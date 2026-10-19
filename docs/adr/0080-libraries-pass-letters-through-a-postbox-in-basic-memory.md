# ADR-0080: Libraries pass letters through a Postbox in Basic Memory

**Status:** accepted
**Date:** 2026-10-15
**Effective from:** the release that carries s121 (1.5.0's first session); sending and receiving follow in its second
**Amends:** [ADR-0062](0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md), its three `from_seat_source` words
(the fourth, `postbox`) and its "Nothing across machines"; [ADR-0069](0069-the-program-addresses-links-and-counts-a-seat-decides-where-a-letter-goes.md),
its "Nothing across machines"
**Relates to:** [ADR-0050](0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md) (a Basic Memory project
is kept by its UUID), [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md)
(every request and answer between seats is a letter), and `PLAN-many-libraries.md` r8, Stage 1 (signed off by the
reader 2026-10-08)

## Context

A letter could reach only a seat of the same Library. The reader runs more than one computer, and a household may
share one collection, so Libraries on different computers need to write to each other. ADR-0062 said "Nothing across
machines" and left a household postbox to a later spike over a shared folder. The reader chose Basic Memory as the
carrier instead (the plan's Q1): it is reachable from every computer and Claude account the household uses, and the
reader has run it for months. Basic Memory documents no conditional write for a self-hosted note, and it reports most
refused writes as ordinary results (B's Stage 0 probes, 2026-10-15), so the design cannot lean on the server to stop a
duplicate.

## Decision

1. **A Library has a card.** `.library/workspace.json` gains `card`, a display name set by `deskpost library card
   --set <name>` under a preflight and a plan id. The marker's `id` stays the identity. A card is a label: never a
   credential, never an address on its own, and nothing finds a Library on disk by it. The Desk carries `library:
   {id, card}`, and `collection owner`'s status names the card beside the id.
2. **One Deskpost project, and a Postbox inside it.** Everything Deskpost keeps in Basic Memory lives in one project,
   chosen from the server's own list by name (`deskpost` by default) and recorded by UUID as the connection's
   `collection_id` (ADR-0050). `deskpost postbox setup` creates the project only on the yes its preflight named,
   refuses when the connection already records a different project (naming both), and refuses a Library with no
   `letters` Book. It reads, moves and changes no other project, and nothing outside `postbox/`.
3. **Each Library's Postbox entry.** Setup writes `postbox/libraries/<library-id>.md` with `overwrite: false` (or
   refreshes the Library's own), holding its id, its card, when it last checked, and each seat that may receive
   letters with its `seat_id`, and reads it back. A card another id already holds is refused with that id. In prose it
   is "the Library's Postbox entry", never a registration (the glossary keeps that word from Binding).
   `postbox check`, and so each session's check, refreshes the entry and reads it back whenever the Library's
   receiving seats have changed since it was last written, and writes nothing otherwise, so the entry's `last_check`
   is the time of its last refresh (s128).
4. **An address is one registered Library**: its id, or a card that matches exactly one entry (compared without
   regard to case). None or several is refused with the list, and a letter is never queued to an unregistered id.
5. **A letter can name a Library.** New reserved, shaped keys: `from_library_id`, `from_library_card`,
   `for_library_id`, `origin_library_id`, `delivery_id`, `origin_delivery_id`, `answers_delivery_id`, `postbox_path`,
   `stale_delivery`, `postbox_damaged`. A letter with no Library field is local, so every letter before 1.5.0 stays
   valid and a local letter's frontmatter does not change. The one recipient predicate is false for a letter whose
   `for_library_id` is another Library's; a seat has the writer's right only over a letter whose `from_library_id` is
   empty or this Library's. A route carries `origin_library_id` and `origin_delivery_id` unchanged.
6. **A fourth source word, `postbox`**: "the sending Library said so", on a letter filed from the Postbox. The reader's
   preface names the sending Library by its card when it is not this one.
7. **One judge for every Basic Memory write.** A JSON-RPC error, `isError`, a result `error` field
   (`NOTE_ALREADY_EXISTS` named apart), `action: conflict`, and a text result headed `# Edit Failed` or `# Error` are
   each a refusal, named. A write is never resent after a dropped session: the session is re-opened and the write is
   judged by its readback.
8. **The delivery-id contract (for session 2, recorded now).** A letter to another Library gets a delivery id in
   `[a-z0-9-]` (`<sender-id>-<utc stamp>-<random>`), so it is its own file name; it is written once to
   `postbox/inbox/<recipient-id>/<delivery-id>.md` with a payload digest, judged by digest at the inbox path and at
   `delivered/`, and filed by the recipient at most once by delivery id under its letters Book's lock, before the note
   is moved to `delivered/`. Nothing is deleted.
9. **The carrier boundary.** `kernel/src/postbox.ts` is the only module that knows Basic Memory carries letters. The
   entry, the address rule and the delivery-id contract are the carrier's, so a shared folder could replace Basic
   Memory later without touching letters.

## Consequences

- ADR-0062's "Nothing across machines" and ADR-0069's no longer hold for letters: a Library may write to another
  through the Postbox. Messages still never cross machines, and the program still sends none (ADR-0062).
- Provenance, not authentication (the plan's Q3): anything that can write to the server can write an entry or a
  letter. The id, not the card, addresses a letter; the card only finds one entry when exactly one has it.
- A Library that never runs `postbox setup` is unchanged, and Basic Memory stays optional (ADR-0044).
- What the real server does with a title, a frontmatter line and a listing page is built against the fixture and
  named in `postbox.ts`'s header, for B's Stage 0 probes to confirm.

## Addendum, 2026-10-18 (kickoffs/s133)

The live trial between two Libraries (kickoffs/s132) found doctor failing every Library that had exchanged a letter
with another. A seat id on a letter belongs to the Library its side names (`for_seat_id` to `for_library_id`'s,
`origin_seat_id` to `origin_library_id`'s, `from_seat_id` to `from_library_id`'s; PLAN-many-libraries.md Stage 1 item
3), so doctor's `seats.identity` and `letters.recipient-incarnation` judge it only in that Library and count the others
apart; an empty id is this Library's, and a malformed one keeps today's judgement. A move to `delivered/` that the
server refuses is reported by `postbox check` in the letter's skipped entry as `move_answer`, the server's words, and
is never counted as moved: presence is still judged by listing. Nothing else changes.
