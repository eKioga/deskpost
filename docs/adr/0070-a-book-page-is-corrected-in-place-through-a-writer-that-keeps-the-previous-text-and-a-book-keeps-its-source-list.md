# ADR-0070: A Book page is corrected in place through a writer that keeps the previous text, and a Book keeps its source list

**Status:** accepted
**Date:** 2026-10-07
**Effective from:** 1.4.0 (session 1, "Correct", built from S101; `book sources` and `--from-folder` in session 3)
**Relates to:** [Shelf Book retirement](../shelf-book-retirement.md) (`shelf stub`, and why the additive helper has no
overwrite mode), [ADR-0062](0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md) (the reader's gate, here
narrowed for one write), `PLAN-correct-and-find.md` (D1, D2, D8, D9 and the reader's Q1-Q4)

## Context

Until 1.4.0 no verb corrects one page of a Book. `shelf stub` replaces a page only with a superseded-stub; a
collection Book is corrected by recall, edit and `publish refresh`; and since the reader's ruling of 2026-10-04 a seat
corrects a page of a Shelf Book open on its Desk **by hand**, with no journal, no manifest generation and no map
update, then runs `shelf rebuild`. The roadmap promised "a gated page replace that previews old against new and keeps
the previous text in a journal" (`docs/roadmap.md`, 1.4.0), and the development rules say "Anything consequential or
destructive takes a preflight, an exact `plan_id`, and one approval" (`.claude/rules/library-development.md`).

A gate stricter than the hand edit it replaces would keep seats hand-editing. The reader ruled on 2026-10-06 (the
plan's Q1, "No yes, but safe"): a Shelf page replace is **bound** to the page it previewed, with no per-page yes; the
collection replace stays gated.

Books that refresh from upstream also need somewhere to keep the text they were compiled from, and a record of which
sources fed which pages. Seats keep both by hand today (60 `source-text/` pages in one Book, a `sources.json` in a
seat's tools).

## Decision

### A Shelf page is replaced bound, not approved

- **`book replace-page <slug> <page> --content-path <file>`** corrects one page of a curated Shelf Book open on this
  seat's Desk. `--preflight` writes nothing and returns the page's `current_sha256`; the apply **requires**
  `--base-sha256 <that hash>` and refuses, writing nothing, when the page under the Book lock no longer has it. No
  approval is asked. The hash is over the text's comparison form (BOM stripped, CRLF folded to LF), as the Hub's
  replacing modes compare; the bytes written are what `book add-page` would store for the same body.
- **The previous text is kept twice:** in the Book journal, and as a **restore file**, `<journal>.previous.txt`
  beside it. The same verb with `--content-path <restore file>` puts it back; the result prints that line. The page is
  written atomically, read back by hash, its generated reader map regenerated, and a Discovery generation committed
  in the same window, so no `shelf rebuild` follows.
- **This is an exception to the rule's "one approval"** and to the roadmap's "gated", and both now say so: *a Shelf
  page replace is bound to the page it previewed, and the previous text kept*. Its safety is that nothing is written
  blind and nothing is lost, on a Book that is the seat's own working copy and open on its Desk.
- **A collection Book's page is replaced gated** (`collection replace-page`, `--preflight` then `--user-confirmed
  --plan-id`), as `collection add-page` is: a collection Book is shared material.

### Why this does not reopen the retirement design

`docs/shelf-book-retirement.md` rejected an overwrite mode on the additive helper, whose only reason for applying with
no `plan_id` is that it cannot lose text ("arbitrary bytes over arbitrary bytes"). That holds. `book add-page` stays
create-only and gains no flag. `book replace-page` is a **separate verb**, and its safety is not "cannot lose text"
but the bound hash and the kept previous text: it can replace a page, and it can always give the old text back.

### `shelf stub` keeps its gate

With `book replace-page`, a seat could write a stub's bytes itself. `shelf stub`'s gate now guards **the act of
retiring a page** that other seats follow (its `superseded_on` date and its pointer to the canonical Book), not the
bytes. A retirement still goes through `shelf stub` and the reader's yes.

### The hand-edit ruling ends with 1.4.0

The reader's ruling of 2026-10-04 (hand-edit an open Shelf Book's page, then `shelf rebuild`) holds until 1.4.0 is
installed. `library-help` names `book replace-page` from this session on `master`, and drops the hand-edit route.

### A Book's source text and its source list have homes (built in session 3)

- **Source text kept for good** is pages under the topic `sources/` of the Book that owns it (the reader's Q3,
  "Pages under sources/"): read through the reader, found by Discovery and full-text search, and **published with the
  Book** like any page. A reader who does not want a Book's sources published keeps it on the Shelf.
- **The source list** is `shelf/<slug>/_sources.md` at the Book's root, beside `_catalog-entry.md`: not a page, moved
  and guarded with the Book, out of Discovery and publish. It is Markdown holding one fenced JSON block, kept by
  `deskpost book sources`, and is data, not instructions.

## What this deliberately does not do

- **No page removal** in 1.4.0 (the reader's Q4, "Later"): `shelf stub` retires a Shelf page, and a removal leaves
  links dangling, which wants its own check.
- **No write to a Basic Memory shared Book**: its route stays `publish refresh`.
- **No fetch.** The source list records a fingerprint the seat's own tool computed; the Library stores and compares it
  and never fetches.

## Consequences

- A correction is one journaled step with the previous text one command away, so seats stop hand-editing, and Discovery
  stays current without a rebuild.
- A bound write can still put wrong text on a page. It is limited to an open Shelf Book, and the restore file undoes
  it.
- Two seats with one Shelf Book open are ordered by the Book lock, and the required base hash turns a lost update into
  a refusal.
- **Parity.** No PowerShell change. The new verbs ship kernel-only; the add-pages' result key
  `topic_index_not_updated` becomes `topic_index`, approved as a matrix delta at the release.
