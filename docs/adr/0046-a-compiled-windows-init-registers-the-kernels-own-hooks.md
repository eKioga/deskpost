# ADR-0046: A compiled Windows init registers the kernel's own hooks

**Status:** accepted
**Date:** 2026-09-25
**Effective from:** release 0.2.2 (S48, the reader's ruling)
**Relates to:** [ADR-0045](0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md) (an installed
kernel says its own remedies; the plugin is opt-in), [ADR-0044](0044-basic-memory-is-optional-and-the-public-install-is-local.md)
(a compiled kernel serves a local workspace's reader)

## Context

ADR-0045 made the plugin opt-in, so the default route's guards are the ones `library init` registers. On Windows
init registered the program's PowerShell guard scripts even when the program was a compiled release; only a POSIX
host was given the kernel's own `hook <verb>` registrations (S42). ADR-0045's remedy rewrite lives in the kernel's
hook verbs, so on the default route it never ran: S47's closed-Book denial in a fresh Windows Sandbox on `v0.2.1`
still named `tools/Set-VirtualDesk.ps1`.

## Decision

**On Windows, when the program is a compiled release -- `<program>/bin/library.exe` exists -- `library init`
registers the kernel's five ported hooks** (`basic-memory-read`, `shelf-read`, `shell-shelf-read`, `desk-context`,
`settings-integrity`):

- for Claude Code in **exec form**, `{ "command": "<program>/bin/library.exe", "args": ["hook", "<verb>"] }`, which
  Claude Code spawns without a shell, because with no Git Bash it runs a shell-form hook through PowerShell, where a
  quoted path runs nothing (S46);
- for Codex as `& "<program>/bin/library" hook <verb>`, because Codex runs a hook through `powershell.exe -Command`
  on Windows (codex-cli 0.153.4, S46), as the plugin's Windows render already does.

**The four hooks with no kernel port stay PowerShell** -- the playbook, the search-hit reminder, the compaction and
seat-start hooks, all optional. Windows has the PowerShell to run them, and S47 measured them working; POSIX, which
has none, goes without them. **A kernel run from source has no binary to name and keeps every guard script.**

**A re-run replaces an earlier release's guard-script block.** What makes a hook the Library's is a path into the
program root, where the kernel registers itself, so the block `v0.2.1` wrote is recognised and rewritten rather than
refused as foreign.

**The matrix records it as one delta, approved by id:** `kernel-registers-its-own-hooks`, on
`workspace.init-creates-marker`, `workspace.init-is-idempotent`, `workspace.init-force-refreshes-managed-sections`
and `workspace.init-leaves-a-workspace-its-checks-pass`, matching only the two hook files and their actions. The
behaviour is judged by the independent row `workspace.compiled-init-registers-the-kernel-hooks`, kernel self-test
section 39, which launches the registered hooks as each harness does against a closed Book.

## Consequences

- A closed-Book denial on a compiled Windows install's default route names `library desk open book ...`, not a
  PowerShell helper.
- A compiled Windows workspace's settings mix two forms: exec-form kernel hooks and `powershell.exe` scripts for the
  unported four. Each port removes one script.
- A reader's existing workspace changes only when `library init` is re-run from a compiled release.
