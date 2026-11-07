/**
 * THE SHARED WRITERS: ONE SAFE PATH FOR EVERY CHANGE A LOCAL LIBRARY MAKES TO A SHARED BOOK (kickoffs/s191, kickoffs/s192;
 * PLAN-many-libraries.md r12, Stage 2 items 1, 2, 4, 5, 11, 15 and 16). Over the Library's Basic Memory connection only,
 * in the connection's collection. Four write forms take the one path, each a TARGET, a note path, and a proposed text or
 * `absent` (remove the note):
 *
 * - `shared add-page`, `shared replace-page` and `shared remove-page`: `target: page`, `books/<slug>/wiki/<page>.md`;
 * - `shared catalog-line`: `target: catalog`, this Book's one line in `books/README.md`, written as a whole-file replace;
 * - `shared sources`: `target: sources`, the Book's `books/<slug>/_sources.md` (outside `wiki/`).
 *
 * In this order, and nothing is written when a step refuses:
 *
 * 1. OPTED IN. The connection records `shared_writes: true` (`deskpost basic-memory setup --shared-writes on`); otherwise
 *    one line refuses, before connecting. The two readers below refuse the same way.
 * 2. THE SEAT HOLDS THIS LIBRARY'S CLAIM (item 11, audit B4): a writer acts only for the seat whose live claim it holds,
 *    never on a record's own say-so. The readers (`reconcile`, `changes`) need no seat.
 * 3. A PROVEN FINGERPRINT (item 15). A Library with no Postbox cache has no Library id and cannot record a proof, so it is
 *    refused before connecting. Then one MCP session for the command: its surface must be `bm` and its tool-list
 *    fingerprint the one `tools/bm-proof.mts --record` proved; otherwise one sentence names both and the whole command
 *    that re-proves it (r12 point 7).
 * 4. THE PREVIEW AND ITS plan_id (item 2's gate), from the exact `bm_read` of the note. The plan_id binds the collection,
 *    Book, action, note and both digests; `--user-confirmed` with any other id refuses. A seat this Library granted upkeep
 *    of the Book (item 16, `shared upkeep`) applies add-page, replace-page, catalog-line and sources with `--plan-id`
 *    alone; every other write, and every write by any other seat, takes the reader's yes.
 * 5. THE CHANGE RECORD, FIRST (item 4): the base companion (none for `base: absent`), the body companion (none for
 *    `body: absent`, a removal), then the record note last, each a `createNote` and each read back by listing with its
 *    digest checked; a record that does not read back is named damaged, and the note is not written.
 * 6. THE CONDITIONAL WRITE (item 2): the note read again, which must still be the text the preview read (or still absent);
 *    then `replaceNote` or `deleteNote` with that same read's checksum, or `createNote`; then read back by listing.
 *
 * VERDICTS (item 2, r11): `written` prints the record id and the one restore line item 16 gives for it; `refused`
 * REVISION_CONFLICT or ALREADY_EXISTS names the note and its current checksum, the record staying; any other refusal is
 * the server's own words; `unknown` is "unsettled", with the record id and `deskpost shared reconcile <slug>`, and is never
 * sent again. THE ONE EXCEPTION is the Catalog (item 5): on REVISION_CONFLICT only, it re-reads the Catalog, re-applies
 * only this Book's line, writes a fresh record, and writes once more; a second conflict refuses. No `bm_move` here.
 *
 * THE READERS (r12 point 3), read-only, one listing of `_deskpost/changes/<slug>/`: `shared reconcile <slug>` classifies
 * every record each time, keeping nothing (current, superseded, not current with its text kept, or damaged) and names
 * each target changed outside Deskpost; `shared changes [<slug>] [--since <date>]` lists the records, newest first.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import type { ParsedArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { BasicMemoryRefusal, field, isLocalBackend, listFolderNodes, markerConnection, noteBody, readExactOrNull, readListedRecord, text } from './basicmemory.ts';
import type { BmVerdict, McpSession } from './basicmemory.ts';
import { createNote, deleteNote, replaceNote } from './bmwrite.ts';
import { openServer } from './bmconnection.ts';
import { postboxCache } from './postbox.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import { requireSeat } from './seatdesk.ts';
import { deskWrite, readSeatRegistry, seatOpenBooks } from './desk.ts';
import { archiveCollectionBookLockedAsync, finishCollectionBookArchiveAsync, localArchivePlanId, relinked } from './localarchive.ts';
import { listFilesRecursive, readUtf8 } from './shelfbook.ts';
import { localDate } from './localdate.ts';
import { convertToBookPagePath } from './pagepath.ts';
import { BOOK_SLUG_PATTERN } from './places.ts';
import { resolveContentPath } from './contentpath.ts';
import { strayControlRefusal } from './controlchars.ts';
import { programRoot } from './programroot.ts';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson } from './psjson.ts';
import { ownedLines, placeOwnedEntry, withoutLine } from './localcatalog.ts';
import { renderSourceList, SOURCE_LIST_FILE, sourceListBlock, validateSourceList } from './booksources.ts';

class SharedWriteRefusal extends Error {}

function refuse(message: string): never {
  throw new SharedWriteRefusal(message);
}

export type SharedAction = 'add-page' | 'replace-page' | 'remove-page' | 'catalog-line' | 'sources' | 'new-book' | 'promote' | 'upkeep' | 'reconcile' | 'changes';
export const SHARED_ACTIONS: SharedAction[] = ['add-page', 'replace-page', 'remove-page', 'catalog-line', 'sources', 'new-book', 'promote', 'upkeep', 'reconcile', 'changes'];
/** The commands whose records make a Book (r12 point 8): history, never a restore source. */
type MadeBy = '' | 'new-book' | 'promote';
type Target = 'page' | 'catalog' | 'sources';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIFF_LINES = 40;
const CATALOG = 'books/README.md';
const COLLECTIONS = ['Projects', 'Reference', 'Workflows'];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `YYYYMMDDTHHMMSSZ`: a record id's stamp, with no colon, as `undo`'s id rule needs. */
function utcStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function lineCount(value: string): number {
  const body = value.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return body === '' ? 0 : body.split('\n').length;
}

/** The companion encoding Unit B proved (S5): one header line, then the exact bytes in base64, 76 characters a line. */
function encodePage(page: string): string {
  const bytes = Buffer.from(page, 'utf8');
  const lines = bytes.toString('base64').match(/.{1,76}/g) ?? [];
  return [`deskpost-page-base64 v1 sha256=${sha256(bytes)} bytes=${bytes.length}`, ...lines].join('\n');
}

/** The page a companion holds, or null when it holds no whole encoding whose digest and length match its header. */
export function decodePage(stored: string): string | null {
  const lines = stored.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => /^deskpost-page-base64 v1 sha256=[0-9a-f]{64} bytes=\d+$/.test(line.trim()));
  if (at < 0) return null;
  const head = /sha256=([0-9a-f]{64}) bytes=(\d+)/.exec(lines[at]!)!;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^[A-Za-z0-9+/=]*$/.test(line.trim())) break;
    body.push(line.trim());
  }
  const bytes = Buffer.from(body.join(''), 'base64');
  return sha256(bytes) === head[1] && bytes.length === Number(head[2]) ? bytes.toString('utf8') : null;
}

const bodyOf = (listed: string): string => noteBody({ file_path: '', title: '', content: listed });

/** `bmwrite.ts`'s text equality: the listed text without the server's frontmatter, against the proposed text. */
function sameText(listed: string, proposed: string): boolean {
  return bodyOf(listed).replace(/\r\n/g, '\n').trim() === proposed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n').trim();
}

/** Two texts, or two absences, equal as reconcile compares them: CRLF folded and trimmed. */
function sameValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
}

/** The first `limit` lines of a unified diff (three lines of context) from `before` to `after`. */
function unifiedDiff(before: string, after: string, limit: number): string[] {
  const split = (value: string) => (value === '' ? [] : value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));
  const a = split(before);
  const b = split(after);
  const ops: { tag: ' ' | '-' | '+'; line: string }[] = [];
  if (a.length * b.length <= 4_000_000) {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { ops.push({ tag: ' ', line: a[i]! }); i += 1; j += 1; }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ tag: '-', line: a[i]! }); i += 1; }
      else { ops.push({ tag: '+', line: b[j]! }); j += 1; }
    }
    while (i < a.length) ops.push({ tag: '-', line: a[i++]! });
    while (j < b.length) ops.push({ tag: '+', line: b[j++]! });
  } else {
    for (const line of a) ops.push({ tag: '-', line });
    for (const line of b) ops.push({ tag: '+', line });
  }
  const near = ops.map((_, index) => ops.slice(Math.max(0, index - 3), index + 4).some((op) => op.tag !== ' '));
  const out = ['--- current', '+++ proposed'];
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < ops.length && out.length < limit; ) {
    if (!near[index]) {
      if (ops[index]!.tag !== '+') oldLine += 1;
      if (ops[index]!.tag !== '-') newLine += 1;
      index += 1;
      continue;
    }
    let end = index;
    while (end < ops.length && near[end]) end += 1;
    const hunk = ops.slice(index, end);
    const oldCount = hunk.filter((op) => op.tag !== '+').length;
    const newCount = hunk.filter((op) => op.tag !== '-').length;
    out.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of hunk) out.push(`${op.tag}${op.line}`);
    oldLine += oldCount;
    newLine += newCount;
    index = end;
  }
  return out.slice(0, limit);
}

// --- the restore line (item 16) --------------------------------------------------------------------------------------

