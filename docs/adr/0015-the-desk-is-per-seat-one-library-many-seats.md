# The Desk is per-seat; one Library, many seats

The reader's bottleneck was that hour-long tasks serialise. One workspace held one Virtual Desk, so
working a second topic meant closing the first topic's Books or cloning the checkout.

The Library is **already multi-topic**. `raw/<project-slug>/`, `notebook/<project-slug>/`, both
Catalogs and the shared collection all hold many subjects today, and the lock primitive was
generalised past Books long ago. The only single-seat thing in it was the Desk — two gitignored
files.

So this adds **seats to the reading room** rather than cloning the library. One checkout, one
collection, one Shelf, one Notebook, one lock namespace, one Discovery index, N Desks. A **seat** is
a named place to work, carrying its own Desk and bound to exactly one Project.

## Status

accepted — 2026-09-07. `PLAN-multi-desk.md` Release 2.

## Considered options

**Clone the checkout per topic.** Rejected, and it is what the reader was already driven to. It
duplicates the collection, the Shelf, the Notebook and the lock namespace — so two clones take two
different locks over one NAS collection, and exclusion that looks present is absent. It also
multiplies every future migration by the number of clones.

**Git or Orca worktrees as seats.** Rejected. Worktrees isolate *code*, which should not vary per
seat, and they put each seat on its own branch. The thing that needs to vary is which Books are open,
which is not a code property at all.

**Call it a room.** Rejected, and it was the reader's own first word. "Room" implies a separate space
holding separate material — the exact misconception this design corrects, since every seat shares
one collection. `carrel` was precise and too obscure. Plural `Desks` overloads one glossary entry
with two senses.

**Ship it in phases.** Rejected as not available. Round 1 of review established that a half-migrated
Desk leaves a Book **open for reading and closed for searching**, because the reader and the search
helpers resolve the Desk independently. Vocabulary, resolver, seat lifecycle, cross-seat safety and
the reader-facing surfaces are one release or they are a defect.

## Consequences

**`CONTEXT.md` is the authority, and it landed first.** The **Seat** entry and the amended **Desk**
entry are in the same commit series as the first seat-aware line of code, because the glossary is the
project's only vocabulary authority and a domain term cannot enter the code ahead of it.

**There is no default seat.** *(Ruled by Eric, 2026-09-07.)* `main` was the locked cosmetic value and
it collided with `BASIC_MEMORY_DEFAULT_PROJECT=main` in the reader's own deployment — one word for
two unrelated concepts, which is what the glossary's `_Avoid_` lines exist to prevent. Renaming it to
`primary` would have removed the collision and kept the real hazard: **a default is the seat an
unset `LIBRARY_SEAT` falls back to, and under the one-project-per-seat binding that same seat holds
live work.** Any process that lost its seat would not fail; it would silently join whatever was in
play there. So the default is gone, and *unset* is a refusal distinct from *unknown*, each naming its
own fix.

The cost is real and was accepted with the ruling: seat resolution sits upstream of the claim, so a
session started outside `tools/Start-LibrarySeat.ps1` has no Desk, and the surfaces that read one
— the validated reader adapter, both Shelf guards, `Get-DeskOverview` — refuse rather than
default. All three already fail closed on unreadable Desk state, so the direction was not invented
here. Each takes an explicit `-Seat` so an ad-hoc run never needs the launcher.

**The Desk's location is owned by `BookRootSchema.ps1`,** which already owns its content schema. It
is `.claude/seats/<seat>/.open-books` and `.open-projects`; `$StateDirectory` keeps meaning
`.claude`. Nineteen production sites across fifteen files composed that path by hand, and
`desk.seat-paths-resolve` is the AST check that stops nineteen regrowing into twenty-five.

**A seat binds exactly one Project, and a Project is bound by at most one live seat.** The binding is
unique in both directions. Two seats binding one project would both target `notebook/<project-slug>/`
and `output/<project-slug>/`, and the singular topic-owner record cannot represent two owners safely.
A seat's Desk may still hold several Project Hubs — reading a Hub is not owning a project.

Full record: [Seats](../seats.md). The reset half is
[ADR-0016](0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md).
