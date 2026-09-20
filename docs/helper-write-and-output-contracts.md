# Helper Write and Output Contracts

Two dot-sourced modules impose a contract on every helper that uses them, and in both cases the
reason is invisible at the call site: `tools/BookWriteGuard.ps1` decides what a helper can undo, and
`tools/LibraryOutput.ps1` decides whether a caller can read what it returns. This record exists
because a call site shows the call and never the decision behind it — `Enter-BookLock` looks like
bookkeeping, and `-Json` looks like a formatting preference. Neither is.

It also disambiguates the journal kinds under `internal/`, which is the thing most often got
wrong: they are six artifacts with six different jobs, and only two of them can roll anything back.

Written 2026-09-08, when the `library-dev` Hub's `connections` page was sorted and these were the
only two subjects on it with no record anywhere else.

## What this does not cover

Four neighbouring pieces already have records, and this page does not repeat them:

| For | Read |
|---|---|
| the lock's own semantics — non-re-entrancy, passing a held handle in, releasing only what was acquired, Book-root normalisation | [Discovery Manifests](discovery-manifests.md), *It is 0.7's lock, not a second one* |
| `Write-AtomicText` and why a derived index publishes by rename | [Derived Indexes](derived-indexes.md) |
| the batch journal's state machine, and the plan's write / delete / touch sets | [Library Triage Design](library-triage-design.md), *Write set and touch set are different things* |
| why an existing page counts as success only against the bytes a single-page write would produce | [Topic Graduation](topic-graduation.md) |
| the paginated `list_directory` and its completeness proof | [Book Currency Anchoring](book-currency-anchoring.md) |

## The lock is the Book's, and it is taken before anything is read

Ordering alone protects against a crash, not against two writers interleaving, and the reader does
run more than one session. So the lock is acquired **before prior state is read or journaled**, not
merely before the write. The reason is specific: a concurrent mutation during capture makes the
journal describe a state that never fully existed, and a later rollback against that journal would
overwrite another writer's committed change. A rollback built on a torn capture is worse than no
rollback, because it is confident.

A surviving lock is stealable after 30 minutes (`$script:StaleLockMinutes`), so an abandoned lock
costs delay rather than a wedged Book.

## The rollback journal records absence as well as content

Before any mutation, the journal records four things:

- the **prior body** of every page the operation will change;
- the **prior absence** of every page it will create — so rollback *deletes* rather than
  resurrects, which is the half a body-only journal gets wrong;
- the affected paths;
- the operation digest.

Rollback then **verifies by readback** rather than assuming the undo worked. The journals live in
`internal/shelf-journals/`.

## Not every journal can roll anything back, and one of them defines a boundary

`Edit-ProjectHub.ps1` journals a previous body. **The publishers do not** — a publication journal
records the *new* manifest and hashes, which describes what now exists rather than what was
destroyed. Do not cite a publication journal as evidence that a write is reversible.

That is not a gap to fix; it is load-bearing. Because a shared refresh has no rollback,
`replace_existing` is rejected at **triage plan validation** rather than merely left unused, and
refreshing an existing shared Book is a separate, separately approved operation. A misclassified
replace inside a batch would be an action the batch could not undo, bound into an approval that
implied it could.

## Six journals, six jobs

They are not variants of one thing, and the names are close enough to swap by accident.

| Path | Job | Spans |
|---|---|---|
| `internal/shelf-journals/` | **rollback** — undo one operation's page writes | one operation |
| `internal/graduate-journals/` | **progress** — which entries of a topic graduation landed, so a retry resumes rather than restarts | one run, resumable |
| `internal/triage-journals/` | **batch state** — carried across processes, which is what makes resume implementable at all (`handoff-journals/` before 2026-08-28, still read, never rewritten) | many processes |
| `internal/manifest-journals/` | the manifest updaters' own record | one update |
| `internal/publication-journals/` | what a publish or Hub edit **produced** — new manifests and hashes, plus a prior body where the writer captures one | one publication |
| `internal/move-journals/` | **rollback and progress at once** (2026-09-19) — one folder cutover's hashed inventory, the pointer files' prior bytes, and every stage it reached, so a run is both resumable to read and reversible by `tools/Move-LibraryFolder.ps1 -Action Rollback` | one cutover, across processes |

The pair most worth keeping apart is the first two, and `Add-ShelfBookTopic.ps1` says so in its own
header: the rollback journal undoes one page's write, the progress journal records what landed across
many. A progress journal written only at the end cannot survive the interruption it exists for.

## `-Json` is opt-in, and that is what preserves composition

Helpers are called two ways and the two need different output.

**In-process**, one helper composes another: `Invoke-LibraryTriage.ps1` calls `Publish-BookCopy.ps1`
through `& $publisher @args` and reads `$child.plan_id`. That caller needs a rich object.

**Across a process boundary** — `powershell.exe -File tools/<helper>.ps1` — PowerShell returns
*formatted text*. A caller projecting a field out of that silently receives empty records rather than
an error, and this is not hypothetical: it already made a successful, journaled shared write look
like a failure.

So the mode is explicit rather than global, and `-Json` is off by default. That default is the part
that matters: a nested caller simply does not pass it and keeps getting objects. Making every helper
emit JSON unconditionally would fix the boundary case by reproducing the empty-field bug *inside* the
composed call — the same defect, one layer down, where no process boundary explains it.

Failures leave by a different door: **stderr plus a non-zero exit code**, never a formatted object on
stdout that a caller might mistake for a result.

## Key Takeaways

- The lock is the Book's and is taken before prior state is read, because a journal captured during
  someone else's write would make rollback destructive.
- A rollback journal records prior **absence** as well as prior content; otherwise undoing a
  creation resurrects a page instead of removing it.
- Only some journals carry a previous body. A shared refresh has no rollback, which is why
  `replace_existing` is refused at plan validation rather than handled.
- Six journal kinds live under `internal/` with six different jobs; the rollback and progress
  journals are the pair most easily confused. The cutover journal is deliberately both: a folder
  move has to be readable mid-run *and* reversible, so it records prior bytes and every stage.
- `-Json` is opt-in so that in-process composition keeps receiving objects. A blanket JSON contract
  would move the empty-field defect inside the composed call rather than removing it.
