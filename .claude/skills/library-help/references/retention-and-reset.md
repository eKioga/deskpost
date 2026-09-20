# Retention and reset

## What reset actually does

A request to **reset** or **clear my workspace/notebook** means one bounded local action unless the
reader names another target:

1. move the Notebook topics **this seat owns** into `internal/notebook-reset-quarantine/<stamp>/`
   and rebuild `notebook/` with a fresh `_master-index.md`;
2. **only when `-ClearDesk` is passed,** clear both of **this seat's** Desk lists, which live at
   `.claude/seats/<seat>/.open-books` and `.claude/seats/<seat>/.open-projects`.

**It sets material aside rather than deleting it (ADR-0016), and the reader should be told so in
those words.** Everything it moves is journalled and recoverable — see *Getting it back* below.
"Deleted" is the wrong word and it makes readers hoard notes they do not need to.

**A topic no seat owns stops the reset.** The refusal names each one and points at
`tools/Set-NotebookTopicOwner`, which maps it to a seat or declares it `shared` or `excluded`. Pass
that on; it is the design refusing to guess at material nobody has claimed, not a fault.

By default the Desk is left alone: open Books and Project Hubs stay open, and only the Notebook is
rebuilt. Either way it is **this seat's** Desk and no other's -- a reset never reaches across seats. That is the answer to "can I clear my notes without losing what I have open?" -- yes, and it
is the default. `-ClearDesk` makes it the full Library Reset, which is what "start fresh" and "reset
my workspace" mean. Reasoning: ADR-0010.

## Clearing the whole Notebook, not just your slice of it

**`-AllIdleSeats` sweeps every seat that is idle right now** (2026-09-15, ADR-0023). "Clear my
notebook" usually means the Notebook; a seat-scoped reset leaves behind every other seat's topics,
and an unscoped search afterwards returns nothing of the reader's own. The sweep takes each foreign
topic whose owning incarnation the registry still names and whose seat holds no session now.

**Skipping is not refusing.** A seat with a live session, or a live agent whose claim holder was
lost, is **named and left** and the run carries on -- "clear every idle seat" is a request one busy
seat must not cancel. Retired incarnations are `-WholeTree`'s, and an incarnation that is neither
registered nor retired is refused outright, because nothing can say that work is finished.

```powershell
$plan = tools/Reset-LocalNotebook.ps1 -WorkspacePath . -AllIdleSeats -Preflight
tools/Reset-LocalNotebook.ps1 -WorkspacePath . -AllIdleSeats -UserConfirmed -ApprovedPlanId $plan.plan_id
```

**Show the `sweep` block before asking.** It is on every run and empty when the switch was not
passed. `sweep.to_sweep` names each topic the run would take with **whose it is** and how much of it
already exists durably -- `copy_evidence`, `page_count`, `pages_without_current_copy`, `known_books`,
`known_projects`, the same evidence the per-topic advisory carries. `sweep.skipped` names each topic
it leaves with the rule that left it and that rule's own `note`; pass the note on as it stands rather
than composing a remedy beside it. The `seat_scope` line says which of the three scopes this is, and
a sweep is the one shape that moves somebody else's material -- say so before the reader approves.

**The two switches are refused together, and the answer is to run both in sequence.** `-WholeTree`
covers this seat plus explicitly **retired** incarnations; `-AllIdleSeats` covers seats that are
merely **idle now**. Passing both selects nothing, on purpose: if they composed, the refusal that
keeps another seat's material out of a whole-tree reset would be half-silenced by a second switch.
Sweep first, whole-tree reset after, each with its own preflight and its own approval.

## "I want my Notebook empty" -- no reset delivers that on its own

**Say this before the reader approves, not after.** A topic declared `shared` or `excluded` is taken
by **no seat's reset at any scope**: it is sorted into `protected` before the scope switches are ever
consulted. So a topic can remain for four different reasons, and the reader should be told which one
applies to which topic:

| It remains because | The route, if there is one |
| --- | --- |
| another seat owns it and you ran an ordinary reset | `-AllIdleSeats`, if that seat is idle |
| its seat has a live session | wait for that session to end, then sweep again |
| its incarnation is **retired** | `-WholeTree`, as a separate approval |
| it is declared `shared` or `excluded` | **a deliberate ownership change first -- see below** |

**An `excluded` declaration may or may not be protecting anything — the preflight now says which.**
Read `predicted_remaining.protected_recoverability`: one row per protected topic, reporting whether
a completed publication journal exists for a Book of that slug. Above zero means the topic is a
published Book's source and `tools/Restore-BookSource.ps1` rebuilds it, so the declaration is
costing an empty Notebook for nothing; zero means it is the only copy and the declaration is
load-bearing. `notebook/orca-ide` was the live example of the first kind, and it was read as the
second for a day. **Ask what the declaration is protecting — then check the row rather than assume.**

