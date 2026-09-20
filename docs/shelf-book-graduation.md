# Graduating a page into a Shelf Book

> **Status:** implemented and tested, 2026-08-17. Decision:
> [ADR-0001](adr/0001-shelf-books-accept-pages-when-open.md).

## The defect

Every Shelf Book was create-once. `Publish-BookCopy.ps1` and `Import-ExternalWikiToShelf.ps1` both
refuse an existing destination, and only a Book marked `Kind: capture` could be appended to. So
*"graduate this to the Godot Book"* had no implementation at all. The moves actually available were
to publish a thirteenth Book, or to leave the material on the Holding Shelf — which is how the Shelf
reached twelve Books with four documented, unresolved overlaps.

## Reader benefit

A finished Notebook article can join the Book it belongs to. Graduation stops being a euphemism for
"file it somewhere else and hope", and the Shelf stops growing a Book per finding.

## Safety boundary

**Additive, and provably so.** `Add-ShelfBookPage.ps1` only ever creates a page that does not
exist. The file is created with `CreateNew`, so a collision fails rather than overwrites even if the
lock were somehow bypassed, and the page already there is left byte-identical.

**The Desk replaces the confirmation.** Because the write cannot lose text, it applies directly with
no `plan_id` — the same treatment `ToNotebook` and `Review` already get. What makes it deliberate is
that the Book must be open, which is the Library's existing idiom: capture is ungated because it is
unvetted material going somewhere disposable, while naming an individual page is curatorial and has
always required an open Book.

**Capture Books are refused by name.** The two paths stay distinct: capture is ungated into
disposable Books through `Add-ShelfNote.ps1`, graduation is deliberate into open curated ones. Raw
session material still cannot reach a curated Book by accident, and a curated page cannot be filed
into the Holding Shelf's note structure by mistake.

**A curated reader map is appended to, never regenerated.** Both publishers generate the identical
map shape — one H1, then one link per page — so a map still in that shape is regenerated from disk
and can never drift from what the Book holds.

The plan said simply "reader map regenerated from disk", and that turned out not to survive contact
with the reader's own Shelf: `shelf/library-dev`'s map carries `##` sections and a paragraph of
annotation under each link, so regenerating it would have destroyed real curatorial work. The first
implementation refused that case, which was safe and made the feature useless on the Book most likely
to want it.

So a curated map has the new link **appended** — still provably additive, not a character of the
existing map touched — and what regeneration would have guaranteed is *reported* instead: every
result carries `reader_map_unlisted`, the count of pages on disk that no link reaches. Regeneration
prevents drift; appending cannot, so the drift is surfaced rather than silently accepted. Between
"cannot lose text" and "cannot drift", the first is the stronger promise and it wins.

That count follows links **one hop** through any topic index the root map names. A flat count would
have been actively misleading: `library-dev`'s root map links two topic indexes and nothing else, so
a flat check reported 27 of its 31 pages as unlisted — reporting a deliberate hierarchy as drift. It
reports 0 now, which is the true answer.

The appended link lands at the end, which may not be the section it belongs in. The preflight says
so, and a link in the wrong place is recoverable in a way a flattened map is not.

**Everything under the Book's lock, journaled first.** The new page's prior **absence** is recorded,
so a failure deletes it rather than leaving a page the reader never asked for; the reader map's prior
body is recorded so it can be put back. A folder created only for the failed page is removed too, and
only while empty, so a concurrent writer's page is never taken with it.

## The two concurrency defects this closed

Both were in `Add-ShelfNote.ps1`, and a second writer for the same Book is what made them reachable.

- **Filename selection was a check-then-write race.** Two sessions capturing at the same moment
  settled on the same `<date>-<slug>.md` and the second overwrote the first. Selection now happens
  again while holding the Book's lock, and the file is created with `CreateNew` so a collision fails
  rather than overwrites.
- **The reader map was rewritten with nobody excluded.** It is regenerated from a directory listing,
  so an unlocked rewrite works from a listing that may already be stale — dropping another session's
  note from the map while its file stays on disk. The map is now regenerated inside the same lock.

Triage's in-place kinds take that same lock, because `review`, `notebook`,
and `Discard` all rewrite the map too. **The lock is the Book's, not any one helper's**, so a fix
applied to only one writer would not be a fix.

`Add-ShelfNote.ps1` also gained the journal, which it did not have: a readback mismatch used to throw
with the note already on disk and the map not yet updated. It now rolls back to no note at all.

## Acceptance evidence

**Sandbox**, `tools/Test-LibraryHelpers.ps1` and `tools/Test-ShelfNoteBoundary.ps1`, against
disposable fixture workspaces. Refused, each by name: a closed Book, a capture Book, an uppercase
path segment, a traversing path, `_index` as a page name, both a body and a body path, an empty body,
a body with no H1 and no `-Title`, a second page at the same path, and a second writer while another
holds the Book's lock. Verified after a successful add: the page keeps its own H1, and a generated
map carries the Book title and lists both the new page and the `_book` link. Against a curated map:
the section heading and the per-link annotation both survive, the new link is appended, and a page on
disk that no link names is reported through `reader_map_unlisted`.

**Fault injection.** With the reader map made unwritable, the write fails *after* the page file
exists — this writer's distinctive rollback shape, since there is no earlier body to restore and the
proof is that the created page is gone again. Asserted: the page is absent, the map is byte-identical
to before, an unrelated page survives, a folder created only for the failed page is removed, and a
folder holding another page is not. The same injection against `Add-ShelfNote.ps1` leaves the note
count and the map unchanged.

**Live Library.** Preflight only, against the open `library-dev` Shelf Book, plus a live refusal
against the closed `odysseus`. That preflight is what found the curated-map problem above: it
reported the real map as not regenerable, which was the correct reading of a map the earlier
sandbox fixtures had no equivalent of. The executing write is deliberately left for a real
graduation — it is additive, and there is no bounded helper that removes a Shelf page again.

## What came next

Graduating a whole topic in one call needed more than repeating this write per article: see
[Graduating a whole topic into a Shelf Book](topic-graduation.md), which adds a bound manifest, a
progress journal, and resume — and composes with `Add-ShelfBookPage.ps1` rather than replacing it.

## Key Takeaways

- `tools/Add-ShelfBookPage.ps1` adds one page to a Shelf Book that is **open on the Desk**. Additive
  only, applies directly, no `plan_id`.
- Capture Books are refused: `Add-ShelfNote.ps1` is for those, and the two paths stay distinct.
- The reader map is regenerated from disk only when it still has the generated shape. A curated map
  is appended to instead, and `reader_map_unlisted` reports the drift regeneration would have
  prevented.
- The per-Book lock covers every writer for that Book — capture, triage, graduation, and rename.
- Run `tools/Test-LibraryHelpers.ps1` and `tools/Test-ShelfNoteBoundary.ps1` after any change to
  `Add-ShelfBookPage.ps1`, `Add-ShelfNote.ps1`, `Invoke-LibraryTriage.ps1`, or `ShelfNoteCommon.ps1`.
