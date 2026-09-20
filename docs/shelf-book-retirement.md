# Retiring Shelf Material, and Finding What Was Retired

> **Status:** built 2026-08-20. Closes the two Shelf-writer gaps recorded in the Library Development
> Hub's `Now` section on 2026-08-20, and the listing half of the archive gap recorded 2026-08-19.

> **Compatibility note (2026-08-20):** the active Shelf lifecycle now has two exits: verified
> publish-and-delete, or approved delete without publishing. `Archive-ShelfBook.ps1` remains for
> Books already using `shelf/_archive/`, but new lifecycle work does not route through it. Shared
> Books retain their separate shared-collection archive.

## Why this exists

[Duplicate Topic Resolution](duplicate-topic-resolution.md) has specified the canonical + stub
pattern since 2026-08-15, and the consolidation pass that day applied it across seven topics. It was
applied **by hand**. Nothing in `tools/` could reproduce it, and nothing could retire a whole Shelf
Book either — `Archive-SharedBook.ps1` and `Archive-ProjectHub.ps1` both reach the NAS and neither
touches the Shelf.

The cost of that was concrete rather than theoretical. On 2026-08-20 `shelf/godot-engine-reference`
(90 wiki pages by the reviewing session's count, 118 files by the archive helper's) was verified by
direct page-content comparison to be a word-for-word duplicate of the shared **Godot Engine
Architecture Reference** Book. The finding was good, and there was no safe way
to act on it: every available move meant editing pages and the Book Catalog outside
`BookWriteGuard.ps1`'s lock and journal. The reader correctly chose to leave the Book in place.

Three things landed together, because retiring a duplicate Book usually means stubbing its pages
first and then needing to find it again afterwards.

## 1. `tools/Set-ShelfBookPageStub.ps1` — turning a page into a stub

Replaces one page of an **open, curated** Shelf Book with a superseded-stub in the shape
[Duplicate Topic Resolution](duplicate-topic-resolution.md) specifies: the page's own H1, then a
blockquote naming the date, the canonical Book, the canonical page, an optional one-line reason, and
a relative link back to that document.

**Why not an overwrite mode on `Add-ShelfBookPage.ps1`.** The Hub recorded the revisit trigger as
"a page-overwrite mode for `Add-ShelfBookPage.ps1`, gated the same way." The goal was right and the
mechanism was not. That helper's entire justification for applying with no `plan_id` is that it
provably cannot lose text — `CreateNew` semantics, "a collision fails rather than overwrites". A
mode that overwrites makes that justification conditional on a flag, and
`.claude/rules/library-development.md` states the rule directly: *a write whose damage has to be
filtered is not additive*. Separately, a generic overwrite is a larger capability than any recorded
need — arbitrary bytes over arbitrary bytes. This helper can only ever write a stub, and the reader
sees the entire replacement text in the preflight before approving it. Less power, same outcome.

**The link depth is computed, not assumed.** A stub at `wiki/<topic>/<page>.md` needs
`../../../../docs/…` and one at `wiki/<page>.md` needs `../../../docs/…`. Every surviving
hand-written stub sits at one level of nesting, so a constant would have been right by coincidence
and silently wrong for the first top-level page. Mutating the computation to that constant is one of
the suite's two mutation-tested cases.

**Idempotent by content**, like the topic writer. A page already holding exactly these bytes is
reported `already-stubbed` with no write, no journal, and no manifest generation — decided *before*
a `plan_id` is issued, because a retry that needs no write should not ask for an approval it does not
need. A page holding a *different* stub is an ordinary change and is gated like any other.

**Gated, because it destroys text.** Preflight, exact `plan_id`, one approval. The `plan_id` binds
the page's current content hash, so a page edited between preflight and approval invalidates it
rather than being overwritten against a stale reading — and the body is re-read under the lock and
compared again, because the approval was bound to a hash taken before anyone was excluded.

**What it refuses:** a capture Book; `_book` and `_index` at any depth (that refusal comes from
`ConvertTo-BookPagePath`, which owns the rule for every Shelf writer — an earlier draft restated it
here and the restatement was dead code); and a page that does not exist, because creating one is
`Add-ShelfBookPage.ps1`'s job.

## 2. `tools/Archive-ShelfBook.ps1` — retiring a whole Shelf Book

Three actions. `Archive` moves `shelf/<slug>` to `shelf/_archive/<slug>`, removes its Book Catalog
entry, and MOVES its Discovery manifest into the archive store. `Restore` reverses all three. `List` is read-only and
ungated.

