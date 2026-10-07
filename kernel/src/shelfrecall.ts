/**
 * `library shelf recall <book-slug>`: a Book in this Library's own collection, brought back to the Shelf to be
 * changed there and returned through the publish verbs that already exist (S70, PLAN-shelf-recall.md; R4, "A Book
 * that left the Shelf has no refresh route").
 *
 * THE COLLECTION IS NEVER WRITTEN. The recall reads every page of `collection/books/<slug>/wiki/`, makes a new Shelf
 * Book through `createShelfBook` with the same pages byte for byte, writes the RECALL RECORD (`recallrecord.ts`) and
 * opens the Shelf copy on this seat's Desk. The collection Book stays where it is and stays readable (Q3); the
 * record is what lets the return refuse drift instead of overwriting work it never saw (Q4).
 *
 * THE LOCK ORDER IS ADR-0019's: the registry lock (for the Desk write), then both Book locks sorted. The Shelf render
 * lock is NOT taken here: `createShelfBook` takes it itself, and a Book lock is a non-reentrant `wx` file.
 *
 * OUT OF SCOPE, REFUSED BY NAME: a Basic Memory workspace and a `shared/` Book (Q2), an archived collection Book (Q7,
 * which has no restore route), and removing a page from the collection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { ensureDirectory, writeAtomicBytes } from './fsx.ts';
import { enterSeatRegistryLock, exitBookLock, withBookLocks, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { removeBookManifestStore } from './manifeststore.ts';
import { completeBookMutation, enterBookMutation, type BookMutation } from './mutation.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { isLocalBackend } from './basicmemory.ts';
import { deskEntriesForSeat, requireSeat, setDeskEntryForSeat } from './seatdesk.ts';
import { parseBookRoot } from './places.ts';
import { collectionBookIdentity, collectionBookWiki } from './collectionbooks.ts';
import { splitLocalFrontmatter } from './localcatalog.ts';
import { readStrictUtf8 } from './notebook.ts';
import { ARCHIVE_FOLDER, SLUG_PATTERN, getShelfBook } from './shelfbook.ts';
import { updateShelfBookIndex } from './capture.ts';
import { invokeShelfCatalogRenderAfterRollback, refuse } from './shelfcatalog.ts';
import { createShelfBook } from './shelf.ts';
// `yyyy-MM-dd` in local time, as the Shelf's own `created` origin is dated.
import { localDate as today } from './localdate.ts';
import {
  collectionPageManifest,
  pageBody,
  readRecallRecord,
  recallRecordLabel,
  recallRecordPath,
  writeRecallRecord,
  RECALL_RECORD_SCHEMA,
  type CollectionManifest,
} from './recallrecord.ts';

const LIBRARY_OUTPUT_SCHEMA = 1;
const STRICT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SHELF_RECALL_OPTIONS = ['shelf-slug', 'lock-timeout', 'plan-id', 'seat', 'workspace'];

/** A test hook, named in self-test section 68: fail the recall after its pages are copied, so the rollback is seen. */
function injectedFault(): string {
  return (process.env['LIBRARY_SHELF_RECALL_FAULT'] ?? '').trim();
}


interface RecallPlan {
  planId: string;
  bookSlug: string;
  shelfSlug: string;
  seat: string;
  title: string;
  summary: string;
  wiki: string;
  manifest: CollectionManifest;
  staleRecord: boolean;
  document: Record<string, PsJsonValue>;
}

/** The title and summary the recalled Book carries: `_book.md`'s H1 and `## Purpose`, else the catalog line. */
function recalledIdentity(workspace: string, wiki: string, slug: string): { title: string; summary: string } {
  const root = path.join(wiki, '_book.md');
  let title = '';
  let summary = '';
  if (fs.existsSync(root)) {
    const body = splitLocalFrontmatter(readStrictUtf8(root)).body.replace(/\r\n/g, '\n');
    title = (/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)?.[1] ?? '').trim();
    const purpose = /^##[ \t]+Purpose[ \t]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body);
    summary = (purpose?.[1] ?? '').trim().replace(/\s*\n\s*/g, ' ');
  }
  if (!title || !summary) {
    const identity = collectionBookIdentity(workspace, 'active', slug);
    if (!title) title = identity.title;
    if (!summary) summary = identity.summary;
  }
  if (!summary) summary = `Recalled from collection/books/${slug}.`;
  return { title, summary };
}

