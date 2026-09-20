# Discovery Manifests

> **Status:** rungs 1 to 6 of Plan item 2.2 are built — the manifest schema and its generator, the
> storage that makes a manifest durable with a read path that refuses a half-written one, the single
> transaction that holds the Book's own lock across the whole of it, the retrofit that makes every
> Shelf writer go through it, the backfill that put a committed manifest on all twelve Shelf Books,
> and **Discovery itself, landed 2026-08-19** — so the Library can now be asked which Book covers a
> subject without opening one. What does not exist yet: **shared Books have no manifests**, so every
> Discovery answer covers the local Shelf only and says so in its own body. That is rung 7, the last
> one, listed at the foot of this page.

## Why 2.2 is built as a ladder

2.2 is the largest item in `PLAN.md`, and the shape of its failure is specific: a transaction wired
into half the writers, or a query reading manifests that nothing keeps fresh, is worse than nothing
because it looks finished. So each rung lands with **its own gate check and its own commit**, and a
stop after any rung leaves the tree in a state `tools/Invoke-LibraryChecks.ps1` can judge.

## Rung 1: the manifest, and where the capture boundary lives

`tools/BookManifest.ps1` is internal and dot-sourced. It turns one Shelf Book on disk into a manifest
object and writes nothing.

| Field | Holds |
| --- | --- |
| `schema` | `1`. |
| `slug`, `title`, `summary`, `topics` | From `shelf/_catalog.md`, which is already closed-readable. |
| `kind` | `curated` or `capture`. |
| `page_metadata` | `full` or `withheld`, with `withheld_reason` saying why. |
| `page_count`, `pending_count` | Counts. `pending_count` is populated for capture Books only. |
| `reader_map` | The map's headings, and its wiki links as `target` + `label`. `null` for a capture Book. |
| `pages` | One entry per page: canonical `path`, `title` from the first H1, and every heading. Empty for a capture Book. |
| `source_digest` | SHA-256 over each page's path and content hash. |

**The capture exclusion is at generation, not at query, and that is the whole design.** ADR-0002 is
explicit about why: the manifest is itself catalog-class and closed-readable, so filtering what
Discovery *returns* would leave a capture Book's note titles sitting at a path any other reader can
read. A capture Book's manifest therefore carries its summary and its counts and nothing else — no
page paths, no titles, no headings, and **no reader map**, because a capture Book's reader map is a
list of note titles.

**It fails closed twice.** A Book counts as capture if *either* its catalog entry *or* its own
`_book.md` carries `Kind: capture`, so a leak needs both signals to be wrong rather than either one.
And a Book with no catalog entry at all is refused outright rather than generated as curated: an
absent entry is the state in which we know least, which is the wrong moment to disclose most.

**The manifest is deterministic.** There is no timestamp in it. Regenerating an unchanged Book yields
identical bytes, so "has this Book changed" is a hash comparison rather than a diff, and the
generation's own metadata — when it ran, which generation it is — belongs to rung 2 where it can
change without changing what was measured.

**Generation reads bodies; it does not authorize reading them.** The caller owes the Desk gate, or
backfill's explicit closed-content approval, before calling `New-BookManifest`. Nothing here is a
back door around the Desk.

### Boundaries, from item 2.5

Applied at generation so no query has to re-apply them: Unicode NFC normalisation, control-character
stripping, whitespace flattening, 300 characters per text field with a truncation marker, 200
headings per page, 5,000 pages per Book. Heading extraction is Markdown-aware — fenced blocks are
skipped in both the backtick and tilde forms, and frontmatter is removed before anything looks for
structure. Page paths are canonical: relative to `wiki/`, forward slashes, no extension, so a
Discovery result feeds `read_open_book_page` directly instead of needing translation.

### What rung 1 proves

`book-manifest.selftest`, 40 checks, fixture-only and offline. Beyond the ordinary cases it asserts:
a `#` inside a backtick or tilde fence is not a heading; frontmatter is not a heading; the **stored**
manifest of a capture Book contains no note title, note path, or body text — the leak canary ADR-0002
asks for, run against the serialized manifest rather than a query result; a Book declaring
`Kind: capture` only in `_book.md` is still withheld; an uncatalogued slug is refused; two generations
of an unchanged Book are byte-identical; and the digest moves for both a changed body and a rename
that changes no bytes.

**The canaries were watched to fail, not merely observed green.** Three mutations, each reverted:
removing the `_book.md` half of the union rule fails the two checks that cover it; making the capture
branch unreachable fails eleven, including every leak canary; and ignoring fence state extracts both
fenced headings. Green tests that have never been seen red are not evidence.

**One canary is currently vacuous, and it is kept anyway.** *"capture note body text reached the
stored manifest"* cannot fail today: no rung stores body text, so it stays clean even with the whole
capture branch disabled. It is retained as a tripwire for the rung that adds excerpts or snippets to
a manifest — the day that changes, this assertion starts doing work. Recorded here so a later reader
finds a decision rather than assuming coverage that does not exist.

A supporting change landed with it: `Get-ShelfBook` in `ShelfNoteCommon.ps1` now also returns the
catalog `summary` and `topics`. The summary is parsed as an item rather than a line, because catalog
summaries wrap — defect family 3, which this codebase has re-learned three times.

## Rung 2: storage, and a read path that refuses

`tools/BookManifestStore.ps1` is internal and dot-sourced. It makes a manifest durable, and — in the
same rung, deliberately — it holds the reader that refuses to serve one that is not.

**The reader is built with the writer, not after it.** A store whose only consumer arrives two rungs
later is a store nobody has tried to read from a half-written state, which is exactly the state it
exists to survive. Building both at once is what makes the ordering rules testable the day they are
written.

### Where a manifest lives, and why it is not on the Shelf

```
internal/book-manifests/<slug>/dirty.json
internal/book-manifests/<slug>/generations/<n>.json
internal/book-manifests/<slug>/current.json
```

`internal/`, not `shelf/`, and the reason is mechanical rather than tidy. The Shelf read guard
(`.claude/hooks/Guard-ShelfBookRead.ps1:87`) refuses every path under `shelf/` except
`shelf/_catalog.md`. A manifest stored beside its Book would therefore be unreadable in precisely
the situation Discovery exists for — the Book closed. Catalog-class means *outside the guard*, and a
self-test asserts the store path resolves under `internal/` and never under `shelf/`, so a later
refactor that moves manifests under the guard fails loudly instead of quietly disabling Discovery.

### The order, and the two rules that enforce it

Dirty marker first, generation next, commit pointer **last**, dirty marker cleared last of all.
Two of those steps are enforced rather than documented:

- `Write-BookManifestGeneration` **throws when no dirty marker is present.** A generation written
  outside a mutation is the silent-stale case this rung exists to prevent, so it cannot exist rather
  than existing unnoticed.
- `Complete-BookManifestGeneration` **re-reads and re-hashes the generation from disk** instead of
  trusting the hash the writer just handed it. The pointer's claim about the bytes is then a claim
  about bytes that were actually read back.

Every crash therefore lands in a state the reader can classify. A crash before the pointer leaves a
marker and no pointer; a crash between the pointer and the marker's removal leaves both, and reads
`dirty` — conservatively refusing a generation that is in fact complete. That is the correct bias
and the reason the marker is cleared last: **the cost of refusing a good manifest is one rebuild;
the cost of serving a bad one is a wrong answer that looks right.**

### `Get-StoredBookManifest` returns a status; it does not throw

`ok`, `missing`, `dirty`, `incomplete`, `corrupt` — and `manifest` is `$null` for all but the first.
It does not throw for any of them, because Discovery iterates every Book and one Book mid-write must
read as unavailable rather than aborting the whole query. `dirty` is checked **first**, ahead of a
valid pointer and a matching generation, since a mutation in progress says nothing about whether it
will finish.

Determinism carries through storage: `ConvertTo-Json`, LF newlines, one trailing LF, UTF-8 with no
BOM. Saving an unchanged Book twice produces byte-identical generation files with identical hashes,
which is what keeps "has this Book changed" a hash comparison. Generations are kept five deep and
the committed one is never pruned.

### What rung 2 proves

