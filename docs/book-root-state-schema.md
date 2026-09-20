# The Book-root state schema, and Books openable from the archive

**2026-08-19. Plan item 3.2.** `tools/BookRootSchema.ps1` (internal, dot-sourced). Gate checks:
`desk.book-root-schema` and `desk.book-root-selftest`.

This item is a **migration, not a feature**. The feature it delivers is one line long — an archived
shared Book can be opened on the Desk and read — and the work is that the shape of a Desk line was
written out independently in eight places, so adding a third location meant finding every one of
them and hoping.

## What the schema is

One line in `.claude/seats/<seat>/.open-books` names a Book's collection root. It was
`.claude/.open-books` until 2026-09-07, when the Desk became per-seat (ADR-0015); the line's SHAPE
is unchanged, and only where the file lives moved:

| root | Book | pages |
| --- | --- | --- |
| `books/<slug>` | active shared | `books/<slug>/wiki/<page>`, over MCP |
| `archive/<slug>` | **archived shared** | `archive/<slug>/wiki/<page>`, over MCP |
| `shelf/<slug>` | local Shelf | `shelf/<slug>/wiki/<page>`, on disk |

A bare `<slug>` is the pre-symmetry format and still means an active shared Book.

**The archive root is `archive/<slug>`, not `archive/books/<slug>`, because that is where the pages
are.** `Archive-SharedBook.ps1` has moved a Book to `archive/<slug>/wiki/` since the pilot; PLAN.md's
own sketch of this item guessed `archive/books/<slug>`, which was checked against the code rather
than believed. A Desk root that did not match the storage path would need a translation step, and a
translation step is the second authority this file exists to remove.

Note the asymmetry with Projects, which really are at `archive/projects/<slug>`. Books were archived
first and Projects later, and the two conventions were never reconciled. Recording the asymmetry is
cheaper and safer than migrating live shared material to tidy it — and it is why **`projects` is a
reserved slug for an archived Book**: `archive/projects` would read as two different things.

**The Shelf has no archive.** `-Location Shelf -Shelf Archive` is refused rather than quietly
ignored — which is what the pre-3.2 helper did with `-Shelf` for *every* Book, so
`-Kind Book -Shelf Archive` opened the active Book and said nothing.

## Who moved

Eight independent copies of the shape, all migrated together:

| file | what it had |
| --- | --- |
| `tools/Set-VirtualDesk.ps1` | its own `ConvertTo-BookRoot`, and composed the root inline |
| `tools/Get-DeskOverview.ps1` | its own `ConvertTo-BookRoot`, and split the root with `-split '/', 2` |
| `tools/SearchBoundaries.ps1` | read `.open-books` without normalising it |
| `tools/BookFullText.ps1` | two regexes and a `Substring(6)` |
| `tools/BookDiscovery.ps1` | composed `books/<slug>` and `shelf/<slug>` to test openness |
| `.claude/adapters/Validated-BookReader.ps1` | its own `ConvertTo-BookRoot`, its own slug match, its own page path |
| `.claude/hooks/Guard-BasicMemoryRead.ps1` | its own pattern, and reduced every shared root to a bare slug |
| `.claude/hooks/Guard-ShelfBookRead.ps1` | its own pattern and its own `^shelf/(...)` extractor |
| `.claude/hooks/Get-VirtualDeskContext.ps1` | its own pattern and its own labels |

**PLAN.md's consumer list was incomplete, and was verified against the code before being planned
against.** It named the reader, `Guard-BasicMemoryRead.ps1`, `Get-VirtualDeskContext.ps1` and
`Get-DeskOverview.ps1`. It did not know about `Guard-ShelfBookRead.ps1`, and it predates Phase 2, so
it did not know that Discovery and full text read Desk state too — through
`Get-SearchOpenBookRoots`, which since 2.3 is the one parser of `.open-books` for every search tier.

**The hooks now depend on `tools/`, and that is deliberate.** Every path out of a guard hook's catch
block denies, so a schema that cannot be loaded fails the guard closed rather than opening it. The
adapter's import is **hard**, unlike its guarded imports of Discovery and full text: losing a tool
costs one tool, but the Book-root shape decides whether any Book may be read at all, and an adapter
that fell back to a private copy would reinstate exactly what this item removed.

