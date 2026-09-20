# Library Inventory and Triage

> **Status:** implemented, 2026-08-13; extended to **Handoff v2** on 2026-08-18 (plan item 1.4); and
> on **2026-08-28 Handoff collapsed into Triage** (fork A), which is where this record's vocabulary
> now sits — see [Triage: one verb, two sources](#triage-one-verb-two-sources-2026-08-28) for the
> kind-by-source matrix, the split gate, and what happened to the handoff helpers.
> The implementation preserves local pages and uses explicitly confirmed copies for any Library
> write. Every section below the 2026-08-28 one is **kept as written on its own date**, and says
> `handoff` where that was the word: a dated design record is a true statement about that day, and
> rewriting one would falsify it. Read `handoff` in those sections as the operation now called
> triage from a Notebook source.

## Decision

Add a light **Library Inventory** before adding any automated Library handoff. The Inventory
reports deterministic facts about the local `notebook/` and its known internal publication journals. The
Librarian then suggests a destination in plain language. It does not embed a four-way classifier
in code or silently move notes.

The normal phrases are:

- "What would reset remove?"
- "Show me what is already copied to my Library."
- "Make a Library copy of these notes."

Use **copy to the Library**, not **backup**. `raw/` and `output/` are outside the normal scope, so
the Library cannot honestly promise a complete workspace backup.

## Reader-facing behavior

The default scope is the current local `notebook/` only. The system proposes one of four actions for
selected notes:

| Proposed action | Intended use |
| --- | --- |
| Refresh an existing Book | Reusable information that belongs with an existing reader Book |
| Copy to an active Project Hub | Current, outcome-specific, or installation-specific context |
| Create a new Book or Project | No fitting existing destination and a clear future use |
| **Hold** on the Holding Shelf | Draft, mixed, or uncertain material |

The fourth action was *"Leave local"* until 2026-08-18. That wording predates the Holding Shelf and
had become actively wrong: leaving uncertain material local means leaving it in the Notebook, which
is exactly where a reset deletes it. **Hold** captures it to the Holding Shelf instead — reset-immune,
closed by default, and surfaced as a pending count by `tools/Get-DeskOverview.ps1` so it cannot rot
unseen. Uncertainty is a reason to keep material somewhere safe, not a reason to keep it nowhere.

These are suggestions, not persistent note states. The local Notebook remains the source for a Book
refresh. A NAS Book is a reader copy, never a second independent authoring source.

The Librarian may explain its recommendation briefly. It must not split paragraphs automatically,
invent confidence, or create a duplicate Book merely because a match was uncertain.

## Reset safety advisory

`Reset-LocalNotebook.ps1 -Preflight` gains a facts-only advisory identifying local Notebook pages that
have no current known completed Library-copy record. It shows the exact `notebook/` target, item count,
and open-Book/open-Project advisory.

Reset remains its own transaction. A user who wants to preserve material first performs a normal
Library copy and receives its result before deciding whether to reset. The reset command never
chains shared writes into its destructive confirmation and never claims that excluded or uncertain
material is protected.

See [Notebook and Desk Model](notebook-and-desk-model.md) for the durable/volatile boundary and
the isolated Claude acceptance evidence for the confirmed reset path.

## Facts before judgment

`Get-LibraryHandoffInventory.ps1` is read-only. It reports facts needed for a useful suggestion:

- local Notebook pages and their hashes;
- known completed local publication manifests, their source boundaries, and matching or drifted
  source hashes;
- pages with no known matching Library-copy record; and
- Book and Project slugs named by those local copy journals.

It does not classify content, mutate the Notebook, or make a NAS call. Publication journals are kept
under `internal/publication-journals/`, separate from user-facing `output/`. The LLM uses this inventory plus
the user's request to propose a small handoff plan in prose.

## Safe handoff execution

An approved handoff is copy-only and per-destination. Its plan contains selected source pages,
destination, expected page paths, and a plan/manifest digest. Execution must receive that approved
digest and fail closed if the source changes between preflight and write.

Every destination reports independently. The runner continues through the independently preflighted
destinations and returns `succeeded: false` with the error for any failed destination; it never
labels a partial handoff as an all-or-nothing success. Local source pages remain intact, so an
interrupted handoff cannot create data loss by itself.

### Books

Selected-page publishing is a prerequisite. It must:

1. generate the Book reader map from the selected pages rather than copying a local index that may
   link to omitted pages;
2. validate internal links and either include required targets or stop before writing; and
3. distinguish refresh-in-place from create-new.

Removing an already-published page is a separate, explicitly confirmed Book-refinement operation.
A normal refresh does not claim to remove historical pages that are no longer selected.

### Projects

Ordinary Project note-taking remains an exact direct write/readback. A multi-page handoff instead
uses a bounded Project-copy helper with the approved page manifest, exact path readback, and an
explicit collision policy. `New-ProjectHub.ps1` gains an optional preflight for handoff planning,
while its ordinary direct creation path remains simple.

## Catalog grouping

The publisher owns an optional `Collection` value and, when one is supplied, inserts a Book beneath
the matching **Projects**, **Reference**, or **Workflows** heading. Existing catalog entries remain
where they are. Collections are presentation metadata only: they do not change Book paths, create
quality stages, or require users to maintain tags.

## Buzz separation result

The original **Buzz Self-Hosting** Book included the installation-specific
`buzz/deployment-record.md`. The separation was completed on 2026-08-14:

1. **Buzz Relay Deployment** was created as the active Project Hub at
   `projects/buzz-relay-deployment/`, with the deployment record under `notes/`.
2. The Project root records its connected Books and tools so a returning reader can receive a
   short orientation briefing.
3. The local Buzz index now links to the Project record rather than treating it as Book content.
4. The shared **Buzz Self-Hosting** Book was refreshed from the ten reusable local pages, excluding
   the deployment record.

The old shared deployment page was deliberately left as an unlinked historical page. A refresh
replaces only its planned reader pages; it does not silently delete prior Library records.

## Implementation result

Implemented on 2026-08-13. The disposable Library acceptance run created a selected-page
**Workflows** Book and a Project Hub note, then re-ran successfully by exact digest readback.
The live `ai-library` follow-through on 2026-08-14 created the approved **Buzz Relay Deployment**
Hub and refreshed the reusable Buzz Book with its deployment-specific page excluded.

### Acceptance findings retained in the implementation

- Basic Memory supplies its own frontmatter and may return a leading line break. Project-copy
  verification normalizes that server representation before comparing the approved UTF-8 digest;
  the source text itself is not silently changed.
- A confirmation now binds the complete generated Book manifest, not merely the source-page
  digest. A Project-copy confirmation likewise includes the requested Project Hub details. A stale
  or incorrect `plan_id` stops before any shared write.
- A completed Project copy writes the same local per-page manifest evidence as a completed Book
  copy, so later reset preflights can recognize matching Project copies without a NAS call.
- An interrupted handoff is resumable when the exact stored content matches the approved manifest.
  The acceptance case first stopped after a Project-note readback mismatch, then resumed with all
  matching records reused after the verifier was corrected.
- The Inventory correctly reports a page as drifted when its local source changes after its
  recorded copy. Older publication journals, including the historical Buzz one, are reported as
  `legacy-copy-record`: they document a past copy but do not provide a current per-page manifest.

## Buzz sequence lesson

The staged order worked: create the Project home first, record the Book and tool connections,
update the local source index, then refresh the Book from the reusable selection. It preserved the
deployment record throughout and avoided treating a copied note as automatic permission to delete
the historical shared page.

## Pi-fit result

**Proceed.** The user starts with a plain-language request. Inventory facts and manifest checks are
quiet helper behavior. One clear approval covers a chosen copy operation; the destructive reset
remains separate. Ambiguous material stays local rather than being forced into a Library category.

## Handoff v2: four destinations, one approval

Plan item 1.4, 2026-08-18. Until then `Invoke-LibraryHandoff.ps1` hardcoded `Destination = 'Shared'`
and its validator accepted only `book` and `project`, so a handoff could only ever reach the NAS.
The operation whose entire purpose is "lose nothing before a reset" could not write to the tier that
exists for exactly that.

### The four kinds

| Kind | Destination | What it does | Gate |
| --- | --- | --- | --- |
| `holding` | Shelf | Captures one Notebook article to a capture Book — the Hold action | none; capture is deliberately ungated |
| `shelf-book` | Shelf | Graduates one article into a curated Shelf Book | that Book open on the Desk |
| `project` | shared collection | Copies Notebook pages to an active Project Hub | none beyond the batch approval |
| `book` | shared collection | Creates a **new** shared Book | none beyond the batch approval |

Every kind is **create-and-additive only**. `replace_existing` is rejected at plan validation rather
than left unused, because publication journals record new manifests and hashes, not the bodies an
overwrite destroyed: a misclassified replace inside a batch has no rollback. Refreshing an existing
shared Book, or appending to one, is a separate and separately approved operation.

### Every action gets an identity

The old handoff digest composed child `plan_id` values, which could never have covered a whole
batch: `holding` and `shelf-book` issue no `plan_id` at all. Each action now carries an `action_id`
and a content-bound `action_digest` over its destination, operation, metadata, source hashes,
collision policy, required Desk state, and its canonical write set. The batch identity is composed
from those digests, which is also what lets the batch journal be read *before* any child runs.

### Write set and touch set are different things

- **write_set** — paths the action must *create*. Checked for overlap across the batch, bound into
  the approval digest, and required absent when the action runs.
- **touch_set** — paths the action updates additively: a Book's reader map, the shared Book Catalog.
  Two actions may share these, because the writers regenerate or append under the Book's own lock. A
  shared index is not the guaranteed-partial-batch hazard a shared create is, so an overlap there is
  recorded, never refused.

Computing the write set at validation and recomputing it at execution would not be equivalent. A
Holding Shelf filename derives from the date and from collision suffixing, so a batch approved on one
set of paths could otherwise execute against different ones. `Add-ShelfNote.ps1` therefore takes
`-RequireNoteFile`, which pins the approved name: an occupied name is a refusal, not a relocation.

The write set is computed locally, without a NAS call, from the same path rules the child writers
use — and then `Invoke-LibraryHandoff.ps1` asserts each child's own preflight agrees with it. That
equality check is the point of the arrangement rather than a redundancy: it is what stops two
definitions of one path rule drifting apart unnoticed. It earned its place on its first run, catching
that `note_page` is a page identity without the `.md` a write set names.

### The batch state machine

1. **Preflight every action.** Any failure refuses the batch before a single write. Plan validation
   has already rejected write-set overlaps, because two actions creating one path is a guaranteed
   partial batch that was knowable without running anything.
2. **Execute in fixed order** — `holding`, `shelf-book`, `project`, `book` — cheapest and most
   reversible first, so a late failure never strands local material.
3. **Revalidate each gate at execution:** source hashes unchanged, Book still open, approved paths
   still writable. A per-action gate failure means two different things depending on when it is
   found: before approval it refuses the batch, after approval it fails that action alone.
4. **Continue on failure.** The reader's goal is losing nothing, so saving what can be saved beats
   stopping early.
5. **Report per-action status.** The batch is `incomplete` unless every action succeeded. A partial
   handoff is never dressed up as a success.
6. **Retry re-runs only actions not marked succeeded.** A succeeded action is an idempotent no-op;
   drift in any source changes the batch identity and demands a fresh preflight.
7. **A durable batch journal owns that state,** at `internal/handoff-journals/<batch_id>.json`,
   rewritten in full and moved into place after every action. Without it step 6 is unimplementable
   across processes: returning outcomes tells the next process nothing.

**A rollback shape the earlier writers do not have.** 1.1 and 1.2 answer a failure by leaving no
trace — a half-renamed Book or a half-added page is worse than none. A batch answers the opposite
way: what already landed must *survive* the failure of a later action, because that is the material
the reader ran this to keep. The per-action writers still roll their own work back; the batch does
not roll back its siblings.

**The crash window, and why an interrupted action is not retried.** Success is journaled *after* the
child writes, so a process that dies in between leaves durable output recorded as pending — and a
resume would then refuse that action forever, because its own approved path is occupied. The journal
therefore records `attempting` **before** the child runs. On resume an `attempting` record means the
destination state is unknowable from here: retrying could duplicate, and marking it succeeded would
be a claim nothing checked. The action is reported `interrupted` with its write set, left untouched,
and the reader is told to look before rebuilding the plan. Automatic reconciliation by content is not
available for `holding`, because `Add-ShelfNote` stamps a capture timestamp into the page and those
bytes cannot be recomputed.

**One writer per batch.** The child writers each take their own Book lock, but nothing stopped two
processes running the same pending action and then overwriting each other's journal. The runner holds
an exclusive batch lock — the same `BookWriteGuard.ps1` primitive, keyed `handoff/<batch_id>` — from
journal load through the final save, and each journal write goes through a uniquely named temporary
file rather than a shared `.tmp`.

**A journal is evidence about one batch, and is checked as such.** Its schema, its `batch_id`, and
every recorded action's `action_digest` must match the batch being run, with no duplicate or unknown
action ids. Accepting an unchecked `succeeded` record would let a stale or hand-edited file silently
skip real work, which is the one failure a resume must never have. `-JournalPath` is confined to
`internal/handoff-journals/` exactly as `-PlanPath` is confined, because the journal is written with a
forced move.

**One honest limit.** The batch journal is local evidence about a possibly remote destination. If a
shared record is deleted after a batch recorded it as succeeded, a resume will skip it rather than
recreate it. Rebuilding the plan produces a new batch identity and a fresh journal, which is the way
out.

**A second, narrower limit.** The runner re-hashes each source immediately before invoking its child,
because the local writers take a path and read it again themselves. That closes a window that exists
only *within* a single run, and so cannot be reached from a single-process test — it is
defence-in-depth, and the tested guarantee is the outer one: a source edited between plan creation and
execution changes the action digest and the plan is refused.

### What the seventh review round found

The design above was reviewed across six adversarial rounds before any code existed
(`PLAN-REVIEW-LOG.md`). The implementation was then reviewed once more, on 2026-08-18, against that
settled design. Eight findings, all real, all fixed, each now carrying a regression check:

- `include_pages` was applied as metadata *after* the write set and source manifest had been built
  from every file, so the child's preflight disagreed with the approval and **every legitimate
  subset was refused**. It is applied before both now.
- Project and Book **titles were absent from the action digest**. Paths derive from the slug, so a
  retitled Book moved no file and the approval did not notice. Metadata is also length-prefixed
  before hashing, so one field holding `a,b` can no longer hash the same as two fields holding `a`
  and `b`.
- The **crash window** above, and the batch lock above.
- An existing **journal was trusted** without checking which batch it belonged to.
- **`-JournalPath` was unconstrained** and reached a forced move.
- **Two Project actions for one Hub** have disjoint write sets and still cannot both run, because
  the first creates the Hub and invalidates the second's child approval. Rejected at validation.
- Local children **re-read their source** rather than being pinned to the approved hash.

Worth recording as a pattern rather than seven separate bugs: six of the eight are the same shape —
*an approval, a journal, or a set that describes less than it appears to*. That is the failure mode
a batch operation is most prone to, because everything it binds is one step removed from what it
actually does.

### Honest write reporting

The old runner set `shared_library_write` whenever any action succeeded, which would have claimed a
NAS write when only a Holding Shelf entry landed. The result now reports `shelf_write`,
`shared_collection_write`, and `notebook_write` separately, each derived from the destinations that
actually succeeded. `notebook_write` is always false: a handoff copies out of the Notebook and never
into it, which is why an interrupted batch cannot lose material by itself.

A batch of local-only actions makes no MCP call at all and runs with the shared collection
unreachable — proved in `tools/Test-LibraryHelpers.ps1` by pointing it at a dead endpoint.

## Key Takeaways

- Inventory reports facts; the Librarian makes a small, explainable recommendation.
- Existing Books are refreshed before new Books are created.
- A handoff is a verified copy, not a full-workspace backup or a reset transaction.
- Selected-page publishing needs a generated reader map and link validation before it can split a
  mixed topic safely.
- Uncertain material is **Held**, not left local: leaving it local leaves it where a reset sweeps it
  into quarantine, which is recoverable but is not a destination anyone chose.
- A batch may only create. Overwriting a shared destination has no rollback, so it is not available
  inside one approval.
- A partial batch is reported as incomplete, keeps what landed, and is resumable from a durable
  journal.

## What a page names, and whether that is durable (2026-08-19)

**Found in use, not by a check.** A handoff proposed rescuing
`notebook/library-dev/rung5-manifest-backfill-spec.md` as *"a frozen, ready-to-implement spec for
work that hasn't been built yet"*, citing the check suite as confirming `shelf.manifest-backfill`
was unregistered. It is registered, it passes, `tools/Update-BookManifests.ps1` is on disk, and
`docs/discovery-manifests.md` carries a full *Rung 5* section. The work shipped. The page is a
delegation brief for completed work, not a spec at risk.

**`copy_status` was not the problem, and saying so matters.** It answers one question well and
evidence-first: does a publication journal record *this exact content*, by hash, reaching a Book or
Project? `no-known-copy-record` was a **true** statement about both library-dev pages. What it
cannot see is a page whose substance was written into a git-tracked design record rather than
published as a page -- and that is a paraphrase relationship, not a copy, so no hash can find it.

**So the pages are asked what they point at.** `Get-PageReferences` extracts workspace-relative
paths from each page's text and classifies each as `tracked`, `untracked`, `missing`, or `unknown`.
Against the real corpus the two pages in question now read:

| page | reference | |
| --- | --- | --- |
| `rung5-manifest-backfill-spec.md` | `docs/discovery-manifests.md` | tracked |
| | `tools/Update-BookManifests.ps1` | **tracked** -- the helper it specified |
| `delegate-harness-evaluation.md` | `docs/model-division-of-labor.md` | tracked |

Eleven more tracked references sit under the first. A Librarian reading that cannot claim the work
was never built.

**A REFERENCE IS A POINTER, NOT PROOF OF COVERAGE**, and the report says so in its own output rather
than leaving it to be inferred. `tracked` means git holds that file -- never that it covers this
page. This is the same rule as *a hit is a location, not a reading*, applied to a different tier:
the scan narrows where to look and settles nothing on its own. Only a reader opening the reference
can say whether it covers the page, and that judgment is deliberately not automated.

**It fails closed.** When git cannot be consulted -- absent, or not a repository -- every reference
reads `unknown` and `references_resolvable` is false. It never reads `untracked`, because that would
make a page look **more** at risk than it is, which is the original misreading pointed the other way.

### The defect the mutation sweep found

`Get-TrackedPathSet` built a `HashSet[string]` with an `OrdinalIgnoreCase` comparer and returned it
bare. **PowerShell enumerates a collection on output**, so the caller received a `String` for one
tracked file, an `Object[]` for several, and `$null` for none -- never the HashSet, and never its
comparer. Three silent consequences: a path differing only in case was misclassified, though these
are Windows paths where case does not distinguish files; with exactly one tracked file `.Contains()`
became `String.Contains`, a **substring** test matching any prefix of that path; and an empty set was
indistinguishable from failure. This repository has enough tracked files to land on `Object[]`, whose
ordinal `Contains` happens to be correct -- which is exactly why it looked right against real input.
`Write-Output -NoEnumerate` fixes it, and three canaries now assert the type, the case-insensitive
hit, and the refusal of a prefix match.

This is the same family as the recorded `, @(...)` lesson, met from the opposite direction: there,
unrolling had to be *prevented* at a return; here it happened silently and took a comparer with it.

**Eleven mutations, all watched red.** One first fired nothing and was a **bad mutation** rather than
a missing case: replacing `return $null` with `return $set` changes nothing, because the set is empty
at that point and a bare return enumerates it away. Rewritten to hand back a real empty set, it fires.

### Registered, and one found alongside

`handoff-inventory.selftest` (32 offline checks) runs in the `else` branch with the other spawned
suites. Adding it surfaced that **`Get-MeterStatus.ps1` has carried a `-SelfTest` since 2026-08-18
that nothing ever ran** -- it is now registered as `meter-status.selftest`. That is the Phase 2
lesson in its purest form: there, a check sat inside the `-Fast` else branch so it ran in the full
gate and never in the pre-commit hook; here it ran nowhere at all.

### What is deliberately not built

**Judging whether a reference covers a page.** That is paraphrase-level and cannot be computed
honestly, so it stays a Librarian judgment made against evidence rather than memory. A check that
claimed to answer it would be the documentation-satisfies-enforcement failure this codebase has
already paid for twice.

**A cap on references per page.** The largest real page names fourteen. A cap that cannot bind is a
flag nobody watches go red.

## Triage: one verb, two sources (2026-08-28)

Fork A, decided by the reader on 2026-08-28. Handoff and triage became one verb, `triage`, over two
sources. Everything above this section is kept as it was written and still says `handoff`.

### What the code said that the proposal did not

The two were framed as "one operation on two inputs". That is true of intent and wrong about shape.
Handoff was a **batch planner**: a JSON plan on disk, validated before an approval existed, write
sets computed and digest-bound, a durable journal, per-action retry, continue-on-failure. Triage was
a **per-note state change** inside one open Book. The gap was never source-versus-source; it was
cardinality and ceremony.

So the merge that paid was not "triage gains a `notebook/` source". It was **triage gains handoff's
destinations**, with the source deciding which are reachable — which closes a real cycle. Before
this, handoff's `holding` kind pushed into `shelf/holding` and triage's `ToNotebook` pulled back, and
neither drove material toward a Book: a captured finding bound for a Shelf Book detoured through the
volatile Notebook.

### The matrix

`source` is `notebook` (the default, so every pre-existing action shape still validates) or
`holding`, meaning one note in a capture Book named by `source_slug`.

| kind | from `notebook` | from `holding` | creates | destroys |
| --- | --- | --- | --- | --- |
| `holding` | yes | — *(already there)* | `shelf/<slug>/wiki/notes/<date>-<slug>.md` | — |
| `notebook` | — *(already there)* | yes | `notebook/<topic>/<file>` | — |
| `shelf-book` | yes | yes | `shelf/<slug>/wiki/<page>.md` | — |
| `project` | yes | yes | `projects/<slug>/notes/…` | — |
| `book` | yes | yes | `books/<slug>/wiki/…` | — |
| `review` | — | yes | *(nothing)* | — |
| `discard` | **refused** | yes | *(nothing)* | the note file |

**No `discard` from `notebook`.** The Holding Shelf survives a Reset, so leaving a note there is a
durable commitment and discarding it means something. `notebook/` is volatile, but a Reset
**quarantines** it rather than deleting it (ADR-0016) — so a notebook discard is not "delete it now
rather than at the reset"; it is strictly worse than the reset, destroying what the reset would have
kept recoverable. It buys nothing and adds a destructive mode to the one helper whose purpose is
losing nothing. The honest fifth option is to leave it, and the refusal says so rather than the kind
being quietly absent.

*(Corrected 2026-09-10. The two paragraphs above both rested on "the Reset already deletes all of
it", which stopped being true on 2026-09-07. The conclusion survives the correction; the reasoning
did not, and it had been the stronger-sounding half.)*

**Upheld on wider ground 2026-09-15**, because the reason above answers *deletion* and so kept
inviting the follow-up: if removal **quarantined** instead, nothing would be destroyed and this
argument would not reach it.
[ADR-0024](adr/0024-removal-from-the-notebook-has-no-destination.md) settled that removal from
`notebook/` has **nowhere to go at all**. Deletion is refused above; the quarantine is a reset's
recovery route rather than a destination, and its restore is per-topic and refuses a topic that
exists in `notebook/` again, so a drained *article* could never be returned; and a new local store is
the Notebook archive this Library refuses on three surfaces. The same ADR settles that removal does
not belong in Triage at all — `Graduate` is satisfied by the durable copy existing, and the Notebook
copy's departure is the Reset's.

Execution order is `review`, `holding`, `notebook`, `shelf-book`, `project`, `book`, `discard`:
cheapest and most reversible first, irreversible last. Discard running last is what makes "graduate
this note into a Book, then discard it" safe — any failure upstream leaves the note where it was.

### The gate rule, stated once

> Writing **into** a capture Book is ungated. Any action whose **source** is a capture Book requires
> that Book open on the Desk.

That is `Add-ShelfNote`'s rule and `Move-ShelfNote`'s rule expressed as one sentence, and it is the
easiest thing to flatten by accident when two helpers become one. Two consequences shaped the code:

- `required_desk_state` became a **list**. A `shelf-book` action sourced from the Holding Shelf needs
  the source Book open to name the note and the destination Book open to write the page, and one
  string could only ever have carried one of them.
- The gate is asserted **where the read happens** — inside `Resolve-TriageNoteSource`, before the
  Book's notes are listed — as well as by the runner immediately before each write. Resolution has to
  read every note's title to honour `source_match`, so a gate checked only afterwards would let a
  closed Book answer *"that matches two notes: …"* and name them. The runner's check is not
  redundant with it: a Book can be closed between the approval and the run.

### `delete_set`, and the batch refusals it made possible

A discard creates nothing, so an approval binding only `write_set` would bind nothing at all. Actions
gained `delete_set`, it enters the digest, and plan validation gained two refusals that were
previously invisible: two actions destroying one path, and one action creating what another destroys.

A third refusal is subtler. `review` and `notebook` rewrite the source note's own frontmatter, so a
`discard` of that same note in the same batch would find bytes its approval never covered and fail
`Assert-SourceUnchanged` **after** the other action had already landed. Knowable at plan time, so
refused there. `shelf-book`, `project` and `book` only *read* the note, so those combine with a
discard freely.

There is deliberately **no** delete-set existence check beside `Assert-WriteSetWritable`.
`Resolve-TriageNoteSource` lists the Book's notes from disk on every invocation, preflight and run
alike, so a note that has gone cannot be named and the refusal arrives before any gate. A check
nobody can make go red is a check nobody maintains.

### Frontmatter travels where a file is copied, and is separated where a page is composed

A capture note opens with a metadata block — `captured`, `review`, `source_project`. That is Holding
Shelf bookkeeping, not content.

- `notebook` copies the file verbatim, because there the frontmatter **is** the provenance the
  working copy should keep. This is what `ToNotebook` always did.
- `shelf-book`, `project` and `book` receive the body with the block separated off.
  `ConvertTo-ShelfPageBody` looks for a leading H1 and would otherwise put a generated heading
  *above* the block, turning provenance into a mid-page rule; a Project record is a Basic Memory note
  that writes frontmatter of its own; and the shared publisher has always separated frontmatter from
  every page it writes.

`Split-NoteFrontmatter` lives in `ShelfNoteCommon.ps1` and has three callers, because three
independent splitters of one format is how a page ends up with its heading below its metadata on one
route and above it on another. The digest binds the delivered body as well as the source file, so the
two cannot drift.

One decision inside that: `Publish-SharedBookCandidate` writes the whole file and reads it back with
`include_frontmatter=$false`, comparing against the split body. For a page that *has* no frontmatter
those are identical, which means that round trip has never actually been exercised — so a capture
note's block is stripped **before** the publisher sees it rather than relying on server behaviour
nothing has tested.

### The two child writers were widened, and that was not free

`Publish-BookCopy.ps1` and `Copy-LocalPagesToProject.ps1` hard-refused any source outside `notebook/`,
and `Publish-SharedBookCandidate.ps1` stamped `notebook/<rel>` into the Book's metadata and the
catalog Origin line. Both `holding → Project` and `holding → Book` were locked into fork A, so both
were widened to accept a second root: one note under a capture Book's `wiki/notes/`, and nothing else
under `shelf/`. `Resolve-LocalSourceRoot` in `ShelfNoteCommon.ps1` owns that rule, returns the
provenance label alongside the root, and asserts the Desk gate itself — a resolver that returned the
path without the gate would hand every caller a way around it.

The provenance label matters beyond tidiness: `Get-LibraryTriageInventory` reads the publication
journal's `source` field to decide whether a page already has a copy record, so a journal naming a
`notebook/` path nothing was ever read from would credit a Notebook page that does not exist and
leave the real Holding Shelf note reading `no-known-copy-record`.

### Schema 3: readable, not re-runnable

The digest recipe gained `source`, `source_slug`, `delete_set`, a list-valued `required_desk_state`,
and the delivered-body hash, so a schema-2 handoff plan cannot re-resolve to its recorded digest.
Supporting both would mean two digest recipes in one file — the exact "two parsers of one record"
failure this document warns about two sections up.

So: **read both, write one.** `-PlanPath` and `-JournalPath` accept `internal/triage-*` and the
legacy `internal/handoff-*` alike, nothing in the legacy directories is written, moved, or rewritten,
and a schema-2 document is read and then refused execution with a message naming the version, the
reason, and what to do. Nothing re-runnable was lost: all thirteen stored plans were spent and both
batch journals recorded every action succeeded. `triage.history-readable` asserts all of that on
every gate run, including that the check itself does not touch the records — `internal/` is
gitignored, so nothing else would notice if it did.

### The prose trigger was the real risk

`Reset-LocalNotebook.ps1` *calls* the inventory and surfaces its advisory, so that behaviour survived
the rename for free. What would not have survived is the sentence: `CONTEXT.md` defined Handoff as
"the sweep that makes a reset safe", and that is what made the Librarian offer it when a reader said
"reset". `Triage` is a tidying verb with no urgency. The merge could have deleted the safety prompt
while keeping every line of code, so `CONTEXT.md` and the Reset playbook now say **"triage the
Notebook first"** in words, and `reset.vocabulary-routes` fails if either stops saying it.

The reset advisory also gained the Holding Shelf counts under an explicit *survives this reset*
label. The preflight was steering a reader toward the Holding Shelf while saying nothing about it.

### What landed

Six files became three; public helpers went from four to two.

| Was | Is |
| --- | --- |
| `Get-LibraryHandoffInventory.ps1` | `Get-LibraryTriageInventory.ps1` — read-only, both sources, throws on neither |
| `HandoffPlanCommon.ps1` | `TriagePlanCommon.ps1` — the matrix, three path sets, the digest |
| `New-LibraryHandoffPlan.ps1` + `Invoke-LibraryHandoff.ps1` + `Move-ShelfNote.ps1` | `Invoke-LibraryTriage.ps1` |
| `ShelfNoteCommon.ps1` | unchanged in role — it is shared with capture and was never handoff's to absorb |

The single-note surface composes a **one-action plan in memory** — no plan file, no journal — so one
note and a batch of twenty compute their write sets, their Desk requirements, and their digest
through the same code. Confirmation is per **kind**, not per surface: `review`, `notebook`, `holding`
and `shelf-book` run on one call, because their child helpers never asked for more and making tidying
ceremonial is how tidying stops happening; `discard`, `project` and `book` take a preflight, the exact
`plan_id`, and one approval.

**The file-count justification was optimistic and should not be leaned on.** Excluding the `internal/`
journals, `handoff` appeared in fourteen docs, `CONTEXT.md`, `README.md`, the `library-help` reset
reference, three allowlist lines, four `_helpers.json` entries, and six tools beyond the four handoff
helpers. This was a workspace-wide vocabulary migration with a tool consolidation inside it. It is
justified on vocabulary.

Dated records were **not** rewritten — the pilot closeout, the iteration brief, and past-defect
narratives keep the word that was true on their date, each gaining one line noting the rename. That
follows the rule already written into `shelf.references`: *a design record naming `shelf/inbox` under
a 2026-08-16 date is a true statement about that day, and rewriting it would falsify the record.*
