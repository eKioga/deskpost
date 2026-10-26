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
 * THE COMMAND LINE IS PARKED (kickoffs/s165 handback): a new top-level verb needs a probe in self-test section 8, which
 * the unit could not edit, so the verbs reach this module only from the self-test until a later unit registers them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { ensureDirectory, writeAtomicBytes, writeAtomicText } from './fsx.ts';
import { sha256OfBytes } from './sha.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { completeBookManifestGeneration, readBookManifestDirty, setBookManifestDirty, writeBookManifestGeneration } from './manifeststore.ts';
import { newBookManifestForCollectionBook } from './collectionbooks.ts';
import { newBookManifestForShelfBook } from './manifest.ts';
import { getShelfBook } from './shelfbook.ts';
import { getCaptureBook } from './triage.ts';
import { updateShelfNoteIndex } from './capture.ts';
import { invokeNotebookRender } from './notebook.ts';
import { notebookScope } from './notebooklayout.ts';
import type { UndoRegenerate } from './journal.ts';

const JOURNAL_DIRECTORIES = ['publication-journals', 'shelf-journals', 'triage-journals'];
const RECORD_DIRECTORY = 'undo';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
}

interface RecordPath {
  path: string;
  preimage_base64: string | null;
  target_base64: string | null;
  status: 'pending' | 'restoring' | 'restored';
}

interface UndoRecord {
  schema: 1;
  id: string;
  action: 'undo' | 'redo';
  journal_id: string;
  journal: string;
  operation_id: string;
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
  return full;
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

function allRecords(workspace: string): UndoRecord[] {
  const directory = recordsDirectory(workspace);
  if (!fs.existsSync(directory)) return [];
  const records: UndoRecord[] = [];
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    try {
      const record = readJson(path.join(directory, name)) as unknown as UndoRecord;
      if (record.schema === 1 && typeof record.id === 'string') records.push(record);
    } catch {
      /* an unreadable record is listed by doctor's reader, not here */
    }
  }
  return records;
}

function saveRecord(workspace: string, record: UndoRecord): void {
  record.updated_utc = new Date().toISOString();
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
  if (!Array.isArray(block.paths) || !Array.isArray(block.locks) || typeof block.operation_id !== 'string') {
    refuse(`The undo block in ${source.relative} is malformed. Nothing was changed.`);
  }
  return {
    operation_id: block.operation_id,
    kind: String(block.kind ?? ''),
    locks: block.locks.map(String),
    paths: block.paths as BlockPath[],
    evidence: Array.isArray(block.evidence) ? block.evidence : [],
    regenerates: Array.isArray(block.regenerates) ? block.regenerates : [],
    marker: block.marker ?? null,
  };
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
    for (const root of roots) held.push(enterBookLock(workspace, root, timeoutSeconds));
  } catch (error) {
    for (const lock of held.reverse()) exitBookLock(lock);
    refuse(`${(error as Error).message} Nothing was changed.`);
  }
  return held;
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
      setBookManifestDirty({ workspace, slug: item.slug, collection: item.collection, reason: `${record.action} ${record.journal_id}`, operationId: record.operation_id });
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
    const full = contained(workspace, item.path);
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
  if (marker.operationId !== record.operation_id) return `left: it belongs to ${marker.operationId ?? 'an operation that names no id'} (${marker.reason})`;
  fs.rmSync(marker.file, { force: true });
  return 'cleared';
}

/** The block a record carries so it can be reversed in turn: its preimages are the prior bytes, its targets the after state. */
function reversalBlock(record: UndoRecord): PsJsonValue {
  return {
    schema: 1,
    operation_id: record.operation_id,
    kind: record.kind,
    locks: record.locks,
    paths: record.paths.map((item) => ({ path: item.path, existed: item.preimage_base64 !== null, content_base64: item.preimage_base64, after_sha256: hashOf(item.target_base64) })),
    evidence: record.evidence as PsJsonValue,
    regenerates: record.regenerates as PsJsonValue,
    marker: record.marker as PsJsonValue,
  };
}

