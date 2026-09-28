/**
 * Books in the Local collection, as Discovery and the writers see them (PLAN-basic-memory.md step 1, B0).
 *
 * WITHOUT THIS A BOOK IN `collection/books/` COULD BE READ AND NEVER FOUND. Discovery answered from four stores
 * -- the Shelf and the shared collection, each with its archive -- and a local Library's own collection was in
 * none of them, so an imported or published Book was invisible to every search that did not already know its
 * slug (the S51 friction log's F20). The pair here is `collection` and `collection-archive`, built by the kernel
 * from what is ON DISK, with the same manifest format and generations as the Shelf's.
 *
 * THE ROSTER IS THE DISK, NOT THE CATALOG. A catalog is a reader-facing list and can be incomplete -- Eric's
 * shared archive holds `archive/blog` with no catalog line at all (Fable #9) -- so a Book is any folder under
 * `collection/books/` (or `collection/archive/`, less its `projects/`) that has a `wiki/`. The catalog line,
 * when there is one, supplies the title and summary.
 *
 * A MANIFEST IS WRITTEN ONLY INSIDE A MUTATION WINDOW, under the Book's own lock, as the store requires. The
 * writers here take a lock the CALLER holds: a Book lock is an exclusive create and is not re-entrant, so a
 * rebuild that took its own inside a publish would wait out its own timeout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { completeBookMutation, enterBookMutation, type MutationResult } from './mutation.ts';
import { getStoredBookManifest, removeBookManifestStore } from './manifeststore.ts';
import { convertToCanonicalPagePath, convertToManifestText, newBookManifestFromPages, type ManifestPage } from './manifest.ts';
import { listFilesRecursive, readUtf8 } from './shelfbook.ts';

export type CollectionShelf = 'active' | 'archive';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function collectionRoot(workspace: string): string {
  return path.join(workspace, 'collection');
}

/** `books/<slug>` or `archive/<slug>`: the root, as the Desk and the locks spell it. */
export function collectionBookRoot(shelf: CollectionShelf, slug: string): string {
  return `${shelf === 'archive' ? 'archive' : 'books'}/${slug}`;
}

export function manifestCollectionFor(shelf: CollectionShelf): string {
  return shelf === 'archive' ? 'collection-archive' : 'collection';
}

/** The folder a shelf's Books live in. The archive's `projects/` holds Hubs, never a Book. */
function shelfDirectory(workspace: string, shelf: CollectionShelf): string {
  return path.join(collectionRoot(workspace), shelf === 'archive' ? 'archive' : 'books');
}

/** Every Book on disk in one half of the Local collection, sorted. A folder with no `wiki/` is not a Book. */
export function collectionBookSlugs(workspace: string, shelf: CollectionShelf): string[] {
  const directory = shelfDirectory(workspace, shelf);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SLUG.test(entry.name) && !(shelf === 'archive' && entry.name === 'projects'))
    .filter((entry) => {
      const wiki = path.join(directory, entry.name, 'wiki');
      return fs.existsSync(wiki) && fs.statSync(wiki).isDirectory();
    })
    .map((entry) => entry.name)
    .sort();
}

export function collectionBookWiki(workspace: string, shelf: CollectionShelf, slug: string): string {
  return path.join(shelfDirectory(workspace, shelf), slug, 'wiki');
}

/** The catalog line naming this Book: its title, and what follows the dash as its summary. */
function catalogEntry(workspace: string, shelf: CollectionShelf, slug: string): { title: string; summary: string } | null {
  const catalog = path.join(shelfDirectory(workspace, shelf), 'README.md');
  if (!fs.existsSync(catalog)) return null;
  const target = `${collectionBookRoot(shelf, slug)}/wiki/_book`;
  for (const line of readUtf8(catalog).split(/\r?\n/)) {
    const at = line.indexOf(`[[${target}|`);
    if (at < 0) continue;
    const rest = line.substring(at + target.length + 3);
    const close = rest.indexOf(']]');
    if (close < 0) continue;
    const summary = rest.substring(close + 2).replace(/^\s*[—–-]\s*/, '').trim();
    return { title: rest.substring(0, close).trim(), summary };
  }
  return null;
}

/** A page's first `# ` heading outside its frontmatter, or null. */
function firstHeading(text: string): string | null {
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  return match ? match[1]!.trim() : null;
}

/** The title and summary Discovery shows: the catalog's, or the root page's first heading. */
export function collectionBookIdentity(workspace: string, shelf: CollectionShelf, slug: string): { title: string; summary: string } {
  const entry = catalogEntry(workspace, shelf, slug);
  if (entry && entry.title) return entry;
  const root = path.join(collectionBookWiki(workspace, shelf, slug), '_book.md');
  const heading = fs.existsSync(root) ? firstHeading(readUtf8(root)) : null;
  return { title: heading ?? slug, summary: entry?.summary ?? '' };
}

/**
 * The metadata manifest for one Local collection Book: the Shelf's builder, handed this Book's pages and its
 * reader-map prefix, so a collection Book is described by exactly the rules a Shelf Book is. Writes nothing.
 */
