# ADR-0040: A POSIX workspace is an absolute path, bound to the binary

**Status:** accepted
**Date:** 2026-09-23
**Effective from:** Phase D of `PLAN-public-release.md` (S20's clean-VM install; S42)
**Relates to:** [ADR-0036](0036-a-direct-install-registers-its-guards-from-library-init.md) (what `library init`
registers) and [ADR-0038](0038-an-installed-library-is-rooted-at-its-current-link.md) (the program root those
registrations name)

## Context

S42 ran the Linux release for the first time, in a clean WSL2 Ubuntu 24.04 distro with no Windows drives, no
interop and no PowerShell. It installed and ran, and then nothing that needs a workspace worked:

- **Every POSIX path was refused.** `library init`, the workspace resolver and the guards' path allowlist
  accepted only a drive-rooted Windows path (`X:\...`), so `/root/desk` was "not a drive-rooted local path".
  The unported guards failed closed -- every call denied -- which was the safe direction and still unusable.
- **The registry had no home.** It fell back to `USERPROFILE`, which Linux does not set, so it became
  `.library` relative to whatever directory the command ran in.
- **A POSIX `init` registered guards that cannot start.** Ten `powershell.exe` Claude hooks, a `powershell.exe`
  reader and four `powershell.exe` Codex hooks. A Claude hook that cannot start does not block, so the workspace
  was unguarded -- and `library doctor` passed `workspace.guards-registered` ("10 hook registration(s)
  resolve"), because it asked only whether each named `.ps1` exists.

## Decision

**On macOS and Linux a workspace root is an absolute `/` path**, resolved by `path.posix`. A leading `//`
(which POSIX leaves to the implementation), a NUL and -- in a root -- a backslash are refused; the guards read
a backslash as a separator, so a root spelled with one could not be judged by prefix. A guarded TARGET reads a
backslash as a separator and is placed. Every comparison stays case-insensitive, as it is on Windows, so a
guard errs toward denying. The registry is `$HOME/.library`.

**On a host with no PowerShell, `library init` binds the workspace to the compiled kernel**:
`"<program>/bin/library" hook <verb>` for each hook the kernel has ported (the three Shelf and Basic Memory
guards, the Desk context and the settings guard), rendered from the program's own registrations with their
matchers, timeouts and messages; `bin/library mcp serve --state-directory <workspace>/.claude` as the reader,
in `.mcp.json` and in `.codex/config.toml`; and the Codex hooks likewise. The hooks with no port -- the
playbook, the search-hit reminder, the compaction and seat-start hooks, all optional -- are left out rather
than registered as commands that cannot start. On POSIX a registration is recognised by its verb as well as its
script, and **`doctor` fails a hook, and warns of a reader, this machine cannot start.**

**Windows is unchanged**: its root form, its sentences and its registrations are the PowerShell oracle's, and
the matrix still compares them there.

## Consequences

- No PowerShell oracle runs on POSIX, so the POSIX branches are judged by kernel self-test sections 19 (roots
  and placement; its pure half runs on every host) and 21 (the bindings START: the registered shelf guard, run
  through `sh`, denies a closed Book, and the registered reader answers `tools/list`), compiled for Linux and
  run in the clean distro against the release binary.
- Conceded: a symbolic link is not followed, as a junction is not on Windows; `$HOME/x` and `~/x` in a shell
  command are not expanded by the shell guard, as `$env:` is not on Windows; and whether Codex runs a POSIX
  hook command through `sh` as Claude does is unmeasured until Codex runs there.
- Left open here and decided the same session in
  [ADR-0042](0042-a-plugin-guarded-workspace-a-posix-remedy-and-a-held-seat.md): a plugin-only workspace, whose
  binary-backed registrations both arms read as absent; the kernel's remedies, which named PowerShell helpers a
  POSIX host cannot run; `library seat start` and `status`, unported; and a seat claim that excluded nothing off
  Windows.
