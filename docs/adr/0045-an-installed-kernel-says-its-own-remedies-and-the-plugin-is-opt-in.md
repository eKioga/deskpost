# ADR-0045: An installed kernel says its own remedies, and the plugin is opt-in

**Status:** accepted
**Date:** 2026-09-24
**Effective from:** release 0.2.0 (S47, the reader's rulings)
**Relates to:** [ADR-0042](0042-a-plugin-guarded-workspace-a-posix-remedy-and-a-held-seat.md) (the POSIX remedy
rewrite; a plugin-guarded workspace), [ADR-0044](0044-basic-memory-is-optional-and-the-public-install-is-local.md)
(friction on the default route is a release defect)

## Context

S46 ran the whole Tier 0 route in a fresh Windows Sandbox and filed two findings that each needed a ruling
rather than a fix:

1. **A guard denial on a kernel install named a helper the reader does not have.** The plugin's Read guard
   refused a closed Holding Shelf page with "Open it with tools/Set-VirtualDesk.ps1 -Action Open ...". A reader
   who installed the kernel has no `tools/` in their workspace; the verb is `library desk open book holding
   --location shelf`. `kernel/src/remedy.ts` rewrote remedies on POSIX only, and was the identity on Windows by
   design, because the acceptance matrix compares the kernel's sentences with the PowerShell oracle's there.
   Rewriting them on Windows moves every compared refusal row.
2. **The README's route registered every guard twice.** `install.ps1` registered the Claude Code plugin, and
   `library init` then registered the workspace's own guards and reader, so `library doctor` on the README's
   workspace warned "every guard runs twice and two validated readers are declared".

## Decision

**A compiled kernel on Windows rewrites its remedies.** Where a sentence leaves the kernel -- a refusal, a guard
denial, the Desk hook's text, a result's remedy fields -- a helper with a ported verb is said as that verb, as on
POSIX; a helper with no port is named by its full path in the installed program, in the form a default execution
policy runs (`powershell -ExecutionPolicy Bypass -File "<program>\tools\<helper>.ps1" ...`). A kernel run from
source on Windows keeps the oracle's sentences.

**The matrix normalises on the oracle's side, by one rule.** When the kernel under test reports `compiled: true`,
the PowerShell arm's stderr, prose stdout and result remedy fields pass through the same rewrite before the two
arms are compared (`ConvertTo-AcceptanceInstalledRemedy`, `tools/AcceptanceMatrix.ps1`). It is a second
implementation, written from the kernel's and never calling it, so the matrix judges the kernel's rewrite rather
than repeating it; the matrix self-test and kernel self-test section 23 hold both to the same cases. Chosen over a
delta per row: one rule the reader can read, instead of a list that grows with every refusal row.

**The plugin is opt-in.** `install.ps1` registers the Claude Code plugin only with `-Plugin` (`install.sh`:
`DESKPOST_PLUGIN=1`); `-SkipPlugin` is accepted and ignored. The default route is `library init`'s per-workspace
guards and kernel reader. Chosen over "init skips when the plugin is enabled" because it is deterministic --
installing the plugin after init would bring the doubling back -- moves no compared init row, and keeps a
stranger's other Claude Code projects free of Deskpost's hooks.

## Consequences

- The Windows verdicts judged through the plugin (rel46a-c) describe an opt-in route from 0.2.0; the default
  route's verdicts are judged through init's guards.
- A remedy for an unported helper is long on Windows. That is the price of being runnable as it stands; each port
  shortens one.
- The rows the rule moves are named by id, with the measurement, in S21's row of `PLAN-public-release.md`.
