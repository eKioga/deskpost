# Notebook and Desk Model

> **Status:** implemented and acceptance-tested 2026-08-14. The reset boundary and the Desk have
> both been revised since: the Desk became per-seat on 2026-09-07 (ADR-0015), the reset became
> seat-scoped and recoverable the same day (ADR-0016), and the Desk clear became opt-in on
> 2026-09-03 (ADR-0010). Those sections carry the current behaviour; the acceptance evidence below
> is the original run and is left as written.

## Decision

The Library has two distinct local knowledge surfaces:

```text
notebook/  volatile working knowledge for the current research or project
docs/      durable Library behavior, harness documentation, and design decisions
output/    user-facing reports, files, drafts, exports, and query results
internal/  application-managed journals, plans, and historical acceptance evidence
```

`raw/` remains source material. `output/` is reserved for user-facing generated material; it is not
a store for application state. The `.claude/` directory, root operating rules, tools, and
`internal/` are persistent harness configuration. They are not working notes.

This mirrors the useful separation in the AI Library Pi port: a reader's Notebook and Desk are
available session knowledge, while the front desk's operating logic remains intact across topics.

## Reset boundary

In the Library, **reset** and **clear my workspace/notebook** mean one bounded local action:

1. move the Notebook topics **this seat owns** into
   `internal/notebook-reset-quarantine/<stamp>/`, journal the moves, and rebuild `notebook/` with a
   fresh `_master-index.md`;
2. **with `-ClearDesk` only,** clear both of **this seat's** Desk lists, at
   `.claude/seats/<seat>/.open-books` and `.claude/seats/<seat>/.open-projects` — never another
   seat's (ADR-0015, ADR-0016); and
3. preserve `docs/`, `raw/`, `output/`, all other `.claude/` configuration, tools, root rules, and
   every shared-Library record. `internal/` is preserved too, and is additionally where the
   quarantine is written.

**It quarantines rather than deletes (ADR-0016).** Nothing a reset moves is destroyed:
`tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List` names every quarantine with the seat
that made it and what it holds — a **read** that needs no seat, because a reader whose session lost
its seat is exactly the reader asking what survived. Restoring and purging are both in
[Librarian Operation Playbooks](librarian-operation-playbooks.md), *Recover from a reset or a
retirement*. Say "set aside", not "deleted"; the difference is the whole point of the design.

**It is scoped to the seat that runs it (ADR-0016).** It takes the topics this seat owns and never
reaches another seat's Desk or material. `-WholeTree` widens it to include seats that have been
**provably retired** — an archive record naming the incarnation, not merely a missing directory —
and hard-refuses every other seat, claimed or dormant.

**A topic nobody owns stops it.** The refusal names each one and points at
`tools/Set-NotebookTopicOwner`, which maps it to a seat or declares it `shared` or `excluded`. A
reset will not guess at material nobody has claimed, and that refusal is the design working rather
than a fault to route around.

**And `excluded` has to be earned**
([ADR-0025](adr/0025-a-protected-topic-states-whether-it-can-be-rebuilt.md), enforced 2026-09-18).
The helper refuses that scope on a topic whose every page is a hash-bound current copy of a published
Book, because `tools/Restore-BookSource.ps1` rebuilds that source from the Book — the declaration
would put a reproducible topic outside every reset at every scope for nothing. It is allowed whenever
the topic holds what the Book does not: a **drifted** page, a legacy-only record, or a page never
published. `-AcceptReproducible` takes the declaration over the evidence and says so in the result.

**The Desk clear is opt-in as of 2026-09-03 (ADR-0010).** By default the reset rebuilds the Notebook
and leaves every open Book and Project Hub open, because that is the far more common request and
because the Desk clear is already reachable on its own through
`Set-VirtualDesk.ps1 -Action Clear`. The two operations are therefore:

| Reader's wording | Command | Desk |
| --- | --- | --- |
| "reset my notebook", "clear my notes" | `Reset-LocalNotebook.ps1 -UserConfirmed` | preserved |
| "reset my workspace", "start fresh" | `Reset-LocalNotebook.ps1 -ClearDesk -UserConfirmed` | cleared |

Preferring the preserving default is a judgement about which mistake is recoverable: a Desk left
open is visible in `Get-DeskOverview.ps1` and undone by one command, while a Desk cleared destroys
the only record of what the reader had open.