`book-manifest-store.selftest`, 32 checks, fixture-only and offline, storing real `New-BookManifest`
output rather than hand-written objects. Beyond the round trip: the reader refuses while dirty even
with a valid pointer and generation present; refuses when the pointer names a generation that is
gone; refuses a generation whose bytes no longer match its committed hash; reports `missing` rather
than erroring for a Book never saved; `current.json` does not exist before completion and
`dirty.json` does not exist after it; a generation write with no marker throws; a slug of `..`,
`../x`, or `Foo` is refused before any path is built.

**The leak canary is re-asserted against the file on disk.** Rung 1 could only check a serialized
object, because nothing was stored. Now that a manifest is a file, the file is the disclosure
surface, and the capture Book's stored generation is asserted to contain no note title, no note
path, and no note body. This is the first rung at which that canary tests something a reader could
actually open.

**Both new canaries were watched red.** Removing the dirty-marker requirement from
`Write-BookManifestGeneration` fails the ordering check; making the reader ignore `dirty.json` fails
three refusal checks. Reverted after each.

**It was run once against real input**, per the delegation record's rule that fixtures prove only
that the code matches the fixtures: `library-dev`, 31 real pages, generated, stored, read back with
a matching digest, and refused when a marker was planted mid-mutation.

### What rung 2 does not do

No locking — rung 3 added it, and this stays as written because it records why the two are separate
commits. The per-Book lock from 0.7, spanning the whole transaction, is absent from this rung
by choice — the ordering rules are what make that later lock sufficient, and keeping them in separate
commits means a stop between the two is still a state the gate can judge. Nothing calls
`Save-BookManifest` yet either; wiring the existing mutators to it is rung 4.

## Rung 3: one transaction, under the Book's own lock

`tools/BookManifestTransaction.ps1` is internal and dot-sourced. It is the only sanctioned way to
put a manifest on disk: `Invoke-BookManifestTransaction` generates, stores, and commits one Book's
manifest with that Book's lock held across the whole span.

**Rung 2 made the order safe. Order survives a crash; it does not survive a second writer.** Two
processes obeying the ordering rules perfectly can still interleave — one sets the marker while the
other is mid-generation, and the second's commit pointer names a generation taken before the first's
mutation. Every individual step is correct and the result describes a Book that never existed. This
rung is where concurrent writers become impossible rather than merely unlikely.

### It is 0.7's lock, not a second one

`Enter-BookLock`/`Exit-BookLock` from `tools/BookWriteGuard.ps1`, the same lock every Shelf writer
already takes. PLAN.md 0.7 is explicit that 2.2 *extends* it — "manifest generations extend this same
lock to cover dirty-marker creation and commit-pointer publication; they do not introduce a second
one" — and the reason is the one that makes a lock a lock: two locks over the same Book exclude
nobody. It is held **from before the dirty marker is set until after the commit pointer is written**,
and it wraps `Save-BookManifest` and nothing else.

**A caller that already holds the lock passes it in.** `Enter-BookLock` wins a `CreateNew` race and
is therefore not re-entrant: a second acquisition by the same process blocks against itself and then
throws. Rung 4's mutators hold the Book lock across their own mutation and must extend it over the
manifest rather than deadlock against it, so `-Lock` takes the handle they already hold. The
transaction verifies the handle names this Book, uses it, and **releases only what it acquired** —
releasing a caller's lock would end the caller's mutation window in the middle of the caller's
mutation.

**A Book root is normalised before its lock name is built.** `shelf/demo`, `shelf\demo`, and
`shelf/demo/` are one Book, and a writer spelling it differently from the next writer would take a
lock nobody else contends for — exclusion that looks present and is not. `ConvertTo-BookLockName` in
`BookWriteGuard.ps1` collapses the three forms and a self-test asserts the collision, so the lock
handed to a transaction can be compared against the Book it claims to protect rather than trusted.

### Where the two failure boundaries sit, and why they differ

The transaction has two distinct failure regions, divided by the moment the dirty marker appears.

- **Generation runs inside the lock but *before* the marker.** It can legitimately fail — rung 1
  refuses an uncatalogued slug outright — and a failure there must leave **nothing** behind. A marker
  with no mutation behind it is a Book that reads unavailable forever with nothing for a rebuild to
  repair.
- **After the marker, a failure leaves it in place, deliberately.** By then whatever called the
  transaction has already mutated the Book, so the stored manifest *is* stale. The refusal is the
  truthful state, and it is rung 2's bias applied one layer up: refusing a good manifest costs a
  rebuild, serving a bad one costs a wrong answer that looks right. The error says so, naming the
  Book and that its manifest is dirty until rebuilt.

The lock is released in `finally` either way — an exception must never leave a Book locked — and an
invalid slug is refused before any lock is taken, so a bad name cannot leave a lock file behind.

Generation still reads bodies and still does not authorize reading them. Unchanged from rung 1: the
caller owes the Desk gate, or backfill's explicit closed-content approval, before it gets here.

### What rung 3 proves

`book-manifest-transaction.selftest`, 28 checks, fixture-only and offline. The two that carry the
rung: **a transaction blocked by another writer's lock writes nothing at all** — no marker, and the
store still reads `missing`, which is what proves the lock precedes the marker rather than following
it — and **a caller-supplied lock is still held after the transaction returns**. Alongside those: a
lock for a different Book is refused and writes nothing; an equivalent Book-root spelling is
accepted as the same lock; a failure after the marker leaves the Book reading `dirty` with the lock
released; a failure before the marker leaves no marker; determinism and the capture leak canary both
carry through the transaction unchanged.

`book-write-guard.selftest` gains two checks for the normalisation, at 18.

**Five mutations, each watched red and reverted.** Removing the lock acquisition fails the
contention check and four others; releasing a caller's lock fails the passthrough check; skipping
the Book-root comparison accepts a foreign lock; clearing the marker on failure fails both
dirty-state checks; and setting the marker before generation fails the generation-failure check.

**A hole in the suite harness was found by the first failing run and closed.** A strict-mode error
inside the fixture body unwound past every remaining assertion, and the suite announced *passed (1
checks)*. The body is now wrapped in a `catch` that records "the suite did not run to completion" as
a failure. A test suite that can exit green having run a tenth of itself is worse than no suite;
this one did, once, and was seen doing it.

**It was run once against real input.** `library-dev`, 31 pages: committed at generation 1 and read
back `ok` with a matching digest; a second transaction refused while the Book's lock was held
elsewhere; and the same run committed generation 2 under a caller-supplied lock that was still held
afterwards. The store directory was removed after, so the workspace carries no half-populated store
that nothing yet refreshes.

### What rung 3 does not do

**Nothing forces a writer through this transaction yet.** A mutator that calls `Save-BookManifest`
directly still bypasses the lock, and no existing mutator calls either. Both halves are rung 4: the
retrofit, and the check that fails a writer which skips it. Until then the transaction is the
sanctioned route rather than the only one.

## Rung 4: the retrofit, and the check that fails a writer which skips it

Rung 3 built the transaction and nothing called it. This rung routes every Shelf writer through it,
and adds the check that fails a writer which does not. It is the enforcement core, and it is where
2.2 stops being available and starts being true.

### A writer does not call the transaction. It opens a mutation window.

The obvious retrofit — call `Invoke-BookManifestTransaction` at the end of each writer — is wrong,
and the reason is the whole of rung 2 restated. Between a writer's last write and its call to the
transaction there is a span in which the Book has changed and the stored manifest still reads `ok`.
A crash there leaves a manifest that *answers*, confidently, about a Book it no longer describes.
`PLAN.md` 2.2 is explicit that the marker goes down **before** the mutation, not after it.

So `BookManifestTransaction.ps1` gained a window rather than only a commit:

```
$lock     = Enter-BookLock ...
$mutation = Enter-BookMutation ... -Lock $lock     # marker down, before the first write
... journal, mutate, verify ...
Complete-BookMutation -Mutation $mutation          # generate, store, commit, marker up
```

`-Lock` is mandatory on `Enter-BookMutation`, and not as a convenience: a mutation window without
exclusion is a window two writers can be inside at once. It is the lock the writer already holds,
because `Enter-BookLock` is not re-entrant and a second acquisition would deadlock against the
first — the `-Lock` path rung 3 built for exactly this.

### Completing never throws, and that is the point

`Complete-BookMutation` returns a status the way `Get-StoredBookManifest` does. By the time it runs,
the page or note or rename has already landed and been verified. If it threw, the exception would
unwind into the writer's own `catch`, the rollback would fire, and **the reader's material would be
discarded because a metadata file could not be written.** That is worse than either outcome the
dirty marker was designed to choose between.

