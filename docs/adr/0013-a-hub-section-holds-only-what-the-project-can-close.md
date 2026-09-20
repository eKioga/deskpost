# A Hub section holds only what the project can close

Every item on a Project Hub **root section** must have a closing condition the project itself can
cause. An item that cannot be closed by doing the work is not an open item, and it leaves the root
for one of three named destinations:

| It never closes because… | It is a | It goes to |
|---|---|---|
| closure needs an event the project cannot cause | **limit** | the Hub's `limits` page, with a disposition |
| it is already settled | **decision** | `## Decisions`, plus the record it names |
| it is a standing practice | **guidance** | the subject's own rules or docs, never the Hub |

`Now` keeps orientation plus open items. `Next` keeps shippable work. Neither keeps anything else.

## Status

accepted — 2026-09-06.

Amends [ADR-0003](0003-decisions-follow-their-subject.md), which routed *decisions* off the root, and
completes the 2026-08-18 split in `docs/project-hub-design.md`, which routed *narrative* off the
root. This is the third and last thing that was never leaving.

## The premise this falsifies

`docs/project-hub-design.md` says, under *Why the split needs no threshold*:

> If narrative never lands in `Now`, `Now` never grows, so there is nothing to monitor and no
> periodic migration to approve.

Narrative did not land in `Now` — session history has gone to a dated `notes/` page since
2026-08-18, as designed. `Now` grew anyway.

Measured from the 222 `internal/publication-journals/` entries that carry a prior body of
`projects/library-dev/_project.md`, one row per day:

| | page | `Now` | `Next` | `Now` entries |
|---|---|---|---|---|
| 2026-08-16 | 24 KB | 11.9 KB | 6.4 KB | 0 |
| 2026-08-23 | 81 KB | 33.2 KB | 14.9 KB | 0 |
| **2026-08-26** — the migration | **21 KB** | **11.2 KB** | **7.4 KB** | 9 |
| 2026-09-06 | 30 KB | 12.5 KB | 13.8 KB | 12 |

The August migration cut the page from 81 KB to 21 KB. Eleven days later it was 30 KB. The split
works — narrative really did stop arriving — and the section grew regardless, through the *other*
kind of content the design named and assumed would drain: **open items.**

## Why they do not drain

The design defined an open item as *"a limit that is still unproven, a decision still owed, a defect
not yet fixed"*, and said it "leaves the section when it closes". Two of those three do close. The
first does not, or not reliably: an unproven limit closes when some event occurs, and the project
frequently cannot cause that event.

All twelve `Now` entries on the library-dev Hub at the time of this decision were of exactly that
one shape — *shipped, but this path has never run live*. Several state in their own text that the
event cannot be manufactured:

- *"Do not manufacture one"* — the eviction offer needs a raw batch owned by an archived Project.
- *"no executable lifecycle"*, *"any Hub experiment is effectively permanent"* — a live `-Dev` Hub
  creation.
- *"the retry has still never fired, because no session has expired"* — waiting on a server timeout.

Those are not open items. They are **limits the project has accepted**, and every one of them was
already a decision that had simply never been recorded as one, so it read as open forever.

The arithmetic follows: each shipped feature closes one `Next` work item and adds one or two `Now`
limits. **Shipping makes the root bigger.** That is the reader's observation — *"the more features I
implement, the less this shrinks"* — and it is a property of the container, not of the discipline
being applied to it.

`Next` had the same problem from the other end. Of its thirteen entries, **four** closed by shipping;
three were deferred decisions, four were standing practice that never closes, and two were *verbatim
duplicates* of `.claude/rules/library-development.md`. Twenty-six percent of a queue was a queue.

## Why not simply raise the threshold

Because the threshold was never the mechanism, and this project already learned that once. From the
same design record, on the ~3,000-word threshold that preceded it:

> The threshold fired in both wrong directions within two days. … Length was never the cause. … The
> clause the rule needed — *"do not trim entries to stay under it"* — is what you write when you
> already know a number invites gaming.

The byte thresholds that replaced it inherited the flaw. Two pieces of evidence from the code:

- `Edit-ProjectHub.ps1` records that `Now` "has been over 12,000 bytes since the threshold shipped,
  so warning on every write to the page said something true, identical, and **unactionable** each
  time." The response was to delta-scope the warning so it fires less. The symptom was suppressed;
  the reason it was unactionable was never asked.
- The remedy the warning prints — *"keep each entry to a line or two"* — is the compression advice
  the 2026-08-18 record explicitly warned against.

And the two rules are arithmetically incompatible anyway. `Now`'s cap is 12,000 bytes, its own
guidance is ~1,200 bytes per entry, and its orientation preamble is 3,509 bytes. That permits
**seven** entries. It held twelve. No amount of careful writing reconciles those numbers, because
nothing was wrong with the writing.

## Why a taxonomy instead

The 2026-08-18 fix worked, and it is worth being precise about *why*: it did not set a limit, it
**named a destination**. Its own account says so — *"The earlier rule was an adjective — concise —
with no named destination, so session entries went to the only place there was. This one names the
destination."*

That fix was applied to one of the two things that grow. This applies the identical move to the
other. A limit now has somewhere to go, so it goes there, and the section stops accumulating for the
same reason it stopped accumulating narrative.

## The `limits` page

`projects/<slug>/limits.md`, a companion to `connections`. Every row carries a **disposition**, and
the disposition is the whole point:

