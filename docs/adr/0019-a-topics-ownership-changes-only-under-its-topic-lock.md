# A topic's ownership changes only under its topic lock; the ownership record lock is last

Three linked defects, one ruling. `notebook/` is shared by every seat, and until 2026-09-09 a valid
claim at seat B authorised a write into a topic owned by seat A, a reassignment could take a live
seat's topic outright, and the reset's revalidation of ownership was still check-then-move because
the reassignment it was defending against took no topic lock at all.

**The rule: a topic's ownership changes only while that topic's lock is held.** The
`notebook-topic-owners` lock serialises one small file's read-modify-write; the authority over what
one topic's ownership *means* is that topic's own lock. So the record lock moved from **third** in the
total order to **last**:

```
registry/Desk  ->  Book (sorted)  ->  topic (sorted)  ->  render  ->  notebook-topic-owners
```

## Status

accepted — 2026-09-09. Closes the `library-dev` Hub's *"Rule how ownership is held, then fix the lock
order and the three writers in ONE pass"* item, which is what the 2026-09-09 seats review left after
reading and Codex found the same family from opposite directions.

Amends nothing in [ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md):
reset stays seat-scoped, quarantining, and refusing every foreign seat it is not entitled to.
[ADR-0015](0015-the-desk-is-per-seat-one-library-many-seats.md)'s claim model is unchanged — what
changes is that holding a claim is no longer *sufficient* to write into any topic.

## The three defects, and why they had to move together

- **A valid claim was entitlement to any topic.** The compiler and Triage validated the acting seat's
  claim and never read the target topic's owner. Seat B could add material to seat A's topic, and
  seat A's *ordinary* reset would then quarantine it — with B still claimed and still working. No
  concurrency needed. The live workspace was in exactly that state: `notebook/2nd-b-vault-dev` was
  owned by seat `library-dev`, which had compiled it before the seat named for that project existed.
- **Reassignment was ungated in every direction.** `Set-NotebookTopicOwner` would move a topic away
  from a live seat, and the reset's own refusal text pointed readers at it.
- **Revalidation was check-then-move.** `Move-NotebookTopicToQuarantine` re-read ownership
  immediately before its `Directory.Move` and its comment claimed the topic lock stabilised the
  answer. It did not, because the remap took no topic lock.

**Codex's recommended fix for the third would have deadlocked.** It proposed holding the ownership
lock through the moves. All three Notebook writers take that lock *inside* a topic lock — ownership is
recorded at the end of promoting a topic — so a reset holding owners and waiting for a topic lock
would meet a writer holding that topic lock and waiting for owners. The three inversions were
harmless only because the reset happened to release owners before taking any topic lock, with a
comment in the apply path saying so. That is why the Hub item insisted on one pass.

## Considered options

**Conform the writers to the old order** — owners *before* topic, held across the write. Rejected on
cost: the ownership record's lock is a single global, so this would hold it for the whole duration of
every compile, blocking every other seat's writer and the reset's own selection for minutes at a
time. The lock exists to serialise a small file; making it the outermost thing a long operation holds
inverts what it is for.

**Hold the ownership lock through the reset's moves** (Codex's recommendation). Rejected: the
deadlock above, against three writers that cannot reasonably record ownership any earlier — a record
naming a topic that failed to promote is a record the reset would act on.

**Give the record lock per-topic granularity.** Rejected as a bigger change with no new safety: the
topic lock already *is* the per-topic lock, and the answer was to use it rather than to grow a second
one beside it.

**Ordering owners between `topic` and `render` rather than after both.** Rejected on evidence, and
this is the one the static gate settled. `desk.lock-order` reads the sequence acquisitions are
*written* in and does not model releases, so a writer's `topic → render → owners` — which releases the
render lock before recording ownership — reads as nesting. With owners fourth, every writer reports
an inversion it does not have. Owners last is the position under which every real sequence is
forward, and no code holds the render lock while taking it.

## Consequences

- **The three writers ask before they write.** `Assert-NotebookTopicWritable`, under the topic lock,
  refuses a topic owned by another seat and names three remedies: work at that seat, reassign it if
  that seat is dormant, or declare the topic `shared`. `shared`, `excluded` and `unmapped` topics stay
  writable — the first two by declaration, and the third because a reset already refuses to guess at
  material nobody has claimed, which is the right place for that refusal.
- **The preflights report it before a plan is issued.** `Test-NotebookTopicWritable` is a lock-free
  read used by the compiler's preflight and Triage's gate loop, because a plan for a write already
  certain to be refused is worse than no plan — the rule `Retire-Seat` states and the reset's own
  preflight had to learn twice.
- **Reassignment is claim-gated and owner-aware.** `Set-NotebookTopicOwner.ps1` joins the claim-gated
  set: it needs the **acting** session's live claim, which is a different question from the assignee
  `-Seat` names — and that distinction is why the helper had been left out of that set. The function
  refuses to move a topic away from another seat whose agent is running, allows a dormant seat's topic
  to be reassigned, and allows the acting seat to hand over a topic it owns itself. The last case was
  written the simpler way first and the live workspace was the counter-example.
- **The reset stopped taking the ownership lock at all.** Its apply path needs no such lock: the
  record is replaced atomically, so a lock-free read is already a consistent snapshot, and what makes
  each individual move safe is the topic lock it already holds — now also the only lock under which
  ownership may change. The lock that had to be dropped for the wrong reason is simply not needed for
  the right one.
- **Two checks, and neither is enforcement alone.** `desk.topic-lock-coverage` proves each ownership
  function calls `Assert-NotebookTopicLockHeld`, that the declared writers are exactly those checking
  ownership, and — against a fixture with a planted foreign owner — that the refusal is live rather
  than merely present. `desk.lock-order` can finally *see* the Notebook family: it reads the wrapper
  functions from `Get-SeatLockAcquiringFunctions`, classifies a composed root like `notebook/$Topic`
  by its literal head, refuses to pass with any declared class unobserved, and pins its own
  classifier both ways against a fixture.
- **A day-one migration, run the day the rule shipped.** `notebook/2nd-b-vault-dev` was handed to
  seat `2nd-b-vault-dev` through the real helper. Without it the new invariant would have bricked that
  seat out of its own topic — a whole-collection guard meeting legacy data, which this repository has
  paid for before.

## What this does not cover

- **A direct `Write` or `Edit` into `notebook/`** still bypasses claim, ownership and the render step.
  That is one of the three rulings the seats review left to Eric, and it is deliberately not settled
  here.
- **Ownership rows still key on the seat SLUG**, not on a seat incarnation, so a reused seat name can
  still inherit an old seat's topics. That is the *give retirement an identity* item;
  [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) supplies the
  `seat_id` it will need, and until then slug reuse is refused.
- **`desk.lock-order` still does not model releases**, so it reads two sequential acquisitions as
  nested. Test runners are excluded for that reason, and the runtime assertions —
  `Assert-SeatRegistryLockHeld` and `Assert-NotebookTopicLockHeld` — are what hold the contract at
  the moment of the call.

Full record: [Seats](../seats.md).
