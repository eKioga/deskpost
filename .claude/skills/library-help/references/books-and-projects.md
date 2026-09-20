# Books, the Shelf, and Project Hubs

## First: a Book opens onto a seat's Desk

There is no default seat, so "open the X Book" has a precondition. **Opening and closing are
changes** and need the live claim that `tools/Start-LibrarySeat.ps1` or `tools/Enter-LibrarySeat.ps1`
holds; they act on **this seat's** Desk and no other's. A session holding no seat is refused, and
the refusal names the fix — pass it on rather than working around it.

**Browsing and listing are reads and need none of that.** Both catalogs,
`Set-VirtualDesk -Action List` and every validated-reader tool work at any seat or none. So
"which Books are there?" is always answerable; "open one" is not. The contract is in
[Seats](../../../../docs/seats.md).

## Books

A Book is curated reference material. Books live in one of two collections, and behave identically:

- the **shared collection** — NAS-backed, `books/<slug>`;
- the **local Shelf** — this machine only, `shelf/<slug>`.

Where a Book lives is a property the reader may ask about, not a rule they have to learn.

**Browse both:**

```
mcp__validated-book-reader__read_book_catalog
```

Pass `location: "shared"` or `location: "shelf"` for one alone. Browsing is not reading a Book, so
the catalogs stay available while every Book is closed.

**Open and close:**

```powershell
tools/Set-VirtualDesk.ps1 -Action Open  -Slug <slug>                   # shared, active
tools/Set-VirtualDesk.ps1 -Action Open  -Shelf Archive -Slug <slug>    # shared, archived
tools/Set-VirtualDesk.ps1 -Action Open  -Location Shelf -Slug <slug>   # local Shelf
tools/Set-VirtualDesk.ps1 -Action Close -Location Shelf -Slug <slug>
tools/Set-VirtualDesk.ps1 -Action Clear                                # clears the whole Desk
tools/Set-VirtualDesk.ps1 -Action List
```

Opening a Shelf slug with no `shelf/<slug>/wiki/` directory is refused, so the Desk can never list a
Book that does not exist.

**An archived shared Book can be opened and read**, with `-Shelf Archive`. Archiving retires a Book
from the active collection; it does not put it beyond reach. The archived copy is a *separate Book
root* from the active one, so opening `archive/<slug>` never opens `books/<slug>` -- a slug that
exists in both places must be named with the shelf you mean. The local Shelf has no archive, so
`-Location Shelf -Shelf Archive` is refused rather than quietly ignored.

**An archived Book is discoverable, and says so.** Both limits this section used to carry are gone:
`read_book_catalog` with `location: archive` lists the shared archive (2026-09-03), and
`discover_book_pages` covers both archives and labels every archived hit `ARCHIVED` -- the Shelf
archive since 2026-09-06 and the shared one since 2026-09-08. Every Discovery answer states which
archives it actually searched, and names
`tools/Update-SharedBookManifests.ps1 -IncludeArchive` if the shared archive has no manifests yet;
read that sentence rather than assuming coverage. `search_open_books` still reaches an archived Book
only while it is open on the Desk, because full text reads open Books and nothing else.

**Read a page:**

```
mcp__validated-book-reader__read_open_book_page   { slug, page }
```

`page` is the canonical path below `wiki/`, without `.md` — for example `_index` or
`working-practices/Check Design`. Start with `_index` (the reader map) or `_book` (metadata and
limits).

Do not read `shelf/<slug>/wiki/` with `Read` or `Grep`, and do not reach for Basic Memory content
readers or search for ordinary reader requests.

### When two Books cover the same thing

Several Shelf Books overlap, because they were converted from separate wiki workspaces. Which copy is
current is recorded per *topic*, not per Book — one Book is routinely canonical for one subject and
superseded for another. Read or add records with `tools/Set-TopicOverlap.ps1`:

