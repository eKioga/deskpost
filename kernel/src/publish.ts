/**
 * `library publish`, `publish batch` and `publish refresh`: the PREFLIGHTS of tools/Publish-ShelfBookToShared.ps1,
 * Publish-ShelfBookBatchToShared.ps1 and Publish-BookCopy.ps1 -Destination Shared -FromShelf -ReplaceExisting,
 * step for step (S16's publication half, S35).
 *
 * ONE CORE, THREE WRAPPERS, AS THE ORACLE HAS THEM. Every one of the three reaches Publish-SharedBookCandidate.ps1's
 * preflight: the write fence, the collection id, the Shelf Book's own checks and Desk gate, its pages in
 * `Sort-Object FullName` order, each page's frontmatter split from its body, the generated `_book` and
 * `_index`, the two digests and the plan. `publish` adds Remove-ShelfBook.ps1's preflight -- the kernel's
 * own `shelf remove` plan, ported in S14 -- and one composite `plan_id` over both; `publish batch` composes
 * `publish` (or the delete plan alone) per item; `publish refresh` IS the candidate plan.
 *
 * THE CANDIDATE'S PREFLIGHT READS NOTHING FROM A SHARED COLLECTION, measured and read: past the fence it is
 * local. So a refresh preflight is the same document as a first publication's, and `-ReplaceExisting`
 * is neither in it nor in its `plan_id` -- which the kernel carries rather than corrects, and S35 records
 * for the reader. ON A LOCAL LIBRARY IT READS ONE THING MORE (S67): the collection Book's pages that no planned
 * record names, `pages_left_behind`, which the publication never removes. They are bound into the outer approval
 * (`publish`'s composite id, `refresh`'s `refresh_plan_id`), never into the candidate id, which is the resume key.
 *
 * THE CONFIRMED HALVES OF `publish` AND `publish refresh` SINCE S39, after the oracle's own two gates (the
 * confirmation, then the exact `plan_id`): the per-page write, compare and readback, the root's completion
 * state, the Catalog edit (inserted, replaced or moved) and its whole-Catalog readback, both journals and the
 * staged local delete -- held by `publication.shelf-book-publish-confirmed-*` and
 * `publication.refresh-confirmed-*`, each oracle run in disposable projects first.
 *
 * AND `publish batch`'s SINCE S40, held by `publication.batch-confirmed-*`: each bound child plan in order --
 * a publish item through the same workflow `library publish` runs, a delete item through `shelf remove` --
 * every item journalled `processing` and then `complete` or `incomplete` with its child's own sentence, and a
 * failed item left where it was while later items run. Read by hand first: the batch journal is rewritten
 * after every state change, ends with a newline, and carries `"error": null` (a property, not a `[string]`
 * parameter); its file is named after the batch `plan_id`'s last sixteen characters; and `shared_library_write`
 * is true when ANY item completed, a delete-only one included -- the oracle's rule, carried.
 *
 * WHAT WAS MEASURED BEFORE IT WAS WRITTEN (S39). Basic Memory writes a NEW note's frontmatter in the order its
 * metadata arrives and keeps an existing note's order on overwrite, so the root's metadata is sent in the
 * order PowerShell's hashtable enumerates it (see `rootMetadata`); a planted alphabetical order turned the
 * publish row red and left the refresh row green, as that predicts. Both journals write `"error": ""` where
 * the oracle passes `$null` to a `[string]` parameter; the workflow journal ends with a newline and the
 * publication journal does not.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { psConvertToJson } from './psjson.ts';
import type { PsJsonValue } from './psjson.ts';
import { psSortCompare } from './pssort.ts';
import { readStrictUtf8 } from './notebook.ts';
import { getShelfBook } from './shelfbook.ts';
import { assertShelfBookOpen } from './triage.ts';
import { removeVerb, shelfDeletePreflight } from './shelfwriters.ts';
import { McpSession, readExactOrNull, resolveCollectionId, resolveMcpUrl } from './basicmemory.ts';
import type { NoteRecord } from './basicmemory.ts';
import { programRoot } from './programroot.ts';
import { assertCollectionWriteAllowed } from './ownership.ts';
import { isLocalBackend } from './basicmemory.ts';
import { withBookLocks } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { completeBookMutation, enterBookMutation, undoBookMutation, type BookMutation } from './mutation.ts';
import { newBookManifestForCollectionBook } from './collectionbooks.ts';
import {
  collectionPageManifest,
  driftRefusal,
  hasDrift,
  readRecallRecord,
  recallDrift,
  recallRecordDigest,
  recallRecordLabel,
  writeRecallRecord,
  type RecallRecord,
} from './recallrecord.ts';
import {
  composeFrontmatter,
  ensureHeading,
  insertUnderHeading,
  LOCAL_BOOKS_CATALOG_TEXT,
  localPublicationState,
  ownedLines,
  readCatalogOrTemplate,
  splitLocalFrontmatter,
  withoutLine,
  writeCatalog,
} from './localcatalog.ts';

class PublishRefusal extends Error {}

function refuse(message: string): never {
  throw new PublishRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLLECTIONS = ['Projects', 'Reference', 'Workflows'];
const DEFAULT_DELETE_REASON = 'Published and verified in the shared collection.';
const READER_MAP_LABEL_MAX_LENGTH = 300;

function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

function isWithin(child: string, parent: string): boolean {
  const parentPath = parent.replace(/[\\/]+$/, '') + path.sep;
  return child.toLowerCase().startsWith(parentPath.toLowerCase());
}

/** `Get-ChildItem -File -Recurse`, every file below `directory`. */
function filesBelow(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** The candidate's `Split-Frontmatter`: a body with CRLF kept when there is no frontmatter block. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: '', body: content };
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing < 0) return { frontmatter: '', body: content };
  const bodyStart = closing + 5;
  return { frontmatter: normalized.substring(0, bodyStart), body: normalized.substring(bodyStart).replace(/^[\r\n]+|[\r\n]+$/g, '') };
}

/**
 * `Get-ReaderMapLabel` (ShelfNoteCommon.ps1), whole: a page's first H1 outside a fence, NFC, control and
 * format characters spaced, whitespace collapsed, capped at 300 -- or the path without `.md`. `.` is
 * `[^\n]` here because .NET's `.` matches a lone CR and JavaScript's does not.
 */
export function readerMapLabel(text: string, pagePath: string): string {
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$(?![\s\S]))/, '');
  let fenced = false;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^[ \t]{0,3}#[ \t]+([^\n]+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) {
      let title = match[1]!.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ');
      title = title.replace(/\s+/g, ' ').trim();
      if (title.length > READER_MAP_LABEL_MAX_LENGTH) title = title.substring(0, READER_MAP_LABEL_MAX_LENGTH).trimEnd() + '...';
      if (title.length) return title;
    }
  }
  const fallback = pagePath.replace(/\.md$/, '');
  return isBlank(fallback) ? pagePath : fallback;
}

interface CandidateInput {
  shelfSlug: string;
  bookSlug: string;
  title: string;
  summary: string;
  collection: string;
  /** `-BookVersion`, default `0.1.0`: in the root's metadata, not in the plan. */
  bookVersion?: string;
  /** How long the local branch waits for its locks (`--lock-timeout`, seconds). Neither in the plan nor in its id. */
  lockTimeoutSeconds?: number;
  /** The left-behind digest the approval covered, rechecked under the Book lock by the local confirmed half. */
  expectedLeftBehindDigest?: string;
  /** Whether the collection Book was there when the approval was read, rechecked with the digest (inspection). */
  expectedDestinationPresent?: boolean;
  /** The recall record's digest the approval covered ('' for none), rechecked with the drift under the Book lock (S70). */
  expectedRecallDigest?: string;
}

/** `--lock-timeout <seconds>`, twenty when absent or unreadable, as `library hub edit` reads it. */
function lockTimeoutOption(value: string | undefined): number {
  const seconds = Number(value ?? '20');
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 20;
}

/** One planned shared record: `content` is what is written, `body` what a readback is compared with. */
interface CandidateRecord {
  path: string;
  source: string | null;
  content: string;
  body: string;
  sha256: string;
}

interface CandidatePlan {
  plan: Record<string, PsJsonValue>;
  planId: string;
  sourceDigest: string;
  manifestDigest: string;
  projectId: string;
  bookRoot: string;
  sourceBoundary: string;
  records: CandidateRecord[];
  /** Local only: pages already in the collection Book that no planned record names. Empty for Basic Memory. */
  leftBehind: LeftBehind;
  /** Local only: the Shelf Book's recall record and its digest, when it was recalled (S70). */
  recall: { record: RecallRecord; digest: string } | null;
}

/**
 * THE WAY BACK FOR A RECALLED BOOK (S70, PLAN-shelf-recall.md): a Shelf Book with a recall record returns only to the
 * Book it came from, and only while that Book's pages are as the recall found them. Checked at every preview and
 * again under the Book lock; `_book` and `_index` are regenerated, so a change to either is reported, never refused.
 */
