# Derived Indexes: the Notebook master index and the Shelf catalog

`notebook/_master-index.md` and `shelf/_catalog.md` are **derived**. Nothing composes them by hand
any more: each is rendered from state that already exists, under a lock that serialises the render,
and written by an atomic replacement that a concurrent reader can never catch half-finished.

Landed 2026-09-07 as `PLAN-multi-desk.md` Release 1, steps 1-4. It stands alone from that plan's
seats: it removes races that were live in this single-seat workspace already.

## What was wrong

Both files were the authority *and* the published view, and every writer edited them in place.

- **The master index** was appended to by `Compile-RawBatchToNotebook.ps1` inside its own topic
  lock. Two compiles into two different topics held two different locks over one shared file. A
  renderer that snapshots `{a}`, is overtaken by one that creates `b` and writes `{a,b}`, then
  writes its stale `{a}`, **loses a topic** — and nothing downstream would notice, because
  `Get-DeskOverview.ps1` enumerates directories rather than the index and no check compared them.
- **Two helpers created a topic directory with no `_index.md` in it**: the compiler, before it wrote
  the index, and `Invoke-LibraryTriage.ps1`'s Notebook route, which wrote no topic index at all. A
  concurrent render would meet a topic it could not label.
- **The Shelf catalog** had five writers and no two agreed how. `Publish-BookCopy.ps1` and
  `Import-ExternalWikiToShelf.ps1` appended with `Add-Content`, unlocked, so two publishes could
  interleave into one line. Archive, Remove and Rename rewrote the whole file from a substring offset
  computed before their own directory work.
- **The catalog's authored header lived in `shelf/`**, which is gitignored. It was therefore
  unrecoverable from a checkout and drifted silently.

## The shape now

| File | Rendered from | Lock | Renderer |
| --- | --- | --- | --- |
| `notebook/_master-index.md` | the topic directories under `notebook/`, plus each topic `_index.md`'s H1 | `render/notebook-master-index` | `tools/NotebookIndex.ps1` |
| `shelf/_catalog.md` | `docs/templates/shelf-catalog-header.md` plus each `shelf/<slug>/_catalog-entry.md` | `render/shelf-catalog` | `tools/ShelfCatalog.ps1` |

Both renderers take the same shape: a caller does all its expensive work first, then hands the
renderer the one cheap thing that makes its change visible. Inside the lock there is only that
commit, the scan, the atomic write, and the readback.

### The critical section is deliberately tiny, and that is the whole point

Deriving the index does not by itself make concurrent writers safe — the lost-topic race above is a
race between two *renderers*. What makes it cheap is that almost nothing needs to render.

- **A new topic** changes which topics exist. It is staged whole under
  `internal/notebook-staging/`, complete with its `_index.md`, and promoted by a single atomic
  directory move **inside** the render lock.
- **An edited topic H1** changes a label the index shows, so it commits inside the lock too. This is
  easy to forget: the index derives the heading as well as the directory, so renaming a topic in
  place invalidates it without changing which topics exist.
- **Everything else — a new article in a topic that already exists, whose heading nobody touched —
  takes no render lock at all.** That is the ordinary case, and it is why two compiles into two
  different topics genuinely overlap.

`tools/Test-NotebookRenderLock.ps1` is the executable form of that sentence, with real processes:
holding the render lock, an existing-topic write still completes while a visibility commit is
refused; two concurrent commits keep both topics over disjoint held windows; two writes into
different existing topics overlap. Without it "narrow critical section" is a claim rather than a
property — and a widened lock breaks no other test and produces no wrong bytes. It only makes the
Library slow in the exact case the work exists to make fast.

Reset is exempt. It removes topics, so it holds the render lock across its removal and rebuild; a
reset is inherently whole-scope and has nothing to do outside the lock.

### Two promotion rules, because Windows has two cases

`Directory.Move` cannot replace a **non-empty** directory. So whole-topic promotion is available for
a **new** topic only. A topic that already exists takes individual **atomic file replacements**
under its own topic lock. There is no third rule; a reset removes topics rather than promoting them.

### Every derived write is an atomic replacement, unconditionally

This is what pays for the narrow lock. A writer whose topic H1 is unchanged never takes the render
lock, which means a renderer really can be reading a topic `_index.md` while another writer rewrites
it. `Write-AtomicText` in `tools/BookWriteGuard.ps1` therefore publishes by rename — bytes to a
uniquely named staging file in the destination's own directory, then a rename over the destination —
so a reader sees the whole old file or the whole new one, never a partial one, and a crash leaves
the old file untouched.