```
tools/Set-TopicOverlap.ps1 -Action List -Slug <slug>
tools/Set-TopicOverlap.ps1 -Action Add -Topic <topic> -Slug <slug> -Counterpart <slug> -Relationship unverified
```

`unverified` is the honest state for an overlap nobody has read both sides of, and it is what a
similarity lead is worth. A record is the reader's judgment written down — it never licenses an
answer about what either copy says. Merging or stubbing is a separate, page-by-page operation; see
`docs/duplicate-topic-resolution.md`.

### Compiling a Book from a git URL, and asking whether it is behind

A GitHub URL is an ordinary source. Fetch it into a **new** `raw/` batch, then compile as usual:

```powershell
tools/Sync-RawUpstream.ps1 -Url https://github.com/<owner>/<repo> -Batch <batch> -IncludePattern 'docs/**/*.md'
```

`-Include` takes directories (cone mode); `-IncludePattern` takes gitignore-style globs. The fetch is
thin — depth 1, blobless, sparse — and **create-only**: it refuses a batch name that already exists,
because moving a checkout in place would invalidate every source hash already cited from it. Newer
material is a new batch. It declares no owner; run `tools/Set-RawBatchOwner.ps1` afterwards.

Each compiled article then records the commit it was built from, as an `Upstream` line in its
`## Sources` block. A batch that is not a git checkout simply gets no pin and compiles as before.

**Is this Book still current?**

```powershell
tools/Get-BookCurrency.ps1 -Book <slug>      # one Book, precisely: names the cited files that changed
tools/Get-BookCurrency.ps1 -All              # every catalogued Book, in both collections
tools/Get-BookCurrency.ps1 -All -ShelfOnly   # the same, without contacting the shared Catalog
```

Both write nothing. `-Book` reads `notebook/<slug>/` when it exists, otherwise an **open** Shelf
Book's pages, and can say `refresh due` and name the changed files. `-All` reads the Discovery
manifests instead, so it can cover closed Books — but it holds no cited paths, so a moved upstream
gets `upstream advanced — article inspection required` and points back at `-Book`.

A **Currency check is not a Source check.** A Source check asks *are this Book's claims true?*; this
asks *has its source moved?*. A matching pin proves the source has not moved — it never proves an
article reflects it, so no answer from this may be worded as verifying a Book. A Book whose upstream
is unreachable is **unverified, not defective**.

Two answers that look like problems and are not. `not anchored` means the Book was compiled before
the pin existed, or from something that is not a git checkout; it gains an anchor on its next
Refresh. `manifest lacks anchor data` means the Book's Discovery manifest predates the roll-up — a
plain backfill will report it already current, so run `tools/Update-BookManifests.ps1 -Rebuild` (or
`tools/Update-SharedBookManifests.ps1 -Rebuild` for a shared Book).

**If the Notebook source is gone.** A Refresh and the `-Book` check both read `notebook/<slug>/`, and
a Notebook Reset clears it. Rebuild it from the published Book:

```powershell
tools/Restore-BookSource.ps1 -Book <slug> -Preflight
tools/Restore-BookSource.ps1 -Book <slug>
```

The Book must be **open on the Desk**, because restoring reads its pages. It is create-only: it
refuses any existing `notebook/<slug>`, empty or not, rather than replacing working knowledge. It
rebuilds against the Book's own publication journal and verifies every page against the SHA-256
recorded there, so a single mismatch aborts with nothing written. It does not touch the Notebook's
master index; the result says whether the topic is linked there.

Restoring needs the local publication journal, so a Book published from another machine cannot be
restored this way — that is reported by name rather than guessed at.

## Project Hubs

A Project Hub is orientation for ongoing work, not a second task system. It holds Purpose, Now,
Next, connected knowledge, and connected tools.

`Now` is orientation and **open items only** — where the work stands, and anything still unproven,
undecided, or unfixed. An entry leaves when it closes. What *happened* in a session goes to a dated
`notes/` history page on the same Hub, which is append-only and has no size limit, because nothing
orients from it. That split is why there is no length rule to remember: `Now` never grows.
`Edit-ProjectHub.ps1` returns an `advice` note when an append to `Now` looks like a dated log entry
— a reminder, not a refusal, since an open item may legitimately carry a date. Reasoning:
`docs/project-hub-design.md`.

