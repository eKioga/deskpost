/**
 * `deskpost undo <journal-id>` and `deskpost redo <undo-id>`: a journaled write put back, and put back again
 * (kickoffs/s165 rows 2 and 3; PLAN-fewer-yeses.md Approach 2, "the undo contract").
 *
 * A STATE MACHINE WRITTEN TO DISK BEFORE IT TOUCHES ANYTHING. Under the locks the write held, every path the journal names
 * must still hold what the write left (`after_sha256`); one that does not was changed since, and the undo refuses, naming
 * the file and the later journal that touched it. Then the record `internal/undo/<id>.json` is written with `state:
 * started`, and per path its PREIMAGE (what is there now, the bytes redo needs, since a hash of the replacement cannot
 * rebuild it) and its TARGET (the journal's prior bytes, or absent). The Book's dirty marker goes down with this run's
 * operation id. Only then is each path restored, `restoring` and `restored` recorded around its atomic replacement; then
 * what the writer re-derived is re-derived (the Discovery manifest, a capture Book's reader map, the Notebook index),
 * each evidence record is marked `undone_by`, the record says `done`, and the marker is cleared only if it is still this
 * run's.
 *
 * A RETRY RECONCILES BY BYTES, NOT BY STATUS. A path equal to its target is restored whatever its status says (the
 * window between a replacement and its `restored` write); one equal to its preimage is pending; one equal to neither was
 * changed by someone else, and the retry refuses with its name.
 *
 * REDO IS THE SAME MACHINE RUN ON AN UNDO RECORD. Each record carries an `undo` block in the journal shape
 * (`journal.ts`), its preimages as the prior bytes and its targets' hashes as the after hashes, so a redo reverses an
 * undo, an undo reverses a redo, and both clear or set `undone_by` on the same evidence.
 *
 * THE COMMAND LINE (kickoffs/s166 row 2): `deskpost undo <journal-id>`, `deskpost undo --list` and `deskpost redo
 * <undo-id>` are entries in the verbs table (`verbs.ts`) and branches in `cli.ts`, each calling one export below; s165
 * had parked them until a unit could add their probes to self-test section 8.
 *
 * A JOURNAL IS DATA, NOT AN AUTHORITY (kickoffs/s167 row 1; the audit's B4). Before anything is taken, the block is
 * checked whole: its keys, their types, a writer kind this file knows, evidence only in the journal folders. The seat
 * that wrote it (`written_by_seat`) must be the seat running the undo; a block from before that field refuses. The
 * locks are derived from the paths (the Hub, Book, Shelf Book or Notebook topic each is in), never read from the block,
 * and a path in none of those refuses. Every path, the journal itself and the records folder must have no link in any
 * existing component, the Library's own ancestors included, at the time of the check; each path is checked again just
 * before its replacement. A hash in a journal is the hash the journal carries, not proof of who wrote it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { ensureDirectory, writeAtomicBytes, writeAtomicText } from './fsx.ts';
import { sha256OfBytes } from './sha.ts';
import { enterBookLock, enterSeatRegistryLock, exitBookLock, type BookLock } from './locks.ts';
import { bookManifestStorePath, completeBookManifestGeneration, readBookManifestDirty, setBookManifestDirty, writeBookManifestGeneration } from './manifeststore.ts';
import { newBookManifestForCollectionBook } from './collectionbooks.ts';
import { newBookManifestForShelfBook } from './manifest.ts';
import { getShelfBook } from './shelfbook.ts';
import { getCaptureBook } from './triage.ts';
import { updateShelfNoteIndex } from './capture.ts';
import { invokeNotebookRender } from './notebook.ts';
import { notebookScope, seatNotebookRelative } from './notebooklayout.ts';
import type { UndoRegenerate } from './journal.ts';
import { linkedComponent } from './vault.ts';
import { deskEntriesForSeat, resolveSeatName } from './seatdesk.ts';
import { parseBookRoot } from './places.ts';
import { readSeatIdentityView, seatIncarnation, SEAT_ID_PATTERN } from './seatincarnation.ts';

const JOURNAL_DIRECTORIES = ['publication-journals', 'shelf-journals', 'triage-journals'];
const RECORD_DIRECTORY = 'undo';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The writers that keep an undo block (kickoffs/s165 row 1), by the `kind` each writes. */
const KINDS = ['hub-edit', 'hub-tidy', 'collection-replace-page', 'triage-review', 'triage-hold', 'triage-notebook'];
const EVIDENCE = /^internal\/(?:publication-journals|triage-journals)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const SEAT = /^[a-z0-9][a-z0-9-]*$/;
/** The order every writer takes its locks in: the Hub or Book, then the seat's Notebook, then the topic. */
const LOCK_ORDER = ['projects/', 'books/', 'shelf/', 'notebook-seat/', 'notebook/'];

class UndoRefusal extends Error {}

function refuse(message: string): never {
  throw new UndoRefusal(message);
}

interface BlockPath {
  path: string;
  existed: boolean;
  content_base64: string | null;
  after_sha256: string | null;
}

interface Block {
  operation_id: string;
  kind: string;
  locks: string[];
  paths: BlockPath[];
  evidence: { path: string; kind: string }[];
  regenerates: UndoRegenerate[];
  marker: { collection: 'shelf' | 'collection'; slug: string } | null;
  written_by_seat: string | null;
  written_by_seat_id: string | null;
}

interface RecordPath {
  path: string;
  preimage_base64: string | null;
  target_base64: string | null;
  status: 'pending' | 'restoring' | 'restored';
}

interface UndoRecord {
  schema: 2;
  id: string;
  action: 'undo' | 'redo';
  journal_id: string;
  journal: string;
  operation_id: string;
  marker_operation_id: string;
  kind: string;
  created_utc: string;
  updated_utc: string;
  state: 'started' | 'done';
  locks: string[];
  marker: Block['marker'];
  regenerates: UndoRegenerate[];
  evidence: Block['evidence'];
  paths: RecordPath[];
  undo: PsJsonValue;
}

interface Source {
  id: string;
  file: string;
  relative: string;
  json: Record<string, unknown>;
  /** An undo or redo record, rather than a writer's journal. */
  record: UndoRecord | null;
}

/** A test seam, named in the self-test sections that use it (497 to 499): where to stop, as a crash would. */
function fault(point: string): void {
  if ((process.env['LIBRARY_UNDO_FAULT'] ?? '').trim() === point) throw new Error(`FAULT INJECTED ${point} (a real run never stops here)`);
}

