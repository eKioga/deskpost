# ADR-0072: A seat is renamed by its id, one seat per run, behind a barrier and a journal

**Status:** accepted
**Date:** 2026-10-09
**Effective from:** the release that carries S109 (the support seat names it)
**Relates to:** [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (what a seat's name
proves), [ADR-0029](0029-the-notebook-belongs-to-the-seat.md) (each seat's Notebook is its own root),
[ADR-0069](0069-the-program-addresses-links-and-counts-a-seat-decides-where-a-letter-goes.md) (letters address a seat),
and `PLAN-seat-identity.md` r8, section 2 (signed off by the reader 2026-10-07)

## Context

The reader named eight seats before seats could talk to one another, and the names do not say what each seat does.
Until now the only way to a better name was to retire a seat and make a new one, which loses its conversation, its
Desk, its Notebook and the letters addressed to it. Session 1 of the seat-identity plan (1.4.0) made a seat's
`seat_id` its identity under every seat-name join and gave a registry row a `names` history, so a name can change
without any record losing its seat. This decision is the verb that changes it.

A rename moves two trees (the seat's state folder and its Notebook root), edits four small files and one registry row.
A crash between any two of those writes must leave a seat that can be finished or put back exactly, and no other verb
may act at the seat while it is half-moved.

## Decision

1. **A seat is renamed by its id, one seat per run.** `deskpost seat rename <old> <new>` previews, then applies with
   the plan id its preview issued, under the reader's one yes. The `seat_id` never changes; the registry row's `seat`
   becomes `<new>` and its `names` history gains the span. There is no batch rename.
2. **The Project and its Hub never change.** The seat stays bound to its Project slug; Hub pages, permalinks and raw
   batch owners are untouched. Text outside Deskpost keeps the old name.
3. **What moves, and what does not.** `.claude/seats/<old>/` becomes `<new>/`, and `notebook/<old>/` when it exists.
   Inside the folder only the `seat` key of `binding.json`, `activity.json`, `conversations.json` and
   `holder-attempt.json` changes; every other file is kept byte for byte. A seat with no Notebook root renames as well.
4. **The preview refuses, naming the reason, and writes nothing** when the seat is held or orphaned, a rename of it is
   unfinished, the new name is not free (a live seat's, a name another seat gave up, a retired seat's plain name), the
   Notebook is legacy or migrating, the seat has no valid `seat_id` of its own, or a retirement record cannot be read.
   The plan id binds the registry, the row, the claim state and every file under the folder and the Notebook root.
5. **A barrier and a journal.** The apply first writes `internal/seat-rename-journals/<seat_id>.json`. While it stands
   before its commit point, every verb that acts at the seat by either name refuses with "Seat '<x>' is being renamed;
   run deskpost seat rename --resume <x> or --rollback <x>"; other seats are not blocked. The journal records each
   mutation's before-image and expected after-image.
6. **A point of no return.** After the moves, the edits, the history record and the registry row, the journal is marked
   committed and the history's commit line is written. Before that point a stopped run is resumed (`--resume`) or put
   back (`--rollback`) mutation by mutation, each classified from the disk as before, after or neither; neither
   refuses, naming the target and both hashes. The registry is restored or completed row by row, so another seat's
   change made meanwhile survives. After it, `--rollback` refuses and `--resume` does only the letters maps.
7. **The undo is a rename back.** `seat rename <new> <old>` is allowed when `<old>` is the seat's immediately previous
   name, which stays reserved for it; it takes the same preview, journal and barrier.
8. **Lock order:** the registry lock, then the seat's Notebook lock, then the barrier. Every Notebook writer takes the
   seat's Notebook lock around its final check and write, and every seat writer checks for a barrier again under its
   lock, through one seat-path resolver (`seatpaths.ts`).

## What this changes

- New verb `seat rename`, with `--resume` and `--rollback`. New verbs have no oracle rows.
- The development repo's `.claude/settings.json` no longer allows the PowerShell tools that can regenerate a Shelf
  map through `ShelfNoteCommon.ps1`; the kernel's writers cover each.
- An old name is not an address. The redirect that tells a sender the new name, and the menu's "(formerly)" line, come
  after this session's cut (`PLAN-seat-identity.md` section 3).

## Consequences

- A seat keeps its conversation, Desk, Notebook, folders and letters across a rename; the launch line reads its added
  folders and inbound settings from the moved folder and passes `--name <new>`.
- A resumed conversation may think of itself by the old name until told; the rename's result gives its first line,
  "You are now <new>, formerly <old>."
- A rename stopped by a crash leaves a barrier until the reader resumes or rolls it back; nothing else at that seat runs
  meanwhile.
