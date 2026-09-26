# Library Documentation

Vocabulary lives in [CONTEXT.md](../CONTEXT.md), the Library's single glossary. From 2026-08-17,
new decisions that are hard to reverse, surprising without context, and the result of a real
trade-off are recorded as short ADRs in [`docs/adr/`](adr/); the narrative records below remain as
they are.

## Decision records

Read these for *why*, and the narrative records below for *how*. As of 2026-08-31 the Library's own
decisions live here, because the Library's subject is its own repository — see ADR-0003 for the rule
that decides where any given decision belongs.

* [ADR-0001](adr/0001-shelf-books-accept-pages-when-open.md) - Shelf Books accept new pages when open
* [ADR-0002](adr/0002-discovery-spans-closed-books.md) - Discovery spans closed Books
* [ADR-0003](adr/0003-decisions-follow-their-subject.md) - decisions follow their subject; the Library owns orientation
* [ADR-0004](adr/0004-the-reasonix-delegate-line-is-retired.md) - the Reasonix delegate line is retired
* [ADR-0005](adr/0005-the-hub-page-size-harness-stays-a-throwaway.md) - the Hub page-size harness stays a throwaway
* [ADR-0006](adr/0006-reset-vocabulary-routes-to-the-library-reset.md) - "reset my workspace" routes to the Library Reset
* [ADR-0007](adr/0007-the-desk-hook-advertises-the-reader-by-exact-name.md) - the Desk hook advertises the validated reader by its exact callable name
* [ADR-0008](adr/0008-a-root-plan-names-the-project-that-owns-it.md) - a root plan file names the project that owns it, because the repository root is a shared namespace
* [ADR-0009](adr/0009-the-library-is-a-foundry-not-a-home-for-spin-off-projects.md) - the Library is a foundry for spin-off projects, not their home
* [ADR-0010](adr/0010-the-notebook-reset-preserves-the-desk.md) - the Notebook reset preserves the Desk; clearing it is the caller's choice
* [ADR-0011](adr/0011-a-sanitized-upstream-identity-is-catalog-class.md) - a sanitized upstream identity is catalog-class, so a Discovery manifest may carry it
* [ADR-0012](adr/0012-archived-books-are-covered-by-search-and-labelled.md) - archived Books stay searchable, and say so, rather than disappearing from the count
* [ADR-0013](adr/0013-a-hub-section-holds-only-what-the-project-can-close.md) - a Hub section holds only what the project can close
* [ADR-0014](adr/0014-a-hook-delivers-a-document-it-does-not-hold-a-rule.md) - an instruction-carrying hook serves a section of a tracked document; it never holds a rule of its own
* [ADR-0015](adr/0015-the-desk-is-per-seat-one-library-many-seats.md) - the Desk is per-seat; one Library, many seats, and no default seat
* [ADR-0016](adr/0016-reset-is-seat-scoped-recoverable-and-refuses-claimed-seats.md) - reset is seat-scoped, quarantines rather than deletes, and refuses claimed seats
* [ADR-0017](adr/0017-the-always-on-margin-is-accepted-disciplines-do-not-move.md) - the always-on margin is accepted; a rule triggered by the reader’s imperative does not move to an on-demand Skill
* [ADR-0018](adr/0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) - a seat binds to a conversation by verified process identity; the environment must agree, never authorise
* [ADR-0019](adr/0019-a-topics-ownership-changes-only-under-its-topic-lock.md) - a topic's ownership changes only under its topic lock; the ownership record lock is last in the order
* [ADR-0020](adr/0020-a-capture-books-name-does-not-reuse-a-glossary-term.md) - a capture Book's name does not reuse a glossary term at a different scope; the Holding Shelf is not renamed
* [ADR-0021](adr/0021-a-cosmetic-reversible-action-is-performed-not-offered.md) - a cosmetic, reversible action is performed, not offered; confirmation is spent on consequence
* [ADR-0022](adr/0022-reachability-names-the-destination-class.md) - a reachability report names the destination class, and only a current copy is proof
* [ADR-0023](adr/0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md) - idleness authorises a sweep of an idle seat’s Notebook topics; retirement still gates a whole-tree reset
* [ADR-0024](adr/0024-removal-from-the-notebook-has-no-destination.md) - removal from the Notebook has no destination; Triage keeps only ever adding
* [ADR-0025](adr/0025-a-protected-topic-states-whether-it-can-be-rebuilt.md) - a protected Notebook topic states whether it can be rebuilt, and the preflight says what will remain
* [ADR-0026](adr/0026-a-hub-section-states-the-current-position.md) - a Hub section states the current position, never its own history of being wrong (proposed)
* [ADR-0027](adr/0027-the-program-is-separate-from-the-workspace.md) - the program is separate from the workspace; a workspace is a folder the program initialises, never a checkout (effective Phase C of `PLAN-public-release.md`)
* [ADR-0028](adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md) - the kernel is TypeScript shipped as one binary; PowerShell survives only in the v0 Windows preview (effective Phase D)
* [ADR-0029](adr/0029-the-notebook-belongs-to-the-seat.md) - the Notebook belongs to the Seat; cross-seat topic ownership and locks retire (supersedes ADR-0015's one-Notebook clause and ADR-0019's mechanism; effective Phase D)
* [ADR-0030](adr/0030-a-collection-has-one-layout-and-two-backends.md) - a collection has one layout and two backends, a Project Hub may live locally, and the plugin exposes one MCP facade (effective Phase D)
* [ADR-0031](adr/0031-the-public-repository-starts-with-fresh-history.md) - the public repository starts with fresh history, and a trusted job mirrors every branch behind a server-side scan (effective Phase B)
* [ADR-0032](adr/0032-the-family-name-is-deskpost.md) - the family name is Deskpost; Deskpost Prompts is Librarian 2.0; the vocabulary is unchanged (effective Phase B)
* [ADR-0033](adr/0033-the-operator-seat-is-excused-from-the-engage-scan.md) - the cutover's engage scan excuses exactly one seat, the one the driving process proves a live claim for; a name alone still blocks
* [ADR-0034](adr/0034-the-vault-export-activates-by-two-renames.md) - the vault export swaps generations with two renames and a journal entry between them, never a junction behind a pointer (effective Phase B)
* [ADR-0035](adr/0035-the-public-tree-export-seeds-once.md) - the public tree export seeds a repository once and refuses its own second run, and the refusal is the drift report (effective Phase B)
* [ADR-0036](adr/0036-a-direct-install-registers-its-guards-from-library-init.md) - a direct install gets its hooks and its reader from `library init`, by absolute path into the program, because the plugin supplies neither (effective Phase C)
* [ADR-0037](adr/0037-a-seat-starts-in-the-workspace-it-is-a-seat-in.md) - the seat launcher starts the agent in the workspace the seat is in, so a reader loads their own instructions and the guards `library init` registered (effective Phase C)
* [ADR-0038](adr/0038-an-installed-library-is-rooted-at-its-current-link.md) - the installers keep `<install>/current` as a link onto the installed version and a compiled kernel reports it as its program root, so the hook paths `library init` writes survive an upgrade and a rollback (effective Phase D)
* [ADR-0039](adr/0039-an-independent-row-is-judged-against-the-kernel-under-test.md) - an independent matrix row is green when a declared judge passes against the kernel under test, or a real session's verdict is recorded for that exact release binary; the embedding row runs against the harness's deterministic stand-in (effective Phase D)
* [ADR-0040](adr/0040-a-posix-workspace-is-an-absolute-path-bound-to-the-binary.md) - on macOS and Linux a workspace root is an absolute `/` path and the registry is `$HOME/.library`; `library init` binds the workspace to the compiled kernel, and doctor fails a registration the machine cannot start (effective Phase D)
* [ADR-0041](adr/0041-library-init-lays-out-the-holding-shelf-and-report-inbox.md) - `library init` lays out the Holding Shelf and the Report Inbox as empty capture Books, renders the catalog and an empty master index, so a fresh workspace passes its own checks (effective Phase D)
* [ADR-0042](adr/0042-a-plugin-guarded-workspace-a-posix-remedy-and-a-held-seat.md) - the enabled Claude Code plugin's hooks count as a workspace's guards and a hook is named by its script or the binary's verb; on POSIX a remedy names the ported `library` verb; `library seat start` and `status` are ported; and off Windows the seat claim is `flock(2)`, which until then excluded nothing (effective Phase D)
* [ADR-0043](adr/0043-a-judge-drives-the-kernels-real-verbs.md) - an independent row is judged through the kernel's real verbs, never by a kernel judging itself; the kernel's atomic write retries a refused rename, jittered; `library triage batch` runs and resumes a plan for the local kinds; and a publication resume is measured over a genuinely interrupted publication (effective Phase D)
* [ADR-0044](adr/0044-basic-memory-is-optional-and-the-public-install-is-local.md) - Basic Memory is optional and advertised, never a prerequisite; the public install defaults to a local collection (Tier 0), the reader's own workspaces keep their Basic Memory collection, and friction on the default route is a release defect (effective the next public release)
* [ADR-0045](adr/0045-an-installed-kernel-says-its-own-remedies-and-the-plugin-is-opt-in.md) - A compiled kernel on Windows says a remedy as a command the reader can run, the matrix normalises the oracle side by one rule, and the Claude Code plugin is opt-in (S47)
* [ADR-0046](adr/0046-a-compiled-windows-init-registers-the-kernels-own-hooks.md) - On Windows a compiled release's `library init` registers the kernel's own five hooks, exec form for Claude and `& ` for Codex, and keeps the four unported ones as PowerShell (S48)

