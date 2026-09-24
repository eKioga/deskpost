# The Supported-Operation Matrix

Every operation the TypeScript kernel must carry, one row each, with the fixture it runs over and
the two invocations whose outcomes are compared. `PLAN-public-release.md` step 23 puts the rule
plainly: **nothing ports until its row exists.**

Written 2026-09-22 (S12), the first session of Phase D.

## What this is for

[ADR-0028](adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md) replaces roughly 60,000
lines of tested PowerShell with a TypeScript kernel. The question that decides whether that is a
rebuild or a regression is *how anyone will know the new one does the same thing*, and the answer
is not "the tests pass" — the new implementation has no tests yet, and the old one's tests are
written against PowerShell internals.

The answer this plan settled on came out of the plan review, where "zero diffs against the
PowerShell implementation" was rejected in one sentence: it is **neither achievable nor
sufficient**. Not achievable, because timestamps, ids and absolute paths differ between two runs of
the *same* implementation. Not sufficient, because two implementations can agree on the same
defect, and because an unenumerated scenario set can omit recovery, publication, refresh or archive
behaviour entirely and nobody would notice the hole.

So the oracle has four parts, and all four are in this repository rather than in anyone's head:

1. **An enumeration.** Every public helper in `tools/_helpers.json` is either exercised by a row
   here or named in `excluded_helpers` with a reason. `acceptance.matrix-covers-every-public-helper`
   fails in both directions, so an operation cannot be added to the Library without a decision about
   whether the kernel carries it.
2. **A fixture per row.** `tools/AcceptanceFixtures.ps1` builds nine workspace shapes through the
   real writers. A row names one.
3. **Normalisation, written down.** `tools/AcceptanceMatrix.ps1` lists exactly what is replaced
   before two outcomes are compared. Everything normalised away is a value *neither* arm is being
   held to, which is why the list is short and in one place.
4. **Approved deltas.** Where the two implementations are *supposed* to differ, the difference is
   named, justified, attributed and dated before the row it affects can go green.

## What a row is

| Field | Meaning |
|---|---|
| `id` | Lowercase dotted slug, unique. What you pass to `-Row`. |
| `area` | One of the port-order groups of step 24, or a cross-cutting concern. |
| `class` | `success`, `failure`, `recovery`, `concurrency`, `publication`, `refresh`, `archive`. |
| `oracle` | `differential` (compared against PowerShell) or `independent` (judged against a stated property). |
| `fixture` | The workspace shape the row runs over. Each arm gets its own, built from scratch. |
| `readonly` | The operation must leave the workspace unchanged. |
| `requires` | What the row needs beyond a local workspace. Skipped, with the reason, when it is absent. |
| `prepare` | Optional. Whole files written into each arm's freshly built workspace before anything runs -- for a state no Library writer produces. |
| `seed` | Optional, and only on a row that needs the shared collection (S33). Steps run into each arm's own disposable project before anything is snapshotted: a PowerShell writer (`script` and `args`, held to every rule a step is, `-ProjectId {collection_id}` included), carrying a preflight's `{plan_id}` to the next seed step; or `collection_note` and `text`, one whole note written through Basic Memory, for the one state no writer leaves. `{second_workspace}` names a second workspace pinned to the same project, built only for a row that uses it. |
| `powershell.steps` | The invocation that is the oracle today. Every script is resolved on disk by the gate, and since S31 every argument is bound against the script's own declared parameters, as PowerShell binds them: a name or a unique prefix, a value for anything but a switch, and a parameter set holding every argument and every mandatory parameter. A script with no `param()` block takes `$args` and is not bound. |
| `kernel.steps` | The invocation the kernel must answer with the same outcome. Every verb, action and reader tool it names is resolved against `library verbs` by `acceptance.kernel-verbs-exist`; the values it passes are not, because a check cannot resolve a Book slug. |

A row with more than one step carries a plan id from one step to the next, which is how a gated
operation — preflight, exact `plan_id`, one approval — is expressed as a single row.

## What "the same outcome" means

Both arms are reduced to a flat `field → value` map:

- `exit` — the exit code.
- `result.<dotted path>` when stdout parsed as JSON, or `stdout` when it did not.
- `stderr`, when it is not empty.
- `effect.<relative path>` — **one entry per file left under the workspace**, content normalised
  first. This is the half a return value cannot cover: a port that answers correctly and writes the
  wrong file is wrong, and stdout would not say so.

Normalised away, and nowhere else: the fixture's own paths (workspace, registry, fixture root), the
program root, the temp root, the user's home, host and user name; full timestamps; dated run
stamps; GUIDs; SHA-256 digests; line endings and trailing whitespace. A handful of keys whose
values are volatile without *looking* volatile — `pid`, `elapsed_ms`, `plan_id`, a claim token — are
replaced by name, because a number cannot be told from a meaningful one without knowing what it is
called.

**A PowerShell error record is reduced to the sentence it was raised with.** A helper that refuses
with `throw` has its message followed by `At <script>:<line> char:<col>`, the `CategoryInfo` line and
`FullyQualifiedErrorId`; one that refuses through `[Console]::Error.WriteLine` does not. That is a
fact about which language raised the refusal, and eleven rows here are `failure` rows. The
alternative — an approved delta on `stderr` — was rejected: the narrowest one expressible would let
the two arms refuse for *different reasons* and still compare green, on exactly the rows whose whole
subject is the wording of a refusal. Removing the decoration holds both arms to the same sentence.

Deliberately **not** normalised: a bare `yyyy-MM-dd`. The fixtures carry dated names on purpose — a
source batch, a capture page — and eating those would make two arms agree about a page neither one
wrote.

## An independent row is not a weaker row

Step 23 keeps four kinds of test *out* of the comparison: fault injection, concurrency,
interrupted-run recovery, and real-harness tests. The reason is not that they are hard. It is that
PowerShell is not a valid oracle for them — **two implementations can lose the same race and the
comparison would report agreement.** Those rows carry `oracle: independent` and a stated reason, and
they are judged against the property itself.

The harness lists them rather than running them unless `-IncludeIndependent` is passed, because the
suites that assert them today take minutes rather than seconds.

## Running it

```powershell
tools/Invoke-AcceptanceMatrix.ps1 -List
tools/Invoke-AcceptanceMatrix.ps1 -Row workspace.init-creates-marker
tools/Invoke-AcceptanceMatrix.ps1 -Area shelf
tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel 'C:\deskpost\library.exe' -RequireGreen
```

**With no `-Kernel`, every differential row reports `pending` — never `green`.** The PowerShell arm
runs and its normalised outcome is recorded; nothing is compared, and the harness says so in that
word. `-RequireGreen` is the Phase D closing gate — S21's row — and it fails until every row is
green.

**A kernel exists as of 2026-09-22 (S13).** It is reached in development as

```powershell
tools/Invoke-AcceptanceMatrix.ps1 -Area workspace -Kernel 'node kernel/src/cli.ts'
```

and as of 2026-09-22 (S14) it answers `init`, `mcp call`, the whole of `shelf` but `duplicates`, and
`desk`. Every other verb the matrix names is **declared** in `kernel/src/verbs.ts` and refuses by
name, which is what lets `acceptance.kernel-verbs-exist` tell a verb that is not ported from a verb
that is misspelled. A row whose verb is unported reports `mismatch`, honestly, rather than `pending`.

**A RELATIVE KERNEL COMMAND IS RESOLVED AT THE HARNESS BOUNDARY, AND IT WAS NOT UNTIL S14.** Every
step runs with its FIXTURE as the working directory, so `node kernel/src/cli.ts` -- the command this
document and `kernel/README.md` both print -- meant nothing where it ran. Measured 2026-09-22: every
row reported `mismatch` with `Cannot find module <fixture>\kernel\src\cli.ts` on stderr, which
reads exactly like an unported verb refusing, and all three ported areas showed 0 green. The command
line is still a command line rather than a path; what changed is that a part naming a file where the
caller typed it is made absolute before the working directory moves out from under it.

**As of 2026-09-22 (S17) it also answers `compile`, `notebook`, `reset` and `doctor`**, and three
things about the harness changed with it, each because a row was measuring something other than its
subject:

- **An array is compared as an array.** `ConvertTo-AcceptanceNormalisedData` returned `@(...)`,
  which PowerShell enumerates on output, so a one-element array reached the field map as its bare
  element and an empty one as `$null`: `["x"]` compared equal to `"x"`, and `[]` to `null`. It
  returns the array whole now, and all 38 rows green before the change stayed green after it.
- **A step may carry the quarantine its reset made.** `{quarantine}` is the leaf of the
  `quarantine_directory` a step reported, carried like `{plan_id}`. A reset names its directory
  `<seat>-<yyyyMMdd-HHmmss>` at the instant it runs, so a restore row cannot be written with a
  literal -- and until the token existed the restore row's oracle ran `-List`, which restores
  nothing, against a kernel arm that restored. The same stamp is now normalised to `<stamp>`, with
  the seat in front kept.
- **A row may `prepare` its fixture**: whole files, relative to the workspace, the same bytes in both
  arms before anything is snapshotted. For the one state no Library writer produces, a hand-edited
  derived index; `acceptance.matrix-shape` refuses a rooted path or one that climbs out.

**As of 2026-09-22 (S18) the kernel keeps each seat's Notebook at `notebook/<seat>/`** (ADR-0029), and
the compile and reset rows went from comparing one path to comparing two. Three things changed so they
still measure their subject:

- **`notebook-is-seat-owned` is a rebase, not a prefix.** It used to approve any field beginning
  `effect.notebook/`, content included -- a delta that would have turned every Notebook row green the
  moment the kernel wrote under a seat root, whatever it wrote. Now the ACTING seat's root in the
  kernel's outcome is rewritten onto the oracle's `notebook/`, keyed by that seat's value and in every
  spelling a path takes, and the content is then compared exactly. A kernel writing into another
  seat's root, a rebased file holding different bytes, and two kernel files rebasing onto one path all
  stay differences; the self-test's section 3g drives each. Files only one layout has are named
  exactly, and three sentences that say one fact in each layout's words are paired verbatim. It
  applies to `compile` and `reset` only, the two areas that write a seat's Notebook.
- **A legacy fixture is migrated on the kernel arm first.** `workspace-notebook` is the shared layout,
  which the kernel refuses to write (the reader's ruling), so the rows over it run `library migrate`
  before the operation, on the kernel arm alone. The migration's own records are the kernel-only
  files the delta names.
- **A kernel step may write a file.** `compile.master-index-is-derived-not-written` is about a hand
  edit, and under ADR-0029 the index a person would edit is one only the migration puts in place, so
  the row writes it after migrating. Whole files inside the workspace, as `prepare`, and never the last
  step.

`workspace-notebook` lost its declared-shared topic to a ninth shape, `workspace-legacy-notebook`,
which holds every state of the shared Notebook -- each produced by the legacy writer that produces it --
and is what `tools/Test-NotebookMigration.ps1` judges the migration over. The ADR-0019 ownership row
became `reset.topic-ownership-is-retired-by-adr-0029`, judged independently: the kernel has no ownership
writer to compare, and that is the property.

**As of 2026-09-22 (S29) the kernel under test may be the installed binary**, and it should be, because
a compiled kernel is not the program `node kernel/src/cli.ts` runs:

```powershell
tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel "$env:LOCALAPPDATA\deskpost\versions\0.1.0\bin\library.exe"
```

The first run against it found two things no source run could, and changed one rule to keep measuring
the subject:

- **The kernel arm is also normalised with the kernel's own program root.** The harness asks the
  kernel for its root once, through `library --version`, and the kernel arm reads that as `<program>`
  as well as this checkout's -- which it must keep, because its fixture was built by this checkout's
  writers. From source the two are one directory and nothing changes; installed, they are not, and
  five rows mismatched on nothing but the program's path. What that concedes: a kernel writing THIS
  checkout's path into a workspace would compare green. The self-test holds that a root belonging to
  neither program is never normalised, and that the PowerShell arm never reads the kernel's.
- **`init` over an existing workspace refuses when the program has moved**, and the oracle does too:
  measured by running the INSTALLED tree's own `Initialize-LibraryWorkspace.ps1` over a workspace this
  checkout initialised. So `workspace.init-is-idempotent` and `workspace.init-force-refreshes-managed-sections`
  mismatch against the installed binary, whose fixture another program built -- and a versioned
  install moves the program on every upgrade. That is S30's to settle, not a delta to approve.

**As of 2026-09-22 (S30) both are settled, and the concession is withdrawn.** The reader ruled that an
installed Library is rooted at `<install>/current`, a link onto the installed version
([ADR-0038](adr/0038-an-installed-library-is-rooted-at-its-current-link.md)), so an upgrade does not move
the program root; `tools/Test-KernelUpgrade.ps1` is the upgrade and rollback fixture. And the reader
ruled that the two `init` rows are judged over a fixture **the kernel's own program initialised**:
`New-AcceptanceFixture -ProgramRoot` takes the root the kernel reports, so the kernel arm's workspace is
built by the release tree's `Initialize-LibraryWorkspace.ps1` (this checkout's file, byte for byte) and
the rows ask what they say -- the same program running `init` again. With nothing in the kernel arm's
workspace naming this checkout, the kernel arm reads **only its own root** as `<program>`, and a kernel
writing this checkout's path is a difference again; the self-test holds that. Against the binary
installed through `current`: 49 green, 0 mismatch.
- **The claim was not exclusive under Bun.** Bun ignores libuv's share-nothing flag, so a compiled
  holder's `.claim.lock` could be opened by anyone and the kernel's own probe read every kernel-held
  seat as free; `seat.enter-an-existing-free-seat` mismatched on 21 fields. `seatclaim.ts` now opens
  that lock with `CreateFileW` and a share mode of 0 when it runs under Bun on Windows.

