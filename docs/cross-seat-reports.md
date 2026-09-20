# Cross-Seat Agent Reports

> **Status:** implemented 2026-09-11, proposed the same day. The sections below are kept in the order
> they were written — defect, decision, benefit, boundary — because the reader benefit and safety
> boundary had to be recorded *before* the build, and rewriting them afterwards to match what shipped
> would destroy the only evidence that they were.
>
> **No open questions remain.** The three the first draft carried were each answerable from the code
> rather than by judgement, and are recorded as rulings — see *Why the transcript is not read* and
> *Two rulings, taken rather than left open*. What shipped is at the end, under *What was built*.

## The defect

Seats made the Library multi-agent. [ADR-0015](adr/0015-the-desk-is-per-seat-one-library-many-seats.md)
gave every agent its own Desk over one shared collection, and [Seats](seats.md) states the split
exactly: *"One checkout, one collection, one Shelf, one Notebook, one lock namespace, one Discovery
index, N Desks."*

What it did not give them is a way to tell each other anything.

An agent at a research seat hits a bug in a helper, or a gap where a tool should exist and does not.
That agent is not the one who will fix it — `library-dev` is — and it is mid-task on something else
entirely. Today the finding has exactly one route out: the reader reads it, copies it, carries it to
a `library-dev` session, and pastes it. So the cost of reporting a defect is paid by the human, in
proportion to how much context the defect needs, at the moment they are least interested in it.

The predictable consequence is not that reports get delayed. It is that small ones stop being made.
A one-line tooling annoyance is never worth a copy-paste round trip, so it is absorbed silently and
hit again by the next agent. This is the same shape as the defect that produced capture in the first
place — see [Capture Books](capture-book-model.md), where the reader's only options were to publish a
one-note Book or lose the note, and in practice the reset just got delayed.

**And the report that does get carried arrives stripped.** A paste is a summary. The conversation
where the defect actually happened — the commands, the arguments, the output — stays behind at the
other seat, where `library-dev` cannot reach it.

## Decision

**A second capture Book, not a messaging system.**

A capture Book is an ordinary Shelf Book whose `shelf/_catalog.md` entry carries `- **Kind:**
capture`. `ShelfNoteCommon.ps1` is explicit that the catalog is the only authority and *"no slug is
special-cased in code, so a reader can retire or add a capture Book by editing shelf/\_catalog.md."*
The Shelf is workspace-wide, so a Book on it is already visible to every seat.

That makes the cross-seat channel a catalog entry rather than a mechanism. Four pieces already work
and are not rebuilt:

| Piece | What already does it |
| --- | --- |
| The write | `Add-ShelfNote.ps1` takes `-BookSlug` (default `holding`) and is deliberately ungated: no confirmation, no open Book, and no seat or claim is consulted anywhere in it |
| The notification | `Get-DeskOverview.ps1` enumerates capture Books by scanning the catalog, so a new one reports its own `pending_count`, `reviewed_count` and `oldest_pending` as a separate line |
| The read gate | It opens and closes as any Shelf Book does, and `Guard-ShelfBookRead.ps1` already denies a closed one — a capture Book *is* a Shelf Book |
| The delivery | Triage's `-To Project -Slug <s>` sends a note to an active Project Hub, gated with a `plan_id` and one approval ([Library Inventory and Triage](library-triage-design.md)) |

So the flow is: an agent at any seat captures a report → `library-dev`'s Desk overview shows a
pending count on its own line → `library-dev` opens the Book and reads the note through the validated
reader → triage routes it to the Hub's `Next`, or discards it under approval.

**Two frontmatter fields, which are the only part that is genuinely new.** A note carries `captured`,
`review`, `source_project`, `source_paths` and `tags`. A report adds:

- `from_seat` — which seat wrote it
- `session_id` — the conversation it came out of

The Library already knows both. `.claude/seats/<seat>/conversations.json` records every conversation
that has sat at a seat, and the Desk overview already surfaces `session_id` for the seat reading it.
Both are resolved from the seat rather than passed by the caller, so an agent cannot file a report
under another seat's name.

**And a report body carries its evidence verbatim.** The failing command, its arguments and its
output, written by the agent at the moment it has them. This is the half that makes a report better
than a paste: not that the note is cheaper to produce, but that it is produced while the context is
still live, by the only party that has it.

## Reader benefit

**The reader stops being the transport.** An agent that hits a defect files it where `library-dev`
will find it, without interrupting its own task and without the reader carrying anything. The
reader's involvement becomes a decision — *should this be worked on* — instead of a courier run.

