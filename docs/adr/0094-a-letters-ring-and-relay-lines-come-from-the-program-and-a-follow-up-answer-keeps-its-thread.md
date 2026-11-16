# ADR-0094: A letter's ring and relay lines come from the program, and a follow-up answer keeps its thread

**Status:** accepted
**Date:** 2026-11-14
**Amends:** [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md) on ring text and answers to closed letters.

## Decision

Eric signed PLAN-letters-ring.md on 2026-11-13. A writer should receive the exact line to send, and a later answer should keep the original thread. This is unit L1 of that plan.

After a local letter is captured and the recipient's reach is read, a recipient other than Codex gets `ring_line`: `From <seat>: a letter for you, letters notes/<page>`. `ring_to` is its `recipient_message_name`, or null when there is none. The existing `next` ring sentence quotes `ring_line`; its closed, not-yet-named and Codex explanations remain.

When `DESKPOST_ASSISTANT=codex` and the recipient is a held Claude seat, named or not yet named, capture also returns `relay_line`: `Tell <seat>: a letter for you, letters notes/<page>`. Its `next` says `Put this line in your reply for Eric: "<relay_line>"`. The Codex writer puts that line in its reply for Eric to relay. A Codex recipient, a closed recipient, a cross-Library letter and a Postbox filing get no relay line. The kernel sends no message.

For one ring covering several letters to one seat, the forms are:

```text
From <seat>: <n> letters for you, letters notes/<a>, notes/<b>
Tell <seat>: <n> letters for you, letters notes/<a>, notes/<b>
```

The recipient reads every named page. This unit defines those combined forms; it writes neither. The mods' later unit M uses them.

The follow-up answer is implemented: a later answer keeps the original thread and leaves a closed original unchanged.

`--answers` closes an open letter as before. For a letter addressed to this seat that is already closed, however it was closed, it writes a follow-up with `answers:` and addresses the first asker as before. It leaves the original bytes unchanged, returns `answered: {page, status: "unchanged"}`, and explains that the reply is linked and the original stays closed. Address, incarnation and frontmatter checks still apply before and under the lock. `letters close` and `--routes` retain their existing rules.

A pending letter carrying `answered_by` or `routed_to` is reopened. It still refuses `--answers` and `letters close`. `letters list` shows it after open letters with `reopened: true` and the remedy: answer with a new letter `--for` the asker, or close it with triage. A partial answer is also a new letter `--for` the asker. The Desk count and `openLettersFor` stay unchanged. `letters list` JSON `count` counts open letters; `reopened_count`, present only when there are reopened letters, counts those separately.

A `--section` tidy's pointer names the moved section, where that section stood.

## Later units

L2 adds required `--wants answer|action|info`, its frontmatter and first body line, `wants` across the Postbox, `letters loose`, and newly recorded eval outputs. M keeps the ring record and end-of-turn reminder in the mods. Neither is implemented by L1.

## Proof

Sections 1400 to 1403 in the hubs-and-letters lane pass: exact ring and relay lines with explicit writer harnesses; follow-up links, original SHA-256 equality and unchanged close/route rules; separate open and reopened JSON counts; and moved-section pointer names, placement and order. Section 169's closed-letter refusal row was removed. Section 277 checks the moved heading as a whole line; section 740 checks successful follow-up answers and an unchanged original with repeat close saying already closed. Existing ring, reach, own-close, route and protected-guidance pins remain required.