/** A test seam (section 495): hold the locks until the named file is gone, saying so with `<file>.held`. */
function pauseWhileHeld(): void {
  const file = (process.env['LIBRARY_UNDO_PAUSE_FILE'] ?? '').trim();
  if (!file) return;
  fs.writeFileSync(`${file}.held`, String(process.pid));
  const deadline = Date.now() + 60_000;
  while (fs.existsSync(file) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
}

function relativeOf(workspace: string, file: string): string {
  return path.relative(workspace, file).replace(/\\/g, '/');
}

/** A path the journal names, inside the Library, or a refusal: a journal is data, and never sends a write elsewhere. */
function contained(workspace: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    refuse(`The journal names a path that is not a plain path inside this Library: ${JSON.stringify(relative)}. Nothing was changed.`);
  }
  const full = path.resolve(workspace, ...relative.split('/'));
  const back = path.relative(path.resolve(workspace), full);
  if (back.startsWith('..') || path.isAbsolute(back)) refuse(`The journal names a path outside this Library: ${relative}. Nothing was changed.`);
  spelledAsOnDisk(workspace, relative);
  return full;
}

/**
 * ONE SPELLING PER FILE (kickoffs/s168 row 1; the s167 second reader's finding 6). A lock is named from the path's text,
 * so a journal path that reaches its file by another spelling (an 8.3 short name) would take another lock than the
 * writer's. Each existing component below the Library must be a name its folder lists; case is compared blind on
 * Windows, whose folders do not tell cases apart. A component that does not exist yet ends the comparison.
 */
function spelledAsOnDisk(workspace: string, relative: string): void {
  let folder = path.resolve(workspace);
  for (const part of relative.split('/')) {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return;
    }
    const listed = names.includes(part) ? part : process.platform === 'win32' ? names.find((name) => name.toLowerCase() === part.toLowerCase()) : undefined;
    if (listed === undefined) {
      if (!fs.existsSync(path.join(folder, part))) return;
      refuse(`The journal names ${relative}, and '${part}' is not a name its folder lists (an 8.3 short name, or another spelling), so a lock named from it would not be the writer's. Nothing was changed.`);
    }
    folder = path.join(folder, listed);
  }
}

function currentHash(full: string): string | null {
  return fs.existsSync(full) && fs.statSync(full).isFile() ? sha256OfBytes(fs.readFileSync(full)) : null;
}

function hashOf(base64: string | null): string | null {
  return base64 === null ? null : sha256OfBytes(Buffer.from(base64, 'base64'));
}

function recordsDirectory(workspace: string): string {
  return path.join(workspace, 'internal', RECORD_DIRECTORY);
}

/**
 * What is wrong with a record read from `internal/undo/<name>`, or null (kickoffs/s168 row 1; the s167 second reader's
 * finding 1). A record is data, checked as a journal's block is: the keys `saveRecord` writes and no others, each of its
 * type, and an `id` that is a plain name equal to the file's.
 */
function recordProblem(json: unknown, name: string): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'it is not an object';
  const record = json as Record<string, unknown>;
  if (record['schema'] === 1) return `it was written before reversals owned their markers, by an unreleased build; paths: ${JSON.stringify(Array.isArray(record['paths']) ? record['paths'].map(item => item?.path) : record['paths'])}; nothing was changed`;
  const keys = ['schema', 'id', 'action', 'journal_id', 'journal', 'operation_id', 'marker_operation_id', 'kind', 'created_utc', 'updated_utc', 'state', 'locks', 'marker', 'regenerates', 'evidence', 'paths', 'undo'];
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  if (extra !== undefined) return `it has a key undo never writes ('${extra}')`;
  const missing = keys.find((key) => !(key in record));
  if (missing !== undefined) return `it has no '${missing}'`;
  const base64 = (value: unknown) => value === null || (typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  if (record['schema'] !== 2) return 'its schema is not 2';
  if (typeof record['marker_operation_id'] !== 'string' || !/^op-[0-9a-f]{16}$/.test(record['marker_operation_id'])) return 'its marker_operation_id is not op- and 16 hex characters';
  if (typeof record['id'] !== 'string' || !ID.test(record['id']) || `${record['id']}.json` !== name) return 'its id is not a plain name equal to its file name';
  if (record['action'] !== 'undo' && record['action'] !== 'redo') return 'its action is not undo or redo';
  if (typeof record['journal_id'] !== 'string' || !ID.test(record['journal_id'])) return 'its journal_id is not a plain name';
  if (typeof record['journal'] !== 'string') return 'its journal is not text';
  if (typeof record['operation_id'] !== 'string' || !/^op-[0-9a-f]{16}$/.test(record['operation_id'])) return 'its operation_id is not op- and 16 hex characters';
  if (typeof record['kind'] !== 'string' || !KINDS.includes(record['kind'])) return 'its kind is not a writer that keeps an undo block';
  if (typeof record['created_utc'] !== 'string' || typeof record['updated_utc'] !== 'string') return 'its times are not text';
  if (record['state'] !== 'started' && record['state'] !== 'done') return 'its state is not started or done';
  if (!Array.isArray(record['locks']) || !record['locks'].every((item) => typeof item === 'string')) return 'its locks are not a list of text';
  if (record['marker'] !== null && (typeof record['marker'] !== 'object' || Array.isArray(record['marker']))) return 'its marker is not an object or null';
  if (!Array.isArray(record['regenerates']) || !Array.isArray(record['evidence'])) return 'its regenerates or evidence is not a list';
  if (record['undo'] !== null && (typeof record['undo'] !== 'object' || Array.isArray(record['undo']))) return 'its undo block is not an object or null';
  if (!Array.isArray(record['paths']) || !record['paths'].length) return 'it names no path';
  for (const [index, item] of (record['paths'] as unknown[]).entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return `path ${index + 1} is not an object`;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'path,preimage_base64,status,target_base64') return `path ${index + 1} has other keys than undo writes`;
    if (typeof entry['path'] !== 'string' || !base64(entry['preimage_base64']) || !base64(entry['target_base64'])) return `path ${index + 1} is not a path with its bytes`;
    if (!['pending', 'restoring', 'restored'].includes(String(entry['status']))) return `path ${index + 1}'s status is not one undo writes`;
  }
  return null;
}

