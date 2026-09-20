# A Hub section states the current position, never its own history of being wrong

A Hub root section carries what is true now. It never carries a paragraph whose subject is another
paragraph on the same page.

The tell is mechanical, and these are quoted from the `library-dev` Hub on 2026-09-19:
*"so the paragraph above is stale from 'is running' onward"*, *"Corrected 2026-09-11:"*,
*"Corrected 2026-09-11 (again):"*. That page's `## Now` held eleven such paragraphs out of
twenty-eight, four of which opened by declaring the paragraph above them stale.
When a paragraph's job is to correct another paragraph, **both are the defect** — delete the pair,
because the record it cites already holds the detail.

## Status

proposed — 2026-09-19, awaiting the reader's ruling. Every other ADR here is `accepted`; this one is
drafted rather than settled, and the status changes when it is ruled on.

**Amends [ADR-0013](0013-a-hub-section-holds-only-what-the-project-can-close.md) by naming a second
growth source, not by reversing it.** ADR-0013's taxonomy holds and its three destinations still
apply. It is amended on one claim only: that naming a destination is sufficient. For *limits* it was.
For content that already had a destination it was not, because that content does not look like it
needs one.

## The premise this falsifies

ADR-0013 closed by saying what it could not do:

> What is **not** claimed: no check can tell an open item from an accepted limit by reading it. That
> judgement is the author's, every time.

That is true and remains true. But it framed the residual risk as a *classification* problem — an
author mistaking a limit for an open item. The regrowth that followed was not a classification
problem. Every paragraph that arrived was correctly classified as orientation **at the moment it was
written**, and became wrong later, on a schedule nobody was watching.

## The measurement

Method: the `## Now` byte count taken from each `projects/library-dev/_project.md` body recorded in
`internal/publication-journals/` — 309 entries carry one — largest per day. Same source ADR-0013
used, different aggregation, so figures for shared dates will not match its table exactly.

| | `Now` | |
|---|---:|---|
| 2026-09-06 | **4,736** | ADR-0013 applied; nineteen limits moved to the `limits` page |
| 2026-09-08 | 6,454 | |
| 2026-09-11 | 9,971 | |
| 2026-09-12 | 11,747 | |
| 2026-09-15 | 16,179 | the Notebook drain loop closes |
| 2026-09-18 | 16,179 | |
| 2026-09-19 | **19,078** | the defect-clearing loop closes |
| 2026-09-19 | 5,585 | after this trim |

**Four times its post-fix size in thirteen days.** ADR-0013 measured 21 KB back to 30 KB in eleven
days and called that the growth it existed to stop. This is steeper, and it happened *after* the fix,
with limits correctly routed away the entire time. On 2026-09-19 the whole page peaked at 39,192
bytes — larger than the roughly 33 KB it stood at on the day ADR-0013 was written to cut it.

## What actually arrived

Classifying the twenty-eight paragraphs at the peak by what should have happened to them:

| | bytes | ¶ |
|---|---:|---:|
| loop status chains (Notebook drain, defect-clearing) | 4,230 | 6 |
| "use, not the queue" session narrative | 2,366 | 3 |
| superseded, or duplicated in `Next` | 1,829 | 3 |
| a paragraph correcting an earlier paragraph | 1,338 | 2 |
| **had a destination and went to the root instead** | **9,763** | **14** |
| genuine orientation (compressed to 5,583 B in 10 ¶) | 9,257 | 14 |

**Half the section.** None of it was a limit. All of it had a destination under ADR-0013 or under the
2026-08-18 split — the dated `notes/` page, or the owning `PLAN-*.md` ledger — and none of it went
there.

## Why it arrived: loop status is orientation, until it is not

A session loop writes three paragraphs onto the root over its life, and the first one is *correct*:

1. **Opening.** *"The X work is running as a session loop, and `PLAN-x.md` is its authority."* This
   is orientation by the letter of ADR-0013 — it tells a returning reader where the project stands,
   which is exactly what `Now` is for.
2. **Closing.** *"The Notebook drain loop CLOSED on 2026-09-15 at row 9 of 9, so the paragraph above
   is stale from 'is running' onward."*
