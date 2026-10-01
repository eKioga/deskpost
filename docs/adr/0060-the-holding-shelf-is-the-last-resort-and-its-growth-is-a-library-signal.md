# ADR-0060: The Holding Shelf is the last resort, and its growth is a Library signal

**Status:** accepted (the guidance half); the kernel half is `PLAN-holding-discipline.md`
**Date:** 2026-09-29
**Effective from:** the next release after 1.2.3 (guidance); the kernel half when it ships
**Relates to:** [Capture Books](../capture-book-model.md) (revised here),
[ADR-0017](0017-the-always-on-margin-is-accepted-disciplines-do-not-move.md) (the trigger stays always-on),
[ADR-0024](0024-removal-from-the-notebook-has-no-destination.md),
[ADR-0048](0048-a-note-is-named-by-the-local-date-and-saving-is-not-reading.md)

## Context

The Holding Shelf was designed by the reader as a last-ditch place: a note that fits nowhere else in
the Library survives a Notebook reset there. On 2026-09-29 it held 37 notes, 21 pending and 16
reviewed, with the oldest pending from 2026-09-19. Read by title, and four of them in full, almost
none fitted nowhere else:

| What the notes were | Where they belonged |
| --- | --- |
| product ideas and roadmap (a GUI, Obsidian, synced drives, onboarding) | the owning dev Hub's backlog |
| session kickoffs, parked plans, session findings | the seat's Hub: `## Next`, or a dated `notes/` page |
| messages from one seat to another ("For game-admin: ...") | the receiving seat's attention; no route exists |
| know-how (Windows Sandbox traps) | a Book |
| drafts superseded by a later note (four versions of one vault idea) | nowhere: closed by the later note |

Four causes, each verified:

1. **Until 1.2.3, Holding was the only door that opened.** On the local collection no seat could add
   a page to a Book or a Hub, and the shared Notebook layout refused writes (the S67 kickoff quotes
   the reader: *"no seats can save anything other than holding shelf tasks"*). 1.2.3 shipped
   `collection add-page`, `hub edit --mode new-page` and the migrate, so this cause is gone, and the
   backlog is its footprint.
2. **The guidance sent every "save this" to Holding.** The workspace template, this repository's
   `CLAUDE.md` and the `library-help` Skill all said *"Save this for later" → the Holding Shelf*, and
   the Skill added that the capture needs no request in advance. [Capture Books](../capture-book-model.md)
   made that a stated benefit: *"Capture stops being a decision."* Seats did what they were told.
3. **Leaving Holding does not close a note.** Triage's `project` and `book` kinds are not ported, so
   a seat files a note with `hub edit` or `collection add-page` and must remember a separate `review`
   triage. It usually does not. A `done` note is never removed either, since `discard` is a gated
   delete, one note at a time.
4. **Nothing pushes back.** `library desk` reports the counts and the oldest date, and nothing reads
   a growing count as a problem.

## Decision

**The guidance half, effective now:**

- **"Save this for later" asks where the note belongs first.** The ladder, in order:
  1. the seat's own Project: its Hub's `## Next`, or a dated `notes/` page (`hub edit --mode
     new-page`, additive and ungated);
  2. durable know-how a Book covers: that Book (`book add-page`, or `collection add-page` with its yes);
  3. working material for the task at hand that need not outlive a reset: the Notebook;
  4. a defect in the Library itself: the Report Inbox (unchanged);
  5. **only when none of those can take it**, the Holding Shelf. For example: there is no seat, no
     Hub or Book fits, the reader declines the yes a Book needs, or a reset is about to happen and
     there is no time to sort the note.
- **A Holding note says why it is there,** in one line at the top of its body, until the kernel has a
  field for it. (Since S73 the field exists: `capture --why <category>`.)
- **A note that has moved is closed in the same turn.** Once its content is in its home, mark the
  Holding copy `review` (one triage action). A note that supersedes an earlier one closes the earlier
  one the same way.
- **A seat triages what it wrote.** When `library desk` shows pending Holding notes, a seat offers to
  sort the ones whose `from_seat` is its own. It leaves other seats' Holding notes alone unless the
  reader asks otherwise.