It is rung 2's bias one layer further out. Refusing a good manifest costs a rebuild; serving a bad
one costs a wrong answer that looks right; discarding a landed write costs the reader their material.
So a manifest failure leaves the marker down, the Book reads `dirty`, the writer reports
`dirty until rebuilt: …` in its result, and the note stays where the reader put it. This matters most
for capture, which is deliberately ungated precisely because a note that costs anything stops being
written down — routing must not have made it fragile.

`Undo-BookMutation` is the other exit, and it has one precondition: **the rollback verified.** The
Book is then back in the state the committed manifest already describes, so the marker is stale and
clearing it restores a true answer. After a rollback that FAILED the Book's state is unknown and the
marker stays down. Each writer decides from the rollback result it already computes.

Triage's in-place kinds have no `Undo` call, and its absence is a decision rather than an omission:
they journal nothing per note and roll nothing back, so a failure after its window opens really does leave
the Book in a state no stored manifest describes. `dirty` is the truthful answer there, not a gap.

### The writers, and the one that inherits

`Add-ShelfBookPage`, `Add-ShelfNote`, `Rename-ShelfBook`, and triage's three in-place kinds.
`review` and `notebook` are the two `PLAN.md` names as the ones the obvious enumeration forgets —
they rewrite frontmatter and the reader map without adding or removing a page, so they leave manifest
and Book in stale agreement. `Discard` was not on that list either, and is here for the same reason.

`Add-ShelfBookTopic` routes **without containing the routing**. It writes no page itself: every page
goes through `Add-ShelfBookPage`, so every page passes through that helper's window. A second route
from the graduator would be a second implementation of the invariant, which is what delegating to the
page writer exists to avoid. The cost is one manifest generation per page rather than one per run,
and it is the right cost — it is what keeps an interrupted graduation resumable, with every page that
landed already described by a committed manifest.

### Manifest refresh inherits the mutation's authorization

Generation reads bodies and still does not authorize reading them, unchanged since rung 1. What rung
4 adds is a caller for that rule: **the writer's own gate is the authorization.** Adding a page and
triaging a note require the Book open; a rename requires a `plan_id` and one approval; capture is
ungated by design. In each case the manifest refresh happens under the authorization the mutation
already carried, and it discloses nothing to the reader — it writes catalog-class metadata to disk,
which is what ADR-0002 decided that metadata is. A closed curated Book that is renamed now gains a
closed-readable manifest where it had none, and that is Discovery working rather than a boundary
moving. Capture Books stay withheld throughout.

### A rename changes which Book the manifest is about

This is the limit rung 2 recorded: `Rename-ShelfBook` knew nothing about `internal/book-manifests/`,
so the old slug's directory survived as a manifest describing a Book at a path that no longer exists.

The manifest is **retired and regenerated, not moved.** Generation N of the old slug has the old slug
and the old title inside it; carrying those files forward under a new name would make the store's own
history disagree with itself. A manifest is derived state, so throwing it away costs a rebuild and
nothing else.

`Complete-BookRenameMutation` does it in an order chosen so that every crash point refuses: mark the
new identity dirty, remove the old store, commit the new identity's first generation. A crash after
the first step leaves two stores, both dirty, both refusing. A crash after the second leaves one
store, dirty, refusing. **At no point does a store answer for a Book that has moved** — which is the
property the old orphan lacked, and the reason this is a fix rather than a tidy-up.

### The check, in two halves, and what neither half catches

`shelf.writers-route-manifests` runs `tools/Test-ShelfWriterRouting.ps1`. No Claude-side hook runs in
a delegate process, so the writers are the only place the invariant can live — and the gate is the
only place a delegate will be told it broke it.

**The static half** catches a writer that never routes at all: a helper that takes a Book's lock,
changes the Book, and opens no window. Nothing at runtime can see that absence, because the absent
code is the thing that would have reported it. The rule keys on the **lock's Book root**, not on the
mere presence of `Enter-BookLock`: `Set-TopicOverlap` locks `internal/overlap-records` and
`Invoke-LibraryTriage`'s BATCH lock is `triage/<batch>`, and neither names a Book, so the exemption is
visible in the call itself rather than in a list here that a future writer could quietly join. Two
further rules: a writer that can roll back must be able to clear its marker, and a window that is
opened must be committed. All three ignore comment lines — every one of these helpers explains its
routing in prose, so a substring search would be satisfied by the comment describing the call it no
longer makes.

**The behavioural half** catches routing that is present and broken. Each real writer runs against a
fixture Shelf and the store is read back: `ok`, and a `source_digest` equal to a manifest generated
fresh from the Book. A call to `Enter-BookMutation` proves nothing on its own; a matching digest is
what a stale manifest cannot survive.

**Neither half proves the marker precedes the mutation** — except one case that does. A writer that
committed only afterwards reaches an identical final state, so every ordinary assertion passes. The
one case that separates them injects a failure *between* a `discard`'s delete and its reader-map
rewrite: triage rolls nothing back, so the note is gone and the store must read `dirty`. A
commit-afterwards design leaves it reading `ok` with a note it has already deleted. That case was
watched failing under exactly that mutation, and it is the only one that did.

### What rung 4 proves

`shelf.writers-route-manifests`, 20 cases, fixture-only and offline. Beyond a generation per writer:
a capture Book's committed manifest still contains no note title, path, or body — the leak canary
asserted for the first time against a file **the reader's own capture helper wrote**; a review that
changes nothing opens no window, so no marker is left with nothing behind it; a rolled-back page add
leaves no marker; a topic graduation advances the generation once per page; a slug change leaves no
old store; and a refused rename leaves the Book available.

**Six mutations, each watched red and reverted.** Commenting out — not deleting — the routing in
`Add-ShelfNote` fails the static scan, which is what proves the scan reads calls rather than text.
Opening `Discard`'s window after its writes fails the ordering case and nothing else. Dropping the
old store's removal fails the rename case. Leaving the marker down after a verified rollback fails
both the static rollback rule and the behavioural case. And injecting a strict-mode error into the
rung 2 store suite now reports *the suite did not run to completion* instead of exiting green.

**The sixth mutation found a missing case rather than a passing one.** Making `Complete-BookMutation`
throw instead of report fired no canary at all: the rule that a manifest failure must never discard a
landed write was asserted in the transaction's own suite and nowhere near a writer. The case now
exists — the commit pointer is held open by another process while a real capture runs, and the note
must survive with `dirty until rebuilt` reported — and with it the mutation fails loudly. A canary
that has never been seen red is not evidence, and this is what that discipline is for.

**It was run once against real input.** `library-dev`, 31 pages, open on the Desk: the window read
`dirty` while open, committed at generation 1, and read back `ok` with a digest matching a fresh
generation. Then the real Holding Shelf, through the real writers: a note captured (generation 1,
kind `capture`, metadata withheld, counts 2/2, and neither its title nor its path anywhere in the
stored generation) and the same note discarded (generation 2, counts back to 1/1). Net zero — the
note count and the reader map were byte-identical afterwards — and both stores were removed, so the
workspace carries nothing half-populated for rung 5 to trip over.

### What rung 4 does not do

Nothing is backfilled. A Book gets a manifest the first time something mutates it, and every Book
that has not been touched since reads `missing`. That is rung 5, which also owns `-Rebuild` for the
out-of-band edit. Discovery still does not exist.

## Rung 5: the backfill, the repair, and the sweep

`tools/Update-BookManifests.ps1`, landed 2026-08-19. Rung 4 left every untouched Book reading
`missing`; it also left two states named but unbuilt — the repair its own writers advertise as
*"dirty until rebuilt"*, and the orphan store nothing walks the Shelf to find. Rung 5 is one helper
covering all three, plus `-Rebuild` for the one state no status can detect.

### The default mode covers every state that is not `ok`

`missing` becomes `backfill`; `dirty`, `incomplete`, and `corrupt` become `repair`; `ok` is left
alone. That single table is what closes the *"dirty until rebuilt"* limit: rung 4's writers report
that string accurately on a manifest failure, and until this rung it named a repair that did not
exist. The plain run is now that repair, and the suite asserts it against the plain run
specifically rather than against `-Rebuild`, because a repair only reachable through the rebuild
flag would leave the string still lying.

### `-Rebuild`'s product is the digest comparison

