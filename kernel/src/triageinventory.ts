/**
 * `library triage inventory` -- what is waiting, and what evidence says it is already safe.
 *
 * TWO SOURCES, REPORTED SEPARATELY AND NEVER FOLDED TOGETHER. The Notebook counters answer "what is
 * about to be deleted", because that is what the Reset preflight renders them as. A Holding Shelf
 * note is the opposite: it is what SURVIVES a reset. Adding one to `page_count` would make the
 * reset preflight overstate the loss, which is the direction that matters.
 *
 * `copy_status` IS EVIDENCE-BASED AND HASH-BOUND, and only `known-current-copy` is proof. A
 * `legacy-copy-record` is synthesised from a journal's attempted records with an EMPTY source hash
 * -- it names a path and binds no content -- and `known-copy-drifted` binds a DIFFERENT version of
 * the page. `no-known-copy-record` is a true statement when it appears, and it is a statement about
 * the journals rather than about the page.
 *
 * WHAT `copy_status` CANNOT SEE, AND WHY THE REFERENCES EXIST. A page whose substance was written
 * into a git-tracked design record rather than published as a page reads as uncopied -- and that
 * gap produced a real misreading. So the pages are asked what they POINT AT. A reference is a
 * POINTER, never proof of coverage: `tracked` means git holds that file, never that it covers this
 * page.
 *
 * THE TRACKED SET FAILS CLOSED. "Nothing is tracked" and "I could not tell" are different answers,
 * and only one of them is safe to render as `untracked`. With no set, every durability reads
 * `unknown` and `references_resolvable` says so -- answering `untracked` would be false confidence
 * in the direction that makes a page look MORE at risk than it is.
 *
 * NEITHER SOURCE HAS TO EXIST. `notebook/` is gitignored and a Reset deletes it, so the state
 * immediately after a Reset -- a populated Holding Shelf and no Notebook at all -- is a normal case
 * this reports on rather than an error.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { sha256OfBytes } from './sha.ts';
import { listFilesRecursive, readUtf8, shelfCatalogSections, type ShelfBook } from './shelfbook.ts';

const LIBRARY_OUTPUT_SCHEMA = 1;

/**
 * A workspace-relative path with at least one separator, ANCHORED on a known top-level directory so
 * ordinary prose containing a slash does not become a reference.
 */
const REFERENCE_ROOTS = 'docs|tools|shelf|books|archive|notebook|internal|output';
const REFERENCE_PATTERN = new RegExp(
  '(?<![A-Za-z0-9._/-])(?:' + REFERENCE_ROOTS + ')/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*',
  'g',
);

const SCOPE =
  'Local Notebook, local capture Books, and internal publication journals only. No Basic Memory or NAS call was made.';
const REFERENCE_RULE =
  'A reference is a POINTER, not proof of coverage: `tracked` means git holds that file, never that it covers this ' +
  'page. Open it before treating a page as already safe.';

function utf8Hash(file: string): string {
  return sha256OfBytes(fs.readFileSync(file));
}

/**
 * Every git-tracked path, or NULL when that cannot be established. ONE git call, not one per
 * reference, and null rather than an empty set -- see the fail-closed note above.
 */