**As of 2026-09-22 (S31) a PowerShell step's arguments are checked as well as its script.** The Report
Inbox found five `hub` rows passing `-Slug` and `-Json` to helpers declaring neither. Binding every
row's arguments found twelve: those five, six `publication` rows passing the same `-Slug`, and the
launcher row passing `-WhatIf` to a script without `SupportsShouldProcess`. None of the twelve had
ever run its PowerShell arm -- eleven need the shared collection and the twelfth is independent. The rows now pass the parameters the scripts declare; `New-ProjectHub.ps1`,
`Edit-ProjectHub.ps1`, `Copy-LocalPagesToProject.ps1`, `Archive-ProjectHub.ps1`, `Archive-SharedBook.ps1`
and `Publish-BookCopy.ps1` gained the shared `-Json` switch, which returns the live object when absent
so their in-process callers are unchanged; and where a row's input changed, the kernel step was given
the same input. **What this does not prove:** that any of those rows is right. The binding says each
oracle call would reach its script's body, not what it would return, and the kernel's `hub new`
already reports different field names from `New-ProjectHub.ps1`. Every one of them is measured the
first time it runs against the NAS.

**The same session added the `guards` area**, the first half of S20's port: fifteen rows over the two
Shelf guards, each a PreToolUse payload handed to `.claude/hooks/Guard-*.ps1` and to `library hook` on
stdin, compared on the decision document -- or on the silence that is an allow. Payloads name
workspace-relative paths, because a `{workspace}` token substituted into a JSON string would put raw
backslashes in it. What the rows do not reach: an absolute path into another registered workspace,
and a contradictory workspace selection, which the kernel does not refuse yet. A seat-owned Notebook
write is the kernel's own rule and is judged by the kernel self-test, not here.

**As of 2026-09-22 (S32) the `guards` area also holds the Basic Memory guard**: fourteen rows, each a
`mcp__basic-memory__*` payload handed to `Guard-BasicMemoryRead.ps1` and to `library hook basic-memory-read`,
one per branch of the oracle -- the suspended readers, the pinned collection, name routing, a listing in
and out of an open Book, a non-canonical directory, a write to an open Hub and the three that are not
allowed, a tool it was not taught, and a seatless call. The rows `prepare` the Desk, because no fixture
opens a shared Book or a Hub. Two of them exist because writing the first twelve measured the oracle by
hand and found it wrong: `projects/<open>/../<closed>/x` passed as a page of the open Hub, and
`MCP__basic-memory__EDIT_NOTE` passed the tool test (`-in`, case-insensitive) and skipped the operation
allowlist (`-ceq`). **Both were fixed in the PowerShell guard before the kernel was written**, with a
regression in `tools/BookRootSchema.ps1`'s self-test, so the rows hold the port to the corrected rule
rather than to the defect.

**As of 2026-09-22 (S32) a shared row runs in disposable projects, and the rows ran against the NAS
for the first time** (the reader's ruling). `-IncludeShared` now needs `-McpUrl` and
`-SharedKnowledgeRoot`, read from nowhere else, because this machine's and this checkout's configuration
name the reader's own collection. Each arm of each shared row gets a new `acceptance-<guid>` Basic Memory
project, accepted only when the project list changed by exactly that one; its fixture is BUILT pinned to
it; every step whose script declares `-ProjectId` passes `{collection_id}` (`acceptance.matrix-shape`
refuses one that does not); every step's environment carries `AI_LIBRARY_MCP_URL`, `AI_LIBRARY_PROJECT_ID`
and `LIBRARY_SHARED_COLLECTION_ROOT`; and the project is deleted after the row -- a deletion that
fails or leaves files turns the row into an error. `tools/AcceptanceSharedCollection.ps1` holds it.

What each arm leaves **in the collection** is now part of its outcome, as `shared/<path>` fields: a
shared write lands on the share, where the workspace effect never looked. Measured before it was
written: Basic Memory's write answers in ~70 ms and the file is on the NAS at once, but this machine's
SMB client serves a cached "not found" for 5 s and a cached listing for 10, so the harness waits out the
client's configured cache lifetimes after an arm before it reads the project. The first snapshot, taken
without that wait, saw an empty folder behind a Hub the helper had read back.

**What the first run measured, and what it did not prove.** `hub.new` creates its Hub, connections page
and catalog entry in its project, captured and compared. `Copy-LocalPagesToProject.ps1` did not forward
`-WorkspacePath` to `New-ProjectHub.ps1`, so from outside the workspace it refused -- fixed. The three
helpers with no `-WorkspacePath` run from `{workspace}` now. And seven rows reach their helper's body
only to refuse for want of a Hub or a Book the disposable project does not hold, or an owner it does not
have: both `Edit-ProjectHub` rows, `hub.archive`, the briefing (whose request also omits `slug`),
`reader.lists-the-project-catalog`, `publication.shared-book-archives-and-stays-searchable` and
`publication.catalog-entry-is-added-without-removing-one`; and
`publication.refuses-without-collection-ownership` returns the success row's own preflight, because no
workspace owns a new project. Those rows need the collection SEEDED, through the real writers, before
they measure what they say.

**As of 2026-09-22 (S33) they are seeded, and every one of the eight now measures its subject.** A row's
`seed` runs the real writers into each arm's project, the same invocations in both arms: `New-ProjectHub`
and `Set-VirtualDesk` for the Hub rows, `Set-CollectionOwner -Acquire` and a confirmed
`Publish-ShelfBookToShared` for the Book rows, and for the ownership refusal `Set-CollectionOwner -Acquire`
run from a SECOND workspace pinned to the same project. Four things were found on the way, each measured:

- **No writer creates a shared collection.** The publisher refuses a missing Book Catalog, and the fence
  reads a folder without `books\README.md` and `projects\README.md` as "not a collection". So a disposable
  project is given those two -- the Book Catalog's heading and `## Open a Book` insert target, and the
  Active Project Catalog as `New-ProjectHub` creates it, less the entry -- and nothing else: the archive
  catalogs are left to the archivers, which create their own.
- **No writer leaves a published Book unlisted.** Every publisher lists what it publishes, and
  `Remove-SharedEntry -CatalogOnly` refuses a live Book. The catalog-entry row's state is a LOST entry,
  which is a hand edit, so a `collection_note` seed writes the Book Catalog back to its empty body --
  the collection's counterpart of `prepare`.
- **Basic Memory does not report a no-overwrite conflict as an error.** `write_note` with
  `overwrite: false` over an existing note answers `isError: false`, `action: "conflict"`,
  `error: "NOTE_ALREADY_EXISTS"`. `New-ProjectHub.ps1` read only `isError`, then read back the other
  writer's page and reported `created` over it. Fixed in the oracle first; `Test-McpHelpers.ps1`'s store
  answered `isError: true` until then, so no helper had been tested against the real answer, and now it
  answers as measured with a race regression (2 of 264 red before the fix).
- **This machine's SMB client serves a note it has read once, stale, after the NAS changes it** -- still
  at 240 s, while a never-read file showed the change at once. The collection's before-snapshot read every
  note from the share, so the after-snapshot was a copy of it: `hub.new`'s catalog compared its old body
  against the kernel's new one, and a `readonly` shared row could never have seen a note change. The
  before-snapshot now reads notes through Basic Memory, so the after-snapshot's read is this machine's
  first; a readonly row reading unchanged across the two is the check that the two read the same bytes.

The briefing row asked for `project`, and the tool's parameter is `slug`; both arms ask for `slug` now.
The Hub-edit rows' `Now` entry lacked the status marker `Edit-ProjectHub` requires. A collection
ownership claim's `"pid"` -- the process that acquired the role -- is normalised by name in a file's text,
as the data rule already does for a `pid` field; a seat claim writes `pid=N` and is untouched.

**The kernel answers three shared rows.** `library hub new` against Basic Memory (`src/basicmemory.ts`, the
transport; `src/ownership.ts`, the fence), and `read_project_catalog` and `read_open_project_briefing`
through the Desk's pin: `hub.new`, `reader.lists-the-project-catalog` and
`hub.briefing-orients-without-opening-dependencies` are green against the NAS. The other six seeded
rows reach their subject in the oracle and mismatch honestly on a kernel verb that refuses by name.

**As of 2026-09-22 (S34) the kernel answers six more shared rows, and two oracles were fixed on the
way.** `library hub edit` (`src/hubedit.ts`), the preflights of `hub archive`, `shared archive` and
`shared list-entry`, and the write fence `library publish` meets (`src/sharedwriters.ts`) -- each oracle
run by hand against disposable projects before a line was written. `hub.edit-preflight-returns-the-section-before-it-writes`,
`hub.add-section-appends-one-dated-entry` (its written page and its journal compared byte for byte),
`hub.archive-retires-a-project-hub`, `publication.refuses-without-collection-ownership`,
`publication.shared-book-archives-and-stays-searchable` and `publication.catalog-entry-is-added-without-removing-one`
are green against the NAS. What each of those rows holds is a PREFLIGHT, or the one AddSection; the
confirmed archive, list and publish halves refuse by name in the kernel and no row holds them yet.

- **A helper's `-Json` result lost every non-ASCII character at the process boundary.** A child
  `powershell.exe` writes stdout in the console's OEM code page, 437 here, so the Catalog lister's preflight
  reported its entry with a hyphen where it writes U+2014 -- measured outside the harness with one
  `Write-LibraryResult -Json` and a byte dump. `Write-LibraryResult` escapes everything above U+007F as
  `\uXXXX` now (the same JSON, which no code page can bend), with a `LibraryOutput.ps1 -SelfTest` check
  that reads a real child's raw bytes (2 of 10 red without it), and the kernel's `emit` does the same.
  The harness still decodes a child's stdout in the console code page; with both arms ASCII, that no
  longer reaches a result. Output that does not go through `Write-LibraryResult` -- the reader adapter's,
  the guards' -- is not covered by this, and no row reaches a non-ASCII character there yet.
- **Four more writers misread a no-overwrite conflict.** `Archive-ProjectHub`, `Archive-SharedBook`,
  `Copy-LocalPagesToProject` and `Publish-SharedBookCandidate` read only `isError`, so a note another
  writer landed first came back as a success and each refused later, under a sentence about a readback,
  a manifest offset or a Catalog line. `Assert-McpWriteNotConflicted` (`CollectionOwnership.ps1`) is the
  one check now, New-ProjectHub's included; `Test-McpHelpers.ps1` races each of the four (4 of 272 red
  before the fix, each refused for the wrong reason).

**As of 2026-09-23 (S35) every `hub` row and every `publication` preflight row is green against the
NAS.** `library hub copy-pages` (`src/hubcopy.ts`) and `library publish`, `publish batch` and `publish
refresh` (`src/publish.ts`) answer their oracles' preflights, each measured by hand first. Three things
changed so the rows measure their subject:

- **The three publication rows that `require` collection ownership are seeded with it.** `requires` is a
  declaration the harness never acts on, so `publication.shelf-book-publishes-to-the-shared-collection`,
  `publication.batch-publishes-every-book-it-was-given` and `publication.refresh-is-a-separately-approved-operation`
  measured an UNOWNED collection, which the fence also passes. Each now takes the writable role with
  `Set-CollectionOwner -Acquire`, as the archive and list rows do, and the refresh row first publishes the
  Book it refreshes, with `Publish-BookCopy -FromShelf`, so the Shelf copy survives to be refreshed from.
- **What the rows cannot see was compared by hand.** The harness normalises every SHA-256 and every
  `plan_id`, which concedes the ORDER pages are hashed in and every generated page a digest covers. Both
  families were run oracle against kernel over one workspace pinned to a disposable project, stdout compared
  raw after parsing: nine copy preflights and the existing-Hub branch, eight publish, batch and refresh
  cases over a Book with non-ordinal names, frontmatter, fences, NFC and format characters -- all identical.
  A planted sort defect was reported by the same comparison.
- **`Sort-Object`'s order was measured, and the kernel had it wrong.** `psSortCompare` broke a hyphen tie
  ordinally, the reverse of the oracle; see `kernel/README.md`. Self-test section 14 holds the measured
  orders and the oracle's own reader-map labels.

**A refresh preflight is a first publication's preflight.** `Publish-SharedBookCandidate.ps1` reads nothing
from the collection before it returns a plan, and `-ReplaceExisting` is in neither the plan nor its
`plan_id`. So the refresh row compares a document that does not say it is a refresh, and a `plan_id` issued
for a publication would also authorise a `-ReplaceExisting` run. The kernel carries this; whether the oracle
should bind it is the reader's ruling, recorded rather than decided in S35.

**As of 2026-09-23 (S36) the kernel answers every hook and the stdio reader**, S20's offline half:
`library hook settings-integrity`, `library hook desk-context` and `library mcp serve`, with the
resolver's anchor and selection-conflict refusals under all of them. Twenty-nine rows came first, and
each family was falsified with planted defects that turned exactly the rows they reach red. Three
things changed in the harness so the rows could reach their subjects:

- **A step's `environment` takes the row's tokens.** No step had ever set `LIBRARY_WORKSPACES`, so every
  guard row read THIS MACHINE's registry; a row about the registry now points it at `{registry}`.
- **`{second_workspace}` exists for any row that names it**, built at `<root>\second` and registered in
  the arm's own registry, so `<fixture-root>` normalises it the same in both arms; and
  `{second_workspace_slash}` is its forward-slash spelling, for a path inside a JSON payload.
- **A Desk context row pins `-AgentProcessId 0`** wherever no binding is its subject, so the "no seat"
  sentence cannot depend on which process tree runs the harness.
- **A step that declares no stdin receives none.** S15 made a declared stdin arrive as its own bytes;
  the empty branch still closed a writer built on the host's input encoding, and under this session's
  host that flushed `ef bb bf` into every such step. `Publish-ShelfBookBatchToShared.ps1` binds pipeline
  input, so its oracle arm wrote a binding error to stderr and
  `publication.batch-publishes-every-book-it-was-given` went red here after passing in S35 -- on a host
  whose input encoding carries a preamble, and only there. The encoding is now set for every step, and
  the harness self-test forces such a host and reads the bytes a child receives (1 of 90 red without it).

**Measuring the settings guard found three holes in the oracle**, each a silent ALLOW of a settings file
that registers no guard a harness will load: `{}` and a `null` hook entry made `tools/HookRegistry.ps1`'s
walk throw -- defect family 4 -- and `Guard-SettingsIntegrity.ps1` fails open by design; and a `Hooks` key
was read case-insensitively as registered. Fixed there first, with a regression each in
`Test-LibraryHooks.ps1` (3 of 3 red without the fix), and a row each -- which the pre-fix oracle turns
red. What the rows concede: a JSON syntax error's sentence is each engine's own, so no row compares one;
the refusal of two keys differing only in case is compared, in .NET's words.

