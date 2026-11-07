/**
 * `library shared archive <slug>` on a local Library: a Local collection Book moved to `collection/archive/`
 * (PLAN-basic-memory.md step 1, B0). Until 1.1 the verb refused a local Library outright, so a Book published into
 * its own collection could never be retired.
 *
 * THE SHARED ARCHIVER'S STEPS, AS FILES: the folder moved, the two publisher-owned pages relinked from `books/<slug>`
 * to `archive/<slug>`, the reader map proved, the archive catalog created when missing and the Book's entry added
 * under `## Archived Books`, and its line removed from the Books catalog. Two differences, both said:
 *
 *   A LINK IS REWRITTEN ONLY WHERE IT IS THIS BOOK'S. The shared archiver replaces the substring `books/<slug>`,
 *   which also matches `books/<slug>-other`; here the next character must end the path segment.
 *
 *   IT IS ONE LOCKED WINDOW with the Discovery manifests: the active identity's store retired and the archived one's
 *   first generation committed, by the same rename rule a Shelf archive uses (`completeBookRenameMutation`).
 *
 * The seats that have the Book open are not changed, as the shared archiver changes none: their `books/<slug>`
 * entry reads as a missing Book until it is closed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { enterBookLock, exitBookLock, withBookLocks, type BookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { completeBookRenameMutation, enterBookMutation, undoBookMutation, type BookMutation } from './mutation.ts';
import { newBookManifestForCollectionBook } from './collectionbooks.ts';
import { listFilesRecursive, readUtf8 } from './shelfbook.ts';
import { localDate } from './localdate.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import {
  ensureHeading,
  insertUnderHeading,
  LOCAL_ARCHIVE_CATALOG_TEXT,
  LOCAL_BOOKS_CATALOG_TEXT,
  ownedLines,
  readCatalogOrTemplate,
  splitLocalFrontmatter,
  withoutLine,
  writeCatalog,
} from './localcatalog.ts';

class LocalArchiveRefusal extends Error {}

function refuse(message: string): never {
  throw new LocalArchiveRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `Get-Date -Format 'yyyy-MM-dd'`: the local date, as the shared archiver stamps an entry. */
function firstHeading(text: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(splitLocalFrontmatter(text).body);
  return match ? match[1]!.trim() : null;
}

/**
 * THIS Book's own path, rewritten from active to archived: in the body, and in every frontmatter value but the
 * three Basic Memory writes for itself (`title`, `type`, `permalink`), as `Rewrite-PublisherOwnedLinks` leaves them.
 */
export function relinked(text: string, slug: string): string {
  const pattern = new RegExp(`books/${escapeRegExp(slug)}(?=/|\\||\\]|\\s|$)`, 'g');
  const match = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!match) return text.replace(pattern, `archive/${slug}`);
  const frontmatter = match[2]!
    .split(/\r?\n/)
    .map((line) => (/^(title|type|permalink):/i.test(line) ? line : line.replace(pattern, `archive/${slug}`)))
    .join('\n');
  return match[1]! + frontmatter + match[3]! + text.substring(match[0].length).replace(pattern, `archive/${slug}`);
}

/**
 * THE APPROVAL BINDS TO WHAT THE READER SAW (S97 row A, home-lab-admin's Report: an apply with a plan id no preflight
 * had issued moved a whole Book). The id covers the slug, the kind, the active path and every file under the active
 * Book's root, each by its path below the root and its bytes' sha256, sorted: a page changed, added or removed after
 * the preview gives another id, and the apply refuses it, as `hub edit` and `shelf recall` refuse theirs.
 */
