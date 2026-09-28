# ADR-0058: Uninstall reaches only what Deskpost wrote, and sessions close first

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S54, `PLAN-install-onboarding.md` step 4)
**Relates to:** [ADR-0054](0054-a-shared-book-opens-on-a-local-library-and-rollback-checks-for-it.md) (the shared-Desk
preflight), [ADR-0057](0057-setup-asks-plans-and-applies-and-the-installer-only-fetches.md) (the receipt and lock)

## Context

1.0 had `install.ps1 -Rollback` and no uninstall at all: the answer was "delete the folder", which leaves every
Library's hooks naming a program that is gone. A general uninstaller risks the opposite failure, deleting what is not
Deskpost's. The plan's rule is a constraint over machinery: the program folder was new or empty, so what Deskpost
created can be proved and nothing else is touched.

## Decision

- **Close your sessions first** (#7, #10). An upgrade, repair, rollback or uninstall refuses while one of two things
  is open:
  - a seat claim, held or orphaned, in a registered Library whose registrations name this install. A Library bound
    to another program is not switched, so its sessions are not in the way;
  - a `library.exe` running from under the install root. Step 0 measured that it shows its launch path there.

  The process asking and its ancestors are excluded. Interactively it lists them and waits for Enter; otherwise it
  refuses with the list. The installer asks through `setup --sessions`. This is best effort, and said so.
- **`deskpost uninstall [--dry-run] [--yes]`** runs in step 8's order:
  1. **Resolve and preview**, while `current` still resolves. Program files come from each version's
     `.inventory.json`. For a 1.0 version with none, they come from the kept archive in `downloads\` when it matches
     `.archive-sha256`, read from the ZIP's own central directory. Otherwise the version folder is
     `not recognised, left in place`. A file counts only while it still matches its hash. `current`, the stray
     `current.new-*` and `current.old-*` links, `current.json`, and the two shims holding exactly the shim line are
     adopted by name. The archives used for adoption are adopted with their `SHA256SUMS`. The Libraries' entries are
     computed too.
  2. **Record `pending: uninstall`** with the frozen removal list, under the lifecycle lock.
  3. **Edit the Libraries.** In each registered Library, only the entries whose Deskpost form names a binary or a
     `-File` script under this root are removed: hooks in `.claude/settings.local.json`, `.claude/settings.json` and
     `.codex/hooks.json`; the reader in `.mcp.json`; the reader table in `.codex/config.toml`. A reader's own hooks
     and servers stay, and no file is deleted. The JSON is re-serialized, so other entries are kept by value, not byte
     for byte. From this point there is no undo.
  4. **Hand PATH and the program files to the finisher,** `tools/Finish-Uninstall.ps1`. It is copied to `%TEMP%` and
     started through **WMI (`Win32_Process.Create`, hidden)**. Measured in S54: a detached `powershell.exe` exits at
     once without running its command, and an attached one dies with the parent's job object. Arguments go in
     through an environment variable, quoted by the `CommandLineToArgvW` rules. The **two-way handshake** follows:
     `started <pid>`, the owner rewritten to the finisher while this process is alive, then `go`. With no `started`
     in 10 s the parent writes `cancel`. The finisher waits for the parent to exit, then removes:
     - links as links;
     - files only while they still match, revalidated as physical paths under the root with no reparse point
       between;
     - folders only when empty;
     - the receipt last, then the lock and the root when empty.

     On `completed` it clears everything. On `failed` it leaves `pending` and the receipt, owned by nobody.
- **Retry never needs the program.** Re-running the installer finds `pending: uninstall` and finishes it
  (`-Resume finish`), through the same removal block. install.ps1 carries that block byte for byte, and kernel
  self-test section 50 holds the two equal. Before the Library edits began, `-Resume undo` just clears it.
- **`deskpost rollback [--yes]`** switches `current` to the previous version in the four named substeps. It runs
  under the lifecycle rule and the close-your-sessions rule, and keeps ADR-0054's shared-Desk preflight. It checks the
  switched version answers through `current`, and switches back if not.
- Both verbs are Windows-only in 1.1, and refuse by name elsewhere.

## Consequences

- `tools/Test-InstallLifecycle.ps1` runs against two built releases: install 1.0.0, upgrade to a second version in
  place, roll back, uninstall. All 13 of its checks pass, on D: with `%TEMP%` on C:. It confirmed:
  - the Library's hooks unchanged byte for byte across the upgrade;
  - doctor green after the upgrade and after the rollback;
  - the finisher completing and the program folder gone;
  - a reader's own hook surviving, and the Library itself untouched.

  An interrupted uninstall was also finished through `install.ps1 -Resume finish` with no program present.
- Kernel self-test section 50 judges the entry matching (a near-miss root included), the Library edit, the ZIP
  inventory, the shared removal block and the argument quoting.
- The receipt's `owned` list is what a later uninstall trusts, but this build's uninstall still recomputes from the
  inventories. Adopting from `owned` alone is left until a Library-less reinstall makes it matter.
