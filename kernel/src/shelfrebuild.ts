/**
 * `library shelf rebuild [<slug>]`: a Shelf Book's Discovery manifest written again from its pages on disk (S87, ruling
 * 4; backlog Row G). A page corrected in place leaves the stored manifest `ok` and describing the old page, and since the
 * reader's ruling of 2026-10-04 seats correct open Shelf pages in place, so Discovery names such a Book in `books_stale`
 * and this is the repair it names. With no slug it rebuilds every Book the Shelf catalog lists.
 *
 * THE ONE MUTATION WINDOW EVERY SHELF WRITER USES: the Book's lock, `enterBookMutation`, then `completeBookMutation`
 * generating the manifest from disk -- a new generation, never an edit of the old one. It writes nothing but the
 * derived manifest store under `internal/`, so it is ungated, as `collection rebuild` is. Never a page, never the catalog.
 */

import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { getShelfBook, SLUG_PATTERN } from './shelfbook.ts';
import { shelfCatalogEntryInventory } from './shelfcatalog.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { completeBookMutation, enterBookMutation } from './mutation.ts';

export class ShelfRebuildRefusal extends Error {}

function refuse(message: string): never {
  throw new ShelfRebuildRefusal(message);
}

function rebuildOne(workspace: string, slug: string): Record<string, PsJsonValue> {
  let lock: BookLock | null = null;
  try {
    const book = getShelfBook(workspace, slug);
    lock = enterBookLock(workspace, book.bookRoot);
    const mutation = enterBookMutation({ workspace, slug, bookRoot: book.bookRoot, reason: 'library shelf rebuild', lock });
    const result = completeBookMutation(mutation);
    return { book: slug, book_root: book.bookRoot, status: result.status, generation: result.generation, summary: result.summary };
  } catch (error) {
    return { book: slug, book_root: `shelf/${slug}`, status: 'not-rebuilt', generation: 0, summary: (error as Error).message };
  } finally {
    exitBookLock(lock);
  }
}

export function shelfRebuildVerb(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('shelf', 'rebuild'));
  const only = (parsed.positional[0] ?? '').trim();
  if (only && !SLUG_PATTERN.test(only)) refuse(`'${only}' is not a Shelf Book slug: lowercase letters, digits and hyphens. Nothing was rebuilt.`);
  if (only) {
    try {
      getShelfBook(workspace, only);
    } catch (error) {
      refuse(`${(error as Error).message} Nothing was rebuilt. The Shelf's Books are listed by deskpost shelf render.`);
    }
  }
  const slugs = only ? [only] : shelfCatalogEntryInventory(workspace).entries.map((entry) => entry.slug);
  const books = slugs.map((slug) => rebuildOne(workspace, slug));
  const rebuilt = books.filter((entry) => entry['status'] === 'committed').length;
  return {
    schema: 1,
    operation: 'Rebuild Shelf Book Discovery manifests',
    scope: only ? `shelf/${only}` : 'every Book the Shelf catalog lists',
    books_total: books.length,
    books_rebuilt: rebuilt,
    books_not_rebuilt: books.length - rebuilt,
    books: books as PsJsonValue,
    shared_library_write: false,
  };
}
