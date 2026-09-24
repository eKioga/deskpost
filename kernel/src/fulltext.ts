/**
 * `search_open_books` -- the full text of Shelf Books that are OPEN on the Desk, and no other.
 *
 * A CLOSED BOOK IS NOT SEARCHED AND IS NOT LISTED. Closed-Book coverage is Discovery's job, over
 * metadata rather than bodies; this tier reads bodies, so the Desk is what decides whether it may
 * read anything at all.
 *
 * THE DESK IS READ TWICE, AND THE SECOND READ IS UNCONDITIONAL. A Book that was open when the query
 * started and is closed by the time the answer is emitted must contribute nothing, because serving
 * its lines would be serving a closed Book's body whatever the Desk said a moment earlier.
 * Everything attributable to that Book goes with it -- its lines, its withheld pages, its place in
 * the searched count -- because a tier that dropped the lines and kept the count would report
 * coverage it did not have.
 *
 * THE COVERAGE LINES COME FIRST AND UNCONDITIONALLY. An answer that looks complete when a Book was
 * skipped, out of scope, or closed underneath it is worse than no answer.
 *
 * A SHARED BOOK OPEN ON THE DESK IS NAMED, NEVER SEARCHED. Its pages arrive one network read at a
 * time, which no query-time budget can complete, so it is reported as out of scope with the route
 * that does work.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertSearchQuery,
  convertToSearchDisplay,
  getSearchBudgetNote,
  newSearchBudget,
  testSearchBudgetAcceptsText,
  testSearchBudgetSpent,
  testSearchContains,
  type SearchBudget,
} from './rawsearch.ts';
import { getArchivedShelfBook, getShelfBook, listFilesRecursive, readUtf8, type ShelfBook } from './shelfbook.ts';

const FULL_TEXT_SCHEMA = 1;

/** The Book tiers' own budget values, which differ from `raw/`'s walk. */
const DEFAULT_MAX_RESULTS = 50;
const MAX_MATCHED_BYTES = 65536;
const MAX_COLLECTED_MATCHES = 5000;
const MAX_LINE_CHARACTERS = 400;
const WALL_CLOCK_SECONDS = 10;
const MAX_FILES_SCANNED = 5000;
const MAX_FILE_BYTES = 2097152;

const CLOSED_NOTE =
  'Closed Books are not searched at all and are not listed here. Use discover_book_pages to find which Book covers a subject.';
const SHARED_NOTE =
  "Full text covers the local Shelf only. A shared Book's pages arrive one read over the network at a time, which no " +
  'query-time budget can complete, so an open shared Book is named below rather than searched.';
const SHARED_ALTERNATIVE = 'read it a page at a time with read_open_book_page, or use discover_book_pages for its headings';
const CLOSING_RULE =
  'A hit is a location, not a reading: a matched line says the term occurs on that page. Open the page with ' +
  'read_open_book_page before answering from it.';

interface ParsedRoot {
  root: string;
  collection: 'shelf' | 'shared';
  shelf: 'active' | 'archive';
  slug: string;
  wikiRoot: string;
}

/**
 * A Desk entry parsed into what a reader of it needs. An ARCHIVED shared Book is `archive/<slug>`,
 * where a fixed offset into `shelf/` is simply wrong -- which is why this is one parser rather than
 * a substring per caller.
 */
export function splitBookRoot(entry: string): ParsedRoot | null {
  const normalised = /^[a-z0-9][a-z0-9-]*$/.test(entry) ? `books/${entry}` : entry;
  const match = /^(shelf\/_archive|books|archive|shelf)\/([a-z0-9][a-z0-9-]*)$/.exec(normalised);
  if (!match) return null;
  const prefix = match[1]!;
  const slug = match[2]!;
  const collection = prefix === 'shelf' || prefix === 'shelf/_archive' ? 'shelf' : 'shared';
  const shelf = prefix === 'archive' || prefix === 'shelf/_archive' ? 'archive' : 'active';
  return { root: normalised, collection, shelf, slug, wikiRoot: `${normalised}/wiki` };
}

/**
 * The seat's open-Book roots. A MISSING `.open-books` READS AS EVERY BOOK CLOSED, which is the
 * fail-safe direction: a Book that cannot be proved open is one whose bodies must not be read.
 */
