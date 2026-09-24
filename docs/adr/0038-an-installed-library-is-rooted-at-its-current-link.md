# ADR-0038: An installed Library is rooted at its current link

**Status:** accepted
**Date:** 2026-09-22
**Effective from:** Phase D of `PLAN-public-release.md` (step 28, the installers; S30)
**Relates to:** [ADR-0028](0028-the-kernel-is-typescript-shipped-as-one-binary.md) (the binary) and
[ADR-0036](0036-a-direct-install-registers-its-guards-from-library-init.md) (the hooks `library init`
registers)

## Context

`install.ps1` and `install.sh` place each release in `<install>/versions/<v>` and switch a shim onto
it. A compiled kernel finds its program one directory above its own executable
(`kernel/src/programroot.ts`), so the program root **was** `versions/<v>` -- and every hook script and
reader-adapter path `library init` writes into a workspace is under the program root.

So the program root moved on every upgrade. Measured 2026-09-22 (S29): `library init` over a workspace
another program root initialised refuses, "already registers hooks the Library did not write", and the
PowerShell original refuses identically when run from the installed tree. Every upgrade would have left
`library init --force` refusing and the workspace's hooks naming the old version, which break the day
it is removed. That refusal is not a defect: it is what protects hooks a reader wrote.

## Decision

**The installers keep `<install>/current` as a link onto `versions/<v>`** (a junction on Windows, a
symlink elsewhere), the shim runs `current/bin/library`, and **a compiled kernel reports `current` as
its program root whenever `current` resolves to its own version directory.** Every path `init` writes
therefore names `current`, and an upgrade or a rollback is a switch of that link.

It is asked of the link, not read off the executable's path, because **Bun resolves the junction**:
measured, a binary started as `<junction>\bin\library.exe` reported its `process.execPath` under
`versions\<v>`. A `current` naming another version -- mid-upgrade, or a version run by its own path
to check it before switching -- leaves the version's own path, which is what the installer's tuple
check needs to see. The installer asks the binary through `current` after switching and switches back
when it does not report `current`, which refuses a release built before this rule.

## Consequences

- `init`'s refusal of foreign hooks is kept unchanged. The alternative, `init` recognising the hooks
  of any Library program root as its own, was declined by the reader: it would overwrite a reader's
  hook that happened to name a same-named script, leave every workspace broken between an upgrade and
  its re-init, and break any workspace not re-initialised when an old version is removed.
- **The switch is not atomic on Windows.** No rename lands a directory on an existing one, so the
  installer makes the new junction, removes the old and renames the new onto its name; a `library` or
  hook started in that instant fails to start. POSIX renames a symlink over a symlink and has no gap.
- A session running across an upgrade runs the new version's hook scripts from its next hook call.
- `tools/Test-KernelUpgrade.ps1` is the fixture: install, init, upgrade, `init --force`, rollback,
  and the first version removed, with every program path checked to name `current` and exist.
- The acceptance matrix's kernel arm builds its fixture with the kernel's own program's `init`, so the
  two `init` rows ask what they say -- the same program again -- and the kernel arm no longer needs
  this checkout's root normalised, which S29 had conceded.
