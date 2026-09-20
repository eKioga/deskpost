# Archived Books are covered by search and labelled

Search covers archived Books, and every answer says which hits are archived. Archiving a Shelf Book
no longer retires its Discovery manifest: the manifest **moves** from the `shelf` store to a
`shelf-archive` store, and a restore moves it back. Every Discovery hit carries `book_root`,
`collection` and `book_shelf`, and the rendered answer marks an archived Book `ARCHIVED`.

Full text follows the same rule for the one archived Book it can reach — one open on the Desk.

## Status

accepted — 2026-09-06.

Extends ADR-0002, which settled that Discovery spans **closed** Books because it reads only
catalog-class metadata. This settles the other axis: **retired** Books. Nothing about what may
cross the boundary changes; only which Books are asked.

## The defect this closes, which was worse than a gap

Archiving removed a Book from search — `Archive-ShelfBook.ps1` called `Remove-BookManifestStore` as
the last step of the archive, and its own preflight said so: *"retire this Book's Discovery manifest
store, so no closed-Book search answers for it."*

That alone would be a defensible design. What made it a defect is the second half. Discovery counts
coverage against the **roster it walked**, and archiving took the Book out of the roster and out of
the store at the same moment. So the count moved in lockstep with the omission and the answer went on
reading complete:

    19 result(s) from 19 of 19 Book(s) -- Shelf 1/1, shared 18/18. Shared collection: all 18 searched.

Nineteen of nineteen, with an archived Book on disk holding 118 pages and thirteen more in the shared
archive. This is the exact failure every coverage sentence in `BookDiscovery.ps1` and
`BookFullText.ps1` was written to prevent — *a partial answer that does not admit it is partial* —
reached down the one path none of those sentences could see, because the Book had been removed from
the question rather than skipped inside it.

The Desk half had already closed on 2026-08-26: an archived Shelf Book opens read-only at
`shelf/_archive/<slug>`. So the Library was in the state where a reader could open an archived Book
but could not be told it existed — the archive had become a place material was forgotten rather than
rested.

## Why covered-and-labelled, and not covered-on-request

The alternative was a flag: keep archived material out of ordinary answers, let a reader ask for it.
It was rejected on one argument. **A reader who cannot find a thing cannot know to ask for it.** An
opt-in flag helps exactly the reader who already suspects the archive holds what they want, which is
the reader who least needed the help; it fails the reader who does not know the Book ever existed,
which is what archiving something a year ago produces. Discovery's whole job is *which Book should I
open* — the tier that exists to answer that question is the wrong place to hide a Book.

The cost of covering is that retired material can read as current. That cost is paid by the **label**
rather than by exclusion, and the label is carried on the hit itself rather than added by a renderer,
so a caller that formats its own answer still has it:

    Godot Engine Reference [shelf/_archive/godot-engine-reference, curated, closed, ARCHIVED]

The root, not just the slug, because `shelf/x` and `shelf/_archive/x` are two different Books that
share a name and a reader needs to know which command opens the one they were shown.

Archiving keeps every other meaning it had. The Book is out of `shelf/_catalog.md`, so no Shelf
writer will touch it and it is absent from the Shelf a reader browses; it is read-only; and the
route back is still `-Action Restore`.

## What "the manifest moves" required

The store was keyed on `(collection, slug)`, where `collection` was `shelf` or `shared`. That is no
longer sufficient, because **an archived Book is still `shelf` or still `shared`** — the Desk's
`Split-BookRoot` had modelled this correctly all along, returning `collection` and `shelf` as
separate fields, and the store had collapsed them.

So the store key becomes `(collection, shelf)` flattened into one name, and `BookRootSchema.ps1` owns
the map in both directions:

    shelf            shelf/<slug>
    shared           books/<slug>
    shelf-archive    shelf/_archive/<slug>
    shared-archive   archive/<slug>

**Flat siblings, not `shared/_archive/<slug>`.** Both prune sweeps enumerate the directories under a
collection's store root and treat each as a slug whose Book should still exist; a nested `_archive`
directory would be walked as an orphaned Book. Flat names keep every existing sweep correct without
it having to know the archives exist.

Three things fell out of that key change, and each was a live defect rather than a refactor:

- **`Assert-BookCollectionMatchesRoot` compared with `StartsWith`**, and
  `'shelf/_archive/godot'.StartsWith('shelf/')` is true — so an archived Book passed as collection
  `shelf` and would have written its manifest into its **active twin's** store. That is the precise
  collision the collection key was introduced to prevent, arriving one shelf over. It now takes the
  root apart and compares the collection for equality, which no prefix satisfies by accident.
- **`Complete-BookRenameMutation` called `Remove-BookManifestStore` without `-Collection`**, which
  defaults to `shelf`. Harmless while renames were the only caller and always Shelf-to-Shelf;
  wrong the moment a mutation moves between collections.
