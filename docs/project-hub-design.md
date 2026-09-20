# Project Hubs and Optional Action Boards

> **Status:** implemented and acceptance-tested in a disposable Basic Memory project on
> 2026-08-13, then validated in the live `ai-library` Project Hub for **Buzz Relay Deployment**
> on 2026-08-14.

## Decision

Keep one NAS-backed Basic Memory project, `ai-library`, but give **active work** a small,
separate home from reusable Books:

```text
projects/<project-slug>/           active Project Hubs
archive/projects/<project-slug>/   inactive Project Hubs
books/<book-slug>/                 reusable active reader copies
archive/<book-slug>/               reusable inactive reader copies
```

This is an information architecture inside one Basic Memory project, not a new Basic Memory MCP
project for every hobby or task. `projects/` holds living context. `books/` holds context that is
worth reopening as a self-contained reader copy. A completed Project Hub may produce a small
Project Book when that is useful, but publishing is optional.

The only project lifecycle is its location: active in `projects/`, inactive in
`archive/projects/`. There are no quality stages, review queues, or required status updates.

## What a Project Hub contains

Each Project starts with one concise home note. Add a sibling note only when it needs its own
research, decision, handoff, or history:

```text
projects/<project-slug>/
  _project.md
```

`_project.md` has a short, human-readable shape:

```markdown
---
title: <Project title>
---

# <Project title>

## Purpose

## Now

## Next
- [ ] A few concrete next actions

## Connected knowledge
- uses [[books/<reference-book>/wiki/_book]]

## Connected tools
<!-- Optional: a Vikunja board link and project ID. No credentials. -->
```

## `Now` is orientation, not a session log

> **Decided 2026-08-18**, after the rule this replaces failed in both directions on the same day.

**Reader benefit.** A returning session reads `Now` first and should be able to trust its first
paragraph without checking it against anything. **Safety boundary.** Nothing about this changes what
a write can touch: every Hub edit keeps its preflight, its journal, and its verified readback.

`Now` holds two kinds of sentence, and they have opposite lifecycles:

- **Orientation** — where the plan stands, what the gate is, what is operational. Stays true only if
  it is *rewritten*.
- **Open items** — a limit that is still unproven, a decision still owed, a defect not yet fixed.
  Leaves the section when it closes.

Everything else — what happened, what landed, what was learned — is **session narrative**, and it
goes straight to a dated `notes/` history page. That page is append-only and has **no size limit**,
because nothing orients from it.

**The rule this replaces, and why it was wrong.** A previous session found `Now` at 5,770 words with
a stale claim in its opening sentence, contradicted 134 lines below, and responded with a ~3,000-word
threshold: past it, move the closed portion out. The threshold fired in both wrong directions within
two days. It was breached by one ordinary session, so it demanded work when nothing was actually
wrong — and on 2026-08-18 the same stale-opening failure happened again at **1,888 words**, well
inside the limit, so it stayed quiet when something was.

Length was never the cause. Mixing a rewritten section with an appended one is: every append pushes
the orientation further from the eye, and nobody re-reads three thousand words to check the top still
holds. A word count is a proxy for "the top has probably rotted", and a poor one. The clause the rule
needed — *"do not trim entries to stay under it"* — is what you write when you already know a number
invites gaming.

**Why the split needs no threshold.** If narrative never lands in `Now`, `Now` never grows, so there
is nothing to monitor and no periodic migration to approve. It is also cheaper per session: appending
to a history page is additive and ungated, where the old cycle spent a gated `ReplaceSection` every
few days. The orientation block earns a gated rewrite only when the plan status genuinely changes,
which is exactly when someone should be looking at it.

### The premise above was falsified, and the fix is the same move (2026-09-06)

> **Decided 2026-09-06.** [ADR-0013](adr/0013-a-hub-section-holds-only-what-the-project-can-close.md).

