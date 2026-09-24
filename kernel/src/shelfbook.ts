/**
 * What a Shelf catalog entry MEANS: the single definition, as `tools/ShelfNoteCommon.ps1` keeps it.
 *
 * THE CATALOG IS THE AUTHORITY FOR A BOOK'S TITLE AND FOR WHETHER IT ACCEPTS CAPTURES. No slug is
 * special-cased in code, so a reader retires or adds a capture Book by editing the catalog.
 *
 * AN ARCHIVED BOOK IS DESCRIBED BY THE SAME GRAMMAR SOMEWHERE ELSE. Archiving a Book IS removing
 * its catalog entry, so an archived Book cannot be resolved by slug -- its entry lives verbatim
 * inside `_archived.json`, and it is parsed by exactly this function against exactly these fields.
 * A second copy of the grammar there would be this codebase's most-repeated defect: two definitions
 * of one rule, drifting silently, where the only symptom is an archived Book whose topics or
 * capture flag disagree with its active self.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const ARCHIVE_FOLDER = '_archive';
export const ARCHIVE_RECORD_NAME = '_archived.json';

export interface ShelfBook {
  slug: string;
  title: string;
  bookRoot: string;
  wikiPath: string;
  notesPath: string;
  isCapture: boolean;
  summary: string;
  topics: string[];
}

export interface CatalogSection {
  title: string;
  body: string;
  /** The whole `## ...` block, from its heading to the next one, exactly as the catalog holds it. */
  text: string;
  index: number;
  length: number;
}

export function readUtf8(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** Every `## ` section of a catalog document, with the offsets an entry rewrite needs. */
export function shelfCatalogSections(catalogText: string): CatalogSection[] {
  const sections: CatalogSection[] = [];
  const heading = /^##[ \t]+(.+?)[ \t]*\r?\n/gm;
  const starts: { index: number; title: string; bodyStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = heading.exec(catalogText)) !== null) {
    starts.push({ index: match.index, title: match[1]!, bodyStart: match.index + match[0].length });
  }
  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position]!;
    const end = position + 1 < starts.length ? starts[position + 1]!.index : catalogText.length;
    sections.push({
      title: start.title,
      body: catalogText.substring(start.bodyStart, end),
      text: catalogText.substring(start.index, end),
      index: start.index,
      length: end - start.index,
    });
  }
  return sections;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one section whose Path line names this Book, or null. More than one is a repair, not a pick. */
export function findShelfCatalogEntry(
  catalogText: string,
  slug: string,
  duplicateMessage: string,
): CatalogSection | null {
  const pathPattern = new RegExp(
    '^[ \\t]*-[ \\t]+\\*\\*Path:\\*\\*[ \\t]+shelf/' + escapeRegExp(slug) + '[ \\t]*$',
    'm',
  );
  const matched = shelfCatalogSections(catalogText).filter((section) => pathPattern.test(section.body));
  if (matched.length === 0) return null;
  if (matched.length !== 1) throw new Error(duplicateMessage);
  return matched[0]!;
}

/**
 * One entry's heading and body turned into a Book. Summary and Topics are read as ITEMS, not as
 * lines: a catalog summary wraps, and a continuation line is indented, so each field runs to the
 * next bullet or the end of the entry.
 */
export function convertFromShelfCatalogEntry(options: {
  workspace: string;
  slug: string;
  title: string;
  body: string;
  bookRoot: string;
}): ShelfBook {
  const wikiPath = path.resolve(path.join(options.workspace, ...options.bookRoot.split('/'), 'wiki'));
  const summaryMatch = /^[ \t]*-[ \t]+\*\*Summary:\*\*[ \t]+([\s\S]*?)(?=^[ \t]*-[ \t]+\*\*|$)/m.exec(options.body);
  const topicsMatch = /^[ \t]*-[ \t]+\*\*Topics:\*\*[ \t]+([\s\S]*?)(?=^[ \t]*-[ \t]+\*\*|$)/m.exec(options.body);
  return {
    slug: options.slug,
    title: options.title.trim(),
    bookRoot: options.bookRoot,
    wikiPath,
    notesPath: path.join(wikiPath, 'notes'),
    isCapture: /^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(options.body),
    summary: summaryMatch ? summaryMatch[1]!.replace(/\s+/g, ' ').trim() : '',
    topics: topicsMatch
      ? topicsMatch[1]!
          .split(',')
          .map((topic) => topic.trim())
          .filter((topic) => topic.length > 0)
      : [],
  };
}

