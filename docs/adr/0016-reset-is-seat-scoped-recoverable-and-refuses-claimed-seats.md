# Reset is seat-scoped, recoverable, and refuses claimed seats

`Reset-LocalNotebook.ps1` removed all of `notebook/` with one `Remove-Item -Recurse -Force`, under no
lock and with no journal. With one Desk that was merely blunt. With N seats it is the most habitual
command in the system destroying another seat's hour-long compile.

Three changes, and they are one decision: reset **selects by ownership**, **quarantines instead of
deleting**, and **refuses a seat it cannot prove is idle**.

## Status

accepted — 2026-09-07. `PLAN-multi-desk.md` Release 2.

**Amends [ADR-0010](0010-the-notebook-reset-preserves-the-desk.md) with a second axis rather than
editing it.** ADR-0010 settled *what a reset touches* — Notebook alone by default, the Desk only
on `-ClearDesk`. That ruling stands unchanged. This one settles *whose material it touches*, which
did not exist as a question when there was one seat. Both are live; neither supersedes the other.

## Considered options

**A metadata journal of what was deleted.** Rejected in round 1 of review, and it was the first
design. A JSON record of paths and hashes cannot restore files after `Remove-Item -Recurse`, and
copying every byte into JSON is expensive and crash-sensitive. Recoverability has to be a property of
the *move*, not of a description of it.

**Whole-tree reset only.** Rejected. It loses another seat's work on the command readers run most,
and "reset my workspace" is exactly the wording ADR-0006 routes here.

**Reset any seat whose Desk is empty.** Rejected, and this was the round-1 error worth recording.
`CONTEXT.md` defines the Desk as what is *in play*, not process liveness: an abandoned seat stays
non-empty forever, and an active seat can be writing Notebook material with an empty Desk. Desk state
cannot answer a liveness question.

**Include every claimed seat in a whole-tree reset.** Rejected, and the round-1 revision had this
exactly backwards. "Claimed" means *active*, so including other claimed seats is precisely what must
never happen.

**Reuse `internal/raw-batch-owners.json` for topic ownership.** Rejected. It is keyed by *batch*, and
a Notebook topic may come from session findings with no batch at all; reset correctness would then
depend on unrelated source provenance.

## Consequences

**Reset deletes nothing.** Each target is atomically renamed into a reset-quarantine directory, the
moves are journalled, the scaffold is rebuilt, and the purge is a separate approved operation. The
repository already used this shape at `internal/shelf-delete-staging` and
`internal/shared-delete-staging`, so it is the existing pattern rather than a new one.

**Ownership is a separate, crash-safe record** — `internal/notebook-topic-owners.json`, keyed by
topic with explicit seat and project ownership, maintained by every Notebook writer.

**Selection happens under the ownership-registry lock, and ownership is revalidated before each
move.** Ownership can be remapped between selection and deletion, and per-topic locks alone do not
stabilise the selected set.

**A whole-tree reset covers the current claiming seat plus explicitly retired seats, and hard-refuses
every other seat — claimed or dormant.** The third case is the one two review rounds left
undefined: an unclaimed, unretired foreign seat fits neither branch. Silently excluding it makes
"whole-tree" a false name; including it bypasses retirement. So it is refused, with the remedy that
fits its state — **wait** for a claimed seat, **retire** a dormant one.

**The preflight states which topics are shared or excluded**, rather than leaving them implicit in
the difference between the owned set and what is on disk. A reset that silently skips a topic and one
that silently includes one are both wrong, and the reader is approving one specific set of moves.

**A day-one inventory preflight refuses activation until every existing Notebook topic is mapped** or
deliberately declared shared or excluded. A `topic-slug == seat-slug` fallback would have recognised
only `notebook/main/` and left real directories like `notebook/library-dev/` unowned, reachable only
by the dangerous whole-tree path. This was free on the day it shipped, because `notebook/` held only
`_master-index.md`, and it gets more expensive with every compiled topic.

Full record: [Seats](../seats.md). The seat model is
[ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md).
