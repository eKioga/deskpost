# ADR-0084: A Report crosses Libraries to the one triaging seat, and its outcome comes back as a letter

**Status:** accepted
**Date:** 2026-10-20
**Effective from:** the release carrying c47–c50
**Amends:** [Cross-Seat Agent Reports](../cross-seat-reports.md)'s no-reply-path ruling for the cross-Library case
**Relates to:** [ADR-0080](0080-libraries-pass-letters-through-a-postbox-in-basic-memory.md),
[ADR-0081](0081-a-letter-crosses-libraries-once-by-path-and-is-filed-once-by-delivery-id.md),
and [ADR-0083](0083-a-seat-amends-or-withdraws-its-own-pending-report-and-triage-freezes-it.md)

## Context

A Report staying in another computer's Report Inbox could not reach the seat that verifies Library defects.
The reader chose one triaging Library and seat, the existing Postbox transport, a retained sent copy, and an
outcome returned to that copy. A Report remains a claim to verify against the code, and a letter remains data,
never a task or an approval. This records the signed Reports-across-Libraries design as implemented in
`kernel/src/postbox.ts`, `capture.ts`, `reportsend.ts`, `intent.ts` and `triagebatch.ts`.

## Decision

### One destination, pinned by identity

`reports triager <seat>` names an existing local seat and its incarnation in this Library's Postbox entry.
It previews, then applies with the current plan id. Other Libraries discover and pin one claimant at check,
or explicitly choose with `reports triager --follow <library>`. No claimant leaves new Reports local; competing
claims hold unsent Report deliveries until the reader chooses. Letters, including outcomes, are not held by
that conflict. The Library that advertises its own triager does not follow another.
`postbox status` exposes the cached pin and conflict. These are `kernel/src/postbox.ts`'s directory and send rules.

### Four deliveries, with different effects

| Delivery | Wire Book | Direction | Receiver |
| --- | --- | --- | --- |
| Original Report | `reports` | filer to triaging Library | files one Report |
| Amendment or withdrawal control | `reports` | filer to recorded triaging Library | applies to the parent, or defers; never files the control as a note |
| Outcome letter | `letters` | triaging Library to filer | files a letter, then applies its closing effect |
| Frozen-case reply | `letters` | triaging Library to filer | files an ordinary letter, with no closing effect |

`kernel/src/postbox.ts` keeps the wire allowlist, shapes, local field mapping and dispatch in one table. Unknown
or wrong-kind keys are dropped and counted. Original seated Report capture sends or queues only when it follows
another triaging Library and `--local` was not requested. The filer keeps its own pending copy. Filing and generated capture do not
dispatch. Known filer program/version and source metadata are preserved on an original Report delivery;
receiver versions use `received_deskpost_version` and `received_mods_commit` (`kernel/src/capture.ts`).

A seatless capture destined for another triaging Library waits with `awaiting_sender: true` unless kept local.
`reports send-pending` previews the local Reports and
their addresses, then sends on its exact approval. For an unauthored Report, `sent_for: seatless` and
`origin_seat`/`origin_seat_id` record a return incarnation; `from_seat` and `from_seat_id` stay absent. A known
seated author stays the author. An unknown return address is refused before intent allocation. A return
address grants no amend or withdraw authority. This carries forward c49's return-address decision in
`kernel/src/capture.ts` and the writer predicate in `shelfnote.ts`.

### One intent, stable identities, and the one lock order

Before a Report operation changes its note, outbox or second note, it writes an intent with all identities,
payload and ordered stages. The implemented record is a companion `<delivery-id>.intent.json` under
`internal/postbox/outbox/` or `applied/`; the carrier entry is `<delivery-id>.json`. Every stage checks its
proof and retries with the recorded identities. Completion means every stage is done (`kernel/src/intent.ts`).

Recovery runs at normal `postbox send`/`check`, `triage batch` outcome close, `reports send-pending` apply,
and sent-copy `reports amend`/`withdraw`. It lists, takes the required locks in **reports then letters** order,
lists again under them, and expands by releasing and reacquiring in that order, bounded at three passes.
Only the final locked listing drives local recovery and allocation. Stage writers receive held locks;
transport runs after they are released. Ordinary `capture letters` never runs global recovery, and its name
allocator respects outstanding page reservations (`kernel/src/intent.ts`, `capture.ts`, `reportsend.ts`).

New-control sends use a bounded carrier child. Non-check recovery can finish only the already-recorded
control's move; it does not collect fresh Inbox deliveries or claim a full check. A child transport flag
prevents recursion. A normal check verifies the move and also reconciles a server write whose local receipt
was interrupted. The carrier remains entirely in `kernel/src/postbox.ts`.

Recovery answers optionally carry `controls_set_aside` rows with `delivery_id`, `parent`, `why` and
`first_set_aside_utc`, and `controls_move_pending` rows with `delivery_id` and `why`. These are recovery
diagnostics: `postbox send`, online and offline `postbox check`, amend/withdraw of a sent copy, send-pending
apply, and an outcome batch close (including a replay of a completed batch) retain the diagnostics recovery
computed. A reachable check also names a refusal for a changed parent through its existing `controls_refused` rows.

