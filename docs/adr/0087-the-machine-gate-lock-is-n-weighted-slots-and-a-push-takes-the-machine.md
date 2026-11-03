# ADR-0087: The machine gate lock is N weighted slots, and a push takes the machine

**Status:** accepted
**Date:** 2026-11-01
**Effective from:** the release carrying c93 and c94
**Relates to:** [PLAN-two-builders.md](../../PLAN-two-builders.md)

## Context

c32 switched the lock off after c30 measured two gates finishing sooner side by side. c41 brought
it back after push suites timed out beside other gates, without recording a Decision. The time
study of 2026-10-29 in PLAN-two-builders.md measured builders waiting 12 to 112 minutes, mostly
behind full commit hooks. Selected commit sections reduce that cost; slots let short gates share
the PC while keeping heavy pushes alone.

## Decision

The legacy pipe is the door. With no slot file it is held for the whole run. A valid machine file
records N and the U2 tip; every admission attempt reads it under the door. In slot mode hooks,
cuts, direct self-tests and WSL runs take one slot and release the door. A push or release takes
the push flag, door and every slot. Later one-slot requests wait behind a pending push.

The lock is on by default; `DESKPOST_GATE_SERIAL=0` switches off one run and its descendants for
measurement. Waiters see a changing queue with holder pid and process start identities. Finished
waits go to a bounded 1 MiB waits file; a failed write warns. The file lives outside checkouts and
Libraries, beside the slot setting in the machine's gate folder.

Only `node kernel/test/gate-lock.ts --set-slots <N> --u2-tip <sha40>` or `--set-slots off` changes
the slot file, after draining holders and pending pushes. Nobody edits or deletes it by hand.
The orchestrator activates N = 2 only after checking all gate-running checkouts are at or after
U2, no unit is mid-run on older code, the BASE check and documents have landed, and a read-only
census shows no gate work. N stays at 2 until `host-trial-n-seats`, built after the side-by-side
test, supports more. While slots are configured, each Kickoff header names its full base and
`kickoff-check` refuses a base that is not at or after the recorded U2 tip.

## Consequences

Mixed code versions are unsafe in slot mode: older code cannot see slot holders. The mandatory
switch-over checks and the BASE refusal fence that boundary. A push costs the other builder one
wait of about 20 minutes, counted separately in the plan's acceptance rather than against the
under-ten-minute target for waits behind other gates. Queue and wait records make that cost
visible. Rollback through `--set-slots off` must finish before a checkout returns to older code.