*"If narrative never lands in `Now`, `Now` never grows"* is wrong. Narrative stopped arriving exactly
as designed — session history has gone to a dated `notes/` page since 2026-08-18 — and `Now` grew
anyway. Measured from the 222 `internal/publication-journals/` entries carrying a prior body of
`projects/library-dev/_project.md`: the 2026-08-26 migration cut the root from **81 KB to 21 KB**, and
eleven days later it was **30 KB** again, with `Now` entries up from 9 to 12.

It grew through the other kind of content this section names: **open items.** The definition above
says an open item *"leaves the section when it closes"*, and for a decision owed or a defect unfixed
that is true. For **an unproven limit it is not**: it closes when some event occurs, and the project
frequently cannot cause that event. Several such entries said so in their own text — *"do not
manufacture one"*, *"no executable lifecycle"*, *"the retry has never fired because no session has
expired"*. Those are limits the project has **accepted**, and each was already a decision that had
never been recorded as one, so it read as open forever.

So the arithmetic ran the wrong way: shipping a feature closes one `Next` item and adds one or two
`Now` limits. **Shipping made the root bigger.**

**The fix is not a better number.** The lesson above still holds — length was never the cause, and a
clause like *"do not trim entries to stay under it"* is what you write when you know a number invites
gaming. The byte thresholds that replaced the word count inherited the flaw: `Edit-ProjectHub.ps1`
recorded that `Now` had been over its cap since the cap shipped, warning "something true, identical,
and **unactionable** each time", and the response was to make the warning fire less often. The
symptom was suppressed rather than diagnosed. The caps also contradict the per-entry guidance:
12,000 bytes, minus a 3,509-byte orientation preamble, at ~1,200 bytes per entry, permits **seven**
entries. The section held twelve.

What worked in 2026-08-18 was **naming a destination** — its own account says the earlier rule failed
because *"concise"* was an adjective with nowhere to send anything. That move was applied to one of
the two things that grow. It is now applied to the other:

> **Every item on a Hub root section must have a closing condition the project can cause.** A limit
> whose proof needs an event you cannot cause goes to the **`limits` page** with a disposition. A
> settled question goes to `## Decisions` and the record it names. A standing practice goes to the
> subject's own rules or docs, never the Hub.

`Next` had the same defect from the other end: of thirteen entries, four closed by shipping, three
were deferred decisions, four were standing practice that never closes, and two were **verbatim
duplicates** of `.claude/rules/library-development.md`.

#### The `limits` page

`projects/<slug>/limits.md`, a companion to `connections`, size-exempt alongside `notes/`. Each row
carries a **disposition**, and the disposition is the mechanism:

- **accepted** — we have decided not to pursue proof. Closed. Never narrowed or revisited again.
- **awaiting** — it will close if the event occurs; nobody is causing it. Cheap to leave.
- **promoted** — someone decided to cause the event; it leaves for `Next` as work.

Most limits on a mature project are `accepted`, and accepted rows are inert. That is what makes this
stable rather than a larger budget: the page grows, but the part anyone must read or maintain does
not. Capping it would recreate the pressure that put those rows in `Now` to begin with.

A limit is **not** a decision in ADR-0003's sense. A decision settles *how the project works*; a
limit records *what has not been proven about work already done*. Keeping them apart is what stops
`## Decisions` — one-line pointers by design — becoming the next section with this problem.

**What no check can do.** Nothing can tell an open item from an accepted limit by reading it; that
judgement is the author's every time. `hub.sections-name-their-destinations` only guarantees the
reader is told the judgement exists and where its answers go — which is exactly what the adjective
*concise* failed to do.

**What stops this drifting back.** The earlier rule was an adjective — *concise* — with no named
destination, so session entries went to the only place there was. This one names the destination.
`Edit-ProjectHub.ps1` also returns a reminder when a `Now` append looks like a dated log entry; it is
a nudge and deliberately not a refusal, because an open item may legitimately carry a date and a
guard that cannot tell the two apart would block real content.

`Next` is deliberately a short orienting list, not a bespoke task database. Create a separate
note only when an action needs its own research, handoff, or history. Generated documents still
go to the local workspace's `output/` directory unless the user asks to preserve a concise result
in the Project Hub.