function openBookRoots(deskStateDirectory: string): string[] {
  const file = path.join(deskStateDirectory, '.open-books');
  if (!fs.existsSync(file)) return [];
  return readUtf8(file)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function convertToCanonicalPagePath(wikiRoot: string, full: string): string {
  return full
    .substring(wikiRoot.length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/')
    .replace(/\.md$/, '');
}

function bookPageFiles(wikiPath: string): string[] {
  if (!fs.existsSync(wikiPath)) return [];
  return listFilesRecursive(wikiPath).filter((file) => file.toLowerCase().endsWith('.md'));
}

/** Containment, and the reparse-point walk that makes it mean something. */
function pathIsContained(root: string, full: string): boolean {
  const rootFull = path.resolve(root).replace(/[\\/]+$/, '');
  const resolved = path.resolve(full);
  if (!resolved.toLowerCase().startsWith((rootFull + path.sep).toLowerCase())) return false;
  let current = resolved;
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) return false;
    if (parent.replace(/[\\/]+$/, '') === rootFull) return true;
    current = parent;
  }
}

function convertToSearchLine(value: string): { text: string; truncated: boolean } {
  const display = convertToSearchDisplay(value);
  if (display.length <= MAX_LINE_CHARACTERS) return { text: display, truncated: false };
  return { text: display.substring(0, MAX_LINE_CHARACTERS), truncated: true };
}

interface FullTextHit {
  book: string;
  book_root: string;
  book_title: string;
  book_kind: string;
  book_shelf: string;
  page: string;
  line: number;
  text: string;
  line_truncated: boolean;
}

export interface FullTextResult {
  schema: number;
  query: string;
  scope: string;
  books_open_total: number;
  shelf_books_open: number;
  shared_books_open: number;
  books_searched: number;
  books_unavailable: Record<string, unknown>[];
  books_out_of_scope: Record<string, unknown>[];
  books_closed_during_query: Record<string, unknown>[];
  capture_books: string[];
  pages_withheld: Record<string, unknown>[];
  pages_scanned: number;
  match_count: number;
  match_count_is_floor: boolean;
  result_count: number;
  truncated: boolean;
  max_results: number;
  budget_note: string;
  results: FullTextHit[];
}

