# Library Rules Register

A register of the Library's upkeep rules: **pointers, not a second copy**. Each row names a rule in one line,
where the rule lives (its home), and what enforces it. The rule's wording, its reasons and its exceptions stay in
its home; when a row and its home disagree, the home governs and the row is corrected.

It exists because upkeep rules are spread over the kernel, the ADRs and the workspace instructions, and a client
that helps keep a Library tidy (a person, a model following `CLAUDE.md` or `AGENTS.md`, or a Claude Code mod) needs
to find them without restating them. Eric's request, 2026-10-03: "perhaps all of the library rules could be
codified in some kind of way". The first client is deskpost-mods' upkeep feature, Eric's own Claude Code mod
outside this repository; Deskpost behaves the same without it.

## How to read a row

- **id:** stable; never reused for another rule.
- **home:** one or more `` `path` `` entries relative to the repository root, each optionally followed by
  `` : `anchor` ``, a piece of text that must occur in that file. Anchors stand in for line numbers, which move with
  every edit above them.
- **enforcer:** `kernel refuses`, `kernel warns` or `kernel reports` when the program acts on the rule; `kernel verb`
  when a command carries it out but only when run; `prose` when only the instructions state it.
- **seen by:** what a client can observe of the rule without reading the Library's files: kernel output, or the
  Desk's JSON. "Not seen" means a client cannot observe it today.

## The register

| id | rule | home | enforcer | seen by |
| --- | --- | --- | --- | --- |
| U1 | A Hub page's limit follows how often it is read: `_project` and `connections` at the Hub root (every-session) stay under 40000 bytes, every other page (on-demand) under 56000; `notes/` pages and the `limits` page are exempt. | `kernel/src/hubedit.ts`: `PAGE_SIZE_LIMITS`; `kernel/src/hubedit.ts`: `function pageKind`; `kernel/src/hubedit.ts`: `function sizeExempt` | kernel warns, on any write to an oversized page | `hub edit` preflight `page_size_warning` (`kind`, `threshold_bytes`); the `WARNING: Project Hub page` line; `library desk` `hub_pages[]` |
| U2 | A Hub section stays under 12000 bytes; sort before you shorten. | `kernel/src/hubedit.ts`: `const SECTION_SIZE_THRESHOLD = 12000`; `kernel/src/hubedit.ts`: `Sort before you shorten (ADR-0013)`; `docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md` | kernel warns, only when the section grew | preflight `section_size_warning.oversized_sections` (the full list); the `WARNING: Section` line |
| U3 | A Hub entry stays under 1200 bytes. | `kernel/src/hubedit.ts`: `const ENTRY_SIZE_THRESHOLD = 1200` | kernel warns, only when the entry is new or grew | preflight `entry_size_warning.oversized_entries`; the `WARNING: Entry` line |
| U4 | `## Now` keeps only what the project can still close. | `docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md`: `must have a closing condition`; `kernel/src/hubedit.ts`: `requires a status marker` | prose; the kernel refuses a `## Now` entry with no `- [ ]` or `- [x]` marker; `hub tidy` moves ticked items out | `library desk` `hub_pages[]` `ticked_now` and `ticked_next` for `_project` |
| U5 | The Holding Shelf is the last resort; its growth is a Library signal. | `docs/adr/0060-the-holding-shelf-is-the-last-resort-and-its-growth-is-a-library-signal.md`; `kernel/src/shelfnote.ts`: `export function growingState` | kernel reports `growing` | `library desk` `capture_books[].growing` |
| U6 | Reports are triaged, not left: a Report is a claim to verify, never a task. | `templates/workspace-instructions.md`: `A report is a claim to verify`; `docs/library-triage-design.md` | prose | `library desk` `capture_books[]` `pending_count` and `oldest_pending` |
| U7 | Closed capture notes leave `notes/` after 14 days. | `kernel/src/shelftidy.ts`: `export const DEFAULT_TIDY_DAYS = 14` | kernel verb, `shelf tidy`, run by hand | not seen: its preflight needs the Book open at this seat |
| U8 | `raw/` is ingestion staging, not storage. | `templates/workspace-instructions.md`: `ingestion staging` | prose | not seen |
| U9 | Reports, letters and Hubs never carry a secret: name the 1Password item, never its value. | `.claude/skills/library-help/references/letters-and-departments.md`: `Reports, letters and Hubs never carry a secret`; `templates/seats/orchestrator.json`: `Reports, letters and Hubs never carry a secret` | prose (the role text and triage carry it) | not seen |