/** The records that pass `recordProblem`; each that does not is added to `rejected`, with the journal it names if any. */
function allRecords(workspace: string, rejected: { name: string; journalId: unknown; why: string }[] = []): UndoRecord[] {
  const directory = recordsDirectory(workspace);
  if (!fs.existsSync(directory)) return [];
  const records: UndoRecord[] = [];
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    let json: unknown;
    try {
      json = readJson(path.join(directory, name));
    } catch {
      /* an unreadable record is listed by doctor's reader, not here */
      continue;
    }
    const why = recordProblem(json, name);
    if (why === null) records.push(json as UndoRecord);
    else rejected.push({ name, journalId: (json as Record<string, unknown> | null)?.['journal_id'], why });
  }
  return records;
}

/** Why a live record is not the reversal of `block`, or null: it restores exactly the block's paths, to its prior bytes. */
function recordDiffers(record: UndoRecord, block: Block): string | null {
  if (record.operation_id !== block.operation_id) return 'operation_id';
  if (record.kind !== block.kind) return 'kind';
  if (record.paths.length !== block.paths.length) return 'paths';
  for (const [index, item] of record.paths.entries()) {
    const expected = block.paths[index]!;
    if (item.path !== expected.path) return 'paths';
    if (item.target_base64 !== (expected.existed ? expected.content_base64 : null)) return `bytes for ${item.path}`;
    if (hashOf(item.preimage_base64) !== expected.after_sha256) return `preimage of ${item.path}`;
  }
  for (const key of ['marker', 'regenerates', 'evidence'] as const) {
    if (JSON.stringify(record[key]) !== JSON.stringify(block[key])) return key;
  }
  return null;
}

function saveRecord(workspace: string, record: UndoRecord): void {
  if (!ID.test(record.id)) refuse(`'${record.id}' is not a plain name, so no undo record is written for it. Nothing more was changed.`);
  record.updated_utc = new Date().toISOString();
  unlinked(recordsDirectory(workspace), 'the undo record', 'Nothing more was changed.');
  ensureDirectory(recordsDirectory(workspace));
  writeAtomicText(path.join(recordsDirectory(workspace), `${record.id}.json`), psConvertToJson(record as unknown as PsJsonValue));
}

/** The journal or record an id names, from the three journal folders or the records. */
function findSource(workspace: string, id: string): Source {
  if (!ID.test(id)) refuse(`'${id}' is not a journal id: give the journal's file name without .json. Nothing was changed.`);
  for (const directory of [...JOURNAL_DIRECTORIES, RECORD_DIRECTORY]) {
    const file = path.join(workspace, 'internal', directory, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    let json: Record<string, unknown>;
    try {
      json = readJson(file);
    } catch (error) {
      refuse(`internal/${directory}/${id}.json does not parse: ${(error as Error).message}. Nothing was changed.`);
    }
    const problem = directory === RECORD_DIRECTORY ? recordProblem(json, `${id}.json`) : null;
    if (problem !== null) refuse(`internal/${directory}/${id}.json is not a record deskpost writes (${problem}). Nothing was changed.`);
    const record = directory === RECORD_DIRECTORY ? (json as unknown as UndoRecord) : null;
    return { id, file, relative: relativeOf(workspace, file), json, record };
  }
  refuse(`No journal '${id}' in internal/publication-journals, internal/shelf-journals, internal/triage-journals or internal/undo. Nothing was changed.`);
}

/** The block, checked for shape; a journal without one names the writer that keeps none yet. */
function blockOf(source: Source): Block {
  const block = source.json['undo'] as Partial<Block> | undefined;
  if (block === undefined || block === null || typeof block !== 'object') {
    const operation = String(source.json['operation'] ?? '');
    const bookRoot = String(source.json['book_root'] ?? '');
    if (operation.startsWith('Replace page ') && bookRoot.startsWith('shelf/')) {
      refuse(`book replace-page writes no undo journal yet (journal ${source.id}); its restore line puts the page back. Nothing was changed.`);
    }
    refuse(`${operation || 'This write'} writes no undo journal yet: ${source.relative} records nothing undo can reverse. Nothing was changed.`);
  }
  const raw = block as Record<string, unknown>;
  if (!Array.isArray(raw) && !('written_by_seat' in raw)) {
    refuse(`${source.relative} predates the seat check: it records no writing seat, so no seat may undo or redo it. Nothing was changed.`);
  }
  if (!Array.isArray(raw) && !('written_by_seat_id' in raw)) {
    refuse(`${source.relative} predates the seat check: it records its writing seat by name and not by seat id, so no seat may undo or redo it. Nothing was changed.`);
  }
  const bad = (why: string): never => refuse(`The undo block in ${source.relative} is malformed: ${why}. Nothing was changed.`);
  const shaped = (value: unknown, keys: string[], what: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad(`${what} is not an object`);
    const found = value as Record<string, unknown>;
    for (const key of Object.keys(found)) if (!keys.includes(key)) bad(`${what} has a key no writer writes ('${key}')`);
    for (const key of keys) if (!(key in found)) bad(`${what} has no '${key}'`);
    return found;
  };
  const listOf = (value: unknown, what: string): unknown[] => (Array.isArray(value) ? value : bad(`${what} is not a list`));
  const slug = (value: unknown, what: string): string => (typeof value === 'string' && ID.test(value) ? value : bad(`${what} is not a plain name`));
  const top = shaped(block, ['schema', 'operation_id', 'kind', 'locks', 'paths', 'evidence', 'regenerates', 'marker', 'written_by_seat', 'written_by_seat_id'], 'the block');
  if (top['schema'] !== 1) bad('its schema is not 1');
  if (typeof top['operation_id'] !== 'string' || !/^op-[0-9a-f]{16}$/.test(top['operation_id'])) bad('its operation_id is not op- and 16 hex characters');
  if (typeof top['kind'] !== 'string' || !KINDS.includes(top['kind'])) bad(`its kind ${JSON.stringify(top['kind'])} is not a writer that keeps an undo block`);
  const seat = top['written_by_seat'];
  if (seat !== null && (typeof seat !== 'string' || !SEAT.test(seat))) bad('its written_by_seat is not a seat name or null');
  const seatId = top['written_by_seat_id'];
  if (seatId !== null && (typeof seatId !== 'string' || !SEAT_ID_PATTERN.test(seatId))) bad('its written_by_seat_id is not a seat id or null');
  const locks = listOf(top['locks'], 'locks').map((item) => (typeof item === 'string' ? item : bad('a lock is not text')));
  const paths = listOf(top['paths'], 'paths').map((item, index) => {
    const entry = shaped(item, ['path', 'existed', 'content_base64', 'after_sha256'], `path ${index + 1}`);
    if (typeof entry['path'] !== 'string') bad(`path ${index + 1} names no path`);
    if (typeof entry['existed'] !== 'boolean') bad(`path ${index + 1}'s existed is not true or false`);
    const content = entry['content_base64'];
    if (entry['existed'] ? typeof content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) : content !== null) bad(`path ${index + 1}'s prior bytes do not match whether it existed`);
    const after = entry['after_sha256'];
    if (after !== null && (typeof after !== 'string' || !/^[0-9a-f]{64}$/.test(after))) bad(`path ${index + 1}'s after_sha256 is not a hash or null`);
    return entry as unknown as BlockPath;
  });
  if (!paths.length) bad('it names no path');
  const evidence = listOf(top['evidence'], 'evidence').map((item, index) => {
    const entry = shaped(item, ['path', 'kind'], `evidence ${index + 1}`);
    if (typeof entry['path'] !== 'string' || !EVIDENCE.test(entry['path'])) bad(`evidence ${index + 1} is not a journal in internal/publication-journals or internal/triage-journals`);
    if (entry['kind'] !== 'publication-evidence' && entry['kind'] !== 'triage-batch-journal') bad(`evidence ${index + 1} is of no kind a writer records`);
    return entry as { path: string; kind: string };
  });
  const regenerates = listOf(top['regenerates'], 'regenerates').map((item, index): UndoRegenerate => {
    const kind = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['kind'] : undefined;
    const what = `regenerate ${index + 1}`;
    if (kind === 'manifest') {
      const entry = shaped(item, ['kind', 'collection', 'slug'], what);
      if (entry['collection'] !== 'shelf' && entry['collection'] !== 'collection') bad(`${what} names no collection`);
      return { kind, collection: entry['collection'] as 'shelf' | 'collection', slug: slug(entry['slug'], what) };
    }
    if (kind === 'shelf-note-index') return { kind, slug: slug(shaped(item, ['kind', 'slug'], what)['slug'], what) };
    if (kind === 'notebook-index') return { kind, seat: slug(shaped(item, ['kind', 'seat'], what)['seat'], what) };
    return bad(`${what} is of no kind a writer re-derives`);
  });
  let marker: Block['marker'] = null;
  if (top['marker'] !== null) {
    const entry = shaped(top['marker'], ['collection', 'slug'], 'the marker');
    if (entry['collection'] !== 'shelf' && entry['collection'] !== 'collection') bad('the marker names no collection');
    marker = { collection: entry['collection'] as 'shelf' | 'collection', slug: slug(entry['slug'], 'the marker') };
  }
  return { operation_id: top['operation_id'] as string, kind: top['kind'] as string, locks, paths, evidence, regenerates, marker, written_by_seat: seat as string | null, written_by_seat_id: seatId as string | null };
}

