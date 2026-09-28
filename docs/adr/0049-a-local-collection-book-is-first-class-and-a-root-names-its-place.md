# ADR-0049: A Local collection Book is first-class, and a Book root names its place

**Status:** accepted
**Date:** 2026-09-26
**Effective from:** 1.1 (S52, `PLAN-basic-memory.md` step 1, ruling B0)
**Relates to:** [ADR-0030](0030-a-collection-has-one-layout-and-two-backends.md) (one layout, two backends),
[ADR-0044](0044-basic-memory-is-optional-and-the-public-install-is-local.md) (the local default)

## Context

ADR-0044 made a Library with no Basic Memory endpoint the default route, and the Local collection
(`collection/`) its durable home. The S51 new-user run of 1.0 found that the Local collection held Project Hubs
and nothing else a reader could act on:

- **F19: a Book could not be published into it.** Every publish, refresh and archive reached for a Basic Memory
  endpoint, the ownership fence and a Basic Memory collection id before it did anything else (`publish.ts`). So a
  local Library's Shelf Book had no durable collection to reach.
- **F20: a Book in it could not be found.** Discovery answered from four manifest stores (the Shelf and the
  shared collection, each with its archive), and none was the Local collection's. A Book there, imported or copied
  in, was invisible to every search that did not already know its slug.

The import of Eric's 24 Books into a local Library (the plan's migration route) is worth nothing until both are
fixed, which is why the plan puts this first.

## Decision

**A Local collection Book is first-class: it is published, refreshed, archived, discovered and searched like any
other.**

- **Local is the only publish target in 1.1.** On a local Library `library publish`, `publish refresh`,
  `publish batch` and `shared archive` are plain file writers into `collection/`. They open no MCP session and
  meet neither the fence nor a Basic Memory collection id, and **a Basic Memory connection changes none of that**,
  because nothing is written to Basic Memory in 1.1. They keep the shared publisher's contract: a preview bound to
  a `plan_id`; the root `copying`, then every page written and read back, then `complete`, with its frontmatter
  keys in their fixed order; the journal in `internal/publication-journals/`; and the locks on `books/<slug>` and
  `collection/books`, which an import also takes.
- **A catalog heading is inserted on demand.** A fresh local Books catalog carries `## Open a Book`, and only that.
  `## Reference`, `## Archived Books` and the rest are added the first time a line needs them, and a missing
  archive catalog is created.
- **Discovery has a `collection` / `collection-archive` pair**, built by the kernel from what is on disk, not from
  the catalogs, in the Shelf's manifest format. Every write to a collection Book commits its manifest inside the
  same locked window. `library collection rebuild` is the repair, and Discovery names it for any Book it cannot
  read. The coverage sentence names the Local collection whenever the collection holds a Book.
- **Full text searches an open collection Book**, because its pages are on this disk. Only a Book reached over the
  network is named rather than searched.

**A Book root names its place, and the grammar is said once.** `kernel/src/places.ts` holds the six root forms and
the three places the glossary names:

| Form | Place |
|---|---|
| `shelf/<slug>`, `shelf/_archive/<slug>` | the Shelf |
| `books/<slug>`, `archive/<slug>` | the Library's own collection: the Local collection on a local Library, Basic Memory on a workspace attached to it |
| `shared/<slug>`, `shared/archive/<slug>` | a local Library's Basic Memory **connection** (ADR-0050) |

- **Nothing existing changes meaning.** `books/<slug>` already was a local Library's collection form, so no Desk
  needs migrating, and `shared/` is only added. The six copies of the old grammar (the reader, the Desk, the guards,
  full text, Discovery and the mutation window) all read this one.
- **A Book is labelled by its place, never by its prefix.** On a local Library, a Discovery hit, a Desk overview
  row and the prompt's Desk line call a `books/` Book `collection`, where 1.0 called it `shared`.
- **The same slug open in two places is still refused, and the refusal names the way out.** `read_open_book_page`
  and `search_open_books` take an optional `place` (`shelf`, `collection` or `shared`). The PowerShell adapter
  declares and honours it too, so the two readers' tool lists stay identical.
- **The Desk's `--location` gains `collection`.** No location is the Library's own collection, as the help always
  said. On a local Library, `--location shared` names its Basic Memory connection once one is set up; with no
  connection it stays the old spelling of `collection`. The same rule applies to `read_book_catalog`'s `shared`.

## Consequences

- A local Library's Shelf Book now has somewhere durable to go, and an imported Book can be found (the plan's
  step 4 depends on both).
- `library collection` gains a `rebuild` action. It refuses on a Basic Memory backend, whose shared manifests are
  still rebuilt by `tools/Update-SharedBookManifests.ps1`.
- A local archive leaves open Desk entries as they are, as the shared archiver does: a seat with `books/<slug>` open
  reads it as missing until it is closed.
- The two readers' `tools/list` gain `place` and the `collection` and `shared-archive` catalog scopes. The adapter
  maps both scopes, and `place collection`, onto its shared collection. It does not filter `search_open_books` by
  place, because it searches the Shelf alone.
- Kernel self-test section 41 judges every rule above through the front door, with a connection and a fenced
  environment that must change nothing.
