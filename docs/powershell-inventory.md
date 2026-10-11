# PowerShell inventory (draft)

**Status: B's draft, 2026-10-09, for the first Kickoff of `PLAN-powershell-free-development.md`.** A corrects it in that
Kickoff's row 0, and every later row updates it (the plan, Session 1 item 0). Read from `master` at `1bd14ec` (S109
cut 1), read-only: nothing was run. Five read-only passes drafted the rows, and B merged them. Cells marked
`(unverified)` were not checked against code, and covering sections named by keyword were not checked case by case.

**Columns:** file or check; what it does; class; decision (`port`, `port some cases`, `retire`); where it goes; the
defect it has caught; state (`old only`, `both`, `new only`, `retired`). Every row starts `old only`.

**The classes (the plan's rule Q2):** 1 checks PowerShell code, so it retires with the PowerShell. 2 is an oracle for
differential rows, retired once they are frozen (session 4). 2a builds or seeds a matrix fixture, replaced in session 3.
3 is a tool a person or a release runs, so it is ported. 4 is a test suite: only the cases nothing else covers are
ported. 5 is unclear, so it is retired with a reason. Nothing is deleted without a row.

**Counts at `1bd14ec`:** 139 `.ps1` files. That is 125 in `tools/` (46 from A to L and 50 from M to Z, leaving out the
`Test-*` and `Invoke-*` files; then 25 `Test-*` and 4 `Invoke-*`), and 14 outside it. The gate registers 132 checks:
67 run in both modes, 61 are skipped under `-Fast`, and 4 run only with `-IncludeShared`.

## Open questions for row 0

1. **Counts:** the plan says 24 `Test-*` suites, but there are 25 (also at `d2efcf1`). The runner's own comment
   (`Invoke-LibraryChecks.ps1:34-37`) still says 128 checks, 63 of them suites.
2. **The decision column needs a fourth value for the listed exceptions.** The reader adapter's closure is 25 files
   (the adapter and 24 `tools/*.ps1`). About 23 of them are marked here as "retire, kept with the adapter closure":
   they leave the development loop but are not deleted while the adapter ships.
3. **The 2a set (fixture builders) is wider than the plan's list.** `AcceptanceFixtures.ps1:47-48` dot-sources
   `NotebookOwnership.ps1` and `RawBatchOwnership.ps1`, and `Set-NotebookTopicOwner` seeds topics at `:438`. The
   fixture closure also takes in `AtomicFile`, `BookWriteGuard`, `CodexBindings`, `CodexHome`, `CollectionOwnership`,
   `GitSource`, `HookRegistry`, `LibraryDeployment`, `LibraryOutput`, `BookManifestTransaction`, `Get-DeskOverview` and
   `Get-LibraryTriageInventory`.
4. **`Test-NotebookMigration.ps1` must be ported, not retired.** It is the live judge of two independent matrix rows,
   and no self-test section tests `migrate`. Its input fixture comes from the legacy PowerShell writers, so it is
   frozen first.
5. **`Test-InstallProof.ps1` installs the published 1.0.0 with 1.0.0's own `install.ps1`.** A TypeScript port either
   keeps one `powershell.exe` call (a listed exception) or freezes a 1.0.0 install as a snapshot.
6. **This checkout's own hooks and adapter still run `.ps1`.** `.claude/settings.json:77-222` and `.mcp.json:4-10` do
   so because a workspace initialised from source has no `bin/library.exe` (`init.ts:420-426`). Moving them over needs
   a source route, such as `node kernel/src/cli.ts hook <verb>`, and its start-up cost per prompt is unmeasured. If it
   is too slow, the hooks become a listed exception.
7. **Three places not in the plan depend on a `.ps1`:**
   - self-test section 62 (`selftest.ts:6115-6122`) runs `Set-NotebookTopicOwner.ps1` and `NotebookIndex.ps1`;
   - `tools/docs-gate.ts:370` reads `SearchBoundaries.ps1` as text;
   - `.claude/hooks/payload-contract.json` is read only by PowerShell.
   Plan line numbers that moved: doctor is now `:648-653`, section 162 is at `:14389`, and the seat-picker section is
   at `:4990-4997`.
8. **`doctor.ts:648-653` will pass silently once the helpers are deleted,** because `bookSlugDefault` (`:613-614`)
   returns null for a missing file. The port changes it to a stated default.
9. **Five reader-adapter checks** (`reader.launch-validation`, `.dispatch-selftest`, `.shelf-selftest`,
   `.project-pin-selftest`, `.shared-selftest`) would spawn `powershell.exe` from `tools/gate.ts`. They stay with the
   adapter exception, or move to the release tier.
10. **About 35 class-1 checks** (PowerShell AST and taint scans) retire with the PowerShell. Several guard rules the
    kernel must also keep: atomic Desk writes, lock order, claim coverage and the export lock. No kernel-side static
    check was found for any of them, so each needs a kernel equivalent or a stated reason not to have one.
11. **Retiring five suites means rewriting matrix rows too.** `Test-LibraryHooks`, `Test-CodexPortability`,
    `Test-SeatLifecycle`, `Test-ShelfNoteBoundary` and `Test-RecoveryRoutes` are named in rows' PowerShell steps or
    reasons, the recorded-verdict `harness.*` rows among them.
12. **Six "port some cases" calls rest on gaps confirmed by grep.** In each, the kernel has the behaviour but no
    section or row asserts it:
    - the maintenance barrier (`seatclaim.ts:638`);
    - Discovery counting archived Books;
    - the render lock staying narrow;
    - dating a quarantine whose journal is missing (`desk.ts:194-213`);
    - the refusal when a seat binding and `LIBRARY_SEAT` disagree (`seatdesk.ts:302`);
    - Basic Memory's `conflict` answer (`basicmemory.ts:401`).
13. **Class calls to settle:**
    - `Get-BookCurrency`: the matrix defers it, but library-help names it.
    - `Export-CollectionToVault`: the matrix calls it one-time, but the playbook treats it as routine.
    - `Update-SharedBookManifests`: the matrix lists it as not ported, but `ownership.ts:510` and the adapter name it.
    - `Remove-MemoryProject`: the matrix tells the user to run it.
    - `PluginPackage`: class 3, called by `Build-KernelRelease.ps1:242`.
    - `triage.history-readable`: the only workspace check that kernel `doctor` lacks.
    - Twelve helpers have no kernel verb found, among them `Move-LibraryFolder`, `Sync-RawUpstream` and
      `Remove-SeatArchive`.
14. **The publish folder** (`docs/releasing.md` step 2, `<publish>`) is outside the checkout, and B did not find it on
    this machine. A or the release session names it, and its publish script gets rows.

## Contents

1. `tools/*.ps1` from A to L (not `Test-*` or `Invoke-*`)
2. `tools/*.ps1` from M to Z (not `Test-*` or `Invoke-*`)
3. `tools/Test-*.ps1` and `tools/Invoke-*.ps1`
4. The checks registered in `Invoke-LibraryChecks.ps1`
5. The PowerShell outside `tools/`, and every non-`.ps1` place that depends on a `.ps1` (with the grep)

## 1. `tools/*.ps1` from A to L

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `tools/AcceptanceFixtures.ps1` | Builds the nine fixture workspace shapes every matrix row runs over, through the real PowerShell writers. | 2a (also 2: harness) | retire | session 3 frozen snapshots in `tools/frozen/fixtures/`, restored by `tools/matrix.ts` | none found | old only |
| `tools/AcceptanceKernelStub.ps1` | Test double for the kernel, used by `Invoke-AcceptanceMatrix.ps1 -SelfTest` to prove the comparer can report a mismatch. | 2 (harness self-test) | retire | session 3 comparer proof (mutation cases) in `tools/matrix.ts`; deleted with the PowerShell | its `-NotebookOnly` mode guards the over-broad Notebook delta fixed in S18 (file comment; hash unverified) | old only |
| `tools/AcceptanceMatrix.ps1` | Matrix shape and coverage rules, the normaliser, effect extractor, comparer with approved deltas, and the matrix doc renderer. | 2 (harness); hosts check `acceptance.matrix-shape` | retire | session 3: `tools/matrix.ts` (normaliser, comparer, `--check-shape`), each proven equal first | none found (its non-ASCII output defect fixed in `ca59c7a`) | old only |
| `tools/AcceptanceSharedCollection.ps1` | Creates, pins and deletes a disposable `acceptance-<guid>` Basic Memory project per shared-row arm. | 2a (shared fixtures) | port | `tools/matrix.ts` (shared rows still need disposable projects after the freeze) (unverified) | none found | old only |
| `tools/Add-CatalogEntry.ps1` | Lists an existing shared Book or Hub missing from its Catalog with one additive `edit_note`. | 2 | retire | frozen rows `publication.catalog-entry-*` (3); kernel verb `shared list-entry` | none found | old only |
| `tools/Add-ShelfBookPage.ps1` | Adds one new page to an open curated Shelf Book under the Book's lock. | 2 | retire | frozen rows `capture.page-added-to-an-open-curated-book`, `capture.page-refused-when-the-book-is-closed`; kernel verb `book add-page` | none found | old only |
| `tools/Add-ShelfBookTopic.ps1` | Graduates a whole Notebook topic into an open Shelf Book, resumable after interruption. | 2 | retire | frozen row `capture.topic-graduates-into-an-open-book`; kernel verb `book graduate` | none found | old only |
| `tools/Add-ShelfNote.ps1` | Captures one note into a capture-enabled Shelf Book (Holding by default). | 2 | retire | frozen rows `capture.note-lands-*`, `capture.the-reader-map-keeps-*`, `capture.a-report-without-a-why-*`, `capture.refuses-a-book-*`; kernel verb `capture`; `doctor.ts:647-652` reads it | none found | old only |
| `tools/Archive-ProjectHub.ps1` | Moves an active Project Hub to the shared archive shelf. | 2 | retire | frozen rows `hub.archive-*` (3); kernel verb `hub archive` | none found (its conflict misread fixed in `ca59c7a`) | old only |
| `tools/Archive-SharedBook.ps1` | Moves a shared Book to the archive shelf and repairs the archive emptiness sentence. | 2 | retire | frozen rows `publication.shared-book-archive*` (3); kernel verb `shared archive` | none found (its conflict misread fixed in `ca59c7a`) | old only |
| `tools/Archive-ShelfBook.ps1` | Archives, restores or lists Shelf Books under a plan_id-gated, verified move. | 2 | retire | frozen rows `shelf.archive-retires-*`, `shelf.archived-book-restores-*`; kernel verbs `shelf archive`, `shelf restore` | none found | old only |
| `tools/AtomicFile.ps1` | Atomic whole-file replace and the matching retrying read. | 2a (fixture and seed closure); adapter closure | retire | kept with the reader adapter's closure (session 6); kernel `fsx.ts` | none found | old only |
| `tools/Build-KernelRelease.ps1` | Builds release zips: bun compile, staging through the public allowlist, `SHA256SUMS`. | 3 | port | `tools/build-release.ts` (session 5) | none found | old only |
| `tools/BookDiscovery.ps1` | Queries closed-readable Book manifests for slug, page path and heading, never body text. | 5 (adapter closure only) | retire | kept with the reader adapter's closure (session 6); kernel `discovery.ts` (unverified) | none found | old only |
| `tools/BookFullText.ps1` | Line-by-line full-text search confined to Shelf Books open on the Desk. | 5 (adapter closure only) | retire | kept with the adapter's closure; the session 6 negative case hides this file; kernel `fulltext.ts` (unverified) | none found | old only |
| `tools/BookManifest.ps1` | Builds one Shelf Book's Discovery manifest, withholding capture-Book page metadata. | 2a (fixture builder dot-sources it); adapter closure | retire | session 3 snapshots; kept with adapter closure; kernel `manifest.ts` | none found | old only |
| `tools/BookManifestStore.ps1` | Stores manifests per Book with a dirty marker, generations and a commit pointer written last. | 2a (fixture builder); adapter closure | retire | session 3 snapshots; kept with adapter closure; kernel `manifeststore.ts` | none found | old only |
| `tools/BookManifestTransaction.ps1` | Generates, stores and commits one Book's manifest under that Book's lock. | 2a (seed closure via `Publish-ShelfBookToShared.ps1`) | retire | session 3 kernel-verb seeds; kernel `mutation.ts`; deleted with the PowerShell | none found | old only |
| `tools/BookRootSchema.ps1` | Specifies the Desk's Book-root states and seat Desk file layout once. | 2a (fixture builder); adapter closure | retire | kept with adapter closure; `init.ts:1129,1185` program-root detection must re-point first (session 6) | none found | old only |
| `tools/BookWriteGuard.ps1` | Per-Book exclusive lock and pre-write journal with verified rollback. | 2a (fixture and seed closure); adapter closure | retire | kept with adapter closure; kernel `locks.ts`, `journal.ts` | none found (two defects in it fixed, `182d838`) | old only |
| `tools/CodexBindings.ps1` | Renders `.codex/hooks.json` and `config.toml` from tracked templates by token substitution. | 2a (dot-sourced by `Initialize-LibraryWorkspace.ps1`) | port | goes with `Initialize-CodexLibrary.ps1`'s port; workspace half is kernel `init` (`init.ts`) | none found | old only |
| `tools/CodexHome.ps1` | Resolves Codex's state directory through `CODEX_HOME`. | 2a (via `CodexBindings.ps1`) | retire | folded into the ports of `CodexBindings.ps1` and `Get-MeterStatus.ps1`; deleted with the PowerShell | none found | old only |
| `tools/CollectionOwnership.ps1` | One writable workspace per collection: the ownership record and the fence every shared write passes. | 2a (seed closure: `New-ProjectHub`, `Set-CollectionOwner`) | retire | session 3 kernel-verb seeds (`collection owner`); kernel `ownership.ts` | none found (file comment, line 794: a regression caught by the full gate) | old only |
| `tools/Compile-RawBatchToNotebook.ps1` | Turns one finished synthesis from a named raw batch into an indexed Notebook article. | 2 | retire | frozen rows `compile.source-batch-becomes-notebook-articles`, `compile.refuses-the-whole-raw-tree`; kernel verb `compile` | none found | old only |
| `tools/Copy-LocalPagesToProject.ps1` | Copies selected Notebook pages into an active Project Hub. | 2 | retire | frozen rows `hub.local-pages-copy-*` (4); kernel verb `hub copy-pages` | none found (its conflict misread fixed in `ca59c7a`) | old only |
| `tools/DeploymentScan.ps1` | Deployment-default and identity scans over what a commit publishes, plus a gitleaks call. | 3 | port | `tools/scan.ts` (session 1 step 6) | identity scan refused a hostname in the mirror design record (`84681f9`) and a doc draft (`9a9b02f`) | old only |
| `tools/Edit-ProjectHub.ps1` | Edits one page of an open active Project Hub, journaling the prior body. | 2 | retire | frozen rows `hub.edit-preflight-*`, `hub.add-section-appends-one-dated-entry`; kernel verb `hub edit` | none found | old only |
| `tools/Enter-LibrarySeat.ps1` | Binds a running conversation to an existing seat, or creates one after a plan_id confirmation. | 2 | retire | frozen rows `seat.enter-an-existing-free-seat`, `seat.desk-context-records-*`; kernel verb `seat enter` | none found (a check caught a defect in it, `8280d5b`) | old only |
| `tools/Export-CollectionToVault.ps1` | Mirrors the collection's `books/` and `projects/` into the Obsidian vault, byte-exact. | 3 | port | `tools/export-vault.ts` (unverified; no kernel verb exists) | none found | old only |
| `tools/Export-MirrorOpsRepo.ps1` | Generates the private ops repository's workflow and scanner from `docs/mirror-publishing-job.md`. | 3 | port | `tools/export-mirror-ops.ts` (name unverified) | none found | old only |
| `tools/Export-PublicTree.ps1` | Copies the public allowlist to staging, scans it, and only then commits and pushes the public tree. | 3 | port | `tools/export-public-tree.ts` (session 5) | its scan refused the first real export naming a host (`84681f9`) | old only |
| `tools/Find-ShelfDuplicateTopics.ps1` | Flags likely duplicate topics across Shelf Books by embedding similarity. | 2 | retire | frozen row `shelf.duplicate-topics-are-reported-not-resolved`; kernel verb `shelf duplicates` | none found | old only |
| `tools/Get-BookCurrency.ps1` | Asks a Book's recorded upstreams what version they are now; read-only. | 3 (unverified; matrix marks it `deferred`) | port | kernel verb (none exists; name unverified) | none found | old only |
| `tools/Get-DeskOverview.ps1` | Read-only Desk, Notebook and capture-Book orientation with owner labels. | 2 (also 2a closure; adapter closure) | retire | frozen rows `desk.overview-names-*`, `desk.a-bare-slug-*`; kernel verb `desk`; kept with adapter closure | none found | old only |
| `tools/Get-LibraryTriageInventory.ps1` | Read-only inventory of the Notebook and capture Books for triage. | 2 (also 2a closure; adapter closure) | retire | frozen row `triage.inventory-lists-what-is-waiting`; kernel verb `triage inventory`; kept with adapter closure | none found | old only |
| `tools/Get-MeterStatus.ps1` | Reports the Codex delegate's rate-limit window from local rollout files, stale-aware. | 3 | port | `tools/meter-status.ts` (name unverified) | guarded the quoted rate-limits decoy; `meter.parsers-agree` caught the status line's drift (`8bb3c61`) | old only |
| `tools/Get-TokenBaseline.ps1` | Cross-engine token baseline from local Claude and Codex session histories. | 5 | retire | deleted with the PowerShell: matrix `not-ported`, no workflow doc names it, untouched since `8a913a9` | none found | old only |
| `tools/Get-WikiMigrationInventory.ps1` | Read-only inventory of an external wiki before import. | 5 | retire | deleted with the PowerShell: matrix `not-ported` (one-time migration) | none found | old only |
| `tools/GitSource.ps1` | Hardened boundary for every git call: allowlisted environment, config isolation, bounded fetch. | 2a (fixture closure); adapter closure | retire | kept with adapter closure; kernel `gitenv.ts` (unverified) | none found | old only |
| `tools/HookRegistry.ps1` | Which hooks the Library requires and under which events, judged structurally. | 2a (dot-sourced by `Initialize-LibraryWorkspace.ps1`); adapter closure | retire | kept with adapter closure; kernel `hookregistry.ts` | none found (three silent allows in it fixed, `19519b3`) | old only |
| `tools/Import-ExternalWikiToShelf.ps1` | Copies an approved external wiki into a new Shelf Book. | 5 | retire | deleted with the PowerShell: matrix `not-ported`; rewrite the docs and instructions that name it | none found | old only |
| `tools/Initialize-CodexLibrary.ps1` | Writes the checkout's machine-local Codex MCP and hook bindings from tracked templates. | 3 | port | `tools/*.ts` (name unverified); a new worktree needs it (`docs/dev-session-loop.md:383,402`) | none found | old only |
| `tools/Initialize-LibraryWorkspace.ps1` | `library init`: writes the marker, registers the workspace, installs the managed instruction and hook files. | 2a (builds every fixture); also 2 | retire | session 3 frozen snapshots; frozen rows `workspace.init-*` (5); kernel verb `init` | none found | old only |
| `tools/LibraryDeployment.ps1` | Resolves the Basic Memory endpoint and collection id from one chain, refusing when none resolves. | 2a (fixture and seed closure); adapter closure | retire | kept with adapter closure; kernel `basicmemory.ts` | none found | old only |
| `tools/LibraryOutput.ps1` | Shared output contract: objects in-process, one JSON object at a process boundary. | 2a (dot-sourced by nearly every writer); adapter closure | retire | kept with adapter closure; kernel `psjson.ts` (unverified) | none found (non-ASCII escape defect in it fixed, `ca59c7a`) | old only |
| `tools/LibrarySeat.ps1` | Seat registry, exclusive session claim, activity record and single-Desk migration. | 2a (fixture builder dot-sources it); adapter closure | retire | kept with adapter closure; kernel `seat.ts`, `seatclaim.ts`, `seatregistry.ts` | none found | old only |

#### Notes

- Scope: 46 files, not 49. `ls tools/*.ps1` names A through L, excluding `Invoke-*`, give 46.
- 14 of these files are in the reader adapter's transitive closure, computed with `releasefiles.ts`'s two regexes from `.claude/adapters/Validated-BookReader.ps1`: AtomicFile, BookDiscovery, BookFullText, BookManifest, BookManifestStore, BookRootSchema, BookWriteGuard, Get-DeskOverview, Get-LibraryTriageInventory, GitSource, HookRegistry, LibraryDeployment, LibraryOutput and LibrarySeat. They cannot be deleted in session 6. I marked them `retire` with "kept with adapter closure", because the plan's decisions have no "listed exception" value. A may want a separate state or decision for them.
- Session 3 needs the fixture and seed closure, not only the plan's named list. Dot-source closure of `AcceptanceFixtures.ps1` plus the six seed writers plus `Initialize-LibraryWorkspace.ps1`'s direct dot-sources pulls in these files from this range: AtomicFile, BookManifest, BookManifestStore, BookManifestTransaction, BookRootSchema, BookWriteGuard, CodexBindings, CodexHome, CollectionOwnership, Get-DeskOverview, Get-LibraryTriageInventory, GitSource, HookRegistry, LibraryDeployment, LibraryOutput and LibrarySeat. `Initialize-LibraryWorkspace.ps1`'s raw closure is about 100 files, because its `-SelfTest` spawns `Invoke-LibraryChecks.ps1` (line 1298). I counted only its top-level dot-sources (lines 61-79, 1686) and `New-ShelfBook.ps1` (line 1129).
- 21 files here have a `-SelfTest` that `Invoke-LibraryChecks.ps1` registers as a check: Add-CatalogEntry, Archive-SharedBook, BookDiscovery, BookFullText, BookManifest, BookManifestStore, BookManifestTransaction, BookRootSchema, BookWriteGuard, CollectionOwnership, DeploymentScan, Edit-ProjectHub, Export-CollectionToVault, Export-PublicTree, Get-LibraryTriageInventory, Get-MeterStatus, Get-TokenBaseline, GitSource, Initialize-LibraryWorkspace, LibraryDeployment and LibraryOutput. Those checks need their own check rows, with class 4 decisions per case, and are not covered here.
- Uncertain class calls:
  - `Get-BookCurrency.ps1`: the matrix marks it `deferred`, there is no kernel verb, but the `library-help` skill (`books-and-projects.md`) and the playbooks still name it. It is either class 3 (port as a kernel verb) or class 5 (retire and rewrite the advice).
  - `Export-CollectionToVault.ps1`: the matrix calls it a "one-time vault export", but the playbook (`librarian-operation-playbooks.md:1000`) presents it as a routine reader operation, and the kernel's `locks.ts` honours its export lock.
  - `AcceptanceSharedCollection.ps1`: kept as `port`, because shared rows after the freeze still need disposable projects (session 4 step 4 runs shared rows under `matrix.ts`).
  - Wiki import (two files): the project `CLAUDE.md` lists "importing an external wiki" as a gated action. Retiring the helpers leaves that instruction pointing at nothing.
  - `Get-MeterStatus.ps1`: step 0 of the Codex delegation preflight (`docs/model-division-of-labor.md:23,125,153`), so it is ported as dev tooling. `~/.claude/statusline.sh` already mirrors its parser in `jq`.
- Defect column: most defects found in git history are defects in these files, found by the port or by checks, not defects these files caught. I marked those "none found (… fixed in hash)". Notable: `ca59c7a` fixed defects in LibraryOutput and the Archive and copy writers. `19519b3` fixed HookRegistry. `8280d5b`: `desk.registry-lock-coverage` caught Enter-LibrarySeat. The AcceptanceKernelStub S18 note comes from its header comment, and I did not find its hash.
- Non-`.ps1` dependents seen in passing: `doctor.ts:647-652` reads `Add-ShelfNote.ps1`. `init.ts` (1129, 1185), `procstart.ts` and `seatdesk.ts` name `BookRootSchema.ps1`. `releasefiles.ts`, `releaseaudit.ts` and `programroot.ts` name `Build-KernelRelease.ps1`. `locks.ts` and `migrate.ts` name `Export-CollectionToVault.ps1`. `cli.ts`, `psjson.ts` and `shelfwriters.ts` name `AcceptanceMatrix.ps1`.
- Line counts (`wc -l`): AcceptanceFixtures 605, AcceptanceKernelStub 116, AcceptanceMatrix 1657, AcceptanceSharedCollection 354, Add-CatalogEntry 267, Add-ShelfBookPage 214, Add-ShelfBookTopic 304, Add-ShelfNote 293, Archive-ProjectHub 234, Archive-SharedBook 454, Archive-ShelfBook 585, AtomicFile 223, BookDiscovery 1078, BookFullText 738, BookManifest 616, BookManifestStore 645, BookManifestTransaction 636, BookRootSchema 1665, BookWriteGuard 783, Build-KernelRelease 375, CodexBindings 388, CodexHome 35, CollectionOwnership 1433, Compile-RawBatchToNotebook 670, Copy-LocalPagesToProject 342, DeploymentScan 1008, Edit-ProjectHub 1391, Enter-LibrarySeat 439, Export-CollectionToVault 862, Export-MirrorOpsRepo 255, Export-PublicTree 1227, Find-ShelfDuplicateTopics 122, Get-BookCurrency 558, Get-DeskOverview 435, Get-LibraryTriageInventory 751, Get-MeterStatus 201, Get-TokenBaseline 600, Get-WikiMigrationInventory 71, GitSource 974, HookRegistry 604, Import-ExternalWikiToShelf 157, Initialize-CodexLibrary 211, Initialize-LibraryWorkspace 1707, LibraryDeployment 306, LibraryOutput 148, LibrarySeat 2762. Total 29,499.

## 2. `tools/*.ps1` from M to Z

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `tools/MaintenanceBarrier.ps1` | Dot-sourced marker under `internal/` that stops claim-gated writes and seat entry during a folder cutover. | 2 (via `LibrarySeat.ps1`; also 2a, loaded by fixtures) | retire | Kernel honours the barrier already (`seatclaim.ts`); kept after session 6 as reader-adapter closure exception | none found | old only |
| `tools/ManifestJournal.ps1` | Dot-sourced progress journal the two manifest backfills write, read and resume from. | 5 (helper of not-ported backfills only) | retire | deleted with the PowerShell, with `Update-BookManifests.ps1` / `Update-SharedBookManifests.ps1` | none found | old only |
| `tools/McpDirectoryListing.ps1` | Dot-sourced paginated MCP `list_directory` with proved completeness. | 2 (via `Archive-ProjectHub.ps1`, `CollectionOwnership.ps1`) | retire | Ported as `Read-McpDirectoryListing` in `kernel/src/sharedwriters.ts`; frozen with its callers' rows | none found | old only |
| `tools/McpToolInventory.ps1` | Asks the workspace's MCP adapters for their tools and names the ones the permission allowlist misses. | 1 (feeds `helpers.manifest-matches-allowlist`; also used by `PluginPackage.ps1`) | retire | deleted with the PowerShell | none found (written after `search_open_books` sat unallowlisted a day, per its header) | old only |
| `tools/Move-LibraryFolder.ps1` | Maintainer cutover: moves a Library folder under a barrier, hashed preflight, verified copy and rollback. | 5 (`excluded_helpers`: maintainer-only, one-time step 6) | retire | deleted with the PowerShell; rewrite `seatclaim.ts:653-662` advice that names it | none found | old only |
| `tools/New-HubMigrationSnapshot.ps1` | Captures the one-time Hub Now/Next migration snapshot and verifier manifest. | 5 (`excluded_helpers`: not-ported, one-time migration) | retire | deleted with the PowerShell | none found | old only |
| `tools/New-ProjectHub.ps1` | Creates a Project Hub (Basic Memory or local collection) and its catalog entry. | 2a (seed of 11 differential rows); also 2 (oracle of `hub.new-project-hub-is-orientation-not-a-log`) | retire | Seed → kernel verb `hub new` (session 3); oracle row frozen (session 4) | none found as a catcher (its conflict misread fixed in ca59c7a) | old only |
| `tools/New-ShelfBook.ps1` | Creates an empty Shelf Book, curated or capture-enabled. | 2a (seed of 2 publication batch rows); also 2 (3 `shelf.new-*` rows) | retire | Seed → kernel verb `shelf new` (session 3); rows frozen (session 4) | none found | old only |
| `tools/NotebookIndex.ps1` | Dot-sourced serialized renderer for `notebook/_master-index.md`, with `-Render`/`-SelfTest`. | 2a (`AcceptanceFixtures.ps1:459,585`, `Initialize-LibraryWorkspace.ps1:66`); also 2 (`compile.master-index-is-derived-not-written`) | retire | Fixture snapshots (session 3); kernel verb `notebook render`; kept as reader-adapter closure exception | none found | old only |
| `tools/NotebookOwnership.ps1` | Dot-sourced record of which seat owns which Notebook topic, and the reset quarantine. | 2a (`AcceptanceFixtures.ps1:47`, `Set-NotebookTopicOwner` at `:438`); also 2 (via `Get-DeskOverview.ps1`, reset oracles) | retire | Fixture snapshots (session 3); ported in `kernel/src/notebook.ts`; kept as reader-adapter closure exception | none found | old only |
| `tools/PluginPackage.ps1` | Generates the plugin's Claude files from the canonical Codex manifests; renders Windows hooks for the build. | 3 (`Build-KernelRelease.ps1:242` runs it); also feeds `plugin.generated-files-match` | port | `tools/build-release.ts` (session 5), plus a generator for `plugin.generated-files-match` (unverified home) | e9c296c: Windows plugin hooks failed open; fixed here with five plugin-package checks | old only |
| `tools/PublicTreeAllowlist.ps1` | Reviewed allowlist of paths that may reach the public repository, and its resolver. | 3 (dot-sourced by `Build-KernelRelease.ps1`, `Export-PublicTree.ps1`, `DeploymentScan.ps1`) | port | `tools/export-public-tree.ts` (session 5); self-test section 162 reads it | none found | old only |
| `tools/Publish-BookCopy.ps1` | Publishes or refreshes a Book copy to the Shelf or shared collection via the candidate publisher. | 2a (seed of 5 differential rows); also 2 (2 `publication.refresh-*` rows) | retire | Seed → kernel verb `publish refresh` / `publish` (session 3, unverified which); rows frozen | none found | old only |
| `tools/Publish-SharedBookCandidate.ps1` | Core shared-collection publisher that `Publish-BookCopy.ps1` forwards to. | 2a (reached by `Publish-BookCopy` / `Publish-ShelfBookToShared` seeds); also 2 | retire | Ported core in `kernel/src/publish.ts`; retires with its wrappers after sessions 3-4 | none found as a catcher (conflict misread fixed in ca59c7a) | old only |
| `tools/Publish-ShelfBookBatchToShared.ps1` | Publishes or deletes a batch of curated Shelf Books under one approval. | 2 (oracle of 3 `publication.batch-*` rows) | retire | Frozen rows; kernel verb `publish batch` | none found | old only |
| `tools/Publish-ShelfBookToShared.ps1` | Publishes a curated Shelf Book to the shared collection, verifies, then deletes the local copy. | 2a (seed of 6 differential rows); also 2 (5 rows) | retire | Seed → kernel verb `publish` (session 3); rows frozen | none found | old only |
| `tools/RawBatchOwnership.ps1` | Dot-sourced: which Project owns a `raw/` batch and whether it is live. | 2a (`AcceptanceFixtures.ps1:48`); also 2 (via `Set-RawBatchOwner.ps1`) | retire | Fixture snapshots; ported in `kernel/src/rawowners.ts` / `collection.ts` | none found | old only |
| `tools/RawSearch.ps1` | Dot-sourced scoped search over one named `raw/` batch, each hit with its provenance. | 2 (via `Search-RawBatch.ps1`, `Compile-RawBatchToNotebook.ps1`) | retire | Ported as `kernel/src/rawsearch.ts`; covered by frozen `search.raw-*` rows | none found | old only |
| `tools/Remove-MemoryProject.ps1` | Deregisters and deletes a whole Basic Memory project (operator recovery). | 3 (maintainer-only; matrix harness tells you to run it for leftover disposable projects, `Invoke-AcceptanceMatrix.ps1:1026`) | port | `tools/*.ts` beside `tools/matrix.ts` for shared-row cleanup (unverified need) | none found | old only |
| `tools/Remove-NotebookQuarantine.ps1` | Destroys one reset quarantine directory and its ownership rows for good. | 5 (`excluded_helpers`: maintainer-only operator recovery) | retire | deleted with the PowerShell; no kernel verb (`reset restore` only restores) | none found | old only |
| `tools/Remove-SeatArchive.ps1` | Destroys a retired seat's archive, refusing when Notebook material would be orphaned. | 5 (`excluded_helpers`: maintainer-only) | retire | deleted with the PowerShell; no kernel verb | none found | old only |
| `tools/Remove-SharedEntry.ps1` | Permanently deletes one shared Book or Hub from Basic Memory (operator repair). | 5 (`excluded_helpers`: maintainer-only) | retire | deleted with the PowerShell | none found | old only |
| `tools/Remove-ShelfBook.ps1` | Permanently deletes one curated Shelf Book after a content-bound approval. | 2 (`shelf.remove-book-refuses-without-a-plan-id`); also 2a via `Publish-ShelfBookToShared` seeds | retire | Frozen row; kernel verb `shelf remove` | none found | old only |
| `tools/Rename-ShelfBook.ps1` | Renames a Shelf Book's slug, directory, title and live references, rollback-protected. | 2 (`shelf.rename-book-keeps-every-page`) | retire | Frozen row; kernel verb `shelf rename` | none found | old only |
| `tools/Reset-LocalNotebook.ps1` | The Library Reset: quarantines a seat's Notebook, optionally clears the Desk. | 2a (`AcceptanceFixtures.ps1:527`); also 2 (4 `reset.*` rows) | retire | Fixture snapshots (session 3); rows frozen; kernel verb `reset` | none found as a catcher (Desk-clear reversal 0ea02ba was a change in it) | old only |
| `tools/Restore-BookSource.ps1` | Rebuilds `notebook/<slug>/` from a published shared Book (operator recovery). | 5 (`excluded_helpers`: maintainer-only) | retire | deleted with the PowerShell; rewrite `notebook.ts:455,480` advice that names it | none found | old only |
| `tools/Restore-NotebookQuarantine.ps1` | Brings quarantined Notebook topics back and re-renders the index. | 2 (`reset.quarantined-material-restores`) | retire | Frozen row; kernel verb `reset restore` | none found | old only |
| `tools/Retire-Seat.ps1` | Archives a seat's Desk and metadata, then removes it from the registry. | 2a (`AcceptanceFixtures.ps1:549`); also 2 (`seat.retirement-is-gated-and-names-what-it-removes`) | retire | Fixture snapshots; row frozen; kernel verb `seat retire` | none found as a catcher (c4a8fe9 fixed faults in it) | old only |
| `tools/SearchBoundaries.ps1` | Dot-sourced shared search limits: query shape, caps, normalisation, sanitising. | 2 (via `BookRootSchema.ps1`, `RawSearch.ps1`) | retire | Ported value for value in `kernel/src/rawsearch.ts`; kept as reader-adapter closure exception | none found | old only |
| `tools/Search-RawBatch.ps1` | Searches one named `raw/` batch for a literal term and reports where it occurs. | 2 (2 `search.raw-*` rows) | retire | Frozen rows; kernel verb `raw search` | none found | old only |
| `tools/SeatConversation.ps1` | Dot-sourced: which conversation a seat last recorded and its title. | 2 (via `Get-DeskOverview.ps1`, `Add-ShelfNote.ps1`) | retire | Ported as `kernel/src/conversation.ts`; kept as reader-adapter closure exception | none found | old only |
| `tools/SeatCreation.ps1` | Dot-sourced single gate both seat-creation routes pass through. | 2 (via `Enter-LibrarySeat.ps1`) | retire | Ported in `kernel/src/seat.ts` / `seatstartplan.ts` (`seat enter --create`, `seat start`) | none found | old only |
| `tools/SeatPicker.ps1` | Dot-sourced terminal seat picker: roster, choice grammar, refusals. | 5 (no matrix row; already ported as kernel `menu`) | retire | Kernel verb `menu`; self-test section 51's parity case dot-sources it and must be dropped (session 6) | none found | old only |
| `tools/Set-CollectionOwner.ps1` | Shows, acquires or releases the collection's writable role. | 2a (seed of 16 differential rows); also independent row `publication.collection-ownership-is-acquired-and-released` | retire | Seed → kernel verb `collection owner` (two-step, session 3) | none found | old only |
| `tools/Set-NotebookTopicOwner.ps1` | Records which seat owns a Notebook topic, or declares it shared or excluded. | 5 (`excluded_helpers`: not-ported, ADR-0029 retired topic ownership) | retire | deleted with the PowerShell; rewrite advice in `doctor.ts`, `notebook.ts`, `seat.ts` | none found | old only |
| `tools/Set-RawBatchOwner.ps1` | Declares, withdraws and reports which Project owns each `raw/` batch. | 2 (`search.raw-batch-ownership-is-reported-per-batch`); also workspace check `raw.batch-owners` | retire | Frozen row; kernel verb `raw owners` | none found | old only |
| `tools/Set-ShelfBookPageStub.ps1` | Replaces one page of an open curated Book with a superseded-stub. | 2 (`shelf.page-stub-marks-a-page-as-pending`) | retire | Frozen row; kernel verb `shelf stub` | none found | old only |
| `tools/Set-TopicOverlap.ps1` | Records, lists and validates topic overlap records between Shelf Books. | 5 (`excluded_helpers`: deferred); runs in workspace check `shelf.overlap-records` | retire | deleted with the PowerShell; no kernel verb (unverified whether `checks.*` rows reach it) | none found (5e05629 made contradictions unrepresentable by key) | old only |
| `tools/Set-VirtualDesk.ps1` | Opens, closes, clears or lists Books and Projects on a seat's Desk. | 2a (seed of 3 hub rows); also 2 (8 `desk.*` rows) and 1 independent | retire | Seed → kernel verb `desk open` (session 3); rows frozen; kept as reader-adapter closure exception | none found as a catcher (218860e: case-insensitive slug check found in it) | old only |
| `tools/SharedBookSource.ps1` | Dot-sourced: reads the shared Book Catalog, page lists and bodies over MCP for manifests. | 2 (via `RawBatchOwnership.ps1`, `Restore-BookSource.ps1`) | retire | deleted with the PowerShell; no direct kernel counterpart found (unverified) | none found | old only |
| `tools/SharedCollectionFiles.ps1` | Dot-sourced filesystem view of the shared collection, for the husk defect MCP cannot see. | 2 (via `CollectionOwnership.ps1`, `Archive-*` oracles) | retire | Ported as "the husk" in `kernel/src/sharedwriters.ts` | none found | old only |
| `tools/ShelfCatalog.ps1` | Dot-sourced serialized renderer for `shelf/_catalog.md` from per-Book entry files. | 2a (`AcceptanceFixtures.ps1:46`, `Initialize-LibraryWorkspace.ps1:65`); also 2 (`shelf.catalog-renders-from-entry-files`) | retire | Fixture snapshots; row frozen; kernel verb `shelf render` | 038e39a: its self-test caught a header lookup falling back to the program's template | old only |
| `tools/ShelfNoteCommon.ps1` | Dot-sourced Shelf Book helpers: catalog lookup, Desk gate, reader maps, capture frontmatter. | 2 (via `BookRootSchema.ps1`, most writers) | retire | Ported in `kernel/src/shelfnote.ts` / `shelfbook.ts`; kept as reader-adapter closure exception | none found | old only |
| `tools/SourcesBlock.ps1` | Dot-sourced emitter and parser of a compiled article's `## Sources` block. | 2 (via `BookManifest.ps1`, `Compile-RawBatchToNotebook.ps1`) | retire | Ported in `kernel/src/manifest.ts` / `compile.ts`; kept as reader-adapter closure exception | none found as a catcher (30e9d5c fixed its parser) | old only |
| `tools/Start-LibrarySeat.ps1` | Creates or enters a seat, holds its claim, and starts the agent there. | 3 (a person runs it; already ported); independent row `seat.launcher-starts-a-harness-in-the-seat-it-named` | retire | Kernel verb `seat start`; rewrite advice in `.claude/hooks/Get-VirtualDeskContext.ps1:132` and `remedy.ts` | none found as a catcher (c4a8fe9 fixed faults in it) | old only |
| `tools/Sync-RawUpstream.ps1` | Fetches a git upstream into a new `raw/` source batch. | 5 (`excluded_helpers`: deferred) | retire | deleted with the PowerShell; no kernel verb | none found | old only |
| `tools/TriagePlanCommon.ps1` | Dot-sourced action schema for Library Triage v3. | 2 (via `Invoke-LibraryTriage.ps1`, 13 differential rows); also 3, follows triage's port | retire | Schema ported in `kernel/src/triagebatch.ts`; decide with `Invoke-LibraryTriage.ps1`'s row | none found | old only |
| `tools/Update-BookManifests.ps1` | Backfills or rebuilds every local Shelf Book's Discovery manifest, journalled. | 5 (`excluded_helpers`: not-ported backfill) | retire | Kernel verb `shelf rebuild` covers the rebuild; rewrite `shelfwriters.ts` message naming it | none found | old only |
| `tools/Update-SharedBookManifests.ps1` | Backfills or rebuilds every shared (Basic Memory) Book's Discovery manifest. | 3 (named in reader-facing text: `ownership.ts:510`, adapter `:529`); `excluded_helpers` says not-ported | port | `kernel verb collection rebuild` extended to Basic Memory, or `tools/*.ts` (unverified; today local collection only) | none found | old only |
| `tools/WorkspaceRegistry.ps1` | Dot-sourced: which workspaces exist on this machine and which one a path belongs to. | 2 (dot-sourced by nearly every oracle and guard); also 2a (`Initialize-LibraryWorkspace.ps1:61`) | retire | Ported in `kernel/src/workspace.ts` / `guards.ts`; kept as reader-adapter closure exception | none found as a catcher (4421325: its `param()` block broke a caller's `-SelfTest`) | old only |

#### Notes

**Scope.** 50 files: every `tools/*.ps1` starting M-Z, minus `Test-*`. The brief estimated about 48.

**Method.**
- Oracle status comes from each row's `powershell.steps` and `seed` scripts in `tools/acceptance-matrix.json`.
- Helpers count as oracles through dot-sourcing from those scripts (`. (Join-Path $PSScriptRoot 'X.ps1')`, plus `& (Join-Path ...)` calls). `Invoke-LibraryChecks.ps1` is excluded as a reaching root, because nearly everything is reachable through it.
- The reader-adapter closure was computed with the regexes of `releasefiles.ts` `dotSourcedTools()`. It holds 25 files: the adapter plus 24 under `tools/`. Nine of them are mine:
  - `MaintenanceBarrier`
  - `NotebookIndex`
  - `NotebookOwnership`
  - `SearchBoundaries`
  - `SeatConversation`
  - `Set-VirtualDesk`
  - `ShelfNoteCommon`
  - `SourcesBlock`
  - `WorkspaceRegistry`

  These survive session 6 as listed exceptions. Their "retire" means retiring from the development loop, not deletion.

**Surprising.**
- `PluginPackage.ps1` appears in three rows' `prepare` text only as file content ("GENERATED by tools/PluginPackage.ps1"). It is not an oracle. Its real role is the build: `Build-KernelRelease.ps1:242` runs it. So it is class 3, not 2.
- Two of my files are dot-sourced by `AcceptanceFixtures.ps1:47-48` but are missing from the plan's 2a list:
  - `NotebookOwnership.ps1`: its `Set-NotebookTopicOwner` function seeds topics at `:438`.
  - `RawBatchOwnership.ps1`.
- `Initialize-LibraryWorkspace.ps1` dot-sources `WorkspaceRegistry`, `ShelfCatalog` and `NotebookIndex` (`:61-66`). Any rebuild of a fixture needs them until session 3's snapshots exist.
- `Publish-SharedBookCandidate.ps1` and `Remove-ShelfBook.ps1` are reached by seeds, not named in them:
  - `Publish-BookCopy.ps1:38` calls the candidate.
  - `Publish-ShelfBookToShared.ps1:63-64` calls `Publish-BookCopy` and `Remove-ShelfBook`.

  Session 3's seed-equality proof covers them implicitly.
- ca59c7a fixed "two oracle defects" in `New-ProjectHub` and `Publish-SharedBookCandidate`, among others: lost non-ASCII text, and a no-overwrite conflict that was misread. That is a reminder that the freeze records the oracle's behaviour at the freeze commit, defects included.
- `Set-TopicOverlap.ps1` (`shelf.overlap-records`) and `Set-RawBatchOwner.ps1` (`raw.batch-owners`) run inside the workspace checks. The seven `checks.*` differential rows run `Invoke-LibraryChecks.ps1 -WorkspaceOnly`, so those rows may reach them indirectly. Unverified which checks those rows compare.
- Kernel advice strings name these files. Session 6 must re-point them:
  - `Move-LibraryFolder`: `seatclaim.ts:653-662`
  - `Restore-BookSource`: `notebook.ts:455,480`
  - `Set-NotebookTopicOwner`: `doctor.ts`, `notebook.ts`, `seat.ts`
  - `Update-SharedBookManifests`: `ownership.ts:510`
  - `Update-BookManifests`: `shelfwriters.ts`
  - `Start-LibrarySeat` / `Set-VirtualDesk` / `Retire-Seat`: `remedy.ts`, plus `.claude/hooks/ShelfBoundary.ps1:65-67` and `Get-VirtualDeskContext.ps1:132`
- Self-test sections that open my files:
  - Section 51 dot-sources `SeatPicker.ps1` (`selftest.ts:4990`).
  - Section 162 reads `PublicTreeAllowlist.ps1` (`selftest.ts:14389`).
  - Section 14 cites `ShelfNoteCommon` / `WorkspaceRegistry` in comments only.
- Gate checks that run a file's own `-SelfTest`. These are class 1 checks for the checks inventory, not rows here:
  - `notebook-index.selftest`
  - `shelf-catalog.selftest`
  - `sources-block.selftest`
  - `mcp-directory-listing.selftest`
  - `raw-search.selftest`
  - `mcp-tool-inventory.selftest`
  - `raw-batch-ownership.selftest`
  - `workspace-registry.selftest`
  - `new-project-hub.selftest`
  - `remove-shared-entry.selftest`
  - `remove-memory-project.selftest`
  - `shared-collection-files.selftest`
  - `hub-migration-snapshot.selftest`
  - `plugin.generated-files-match`

**Uncertain class calls.**
- `Update-SharedBookManifests.ps1`. The matrix's `excluded_helpers` says not-ported. But reader-facing text names it, so I called it class 3 / port. It could equally retire, with those strings rewritten. Eric's call on whether the Basic Memory shared backend still needs a backfill.
- `Remove-MemoryProject.ps1`. Called port only because the matrix harness tells you to run it for orphaned disposable projects. If `tools/matrix.ts` cleans up its own projects, it retires.
- `PluginPackage.ps1`. Port is certain for the Windows hook render inside the build. Whether `-Write` and the generated-files check also need a TS home is undecided.
- `Publish-BookCopy.ps1`. The kernel verb that writes the same seed precondition (`publish refresh`, or `publish` with a copy) is unverified.
- `SharedBookSource.ps1`. No kernel file names it. I did not verify whether `bmsource.ts` or `sharedwriters.ts` covers its MCP catalog reads.
- Operator-recovery tools (`Remove-NotebookQuarantine`, `Remove-SeatArchive`, `Remove-SharedEntry`, `Restore-BookSource`, `Move-LibraryFolder`). They are marked retire under rule 5, as maintainer-only and without kernel verbs. If a person still runs them, they are class 3 instead.

**Line counts (`wc -l`).**

| File | Lines | File | Lines |
| --- | ---: | --- | ---: |
| MaintenanceBarrier | 257 | Restore-NotebookQuarantine | 573 |
| ManifestJournal | 89 | Retire-Seat | 236 |
| McpDirectoryListing | 224 | SearchBoundaries | 344 |
| McpToolInventory | 499 | Search-RawBatch | 91 |
| Move-LibraryFolder | 1182 | SeatConversation | 535 |
| New-HubMigrationSnapshot | 761 | SeatCreation | 342 |
| New-ProjectHub | 384 | SeatPicker | 1407 |
| New-ShelfBook | 202 | Set-CollectionOwner | 194 |
| NotebookIndex | 562 | Set-NotebookTopicOwner | 171 |
| NotebookOwnership | 1319 | Set-RawBatchOwner | 176 |
| PluginPackage | 956 | Set-ShelfBookPageStub | 259 |
| PublicTreeAllowlist | 247 | Set-TopicOverlap | 397 |
| Publish-BookCopy | 149 | Set-VirtualDesk | 176 |
| Publish-SharedBookCandidate | 452 | SharedBookSource | 422 |
| Publish-ShelfBookBatchToShared | 168 | SharedCollectionFiles | 337 |
| Publish-ShelfBookToShared | 157 | ShelfCatalog | 787 |
| RawBatchOwnership | 1174 | ShelfNoteCommon | 632 |
| RawSearch | 1039 | SourcesBlock | 937 |
| Remove-MemoryProject | 320 | Start-LibrarySeat | 629 |
| Remove-NotebookQuarantine | 279 | Sync-RawUpstream | 210 |
| Remove-SeatArchive | 263 | TriagePlanCommon | 669 |
| Remove-SharedEntry | 421 | Update-BookManifests | 449 |
| Remove-ShelfBook | 360 | Update-SharedBookManifests | 482 |
| Rename-ShelfBook | 435 | WorkspaceRegistry | 918 |
| Reset-LocalNotebook | 725 | Restore-BookSource | 454 |

Total: 24,451 lines across 50 files.

## 3. `tools/Test-*.ps1` and `tools/Invoke-*.ps1`

### Draft rows: `tools/Test-*.ps1` and `tools/Invoke-*.ps1` (`master` at `1bd14ec`)

Drafted 2026-10-09 from a read-only copy. "Section N" means `selected(N)` in `kernel/test/selftest.ts`; `[d]`/`[i]` after a row id means differential/independent in `tools/acceptance-matrix.json`. "Gate check" names the `Invoke-LibraryChecks.ps1` check that runs the file.

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `tools/Test-AllowlistRuleParity.ps1` | Runs 8 fixture cases through `DeploymentScan.ps1`'s allowlist rule and the mirror job's shell scanner (taken from `docs/mirror-publishing-job.md`), and pins where they disagree (2 cases). Gate check `mirror-job.allowlist-rule-parity`. | 4 (it tests a class 3 tool being ported: `DeploymentScan` becomes `tools/scan.ts`) | port some cases | the 8-case table, run as a test of `tools/scan.ts` against the server block (session 1, step 6) | none found (1 commit) | old only |
| `tools/Test-ArchiveSearchCoverage.ps1` | ADR-0012 suite: archiving a Shelf Book moves its manifest to the archive store, Discovery still finds it, labels it and counts it; currency says archives are out of scope. Gate check `archive.search-coverage`. | 4 | port some cases | Port: "Discovery covers, labels and counts an archived Book" and "same-slug active and archived Books keep separate manifests" (kernel `discovery.ts` does this; no section or row asserts it). Manifest move: `shelf.archive-*` [d] rows' effects (unverified). Currency case: retire (`Get-BookCurrency` deferred). | its header: archiving used to retire the manifest, so a Book left search while Discovery said "all N searched" | old only |
| `tools/Test-BookCurrencyShelfPath.ps1` | Tests `Get-BookCurrency.ps1 -Book` on a Shelf Book: Desk gate per seat, front-matter exclusion, source order. Gate check `book-currency.shelf-path`. | 4 | retire | deleted with the PowerShell (`Get-BookCurrency.ps1` is `deferred` in `excluded_helpers`; the kernel has no currency verb) | its header: the Desk guard once read a missing file, so every open Shelf Book was refused as closed | old only |
| `tools/Test-BuiltRelease.ps1` | Runs the four release fixtures against one built release folder, each in its own `powershell.exe`, with the machine's Deskpost blanked. Gate check `release.fixtures-all-run` holds its list. | 3 | port | `tools/test-built-release.ts` (session 5, step 2); self-test section 91 reads this file (`selftest.ts:8251`) and must be re-pointed | its header: S57 built 1.2 without running `Test-KernelUpgrade`, which then failed at its first install (`c61fc74`); `f262847` (the fixture had never run the release's own installer) | old only |
| `tools/Test-CodexPortability.ps1` | Renders Codex bindings with `Initialize-CodexLibrary.ps1` into a fixture and checks them: idempotent, `required = true` reader, absolute hook paths, guard denies. Gate check `codex.portability-selftest`; PowerShell arm of `harness.codex-refuses-a-shell-read-of-a-closed-book` [i]. | 4 | retire | deleted with the PowerShell (`Initialize-CodexLibrary.ps1` is `maintainer-only`); kernel Codex checks: `checks.a-codex-*` [d] rows, sections 36, 47; the harness row keeps its recorded verdict | `7a3fd4e` (Codex spells `mcp__basic_memory__`; the guard matcher missed it) (unverified that this suite was the one red) | old only |
| `tools/Test-HubMigrationAcceptance.ps1` | Checks a one-time Hub migration snapshot against its manifest (open items, invariant sections, preamble). Gate check `hub-migration-acceptance.selftest`. | 4 (and 5) | retire | deleted with the PowerShell (`not-ported` in `excluded_helpers`); also drop its allow entry in `.claude/settings.json:33` | none found | old only |
| `tools/Test-InstallLifecycle.ps1` | Built-release fixture: install release A, upgrade in place to B, rollback, uninstall through the finisher; hooks byte for byte, doctor green, a reader's own hook kept. | 4 (release fixture) | port some cases | `tools/test-built-release.ts`: the two-release upgrade (hooks byte for byte, doctor green) and rollback. Uninstall and finisher cases: sections 50, 110, 116 (unverified) | `f262847` (the fixture fell back to the checkout's installer, not the release's) | old only |
| `tools/Test-InstallOnboarding.ps1` | Built-release fixture: the installer's faults (`DESKPOST_INSTALL_FAULT_AFTER`), resume, undo, live and dead owners, a non-empty program folder. | 4 (release fixture) | port some cases | `tools/test-built-release.ts`: the forwarder's fetch and hash check and a cross-volume install against the real archive. Fault, owner and resume cases: sections 129, 132 (unverified case by case) | `3ddc523` (S58 inspection: fixtures did not restore what they changed) | old only |
| `tools/Test-InstallProof.ps1` | Built-release fixture against the published 1.0.0: upgrade from a real 1.0.0 install, live seat refusals, finisher failed and cancel paths, legacy adoption of `versions\1.0.0`. | 4 (release fixture) | port some cases | `tools/test-built-release.ts`: the upgrade from a real 1.0.0 Library. Adoption and finisher paths: sections 50, 116, 148 (unverified). See Notes: 1.0.0's own `install.ps1` is PowerShell. | `ca4b5fe` (written for S54's open #12 items); `lifecycle.ts:274` pins its wording | old only |
| `tools/Test-KernelUpgrade.ps1` | Built-release fixture: install A, init through the shim, upgrade to a re-versioned B, rollback, delete `versions\A`; every program path in the Library names `current` and exists. | 4 (release fixture) | port some cases | `tools/test-built-release.ts` (the plan names it). Drop `-PlantDefect`, which runs the PowerShell initialiser. Overlap: sections 9, 109, 110, 144 | its header: before S30 every upgrade moved the program root and broke the Library's hooks (ADR-0038); `c61fc74` | old only |
| `tools/Test-LibraryFolderMove.ps1` | Tests the maintenance barrier and `Move-LibraryFolder.ps1`'s cutover in 12 sections: barrier states, refusals, preflight, pointer rewrite, move, rollback. Gate check `maintenance.folder-move`. | 4 | port some cases | Port sections 1 to 3: the barrier's states, the fail-closed read of a damaged record, and seat entry and claim-gated writes refused. The kernel enforces this (`seatclaim.ts:638`, `seat.ts:865,1261`), but no section or row covers it. Sections 4 to 12 go with the mover (`maintainer-only`). | none found | old only |
| `tools/Test-LibraryHelpers.ps1` | Boundary suite (584 assertions) for about 20 local helpers: Desk, reset, compile, triage, publish copy, Shelf writers, wiki import, currency, restore source, plus the gate's defect-family detectors. Gate check `library-helpers.boundary-suite`. | 4 (part 1: lines 1810-1980 test the gate's detectors) | retire | `desk.*`, `reset.*`, `compile.*`, `triage.*`, `shelf.*`, `capture.*`, `publication.*` [d] rows; sections 29, 31, 33 (rows `concurrency.two-writers-one-book-lock`, `recovery.an-interrupted-write…`, `triage.batch-resumes…` cite it); the rest test non-ported helpers (unverified case by case) | `af00fd3` (found five gate detectors had silently become unfalsifiable); `d984f43` | old only |
| `tools/Test-LibraryHooks.ps1` | Runs every `.claude/hooks/*.ps1` hook as a real process on real payloads and reads the JSON it returns. Gate check `library-hooks.boundary-suite`; PowerShell arm of two `harness.*` [i] rows. | 4 | retire | deleted with the PowerShell hooks; the kernel hook verbs: `guards.*` [d] rows (about 60), sections 11, 12, 16, 18, 111-114 | `7a3fd4e` ("Test-LibraryHooks.ps1: 2 of 4 red without the fix", the Codex matcher); `19519b3` (three silent allows) | old only |
| `tools/Test-ManifestBackfill.ps1` | 19 cases for `Update-BookManifests.ps1`: generations, rebuild, resume journal, prune, leak canary, approval and `plan_id`. Gate check `shelf.manifest-backfill`. | 4 | retire | deleted with the PowerShell (`Update-BookManifests.ps1` is `not-ported`); the kernel's repair is `shelf rebuild`, section 127 | `18a9d25` (written with the backfill) | old only |
| `tools/Test-McpHelpers.ps1` | Runs the shared-collection writers against a loopback stub MCP endpoint: publish, archive, Hub edit, copy to project, catalog entry, triage project kind. Gate check `mcp-helpers.boundary-suite`. | 4 | port some cases | Port: a no-overwrite create that loses a race (`action: conflict`, `NOTE_ALREADY_EXISTS`) must refuse. The kernel handles it (`basicmemory.ts:401`, `sharedwriters.ts:252,545`), but no section asserts it. Rest: `publication.*` and `hub.*` [d] shared rows, section 13 | `basicmemory.ts:17-18` (`New-ProjectHub` reported `created` over another writer's Hub); `ca59c7a` (two oracle defects) | old only |
| `tools/Test-NotebookMigration.ps1` | Judges `library migrate` (ADR-0029) over every legacy state, interrupted at every step, driving the kernel under test (`-Kernel`). Gate check `notebook.migration`. | 4, and the judge of two independent rows | port | the `judge` of `reset.topic-ownership-is-retired-by-adr-0029` [i] and `recovery.migration-refuses-activation-…` [i]; nothing else tests `migrate` (no section). Needs a frozen legacy fixture (`workspace-legacy-notebook` is built by PowerShell writers). | `de4c0d5` (made the judge of both migration rows) | old only |
| `tools/Test-NotebookRenderLock.ps1` | Proves with real processes that the Notebook render lock is narrow: existing-topic writes do not take it, visibility changes do. Gate check `notebook.render-lock-narrow`. | 4 | port some cases | Port "a compile into an existing topic completes while the render lock is held" (section 30 proves exclusion only, not narrowness). The rest: section 30 / `concurrency.notebook-mutation-lock-…` [i] | none found; it guards a widened lock, which "breaks no test" (its header) | old only |
| `tools/Test-NotebookSweep.ps1` | Tests `Reset-LocalNotebook.ps1 -AllIdleSeats`: which seats' topics a sweep takes or leaves, its preflight, and its digest. Gate check `notebook.idle-seat-sweep`. | 4 | retire | deleted with the PowerShell; the kernel refuses `--all-idle-seats` by name (`verbs.ts:641-642`, `notebook.ts:709`) | none found | old only |
| `tools/Test-RecoveryRoutes.ps1` | Tests the four recovery routes: quarantine restore and purge, Desk restore from a seat archive, the seat-archive purge, and the quarantine roster's dating. Gate check `recovery.routes`. | 4 | port some cases | Port section 11: undated quarantines (missing or corrupt journal) are dated from the folder name and never sorted oldest. That is the kernel's `desk.ts:194-213`, which says no Desk row runs over a quarantine; section 202 uses good journals only. Sections 1-7: `reset.quarantined-material-restores` [d] (unverified for 6b-7). Sections 8-10: helpers `maintainer-only` or refused (`seat.ts:1270`). | `desk.ts:194-198` (three dating defects no row could see) | old only |
| `tools/Test-SeatLifecycle.ps1` | Drives the real launcher, `Enter-LibrarySeat` and `Retire-Seat` (126+ assertions): creation, project binding, claims, retirement plan, seat resolution, conversation history. Gate check `seat.lifecycle`. | 4 | port some cases | Port case 13's binding-versus-`LIBRARY_SEAT` disagreement refusal (`seatdesk.ts:302-312`; no section or row has it). Rest: `seat.*` rows, sections 24-27, 76-79, 93-95, 156-157, 187-192 (unverified case by case) | `c4a8fe9` (first run found three faults, among them `-Preflight` promising a launch on a live claim) | old only |
| `tools/Test-SharedManifestBackfill.ps1` | 35 cases for `Update-SharedBookManifests.ps1` against a stub endpoint: approval, truncated or substituted reads, resume, prune, archive roster. Gate check `shared.manifest-backfill`. | 4 | retire | deleted with the PowerShell (`not-ported`; the kernel says it "has no command that builds shared-collection manifests", a `delta` phrase in the matrix) | `fb2772f`, `ac64751` (written with the shared Discovery store and archive) | old only |
| `tools/Test-ShelfNoteBoundary.ps1` | 64 cases for capture Books: capture never gated, holding-sourced triage gated on the Book being open, slug rules, the Desk's capture reporting. Gate check `shelf-note.boundary-suite`. | 4 | retire | `capture.*`, `triage.*` [d] rows; sections 34, 40, 69, 82-88; it pins the oracle half of `triage.batch-carries-more-than-one-notebook-action` and `capture.a-note-is-named-by-the-local-date` (unverified: the closed gate for each holding-sourced kind) | `d984f43` (unverified that this suite was the one red) | old only |
| `tools/Test-ShelfWriterRouting.ps1` | 26 cases: a static scan of which helpers open manifest mutation windows, then real Shelf writers each committing a Discovery manifest generation. Gate check `shelf.writers-route-manifests`. | 4 (part 1: the static scan of PowerShell) | port some cases | Port the failure-path cases: a note that landed stays landed when its manifest cannot commit, and a failure mid-mutation leaves the Book dirty (unverified that the kernel has a seam for this). Happy paths: effects of `capture.*`, `shelf.*` [d] rows (every workspace file is compared) and section 59 | `678b1b8` (reports the lock failure a manifest updater hit) (unverified) | old only |
| `tools/Test-TwoSeatAcceptance.ps1` | Two seats, real processes: a Book open at one seat is closed at the other for reads and search, guards agree with the reader, and a rename rewrites every seat. Gate check `desk.two-seat-acceptance`; the gate also holds `docs/seats.md` to its sections. | 4 | port some cases | Port "a rename rewrites every seat's Desk that holds the Book" (`shelfwriters.ts:267`; the rename row's fixture `workspace-shelf` has one seat) (unverified). Rest: `desk.*`, `guards.*`, `reader.*` rows on `workspace-two-seat`, section 11 | `b340a63` (notebook/ writes took no claim; unverified that this suite was the one red) | old only |
| `tools/Test-VaultExport.ps1` | The 5 cases for `Export-CollectionToVault.ps1` (fresh, unchanged, edited destination, resume, removed page), dot-sourced by its `-SelfTest`. | 4 | retire | deleted with the PowerShell (`Export-CollectionToVault.ps1` is `maintainer-only`, a one-time export) | none found (1 commit) | old only |
| `tools/Invoke-AcceptanceMatrix.ps1` | The differential matrix runner: builds fixtures, runs seeds in both arms (`:745-750`), runs both arms, normalises and compares; `-SelfTest` is gate check `acceptance.harness-selftest`. | 2 (and 2a) | retire | session 4's frozen matrix runner, `tools/matrix.ts` (session 3 proves its parts equal; freeze command `:55-64`) | `19519b3` (sent a byte-order mark to every step's stdin, turning a row red); `de4c0d5` (independent rows could never be green) | old only |
| `tools/Invoke-LibraryChecks.ps1` | The commit gate: 132 registered checks plus `kernel.selftest`; also the PowerShell arm of 7 differential rows (`checks.*`, `workspace.init-leaves-a-workspace-its-checks-pass`). | 3 (and 2) | port | `tools/gate.ts` (sessions 1-2; one inventory row per check); its differential rows freeze in session 4; it stays callable until the release after session 5 | `af00fd3` (the full gate caught a half-done split); `e9f82f9` | old only |
| `tools/Invoke-LibraryTriage.ps1` | The PowerShell triage planner and batch runner (inventory, plan, batch, resume); the oracle of about 15 `triage.*` [d] rows. | 2 (and 3) | port some cases | kernel verb `triage` (`triagebatch.ts` already ports the batch); port the still-needed kinds the kernel refuses (`project`, a new shared Book, `-PlanPath`: `triagebatch.ts:245,524-526,828`); also `doctor.ts:647-652` reads its default | `5ab118e` (unverified) | old only |
| `tools/Invoke-SeatClaimHolder.ps1` | A background process that holds one seat's claim handle while its agent lives; spawned by `LibrarySeat.ps1`'s `Start-SeatClaimHolder`, never run by hand. | 2 | retire | kernel `seat.ts` `startSeatClaimHolder` (already ported); retire after the freeze of `seat.enter-an-existing-free-seat` and `seat.desk-context-records-…` [d], whose PowerShell arm (`Enter-LibrarySeat.ps1`) spawns it | none found (1 commit) | old only |

#### Notes

- **There are 29 files, not 28:** 25 `Test-*` and 4 `Invoke-*`. `d2efcf1` has the same 29, so the plan's "24 `Test-*` suites" undercounts by one.
- **Most suites test PowerShell helpers, not the kernel.** Only `Test-NotebookMigration` (and the four release fixtures through the built binary) drive the kernel. A port therefore means a new kernel-side case, not a translation. I kept "port some cases" for gaps I confirmed by grep: no hit in `selftest.ts` and none in `acceptance-matrix.json`. These are:
  - the maintenance barrier;
  - Discovery counting archived Books;
  - the render lock's narrowness;
  - the dating fallback for quarantines with no readable journal;
  - the binding-versus-environment refusal;
  - the Basic Memory `conflict` answer.
- **Test-NotebookMigration is the live judge** of two independent rows (`"judge": ["powershell.exe", … "tools/Test-NotebookMigration.ps1", "-Kernel", "{kernel}"]`). Neither row can stay green without PowerShell until it is ported. Its input fixture is built by legacy PowerShell writers, so the port needs that fixture frozen (session 3).
- **Five suites appear in `harness.*` rows' PowerShell steps or in rows' reasons:** `Test-LibraryHooks`, `Test-CodexPortability`, `Test-SeatLifecycle`, `Test-ShelfNoteBoundary` and `Test-RecoveryRoutes`. The harness rows are `recorded_verdict`, and the kernel steps are `selftest hooks` / `selftest codex-hooks`. When a suite is retired, those rows need their PowerShell steps and reasons rewritten, not just deleted.
- **Test-InstallProof needs PowerShell for one case.** It installs the published 1.0.0 with 1.0.0's own `install.ps1`, which is PowerShell. A TypeScript port either keeps one `powershell.exe` call against a downloaded legacy installer or freezes a 1.0.0 install as a snapshot. This is undecided.
- **Install fixtures and the forwarder.** Since 1.3.5, `install.ps1` forwards to `library.exe install` (`install.ps1:3`), so the install fixtures' fault and resume cases now exercise kernel code that sections 129 and 132 also drive. The remaining value is running against a real built archive.
- **Things that point at these files outside `tools/`:**
  - `.claude/settings.json:32,33,55` allows `Invoke-LibraryChecks`, `Test-HubMigrationAcceptance` and `Invoke-LibraryTriage`.
  - `.githooks/pre-commit` names `Invoke-LibraryChecks` and `Test-BuiltRelease`.
  - `selftest.ts:8251-8257` (section 91) reads `Test-BuiltRelease` and `Test-InstallLifecycle`.
  - `kernel/src/lifecycle.ts:274,836`, `migrate.ts:6`, `verbs.ts:542`, `basicmemory.ts:18` and `seat.ts:4` cite suites in comments.
  - `kernel/package.json` and `kernel/src/cli.ts` mention `Invoke-AcceptanceMatrix`.
- **Uncertain class calls:**
  - `Test-AllowlistRuleParity` could be read as class 1 (allowlist parity). I made it class 4 because the tool it tests moves to `tools/scan.ts` rather than retiring.
  - `Invoke-LibraryTriage` is both the oracle (2) and a tool someone runs (3). I put 2 first because its rows freeze before it can go.
  - `Invoke-SeatClaimHolder` may be reached from `LibrarySeat.ps1` if that file stays in the reader adapter's closure; a spawn is not a dot-source, so the closure resolver would not list it (unverified).
- **Line counts (`wc -l`):**

  | File | Lines |
  | --- | ---: |
  | AllowlistRuleParity | 255 |
  | ArchiveSearchCoverage | 303 |
  | BookCurrencyShelfPath | 422 |
  | BuiltRelease | 104 |
  | CodexPortability | 157 |
  | HubMigrationAcceptance | 296 |
  | InstallLifecycle | 102 |
  | InstallOnboarding | 129 |
  | InstallProof | 165 |
  | KernelUpgrade | 255 |
  | LibraryFolderMove | 566 |
  | LibraryHelpers | 2,294 |
  | LibraryHooks | 1,297 |
  | ManifestBackfill | 553 |
  | McpHelpers | 1,341 |
  | NotebookMigration | 298 |
  | NotebookRenderLock | 339 |
  | NotebookSweep | 514 |
  | RecoveryRoutes | 992 |
  | SeatLifecycle | 3,790 |
  | SharedManifestBackfill | 998 |
  | ShelfNoteBoundary | 632 |
  | ShelfWriterRouting | 618 |
  | TwoSeatAcceptance | 663 |
  | VaultExport | 345 |
  | Invoke-AcceptanceMatrix | 1,865 |
  | Invoke-LibraryChecks | 6,838 |
  | Invoke-LibraryTriage | 1,065 |
  | Invoke-SeatClaimHolder | 113 |
  | **Total** | **27,309** |

## 4. The checks registered in `Invoke-LibraryChecks.ps1`

### Draft rows: checks registered in `tools/Invoke-LibraryChecks.ps1` (master `1bd14ec`)

Counted by registration: every line that begins `Invoke-Check '<name>'` or `Invoke-WorkspaceCheck '<name>'` (the two
invokers `$script:CheckInvokerNames` declares, line 223). That gives **132**: 67 above `if ($Fast)` (they run in both
modes), 61 in its `else` branch (lines 5676-6517, every one named in the `-Fast` roster at line 5668, so **61 skipped
under `-Fast`**), and 4 inside `if ($IncludeShared)` (lines 6519-6797, skipped in both modes unless `-IncludeShared`).
The wrapper's own call at line 246 and the deliberate decoy in a comment near line 5681 are not registrations.

Tier: the plan's tier (Session 1 item 2) for a check that goes to `tools/gate.ts`; `none` for a check retired with
the PowerShell. "Where it goes" for a suite that runs a `.ps1` file follows that file's own inventory row; the self-test
sections named here are matched by section title only and marked `(unverified)`.

| File or check | What it does | Class | Tier | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `settings.parse` | Parses the program's `.claude/settings.json` and `settings.local.json` as JSON. | 5 (program config) | commit | port | `tools/gate.ts` | none found (introduced `df8a0fa`) | old only |
| `settings.hooks-registered` | Checks the program's settings register each required hook under the right event, from `tools/HookRegistry.ps1`. | 1 (reads PowerShell registry); kernel has `hookregistry.ts` | commit | port | `tools/gate.ts`, re-derived from `kernel/src/hookregistry.ts` (unverified that the program settings still need it) | A guard moved from PreToolUse to PostToolUse still "appears" (comment); `a5a6856` | old only |
| `workspace.guards-registered` | Checks the reader's workspace registers its guards, their paths exist, and the reader server is declared. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1387`); self-test section 20 (unverified) | S14: a split workspace nobody was guarded in, unreported by 121 checks (comment); `ebe0711` | old only |
| `workspace.codex-guards-registered` | Same questions for the workspace's Codex hooks, plus trust and hook review (warns). | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1388`) | S49: unreviewed Codex hooks skipped silently; `5c24807` | old only |
| `codex.project-access-config` | Checks `.codex/` templates and generated config exist, register the guards, and name files that exist. | 5 (program config) | commit | port | `tools/gate.ts` | S21's version named five files and opened none, passing four sessions (comment at line 5566); `e75db29` | old only |
| `codex.delegation-runs-hooks` | Checks the documented `codex exec` recipe keeps `--dangerously-bypass-hook-trust`, plus a fixture half. | 5 (document check) | commit | port some cases | `tools/gate.ts` (document half, already in `tools/docs-gate.ts`) | A delegate without the flag runs with no guard, measured 2026-09-08 (comment) | old only |
| `powershell.dot-sourced-files-declare-no-parameters` | AST scan: no dot-sourced `.ps1` declares a `param()` block. | 1 | none | retire | deleted with the PowerShell | `McpDirectoryListing.ps1` param block binding in callers; `4421325` | old only |
| `powershell.defect-families` | AST scan of every `.ps1` for the recorded PowerShell defect families (unrolling, strict-mode reads, parameter reassignment). | 1 | none | retire | deleted with the PowerShell | Families in `.claude/rules/library-development.md`; `b32e169` | old only |
| `mcp.transports-recover-sessions` | Scans each PowerShell MCP transport copy for expired-session recovery. | 1 | none | retire | deleted with the PowerShell | Ten transport copies had no recovery (comment); `991b02f` | old only |
| `mcp.transports-guard-idless-events` | Scans PowerShell MCP transports for guarded `.id` reads on id-less SSE frames. | 1 | none | retire | deleted with the PowerShell | Nine copies threw on an id-less frame, reproduced 2026-09-03; `94f2564` | old only |
| `reader.launch-validation` | Runs the reader adapter's `-LaunchSelfTest` and a live launch with empty stdin. | 4 (adapter test) | push (unverified) | port some cases | kept with the reader-adapter exception's tests (plan session 6 item 3) (unverified) | Wrong default `$StateDirectory`, validator inert a whole phase (comment) | old only |
| `helpers.manifest-matches-allowlist` | Checks `tools/_helpers.json` lists exactly the `.ps1` files on disk and matches the settings allowlist. | 1 | none | retire | deleted with the PowerShell | Recovery helpers missing from the allowlist; `04a3329` | old only |
| `shelf.overlap-records` | Validates the workspace's topic-overlap records through `Set-TopicOverlap.ps1 -Action Validate`. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1389`) | none found | old only |
| `raw.batch-owners` | Validates raw batch ownership records through `Set-RawBatchOwner.ps1 -Action Validate`. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1390`) | none found | old only |
| `desk.seat-paths-resolve` | AST scan: no `.ps1` composes a Desk filename path except the schema file. | 1 | none | retire | deleted with the PowerShell | An earlier scan missed `.claude/.open-books` forms; 19 sites migrated (comment) | old only |
| `desk.claim-coverage` | AST scan: the declared claim-gated PowerShell helpers call `Assert-SeatClaimHeld`. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `maintenance.barrier-coverage` | AST scan: PowerShell launchers and writers check the maintenance barrier; pins who raises one. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `desk.registry-lock-coverage` | AST scan plus a PowerShell fixture: registry-lock-guarded functions assert the lock. | 1 | none | retire | deleted with the PowerShell | Cross-seat Desk scans without the registry lock; `5772887` | old only |
| `desk.topic-lock-coverage` | AST scan plus a PowerShell fixture: topic-owner writes assert the topic lock. | 1 | none | retire | deleted with the PowerShell | Ownership changed outside a topic's lock; `e441823` | old only |
| `desk.lock-order` | AST scan: PowerShell lock acquisitions follow the declared order. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `desk.book-root-schema` | AST/text scan: only `BookRootSchema.ps1` defines the Book-root shape; no source composes page paths. | 1 | none | retire | deleted with the PowerShell | A composed `books/$($entry.slug)/wiki` slipped an earlier pattern (comment) | old only |
| `shelf.references-resolve` | Checks Shelf paths named in the workspace catalog and notes resolve. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1391`) | none found | old only |
| `seat.resolution-contract` | Checks the PowerShell seat resolver's state matrix and that every call site passes the state directory. | 1 | none | retire | deleted with the PowerShell | A resolver circle hit live 2026-09-15 running `Set-NotebookTopicOwner.ps1` (comment) | old only |
| `seat.creation-gate` | AST scan: only declared PowerShell routes create seats, each calling `Assert-NewSeatIsCreatable`. | 1 | none | retire | deleted with the PowerShell | 2026-09-10: the launcher created an empty Desk where `Enter-LibrarySeat.ps1` did not (comment) | old only |
| `desk.seat-retirement-identity` | Fixture half drives `Get-NotebookResetTargets`; live half reads this workspace's seat registry. | 5 (workspace health) and 1 | none | retire | kernel verb `doctor` (`doctor.ts:1392`) | none found | old only |
| `seats.session-start-section-resolves` | Checks headings the seat-start hook serves resolve in `docs/seats.md`, bounded, carrying the ask. | 5 (document check) | commit | port | `tools/gate.ts`, headings read from `kernel/src/hookseatstart.ts:56` | none found | old only |
| `seats.contract-table-matches-code` | Checks the `docs/seats.md` contract table matches `SeatCreation.ps1` declarations and cites registered checks. | 1 | none | retire | deleted with the PowerShell (unverified: the table may need a kernel-side rewrite) | Two checks broke when a second invoker was added (comment line 217) | old only |
| `seats.two-seat-row-matches-suite` | Checks the `docs/seats.md` two-seat row matches `Test-TwoSeatAcceptance.ps1` section headers. | 1 | none | retire | deleted with the PowerShell, with that suite | none found | old only |
| `context.seat-vocabulary` | Checks seat terms declared in `LibrarySeat.ps1` each have a `CONTEXT.md` glossary entry. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `gate.children-meet-ended-input` | Checks a child the gate starts finds stdin redirected. | 1 (the PowerShell runner's relaunch) | none | retire | `tools/gate.ts` is headless by construction (plan item 1) | S44: the full gate hung at a console on a fresh clone; `ccbf756` | old only |
| `context.always-on-budget` | Counts always-on instruction words (CLAUDE.md, AGENTS.md) against a budget. | 5 (document check) | commit | port | `tools/gate.ts` (already in `tools/docs-gate.ts:206`); compare self-test section 101 | CLAUDE.md passed its line unwarned (comment at line 203) | old only |
| `docs.links-resolve` | Checks relative links in `docs/` resolve. | 5 (document check) | commit | port | `tools/gate.ts` (already in `tools/docs-gate.ts:266`) | none found | old only |
| `docs.adr-index-is-complete` | Checks the ADR index lists every ADR and no deleted one. | 5 (document check) | commit | port | `tools/gate.ts` (already in `tools/docs-gate.ts:284`) | ADR-0022 to 0024 committed with no index line (comment) | old only |
| `skill.library-help-pointers-resolve` | Checks the library-help Skill's links, reference files and guide list match, both ways. | 5 (document check) | commit | port | `tools/gate.ts` (third half already in `tools/docs-gate.ts`) | none found | old only |
| `git.pre-commit-installed` | Checks `.githooks/pre-commit` exists and `core.hooksPath` is `.githooks`. | 5 (repository config) | commit | port | `tools/gate.ts` | none found | old only |
| `retrieval.hit-is-a-location` | Checks every retrieval tier's render and three documents carry the "a hit is a location" rule. | 1 (render half) and document half | commit | port some cases | `tools/gate.ts` (document half, in `tools/docs-gate.ts`); render half to kernel discovery sections (unverified) | `book-discovery` asserted nothing about its closing line (comment) | old only |
| `reset.vocabulary-routes` | Checks documents route "reset" to the Library Reset and drives the reset helper's Git disclaimer. | 4 (helper half) and document half | commit | port some cases | `tools/gate.ts` (document half, in `tools/docs-gate.ts`); helper half to a kernel `reset` section (unverified) | 2026-08-23: "reset my workspace" read as a Git cleanup (comment) | old only |
| `hub.briefing-regex-mirror` | AST compare: briefing regexes in `New-ProjectHub.ps1` and the reader adapter are identical. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `hub.sections-name-their-destinations` | Checks the Hub's Now seed in `New-ProjectHub.ps1` names every destination the design record defines. | 1 (seed lives in PowerShell) | none | retire | deleted with the PowerShell; kernel Hub seed may need its own check (unverified) | none found | old only |
| `hub.dev-template-seeds-sections` | Checks the dev Hub template in `New-ProjectHub.ps1` matches the design record and ADR-0003. | 1 (seed lives in PowerShell) | none | retire | deleted with the PowerShell (unverified: kernel seed coverage) | none found | old only |
| `workspace.plans-declare-their-owner` | Checks each plan file declares an owning Project Hub. | 5 (document check) | commit | port | `tools/gate.ts` (already in `tools/docs-gate.ts:178`) | A foreign product replaced a cited plan's content; `7576688` | old only |
| `workspace.no-foreign-install` | Checks no foreign product's install files sit in the root and CLAUDE.md still introduces this workspace. | 5 (repository check) | commit | port | `tools/gate.ts` (document half in `tools/docs-gate.ts`) | Librarian 2.0 installed over the root; `7576688` | old only |
| `books.no-hardcoded-known-limits` | Scans PowerShell helpers for a reintroduced `known_limits` field. | 1 | none | retire | deleted with the PowerShell | The same `known_limits` text stamped on every Book; `115740f` | old only |
| `books.reader-map-labels-are-titles` | AST scan: PowerShell reader-map writers label links with page titles. | 1 | none | retire | deleted with the PowerShell; kernel map in section 183 (unverified) | Reader maps listed filenames, not titles; `cfa70f7` | old only |
| `books.reader-map-label-matches-manifest-title` | Checks `Get-ReaderMapLabel` agrees with `BookManifest.ps1`'s title rule. | 1 | none | retire | deleted with the PowerShell | Same defect; `cfa70f7` | old only |
| `restore-book-source.canonical-source` | Drives `Restore-BookSource.ps1`'s validator on a Shelf-published Book. | 1 | none | retire | deleted with the PowerShell | A misleading "does not resolve" refusal, fixed 2026-09-05 (comment) | old only |
| `book-currency.roll-up-is-worst-row` | AST check: `Get-BookCurrency.ps1` call sites order "cannot verify" first. | 1 | none | retire | deleted with the PowerShell | A Book with 13 unreadable articles reported `current`; `8bb3c61` | old only |
| `manifests.lock-failure-names-its-cause` | AST check: PowerShell manifest updaters report the real lock failure cause. | 1 | none | retire | deleted with the PowerShell | 2026-09-05 shared rebuild mislabeled as contention; `678b1b8` | old only |
| `notebook.master-index-renders` | Checks the workspace's Notebook master index equals a fresh render. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1393`) | none found | old only |
| `shelf.catalog-renders-from-entries` | Checks the workspace's Shelf catalog equals a render of its entries. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1394`) | none found | old only |
| `output.namespaced-by-project` | Checks every file in `output/` sits under a project slug. | 5 (workspace health) | none | retire | kernel verb `doctor` (`doctor.ts:1395`) | none found | old only |
| `derived-indexes.written-atomically` | Taint scan: PowerShell writes of derived index files are atomic. | 1 | none | retire | deleted with the PowerShell | Derived indexes written non-atomically; `57d206f` | old only |
| `desk.state-read-and-written-atomically` | Scope-aware taint scan: PowerShell Desk reads and writes go through the atomic primitives. | 1 | none | retire | deleted with the PowerShell | Desk writes were not atomic across 21 readers; `18b58b0` | old only |
| `derived-indexes.rollback-re-renders` | AST check: PowerShell rollbacks re-render derived indexes. | 1 | none | retire | deleted with the PowerShell | A rollback restored a stale index; `57d206f` | old only |
| `notebook.exclusion-must-be-earned` | Drives `Set-NotebookTopicOwner` to check an `excluded` declaration is refused when a Book reproduces it. | 1 | none | retire | deleted with the PowerShell; kernel ownership section (unverified) | `fba979f` | old only |
| `gate.fast-roster-matches-suites` | AST check: the `-Fast` roster equals the suites in the `else` branch. | 1 | none | retire | deleted with the PowerShell (the gate.ts registry replaces the roster) | A suite missing from the roster, "-Fast counted 80 without it"; `0ef4731` | old only |
| `hooks.payload-fields-are-captured` | Checks payload fields PowerShell hooks read are ones the harness sends. | 1 | none | retire | deleted with the PowerShell | Hooks read field names the payload never carries; `7f8dbc3` | old only |
| `export-lock.reaches-both-chokepoints` | AST check: the export lock is checked in `Enter-BookLock` and `Assert-SeatClaimHeld`. | 1 | none | retire | deleted with the PowerShell | none found | old only |
| `public.no-deployment-defaults` | Scans program files for the deployment denylist and structural deployment values. | 3 (leak gate) | commit | port | `tools/scan.ts`, called by `tools/gate.ts` (plan session 1 item 6) | The denylist read from the program yielded nothing after step 22, measured 2026-09-21 (comment) | old only |
| `public.identity-scan` | Scans staged blobs for the identity denylist (gitleaks in contributor mode). | 3 (leak gate) | commit | port | `tools/scan.ts`, called by `tools/gate.ts` (plan session 1 item 6) | none found | old only |
| `collection.write-fence-coverage` | AST check: declared PowerShell collection writers call the write fence. | 1 | none | retire | deleted with the PowerShell | `3817a19` | old only |
| `acceptance.matrix-shape` | Validates `acceptance-matrix.json` shape and that every PowerShell script it names exists. | 1, but the plan ports it | commit | port | `tools/matrix.ts --check-shape` (plan session 3 item 4) | none found | old only |
| `acceptance.matrix-covers-every-public-helper` | Checks every public PowerShell helper has a matrix row or an exclusion. | 2 | commit until the freeze | retire | retired after the freeze (session 4) | none found | old only |
| `kernel.selftest` | Runs `node kernel/test/selftest.ts`, every section. | 4 (the kernel suite itself) | cut (commit runs only the sections that cover changed files) | port | `tools/gate.ts`, cut tier, with section selection (plan item 3) | many; none attributed to this check by name | old only |
| `acceptance.kernel-verbs-exist` | Checks every matrix row's kernel step names a verb `library verbs` declares. | 5 (matrix check) | commit | port | `tools/matrix.ts` or `tools/gate.ts` (unverified which) | Four rows were testing nothing; `0ddd642` | old only |
| `acceptance.matrix-doc-matches-rows` | Checks the generated region of `docs/supported-operation-matrix.md` matches a render of the rows. | 5 (matrix check) | commit | port | `tools/matrix.ts` or `tools/gate.ts` (unverified which) | none found | old only |
| `release.fixtures-all-run` | Checks `Test-BuiltRelease.ps1` names every release-taking `Test-*.ps1`. | 1 | none | retire | replaced by `tools/test-built-release.ts` (session 5) | S57 never ran `Test-KernelUpgrade.ps1`; S58 found it failing; `185c661` | old only |
| `codex.portability-selftest` | Runs `Test-CodexPortability.ps1`: packaged Codex guards resolve a fixture. | 4 | push (-Fast skips) | port some cases (unverified) | per `Test-CodexPortability.ps1`'s row; kernel sections 22 and 39 (unverified) | none found | old only |
| `reader.dispatch-selftest` | Drives the reader adapter's JSON-RPC argument guards over stdio. | 4 (adapter test) | push (-Fast skips) | port some cases | kept with the reader-adapter exception (session 6) (unverified) | none found | old only |
| `acceptance.harness-selftest` | Runs `Invoke-AcceptanceMatrix.ps1 -SelfTest`, building eight fixtures. | 2 | none (-Fast skips) | retire | retired after the freeze (session 4); `matrix.ts` proofs in session 3 | none found | old only |
| `reader.shelf-selftest` | Runs the reader adapter's `-ShelfSelfTest`. | 4 (adapter test) | push (-Fast skips) | port some cases | kept with the reader-adapter exception (unverified) | none found | old only |
| `reader.project-pin-selftest` | Drives both adapter Project-pin call sites with a decoy pin. | 4 (adapter test) | push (-Fast skips) | port some cases | kept with the reader-adapter exception (unverified) | `read_project_catalog` refused at every seat, 2026-09-08 (comment) | old only |
| `library-hooks.boundary-suite` | Runs `Test-LibraryHooks.ps1`: every PowerShell hook driven as a real process. | 4 | none (-Fast skips) | retire (unverified) | per `Test-LibraryHooks.ps1`'s row; kernel hook sections 16, 18, 111-114 (unverified) | Wrong payload field names (comment line 5281); `f0ed7f8` | old only |
| `maintenance.folder-move` | Runs `Test-LibraryFolderMove.ps1`: a real barrier refuses `Set-VirtualDesk` and the launchers. | 4 | none (-Fast skips) | retire (unverified) | per `Test-LibraryFolderMove.ps1`'s row | none found | old only |
| `library-helpers.boundary-suite` | Runs `Test-LibraryHelpers.ps1` against the workspace. | 4 | none (-Fast skips) | retire (unverified) | per `Test-LibraryHelpers.ps1`'s row | none found | old only |
| `mcp-helpers.boundary-suite` | Runs `Test-McpHelpers.ps1` against a loopback stub. | 4 | none (-Fast skips) | retire (unverified) | per `Test-McpHelpers.ps1`'s row | none found | old only |
| `book-write-guard.selftest` | Runs `BookWriteGuard.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `BookWriteGuard.ps1`'s row | none found | old only |
| `notebook-index.selftest` | Runs `NotebookIndex.ps1 -SelfTest`. | 2a (fixture builder's test) | none (-Fast skips) | retire | after session 3 replaces `NotebookIndex.ps1` | none found | old only |
| `shelf-catalog.selftest` | Runs `ShelfCatalog.ps1 -SelfTest`. | 2a (fixture builder's test) | none (-Fast skips) | retire | after session 3 replaces `ShelfCatalog.ps1` | none found | old only |
| `notebook.render-lock-narrow` | Runs `Test-NotebookRenderLock.ps1`: eight processes rewrite a file 800 times under the render lock. | 4 | none (-Fast skips) | retire (unverified) | per `Test-NotebookRenderLock.ps1`'s row; kernel sections 29-30 (unverified) | none found | old only |
| `book-manifest.selftest` | Runs `BookManifest.ps1 -SelfTest`. | 2a | none (-Fast skips) | retire | after session 3 | none found | old only |
| `book-manifest-store.selftest` | Runs `BookManifestStore.ps1 -SelfTest`. | 2a | none (-Fast skips) | retire | after session 3 | none found | old only |
| `book-manifest-transaction.selftest` | Runs `BookManifestTransaction.ps1 -SelfTest`. | 2a | none (-Fast skips) | retire | after session 3 | none found | old only |
| `git-source.selftest` | Runs `GitSource.ps1 -SelfTest`: git transport isolation and batch-root discovery. | 4 | none (-Fast skips) | retire (unverified) | per `GitSource.ps1`'s row; kernel section 92 (unverified) | Discovery walking up into the Library's own repository (comment) | old only |
| `sources-block.selftest` | Runs `SourcesBlock.ps1 -SelfTest`: Sources block round trip. | 4 | none (-Fast skips) | retire (unverified) | per `SourcesBlock.ps1`'s row | none found | old only |
| `mcp-directory-listing.selftest` | Runs `McpDirectoryListing.ps1 -SelfTest`: paginated listing completeness. | 4 | none (-Fast skips) | retire (unverified) | per `McpDirectoryListing.ps1`'s row | Unpaged listings returned 9 of 17 pages, measured 2026-09-05 (comment) | old only |
| `book-discovery.selftest` | Runs `BookDiscovery.ps1 -SelfTest`. | 4 | push (-Fast skips) | port some cases (unverified) | per `BookDiscovery.ps1`'s row; may stay in the adapter's closure | none found | old only |
| `book-fulltext.selftest` | Runs `BookFullText.ps1 -SelfTest`: full-text only for open Books, caps. | 4 | push (-Fast skips) | port some cases (unverified) | per `BookFullText.ps1`'s row; in the adapter's closure (plan session 6) | none found | old only |
| `raw-search.selftest` | Runs `RawSearch.ps1 -SelfTest`: scope, provenance, historical labels. | 4 | none (-Fast skips) | retire (unverified) | per `RawSearch.ps1`'s row; kernel `rawsearch.ts` | none found | old only |
| `mcp-tool-inventory.selftest` | Runs `McpToolInventory.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `McpToolInventory.ps1`'s row | none found | old only |
| `raw-batch-ownership.selftest` | Runs `RawBatchOwnership.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `RawBatchOwnership.ps1`'s row; kernel `rawowners.ts` | An eviction offer stated without reading catalogs survived 87 green checks (comment) | old only |
| `desk.two-seat-acceptance` | Runs `Test-TwoSeatAcceptance.ps1`: two seats, real helpers and guards, must agree. | 4 | none (-Fast skips) | retire (unverified) | per `Test-TwoSeatAcceptance.ps1`'s row; kernel sections 24-27 (unverified) | none found | old only |
| `seat.lifecycle` | Runs `Test-SeatLifecycle.ps1` against the workspace environment. | 4 (uses 2a `Retire-Seat.ps1`) | none (-Fast skips) | retire (unverified) | per `Test-SeatLifecycle.ps1`'s row | First run found three faults (empty Desk file, `$null` reads, a hanging `-Json`); `c4a8fe9` | old only |
| `recovery.routes` | Runs `Test-RecoveryRoutes.ps1`: the recovery routes the docs promise. | 4 | none (-Fast skips) | retire (unverified) | per `Test-RecoveryRoutes.ps1`'s row; kernel sections 31-32 (unverified) | none found | old only |
| `notebook.migration` | Runs `Test-NotebookMigration.ps1`: the kernel's ADR-0029 migration from PowerShell-built legacy states. | 4 (judges a kernel verb; independent row) | push (-Fast skips) | port some cases | per `Test-NotebookMigration.ps1`'s row; its legacy states need frozen fixtures (unverified) | none found | old only |
| `notebook.idle-seat-sweep` | Runs `Test-NotebookSweep.ps1`: cross-seat sweep classification. | 4 | none (-Fast skips) | retire (unverified) | per `Test-NotebookSweep.ps1`'s row | none found | old only |
| `desk.book-root-selftest` | Runs `BookRootSchema.ps1 -SelfTest`. | 4 | push (-Fast skips) | port some cases (unverified) | stays while `BookRootSchema.ps1` is in the adapter's closure (plan session 6) | none found | old only |
| `triage-inventory.selftest` | Runs `Get-LibraryTriageInventory.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per that file's row; kernel sections 153 and 176 (unverified) | An advisory read `unavailable` after a reset, fixed 2026-08-28 (comment) | old only |
| `triage.history-readable` | Checks legacy `internal/handoff-*` records parse and the gate does not touch them. | 5 | none (-Fast skips) | retire | not in kernel `doctor` (unverified whether kernel triage reads them) | none found | old only |
| `meter-status.selftest` | Runs `Get-MeterStatus.ps1 -SelfTest`: the Codex meter parser. | 4 (of a class 3 tool) | none (-Fast skips) | retire (unverified) | per `Get-MeterStatus.ps1`'s row | It had a self-test nothing ran (comment) | old only |
| `meter.parsers-agree` | Runs `Get-MeterStatus.ps1` and `~/.claude/statusline.sh` over one fixture; values must agree. | 3 | none (-Fast skips) | retire (unverified) | per `Get-MeterStatus.ps1`'s row | The status line showed a quoted rate-limit blob as a live meter, 2026-09-05; `8bb3c61` | old only |
| `token-baseline.selftest` | Runs `Get-TokenBaseline.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `Get-TokenBaseline.ps1`'s row | none found | old only |
| `library-deployment.selftest` | Runs `LibraryDeployment.ps1 -SelfTest`: deployment resolver refusals and endpoint validation. | 4 | none (-Fast skips) | retire (unverified) | per `LibraryDeployment.ps1`'s row | none found | old only |
| `collection-vault-export.selftest` | Runs `Export-CollectionToVault.ps1 -SelfTest`. | 3 (mirror export's test) | push (-Fast skips) | port some cases | with the mirror export's port, `tools/*.ts` (unverified) | none found | old only |
| `public-tree-export.selftest` | Runs `Export-PublicTree.ps1 -SelfTest` on throwaway repositories. | 3 (export's test) | push (-Fast skips) | port | `tools/export-public-tree.ts` (session 5) | none found | old only |
| `workspace-registry.selftest` | Runs `WorkspaceRegistry.ps1 -SelfTest`. | 4 | push (-Fast skips) | port some cases (unverified) | stays while `WorkspaceRegistry.ps1` is in the adapter's closure (plan session 6) | none found | old only |
| `workspace-init.selftest` | Runs `Initialize-LibraryWorkspace.ps1 -SelfTest`. | 2a | none (-Fast skips) | retire | after session 3 freezes fixtures | none found | old only |
| `workspace-init.ignores-a-seated-session` | Runs the same self-test with a seated session's variables set and cleared. | 2a and 1 (gate environment) | none (-Fast skips) | retire | after session 3; `gate.ts` blanks the same variables (plan item 1) | S69: an inherited `LIBRARY_WORKSPACE` turned the suite red; `bcef589` | old only |
| `collection-ownership.selftest` | Runs `CollectionOwnership.ps1 -SelfTest`: six processes race to acquire. | 4 | none (-Fast skips) | retire (unverified) | per `CollectionOwnership.ps1`'s row; kernel section 28 (unverified) | none found | old only |
| `deployment-scan.selftest` | Runs `DeploymentScan.ps1 -SelfTest`: the scan detectors stay live. | 3 (scan's test) | push (-Fast skips) | port | `tools/scan.ts`'s own test (session 1 item 6) | none found | old only |
| `plugin.generated-files-match` | Runs `PluginPackage.ps1 -SelfTest`: generated Claude plugin files match the Codex layout. | 3 (build) | push (-Fast skips) | port | `tools/*.ts` with `PluginPackage.ps1`'s port (unverified name) | none found | old only |
| `mirror-job.allowlist-rule-parity` | Runs `Test-AllowlistRuleParity.ps1`: the scan's allowlist rule vs the mirror job's. | 3 | push (-Fast skips) | port | `tools/scan.ts` against `docs/mirror-publishing-job.md` (unverified) | none found | old only |
| `library-output.selftest` | Runs `LibraryOutput.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `LibraryOutput.ps1`'s row | none found | old only |
| `edit-project-hub.selftest` | Runs `Edit-ProjectHub.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `Edit-ProjectHub.ps1`'s row; kernel `hubedit.ts` sections | none found | old only |
| `new-project-hub.selftest` | Runs `New-ProjectHub.ps1 -SelfTest`. | 2a (seed writer's test) | none (-Fast skips) | retire | after session 3 moves seeds to kernel verbs | none found | old only |
| `add-catalog-entry.selftest` | Runs `Add-CatalogEntry.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `Add-CatalogEntry.ps1`'s row | none found | old only |
| `remove-shared-entry.selftest` | Runs `Remove-SharedEntry.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `Remove-SharedEntry.ps1`'s row | none found | old only |
| `remove-memory-project.selftest` | Runs `Remove-MemoryProject.ps1 -SelfTest`. | 4 | none (-Fast skips) | retire (unverified) | per `Remove-MemoryProject.ps1`'s row | none found | old only |
| `archive-shared-book.selftest` | Runs `Archive-SharedBook.ps1 -SelfTest`: the catalog emptiness-sentence repair. | 4 | none (-Fast skips) | retire (unverified) | per `Archive-SharedBook.ps1`'s row | none found | old only |
| `shared-collection-files.selftest` | Runs `SharedCollectionFiles.ps1 -SelfTest`: never remove a non-empty directory. | 4 | none (-Fast skips) | retire (unverified) | per `SharedCollectionFiles.ps1`'s row | none found | old only |
| `hub-migration-acceptance.selftest` | Runs `Test-HubMigrationAcceptance.ps1 -SelfTest`. | 5 (one-off migration) | none (-Fast skips) | retire | deleted with the PowerShell | none found | old only |
| `hub-migration-snapshot.selftest` | Runs `New-HubMigrationSnapshot.ps1 -SelfTest`. | 5 (one-off migration) | none (-Fast skips) | retire | deleted with the PowerShell | none found | old only |
| `book-currency.shelf-path` | Runs `Test-BookCurrencyShelfPath.ps1`. | 4 | none (-Fast skips) | retire (unverified) | per that file's row | A careless fixture proved the wrong branch; `90fe0fe` | old only |
| `shelf.writers-route-manifests` | Runs `Test-ShelfWriterRouting.ps1`: Shelf writers go through the manifest window. | 4 | none (-Fast skips) | retire (unverified) | per that file's row | none found | old only |
| `shelf.manifest-backfill` | Runs `Test-ManifestBackfill.ps1` against a fixture Shelf. | 4 | none (-Fast skips) | retire (unverified) | per that file's row; kernel `shelf rebuild` section 127 (unverified) | none found | old only |
| `archive.search-coverage` | Runs `Test-ArchiveSearchCoverage.ps1`: an archived Book stays findable and counted. | 4 | none (-Fast skips) | retire (unverified) | per that file's row | Archiving retired a Book's Discovery manifest (ADR-0012); `52ec4d3` | old only |
| `shared.manifest-backfill` | Runs `Test-SharedManifestBackfill.ps1` against a fault-injecting stub. | 4 | none (-Fast skips) | retire (unverified) | per that file's row | none found | old only |
| `shelf-note.boundary-suite` | Runs `Test-ShelfNoteBoundary.ps1`. | 4 | none (-Fast skips) | retire (unverified) | per that file's row; kernel `shelfnote.ts` | none found | old only |
| `shared.archive-catalog-consistency` | Reads the shared collection's `archive/README.md` for an emptiness claim (warns). Needs `-IncludeShared`. | 5 (shared health) | release | port (unverified) | `tools/gate.ts` release tier, shared checks | The pilot-era "nothing archived" sentence on a populated catalog; `cc290bd` | old only |
| `shared.archive-leaves-no-husk` | Looks for empty source trees an archive left on the share (warns). Needs `-IncludeShared`. | 5 (shared health) | release | port (unverified) | `tools/gate.ts` release tier, shared checks | Archives left emptied source trees; `088e102` | old only |
| `seat.create-acceptance` | Drives PowerShell seat creation end to end against live Projects. Needs `-IncludeShared`. | 4 | none | retire (unverified) | kernel seat creation sections 156-157, 190 (unverified) | none found | old only |
| `reader.shared-selftest` | Runs the reader adapter's `-SelfTest` against the shared collection. Needs `-IncludeShared`. | 4 (adapter test) | release | port some cases | kept with the reader-adapter exception (session 6) (unverified) | none found | old only |

#### Notes

- **Count matches the plan: 132 registered, 61 skipped under `-Fast`.** The runner's own comment at lines 34-37 is
  stale: it says "of 128 checks ... sixty-three are whole test suites".
- **Four checks run in neither normal mode.** The `-IncludeShared` four are reported `skipped` by both `-Fast` and the
  full gate. The plan's release tier ("the shared (NAS) checks") is where they would run.
- **Nine workspace checks are already in the kernel.** `doctor.ts:1387-1395` implements all nine
  `Invoke-WorkspaceCheck` checks outside the suite branch, so retiring them loses nothing. `triage.history-readable`
  is the one workspace check not in `doctor`.
- **Eight checks are already in `tools/docs-gate.ts`**, for docs-only commits only. Six are full ports and two are
  their document halves.
- **The class 1 group is large.** About 35 checks scan or drive PowerShell code: AST scans, taint scans,
  PowerShell-to-PowerShell parity, and the runner's own roster. All retire with the PowerShell. Several guard a rule
  the kernel must also hold, such as atomic Desk writes, lock order, claim coverage and the export lock, and none of
  them has a kernel-side static check. Their row should name the kernel self-test section that holds each rule. I
  did not verify those sections.
- **Uncertain class calls:**
  - The `hub.*` seed checks: the seed text lives in `New-ProjectHub.ps1` (2a), so the check retires with it unless the kernel seed gets its own check.
  - `seats.contract-table-matches-code`: the table renders PowerShell declarations.
  - `settings.hooks-registered`: the program settings may still register PowerShell hooks.
  - Every suite's port-or-retire call: the call belongs to the suite file's row, so I marked suite decisions `(unverified)`.
- **The reader adapter's tests.** Five checks test the adapter, a listed exception, and plan session 6 keeps "the
  tests it needs". `gate.ts` would then have to spawn `powershell.exe`, which conflicts with "no PowerShell" in the
  plan's goal. These are `reader.launch-validation`, `reader.dispatch-selftest`, `reader.shelf-selftest`,
  `reader.project-pin-selftest` and `reader.shared-selftest`.
- **Self-test numbering.** `kernel/test/selftest.ts` has 207 `selected(N)` blocks, and the plan says 205 sections.
  Section numbers in the table come from matching titles only.
- **Line count:** `tools/Invoke-LibraryChecks.ps1` is 6,838 lines (`wc -l`).

## 5. The PowerShell outside `tools/`, and what depends on a `.ps1`

### Draft rows: the PowerShell outside `tools/`, and what depends on any `.ps1`

Drafted from a detached copy of `master` at `1bd14ec` (S109 cut 1). Read-only; nothing was run but `git`, `grep`,
`wc` and `node` reading files. Line numbers are current at `1bd14ec`.

#### Grep

```sh
# Part 1: the .ps1 files outside tools/ (14)
git ls-files '*.ps1' | grep -v ^tools/

# Part 2: every non-.ps1 place that names a .ps1 or PowerShell (3,739 hit lines in 284 files)
git grep -n -i -E '\.ps1|powershell' -- ':!tools/*.ps1' ':!*.ps1'
git grep -c -i -E '\.ps1|powershell' -- ':!tools/*.ps1' ':!*.ps1'     # per-file counts

# Narrowing passes over the same hits
git grep -n -i -E '\.ps1|powershell' -- kernel/src | grep -v -E '^[^:]+:[0-9]+:\s*(\*|//|/\*\*)'   # kernel code, comments dropped
# kernel/test/selftest.ts: each non-comment hit mapped to the enclosing `if (selected(N)` block (node, read-only)
```

Who ships and who runs (checked in `tools/PublicTreeAllowlist.ps1:53-54,111,124-126`, `kernel/src/releasefiles.ts:24-35,46-83`,
`kernel/src/hookregistry.ts:26-77`, `kernel/src/init.ts:405-426`):

- **Public tree:** all 14 (`.claude/adapters` and `.claude/hooks` are include roots; `install.ps1`, `library.ps1` listed).
- **Release archive:** only `install.ps1` and the adapter with its closure (24 `tools/*.ps1` today, recomputed here with
  the `releasefiles.ts:46-50` rules). Every hook script and `library.ps1` (with `library`, `library.cmd`) is dropped.
- **A reader's workspace runs:** from a compiled release, no hook script (each registered as `library.exe hook <verb>`;
  all 8 required hooks have a verb, `hookregistry.ts:69-78`); the adapter only for a Basic Memory workspace on Windows.
  From a kernel run from source (no `bin/library.exe`), the hook scripts and the adapter (`init.ts:420-426,411-415`).
- **This checkout's own sessions run:** all 9 hook registrations in `.claude/settings.json:77-222` and the adapter via
  `.mcp.json:4-10`, every session.

#### Part 1: the 14 `.ps1` files outside `tools/`

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `.claude/adapters/Validated-BookReader.ps1` | The validated MCP reader for Books and Hubs in Basic Memory; dot-sources 24 `tools/` scripts. Ships in the release. | 3 (a reader runs it: Basic Memory on Windows); also 2 (PS arm of 20 differential rows, `reader.*`, `discovery.*`, `search.*`, `hub.briefing-*`, `seat.tier0-*`) | port (separate backlog item); until then kept | Listed exception with its closure (plan session 6 step 3); kernel `mcp serve` already serves the local collection | none found (a reader, not a check) | old only |
| `.claude/hooks/Guard-BasicMemoryRead.ps1` | PreToolUse guard: the shared-collection Desk boundary for `mcp__basic-memory__*` calls. | 2 (PS arm of 17 differential `guards.basic-memory-*` rows); also 3 (this checkout's settings run it) | retire | kernel verb `hook basic-memory-read`; rows frozen in session 4; `.claude/settings.json:78-92` re-pointed | none found (a guard, not a check) | old only |
| `.claude/hooks/Guard-ShelfBookRead.ps1` | PreToolUse guard: a closed Shelf Book is unreadable by Read, Grep, Glob, Write, Edit (and Codex apply_patch). | 2 (13 differential `guards.*` rows); also 3 | retire | kernel verb `hook shelf-read`; settings `:94-108` re-pointed | none found (a guard) | old only |
| `.claude/hooks/Guard-ShellShelfRead.ps1` | PreToolUse guard: a closed Shelf Book is unreadable by a shell command. | 2 (9 differential rows); also 3 | retire | kernel verb `hook shell-shelf-read`; settings `:110-124` re-pointed | its own comment (`:16-30`) records the hole it closes: a `wc -c` read of closed `holding`, 2026-09-06, `ba0dec9` | old only |
| `.claude/hooks/Get-VirtualDeskContext.ps1` | UserPromptSubmit hook: says what is open at this seat on every prompt. | 2 (10 differential `guards.desk-context-*`, `seat.desk-context-*` rows); also 3 | retire | kernel verb `hook desk-context`; settings `:145-160` re-pointed | none found | old only |
| `.claude/hooks/Guard-SettingsIntegrity.ps1` | ConfigChange guard: refuses a settings edit that would disable the guards. | 2 (9 differential `guards.settings-*` rows); also 3 | retire | kernel verb `hook settings-integrity`; settings `:207-222` re-pointed | none found (comment `:12-22` cites the silent settings breakage it answers) | old only |
| `.claude/hooks/Restore-CompactedGuidance.ps1` | PostCompact and SessionStart hook: clears the serve ledger after a compaction. | 3 (this checkout's settings run it); no matrix row | retire | kernel verb `hook compact-clear` (self-test sections 21, 39, 112); settings `:162-192` re-pointed | none found | old only |
| `.claude/hooks/Get-SeatStartContext.ps1` | SessionStart hook: hands a seatless session the roster, re-binds a resumed one. | 3; no matrix row | retire | kernel verb `hook seat-start` (sections 21, 39, 101, 113); settings `:193-205` re-pointed | none found | old only |
| `.claude/hooks/Add-SearchHitReminder.ps1` | PostToolUse hook: "a hit is a location, not a reading" after a search. | 3; no matrix row | retire | kernel verb `hook search-hit` (sections 21, 39, 101, 113); settings `:127-143` re-pointed | none found | old only |
| `.claude/hooks/HookContext.ps1` | Dot-sourced plumbing for 7 hooks: payload reader, deny writer, serve ledger. Also dot-sourced by `Invoke-LibraryChecks.ps1:2932`, `Test-LibraryHooks.ps1:277`. | 2 (part of the guard oracles, transitively) | retire | deleted with the PowerShell, after the hooks | none found | old only |
| `.claude/hooks/ProgramRoot.ps1` | Dot-sourced: finds the program root apart from the workspace, for 5 hooks and `ShelfBoundary.ps1`. | 2 (transitively, guard oracles) | retire | deleted with the PowerShell | none found (its comment records the plugin-layout exit-1 it fixed, `9e69e77`) | old only |
| `.claude/hooks/ShelfBoundary.ps1` | Dot-sourced: where a Shelf path sits relative to the Desk, for the two Shelf guards. | 2 (transitively) | retire | deleted with the PowerShell; kernel `guards.ts` holds the same rules (unverified one-to-one) | none found | old only |
| `install.ps1` | The public `irm \| iex` installer: fetches a release, checks its hash, runs that release's `library.exe install`. Ships beside a release. | 3 | port (done: kernel verb `install`, 1.3.5, ADR-0066); file kept | Listed exception (public one-liner URL); self-test sections 110, 132, 137 read or run it | none found | old only |
| `library.ps1` | Source-checkout dispatcher for `library desk` and `library init` (to `Get-DeskOverview.ps1`, `Initialize-LibraryWorkspace.ps1`). Dropped from releases. | 2 (PS arm of 2 differential `workspace.*` rows) | retire | kernel verbs `desk`, `init` (`deskpost`); after the session 4 freeze, with `library` and `library.cmd` | none found | old only |

#### Part 2: non-`.ps1` places that depend on a `.ps1`

Class is the class of the `.ps1` depended on (for a `tools/` script, my provisional call; the `tools/` rows decide).

##### Code and configuration

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `.githooks/pre-commit:51` | Runs `tools/Invoke-LibraryChecks.ps1 -Fast` for a non-docs commit (`:12`, `:20` are comments). | gate runner (1 and 4) | retire | `node tools/gate.ts --tier commit` at the flip (session 2 step 3) | none found | old only |
| `.githooks/pre-commit` (docs path) | Runs `node tools/docs-gate.ts`, which itself starts one `powershell.exe` (row below). | 3 (`DeploymentScan.ps1`) | port | `tools/scan.ts` inside the commit tier | none found | old only |
| `.githooks/commit-msg:18` | Runs `tools/DeploymentScan.ps1 -IdentityScan -CommitMessageFile` on every commit message. | 3 | port | `tools/scan.ts` (session 1 item 6) | none found | old only |
| `tools/docs-gate.ts:411-445` | Dot-sources `LibraryDeployment.ps1` and `DeploymentScan.ps1` (`:418-419`) in one `powershell.exe -Command` (`:445`) for the identity and deployment scans. | 3 | port | `tools/scan.ts` (session 1 item 6) | none found | old only |
| `tools/docs-gate.ts:370-371` | Reads the hit-rule stem from `tools/SearchBoundaries.ps1`'s text. | 3 (`SearchBoundaries.ps1` is in the adapter closure) | port | read the stem from a kernel source or a data file (unverified which) | none found | old only |
| `tools/docs-gate.ts:56-64` | `CONTRACT_DOCUMENTS`: docs read by PowerShell checks keep the full runner. | 1 (the PS checks named) | retire | folded into `gate.ts` commit tier at the flip | none found | old only |
| `kernel/package.json:5` | Description names `Invoke-AcceptanceMatrix.ps1` as the judge. No script depends on a `.ps1`. | 2 | retire | text rewritten when `matrix.ts` lands; plan adds a `gate` script here | none found | old only |
| `.claude/settings.json:77-222` (9 hook registrations) | This checkout's sessions run each `.claude/hooks/*.ps1` through `powershell.exe -File`. | 2 and 3 (the hooks) | retire | each re-pointed to its kernel `hook <verb>` (needs a from-source spelling; see Notes) | none found | old only |
| `.claude/settings.json:15-72` (58 allow lines) | Permission allowlist for `tools/*.ps1` helpers; rows below, one per line. | per helper | see rows | see rows | none found | old only |
| `.mcp.json:4-10` | This checkout's own reader: `powershell.exe -File .claude/adapters/Validated-BookReader.ps1`. | 3 (adapter) | port (backlog) | listed exception while the adapter stays; else kernel `mcp serve` | none found | old only |
| `.codex/config.template.toml:1,15` | Codex template: reader server is `powershell.exe -File __VALIDATED_READER_PATH__`; header names `Initialize-CodexLibrary.ps1`. | 3 (adapter; `Initialize-CodexLibrary.ps1`) | port (backlog) | stays with the adapter exception; header re-pointed to kernel `init` | none found | old only |
| `.codex/workspace-config.template.toml:2,6,17` | Same for a reader workspace; `init.ts:737` swaps `powershell.exe` for the binary on POSIX. | 3 (adapter) | port (backlog) | stays with the adapter exception | none found | old only |
| `.claude-plugin/.mcp.json:2`, `.claude-plugin/hooks/hooks.json:2`, `.codex-plugin/reader.json:2` | Generated by `tools/PluginPackage.ps1`; `plugin.generated-files-match` fails on drift. | 3 (`PluginPackage.ps1`, a build tool) | port | a `tools/*.ts` generator (name unverified), session 5 or 6 | none found | old only |
| `.claude/hooks/payload-contract.json` | Measured hook payload fields; read only by PowerShell (`HookContext.ps1`, `Guard-SettingsIntegrity.ps1`, `HookRegistry.ps1`, `DeploymentScan.ps1`, `Invoke-LibraryChecks.ps1`). No kernel reader found. | 2 (hooks) | retire | deleted with the hooks, or adopted by a kernel check (unverified) | none found | old only |
| `library:16-34` | POSIX launcher: execs `library.ps1` through `pwsh` or `powershell.exe`. | 2 (`library.ps1`) | retire | removed with `library.ps1` | none found | old only |
| `library.cmd:4` | Windows launcher: `powershell.exe -File library.ps1`. | 2 | retire | removed with `library.ps1` | none found | old only |
| `.gitattributes:9,17` | Line-ending rules for `tools/*.ps1` and `/library.ps1`. | n/a | retire | lines removed with the files | none found | old only |
| `tools/acceptance-matrix.json` (253 `script` steps) | Every differential row's PowerShell arm names the `.ps1` it runs. | 2 | retire | frozen into `tools/frozen-results.json` (session 4); PS arm fields dropped | none found | old only |
| `tools/_helpers.json` | Declares the role of every `tools/*.ps1`; `Invoke-LibraryChecks.ps1` compares it with the allowlist. | 1 | retire | deleted with the PowerShell | none found | old only |
| `tools/mirror-fixture/fixture.sh:6,31,50` | Fixture names the scanner `Export-MirrorOpsRepo.ps1` generates and the `Build-KernelRelease.ps1` layout; writes a stand-in `install.ps1`. | 3 | port | comments re-pointed to the `tools/*.ts` ports (session 5) | none found | old only |
| `kernel/src/init.ts:1129` | Program-root detection for the local collection: `tools/BookRootSchema.ps1` exists. | 3 (`BookRootSchema.ps1`, adapter closure) | port | key on `kernel/package.json` (session 6 step 2) | none found | old only |
| `kernel/src/init.ts:1185` | Same detection, to skip the program's own instruction files. | 3 | port | key on `kernel/package.json` | none found | old only |
| `kernel/src/init.ts:63-66,665,693-700` | From source (no binary), registers Codex hooks as `powershell.exe -File <hook>.ps1`. | 2 (hooks) | retire | kernel `hook <verb>` from source too (spelling unverified) | none found | old only |
| `kernel/src/init.ts:420-426,452-460` | From source, Claude hook registrations stay the `.ps1` scripts (`kernelRegistersHooks`). | 2 (hooks) | retire | same as above | none found | old only |
| `kernel/src/init.ts:486-502,1203-1214` | Registers the adapter `powershell.exe -File Validated-BookReader.ps1` for Basic Memory on Windows or from source. | 3 (adapter) | port (backlog) | listed exception while the adapter stays | none found | old only |
| `kernel/src/init.ts:396-397` | Recognises an earlier init's `powershell.exe` adapter entry as Deskpost's, to replace it. | n/a (a name, no file read) | port | kept: upgrade recognition of old registrations | none found | old only |
| `kernel/src/doctor.ts:648-653` | Reads `-BookSlug` defaults out of `tools/Add-ShelfNote.ps1` and `tools/Invoke-LibraryTriage.ps1`. | 3 | port | read the kernel's `capture`/`triage` defaults; drop the read. Note: `bookSlugDefault` (`:613-614`) returns null for a missing file, so deletion makes the check pass silently | none found | old only |
| `kernel/src/doctor.ts:117-124` | `deskpostScripts`: the hook and adapter script names, plus every `.ps1` in the program's `.claude/hooks`. | 2 (hooks) | port | kept as names for old registrations; tolerates a missing folder (`:121-123`) | none found | old only |
| `kernel/src/hookregistry.ts:26-35,44-60,69-78` | Required hooks keyed by `.ps1` file name; verb map. Names only, no file read. | 2 (hooks) | port | kept as names (or re-keyed by verb); no file needed | none found | old only |
| `kernel/src/mcpserve.ts:107,124` | Launch check: the guard `.ps1` names a settings file must register. | 2 (hooks) | port | kept as names; verbs already recognised (`:128-130`) | none found | old only |
| `kernel/src/deskcontext.ts:128` | `CLEAR_HOOK = 'restore-compactedguidance.ps1'`, a registration name. | 2 (hooks) | port | kept as a name | none found | old only |
| `kernel/src/hooksearchhit.ts:25` | Matches `Search-RawBatch.ps1` in a shell command as a raw search. | 3 (`Search-RawBatch.ps1`) | port | drop the `.ps1` alternative when the helper retires | none found | old only |
| `kernel/src/machine.ts:187-218`, `kernel/src/lifecycle.ts:638` | Parses a `powershell.exe -File <script>` registration (ownership, uninstall). | n/a (a name) | port | kept for old registrations | none found | old only |
| `kernel/src/releasefiles.ts:24,27,35,46-50` | The release keeps `install.ps1` and the adapter's closure, parsed from its dot-sources (`:48-49`); drops `library*`. | 3 (adapter, `install.ps1`) | port | stays while the adapter does (session 5 step 1, session 6 step 3) | none found | old only |
| `kernel/src/releaseaudit.ts:155` | `install.ps1` is a loose release file. | 3 | port | kept (listed exception) | none found | old only |
| `kernel/src/procstart.ts:102-103` (calls `:114,198,346`) | Under Node on Windows, reads process start time and ancestry through `powershell.exe -Command`. | OS call, no `.ps1` | port | listed exception by default (plan "Risks"); or a Node-side native read (unverified) | none found | old only |
| `kernel/src/lifecycle.ts:172-173` | Under Node, lists processes with `Get-CimInstance` through `powershell.exe`. | OS call | port | as above | none found | old only |
| `kernel/src/seat.ts:1107` | Under Node, one `powershell.exe` child waits for the agent's exit. | OS call | port | as above | none found | old only |
| `kernel/src/processverb.ts:24` | Reports the route label `powershell` under Node. | OS call | port | changes with the three rows above | none found | old only |
| `kernel/src/remedy.ts:134-159` | Rewrites `tools/X.ps1 ...` advice to a kernel verb, or marks it PowerShell-only. | 3 (the helpers named) | port | kept until the advice strings below are rewritten (session 6 step 2) | none found | old only |
| `kernel/src/triagebatch.ts:245,526,828` | Refusals tell the reader to run `tools/Invoke-LibraryTriage.ps1` (stored plan, unported kinds). | 3 | port | port the missing triage parts, then rewrite the three refusals | none found | old only |
| `kernel/src/ownership.ts:95,106,122,133` | Advice: run `tools/Initialize-CodexLibrary.ps1 -McpUrl ...`. | 3 | port | name kernel `basic-memory setup` or `init` (unverified) | none found | old only |
| `kernel/src/ownership.ts:210,510` | Advice naming `tools/CollectionOwnership.ps1`, `tools/Update-SharedBookManifests.ps1`. | 3 | port | name the kernel verb or remove | none found | old only |
| `kernel/src/basicmemory.ts:117,139` | Advice: `tools/Initialize-CodexLibrary.ps1`. | 3 | port | as `ownership.ts:95` | none found | old only |
| `kernel/src/notebook.ts:480,539,662,787`; `seat.ts:604`; `doctor.ts:744`; `notebookverb.ts:51` | Advice naming `Restore-BookSource.ps1` and `Set-NotebookTopicOwner.ps1`. | 5 (`Set-NotebookTopicOwner.ps1`, retired by ADR-0029); 3 (`Restore-BookSource.ps1`) | port | rewritten or removed (session 6 step 2) | none found | old only |
| `kernel/src/seatclaim.ts:653,661-662` | Advice: `tools/Move-LibraryFolder.ps1 -Action Status / LiftBarrier`. | 3 | port | a kernel verb (none found) or removed | none found | old only |
| `kernel/src/capture.ts:2163`, `compile.ts:345`, `hubcopy.ts:138-139`, `locks.ts:117`, `shelf.ts:173`, `shelfcatalog.ts:164`, `collection.ts:69`, `verbs.ts:972` | Help and refusal text naming a `tools/*.ps1` helper. | 3 | port | rewritten to kernel verbs (session 6 step 2) | none found | old only |
| `kernel/src/setup.ts:347-398,460,882,942` | The installer line in its PowerShell spelling: `irm .../install.ps1`. | 3 (`install.ps1`) | port | kept (listed exception) | none found | old only |
| `kernel/src/bootstrap.ts:220`, `programroot.ts:54`, `verbs.ts:294,331` | Text naming `install.ps1`. | 3 | port | kept (listed exception) | none found | old only |
| Not dependencies (`kernel/src`) | `rawsearch.ts:79` and `shelfwriters.ts:154,598` (extension filters); `triagebatch.ts:236`, `verbs.ts:838`, `doctor.ts:292-293` (the reader's shell quoting); `init.ts:670,699` (Codex runs hooks through `powershell.exe -Command` on Windows); `setup.ts:646` (Claude Code's own installer URL); `notebooklayout.ts:161`, `verbs.ts:714`. All other `kernel/src` hits are comments. | n/a | retire | no change needed | none found | old only |
| `kernel/test/selftest.ts:4990-4997` (section 51) | Dot-sources `tools/SeatPicker.ps1` and runs it to compare rosters with the kernel menu. | 2 (`SeatPicker.ps1`, oracle for a self-test parity, not a matrix row) | retire | the parity half removed when `SeatPicker.ps1` retires (session 6 step 2) | none found | old only |
| `kernel/test/selftest.ts:6115-6122` (section 62) | Runs `tools/Set-NotebookTopicOwner.ps1` and `tools/NotebookIndex.ps1` to prove they refuse a seat-owned Library. Not named in the plan. | 5 and 2a | retire | case removed with the two scripts | none found | old only |
| `kernel/test/selftest.ts:8250-8258` (section 91) | Reads `Test-BuiltRelease.ps1` and `Test-InstallLifecycle.ps1` to check the release's own installer is used. | 4 | retire | re-pointed at `tools/test-built-release.ts` (session 5 step 2) | `selftest.ts:8246-8248` records the defect: the fixture ran the checkout's `install.ps1`, not the release's (S74 row 2) | old only |
| `kernel/test/selftest.ts:9931-9932` (section 110) | Reads `install.ps1` to confirm `-Rollback` forwards to the kernel. | 3 | port | kept (listed exception) | none found | old only |
| `kernel/test/selftest.ts:10386-10421` (section 117) | Judges a built release: no `.ps1` outside `install.ps1` and the adapter closure. | 3 | port | kept; plan adds the hidden-module closure case (session 6 step 3) | none found | old only |
| `kernel/test/selftest.ts:10462-10490` (section 118) | Every `tools/*.ps1` a kernel remedy names must be one the release ships, after rewrite. | 3 | port | kept while advice names `.ps1` | none found | old only |
| `kernel/test/selftest.ts:10538-10639` (section 120) | Allowlist of kernel strings that name a `.ps1` helper or a PowerShell parameter. | 3 | port | shrinks as advice is rewritten | none found | old only |
| `kernel/test/selftest.ts:11664-11695` (section 132) | Copies and runs `install.ps1` through `powershell.exe` against a release. | 3 | port | kept (listed exception), release tier | none found | old only |
| `kernel/test/selftest.ts:12119` (section 137) | Runs the previous release's `install.ps1`. | 3 | port | kept, release tier | none found | old only |
| `kernel/test/selftest.ts:12083-12084` (section 136) | Fails if `install.ts`, `bootstrap.ts` or `finisher.ts` name `powershell` in code. | n/a | port | kept | none found | old only |
| `kernel/test/selftest.ts:14389` (section 162) | Reads `tools/PublicTreeAllowlist.ps1` as text: `templates` is an include root. | 3 | port | read `tools/export-public-tree.ts` instead (session 5 step 1) | none found | old only |
| `kernel/test/selftest.ts:10177` (section 114) | Asserts the retired `Get-PlaybookContext.ps1` is gone. | n/a | port | kept (negative check) | none found | old only |
| `kernel/test/selftest.ts` sections 39, 48 (`:3406`, `:4545`), 115, 116 (`:10240,10274,10300`), 50 (`:4711`) | Start `powershell.exe` (no `.ps1`): Codex's Windows hook shell; process start time; `Compress-Archive` for a test ZIP. | OS call | port | 39, 48 stay (they test Codex's real shell); 115/116 as `procstart.ts`; 50 could use the kernel's ZIP writer (unverified) | none found | old only |
| `kernel/test/selftest.ts`, other hits | Sections 1, 16-23, 36, 47, 63, 69, 89, 96, 101, 102, 113, 141, 204: `.ps1` names as test data or fake fixture files (`'# fixture'`), no real `.ps1` opened. | n/a | retire | no change needed | none found | old only |
| Mentions only, no dependency | `.claude-plugin/hooks/hooks.json:17`, `.codex-plugin/hooks.json:17` (a tool named `PowerShell`); `.codex-plugin/hooks.json:2`, `.codex-plugin/mcp.json:2`; `.gitignore:26,61,70`; `install.sh:4,19`; `tools/acceptance-verdicts.json:2,23,37`; `tools/AcceptanceEmbeddingStandIn.mjs:9`; `kernel/test/context-budget.json:2`. | n/a | retire | comments refreshed when convenient | none found | old only |

##### `.claude/settings.json` allow lines (one per line)

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `.claude/settings.json:15` | Allows `powershell.exe -File tools/Set-VirtualDesk.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `desk open/close` | none found | old only |
| `.claude/settings.json:16` | Allows `powershell.exe -File tools/Reset-LocalNotebook.ps1`. | 2a (fixture) | retire | line removed when the script retires; kernel verb `reset` | none found | old only |
| `.claude/settings.json:17` | Allows `powershell.exe -File tools/Publish-BookCopy.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `publish` | none found | old only |
| `.claude/settings.json:18` | Allows `powershell.exe -File tools/Publish-ShelfBookToShared.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `publish` | none found | old only |
| `.claude/settings.json:19` | Allows `powershell.exe -File tools/Publish-ShelfBookBatchToShared.ps1`. | 3 | retire | line removed when the script retires; kernel verb `publish` (batch) | none found | old only |
| `.claude/settings.json:20` | Allows `powershell.exe -File tools/New-ProjectHub.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `hub new` | none found | old only |
| `.claude/settings.json:21` | Allows `powershell.exe -File tools/Archive-ProjectHub.ps1`. | 3 | retire | line removed when the script retires; kernel verb `hub archive` | none found | old only |
| `.claude/settings.json:22` | Allows `powershell.exe -File tools/Compile-RawBatchToNotebook.ps1`. | 3 | retire | line removed when the script retires; kernel verb `compile` | none found | old only |
| `.claude/settings.json:23` | Allows `powershell.exe -File tools/Copy-LocalPagesToProject.ps1`. | 3 | retire | line removed when the script retires; kernel verb `hub copy-pages` | none found | old only |
| `.claude/settings.json:24` | Allows `powershell.exe -File tools/Edit-ProjectHub.ps1`. | 3 | retire | line removed when the script retires; kernel verb `hub edit` | none found | old only |
| `.claude/settings.json:25` | Allows `powershell.exe -File tools/Get-DeskOverview.ps1`. | 3 (adapter closure) | retire | line removed when the script retires; kernel verb `desk` | none found | old only |
| `.claude/settings.json:26` | Allows `powershell.exe -File tools/Get-MeterStatus.ps1`. | 5 (unverified) | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:27` | Allows `powershell.exe -File tools/Get-TokenBaseline.ps1`. | 5 (unverified) | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:28` | Allows `powershell.exe -File tools/Add-ShelfNote.ps1`. | 3; also 2 (5 rows) | retire | line removed when the script retires; kernel verb `capture` | none found | old only |
| `.claude/settings.json:29` | Allows `powershell.exe -File tools/Add-ShelfBookPage.ps1`. | 3 | retire | line removed when the script retires; kernel verb `book add-page` | none found | old only |
| `.claude/settings.json:30` | Allows `powershell.exe -File tools/Add-ShelfBookTopic.ps1`. | 3 | retire | line removed when the script retires; kernel verb `book graduate` (unverified) | none found | old only |
| `.claude/settings.json:31` | Allows `powershell.exe -File tools/Rename-ShelfBook.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf rename` | none found | old only |
| `.claude/settings.json:32` | Allows `powershell.exe -File tools/Invoke-LibraryChecks.ps1`. | gate runner (1 and 4) | retire | line removed when the script retires; `tools/gate.ts` | none found | old only |
| `.claude/settings.json:33` | Allows `powershell.exe -File tools/Test-HubMigrationAcceptance.ps1`. | 4 | retire | line removed when the script retires; covering section or row (unverified) | none found | old only |
| `.claude/settings.json:34` | Allows `powershell.exe -File tools/New-HubMigrationSnapshot.ps1`. | 5 (unverified) | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:35` | Allows `powershell.exe -File tools/Initialize-CodexLibrary.ps1`. | 3 | retire | line removed when the script retires; kernel verb `init` / `basic-memory setup` (unverified) | none found | old only |
| `.claude/settings.json:36` | Allows `powershell.exe -File tools/Restore-BookSource.ps1`. | 3 | retire | line removed when the script retires; kernel verb `book sources` (unverified) | none found | old only |
| `.claude/settings.json:37` | Allows `powershell.exe -File tools/Update-BookManifests.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf rebuild` (unverified) | none found | old only |
| `.claude/settings.json:38` | Allows `powershell.exe -File tools/Update-SharedBookManifests.ps1`. | 3 | retire | line removed when the script retires; kernel verb `collection` (unverified) | none found | old only |
| `.claude/settings.json:39` | Allows `powershell.exe -File tools/Set-TopicOverlap.ps1`. | 5 (unverified) | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:40` | Allows `powershell.exe -File tools/Remove-SharedEntry.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shared archive` (unverified) | none found | old only |
| `.claude/settings.json:41` | Allows `powershell.exe -File tools/Add-CatalogEntry.ps1`. | 3 | retire | line removed when the script retires; kernel `shared` writers (unverified) | none found | old only |
| `.claude/settings.json:42` | Allows `powershell.exe -File tools/Get-WikiMigrationInventory.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:43` | Allows `powershell.exe -File tools/Import-ExternalWikiToShelf.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:44` | Allows `powershell.exe -File tools/Archive-SharedBook.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shared archive` | none found | old only |
| `.claude/settings.json:45` | Allows `powershell.exe -File tools/Find-ShelfDuplicateTopics.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf duplicates` | none found | old only |
| `.claude/settings.json:46` | Allows `powershell.exe -File tools/Search-RawBatch.ps1`. | 3 | retire | line removed when the script retires; kernel verb `raw search` | none found | old only |
| `.claude/settings.json:47` | Allows `powershell.exe -File tools/Set-RawBatchOwner.ps1`. | 3 | retire | line removed when the script retires; no writer verb found (`raw owners` reads) | none found | old only |
| `.claude/settings.json:48` | Allows `powershell.exe -File tools/Archive-ShelfBook.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf archive` / `shelf restore` | none found | old only |
| `.claude/settings.json:49` | Allows `powershell.exe -File tools/Remove-ShelfBook.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf remove` | none found | old only |
| `.claude/settings.json:50` | Allows `powershell.exe -File tools/Set-ShelfBookPageStub.ps1`. | 3 | retire | line removed when the script retires; kernel verb `shelf stub` | none found | old only |
| `.claude/settings.json:51` | Allows `powershell.exe -File tools/Remove-MemoryProject.ps1`. | 5 (unverified) | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:52` | Allows `powershell.exe -File tools/Get-LibraryTriageInventory.ps1`. | 3 (adapter closure) | retire | line removed when the script retires; kernel verb `triage inventory` | none found | old only |
| `.claude/settings.json:53` | Allows `powershell.exe -File tools/Sync-RawUpstream.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:54` | Allows `powershell.exe -File tools/Get-BookCurrency.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:55` | Allows `powershell.exe -File tools/Invoke-LibraryTriage.ps1`. | 2 (11 rows); also 3 | retire | line removed when the script retires; kernel verb `triage batch` (partial) | none found | old only |
| `.claude/settings.json:56` | Allows `powershell.exe -File tools/Start-LibrarySeat.ps1`. | 3 | retire | line removed when the script retires; kernel verb `seat start` | none found | old only |
| `.claude/settings.json:57` | Allows `powershell.exe -File tools/Retire-Seat.ps1`. | 2a (fixture) | retire | line removed when the script retires; kernel verb `seat retire` | none found | old only |
| `.claude/settings.json:58` | Allows `powershell.exe -File tools/Set-NotebookTopicOwner.ps1`. | 5 (ADR-0029 retired topic ownership) | retire | line removed when the script retires; kernel `notebook own` refuses; none | none found | old only |
| `.claude/settings.json:59` | Allows `powershell.exe -File tools/Start-LibrarySeat.ps1`. Duplicate of `:56`. | 3 | retire | line removed when the script retires; kernel verb `seat start` | none found | old only |
| `.claude/settings.json:60` | Allows `powershell.exe -File tools/Retire-Seat.ps1`. Duplicate of `:57`. | 2a (fixture) | retire | line removed when the script retires; kernel verb `seat retire` | none found | old only |
| `.claude/settings.json:61` | Allows `powershell.exe -File tools/Enter-LibrarySeat.ps1`. | 3 | retire | line removed when the script retires; kernel verb `seat enter` | none found | old only |
| `.claude/settings.json:62` | Allows `powershell.exe -File tools/Restore-NotebookQuarantine.ps1`. | 3 | retire | line removed when the script retires; kernel verb `reset restore` | none found | old only |
| `.claude/settings.json:63` | Allows `powershell.exe -File tools/Remove-NotebookQuarantine.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:64` | Allows `powershell.exe -File tools/Remove-SeatArchive.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:65` | Allows `powershell.exe -File tools/New-ShelfBook.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `shelf new` | none found | old only |
| `.claude/settings.json:66` | Allows `powershell.exe -File tools/Move-LibraryFolder.ps1`. | 3 | retire | line removed when the script retires; no kernel verb found | none found | old only |
| `.claude/settings.json:67` | Allows `powershell.exe -File tools/Export-CollectionToVault.ps1`. | 3 | retire | line removed when the script retires; kernel verb `migrate` (unverified) | none found | old only |
| `.claude/settings.json:68` | Allows `powershell.exe -File tools/Export-PublicTree.ps1`. | 3 | retire | line removed when the script retires; `tools/export-public-tree.ts` | none found | old only |
| `.claude/settings.json:69` | Allows `powershell.exe -File tools/Export-MirrorOpsRepo.ps1`. | 3 | retire | line removed when the script retires; `tools/*.ts` mirror export (name unverified) | none found | old only |
| `.claude/settings.json:70` | Allows `powershell.exe -File tools/Build-KernelRelease.ps1`. | 3 | retire | line removed when the script retires; `tools/build-release.ts` | none found | old only |
| `.claude/settings.json:71` | Allows `powershell.exe -File tools/Initialize-LibraryWorkspace.ps1`. | 2a (fixture builder) | retire | line removed when the script retires; kernel verb `init` | none found | old only |
| `.claude/settings.json:72` | Allows `powershell.exe -File tools/Set-CollectionOwner.ps1`. | 2a (seed writer) | retire | line removed when the script retires; kernel verb `collection owner` | none found | old only |

##### Documents (one summary row per file)

"Names" lists up to five `.ps1` files the document mentions. Decision `retire` here means the mention goes; history
documents (plans, review logs, ADRs) stay as written.

| File or check | What it does | Class | Decision | Where it goes | Defect it has caught | State |
| --- | --- | --- | --- | --- | --- | --- |
| `.claude/rules/library-development.md` (18 hits) | Path-scoped development rule; names `_helpers.json` and PowerShell tools. Names: Invoke-LibraryChecks.ps1, RawSearch.ps1, BookManifestTransaction.ps1, BookRootSchema.ps1, Update-SharedBookManifests.ps1 +8 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `.claude/skills/library-help/SKILL.md` (4 hits) | Skill text shipped to readers; names helpers. Names: install.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `.claude/skills/library-help/references/books-and-projects.md` (1 hits) | Skill reference shipped to readers. Names: "PowerShell" only. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `AGENTS.md` (14 hits) | Agent instructions: run `Invoke-LibraryChecks.ps1` (`:81`), the "No new PowerShell" rule. Changes at the flip (session 2 step 4). Names: Guard-BasicMemoryRead.ps1, Reset-LocalNotebook.ps1, Invoke-LibraryChecks.ps1, Test-McpHelpers.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `CLAUDE.md` (7 hits) | Program checkout instructions. Names: Get-DeskOverview.ps1, Set-VirtualDesk.ps1, New-ProjectHub.ps1, Add-ShelfNote.ps1, Add-ShelfBookPage.ps1 +1 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `CONTEXT.md` (4 hits) | Contract document: `context.seat-vocabulary` reads it (`docs-gate.ts:57`). Names: Start-LibrarySeat.ps1, Enter-LibrarySeat.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `CONTRIBUTING.md` (6 hits) | Contributor guide: PowerShell gate and tools. Names: Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `PLAN-REVIEW-LOG-assistant-onboarding.md` (22 hits) | Plan review log (history). Names: install.ps1, Test-InstallOnboarding.ps1, AcceptanceMatrix.ps1, Initialize-LibraryWorkspace.ps1, deskpost-install.ps1 +2 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-basic-memory.md` (1 hits) | Plan review log (history). Names: install.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-book-currency.md` (16 hits) | Plan review log (history). Names: Sync-RawUpstream.ps1, Edit-ProjectHub.ps1, Restore-BookSource.ps1, SharedBookSource.ps1, BookManifestStore.ps1 +4 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-correct-and-find.md` (1 hits) | Plan review log (history). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-dev-architecture.md` (26 hits) | Plan review log (history). Names: Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1, Get-DeskOverview.ps1, Set-CurrencySource.ps1, Publish-SharedBookCandidate.ps1 +7 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-install-onboarding.md` (36 hits) | Plan review log (history). Names: Build-KernelRelease.ps1, install.ps1, SeatPicker.ps1, SeatConversation.ps1, Start-LibrarySeat.ps1 +3 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-local-collection-writers.md` (9 hits) | Plan review log (history). Names: Invoke-AcceptanceMatrix.ps1, AcceptanceFixtures.ps1, Get-DeskOverview.ps1, Set-VirtualDesk.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-many-libraries.md` (2 hits) | Plan review log (history). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-multi-desk.md` (14 hits) | Plan review log (history). Names: Restore-BookSource.ps1, Edit-ProjectHub.ps1, BookRootSchema.ps1, Archive-ShelfBook.ps1, Get-VirtualDeskContext.ps1 +7 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-one-upgrade.md` (21 hits) | Plan review log (history). Names: install.ps1, Test-InstallLifecycle.ps1, Finish-Uninstall.ps1, Get-SeatStartContext.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-public-release.md` (136 hits) | Plan review log (history). Names: Initialize-CodexLibrary.ps1, Invoke-LibraryChecks.ps1, BookWriteGuard.ps1, SharedCollectionFiles.ps1, Get-PlaybookContext.ps1 +45 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-seat-identity.md` (7 hits) | Plan review log (history). Names: Invoke-LibraryChecks.ps1, Invoke-LibraryTriage.ps1, ShelfNoteCommon.ps1, Get-LibraryTriageInventory.ps1, Add-ShelfNote.ps1 +1 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-seat-launch.md` (19 hits) | Plan review log (history). Names: Enter-LibrarySeat.ps1, BookRootSchema.ps1, LibrarySeat.ps1, Validated-BookReader.ps1, Retire-Seat.ps1 +6 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-seats-team.md` (2 hits) | Plan review log (history). Names: SeatCreation.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-support-seats.md` (3 hits) | Plan review log (history). Names: Invoke-LibraryChecks.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG-token-efficiency.md` (18 hits) | Plan review log (history). Names: Edit-ProjectHub.ps1, Invoke-LibraryChecks.ps1, Test-McpHelpers.ps1, Test-LibraryHelpers.ps1, Test-HubMigrationAcceptance.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-REVIEW-LOG.md` (23 hits) | Plan review log (history). Names: Invoke-LibraryHandoff.ps1, Test-ShelfNoteBoundary.ps1, Add-ShelfNote.ps1, New-LibraryHandoffPlan.ps1, Publish-BookCopy.ps1 +9 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-assistant-onboarding.md` (27 hits) | Plan (history or design). Names: install.ps1, Test-InstallOnboarding.ps1, AcceptanceFixtures.ps1, Export-MirrorOpsRepo.ps1, Test-KernelUpgrade.ps1 +1 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-basic-memory.md` (5 hits) | Plan (history or design). Names: Initialize-CodexLibrary.ps1, Update-SharedBookManifests.ps1, Export-CollectionToVault.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-book-currency.md` (49 hits) | Plan (history or design). Names: Compile-RawBatchToNotebook.ps1, GitSource.ps1, Sync-RawUpstream.ps1, Get-BookCurrency.ps1, SourcesBlock.ps1 +14 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-correct-and-find.md` (5 hits) | Plan (history or design). Names: SeatPicker.ps1, AcceptanceFixtures.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-defect-clearing.md` (44 hits) | Plan (history or design). Names: Invoke-LibraryChecks.ps1, Set-NotebookTopicOwner.ps1, Guard-ShellShelfRead.ps1, Compile-RawBatchToNotebook.ps1, Rename-ShelfBook.ps1 +13 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-dev-architecture.md` (13 hits) | Plan (history or design). Names: New-ProjectHub.ps1, Edit-ProjectHub.ps1, Add-ShelfNote.ps1, Validated-BookReader.ps1, Invoke-LibraryChecks.ps1 +3 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-holding-discipline.md` (38 hits) | Plan (history or design). Names: Add-ShelfNote.ps1, Invoke-LibraryTriage.ps1, Get-DeskOverview.ps1, AcceptanceMatrix.ps1, TriagePlanCommon.ps1 +6 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-hub-rename.md` (1 hits) | Plan (history or design). Names: Archive-ProjectHub.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-install-onboarding.md` (66 hits) | Plan (history or design). Names: install.ps1, Start-LibrarySeat.ps1, SeatPicker.ps1, SeatConversation.ps1, Validated-BookReader.ps1 +7 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-install-without-powershell.md` (49 hits) | Plan (history or design). Names: install.ps1, Test-InstallOnboarding.ps1, Test-InstallProof.ps1, Test-KernelUpgrade.ps1, Build-KernelRelease.ps1 +4 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-local-collection-writers.md` (20 hits) | Plan (history or design). Names: Get-PlaybookContext.ps1, Set-NotebookTopicOwner.ps1, NotebookIndex.ps1, Copy-LocalPagesToProject.ps1, Invoke-LibraryChecks.ps1 +3 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-many-libraries.md` (2 hits) | Plan (history or design). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-migrate-to-deskpost-dev.md` (19 hits) | Plan (history or design). Names: Test-BuiltRelease.ps1, Restore-BookSource.ps1, Publish-BookCopy.ps1, Invoke-LibraryTriage.ps1, Start-LibrarySeat.ps1 +5 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-multi-desk.md` (41 hits) | Plan (history or design). Names: Compile-RawBatchToNotebook.ps1, Invoke-LibraryTriage.ps1, Restore-BookSource.ps1, Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1 +20 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-no-powershell-runtime.md` (60 hits) | Plan (history or design). Names: Validated-BookReader.ps1, Get-PlaybookContext.ps1, Enter-LibrarySeat.ps1, HookContext.ps1, Restore-CompactedGuidance.ps1 +18 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-notebook-drain.md` (54 hits) | Plan (history or design). Names: TriagePlanCommon.ps1, Get-LibraryTriageInventory.ps1, Test-ShelfNoteBoundary.ps1, Test-LibraryHelpers.ps1, Guard-ShelfBookRead.ps1 +19 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-one-step-upgrade.md` (25 hits) | Plan (history or design). Names: install.ps1, Test-InstallProof.ps1, Test-KernelUpgrade.ps1, Test-InstallOnboarding.ps1, prepare.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-one-upgrade.md` (44 hits) | Plan (history or design). Names: Test-InstallProof.ps1, Test-InstallLifecycle.ps1, install.ps1, Finish-Uninstall.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-public-release.md` (44 hits) | Plan (history or design). Names: Invoke-DshRun.ps1, Invoke-ReasonixRun.ps1, SharedCollectionFiles.ps1, Invoke-LibraryChecks.ps1, Export-PublicTree.ps1 +50 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-seat-identity.md` (6 hits) | Plan (history or design). Names: Get-BookCurrency.ps1, Invoke-LibraryTriage.ps1, Add-ShelfNote.ps1, Rename-ShelfBook.ps1, ShelfNoteCommon.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-seat-launch.md` (48 hits) | Plan (history or design). Names: Invoke-SeatClaimHolder.ps1, Enter-LibrarySeat.ps1, SeatPicker.ps1, Start-LibrarySeat.ps1, LibrarySeat.ps1 +11 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-seat-messaging.md` (1 hits) | Plan (history or design). Names: Get-DeskOverview.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-seat-network.md` (14 hits) | Plan (history or design). Names: Add-ShelfNote.ps1, Get-DeskOverview.ps1, Initialize-LibraryWorkspace.ps1, ShelfNoteCommon.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-seats-team.md` (4 hits) | Plan (history or design). Names: SeatCreation.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-shelf-recall.md` (9 hits) | Plan (history or design). Names: Restore-BookSource.ps1, Invoke-LibraryChecks.ps1, AcceptanceMatrix.ps1, Invoke-AcceptanceMatrix.ps1, LibrarySeat.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-support-seats.md` (4 hits) | Plan (history or design). Names: Invoke-LibraryChecks.ps1, Initialize-CodexLibrary.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN-token-efficiency.md` (19 hits) | Plan (history or design). Names: Get-TokenBaseline.ps1, Get-MeterStatus.ps1, Invoke-LibraryChecks.ps1, Edit-ProjectHub.ps1, Test-McpHelpers.ps1 +3 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `PLAN.md` (68 hits) | Plan (history or design). Names: Test-McpHelpers.ps1, Invoke-LibraryChecks.ps1, Invoke-LibraryHandoff.ps1, Publish-BookCopy.ps1, ShelfNoteCommon.ps1 +32 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `README.md` (13 hits) | Public readme: the `install.ps1` one-liner (listed exception). Names: install.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | `install.ps1` mentions kept (listed exception); others rewritten when ported | none found | old only |
| `docs/_index.md` (8 hits) | Design or how-to prose. Names: install.ps1, SeatPicker.ps1, Get-PlaybookContext.ps1, Finish-Uninstall.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/adr/0001-shelf-books-accept-pages-when-open.md` (2 hits) | ADR (a dated decision record). Names: Publish-BookCopy.ps1, Add-ShelfNote.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0003-decisions-follow-their-subject.md` (4 hits) | Contract document: `hub.dev-template-seeds-sections` reads it (`docs-gate.ts:61`). Names: Add-ShelfNote.ps1, New-ProjectHub.ps1, Edit-ProjectHub.ps1, Copy-LocalPagesToProject.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/adr/0004-the-reasonix-delegate-line-is-retired.md` (5 hits) | ADR (a dated decision record). Names: Invoke-ReasonixRun.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0005-the-hub-page-size-harness-stays-a-throwaway.md` (4 hits) | ADR (a dated decision record). Names: New-HubMigrationSnapshot.ps1, Test-HubMigrationAcceptance.ps1, Edit-ProjectHub.ps1, Get-HubPageSizes.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0006-reset-vocabulary-routes-to-the-library-reset.md` (1 hits) | ADR (a dated decision record). Names: Reset-LocalNotebook.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0007-the-desk-hook-advertises-the-reader-by-exact-name.md` (1 hits) | ADR (a dated decision record). Names: Get-VirtualDeskContext.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0008-a-root-plan-names-the-project-that-owns-it.md` (1 hits) | ADR (a dated decision record). Names: Rename-ShelfBook.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0010-the-notebook-reset-preserves-the-desk.md` (5 hits) | ADR (a dated decision record). Names: Reset-LocalNotebook.ps1, Set-VirtualDesk.ps1, Get-DeskOverview.ps1, Test-LibraryHelpers.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0011-a-sanitized-upstream-identity-is-catalog-class.md` (6 hits) | ADR (a dated decision record). Names: Get-BookCurrency.ps1, BookManifest.ps1, BookManifestTransaction.ps1, BookManifestStore.ps1, Get-DeskOverview.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0012-archived-books-are-covered-by-search-and-labelled.md` (10 hits) | ADR (a dated decision record). Names: Archive-ShelfBook.ps1, BookDiscovery.ps1, BookFullText.ps1, BookRootSchema.ps1, Update-SharedBookManifests.ps1 +2 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md` (3 hits) | Contract document: `hub.sections-name-their-destinations` reads it (`docs-gate.ts:62`). Names: Edit-ProjectHub.ps1, New-ProjectHub.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md` (5 hits) | ADR (a dated decision record). Names: Get-PlaybookContext.ps1, Restore-CompactedGuidance.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0015-the-desk-is-per-seat-one-library-many-seats.md` (2 hits) | ADR (a dated decision record). Names: Start-LibrarySeat.ps1, BookRootSchema.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md` (1 hits) | ADR (a dated decision record). Names: Reset-LocalNotebook.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0017-the-always-on-margin-is-accepted-disciplines-do-not-move.md` (5 hits) | ADR (a dated decision record). Names: Invoke-LibraryChecks.ps1, Add-ShelfNote.ps1, Add-ShelfBookPage.ps1, SearchBoundaries.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md` (4 hits) | ADR (a dated decision record). Names: Enter-LibrarySeat.ps1, Edit-ProjectHub.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0019-a-topics-ownership-changes-only-under-its-topic-lock.md` (1 hits) | ADR (a dated decision record). Names: Set-NotebookTopicOwner.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0020-a-capture-books-name-does-not-reuse-a-glossary-term.md` (2 hits) | ADR (a dated decision record). Names: Rename-ShelfBook.ps1, BookWriteGuard.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0022-reachability-names-the-destination-class.md` (7 hits) | ADR (a dated decision record). Names: Get-LibraryTriageInventory.ps1, Archive-SharedBook.ps1, Archive-ProjectHub.ps1, Set-VirtualDesk.ps1, Reset-LocalNotebook.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md` (3 hits) | ADR (a dated decision record). Names: Reset-LocalNotebook.ps1, NotebookOwnership.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0024-removal-from-the-notebook-has-no-destination.md` (6 hits) | ADR (a dated decision record). Names: TriagePlanCommon.ps1, Test-ShelfNoteBoundary.ps1, Test-LibraryHelpers.ps1, Restore-NotebookQuarantine.ps1, Add-ShelfBookPage.ps1 +1 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0025-a-protected-topic-states-whether-it-can-be-rebuilt.md` (7 hits) | ADR (a dated decision record). Names: NotebookOwnership.ps1, Restore-BookSource.ps1, Reset-LocalNotebook.ps1, Set-NotebookTopicOwner.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0026-a-hub-section-states-the-current-position.md` (3 hits) | ADR (a dated decision record). Names: Invoke-LibraryChecks.ps1, New-ProjectHub.ps1, Edit-ProjectHub.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md` (9 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0029-the-notebook-belongs-to-the-seat.md` (3 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0033-the-operator-seat-is-excused-from-the-engage-scan.md` (3 hits) | ADR (a dated decision record). Names: Move-LibraryFolder.ps1, Test-LibraryFolderMove.ps1, Edit-ProjectHub.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0034-the-vault-export-activates-by-two-renames.md` (1 hits) | ADR (a dated decision record). Names: Export-CollectionToVault.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0035-the-public-tree-export-seeds-once.md` (2 hits) | ADR (a dated decision record). Names: Export-PublicTree.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0036-a-direct-install-registers-its-guards-from-library-init.md` (5 hits) | ADR (a dated decision record). Names: Initialize-LibraryWorkspace.ps1, PluginPackage.ps1, Guard-SettingsIntegrity.ps1, CodexBindings.ps1, Initialize-CodexLibrary.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0037-a-seat-starts-in-the-workspace-it-is-a-seat-in.md` (3 hits) | ADR (a dated decision record). Names: Start-LibrarySeat.ps1, Get-DeskOverview.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0038-an-installed-library-is-rooted-at-its-current-link.md` (3 hits) | ADR (a dated decision record). Names: install.ps1, Test-KernelUpgrade.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0039-an-independent-row-is-judged-against-the-kernel-under-test.md` (3 hits) | ADR (a dated decision record). Names: Test-NotebookMigration.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0040-a-posix-workspace-is-an-absolute-path-bound-to-the-binary.md` (8 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0041-library-init-lays-out-the-holding-shelf-and-report-inbox.md` (3 hits) | ADR (a dated decision record). Names: Add-ShelfNote.ps1, Invoke-LibraryTriage.ps1, New-ShelfBook.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0042-a-plugin-guarded-workspace-a-posix-remedy-and-a-held-seat.md` (3 hits) | ADR (a dated decision record). Names: Start-LibrarySeat.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0043-a-judge-drives-the-kernels-real-verbs.md` (3 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0044-basic-memory-is-optional-and-the-public-install-is-local.md` (4 hits) | ADR (a dated decision record). Names: Enter-LibrarySeat.ps1, New-ProjectHub.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md` (7 hits) | ADR (a dated decision record). Names: Set-VirtualDesk.ps1, install.ps1, AcceptanceMatrix.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0046-a-compiled-windows-init-registers-the-kernels-own-hooks.md` (8 hits) | ADR (a dated decision record). Names: Set-VirtualDesk.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0047-a-route-field-is-a-remedy-and-doctor-reads-codex-hook-review.md` (3 hits) | ADR (a dated decision record). Names: Restore-NotebookQuarantine.ps1, CodexBindings.ps1, AcceptanceMatrix.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0048-a-note-is-named-by-the-local-date-and-saving-is-not-reading.md` (4 hits) | ADR (a dated decision record). Names: Add-ShelfNote.ps1, Invoke-LibraryTriage.ps1, TriagePlanCommon.ps1, Test-ShelfNoteBoundary.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0049-a-local-collection-book-is-first-class-and-a-root-names-its-place.md` (2 hits) | ADR (a dated decision record). Names: Update-SharedBookManifests.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md` (1 hits) | ADR (a dated decision record). Names: Initialize-CodexLibrary.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0052-a-librarys-writes-stage-in-one-folder.md` (1 hits) | ADR (a dated decision record). Names: AtomicFile.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0054-a-shared-book-opens-on-a-local-library-and-rollback-checks-for-it.md` (5 hits) | ADR (a dated decision record). Names: install.ps1, Test-KernelUpgrade.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0055-the-command-is-deskpost-and-the-binary-stays-library-exe.md` (2 hits) | ADR (a dated decision record). Names: Invoke-LibraryChecks.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0056-doctor-and-init-speak-to-a-person-and-json-is-the-machine-form.md` (4 hits) | ADR (a dated decision record). Names: Test-KernelUpgrade.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0057-setup-asks-plans-and-applies-and-the-installer-only-fetches.md` (5 hits) | ADR (a dated decision record). Names: install.ps1, Build-KernelRelease.ps1, Test-InstallOnboarding.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0058-uninstall-reaches-only-what-deskpost-wrote-and-sessions-close-first.md` (6 hits) | ADR (a dated decision record). Names: install.ps1, Finish-Uninstall.ps1, Test-InstallLifecycle.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md` (7 hits) | ADR (a dated decision record). Names: Start-LibrarySeat.ps1, SeatPicker.ps1, SeatConversation.ps1, install.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0061-a-seats-added-folders-are-the-seats-own.md` (1 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0062-a-message-is-a-doorbell-and-a-letter-is-the-record.md` (3 hits) | ADR (a dated decision record). Names: Initialize-LibraryWorkspace.ps1, ShelfNoteCommon.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0063-one-upgrade-finishes-the-job.md` (3 hits) | ADR (a dated decision record). Names: install.ps1, Test-InstallProof.ps1, Test-InstallLifecycle.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0064-the-runtime-hooks-are-kernel-verbs.md` (15 hits) | ADR (a dated decision record). Names: Restore-CompactedGuidance.ps1, Add-SearchHitReminder.ps1, Get-SeatStartContext.ps1, Get-PlaybookContext.ps1, Test-LibraryHooks.ps1 +1 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0065-the-kernel-calls-the-finisher-and-the-release-start-no-powershell.md` (28 hits) | ADR (a dated decision record). Names: Finish-Uninstall.ps1, library.ps1, install.ps1, Build-KernelRelease.ps1, AcceptanceMatrix.ps1 +1 more. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0066-the-program-installs-itself.md` (18 hits) | ADR (a dated decision record). Names: install.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0067-a-running-image-in-a-tree-being-removed-is-moved-aside.md` (1 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0068-the-program-checks-for-and-fetches-its-own-upgrades.md` (3 hits) | ADR (a dated decision record). Names: install.ps1. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0069-the-program-addresses-links-and-counts-a-seat-decides-where-a-letter-goes.md` (1 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0070-a-book-page-is-corrected-in-place-through-a-writer-that-keeps-the-previous-text-and-a-book-keeps-its-source-list.md` (1 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/adr/0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md` (1 hits) | ADR (a dated decision record). Names: "PowerShell" only. | mixed (as named) | retire | no change: historical record | none found | old only |
| `docs/book-archive-model.md` (4 hits) | Design or how-to prose. Names: SharedCollectionFiles.ps1, Archive-SharedBook.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/book-currency-anchoring-deferred.md` (10 hits) | Design or how-to prose. Names: Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1, Set-CurrencySource.ps1, Get-BookCurrency.ps1, Publish-SharedBookCandidate.ps1 +2 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/book-currency-anchoring.md` (24 hits) | Design or how-to prose. Names: Compile-RawBatchToNotebook.ps1, GitSource.ps1, SourcesBlock.ps1, Sync-RawUpstream.ps1, Get-BookCurrency.ps1 +7 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/book-root-state-schema.md` (25 hits) | Design or how-to prose. Names: BookRootSchema.ps1, Archive-SharedBook.ps1, Set-VirtualDesk.ps1, Get-DeskOverview.ps1, SearchBoundaries.ps1 +10 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/capture-book-model.md` (19 hits) | Design or how-to prose. Names: Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1, Get-DeskOverview.ps1, Add-ShelfNote.ps1, Guard-ShelfBookRead.ps1 +8 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/claude-reader-compatibility.md` (5 hits) | Design or how-to prose. Names: "PowerShell" only. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/collection-ownership.md` (10 hits) | Design or how-to prose. Names: Set-CollectionOwner.ps1, CollectionOwnership.ps1, BookWriteGuard.ps1, SharedCollectionFiles.ps1, Initialize-CodexLibrary.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/cross-seat-reports.md` (22 hits) | Design or how-to prose. Names: ShelfNoteCommon.ps1, Add-ShelfNote.ps1, Get-DeskOverview.ps1, Guard-ShelfBookRead.ps1, Rename-ShelfBook.ps1 +8 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/derived-indexes.md` (27 hits) | Design or how-to prose. Names: Compile-RawBatchToNotebook.ps1, Get-DeskOverview.ps1, Invoke-LibraryTriage.ps1, Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1 +9 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/dev-session-loop.md` (10 hits) | The session loop: `-Fast` gate times and instructions. Changes at the flip (session 2 step 4). Names: DeploymentScan.ps1, Invoke-LibraryChecks.ps1, Invoke-AcceptanceMatrix.ps1, Initialize-CodexLibrary.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/discovery-manifests.md` (25 hits) | Design or how-to prose. Names: Invoke-LibraryChecks.ps1, BookManifest.ps1, ShelfNoteCommon.ps1, BookManifestStore.ps1, Guard-ShelfBookRead.ps1 +14 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/duplicate-topic-resolution.md` (2 hits) | Design or how-to prose. Names: Find-ShelfDuplicateTopics.ps1, Set-TopicOverlap.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/full-text-over-open-books.md` (8 hits) | Design or how-to prose. Names: SearchBoundaries.ps1, BookFullText.ps1, BookDiscovery.ps1, SharedBookSource.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/guides/README.md` (4 hits) | Design or how-to prose. Names: "PowerShell" only. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/guides/basic-memory.md` (2 hits) | Design or how-to prose. Names: "PowerShell" only. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/helper-write-and-output-contracts.md` (7 hits) | Design or how-to prose. Names: BookWriteGuard.ps1, LibraryOutput.ps1, Edit-ProjectHub.ps1, Move-LibraryFolder.ps1, Add-ShelfBookTopic.ps1 +2 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/history.md` (1 hits) | Design or how-to prose. Names: Set-TopicOverlap.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/hit-is-a-location.md` (10 hits) | Design or how-to prose. Names: SearchBoundaries.ps1, RawSearch.ps1, BookManifest.ps1, Invoke-LibraryChecks.ps1, Search-RawBatch.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/hook-enforced-boundaries.md` (19 hits) | Design or how-to prose. Names: HookContext.ps1, ShelfBoundary.ps1, BookRootSchema.ps1, HookRegistry.ps1, Set-VirtualDesk.ps1 +8 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/hub-migration-runbook.md` (11 hits) | Design or how-to prose. Names: Edit-ProjectHub.ps1, New-HubMigrationSnapshot.ps1, Test-HubMigrationAcceptance.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/librarian-operating-rules.md` (1 hits) | Design or how-to prose. Names: Get-DeskOverview.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/librarian-operation-playbooks.md` (82 hits) | Design or how-to prose. Names: LibraryDeployment.ps1, Get-MeterStatus.ps1, Initialize-CodexLibrary.ps1, Invoke-LibraryChecks.ps1, Compile-RawBatchToNotebook.ps1 +34 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/librarian-voice-and-wayfinding.md` (2 hits) | Design or how-to prose. Names: Search-RawBatch.ps1, SearchBoundaries.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/library-organization.md` (2 hits) | Design or how-to prose. Names: Move-LibraryFolder.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/library-triage-design.md` (22 hits) | Design or how-to prose. Names: Get-DeskOverview.ps1, Reset-LocalNotebook.ps1, Get-LibraryHandoffInventory.ps1, New-ProjectHub.ps1, Invoke-LibraryHandoff.ps1 +15 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/mcp-tool-allowlist-check.md` (3 hits) | Design or how-to prose. Names: McpToolInventory.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/mirror-publishing-job.md` (12 hits) | Design or how-to prose. Names: DeploymentScan.ps1, PublicTreeAllowlist.ps1, Export-MirrorOpsRepo.ps1, Build-KernelRelease.ps1, install.ps1 +1 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/model-division-of-labor.md` (7 hits) | Design or how-to prose. Names: Get-MeterStatus.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/notebook-and-desk-model.md` (26 hits) | Design or how-to prose. Names: Restore-NotebookQuarantine.ps1, Restore-BookSource.ps1, Set-VirtualDesk.ps1, Reset-LocalNotebook.ps1, Get-DeskOverview.ps1 +9 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/project-hub-design.md` (15 hits) | Contract document: `hub.*` checks read it against `New-ProjectHub.ps1` (`docs-gate.ts:60`). Names: Edit-ProjectHub.ps1, New-ProjectHub.ps1, Copy-LocalPagesToProject.ps1, Archive-ProjectHub.ps1, Set-VirtualDesk.ps1 +2 more. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/raw-batch-ownership.md` (10 hits) | Design or how-to prose. Names: RawBatchOwnership.ps1, Set-RawBatchOwner.ps1, RawSearch.ps1, Archive-ProjectHub.ps1, Set-TopicOverlap.ps1 +1 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/raw-to-notebook-compilation.md` (6 hits) | Design or how-to prose. Names: Compile-RawBatchToNotebook.ps1, Search-RawBatch.ps1, Invoke-LibraryTriage.ps1, Copy-LocalPagesToProject.ps1, Publish-BookCopy.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/reader-argument-validation.md` (3 hits) | Design or how-to prose. Names: McpToolInventory.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/real-session-verdicts-in-windows-sandbox.md` (5 hits) | Design or how-to prose. Names: runner.ps1, install.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/releasing.md` (2 hits) | Release steps naming the PowerShell build and publish tools. Rewritten in session 5 step 3. Names: Test-BuiltRelease.ps1, Build-KernelRelease.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/roadmap.md` (16 hits) | Design or how-to prose. Names: install.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/scoped-raw-search.md` (8 hits) | Design or how-to prose. Names: Search-RawBatch.ps1, RawSearch.ps1, SearchBoundaries.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/seats.md` (69 hits) | Contract document: `seats.*` checks read it against `SeatCreation.ps1`; the SessionStart hook serves it (`docs-gate.ts:58`). Names: Start-LibrarySeat.ps1, Set-NotebookTopicOwner.ps1, Enter-LibrarySeat.ps1, Get-DeskOverview.ps1, BookRootSchema.ps1 +20 more. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/shelf-book-graduation.md` (12 hits) | Design or how-to prose. Names: Publish-BookCopy.ps1, Import-ExternalWikiToShelf.ps1, Add-ShelfBookPage.ps1, Add-ShelfNote.ps1, Test-LibraryHelpers.ps1 +3 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/shelf-book-retirement.md` (21 hits) | Design or how-to prose. Names: Archive-ShelfBook.ps1, Archive-SharedBook.ps1, Archive-ProjectHub.ps1, BookWriteGuard.ps1, Set-ShelfBookPageStub.ps1 +9 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/shelf-desk-symmetry.md` (6 hits) | Design or how-to prose. Names: Guard-ShelfBookRead.ps1, Validated-BookReader.ps1, Get-DeskOverview.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/shelf-lifecycle.md` (6 hits) | Design or how-to prose. Names: Publish-ShelfBookToShared.ps1, Publish-ShelfBookBatchToShared.ps1, Set-TopicOverlap.ps1, Remove-ShelfBook.ps1, Archive-ShelfBook.ps1 +1 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/shelf-to-shared-publication.md` (2 hits) | Design or how-to prose. Names: Publish-ShelfBookToShared.ps1, Remove-ShelfBook.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/supported-operation-matrix.md` (150 hits) | Rendered from the matrix; `acceptance.matrix-doc-matches-rows` checks it (`docs-gate.ts:63`). Names: AcceptanceFixtures.ps1, AcceptanceMatrix.ps1, Invoke-AcceptanceMatrix.ps1, Test-NotebookMigration.ps1, Initialize-LibraryWorkspace.ps1 +54 more. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/templates/shelf-catalog-header.md` (1 hits) | Template that init and upgrade ship (`docs-gate.ts:59`). Names: Add-ShelfNote.ps1. | mixed (as named) | retire | rewritten in the session named, or with the checks that read it | none found | old only |
| `docs/topic-graduation.md` (10 hits) | Design or how-to prose. Names: Add-ShelfBookPage.ps1, BookWriteGuard.ps1, Test-LibraryHelpers.ps1, Add-ShelfBookTopic.ps1, ShelfNoteCommon.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/topic-overlap-records.md` (5 hits) | Design or how-to prose. Names: Set-TopicOverlap.ps1, Find-ShelfDuplicateTopics.ps1, Invoke-LibraryChecks.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `docs/workspace-wiki-migration.md` (2 hits) | Design or how-to prose. Names: Get-WikiMigrationInventory.ps1, Import-ExternalWikiToShelf.ps1. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `kernel/README.md` (35 hits) | Kernel readme: PowerShell oracle and helpers. Names: Invoke-AcceptanceMatrix.ps1, New-ProjectHub.ps1, Copy-LocalPagesToProject.ps1, Edit-ProjectHub.ps1, Archive-ProjectHub.ps1 +24 more. | mixed (as named) | retire | prose rewritten when the named tools are ported or retired | none found | old only |
| `llms-install.md` (11 hits) | Assistant install page: `install.ps1` (listed exception). Names: install.ps1. | mixed (as named) | retire | `install.ps1` mentions kept (listed exception); others rewritten when ported | none found | old only |

#### Notes

- **Plan line numbers that moved:** `doctor.ts:647-652` is now `:648-653`; selftest section 162's read is `:14389`
  (was `:14366`); the seat-picker dot-source is `:4990-4997` in section 51 (was `:4988-4992`); `lifecycle.ts:172` is
  `:172-173`. Unchanged: `init.ts:1129,1185`, `init.ts:496,665`, `releasefiles.ts:49`, `procstart.ts:102`,
  `seat.ts:1107`, `triagebatch.ts:245,526,828`, `selftest.ts:8251-8254` (section 91).
- **Not named in the plan:** self-test section 62 (`:6115-6122`) runs two `tools/*.ps1`; `tools/docs-gate.ts:370`
  reads `SearchBoundaries.ps1` as text; `.mcp.json` and the 9 hook registrations in `.claude/settings.json` run
  PowerShell in this checkout's own sessions; `.claude/hooks/payload-contract.json` is read only by PowerShell.
- **`doctor.ts:648-653` fails quietly after deletion:** `bookSlugDefault` returns null for a missing file, so the
  stale-Book check stops checking the helper defaults without saying so. Port or drop it deliberately.
- **Hooks: retire, not a listed exception (my call).** All 8 required hooks have kernel verbs. The catch: this
  checkout's own sessions, and a reader workspace initialised from source, register the `.ps1` scripts because no
  `bin/library.exe` exists (`init.ts:420-426`). Re-pointing needs a from-source spelling (for example
  `node kernel/src/cli.ts hook <verb>`) whose per-prompt start-up cost is unmeasured. If that is too slow, the hooks
  become a listed exception instead.
- **Uncertain class calls:** the adapter is 3 first (a reader needs it), 2 second (20 differential rows plus 1
  independent). `library.ps1` is 2 only (2 rows) though it is also a dev convenience. `HookContext`, `ProgramRoot` and
  `ShelfBoundary` are "2 transitively" since they serve only the hooks and two test suites. `install.ps1` is 3, with
  its port already done.
- **Allow-line classes and verbs are provisional:** taken from `remedy.ts:57-131` (helper-to-verb rewrites),
  `verbs.ts` usage strings, and the plan's 2a list. Helpers with no kernel verb found: `Get-MeterStatus`,
  `Get-TokenBaseline`, `New-HubMigrationSnapshot`, `Set-TopicOverlap`, `Get-WikiMigrationInventory`,
  `Import-ExternalWikiToShelf`, `Remove-MemoryProject`, `Sync-RawUpstream`, `Get-BookCurrency`,
  `Remove-NotebookQuarantine`, `Remove-SeatArchive`, `Move-LibraryFolder`. `Start-LibrarySeat` and `Retire-Seat`
  appear twice (`:56,59` and `:57,60`).
- **Adapter closure recomputed:** 25 files (the adapter and 24 `tools/*.ps1`), same as the plan's count.
- **Line counts (`wc -l`):** `Validated-BookReader.ps1` 1576; `Add-SearchHitReminder.ps1` 64;
  `Get-SeatStartContext.ps1` 300; `Get-VirtualDeskContext.ps1` 214; `Guard-BasicMemoryRead.ps1` 239;
  `Guard-SettingsIntegrity.ps1` 155; `Guard-ShelfBookRead.ps1` 307; `Guard-ShellShelfRead.ps1` 294;
  `HookContext.ps1` 277; `ProgramRoot.ps1` 87; `Restore-CompactedGuidance.ps1` 141; `ShelfBoundary.ps1` 243;
  `install.ps1` 156; `library.ps1` 219. Total 4,272.
