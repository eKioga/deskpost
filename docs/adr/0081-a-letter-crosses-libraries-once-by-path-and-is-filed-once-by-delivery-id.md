# ADR-0081: A letter crosses Libraries once by its path and is filed once by its delivery id

**Status:** accepted
**Date:** 2026-10-15
**Effective from:** the release that carries s123 (1.5.0's second session)
**Amends:** none. Carries out decision 8 of [ADR-0080](0080-libraries-pass-letters-through-a-postbox-in-basic-memory.md),
the delivery-id contract it recorded for this session
**Relates to:** [ADR-0062](0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md) (a letter is the record),
[ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md) (every
request and answer between seats is a letter), `PLAN-many-libraries.md` Stage 1 items 4-7, and deskpost-desk's Stage 0
probes of 2026-10-15 (S1, S3, S5-S7)

## Context

ADR-0080 set a Library up in the Postbox and gave letters Library fields, but nothing could carry a letter. The carrier
is a Basic Memory server, and B's probes showed what it does and does not promise. `write_note` with `overwrite: false`
lets exactly one of two concurrent creates of a path through (S1), and there is no conditional write (S2). The server
keeps a note's `metadata` as frontmatter and merges a body's own `---` block into it (S5), and it quotes a value YAML
must quote (S7). A moved note keeps its permalink at the old path, so `read_note` on that path answers the moved note,
even after a new file is written there; only `read_content` by file path and `list_directory` see the file actually at
a path (S6). A session can drop mid-call, and a write may or may not have landed when it does.

## Decision

1. **A delivery id names one letter everywhere.** A letter to another Library gets `<sender-id>-<yyyymmddthhmmssz>-<random>`,
   lowercase `[a-z0-9-]`, so it is the note's own file name (S6). It is written at
   `postbox/inbox/<recipient-id>/<delivery-id>.md` and nowhere else.
2. **The sender's record and its outbox entry are written together.** `capture letters --for <seat> --library
   <id-or-card>` resolves the Library through the Postbox now; the seat must be in its entry with a `seat_id`. The
   letter goes into the local `letters` Book as today, with `from_library_id`, `from_library_card`, `for_library_id`,
   `delivery_id` and `postbox_path`. In the same mutation window, `internal/postbox/outbox/<delivery-id>.json` fixes the
   delivery id, the path and the payload digest. A rollback removes both. A body that opens with `---` is refused
   before anything is written, because the server would merge it into the frontmatter (S5).
3. **The digest covers the kept body only.** SHA-256 over the text after the server's frontmatter, newline-normalised,
   with the leading newline the server adds and any trailing whitespace dropped. Deskpost's fields travel as
   `metadata`, which the server keeps by value (S7), and the sender's digest travels with them as `payload_digest`.
4. **Never `read_note` for an inbox path.** Every Postbox read of a letter is `read_content` by file path, and every
   listing is `list_directory` (S6). `read_note` would answer the moved note for its old path and miss a re-created one.
5. **Sent exactly once by path.** `postbox send` (and capture, once, right after writing) first looks at the inbox path
   and at `delivered/`. The same digest at either is success; another digest is a refusal recorded in the outbox
   entry, and nothing is overwritten. Only when neither exists is the inbox path written, with `overwrite: false`. A
   `conflict` answer re-reads both paths and judges by digest. An entry is marked sent only after a digest-matching
   readback. A dropped session is re-opened and judged by readback, never resent (ADR-0080 decision 7).
6. **Filed exactly once by delivery id.** `postbox check` lists its own inbox and reads each file. Under the receiving
   `letters` Book's lock, capture's internal filing route files it only if no letter there already carries that
   `delivery_id`. The author is the one the sending Library named (`from_seat_source: postbox`), and
   `origin_delivery_id` is the sender's delivery id. A recipient whose `seat_id` no longer matches is filed with
   `stale_delivery: true`; a body whose digest is not `payload_digest` is filed with `postbox_damaged: true`. Only
   after the local copy is verified is the note moved to `delivered/`. A destination that already holds the delivery
   id with the same digest counts as moved: the inbox copy is left, recorded in `internal/postbox/state.json`, and
   counted once.
7. **An answer closes the asker's own copy.** `--answers` on a letter filed from the Postbox sends the answer back to
   the first asker's Library and seat as the letter records them, with `answers_delivery_id` set to its
   `origin_delivery_id`, however many local routes came between. When the asker's Library files it, the same window
   closes the asker's letter with that `delivery_id` (`answered_by` = the filed answer).
8. **Nothing is deleted.** Not on the server and not here: a refused send, a damaged or stale delivery, and a left
   inbox copy are all kept and named.
9. **Out of the way.** The Desk and doctor read only the cache (`state.json`) and the outbox: letters waiting to send
   or refused, letters received from other Libraries, undeliverable and damaged ones, and since when the Postbox has
   not answered. A seat's launch runs one detached `postbox check --send-first` at most once per conversation, with a
   5-second budget for each MCP call, and never waits for it.

## Consequences

- A letter can now reach a seat in another Library and its answer can come back. A server that is down only delays a
  letter: it waits in the outbox, and the Desk and doctor say so.
- A duplicate is stopped twice: the sender looks before it writes, and the receiver files by delivery id. Neither leans
  on the server to refuse a duplicate, because it documents no conditional write.
- `postbox.ts` stays the only module that knows Basic Memory carries letters. The outbox, the digest, the delivery id
  and the filing rule are the carrier's contract, so a shared folder could replace Basic Memory without touching
  letters.
- Built against the fixture server, which now keeps notes as the probes measured. What no probe measured is marked
  `UNPROBED` in `postbox.ts`, `basicmemory.ts` and the fixture: `read_content`'s answer shape, `move_note` onto an
  existing file, how `move_note` resolves an identifier, and `list_directory` past 200 notes. A live trial between two
  Libraries on the real server is still to come.

## Addendum, 2026-10-17 (kickoffs/s131)

B's probe of the real server (`projects/deskpost-desk/notes/2026-10-17-postbox-probes`) found that `read_content` by a
path is not exact: it follows a permalink first, so a moved note's old path answers the moved note even once a new file
is there, and a path with no file, in a folder that holds notes, answers another note from that folder. The Context's
"only `read_content` by file path and `list_directory` see the file actually at a path" and decision 4's "every Postbox
read of a letter is `read_content` by file path" no longer hold. A letter's presence at a path is judged by
`list_directory` of its folder; a listed file is read by the `permalink` its node gives, and its text is trusted only
when its own `permalink:` line is that permalink; a move names the file by its permalink. Decisions 5 and 6 stand on
that footing, and nothing else changes.
