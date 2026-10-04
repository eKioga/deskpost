/**
 * `discover_book_pages` -- where a term occurs across CLOSED-Book metadata, and nothing of any body.
 *
 * A HIT IS A LOCATION, NOT A READING. Every hit carries a Book, a page path and the heading that
 * matched; no page text ever leaves this file. That is what lets Discovery cover a Book the Desk
 * has not opened: a heading licenses "shall I open it?", never an answer about what the page says.
 *
 * THE STORE IS THE AUTHORITY, AND ANYTHING IT DOES NOT CALL `ok` IS NAMED. A Book whose manifest is
 * missing, dirty, corrupt or incomplete contributes nothing AND appears in `books_unavailable` with
 * the reason and the repair -- including a Book this query could have read live, because
 * "unavailable" is a statement about the Book rather than about one path to it. An answer that
 * looked complete while a Book was silently skipped is the failure this whole tier is built
 * against.
 *
 * ONE LOOP OVER EVERY COLLECTION, DRIVEN BY THE SCHEMA'S LIST. Both actives then both archives, so
 * active material sorts ahead of retired material. A collection the schema names and this file has
 * no roster for is a REFUSAL rather than a silent omission.
 *
 * THE ONE BODY-READING PATH IS GATED ON THE DESK. A capture Book's closed-readable manifest holds
 * its summary and its counts and nothing else, because naming an individual note is reading it.
 * Once the Book is OPEN its pages join Discovery normally, read live from disk at query time --
 * live rather than stored, because a capture Book's pages change on every capture and a derived
 * store nothing invalidates would be stale by construction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertSearchQuery,
  convertToSearchDisplay,
  resolveSearchResultCap,
  testSearchContains,
} from './rawsearch.ts';
import { getMarkdownHeadings, type Heading } from './manifest.ts';
import { parseBookRoot } from './places.ts';
import { collectionBookSlugs } from './collectionbooks.ts';
import { isLocalBackend, markerConnection } from './basicmemory.ts';
import { getStoredBookManifest, MANIFEST_COLLECTIONS } from './manifeststore.ts';
import {
  ARCHIVE_FOLDER,
  ARCHIVE_RECORD_NAME,
  getArchivedShelfBook,
  getShelfBook,
  listFilesRecursive,
  readUtf8,
  type ShelfBook,
} from './shelfbook.ts';

const DISCOVERY_SCHEMA = 1;
const DEFAULT_MAX_RESULTS = 50;
const MAX_PAGES_PER_BOOK = 2000;

// ADVICE NAMES ONLY WHAT SHIPS (S85 row 1): the manifest rebuilders these named are PowerShell helpers a release does
// not carry. A Shelf Book's manifest is rebuilt by any write to it; a shared one has no rebuilder in this program.
const SHARED_REBUILDER_MISSING = 'this program has no command that builds shared-collection manifests';
const SHARED_NOTE_NONE =
  'No shared-collection manifests are present, so this answer covers the local Shelf only -- ' + SHARED_REBUILDER_MISSING + '.';
const REPAIR_HINT = "write to this Book once (deskpost book add-page, or deskpost capture for a capture Book) to rebuild its manifest";
const SHARED_REPAIR_HINT = `this shared Book's manifest cannot be repaired here: ${SHARED_REBUILDER_MISSING}`;
const SHELF_ARCHIVE_REPAIR_HINT =
  "restore it with deskpost shelf restore and archive it again with deskpost shelf archive to rebuild this archived Book's manifest";
const SHARED_ARCHIVE_REPAIR_HINT = `this archived shared Book's manifest cannot be repaired here: ${SHARED_REBUILDER_MISSING}`;
const SHARED_ARCHIVE_NOTE_NONE =
  "the shared collection's archive is NOT covered by this answer -- " + SHARED_REBUILDER_MISSING;
const CLOSING_RULE =
  'A hit is a location, not a reading: these are headings and titles, not content, so a hit says which Book to open ' +
  'and never what the page says. Open it with read_open_book_page before answering from it.';
const COLLECTION_REPAIR_HINT = "run `deskpost collection rebuild` to rebuild the Local collection's Discovery manifests";
const SHARED_NOTE_NOT_REBUILT =
  'The shared collection this Library connects to is NOT covered: ' + SHARED_REBUILDER_MISSING + ". Open a shared " +
  "Book from its catalog, read_book_catalog with location 'shared'.";

/**
 * Deterministic ordering. Book-level matches come before page-level ones because they ORIENT: a
 * Book whose summary matches is a Book to consider opening, whatever its pages say.
 */
