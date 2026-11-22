# Kickoff template

Fill the block, then run `node tools/kickoff-check.mts <file> --train <register file>` before posting it.
Authoring rules, including Audit and Second read lines, are in [The Kickoff](dev-loop-orchestrator.md#the-kickoff).
The builder follows [the session loop](dev-session-loop.md) for OPEN, the yes, default limits and CLOSE.

```markdown
# <P><NN> kickoff: <outcome>

<p><NN>, AT <build seat> (<builder or builder and integrator>). author_seat: <orchestrator seat>.
Revision: **r1**. Base and docs/dev-session-loop.md as committed at `<SHA>`; branch `<unit branch>`.

TRAIN: <open train item id>
DELIVERABLE: <slug>

WHY NOW:
- <goal, evidence at the base, and what already does it>
- <when citing a push command as evidence, quote the exact form and name the run or record it came from. Put the evidence here. Put actual work in ROWS or OPEN and its authorization in CHARTER.>
- **How this could cost time later:** <likeliest wasted run and what prevents it>
- **Lane:** <lane from docs/areas.json>
- **Cross-lane:** <paths in inline code> (<why>; only when OWNS PATHS names a file in another lane's area)

OWNS PATHS:
- `<path or pattern>`

STAY OUT OF: <other worktrees, branches, stashes and anything outside this unit>

ROWS:
1. **<reader-visible outcome>**: <smallest change, where and why; Catches here for any wait>.
   Done when: <check and expected result>.

CHARTER (effective on the posted Run pointer's hash, Eric's standing yes, or on Eric's yes at OPEN): <rows as commits; named merges and one private push if assigned>.

STANDING ANSWERS: the stop list in dev-session-loop.md applies.
CLOSE: <`node tools/land.mts --open int/<unit> --token-item "<item>"` (the unit ends at "pull request open"); handback with the pull request's number, row outcomes, proofs, timings, choices, Needs you and letter to the orchestrator>.
**Stop.**
```

Optional header line: `CHAIN: yes`, on a line of its own after the Revision line. It lets a builder start this Kickoff in
the same session as the one before it, when `deskpost kickoff next` answers start; absent means no. Write it only on a
Kickoff on another branch whose rows wait on no review, and on the one before it.

Optional headings: SIZE, OWNS, WHERE THINGS STAND, MERGE, COMMANDS, NOT CHARTERED, RULES, STANDING ANSWERS, OPEN.
Use them for unit-specific detail, such as a merge or sensitive-file notes; keep their order from the authoring guide.

A MERGE records its identity-scan line. A clean non-fast-forward merge runs `commit-msg` without pre-commit;
only a hand-finished merge's commit runs pre-commit. A builder unit ends at "pull request open" with
`node tools/land.mts --open int/<unit>`; the push tier is for release and cut units only.