/** The Shelf slug `_book.md`'s `source_boundary` names, when it names `shelf/<s>/wiki`. */
function sourceShelfSlug(wiki: string): string | null {
  const root = path.join(wiki, '_book.md');
  if (!fs.existsSync(root)) return null;
  const boundary = splitLocalFrontmatter(readStrictUtf8(root)).fields?.get('source_boundary') ?? '';
  const match = /^shelf\/([a-z0-9][a-z0-9-]*)\/wiki$/.exec(boundary.trim());
  return match ? match[1]! : null;
}

/**
 * THE PREFLIGHT, READ-ONLY, and the same function the confirmed half re-runs under the locks (Preflight 1-7). Every
 * refusal is certain before an approval is issued.
 */
function recallPlan(workspace: string, argv: string[]): RecallPlan {
  const parsed = parseArguments(argv, SHELF_RECALL_OPTIONS);
  const argument = parsed.positional[0] ?? '';
  if (/^shared\//.test(argument)) {
    refuse(
      `shelf recall brings back a Book from this Library's own collection only, and '${argument}' is a Book of a Basic Memory ` +
        'connection. A local Library never writes to Basic Memory, so a recalled shared Book would have no way back. Nothing was written.',
    );
  }
  const bookSlug = argument;
  if (!STRICT_SLUG.test(bookSlug)) refuse('library shelf recall needs the collection Book slug: library shelf recall <book-slug> [--shelf-slug <s>].');

  // 1. THE BACKEND, THE ARCHIVE, THE BOOK.
  if (!isLocalBackend(workspace)) {
    refuse(
      'shelf recall works on a local Library\'s own collection, and this workspace\'s collection is Basic Memory: a recalled Book ' +
        'would have no way back, because a local publish never writes to Basic Memory. Nothing was written.',
    );
  }
  const wiki = collectionBookWiki(workspace, 'active', bookSlug);
  if (!fs.existsSync(wiki) || !fs.statSync(wiki).isDirectory()) {
    if (fs.existsSync(collectionBookWiki(workspace, 'archive', bookSlug))) {
      refuse(
        `Book '${bookSlug}' is in the collection archive (collection/archive/${bookSlug}), and no verb restores an archived collection ` +
          `Book, so there is no route to recall it. Move collection/archive/${bookSlug} back to collection/books/${bookSlug} by hand, ` +
          'then run deskpost collection rebuild, and recall it from there. Nothing was written.',
      );
    }
    refuse(`No Book '${bookSlug}' is in this Library's collection (collection/books/${bookSlug}/wiki does not exist). Nothing was written.`);
  }

  // 2. THE BOOK IS OPEN ON THIS SEAT'S DESK: the recall reads every page, and a closed Book is unavailable.
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
  const open = deskEntriesForSeat(stateDirectory, seat, 'books').some((entry) => parseBookRoot(entry.trim())?.root === `books/${bookSlug}`);
  if (!open) {
    refuse(`Book '${bookSlug}' is not open at seat '${seat}', and a recall reads every page of it. Open it first: deskpost desk open book ${bookSlug} --location collection`);
  }

  // 3. THE SHELF SLUG, and nothing already standing on it.
  const shelfSlug = (parsed.options.get('shelf-slug') ?? '').trim() || sourceShelfSlug(wiki) || bookSlug;
  if (!STRICT_SLUG.test(shelfSlug) || !SLUG_PATTERN.test(shelfSlug)) refuse(`--shelf-slug '${shelfSlug}' must use lowercase letters, digits, and single hyphens.`);
  const shelfRoot = path.join(workspace, 'shelf', shelfSlug);
  if (fs.existsSync(shelfRoot)) {
    const isBook = fs.existsSync(path.join(shelfRoot, 'wiki'));
    refuse(
      `${isBook ? `Shelf Book 'shelf/${shelfSlug}' already exists` : `shelf/${shelfSlug} exists but has no wiki/, so it is a husk rather than a Book`}, ` +
        `so the recall has nowhere to put the pages. Recall into another slug with --shelf-slug <s>, or move that Book out of the way ` +
        `first (deskpost shelf rename ${shelfSlug} <new-slug>). Nothing was written.`,
    );
  }
  if (fs.existsSync(path.join(workspace, 'shelf', ARCHIVE_FOLDER, shelfSlug))) {
    refuse(
      `shelf/${ARCHIVE_FOLDER}/${shelfSlug} is an archived Shelf Book with that slug, and a recall there would stand beside it. ` +
        'Recall into another slug with --shelf-slug <s>. Nothing was written.',
    );
  }
  const staleRecord = readRecallRecord(workspace, shelfSlug) !== null;

  // 4 AND 5. THE PAGE SET, and every page one the return can carry back unchanged.
  const manifest = collectionPageManifest(wiki);
  if (manifest.pages.length === 0) refuse(`collection/books/${bookSlug}/wiki holds no page but _book and _index, so there is nothing to recall.`);
  for (const page of manifest.pages) {
    const file = path.join(wiki, ...page.path.split('/'));
    const label = `collection/books/${bookSlug}/wiki/${page.path}`;
    const bytes = fs.readFileSync(file);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      refuse(
        `Page '${label}' starts with a byte-order mark. The return reads a page without one and writes none, so this page would change ` +
          'bytes on its way back even unedited. Remove the BOM, then recall. Nothing was written.',
      );
    }
    let content: string;
    try {
      content = readStrictUtf8(file);
    } catch {
      refuse(`Page '${label}' is not valid UTF-8, so the return could not publish it. Nothing was written.`);
    }
    const body = pageBody(content);
    if (body !== content && !body.trim()) refuse(`Page '${label}' has frontmatter but no body, so the return could not publish it. Nothing was written.`);
    if (body.startsWith('\r') || body.startsWith('\n')) {
      refuse(`Page '${label}' starts with a blank line, so the return could not publish it safely. Nothing was written.`);
    }
  }

  // 6. TITLE AND SUMMARY. 7. THE PLAN.
  const { title, summary } = recalledIdentity(workspace, wiki, bookSlug);
  const planId =
    'shelf-recall-' +
    sha256OfText(
      [
        `slug=${bookSlug}`,
        `shelf_slug=${shelfSlug}`,
        ...manifest.pages.map((page) => `page=${page.path}|${page.sha256}`),
        `_book=${manifest.book_sha256}`,
        `_index=${manifest.index_sha256}`,
        `title=${title}`,
        `summary=${summary}`,
      ].join('\n'),
    );
  const document: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Recall a collection Book to the Shelf',
    book: `collection/books/${bookSlug}`,
    shelf_book: `shelf/${shelfSlug}`,
    title,
    summary,
    page_count: manifest.pages.length,
    pages: manifest.pages.map((page) => page.path),
    recall_record: recallRecordLabel(shelfSlug),
    ...(staleRecord ? { stale_record: `${recallRecordLabel(shelfSlug)} names a Shelf Book that is no longer there; the recall overwrites it.` } : {}),
    desk_action: `open shelf/${shelfSlug} on seat '${seat}'`,
    plan_id: planId,
    confirmation_required: true,
    shared_library_write: false,
    scope:
      `Copies every page of collection/books/${bookSlug} byte for byte into a new Shelf Book, shelf/${shelfSlug}, records what it ` +
      'copied, and opens the Shelf Book on this seat. The collection is not written and stays readable. The way back is ' +
      `deskpost publish refresh ${shelfSlug} (the Shelf copy stays) or deskpost publish ${shelfSlug} (it is then deleted); either ` +
      "refuses if the collection Book changed after this recall. _book and _index are regenerated on the way back.",
  };
  return { planId, bookSlug, shelfSlug, seat, title, summary, wiki, manifest, staleRecord, document };
}