- **accepted** — we have decided not to pursue proof. Closed. It stays as a record and is never
  narrowed, revisited, or counted against anything again.
- **awaiting** — it will close if the event occurs; nobody is causing it. Cheap to leave.
- **promoted** — someone decided to cause the event. It leaves for `Next` as work.

Most of a mature project's limits are `accepted`, and accepted rows are inert. That, not the larger
page budget, is what makes this stable: the page grows, but the part of it anyone must read or
maintain does not.

A limit is not a decision in ADR-0003's sense and does not go to `## Decisions`. A decision settles
*how the project works*; a limit records *what has not been proven about work already done*. Keeping
them apart is what stops `## Decisions` — one-line pointers, by design — becoming the next section
with this problem.

## What this changes

- **`New-ProjectHub.ps1`** seeds the rule into `## Now` for **every** Hub, not only `-Dev` ones. The
  old seed's closing sentence, *"An entry leaves this section when it closes"*, is the assumption
  that failed and is replaced by the three destinations. The default body's expected literal in
  `new-project-hub.selftest` moves with it — deliberately, and for the first time since `-Dev`
  landed. Existing Hubs are unaffected; they were created, not re-seeded.
- **`Edit-ProjectHub.ps1`** stops advising compression. An oversized section now reports that it is
  probably holding items that cannot close, and names the three destinations. The `limits` page joins
  `notes/` as size-exempt, because a ledger of accepted limits is a record and records do not orient.
- **`docs/project-hub-design.md`** carries the falsified premise, the measurement, and the tier.

## Does this still serve the token-efficiency goal the budget existed for

Yes, and by more than the budget did. The caps came from `PLAN-token-efficiency.md`, whose goal is to
"remove the accumulated cost from **the shared Project Hub that both engines read on every
orientation**". The test is therefore not "is the page smaller" but "is the *orientation read*
smaller, without the cost reappearing somewhere that is also read every time".

**Nothing reads the `limits` page automatically.** Verified rather than assumed: the three hooks in
`.claude/hooks/` inject Desk state and tool names and read no page content at all, and
`Select-ReturnBriefingSections` reads the Hub root plus `connections` and nothing else. The ledger is
reached only by an explicit `read_open_project_page(..., limits)`.

Measured on the library-dev Hub, in the plan's own units (bytes, tokens estimated at chars/4):

| | bytes | ~tokens |
| --- | ---: | ---: |
| `_project.md` before | 25,547 | 6,387 |
| `_project.md` after | 12,376 | 3,094 |
| **saved per orientation, both engines** | **13,171** | **3,293** |
| `limits.md`, on demand only | 10,468 | 2,617 |

A 52% cut to the read both engines make every time, and 85% below the plan's 2026-08-25 baseline of
82,901 characters.

**It is not a shell game, and the arithmetic proves it rather than the intent.** Even a session that
reads *both* pages pays 22,844 bytes against today's 25,547 for the root alone — the sort compressed
the material by about 2,700 bytes on its way across. So the worst case is still cheaper than the
status quo, and the common case, where the ledger is never opened, is cheaper by half.

The deeper saving is not in the table. Under the old arrangement every accepted limit was re-read at
every orientation *and* hand-narrowed each session to hold the section under its cap — the narrowing
is why `Now` looked flat while its entry count climbed from 9 to 12. An accepted row costs nothing to
keep now, so that recurring editing cost goes to zero as well.

**This is the follow-up that plan asked for, arriving through a door it did not predict.** Its Key
decision 4 says in terms: *"The cost asymmetry stays unfixed, and this phase is one-time cleanup, not
a cure"*, and sets a follow-up trigger — more than five `[x]` entries in either section. That trigger
**would not have fired.** There were two. The growth did not come from closed items lingering; it came
from entries that were never closed and never would be, which look exactly like live ones. Both
remedies the plan foresaw — a cheap close operation, or a status read that excludes `[x]` — address
the symptom it expected rather than the mechanism that actually operated.

Two of that plan's other decisions bear on this and are satisfied. Decision 10 — *"a phase that hits
a number by dropping an open item has failed"* — is met: **no item was dropped.** All nineteen moved
intact and gained a disposition they did not have. Decision 2 observed that a status tool *"would
have to guess which 4 of 26 entries are live, from prose"*; requiring a declared disposition removes
the guess, so this makes that deferred tool buildable rather than harder.

**The tradeoff, stated.** Decision 6 deferred moving the `Connected` lists because doing so *"changes
what orientation returns"*. The same is true here: a reader orienting no longer sees the unproven
list in passing. That is accepted for the same reason the `connections` move was: orientation should
return where the project stands and what to do next, and a ledger of what has not been proven about
finished work is consulted when you touch the subsystem it concerns, not when you arrive. `Now` names
the page and its dispositions so the material is one call away and never a surprise.

## How this is held

`hub.sections-name-their-destinations` asserts that the `Now` seed names all three destinations and
that the design record agrees — the same shape as the credentials-warning check, and for the same
reason: nothing validates what a reader types into a Hub, so the seed's wording is the mechanism.

What is **not** claimed: no check can tell an open item from an accepted limit by reading it. That
judgement is the author's, every time. The check only guarantees that the reader is told the
judgement exists and where its answers go — which is precisely what the adjective *concise* failed
to do.
