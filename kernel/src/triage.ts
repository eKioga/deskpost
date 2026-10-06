/**
 * `library triage validate` -- a triage plan judged before a byte of it is written.
 *
 * WHAT VALIDATION IS FOR, AND WHY IT IS ITS OWN STEP. A triage batch reaches several destinations
 * in one approved operation, and a batch that fails halfway has already written some of them. So
 * everything knowable up front is decided up front: whether the kind is reachable from the source
 * at all, whether the source exists and hashes, what each action will create and destroy, and
 * whether any two actions collide. A conflict that was knowable here and discovered at write time
 * is a guaranteed partial batch.
 *
 * THE DIGEST IS THE APPROVAL, AND IT IS LENGTH-PREFIXED. A digest built by joining fields with a
 * separator is only as strong as the assumption that no value contains it: with plain joining, one
 * field holding "a,b" and two fields holding "a" and "b" hash identically, and an approval that
 * cannot tell those apart binds less than it claims to. Every value is written as its length, a
 * colon and its text, so no two different plans can render to one string.
 *
 * THE DIGEST RECIPE IS PART OF THE CONTRACT RATHER THAN AN INTERNAL DETAIL, which is why it is
 * reproduced here field for field rather than reinvented. An `action_id` appears in the refusals a
 * reader acts on and in the stored plan a later run re-resolves against; a port that hashed the
 * same plan differently could not re-resolve an approval the reader had already been given.
 *
 * THE DESK GATE FIRES DURING RESOLUTION, NOT AFTER IT. Resolving a capture-Book note reads every
 * note's title and filename to honour `source_match`, so asserting the Desk only through
 * `required_desk_state` -- which the runner checks later -- would let a CLOSED Book answer "that
 * matches 3 notes:" and name them. The Book being open is a precondition of READING it.
 *
 * THE OTHER TWO THIRDS: the inventory (src/triageinventory.ts) and, since S43, the batch runner that executes
 * and resumes a plan (src/triagebatch.ts), which imports the resolution above rather than repeating it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { sha256OfText } from './sha.ts';
import { getShelfBook, readUtf8, listFilesRecursive, type ShelfBook } from './shelfbook.ts';
import { assertSeatMayClose, shelfNotes, whyRefusal, type ShelfNoteRow } from './shelfnote.ts';
import { isLocalBackend } from './basicmemory.ts';
import { deskEntriesForSeat, deskFilePath, resolveSeatName } from './seatdesk.ts';
import { notebookScope } from './notebooklayout.ts';
import { triageInventory } from './triageinventory.ts';
import { triageBatch } from './triagebatch.ts';
import { convertToBookPagePath } from './pagepath.ts';
import { localDate } from './localdate.ts';

const LIBRARY_OUTPUT_SCHEMA = 1;
const ARCHIVE_FOLDER = '_archive';

/**
 * Cheapest and most reversible first, so a late failure never strands local material: a review
 * costs nothing to redo, a shared Book cannot be un-created, and a discard cannot be undone at all.
 */
const EXECUTION_ORDER = ['review', 'holding', 'notebook', 'shelf-book', 'collection-book', 'project', 'book', 'discard'];

/** Which kinds each source can reach. Data rather than scattered guards, so every cell has a message. */
const SOURCE_KINDS: Record<string, string[]> = {
  notebook: ['holding', 'shelf-book', 'collection-book', 'project', 'book'],
  holding: ['notebook', 'shelf-book', 'collection-book', 'project', 'book', 'review', 'discard'],
};

const REFUSAL_REASON: Record<string, string> = {
  'notebook|notebook': 'A notebook action is already in the Notebook. Name the topic folder directly instead.',
  'notebook|review': 'A review marks a capture-Book note reviewed. A Notebook article carries no review field.',
  'notebook|discard':
    "There is no discard from the Notebook. A Reset quarantines notebook/ rather than deleting it (ADR-0016), so a " +
    'discard is not deleting it sooner -- it is strictly worse than the reset, destroying what the reset would have ' +
    "kept recoverable, and it adds a destructive mode to the one helper whose purpose is losing nothing. Nor does " +
    "quarantining instead of deleting open a route: the quarantine is a reset's recovery route and not a " +
    'destination, and its restore cannot return one article to a topic that still exists, so removal from notebook/ ' +
    'has nowhere to go at all (ADR-0024). Leave it, or triage it somewhere durable. ' +
    '(docs/library-triage-design.md:440-448, docs/adr/0024-removal-from-the-notebook-has-no-destination.md)',
  'holding|holding': 'This note is already on the Holding Shelf. Use shelf-book, project, book, or notebook to move it on.',
};

/**
 * The kinds that rewrite the SOURCE note's own frontmatter. Since S73 (plan row 2a) that includes the filing kinds:
 * filing a Holding note closes it, so a filing action is note-mutating when its source is a capture Book, and a
 * Notebook-sourced one names no note and so mutates none.
 */
export const FILING_KINDS = ['shelf-book', 'collection-book'];
const NOTE_MUTATING_KINDS = ['notebook', 'review', ...FILING_KINDS];

