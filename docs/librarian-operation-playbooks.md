# Librarian Operation Playbooks

Read the applicable section immediately before a consequential shared-Library or reset action.
This reference is intentionally not part of the Library's always-on reader instructions.

## AI Library development

For an explicit AI Library development task, always use the collection this workspace is attached
to. Every helper resolves it for itself through `tools/LibraryDeployment.ps1` -- an explicit
`-ProjectId`, then `AI_LIBRARY_PROJECT_ID`, then the generated `.claude/.library-project` -- so it
is not written down here or anywhere else in the tree, and a workspace with none configured is
refused with the three routes named. The workspace hook blocks direct Basic Memory content
readers and search for normal reader work: use the validated reader for Books and Projects and
the bounded PowerShell helpers for shared changes. For an explicit active-Project write or edit,
use the exact `projects/<slug>/...` target and read back that exact path. Never make a destructive
Basic Memory change without the user's clear approval.

## Delegating implementation work

Delegation is a call the Librarian makes, not a transfer of authority. Read
[Model Division of Labor](model-division-of-labor.md) first — it defines which work is worth
delegating, and how the return value is kept small enough to be worth reading.

**Step 0, before the rest: does the delegate have window left?** Run
`tools/Get-MeterStatus.ps1`. If the window is nearly spent, the cheapest decision is not to delegate
at all — a run that dies partway costs a salvage pass and buys nothing. Read `used_percent` together
with `reading_age_minutes`: the reading is last-known and only refreshes when Codex runs, so an old
figure understates what has been spent since.

Preflight, in order:

1. **Clean tree.** `git status -sb`. A dirty tree means the delegate's diff cannot be isolated or
   reverted. Stop and ask the reader to commit or stash.
2. **A written spec.** If the spec cannot be written without making design decisions, the work is
   a design question and stays with the Librarian.
3. **A scoped launch.** A non-interactive build delegate switches off its shared-collection MCP
   servers for that invocation. It has no user present to approve consequential work and does not
   need Library content to implement repository changes:

   ```
   codex exec --sandbox workspace-write --dangerously-bypass-hook-trust -c mcp_servers.basic-memory.enabled=false -c mcp_servers.validated-book-reader.enabled=false
   ```

`--sandbox workspace-write` confines the delegate's writes to the workspace. Prefer it to `--yolo`
or `--dangerously-bypass-approvals-and-sandbox` for any in-repo build: full bypass grants more than
the work needs, and per-run MCP scoping is a weak claim if the sandbox is switched off underneath
it. `codex exec` is non-interactive and has no approval prompt to suppress, so the sandbox flag is
sufficient on its own. Verified against codex-cli 0.147.0, whose accepted values are `read-only`,
`workspace-write`, and `danger-full-access`; there is no `--full-auto`.

**`--dangerously-bypass-hook-trust` is what keeps the Desk boundary on this path, and it is not
optional.** Codex records hook trust per `CODEX_HOME` and skips an untrusted hook **silently**;
`codex exec` has no interactive review with which to earn trust. Without the flag a delegate runs
with no Library guard at all and nothing reports the absence. Measured 2026-09-08 on codex-cli
0.153.4: a delegate asked to read a page of a closed Shelf Book read it, and the identical command
in the identical home carrying this flag was refused by `Guard-ShellShelfRead`. The flag's
documented purpose is this case -- "intended only for automation that already vets hook sources" --
and this workspace's hook source is tracked in git and rendered from a tracked template by
`tools/Initialize-CodexLibrary.ps1`. Full record:
[Hook-Enforced Boundaries](hook-enforced-boundaries.md).

Verify by climbing the ladder, no further than it needs to go: `tools/Invoke-LibraryChecks.ps1`
first, then `git diff --stat` for scope, then a targeted read of anything under `tools/`,
`.claude/`, or `internal/`, and a full diff read only when the gate fails in a way the stat cannot
explain. The delegate's report is advisory at every step; the check suite is the evidence.

This restriction is for repository-only delegates, not for the trusted interactive Codex
Librarian. The interactive session loads `.codex/config.toml` and `.codex/hooks.json`, may read
open Books and Projects through the validated reader, and may maintain an open active Project Hub
through the guarded direct write surface.

Never delegate a shared-collection write, a playbook-gated operation, or a commit. A delegate with
the shared servers disabled cannot accidentally acquire that authority.

## Library inventory and triage

### Compile a named raw batch into the Notebook

Read and synthesize the requested batch first; the helper does not do that reasoning. Put the
finished Markdown in a temporary or other non-Notebook file, beginning with one H1 and including
`## Key Takeaways`. Name every raw source file actually used, relative to the batch, then run
`tools/Compile-RawBatchToNotebook.ps1 ... -Preflight`. The preview binds the draft, source hashes,
destination article, and both Notebook indexes, and reports no shared write.

A new article is additive: rerun without `-Preflight`. A divergent existing article needs explicit
`-ReplaceExisting`; show its exact `plan_id`, wait for one clear approval, then rerun with
`-UserConfirmed -ApprovedPlanId <that exact plan_id>`. Never handwrite the generated `## Sources`
section or use this helper to copy raw text wholesale. The returned `article_path` is ready for the
triage plan below. Full contract: [Compile a raw batch into the Notebook](raw-to-notebook-compilation.md).

When the user asks what reset would remove, what is already copied, or asks to make a Library copy,
start with `tools/Get-LibraryTriageInventory.ps1 -WorkspacePath .`. It reports both local buffers
separately and never sums them: the Notebook counters answer *what a reset deletes*, and the
`holding_*` counters are material that already **survives** one. It is local journal evidence, not a
NAS scan or automatic classifier, and it returns a report even when a source is absent — a workspace
just after a Reset is a populated Holding Shelf and no Notebook at all.

Use the user's stated purpose and the inventory to suggest one small destination: refresh a Book,
copy selected pages to an active Project Hub, create a new destination, or **Hold** the material on
the Holding Shelf. Do not silently split notes, invent a category, or create a duplicate Book because
a match is uncertain — and do not advise leaving uncertain material in the Notebook, which is where a
reset deletes it. Uncertainty is a reason to Hold, not a reason to do nothing.

**Triage is the sweep that makes a reset safe**, so when a reader says "reset", "start fresh", or
"clear my workspace", **triage the Notebook first** — offer it before the Reset rather than after,
and say plainly that the Notebook is what the Reset deletes.

### The kinds, and which source can reach them

The **source** decides which destinations are reachable. `notebook` is the default and needs no
`source` field, so an action written before 2026-08-28 still validates.

| Kind | Where it lands | From `notebook` | From `holding` | Needs |
| --- | --- | --- | --- | --- |
| `holding` | the Holding Shelf | yes | — | `source_path`, `title` |
| `notebook` | `notebook/<topic>/` | — | yes | `topic`, and the note |
| `shelf-book` | an open curated Shelf Book | yes | yes | `slug`, `page_path` |
| `project` | an active Project Hub | yes | yes | `slug`, `title`, `purpose` |
| `book` | a **new** shared Book | yes | yes | `slug`, `title`, `summary` |
| `review` | in place — marks a note reviewed | — | yes | `reopen` to put it back to pending |
| `discard` | in place — deletes one note | — | yes | its own approval |

A `notebook` source is a file or folder inside `notebook/`. A `holding` source is one note in a
capture Book, named by `source_page` (exact) or `source_match`, with `source_slug` defaulting to
`holding`. A session finding has no disk path, so materialise it into a Notebook article or capture
it first and triage from that hashed file — context cannot be hashed, and an approval that binds
nothing is not an approval.

**There is no `discard` from the Notebook.** It would add a destructive mode to the helper whose
purpose is losing nothing, and the argument for it got weaker rather than stronger: a Reset
**quarantines** `notebook/` rather than deleting it, so a discard would not merely delete sooner —
it would be the *more* destructive of the two, with no route back. The honest fifth option is to
leave it. Every other kind is create-and-additive only; `replace_existing`
is refused at plan validation, because a misclassified overwrite has no rollback.