export function shelfRecallVerb(argv: string[], programRoot: string, workspace: string): { refusal: string | null; value: PsJsonValue | null } {
  const parsed = parseArguments(argv, SHELF_RECALL_OPTIONS);
  const preview = recallPlan(workspace, argv);
  if (parsed.flags.has('preflight')) return { refusal: null, value: preview.document };
  if (!parsed.flags.has('user-confirmed')) refuse('The Book was not recalled: review the preflight (--preflight) and rerun with --user-confirmed --plan-id <id>.');
  if ((parsed.options.get('plan-id') ?? '') !== preview.planId) {
    refuse('The Book was not recalled: rerun the current preflight and pass its exact plan_id. A different plan_id means the Book or the Shelf changed since you approved it.');
  }
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const lockTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 20;
  const { bookSlug, shelfSlug } = preview;
  const shelfRoot = path.join(workspace, 'shelf', shelfSlug);
  const desks = path.join(workspace, '.claude');

  let registryLock: BookLock | null = null;
  try {
    registryLock = enterSeatRegistryLock(workspace, lockTimeout);
    return withBookLocks(workspace, [`books/${bookSlug}`, `shelf/${shelfSlug}`], lockTimeout, (locks) => {
      // 2. THE PREVIEW, AGAIN, UNDER THE LOCKS.
      let current: RecallPlan;
      try {
        current = recallPlan(workspace, argv);
      } catch (error) {
        refuse(`The Book was not recalled: it changed since the preview, and nothing was written. ${(error as Error).message}`);
      }
      if (current.planId !== preview.planId) refuse('The Book was not recalled: it changed since the preview, and nothing was written. Rerun --preflight.');

      const shelfLock = locks.find((lock) => lock.bookRoot === `shelf/${shelfSlug}`)!;
      let mutation: BookMutation | null = null;
      let journalPath: string | null = null;
      let created = false;
      let deskOpened = false;
      try {
        // 3. THE WINDOW AND THE JOURNAL: the record's prior state, present (a stale one) or absent.
        mutation = enterBookMutation({ workspace, slug: shelfSlug, bookRoot: `shelf/${shelfSlug}`, reason: `Recall collection/books/${bookSlug}`, lock: shelfLock });
        journalPath = writeBookJournal({
          workspace,
          bookRoot: `shelf/${shelfSlug}`,
          operation: `Recall collection/books/${bookSlug} to shelf/${shelfSlug}`,
          paths: [recallRecordPath(workspace, shelfSlug)],
          operationDigest: preview.planId,
        }).journalPath;

        // 4. THE SHELF BOOK, with the recalled identity and its provenance. It renders the catalog itself.
        createShelfBook({
          workspace,
          programRoot,
          slug: shelfSlug,
          title: current.title,
          summary: current.summary,
          capture: false,
          origin: `recalled from collection/books/${bookSlug} ${today()}`,
        });
        created = true;

        // 5. EVERY PAGE, BYTE FOR BYTE, frontmatter included. 6. READ BACK, THEN THE RECORD.
        const shelfWiki = path.join(shelfRoot, 'wiki');
        for (const page of current.manifest.pages) {
          const bytes = fs.readFileSync(path.join(current.wiki, ...page.path.split('/')));
          const target = path.join(shelfWiki, ...page.path.split('/'));
          ensureDirectory(path.dirname(target));
          writeAtomicBytes(target, bytes);
        }
        if (injectedFault() === 'after-copy') throw new Error('LIBRARY_SHELF_RECALL_FAULT=after-copy: the recall was made to fail after its page copy');
        for (const page of current.manifest.pages) {
          if (sha256OfBytes(fs.readFileSync(path.join(shelfWiki, ...page.path.split('/')))) !== page.sha256) {
            throw new Error(`shelf/${shelfSlug}/wiki/${page.path} did not read back byte-identical to its collection page`);
          }
        }
        writeRecallRecord(workspace, {
          schema: RECALL_RECORD_SCHEMA,
          book_slug: bookSlug,
          shelf_slug: shelfSlug,
          plan_id: preview.planId,
          recalled_utc: new Date().toISOString(),
          refreshed_utc: null,
          seat: current.seat,
          title: current.title,
          summary: current.summary,
          pages: current.manifest.pages,
          book_sha256: current.manifest.book_sha256,
          index_sha256: current.manifest.index_sha256,
        });

        // 7. OPEN ON THIS SEAT (Q5), under the registry lock already held, as removeVerb closes one.
        deskOpened = setDeskEntryForSeat({ workspace, stateDirectory: desks, seat: current.seat, kind: 'books', entry: `shelf/${shelfSlug}`, action: 'Add' });

        // 7b. THE READER MAP, FROM DISK (S85 row 5, backlog Row C): `createShelfBook` wrote it before any page was
        // copied, so it listed only `_book`. Regenerated before the manifest commit, and checked to list every page.
        updateShelfBookIndex(getShelfBook(workspace, shelfSlug));
        const map = fs.readFileSync(path.join(shelfWiki, '_index.md'), 'utf8');
        const unlisted = current.manifest.pages
          .map((page) => page.path.replace(/\.md$/, ''))
          .filter((page) => page !== '_index' && page !== '_book' && !map.includes(`[[${page}|`));
        if (unlisted.length) throw new Error(`shelf/${shelfSlug}/wiki/_index.md does not list ${unlisted.join(', ')} after it was regenerated`);

        // 8. THE MANIFEST.
        const manifest = completeBookMutation(mutation);
        mutation = null;
        const document = current.document;
        document['status'] = 'recalled';
        document['pages_verified_identical'] = current.manifest.pages.length;
        document['desk_opened'] = deskOpened || deskEntriesForSeat(desks, current.seat, 'books').includes(`shelf/${shelfSlug}`);
        document['manifest'] = manifest.summary;
        document['journal'] = path.relative(workspace, journalPath).replace(/\\/g, '/');
        document['next'] =
          `Change the pages in shelf/${shelfSlug}, then return them: deskpost publish refresh ${shelfSlug} --preflight keeps the Shelf copy, ` +
          `deskpost publish ${shelfSlug} --preflight publishes it and deletes the Shelf copy. Both take --book-slug ${bookSlug} from the record. ` +
          `Or make the Book Shelf-only: deskpost shared archive ${bookSlug} --kind book --preflight retires the collection copy.`;
        return { refusal: null, value: document };
      } catch (error) {
        // ROLLBACK, IN REVERSE, the registry lock still held. The collection was never written.
        const failure = (error as Error).message;
        const problems: string[] = [];
        const step = (label: string, action: () => void): void => {
          try {
            action();
          } catch (stepError) {
            problems.push(`${label}: ${(stepError as Error).message}`);
          }
        };
        step('the Desk entry', () => {
          if (deskOpened) setDeskEntryForSeat({ workspace, stateDirectory: desks, seat: current.seat, kind: 'books', entry: `shelf/${shelfSlug}`, action: 'Remove' });
        });
        step('the recall record', () => {
          if (journalPath) restoreBookJournal(journalPath);
        });
        step(`shelf/${shelfSlug}`, () => {
          if (created || fs.existsSync(shelfRoot)) fs.rmSync(shelfRoot, { recursive: true, force: true });
          if (fs.existsSync(shelfRoot)) throw new Error('it still exists');
        });
        step('the manifest store', () => {
          if (mutation !== null) removeBookManifestStore(workspace, shelfSlug, 'shelf');
        });
        step('shelf/_catalog.md', () => {
          if (created) invokeShelfCatalogRenderAfterRollback(workspace, programRoot);
        });
        const rollback = problems.length ? `FAILED: ${problems.join('; ')}` : 'complete and verified';
        refuse(`The Book was not recalled. ${failure}. Rollback: ${rollback}. The collection was not written.`);
      }
    });
  } finally {
    exitBookLock(registryLock);
  }
}