function recallCheck(workspace: string, shelfSlug: string, bookSlug: string): { record: RecallRecord; digest: string; regenerated: string[] } | null {
  const record = readRecallRecord(workspace, shelfSlug);
  if (record === null) return null;
  if (record.book_slug !== bookSlug) {
    refuse(
      `shelf/${shelfSlug} was recalled from collection/books/${record.book_slug} (${recallRecordLabel(shelfSlug)}), so it returns there ` +
        `and nowhere else; --book-slug ${bookSlug} names another Book. Leave --book-slug out, or pass --book-slug ${record.book_slug}. ` +
        'Nothing was written.',
    );
  }
  const wiki = path.join(workspace, 'collection', 'books', bookSlug, 'wiki');
  const now = fs.existsSync(wiki) ? collectionPageManifest(wiki) : { pages: [], book_sha256: '', index_sha256: '' };
  const drift = recallDrift(record, now);
  if (hasDrift(drift)) refuse(driftRefusal(bookSlug, shelfSlug, drift));
  const regenerated = [
    ...(now.book_sha256 !== record.book_sha256 ? [`collection/books/${bookSlug}/wiki/_book.md`] : []),
    ...(now.index_sha256 !== record.index_sha256 ? [`collection/books/${bookSlug}/wiki/_index.md`] : []),
  ];
  return { record, digest: recallRecordDigest(record), regenerated };
}

interface LeftBehind {
  pages: { path: string; sha256: string }[];
  /** SHA-256 over the list; '' when it is empty, so an approval with nothing left behind is unchanged. */
  digest: string;
}

/**
 * THE PAGES A LOCAL REFRESH WOULD LEAVE BEHIND (S67, Eric's Q4). A local publication writes its planned records and
 * deletes nothing, while Discovery indexes every file on disk (collectionbooks.ts), so a page the new Shelf copy no
 * longer carries stays findable and drops out of the reader map, and nobody is told. It is reported, bound into the
 * approval, and never removed: removing a collection page is a shared deletion, which has no route yet.
 *
 * THIS IS THE ONE PLACE THE LOCAL PREFLIGHT READS THE DESTINATION; the candidate's own plan_id does not include it,
 * because that id is the resume key written into `_book.md` (approved_plan_id).
 */