/** A filing kind, or a `project` that is a local Hub page (row 2b); a Basic Memory `project` files nothing. */
function isFilingKind(kind: string, destination: string): boolean {
  return FILING_KINDS.includes(kind) || (kind === 'project' && destination === 'local-hub');
}

/** An action that files a Holding note, and so closes it: its metadata names where the note went. */
export function isFilingAction(action: TriageAction): boolean {
  return action.source === 'holding' && typeof action.metadata['filed_to'] === 'string';
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function triageValue(action: Record<string, unknown>, name: string): unknown {
  return name in action ? action[name] : null;
}

function triageString(action: Record<string, unknown>, name: string): string {
  const value = triageValue(action, name);
  return value === null || value === undefined ? '' : String(value);
}

function triageTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim();
  if (text === '') return false;
  return ['true', 'True', 'TRUE', '1'].includes(text);
}

/** Length-prefixed, so no two different values can render to the same text. */
export function convertToTriageDigestText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Map) {
    const parts = [...value.keys()]
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `k${key.length}:${key}=${convertToTriageDigestText(value.get(key))}`);
    return `map${parts.length}{${parts.join(';')}}`;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => convertToTriageDigestText(item));
    return `arr${parts.length}[${parts.join(';')}]`;
  }
  const text = String(value);
  return `str${text.length}:${text}`;
}

export function triageHash(text: string): string {
  return sha256OfText(text);
}

// --- sources ---------------------------------------------------------------------------------------

interface SourceFile {
  relative: string;
  sourcePath: string;
  content: string;
  sha256: string;
}

interface ResolvedSource {
  kind: 'notebook' | 'holding';
  relative: string;
  isContainer: boolean;
  name: string;
  bookSlug: string;
  bookRoot: string;
  note: ShelfNoteRow | null;
  files: SourceFile[];
}

/**
 * The Desk gate for a capture Book. A caller that has already resolved THE seat (S73 row 4: triage resolves it once
 * with --seat, so the Desk gate, the Notebook scope and the seat rule agree) passes it; every other caller passes none
 * and keeps the resolution from `.claude/` it always had.
 */
export function assertShelfBookOpen(workspace: string, slug: string, action: string, resolvedSeat?: string | null): void {
  const desks = path.join(workspace, '.claude');
  let seat: string;
  if (resolvedSeat) {
    seat = resolvedSeat;
  } else {
    const resolved = resolveSeatName({ stateDirectory: desks });
    if (resolved.status !== 'named') refuse(resolved.message);
    seat = resolved.seat!;
  }
  if (!fs.existsSync(deskFilePath(desks, seat, 'books'))) refuse('Virtual Desk configuration is missing .open-books.');
  const openBooks = deskEntriesForSeat(desks, seat, 'books');
  if (openBooks.includes(`shelf/${slug}`)) return;
  if (openBooks.includes(`shelf/${ARCHIVE_FOLDER}/${slug}`)) {
    refuse(
      `Shelf Book '${slug}' is archived and read-only. Restore it with deskpost shelf restore ${slug} before ${action}.`,
    );
  }
  refuse(
    `Shelf Book '${slug}' is closed. Open it with deskpost desk open book ${slug} --location shelf before ${action}.`,
  );
}