`-Rebuild` regenerates regardless of state, which is the only way to notice a body edited outside
the helpers — the reader opening a Shelf page in an editor updates no manifest and sets no marker.
Its output is therefore not "twelve Books rebuilt" but *which Books changed*: the committed
`source_digest` is read before the window opens and compared after the commit, and each Book is
reported `changed` or `unchanged`. Nothing else in the Library can answer that question.

**Resume is disabled under `-Rebuild`, and that is a deviation from the spec worth keeping.** The
spec described one resume rule; the delegate found that applying it to a rebuild defeats the
rebuild. Resume trusts a journal entry only when the store confirms it — and the store confirms
only the *last commit*, which is exactly what an out-of-band edit leaves stale. A resumed rebuild
would skip precisely the Books the diagnostic exists to re-read.

### Authorization is uniform, and the preflight is itself a disclosure surface

Generation hashes page content for the `source_digest` *before* the capture branch is reached, so a
capture Book's backfill reads its note bodies even though the stored manifest keeps counts only.
There is no capture exemption: `confirmation_required` is true exactly when at least one closed Book
is in scope, and a run without both the preflight's exact `plan_id` and `-UserConfirmed` is refused
before anything is read, locked, or written.

The preflight names `slug`, `title`, `kind`, `open`, `store_status`, `action`, and `page_count` —
and **no page path, no page title, no note title**, in any mode. A preflight the reader reads is one
of the places ADR-0002 exists to keep note titles out of, and a count is not: the Desk overview
already reports counts.

One consequence, deliberate and fail-safe: `confirmation_required` is computed from the *scope*, not
from whether any body will actually be read. A re-run in which every Book already reads `ok` reads
nothing and still asks. The alternative — deciding authorization from predicted work — makes the
approval depend on a state that can change between the preflight and the run.

### A failure leaves the marker down; the run does not stop

Each Book goes through rung 4's mutation window, never around it, so the marker is down before
generation and a crash mid-run leaves the Book refusing rather than serving a manifest this pass had
already decided was suspect. `Complete-BookMutation` never throws, so a failed Book is recorded
`dirty` and the loop continues — the same reasoning that makes `Get-StoredBookManifest` return a
status rather than throw, one layer out, over a bulk pass where one bad Book must not cost the other
eleven.

**Nothing here calls `Undo-BookMutation`, and the omission is the design.** Nothing in this rung
mutates a Book, so there is nothing to roll back; but a Book whose regeneration failed is a Book
whose stored manifest this run cannot vouch for, and `dirty` is the truthful answer. Clearing the
marker would restore an answer there is positive reason to doubt. A Book whose lock is held
elsewhere is a *skip*, not a failure, and writes nothing at all — the marker is set inside the
window, which is inside the lock.

### Prune fails closed on two signals, and is measured against the whole catalog

A store is removed only when its slug is absent from `shelf/_catalog.md` **and** has no
`shelf/<slug>` directory on disk. Present on disk but missing from the catalog is a *catalog*
problem, and deleting derived state is the wrong response to a state we do not understand; that case
is reported under `stores_kept_unresolved` and kept. Both signals must agree. This is the sweep that
closes rung 4's crash-mid-rename residue and the deleted-Book limit, neither of which any writer
could notice.

Prune runs in both modes and runs even under `-Book`, because scoping it would mean an orphan is
only ever found by a full run. **The first real run found the defect in that sentence**: `-Book`
narrowed the catalog list, and the prune sweep was reading the *narrowed* list, so a
`-Book library-dev` preflight reported eleven healthy Books as unresolved. Only the second
fail-closed signal stood between `-Book` and deleting every other Book's store. Fixed by keeping the
full catalog separately for the sweep, with a regression case that fails when the two are conflated.
The two-signal rule is what turned a scoping bug into a noisy preflight rather than a data loss, and
that is the argument for fail-closed on two signals rather than one.

### The journal is the fast path; the store is the authority

`internal/manifest-journals/<mode>-<digest16>.json`, rewritten in full after every Book via a temp
file and a replacing move — a journal written only at the end cannot survive the interruption it
exists for. The digest binds the run to its mode and its exact ordered Book list, so a different
scope is a different journal. On a re-run, a `committed` entry is trusted only when
`Get-StoredBookManifest` — which reads no body — still reads `ok` with the same `source_digest`. An
unreadable, half-written, or absent journal is treated as absent and is never fatal. Same
two-mechanism shape as `Add-ShelfBookTopic.ps1`, for the same reason.

### What rung 5 proves

`tools/Test-ManifestBackfill.ps1`, 18 fixture cases, registered as `shelf.manifest-backfill`.

**Nine mutations were watched red before anything was believed.** Calling `Save-BookManifest`
directly instead of opening the window; adding the `Undo` the design omits; setting the marker
before taking the lock; pruning the unresolved store; letting one Book's failure throw; letting note
paths into the preflight; enabling resume under `-Rebuild`; and the two fixes below, each backed out
again to watch its own regression case fail. Every one fired.

**Two defects were found this way, neither by the gate.**

- **The static scan counted a block comment as a call.** `Test-CallsFunction` in
  `Test-ShelfWriterRouting.ps1` skipped lines beginning with `#`, which a `<# #>` block's *body*
  does not. `Update-BookManifests.ps1` documents the mutation window in its `.DESCRIPTION`, so a
  mutation that removed both calls left the census and the locks-without-a-window rule green — rung
  4's enforcement satisfiable by documentation. Block comments are now stripped before matching, and
  a case asserts a synopsis mention does not count.
- **The prune scope defect above**, found by running against real input rather than fixtures.

**The live run, 2026-08-19,** under the reader's explicit closed-content approval against
`plan_id update-book-manifests-620a0feb…`: one Book scoped with `-Book` first, then the full sweep
over 12 Books, 11 of them closed. All 12 committed at generation 1, exit 0, nothing dirty. Every
store then re-read `ok` with a `source_digest` matching a fresh generation — a call proves nothing,
a matching digest is what a stale manifest cannot survive. The real capture Book's note titles and
note paths were searched for in its own committed generation file and none appear, with
`page_metadata` reading `withheld`. `-Rebuild` on one Book advanced it to generation 2 and reported
`changed: False`. A planted orphan store was reported in the preflight and removed by the run.

**The Shelf keeps its manifests.** Rungs 3 and 4 both removed their stores afterwards so nothing
half-populated was left behind; rung 5 is the rung whose whole point is that the Shelf carries
manifests, and rung 6 needs them. A stale one is detectable by `-Rebuild` and repairable by the
plain run, which is the property that makes keeping them safe.

### What rung 5 does not do

It does not touch shared Books — that is rung 7, and it is the Librarian's because a delegate
process has no MCP. It does not read a manifest: Discovery is rung 6, and until it exists these
twelve stores answer no question. And nothing schedules it, so a Shelf edited outside the helpers
stays stale until someone runs `-Rebuild`.

## Rung 6: Discovery itself

`tools/BookDiscovery.ps1`, landed 2026-08-19, reached by the reader as `discover_book_pages` on the
validated reader MCP. It is the rung the other five exist for: it answers *which Book covers this*
across every Shelf Book, closed ones included, and it reads no closed Book's body to do it.

### The surface, with the reader benefit and the boundary written down first

Per `.claude/rules/library-development.md`, both were settled before any code was written.

**The reader benefit.** Without Discovery the only way to test a Book's relevance is to open it, so
a wrong guess loads an irrelevant Book into the Librarian's context — the pollution the Desk exists
to prevent, caused by the absence of the feature. Discovery turns "open three and see" into "open
one". It is a step inside the answering loop of `CLAUDE.md`, not an errand beside it.

**The boundary it must not cross.** Never body text. Never a closed capture Book's note title or
note path. Never a manifest the store has not called `ok`. Never an answer that looks complete when
a Book was skipped or the shared collection was never in scope.

**Both surfaces were live, and the boundary does not choose between them**, because the boundary is
enforced in the query engine either way. What the surface decides is *reach*. A `tools/*.ps1` helper
is invoked deliberately; an MCP tool sits in the tool list beside `read_book_catalog`, where the
layered answering discipline already points. `suggest_active_projects` is the exact precedent —
ungated search over catalog-class summaries, returning pointers, opening nothing — and Discovery is
its sibling for Books. ADR-0002 supplies the rest: a manifest **is** catalog-class material, stored
under `internal/` rather than behind the Shelf read guard, with a capture Book's page metadata
excluded at write time rather than filtered at query time.