const FIELD_RANK: Record<string, number> = {
  'book-title': 0,
  topic: 1,
  'book-summary': 2,
  'reader-map': 3,
  'page-title': 4,
  heading: 5,
};

/**
 * manifest collection -> the Book-root prefix its Books live under. One map, both directions -- and ONE ENTRY
 * DEPENDS ON THE WORKSPACE: on a local Library the shared collection is its Basic Memory CONNECTION, whose Books
 * open as `shared/<slug>`, while `books/<slug>` is the Library's own collection (PLAN-basic-memory.md step 1).
 */
function collectionPrefix(name: string, localBackend: boolean): string {
  switch (name) {
    case 'shelf':
      return 'shelf';
    case 'shelf-archive':
      return `shelf/${ARCHIVE_FOLDER}`;
    case 'collection':
      return 'books';
    case 'collection-archive':
      return 'archive';
    case 'shared':
      return localBackend ? 'shared' : 'books';
    default:
      return localBackend ? 'shared/archive' : 'archive';
  }
}

type Place = 'shelf' | 'collection' | 'shared';

function splitManifestCollection(name: string, localBackend: boolean): { collection: Place; shelf: 'active' | 'archive'; prefix: string } {
  if (!MANIFEST_COLLECTIONS.includes(name)) {
    throw new Error(`Book manifest collection '${name}' must be one of: ${MANIFEST_COLLECTIONS.join(', ')}.`);
  }
  const shelf = name.endsWith('-archive') ? 'archive' : 'active';
  const collection = (shelf === 'archive' ? name.substring(0, name.length - '-archive'.length) : name) as Place;
  return { collection, shelf, prefix: collectionPrefix(name, localBackend) };
}

interface DiscoveryHit {
  book: string;
  book_root: string;
  book_title: string;
  book_kind: string;
  book_open: boolean;
  book_shelf: string;
  collection: string;
  page: string | null;
  heading: string | null;
  match_field: string;
  overlap: string | null;
}

interface UnavailableBook {
  book: string;
  book_root: string;
  book_title: string;
  collection: string;
  book_shelf: string;
  book_open: boolean;
  status: string;
  reason: string;
  repair: string;
}

/**
 * A record names two Books, and the SAME record reads differently from each side -- canonical from
 * one is superseded from the other.
 */
function formatOverlap(slug: string, record: Record<string, unknown>): string {
  const topic = String(record['topic']);
  const relationship = String(record['relationship']);
  const resolution = String(record['resolution']);
  if (slug === String(record['book'])) {
    const other = String(record['counterpart']);
    if (relationship === 'canonical') return `canonical for '${topic}' over ${other} (resolution: ${resolution})`;
    if (relationship === 'complementary') return `complementary with ${other} on '${topic}' (resolution: ${resolution})`;
    if (relationship === 'unverified') return `unverified overlap with ${other} on '${topic}' (resolution: ${resolution})`;
    return `${relationship} overlap with ${other} on '${topic}' (resolution: ${resolution})`;
  }
  const other = String(record['book']);
  if (relationship === 'canonical') return `superseded for '${topic}' by ${other} (resolution: ${resolution})`;
  if (relationship === 'complementary') return `complementary with ${other} on '${topic}' (resolution: ${resolution})`;
  if (relationship === 'unverified') return `unverified overlap with ${other} on '${topic}' (resolution: ${resolution})`;
  return `${relationship} overlap with ${other} on '${topic}' (resolution: ${resolution})`;
}

/**
 * An unreadable or malformed record file must NOT take the query down: an overlap mark is an
 * annotation on an answer, and losing the annotation is not losing the answer.
 */