/** The page a page path names, as the writers take it: `books/<slug>/wiki/a/b.md` is `a/b`. */
function pageName(pagePath: string): string {
  return pagePath.replace(/^books\/[^/]+\/wiki\//, '').replace(/\.md$/, '');
}

/**
 * THE ONE RESTORE LINE FOR A RECORD (item 16, r11 round 1), chosen from its target and its base state, and said word for
 * word by the writer that made the record, by `shared reconcile` and `shared changes`, and by `undo`'s receipt refusal.
 * A removal's record has a base, so its line puts the note back. A BOOK-MAKING RECORD (`made_by: new-book` or `promote`,
 * r12 point 8) has no restore: its command is empty, and its words name the recovery instead.
 */
export function restoreLine(target: string, slug: string, notePath: string, baseAbsent: boolean, recordId: string, madeBy = ''): { command: string; says: string } {
  if (madeBy === 'new-book' || madeBy === 'promote') {
    return { command: '', says: `a Book-making record has no restore: finish a half-made Book by rerunning deskpost shared ${madeBy} ${slug}; a Book made by mistake is removed on the server by Eric` };
  }
  const from = `--from-change ${recordId}`;
  if (target === 'catalog') {
    return { command: `deskpost shared catalog-line ${slug} ${from} --base`, says: baseAbsent ? 'removes the Catalog line it added' : "puts the Book's Catalog line back" };
  }
  if (target === 'sources') {
    return baseAbsent
      ? { command: `deskpost shared sources ${slug} ${from} --remove`, says: "removes the source list it created, and needs the reader's yes" }
      : { command: `deskpost shared sources ${slug} ${from} --base`, says: "puts the Book's source list back" };
  }
  return baseAbsent
    ? { command: `deskpost shared remove-page ${slug} ${pageName(notePath)} ${from}`, says: "removes the page it added, and needs the reader's yes" }
    : { command: `deskpost shared replace-page ${slug} ${pageName(notePath)} ${from} --base`, says: 'puts the page back' };
}

// --- the connection, the seat and the session ------------------------------------------------------------------------

interface Context {
  session: McpSession;
  project: string;
  slug: string;
}

interface Opened {
  context: Context;
  collection: string;
  seat: string;
  seatId: string;
  libraryId: string;
  libraryCard: string;
}

type Connection = NonNullable<ReturnType<typeof markerConnection>>;

/** Step 1, before connecting: a local Library, opted in, with a collection UUID. */
function optedIn(action: SharedAction, workspace: string): Connection {
  if (!isLocalBackend(workspace)) refuse(`library shared ${action} is for a local Library. Nothing was written.`);
  const connection = markerConnection(workspace);
  if (connection === null || !connection.shared_writes) {
    refuse(`This Library does not write shared Books: turn it on with deskpost basic-memory setup --shared-writes on. Nothing was written.`);
  }
  if (!UUID.test(connection.collection_id)) refuse('The Basic Memory connection records no collection UUID, so no shared Book can be addressed. Run deskpost basic-memory setup again. Nothing was written.');
  return connection;
}

/** Steps 2 and 3: the seat's claim (a writer only), the Postbox cache, then one session on a proven fingerprint. */
async function connect(connection: Connection, parsed: ParsedArguments, workspace: string, slug: string, writer: boolean): Promise<Opened> {
  // (a) THE SEAT THAT HOLDS THIS LIBRARY'S CLAIM.
  let seat = '';
  let seatId = '';
  if (writer) {
    const stateDirectory = path.join(workspace, '.claude');
    seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
    assertSeatClaimHeld({ workspace, stateDirectory, seat, token: parsed.options.get('claim-token') });
    seatId = readSeatRegistry(stateDirectory).find((entry) => entry.seat === seat)?.seatId ?? '';
    // NO WRITE WITHOUT A seat_id (library-auditor's second reads through a408d73): a record names its writer by it, and
    // upkeep grants bind by it.
    if (!seatId) refuse(`The seat ${seat} has no seat_id in this Library's registry, so no change record could name it: see deskpost seat cards. Nothing was written.`);
  }

  // (b) A POSTBOX CACHE, THEN ONE SESSION ON A PROVEN FINGERPRINT.
  const state = postboxCache(workspace).state;
  const libraryId = String(state?.['library_id'] ?? '');
  if (state === null || !UUID.test(libraryId)) {
    refuse(`This Library has no Postbox yet, so it has no Library id to sign a change record with and cannot record a proof: deskpost postbox setup --url ${connection.url} --preflight. Nothing was written.`);
  }
  const libraryCard = String(state['library_card'] ?? '');
  const proven = typeof state['server_tools_proven_fingerprint'] === 'string' ? state['server_tools_proven_fingerprint'] : '';
  let session: McpSession;
  try {
    session = await openServer(connection.url);
  } catch (error) {
    refuse(`Nothing was written. The Basic Memory server did not answer: ${(error as Error).message}`);
  }
  if (session.surface !== 'bm' || session.toolsFingerprint === null || session.toolsFingerprint !== proven) {
    const out = `${workspace}/internal/bm-proof/${utcStamp(new Date())}`;
    refuse(
      `Shared writes are paused: this server's tool-list fingerprint is ${session.toolsFingerprint ?? 'unreadable'}` +
        `${session.surface === 'bm' ? '' : ` (its surface is ${session.surface}, not Basic Memory 1.0)`}, the proven one is ${proven || 'none yet'}, ` +
        `so nothing was written; re-prove it with: node ${programRoot()}/tools/bm-proof.mts --url ${connection.url} --out ${out} --record --workspace ${workspace}`,
    );
  }
  return { context: { session, project: connection.collection_id, slug }, collection: connection.collection_name || connection.collection_id, seat, seatId, libraryId, libraryCard };
}

// --- listing, the create guard, and the record pieces ----------------------------------------------------------------

/** Every file directly in `folder`, by its exact `file_path`, with its permalink. */
async function listedFiles(context: Context, folder: string): Promise<Map<string, string>> {
  const nodes = await listFolderNodes(context.session, context.project, folder, `The folder ${folder}`,
    `The folder ${folder} holds more than 5,000 notes, and this release lists at most 50 pages of 100.`);
  const files = new Map<string, string>();
  for (const node of nodes) if (field(node, 'type') === 'file') files.set(text(field(node, 'file_path')), text(field(node, 'permalink')));
  return files;
}

/** The file at exactly `notePath` as its folder's listing reports it, read by that listing, or null when it is not listed. */
async function listedRead(context: Context, notePath: string): Promise<{ text: string; checksum: string } | null> {
  const files = await listedFiles(context, notePath.slice(0, notePath.lastIndexOf('/')));
  const permalink = files.get(notePath);
  if (permalink === undefined) return null;
  return readListedRecord(context.session, { id: context.project, name: context.project }, notePath, permalink);
}

function unsettled(context: Context, what: string, reason: string, recordId: string): never {
  refuse(
    `The write of ${what} is unsettled: ${reason}. Its change record is ${recordId}; run deskpost shared reconcile ${context.slug} ` +
      'to see whether it landed. It was not sent again.',
  );
}

/**
 * THE CREATE GUARD (kickoffs/s191 row 3; PLAN-many-libraries.md r12 point 4, from s189's live S6, where the NAS's listing
 * had not yet caught up with a create). After every `createNote` this module makes answered `written`, its folder is
 * listed; a file not listed is listed again after two seconds; still absent, the same text is created once more (an
 * `ALREADY_EXISTS` answer then means "go and list") and the folder listed again; still absent is unsettled.
 *
 * THE OTHER HALF, FOR LATER WRITERS: a writer that moves a note waits about two seconds after the move before it creates a
 * note at the moved note's old path (`tools/bm-proof.mts`'s S6 pauses the same way). This module moves nothing.
 */
async function confirmCreated(context: Context, notePath: string, body: string, recordId: string): Promise<{ text: string; checksum: string }> {
  let listed = await listedRead(context, notePath);
  if (listed === null) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    listed = await listedRead(context, notePath);
  }
  if (listed === null) {
    const again = await createNote(context.session, context.project, notePath, body);
    if (again.form === 'unknown') unsettled(context, notePath, `it was not listed after two listings, and creating it once more answered unknown: ${again.reason}`, recordId);
    if (again.form === 'refused' && again.code !== 'ALREADY_EXISTS') {
      unsettled(context, notePath, `it was not listed after two listings, and creating it once more was refused ${again.code}: ${again.message}`, recordId);
    }
    listed = await listedRead(context, notePath);
  }
  if (listed === null) unsettled(context, notePath, 'it was answered written, and its folder still does not list it after a wait and one more create', recordId);
  return listed;
}

/** One record piece: created, confirmed by listing, and checked; anything else names the record damaged. */
async function writeRecordPiece(context: Context, notePath: string, body: string, recordId: string, check: (listed: string) => boolean): Promise<void> {
  const verdict = await createNote(context.session, context.project, notePath, body);
  if (verdict.form !== 'written') {
    const said = verdict.form === 'refused' ? `refused ${verdict.code}: ${verdict.message}` : `unknown: ${verdict.reason}`;
    refuse(`The change record ${recordId} is damaged: ${notePath} was ${said}. Nothing more was written.`);
  }
  const listed = await confirmCreated(context, notePath, body, recordId);
  if (!check(listed.text)) refuse(`The change record ${recordId} is damaged: ${notePath} does not read back as written. Nothing more was written.`);
}

// --- the record reader -----------------------------------------------------------------------------------------------

interface ChangeRecord {
  id: string;
  target: Target;
  page: string;
  baseAbsent: boolean;
  baseSha: string;
  bodyAbsent: boolean;
  bodySha: string;
  seat: string;
  libraryCard: string;
  libraryId: string;
  time: string;
  madeBy: string;
}

/** A record's restore, as the readers print it: the command (null for a Book-making record) and its words. */
function restoreFields(record: ChangeRecord, slug: string): { restore: string | null; restore_says: string } {
  const line = restoreLine(record.target, slug, record.page, record.baseAbsent, record.id, record.madeBy);
  return { restore: line.command || null, restore_says: line.says };
}

interface LoadedRecord {
  id: string;
  record: ChangeRecord | null;
  base: string | null;
  body: string | null;
  /** Why the record cannot be used, or null when every piece it names reads back and matches. */
  damaged: string | null;
}

/** The note path a target may name in this Book's folder, or null for any other. */
function targetPath(target: string, slug: string, page: string): boolean {
  if (target === 'catalog') return page === CATALOG;
  if (target === 'sources') return page === `books/${slug}/${SOURCE_LIST_FILE}`;
  return target === 'page' && page.startsWith(`books/${slug}/wiki/`) && page.endsWith('.md');
}

/** A record note's own lines as a change record of this Book, or null when they are not one. */
function parseRecord(id: string, slug: string, body: string): ChangeRecord | null {
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const pair = /^([a-z_0-9]+): (.*)$/.exec(line.trim());
    if (pair && !fields.has(pair[1]!)) fields.set(pair[1]!, pair[2]!.trim());
  }
  const target = fields.get('target') ?? '';
  const page = fields.get('page') ?? '';
  if (!targetPath(target, slug, page)) return null;
  const baseAbsent = fields.get('base') === 'absent';
  const bodyAbsent = fields.get('body') === 'absent';
  const baseSha = fields.get('base_sha256') ?? '';
  const bodySha = fields.get('body_sha256') ?? '';
  if ((!baseAbsent && !SHA256.test(baseSha)) || (!bodyAbsent && !SHA256.test(bodySha)) || (baseAbsent && bodyAbsent)) return null;
  return {
    id, target: target as Target, page, baseAbsent, baseSha, bodyAbsent, bodySha,
    seat: fields.get('seat') ?? '', libraryCard: fields.get('library_card') ?? '', libraryId: fields.get('library_id') ?? '', time: fields.get('time') ?? '',
    madeBy: fields.get('made_by') ?? '',
  };
}

/**
 * ONE RECORD, READ EXACTLY (item 4): the record note at `_deskpost/changes/<slug>/<id>.md`, read by its folder's listing,
 * then (with `companions`) each companion it names, decoded, and its digest checked against the record's. A missing
 * companion or a digest that does not match makes it DAMAGED, named, never "never landed". Null when no such record is listed.
 */
async function loadRecord(context: Context, files: Map<string, string>, id: string, companions: boolean): Promise<LoadedRecord | null> {
  const folder = `_deskpost/changes/${context.slug}`;
  const read = async (notePath: string): Promise<string | null> => {
    const permalink = files.get(notePath);
    if (permalink === undefined) return null;
    const found = await readListedRecord(context.session, { id: context.project, name: context.project }, notePath, permalink);
    return found === null ? null : bodyOf(found.text);
  };
  if (!files.has(`${folder}/${id}.md`)) return null;
  // A LISTED RECORD WHOSE NOTE DOES NOT READ is a damaged row, never a crash (library-auditor's S1).
  const note = await read(`${folder}/${id}.md`);
  if (note === null) return { id, record: null, base: null, body: null, damaged: 'listed, and its note did not read' };
  const record = parseRecord(id, context.slug, note);
  if (record === null) return { id, record: null, base: null, body: null, damaged: 'its record note does not read as a change record of this Book' };
  const loaded: LoadedRecord = { id, record, base: null, body: null, damaged: null };
  if (!companions) return loaded;
  for (const side of ['base', 'body'] as const) {
    if (side === 'base' ? record.baseAbsent : record.bodyAbsent) continue;
    const stored = await read(`${folder}/${id}.${side}.md`);
    if (stored === null) return { ...loaded, damaged: `its ${side} companion ${id}.${side}.md is missing` };
    const decoded = decodePage(stored);
    if (decoded === null || sha256(decoded) !== (side === 'base' ? record.baseSha : record.bodySha)) {
      return { ...loaded, damaged: `its ${side} companion ${id}.${side}.md does not match the record's digest` };
    }
    loaded[side] = decoded;
  }
  return loaded;
}

/** `--from-change <id>`: the record, whole and undamaged, from this Book's folder; anything else refuses. */
async function fromChange(context: Context, id: string): Promise<LoadedRecord & { record: ChangeRecord }> {
  if (!RECORD_ID.test(id)) refuse(`'${id}' is not a change record id. Nothing was written.`);
  const files = await listedFiles(context, `_deskpost/changes/${context.slug}`);
  const loaded = await loadRecord(context, files, id, true);
  if (loaded === null) refuse(`No change record ${id} is listed under _deskpost/changes/${context.slug}/. Nothing was written.`);
  if (loaded.damaged !== null || loaded.record === null) refuse(`The change record ${id} is damaged: ${loaded.damaged}. Nothing was written.`);
  return loaded as LoadedRecord & { record: ChangeRecord };
}

// --- the Catalog line (item 5) ---------------------------------------------------------------------------------------

const catalogTarget = (slug: string) => `books/${slug}/wiki/_book`;

/** This Book's owned Catalog line(s) in `text`, joined, or null when it has none: what reconcile compares for the Catalog. */
function ownedLineOf(text: string | null, slug: string): string | null {
  if (text === null) return null;
  const lines = ownedLines(text, [catalogTarget(slug)]).map((owned) => owned.line.trim());
  return lines.length === 0 ? null : lines.join('\n');
}

function oneOwnedLine(text: string, slug: string): { index: number; line: string; heading: string | null } | null {
  const owned = ownedLines(text, [catalogTarget(slug)]);
  if (owned.length > 1) refuse(`The Book Catalog carries ${owned.length} entry lines linking '${catalogTarget(slug)}'; it will not guess which one is this Book's. Nothing was written.`);
  return owned[0] ?? null;
}

// --- one change, through the safe path --------------------------------------------------------------------------------

interface Change {
  target: Target;
  notePath: string;
  /** The note's whole text as the preview read it, or null when it is absent. */
  current: string | null;
  /** What the record keeps as its base: `current`, except a Catalog record whose Book had no line (null, `base: absent`). */
  recordBase: string | null;
  /** The text to write, or null to remove the note. */
  proposed: string | null;
}

type Outcome = { form: 'written'; recordId: string; recordPath: string; checksum: string } | { form: 'conflict'; recordId: string; code: string; now: string };