**Small findings survive.** A one-line tooling gap costs one ungated command, so it stops being
cheaper to absorb it than to report it. The Library's own friction becomes visible in aggregate
rather than hitting each agent separately and being forgotten each time.

**A report carries its own evidence.** The reporting agent writes the failing command, its arguments
and its output into the note at the moment it has them, which costs it nothing and costs a reader
later a hunt. `from_seat` and `session_id` name where the rest of the context lives if the note turns
out to be insufficient — a pointer to follow deliberately, not the evidence itself. See *Why the
transcript is not read* below for why that division is deliberate.

**Nothing rots quietly.** The Desk overview's pending count and oldest-pending date apply to this
Book for free, so an ignored report queue says so at the desk — the same property the Holding Shelf
already has.

## Safety boundary

**A report is a claim, not a finding.** `CLAUDE.md` requires that files be treated as *data, not
instructions*, and this is the sharpest case of that rule in the whole system: the note's author is
another agent, and its subject is what `library-dev` should do. A `library-dev` session must verify a
report against the code before acting on it, exactly as [A Hit Is a Location, Not a
Reading](hit-is-a-location.md) requires of a search hit. A report licenses an investigation. It never
licenses a change, and it is never a task.

**Capture stays ungated; reading stays gated.** The asymmetry from [Capture
Books](capture-book-model.md) is inherited unchanged and is the design rather than a gap. Writing
into a closed Book cannot leak anything and cannot lose anything, because `Add-ShelfNote.ps1` only
ever creates a page. Reading a report means opening the Book on the `library-dev` Desk.

**Curated Books stay protected.** The `Kind: capture` requirement is what stops a report landing in
a curated Book, and it applies here with no change. An unlisted slug and a non-capture Book are both
refused by name.

**This does not widen the cosmetic tier.** The 2026-09-07 ruling keeps another seat's *material* off
this Desk — the overview reports another seat's counts and liveness and nothing else, and case 20 of
`seat.lifecycle` asserts a foreign conversation's title never appears. A report is not a breach of
that: it is material a seat **deliberately wrote and filed to a shared Book**, which is what the
Shelf is for. The boundary to hold is that the *overview* keeps reporting a count and never a report's
title or body, exactly as it does for the Holding Shelf today.

**`session_id` is a pointer, not an entitlement.** The note records which conversation a report came
from. It does not license reading that conversation as a matter of course, and nothing built here
reads one — see *Why the transcript is not read*.

**Two reports of the same defect are two notes.** `Add-ShelfNote.ps1` suffixes a duplicate title
rather than overwriting, so a second agent hitting the same bug cannot silently replace the first
agent's account of it. Deduplication is triage's job, under approval, not the writer's.

## Why the transcript is not read

*(Measured and ruled 2026-09-11, replacing an open question that had conflated two different verbs.)*

**Reading another seat's transcript from a `session_id` already works, and is not seat-scoped.**
`Get-SeatTranscriptPath` locates `<session_id>.jsonl` by scanning every project directory under the
transcript root rather than composing a path — deliberately, because Claude Code's workspace-to-
directory mangling is undocumented and *"a picker that reimplemented that rule would be a lookalike
of the consumer whose files it is reading."* A conversation id is a uuid, so the filename is unique
across all of them. `Get-SeatConversationTitle` then opens and reads the file, and does so on every
picker roster draw. So the capability is present and proven.

**Resuming is a different verb and is the wrong one.** `--resume <id>` handed to a launched agent
does not bring evidence to `library-dev`; it launches a process *into* the other seat's conversation.

The design declines the capability it has, for three reasons:

- **The budget that exists is for a title, not a defect.** The transcript reader scans a head of
  2,000 lines or 4 MB for one marker string. Finding a bug means reading the span around an unknown
  point in a file whose lines are *"tens of kilobytes"* each. No budget covers that and no helper
  does it, so "read the transcript" is unbounded work disguised as a pointer.
- **Scope.** The 2026-09-07 cosmetic-tier ruling keeps another seat's material off this Desk, and a
  transcript is the most material thing in the system: everything that seat did, not the defect.
  Filing a report is consent to share the report, not the session.
- **The cheaper half is also the better half.** Evidence written when the context is live is more
  accurate than evidence reconstructed from a transcript later, and costs the reporting agent almost
  nothing.

So `session_id` is recorded as provenance and followed deliberately — by a person who has read the
note, found it insufficient, and decided to go look. It is never a routine step in triage.

## The naming question