export function findOpenBookLines(options: {
  workspace: string;
  query: string;
  maxResults?: number;
  deskStateDirectory: string;
}): FullTextResult {
  const root = path.resolve(options.workspace);
  const needle = assertSearchQuery(options.query);
  const cap = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const budget: SearchBudget = newSearchBudget({
    wallClockSeconds: WALL_CLOCK_SECONDS,
    maxMatchedBytes: MAX_MATCHED_BYTES,
    maxFilesScanned: MAX_FILES_SCANNED,
    maxCollectedMatches: MAX_COLLECTED_MATCHES,
  });

  const parsedRoots = openBookRoots(options.deskStateDirectory)
    .map((entry) => splitBookRoot(entry))
    .filter((entry): entry is ParsedRoot => entry !== null);
  const shelfBooksOpen = parsedRoots
    .filter((entry) => entry.collection === 'shelf')
    .sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));
  const sharedSlugs = parsedRoots
    .filter((entry) => entry.collection === 'shared')
    .map((entry) => entry.slug)
    .sort();

  const hits: { order: number; hit: FullTextHit }[] = [];
  const unavailable: Record<string, unknown>[] = [];
  const withheld: Record<string, unknown>[] = [];
  let captureBooks: string[] = [];
  let searched: string[] = [];
  let pagesScanned = 0;
  let order = 0;

  for (const openBook of shelfBooksOpen) {
    const slug = openBook.slug;
    const isArchived = openBook.shelf === 'archive';
    order += 1;
    // A Book the catalog does not list, or whose wiki directory is gone, is NAMED. Dropping it
    // would make the answer look like it covered every open Book.
    let book: ShelfBook;
    try {
      book = isArchived ? getArchivedShelfBook(root, slug) : getShelfBook(root, slug);
    } catch (error) {
      unavailable.push({
        book: slug,
        book_root: openBook.root,
        book_title: slug,
        collection: 'shelf',
        book_shelf: openBook.shelf,
        reason: (error as Error).message,
        // The repair has to match where the Book actually is: sending a reader to shelf/_catalog.md
        // for an ARCHIVED Book is advice that cannot work, because archiving removed that entry.
        repair: isArchived
          ? `check shelf/_archive/${slug}/_archived.json is intact, or close the Book with tools/Set-VirtualDesk.ps1`
          : 'check shelf/_catalog.md lists this Book, or close it with tools/Set-VirtualDesk.ps1',
      });
      continue;
    }
    if (!fs.existsSync(book.wikiPath)) {
      unavailable.push({
        book: slug,
        book_root: openBook.root,
        book_title: book.title,
        collection: 'shelf',
        book_shelf: openBook.shelf,
        reason: `This Book has no pages directory at ${openBook.wikiRoot}.`,
        repair: 'restore the Book directory, or close it with tools/Set-VirtualDesk.ps1',
      });
      continue;
    }

    const kind = book.isCapture ? 'capture' : 'curated';
    searched.push(openBook.root);
    const wikiRoot = path.resolve(book.wikiPath);
    let contributed = false;

    for (const file of bookPageFiles(book.wikiPath)) {
      if (testSearchBudgetSpent(budget)) break;

      // Containment, applied to every page BEFORE it is opened: a junction inside a Book's wiki
      // would otherwise let this read another Book, because every file below it still reports a
      // path under this Book's root.
      if (!pathIsContained(wikiRoot, file)) {
        withheld.push({
          book: slug,
          book_root: openBook.root,
          page: convertToCanonicalPagePath(wikiRoot, file),
          reason: 'the page resolves outside this Book, or through a reparse point; its content was withheld',
        });
        continue;
      }
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        withheld.push({
          book: slug,
          book_root: openBook.root,
          page: convertToCanonicalPagePath(wikiRoot, file),
          reason: `the page is ${size} bytes, above the ${MAX_FILE_BYTES}-byte per-page cap; it was not scanned`,
        });
        continue;
      }

      budget.filesScanned += 1;
      pagesScanned += 1;
      const page = convertToCanonicalPagePath(wikiRoot, file);
      const text = fs.readFileSync(file, 'utf8');

      let lineNumber = 0;
      for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        lineNumber += 1;
        if (!testSearchContains(line, needle)) continue;
        const rendered = convertToSearchLine(line);
        hits.push({
          order,
          hit: {
            book: slug,
            book_root: openBook.root,
            book_title: book.title,
            book_kind: kind,
            book_shelf: openBook.shelf,
            page,
            line: lineNumber,
            text: rendered.text,
            line_truncated: rendered.truncated,
          },
        });
        budget.collectedMatches += 1;
        contributed = true;
        if (testSearchBudgetSpent(budget)) break;
      }
    }

    if (contributed && kind === 'capture') captureBooks.push(openBook.root);
  }

  // SECOND READ, unconditional. Compared as ROOTS rather than as a composed `shelf/<slug>`: an
  // archived Book's root is `shelf/_archive/<slug>`, so a composed form would declare every
  // archived Book closed-during-query and silently drop its lines.
  const closedDuringQuery: Record<string, unknown>[] = [];
  const endRoots = openBookRoots(options.deskStateDirectory);
  const stillOpen = new Set<string>();
  for (const bookRoot of searched) {
    if (endRoots.includes(bookRoot)) {
      stillOpen.add(bookRoot);
      continue;
    }
    closedDuringQuery.push({ book: splitBookRoot(bookRoot)?.slug ?? bookRoot, book_root: bookRoot });
  }
  let live = hits;
  let liveWithheld = withheld;
  if (closedDuringQuery.length) {
    live = hits.filter((entry) => stillOpen.has(entry.hit.book_root));
    liveWithheld = withheld.filter((entry) => stillOpen.has(String(entry['book_root'])));
    captureBooks = captureBooks.filter((entry) => stillOpen.has(entry));
    searched = searched.filter((entry) => stillOpen.has(entry));
  }

  const sorted = [...live].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    if (left.hit.page !== right.hit.page) return left.hit.page < right.hit.page ? -1 : 1;
    return left.hit.line - right.hit.line;
  });

  const returned: FullTextHit[] = [];
  for (const entry of sorted.slice(0, cap)) {
    if (!testSearchBudgetAcceptsText(budget, entry.hit.text, returned.length === 0)) break;
    returned.push(entry.hit);
  }

  const outOfScope = sharedSlugs.map((slug) => ({
    book: slug,
    collection: 'shared',
    reason: 'a shared Book has no local pages to scan, and reading one over the network is a backfill rather than a query',
    alternative: SHARED_ALTERNATIVE,
  }));

  return {
    schema: FULL_TEXT_SCHEMA,
    query: convertToSearchDisplay(options.query),
    scope: 'Shelf Books open on the Desk',
    books_open_total: shelfBooksOpen.length + sharedSlugs.length,
    shelf_books_open: shelfBooksOpen.length,
    shared_books_open: sharedSlugs.length,
    books_searched: searched.length,
    books_unavailable: unavailable,
    books_out_of_scope: outOfScope,
    books_closed_during_query: closedDuringQuery,
    capture_books: captureBooks,
    pages_withheld: liveWithheld,
    pages_scanned: pagesScanned,
    match_count: sorted.length,
    match_count_is_floor: budget.wallClockHit || budget.filesScannedHit || budget.collectedMatchesHit,
    result_count: returned.length,
    truncated: sorted.length > returned.length,
    max_results: cap,
    budget_note: getSearchBudgetNote(budget),
    results: returned,
  };
}