function overlapIndex(workspace: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const file = path.join(workspace, 'internal', 'overlap-records.json');
  if (!fs.existsSync(file)) return index;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readUtf8(file)) as Record<string, unknown>;
  } catch {
    return index;
  }
  if (data === null || typeof data !== 'object' || !('records' in data)) return index;
  for (const record of (data['records'] as Record<string, unknown>[]) ?? []) {
    if (record === null || typeof record !== 'object') continue;
    const complete = ['topic', 'book', 'counterpart', 'relationship', 'resolution'].every((field) => field in record);
    if (!complete) continue;
    for (const side of [String(record['book']), String(record['counterpart'])]) {
      if (!side.trim()) continue;
      const marks = index.get(side) ?? [];
      marks.push(formatOverlap(side, record));
      index.set(side, marks);
    }
  }
  return index;
}

function overlapStatus(index: Map<string, string[]>, slug: string): string | null {
  const marks = index.get(slug);
  if (!marks || !marks.length) return null;
  return marks.join('; ');
}

/** The same section shape `getShelfBook` matches, in catalog order, so a result set reads in it. */
function catalogSlugs(catalogText: string): string[] {
  return [...catalogText.matchAll(/^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/gm)].map(
    (match) => match[1]!,
  );
}

/** A missing `.open-books` reads as every Book CLOSED, which is the fail-safe direction. */
function openRoots(deskStateDirectory: string): string[] {
  const file = path.join(deskStateDirectory, '.open-books');
  if (!fs.existsSync(file)) return [];
  return readUtf8(file)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function archivedShelfBookSlugs(workspace: string): string[] {
  const root = path.join(workspace, 'shelf', ARCHIVE_FOLDER);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (item) =>
        item.isDirectory() &&
        /^[a-z0-9][a-z0-9-]*$/.test(item.name) &&
        fs.existsSync(path.join(root, item.name, ARCHIVE_RECORD_NAME)),
    )
    .map((item) => item.name)
    .sort();
}

interface LivePage {
  path: string;
  title: string;
  headings: Heading[];
}