3. **Correcting.** A further note fixing something the closing paragraph got wrong.

Two loops ran between 2026-09-06 and 2026-09-19 and each produced all three. The rule was not broken
at any step. A sentence that was true when written stopped being true, and nothing in the rule says
who is responsible for that, or when.

**The test ADR-0013 lacks:** *would this sentence need a correction when the work it describes
finishes?* If yes it is not orientation — it is status, it expires on a known date, and it belongs in
the ledger of the plan that owns it. A **dated fact that the loop closed** does not expire and may
stay.

## Why it stayed: the cheap write is the wrong write

The correcting paragraph is not laziness, it is the tool's incentive. From
`docs/librarian-operation-playbooks.md`:

| | gate |
|---|---|
| `AppendSection` — add "the above is stale" | **applies directly** |
| `ReplaceSection` — delete the stale paragraph | preflight `plan_id` + one confirmation |

> **There is no remove-item mode:** `ReplaceItem` requires non-empty content, so retiring one closed
> `Now` entry means a `ReplaceSection` that rewrites the section without it.

So correcting is one ungated call and deleting is a gated two-step with an approval. A session at the
end of its work, already over budget, takes the cheap one every time. This is the cost asymmetry
`PLAN-token-efficiency.md` named in its Key decision 4 and left unfixed — *"this phase is one-time
cleanup, not a cure"* — arriving on the page where it was most expensive.

## The decision

1. **A section states the current position.** A paragraph whose subject is another paragraph on the
   same page is never added. The stale paragraph is deleted instead, in the same write.
2. **A loop's running status does not go on the root.** It belongs in its `PLAN-*.md` ledger. The
   root may carry the dated fact that a loop opened or closed, and nothing that expires when it does.
3. **Closing a loop includes deleting its own opening paragraph.** The closing session pays the
   `ReplaceSection` rather than appending a correction. It is one gated write either way; only the
   correction *feels* cheaper, and it leaves two paragraphs where there should be none.
4. **It applies to `Next`'s preamble too.** The same pattern ran there in mirror image: a pause that
   had ended thirteen days earlier, still asserted, still pointing at `## Now` for an orientation that
   no longer existed.

## Why this one is checkable, and ADR-0013's was not

ADR-0013 could not mechanise its judgement because an open item and an accepted limit read alike.
**This tell does not have that property.** A paragraph that names another paragraph is recognisable
from the text alone, without knowing anything about the project: *"the paragraph above"*, *"is stale
from"*, *"Corrected"* followed by a date, and that same phrase followed by *"(again)"*.

That makes a real check possible for the first time on this rule — one that reads the published Hub
root under `-IncludeShared` and fails on the construction. **This ADR is not held until that check
exists**, and a rule about a page nothing validates is the same adjective-without-a-destination that
ADR-0013 was written to replace.

## What this changes

- **`tools/Invoke-LibraryChecks.ps1`** gains the tell check described above, registered where it
  actually runs — and named in the `-Fast` roster only if it is cheap enough to belong there.
- **`tools/New-ProjectHub.ps1`**'s `Now` seed gains the rule, which means
  `hub.sections-name-their-destinations` gains a further required claim. That check reads the seed
  and `docs/project-hub-design.md`; it reads ADR-0013 only for existence, so adding this file breaks
  nothing on its own.
- **`docs/project-hub-design.md`** carries the second growth source, the measurement, and the expiry
  test.
- **`.claude/rules/library-development.md`** carries the closing-session obligation, since it is a
  condition on how work is finished rather than an open item.

## What this deliberately does not decide

**Whether `Edit-ProjectHub.ps1` should get a remove-item mode.** That would attack the cost asymmetry
directly and it is the obvious next question, but it is a change to a gated writer with its own
safety argument — the absence of that mode is what makes every deletion visible and approved. Naming
an incentive is not the same as ruling on it, and this ADR does not.

**Whether any of this generalises past `library-dev`.** One Hub, two loops, thirteen days. The
mechanism should apply to any project running a session loop, and no second Hub has been measured.
