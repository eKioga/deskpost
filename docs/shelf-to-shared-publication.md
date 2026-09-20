# Publish a Shelf Book to the shared collection

A curated Shelf Book can be published directly to the shared collection. The ordinary Shelf exit is
`tools/Publish-ShelfBookToShared.ps1`: it publishes and verifies the shared copy, verifies its Catalog
entry, and only then permanently deletes the local Book under the same approval. No local archive
copy is created.

The safety boundary is explicit: `-FromShelf` is required, the source must be exactly
`shelf/<slug>` or `shelf/<slug>/wiki`, and the Book must be curated and open on the Desk even for
preflight. Capture Books are refused. Publication still uses a read-only preflight followed by one
approval bound to its exact `shelf-copy-...` `plan_id`; the Shelf source is never changed.

That source-preserving helper remains the publication half and can still be used alone when the
reader explicitly wants two copies. The connected workflow composes it with
`tools/Remove-ShelfBook.ps1`; it never treats publication approval as permission to delete unless
the composite preflight showed that deletion and the reader approved its exact composite `plan_id`.

Every Markdown page below the Shelf Book's `wiki/` directory is carried over, including nested
`_index.md` pages. The wiki-root `_book.md` and `_index.md` are not copied. The shared publisher
regenerates the Book root and reader map so Shelf-only metadata such as `Type: Local copy` and a
Notebook source label cannot become false shared metadata.

## Source frontmatter

A literal frontmatter block is absorbed into the shared store's own frontmatter, and `title` is
overwritten with a filename-derived value. The store adds its own frontmatter to every note and,
when it parses a literal frontmatter block out of submitted content, strips surrounding carriage
returns and newlines from the remaining body. Publication verifies every record by trimming leading
and trailing carriage returns and newlines from both the expected body and its readback.

Opening the Book on the Desk is deliberate curatorial intent, not publication approval. The Desk
gate must be satisfied before preflight; the exact preflight plan still needs the reader's separate
approval before any shared-collection write.

## Failure and resume

Shared publication is never rolled back or deleted automatically. If it stops while copying, the
Shelf Book remains and only the same matching manifest may resume. If publication completes but
local deletion fails, the verified shared Book remains in its Catalog, the local deletion rolls back
when still possible, and the workflow journal records `published-awaiting-local-delete`. A retry of
the same approved plan verifies the shared Book again before attempting the unfinished deletion.