/** Steps 5 and 6 for one change, after its plan id was accepted. A REVISION_CONFLICT or ALREADY_EXISTS comes back as a conflict. */
async function writeChange(opened: Opened, workspace: string, change: Change, madeBy: MadeBy = ''): Promise<Outcome> {
  const { context } = opened;
  const { notePath, current, recordBase, proposed } = change;

  // (d) THE CHANGE RECORD: the companions, then the record note last, each read back by listing.
  const at = new Date();
  const recordId = `${utcStamp(at)}-${opened.libraryId}-${randomBytes(4).toString('hex')}`;
  const folder = `_deskpost/changes/${context.slug}`;
  const recordPath = `${folder}/${recordId}.md`;
  const holds = (expected: string) => (listed: string) => decodePage(bodyOf(listed)) === expected;
  if (recordBase !== null) await writeRecordPiece(context, `${folder}/${recordId}.base.md`, encodePage(recordBase), recordId, holds(recordBase));
  if (proposed !== null) await writeRecordPiece(context, `${folder}/${recordId}.body.md`, encodePage(proposed), recordId, holds(proposed));
  const baseLine = recordBase === null ? 'base: absent' : `base_sha256: ${sha256(recordBase)}`;
  const bodyLine = proposed === null ? 'body: absent' : `body_sha256: ${sha256(proposed)}`;
  const recordLines = [
    `# Change record ${recordId}`,
    '',
    `target: ${change.target}`,
    `page: ${notePath}`,
    baseLine,
    bodyLine,
    ...(recordBase === null ? [] : [`base_companion: ${recordId}.base.md`]),
    ...(proposed === null ? [] : [`body_companion: ${recordId}.body.md`]),
    `library_id: ${opened.libraryId}`,
    `library_card: ${opened.libraryCard}`,
    `seat: ${opened.seat}`,
    `seat_id: ${opened.seatId}`,
    `time: ${at.toISOString()}`,
    ...(madeBy ? [`made_by: ${madeBy}`] : []),
  ];
  // THE WHOLE RECORD READS BACK AS WRITTEN (library-auditor's M1): a record that kept its digests but lost or changed any
  // other line would be refused later as damaged, or tie its restore to the wrong page.
  const recordText = recordLines.join('\n') + '\n';
  await writeRecordPiece(context, recordPath, recordText, recordId, (listed) => sameText(listed, recordText));

  // THE LOCAL RECEIPT (item 11; kickoffs/s191 row 4), once the record has read back and before the note is written, so
  // `deskpost undo <record-id>` can name this write's restore line. A refused or unsettled write keeps it.
  const receipts = path.join(workspace, 'internal', 'shared-receipts');
  fs.mkdirSync(receipts, { recursive: true });
  writeAtomicText(path.join(receipts, `${recordId}.json`), psConvertToJson({
    collection_id: context.project, slug: context.slug, page: notePath, record_id: recordId, seat: opened.seat, seat_id: opened.seatId, target: change.target, base_absent: recordBase === null,
    ...(madeBy ? { made_by: madeBy } : {}),
  }) + '\n');

  // (e) THE NOTE, READ AGAIN, STILL THE TEXT THE PREVIEW READ; THEN THE CONDITIONAL WRITE AND ITS READBACK.
  const again = await readExactOrNull(context.session, context.project, notePath, { stopped: 'the note was not written' });
  if ((again === null ? null : noteBody(again)) !== current) {
    refuse(`${notePath} changed after its change record ${recordId} was written, so it was not written; the record stays. Preview it again.`);
  }
  let verdict: BmVerdict;
  if (again !== null && !again.checksum) refuse(`${notePath} was read without the checksum a conditional write needs, so it was not written; the record ${recordId} stays.`);
  if (proposed === null) verdict = await deleteNote(context.session, context.project, notePath, again!.checksum);
  else if (again === null) verdict = await createNote(context.session, context.project, notePath, proposed);
  else verdict = await replaceNote(context.session, context.project, notePath, proposed, again.checksum!);
  if (verdict.form === 'refused') {
    if (verdict.code === 'REVISION_CONFLICT' || verdict.code === 'ALREADY_EXISTS') {
      const now = verdict.currentChecksum ?? (await readExactOrNull(context.session, context.project, notePath, { stopped: 'nothing more was read' }))?.checksum ?? 'unreadable';
      return { form: 'conflict', recordId, code: verdict.code, now };
    }
    refuse(`The server refused the write of ${notePath}: ${verdict.code}: ${verdict.message}. The change record ${recordId} stays.`);
  }
  if (verdict.form === 'unknown') unsettled(context, notePath, verdict.reason, recordId);
  if (proposed === null) {
    if ((await listedRead(context, notePath)) !== null) unsettled(context, notePath, 'its removal was answered written, and its folder still lists it', recordId);
    return { form: 'written', recordId, recordPath, checksum: '' };
  }
  const landed = again === null ? await confirmCreated(context, notePath, proposed, recordId) : await listedRead(context, notePath);
  if (landed === null) unsettled(context, notePath, 'it was answered written, and its folder does not list it', recordId);
  if (!sameText(landed.text, proposed)) unsettled(context, notePath, 'it was answered written, and it does not read back as written', recordId);
  return { form: 'written', recordId, recordPath, checksum: landed.checksum };
}

function conflictRefusal(notePath: string, outcome: { recordId: string; code: string; now: string }): never {
  refuse(`${notePath} was written by someone else since it was read (${outcome.code}), so nothing was overwritten; its current checksum is ${outcome.now}. The change record ${outcome.recordId} stays. Preview it again.`);
}

// --- the actions ------------------------------------------------------------------------------------------------------

interface Plan {
  change: Change;
  operation: string;
  scope: string;
  /** The Catalog's retry (item 5): this Book's line re-applied to the Catalog as it now reads. */
  reapply?: (text: string) => string;
}

function readContentFile(workspace: string, contentPath: string): string {
  const full = resolveContentPath(workspace, contentPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--content-path was not found: ${contentPath}`);
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)).replace(/^﻿/, '');
  } catch (error) {
    refuse(`--content-path '${contentPath}' is not valid UTF-8: ${(error as Error).message}`);
  }
  const stray = strayControlRefusal(value, `--content-path '${contentPath}'`);
  if (stray !== null) refuse(stray);
  if (value.trim() === '') refuse(`--content-path '${contentPath}' is empty. Nothing was written.`);
  return value;
}

/** `--from-change <id>` with exactly one of the sides the action allows, or null when the action is given its text another way. */
function fromChangeSide(parsed: ParsedArguments, action: string, sides: string[], usage: string): { id: string; side: string } | null {
  const id = (parsed.options.get('from-change') ?? '').trim();
  const chosen = sides.filter((side) => parsed.flags.has(side));
  if (!id) {
    if (chosen.length) refuse(`library shared ${action} --${chosen[0]} needs --from-change <record-id>: ${usage}.`);
    return null;
  }
  if (sides.length && chosen.length !== 1) refuse(`library shared ${action} --from-change takes exactly one of ${sides.map((side) => `--${side}`).join(' or ')}: ${usage}.`);
  return { id, side: chosen[0] ?? '' };
}

/** The text of the note now, and its body, or null when it is absent. */
async function readNow(context: Context, notePath: string): Promise<string | null> {
  const found = await readExactOrNull(context.session, context.project, notePath, { stopped: 'nothing was written' });
  return found === null ? null : noteBody(found);
}

function wrongRecord(id: string, why: string): never {
  refuse(`The change record ${id} ${why}, so it cannot restore this. Nothing was written.`);
}

/**
 * Every write action's plan: the target, its note, the current text, and the proposed text or `absent`. `early` is what
 * could be checked before connecting (the slug, the page, the content file); the rest needs the server.
 */
async function planWrite(action: SharedAction, parsed: ParsedArguments, opened: Opened, early: { page: string; contentText: string | null }): Promise<Plan> {
  const { context } = opened;
  const slug = context.slug;
  const usage = USAGE[action];
  if (action === 'add-page' || action === 'replace-page' || action === 'remove-page') {
    const notePath = `books/${slug}/wiki/${early.page}.md`;
    const current = await readNow(context, notePath);
    const from = fromChangeSide(parsed, action, action === 'replace-page' ? ['base', 'body'] : [], usage);
    let proposed: string | null;
    if (action === 'remove-page') {
      if (current === null) refuse(`${notePath} does not exist, so there is nothing to remove. Nothing was written.`);
      if (from !== null) {
        const loaded = await fromChange(context, from.id);
        if (loaded.record.target !== 'page' || loaded.record.page !== notePath) wrongRecord(from.id, `is a change to ${loaded.record.page}, not to ${notePath}`);
        if (!loaded.record.baseAbsent) wrongRecord(from.id, 'did not create the page (its base is not absent); put its base back with replace-page --base instead');
      }
      proposed = null;
    } else if (from !== null) {
      if (action === 'add-page') refuse(`library shared add-page takes --content-path only: ${usage}.`);
      const loaded = await fromChange(context, from.id);
      if (loaded.record.target !== 'page' || loaded.record.page !== notePath) wrongRecord(from.id, `is a change to ${loaded.record.page}, not to ${notePath}`);
      proposed = from.side === 'base' ? loaded.base : loaded.body;
      if (proposed === null) {
        wrongRecord(from.id, from.side === 'base'
          ? `created the page (its base is absent); remove it with deskpost shared remove-page ${slug} ${early.page} --from-change ${from.id}`
          : 'removed the page (its body is absent); remove it again with remove-page');
      }
    } else {
      if (early.contentText === null) refuse(`library shared ${action} needs --content-path <file>: ${usage}.`);
      proposed = early.contentText;
      if (action === 'replace-page' && current === null) {
        refuse(`${notePath} does not exist, so there is nothing to replace. Add it with deskpost shared add-page ${slug} ${early.page} --content-path <file> --preflight. Nothing was written.`);
      }
      if (action === 'add-page' && current !== null) {
        refuse(`${notePath} already exists. Replace it with deskpost shared replace-page ${slug} ${early.page} --content-path <file> --preflight. Nothing was written.`);
      }
    }
    const operation = proposed === null ? 'Remove a page of a shared Book' : current === null ? 'Add a page to a shared Book' : 'Replace a page of a shared Book';
    const how = proposed === null
      ? 'removes the page only while it is still the text shown here'
      : current === null ? 'creates the page only if it is still absent' : 'replaces the page only while it is still the text shown here';
    return {
      change: { target: 'page', notePath, current, recordBase: current, proposed },
      operation,
      scope: `Records the change first under _deskpost/changes/${slug}/ (the page's current text, the new text, and who wrote it), then ${how}, and confirms it by listing. Nothing else is changed.`,
    };
  }

  if (action === 'sources') {
    const notePath = `books/${slug}/${SOURCE_LIST_FILE}`;
    const current = await readNow(context, notePath);
    const from = fromChangeSide(parsed, action, ['base', 'remove'], usage);
    let proposed: string | null;
    if (from !== null) {
      const loaded = await fromChange(context, from.id);
      if (loaded.record.target !== 'sources') wrongRecord(from.id, `is a change to ${loaded.record.page}, not to this Book's sources`);
      if (from.side === 'remove') {
        if (!loaded.record.baseAbsent) wrongRecord(from.id, 'did not create the source list (its base is not absent); put its base back with --base instead');
        if (current === null) refuse(`${notePath} does not exist, so there is no source list to remove. Nothing was written.`);
        proposed = null;
      } else {
        if (loaded.base === null) wrongRecord(from.id, `created the source list (its base is absent); remove it with deskpost shared sources ${slug} --from-change ${from.id} --remove`);
        proposed = loaded.base;
      }
    } else {
      if (early.contentText === null) refuse(`library shared sources needs --content-path <file> or --from-change <record-id>: ${usage}.`);
      proposed = early.contentText;
    }
    return {
      change: { target: 'sources', notePath, current, recordBase: current, proposed },
      operation: proposed === null ? "Remove a shared Book's sources" : "Set a shared Book's sources",
      scope: proposed === null
        ? `Records the change first under _deskpost/changes/${slug}/, then removes the Book's sources (${notePath}) only while they are still the text shown here. Nothing else is changed.`
        : `Records the change first under _deskpost/changes/${slug}/, then ${current === null ? 'creates' : 'replaces'} the Book's sources (${notePath}) only while ${current === null ? 'they are still absent' : 'they are still the text shown here'}. Nothing else is changed.`,
    };
  }

  // catalog-line
  const catalog = await readNow(context, CATALOG);
  if (catalog === null) refuse(`The Book Catalog ${CATALOG} is missing; it will not be created implicitly. Nothing was written.`);
  const from = fromChangeSide(parsed, action, ['base'], usage);
  let reapply: (text: string) => string;
  if (from !== null) {
    if (parsed.options.has('title') || parsed.options.has('summary') || parsed.options.has('collection')) refuse(`library shared catalog-line --from-change takes no --title, --summary or --collection: ${usage}.`);
    const loaded = await fromChange(context, from.id);
    if (loaded.record.target !== 'catalog') wrongRecord(from.id, `is a change to ${loaded.record.page}, not to the Catalog`);
    const before = loaded.base === null ? null : oneOwnedLine(loaded.base, slug);
    reapply = (text) => {
      const owned = oneOwnedLine(text, slug);
      if (before === null) return owned === null ? text : withoutLine(text, owned.index);
      return placeOwnedEntry(text, catalogTarget(slug), before.line, before.heading ?? '## Open a Book', null, true).text;
    };
  } else {
    const title = (parsed.options.get('title') ?? '').trim();
    const summary = (parsed.options.get('summary') ?? '').trim();
    if (!title || !summary) refuse(`library shared catalog-line needs --title <t> and --summary <s>, or --from-change <record-id> --base: ${usage}.`);
    if (/[\x00-\x1f\x7f]/.test(title + summary)) refuse('Catalog title and summary cannot hold control characters or DEL. Nothing was written.');
    const word = parsed.options.get('collection');
    const collection = word === undefined ? null : COLLECTIONS.find((name) => name.toLowerCase() === word.toLowerCase());
    if (collection === undefined) refuse(`library shared catalog-line --collection is Projects, Reference or Workflows; got '${word}'.`);
    const entry = `- [[${catalogTarget(slug)}|${title}]] — ${summary}`;
    reapply = (text) => {
      const owned = oneOwnedLine(text, slug);
      // With no collection named, a listed line stays under the heading it has; a new one goes where a publication puts it.
      const heading = collection !== null ? `## ${collection}` : owned?.heading || '## Open a Book';
      return placeOwnedEntry(text, catalogTarget(slug), entry, heading, collection !== null ? '## Open a Book' : null, collection !== null).text;
    };
  }
  return {
    change: catalogChange(catalog, reapply(catalog), slug),
    operation: "Set a shared Book's Catalog line",
    scope: `Records the change first under _deskpost/changes/${slug}/, then writes ${CATALOG} only while it is still the text shown here, changing only this Book's line. On a conflict it re-reads the Catalog and tries once more with a fresh record.`,
    reapply,
  };
}

