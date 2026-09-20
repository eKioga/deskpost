# A capture Book's name does not reuse a glossary term at a different scope

The Library gained a second capture Book on 2026-09-11. Naming it forced a question the glossary had
never been asked: **Holding Shelf** is a *Book*, and **Shelf** is the collection of Books it sits on.
One word, two scopes, four entries apart in the file whose entire job is to stop that.

The reader found it, not a check. Reading "the Holding Shelf is a capture Book" is where it lands.

## Status

accepted — 2026-09-11.

## Considered options

**Leave it, and name the new Book to match.** Rejected. It doubles the defect: a reader who has just
learned that a Shelf is a Book meets a second Book whose name also says Shelf, and the glossary's
`_Avoid_` lines lose their authority precisely where they are being consulted. This repository
already threw out the seat name `main` on exactly these grounds — it collided with
`BASIC_MEMORY_DEFAULT_PROJECT=main`, *"one word for two unrelated concepts, exactly what the
glossary's `_Avoid_` lines exist to prevent"* ([Seats](../seats.md), *There is no default seat*).
The rule existed; nothing had applied it inward.

**Rename the Holding Shelf now.** Rejected as the expensive answer to a cheap problem, and the
reader ruled on it directly. It is *possible*: `Rename-ShelfBook.ps1` did this once, on
2026-08-17, with a preflight naming every live reference, one approval bound to the catalog and to
every page hash, a per-Book lock, a pre-write journal, and a rollback verified by readback. It is
not free: that rename surfaced two defects in `BookWriteGuard.ps1` and added the
`shelf.references-resolve` gate check, because a rename touch-list rots. Spending that to relieve a
confusion that a second Book might itself resolve is the wrong order.

**Name the new Book so the pair teaches the distinction, and rename nothing.** Accepted.

## Consequences

**The rule, stated once so the next capture Book inherits it:** a capture Book's name must not reuse
a term `CONTEXT.md` already defines at a different scope. *Shelf* means a collection of Books;
a Book is not one.

**The pair carries the meaning that neither name carries alone.** The Holding Shelf receives from the
reader's own Notebook. The **Report Inbox** receives from another seat. That is the same line the
2026-08-17 rename drew when it rejected *Inbox* — *"an inbox receives from outside and this receives
from the reader's own Notebook"* — so the word is not merely available for the new Book, it is the
word that rename's own reasoning points at.

**A prohibition became a distinction.** The Holding Shelf's `_Avoid_` line said *Inbox*. It now says
*Inbox — that is the Report Inbox, which receives from somewhere else*. An `_Avoid_` entry that
explains where the word did go teaches the model; one that merely forbids it invites the next
session to wonder why.

**The Holding Shelf keeps its name, and the collision is still there.** This ADR does not claim to
have fixed it — it records a decision to let a second, contrasting name do the work first. That is
falsifiable: if a reader still trips over *Shelf* now that the pair exists, the rename is back on the
table with better evidence than it had today, and this entry is superseded rather than defended.

**Written at ship time, deliberately not before.** [Cross-Seat Agent
Reports](../cross-seat-reports.md) ruled that this ADR wait until the Book existed, because
*"let the pair teach the distinction"* records nothing if the pair is never built, and the collision
would then need deciding from scratch. [ADR-0005](0005-the-hub-page-size-harness-stays-a-throwaway.md)
is the precedent for not building ceremony around what may stay a proposal.

Full record: [Cross-Seat Agent Reports](../cross-seat-reports.md), *The naming question*.