Folded in at the reader's request, 2026-09-11, after the reader read "the Holding Shelf is a capture
Book" and said it hurt to think of a shelf as a kind of book.

**The objection is correct and the glossary walked past its own rule.** [CONTEXT.md](../CONTEXT.md)
defines **Shelf** as *"the reader's own collection of Books"* and, four entries later, **Holding
Shelf** as *"the Library's capture Book."* The word *Shelf* therefore means a collection in one
entry and a single Book in the next. The `_Avoid_` lines exist to stop exactly this, but they only
ever compare whole terms and never the words inside a compound one.

**This repository has already ruled against the same shape.** [Seats](seats.md), *There is no default
seat*: the seat name `main` collided with `BASIC_MEMORY_DEFAULT_PROJECT=main`, and it was thrown out
as *"one word for two unrelated concepts, exactly what the glossary's `_Avoid_` lines exist to
prevent."* The Holding Shelf is that defect sitting inside the glossary.

**The rename that produced the name was answering a different question.** On 2026-08-17 *Notes Inbox*
became *Holding Shelf* for one stated reason: *"an inbox receives from outside and this receives from
the reader's own Notebook"* ([Capture Books](capture-book-model.md)). That is an argument against
**Inbox**. Nothing in it considered *Shelf* against *Shelf*. So this is a question that was never
asked, not a settled one being reopened.

**The report Book is the case that reasoning leaves room for.** A report arrives from another seat —
from outside the reader's own Notebook, which is precisely the condition the 2026-08-17 rule uses to
license the word. Naming the pair so the contrast carries the meaning:

| Book | Receives from | Disposition |
| --- | --- | --- |
| **Holding Shelf** (`shelf/holding`) | the reader's own Notebook | discard, or graduate to a Book |
| **Report Inbox** (`shelf/reports`) | another agent's seat | investigate, then close or route to `Next` |

This makes the Holding Shelf's `_Avoid_: Inbox` line meaningful rather than arbitrary — it stops
saying *never use this word* and starts saying *that word belongs to the other one*. `CONTEXT.md`
would need a **Report Inbox** entry saying so; the `_Avoid_` line on Holding Shelf would need to name
the distinction rather than the prohibition.

**Renaming the Holding Shelf is deliberately not proposed** (ruled by the reader, 2026-09-11). The
last rename needed `Rename-ShelfBook.ps1` with a preflight naming every live reference, one approval
bound to the catalog and every page hash, a journal and a rollback verified by readback; it surfaced
two defects in `BookWriteGuard.ps1`; and it added the `shelf.references-resolve` gate check because a
rename touch-list rots. It is proven and it is not free. The cheaper move is to let the pair teach
the distinction and see whether the collision still hurts once there are two Books and the contrast
is visible.

## What this costs

Separating what rides existing machinery from what is actual work, because the first list is what
makes this proposal cheap and the second is what makes it a build.

**Free — no code change:**

- The write. `-BookSlug reports` works the moment the catalog entry and `shelf/reports/wiki/` exist;
  `Add-ShelfNote.ps1` creates the `notes/` directory itself and regenerates the reader map from disk.
- The pending count on the Desk overview, per Book, on its own line.
- Open, close, guard, and reading through `read_open_book_page`.
- Triage's existing routes, including `-To Project`.

**Actual work:**

1. **Creating the Book.** There is no `New-ShelfBook.ps1`. `Add-CatalogEntry.ps1` targets the
   *shared* Catalog over MCP, not the Shelf, and `Import-ExternalWikiToShelf.ps1` needs an external
   wiki. So this is either a hand-made directory plus a hand edit to `shelf/_catalog.md`, or a small
   new helper. Given that every capture write parses that catalog and `shelf.references-resolve`
   fails the commit on a catalog entry with no Book on disk, a helper is the safer shape.
2. **The two frontmatter fields.** `from_seat` and `session_id` in `Add-ShelfNote.ps1` and in the
   frontmatter contract in `ShelfNoteCommon.ps1`, resolved from the seat rather than passed by the
   caller — an agent must not be able to file a report under another seat's name.
3. **`CONTEXT.md`.** A **Report Inbox** entry, and the Holding Shelf's `_Avoid_` line reworded from a
   prohibition to a distinction.
4. **The `library-help` Skill and the guides.** The reader experience changes, so the Skill is
   updated in the same pass — that rule is already standing.

## What is deliberately not built

**No addressing.** One report Book, read by `library-dev`. A `for_seat` field and an overview that
filters by it wait on a condition, and the condition is narrower than it first looks.

