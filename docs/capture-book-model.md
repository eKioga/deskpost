# Capture Books and the Library Help Skill

> **Status:** implemented and acceptance-tested, 2026-08-16.

## The defect

The Library had a durable local tier — the Shelf — and a volatile one — the Notebook. It had no way
to move a single finding from the second to the first. `Publish-BookCopy.ps1` refuses an existing
destination (*"Local Shelf Book already exists"*), and so does `Import-ExternalWikiToShelf.ps1`. Both
create Books; neither appends to one.

The reader-facing consequence: a session produces something worth keeping, the reader is not ready to
sort it, and the next task wants a clean Notebook. The only honest options were to publish a new
one-note Book per finding, or lose the note. Both are wrong, so in practice the reset just got
delayed.

Separately, every question about how the Library works was answered by reconstructing the workflow
from `CLAUDE.md` and `docs/`. Those are design records and operating rules, not reader-facing
instructions, and reconstruction drifts.

## Decision

Two changes, neither of which adds a storage tier.

**Capture Books.** A capture Book is an ordinary Shelf Book whose `shelf/_catalog.md` entry carries
`- **Kind:** capture`. Nothing else distinguishes it: it opens, closes, reads, and is guarded exactly
as any Shelf Book. `shelf/holding` — the Holding Shelf — is the first one (created as `shelf/inbox` and renamed
2026-08-17; see below). The catalog is the only
authority for capture-enablement, so no slug is special-cased in code and a reader can add or retire
a capture Book by editing one line.

A parallel `notebook-shelf/` tree was considered and rejected. It would have twinned the guard hook,
the validated reader, the catalog, the Desk state format, and every document naming `shelf/`, to
obtain a property the Shelf already has: local, reset-immune, closed until opened.

**Help as a Skill, not a Book.** Reader-facing help lives in `.claude/skills/library-help/`. A Skill
keeps its name and one-line description in context permanently at negligible cost and loads its body
only when a meta question arrives. A closed help Book would have cost the same context — nothing
auto-loads a Book either — while making help harder to reach exactly when a confused reader needs
it. Depth sits in `references/`, loaded per topic rather than whole.

## Reader benefit

**Capture stops being a decision.** "Save this for later" is one ungated command that needs no open
Book and cannot lose anything, because it only ever creates a page. The reader can then reset freely.

**Set-aside material stops rotting.** `Get-DeskOverview.ps1` reports each capture Book's pending
count and oldest pending date, so a Holding Shelf ignored for weeks says so at the desk
instead of waiting to be remembered.

**Help is answered, not reconstructed.** A meta question loads written instructions that are updated
alongside the feature they describe.

## Safety boundary

**Capture writes; it does not read.** `Add-ShelfNote.ps1` deliberately works on a closed Book — that
is the whole point, since setting material aside must not disturb the current session — while every
route that *reads* a note still requires the Book open. Writing into a closed Book cannot leak
anything; the asymmetry is the design, not a gap.

**Curated Books are protected from raw material.** The `Kind: capture` requirement is what stops
`Add-ShelfNote.ps1` appending session scratch to `odysseus` or `2nd-b`. An unlisted slug and a
non-capture Book are both refused by name.

**The Desk overview reports counts, not content.** It reads note frontmatter to count `review:
pending` and never returns titles or bodies. Reading a note means opening the Book, exactly as with
any Shelf page. This keeps "closed means unreadable" true while still making a forgotten Holding Shelf
visible.

**Triage is gated in proportion to what it can destroy.** `ToNotebook` copies (the Shelf note stays,
so a later reset cannot take it) and `Review` rewrites one frontmatter field; both apply directly
because neither can lose text. `Discard` deletes and therefore needs a preflight `plan_id` and one
clear approval. That `plan_id` hashes the note's current content, so editing a note invalidates a
stale approval.

**The guard needed no changes.** `Guard-ShelfBookRead.ps1` denied `Read` against the closed
`shelf/inbox` on the first attempt, because a capture Book is a Shelf Book. The measured limits
recorded in [Shelf and Catalog Symmetry](shelf-desk-symmetry.md) apply unchanged and are not
improved by this work: broad searches and shell commands remain advisory, not blocked.

## Acceptance evidence

### Guard and gate suite, disposable sandbox

Run 2026-08-16 against a fixture workspace, not the reader's Shelf. Refused, each by name: capture
into a non-capture Book, capture into an unlisted slug, capture with an empty body, triage while the
Book is closed, an ambiguous `-MatchText` (listing both hits), a duplicate `ToNotebook` destination,
`Discard` without `-UserConfirmed`, and `Discard` with a wrong `plan_id`. Succeeded: capture, a
second capture of the same title (suffixed rather than overwritten), `Review`, a repeated `Review`
reporting `unchanged`, `ToNotebook`, and `Discard` with the exact `plan_id`. The reader map matched
the notes on disk after every operation.

### Three ordinary reader requests, live Library

1. **"Save this finding for later."** `Add-ShelfNote.ps1` captured one note with the Book closed and
   no confirmation, read it back byte-identical, and reported `pending_count: 1`.
