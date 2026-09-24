# Model Division of Labor

How Library work is split between the Librarian (Claude, in the Claude Code session) and a
delegated CLI agent. Read this before delegating, and read [AGENTS.md](../AGENTS.md) to see what
the delegate is told on its side — one file, read by every delegate, which is the cheapest
portability available and the reason a harness swap costs a config change rather than a rewrite.

> **Retired 2026-09-19 — the Reasonix and DeepSeek Harness delegate lines have left the code.**
> Their helpers, config and gate check are deleted; ADR-0004 and the dated notes keep the reasoning.

Codex is the one delegate:

| Delegate | Driven by | Billing | Status |
| --- | --- | --- | --- |
| **Codex** | `codex exec` | flat subscription, hard weekly window | the default builder |

## What is actually being optimised

The objective is neither "minimise tokens" nor "minimise spend". It is to keep **the Librarian's
context** from becoming the binding constraint on a week's work.

**Codex costs meter.** A token spent there is free until the weekly window is exhausted, and then it
is unavailable at any price. `tools/Get-MeterStatus.ps1` is step 0 of its preflight precisely because
the answer can be *don't delegate*. When the window is spent the work comes back to the Librarian or
waits — there is no second delegate to route it to, and that is the whole cost of the retirement.

That reframes delegation as a **call-cost** question rather than a capability question. The
delegate is a tool the Librarian calls, not a second Librarian. When a call is made, the
Librarian's meter is charged for exactly two things:

- the prompt written to set the call up, and
- the report read when it returns.

Everything between those two points — the file reads, the failed attempt, the retry, the test
output — is invisible to the Librarian's context. **Delegation is therefore a return-value design
problem.** A call that hands back four hundred lines of diff is expensive. A call that hands back
`PASS · 3 files · stat` is nearly free, and buys exactly the same work.

## The four calls worth making

**1. Read-and-summarise.** Point the delegate at `raw/<project-slug>/<source-batch>/` and take
back a synthesis. The Librarian never loads the source material at all. Given how much Library
work *is* reading raw material, this is the largest single lever available — larger than
delegating code. The synthesis still has to be checked against the cited pages before it becomes
a Notebook article; a summary is a claim, not evidence.

**2. Gate-and-fix.** "Run `tools/Invoke-LibraryChecks.ps1`, fix what fails, report the final
summary line and `git diff --stat`." The edit→test→edit loop is what destroys a context window,
because every iteration's output stays in the transcript permanently. Handing over the whole loop
and taking back one line is the difference between a large session and a small one.

**3. Build-from-spec.** A frozen spec in, a diff and a check result out. Cost is dominated by the
return value, so the verification ladder below matters more than the spec length.

**4. Resume, don't re-spec.** A fresh session makes the Librarian rewrite context already paid
for, on both meters. Resume the existing thread and write a sentence instead.

## What stays with the Librarian

Not because the delegate reasons less well — the record shows otherwise — but because these are
short-context, high-judgment, or structurally unavailable to a process outside the harness:

- **Desk, Book, and Project operations.** The validated reader and the Desk guard are Claude Code
  hooks and MCP servers. They do not exist in the delegate's process.
- **Shared-collection writes.** Same reason, and the consequences are durable. See the boundary
  note below.
- **Design decisions, arbitration, and playbook-gated operations** — publishing, refresh,
  triage, archive, reset, wiki import. Each has its own approval in
  [Librarian Operation Playbooks](librarian-operation-playbooks.md).
- **Reader-facing voice.** The delegate drafts; the Librarian edits for voice.
- **Every commit.**

## Verify by gate, not by reading

Re-reading the delegate's full output charges the Librarian's meter for work already paid for on
the other. Climb this ladder only as far as it needs to go:

1. `tools/Invoke-LibraryChecks.ps1` — the suite is the acceptance test. `FAIL` stops everything.
   **A suite that stops producing output is a failure too, and a timeout is not a `FAIL` line.**
   Compare against the committed baseline's check count and wall clock: 267 checks in 6 seconds
   became 242 seconds and zero bytes, and rungs 1 and 2 both read clean while it happened.
   Timing is evidence, not noise.
2. `git status -sb` and `git diff --stat` — scope check. Anything outside the spec's stated paths
   is a finding on its own.
3. Targeted read — only files under `tools/`, `.claude/`, or `internal/`, or any file the gate
   flagged.
4. Full diff read — only when the gate failed in a way the stat cannot explain.

A delegate's own report is advisory at every step. The gate is the evidence.

## Scoping a delegated run

There are two Codex roles. The trusted interactive Codex Librarian loads the project's
`.codex/config.toml` and `.codex/hooks.json` -- **both only once that folder is trusted in
`$CODEX_HOME/config.toml`, and both ignored in silence until it is** (measured 2026-09-22; record in
[Hook-Enforced Boundaries](hook-enforced-boundaries.md)). Its Basic Memory calls pass through the same Desk
guard as Claude, so it can read open Books and Projects through the validated reader and maintain
an open active Project Hub. A non-interactive build delegate does not need shared content and has
no user present to approve consequential work, so launch it with the shared servers switched off:

```
codex exec --sandbox workspace-write --dangerously-bypass-hook-trust -c mcp_servers.basic-memory.enabled=false -c mcp_servers.validated-book-reader.enabled=false
```

This is role separation, not the configuration for an interactive takeover. Never use an
unguarded harness for a shared-collection write.

`--dangerously-bypass-hook-trust` is not optional here. Codex records hook trust per `CODEX_HOME`
and skips an untrusted hook silently, and `exec` has no review with which to earn trust -- so
without it the delegate runs with no Library guard and nothing reports the absence. Measured
2026-09-08 on codex-cli 0.153.4; record in
[Hook-Enforced Boundaries](hook-enforced-boundaries.md).