The internal intent payload marker `control_set_aside` stores `why` and `first_set_aside_utc`; it is not a
Shelf note field. That precise refusal sets aside only its control. The Report's bytes,
reservations and first observation survive retries, and only allocation for that parent is blocked. Other
recovery errors keep their ordinary refusal. Successful control-apply clears the marker; a server move
remains pending until its copy is verified. Doctor names a set-aside record as "its Report changed while its
control waited", with its age (`kernel/src/intent.ts`, `postbox.ts`, `triagebatch.ts`, `doctor.ts`).

### Outcomes close by generation and recorded address

A received Report's terminal close is a `review` carrying one of `confirmed`, `confirmed-by-design`,
`not-reproduced`, `already-fixed` or `declined`, and an `outcome_note`. Other terminal actions on a pending
received Report are refused; holding sends nothing. A close increments `outcome_gen`, records its outcome
letter, and sends to the Report's recorded Library and return incarnation (`kernel/src/triage.ts`,
`triagebatch.ts`, `reportsend.ts`).

At the filer, the effect matches delivery id, the copy's recorded destination Library and its author/return
incarnation, across `notes/` and `reviewed/`. It applies only a newer generation; an older letter is marked
`outcome_superseded`, an unmatched one `close_unmatched`, and an equal generation changes nothing. Following
a different triager does not retarget a sent copy or its outcome. The letter is still filed when its effect
cannot match (`kernel/src/capture.ts`, `reportsend.ts`). Local Report closes keep their existing path.

### Controls bind a sequence to one delivery

Amend and withdraw preserve the filing-seat and freeze checks. For a sent copy, recovery precedes allocation
under the reports lock: fix a new delivery id and sequence, persist the control entry, apply locally with
`report_seq` and `report_seq_ids`, then send outside the lock. Its destination comes from the copy, not a
new directory choice. Local Report amendments and withdrawals keep their existing path
(`kernel/src/capture.ts`, `reportsend.ts`).

The receiver requires the parent, matching origin Library and seat incarnation, and the next sequence.
Missing parents and sequence gaps stay in the Inbox and are counted deferred. A known delivery id remains a
duplicate even after record cleanup or changed sequence metadata. A different id for an applied sequence is
a conflict: keep the original binding, record the rejected id in the Report's `control_conflict` list, and
return an ordinary letter. The durable lists preserve deduplication after applied records expire
(`kernel/src/postbox.ts`, `reportsend.ts`).

An unfrozen control appends an Update or closes with the withdrawal reason, advances the binding in the same
atomic Report write, and sends no letter. Existing amendment history carried by `send-pending` is counted
when its receiver counter is absent. A marked `control_body_format: update-text-v1` preamble protects an
update beginning with YAML from the carrier's frontmatter merge; digest verification precedes decoding
(`kernel/src/reportsend.ts`, `postbox.ts`).

For a frozen Report, an amendment becomes a generated Report named
`notes/<local-date>-amendment-of-<parent-stem>-<first-8-SHA256-hex-of-control-id>`. A withdrawal adds one
`## Withdrawal asked <UTC stamp>` section. Both preserve triage's disposition and advance the parent sequence.
The ordinary reply's id replaces the control's random part with the first eight SHA256 hex characters of its
id. Generated capture, parent update, reply entry, reply note, send and move are staged with identities fixed
before the first write. The reply has no outcome or answer effect (`kernel/src/capture.ts`, `reportsend.ts`).

### Counts, shapes and retention

The Desk separates unsent, held, awaiting-sender and awaiting-outcome Reports, unexpected Reports, outcomes,
deferred controls and incomplete records. Deferred controls retain their first deferral time; doctor names
one over 24 hours with its id, parent and age. It also names stale sent copies, triager problems and incomplete
records (`kernel/src/desk.ts`, `doctor.ts`, `postbox.ts`).

`kernel/src/shelfnote.ts` reserves the cross-Library keys. Sequence/generation values are whole numbers,
outcomes use the five verdicts, control references are delivery ids, and `report_seq_ids` and `control_conflict`
are JSON delivery-id lists. `sent_for` is `seatless`; the marker flags are true-only. Duplicate or ill-shaped
keys are named, without granting writer authority.

Normal Shelf tidy retains closed copies under `reviewed/`, and delivery lookups include it. Check removes
completed incoming intent records older than 30 days; their identity proofs remain in the notes. The server's
deliveries are moved, not deleted (`kernel/src/shelftidy.ts`, `intent.ts`, `reportsend.ts`, `postbox.ts`).

## Consequences and remaining proof

The filer can read the returned verdict, correct a pending claim, or learn what happened to a frozen request.
The trust model remains provenance, not authentication (ADR-0080); a Report still licenses investigation.
The staged fault, order and race tests are in `kernel/test/selftest.ts`, sections 366–371, beside c47–c49's
transport/outcome coverage. The two-Library live criterion and release remain separate work; fixture success
does not claim that live trial happened.