export function shelfCatalogPath(workspace: string): string {
  return path.join(workspace, 'shelf', '_catalog.md');
}

export function getShelfBook(workspace: string, slug: string): ShelfBook {
  // The slug rule is the accurate refusal: without it 'Holding' would be refused later as an
  // unlisted Book, which is true and sends the reader to the wrong repair.
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error('Book slug must contain only lowercase letters, digits, and hyphens.');
  }
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) throw new Error('This workspace has no local Shelf catalog.');
  const entry = findShelfCatalogEntry(
    readUtf8(catalogFile),
    slug,
    `Shelf catalog lists 'shelf/${slug}' more than once; repair the catalog before writing to it.`,
  );
  if (!entry) throw new Error(`No Shelf Book '${slug}' is listed in shelf/_catalog.md.`);
  return convertFromShelfCatalogEntry({
    workspace,
    slug,
    title: entry.title,
    body: entry.body,
    bookRoot: `shelf/${slug}`,
  });
}

export function archivedBookRoot(slug: string): string {
  return `shelf/${ARCHIVE_FOLDER}/${slug}`;
}

export function archiveRecordPath(workspace: string, slug: string): string {
  return path.join(workspace, 'shelf', ARCHIVE_FOLDER, slug, ARCHIVE_RECORD_NAME);
}

/** The same Book object for an archived Book, read from the record the archiver stored. */
export function getArchivedShelfBook(workspace: string, slug: string): ShelfBook & { archivedOn: string } {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error('Book slug must contain only lowercase letters, digits, and hyphens.');
  }
  const recordFile = archiveRecordPath(workspace, slug);
  if (!fs.existsSync(recordFile)) {
    throw new Error(`No archived Shelf Book '${slug}' is recorded at shelf/_archive/${slug}/_archived.json.`);
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readUtf8(recordFile)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`The archive record for '${slug}' is not readable JSON: ${(error as Error).message}`);
  }
  if (!('catalog_entry' in record)) {
    throw new Error(
      `The archive record for '${slug}' carries no catalog_entry, so its title and topics cannot be recovered.`,
    );
  }
  const entry = String(record['catalog_entry']);
  // The stored entry is a whole catalog block: a `## Title` heading and the bullets beneath it.
  const match = /^##[ \t]+(.+?)[ \t]*\r?\n([\s\S]*)$/m.exec(entry);
  const title = match ? match[1]! : 'title' in record ? String(record['title']) : slug;
  const body = match ? match[2]! : entry;
  const book = convertFromShelfCatalogEntry({
    workspace,
    slug,
    title,
    body,
    bookRoot: archivedBookRoot(slug),
  });
  return { ...book, archivedOn: 'archived_on' in record ? String(record['archived_on']) : '' };
}

/** Every file under a directory, sorted by full path, which is what a byte-identity proof compares. */
export function listFilesRecursive(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export interface PageHash {
  relative: string;
  sha256: string;
}

/**
 * Every page under a wiki root, with its hash. This is what proves the reader's material crossed a
 * move unaltered: the title pages may be rewritten on purpose, everything else must be identical.
 */
export function bookPageManifest(wikiPath: string, hashFile: (file: string) => string): PageHash[] {
  return listFilesRecursive(wikiPath).map((file) => ({
    relative: file.substring(wikiPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    sha256: hashFile(file),
  }));
}
