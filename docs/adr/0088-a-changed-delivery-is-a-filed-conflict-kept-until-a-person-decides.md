# ADR-0088: A changed delivery is a filed conflict, kept until a person decides

**Status:** accepted
**Date:** 2026-11-04
**Effective from:** the release carrying c108-r3
**Amends:** [ADR-0081](0081-a-letter-crosses-libraries-once-by-path-and-is-filed-once-by-delivery-id.md), decisions 6 and 9

## Context

Filing once by delivery id stops duplicate notes, but it cannot tell whether a retry still carries the body that was
filed. Previously a changed inbox body could be moved to `delivered/` while the local note held the first body.
An outcome retry had the same gap. A check after the move reported a mismatch too late to keep that body visible.

## Decision

The signed `PLAN-postbox-filed-conflict.md`, implemented by c108-r3 for detection, extends the filing contract:

1. A letter, Report or outcome letter filed from the Postbox carries `postbox_wire_digest`, the digest of its kept
   wire body at filing. The receipt lives on the note, follows it through tidy, and outlives the incoming intent's
   thirty-day retention. Later commands do not update it from an edited local body (plan D1).
2. Each receiving writer looks for the delivery id across incoming letters, Reports and intent records under its
   own locks, reports then letters, before allocating or applying anything. Matching Book, kind and receipt preserve
   the ordinary retry. A different body is `changed`; a different Book or kind is `moved-book`; no receipt anywhere
   is `no-receipt`. Older already-filed notes with an inbox copy therefore need one explicit disposition after the
   upgrade rather than silently moving that copy (D2).
3. A conflict writes no Book note or intent and repeats no outcome effect. It stays in the inbox. Its cached row
   records the filed and inbox digests and location. Check names new conflicts, doctor warns about open conflicts,
   and the Desk counts them from the cache. Cache writes use one lock and fresh row mutations. A new inbox version
   is judged again. The fresh body is also checked before a move; the after-move check remains a second guard.
4. `deskpost postbox conflict` settles a conflict after a preview bound to the current filed and inbox bodies,
   conflict row and chosen disposition. `--keep-filed` leaves the inbox copy and records the decision; `--reopen`
   reverses only that decision and the left-copy row it added, preserving later cache writes. `--file-as-new` is
   letters only: it saves the exact rendered text and fixed copy path before publishing, completes the page, index
   and manifest under the letters lock, then links the original and records the unchanged inbox copy. An unfinished
   operation resumes with `--resume <op_id>` and needs no new approval. A changed inbox copy stays for the next check,
   and any newer recorded conflict stays open. Reports and outcomes cannot be copied, and a file-as-new decision
   cannot be reopened. Nothing replaces
   the filed body, deletes a server file or moves the changed body to `delivered/` (D3). Doctor names open conflicts
   and the resume command for each unfinished operation. Implemented by c116 (plan A5).
5. Controls receive the pre-move guard and locked identity check; broader control retry changes are outside this
   decision's implementation (D4). No notification goes back to the sender of a conflict (D5).

## Consequences

Changed retries remain visible without a second filing or repeated verdict. The receipt proves the received body,
not the current edited note. A person decides how to reconcile the two through the disposition command; a stale
plan is refused without a write, and a stopped copy resumes from its saved rendering. Pre-move reading narrows a race;
the server has no conditional move, so the gap between that read and the move remains. This unit supplies fixture
evidence and makes no live-server claim.
