# Decisions follow their subject; the Library owns orientation

Development work in the Library produces two things it has nowhere to put: a binding to the working
tree being worked in, and decisions that are settled and must not be re-opened. Both currently live
as prose paragraphs inside a Project Hub's `Now` and `Next` — the page read at the start of every
session — where a settled decision competes for attention with genuinely open actions and never
leaves, because a decision does not close the way a task does. The Library Development Hub carries
at least four such entries, each ending in some form of "do not re-open this unprompted", which is
an architecture decision record's status field written as prose.

The governing rule is that **code is the source of truth for what it does**, and **a decision lives
with its subject**. The Library owns orientation: it is where you find out that a decision exists
and where it is recorded, not necessarily where the decision itself is kept.

Concretely: if a subject has a repository you control, its decisions belong in **that repository's**
`docs/adr/` — which is this repository's `docs/adr/` only when the subject is the Library itself. If
it does not, they belong in its Project Hub's `decisions/` page on the shared collection. Either
way, the Hub carries a one-line pointer, so orientation is identical regardless of which side the
pointer resolves into.

On Books, the claim is deliberately narrow: **a Book is not authoritative for implementation facts
that are available in live code.** This does not say a Book compiled from a versioned source should
not exist. `books/ignis`, `books/2nd-b-vault`, `books/deepseek-harness` and their peers are
legitimate and valuable — they carry synthesis that no single file contains, which is exactly what
reading the source cannot cheaply produce. What they are not is the place to answer "what does this
function do today".

## Status

accepted — 2026-08-31

## Considered options

**A compiled Book of the codebase, refreshed more often.** This is the status quo, and refreshing
harder does not fix it. Every codebase Book is a point-in-time copy that reads as verified long
after its source has moved on, and the cost of a refresh is a compile session, so the interval will
always be longer than the rate of change. The wider industry moved the same way for the same reason:
agentic search over live files replaced pre-built indexes because freshness and precision beat
recall against a stale index, and the maintenance burden was not worth carrying.

**A code index or embedding store over the repositories.** Rejected. The retrieval the Library
already has — scoped raw search, `discover_book_pages`, and ordinary file reading — is the shape
that works, and an index is another artifact that goes out of date. If symbol-level navigation is
ever wanted, an existing LSP-backed tool is the thing to adopt rather than build.

**A `Kind: dev` Book, or a dev Project type.** Rejected together, for the same reason. `Kind:`
currently gates real behavior — `Add-ShelfNote.ps1` refuses any Book not marked `capture`, and that
refusal is what keeps raw material out of curated Books. A `dev` value would gate nothing, and an
inert label drifts away from what it claims. The same argument applies to a stored marker on a
Project: the presence of a `## Repo` section is self-describing, and a stored kind would only
duplicate what the section already says.

**Keeping all decisions in this repository's `docs/adr/`.** Rejected because it fails its second
customer. A decision about the 2nd_b vault's schema cannot sensibly live in the Library's
repository, and any rule that assumes one repository breaks the first time a Project is about
something else.

**Keeping all decisions in Hub `decisions/` pages.** Rejected because it strips `git blame`,
version history, and code-search discoverability from decisions that belong beside the code they
describe, and would require migrating ADR-0001 and ADR-0002 off a surface that works.

## Consequences

A Project Hub for development work gains two optional sections: `## Repo`, binding it to a working
tree, and `## Decisions`, holding one-line pointers. `New-ProjectHub.ps1 -Dev` seeds both as
placeholder prose. Neither is part of every Project Hub's required shape — Hubs without them stay
valid and are not migrated.

`## Decisions` holds **operative pointers only**. A pointer is replaced or removed when its decision
is superseded or reversed, and the history stays in the ADR or `decisions/` page, which is where a
decision's own record of being overturned belongs. Without that rule the section would reproduce
exactly the unbounded append-only growth being removed from `Now`.

The disambiguating test — *does the subject have a repository you control?* — has a genuine
ambiguous middle: a decision about how the Library *reads* an external subject concerns an external
thing but is implemented in this repository. That will be refined from real use rather than
pre-specified.

Nothing here is enforced. The dev template is an unenforced creation convenience, and the
operative-pointers rule is a discipline carried by seed wording. Enforcement was considered and
declined: this repository's existing structural validator inspects only column-zero list entries, so
two current Hubs cannot trip it at all, and a new whole-collection invariant is the shape of change
that has previously bricked a surface until legacy data was migrated. What is gated is only what the
template produces, never any Hub's content.

Currency anchoring — letting a Book declare the source version it was compiled from and report when
a Refresh is due — was designed alongside this and deliberately deferred. Its design is preserved in
`docs/book-currency-anchoring-deferred.md`. It is not a rejected idea; it is a larger piece of work
whose value arrives only after the Books that would carry it exist.

## The `decisions/` branch was unimplemented for eight days (2026-09-08)

This ADR specified `decisions/NNNN-slug.md` on 2026-08-31 and **nothing in `tools/` could create
that page** until 2026-09-08. `Edit-ProjectHub.ps1` refuses a page that does not exist,
`New-ProjectHub.ps1` seeds a Hub rather than a page, `Copy-LocalPagesToProject.ps1` reached only
`notes/**` or one file beside `_project`, and a Claude session has no direct Basic Memory write
tool at all. The gap went unnoticed because the only project using the tooling is this repository,
which *has* a repository and therefore takes the other branch of the test above.

Closed by a `-DestinationDirectory` parameter on the existing copy helper rather than a new one:
that helper already carries the shared-write apparatus the shape needs, and a second
implementation of a shared-write path is the drift class this codebase keeps paying for. **The
lesson is about specification, not tooling** -- a documented shape whose only user takes the other
branch can sit unbuilt indefinitely, and reads as supported the whole time. When a rule picks
between two destinations, exercise the one nothing is using before calling it implemented.
