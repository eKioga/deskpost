/**
 * THE BASIC MEMORY 1.0 WRITE PRIMITIVES (kickoffs/s178-r2 row 5; PLAN-basic-memory-1-0.md Unit A item 2). Five changes
 * -- create, conditional replace, guarded edit, guarded move, guarded delete -- each sent EXACTLY ONCE and answered with a
 * typed verdict (`BmVerdict`): `written`, `refused` (the server's own typed refusal: nothing changed) or `unknown`.
 * No caller uses them yet; 1.6.0's shared writers will be the first, and `tools/bm-proof.mts` proves them on a server.
 *
 * WHEN A CHANGE IS UNCERTAIN -- `OUTCOME_UNKNOWN`, a dropped session (`SessionDropped`: re-opened and never resent), a
 * failure after the request reached `fetch` (`TransportUncertain`), or an answer with no receipt -- the primitive SETTLES
 * IT ONCE, BY LISTING: the target's folder is listed, the file found by its exact `file_path`, and read by that listing
 * (`readListedRecord`), never by a path read, which 1.0 can answer with a moved note. Settlement never returns
 * `refused` (only the server says nothing changed), and a listing or read that fails while settling is `unknown`.
 * A refusal raised before anything is sent (a server that is not 1.0, a bad path, the address judged unsafe) is thrown,
 * not turned into a verdict.
 *
 * TEXT EQUALITY is `writeExact`'s rule (basicmemory.ts): the listed text without its frontmatter, CRLF made LF and
 * trimmed, against the proposed body treated the same way. Writes compare bodies without frontmatter; an uncertain
 * move compares the whole text's SHA-256, frontmatter included, against the source read before sending.
 */

import { createHash } from 'node:crypto';
import { BasicMemoryRefusal, field, judgeBmWrite, listFolderNodes, McpSession, noteBody, readExactOrNull, readListedRecord, refuse, SessionDropped, text, TransportUncertain } from './basicmemory.ts';
import type { BmVerdict, Json, NoteRecord } from './basicmemory.ts';

/** The edit commands that add their text again when applied twice: never sent without a checksum (Book `basic-memory`). */
const ADDITIVE_EDIT = /^(append|prepend|insert_before_section|insert_after_section)$/;

function needBm(session: McpSession, operation: string): void {
  if (session.surface !== 'bm') {
    refuse(`${operation} speaks Basic Memory 1.0 only, and the server at ${session.endpoint} does not offer the 1.0 tools (its surface is ${session.surface}). Nothing was sent.`);
  }
}

