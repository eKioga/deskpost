# The Shelf is a staging area, not storage

This page records a design intent that governed the Shelf from the beginning but was never written
down, which is why the Shelf grew an entrance and no exit. It is the reader's statement of purpose,
recorded 2026-08-20, not a derivation from the code.

## The principle

**The local Shelf is a waiting room. The shared collection is the destination.**

Every Book on the Shelf is there for one of two reasons:

1. It is **not ready for the shared catalog yet** — still being curated, deduplicated, or checked.
2. The **Librarian parked it there** to solve a problem in front of it — an import staged for
   review, a duplicate held while its overlap was resolved, material rescued from a workspace.

Neither reason is permanent. A Book that stays on the Shelf indefinitely is a Book **hidden from
every other machine that uses this Library**, sitting in local storage that grows without bound.

That defeats the point. The Library's value is centralised in Basic Memory precisely so Books can be
shared across the computers that use this workspace. A Book that never leaves the Shelf is a Book
the Library cannot do its job with.

**The steady state of a healthy Shelf is near-empty.** Growth is a signal, not an outcome.

## The lifecycle this implies

A Shelf Book has two reader-chosen exits:

- **Publish, verify, then delete locally.** The ordinary path. Create or refresh the shared Book,
  read back every page, verify its shared Catalog entry, and only then permanently delete the Shelf
  copy. `tools/Publish-ShelfBookToShared.ps1` binds both halves to one `plan_id` and one approval.
- **Move a selected batch under one approval.** `tools/Publish-ShelfBookBatchToShared.ps1` composes
  explicit per-Book publish-or-delete plans into one content-bound batch approval. Each Book still
  verifies before its local deletion; a failed item is journalled and left on the Shelf while later
  independent items continue. The Holding Shelf is excluded because untriaged captures are not a
  batch-deletion target. After an exit, reconcile any now-stale Shelf-only topic-overlap records
  with `Set-TopicOverlap.ps1 -Action Remove`; that exact removal remains allowed after either Book
  has left the Shelf, but creating or changing a record still requires live Shelf Books.
- **Delete without publishing.** The Book was parked to solve a problem, the problem is solved, and
  it was never destined for the shared collection. `tools/Remove-ShelfBook.ps1` previews every file
  and permanently deletes it only after an exact approval.

In both cases deletion is the reader's decision. The Librarian may offer it and execute an approved
bounded plan; it never decides unilaterally that the reader's material should disappear.

## Archive compatibility

Archiving is a shared-collection concept. `Archive-ShelfBook.ps1` and `shelf/_archive/` remain in
place for compatibility with Books already moved there, but they are not an exit in the active Shelf
lifecycle and the connected workflow does not use them. This task neither migrates nor deletes
anything already in that compatibility area.

## What is missing

Naming it plainly, because four rounds of publication work happened without it being stated:

- **No signal that the Shelf is drifting.** `Get-DeskOverview.ps1` reports what is on the Shelf. It
  does not distinguish a Book that arrived yesterday from one that has been waiting for months, so
  unbounded growth is invisible until someone looks. Whether the answer is a counter, an age
  signal, or a triage offer at a natural pause is an open design question — and this workspace has
  a standing note against building a prompt for a problem before the evidence appears. Gather the
  evidence first.

The connected publish-and-delete workflow records `publishing`, `published-awaiting-local-delete`,
and `complete` locally, so an interrupted second half is reported rather than mistaken for success.

## Why this page exists

The whole 2026-08 development run — Phases 0 through 3, the Codex partnership, four rounds of
publication defects — began when the reader tried to move Books off the Shelf into the shared
catalog and found the path did not exist. The path exists now. **The concept behind it did not, and
that is what this page fixes:** the Shelf was always meant to drain, and a workspace that never
says so will keep growing an entrance without an exit.

## Live acceptance

On 2026-08-21, the first complete curated-Shelf batch published and verified eight Books, deleted
one superseded local map, and left only the Holding Shelf. The reader confirmed the experience felt
like Books simply moved into the shared catalog. This proves the batch workflow's intended reader
experience; it does not authorize automatic migration of future Books without their own bounded
preflight and approval.
