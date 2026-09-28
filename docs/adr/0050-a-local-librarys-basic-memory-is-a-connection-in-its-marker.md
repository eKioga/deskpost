# ADR-0050: A local Library's Basic Memory is a connection, and it lives in the marker

**Status:** accepted
**Date:** 2026-09-26
**Effective from:** 1.1 (S52, `PLAN-basic-memory.md` step 2, ruling B1)
**Relates to:** [ADR-0044](0044-basic-memory-is-optional-and-the-public-install-is-local.md) (Basic Memory is
optional), [ADR-0049](0049-a-local-collection-book-is-first-class-and-a-root-names-its-place.md) (the `shared/`
form)

## Context

Eric's ruling B1 is "local always, but with the added options for the users who have Basic Memory set up". A
local Library keeps its Books and Hubs in `collection/`, and a Basic Memory server is a second source it reads:
to open a shared Book, to compare, and to import from the server's storage folder.

1.0 had only one way to say "this workspace has Basic Memory", which was that it IS Basic Memory. Three files,
`.claude/.library-mcp-url`, `.library-project` and `.library-shared-root`, are what `init` reads to decide a
workspace's backend, and what the ownership fence reads to decide who writes. The S51 run found that
`init --mcp-url` recorded a backend without writing the files its helpers read, and so half-configured the
workspace (F21). The plan's review found the obvious fix worse than the defect (Fable #1, blocking): writing the
three files into a local Library turns the next `init` (a repair, an upgrade, a `deskpost setup`) into a silent
conversion to `backend: basic-memory`. After that `openCollection` refuses, and Hubs go to MCP.

## Decision

**A local Library's Basic Memory is a connection, and it lives in the Library's marker and nowhere else**, as
`connections.basic_memory: { url, collection_id, collection_name, storage }`.

- **`library basic-memory setup`** checks each value live before saving it:
  - the URL answers MCP `initialize` within the timeout;
  - the collection is chosen from the server's own `list_memory_projects` and stored as its UUID;
  - the storage folder, when given, holds both catalogs.

  A value that fails is named with its reason, and nothing is saved. It never writes the three files. A file
  left by 1.0's half-configured init is named, never read and never removed.
- **`library basic-memory disconnect`** removes the marker's record and touches neither collection.
- **The marker's `backend: local` is honoured before everything, the environment included.** For a local Library
  the endpoint, collection id and shared root are the connection's. `AI_LIBRARY_MCP_URL`,
  `AI_LIBRARY_PROJECT_ID`, `LIBRARY_SHARED_COLLECTION_ROOT` and the three files are ignored, so a shell that has
  them set cannot make a local Library reach for a server it never connected.
- **The fence stays `local` for a local Library whatever its connection.** Nothing is written to Basic Memory in
  1.1, so every shared writer is refused there exactly as before, and publish never meets the fence at all
  (ADR-0049).
- **`init` preserves what it does not set.** It keeps every marker field it does not own, a `connections` record
  included, and keeps an existing `backend`. A NEW Library initialised with `--mcp-url` is local, and records the
  URL (and `--collection-id`) as its connection, which is the F21 fix. A Basic Memory backend remains only for the
  workspaces that already have one, and they keep working through 1.x exactly as before.
- **Every MCP call is bounded**, at twenty seconds or `LIBRARY_MCP_TIMEOUT_MS`. A host that accepts the
  connection and never answers is refused by name, never waited on.

## Consequences

- The Desk's `shared/<slug>` form (ADR-0049) reads over this connection's URL and collection UUID, with the
  timeout.
- A Library moved to another machine by folder sync carries its connection with it, because the marker is inside
  the Library. The connection's storage folder is a path on the machine that set it up, and a second machine
  re-runs set-up to name its own.
- `tools/Initialize-CodexLibrary.ps1` still configures a Basic Memory backend, and a local Library no longer
  needs it.
- Kernel self-test section 42 judges set-up, disconnect, the re-`init` and the environment against a stand-in
  Basic Memory server run as a child process, including one that never answers.
