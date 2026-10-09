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
import { withBookLocks } from './locks.ts';
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
function relinked(text: string, slug: string): string {
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

  return withBookLocks(workspace, [activeDirectory, archiveDirectory, 'collection/books', 'collection/archive'], 20, (locks) => {
    // THE PLAN, AGAIN, UNDER THE LOCKS: nothing can change the Book between this check and the move.
    if (!fs.existsSync(activeRoot) || !fs.existsSync(activeIndex)) refuse(`Active Book '${slug}' is incomplete or missing; nothing was archived.`);
    if (archivePlanId(slug, kind, activeDirectory, activeFull) !== approved) refuse(STALE_PLAN_ID);
    const activeLock = locks.find((lock) => lock.bookRoot === activeDirectory)!;
    const archiveLock = locks.find((lock) => lock.bookRoot === archiveDirectory)!;
    let mutation: BookMutation | null = null;
    let moved = false;
    try {
      mutation = enterBookMutation({ workspace, slug, bookRoot: activeDirectory, reason: `Archive ${activeDirectory}`, lock: activeLock, collection: 'collection' });
      // Re-checked under the locks: the checks above ran with nobody excluded.
      if (fs.existsSync(archiveFull)) refuse(`Archive already contains '${slug}'; no move was attempted.`);
      fs.mkdirSync(path.dirname(archiveFull), { recursive: true });
      fs.renameSync(activeFull, archiveFull);
      moved = true;

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

      const manifest = completeBookRenameMutation({
        mutation,
        newSlug: slug,
        newBookRoot: archiveDirectory,
        newLock: archiveLock,
        newCollection: 'collection-archive',
        manifest: newBookManifestForCollectionBook(workspace, 'archive', slug),
      });
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
  });
}