So it is **both, layered**: the engine is an internal dot-sourced module with its own suite and its
own gate check, and the adapter loads it and formats the answer. The adapter reimplements nothing —
one query, one set of leak canaries, one refusing store read. The load is guarded: a missing module
costs the Discovery tool and never the reads every other tool on that adapter serves.

One consequence is the reader's: `mcp__validated-book-reader__discover_book_pages` needs an
allowlist line in `.claude/settings.json` or it prompts once per session. That file is the reader's,
and `helpers.manifest-matches-allowlist` does not see MCP tools, so this one is not reported by the
gate the way a new public helper is.

### A Book that cannot be read is named, never dropped

`Get-StoredBookManifest` classifies a store as `ok`, `missing`, `dirty`, `incomplete`, or `corrupt`
and throws for none of them, precisely so a bulk query can carry on. Every Book that is not `ok`
goes into `books_unavailable` with its slug, its status, the store's own reason, and the repair —
and `books_searched` falls below `books_total` to match. The rendered answer prints that list under
*"Books this query could NOT read"* before any hit.

The failure this prevents is the quiet one. A query run while a Book is mid-write would otherwise
return fewer results and look exactly like a query that found fewer results. Silence is the bug;
an unavailable Book is not.

**The store is the only authority on freshness, and Discovery has no path around it.** It does not
look for a dirty marker of its own and does not fall back to the newest generation on disk. A second
classifier would be a second parser of the same state — the drift this codebase has already paid for
between the two meter readers. The canary is built accordingly: patching the *store* to ignore
`dirty.json` makes Discovery serve the stale manifest and fails five assertions, which is what
proves the single point of refusal is real rather than merely intended.

### What a capture Book contributes, and where the open path reads from

Closed, it contributes its title, its summary, and its topics — a Book-level hit with no page path,
because its stored `page_metadata` reads `withheld` and its `pages` and `reader_map` are empty by
construction. ADR-0002 also says its pages join Discovery normally once it is **open**, and the
closed-readable store deliberately does not hold them, so the open path has to read from somewhere.

**It reads from disk, live, at query time, and writes nothing.** The alternative — a second, gated
store — would be derived state that no writer invalidates: a capture Book's pages change on every
`Add-ShelfNote`, so that store would need its own marker, generation, and commit machinery to answer
a question the filesystem answers correctly for free. A live read cannot be stale. It reuses rung 1's
extraction helpers rather than a bypass switch on `New-BookManifest`, so the union rule that fails
closed twice is untouched.

This is the one body-reading path in the file, and it is gated on the Book being open — not on its
kind. Removing that gate is a watched mutation: it puts the note title into the answer and fails the
closed-capture canary immediately.

### The Shelf only, said in the answer rather than in this document

Shared Books have no manifests until rung 7, so `shared_books_covered` is `false`, `shared_books_note`
names the gap, and the rendered answer repeats it on the first line — on every query, not only on the
ones that find nothing. A partial answer that does not admit it is partial is worse than the missing
half, and a limitation recorded only in a design document is not a limitation the reader is told
about.

### Output, and the field set that is declared rather than assumed

A hit carries `book`, `book_title`, `book_kind`, `book_open`, `page`, `heading`, `match_field`, and
`overlap` — and that list lives in one variable, `$script:DiscoveryHitFields`, which the suite
asserts every hit against. A later rung that adds an excerpt field fails a leak canary instead of
shipping. `page` is the canonical path that feeds `read_open_book_page` directly; a reader-map link
whose target the manifest does not list as a page gets no path at all, because handing the reader a
path that fails to open is worse than handing them the Book.

`match_field` says *why* a Book surfaced: `book-title`, `topic`, `book-summary`, `reader-map`,
`page-title`, or `heading`. A summary match returns no text — `shelf/_catalog.md` is where the reader
reads a summary, and the hit only has to say which Book to consider.

The overlap join reads each record from the side of the Book that matched, so the same record reads
`canonical for 'x' over y` from one Book and `superseded for 'x' by y` from the other. That is
ADR-0002's *"metadata becomes load-bearing"* made concrete. An unreadable or malformed record file
loses the annotation, never the answer.

Matching is literal, case-insensitive, NFC-normalised, control-stripped, and whitespace-flattened —
the same treatment `ConvertTo-ManifestText` applies at generation, so both sides reach the comparison
having had the same thing done to them. **Regex opt-in is deliberately not offered**: item 2.5 owns
the wall-clock cap that an unbounded reader-supplied pattern over 743 pages needs, and improvising it
here would be the wrong rung.

### What rung 6 proves

`book-discovery.selftest`, 68 checks, fixture-only and offline, over a disposable four-Book Shelf
with a curated Book, a capture Book, a Book whose store is damaged on purpose, and an overlap record.

**Twelve mutations were watched red before anything was believed**, each reverted: returning body
text as an excerpt field; the store serving a dirty Book; dropping the `books_unavailable`
accumulation; running the live capture path for a closed Book; dropping the overlap join; letting one
unreadable store throw instead of being reported; claiming the shared collection was covered; losing
case-insensitivity; dropping the page-title dedup; giving a dead reader-map link a page path; putting
the store's read back on `Get-Content -Raw`; and dropping NFC normalisation. Every one fired.

**The first sweep produced a finding about the suite rather than the code.** Four mutations reported
one failure and hid three: an assertion indexing an empty match set threw, and the catch-all that
stops a suite exiting green on a fraction of itself swallowed everything after it. So a suite that
*had* the right canary could only show the first one that noticed. Nothing indexes a filtered set
directly any more, and a query that throws is now a failed assertion rather than a dead suite —
which is what makes *"one unreadable store must not take the whole query down"* testable at all.
A second finding was a canary of mine that could not fail: the decomposed-query case was written
with an ASCII string, so it tested nothing until the fixture gained a real accented character.

**A defect fell out of the first real run, and it was rung 2's.** `Get-StoredBookManifest` read its
generation files with `Get-Content -Raw`, which in Windows PowerShell 5.1 reads a BOM-less UTF-8 file
as ANSI — the sixth hazard in `.claude/rules/library-development.md`, in the store's own read path
since 2026-08-18. Every text field of every manifest it returned was silently mangled: the first real
query came back naming *"Library Development â€" Design History"*. Nothing noticed for a day because
rung 5 compares only `source_digest`, which is ASCII hex, and because every fixture in the store's
suite was ASCII. Fixed with `[IO.File]::ReadAllText` at all five sites, and the store's fixture is no
longer ASCII — so its existing round-trip assertion now covers the hazard as well as the two explicit
ones added beside it. Both ends have a regression case: the store's, and Discovery's as the consumer.

**The live run, 2026-08-19**, against the twelve real manifests rung 5 committed:

- `manifest` over all twelve Books returned five hits from two Books, with `obsidian-work-vault`
  correctly annotated *"unverified overlap with 2nd-b on 'obsidian'"* from the real record file.
- Five broad queries — `the`, `a`, `e`, `note`, `2026` — produced 10,668 matches across all twelve
  Books. The closed capture Book contributed Book-level hits only and **not one page path**, and its
  stored manifest reads `withheld` with zero pages and no reader map.
- A dirty marker planted on a real closed Book put it in `books_unavailable` with the store's own
  reason, dropped `books_searched` to 11 of 12, contributed none of its hits, and left the other
  eleven Books answering — 9 of the 16 matches survived. The marker was removed and the store re-read
  `ok` with an unchanged `source_digest`.
- The whole path was exercised end to end over JSON-RPC through the adapter, not only in-process:
  `tools/list` carries `discover_book_pages`, a query returns the rendered answer, and a missing
  `query`, a blank `query`, and a non-numeric `max_results` are each refused by name.

### What rung 6 does not do

It does not touch shared Books — rung 7, and the Librarian's, because a delegate process has no MCP.
It does not read full text: that is 2.3, confined to open Books. It offers no regex and no wall-clock
cap, which is 2.5's to design across all three tiers. It does not detect a Shelf page edited outside
the helpers — `-Rebuild` is still the only thing that can, and nothing schedules it, so Discovery
answers from the last committed manifest and will say `ok` about a Book whose body has moved on.

And **a heading is not a claim**. Nothing in the code can enforce ADR-0002's standing constraint that
a Discovery hit licenses *shall I open it?* and never an answer about what the page says. The answer
ends with that sentence every time, which is a reminder rather than a guard; 2.6 is where the
safeguard belongs.