The Librarian must first run `Reset-LocalNotebook.ps1 -Preflight`, show the exact Notebook target,
the item count, the topics it would quarantine with their owners, `loose_files_to_quarantine`, the
open-Book/open-Project advisory, and the local-journal copy advisory, then request one clear
confirmation. Reset never performs a triage or any shared write.

**The confirmed run needs the preflight's exact `plan_id`** (2026-09-09). `-UserConfirmed` alone
approved "a reset" and the run then recomputed its own selection, so a topic added or remapped after
the preview was included in silence:

```powershell
tools/Reset-LocalNotebook.ps1 -WorkspacePath . -UserConfirmed -ApprovedPlanId <that exact id>
```

A refused `plan_id` means something changed since the preview and nothing was moved. Rerun the
preflight and ask again rather than fetching a fresh id.

`Get-LibraryTriageInventory.ps1` reads the current Notebook, the local capture Books, and internal copy journals only. It
recognizes completed Book and Project manifests, and normalizes historical journal source labels
beginning with `wiki/` to `notebook/`; the historical records remain unchanged.

The reset result reports both `shared_library_write: false` and `basic_memory_write: false` after a
confirmed reset. The former is the standard helper field; the latter remains for compatibility.

### What the preflight says about material that already exists elsewhere

**Reader benefit.** The Library-copy advisory answered only at whole-Notebook scale — *so many pages,
so many with a current copy record* — and that is the wrong grain for the decision being made. A reset takes
**topics**, and a reader deciding whether to triage first needs to know *which* topic is the exposed
one; an aggregate that is 94% reassuring says nothing about the topic that is 0%. The advisory now
carries `topics`, one row per Notebook topic: its page count, the four copy states, the derived
`pages_without_current_copy`, and the Books and Project Hubs its pages have actually reached.

**Books and Project Hubs are named separately and never merged into one count**
([ADR-0022](adr/0022-reachability-names-the-destination-class.md)). Both live in the shared
collection and a reset reaches neither, so the *safety* verdict is the union of the two. What differs
is what the reader does next: the two are opened with `Set-VirtualDesk.ps1 -Kind Book` against
`-Kind Project` and read with `read_open_book_page` against `read_open_project_page`, so a merged
count names no route. Measured on 2026-09-15, a Books-only reading would have reported all 11 pages
of `2nd-b-vault-dev` as existing only in the Notebook while 10 of them were hash-bound copies in a
Project Hub.

**Only `known-current-copy` counts as proof**, which is why each row carries
`pages_without_current_copy` rather than leaving the reader to add up the other three.
`known-copy-drifted` means a *different* version reached the destination, and `legacy-copy-record` is
synthesised from a journal's `attempted_records` with an empty source hash — it names a path and
binds no content at all.

`notebook/_master-index.md` is excluded: it is rendered from the topics rather than written, and the
reset rebuilds it instead of moving it. Any *other* loose file directly under `notebook/` appears
under an empty `topic`, because a reset does quarantine those and a report about what a reset would
take must not drop the one class of file that has no topic to sit in.

**Safety boundary: these rows are preflight evidence, and never a post-run fact.** They are computed
once, before the registry lock, from the Notebook as it stood when the reader was asked — deliberately
so, because that is the state the reader is approving a move of. They are *not* re-derived after the
moves. On a completed run they therefore describe what **was** there, and the authority on what
remains is `remaining_in_notebook`, re-derived inside the lock. Read these for the approval and that
one for the outcome, never the other way round.

**And the advisory warns; it never gates.** It reads local publication journals only — no NAS call,
and no verification that a destination still holds the page it recorded. A row showing a topic fully
copied is a reason to ask the reader fewer questions, not permission to skip the confirmation. The
report says as much in its own `message`, and a reset remains an approved operation whatever the rows
report.

### What a completed run reports, and what the Desk shows

**Reader benefit.** Until 2026-09-15 the five `topics_*` fields on a reset result were computed from
the selection taken *before* the lock and never re-read, so a completed run told the reader what had
been **predicted** rather than what was **left**. Under `-WholeTree` that was plainly false:
`topics_owned_by_retired_seats` still named a topic the same run had just quarantined. A completed
run now also carries **`remaining_in_notebook`**, re-derived inside the registry lock after the
moves, so *"what is still in `notebook/`, and whose is it"* is answered from the Notebook rather than
from the plan. `Get-DeskOverview.ps1` answers the same question outside a reset: every topic it lists
now names its owning seat, so a reader can see whose material sits beside their own without running a
reset preflight to find out.