function catalogChange(current: string, proposed: string, slug: string): Change {
  return { target: 'catalog', notePath: CATALOG, current, recordBase: ownedLineOf(current, slug) === null ? null : current, proposed };
}

/** The writers a seat granted upkeep runs without a yes (item 16): never a removal, a Book-making command or the grant itself. */
function upkeepable(action: SharedAction, parsed: ParsedArguments): boolean {
  return action === 'add-page' || action === 'replace-page' || action === 'catalog-line' || (action === 'sources' && !parsed.flags.has('remove'));
}

/** The checks that need no server: the slug, the page and the content file. */
function earlyChecks(action: SharedAction, parsed: ParsedArguments, workspace: string): { slug: string; page: string; contentText: string | null } {
  const usage = USAGE[action];
  const slug = (parsed.positional[0] ?? '').trim();
  const pageWord = parsed.positional[1] ?? '';
  const paged = action === 'add-page' || action === 'replace-page' || action === 'remove-page';
  if (!slug || (paged && !pageWord)) refuse(`library shared ${action} needs ${paged ? 'a Book slug and a page path' : 'a Book slug'}: ${usage}.`);
  if (!BOOK_SLUG_PATTERN.test(slug)) refuse(`'${slug}' is not a Book slug: lowercase letters, digits and hyphens. Nothing was written.`);
  const page = paged ? convertToBookPagePath(pageWord) : '';
  // AN APPLY WITH --plan-id ALONE (item 16): only for the writers a granted seat runs without a yes; runWrite checks the grant.
  const planOnly = upkeepable(action, parsed) && !parsed.flags.has('preflight') && !parsed.flags.has('user-confirmed') && (parsed.options.get('plan-id') ?? '') !== '';
  if (!planOnly && parsed.flags.has('preflight') === parsed.flags.has('user-confirmed')) refuse(`library shared ${action} takes --preflight, or --user-confirmed --plan-id <id> after it: ${usage}.`);
  const contentPath = (parsed.options.get('content-path') ?? '').trim();
  if (contentPath && parsed.options.has('from-change')) refuse(`library shared ${action} takes --content-path or --from-change, not both: ${usage}.`);
  if (!contentPath) return { slug, page, contentText: null };
  let contentText = readContentFile(workspace, contentPath);
  if (action === 'sources') {
    // CHECKED WHOLE BEFORE CONNECTING (item 2, r11): the list's shape. Whether each fed page exists is the Book's to say.
    const block = sourceListBlock(contentText);
    if ('problem' in block) refuse(`--content-path '${contentPath}' is not a source list: ${block.problem}. Nothing was written.`);
    const checked = validateSourceList(block.value, (pageWordOf) => {
      try {
        return convertToBookPagePath(pageWordOf);
      } catch {
        return null;
      }
    });
    if (checked.list === null) refuse(`--content-path '${contentPath}' is not a valid source list: ${checked.problems.join('; ')}. Nothing was written.`);
    contentText = renderSourceList(checked.list);
  }
  return { slug, page, contentText };
}

const USAGE: Record<SharedAction, string> = {
  'add-page': 'library shared add-page <slug> <page> --content-path <file> (--preflight | [--user-confirmed] --plan-id <id>)',
  'replace-page': 'library shared replace-page <slug> <page> (--content-path <file> | --from-change <record-id> (--base | --body)) (--preflight | [--user-confirmed] --plan-id <id>)',
  'remove-page': 'library shared remove-page <slug> <page> [--from-change <record-id>] (--preflight | --user-confirmed --plan-id <id>)',
  'catalog-line': 'library shared catalog-line <slug> (--title <t> --summary <s> [--collection <c>] | --from-change <record-id> --base) (--preflight | [--user-confirmed] --plan-id <id>)',
  sources: 'library shared sources <slug> (--content-path <file> | --from-change <record-id> (--base | --remove)) (--preflight | [--user-confirmed] --plan-id <id>)',
  'new-book': 'library shared new-book <slug> --title <t> --summary <s> [--collection <c>] (--preflight | --user-confirmed --plan-id <id>) [--seat <s>]',
  promote: 'library shared promote <slug> (--preflight | --user-confirmed --plan-id <id>) [--seat <s>]',
  upkeep: 'library shared upkeep <slug> (--seats <seat>[,...] | --any-seat) (--preflight | --user-confirmed --plan-id <id>) [--seat <s>]; library shared upkeep <slug> --off (--preflight | --plan-id <id>) [--seat <s>]',
  reconcile: 'library shared reconcile <slug>',
  changes: 'library shared changes [<slug>] [--since <date>]',
};

type Planned =
  | { form: 'written'; written: Change; outcome: Extract<Outcome, { form: 'written' }>; retriedAfter: string | null }
  | { form: 'unchanged'; recordId: string };

/** One planned change written, with the Catalog's one retry (item 5): the server's own REVISION_CONFLICT only. */
async function writePlanned(opened: Opened, workspace: string, plan: Plan, madeBy: MadeBy = ''): Promise<Planned> {
  const { context } = opened;
  let written = plan.change;
  let outcome = await writeChange(opened, workspace, written, madeBy);
  let retriedAfter: string | null = null;
  if (outcome.form === 'conflict') {
    // An `unknown` never comes here.
    if (plan.reapply === undefined || outcome.code !== 'REVISION_CONFLICT') conflictRefusal(plan.change.notePath, outcome);
    retriedAfter = outcome.recordId;
    const reread = await readNow(context, CATALOG);
    if (reread === null) refuse(`The Book Catalog ${CATALOG} went missing after a conflict; the change record ${outcome.recordId} stays. Nothing more was written.`);
    const proposed = plan.reapply(reread);
    if (proposed === reread) return { form: 'unchanged', recordId: outcome.recordId };
    written = catalogChange(reread, proposed, context.slug);
    outcome = await writeChange(opened, workspace, written, madeBy);
    if (outcome.form === 'conflict') {
      refuse(`${CATALOG} was written by someone else twice while this Book's line was written (${outcome.code}), so nothing was overwritten; its current checksum is ${outcome.now}. ` +
        `The change records ${retriedAfter} and ${outcome.recordId} stay. Preview it again.`);
    }
  }
  return { form: 'written', written, outcome, retriedAfter };
}

async function runWrite(action: SharedAction, parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const early = earlyChecks(action, parsed, workspace);
  const opened = await connect(connection, parsed, workspace, early.slug, true);
  const { context } = opened;
  const slug = early.slug;
  // (c) THE BOOK, THE EXACT READ, THE PREVIEW AND ITS plan_id. A Catalog line restored from its record needs no Book.
  if (!(action === 'catalog-line' && parsed.options.has('from-change'))
    && (await readExactOrNull(context.session, context.project, `books/${slug}/wiki/_book.md`, { stopped: 'nothing was written' })) === null) {
    refuse(`The shared collection '${opened.collection}' has no Book at books/${slug}. Nothing was written.`);
  }
  const plan = await planWrite(action, parsed, opened, early);
  const { change } = plan;
  const baseDigest = change.current === null ? 'absent' : sha256(change.current);
  const bodyDigest = change.proposed === null ? 'absent' : sha256(change.proposed);
  const planId = 'shared-write-' + sha256([context.project, slug, action, change.notePath, baseDigest, bodyDigest].join('|'));
  // UPKEEP (item 16, second and third bullets): a seat this Library granted writes without a yes. The grant is read fresh
  // for every preview and every apply without --user-confirmed, since the plan_id does not bind it; an apply with the
  // reader's yes needs no grant and reads none.
  const confirmed = parsed.flags.has('user-confirmed');
  const catalogRemoval = action === 'catalog-line' && ownedLineOf(change.proposed ?? '', slug) === null;
  const grant = upkeepable(action, parsed) && !catalogRemoval && !confirmed ? await upkeepGrant(opened) : null;
  const preview: Record<string, PsJsonValue> = {
    schema: 1,
    operation: plan.operation,
    collection: opened.collection,
    book: `shared/${slug}`,
    target: change.target,
    page: change.notePath,
    current_sha256: baseDigest,
    proposed_sha256: bodyDigest,
    current_lines: change.current === null ? 0 : lineCount(change.current),
    proposed_lines: change.proposed === null ? 0 : lineCount(change.proposed),
    diff: unifiedDiff(change.current ?? '', change.proposed ?? '', DIFF_LINES),
    plan_id: planId,
    confirmation_required: grant === null,
    ...(catalogRemoval ? { confirmation_reason: "Removing this Book's Catalog line needs the reader's yes, even with an upkeep grant." } : {}),
    ...(grant === null ? {} : { maintained_by: grant.names }),
    shared_library_write: true,
    scope: plan.scope,
  };
  if (baseDigest === bodyDigest) {
    return { ...preview, status: 'unchanged', next: `${change.notePath} already holds this text; nothing was written.` };
  }
  if (parsed.flags.has('preflight')) return preview;
  if ((parsed.options.get('plan-id') ?? '') !== planId) {
    refuse("Nothing was written: the plan_id given is not this preview's. The note may have changed since the preview; rerun --preflight and pass its exact plan_id.");
  }
  if (!confirmed && grant === null) {
    refuse(`Nothing was written: no upkeep grant from this Library names seat ${opened.seat} for shared/${slug}, so this write needs the reader's yes: rerun it with --user-confirmed --plan-id ${planId}.`);
  }

  const done = await writePlanned(opened, workspace, plan);
  if (done.form === 'unchanged') {
    return { schema: 1, operation: plan.operation, book: `shared/${slug}`, target: change.target, page: CATALOG, status: 'unchanged', record_id: done.recordId,
      next: `${CATALOG} changed while it was written, and it now holds this Book's line as asked; nothing more was written. The first change record ${done.recordId} stays.` };
  }
  const { written, outcome, retriedAfter } = done;
  const restore = restoreLine(written.target, slug, written.notePath, written.recordBase === null, outcome.recordId);
  return {
    schema: 1,
    operation: plan.operation,
    book: `shared/${slug}`,
    target: change.target,
    page: change.notePath,
    verdict: 'written',
    record_id: outcome.recordId,
    record: outcome.recordPath,
    ...(retriedAfter === null ? {} : { retried_after: retriedAfter }),
    checksum: outcome.checksum,
    restore: restore.command,
    shared_library_write: true,
    next: `Written. Its change record is ${outcome.recordId}; ${restore.command} ${restore.says}.`,
  };
}

// --- making a Book (items 8 and 9; r12 points 6 and 8) ----------------------------------------------------------------

/** `_book.md` and the empty reader map `_index.md` in a publication's form (`publish.ts`'s `rootBody` and `indexBody`). */
function bookPages(slug: string, title: string, summary: string): { book: string; index: string } {
  const bookRoot = `books/${slug}/wiki`;
  return {
    book: `# ${title}\n\n## Purpose\n\n${summary}\n\n## Reader map\n\n- [[${bookRoot}/_index|Open the reader map]]\n`,
    index: `# ${title} - Reader Map\n\n- [[${bookRoot}/_book|Book metadata and limits]]\n`,
  };
}

/** One page a Book-making command creates (`base: absent`), or skips when this command's own record made it already. */
interface BookStep {
  notePath: string;
  target: Target;
  current: string | null;
  proposed: string;
  skip: boolean;
}

/** A page's text without its own frontmatter, as the server's readback compares it (`sameText`). */
const withoutFrontmatter = (value: string) => value.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 160);

/**
 * THE RESUME RULE (item 8, r12 point 6), for every Book-making command. The slug is refused when `archive/<slug>` is
 * listed, and when its `_book.md` exists and is not this command's from this Library (below). Each page is
 * skipped when it already holds this run's text and this command's record made it. A page this command made that now
 * holds other text refuses, named, for `new-book` (a rerun never changes what an earlier run made); for `promote`
 * (`recopy`) it is copied again over that text, since the local Book is the live one until the archive half finishes.
 */
