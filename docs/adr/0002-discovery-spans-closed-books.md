# Discovery spans closed Books; reading does not

The Library could not search itself: the validated reader offers only exact-path reads, and
shared-collection search is denied outright. With 743 Shelf pages and twelve shared Books, the only
discovery surface was catalog blurbs. We are adding two tiers — **Discovery** over catalog-class
metadata (summaries, reader maps, page titles and headings) across *all* Books including closed
ones, and full-text search confined to Books that are **open**.

## Status

accepted — 2026-08-17

## Considered options

Confining discovery to open Books was the safer-looking option, and it is the one that appears to
respect "closed means unavailable." It was rejected because it does not solve the actual problem:
if you must open a Book to learn whether it is relevant, you cannot find anything you have not
already memorised.

## Consequences

This looks like a weakening of the Desk boundary and is in fact the opposite. The Desk exists for
context hygiene — keeping unrelated material from crowding the Librarian's attention. Without
discovery, the only way to test a Book's relevance is to open it, so a wrong guess loads an
irrelevant Book into context. That is the pollution the Desk exists to prevent, caused by the
absence of the feature. Discovery means opening one Book instead of three.

The precedent already exists: both catalogs stay readable while every Book is closed, because
browsing is not reading. A reader map is catalog-class material.

**Capture Books are the one exception, and it is enforced in storage rather than in the query.** A
closed capture Book exposes counts only — never a note's title or body — because naming an individual
note is reading it. That boundary predates this decision and was acceptance-tested with leak canaries.

Filtering what Discovery *returns* would not preserve it. The metadata manifest is itself
catalog-class and closed-readable, so a capture Book's page titles held there would be exposed to any
other reader of that path, whatever Discovery chose to show. Therefore a `Kind: capture` Book's
closed-readable manifest contains **its summary and pending count and nothing else**; its page-level
metadata is generated only behind the Book-open gate and stored where that gate applies. Its pages
join Discovery normally once the Book is open, and the leak canaries assert the *stored manifest* is
clean, not merely the query result.

The reasoning holds because captures are *unvetted* material the reader has not yet looked at, so
surfacing their titles is not orientation — it is the review they deliberately deferred.

Three constraints follow and must not be dropped. **A heading is not a claim** — discovery results
license a suggestion to open a Book, never an answer about what that Book says; the Librarian must
not reason from titles as though they were content. And **metadata becomes load-bearing**, so Book
summaries and the canonical/superseded marks are now part of the retrieval surface rather than
decoration.