function run(workspace: string, id: string, action: 'undo' | 'redo', lockTimeout: number): Record<string, PsJsonValue> {
  const source = findSource(workspace, id);
  if (action === 'undo' && source.record?.action === 'undo') refuse(`${id} is an undo; put the write back with deskpost redo ${id}. Nothing was changed.`);
  if (action === 'redo' && source.record?.action !== 'undo') refuse(`${id} is not an undo record, so there is nothing to redo; deskpost redo takes the id deskpost undo printed. Nothing was changed.`);
  const block = blockOf(source);
  for (const item of block.paths) contained(workspace, item.path);
  const locks = takeLocks(workspace, block.locks, lockTimeout);
  try {
    pauseWhileHeld();
    const records = allRecords(workspace);
    let record = liveReversal(records, id);
    if (record !== null && record.action !== action) record = null;
    if (record !== null && record.state === 'done') {
      // ALREADY DONE: a retry after the last step finishes that step and says so.
      const marker = clearOwnMarker(workspace, record);
      return { schema: 1, operation: action === 'undo' ? 'Undo a journaled write' : 'Redo an undone write', id: record.id, journal: id, status: `already-${action === 'undo' ? 'undone' : 'redone'}`, state: 'done', marker };
    }

    // ANOTHER OPERATION'S DIRTY MARKER IS NEVER HIDDEN (kickoffs/s165 row 5): setting this run's over it, then committing,
    // would clear a failed writer's warning and leave Discovery describing what that writer half-changed.
    if (block.marker !== null) {
      const marker = readBookManifestDirty(workspace, block.marker.slug, block.marker.collection);
      if (marker !== null && marker.operationId !== record?.operation_id) {
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
        schema: 1,
        id: `${action}-${stamp}-${randomBytes(4).toString('hex')}`,
        action,
        journal_id: id,
        journal: source.relative,
        operation_id: `op-${randomBytes(8).toString('hex')}`,
        kind: block.kind,
        created_utc: now.toISOString(),
        updated_utc: now.toISOString(),
        state: 'started',
        locks: block.locks,
        marker: block.marker,
        regenerates: block.regenerates,
        evidence: block.evidence,
        paths: block.paths.map((item) => {
          const full = contained(workspace, item.path);
          return { path: item.path, preimage_base64: fs.existsSync(full) ? fs.readFileSync(full).toString('base64') : null, target_base64: item.existed ? item.content_base64 : null, status: 'pending' };
        }),
        undo: null,
      };
      record.undo = reversalBlock(record);
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
      setBookManifestDirty({ workspace, slug: record.marker.slug, collection: record.marker.collection, reason: `${action} ${id}`, operationId: record.operation_id });
    }

    // 3. EACH PATH, IN ORDER.
    const restored: PsJsonValue[] = [];
    for (let index = 0; index < record.paths.length; index += 1) {
      const item = record.paths[index]!;
      if (item.status !== 'restored') {
        item.status = 'restoring';
        saveRecord(workspace, record);
        const full = contained(workspace, item.path);
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
      if (own !== null && own.state !== 'done') {
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
 * For `doctor` (kickoffs/s165 row 5): each record left `started`, with the one command that resumes it, and each `done`
 * record whose own marker is still down, cleared here. A marker naming no record, or an unfinished one, is never cleared.
 */
export function incompleteUndos(workspace: string): string[] {
  return allRecords(workspace)
    .filter((record) => record.state !== 'done')
    .map((record) => `internal/${RECORD_DIRECTORY}/${record.id}.json (${record.action} of ${record.journal_id}) stopped before it finished; resume it with: deskpost ${record.action} ${record.journal_id}`);
}

export function clearLeftUndoMarkers(workspace: string): string[] {
  const cleared: string[] = [];
  for (const record of allRecords(workspace)) {
    if (record.state !== 'done' || record.marker === null) continue;
    const marker = readBookManifestDirty(workspace, record.marker.slug, record.marker.collection);
    if (marker === null || marker.operationId !== record.operation_id) continue;
    fs.rmSync(marker.file, { force: true });
    cleared.push(`the dirty marker of ${record.marker.collection === 'collection' ? 'collection/books' : 'shelf'}/${record.marker.slug} was the finished ${record.action} ${record.id}'s own, and is cleared`);
  }
  return cleared;
}