**The primitive was chosen by measurement, not reputation.** Both candidates were run against 400
rewrites of one file while another process read it as fast as it could, 2026-09-07:

| | reads | partial | sharing refusals | file-not-found |
| --- | --- | --- | --- | --- |
| `File.Replace` | 118,498 | 0 | 11,047 | **443** |
| `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING` | 218,700 | 0 | 303 | **0** |

Neither ever yields a partial file. The difference is what a reader is told when it loses the race:
`File.Replace` unlinks the destination before it renames, so 443 readers were told the file did not
exist — and a reader that concludes a topic index is *missing* is about to report a healthy topic as
degenerate. Passing a real backup path instead of a null one changes nothing (496 not-found reads),
so that unlink is not an artefact of the call.

`MoveFileEx` runs first for that reason. It has one gap of its own: it refuses `ACCESS_DENIED`
against a destination another process holds open at all, even one sharing `ReadWrite|Delete`, which
`File.Replace` serves happily. So `File.Replace` is the fallback, engaged only once half the retry
attempts are spent. A destination held *exclusively* is refused by both, which is the correct answer.

The other half of the contract is `Read-AtomicBytes`: a rename-over holds the destination for an
instant, so every Library reader of a derived index retries a transient refusal rather than surfacing
it as an unexplained failure in the middle of an unrelated operation.

`Write-AtomicText` is a thin wrapper over `Write-AtomicBytes`, which is the same measured mechanism
with a `byte[]` payload. The split landed 2026-09-18 for the rollback below, which restores bytes:
a prior body is journaled as base64 precisely so a UTF-8 BOM survives, and pushing that back through
a text writer would re-encode it.

### A rollback re-derives the index; it never restores one

**No journal may carry `notebook/_master-index.md` or `shelf/_catalog.md`, and `Write-BookJournal`
refuses one.** Four helpers used to list one — the compiler, and the Shelf's rename, archive and
remove — and until 2026-09-18 a failed run wrote that snapshot back with a truncating call, outside
the render lock.

Two things were wrong with it, and the second is the worse one.

- **It was a torn read waiting to happen.** The one write that occurs after something has already
  gone wrong was the one write a concurrent reader could catch half-finished.
- **The bytes were stale by construction.** A derived index is rendered from state the operation
  does not own, so the snapshot is a snapshot of *every other* topic and Book too. Seat B compiles a
  topic while seat A's compile fails; seat A's rollback restores an index that predates seat B's
  work and **loses seat B's topic**. That is the lost-topic race this whole design removed,
  reintroduced through the rollback door. It needs two seats and a failed run to bite, which is
  exactly why nothing noticed.

So the rule is the same one that governs the happy path: **journal the authority, re-derive the
view.**

| Helper | What its journal holds | What its rollback re-derives |
| --- | --- | --- |
| `Compile-RawBatchToNotebook.ps1` | the article and the topic's own `_index.md` | the master index, after any half-promoted topic directory is removed |
| `Rename-ShelfBook.ps1` | the Book's `_catalog-entry.md`, its `_book.md` and `_index.md`, and every Desk that named it | the catalog |
| `Archive-ShelfBook.ps1` (both directions) | nothing — the Book's authority rides inside the directory that moves | the catalog |
| `Remove-ShelfBook.ps1` | nothing — the same reason; the Book moves into staging as one tree | the catalog |

`Write-BookJournal` therefore accepts an **empty** `-Paths`. An operation whose only durable change
is a directory move has no file bytes to record, and a mandatory parameter that rejected an empty
array is what pushed two of these helpers into journaling the catalog in the first place. The
journal is still written: it is the operation's dated record, and it is the thing the rollback is
shaped around.

The re-render goes through `Invoke-NotebookRenderAfterRollback` or
`Invoke-ShelfCatalogRenderAfterRollback`, which take the render lock exactly as the happy path does
and **report their own failure separately**. If the Notebook or the Shelf cannot be rendered — most
often because something unrelated on disk is degenerate — the files that rollback restored are
nonetheless back, and one flat `Rollback: FAILED` would hide that. The message says what landed and
names the single command that finishes the job.

And the restore itself is now an atomic replacement like every other write here, which matters
beyond the derived files: a topic `_index.md` is restored while a renderer may be reading it,
because an ordinary compile takes no render lock.

