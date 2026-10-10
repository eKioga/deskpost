# ADR-0073: A department letter goes to its orchestrator or its only seat, and a seat's names follow one set of rules

**Status:** accepted
**Date:** 2026-10-09
**Effective from:** the release that carries S110 (the support seat names it)
**Amends:** [ADR-0069](0069-the-program-addresses-links-and-counts-a-seat-decides-where-a-letter-goes.md), its
delivery line for a letter to a department
**Relates to:** [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md)
(every request and answer between seats is a letter), [ADR-0072](0072-a-seat-is-renamed-by-its-id-one-seat-per-run-behind-a-barrier-and-a-journal.md)
(a seat is renamed by its id), and `PLAN-seat-identity.md` r8, sections 3 and 4 (signed off by the reader 2026-10-07)

## Context

ADR-0069 says two things about a letter to a department that cannot both hold. Its Decision says the letter "resolves
when it is written to that department's orchestrator", and `capture --for-department` refused a department with none.
Its Consequences say "A department of one makes its only seat its orchestrator". So a department of one seat got
nothing, though the ADR promised it would reach that seat. The reader decided (the plan's Q3): a department with no
orchestrator and one seat delivers to that seat.

Seat names also gained rules over three sessions without one place that states them: identity moved to the
`seat_id` (1.4.0), a rename gives a name up (ADR-0072), and an old name now points the way (S110).

## Decision

1. **One destination per department, worked out when a letter is written.** `departmentDestination(d)` gives
   `orchestrator` (the department's one orchestrator), else `only-seat` (the department has exactly one seat), else
   `none` with the department's seats. `capture --for-department`, `seat cards`' views, the retire preview and the
   new-seat wizard all use it, so they cannot disagree.
2. **Delivery.** A letter to a department goes to its destination's seat. It records `for_department` (the address)
   and `department_delivery: orchestrator | only-seat` (how it was resolved). With `none` it is refused: "Department
   '<d>' has <n> seats and no orchestrator, so a letter to it has no one place to go. Describe one as its
   orchestrator, or write to a seat with --for <seat>. Nothing was captured." Nothing moves a letter after it is
   written. There is still no engine and no queue.
3. **The retire preview** names the department that loses its destination (`department_loses_destination`, replacing
   `department_loses_orchestrator`): the orchestrator of a department, or the only seat of one.
4. **ADR-0069's contradiction is resolved** in favour of its Consequences line: a department of one delivers to its
   only seat. Its Decision's delivery line now reads as this ADR's point 2.
5. **The naming rules, in one place.**
   - A seat's `seat_id` is its identity; its name is a label with a history (`names`).
   - A name given up by a rename stays reserved for that seat, retired or not, and is not an address: a verb given it
     refuses with "'<old>' was renamed to '<new>' on <date>; write to that name." The menu shows "(formerly <old>)"
     for 30 days.
   - **A rename takes a name no seat has had.** It refuses a retired seat's final name, which a new seat may still
     take (`seat start`), as before.
   - A department is a product (deskpost, vault, valheim) or a shared service (homelab, website, games, ideas, audit).
   - Size: no orchestrator for a department of one seat; one from about three seats; a split when one is not enough;
     no nested departments until a real split needs them.
   - Names are suggested as `<department>-<job>[-<area>]` (`deskpost-lead`, `homelab-audit`). A suggestion, never
     enforced.

## Consequences

- A department of one seat can be written to by name, and the letter says how it was delivered.
- A department of two or more with no orchestrator is refused by name, with its seats listed, so the sender can pick
  one or the reader can describe an orchestrator.
- Capture's result and the retire preview each change one field; the acceptance matrix records both as deltas
  (kickoffs/s110 ruling 8).
- Nicknames, the auditor's audit record and `audit due` are later sessions of the plan.
