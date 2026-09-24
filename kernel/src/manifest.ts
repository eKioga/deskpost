/**
 * One Shelf Book's Discovery metadata manifest. Reads bodies; writes nothing.
 *
 * The PowerShell original is `tools/BookManifest.ps1`, and the properties that matter here are the
 * ones that decide what a reader who has opened NOTHING can see.
 *
 * THE MANIFEST IS CATALOG-CLASS. It is destined for a path readable while every Book is closed,
 * exactly as `shelf/_catalog.md` already is, so everything it holds is disclosed to a reader who has
 * opened nothing.
 *
 * THE CAPTURE EXCLUSION IS THEREFORE AT GENERATION, NOT AT QUERY. Filtering what Discovery RETURNS
 * would not preserve the boundary, because the manifest itself is closed-readable: a capture Book's
 * note titles held there leak to any other reader of that path. A capture Book's manifest carries
 * its summary and its counts and nothing else.
 *
 * IT FAILS CLOSED, TWICE. A Book is capture if EITHER the catalog entry or the Book's own `_book.md`
 * says so, so a leak needs both signals to be wrong rather than either.
 *
 * IT IS DETERMINISTIC. There is no timestamp in the body: regenerating an unchanged Book yields
 * identical bytes, so "has this Book changed" is a hash comparison and not a diff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { listFilesRecursive, readUtf8, type ShelfBook } from './shelfbook.ts';

const BOOK_MANIFEST_SCHEMA = 2;

// Boundaries. Books are converted material from several external wikis, so page text is closer to
// untrusted input than to something this codebase wrote.
const MAX_TEXT_LENGTH = 300;
const MAX_HEADINGS_PER_PAGE = 200;
const MAX_PAGES_PER_BOOK = 5000;
const MAX_UPSTREAMS_PER_BOOK = 100;

const SOURCES_HEADING = '## Sources';

export interface ManifestPage {
  /** Canonical: below wiki/, no extension, forward slashes. It is what feeds read_open_book_page. */
  path: string;
  text: string;
  bytes: Uint8Array;
}

export interface Heading {
  level: number;
  text: string;
}

/**
 * Normalise, flatten, sanitise, cap -- in that order. Unicode normalisation happens at generation so
 * a query never has to normalise the stored side, and control characters are STRIPPED rather than
 * escaped because a manifest is rendered to a terminal by every consumer it has.
 */
export function convertToManifestText(value: string): string {
  if (!value) return '';
  let text = value.normalize('NFC');
  // \p{Cc} and \p{Cf}: the two categories PowerShell's [\p{Cc}\p{Cf}] names.
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_TEXT_LENGTH) text = text.substring(0, MAX_TEXT_LENGTH).replace(/\s+$/, '') + '...';
  return text;
}

/** Frontmatter is metadata, not content: a capture note's `review: pending` is not a heading. */
export function removePageFrontmatter(text: string): string {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return match ? match[1]! : text;
}

/**
 * Markdown-aware rather than line-prefix guessing. A '#' inside a fenced block is content, and this
 * Shelf holds Books full of shell transcripts, so that is not a hypothetical.
 */
export function getMarkdownHeadings(text: string): Heading[] {
  const lines = removePageFrontmatter(text).replace(/\r\n/g, '\n').split('\n');
  let fenced = false;
  const found: Heading[] = [];
  for (const line of lines) {
    if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!match) continue;
    if (found.length >= MAX_HEADINGS_PER_PAGE) break;
    found.push({ level: match[1]!.length, text: convertToManifestText(match[2]!) });
  }
  return found;
}

export interface ReaderMap {
  headings: Heading[];
  links: { target: string; label: string }[];
}

/**
 * The reader map in structured form: its sections, and what it points at. It is the most useful
 * thing a manifest can hold -- the one part of a Book a human wrote to be read first.
 */
export function getReaderMapMetadata(text: string): ReaderMap {
  const links: { target: string; label: string }[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (links.length >= MAX_HEADINGS_PER_PAGE) break;
    links.push({
      target: convertToManifestText(match[1]!),
      label: match[2] === undefined ? '' : convertToManifestText(match[2]),
    });
  }
  return { headings: getMarkdownHeadings(text), links };
}

/**
 * A hash over BYTES, not over the manifest: this is what answers "has the Book changed since its
 * manifest was written" without reading a body. It is safe to publish for a capture Book precisely
 * because a digest discloses nothing about what was digested.
 */
export function getBookPageDigest(pages: ManifestPage[]): string {
  const parts = pages.map((page) => `${page.path}:${sha256OfBytes(page.bytes)}`);
  return sha256OfText(parts.join('\n'));
}

