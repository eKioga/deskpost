# Kickoff template

Fill the block, then run `node tools/kickoff-check.mts <file> --train <register file>` before posting it.
Authoring rules, including Audit and Second read lines, are in [The Kickoff](dev-loop-orchestrator.md#the-kickoff).
The builder follows [the session loop](dev-session-loop.md) for OPEN, the yes, default limits and CLOSE.

```markdown
# <P><NN> kickoff: <outcome>

<p><NN>, AT <build seat> (<builder or builder and integrator>). author_seat: <orchestrator seat>.
Revision: **r1**. Base and docs/dev-session-loop.md as committed at `<SHA>`; branch `<unit branch>`.

TRAIN: <open train item id>

WHY NOW:
- <goal, evidence at the base, and what already does it>
- **How this could cost time later:** <likeliest wasted run and what prevents it>

OWNS PATHS:
- `<path or pattern>`

STAY OUT OF: <other worktrees, branches, stashes and anything outside this unit>

ROWS:
1. **<reader-visible outcome>**: <smallest change, where and why; Catches here for any wait>.
   Done when: <check and expected result>.

CHARTER (effective only on Eric's yes at OPEN): <rows as commits; named merges and one private push if assigned>.

CLOSE: <handback, row outcomes, proofs, timings, choices, Needs you and letter to the orchestrator>.
**Stop.**
```

Optional headings: SIZE, OWNS, WHERE THINGS STAND, MERGE, COMMANDS, NOT CHARTERED, RULES, STANDING ANSWERS, OPEN.
Use them for unit-specific detail, such as a merge or sensitive-file notes; keep their order from the authoring guide.

A MERGE records its identity-scan line. A clean non-fast-forward merge runs `commit-msg` without pre-commit;
only a hand-finished merge's commit runs pre-commit. The push tier judges the outgoing range.