/** The one live read, and it happens only for an OPEN capture Book. Nothing is written. */
function discoveryLivePages(wikiRoot: string): LivePage[] {
  if (!fs.existsSync(wikiRoot)) return [];
  let files = listFilesRecursive(wikiRoot).filter((file) => file.toLowerCase().endsWith('.md'));
  if (files.length > MAX_PAGES_PER_BOOK) files = files.slice(0, MAX_PAGES_PER_BOOK);
  return files.map((file) => {
    const headings = getMarkdownHeadings(readUtf8(file));
    const firstH1 = headings.filter((heading) => heading.level === 1);
    return {
      path: file.substring(wikiRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/').replace(/\.md$/, ''),
      title: firstH1.length ? firstH1[0]!.text : '',
      headings,
    };
  });
}

/** The shared collection's roster. Unreadable or malformed reads as NO roster, honestly out of scope. */
function sharedRoster(workspace: string, manifestCollection = 'shared'): { slugs: string[]; asOf: string } | null {
  const file = path.join(workspace, 'internal', 'book-manifests', manifestCollection, '_roster.json');
  if (!fs.existsSync(file)) return null;
  try {
    const roster = JSON.parse(readUtf8(file)) as Record<string, unknown>;
    if (!('books' in roster)) return null;
    const slugs = ((roster['books'] as Record<string, unknown>[]) ?? [])
      .map((entry) => String(entry['slug']))
      .filter((slug) => /^[a-z0-9][a-z0-9-]*$/.test(slug));
    if (!slugs.length) return null;
    return { slugs, asOf: 'generated_utc' in roster ? String(roster['generated_utc']) : '' };
  } catch {
    return null;
  }
}

/**
 * EACH HIT CARRIES ITS PLACE, HANDED IN, never inferred from the root's prefix (PLAN-basic-memory.md step 1,
 * Fable #6): `books/<slug>` is the Local collection on a local Library and the shared collection elsewhere, so
 * a prefix alone labelled a local Library's own Book `shared`.
 */
function newHit(options: {
  slug: string;
  bookRoot: string;
  bookTitle: string;
  kind: string;
  isOpen: boolean;
  page: string | null;
  heading: string | null;
  matchField: string;
  overlap: string | null;
  place: Place;
}): DiscoveryHit {
  const parts = parseBookRoot(options.bookRoot);
  if (parts === null || parts.root !== options.bookRoot) throw new Error('Virtual Desk open-book state is malformed.');
  return {
    book: options.slug,
    book_root: options.bookRoot,
    book_title: options.bookTitle,
    book_kind: options.kind,
    book_open: options.isOpen,
    book_shelf: parts.shelf,
    collection: options.place,
    page: options.page,
    heading: options.heading,
    match_field: options.matchField,
    overlap: options.overlap,
  };
}

/**
 * Every hit ONE Book's manifest contributes. Shared by both collections rather than written twice,
 * so the shared collection cannot acquire a second extraction with its own rules.
 */
function bookHits(options: {
  slug: string;
  bookRoot: string;
  manifest: Record<string, unknown>;
  kind: string;
  isOpen: boolean;
  needle: string;
  overlap: string | null;
  livePages: LivePage[];
  place: Place;
}): DiscoveryHit[] {
  const hits: DiscoveryHit[] = [];
  const title = String(options.manifest['title'] ?? '');
  const base = {
    slug: options.slug,
    bookRoot: options.bookRoot,
    bookTitle: title,
    kind: options.kind,
    isOpen: options.isOpen,
    overlap: options.overlap,
    place: options.place,
  };

  if (testSearchContains(title, options.needle)) {
    hits.push(newHit({ ...base, page: null, heading: title, matchField: 'book-title' }));
  }
  for (const topic of (options.manifest['topics'] as string[] | undefined) ?? []) {
    if (testSearchContains(String(topic), options.needle)) {
      hits.push(newHit({ ...base, page: null, heading: String(topic), matchField: 'topic' }));
    }
  }
  // The summary matched, and the summary is NOT returned: the Book Catalog is where the reader
  // reads it, and a hit only has to say which Book to consider.
  if (testSearchContains(String(options.manifest['summary'] ?? ''), options.needle)) {
    hits.push(newHit({ ...base, page: null, heading: null, matchField: 'book-summary' }));
  }

  let pages: { path: string; title: string; headings: Heading[] }[] = [];
  if (options.kind === 'capture') {
    pages = options.livePages;
  } else {
    pages = ((options.manifest['pages'] as Record<string, unknown>[] | undefined) ?? []).map((page) => ({
      path: String(page['path'] ?? ''),
      title: String(page['title'] ?? ''),
      headings: ((page['headings'] as Record<string, unknown>[] | undefined) ?? []).map((heading) => ({
        level: Number(heading['level'] ?? 0),
        text: String(heading['text'] ?? ''),
      })),
    }));
    const readerMap = options.manifest['reader_map'] as Record<string, unknown> | null | undefined;
    if (readerMap !== null && readerMap !== undefined) {
      const pagePaths = new Set(pages.map((page) => page.path));
      // Only the map's LINKS are scanned here. Its headings are already covered, because `_index.md`
      // is a page of the Book like any other -- reporting them twice would inflate one match.
      for (const link of ((readerMap['links'] as Record<string, unknown>[] | undefined) ?? [])) {
        const target = String(link['target'] ?? '');
        const label = String(link['label'] ?? '');
        if (!testSearchContains(target, options.needle) && !testSearchContains(label, options.needle)) continue;
        // Only a target the manifest also lists as a page becomes a page path: a reader map can
        // point at something gone, and handing back a path that fails to open is worse than handing
        // back the Book.
        const linkPage = pagePaths.has(target) ? target : null;
        hits.push(newHit({ ...base, page: linkPage, heading: label.trim() ? label : target, matchField: 'reader-map' }));
      }
    }
  }

  for (const page of pages) {
    if (testSearchContains(page.title, options.needle)) {
      hits.push(newHit({ ...base, page: page.path, heading: page.title, matchField: 'page-title' }));
    }
    for (const heading of page.headings) {
      // The page title IS the first H1, so reporting both would be one match twice.
      if (heading.level === 1 && page.title.length > 0 && heading.text === page.title) continue;
      if (testSearchContains(heading.text, options.needle)) {
        hits.push(newHit({ ...base, page: page.path, heading: heading.text, matchField: 'heading' }));
      }
    }
  }

  return hits;
}

export interface DiscoveryResult {
  schema: number;
  query: string;
  scope: string;
  shared_books_covered: boolean;
  shared_roster_as_of: string;
  shared_books_note: string;
  archive_note: string;
  shared_archive_covered: boolean;
  shared_archive_roster_as_of: string;
  shelf_books_total: number;
  shelf_books_searched: number;
  shared_books_total: number;
  shared_books_searched: number;
  shelf_archive_books_total: number;
  shelf_archive_books_searched: number;
  shared_archive_books_total: number;
  shared_archive_books_searched: number;
  collection_books_total: number;
  collection_books_searched: number;
  collection_archive_books_total: number;
  collection_archive_books_searched: number;
  collection_note: string;
  books_total: number;
  books_searched: number;
  books_unavailable: UnavailableBook[];
  match_count: number;
  result_count: number;
  truncated: boolean;
  max_results: number;
  results: DiscoveryHit[];
}

export function findBookPages(options: {
  workspace: string;
  query: string;
  maxResults?: number;
  deskStateDirectory: string;
}): DiscoveryResult {
  const root = path.resolve(options.workspace);
  const needle = assertSearchQuery(options.query);
  const maxResults = resolveSearchResultCap(options.maxResults ?? DEFAULT_MAX_RESULTS);

  const catalogPath = path.join(root, 'shelf', '_catalog.md');
  if (!fs.existsSync(catalogPath)) throw new Error('This workspace has no local Shelf catalog.');
  const slugs = catalogSlugs(readUtf8(catalogPath));

  const overlaps = overlapIndex(root);
  const open = openRoots(options.deskStateDirectory);
  const localBackend = isLocalBackend(root);

  const roster = sharedRoster(root, 'shared');
  const sharedSlugs = roster ? roster.slugs : [];
  const sharedRosterAsOf = roster ? roster.asOf : '';

  // THE LOCAL COLLECTION'S ROSTER IS ITS DISK, both halves, read offline like the Shelf archive. A workspace
  // attached to Basic Memory has no Local collection of its own: its `books/` IS the shared collection.
  const collectionSlugs = localBackend ? collectionBookSlugs(root, 'active') : [];
  const collectionArchiveSlugs = localBackend ? collectionBookSlugs(root, 'archive') : [];

  // The Shelf archive needs no roster file: it is a local directory, readable offline. The SHARED
  // archive does, for the same reason the active shared collection does -- it is behind MCP, and
  // nothing here reaches the network.
  const shelfArchiveSlugs = archivedShelfBookSlugs(root);
  const archiveRoster = sharedRoster(root, 'shared-archive');
  const sharedArchiveSlugs = archiveRoster ? archiveRoster.slugs : [];
  const sharedArchiveRosterAsOf = archiveRoster ? archiveRoster.asOf : '';

  const rosters: Record<string, { slugs: string[]; repair: string }> = {
    shelf: { slugs, repair: REPAIR_HINT },
    shared: { slugs: sharedSlugs, repair: SHARED_REPAIR_HINT },
    'shelf-archive': { slugs: shelfArchiveSlugs, repair: SHELF_ARCHIVE_REPAIR_HINT },
    'shared-archive': { slugs: sharedArchiveSlugs, repair: SHARED_ARCHIVE_REPAIR_HINT },
    collection: { slugs: collectionSlugs, repair: COLLECTION_REPAIR_HINT },
    'collection-archive': { slugs: collectionArchiveSlugs, repair: COLLECTION_REPAIR_HINT },
  };

  const hits: { order: number; rank: number; hit: DiscoveryHit }[] = [];
  const unavailable: UnavailableBook[] = [];
  const searchedByCollection: Record<string, number> = {};
  for (const name of MANIFEST_COLLECTIONS) searchedByCollection[name] = 0;
  let order = 0;

  for (const manifestCollection of MANIFEST_COLLECTIONS) {
    const plan = rosters[manifestCollection];
    if (plan === undefined) {
      throw new Error(
        `Discovery has no roster for the '${manifestCollection}' Book collection, so it cannot say whether that collection was searched.`,
      );
    }
    const parts = splitManifestCollection(manifestCollection, localBackend);
    const isLocal = parts.collection === 'shelf';
    for (const slug of plan.slugs) {
      order += 1;
      const bookRoot = `${parts.prefix}/${slug}`;
      const isOpen = open.includes(bookRoot);
      const overlap = overlapStatus(overlaps, slug);

      // RESOLVED INSIDE A TRY. A slug the catalog cannot resolve used to throw straight out of the
      // query, taking the whole answer down; naming the Book and carrying on is what this tier does
      // for every other unreadable state.
      let book: ShelfBook | null = null;
      let resolveFailure = '';
      if (isLocal) {
        try {
          book = parts.shelf === 'archive' ? getArchivedShelfBook(root, slug) : getShelfBook(root, slug);
        } catch (error) {
          resolveFailure = (error as Error).message;
        }
      }

      const stored = resolveFailure ? null : getStoredBookManifest(root, slug, manifestCollection);
      if (resolveFailure || stored === null || stored.status !== 'ok') {
        unavailable.push({
          book: slug,
          book_root: bookRoot,
          book_title: book !== null ? book.title : slug,
          collection: parts.collection,
          book_shelf: parts.shelf,
          book_open: isOpen,
          status: resolveFailure ? 'unresolvable' : stored!.status,
          reason: resolveFailure ? resolveFailure : stored!.reason,
          repair: plan.repair,
        });
        continue;
      }
      searchedByCollection[manifestCollection] = (searchedByCollection[manifestCollection] ?? 0) + 1;
      const manifest = stored.manifest!;

      // The union rule: either signal saying capture is enough. It cannot widen disclosure -- the
      // live path is gated on the Book being open, not on its kind -- but a Book reported as
      // curated while its catalog calls it capture would be a lie in the answer.
      const kind = manifest['kind'] === 'capture' || (book !== null && book.isCapture) ? 'capture' : 'curated';

      const livePages = kind === 'capture' && isOpen && book !== null ? discoveryLivePages(book.wikiPath) : [];

      for (const hit of bookHits({ slug, bookRoot, manifest, kind, isOpen, needle, overlap, livePages, place: parts.collection })) {
        hits.push({ order, rank: FIELD_RANK[hit.match_field] ?? 99, hit });
      }
    }
  }

  const shelfSearched = searchedByCollection['shelf'] ?? 0;
  const sharedSearched = searchedByCollection['shared'] ?? 0;
  const shelfArchiveSearched = searchedByCollection['shelf-archive'] ?? 0;
  const sharedArchiveSearched = searchedByCollection['shared-archive'] ?? 0;
  const collectionSearched = searchedByCollection['collection'] ?? 0;
  const collectionArchiveSearched = searchedByCollection['collection-archive'] ?? 0;

  const sorted = [...hits].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    if (left.rank !== right.rank) return left.rank - right.rank;
    const leftPage = left.hit.page ?? '';
    const rightPage = right.hit.page ?? '';
    if (leftPage !== rightPage) return leftPage < rightPage ? -1 : 1;
    const leftHeading = left.hit.heading ?? '';
    const rightHeading = right.hit.heading ?? '';
    if (leftHeading !== rightHeading) return leftHeading < rightHeading ? -1 : 1;
    return 0;
  });
  const returned = sorted.slice(0, maxResults).map((entry) => entry.hit);

  // The coverage sentence is computed from what actually HAPPENED, never from the fact that a loop
  // ran. Claiming the shared collection while one of its Books was unreadable is the same silent
  // partial as dropping a Shelf Book, so "partial" is a state of its own and names the shortfall.
  const sharedUnavailable = unavailable.filter(
    (entry) => entry.collection === 'shared' && entry.book_shelf === 'active',
  ).length;
  const sharedCovered = sharedSlugs.length > 0;
  // A Book added to the shared catalog since the last backfill is not merely unread, it is UNKNOWN,
  // and no count can reveal it. Saying how old the roster is turns a blind spot into a judgement
  // the reader can make.
  const asOfText = !sharedRosterAsOf.trim()
    ? ''
    : ` Shared Book list as of ${sharedRosterAsOf.substring(0, Math.min(10, sharedRosterAsOf.length))}; a Book added since then is not in this answer.`;
  // A LOCAL LIBRARY WITH A CONNECTION HAS NO REBUILDER FOR ITS SHARED MANIFESTS YET (step 5): the rebuild is
  // PowerShell, which a release does not ship. So that absence is named as what it is, not as a script to run.
  const connected = localBackend && markerConnection(root) !== null;
  const sharedNote = !sharedCovered
    ? connected
      ? SHARED_NOTE_NOT_REBUILT
      : SHARED_NOTE_NONE
    : sharedUnavailable > 0
      ? `Shared collection: ${sharedSearched} of ${sharedSlugs.length} Books searched -- ${sharedUnavailable} could not be read, named below, so this answer is PARTIAL for the shared collection.${asOfText}`
      : `Shared collection: all ${sharedSearched} Book(s) searched.${asOfText}`;

  // THE ARCHIVE SENTENCE IS SEPARATE AND UNCONDITIONAL. An archive with nothing in it still says
  // so, because "no archived Books" and "archived Books not searched" are different facts and a
  // reader cannot tell them apart from silence.
  const shelfArchiveUnavailable = unavailable.filter(
    (entry) => entry.collection === 'shelf' && entry.book_shelf === 'archive',
  ).length;
  const sharedArchiveUnavailable = unavailable.filter(
    (entry) => entry.collection === 'shared' && entry.book_shelf === 'archive',
  ).length;
  const archiveParts: string[] = [];
  archiveParts.push(
    !shelfArchiveSlugs.length
      ? 'the Shelf archive holds no Books'
      : shelfArchiveUnavailable > 0
        ? `Shelf archive: ${shelfArchiveSearched} of ${shelfArchiveSlugs.length} searched -- ${shelfArchiveUnavailable} could not be read, named below`
        : `Shelf archive: all ${shelfArchiveSearched} Book(s) searched`,
  );
  archiveParts.push(
    archiveRoster === null
      ? SHARED_ARCHIVE_NOTE_NONE
      : sharedArchiveUnavailable > 0
        ? `shared archive: ${sharedArchiveSearched} of ${sharedArchiveSlugs.length} searched -- ${sharedArchiveUnavailable} could not be read, named below`
        : `shared archive: all ${sharedArchiveSearched} Book(s) searched`,
  );

  // THE LOCAL COLLECTION IS NAMED WHENEVER IT HOLDS A BOOK, active or archived, and its partial state is a
  // state of its own as the shared collection's is. A Library whose collection holds none reads exactly as it
  // did before the pair existed: there is nothing there to have searched or to have missed.
  const collectionHasBooks = collectionSlugs.length + collectionArchiveSlugs.length > 0;
  const collectionUnavailable = unavailable.filter((entry) => entry.collection === 'collection').length;
  const collectionNote = !collectionHasBooks
    ? ''
    : `Local collection: ${collectionSearched} of ${collectionSlugs.length} Book(s) searched, and ${collectionArchiveSearched} of ` +
      `${collectionArchiveSlugs.length} archived` +
      (collectionUnavailable > 0 ? ` -- ${collectionUnavailable} could not be read, named below, so this answer is PARTIAL for it.` : '.');
  const places = ['local Shelf', ...(collectionHasBooks ? ['Local collection'] : []), ...(sharedCovered ? ['shared collection'] : [])];
  const scope = `${places.length === 3 ? `${places[0]}, ${places[1]} and ${places[2]}` : places.join(' and ')}, including what is archived`;

  return {
    schema: DISCOVERY_SCHEMA,
    query: convertToSearchDisplay(options.query),
    scope,
    shared_books_covered: sharedCovered,
    shared_roster_as_of: sharedRosterAsOf,
    shared_books_note: sharedNote,
    archive_note: `Archived Books are covered and labelled -- ${archiveParts.join('; ')}.`,
    shared_archive_covered: archiveRoster !== null,
    shared_archive_roster_as_of: sharedArchiveRosterAsOf,
    shelf_books_total: slugs.length,
    shelf_books_searched: shelfSearched,
    shared_books_total: sharedSlugs.length,
    shared_books_searched: sharedSearched,
    shelf_archive_books_total: shelfArchiveSlugs.length,
    shelf_archive_books_searched: shelfArchiveSearched,
    shared_archive_books_total: sharedArchiveSlugs.length,
    shared_archive_books_searched: sharedArchiveSearched,
    collection_books_total: collectionSlugs.length,
    collection_books_searched: collectionSearched,
    collection_archive_books_total: collectionArchiveSlugs.length,
    collection_archive_books_searched: collectionArchiveSearched,
    collection_note: collectionNote,
    books_total: slugs.length + sharedSlugs.length + shelfArchiveSlugs.length + sharedArchiveSlugs.length + collectionSlugs.length + collectionArchiveSlugs.length,
    books_searched: shelfSearched + sharedSearched + shelfArchiveSearched + sharedArchiveSearched + collectionSearched + collectionArchiveSearched,
    books_unavailable: unavailable,
    match_count: sorted.length,
    result_count: returned.length,
    truncated: sorted.length > returned.length,
    max_results: maxResults,
    results: returned,
  };
}