- **A message for another seat** may still go to Holding, since no seat writes another's Hub. It is
  tagged `for-seat`, and its title names the seat it is for. The receiving seat closes it once it has
  acted on it. A proper route is still an open question.

**The kernel half,** planned in `PLAN-holding-discipline.md` and not built by this ADR:
- every close stamps `reviewed: <utc>` and a reopen removes it (shipped in S73);
- filing a note into a Shelf Book, a local Hub or a local collection Book closes it (all three
  routes shipped in S73; the collection Book one is the new kind `collection-book`);
- a recorded (never required) `--why` category, counted on the Desk (shipped in S73);
- `--supersedes <page>` (shipped in S73);
- `shelf tidy`, which moves long-closed notes inside the Book, to `wiki/reviewed/<yyyy-mm>/`, with
  `--restore` for the way back (shipped in S77);
- a Desk and doctor signal past a pending-count or age threshold: `growing` on the Desk row and a
  doctor WARN, from the Book's own `Growing at:` line or 5 pending and 7 days (shipped in S77);
- `--for <seat>` for a message to another seat;
- the seat rule as a kernel rule: per Book (`holding` writer-only, `reports` any seat), on every route that closes,
  reopens or deletes a note, with the reader's named per-action override (shipped in S73; see the safety boundary).

## Reader benefit

Material lands where the next session will look for it: a Hub, a Book or the Notebook, not a closed
Shelf Book nobody opens. The Holding Shelf goes back to what the reader built it for, so a note on it
means something again, and a growing count points at a real gap in the Library rather than at habit.

## Safety boundary

**Nothing is ever lost to the ladder.** Capture to Holding stays ungated, needs no open Book and
survives a reset, exactly as before. When a higher rung would need an approval the reader has not
given, or its home is unclear, the note goes to Holding rather than waiting. The ladder only chooses
a destination; it adds no gate to saving.

**No seat sorts another seat's Holding notes** unless the reader asks it to. The Report Inbox is
different by design: a Report is filed by one seat for another to close. Nothing here deletes a note:
closing means `review: done`, and `discard` keeps its preview and its yes.

**Since S73 the kernel enforces that sentence, per Book.** The rules:
- **Per Book, from the entry.** Each capture Book's catalog entry says `- **Closed by:** writer` or
  `any`. `library init` writes `writer` for `holding` and `any` for `reports`, and
  `shelf new --capture` writes `writer` unless told `--closed-by any`.
- **Old entries.** An entry with no line is any-seat, as every Book was before the line existed. An
  unrecognised value reads as `writer` and never refuses a capture. `library doctor` warns on both,
  keyed on the capture Kind rather than a slug, and edits nothing.
- **Which notes a seat may close.** In a `writer` Book, a seat may close, reopen or delete only a note
  it wrote, a note with no `from_seat` (a seatless capture), or a message whose `for_seat` names it.
- **Every route.** That covers `review`, `review --reopen`, `notebook`, the filing kinds, `discard`
  and `capture --supersedes`. It is stated once, where triage resolves the note, against one seat
  resolved with `--seat`.
- **The reader's override.** It is the action's `other_seat`, naming the writing seat. It enters the
  plan id, and the preflight lists such actions apart. A wrong one is refused, and a correct but
  unneeded one is accepted.
- **No change to saving.** Capture without `--supersedes` stays ungated and seatless-capable.
- **Tidying is Library housekeeping, and covers every seat's closed notes** (S77). `shelf tidy` moves
  and never closes, reopens or deletes, so the seat rule, which is about closing, does not apply to it.
  It needs the Book open and the reader's yes to its plan id, like any move.

## Consequences

- *"Capture stops being a decision"* in [Capture Books](../capture-book-model.md) is revised: choosing
  a destination is now a small decision, and Holding is the answer only when the others fail.
- The `## Keeping material` bullet stays on the always-on surface, as ADR-0017 requires for a rule
  triggered by the reader's imperative. Only its wording changes, word-neutral in this repository's
  `CLAUDE.md`.
- Until the kernel half ships, closing a moved note remains a second step the Librarian must remember.
  That is the known weak point this ADR accepts.