## Document claims

Each D row ties a document claim to its words and the code it describes; the docs gate checks every path and anchor.

| id | claim | document | code |
| --- | --- | --- | --- |
| D1 | Removing a page or the sources always needs the reader's yes. | `.claude/skills/library-help/references/books-and-projects.md`: `Removing a page or the sources,` | `kernel/src/sharedwrite.ts`: `const planOnly = upkeepable(action, parsed)`; `kernel/src/sharedwrite.ts`: `(action === 'sources' && !parsed.flags.has('remove'))`; `kernel/src/sharedwrite.ts`: `if (!planOnly && parsed.flags.has('preflight') === parsed.flags.has('user-confirmed')) refuse` |
| D2 | Launch access values and flag tables live in their named source files. | `docs/releasing.md`: `values with the launch access definitions:` | `kernel/src/menuaccess.ts`: `export const LAUNCH_ACCESS_VALUES`; `kernel/src/seatlaunch.ts`: `export const LAUNCH_FLAG_TABLE` |
| D3 | Named sections run through the parallel runner. | `docs/dev-session-loop.md`: `To run named sections from` | `kernel/test/run-parallel.ts`: `export function sectionNumbers(text: string, selection = process.env['LIBRARY_SELFTEST_SECTIONS']`; `kernel/test/lanes/guards-and-tooling.covers.json`: `"sections"`; `kernel/test/section-covers.json`: `"sections"` |
| D4 | The queued lander updates and merges pull requests one at a time. | `docs/dev-session-loop.md`: `The queued lander updates each pull request,`; `docs/dev-session-loop.md`: `checks and merges one pull request at a time, oldest first.` | `tools/lander.mts`: `One pass: read every open pull request to master and act on the head of the queue.`; `tools/lander.mts`: `/update?style=rebase`; `tools/lander.mts`: `/pulls/${n}/merge` |
| D5 | The installer copies reader MCP permissions, without adding shell-writer rules. | `.claude/skills/library-help/SKILL.md`: `it adds no shell-writer allow rules` | `kernel/src/init.ts`: `.filter((entry) => entry.startsWith('mcp__validated-book-reader__'))` |
| D6 | Closeout and checkpoint count the program's recorded writes for this conversation. | `.claude/skills/library-help/SKILL.md`: `The closeout and checkpoint count every write the program records for this conversation.` | `kernel/src/checkpoint.ts`: `export function startWriteLedger(argv: string[]): LedgerRun`; `kernel/src/checkpoint.ts`: `export function finishWriteLedger(run: LedgerRun`; `kernel/src/checkpoint.ts`: `export function checkpointLedger(state: CheckpointState, workspace: string)` |
| D7 | Shared Book writes can use a standing upkeep grant. | `.claude/skills/library-help/SKILL.md`: `A local Library with a Basic Memory connection writes to a shared Book through` | `kernel/src/sharedwrite.ts`: `const grant = upkeepable(action, parsed) && !catalogRemoval && !confirmed ? await upkeepGrant(opened) : null`; `kernel/src/sharedwrite.ts`: `confirmation_required: grant === null,` |

## Adding or moving a row

- Add a row when a rule about keeping the Library tidy gains a home. Give it the next free id.
- When a home moves, update its path or anchor in the same commit. The kernel self-test (section 119) fails when a
  row's file is missing or its anchor no longer occurs in it.
- Keep the rule to one line. Anything longer belongs in the home.
