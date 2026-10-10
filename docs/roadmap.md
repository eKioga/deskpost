# Deskpost Roadmap

What is being built next, and roughly in what order. It is a statement of intent, not a promise:
anything here can move when real use shows something more urgent.

## How to read it

Deskpost is developed in **sessions**: one long, planned build session at a time, each with a
written scope and a handback that says what shipped. A milestone lists the sessions it expects, so
its progress reads **x of y sessions**. When a milestone reaches y of y, a release carrying it is
due. That is how it has tended to go rather than a rule, and a milestone can gain a session when a
handback parks something.

Most items begin as a report filed from real use: a refusal that named the wrong thing, a verb
that was missing, an idea from a design conversation. A report is checked against the code before
it becomes an item, so everything under **Now** and **Next** is a confirmed gap.

| Tier | Meaning |
| --- | --- |
| **Now** | scoped into the current or next session |
| **Next** | designed or confirmed, waiting for its session |
| **Exploring** | an idea being shaped; no design is signed off yet |
| **Back burner** | set aside on purpose; not planned |
| **Released** | shipped, with the release that carried it |

## Now

Nothing is scoped into a session yet. The last session of Seats you can rename (below) is next in
line.

## Next

### Seats you can rename (3 of 4 sessions; plan signed off 2026-10-07)

Its first session shipped in 1.4.0, its second and third in 1.4.1; nicknames and the audit record follow.

- **A seat's identity is its id, not its name** (shipped in 1.4.0), so a name can change without losing letters,
  Notebook topics or history. The Orca tab shows the seat's name with no `seat: ` prefix.
- **`seat rename`** (shipped in 1.4.1): one seat at a time, previewed, recoverable if interrupted, undone by
  renaming back; the seat keeps its conversation, Desk, Notebook and folders. An old name points the way to
  the new one.
- **A department of one seat** receives letters addressed to the department (shipped in 1.4.1).
- **Two system-wide seats from templates** (shipped in 1.4.1): an ideas seat that catches and vets ideas with
  each product's lead, and one auditor for the whole Library and its projects. Optional nicknames.
- **An audit record**: which revision of a Book, Hub or repository was last audited, and which are
  due again.

In order: the rest of **Seats you can rename**, then **Development without PowerShell**, then **Libraries on
more than one computer** (Eric, 2026-10-09).

### Libraries on more than one computer (plan signed off 2026-10-08)

Two ideas that turned out to be one design: **your seats on more than one computer**, so one
machine's memory and processor stop being the limit; and **two Libraries, one household**, where two
people share one collection on a home network: reading is free, and editing is borrowed. Underneath,
both are Libraries on different computers that name themselves, send each other letters, and share
one collection.

- **Each computer is a Library in its own right**, with its own seats, Desk, Notebook, Project Hubs
  and Shelf. Nothing about one computer's seats is decided on another.
- **Letters and shared Books go through Basic Memory**, a server on your own network that Deskpost is
  only a client of. Everything Deskpost keeps there sits in one Basic Memory project of its own, and
  nothing else on the server is read or changed. Hubs and Notebooks stay on each computer.
- **Basic Memory stays optional.** A Library without it works exactly as it does today.

Hard limits: **no accounts, no database, no internet service** of Deskpost's own. It follows the
remaining sessions of **Seats you can rename**, and it comes in two releases, each worth keeping even
if the next never ships. Moving the development tools off PowerShell may come between them.

#### 1.5.0: Libraries that write to each other (0 of about 2 sessions)

- **A Library card**: a display name for a Library, with no account and no server behind it. The
  card is a label, not a credential and not an address. The Desk and `collection owner --status` name
  a Library by its card, with its id beside it.
- **A Postbox in Basic Memory**: `deskpost postbox setup` connects a Library to a Basic Memory server,
  previewed and on your yes, and registers the Library there, so other Libraries can address it.