export function getCaptureBook(workspace: string, slug: string): ShelfBook {
  const book = getShelfBook(workspace, slug);
  if (!book.isCapture) {
    refuse(
      `Shelf Book '${slug}' is not capture-enabled. Only a Book whose catalog entry carries '- **Kind:** capture' accepts notes.`,
    );
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Capture Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  return book;
}

function resolveNotebookSource(
  workspace: string,
  sourcePath: string,
  allowFolder: boolean,
  includePages: string[],
  notebookRelative = 'notebook',
): ResolvedSource {
  if (!sourcePath.trim()) refuse('Each notebook-sourced action needs a source_path.');
  const notebookRoot = path.resolve(path.join(workspace, ...notebookRelative.split('/'))).replace(/[\\/]+$/, '') + path.sep;
  const full = path.resolve(path.join(workspace, sourcePath));
  if (!full.toLowerCase().startsWith(notebookRoot.toLowerCase())) {
    refuse(`source_path '${sourcePath}' must name a file or folder inside ${notebookRelative}/.`);
  }
  if (!fs.existsSync(full)) refuse(`source_path '${sourcePath}' was not found.`);
  const isContainer = fs.statSync(full).isDirectory();
  if (isContainer && !allowFolder) {
    refuse(`source_path '${sourcePath}' must name a single Markdown article for this action kind.`);
  }
  let files: string[];
  if (isContainer) {
    files = listFilesRecursive(full).filter((file) => path.extname(file) === '.md');
  } else {
    if (path.extname(full) !== '.md') refuse(`source_path '${sourcePath}' must be a Markdown article.`);
    files = [full];
  }
  if (!files.length) refuse(`source_path '${sourcePath}' contains no Markdown articles.`);

  // Applied HERE, before the manifest and the write set are built: a subset selection arriving
  // afterwards would leave the approval describing every file while the child wrote only some.
  if (includePages.length) {
    if (!isContainer) refuse('include_pages is available only when source_path names a Notebook folder.');
    const selected = new Set<string>();
    for (const page of includePages) {
      const normalised = String(page).trim().replace(/^[\\/]+/, '');
      if (!/\.md$/.test(normalised)) {
        refuse(`include_pages entry '${page}' must name a Markdown file relative to source_path.`);
      }
      const candidate = path.resolve(path.join(full, normalised));
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        refuse(`include_pages entry '${page}' is not an exact Markdown file below source_path.`);
      }
      selected.add(candidate);
    }
    files = files.filter((file) => selected.has(file));
    if (files.length !== selected.size) refuse('include_pages named a file outside the resolved source.');
  }

  const relativeRoot = full.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const entries: SourceFile[] = files.map((file) => {
    const relative = isContainer
      ? file.substring(full.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : path.basename(file);
    const content = readUtf8(file);
    return {
      relative,
      sourcePath: isContainer ? `${relativeRoot}/${relative}` : relativeRoot,
      content,
      sha256: triageHash(content),
    };
  });

  return {
    kind: 'notebook',
    relative: relativeRoot,
    isContainer,
    name: isContainer ? path.basename(full) : path.basename(full, '.md'),
    bookSlug: '',
    bookRoot: '',
    note: null,
    files: entries,
  };
}

/**
 * WHO IS SORTING, AND WHETHER THIS ACTION CLOSES THE NOTE (S73 row 4). `closes` is true for every kind that closes,
 * reopens or deletes a note -- `review`, `notebook`, the filing kinds, `discard` -- and the seat rule is stated here,
 * once, for all of them. `seat` is the one resolved seat; `otherSeat` is the action's `other_seat`, the reader's
 * named override.
 */
export interface SeatRuleContext {
  seat: string | null;
  otherSeat: string | null;
  closes: boolean;
}

function resolveNoteSource(workspace: string, slug: string, page: string, matchText: string, rule: SeatRuleContext): ResolvedSource {
  const bookSlug = slug.trim() ? slug : 'holding';
  const book = getCaptureBook(workspace, bookSlug);
  assertShelfBookOpen(workspace, bookSlug, 'triaging its notes', rule.seat);
  const notes = shelfNotes(book);
  if (!notes.length) refuse(`Capture Book '${bookSlug}' holds no notes.`);

  const hasPage = page.trim() !== '';
  const hasMatch = matchText.trim() !== '';
  if (hasPage && hasMatch) refuse('Name the note with either source_page or source_match, not both.');
  if (!hasPage && !hasMatch) refuse('Name the note to triage with source_page (exact) or source_match.');

  let targets: ShelfNoteRow[];
  if (hasPage) {
    const wanted = page.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!/^notes\/[^/]+$/.test(wanted)) {
      refuse('source_page must be the canonical note path, for example notes/2026-08-16-my-finding.');
    }
    targets = notes.filter((note) => note.page === wanted);
    if (!targets.length) refuse(`No note '${wanted}' is in Book '${bookSlug}'.`);
  } else {
    // Ordinal containment, so a match is case-sensitive.
    targets = notes.filter((note) => note.title.includes(matchText) || note.file.includes(matchText));
    if (!targets.length) refuse(`No note title or filename in Book '${bookSlug}' contains '${matchText}'.`);
    if (targets.length !== 1) {
      refuse(
        `'${matchText}' matches ${targets.length} notes: ${targets.map((note) => note.page).join(', ')}. Narrow it, or name one with source_page.`,
      );
    }
  }
  const note = targets[0]!;
  // THE SEAT RULE, per Book from its catalog entry (S73 row 4, Q4). A wrong other_seat is refused whatever the kind.
  if (rule.closes || rule.otherSeat !== null) {
    assertSeatMayClose(note, { slug: book.slug, closedBy: book.closedBy ?? 'any' }, rule.seat, rule.otherSeat, refuse);
  }
  const content = readUtf8(note.fullPath);
  const relative = `${book.bookRoot}/wiki/${note.page}.md`;
  return {
    kind: 'holding',
    relative,
    isContainer: false,
    name: note.file.replace(/\.md$/i, ''),
    bookSlug: book.slug,
    bookRoot: book.bookRoot,
    note,
    files: [{ relative: note.file, sourcePath: relative, content, sha256: triageHash(content) }],
  };
}

// --- the action model ------------------------------------------------------------------------------

export interface TriageAction {
  action_id: string;
  kind: string;
  source: string;
  source_slug: string;
  source_note: string;
  slug: string;
  title: string;
  source_path: string;
  source_is_folder: boolean;
  source_file_count: number;
  source_manifest: string[];
  delivered_sha256: string;
  destination: string;
  operation: string;
  collision_policy: string;
  required_desk_state: string[];
  write_set: string[];
  touch_set: string[];
  delete_set: string[];
  metadata: Record<string, unknown>;
  action_digest: string;
}

