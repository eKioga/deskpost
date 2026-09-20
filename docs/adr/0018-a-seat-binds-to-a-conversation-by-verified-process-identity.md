# A seat binds to a conversation by verified process identity

Sitting down at a seat took five steps and two remembered names, and the button the reader actually
reaches for — the IDE's Claude button — bypassed all five: it starts an agent with no seat, which can
read the Library's own files and open nothing.

So a seat **binds to the running agent process**. The binding is a durable record naming that
process; the process's own identity is what every consumer verifies; and `LIBRARY_SEAT` becomes a
convenience that **must agree with the binding or the call is refused**. A conversation id is used to
*find* a seat again, and never to authorise anything.

Nothing that makes seats safe moves. One live agent per seat, one seat per agent process for the life
of that process, **no default seat**, the claim-gated mutators fail closed without a held claim, and
a seat is held for exactly as long as the agent process that holds it is alive.

## Status

accepted — 2026-09-09. `PLAN-seat-launch.md`, converged through five Codex rounds
(`PLAN-REVIEW-LOG-seat-launch.md`); three load-bearing rulings by Eric, recorded below as Q1, Q2 and
Q3.

**Amends [ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md) on the entry route only.**
ADR-0015 said a session that names no seat has no Desk, and that stands. What changes is that naming
a seat is no longer the launcher's exclusive privilege: a running conversation may **bind** one, and
the binding is stronger evidence than the environment variable the launcher exports. The
2026-09-07 mandatory-launcher ruling narrows the same way — the launcher stays, and stops being the
only door.

Nothing here amends [ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md):
a whole-tree reset still covers the acting seat plus explicitly retired seats and hard-refuses every
other one, whatever its liveness.

## What was measured, because the decision rests on it

Every route below was read out of live processes on 2026-09-09, before any of this was written. The
step-0 entry on `notes/library-dev-history-2026-08-part-2` carries the tables.

- **`CLAUDE_PID` reaches tool and hook children, and nothing else.** It is set in the Bash tool's and
  the PowerShell tool's children; it is **absent on `claude.exe` itself** and **absent in MCP server
  processes**, read through the PEB with a positive control against two processes known to carry it.
- **So the validated-reader adapter has no environment route at all**, and its parent process is the
  only one: `claude.exe` for the Claude Librarian and **`codex.exe` for the Codex Librarian**, whose
  adapter carries neither `CLAUDECODE` nor `LIBRARY_SEAT`. A parent-name test written for
  `claude.exe` alone would refuse the Codex reader outright.
- **One agent process can have several adapter instances live at once** (two, then a third minutes
  later, all parented to the same agent). Resolution must not assume one adapter per agent.
- **`--session-id <uuid>` is honoured exactly**, a fork gets a **new** `session_id`, and
  `additionalContext` reaches the model where `systemMessage` does not.
- **A spawned holder outlives the process that spawned it**, including that process being killed, so
  no `CREATE_BREAKAWAY_FROM_JOB` and no fallback to the launcher route.
- **The registry lock costs 0.74 ms uncontended** and refuses promptly when held, so a hook's
  deadline and the bind handshake's are both about two seconds. The 20-second default is a
  stale-holder timeout, not a latency budget.

## The decisions

**Q1 — attach after launch, and verified process identity is the authority.** *(Eric.)* The Claude
button stays exactly as it is. A `SessionStart` hook notices the session has no seat and hands the
Librarian the seat roster with one instruction: ask which seat, then bind it. The reader answers in a
sentence.

`LIBRARY_SEAT` is then a **convenience that must agree**. A binding and a disagreeing environment
value are a refusal naming both, never a silent preference for either. Environment-first was the
alternative and it is the dangerous one: a stale inherited value would read another seat's Desk while
its writes refused, which is the half-migrated state ADR-0015 rejects.

**An environment-only resolution is a name, not a verified binding, and nothing records it as one.**
That is what keeps the launcher's own route working on the day a hook cannot run.

**Q2 — a resumed conversation re-binds the seat it last held, if that seat is free and the same
incarnation, and the hook does it.** *(Eric.)* This is a **per-conversation binding, not a default**:
it restores a seat this conversation demonstrably sat at, and it restores nothing for a conversation
that never sat anywhere. Always asking was the alternative; IDE hibernation would have made the
question daily.

