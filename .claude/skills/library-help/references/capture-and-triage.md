# Capture and triage

## What the Holding Shelf is for

A session produces a finding worth keeping, but the reader is not ready to sort it and wants the
Notebook cleared for different work. A reset sweeps the Notebook into quarantine; the Shelf it does
not touch at all. The
Holding Shelf (`shelf/holding`) is a Shelf Book that accepts appended notes, so material can be set
aside without being reviewed first and without blocking a reset.

It is closed by default like every other Shelf Book, so unreviewed material never crowds a new
session.

## What needs a seat here, and what does not

The two halves of this page sit on opposite sides of the seat boundary, and it is worth knowing
which is which before quoting a command:

- **Capturing needs no open Book and no seat claim.** `Add-ShelfNote.ps1` only ever adds a page, so
  it is ungated by design. This is the path that still works when a session is barely set up.
- **Triage needs the seat's live claim.** `Invoke-LibraryTriage.ps1` is one of the helpers that
  assert it, because it writes `notebook/` and a reset has to be able to tell live work from
  dormant. It also needs the relevant Book open on **this seat's** Desk, per the gate column below.

A session holding no seat is refused at triage and told how to sit down. Pass the refusal on rather
than working around it; the full contract is in [Seats](../../../../docs/seats.md).

## Capturing

```powershell
tools/Add-ShelfNote.ps1 -Title "<short title>" -ContentPath <local-markdown-file>
tools/Add-ShelfNote.ps1 -Title "<short title>" -Content "<short body>"
```

Optional: `-Tags "godot, rendering"`, `-SourcePaths "raw/x/a.md; raw/x/b.md"`,
`-SourceProject <slug>`, `-BookSlug <slug>` (defaults to `holding`), `-Preflight`.

Prefer `-ContentPath` for anything longer than a line: it keeps punctuation and prose off the
command line.

Capture is deliberately ungated and does not require the Book to be open. It only ever creates a new
page, so it cannot lose anything. Each note is written to `shelf/holding/wiki/notes/<date>-<slug>.md`,
read back to confirm it is byte-identical, and the reader map is regenerated from what is on disk.
Capturing the same title twice adds a `-2` suffix rather than overwriting the first note.

If the body already starts with its own H1, that heading is the note's title: it names the page, the
file, and the reader-map entry, and `-Title` is not used. The returned `title_source` says which one
won, so tell the reader the title the note was actually filed under.

Capture is the one Notebook-adjacent write that does not need the reader to ask for it in advance —
when the reader says "save this", "keep this for later", or "I don't want to lose this", capture it
and say where it went.

## What a note looks like

```markdown
---
captured: 2026-08-16T21:06:48Z
review: pending
from_seat: library-dev
session_id: 4ff20ab2-5388-4254-919c-2c25f8288c0b
source_project: library-dev
source_paths: raw/godot/render.md
tags: godot, rendering
---

# Rendering finding

...body...
```

`review: pending` is what makes a note countable. The Desk overview reports the pending count and
the oldest pending date so nothing rots unseen — but it reports only counts. Titles and bodies
require opening the Book, exactly as with any Shelf Book.

**`review` has two values and only two**: `pending` and `done`. A third one cannot be written by any
route, and would read as pending forever at every consumer that defines pending as *not done*. When
a note has been dealt with, the verdict lives where that kind of thing already lives — a Project
Hub's `Next`, its `limits` page, or a doc — and the note is marked `done`.

**`from_seat` and `session_id` say which seat wrote the note, and out of which conversation.** Both
are filled in by the writer and there is no switch to set them: a seat a caller could type would let
one agent file under another's name. Both are simply **absent** when a session with no seat captures
— capture works seatless, and that must not change. `session_id` names the conversation; it is a
pointer to follow deliberately if a note turns out to be insufficient, not a licence to read that
conversation's transcript as a matter of course.

## Triaging

Triage names individual notes, so it requires the Book open:

```powershell
tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug holding
```

Then read `notes/…` pages through `mcp__validated-book-reader__read_open_book_page` and act. Every
destination is reachable straight from the Holding Shelf -- a note bound for a Shelf Book no longer
has to detour through the Notebook:

