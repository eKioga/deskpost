# Graduating a whole topic into a Shelf Book

> **Status:** implemented and tested, 2026-08-17. Builds directly on
> [Graduating a page into a Shelf Book](shelf-book-graduation.md) and the writer
> [ADR-0001](adr/0001-shelf-books-accept-pages-when-open.md) established.

## The defect

`Add-ShelfBookPage.ps1` graduates one page safely. Graduating a topic meant calling it once per
article, and Codex Round-1 finding #8 is what that costs: a multi-page "additive" call can fail
halfway, and there was no manifest, no journal, no collision policy, and no resume rule. A retry
after a partial failure could not tell which pages had already landed, so it re-attempted everything
and created duplicate suffixed pages — the exact outcome graduation exists to stop.

## Reader benefit

A finished Notebook topic joins the Book it belongs to in one call, and an interrupted run is
finished by repeating the same command rather than by working out by hand which of eleven articles
made it across.

## Safety boundary

**Additive, and provably so — inherited, not re-derived.** Every page is written by
`Add-ShelfBookPage.ps1`, never by a second implementation. That helper already takes the Book's lock,
journals the page's prior absence, creates with `CreateNew`, verifies by readback, and handles both
reader-map shapes. This one orchestrates and records; it does not write pages. So the additive
guarantee is the same guarantee, not a parallel one that has to be argued again.

**The lock is taken and released per page.** That is what makes an interrupted run resumable instead
of leaving one long hold behind, and it keeps the writer inside the 30-minute stale-lock window
rather than depending on it.

**Resume, not undo — the distinctive shape.** When a multi-page write is interrupted partway, the
pages that landed are correct and complete. Keeping them is the right outcome; rolling them back
would discard finished work for nothing. This is the opposite of the rename in 1.1 and the single
page in 1.2, whose correct response to a failure is to leave no trace, and it is why this writer
needed its own fault coverage rather than a variation on theirs.

**Two independent ways to know an entry is done, because one of them can be lost.**

- The *progress journal* records each entry's outcome. It is a different artifact from
  `BookWriteGuard.ps1`'s rollback journal and must not be mistaken for it: the rollback journal
  undoes one page's write, this one records what already landed so a later process can tell. It is
  rewritten in full after every entry, via a temp file and a replacing move, because a journal
  written only at the end cannot survive the interruption it exists for, and a truncated progress
  record is worse than a slightly stale one — resume trusts it.
- *Idempotence by content* is the one that still works when the journal died with the process that
  wrote it. A target page that already exists and is byte-identical to what this operation would
  write counts as success. "Identical" means identical to the bytes a single-page write would
  produce, which is why the H1-and-title normalisation is now shared with `Add-ShelfBookPage.ps1`
  through `ConvertTo-ShelfPageBody` rather than reimplemented — comparing against the raw source
  instead would call every page divergent.

**A divergent collision refuses the whole operation before any write.** A target that exists with
different content is not suffixed around; suffixing is how the duplicates were being made. The
preflight reports it as `blocked` with the offending pages named, so the reader sees the full picture
before anything is attempted rather than discovering it mid-run.

**The manifest digest binds the operation.** It covers the Book, every source path, every source
hash, and every target. A source edited between attempts produces a different digest, so an earlier
journal no longer applies and the run starts clean instead of resuming against material that has
moved underneath it.

**An article without a leading H1 is refused by name, at preflight.** A Book page's title is
curatorial, and deriving one from the filename is a guess this helper does not make. A topic index
(`_index.md`, `_book.md`) is skipped and reported, not carried across — it is the Notebook's own map,
and it would collide with the Book's reader map.

**A partial run is never reported as success.** `status` is `complete` only when every entry
succeeded; otherwise it is `incomplete`, with per-entry results and the count that failed. On
failure the run continues to the remaining entries rather than stopping, because the reader's goal is
to graduate what can be graduated — but the honest total is what gets reported.

## Acceptance evidence

**Sandbox**, `tools/Test-LibraryHelpers.ps1`, against a disposable fixture workspace — 41 new
assertions, 164 total. Refused, each by name: a closed Book, a capture Book, a missing source
directory, and an article with no leading H1. Verified at preflight: the manifest binds three
articles, the topic index is skipped rather than graduated, no confirmation is required, and no
folder is created.

**Fault injection — the shape neither 1.1 nor 1.2 covers.** A directory standing where the second
page's file must go fails exactly that entry while the first and third succeed. This needs no
test-only surface in the helper, and the manifest still classes the blocked entry as pending because
a container is not a page. Asserted: the run reports `incomplete` with two succeeded and one failed,
both unobstructed pages are on disk, and the progress journal exists. Then, with the obstruction
removed and the same command repeated: the run reports `complete`, recognises the earlier journal,
lands the unfinished entry — and the two pages that had already landed are **byte-identical**, which
is the assertion that proves resume rather than rewrite.

Also asserted: with the journal deleted entirely, a rerun recognises all three pages as already
present and identical and rewrites none of them; a source edited after graduation is reported as a
divergent collision and refuses the operation without touching the existing page; adding an article
changes the manifest digest and leaves exactly one entry pending; and with the reader map made
unwritable, the pending entry fails, the child rolls its own page back rather than leaving it half
written, and pages that had already landed are undisturbed.

**Live Library.** Preflight only, against the open `library-dev` Shelf Book, plus a live refusal
against the closed `odysseus`. The preflight correctly read `library-dev`'s **curated** map and
reported `append each link; this map is curated, so it is not regenerated`, with
`reader_map_unlisted` at 0 through the one-hop rule. It created no pages, no folder, and no journal.

One honest limit on that evidence: `notebook/` currently holds only `_master-index.md`, so there was
no real Notebook topic to point at and the live source was `docs/adr` instead. That exercises the
Book side fully — the catalog, the Desk gate, the real curated map, the digest — but the intended
source shape, a Notebook topic with its own `_index.md`, has been proved only against fixtures. The
skip-the-topic-index path is sandbox-tested, not yet live-tested.
The executing write is deliberately left for a real graduation: it is additive, and there is still no
bounded helper that removes a Shelf page again.

## Key Takeaways

- `tools/Add-ShelfBookTopic.ps1` graduates a directory of articles into a Shelf Book that is **open
  on the Desk**. Additive only, applies directly, no `plan_id`.
- It composes with `Add-ShelfBookPage.ps1` rather than duplicating it, so the lock, the journal, the
  create-new semantics, the readback, and both reader-map shapes are the same code.
- Repeating the same command after a failure is the supported recovery. Only unfinished entries are
  attempted; pages that already landed are left byte-identical.
- An identical existing page is success; a divergent one refuses the whole operation before any
  write.
- Editing a source between attempts changes the manifest digest, which retires the old journal
  rather than resuming against moved material.
- Run `tools/Test-LibraryHelpers.ps1` after any change to `Add-ShelfBookTopic.ps1`,
  `Add-ShelfBookPage.ps1`, or the shared `ConvertTo-ShelfPageBody` / `ConvertTo-BookPagePath` in
  `ShelfNoteCommon.ps1`.
