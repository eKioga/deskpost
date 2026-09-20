# Where Deskpost came from

A short record of the project's origins, its debts, and where the design records that are not in
this repository actually live.

## It started as an LLM Wiki

Deskpost began from **Andrej Karpathy's LLM Wiki prompt** — the idea that an assistant should build
and maintain a wiki of what it has learned, rather than re-deriving it every session. That prompt is
the seed of everything here: the Notebook, the separation of raw source material from distilled
understanding, and the habit of writing a finding down where it can be found again.

The debt is visible in the code. Several of the earliest Books were converted from separate LLM Wiki
workspaces, and those conversions were not uniformly clean — which is why
[`docs/topic-overlap-records.md`](topic-overlap-records.md) and `tools/Set-TopicOverlap.ps1` exist at
all, to record where the same subject ended up under two names.

What changed since is the part the prompt did not cover: **what the assistant is allowed to read.**
A wiki grows; a reading room is arranged. The Desk, the open/closed state of a Book, and the
validated reader that refuses anything not deliberately opened are the answer this project arrived
at, and they are what the name now points to.

## The AI Library Pilot

Before it was a product it was a pilot, closed out on **2026-08-15**. The record is preserved as
written in [Pilot Success Closeout](pilot-success-closeout-2026-08-15.md) and is not edited — its
feature-freeze posture was retired two days later, but its account of the decision stands.

The pilot's purpose was to find out whether the thing was useful on real work rather than on
fixtures, and the decisive evidence was ordinary: it carried a real research-and-build effort
through to completion without needing extra process around it. Everything in this repository that
looks like paranoia — the preflights, the `plan_id` approvals, the journalled rollbacks — comes from
that period, when the answer to "can this lose my work" had to become no.

Historical records in `docs/` still refer to the Pilot. Those references describe evidence, not the
active workspace; see [Library Identity and Transition](library-identity-and-transition.md).

## The name

The workspace was called "the Library" for its first year, and the product had no name of its own.
That became untenable once a second product existed: every conversation had to explain both before
it could discuss either. **Deskpost** was chosen on 2026-09-19. The reasoning, the rejected
candidates, and the registry checks are in
[ADR-0032](adr/0032-the-family-name-is-deskpost.md).

"The Library" survives as the name of the workspace a reader works in, and "the Librarian" as the
voice. [`CONTEXT.md`](../CONTEXT.md) remains the only authority on the vocabulary.

## The design records are private, and deliberately so

This repository starts with **fresh history** ([ADR-0031](adr/0031-the-public-repository-starts-with-fresh-history.md)).
The commits that built it are not here, and neither are the documents that drove them:

- `PLAN.md` and the namespaced `PLAN-<topic>.md` files — the implementation plans, each hardened
  adversarially before any code was written.
- `PLAN-REVIEW-LOG-<topic>.md` — the review logs: every finding the reviewing model raised, and what
  was done about it, including the ones that were rejected and why.

They are private for one reason: they were written inside a working Library and they quote it. They
name endpoints, share paths, machine names and the maintainer's own reading material, because that
is what the work was about. Sanitising them would falsify the record — several of those documents
exist precisely to record the removal of a value, and they quote the value to do it.

**Some ADRs in `docs/adr/` cite a PLAN file by name.** Those citations are kept as historical
references rather than rewritten. A link that does not resolve here is not a broken link; it is a
pointer into a record that is not public. The docs link check knows this and treats `PLAN*.md`
references as external.

What *is* public is the reasoning: `docs/adr/` records every decision that outlived its plan,
including the reversals, and the checks in `tools/` carry their arguments in their own comments.

## Credits

- **Andrej Karpathy**, for the LLM Wiki prompt this grew out of.
- **Basic Memory**, which backs the shared collection in v0.
- **gitleaks**, the generic backstop in the identity scan for any machine without a denylist.
- Every model that argued with a plan before it was built, and lost some of those arguments.