## The guard is the sharp edge

Before 3.2 `Guard-BasicMemoryRead.ps1` reduced every open shared Book to a bare slug and allowed
`books/<slug>`. A bare slug cannot say which half of the shared collection it came from, so once
`archive/<slug>` exists, that reduction would have meant **opening the archived Book also opened its
active twin**. The guard now keeps the root and allows exactly it.

`archive` is deliberately **not** allowed wholesale the way `books` is. Listing `books` discloses the
active catalog's shape, which the Book Catalog already publishes; listing `archive` would disclose
which Books were retired, and no reader-facing catalog says that yet.

## What is enforced, and what is only a rule

`desk.book-root-schema` scans every `.ps1` under `tools/` and `.claude/` and fails if any file except
the schema itself carries a Book-root **validation pattern**, with block comments stripped first. It
also fails the reader adapter for composing a Book page path from a slug at all.

It does **not** catch every site that builds a root by string interpolation. It catches the sites
whose *job* is turning a Book identity into a page path to fetch, which as of 2026-09-08 is three
files: the reader adapter, `SharedBookSource.ps1`, and `Update-SharedBookManifests.ps1`. Those three
are named in the check.

**That list was one file long until the shared archive arrived, and the exemption was the defect.**
This section used to record `SharedBookSource.ps1` as *legitimately* composing `books/<slug>/wiki`
"for the active-collection manifest builder" — true while the shared collection had one half, and
false the moment `archive/<slug>` became a Book root that helper could be asked about. It would have
read the ACTIVE twin and committed a complete, well-formed manifest under the archived Book's name.
Both files now take a Book root and ask `Split-BookRoot` for `wiki_root`.

The pattern also had to widen: it matched a bare `books/$name` only, so `books/$($entry.slug)/wiki`
— which is how a real composition is actually spelled — would have gone straight past. Every
other interpolated root remains a rule rather than a check, covered behaviourally by suites that
drive the real producer and the real consumers. Stating the boundary is the point: a check that
documentation could satisfy is worse than no check.

## What the suite does, and what the mutation sweep found

`desk.book-root-selftest` has two halves, and the second is the point: it drives
`Set-VirtualDesk.ps1`, `Get-DeskOverview.ps1`, `Guard-BasicMemoryRead.ps1` and the reader adapter as
**separate processes** against a fixture workspace. A unit test of the schema would pass with half
the codebase still carrying its own copy.

The adapter has no non-serving mode — dot-sourcing it falls straight into `while (ReadLine)` and
hangs, which is how the first version of this suite found out — so it is driven over JSON-RPC with a
request file redirected onto stdin.

**A suite that died mid-way reported success.** A missing dot-source made an unrecognised command
abort the fixture block; every assertion after it was skipped and the runner still printed
`55 checks passed` and exited 0. Both this suite and 3.1's now record an escaping exception as a
failure of its own.

The mutation sweep found three canaries missing and one hole in the new static check:

- **The accept pattern was never asserted.** `ConvertTo-BookRoot` validates against the *canonical*
  pattern, so loosening the *accept* pattern was caught by a second gate — except in
  `Guard-ShelfBookRead.ps1`, which validates against it and never calls `ConvertTo-BookRoot`. Both
  patterns are now asserted directly, in both directions.
- **No Shelf Book was ever open in the guard fixture**, so removing the guard's shared-collection
  filter changed nothing the suite looked at.
- **The adapter's page composition could not be reached offline**, because doing so needs a live
  archived Book. Caught statically instead, and named above as the limit it is.