For an explicit request to start, save, or update a Project Hub, use the native Basic Memory
write or edit route at the exact active Project path and read it back at that exact path. This is
an ordinary project write: it has no preflight, manifest, digest, or separate confirmation. The
reader guard must protect direct content reads without pretending that user-requested Project
authoring is forbidden.

## Editing a Hub after creation

> **Status:** implemented and acceptance-tested against a disposable Basic Memory project on
> 2026-08-16, then used on the live `library-dev` Hub the same day.

`New-ProjectHub.ps1` only creates. Filling in the sections its own template leaves blank was, until
now, hand-rolled MCP JSON-RPC each time — the gap recorded as "No tool for editing a Project Hub
after creation" in the wiki-to-book retrospective. `tools/Edit-ProjectHub.ps1` closes it.

The helper takes a `-Mode` and edits one page of one open active Hub:

| Mode | Effect | Gate |
| --- | --- | --- |
| `AddSection` | appends a new level-two section | applies directly |
| `AppendSection` | adds text at the end of an existing section | applies directly |
| `CheckItem` | ticks or unticks one checklist item | applies directly |
| `ReplaceItem` | replaces one list item or line | preflight `plan_id` + `-UserConfirmed` |
| `ReplaceSection` | replaces one section's body, keeping its heading | preflight `plan_id` + `-UserConfirmed` |
| `ReplaceBody` | replaces the whole page body | preflight `plan_id` + `-UserConfirmed` |

The split follows the rule this design already set: an ordinary Project write is not a ceremony, so
the modes that cannot lose text apply directly. The ones that do remove text carry the same
preflight-and-exact-`plan_id` gate every other bounded helper uses. The claim of losslessness is
mechanical, not a promise: the additive modes assert that every existing non-blank line survives,
and `CheckItem` asserts that exactly one line changed and that it differs only in its checkbox
marker. Any other outcome refuses the write.

`CheckItem` and `ReplaceItem` exist because the most ordinary Hub edit — marking one `Next` item
done — was otherwise the most ceremonious, reachable only by re-supplying a whole section through
the gated path and risking retyping errors in text nobody meant to touch. They locate their target
with `-MatchText`, require it to match exactly one item, and treat a wrapped item as one unit so its
indented continuation lines travel with the marker line.

Four further boundaries make the direct route safe:

1. The Project must be open on the Virtual Desk. That open state is the boundary standing in for a
   confirmation on additive edits; an archived Hub is refused outright as read-only.
2. The page is read and re-read at its exact canonical path, and a response whose `file_path`
   differs stops the edit before any write — the same substituted-content protection the readers use.
3. The previous body is journaled to `internal/publication-journals/` *before* the write, so an
   interrupted or mismatched edit always leaves the prior text recoverable.
4. Section boundaries are found with a fence-aware scan, so a `#` or `##` line inside a fenced code
   block is content rather than a heading. This is the same class of defect the migration tools hit
   by scanning links without skipping fences.

Section matching is exact and case-sensitive, a duplicated section name is refused rather than
guessed at, and an edit that would produce the current text reports `unchanged` and writes nothing.
An appended bullet continues the list it lands in, while appended prose gets its own paragraph
break, so an edit reads like the section around it. `-SelfTest` covers the text handling offline:
33 checks, no NAS access.

A refusal reports its reason as a clean terminating error rather than a raw script throw, so the
message is not buried under the helper's own source position.

The live acceptance run against the disposable `publisher-acceptance-test-20260813` project proved
16 checks: closed-Project refusal, traversal refusal, missing-page and missing-section refusal,
additive writes with no `plan_id`, journal capture of the prior body, `AddSection` refusing an
existing section, a read-only preflight, refusal without confirmation, refusal on a wrong `plan_id`,
the confirmed replacement, the no-op path, and both content-input routes.

Two defects surfaced during that run and are fixed and covered. An absolute `-ContentPath` was
joined to the workspace root and rejected as malformed. And two edits made in the same second
derived the same default journal name, so the second overwrote the first's record of the previous
body; journal names now carry a `plan_id` suffix and were re-proved unique on a back-to-back pair.

