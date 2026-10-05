# ADR-0066: The program installs itself, and install.ps1 forwards to it

**Status:** accepted
**Date:** 2026-10-04
**Effective from:** 1.3.5 (built in S89 and S90, released in S91)
**Amends:** [ADR-0057](0057-setup-asks-plans-and-applies-and-the-installer-only-fetches.md) (the fetcher is the
program too), [ADR-0058](0058-uninstall-reaches-only-what-deskpost-wrote-and-sessions-close-first.md) (an
interrupted uninstall is finished by the program's own removal, no longer by a block install.ps1 carries)
**Relates to:** [ADR-0063](0063-one-upgrade-finishes-the-job.md) (the refresh the closing step runs),
[ADR-0065](0065-the-kernel-calls-the-finisher-and-the-release-start-no-powershell.md) (no PowerShell at runtime;
`bun:ffi` for the registry and the process calls)

## Context

Since 1.3.2 nothing Deskpost runs needs PowerShell, except the installer: `install.ps1`, 1039 lines, run through
`irm | iex` or as a file. It fetched and checked a release, then ran the release's own binary for the conversation
(`setup --ask`), the plan and the Library's writes, and did everything between itself: recovery, staging, the plan's
file, the four-substep switch of `current`, `current.json`, the shims, the PATH entry and its broadcast, the receipt
and its lock, the closing doctor and the welcome fork. Its closing step also ended a working upgrade in a raw
PowerShell exception when doctor found a problem in a Library's own content (the fifth-pass Report).

The design is `PLAN-install-without-powershell.md` r3 (Fable APPROVED at round 3), with Eric's three rulings of
2026-10-04: a Command Prompt line using the `curl.exe` and `tar.exe` Windows ships; `install.ps1` shrinking to a
forwarder; S89 and S90 build and S91 releases.

## Decision

1. **`library install` is the installer** (D1, D5). It is install.ps1's transaction step for step, on the same
   receipt, lifecycle lock, pending marks and phase names, and the pending record keeps install.ps1's whole shape
   (`candidate`, `created_version`, `previous_target`, `previous_record`, `previous_version`, `previous_previous`,
   `path_adopted`, `path_added`, `steps`, `.pending\plan.json` and `answers.json`). So a transaction begun by a 1.3.4
   install.ps1 is finished or undone by the program, and the reverse. Its flags are install.ps1's parameters in
   `--kebab-case`, with the same defaults and environment fallbacks.

2. **Two stages in one verb** (D2). Run as a reader runs it, it is a bootstrap: it reads `SHA256SUMS` from a local
   release folder or a URL (the versioned line preferred; the unversioned name alone; equal hashes when both are
   listed), checks the archive's hash, extracts it (refusing an absolute name, a drive, `..`, a `:` and anything but
   one top folder), asks the extracted binary for its tuple, and runs **that** binary with `--extracted <folder>
   --archive-sha256 <hex>`. The code that places release N is release N's. The bootstrap waits, removes its temp
   folder and returns the child's exit code. A release whose binary has no `install` verb is refused: it is
   installed by its own install.ps1. Bun's `fetch` is handed `NODE_EXTRA_CA_CERTS` as `tls.ca`.

3. **After `current` switches, `current\bin\library.exe` runs** `setup --apply`, `setup --refresh-served`, the
   closing doctor and the welcome fork, as install.ps1 did, because they read the program root.

4. **`.pending` goes inside the lock, on every path** (D5): with the commit, an undo, a start-over and an
   uninstall's finish, the finisher's included. A run that finds a committed transaction's `.pending` left under the
   lock removes it.

5. **The PATH entry is added natively** (D4): `Path` read raw and written back `REG_EXPAND_SZ` on the same key
   resolver as its removal (`DESKPOST_PATH_KEY` for a fixture), then `WM_SETTINGCHANGE` "Environment" through user32's
   `SendMessageTimeoutW`. A process cannot change its caller's PATH: the program puts the entry on its own PATH for
   its children, install.ps1 adds it to the window it ran in, and a new terminal reads it from the registry.

6. **The closing check is said, never thrown** (D7). After a committed transaction a check that is not green ends
   in one plain message and exit 1. It says whether the program or a Library failed, and names `rollback` only for a
   program failure with a version to go back to. With `--json` one object carries the status and the closing result.

7. **install.ps1 is a forwarder** (D6): its parameter block, the JSON-needs-a-plan refusal before any download, the
   fetch, hash check and extraction, a capability check (`library.exe install --help`), then the extracted binary
   with the parameters mapped one to one and `--forwarded`, so advice spells `-Resume`. Its stdout is relayed as it
   is, a refusal is thrown in the program's own words (`--refusal-file`), and `-Rollback` runs `deskpost rollback`. It
   never calls `exit`. Its uninstall removal block is gone, and with it the differential half of self-test section
   50; section 116 keeps a TypeScript assertion on the twin key.

## Consequences

- No PowerShell runs in an install, an upgrade, a repair, a recovery or an uninstall's finish. The one PowerShell
  file a release still carries for installing is the forwarder, kept so every existing one-liner, `llms-install.md`
  and the release fixtures keep working; it is deleted with the PowerShell development tooling.
- The four install fixtures are the parity proof: they run unchanged against the forwarder, and so through the
  program, except `Test-InstallLifecycle` installing its first release with that release's own install.ps1 (a
  release before 1.3.5 has no `install` verb).
- The Command Prompt line (D3), the unversioned asset names and the live no-PowerShell fixture are 1.3.5's later
  sessions.
