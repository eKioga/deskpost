# ADR-0042: A plugin-guarded workspace is guarded, a POSIX remedy names a runnable command, and a seat is held on every host

**Status:** accepted
**Date:** 2026-09-23
**Effective from:** Phase D of `PLAN-public-release.md` (S20's clean-VM install; S42)
**Decided by:** the Librarian, on the reader's instruction to fix three open questions by its own recommendations
("i do not know how to solve those problems ... You can research the internet"). Each decision below rests on a
measurement made in S42, and is recorded so the reader can overrule it.
**Relates to:** [ADR-0040](0040-a-posix-workspace-is-an-absolute-path-bound-to-the-binary.md) (the POSIX bindings),
[ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md) and
[ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (the seat and its claim), and
[ADR-0037](0037-a-seat-starts-in-the-workspace-it-is-a-seat-in.md) (a seat starts in its workspace)

## Context

Three questions ADR-0040 left open, and a defect found while answering the third:

1. **A workspace guarded wholly by the Claude Code plugin read as unguarded.** Its hooks are the plugin's, in
   the plugin's own `hooks.json` and spelled `"<root>/bin/library" hook <verb>`, and `doctor`, the settings
   guard and both readers' launch warnings knew only the workspace's `.claude/settings*.json` and script names.
2. **The kernel's remedies named PowerShell helpers** a POSIX host cannot run: `library desk` with no seat told
   a Linux reader to use `tools/Start-LibrarySeat.ps1`.
3. **`library seat start` and `status` were unported**, so a POSIX reader had no way to sit down at a terminal.
4. **Off Windows the seat claim excluded nothing.** Measured in the clean Ubuntu distro: the claim's
   "share-nothing" open was a plain `open(2)`, and its probe asked only whether the file opens, which it always
   does -- every held seat read free, and two sessions could take one seat.

## Decision

1. **A registration names a hook by its script OR by the binary's verb, on every platform, in both arms**
   (`Test-HookEntryNamesHook`, `namesHook`), matched on the verb's word boundary. And **the enabled, installed
   Deskpost plugin's hooks count as registered**, read as Claude Code records them -- MEASURED with claude
   2.1.281 and a scratch `CLAUDE_CONFIG_DIR`: `enabledPlugins` in `<config>/settings.json` (which a workspace's
   own settings may override), `installPath` in `<config>/plugins/installed_plugins.json`, and the manifest's
   `hooks` and `mcpServers` paths. `doctor` also checks that a named `bin/library` exists, and **warns when a
   workspace registers its guards itself and through the plugin**, because every guard then runs twice.
2. **On POSIX a remedy is rewritten where it leaves the kernel** -- a refusal, a guard denial, the Desk hook's
   text, a result's remedy fields, a reader refusal -- to the ported `library` verb (`desk open`, `seat enter`,
   `seat start`, `seat retire`, `shelf render`, `notebook render`, `capture`, `desk`), and a helper with no port
   is named as PowerShell-only rather than offered. Windows keeps the oracle's sentences, which the matrix
   compares, and a page's content is never rewritten (`kernel/src/remedy.ts`).
3. **`library seat start <name>` is ported for a named seat**: create it if new (bound to an active Project, with
   no approval step, as the launcher does when both are named), hold the claim in its own process, start the
   agent in the workspace with `LIBRARY_SEAT`, `LIBRARY_SEAT_CLAIM` and `LIBRARY_WORKSPACE`, and release the claim
   when the agent exits. Not ported, and refused by name: the picker, a Desk restore, retiring a pre-seat Desk,
   and a workspace that still has one. **`library seat status`** is the roster: each seat, its Project, whether a
   session holds it, and its advisory last activity.
4. **On macOS and Linux the claim is `flock(2)`**, exclusive and non-blocking, on the same `.claim.lock`, through
   `bun:ffi` as the Windows path already calls `CreateFileW`: held exactly while the holder's descriptor is open,
   released when it closes or the process dies.

## Consequences

- Rows and judges: `checks.a-plugin-only-workspace-reads-as-guarded` (differential, red against the binary before
  it), the oracle's hook suite section 5a, and kernel self-test sections 22 (plugin), 23 (remedies) and 24 (the
  claim's life and `seat start`), run on Windows and, compiled, in the clean distro. Five planted defects red.
- The harness now pins `CLAUDE_CONFIG_DIR` for every step to an empty directory of the fixture's, so no row reads
  the harness operator's own Claude Code configuration, and a `prepare` takes the fixture's tokens.
- Conceded: a kernel run from source under Node on POSIX has no FFI and its claim does not exclude; musl's libc is
  not `libc.so.6`; a project- or local-scope plugin install is read from `projectPath` without having been
  measured; `seat start --no-launch` releases the claim as it exits, as the launcher's does.