/**
 * The seat running this undo or redo, which must be the seat that wrote what it reverses: compared by the journal's
 * recorded seat id (kickoffs/s168 row 4), so a renamed seat keeps its writes and a new seat under a retired name gets
 * none of them. Both seats are named by their names now.
 */
function callerSeat(workspace: string, id: string, block: Block, action: 'undo' | 'redo'): { name: string; id: string } {
  const stateDirectory = path.join(workspace, '.claude');
  const resolved = resolveSeatName({ stateDirectory });
  if (resolved.status !== 'named') refuse(`deskpost ${action} checks that ${id} is this seat's own write, and no seat is named: ${resolved.message} Nothing was changed.`);
  if (block.written_by_seat === null) refuse(`${id} was written with no seat named, so no seat may ${action} it. Nothing was changed.`);
  if (block.written_by_seat_id === null) refuse(`${id} was written by seat '${block.written_by_seat}' with no seat id recorded, so no seat may ${action} it. Nothing was changed.`);
  const view = readSeatIdentityView(stateDirectory);
  const caller = seatIncarnation(stateDirectory, resolved.seat!, view).seatId;
  if (caller !== block.written_by_seat_id) {
    const writer = view.live.find((row) => row.identity === 'valid' && row.seatId === block.written_by_seat_id)?.seat;
    const named = writer ? `seat '${writer}'` : `seat '${block.written_by_seat}', which is no seat in the registry now`;
    refuse(`${id} was written by ${named}, and this session is seat '${resolved.seat}': a seat may ${action} only its own writes, judged by the journal's recorded seat id. Nothing was changed.`);
  }
  return { name: resolved.seat!, id: caller };
}

/**
 * The locks, from the paths alone: `collection/projects/<slug>/...` is the Hub's, `collection/books/<slug>/...` and
 * `shelf/<slug>/...` the Book's, and `notebook/<seat>/<topic>/...` the seat's Notebook and the topic's, for this seat
 * only. A path in none of them refuses, and so does a marker or re-derivation naming a Book none of the paths is in.
 */
function lockRootsOf(source: Source, block: Block, seat: string): string[] {
  const roots: string[] = [];
  const add = (root: string): void => {
    if (!roots.includes(root)) roots.push(root);
  };
  for (const item of block.paths) {
    const parts = item.path.split('/');
    if (parts[0] === 'collection' && (parts[1] === 'projects' || parts[1] === 'books') && parts.length >= 4) add(`${parts[1]}/${parts[2]}`);
    else if (parts[0] === 'shelf' && parts.length >= 3) add(`shelf/${parts[1]}`);
    else if (parts[0] === 'notebook' && parts[1] === seat && parts.length >= 4) {
      add(`notebook-seat/${seat}`);
      add(`notebook/${seat}/${parts[2]}`);
    } else refuse(`The journal names ${item.path}, which is outside every Hub, Book, Shelf Book and this seat's Notebook topics, the places a journaled write may change. Nothing was changed.`);
  }
  const needs = (root: string, what: string): void => {
    if (!roots.includes(root)) refuse(`The undo block in ${source.relative} names ${what}, which none of its paths is in. Nothing was changed.`);
  };
  const bookRoot = (collection: 'shelf' | 'collection', name: string) => (collection === 'collection' ? `books/${name}` : `shelf/${name}`);
  if (block.marker !== null) needs(bookRoot(block.marker.collection, block.marker.slug), `the marker of ${block.marker.slug}`);
  for (const item of block.regenerates) {
    if (item.kind === 'manifest') needs(bookRoot(item.collection, item.slug), `the manifest of ${item.slug}`);
    else if (item.kind === 'shelf-note-index') needs(`shelf/${item.slug}`, `the reader map of ${item.slug}`);
    else if (item.seat !== seat) refuse(`The undo block in ${source.relative} names the Notebook index of ${item.seat}, not this seat's. Nothing was changed.`);
  }
  const rank = (root: string) => LOCK_ORDER.findIndex((prefix) => root.startsWith(prefix));
  return roots.sort((left, right) => rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0));
}