- **Letters between Libraries**: `capture letters --for <seat> --library <card>` leaves a letter for
  a seat in another Library, on another computer or another Claude account. It is delivered exactly
  once, even after a timeout or a retry, and it waits in the Postbox until the other Library collects
  it, as a letter waits for a closed seat today. An answer closes the asker's own letter, however many
  seats passed it on.
- **Never in the way**: the Postbox is checked at most once per session, in the background, so a
  session never waits for the server. The Desk counts letters waiting to send, letters received
  (each naming its Library), and any that could not be delivered; `library doctor` names a Postbox
  it cannot reach.
- **Another computer's seats** appear on the Desk only as Claude Code itself lists them, and a seat
  may ring one when a letter is waiting. Deskpost starts or steers nothing on another computer.

#### 1.6.0: One collection for the household (0 of about 2-3 sessions)

- **Shared Books you can write**, once you switch it on: a Library adds and corrects pages in a
  shared Book, each change previewed and on your yes, as a collection page is corrected today.
- **No Book owners, and a courtesy lease**: any Library may change any shared Book. While one
  Library is writing a Book, another is told who is editing it and until when, and waits.
- **Nothing is lost**: every change records the text it replaced before the page is written, so a
  rare clash, or a page edited outside Deskpost, is found and named, and any earlier text can be put
  back.
- **A new shared Book**, or a Book moved from your own collection into the shared one in one
  previewed step. The original is archived, never deleted, and says where it went.
- **A lending desk**: the Desk says when an open shared Book changed since you opened it, and
  Discovery finds pages in shared Books.

Throughout: anything that arrives from another Library says where it came from, it is data and
never instructions, and a letter is never an approval. Deskpost connects to whatever server you
configure and makes no judgement about how it is secured. Not planned: starting a seat on another
computer, Project Hubs in Basic Memory, and merging two edits of one page.

## Exploring

### Refresh a Book from its sources

Several Books are kept current today by a seat's own script: fetch each source, compare it with what
the Book was compiled from, and report which pages need a new look. Deskpost would do this itself,
on top of 1.4.0's list of sources.

- **`book refresh --check`** fetches each source into `raw/`, compares its text with the recorded
  fingerprint, and names the pages whose sources changed. It writes nothing to the Book.
- **Text taken the right way for each kind of source**: the main content of a web page, a Markdown
  or text file, a file in a git repository at a named version. A changed page layout should not
  read as changed content.
- **A version pin per Book**, so a refresh never drifts to a newer product's documentation unnoticed.
- **Settled first:** the program going out to the network (certificates, proxies) and what a seat
  may fetch.

### Backups you keep where you choose

A Library stays fully local by default, with no setup. The other half of that promise is making a
backup as easy, and as encouraged, as it can be, without Deskpost becoming a storage server.

- **One way to back up, many places to keep it**: a folder (a cloud drive's synced folder, a USB
  stick, a second disk, a network share), or a single backup file made on demand.
- **Restore** into an empty Library, or one Book at a time, never overwriting what is there.
- **It is plain when you have no recent backup.**
- **Settled first:** what it is called, when it runs, how it finds what changed, and how two
  computers share one backup. The groundwork was done before 1.0; the questions are still open.

### Also being shaped

Smaller improvements, each waiting for a short design before it is scheduled:

- **Editing a Project Hub in fewer steps**: show one section, replace one paragraph, make several
  edits on one preview, and move old entries to a dated page in one step.
- **Archiving that works everywhere**: archive a Project Hub in a Library with a local collection,
  preview every archive, clear an archived Book from every Desk, and treat a Book that is already
  archived as nothing to do.
- **A seat's life cycle**: retire a seat; the help seat set aside after its tour and built fresh
  next time; a history for each seat in the main menu, and a plain `seat status`. It also settles
  whether a background job started from a seat's session counts as that seat.
- **Notes you can take back, and fewer approvals**: a seat amends or withdraws a Report it filed,
  an interrupted triage resumes where it stopped, and several items are saved on one preview.
