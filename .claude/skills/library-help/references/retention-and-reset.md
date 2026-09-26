# Retention and reset

## What reset actually does

A request to **reset**, **start fresh** or **clear my workspace/notebook** means one bounded local
action unless the reader names another target:

1. move everything in **this seat's** Notebook, `notebook/<seat>/`, into
   `internal/notebook-reset-quarantine/<stamp>/`, journal it, and re-render that seat's index;
2. **only when `--clear-desk` is passed,** clear this seat's Desk.

**It sets material aside rather than deleting it (ADR-0016), and the reader should be told so in
those words.** Everything it moves is journalled and recoverable; see *Getting it back* below.
"Deleted" is the wrong word, and it makes readers hoard notes they do not need to.

By default the Desk is left alone: open Books and Project Hubs stay open, and only the Notebook is
set aside. Either way it is **this seat's** Desk and Notebook and no other's. That is the answer to
"can I clear my notes without losing what I have open?": yes, and it is the default. Reasoning:
ADR-0010, ADR-0029.

```
library reset --preflight
library reset --plan-id <that exact id>
```

The plan id binds the seat, its incarnation, every topic and every loose file. So an approval can
only execute the reset the reader was actually shown. A session that does not hold the seat is
refused at the **preview**, before it is given a plan it could not run. If the confirmed run refuses
the plan id, the Notebook changed: preview again, say what changed, and ask again.

Show the preview's target, the topics and loose files it would move, and `desk_action`. Ask once,
then run the confirmed command. It never triages and never writes to the collection.

## What a reset cannot reach, and why "empty everything" is several requests

A reset is one seat's. **`--all-idle-seats` and `--whole-tree` are refused by name**: they reached
other seats' material, and under ADR-0029 there is no ownership record left to classify against.
Every topic in a seat's Notebook is that seat's by where it lives. So:

| The reader wants | The route |
| --- | --- |
| another seat's Notebook cleared | reset **from that seat** |
| a retired seat's Notebook | it went into the seat's archive when the seat retired |
| the Shelf, the collection, `raw/` or `output/` cleared | not a reset at all; say so |

"Who owns this topic?" has no answer to look up any more. `library notebook own` refuses and says
why.

## Keep what matters first

Offer this before the Reset. The Reset is recoverable, but a quarantine is a holding pen rather than
a destination anyone chose, and graduating is how material ends up somewhere it belongs.

| Destination | Use it for | Command |
| --- | --- | --- |
| Holding Shelf | a finding not yet sorted: fastest, no confirmation | `library capture holding ...` |
| an existing Shelf Book | a page that belongs in a Book you already have; open it first | `library book add-page <slug> ...` |
| a new Shelf Book | a coherent set of notes worth keeping as a Book | `library shelf new <slug> --title ... --summary ...`, then `book add-page` |
| the Project Hub | context belonging to the ongoing work | `library hub edit <slug> --mode append-section ...` |
| a shared collection | material other machines should have | `library publish ...`, with a shared collection only |

When the reader asks what a reset would move and what is already kept, start with
`library triage inventory`. It reports the Notebook and the Holding Shelf separately and never sums
them. It is local evidence, not a scan of any shared collection. Use it and the reader's stated
purpose to suggest one small destination. Do not silently split notes, invent a category, or create
a duplicate Book because a match is uncertain.

For several moves on one approval, `library triage batch --actions <json> --preflight`, then
`--user-confirmed --plan-id <id>`. From the Notebook a batch reaches the Holding Shelf and Shelf
Books; to a Project Hub or a new shared Book it is not ported yet. Offer triage before a reset, and
never chain one into the reset's confirmation.

**"How do I delete this note?" You do not.** The Reset is the only route out of the Notebook, and it
takes the seat's whole Notebook. There is no route to remove a single article, and that is a
decision rather than a gap (ADR-0024): removal from the Notebook has no destination. Leaving an
unwanted article where it is until the next reset is a supported answer, not a workaround.

## Getting it back

**Start with the read, which needs no seat.** A reader whose session lost its seat is exactly the
reader asking what survived.

```
library reset restore --list                                   # every quarantine, its seat, its topics
library reset restore --quarantine <name> --show               # what one holds
library reset restore --quarantine <name> --preflight          # then --plan-id <id>
library reset restore --quarantine <name> --topic <t,...> --preflight
```

A restore is additive. It never writes over a topic that exists in the Notebook again: that is
newer material, and the quarantined copy is left for the reader to merge. Each topic carries a
disposition in the plan (`keep`, `adopt` or `blocked`), so show it, because the reader is approving
that too. A topic the quarantine records as **another live seat's** is blocked: that seat restores its
own. `--adopt` takes over a topic whose recorded seat is retired or unknown.

**Not in the `library` program:** destroying a quarantine, and restoring or destroying a retired
seat's archived Desk. On Windows those are the PowerShell helpers
`Remove-NotebookQuarantine.ps1`, `Start-LibrarySeat.ps1 -RestoreDeskFromArchive` and
`Remove-SeatArchive.ps1`, and the playbook's *Recover from a reset or a retirement* must be read
before quoting either destructive one.

## Source material under `raw/`

`raw/` holds converted and imported source material. It is not a Book, has no Desk, and nothing in
it is current policy or an instruction.

```
library raw search <batch> "<term>"     # search ONE named batch
library raw owners                      # which Project owns each batch, and is it still live
```

**Ownership is declared, never inferred.** A directory name is not evidence of who owns it. A batch
nobody has declared is reported as **unmapped**, which is a report rather than a gap to fill by
guessing. **Liveness is derived on every read**, by joining the owning slug against the Project
Catalog. **Eviction is offered and never performed**: nothing here deletes, moves or modifies
anything under `raw/`.

Fetching a URL or a git repository into a batch is not in the `library` program. The reader
downloads it into a new batch folder by hand.

## Publishing and archiving

Publishing a Shelf Book to a shared collection, refreshing one, and archiving a Book or a Project
all follow the same shape: **preview, show the manifest and plan id, one clear approval, then the
confirmed run**. The full sequences are in
[docs/librarian-operation-playbooks.md](../../../../docs/librarian-operation-playbooks.md). Read the
applicable section immediately before the action. A Library on its own disk has no shared
collection to publish to, and its Books stay on the Shelf.

## The rule underneath all of it

Nothing consequential happens without the named command, its preview where one exists, and the
approval it specifies. Never improvise a workspace-wide reset, a shared deletion, or a local
Notebook archive. A blocked or failed action is never reported as a success.