## Rung 7: the shared backfill, and Discovery over both collections

`tools/Update-SharedBookManifests.ps1` with `tools/SharedBookSource.ps1` beneath it, landed
2026-08-19. It is the rung that makes rung 6's first line stop being necessary: Discovery now spans
the local Shelf and the shared collection, and the sentence *"this answer covers the local Shelf
only"* appears only when the shared collection genuinely is out of scope.

Four things had to be settled before any code, and two of them had answers already on disk that
turned out to be wrong in the same way.

### The store was keyed on a coincidence, and now it is keyed on the collection

`Get-BookManifestStorePath` built `internal/book-manifests/<slug>/` from the slug **alone**, while
`BookWriteGuard`'s per-Book lock has always keyed on `book_root` and normalised it to `shelf-<slug>`
versus `books-<slug>`. So the lock already distinguished the two collections and the store did not.
Nothing had collided: twelve Shelf slugs against thirteen shared ones, with `godot-engine-reference`
and `godot-engine-architecture-reference` the nearest miss. That is a coincidence, not a property —
the shared collection's names are not this workspace's to control, and a collision would have had one
Book's manifest answering for another's with no status able to detect it.

The store is now `internal/book-manifests/<collection>/<slug>`, with `-Collection` threaded through
every store and transaction function and defaulting to `shelf`, and a `shelf`/`shared` name is
refused at the same door that refuses a traversing slug. The twelve existing stores were moved under
`shelf/` and verified by re-reading every one: same status, same generation, same `source_digest` —
a pure move, no body read, no regeneration. `Invoke-BookManifestTransaction` also cross-checks the
collection against the Book root, so a `books/` root with a `shelf` store key is refused rather than
locking one Book and writing another's manifest.

### The page-enumeration primitive was the one genuinely unknown piece

`New-BookManifest` is Shelf-only by construction: it calls `Get-ShelfBook`, parses
`shelf/_catalog.md`, and walks the filesystem. The shared side has a different catalog
(`books/README`, read over MCP) and no filesystem at all. So the primitive was established first and
everything else was shaped by it.

**Enumeration is `list_directory`; reading is `read_note`; both are exact.** The listing parser is
the one `Archive-ProjectHub.ps1` has used against the real NAS since the pilot. A read whose returned
`file_path` differs from the requested one is refused with its content withheld — the same rule the
validated reader adapter applies to every page it serves, and for the same reason: a manifest built
from a substituted read describes one Book under another Book's name.

**A listing that does not contain the Book's own `_book` page is refused as incomplete.** Every Book
has one and the catalog links to it, so its absence means the listing was truncated or filtered, and
the failure being prevented is a manifest that silently describes a fraction of a Book — which no
status could tell from a small Book. This is the only truncation a listing can be checked against,
and that limit is recorded below rather than implied.

**The manifest itself is built by the same function for both collections.** Rung 1's generator was
split into `New-BookManifestFromPages` — schema, caps from item 2.5, capture exclusion, digest — and
a thin Shelf wrapper that reads the page list off disk. The shared side supplies the same page shape
from MCP. The digest still hashes page **bytes**, so the Shelf supplies raw file bytes and every
digest committed since rung 2 stayed valid; the refactor was proved by regenerating a real Shelf
Book and comparing the result byte-for-byte with its committed generation.

**The capture union rule has one signal on the shared side, and it must be read.** On the Shelf the
two signals are the catalog entry and the Book's own `_book.md`. The shared catalog carries no
`Kind` field at all, so the Book's `_book` page is the only signal there is — and a Book whose
`_book` page cannot be read is therefore **refused**, never generated as curated on the assumption
that silence means "not capture".

### Authorization is rung 5's shape, and the preflight counts without naming

`confirmation_required` is computed from the **scope** — true whenever at least one closed Book is in
it — and never from predicted work, because authorization decided from predicted work depends on
state that can change between the preflight and the run. A run without both the preflight's exact
`plan_id` and `-UserConfirmed` is refused before anything is read, locked, or written, and the
plan_id carries the operation's own name, so a Shelf approval cannot be replayed against the shared
collection or the other way round.

The preflight names `slug`, `title`, `kind`, `open`, `store_status`, `action`, and `page_count`, and
**no page path, no page title, no note title**. Counting pages needs a directory listing, so the
preflight makes one and shows none of it — a count is not a disclosure and the Desk overview already
reports counts, while a page title is exactly what ADR-0002 keeps out of closed-readable places. A
suite case asserts the preflight reads **exactly one note**, `books/README`, and no page body at all.

One field is deliberately not guessed: `kind` reads *"unknown until generation"*, because the only
capture signal lives in the Book's `_book` page and reading it is the thing this approval is for.
Guessing `curated` there is precisely how a capture Book's page metadata would end up in a
closed-readable store.

### What changed in Discovery, and how coverage is computed rather than assumed

Discovery gained a shared loop on the same terms as the Shelf one: the store is the authority,
anything it will not call `ok` is named with its status and its own repair, and `books_searched`
falls to match. It reads no shared Book's body and reaches no network — it answers offline, from
local stores, whatever wrote them.

**The roster is what makes "unavailable" different from "invisible".** Discovery has no shared
catalog of its own, so the backfill writes `internal/book-manifests/shared/_roster.json` from the
**whole** catalog — even under `-Book`, because a partial roster would make the other Books vanish
rather than be reported. A rostered Book with no store is `missing` and named; without a roster the
shared collection is honestly out of scope and the answer says so; a malformed roster reads as no
roster, never as half a collection.

**Coverage is a computed state with three values.** `shared_books_covered` says whether the
collection is in scope at all, and the note says what actually happened: all searched, or *PARTIAL*
with the number that could not be read and the Books named below. An answer that claims shared
coverage while a shared Book's store is not `ok` is the same silent-partial failure rung 6 was built
to prevent, so the canary is two-sided — one mutation makes the note claim full coverage, another
drops the unavailable Book entirely, and both fire.

**Every shared answer states how old its Book list is.** A Book added to `books/README` since the
last backfill is not merely unread by Discovery, it is *unknown*, and no count can reveal it. The
roster's date is therefore in the answer: *"Shared Book list as of 2026-08-19; a Book added since
then is not in this answer."* A blind spot the reader can see is a different thing from one only this
document mentions.

### What rung 7 proves

`tools/Test-SharedManifestBackfill.ps1`, registered as `shared.manifest-backfill`. It runs
against a **fault-injectable loopback stub** rather than the NAS, following `Test-McpHelpers.ps1`: a
suite that needs the network stops proving anything the moment the network is down, and a faithful
stub can only ever exercise happy paths. The faults are the point — a substituted read, a truncated
listing, an unreadable page, an unreadable `_book` page.

**Fourteen mutations were watched red before anything was believed**, each reverted: claiming full
shared coverage while a shared Book was unreadable; dropping an unreadable shared Book instead of
naming it; accepting a read whose `file_path` was not the one requested; accepting a listing that
lost the Book's `_book` page; generating a shared capture Book as curated; letting one unreadable
Book take down the whole pass; putting page paths into the preflight; writing the roster from the
narrowed scope; pruning a shared store on one signal; keying the store on the slug alone again;
resuming on the journal without the store confirming it; ignoring the roster so an un-backfilled
Book is invisible; leaving shared reader-map links spelled as full note paths; and giving up on the
first sharing violation instead of retrying the swap. Every one fired.

One mutation of the first sweep was a **false red** and is recorded as a suite-discipline note: it
left an unbalanced brace, so the suite failed to parse and reported a failure that proved nothing
about the canary. A mutation must stay syntactically valid, or its red is about the mutation.

**Two defects fell out of the first real run, and neither was visible to any fixture.**

- **Shared reader-map links are written as full note paths.** The Shelf writes its map links
  relative to `wiki/`; the shared collection writes `books/<slug>/wiki/<page>`. Rung 6's rule that a
  link target must match a page path the manifest lists — the rule that stops the reader being handed
  a path that fails to open — therefore matched *nothing* on the shared side, and every shared
  reader-map hit silently degraded to a Book-level hit. The fixture had agreed with the code and both
  had disagreed with the NAS. Fixed by canonicalising link targets at generation, behind an explicit
  `-LinkPrefix`, so a link *out* of the Book is still left exactly as written; a regression case
  covers the resolved link, the dead link, and the outbound link, and was watched red.