- **`BookFullText.ps1` re-derived `"shelf/$slug"`** in the second Desk read, so an open archived Book
  would have been declared closed-during-query and had every line dropped — silently, which is what
  that second read exists to prevent. Invisible while nothing archived could be searched at all.

## Where an archived Book's metadata comes from

An archived Book is **absent from `shelf/_catalog.md` by design** — removing that entry is what
archiving is — so it cannot be resolved by slug. Its metadata lives in `_archived.json`, whose
`catalog_entry` field holds the reader's own entry verbatim, which is why that field was stored.

`Get-ArchivedShelfBook` reads it and hands the entry to `ConvertFrom-ShelfCatalogEntry` — the same
function `Get-ShelfBook` now uses, split out for this. A second copy of the entry grammar would have
been this codebase's most-repeated defect, and its only symptom would have been an archived Book
whose topics or capture flag disagreed with its active self.

`Get-ShelfBook`'s refusal message was also a small harm of its own. Full text reported an open
archived Book as *"No Shelf Book 'godot-engine-reference' is listed in shelf/\_catalog.md"* with the
repair *"check shelf/\_catalog.md lists this Book"* — advice that cannot work, and which, if
followed, would leave the catalog claiming a Book that is not at `shelf/<slug>`.

## The Shelf archive needs no roster file; the shared archive does

The active Shelf has `shelf/_catalog.md` and the shared collection has a generated roster, because
neither can be enumerated where the answer is needed — one is the reader's curated list, the other
is behind MCP. The Shelf archive is neither: a local directory, always readable offline, where each
Book's own `_archived.json` is what makes it archived rather than a stray folder. Deriving the roster
beats storing one that could go stale against the directory it describes.

## What is deliberately not done yet

**The shared collection's archive is not covered.** Generating those manifests means reading archived
Books over MCP, which is the shared backfill's job and is its own piece of work. Until then Discovery
says so in every answer, in the words it can stand behind:

    the shared collection's archive is NOT covered by this answer -- archived shared Books have no
    Discovery manifests yet

It names the state and **not a remedy that does not exist**. An earlier draft pointed at
`Update-SharedBookManifests.ps1 -IncludeArchive`, a flag no helper accepts — the same dead-end repair
instruction found in the currency roll-up the day before this landed. A hint is only honest if it can
be followed, which is why `Update-BookManifests.ps1` gained a real `-IncludeArchive` in this change
rather than being promised one.

**Closed 2026-09-08, and the draft's flag now exists.** `Update-SharedBookManifests.ps1` gained a
real `-IncludeArchive`; the thirteen archived shared Books have manifests in the `shared-archive`
store this ADR created, and `internal/book-manifests/shared-archive/_roster.json` is what turns the
sentence above off. **Nothing in search changed**, which is what the seams were for — Discovery
already looped over `Get-BookManifestCollections`, already read a `shared-archive` roster, and
already refused a collection it had no roster for. Both shared-archive hints now name that flag.

Three things the shared half needed that the Shelf half did not:

- **The archive index is the roster's source, and it is behind MCP.** `archive/README.md` is parsed
  by the same entry grammar as `books/README` — one parser with a root prefix, not a copy — and
  what follows the link is a summary in one and an archived *date* in the other, so the trailer is
  returned as its own field and the call site decides. An archived Book therefore carries **no
  summary**: archiving removed the entry that held one.
- **An unreadable archive index is fatal to the flag.** Compare the Shelf archive, which needs no
  roster file because its absence really is evidence. A roster written from a failed MCP read would
  make Discovery say *"the shared archive holds no Books"* — a complete-sounding answer about
  material it never asked about.
- **The journal is keyed on the Book root.** `books/x` and `archive/x` are two Books that share a
  name, so a slug key wrote one entry for both and the second commit overwrote the first's digest.

## How this is held

`archive.search-coverage` (`tools/Test-ArchiveSearchCoverage.ps1`), six cases over a disposable
fixture, driving the real archiver and the real Discovery as processes. It is a suite rather than a
static scan because every component was individually correct: only archiving a Book and then asking
Discovery a question shows the Book gone. Its load-bearing cases are the **coverage count**, which
the original defect fails, and an **active and archived Book of the same slug**, which is where a
fixture is most likely to pass for the wrong reason.

`desk.book-root-schema` additionally fails on any list of the manifest-collection names written
outside `BookRootSchema.ps1`. Discovery builds its own loop from `Get-BookManifestCollections` and
**refuses** a collection it has no roster for, so a fifth collection reaches search by being added to
the schema instead of being known to the store and invisible in the answer.

## Record

`docs/book-root-state-schema.md` and `docs/shelf-book-retirement.md`.