```
mcp__validated-book-reader__read_project_catalog        { shelf: "active" | "archive" }
mcp__validated-book-reader__suggest_active_projects     { query }
mcp__validated-book-reader__read_open_project_page      { slug, page }
mcp__validated-book-reader__read_open_project_briefing  { slug }
```

`suggest_active_projects` ranks Hubs against the reader's own words and never opens one — present
the matches and ask which to open.

```powershell
tools/Set-VirtualDesk.ps1 -Action Open -Kind Project -Shelf Active -Slug <slug>
tools/New-ProjectHub.ps1        # a new Hub: slug, title, purpose, short next list
tools/New-ProjectHub.ps1 -Dev   # the same, plus Repo and Decisions for development work
tools/Edit-ProjectHub.ps1       # fill in or update an open Hub's prose
```

### A Hub for development work

`-Dev` seeds two extra sections. They are **optional and specific to development** — a Hub created
without `-Dev` is unchanged, and existing Hubs are never migrated automatically.

- **`## Repo`** binds the Hub to a working tree: the checkout, the remote, the branch, the command
  that must pass, and a **pointer to that tree's own `AGENTS.md`** rather than a copy of it. The
  remote placeholder says *sanitized remote URL — no credentials or userinfo*, because a Hub lives on
  the NAS and nothing checks what gets typed into it.
- **`## Decisions`** holds one-line pointers to settled ground — things that are decided and should
  not be re-opened. A decision is not a task and never "closes", so it does not belong in `Next`.

`-Dev` seeds **placeholder prose, not values**; it asks for the working tree rather than guessing
one. `-Dev -Preflight` shows the exact sections and byte count it would write without creating
anything — worth using, because nothing in the Library deletes a Project Hub once it exists.

**Where a decision itself is written** follows its subject: if the subject has a repository you
control, the decision goes in *that repository's* `docs/adr/`; if it does not, it goes on the Hub's
own `decisions/` page -- created by copying a page authored in the Notebook first, with
`tools/Copy-LocalPagesToProject.ps1 -DestinationDirectory decisions` (one preflight, one
approval). Either way the Hub carries only the pointer. Pointers are **operative only** —
remove one when its decision is superseded and let the record it names carry that history, or the
section becomes the append-only log `Now` was split to avoid. Reasoning: `docs/adr/0003-decisions-follow-their-subject.md`.

To add these sections to a Hub that already exists, use `Edit-ProjectHub.ps1` — `-Dev` only affects
creation.

After opening a Hub, call `read_open_project_briefing`. It names recorded Books and tools but never
opens dependencies automatically.

`Edit-ProjectHub.ps1` has **seven** modes. `AddSection`, `AppendSection`, and `CheckItem` apply
directly and are checked so they cannot lose text. `ReplaceItem`, `ReplaceSection`,
`RemoveSection` and `ReplaceBody` need a preflight `plan_id` and one clear approval. There is **no
remove-item mode**, so retiring one closed checklist entry costs a whole `ReplaceSection`. An
archived Hub is read-only, and `Edit-ProjectHub.ps1` edits only pages that already **exist** --
creating one is `Copy-LocalPagesToProject.ps1`, below.

## Why "closed" matters

Closed means unreadable, by different mechanisms in each collection:

- A closed **shared** Book's bytes are on the NAS and never on this disk.
- A closed **Shelf** Book is on this disk, so `.claude/hooks/Guard-ShelfBookRead.ps1` denies `Read`,
  `Grep`, and `Glob` that name it.

The guard is enforced against every route that names a Book, and advisory against broad searches and
shell commands — the Desk is a control for directing attention, not a security boundary. Say plainly
that a Book is closed and offer to open it. Never work around the guard.
