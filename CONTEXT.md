# The Library

The Library is a personal research and working-knowledge workspace in which an LLM acts as a
Librarian: reading source material, compiling it into working knowledge, and keeping selected
context in a durable collection. This file is the single glossary for that vocabulary. It defines
what each term *is*; it is not a spec, and it holds no implementation detail.

## Places material lives

**Library**:
This local workspace and the working collection it owns.
_Avoid_: the Pilot, the workspace, the vault

**Notebook**:
The reader's disposable scratch space, carried through every part of the workflow. Session findings
and source material land here first; what proves worth keeping graduates to a Book or the Holding
Shelf, and a reset removes the rest. **Each seat has its own** (ADR-0029): `notebook/<seat>/`, whose
topics are that seat's by where they live, so nothing records who owns them and a reset at one seat
reaches no other. Material two seats both want has no shared home; it graduates to a Shelf Book. A
workspace reaches that layout once, through the **Notebook migration**; until then -- and in the
PowerShell tools, which never carry it -- every seat shares one Notebook at `notebook/<topic>/`.
_Avoid_: notes, scratch, working set, drafts

**Shelf**:
The reader's own collection of Books, held on this machine and never part of the shared collection.
It survives a reset. Material that warrants preserving beyond this machine is published to the
shared collection; that choice, not a backup, is what makes a Book durable.
_Avoid_: local library, cache

**Shared collection**:
The NAS-backed collection of Books and Project Hubs. Never stored on this disk.
_Avoid_: the NAS, Basic Memory, remote library, the cloud

**Local collection**:
A workspace's own collection at `collection/`, in the shared collection's exact layout, that a workspace
with no Basic Memory endpoint writes Project Hubs to (ADR-0030). `library init` lays it out and records
its persistent id in `collection/.library/collection.json`; it takes no ownership claim, because it sits
inside one workspace. So far the kernel alone reads and writes it (`library hub new`, seat creation, the
Project Catalog read); the PowerShell tools still reach only the shared collection.
_Avoid_: local library, offline mode

**Library Mirror**:
A one-way, derived copy of the shared collection's published Books and active Project Hubs, written
into the reader's own Obsidian vault so the collection can be read on every device they use. Bodies
are byte-exact and its links are never rewritten, because it is a reading surface and not a second
home for the material: the Library is upstream, nothing is ever written back, and nothing in it is
authoritative. A mirrored note's stamp records what was true at the export that emitted it, not what
is true now.
_Avoid_: sync, the vault copy, backup, export

**Raw**:
Source material for a project, held as named source batches of any file type: supplied by the reader,
or fetched at their request from a named upstream. It is both what gets compiled into the Notebook and
the source of truth to check a Book against. Never a permanent home: batches are expected to be
cleared as the projects they serve close.
_Avoid_: input, corpus, dump, archive

**Working tree**:
The live checkout a development Project's work happens in, named by its Project Hub. It is external
to the Library and belongs to the project being worked on, not to the collection. Distinct from Raw:
Raw is source material the Library has copied and owns, while a working tree is never copied,
compiled from, or kept.
_Avoid_: repo, codebase, source, checkout

**Source check**:
Comparing a Book's claims against a raw batch, while that batch still happens to be present. It is
opportunistic: a Book does not depend on its source, and a source that has served its purpose is
deleted. A Book with no surviving source is finished, not orphaned.
_Avoid_: audit, validation, fact-check

**Currency check**:
Asking a Book's recorded source what version it is now, and comparing that against the version its
articles record. Where a Source check asks *is this true?*, this asks *is this current?* -- and it
needs nothing local, because the version is recorded in the article rather than inferred from a batch
that may be long deleted. It reports that a **Refresh** is due. A source it cannot reach leaves the
Book unverified, not defective.
_Avoid_: staleness check, freshness check, stale

## Units of knowledge

**Book**:
A self-contained, portable package of reusable knowledge whose reader-facing core is its `wiki/`
pages. A Book may live on the Shelf or in the shared collection; where it lives is a property the
reader may ask about, not a rule they must learn.
_Avoid_: wiki, doc set, package

**Capture Book**:
A Book that accepts appended notes rather than being curated. Its catalog entry is the only thing
that marks it as one.
_Avoid_: working book, scratch book, journal

**Holding Shelf**:
The capture Book that receives from the reader's own Notebook. It holds material set aside that has
not been vetted — kept so the reader can reset freely, and revisited a project or two later to be
discarded or graduated to a Book. It is a buffer awaiting a decision, not a place to store things.
_Avoid_: Inbox — that is the Report Inbox, which receives from somewhere else; also Notes Inbox,
staging, the queue, short-term storage