function archivePlanId(slug: string, kind: string, activeDirectory: string, activeFull: string): string {
  const files = listFilesRecursive(activeFull)
    .map((file) => `${path.relative(activeFull, file).split(path.sep).join('/')}|${sha256OfBytes(fs.readFileSync(file))}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const manifest = sha256OfText(files.join('\n'));
  return 'shared-archive-' + sha256OfText([`slug=${slug}`, `kind=${kind}`, `active_path=${activeDirectory}`, `manifest=${manifest}`].join('\n'));
}

const STALE_PLAN_ID =
  'The Book was not archived: rerun the current preflight and pass its exact plan_id. A different plan_id means the Book ' +
  'changed since you approved it. Nothing was moved.';

export function localSharedArchive(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('shared', 'archive'));
  const slug = parsed.positional[0] ?? '';
  if (!slug.trim()) refuse('BookSlug is required.');
  if (!SLUG.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');
  // A LOCAL LIBRARY'S ARCHIVER MOVES A BOOK ONLY; a Project Hub is not archived here (`hub archive` is Basic Memory's).
  const kind = parsed.options.get('kind') ?? 'book';
  if (kind !== 'book') refuse(`This Library's own archiver moves a Book only, and --kind ${kind} names something else. Nothing was archived.`);

  const collection = path.join(workspace, 'collection');
  const activeDirectory = `books/${slug}`;
  const archiveDirectory = `archive/${slug}`;
  const activeFull = path.join(collection, 'books', slug);
  const archiveFull = path.join(collection, 'archive', slug);
  const activeRoot = path.join(activeFull, 'wiki', '_book.md');
  const activeIndex = path.join(activeFull, 'wiki', '_index.md');
  // AN ARCHIVED BOOK IS SAID AS ONE (kickoffs/s109 ruling 4): no active copy and an archive copy is not "incomplete".
  if (!fs.existsSync(activeFull) && fs.existsSync(archiveFull)) refuse(`Book '${slug}' is already archived; nothing to do.`);
  if (!fs.existsSync(activeRoot) || !fs.existsSync(activeIndex)) refuse(`Active Book '${slug}' is incomplete or missing; nothing was archived.`);
  if (fs.existsSync(archiveFull)) refuse(`Archive already contains '${slug}'; no move was attempted.`);
  const bookTitle = firstHeading(readUtf8(activeRoot)) ?? slug;
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Archive Book',
    destination: 'collection',
    book_slug: slug,
    book_title: bookTitle,
    active_path: activeDirectory,
    archive_path: archiveDirectory,
    active_catalog_entry_removed: true,
    source_tree_removal: `the emptied ${activeDirectory}/ is moved whole, so none is left behind`,
    confirmation_required: true,
    shared_library_write: false,
    plan_id: archivePlanId(slug, kind, activeDirectory, activeFull),
  };
  if (parsed.flags.has('preflight')) return plan;
  if (!parsed.flags.has('user-confirmed')) refuse('Archiving is not yet performed: review the move plan and rerun with --user-confirmed.');
  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('Archiving is not yet performed: rerun --preflight and pass its plan_id with --user-confirmed --plan-id <id>. Nothing was moved.');
  if (approved !== plan['plan_id']) refuse(STALE_PLAN_ID);

  return archiveCollectionBookLocked(workspace, slug, {
    recheck: () => {
      if (archivePlanId(slug, kind, activeDirectory, activeFull) !== approved) refuse(STALE_PLAN_ID);
    },
  });
}

/** The archive route's own content-bound plan id for a collection Book, as its preflight issues it (`shared promote` binds it). */
export function localArchivePlanId(workspace: string, slug: string): string {
  return archivePlanId(slug, 'book', `books/${slug}`, path.join(workspace, 'collection', 'books', slug));
}

/**
 * THE ARCHIVE ROUTE'S LOCKED HALF (kickoffs/s193 row 3; PLAN-many-libraries.md item 9), for `shared archive` and
 * `shared promote` alike, so promote never holds a Book lock this route takes (`withBookLocks` has no re-entry). Under the
 * locks, `recheck` judges the Book against what its caller approved (the plan id, or promote's per-page digests) before
 * anything moves; `afterMove`, given the archived Book's `wiki/`, writes inside the locks after the move.
 */
export function archiveCollectionBookLocked(
  workspace: string,
  slug: string,
  options: { recheck: (activeFull: string) => void; afterMove?: (archivedWiki: string) => void },
): Record<string, PsJsonValue> {
  return withBookLocks(workspace, archiveLockRoots(slug), 20, (locks) => {
    const bookTitle = activeChecks(workspace, slug);
    options.recheck(path.join(workspace, 'collection', 'books', slug));
    return archiveUnderLocks(workspace, slug, locks, bookTitle, options.afterMove);
  });
}

/**
 * THE SAME LOCKED HALF, WITH AN ASYNC RECHECK (kickoffs/s194 row 2; library-auditor's M2 on s193). The lock wait (up to
 * 20 s) is inside the locked half, so a check made before it misses what changed during the wait; `shared promote` reads
 * the shared copy back here, after the locks are held and before anything moves. The roots and their order are
 * `withBookLocks`'s (which has no async form); the synchronous function above and its callers are unchanged.
 */
