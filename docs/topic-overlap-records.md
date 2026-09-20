# Topic Overlap Records

> **Status:** built 2026-08-18 as Plan item 2.1, the first item of Phase 2. The records exist; no
> pages have been merged or stubbed, which is deliberate and is the next section's subject.

## What this is for

Several Shelf Books cover the same real-world subject. That is **conversion residue**, not a filing
habit: the Books were converted from separate LLM Wiki workspaces and the conversions were not
uniformly clean. Left unrecorded, a reader has no way to tell which copy is current, and the
Librarian re-derives the answer — differently — every time it comes up.

A single per-Book `Status` cannot hold the answer, because the answer is not per Book.
`agentic-os-development` is **superseded** for the `2nd-b` material and remains **canonical** for its
Odysseus and household-platform pages. Both are true of that Book at the same time. So the record is
scoped to a *topic* and a *pair of Books*, and a Book carries as many records as it has overlapping
subjects.

## The helper

`tools/Set-TopicOverlap.ps1`, with `-Action Add`, `Set`, `Remove`, `List`, or `Validate`.

```
tools/Set-TopicOverlap.ps1 -Action Add -Topic obsidian-tooling `
    -Slug agentic-os-development -Counterpart 2nd-b -Relationship unverified
```

Records live in `internal/overlap-records.json` — application-managed, and untracked for the same
reason the Shelf is: a checkout that recovers a script must not roll back what the reader decided
about their own Books.

## What a record holds

| Field | Meaning |
| --- | --- |
| `topic` | The reader's word for the shared subject. A lowercase slug, not a page path. |
| `book` | The Book the relationship reads *from*. |
| `counterpart` | The other Book in the pair. |
| `relationship` | `unverified`, `complementary`, or `canonical` (see below). |
| `resolution` | `open`, `accepted`, or `resolved`. |
| `date` | ISO `yyyy-MM-dd`. |
| `note` | One line on why, for whoever finds this in six months. |

**`unverified`** — an overlap is suspected and nobody has read both copies. This is the honest
starting state, and `tools/Find-ShelfDuplicateTopics.ps1` produces leads of exactly this quality.

**`complementary`** — both copies were read and each covers a facet the other does not.
[Duplicate topic resolution](duplicate-topic-resolution.md) is explicit that this is *not* a
duplicate: leave both in place and record the relationship instead of merging.

**`canonical`** — `book` is the canonical copy for this topic and `counterpart` is superseded.

## The two rules worth explaining

**A contradiction is unrepresentable, not merely detected.** The record key is the topic plus the
*unordered* Book pair, so "A is canonical for B" and "B is canonical for A" are the same key and the
second is refused as a duplicate. There is no pair of records that can disagree, which is a stronger
property than a validator that looks for disagreement — a validator can be skipped, and a key cannot.
Correcting the direction is `-Action Set` naming the pair the other way round; it replaces the record
rather than adding one.

**A relationship and a resolution state that cannot both be true are refused.** `resolved` means the
losing copy was reconciled, so it requires a losing copy — only `canonical` has one. `accepted` means
the reader looked and decided there was nothing to merge, which only `complementary` offers. And
nothing can be settled about a pair nobody has read, so `unverified` is `open` and nothing else.
Changing the relationship resets the resolution: a state settled under the old reading of a pair is
not evidence about the new one.

## The boundary, stated because it is the whole point

**This helper never reads a Book body.** It reads `shelf/_catalog.md`, which is catalog-class and
readable while every Book is closed, and it writes one record file. That is why it runs with an empty
Desk — and it is also the limit on what a record *means*. A relationship recorded here is the
reader's judgment, entered by hand. It is never a claim this process derived from pages it read, and
nothing about the record file should be read as evidence that the pages were compared.

Comparing them is a Desk operation. `duplicate-topic-resolution.md`'s survivorship rule requires
reading every page of the losing copy before anything is stubbed, precisely so a page holding a
subtopic the canonical copy never covered is carried across instead of disappearing. That read-through
is out of scope this iteration and is far cheaper once 2.2's Discovery lands, which is why the plan
sequences it that way.

## Known limits

- **Shelf Books only.** Dangling-slug validation is done against `shelf/_catalog.md`. The shared Book
  Catalog is reachable only over MCP, which a plain helper process does not have, so a record naming
  a shared Book could not be validated and is therefore not accepted. If shared overlaps ever need
  recording, that is a schema version and a second slug space, not a loosened check.
- **Records go stale silently on their own.** A Book renamed or archived after a record was written
  leaves the record naming a Book that no longer exists. Nothing else in the tree would notice, which
  is why `Invoke-LibraryChecks.ps1`'s `shelf.overlap-records` check re-validates the whole file on
  every commit rather than only when a record is added.
- **`Find-ShelfDuplicateTopics.ps1` produces leads, not records.** Matching folder names, page counts,
  and a high similarity score are grounds for an `unverified` record and nothing stronger.

## Key Takeaways

- Overlap is a property of a *topic and a pair of Books*, not of a Book — one Book is routinely
  canonical for one subject and superseded for another.
- The unordered pair key makes a contradictory record impossible to write, rather than catching it
  afterwards; the relationship/resolution table does the same for states that cannot both be true.
- Recording a relationship is not comparing the pages. Nothing here licenses an answer about what
  either copy says.