**Safety boundary: reporting may never widen the run.** The re-derivation is a *read*, taken after
the moves and before the lock is released. Nothing acts on it — it adds no target, retries no
refusal, and moves nothing. Its refusals are deliberately **not raised**:
`Get-NotebookResetTargets` refuses an unmapped topic, which is correct *before* a move and wrong
after one, and throwing there would fail a reset that had already succeeded. The preflight's own
fields are left exactly as the reader approved them, beside the new ones, for the reason
`open_books_advisory` and `open_books_after` already sit side by side — the approved set and the
outcome are two different facts, and a reader checking one against the other needs both.

**The Desk owner label stays inside the cosmetic tier** (the ruling of 2026-09-07). It names the seat
that owns a topic *already listed on this Desk* — a fact about this workspace's own shared Notebook,
which every seat may read anyway — and adds no article names, no page content, and nothing about
another seat's Desk. It takes **no lock**: `Read-NotebookTopicOwners` is deliberately outside both
lock sets (ADR-0019), the record is replaced atomically, and every other read on that page is
lock-free for the same reason.

**The dot-source cost was measured before it was accepted**, because
`.claude/hooks/Guard-ShelfBookRead.ps1` explicitly avoids exactly this load on its own read path.
Loading `NotebookOwnership.ps1` costs **~40 ms** — it pulls in `BookWriteGuard.ps1` and
`NotebookIndex.ps1`, `BookRootSchema.ps1` and `LibrarySeat.ps1` being already loaded here — and the
record read itself ~1.4 ms, against a 576 ms `Get-DeskOverview.ps1` invocation: **~7%**. The guard's
avoidance does not transfer, and the difference is frequency rather than size. That hook runs on
every `Read`, `Grep`, `Glob`, `Write` and `Edit`, hundreds of times a session, and pays for a topic
it usually does not need; this helper is invoked by a reader asking what is on their Desk, and no
hook calls it — the per-prompt hook is `Get-VirtualDeskContext.ps1`, a different script. A cost paid
once when it was asked for is not the cost the guard declined.

There is deliberately no local Notebook-archive folder, and the quarantine is not one: it is a
recovery route for material a reset has already moved, not a place to file things on purpose.
Before resetting, a reader who wants to retain material still chooses a meaningful destination: a
local Shelf Book, a shared Library copy, or an active Project Hub. Those paths already have their
own confirmation and NAS-backed preservation boundaries. Do not offer a local Notebook archive.

### What a reader can see of a quarantine, and why the Desk cannot show it all

**Reader benefit.** A quarantine was a name and a list of topic folders. `-List` said which stamped
directories exist, which seat made each one and which topics are inside — but a topic is a folder,
and *"is the page I am missing in there?"* was a question the Library could not answer without a file
browser. `-Show <name>` answers it: one row per topic with its articles named, its article count, and
the total number of files the topic holds, so a reader can tell a topic that came through whole from
one that was already half empty when the reset took it. The roster keeps its shape and gains the two
numbers a reader chooses *between* quarantines with — how many articles each holds, and how old it
is.

**And the Desk says a quarantine exists at all**, which is the half without which the rest stays
theoretical. Nothing surfaced these directories unless the reader already suspected them: they sit
under `internal/`, no index lists them, and a reader who reset three weeks ago and now wants one page
back had no reason to believe there was anywhere to look. `Get-DeskOverview.ps1` now carries a
`notebook.quarantine` block — how many there are, the oldest one's name and age in days, and the
command that names what is inside.

**Age has two sources and the row says which one answered.** `quarantined_utc` comes from the
quarantine's `reset-journal.json`, and that journal is *allowed* to be missing or unreadable:
`Read-NotebookQuarantineJournal` fails soft by design, because a corrupt note about the material must
never stop the material coming back. So the age falls back to the stamp in the directory name, which
the reset writes as `<seat>-<yyyyMMdd-HHmmss>` in UTC at the moment it creates the directory —
a second or so ahead of the journal's own timestamp, and exact enough for an age in days.
`stamp_source` reports `journal`, `directory-name` or `unknown`, and **`quarantined_utc` is left
exactly as the journal gave it**, empty when there was no journal to read. A field that is blank and
a field that has been filled in from somewhere else look identical to a reader, and only one of them
is honest about where the answer came from.