Measured 2026-09-23, offline, 139 rows: from source and against the binary installed through `current`,
**108 green, 0 mismatch, 17 independent, 14 skipped**. With `-IncludeShared`, against the binary: **121 green, 1
mismatch** -- `shelf.duplicate-topics-are-reported-not-resolved`, which needs an embedding endpoint -- and all 26
disposable projects removed cleanly.

**As of 2026-09-23 (S37) the plugin points at the binary, and the three `harness` rows are measured.**
They are `independent`, so no run of this harness judges them; each was judged in a real session against
the release installed through `current`, in a `workspace-open-book` fixture with every registration
`library init` wrote set aside, so that the plugin was the only source of hooks and -- in Claude Code -- of
the reader:

- `harness.claude-code-refuses-a-shell-read-of-a-closed-book`: claude 2.1.280, `--plugin-dir` on the
  release. `cat` of a page of the closed `holding` was denied, the debug log recording the plugin hook's
  `permissionDecision: deny` in the guard's words; `echo control-ok` completed in the same session; the
  reader connected as `plugin:deskpost:validated-book-reader` and answered `read_book_catalog`.
- `harness.codex-refuses-a-shell-read-of-a-closed-book`: codex-cli 0.153.4, the plugin installed from the
  release into a scratch `CODEX_HOME` with the fixture trusted and `--dangerously-bypass-hook-trust`.
  `Get-Content` of the same page was "Command blocked by PreToolUse hook" in the guard's words; `echo
  control-ok` completed. The Desk hook named `mcp__validated_book_reader__read_open_book_page`, and Codex's
  own tool listing offered exactly that name.
- `harness.a-post-compaction-session-still-knows-where-it-is`: the Claude session resumed, compacted by
  `/compact` (29,900 tokens to 2,364, `compact_boundary` in the stream), and resumed again; the plugin's
  Desk hook re-served the seat, the open Book and the exact reader tool on the next prompt. The model's
  one-line summary of that context was loose (haiku called the open Book merely available); what the row
  holds is the surface served, which was correct.

**What those sessions found, and what was done about it.** A Codex plugin's MCP server starts in the plugin
cache with no MCP roots and none of the session's environment, so the Codex plugin carries no reader (the
reader's ruling); with no `mcpServers` in its manifest Codex serves the plugin root's `.mcp.json`, so the
Codex manifest names an explicitly empty one. Codex runs a hook through `powershell.exe -Command` on
Windows, so a Windows release renders the Codex hooks with `& `. And Codex spells a server's hyphens as
underscores, in the names it offers and in a PreToolUse `tool_name` -- which leaves the Codex bindings'
`^mcp__basic-memory__.*$` guard unable to fire and every sentence naming the reader by its project form
naming a tool Codex does not offer. Those two are recorded, not fixed (the reader's ruling), and have no row
yet: a row compares the kernel with the oracle, and both are wrong the same way.

**As of 2026-09-23 (S38) both are fixed, rows first and the oracle before the kernel.** Nine rows:

- **Codex's Basic Memory spelling.** `guards.basic-memory-codex-spelling-lists-an-open-shared-book`,
  `-read-is-suspended` and `-keeps-the-edit-allowlist` hand both guards `mcp__basic_memory__<tool>`. Both
  arms denied all three as a tool the guard was never taught, so the rows read green over the defect; with
  the oracle fixed and the kernel not, all three went red. Only the exact lowercase prefix is rewritten, so
  `guards.basic-memory-a-tool-name-is-matched-exactly` still holds, and the "blocks" sentence still quotes
  the name the harness sent. The Codex template's matcher is `^mcp__basic_memory__.*$`; the plugin's, which
  serves both harnesses, is `^mcp__basic[-_]memory__.*$`.
- **The check that read it green.** `checks.a-codex-basic-memory-guard-that-cannot-fire-is-reported` runs the
  doctor over a Codex hooks file carrying the pre-S38 matcher. `$script:CodexRequiredHooks` had no matcher
  rule for the Basic Memory guard, so any matcher passed; it now carries a `sample`, a tool name the
  registered matcher must MATCH, where the other rows' `matcher` is a pattern the matcher's TEXT must match.
  The row's first run caught a defect in that very change -- an `if` used as a value unrolled an empty
  match, and StrictMode's `Count` sentence became the check's whole detail -- which `checks.reports-every-registered-check`
  reported too. `Test-LibraryHooks.ps1` holds the rule over four matchers (2 of 4 red without the fix).
- **The reader's name.** `guards.desk-context-names-the-reader-codex-offers`,
  `guards.a-closed-book-denial-names-the-reader-codex-offers` and `guards.a-shell-denial-names-the-reader-codex-offers`
  hand each hook `mcp__validated_book_reader__`; `guards.desk-context-a-prefix-naming-no-tool-advertises-none`
  and `guards.a-reader-prefix-naming-no-tool-fails-closed` hand it `read_`. The oracle hooks declared no such
  parameter, so the harness's argument check refused all five before a run -- their red. The Desk row was
  green once the oracle had the parameter, since the kernel had carried `--reader-tool-prefix` since S37.
  The prefix rule and its sentence live in `HookContext.ps1` and `kernel/src/readerprefix.ts`, and the
  kernel's sentence changed to the oracle's, which names no flag. `library init` hands the Codex Desk hook
  and both Shelf guards `-ReaderToolPrefix mcp__validated_book_reader__`, which `workspace.init-creates-marker`
  compares, and the plugin hands both Shelf guards the prefix as it already did the Desk hook.

`reader.shared-selftest`, the gate's one failure through S37, is fixed as well: the adapter's sandbox wrote
the all-zeroes collection id and then read real shared Books through it. The shared half now pins the
sandbox to the collection the adapter is configured for, read from the bound workspace's own
`.library-project` when the adapter loads, because the Shelf half runs first and repoints the state
directory at a sandbox it then deletes. Its reads are reads: `shared_library_write` stays `false`.

What these did not change: every other sentence naming the reader by its project form. The capture and
stub helpers' `next` lines, `library-help`'s references, `Add-SearchHitReminder.ps1`'s matcher and the
program's own `.claude/settings.json` name the project form, which is right for a Claude session a
workspace's `.mcp.json` serves and wrong under either plugin or Codex; none of them is a hook a
registration can hand a prefix to.

**And `suggest_active_projects` has rows and a port** (S38), the last reader tool that refused by name.
`reader.suggests-active-projects-by-the-readers-words` seeds three Hubs through `New-ProjectHub` and asks
for `Godot kernel`: a word in a slug or title scores ten, one in the body at most three, the Hub that matched
nothing is left out, and each match carries its words and its Purpose. `reader.suggestions-say-when-nothing-matched`
is the no-match sentence. Both are green against the NAS in disposable projects, both arms returning the
ranked text itself, and the first went red against a planted ascending sort. What the port concedes -- .NET's
Unicode `\b`, rebuilt from its `\w` class; `ToLowerInvariant` as JavaScript's `toLowerCase`; a tie in score
and title -- no row reaches. A workspace on the local collection is refused by name: the adapter reads Hubs
from Basic Memory only, so there is nothing to compare a local answer with.

Measured 2026-09-23, 150 rows: offline, from source and against an S38 release installed through `current` under
a scratch root, **117 green, 0 mismatch, 17 independent, 16 skipped**. With `-IncludeShared`, against that binary:
**132 green, 1 mismatch** -- `shelf.duplicate-topics-are-reported-not-resolved`, which needs an embedding endpoint --
with no row in error, so every disposable project was removed. The upgrade fixture passes 30 of 30, the harness
self-test 90 of 90, the kernel self-test 317 of 317. The full gate with `-IncludeShared` and the reader's workspace
attached first failed 2 checks -- `codex.project-access-config` and `workspace.codex-guards-registered`, each
correctly reporting a Codex hooks file written before S38 -- which cleared when the program's bindings were
regenerated with `tools/Initialize-CodexLibrary.ps1` and `library init` was re-run over the workspace (the reader's
go-ahead; only `.codex/hooks.json` changed in either). Re-run after: 128 passed, 1 warned (the always-on budget), 0 failed, 0 skipped.

**As of 2026-09-23 (S39) the confirmed shared-writer halves have rows and ports**, eleven rows, each written
first and its oracle run in disposable projects before a line of the kernel was: `hub archive` (two rows: a
fresh archive, and a root with self-links into an archive Catalog that already lists another Hub), `shared
archive` (two: a fresh archive, and one into an archive Catalog carrying the pilot-era emptiness sentence),
`shared list-entry` (two: the heading appended, and an entry inserted under an existing heading), `hub
copy-pages` (three: the Hub created and journalled `complete`, an identical record reused, and a differing
record refused with an `incomplete` journal), and `publish` and `publish refresh` (one each: the composite
publish, verify and local delete; and a refresh that re-files the Book under a collection, reaching the root
overwrite, the heading creation and `catalog_entry_state: moved`). A planted defect per writer turned exactly
the rows it reaches red. `publish batch`'s confirmed half still refuses by name; no row holds it.

What reading the oracles by hand found, each carried into the port rather than corrected:

- **This machine's SMB client decides an archive's husk.** The cleanup lists the directory the move just
  emptied through the share, and a client that listed it within its cache lifetime answers from that
  listing: the oracle reported `not-empty` and left the empty directory (measured by hand, with and without
  a prior listing). The harness's own before-snapshot is such a listing, and the kernel arm takes none, so
  the rows would have measured the cache. A row may now declare `share_settles_before_arm`, which waits out
  the client's cache lifetimes after the before-snapshot; `acceptance.matrix-shape` holds it to a boolean on a
  shared row (2 harness self-test checks). What it concedes: a reader who browsed the Book in Explorer just
  before archiving still gets a husk, from either implementation, and `shared.archive-leaves-no-husk` reports
  it afterwards.
- **A body read without frontmatter keeps a leading newline.** Basic Memory returns `"\n# Title..."` for
  `include_frontmatter: false`; the Book archiver's frontmatter strip does not fire on it, so the relinked
  root is written back with that newline and reads with three. A planted trim turned the fresh-archive row red.
- **Basic Memory writes a new note's frontmatter in the order its metadata arrives, and keeps an existing
  note's order on overwrite.** The publisher's metadata is a PowerShell hashtable, so a published root's
  frontmatter is in .NET Framework's hashtable order -- measured and deterministic, and sent by the port as a
  literal. A planted alphabetical order turned the publish row red and left the refresh row, an overwrite,
  green.
- **The journals are ConvertTo-Json's**, with `'` as `'`, `"error": ""` where the oracle hands `$null` to
  a `[string]` parameter, and `-ReplaceExisting` absent from the copy's plan as from the refresh's. The
  publication and copy journals end without a newline; the workflow journal ends with one.

Measured 2026-09-23, 161 rows: offline, from source and against an S39 release installed through `current` under
a scratch root, **117 green, 0 mismatch, 17 independent, 27 skipped**. With `-IncludeShared`, against that binary:
**143 green, 1 mismatch** -- `shelf.duplicate-topics-are-reported-not-resolved`, which needs an embedding endpoint --
with no row in error, so every disposable project was removed. The upgrade fixture passes 30 of 30, the harness
self-test 92 of 92, the kernel self-test 317 of 317, and the full gate with `-IncludeShared` and the reader's
workspace attached 128 passed, 1 warned (the always-on budget), 0 failed, 0 skipped.

**As of 2026-09-23 (S40) `publish batch`'s confirmed half has rows and a port**, the last confirmed shared-writer
half that refused by name. Two rows, each over a batch of a publish item (the open curated Book) and a delete item
(a second curated Book, `spare`, seeded through `New-ShelfBook`): `publication.batch-confirmed-publishes-and-deletes-every-item`,
and `publication.batch-confirmed-preserves-a-failed-item-and-continues`, whose collection already holds a different
publication of `curated` -- so the first item's child refuses (a batch never passes `-ReplaceExisting`), its Shelf
Book stays, and the delete still runs. Both oracles were run by hand in disposable projects first; both rows were
red against the unported kernel, and two planted defects turned exactly the rows they reach red: stopping at the
first failed item (the failure row only), and naming the journal after another slice of the `plan_id` (both).

What reading the oracle by hand found:

- **A hand run needs the arm's seat claim.** Without `LIBRARY_SEAT_CLAIM`, the publish child's local delete of an
  OPEN Book refused ("has no live session") and rolled back, while the delete of a closed one succeeded -- the
  harness takes `Enter-FixtureSeatClaim` for each arm, so the rows measure the claimed case.
- **The batch journal is rewritten after every state change**, ends with a newline, and writes `"error": null`
  until an item fails -- a property, not a `[string]` parameter, so not the `""` of the two journals S39 ported. An
  item's error is its child's whole refusal sentence, the child's journal paths inside it.
- **`shared_library_write` is true when ANY item completed**, a delete-only item included. Carried, not corrected.
- **The journal is named after the batch `plan_id`'s last sixteen characters**, and that `plan_id` differs between
  the arms for reasons that are not behaviour: it binds the plan file's full path and each arm's own disposable
  project. Content compared equal while the key did not, so the harness now normalises the ARM'S OWN carried
  `plan_id` tail, by value and only where it stands alone (`<plan-tail>`); inside the full `plan_id` it is left to
  the sha256 rule. Three harness self-test checks hold it (1 of 95 red with the rule disabled), and the second
  planted defect shows a name built from any other value stays a difference.

**The first offline run from source this session read 116 green and 1 mismatch**, and only its summary was kept,
so the row is not known; the rerun, and every run after it, read 0 mismatch. Recorded as an intermittent row to
find, not as a result.

Measured 2026-09-23, 163 rows: offline, from source and against an S40 release installed through `current` under
a scratch root, **117 green, 0 mismatch, 17 independent, 29 skipped**. With `-IncludeShared`, against that binary:
**145 green, 1 mismatch** -- `shelf.duplicate-topics-are-reported-not-resolved`, which needs an embedding endpoint --
with no row in error, so every disposable project was removed. The upgrade fixture passes 30 of 30, the harness
self-test 95 of 95, the kernel self-test 317 of 317, and the full gate with `-IncludeShared` and the reader's
workspace attached 128 passed, 1 warned (the always-on budget), 0 failed, 0 skipped.

**What stands between these numbers and `-RequireGreen`** is S21's row in the plan: the gate has no green verdict
for an independent row at all, and the eighteen rows that are not green are sorted there by what each needs.

**As of 2026-09-23 (S41) an independent row can be green**, by the reader's two rulings
([ADR-0039](adr/0039-an-independent-row-is-judged-against-the-kernel-under-test.md)). With `-IncludeIndependent`
an independent row is never compared any more; it is judged:

- **A `judge`** is a command the harness runs with the kernel under test as `{kernel}`, and its exit 0 is the
  row's green. Three rows have one: `seat.tier0-opens-a-seat-with-no-basic-memory` (kernel self-test section 10,
  through `LIBRARY_SELFTEST_KERNEL` and `LIBRARY_SELFTEST_SECTIONS`), and
  `reset.topic-ownership-is-retired-by-adr-0029` and
  `recovery.migration-refuses-activation-until-every-legacy-state-is-accounted-for` (`Test-NotebookMigration.ps1
  -Kernel`). Handed a kernel that fails every call, all three went red.
- **A `recorded_verdict`** is looked up in `tools/acceptance-verdicts.json` by row and by the SHA-256 of the exact
  binary under test. Four rows have one -- the three `harness` rows and `seat.launcher-starts-a-harness-in-the-seat-it-named`
  -- and none has a verdict yet, since S37's were taken against a binary that no longer exists: each is `pending`
  until a real session judges the release and records it. From source they are `pending` by construction.
- A row with neither stays `independent` and says it is not judged yet. Ten rows are still there.

The self-test holds each branch (15 new checks): a judge's exit is its verdict and it is handed the kernel under
test, a verdict recorded for ANOTHER binary is not this one's (red with the hash ignored), and the shape check
refuses a judge that names no `{kernel}`, a judge on a differential row, and both keys on one row.

**The embedding row runs offline, against the harness's own stand-in.** `tools/AcceptanceEmbeddingStandIn.mjs` is
started for the row and shared by both arms; its vectors are integer word counts, which no JSON parser or number
type can bend, so the row compares each implementation's own excerpts, cosine, threshold, rounding and order. The
harness now sets every row's `TEI_EMBEDDING_URL` and `TEI_API_KEY` -- empty unless the stand-in is running -- so no
row can reach a reader's inference server through the shell (red when not cleared). `library shelf duplicates` is
ported (`src/duplicates.ts`) and the row is green; two planted defects each turned it red. What reading the oracle
by hand found:

- **Two oracle defects, both a literal non-ASCII character in a `.ps1` without a BOM**, which Windows PowerShell
  reads as Windows-1252. The detector's `guidance` sentence carried a U+2014 that every caller received as three
  characters. And `Get-ReaderMapLabel`'s optional BOM was a literal U+FEFF, which became U+00EF U+00BB and an
  optional U+00BF: the frontmatter strip never fired, so a page whose frontmatter held a YAML comment (`# ...`)
  was labelled with the comment. Both fixed in the oracle first -- `[char]0x2014` and the regex escape `\uFEFF` --
  with a `books.reader-map-label-matches-manifest-title` case that the old regex fails. A scan of every BOM-less
  `.ps1` found no third.
