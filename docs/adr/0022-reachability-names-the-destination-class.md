# A reachability report names the destination class, and only a current copy is proof

The Notebook drain plan's per-topic reachability report answers one question at a reset preflight:
*for each topic about to be quarantined, how much of it already exists somewhere the reset cannot
reach?* `Get-LibraryTriageInventory.ps1` already computes the evidence per page, hash-bound against
the local publication journals, and it keeps `known_books` and `known_projects` as two separate
lists. The open question — D3 in `PLAN-notebook-drain.md` — was whether the per-topic roll-up merges
them.

**The ruling has two halves.** The safety verdict is the **union**: a page with a current copy record
in *either* class exists outside `notebook/` and a reset does not endanger it. The report nonetheless
**names the two classes separately and never merges them into one count**, because they differ in
what the reader does next, not in whether the material survives. And **only `known-current-copy` is
proof** — the other three copy states are reported under their own names and none of them counts
toward reachability.

## The measurement that decided the first half

Run against the live Notebook on 2026-09-15 — four topics holding 54 pages, plus the excluded
master index. A dated observation, not a figure to trust later; re-read it from the helper.

| Topic | Pages | With a current Book copy | With a current Project Hub copy |
| --- | --- | --- | --- |
| `home-assistant-admin` | 27 | 27 | 0 |
| `orca-ide` | 14 | 13 | 0 |
| `2nd-b-vault-dev` | 11 | **0** | **10** |
| `basic-memory` | 2 | 0 | 1 |

A Books-only report would tell the reader that all 11 pages of `2nd-b-vault-dev` exist only in the
Notebook. Ten of them are copied into the `2nd-b-vault-dev` Project Hub, with the journal binding
each page's exact bytes. That is not a conservative error to be waved through as "erring safe": it is
an alarm on the one topic where the copy coverage is strongest outside `home-assistant-admin`, and
the reader's response to it is to re-triage eleven pages that are already durably copied. An advisory
that cries wolf on its largest number is an advisory nobody reads.

## Why the union is the safety verdict

Both classes live in the same place and a reset reaches neither. CONTEXT.md defines the **shared
collection** as *"the NAS-backed collection of Books and Project Hubs. Never stored on this disk"*,
and the reset touches `notebook/` only. Retiring either is a move rather than a deletion —
`Archive-SharedBook.ps1` to `archive/<slug>/` and `Archive-ProjectHub.ps1` to
`archive/projects/<slug>/`, each reporting `source_tree_removed` — and
[ADR-0012](0012-archived-books-are-covered-by-search-and-labelled.md) keeps archived Books covered by
search and labelled rather than retired from it. Nothing in this repository makes a Hub copy less
durable against a reset than a Book copy, and the report must not imply otherwise.

## Why the classes are still named separately

**The route differs, and a merged count names none of it.** A reader acting on the report opens the
destination, and the two are opened and read by different commands: `Set-VirtualDesk.ps1 -Kind Book`
against `-Kind Project`, then `read_open_book_page` against `read_open_project_page`. "10 of 11
copied" cannot be acted on by a reader who was not told which kind of thing to open.

**The character differs, and it is the reader's actual question.** CONTEXT.md calls a Book *"a
self-contained, portable package of reusable knowledge"* and a Project Hub *"living,
outcome-specific context for one bounded effort … it orients current work"*. A reader deciding
whether a topic has earned a Book is not answered by "it is in a Hub" — that restates the question.
Both are safe from the reset; only one of them is the destination the reader may still be aiming at.

**The evidence layer already keeps them apart.** `Resolve-CopyRecords` in
`Get-LibraryTriageInventory.ps1` returns `known_books` and `known_projects` as two lists from one
pass over the journals, and `Get-JournalEntries` derives `destination_type` before anything else.
Merging at the roll-up would discard, one layer up, a distinction the layer that reads the journals
deliberately preserves — and the same rows feed the cross-seat sweep's preflight (the drain plan's
completion criterion 2), so this shape is what a sweep over every idle seat will show.

