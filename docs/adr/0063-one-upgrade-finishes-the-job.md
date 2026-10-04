# ADR-0063: One upgrade finishes the job

**Status:** accepted
**Date:** 2026-10-02
**Effective from:** 1.3.2 (its first session, "One upgrade finishes the job")
**Amends:** [ADR-0057](0057-setup-asks-plans-and-applies-and-the-installer-only-fetches.md) on the
existing-Library rule (an upgrade now refreshes the Libraries it serves) and on "the whole apply refuses" (now per
Library); and `setup.ts`'s rule that a consequential choice is never a default, for this one choice
**Relates to:** [ADR-0058](0058-uninstall-reaches-only-what-deskpost-wrote-and-sessions-close-first.md)
(uninstall and live sessions), [ADR-0060](0060-the-holding-shelf-is-the-last-resort-and-its-growth-is-a-library-signal.md)
(`Closed by:` on capture Books)

## Context

The reader's 1.3.0 upgrade needed a second command, `deskpost init`, and then a hand edit for the `Closed by:` lines
on `holding` and `reports`. Three Reports were triaged into 1.3.2. The reader ruled on 2026-10-02: **an install or
upgrade must never need a second command to finish.**

Today an upgrade keeps every Library it serves exactly as it is (ADR-0057). Only `init` brings a Library's managed
files, hooks, Skill and standard Books up to the new program, and its apply refuses whole on any conflicting file.

The design is `PLAN-one-upgrade.md` (r9): three Fable rounds and five Codex rounds, APPROVED at Codex round 5. Its
review log is `PLAN-REVIEW-LOG-one-upgrade.md`. Codex's rounds moved the design twice: away from welding the Library
refresh into the program transaction (round 2), and to a program-only rollback (round 3, the reader's ruling).

## Decision

1. **Two steps on one yes.** The program transaction stays as it is, and leaves every Library untouched. After it
   commits, the new program's `setup --refresh-served <root>` brings each Library the install serves up to date. The
   plan screen shows each Library's refresh beside the program plan, and the plan id binds both, so one [Enter]
   covers both.
2. **The approval is the write set itself.** `setup --apply` writes the approved per-Library writes (each relative
   path, its old SHA-256 or "absent", and its new content, byte-exact, plus the directories to create) as
   `.pending\refresh-approval.json`. The installer copies it into the receipt as `refresh_pending` in the same receipt
   write that commits the transaction. An Undo before the commit discards it with `.pending`. Every release already
   removes the receipt on uninstall.
3. **The refresh replays the approval under the lifecycle lock**, by the three-state rule: a file still at its old
   state is written, one already at its new state is done, and anything else is a conflict. It refuses if a
   transaction is pending or `current` is not the approved version, and clears `refresh_pending` when every Library is
   done or reported. Nothing is re-planned, and once the approval is cleared nothing of the refresh is kept under the
   install root.
4. **Each Library stands alone.** A Library whose refresh refuses (foreign hooks, bad markers, a husk Book, a Codex
   config holding entries Deskpost did not write, entries naming `versions\<v>`) or conflicts is kept or reported
   **partly refreshed**, named with its reason and with `deskpost init <folder>` as the way to finish, and the rest go
   on. `setup --apply` exits 0 and reports the refused list.
5. **The reader can keep the Libraries as they are**, with one key or `--keep-libraries`, and the screen says the
   Library will lag the program. **When nobody can be asked, the upgrade refreshes by default**: this overrides the
   rule that a consequential choice is never a default, because a refresh is what "one run finishes the job" means.
6. **Routes that already write a Library keep doing so.** A new Library (`-Library <new>`) and `-Library <L>
   -Repair` keep today's single-Library write inside the transaction, and the refresh covers only the other served
   Libraries. A same-version run while a refresh is unfinished offers refresh only.
7. **`init` is safe and finishes what it started.** Its Shelf plan compares bytes and plans only files the Shelf
   writer changed. It completes a partly created standard Book, writes the managed Skill's ownership file first, and
   refuses a managed Codex config that holds reader additions. It brings a standard capture Book's entry up to date:
   an existing Book without `Closed by:` gets `any`, today's runtime meaning, and a Book `init` creates gets its
   default. A line that says something is never changed.
8. **The closing doctor checks every served Library**, through `doctor --served-by <root>`, and names any it could not
   reach. A kept or refused Library shows WARNs, never a failure.
9. **Rollback is program-only** (the reader's ruling, 2026-10-02). `deskpost rollback` switches the program back and
   never writes in a Library. For each served Library it names `deskpost init <folder>` (run with the older program)
   to return its managed files and hooks to the older form, and `deskpost seat enter <name>` for a conversation that
   is already open, since a resumed conversation is not re-bound to its seat until one of them runs. Guards still
   fire under the older program, and a hook verb it does not know is a non-blocking error. `install.ps1 -Rollback`
   calls the kernel's rollback, so there is one rollback.

## Consequences

- A reader upgrades with one command, and every served Library is current when it ends, or is named with its reason
  and the command that finishes it.
- One odd Library no longer blocks the upgrade of the others: "the whole apply refuses" is now per Library.
- Unattended upgrades change Libraries by default. `--keep-libraries` keeps the old behaviour.
- After a rollback, a refreshed Library keeps working under the older program, at the cost of a hook-error notice
  and manual seat re-binding until the reader runs the named `init` or `seat enter`.
- Two PowerShell fixtures change their expectations only (`Test-InstallProof.ps1:77`, `Test-InstallLifecycle.ps1:56`),
  a named exception to the no-new-PowerShell rule. Every new case is judged in the kernel self-test.