/** The union rule. Either signal saying `capture` is enough. */
export function testBookIsCapture(book: ShelfBook): boolean {
  if (book.isCapture) return true;
  const bookPage = path.join(book.wikiPath, '_book.md');
  if (fs.existsSync(bookPage) && /^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(readUtf8(bookPage))) {
    return true;
  }
  return false;
}

/**
 * A page's `## Sources` block, reduced to the question the manifest asks of it: is it READABLE, and
 * which upstreams does it pin?
 *
 * THREE OUTCOMES, AND THE ROLL-UP NEEDS ALL THREE SEPARABLE. A page with no block at all is readable
 * and anchorless -- an imported wiki page, not a defect. A block that parses and pins nothing is the
 * same answer. A pin that fails the grammar is UNREADABLE: it contributes no tuple, and the Book it
 * belongs to must not then be reported current on the strength of its other pages.
 *
 * WHY THE PARSE IS NARROWER THAN `tools/SourcesBlock.ps1`. That file also maps cited paths onto pins
 * for the currency tier, which no manifest field records; what the manifest stores is the distinct
 * (url, ref, commit) tuples and a count of pages whose block would not parse. This reads exactly the
 * lines those two fields come from and refuses the same shapes -- a malformed Upstream line, a
 * claim-bearing line wearing the wrong bullet, and two Upstream lines disagreeing about one root.
 */
