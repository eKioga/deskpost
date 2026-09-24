/**
 * The mutation window: what a Shelf writer actually calls around its own change.
 *
 * The PowerShell original is `tools/BookManifestTransaction.ps1`. Committing a manifest AFTER a
 * writer has finished leaves a window in which the Book has changed and the stored manifest still
 * reads `ok` -- exactly the silently-stale answer the dirty marker exists to prevent. So a writer
 * does not call the transaction. It OPENS a window and then closes it:
 *
 *     const lock = enterBookLock(...)
 *     const mutation = enterBookMutation(...)   // marker down, BEFORE the first write
 *     ... journal, mutate, verify ...
 *     completeBookMutation(mutation)            // generate, store, commit, marker up
 *
 * and on a failure whose rollback VERIFIED, `undoBookMutation` instead -- the Book is back to the
 * state the committed manifest already describes, so the marker must come up or the Book reads
 * unavailable for ever with nothing left to repair.
 *
 * COMPLETING NEVER THROWS, AND THAT IS THE POINT. The mutation has already landed and been verified
 * by the time it is called. A manifest failure must not unwind the reader's page, note or rename: it
 * leaves the marker down, the Book reads `dirty`, and Discovery refuses to describe it until a
 * rebuild. Refusing a good manifest costs a rebuild; serving a bad one costs a wrong answer that
 * looks right; discarding a landed write costs the reader their material.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { toBookLockName, type BookLock } from './locks.ts';
import {
  bookManifestStorePath,
  MANIFEST_COLLECTIONS,
  removeBookManifestStore,
  saveBookManifest,
  setBookManifestDirty,
} from './manifeststore.ts';
import { newBookManifestForShelfBook } from './manifest.ts';
import { getShelfBook } from './shelfbook.ts';

export interface BookMutation {
  workspace: string;
  slug: string;
  bookRoot: string;
  collection: string;
  reason: string;
  lock: BookLock;
}

export interface MutationResult {
  status: 'committed' | 'dirty' | 'cleared';
  slug: string;
  generation: number;
  summary: string;
}

const COLLECTION_ROOT_PREFIX: Record<string, string> = {
  shelf: 'shelf',
  'shelf-archive': 'shelf/_archive',
  shared: 'books',
  'shared-archive': 'archive',
};

export function bookRootForCollection(collection: string, slug: string): string {
  const prefix = COLLECTION_ROOT_PREFIX[collection];
  if (prefix === undefined) {
    throw new Error(`Book collection '${collection}' must be one of: ${MANIFEST_COLLECTIONS.join(', ')}.`);
  }
  return `${prefix}/${slug}`;
}

/**
 * THE ARCHIVES MADE `startsWith` WRONG. A prefix test said `shelf/_archive/godot` belonged to
 * `shelf`, so an archived Book would have written its manifest into its ACTIVE twin's store -- the
 * exact collision the collection key exists to prevent, one shelf over. The root is taken apart and
 * its OWN collection compared for equality, which no prefix can satisfy by accident.
 */
export function assertBookCollectionMatchesRoot(collection: string, bookRoot: string): void {
  if (!MANIFEST_COLLECTIONS.includes(collection)) {
    throw new Error(`Book collection '${collection}' must be one of: ${MANIFEST_COLLECTIONS.join(', ')}.`);
  }
  const actual = collectionForBookRoot(bookRoot);
  if (actual === null) {
    throw new Error(`Book root '${bookRoot}' is not a well-formed Book root, so no collection can answer for it.`);
  }
  if (actual !== collection) {
    throw new Error(
      `Book root '${bookRoot}' does not belong to the '${collection}' collection; it belongs to '${actual}'. ` +
        `A '${collection}' Book's root starts with '${COLLECTION_ROOT_PREFIX[collection]}/'.`,
    );
  }
}

function collectionForBookRoot(bookRoot: string): string | null {
  const match = /^(shelf\/_archive|books|archive|shelf)\/([a-z0-9][a-z0-9-]*)$/.exec(bookRoot);
  if (!match) return null;
  switch (match[1]) {
    case 'shelf':
      return 'shelf';
    case 'shelf/_archive':
      return 'shelf-archive';
    case 'books':
      return 'shared';
    default:
      return 'shared-archive';
  }
}

/**
 * Mark a Book dirty before a writer changes it, and hold everything the commit will need.
 *
 * The lock is MANDATORY and not a convenience: a mutation window without exclusion is a window two
 * writers can be inside at once. A handle for the wrong Book is worse than no handle -- it would run
 * the whole window believing it was protected while another writer held the Book it is touching.
 */
export function enterBookMutation(options: {
  workspace: string;
  slug: string;
  bookRoot?: string;
  reason: string;
  lock: BookLock;
  collection?: string;
}): BookMutation {
  const collection = options.collection ?? 'shelf';
  const bookRoot = options.bookRoot ?? bookRootForCollection(collection, options.slug);
  assertBookCollectionMatchesRoot(collection, bookRoot);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.slug)) {
    throw new Error(`Book slug '${options.slug}' must contain only lowercase letters, digits, and hyphens.`);
  }
  if (toBookLockName(options.lock.bookRoot) !== toBookLockName(bookRoot)) {
    throw new Error(`The lock handed to this mutation is for '${options.lock.bookRoot}', not for '${bookRoot}'.`);
  }
  setBookManifestDirty({ workspace: options.workspace, slug: options.slug, reason: options.reason, collection });
  return {
    workspace: options.workspace,
    slug: options.slug,
    bookRoot,
    collection,
    reason: options.reason,
    lock: options.lock,
  };
}