export function formatFullTextResult(result: FullTextResult): string {
  const lines: string[] = [];
  lines.push(`Full text over ${result.books_searched} of ${result.shelf_books_open} open Shelf Book(s) for: ${result.query}`);
  // "at least" belongs on the COUNT, not only on the truncation line: a search stopped by a scan
  // budget can return every line it collected, and the count would then read as exact while the
  // budget note said the opposite.
  const found = result.match_count_is_floor ? `at least ${result.result_count}` : `${result.result_count}`;
  lines.push(`${found} matching line(s) from ${result.pages_scanned} page(s). ${CLOSED_NOTE}`);
  if (result.truncated) {
    const total = result.match_count_is_floor ? `at least ${result.match_count}` : `${result.match_count}`;
    lines.push(`Showing the first ${result.result_count} of ${total} matching lines; ask for more with a larger result cap.`);
  }
  if (result.budget_note.trim()) lines.push(result.budget_note);
  if (result.books_out_of_scope.length) {
    lines.push('');
    lines.push(SHARED_NOTE);
    for (const entry of result.books_out_of_scope) {
      lines.push(`- ${entry['book']} [${entry['collection']}], open but NOT searched: ${entry['reason']} -- ${entry['alternative']}`);
    }
  }
  if (result.books_unavailable.length) {
    lines.push('');
    lines.push('Books that are open but could NOT be read, so this answer is incomplete for them:');
    for (const entry of result.books_unavailable) {
      lines.push(`- ${entry['book']} [${entry['book_root']}]: ${entry['reason']} -- ${entry['repair']}`);
    }
  }
  if (result.books_closed_during_query.length) {
    lines.push('');
    lines.push(
      "Books CLOSED while this query ran; their results were discarded unread, because a closed Book's body is not available:",
    );
    for (const entry of result.books_closed_during_query) {
      lines.push(`- ${entry['book']} -- open it again and repeat the search if you still want it`);
    }
  }
  if (result.pages_withheld.length) {
    lines.push('');
    lines.push('Pages that were NOT scanned, so this answer is incomplete for them:');
    for (const entry of result.pages_withheld) {
      lines.push(`- ${entry['book']}/${entry['page']}: ${entry['reason']}`);
    }
  }
  if (result.capture_books.length) {
    lines.push('');
    lines.push(
      `Some of these lines come from UNVETTED capture notes in: ${result.capture_books.join(', ')}. They are readable ` +
        'because the Book is open, but nobody has triaged them.',
    );
  }
  lines.push('');
  if (!result.results.length) {
    lines.push('No page of the open Books carries that term.');
  } else {
    // Grouped on the ROOT: `shelf/x` and `shelf/_archive/x` are two Books sharing one name, and a
    // slug key would print one heading over both.
    let currentBook = '';
    for (const hit of result.results) {
      if (hit.book_root !== currentBook) {
        currentBook = hit.book_root;
        const shelfText = hit.book_shelf === 'archive' ? ', ARCHIVED' : '';
        lines.push('');
        lines.push(`${hit.book_title} [${hit.book_root}, ${hit.book_kind}${shelfText}]`);
      }
      const cut = hit.line_truncated ? ' [line truncated]' : '';
      lines.push(`  ${hit.page}:${hit.line}: ${hit.text}${cut}`);
    }
  }
  lines.push('');
  lines.push(CLOSING_RULE);
  return lines.join('\n');
}
