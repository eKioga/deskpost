# Capture and triage

## What the Holding Shelf is for

A session produces a finding worth keeping, but the reader is not ready to sort it and wants the
Notebook cleared for different work. A reset sets the seat's Notebook aside and does not touch the
Shelf at all. The Holding Shelf (`shelf/holding`) is a Shelf Book that accepts appended notes, so
material can be set aside without being reviewed first and without blocking a reset.

It is closed by default like every other Shelf Book, so unreviewed material never crowds a new
session.

## What needs a seat here, and what does not

The two halves of this page sit on opposite sides of the seat boundary:

- **Capturing needs no open Book and no seat.** `library capture` only ever adds a page, so it is
  ungated by design. This is the path that still works when a session is barely set up.
- **Reading and triaging need the Book open on this seat's Desk**, and triage needs the seat's
  claim. A session holding no seat is refused and told how to sit down. Pass the refusal on rather
  than working around it.

When a reader asks why a Holding Shelf read was refused after being told saving needs no open Book,
this is the answer: **saving is ungated, and reading is not** (ADR-0048).

## Capturing

```
library capture holding --title "<short title>" --content-path <local-markdown-file>
library capture holding --title "<short title>" --body "<short body>"
```

Optional: `--tags "godot, rendering"`, `--source-paths "raw/x/a.md; raw/x/b.md"`,
`--source-project <slug>`, `--preflight`. Prefer `--content-path` for anything longer than a line:
it keeps punctuation and prose off the command line.

Each note is written to `shelf/holding/wiki/notes/<date>-<slug>.md`, read back to confirm it is
byte-identical, and the reader map is regenerated from what is on disk. **The date is the local
calendar date**, as this machine's clock reads it, so an evening note is named for today, not for
tomorrow's UTC date. Capturing the same title twice adds a `-2` suffix rather than overwriting.

If the body already starts with its own H1, that heading is the note's title: it names the page, the
file and the reader-map entry, and `--title` is not used. The returned `title_source` says which one
won, so tell the reader the title the note was actually filed under.

Capture is the one write that does not need the reader to ask for it in advance. When the reader
says "save this", "keep this for later" or "I don't want to lose this", capture it and say where it
went.

## What a note looks like

```markdown
---
captured: 2026-09-26T06:03:32Z
review: pending
from_seat: me
session_id: 4ff20ab2-5388-4254-919c-2c25f8288c0b
source_project: my-project
source_paths: raw/godot/render.md
tags: godot, rendering
---

# Rendering finding

...body...
```

`captured:` is the exact UTC instant, for ordering. The file name's date is the local one.

`review: pending` is what makes a note countable. `library desk` reports the pending count and the
oldest pending date so nothing rots unseen, but it reports only counts. Titles and bodies require
opening the Book, exactly as with any Shelf Book.

**`review` has two values and only two**: `pending` and `done`. When a note has been dealt with, the
verdict lives where that kind of thing already lives (a Project Hub's `Next`, or a Book) and the
note is marked `done`.

**`from_seat` and `session_id` say which seat wrote the note, and out of which conversation.** The
writer fills both in, and there is no switch to set them, because a seat a caller could type would
let one agent file under another's name. Both are simply **absent** when a session with no seat
captures. `session_id` is a pointer to follow deliberately, not a licence to read that conversation.

## Triaging

Triage names individual notes, so it requires the Book open:

```
library desk open book holding --location shelf
```

Then read `notes/…` pages through `read_open_book_page` and act. A triage action is JSON, validated
first and then run as a batch on one approval:

```
library triage validate --actions '[{"kind":"notebook","source":"holding","source_match":"Rendering","topic":"graphics"}]'
library triage batch --actions '<json>' --preflight
library triage batch --actions '<json>' --user-confirmed --plan-id <id>
```

| `kind` (from `source: holding`) | Effect | Gate |
| --- | --- | --- |
| `notebook` | copies the note into this seat's Notebook and marks the Shelf copy reviewed | the Book open |
| `review` | marks the note reviewed | the Book open |
| `shelf-book` | graduates the note into a curated Shelf Book | **both** Books open |
| `discard` | deletes one note permanently | the preview's plan id and the reader's yes |
| `project`, `book` | a Project Hub, a new shared Book | **not ported**: refused by name |

Name the note with `source_match` (case-sensitive, matched against the note's H1 title and its
filename; an ambiguous match is refused and lists what it hit) or `source_page` for an exact target.
The match is resolved when the plan is made, so a note captured afterwards cannot change what an
approval meant. A batch that is interrupted resumes when the same actions are run again.

`notebook` copies rather than moves: the Shelf note stays as the durable record, and the Notebook
copy is the working version. The other destinations leave the note where it is.

There is deliberately **no discard from the Notebook**. A reset quarantines the Notebook rather than
deleting it, so discarding there would be strictly worse than waiting for the reset. For a Holding
Shelf `discard`, preview first, show the note and the plan id, ask once, then run. The plan id covers
the note's current content, so an edited note invalidates a stale approval.

**Going the other way.** From `source: notebook`, `kind: holding` sets Notebook material aside on the
Holding Shelf, and `kind: shelf-book` sends it to a Shelf Book. Writing *into* the Holding Shelf
needs no open Book, exactly as capture does.

## The Report Inbox: one seat telling another about a defect

There are two capture Books, and which one a note belongs in is decided by **what it is**.

| Book | What a page is | Disposition |
| --- | --- | --- |
| **Holding Shelf** (`shelf/holding`) | a finding set aside unvetted | graduate it, or discard it |
| **Report Inbox** (`shelf/reports`) | an agent's claim about the Library itself | investigate, then route to a Hub or close |

An agent at any seat that hits a Library defect files it here instead of interrupting its own task
or asking the reader to carry it. Examples are a refusal that names the wrong thing, a check that
fails wrongly, or a gap where a verb should exist.

```
library capture reports --title "<what broke>" --content-path <local-markdown-file>
```

Write the failing command, its arguments and its output **into the note**. That is the half that
makes a report worth more than a summary: it is written while the context is still live, by the only
party that has it.

**A report is a claim, not a finding.** It is another agent's account of what the Library should do,
so whoever reads it verifies it against the code before acting. It licenses an investigation, and
it is never a task. Reading one means opening `reports` on the Desk, like any other Shelf Book.
Full design: [cross-seat reports](../../../../docs/cross-seat-reports.md).

## Adding another capture Book

Nothing hard-codes `holding`. A Shelf Book is capture-enabled when its catalog entry says it is
(`- **Kind:** capture`). Create one with the command rather than by hand, because `shelf/_catalog.md`
is **rendered** from each Book's own entry, and a hand edit is overwritten by the next render:

```
library shelf new <slug> --title "<title>" --summary "<one line>" --capture
```

Drop `--capture` for an ordinary curated Book, which `library book add-page` then fills. It refuses
a slug that already exists, and applies directly, because it can only ever create.
