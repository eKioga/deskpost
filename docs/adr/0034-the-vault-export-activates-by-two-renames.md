# ADR-0034: The vault export activates by two renames, not by a pointer

**Status:** accepted
**Date:** 2026-09-19
**Effective from:** Phase B of `PLAN-public-release.md` (step 15, `tools/Export-CollectionToVault.ps1`)
**Supersedes:** nothing. `D:\library-mirror`'s per-file exporter is retired by the same step.

## Context

The collection is mirrored one-way into the reader's Obsidian vault so it can be read on every
device Obsidian Sync reaches. Step 15 of the public-release plan replaces a per-file exporter with a
whole-generation one, and clause (c) of its contract leaves one mechanism open:

> Windows cannot rename over an existing directory, so the mechanism is two renames with a journal
> entry between them, or versioned generation directories behind a pointer, chosen in Phase B.

The constraint behind the clause is real and is not a Windows quirk worth working around: there is
no `rename(2)`-style atomic directory replacement on NTFS. `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING` refuses a directory destination, and `File.Replace` is file-only. So the
old generation must be moved out of the way before the new one can take its name, and the question
is what stands at the reader's path in between.

An Obsidian editor cannot be excluded from the destination, which is why the contract retains the
old generation rather than deleting it: an edit that lands in the activation window has to be
findable afterwards. Both candidate mechanisms retain it. They differ in what the reader's vault
looks like during the swap and in what the product then depends on.

## Decision

**Two renames, with a journal entry between them.**

    1. journal: activation-begin, naming the live path, the retained path and the staged path
    2. rename  <mirror>                     ->  <state>\generations\<generation-id>
    3. journal: live-moved-aside
    4. rename  <state>\staging\<run-id>     ->  <mirror>
    5. journal: activation-complete

Both renames are metadata operations within one volume, so the window in step 3 where the mirror
path does not exist is sub-millisecond rather than the length of a copy. The staging and generation
directories live under `<vault>\40-Resources\.library-export\`: on the same volume, because a
cross-volume move is a copy, and under a dot-directory, because Obsidian and Obsidian Sync ignore
those, so a retained generation is not a second copy of the Library in the reader's search results.

**Rejected: versioned generation directories behind a pointer.** The pointer would have to be a
junction or symlink at `40-Resources\Library`, and that buys nothing here:

- It does not remove the window. Repointing a junction is delete-then-create, or a rename of the
  junction itself, which is the same two-step with an extra reparse point in it.
- Obsidian indexes a junction's target as ordinary files, so Obsidian Sync would replicate the
  generation directory's contents to every device under a path that exists only on this machine.
  The mechanism meant to be invisible becomes the thing that is synced.
- It adds a platform dependency the product does not otherwise have. A symlink needs Developer Mode
  or elevation on Windows; a junction needs neither but is Windows-only, and the kernel of Phase D
  (ADR-0028) targets macOS and Linux from one codebase.
- It makes the reader's path a link rather than a folder. Every tool that copies, backs up or
  repairs the vault then has an opinion about it, and those opinions differ.

The pointer's one genuine advantage — several generations retained at once — is not wanted. The
contract keeps exactly one previous generation and deletes it once it has been verified against its
own manifest, because a retained generation is unsynced reader-visible bytes and the value of
keeping them decays fast.

## Consequences

- **The journal is load-bearing, not a log.** Between steps 2 and 4 the vault has no mirror, and the
  only thing that knows how to finish or undo the swap is the journal entry written in step 1. It
  therefore records absolute paths, not relative ones, and it is flushed before each rename rather
  than after.
- **An interrupted run is resumed or rolled back, never merged.** The recovery reads the last
  journal entry and then *observes the filesystem*, and the two must agree. Live present and
  retained absent means step 2 never ran: roll forward or discard the staged generation. Live
  absent and retained present means step 2 ran and step 4 did not: complete it. Live present **and**
  retained present cannot be produced by a rename, so it means something outside this tool created
  a directory at the mirror path during the window; the run refuses and names both paths rather
  than choosing one.
- **Recovery of a window edit is reported, and lands where the reader can open it.** After
  activation the retained generation is re-hashed against the *old* manifest; anything that differs
  was written into the vault during the window, and it is copied to
  `40-Resources\Library-recovered\<run-id>\` — a visible folder, created only when there is
  something in it — and named in the run's result as `vault-edited-during-activation`.
- **The same-volume requirement is checked, not assumed.** The exporter refuses when the state root
  and the mirror are on different volumes, because a "rename" across volumes is a copy and the
  window stops being sub-millisecond without anything saying so.
- **Phase D inherits the decision, not the API.** Two renames are expressible on every platform the
  kernel targets; a junction is not. The mechanism ports as written.

## Related

- `PLAN-public-release.md` step 15, contract (a) to (f).
- ADR-0028 (the kernel is TypeScript shipped as one binary) — why platform-portability decides ties.
- ADR-0027 (the program is separate from the workspace) — why reader material, including the vault,
  is never in the repository.