## When the delegate is unavailable

**Nothing in the Library depends on the delegate.** No tool, hook, check, or reader path calls it;
`CLAUDE.md` does not mention it. If Codex vanished permanently every check would still pass and
every helper would still run. The degradation is *slower and more expensive*, never *broken*. Say
so plainly rather than treating an outage as a crisis.

There is no automatic failover, and there should not be a silent one — absorbing a delegated call
means paying the meter the delegation existed to protect. Four modes have actually occurred, and
they want different responses:

1. **Out of window.** `tools/Get-MeterStatus.ps1` answers this *before* handing off, which is why
   it is step 0 of the preflight. Read its `used_percent` together with `reading_age_minutes`: the
   figure is last-known, and it only refreshes when Codex runs. Once the window is gone it is gone
   for the rest of it — stop planning around delegation for the session rather than retrying.
2. **Died mid-run.** The delegate is told to leave the tree dirty and report; a killed process
   reports nothing. Salvage with `git status -sb` and `git diff --stat` against the spec's declared
   paths, then the gate. Anything outside those paths is a finding regardless of why it stopped.
3. **Unreachable from the harness.** The launch itself is refused — a permission classifier, a
   missing rule, a bad flag. Costs nothing but a round trip, and the fix is usually *less*
   privilege rather than more. Do not route around the refusal by delegating the blocked edit to
   the delegate: it is the same principal problem `AGENTS.md` exists to name, and the absence of a
   guard in that process is not permission.
4. **The guard is down, not the delegate.** The classifier that vets local commands can be
   unavailable while Codex works perfectly — so the work lands and cannot be verified. Read-only
   tools still function. Hold the commit: a delegate's report is advisory, and committing on it
   spends the one credibility check the ladder exists to provide.

**Verify flags before launching, not after.** Every launch failure in this workflow's first real
session came from inferring a flag from surrounding prose instead of reading `--help`. `codex exec`
and `codex exec resume` do not take the same options — `resume` accepts neither `--sandbox` nor
`--cd`, so its sandbox goes through `-c sandbox_mode="workspace-write"`, and its options must
precede the session id. It *does* accept `--dangerously-bypass-hook-trust`, and a resumed
delegate needs it for the same reason a fresh one does — without it the resumed run is the
unguarded surface again. Verified against codex-cli 0.153.4 by reading `codex exec resume
--help`, which is the rule this paragraph is about. A bad launch is cheap for the delegate
and expensive for the reader, because each one costs a round trip.

**The Codex meter itself has two parsers, and as of 2026-09-05 they are checked against each other.**
`tools/Get-MeterStatus.ps1` is step 0 of the preflight; `~/.claude/statusline.sh` renders the same
window in the reader's terminal, which is what the reader actually looks at before deciding whether
to delegate. Both read the same rollout records, in two languages, by decision — the status line
runs on every render and cannot afford a PowerShell spawn. **Nothing compared them, and they had
drifted.** The status line matched the substring `"primary":{"used_percent"` anywhere in a rollout
and took the last hit, so a session that merely *quoted* a rate-limits blob — pasting a spec into
Codex is enough — was rendered to the reader as a live meter. Its own comment called that matching
"structural" because it was narrower than a bare `rate_limits` search; narrower is not structural.
`Get-MeterStatus.ps1` had guarded that exact decoy since 2026-08-18 and says so in its self-test.
The status line now runs a `jq` filter mirroring `Get-RateLimitsFromRecord` step for step, and
`meter.parsers-agree` drives **both real parsers** over one fixture rather than reimplementing
either — pinning the expected value as well as their agreement, because two parsers drifting the
same way would agree and still be wrong. The check fails on the substring matcher it replaced.
Note what this cost to find: the defect was latent, not firing, so no reading was ever visibly
wrong. A second parser is a liability the moment nothing compares it to the first.

**A test that passes for the wrong reason is not a passing test.** Two instances, one day apart,
and they are the same mistake wearing different clothes. The first delegated build shipped twelve
passing tests over fixtures written to match the implementation rather than the real
data, and the helper found nothing in eighty-nine real files. Climb to rung 3 for anything under
`tools/` and *run it against real input once*. The gate proves the code does what its fixtures say;
only real input proves the fixtures were right.

The second, on the retired Reasonix line: probing whether its `deny` rules bound by asking it to
run `git tag`. It refused — citing `AGENTS.md` boundary 2 by number and quoting it — and the probe
proved nothing, because every rule in that delegate's own config was also stated in `AGENTS.md`,
so **compliance masked the mechanism**. Only a rule forbidding something no instruction covers
could tell the two apart. When testing a guard, make sure the thing you are testing is the only
thing that could produce the result.

## Anti-patterns

- **Reading files, then delegating them.** Pays both meters for the same context. If the delegate
  is going to read it, the Librarian must not.
- **Delegating under roughly twenty lines.** The prompt costs more than the edit.
- **A fresh session per follow-up.** Re-establishes context already bought.
- **Asking for the full diff back.** Undoes the entire trade.
- **Delegating a decision.** Writing the spec is where the design happens; if the spec cannot be
  written, the work is not ready to delegate.
- **Changing config mid-session.** It invalidates the prefix cache and the next turn pays full
  price for the whole context — observed as a ~20× jump on one turn. Settle the
  configuration, then work.

## Where the balance lands

There is no target percentage. Route reading, looping, and volume to the delegate; keep deciding,
arbitrating, and Desk work with the Librarian. An even split falls out on its own, because the
phases carrying the volume are the delegable ones.

As a signal rather than a rule: through a build stretch, roughly one Librarian turn per three to
five delegated calls. Through a design stretch, all Librarian — and that is correct, because
design turns are short and cheap.