- **`Get-ChildItem -Recurse` lists a directory's own files before its subdirectories'** (`beta/_index.md` before
  `beta/0sub/_index.md`), which a sorted walk would reverse; the port walks as the oracle does.
- **`[Math]::Round(x, 4)` rounds half to even**, as .NET Framework computes it; and pairs of equal similarity kept
  their generation order over thirteen pairs. Ties past sixteen pairs, where .NET's sort stops being an insertion
  sort, are unmeasured; the port is stable.

Measured 2026-09-23, 163 rows, offline with `-IncludeIndependent`, from source and against an S41 release installed
through `current` under a scratch root: **121 green, 0 mismatch, 4 pending (the recorded-verdict rows), 8
independent (no judge yet), 30 skipped (the shared rows)**. Harness self-test 110 of 110, kernel self-test 317 of
317. **Under the reader's leaner routine (S41) the shared matrix, the full gate and the upgrade fixture were not
run this session**; they are the release candidate's, and S41's harness changes mean the whole shared matrix runs
before it.

**As of 2026-09-23 (S42) the Linux release is judged in a clean distro, and three rows are new.** No PowerShell
oracle runs on macOS or Linux, so the POSIX half of the kernel is judged by kernel self-test sections compiled for
Linux (`bun build --compile --target=bun-linux-x64 kernel/test/selftest.ts`) and run in the clean WSL2 distro
`deskpost-clean` against the release binary installed there, with `LIBRARY_SELFTEST_KERNEL` naming it: sections
19 (POSIX roots and placement; its pure half runs on every host), 20 (a fresh workspace's `doctor` fails nothing),
21 (the POSIX bindings start: the registered shelf guard, run through `sh`, denies a closed Book, and the registered
reader answers `tools/list`), 22 (a workspace guarded by the enabled plugin is guarded), 23 (on POSIX a remedy
names a `library` verb) and 24 (a seat is held for exactly its session's life, and `library seat start` holds it).
Each was red against the binary before its change, and thirteen planted defects each turned red exactly the checks
they reach -- the thirteenth reproducing the defect it guards: **off Windows the seat claim excluded nothing**, a
second claim on a held seat was granted and the probe read it free.

The three new rows, each red against the kernel before its port:

- `workspace.init-leaves-a-workspace-its-checks-pass` -- `library init` then the workspace checks, over a bare
  folder ([ADR-0041](adr/0041-library-init-lays-out-the-holding-shelf-and-report-inbox.md)).
- `shelf.new-capture-book-gets-a-capture-reader-map` -- a defect porting the first found: the kernel's
  `shelf new --capture` wrote a curated Book's reader map, and no row had ever made a capture Book.
- `checks.a-plugin-only-workspace-reads-as-guarded` -- a workspace whose guards and reader come only from the
  enabled, installed Claude Code plugin ([ADR-0042](adr/0042-a-plugin-guarded-workspace-a-posix-remedy-and-a-held-seat.md)).
  Its fixture is a scratch Claude Code configuration the row `prepare`s, laid out as claude 2.1.281 was measured
  to lay out an installed plugin.

Two harness changes, so the whole shared matrix runs before the release candidate: every step's
`CLAUDE_CONFIG_DIR` is pinned to an empty directory of the fixture's, because `doctor` and the launch warnings now
read which plugins Claude has enabled and would otherwise read the harness operator's own `~/.claude`; and a
`prepare` text takes the fixture's tokens, `{workspace_slash}` among them, because an installed plugin's
`installPath` is recorded as absolute. And `workspace-shelf` replaces the empty Holding Shelf every `library init`
now lays out with its own, and carries the Report Inbox.

Measured 2026-09-23, 166 rows, offline with `-IncludeIndependent`, against the S42 release (`rel42e`) installed through `current` under a scratch root: **124 green, 0 mismatch, 4 pending (the recorded-verdict rows), 8 independent (no judge yet), 30 skipped (the shared rows)**. The three areas that carry shared rows, run with `-IncludeShared` against the reader's endpoint in disposable projects: **reader 16 green, hub 11 green, publication 14 green and 2 independent, 0 mismatch**. Harness self-test 110 of 110; kernel self-test 396 of 396 on Windows, and sections 19-24 in the distro 45, 18, 18, 10, 18 and 13. The full gate and the upgrade fixture were not run (the leaner routine).

**As of 2026-09-24 (S43) every row has a comparison, a judge or a recorded verdict**
([ADR-0043](adr/0043-a-judge-drives-the-kernels-real-verbs.md)). The ten independent rows S40 listed in groups
(3)-(5) are judged, each by a kernel self-test section that drives the kernel under test through its real verbs
and imports none of the kernel's own claim, lock or journal code -- a kernel answering `library selftest
concurrency` would have been asked whether it is right by itself, so that verb is not ported for these rows and
their kernel steps now name the verb the judge drives:

| Row | Judge | What it holds |
| --- | --- | --- |
| `seat.refuses-a-seat-claimed-by-a-live-process` | section 25 | a second process refused entry and a Desk write while the first lives; a paused agent keeps its seat with nothing written under it; the seat free once its agent dies |
| `seat.every-mutation-fences-on-the-incarnation` | section 26 | a Desk write and a reset carrying an earlier session's token, a binding whose start time no longer describes the process at that pid, and a retired incarnation's token, each refused beside the current proof |
| `reset.refuses-a-seat-whose-claim-is-held` | section 27 | a reset of every shape aimed at a seat another session holds refused and changing nothing; the holder allowed; still refused from elsewhere once free |
| `publication.collection-ownership-is-acquired-and-released` | section 28 | the ported `library collection owner`: idempotent acquire, refusal and the fence, release only with no Book lock, a forced takeover previewed then recorded, ten workspaces contending three times with one winner each; offline, over a scratch view |
| `concurrency.two-writers-one-book-lock` | section 29 | eight captures started behind a Book lock the judge holds write and journal nothing, then all land, the map lists all eight, and their journals record eight successive map states |
| `concurrency.notebook-mutation-lock-excludes-reset-compile-and-triage` | section 30 | compiles behind the render lock, a compile behind a topic lock and a reset behind a topic lock each change nothing until release and then land |
| `recovery.an-interrupted-write-leaves-no-partial-file` | section 31 | a multi-megabyte page replaced twelve times under another process's probes and reads and beside kernel reads, every read whole and every write landing; killed writers leave one body or the other |
| `recovery.rollback-undoes-one-operation-and-verifies-by-readback` | section 32 | a capture, a page added in a new folder, and a rename, each failing at a read-only file, rolled back byte for byte and saying so |
| `triage.batch-resumes-after-an-interruption` | section 33 | the ported `library triage batch`: a failed action rerun alone, what landed untouched; an action a killed run left `attempting` reported `interrupted`, never rerun |
| `publication.batch-publish-resumes-from-its-progress-journal` | rewritten | now two differential shared rows, below |

**Making a race certain.** A Book lock is a file made by exclusive create, so sections 29 and 30 hold the lock
themselves and start the writers behind it: a writer that takes no lock writes while the gate is shut, and one
that reads its prior state first journals it while the gate is shut. Two of the judge's own defects were found
by planting kernel defects that stayed green: children spawned inside an async callback, which do not start
until the event loop turns, and a synchronous pause, which never turns it -- so every writer "behind the gate"
started after it opened. The ownership create has no gate, so section 28 widens every contender's read and
repeats the round; with six contenders and no widening, an arbitration that REPLACED an existing claim stayed
green, and with it the defect was caught in 6 of 6 runs.

**What the judges found in the kernel and the oracle:**

- **The kernel's atomic write renamed once** where `Write-AtomicBytes` retries eight times: while another process
  read a page, every fourth replacement failed with EPERM. It now retries, and the pause is jittered because a
  periodic reader was measured to stay in phase with a fixed 120 ms retry and refuse all eight attempts of one
  write in ten (`src/fsx.ts`). A truncating in-place write was then red in 3 of 3 runs, caught by a tail probe
  paced by spinning, since a torn write of that page lasts about 3.4 ms, under Windows' timer tick.
- **On Linux a zombie read as a live agent**: sections 25-27, run in the clean distro, found an agent that had
  exited unreaped holding its seat, since its pid, `/proc` entry and start time survive until the reap. A
  `/proc/<pid>/stat` state of `Z` now reads as gone (`src/procstart.ts`); red against `rel43a`, green against
  `rel43b`.
- **Triage to the Notebook refused in every workspace with a master index** -- since ADR-0041, every workspace:
  the oracle's write-set gate refused `notebook/_master-index.md` and an existing topic's `_index.md`, which the
  action never creates. Fixed in `Invoke-LibraryTriage.ps1` first, with two `Test-ShelfNoteBoundary.ps1` cases
  red without it (3 of 61), then ported.
- **Recorded, not fixed:** a Tier 0 workspace has no reader for an open local Project's page --
  `read_open_project_page` asks for Basic Memory with or without a collection pin -- and its Desk writers refuse
  without a pin; a killed capture leaves its note complete and unlisted and its Book lock behind for thirty
  minutes; and a triage `-CaptureDate` other than today makes every holding action refuse in both arms.

**Five new rows.** `triage.batch-preflight-binds-every-action` and
`triage.batch-confirmed-lands-every-action-and-journals-it` hold the batch runner to the oracle over two
Notebook articles, the confirmed one comparing the plan record and the journal byte for byte (122 and 128
fields). `publication.an-interrupted-publication-resumes-where-it-stopped` and
`publication.a-resumed-publication-refuses-a-page-it-did-not-write` replace the batch-resume row, which named
a suite with no publication resume in it and a kernel command neither implementation has: a real publisher is
stopped at a page it did not write, then that page is removed (or left), and each arm's next publish must
resume (or refuse it). For that the harness gained two seed steps, `collection_delete` and `expect_failure`
on a script step, and stderr is now normalised by cutting the error-record decoration, joining PowerShell's
character-wrapped lines with nothing, and only then replacing path tokens -- the first failure row naming a
journal under its fixture differed by nothing but where the host's width broke the path (3 new self-test
checks, and 2 for the unwrap).

**Falsified.** Every judge was red against a kernel that fails every call. Planted defects, each red on exactly
the checks it reaches: the claim's enter rule and probe (25), a token accepted without matching and a start
time ignored (26), the reset's claim assertion removed (27), a replacing arbitration, a release ignoring locks
and an acquire that takes a held role (28), a capture with no lock and one journaling before its lock (29), no
render lock, no compile topic lock and no reset topic locks (30), a truncating write and a single rename (31),
a rollback that leaves a created file, one that restores nothing, one that restores nothing and verifies
nothing, and a folder left behind (32), an interrupted action rerun, the journal ignored, and `attempting`
recorded after the child (33); a journal field reordered and a preflight count changed (the two triage rows);
a divergent page overwritten and a `copying` root refused (the two publication rows, against the NAS).

Measured 2026-09-24, 169 rows, offline with `-IncludeIndependent`, against the S43 release (`rel43b`) installed through `current` under a scratch root: **135 green, 0 mismatch, 4 pending (the recorded-verdict rows), 0 independent, 30 skipped (the shared rows)**, the same as against `rel43a` before the zombie fix. The publication area with `-IncludeShared` against the reader's endpoint in disposable projects: **9 green, 0 mismatch, 8 errors** -- the Basic Memory service stopped answering part way through the run (the host still answers ping; every connection is reset), so the eight rows after it never reached a project and nothing was left behind; both new publication rows were green against the NAS from source before it went down, and the resume row again against `rel43b`. Harness self-test 115 of 115; kernel self-test 615 of 615 on Windows; in the distro against the Linux release, sections 19-24 122 checks, 25 15, 26 24, 27 15, 28 59, 29 9, 30 17 and 31 26 (32 and 33 inject their faults by making a file read-only, which root ignores, so they judge on Windows); `-Fast` 129 checks, 0 failed, 1 warned (the always-on budget). The full gate and the upgrade fixture were not run (the leaner routine).

**As of 2026-09-24 (S44) two of S43's Report Inbox claims are fixed in both implementations, and a success row
can no longer agree its way to green.** Both claims were confirmed against the code before anything changed:

- **A triage batch carried at most one Notebook action.** Every Notebook action names the master index in its
  write set, and the batch refuses two actions naming one path. The index is re-rendered, never created, so the
  two indexes a Notebook action updates are now left out of that comparison (`Test-TriageSharedDerivedPath`,
  `isSharedDerivedPath`) -- the half of the S43 fix that stopped at "must not already exist". New row
  `triage.batch-carries-more-than-one-notebook-action` is **independent**, judged by kernel self-test section 34:
  no fixture is a state both arms accept, since the oracle writes only the shared Notebook ADR-0029 retires and
  the kernel only a seat's own. Section 34 was red against `rel43b` (6 of 17, refused exactly as the claim said);
  the oracle's half is a `Test-ShelfNoteBoundary.ps1` case, red with the fix taken out.
- **A `-CaptureDate` other than today made every holding action refuse.** The plan names the note by the capture
  date and `Add-ShelfNote.ps1` named it by today, so the child's own plan disagreed. The writer now takes the
  date (`-CaptureDate`, `--capture-date` on `library capture`), which names the file and nothing else, and triage
  passes the plan's. New differential row `triage.batch-holding-action-keeps-its-capture-date`, 98 fields,
  mismatch against `rel43b` (58 differences), and a boundary-suite case red without the fix.

**A success row whose oracle fails is an error, not a comparison.** The capture-date row's first run was
**green with both arms refusing** -- the preflight refused, the confirming step then refused for want of a plan,
and two identical refusals agree. The harness never compared a row's class with its oracle's exit. It now does:
a `success` row whose PowerShell arm fails at any step reports `error`, naming the step. No row changed status: no
success row in any saved run -- S43's offline and publication runs, S44's -- has a failing oracle. Harness
self-test case 3b2 declares the refusal row a success row in memory and requires `error`; red with the rule
disabled.

**The full gate hung at a terminal.** Found by S7's fresh clone in Windows Sandbox, following the README: two
`Test-SeatLifecycle.ps1` cases spawn a child that must find its input ENDED -- 19e, the launcher refusing a caller
that cannot be asked, and 19m, the picker refusing ended input -- and spawned it with `&`, so it inherited the
suite's stdin. Every gate until S44 was run from an agent's tool, whose stdin is redirected, so both passed; a
person at a console gave the child a keyboard, and the picker asked `Seat:` for ever. Both now start the child with
its stdin redirected and closed. And the same shape was found a third time, silent -- `BookRootSchema.ps1
-SelfTest` starts the Desk hook with `&`, and a hook with no payload argument reads stdin -- so the cure is in
the gate itself: at a console, `Invoke-LibraryChecks.ps1` runs itself again with stdin redirected and closed
before any check, and every child inherits the ended input. `gate.children-meet-ended-input` holds it, red at a
console with the relaunch disabled. **Measure a console as a console:** a `Start-Process` that redirects the
child's output also hands it the caller's stdin, so a first "console" run of the seat suite was no console at
all; the runs that count were started with no redirection and wrote their own output (seat suite 1006
assertions, no prompt; `-Fast` red then green as above). With its stdin detached, v0.1.0's full gate in the
Sandbox went past the seat suite unaided.

Measured 2026-09-24, 171 rows, offline with `-IncludeIndependent`, against the S44 release (`rel44a`) installed
through `current` under a scratch root: **137 green, 0 mismatch, 4 pending (the recorded-verdict rows), 0
independent, 0 error, 30 skipped (the shared rows)**. The eight publication rows S43's outage stopped, rerun with
`-IncludeShared` against the reader's endpoint in disposable projects against `rel43b`: **8 green**, no project
left behind -- so the publication area is 17 of 17 against that release. Harness self-test 116 of 116; kernel
self-test 632 of 632 from source on Windows, and against `rel44a` 630 of 632 -- the two `--version from source`
checks, which a compiled kernel fails by construction; in the distro against the Linux release, sections 19-24
122 checks, 25 15, 26 24, 27 15, 28 59, 29 9, 30 17, 31 26 and 34 17; `-Fast` 130 checks, 0 failed, 1 warned
(the always-on budget). The full gate and the upgrade fixture were not run here (the leaner routine).

The comparison itself is falsified rather than merely exercised.
`tools/Invoke-AcceptanceMatrix.ps1 -SelfTest` builds every declared fixture, runs one real row end
to end, and then drives four stub kernels: one that agrees over its own fixture (green only if
normalisation really fired), one that differs in substance (must report a difference), one that
differs only where a delta approves it (must stay green *and* report the approved delta), and one
that refuses (must report the differing exit code). A comparator that never reports a difference
agrees with everything.

## Where these live

| Path | What it holds |
|---|---|
| `tools/acceptance-matrix.json` | The rows, the areas, the approved deltas, the excluded helpers. The single source. |
| `tools/AcceptanceFixtures.ps1` | The eight workspace shapes, built through the real writers. |
| `tools/AcceptanceMatrix.ps1` | Shape and coverage rules, normalisation, the comparison, this document's generated region. |
| `tools/Invoke-AcceptanceMatrix.ps1` | The harness, its self-test, and `-RenderDoc`. |
| `tools/AcceptanceKernelStub.ps1` | The test double the self-test compares against. Never a kernel. |
| `tools/AcceptanceSharedCollection.ps1` | The disposable Basic Memory project each arm of a shared row runs in, and its deletion (S32). |
| `kernel/src/cli.ts` | The kernel's front door. `library verbs` prints the table the gate resolves a row's kernel command against. |
| `kernel/src/verbs.ts` | Every verb the matrix names, ported or not, with the ledger row that carries it. |
| `kernel/test/selftest.ts` | The kernel's own suite. It spawns the CLI as a child process rather than importing its verbs. |
| `tools/Build-KernelRelease.ps1` | The release: `bun build --compile` per platform, inside the public program tree, zipped, with SHA256SUMS. |
| `install.ps1`, `install.sh` | Verify a release, place it in a versioned directory, switch the `current` link onto it, then `library doctor`. |
| `tools/Test-KernelUpgrade.ps1` | The upgrade and rollback fixture, run over a built release under a scratch install root. |

## The matrix

Everything below this line is generated from `tools/acceptance-matrix.json` by
`tools/Invoke-AcceptanceMatrix.ps1 -RenderDoc`, and `acceptance.matrix-doc-matches-rows` fails when
the two disagree. Edit the rows, not the table.

<!-- BEGIN GENERATED MATRIX -- rendered by tools/Invoke-AcceptanceMatrix.ps1 -RenderDoc; do not edit by hand -->

**171 rows** across 18 areas: 154 compared against PowerShell, 17 judged independently. 30 need a reachable shared collection and are skipped offline. 23 public helpers are excluded with a reason rather than given a row.

Approved for **every** row, so not repeated on each one: `kernel-reports-its-own-version`.

### workspace

Workspace resolver, marker and machine registry.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `workspace.init-creates-marker` | success | differential | `bare-folder` | `library init` on an empty folder writes the marker, registers the workspace, and installs the managed instruction and harness files. |
| `workspace.init-is-idempotent` | success | differential | `workspace-fresh` | A second `library init` over the same folder keeps the workspace id and its created stamp, and reports that rather than reissuing them. |
| `workspace.init-refuses-a-non-drive-rooted-path` | failure | differential | `bare-folder` | `library init` against a UNC path refuses, naming the rule, and writes nothing. |
| `workspace.init-force-refreshes-managed-sections` | success | differential | `workspace-fresh` | `library init -Force` refreshes the managed instruction sections and the marker's program version against an existing workspace, leaving the reader's own prose alone. |
| `workspace.init-leaves-a-workspace-its-checks-pass` | success | differential | `bare-folder` | `library init` on an empty folder lays out the Holding Shelf and the Report Inbox as capture Books, renders the Shelf catalog from them and an empty Notebook master index, and the workspace checks that follow fail nothing (S42, the reader's ruling). |
| `workspace.resolves-by-walking-up-from-a-subdirectory` | success | differential | `workspace-seated` | A command run from a directory inside a workspace resolves that workspace by its marker, with no explicit path and no environment variable. |
| `workspace.refuses-when-no-workspace-is-attached` | failure | differential | `bare-folder` | A command that needs a workspace, run where there is none, refuses in the resolver's words and names the three ways to attach one. |

### shelf

The Shelf catalog and the local Books it indexes.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `shelf.catalog-renders-from-entry-files` | success | differential | `workspace-shelf` | The Shelf catalog is re-derived from each Book's entry file, byte for byte. |
| `shelf.new-book-creates-a-book-root` | success | differential | `workspace-shelf` | A new local Shelf Book gets its Book root, its `_book.md`, its reader map and its catalog entry, and appears in the rendered catalog. |
| `shelf.new-capture-book-gets-a-capture-reader-map` | success | differential | `workspace-shelf` | A new capture Book gets its notes/ directory and the reader map every capture regenerates, with its pending and reviewed sections empty, rather than a curated Book's map (S42). |
| `shelf.new-book-refuses-a-duplicate-slug` | failure | differential | `workspace-shelf` | Creating a Shelf Book whose slug is already on the Shelf refuses and changes nothing. |
| `shelf.rename-book-keeps-every-page` | success | differential | `workspace-shelf` | Renaming a Shelf Book moves its root, rewrites its catalog entry, and keeps every page byte-identical. |
| `shelf.remove-book-refuses-without-a-plan-id` | failure | differential | `workspace-shelf` | A destructive Shelf operation invoked without the exact plan id its preflight issued refuses, and the Book is still there. |
| `shelf.archive-retires-a-book-without-destroying-it` | archive | differential | `workspace-shelf` | Archiving a Shelf Book moves it under `shelf/_archive/`, stores its catalog entry verbatim, and leaves it un-openable but restorable. |
| `shelf.archived-book-restores-to-the-active-shelf` | recovery | differential | `workspace-shelf` | Restoring an archived Shelf Book puts back the entry the reader wrote, not a regenerated one. |
| `shelf.duplicate-topics-are-reported-not-resolved` | success | differential | `workspace-shelf` | The duplicate-topic detector names every Book claiming a topic and resolves nothing by itself. _(needs embedding-service)_ |
| `shelf.page-stub-marks-a-page-as-pending` | success | differential | `workspace-open-book` | A page of an open Shelf Book is replaced by a stub that points at the canonical Book and page that superseded it. |

### reader

The validated reader: the only route to Book and Project content.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `reader.reads-a-page-of-an-open-book` | success | differential | `workspace-open-book` | `read_open_book_page` returns the page of a Book that is open on this seat's Desk. |
| `reader.refuses-a-page-of-a-closed-book` | failure | differential | `workspace-open-book` | The same call against a Book that is not open is refused, and the refusal names the Book and says it is closed. |
| `reader.refuses-a-seatless-session` | failure | differential | `workspace-shelf` | A session with no seat reads the Library's own files and nothing else: every Book and Project call is refused, naming the missing seat. |
| `reader.lists-the-book-catalog` | success | differential | `workspace-open-book` | `read_book_catalog` scoped to `shelf` returns the local Shelf catalog, with no backend read: the listing a workspace can answer from its own files. |
| `reader.rejects-a-malformed-argument-before-any-read` | failure | differential | `workspace-open-book` | An argument that fails validation is refused at the guard, before any Desk or backend read happens. |
| `reader.lists-the-project-catalog` | success | differential | `workspace-open-book` | `read_project_catalog` lists the active Project Hubs from the collection the workspace is pinned to. _(needs shared-collection)_ |
| `reader.suggests-active-projects-by-the-readers-words` | success | differential | `workspace-open-book` | `suggest_active_projects` ranks the active Project Hubs against the reader's words -- a word in a Hub's slug or title outweighs one in its body -- names each match with the words it matched and its Purpose, leaves out a Hub that matched nothing, and opens no Project. _(needs shared-collection)_ |
| `reader.suggestions-say-when-nothing-matched` | success | differential | `workspace-open-book` | A query that matches no active Project Hub is answered in one sentence quoting the words and saying no Project was opened -- an answer, not an empty list a session could read as a failed call. _(needs shared-collection)_ |
| `reader.serve-answers-initialize` | success | differential | `workspace-open-book` | The stdio reader answers `initialize` with the protocol version it speaks, its tool capability and its name: the handshake every harness makes before it lists a tool. |
| `reader.serve-lists-its-tools` | success | differential | `workspace-open-book` | The stdio reader lists exactly its eight tools, each with the description and input schema a harness shows the session -- the surface through which every Book and Project read happens. |
| `reader.serve-reads-a-page-of-an-open-book` | success | differential | `workspace-open-book` | A `tools/call` of `read_open_book_page` through the stdio reader returns the page of a Book open at this seat, in the envelope the harness reads. |
| `reader.serve-refuses-a-call-naming-another-workspace` | failure | differential | `workspace-open-book` | The stdio reader is bound to one workspace for the whole session, and a call naming another is refused as a tool error naming the bound one. |
| `reader.serve-serves-the-shelf-catalog-to-a-seatless-session` | success | differential | `workspace-shelf` | The Shelf catalog needs no Desk, so a session with no seat is served it through the stdio reader: the browse surface stays readable while every Book stays closed. |
| `reader.serve-answers-an-unknown-method-by-id` | failure | differential | `workspace-open-book` | A request for a method the reader does not serve is answered by its id with JSON-RPC's method-not-found, rather than silence a client would wait on. |
| `reader.serve-says-nothing-to-a-notification` | success | differential | `workspace-open-book` | A notification carries no id and wants no response, so the reader writes nothing to stdout -- where any stray byte would break the protocol. |
| `reader.serve-with-no-workspace-refuses-each-call` | failure | differential | `bare-folder` | A reader launched in no Library workspace starts rather than dying, and refuses each call in one sentence naming how to attach one -- a broken server is what the client would otherwise report. |

### desk

The Desk: what is open, at this seat.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `desk.overview-names-what-is-open-at-this-seat` | success | differential | `workspace-open-book` | The Desk overview reports this seat's open Books and Projects, and one line per other seat. |
| `desk.open-a-book` | success | differential | `workspace-shelf` | Opening a Book adds it to this seat's Desk and to no other seat's. |
| `desk.close-a-book` | success | differential | `workspace-open-book` | Closing a Book removes it from the Desk and makes its content unavailable again. |
| `desk.clear-closes-everything-at-one-seat` | success | differential | `workspace-open-book` | Clearing the Desk closes every Book and Project at this seat and leaves other seats untouched. |
| `desk.refuses-to-open-a-book-that-is-not-on-the-shelf` | failure | differential | `workspace-shelf` | Opening a Book that no catalog entry names refuses, naming what is on the Shelf rather than leaving the reader guessing. |
| `desk.a-bare-slug-on-the-desk-is-a-shared-book` | success | differential | `workspace-open-book` | A pre-symmetry bare slug in a Desk file names a SHARED Book (`books/<slug>`), never a Shelf one, so the overview reports it where the reader serves it from. |

### seat

Seat creation, the claim by verified process identity, and binding.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `seat.enter-an-existing-free-seat` | success | differential | `workspace-two-seat` | Entering an existing unclaimed seat binds this process to it and reports the Desk it inherited. _(delta: kernel-claim-lock)_ |
| `seat.desk-context-records-the-conversation-at-a-bound-seat` | success | differential | `workspace-two-seat` | At a seat bound to this conversation's agent by verified identity, the Desk context hook says so and records the conversation on the binding and in the seat's history, once per session under the serve ledger -- the backstop for every route into a seat that did not record it. _(delta: kernel-claim-lock)_ |
| `seat.refuses-a-seat-claimed-by-a-live-process` | concurrency | independent | `workspace-two-seat` | A seat whose claim is held by a living process is refused to a second process; a paused agent keeps its seat, and there is no lease expiry. _(delta: kernel-claim-lock)_ |
| `seat.every-mutation-fences-on-the-incarnation` | concurrency | independent | `workspace-two-seat` | A mutation carrying a stale incarnation is refused even though the seat name still matches. _(delta: kernel-claim-lock)_ |
| `seat.retirement-is-gated-and-names-what-it-removes` | archive | differential | `workspace-two-seat` | Retiring a seat takes a preflight, an exact plan id and one approval, and archives the seat's material rather than deleting it. _(delta: kernel-claim-lock)_ |
| `seat.launcher-starts-a-harness-in-the-seat-it-named` | success | independent | `workspace-seated` | The launcher opens a real Claude Code or Codex session in the named seat, in the workspace that seat belongs to. _(delta: kernel-claim-lock)_ |
| `seat.tier0-opens-a-seat-with-no-basic-memory` | success | independent | `workspace-fresh` | In a workspace with no Basic Memory endpoint, `library init` lays out the local collection, `library hub new` writes a Hub into it, and `library seat enter --create` binds a new seat to that Hub, validated against the local Active Project Catalog; the seat's Desk then answers with its own Project open. _(delta: kernel-claim-lock)_ |

### discovery

Discovery over closed-Book metadata.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `discovery.finds-pages-in-closed-books` | success | differential | `workspace-shelf` | Discovery reports where a term occurs across closed-Book metadata, and returns locations rather than content. Run over the shape in which BOTH Books are closed, so every hit is one the Desk had no part in. |
| `discovery.never-returns-closed-book-content` | failure | differential | `workspace-open-book` | A discovery hit carries the Book, the page and nothing of the body: a hit is a location, not a reading. The term is the TITLE of a note inside a CLOSED capture Book, so the answer reports both Books searched and returns no hit -- absence with its coverage stated, never absence because nothing was read. |

### search

Full text over open Books, and scoped search over raw/.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `search.full-text-over-open-books-only` | success | differential | `workspace-open-book` | Full-text search returns matches from open Books and is silent about closed ones. |
| `search.raw-search-is-scoped-to-one-batch` | success | differential | `workspace-raw` | Raw search runs against the named source batch and reports where a term occurs in it. |
| `search.raw-search-refuses-an-unrecognised-batch` | failure | differential | `workspace-raw` | Raw search against a path that is not a source batch refuses and names what the batches are. |
| `search.raw-batch-ownership-is-reported-per-batch` | success | differential | `workspace-raw` | Each source batch reports which Project owns it, and liveness is derived at read time rather than stored. |

### capture

Capture into a capture-enabled Book and the Report Inbox.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `capture.note-lands-in-a-capture-enabled-book` | success | differential | `workspace-shelf` | A captured note is written into the Holding Shelf with its capture date and review state, with no Book open. |
| `capture.refuses-a-book-that-is-not-capture-enabled` | failure | differential | `workspace-shelf` | Capturing into a curated Book refuses and names the capture Books that would accept it. |
| `capture.page-added-to-an-open-curated-book` | success | differential | `workspace-open-book` | A page added to an OPEN curated Book is additive, taken under the Book's lock, and appears in the reader map. |
| `capture.page-refused-when-the-book-is-closed` | failure | differential | `workspace-shelf` | The same page write against a closed Book refuses: a closed Book is unavailable for writing as well as reading. |
| `capture.topic-graduates-into-an-open-book` | success | differential | `workspace-two-seat` | A whole Notebook topic graduates into an open curated Book: bound manifest, per-page progress journal, identical pages idempotent, divergent collisions refused. |

### triage

Triage inventory, plan validation and batch execution.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `triage.inventory-lists-what-is-waiting` | success | differential | `workspace-shelf` | The triage inventory reports every untriaged capture with its Book, page and capture date. |
| `triage.plan-refuses-overlapping-write-sets` | failure | differential | `workspace-notebook` | A triage plan whose actions would write the same page twice is refused at validation, before anything is written. Two actions, two different Notebook articles, ONE destination page: the refusal names the path and both action ids, so the approval digest is compared as well as the write set. |
| `triage.plan-refuses-replace-existing` | failure | differential | `workspace-shelf` | `replace_existing` is rejected at plan validation, because a shared refresh has no rollback and an approval must not imply one. |
| `triage.batch-preflight-binds-every-action` | success | differential | `workspace-notebook` | A triage batch preflight over two Notebook articles -- one captured to the Holding Shelf, one graduated into the open curated Book -- orders the actions, binds each one's source, write set and digest into one batch plan_id, carries each child writer's own preflight, and writes nothing (S43). |
| `triage.batch-confirmed-lands-every-action-and-journals-it` | success | differential | `workspace-notebook` | The same batch confirmed under its exact plan_id lands the note and the page through the child writers, writes the plan record and a journal recording every action succeeded, and reports the Shelf write and no other (S43). |
| `triage.batch-carries-more-than-one-notebook-action` | success | independent | `workspace-notebook` | A triage batch of two Notebook actions -- one Holding Shelf note into an existing topic, one into a new topic -- is planned and confirmed as one batch: both notes land, the new topic gets its index, and the seat's master index lists both topics. Every Notebook action re-renders the master index, which it updates and never creates, so two of them do not contend for it (S44, from a Report Inbox claim of S43's: such a batch was refused as two actions both creating the master index). |
| `triage.batch-holding-action-keeps-its-capture-date` | success | differential | `workspace-notebook` | A triage batch planned for a capture date other than today -- one previewed before midnight UTC and confirmed after it -- names the Holding Shelf note by that date, and the child writer's own plan agrees, so the note lands as 2026-01-01-oracle-notes.md (S44, from a Report Inbox claim of S43's: every holding action refused, because the child named the note by today's date). |
| `triage.batch-resumes-after-an-interruption` | recovery | independent | `workspace-shelf` | A triage batch killed between actions resumes from its journal rather than restarting, and no action runs twice. |

### hub

Project Hubs, local and shared, and the bounded Hub edit.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `hub.new-project-hub-is-orientation-not-a-log` | success | differential | `workspace-seated` | A new Project Hub gets `_project.md` holding orientation and open items, and a `notes/` page for anything dated. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.edit-preflight-returns-the-section-before-it-writes` | success | differential | `workspace-seated` | A Hub section edit run as a preflight writes nothing and returns `section_before`, so the caller edits what is there rather than what it remembers. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.add-section-appends-one-dated-entry` | success | differential | `workspace-seated` | Adding a section writes the heading itself, so a body carrying its own heading is a defect the caller must not commit. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.local-pages-copy-into-a-project` | success | differential | `workspace-notebook` | Local Notebook pages copy into an open Project Hub with their source attribution intact. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.local-pages-copy-confirmed-creates-the-hub-and-journals` | success | differential | `workspace-notebook` | A confirmed copy under its exact plan_id creates the Hub its plan said it would, writes and reads back every record, and keeps a `complete` journal under `internal/publication-journals/`. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.local-pages-copy-confirmed-reuses-an-identical-record` | success | differential | `workspace-notebook` | A confirmed copy into an existing Hub leaves a record that already holds the approved text alone and reports it reused, and writes only the other. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.local-pages-copy-confirmed-refuses-a-differing-record` | failure | differential | `workspace-notebook` | A confirmed copy without -ReplaceExisting over a record holding other text refuses, overwrites nothing, and keeps an `incomplete` journal naming the error. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.archive-retires-a-project-hub` | archive | differential | `workspace-seated` | An archived Project Hub moves to the archive shelf, stays searchable, and says that it is archived. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.archive-confirmed-moves-the-hub-and-both-catalogs` | archive | differential | `workspace-seated` | A confirmed Hub archive moves every page to `archive/projects/<slug>`, rewrites the root's own links, lists it in the archive Catalog, removes its active Catalog line, and removes the emptied directory. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.archive-confirmed-rewrites-root-links-into-an-existing-catalog` | archive | differential | `workspace-seated` | A confirmed Hub archive rewrites every link the root makes into its own directory, and adds one line to an archive Catalog that already lists another Hub, keeping that one. _(delta: hubs-can-be-local; needs shared-collection)_ |
| `hub.briefing-orients-without-opening-dependencies` | success | differential | `workspace-open-book` | `read_open_project_briefing` returns a Project's orientation without opening the Books it depends on. _(delta: hubs-can-be-local; needs shared-collection)_ |

### compile

Compiling a source batch into Notebook articles.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `compile.source-batch-becomes-notebook-articles` | success | differential | `workspace-raw` | Compiling one source batch writes Notebook articles with source attribution, updates the topic index and re-renders the master index. _(delta: notebook-is-seat-owned)_ |
| `compile.refuses-the-whole-raw-tree` | failure | differential | `workspace-raw` | Compiling without naming a project or a source batch refuses: only the requested batch is ever compiled. _(delta: notebook-is-seat-owned)_ |
| `compile.master-index-is-derived-not-written` | success | differential | `workspace-notebook` | The Notebook master index is re-derived from the topics on disk, and a hand edit to it is drift rather than content. _(delta: notebook-is-seat-owned)_ |

### reset

The Library Reset: seat-scoped, quarantining, recoverable.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `reset.preflight-states-what-would-be-quarantined` | success | differential | `workspace-notebook` | The reset preflight names every topic and loose file it would set aside, per topic rather than only in total, and writes nothing. _(delta: notebook-is-seat-owned)_ |
| `reset.refuses-without-the-plan-id-it-issued` | failure | differential | `workspace-notebook` | A reset invoked with no plan id, or with one that does not match the preflight, refuses and moves nothing. _(delta: notebook-is-seat-owned)_ |
| `reset.quarantines-rather-than-deletes` | success | differential | `workspace-notebook` | A confirmed reset MOVES each target into a stamped quarantine directory and journals whose it was; nothing is deleted. _(delta: notebook-is-seat-owned)_ |
| `reset.quarantined-material-restores` | recovery | differential | `workspace-notebook` | Quarantined topics come back to the Notebook as whose they were -- an ownership row in the shared layout, the seat's own root under ADR-0029 -- which is what makes the reset recoverable rather than merely undestructive. _(delta: notebook-is-seat-owned)_ |
| `reset.topic-ownership-is-retired-by-adr-0029` | success | independent | `workspace-two-seat` | A topic belongs to the seat whose Notebook holds it: `library notebook own` refuses by name, and no kernel writer -- compile, reset, restore, migrate -- records an owner. _(delta: notebook-is-seat-owned)_ |
| `reset.refuses-a-seat-whose-claim-is-held` | concurrency | independent | `workspace-two-seat` | A reset targeting a seat with a live claim is refused, so one seat's habitual command cannot destroy another seat's hour-long compile. _(delta: notebook-is-seat-owned)_ |

### checks

The checks runner itself.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `checks.reports-every-registered-check` | success | differential | `workspace-two-seat` | The doctor reports one result per registered WORKSPACE check -- every check that reads the reader's material rather than this program's source -- and a check that did not run is reported skipped rather than omitted. What is compared is the REPORT: over a fixture workspace the run legitimately fails the checks that read material the fixture does not have, and a non-zero exit is part of that outcome rather than a defect. |
| `checks.a-codex-basic-memory-guard-that-cannot-fire-is-reported` | failure | differential | `workspace-two-seat` | Codex offers Basic Memory's tools as `mcp__basic_memory__<tool>`, so a Codex hooks file whose Basic Memory guard matches `^mcp__basic-memory__.*$` -- every Codex binding `library init` wrote until S38 -- registers a guard that can never fire, and `workspace.codex-guards-registered` reports it failed, naming the matcher, rather than green. |
| `checks.a-plugin-only-workspace-reads-as-guarded` | success | differential | `workspace-seated` | A workspace whose guards and reader come only from the enabled, installed Deskpost Claude Code plugin -- its own settings register no hook -- reads as guarded, through the plugin's registrations (S42). |
| `checks.skips-workspace-checks-when-none-is-attached` | failure | differential | `bare-folder` | With no workspace attached, the workspace-reading checks report skipped with the reason, never failed: skip and fail are different answers. |

### publication

Publication, refresh and archive against the shared collection.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `publication.shelf-book-publishes-to-the-shared-collection` | publication | differential | `workspace-open-book` | An open Shelf Book publishes to the shared collection under its bounded helper, with a publication journal recording what it produced. _(needs collection-ownership; needs shared-collection)_ |
| `publication.shelf-book-publish-confirmed-publishes-verifies-and-deletes` | publication | differential | `workspace-open-book` | A confirmed publish under its exact composite plan_id writes and reads back every shared page, marks the root complete, inserts and verifies its one Catalog line, journals both the publication and the workflow, and only then deletes the local Shelf Book. _(needs collection-ownership; needs shared-collection)_ |
| `publication.refresh-confirmed-refiles-the-book-under-its-collection` | refresh | differential | `workspace-open-book` | A confirmed refresh naming a collection the published root does not carry overwrites the root with that collection, reuses every unchanged page, creates the three collection headings, and moves the Catalog line from `## Open a Book` to the collection's heading, reporting `catalog_entry_state: moved`. _(needs collection-ownership; needs shared-collection)_ |
| `publication.refuses-without-collection-ownership` | failure | differential | `workspace-open-book` | A shared write from a workspace that does not hold the collection's ownership claim is refused by the fence, not by convention. _(needs shared-collection)_ |
| `publication.batch-publishes-every-book-it-was-given` | publication | differential | `workspace-open-book` | A batch publication carries several Shelf Books in one approved operation, and reports per Book what landed. _(needs collection-ownership; needs shared-collection)_ |
| `publication.batch-confirmed-publishes-and-deletes-every-item` | publication | differential | `workspace-open-book` | A confirmed batch under its exact plan_id runs each bound child plan in order -- the open curated Book published, verified and deleted locally, then a second Shelf Book deleted without publication -- journalling every item's state, and reports the batch `complete`. _(needs collection-ownership; needs shared-collection)_ |
| `publication.batch-confirmed-preserves-a-failed-item-and-continues` | failure | differential | `workspace-open-book` | A confirmed batch whose first item cannot publish -- the collection already holds a different Book at its slug, and a batch never replaces one -- journals that item `incomplete` with its child's refusal, leaves its Shelf Book in place, still runs the later delete, and reports the batch `incomplete`. _(needs collection-ownership; needs shared-collection)_ |
| `publication.an-interrupted-publication-resumes-where-it-stopped` | recovery | differential | `workspace-open-book` | A shared publication interrupted part way -- the real publisher stopped at a page it had not written, after writing the Book's root as `copying` and its reader map, and that page then removed -- is resumed by the next confirmed publish of the same Book: the root and the reader map are reused, the missing pages are created, the root is marked complete and the Catalog line inserted (S43, rewriting publication.batch-publish-resumes-from-its-progress-journal). _(needs collection-ownership; needs shared-collection)_ |
| `publication.a-resumed-publication-refuses-a-page-it-did-not-write` | failure | differential | `workspace-open-book` | The same interrupted publication with the page it stopped at still in place: the next confirmed publish reuses the root and the reader map and then refuses that divergent page by name, writes nothing over it, leaves the root `copying`, and deletes no local Book (S43). _(needs collection-ownership; needs shared-collection)_ |
| `publication.refresh-is-a-separately-approved-operation` | refresh | differential | `workspace-open-book` | Refreshing an existing shared Book is its own gated operation, never an action inside a batch, because it cannot be rolled back. _(needs collection-ownership; needs shared-collection)_ |
| `publication.shared-book-archives-and-stays-searchable` | archive | differential | `workspace-open-book` | An archived shared Book moves to the archive shelf, keeps its Catalog entry labelled rather than removed, and stays covered by search. _(needs collection-ownership; needs shared-collection)_ |
| `publication.shared-book-archive-confirmed-moves-relinks-and-delists` | archive | differential | `workspace-open-book` | A confirmed Book archive moves the Book to `archive/<slug>`, rewrites the publisher-owned root and reader map (body and metadata) onto the archive path, verifies every page the reader map links, creates the archive Catalog with one dated entry, removes the active Catalog line, and removes the emptied directory. _(needs collection-ownership; needs shared-collection)_ |
| `publication.shared-book-archive-confirmed-repairs-the-emptiness-sentence` | archive | differential | `workspace-open-book` | A confirmed Book archive into an archive Catalog that already lists another Book inserts its entry under `## Archived Books`, keeps the other, and removes the pilot-era emptiness sentence, reporting `emptiness_claim: repaired`. _(needs collection-ownership; needs shared-collection)_ |
| `publication.catalog-entry-is-added-without-removing-one` | publication | differential | `workspace-open-book` | Listing an unlisted shared Book adds exactly one line and reports `already_listed` without writing when the slug is present. _(needs collection-ownership; needs shared-collection)_ |
| `publication.catalog-entry-confirmed-creates-its-heading` | publication | differential | `workspace-open-book` | A confirmed listing into a Book Catalog without the collection's heading appends the heading and the one entry, and reads the entry back. _(needs collection-ownership; needs shared-collection)_ |
| `publication.catalog-entry-confirmed-inserts-under-its-heading` | publication | differential | `workspace-open-book` | A confirmed listing into a Book Catalog that has the collection's heading inserts the one entry directly under it and keeps the entry already there. _(needs collection-ownership; needs shared-collection)_ |
| `publication.collection-ownership-is-acquired-and-released` | concurrency | independent | `workspace-two-seat` | One writable workspace per collection: ownership is an exclusive per-incarnation claim record, and a second workspace is refused while it stands. |

### concurrency

Two writers, one resource. Judged on its own, never against PowerShell.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `concurrency.two-writers-one-book-lock` | concurrency | independent | `workspace-shelf` | Two writers against one Book serialise on the Book's lock, which is taken before prior state is read so no journal describes a torn capture. |
| `concurrency.notebook-mutation-lock-excludes-reset-compile-and-triage` | concurrency | independent | `workspace-notebook` | A per-Seat Notebook mutation lock survives ADR-0029: one agent can issue concurrent operations, and reset, compile and triage still exclude each other. |

### recovery

Interrupted runs, rollback and quarantine restore. Judged on its own.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `recovery.an-interrupted-write-leaves-no-partial-file` | recovery | independent | `workspace-shelf` | A write killed mid-flight leaves either the old file or the new one, never half of either: every whole-file replacement is atomic and every reader retries the instant of the rename. |
| `recovery.rollback-undoes-one-operation-and-verifies-by-readback` | recovery | independent | `workspace-shelf` | A rollback restores prior bodies AND deletes pages the operation created, then verifies by reading back rather than assuming the undo worked. |
| `recovery.migration-refuses-activation-until-every-legacy-state-is-accounted-for` | recovery | independent | `workspace-legacy-notebook` | The data-model migration enumerates every legacy state -- owned, shared, excluded, unmapped, loose files, retired incarnations, quarantine -- records a disposition for each, and refuses activation until none is unaccounted. |

### harness

Behaviour only a real Claude Code or Codex session can show.

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `harness.claude-code-refuses-a-shell-read-of-a-closed-book` | failure | independent | `workspace-open-book` | In a real Claude Code session in the workspace, a shell read of a closed Book's page is denied by the hook, quoting the guard, while a control command naming no closed Book completes in the same session. |
| `harness.codex-refuses-a-shell-read-of-a-closed-book` | failure | independent | `workspace-open-book` | The same denial in a real Codex session, whose hooks and config are project-level and gated on project trust -- and which ignores an untrusted project in silence. |
| `harness.a-post-compaction-session-still-knows-where-it-is` | success | independent | `workspace-open-book` | After compaction, a session in a workspace still resolves its workspace, its seat and its Desk, and the instruction surface it is re-served says so. |

### guards

The Library's hooks: the Desk boundary's PreToolUse guards, the ConfigChange settings guard and the UserPromptSubmit Desk context hook -- a payload in, a decision or context out (S20).

| Row | Class | Oracle | Fixture | Operation |
| --- | --- | --- | --- | --- |
| `guards.read-of-a-closed-shelf-book-is-denied` | failure | differential | `workspace-open-book` | A Read of a page in a closed Shelf Book is denied, naming the Book and the command that opens it. |
| `guards.read-of-an-open-shelf-book-is-allowed` | success | differential | `workspace-open-book` | A Read of a page in a Shelf Book open at this seat is allowed: the guard exits 0 and says nothing. |
| `guards.the-shelf-catalog-stays-readable` | success | differential | `workspace-open-book` | The Shelf catalog is the browse surface and stays readable with every Book closed: naming what could be opened is not reading it. |
| `guards.a-glob-spanning-the-shelf-is-denied` | failure | differential | `workspace-open-book` | A Glob pattern that spans the Shelf reaches Books that are closed, so it is denied on its literal text. |
| `guards.an-aliased-path-form-is-refused` | failure | differential | `workspace-open-book` | A path form that is neither relative nor drive-rooted -- `//?/`, UNC, device paths -- is refused, because where it points cannot be established; only `outside` is allowed. |
| `guards.a-trailing-dot-does-not-hide-a-closed-book` | failure | differential | `workspace-open-book` | Windows opens a segment with a trailing dot as the segment without it, and so does the path normaliser, so `holding.` does not walk a Read past the closed Book `holding`. |
| `guards.a-patch-into-a-closed-book-is-denied` | failure | differential | `workspace-open-book` | Codex's apply_patch carries its paths inside the patch document; a patch that updates a closed Book's page is denied, naming the path. |
| `guards.a-patch-the-guard-cannot-read-fails-closed` | failure | differential | `workspace-open-book` | An apply_patch directive the guard was not taught is refused rather than skipped: a parser that skips what it does not recognise fails open. |
| `guards.a-seatless-notebook-write-is-refused` | failure | differential | `workspace-fresh` | A Write into notebook/ from a session that resolves no seat is refused, in the seat resolver's own words: there is no default seat. |
| `guards.shell-read-of-a-closed-book-is-denied` | failure | differential | `workspace-open-book` | A shell command naming a page of a closed Shelf Book is denied on its text, quoting what the command typed. |
| `guards.shell-read-of-an-open-book-is-allowed` | success | differential | `workspace-open-book` | A shell command naming only a Book open at this seat is allowed. |
| `guards.a-shell-glob-cannot-read-around-the-guard` | failure | differential | `workspace-open-book` | `shelf*/` is `shelf/` once the shell expands it, so a glob character does not walk a read past a closed Book. |
| `guards.a-quoted-heredoc-body-is-data` | success | differential | `workspace-open-book` | The body of a quoted-delimiter heredoc is data the shell never parses, so a closed Book named only inside it is not a read. |
| `guards.an-escape-is-not-a-path-separator` | success | differential | `workspace-open-book` | A backslash before anything but a path character is an escape, so an escaped search pattern that spells Shelf names no Book. |
| `guards.a-seatless-shell-read-of-the-shelf-fails-closed` | failure | differential | `workspace-fresh` | A shell command naming a Shelf path from a session with no seat fails closed: with no Desk, nothing can vouch for a Book being open. |
| `guards.basic-memory-direct-read-is-suspended` | failure | differential | `workspace-open-book` | A direct Basic Memory read of an OPEN shared Book is still denied: shared content is read only through the validated reader, whatever the Desk holds. |
| `guards.basic-memory-requires-the-pinned-collection` | failure | differential | `workspace-open-book` | A Basic Memory call addressed to any collection but the workspace's pinned one is denied before its tool is considered. |
| `guards.basic-memory-refuses-project-name-routing` | failure | differential | `workspace-open-book` | A call that routes by project NAME as well as the pinned id is denied: a name can resolve to another collection. |
| `guards.basic-memory-lists-an-open-shared-book` | success | differential | `workspace-open-book` | Listing a directory inside a shared Book open at this seat is allowed: the guard exits 0 and says nothing. |
| `guards.basic-memory-refuses-to-list-a-closed-shared-book` | failure | differential | `workspace-open-book` | Listing a shared Book that is not open is denied; so is the archive half of the collection, which is not allowed wholesale the way `books` is. |
| `guards.basic-memory-refuses-a-non-canonical-directory` | failure | differential | `workspace-open-book` | A directory that climbs with `..` out of an open Book is not canonical and is denied rather than resolved. |
| `guards.basic-memory-writes-a-page-of-an-open-project` | success | differential | `workspace-open-book` | A direct write to a page under a Project Hub open at this seat takes the direct path: allowed, silently. |
| `guards.basic-memory-refuses-a-whole-page-hub-root-overwrite` | failure | differential | `workspace-open-book` | A whole-page overwrite of an open Hub's root page is denied and sent to Edit-ProjectHub, which journals, locks and verifies. |
| `guards.basic-memory-refuses-a-duplicating-edit` | failure | differential | `workspace-open-book` | An edit_note operation outside the idempotent allowlist is denied, whatever its case: `Append` duplicates content on a retry exactly as `append` does. |
| `guards.basic-memory-refuses-a-write-outside-an-open-project` | failure | differential | `workspace-open-book` | A direct write to a Project Hub that is not open at this seat is denied. |
| `guards.basic-memory-refuses-a-tool-it-was-not-taught` | failure | differential | `workspace-open-book` | A Basic Memory tool the guard has no rule for is denied by name: an allowlist fails closed. |
| `guards.basic-memory-a-dot-dot-does-not-leave-an-open-project` | failure | differential | `workspace-open-book` | A write whose identifier climbs out of an open Project Hub with `..` is denied: `projects/acceptance/../other` names a closed Hub, and a `.` or `..` segment is never a page name. |
| `guards.basic-memory-a-tool-name-is-matched-exactly` | failure | differential | `workspace-open-book` | A tool name is matched exactly: `MCP__basic-memory__EDIT_NOTE` is not edit_note, and it is denied rather than admitted past the operation allowlist. |
| `guards.basic-memory-a-seatless-call-fails-closed` | failure | differential | `workspace-fresh` | A Basic Memory call from a session that resolves no seat fails closed in the seat resolver's words: no seat, no Desk, nothing open. |
| `guards.basic-memory-codex-spelling-lists-an-open-shared-book` | success | differential | `workspace-open-book` | Codex names a Basic Memory tool `mcp__basic_memory__<tool>`, its server's hyphens spelled as underscores (measured S37), and the guard judges that name as the tool it is: a listing inside an open shared Book is allowed, silently, as it is under Claude Code's spelling. |
| `guards.basic-memory-codex-spelling-read-is-suspended` | failure | differential | `workspace-open-book` | A direct read under Codex's spelling, `mcp__basic_memory__read_note`, is denied as the suspended reader it is -- in the suspension's own sentence, not as a tool the guard was never taught. |
| `guards.basic-memory-codex-spelling-keeps-the-edit-allowlist` | failure | differential | `workspace-open-book` | Under Codex's spelling the edit rules still hold: `mcp__basic_memory__edit_note` with `append` on a page of an open Hub is denied as a duplicating edit, because the name is the same tool and not a way past the operation allowlist. |
| `guards.another-workspaces-shelf-is-closed-here` | failure | differential | `workspace-open-book` | A Read by absolute path into ANOTHER registered workspace's Shelf is denied whatever that workspace's Desk says: a Desk belongs to a seat in a session, and this session holds none there. |
| `guards.a-shell-read-into-another-workspace-is-denied` | failure | differential | `workspace-open-book` | A shell command naming another registered workspace's Notebook by a forward-slash drive path is denied on its text, quoting the path the command typed. |
| `guards.a-selection-inside-a-workspace-fails-closed` | failure | differential | `workspace-open-book` | A guard given a workspace that sits INSIDE a registered one fails closed, naming the selection, what the working directory derives and what the registry registers: the three answers disagree, and judging by any one of them would judge one place by another's Desk. |
| `guards.a-marker-the-registry-contradicts-fails-closed` | failure | differential | `workspace-open-book` | A workspace whose marker names one id while the registry registers its path under another fails closed: the marker is the authority, and carrying on would act under an identity the registry attributes to something else. |
| `guards.settings-dropping-an-optional-hook-is-allowed-and-said` | success | differential | `workspace-fresh` | A settings edit that registers every load-bearing guard but drops the optional guidance hooks is allowed, and the hooks it no longer registers are named rather than dropped in silence. |
| `guards.settings-dropping-a-load-bearing-guard-is-refused` | failure | differential | `workspace-fresh` | A settings edit that stops registering a load-bearing guard is refused, naming the guard and what it protects; the previous settings stay in force. |
| `guards.settings-moving-a-guard-off-its-event-is-refused` | failure | differential | `workspace-fresh` | A guard still named but moved to an event where it cannot act -- the Shelf guard under PostToolUse, after the tool has run -- is refused, naming the event it belongs on. |
| `guards.settings-a-hooks-block-the-harness-skips-is-refused` | failure | differential | `workspace-fresh` | A hooks block whose event is an object where Claude Code requires an array is refused: the harness skips such a file entirely, so every guard in it would go silent while a walk of it reads clean. |
| `guards.settings-a-null-hook-entry-is-refused` | failure | differential | `workspace-fresh` | A hooks block whose entry is null is refused as a shape fault. Until S36 it made the oracle's walk throw, and a guard that fails open allowed it in silence. |
| `guards.settings-a-hooks-key-in-the-wrong-case-registers-nothing` | failure | differential | `workspace-fresh` | A hooks block under `Hooks` registers nothing in a harness that reads `hooks`, so the edit is refused for every load-bearing guard. Until S36 the oracle read the key case-insensitively and allowed it. |
| `guards.settings-emptied-to-an-empty-object-is-refused` | failure | differential | `workspace-fresh` | Settings files emptied to `{}` register no guard at all and are refused. Until S36 an empty object made the oracle's registry walk throw, and the edit was allowed in silence. |
| `guards.settings-keys-differing-only-in-case-do-not-parse` | failure | differential | `workspace-fresh` | A settings file with two keys that differ only in case does not parse as the oracle reads JSON, and is refused in that parser's own sentence. |
| `guards.settings-a-source-it-cannot-block-is-not-judged` | success | differential | `workspace-fresh` | A ConfigChange from a source no hook can block, or one that does not define the Library's hooks, is not judged: the guard says nothing, even over a settings file it would refuse. |
| `guards.desk-context-names-what-is-open-at-this-seat` | success | differential | `workspace-open-book` | On every prompt the Desk context hook names the seat, how it was named, what is open there, and the exact reader tool for it -- here a seat named by LIBRARY_SEAT, which it says is not bound to this conversation. |
| `guards.desk-context-labels-every-kind-of-open-book` | success | differential | `workspace-open-book` | A Desk holding a Shelf Book, a bare slug, a shared archive, a Shelf archive and a Project Hub is reported with one label per kind -- a bare slug as SHARED -- and both reader tools advertised. |
| `guards.desk-context-with-no-seat-says-how-to-get-one` | failure | differential | `workspace-fresh` | A session that resolves no seat is told so in the seat resolver's words, that nothing can be opened or changed until one is entered, and to ask the reader which seat. |
| `guards.desk-context-a-seat-with-no-desk-is-named` | failure | differential | `workspace-open-book` | A seat that has no Desk in this workspace is named, with the command that creates it, rather than reported as an empty Desk. |
| `guards.desk-context-unreadable-state-advertises-no-reader` | failure | differential | `workspace-open-book` | A Desk file that does not parse is reported as invalid state, with no reader tool advertised: a session that cannot trust the Desk must not be handed a reader to use against it. |
| `guards.desk-context-in-no-workspace-says-so` | failure | differential | `bare-folder` | A session in no Library workspace is told so and how to attach one, rather than being shown an empty Desk. |
| `guards.desk-context-a-contradictory-selection-is-reported` | failure | differential | `workspace-open-book` | A workspace selection the registry contradicts is reported as unavailable, in the resolver's own refusal, rather than answered from either candidate. |
| `guards.desk-context-names-the-reader-codex-offers` | success | differential | `workspace-open-book` | Registered for Codex, the Desk context hook is handed the reader's Codex prefix, `mcp__validated_book_reader__`, and advertises the reader by the name Codex offers -- never by the project form, which names a tool no Codex session has. |
| `guards.desk-context-a-prefix-naming-no-tool-advertises-none` | failure | differential | `workspace-open-book` | A reader prefix that is not `mcp__<server>__` names no tool, so the Desk context says it cannot name one and advertises nothing, rather than handing the session a name to call. |
| `guards.a-closed-book-denial-names-the-reader-codex-offers` | failure | differential | `workspace-open-book` | The Shelf guard's denial tells the session which reader tool to call next, so under a Codex registration it names `mcp__validated_book_reader__read_open_book_page`, the tool that session is offered. |
| `guards.a-shell-denial-names-the-reader-codex-offers` | failure | differential | `workspace-open-book` | The shell guard's denial names the reader by the prefix its registration was handed, so a Codex session is sent to `mcp__validated_book_reader__read_open_book_page` rather than to a tool it does not have. |
| `guards.a-reader-prefix-naming-no-tool-fails-closed` | failure | differential | `workspace-open-book` | A Shelf guard handed a reader prefix that names no tool is a broken registration, and it fails closed -- even over a read it would otherwise allow -- naming the prefix, rather than denying later with a sentence that sends the session to a tool that does not exist. |

### Approved deltas

| Delta | Applies to | Field | Reason | Approved |
| --- | --- | --- | --- | --- |
| `notebook-is-seat-owned` | `area:compile`, `area:reset` | rebase `notebook/{seat}` onto `notebook`, then compare content; kernel only: `^effect\.internal/notebook-layout\.json$`, `^effect\.internal/notebook-migration/`; PowerShell only: `^effect\.internal/notebook-topic-owners\.json$`; 3 sentence pair(s), verbatim | ADR-0029: the kernel keeps each seat's Notebook at notebook/<seat>/ and records no owners; the PowerShell arm writes notebook/<topic>/ and records every owner. So the ACTING seat's root in the kernel's outcome is rebased onto the oracle's notebook/ -- keyed by that seat's value, in every spelling a path takes -- and then held to the oracle's content exactly. Until S18 this delta matched any field beginning effect.notebook/ and approved it whatever it held, which would have turned every Notebook row green the moment the kernel wrote under a seat root. Files only one layout has are named rather than matched by prefix: the kernel's layout and migration records, the oracle's ownership record. Three sentences say one fact in each layout's own words and are paired verbatim: a restore's keep reason, the sweep the kernel does not have, and the route that re-renders a seat's index, which the PowerShell renderer cannot reach. | PLAN-public-release.md step 23, 'every intentional delta (the Seat-owned Notebook, local Hubs) is listed and approved'; narrowed to a rebase and to the two areas that write a seat's Notebook in S18, under the reader's four rulings of that session, 2026-09-19 |
| `hubs-can-be-local` | `area:hub` | `^result\.backend$` | ADR-0030 and step 27: Tier 0 runs with the local backend only, so a Hub the PowerShell arm can only create in the shared collection the kernel creates on disk. The operation and its refusals are compared; the storage location is not. | PLAN-public-release.md step 23, 2026-09-19 |
| `kernel-claim-lock` | `area:seat` | `^effect\.\.claude/seats/[a-z0-9][a-z0-9-]*/\.claim\.lock$` | A seat claim the KERNEL holds is two files. Node can open a file sharing everything or sharing nothing, and PowerShell's FileShare::Read is neither (measured 2026-09-22): so the kernel's holder writes .claim sharing everything -- which PowerShell's probe still reads as held and its acquire still refuses -- and holds .claim.lock sharing nothing, which makes its own acquisition exclusive and is what the kernel's probe reads for a kernel holder. The alternative, probing .claim sharing nothing, would have read every concurrent reader as a live session: the defect PowerShell's probe was corrected for on 2026-09-15. | the reader, S14's second half, choosing the sidecar lock over an exclusive probe, 2026-09-22 |
| `kernel-reports-its-own-version` | `*` | `^result\.program_version$` | Every helper that reports a program version reports the version of the implementation that ran. The two arms are different programs; requiring equal version strings would require the port to lie about which one answered. | PLAN-public-release.md step 28, the plugin/binary/schema version tuple, 2026-09-19 |

### Public helpers with no row, and why

| Helper | Class | Reason |
| --- | --- | --- |
| `Import-ExternalWikiToShelf.ps1` | not-ported | Step 24 names wiki import among the four that do not port: a one-time migration the public never runs. |
| `Get-WikiMigrationInventory.ps1` | not-ported | The inventory half of the same wiki import. |
| `New-HubMigrationSnapshot.ps1` | not-ported | Step 24 names Hub migration among the four that do not port. |
| `Test-HubMigrationAcceptance.ps1` | not-ported | The acceptance half of the same Hub migration. |
| `Get-TokenBaseline.ps1` | not-ported | Step 24 names the token baseline among the four that do not port: a development measurement, not a reader operation. |
| `Update-BookManifests.ps1` | not-ported | Step 24 names both manifest backfills among the four that do not port. |
| `Update-SharedBookManifests.ps1` | not-ported | The shared half of the same backfill. |
| `Set-NotebookTopicOwner.ps1` | not-ported | ADR-0029 retires topic ownership: a topic belongs to the seat whose Notebook holds it, so the kernel has no ownership writer and `library notebook own` refuses by name. Its row became reset.topic-ownership-is-retired-by-adr-0029 in S18, judged independently by tools/Test-NotebookMigration.ps1. |
| `Export-PublicTree.ps1` | maintainer-only | Publishes this program. It runs in the maintainer's checkout and has no meaning inside a reader's workspace. |
| `Export-MirrorOpsRepo.ps1` | maintainer-only | Generates the publishing job of step 12. Maintainer-side, like the tree export it serves. |
| `Build-KernelRelease.ps1` | maintainer-only | Builds the release archives the installers install (step 28, S19). It runs in the maintainer's checkout or the publishing job; a reader receives its output, never runs it. |
| `Export-CollectionToVault.ps1` | maintainer-only | The one-time vault export of step 13, run once against this estate's collection. |
| `Move-LibraryFolder.ps1` | maintainer-only | The folder cutover protocol of step 6, which moved D:\Library. A reader's workspace is created by `library init` and moved by moving it. |
| `Initialize-CodexLibrary.ps1` | maintainer-only | Renders this program's own .codex/ bindings. `library init` is the reader's route and has its own rows. |
| `Remove-MemoryProject.ps1` | maintainer-only | Deletes a Basic Memory project. An operator's recovery route against the backend, deliberately not in the reader's binary. |
| `Remove-SharedEntry.ps1` | maintainer-only | Repairs a shared Catalog by hand. Operator recovery, reached through the playbooks. |
| `Remove-SeatArchive.ps1` | maintainer-only | Removes a retired seat's archive. Operator recovery. |
| `Remove-NotebookQuarantine.ps1` | maintainer-only | Empties reset quarantine. Operator recovery; the restore route is what the reader is offered and it has a row. |
| `Restore-BookSource.ps1` | maintainer-only | Rebuilds a Book's source record after an upstream change. Operator recovery. |
| `Sync-RawUpstream.ps1` | deferred | Pulls a raw batch's upstream. Useful to a reader and not in Tier 0; revisit before v1.1 rather than porting blind. |
| `Get-MeterStatus.ps1` | deferred | Reports this estate's Basic Memory meter. Backend-specific reporting that Tier 0 has no counterpart for. |
| `Get-BookCurrency.ps1` | deferred | Book currency anchoring is a shared-collection property; docs/book-currency-anchoring-deferred.md already records the deferral. |
| `Set-TopicOverlap.ps1` | deferred | Duplicate-topic bookkeeping over the shared collection. Its detector, Find-ShelfDuplicateTopics, has a row. |

<!-- END GENERATED MATRIX -->