- **The atomic swap could lose a Book to a momentary sharing violation.** The first full rebuild lost
  one Book of thirteen to *"Unable to remove the file to be replaced"* — something else on the machine
  holding the destination open for an instant. The design handled it correctly, which is worth
  saying: that Book read `dirty`, the other twelve committed, and a scoped repair fixed it. But the
  cost was a spurious dirty Book and a second approved pass over closed content, so the swap now
  retries with backoff and fails only against a destination nothing releases. The regression case
  holds the file open for the whole call, asserts the swap still fails, and asserts from the elapsed
  time that it tried more than once.

**The live run, 2026-08-19**, under the reader's explicit closed-content approval, one Book scoped
first and then the rest — the shape rung 5's live run used:

- `agent-mail-harness-onboarding` alone under `plan_id update-shared-book-manifests-6f775962…`,
  committed at generation 1 with its stored digest matching a fresh generation.
- Then all 13 under `plan_id …-7de72c74…`: 12 committed, 1 already current, **339 pages and 2,013
  headings** now discoverable across the shared collection, nothing dirty, nothing pruned.
- Then a `-Rebuild` under `plan_id …-6e5e6c7f…` to carry the reader-map fix, which is where the swap
  defect surfaced: 12 to generation 2 reporting `changed: False`, one dirty, repaired under its own
  scoped `plan_id …-1e221a38…` at generation 3.
- A dirty marker planted on a real shared Book made the answer read *PARTIAL*, dropped
  `books_searched` to 24 of 25, named the Book with the **shared** repair, and left the other 24
  answering. The marker was removed and the store re-read `ok`.
- The whole path end to end over JSON-RPC through the reader adapter, not only in process:
  `discover_book_pages` returns an answer spanning 25 Books across both collections, and a blank
  query is still refused by name.

Worth recording about `-Rebuild`: it reported `changed: False` for every Book even though the
manifests genuinely changed. That is correct and not a bug — `changed` compares `source_digest`,
which is a hash of the **Book's pages**, and the Books had not changed; only our reading of them had.
The digest answers "has the Book moved on", never "is the manifest different".

### The shared archive, added 2026-09-08

`-IncludeArchive` brings `archive/<slug>` into the same pass, and it is the same manifest a third
time: the same `New-BookManifestFromPages`, the same caps, the same capture exclusion, stored in the
`shared-archive` collection [ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md)
created. **Nothing in Discovery changed** - it already looped over `Get-BookManifestCollections`,
already read a `shared-archive` roster, and already *refused* a collection it had no roster for, so
the seams did their job and this was generating manifests rather than teaching search.

What it did change is that a **slug stopped identifying a Book**. `books/x` and `archive/x` are two
Books that share a name, so the store key, the lock, the journal entry, the digest that binds the
approval, and the preflight row a reader approves are all Book **roots** now. Where a Book's pages
are is `Split-BookRoot`'s `wiki_root`, never a composed path - and that is the whole failure mode
worth naming: a helper composing `books/<slug>/wiki` for an archived Book does not error. It reads
the ACTIVE twin and commits a complete, well-formed manifest, with a plausible page count and a real
reader map, under the archived Book's name. Nothing is missing, so no absence-based assertion sees
it.

So the suite's archive fixture gives `dup` a Book in **both** halves with different pages, different
headings, and a reader map whose links carry the archive root, and asserts that each store holds its
own Book's content. The consistently-composed defect - listing and generation agreeing with each
other and both about the wrong Book - was watched red in five places, including the journal, where
the two Books recorded one digest. `desk.book-root-schema` now also scans the two shared helpers
statically, so the composition cannot come back.

Three asymmetries with the Shelf archive, each recorded in ADR-0012: the archive index is the
roster's source and is behind MCP, so an **unreadable index is fatal** rather than an empty archive;
the archive's stores are **swept only when the archive was in scope**, and the second prune signal is
read at the archived Book's own page rather than its active twin's; and an archived Book carries
**no summary**, because the index writes an archived date where the active catalog wrote a
description.

### What rung 7 does not do

- **Shared Books contribute no topics.** The shared `_book` page has no `**Topics:**` bullet — its
  shape is `# Title / ## Purpose / ## Reader map` (`Publish-SharedBookCandidate.ps1:126`), so all
  thirteen stored manifests carry an empty topic list. The generator honours the bullet if one ever
  appears; nothing is broken, and a `topic` match simply cannot come from a shared Book today.
- **The shared capture signal is single and always absent.** No shared Book is a capture Book —
  capture is a local Shelf surface by `capture-book-model.md` — so the union rule that fails closed
  twice on the Shelf has one signal here. A shared capture Book, if one is ever created, **must**
  carry `- **Kind:** capture` on its `_book` page or its page metadata will be published as curated.
  The fail-closed half that does hold: an unreadable `_book` page refuses the Book outright.
- **Only one kind of truncated listing is detectable.** A listing missing the Book's `_book` page is
  refused; a listing that quietly drops some *other* page is indistinguishable from a smaller Book,
  and would commit a manifest describing less than the Book holds. Nothing available over MCP gives a
  second signal to check the first against.
- **A shared capture Book has no live path.** An open Shelf capture Book's pages are read from disk at
  query time; a shared one has no filesystem, so it contributes Book-level hits whether open or
  closed. A canary covers it.
- **Nothing schedules any of this.** A shared Book edited on the NAS updates no manifest and sets no
  marker, exactly as on the Shelf, and `-Rebuild` remains the only thing that can detect it — now at
  the cost of re-reading closed bodies under a fresh approval. The roster date in every answer is the
  visible half of the same gap.
- **Discovery still offers no regex and no wall-clock cap**, which is 2.5's to design across all
  three tiers, and **a heading is still not a claim**, which is 2.6's.

## Known limits, recorded now rather than when they bite

- **Shelf Books only.** Shared Books are reachable only over MCP, which a plain helper process does
  not have. The shared half of generation belongs to the Librarian for exactly the reason 2.2's
  backfill split names, and it is not written yet. **Closed by rung 7**, which wrote it -- as the
  Librarian, over MCP, under the reader's explicit approval. What replaces this limit is narrower and
  is recorded in *What rung 7 does not do*: a roster Discovery cannot refresh by itself, one
  detectable kind of truncated listing, and no topics on the shared side. The shared collection's
  **archive** followed on 2026-09-08 under `-IncludeArchive`; see *The shared archive* above.
- **Setext headings are not extracted.** `Title` underlined with `===` is a heading in Markdown and is
  invisible here. No Book on this Shelf uses the form; if one arrives, this is a generator change and
  a fixture, not a redesign.
- **An out-of-band edit still goes undetected** until something regenerates. Nothing in rung 1
  changes that; it is `-Rebuild`'s problem, and `-Rebuild` reads bodies and so carries the same
  authorization requirement as backfill.
- **A crash mid-rename can still leave an orphan store, but never one that answers.** Rung 4 closed
  the original form of this: a rename now retires the old slug's store rather than leaving it behind.
  What remains is one narrow window — a crash after the new identity is marked dirty and before the
  old store is removed leaves both, and **both refuse**, because the marker is down on each. A
  refusing orphan costs a rebuild and a directory; the old orphan gave a confident answer about a
  Book at a path that no longer existed. Pruning stores with no Book belongs with rung 5's rebuild,
  which is the pass that already walks the Shelf. **Closed by rung 5**, whose prune sweep removes a
  store only when the catalog and `shelf/` agree the Book is gone.
- **"dirty until rebuilt" names a repair that does not exist yet.** A writer whose manifest commit
  fails says so accurately, and the helper that rebuilds is rung 5. The practical cost today is zero,
  because Discovery is not built either and nothing reads a manifest; the next successful mutation of
  that Book also clears it. Worth knowing before someone goes looking for the rebuild. **Closed by
  rung 5**: the plain `Update-BookManifests.ps1` run is that repair, and it covers every state that
  is not `ok` rather than only `missing`.
- **A Book that is deleted outside the helpers still leaves its store.** Nothing in the Library
  deletes a Shelf Book, so there is no writer to route; the same rung 5 sweep is where this is
  noticed rather than a limit any writer can close. **Closed by rung 5's prune**, on the two-signal
  rule — a Book absent from both the catalog and `shelf/` is an orphan; absent from one only is
  reported and kept.