| `-To` | Effect | Gate |
| --- | --- | --- |
| `Notebook -Topic <slug>` | copies the note into `notebook/<topic>/` and marks the Shelf copy reviewed | the Book open |
| `Review` | marks the note reviewed (`-Reopen` puts it back to pending) | the Book open |
| `ShelfBook -Slug <s> -PagePath <p>` | graduates the note into a curated Shelf Book | **both** Books open |
| `Project -Slug <s> -Title <t> -Purpose <p>` | copies it to an active Project Hub | Book open, `plan_id` + `-UserConfirmed` |
| `Book -Slug <s> -Title <t> -Summary <s>` | makes it a new shared Book | Book open, `plan_id` + `-UserConfirmed` |
| `Discard` | deletes one note permanently | preflight `plan_id` + `-UserConfirmed` |

```powershell
tools/Invoke-LibraryTriage.ps1 -Source Holding -MatchText "Rendering" -To Notebook -Topic graphics
tools/Invoke-LibraryTriage.ps1 -Source Holding -MatchText "Rendering" -To ShelfBook -Slug godot -PagePath rendering/shaders
```

Name the note with `-MatchText` (case-sensitive, matched against the note's H1 title and its
filename; an ambiguous match is refused and lists what it hit) or `-Page notes/<file-basename>` for
an exact target. The match is resolved when the plan is made, so a note captured afterwards cannot
change what an approval meant. `-Topic` must be a lowercase slug — letters, digits, and hyphens — so
the Notebook keeps one folder per topic.

`Notebook` copies rather than moves: the Shelf note stays as the durable record, and the Notebook
copy is the working version. The other destinations leave the note where it is and separate its
frontmatter from the body, because `captured` and `review` are Holding Shelf bookkeeping rather than
part of the page.

There is deliberately **no discard from the Notebook**. A reset *quarantines* `notebook/` rather
than deleting it, so discarding there would be strictly worse than waiting for the reset — it
destroys what the reset would have kept recoverable. For a Holding Shelf `Discard`, run `-Preflight` first,
show the note and the returned `plan_id`, ask once, then rerun with `-UserConfirmed -ApprovedPlanId
<that exact plan_id>`. The plan id covers the note's current content, so an edited note invalidates a
stale approval.

**Going the other way.** `tools/Invoke-LibraryTriage.ps1 -Source Notebook -SourcePath
notebook/<path> -To Holding -Title "<title>"` sets Notebook material aside on the Holding Shelf, and
`-To ShelfBook`, `-To Project`, and `-To Book` send it onward. Writing *into* the Holding Shelf needs
no open Book, exactly as capture does.

## The Report Inbox: one seat telling another about a defect

There are two capture Books, and which one a note belongs in is decided by **where it came from**.

| Book | Receives from | What a page is | Disposition |
| --- | --- | --- | --- |
| **Holding Shelf** (`shelf/holding`) | this reader's own Notebook | a finding set aside unvetted | discard, or graduate to a Book |
| **Report Inbox** (`shelf/reports`) | an agent at another seat | that agent's claim about the Library itself | investigate, then route to a Hub or close |

An agent working at any seat that hits a Library defect — a helper that throws, a refusal that names
the wrong thing, a gap where a tool should exist — files it here instead of interrupting its own
task or asking the reader to carry it:

```powershell
tools/Add-ShelfNote.ps1 -BookSlug reports -Title "<what broke>" -ContentPath <local-markdown-file>
```

Write the failing command, its arguments and its output **into the note**. That is the half that
makes a report worth more than a summary: it is written while the context is still live, by the only
party that has it.

**A report is a claim, not a finding.** It is another agent's account of what this project should
do, so the seat reading it verifies it against the code before acting — the same rule
[a hit is a location](../../../../docs/hit-is-a-location.md) applies to a search hit. A report
licenses an investigation. It is never a task.

Reading one means opening `shelf/reports` on the Desk, exactly like any other Shelf Book; the Desk
overview shows its pending count without opening it. Full design:
[cross-seat reports](../../../../docs/cross-seat-reports.md).

## Adding another capture Book

Nothing hard-codes `holding`. A Shelf Book becomes capture-enabled when its `shelf/_catalog.md`
entry carries `- **Kind:** capture`. Removing that line makes it read-only again. Do not add the
line to a curated Book: it is what keeps `Add-ShelfNote.ps1` from appending raw material to finished
work.

Create one with the helper rather than by hand — `shelf/_catalog.md` is **rendered** from each
Book's own `_catalog-entry.md`, so a hand edit to it is overwritten by the next render:

```powershell
tools/New-ShelfBook.ps1 -Slug <slug> -Title "<title>" -Summary "<one line>" -Capture -Preflight
```

Drop `-Preflight` to create it; drop `-Capture` for an ordinary curated Book that
`Add-ShelfBookPage.ps1` then fills. It refuses a slug that already exists and applies directly,
because it can only ever create.