async function bookSteps(opened: Opened, madeBy: MadeBy, pages: { notePath: string; proposed: string; target?: Target }[], recopy = false): Promise<BookStep[]> {
  const { context } = opened;
  const slug = context.slug;
  if ((await listedFiles(context, `archive/${slug}/wiki`)).has(`archive/${slug}/wiki/_book.md`)) {
    refuse(`The slug ${slug} was archived (archive/${slug} is listed), and 1.6.0 re-creates no archived slug. Nothing was written.`);
  }
  const files = await listedFiles(context, `_deskpost/changes/${slug}`);
  // This command's records from this Library, by page, oldest first (record ids begin with their time).
  const tried = new Map<string, ChangeRecord[]>();
  for (const id of recordIds(files, slug)) {
    const record = (await loadRecord(context, files, id, false))?.record;
    if (record && record.madeBy === madeBy && record.libraryId === opened.libraryId) tried.set(record.page, [...(tried.get(record.page) ?? []), record]);
  }
  // A PAGE IS THIS COMMAND'S ONLY WHEN IT HOLDS WHAT THIS LIBRARY WROTE (library-auditor's M1 on s193). A record is written
  // before its target and kept when the create is refused or stops, so a record proves an attempt, not a page: the page
  // is owned when this command's `base: absent` record for it exists and that record, or a later one of this command for
  // the same page, read whole with its companions, holds the page's current text. Anything else is another writer's page.
  const owns = async (notePath: string, current: string): Promise<boolean> => {
    const ours = tried.get(notePath) ?? [];
    if (!ours.some((record) => record.baseAbsent)) return false;
    for (const record of [...ours].reverse()) {
      const whole = await loadRecord(context, files, record.id, true);
      if (whole !== null && whole.damaged === null && whole.body !== null && sameValue(current, withoutFrontmatter(whole.body))) return true;
    }
    return false;
  };
  const bookPath = `books/${slug}/wiki/_book.md`;
  const steps: BookStep[] = [];
  for (const page of pages) {
    const current = await readNow(context, page.notePath);
    if (current !== null && !(await owns(page.notePath, current))) {
      const last = tried.get(page.notePath)?.at(-1);
      const attempt = last === undefined ? '' : ` This Library's change record ${last.id} tried to make it, and the page does not hold what that record wrote.`;
      refuse(page.notePath === bookPath
        ? `The slug ${slug} is taken: ${bookPath} exists, and no deskpost shared ${madeBy} from this Library made it.${attempt} Nothing was written.`
        : `${page.notePath} exists, and no deskpost shared ${madeBy} from this Library made it.${attempt} Nothing was written.`);
    }
    const same = current !== null && sameValue(current, withoutFrontmatter(page.proposed));
    if (current !== null && !same && !recopy) {
      refuse(`${page.notePath} was made earlier with other text, and a rerun never changes it: it reads "${oneLine(current)}", this run would write "${oneLine(page.proposed)}". ` +
        `Rerun with the words the first run used. Nothing was written.`);
    }
    steps.push({ notePath: page.notePath, target: page.target ?? 'page', current, proposed: page.proposed, skip: same });
  }
  return steps;
}

/** The Catalog step: skipped when this Book's line already reads as asked; a different line of this Book refuses, named. */
function catalogStep(plan: Plan, slug: string): { plan: Plan; skip: boolean } {
  const { current, proposed } = plan.change;
  if (current === proposed) return { plan, skip: true };
  const had = ownedLineOf(current, slug);
  if (had !== null) {
    refuse(`The Book Catalog already lists shared/${slug} as "${oneLine(had)}", and this run would write "${oneLine(ownedLineOf(proposed, slug) ?? '')}"; a rerun never changes it. ` +
      'Rerun with the words the first run used. Nothing was written.');
  }
  return { plan, skip: false };
}

const digestOf = (value: string | null) => (value === null ? 'absent' : sha256(value));

/** The preview a Book-making command shows, its plan_id binding every step's note, both digests and whether it is skipped. */
function bookPreview(opened: Opened, operation: string, steps: BookStep[], catalog: { plan: Plan; skip: boolean }, extra: string[], scope: string): Record<string, PsJsonValue> {
  const { context } = opened;
  const binding = [
    ...steps.map((step) => `${step.notePath}|${digestOf(step.current)}|${digestOf(step.proposed)}|${step.skip}`),
    `${CATALOG}|${digestOf(catalog.plan.change.current)}|${digestOf(catalog.plan.change.proposed)}|${catalog.skip}`,
    ...extra,
  ];
  const rows: PsJsonValue[] = [
    ...steps.map((step, index) => ({ step: index + 1, page: step.notePath, does: step.skip ? 'already made by this command: skipped' : 'create', proposed_sha256: digestOf(step.proposed) })),
    { step: steps.length + 1, page: CATALOG, does: catalog.skip ? "this Book's line already reads as asked: skipped" : "add this Book's line, last", proposed_sha256: digestOf(catalog.plan.change.proposed) },
  ];
  return {
    schema: 1,
    operation,
    collection: opened.collection,
    book: `shared/${context.slug}`,
    steps: rows,
    plan_id: `shared-${operation === 'Make a shared Book' ? 'new-book' : 'promote'}-` + sha256([context.project, context.slug, ...binding].join('\n')),
    confirmation_required: true,
    shared_library_write: true,
    scope,
  };
}

/** The steps not skipped, written in order through the safe path, each recorded first with `made_by`; the Catalog last. */
async function writeBookSteps(opened: Opened, workspace: string, madeBy: MadeBy, steps: BookStep[], catalog: { plan: Plan; skip: boolean }): Promise<PsJsonValue[]> {
  const records: PsJsonValue[] = [];
  for (const step of steps) {
    if (step.skip) continue;
    const outcome = await writeChange(opened, workspace, { target: step.target, notePath: step.notePath, current: step.current, recordBase: step.current, proposed: step.proposed }, madeBy);
    if (outcome.form === 'conflict') conflictRefusal(step.notePath, outcome);
    records.push({ page: step.notePath, record_id: outcome.recordId });
  }
  if (!catalog.skip) {
    const done = await writePlanned(opened, workspace, catalog.plan, madeBy);
    records.push({ page: CATALOG, record_id: done.form === 'written' ? done.outcome.recordId : done.recordId });
  }
  return records;
}

/** `shared new-book <slug> --title <t> --summary <s> [--collection <c>]` (item 8): `_book.md`, `_index.md`, then the Catalog line. */
async function runNewBook(parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const early = earlyChecks('new-book', parsed, workspace);
  const title = (parsed.options.get('title') ?? '').trim();
  const summary = (parsed.options.get('summary') ?? '').trim();
  if (!title || !summary) refuse(`library shared new-book needs --title <t> and --summary <s>: ${USAGE['new-book']}.`);
  if (/[\x00-\x1f\x7f]/.test(title + summary)) refuse('A Book title and summary cannot hold control characters or DEL. Nothing was written.');
  const opened = await connect(connection, parsed, workspace, early.slug, true);
  const slug = early.slug;
  const texts = bookPages(slug, title, summary);
  const steps = await bookSteps(opened, 'new-book', [
    { notePath: `books/${slug}/wiki/_book.md`, proposed: texts.book },
    { notePath: `books/${slug}/wiki/_index.md`, proposed: texts.index },
  ]);
  const catalog = catalogStep(await planWrite('catalog-line', parsed, opened, early), slug);
  const preview = bookPreview(opened, 'Make a shared Book', steps, catalog, [title, summary, parsed.options.get('collection') ?? ''],
    `Makes shared/${slug} in three steps, each recorded first under _deskpost/changes/${slug}/ (made_by: new-book): _book.md, then the reader map _index.md, ` +
      "then this Book's Catalog line last, so an unfinished Book is never offered. A rerun skips each step already made and finishes the rest. Nothing else is changed.");
  if (steps.every((step) => step.skip) && catalog.skip) return { ...preview, status: 'unchanged', next: `shared/${slug} is already made as asked; nothing was written.` };
  if (parsed.flags.has('preflight')) return preview;
  if ((parsed.options.get('plan-id') ?? '') !== preview['plan_id']) {
    refuse("Nothing was written: the plan_id given is not this preview's. The Book or the Catalog may have changed since the preview; rerun --preflight and pass its exact plan_id.");
  }
  const records = await writeBookSteps(opened, workspace, 'new-book', steps, catalog);
  return {
    schema: 1,
    operation: 'Make a shared Book',
    book: `shared/${slug}`,
    verdict: 'written',
    records,
    shared_library_write: true,
    next: `Made shared/${slug}; open it with deskpost basic-memory open ${slug}. Its records are history, not restore sources: ${restoreLine('page', slug, '', true, '', 'new-book').says}.`,
  };
}

// --- promoting a collection Book (item 9) -----------------------------------------------------------------------------

/** Every file under a local Book's folder, by its path below it, with its bytes' sha256: what the archive half re-checks. */
function localDigests(activeFull: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const file of listFilesRecursive(activeFull)) digests.set(path.relative(activeFull, file).split(path.sep).join('/'), sha256(fs.readFileSync(file)));
  return digests;
}

/** A page's text as reconcile compares it (`sameValue`: CRLF folded, trimmed), by its digest. */
const sharedForm = (value: string) => sha256(value.replace(/\r\n/g, '\n').trim());

/**
 * THE SHARED COPY, READ BACK UNDER THE ARCHIVE LOCKS (kickoffs/s194 row 2; library-auditor's M2 on s193): every page
 * promote copied or skipped, `expected` by note path with its `sharedForm`, listed folder by folder (`listedFiles` lists
 * one level) and read by that listing. A page missing or holding other text refuses, named; nothing is moved.
 *
 * ON THE FINISHING PATH (kickoffs/s195 row 4; deskpost-lead's review of s194, finding 1) the local Book is already in
 * `collection/archive/<slug>` and every rerun finishes from there, so neither "the local Book stays active" nor "a rerun
 * copies it again" is true: `routes` gives, for each page, the one command that puts promote's text back, and the
 * refusal names the archived location, each page and its route.
 */
async function sharedCopyComplete(context: Context, slug: string, expected: Map<string, string>, routes: Map<string, string> | null = null): Promise<void> {
  const folders = new Map<string, string[]>();
  for (const notePath of expected.keys()) {
    const folder = notePath.slice(0, notePath.lastIndexOf('/'));
    folders.set(folder, [...(folders.get(folder) ?? []), notePath]);
  }
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [folder, notePaths] of folders) {
    const files = await listedFiles(context, folder);
    for (const notePath of notePaths) {
      const permalink = files.get(notePath);
      const found = permalink === undefined ? null : await readListedRecord(context.session, { id: context.project, name: context.project }, notePath, permalink);
      if (found === null) missing.push(notePath);
      else if (sharedForm(bodyOf(found.text)) !== expected.get(notePath)) changed.push(notePath);
    }
  }
  if (routes !== null && missing.length + changed.length > 0) {
    const pages = [...missing.sort(), ...changed.sort()];
    const said = [...missing.map((notePath) => `${notePath} is missing`), ...changed.map((notePath) => `${notePath} holds another writer's text`)];
    refuse(`The shared copy is not as promote copied it, so the archive was not finished: ${said.join('; ')}. The local Book is already archived at collection/archive/${slug}, ` +
      `so promote cannot copy ${pages.length === 1 ? 'it' : 'them'} again. Put ${pages.length === 1 ? 'it' : 'each'} back first: ` +
      `${pages.map((notePath) => routes.get(notePath) ?? `ask Eric to put ${notePath} back on the server as promote copied it`).join('; ')}; then run deskpost shared promote ${slug} again. Nothing was moved.`);
  }
  if (missing.length) {
    refuse(`The shared copy is incomplete, so the local Book was not archived: ${missing.sort().join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from shared/${slug}. ` +
      `The local Book stays active; run deskpost shared promote ${slug} again to copy ${missing.length === 1 ? 'it' : 'them'} again and archive it. Nothing was moved.`);
  }
  if (changed.length) {
    refuse(`The shared copy changed after it was copied, so the local Book was not archived: ${changed.sort().join(', ')} now ${changed.length === 1 ? 'holds' : 'hold'} another writer's text. ` +
      `The local Book stays active, and a rerun refuses ${changed.length === 1 ? 'that page' : 'those pages'} as not made by this command. Nothing was moved.`);
  }
}

const intentFile = (workspace: string, slug: string) => path.join(workspace, 'internal', 'shared-promote', `${slug}.json`);

function writePromoteIntent(workspace: string, slug: string, intent: Record<string, PsJsonValue>): void {
  fs.mkdirSync(path.dirname(intentFile(workspace, slug)), { recursive: true });
  writeAtomicText(intentFile(workspace, slug), JSON.stringify(intent, null, 2) + '\n');
}

interface PromoteIntent { text: string; collection: string; files: Record<string, string>; relinked: Record<string, string>; shared_pages: Record<string, string> }