**Q3 — a new seat needs one confirmation, and that confirmation is bound to a `plan_id`.** *(Eric.)*
Creating a seat names two slugs — the seat and its Project — and the `plan_id` covers both, plus the
registry digest, so an approval cannot execute a different creation from the one that was shown. An
intent flag alone was the alternative; it approves "a seat", which is the defect the reset's own
unbound `-UserConfirmed` had.

**One agent process holds one seat for the life of that process.** No live switching. A
launcher-started agent carries `LIBRARY_SEAT` in an environment no helper can rewrite, so a release
would turn every later call into a disagreement; and a mutator that checked its claim before taking
its operation lock could finish a write after the seat had been given away.

**A conversation id locates a seat; it never authorises.** A conversation resumed in two processes is
the agent's own concurrency: each process holds its own seat legitimately, the Library records both
and announces the newer one, and enforcing uniqueness would need a new suspension state in every
mutation gate to police it. So the conversation record is a lookup table, and the claim is still the
only thing that admits a write.

**A retired slug is not reusable while any record still cites it.** A seat is identified by a
`seat_id` — one **incarnation** — and a retired-and-recreated seat is a different one. Ownership rows
keep their slug this release, so until *give retirement an identity* migrates them, reuse of a cited
slug is refused rather than silently inherited.

**A hook may invoke a helper that holds the rule while holding none of its own**
([ADR-0014](0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md)). The resume-bind and the
backstop recorder are the first hooks here that mutate seat state, and the boundary is the same one
ADR-0014 drew for served guidance: the hook calls `tools/Enter-LibrarySeat.ps1`, which refuses
everything the Librarian would be refused; the hook's own instructional text is served from a named
section of a tracked document (*Sitting down at a seat*, in [Seats](../seats.md)) rather than written
into the hook; and its deadline is short, with the roster or silence as its failure, never a blocked
session.

## What this deliberately does not do

**It does not authenticate a session.** `CLAUDE_PID` is an environment value: any process on this
machine can set it and pass as a session, exactly as any process can read the claim token out of the
claim file today. `CONTEXT.md` defines the Desk as a control over attention and **not a security
boundary**, and this decision keeps it there. What verified identity buys is that a *mistake* — a
stale value, a reused PID, a resumed conversation — cannot silently read or write the wrong seat. A
PID is verified together with the process start time for exactly that reason: a reused PID neither
inherits nor ends a claim.

**It does not open the seatless Project catalog.** `Get-DeskProjectId` still refuses a missing Desk,
and its self-test still requires that. The seat picker's list of Projects is a helper-side read on
the route `Edit-ProjectHub.ps1` already uses, taken outside every lock.

**It does not redirect the IDE's Claude button.** `settings.agentCmdOverrides` is profile-global, so
aiming it here would run a Library wrapper in every workspace; it stays an option to be measured
after this ships.

## Consequences

- **Two files, not one**: a durable binding that carries identity, and a transient handle that
  carries liveness. Truncating one file that held both would erase the identity that makes recovery
  safe.
- **Liveness gains a third state.** A seat is `free`, `held`, or **`orphaned`** — no live handle, a
  committed binding, and its agent still alive. An orphan is repaired by a re-bind from the same
  agent and is refused every mutation until it is, so a lost holder never reads as a stopped agent.
- **A committed binding is never rewritten while its agent is alive.** Recovery writes a new holder
  attempt and leaves the binding alone.
- **`Test-SeatClaim` stays Boolean.** In Windows PowerShell 5.1 every non-empty string is truthy, so
  a tri-state returned from the existing Boolean function would make every `-not (Test-SeatClaim …)`
  in the repository stop detecting a free seat. The three-state answer is a new function, and each
  decision migrates to an explicit comparison on it.
- **`CONTEXT.md` gained the vocabulary first**: **Conversation**, **Binding**, **Claim holder** and
  **Seat incarnation**, in the same commit series as the first line of code that needs them.

Full design: `PLAN-seat-launch.md`. The seat model it extends: [Seats](../seats.md).