function trackedPathSet(workspace: string): Set<string> | null {
  let output: string;
  try {
    output = execFileSync('git', ['-C', workspace, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const set = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const item = line.trim().replace(/\\/g, '/');
    if (item) set.add(item.toLowerCase());
  }
  return set;
}

interface PageReference {
  path: string;
  durability: string;
}

/** The workspace paths one page names, each classified for durability. No cap: a page names a handful. */
function pageReferences(workspace: string, full: string, tracked: Set<string> | null): PageReference[] {
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const references: PageReference[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const item = match[0].replace(/\\/g, '/').replace(/[.,;:]+$/, '');
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const durability =
      tracked === null
        ? 'unknown'
        : tracked.has(key)
          ? 'tracked'
          : fs.existsSync(path.join(workspace, ...item.split('/')))
            ? 'untracked'
            : 'missing';
    references.push({ path: item, durability });
  }
  return references.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

interface CoverageEntry {
  source: string;
  sourceSha256: string;
  destinationType: 'book' | 'project';
  destinationSlug: string;
  journal: string;
  quality: 'complete' | 'legacy-complete';
}

/** A journal source naming a capture-Book note falls through unchanged; the rule is anchored at `wiki/`. */
function normaliseSourcePath(item: string): string {
  const match = /^wiki\/(.+)$/.exec(item);
  return match ? 'notebook/' + match[1]! : item;
}

function journalEntries(journalPath: string): CoverageEntry[] {
  const journal = JSON.parse(readUtf8(journalPath)) as Record<string, unknown>;
  const state = String(journal['state'] ?? '');
  const errorText = String(journal['error'] ?? '');
  const bookSlug = String(journal['book_slug'] ?? '');
  const projectSlug = String(journal['project_slug'] ?? '');
  let destinationType: 'book' | 'project';
  if (bookSlug.trim()) destinationType = 'book';
  else if (projectSlug.trim()) destinationType = 'project';
  else return [];
  const destinationSlug = destinationType === 'book' ? bookSlug : projectSlug;
  const quality: 'complete' | 'legacy-complete' | 'incomplete' =
    state === 'complete'
      ? 'complete'
      : destinationType === 'book' && state === 'candidate' && !errorText.trim()
        ? 'legacy-complete'
        : 'incomplete';
  if (quality === 'incomplete') return [];

  const entries: CoverageEntry[] = [];
  const planned = ((journal['planned_records'] as Record<string, unknown>[] | null) ?? []).filter((item) => item !== null);
  if (planned.length) {
    for (const record of planned) {
      const source = record['source'];
      if (source === null || source === undefined || String(source) === '') continue;
      entries.push({
        source: normaliseSourcePath(String(source)),
        sourceSha256: String(record['sha256'] ?? ''),
        destinationType,
        destinationSlug,
        journal: journalPath,
        quality,
      });
    }
    return entries;
  }
  if (destinationType !== 'book') return [];
  const legacy = ((journal['attempted_records'] as unknown[] | null) ?? []).filter((item) => item !== null);
  for (const record of legacy) {
    const item = String(record);
    const match = /^books\/[^/]+\/wiki\/(.+\.md)$/.exec(item);
    if (match && !['_book.md', '_index.md'].includes(match[1]!)) {
      entries.push({
        source: 'notebook/' + match[1]!,
        sourceSha256: '',
        destinationType,
        destinationSlug,
        journal: journalPath,
        quality,
      });
    }
  }
  return entries;
}

/** Capture-enabled Books from the catalog, without throwing when there are none. */
function captureBooks(workspace: string): ShelfBook[] {
  const catalogPath = path.join(workspace, 'shelf', '_catalog.md');
  if (!fs.existsSync(catalogPath)) return [];
  const books: ShelfBook[] = [];
  for (const section of shelfCatalogSections(readUtf8(catalogPath))) {
    if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
    const pathMatch = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body);
    if (!pathMatch) continue;
    const slug = pathMatch[1]!;
    const wikiPath = path.join(workspace, 'shelf', slug, 'wiki');
    if (!fs.existsSync(wikiPath)) continue;
    books.push({
      slug,
      title: section.title.trim(),
      bookRoot: `shelf/${slug}`,
      wikiPath,
      notesPath: path.join(wikiPath, 'notes'),
      isCapture: true,
      summary: '',
      topics: [],
    });
  }
  return books.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

interface NoteRow {
  file: string;
  page: string;
  fullPath: string;
  title: string;
  review: string;
  captured: string;
}

/** Frontmatter, title and a hash. Bodies are never read into the report. */
function bookNotes(book: ShelfBook): NoteRow[] {
  if (!fs.existsSync(book.notesPath)) return [];
  return fs
    .readdirSync(book.notesPath, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md'))
    .map((item) => item.name)
    .sort()
    .map((name) => {
      const full = path.join(book.notesPath, name);
      const content = readUtf8(full);
      const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content);
      const base = name.replace(/\.md$/i, '');
      const captured = /^captured:[ \t]*(.*)$/m.exec(content);
      const review = /^review:[ \t]*(.*)$/m.exec(content);
      return {
        file: name,
        page: `notes/${base}`,
        fullPath: full,
        title: heading ? heading[1]!.trim() : base,
        review: review && review[1]!.trim() ? review[1]!.trim() : 'pending',
        captured: captured && captured[1]!.trim() ? captured[1]!.trim() : 'unknown',
      };
    });
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((item) => item))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * `notebookRelative` is the Notebook root to read: `notebook` for the shared tree, `notebook/<seat>`
 * for a seat's own under ADR-0029. Every path it reports is under that root, so a reset's advisory
 * describes the Notebook that reset would take rather than every seat's at once.
 */
export function triageInventory(workspace: string, notebookRelative = 'notebook'): Record<string, PsJsonValue> {
  const root = path.resolve(workspace);
  const notebookRoot = path.join(root, ...notebookRelative.split('/'));
  const journalRoot = path.join(root, 'internal', 'publication-journals');
  const notebookPresent = fs.existsSync(notebookRoot) && fs.statSync(notebookRoot).isDirectory();

  const coverage = new Map<string, CoverageEntry[]>();
  const journalErrors: string[] = [];
  if (fs.existsSync(journalRoot) && fs.statSync(journalRoot).isDirectory()) {
    for (const name of fs.readdirSync(journalRoot).filter((item) => item.toLowerCase().endsWith('.json')).sort()) {
      const full = path.join(journalRoot, name);
      try {
        for (const entry of journalEntries(full)) {
          const list = coverage.get(entry.source) ?? [];
          list.push(entry);
          coverage.set(entry.source, list);
        }
      } catch (error) {
        journalErrors.push(`${name}: ${(error as Error).message}`);
      }
    }
  }

  const tracked = trackedPathSet(root);

  // Shared by both sources rather than written twice: the two halves ask the identical question of
  // the identical journals, and a second copy is a second thing to keep in step with the format.
  const resolveCopyRecords = (
    relative: string,
    sha256: string,
  ): { copyStatus: string; knownBooks: string[]; knownProjects: string[]; journals: string[] } => {
    const matched = coverage.get(relative) ?? [];
    const current = matched.filter((entry) => entry.quality === 'complete' && entry.sourceSha256 === sha256);
    const drifted = matched.filter(
      (entry) => entry.quality === 'complete' && entry.sourceSha256 && entry.sourceSha256 !== sha256,
    );
    const legacy = matched.filter((entry) => entry.quality === 'legacy-complete');
    return {
      copyStatus: current.length
        ? 'known-current-copy'
        : drifted.length
          ? 'known-copy-drifted'
          : legacy.length
            ? 'legacy-copy-record'
            : 'no-known-copy-record',
      knownBooks: sortedUnique(matched.filter((entry) => entry.destinationType === 'book').map((entry) => entry.destinationSlug)),
      knownProjects: sortedUnique(
        matched.filter((entry) => entry.destinationType === 'project').map((entry) => entry.destinationSlug),
      ),
      journals: sortedUnique(matched.map((entry) => path.basename(entry.journal))),
    };
  };

  // --- Source one: the Notebook, whose topics a Reset quarantines --------------------------------
  const pages = (notebookPresent ? listFilesRecursive(notebookRoot).filter((file) => file.toLowerCase().endsWith('.md')) : []).map(
    (file) => {
      const relative = notebookRelative + '/' + file.substring(notebookRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const hash = utf8Hash(file);
      const references = pageReferences(root, file, tracked);
      const records = resolveCopyRecords(relative, hash);
      return {
        path: relative,
        sha256: hash,
        copy_status: records.copyStatus,
        known_books: records.knownBooks,
        known_projects: records.knownProjects,
        journals: records.journals,
        references,
        tracked_reference_count: references.filter((reference) => reference.durability === 'tracked').length,
      };
    },
  );

  // --- The per-topic roll-up (ADR-0022) ----------------------------------------------------------
  //
  // ONE GROUPING OVER THE PAGES ABOVE, NOT A SECOND READER OF THE JOURNALS. A reset takes TOPICS, so
  // a whole-Notebook figure that is 94% reassuring says nothing about the one topic that is 0%.
  //
  // THE MASTER INDEX IS EXCLUDED AND EVERY OTHER LOOSE FILE IS NOT. `_master-index.md` is rendered
  // rather than written and a reset rebuilds it; any OTHER file directly under notebook/ belongs to
  // no topic and IS quarantined, so it is grouped under an empty topic rather than dropped -- a
  // filter that removes an item from the numerator and the denominator alike makes a partial answer
  // read as a complete one.
  const grouped = new Map<string, typeof pages>();
  for (const page of pages) {
    if (page.path === `${notebookRelative}/_master-index.md`) continue;
    const segments = page.path.substring(notebookRelative.length + 1).split('/');
    const topic = segments.length > 1 ? segments[0]! : '';
    const list = grouped.get(topic) ?? [];
    list.push(page);
    grouped.set(topic, list);
  }
  const topics = [...grouped.keys()]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((topic) => {
      const topicPages = grouped.get(topic)!;
      return {
        topic,
        page_count: topicPages.length,
        known_current_copy_count: topicPages.filter((page) => page.copy_status === 'known-current-copy').length,
        known_copy_drifted_count: topicPages.filter((page) => page.copy_status === 'known-copy-drifted').length,
        legacy_copy_record_count: topicPages.filter((page) => page.copy_status === 'legacy-copy-record').length,
        no_known_copy_record_count: topicPages.filter((page) => page.copy_status === 'no-known-copy-record').length,
        pages_without_current_copy: topicPages.filter((page) => page.copy_status !== 'known-current-copy').length,
        known_books: sortedUnique(topicPages.flatMap((page) => page.known_books)),
        known_projects: sortedUnique(topicPages.flatMap((page) => page.known_projects)),
      };
    });

  // --- Source two: the capture Books, which a Reset does NOT touch -------------------------------
  const books = captureBooks(root);
  const holdingNotes = books.flatMap((book) =>
    bookNotes(book).map((note) => {
      const relative = `${book.bookRoot}/wiki/${note.page}.md`;
      const hash = utf8Hash(note.fullPath);
      const records = resolveCopyRecords(relative, hash);
      return {
        path: relative,
        book: book.slug,
        page: note.page,
        title: note.title,
        review: note.review,
        captured: note.captured,
        sha256: hash,
        copy_status: records.copyStatus,
        known_books: records.knownBooks,
        known_projects: records.knownProjects,
        journals: records.journals,
      };
    }),
  );
  const holdingPending = holdingNotes.filter((note) => note.review !== 'done');
  // 'unknown' is what a note carrying no captured field reports, and it must not sort as though it
  // were the oldest date in the Book.
  const holdingDates = holdingPending
    .map((note) => note.captured)
    .filter((captured) => captured !== 'unknown')
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Library Triage Inventory',
    workspace: root,
    scope: SCOPE,
    reference_rule: REFERENCE_RULE,
    references_resolvable: tracked !== null,
    notebook_present: notebookPresent,
    page_count: pages.length,
    known_current_copy_count: pages.filter((page) => page.copy_status === 'known-current-copy').length,
    known_copy_drifted_count: pages.filter((page) => page.copy_status === 'known-copy-drifted').length,
    legacy_copy_record_count: pages.filter((page) => page.copy_status === 'legacy-copy-record').length,
    no_known_copy_record_count: pages.filter((page) => page.copy_status === 'no-known-copy-record').length,
    topics: topics as unknown as PsJsonValue,
    holding_present: books.length > 0,
    holding_books: books.map((book) => book.slug),
    holding_note_count: holdingNotes.length,
    holding_pending_count: holdingPending.length,
    holding_oldest_pending: holdingDates.length ? holdingDates[0]! : '',
    holding_no_known_copy_record_count: holdingNotes.filter((note) => note.copy_status === 'no-known-copy-record').length,
    unreadable_journals: journalErrors,
    pages: pages as unknown as PsJsonValue,
    holding_notes: holdingNotes as unknown as PsJsonValue,
    shared_library_write: false,
  };
}