/** This Library's promote intent for `slug`, or null when none is recorded or it does not read as one. */
function promoteIntent(workspace: string, slug: string): PromoteIntent | null {
  let text: string;
  let parsed: Record<string, unknown>;
  try {
    text = fs.readFileSync(intentFile(workspace, slug), 'utf8');
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const map = (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((one) => typeof one === 'string') ? (value as Record<string, string>) : null;
  const files = map(parsed['files']);
  const relinkedDigests = map(parsed['relinked']);
  const sharedPages = map(parsed['shared_pages']);
  if (parsed['slug'] !== slug || files === null || relinkedDigests === null || sharedPages === null || Object.keys(sharedPages).length === 0) return null;
  return { text, collection: typeof parsed['collection_id'] === 'string' ? parsed['collection_id'] : '', files, relinked: relinkedDigests, shared_pages: sharedPages };
}

/** The archived Book holds exactly the files the intent recorded, `_book.md` and `_index.md` as copied or as relinked. */
function intentMatches(intent: PromoteIntent, archiveFull: string): boolean {
  if (!fs.existsSync(archiveFull)) return false;
  const now = localDigests(archiveFull);
  now.delete('wiki/_moved.md');
  const names = new Set([...now.keys(), ...Object.keys(intent.files)]);
  return [...names].every((name) => now.get(name) === intent.files[name] || (intent.relinked[name] !== undefined && now.get(name) === intent.relinked[name]));
}

/**
 * A PROMOTE STOPPED AFTER THE MOVE (kickoffs/s195 spare S1): the archive route's "inspect the archive and both catalogs
 * before retrying" (`localarchive.ts`) is not promote's remedy, since s194 row 3 made its rerun finish the archive; that
 * sentence is replaced by the rerun. `shared archive`'s own stop is untouched.
 */
async function promoteArchive<T>(slug: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const said = (error as Error).message;
    const inspect = '; inspect the archive and both catalogs before retrying.';
    if (said.startsWith('Book archival stopped.') && said.includes(inspect)) refuse(said.replace(inspect, `; run deskpost shared promote ${slug} again to finish it.`));
    throw error;
  }
}

const noBook = (slug: string) => `This Library's collection has no Book ${slug} at collection/books/${slug}, so there is nothing to promote. Nothing was written.`;

/** The marker is part of the archive manifest; the intent stays until that manifest commits. */
function writeMoved(workspace: string, wiki: string, slug: string, opened: Opened): void {
  writeAtomicText(path.join(wiki, '_moved.md'), `# Moved\n\nmoved to the shared collection as \`shared/${slug}\`, ${localDate()}, by ${opened.libraryCard || opened.seat}\n`);
}

/** This Book's Catalog line in the local `collection/books/README.md`, or its `_book.md` heading and Purpose. */
function localCatalogWords(workspace: string, slug: string, bookText: string): { title: string; summary: string; heading: string | null } {
  const catalogFile = path.join(workspace, 'collection', 'books', 'README.md');
  const owned = fs.existsSync(catalogFile) ? ownedLines(readUtf8(catalogFile), [catalogTarget(slug)]) : [];
  const parsed = owned.length === 1 ? /\[\[[^|\]]+\|([^\]]+)\]\]\s*—\s*(.+?)\s*$/.exec(owned[0]!.line) : null;
  if (parsed) return { title: parsed[1]!.trim(), summary: parsed[2]!, heading: owned[0]!.heading };
  const body = withoutFrontmatter(bookText);
  const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1] ?? slug;
  const purpose = /^## Purpose\s*\r?\n+([\s\S]*?)(?:\r?\n## |\s*$)/m.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() || title;
  return { title, summary: purpose, heading: null };
}

/**
 * ONLY THE PROMOTING SEAT'S OWN ENTRY (item 9): `books/<slug>` swapped for `shared/<slug>` in place, through `deskWrite`
 * with this seat's claim. Already swapped, or never open here, it is left; no other seat's Desk is written.
 */
function swapDeskEntry(workspace: string, opened: Opened, parsed: ParsedArguments, slug: string): string {
  const entries = seatOpenBooks(workspace, opened.seat);
  if (!entries.includes(`books/${slug}`)) {
    return entries.includes(`shared/${slug}`) ? `this seat's Desk already holds shared/${slug}; left as it is` : `books/${slug} is not open on this seat's Desk; left as it is`;
  }
  deskWrite({ workspace, action: 'open', kind: 'book', location: 'shared', shelf: 'active', slug, seat: opened.seat, claimToken: parsed.options.get('claim-token'), replacing: `books/${slug}` });
  if (!seatOpenBooks(workspace, opened.seat).includes(`shared/${slug}`)) refuse(`This seat's Desk did not read back shared/${slug} after the swap.`);
  return `this seat's books/${slug} swapped for shared/${slug}`;
}

/**
 * `shared promote <slug>` (item 9; r12 point 6): ONE PREVIEW, ONE plan_id, covering every page of the local collection
 * Book with its digest, the target `books/<slug>/` and the archive route's own plan. THE COPY: new-book's steps with the
 * local `_book.md` and `_index.md`, each page, the Book's `_sources.md`, each `made_by: promote`, the Catalog line last.
 * THE ARCHIVE, only after every page read back: the archive route's locked half, which re-checks each local file against
 * the digests this run copied and names any that changed; `_moved.md` is written inside its locks. THE DESK: this seat's
 * entry only. A rerun skips what already matches and finishes the rest, the archive half included.
 */
async function runPromote(parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const early = earlyChecks('promote', parsed, workspace);
  const slug = early.slug;
  const activeFull = path.join(workspace, 'collection', 'books', slug);
  const archivedWiki = path.join(workspace, 'collection', 'archive', slug, 'wiki');
  // A surviving intent takes precedence over the marker until the archive manifest commits.
  const intent = !fs.existsSync(activeFull) && fs.existsSync(archivedWiki) ? promoteIntent(workspace, slug) : null;
  const archived = intent === null && !fs.existsSync(path.join(activeFull, 'wiki', '_book.md')) && fs.existsSync(path.join(archivedWiki, '_moved.md'));
  if (!archived && intent === null && !fs.existsSync(path.join(activeFull, 'wiki', '_book.md'))) {
    if (fs.existsSync(path.join(workspace, 'shelf', slug, 'wiki'))) {
      refuse(`${slug} is a Shelf Book, and promote takes a Book of this Library's collection: publish it there first (deskpost publish ${slug} --title <t> --summary <s> --preflight), then promote it. Nothing was written.`);
    }
    refuse(noBook(slug));
  }
  const opened = await connect(connection, parsed, workspace, slug, true);
  const scope = `Copies collection/books/${slug} to shared/${slug} as recorded changes (made_by: promote), its Catalog line last; then, only when every page read back, ` +
    `archives the local Book under the archive route's own locks, re-checking every file, and writes _moved.md into it; then swaps this seat's own Desk entry. A rerun finishes what is left.`;

  // THE ARCHIVE HALF ALREADY DONE (a rerun): only the Desk is left.
  if (archived) {
    if ((await readNow(opened.context, `books/${slug}/wiki/_book.md`)) === null) refuse(`collection/books/${slug} was archived with _moved.md, and shared/${slug} has no _book.md. Nothing was written.`);
    const preview = { schema: 1, operation: 'Promote a Book to the shared collection', collection: opened.collection, book: `shared/${slug}`, steps: [{ step: 1, does: 'the copy and the archive are done: skipped' }, { step: 2, does: "swap this seat's own Desk entry, if it still holds books/" + slug }],
      plan_id: 'shared-promote-' + sha256([opened.context.project, slug, 'desk'].join('\n')), confirmation_required: true, shared_library_write: false, scope };
    if (parsed.flags.has('preflight')) return preview;
    if ((parsed.options.get('plan-id') ?? '') !== preview.plan_id) refuse("Nothing was written: the plan_id given is not this preview's. Rerun --preflight and pass its exact plan_id.");
    return { schema: 1, operation: preview.operation, book: `shared/${slug}`, verdict: 'written', records: [], archive: 'already archived', desk: swapDeskEntry(workspace, opened, parsed, slug), shared_library_write: false,
      next: `shared/${slug} is promoted; open it with deskpost basic-memory open ${slug}.` };
  }

  // THE ARCHIVE STOPPED AFTER THE MOVE (a rerun): the shared copy read back, then the archive's remaining steps and the Desk.
  if (intent !== null) {
    const archiveFull = path.join(workspace, 'collection', 'archive', slug);
    if (!intentMatches(intent, archiveFull)) refuse(noBook(slug));
    // THE COLLECTION IT WAS PROMOTED TO (deskpost-lead's review of s194, finding 4): never finished against another one.
    if (intent.collection !== opened.context.project) {
      refuse(`collection/archive/${slug} was promoted to the shared collection ${intent.collection || 'that its intent does not name'}, not to ${opened.context.project}, which this Library's connection names, ` +
        'so it was not finished here. Nothing was moved.');
    }
    // EACH PAGE'S ROUTE BACK: a wiki page from promote's own record for it (this Library's, made_by: promote, the newest;
    // never another writer's record, whose body is their text), the sources from the archived copy, which the archive
    // leaves as it was (only _book.md and _index.md are relinked).
    const changeFiles = await listedFiles(opened.context, `_deskpost/changes/${slug}`);
    const promoted = new Map<string, string>();
    for (const id of recordIds(changeFiles, slug)) {
      const record = (await loadRecord(opened.context, changeFiles, id, false))?.record;
      if (record && record.madeBy === 'promote' && record.libraryId === opened.libraryId) promoted.set(record.page, id);
    }
    const routes = new Map<string, string>();
    for (const notePath of Object.keys(intent.shared_pages)) {
      const id = promoted.get(notePath);
      if (notePath === `books/${slug}/${SOURCE_LIST_FILE}`) routes.set(notePath, `deskpost shared sources ${slug} --content-path collection/archive/${slug}/${SOURCE_LIST_FILE} --preflight`);
      // No writer names _book.md or _index.md (`convertToBookPagePath`), and the archived ones are relinked: Eric's, from the record.
      else if (/\/wiki\/_(book|index)\.md$/.test(notePath)) routes.set(notePath, `ask Eric to put ${notePath} back on the server as promote's change record ${id ?? '(none listed)'} holds it`);
      else if (id !== undefined) routes.set(notePath, `deskpost shared replace-page ${slug} ${pageName(notePath)} --from-change ${id} --body --preflight`);
    }
    const preview = { schema: 1, operation: 'Promote a Book to the shared collection', collection: opened.collection, book: `shared/${slug}`,
      steps: [{ step: 1, does: 'the copy and the move are done: skipped' }, { step: 2, does: `finish the archive of collection/archive/${slug}: both catalogs, _moved.md and its Discovery manifest` },
        { step: 3, does: "swap this seat's own Desk entry, if it still holds books/" + slug }],
      plan_id: 'shared-promote-' + sha256([opened.context.project, slug, 'finish', intent.text].join('\n')), confirmation_required: true, shared_library_write: false, scope };
    if (parsed.flags.has('preflight')) return preview;
    if ((parsed.options.get('plan-id') ?? '') !== preview.plan_id) refuse("Nothing was written: the plan_id given is not this preview's. Rerun --preflight and pass its exact plan_id.");
    const archive = await promoteArchive(slug, () => finishCollectionBookArchiveAsync(workspace, slug, {
      allowMoved: true,
      recheck: async (full) => {
        if (promoteIntent(workspace, slug)?.text !== intent.text || !intentMatches(intent, full)) refuse(noBook(slug));
        await sharedCopyComplete(opened.context, slug, new Map(Object.entries(intent.shared_pages)), routes);
      },
      afterMove: (wiki) => writeMoved(workspace, wiki, slug, opened),
    }));
    fs.rmSync(intentFile(workspace, slug), { force: true });
    return { schema: 1, operation: preview.operation, book: `shared/${slug}`, verdict: 'written', records: [],
      archive: { archive_path: String(archive['archive_path'] ?? `archive/${slug}`), moved_note: `collection/archive/${slug}/wiki/_moved.md`, finished: true },
      desk: swapDeskEntry(workspace, opened, parsed, slug), shared_library_write: false,
      next: `Promoted to shared/${slug}; the stopped archive was finished with _moved.md. Open it with deskpost basic-memory open ${slug}.` };
  }

  // THE LOCAL BOOK, READ ONCE: every file's digest, and the pages to copy in order.
  const digests = localDigests(activeFull);
  const wikiPages = [...digests.keys()].filter((name) => name.startsWith('wiki/') && name.endsWith('.md') && name !== 'wiki/_book.md' && name !== 'wiki/_index.md').sort();
  const read = (relative: string) => readUtf8(path.join(activeFull, ...relative.split('/')));
  const pages: { notePath: string; proposed: string; target?: Target }[] = [
    ...['wiki/_book.md', 'wiki/_index.md', ...wikiPages].map((relative) => ({ notePath: `books/${slug}/${relative}`, proposed: read(relative) })),
    ...(digests.has(SOURCE_LIST_FILE) ? [{ notePath: `books/${slug}/${SOURCE_LIST_FILE}`, proposed: read(SOURCE_LIST_FILE), target: 'sources' as Target }] : []),
  ];
  const steps = await bookSteps(opened, 'promote', pages, true);
  const words = localCatalogWords(workspace, slug, read('wiki/_book.md'));
  if (/[\x00-\x1f\x7f]/.test(words.title + words.summary)) refuse('The Catalog title or summary holds control characters or DEL. Nothing was written.');
  const catalogText = await readNow(opened.context, CATALOG);
  if (catalogText === null) refuse(`The Book Catalog ${CATALOG} is missing; it will not be created implicitly. Nothing was written.`);
  const entry = `- [[${catalogTarget(slug)}|${words.title}]] — ${words.summary}`;
  const named = COLLECTIONS.find((name) => `## ${name}` === words.heading);
  const reapply = (text: string) => {
    const heading = named !== undefined ? `## ${named}` : oneOwnedLine(text, slug)?.heading || '## Open a Book';
    return placeOwnedEntry(text, catalogTarget(slug), entry, heading, named !== undefined ? '## Open a Book' : null, named !== undefined).text;
  };
  const catalog = catalogStep({ change: catalogChange(catalogText, reapply(catalogText), slug), operation: '', scope: '', reapply }, slug);
  const archivePlan = localArchivePlanId(workspace, slug);
  const preview: Record<string, PsJsonValue> = {
    ...bookPreview(opened, 'Promote a Book to the shared collection', steps, catalog, [archivePlan], scope),
    pages: [...digests].map(([name, digest]) => ({ page: `collection/books/${slug}/${name}`, sha256: digest })),
    target: `books/${slug}/ in ${opened.collection}`,
    archive: { from: `collection/books/${slug}`, to: `collection/archive/${slug}`, plan_id: archivePlan },
  };
  if (parsed.flags.has('preflight')) return preview;
  if ((parsed.options.get('plan-id') ?? '') !== preview['plan_id']) {
    refuse("Nothing was written: the plan_id given is not this preview's. The local Book, the shared copy or the Catalog may have changed since the preview; rerun --preflight and pass its exact plan_id.");
  }

  const records = await writeBookSteps(opened, workspace, 'promote', steps, catalog);
  const sharedPages = new Map(steps.map((step) => [step.notePath, sharedForm(withoutFrontmatter(step.proposed))]));
  // THE INTENT, BEFORE THE ARCHIVE (kickoffs/s194 row 3): rewritten on every run, left after a refusal, removed once
  // the archive manifest commits, so a stop after the move or marker can be finished by a rerun.
  writePromoteIntent(workspace, slug, {
    schema: 1, slug, shared: `shared/${slug}`, collection_id: opened.context.project,
    files: Object.fromEntries([...digests].sort()),
    relinked: Object.fromEntries(['wiki/_book.md', 'wiki/_index.md'].map((name) => [name, sha256(relinked(read(name), slug))])),
    shared_pages: Object.fromEntries([...sharedPages].sort()),
    records: records.map((row) => String((row as Record<string, PsJsonValue>)['record_id'])),
  });
  const archive = await promoteArchive(slug, () => archiveCollectionBookLockedAsync(workspace, slug, {
    recheck: async (full) => {
      const now = localDigests(full);
      const changed = [...new Set([...now.keys(), ...digests.keys()])].filter((name) => now.get(name) !== digests.get(name)).sort();
      if (changed.length) {
        refuse(`The local Book changed after it was copied, so it was not archived: ${changed.map((name) => `collection/books/${slug}/${name}`).join(', ')}. ` +
          `The shared copy stays; run deskpost shared promote ${slug} again to copy those pages and archive it. Nothing was moved.`);
      }
      // THE BOUNDARY LEFT: between this read and the rename, inside the local locks, which exclude no other Library. A
      // shared write after this read is an ordinary later change with its own record, not a hole in this copy.
      await sharedCopyComplete(opened.context, slug, sharedPages);
    },
    afterMove: (wiki) => writeMoved(workspace, wiki, slug, opened),
  }));
  fs.rmSync(intentFile(workspace, slug), { force: true });
  return {
    schema: 1,
    operation: 'Promote a Book to the shared collection',
    book: `shared/${slug}`,
    verdict: 'written',
    records,
    archive: { archive_path: String(archive['archive_path'] ?? `archive/${slug}`), moved_note: `collection/archive/${slug}/wiki/_moved.md` },
    desk: swapDeskEntry(workspace, opened, parsed, slug),
    shared_library_write: true,
    next: `Promoted to shared/${slug}; the local Book is archived with _moved.md. Its records are history, not restore sources: ${restoreLine('page', slug, '', true, '', 'promote').says}.`,
  };
}

