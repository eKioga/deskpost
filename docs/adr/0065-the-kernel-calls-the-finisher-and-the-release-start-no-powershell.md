# ADR-0065: The kernel's calls, the finisher and the release start no PowerShell

**Status:** accepted
**Date:** 2026-10-03
**Effective from:** 1.3.2 (its third session, "the kernel calls and the release tree")
**Amends:** [ADR-0058](0058-uninstall-reaches-only-what-deskpost-wrote-and-sessions-close-first.md) (the finisher is
a copy of the program, not a PowerShell script started through WMI);
[ADR-0045](0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md) (an unported helper on an
installed Windows kernel is named without a path)
**Relates to:** [ADR-0064](0064-the-runtime-hooks-are-kernel-verbs.md) (the hooks, session 2, which revoked
"one code path" in principle), [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (a
binding is pid and start time)

## Context

Milestone 1.3.2 is "No PowerShell at runtime": nothing a reader runs on a local collection starts Windows
PowerShell. After session 2 (ADR-0064) the hooks were kernel verbs, and three things still started it:

- **the kernel's own process calls** (`procstart.ts`, `seat.ts`, `lifecycle.ts`): the start time a seat binding is
  checked by, the ancestry walk to the agent client, the wait that holds a seat for its agent's life, and the process
  list a lifecycle switch checks for live sessions. Each spawned `powershell.exe`;
- **the uninstall finisher**: `tools/Finish-Uninstall.ps1`, copied to `%TEMP%` and started through WMI by a
  `powershell.exe` call;
- **the release itself**, which was the public tree: about 140 `.ps1` files nothing in an install runs, and the root
  `library`, `library.cmd` and `library.ps1`. And the advice an installed kernel gave named those scripts by their
  path in the program, so dropping them would make it a dead end.

The design is `PLAN-no-powershell-runtime.md` (r7, D4, D7, D8, D9), as kickoffs/s83's rulings amend it. D8 was
written from S82's spike, which measured the job objects each launch context runs in.

## Decision

1. **The kernel's process calls are `bun:ffi` in a compiled kernel** (`win32proc.ts`; D7 and ruling 3):
   - start time: `GetProcessTimes`' creation FILETIME less 116444736000000000, through
     `roundTripFromHundredNanoseconds`, so it equals the oracle's `StartTime.ToUniversalTime().ToString('o')` to
     100 ns. A process that can be seen and not read stays the `unreadable` sentinel, which is alive;
   - ancestry: one Toolhelp32 snapshot, plus one `GetProcessTimes` per record for the `parent-reused` rule;
   - the agent-exit wait: `OpenProcess` held for the whole wait (so the pid cannot be reused under it), asked with
     `WaitForSingleObject` at a zero timeout between short sleeps, so the event loop is never blocked. A different
     start time at the pid is not waited on. An agent that cannot be opened for waiting falls back to the poll;
   - the process list: Toolhelp32 plus `QueryFullProcessImageNameW`, with a null path where a process cannot be
     opened, as the CIM row has. D7 had missed this one; ruling 3 added it.

   **Under Node each keeps its PowerShell path as the fallback** (Q2), because Node has no FFI. That revokes
   `procstart.ts`'s "one code path" rule (2026-09-22): its reason was that `node kernel/src/cli.ts` was what the matrix
   measured, and the matrix now runs against the compiled binary. An internal verb, `library process`, is the front
   door self-test section 115 judges a compiled kernel through, with `powershell.exe` off the child's PATH.

2. **The uninstall finisher is a copy of the program** (D8, ruling 4). `deskpost uninstall` copies the running
   `library.exe` to `%TEMP%` and starts the copy with `CreateProcessW` through `bun:ffi`, with
   `CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW`, and on `ERROR_ACCESS_DENIED` the same start without breakaway.
   **Never the runtime's attached `spawn`**: S82 measured that Bun puts such a child in its own kill-on-close job
   (`0x3c00`), where it dies with its parent, while a plain `CreateProcessW` child leaves silently (that job carries
   `SILENT_BREAKAWAY_OK`). Breakaway was never refused in any context measured. **No Task Scheduler route**: it
   flashes a console window and runs only while the user is logged on, and a start that fails already lands on the
   handshake's `cancel` and the remedy to re-run the installer with `-Resume finish`.

   The copy runs `library finish-uninstall` (`finisher.ts`, internal), a port of the script rule for rule: the
   `started`/`go`/`cancel` handshake and its 30 s, the 120 s parent wait, the result file, `completed` (the receipt
   deleted last) or `failed` (pending kept, owned by no live process), and the `no-finisher` fault injection. The
   PATH entry is read raw from HKCU and written back as REG_EXPAND_SZ through advapi32. A running exe cannot delete
   itself (`EPERM`, measured), so the copy hands its own delete to a `cmd /c ping ... & del` child as it exits.

   A kernel run from source has no program to copy, and no source run reaches the finisher (a checkout is not an
   installed release), so **`uninstall` refuses from source before it changes anything**, and the script is deleted
   (ruling 4's alternative, a standing answer). `install.ps1` keeps its own removal block for `-Resume finish`.
   Self-test section 50 now runs the kernel's removal and that block on the same frozen list over twin fixtures, and
   section 116 uninstalls a fixture install of a compiled kernel with no PowerShell on PATH, its PATH edit (on a
   fixture key, `DESKPOST_PATH_KEY`) judged against the block's `Remove-DeskpostPathEntry` on a twin key.

3. **A release ships only what runs** (D9, ruling 5). `kernel/src/releasefiles.ts` is the release's own list:
   `tools/Build-KernelRelease.ps1` pipes the public tree's files into it and stages what it prints. It keeps every
   file that is not PowerShell, `install.ps1`, and the Basic Memory reader adapter with its transitive closure of
   dot-sourced `tools/` scripts, computed from the files (24 today). It drops every other `.ps1` and the root
   `library.cmd` and `library.ps1`. The extensionless root `library` stays: `install.sh` `chmod`s it in the extracted
   tree, and a Linux release without it did not install (found in the clean distro). **The public repository is
   unchanged**: `tools/*.ps1` stays the development oracle until "PowerShell-free development". Self-test section 117
   judges a built tree, including that it carries what `install.sh` touches. A built release ships 26 `.ps1` files,
   down from 139.

4. **Advice names only what ships** (D4, amendments 1 and 6). `remedy.ts`'s `REWRITES` gains every helper a kernel
   sentence names that has a verb (`Set-CollectionOwner`, `Archive-ShelfBook`, `Copy-LocalPagesToProject`,
   `Initialize-LibraryWorkspace`, a bare `Invoke-LibraryTriage`). On an installed Windows kernel a helper with no verb
   is named as "a helper in the Deskpost source checkout; this installed program does not ship it", with no
   PowerShell and no path. `tools/AcceptanceMatrix.ps1`'s mirror moves in step. Self-test section 118 asserts that no
   kernel sentence said as an installed Windows kernel says it names a `.ps1` outside D9's allowlist.

## Consequences

- **What still starts PowerShell at runtime, by name:** the installer (until "Install without PowerShell"); the Basic
  Memory reader adapter on Windows, a Basic Memory workspace only (Q3); and Codex's own `powershell.exe -Command`
  launcher, which is Codex's, not Deskpost's. In the kernel's source, `powershell` remains only in the Node
  fallbacks, `init.ts`'s adapter registration and its `codexGuardCommand` for a program with no kernel hooks.
- A compiled kernel's process calls are faster: one kernel32 call instead of a 190-210 ms PowerShell spawn per read.
- The acceptance matrix's compiled arm initialises its fixtures with the kernel's own program root's
  `tools/Initialize-LibraryWorkspace.ps1`, which a release no longer ships. Running rows with `-Kernel` against a
  built release needs that fixed first (Report, 2026-10-03), or a tree that still carries `tools/`.
- `install.ps1`'s removal block keeps its comment that it is carried byte for byte by the finisher: the installer is
  not changed in 1.3.2, and the comment is corrected when it next is.
- D5's clean-distro run (S83) proved the POSIX registrations ADR-0064 changed: a Linux init registers nine kernel hook
  verbs. Sections that read or import the source tree (101, 112, 114) do not run as a compiled self-test; they are
  judged on Windows against the compiled kernel.
