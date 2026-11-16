# ADR-0091: An every-section gate takes the whole machine

**Status:** accepted
**Date:** 2026-11-08
**Effective from:** the release carrying c128
**Amends:** [ADR-0087](0087-the-machine-gate-lock-is-n-weighted-slots-and-a-push-takes-the-machine.md)
**Relates to:** [PLAN-two-builders.md](../../PLAN-two-builders.md)

## Context

Two every-section runs do not fit this PC. On 2026-11-07, s198's commit gate was stopped
by Claude Code for low memory about thirteen minutes in, beside c126's every-section
commit gate. The c126 records `20261108T061709Z-commit.json` and
`20261108T065739Z-commit.json` started with 5155 and 5609 MB free of 31801 MB,
respectively; the latter ran alone. These readings do not establish a memory threshold.

On 2026-11-06, two paired every-section commit runs both failed at the 45-minute
limit, after 2735 and 2769 seconds. Alone, runs take 1340 to 1830 seconds. The evidence
is recorded in `projects/deskpost-desk/notes/2026-11-06-triage-six-reports-gate-and-messages`.
ADR-0087 gave a commit and a cut one slot regardless of the work selected, so N = 2
admitted both heavy runs together.

## Decision

A commit gate selecting every section, including a commit comparison, and every cut
take the push flag, the door and every slot, as a push or release does. Later one-slot
requests wait behind them. Selected-section commits keep one slot. N stays at 2;
direct self-tests and WSL runs retain their existing weight.

The gate passes the exclusive weight explicitly from its selection. An every-section
commit's holder tier says `commit (every section)` (or `commit comparison (every section)`),
while its report tier and record filename remain `commit`. Children inherit a validated
exclusive holder's token. A one-slot token cannot satisfy an exclusive request; its
refusal names the holder's one slot and the requesting gate's need for every slot.

This amends ADR-0087's one-slot rule for hooks that select every section and for cuts.
Its admission, default locking, slot configuration and rollback rules still apply.

## Consequences

A builder's every-section commit waits for the other builder's gate, potentially about
forty minutes before its own checks start. The wait is recorded separately from runtime.
Serialization prevents these two heavy gates from competing for memory; no running gate
is stopped for memory by this policy. There is no memory meter or free-memory threshold.