**The gate is split, and it is not symmetric.** Writing *into* a capture Book — capture, or a
`holding` action — needs no open Book at all. Any action whose *source* is a capture Book needs that
Book open, and a `shelf-book` action sourced from the Holding Shelf needs **both** Books open.

### One note

```powershell
tools/Invoke-LibraryTriage.ps1 -Source Holding -MatchText "<text>" -To Notebook -Topic <slug>
```

`-To` takes `Notebook`, `Holding`, `ShelfBook`, `Project`, `Book`, `Review`, or `Discard`. Review,
notebook, holding and shelf-book run on one call and ask for nothing; discard, project and book take
a preflight, the exact `plan_id`, and one approval. One note writes no plan record and no journal.

### A batch

`tools/Invoke-LibraryTriage.ps1 -ActionJson <json> -Preflight` validates every action, computes each
one's canonical write set, refuses two actions that would create the same path, and returns the
`plan_id`. Show the selected pages, destinations, write sets, anything in a `delete_set`, and that
`plan_id`. After one clear approval, rerun with `-UserConfirmed -ApprovedPlanId <that exact plan_id>`.
A preflight writes nothing; the confirmed run writes the plan record it was approved against.

Reading the result honestly matters here:

- `status` is `complete` only when every action succeeded. `incomplete` means a partial triage, and
  it is never reported as a success.
- `shelf_write`, `shared_collection_write`, and `notebook_write` are separate. A batch that only
  reached the Holding Shelf did not touch the NAS, and says so. A `notebook` action is honestly true
  in two of them: it copies into `notebook/` and marks the Shelf original reviewed.
- A failed action does not undo the ones that already landed. Fix the cause and rerun **the same
  plan**: succeeded actions are skipped from the batch journal at `internal/triage-journals/`.
  Editing a source instead invalidates the approval and needs a new plan.

Local source pages always remain intact, apart from a `discard` that names one note. Never run a
triage as part of the reset confirmation itself — offer it first, as its own step.

## Publish or refresh a shared Book copy

Before publishing a Book, run
`tools/Publish-BookCopy.ps1 -Destination Shared ... -Preflight`. Show the source, Book name,
manifest digest, `plan_id`, and pages that would be created. After a clear yes, rerun with
`-UserConfirmed -ApprovedPlanId <that exact plan_id>`. The helper preserves local source, journals
created and reused pages locally, resumes only a matching interrupted copy, reads back every planned
page, and adds the Catalog entry only after the Book is readable.
The source page's own frontmatter is absorbed by the shared store and is not what readback verifies.

To publish a curated Shelf Book and remove the local copy, open it on the Desk before preflight.
Capture Books cannot use this path. The composite preview shows both child plans and deletion is
part of the one approval:

```powershell
tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>
$plan = tools/Publish-ShelfBookToShared.ps1 -ShelfBookSlug <slug> -BookSlug <shared-slug> -BookTitle "<title>" -Summary "<summary>" -Preflight
```

After showing that plan and receiving a clear yes, run the matching confirmed command with no source
or metadata changes:

```powershell
tools/Publish-ShelfBookToShared.ps1 -ShelfBookSlug <slug> -BookSlug <shared-slug> -BookTitle "<title>" -Summary "<summary>" -UserConfirmed -ApprovedPlanId $plan.plan_id
```

The Shelf Book's root `_book.md` and `_index.md` are replaced by generated shared records; all other
Markdown pages keep their paths relative to `wiki/`. The local Book is deleted only after every
shared page and the shared Catalog entry read back successfully. See
[Publish a Shelf Book to the shared collection](shelf-to-shared-publication.md).

If the reader explicitly wants the local Book preserved, use the lower-level
`Publish-BookCopy.ps1 -Destination Shared -FromShelf` flow instead. That is a copy, not the ordinary
Shelf exit.

For a refresh, start with the question at hand—not automatically with `raw/`. Update the Notebook
from relevant session context, selected Notebook notes, a changed `raw/` repository, specific web
research, or a combination. Then use the same preflight and confirmed run with `-ReplaceExisting`.
Only the planned reader pages are replaced; unlinked historical shared pages are left intact. Use a
Book collection (`Projects`, `Reference`, or `Workflows`) only after the user has chosen it.
**Changing a published Book's collection is a `-ReplaceExisting` run**, because `collection` is one
of the Book-root metadata keys a refresh compares, and it re-files the Catalog entry as well as the
root — see `catalog_entry_state` below.

**A refresh has two more steps after the publish, and the first one is easy to miss.**