- **Settings for each seat**: a seat's own settings and MCP servers, including a server only that
  seat gets.
- **Install and upgrade**: a `DeskpostSetup.exe` you double-click, and a passive "a new version is
  out" hint in `library doctor`.
- **The guards' remaining cases**: a command that names a path in an unusual spelling (a drive
  root, `/d/`, after a `cd`, inside a heredoc or quotes) is judged, never let through.
- **Upkeep you can see**: `library desk` reports Hub sizes and the Notebook's size, age and
  growth, with size limits that fit each kind of page; `library doctor` warns when a Notebook keeps
  growing; a stale Notebook index is caught when it happens.
- **Refusals under `--json`** are one object on standard output, so a script reads them as it
  reads everything else.

## Back burner

Set aside on purpose, not planned, until real use calls for them again:

- **A read-only Desk view**: seats, open Books, the Notebook and inbox counts at a glance, drawn
  from the same data `library desk` reports. It would be another client of the program, never a
  second implementation, and exactly as honest as the program: a closed Book looks closed.
- **Moving Books on and off the Desk from the Desk view.**
- **A small local model for routine choices** (yes or no, one of a few), to spend fewer tokens.
  It waits until it would save something real, and until a ruling on whether a second AI provider
  may see your material.

## Released

### 1.2.4: Tidy shelves (released in 1.2.5, 2026-09-30)

Small corrections found by using 1.2.3 on real Books.

- **Archiving two Books in a row works on one preview each.** Today archiving one Shelf Book
  invalidates the other's approved preview, because the approval is bound to the whole catalog
  rather than to that Book's own entry.
- **Refusals name the flag you actually type**, `--plan-id`, rather than an internal parameter name.
- **Every `book` and `shelf` action prints its own usage** with `--help`, as `hub edit` does, and a
  missing slug gets usage rather than a slug-format error.
- **A Book's creation date is the local date**, as capture notes already are, so an evening Book
  is not dated tomorrow.
- **A new Project Hub's guidance no longer points at a page it does not have**: the `limits` page
  is made when the first limit arrives.
- **`raw/` is documented as staging, not storage**: each source batch is compiled into its Book and
  then evicted.
- `shelf recall` (new in 1.2.3) closes its last open cases, and the development gate stops
  depending on whether Deskpost is installed on the developer's own PATH.

### 1.2.5: Seat-only folders, and an upgrade that knows it is one (2 of 2 sessions; released 2026-09-30)

A seat that works on files outside the Library, such as a game mod's source or a repository, can
now be given those folders once, and only that seat gets them.

- **A seat remembers its own folders**: `deskpost seat dirs <seat> --add <path>`, or `f` and the
  seat's number in the main menu. Every launch of that seat, new or resumed, passes them to the
  assistant, so a folder's own skills load at that seat and nowhere else.
- **`library doctor` warns when a folder is shared by accident**: a folder remembered in the
  workspace's own settings reaches every seat, and doctor names the seat-only route.
- **Hub edits report `status` and `journal`**, as the other writers do.
- **Upgrading an install in its own folder just works**: the installer recognises the install it
  finds, says which version it upgrades from and to, and keeps the Library you already have,
  rather than asking where a new one should live.
- **The Linux download runs**: a release is built from the committed files, so its scripts no
  longer carry Windows line endings. The 1.2.3 Linux download has them.
- **The first half of 1.3.0 comes with it**: filing a Holding note somewhere better closes it,
  every close is stamped with when it happened, a capture can say why it is on the Holding Shelf,
  and a newer note can close the one it replaces. A seat closes only its own Holding notes unless
  the reader names another's.

It was released together with 1.2.4.

### 1.2.6: Seats that can talk (1 of 1 sessions; released 2026-10-01)

Claude Code can now pass messages between your sessions on the same computer. Deskpost gives each seat's session
the seat's name, so a session at one seat can find and message the session at another.

