# Raw batch ownership, with one authority for liveness

**2026-08-19. Plan item 3.1.** `tools/RawBatchOwnership.ps1` (internal, dot-sourced) and
`tools/Set-RawBatchOwner.ps1` (public). Gate checks: `raw.batch-owners` and
`raw-batch-ownership.selftest`.

Item 2.4 answered **scope** — a source batch is a canonical directory under `raw/` that the reader
names — and deliberately stopped there, because scope and ownership are different questions. This
item answers the second one: *which Project does this material belong to, and is that Project still
live?*

## Ownership is declared, because it cannot be inferred

`CLAUDE.md` documents the shape `raw/<project-slug>/<source-batch>/`. `raw/` does not follow it.
Its seven top-level directories are `Agentic OS Development`, `buzz-main`,
`deepseek-harness-master`, `DeepSeek-Reasonix-main-v2`, `Fallout 4 Modding`,
`LLM Workflow Testing`, and `lm-studio-bionic-docs-main` — whole repository checkouts and converted
wiki exports, none of them named after a Project slug, and one of them (`LLM Workflow Testing`) a
retired workspace whose batches sit one level down.

So deriving an owner from a directory name would be a guess dressed as a rule, and it would
*contradict* the documented shape rather than implement it. Ownership is therefore declared by the
reader, one batch at a time, and a batch nobody has declared is reported as **unmapped** — never
guessed. The rendered report says so in as many words, because the temptation this design exists to
resist is exactly the one a reader will feel when they see a list of unmapped batches with obvious
names.

## It is not a second authority on scope

`tools/RawSearch.ps1` owns what a source batch *is*, and every one of those decisions is called
rather than reimplemented:

- `Get-RawBatchRoster` supplies the shape of `raw/` at both depths a batch is actually found at.
- `Resolve-RawBatch` decides whether a reader-supplied name **is** a batch, and supplies the
  canonical path a record is stored under — so a record can never disagree with the search tier
  about which directory it names.
- `Get-RawProvenance` and its declared historical roots supply the `[historical]` label, which
  travels into the ownership report unchanged.

Two authorities on one question is the drift this codebase keeps paying for; the mutation that
removes `Resolve-RawBatch` from the writer is in the sweep for that reason.

**A mapping covers its whole subtree**, exactly as a declared historical root does, and for the same
reason: a repository checkout is one piece of source material whether the reader names its root or a
directory inside it. Longest declared prefix wins, so a reader who owns `LLM Workflow Testing` by one
Project and `LLM Workflow Testing/guild-lab` by another gets the specific answer. Prefix matching
respects the path separator, so `alpha-two` is not inside `alpha`.

Ownership is reported at the **top level**, because that is the unit a retention decision is actually
made about; `raw/` holds roughly 500 directories across the roster's two depths and listing every one
as separately unmapped would be a wall rather than a report. A root that is unmapped while something
beneath it is mapped says so, rather than reading as a flat *UNMAPPED*.

**There is no cap anywhere in this item.** The roots are a handful and the mappings are whatever the
reader declared. This phase already found one cap that could never bind, and a cap that cannot bind
is a flag nobody watches go red.

## Liveness is derived at read time and never stored

A record holds a batch, a Project **slug**, a date, and a note. It holds nothing about that
Project's state, because a stored copy of the state would go stale the moment a Project is archived
and nothing would say so. Every read joins the slug against the active and archived Project
Catalogs:

| value | meaning |
| --- | --- |
| `active` | the slug is listed in the active Project Catalog |
| `archived` | it is not, and it is listed in the archived Project Catalog |
| `unlisted` | it is in neither, and both were read successfully |
| `undetermined` | the catalogs could not be read, so the question was not answered |

The join is **decomposed** so that an unreadable *archive* catalog degrades only the slugs whose
answer depends on it: a slug listed as active is active whatever the archive says.

**An absent archive catalog is knowledge, not failure, and the two are told apart structurally.**
Basic Memory answers a read for a note that does not exist with a successful but *empty* record —
the signal `Test-AbsentRecord` in the validated reader adapter keys on. `Archive-ProjectHub.ps1`
creates `archive/projects/README.md` on the first archive, so `absent` genuinely means no Project
has ever been archived, and a slug missing from the active catalog is then `unlisted`. String-matching
an error message would have been a guess about wording. On the live run the real NAS returned
`catalog_active: ok, catalog_archive: absent`, which matches what the validated reader reports.

Validation is deliberately blind to whether the Project exists and to whether the batch is still on
disk. Both are read-time questions; a pre-commit check needing the NAS would fail whenever the NAS
was down, and `raw/` is gitignored, so on a fresh clone *every* batch is missing and every mapping
would fail. A mapping with no directory behind it is reported as stale — information — rather than
failing a commit.

## Eviction is offered, never performed

A batch whose owning Project is `archived` is named as a candidate, with the evidence. **Nothing in
this item deletes, moves, or modifies anything under `raw/`.** That is a deliberate scope boundary
rather than an omission: `raw/` is 1.9 GB of the reader's own source material, the deletion is
irreversible, and `CLAUDE.md` forbids improvising a workspace-wide deletion. The offer is the
deliverable; acting on it is the reader's, in their own file manager or shell.