function assertKindReachable(kind: string, sourceKind: string): void {
  if (!EXECUTION_ORDER.includes(kind)) {
    refuse(`Unknown triage action kind '${kind}'. Use one of: ${EXECUTION_ORDER.join(', ')}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(SOURCE_KINDS, sourceKind)) {
    // THE ROUTE TO ANOTHER CAPTURE BOOK IS source_slug (S85 row 5, backlog Row C): a seat closing a letter tried
    // `source: "letters"` and was told only the two source kinds.
    refuse(
      `Unknown triage source '${sourceKind}'. Use 'notebook' or 'holding'. A note in another capture Book, such as reports or ` +
        `letters, is source 'holding' with source_slug naming the Book: {"kind":"review","source":"holding","source_slug":"letters","source_page":"notes/<page>"}.`,
    );
  }
  if (SOURCE_KINDS[sourceKind]!.includes(kind)) return;
  const reason =
    REFUSAL_REASON[`${sourceKind}|${kind}`] ??
    `From source '${sourceKind}' the reachable kinds are: ${SOURCE_KINDS[sourceKind]!.join(', ')}.`;
  refuse(`Action kind '${kind}' is not reachable from source '${sourceKind}'. ${reason}`);
}

function convertToNoteSlug(title: string): string {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.substring(0, 60).replace(/^-+|-+$/g, '');
  if (!slug.trim()) refuse('Title must contain at least one letter or digit.');
  return slug;
}

function noteSlugFromBody(body: string, title: string): string {
  const normalised = body.replace(/\s+$/, '');
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(normalised);
  const keepsOwn = heading !== null && heading.index === 0 && /[a-zA-Z0-9]/.test(heading[1]!);
  const pageTitle = keepsOwn ? heading![1]!.trim() : title;
  if (!pageTitle.trim()) refuse('A holding action needs a title, or a source whose first line is an H1.');
  return convertToNoteSlug(pageTitle);
}

/** The leading frontmatter block, separated from the body. */
export function splitNoteFrontmatter(content: string): { hasFrontmatter: boolean; body: string } {
  const normalised = content.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return { hasFrontmatter: false, body: content };
  const closing = normalised.indexOf('\n---\n', 4);
  if (closing < 0) return { hasFrontmatter: false, body: content };
  return { hasFrontmatter: true, body: normalised.substring(closing + 5).replace(/^[\r\n]+|[\r\n]+$/g, '') };
}

function sortedCopy(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, 'en'));
}

export function convertToTriageAction(
  action: Record<string, unknown>,
  workspace: string,
  captureDate: string,
  notebookRelative = 'notebook',
  seat: string | null = null,
): TriageAction {
  const kind = triageString(action, 'kind');
  let sourceKind = triageString(action, 'source');
  if (!sourceKind.trim()) sourceKind = 'notebook';
  assertKindReachable(kind, sourceKind);

  // Rejected, not ignored. A batch that quietly dropped the flag would run a DIFFERENT operation
  // from the one the reader described, which is worse than refusing to run at all.
  if (triageTruthy(triageValue(action, 'replace_existing'))) {
    refuse(
      `Action kind '${kind}' declares replace_existing. Triage is create-and-additive only, apart from discard, which ` +
        'binds what it destroys and needs its own approval: refreshing or overwriting an existing destination is a ' +
        'separate, separately approved operation.',
    );
  }

  let slug = triageString(action, 'slug');
  const title = triageString(action, 'title');
  const sourcePath = triageString(action, 'source_path');
  let sourceSlug = triageString(action, 'source_slug');
  if (sourceKind === 'holding' && !sourceSlug.trim()) sourceSlug = 'holding';
  const includePages = (triageValue(action, 'include_pages') as string[] | null) ?? [];
  if (includePages.length && (sourceKind === 'holding' || ['holding', 'shelf-book'].includes(kind))) {
    refuse(`Action kind '${kind}' from source '${sourceKind}' takes a single article and does not accept include_pages.`);
  }

  // THE SEAT RULE'S INPUTS (row 4): the kinds that close, reopen or delete a note, and the reader's named override.
  const otherSeat = triageString(action, 'other_seat').trim() || null;
  const closes = ['review', 'notebook', 'discard', ...FILING_KINDS].includes(kind) || (kind === 'project' && isLocalBackend(workspace));

  // Resolved once, before any kind branch, so every kind hashes its source the same way.
  const source =
    sourceKind === 'holding'
      ? resolveNoteSource(workspace, sourceSlug, triageString(action, 'source_page'), triageString(action, 'source_match'), { seat, otherSeat, closes })
      : resolveNotebookSource(workspace, sourcePath, ['project', 'book'].includes(kind), includePages, notebookRelative);

  let writeSet: string[] = [];
  let touchSet: string[] = [];
  let deleteSet: string[] = [];
  const metadata = new Map<string, unknown>();
  const requiredDesk: string[] = [];
  // THE GATE RULE: any action reading a named note out of a capture Book needs that Book open;
  // writing INTO one needs nothing. Applied here once, for every holding-sourced kind.
  if (sourceKind === 'holding') requiredDesk.push(`shelf-book-open:${source.bookSlug}`);

  let deliveredSha = 'same-as-source';
  const noteBody = sourceKind === 'holding' ? splitNoteFrontmatter(source.files[0]!.content) : null;
  let destination = '';
  let operation = '';

  switch (kind) {
    case 'holding': {
      if (!slug.trim()) slug = 'holding';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) refuse('A holding action slug must use lowercase letters, digits, and hyphens.');
      const book = getCaptureBook(workspace, slug);
      const noteSlug = noteSlugFromBody(source.files[0]!.content, title);
      writeSet = [`${book.bookRoot}/wiki/notes/${captureDate}-${noteSlug}.md`];
      touchSet = [`${book.bookRoot}/wiki/_index.md`];
      metadata.set('book_root', book.bookRoot);
      metadata.set('note_title', title);
      metadata.set('capture_date', captureDate);
      // AN OPTIONAL `why` (S73 row 3), passed to the capture. Only when given, so a plan without one keeps its id, and
      // none is invented: a Notebook page set aside is as often `reset-imminent` as `no-home`.
      const why = triageString(action, 'why').trim();
      if (why) {
        const malformed = whyRefusal(why);
        if (malformed !== null) refuse(`A holding action's why is recorded as the capture's: ${malformed}`);
        metadata.set('why', why);
      }
      destination = 'shelf';
      operation = 'capture-note';
      break;
    }
    case 'notebook': {
      const topic = triageString(action, 'topic');
      if (!topic.trim()) refuse(`A notebook action needs topic: the ${notebookRelative}/<topic>/ folder this note belongs to.`);
      const topicSlug = topic.trim();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(topicSlug)) refuse('topic must contain only lowercase letters, digits, and hyphens.');
      slug = topicSlug;
      writeSet = [`${notebookRelative}/${topicSlug}/${source.note!.file}`, `${notebookRelative}/${topicSlug}/_index.md`, `${notebookRelative}/_master-index.md`];
      touchSet = sortedCopy([source.relative, `${source.bookRoot}/wiki/_index.md`]);
      metadata.set('topic', topicSlug);
      metadata.set('book_root', source.bookRoot);
      metadata.set('new_review', 'done');
      destination = 'notebook';
      operation = 'copy-note-to-notebook';
      break;
    }
    case 'review': {
      const reopen = triageTruthy(triageValue(action, 'reopen'));
      slug = source.bookSlug;
      touchSet = sortedCopy([source.relative, `${source.bookRoot}/wiki/_index.md`]);
      metadata.set('book_root', source.bookRoot);
      metadata.set('new_review', reopen ? 'pending' : 'done');
      metadata.set('current_review', source.note!.review);
      destination = 'shelf';
      operation = 'set-review';
      break;
    }
    case 'discard': {
      slug = source.bookSlug;
      deleteSet = [source.relative];
      touchSet = [`${source.bookRoot}/wiki/_index.md`];
      metadata.set('book_root', source.bookRoot);
      metadata.set('note_title', source.note!.title);
      destination = 'shelf';
      operation = 'discard-note';
      break;
    }
    case 'shelf-book': {
      if (!slug.trim()) refuse('A shelf-book action needs the Shelf Book slug.');
      const pagePath = triageString(action, 'page_path');
      if (!pagePath.trim()) refuse('A shelf-book action needs page_path.');
      const book = getShelfBook(workspace, slug);
      if (book.isCapture) {
        refuse(`Shelf Book '${slug}' is a capture Book. Use a holding action for it; shelf-book graduates into a curated Book.`);
      }
      const page = convertToBookPagePath(pagePath);
      writeSet = [`${book.bookRoot}/wiki/${page}.md`];
      touchSet = [`${book.bookRoot}/wiki/_index.md`];
      metadata.set('book_root', book.bookRoot);
      metadata.set('page_path', page);
      metadata.set('page_title', title);
      requiredDesk.push(`shelf-book-open:${slug}`);
      destination = 'shelf';
      operation = 'add-page';
      break;
    }
    // A PAGE OF AN EXISTING, OPEN COLLECTION BOOK (S73 row 2c), through `collection add-page`. Named for its
    // destination like `shelf-book`; `book` keeps its meaning, a new shared Book. Local collections only.
    case 'collection-book': {
      if (!isLocalBackend(workspace)) {
        refuse(
          "A collection-book action adds a page to a local Library's own collection, and this workspace is attached to Basic Memory: " +
            'a shared Book changes through its Shelf Book and library publish refresh. Nothing was changed.',
        );
      }
      if (!slug.trim()) refuse('A collection-book action needs the collection Book slug.');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) refuse('A collection-book action slug must use lowercase letters, digits, and hyphens.');
      if (source.isContainer || includePages.length) refuse(`A collection-book action adds one page, and '${source.relative}' is a folder. Name one page per action.`);
      const pagePath = triageString(action, 'page_path');
      if (!pagePath.trim()) refuse('A collection-book action needs page_path.');
      const page = convertToBookPagePath(pagePath);
      writeSet = [`collection/books/${slug}/wiki/${page}.md`];
      touchSet = [`collection/books/${slug}/wiki/_index.md`];
      metadata.set('page_path', page);
      metadata.set('page_title', title);
      requiredDesk.push(`collection-book-open:${slug}`);
      destination = 'collection';
      operation = 'add-collection-page';
      break;
    }
    case 'project': {
      if (!slug.trim()) refuse('A project action needs the Project slug.');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) refuse('A project action slug must use lowercase letters, digits, and single hyphens.');
      // ON A LOCAL COLLECTION IT IS ONE HUB PAGE (S73 row 2b, Q2): the slug and the Hub open at this seat, and the
      // page is `notes/<the source's file stem>`, made by `hub edit --mode new-page`'s writer. Its write set is
      // under `collection/`, so the runner's collision check covers it. Basic Memory keeps the shape below.
      if (isLocalBackend(workspace)) {
        if (source.isContainer || includePages.length) {
          refuse(`A project action on a local collection makes one Hub page, and '${source.relative}' is a folder. Name one page per action.`);
        }
        const page = `notes/${source.name}`;
        writeSet = [`collection/projects/${slug}/${page}.md`];
        metadata.set('page_path', page);
        if (title.trim()) metadata.set('page_title', title);
        requiredDesk.push(`project-open:${slug}`);
        destination = 'local-hub';
        operation = 'new-hub-page';
        break;
      }
      if (!title.trim()) refuse('A project action needs a title.');
      if (!triageString(action, 'purpose').trim()) refuse(`Project action '${slug}' needs purpose.`);
      writeSet = source.files.map((file) =>
        source.isContainer ? `projects/${slug}/notes/${source.name}/${file.relative}` : `projects/${slug}/notes/${file.relative}`,
      );
      metadata.set('purpose', triageString(action, 'purpose'));
      metadata.set('next_actions', (triageValue(action, 'next_actions') as string[] | null) ?? []);
      destination = 'shared-collection';
      operation = 'copy-pages';
      break;
    }
    case 'book': {
      if (!slug.trim()) refuse('A book action needs the Book slug.');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) refuse('A book action slug must use lowercase letters, digits, and single hyphens.');
      if (!title.trim()) refuse('A book action needs a title.');
      if (!triageString(action, 'summary').trim()) refuse(`Book action '${slug}' needs summary.`);
      const bookRoot = `books/${slug}/wiki`;
      writeSet = [`${bookRoot}/_book.md`, `${bookRoot}/_index.md`].concat(
        source.files.map((file) =>
          source.isContainer ? `${bookRoot}/${source.name}/${file.relative}` : `${bookRoot}/${file.relative}`,
        ),
      );
      // The shared Book Catalog is APPENDED to, not created, so it belongs in touch_set: two new
      // Books in one batch is a reasonable request and an overlap refusal there would be a false
      // alarm.
      touchSet = ['books/README.md'];
      metadata.set('summary', triageString(action, 'summary'));
      if (triageString(action, 'collection').trim()) metadata.set('collection', triageString(action, 'collection'));
      destination = 'shared-collection';
      operation = 'create-book';
      break;
    }
    default:
      refuse(`Unknown triage action kind '${kind}'. Use one of: ${EXECUTION_ORDER.join(', ')}.`);
  }

  if (includePages.length) metadata.set('include_pages', sortedCopy(includePages));
  if (sourceKind === 'holding') {
    metadata.set('source_note_title', source.note!.title);
    // THE READER'S OVERRIDE ENTERS THE DIGEST (row 4), so a yes to sorting another seat's note is a yes to it by name.
    if (otherSeat !== null) metadata.set('other_seat', otherSeat);
    // Every destination outside the Holding Shelf itself receives the note's BODY, with the
    // frontmatter separated off. Only `notebook` copies the file verbatim, because there the
    // frontmatter IS the provenance the working copy should keep.
    if (['shelf-book', 'collection-book', 'project', 'book'].includes(kind)) {
      metadata.set('frontmatter', noteBody!.hasFrontmatter ? 'separated' : 'none');
      deliveredSha = triageHash(noteBody!.body);
    }
    // FILING CLOSES THE NOTE (S73 row 2a). The note and its Book's map join the touch set, and the close's
    // `new_review` and `filed_to` (a path already in the write set) enter the digest. The `reviewed:` stamp does
    // not: the runner writes it at execution (row 1).
    if (isFilingKind(kind, destination)) {
      touchSet.push(source.relative, `${source.bookRoot}/wiki/_index.md`);
      metadata.set('new_review', 'done');
      metadata.set('filed_to', writeSet[0]!);
    }
  }

  writeSet = sortedCopy(writeSet);
  touchSet = sortedCopy(touchSet);
  deleteSet = sortedCopy(deleteSet);
  const requiredDeskState = [...new Set(sortedCopy(requiredDesk))];
  const sourceManifest = sortedCopy(source.files.map((file) => `${file.sourcePath}|${file.sha256}`));

  // The digest covers everything an approval is meant to bind: where the material comes from, where
  // it lands, what the action does, the metadata that shapes the result, the exact source bytes,
  // the exact bytes delivered when those differ, the collision policy, the Desk state required, and
  // the exact paths it will create and destroy.
  const digest = triageHash(
    [
      `kind=${kind}`,
      `source=${sourceKind}`,
      `source_slug=${convertToTriageDigestText(sourceSlug)}`,
      `destination=${destination}`,
      `operation=${operation}`,
      `slug=${slug}`,
      `title=${convertToTriageDigestText(title)}`,
      `metadata=${convertToTriageDigestText(metadata)}`,
      'collision_policy=create-only',
      `required_desk_state=${convertToTriageDigestText(requiredDeskState)}`,
      `sources=${sourceManifest.join('\n')}`,
      `delivered=${deliveredSha}`,
      `write_set=${writeSet.join('\n')}`,
      `delete_set=${deleteSet.join('\n')}`,
    ].join('\n'),
  );

  return {
    action_id: `action-${digest.substring(0, 16)}`,
    kind,
    source: sourceKind,
    source_slug: sourceSlug,
    source_note: sourceKind === 'holding' ? source.relative : '',
    slug,
    title,
    source_path: source.relative,
    source_is_folder: source.isContainer,
    source_file_count: source.files.length,
    source_manifest: sourceManifest,
    delivered_sha256: deliveredSha,
    destination,
    operation,
    collision_policy: 'create-only',
    required_desk_state: requiredDeskState,
    write_set: writeSet,
    touch_set: touchSet,
    delete_set: deleteSet,
    metadata: Object.fromEntries(metadata),
    action_digest: digest,
  };
}