- **Each seat's session names itself after its seat on its second prompt.** Claude Code's list of your sessions,
  and its `/resume` list, show `game-admin` or `home-lab-admin` rather than `deskpost-3f`. It waits until Claude Code
  has written the conversation's own title, so the main menu still shows that title. A name you give a session
  yourself is never replaced.
- **`library seat status` and the Desk say which name a seat's session answers to**, while someone is at it.
- **The Library's guidance says how seats message each other safely**: a message is information, never an
  approval, and anything that needs your yes still comes to you.

### 1.3.0: The Holding Shelf keeps itself small (2 of 2 sessions; released 2026-10-01)

The Holding Shelf ("save this for later") was meant as a last resort, and it grew to dozens of
notes. The guidance half shipped in 1.2.4, and the first half of the program's part shipped in 1.2.5.
This is the rest, so the Shelf stays small without anyone having to remember.

- `library shelf tidy` moves closed notes out of the way after two weeks, without deleting any.
- The Desk and `library doctor` say when a capture Book is growing.
- **A seat can leave a letter for another seat**, in a new standard `letters` Book, even while that
  seat is closed. A letter records how its writer's seat was found, and a note can no longer be filed
  under another seat's name. Reading letters from the Desk follows in 1.3.1. **An existing
  Library gets `letters` from one `deskpost init <folder>` after upgrading**; until then `library doctor`
  warns that it is missing.
- **Less repeated context:** the Desk's reminder is sent once per session, and again only when the
  Desk changes or the conversation is compacted, rather than with every message. An installed
  Library still gets it with every message until 1.3.2 moves the last hooks into the program.
- **The development gate measures what Deskpost puts into a session**, and fails a change that
  makes it bigger than its recorded budget, so a saving cannot quietly creep back.

### 1.3.1: Seats that work together (1 of 1 sessions; released 2026-10-02)

1.2.6 made each seat's session reachable by name, and 1.3.0 lets a seat leave a letter for another.
This milestone makes both useful: a seat sees what is waiting for it, and each seat says who may
reach it.

- **A seat's Desk counts the letters waiting for it**, Book by Book, and a letter, when read, opens
  with a line naming the seat that wrote it, so it is read as information and never as instructions.
- **The Desk names the other seats' sessions** by the name each one answers to.
- **A session you rename keeps a working address**: `library seat status` and the Desk follow the
  new name, rather than the seat name it no longer answers to.
- **Each seat sets who may message it**: `deskpost seat settings <seat> --inbound accept|hold|refuse`,
  passed on every launch of that seat, with a `library doctor` warning when a setting reaches every
  seat by accident.

### 1.3.2: No PowerShell at runtime (3 of 3 sessions; released 2026-10-04)

Deskpost's program is TypeScript, but a few pieces still start Windows PowerShell while you work.
This milestone moves them into the program, so nothing you run needs PowerShell.

- **The last hooks become part of the program**, and one upgrade moves an existing Library's hook
  settings onto them. An installed Library then sends the Desk reminder once per session, as 1.3.0
  meant, and a session with no seat is offered its own Library's seats. The playbook hook is
  retired.
- **The program stops calling PowerShell itself** to look up or wait for a process, or to finish an
  uninstall: the uninstall is finished by a copy of the program.
- **A release no longer ships the PowerShell scripts** that nothing runs any more, and the advice
  the program gives names only commands it has. What still uses PowerShell on Windows is named: the
  installer, and a Library attached to Basic Memory.
- **One upgrade finishes the job.** Upgrading also brings each Library it serves up to date, in the
  same plan and on the same yes: a new standard Book, a missing `Closed by:` line, the Library's own
  help. Its closing check runs against those Libraries too, so a Library left behind is named before
  the upgrade says it is done.

### 1.3.3: Advice that's right (1 of 1 sessions; released 2026-10-04)