**Moving a topic off `excluded` needs `tools/Set-NotebookTopicOwner.ps1`, and an agent session
cannot run it.** The Claude Code auto mode classifier refuses it as a shared-resource write even
though the project allowlist carries it, so this is one the reader runs themselves — in Claude Code,
by typing the command with a leading `!`. Say that plainly rather than reporting a Library refusal;
nothing in the Library is stopping them. Never hand-edit `internal/notebook-topic-owners.json`
instead: that bypasses the live-claim gate which stops one session reassigning another seat's topic
and then resetting it as its own.

**Read `predicted_remaining` before taking an approval.** It answers the reader's actual question in
`notebook_will_be_empty` and names every topic that survives with the rule that leaves it. Do not
add the leftover fields up by hand — they overlap the target set, so the sum over-reports what
survives. `topics_unmapped` is not a leftover at all; it is a refusal that stops the run.
`remaining_in_notebook` answers it exactly, and it is post-run only.

**One sweep makes one quarantine across several seats' topics, and its journal is the only record of
whose each topic was.** The ownership rows stay behind pointing at their seats, but a purge takes
them and the quarantined material carries no owner of its own. So the journal records
`all_idle_seats` beside `whole_tree` and one `{topic, seat, seat_id}` row per topic -- reported by
`-List` as `all_idle_seats` and by `-Quarantine <name> -Show` as `recorded_owners`. That is what
answers "can this go back to the seat it came from?", and a quarantine whose journal is missing is
still restorable and belongs to nobody the Library can name.

It preserves `docs/`, `raw/`, `output/`, `internal/`, `shelf/`, all other `.claude/` configuration,
tools, root rules, and every shared-Library record. It never performs a triage or any shared write.

**Triage the Notebook first.** Triage is the sweep that makes a reset safe, and it is a tidying verb
that reads as optional — so offer it before the Reset, and say plainly that `notebook/` is what
gets swept. It is recoverable, but quarantine is a holding pen rather than a destination anyone
chose; triage is how material ends up somewhere it belongs. The Holding Shelf is not touched.

```powershell
$plan = tools/Reset-LocalNotebook.ps1 -WorkspacePath . -Preflight
tools/Reset-LocalNotebook.ps1 -WorkspacePath . -UserConfirmed -ApprovedPlanId $plan.plan_id
```

The `plan_id` binds the seat, both scope switches, the exact topics with their owners, and the loose
files under `notebook/` — so an approval can only execute the reset the reader was actually shown. A
session that holds no live claim is refused at the **preflight**, before a plan it could not run is
issued. If the confirmed run refuses the `plan_id`, the Notebook changed: rerun the preflight, say
what changed, and ask again.

Show the preflight's `notebook/` target, item count, `loose_files_to_quarantine`, open-Book and
open-Project advisory, and the
journal-based Library-copy advisory. That advisory also reports the Holding Shelf counts under
`holding_survives_this_reset` — material that is already safe, which is the reassuring half a reader
needs alongside the count of what is about to go. Say plainly that the advisory reads local journals
only: it does not verify NAS state and cannot protect excluded or uncertain material. Ask once, then
run the confirmed command.

There is deliberately no local Notebook-archive folder. The quarantine is not one: it is where a
reset puts material it has already moved, not a place to file things on purpose.

**"How do I delete this note?" -- you do not; the Reset is the only route out of `notebook/`, and it
takes a whole topic.** There is no route to remove a single article, and that is a decision rather
than a gap (2026-09-15, ADR-0024): removal from the Notebook has no destination. Deleting is refused
outright; the quarantine is a recovery route rather than somewhere to file things; and a local
archive is the thing the Library declines to build. Triage is the answer to "I want this somewhere
better" -- it **graduates** a page to a Book or a Project Hub, and the Notebook copy's departure is
the Reset's to own. And the Reset has no topic filter either -- it takes every topic the seat owns,
which is why "reset when you are done with this batch" is the shape the Library is built around
rather than deleting notes one at a time. Leaving an unwanted article where it is until then is a
supported answer, not a workaround.

## Getting it back

Three routes, added 2026-09-10, for material a reset or a retirement set aside. **Start with the
read, which needs no seat** — a reader whose session lost its seat is exactly the reader asking
what survived.

```powershell
tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List   # every quarantine, its seat, its topics
tools/Remove-SeatArchive.ps1 -List                            # retired seats' archived Desks
```

| You want | Route | Afterwards |
| --- | --- | --- |
| Put quarantined topics back | `tools/Restore-NotebookQuarantine.ps1 -Quarantine <name>` | additive |
| Put a retired seat's Desk back | `tools/Start-LibrarySeat.ps1 -Seat <name> -RestoreDeskFromArchive <archive>` | additive |
| Destroy a quarantine | `tools/Remove-NotebookQuarantine.ps1` | **not recoverable** |
| Destroy a retirement record | `tools/Remove-SeatArchive.ps1` | **not recoverable** |

A restore never writes over a topic that exists in `notebook/` again — that is newer material, and
the quarantined copy is left for the reader to merge. Each topic carries an ownership disposition
in the plan (`keep`, `record` or `adopt`); show it, because the reader is approving that too.

