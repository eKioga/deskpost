# "Reset my workspace" routes to the Library Reset on every surface a session reads

A reader saying "reset", "start fresh", or "reset my workspace" in this workspace means the **Library
Reset** — removing the Notebook and clearing the Desk — and never a Git cleanup. The two are easy to
confuse, and confusing them is expensive in both directions: a Git cleanup destroys tracked work the
reader did not ask to lose, and a Library Reset performed when a Git cleanup was wanted leaves the
repository untouched while deleting the Notebook.

The reader's own wording is claimed explicitly on every surface a session actually reads, rather
than being left to inference from a glossary entry one of them happens to cite.

## Status

accepted — 2026-08-26, shipped as `b8abfa9`.

Moved here from the Library Development Hub's `Now` section on 2026-08-31 by ADR-0003.

## Considered options

**Define it once in `CONTEXT.md` and let the other surfaces inherit.** Rejected. A session that has
compacted, or one driven by Codex rather than Claude, does not necessarily have the glossary in
context at the moment the word is used. The claim has to be where the reading happens.

**Ask every time.** Rejected as the default. Asking is correct when the reader might genuinely mean
repository cleanup, and `CONTEXT.md` says so — but defaulting to a question on an unambiguous term
makes the ordinary case worse to serve the rare one.

## Consequences

`CLAUDE.md`, `CONTEXT.md`, `AGENTS.md`, the operation playbook, and the `library-help` Skill all
claim the reader's wording, and all five state that **a clean working tree is never evidence a Reset
happened**. That second half matters as much as the first: a clean branch is exactly the observation
that invites the wrong conclusion.

`Reset-LocalNotebook.ps1`'s own preflight says it touches no repository file and runs no Git command
— the sentence a reader meets at the approval moment, where it is load-bearing rather than
informational.

The gate check `reset.vocabulary-routes` asserts both halves across all five surfaces and drives the
helper for real, asserting it still reports the open Books and Hubs. That last assertion is the
evidence a clean branch cannot supply. Mutation-proven both ways.