2. **"What is on my desk?"** `Get-DeskOverview.ps1` reported `inbox` as `is_open: False`,
   `pending_count: 1`, with the oldest pending timestamp — and no note title or body.
3. **"Open the inbox and show me what is waiting."** A `Read` against the closed note was denied by
   the existing guard. After `Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug inbox`, both the
   reader map and the note itself were served through
   `mcp__validated-book-reader__read_open_book_page`.

The acceptance note was then discarded through the gated path on the live Book — preflight, exact
`plan_id`, `-UserConfirmed` — and the Book closed, leaving the Inbox empty and ready.

### Defect found and fixed during acceptance

The first live capture failed: `Add-ShelfNote.ps1` joined `-ContentPath` to the workspace
unconditionally, so an absolute path became `D:\Library\C:\Users\...` and `GetFullPath` rejected it.
A note body is usually a scratch file outside the workspace, so a rooted path is now taken as given
and only a relative one is resolved against the workspace.

### Adversarial verification, 2026-08-16

A second pass re-ran the boundary cases and probed the parts acceptance had taken on trust. Every
refusal above held. The Desk overview was checked directly for leakage — canary title, body, tags,
`source_paths`, and `source_project` in a closed capture Book, with the whole output serialized —
and returned none of them.

Two defects were found and fixed, both from PowerShell's `-notmatch` being case-insensitive or from
two sources of truth for a note's title:

- `Move-ShelfNote.ps1` (absorbed into `Invoke-LibraryTriage.ps1` on 2026-08-28) validated `-Topic`
  with `-notmatch`, so `-Topic Graphics` passed a
  lowercase-only rule and created `notebook/Graphics/`. On Windows that silently merges with an
  existing `notebook/graphics/` while reporting the casing the reader typed; on a case-sensitive
  filesystem it would split one topic in two. Now `-cnotmatch`. `Get-CaptureBook`'s slug check had
  the same flaw: `-BookSlug Inbox` was refused as an unlisted Book rather than as a bad slug.
- `Add-ShelfNote.ps1` kept a body's own leading H1 as the page title but still derived the filename
  from `-Title` and reported `-Title` as `note_title`. The note was then filed under a title that
  appeared nowhere on its page, and `-MatchText` on that title could never find it. The body's H1 now
  supplies the slug and the reported title, a new `title_source` field says which won, and `-Title`
  still stands in when the heading has no letter or digit.

`tools/Test-ShelfNoteBoundary.ps1` keeps all of it: 28 cases over a disposable fixture workspace,
including one regression case per defect above and the Desk-overview leak canaries.

### Renamed to the Holding Shelf, 2026-08-17

`shelf/inbox` became `shelf/holding`, and *Notes Inbox* became *Holding Shelf* — the term
`CONTEXT.md` had already settled on, because an inbox receives from outside and this receives from
the reader's own Notebook. The evidence above is left under the names it was recorded with: it
describes what happened on 2026-08-16.

The move went through `tools/Rename-ShelfBook.ps1` rather than by hand — a preflight naming every
live reference, one approval bound to the catalog and to every page hash, the per-Book lock, a
pre-write journal, and a rollback verified by readback. The single pending note was verified
byte-identical after.

Two defects surfaced in `BookWriteGuard.ps1` while building it, which the rename is the first caller
of:

- `Restore-BookJournal` recorded prior state as *text*, so a file carrying a UTF-8 BOM came back
  without one and then failed the very hash check meant to prove the restore. Journals now record
  bytes (schema 2), and a BOM case is in the self-test.
- Its write branch had no answer for a read-only file while its delete branch already passed
  `-Force`. A rollback that gives up over a file attribute leaves a Book half-migrated, which is
  strictly worse than restoring it.

`tools/Invoke-LibraryChecks.ps1` gained `shelf.references-resolve`: a stale Shelf path in the
`library-help` Skill or the root guides, a catalog entry with no Book on disk, or a capture helper
defaulting to a Book the catalog does not list, now fails the commit. A rename touch list is
remembered once and rots afterwards; the invariant underneath it does not.

## Key Takeaways

- A capture Book is an ordinary Shelf Book marked `- **Kind:** capture` in the Shelf catalog; the
  catalog is the only authority, and nothing hard-codes `holding`.
- Capture is ungated and works on a closed Book because it can only add a page. Reading and triaging
  notes requires the Book open, like any Shelf page.
- The Desk overview surfaces pending counts and the oldest pending date so set-aside material does
  not rot, without exposing note content.
- `ToNotebook` and `Review` apply directly; `Discard` needs a preflight `plan_id` and one approval.
- Reader-facing help is the `library-help` Skill, updated whenever the Library's reader experience
  changes. `docs/` remains the record of why, not the instructions for how.
- `tools/Test-ShelfNoteBoundary.ps1` is the regression suite for all of this. Run it after any change
  to `Add-ShelfNote.ps1`, `Invoke-LibraryTriage.ps1`, or `ShelfNoteCommon.ps1`.
