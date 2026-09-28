# Basic Memory: Connecting, Importing and the Cutover

> For a Library whose Books and Project Hubs live on your own disk (the default), when you also have a
> Basic Memory server. The server is optional: it lets you read shared Books from another machine, and it
> is how you move an older Basic Memory workspace into a Library. Nothing here ever writes to Basic Memory.

A short answer first: **your Library always keeps its own Books and Hubs, in its own `collection/` folder.**
A Basic Memory server is a **connection**, a second place the Library can read from. You can compare the
two, import from the server's storage folder, and open a shared Book without copying it. Disconnecting
removes the connection and nothing else.

## Connecting

Ask the Librarian to connect Basic Memory, or run it yourself:

```
library basic-memory setup --url <the server's MCP URL> --collection <name> [--storage <folder>]
```

Each value is checked live before anything is saved:

| You give | It is checked by | It is needed for |
| --- | --- | --- |
| the server URL | the server answering within the timeout (20 s, or `LIBRARY_MCP_TIMEOUT_MS`) | everything |
| the collection | choosing it from the server's own list; its id is stored | opening a shared Book |
| the storage folder | it holds `books/README.md` and `projects/README.md` | the comparison and import |

A value that fails is shown with the reason, and nothing is saved. The storage folder is optional: without
it, status and opening a shared Book still work, and import says it needs the folder. The connection is
kept inside your Library (`.library/workspace.json`), so a Library carried to another machine by folder sync
brings its connection with it. The storage folder is a path on the machine that set it up, so a second
machine runs set-up again to name its own.

`library basic-memory disconnect` removes the connection. Neither your Library's Books nor the server's
are touched.

## Seeing how the two differ

> Ask: **"How does my Library compare with Basic Memory?"** (`library basic-memory status`)

```
Basic Memory  <server URL>   reachable
  Collection  my-collection   12 Books · 5 Projects · 4 archived
  Access      read-only (import reads the storage folder; nothing is ever written to Basic Memory in 1.1)
  Compared    3 Books only there · 1 only here · 2 differ · last import 2026-09-27 10:14
```

Status writes nothing, anywhere. **"Differ" says which side changed**, measured against the record of your
last import: `there` (the server changed it), `here` (you did), `both`, or `unrecorded` for a Book in both
places that no import brought.

## Importing

> Ask: **"Import from Basic Memory."** You will see a preview first.

```
Import from <storage folder> into <your Library>\collection
  New        12 Books, 5 Projects, 3 archived Books, 1 archived Project   (640 files)
  Skipped    notes/ work/   · 4 links into them will dangle
  Notes      2 Books have no publication state (imported as-is) · archive/old-blog is uncatalogued …
```

Your yes covers exactly that preview (its `plan_id`). What to expect:

- **The source is only read.** Files are copied byte for byte, and frontmatter is kept exactly as it was.
- **Only Library material is taken:** `books/`, `projects/`, `archive/` and `archive/projects/`. Every other
  folder, every dot-folder and every link or junction is named and left alone.
- **Your catalogs are added to, never rewritten.** A Book the import adds gets the server's own catalog line,
  under the server's heading.
- **Import can run again, and it never overwrites work on either side:**

  | Since the last import… | The import… |
  | --- | --- |
  | only the server changed a file | updates it here |
  | only you changed it | keeps yours |
  | both changed it | names it as a conflict and leaves both alone |
  | the server removed it | keeps it here: import never deletes |
  | a Book or Hub of that name is already here, and no import brought it | names it as a conflict and skips the whole Book, unless it is identical file for file, when it is simply recorded as imported |

- **If it stops partway** (a crash, a closed laptop), ask for the import again. It finishes what it started.
- A file that changes on the server between your yes and its copy is skipped and named, never copied from a
  stale plan.

The record of what was imported is `collection/imports.md`. It is written by the import alone. Edit it, and a
re-import can no longer tell your changes from the server's.

## Opening a shared Book without importing it

> Ask: **"What shared Books are there?"**, then **"Open the X shared Book."**
> (`library basic-memory open`, then `library basic-memory open <slug>`)

The list marks each Book that is **also in your Library**. An opened shared Book sits on your Desk as
`shared/<slug>`, and its pages are read from the server each time, never copied. If the same Book is open
from both places, the Librarian asks which one you mean.

**Before switching back to 1.0,** close your shared Books: 1.0 cannot read a Desk that holds one.
`library basic-memory rollback-check` lists every seat that holds one, with the command that closes it, and
`install.ps1 -Rollback` refuses to switch until they are closed.

## A Library inside a synced vault

The Library replaces most files through one staging folder, `.deskpost-staging\`, rather than a temporary file
beside each one, so a sync client sees far less churn. Obsidian ignores dot-folders already. For any other sync
client, add one exclude rule for `.deskpost-staging`. Some writes are not staged: a new note is created under its
final name, the Shelf's reader maps and the journals are written in place, and the Library's `internal/` records
keep their own temporary files. A sync client can still see those.

## The cutover: moving from a Basic Memory workspace

This is a checklist, not a command. The Librarian walks it with you, and each step has its own preview and
yes. The old workspace and Basic Memory stay intact throughout, as the fallback.

0. **Triage the old workspace's Report Inbox.** Mark each fixed or obsolete Report `done`. Leave every Report
   that is still true as `pending`.
1. **Carry the Holding Shelf, then the still-pending Reports, into the new Library:**
   ```
   library shelf carry <old-workspace> --book holding
   library shelf carry <old-workspace> --book reports
   ```
   Notes are copied byte for byte, with their dates and review state. Only pending Reports carry. A note
   already here is skipped. A same-named but different note is named as a conflict. The carried notes keep
   their old seat and conversation ids, which this Library does not resolve: harmless, but visible. Triage
   them at the new development seat.
2. **Run the last import from Basic Memory,** and settle any conflicts it names.
3. **Stop working at the old workspace's seats.** Leave the old workspace and Basic Memory as they are.
4. **Retire any export or mirror** of the old collection into your vault, so the vault holds one copy.
5. **Point any launcher or shortcut** you start sessions from at the new program.

**Before the first real import into a vault,** import into a scratch Library outside the vault, and run the
vault's own doctor over the new Library's folder. Settle anything it flags before a whole collection lands in a
synced folder.