/** The writers' per-seat active Desk check, before target reads and again while locked. */
function requireOpenTargets(workspace: string, seat: string, roots: string[], action: 'undo' | 'redo'): void {
  const state = path.join(workspace, '.claude');
  const projects = deskEntriesForSeat(state, seat, 'projects');
  const books = deskEntriesForSeat(state, seat, 'books').map(entry => parseBookRoot(entry));
  for (const root of roots) {
    const [kind, slug] = root.split('/');
    if (kind !== 'projects' && kind !== 'books' && kind !== 'shelf') continue;
    const project = kind === 'projects';
    if (project ? !projects.includes(root) : !books.some(entry => entry?.root === root)) {
      if (project && projects.includes(`archive/projects/${slug}`)) refuse(`Project '${slug}' is open from the archive shelf. Archived Project Hubs are read-only. Nothing was changed.`);
      if (!project && books.some(entry => entry !== null && entry.slug === slug && entry.shelf === 'archive' && entry.form === (kind === 'shelf' ? 'shelf' : 'books'))) refuse(`Book '${slug}' is open from the archive shelf, which is read-only. Nothing was changed.`);
      const open = project ? `project ${slug}` : `book ${slug} --location ${kind === 'shelf' ? 'shelf' : 'collection'}`;
      refuse(`${project ? 'Hub' : 'Book'} '${slug}' is not open on seat '${seat}''s Desk, so ${action} will not change it. Open it first: deskpost desk open ${open}. Nothing was changed.`);
    }
  }
}

/** `full`, or a refusal when any existing component of it, from its drive or file-system root down, is a link. */
function unlinked(full: string, named: string, tail = 'Nothing was changed.'): string {
  const linked = linkedComponent(full);
  if (linked !== null) refuse(`${linked} is a symbolic link or junction, so ${named} is not reached through it. ${tail}`);
  return full;
}

/** Every path a journal or record says it touched, workspace-relative. */
function touchedPaths(workspace: string, json: Record<string, unknown>): string[] {
  const found: string[] = [];
  const undo = json['undo'] as { paths?: { path?: unknown }[] } | undefined;
  for (const item of undo?.paths ?? []) if (typeof item.path === 'string') found.push(item.path);
  for (const entry of (json['entries'] as { path?: unknown }[] | undefined) ?? []) {
    if (typeof entry.path === 'string') found.push(relativeOf(workspace, entry.path));
  }
  if (typeof json['page_path'] === 'string') found.push(`collection/${json['page_path']}`);
  if (typeof json['notes_page_path'] === 'string') found.push(`collection/${json['notes_page_path']}`);
  return found;
}

/** The newest journal or record, other than `self`, written after it and touching `relative`; null when there is none. */
function laterJournal(workspace: string, relative: string, self: string, since: number): string | null {
  let best: { file: string; time: number } | null = null;
  for (const directory of [...JOURNAL_DIRECTORIES, RECORD_DIRECTORY]) {
    const root = path.join(workspace, 'internal', directory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter((item) => item.endsWith('.json'))) {
      const file = path.join(root, name);
      if (path.resolve(file) === path.resolve(self)) continue;
      const time = fs.statSync(file).mtimeMs;
      if (time < since || (best !== null && time <= best.time)) continue;
      try {
        if (touchedPaths(workspace, readJson(file)).includes(relative)) best = { file, time };
      } catch {
        /* an unreadable journal names nothing */
      }
    }
  }
  return best === null ? null : relativeOf(workspace, best.file);
}

/** The record that reverses `id` and has not itself been reversed, done or not; null when nothing does. */
function liveReversal(records: UndoRecord[], id: string): UndoRecord | null {
  const reversals = records.filter((record) => record.journal_id === id).sort((left, right) => (left.created_utc < right.created_utc ? 1 : -1));
  for (const record of reversals) {
    if (record.state !== 'done') return record;
    if (!records.some((other) => other.journal_id === record.id && other.state === 'done')) return record;
  }
  return null;
}

function takeLocks(workspace: string, roots: string[], timeoutSeconds: number): BookLock[] {
  const held: BookLock[] = [];
  try {
    // Keep the Desk open through restoration; take the registry before target locks and release it last.
    held.push(enterSeatRegistryLock(workspace, timeoutSeconds));
    for (const root of roots) held.push(enterBookLock(workspace, root, timeoutSeconds));
  } catch (error) {
    for (const lock of held.reverse()) exitBookLock(lock);
    refuse(`${(error as Error).message} Nothing was changed.`);
  }
  return held;
}

/**
 * THE FOLDERS THE DERIVED WRITES LAND IN, CHECKED AS THE RESTORED PATHS ARE (kickoffs/s168 row 3; the s167 second
 * reader's finding 3): a Book's manifest store (its dirty marker and generations), a capture Book's wiki (its reader map)
 * and a seat's Notebook root (its index). A link in any of them refuses before any derived write.
 */
function derivedUnlinked(workspace: string, block: Pick<Block, 'marker' | 'regenerates'>, tail: string): void {
  const store = (collection: 'shelf' | 'collection', slug: string) =>
    unlinked(path.join(bookManifestStorePath(workspace, slug, collection), 'generations'), `the Discovery manifest store of ${collection === 'collection' ? 'collection/books' : 'shelf'}/${slug}`, tail);
  if (block.marker !== null) store(block.marker.collection, block.marker.slug);
  for (const item of block.regenerates) {
    if (item.kind === 'manifest') store(item.collection, item.slug);
    else if (item.kind === 'shelf-note-index') unlinked(path.join(workspace, 'shelf', item.slug, 'wiki'), `the reader map of shelf/${item.slug}`, tail);
    else unlinked(path.join(workspace, ...seatNotebookRelative(item.seat).split('/')), `the Notebook index of ${item.seat}`, tail);
  }
}