/** Close a mutation window by committing the manifest that describes the change. Never throws. */
export function completeBookMutation(mutation: BookMutation, manifest?: PsJsonValue): MutationResult {
  try {
    let document = manifest;
    if (document === undefined) {
      // Only the ACTIVE Shelf can be generated from here. An ARCHIVED Book is absent from
      // shelf/_catalog.md by design, so resolving it by slug would refuse it as uncatalogued; its
      // caller has the pages and the metadata and hands one in.
      if (mutation.collection !== 'shelf') {
        throw new Error(
          `A '${mutation.collection}' Book's manifest must be generated by its caller and passed in; ` +
            `Book '${mutation.slug}' arrived without one.`,
        );
      }
      document = newBookManifestForShelfBook(getShelfBook(mutation.workspace, mutation.slug)) as PsJsonValue;
    }
    const pointer = saveBookManifest({
      workspace: mutation.workspace,
      slug: mutation.slug,
      manifest: document,
      reason: mutation.reason,
      collection: mutation.collection,
    });
    return {
      status: 'committed',
      slug: mutation.slug,
      generation: pointer.generation,
      summary: `generation ${pointer.generation} committed`,
    };
  } catch (error) {
    // Deliberately not cleared. If the marker exists, the mutation has already touched the Book, and
    // a refusal is the truthful answer until something rebuilds it.
    return {
      status: 'dirty',
      slug: mutation.slug,
      generation: 0,
      summary:
        'dirty until rebuilt: The manifest transaction for Book ' +
        `'${mutation.slug}' failed and its stored manifest is now marked dirty until rebuilt: ${(error as Error).message}`,
    };
  }
}

/**
 * Close a window whose mutation was rolled back AND VERIFIED. Never throws.
 *
 * Only for a rollback that verified, or a failure that wrote nothing. After a rollback that FAILED
 * the Book is in an unknown state and the marker must stay down.
 */
export function undoBookMutation(mutation: BookMutation): MutationResult {
  try {
    const marker = path.join(
      bookManifestStorePath(mutation.workspace, mutation.slug, mutation.collection),
      'dirty.json',
    );
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
    return {
      status: 'cleared',
      slug: mutation.slug,
      generation: 0,
      summary: 'unchanged (the mutation was rolled back)',
    };
  } catch (error) {
    return {
      status: 'dirty',
      slug: mutation.slug,
      generation: 0,
      summary: `dirty until rebuilt: the marker could not be cleared: ${(error as Error).message}`,
    };
  }
}

/**
 * Close a window across a CHANGE OF BOOK IDENTITY: the old slug's store is retired and the new
 * identity's first generation is committed. Never throws.
 *
 * The manifest is not moved, it is retired and regenerated. Generation N of the old identity
 * describes a Book with the old slug and the old title inside it; carrying those files forward under
 * a new name would make the store's history disagree with itself. A manifest is derived state, so
 * the cheap and truthful move is to throw it away and generate the new identity's first generation
 * from the Book as it now stands.
 *
 * THE ORDER IS CHOSEN SO EVERY CRASH POINT REFUSES. New identity dirty first, old store removed
 * second, new generation committed last. A crash after the first leaves two dirty stores -- both
 * refuse. A crash after the second leaves one, dirty, refusing. At no point does a store answer for
 * a Book that has moved.
 *
 * A CHANGE OF SHELF IS THE SAME MOVE. Archiving changes a Book's identity exactly as a rename does,
 * so `newCollection` generalises this from "new slug" to "new identity"; the ordering argument never
 * depended on WHICH field moved.
 */
export function completeBookRenameMutation(options: {
  mutation: BookMutation;
  newSlug: string;
  newBookRoot?: string;
  newLock: BookLock;
  newCollection?: string;
  manifest?: PsJsonValue;
}): MutationResult {
  const { mutation } = options;
  try {
    const newCollection = options.newCollection ?? mutation.collection;
    const newBookRoot = options.newBookRoot ?? bookRootForCollection(newCollection, options.newSlug);
    const renamed = enterBookMutation({
      workspace: mutation.workspace,
      slug: options.newSlug,
      bookRoot: newBookRoot,
      reason: mutation.reason,
      lock: options.newLock,
      collection: newCollection,
    });
    // The MUTATION'S OWN collection, never the new one: a move out of any other store would
    // otherwise leave the old manifest in place and delete an unrelated Book's store.
    removeBookManifestStore(mutation.workspace, mutation.slug, mutation.collection);
    const result = completeBookMutation(renamed, options.manifest);
    if (result.status !== 'committed') return result;
    return {
      status: 'committed',
      slug: options.newSlug,
      generation: result.generation,
      summary: `generation ${result.generation} committed under ${newBookRoot}; the store for ${mutation.bookRoot} was retired`,
    };
  } catch (error) {
    return {
      status: 'dirty',
      slug: options.newSlug,
      generation: 0,
      summary: `dirty until rebuilt: ${(error as Error).message}`,
    };
  }
}
