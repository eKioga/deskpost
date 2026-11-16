# ADR-0092: Bounded commit hooks share three gate slots

**Status:** accepted
**Date:** 2026-11-09
**Effective from:** c133-r2
**Amends:** [ADR-0087](0087-the-machine-gate-lock-is-n-weighted-slots-and-a-push-takes-the-machine.md) and [ADR-0091](0091-an-every-section-gate-takes-the-whole-machine.md)
**Relates to:** [PLAN-build-regroup.md](../../PLAN-build-regroup.md)

## Context

Every-section commit checks take every slot and make the builders take turns. Eric approved
regroup stage 2 with bounded local work and three machine slots. The scheme is judged by using it;
no seed run, comparison, load test or timing study is required.

## Decision

A normal commit hook takes one slot and uses at most two self-test workers, including when its
original selection includes every section. Its estimated work budget is 180 seconds at that
worker count. The existing 120-second reporting budget remains unchanged.

Above the work budget the hook runs the fixed smoke sections, whose reasons live in
`kernel/test/smoke-sections.json`, plus every section whose own self-test text changed and every
new claim-map key. It reports how many sections it ran and left to the runners. Small selections
keep their existing coverage. Type checks, document checks and scans retain their acceptance role.

`tools/section-times.mts write <result.json>...` builds per-section median seconds from passing
runner results. Failed and skipped results contribute no sample. The seed contains no times;
unknown sections use the median of known section times, or the named five-second default when
none is known. The estimate divides total work by workers and is never below the longest section.

The machine has three slots: two builders and the future Windows runner can each hold one.
This replaces ADR-0087's N = 2 and its prerequisite measuring trial. The only configuration writer
remains `node kernel/test/gate-lock.ts --set-slots 3 --u2-tip <sha40>`, which drains all holders
before changing the file. The recorded U2 tip stays unchanged. c133-r2 delegates this switch to
deskpost-codex-dev; deskpost-lead records the handback on its Hub.

Every-section commit comparisons keep ADR-0091's exclusive weight and full selection. Push,
cut and release tiers, and explicit whole-suite runs, retain their existing behavior. This
decision amends ADR-0091 only for normal commit hooks. Lock validation, pending-push priority,
compatibility checks and rollback through `--set-slots off` remain in force.

## Consequences

Local hooks can admit concurrent work without starting three eight-worker suites. A smoke pass
does not certify the deferred sections; runners cover those, and this unit retains its chartered
push tier before landing. Estimated work is a selection policy, not a wall-clock deadline: smoke
and changed-section tests always run to their existing limits. New failures found in use become
fix items rather than reasons to add another measuring round.