- **Nothing schedules a rebuild.** A Shelf page edited in an editor updates no manifest and sets no
  marker, so the store stays confidently stale until someone runs `-Rebuild`. Rung 5 makes the drift
  *detectable*; it does not make it self-correcting, and no rung on this ladder does.

## The rungs, and where the ladder stands

2. Storage: catalog-class paths, versioned generations, the dirty marker, the commit pointer written
   last, and a read path that refuses a dirty or incomplete generation. **Landed 2026-08-18** — see
   *Rung 2* above.
3. The single manifest-generation transaction, holding 0.7's per-Book lock from before the dirty
   marker until after the commit pointer. **Landed 2026-08-18** — see *Rung 3* above.
4. Retrofit every existing mutator onto that transaction — `Move-ShelfNote`'s `Review`, `ToNotebook`
   and `Discard` included (that helper was absorbed into `Invoke-LibraryTriage.ps1` on 2026-08-28;
   the three modes are now the `review`, `notebook` and `discard` kinds) — plus the check that fails a writer which does not route through it, and
   the orphan store a renamed Book used to leave behind. **Landed 2026-08-18** — see *Rung 4* above.
5. Local Shelf backfill, the repair for every state that is not `ok`, `-Rebuild` for the out-of-band
   edit, and the prune sweep for a store whose Book is gone — journalled and resumable.
   **Landed 2026-08-19** — see *Rung 5* above.
6. Discovery itself: manifests only, refusing dirty generations, joining `internal/overlap-records.json`
   for the overlap field, returning Book slug, page path, matched heading, and overlap status —
   never body text. **Landed 2026-08-19** — see *Rung 6* above.
7. Shared backfill, preflighted, with explicit closed-content authorization -- the Librarian's,
   because the mechanism is absent from a delegate process -- the collection-namespaced store it
   needed, and Discovery over both collections with coverage it computes rather than assumes.
   **Landed 2026-08-19** -- see *Rung 7* above. **The ladder is complete**, and item 2.2 with it.

## Key Takeaways

- A manifest is catalog-class material, so what it *stores* is what it *discloses* — filtering the
  query would have been the wrong layer, and ADR-0002 says so directly.
- Capture Books are withheld on the union of two signals and refused on the absence of both, so the
  quiet failure mode is a Book that discloses too little rather than too much.
- The manifest carries no timestamp, which is what makes "unchanged" a hash comparison.
- Rung 1 generates; it does not store, and it does not authorize the reads it performs.
- Manifests live in `internal/`, not `shelf/`, because the Shelf read guard would otherwise make
  them unreadable exactly when a closed Book needs describing — and a self-test asserts it.
- The read path fails closed on five states and throws on none of them, because Discovery iterates
  every Book and one Book mid-write must be unavailable rather than fatal.
- Refusing a good manifest costs a rebuild; serving a bad one costs a wrong answer that looks right.
  That is why the dirty marker is cleared after the commit pointer, not before it.
- Ordering survives a crash; it does not survive a second writer. The lock is what makes two correct
  writers unable to compose into a manifest describing a Book that never existed.
- It is 0.7's lock extended, never a second one beside it — two locks over the same Book exclude
  nobody — and a caller already holding it passes it in, because the lock is not re-entrant.
- A failure before the dirty marker must leave nothing behind; a failure after it must leave the
  marker. The two halves of the transaction fail in opposite directions on purpose.
- A writer opens a mutation window rather than committing afterwards, because "afterwards" is a span
  in which a changed Book still has a manifest that answers.
- Completing a mutation cannot throw. Refusing a good manifest costs a rebuild, serving a bad one
  costs a wrong answer that looks right, and discarding a landed write costs the reader their
  material — which is the worst of the three and the only one a thrown exception would cause.
- The manifest refresh inherits the mutation's own authorization; it never grants one. Capture is
  ungated, a page add needs the Book open, a rename needs an approval, and the manifest follows.
- A rename retires the old identity's manifest instead of moving it, because a manifest is derived
  state and generation N of the old slug describes a Book with the old slug inside it.
- The default backfill run is the repair "dirty until rebuilt" names; a repair reachable only through
  `-Rebuild` would leave the string still lying.
- `-Rebuild`'s product is not the rebuild but the digest comparison — *which* Books were edited out
  of band is the question nothing else in the Library can answer.
- Resume and `-Rebuild` are incompatible on purpose: the store confirms only the last commit, which
  is exactly what an out-of-band edit leaves stale.
- A preflight the reader reads is a disclosure surface, so it carries counts and never a page path,
  a page title, or a note title.
- Prune requires two signals to agree before removing anything, and that is what turned a scoping
  defect into a noisy preflight instead of eleven deleted stores.
- A static rule that reads source text must strip block comments first, or documentation satisfies
  the rule that enforcement depends on.
- Enforcement lives in the writers and is proved by the gate, because no Claude-side hook runs in a
  delegate process. A static rule catches a writer that never routes; a behavioural run catches
  routing that is broken; only an injected mid-mutation failure can tell the two orderings apart.
- A surface choice decides reach, not safety, when the boundary is enforced in the engine both
  surfaces share. Discovery sits on the reader MCP because that is where the answering loop already
  looks, and its engine sits in `tools/` because that is where a suite can hold it.
- A query that quietly returns less is worse than one that fails. Every Book the store will not call
  `ok` is named in the answer with its status and its repair, and the searched count falls to match.
- Discovery re-classifies nothing. The store is the single point of refusal, and the canary that
  proves it is a mutation to the *store* rather than to Discovery.
- An open capture Book's pages are read live rather than stored, because a second store would be
  derived state nothing invalidates — and a live read cannot be stale.
- Every answer states its own scope on the first line. A limitation recorded only in a design
  document is not a limitation the reader has been told about.
- A permitted output field set declared in one variable turns "we would never return body text" into
  an assertion a later rung has to break on purpose.
- A suite whose assertion indexes an empty match set stops at the first canary that notices, so a
  suite that has the right canaries can still show only one of them. Watching mutations fail is what
  finds that; a green run never will.
- A store keyed on a name alone is keyed on a coincidence as soon as there are two collections of
  names. The lock had distinguished them since 0.7; the store was one slug collision away from
  answering for the wrong Book, and no status could have caught it.
- Establish the enumeration primitive before designing anything on top of it. Everything above it --
  schema, caps, capture exclusion, digest -- was already settled and could be shared; the only real
  unknown was where a page list comes from when there is no filesystem.
- One generator for both collections, or they drift. The seam is a page list of {path, text, bytes},
  which is what let the Shelf keep hashing raw file bytes and every digest committed since rung 2
  stay valid.
- A listing missing the Book's own _book page is the one truncation that can be checked, so it is
  refused; a listing quietly missing some other page is indistinguishable from a smaller Book, and
  that is written down rather than implied.
- The shared collection's only capture signal is the Book's own _book page, so an unreadable _book
  page refuses the Book. Silence is never read as "not capture".
- A preflight may count what it must not name. Counting pages takes a directory listing; showing one
  would put page paths in front of the reader, which is what the approval has not been given for yet.
- Coverage is computed from what happened, not from the fact that a loop ran. "All searched",
  "PARTIAL and here is who is missing", and "out of scope" are three different answers.
- A roster is what makes an un-backfilled Book *unavailable* rather than *invisible*, and its date
  belongs in the answer: Discovery cannot see the shared catalog, so a Book added since the last
  backfill is unknown rather than merely unread.
- A mutation that leaves the file unparseable is a false red. It proves the suite noticed a syntax
  error, not that the canary works.
- The fixture agreed with the code and both disagreed with the NAS -- twice now. Shared reader-map
  links are full note paths, and only real input said so.
- An atomic swap can lose a race it did nothing wrong in. The design's answer -- one dirty Book, the
  pass carries on, a re-run repairs it -- was correct and still cost an approved second pass over
  closed content, which is why the swap now retries.
- `-Rebuild`'s `changed` compares the Book's pages, never the manifest. Twelve Books reporting
  `changed: False` while their manifests were rewritten is the field answering the question it was
  built to answer.
- A canary written over ASCII cannot catch an encoding defect. `Get-Content -Raw` reads a BOM-less
  UTF-8 file as ANSI, it had been mangling every manifest text field since rung 2, and it took real
  input to see it because every fixture was ASCII and the only thing compared was a hex digest.