A mapping naming a Project in **neither** catalog is a separate thing and is reported separately: a
record to correct or withdraw, not an eviction offer. An unlisted Project is one nothing knows about;
an archived one is a decision that was made.

## Where the record file lives, and why that differs from the historical roots

`internal/raw-batch-owners.json`, and `internal/` is gitignored. `RawSearch.ps1` keeps its declared
historical roots in *tracked source* for the opposite reason, and the two look alike enough to be
worth stating: a provenance label is **policy** and must survive a fresh clone, because a label that
can go missing is not a label. An ownership record is about reader material that is itself
gitignored — on a fresh clone the batches are gone too, and a mapping for a directory that does not
exist is not a loss.

Writes take the Book lock on the non-Book key `internal/raw-batch-owners`, because the file is shared
by every batch and a per-batch lock would let two declarations interleave a read-modify-write and
lose one. The write is temp-file-and-swap with a verified readback, the same idiom as
`Set-TopicOverlap.ps1`.

## What real input found that a green suite did not

The offline suite passed **87 checks on its first run**. Every defect below was found afterwards, by
running the helper against the real workspace and the real NAS.

1. **`Unable to find type [Net.Http.HttpClient]`.** `SharedBookSource.ps1` uses the type and does not
   load the assembly; all seven of its other callers happen to do it in their own preamble. Reported
   as a catalog that could not be read, which is the honest degradation — and still wrong.
   `Get-RawOwnerCatalogSet` now loads it.
2. **One flag doing two jobs.** `liveness_determined` answered both *were the catalogs read?* and
   *is the eviction list complete?* Those differ in exactly the state a fresh workspace is in: with
   the catalogs unreachable and no mapping declared, no mapping was undetermined, so the flag read
   **determined** while nothing had been read at all — and it sat beside a populated
   `liveness_reason` saying the opposite. Now `catalogs_read` (a property of the network call) and
   `eviction_determined` (a property of the mappings, vacuously true when there are none). The
   renderer gates its warning on the first and its eviction sentence on the second, and a third
   sentence covers the mapping-free case, because *"nothing to evict"* would otherwise be true there
   for a reason that has nothing to do with liveness.
3. **`unlisted` was reachable in the resolver and unreachable in the render.** A live mapping to a
   Project in neither catalog appeared nowhere in the rendered answer: a deeper mapping was visible
   only as a count on its parent root. The report now lists every declared mapping and names the
   dangling ones.
4. **The helper printed nothing when run as `powershell.exe -File`** — the exact form the permission
   allowlist uses. `Write-LibraryResult` returns the live object in non-JSON mode and `exit 0`
   discarded it before the format engine ran. `return`, as `Set-TopicOverlap.ps1` does.

## What the mutation sweep found

Twenty-one mutations, all watched red. Two fired nothing on the first pass, and they were different
kinds of nothing:

- **A redundant second gate masking the first.** Relaxing the writer's own `-cnotmatch` on the
  Project slug changed no observable behaviour, because `Test-RawOwnerRecords` carries the same rule
  and refused the write anyway — by the wrong gate, with the wrong message. The canary asserted only
  *that* the write was refused. It now asserts the **reason**.
- **A bad mutation, not a missing case.** Removing `.ToLowerInvariant()` from the duplicate-batch key
  changed nothing because a PowerShell hashtable literal compares keys **case-insensitively by
  default** — so the explicit lowercasing and the implicit comparer were two redundant mechanisms and
  neither was individually tested. `$seen` is now a dictionary with an `Ordinal` comparer, making the
  lowercasing the only thing doing the job, and the mutation fires.

Four further mutations went red by **killing the suite** rather than by failing an assertion: the
module verifies its own readback and throws, and an unguarded write in the suite is a canary that
takes every later check with it. The suite's mutating calls are now wrapped so a throw is a failed
assertion.

## Honest limits

- **No mapping is declared.** The record file exists and holds nothing. Declaring ownership is the
  reader's judgment by design, and this session deliberately did not make it on their behalf. The
  live write path was proved end to end — declare, report, validate through the gate, withdraw — and
  then withdrawn.
- **The `archived` liveness value has never been seen live**, because no Project has ever been
  archived: `archive/projects/README.md` does not exist yet. That branch is fixture-tested only, and
  it is the branch the whole eviction offer hangs on. The same class of gap as the meter's
  `secondary` window. Do not read *"handles archived"* as *"verified against archived"*.
- **Eviction performs nothing**, by decision above. If the reader later wants a gated eviction
  helper, it is a destructive workspace operation and needs the full preflight, `plan_id`, and
  approval apparatus — not an extension of this one.
- **`Get-RawBatchRoster` is called on every report**, which enumerates `raw/` two levels deep. That
  is a few seconds on 73,000 files and no page is read. It is not cached, deliberately: a cached
  roster is a second copy of the shape of `raw/`, and a batch added or evicted since the last run
  would be invisible.
