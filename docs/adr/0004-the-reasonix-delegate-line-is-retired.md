# The Reasonix delegate line is retired

> **Superseded 2026-09-01 — Reasonix is no longer in play at all.** The reader reports it has been
> replaced by a product that does not need integrating yet, so this is no longer a live decision to
> respect but a record of one that was made. Its pointer has left the Library Development Hub's
> `## Decisions` section, per the operative-pointers-only rule in ADR-0003.
>
> Kept, not deleted, because superseding is a statement about currency rather than a deletion —
> `CONTEXT.md`'s own definition. Deleting it would destroy the reasoning and leave a hole in the ADR
> numbering, and the *Considered options* below are still the argument anyone should read before
> taking on a per-token delegate again.
>
> **Still true of the repository as of 2026-09-01:** `tools/Invoke-ReasonixRun.ps1` (698 lines) is on
> disk, `reasonix-run.selftest` runs in the gate, and there is an allowlist line, a
> `tools/_helpers.json` entry, and substantial Reasonix content in
> `docs/model-division-of-labor.md`. Removing that surface is a separate change and has not been
> made.

The Library briefly ran three implementation delegates: Codex, DeepSeek Harness, and Reasonix
(DeepSeek V4 Flash via the Reasonix CLI). Reasonix was API-billed per token rather than metered, so
it filled a real gap — work could continue when Codex's weekly window was spent. Its integration was
completed on 2026-08-18 with `tools/Invoke-ReasonixRun.ps1`, which took over the argv, the stream,
the poll decision, and the MCP catalog gate that the hand-assembled Skill had left to be reassembled
by hand on every run.

The reader does not expect to use Reasonix again. Further development on it is not worth its cost,
so the line is retired: no more capability is added, and its remaining unproved surfaces stay
unproved by decision rather than by oversight.

## Status

accepted — 2026-08-26. Superseded only by a decision to want a per-token delegate again.

Moved here from the Library Development Hub's `Next` section on 2026-08-31 by ADR-0003. Committed
and pushed as `7aad470` (the extraction) and `bf8d93b` (the retirement).

## Considered options

**Keep developing it.** Rejected on cost. The remaining work was live acceptance of `-Resume`,
`-TaskFile`, `-MetricsPath`, and the `-OnStale Report` reaping gap — each requiring real runs
against a delegate the reader had stopped reaching for.

**Delete the helper.** Rejected. `tools/Invoke-ReasonixRun.ps1` is covered by `reasonix-run.selftest`
at 36 checks inside a green gate, so it costs nothing to keep and removes the reassembly problem if
the line is ever reopened. Deleting it would throw away the part that was finished.

## Consequences

`tools/Invoke-ReasonixRun.ps1` stays on disk and stays gated. `docs/model-division-of-labor.md`
carries a status note saying its Reasonix passages no longer govern.

**Recorded so nobody re-derives it:** no live run ever exercised `-Resume`, `-TaskFile`, or
`-MetricsPath`, and `-OnStale Report` leaves the process alive with nothing reaping it. These are
unproved by decision now, not by oversight — anyone reopening the line starts from that list.

Two preconditions of the delegate were never enforced and stay true of a helper still on disk. The
MCP write-ban override lives in `%AppData%\Roaming\reasonix\mcp-activation.json`, outside the
checkout and keyed by a hash of the workspace path, so a move or a fresh clone drops the ban with no
error and nothing can see it. And the delegate's `bash` runs under WSL while the gate is a
`powershell.exe` invocation. Both stop mattering while Reasonix goes unused; both matter again the
day it is picked up.

**Do not re-open this unprompted.** Revisit only if a per-token delegate is wanted again.

Fuller narrative: [[projects/library-dev/notes/library-dev-history-2026-08-part-2]].