*(Sharpened by the reader, 2026-09-11. This paragraph first said addressing was worth building "when
a second recipient exists" — which **any** seat wanting to leave a note satisfies, including the
peer-to-peer case the next paragraphs reject. A trigger that fires on the thing you decided against
is not a trigger.)*

**The condition is a second seat that serves a support role**, the way `library-dev` does for the
Library itself. That is what makes an unaddressed inbox work: a support seat is a **hub**, so
"everyone → the maintainer" needs no `for_seat` field, no filtering, and no reply path, because the
reply is the work itself. Two hubs would still be two unaddressed Books. It is *peer* traffic that
would force addressing, and peer traffic is what the Library already answers another way — see
below.

Until such a seat exists, the cost is real and unpaid-for: **the Desk overview reports every capture
Book's pending count to every seat**, so a third capture Book puts two counts on every Desk that
owns neither.

**No peer-to-peer channel, because the Library already is one.** *(Settled with the reader
2026-09-11, when the question "does this handle agent-to-agent communication too?" was asked
directly.)* Three shapes hide under that question and only one of them was missing:

| Shape | Answer |
| --- | --- |
| knowledge that matters to another subject | the **collection** — a Notebook article or a Book page, discoverable *by topic, by anyone, for as long as it is kept*. Addressing it to a seat would make it findable only by that seat and only while that seat exists, which is strictly worse. The Holding Shelf is already cross-seat if it needs a home before it is sorted |
| something about the Library itself | the **Report Inbox** — hub-and-spoke, not peer traffic |
| "seat B should go look at X" | **no route, structurally.** The seat↔project binding is unique in both directions because `notebook/<slug>/` and `output/<slug>/` cannot have two owners (`LibrarySeat.ps1`), and `Edit-ProjectHub.ps1` refuses on the grounds that "a Hub open at another seat must not entitle this one". So this goes through the reader, by hand |

The third is a genuine gap and is **deliberately left open**. An inbox per seat would close it with no
new code, and would buy a `for_seat` field, a filtered overview, orphaned Books when a seat retires,
and an invitation to converse in a medium with no reply path. The right time to choose is when a real
session wants it, because that incident also says whether the answer is an inbox at all — or whether
those two subjects should share a Notebook topic, or are one project.

**No delivery guarantee, no read receipts, no threading.** A report is a page in a Book. If a reply
is needed, it is a reply to the reader, not to the other agent — the agent that filed the report has
very likely finished its task and gone.

**No new guard.** A capture Book is a Shelf Book, so the existing guard covers it. [Capture
Books](capture-book-model.md) recorded that `Guard-ShelfBookRead.ps1` denied a read against the new
closed capture Book on the first attempt with no changes, and the same should be re-confirmed here
rather than assumed.

**No automatic triage.** Nothing reads a report and acts on it. The safety boundary above is the
whole reason: a report is another agent's claim about what this project should do.

**No transcript reading.** The capability exists and is declined on purpose, with the reasoning
recorded above rather than left implicit — a later session that discovers `Get-SeatTranscriptPath`
will find this section instead of concluding nobody had noticed.

## Two rulings, taken rather than left open

Both were open questions in the first draft of this document. Neither needed a judgement call; both
were answerable by tracing a real report through the code, and are recorded here so the next session
does not re-ask them.

### A report keeps `review: pending|done`. No disposition set of its own.

The temptation is real — a report's lifecycle reads as *investigate → confirmed or won't-fix →
closed*, which is not *discard or graduate*. It is still refused, for three reasons in increasing
order of weight.

**A third value has no route to be written.** `TriagePlanCommon.ps1` sets `new_review` to exactly
`'done'`, or to `'pending'` under `-Reopen`, and `Test-ShelfNoteBoundary.ps1` pins both. Nothing in
the system can write `wont-fix` to a note short of a hand edit.

**And if one were written, it would read as pending forever.** Three consumers independently define
pending as *not done*: the Desk overview's `pending_count`, and the reader-map generator, which files
every note whose `review` is not `done` under `## Pending review`. A `wont-fix` report would sit in
the count and under that heading permanently. This is not a schema that needs extending; it is a
binary asserted in three places, and a third value is a silent defect in all of them.

**The dispositions already exist, and they are better ones.** A confirmed report triages to the
Hub's `Next`, where [ADR-0013](adr/0013-a-hub-section-holds-only-what-the-project-can-close.md)
governs its whole life. One that will not be worked goes to the Hub's `limits` page, which already
carries **accepted**, **awaiting** and **promoted** — a richer vocabulary than any frontmatter enum,
attached to the place the project actually reasons about its own queue. Repeating that lifecycle in
note frontmatter would put two definitions of one rule in two files, which is this codebase's
most-repeated defect.

