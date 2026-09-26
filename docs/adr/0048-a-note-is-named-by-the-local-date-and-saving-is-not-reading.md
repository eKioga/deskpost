# ADR-0048: A note is named by the local date, and saving is not reading

**Status:** accepted
**Date:** 2026-09-26
**Effective from:** the release candidate for `v1.0.0` (S50, the reader's rulings)
**Relates to:** [ADR-0047](0047-a-route-field-is-a-remedy-and-doctor-reads-codex-hook-review.md) (the rulings S49
recorded), [ADR-0017](0017-the-always-on-margin-is-accepted-disciplines-do-not-move.md) (the always-on margin that
carries the Holding Shelf's sentence)

## Context

S49's Sandbox run on `v0.2.2` filed two claims in the Report Inbox. S50 verified both against the source.

**The date.** `library capture holding --title 'Grocery list'` at 2026-09-25 23:03 local time (UTC-7) wrote
`notes/2026-09-26-grocery-list.md` with `captured: 2026-09-26T06:03:32Z`, and the session that read it called the
file "dated tomorrow". The note's name came from the UTC date in both arms: `utcDate()` in `kernel/src/capture.ts`,
`triage.ts` and `triagebatch.ts`, and `[DateTime]::UtcNow` in `tools/Add-ShelfNote.ps1`,
`tools/Invoke-LibraryTriage.ps1` and `tools/TriagePlanCommon.ps1`. Triage's default `--capture-date` used the same
rule.

**The wording.** The workspace instructions `library init` renders said the Holding Shelf is "Ungated, no open Book
needed, survives a reset." Two sessions asked for a Holding Shelf page were correctly refused as a closed Book. Both
then told the reader the guidance contradicted the guard. The sentence is about saving. Reading a note back is gated
like any Shelf Book, and the sentence did not say which of the two it meant.

## Decision

**A note's file name takes the local calendar date, and `captured:` stays the UTC instant.** The name is the date as
a reader would say it. The frontmatter is the exact moment, for ordering and comparison. Triage's default
`--capture-date` follows the same rule, and an explicit `--capture-date` is unchanged. Kernel self-test section 40
holds this with two zones through the front door: `TZ=Etc/GMT+12` and `TZ=Etc/GMT-14`. At any instant, at least one of
them is on a different calendar date from UTC, so the section is red against a UTC-dated kernel whenever it runs. It
was red against this tree before the fix, on the UTC-12 capture and the UTC-12 triage date, and is green 17 of 17
after it. The PowerShell oracle takes `[DateTime]::Now` (.NET on Windows ignores `TZ`), and
`Test-ShelfNoteBoundary.ps1` now expects the local date.

**Saving is ungated and reading is not, in so many words.** The template now says: "Saving is ungated, needs no open
Book and survives a reset; reading its notes back is gated like any Shelf Book, so open `holding` first." The
program's own `CLAUDE.md` and `library capture`'s summary in `kernel/src/verbs.ts` say the same. Section 40 reads the
rendered bullet and requires it to name saving, reading and opening, and to no longer say "no open Book needed" on
its own.

**Also ruled in S50, recorded here:**

- The next release is the **release candidate**. The four real-session verdicts are judged only on the binary that
  will be tagged, after the whole shared matrix, the full gate and the upgrade fixture have run on it.
- The **Orca per-seat Quick Command export** (step 29's `library seat export-orca`) is deferred past `v1.0.0` and
  leaves S20's row. `docs/seats.md`'s one-button Quick Command recipe remains the route.
- **macOS leaves S20's row.** Phase D's criterion reads "a clean macOS or Linux VM". S49 met it on Linux from
  `releases/latest`, and no machine here can run macOS, so `v1.0.0` ships no darwin archive and claims none.

## Consequences

An evening capture is named for the day the reader is living in. Two notes captured either side of UTC midnight
still order correctly by `captured:`. The file names of notes captured before this change keep their UTC dates, and
nothing renames them. A session that is refused a Holding Shelf read now has the instruction that explains the
refusal. The workspaces `init` has already rendered keep the old sentence until `library init --force` refreshes
their managed sections.