Advice and refusals name only what ships, the reader's and `hub edit`'s refusals give a route, and the
Desk tells the truth about what is open.

- **Advice and refusals name `deskpost` commands**, not the PowerShell helpers a release no longer
  ships, and say what the program lacks where no command exists yet.
- **The reader's and `hub edit`'s refusals give a route**: the reader accepts `projects/<slug>` and
  names `_project` for a missing Hub page, and `hub edit` names the content when a body repeats its
  own heading.
- **`desk close book` closes the Book wherever it is open**, and refuses when nothing matches.
- **The Desk tells the truth about what is open**, including for a seat the launcher holds.

### 1.3.4: A Book kept in one place (1 of 1 sessions; released 2026-10-04)

A Book that changes often can be kept in one place without paper cuts: a refresh has one id to
approve and keeps its summary on the Shelf, the reader says when a Book was archived, Discovery says
when a Shelf Book's index is stale and `shelf rebuild` repairs it, and `hub edit replace-item` keeps a
nested list with its item.

### 1.3.5: Install without PowerShell (2 of 2 sessions; released 2026-10-05)

- **`library install`** installs, upgrades, repairs and recovers Deskpost with no PowerShell running:
  the program does what `install.ps1` did, on the same receipt and lock, so either can finish what the
  other began.
- **One Command Prompt line** for a new reader, using the `curl.exe` and `tar.exe` Windows ships.
- **`install.ps1` becomes a thin forwarder**, so every existing one-liner keeps working.
- **The installer's closing check no longer ends in a PowerShell error** after an install that worked,
  and says whether the program or a Library needs the fix.

### 1.3.6: Upgrade in one step (1 of 1 sessions; released 2026-10-06)

- **`deskpost upgrade`** checks GitHub for a newer release and installs it, and the main menu says
  when one is ready (`u` upgrades from there). The check runs at most once a day and can be turned off.
- **An upgrade waits for open sessions to close** instead of refusing, and names what to close.
- **The one-liners need no options**, even for an install outside the default folder: the installer
  finds that install itself.
- **An upgrade keeps the install's answers** (the PATH choice too), removes program versions older than
  the one it could roll back to, and every refusal names the line and spelling the reader used.
- **Small fixes:** clearer refusals for `desk open`, Hub writers and the readers, and each seat's
  session named after its seat from the moment it starts.

### 1.3.7: Fixes from the 1.3.6 run (1 of 1 sessions; released 2026-10-06)

- **A first Linux install is accepted** when `~/.local/bin` is not on PATH yet; the installer says to
  add it instead of failing.
- **`deskpost` and `library` run from Git Bash** on Windows, beside the Command Prompt and PowerShell.
- **Install and upgrade say what they do:** the upgrade screen says upgrade, names the old versions it
  will remove and says "brought up to date" once; an install without a Library never checks the folder
  it was run from; the PowerShell line leaves nothing behind in the reader's shell.
- **Small fixes:** Hub and capture writes refuse stray control characters; `triage inventory` names
  each note's sender and recipient and can list only waiting notes; `hub edit new-page` advises
  `--content-path`; the kernel type-checks in the commit gate.

### 1.3.8: Seats that work as a team (4 of 4 sessions; released 2026-10-07)

- **Every seat gets a one-line card** saying what it does, an optional department and a role
  (performer or orchestrator), and a seat can see who does what in its department.
- **The main menu's `+` offers a template** for a new seat.
- **A letter can be addressed to a department.** It reaches that department's orchestrator, which
  answers it or passes it on to the right seat, and the Desk counts what waits, and what each seat
  has sent; a seat with letters waiting is not retired.

Each seat can say what it does, and may belong to a department, such as development, IT or
marketing. A seat can write to a department rather than to a named seat, and one seat decides where
each letter goes. Letters between seats are kept apart from the Report Inbox, have a status (open,
answered, routed, closed), and are never taken as an order.

### 1.4.0: Correct and find (4 of 4 sessions; released 2026-10-09)