export async function archiveCollectionBookLockedAsync(
  workspace: string,
  slug: string,
  options: { recheck: (activeFull: string) => Promise<void>; afterMove?: (archivedWiki: string) => void },
): Promise<Record<string, PsJsonValue>> {
  const locks: BookLock[] = [];
  try {
    for (const root of [...new Set(archiveLockRoots(slug))].sort()) locks.push(enterBookLock(workspace, root, 20));
    const bookTitle = activeChecks(workspace, slug);
    await options.recheck(path.join(workspace, 'collection', 'books', slug));
    return archiveUnderLocks(workspace, slug, locks, bookTitle, options.afterMove);
  } finally {
    for (const lock of [...locks].reverse()) exitBookLock(lock);
  }
}

/**
 * AN ARCHIVE STOPPED BETWEEN THE MOVE AND ITS LAST STEP, FINISHED (kickoffs/s194 row 3; library-auditor's S1 on s193).
 * Only when `collection/books/<slug>` is absent and `collection/archive/<slug>` holds the moved Book without `_moved.md`;
 * `recheck`, given the archived Book's folder, judges it against what its caller recorded before the move. Every step
 * after the move is safe to run again on the archived Book: the relink rewrites only `books/<slug>` paths, the archive
 * catalog adds its entry once, the Books catalog loses this Book's line only if it still has one.
 */
export async function finishCollectionBookArchiveAsync(
  workspace: string,
  slug: string,
  options: { recheck: (archiveFull: string) => Promise<void>; afterMove?: (archivedWiki: string) => void; allowMoved?: boolean },
): Promise<Record<string, PsJsonValue>> {
  const locks: BookLock[] = [];
  try {
    for (const root of [...new Set(archiveLockRoots(slug))].sort()) locks.push(enterBookLock(workspace, root, 20));
    const archiveFull = path.join(workspace, 'collection', 'archive', slug);
    const archivedRoot = path.join(archiveFull, 'wiki', '_book.md');
    if (fs.existsSync(path.join(workspace, 'collection', 'books', slug)) || !fs.existsSync(archivedRoot) || (!options.allowMoved && fs.existsSync(path.join(archiveFull, 'wiki', '_moved.md')))) {
      refuse(`Book '${slug}' is not an archive stopped before its last step; nothing was changed.`);
    }
    await options.recheck(archiveFull);
    return archiveUnderLocks(workspace, slug, locks, firstHeading(readUtf8(archivedRoot)) ?? slug, options.afterMove, true);
  } finally {
    for (const lock of [...locks].reverse()) exitBookLock(lock);
  }
}

const archiveLockRoots = (slug: string) => [`books/${slug}`, `archive/${slug}`, 'collection/books', 'collection/archive'];

/**
 * THE PLAN, AGAIN, UNDER THE LOCKS: nothing can change the Book between this check and the move. A Book archived
 * between the preflight and the locks is said as one, as before the plan (kickoffs/s112 ruling 3a). Returns its title.
 */
function activeChecks(workspace: string, slug: string): string {
  const activeFull = path.join(workspace, 'collection', 'books', slug);
  const activeRoot = path.join(activeFull, 'wiki', '_book.md');
  if (!fs.existsSync(activeFull) && fs.existsSync(path.join(workspace, 'collection', 'archive', slug))) refuse(`Book '${slug}' is already archived; nothing to do.`);
  if (!fs.existsSync(activeRoot) || !fs.existsSync(path.join(activeFull, 'wiki', '_index.md'))) refuse(`Active Book '${slug}' is incomplete or missing; nothing was archived.`);
  return firstHeading(readUtf8(activeRoot)) ?? slug;
}

