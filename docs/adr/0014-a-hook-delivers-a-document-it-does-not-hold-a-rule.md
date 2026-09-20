# A hook delivers a document; it does not hold a rule

The Library gained four instruction-carrying hooks on 2026-09-06. Each one puts text in front of a
session at a moment prose cannot reliably reach — the playbook for the helper about to run, the rules
a compaction unloaded, the reminder that a search hit is not a reading.

The obvious way to write them is to put the text in the hook. That is rejected. A hook reads a
**tracked document** and serves a named section of it.

## Status

accepted — 2026-09-06.

## Considered options

**The text lives in the hook.** Rejected on three counts, in increasing order of seriousness.

It is unreviewable: a change to what every session is told arrives as a diff to a PowerShell string
literal, and nobody reviews PowerShell for wording. It is undiscoverable: a reader asking "what am I
being told, and why" has to read code. And it creates a **second authority** — the moment a hook says
something the tracked documentation does not, the Library has two rules and no way to tell which one
is current. That is strictly worse than the rot the hooks were introduced to fix, because a rotted
instruction is merely absent, while a divergent one is wrong.

**The hook points at the document.** Rejected as the thing already tried. `CLAUDE.md` says "read
`docs/librarian-operation-playbooks.md` ... before publishing, refreshing, archiving, resetting". A
pointer is exactly what decays: it is the oldest text in the window by the time the operation it
governs is reached, and following it costs a read the session must decide to make.

**The hook cuts a named section out of the document and serves it.** Accepted.

## Consequences

The routing table in `Get-PlaybookContext.ps1` maps a helper filename to a heading, and
`library-hooks.boundary-suite` asserts that **every routed heading resolves in the tracked
document**. Rewording a heading in the playbook fails the gate rather than silently serving nothing
at the moment it was written for — the failure mode a hook holding its own copy cannot have, because
it has nothing left to disagree with.

Cutting is by structure, never by an end marker: a section ends at the next heading of the same or
higher level. An end-marker cut in this repository once swallowed four unrelated sections.

**A hook may say nothing that the tracked documentation does not already say.** The rule bites
immediately. `Restore-CompactedGuidance.ps1` was first written to restate the load-bearing rules from
`CLAUDE.md` after a compaction; `.claude/rules/library-development.md` records that a project-root
`CLAUDE.md` **is** re-injected after `/compact`, so that design would have paid twice for text the
harness restores for free, out of a workspace that budgets its always-on surface in words. The hook
was retargeted at what compaction actually drops — the path-scoped rule — and the suite now asserts
it does not repeat phrases `CLAUDE.md` still carries.

**Guards are exempt, and are the reason the rule is worth stating.** `Guard-ShelfBookRead` and
`Guard-ShellShelfRead` encode a boundary rather than an instruction; there is no document to serve,
because the whole point is that the reader never has to be told. The rule governs hooks that
*inform*. A hook that both refuses and instructs would be the second authority this ADR exists to
prevent — which is why `Get-PlaybookContext.ps1` cannot return a permission decision, and the suite
asserts that it does not.

Full record: [Hook-Enforced Boundaries](../hook-enforced-boundaries.md).
