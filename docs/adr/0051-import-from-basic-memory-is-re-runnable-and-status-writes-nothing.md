# ADR-0051: Import from Basic Memory is re-runnable against a record, and status writes nothing

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S53, `PLAN-basic-memory.md` steps 3 and 4, ruling B2)
**Relates to:** [ADR-0049](0049-a-local-collection-book-is-first-class-and-a-root-names-its-place.md) (Local collection
Books are first-class), [ADR-0050](0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md) (the connection),
[ADR-0030](0030-a-collection-has-one-layout-and-two-backends.md) (one layout, Markdown canonical)

## Context

For Eric this is the migration route: 24 Books, 10 Hubs, 15 archived Books and 3 archived Hubs move from a Basic
Memory collection's storage folder into a local Library, with nothing lost on either side and the old workspace kept
as the fallback (ruling B2). The source is live and stays in use until cutover, so the import has to run more than
once without overwriting work on either side. It also has to survive a crash halfway through 1,272 files.

## Decision

- **`library basic-memory status` writes nothing, anywhere.** Reachability is an MCP `initialize` within the timeout.
  Counts and the comparison come from the storage folder, read as import reads it. Without a folder, the counts come
  from the server's catalogs over MCP and the comparison says it needs the folder. Each root is `only there`,
  `only here` or `differs`, and a root that differs names **which side changed** (`there`, `here`, `both`), judged
  against the import record. A root in both places that no import brought is `unrecorded`.
- **The source is enumerated from disk, never from its catalogs, and never written.** A root is any slug folder
  under `books/`, `projects/`, `archive/` or `archive/projects/`. Everything else is skipped and named, dot-entries
  included. A symlink or junction is refused, named and never followed. The four catalogs are merge targets and are
  not copied. The preview counts the wikilinks that point into a skipped folder, since those will dangle.
- **The record is `collection/imports.md`**: a note whose body is one fenced JSON block, holding each imported file's
  path and its SHA-256 at import time. It is a `.md` outside every dot-folder, so Obsidian Sync carries it by default.
- **Every file is judged by step 4's table** against the record: `update` (only the source changed), `keep-local`
  (only this Library changed, a deletion included), `conflict` (both changed, named and left alone), `add`, and
  `removed-there` (kept here: import never deletes). A file that is identical on both sides is `same` whatever the
  record says, which is the three-state rule that finishes a crashed run.
- **A root here that no import brought is one root-level conflict, never merged file by file.** That covers a Book
  published locally or a Hub made here under a slug the source also has, and a Hub the import would add under a slug a
  seat is bound to. *Refinement made in S53:* a root that is identical file for file, with nothing added locally, is
  **adopted** into the record without a write, so a record that was moved aside can be rebuilt.
- **`plan_id` is the SHA-256 of the sorted `(path, source sha, local sha | absent, action)` lines.** The confirmed run
  recomputes it, once before the locks and again under them, and refuses a mismatch. Each source file is also
  re-hashed as it is read for its write, and so is the local file it would replace. Either one changed since the plan
  was taken is skipped and named, and the record keeps what it said. A sync client takes no Book lock, so this is
  what stops an edit it lands mid-run from being overwritten (post-build inspection #1).
- **Locks:** `collection/archive`, `collection/books`, `collection/projects`, and every root the run writes, all
  taken through `withBookLocks` (`--lock-timeout`). A Hub held at a seat therefore blocks its own import.
- **Recovery:** the plan is journalled as `pending` at `internal/import-journals/<plan_id>.json` before the first
  write, and each write is atomic. The journal's `added_roots` stop a half-brought root from reading as "here, and no
  import brought it" on the re-run, and they are what still gets its catalog line written. **The record is written
  last.** A finished run marks its journal `complete` and any crashed one `superseded`.
- **Catalogs are merged, never regenerated.** A line is added only for a root this run adds (or a crashed run was
  adding), and only when the Library's catalog does not already list it. The line is the source's own, under the
  source's heading, which is inserted when missing. An uncatalogued root is filed under its catalog's default heading,
  titled from its root page. No line is removed or rewritten.
- **One source per record.** A record or an unfinished journal made from another storage folder is refused rather
  than merged (post-build inspection #4). Status applies the same seat bindings as the import, so `only there` is
  what an import would bring.
- **Afterwards,** the Discovery manifests of the Books written or adopted are rebuilt under the held locks, and doctor runs once the
  locks are released. Its result is part of the import's.

## Consequences

- A re-import is the ordinary way to catch up until cutover. The cutover checklist ends with one.
- Measured against Eric's storage folder (a read-only dry run, S53): 52 roots and 1,272 files, five Books with no
  publication state, `archive/blog` uncatalogued and still `copying`, and 13 links into `work/`, `records/` and
  `_guild/`. The plan's 1,276 counted the four catalog files, and its 14 counted a link in `books/README.md`, which is
  merged rather than copied.
- `LIBRARY_IMPORT_FAULT_AFTER` and `LIBRARY_IMPORT_PAUSE_BEFORE_WRITES_MS` are fixture switches for the self-test,
  as `library migrate --fault-after` is.
- Kernel self-test section 43 judges both verbs through the front door against the stand-in server: every row of the
  table, the root-level conflicts, adoption, a stale plan, a held Hub, a crash and its finish, the race the re-hash
  guards, and the source's bytes before and after.
