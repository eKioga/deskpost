# A root plan file names the project that owns it

More than one project is developed inside this checkout, and the repository root is a shared
namespace. `PLAN.md` is the filename every plan-authoring skill defaults to — `claudex-loop`,
`codex-review`, `grill-with-docs-codex` all write there unless told otherwise — so the root's generic
names belong to whichever project wrote them last.

Every plan file at the root now declares its owning Project Hub on its own line under the heading,
and `workspace.plans-declare-their-owner` fails the gate without it. The unqualified `PLAN.md` and
`PLAN-REVIEW-LOG.md` are reserved for this workspace; a plan whose subject is anything else must be
namespaced.

## Status

accepted — 2026-09-01, shipped as `cb9bcd7`.

## Considered options

**Trust the convention.** This was the status quo, and it had already failed twice. The convention
genuinely existed — two earlier sessions namespaced their plans by hand, and
`PLAN-REVIEW-LOG-token-efficiency.md` states it in its own third line — but a convention nothing
enforces lasts exactly until it is inconvenient, and the third project ignored it.

**Extend `docs.links-resolve` instead.** Rejected because it structurally cannot help. That check
passes whenever the target file exists, and every citation here resolved perfectly the whole time
the content behind it belonged to a different product. A link check validates paths; a citation
depends on ownership. They are different questions and only one of them was being asked.

**Move the other project out of the repository.** Still available and still reasonable, but it fixes
one instance rather than the class, and it is the reader's call rather than a structural guard. The
ownership rule holds whether or not any given project stays.

**Reserve no names — namespace everything, including the Library's own plan.** Rejected as a worse
trade. It would have required rewriting roughly nineteen citations across `docs/` and `tools/` for no
gain: this is the Library's repository, so the unqualified name legitimately belongs to it, and the
rule only has to say so.

## Consequences

Each root plan carries `> **Owner:** <project-hub-slug>`. The owner is a Project Hub slug for the
same reason raw-batch ownership records use one — the Library already had "declare who owns this" as
a proven pattern, applied to `raw/` and never to the root.

Six mutations prove the check: the 2026-09-01 takeover replayed verbatim, a marker claiming another
owner, the owner line deleted, an unowned new plan appearing, a case-smuggled slug, and a marker
inline in prose that must not count.

**What this does not cover, deliberately.** The check is scoped to root plan files, because that is
the vector that actually caused harm. `tools/` is a shared namespace too — Librarian 2.0's
consistency checker was sitting in it — and that was resolved by moving the file to
`tools/librarian-2/` rather than by a guard. If a second non-Library tool lands there, the honest
choice is to extend this check rather than repeat the manual fix.

**Note the asymmetry, because it inverts the intuition.** The shared collection is *not* the vector.
Books and Project Hubs are namespaced by slug and cannot collide; the Hub for the intruding project
was well-behaved throughout. Hardening the shared collection would have prevented nothing. Only the
local repository root was unprotected, which is the opposite of where a "shared collection infecting
the Library" framing would look.

**What was nearly lost.** Librarian 2.0's plan was found in the working tree on top of the Library's
own committed 922-line plan, reduced to 113 lines and uncommitted. Roughly nineteen sources cite
`PLAN.md` **by item number** — "PLAN.md 0.7", "2.2", "item 0.1", "3.1" — and
`Rename-ShelfBook.ps1` rewrites into it as a Library self-file beside `CLAUDE.md` and `CONTEXT.md`.
The repository was clean, so nothing was lost; one `git add -A` would have made every one of those
citations point at a different product. The session that found it had itself excluded `PLAN.md` from a
commit by name an hour earlier, and only because recon happened to read the file and notice the title.