### What the independent session found

A fresh session ran a six-check verification on 2026-08-16 and passed all six: the always-on guide
led it to the playbook without a search, the allowlist entry raised no permission prompt, the
journal held the whole previous body, both gated refusals fired before the confirmed write, the
closed-Project and traversal refusals held, and the offline suite ran clean. It also found four
things the building session had missed.

The real defect was list continuation on **wrapped** items. `Test-ListLine` looked only at the
section's last line, and a wrapped item ends on indented continuation prose rather than a marker, so
an appended bullet got a paragraph break instead of joining the list. Hub prose wraps everywhere, so
this was the common case, not the edge; the original self-test passed only because its fixture used
single-line bullets. The scan now walks back through continuation lines to decide, and the suite
carries wrapped fixtures for both the bullet and the prose case.

The other three were gaps rather than faults. `-ProjectId` was load-bearing for any Hub outside the
pinned project and appeared in no procedure — now documented. `-Preflight` worked on the direct
modes as a safe preview and was undocumented — now stated. And refusals arrived as raw PowerShell
throws carrying the helper's own source position while successes returned clean structured output;
refusals are now clean terminating errors. The fourth finding, no item-level edit, became
`CheckItem` and `ReplaceItem` above.

Ticking an already-ticked item briefly threw on the "exactly one line changed" assertion instead of
reporting `unchanged`; the no-op path now wins. Live acceptance is 23 checks after these additions.

Deliberately excluded at the time: creating a new Hub page **outside `notes/`**.
`New-ProjectHub.ps1` creates a Hub and `Copy-LocalPagesToProject.ps1` copied Notebook pages into
one; adding a third creation route was not needed by any observed request. **That exclusion ended
on 2026-09-08**, when the first request for it arrived: `decisions/NNNN-slug.md`, the shape *The
subject-follows rule* below had specified since 2026-08-31 and which nothing in `tools/` could
produce. It was closed by a `-DestinationDirectory` parameter on the existing copy helper rather
than by a third route, because that helper already carries the shared-write apparatus the shape
needs: the `plan_id` binds the destination, the publication journal records it, the readback is
verified against the approved text, and the Desk gate, the overwrite guard and the Hub-exists
preflight are all already in the path. A second implementation of a shared-write path is the drift
class this codebase keeps paying for. The MCP session boilerplate is still duplicated per helper, as the
retrospective notes; extracting it is a refactor of working code and stays unowned for now.

## Reader experience

The existing Book reader cannot safely read Project Hubs: it only permits exact paths below
`books/<slug>/wiki/`. Extend that same adapter rather than adding a second MCP process:

1. `projects/README.md` is the active Project Catalog. `archive/projects/README.md` is the
   archived Project Catalog; it remains separate from the Book archive index.
2. A project is opened through the existing Virtual Desk with a backward-compatible `Kind`
   selector (`Book` remains the default). `Kind Project` records the exact active or archive root
   in `.open-projects`; a missing state file is created and treated as empty everywhere.
3. The existing return-validating adapter gains `read_project_catalog` and
   `read_open_project_page`. The latter accepts only pages beneath the exact active or archived
   root recorded for that open Project.
4. The Basic Memory read guard is actually registered as a `PreToolUse` hook. It permits
   discovery of `projects/` and an opened Project directory, while continuing to deny direct
   content readers and search for ordinary reader requests.

The Project Reader must reject a response whose `file_path` is not the requested canonical path,
just as the Book Reader does. This preserves the protection added after the Library's substituted-
content failure without making Project reading a special ceremony. An archived Project is opened
and read in place; reopening a house search later is an ordinary request, not a restore workflow.

After a Project opens, the Librarian may offer a short return briefing. It reads only the opened
Project's own `Connected knowledge` and `Connected tools` sections, suggests the recorded Books a
reader might open, and names the recorded tools' roles. It does not search for dependencies,
infer missing connections, open Books, or create persistent state.