## Guides

Written for the reader rather than for the Librarian, and kept together in
[`docs/guides/`](guides/README.md) so they can be found by browsing rather than by searching — a
guide has to stay current, where the design records below are dated snapshots that are meant to
freeze. The `library-help` Skill offers the same four.

* [Returning Reader Quick Start](guides/quick-start-returning-reader.md) - for someone who knew the Library before seats: what changed, what old habits now do, and the first five minutes of a real session
* [Library Learning Path](guides/learning-path.md) - nine safe things to try in order, each proving one piece of the design, with what to look at afterwards
* [Starting a New Project](guides/starting-a-new-project.md) - a new long-running subject: the Hub, then the seat, then the first compile, every step of it by asking
* [Library Workflow Guide](guides/workflow-guide.md) - the same behaviour drawn as flow, one vertical diagram per question

## Narrative records

* [Librarian Operating Rules](librarian-operating-rules.md) - durable Library operating guidance
* [Librarian Voice and Wayfinding](librarian-voice-and-wayfinding.md) - reader benefit, front-desk cadence, and plain-language safety boundary
* [Librarian Operation Playbooks](librarian-operation-playbooks.md) - on-demand procedures for publishing, triage, archiving, reset, and Library development
* [Notebook and Desk Model](notebook-and-desk-model.md) - volatile Notebook boundary, desk overview, reset scope, and acceptance evidence
* [Seats](seats.md) - one Library and many Desks, why there is no default seat, the session claim that is not a lock, the two questions that look alike and are not, and what measuring Codex's apply_patch corrected
* [Derived Indexes](derived-indexes.md) - why `notebook/_master-index.md` and `shelf/_catalog.md` are rendered rather than authored, the render locks and why their critical sections are tiny, the atomic-replacement primitive chosen by measurement, and the day-one split of the catalog into per-Book entry files
* [The Supported-Operation Matrix](supported-operation-matrix.md) - the acceptance oracle for the TypeScript port: every operation the kernel must carry with the fixture it runs over, why "zero diffs" is neither achievable nor sufficient, exactly what is normalised away before two implementations are compared, the deltas approved in advance, and why a row with no kernel attached reports `pending` rather than green
* [Helper Write and Output Contracts](helper-write-and-output-contracts.md) - the per-Book lock taken before prior state is read, the rollback journal that records absence as well as content, the five journal kinds under `internal/` and their five different jobs, and why `-Json` is opt-in
* [Shelf and Catalog Symmetry](shelf-desk-symmetry.md) - Shelf Books opening and closing exactly as shared Books do, and the guard that makes closed mean closed
* [Hook-Enforced Boundaries](hook-enforced-boundaries.md) - what the hook layer guards and what it merely delivers, the shell hole measured on 2026-09-06, the Codex hooks file that never loaded because valid JSON was the wrong bar, the serve ledger's contract with compaction, and the two windows on a broken settings file
* [One Writable Workspace Per Collection](collection-ownership.md) - the writable role acquired by exclusive create and fenced by an incarnation, why the record is a directory of per-incarnation claims rather than the single file the plan sketched, why an unowned collection is permitted and why that is a one-way door, the release that refuses while a Book lock is held, and the four backend states with the fix each one names
* [Graduating a Page into a Shelf Book](shelf-book-graduation.md) - the additive open-Book write, the reader-map rule that keeps it additive, and the two capture races it closed
* [Capture Books and the Library Help Skill](capture-book-model.md) - the Holding Shelf, ungated capture into a closed Book, pending-count resurfacing, gated triage, and help as a Skill
* [Cross-Seat Agent Reports](cross-seat-reports.md) - the Report Inbox as the channel from any seat to `library-dev`, the two provenance fields that make a report better than a paste, why a report is a claim and never a task, why the transcript it names is deliberately not read, and the Shelf/Book naming collision folded in
* [Book Archive Model](book-archive-model.md) - how working files and NAS Books fit together
* [Library Organization Model](library-organization.md) - Books, Projects, active/archive shelves, and collection-aware catalog grouping
* [Library Inventory and Triage](library-triage-design.md) - one verb over both local buffers, the kind-by-source matrix, the split gate, and the reset advisory
* [Workspace Wiki Migration](workspace-wiki-migration.md) - confirmed external-wiki inventory, project/reference split proposals, and verified Shelf imports
* [Duplicate Topic Resolution](duplicate-topic-resolution.md) - survivorship rule and canonical + stub pattern for the same topic appearing in more than one migrated Book
* [Retiring Shelf Material](shelf-book-retirement.md) - the stub writer, the local Shelf archive with restore, and how the shared archive became listable
* [The Validated Reader's Argument Guards](reader-argument-validation.md) - one definition of what a required tool argument is, and the process-level self-test that proves it
* [Project Hubs and Optional Action Boards](project-hub-design.md) - implemented active Projects, suggestions, archive, return briefings, the dev template, and where decisions live
* [Compiling and Refreshing a Book from a git URL](book-currency-anchoring.md) - the shipped route: a URL becomes a real raw batch, the compiler records the remote commit it hashed, and a Currency check asks the upstream whether a Refresh is due
* [Book Currency Anchoring — Deferred Design](book-currency-anchoring-deferred.md) - how that design was reached, why it waited, and the 2026-09-04 revision that anchored to a remote pin instead of a local worktree; superseded as guidance by the record above
* [Claude Reader Compatibility](claude-reader-compatibility.md) - Unicode-safe MCP output and the regression guard that protects Claude reading
* [Library Identity and Transition](library-identity-and-transition.md) - the Library's name, warm Librarian voice, standalone connection boundary, and retained history
* [Model Division of Labor](model-division-of-labor.md) - what the Librarian keeps, what a delegated CLI agent is called for, and why verification runs through the check suite
* [Token-Efficient Library Development](token-efficient-library-development.md) - measured context pressure in development sessions and a feature-preserving optimization sequence
* [Hub Now/Next Migration Runbook](hub-migration-runbook.md) - the exclusive window, the four writes in order, the two approvals, and the reader-approved classification behind them
* [Raw-to-Notebook Compilation](raw-to-notebook-compilation.md) - source-bound creation of indexed Notebook articles ready for triage to a Project or a Book
* [Pilot Success Closeout — 2026-08-15](pilot-success-closeout-2026-08-15.md) - historical adoption decision, operating model, maintenance boundary, and next-project rule
* [Where Deskpost Came From](history.md) - the LLM Wiki prompt it grew out of, the pilot that proved it on real work, the name, and why the plan files and review logs are private
* [The Mirror Publishing Job](mirror-publishing-job.md) - the server-side gate: what the Forgejo instance can actually do, why the job lives in a separate private ops repository, the five surfaces it scans, and why a failed attestation names nothing
* [Discovery Manifests](discovery-manifests.md) - the manifest schema and generator, durable storage whose read path refuses a half-written manifest, the single transaction holding the Book's own lock, and the backfill across every Shelf Book
* [Full Text over Open Books](full-text-over-open-books.md) - the second retrieval tier, confined to Books open on the Desk, and the search boundaries it pulled forward
* [Scoped Raw Search](scoped-raw-search.md) - the third tier, over one named batch under `raw/` rather than a Book, and why it is never run over all of it
* [A Hit Is a Location, Not a Reading](hit-is-a-location.md) - the rule that covers all three retrieval tiers: a hit says where a term occurs and licenses opening it, never an answer
* [The Book-Root State Schema](book-root-state-schema.md) - one line of a Desk file names a Book's collection root, the migration that moved every consumer onto it, and opening an archived shared Book
* [Raw Batch Ownership](raw-batch-ownership.md) - which Project owns a source batch, with one authority for liveness derived at read time
* [Topic Overlap Records](topic-overlap-records.md) - several Shelf Books covering one real subject as conversion residue, recorded before anything is merged
* [Graduating a Whole Topic into a Shelf Book](topic-graduation.md) - the topic-level writer built on the page-level one, and the defect that prompted it
* [The Shelf Is a Staging Area, Not Storage](shelf-lifecycle.md) - the reader's statement of purpose, recorded after the Shelf grew an entrance and no exit
* [Publish a Shelf Book to the Shared Collection](shelf-to-shared-publication.md) - the ordinary Shelf exit: publish, verify the copy and its Catalog entry, then delete the local Book under the same approval
* [Teaching the Allowlist Check about the MCP Adapter](mcp-tool-allowlist-check.md) - the gap that let a new reader tool go unallowlisted, and the check that closes it