/**
 * Per-action preflight is not enough on its own. Two actions creating the same page each pass
 * alone, then the first creates the destination and the second necessarily fails -- a guaranteed
 * partial batch from a conflict that was knowable here.
 */
// A NOTEBOOK ACTION'S TWO INDEXES ARE NOT CREATES, so they are not compared (S44): every Notebook action
// re-renders the master index, and a topic's index is created by the first action into a new topic and updated
// by each later one -- two updates in order, not a guaranteed failure. Compared, they refused every batch with a
// second Notebook action. The oracle's `Test-TriageSharedDerivedPath` is the same rule.
function isSharedDerivedPath(action: TriageAction, item: string): boolean {
  if (action.kind !== 'notebook') return false;
  if (/(^|\/)_master-index\.md$/.test(item)) return true;
  const topic = String(action.metadata['topic'] ?? '');
  return topic !== '' && item.endsWith(`/${topic}/_index.md`);
}

export function assertWriteSetsDisjoint(actions: TriageAction[]): void {
  const seen = new Map<string, string>();
  for (const action of actions) {
    for (const item of action.write_set) {
      if (isSharedDerivedPath(action, item)) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) {
        refuse(
          `Two actions both create '${item}' (${seen.get(key)} and ${action.action_id}). One would necessarily fail, ` +
            'so the batch is refused before any write. Model an ordered dependency or change one destination.',
        );
      }
      seen.set(key, action.action_id);
    }
  }
  const doomed = new Map<string, string>();
  for (const action of actions) {
    for (const item of action.delete_set) {
      const key = item.toLowerCase();
      if (doomed.has(key)) {
        refuse(`Two actions both discard '${item}' (${doomed.get(key)} and ${action.action_id}). The second would find nothing there; remove the duplicate.`);
      }
      if (seen.has(key)) {
        refuse(`Action ${seen.get(key)} creates '${item}' and ${action.action_id} discards it. Run them as separate, separately approved batches.`);
      }
      doomed.set(key, action.action_id);
    }
  }

  // A discard binds the note's bytes as they are NOW. `review` and `notebook` rewrite that note's
  // own frontmatter, so by the time the discard ran -- it runs last -- its source would no longer
  // hash to what the approval covered. Knowable here, so refused here.
  const mutated = new Map<string, string>();
  for (const action of actions) {
    if (!NOTE_MUTATING_KINDS.includes(action.kind) && !isFilingAction(action)) continue;
    if (!action.source_note.trim()) continue;
    mutated.set(action.source_note.toLowerCase(), action.action_id);
  }
  for (const action of actions) {
    if (action.kind !== 'discard') continue;
    const key = action.source_note.toLowerCase();
    if (mutated.has(key)) {
      refuse(
        `Action ${mutated.get(key)} rewrites '${action.source_note}' and ${action.action_id} discards it. The rewrite ` +
          "would invalidate the discard's approved source hash mid-batch, so the two cannot share a batch. Discard it " +
          'separately once the other action has landed.',
      );
    }
  }

  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.action_id)) refuse(`Two actions are byte-identical (${action.action_id}); remove the duplicate.`);
    ids.add(action.action_id);
  }

  // Two Project actions for one Hub have disjoint write sets and still cannot both run: the Hub
  // record itself is created by the first, and the second's approved plan_id then no longer
  // matches. The conflict is real, invisible in the write sets, and knowable here.
  const projectSlugs = new Set<string>();
  for (const action of actions) {
    // A LOCAL HUB PAGE (row 2b) issues no child plan and creates no Hub, so two pages for one Hub are two creates.
    if (action.kind !== 'project' || action.destination === 'local-hub') continue;
    if (projectSlugs.has(action.slug)) {
      refuse(
        `Two Project actions both target '${action.slug}'. The first would create or claim the Hub and invalidate the ` +
          "second's approval; combine them into one action with include_pages instead.",
      );
    }
    projectSlugs.add(action.slug);
  }

  // TWO PAGES FOR ONE COLLECTION BOOK (row 2c): the child's plan_id binds the Book's reader map, and the first
  // page's link changes it, so the second child's id would be stale by the time it ran.
  const collectionSlugs = new Set<string>();
  for (const action of actions) {
    if (action.kind !== 'collection-book') continue;
    if (collectionSlugs.has(action.slug)) {
      refuse(
        `Two collection-book actions both target '${action.slug}'. The first page's reader-map line would invalidate the ` +
          "second's approval; run them as separate batches.",
      );
    }
    collectionSlugs.add(action.slug);
  }
}