### Finding an active Project without scanning a catalog

When a reader describes work they want to resume but cannot remember the Project name, the
validated reader exposes `suggest_active_projects`. It reads the exact active Project Catalog and
the exact `_project.md` home note for each active entry, then returns at most five ranked matches.
It gives extra weight to title and slug matches, includes only a short Purpose excerpt, and reports
the matching words. This is intentionally a small active-Project lookup, not a general Library or
Notebook search.

Suggestions are read-only and do not require, create, or alter Virtual Desk state. They never open
a Project or its connected Books. The Librarian presents the result and lets the reader choose what
to open. The reader validates every catalog and Project-root response against its exact canonical
path and stops rather than silently scanning a partial catalog of more than 25 active Projects.

If a Book and a Project share a slug, their separate roots remain safe but the Librarian asks
which one the user means.

## Archiving a Project Hub

Add a bounded `Archive-ProjectHub.ps1` alongside the existing Book archiver.

1. Its read-only preflight verifies `projects/<slug>/_project.md`, confirms that
   `archive/projects/<slug>/` is unused, and shows the single proposed move.
2. After one explicit confirmation, it uses Basic Memory's native directory move from
   `projects/<slug>` to `archive/projects/<slug>`.
3. It accepts a former-path redirect only when it resolves to that exact archive destination.
4. It reads every moved Project page back at its exact archive path. It rewrites only an exact
   `[[projects/<slug>/...]]` link target in `_project.md`; it never performs a blanket replacement
   or reconstructs hand-written sibling notes.
5. It removes the entry from `projects/README.md` only after readback and adds it under an
   **Archived Projects** heading in `archive/projects/README.md`.

The helper never deletes project content, does not alter related Books, and does not touch any
external system. If a post-move check fails, it reports the possible archive location rather than
blindly retrying.

## Optional Vikunja attachment

`## Connected tools` may contain a Vikunja board URL and project ID. Nothing calls Vikunja in
this phase: no token, webhook, synchronization, task process, or board change. If it is attached
later, Vikunja remains the action source for its board and Basic Memory remains the context
source. Archiving a Project Hub never changes the board.

If integration is needed later, build it in this order:

1. Read a linked board on request and present a current snapshot alongside Project Hub context.
2. On an explicit request such as “add this to the board,” create or update one task and read it
   back.
3. Only after that proves valuable, consider a narrowly scoped event capture from Vikunja into a
   Project Hub log.

Vikunja remains the action source for its board. Basic Memory remains the context source. Project
archiving never archives, closes, or changes a Vikunja board; that is a separate human choice.

## The dev template, and where decisions live

> Added 2026-08-31 by ADR-0003. Applies to Project Hubs for development work.

`New-ProjectHub.ps1 -Dev` seeds two additional sections. Both are **optional and dev-specific** —
not part of every Project Hub's shape. Hubs created without `-Dev` are unchanged, byte for byte, and
existing Hubs are not migrated.

```markdown
## Repo

- **Working tree:** the local checkout this project's work happens in.
- **Remote:** sanitized remote URL -- no credentials or userinfo.
- **Branch:** the branch work lands on.
- **Gate:** the command that must pass before a change is done.
- **Agent guidance:** point at the working tree's own `AGENTS.md`; never copy it here.

## Decisions

- **<date> -- <what was decided>.** <where its record lives>
```

`## Repo` binds the Hub to a **working tree** — live, external, belonging to the project rather than
to the Library, and never copied or compiled from. It points at that tree's own `AGENTS.md` rather
than reproducing it, because a copy goes stale silently. The remote line carries its credentials
warning inline, where the reader is typing: a Hub is NAS-backed, and the exclusion below is easy to
forget while pasting a URL. Nothing validates what is typed, so the wording is the only guard, and
`hub.dev-template-seeds-sections` asserts it verbatim.

