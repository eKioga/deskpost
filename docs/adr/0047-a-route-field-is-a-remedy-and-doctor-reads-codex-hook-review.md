# ADR-0047: A route field is a remedy, and doctor reads Codex's hook review

**Status:** accepted
**Date:** 2026-09-26
**Effective from:** release 0.2.3 (S49, the reader's rulings)
**Relates to:** [ADR-0045](0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md) (an installed
kernel says its own remedies), [ADR-0046](0046-a-compiled-windows-init-registers-the-kernels-own-hooks.md) (a compiled
Windows init registers the kernel's own hooks)

## Context

**Route fields.** S48's Linux run found `library desk`'s `notebook.quarantine.list_route` naming
`tools/Restore-NotebookQuarantine.ps1` on POSIX and from a compiled Windows kernel. S49 verified the claim and found
it wider: the restore's listing carries `show_route` and its show carries `restore_route`, both the same helper. The
kernel ports the verb (`library reset restore`), but ADR-0045's rewrite named only eleven remedy keys, and none of
them was a route; nor did it know `Restore-NotebookQuarantine`, so a route would have been named as an unported
helper even inside a remedy.

**Codex's third gate.** S49 judged the Codex verdict on `v0.2.2` in S7's fresh Windows Sandbox, codex-cli 0.153.4 in
a scratch `CODEX_HOME`. With the project trusted in `config.toml` and no hook reviewed, `codex exec` ran a shell
read of a closed Book's page and printed its canary, with no hook firing, while `workspace.codex-guards-registered`
passed. With `--dangerously-bypass-hook-trust` the same read was blocked. After the reader's first interactive
session in the workspace, which wrote one `[hooks.state.'<hooks.json>:<event>:<i>:<j>']` table with a
`trusted_hash` per hook, the read was blocked with no flag. `tools/CodexBindings.ps1` had recorded hook trust as a
third gate "reported, never written"; doctor never reported it. The harness, meanwhile, pinned `CLAUDE_CONFIG_DIR`
per fixture but not `CODEX_HOME`, so every doctor row read the Codex home of whoever ran the matrix.

## Decision

**A result field whose key ends in `_route` is a remedy** -- every such key, not a list, so a route added later is
covered -- and `Restore-NotebookQuarantine` rewrites to `library reset restore`: `-List` to `--list`, and
`-Quarantine <name>` with `-Show`, `-Topic`, `-Adopt`, `-Preflight` and `-PlanId` to their flags. In the kernel
(`kernel/src/remedy.ts`) and in the matrix's own port (`tools/AcceptanceMatrix.ps1`), each held by the same cases.
It is ADR-0045's one rule extended, not a delta: the two rows it moved, `desk.overview-names-what-is-open-at-this-seat`
and `desk.a-bare-slug-on-the-desk-is-a-shared-book`, were red against `v0.2.2` on their `list_route` field only, and
green against the fix.

**`workspace.codex-guards-registered` warns when a registered Codex hook has no review** in the resolved Codex home,
naming each unreviewed hook as `<Event> <i>:<j>` and the `config.toml` it read, with the remedy: open a Codex session
in the folder once and accept its hook review. A warning, as an untrusted project is, because both leave correct
bindings inert. **Presence only**: what `trusted_hash` is taken over is Codex's and is not reproduced, so a review
gone stale after a hook changed reads as reviewed, and Codex asks again in that case. Read, never written. Both arms,
word for word; the pass sentence now says "with every hook reviewed".

**The harness pins `CODEX_HOME`** to a fixture directory that does not exist, as it does `CLAUDE_CONFIG_DIR`; a row
about trust points its steps at a home it prepared. Two differential rows hold the gate:
`checks.a-trusted-codex-project-with-unreviewed-hooks-is-warned` and
`checks.a-trusted-codex-project-with-every-hook-reviewed-passes`, both red against `v0.2.2`.

**Also ruled in S49, recorded here:** the next release, `v0.2.3`, carries a `linux-x64` archive beside `win-x64`,
since a published tag is never moved; and the publishing job keeps its split -- the release is built here and
verified, scanned and published there -- which S20's row accepts as its publishing-job criterion.

## Consequences

A reader on Linux or on an installed Windows kernel is offered `library reset restore ...` for a quarantine, a command
the machine runs. A stranger who trusts a folder for Codex but skips its hook review is told the guard is off, where
doctor used to say it was on. The whole shared matrix runs before the release candidate, because the harness changed.
