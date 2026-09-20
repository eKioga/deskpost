# The operator's own seat is excused from the cutover engage scan, proven and never named

`Move-LibraryFolder.ps1` refuses to engage while any registered seat is held or orphaned. Exactly
one seat is excused from that scan: the one the process driving the cutover **proves** it holds a
live claim for. The proof is the disjunction `Assert-SeatClaimHeld` already admits — a matching
claim token, or a committed binding naming this process's agent — and a seat named without one still
blocks. What is excused is only *"do not count me as a reason not to start."* Once the barrier is up,
that seat is refused every claim-gated mutation like every other.

## Status

accepted — 2026-09-19, Eric's ruling in session S3 of `PLAN-public-release.md`. Effective
immediately; it is what makes Phase A's moves runnable by the Librarian.

## Why

S2 built the scan to count every registered seat, with a deliberate comment on the call: *"a mover
must not exempt itself from the scan by happening to run inside an agent that holds a seat."* That
intent is right and this decision keeps it. What it missed is that the seat driving the cutover is
registered like any other, so from the `library-dev` seat `-Preflight` itself was refused with
`seat 'library-dev' is held by a live session` and the Librarian could run only `-Action Status` —
contradicting the playbook the same session wrote, whose step 2 tells the Librarian to run the
preflight and show the reader what it reports. One of the two had to change.

**The operator is not the hazard the barrier exists for.** That hazard is a writer changing the
source *after* its copy was verified. The operator's session is blocked synchronously inside the
mover for the whole run and cannot be that writer, and once the barrier is up its seat is refused
every claim-gated mutation anyway.

**S2's fixtures could not see it**, which is the more useful half. Every mover fixture ran against a
workspace whose seats were free: they proved a held seat blocks, and never asked whether the
*operator's* seat should count. A guard asserted only against strangers has never been asked about
its owner.

## Considered options

**Leave the scan alone; run cutovers from a seatless terminal.** Rejected on what it actually costs.
The scan blocks on *any* held seat, so this does not mean "open another terminal" — it means ending
the Librarian's session first, the reader driving every cutover by hand, and a fresh session
afterwards for the Hub edits. The session that reports a cutover would never be the session that ran
it. For a six-cutover session that is six teardowns.

**Exempt by seat name, from `LIBRARY_SEAT`.** Rejected; this is precisely the "happening to" S2
warned about. An agent handed or inheriting the variable carries no claim and would excuse a seat a
real session is sitting at.

**Exempt via `this_agent` alone.** Rejected on measurement. No seat in this workspace carries a
committed binding, so `this_agent` is false and the token is the only proof available — an exemption
keyed on the binding alone would have left the operator blocked and the change inert.

**Ask whether the source actually contains the workspace, and skip the seat scan when it does not.**
Not taken, and deliberately left open. The refusal's own reasoning — *"its Desk and Notebook are part
of what is being moved"* — is false for every Phase A source and true only in step 22, when
`D:\Library` itself moves. That is a larger change than the evidence in hand supports and belongs to
S11, where it can be ruled against the case it actually describes.

## Consequences

- The exemption applies to **`held` only, never `orphaned`**: `mutate`/`orphaned` is `refuse` in
  `Get-SeatStateMatrix` even for the same agent, and an operator whose own claim holder died cannot
  vouch for its own quietness. It blocks, with the orphan's own remedy.
- `Assert-SeatClaimHeld` does not consult the exemption and must not learn to. The barrier's
  guarantee is unchanged.
- The seat and token are resolved from the environment **in the entry point's parameter defaults**,
  never inside the scan, so a fixture can drive both routes. A guard that resolves its own identity
  inside its decision is one nothing can test — which is how the gap survived S2.
- **The exemption is named, never a silent absence.** `exempt_seat` appears on `-Action Status`, on
  the preflight plan, on the confirmed result, and in the run's journal. `blocking` now honestly
  answers a different question for a different asker: *what stops a cutover this session would start.*
- `Test-LibraryFolderMove.ps1` section 4b pins it with two held seats — only the bystander blocking —
  a per-route case for the token and the binding, and the negative that makes it falsifiable: a seat
  named without a matching claim must still block. Deleting the token comparison turns that one red
  and leaves the rest green.
- The cutover playbook's step 2 and its barrier paragraph were corrected in the same pass. The
  barrier paragraph also lost a claim that was never true: a Hub edit is **not** refused under a
  barrier, because `Edit-ProjectHub.ps1` is not claim-gated and the barrier reaches nothing else.
