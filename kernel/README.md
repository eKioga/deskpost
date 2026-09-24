# The kernel

The TypeScript implementation the PowerShell tools are being ported into
([ADR-0028](../docs/adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md),
`PLAN-public-release.md` steps 23–28). Started 2026-09-22 (S13).

## How it is judged

Not by its own tests. `docs/supported-operation-matrix.md` enumerates every operation the kernel must
carry, and `tools/Invoke-AcceptanceMatrix.ps1` runs each row against **both** implementations and
compares normalised outcomes — the return value *and* every file left under the workspace, because a
port that answers correctly and writes the wrong file is wrong and stdout would not say so.

```powershell
tools/Invoke-AcceptanceMatrix.ps1 -Area workspace -Kernel 'node kernel/src/cli.ts'
tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel 'node kernel/src/cli.ts' -RequireGreen
```

`node kernel/test/selftest.ts` is this package's own suite. It asserts what the matrix cannot: that
the argument list binds, that the serializer matches PowerShell's layout byte for byte, and that a
refusal reaches stderr with a non-zero exit. Every behavioural case spawns `src/cli.ts` as a **child
process** — a suite that reached a verb by importing its function would not have tested the front
door, which is the defect S12 recorded against the acceptance harness itself.

## What answers today

`library verbs` is the authority, and `acceptance.kernel-verbs-exist` reads it. `src/verbs.ts`
declares **every** verb the matrix names, ported or not, with the ledger row that carries it; an
unported verb refuses by name and its rows mismatch honestly rather than sitting pending.

