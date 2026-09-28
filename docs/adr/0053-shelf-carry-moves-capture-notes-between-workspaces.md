# ADR-0053: `library shelf carry` moves capture notes between workspaces, byte for byte

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S53, `PLAN-basic-memory.md` step 4b)

## Context

Eric's Holding Shelf is mostly Deskpost feature ideas (15 of 21 pending notes, read in S51). Their home is the new
Library's `deskpost-dev` Project, not Basic Memory, so the import never carries them. The Report Inbox's still-true
notes are in the same position. The cutover needs one step that moves them.

## Decision

- **`library shelf carry <old-workspace> --book <capture-book>`**, previewed with `--preflight` and confirmed with
  `--user-confirmed --plan-id`. The `plan_id` hashes the sorted `(file name, sha, action)` lines, and is re-checked
  under the Book lock.
- **It is called carry, not import,** because the glossary's Import is an external document set brought into the
  collection as a Book, and this moves notes between two Shelves.
- **Byte for byte, and the old workspace is only read.** A note keeps its file name, `captured:` and `review:`. A note
  already here byte-identical is skipped. A same-name note with different content is a named conflict and is left
  alone on both sides. Only capture Books are accepted, at both ends.
- **`--book reports` carries `review: pending` notes only.** `review:` has no "still true" state, so the old
  workspace's triage marks each settled Report `done` first. Every other capture Book carries whole.
- **Inside capture's own mutation window:** Book lock → manifest mutation → a journal of every path → `wx` creates →
  the reader map regenerated → the manifest committed. The Shelf's manifest therefore ends clean. A failure restores
  the journal.
- **Provenance is kept and said.** A carried note keeps the `from_seat` and `session_id` it was written with, which
  nothing in the new Library resolves. The preview says so.

## Consequences

- The cutover checklist's step 1 runs it twice: `--book holding`, then `--book reports` after the old Report Inbox
  has been triaged.
- Kernel self-test section 45 judges the counts, byte-exact copies and review states, the conflict, the clean
  manifest, the old workspace's bytes before and after, a re-run that carries nothing, pending-only Reports, and the
  refusal of a non-capture Book.
