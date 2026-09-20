# Shelf and Catalog Symmetry

> **Status:** implemented 2026-08-16. Shelf Books now open, close, and read exactly as shared Books
> do. This record covers the reader benefit, the safety boundary, and the acceptance evidence.

## The defect

Before this change, `.open-books` held bare slugs and the validated reader mapped every one of them
to `books/<slug>/wiki/` on the NAS. No code path reached the local Shelf. A Shelf Book therefore
could not be opened, could not be closed, and stayed readable regardless of Desk state — the
Librarian simply read `shelf/<slug>/wiki/*.md` with the `Read` tool.

Half the collection had a control surface and half did not. A reader asking "are these Books open?"
was asking a question that had no meaning for the Shelf, and a reader who assumed closed Books were
unavailable was wrong in a way nothing disclosed.

## Reader benefit

One model for the whole collection. **Open** means the Book's pages are available to the Librarian;
**closed** means they are not; the reader controls which. Where a Book physically lives is a
property the reader may ask about, not a rule they have to learn.

## Safety boundary

Closed means unreadable in both collections, by different mechanisms:

- A closed **shared** Book is unreadable because the file is on the NAS and never on this disk. The
  reader's closed-check is a second lock on a door already across the network.
- A closed **Shelf** Book is on this disk, so `.claude/hooks/Guard-ShelfBookRead.ps1` stands in for
  that distance. It denies `Read` and `Grep` under `shelf/<slug>/` unless that Book is open, and
  fails closed on any state error. It does **not** achieve the same guarantee — see the measured
  boundary below.

`shelf/_catalog.md` stays readable while every Book is closed, exactly as the shared Book Catalog
does. Browsing the collection is not reading a Book.

Shelf reads keep the same four guarantees the NAS reader enforces: closed Books rejected, path
traversal rejected, exact canonical path verified, empty content rejected. Because Windows compares
paths case-insensitively, the exact-path check walks the path segment by segment and requires an
ordinal match on each — the local equivalent of the NAS reader's `-cne` file-path comparison.

### What the guard actually covers, measured

The first version of this record claimed a single narrow gap — an untargeted `Grep`. That was
written from reading the hook, not from testing it, and it understated the boundary. Measured
2026-08-16 against the closed `odysseus` Shelf Book:

| Route | Before | After | Leaks now |
| --- | --- | --- | --- |
| `Read` on a closed Shelf page | denied | denied | — |
| `Grep` with `path` inside a closed Book | denied | denied | — |
| `Grep` with `glob` `shelf/**/*.md` | allowed | **denied** | — |
| `Glob` on `shelf/<slug>/**`, closed | allowed | **denied** | — |
| `Glob` on `shelf/**`, spanning closed Books | allowed | **denied** | — |
| `Grep` with no `path` at all | allowed | allowed | page content |
| `Grep` with `path` set to the workspace root | allowed | allowed | page content |
| `PowerShell` running `Get-Content` | allowed | allowed | page content |
| `Bash` running `head` | allowed | allowed | page content |

The structured cases were closed on 2026-08-16 by inspecting `Grep`'s `glob` field and `Glob`'s
`pattern` directly, rather than only the resolved `path`. A pattern aimed into `shelf/` is
deliberate targeting, so denying it costs nothing in ordinary work; patterns naming an *open* Book,
or no Book at all, still pass.

What remains open is one policy decision and one structural limit, not an oversight:

- **Broad searches are not blocked.** A `Grep` with no `path`, or one rooted at the workspace, can
  still surface a line from a closed Shelf page. Denying those would break ordinary work across the
  whole Library to close a partial gap. Deliberately not done.
- **Shell tools are not intercepted.** `Bash` and `PowerShell` carry freeform command strings, and
  matching them would mean pattern-matching shell text that `cd`, quoting, variables, and pipelines
  all defeat. Adding them would buy the appearance of a guarantee rather than the guarantee.

### The honest ceiling

A `PreToolUse` text matcher cannot make a local file unreadable to an agent that can execute shells.
Extending the matcher to `Glob`, `Bash`, and `PowerShell` and inspecting command strings raises the
cost of the obvious routes, but quoting, variables, `cd`, and pipelines all defeat string matching.
Such a guard is a speed bump, not a wall, and this record should not imply otherwise.

Closed means genuinely unreadable in the shared collection because the bytes are on the NAS and
never on this disk. The only change that would buy the Shelf the same property is to put its bytes
somewhere the agent's tools cannot reach — outside the workspace root, with the validated reader
process fetching them on the reader's behalf. That was considered and rejected on 2026-08-16 as
disproportionate: it would relocate the whole Shelf, touch the reader, the import tool, the catalog,
and every doc naming `shelf/`, to harden material that already lives on the reader's own machine.

So the standing position is deliberate, not aspirational. **Shelf "closed" is enforced against
every route that names a Book, and advisory against broad searches and shell commands.** The Desk
is a control for directing attention, not a security boundary against the Librarian. Anyone
extending this guard should keep that distinction in the record rather than quietly implying the
stronger one.

## State format

An open Book is recorded as its collection root:

- `books/<slug>` — shared collection
- `shelf/<slug>` — local Shelf
- a bare `<slug>` — pre-symmetry format, still read as a shared Book

This mirrors the `projects/<slug>` form `.open-projects` already used. Migration is silent and
happens on the next Desk write.

## Acceptance evidence

`Validated-BookReader.ps1 -ShelfSelfTest` runs the Shelf half offline, without the NAS reachable,
and passed on 2026-08-16 with: exact catalog path, exact page path, exact space-named page path, and
rejection of a missing page, a closed Book, a traversal attempt, a wrong-case page name, and an
empty page. `-SelfTest` runs the Shelf suite followed by the original shared suite.

Guard decisions were verified directly: a closed Shelf Book denied, `shelf/_catalog.md` allowed, a
Notebook file allowed, a `Grep` into a closed Shelf Book denied, and a path escaping `shelf/` allowed
because it resolves outside the Shelf. After opening one Shelf Book, that Book was allowed while a
second, still-closed Book remained denied — confirming per-Book granularity rather than a blanket
directory rule.

Opening a Shelf slug with no `shelf/<slug>/wiki/` directory is refused at open time, so the Desk
cannot list a Book that does not exist.

### Three ordinary reader requests

1. **"What is on my desk?"** — `Get-DeskOverview.ps1` reported each open Book with its slug,
   location, and root, alongside open Projects and the Notebook inventory.
2. **"Open the library-dev Book."** — opened with `-Location Shelf`; the guard flipped that Book
   from denied to allowed while `2nd-b` stayed denied.
3. **"Read its working-practices index."** — served through
   `mcp__validated-book-reader__read_open_book_page`, returning the exact page.

## Related repair

`.claude/settings.local.json` was invalid JSON (a doubled comma in the permissions array), so the
whole file — the permission allowlist, the `Guard-BasicMemoryRead` safety hook, and the
`Get-VirtualDeskContext` prompt hook — was silently not loading. Repaired in the same change. The
desk-context hook is what tells the Librarian at each prompt which Books are open; while it was
dead, that state had to be fetched by hand.