/** The coverage line comes FIRST and unconditionally: a Discovery answer must never look complete. */
export function formatDiscoveryResult(result: DiscoveryResult): string {
  const lines: string[] = [];
  lines.push(`Discovery over the ${result.scope} for: ${result.query}`);
  lines.push(
    `${result.result_count} result(s) from ${result.books_searched} of ${result.books_total} Book(s) -- Shelf ` +
      `${result.shelf_books_searched}/${result.shelf_books_total}, shared ${result.shared_books_searched}/${result.shared_books_total}, ` +
      `Shelf archive ${result.shelf_archive_books_searched}/${result.shelf_archive_books_total}, shared archive ` +
      `${result.shared_archive_books_searched}/${result.shared_archive_books_total}. ${result.shared_books_note}`,
  );
  if (result.collection_note) lines.push(result.collection_note);
  lines.push(result.archive_note);
  if (result.truncated) {
    lines.push(
      `Showing the first ${result.result_count} of ${result.match_count} matches; ask for more with a larger result cap.`,
    );
  }
  if (result.books_unavailable.length) {
    lines.push('');
    lines.push('Books this query could NOT read, so this answer is incomplete for them:');
    for (const entry of result.books_unavailable) {
      lines.push(`- ${entry.book} [${entry.book_root}] (${entry.status}): ${entry.reason} -- ${entry.repair}`);
    }
  }
  lines.push('');
  if (!result.results.length) {
    lines.push('No manifest in the Books this query could read carries that term.');
  } else {
    // Grouped on the ROOT, not the slug: `shelf/notes` and `shelf/_archive/notes` are two different
    // Books that share a name, and one heading over both would attribute an archived Book's pages
    // to its active twin.
    let currentBook = '';
    for (const hit of result.results) {
      if (hit.book_root !== currentBook) {
        currentBook = hit.book_root;
        const openText = hit.book_open ? 'open' : 'closed';
        const overlapText = hit.overlap !== null ? ` -- overlap: ${hit.overlap}` : '';
        // ARCHIVED IS SAID, NOT IMPLIED: a retired Book that reads like a current one is the cost
        // of covering the archive at all, so the label rides every hit group.
        const shelfText = hit.book_shelf === 'archive' ? ', ARCHIVED' : '';
        lines.push('');
        lines.push(`${hit.book_title} [${hit.book_root}, ${hit.book_kind}, ${openText}${shelfText}]${overlapText}`);
      }
      const where = hit.page !== null ? hit.page : '(Book level)';
      const what = hit.heading !== null ? ` -- ${hit.heading}` : '';
      lines.push(`  ${hit.match_field}: ${where}${what}`);
    }
  }
  lines.push('');
  lines.push(CLOSING_RULE);
  return lines.join('\n');
}
