# Idleness authorises a sweep; retirement still gates a whole-tree reset

The Notebook accumulates across seats and no single operation cleans it. A seat-scoped reset takes
only the acting seat's topics, so "clear my notebook" leaves a directory that is entirely other
seats' material. `Reset-LocalNotebook.ps1 -AllIdleSeats` is meant to close that: quarantine the
Notebook topics of every seat not currently in use, name and skip the ones in use, touch no Desk.

Two decisions already refused that target set by name.
[ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md) refused *"an
unclaimed, unretired foreign seat"* because *"including it bypasses retirement"*.
[ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) reaffirmed it
*"whatever its liveness"*. So this is owed an argument rather than a feature flag.

**A seat being idle now authorises a sweep of its Notebook topics. Retirement still gates a
whole-tree reset, and nothing here widens one.**

## Status

accepted — 2026-09-15. `PLAN-notebook-drain.md` item 2, ledger row 6 (foundations). The
`-AllIdleSeats` sweep itself is row 7 and is not built by this decision.

**Amends [ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md) on the
third case only.** ADR-0016's three-part ruling — reset selects by ownership, quarantines instead
of deleting, and refuses a seat it cannot prove is idle — stands whole. What changes is that the
unclaimed, unretired foreign seat is no longer refused *everywhere*: it stays refused inside
`-WholeTree`, and becomes reachable by a differently named operation that discloses what it is
doing. The remedies ADR-0016 names — **wait** for a claimed seat, **retire** a dormant one — are
both still correct answers; a sweep is a third.

**Amends [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) on its
non-amendment clause only.** ADR-0018 said *"Nothing here amends ADR-0016: a whole-tree reset still
covers the acting seat plus explicitly retired seats and hard-refuses every other one, whatever its
liveness."* That sentence was a statement that ADR-0018 changed nothing, not a finding that liveness
is inadequate evidence — and it remains exactly true of `-WholeTree`. Everything ADR-0018 decided
about bindings, claims and the three-state answer is untouched and is what makes this decision
possible at all.

## What made this answerable, and it is not a change of mind

**The refusal was written against an operation that could not say whose material it was taking.** On
2026-09-07 a reset's preflight named topics; it did not name owners, it did not report what already
existed durably elsewhere, and its journal recorded no per-topic owner. An operation that reaches
another seat's material while unable to tell the reader whose it is, or to give it back, is one
ADR-0016 was right to refuse. Three things shipped since, all within this plan:

- **The preflight names the owner of every topic** and classifies the rest as `protected`, `foreign`,
  `retired`, `unaccounted` or `unmapped` (`Get-NotebookResetTargets`, 2026-09-10).
- **The preflight names what already exists durably in a Book or a Project Hub, per topic**
  ([ADR-0022](0022-reachability-names-the-destination-class.md), 2026-09-15), so "whose is this and
  is it safe to move" is one read rather than an inference.
- **The quarantine journal carries per-topic `recorded_owners`**, and a quarantine read names the
  articles inside it (2026-09-15). What a sweep sets aside can be handed back to the seat it came
  from.

**And the liveness rule this rests on is not new either — it has been enforced since 2026-09-09 for
a smaller version of the same act.** `Set-NotebookTopicOwner` refuses to move a topic away from a
seat whose claim state is not `free`, and permits it when that seat is dormant
(`tools/NotebookOwnership.ps1:445-452`; [Seats](../seats.md), *Reassignment is gated by the acting
seat*). ADR-0016's own refusal text points the reader at that route. So the Library already decided
that a dormant foreign seat's Notebook topic may be taken by a live one, on exactly the test this
ADR adopts.

## Considered options

**Leave it refused; tell the reader to retire the seat first.** Rejected, and it is the status quo
this replaces. Retirement is not a tidying step — it ends a seat, archives its Desk, frees its slug
and makes *all* of its material whole-tree eligible. Asking a reader to retire a seat they intend to
sit at again next week, in order to clear a stale Notebook topic, prices a small act at a large one.

**Reassign, then reset — the route that exists today.** Rejected as the thing being fixed rather
than kept. It works, and it is *less* safe than the sweep: `Set-NotebookTopicOwner` rewrites the
ownership row, so after the reset nothing anywhere records that the topic was ever the other seat's.
The two-step route trades the owner's name for the same quarantine. A sweep keeps both.

**Extend `-WholeTree` to cover idle unretired seats.** Rejected, and this is the horn ADR-0016
impaled itself on deliberately. `-WholeTree` is a name that claims completeness, so its dilemma is
real: silently excluding a seat makes the name false, and including one bypasses retirement.
`-AllIdleSeats` is a name that states its own limit — idle seats, with the busy ones named — so it
faces neither horn. **The flag is load-bearing, not cosmetic.** The same code reached through
`-WholeTree` would re-create the defect ADR-0016 refused.

**Key the predicate on `Test-SeatClaim`.** Rejected, and it is the obvious implementation and the
wrong one. That function answers about the *handle*, so it returns `$false` for an **orphaned**
seat — no live handle, a committed binding, and its agent still alive and working. It stays Boolean
for the reason ADR-0018 records: in Windows PowerShell 5.1 `'free'` is truthy, so returning a state
from it would invert every `-not (Test-SeatClaim …)` in the repository at once. The sweep therefore
keys on `Get-SeatClaimState … -ne 'free'`, which is what `Set-NotebookTopicOwner` already does.

**Probe the claim first and read the incarnation afterwards.** Rejected on a reachable data-loss
path, and it is the finding that made this row worth its own session. See below.