/** The move and everything after it, with the archive route's locks held and its checks passed. */
function archiveUnderLocks(workspace: string, slug: string, locks: BookLock[], bookTitle: string, afterMove?: (archivedWiki: string) => void, resumed = false): Record<string, PsJsonValue> {
  const collection = path.join(workspace, 'collection');
  const activeDirectory = `books/${slug}`;
  const archiveDirectory = `archive/${slug}`;
  const activeFull = path.join(collection, 'books', slug);
  const archiveFull = path.join(collection, 'archive', slug);
  {
    const activeLock = locks.find((lock) => lock.bookRoot === activeDirectory)!;
    const archiveLock = locks.find((lock) => lock.bookRoot === archiveDirectory)!;
    let mutation: BookMutation | null = null;
    let moved = resumed;
    try {
      // A RESUMED ARCHIVE re-enters the same mutation on the active root (its marker is still down from the stopped run),
      // so the rename's manifest step below closes it as the first run would have.
      mutation = enterBookMutation({ workspace, slug, bookRoot: activeDirectory, reason: `Archive ${activeDirectory}`, lock: activeLock, collection: 'collection' });
      if (!resumed) {
        // Re-checked under the locks: the checks above ran with nobody excluded.
        if (fs.existsSync(archiveFull)) refuse(`Archive already contains '${slug}'; no move was attempted.`);
        fs.mkdirSync(path.dirname(archiveFull), { recursive: true });
        fs.renameSync(activeFull, archiveFull);
        moved = true;
      }

      const archivedRoot = path.join(archiveFull, 'wiki', '_book.md');
      const archivedIndex = path.join(archiveFull, 'wiki', '_index.md');
      for (const page of [archivedRoot, archivedIndex]) {
        const before = readUtf8(page);
        const after = relinked(before, slug);
        if (after !== before) writeAtomicText(page, after);
        if (new RegExp(`\\[\\[books/${escapeRegExp(slug)}(?=/|\\|)`).test(splitLocalFrontmatter(readUtf8(page)).body)) {
          refuse(`Archive link readback still contains the active Book path in '${archiveDirectory}/wiki/${path.basename(page)}'.`);
        }
      }
      // The reader map proved: every archive-local link reaches a page at its archived path.
      const targets = [...readUtf8(archivedIndex).matchAll(new RegExp(`\\[\\[(${escapeRegExp(archiveDirectory)}/wiki/[^\\]|]+)`, 'g'))].map((m) => m[1]!);
      if (targets.length === 0) refuse('Archive reader map contains no archive-local links.');
      for (const target of new Set(targets)) {
        if (!fs.existsSync(path.join(collection, ...`${target}.md`.split('/')))) refuse(`Archive reader map links to a missing page: ${target}.md`);
      }

      // The archive catalog: created when missing, the heading inserted when missing, the entry added once.
      const archiveCatalogFile = path.join(collection, 'archive', 'README.md');
      const link = `[[${archiveDirectory}/wiki/_book|${bookTitle}]]`;
      let archiveCatalog = readCatalogOrTemplate(archiveCatalogFile, LOCAL_ARCHIVE_CATALOG_TEXT).text;
      if (!archiveCatalog.toLowerCase().includes(link.toLowerCase())) {
        archiveCatalog = ensureHeading(archiveCatalog, '## Archived Books', null).text;
        archiveCatalog = writeCatalog(archiveCatalogFile, insertUnderHeading(archiveCatalog, '## Archived Books', `- ${link} — Archived ${localDate()}`));
      }
      if (!archiveCatalog.toLowerCase().includes(link.toLowerCase())) refuse('Archive index readback did not include the Book.');

      // The Books catalog: this Book's one line removed; two are refused rather than guessed between.
      const booksCatalogFile = path.join(collection, 'books', 'README.md');
      let booksCatalog = readCatalogOrTemplate(booksCatalogFile, LOCAL_BOOKS_CATALOG_TEXT).text;
      const owned = ownedLines(booksCatalog, [`${activeDirectory}/wiki/_book`, `${archiveDirectory}/wiki/_book`]);
      if (owned.length > 1) refuse('The active Book Catalog has more than one matching entry; archive stopped without changing the Catalog.');
      if (owned.length === 1) booksCatalog = writeCatalog(booksCatalogFile, withoutLine(booksCatalog, owned[0]!.index));
      if (ownedLines(booksCatalog, [`${activeDirectory}/wiki/_book`]).length > 0) refuse('Active Book Catalog readback still includes the archived Book.');
      afterMove?.(path.join(archiveFull, 'wiki'));

      const manifest = completeBookRenameMutation({
        mutation,
        newSlug: slug,
        newBookRoot: archiveDirectory,
        newLock: archiveLock,
        newCollection: 'collection-archive',
        manifest: newBookManifestForCollectionBook(workspace, 'archive', slug),
      });
      // Promote retains its recovery intent until the manifest has committed.
      if (afterMove && manifest.status !== 'committed') refuse(manifest.summary);
      mutation = null;
      return {
        schema: 1,
        operation: 'Archive Book',
        destination: 'collection',
        book_slug: slug,
        archive_path: archiveDirectory,
        archive_complete: true,
        active_catalog_updated: owned.length === 1,
        source_tree: activeDirectory,
        source_tree_removed: 'moved',
        discovery_manifest: manifest.summary,
        shared_library_write: false,
      };
    } catch (error) {
      if (mutation !== null && !moved) undoBookMutation(mutation);
      const location = moved
        ? `The Book was moved to 'collection/${archiveDirectory}'; inspect the archive and both catalogs before retrying.`
        : 'The active Book was left in place.';
      refuse(`Book archival stopped. ${location} ${(error as Error).message}`);
    }
  }
}