/** `<directory>/<title>.md` split as `bm_write` takes it; a path that is not one is refused before anything is sent. */
function pathParts(notePath: string): { directory: string; title: string } {
  const match = /^(?:([A-Za-z0-9._-][A-Za-z0-9._ /-]*)\/)?([^/\\]+)\.md$/.exec(notePath);
  if (!match || /(^|\/)\.{1,2}(\/|$)|\/\//.test(notePath)) refuse(`'${notePath}' is not a note path of the form <directory>/<title>.md. Nothing was sent.`);
  return { directory: match[1] ?? '', title: match[2]! };
}

function folderOf(notePath: string): string {
  return notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
}

function sameText(listed: string, proposed: string): boolean {
  const record: NoteRecord = { file_path: '', title: '', content: listed };
  return noteBody(record).replace(/\r\n/g, '\n').trim() === proposed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n').trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The file at exactly `notePath`, as its folder's listing reports it, or null when the listing has none there. */
async function listedNode(session: McpSession, project: string, notePath: string): Promise<{ filePath: string; permalink: string } | null> {
  const folder = folderOf(notePath) || '/';
  const nodes = await listFolderNodes(session, project, folder, `The folder ${folder}`,
    `The folder ${folder} holds more than 5,000 notes, and this release lists at most 50 pages of 100.`);
  const node = nodes.find((item) => field(item, 'type') === 'file' && text(field(item, 'file_path')) === notePath);
  return node === undefined ? null : { filePath: notePath, permalink: text(field(node, 'permalink')) };
}

async function readNode(session: McpSession, project: string, node: { filePath: string; permalink: string }): Promise<{ text: string; checksum: string } | null> {
  return readListedRecord(session, { id: project, name: project }, node.filePath, node.permalink);
}

function unknown(reason: string, observedChecksum?: string): BmVerdict {
  return observedChecksum ? { form: 'unknown', reason, observedChecksum } : { form: 'unknown', reason };
}

/** Settlement, guarded: a refusal while listing or reading is `unknown`, never a verdict of its own. */
async function settling(reason: string, settle: () => Promise<BmVerdict>): Promise<BmVerdict> {
  try {
    return await settle();
  } catch (error) {
    if (error instanceof BasicMemoryRefusal) return unknown(`${reason}; settling it by listing failed: ${error.message}`);
    throw error;
  }
}

/**
 * ONE CHANGE, SENT ONCE. The server's verdict when it gives one; otherwise (`unknown`, a dropped session, a transport
 * failure after sending) the primitive's own settlement, run once.
 */
async function change(session: McpSession, tool: string, args: Record<string, Json>, settle: (reason: string) => Promise<BmVerdict>): Promise<BmVerdict> {
  let response: unknown;
  try {
    response = await session.callToolOnce(tool, args);
  } catch (error) {
    if (error instanceof SessionDropped || error instanceof TransportUncertain) return settling(error.message, () => settle(error.message));
    throw error;
  }
  const verdict = judgeBmWrite(response);
  if (verdict.form !== 'unknown') return verdict;
  return settling(verdict.reason, () => settle(verdict.reason));
}

/** Create and replace: `written` when the listed file's text is the proposed text; else `unknown`, with what was seen. */
async function settleText(session: McpSession, project: string, notePath: string, body: string, reason: string): Promise<BmVerdict> {
  const node = await listedNode(session, project, notePath);
  if (node === null) return unknown(`${reason}; its folder does not list ${notePath}`);
  const read = await readNode(session, project, node);
  if (read === null) return unknown(`${reason}; ${notePath} was listed but read NOT_FOUND`);
  if (sameText(read.text, body)) return { form: 'written', filePath: notePath, checksum: read.checksum };
  return unknown(`${reason}; ${notePath} holds other text`, read.checksum);
}

/** A new note at `notePath`, never over an existing one: `ALREADY_EXISTS` is `refused`, never a retry. */
export async function createNote(session: McpSession, project: string, notePath: string, body: string): Promise<BmVerdict> {
  needBm(session, 'createNote');
  const { directory, title } = pathParts(notePath);
  return change(session, 'bm_write', { directory, title, content: body, note_type: 'note', overwrite: false, output_format: 'json', project },
    (reason) => settleText(session, project, notePath, body, reason));
}

/**
 * The note at `notePath` replaced only while it is still the revision `expectedChecksum` names -- the checksum of the very
 * `bm_read` its base text came from, passed verbatim, never a digest Deskpost computes.
 */
export async function replaceNote(session: McpSession, project: string, notePath: string, body: string, expectedChecksum: string): Promise<BmVerdict> {
  needBm(session, 'replaceNote');
  const { directory, title } = pathParts(notePath);
  if (!expectedChecksum) refuse(`replaceNote '${notePath}' needs the checksum of the read its base came from. Nothing was sent.`);
  return change(session, 'bm_write', { directory, title, content: body, note_type: 'note', overwrite: true, expected_checksum: expectedChecksum, output_format: 'json', project },
    (reason) => settleText(session, project, notePath, body, reason));
}

/** The body an edit leaves, for the commands whose result the helper can compute; null for any other (STANDING ANSWER 5). */
function editedBody(command: string, base: string, args: Record<string, Json>): string | null {
  const content = typeof args['content'] === 'string' ? args['content'] : null;
  if (content === null) return null;
  if (command === 'append') return `${base.trimEnd()}\n${content}`;
  if (command === 'prepend') return `${content}\n${base.trimStart()}`;
  if (command === 'find_replace' && typeof args['find_text'] === 'string' && args['find_text'] !== '') return base.split(args['find_text']).join(content);
  return null;
}

/**
 * `bm_edit` with `command` and its `args` (`content`, `find_text`, `section`, ...). `append`, `prepend` and `insert_*`
 * add their text again if applied twice, so without `expectedChecksum` they are refused here, as `CHECKSUM_REQUIRED`,
 * before anything is sent. The base is read first (`readExactOrNull`), for settlement.
 */
export async function editNote(session: McpSession, project: string, notePath: string, command: string, args: Record<string, Json>, expectedChecksum?: string): Promise<BmVerdict> {
  needBm(session, 'editNote');
  pathParts(notePath);
  if (ADDITIVE_EDIT.test(command) && !expectedChecksum) {
    return { form: 'refused', code: 'CHECKSUM_REQUIRED', message: `${command} adds its text again if it is applied twice, so it is sent only with the checksum of the read its base came from. Nothing was sent.` };
  }
  const base = await readExactOrNull(session, project, notePath);
  const sent: Record<string, Json> = { ...args, identifier: notePath, command, output_format: 'json', project };
  if (expectedChecksum) sent['expected_checksum'] = expectedChecksum;
  return change(session, 'bm_edit', sent, async (reason) => {
    if (base === null) return unknown(`${reason}; the note was not there to read before the edit`);
    const expected = editedBody(command, noteBody(base), args);
    if (expected === null) return unknown(`${reason}; the text a ${command} leaves cannot be computed here, so it was not settled`);
    const node = await listedNode(session, project, notePath);
    if (node === null) return unknown(`${reason}; its folder does not list ${notePath}`);
    const read = await readNode(session, project, node);
    if (read === null) return unknown(`${reason}; ${notePath} was listed but read NOT_FOUND`);
    const before = expectedChecksum ?? base.checksum ?? '';
    if (read.checksum !== before && sameText(read.text, expected)) return { form: 'written', filePath: notePath, checksum: read.checksum };
    return unknown(`${reason}; ${notePath} does not hold the edited text`, read.checksum);
  });
}

/**
 * `bm_move` of `notePath` to `destination` (a note path, or a folder ending in `/`). Before sending, the source is read by
 * its listing and its whole text's SHA-256 kept: an uncertain move is `written` only when the source folder no longer
 * lists it, the destination folder lists the destination file, and that file, read by its listing, has the same SHA-256,
 * frontmatter included (kickoffs/s181-r2 row 2; library-auditor M2). A body alone does not prove identity: another note of
 * the same body, or an empty one, would pass. The NAS kept a moved note's bytes (s180's live S6, same checksum); a server
 * that rewrites them makes an uncertain move `unknown`, the safe direction.
 */
export async function moveNote(session: McpSession, project: string, notePath: string, destination: string, expectedChecksum?: string): Promise<BmVerdict> {
  needBm(session, 'moveNote');
  pathParts(notePath);
  const into = destination.replace(/^\/+/, '');
  const target = into.endsWith('/') ? `${into}${notePath.slice(notePath.lastIndexOf('/') + 1)}` : into;
  pathParts(target);
  const source = await listedNode(session, project, notePath);
  const sourceRead = source === null ? null : await readNode(session, project, source);
  const digest = sourceRead === null ? null : sha256(sourceRead.text);
  const sent: Record<string, Json> = { identifier: notePath, destination, output_format: 'json', project };
  if (expectedChecksum) sent['expected_checksum'] = expectedChecksum;
  return change(session, 'bm_move', sent, async (reason) => {
    if (digest === null) return unknown(`${reason}; the source was not listed before the move, so there is nothing to compare`);
    if ((await listedNode(session, project, notePath)) !== null) return unknown(`${reason}; the source folder still lists ${notePath}`);
    const node = await listedNode(session, project, target);
    if (node === null) return unknown(`${reason}; the destination folder does not list ${target}`);
    const read = await readNode(session, project, node);
    if (read === null) return unknown(`${reason}; ${target} was listed but read NOT_FOUND`);
    if (sha256(read.text) === digest) return { form: 'written', filePath: target, checksum: read.checksum };
    return unknown(`${reason}; ${target} is not the note that was moved`, read.checksum);
  });
}

/** `bm_delete` of `notePath`. An uncertain delete is `written` when the folder no longer lists the file (checksum ''). */
export async function deleteNote(session: McpSession, project: string, notePath: string, expectedChecksum?: string): Promise<BmVerdict> {
  needBm(session, 'deleteNote');
  pathParts(notePath);
  const sent: Record<string, Json> = { identifier: notePath, output_format: 'json', project };
  if (expectedChecksum) sent['expected_checksum'] = expectedChecksum;
  return change(session, 'bm_delete', sent, async (reason) => {
    if ((await listedNode(session, project, notePath)) === null) return { form: 'written', filePath: notePath, checksum: '' };
    return unknown(`${reason}; its folder still lists ${notePath}`);
  });
}