export function newBookManifestForCollectionBook(workspace: string, shelf: CollectionShelf, slug: string): Record<string, PsJsonValue> {
  const wiki = collectionBookWiki(workspace, shelf, slug);
  if (!fs.existsSync(wiki) || !fs.statSync(wiki).isDirectory()) {
    throw new Error(`Book '${slug}' has no pages directory at collection/${collectionBookRoot(shelf, slug)}/wiki.`);
  }
  const pages: ManifestPage[] = listFilesRecursive(wiki)
    .filter((file) => file.toLowerCase().endsWith('.md'))
    .map((file) => ({ path: convertToCanonicalPagePath(wiki, file), text: fs.readFileSync(file, 'utf8'), bytes: fs.readFileSync(file) }));
  const identity = collectionBookIdentity(workspace, shelf, slug);
  return newBookManifestFromPages({
    slug,
    title: identity.title,
    summary: convertToManifestText(identity.summary.replace(/\*\*/g, '')),
    topics: [],
    isCapture: false,
    pages,
    linkPrefix: `${collectionBookRoot(shelf, slug)}/wiki/`,
  });
}

/**
 * Rebuild one Book's manifest, under a lock the caller holds on its root. A Book no longer on disk -- archived
 * away, or never there -- has its store retired instead, so no manifest answers for a Book that has moved.
 * Never throws: a failed rebuild leaves the Book `dirty`, which Discovery names, and that is the safe answer.
 */
export function rebuildCollectionManifestHeld(workspace: string, shelf: CollectionShelf, slug: string, lock: BookLock, reason: string): MutationResult {
  const collection = manifestCollectionFor(shelf);
  const bookRoot = collectionBookRoot(shelf, slug);
  try {
    if (!collectionBookSlugs(workspace, shelf).includes(slug)) {
      removeBookManifestStore(workspace, slug, collection);
      return { status: 'cleared', slug, generation: 0, summary: `no Book at collection/${bookRoot}; its manifest store was retired` };
    }
    const mutation = enterBookMutation({ workspace, slug, bookRoot, reason, lock, collection });
    let manifest: Record<string, PsJsonValue>;
    try {
      manifest = newBookManifestForCollectionBook(workspace, shelf, slug);
    } catch (error) {
      return { status: 'dirty', slug, generation: 0, summary: `dirty until rebuilt: ${(error as Error).message}` };
    }
    return completeBookMutation(mutation, manifest);
  } catch (error) {
    return { status: 'dirty', slug, generation: 0, summary: `dirty until rebuilt: ${(error as Error).message}` };
  }
}

/** The same, taking the Book's lock itself: for a caller holding none. */
export function rebuildCollectionManifest(workspace: string, shelf: CollectionShelf, slug: string, reason: string): MutationResult {
  let lock: BookLock | null = null;
  try {
    lock = enterBookLock(workspace, collectionBookRoot(shelf, slug));
    return rebuildCollectionManifestHeld(workspace, shelf, slug, lock, reason);
  } catch (error) {
    return { status: 'dirty', slug, generation: 0, summary: `not rebuilt: ${(error as Error).message}` };
  } finally {
    exitBookLock(lock);
  }
}

/**
 * `library collection rebuild`: every Local collection Book's manifest, both halves, and every store whose Book
 * is gone retired. The route Discovery names when a Book is missing from it -- a Book copied in by hand, or one
 * whose rebuild after a write did not complete.
 */
export function rebuildAllCollectionManifests(workspace: string, reason = 'library collection rebuild'): Record<string, PsJsonValue> {
  const results: Record<string, PsJsonValue>[] = [];
  for (const shelf of ['active', 'archive'] as CollectionShelf[]) {
    const onDisk = collectionBookSlugs(workspace, shelf);
    const storeRoot = path.join(workspace, 'internal', 'book-manifests', manifestCollectionFor(shelf));
    const stored = fs.existsSync(storeRoot)
      ? fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SLUG.test(entry.name)).map((entry) => entry.name)
      : [];
    for (const slug of [...new Set([...onDisk, ...stored])].sort()) {
      const result = rebuildCollectionManifest(workspace, shelf, slug, reason);
      results.push({ book_root: collectionBookRoot(shelf, slug), status: result.status, summary: result.summary });
    }
  }
  return {
    schema: 1,
    operation: 'Rebuild the Local collection Discovery manifests',
    books: results,
    committed: results.filter((row) => row['status'] === 'committed').length,
    retired: results.filter((row) => row['status'] === 'cleared').length,
    dirty: results.filter((row) => row['status'] === 'dirty').length,
    shared_library_write: false,
  };
}

/** Whether a Book's stored manifest is `ok`. For a caller reporting what a write left behind. */
export function collectionManifestStatus(workspace: string, shelf: CollectionShelf, slug: string): string {
  return getStoredBookManifest(workspace, slug, manifestCollectionFor(shelf)).status;
}