| Verb | State |
| --- | --- |
| `init` | Ported. Marker, machine registry, managed instruction sections, `.mcp.json`, both harness settings files, both Codex bindings. Since S30, in both arms: the workspace's five folders, and -- with no endpoint -- the local collection (ADR-0030) with its id in `collection/.library/collection.json`; and a re-run keeps the marker's own `collection_id` (the Report Inbox's defect of 2026-09-22). |
| `mcp call` | Ported for `read_open_book_page` and `read_book_catalog` against a local Shelf, and `read_project_catalog` against the local collection (S30). Since S33 `read_project_catalog` (with `--shelf archive`) and `read_open_project_briefing` also answer from Basic Memory, through the Desk's pin, with the adapter's exact-record validation. A shared Book page and the shared Book Catalog still refuse, naming the missing endpoint. |
| `hub new` | Ported against the LOCAL collection (S30, `src/collection.ts`) and, since S33, against BASIC MEMORY: `src/basicmemory.ts` is the MCP transport and the deployment chain, `src/ownership.ts` the one-writable-workspace fence, read only. `New-ProjectHub.ps1` step for step -- fenced before a preflight too, its three reads, its write order and its sentence for what each failure leaves -- and its result's field names, which the local verb now reports as well (`project_path`, `connections_path`, where it said `project_root` and `connections`). A no-overwrite write that finds a note is a refusal: Basic Memory answers that `isError: false`, `action: conflict`, and the oracle reported `created` over it until S33. The deployment comes from the environment or the workspace's own `.claude/`, never the program root's. |
| `hub copy-pages` | Its PREFLIGHT, ported (S35, `src/hubcopy.ts`): `Copy-LocalPagesToProject.ps1` step for step -- the fence, the collection id, the destination whitelist, `Resolve-LocalSourceRoot` with its Desk gate for a capture note, the pages in `Sort-Object FullName` order, `-IncludePage`, `Assert-ProjectTargetSafe` on every target, both digests, and `New-ProjectHub`'s own preflight for `project_action`. `hub.local-pages-copy-into-a-project` is green against the NAS; because the harness normalises every digest and the `plan_id`, those were compared RAW by hand over one workspace, nine preflights and the existing-Hub branch (all identical), with a planted sort defect seen. **The confirmed copy since S39**: the Hub created when the plan said `create`, a read, compare and no-overwrite write per record with a readback, and the `complete` or `incomplete` journal -- three `hub.local-pages-copy-confirmed-*` rows, green against the NAS, a planted missing journal red on exactly its row. A local collection refuses by name. |
| `hub edit` | Ported (S34, `src/hubedit.ts`): `Edit-ProjectHub.ps1` step for step, against Basic Memory and the local collection. The text rules are the oracle's own -- all seven modes, the `Now` structure rule, the change counts, the three size warnings -- held to the oracle's functions extracted by AST over 25 inputs (25 identical) and pinned in self-test section 13; then the fence, THIS seat's Desk, the plan and its `plan_id`, and for a write the Hub's lock, a re-read that must still match the plan, the journal, the write and a readback that must equal it. Both `hub` edit rows are green against the NAS, the write's journal byte for byte. The size warnings go to stderr as `WARNING: ...` where the oracle uses `Write-Warning`; no row reaches one. |
| `hub archive`, `shared archive`, `shared list-entry` | Their PREFLIGHTS, ported (S34, `src/sharedwriters.ts`): `Archive-ProjectHub.ps1` (its paginated listing proved against the server's declared total), `Archive-SharedBook.ps1` and `Add-CatalogEntry.ps1`, each reading what its oracle reads with that oracle's own `include_frontmatter`, because a title parsed from a page with frontmatter is a different title. Their three rows are green against the NAS. **Their confirmed halves since S39** -- the native move, the link rewrites (a Book's body and metadata, written back with the leading newline Basic Memory returns for a body read without frontmatter), the reader-map proof, the archive Catalogs and the emptiness-sentence repair, the Catalog edit, and the husk cleanup -- each oracle run by hand in a disposable project first, held by six `*-confirmed-*` rows green against the NAS, with a planted defect per writer red on exactly the rows it reaches. The husk cleanup reads the share, and this machine's SMB client answers a listing it made within its cache lifetime from that listing: the oracle and the port then both report `not-empty` and leave the husk, so those rows settle the share before the arm (`share_settles_before_arm`). |
| `publish`, `publish batch`, `publish refresh` | Their PREFLIGHTS, ported (S35, `src/publish.ts`): `Publish-ShelfBookToShared.ps1`, `Publish-ShelfBookBatchToShared.ps1` and `Publish-BookCopy.ps1 -Destination Shared -FromShelf -ReplaceExisting`, around one core -- `Publish-SharedBookCandidate.ps1`'s preflight, whose frontmatter split, generated `_book` and `_index` (with `Get-ReaderMapLabel` whole, self-test section 14) and digests are the oracle's -- and, for `publish`, the kernel's own `shelf remove` plan nested without `schema`. All four `publication` preflight rows are green against the NAS, the three new ones seeded with the collection's ownership; their digests and `plan_id`s were compared RAW by hand over eight cases (identical). **The candidate's preflight reads nothing from the collection, and `-ReplaceExisting` is in neither its plan nor its `plan_id`**, so a refresh preflight is a first publication's document: carried, and recorded for the reader (S35). **`publish` and `publish refresh` confirmed since S39**: every page written, compared and read back, the root marked complete, the Catalog line inserted, replaced or moved and verified over the whole Catalog, both journals, and for `publish` the kernel's own `shelf remove` run after the publication verifies. Basic Memory writes a NEW note's frontmatter in the order its metadata arrives, so the root's metadata goes in the order PowerShell's hashtable enumerates it -- measured, and carried as a literal (`rootMetadata`). **`publish batch` confirmed since S40**: each bound child plan in order through the same two workflows, every item journalled before and after its child runs, a failed item left in place with its child's sentence while later items continue; the batch journal is named after the batch `plan_id`'s last sixteen characters, which the harness normalises by this arm's value. |
| `shelf render`, `shelf new` | Ported. |
| `shelf rename`, `remove`, `archive`, `restore`, `stub` | Ported (S14). One port, not five: they share the rollback journal under `internal/shelf-journals/` and the Discovery manifest transaction under `internal/book-manifests/`, so porting any one of them was porting all of it. |
| `shelf duplicates` | Ported (S41, `src/duplicates.ts`): `Find-ShelfDuplicateTopics.ps1` step for step -- the Books in filesystem order, each directory's own `_index.md` before its subdirectories' (measured), the cosine in the oracle's order, .NET Framework's half-to-even `Math.Round(x, 4)`, and a stable descending sort. Its row runs offline against the harness's embedding stand-in (`tools/AcceptanceEmbeddingStandIn.mjs`, integer vectors), never a reader's server. |
| `desk`, `desk open|close|clear` | Ported (S14). The overview reads this seat in full and every other seat as counts and liveness; the writes take the registry lock and require a matching live claim. Since S31 a bare-slug Desk line is `books/<slug>`, as `ConvertTo-BookRoot` has it -- it read as `shelf/<slug>` until `desk.a-bare-slug-on-the-desk-is-a-shared-book` existed to say so. |
| `hook shelf-read`, `hook shell-shelf-read` | Ported (S31, the first half of S20's port): `Guard-ShelfBookRead.ps1` and `Guard-ShellShelfRead.ps1`, a payload on stdin and a deny document or silence on stdout, judged by the 15 `guards` rows. Every failure is a denial. `.NET`'s `IsPathRooted` and `GetFullPath` are reproduced as measured (a trailing dot is stripped from a segment; `* ? < > " |` and a colon past the drive make a path `invalid`). **Two things are the kernel's, not the oracle's:** a Notebook write is judged as this kernel's writers judge one under ADR-0029 -- this seat's root only, and refused in a legacy, migrating or not-yet-active layout -- which section 11 of the self-test holds; and the workspace comes from `resolveWorkspace`, which lacks the oracle's anchor and selection-conflict refusals. **`hook basic-memory-read`** is ported (S32): `Guard-BasicMemoryRead.ps1`, judged by 14 more `guards` rows, one per branch, and by self-test section 12 where no row reaches -- .NET's `$` (it matches before a final newline, measured), StrictMode's missing-property sentence, and the empty `.open-projects` the oracle writes. Porting it found two holes in the ORACLE, fixed there first with a row each: a `..` segment walked a direct write out of an open Hub, and a tool name in another case skipped the edit-operation allowlist. **Since S36 the workspace is the oracle's**: `resolveWorkspace` carries the anchor (the program root, admitted only on a marker the registry does not contradict -- self-test section 15) and `Get-WorkspaceSelectionConflict`'s refusals, and four rows hold the selection refusals and a read into ANOTHER registered workspace, by absolute path and by a forward-slash shell token. **`hook settings-integrity`** (S36) is `Guard-SettingsIntegrity.ps1`, judged by nine `guards.settings-*` rows, and FAILS OPEN as its oracle does (section 16). Measuring it found three holes in the oracle, each a SILENT ALLOW of a settings file that registers no guard -- `{}` and a `null` hook entry made its walk throw, and a `Hooks` key was read case-insensitively -- fixed in `tools/HookRegistry.ps1` first, with a regression each in `Test-LibraryHooks.ps1` (3 of 3 red without the fix) and a row each. The registry judges moved from `doctor.ts` to `src/hookregistry.ts`, which both now use. What it concedes: a syntax error's sentence is this engine's (the refusal is compared, not the words), and a number's .NET type and an array-index-like event name's order are reconstructed from parsed JSON. **`hook desk-context`** (S36, `src/deskcontext.ts`) is `Get-VirtualDeskContext.ps1`, judged by seven `guards.desk-context-*` rows and `seat.desk-context-records-the-conversation-at-a-bound-seat`, which binds a stand-in agent and compares the recorded binding, history and serve ledger (`src/hookledger.ts`) byte for byte. Since S37 it takes `--reader-tool-prefix`, the reader's callable prefix, because the name a harness gives the reader depends on who registered it -- `mcp__validated-book-reader__` from a workspace's `.mcp.json` (the default, which every row holds), `mcp__plugin_deskpost_validated-book-reader__` from the Claude plugin, `mcp__validated_book_reader__` in Codex -- each measured in a real session; the plugin packager composes the flag, and self-test section 18 holds it. **Since S38 both Shelf guards take `--reader-tool-prefix` too**, because each denial names the reader -- the prefix rule and its one sentence are `src/readerprefix.ts`, and a prefix that names no tool fails the guard closed -- and `init` hands the Codex Desk hook and both Shelf guards Codex's form. And **the Basic Memory guard judges Codex's spelling**, `mcp__basic_memory__<tool>`, as the tool it is; only the exact lowercase prefix is rewritten. `hookregistry.ts`'s Codex rule gained a `sample`, a tool name the Basic Memory matcher must match, where until S38 any matcher passed. Nine rows hold the three, each red before its port. |
| the plugin | **Points at the binary** (S37): `.codex-plugin/hooks.json` registers `"${PLUGIN_ROOT}/bin/library" hook <verb>` for the four load-bearing hooks, and Claude's generated `.mcp.json` is `bin/library mcp serve`. Measured in a real Claude Code session (`--plugin-dir` on the installed release) and a real Codex one (the plugin installed into a scratch `CODEX_HOME`), each with every registration `library init` wrote set aside: a closed Book's page denied by the plugin's shell guard, a control command completing, the reader connected, and the Desk context naming the exact reader tool the session offered. **Codex's plugin carries no reader** (the reader's ruling): a Codex plugin server starts in the plugin cache with no MCP roots and none of the session's environment, so it cannot tell which workspace it serves. Since S38 its Basic Memory matcher is `^mcp__basic[-_]memory__.*$`, the union of the two harnesses' spellings, and both Shelf guards are handed the reader's prefix as the Desk hook is. `tools/PluginPackage.ps1` owns the rest -- see its header. |
| `mcp serve` | Ported (S36, `src/mcpserve.ts`): the adapter's stdio loop -- a workspace bound once at start and checked on every call, the seat resolved per request by agent ancestry, the launch warning on stderr, and the protocol edges measured from the oracle (case-insensitive methods and tool names, silence for an id-less or unparseable line, -32600 and -32601). Eight `reader.serve-*` rows, and self-test section 17 for a workspace re-initialised under a running server. `suggest_active_projects` answers since S38 (`Get-ProjectSuggestions`, two shared rows), against Basic Memory; a local-collection workspace is refused by name, since the adapter has no local counterpart to compare with. **`mcp call` now answers through the same dispatch**, and with it the adapter's rules it had skipped: the Shelf catalog is served seatless, the seat comes from a binding as well as LIBRARY_SEAT, the Desk's pin and duplicates are checked, a shared Book page and Catalog are read from Basic Memory, and a Shelf page path is matched in its on-disk case. |
| `notebook render` | Ported (S17), re-cut for ADR-0029 (S18): re-derives THIS SEAT'S index, `notebook/<seat>/_master-index.md`, reporting the drift it repaired. |
| `notebook own` | Retired by ADR-0029 (S18) and refuses by name: a topic belongs to the seat whose Notebook holds it, so there is no ownership to record. |
| `reset`, `reset restore` | Ported (S17), re-cut for ADR-0029 (S18): the reset takes the acting seat's own root and nothing else, so `--whole-tree` and `--all-idle-seats` refuse by name. `--clear-desk`, and the restore's `--list`, `--show`, `--topic` and `--adopt`, as before. Quarantine by move, journal beside the material, plan bound to the seat's incarnation. |
| `compile` | Ported (S17) for a batch with no git repository in it, into the seat's own Notebook (S18). A source file INSIDE a repository refuses by name: see below. |
| `migrate` | Ported (S18) and only here: ADR-0029's migration from the shared Notebook. Every legacy state enumerated with a recorded disposition, activation refused until none is unaccounted, journalled before every move, `--resume` and `--rollback` from any point. No PowerShell oracle exists, so `tools/Test-NotebookMigration.ps1` judges it. |
| `doctor` | Ported (S17): the nine checks that read the reader's material -- `Invoke-LibraryChecks.ps1 -WorkspaceOnly`. The program's own development gate is not a doctor's, and is not ported. |
| `seat enter`, `seat retire` | Ported (S14's second half). Enter binds an agent process to an existing seat by verified identity and spawns this same program as the claim holder (`seat hold`); retire is gated and archives. `seat enter --create` is ported for the local collection (S30): `SeatCreation.ps1`'s gate rule for rule, the preflight and exact plan id, and the oracle's abort order -- **Tier 0 opens a Seat with no Basic Memory**, judged by `seat.tier0-opens-a-seat-with-no-basic-memory`. Since S42 `seat start` (a named seat, the claim held for its agent's life) and `seat status` (the roster) answer; the picker, a Desk restore and a pre-seat Desk's migration refuse by name (ADR-0042). The claim itself is judged independently by self-test sections 24-27 (S43). |
| `collection owner` | Ported (S43, `src/ownership.ts`): `Set-CollectionOwner.ps1` whole -- status, acquire (idempotent, refusing a role another workspace holds, `--force` previewed and then recorded as a forced takeover) and release (refused while a Book lock is held). The claim is created by hard link from a staging name, which is exclusive and complete the instant it appears, since Node cannot spell `File.Move` without replace. Judged by self-test section 28, ten workspaces contending three times (ADR-0043). |
| `triage inventory`, `triage validate` | Ported (S15, S25). |
| `triage batch` | Ported (S43, `src/triagebatch.ts`): `Invoke-LibraryTriage.ps1 -ActionJson` for the local kinds -- review, holding, notebook (into this seat's Notebook), shelf-book, discard -- with the oracle's state machine, batch id, plan record and journal, byte for byte on two differential rows; a resume is the same `--actions` run again. A project or book action, the single-note surface and `-PlanPath` refuse by name. Judged for resumption by self-test section 33 (ADR-0043). |
| `selftest` | Declared, refuses by name. Only the three recorded-verdict harness rows name it; the concurrency and recovery rows are judged by self-test sections 29-32 through the real verbs, because a kernel judging itself is not a judge (ADR-0043). |

**The one partial port S17 left, stated rather than thinned.** `tools/Compile-RawBatchToNotebook.ps1`
captures an upstream PIN for a source file inside a git repository -- HEAD, the tracked remote ref, a
status sample either side of the read, and a bounded blobless fetch proving the commit is on that
remote. The kernel carries none of that yet. A batch with no repository compiles exactly as the
oracle does, pin withheld with the same reason; a source file inside one is REFUSED, naming the
PowerShell helper, because withholding a pin the oracle would capture records the article as
unanchored for a reason that is not true. No matrix row holds the pin path to anything, since no
fixture batch is a repository.

**How the kernel reads who is at a seat** (S14's second half, the reader's two rulings of 2026-09-22).
A seat's identity can come from an explicit argument, a committed binding, or `LIBRARY_SEAT`, and the
middle one is verified by pid AND by the recorded start time of the process now at that pid -- so a
reused pid reports as a different agent rather than inheriting the seat. Node exposes no start time,
so `src/procstart.ts` reads one per platform: on Windows it runs **the oracle's own expression** in
`powershell.exe` (identical to 100 ns by construction, 191-209 ms a read, and a gone pid costs no
spawn); on Linux `/proc`; on macOS `ps -o lstart=`. A native call was declined because
`node src/cli.ts`, which every row runs, could not execute it.

**A claim the kernel holds is two files.** Node opens a file sharing everything or sharing nothing
(libuv's `0x10000000`, honoured on Windows, measured), and PowerShell's `FileShare::Read` is neither.
So the kernel's holder writes `.claim` sharing everything -- which PowerShell's probe still reads as
held and its acquire still refuses -- and holds `.claim.lock` sharing nothing, which makes its own
acquisition exclusive. The probe asks `.claim` with a WRITE-mode open (a PowerShell holder) and
`.claim.lock` with an ordinary one (a kernel holder), so a concurrent reader is never mistaken for a
session. `.claim.lock` is the approved delta `kernel-claim-lock`. **Off Windows there are no share
modes at all, so neither probe detects a holder there yet**; that is the POSIX spelling of the claim,
and it belongs with S20's clean macOS or Linux VM.

**Which Notebook a verb is looking at** (ADR-0029, S18; `src/notebooklayout.ts`). The kernel keeps each
seat's Notebook at `notebook/<seat>/` and records no owners. Seat roots and legacy topics share one
namespace -- a legacy topic may be named like a seat, and in the reader's own workspace two are -- so
no folder name can say which layout a workspace is in. `internal/notebook-layout.json`, written LAST
by the migration, is what makes the seat-owned layout active. Four states follow, and the reader
ruled on what each does (S18):

| State | What the kernel does |
| --- | --- |
| `seat-owned` | The layout record exists. Every Notebook verb reads and writes `notebook/<seat>/`. |
| `migrating` | A migration journal is neither complete nor rolled back -- and it outranks the record, which the migration writes one step before it closes the journal. EVERY Notebook verb refuses and names `library migrate --resume` and `--rollback`. |
| `legacy` | Something a legacy writer produced is on disk. Writes refuse and name `library migrate`; reads see the shared tree as it is, so a preflight, a graduation's read and triage's validation still answer. |
| `fresh` | Nothing legacy at all. Reads see the (empty) shared tree; the first write activates the seat-owned layout, since there is nothing to migrate and so nothing to approve. |

**The migration** stages every legacy entry out of `notebook/` before it places any, because a topic
may be named like the seat that receives material. A live seat's topics go to that seat; a retired
seat's are set aside; what no seat owns -- declared shared, excluded, unmapped, a loose file, a
topic whose owner neither the registry nor a retirement record names -- waits for the reader's
`--assign <item>=<seat>` or `--set-aside <item>`. "Set aside" is a quarantine journalled like a
reset's, so `reset restore --adopt` brings any of it back into any seat. The ownership record and the
shared index are archived under `internal/notebook-migration/legacy/`, never deleted. It refuses while
any seat but the caller's has a live session.

**How the matrix compares it.** The PowerShell arm writes `notebook/<topic>/`; the kernel writes
`notebook/<seat>/<topic>/`. The approved delta `notebook-is-seat-owned` rebases the ACTING seat's root
in the kernel's outcome onto the oracle's `notebook/` -- keyed by that seat's value, in every spelling
a path takes, the hyphenated file-name form included -- and then holds the kernel to the oracle's
content exactly. Until S18 it approved any field beginning `effect.notebook/` whatever it held, which
would have turned every Notebook row green the moment the kernel wrote under a seat root. The rows
over a legacy fixture run `migrate` first on the kernel arm only, which is the asymmetry the delta
exists to carry; the one row whose input is a hand edit writes it after the migration with a kernel
`write` step, since the file a person would edit is somewhere only the migration puts it.

**A result on stdout is ASCII** (S34, measured). A child `powershell.exe` writes stdout in the console's
OEM code page -- 437 on the maintainer's machine -- and `Add-CatalogEntry.ps1 -Preflight -Json` reported
the entry it would write with a hyphen where it writes U+2014, so the preview a reader approves was not
the line that lands. `Write-LibraryResult -Json` escapes every character above U+007F as `\uXXXX` now,
with a self-test that reads the raw bytes of a real child (2 of 10 red without it), and so does `emit`
here (self-test section 13). Files are untouched: they keep `ConvertTo-Json`'s literal characters, which
`src/psjson.ts` reproduces.

**An order is `Sort-Object`'s, measured** (S35; `src/pssort.ts`). Windows PowerShell 5.1 sorts under the
current culture, en-US here: `'` and `-` are ignored at the first level, every other ASCII symbol weighs
`` !"#$%&()*,./:;?@[\]^_`{|}~+<=>`` and then digits, then letters, case-insensitively. Of two strings equal
but for the ignored characters, fewer sorts first, then the LATER position. `psSortCompare` broke that tie
ordinally until S35 -- `a-bc` before `ab-c`, `ab-c` before `abc`, the reverse of the oracle in both -- and
the delete plan's file manifest (from `listFilesRecursive`, which stays ordinal for its other callers) and
its `sortUnique` were ordinal outright; both sort as `Sort-Object` now. No fixture held two names
that tell the orders apart, and the digests that would have shown it are normalised, so no row did.
Case-only ties, which `Sort-Object` leaves unstable, are still broken ordinally.

## Two things that are not obvious

**`src/psjson.ts` exists because the matrix compares files.** Normalisation removes paths,
timestamps, GUIDs, line endings and trailing whitespace — and nothing else, so **indentation
survives it**. Windows PowerShell's `ConvertTo-Json` indents a container's children relative to the
column its own opening bracket was written at, which means the length of the key above decides the
indent. `JSON.stringify` at any setting differs from that on every line. The layout is pinned in the
self-test against output measured from PowerShell 5.1, never against this file's own writer.

**The kernel runs from source in development, and ships compiled.** Node 22+ strips the types, so
there is no build step in development and `-Kernel 'node kernel/src/cli.ts'` is the whole invocation.
A reader gets `bun build --compile` output instead (step 28, S19's row), built by
`tools/Build-KernelRelease.ps1` and installed by `install.ps1` / `install.sh` at the program root.

**A compiled kernel is not where its source was** (S29, measured). Inside the binary `import.meta.url`
is `file:///B:/%7EBUN/root/<name>.exe` on Windows, so "two directories up from `kernel/src/`" is
`B:\`, and the three `init` rows that write a workspace mismatched on 33 of 33 fields against a raw
binary. The kernel still needs its program on disk -- the templates `init` renders, the plugin
manifest, and the hooks and reader adapter, which are PowerShell -- so a release is **the public
program tree with the binary at `bin/`**, and `src/programroot.ts` finds a compiled kernel's program
one directory above its own. A binary outside that layout refuses when a verb first asks for the
program, naming where it looked; `help`, `--version` and every verb that never reads the program
still answer. `library --version` reports the release tuple -- plugin, binary (baked in with
`--define`) and workspace schema versions -- which the builder and both installers read back from the
binary itself rather than from the file beside it.

Two things `node src/cli.ts` never shows, both measured from the binary in S29. `seat.ts`'s
`selfCommand` spawns the holder as the binary alone, because a compiled `process.argv[1]` is the
virtual `B:/~BUN/root/...` path and matches no script extension. And `procstart.ts` still reads a
Windows start time through `powershell.exe`, in the binary as from source.

**Bun is not libuv, and the claim found that out** (S29). Bun ignores `UV_FS_O_EXLOCK`, measured with
one probe run under Node, under `bun` and as a compiled binary: only Node refused the second open. So
a compiled kernel's `.claim.lock` was share-everything, and its probe read every kernel-held seat as
free. `seatclaim.ts`'s `openShareNothing` calls `CreateFileW` with a share mode of 0 through `bun:ffi`
when it runs under Bun on Windows, and keeps libuv's flag under Node. The whole matrix run with the
installed binary as the kernel is what caught it -- `-Kernel "$env:LOCALAPPDATA\deskpost\versions\<v>\bin\library.exe"`
-- which is also why the reason `procstart.ts` gives for declining a native call does not reach here:
the binary's path is measured now.

**An installed kernel is rooted at `current`, not at its version** (S30, the reader's ruling;
[ADR-0038](../docs/adr/0038-an-installed-library-is-rooted-at-its-current-link.md)). Every hook and
adapter path `init` writes is under the program root, and `init` refuses a workspace whose hooks name
another program, so a root at `versions/<v>` would have moved on every upgrade and left `init --force`
refusing. The installers keep `<install>/current` as a link onto the installed version, the shim runs
through it, and `stableProgramRoot` reports `current` when it resolves to the binary's own version
directory. **Bun resolves the junction** -- measured, a binary started through one reported its
`execPath` under `versions\<v>` -- so the rule asks the link from the version's side rather than reading
the executable's path. `tools/Test-KernelUpgrade.ps1 -Release <folder>` is the upgrade, rollback and
old-version-removed fixture; with `-PlantDefect` it initialises from the version's own path and fails.
