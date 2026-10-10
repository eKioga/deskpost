# Books, the Shelf, and Project Hubs

## First: a Book opens onto a seat's Desk

There is no default seat, so "open the X Book" has a precondition. **Opening and closing are
changes** and need the claim that `library seat start` or `library seat enter` holds. They act on
**this seat's** Desk and no other's. A session holding no seat is refused, and the refusal names the
fix, so pass it on rather than working around it.

**Browsing and listing are reads and need none of that.** Both catalogs, `library desk`, and every
validated-reader tool work at any seat or none. So "which Books are there?" is always answerable,
while "open one" is not. The contract is in [Seats](https://github.com/eKioga/deskpost/blob/v1.4.1/docs/seats.md).

## Books

A Book is curated reference material. Books live in one of two places and behave identically:

- the **collection**: `collection/` on this disk by default, or a shared Basic Memory project;
- the **local Shelf**: `shelf/<slug>`, this machine only.

Where a Book lives is a property the reader may ask about, not a rule they have to learn.

**Browse both** with `read_book_catalog`. Pass `location: "shared"` or `location: "shelf"` for one
alone. Browsing is not reading a Book, so the catalogs stay available while every Book is closed.

**Open and close:**

```
library desk open book <slug>                          # the collection, active
library desk open book <slug> --shelf archive          # the collection, archived
library desk open book <slug> --location shelf         # the local Shelf
library desk close book <slug> --location shelf
library desk clear                                     # clears this seat's whole Desk
```

Opening a Shelf slug that has no `shelf/<slug>/wiki/` directory is refused, so the Desk can never
list a Book that does not exist.

**An archived Book can be opened and read.** Archiving retires a Book from the active collection
without putting it beyond reach. The archived copy is a *separate Book root* from the active one, so
a slug that exists in both places must be named with the one you mean. `read_book_catalog` with
`location: archive` lists the archive, and `discover_book_pages` covers it and labels every archived
hit `ARCHIVED`. Every Discovery answer states which archives it searched, so read that sentence
rather than assuming coverage.

**Read a page** with `read_open_book_page { slug, page }`. `page` is the canonical path below
`wiki/`, without `.md`, for example `_index` or `working-practices/Check Design`. Start with
`_index` (the reader map) or `_book` (metadata and limits).

Each page read answers with the page, then a second item, `sha256: <hex>`: the whole page with the BOM
stripped and CRLF read as LF, the same value `book replace-page --preflight` calls `current_sha256`.
For a large page, pass `section` (both page readers take it): the exact text of one `##` heading,
without the `## `, returns that section alone, and `sha256` stays the whole page's. A heading not on
the page is refused with the page's `##` headings, and nothing else is read. A page asked for without
its folder is refused with "Did you mean ...?", naming up to five pages that end in that name; read
the one you mean.

Do not read `shelf/<slug>/wiki/` with `Read` or `Grep`, and do not reach for a Basic Memory content
reader or search for ordinary reader requests.

**Make and keep Shelf Books:**

```
library shelf new <slug> --title "<title>" --summary "<one line>"      # a new curated Book
library book add-page <slug> <page> --content-path <file>             # add a page; the Book open
library shelf rename | remove | archive | restore                      # each previews first
library shelf rebuild [<slug>]                                         # Discovery manifest from disk
```

A page corrected in place on the Shelf leaves its Discovery manifest behind. Discovery then lists the Book in
`books_stale` and still searches it; `library shelf rebuild <slug>` brings the manifest up to date.

**Making a Book Shelf-only:** `shelf recall <slug>`, then `shared archive <slug> --kind book`. The recall copies the
collection Book to the Shelf; the archive then retires the collection copy. The archive previews first, and applies
only with `--user-confirmed --plan-id <id>`, the id its preflight issued; a Book changed since that preview is refused.

### When two Books cover the same thing

Books converted from separate sources can overlap. Which copy is current is recorded per *topic*,
not per Book, because one Book is often canonical for one subject and superseded for another.
`library shelf duplicates` finds candidate overlaps read-only. A high score is a lead, not a
verdict, and it never licenses an answer about what either copy says. `library shelf stub` replaces
a superseded page with a pointer to its canonical copy, after a preview and an approval. See
`docs/duplicate-topic-resolution.md`.

### Keeping a Book current with its source

The Currency check ("is this Book behind its upstream?"), fetching a git URL into `raw/`, and
rebuilding a Notebook source from a published Book are **not in the `deskpost` program**, and an
installed Deskpost does not ship them: they are helpers in the Deskpost source checkout
(`Get-BookCurrency`, `Sync-RawUpstream` and `Restore-BookSource`). A **Currency check is not a Source check** in any case: a matching pin
proves the source has not moved, and never that an article reflects it.

**A Shelf Book's Summary lives in `_catalog-entry.md`**, not in `_book.md`'s Purpose, which only `shelf new` and
`shelf recall` set alongside it. To change the Summary, edit `_catalog-entry.md`, then run `deskpost shelf render`
(it takes no Book name: it rebuilds `shelf/_catalog.md` from every Book's entry, and is safe to rerun) and
`deskpost shelf rebuild <slug>`. Run `shelf render` after any `_catalog-entry.md` edit. `shelf rebuild` alone
rewrites only the manifest, and an edit to the entry does not mark the Book stale.

## Project Hubs

A Project Hub is orientation for ongoing work, not a second task system. It holds Purpose, Now,
Next, connected knowledge and connected tools.

`Now` is orientation and **open items only**: where the work stands, and anything still unproven,
undecided or unfixed. An entry leaves when it closes. What *happened* in a session belongs on a
dated history page, never in `Now`. That split is why there is no length rule to remember. Reasoning:
`docs/project-hub-design.md`.

```
read_project_catalog        { shelf: "active" | "archive" }
suggest_active_projects     { query }
read_open_project_page      { slug, page, section? }     # e.g. section "Now"; answers with sha256
read_open_project_briefing  { slug }
```

`suggest_active_projects` ranks Hubs against the reader's own words and never opens one. Present the
matches and ask which to open. After opening a Hub, call `read_open_project_briefing`. It names
recorded Books and tools but never opens them automatically.

```
library hub new <slug> --title "<t>" [--purpose "<p>"] [--next-action "<a>"] [--dev] [--preflight]
library desk open project <slug>
library hub edit <slug> --mode <mode> ...
```

`hub new` needs no seat, and a seat can only be created for a Hub that exists and is active.

**Linking a Hub page to a Book.** A collection Book's page is `[[books/<slug>/wiki/<page>|label]]`, and a Shelf
Book's is `[[shelf/<slug>/wiki/<page>|label]]`. A Book that changes often is best kept on the Shelf and linked
there, because its pages are corrected in place with no yes (`book replace-page`); changing an existing page of a
collection Book is `collection replace-page`, which takes a yes.

### A Hub for development work

`--dev` seeds two extra sections. They are **optional and specific to development**: a Hub created
without `--dev` is unchanged, and existing Hubs are never migrated automatically.

- **`## Repo`** binds the Hub to a working tree: the checkout, the remote, the branch, the command
  that must pass, and a **pointer to that tree's own `AGENTS.md`** rather than a copy of it. The
  remote placeholder asks for a *sanitized remote URL, with no credentials or userinfo*, because
  nothing checks what gets typed into a Hub.
- **`## Decisions`** holds one-line pointers to settled ground. A decision is not a task and never
  "closes", so it does not belong in `Next`.

`--dev` seeds **placeholder prose, not values**. `--dev --preflight` shows the exact sections it
would write without creating anything, which is worth using because nothing deletes a Project Hub
once it exists. To add these sections to an existing Hub, use `hub edit --mode add-section`.

**Two seats on one dev Hub.** A dev Hub on a local collection can run the dev session loop: a build
seat works long sessions from a Kickoff, `kickoffs/sNN` on its Hub, and a support seat triages and
writes the Kickoffs. The build seat shows the Kickoff's title, revision, content hash and CHARTER
and takes one yes; that yes is the reader's explicit request for the commits and the private push
the CHARTER names, for that page at that hash only. It never covers a public push, a tag, a release
or anything destructive, and each previewed action still takes its own approval. The loop is
`docs/dev-session-loop.md` in the program repository.

**Where a decision itself is written** follows its subject. If the subject has a repository you
control, the decision goes in *that repository's* `docs/adr/`. Otherwise it goes on the Hub. Either
way the Hub carries only the pointer, and pointers are **operative only**. Reasoning:
`docs/adr/0003-decisions-follow-their-subject.md`.

`hub edit` has **seven** modes. `add-section`, `append-section` and `check-item` apply directly and
are checked so they cannot lose text. `replace-item`, `replace-section`, `remove-section` and
`replace-body` need a `--preflight` plan id and one clear approval (`--user-confirmed --plan-id`).
There is no remove-item mode. An archived Hub is read-only, and those seven edit only pages that
already **exist**. On a local collection an eighth, `--mode new-page --page <path> --content-path <f>`,
makes a page that does not exist -- the dated `notes/` page history belongs on -- and never replaces one;
on Basic Memory a new page goes through `deskpost hub copy-pages`. `hub archive` and
`hub copy-pages` work against a shared collection only.

**Renaming a Hub** in this Library's own collection is `library hub rename <old> <new> --title "<t>"`: preview with
`--preflight`, show the reader what it reports, then `--user-confirmed --plan-id <id>` after one clear yes. It
copies the Hub forward under the new name (rewriting only each page's `permalink` and the root's title), replaces its
catalog line, re-points every free seat's Desk, and archives the old Hub **unchanged** under its old name, so its
history keeps the words it was written in. Pages elsewhere that mention the old name are listed, never edited, and so
are the new Hub's own current pages that still name the old slug or title (`mentions_in_new_hub`), for `hub edit`;
its `notes/` are history and are not listed. It
refuses while a seat is bound to the old Hub, or while a session holds a seat that has it open.

### Editing a Hub page: habits that hold

- **Text comes from a file** written as UTF-8 with LF line endings (`--content-path`). A script that builds Hub text
  stays plain ASCII: Windows PowerShell 5.1 reads a `.ps1` without a byte-order mark as ANSI, so an em dash in it
  arrives as `â€”`. Python on Windows writes CRLF in text mode unless told `newline='\n'`.
- **One edit at a time.** Every edit changes the page's hash, so preview and apply one before planning the next.
- **What `replace-item` replaces:** on a paragraph line, that one line; on a list item, the item with its nested
  sub-items. `check-item` ticks the item's first line only.
- **`## Now` takes checkboxes or paragraphs.** A list entry at column zero without `- [ ]` or `- [x]` is refused.
- **Removing text needs the reader's yes** (`--user-confirmed`). To change the state of an item without one, append a
  new item that says it updates the one above.
- **Preview an append to `## Decisions` with `--preflight`**: it reports `entry_size_warning` from the proposed text
  before anything is written, where an apply without it only warns afterwards.
- **Never filter `hub edit`'s output** through `grep`, `head` or a redirect: tools read its size warnings
  (`page_size_warning`, `section_size_warning`, `entry_size_warning`) from the whole result.
- **Read the page back through the validated reader.** For a page too large for one read, `library mcp call
  read_open_project_page --slug <s> --page <p>` prints the reader's answer, which a script can compare with the
  content file.

## Why "closed" matters

Closed means unreadable, by different mechanisms in each place:

- A closed **shared** Book's bytes are not on this disk, and the validated reader refuses it.
- A closed **Shelf** Book is on this disk, so the Library's hooks deny `Read`, `Grep`, `Glob` and
  shell commands that name it.

The guard is enforced against every route that names a Book, and advisory against broad searches.
The Desk is a control for directing attention, not a security boundary. Say plainly that a Book is
closed and offer to open it. Never work around the guard.
