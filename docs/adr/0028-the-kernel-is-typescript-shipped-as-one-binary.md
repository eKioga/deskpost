# The kernel is TypeScript, shipped as one binary; PowerShell survives only in the v0 preview

The rebuild's kernel is written in TypeScript on Node 22+ and delivered to readers as one
self-contained executable per platform. Node is a developer prerequisite, never a reader one. The
current Windows PowerShell 5.1 implementation ships once more, as a labelled Windows preview, and
is not extended after that.

## Status

accepted — 2026-09-19, Eric's ruling Q3 in `PLAN-public-release.md`. Effective from that plan's
Phase D; the v0 preview of Phase B remains PowerShell.

## Why

Three constraints point the same way. Windows PowerShell 5.1 exists only on Windows, and
PowerShell 7 is a separate install on every platform including Windows (Microsoft Learn,
observed 2026-09-19), which Eric's footprint rule forbids as a reader prerequisite. The
development rules in `.claude/rules/library-development.md` name six PowerShell defect families
this codebase keeps producing, three of them unlintable. And the reader's stated destination is an
Orca-shaped TypeScript application, so a PowerShell rebuild would be rebuilt again. The size of the
job is known: `.dsh-prototype/library-core/lib/index.js` re-implemented fifteen Library tools in
1,148 lines of JavaScript on 2026-09-01 and verified them against a fixture workspace; the 60,000
lines of PowerShell are mostly self-tests, seat and lock machinery, and publication helpers the
public never needs.

## Considered options

**PowerShell 7 for v1.** Rejected. The least rewrite, one more install for every reader on every
platform, and a second migration when the application arrives. A `pwsh` experiment against the
current suite was proposed and then made unnecessary by the footprint rule.

**Python with `uv tool install`.** Rejected. Excellent one-line installs, and it aligns with Basic
Memory and spec-kit, but with nothing else the reader named.

**TypeScript with Node required, distributed on npm.** Rejected. A simpler release pipeline that
fails the footprint rule on day one.

## Consequences

- Nothing ports until a row exists for it in a **supported-operation matrix**; the old and new
  implementations run every row over one fixture workspace and their **normalised** outcomes are
  compared, with intentional deltas listed and approved. Independent fault, concurrency, recovery
  and real-harness suites stand beside the comparison.
- The seat claim keeps ADR-0018's contract: verified process identity with an incarnation, fenced
  on every mutation, an exclusive handle where the platform provides one, and **no heartbeat or
  lease expiry**.
- Every release pins a plugin version, binary version and workspace schema version as one tuple;
  upgrade is binary then plugin, rollback the reverse; `library doctor` is the acceptance.
- Helpers the public never needs are not ported: wiki import, Hub migration, the token baseline,
  both manifest backfills.
