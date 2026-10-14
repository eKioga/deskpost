# Building software with seats

You can use seats to develop a project with one assistant or several. Keep its source in a
working tree outside the Library. Its Project Hub holds the current state and links to the
work you approved. The `developer` and `planner` templates give new seats a starting purpose;
they do not grant Git or release authority.

## Four rules to start with

**Give each unit one Kickoff.** Write a page with the outcome, what it OWNS, what it must STAY
OUT OF, its CHARTER, its stop rule and the handback it owes. Read it before starting and give
one approval bound to the page and its content hash. When that unit ends, the builder hands
back and stops. A letter or a list of ideas never starts the next unit.

**Assign three roles.** Your planner keeps the backlog and writes Kickoffs. Your builder
implements one unit on its own branch and never merges as a builder. Your integrator combines
finished units, checks the result and makes only the push you authorized. Name one integrator
at a time, even when the same seat builds and integrates. With one seat you can assign these
roles at different times.

**Decide within the approval and record the choice.** An open question inside the CHARTER is
for the builder to decide and explain in its handback. Anything outside it parks with a
reason. The builder neither waits for routine choices nor widens the work. Deskpost's
[Decide and record](https://github.com/eKioga/deskpost/blob/v1.4.5/docs/dev-session-loop.md#work)
is a worked example.

**Have a second reader inspect sensitive changes.** Before a release or any credential step,
someone else reads the sensitive diff and the combined final result. Include guards, hooks,
launch permissions, secrets, release tooling and the prose that controls them. With one
harness, you can be that reader. Record the base, candidate revision, paths, findings and
what became of each. A changed covered path needs another read.

No permission level is a default: you choose each seat's sandbox and approval flags for your
environment.

## When you use two builders

Give each builder its own working tree and unit branch. Put the files and newly allocated
identifiers in OWNS before work starts. Shared files wait their turn unless the planner
explicitly gives each unit separate additions. A builder parks a row that needs a file it
does not own.

Build integration on `int/<kickoff>` from a pinned remote base. Merge the finished tips in
the recorded order, check the combined tree and verify the remote base again before a
fast-forward push. Resolve only independent additions with distinct planner-allocated
identifiers, kept whole in ascending order. Abort any other conflict and charter a
reconciliation. `git merge-tree --write-tree` diagnoses current tips; it writes Git objects
but no refs or index, and cannot predict edits still to come.

## When you use usage meters

Usage is advice about where to put work. If you have Orca, its `orca account list --json`
reports weekly use, reset times and update times; check that its account matches the seat.
An old, missing, refused or expired reading is unknown. Without Orca, say unknown; a Codex
session log can fill only Codex's reading. Deskpost's
[usage rule](https://github.com/eKioga/deskpost/blob/v1.4.5/docs/dev-session-loop.md#assigning-work-by-usage)
keeps its thresholds in one place. You can override the planner's advice.

## When you use fixtures

Ordinary tests use fake homes and their own workspace and registry. Never copy real login
files. Only a named live proof that needs a signed-in assistant uses your real home and
login, with the fewest tools it needs. It changes no home configuration unless separately
approved, restored and verified by path and hash or a sanitized comparison.

The program that makes a fixture removes it in `finally` under its temp folder. After an
abnormal end, name any leftover path and the kind of material in it. You or a later run of
that same program remove it; do not plan a separate shell delete or retry a refused cleanup
another way. The bounded Codex delete-rule proof is unverified; this fixture recipe is its
fallback.

## When you use Codex seats

Deskpost 1.4.4 adds `--no-daemon` on every Codex launch so separate seats do not borrow a
shared daemon's identity. Its tested simultaneous-seat resume used `exec resume` only;
interactive (TUI) resume is unproved. `codex queue` waking is also unverified: paste the
handback line into the planner's session yourself.

Choose an assistant with `deskpost seat settings <seat> --assistant codex`. Preview flags
with `deskpost seat settings <seat> --flags codex --preflight -- <flags>`, then approve that
preview and apply the same flags with its exact `--plan-id`. For example, `-a never -s
danger-full-access` is one choice: it removes approval prompts and filesystem confinement,
so the assistant can act broadly without asking. Choose it only for an environment where
you want those consequences. A refused command still parks; it does not authorize a bypass.

Signed-in skill discovery without copied logins is unverified in K1b. Use the release's
upgrade rehearsal as the fallback; a source-fixture observation does not certify a release.

## When you use an assistant as the second reader

Deskpost's two-harness setup requires the other harness to read sensitive work. Currently
only the Claude Code reviewer profile passed: a fresh Claude session can read Codex-authored
work from a staging folder containing clean review files. As planner, write
`claude-settings.json` with `{"permissions":{"allow":["Read","Grep","Glob"]}}` and
`empty-mcp.json` with `{"mcpServers":{}}` in your fixture folder. Run this profile in the
staging directory through subprocess argv, keeping the empty setting-source argument:

```text
<claude-executable> -p --safe-mode --restricted --disable-slash-commands --setting-sources "" --tools Read,Grep,Glob --strict-mcp-config --mcp-config <fixture>/empty-mcp.json --settings <fixture>/claude-settings.json --permission-mode dontAsk --output-format stream-json --verbose --include-hook-events --no-session-persistence
```

Replace only the executable and fixture paths with yours. The tools exposed in the proof
were Read, Grep and Glob; no user skills, plugins, hooks or MCP servers loaded. Its limits:
Grep/Glob outside the folder, links and aliases untested; the child inherits its environment,
but no tool can read it; built-in telemetry on. Stage no secrets.

A Codex reviewer profile is not yet proven. In Deskpost, the planner steers sensitive work
to Codex when possible. A release carrying Claude-authored sensitive commits records the
reader's written acceptance of the gap before any credential step. This one-way rule ends
only after a chartered Codex profile passes all five k1e-r2 criteria. Review covers the whole
candidate's sensitive diff, how its commits combine, and finding dispositions. It does not
gate a private source push.

## When you use attempt pages and gates

An attempt page keeps the approved Kickoff hash, yes time, branch, base and session identity.
Numbered standing answers let you give routine choices in advance. A stall log names what
stopped a step, whether it came from the product or the harness, and what remains parked.

Choose gates that catch the unit's defects. Deskpost uses targeted test sections while
working, the pre-commit hook on each clean staged cut, and a full gate before a chartered
private push. Record each commit and its hook result together. Its
[development loop](https://github.com/eKioga/deskpost/blob/v1.4.5/docs/dev-session-loop.md)
shows the full procedure; you need only the extras your project uses, but an adopted extra
brings its safeguards with it.

## Starter Kickoff

```markdown
# Build <unit>: <outcome>

author_seat: <planner>; revision: r1; roles: builder <seat>, integrator <seat or none>

WHY NOW: <why now; usage advice if used>
SIZE: <time budget and gate minutes; stop rule: the time or evidence boundary, then hand back what is done>
OWNS: <files and new identifiers, or "none other open">
STAY OUT OF: <other work, real homes, credentials, release unless separately chartered>
WHERE THINGS STAND: <working tree, unit branch, pinned base, current state>
MERGE: <finished tips and order, integration branch and base, or none>
ROWS: <numbered rows, in order; each ends "Done when: <the check that proves it>">
COMMANDS: <command families>
CHARTER: <exact commits, fixtures and any private push approved by the reader>
NOT CHARTERED: <what the yes does not cover>
RULES: <written out in full, never "as the last Kickoff's">: decide inside the charter and record it; park
anything outside it
STANDING ANSWERS: <numbered choices the builder may decide>
OPEN: a fresh session; read the page, verify the base, show title/author/revision/hash/charter, take one yes
CLOSE: handback with each row against its "Done when", checks, decisions, stalls, a "Needs you" list and the
next recommendation; write its letter to the planner, supply the reader's paste line, then **Stop.**
```

Deskpost's own Kickoffs start from `docs/kickoff-template.md`, and `tools/kickoff-check.mts` checks a filled one
for every section in this order, a `Done when:` on every row, and no pointer to an earlier Kickoff.