**A label that does not apply is deleted, not filled with `n/a`** (2026-09-06). The section names
*the working tree the work happens in and what proves a change is done*; the five git-shaped labels
are the common case, not the definition. Settled on the first subject that had no repository of its
own — `2nd-b-vault-dev`, whose `D:\2nd_b` is a working tree with a `.gitignore` and no `.git`,
replicated by Obsidian Sync across four hosts. Filled honestly there, `Remote`, `Branch` and the
`AGENTS.md` pointer are all empty: **three dead lines out of five**, on a live Hub root, which reads
as broken rather than as deliberately short and costs a reader attention on every orientation. The
alternative considered and rejected was adding non-git alternate labels to the seed — inventing
vocabulary for a case seen once, when the honest answer is that this subject simply has fewer things
worth naming. That Hub keeps `Working tree` and `Gate` and says in one sentence why the rest are
absent, so the omission reads as a decision rather than an oversight.

### The subject-follows rule

**A decision lives with its subject.** The test is about the *subject's* repository, not the
Library's:

> **Does the subject have a repository you control?**
> **Yes** — the decision goes in **that repository's** `docs/adr/`. That is this repository's
> `docs/adr/` only when the subject is the Library itself.
> **No** — it goes in the Hub's `decisions/NNNN-slug.md`, mirroring `docs/adr/` numbering and format.

Either way the Hub's `## Decisions` section carries a one-line pointer, so orientation is identical
regardless of which side the pointer resolves into. Repository storage buys version history, blame,
and code-search discoverability for decisions that belong beside code; Hub storage reaches subjects
that have no repository of their own. Neither dominates, which is why the rule picks rather than
declaring a winner.

There is a genuine ambiguous middle — a decision about how the Library *reads* an external subject
concerns something external but is implemented here. Refine the test from real use rather than
pre-specifying every case.

**How the `decisions/` page is created** (2026-09-08). `tools/Copy-LocalPagesToProject.ps1`, with
`-DestinationDirectory decisions`, from a page authored locally **first**:
`Resolve-LocalSourceRoot` permits `notebook/` and one note under a capture Book's `wiki/notes/`,
and nothing else, so a Notebook write is a step in this route rather than an afterthought. The
destination is a parameter and is **never inferred from the source folder's name** — a folder
source's default target is `notes/<sourceName>/<relative>`, so a source folder called `decisions`
would land at `notes/decisions/` and read as though it had worked. Each destination segment must be
lowercase-with-hyphens, which is what keeps the write inside `projects/<slug>/` without a blocklist
of traversals; `_project`, `connections` and `README` are refused on every route, because those
belong to `New-ProjectHub.ps1` and `Edit-ProjectHub.ps1`, which journal a previous body, hold the
`projects/<slug>` lock and verify the readback. Held by `mcp-helpers.boundary-suite`.

**First exercised 2026-09-08**, and the branch had been specified for eight days before anything
could produce it. `projects/2nd-b-vault-dev/decisions/0001..0006` carry that Hub's six standing
decisions; five were relocated out of its `Now` and the sixth came from a different subsection,
which is why the Hub had carried **six** pointers against **five** prose blocks. One paragraph was
deliberately *not* relocated: the credentials deferral is live risk state as well as a decision,
and excising it would have deleted the live half to tidy the recorded one. Record:
`projects/library-dev/notes/library-dev-history-2026-08-part-2`.

### Decisions holds operative pointers only

A pointer is **replaced or removed** when its decision is superseded or reversed. The history stays
in the ADR or `decisions/` page, which is where a decision's own record of being overturned belongs.

This rule is the whole reason the section is safe to add. A decision does not close the way a task
does, so a `Decisions` section without it accumulates forever and reproduces exactly the append-only
growth the `Now` seed exists to prevent — the defect being fixed, wearing different clothes.

Like the `Now` seed, this is carried by seed wording rather than enforcement. `Assert-NowStructure`
inspects only column-zero list entries, and a new whole-collection invariant is the shape of change
that has previously bricked a surface until legacy data was migrated. What is gated is only what the
template produces, never any Hub's content.

## Deliberate exclusions