## Why only a current copy is proof

`copy_status` has four values and exactly one of them binds this page's bytes to a destination:

- **`known-current-copy`** — a `complete` journal record whose `source_sha256` equals the page's hash
  today. This is the only proof.
- **`known-copy-drifted`** — a complete record whose hash is *different*. Something reached the
  destination; it is not what is in `notebook/` now.
- **`legacy-copy-record`** — binds nothing. `Get-JournalEntries` synthesises it from a journal's
  `attempted_records` with `source_sha256 = ''`, and only for Book destinations. Counting it would
  report material as safe on the strength of a record that names a path and no content.
- **`no-known-copy-record`** — no record at all.

So each topic row carries the four counts under the names the whole-Notebook advisory already uses,
plus `pages_without_current_copy` — the number the reader acts on. Deriving it in the report rather
than leaving the reader to add three of four counts is what keeps this ruling from living only in
prose: a reader who sees `legacy_copy_record_count: 3` and no such field will read those three as
safe, which is the exact misreading this half exists to prevent.

## Status

accepted — 2026-09-15. Settles **D3** in `PLAN-notebook-drain.md`, which row 4 of that plan's session
ledger was scoped to decide before writing the report. This is a decision about what a report may
claim, so it is recorded here rather than as a `limits` row —
[ADR-0013](0013-a-hub-section-holds-only-what-the-project-can-close.md) reserves that page for what
is unproven, and nothing here is waiting on an event.

## Considered options

**One merged "copied" count per topic.** Accurate about survival and useless for acting on. It names
no route, and it answers the graduation question with the question. Rejected.

**Books only — treat a Book as the only durable destination.** This is the tempting reading, because
the Library's own vocabulary makes a Book the durable unit and a Project Hub the transient one.
Rejected on the measurement above: it is false about 10 live pages today, and the premise is wrong
anyway — a Hub is bounded in *purpose*, not in storage, and lives on the same NAS.

**A single `safe` / `at risk` verdict per topic.** Rejected. A topic is rarely uniform — `orca-ide` is
13 of 14 — and one word would hide both drift and the empty-hash legacy record behind a reassurance.

**Building the grouping in `Reset-LocalNotebook.ps1`.** Rejected: a second reader of the publication
journals is the drift class this codebase keeps paying for, and `Resolve-CopyRecords` was written as
one function for exactly that reason. The roll-up belongs beside the evidence it rolls up, where the
sweep preflight can read the same rows.

## Consequences

`Get-LibraryTriageInventory.ps1` gains a `topics` array, one row per Notebook topic, grouped from the
`pages` it already emits. `Reset-LocalNotebook.ps1` carries it on `library_copy_advisory`, so the
per-topic rows appear wherever the whole-Notebook counts already do.

**`notebook/_master-index.md` is excluded from the rows.** It is rendered from the topics rather than
written, holds no original material, and the reset does not move it —
`Get-ResetLooseFiles` excludes it by exact name for the same reason.

**Every other loose file under `notebook/` is kept, under an empty `topic`.** A loose file belongs to
no topic but a reset *does* quarantine it, and a report about what a reset would take must not drop
the one class of file that has no topic to hide behind. The rows' page counts therefore sum to
`page_count` minus the one excluded index, and that total is asserted from outside the grouping in
the self-test — a filter that quietly drops an item from both the numerator and the denominator makes
a partial answer read as a complete one.

The four counter names (`known_current_copy_count`, `known_copy_drifted_count`,
`legacy_copy_record_count`, `no_known_copy_record_count`) mean the same thing per topic as they do
for the whole Notebook. That is deliberate: the helper's existing comment warns that a counter which
quietly changed what it counts is worse than one that disappeared, and two scopes of the same name
must not be two definitions.
