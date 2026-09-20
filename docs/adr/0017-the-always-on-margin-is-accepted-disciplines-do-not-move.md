# The always-on margin is accepted; a discipline does not move to an on-demand Skill

`CLAUDE.md` stays at 808 of its 900-word budget, two words under the 810 warn line, and the
`## Keeping material` section stays where it is. The margin is accepted deliberately rather than
relieved.

Two rules follow from it, and they are the reusable part:

- **The 810 line is advisory and the 900 line is the gate.** `Invoke-LibraryChecks.ps1` exits
  non-zero on `fail` alone, so a `warn` blocks no commit. Crossing 810 is the early-warning band
  doing its job, not a rule being refused.
- **A rule whose trigger is the reader's imperative stays on the always-on surface.** `library-help`
  is described as answering *meta questions*. Material may move there when the reader would ask for
  it; it may not move there when the reader's words are an instruction to act.

## Status

accepted — 2026-09-08. Closes the `library-dev` Hub's *"Give the always-on surface real headroom, or
decide it does not need any"* item, and corrects the `limits` row that said the budget could not be
relieved by trimming — it can be, by 54 to 82 words, and the reason not to is what follows.

Applies [ADR-0003](0003-decisions-follow-their-subject.md): the subject is this repository, so the
decision lands here. Continues the 2026-08-14 reduction recorded in
[Librarian Operating Rules](../librarian-operating-rules.md), whose standing instruction is *"do not
re-copy detailed playbook steps into the always-on guide; add a concise trigger and link there
instead."*

## The reader benefit and the safety boundary, written down first

`.claude/rules/library-development.md` requires both before a reader-experience change. Working them
out is what decided this, so they are recorded even though the change was declined.

**The reader benefit of moving `## Keeping material` to the Skill: none could be stated.** The
reader's experience after the move is either identical — the Librarian loads the Skill and behaves as
before — or worse, because it does not. No reader gains anything in the good case. The entire benefit
accrues to the colour of one gate line. That is the wrong beneficiary for a change governed by the
reader-experience rule, and it is sufficient on its own.

**The safety boundary: a behavioural discipline must not move to a surface that loads on demand.**
The `limits` page has carried this sentence since 2026-09-06. What this decision adds is the sharper
test that made it decidable, because "is this a discipline?" was not:

> A rule that must survive a `/compact` stays in `CLAUDE.md`. A "how do I" answer may leave. When
> they conflict, ask what **triggers** the rule — a question the reader asks, or a thing the
> Librarian does. Only the first can live behind a Skill description.

## What the audit found, and why it changed the answer

The Hub item proposed moving three of the section's four bullets on the grounds that it is "the
section most fully duplicated by the `library-help` Skill". Checked bullet by bullet against the
whole Skill tree, that is half true, and the halves are the load-bearing part:

| Bullet | Duplicated in `library-help`? | Where |
|---|---|---|
| compile scope; keep indexes and `## Key Takeaways` current | **no** | the Skill's "never all of it" governs *search*, not compiling; `Key Takeaways` appears nowhere in the tree |
| capturing from an open Book is a local Notebook write; cite the Book and page with its limits; **make no shared write** | **no** | no counterpart anywhere under `.claude/skills/` |
| **"Save this for later"** → `Add-ShelfNote.ps1`, ungated | yes | `SKILL.md`, `references/capture-and-triage.md` |
| **"Put this in the X Book"** → `Add-ShelfBookPage.ps1`, additive | yes | `SKILL.md` |

Two of four, not three. And the two halves fall out in the worst possible arrangement:

- **The bullets that are duplicated are the two the Skill cannot be reached by.** Both are triggered
  by a reader's imperative — *"save this for later"*, *"put this in the X Book"*. The Skill's
  description enumerates interrogatives only: "how do I …", "what happens if I reset", "where should
  this go", "what tools are there", "why can't I read that". Nothing loads the Skill when the reader
  gives an instruction instead of asking a question. Worse, the clause that would be lost is the one
  that decides whether the Librarian may act *without stopping* — `Ungated, no open Book needed`. A
  Librarian that has lost it does not fail loudly; it opens a Book it did not need to open, or asks
  for an approval that was never required.
- **The bullets that are not duplicated are pure discipline, and one of them is a safety boundary.**
  `make no shared write` has no second copy anywhere in the workspace's on-demand material. Moving it
  is not relocating a duplicate; it is relocating the only copy.