### A topic that cannot be rendered stops the render, and says so

Every directory under `notebook/` must hold an `_index.md` carrying **exactly one column-zero H1**,
because that heading is the label the index shows. Missing, malformed, no heading, or two headings:
the scan throws **before** anything is written, so the reader keeps the last index that was true
rather than being handed an empty one.

The cost is deliberate and worth stating plainly: **one unrenderable topic blocks every Notebook
write that changes which topics exist, anywhere in the Notebook.** Rendering only the renderable
topics would silently drop a topic the reader has on disk, which is the lost-topic failure this whole
change removes. So the refusal names the directory and the repair, and every writer refuses at its
own topic first, with a message about that topic rather than about the Notebook.

A fenced code block is not a heading. That was learned the expensive way: the first implementation
anchored on start-of-file-or-newline and counted a column-zero `#` wherever it appeared, so one
topic index containing a Markdown example would have hidden every other topic from the reader.

### The Shelf entry file

Each Book's catalog block is authoritative in `shelf/<slug>/_catalog-entry.md`. A writer touches its
own Book's file and nothing else, so two publishes cannot collide at all — there is no shared file
for them to interleave in.

- **The entry and the rendered catalog commit in one critical section.** A writer that committed its
  entry and crashed before rendering would leave the authority and the published view disagreeing,
  so the renderer performs the entry write itself: callers pass `-WriteEntry` or `-RemoveEntry`, not
  a procedure. That also keeps the write somewhere the gate can see it.
- **An entry is validated against the slug of the directory it was found in.** A copied Book
  directory would otherwise carry a Path line naming the Book it was copied from, and the catalog
  would list one Book twice under two titles.
- **It lives outside `wiki/`.** Page manifests, Discovery and every reader-map regeneration
  enumerate `shelf/<slug>/wiki`, so an entry file there would become a page of the Book.
- **It is inside the closed-Book boundary**, unlike the rendered catalog. That is correct: the entry
  is the Book's own authored material, and `shelf/_catalog.md` is the published view that stays
  readable while every Book is closed.
- **`shelf/_archive/` is skipped**, so an archived Book is out of the active catalog by construction.
  Its entry travels into the archive with its directory, and a restore writes it back from the
  archive record. Search still covers archived Books and labels them — see
  [ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md).

### One transient state a concurrent render can meet, and it is accepted

`Publish-BookCopy.ps1` and `Import-ExternalWikiToShelf.ps1` both put the Book's directory on the
Shelf and *then* take the render lock to write its entry. Between those two moments the Shelf holds a
Book directory with no `_catalog-entry.md`, so a render started by another process in that window
**fails**, naming that Book as unlistable.

Accepted deliberately. Nothing is corrupted, the failure is loud rather than silent, the operation
that caused it completes moments later, and a retry succeeds. The alternative — skipping a Book
directory that has no entry — is the failure this whole change removes, one collection over: a Book
would drop out of its own catalog and every check would pass. Closing the window properly means
holding the shelf render lock across the whole create, which is a page copy of arbitrary size; worth
doing if a real collision is ever observed, and not worth it before.

The Shelf's own directories are a different matter and are skipped by construction: `_archive`, and
any dot-prefixed staging directory. That second one was a guaranteed failure rather than a race —
the importer stages inside `shelf/` as `.migration-<slug>-<digest>`, so the first version's
"refuse any name that is not a slug" rule would have refused every render during an import.

### The header is tracked

`docs/templates/shelf-catalog-header.md` is the authority. Not `shelf/`, which is gitignored, and not
a string constant inside the renderer: [ADR-0014](adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md)
says a mechanism delivers a document and never holds a rule of its own, and this header is
reader-facing prose about what a capture Book is. A header carrying a column-zero `##` is refused
rather than published, because it would render as a Book the Shelf does not have.

## Which writers participate

All four Notebook writers, and all five Shelf catalog writers. Migrating only the first of each was
caught as a defect twice during review.