**The seat does not fall back, and the difference is what each answer is for.** That same directory
name begins with the seat that made the quarantine, so `quarantined_by` could be read off it just as
easily — and is not. An age is orientation: wrong by a second, it costs nothing. The seat is what
decides whether a restore may act at all, and `Get-RestoreDispositions` refuses a topic rather than
guess at its owner. A directory can be renamed by hand; a record cannot be renamed into existence.
So `quarantined_by` is empty wherever the journal is, and the reader is told to open the one
quarantine rather than sold a name nothing supports.

**Safety boundary: this is a read and it stays one.** `-Show` takes no lock, writes nothing, and
needs no seat — for the reason `-List` needs none, which is that a reader whose session has lost its
seat is exactly the reader asking what survived. **Do not seat-gate it to make it match the Desk.**
The asymmetry runs the other way: `Get-DeskOverview.ps1` throws without a seat because a Desk belongs
to a seat, so the Desk surface *cannot* reach the reader these two reads exist to serve. That is
precisely why the Desk block names the command instead of only printing a count — the reader who most
needs the route is the one who cannot run the surface that mentions it.

**It names articles; it does not read them.** `-Show` reports file names and counts and never page
content, and the only seat it names is the one the journal records as having made the quarantine —
the same fact `-List` has always carried. It lists one directory of this workspace. It does not widen
the cosmetic tier of 2026-09-07 and it consults no other seat's Desk.

**The Desk block costs one directory listing and one small journal read per quarantine**, and no new
dot-source: `NotebookOwnership.ps1` arrived on this path with the owner label above, and
`Get-NotebookQuarantineInventory` was already in it. Measured on 2026-09-15 at **~5.5 ms** for a
fixture holding three quarantines of three topics each, against a **649 ms** child-process
invocation of the helper — under 1%, and this workspace holds one quarantine, not three.

**The per-topic article walk is deliberately not in that function.** It is a separate call that only
`-List` and `-Show` make, and the measurement is why: over the same three quarantines it costs
**~5.8 ms** again, roughly doubling the read — and it scales with *articles* rather than with
quarantines, so on a real Notebook topic of twenty-seven pages it keeps growing while the count and
the age do not. The Desk asks how many and how old; the reads that name things pay for naming them.

### Whose topics a sweep over idle seats may take, and whose it must leave

*(2026-09-15, [ADR-0023](adr/0023-idleness-authorises-a-sweep-retirement-still-gates-whole-tree.md).
The predicate and the rule. The `-AllIdleSeats` sweep that uses them shipped the same day; what it
shows the reader, and what it refuses to merge, is the section after this one.)*

**Reader benefit.** A reader who asks to clear the Notebook means the Notebook, not their slice of
it. A seat-scoped reset leaves behind every other seat's topics, and the route that clears a
*dormant* seat's topic today is two steps with a worse record than one: reassign it with
`Set-NotebookTopicOwner.ps1`, which **overwrites the only record of whose it was**, and then reset it
as your own. One sweep does the same work in one approved operation and keeps each topic's owner, so
what comes back out of the quarantine can still be given back to the seat it came from.

**Safety boundary.** A sweep may take a topic only from a seat that is **idle now** and whose
**incarnation the registry still names**. It must leave:

- a seat with a live session (`held`) or a live agent whose claim holder was lost (`orphaned`) —
  material somebody is still writing;
- a topic owned by a **retired** incarnation — that is `-WholeTree`'s, and ADR-0016 is unchanged;
- a topic owned by an incarnation that is **neither registered nor retired** — nothing can say that
  work is finished, which is the `rm -rf` data-loss family closed on 2026-09-10;
- every `shared` or `excluded` topic, and every Desk, exactly as a reset does today.

**Idleness is read per incarnation, and that ordering is the guard.** A claim state answers about a
*slug*; an ownership row names a *slug and an incarnation*. A seat retired and created again under
the same name is a different seat, so a sweep that probed the claim first would read the new seat's
idleness and quarantine the old one's material — silently widening `-WholeTree` for retired rows and
reopening the hand-deleted-directory hole for unaccounted ones. `Get-SeatSweepDisposition` therefore
asks `Get-SeatIncarnationStatus` **before** it probes, and each of its six answers carries a distinct
reason so a preflight can say which rule left a topic alone rather than reporting one shared silence.