// --- upkeep grants (item 16; kickoffs/s195) ---------------------------------------------------------------------------

/**
 * THE GRANT NOTE `_deskpost/upkeep/<slug>.md` (item 16; its format pinned word for word in kickoffs/s195 and c120): a
 * `# Upkeep grants for <slug>` line, then one block per Library, in the order written:
 *
 *     ## library <library_id>
 *     - card: <library card>
 *     - seat_ids: <seat_id>[,<seat_id>...]      (empty when any_seat is true)
 *     - any_seat: true|false
 *     - names: <seat name>[,...]                 (display only; "any seat" when any_seat)
 *     - book_record: <record id of the change that created books/<slug>/wiki/_book.md>
 *     - time: <ISO 8601 UTC of the grant>
 *
 * A grant is provenance, not authentication (ADR-0090): it names who may keep the Book up to date without Eric's yes for
 * each write, and every such write still takes the whole safe path, recorded first and restorable.
 */
const upkeepNote = (slug: string) => `_deskpost/upkeep/${slug}.md`;

interface UpkeepBlock {
  libraryId: string;
  seatIds: string[];
  anySeat: boolean;
  names: string[];
  bookRecord: string;
  /** The block's own lines, exactly as read, so another Library's block is written back byte for byte. */
  raw: string;
}