**Report Inbox**:
The capture Book one seat files into for another to triage: a defect hit, or a gap where a tool
should be. A page is one agent's claim about the Library itself, carrying the evidence it was
written from — verified against the code before it is acted on, and never a task. What separates it
from the Holding Shelf is where it receives from: another seat, rather than this reader's Notebook.
_Avoid_: the bug tracker, tickets, the queue, messages

**Project Hub**:
Living, outcome-specific context for one bounded effort. It orients current work; it is not a task
system. `Now` is where the work stands and `Next` is its open actions. A Hub for development work
**may also** carry a `Decisions` section of one-line pointers to settled ground — optional and
specific to that kind of work, not part of every Hub's shape. A pointer there is orientation, not a
task: it names a decision and where its record lives, and is removed when that decision is
superseded.
_Avoid_: project note, board, tracker

**Catalog**:
The browsable list of a collection's Books or Projects. Reading a catalog is browsing, not reading a
Book, so it stays available while every Book is closed. Both collections have one, so a Catalog is
never a destination: material is published *to the shared collection* and then *appears in* its
Catalog.
_Avoid_: index, manifest, TOC, "the catalog" meaning the shared collection

**Reader map**:
A Book's own `_index` page, listing the pages it contains.
_Avoid_: table of contents, sitemap

**Canonical**:
Said of the Book holding the current coverage of a topic, when more than one Book covers it.
_Avoid_: master, primary, source of truth

**Superseded**:
Said of a Book whose coverage of a topic has been replaced by a canonical one. It stays in place and
stays readable; superseding is a statement about currency, not a deletion.
_Avoid_: deprecated, obsolete, stale, retired

## The Desk

**Desk**:
The Books and Project Hubs the reader has deliberately opened for the work at one seat, from either
collection. It exists so unrelated material cannot crowd the Librarian's attention — a control over
what is in play, not a security boundary. Every seat has its own Desk, and there is no Desk that
belongs to the Library as a whole.
_Avoid_: session, workspace state, context

**Seat**:
A named place to work, carrying its own Desk and its own Notebook, and bound to exactly one Project.
Everything else is shared — one collection, one Shelf, one lock namespace, one Discovery index — so a
seat adds a place to sit in the reading room rather than a copy of the library. (A workspace not yet
through the Notebook migration still shares one Notebook among its seats; see **Notebook**.) Entered through
`tools/Start-LibrarySeat.ps1`, or **bound to a running conversation** with
`tools/Enter-LibrarySeat.ps1` (ADR-0018), which the SessionStart hook offers to a session that has
none and does unasked for a conversation being resumed. `LIBRARY_SEAT` names one and authenticates
nothing; a binding is the authority and the environment must agree with it. **There is no default
seat.** A session that names no seat has no Desk: it can read the Library's own files, and it can
open nothing, read no Book, and change nothing.
_Avoid_: room, clone, workspace, session

**Conversation**:
One Claude Code session transcript, identified by its session id, resumable with `claude --resume`.
A seat remembers the conversations that sat at it, which is how a resumed conversation finds its
seat again. It is the transcript and nothing more: not the seat, not the Desk, and not the process.
_Avoid_: session, chat, thread

**Binding**:
The durable record that one agent process holds one seat: which seat incarnation, which process,
which conversation, and whether the record is provisional or committed. It is what lets a seat
answer to a *process* rather than to a name any process may carry by accident, so a binding and a
disagreeing `LIBRARY_SEAT` are a refusal rather than a preference.
_Avoid_: session, attachment, lease, registration

**Claim holder**:
The process that keeps a seat's claim handle open for exactly as long as the agent process holding
that seat is alive, and then lets go. It holds the handle on the agent's behalf and decides nothing.
_Avoid_: keeper, daemon, lease, watchdog

**Seat incarnation**:
One creation of a seat under a slug. A seat that is retired and later created again under the same
name is a *different* incarnation, so a record naming the old one has not been inherited by the new
one. A record written before incarnations existed names no id, and that absence is itself an
incarnation — the pre-identity one — rather than a gap.
_Avoid_: generation, version, instance, session

**Retirement record**:
The archived proof that one seat incarnation is finished: `internal/seat-archive/<seat>-<stamp>/`,
written only by the gated retirement helper, naming the seat, the incarnation and what was on its
Desk. It is what "retired" *means* — a missing seat directory is not one — and what frees the name for
a new seat. The seat's own Notebook is archived beside its Desk (ADR-0029); in a workspace not yet
through the Notebook migration, the record is instead what makes that incarnation's Notebook topics
reachable by a whole-tree reset.
_Avoid_: backup, tombstone, deletion, snapshot

