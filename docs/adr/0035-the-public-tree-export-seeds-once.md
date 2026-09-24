# ADR-0035: The public tree export seeds a repository once, and never updates one

**Status:** accepted
**Date:** 2026-09-20
**Effective from:** Phase B of `PLAN-public-release.md` (step 14, `tools/Export-PublicTree.ps1`)
**Supersedes:** nothing. It settles a question ADR-0031 left implicit.

## Context

`tools/Export-PublicTree.ps1` copies an allowlist of product paths into a staging directory, scans
it, and runs `git init` plus one commit. Because it initialises every time, every export is an
unrelated history, and pushing one over an existing repository is a forced replacement of everything
that was there.

That was harmless while nothing had been published, and it stopped being harmless the moment
something was. During the work to get `v0.1.0` right, the export was run and force-pushed twice.
Nothing in the tool, its help, or any record said it was meant to run once — and a force-push over a
published history breaks every clone and every fork.

ADR-0031 already fixes the *seed* at one commit and routes every later change through ordinary
commits: a pull request reviewed on GitHub, merged at the private origin, carried out by the mirror.
What no record answered was the interval. Between the seed and the migration of step 22, the program
is still developed in a separate workspace, and nothing said how a change made there should reach
the public repository. Re-running the export is the obvious move, and it is exactly the destructive
one.

## Considered options

**(a) The exporter seeds once, ever.** After the seed, a change reaches the public repository the way
ADR-0031 already routes every later change. The interval is real, is a known two-homes condition,
and ends at step 22.

**(b) The exporter commits into the existing history** instead of initialising. Rejected, and for a
reason sharper than "more code". It looks non-destructive, which is its danger: a bulk sync from a
workspace that has never seen a pull request merged at the origin would carry that merge's absence
in as an ordinary commit and **silently revert it**. That is worse than a force-push, because a
force-push is loud and this is not.

**(c) Bring the migration forward** so there is no interval. Cannot run: step 22 depends on steps 20
and 21, and neither is built.

## Decision

Option (a). The exporter runs **once per public repository, ever**, and refuses its own second
execution.

The guard is bounded by what the tool can actually see, which is worth stating because the obvious
formulation cannot be implemented. "Refuse a destination whose repository you did not create" is
impossible here: the tool never touches a remote at all. It stops at a staging tree with one commit
and no remote, and the destructive act happens later, in a hand-typed push. So what it records and
refuses is its own seeding. `internal/public-tree-seed.json` holds the destination, commit, date and
every exported path with its SHA-256. Its presence refuses a second execution; `-Preflight` stays
open, because it copies nothing. An unreadable record fails **closed** — a guard that cannot answer
is not an absence of one.

**The refusal is also the drift report.** Somebody re-running the export is asking how to get their
changes out, so refusing without answering that question would send them looking for a way around
the guard. The refusal names the allowlisted files that have changed since the seed, and
`-DriftReport` gives the same list read-only.

## Consequences

- The first workspace was seeded before the guard existed, so its record was backfilled **from the
  artifact** — the staging tree actually pushed — rather than from the workspace as it stands today.
  The stored hashes are therefore the published bytes, which is why the first drift report measured
  real change (227 of 229 unchanged) instead of a vacuous all-clear. A record backfilled from the
  current workspace would have reported no drift and meant nothing.
- The original `plan_id` of that seed cannot be recovered, and is recorded as unrecoverable rather
  than invented.
- The seed record is gitignored and is not on the export allowlist, so it neither commits nor
  exports. A clone of the public repository therefore carries no seed record and would consider
  itself unseeded, which is correct: it is a different repository.
- This rule is recorded as an ADR rather than only as a step in the plan **because the tool ships and
  the plan does not.** `PLAN*.md` is denied by the public tree allowlist and by the identity scan's
  path filter both, so a contributor who meets the refusal would otherwise find no statement of why
  it exists. A rule enforced in public needs its reasoning in public.
