# Workspace Wiki Migration

> **Status:** implemented locally on 2026-08-15. This is a confirmed, Shelf-first migration path
> for one external workspace wiki at a time.

## Why this exists

The Library is now ready for production use, but older LLM workspaces retain knowledge in their
own `wiki/` folders. The production Library did **not** include the deposit-box importer found in
an earlier reference implementation, and its existing Book publisher accepts only local
`notebook/` sources. A bulk scan into `raw/` would be both context-heavy and a poor source
boundary. This capability provides the missing direct migration path without treating a workspace
as disposable before its copy has been checked.

## Reader workflow

The reader can ask in plain language to turn a named external `wiki/` folder into a Book. The
Librarian performs these bounded steps:

1. Run `tools/Get-WikiMigrationInventory.ps1 -SourceWikiPath <source-wiki>`.
2. Use its page paths, first headings, top-level groups, and link map to propose either one Book
   or a small project/reference split.
3. Show the exact pages in each proposed Book. The Librarian never silently decides that a page is
   “project” or “tool” documentation.
4. Preflight each approved Shelf Book with `tools/Import-ExternalWikiToShelf.ps1 ... -Preflight`.
   The preflight returns an exact page manifest and `plan_id`.
5. After one clear approval, rerun that same import with `-UserConfirmed -ApprovedPlanId <plan_id>`.

The original workspace is read-only throughout. Migration does not authorize its deletion,
renaming, or cleanup; the reader decides that separately after inspecting the Shelf Book.

## Split safety

A selected Book must include every selected page's resolvable local Markdown or wiki-link target.
The importer refuses a partial selection that would leave such a link broken. A reusable reference
page may appear in more than one migrated Shelf Book when it is needed to keep a project Book and
a tool-reference Book self-contained. The tool does not rewrite source articles or invent summary
content.

## What the importer creates

The confirmed importer creates `shelf/<book-slug>/wiki/`, preserves the selected Markdown page
content and paths, generates `_book.md` and `_index.md`, verifies every copied page against its
SHA-256 digest, and writes an origin-aware entry to `shelf/<book-slug>/_catalog-entry.md` inside the
Shelf render lock, which then re-renders `shelf/_catalog.md`. It used to append to that catalog with
`Add-Content` and no lock, so two imports could interleave into one line; each import now touches
only its own Book's file. It refuses an existing Shelf destination.
Detail: [Derived Indexes](derived-indexes.md). If copying fails before completion, it leaves an exact named staging folder for
inspection rather than deleting evidence.

The source wiki must not have root `_book.md` or `_index.md`, because those names are reserved for
the Library's generated metadata and reader map. Rename a conflicting source file before
migrating; no source file is renamed automatically.

## Current boundary and follow-up

This implementation is deliberately **Shelf-first**. A successful import is a verified local Book,
not permission to publish it to the shared collection. The reader should audit and inspect the
migrated Shelf Book before any separate shared-publication decision. Once the curated Book is open
on the Desk, the explicit Shelf-source workflow can publish it without using the volatile Notebook;
see [Publish a Shelf Book to the shared collection](shelf-to-shared-publication.md).

The development regression check proves that the inventory finds a mixed project/tool fixture, an
unsafe split is rejected, a selected page is copied byte-for-byte, and the source wiki remains
unchanged. It is retained with the development workspace rather than the production Library.

## Key Takeaways

- Migrate one source wiki at a time; do not bulk-load historic workspaces into `raw/`.
- The Librarian proposes a split, while the reader chooses it.
- Link completeness and checksum verification protect a Shelf Book from an unsafe partial copy.
- Source cleanup is always separate from migration and shared publication.
- Migrating several independent workspaces can surface the same real-world topic in more than one
  Book. That is not a link-closure duplication problem; see [Duplicate Topic
  Resolution](duplicate-topic-resolution.md) for the survivorship rule and canonical + stub pattern.
