# AGENTS.md — the Library

Working instructions for a CLI agent implementing in this repository. Claude Code reads
[CLAUDE.md](CLAUDE.md); this file is the equivalent for Codex and any other agent driven from
outside that harness. If the two ever disagree about a boundary, the stricter reading wins.

[CONTEXT.md](CONTEXT.md) is the glossary and the only authority on what this vocabulary means.
Read it before using *Book*, *Shelf*, *Notebook*, *Project*, *Desk*, or *Holding Shelf* in code,
comments, or prose — these are defined terms here, not loose description.

**Read `.claude/rules/library-development.md` before changing any tool, hook, or adapter.** It is
the authoritative development guidance: the standing rules, the six defect families this codebase
keeps producing, the Book write-lock and journalling contract, and the context budget. This file
summarises the boundaries; that file governs the code.

## Start here

The current development goal is the Shelf's exit ramp. Read
[The Shelf is a staging area, not storage](docs/shelf-lifecycle.md) before planning any Shelf or
archive work — it records design intent stated by the reader that is **not derivable from the
code**, and the absence of which is why the Shelf grew an entrance and no exit.

The `library-dev` Project Hub is the durable source of current development state. When it is open
on the Desk, read it through the validated reader and keep its `Now` section current through exact
Basic Memory writes to `projects/library-dev/...`. When it is closed, ask the reader to open it;
never bypass the Desk with a direct content reader.

## Where things live

`notebook/` volatile working knowledge · `raw/` source material · `output/` requested
reader-facing files · `docs/` durable guidance · `internal/` application-managed records ·
`tools/` PowerShell helpers · `.claude/` hooks, adapters, rules, and workspace settings.

## Hard boundaries

1. **Shared access is Desk-scoped, not globally disabled.** Trusted interactive Codex sessions load
   `basic-memory` and `validated-book-reader` from `.codex/config.toml`; Claude loads the equivalent
   servers from `.mcp.json`. Both use `.claude/hooks/Guard-BasicMemoryRead.ps1` as a `PreToolUse`
   guard. On a fresh session, confirm both servers appear in the tool catalog and that the Codex
   project hooks are trusted. A missing server or hook is a development-environment fault, not a
   reason to work from pasted Hub state.

   Read Book and Project content only through the validated reader. Direct Basic Memory
   `write_note` and `edit_note` are allowed only for exact paths inside an **open active Project
   Hub**; read the exact path back through the validated reader. Direct shared-Book writes and all
   direct `move_note`, `delete_note`, `create_memory_project`, and `delete_project` calls remain off
   limits. Shared publication, refresh, archive, and Project creation use their bounded helpers and
   playbooks.

   Other harnesses that cannot load the guard do not inherit this authority. Disable their shared
   MCP servers or keep them to repository-only implementation work.
2. **Git changes require the reader's explicit request.** By default, leave the working tree dirty
   and report what changed. When the reader explicitly asks Codex to manage the repository, commit,
   or push, first review the complete diff and run the required gate, then make the requested commit
   and push normally. **Codex Desktop must run `git push` outside its sandbox**; when a requested
   commit includes a push, use the escalated route by default rather than waiting for a reminder.
   Never force-push, rewrite published history, create a tag, or discard unrelated
   work unless the reader separately and explicitly requests that exact operation.

   **"Reset" is never a Git request.** In this workspace a reset means the **Library Reset** —
   `tools/Reset-LocalNotebook.ps1`, which rebuilds `notebook/` and clears the Desk and touches no
   repository file. A session rooted here has already read "reset my workspace" as a working-tree
   cleanup and reported the branch clean while the Desk still held two Books and a Project Hub. A
   clean `git status` is never evidence that a Reset occurred — the Desk state and `notebook/` are.
   Route "reset", "start fresh", and "clear my workspace" to the reset playbook, and where the
   reader could genuinely mean repository cleanup, ask them to distinguish **Library Reset** from
   **Git cleanup** rather than taking the destructive reading.
3. **Never put journals, plans, or test evidence in `output/`.** That directory is reader-facing
   deliverables only.
4. **Do not edit `shelf/`, `notebook/`, `raw/`, or `internal/`.** Reader material and
   application-managed records. All four are gitignored — edits there are invisible to review and
   unrecoverable from a checkout.
5. **Anything consequential or destructive takes a preflight, an exact `plan_id`, and one
   approval.** You do not hold that approval. Stop and report instead.