**Skipping is not refusing.** A refused operation stops and changes nothing; a sweep names the seat
it skipped and carries on, because "clear every idle seat" is a request one busy seat must not
cancel. The seat-state matrix spells the two apart — `skip`, not `refuse` — so a reader can tell a
disclosure from an abort.

### What the sweep shows before it runs, and the two operations it refuses to merge

*(2026-09-15. `Reset-LocalNotebook.ps1 -AllIdleSeats`, built on the predicate and the rule above.)*

**Reader benefit.** "Clear my notebook" is now one approved operation rather than a survey. The
preflight names every topic the run would take, **whose each one is**, and how much of it already
exists durably in a Book or a Project Hub — the three things a reader approving a cross-seat move
cannot supply from memory, in the preflight itself rather than in a separate report they would have
to know to run. Each topic it leaves is named with the rule that left it and the sentence that says
what to do about it, so the difference between "somebody is working there" and "that seat is retired,
use `-WholeTree`" is visible without reading any code.

**Safety boundary.** Beyond the predicate's own limits above, the sweep must not cross four more.

- **The two switches are refused together.** `-WholeTree` covers this seat plus explicitly retired
  incarnations; `-AllIdleSeats` covers seats that are merely idle now. Passing both is an error that
  selects nothing, because the flag is load-bearing rather than cosmetic: if they composed, the
  foreign refusal that keeps ADR-0016's third case refused would be half-silenced by a second
  switch, and the next reader would find `-WholeTree` reaching an idle seat with no decision saying
  it may. They compose **in sequence** instead — sweep, then whole-tree — each with its own preflight
  and its own approval.
- **One quarantine per run, and its journal is the only thing that will ever say whose each topic
  was.** The ownership rows stay in `internal/notebook-topic-owners.json` pointing at their seats, but
  a purge takes them, and the material in the quarantine carries no owner of its own. So
  `reset-journal.json` records `all_idle_seats` beside `whole_tree` and one `{topic, seat, seat_id}`
  row per topic, surfaced as `recorded_owners`. Without that record a sweep would be a one-way door:
  restorable, and to nobody in particular.
- **A seat that wakes between the preview and the approval stops the run, with nothing moved.** The
  `plan_id` binds the target set *with each topic's owning incarnation*, so a seat taking a session
  after the preflight changes the selection and the approval no longer describes it. That is the
  guard working: rerun the preflight, show what changed, and ask again — never reach for a fresh
  `plan_id` to make the old approval go through.
- **No Desk but the acting seat's is touched, and only with `-ClearDesk`.** A sweep reaches other
  seats' Notebook topics and nothing else of theirs. ADR-0010 is unchanged.

**How much each topic costs to lose is measured, not asserted.** The per-topic rows come from the
same walk `library_copy_advisory.topics` renders rather than from a second one beside it, so the two
cannot disagree. `pages_without_current_copy` is the number to act on: only `known-current-copy` is
proof, and `known_books` and `known_projects` say **where to look** rather than what is proven. A
topic with no markdown pages reports a measured `0`; if the advisory itself could not be read, every
count is empty rather than zero, because a zero a reader reads as "nothing to lose" must never stand
in for "this was not measured".

**Each seat is asked about once per pass, not once per topic.** A seat owning several topics is the
ordinary case, and resolving it per row would both cost a claim probe each time and let two probes of
one seat disagree — putting one of its topics in the target set and leaving its sibling out, from a
single pass over a single record. The preflight reports the probes it really cost, so the claim can
be checked rather than trusted.

## User output and internal state

`output/` is the reader-facing destination for requested reports, PDFs, documents, spreadsheets,
CSV exports, drafts, and other generated files. It is not an implementation cache.

Application-managed records live under `internal/`:

- `publication-journals/` — publisher provenance, recovery, and copy-drift evidence;
- `triage-plans/` — the plan record a confirmed triage batch was approved against. `handoff-plans/`
  holds the pre-2026-08-28 records: still readable, never rewritten, and no longer re-runnable.

The operational records were moved from `output/` to these locations on 2026-08-14 without
rewriting their contents. Historical archive-package acceptance evidence is retained only in the
development workspace, not the production Library. The Inventory, publisher, and triage runner
use the internal paths above. Reset preserves both `output/` and `internal/`.

## Desk as current session knowledge