export function executionOrder(actions: TriageAction[]): TriageAction[] {
  const ordered: TriageAction[] = [];
  for (const kind of EXECUTION_ORDER) {
    for (const action of actions) if (action.kind === kind) ordered.push(action);
  }
  return ordered;
}

export function resolveTriagePlanActions(
  requested: Record<string, unknown>[],
  workspace: string,
  captureDate: string,
  notebookRelative = 'notebook',
  seat: string | null = null,
): TriageAction[] {
  const resolved = requested.map((action) => convertToTriageAction(action, workspace, captureDate, notebookRelative, seat));
  if (!resolved.length) refuse('A Library Triage plan needs at least one action.');
  assertWriteSetsDisjoint(resolved);
  return executionOrder(resolved);
}

export interface TriageResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/** The default `--capture-date`: the local calendar date, as a capture names its note (S50). */
export function runTriageVerb(argv: string[], workspace: string): TriageResult {
  const action = argv[0] ?? '';
  const parsed = parseArguments(argv.slice(1), ['actions', 'capture-date', 'seat', 'workspace']);
  try {
    if (action === 'validate') {
      const actionsJson = parsed.options.get('actions');
      if (actionsJson === undefined) {
        refuse('library triage validate needs --actions <json>: the plan to judge, as a JSON array of actions.');
      }
      let requested: Record<string, unknown>[];
      try {
        const parsedJson: unknown = JSON.parse(actionsJson);
        requested = Array.isArray(parsedJson) ? (parsedJson as Record<string, unknown>[]) : [parsedJson as Record<string, unknown>];
      } catch {
        refuse('ActionJson must be valid JSON.');
      }
      if (!requested.length) refuse('A Library Triage plan needs at least one action.');
      const captureDate = (parsed.options.get('capture-date') ?? '').trim() || localDate();
      // THE NOTEBOOK A PLAN READS FROM OR WRITES TO IS THE SEAT'S (ADR-0029), resolved only when an
      // action touches it: a plan over the Holding Shelf alone needs no seat's Notebook at all.
      const touchesNotebook = requested.some((item) => {
        if (item === null || typeof item !== 'object') return false;
        const source = String(item['source'] ?? '').trim() || 'notebook';
        return source === 'notebook' || String(item['kind'] ?? '') === 'notebook';
      });
      // ONE SEAT FOR EVERY ACTION (S73 row 4), resolved once with --seat: the Notebook scope, the Desk gate and the
      // seat rule all read it, where the Desk gate used to resolve its own from `.claude/` and ignore --seat.
      const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory: path.join(workspace, '.claude') });
      const seat = seatState.status === 'named' ? seatState.seat! : null;
      let notebookRelative = 'notebook';
      if (touchesNotebook) notebookRelative = notebookScope(workspace, seat, 'read', 'Validating a triage plan').relative;
      const resolved = resolveTriagePlanActions(requested, workspace, captureDate, notebookRelative, seat);
      return {
        refusal: null,
        value: {
          schema: LIBRARY_OUTPUT_SCHEMA,
          operation: 'Validate a Library Triage plan',
          capture_date: captureDate,
          action_count: resolved.length,
          actions: resolved as unknown as PsJsonValue,
          confirmation_required: false,
          shared_library_write: false,
          scope:
            'Every action was resolved against the material on disk and checked for reachability, collisions and ' +
            'Desk requirements. NOTHING was written: this is the judgement, not the run.',
        } as PsJsonValue,
      };
    }
    if (action === 'inventory') {
      return { refusal: null, value: triageInventory(workspace, 'notebook', { pendingOnly: parsed.flags.has('pending') }) as PsJsonValue };
    }
    if (action === 'batch') {
      // THE BATCH RUNNER (S43, src/triagebatch.ts): preflight, confirmed run, and resume from its journal --
      // a resume is the same --actions run again, which is the same batch and so the same journal.
      return triageBatch(argv.slice(1), workspace);
    }
    return { refusal: `library triage has no action '${action}'. It has: batch, inventory, validate.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