- **The static check's own anchor was too narrow**: it required the prefix and the character class
  to be adjacent, and `Guard-ShelfBookRead.ps1`'s `'^shelf/([a-z0-9]...'` — one bracket different —
  slipped straight past a check that was reporting clean. The sweep found the check, not the copy.

## Honest limits

- **No archived Book has ever existed.** `archive/README.md` on the shared collection says the pilot
  archived nothing, and there is no `## Archived Books` section. So the whole archive path is
  **fixture-tested and statically checked, never run against a real archived Book**. Reading one
  end to end is unproven. The same class of gap as 3.1's `archived` liveness value and the meter's
  `secondary` window — and it will close the first time a Book is genuinely archived.
- **There is no way to list archived Books.** *(Closed 2026-09-03.)* `read_book_catalog` gained
  `location: archive`, which serves `archive/README.md` under the same return validation as the
  active catalog. That was a real gap and it was not this item's: opening was the ask.
- **Discovery and full text do not cover archived Books.** *(Closed 2026-09-06,
  [ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md).)* Manifests were
  generated per collection for `shelf` and `books` only, so an archived Book had none and never
  appeared in Discovery. The store is now keyed on `(collection, shelf)` and archiving MOVES a Book''s
  manifest rather than retiring it. The *shared* archive followed on 2026-09-08, through
  `Update-SharedBookManifests.ps1 -IncludeArchive`; until its roster exists, every Discovery answer
  says the shared archive is not covered and names that flag.
- **`tools/BookManifestTransaction.ps1` still maps a collection to a `books/` or `shelf/` prefix.**
  *(Closed 2026-09-06.)* It did, and the way it did was worse than a duplicate rule: it compared with
  `StartsWith`, and `shelf/_archive/<slug>` starts with `shelf/`. An archived Book would have passed
  as collection `shelf` and written its manifest into its ACTIVE twin''s store. The root is now taken
  apart by the schema and its own manifest collection compared for equality.

## The fourth root: an archived Shelf Book (2026-08-26)

**Reader benefit.** A Shelf Book that was archived stayed on disk and became unreachable: not
openable on the Desk, not readable through the validated reader, and not in any search tier. The only
way to look at anything inside it was `-Action Restore`, which un-retires the whole Book to answer one
question. It now opens on the Desk as `shelf/_archive/<slug>`, is read through the validated reader
like any other open Book, and labels itself `<slug> (shelf, archived)` so it is never mistaken for the
active Book of the same name.

**Safety boundary it must not cross.** An archived Shelf Book is **read-only**. Every Shelf writer
refuses it by name — `Assert-ShelfBookOpen` reports "archived and read-only" and points at
`-Action Restore` — because archiving retires a Book and a write that silently un-retired one would
make the archive a place material rots rather than rests. Opening it must not widen anything else:
opening `shelf/_archive/<slug>` must never unlock `shelf/<slug>`, the whole archive must not become
listable, and a closed archived Book stays as unreadable as any closed Book. All four are asserted.

**The guard now keys on roots, not slugs.** `Get-OpenShelfRoots` returns `shelf/demo` and
`shelf/_archive/demo` as the different Books they are. Reducing both to `demo` — which is what it did
until 2026-08-26 — would have let opening the archived Book unlock its active twin, the same defect
3.2 fixed for the shared archive, one collection over.

**What a fixture could not see.** Three consumers each re-derived `shelf/<slug>/wiki` instead of
asking for `wiki_root`: `Set-VirtualDesk.ps1`, the reader adapter's `Read-ShelfBookPage`, and the
Shelf read guard. All three passed their own suites, because the fixture also held an *active* Book
of the same name — the composed path pointed at a real directory, so the check passed for the wrong
reason. The first live open of the one archived Book on disk failed on the first of them. The fixture
now gives the archived twin its own pages on disk, and the adapter assertion reads content only the
archived copy contains.

The adapter's comment had said the Shelf branch "could not currently be wrong" because the Shelf had
no archive. That premise expired the day `Archive-ShelfBook.ps1` shipped, and the exemption it
justified became the bug. The invariant was right; the exception to it was not.

**Closed on 2026-09-06 by [ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md).**
Discovery covers the Shelf archive and labels every hit; full text does the same for an archived Book
open on the Desk. The store gained two collections — `shelf-archive` and `shared-archive` — as flat
siblings of `shelf` and `shared`, because both prune sweeps enumerate a collection''s store root and
would have walked a nested `_archive` directory as an orphaned Book. `BookRootSchema.ps1` owns the
map, in both directions, and `desk.book-root-schema` fails on a list of those names written anywhere
else. The shared archive''s manifests, which need MCP reads and belonged to the shared backfill,
landed there on 2026-09-08 - so all four collections in the schema now have a generator, and
`desk.book-root-schema` additionally fails any of the three page-fetching files for composing a page
path from a slug.