**Where an archived Shelf Book goes, and why not `archive/<slug>`.** `BookRootSchema.ps1` already
owns `archive/<slug>` and it means an archived **shared** Book; reusing it would put two different
Books at one root. `shelf/_archive/<slug>` cannot collide with any Book, because a Shelf slug is
`^[a-z0-9]+(-[a-z0-9]+)*$` and no Book can ever be called `_archive`. Staying under `shelf/` also
means the existing Shelf read guard covers the archive for free.
**The asymmetry with the shared archive is closed, as of 2026-08-26.** Phase 3.2 made an archived
*shared* Book openable on the Desk. An archived *Shelf* Book now opens too, on the fourth Book root
`shelf/_archive/<slug>` — see [Book-root state schema](book-root-state-schema.md). What it is **not**
is writable: every Shelf writer refuses it by name and points at `-Action Restore`, because archiving
retires a Book and a write that silently un-retired one would make the archive a place material rots
rather than rests. `-Action List` and `-Action Restore` remain, and Restore is still the only way back
to an active, writable Book.

**The search half closed on 2026-09-06**, under
[ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md). This helper no longer
retires a Book's Discovery manifest; it **moves** it, from the `shelf` store to `shelf-archive`, and
`Restore` moves it back. Discovery covers the Shelf archive and labels every hit `ARCHIVED`, and full
text does the same for an archived Book open on the Desk. What is still open is the *shared* archive:
generating those manifests means reading archived Books over MCP, which is the shared backfill's job.
Every Discovery answer says so rather than counting them as absent.

**Three consumers had each re-derived the page path, and a fixture could not see it.** Closing this
found the same defect in `Set-VirtualDesk.ps1`, the validated reader adapter, and
`Guard-ShelfBookRead.ps1`: all three composed `shelf/<slug>/wiki` instead of asking the schema for
`wiki_root`. Every one passed its own self-test, because the fixture also held an *active* Book of the
same name — so the composed path pointed at a directory that really existed and the check passed for
the wrong reason. The first live open of the one archived Book on disk failed immediately. The fixture
now gives the archived twin its own pages, which is what makes those assertions mean anything.

**Restore is part of the feature, not a follow-up.** An archive with no way back re-creates by hand
exactly the hand-editing this helper removes. The removed catalog entry is stored **verbatim** in
`shelf/_archive/<slug>/_archived.json`, so a restore puts back the summary line, `Kind` marker and
annotations the reader wrote rather than a regenerated approximation.

**The rollback shape is a third one.** `Add-ShelfBookPage.ps1` rolls back a prior *absence*;
`Set-ShelfBookPageStub.ps1` rolls back a prior *body*; this one has to unwind a **moved directory**,
which no journal of file bytes can express. The move is therefore reversed by hand in the catch
block and the journal covers only the Book Catalog. Mutating that reversal away is the archive
suite's mutation-tested case.

**How the mutation window closes, and why the static rule does not see it.**
`shelf.writers-route-manifests` requires every helper that opens a window to close it with
`Complete-BookMutation` or `Complete-BookRenameMutation`. The `Restore` path does. The `Archive` path
**cannot** — there is no Book left at `shelf/<slug>` to generate a manifest from — so it closes the
window by removing the store outright, which takes the dirty marker with it. The static rule passes
for this file because of the `Restore` path, which means it passes for the wrong reason where
`Archive` is concerned. Two behavioural cases in `tools/Test-ShelfWriterRouting.ps1` are what
actually cover it, and the census comment says so.

**What it refuses:** a capture Book, because the Holding Shelf is the standing capture surface and
its notes are triaged rather than archived wholesale; and a Book that is **open on the Desk**, so
archiving is never something that happens to material in play.

**Source references are reported in two lists, and never rewritten.** `blocking_references` are
mentions on the narrow set of surfaces `shelf.references-resolve` actually reads —
`.claude/skills/**/*.md`, `CLAUDE.md`, `CONTEXT.md` — and those do fail the gate.
`other_references` are mentions anywhere else under `docs/`, `internal/`, or `output/`, which the
gate never reads. Deciding what a document recording a dated event should now say is the reader's
call. The first version of this reported one undifferentiated list and asserted all of it would fail
the gate; see *First live use* below for why that was wrong and what it cost.

## 3. The shared archive became listable

Until 2026-08-20 `archive/README.md` was exposed by **no reader tool**. Phase 3.2 gave the Desk an
`archive/<slug>` Book root, so an archived shared Book could be *opened* — but only by a reader who
already knew its slug, and Discovery does not cover archived Books either. There was no way to find
one.

`read_book_catalog` now accepts `location: archive`. It reuses the shared catalog reader rather than
repeating it, so the archive listing gets exactly the same return validation: the record's own
`file_path` must be the one that was asked for, or the content is withheld. Extending the existing
tool rather than adding a new one also means no new permission-allowlist entry — a new MCP tool would
have needed one.

The answer names **both** archives, because they are separate and a reader asking what is archived
should not have to already know that: the shared archive opens with `Set-VirtualDesk -Location
Archive`, and the local Shelf archive is listed with `tools/Archive-ShelfBook.ps1 -Action List`.

