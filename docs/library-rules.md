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
| U1 | A Hub page stays under 40000 bytes; `notes/` pages and the `limits` page are exempt. | `kernel/src/hubedit.ts`: `const PAGE_SIZE_THRESHOLD = 40000`; `kernel/src/hubedit.ts`: `function sizeExempt` | kernel warns, on any write to an oversized page | `hub edit` preflight `page_size_warning`; the `WARNING: Project Hub page` line |
| U2 | A Hub section stays under 12000 bytes; sort before you shorten. | `kernel/src/hubedit.ts`: `const SECTION_SIZE_THRESHOLD = 12000`; `kernel/src/hubedit.ts`: `Sort before you shorten (ADR-0013)`; `docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md` | kernel warns, only when the section grew | preflight `section_size_warning.oversized_sections` (the full list); the `WARNING: Section` line |
| U3 | A Hub entry stays under 1200 bytes. | `kernel/src/hubedit.ts`: `const ENTRY_SIZE_THRESHOLD = 1200` | kernel warns, only when the entry is new or grew | preflight `entry_size_warning.oversized_entries`; the `WARNING: Entry` line |
| U4 | `## Now` keeps only what the project can still close. | `docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md`: `must have a closing condition`; `kernel/src/hubedit.ts`: `requires a status marker` | prose; the kernel refuses a `## Now` entry with no `- [ ]` or `- [x]` marker | ticked `- [x]` items in `## Now`, read through the validated reader |
| U5 | The Holding Shelf is the last resort; its growth is a Library signal. | `docs/adr/0060-the-holding-shelf-is-the-last-resort-and-its-growth-is-a-library-signal.md`; `kernel/src/shelfnote.ts`: `export function growingState` | kernel reports `growing` | `library desk` `capture_books[].growing` |
| U6 | Reports are triaged, not left: a Report is a claim to verify, never a task. | `templates/workspace-instructions.md`: `A report is a claim to verify`; `docs/library-triage-design.md` | prose | `library desk` `capture_books[]` `pending_count` and `oldest_pending` |
| U7 | Closed capture notes leave `notes/` after 14 days. | `kernel/src/shelftidy.ts`: `export const DEFAULT_TIDY_DAYS = 14` | kernel verb, `shelf tidy`, run by hand | not seen: its preflight needs the Book open at this seat |
| U8 | `raw/` is ingestion staging, not storage. | `templates/workspace-instructions.md`: `ingestion staging` | prose | not seen |

## Adding or moving a row

- Add a row when a rule about keeping the Library tidy gains a home. Give it the next free id.
- When a home moves, update its path or anchor in the same commit. The kernel self-test (section 119) fails when a
  row's file is missing or its anchor no longer occurs in it.
- Keep the rule to one line. Anything longer belongs in the home.