function regenerate(workspace: string, record: UndoRecord): string[] {
  const done: string[] = [];
  for (const item of record.regenerates) {
    if (item.kind === 'notebook-index') {
      invokeNotebookRender(notebookScope(workspace, item.seat, 'write', `${record.action} ${record.journal_id}`));
      done.push(`the Notebook index of ${item.seat}`);
    } else if (item.kind === 'shelf-note-index') {
      updateShelfNoteIndex(getCaptureBook(workspace, item.slug));
      done.push(`the reader map of shelf/${item.slug}`);
    } else if (item.kind === 'manifest') {
      // THIS RUN'S MARKER IS DOWN, so the generation may be written; the commit clears it, as every writer's does.
      setBookManifestDirty({ workspace, slug: item.slug, collection: item.collection, reason: `${record.action} ${record.journal_id}`, operationId: record.marker_operation_id });
      const manifest = item.collection === 'collection' ? newBookManifestForCollectionBook(workspace, 'active', item.slug) : (newBookManifestForShelfBook(getShelfBook(workspace, item.slug)) as PsJsonValue);
      const written = writeBookManifestGeneration({ workspace, slug: item.slug, manifest, collection: item.collection });
      completeBookManifestGeneration({ workspace, slug: item.slug, generation: written.generation, collection: item.collection });
      done.push(`the Discovery manifest of ${item.collection === 'collection' ? 'collection/books' : 'shelf'}/${item.slug} (generation ${written.generation})`);
    }
  }
  return done;
}

/** `undone_by` set to this record (an undo) or cleared (a redo) on each evidence record; a missing one is reported. */
function markEvidence(workspace: string, record: UndoRecord): { marked: string[]; missing: string[] } {
  const marked: string[] = [];
  const missing: string[] = [];
  for (const item of record.evidence) {
    const full = unlinked(contained(workspace, item.path), item.path, 'Nothing more was changed.');
    if (!fs.existsSync(full)) {
      missing.push(item.path);
      continue;
    }
    const json = readJson(full);
    json['undone_by'] = record.action === 'undo' ? record.id : null;
    writeAtomicBytes(full, Buffer.from(psConvertToJson(json as PsJsonValue), 'utf8'));
    marked.push(item.path);
  }
  return { marked, missing };
}

/** The marker cleared only when it is this record's own; another operation's is left and named. */
function clearOwnMarker(workspace: string, record: UndoRecord): string {
  if (record.marker === null) return 'none';
  const marker = readBookManifestDirty(workspace, record.marker.slug, record.marker.collection);
  if (marker === null) return 'clear';
  if (marker.operationId !== record.marker_operation_id) return `left: it belongs to ${marker.operationId ?? 'an operation that names no id'} (${marker.reason})`;
  fs.rmSync(marker.file, { force: true });
  return 'cleared';
}

/** The block a record carries so it can be reversed in turn: its preimages are the prior bytes, its targets the after state. */
function reversalBlock(record: UndoRecord, seat: { name: string; id: string }): PsJsonValue {
  return {
    schema: 1,
    operation_id: record.operation_id,
    kind: record.kind,
    locks: record.locks,
    paths: record.paths.map((item) => ({ path: item.path, existed: item.preimage_base64 !== null, content_base64: item.preimage_base64, after_sha256: hashOf(item.target_base64) })),
    evidence: record.evidence as PsJsonValue,
    regenerates: record.regenerates as PsJsonValue,
    marker: record.marker as PsJsonValue,
    written_by_seat: seat.name,
    written_by_seat_id: seat.id,
  };
}

