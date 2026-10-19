# ADR-0083: A seat amends or withdraws its own pending Report, and triage freezes it

**Status:** accepted
**Date:** 2026-10-17
**Effective from:** the release that carries s130
**Relates to:** [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md)
(`letters close`, the model), the plan `projects/deskpost-desk/notes/2026-10-09-plan-report-amend-withdraw-r3` (signed
off by Eric 2026-10-09), and the glossary's **Report Inbox**

## Context

A Report could not be corrected or recalled by the seat that filed it. The only update was `capture reports
--supersedes notes/<older>`, the whole Report restated under a new name, so a reader diffed two pages. A withdrawal was
an ordinary triage close, so a withdrawn Report looked like a fixed one, and the Report Inbox is `Closed by: any`, so
any seat could close any Report. A capture recorded its writer's name and conversation but no seat id, so a later seat
reusing a retired name passed as the writer.

## Decision

1. **Two verbs under a `reports` group**, scoped to the standard `reports` Book only:
   `deskpost reports amend notes/<page> --content-path <file>` and
   `deskpost reports withdraw notes/<page> --note "<reason>"`. Letters, Holding notes and `shelf tidy` are unchanged.
2. **Amend appends, never rewrites.** It adds `## Update <UTC stamp>` at the note's end with the file's text and sets
   `updated:` (the latest) and `update_count:`. The body and every earlier update stay byte for byte. It refuses an
   empty file, one over 16 KB, a control character other than tab and line ending, a `#` or `##` heading outside a
   fenced block, and a fence left open.
3. **Withdraw reuses `closed_note`.** `review: done`, `reviewed:` and `closed_note:` (required, one line). In the
   `reports` Book a `closed_note` means withdrawn, and the reader map marks it `(withdrawn)`. A triage reopen is
   unchanged.
4. **Only while untouched by triage.** Both refuse a Report that is `review: done`, or carries `filed_to`,
   `superseded_by`, `answered_by` or `routed_to` (reopened ones too), or whose frontmatter is malformed. Once triaged a
   Report is frozen: new evidence goes in a new Report.
5. **Only the filing seat, by its id.** `capture` writes `from_seat_id` for a seated capture whose registry id is
   valid. `isWrittenBy` takes it under the letters rule: an id-less note matches by name, a renamed seat still wrote
   its note, a later seat reusing a retired name did not. The seat is resolved from the session; `--seat` is refused.
   A seatless Report can be closed only by triage. No reader override: the reader withdraws by triage `review` and
   amends by a new Report.
6. **The new keys are reserved and shaped**: `from_seat_id` (32 lowercase hex characters), `updated` (a UTC stamp)
   and `update_count` (a positive whole number).
7. **What triage and doctor see.** `triage inventory` emits `updated` and `update_count` when present, and
   `closed_note` on a done note in any capture Book. The map marks a pending amended Report `(updated <date>)`.
   `letters.relationship-fields` keeps its name, covers every capture Book, and warns when `update_count` differs from
   the number of `## Update` sections; `seats.identity` checks `from_seat_id` as it checks the letter ids.

## Consequences

- Each verb is journalled with the reader map and makes a new Discovery manifest generation, with no reader's yes: a
  seat's own filing is not the reader's decision.
- A triage batch previewed before an amend refuses at apply, because the Report's hash is in its plan id: the triager
  has not read the new text.
- `from_seat` and `from_seat_id` guard against mistakes, not against a process running as the reader that sets
  `LIBRARY_SEAT`. Reports are not secret, and every change is journalled.
- A Holding note in an existing Library with a doubled or wrong-shaped reserved key now gains a doctor WARN, never a
  FAIL.
- No PowerShell changes: `tools/ShelfNoteCommon.ps1` reads named keys only and tolerates the new ones.