## The gate

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/Invoke-LibraryChecks.ps1 -WorkspacePath .
```

Run it after any change to a tool, a hook, or the reader, and again before reporting done. Paste
the final summary line. `WARN` is acceptable; `FAIL` is not. This suite is the acceptance test —
it is more authoritative than your own reading of the diff, and it is why your report can be
short. A fix without a regression check that proves it stays fixed is a fix that comes back.

**`-Fast` while you work; the full run is a phase gate, and NEVER an interactive wait.** Measured
2026-09-17: `-Fast` is **23 seconds** for 98 checks and is exactly what the pre-commit hook fires,
while the bare command above spawns ~50 helper self-tests as child processes and takes **20+
minutes**. Every static check is registered above the `if ($Fast)` branch and therefore runs in
*both* modes, so `-Fast` answers almost any question worth asking mid-session — including whether a
static check you just added passes. When the full run is genuinely warranted, background it and keep
working; do not make the reader sit through it, and never start either variant merely to orient. On
2026-09-17 a session ran the full suite twice while reading a Project Hub, discarded the first result
to a mis-read JSON property, and cost the reader roughly forty minutes for an answer `-Fast` returns
in twenty-three seconds.

**Codex Desktop runs the full gate outside the sandbox by default.** Several suites launch child
processes or loopback listeners, and a sandboxed run can produce environmental failures that are
not defects in the Library. Small, explicitly known-pure self-tests may run inside the sandbox;
`tools/Invoke-LibraryChecks.ps1` should not. If the outside-sandbox route is unavailable, report the
run as partial rather than treating sandbox failures or skips as product evidence.

**Say which suites you could not execute.** Two suites stand up a loopback HTTP stub and need
`[Net.HttpListener]`, which some sandboxes report as unsupported: `mcp-helpers.boundary-suite` and
`shared.manifest-backfill`. If they cannot start in your environment, your run is not a green gate —
it is a partial one. Name them in your report, and never treat a suite you skipped as evidence for
code you changed. Verified 2026-08-20: a delegated change added assertions to
`tools/Test-McpHelpers.ps1`, reported success without running it, and the host run then failed 1 of
101 on an unrelated ordering fault the delegate could not have seen. Changing a test you cannot run
is allowed; claiming it passes is not.

**The gate is a Windows command, and your shell may not be Windows.** Some harnesses route their
`bash` tool through WSL — a delegated session in this repository reported `pwd` as `/mnt/c/...`,
where this workspace is `/mnt/d/Library` rather than `D:\Library`. If that is your situation,
invoke `powershell.exe` explicitly with a path its own shell understands, and check that the drive
is mounted before assuming the run failed for a more interesting reason. Do not translate the
command into a POSIX equivalent: there is one gate, and a substitute for it is not evidence.

## PowerShell defect families

Named and explained in `.claude/rules/library-development.md`. The first two are linted by
`powershell.defect-families`, which parses the AST — do not sweep for them by hand, fix what it
reports. The last two have no lint and have each bitten this codebase in production.

1. **Case-insensitive operator on a lowercase-only rule.** `-match`, `-notmatch`, `-like` accept
   `Odysseus` against `[a-z0-9]` and write state nothing else matches. Use the `-c` variants.
2. **A pipeline result counted or indexed without `@()`.** A one-item pipeline unrolls to a
   scalar, so `.Count` and `[0]` throw under `Set-StrictMode`.
3. **A list parsed one line at a time.** A wrapped bullet loses its continuation, and on a CRLF
   file a `[ \t]*$` tail matches nothing where `\s*$` would. Parse the item, not the line.
4. **A member collection's aggregate property read without enumerating.**
   `$o.PSObject.Properties.Name` throws on an empty collection under `Set-StrictMode`. Enumerate:
   `@($o.PSObject.Properties | ForEach-Object { $_.Name })`.

Separately, a file-handling convention rather than a defect family: sources are UTF-8 **without
BOM**. Do not round-trip through `Get-Content`/`Set-Content`. Use
`[System.IO.File]::ReadAllText()` and
`[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))`.

## Always-on context budget

`CLAUDE.md` is capped at 900 words and the whole always-on surface at 1100, enforced by
`context.always-on-budget`, which warns at 90% of either ceiling. Run the check for the live
figures rather than trusting a number written here. `CLAUDE.md` sits deliberately close to its warn
line, and that margin is accepted rather than relieved:
[ADR-0017](docs/adr/0017-the-always-on-margin-is-accepted-disciplines-do-not-move.md) records why,
and what to do when it is crossed. A `warn` blocks no commit — only a `fail`, at the ceiling itself,
does.

Do **not** add words to `CLAUDE.md`, to any `description:` in `.claude/skills/*/SKILL.md`, or to a
`.claude/rules/*.md` without `paths:` frontmatter. Durable guidance belongs in `docs/`, and
development guidance in a path-scoped rule — both load on demand and cost nothing at launch.
Never use `@path` imports; they move words out of the count without moving any of the cost.

## Reporting back

Keep the return value small — it is read by a model with a metered context window.

- Files changed: one line each, path plus what and why.
- The check suite's final summary line, verbatim.
- Any deviation from the spec, with the reason.

Do not paste full diffs, full test logs, or file contents. If something genuinely needs a close
read, name the path and line range and say why.