So the move frees at most 24 words without evicting an undocumented safety rule, and buys those 24
words by removing the routing trigger for two ungated actions.

## What was measured

Every candidate was measured with the gate's own `Measure-InstructionWords`, extracted by AST from
`Invoke-LibraryChecks.ps1` rather than reimplemented, and falsified by reproducing 808 for the file
on disk. Measuring by eye is specifically untrustworthy here: the budget counts whitespace-separated
tokens, and the 2026-09-06 attempt to shorten `read_book_catalog` to "the catalog readers" took the
file **up**, from 803 to 807.

| Candidate | Words | Δ | To the 810 warn line | To the 900 gate |
|---|---:|---:|---:|---:|
| unchanged | 808 | — | 2 | 92 |
| move bullets 2, 3 and 4 (as the Hub proposed) | 754 | −54 | 56 | 146 |
| move bullets 3 and 4 only | 784 | −24 | 26 | 116 |
| trim the tails, move nothing | 802 | −6 | 8 | 98 |
| the whole section leaves | 726 | −82 | 84 | 174 |

Section by section, the file is 56 words of preamble, 99 Voice, 34 Where things live, 56 Starting
work, 161 Desk/Books/Projects, 93 Keeping material, 189 Answering a question, 120 Before anything
consequential. The three largest are the ones carrying the gate-asserted sentences and the source-
ordering discipline. The 2026-09-06 finding that "roughly none of it fails the must-this-survive-a-
`/compact` test" survives being measured rather than asserted.

## The premise this corrects

The Hub item said the two-word margin means "one added bullet re-warns the gate, and **that blocks
every future rule this project might want to add**." The first clause is right and the second is not.

`Invoke-Check` routes a `WARN: ` prefix to `warn`, and only `@($results | Where-Object { $_.status
-eq 'fail' })` sets `exit 1`. The pre-commit hook keys on that exit code alone. So a warn is visible
and blocks nothing; there are 92 words — four or five ordinary bullets — before anything is refused.

The distinction matters because the two states have opposite meanings. The warn band exists *to be
entered*: its own comment in the runner records why it was added, which is that `CLAUDE.md` "went
from 894 to over the line with nothing said in between." A budget that only speaks at the ceiling
gives no time to act. Restructuring reader-facing rules to avoid ever entering the warning band
would be spending the reader's clarity to keep a designed-for state from occurring.

## What happens when the warn fires

This is the part that keeps the acceptance from being a shrug. A permanent warn really would be
noise, so the response is defined in advance rather than left to whoever meets it:

1. **Do not trim to get back under 810.** The measurements above are the record that trimming buys
   6 words without moving something, and that everything larger crosses the boundary. Re-deriving
   this under pressure is how the boundary gets crossed.
2. **Ask the trigger question of the new rule.** If a *question* the reader asks would summon it, it
   belongs in `library-help` and never needed the always-on surface. If the Librarian's own action
   triggers it, it belongs in `CLAUDE.md` and the warn is correct.
3. **If it belongs and the file crosses 810, raise `$fileBudget` deliberately and record why.** That
   is a budget decision, taken once, with the aggregate line — 913 of 1,100, its own warn at 990 —
   as the real constraint. The file budget is a proxy; the aggregate is the cost.
4. **A path-scoped rule under `.claude/rules/` is the free move and should be tried first.** It costs
   nothing at launch, which is why the runner's own warn text names it ahead of a Skill body.

## What this does not cover

- **Whether the Librarian obeys any of these rules is not gated here, or anywhere.** The same split
  `docs/hit-is-a-location.md` draws applies: this ADR is a rule about where rules live, and
  `context.always-on-budget` enforces only the word count. A check that documentation satisfies must
  not be mistaken for the enforcement it is named after.
- **Six sentences in `CLAUDE.md` remain asserted verbatim** and are not editable as prose: the three
  `workspace.no-foreign-install` anchors (`# The Librarian`, `You are the Librarian of **the
  Library**`, and the glossary line naming `CONTEXT.md`), the hit-rule stem — which must match
  `SearchBoundaries.ps1`'s `$script:SearchHitRuleStem`, so rewording it breaks the check rather than
  the rule — and the reset vocabulary and evidence sentences that `reset.vocabulary-routes` matches
  across line breaks.
- **This decides nothing about the aggregate budget.** At 913 of 1,100 it has 77 words before its own
  warn line, and the next Skill description added to this workspace spends from it.
