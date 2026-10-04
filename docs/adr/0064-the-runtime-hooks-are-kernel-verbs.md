# ADR-0064: The runtime hooks are kernel verbs

**Status:** accepted
**Date:** 2026-10-03
**Effective from:** 1.3.2 (its second session, "the hooks")
**Amends:** [ADR-0014](0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md) (its routed-heading gate is
retired with the playbook hook); [ADR-0046](0046-a-compiled-windows-init-registers-the-kernels-own-hooks.md) (no
hook is left as PowerShell in a compiled or POSIX init)
**Relates to:** [ADR-0063](0063-one-upgrade-finishes-the-job.md) (an upgrade refreshes every served Library's
registrations), [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (the re-bind goes
through the gate)

## Context

Milestone 1.3.2 is "No PowerShell at runtime": nothing a reader runs on a local collection starts Windows
PowerShell. After 1.3.1, four hooks an installed Library registered were still PowerShell scripts run from the
program: `Restore-CompactedGuidance.ps1`, `Add-SearchHitReminder.ps1`, `Get-SeatStartContext.ps1` and
`Get-PlaybookContext.ps1`. Two Reports showed they were also wrong in an installed Library, because each was
registered with no `-StateDirectory` and so worked on the **program's** state:

- the compaction clear emptied the program's serve ledger, never the workspace's, so the Desk block S77 withholds
  was sent on every prompt;
- the seat-start hook read the program's seats, so a seatless session in a Library with seats was told "No seat
  exists in this checkout yet" (reproduced in a fixture in S82), and a resume re-bind ran against the program.

The design is `PLAN-no-powershell-runtime.md` (r7; Fable APPROVED at round 4, then B's S81 amendments). The reader
accepted every recommendation on 2026-10-02 (its Q1-Q5).

## Decision

1. **Three verbs, one retirement (D1).**
   - **`library hook compact-clear`** is the serve-ledger clear and nothing else. On PostCompact and on every
     SessionStart source it removes the session's key from the **workspace's** `.claude/.hook-served.json`, resolving
     the workspace as desk-context does (explicit, `LIBRARY_WORKSPACE`, the working directory's marker, the anchor).
     It prints nothing; with no workspace it exits 0 silently. **The standing-rules serve is dropped** (Q5): `init`
     writes no `.claude/rules/` into a workspace, and the development checkout keeps the script. `ledgerClearReaches`
     answers true for the verb when its binary is there and its target (`--state-directory`, else
     `<workspace>/.claude`) is the Desk hook's own state directory.
   - **`library hook search-hit`** is the hit-is-a-location reminder. It also matches `deskpost raw search` and
     `library raw search`, and takes `--reader-tool-prefix` as desk-context does.
   - **`library hook seat-start`** is the seat-start hook, branch for branch. It reads the **workspace's** seats and
     re-binds a resumed conversation through this program's own `seat enter`, which applies the operation-by-state
     matrix (ADR-0018). The served section is still `## Sitting down at a seat` of the program's `docs/seats.md`.
   - **`Get-PlaybookContext.ps1` is retired and deleted** (Q1), with its PreToolUse block in the program's
     `.claude/settings.json`, so no Library registers it. The playbooks document stays.
2. **Every table moves in step (D2).** `HOOK_VERB_FOR_SCRIPT`, `HOOK_ACTIONS`, `library verbs` and the oracle's
   verb map gain the three verbs; `REQUIRED_HOOKS` and the oracle's required table lose the playbook row. So a
   compiled or POSIX `init` registers every hook as `library hook <verb>` and no PowerShell for Claude. The plugin
   stays at its five verbs. `kernel/test/context-budget.json` gains `search-hit` and `seat-start`.
3. **An unknown hook verb fails safe (D3).** It reads its payload. Under PreToolUse it is a deny naming the verb, the
   binary's version and the remedy (`deskpost init` with the installed program, or upgrade), so a guard a binary
   lacks fails closed. Under any other event, or for a registration marked `--advisory`, it exits 0 and prints
   nothing. It protects binaries from 1.3.2 on. For 1.3.1 and older nothing new is needed: none of the new verbs is
   PreToolUse, so an older binary's refusal (exit 1) is a non-blocking error, and `deskpost rollback` names the
   `init` and `seat enter` lines (ADR-0063 decision 9).
4. **How the ports are judged (D6).** Front-door kernel self-test sections, run against the kernel under test with
   `LIBRARY_SELFTEST_KERNEL`, are the judges: section 111 (D3), 112 (`compact-clear`: the workspace session's key
   emptied, the program's ledger untouched, nothing printed), 113 (`search-hit` and `seat-start` in a Library with
   seats) and 114 (the retirement: a fresh init's doctor and settings guard name nothing missing); section 39 judges
   a compiled init's registrations. `tools/Test-LibraryHooks.ps1` stops testing the retired script: its section-4
   ledger writer is `HookContext.ps1`'s `Set-HookServed`, and **ADR-0014's "every routed heading resolves" gate is
   retired** with the hook. `seats.session-start-section-resolves` still guards the seat section.
5. **The kernel's process calls (D7), as decided for session 3:** under Bun the start time, ancestry and agent-exit
   wait move to `bun:ffi`; under Node the PowerShell path stays as a fallback (Q2). That **revokes `procstart.ts`'s
   "one code path" rule**; session 3's commit says so.

## Consequences

- An installed Library's hooks are `library.exe hook <verb>` after the 1.3.2 upgrade refreshes it (ADR-0063), with
  no `deskpost init` step. The Desk block is withheld after the first prompt there too, and a seatless session is
  offered that Library's seats.
- A development checkout run from source has no binary to register, so it keeps the three scripts
  (`Restore-CompactedGuidance.ps1`, `Add-SearchHitReminder.ps1`, `Get-SeatStartContext.ps1`), unchanged in behaviour.
- **ADR-0014 quotes a filename an installed Library no longer runs** (`Restore-CompactedGuidance.ps1`, by way of
  `Get-SeatStartContext.ps1`'s header). ADR-0014 is history and is not edited; this record says so.
- Codex keeps its four hooks: it has no SessionStart or PostCompact, and its launcher (`powershell.exe -Command`)
  is Codex's, not Deskpost's.
- Session 3 builds the uninstall finisher from S82's spike: a `library.exe` copy started by `CreateProcessW` with
  `CREATE_BREAKAWAY_FROM_JOB`, falling back to a plain start, with Task Scheduler last.