function localPagesLeftBehind(workspace: string, bookSlug: string, records: CandidateRecord[]): LeftBehind {
  const wiki = path.join(workspace, 'collection', 'books', bookSlug, 'wiki');
  if (!fs.existsSync(wiki) || !fs.statSync(wiki).isDirectory()) return { pages: [], digest: '' };
  // CASE FOLDED ONLY WHERE THE FILE SYSTEM FOLDS IT (inspection): on a case-sensitive one `Guide.md` is its own page.
  const fold = (value: string) => (process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value);
  const planned = new Set(records.map((record) => fold(record.path)));
  const pages = filesBelow(wiki)
    .filter((file) => path.extname(file).toLowerCase() === '.md')
    .map((file) => ({ file, relative: `books/${bookSlug}/wiki/${file.substring(wiki.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')}` }))
    .filter((item) => !planned.has(fold(item.relative)))
    .map((item) => ({ path: `collection/${item.relative}`, sha256: sha256OfBytes(fs.readFileSync(item.file)) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { pages, digest: pages.length ? sha256OfText(pages.map((page) => `${page.path}|${page.sha256}`).join('\n')) : '' };
}

/**
 * Publish-SharedBookCandidate.ps1 -FromShelf -SourcePath shelf/<slug> -Preflight, step for step. The
 * notebook and capture-note routes of the same publisher are not reached by any `library publish` verb.
 */
function candidatePreflight(workspace: string, input: CandidateInput): CandidatePlan {
  // THE LOCAL BRANCH IS TAKEN FIRST (PLAN-basic-memory.md step 1, Fable #2): a local Library publishes into its own
  // `collection/`, the only publish target in 1.1, so it never resolves an endpoint, never meets the fence and never
  // asks for a Basic Memory collection id -- none of which a connection changes, because nothing is written to
  // Basic Memory in 1.1.
  const local = isLocalBackend(workspace);
  let projectId: string;
  if (local) {
    projectId = localCollectionId(workspace);
  } else {
    resolveMcpUrl(workspace);
    assertCollectionWriteAllowed(workspace, 'publishing to the shared collection');
    projectId = resolveCollectionId(workspace);
  }
  if (!SLUG.test(input.bookSlug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');

  const shelfRoot = path.resolve(workspace, 'shelf');
  let sourceFull = path.resolve(workspace, `shelf/${input.shelfSlug}`);
  if (!isWithin(sourceFull, shelfRoot)) refuse('SourcePath must be inside shelf/ when -FromShelf is used.');
  if (!fs.existsSync(sourceFull)) refuse(`Cannot find path '${sourceFull}' because it does not exist.`);
  if (!fs.statSync(sourceFull).isDirectory()) refuse('SourcePath must name a Shelf Book folder, not a single file, when -FromShelf is used.');
  const shelfSlug = input.shelfSlug;
  let book;
  try {
    book = getShelfBook(workspace, shelfSlug);
  } catch (error) {
    refuse((error as Error).message);
  }
  const shelfWikiRoot = path.resolve(book.wikiPath);
  if (book.isCapture) refuse(`Shelf Book '${shelfSlug}' is a capture Book and cannot be published to the shared collection.`);
  if (!fs.existsSync(shelfWikiRoot) || !fs.statSync(shelfWikiRoot).isDirectory()) {
    refuse(`Shelf Book '${shelfSlug}' has no pages directory at shelf/${shelfSlug}/wiki.`);
  }
  assertShelfBookOpen(workspace, shelfSlug, 'publishing it to the shared collection');
  sourceFull = shelfWikiRoot;
  const sourceBoundary = `shelf/${shelfSlug}/wiki`;
  const files = filesBelow(sourceFull)
    .filter((file) => path.extname(file).toLowerCase() === '.md')
    .filter((file) => {
      const relative = file.substring(sourceFull.length).replace(/^[\\/]+/, '').replace(/\\/g, '/').toLowerCase();
      return relative !== '_book.md' && relative !== '_index.md';
    })
    .sort(psSortCompare);
  if (files.length === 0) refuse('The selected Shelf Book contains no publishable Markdown pages.');
  if (local) assertNotArchivedAway(workspace, input.bookSlug);
  const recall = local ? recallCheck(workspace, shelfSlug, input.bookSlug) : null;

  const bookRoot = `books/${input.bookSlug}/wiki`;
  const sources = files.map((file) => {
    const relative = file.substring(sourceFull.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const content = readStrictUtf8(file);
    const parts = splitFrontmatter(content);
    if (parts.frontmatter && isBlank(parts.body)) refuse(`Source page '${file}' has frontmatter but no body.`);
    if (parts.body.startsWith('\r') || parts.body.startsWith('\n')) refuse(`Source page '${file}' starts with a blank line and cannot be published safely.`);
    return {
      path: `${bookRoot}/${relative}`,
      source: `${sourceBoundary}/${relative}`,
      content,
      frontmatter: parts.frontmatter,
      body: parts.body,
      sha256: sha256OfText(parts.body),
    };
  });
  const frontmatterPageCount = sources.filter((source) => source.frontmatter.length > 0).length;
  const sourceDigest = sha256OfText(sources.map((source) => `${source.source}|${source.sha256}`).join('\n'));
  const links = [`- [[${bookRoot}/_book|Book metadata and limits]]`].concat(
    sources.map((source) => {
      const target = source.path.substring(0, source.path.length - 3);
      const relative = source.path.substring(bookRoot.length + 1);
      return `- [[${target}|${readerMapLabel(source.body, relative)}]]`;
    }),
  );
  const rootBody = `# ${input.title}\n\n## Purpose\n\n${input.summary}\n\n## Reader map\n\n- [[${bookRoot}/_index|Open the reader map]]\n`;
  const indexBody = `# ${input.title} - Reader Map\n\n${links.join('\n')}\n`;
  const records: CandidateRecord[] = [
    { path: `${bookRoot}/_book.md`, source: null, content: rootBody, body: rootBody, sha256: sha256OfText(rootBody) },
    { path: `${bookRoot}/_index.md`, source: null, content: indexBody, body: indexBody, sha256: sha256OfText(indexBody) },
    ...sources.map((source) => ({ path: source.path, source: source.source, content: source.content, body: source.body, sha256: source.sha256 })),
  ];
  const manifestDigest = sha256OfText(records.map((record) => `${record.path}|${record.sha256}|${record.source ?? ''}`).join('\n'));
  const planId = `shelf-copy-${sourceDigest}-${manifestDigest}`;
  const leftBehind = local ? localPagesLeftBehind(workspace, input.bookSlug, records) : { pages: [], digest: '' };
  return {
    planId,
    sourceDigest,
    manifestDigest,
    projectId,
    bookRoot,
    sourceBoundary,
    records,
    leftBehind,
    recall: recall === null ? null : { record: recall.record, digest: recall.digest },
    plan: {
      ...(local ? { pages_left_behind: leftBehind.pages as unknown as PsJsonValue } : {}),
      ...(recall !== null
        ? {
            recall_record: recallRecordLabel(shelfSlug),
            recalled_from: `collection/books/${recall.record.book_slug}`,
            recall_digest: recall.digest,
            recall_regenerates: recall.regenerated,
            ...(recall.regenerated.length
              ? { recall_note: `${recall.regenerated.join(' and ')} changed after the recall; the return regenerates them, so that change will not survive.` }
              : {}),
          }
        : {}),
      operation: 'Publish a Copy',
      destination: local ? 'collection' : 'shared',
      ...(local ? { collection_id: projectId } : { project_id: projectId }),
      book_slug: input.bookSlug,
      collection: input.collection,
      source: sourceBoundary,
      source_file_count: sources.length,
      frontmatter_page_count: frontmatterPageCount,
      include_pages: sources.map((source) => source.source),
      source_digest_sha256: sourceDigest,
      page_manifest_sha256: manifestDigest,
      plan_id: planId,
      planned_shared_records: records.map((record) => ({ path: record.path, sha256: record.sha256, source_path: record.source })),
      confirmation_required: true,
      shared_library_write: false,
      local_original_preserved: true,
    },
  };
}

/**
 * A SLUG WHOSE BOOK IS IN THE COLLECTION'S ARCHIVE AND NOT ON ITS ACTIVE SHELF IS NOT PUBLISHED TO (S67, inspection
 * round 2): a publication would recreate the Book beside its archived copy. It is refused at the preview and again
 * under the Book lock, so a Book archived between the preview and the yes is never brought back by the run.
 */
function assertNotArchivedAway(workspace: string, bookSlug: string): void {
  const active = fs.existsSync(path.join(workspace, 'collection', 'books', bookSlug, 'wiki'));
  const archived = fs.existsSync(path.join(workspace, 'collection', 'archive', bookSlug, 'wiki'));
  if (!active && archived) {
    refuse(
      `Book '${bookSlug}' is in this Library's collection archive (collection/archive/${bookSlug}) and not on its active shelf, so ` +
        'publishing it would recreate it beside the archived copy. Restore it first, or publish under another --book-slug. Nothing was written.',
    );
  }
}

/** The Local collection's persistent id, read from where `library init` records it; a Library without one is told to run init. */
function localCollectionId(workspace: string): string {
  const file = path.join(workspace, 'collection', '.library', 'collection.json');
  if (!fs.existsSync(file)) refuse(`This Library has no Local collection yet: ${file} does not exist. Run library init in it, which lays out collection/.`);
  let id = '';
  try {
    id = String((JSON.parse(readStrictUtf8(file)) as Record<string, unknown>)['id'] ?? '');
  } catch {
    id = '';
  }
  if (!id.trim()) refuse(`${file} carries no readable id, so the Local collection's identity cannot be confirmed.`);
  return id;
}

// --- the candidate's confirmed half (S39) -------------------------------------------------------------------

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

function toolRejected(response: unknown): boolean {
  const error = field(response, 'error');
  return (error !== undefined && error !== null) || field(field(response, 'result'), 'isError') === true;
}

/** `[string]` of a value ConvertFrom-Json produced, as `Meta` renders it: `True`/`False` for a boolean. */
function psText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return value === null || value === undefined ? '' : String(value);
}

/** `Meta`: a frontmatter value by name, looked up as `PSObject.Properties[...]` does -- case-insensitively. */
function meta(record: NoteRecord | null, name: string): string | null {
  const frontmatter = record?.frontmatter;
  if (frontmatter === null || frontmatter === undefined || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return null;
  const key = Object.keys(frontmatter as Record<string, unknown>).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : psText((frontmatter as Record<string, unknown>)[key]);
}

/** `Get-PublicationState`, with the pilot's `guild_state` spellings (a `switch`: case-insensitive). */
function publicationState(record: NoteRecord | null): string | null {
  const state = meta(record, 'publication_state');
  if (state !== null && state.trim().length > 0) return state;
  switch ((meta(record, 'guild_state') ?? '').toLowerCase()) {
    case 'incomplete-candidate':
      return 'copying';
    case 'candidate':
      return 'complete';
    default:
      return null;
  }
}

/** `Normalize`: both ends' CR and LF trimmed, then CRLF made LF. */
function normalizeBody(body: string): string {
  return body.replace(/^[\r\n]+|[\r\n]+$/g, '').split('\r\n').join('\n');
}

function codeAt(text: string, offset: number): string {
  return offset < text.length ? 'U+' + text.charCodeAt(offset).toString(16).toUpperCase().padStart(4, '0') : '<end>';
}

/** `Assert-Matches`: the readback against the planned body, and on a difference the first differing UTF-16 unit. */
function assertMatches(record: NoteRecord, expected: CandidateRecord, writeReadback: boolean): void {
  const actual = normalizeBody(record.content);
  const wanted = normalizeBody(expected.body);
  const actualHash = sha256OfText(actual);
  const wantedHash = sha256OfText(wanted);
  if (actualHash === wantedHash) return;
  const limit = Math.min(actual.length, wanted.length);
  let offset = 0;
  while (offset < limit && actual[offset] === wanted[offset]) offset++;
  const message = writeReadback ? `Page '${expected.path}' did not read back as written` : `Existing record '${expected.path}' differs from the approved manifest`;
  refuse(
    `${message} at offset ${offset} (actual ${codeAt(actual, offset)}, expected ${codeAt(wanted, offset)}; actual length ${actual.length}, ` +
      `expected length ${wanted.length}; actual SHA-256 ${actualHash}, expected SHA-256 ${wantedHash}).`,
  );
}

/**
 * The root's metadata IN THE ORDER POWERSHELL'S HASHTABLE ENUMERATES IT (measured S39, .NET Framework 4, whose
 * string hashing is not randomised). The order matters because Basic Memory writes a NEW note's frontmatter in
 * the order it is given -- the published root reads exactly this way -- while an overwrite keeps the existing
 * note's order and appends what is new. The key set is fixed; a key added to the oracle's `$metadata` is a
 * new measurement, not an edit to this list.
 */
function rootMetadata(candidate: CandidatePlan, input: CandidateInput, state: string): Record<string, PsJsonValue> {
  const values: Record<string, PsJsonValue> = {
    source_workspace: 'local-library-workspace',
    collection: input.collection,
    page_manifest_sha256: candidate.manifestDigest,
    publication_state: state,
    reader_map_path: `${candidate.bookRoot}/_index.md`,
    book_slug: input.bookSlug,
    planned_page_count: candidate.records.length,
    book_version: input.bookVersion ?? '0.1.0',
    approved_plan_id: candidate.planId,
    source_digest_sha256: candidate.sourceDigest,
    source_boundary: candidate.sourceBoundary,
  };
  const order = [
    'source_workspace', ...(input.collection ? ['collection'] : []), 'page_manifest_sha256', 'publication_state', 'reader_map_path',
    'book_slug', 'planned_page_count', 'book_version', 'approved_plan_id', 'source_digest_sha256', 'source_boundary',
  ];
  const ordered: Record<string, PsJsonValue> = {};
  for (const key of order) ordered[key] = values[key]!;  return ordered;
}

/** `Get-OwnedCatalogEntries`: every line carrying this Book's link target, with the `## ` heading it sits under. */
function ownedCatalogEntries(catalogText: string, prefix: string): { line: string; heading: string | null }[] {
  let heading: string | null = null;
  const owned: { line: string; heading: string | null }[] = [];
  for (const line of catalogText.split(/\r?\n/)) {
    if (/^##\s+\S/.test(line)) heading = line.trimEnd();
    else if (line.trimStart().startsWith(prefix)) owned.push({ line, heading });
  }
  return owned;
}

/**
 * Publish-SharedBookCandidate.ps1's confirmed half, after its two gates: the root first (created, resumed or
 * replaced), every other record read, reused or written, a health check over all of them, the root marked
 * complete, the Catalog line inserted, replaced or moved and read back, and the journal. Any failure journals
 * `copying` and is reported under the oracle's one sentence.
 */
async function candidateConfirmed(
  workspace: string,
  input: CandidateInput,
  candidate: CandidatePlan,
  replaceExisting: boolean,
  journalOption: string,
): Promise<Record<string, PsJsonValue>> {
  if (isLocalBackend(workspace)) return localCandidateConfirmed(workspace, input, candidate, replaceExisting, journalOption);
  const journalPath = isBlank(journalOption)
    ? path.join(workspace, 'internal', 'publication-journals', `${input.bookSlug}-${candidate.sourceDigest}.json`)
    : path.resolve(journalOption);
  const projectId = candidate.projectId;
  const records = candidate.records;
  const attempted: string[] = [];
  const created: string[] = [];
  const reused: string[] = [];
  const saveJournal = (state: string, errorText: string): void => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const journal: Record<string, PsJsonValue> = {
      state,
      timestamp_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
      project_id: projectId,
      book_slug: input.bookSlug,
      collection: input.collection,
      source_digest_sha256: candidate.sourceDigest,
      page_manifest_sha256: candidate.manifestDigest,
      approved_plan_id: candidate.planId,
      planned_records: records.filter((record) => record.source).map((record) => ({ path: record.path, source: record.source, sha256: record.sha256 })),
      attempted_records: [...attempted],
      created_records: [...created],
      reused_records: [...reused],
      // A `[string]` parameter: `$null` arrives as ''.
      error: errorText,
    };
    fs.writeFileSync(journalPath, psConvertToJson(journal), 'utf8');
  };
  const words = { includeFrontmatter: false, stopped: 'publication stopped' };
  try {
    const session = new McpSession(resolveMcpUrl(workspace), 'library-resumable-publisher');
    await session.initialize();
    const createRecord = async (expected: CandidateRecord, metadata: Record<string, PsJsonValue> | null, overwrite: boolean): Promise<void> => {
      const args: Record<string, PsJsonValue> = {
        project_id: projectId,
        directory: expected.path.substring(0, expected.path.lastIndexOf('/')),
        title: path.posix.parse(expected.path).name,
        content: expected.content,
        note_type: 'note',
        overwrite,
        output_format: 'json',
      };
      if (metadata !== null) args['metadata'] = metadata;
      const response = await session.callTool('write_note', args as Record<string, never>);
      if (toolRejected(response)) refuse(`Write '${expected.path}' was rejected.`);
      if (String(field(field(field(field(response, 'result'), 'structuredContent'), 'result'), 'action') ?? '') === 'conflict') {
        refuse(
          `Write '${expected.path.substring(0, expected.path.length - 3)}' was refused: a note already exists there, written by someone else ` +
            'since this run read the collection. Nothing was overwritten.',
        );
      }
      const record = await readExactOrNull(session, projectId, expected.path, words);
      if (record === null) refuse(`Write '${expected.path}' did not become readable.`);
      assertMatches(record, expected, true);
    };

    const rootRecord = records[0]!;
    const root = await readExactOrNull(session, projectId, rootRecord.path, words);
    const copying = rootMetadata(candidate, input, 'copying');
    if (root === null) {
      attempted.push(rootRecord.path);
      await createRecord(rootRecord, copying, false);
      created.push(rootRecord.path);
    } else {
      const rootKeys = ['book_slug', 'source_digest_sha256', 'page_manifest_sha256', 'approved_plan_id', ...(input.collection ? ['collection'] : [])];
      const sameRoot = rootKeys.every((name) => meta(root, name) === psText(copying[name]));
      if (!sameRoot) {
        if (!replaceExisting) refuse('Existing Book has a different source or manifest. Review the preflight and rerun with --replace-existing to refresh this exact Book.');
        if (meta(root, 'book_slug') !== input.bookSlug) refuse('Existing root does not belong to this Book slug; it will not be replaced.');
        attempted.push(rootRecord.path);
        await createRecord(rootRecord, copying, true);
        created.push(rootRecord.path);
      } else {
        // `-notin`: case-insensitive.
        if (!['copying', 'complete'].includes((publicationState(root) ?? '').toLowerCase())) refuse('Existing root is not resumable.');
        assertMatches(root, rootRecord, false);
        reused.push(rootRecord.path);
      }
    }
    for (const expected of records.slice(1)) {
      const record = await readExactOrNull(session, projectId, expected.path, words);
      if (record === null) {
        attempted.push(expected.path);
        await createRecord(expected, null, false);
        created.push(expected.path);
        continue;
      }
      try {
        assertMatches(record, expected, false);
        reused.push(expected.path);
      } catch (error) {
        if (!replaceExisting) throw error;
        attempted.push(expected.path);
        await createRecord(expected, null, true);
        created.push(expected.path);
      }
    }
    for (const expected of records) {
      const record = await readExactOrNull(session, projectId, expected.path, words);
      if (record === null) refuse(`Health check could not read '${expected.path}'.`);
      assertMatches(record, expected, true);
    }
    // `-ne`: case-insensitive, so a root already reading `Complete` is not rewritten.
    if ((publicationState(await readExactOrNull(session, projectId, rootRecord.path, words)) ?? '').toLowerCase() !== 'complete') {
      const response = await session.callTool('write_note', {
        project_id: projectId,
        directory: rootRecord.path.substring(0, rootRecord.path.lastIndexOf('/')),
        title: path.posix.parse(rootRecord.path).name,
        content: rootRecord.content,
        note_type: 'note',
        metadata: rootMetadata(candidate, input, 'complete') as Record<string, never>,
        overwrite: true,
        output_format: 'json',
      });
      if (toolRejected(response)) {
        const rpc = field(response, 'error');
        const failure =
          rpc !== undefined && rpc !== null
            ? psText(field(rpc, 'message'))
            : field(field(response, 'result'), 'isError') === true
              ? JSON.stringify(field(field(response, 'result'), 'content') ?? null)
              : 'Unknown MCP tool failure.';
        refuse(`Publication completion update was rejected: ${failure}`);
      }
      const record = await readExactOrNull(session, projectId, rootRecord.path, words);
      if (record === null) refuse('Publication completion update made the root unreadable.');
      assertMatches(record, rootRecord, true);
      if (publicationState(record) !== 'complete') refuse('Publication completion readback did not match.');
    }
    if (publicationState(await readExactOrNull(session, projectId, rootRecord.path, words)) !== 'complete') refuse('Publication completion readback did not match.');

    // THE CATALOG LINE THIS BOOK OWNS, identified by its link target.
    const entry = `- [[${candidate.bookRoot}/_book|${input.title}]] — ${input.summary}`;
    const ownedPrefix = `- [[${candidate.bookRoot}/_book|`;
    let catalog = await readExactOrNull(session, projectId, 'books/README.md', words);
    if (catalog === null) refuse('The Book Catalog is missing; it will not be created implicitly.');
    let targetHeading = '## Open a Book';
    let placementRequested = false;
    if (input.collection) {
      for (const heading of COLLECTIONS) {
        if (!new RegExp(`^## ${heading}\\s*$`, 'im').test(catalog.content)) {
          const block = COLLECTIONS.map((name) => `## ${name}\n`).join('\n');
          const response = await session.callTool('edit_note', {
            project_id: projectId,
            identifier: 'books/README',
            operation: 'find_replace',
            find_text: '## Open a Book',
            content: `${block}\n## Open a Book`,
            expected_replacements: 1,
            output_format: 'json',
          });
          if (toolRejected(response)) refuse('Book Catalog collection headings could not be created.');
          catalog = await readExactOrNull(session, projectId, 'books/README.md', words);
          break;
        }
      }
      targetHeading = `## ${input.collection}`;
      placementRequested = true;
    }
    const owned = ownedCatalogEntries(catalog?.content ?? '', ownedPrefix);
    let edits: { name: string; findText: string; content: string }[] = [];
    let catalogEntryState = 'already-current';
    let movedFrom: string | null = null;
    if (owned.length === 0) {
      edits = [{ name: 'insert', findText: targetHeading, content: `${targetHeading}\n\n${entry}` }];
      catalogEntryState = 'inserted';
    } else if (owned.length > 1) {
      refuse(`The Book Catalog carries ${owned.length} entry lines linking '${candidate.bookRoot}/_book'; it will not guess which one this publication owns.`);
    } else if (placementRequested && owned[0]!.heading !== targetHeading) {
      // REMOVE FIRST, THEN INSERT: a half-finished move then leaves no line, which the next run heals.
      movedFrom = owned[0]!.heading;
      edits = [
        { name: 'remove-from-old-collection', findText: owned[0]!.line, content: '' },
        { name: 'insert-under-new-collection', findText: targetHeading, content: `${targetHeading}\n\n${entry}` },
      ];
      catalogEntryState = 'moved';
    } else if (owned[0]!.line !== entry) {
      edits = [{ name: 'replace-in-place', findText: owned[0]!.line, content: entry }];
      catalogEntryState = 'replaced';
    }
    for (const step of edits) {
      const response = await session.callTool('edit_note', {
        project_id: projectId,
        identifier: 'books/README',
        operation: 'find_replace',
        output_format: 'json',
        find_text: step.findText,
        content: step.content,
        expected_replacements: 1,
      });
      if (toolRejected(response)) refuse(`Book Catalog update was rejected (planned '${catalogEntryState}', step '${step.name}').`);
    }
    catalog = await readExactOrNull(session, projectId, 'books/README.md', words);
    // THE COUNT IS TAKEN OVER THE WHOLE CATALOG, never within a section.
    const ownedAfter = ownedCatalogEntries(catalog?.content ?? '', ownedPrefix);
    const catalogEntryVerified = ownedAfter.length === 1 && ownedAfter[0]!.line === entry;
    if (!catalogEntryVerified) refuse(`Book Catalog readback did not carry this Book's current entry line exactly once: '${entry}'.`);
    const catalogEntryHeading = ownedAfter[0]!.heading;
    if (placementRequested && catalogEntryHeading !== targetHeading) {
      refuse(
        `Book Catalog readback filed this Book's entry under '${catalogEntryHeading === null ? 'no collection heading' : catalogEntryHeading}' ` +
          `rather than the requested '${targetHeading}'.`,
      );
    }
    saveJournal('complete', '');
    return {
      operation: 'Publish a Copy',
      destination: 'shared',
      book_path: candidate.bookRoot,
      publication_complete: true,
      catalog_entry_verified: catalogEntryVerified,
      catalog_updated: edits.length > 0,
      catalog_entry_state: catalogEntryState,
      catalog_entry_heading: catalogEntryHeading,
      catalog_entry_moved_from: movedFrom,
      catalog_entry: entry,
      journal_path: journalPath,
      created_records: created,
      reused_records: reused,
      local_original_preserved: true,
    };
  } catch (error) {
    const message = (error as Error).message;
    saveJournal('copying', message);
    refuse(
      'Shared publication stopped safely. No local source was changed. Resume is allowed only when the existing root metadata and manifest ' +
        `match. Journal: ${journalPath}. ${message}`,
    );
  }
}

// --- the local branch's confirmed half (PLAN-basic-memory.md step 1, B0) ----------------------------------------

/**
 * The candidate's confirmed half, into the Local collection, as a plain file writer. TODAY'S CONTRACT, KEPT: the
 * root first, `copying`, then every page written and read back, a health check over all of them, the root
 * `complete` with its frontmatter keys in their fixed order, the catalog line inserted, replaced or moved and the
 * whole catalog read back, and the journal in `internal/publication-journals/` -- the same file the shared
 * publisher writes. Resumable by the same rule: an existing root is reused only when its metadata names this
 * exact source and manifest.
 *
 * THE LOCKS ARE THE BOOK'S AND THE CATALOG'S, TAKEN TOGETHER (Fable #8, round 2): `books/<slug>` and
 * `collection/books`, the name `library hub new`'s catalog lock is spelled in, sorted by `withBookLocks` as an
 * import's are, so a publish and an import can never interleave on `books/README.md` and never deadlock.
 *
 * AND ITS DISCOVERY MANIFEST IS COMMITTED IN THE SAME WINDOW (step 1, F20): marker down before the first write,
 * generation up after the catalog proves, so a published Book is found by the next search.
 */
async function localCandidateConfirmed(
  workspace: string,
  input: CandidateInput,
  candidate: CandidatePlan,
  replaceExisting: boolean,
  journalOption: string,
): Promise<Record<string, PsJsonValue>> {
  const journalPath = isBlank(journalOption)
    ? path.join(workspace, 'internal', 'publication-journals', `${input.bookSlug}-${candidate.sourceDigest}.json`)
    : path.resolve(journalOption);
  const collectionRoot = path.join(workspace, 'collection');
  const fileFor = (relative: string) => path.join(collectionRoot, ...relative.split('/'));
  const records = candidate.records;
  const attempted: string[] = [];
  const created: string[] = [];
  const reused: string[] = [];
  const saveJournal = (state: string, errorText: string): void => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const journal: Record<string, PsJsonValue> = {
      state,
      timestamp_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
      destination: 'collection',
      collection_id: candidate.projectId,
      book_slug: input.bookSlug,
      collection: input.collection,
      source_digest_sha256: candidate.sourceDigest,
      page_manifest_sha256: candidate.manifestDigest,
      approved_plan_id: candidate.planId,
      planned_records: records.filter((record) => record.source).map((record) => ({ path: record.path, source: record.source, sha256: record.sha256 })),
      attempted_records: [...attempted],
      created_records: [...created],
      reused_records: [...reused],
      error: errorText,
    };
    fs.writeFileSync(journalPath, psConvertToJson(journal), 'utf8');
  };
  const readFile = (relative: string): string | null => {
    const file = fileFor(relative);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? readStrictUtf8(file) : null;
  };
  const rootRecord = records[0]!;
  const rootText = (state: string) => composeFrontmatter(rootMetadata(candidate, input, state)) + '\n' + rootRecord.content;
  const write = (relative: string, text: string, check: (back: string) => boolean): void => {
    writeAtomicText(fileFor(relative), text);
    const back = readFile(relative);
    if (back === null) refuse(`Write '${relative}' did not become readable.`);
    if (!check(back)) refuse(`Page '${relative}' did not read back as written.`);
  };
  const rootMatches = (text: string): boolean => normalizeBody(splitLocalFrontmatter(text).body) === normalizeBody(rootRecord.body);

  // A FIXTURE SWITCH, for kernel self-test section 68 and nothing else, as import's is: the run held after its
  // outside-lock re-run and BEFORE the locks, so an `add-page` can land in the one window only the in-lock recheck sees.
  const pause = Number((process.env['LIBRARY_PUBLISH_PAUSE_BEFORE_WRITES_MS'] ?? '').trim() || 0);
  if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pause, 60000));

  return withBookLocks(workspace, [candidate.bookRoot.replace(/\/wiki$/, ''), 'collection/books'], input.lockTimeoutSeconds ?? 20, (locks) => {
    const bookLock = locks.find((lock) => lock.bookRoot === candidate.bookRoot.replace(/\/wiki$/, ''))!;
    // THE RECALL, AGAIN, UNDER THE LOCK (S70): the record the approval covered, and no drift since. An `add-page`
    // between the preview and the yes waits on this lock, so it is either seen here or lands after the return. First,
    // because a page added to a recalled Book is drift, and the drift refusal names it and the routes.
    if (input.expectedRecallDigest !== undefined) {
      const recall = recallCheck(workspace, input.shelfSlug, input.bookSlug);
      if ((recall?.digest ?? '') !== input.expectedRecallDigest) {
        refuse(`The recall record for shelf/${input.shelfSlug} changed after the preview, so the approval no longer describes this return. Rerun --preflight. Nothing was written.`);
      }
    }
    // THE PAGES LEFT BEHIND, AGAIN, UNDER THE LOCK (S67): the approval covered a list read with nobody excluded.
    if (input.expectedLeftBehindDigest !== undefined) {
      const now = localPagesLeftBehind(workspace, input.bookSlug, candidate.records);
      assertNotArchivedAway(workspace, input.bookSlug);
      const present = fs.existsSync(path.join(workspace, 'collection', 'books', input.bookSlug, 'wiki'));
      if (input.expectedDestinationPresent !== undefined && present !== input.expectedDestinationPresent) {
        refuse(
          `collection/books/${input.bookSlug} ${present ? 'appeared' : 'left the active shelf'} after the preview, so the approval no longer ` +
            'describes what the run would do. Rerun --preflight. Nothing was written.',
        );
      }
      if (now.digest !== input.expectedLeftBehindDigest) {
        refuse(
          `The pages this publication would leave behind in collection/books/${input.bookSlug}/wiki changed after the preview, so the ` +
            'approval no longer describes what the run would do. Rerun --preflight. Nothing was written.',
        );
      }
    }
    let mutation: BookMutation | null = null;
    try {
      mutation = enterBookMutation({
        workspace,
        slug: input.bookSlug,
        bookRoot: `books/${input.bookSlug}`,
        reason: `Publish ${candidate.planId} into the Local collection`,
        lock: bookLock,
        collection: 'collection',
      });
      saveJournal('copying', '');

      // THE ROOT: created, resumed or replaced, by the shared publisher's rule.
      const existingRoot = readFile(rootRecord.path);
      const copying = rootMetadata(candidate, input, 'copying');
      if (existingRoot === null) {
        attempted.push(rootRecord.path);
        write(rootRecord.path, rootText('copying'), rootMatches);
        created.push(rootRecord.path);
      } else {
        const fields = splitLocalFrontmatter(existingRoot).fields ?? new Map<string, string>();
        const rootKeys = ['book_slug', 'source_digest_sha256', 'page_manifest_sha256', 'approved_plan_id', ...(input.collection ? ['collection'] : [])];
        const sameRoot = rootKeys.every((name) => (fields.get(name) ?? null) === psText(copying[name]));
        if (!sameRoot) {
          if (!replaceExisting) refuse('Existing Book has a different source or manifest. Review the preflight and rerun with --replace-existing to refresh this exact Book.');
          if ((fields.get('book_slug') ?? null) !== input.bookSlug) refuse('Existing root does not belong to this Book slug; it will not be replaced.');
          attempted.push(rootRecord.path);
          write(rootRecord.path, rootText('copying'), rootMatches);
          created.push(rootRecord.path);
        } else {
          if (!['copying', 'complete'].includes((localPublicationState(fields) ?? '').toLowerCase())) refuse('Existing root is not resumable.');
          if (!rootMatches(existingRoot)) refuse(`Existing record '${rootRecord.path}' differs from the approved manifest.`);
          reused.push(rootRecord.path);
        }
      }

      // EVERY OTHER PAGE, byte for byte as planned: absent is written, identical is reused, different is a refusal
      // unless this is a refresh.
      for (const expected of records.slice(1)) {
        const existing = readFile(expected.path);
        if (existing === null) {
          attempted.push(expected.path);
          write(expected.path, expected.content, (back) => back === expected.content);
          created.push(expected.path);
          continue;
        }
        if (existing === expected.content) {
          reused.push(expected.path);
          continue;
        }
        if (!replaceExisting) refuse(`Existing record '${expected.path}' differs from the approved manifest.`);
        attempted.push(expected.path);
        write(expected.path, expected.content, (back) => back === expected.content);
        created.push(expected.path);
      }
      // THE HEALTH CHECK, over all of them, before the root says complete.
      for (const expected of records) {
        const back = readFile(expected.path);
        if (back === null) refuse(`Health check could not read '${expected.path}'.`);
        if (expected === rootRecord ? !rootMatches(back) : back !== expected.content) refuse(`Page '${expected.path}' did not read back as written.`);
      }
      const rootNow = readFile(rootRecord.path)!;
      if ((localPublicationState(splitLocalFrontmatter(rootNow).fields) ?? '').toLowerCase() !== 'complete') {
        write(rootRecord.path, rootText('complete'), (back) => rootMatches(back) && localPublicationState(splitLocalFrontmatter(back).fields) === 'complete');
      }

      // THE CATALOG LINE THIS BOOK OWNS, identified by its link target; a heading it needs is inserted, not refused.
      const catalogFile = fileFor('books/README.md');
      const entry = `- [[${candidate.bookRoot}/_book|${input.title}]] — ${input.summary}`;
      const target = `${candidate.bookRoot}/_book`;
      let catalog = readCatalogOrTemplate(catalogFile, LOCAL_BOOKS_CATALOG_TEXT).text;
      const targetHeading = input.collection ? `## ${input.collection}` : '## Open a Book';
      catalog = ensureHeading(catalog, targetHeading, input.collection ? '## Open a Book' : null).text;
      const owned = ownedLines(catalog, [target]);
      let catalogEntryState = 'already-current';
      let movedFrom: string | null = null;
      if (owned.length === 0) {
        catalog = insertUnderHeading(catalog, targetHeading, entry);
        catalogEntryState = 'inserted';
      } else if (owned.length > 1) {
        refuse(`The Book Catalog carries ${owned.length} entry lines linking '${target}'; it will not guess which one this publication owns.`);
      } else if (input.collection && owned[0]!.heading !== targetHeading) {
        movedFrom = owned[0]!.heading;
        catalog = insertUnderHeading(withoutLine(catalog, owned[0]!.index), targetHeading, entry);
        catalogEntryState = 'moved';
      } else if (owned[0]!.line !== entry) {
        const lines = catalog.replace(/\r\n/g, '\n').split('\n');
        lines[owned[0]!.index] = entry;
        catalog = lines.join('\n');
        catalogEntryState = 'replaced';
      }
      const before = readCatalogOrTemplate(catalogFile, '').text;
      const catalogUpdated = catalog !== before;
      if (catalogUpdated) catalog = writeCatalog(catalogFile, catalog);
      const ownedAfter = ownedLines(catalog, [target]);
      const catalogEntryVerified = ownedAfter.length === 1 && ownedAfter[0]!.line === entry;
      if (!catalogEntryVerified) refuse(`Book Catalog readback did not carry this Book's current entry line exactly once: '${entry}'.`);
      const catalogEntryHeading = ownedAfter[0]!.heading;
      if (input.collection && catalogEntryHeading !== targetHeading) {
        refuse(`Book Catalog readback filed this Book's entry under '${catalogEntryHeading ?? 'no collection heading'}' rather than the requested '${targetHeading}'.`);
      }

      // THE RECALL RECORD FOLLOWS A VERIFIED RETURN (S70, Q8): rebuilt FROM DISK, after the root's `complete` rewrite and
      // the catalog readback, so the Shelf copy's next return checks drift against what is now there -- left-behind pages
      // included, which no planned record names. Never thrown: the return has landed, and a stale record only refuses.
      let recallRecord: string | null = null;
      const recalled = readRecallRecord(workspace, input.shelfSlug);
      if (recalled !== null) {
        try {
          const now = collectionPageManifest(path.join(workspace, 'collection', 'books', input.bookSlug, 'wiki'));
          writeRecallRecord(workspace, { ...recalled, ...now, title: input.title, summary: input.summary, refreshed_utc: new Date().toISOString() });
          recallRecord = `${recallRecordLabel(input.shelfSlug)} rewritten with the collection Book as this return left it`;
        } catch (error) {
          recallRecord = `${recallRecordLabel(input.shelfSlug)} NOT rewritten (${(error as Error).message}); the next return will refuse on drift until it is recalled again`;
        }
      }

      const manifest = completeBookMutation(mutation, newBookManifestForCollectionBook(workspace, 'active', input.bookSlug));
      mutation = null;
      saveJournal('complete', '');
      return {
        operation: 'Publish a Copy',
        destination: 'collection',
        book_path: candidate.bookRoot,
        publication_complete: true,
        catalog_entry_verified: catalogEntryVerified,
        catalog_updated: catalogUpdated,
        catalog_entry_state: catalogEntryState,
        catalog_entry_heading: catalogEntryHeading,
        catalog_entry_moved_from: movedFrom,
        catalog_entry: entry,
        journal_path: journalPath,
        created_records: created,
        reused_records: reused,
        discovery_manifest: manifest.summary,
        ...(recallRecord !== null ? { recall_record: recallRecord } : {}),
        pages_left_behind: candidate.leftBehind.pages as unknown as PsJsonValue,
        ...(candidate.leftBehind.pages.length
          ? {
              left_behind_note:
                `${candidate.leftBehind.pages.length} page(s) already in collection/books/${input.bookSlug}/wiki are not in this ` +
                'publication. They were left as they are: still on disk, still found by Discovery, and no longer in the reader map.',
            }
          : {}),
        local_original_preserved: true,
      };
    } catch (error) {
      const message = (error as Error).message;
      // NOTHING WRITTEN, NOTHING DIRTY: a refusal before the first write leaves the Book as its manifest describes.
      // After one, the Book's state is not what any manifest says, and `dirty` is the honest answer until a rebuild.
      if (mutation !== null && attempted.length === 0) undoBookMutation(mutation);
      saveJournal('copying', message);
      refuse(
        'Local publication stopped safely. No Shelf source was changed. Resume is allowed only when the existing root metadata and manifest ' +
          `match. Journal: ${journalPath}. ${message}`,
      );
    }
  });
}

// --- the arguments ----------------------------------------------------------------------------------------

interface PublishInput extends CandidateInput {
  topics: string;
  bookVersion: string;
  replaceExisting: boolean;
  deleteReason: string;
}

/** `[ValidateSet('Projects','Reference','Workflows')]`: matched case-insensitively, kept as typed. */
function collectionOption(value: string | undefined): string {
  if (value === undefined) return '';
  if (!COLLECTIONS.some((name) => name.toLowerCase() === value.toLowerCase())) {
    refuse(`library publish --collection is Projects, Reference or Workflows; got '${value}'.`);
  }
  return value;
}

/** The mandatory parameters, which PowerShell's binder refuses before a script's body runs. */
function required(value: string | undefined, name: string, usage: string): string {
  if (value === undefined || value === '') refuse(`library ${usage} needs ${name}.`);
  return value;
}

const VALUED = [
  'title', 'summary', 'book-slug', 'collection', 'topics', 'book-version', 'reason', 'plan', 'workspace', 'plan-id',
  'journal-path', 'publication-journal-path', 'workflow-journal-path', 'lock-timeout',
];

// --- library publish ----------------------------------------------------------------------------------------

/** Publish-ShelfBookToShared.ps1 as far as its composite plan. */
function publishPlan(workspace: string, input: PublishInput): Record<string, PsJsonValue> {
  const local = isLocalBackend(workspace);
  const projectId = local ? localCollectionId(workspace) : resolveCollectionId(workspace);
  if (!SLUG.test(input.shelfSlug)) refuse('ShelfBookSlug must use lowercase letters, digits, and single hyphens.');
  if (!SLUG.test(input.bookSlug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');
  if (input.bookSlug === 'blog') refuse("The shared Book slug 'blog' is reserved and cannot be used by this workflow.");
  const publication = candidatePreflight(workspace, input);
  const deletePlan = shelfDeletePreflight(workspace, input.shelfSlug, input.deleteReason);
  const digestLines = [
    local ? 'action=publish-shelf-book-to-collection' : 'action=publish-shelf-book-to-shared',
    `shelf_slug=${input.shelfSlug}`,
    `shared_slug=${input.bookSlug}`,
    local ? `collection_id=${projectId}` : `project_id=${projectId}`,
    `collection=${input.collection}`,
    `book_version=${input.bookVersion}`,
    `replace_existing=${input.replaceExisting ? 'true' : 'false'}`,
    `publication_plan=${publication.planId}`,
    `delete_plan=${String(deletePlan['plan_id'])}`,
    // Only when something would be left behind, so an approval with nothing to report keeps its id (S67).
    ...(publication.leftBehind.digest ? [`left_behind=${publication.leftBehind.digest}`] : []),
    // The recall record, likewise (S70): bound into the composite id, never into the candidate id, the resume key.
    ...(publication.recall ? [`recall=${publication.recall.digest}`] : []),
  ];
  if (local) {
    return {
      operation: 'Publish a Shelf Book to the Local collection, then delete the Shelf copy',
      shelf_book: `shelf/${input.shelfSlug}`,
      shared_book: `books/${input.bookSlug}`,
      destination: 'collection',
      execution_order: ['publish and verify every page in collection/', 'verify the Local collection Catalog entry', 'permanently delete the Shelf Book'],
      publication_plan: publication.plan,
      local_delete_plan: deletePlan,
      plan_id: 'publish-delete-shelf-book-' + sha256OfText(digestLines.join('\n')),
      confirmation_required: true,
      destructive: true,
      recoverable: false,
      shared_library_write: false,
      scope:
        "Creates or refreshes the verified Book in this Library's own collection/ first -- nothing is written to Basic Memory. Only after " +
        'the Catalog readback succeeds does it permanently delete the Shelf Book. No archive copy of the Shelf Book is created.',
    };
  }
  return {
    operation: 'Publish a Shelf Book to shared, then delete the local copy',
    shelf_book: `shelf/${input.shelfSlug}`,
    shared_book: `books/${input.bookSlug}`,
    execution_order: ['publish and verify every shared page', 'verify the shared Catalog entry', 'permanently delete the local Shelf Book'],
    publication_plan: publication.plan,
    local_delete_plan: deletePlan,
    plan_id: 'publish-delete-shelf-book-' + sha256OfText(digestLines.join('\n')),
    confirmation_required: true,
    destructive: true,
    recoverable: false,
    shared_library_write: false,
    scope:
      'Creates or refreshes the verified shared Book first. Only after the shared Catalog readback succeeds does it permanently ' +
      'delete the local Shelf Book. No local archive copy is created.',
  };
}

/**
 * A RECALLED SHELF BOOK'S DEFAULTS (S70, Q6): `--book-slug` from its recall record, which it may not contradict, and
 * `--title` and `--summary` from its Shelf catalog entry -- which `shelf rename --new-title` keeps current -- falling
 * back to the record's. Without a record the three are what they were: the Shelf slug, and required.
 */
function returnDefaults(workspace: string, shelfSlug: string, parsed: { options: Map<string, string> }, usage: string): { bookSlug: string; title: string; summary: string } {
  const record = isLocalBackend(workspace) ? readRecallRecord(workspace, shelfSlug) : null;
  if (record === null) {
    return {
      bookSlug: parsed.options.get('book-slug') ?? shelfSlug,
      title: required(parsed.options.get('title'), '--title', usage),
      summary: required(parsed.options.get('summary'), '--summary', usage),
    };
  }
  let entry: { title: string; summary: string } | null = null;
  try {
    const book = getShelfBook(workspace, shelfSlug);
    entry = { title: book.title.trim(), summary: book.summary.trim() };
  } catch {
    entry = null;
  }
  return {
    bookSlug: parsed.options.get('book-slug') ?? record.book_slug,
    title: parsed.options.get('title') || entry?.title || record.title,
    summary: parsed.options.get('summary') || entry?.summary || record.summary,
  };
}

async function publishVerb(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, VALUED);
  const usage = 'publish <shelf-slug> --title <t> --summary <s>';
  const shelfSlug = required(parsed.positional[0], 'the Shelf Book slug', usage);
  const defaults = returnDefaults(workspace, shelfSlug, parsed, usage);
  const input: PublishInput = {
    shelfSlug,
    bookSlug: defaults.bookSlug,
    title: defaults.title,
    summary: defaults.summary,
    collection: collectionOption(parsed.options.get('collection')),
    topics: parsed.options.get('topics') ?? 'local-notes',
    bookVersion: parsed.options.get('book-version') ?? '0.1.0',
    replaceExisting: parsed.flags.has('replace-existing'),
    deleteReason: parsed.options.get('reason') ?? DEFAULT_DELETE_REASON,
    lockTimeoutSeconds: lockTimeoutOption(parsed.options.get('lock-timeout')),
  };
  const plan = publishPlan(workspace, input);
  if (parsed.flags.has('preflight')) return { schema: 1, ...plan };
  if (!parsed.flags.has('user-confirmed')) refuse('The Shelf Book was not published or deleted: review the preflight and rerun with --user-confirmed.');
  return publishWorkflow(workspace, input, plan, parsed.options.get('plan-id') ?? '', {
    publicationJournal: parsed.options.get('publication-journal-path') ?? '',
    workflowJournal: parsed.options.get('workflow-journal-path') ?? '',
  });
}

/**
 * Publish-ShelfBookToShared.ps1 past its `-UserConfirmed` gate: the exact `plan_id`, then the publication,
 * verified, and only then the local delete. `library publish` reaches it with its own options, and each
 * publish item of `publish batch` with none -- as the batch calls the script, with no journal paths.
 */
async function publishWorkflow(
  workspace: string,
  input: PublishInput,
  plan: Record<string, PsJsonValue>,
  approvedPlanId: string,
  journals: { publicationJournal: string; workflowJournal: string },
): Promise<Record<string, PsJsonValue>> {
  const shelfSlug = input.shelfSlug;
  if (approvedPlanId !== plan['plan_id']) {
    refuse('The Shelf Book was not published or deleted: rerun the current preflight and pass its exact plan_id as --plan-id.');
  }

  // THE CONFIRMED HALF (S39): the publication, verified, and only then the local delete -- each state
  // journalled first, so an interrupted run says how far it got. Shared publication is never rolled back.
  const publicationPlan = plan['publication_plan'] as Record<string, PsJsonValue>;
  const deletePlan = plan['local_delete_plan'] as Record<string, PsJsonValue>;
  const publicationJournalOption = journals.publicationJournal;
  const publicationJournalPath = isBlank(publicationJournalOption)
    ? path.join(workspace, 'internal', 'publication-journals', `${input.bookSlug}-${String(publicationPlan['source_digest_sha256'])}.json`)
    : publicationJournalOption;
  const workflowJournalOption = journals.workflowJournal;
  const workflowJournalPath = isBlank(workflowJournalOption)
    ? path.join(workspace, 'internal', 'publication-journals', `${shelfSlug}-to-${input.bookSlug}-publish-delete.json`)
    : path.resolve(workflowJournalOption);
  let state = 'publishing';
  const saveWorkflowJournal = (current: string, errorText: string): void => {
    fs.mkdirSync(path.dirname(workflowJournalPath), { recursive: true });
    const record: Record<string, PsJsonValue> = {
      schema: 1,
      state: current,
      timestamp_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
      plan_id: plan['plan_id']!,
      shelf_book_slug: shelfSlug,
      shared_book_slug: input.bookSlug,
      publication_plan_id: publicationPlan['plan_id']!,
      delete_plan_id: deletePlan['plan_id']!,
      publication_journal: publicationJournalPath,
      error: errorText,
    };
    // This one ends with a newline; the publication journal does not (measured S39).
    fs.writeFileSync(workflowJournalPath, psConvertToJson(record) + '\n', 'utf8');
  };
  try {
    saveWorkflowJournal(state, '');
    const candidate = candidatePreflight(workspace, input);
    // THE LIST THE APPROVAL COVERED, rechecked under the Book lock by the local publisher (S67).
    if (isLocalBackend(workspace)) {
      const approved = ((publicationPlan['pages_left_behind'] as unknown as { path: string; sha256: string }[] | undefined) ?? []);
      input.expectedLeftBehindDigest = approved.length ? sha256OfText(approved.map((page) => `${page.path}|${page.sha256}`).join('\n')) : '';
      input.expectedDestinationPresent = fs.existsSync(path.join(workspace, 'collection', 'books', input.bookSlug, 'wiki'));
      input.expectedRecallDigest = String(publicationPlan['recall_digest'] ?? '');
    }
    const publicationResult = await candidateConfirmed(workspace, input, candidate, input.replaceExisting, publicationJournalPath);
    if (publicationResult['publication_complete'] !== true || publicationResult['catalog_entry_verified'] !== true) {
      refuse('the shared publisher did not report both publication completion and Catalog verification');
    }
    state = 'published-awaiting-local-delete';
    saveWorkflowJournal(state, '');
    const removed = removeVerb(
      [shelfSlug, '--reason', input.deleteReason, '--plan-id', String(deletePlan['plan_id']), '--workspace', workspace],
      programRoot(),
      workspace,
    );
    if (removed.refusal !== null) refuse(removed.refusal);
    // In process, as the oracle calls its remover: the live object, with no `schema` of its own.
    const { schema: _schema, ...deleteResult } = removed.value as Record<string, PsJsonValue>;
    if (deleteResult['local_book_deleted'] !== true) refuse('the local deletion helper did not report completion');
    state = 'complete';
    saveWorkflowJournal(state, '');
    return {
      schema: 1,
      operation: String(plan['operation']),
      status: 'complete',
      plan_id: plan['plan_id']!,
      shared_book: `books/${input.bookSlug}`,
      shared_publication_verified: true,
      local_book: `shelf/${shelfSlug}`,
      local_book_deleted: true,
      publication: publicationResult,
      deletion: deleteResult,
      workflow_journal: workflowJournalPath.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
      shared_library_write: true,
    };
  } catch (error) {
    const message = (error as Error).message;
    saveWorkflowJournal(state, message);
    refuse(`The publish-and-delete workflow is incomplete at '${state}'. The shared publication is never rolled back. Journal: ${workflowJournalPath}. ${message}`);
  }
}

// --- library publish refresh --------------------------------------------------------------------------------

/** Publish-BookCopy.ps1 -Destination Shared -FromShelf -SourcePath shelf/<slug> -ReplaceExisting. */
async function refreshVerb(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, VALUED);
  const usage = 'publish refresh <slug> --title <t> --summary <s>';
  const shelfSlug = required(parsed.positional[0], 'the Shelf Book slug', usage);
  const defaults = returnDefaults(workspace, shelfSlug, parsed, usage);
  const input: CandidateInput = {
    shelfSlug,
    bookSlug: defaults.bookSlug,
    title: defaults.title,
    summary: defaults.summary,
    collection: collectionOption(parsed.options.get('collection')),
    lockTimeoutSeconds: lockTimeoutOption(parsed.options.get('lock-timeout')),
  };
  const candidate = candidatePreflight(workspace, input);
  // A LOCAL REFRESH THAT LEAVES PAGES BEHIND HAS AN APPROVAL OF ITS OWN (S67, Eric's Q4): the candidate plan_id stays the
  // resume key, and `refresh_plan_id` covers it and the list. With nothing left behind the two are the same.
  // A RECALLED BOOK'S RETURN IS BOUND TO ITS RECALL RECORD THE SAME WAY (S70): the record's digest joins the id.
  const bound = [...(candidate.leftBehind.digest ? [candidate.leftBehind.digest] : []), ...(candidate.recall ? [`recall=${candidate.recall.digest}`] : [])];
  const refreshPlanId = bound.length ? 'refresh-' + sha256OfText([candidate.planId, ...bound].join('\n')) : candidate.planId;
  if (parsed.flags.has('preflight')) {
    const covers = [
      ...(candidate.leftBehind.digest
        ? [`the ${candidate.leftBehind.pages.length} page(s) listed in pages_left_behind, which the refresh leaves on disk and does not remove`]
        : []),
      ...(candidate.recall ? [`the recall record ${recallRecordLabel(shelfSlug)}, which the refresh checks for drift again under the Book lock`] : []),
    ];
    return {
      schema: 1,
      ...candidate.plan,
      ...(bound.length ? { refresh_plan_id: refreshPlanId, approve_with: `--user-confirmed --plan-id ${refreshPlanId}: this id covers ${covers.join(', and ')}.` } : {}),
    };
  }
  if (!parsed.flags.has('user-confirmed')) refuse('Shared publication is not yet performed: review the manifest and rerun with --user-confirmed.');
  if ((parsed.options.get('plan-id') ?? '') !== refreshPlanId) {
    refuse(
      candidate.leftBehind.digest
        ? 'The refresh is not yet performed: it leaves pages behind, so its approval is refresh_plan_id, not plan_id. Rerun the current preflight and pass its exact refresh_plan_id.'
        : candidate.recall
          ? 'The refresh is not yet performed: it returns a recalled Book, so its approval is refresh_plan_id, not plan_id. Rerun the current preflight and pass its exact refresh_plan_id.'
          : 'Shared publication is not yet performed: rerun the current preflight and pass its exact plan_id as --plan-id.',
    );
  }
  if (isLocalBackend(workspace)) {
    input.expectedLeftBehindDigest = candidate.leftBehind.digest;
    input.expectedDestinationPresent = fs.existsSync(path.join(workspace, 'collection', 'books', input.bookSlug, 'wiki'));
    input.expectedRecallDigest = candidate.recall?.digest ?? '';
  }
  // THE CONFIRMED HALF (S39): the candidate with -ReplaceExisting, its result under Publish-BookCopy's `schema`.
  return { schema: 1, ...(await candidateConfirmed(workspace, input, candidate, true, parsed.options.get('journal-path') ?? '')) };
}

// --- library publish batch ------------------------------------------------------------------------------------

function itemValue(item: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(item, name) ? item[name] : undefined;
}

/** `[string]` of a value ConvertFrom-Json produced: a boolean is `True`/`False`, as PowerShell renders it. */
function psString(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function requiredString(item: Record<string, unknown>, name: string): string {
  const value = itemValue(item, name);
  if (value === undefined || value === null || isBlank(psString(value))) refuse(`Each batch item requires '${name}'.`);
  return psString(value);
}

function optionalString(item: Record<string, unknown>, name: string, fallback = ''): string {
  const value = itemValue(item, name);
  return value === undefined || value === null ? fallback : psString(value);
}

/**
 * Publish-ShelfBookBatchToShared.ps1: Get-BatchPlan, and since S40 the confirmed run -- each bound child plan in
 * order, a failed item journalled and left alone while later items continue.
 */
async function batchVerb(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, VALUED);
  if (!isLocalBackend(workspace)) resolveCollectionId(workspace);
  const planPath = required(parsed.options.get('plan'), '--plan', 'publish batch --plan <path>');
  const full = path.resolve(planPath);
  if (!fs.existsSync(full)) refuse(`Cannot find path '${full}' because it does not exist.`);
  let value: unknown;
  try {
    value = JSON.parse(readStrictUtf8(full));
  } catch (error) {
    refuse(`Batch plan '${planPath}' is not valid JSON. ${(error as Error).message}`);
  }
  const itemsValue = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)['items'] : undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, 'items')) {
    refuse(`Batch plan '${planPath}' requires an items array.`);
  }
  // `@($value.items)`: a scalar is one item, a null none.
  const items = Array.isArray(itemsValue) ? itemsValue : itemsValue === null || itemsValue === undefined ? [] : [itemsValue];
  if (items.length === 0) refuse(`Batch plan '${planPath}' contains no items.`);

  const seenShelf = new Set<string>();
  const seenShared = new Set<string>();
  const actions: Record<string, PsJsonValue>[] = [];
  // What the confirmed run hands each child, read from the item as the preflight read it.
  const children: ({ kind: 'publish'; input: PublishInput } | { kind: 'delete'; shelfSlug: string; reason: string })[] = [];
  for (const raw of items) {
    const item = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const kind = optionalString(item, 'action', 'publish');
    if (kind !== 'publish' && kind !== 'delete') refuse(`Batch item action '${kind}' must be publish or delete.`);
    const shelfSlug = requiredString(item, 'shelf_book_slug');
    if (seenShelf.has(shelfSlug.toLowerCase())) refuse(`Batch plan names Shelf Book '${shelfSlug}' more than once.`);
    seenShelf.add(shelfSlug.toLowerCase());
    if (kind === 'publish') {
      const bookSlug = requiredString(item, 'book_slug');
      if (seenShared.has(bookSlug.toLowerCase())) refuse(`Batch plan names shared slug '${bookSlug}' more than once.`);
      seenShared.add(bookSlug.toLowerCase());
      const input: PublishInput = {
        shelfSlug,
        bookSlug,
        title: requiredString(item, 'book_title'),
        summary: requiredString(item, 'summary'),
        topics: optionalString(item, 'topics', 'local-notes'),
        collection: collectionOption(optionalString(item, 'collection') || undefined),
        bookVersion: optionalString(item, 'book_version') || '0.1.0',
        // The batch passes neither -ReplaceExisting nor -Reason to its child: a batch never replaces a Book.
        replaceExisting: false,
        deleteReason: DEFAULT_DELETE_REASON,
      };
      // A RECALLED SHELF BOOK IS NOT A BATCH ITEM (S70): its return replaces a collection Book, and a batch never
      // replaces, so without this the item would fail only in its confirmed half, naming no route.
      if (isLocalBackend(workspace) && readRecallRecord(workspace, shelfSlug) !== null) {
        refuse(
          `Shelf Book '${shelfSlug}' was recalled from the collection (${recallRecordLabel(shelfSlug)}), and a batch never replaces a Book, ` +
            `so it cannot return it. Return it on its own: deskpost publish refresh ${shelfSlug} keeps the Shelf copy, and deskpost publish ` +
            `${shelfSlug} deletes it after. Nothing was changed.`,
        );
      }
      const child = publishPlan(workspace, input);
      actions.push({ action: 'publish', shelf_book: `shelf/${shelfSlug}`, shared_book: `books/${bookSlug}`, child_plan: child, input: raw as PsJsonValue });
      children.push({ kind: 'publish', input });
    } else {
      const reason = optionalString(item, 'delete_reason', 'Not selected for the shared collection.');
      const child = shelfDeletePreflight(workspace, shelfSlug, reason);
      actions.push({ action: 'delete', shelf_book: `shelf/${shelfSlug}`, shared_book: null, child_plan: child, input: raw as PsJsonValue });
      children.push({ kind: 'delete', shelfSlug, reason });
    }
  }
  const digestLines = ['action=publish-shelf-book-batch-to-shared', `plan=${full}`].concat(
    actions.map(
      (action) =>
        `action=${String(action['action'])}|shelf=${String(action['shelf_book'])}|shared=${action['shared_book'] ?? ''}|child=${String((action['child_plan'] as Record<string, PsJsonValue>)['plan_id'])}`,
    ),
  );
  const planId = 'publish-delete-shelf-book-batch-' + sha256OfText(digestLines.join('\n'));
  const workspacePrefix = workspace.replace(/[\\/]+$/, '') + path.sep;
  const planLabel = full.toLowerCase().startsWith(workspacePrefix.toLowerCase())
    ? full.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : full;
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Publish or delete a batch of Shelf Books',
    batch_plan_path: planLabel,
    items: actions,
    execution_policy:
      'Each item publishes and verifies before its local deletion. Failed items are preserved and later items continue; no shared publication is rolled back.',
    plan_id: planId,
    confirmation_required: true,
    destructive: true,
    recoverable: false,
    shared_library_write: false,
  };
  if (parsed.flags.has('preflight')) return plan;
  if (!parsed.flags.has('user-confirmed')) refuse('The Shelf batch was not changed: review the preflight and rerun with --user-confirmed.');
  if ((parsed.options.get('plan-id') ?? '') !== planId) {
    refuse('The Shelf batch was not changed: rerun the current preflight and pass its exact plan_id as --plan-id.');
  }

  // THE CONFIRMED RUN (S40), each oracle case run by hand in disposable projects first. Every item is
  // journalled `processing` before its child runs and `complete` or `incomplete` after, the whole journal
  // rewritten each time; a failed item keeps its child's own sentence and the batch moves on. Nothing is
  // retried, cleaned up or rolled back here -- each child owns its own recovery.
  const journalPath = path.join(workspace, 'internal', 'publication-journals', `shelf-exit-batch-${planId.substring(planId.length - 16)}.json`);
  const status: Record<string, PsJsonValue>[] = [];
  const saveJournal = (): void => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const record: Record<string, PsJsonValue> = {
      schema: 1,
      timestamp_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
      plan_id: planId,
      items: status.map((entry) => ({ ...entry })),
    };
    // Ends with a newline, and `error` is `null` until an item fails: a property, not a `[string]` parameter.
    fs.writeFileSync(journalPath, psConvertToJson(record) + '\n', 'utf8');
  };
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]!;
    const child = children[index]!;
    const entry: Record<string, PsJsonValue> = {
      shelf_book: action['shelf_book']!,
      shared_book: action['shared_book']!,
      action: action['action']!,
      state: 'processing',
      error: null,
    };
    status.push(entry);
    saveJournal();
    try {
      const approved = String((action['child_plan'] as Record<string, PsJsonValue>)['plan_id']);
      if (child.kind === 'publish') {
        // The child recomputes its own plan, as the script does when it is called again.
        const result = await publishWorkflow(workspace, child.input, publishPlan(workspace, child.input), approved, { publicationJournal: '', workflowJournal: '' });
        if (result['local_book_deleted'] !== true) refuse('the child workflow did not report local deletion');
      } else {
        const removed = removeVerb([child.shelfSlug, '--reason', child.reason, '--plan-id', approved, '--workspace', workspace], programRoot(), workspace);
        if (removed.refusal !== null) refuse(removed.refusal);
        if ((removed.value as Record<string, PsJsonValue>)['local_book_deleted'] !== true) refuse('the child deletion did not report completion');
      }
      entry['state'] = 'complete';
    } catch (error) {
      entry['state'] = 'incomplete';
      entry['error'] = (error as Error).message;
    }
    saveJournal();
  }
  const incomplete = status.filter((entry) => entry['state'] !== 'complete').length;
  return {
    schema: 1,
    operation: String(plan['operation']),
    plan_id: planId,
    status: incomplete > 0 ? 'incomplete' : 'complete',
    items: status,
    journal: journalPath.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    // The oracle's rule, carried: true when ANY item completed, a delete-only one included.
    shared_library_write: status.length > incomplete,
  };
}

/** `library publish [batch|refresh] ...`. */
export async function runPublish(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const first = argv[0] ?? '';
  if (first === 'batch') return batchVerb(argv.slice(1), workspace);
  if (first === 'refresh') return refreshVerb(argv.slice(1), workspace);
  return publishVerb(argv, workspace);
}
