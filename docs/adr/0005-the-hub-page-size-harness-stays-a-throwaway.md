# The Hub page-size harness stays a throwaway

Measuring a Project Hub page's size — which sections and entries are actually large — needs a
harness that AST-imports `Import-ScriptFunctionScope` from `New-HubMigrationSnapshot.ps1`,
`Invoke-ReaderCall` from `Test-HubMigrationAcceptance.ps1`, and six `Edit-ProjectHub.ps1` parsers.
It has been rebuilt from scratch in two consecutive sessions, because the scratchpad is
session-specific and nothing carries it forward.

It is not promoted to `tools/Get-HubPageSizes.ps1`. It stays a throwaway, rebuilt when needed.

## Status

accepted — 2026-08-26, with a trigger rather than a schedule.

Moved here from the Library Development Hub's `Next` section on 2026-08-31 by ADR-0003.

## Considered options

**Promote it to a public helper.** Rejected on cost relative to benefit. A public helper lands
raising `helpers.manifest-matches-allowlist` and needs a `tools/_helpers.json` entry plus a
`.claude/settings.json` allowlist line only the reader can add — the Librarian is refused that edit
by design. That is real ceremony for something rebuilt in a few minutes.

**Rebuild it each time it is wanted.** Accepted. It is genuinely cheap: a few minutes and near-zero
context, because it prints names and byte counts rather than page text. Two rebuilds is not yet
evidence of a recurring cost.

## Consequences

The measurement is available whenever it is wanted, at the price of rebuilding it. Nothing in the
repository refers to a `Get-HubPageSizes.ps1`, so nothing breaks by its absence.

**The trigger, not a schedule: revisit if a third session has to rebuild it.** Two rebuilds is a
coincidence; three is a pattern, and at that point the ceremony is cheaper than the repetition.

**Do not re-open this unprompted** before that trigger fires.

Recipe and reasoning: [[projects/library-dev/notes/library-dev-history-2026-08-part-2]], section
`2026-08-26 (continued) -- The lever applied to Now, and the detail it displaced`.