- **Correct a page in a Shelf Book or a collection Book** without archiving and rebuilding the whole
  Book: a gated page replace that previews old against new and keeps the previous text in a journal
  (a Shelf page replace is bound to the page it previewed, and the previous text kept: ADR-0070).
  A topic index can gain the line for a page added under it.
- **`library doctor --report`** files what doctor finds to the Report Inbox, failures only by
  default, and never the same failure twice.
- **A browse mode in the main menu**: one key from bare `deskpost` lists the Books and Projects the
  Library holds, with titles, topics and summaries only. It is not a seat, and it opens nothing.
- **An unknown flag is refused by every verb**, rather than silently ignored.
- **A Book's reader map nests topic pages** under their topic, so the curated pages are not lost
  among dozens of source pages.
- **A Book's source text has a named home**, so material compiled out of `raw/` has somewhere
  durable to go.
- **A Book lists the sources it was compiled from**: each source's address, the page it feeds and
  the fingerprint of the text last compiled, in one file the Library owns. A seat's own refresh tool
  can read and update it, and after a page is corrected the Book records the new fingerprints, so
  it is plain which sources changed since. Fetching the sources is a later step (see **Exploring**).
- The first session of **Seats you can rename**: a seat's identity is its id, and the Orca tab shows
  the bare seat name.

### 1.4.1: Letters that ring, and seats you can rename (3 of 3 sessions; released 2026-10-10)

So the reader no longer carries mail between seats (ADR-0071).

- **A letter for every request and answer, rung at once**: the writer sends the recipient one message when it
  is open, and `capture letters` says how to reach it.
- **A seat hears of its letters when it opens**: the launcher's first prompt, and one line on its Desk served
  once for each newer letter; `seat enter` says the count.
- **`letters close`**: a seat closes its own letter in one step, with a one-line note and no reader's yes.
- **`seat start --inbound accept`** for a new Claude Code seat, so rings reach it at once.
- The second and third sessions of **Seats you can rename**: `seat rename`, previewed and undone by renaming
  back; an old name points the way to the new one, and the menu says "(formerly ...)" for 30 days.
- A Notebook reset refuses while a Hub or Shelf Book page links into what it would move; a department of one
  seat receives its letters; the auditor and ideas seat templates.

### Earlier releases

- **1.0.** One binary for Windows and Linux
  ([ADR-0028](adr/0028-the-kernel-is-typescript-shipped-as-one-binary.md)), installed apart from the
  Libraries it serves ([ADR-0027](adr/0027-the-program-is-separate-from-the-workspace.md)). Claude Code
  and Codex are both supported. A local collection is the default, with Basic Memory as the optional
  shared route, and each seat carries its own Notebook
  ([ADR-0029](adr/0029-the-notebook-belongs-to-the-seat.md)).
- **1.1.** An install that asks one question and shows its plan, `deskpost uninstall` and
  `deskpost rollback`, and bare `deskpost` as the main menu: your seats, and a number to resume one
  ([ADR-0059](adr/0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md)).
- **1.2.** Install by asking your assistant ([`llms-install.md`](../llms-install.md)): a plan the
  assistant shows, and an install bound to it. The install ends on **Show me around** (`h`), a guided
  first look from a `deskpost-help` seat, and every Library carries the `library-help` Skill.

## Keeping it current

This page and the README's **Roadmap** section change together, so the public page never trails the
work:

- **At each handback**, a milestone's count moves to the sessions that actually ran, and an item a
  handback parks says where it went.
- **At each triage**, a design item added to the backlog gets a tier here in the same change, or the
  backlog says why it stays off this page. At each handback, the support seat also checks its
  design queue for an item with neither.
- **At each release**, its version-bump commit moves the milestones it carries to **Released**, and
  the README names the new current release and the next milestones. A release's public README is then
  true on the day it ships.

## Out of scope

Accounts, hosted services, telemetry, and anything that needs a database.