function run(workspace: string, id: string, action: 'undo' | 'redo', lockTimeout: number): Record<string, PsJsonValue> {
  // The journal's seat id is proved before this mapping is used; no other seat's paths move.
  const currentNotebook = <T extends { paths: { path: string }[]; regenerates: UndoRegenerate[] }>(value: T, former: string | null, current: string): T => {
    if (former === null || former === current) return value;
    const prefix = `notebook/${former}/`;
    return { ...value,
      paths: value.paths.map(item => ({ ...item, path: item.path.startsWith(prefix) ? `notebook/${current}/${item.path.slice(prefix.length)}` : item.path })),
      regenerates: value.regenerates.map(item => item.kind === 'notebook-index' && item.seat === former ? { ...item, seat: current } : item),
    };
  };
  const source = findSource(workspace, id);
  if (action === 'undo' && source.record?.action === 'undo') refuse(`${id} is an undo; put the write back with deskpost redo ${id}. Nothing was changed.`);
  if (action === 'redo' && source.record?.action !== 'undo') refuse(`${id} is not an undo record, so there is nothing to redo; deskpost redo takes the id deskpost undo printed. Nothing was changed.`);
  // Every link is checked down to a writer's journal before its block is used.
  const checkedBlock = (origin: Source): Block => {
    try {
      let anchor = origin;
      const chain: Source[] = [];
      const seen = new Set<string>();
      while (anchor.record !== null) {
        if (chain.length >= 64 || seen.has(anchor.relative)) throw new Error('record chain loops or exceeds 64 links');
        seen.add(anchor.relative);
        unlinked(anchor.file, anchor.relative);
        chain.push(anchor);
        anchor = findSource(workspace, anchor.record.journal_id);
      }
      unlinked(anchor.file, anchor.relative);
      let original = blockOf(anchor);
      for (const link of chain.reverse()) {
        const record = link.record!;
        const writer = callerSeat(workspace, anchor.id, original, action);
        const mapped = currentNotebook(original, original.written_by_seat, writer.name);
        const reversal = psConvertToJson(record.undo);
        if (record.journal !== anchor.relative ||
            record.action !== (anchor.record?.action === 'undo' ? 'redo' : 'undo') ||
            (recordDiffers(record, original) !== null && recordDiffers(record, mapped) !== null) ||
            (reversal !== psConvertToJson(reversalBlock(record, { name: original.written_by_seat!, id: writer.id })) &&
             reversal !== psConvertToJson(reversalBlock(record, writer)))) {
          throw new Error('not a recorded reversal');
        }
        original = blockOf(link);
        anchor = link;
      }
      return original;
    } catch {
      refuse(`${origin.relative} is not the recorded reversal of its journal. Nothing was changed.`);
    }
  };
  let block = source.record === null ? blockOf(source) : checkedBlock(source);
  const caller = callerSeat(workspace, id, block, action);
  const seat = caller.name;
  block = currentNotebook(block, block.written_by_seat, seat);
  const roots = lockRootsOf(source, block, seat);
  requireOpenTargets(workspace, seat, roots, action);
  unlinked(source.file, source.relative);
  for (const item of [...block.paths, ...block.evidence]) unlinked(contained(workspace, item.path), item.path);
  derivedUnlinked(workspace, block, 'Nothing was changed.');
  const locks = takeLocks(workspace, roots, lockTimeout);
  try {
    pauseWhileHeld();
    requireOpenTargets(workspace, seat, roots, action);
    derivedUnlinked(workspace, block, 'Nothing was changed.');
    const rejected: { name: string; journalId: unknown; why: string }[] = [];
    const records = allRecords(workspace, rejected);
    const planted = rejected.find((item) => item.journalId === id);
    if (planted !== undefined) {
      refuse(`internal/${RECORD_DIRECTORY}/${planted.name} names ${id} but is not a record deskpost writes (${planted.why}), so the ${action} will not run beside it. Nothing was changed.`);
    }
    let record = liveReversal(records, id);
    if (record !== null && block.written_by_seat !== seat) {
      record = currentNotebook(record, block.written_by_seat, seat);
      record.undo = reversalBlock(record, caller);
    }
    if (record !== null && record.action !== action) record = null;
    const differs = record === null ? null : recordDiffers(record, block);
    if (record !== null && differs !== null) {
      refuse(`internal/${RECORD_DIRECTORY}/${record.id}.json does not match ${source.relative}: its ${differs} differ from the journal's, so it is not used. Nothing was changed.`);
    }
    if (record !== null && record.state === 'done') {
      // ALREADY DONE: a retry after the last step finishes that step and says so.
      const marker = clearOwnMarker(workspace, record);
      return { schema: 1, operation: action === 'undo' ? 'Undo a journaled write' : 'Redo an undone write', id: record.id, journal: id, status: `already-${action === 'undo' ? 'undone' : 'redone'}`, state: 'done', marker };
    }

    // ANOTHER OPERATION'S DIRTY MARKER IS NEVER HIDDEN (kickoffs/s165 row 5): setting this run's over it, then committing,
    // would clear a failed writer's warning and leave Discovery describing what that writer half-changed.
    if (block.marker !== null) {
      const marker = readBookManifestDirty(workspace, block.marker.slug, block.marker.collection);
      if (marker !== null && marker.operationId !== record?.marker_operation_id) {
        const rebuild = block.marker.collection === 'collection' ? 'deskpost collection rebuild' : `deskpost shelf rebuild ${block.marker.slug}`;
        refuse(
          `${block.marker.collection === 'collection' ? 'collection/books' : 'shelf'}/${block.marker.slug} is marked dirty by another operation ` +
            `(${marker.operationId ?? 'one that names no id'}: ${marker.reason}), and this ${action} would hide that. Rebuild it with ${rebuild}, then run the ${action} again. Nothing was changed.`,
        );
      }
    }

    if (record === null) {
      // 1. STALE STATE IS REFUSED: every path must still hold what the write left.
      const since = fs.statSync(source.file).mtimeMs;
      for (const item of block.paths) {
        if (currentHash(contained(workspace, item.path)) !== item.after_sha256) {
          const later = laterJournal(workspace, item.path, source.file, since);
          refuse(`${item.path} changed after ${id} wrote it${later ? `: ${later} touched it since` : ', and no later journal names it'}. Nothing was changed.`);
        }
      }
      // 2. THE RECORD, BEFORE ANYTHING IS TOUCHED.
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
      record = {
        schema: 2,
        id: `${action}-${stamp}-${randomBytes(4).toString('hex')}`,
        action,
        journal_id: id,
        journal: source.relative,
        operation_id: block.operation_id,
        marker_operation_id: `op-${randomBytes(8).toString('hex')}`,
        kind: block.kind,
        created_utc: now.toISOString(),
        updated_utc: now.toISOString(),
        state: 'started',
        locks: roots,
        marker: block.marker,
        regenerates: block.regenerates,
        evidence: block.evidence,
        paths: block.paths.map((item) => {
          const full = contained(workspace, item.path);
          return { path: item.path, preimage_base64: fs.existsSync(full) ? fs.readFileSync(full).toString('base64') : null, target_base64: item.existed ? item.content_base64 : null, status: 'pending' };
        }),
        undo: null,
      };
      record.undo = reversalBlock(record, caller);
      saveRecord(workspace, record);
    } else {
      // A RETRY: each path judged by its bytes.
      for (const item of record.paths) {
        const now = currentHash(contained(workspace, item.path));
        if (now === hashOf(item.target_base64)) item.status = 'restored';
        else if (now === hashOf(item.preimage_base64)) item.status = 'pending';
        else refuse(`${item.path} was changed by someone else after ${record.id} began, so the ${action} cannot finish; ${record.journal} and that file are as they are. Nothing more was changed.`);
      }
      saveRecord(workspace, record);
    }
    if (record.marker !== null) {
      setBookManifestDirty({ workspace, slug: record.marker.slug, collection: record.marker.collection, reason: `${action} ${id}`, operationId: record.marker_operation_id });
    }

    // 3. EACH PATH, IN ORDER.
    const restored: PsJsonValue[] = [];
    for (let index = 0; index < record.paths.length; index += 1) {
      const item = record.paths[index]!;
      if (item.status !== 'restored') {
        item.status = 'restoring';
        saveRecord(workspace, record);
        // AGAIN JUST BEFORE THE REPLACEMENT: a folder made a link since the check is not followed.
        const full = unlinked(contained(workspace, item.path), item.path, 'Nothing more was changed.');
        if (item.target_base64 === null) {
          fs.rmSync(full, { force: true });
          const parent = path.dirname(full);
          if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
        } else {
          ensureDirectory(path.dirname(full));
          writeAtomicBytes(full, Buffer.from(item.target_base64, 'base64'));
        }
        if (currentHash(full) !== hashOf(item.target_base64)) refuse(`${item.path} did not read back as the ${action} wrote it.`);
        fault('after-replace');
        item.status = 'restored';
        saveRecord(workspace, record);
      }
      restored.push({ path: item.path, now: item.target_base64 === null ? 'absent' : 'restored' });
      if (index < record.paths.length - 1) fault('between-restores');
    }

    // 4 AND 5. WHAT THE WRITER RE-DERIVED, THEN THE EVIDENCE.
    fault('before-regenerate');
    // AGAIN JUST BEFORE THE DERIVED WRITES, as before each replacement.
    derivedUnlinked(workspace, record, 'Nothing more was changed.');
    const regenerated = regenerate(workspace, record);
    const evidence = markEvidence(workspace, record);

    // 6. DONE, THEN THIS RUN'S MARKER.
    record.state = 'done';
    saveRecord(workspace, record);
    fault('after-done');
    const marker = clearOwnMarker(workspace, record);
    return {
      schema: 1,
      operation: action === 'undo' ? 'Undo a journaled write' : 'Redo an undone write',
      id: record.id,
      journal: id,
      record: relativeOf(workspace, path.join(recordsDirectory(workspace), `${record.id}.json`)),
      status: action === 'undo' ? 'undone' : 'redone',
      state: 'done',
      paths: restored,
      regenerated,
      evidence_marked: evidence.marked,
      evidence_missing: evidence.missing,
      marker,
      next: action === 'undo' ? `To put the write back, run deskpost redo ${record.id}.` : `To undo it again, run deskpost undo ${record.id}.`,
    };
  } finally {
    for (const lock of locks.reverse()) exitBookLock(lock);
  }
}

