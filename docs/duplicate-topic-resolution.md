# Duplicate Topic Resolution

> **Status:** proposed 2026-08-15, first applied to the cross-workspace duplicates found during the
> initial batch of Workspace Wiki Migration imports (Odysseus, LM Studio, Obsidian LiveSync, and
> Obsidian Local LLM Hub).

## Why this exists

[Workspace Wiki Migration](workspace-wiki-migration.md) already allows one specific kind of
duplication on purpose: a shared reference page copied into two Shelf Books so each stays
self-contained after a project/reference split. That is working as designed and is out of scope
here.

This document is about a different case. When several independently-authored external workspaces
get migrated as whole Books, the same real-world subject can turn up in more than one Book —
documented at different times, to different depth, sometimes covering different facets of the same
thing. Nobody decided to duplicate it; it just accumulated that way across separate workspaces. Left
alone, the reader has no way to know which copy is current, and a future search or read risks
surfacing the stale one.

## Recognizing a duplicate topic

Run `tools/Find-ShelfDuplicateTopics.ps1 -EmbeddingUrl <url> -ApiKey <TEI key>` (or set
`$env:TEI_EMBEDDING_URL` and `$env:TEI_API_KEY` first) before
manually eyeballing folder names across workspaces. It embeds every Book's whole-Book purpose and
every subfolder's `_index.md` via the reader's local TEI embedding service (see [Standalone TEI CPU
Embedding Service](workspace-wiki-migration.md), `llm-workflow-testing` Book), flags cross-Book pairs
above a cosine-similarity threshold (default 0.85), and never writes anything — read-only, like the
migration inventory tool. **There is no default endpoint**: it carried one reader's LAN address
until 2026-09-19, which is one reader's network travelling in everyone else's clone, so it refuses
and names the argument and the variable instead.

A lead becomes a durable record through `tools/Set-TopicOverlap.ps1` — see
[Topic overlap records](topic-overlap-records.md). Record it as `unverified` at this stage: the
relationship is not yet known, and an overlap noticed and never written down is one the next session
re-derives from scratch.

Matching folder names, page counts, or a high similarity score are a lead, not a verdict. Read the
actual pages before deciding anything. A "duplicate" spotted only by title, or only by the tool, can
turn out to be:

- a true duplicate (same facts, one copy just older or thinner), or
- complementary (each copy covers a different facet — e.g. one architectural, one operational — and
  neither is redundant on its own).

Only the first case gets resolved by this process. The second is not a duplicate; leave both in
place and note the relationship instead of merging.

## Survivorship rule, in order

1. If one copy is a strict superset of the other (same era, covers everything the other does plus
   more) — it is canonical.
2. Otherwise prefer the copy with more pages and a more recent source date on the pages that
   actually differ, not just a larger folder.
3. If the copies are genuinely tied, or turn out to be complementary rather than redundant, do not
   apply a rule — ask the reader.
4. Before stubbing anything, read every page in the losing copy. A page that holds a subtopic the
   canonical copy never covered is not a duplicate — carry it into the canonical Book as its own new
   page (with a one-line provenance note on where it came from) rather than stubbing it away.

## Canonical + stub pattern

Once a canonical Book is chosen for a topic:

- A genuinely redundant page in the other Book is replaced with a short stub: one line, a link to
  the canonical page, the date, and a note that it was superseded there.
- A genuinely unique page is copied into the canonical Book first, then the original is stubbed the
  same way — so nothing that existed only in the losing copy quietly disappears.
- The canonical Book's `_book.md` gets one added line recording what was merged in and why. Record
  the decision, not just the outcome — a future reader (or Librarian) should not have to re-derive
  the reasoning from a diff.
- Never delete the losing copy outright. A stub preserves the path in case something else still
  links to it, and it keeps an honest record that duplicate coverage existed and was resolved,
  rather than making it look like the topic was only ever documented once.

## When not to do this

- This is not a standing audit. The trigger is a reader-noticed duplicate, or a duplicate surfaced
  while proposing a new wiki migration — not a scheduled sweep of the whole Shelf.
- Don't touch the intentional shared-dependency pages [Workspace Wiki
  Migration](workspace-wiki-migration.md) already allows; those exist to keep a Book self-contained
  and are not the problem this document addresses.

## Key Takeaways

- Golden-record-style survivorship — most complete and most recent wins, ties go to the reader —
  replaces ad hoc judgment calls with a rule that can be applied the same way next time.
- Always read before stubbing. Page-count and folder-name overlap can hide a "duplicate" that is
  actually complementary content; merging those would destroy real information.
- A stub, not a deletion, is the default outcome for a superseded copy, and the canonical Book
  records why it won.
