# The Library is a foundry for spin-off projects, not their home

The Library is used to develop products that are not the Library — most of them meta: knowledge
tools, prompt sets, workspace conventions. That is a goal, not an accident, and the reader wants more
of it. But every such product resembles the Library closely enough to collide with it, and two
collisions have already cost material.

A spin-off project may use the Library's **instruments** freely: its Project Hub, its review skills,
its Books, its Notebook. It may not use the Library as its **working tree**. The product's source of
truth lives in a repository of its own, and the Hub's `## Repo` section names it.

## Status

accepted — 2026-09-01.

## What actually went wrong

Both incidents came from one product living inside another's namespace, and neither was caught by
anything structural.

**The repository root.** `PLAN.md` is the filename `claudex-loop`, `codex-review`, and
`grill-with-docs-codex` all default to. On 2026-08-31 Librarian 2.0's plan was found in the working
tree on top of the Library's own committed 922-line plan, reduced to 113 lines and uncommitted;
roughly nineteen sources cite that file *by item number*. One `git add -A` would have repointed all
of them. ADR-0008 closed this with `workspace.plans-declare-their-owner`, but that check legalizes
the tenancy rather than ending it: a namespaced plan with an owner line is permitted to sit at the
root indefinitely.

**Reader space.** Librarian 2.0's five design documents were parked in `raw/librarian-2-dev/`.
`raw/`, `notebook/`, and `shelf/` are gitignored on purpose — *"a checkout that recovers a script must
never roll back the reader's knowledge"* — and are swept by a Library Reset. The documents were not
reader knowledge, and they were lost, along with two Notebook articles. What survived did so because
it was tracked (`PLAN-librarian-2.md`, the review log, the checker) or because a 2026-08-28 triage had
copied it to the Hub. Nothing failed; every rule worked as designed. The product was simply in a
folder whose contract is "this is disposable."

The ledger did not notice either. `internal/raw-batch-owners.json` still declared two batches owned by
`librarian-prompts-v2` after `raw/` was empty, and `raw.batch-owners` reported "6 records, all valid"
— it calls `-Action Validate`, which checks schema. `-Action Report` knew: it prints `NO DIRECTORY`
for every one. The gate was asking a question the helper could already answer better.

## The rule

**Instruments, yes. Namespace, no.**

| The Library provides | The spin-off's own repository holds |
| --- | --- |
| the Project Hub — session history, open items, connected tools | the product's source files |
| `claudex-loop`, `codex-review`, cold-read subagents | its plan and review logs |
| Books and the Notebook it draws on | its own tooling |
| ADRs about *the Library's* handling of such projects | ADRs about *the product* |

The Hub's `## Repo` section already carries this: `docs/project-hub-design.md` defines a working tree
as *"live, external, belonging to the project rather than to the Library."* This ADR states the
converse plainly, because the dev-Hub shape describes what a bound tree looks like without saying that
the Library must never be one.

Install testing is the sharp edge. A product that writes files into a workspace root must be tested
against a root, and the Library is a root. Those tests go in a disposable sandbox outside both the
Library and the product's own repository.

## Considered options

**Give spin-offs a tracked `dev/` directory inside the Library.** This was the first recommendation
and it is genuinely simpler: one repository, one gate, immune to a reset, and it extends a precedent
already set when the 2.0 checker moved to `tools/librarian-2/`. Rejected because it fixes only the
loss and not the confusion. The Library would still be the working tree an agent is standing in while
reasoning about a product whose vocabulary overlaps the Library's almost word for word — `notebook`,
`triage`, `Desk`, `Book`, `Shelf`, `reset` all mean different things in the two systems. And each new
spin-off adds a tenant to a namespace whose whole problem is that it is shared.

**Extend `workspace.plans-declare-their-owner` to more file classes.** Rejected as unbounded. The
takeover vector was root plans; the loss vector was `raw/`; a third product would find a third
surface. Enumerating namespaces is a losing game against a class of failure whose cause is that the
product is inside at all.

**Ban spin-off development in the Library entirely.** Rejected — it discards the thing that works.
The Hub, the review loop, and the Books are exactly why this project moved fast, and the reader's
stated goal is to do more of this, not less.

## Consequences

Librarian 2.0 moved to `D:\librarian-v2` on 2026-09-01 with its plan, review logs, and checker. The
Library keeps its Hub and the four restored Notebook articles. `PLAN-librarian-2.md`,
`PLAN-REVIEW-LOG-librarian-2.md`, and `tools/librarian-2/` are gone from this repository, and the two
`librarian-prompts-v2` raw-batch records are withdrawn.

**A new check, `workspace.no-foreign-install`.** It fails if `_triage.md` or `holding.md` appears at
the Library root — both are load-bearing filenames in 2.0's install, attested by its Hub — or if
`CLAUDE.md` stops carrying the three anchors by which this workspace introduces itself. Mutation-proven
three ways: each installed filename present, and `CLAUDE.md` overwritten by a plausible 2.0 layer-1
block.

It names files rather than a layer marker, deliberately. The documents that would define a marker now
live in another repository, so a marker string asserted here could go stale without this repository
ever seeing the change. The `CLAUDE.md` half is the general one: it does not care which product
overwrote the file, only that what remains still says this is the Library.

**What this does not cover.** The check is a tripwire, not a boundary — it reports an install that
already happened. Nothing prevents one, because nothing in this repository runs when an agent pastes a
prompt into a session. The real guard is the working-directory split and the spin-off's own
`AGENTS.md` saying so.

**The dangling-ledger gap is left open, and it is not this project's.** Raw-batch records can
name batches with no directory, because a reset empties `raw/`. Withdrawing them would delete
ownership history the reader may want when the material is restored. The honest fix is for
`raw.batch-owners` to surface what `-Action Report` already knows, and that is Library work with its
own decision to make.

**Decisions about a spin-off go in the spin-off's repository.** ADR-0003's subject-follows rule
already says a decision lives with its subject, and *"that is this repository's `docs/adr/` only when
the subject is the Library itself."* Giving a spin-off its own repository changes the answer for it
from the Hub's `decisions/` to its own `docs/adr/`. This ADR is in the Library's because its subject
*is* the Library — how it hosts other people's products.
