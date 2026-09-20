# Pilot Success Closeout — 2026-08-15

> **Status:** historical record. The adoption decision below still stands; its **feature-freeze
> posture was retired on 2026-08-17** and no longer governs. The Library is in active development.
> This document is preserved as written — do not edit its account of the 2026-08-15 decision. For
> the current posture see [Library Identity and Transition](library-identity-and-transition.md) and
> `output/library-dev/library-next-iteration-brief.md`.
>
> **Vocabulary note, 2026-08-28:** where this record says *handoff* it names the operation now called
> **triage**, which absorbed it and gained the Holding Shelf as a second source. The word is left as
> written because it was the word on 2026-08-15. Current contract:
> [Library Inventory and Triage](library-triage-design.md).

## Decision

The Pilot has met its purpose: it supported a real Buzz research-and-build effort through the
setup of the backend infrastructure, a second account, and working agents. The workflow now moves
from source material, through a local Notebook, to an explicitly approved Library copy only when
that context is worth keeping.

The reader experience is feature-frozen by default. Future changes should be a response to an
observed problem or an explicit reader request, not speculative Pilot expansion.

## Evidence retained

- The local-first Notebook, validated Book and Project readers, bounded reset/archive helpers, and
  manifest-bound Library handoff have all passed their focused acceptance checks.
- The Project-copy journal now records only completed, read-back copies. Reset preflight recognizes
  matching Project copies, identifies drift, and withholds incomplete copies.
- An independent Claude end-to-end check exercised a disposable Basic Memory project: preflight,
  confirmation binding, exact readback, current-copy recognition, drift detection, incomplete-copy
  withholding, and idempotent reuse all passed.
- The Human Director's live Buzz work supplied the decisive field-use confirmation: the Pilot was
  useful enough to carry a real infrastructure setup to completion without requiring extra process.

## Operating model from now on

1. Start a new project with a short plain-language description. Keep its sources in
   `raw/<project>/` and its working knowledge in `notebook/<project>/`.
2. Use the Notebook and open Books or Projects for ordinary work. Capture useful findings locally.
3. At a natural stopping point, ask what should be retained. Use the local handoff inventory and
   make a bounded copy to a Book or Project only when it has a clear future use.
4. Reset or archive local working material only after the relevant preservation decision. A reset
   preflight is advisory; it is not a backup claim.

## Maintenance boundary

- Fix demonstrated defects promptly and keep their regression checks.
- Before a reader-experience change, use the Pi-fit feature card and test the normal request, a
  nearby everyday variation, and the real safety boundary.
- Do not add automatic synchronization, lifecycle stages, background workflow, or new standing
  process without a specific reader benefit proven by ordinary use.
- Treat task-board integration as a later, staged option: read on request first, then explicit
  one-task writes if they become useful. Agent Mail is not part of the adopted Library runtime;
  use direct, explicit collaboration only when it is actually needed.

## Buzz handoff record

`internal/handoff-plans/handoff-20260815-010029-318c29a4.json` is retained as a historical
preflight plan, not evidence that its five selected Buzz pages were copied. There is no matching
completed Project-copy journal, and the local source path is no longer present. If that specific
operational context still needs preservation, create a fresh local source and a new preflight;
do not reuse the old approval or treat it as a completed copy.

## Next project

Do not create a placeholder Project. The next real project begins when the reader describes it;
that project is the ordinary-use confirmation that the adopted workflow generalizes beyond Buzz.