| Helper | What it does now |
| --- | --- |
| `Compile-RawBatchToNotebook.ps1` | New topic: stages whole, promotes in the lock. Existing topic: atomic file replacements, render lock only if the H1 changed or the index drifted. Refuses a topic directory with no `_index.md`. |
| `Invoke-LibraryTriage.ps1` (Notebook route) | Creates a topic complete with a generated `_index.md`, promoted in the lock. It used to create the directory and write no index at all. |
| `Restore-BookSource.ps1` | Create-only, so always the new-topic case. Generates an `_index.md` when the publication carried none, validates it before promotion, and now **does** write the master index — the reader is no longer asked to add a line by hand. |
| `Reset-LocalNotebook.ps1` | Removal, scaffold and render in one critical section. Its own copy of the index text is gone, which is what removed the file's UTF-8 BOM. |
| `Publish-BookCopy.ps1` | Writes its Book's entry file inside the render lock, instead of appending to the catalog unlocked. |
| `Import-ExternalWikiToShelf.ps1` | The same. |
| `Archive-ShelfBook.ps1` | Archive: the entry travels with the directory, then a render. Restore: the entry is written back from the archive record inside the lock. |
| `Remove-ShelfBook.ps1` | The entry goes into deletion staging with the rest of the Book, then a render. No offset arithmetic. |
| `Rename-ShelfBook.ps1` | Rewrites its own entry file's heading and Path line inside the lock. Still confined to this Book's section, and now to this Book's file. |

`Publish-BookCopy.ps1` deliberately takes **no** Book lock. The obvious reading of "hold Book then
shelf render" would put one around its create, and it cannot: `shelf.writers-route-manifests`
requires that a helper locking a Shelf Book also open a manifest mutation window, and this helper has
no manifest handling to open one from. The catalog race is closed by the render lock regardless.

## The BOM

`notebook/_master-index.md` carried a UTF-8 BOM until 2026-09-07, because the reset scaffold wrote it
with `Set-Content -Encoding UTF8` — which adds one in Windows PowerShell 5.1 — while every other
Library writer uses `UTF8Encoding($false)`. A rendered file has to have exactly one byte sequence for
a readback to mean anything, so the renderer writes no BOM and the first regeneration dropped it
once. `notebook/` is gitignored, so that was not a tracked diff. A BOM on the master index is now
reported as drift in its own right.

## The gate

| Check | What it holds |
| --- | --- |
| `notebook.master-index-renders` | The file on disk matches the topics and headings on disk, with no BOM. |
| `shelf.catalog-renders-from-entries` | The file on disk matches the tracked header plus the validated entry files. |
| `derived-indexes.written-atomically` | No production helper writes a derived index with a truncating call, **and none passes one to `Write-BookJournal -Paths`**. It follows the **path variable**, not the filename on the write line: production code writes `Write-Utf8 $catalogPath (...)`, which names no filename at all, while a fixture inlines the literal. The first version had that backwards and fired on five fixture writes while missing every real one. The journal half reads the call from the **AST**, because the compiler's spans a backtick continuation, and it taints on the two **rendered** names only — `_catalog-entry.md` is a Book's own authority and journaling it is correct. |
| `derived-indexes.rollback-re-renders` | Every helper that renders a derived index **and** restores a journal re-derives that index inside the catch that restores. The subject set is derived from the source rather than listed, the check fails rather than passes when it is empty, and it requires at least one journal-only rollback to stay outside the set — a rule that came to cover every rollback would be firing on correct code. |
| `notebook-index.selftest`, `shelf-catalog.selftest` | The renderers' own rules, offline. |
| `notebook.render-lock-narrow` | The critical section, with real processes. The slowest check in the gate, and it earns it. |

Neither state check repairs what it finds. A check that fixed the drift would report a healthy
Library on every run while the writer that caused it stayed broken. The repair is explicit:
`tools/NotebookIndex.ps1 -Render -WorkspacePath .` or `tools/ShelfCatalog.ps1 -Render -WorkspacePath .`.

## Day one

A Shelf that predates this has a catalog and no entry files, and `Get-ShelfCatalogText` refuses
rather than rendering a Shelf it cannot reproduce. `tools/ShelfCatalog.ps1 -Migrate -WorkspacePath .`
splits the live catalog into entry files and renders; `-Preflight` shows what it would write. It is
idempotent, it never invents an entry for a Book the catalog does not list, and it **refuses** rather
than overwrites when an entry file already exists and differs — the file on disk is the authority the
moment it exists.

This workspace was migrated on 2026-09-07: one Book (`Holding Shelf`), one entry file, and the
rendered catalog came back byte-identical to the authored one apart from a trailing blank line.

Test fixtures go through the same path. `Initialize-ShelfCatalogForFixture` copies the tracked header
from the repository — never a retyped copy, which would keep passing while the tracked one was broken
— and then runs the real migration.