export function undoJournal(workspace: string, journalId: string, options: { lockTimeout?: number } = {}): Record<string, PsJsonValue> {
  return run(workspace, journalId, 'undo', options.lockTimeout ?? 20);
}

export function redoUndo(workspace: string, undoId: string, options: { lockTimeout?: number } = {}): Record<string, PsJsonValue> {
  return run(workspace, undoId, 'redo', options.lockTimeout ?? 20);
}

/**
 * `deskpost undo --list`: the last day's journals that carry an undo block, and the records, each with a state:
 * restorable, stale (naming the later journal), undone (naming what reversed it), or incomplete (naming the record).
 */
export function undoList(workspace: string, now: Date = new Date()): Record<string, PsJsonValue> {
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const records = allRecords(workspace);
  const entries: Record<string, PsJsonValue>[] = [];
  for (const directory of [...JOURNAL_DIRECTORIES, RECORD_DIRECTORY]) {
    const root = path.join(workspace, 'internal', directory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter((item) => item.endsWith('.json')).sort()) {
      const file = path.join(root, name);
      const time = fs.statSync(file).mtimeMs;
      if (time < since) continue;
      let json: Record<string, unknown>;
      try {
        json = readJson(file);
      } catch {
        continue;
      }
      if (json['undo'] === undefined || json['undo'] === null) continue;
      const id = name.replace(/\.json$/, '');
      const own = directory === RECORD_DIRECTORY ? (json as unknown as UndoRecord) : null;
      const command = own?.action === 'undo' ? `deskpost redo ${id}` : `deskpost undo ${id}`;
      let state: string;
      let detail: string;
      const reversal = liveReversal(records, id);
      const problem = own === null ? null : recordProblem(json, name);
      if (problem !== null) {
        state = 'unavailable';
        detail = problem;
      } else if (own !== null && own.state !== 'done') {
        state = 'incomplete';
        detail = `resume it with deskpost ${own.action} ${own.journal_id}`;
      } else if (reversal !== null && reversal.state === 'done') {
        state = 'undone';
        detail = `by ${reversal.id}`;
      } else if (reversal !== null) {
        state = 'incomplete';
        detail = `${reversal.id} stopped before it finished; resume it with deskpost ${reversal.action} ${id}`;
      } else {
        let stale: string | null = null;
        for (const item of (json['undo'] as { paths?: BlockPath[] }).paths ?? []) {
          let full: string;
          try {
            full = contained(workspace, item.path);
          } catch {
            stale = `${item.path} is not a path inside this Library`;
            break;
          }
          if (currentHash(full) !== item.after_sha256) {
            const later = laterJournal(workspace, item.path, file, time);
            stale = `${item.path} changed since${later ? `, by ${later}` : ''}`;
            break;
          }
        }
        state = stale === null ? 'restorable' : 'stale';
        detail = stale === null ? command : stale;
      }
      entries.push({ id, kind: String((json['undo'] as { kind?: unknown }).kind ?? ''), journal: relativeOf(workspace, file), state, detail, time: new Date(time).toISOString() });
    }
  }
  entries.sort((left, right) => (String(left['time']) < String(right['time']) ? -1 : 1));
  return {
    schema: 1,
    operation: 'List the last day of undoable writes',
    count: entries.length,
    entries: entries as PsJsonValue,
    lines: entries.map((entry) => `${entry['id']}  ${entry['kind']}  ${entry['state']}: ${entry['detail']}`),
  };
}

/**
 * For doctor: unfinished records name their retry; old or malformed records name their refusal. Doctor never clears
 * markers: only the validated reversal, under its locks, may clear its own unique marker (c68-r4 row 2).
 */
export function incompleteUndos(workspace: string): string[] {
  const rejected: { name: string; journalId: unknown; why: string }[] = [];
  const incomplete = allRecords(workspace, rejected)
    .filter((record) => record.state !== 'done')
    .map((record) => `internal/${RECORD_DIRECTORY}/${record.id}.json (${record.action} of ${record.journal_id}) stopped before it finished; resume it with: deskpost ${record.action} ${record.journal_id}`);
  return [...incomplete, ...rejected.map(item => `internal/${RECORD_DIRECTORY}/${item.name}: ${item.why}`)];
}

/** Historical export name retained for doctor; this is a read, never a cleanup. */
export function clearLeftUndoMarkers(workspace: string): string[] {
  const left: string[] = [];
  for (const record of allRecords(workspace)) {
    if (record.marker === null) continue;
    const marker = readBookManifestDirty(workspace, record.marker.slug, record.marker.collection);
    if (marker === null || marker.operationId !== record.marker_operation_id) continue;
    left.push(`the dirty marker of ${record.marker.collection === 'collection' ? 'collection/books' : 'shelf'}/${record.marker.slug} names ${record.id}; left in place; finish it with deskpost ${record.action} ${record.journal_id}`);
  }
  return left;
}