- **Rebuild the Book's Discovery manifest**: `tools/Update-SharedBookManifests.ps1 -Book <slug>
  -Rebuild`. A publish does not regenerate it, so `Get-BookCurrency.ps1 -All` keeps answering from the
  manifest generation that predates the refresh — on 2026-09-10 it reported `orca-ide` `not anchored`
  from a five-day-old manifest while every published article already carried a fresh upstream pin. It
  writes only local manifest stores, **but it still needs approval, and this step is where a refresh
  fails if you take the write set as the gate.** `confirmation_required` is computed from the SCOPE —
  true whenever at least one CLOSED Book is in it — because generating a manifest reads closed-Book
  page bodies over MCP. Publishing does not open the Book on the Desk, so the Book this step names is
  always closed and this rebuild always requires approval. Run `-Preflight -Json`, then rerun with
  `-UserConfirmed -ApprovedPlanId <that exact plan_id>`. Confirm with `-All` rather than assuming.
- **Read what the publisher says about the Catalog.** Since 2026-09-10 a refresh replaces the entry
  it owns rather than leaving a stale summary in place, and since 2026-09-18 a **changed
  `-Collection` moves that entry** instead of rewriting it where it already sat.
  `catalog_entry_state` is `inserted`, `replaced`, `moved` or `already-current`; `catalog_updated`
  is `$true` only when an edit was actually issued; `catalog_entry_heading` is the collection
  heading the entry is filed under, reported on **every** publish; and `catalog_entry_moved_from`
  names the heading it came from, empty unless the state is `moved`. `catalog_entry_verified` is the
  one a caller should gate on — it is the readback of the exact entry line, counted across the
  **whole** Catalog rather than within one section, so it proves the Catalog agrees with `_book`
  rather than merely mentioning the Book, and a move whose second edit failed is a refusal rather
  than a Book quietly listed twice. The line it owns is found by its `[[<root>/_book|` link
  target, so a retitled Book updates its own line instead of gaining a second one; two entry lines
  sharing that target are refused rather than guessed between. **A refresh that names no
  `-Collection` moves nothing** — it leaves the entry in whatever collection the last decision
  filed it under, because `## Open a Book` is where an unfiled Book is inserted and never a request.
  Name the state in the summary, and when it is `moved`, name both headings.

## Import an external workspace wiki to the Shelf

When the user wants to migrate a different workspace's `wiki/` folder, begin with the read-only
inventory:

```powershell
tools/Get-WikiMigrationInventory.ps1 -SourceWikiPath <external-wiki-folder>
```

The inventory lists exact page paths, first headings, top-level folders, and internal or unresolved
links. It does not decide what is Project material or reusable tool/reference material. Use those
facts to propose either one Book or a small split. Show every page selected for each Book. Do not
silently move, rewrite, or delete any source page. A selected Book must be self-contained: include
every selected page's local link target. When the same tool page supports two reader purposes, it
may be copied into both Shelf Books rather than leaving a broken link.

For each user-approved Shelf Book, preflight the exact copy:

```powershell
tools/Import-ExternalWikiToShelf.ps1 -SourceWikiPath <external-wiki-folder> -BookSlug <slug> -BookTitle <title> -Summary <summary> -Topics <topics> -IncludePage <relative-page>,... -Preflight
```

Show the source, selected pages, Shelf destination, manifest digest, and `plan_id`. After one clear
approval, rerun the same command with `-UserConfirmed -ApprovedPlanId <that exact plan_id>`. The
helper verifies every copied Markdown file before it moves the Book into `shelf/<slug>/wiki/` and
adds the Shelf catalog entry. It refuses an existing destination and leaves a named staging folder
for inspection if copying fails. The original workspace stays unchanged. A later shared-Catalog
publication remains a separate deliberate action; do not treat this Shelf import as permission to
publish or delete the original.

## Copy local pages into a Project Hub

Sending finished local pages to an active Hub is a **shared write**, so it takes a preflight, an
exact `plan_id`, and one approval. `tools/Copy-LocalPagesToProject.ps1` is the only route: a
Claude session has no direct Basic Memory write tool, and `Edit-ProjectHub.ps1` refuses a page
that does not exist yet.

```powershell
tools/Copy-LocalPagesToProject.ps1 -SourcePath notebook/<topic> -ProjectSlug <slug> -Title <t> -Purpose <p> -Preflight
```

**Where the pages land is a parameter, never a guess.** Three destinations:

| | Destination | Use it for |
| --- | --- | --- |
| *(default)* | `projects/<slug>/notes/**` | working notes and narrative — the common case |
| `-DestinationDirectory <dir>` | `projects/<slug>/<dir>/**` | a page that belongs at a named path, `decisions/` above all |
| `-AtProjectRoot` | one file beside `_project` | a single page that is not narrative; refuses a folder |

`-DestinationDirectory` is what makes ADR-0003's `decisions/NNNN-slug.md` shape reachable for a
subject with no repository of its own. It is **never inferred from the source folder's name**: a
source folder called `decisions` still lands under `notes/` unless the parameter says otherwise,
which is the failure that would read as success. Each segment must be lowercase letters, digits
and single hyphens — that whitelist is what keeps the write inside `projects/<slug>/`, rather than
a blocklist of traversals — and the two switches are mutually exclusive.

**`_project`, `connections` and `README` are refused on every route.** `New-ProjectHub.ps1` seeds
those three, and only `Edit-ProjectHub.ps1` rewrites the root: it journals the previous body, holds
the `projects/<slug>` lock and verifies the readback, none of which a copy does.
`Guard-BasicMemoryRead.ps1` refuses a direct `write_note` to a Hub root for the same reason, so a
copy that could land there would be a side door around one boundary rather than a second one.

**The source must be local and permitted, which is a step to plan rather than discover.**
`Resolve-LocalSourceRoot` allows `notebook/` and one note under a capture Book's `wiki/notes/`, and
nothing else — so a page bound for `decisions/` is authored in the Notebook first, and a Notebook
write needs the reader's request. A **new** `notebook/<topic>/` also owes the rendered master index
(commit it through `Invoke-NotebookRender`) and a `tools/Set-NotebookTopicOwner.ps1` record, which
no gate checks but the Library Reset preflight requires. That helper became **claim-gated** on
2026-09-09 (ADR-0019): it needs the acting session's own live seat claim, and it refuses to move a
topic away from another seat whose agent is still running.

The `plan_id` binds the destination as well as the content, so an approval for `decisions/` cannot
be spent on a run that lands the same pages under `notes/`. Re-running a satisfied copy reuses its
records instead of rewriting them, and a destination already holding *different* content is refused
unless `-ReplaceExisting` is passed. Every run journals to `internal/publication-journals/`, keyed
on the page manifest, so one source copied to two destinations keeps two records rather than
overwriting the first.

Read the preflight's `planned_project_records` before approving — the composed destination paths
and the `source_path` provenance labels, not just the `plan_id` and the counts. That list is what
exposed a label defect on 2026-09-08 that six falsification rounds had not.

Detail: [Project Hub Design](project-hub-design.md), *The subject-follows rule*.

## Edit an open Project Hub page

Filling in `Now`, `Connected knowledge`, or any other section of a Hub is ordinary work, not a
ceremony. Use `tools/Edit-ProjectHub.ps1` with the exact open Project slug and page; `_project` is
the default page.

```powershell
tools/Edit-ProjectHub.ps1 -ProjectSlug <slug> -Mode AppendSection -Section 'Now' -ContentPath <local-markdown-file>
```

The Project must be open on the Virtual Desk, and only an active `projects/<slug>` Hub is editable;
an archived Hub is read-only. Seven modes exist:

| Mode | Use it for | Gate |
| --- | --- | --- |
| `AddSection` | a section the page does not have yet | applies directly |
| `AppendSection` | adding to the end of a section | applies directly |
| `CheckItem` | ticking (or with `-Uncheck`, unticking) one checklist item | applies directly |
| `ReplaceItem` | rewriting one list item or line | preflight `plan_id` + `-UserConfirmed` |
| `ReplaceSection` | rewriting a whole section | preflight `plan_id` + `-UserConfirmed` |
| `RemoveSection` | deleting a whole section | preflight `plan_id` + `-UserConfirmed` |
| `ReplaceBody` | rewriting the whole page | preflight `plan_id` + `-UserConfirmed` |

The three direct modes cannot lose text: the two additive ones are checked to preserve every
existing line, and `CheckItem` is checked to alter nothing but one checkbox marker. For the four
gated modes, run `-Preflight` first, show the before and after with the returned `plan_id`, and
rerun with `-UserConfirmed -ApprovedPlanId <that exact plan_id>` after one clear yes.

`RemoveSection` takes neither `-Content` nor `-MatchText`, and refuses `Purpose`, `Now` and `Next`
by name as structural. **There is no remove-item mode:** `ReplaceItem` requires non-empty content,
so retiring one closed `Now` entry means a `ReplaceSection` that rewrites the section without it.

`CheckItem` and `ReplaceItem` find their target with `-MatchText`, text that appears in exactly one
item, matched case-sensitively; an ambiguous match is refused and lists what it hit. `-Section` is
required for the section modes and optional for the item modes, where it narrows the search. A
wrapped item counts as one item: its indented continuation lines travel with it.

**Every mode now has a precondition, and the lock is held to the end.** Immediately before writing,
the helper re-reads the page and compares its digest to the one the plan was built from; a page that
changed in between is a refusal with nothing written, and the message says the text you were editing
is no longer what is there. Until 2026-09-07 only the four gated modes checked that — through their
`plan_id` — so `AddSection`, `AppendSection` and `CheckItem` applied with no precondition at all and
reported success. The `projects/<slug>` lock is taken before that final re-read and held through the
write, the readback and the journal: released earlier, another helper's perfectly correct write could
land in between and make this run report a failed verification for an edit that succeeded.

**It is not compare-and-swap, and it does not pretend to be.** `write_note` exposes no
expected-digest argument, so the residual window is one network round trip wide, and the lock
excludes Library helpers rather than every writer. It closes the window that is actually ours.

Every run reads the page at its exact canonical path, refuses a substituted path, journals the
previous body to `internal/publication-journals/` before writing, and verifies the readback against
the approved text. An edit that would change nothing reports `unchanged` and writes nothing.
`-Preflight` works on every mode, including the direct ones, and is a safe way to preview a long
append. Prefer `-ContentPath` over `-Content` for prose: it keeps punctuation and long text out of
the command line.

**A `ReplaceBody` whose `-ContentPath` is a file under `notebook/` records copy evidence for that
Notebook page, and no other edit does** (2026-09-18). This is the route for a Hub page whose
Notebook source has **drifted**, because triage cannot do it: `Invoke-LibraryTriage.ps1` is
create-and-additive only and rejects `replace_existing` at plan validation, so a destination that
already exists is refused. Until this was fixed the edit bound nothing, and the page went on
reading `known-copy-drifted` in `Get-LibraryTriageInventory.ps1` and in the reset's copy advisory —
which named it as one to act on while the only additive tool refused it, a closed loop. **The
narrowness is deliberate:** only a whole-body replace makes the page carry the whole source, so an
append, a section replace, an inline `-Content` edit, and a `-ContentPath` outside `notebook/`
record nothing. A wrong `known-current-copy` would be far worse than a missing one, because it
tells a reset that material is safe when it is not. **Prove a page current from this helper**, by
re-running the same `-Preflight` and reading `unchanged: True`, rather than from the inventory.

The helper writes to the pinned `ai-library` project by default. A Hub in a different Basic Memory
project needs `-ProjectId <uuid>`; that is how the disposable acceptance runs stay out of the live
collection.

**Two things the direct MCP path will no longer do**, both refused by `Guard-BasicMemoryRead.ps1`
since 2026-09-07:

- **`write_note` to a Hub *root* page** (`projects/<slug>/_project.md`), and only the root. It is the
  page every session touches at close and the most structured page in the collection, so a whole-page
  overwrite of it goes through this helper — which journals the previous body, holds the lock, and
  verifies the readback. Every other page under `projects/<slug>/` keeps the direct path on purpose:
  `notes/` and `limits/` are append-only narrative, collisions there are least likely, and the escape
  hatch matters more, because there is no remove-item mode and retiring one closed entry already
  costs a whole `ReplaceSection`.
- **`edit_note` with anything but `replace_section` or `find_replace`.** `append`, `prepend`,
  `insert_before_section` and `insert_after_section` duplicate content silently on a second
  application, and nothing on the direct path journals a previous body or reads back what it wrote.
  It is an allowlist rather than a denylist of those four, so an oddly-cased spelling and any
  operation added to the tool later are refused too — a guard that admits what it has not been taught
  fails open, silently.

Detail: [Hook-Enforced Boundaries](hook-enforced-boundaries.md).

`tools/Edit-ProjectHub.ps1 -SelfTest` checks the section and fence handling offline, with no NAS
access and no shared write.

## Archive a Book or Project

To archive a Book, preflight
`tools/Archive-SharedBook.ps1 -BookSlug <slug> -Preflight`, show the move from `books/<slug>/` to
`archive/<slug>/`, and ask once for approval. Rerun with `-UserConfirmed` only after a clear yes.
The helper uses a native move, verifies the root, reader map, and linked pages at the archive path,
records the Book in `archive/README.md`, and removes the active Catalog entry. It preserves local
working material.

It then removes the emptied `books/<slug>/` directory, which the note move leaves behind. Read
`source_tree_removed` on the result: `removed` is the ordinary outcome, `absent` means a rerun found
nothing, and **`unavailable` means the collection filesystem could not be reached and the emptied
directory is still there** -- say so rather than reporting a clean archive. `not-empty` means files
remain and the helper refused to touch them, which is worth looking at before doing anything else.
The preflight names this outcome in advance, so an unreachable share is known before you ask for
approval.

Listing that entry is also what repairs the archive catalog's pilot-era emptiness sentence: one
`find_replace` of one verbatim sentence, run last, never able to remove an entry, and reported as
`emptiness_claim` on the result. Until an archive runs, `Invoke-LibraryChecks.ps1 -IncludeShared`
warns through `shared.archive-catalog-consistency` — a known state, not a defect to chase, and not
grounds for correcting the live page around the Desk guard. Detail:
[Book Archive Model](book-archive-model.md).

To remove a Shelf Book without publishing it, preflight
`tools/Remove-ShelfBook.ps1 -BookSlug <slug> -Preflight`. Show every file, the Catalog and Desk
changes, the source-reference lists, and that deletion is permanent and creates no local archive
copy. After one clear approval, rerun with `-UserConfirmed` and the exact `-ApprovedPlanId`.

`Archive-ShelfBook.ps1` remains a compatibility helper for Books already placed in
`shelf/_archive/`; it is not part of the active two-exit Shelf lifecycle. Do not route new Shelf
cleanup through it.

To retire a **duplicated topic** rather than a whole Book, follow
[Duplicate Topic Resolution](duplicate-topic-resolution.md) — read every page of the losing copy
first, carry anything genuinely unique into the canonical Book, and only then stub. Stubbing is
`tools/Set-ShelfBookPageStub.ps1` with the Book open: preflight, show the reader the exact
replacement text, one approval bound to the page's current content. Never delete the losing copy
outright; a stub preserves the path and the honest record that duplicate coverage existed. Record the
resolution with `tools/Set-TopicOverlap.ps1` afterwards. Full detail:
[Retiring Shelf Material](shelf-book-retirement.md).

To archive a Project, preflight
`tools/Archive-ProjectHub.ps1 -ProjectSlug <slug> -Preflight`, show the move from
`projects/<slug>/` to `archive/projects/<slug>/`, and ask once for approval. Rerun with
`-UserConfirmed` only after a clear yes. The helper validates moved notes, updates exact root
self-links and both Project Catalogs, and never changes related Books or a Vikunja board.
It removes the emptied `projects/<slug>/` directory afterwards and reports `source_tree_removed` the
same way; read it the same way.

**Neither archiver can see a leftover directory over MCP, and neither can any other check.** Basic
Memory indexes notes, so an emptied directory is invisible to `list_directory`, to both Catalogs, and
to Discovery -- on 2026-08-29 six of them accumulated while five index-backed surfaces all reported
the collection clean. `Invoke-LibraryChecks.ps1 -IncludeShared` now WARNs through
`shared.archive-leaves-no-husk`, which is the only check that looks at the collection's filesystem.
If it warns, remove the named directories there; they hold no files. Detail:
[Book Archive Model](book-archive-model.md).

## Repair a derived index

`notebook/_master-index.md` and `shelf/_catalog.md` are rendered, not authored. If the gate reports
`notebook.master-index-renders` or `shelf.catalog-renders-from-entries` failing, the file on disk
disagrees with what it is derived from — usually because something edited it by hand. Re-render it:

```powershell
tools/NotebookIndex.ps1 -Render -WorkspacePath .
tools/ShelfCatalog.ps1 -Render -WorkspacePath .
```

Neither check repairs what it finds, deliberately: a check that fixed the drift would report a
healthy Library on every run while the writer that caused it stayed broken. A render that refuses
names the topic or Book it cannot render and what to repair — most often a topic directory whose
`_index.md` is missing or carries no single column-zero H1, or a Shelf Book with no
`_catalog-entry.md`. A Shelf that predates the split needs
`tools/ShelfCatalog.ps1 -Migrate -WorkspacePath .` once; `-Preflight` shows what it would write.

**One other route reaches the same repair, and it names it for you.** A failed compile, rename,
archive or Shelf deletion rolls itself back and then *re-derives* the index rather than restoring
one — a derived index is never journaled. If that last step is the part that could not run, the
result says so in those words: the files it restored are back, and one of the two commands above
finishes the job. Read it as a half-complete rollback, not a failed one, and do not reach for the
journal. Full contract: [Derived Indexes](derived-indexes.md).

## Work at a seat

A **seat** is a named place to work, carrying its own Desk and bound to exactly one Project. One
checkout, one collection, one Shelf, one Notebook, N Desks (ADR-0015). Three research topics at once
means three seats, not three clones.

```powershell
tools/Start-LibrarySeat.ps1 -Seat <name> -Project <project-slug>
```

It creates the seat if it is new, migrates a pre-seat Desk into it, holds the seat's exclusive
session claim for the life of the session, and starts the agent there. **With no `-Seat` it is a
picker** (2026-09-10): one numbered entry per seat with its Project, whether anyone is at it, when it
was last active and what its last conversation was called — a row on a wide terminal, a card of one
field per line below 120 columns (2026-09-11), with the same numbers either way; a number resumes
that conversation,
`n<number>` starts a new one there, `+` creates a seat after one confirmation, `r<number>` retires one
through its own preflight. A caller that cannot be prompted -- a script, a hook, a tool call -- is
refused and told to pass `-Seat`, so nothing here waits on an answer that cannot come. `-Preflight` shows what it
would do without doing it - and **refuses outright when another session already holds that seat**,
rather than printing a plan for a start the claim is certain to refuse. Corrected 2026-09-09: it
used to report `claim_live: True`, promise `launch: claude` and exit 0 in exactly that case.

**There is no default seat.** A session that names none has no Desk: it can read the Library's own
files, and it can open nothing, read no Book, and change nothing. That is a real state rather than a
misconfiguration — a default would be the seat an unset `LIBRARY_SEAT` silently falls back to, and
since a seat holds live work, anything that lost its seat would join someone else's. When a helper
refuses for want of a seat, the refusal names the fix; pass it on rather than working around it.

**Reads never need the claim; changes always do.** `Set-VirtualDesk -Action List`, the Catalogs and
every reader tool work without one. Opening a Book, compiling, editing a Hub and resetting do not.

**One session per seat.** A second session at an occupied seat is refused. `Get-DeskOverview.ps1`
reports this seat's Desk in full and one line per other seat — its open counts, whether it is
claimed, and an advisory last-activity time. Another seat's open Books are deliberately not listed:
naming them would put material on this reader's Desk that they did not open.

**This seat's own line carries its occupancy too** (2026-09-10): a `this_seat` object with the source
that named the seat, `free`/`held`/`orphaned` with the repair spelled out for an orphan, the agent
process and start time, the bind time and seat incarnation, and the seat's last conversation with its
title — or, when there is no title, the sentence saying which of six reasons that is. Lead a Desk
summary with what it says about **this** seat; another seat's conversation is not on it, by the same
rule that keeps its open Books off it. Detail: [Seats](seats.md), *What the Desk overview says about a
seat*.

**Retiring a seat is gated and recoverable.** Preflight `tools/Retire-Seat.ps1 -Seat <name>
-Preflight`, show the reader the Desk it will archive **and the `records_to_archive` line beside it**,
and rerun with `-UserConfirmed` and the exact `-ApprovedPlanId` after one clear yes. It refuses a seat
with a live session, because retirement is what makes a seat's material eligible for a whole-tree
reset. The Desk is archived to `internal/seat-archive/`, never discarded: it is the only durable
record of what was open. Since 2026-09-10 the seat's own records travel with it — its conversation
history, its binding, and any holder attempt — because retirement deletes the seat directory and
`conversations.json` is the only copy of which conversations sat there.

**The archive record IS the retirement, and a deleted seat directory is not one** (2026-09-10).
Nothing infers retirement from a missing `.claude/seats/<name>` folder any more: `seat.json` names
the seat *and its incarnation*, and that record plus absence from the registry is what makes a
seat's Notebook topics reachable by a whole-tree reset and its name reusable by a new seat. So when
a seat folder has been deleted by hand, do not work around it — **retire the seat**, which works on
a seat whose Desk files are gone. `Get-DeskOverview.ps1` reports the disagreement in a
`seat_consistency` block naming the route for each state, and `desk.seat-retirement-identity` fails
the gate on it. A slug may be reused after a real retirement; it is refused while an ownership row
names an incarnation no retirement record accounts for, and the refusal names that row.

**A retired seat's Desk can be put back, and its archive can be destroyed** (2026-09-10). Both are in
*Recover from a reset or a retirement* below: `-RestoreDeskFromArchive` on this same launcher, and
`tools/Remove-SeatArchive.ps1`, which refuses when deleting a retirement record would leave Notebook
material nothing can account for. Read that section before quoting either.

**A cross-seat operation consults every seat.** Rename, archive and remove ask whether material is in
play anywhere, not just here; rename rewrites the entry at every seat that holds it. A missed seat
would be left pointing at a slug a future Book could occupy. Detail: [Seats](seats.md).

## Reset the local Notebook

A request to **reset** or **clear my workspace/notebook** means the bounded local-notebook reset
unless the user explicitly names another target. First run
`tools/Reset-LocalNotebook.ps1 -WorkspacePath . -Preflight`. Show the `notebook/` target, item
count, the topics it would quarantine, **`loose_files_to_quarantine`**, the open-Book/open-Project
advisory, and the internal-journal-based Library-copy advisory. Explain that the advisory does not
verify NAS state and cannot protect excluded or uncertain material.

**Read that advisory per topic, not just in total** (2026-09-15, [ADR-0022](adr/0022-reachability-names-the-destination-class.md)). `library_copy_advisory.topics`
carries one row per Notebook topic, and the whole-Notebook figure above it can be overwhelmingly
reassuring while one topic is covered not at all — which is the topic the reader needs named.
Per row: **`pages_without_current_copy` is the number to act on**, because only
`known-current-copy` is proof — a `legacy-copy-record` is synthesised with an empty source hash
and binds no content, and a drifted one binds another version. **`known_books` and
`known_projects` are reported separately and must not be merged when you relay them**: both are
out of a reset's reach, so neither is safer, but the reader opens them with
`Set-VirtualDesk.ps1 -Kind Book` against `-Kind Project` and reads them with different tools.
A row with an empty `topic` is the loose files directly under `notebook/`, which a reset also
quarantines. These rows describe the Notebook as it was read **before** any move; after a
completed run, `remaining_in_notebook` is what is actually left.

**The preflight now issues a `plan_id`, and a claimless session is refused before it gets one.** The
digest covers the seat, both scope switches, the exact topics with their owners, and the loose files
— so an approval cannot execute a different reset from the one that was shown. Keep the `plan_id`:
the confirmed run needs it.

**A Reset is not a Git operation, and a clean working tree is not evidence of one.** "Reset", "start
fresh", and "clear my workspace" name this bounded action, never a repository cleanup: it modifies no
tracked file and runs no Git command, so `git status` says nothing about whether it happened — the
Desk state and `notebook/` do. A session rooted here once read the request as a working-tree cleanup
and reported the branch clean while the Desk still held two Books and a Project Hub. Where the reader
could genuinely mean repository cleanup, ask them to distinguish **Library Reset** from **Git
cleanup** rather than taking the destructive reading.

**Offer to triage the Notebook first.** Triage is what makes a reset safe, and `triage` is a tidying
verb that reads as optional — so say it, rather than assuming the reader knows the Notebook is what
disappears. Reset is nonetheless separate from triage: never chain a shared write into this
confirmation. After a clear yes, run
`tools/Reset-LocalNotebook.ps1 -WorkspacePath . -UserConfirmed -ApprovedPlanId <that exact plan_id>`.
It moves this
seat's topics into `internal/notebook-reset-quarantine/<stamp>/` and rebuilds only `notebook/`,
preserving `docs/`, `raw/`, `output/`, `internal/`, configuration, tools, and the shared Library.
**Nothing it moves is destroyed** — say "set aside", and name the restore route below when the
reader asks. The removal, the scaffold and the master-index render happen inside one
critical section, so there is no window in which the index still advertises topics that are gone; the
result reports `master_index_topic_count`, read from the render rather than asserted, because a reset
that rebuilt an index still listing topics would be a reset that did not remove them.

**Show `remaining_in_notebook` after a completed run, not the preflight's `topics_*` fields.** Those
five name what the reader *approved* and are kept for exactly that; `remaining_in_notebook` is
re-derived inside the registry lock after the moves and names what is actually still in `notebook/`
and whose it is — `owned_by_this_seat`, `owned_by_other_seats`, `protected`,
`owned_by_retired_seats`, `owned_by_unaccounted_seats` and `unmapped`. The two can disagree, and
where they do the second one is the true one: a `-WholeTree` run quarantines a retired seat's topic,
so the prediction still names it and the Notebook no longer holds it. **`owned_by_this_seat` should
be empty** — a topic this seat owns that is still there is a move that did not happen, and
`left_in_place` says why. `tools/Get-DeskOverview.ps1` answers the same question at any time, with
each Notebook topic labelled `yours (<seat>)`, `seat <other>`, `shared`, `excluded` or `unmapped`.

**A refused `plan_id` is the guard working, not an error to route around.** The selection is
recomputed under the lock and the digest rechecked, so a topic that entered the target set or a loose
file that appeared since the preview stops the run with nothing moved. Rerun the preflight, show the
reader what changed, and ask again — never reach for a fresh `plan_id` to make the old approval go
through.

**A reset is scoped to the seat that runs it (ADR-0016).** It never reaches another seat's Desk, and
the preflight names the seat it is about to act on. Say which seat, because with more than one open
the reader is approving one of them.

**`-AllIdleSeats` widens that scope to every seat that is idle right now** (2026-09-15,
[ADR-0023](adr/0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md)). A reader who
asks to clear the Notebook usually means the Notebook, not their slice of it — and a seat-scoped
reset leaves behind every other seat's topics. Add the switch when that is what they meant. It takes
each foreign topic whose owning incarnation the registry still names and whose seat holds no session
now; it **names and leaves** a seat with a live session or a lost claim holder, and a retired or
unaccounted incarnation's topics are not its business at all. **Skipping is not refusing** — the run
carries on and says which rule left each topic alone, because "clear every idle seat" is a request
one busy seat must not cancel. The preflight's `seat_scope` line says which of the three scopes this
is; show it beside `desk_action`, for the same reason that one is shown.

**Read the preflight's `sweep` block before relaying anything else about a sweep.** It is on every
run and empty when the switch was not passed, so it can be asserted and can be missed.
`sweep.to_sweep` carries one row per topic the run would take — its `seat` and `seat_id`, and the
same copy evidence the per-topic advisory uses: `copy_evidence`, `page_count`,
**`pages_without_current_copy`**, `known_books` and `known_projects`. That is whose it is and what
already exists durably, in the preflight itself rather than in a separate report the reader would
have to know to run. `sweep.skipped` carries one row per foreign topic it deliberately leaves, with
`incarnation_status`, `claim_state`, `reason` and the predicate's own **`note`** — relay that note as
it stands rather than composing a remedy beside it, which is how this repository's two authorities
always come to disagree. `seats_resolved` and `claim_probes` are the real counters: each distinct
`(seat, seat_id)` is probed **once per pass**, not once per topic.

**`-AllIdleSeats` and `-WholeTree` are refused together, and they compose in sequence instead.**
`-WholeTree` covers this seat plus explicitly **retired** incarnations; `-AllIdleSeats` covers seats
that are merely **idle now**. Passing both is an error that selects nothing, because the switch is
load-bearing rather than cosmetic: if they composed, the foreign refusal that keeps ADR-0016's third
case refused would be half-silenced by a second switch, and the next reader would find `-WholeTree`
reaching an idle seat with no decision saying it may. When the reader wants both, **run the sweep
first and the whole-tree reset after** — each with its own preflight and its own approval. Say that,
rather than passing the refusal on as a limitation.

**NO SCOPE OF THIS HELPER EMPTIES `notebook/`, and a reader who asked for an empty Notebook must be
told so before they approve** (2026-09-15, from a `2nd-b-vault-dev` Report Inbox note verified
against the code). A topic declared `shared` or `excluded` is in neither the target set nor the
foreign, retired or unaccounted ones — `NotebookOwnership.ps1:622-623` puts both into `protected`
and stops there, so **no seat's reset of any scope takes it**. Add that to the three scope rules and
a topic can remain for four different reasons: another seat owns it and you did not sweep; its seat
is busy and the sweep named it; its incarnation is retired and that is `-WholeTree`'s; or it is
declared out of scope and nothing here reaches it. **Say which reason applies to which topic**, and
say plainly that "empty" is not something a reset delivers on its own.

**The route past an `excluded` topic is a deliberate ownership change, and it is not a step in the
reset.** `tools/Set-NotebookTopicOwner.ps1` moves the topic off `excluded`, and only then does a
reset see it. Offer that as its own decision rather than as the next thing to do, and **ask what the
declaration is protecting** before helping anyone undo it: an `excluded` row is somebody's deliberate
assertion that a topic is precious, and lifting it is the reader's call.

**But the declaration has to be earned, and since 2026-09-18 the helper checks it
([ADR-0025](adr/0025-a-protected-topic-states-whether-it-can-be-rebuilt.md)).**
`tools/Set-NotebookTopicOwner.ps1 -Scope excluded` **refuses** a topic whose every page is a
hash-bound current copy of a published Book — `tools/Restore-BookSource.ps1` rebuilds exactly that
source, so the declaration would put a reproducible topic outside every reset at every scope and cost
the reader the empty Notebook they asked for. It still goes through whenever the topic holds
something the Book does not: a **drifted** page, one recorded only by a legacy journal, or one never
published at all. That is the case an `excluded` declaration is actually for, and it is why the
refusal is narrow. `notebook/orca-ide` was the counter-example the rule came from — declared
`excluded` to shield a published Book's refresh source, a shield that was never earned.
`-AcceptReproducible` writes the declaration over the evidence and reports that it did.

**The preflight now says what will REMAIN, and `predicted_remaining` is the field to read it from**
(2026-09-15). It mirrors `remaining_in_notebook` field for field, so the prediction and the outcome
can be read against each other, and it carries the two things a reader deciding about a reset
actually needs: **`notebook_will_be_empty`**, the answer to the question they asked, and
**`protected_recoverability`**, one row per protected topic saying whether a completed publication
journal exists for a Book of that slug. Show both **before** taking an approval. A disagreement
between `predicted_remaining` and `remaining_in_notebook` after a completed run is a move that did
not go as approved.

**Do not add the leftover fields up by hand; that recipe is wrong at two of the three scopes.** The
classification lists overlap `targets` by design — a swept foreign topic is in `foreign` *and*
`targets`, and under `-WholeTree` a retired one is in `retired` *and* `targets` — so adding them up
over-reports what survives. `predicted_remaining` subtracts the target set instead, which is why it
exists rather than being left to the reader. `topics_unmapped` is still not a leftover at all but a
refusal that stops the run, and `predicted_remaining.note` says so when that is the case.

**And an `excluded` topic with a publication journal is not precious — it is reproducible.** That is
what `protected_recoverability` is for, and it is the difference between a declaration worth keeping
and one that is costing the reader an empty Notebook for nothing. Read the row before repeating the
advice above: `complete_publication_journals` above zero means `tools/Restore-BookSource.ps1` can
rebuild that topic from the published Book, and zero means it really is the only copy. The row
reports evidence and never a verdict — that helper additionally needs the Book **open on the Desk**,
refuses to overwrite an existing `notebook/<slug>`, and aborts on a single page-hash mismatch.

**A sweep makes one quarantine across several seats' topics, and its journal is the only record of
whose each topic was.** The ownership rows stay in `internal/notebook-topic-owners.json` pointing at
their seats, but a purge takes them and the quarantined material carries no owner of its own — so
`reset-journal.json` records `all_idle_seats` beside `whole_tree` and one `{topic, seat, seat_id}`
row per topic. Both seatless reads surface it: `-List` reports `all_idle_seats` so a sweep's
quarantine is not read as an ordinary one, and `-Quarantine <name> -Show` reports `recorded_owners`,
one row per topic. That is what answers *"can this go back to the seat it came from?"* — and a
quarantine whose journal is missing is still restorable and belongs to nobody the Library can name.

**Which of the two shapes to run is decided by the reader's wording (ADR-0010).** The default
preserves the Virtual Desk, so every open Book and Project Hub stays open. Add **`-ClearDesk`** for
the full Library Reset when the reader says "reset my workspace", "start fresh", or otherwise asks
for a clean slate rather than clean notes. The preflight reports `desk_action` as `preserved` or
`cleared` -- show that line, because it is the one thing distinguishing the two operations, and the
reader is approving one of them. If their wording does not settle it, ask; do not assume the wider
one. Do not offer a local Notebook archive.
If retention is wanted before resetting, help the user capture unsorted findings to the Holding Shelf
with `tools/Add-ShelfNote.ps1`, or run `tools/Invoke-LibraryTriage.ps1` to send Notebook material to
a Shelf Book, a Project Hub, or a new shared Book.

## Recover from a reset or a retirement

Three routes, added 2026-09-10, for the material a reset or a retirement set aside. Two of them
destroy things permanently; read which is which before quoting a command.

**See what is recoverable first.** `tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List`
names every quarantine with the seat that made it, when, and the topics and loose files it holds.
This one is a **read** and needs no seat, which matters: a reader whose session has lost its seat is
exactly the reader asking what survived. `tools/Remove-SeatArchive.ps1 -List` does the same for
retired seats' archives.

**Read `whole_tree` and `all_idle_seats` together, never one of them.** Each row reports both, because
either can be the reason one quarantine holds material belonging to more than one seat — and a sweep's
quarantine is `whole_tree: false` exactly as an ordinary seat-scoped one is. `all_idle_seats` is
`false` on every quarantine made before 2026-09-15, which is true of them: nothing before that date
was a sweep.

**Then name the articles in one of them** (2026-09-15). A topic is a folder, so the roster's topic
list does not answer *"is the page I lost in there?"* —
`tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine <name> -Show` does, with one row
per topic carrying its articles, its `article_count` and its `file_count`. It is a read like `-List`
and needs no seat either; it names files and never page content. `file_count` above `article_count`
means the topic holds something this listing does not name — an attachment, a stray file — rather
than nothing.

**It also names whose each topic was, under `recorded_owners`** (2026-09-15) — one `{topic, seat,
seat_id}` row per topic, read from the quarantine's journal. For a sweep that is the only record
there is: one run quarantines several seats' topics, the ownership rows left behind are taken by a
purge, and the material carries no owner of its own. It is empty for a quarantine whose journal is
missing or predates the record, which is reported rather than guessed at from the directory name.

**Read `stamp_source` before you quote an age.** Both reads report `stamped_utc`, `age_days` and
`stamp_source`, and that last word is `journal`, `directory-name` or `unknown`. A quarantine whose
`reset-journal.json` is missing or unreadable is dated from its own stamped directory name instead,
and `quarantined_utc` stays empty — the journal's field is never filled in from the name. Where
`stamp_source` is `unknown` there is no date at all; say so rather than treating a blank as new.
**`quarantined_by` is empty in exactly those cases too, and is not guessed from the directory
prefix**: the seat decides whether a restore may act, so it comes from the record or not at all.

**`tools/Get-DeskOverview.ps1` says how many quarantines there are without being asked**, under
`notebook.quarantine`: the count, the topics they hold between them, the oldest with its age, and
`undated_count` for any nothing can date. It is the count and the route, never the contents — and
the Desk **throws without a seat** while both reads above need none, so when a reader has lost their
seat, quote them the `-List` command rather than the overview.

**Restore quarantined Notebook material.** `tools/Restore-NotebookQuarantine.ps1 -WorkspacePath .
-Quarantine <name> -Preflight`, then rerun with `-UserConfirmed` and the exact `-ApprovedPlanId`
after one clear yes. Show the reader `topics_to_restore` **with the ownership disposition beside each
one** — `keep`, `record` or `adopt` — because that is what they are approving besides the move.
`-Topic <names>` narrows it to some of the topics; loose files travel only with a whole-quarantine
restore, and the plan says which ones it is leaving. It never writes over a topic that exists in
`notebook/` again: that is newer material, and the quarantined copy is left for the reader to merge.

**A row naming another incarnation needs `-Adopt`, and a live seat's is refused outright.** A reset
leaves each quarantined topic's ownership row citing the seat that owned it, and since slugs may be
reused that row can name an incarnation that is not this seat's. Adopting is taking the material
over, so it is asked for rather than assumed. If the refusal names a seat that is still registered,
the answer is to restore from that seat or reassign the topic first — not to pass `-Adopt`, which
does not lift that one.

**Purge a quarantine.** `tools/Remove-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine <name>
-Preflight`, same confirmation shape. **This is not recoverable**: nothing stages it, nothing
journals it, and `internal/` is not tracked, so no Git command brings it back. Say that plainly and
offer the restore first. It removes each destroyed topic's ownership row in the same operation —
leaving a row citing material that exists nowhere would block that seat's slug forever, and no reset
could ever clear it.

**Purge a retired seat's archive — and expect this one to refuse.**
`tools/Remove-SeatArchive.ps1 -Archive <name> -Preflight`. An archive is the **retirement record**,
not a keepsake: deleting it un-retires the incarnation it names, so that incarnation's Notebook
topics become `unaccounted`, every whole-tree reset refuses them, and the slug stops being reusable —
permanently, because retirement acts on a registry entry and there would no longer be one. The
preflight computes every ownership row's status twice, as things stand and against the records that
would remain, and refuses on any row that would change. Pass its refusal on with the three routes it
names; do not work around it. It also destroys the only durable copy of that seat's Desk, its
conversation history and its binding, so the preflight lists all of it.

**Restore a retired seat's Desk.** `tools/Start-LibrarySeat.ps1 -Seat <name>
-RestoreDeskFromArchive <archive> -Preflight`, then `-UserConfirmed -ApprovedPlanId <that id>`. It is
**additive**: it opens what that Desk had open and closes nothing. The archive's conversation history
travels only when the archive records that same seat slug — a conversation record says which seat a
conversation sat at, and copying it onto another name would make a claim that is not true; the plan
reports `history` as `merge`, `skipped` or `none` with the reason. The seat must already exist: there
is one approval per run and creating a seat already owns it, so create with `-NoLaunch` first and the
refusal spells out both commands.

## Capture and triage a Shelf note

Capture is ordinary work, not a ceremony. When the user wants a finding kept without sorting it now,
run `tools/Add-ShelfNote.ps1 -Title <title> -ContentPath <local-markdown-file>` with optional
`-Tags`, `-SourcePaths`, and `-SourceProject`. It needs no confirmation and no open Book because it
can only create a new page; it writes the note, reads it back byte-for-byte, and regenerates the
Book's reader map from what is on disk. A Book accepts notes only when its `shelf/_catalog.md` entry
carries `- **Kind:** capture`, so raw material can never land in a curated Book.

Triage names individual notes, so it requires the capture Book open on the Virtual Desk. Read the
notes through `mcp__validated-book-reader__read_open_book_page`, then use
`tools/Invoke-LibraryTriage.ps1 -Source Holding`:

| `-To` | Use it for | Gate |
| --- | --- | --- |
| `Notebook -Topic <slug>` | copying a note into `notebook/<topic>/` to work on, marking the Shelf copy reviewed | the source Book open |
| `Review` | marking a note reviewed, or reopening it with `-Reopen` | the source Book open |
| `ShelfBook -Slug <s> -PagePath <p>` | graduating a note straight into a curated Book | **both** Books open |
| `Project -Slug <s> -Title <t> -Purpose <p>` | sending a note to an active Project Hub | source Book open, plus `plan_id` + `-UserConfirmed` |
| `Book -Slug <s> -Title <t> -Summary <s>` | making a note a new shared Book | source Book open, plus `plan_id` + `-UserConfirmed` |
| `Discard` | deleting one note permanently | preflight `plan_id` + `-UserConfirmed` |

`Notebook` copies rather than moves, so the durable Shelf record survives the next reset. The other
destinations leave the note where it is, and separate its capture frontmatter from the body — that
block is Holding Shelf bookkeeping, not content. Name the note with `-MatchText` (case-sensitive, and
an ambiguous match is refused with the list of hits) or `-Page notes/<basename>`; the match is
resolved when the plan is made, so a note captured afterwards cannot change what an approval meant.
The discard `plan_id` covers the note's current content, so an edited note invalidates a stale
approval.

## Move a Library folder under the cutover protocol

A folder that holds the reader's own material is moved by `tools/Move-LibraryFolder.ps1` and by
nothing else. It exists because a plain copy-and-delete loses work in a way that looks like success:
a writer can change the source *after* its copy was verified, finish, and leave no lock for an
idleness check to find, so the new path silently lacks that writer's completed work.

**Say what the barrier does before you ask for approval.** The confirmed run raises a **maintenance
barrier** — a marker under `internal/` that every claim-gated mutator and both seat entry routes
refuse on. For the length of the run, at every seat, nobody can open or close a Book or a Project,
compile, triage, reset, restore a quarantine or a Book source, delete an open Shelf Book, set a topic
owner, start a session, or sit down at a seat. Reading is unaffected, and so are the writers that go
through neither door: **editing a Hub and adding a Holding Shelf note still work**, because
`Edit-ProjectHub.ps1` and `Add-ShelfNote.ps1` are not claim-gated and the barrier reaches nothing
else. (Until 2026-09-19 this paragraph said a Hub edit was refused. It never was.) That is not a side
effect to mention afterwards; it is the reader's whole Library stopping, and they decide when.

**The route.**

1. `tools/Move-LibraryFolder.ps1 -Action Status` first, any time, from any session. It needs no seat
   and changes nothing: it reports whether a barrier is up, which seats are live, which Book locks
   are held, and any run that has not finished.
2. `-SourcePath <folder> -DestinationPath <folder> -PointerPath <file> [-PointerPath <file>] -Preflight`.
   It **refuses outright** while any *other* seat is held or orphaned, while a Book lock is held,
   while a barrier is up, or while an earlier run is unfinished — a plan for a cutover that is
   certain to be refused is worse than no plan. It also refuses a destination that already exists,
   overlapping source and destination, a pointer inside the folder being moved, and a reparse point
   in the tree.

   **The Librarian's own seat does not block, and that is the one exemption there is** (ADR-0033,
   ruled 2026-09-19). The seat this session is driving the cutover from is excused from the engage
   scan, so the Librarian runs the preflight itself rather than only `-Action Status`. It is excused
   only when this process **proves** it holds that claim — a matching claim token, or a committed
   binding naming this process's agent, the same disjunction `Assert-SeatClaimHeld` admits. A session
   carrying `LIBRARY_SEAT` and no matching claim proves nothing and still blocks, and so does an
   **orphaned** seat, whose own remedy is to re-bind it. What is excused is only *"do not count me as
   a reason not to start"*: once the barrier is up that seat is refused every claim-gated mutation
   like every other. **Say which seat was excused** — `exempt_seat` names it on `-Action Status`, on
   the plan, on the result, and in the run's journal.
3. Show the reader `file_count`, `byte_count`, `aside`, every pointer row, and **`ambiguous_total`
   with its occurrences.** Those are places where the old path appears followed by a character that
   could extend it — a sibling folder like `D:\Library-DSH`, or a path followed by a space — and this
   helper deliberately leaves them alone. Under-rewriting is visible; over-rewriting renames folders
   nobody asked about. Anything genuinely stale there is the reader's to fix by hand.
4. After one clear yes, rerun with `-UserConfirmed -ApprovedPlanId <that exact id>`. The `plan_id` is
   re-derived **under the barrier**, so anything that changed since the preflight refuses the run.

**Read the result, and say the true thing about the source.** It reports `aside`, which is where the
source now is. **It is not deleted**, and the reader should not be told the old folder is gone: the
aside copy is what a rollback restores, and it is removed only by the archive purge, which is its own
gated operation with its own approval.

**The way back is a command, not a note.** `-Action Rollback -RunId <id> -Preflight`, then
`-UserConfirmed -ApprovedPlanId <that id>`. It puts the aside copy back at the source path, restores
every pointer from the bytes journalled before the move, and removes the destination — but only after
verifying the destination still holds exactly what the run copied there. **A destination somebody has
worked in since is refused**, listing the files, because that work exists in no journal. Say so
plainly rather than looking for a way around it.

**If a run was interrupted**, `-Action Status` names it and its last stage, and the journal under
`internal/move-journals/<run-id>.json` records every stage it reached. Roll it back rather than
starting a new one; a new cutover is refused while one is unfinished. `-Action LiftBarrier -RunId
<id> -UserConfirmed` lowers a barrier a crashed run left standing, and lifting it undoes **nothing** —
it only lets work start again.

Layout rules for the destination root: [Library Organization Model](library-organization.md), *The
`D:\deskpost\` root*.

## Mirror the collection into the vault

`tools/Export-CollectionToVault.ps1` copies the collection's `books/` and `projects/` -- and with
them the two catalogs -- into the reader's Obsidian vault at `40-Resources/Library`, one way, byte
for byte, **links never rewritten**. It replaced `D:\library-mirror`'s per-file exporter on
2026-09-19 (PLAN-public-release.md step 15).

**Say what it stops before you ask for approval.** For the length of the capture it holds a
**collection-wide export lock**, and while that is held nobody at any seat can publish, refresh,
archive, edit a Hub, write to a Shelf Book or rebuild a manifest -- `Enter-BookLock` and
`Assert-SeatClaimHeld` both refuse, each with its own message naming the export. Reading is
unaffected. It is shorter than a cutover barrier and narrower in what it blocks, but it is the same
kind of statement: the Library's writers stop, and the reader decides when.

**The route.**

1. `-VaultRoot <path> -Preflight`. **There is no default vault in code** -- pass `-VaultRoot` or set
   `$env:LIBRARY_VAULT_ROOT`, and the refusal names both. Read-only: it writes no manifest, no
   journal and no staged generation.
2. Show the reader `source_file_count`, `added`, `changed`, `removed`, `unmanaged_carried` and the
   `plan_id`. **`unmanaged_carried` is the reader's own files** -- anything in the mirror that no
   manifest claims. They are copied into the new generation untouched, and naming them is how the
   reader learns the mirror has files the export did not put there.
3. After one clear yes, rerun with `-UserConfirmed -ApprovedPlanId <that exact id>`. The `plan_id`
   binds every source hash and every destination hash, so anything that changed since the preflight
   refuses the run.

**The refusals, and what each one means.**

- **"managed file(s) in the vault no longer match what was exported"** -- somebody edited a mirrored
  note in Obsidian. The run writes nothing. That edit exists in no source, so copy what you want to
  keep out of the mirror first; once you have, the next run replaces it.
- **"file(s) already sit at ... and no manifest claims any of them"** -- a first run against a mirror
  another tool wrote. `-AdoptExistingMirror` retains that whole tree as a generation and starts
  managing a fresh one. **The retained tree is kept, never deleted**: no manifest describes it, so
  nothing can verify removing it is safe. Read it, then delete it by hand.
- **"source path(s) would land on an unmanaged file"** -- the reader made a file where a Book page
  now belongs. Move or delete it in the vault, then rerun.
- **"export run(s) did not finish"** -- see below. A new export is refused until it is resolved,
  because a second generation staged over an unfinished swap is how two generations get merged.

**An interrupted run is resumed or rolled back, never merged.** `-ResumeRunId <id> -Preflight` reads
the journal, observes the filesystem, and says which of the two renames happened and what finishing
would do; `-ResumeRunId <id> -UserConfirmed` does it. A run that never reached the swap rolls back
and the vault is exactly as it was. A run stopped between the renames is completed with the **new**
generation. The journals are under `internal/vault-export-journals/`.

**Read the result for `vault_edited_during_activation`, and say it plainly.** Activation is two
renames (ADR-0034), and a note written in the window between them lands in the generation being
retired. It is found by re-hashing that generation afterwards, copied to
`40-Resources\Library-recovered\<run-id>\` -- a visible folder that exists only when there is
something in it -- and named in the result. Tell the reader the path; nothing else will.

**The mirror is declared read-only in the vault's `folders:` registry.** That is a statement to the
reader, not enforcement: an Obsidian editor cannot be excluded, which is why the contract is
"anything that touched it is found and kept" rather than "nobody touches it".

## Further design detail

- [Library Inventory and Triage](library-triage-design.md) explains the copy and journal model.
- [Book Archive Model](book-archive-model.md) explains Book shelves and retention.
- [Project Hubs and Optional Action Boards](project-hub-design.md) explains Project behavior.
- [Notebook and Desk Model](notebook-and-desk-model.md) defines the reset boundary.