The Virtual Desk lists the Books and Project Hubs the reader has deliberately opened. The
Notebook is also active local knowledge, so a request such as **what is on my desk?**, **what do I
have open?**, or **what knowledge is connected to this session?** receives a compact combined
briefing.

Books open and close identically whether they live in the shared collection or on the local Shelf.
An open Book is recorded as its collection root — `books/<slug>` for a shared Book, `shelf/<slug>`
for a Shelf Book — and both are read through the same validated reader. A bare slug is the
pre-symmetry format and still means a shared Book.

Closed means unreadable in both collections, but for different reasons. A closed shared Book is
unreadable because its file is on the NAS and never on this disk. A closed Shelf Book *is* on this
disk, so `Guard-ShelfBookRead.ps1` supplies locally what the network supplies for free: it denies
`Read` and `Grep` under `shelf/<slug>/` unless that Book is open. `shelf/_catalog.md` stays readable,
as the shared Book Catalog does, because browsing is not reading a Book.

`Get-DeskOverview.ps1` is the read-only source for that briefing. It returns:

- every open Book as its slug, location (`shared` or `shelf`), and collection root;
- every open Project path;
- the Notebook's topic count and article count;
- each top-level topic's index path, article count, and a short overview drawn only from its index;
- **this seat's own occupancy** (added 2026-09-10): which of the three sources named the seat, its
  `free`/`held`/`orphaned` state with the repair for an orphan, the agent process and start time
  behind that state, the bind time and seat incarnation, and the conversation the seat last recorded
  with its title — or, when there is no title, which of six reasons that is; and
- one line per **other** seat: its open counts, whether it is claimed, and an advisory last-activity
  time. Never its open Books and never its conversation.

The helper does not read Book or Project content, open additional records, or read every Notebook
article. It reads one file outside the workspace and says so in its `scope`: the head of **this**
seat's last conversation transcript, which is where a conversation title exists at all. It supplies
orientation, not hidden retrieval. The Librarian may name only what the helper returned and should
explain that these are the knowledge sources currently connected to the session.

## Acceptance evidence

### Desk overview

A live Claude acceptance run passed on 2026-08-14 without changing the desk. It reported the open
`buzz-self-hosting` Book, the `projects/buzz-relay-deployment` Project, and the then-current Buzz
topic in the volatile Notebook with ten articles. The reader-facing briefing correctly described
these as the knowledge connected to the session. It used only `Get-DeskOverview.ps1`, made no shared-Library read, and reported
`shared_library_write: false`.

### Reset

A separate Claude end-to-end acceptance run used a disposable fixture rather than the real Pilot.
Its preflight named the fixture Notebook, open Book, open Project, confirmation gate, and preservation
scope. After one simulated confirmation, it proved that the old Notebook topic was gone, the fresh
master index existed, both desk lists were zero bytes, and byte hashes for fixture `docs/`, `raw/`,
`output/`, and `internal/` files were unchanged. No network or shared-Library tool was called. The
real Pilot's Notebook manifest and Virtual Desk were also confirmed unchanged after the test.

## Lessons retained

- A fresh start should remove leftover research and open references, not the harness that makes the
  Library safe and useful.
- A session overview is most useful when it combines the user-managed Desk with a small, explicit
  Notebook inventory.
- Keep the overview deterministic and shallow. Do not turn a status request into an automatic deep
  read or dependency search.
- Test destructive local workflows in a disposable workspace before exercising them on the reader's
  real Notebook.
- Keep user-facing output separate from the publisher's recovery records and test evidence.

## Key Takeaways

- `notebook/` is disposable working knowledge; `docs/` is durable Library knowledge.
- Reset takes the Notebook topics **this seat owns** and **quarantines** them rather than deleting
  them, after a preflight and one confirmation carrying that preflight's `plan_id`.
- Reset **leaves the Desk open** unless `-ClearDesk` is passed (ADR-0010), and refuses a topic that
  no seat owns.
- Quarantined material comes back: `tools/Restore-NotebookQuarantine.ps1`, whose `-List` is a read
  and needs no seat.
- `-Show <name>` names the articles inside one quarantine, and the Desk reports how many
  quarantines there are and how old the oldest is — with `stamp_source` saying whether the age
  came from the journal or from the stamped directory name.
- Desk status includes open Books, open Projects, and a concise Notebook inventory.
- `output/` contains user deliverables; `internal/` contains application-managed records.
- Local retention happens through Shelf Books, Library copies, or Project Hubs—not a second Notebook archive.