## The decision, stated as the predicate

`Get-SeatSweepDisposition` answers one ownership row at a time, and is total over every row a
Notebook can produce. Its order is the ruling:

| Test, in order | Answer | Why |
| --- | --- | --- |
| the acting seat's own incarnation | **allow** (`acting-seat`) | authorised by its own held claim, not by idleness — a reset already takes these |
| the incarnation is **retired** | **skip** (`retired-incarnation`) | `-WholeTree`'s alone; ADR-0016 unchanged |
| the incarnation is **unaccounted** | **skip** (`unaccounted-incarnation`) | nothing can say that work is finished |
| claim state `free` | **allow** (`idle`) | nobody is writing it, and the owner is recorded in the journal |
| claim state `held` | **skip** (`live-session`) | somebody is working there now |
| claim state `orphaned` | **skip** (`lost-holder`) | the agent is still running; its claim holder was lost |

**The incarnation question comes before the probe, and that ordering is the guard.** A claim state
answers about a **slug**; an ownership row names a **slug and an incarnation** (ADR-0018). A seat
retired and created again under the same name is a different seat, so a predicate that probed first
would read the *new* seat's idleness and sweep the *old* one's topics. That is not a corner case: it
silently widens `-WholeTree` for every retired row, and for an unaccounted row it reopens the hole
closed on 2026-09-10, where a hand-deleted seat directory made another seat's topics eligible with no
refusal at all. Both are decided from the registry and the archive, and neither is decidable from a
claim state.

**Every skip has its own reason, and `skip` is not `refuse`.** A refused operation stops and changes
nothing; a sweep names the seat it skipped and carries on, because one busy seat must not cancel
"clear every idle seat". Six distinct reasons rather than one shared silence, so a preflight can say
which rule left a topic alone — the same discipline the whole-tree refusal already applies when it
picks a remedy per state.

## Consequences

**`Get-SeatStateMatrix` gains a `sweep` row-set, pinned both ways.** `free → allow`, `held → skip`,
`orphaned → skip`. A guard that pinned only the positive would stay green when a recognised state
went blind, and this table is the only thing between "clear every idle seat" and "clear every seat".

**The matrix's standing warning is now enforced rather than written.** It says a whole-tree reset's
other seats are on no row *"deliberately … putting it on this table would invite a future reader to
answer it from here."* `seat.resolution-contract` now pins the table's operation set at exactly
`enter`, `mutate`, `retire`, `sweep`, so a `reset-whole-tree` row fails the gate and sends its author
back to ADR-0016 before it can be read as an answer.

**A sweep still refuses an `unmapped` topic, and still never touches a Desk.** Both are ADR-0016 and
ADR-0010 respectively, and neither is in question here.

**The probe-contention window is real, is not fixed here, and belongs to the sweep's own build.**
`Test-SeatClaim` probes with `FileShare::None`, so for as long as that probe's handle is open a
legitimate `Enter-SeatClaim` at the same seat fails with *"already has a live session"* — and a
sweep probes every seat, twice if its preflight and apply each ask. It is recorded on
`Get-SeatSweepDisposition` at the point a reader would meet it, and closing it is row 7's.

**`sweep` stays a common noun and must not become a glossary term.** `CONTEXT.md` already uses the
word inside **Triage** — *"the sweep that makes a reset safe"* — for the review pass, and this
codebase uses it generically for a pass over a collection (mutation sweep, prune sweep, ownership
sweep). A matrix operation value is not a domain term, so ADR-0015's rule that the glossary moves
first is not engaged. Promoting *Sweep* to a `CONTEXT.md` headword **would** engage
[ADR-0020](0020-a-capture-books-name-does-not-reuse-a-glossary-term.md): one word, two operations,
both about resets. The reader-facing name is the flag, `-AllIdleSeats`.

## What this deliberately does not decide

**It does not decide D1, and does not lean on it.** D1 asks what *removal from `notebook/`* means
for a Triage plan — whether the `:81` refusal of `notebook → discard` still applies if the removal
quarantines rather than deletes, against the counter-citation that the quarantine is *"a recovery
route for material a reset has already moved, not a place to file things on purpose"*
([Notebook and Desk Model](../notebook-and-desk-model.md)). This decision is on the other side of
that line in both halves. It adds **no Triage kind** and leaves `$script:TriageSourceKinds`
untouched; and a sweep's quarantine is material *a reset has moved*, which is the sentence's own
permitted case, not a destination anybody filed to on purpose. The contested step here is **whose**
topics a reset may take, which is an authorisation question ADR-0016 owns — not **what** the move
means, which is D1's.

The independence is testable in both directions. If D1 settles that a quarantine-based removal is a
discard and the Triage refusal stands, the sweep is unaffected: the reset has always quarantined the
acting seat's own topics and that is not a Triage action. If D1 settles the other way and a `drain`
kind is founded, the sweep is unaffected again. Nothing below this line should be cited in that
argument.

**It does not decide D2** — whether removal belongs in Triage at all. A sweep is a reset.

**It does not license taking a live seat's material under any argument**, including that a
quarantine is recoverable. Recoverability is why a reset is safe to *offer*; it has never been why a
reset may reach somebody else's work, and reading it that way would erase the `held` and `orphaned`
rows the same day it was written down.

Full record: [Notebook and Desk Model](../notebook-and-desk-model.md), *Whose topics a sweep over
idle seats may take*. The seat model: [Seats](../seats.md).