/** The note's blocks; a leading frontmatter block is skipped, an empty `- seat_ids:` and trailing whitespace are accepted. */
function upkeepBlocks(text: string): UpkeepBlock[] {
  const body = withoutFrontmatter(text);
  const starts = [...body.matchAll(/^## library \S+[ \t]*\r?$/gm)].map((match) => match.index);
  return starts.map((start, at) => {
    const raw = body.slice(start, starts[at + 1] ?? body.length);
    const fields = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const pair = /^- ([a-z_]+):[ \t]*(.*?)\s*$/.exec(line);
      if (pair && !fields.has(pair[1]!)) fields.set(pair[1]!, pair[2]!);
    }
    const list = (name: string) => (fields.get(name) ?? '').split(',').map((one) => one.trim()).filter(Boolean);
    return { libraryId: /^## library (\S+)/.exec(raw)![1]!, seatIds: list('seat_ids'), anySeat: fields.get('any_seat') === 'true', names: list('names'), bookRecord: fields.get('book_record') ?? '', raw };
  });
}

const upkeepText = (slug: string, raws: string[]) => `# Upkeep grants for ${slug}\n\n` + raws.join('');

/** A record that made this Book: a `base: absent` creation of its `_book.md` by `new-book` or `promote`, from any Library. */
const makesBook = (record: ChangeRecord | null | undefined, slug: string): boolean =>
  !!record && record.target === 'page' && record.page === `books/${slug}/wiki/_book.md` && record.baseAbsent && (record.madeBy === 'new-book' || record.madeBy === 'promote');

/**
 * THE GRANT THIS SEAT WRITES UNDER (item 16, second bullet), read fresh by every writer that may use one: this Library's
 * block naming the caller's `seat_id` (or `any_seat`, the caller holding a live seat here, as `connect` proved), whose
 * `book_record` is a creation of this Book's `_book.md`. One listing; the note and the record are read only when listed.
 */
async function upkeepGrant(opened: Opened): Promise<UpkeepBlock | null> {
  const { context } = opened;
  const listed = await listedRead(context, upkeepNote(context.slug));
  if (listed === null) return null;
  const blocks = upkeepBlocks(bodyOf(listed.text));
  if (new Set(blocks.map((one) => one.libraryId)).size !== blocks.length) return null;
  const block = blocks.find((one) => one.libraryId === opened.libraryId && (one.anySeat || one.seatIds.includes(opened.seatId)));
  if (block === undefined || !RECORD_ID.test(block.bookRecord)) return null;
  const files = await listedFiles(context, `_deskpost/changes/${context.slug}`);
  return makesBook((await loadRecord(context, files, block.bookRecord, false))?.record, context.slug) ? block : null;
}

const upkeepCopy = (workspace: string, slug: string) => path.join(workspace, 'internal', 'shared-upkeep', `${slug}.json`);

/** The grant note written conditionally (created when unlisted, replaced on the same read's checksum, or deleted), read back. */
async function writeUpkeepNote(context: Context, notePath: string, listed: { checksum: string } | null, text: string | null): Promise<void> {
  const verdict = text === null ? await deleteNote(context.session, context.project, notePath, listed!.checksum)
    : listed === null ? await createNote(context.session, context.project, notePath, text) : await replaceNote(context.session, context.project, notePath, text, listed.checksum);
  if (verdict.form === 'refused') {
    if (verdict.code === 'REVISION_CONFLICT' || verdict.code === 'ALREADY_EXISTS') refuse(`${notePath} was written by someone else since it was read (${verdict.code}), so nothing was overwritten. Preview it again.`);
    refuse(`The server refused the write of ${notePath}: ${verdict.code}: ${verdict.message}.`);
  }
  const unsettledNote = (why: string) => refuse(`The write of ${notePath} is unsettled: ${why}. Preview it again to see whether it landed; it was not sent again.`);
  if (verdict.form === 'unknown') unsettledNote(verdict.reason);
  let back = await listedRead(context, notePath);
  if (text !== null && back === null) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    back = await listedRead(context, notePath);
  }
  if (text === null ? back !== null : back === null || !sameText(back.text, text)) unsettledNote('it does not read back as written');
}

/**
 * `shared upkeep <slug> (--seats <seat>[,...] | --any-seat)` (item 16, first bullet): THE GRANT, gated, writes this
 * Library's block (each named seat's `seat_id` from this Library's registry, the Library id, the making record's id) and
 * keeps every other Library's block byte for byte; its plan_id binds the note as read and the proposed text without its
 * `time:` line. `--off` removes only this Library's block with `--plan-id` alone, and deletes the note when no block is left.
 * After the readback, this Library's copy of its block is kept at `internal/shared-upkeep/<slug>.json` for the Desk.
 */
async function runUpkeep(parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const usage = USAGE.upkeep;
  const slug = (parsed.positional[0] ?? '').trim();
  if (!slug) refuse(`library shared upkeep needs a Book slug: ${usage}.`);
  if (!BOOK_SLUG_PATTERN.test(slug)) refuse(`'${slug}' is not a Book slug: lowercase letters, digits and hyphens. Nothing was written.`);
  const off = parsed.flags.has('off');
  const seatsWord = parsed.options.get('seats');
  const anySeat = parsed.flags.has('any-seat');
  if (off ? seatsWord !== undefined || anySeat : (seatsWord === undefined) === !anySeat) refuse(`library shared upkeep takes --seats <seat>[,...] or --any-seat, or --off alone: ${usage}.`);
  const preflight = parsed.flags.has('preflight');
  const planGiven = (parsed.options.get('plan-id') ?? '') !== '';
  if (off ? preflight === planGiven : preflight === parsed.flags.has('user-confirmed')) {
    refuse(off ? `library shared upkeep --off takes --preflight, or --plan-id <id> after it: ${usage}.` : `library shared upkeep takes --preflight, or --user-confirmed --plan-id <id> after it: ${usage}.`);
  }
  const opened = await connect(connection, parsed, workspace, slug, true);
  const { context } = opened;
  const notePath = upkeepNote(slug);
  const listed = await listedRead(context, notePath);
  const current = listed === null ? null : bodyOf(listed.text);
  const blocks = current === null ? [] : upkeepBlocks(current);
  const mine = blocks.find((block) => block.libraryId === opened.libraryId);
  const currentDigest = digestOf(current);
  const base = { schema: 1, collection: opened.collection, book: `shared/${slug}`, note: notePath, library_id: opened.libraryId };

  if (off) {
    const removed = blocks.filter((block) => block.libraryId === opened.libraryId).length;
    const kept = blocks.filter((block) => block.libraryId !== opened.libraryId).map((block) => block.raw);
    const proposed = kept.length ? upkeepText(slug, kept) : null;
    const preview: Record<string, PsJsonValue> = {
      ...base, operation: 'Turn off upkeep of a shared Book', current_sha256: currentDigest, proposed_sha256: digestOf(proposed),
      plan_id: 'shared-upkeep-' + sha256([context.project, slug, 'off', currentDigest, digestOf(proposed)].join('|')),
      confirmation_required: false, shared_library_write: true, blocks_removed: removed,
      scope: proposed === null ? `Deletes ${notePath}, which holds only this Library's grant, only while it is still the text read here.`
        : `Removes all ${removed} blocks of this Library from ${notePath} only while it is still the text read here; every other Library's block is kept as it is.`,
    };
    if (mine === undefined) {
      fs.rmSync(upkeepCopy(workspace, slug), { force: true });
      return { ...preview, status: 'unchanged', next: `This Library has no upkeep grant for shared/${slug}; nothing was written.` };
    }
    if (preflight) return preview;
    if (parsed.options.get('plan-id') !== preview['plan_id']) refuse("Nothing was written: the plan_id given is not this preview's. The grant note may have changed since the preview; rerun --preflight and pass its exact plan_id.");
    await writeUpkeepNote(context, notePath, listed, proposed);
    fs.rmSync(upkeepCopy(workspace, slug), { force: true });
    return { ...base, operation: preview['operation']!, verdict: 'written', shared_library_write: true, blocks_removed: removed,
      next: `Removed ${removed} upkeep block(s). Upkeep of shared/${slug} by this Library is off: every write to it needs the reader's yes again.` };
  }

  if (new Set(blocks.map((block) => block.libraryId)).size !== blocks.length) {
    refuse(`Invalid upkeep note ${notePath}: duplicate Library blocks; no grant was written. Turn this Library's grants off with deskpost shared upkeep ${slug} --off --preflight.`);
  }

  // THE BOOK, THE SEATS AND THE MAKING RECORD.
  if (!(await listedFiles(context, `books/${slug}/wiki`)).has(`books/${slug}/wiki/_book.md`)) {
    refuse(`The shared collection '${opened.collection}' has no Book at books/${slug} (its folder lists no _book.md), so there is nothing to grant. Nothing was written.`);
  }
  const registry = readSeatRegistry(path.join(workspace, '.claude'));
  const names = anySeat ? [] : [...new Set((seatsWord ?? '').split(',').map((name) => name.trim()).filter(Boolean))];
  if (!anySeat && names.length === 0) refuse(`library shared upkeep --seats names at least one seat: ${usage}.`);
  const seatIds = names.map((name) => {
    const row = registry.find((entry) => entry.seat === name);
    if (row === undefined) refuse(`${name} is not a live seat of this Library, so it cannot be granted upkeep: deskpost seat cards lists them. Nothing was written.`);
    if (!row.seatId) refuse(`The seat ${name} has no seat_id in this Library's registry, so a grant could not name it: see deskpost seat cards. Nothing was written.`);
    return row.seatId;
  });
  const files = await listedFiles(context, `_deskpost/changes/${slug}`);
  let making: string | null = null;
  for (const id of recordIds(files, slug)) {
    if (makesBook((await loadRecord(context, files, id, false))?.record, slug)) {
      making = id;
      break;
    }
  }
  if (making === null) {
    refuse(`shared/${slug} has no record of being made by deskpost shared new-book or promote (a Book made before 1.6.0's writers), and 1.6.0 has no route to grant it: ` +
      'its writes keep the reader\'s yes for each one. Nothing was written.');
  }
  const blockOf = (time: string | null) => [`## library ${opened.libraryId}`, `- card: ${opened.libraryCard}`, `- seat_ids: ${seatIds.join(',')}`, `- any_seat: ${anySeat}`,
    `- names: ${anySeat ? 'any seat' : names.join(',')}`, `- book_record: ${making}`, ...(time === null ? [] : [`- time: ${time}`]), ''].join('\n');
  const proposedAt = (time: string | null) => upkeepText(slug, mine === undefined ? (blocks.length && !blocks.at(-1)!.raw.endsWith('\n') ? [blockOf(time), ...blocks.map((block) => block.raw)] : [...blocks.map((block) => block.raw), blockOf(time)]) : blocks.map((block) => (block === mine ? blockOf(time) : block.raw)));
  const proposedDigest = sha256(proposedAt(null));
  const preview: Record<string, PsJsonValue> = {
    ...base, operation: 'Grant upkeep of a shared Book',
    seats: anySeat ? 'any seat of this Library' : names.map((name, at) => ({ seat: name, seat_id: seatIds[at]! })),
    book_record: making, current_sha256: currentDigest, proposed_sha256: proposedDigest,
    diff: unifiedDiff(current ?? '', proposedAt('<the time of the apply>'), DIFF_LINES),
    plan_id: 'shared-upkeep-' + sha256([context.project, slug, 'grant', currentDigest, proposedDigest].join('|')),
    confirmation_required: true, shared_library_write: true,
    scope: `Writes this Library's block in ${notePath} only while it is still the text read here, keeping every other Library's block as it is. ` +
      `Then ${anySeat ? 'any seat of this Library' : names.join(', ')} may add, replace and restore pages, the Catalog line and the sources of shared/${slug} without the reader's yes for each write; ` +
      'removing a page or the sources, and making or promoting a Book, still need it.',
  };
  if (mine !== undefined && blockOf(null).trim() === mine.raw.split('\n').filter((line) => !/^- time:/.test(line)).join('\n').trim()) {
    const time = /^- time:[ \t]*(\S+)\s*$/m.exec(mine.raw)?.[1];
    if (!time) refuse(`Invalid upkeep note ${notePath}: this Library's block has no time; its local copy was not refreshed.`);
    const copy = upkeepCopy(workspace, slug);
    const text = JSON.stringify({ schema: 1, slug, book: `shared/${slug}`, collection_id: context.project, library_id: opened.libraryId,
      seat_ids: mine.seatIds, any_seat: mine.anySeat, names: mine.names, book_record: mine.bookRecord, time }, null, 2) + '\n';
    const state = !fs.existsSync(copy) ? 'missing' : readUtf8(copy) === text ? 'current' : 'stale';
    if (!preflight && state !== 'current') {
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      writeAtomicText(copy, text);
    }
    return { ...preview, status: 'unchanged', local_copy: preflight ? state : state === 'current' ? 'current' : 'refreshed',
      next: preflight && state !== 'current' ? `The grant already reads as asked; its local copy is ${state}. Refresh it with deskpost shared upkeep ${slug} ${anySeat ? '--any-seat' : '--seats ' + names.join(',')} --user-confirmed --plan-id ${String(preview['plan_id'])}. No server write is needed.`
        : `This Library's grant for shared/${slug} already reads as asked; no server write was made. Its local copy is ${state === 'current' ? 'current' : 'refreshed'}.` };
  }
  if (preflight) return preview;
  if (parsed.options.get('plan-id') !== preview['plan_id']) refuse("Nothing was written: the plan_id given is not this preview's. The grant note may have changed since the preview; rerun --preflight and pass its exact plan_id.");
  const time = new Date().toISOString();
  await writeUpkeepNote(context, notePath, listed, proposedAt(time));
  fs.mkdirSync(path.dirname(upkeepCopy(workspace, slug)), { recursive: true });
  writeAtomicText(upkeepCopy(workspace, slug), JSON.stringify({ schema: 1, slug, book: `shared/${slug}`, collection_id: context.project, library_id: opened.libraryId,
    seat_ids: seatIds, any_seat: anySeat, names: anySeat ? ['any seat'] : names, book_record: making, time }, null, 2) + '\n');
  return { ...base, operation: preview['operation']!, verdict: 'written', book_record: making, time, shared_library_write: true,
    next: `Granted: ${anySeat ? 'any seat of this Library' : names.join(', ')} may keep shared/${slug} up to date without a yes for each write. Turn it off with deskpost shared upkeep ${slug} --off --preflight.` };
}

// --- the readers (r12 point 3) ---------------------------------------------------------------------------------------

/** The record ids listed in one Book's change folder: `<id>.md`, never a companion. */
function recordIds(files: Map<string, string>, slug: string): string[] {
  const folder = `_deskpost/changes/${slug}/`;
  return [...files.keys()]
    .filter((file) => file.startsWith(folder) && file.endsWith('.md') && !/\.(base|body)\.md$/.test(file))
    .map((file) => file.slice(folder.length, -3))
    .filter((id) => RECORD_ID.test(id))
    .sort();
}

const CLASSES = { current: 'current', superseded: 'superseded', notCurrent: 'not current, text kept', damaged: 'damaged' } as const;

async function runReconcile(parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const slug = (parsed.positional[0] ?? '').trim();
  if (!slug) refuse(`library shared reconcile needs a Book slug: ${USAGE.reconcile}.`);
  if (!BOOK_SLUG_PATTERN.test(slug)) refuse(`'${slug}' is not a Book slug: lowercase letters, digits and hyphens. Nothing was read.`);
  const { context } = await connect(connection, parsed, workspace, slug, false);
  const files = await listedFiles(context, `_deskpost/changes/${slug}`);
  const loaded: LoadedRecord[] = [];
  for (const id of recordIds(files, slug)) {
    const one = await loadRecord(context, files, id, true);
    if (one !== null) loaded.push(one);
  }

  // EACH TARGET'S CURRENT VALUE, read once: a page's or the sources' text, or THIS BOOK'S OWN CATALOG LINE (the Catalog is
  // every Book's; another Book's records sit in its own folder, so only this Book's line is judged).
  const value = (target: Target, textOf: string | null) => (target === 'catalog' ? ownedLineOf(textOf, slug) : textOf);
  const groups = new Map<string, LoadedRecord[]>();
  for (const one of loaded) {
    if (one.record === null) continue;
    const key = `${one.record.target}|${one.record.page}`;
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }
  const currents = new Map<string, string | null>();
  for (const key of groups.keys()) {
    const [target, notePath] = key.split('|') as [Target, string];
    currents.set(key, value(target, await readNow(context, notePath)));
  }

  const rows: PsJsonValue[] = [];
  for (const one of loaded) {
    const record = one.record;
    const row: Record<string, PsJsonValue> = { record_id: one.id, target: record?.target ?? null, page: record?.page ?? null, seat: record?.seat ?? null, time: record?.time ?? null };
    if (one.damaged !== null || record === null) {
      rows.push({ ...row, class: CLASSES.damaged, why: one.damaged ?? 'unreadable', restore: null });
      continue;
    }
    const key = `${record.target}|${record.page}`;
    const body = value(record.target, one.body);
    const others = groups.get(key)!.filter((other) => other !== one && other.damaged === null);
    const kind = sameValue(body, currents.get(key) ?? null)
      ? CLASSES.current
      : others.some((other) => sameValue(value(record.target, other.base), body)) ? CLASSES.superseded : CLASSES.notCurrent;
    rows.push({ ...row, class: kind, ...(kind === CLASSES.current ? { restore: null } : restoreFields(record, slug)) });
  }
  const outside: PsJsonValue[] = [];
  for (const [key, group] of groups) {
    const [target, notePath] = key.split('|') as [Target, string];
    const current = currents.get(key) ?? null;
    // A TEXT DESKPOST KNOWS is a record's body, or a record's base (a write that never landed leaves the base): only a
    // current text that is neither came from outside Deskpost.
    if (!group.some((one) => one.damaged === null && (sameValue(value(target, one.body), current) || sameValue(value(target, one.base), current)))) {
      outside.push({ target, page: notePath, now: current === null ? 'absent' : 'present', says: 'changed outside Deskpost: its current text matches no change record' });
    }
  }
  const count = (kind: string) => rows.filter((row) => (row as Record<string, PsJsonValue>)['class'] === kind).length;
  return {
    schema: 1,
    operation: 'Reconcile a shared Book',
    book: `shared/${slug}`,
    records: rows,
    changed_outside_deskpost: outside,
    counts: { current: count(CLASSES.current), superseded: count(CLASSES.superseded), not_current: count(CLASSES.notCurrent), damaged: count(CLASSES.damaged), changed_outside_deskpost: outside.length },
    shared_library_write: false,
    next: rows.length === 0 ? `No change records for shared/${slug}.` : `${rows.length} change record(s) classified; nothing was written.`,
  };
}

async function runChanges(parsed: ParsedArguments, workspace: string, connection: Connection): Promise<Record<string, PsJsonValue>> {
  const slug = (parsed.positional[0] ?? '').trim();
  if (slug && !BOOK_SLUG_PATTERN.test(slug)) refuse(`'${slug}' is not a Book slug: lowercase letters, digits and hyphens. Nothing was read.`);
  const sinceWord = parsed.options.get('since');
  const since = sinceWord === undefined ? null : Date.parse(sinceWord);
  if (since !== null && Number.isNaN(since)) refuse(`library shared changes --since takes a date, such as 2026-11-05; got '${sinceWord}'.`);
  const opened = await connect(connection, parsed, workspace, slug || 'all', false);
  const { session, project } = opened.context;
  let slugs: string[];
  if (slug) slugs = [slug];
  else {
    const nodes = await listFolderNodes(session, project, '_deskpost/changes', 'The folder _deskpost/changes', 'The folder _deskpost/changes holds more than 5,000 Books.');
    slugs = nodes.filter((node) => field(node, 'type') === 'directory').map((node) => text(field(node, 'name'))).filter((name) => BOOK_SLUG_PATTERN.test(name)).sort();
  }
  const listed: Record<string, PsJsonValue>[] = [];
  for (const book of slugs) {
    const context: Context = { session, project, slug: book };
    const files = await listedFiles(context, `_deskpost/changes/${book}`);
    for (const id of recordIds(files, book)) {
      const one = await loadRecord(context, files, id, false);
      if (one === null) continue;
      const record = one.record;
      if (record === null) {
        listed.push({ book: `shared/${book}`, record_id: id, time: null, target: null, page: null, seat: null, library_card: null, restore: null, damaged: one.damaged });
        continue;
      }
      listed.push({ book: `shared/${book}`, record_id: id, time: record.time, target: record.target, page: record.page, seat: record.seat, library_card: record.libraryCard, ...restoreFields(record, book) });
    }
  }
  // NEWEST FIRST BY THE RECORD'S OWN TIME, for reading only (r12 point 3): nothing is ordered or skipped by it otherwise.
  const timeOf = (row: Record<string, PsJsonValue>) => (typeof row['time'] === 'string' ? Date.parse(row['time']) : Number.NaN);
  const shown = listed
    .filter((row) => since === null || timeOf(row) >= since)
    .sort((a, b) => (Number.isNaN(timeOf(b)) ? -1 : Number.isNaN(timeOf(a)) ? 1 : timeOf(b) - timeOf(a)) || String(b['record_id']).localeCompare(String(a['record_id'])));
  return {
    schema: 1,
    operation: 'List the changes to shared Books',
    books: slugs.map((book) => `shared/${book}`),
    since: sinceWord ?? null,
    changes: shown,
    shown: shown.length,
    listed: listed.length,
    shared_library_write: false,
  };
}

/** `deskpost shared <action>` for the connection route's actions, on a local Library. */
export async function runSharedAction(action: SharedAction, argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('shared', action));
  const connection = optedIn(action, workspace);
  try {
    if (action === 'reconcile') return await runReconcile(parsed, workspace, connection);
    if (action === 'changes') return await runChanges(parsed, workspace, connection);
    if (action === 'new-book') return await runNewBook(parsed, workspace, connection);
    if (action === 'promote') return await runPromote(parsed, workspace, connection);
    if (action === 'upkeep') return await runUpkeep(parsed, workspace, connection);
    return await runWrite(action, parsed, workspace, connection);
  } catch (error) {
    if (error instanceof BasicMemoryRefusal) refuse(`${error.message} (shared ${action} ${parsed.positional.join(' ')})`);
    throw error;
  }
}