const UPSTREAM_PATTERN =
  /^- Upstream `(?<root>[^`]+)` pinned to `(?<url>[^`]+)` `(?<ref>[^`]+)` `(?<oid>[0-9a-f]{40})`(?: captured `(?<captured>[^`]*)`)?\s*$/;

export interface Anchor {
  url: string;
  ref: string;
  commit_oid: string;
}

export function getArticleAnchors(text: string): { readable: boolean; upstreams: Anchor[] } {
  if (!text) return { readable: true, upstreams: [] };
  const lines = text.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ line: line.replace(/\s+$/, ''), index }))
    .filter((entry) => entry.line === SOURCES_HEADING);
  if (!headings.length) return { readable: true, upstreams: [] };
  if (headings.length > 1) return { readable: false, upstreams: [] };

  const upstreams: Anchor[] = [];
  const seenPins = new Map<string, string>();
  let inFence = false;
  let fenceMarker = '';
  let inComment = false;

  for (let index = headings[0]!.index + 1; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\s+$/, '');
    const bare = line.replace(/^\s+/, '');

    // A fence or an HTML comment inside the block is INERT. A `- Upstream ...` written inside one is
    // sample text to Markdown, and reading it as a live pin would carry a Book to `current` on the
    // strength of an example.
    if (inComment) {
      if (bare.includes('-->')) inComment = false;
      continue;
    }
    if (inFence) {
      if (bare.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (bare.startsWith('```') || bare.startsWith('~~~')) {
      inFence = true;
      fenceMarker = bare.substring(0, 3);
      continue;
    }
    if (bare.startsWith('<!--')) {
      if (!bare.includes('-->')) inComment = true;
      continue;
    }

    if (line.length === 0) continue;
    if (line.startsWith('## ')) break;

    // PROSE INSIDE THE BLOCK IS SKIPPED, and that is a correction made against real data: published
    // pages open their ## Sources with a hand-written paragraph. A CLAIM WEARING THE WRONG BULLET is
    // still a refusal -- `* `, `+ ` and an indented `- ` are all bullets to Markdown and none is the
    // canonical form, so a claim on one would be silently dropped.
    if (!line.startsWith('- ')) {
      const smuggled = /^\s*(?:-|\*|\+)\s+(.*)$/.exec(line);
      if (smuggled && isSourcesClaimBearing(smuggled[1]!)) return { readable: false, upstreams: [] };
      continue;
    }

    if (line.startsWith('- Upstream ')) {
      const match = UPSTREAM_PATTERN.exec(line);
      if (!match) return { readable: false, upstreams: [] };
      const groups = match.groups!;
      const signature = `${groups['url']}|${groups['ref']}|${groups['oid']}`;
      const seen = seenPins.get(groups['root']!);
      if (seen !== undefined) {
        if (seen !== signature) return { readable: false, upstreams: [] };
        continue;
      }
      seenPins.set(groups['root']!, signature);
      upstreams.push({ url: groups['url']!, ref: groups['ref']!, commit_oid: groups['oid']! });
      continue;
    }

    // A file line. Prose on a canonical bullet is skipped too; a claim on one is not.
    if (!/^- `[^`]+` `sha256:[0-9a-f]{64}`/.test(line) && isSourcesClaimBearing(line.substring(2))) {
      return { readable: false, upstreams: [] };
    }
  }

  return { readable: true, upstreams };
}

/**
 * Does this line make a claim the anchor roll-up could measure? A corrupted hash, a mangled pin and
 * a file line that lost its backtick are all claims; a provenance note a person wrote before this
 * grammar existed is not.
 */
function isSourcesClaimBearing(content: string): boolean {
  return /sha256:|https?:\/\/|\bUpstream\b|\bpinned to\b|\b[0-9a-f]{40}\b/.test(content);
}

/** Collapse anchor tuples to the distinct ones, in first-seen order. */
export function selectDistinctAnchor(anchors: Anchor[]): Anchor[] {
  const seen = new Set<string>();
  const distinct: Anchor[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.url}|${anchor.ref}|${anchor.commit_oid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ url: anchor.url, ref: anchor.ref, commit_oid: anchor.commit_oid });
  }
  return distinct;
}

/**
 * Build a manifest from Book metadata and an already-collected page list. Writes nothing.
 *
 * The schema, the caps, the capture exclusion and the digest all live here; a collection differs
 * only in where the page list came from. There is only one place they are built, which is what
 * guarantees Discovery reads them identically.
 */
export function newBookManifestFromPages(options: {
  slug: string;
  title: string;
  summary?: string;
  topics?: string[];
  isCapture: boolean;
  pages: ManifestPage[];
  capturePageCount?: number | null;
  capturePendingCount?: number | null;
  linkPrefix?: string;
}): Record<string, PsJsonValue> {
  const pages = options.pages;
  if (pages.length > MAX_PAGES_PER_BOOK) {
    throw new Error(`Book '${options.slug}' holds ${pages.length} pages, above the manifest cap of ${MAX_PAGES_PER_BOOK}.`);
  }

  // THE KEY ORDER IS THE DOCUMENT. `ConvertTo-Json` writes an [ordered] hashtable in insertion
  // order, and the matrix compares the file, so this list is the PowerShell one line for line --
  // including `anchored_upstreams` and `anchor_unreadable` sitting before `source_digest`.
  const manifest: Record<string, PsJsonValue> = {
    schema: BOOK_MANIFEST_SCHEMA,
    slug: options.slug,
    title: convertToManifestText(options.title),
    summary: convertToManifestText(options.summary ?? ''),
    topics: [...(options.topics ?? [])],
    kind: 'curated',
    page_metadata: 'full',
    withheld_reason: '',
    page_count: pages.length,
    pending_count: null,
    reader_map: null,
    pages: [],
    anchored_upstreams: [],
    anchor_unreadable: 0,
    source_digest: getBookPageDigest(pages),
  };

  if (options.isCapture) {
    manifest['kind'] = 'capture';
    manifest['page_metadata'] = 'withheld';
    manifest['withheld_reason'] = 'capture Book: naming an individual note is reading it';
    if (options.capturePageCount !== null && options.capturePageCount !== undefined) {
      manifest['page_count'] = options.capturePageCount;
    }
    manifest['pending_count'] =
      options.capturePendingCount === undefined ? null : (options.capturePendingCount as PsJsonValue);
    return manifest;
  }

  const pageEntries: PsJsonValue[] = [];
  const anchors: Anchor[] = [];
  let unreadable = 0;
  for (const page of pages) {
    if (page.path === '_index') {
      manifest['reader_map'] = canonicalReaderMap(getReaderMapMetadata(page.text), options.linkPrefix ?? '');
    }
    const headings = getMarkdownHeadings(page.text);
    const firstH1 = headings.filter((heading) => heading.level === 1);
    pageEntries.push({
      path: page.path,
      title: firstH1.length ? firstH1[0]!.text : '',
      headings: headings.map((heading) => ({ level: heading.level, text: heading.text })),
    });

    const found = getArticleAnchors(page.text);
    if (!found.readable) unreadable += 1;
    for (const anchor of found.upstreams) anchors.push(anchor);
  }
  manifest['pages'] = pageEntries;

  const distinct = selectDistinctAnchor(anchors);
  if (distinct.length > MAX_UPSTREAMS_PER_BOOK) {
    throw new Error(
      `Book '${options.slug}' cites ${distinct.length} distinct upstreams, above the manifest cap of ${MAX_UPSTREAMS_PER_BOOK}.`,
    );
  }
  manifest['anchored_upstreams'] = distinct.map((anchor) => ({
    url: anchor.url,
    ref: anchor.ref,
    commit_oid: anchor.commit_oid,
  }));
  manifest['anchor_unreadable'] = unreadable;
  return manifest;
}

/**
 * A reader map's links point at pages, and Discovery hands the reader a path only when a link target
 * matches a page path the manifest lists, so the two must be spelled the same way. Anything that
 * does not start with the prefix is left exactly as written -- a link OUT of the Book is not a page
 * path and must not be forced into looking like one.
 */
function canonicalReaderMap(readerMap: ReaderMap, linkPrefix: string): PsJsonValue {
  const links = readerMap.links.map((link) => {
    let target = link.target;
    if (linkPrefix && target.startsWith(linkPrefix)) {
      target = target.substring(linkPrefix.length).replace(/\.md$/, '');
    }
    return { target, label: link.label };
  });
  return {
    headings: readerMap.headings.map((heading) => ({ level: heading.level, text: heading.text })),
    links,
  };
}

/** The canonical page path: below wiki/, no extension, forward slashes. */
export function convertToCanonicalPagePath(wikiRoot: string, fullPath: string): string {
  const relative = fullPath.substring(wikiRoot.length).replace(/^[\\/]+/, '');
  return relative.replace(/\\/g, '/').replace(/\.md$/, '');
}

/** The metadata manifest for one already-resolved local Book. Reads bodies; writes nothing. */
export function newBookManifestForShelfBook(book: ShelfBook): Record<string, PsJsonValue> {
  if (!fs.existsSync(book.wikiPath) || !fs.statSync(book.wikiPath).isDirectory()) {
    throw new Error(`Book '${book.slug}' has no pages directory at ${book.bookRoot}/wiki.`);
  }
  const files = listFilesRecursive(book.wikiPath).filter((file) => file.toLowerCase().endsWith('.md'));
  if (files.length > MAX_PAGES_PER_BOOK) {
    throw new Error(`Book '${book.slug}' holds ${files.length} pages, above the manifest cap of ${MAX_PAGES_PER_BOOK}.`);
  }
  const pages: ManifestPage[] = files.map((file) => ({
    path: convertToCanonicalPagePath(book.wikiPath, file),
    // Raw bytes for the digest, decoded text for the headings.
    text: fs.readFileSync(file, 'utf8'),
    bytes: fs.readFileSync(file),
  }));

  const isCapture = testBookIsCapture(book);
  let captureCount: number | null = null;
  let pendingCount: number | null = null;
  if (isCapture) {
    // A Shelf capture Book counts the notes directly under notes/, which is not the same set as
    // every page under wiki/ that the digest covers.
    const notes = shelfNotes(book);
    captureCount = notes.length;
    pendingCount = notes.filter((note) => note.review !== 'done').length;
  }

  return newBookManifestFromPages({
    slug: book.slug,
    title: book.title,
    summary: book.summary,
    topics: book.topics,
    isCapture,
    pages,
    capturePageCount: captureCount,
    capturePendingCount: pendingCount,
  });
}

export interface ShelfNote {
  file: string;
  page: string;
  fullPath: string;
  title: string;
  captured: string;
  review: string;
}

/** Every note's frontmatter and title. Bodies are never returned. */
export function shelfNotes(book: ShelfBook): ShelfNote[] {
  if (!fs.existsSync(book.notesPath) || !fs.statSync(book.notesPath).isDirectory()) return [];
  return fs
    .readdirSync(book.notesPath, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md'))
    .map((item) => item.name)
    .sort()
    .map((name) => {
      const fullPath = path.join(book.notesPath, name);
      const content = readUtf8(fullPath);
      const fields = noteFrontmatter(content);
      const titleMatch = /^#[ \t]+(.+?)[ \t]*$/m.exec(content);
      const base = name.replace(/\.md$/i, '');
      return {
        file: name,
        page: `notes/${base}`,
        fullPath,
        title: titleMatch ? titleMatch[1]!.trim() : base,
        // A BLANK VALUE IS AN ABSENT ONE, which is what Get-FrontmatterValue decides: a note whose
        // `review:` line was written empty is pending, not reviewed under the name ''.
        captured: frontmatterValue(fields, 'captured', 'unknown'),
        review: frontmatterValue(fields, 'review', 'pending'),
      };
    });
}

function frontmatterValue(fields: Map<string, string>, key: string, fallback: string): string {
  const value = fields.get(key);
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

/** The flat `key: value` pairs of a leading frontmatter block, or an empty map when there is none. */
function noteFrontmatter(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 2 || lines[0]!.trim() !== '---') return fields;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') return fields;
    const match = /^([a-z_]+):\s*(.*)$/.exec(lines[index]!);
    if (match) fields.set(match[1]!, match[2]!.trim());
  }
  return new Map();
}