**Verified live**, not only against fixtures: the real `read_book_catalog` call over the real MCP
channel returned `archive/README.md`, which reads *"The initial pilot has no archived content."* —
confirming the Hub's 2026-08-19 statement rather than assuming it.

## First live use, 2026-08-20, and the two defects it found

Both helpers were exercised on `shelf/godot-engine-reference` the same day they landed, by the
session that had recorded the gap. Two pages verified word-for-word were stubbed, then the whole
118-page Book was archived. Every page verified byte-identical at the archive path, the Book Catalog
entry was stored verbatim, the Discovery manifest was retired, and the full gate came back green with
no manual cleanup. The stub writer's idempotence, its `_index` refusal, and its computed link depth
all behaved as documented on first use.

Two defects surfaced that no fixture had caught, both now fixed.

**The archive preflight predicted a gate failure that could not happen.** It reported every file
under `docs/`, `internal/`, `output/`, and `.claude/` naming the Book, and said flatly that they
"will name a Book the catalog no longer lists, which fails `shelf.references-resolve`."
`shelf.references-resolve` reads a far narrower set: `.claude/skills/**/*.md`, `CLAUDE.md`, and
`CONTEXT.md`. The real archive had **zero** mentions on those surfaces and eight elsewhere, so the
gate passed clean while the preflight had promised failure — sending the reader to look for edits
nobody needed. The wide scan was worth keeping and the claim was not, so the report is now two lists:
`blocking_references`, which really do fail the gate, and `other_references`, which the gate never
reads. A dated record naming this Book stays true; editing it would be falsifying a record rather
than fixing a link. The `next` line is now conditional on which list is non-empty. Regression cases
in `tools/Test-LibraryHelpers.ps1` cover both directions, plus a `shelf/demo-v2` lookalike that must
not count as a mention of `shelf/demo`.

**The stub writer's `plan_id` was the only truncated one in the family.** It hashed to 16 hex
characters where `Rename-ShelfBook`, `Invoke-LibraryTriage`, `Archive-ShelfBook` and `TriagePlanCommon`
all bind an approval to the full 64. Harmless — 64 bits is not a collision risk — but it made one
member of a deliberately uniform family look different at the exact moment a reader is comparing an
approval token by eye. Now full-length. The 16-character truncations elsewhere in `tools/` are
journal *file names*, a different job.

Neither defect was reachable from a fixture: the first needed a real workspace with real history
mentioning the Book, and the second needed someone using both helpers in one sitting.

**One interaction worth knowing, not a defect.** Stubbing a page and then archiving its Book leaves
the stub's relative link to `docs/duplicate-topic-resolution.md` one level short, because the page
moved a directory deeper. It is not corrected on archive, deliberately: the archive's core guarantee
is that every page is byte-identical at the new path, and rewriting links would break exactly that.
An archived Book is in no reading surface anyway, so the link is inert until a restore puts it back
where it resolves again.

## What is still open

- **The shared collection's archive is not covered by search.** *(Closed 2026-09-08.)* The Shelf
  archive closed 2026-09-06 (ADR-0012) and the Desk half on 2026-08-26; this was the last of the
  2026-08-19 gap. `Update-SharedBookManifests.ps1 -IncludeArchive` now generates the archived shared
  Books' manifests over MCP, under the same preflight and approval its active half has always
  needed, and Discovery covers them because the seams were already there — `Get-DiscoverySharedRoster`
  accepted the `shared-archive` store, so the work was generating manifests, not teaching search.
  The remaining honest limit is narrower and is recorded in ADR-0012: an archived shared Book
  carries **no summary**, because the archive index writes a date where the active catalog wrote a
  description.
- **An archived Shelf Book's manifest has one live regeneration route and no second signal.**
  `Update-BookManifests.ps1 -IncludeArchive` prunes an archive store whose Book is absent from
  `Get-ArchivedShelfBookSlugs`, on that one signal — which is sound, because that roster already
  requires both the directory and its `_archived.json`, so a Book absent from it has no archive
  record at all. The active sweep insists on two signals because its roster is a *file* that can
  disagree with the disk; the archive's roster **is** the disk.
## Evidence

- `tools/Test-LibraryHelpers.ps1` — 373 checks, including the stub writer's refusals, its
  preflight/approval binding, its idempotence, its prior-body rollback, and the archive helper's
  full archive → list → restore → fault-injected-rollback cycle.
- `tools/Test-ShelfWriterRouting.ps1` — 25 cases, including the four new behavioural ones.
- `.claude/adapters/Validated-BookReader.ps1 -SelfTest` — the shared half now asserts the exact
  `archive/README.md` record path and that the listing names both archives.
- Mutation-tested: the stub writer's `plan_id` content binding and its computed link depth, and the
  archive helper's directory rollback. Each mutation was applied, confirmed to fail the suite, and
  reverted.
