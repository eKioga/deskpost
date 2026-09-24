# The Notebook belongs to the Seat

A Seat carries its own Desk and its own Notebook. What stays shared is the collection, the Shelf
and the Discovery index. A reset is "reset this Seat's Notebook" and touches nothing else.

## Status

accepted — 2026-09-19, Eric's ruling Q4 in `PLAN-public-release.md`. Effective from that plan's
Phase D, in the TypeScript kernel only; the PowerShell implementation never carries it.

**Implemented in the kernel 2026-09-22 (S18)**: `notebook/<seat>/`, activated by
`internal/notebook-layout.json`, and `library migrate` over every legacy state this ADR names -- plus
one it did not: an ownership row whose topic is no longer on disk, which the PowerShell reset leaves
behind every time it quarantines a topic. The reader's four rulings of that session (the root's
location, what no seat owns, what an interrupted migration blocks, what an unmigrated workspace does)
are recorded in `kernel/README.md`. `CONTEXT.md` says the model and that an unmigrated workspace still
shares one Notebook, because the PowerShell tools the reader uses today never carry this.

**Supersedes** the "one Notebook" clause of [ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md)
and the mechanism of [ADR-0019](0019-a-topics-ownership-changes-only-under-its-topic-lock.md).
**Keeps** [ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md)'s promise
(a reset is seat-scoped and quarantines rather than deletes, now trivially) and
[ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md)'s binding.

## Why

`notebook/<project-slug>/` already partitions the Notebook by project, and ADR-0015 already binds a
Seat to exactly one Project. What made the Notebook shared state was everything around the
directories: one tree, one rendered master index, one ownership record, topic locks taken across
seats, quarantine by owner, and a whole-tree reset path guarded by "a topic nobody owns blocks the
reset". `docs/seats.md` is 1,212 lines and a large share of it exists to keep that shared tree safe.

Eric's account on 2026-09-19 is the evidence: the seat menu is the feature he values most — "a
familiar cockpit with everything I need ready to go" — and "the only real trouble was clearing out
the notebook because notes from other sessions are tied to it." He confirmed he never runs two
Seats on one Project. The simpler design makes the sharing go away instead of making it safe.

This also answers the 2026-08-17 brief's open question R3, "decide what the Notebook tier is
for", with the reader's own evidence: it earns its ceremony only as per-Seat scratch.

## Considered options

**Notebook per Project rather than per Seat.** Identical while one Seat per Project holds, which
Eric confirmed. It is the fallback if that ever changes: a one-line difference now, a migration
later.

**Keep the shared Notebook and improve the reset experience.** Rejected. It keeps the whole
contract and the class of defect it exists to prevent.

## Consequences

- Retired: topic ownership records, `Set-NotebookTopicOwner`, cross-seat topic locks,
  quarantine-by-owner, and the rule that an unowned topic blocks a reset. The master index becomes
  a roll-up derived on demand, never shared state.
- Kept on review: a **per-Seat Notebook mutation lock**, because one agent can issue concurrent
  operations and reset, compile and triage still exclude each other.
- A Notebook article two Seats both want has no shared home; it graduates to a Shelf Book, which is
  the designed exit ramp. The Library already says the Notebook is disposable; this makes it true.
- The migration is resumable and enumerates every legacy state — owned, shared, excluded,
  unmapped, loose files, retired incarnations, quarantine — with a recorded disposition, and refuses
  activation until each is accounted for.
- `CONTEXT.md`'s Seat entry changes with the implementing release, not before.