**Discovery**:
Finding which Books might be worth opening, from catalog-class metadata alone — summaries, reader
maps, page titles and headings — without opening anything. Discovery licenses a suggestion to open a
Book; it never licenses an answer about what that Book says. A closed capture Book is the one
exception: it offers only its summary and pending count, because naming an individual note is
reading it.
_Avoid_: search, lookup, retrieval

**Open**:
Said of a Book or Project whose pages are available to the Librarian, because the reader opened it.
_Avoid_: loaded, active, checked out

**Closed**:
Said of a Book or Project whose pages are not available. Closed means unavailable in both
collections, by different mechanisms.
_Avoid_: unloaded, archived, locked

**Archived**:
Said of a Book or Project moved to an inactive shelf and removed from its active catalog. Distinct
from closed: archiving is an organizational move, closing is an attention choice.
_Avoid_: retired, deleted, cold storage

## Working with material

**Compile**:
Turning source material or session findings into concise, source-attributed working knowledge in
the Notebook.
_Avoid_: ingest, index, summarize, process

**Import**:
Bringing an external document set into the collection as a Book without compiling it. An imported
Book is someone else's material — structurally adopted, but not claim-verified.
_Avoid_: migrate, copy, ingest

**Graduate**:
Moving material out of the Notebook to somewhere a reset cannot reach.
_Avoid_: promote, save, commit, archive

**Capture**:
Setting a finding aside for later without sorting it now. It only ever adds a page.
_Avoid_: save, stash, log

**Triage**:
Reviewing working material and deciding where each piece goes, from either of the two local buffers:
the Notebook, whose topics a Reset moves out into a recoverable quarantine, and the Holding Shelf,
which a Reset never touches. It is **the sweep that makes a reset safe** — the Librarian reviews
what is there, proposes a destination for each piece (the Holding Shelf, the Notebook, a Shelf Book,
a Project Hub, or a new Book in the shared collection), and copies it there on one approval. So when
a reader says "reset", **triage the Notebook first**: offer it before the Reset, not after. Triage
only ever adds, apart from discarding one Holding Shelf note, which is named, bound, and separately
approved. Replacing or refreshing something that already exists in the shared collection is a
separate, separately approved operation. It is a copy, never a full-workspace backup, and never part
of the reset itself.
_Avoid_: process, sort, groom, handoff, backup, export, migration, sync

**Notebook migration**:
The one-time move of a workspace from one shared Notebook to a Notebook per seat (ADR-0029). Every
legacy item is named with a recorded disposition — a live seat's topics go to that seat, a retired
seat's are set aside, and whatever no seat owns waits for the reader to give it a seat or set it aside
— and nothing becomes active until every item is accounted for. It is gated like any consequential
operation, journals every move before it makes it, and can be resumed or rolled back from any point.
Setting aside is a quarantine a restore can bring back into any seat; nothing is deleted.
_Avoid_: upgrade, conversion, import, sync

**Publish**:
Creating a reader copy of local material in the shared collection.
_Avoid_: sync, push, upload, back up

**Refresh**:
Replacing an existing Book's reader pages from current evidence.
_Avoid_: update, re-sync, rebuild

**Reset**:
Moving the acting seat's Notebook — `notebook/<seat>/` — into a recoverable quarantine, and nothing
else. It **deletes nothing** — the quarantine is purged only by a separate approved operation — and
another seat's Notebook is never touched (ADR-0016, ADR-0029). A workspace not yet through the
Notebook migration still has one shared Notebook, and there a reset selects the acting seat's topics
by the ownership record instead.
The Desk survives by default; `-ClearDesk` clears it too, and that pairing is the full **Library
Reset** a reader asking to "start fresh" means (ADR-0010). Offer to **triage the Notebook first**
— that is what makes it safe. It touches no repository file, Shelf Book, shared page, or `raw/`
batch, and the only `internal/` records it writes are the quarantine and its journal — so a Git
cleanup is never a Reset, and a clean working tree is never evidence that one happened. A reader who
says "reset", "start fresh", or "reset my workspace" here means this; if they might mean repository
cleanup instead, ask which before touching either.
_Avoid_: clear, wipe, clean, start over

## How the Librarian is held to account

**Bounded helper**:
A named tool that performs one consequential action within stated limits, rather than the Librarian
improvising it.
_Avoid_: script, command, automation

**Preflight**:
A read-only preview of a consequential action, showing exactly what would change before anything
does.
_Avoid_: dry run, check, simulation

**Approval**:
The reader's one clear yes to a specific previewed action. It covers that action only and does not
carry to the next one.
_Avoid_: confirmation, sign-off, permission

**Reader benefit**:
The stated reason a change to the Library helps the person using it. Every reader-experience change
records one, alongside the safety boundary it must not cross.
_Avoid_: value, justification, rationale
