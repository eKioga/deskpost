# ADR-0054: A shared Book opens on a local Library, and a rollback to 1.0 checks for one first

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S53, `PLAN-basic-memory.md` step 5, moved into 1.1 at Eric's request)
**Relates to:** [ADR-0049](0049-a-local-collection-book-is-first-class-and-a-root-names-its-place.md) (the `shared/`
form), [ADR-0050](0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md) (the connection)

## Context

ADR-0049 gave the Desk a `shared/<slug>` form, read over a local Library's Basic Memory connection, but no way for a
reader to find what the server holds or to open a Book there by name. And 1.0's reader refuses a whole Desk that
holds a `shared/` entry. Rolling back to 1.0 with one open would silently close every Book on that seat.

## Decision

- **`library basic-memory open`** lists the connection's Books from the server's own catalogs (`books/README.md`
  and `archive/README.md`, over MCP, with the timeout), each marked `also in your Library` when the Local collection
  holds that slug too.
- **`library basic-memory open <slug> [--shelf archive]`** first reads the Book's `_book` page through the
  connection, and refuses one the server lacks. It then opens `shared/<slug>` (or `shared/archive/<slug>`) on the
  seat's Desk through the ordinary Desk write. Its pages are read over MCP by the validated reader. Nothing is copied
  and nothing is written to Basic Memory. The same slug open in both places is settled by `place`, as ADR-0049 set out.
- **`library basic-memory rollback-check`** scans `.claude/seats/<seat>/.open-books` in every registered Library and
  in the current one. It names each seat holding a `shared/` entry, with the `library desk close` command for each
  entry. It writes nothing, and it answers from outside any workspace. `library desk close book <slug> --location
  shared` removes a `shared/` entry even after the connection is gone, so that command always works (post-build
  inspection #2).
- **`install.ps1 -Rollback` runs the check through the version it is leaving and refuses to switch while any seat
  holds a `shared/` entry**, printing the close commands. This was the kickoff's open decision, and it is taken here
  because `install.ps1 -Rollback` is the fallback the cutover actually relies on today. The install plan's
  `deskpost rollback` inherits the same preflight.
  - A version that has no check, or cannot answer, never blocks the way back, because rollback is the fallback for a
    broken version. 1.0 has no `shared/` form, so a 1.0 Desk can hold no such entry.
  - An unreadable seat folder or registry is reported and does not block.

## Consequences

- Shared-Book Discovery is unchanged. It uses the shared manifests where they exist, and rebuilding them is still
  PowerShell until its kernel port in 1.2.
- Kernel self-test section 46 judges the list, opening, a read over MCP from the stand-in server, the refusal of a
  missing Book, the same slug in both places, a hung server within the timeout, and the rollback check through its
  own close commands. The `install.ps1` hook was exercised by hand against the kernel's real answer, both blocking
  and clear. `tools/Test-KernelUpgrade.ps1` covers `-Rollback` with a built release.
