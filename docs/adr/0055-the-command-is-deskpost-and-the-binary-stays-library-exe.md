# ADR-0055: The command is `deskpost`, and the binary stays `library.exe` through 1.x

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S54, `PLAN-install-onboarding.md` step 1)
**Supersedes:** the unexecuted consequence "CLI `deskpost`" of [ADR-0032](0032-the-family-name-is-deskpost.md), which
1.0 shipped as `library`
**Relates to:** [ADR-0038](0038-an-installed-library-is-rooted-at-its-current-link.md) (hooks name `current`),
[ADR-0045](0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md) (remedies an installed kernel says),
[ADR-0046](0046-a-compiled-windows-init-registers-the-kernels-own-hooks.md) (the kernel's own hooks)

## Context

ADR-0032 named the product Deskpost and its CLI `deskpost`. 1.0 shipped the command as `library`, with the binary at
`bin\library.exe`. Every Library's hooks and reader registration name that binary through `<install>\current`, and
`init` refuses a reader command it did not write (`init.ts:360-372`). Eric's first run as a new user met a product
called Deskpost and a command called `library`, with nothing on screen joining the two.

Renaming the file on disk now would break two things. Rolling back to 1.0 would leave every Library's hooks naming a
binary 1.0 does not have, so the guards would fail open. And every `.mcp.json` would need a migration that `init`
itself refuses.

## Decision

- **The command a reader types is `deskpost`.** A release on Windows puts two shims in `<install>\bin`:
  `deskpost.cmd` and `library.cmd`. Both hold the same line, running `current\bin\library.exe`. `install.sh` adds a
  `deskpost` link beside `library`. It leaves an existing `deskpost` that is not its own link alone, and says so.
- **`library` stays a quiet alias through 1.x.** It is kept working, but it is not what the screens and docs teach.
- **The binary stays `bin\library.exe` (and `bin/library`) through 1.x.** Hooks and the reader registration are
  unchanged: they name `<install>\current\bin\library.exe`, as 1.0 writes them. So:
  - rolling back to 1.0 keeps every Library guarded;
  - no `.mcp.json` migration is needed;
  - a 1.0 Library upgrades by switching `current`, and nothing else.

  Renaming the file on disk is a 2.0 decision.
- **The user-visible name is `deskpost` wherever a remedy leaves an installed kernel.** The kernel's sentences and
  its rewrites of PowerShell helpers say `library <verb>`, which is the oracle's word. On the hosts ADR-0045 already
  rewrites for (POSIX, and a compiled kernel on Windows), `library <verb>` is said as `deskpost <verb>`. Only a verb
  the kernel has is renamed, so a path such as `bin/library` or `library.exe`, a word such as `library-dev`, and the
  Library itself are never touched. A kernel run from source on Windows keeps the oracle's sentences, which the
  acceptance matrix compares. The usage text says `deskpost`.
- **Doctor checks the program as well as the Library**, in a `program_checks` list beside the workspace checks:
  - `program.command-resolves`: on an installed program, `deskpost` must resolve to this install's shim. A shim
    that resolves elsewhere fails, naming what it runs. One that is not on PATH fails too, unless the install's
    receipt records `-NoPathChange`, which makes it a warning. A checkout run from source reports it skipped.
  - `program.assistant-present`: a warning, never a failure, when neither Claude Code nor Codex is found, looked for
    by the resolver `seat start` uses.
- **Doctor judges only Deskpost's own registrations, read as invocations** (PLAN-install-onboarding.md #15, F16):
  - A hook or reader entry is read as the process its harness starts. That is exec form's `command` plus `args`,
    or the command line tokenized quote-aware (double quotes, single quotes with `''`, Codex's leading `& `). Until
    1.1 it was split on whitespace, so a program path holding a space was never seen.
  - An entry is Deskpost's when it runs `<…>/bin/library[.exe] hook|mcp …`, or runs one of Deskpost's own scripts
    with `-File`. A reader's own hooks and servers are counted, and never flagged.
  - A kernel binary that is missing fails, as before. One the Library's own files register that belongs to a
    **different Deskpost program** from the one running doctor also fails, naming both. So does one that names this
    install's own `versions\<v>` directly, which an upgrade would leave behind (ADR-0038). An enabled plugin's
    registrations are the plugin's own install, and are judged only for presence.

## Consequences

- The acceptance matrix approves `program_checks` as the kernel's own (delta `kernel-doctor-checks-the-program`),
  and still compares every workspace check. Its six `checks` rows are green.
- Kernel self-test section 23 holds the rename's reach: a verb renamed, a path or a word not, and the oracle's host
  untouched. Section 47 judges the tokenizer, owned-only judging, another program, a version folder, and the
  command-resolves check against a planted install.
- The PowerShell oracle's `Invoke-LibraryChecks.ps1 -WorkspaceOnly` still reports a reader's own missing `.ps1` hook.
  No matrix fixture carries one, so the arms still agree. The oracle is not changed to match.
- The Codex reader in `.codex/config.toml` is still checked for presence only. Parsing its TOML command is not done
  here.
