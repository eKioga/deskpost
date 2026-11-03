# Start a project

How a seat decides the approach for a new project, before any claudex-loop or build. Use it for a new project or a
change of a project's direction. Most work never needs it.

## When to use it, and when not

**Use it** for a new project, or when an existing project changes direction: a new goal, a new platform, or the
question "should we build this at all".

**Skip it** for a fix, a unit inside an approved plan, a question whose direction is already settled, or a bounded
request such as "give me three steps" or "compare these two". Those take the light path: answer in the shape the
reader asked for, and check each step as you go. A tool you happen to find while answering a question is not a new
project.

## The steps

1. **Ask only what is missing.** When two or more facts that would change the approach are unknown, ask for them in
   one batch of at most seven questions: who it is for, what it must and must not do, where it runs, what matters
   most, who builds it. "Not sure" counts as an answer. Never send the batch twice. If the reader says to skip the
   questions, go on and state the assumptions you made.
2. **Look at what exists first.** Start with the Library's Books and the project's own files. Then look at, normally,
   two comparable projects and the primary documentation. For each source, write down what it supports, what it does
   not, and the date you saw it. A popular project is not proof that it fits this one.
3. **Decide.** Give one recommendation and one credible alternative, what each gains and what each costs, and the
   condition that would make the recommendation wrong.
4. **Test the riskiest thing first.** Name the dependency most likely to sink the project and the smallest test that
   would show it holds. Give the test a stop condition, and say which result would justify more work.
5. **Stop researching on time.** After the first set of evidence, make one targeted follow-up round. Two lookups in a
   row that add nothing new end the search. Ask the reader before starting another round. A research budget matches
   house rule 2's default: at most three bounded probes or five minutes, unless the reader sets another. "Unknown" is
   a valid answer.

## Two boundaries

- **Reviewing means reading.** Reviewing a repository never installs, builds, tests or runs it without the reader's
  yes.
- **Private stays private.** A public search carries no names, private paths or unpublished plans.

## Two passes, because a new project has no seat yet

A brand-new project starts in a session with no seat, and a seatless session cannot open Books or write a Hub.

- **First pass, without a seat** (the guide's Step 0): the questions, the project's own files and public sources only.
  End with a provisional verdict, the recommendation and the alternative, said in the reply. Open no Book and write
  no Hub.
- **Second pass, once seated** (after the guide's Step 2): check the Library's Books for anything that changes the
  first pass. Then record the verdict, the recommendation, the alternative and the first test on the seat's Hub under
  `## Decisions`.

For a change of direction in an existing project the seat already exists, so the two passes are one. Building then
starts with a claudex-loop and a train item, on the reader's yes.

Inspired by the advise-project-approach skill (MIT, https://github.com/AaravKashyap12/advise-project-approach, read at v0.7.2 on 2026-11-01); no text is copied from it.