Both destructive routes need the full procedure and its warnings: read *Recover from a reset or a
retirement* in [Librarian Operation Playbooks](../../../../docs/librarian-operation-playbooks.md)
before quoting either. Purging a seat archive usually **refuses**, on purpose — deleting a
retirement record un-retires the incarnation it names and strands that seat's Notebook topics
permanently.

## Five ways to keep material before resetting

| Destination | Use it for | Tool |
| --- | --- | --- |
| Holding Shelf | a finding not yet sorted; fastest, no confirmation | `tools/Add-ShelfNote.ps1` |
| a new local Shelf Book | a coherent set of notes worth keeping as a Book, locally | `tools/Publish-BookCopy.ps1 -Destination Shelf` |
| an existing Shelf Book | one page that belongs in a Book you already have; open it first | `tools/Add-ShelfBookPage.ps1` |
| shared Library copy | material other machines and sessions should have | `tools/Publish-BookCopy.ps1 -Destination Shared` |
| active Project Hub | context belonging to ongoing work | `tools/Copy-LocalPagesToProject.ps1` |
| a named path in a Hub | a decision record, not narrative | the same, `-DestinationDirectory decisions` |

When the reader asks what reset would remove or what is already copied, start with:

```powershell
tools/Get-LibraryTriageInventory.ps1 -WorkspacePath .
```

It reports both local buffers and never sums them: the Notebook counters answer *what a reset
moves into quarantine*, and the `holding_*` counters are what stays where it is. It is local journal evidence,
not a NAS scan or an automatic classifier, and it returns a report even when a source is missing --
a workspace just after a Reset is a populated Holding Shelf and no Notebook. Use it and the reader's
stated purpose to suggest one small destination. Do not silently split notes, invent a category, or
create a duplicate Book because a match is uncertain.

For an approved multi-destination triage, preflight with
`tools/Invoke-LibraryTriage.ps1 -ActionJson <json> -Preflight`, show the pages, destinations, write
sets, anything in a `delete_set`, and the `plan_id`, then rerun with `-UserConfirmed -ApprovedPlanId
<that exact plan_id>`. Offer triage before a reset; never chain one into the reset confirmation
itself.

## Source material under `raw/`

`raw/` holds converted and imported source material -- whole repository checkouts, exported wikis,
and a deliberately retained copy of the Library's own **retired** instructions. It is not a Book, has
no Desk, and nothing in it is current policy.

Two separate questions, and two helpers:

```powershell
tools/Search-RawBatch.ps1 -List                                  # what source batches exist
tools/Search-RawBatch.ps1 -Batch '<batch>' -Query '<term>'       # search ONE named batch
tools/Set-RawBatchOwner.ps1 -Action Report                       # who owns each batch, and is that Project still live
tools/Set-RawBatchOwner.ps1 -Action Set -Batch '<batch>' -Project <project-slug>
tools/Set-RawBatchOwner.ps1 -Action Remove -Batch '<batch>'
```

**Ownership is declared, never inferred.** `raw/` does not follow the documented
`raw/<project-slug>/<source-batch>/` shape -- most batches are repository checkouts whose names are
not Project slugs -- so a directory name is not evidence of who owns it. A batch nobody has declared
is reported as **unmapped**, and that is a report rather than a gap to be filled by guessing. A
mapping covers its whole subtree, and the longest declared prefix wins.

**Liveness is derived on every read, never stored.** A record holds a Project slug and nothing else,
so archiving a Project cannot leave a stale copy of its status behind. Each read joins the slug
against the active and archived Project Catalogs and reports `active`, `archived`, `unlisted`, or
`undetermined` -- the last meaning the Catalogs could not be read, which is never reported as though
it were an answer. `-Offline` skips the Catalog read and says so.

**Eviction is offered and never performed.** A batch whose owning Project is archived is named as a
candidate with its evidence; deleting it is yours to do. Nothing in these helpers deletes, moves, or
modifies anything under `raw/`.

## Publishing and archiving

Publishing a shared Book copy, refreshing one, importing an external wiki to the Shelf, and
archiving a Book or Project all follow the same shape: **preflight, show the manifest and `plan_id`,
one clear approval, rerun with `-UserConfirmed -ApprovedPlanId`**. The full sequences are in
[docs/librarian-operation-playbooks.md](../../../../docs/librarian-operation-playbooks.md) — read the
applicable section immediately before the action.

Archiving lives in `tools/Archive-SharedBook.ps1` and `tools/Archive-ProjectHub.ps1`. Duplicate
topics across the Shelf are found read-only with `tools/Find-ShelfDuplicateTopics.ps1`; a high score
is a lead, not a verdict.

## The rule underneath all of it

Nothing consequential happens without the named bounded helper, its preflight where one exists, and
the approval that helper specifies. Never improvise a workspace-wide reset, a shared-Library
deletion, or a local Notebook archive. A blocked or failed action is never reported as a success.
