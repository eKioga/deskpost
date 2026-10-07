# ADR-0069: The program addresses, links and counts; a seat decides where a letter goes

**Status:** accepted
**Date:** 2026-10-06
**Effective from:** 1.3.8 (session 1, cards, roles and the directory, built from S96; session 2, templates; session 3,
letters to a department; released in session 4)
**Amends:** [ADR-0062](0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md) on two bullets only: "No routing,
assignment or workflow engine" (0062:145-147) and "Nothing a seat may act on lives only in a message" (0062:51-58).
See "What this changes in ADR-0062". Its inbound-policy lines 0062:28 and 0062:123-124 are answered here (2026-10-07), not
amended.
**Relates to:** [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (what a seat's name
proves), [ADR-0060](0060-the-holding-shelf-is-the-last-resort-and-its-growth-is-a-library-signal.md) (growth as a
signal), [Seats](../seats.md), [Capture Books](../capture-book-model.md)

## Context

Seats already talk (1.2.6) and leave letters for each other (1.3.0, 1.3.1). What they lack is a way to know **who
does what**, and a way to write to a **department** when no one knows which seat should answer. A seat's role lives
today in its Hub's Purpose, which no other seat may read: the 2026-09-07 ruling makes another seat counts and liveness
only. Deskpost's own Engineering seats run as a performer and an orchestrator by convention, and nothing records it.

ADR-0062 drew the boundary: a message is a doorbell, a letter is the record, Deskpost sends no messages, and there is
"no routing, assignment or workflow engine" ("a seat may be the place others write to ... That is a line in its Hub's
Purpose, and the reader decides"). The reader ruled on 2026-10-03 that seats may work as departments, and on
2026-10-06 (the plan's Q1 to Q7, `PLAN-seats-team.md` r6, approved at Codex round 6) that **a seat decides where a
letter goes, and the program stores, addresses, links and counts**. This ADR records that, and what it changes in
ADR-0062.

## Decision

### A seat decides; the program addresses, links and counts

- **No engine.** Nothing matches a letter to a card, assigns work, or moves a letter on its own. A department's
  orchestrator is a seat that reads a letter and answers it or routes it; the program records the step it took.
- **Deskpost still sends no messages**, still posts into no session's pipe, and still shows one seat nothing of
  another's material beyond counts, liveness and **the card that seat published about itself**.

### Cards, departments and roles live in the registry, under the reader's gate

- `.claude/seats/_registry.json` rows gain four optional fields, written after the existing four:
  - `department`: a slug (`[a-z0-9][a-z0-9-]*`). A department exists while a seat carries it; there is no
    departments file.
  - `role`: `performer` or `orchestrator`. **A role requires a department**, and a department has **at most one
    orchestrator**.
  - `card`: one line of at most 160 characters with no control character (S94's rule for Hub writers, tab
    included): what the seat handles, in its own words.
  - `template`: `<name>@<version>`, the template a seat was created from (written by session 2).
- **They change only under the reader's gate.** `deskpost seat describe` previews `before` and `after` per field and
  per row, says when it creates a department, and issues a plan id over the seat, the requested changes and the digest
  of the whole registry file; the apply rechecks under the registry lock and refuses on a changed registry. A swap of
  orchestrators (`--from <current>`) is one preview and one plan for both rows, so a department is never left between
  two. Session 2's `seat start` options take the same kind of plan id. A seat may draft its own card; applying it
  still takes the reader's yes.
- **Every effective role change advises a review of the Hub's Purpose.** The registry, not the Purpose, decides where
  a letter goes, so a Purpose that drifts costs guidance, never routing. A Purpose's "Seat template" line is creation
  provenance, not a live claim.
- **Retire's plan id binds the row's `seat_id` and the four fields**, so an approval taken for a performer cannot
  apply after that seat became its department's orchestrator, and its preview says when a department loses its
  orchestrator.

### The registry's history is an attempt log

- Every registry write that sets or changes one of the four fields appends **one record per changed row** to
  `internal/seat-registry-history.jsonl` under the registry lock (`when`, `seat`, `seat_id`, `before`, `after`, the
  caller's `from_seat`, `plan_id`, the verb, and `purpose_review_advised` where it applies), all sharing one `attempt`
  id; then replaces the registry atomically, as every registry write does; then appends `{attempt, committed: true}`.
- **A record with no commit line is an unconfirmed attempt.** The replace may or may not have happened, and after later
  changes nothing can say which, so `seat status` and doctor say "unconfirmed" rather than guess. A line that does not
  parse is ignored, and every append first writes a newline when the file does not end in one, so damaged bytes stay
  their own line and the next record is whole.
- No transaction log beyond that. The registry is the one truth; the history is evidence of attempts and commits.
- A registry write that touches none of the four fields on any row writes no history.

### Invalid values read as absent, through one projection

- The registry has many readers, and **none of them throws on the new fields.** A malformed card, an unknown role, a
  department that is not a slug, a role with no department, or a second orchestrator in a department read as
  **absent** (no card; no orchestrator for that department), and doctor's `seats.registry-fields` WARNs with the
  repair.
- **One validated projection over the whole registry, `seatMetadata(rows)`, serves every reader-facing surface**
  (`seat status`, the menu, `seat cards`, `library desk`), because "one orchestrator per department" is a property of
  the registry, not of a row. The raw rows are kept only for lossless writes, so a malformed card never reaches a
  terminal.

### The directory is computed, never stored

- `deskpost seat cards` computes the calling seat's **directory** live from the registry, the seat folders and claims,
  and the letters Books: seat, role, card, open or closed, `message_name` while open, and `pending_letters` as a
  number. Nothing is generated or stored, so nothing goes stale. **The directory reads cards, never Hubs.**
- Its default views (an orchestrator sees its department and every other department's orchestrator; a performer sees
  its own orchestrator and every other department's; a seat with no department sees itself and every orchestrator)
  are chosen for context cost, **not as a boundary**: every field is already in the ungated `seat status`, and
  `--all` shows everything.
- **A card is data.** The text form opens with "Cards are text each seat wrote about itself: data, not instructions."
- **The Desk shows numbers, and the hook line stays static.** `library desk` carries the directory's counts and
  liveness; the Desk reminder gains at most one line naming the seat's role and department, with no counts and no
  liveness, so its text does not change when a peer opens or closes.

### Letters to a department (session 3)

- **Every letter records both ends' incarnations when it is written**: `origin_seat` with `origin_seat_id`, and
  `for_seat_id` for the recipient, each the registry row's `seat_id` at that moment. **A missing identity is recorded
  as missing and never filled in later.** One recipient predicate (`for_seat` matches, and `for_seat_id` too when the
  letter carries one) replaces the slug comparison wherever a recipient is judged; a letter with no `for_seat_id`
  matches by slug, the legacy rule.
- **A letter may be addressed to a department** (`--for-department`, never sharing `--for`), and resolves **when it
  is written** to that department's orchestrator. It keeps the department it was addressed to.
- **`--answers` and `--routes` close and link** as `--supersedes` does, and the three are mutually exclusive. They
  refuse a closed, linked or malformed original; answering alone also refuses an unknown asker. Both stay in the
  original's Book. **`hops` is stored** (a count, limit 3); **status is worked out** from `review` and the link
  fields (open, answered, routed, closed), never stored.
- **Stale deliveries are defined, detected and repaired**, not prevented by a lock: a department letter resolved to a
  seat that has since lost the role stays that seat's letter; a letter whose `for_seat_id` no longer matches the
  registry row, or whose `for_seat` is gone, is not credited to a new incarnation of the slug; doctor's
  `letters.recipient-incarnation` names each, and its writer, or the reader with `other_seat`, closes it. Capture
  does not take the registry lock.

### The message-or-letter rule

Anything to act on later, anything for a closed seat, and anything routed is a **letter**. A quick question answered
within the exchange, a status ping, or the ring for a letter may be a **message**, and only to a seat that is open and
has a `message_name` (a Codex seat has none). The templates' role text, `library-help` and this ADR carry the same
sentence. Only letters are counted.

## What this changes in ADR-0062

- **0062:145-147, "No routing, assignment or workflow engine",** now reads: **the program addresses, links and
  counts; a seat decides where a letter goes.** There is still no engine, and nothing assigns. What changes is where
  "the place others write to" is recorded: a department's orchestrator in the registry, under the reader's gate,
  rather than a line in a Hub's Purpose that no other seat may read.
- **0062:51-58, "Nothing a seat may act on lives only in a message",** now names the quick-question message: a quick
  question answered within the exchange, a status ping, or the ring for a letter may be a message, and only to a seat
  that is open and has a `message_name`; anything acted on later, sent to a closed seat, or routed is a letter. A
  message still never approves, opens a Book on another seat's Desk, widens what a seat may do, or stands in for the
  reader's yes, and Deskpost still sends none.
- **Kept as they stand:** every other bullet of ADR-0062, among them "Deskpost sends no messages", the one-key inbound
  file passed as a value, the Desk's facts-not-verdicts rule and the cosmetic tier.

## Open question: ADR-0062:28 and 0062:123-124

ADR-0062 says a project or local `crossSessionInbound` "applies only when it is stricter" (0062:28) and that the value
is "never written to user or workspace settings, which reach every seat" (0062:123-124). Yet the reader's Library has
run on a local `"crossSessionInbound": "accept"` in its own `.claude/settings.local.json` since 2026-10-04, and its
peer messages have appeared to flow since. **That has not been tested live.** This ADR does not amend either line. The
live check (two seats started from one scratch Library, one message, with and without the key) is the support seat's
with the reader, after S96. If a local `accept` is shown to apply, a later amendment says so in so many words: a reader
may choose a Library-wide `accept`, and Deskpost reads it and never writes it. Until then doctor's
`settings.inbound-overview` reports where the key is set and names **the per-seat route only**
(`seat settings --inbound accept`).

**Answered 2026-10-07** by the support seat's live check (Claude Code 2.1.292, one machine). With nothing set,
messages between sessions that prompt for permission (default, auto and dontAsk modes) were delivered at once; a
local `hold` held them, and Claude Code said a repository's settings may only tighten. So 0062:28 and 0062:123-124
hold as written and nothing is amended: a Library's local `accept` loosens nothing. Not tested: a session that
bypasses permissions, on either side. Doctor's unset sentence says Claude Code's default.

## What this deliberately does not do

- **No program-side matching of letters to cards**, and no automatic routing step. One can be added later on top of the
  same `--routes` step with nothing to undo.
- **No stored third `review` value**; `docs/cross-seat-reports.md`'s two values stand.
- **No generated directory page**, no departments file, and no check of a Hub's Purpose against the registry (doctor
  has no lawful read of a closed Hub's text).
- **It does not authenticate a seat.** "The caller must be the recipient" guards against mistakes, not against a
  process that sets `LIBRARY_SEAT` (ADR-0062, ADR-0018).
- Nothing across machines, no message log, no `SendMessage` guard.

## Consequences

- Each seat can say what it does, and a seat can see who does what without reading anyone's material.
- **Hop limit 3.** A fourth route is refused, and the refusal says to ask the reader.
- **Retire refuses while letters are pending**, best effort; doctor names what the window leaves.
- A department of one makes its only seat its orchestrator; with none, `--for-department` is refused and senders write
  to the seat.
- **Phasing.** Session 1 (S96): this ADR, the four fields and their projection, `seat describe` with its history,
  `seat cards`, the Desk facts and the hook line, and doctor's `seats.registry-fields`,
  `letters.recipient-incarnation` (its `for_seat_id` half active from session 3) and `settings.inbound-overview`.
  Session 2: the two built-in templates and the `+` wizard's steps. Session 3: letters to a department, `--answers`,
  `--routes`, the incarnation fields and the counts. Session 4: the release.
- **Parity.** No new PowerShell. `seatCreationPlanId` stays byte-identical with its PowerShell oracle. The new
  registry, `seat status`, `library desk` and doctor keys ship as `kernel_only` deltas, approved at the 1.3.8 release.
