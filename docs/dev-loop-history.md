# The Dev Loop: history and limits

Any seat reads this page before relying on something the loop has not proved, or when a rule on
[the builder's page](dev-session-loop.md) or [the planner's page](dev-loop-planner.md) needs its background: what
remains unproved, the loop's limits, and records of how a rule came about.

## What remains unproved

K1 passed code-mode guard enforcement and simultaneous new/resumed Codex seat isolation, but its
resume proof used `exec resume` only. Interactive (TUI) Codex resume is unproved; do not advertise
that result as a TUI proof. The second-reader limits are in ["The second reader"](dev-loop-planner.md#the-second-reader).

K1b has not run. Its bounded delete rule, `codex queue` waking, and signed-in skill discovery are
unverified. Use the fixture recipe for deletion; Eric pastes the handback line instead of relying
on a queue wake; use the release rehearsal for signed-in discovery. A source-fixture observation
does not certify an exact release binary.

## Limits

- Kickoff pages accumulate; pruning is out of scope.
- Headless `claude -p` runs used as sandbox tests may be refused by auto mode ("Create Unsafe Agents"), and on
  other days pass. Try the first run; if it is refused, say the plan needs manual mode or an allow rule, with the
  reader approving each run. Never route around the classifier through another tool or a subagent.
- The seats share one Codex quota. The planner uses Fable or Codex for design and plan reviews as it sees fit, and a
  builder uses either when a Kickoff or its own judgment calls for it (Eric, 2026-10-06; this replaces "Fable is B's
  default reviewer so that Codex quota stays with A"). Before any Codex run, use ["Assigning work by usage"](dev-loop-planner.md#assigning-work-by-usage)
  for the meter reading and say it.
- The harness can still stall a builder on a permission prompt. The COMMANDS section lets the reader widen
  the allowlist beforehand, and the stall log measures what remains.

## The push gate's first run (S68)

**First run, S68 (2026-09-29, at `4004cdc`):** `108 passed, 1 warned, 0 failed, 22 skipped`. The one
WARN is `context.always-on-budget`. The workspace checks that S67 saw FAIL now SKIP with no workspace
attached, as `Invoke-WorkspaceCheck` intends, so no defect was filed.