So the note's `review` field answers one question only — *has anyone looked at this yet* — and the
verdict lives wherever that class of thing already lives.

**The gap this leaves, stated rather than discovered.** A report investigated and **rejected** goes
to `done` with no record of why, so the next agent can hit the same thing and report it again. There
is no route to annotate a note in place: `Add-ShelfNote.ps1` only ever creates a page, and triage's
review kind only regex-replaces the `review:` line. Closing it would need either a new note-body
writer, or a convention that the rejecting session captures a short reply note into the same Book —
which works today, with no new code, because capture is create-only and ungated. **Neither is built
on speculation.** Wait for a rejected report that someone actually re-reports.

### The naming ruling earns an ADR, written when the Book ships

It meets all three of the bar in [`docs/_index.md`](_index.md) — hard to reverse, surprising without
context, the result of a real trade-off. A reader who finds one capture Book called a Shelf and
another called an Inbox, while the glossary's `_Avoid_` line on the first one says not to call it an
Inbox, is exactly the reader an ADR is for.

It was deliberately **not** written while this was a proposal. An ADR recording *"let the pair teach
the distinction"* is stranded if the pair never exists, and the collision would then need deciding
from scratch against a situation this document did not anticipate.
[ADR-0005](adr/0005-the-hub-page-size-harness-stays-a-throwaway.md) is this repository's own
precedent for not building ceremony around something that may stay a proposal.

**The condition was ship time, and it was met the same day**:
[ADR-0020](adr/0020-a-capture-books-name-does-not-reuse-a-glossary-term.md) carries both halves — the
rule that a capture Book's name must not reuse a glossary term at a different scope, and the decision
not to rename the Holding Shelf.

## What was built

*(2026-09-11. The sections above are the design as it stood before the build and are deliberately not
rewritten to match; this is what shipped.)*

| Piece | Where |
| --- | --- |
| `New-ShelfBook.ps1` | creates an empty Shelf Book, curated or `-Capture`. The gap named under *What this costs* — it composes the entry with the Shelf composer and commits it inside the render lock, so the derived catalog is never hand-edited |
| `from_seat`, `session_id` | `Add-ShelfNote.ps1` resolves both; `ShelfNoteCommon.ps1` surfaces them. No parameter sets either |
| The **Report Inbox** | `shelf/reports`, created through the helper on 2026-09-11 |
| Glossary | [CONTEXT.md](../CONTEXT.md) gained a **Report Inbox** entry, and the Holding Shelf's `_Avoid_` line became a distinction rather than a prohibition |
| Reader-facing help | the `library-help` Skill routes *"something in the Library itself is broken"*, and its capture reference carries the two-Book table |
| Regression cover | eleven cases in `shelf-note.boundary-suite`, which was already registered — a new suite would have owed the `-Fast` roster a name |

**Two things the build corrected in this document's own reasoning.**

*What this costs* listed creating the Book as possibly "a hand-made directory plus a hand edit to
`shelf/_catalog.md`". **That option never existed.** The catalog is rendered from each Book's
`_catalog-entry.md` under the render lock, so a hand edit to it is overwritten by the next render.
The helper was the only route, not the safer of two.

And `New-ShelfBook.ps1`'s first draft carried a guard for *"a catalog entry with no Book under it"*
that **no input could reach**: an entry file lives at `shelf/<slug>/_catalog-entry.md`, so its
directory exists whenever it does, and the existing-Book guard always fired first. It is one guard
with two messages now, and the suite proves the husk refusal is distinguishable from the
existing-Book one rather than merely proving something was refused.

**What is verified.** The complete gate passes with nothing skipped — `-IncludeShared`, 94 checks, 0
failed. The single warning is `New-ShelfBook.ps1` awaiting its `.claude/settings.json` allowlist
line, which the Librarian is refused by design and which warns rather than fails for exactly that
reason. Four injected regressions were each caught by the case written for it, with a control case
proving the run had not simply broken.

**And the end-to-end path was exercised live rather than only against fixtures**, which is what
`.claude/rules/library-development.md` asks for before a reader-experience change: the Book created
through the helper, a real report filed into it — `from_seat: library-dev`, a resolved `session_id`
— and the Desk overview reporting `reports` pending 1 beside `holding` pending 0, which is the
separation this design argued for, observed rather than asserted.
