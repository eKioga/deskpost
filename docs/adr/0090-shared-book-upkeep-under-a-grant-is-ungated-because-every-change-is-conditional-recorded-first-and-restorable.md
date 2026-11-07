# ADR-0090: Shared-Book upkeep under a grant is ungated because every change is conditional, recorded first and restorable

**Status:** accepted
**Date:** 2026-11-06
**Effective from:** the release carrying 1.6.0's shared writers (kickoffs/s195)
**Amends, for `shared/` Books only:** [ADR-0070](0070-a-book-page-is-corrected-in-place-through-a-writer-that-keeps-the-previous-text-and-a-book-keeps-its-source-list.md)
**Builds on:** [ADR-0089](0089-shared-books-are-written-by-any-library-with-conditional-writes-change-records-and-restore-as-the-guarantee.md)
**Plan:** `PLAN-many-libraries.md` r12, item 16 (the second new ADR of item 10)

## Context

ADR-0070 lets a Book page be corrected in place only on the reader's yes for each write, because a correction was
the one change that could not be taken back without the previous text. ADR-0089 made every shared write conditional,
recorded in full before it lands (the previous text and the new text in `_deskpost/changes/<slug>/`) and restorable
from that record by one printed command. Under that per-write yes, keeping a shared Book current took many yeses for
routine work (Eric, 2026-11-02: refreshing a collection Book "often tak[es] multiple 'yeses' just to keep it from going
stale"; "remove as much friction as possible").

## Decision

1. **One yes per Book.** `deskpost shared upkeep <slug> --seats <seat>[,...]` (or `--any-seat`) writes this Library's
   block in the note `_deskpost/upkeep/<slug>.md`: the Library id, each named seat's `seat_id` from this Library's
   registry (a rename keeps it; a retirement ends it; a seat recreated under the same name has a new one), the names
   for display, and the id of the change record that created the Book's `_book.md`. Granting takes the reader's yes.
   A Library grants only its own seats, and other Libraries' blocks are kept as they are. `--off` removes this
   Library's block without a yes, and the note goes when no block is left.
2. **What a granted seat writes without a yes:** `shared add-page`, `shared replace-page` (with `--from-change`
   restores), `shared catalog-line` and `shared sources` on that Book. Each takes the whole ADR-0089 path: proven
   fingerprint, record first, conditional write, readback, the printed record id and restore line. The preview says
   `confirmation_required: false` and names who maintains the Book; the apply takes `--plan-id` alone and reads the
   grant again, since the plan id does not bind it.
3. **What always needs the reader's yes:** `shared upkeep` itself, `shared new-book`, `shared promote`, `shared
   remove-page` and `shared sources --remove`.
4. **This amends ADR-0070 for `shared/` Books only.** A local collection Book's page replacement keeps ADR-0070's
   per-write yes.

## Consequences

**The grant is provenance, not authentication.** On an open server anything could write the grant note, exactly as
anything could write a page. The guarantee stays the change records and restore, which do not depend on the grant: a
granted write that should not have landed is put back from its record like any other.

**The grant is bound to a Book by a named record.** A write goes ungated only when the record the grant names is a
`base: absent` creation of this Book's `_book.md` by `shared new-book` or `shared promote`. That holds while no command
moves `books/<slug>` away or re-creates a slug: in 1.6.0 `new-book` and `promote` refuse an archived slug and a
`_book.md` they did not make. When `shared archive` comes back, it must re-check this binding (a new Book under an old
slug must not inherit the old grant). The earliest making record may be an attempt that never landed; that is harmless
while no slug is re-created. A Book made before 1.6.0's writers has no such record and cannot be granted; its writes
keep the per-write yes.

The Desk names who maintains an open shared Book from this Library's own copy of its block, with the seats' current
names. Discovery reads the same note.
