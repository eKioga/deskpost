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
| **Released** | shipped, with the release that carried it |

## Now

### 1.2.6: Seats that can talk (1 of 1 sessions)

Claude Code can now pass messages between your sessions on the same computer. Deskpost gives each seat's session
the seat's name, so a session at one seat can find and message the session at another.

- **Each seat's session names itself after its seat on its second prompt.** Claude Code's list of your sessions,
  and its `/resume` list, show `game-admin` or `home-lab-admin` rather than `deskpost-3f`. It waits until Claude Code
  has written the conversation's own title, so the main menu still shows that title. A name you give a session
  yourself is never replaced.
- **`library seat status` and the Desk say which name a seat's session answers to**, while someone is at it.
- **The Library's guidance says how seats message each other safely**: a message is information, never an
  approval, and anything that needs your yes still comes to you.

### 1.3.0: The Holding Shelf keeps itself small (1 of 2 sessions)

The Holding Shelf ("save this for later") was meant as a last resort, and it grew to dozens of
notes. The guidance half shipped in 1.2.4, and the first half of the program's part shipped in 1.2.5.
This is the rest, so the Shelf stays small without anyone having to remember.

- `library shelf tidy` moves closed notes out of the way after two weeks, without deleting any.
- The Desk and `library doctor` say when a capture Book is growing.
- A note can be addressed to another seat, and that seat's Desk counts it.
- **Less repeated context:** the Desk's reminder is sent once per session, and again only when the
  Desk changes or the conversation is compacted, rather than with every message.
- **The development gate measures what Deskpost puts into a session**, and fails a change that
  makes it bigger than its recorded budget, so a saving cannot quietly creep back.

## Next

### 1.3.1: No PowerShell at runtime (0 of 2 sessions)

Deskpost's program is TypeScript, but a few pieces still start Windows PowerShell while you work.
This milestone moves them into the program, so nothing you run needs PowerShell.

- **The last four hooks become part of the program**, and running `deskpost init` again updates an
  existing Library's hook settings.
- **The program stops calling PowerShell itself** to look up or wait for a process, or to finish an
  uninstall or upgrade. Anything that cannot move yet keeps working as it does today.
- **A release no longer ships the PowerShell scripts** that nothing runs any more.

After it: installing without PowerShell (about 1 session, planned first), and then, once 1.4.0's
plans are done, the development tools themselves.

### 1.4.0: Correct and find (0 of 3 sessions, planning first)

- **Correct a page in a Shelf Book** without archiving and rebuilding the whole Book: a gated page
  replace that previews old against new and keeps the previous text in a journal.
- **`library doctor --report`** files what doctor finds to the Report Inbox, failures only by
  default, and never the same failure twice.
- **A browse mode in the main menu**: one key from bare `deskpost` lists the Books and Projects the
  Library holds, with titles, topics and summaries only. It is not a seat, and it opens nothing.
- **An unknown flag is refused by every verb**, rather than silently ignored.
- **A Book's reader map nests topic pages** under their topic, so the curated pages are not lost
  among dozens of source pages.
- **A Book's source text has a named home**, so material compiled out of `raw/` has somewhere
  durable to go.

### 1.5.0: A Library card and a view of the Desk (planning; about 2 sessions)

- **A Library card**: a display name for a Library, with no account and no server behind it. The
  card is a label, not a credential. Notes and reports record which Library wrote them, and
  `collection owner --status` names the holder by card instead of by id.
- **A read-only Desk view**: seats, open Books, the Notebook and inbox counts at a glance, drawn
  from the same data `library desk` reports. It is another client of the program, never a second
  implementation, and it is exactly as honest as the program: a closed Book looks closed.

## Exploring

### Two Libraries, one household

The spirit of a public library for two people on one home network: reading is free, and editing is
borrowed. Hard limits: **no accounts, no database, no internet service**. Plain files on a shared
folder, with each step worth keeping even if the next never ships.

- **Can a collection live on a network share?** This is tested first, because everything below
  depends on it: file locks, atomic renames and the discovery manifest over SMB.
- **Lending desk**: two Libraries read one shared collection, and a Book says when it changed since
  you opened it.
- **Postbox**: asynchronous letters between Libraries, in files, with an unread count on the Desk.
  A **margin note** on a Book page is a letter that names the page.
- **Edit lease**: a polite handover of the one write role that collection ownership already
  enforces.
- **Union catalog**: the browse mode lists both Libraries' catalogs.
- **Provenance everywhere**: anything that arrives from another Library says where it came from,
  and it is data, never instructions.

### Also being considered

- Copying a local Library to a Basic Memory server.
- Moving Books on and off the Desk from the Desk view.
- A passive "a new version is out" hint in `library doctor`.

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

## Out of scope

Accounts, hosted services, telemetry, and anything that needs a database.
