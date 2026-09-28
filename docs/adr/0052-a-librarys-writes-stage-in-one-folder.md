# ADR-0052: A Library's atomic writes stage in one folder

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S53, `PLAN-basic-memory.md` step 4a, Eric's ruling (a))

## Context

Eric's trial Library lives inside his Obsidian vault, which Obsidian Sync carries. The kernel's two atomic writers
staged every write as `.<name>.<random>.tmp` beside the file and then renamed it into place, so the sync client saw
transient files appear and vanish in every folder the program touched. The S49/S50 durability research names that
churn as a risk to a synced Library.

## Decision

- **`writeAtomicText` and `writeAtomicBytes` stage inside a Library in `<Library>/.deskpost-staging/`.** That is one
  dot-folder, which Obsidian ignores, and one exclude rule for any other sync client. The Library is found by the
  marker walk (`.library/workspace.json`), cached per directory for the process, and only once found. A folder that
  becomes a Library mid-process is therefore seen on its next write.
- **Two fallbacks stage beside the file, as before:**
  - a write outside any Library (the workspace registry, doctor fixtures);
  - a rename refused with `EXDEV`. A Library subfolder that is a junction to another drive cannot be renamed into
    from the Library's own volume, and without this fallback such a folder would become unwritable.
- **Staging files older than a day are cleared at seat start** (`library seat enter` and `seat start`). A write that
  crashed between its staging and its rename is the only thing that leaves one behind.

## Consequences

- Not covered, and known (the plan's list): capture notes created in place with `wx`, the reader map and the journals
  written directly, and the manifest store's own `.tmp` under `internal/`. These are final-name writes, or they live
  under `internal/`. The PowerShell writers (`tools/AtomicFile.ps1`) still stage beside the file. The trial records
  what Obsidian Sync actually sees.
- Kernel self-test section 44 observes where each write staged by wrapping `fs.renameSync` in process
  (`syncBuiltinESMExports`), injects `EXDEV` the same way, and drives a real `seat enter` over stale and fresh
  staging files.