- No automatic two-way task synchronization.
- No API tokens or credentials in Basic Memory notes, Books, the local Notebook, or repository files.
- No separate Basic Memory project per personal project.
- No recreation of Kanban, due dates, recurrence, or notifications inside Basic Memory.
- No requirement to use Vikunja, create task notes, or publish a Project as a Book.

## Implementation and acceptance

The reader and archive pieces were implemented and tested together in a disposable Basic Memory
project before touching `ai-library`. The acceptance test proved:

1. create one Project Hub, read back its exact root, add its active-Catalog line, and read that
   entry back;
2. open the Project and reject a closed Project, a traversal path, and a wrong returned path;
3. prove the registered real `PreToolUse` hook blocks direct Basic Memory content reads and search
   for ordinary reader requests, while an explicit active-Project write gets an exact readback;
4. archive the Project with the native move, exact archive readback, active-catalog removal, and
   archive-project-Catalog creation; then open and read the archived hub through the adapter;
5. leave a related Book untouched; and
6. support three ordinary requests: "start a project," "open my project," and "archive this
   project," with only the archive move requiring its one confirmation.

The implementation is in `tools/New-ProjectHub.ps1`, `tools/Archive-ProjectHub.ps1`, the existing
`tools/Set-VirtualDesk.ps1`, and the existing `Validated-BookReader.ps1` adapter. The Book-reader
self-test and the Project-reader acceptance test both passed. The Project create and archive
helpers were also exercised against multiple disposable hubs to confirm that existing active and
archived Catalog entries are preserved.

During the independent end-to-end run, an empty or single-entry Virtual Desk exposed a PowerShell
collection-unrolling defect in `Set-VirtualDesk.ps1` and `Get-VirtualDeskContext.ps1`. The four
state-reader call sites now force array semantics with `@(...)`, so empty desks, one open item, and
multiple open items all remain valid state. The focused desk regression and the containment-boundary
test passed after that correction.

## Live pilot validation

The live **Buzz Relay Deployment** Hub confirms the intended separation: deployment-specific
context lives under `projects/buzz-relay-deployment/`, while the reusable **Buzz Self-Hosting**
Book remains a separate reference. Its return briefing names only the Project's recorded Books and
tools, never opens anything automatically, and gives a returning reader a useful reminder of what
to open next.

The live Claude acceptance path passed on 2026-08-14:

1. an omitted Project-Catalog shelf resolves safely to the active catalog;
2. an opened Project returns its recorded Book and tool briefing;
3. an opened Book returns a full operational page;
4. `Clear` empties both open Books and open Projects; and
5. reads after clearing are rejected as closed.

Two small reader hardenings came from this validation. An absent Project-Catalog `arguments`
object now defaults safely to the active shelf, and `Clear` acts on the whole Virtual Desk rather
than only the default Book scope. The initial Claude failure on a non-ASCII Book page was a
PowerShell JSON-output encoding defect, not a Project or Book design issue; see
[Claude Reader Compatibility](claude-reader-compatibility.md).

The active-Project suggestion regression also passed on 2026-08-14 against an isolated desk
fixture and the live read-only Library path. It found **Buzz Relay Deployment** for “buzz relay,”
returned a clear no-match result for unrelated words, did not create the absent `.open-projects`
fixture file, and did not change the project pin or Book desk state.

## Pi-fit result

**Proceed.** The normal path is plain language and preserves a small existing mental model:
active projects are where current work lives; archived projects are still available later. The
only new state is the open-project root needed to enforce exact safe reads. The sole confirmation
protects an organizational move that removes the project from the active catalog.

## Key Takeaways

- Project Hubs are living NAS-native context; Books are optional reusable reader copies.
- Active versus archived is enough lifecycle for Projects.
- A Project return briefing is orientation only: it records relevant Books and tools without
  searching, inferring, or opening dependencies.
- Project suggestions make returning to remembered work direct while leaving the reader in control
  of what opens.
- Vikunja has a clean future slot without requiring it now.
- Guarded, exact-path reading remains non-negotiable for Projects and Books alike.
