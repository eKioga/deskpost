/**
 * Which Notebook a kernel verb is looking at: the seat's own, or the shared tree ADR-0029 retires.
 *
 * ADR-0029 (S18). A seat carries its own Notebook at `notebook/<seat>/`; a topic is
 * `notebook/<seat>/<topic>/` and a seat's derived index is `notebook/<seat>/_master-index.md`. There is
 * no ownership record, no cross-seat topic lock and no shared master index: every topic under a seat's
 * root is that seat's by where it lives. The PowerShell implementation never carries any of this, and
 * `notebook-is-seat-owned` is the approved delta that compares the two.
 *
 * FOUR STATES, AND THE ONE THAT SAYS SO IS WRITTEN LAST. Seat roots and legacy topics share a
 * namespace -- a legacy topic may be named like a seat, and in the reader's own workspace two are -- so
 * no folder name can say which layout a workspace is in. `internal/notebook-layout.json` is what makes
 * the seat-owned layout ACTIVE; the migration writes it as its final act.
 *
 *   seat-owned  The layout record exists.
 *   migrating   No record, and a migration journal is neither complete nor rolled back. EVERY Notebook
 *               verb refuses and names `library migrate --resume` (the reader's ruling, S18): a
 *               half-moved Notebook answers every question wrongly.
 *   legacy      No record, and something a legacy writer produced is on disk: a topic or file under
 *               notebook/, a master index that is not the empty one, an ownership row, a quarantine.
 *               Writes refuse and name `library migrate` (the reader's ruling, S18); reads see the
 *               shared tree as it is.
 *   fresh       Nothing legacy at all. Treated as seat-owned, and ACTIVATED by the first write: there
 *               is nothing to migrate, so there is nothing to approve.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock, isBookLockHeld } from './locks.ts';

export const NOTEBOOK_LAYOUT_RECORD = 'internal/notebook-layout.json';
export const NOTEBOOK_MIGRATION_ROOT = 'internal/notebook-migration';
export const NOTEBOOK_LAYOUT_LOCK_ROOT = 'internal/notebook-layout';
export const SEAT_INDEX_NAME = '_master-index.md';
const SEAT_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The empty derived index, byte for byte what the legacy renderer writes over a Notebook with no topics. */
export const EMPTY_INDEX_TEXT = '# Notebook Index\n\nThis Notebook is ready for a new topic. Add topic folders here as material is compiled.\n';

export type NotebookLayoutState = 'seat-owned' | 'migrating' | 'legacy' | 'fresh';

export interface NotebookLayout {
  state: NotebookLayoutState;
  /** Why a legacy workspace is legacy: every legacy thing found, named. Empty unless `legacy`. */
  legacy: string[];
  record: Record<string, unknown> | null;
  migration_status: string;
}

function readJsonFile(file: string): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object.`);
  return parsed as Record<string, unknown>;
}

export function notebookLayoutRecordPath(workspace: string): string {
  return path.join(workspace, ...NOTEBOOK_LAYOUT_RECORD.split('/'));
}

export function migrationJournalPath(workspace: string): string {
  return path.join(workspace, ...NOTEBOOK_MIGRATION_ROOT.split('/'), 'journal.json');
}

/** The migration journal's status, or '' when there is none. FAILS CLOSED: an unreadable journal is a migration in an unknown state. */
export function migrationJournalStatus(workspace: string): string {
  const file = migrationJournalPath(workspace);
  if (!fs.existsSync(file)) return '';
  let journal: Record<string, unknown>;
  try {
    journal = readJsonFile(file);
  } catch (error) {
    throw new Error(
      `The Notebook migration journal at ${file} cannot be read: ${(error as Error).message}. Nothing can say how far that migration got, ` +
        'so no Notebook verb will act until it is repaired or restored from a backup.',
    );
  }
  return String(journal['status'] ?? '');
}

/** Whether a file holds the empty derived index, in any spelling a writer leaves: BOM or none, LF or CRLF. */
export function isEmptyIndexFile(file: string): boolean {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') === EMPTY_INDEX_TEXT;
}

/** Every legacy thing on disk, named. The shared tree's writers produce exactly these. */
export function legacyNotebookMaterial(workspace: string): string[] {
  const found: string[] = [];
  const notebook = path.join(workspace, 'notebook');
  if (fs.existsSync(notebook) && fs.statSync(notebook).isDirectory()) {
    for (const item of fs.readdirSync(notebook, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (item.name === SEAT_INDEX_NAME && item.isFile()) {
        if (!isEmptyIndexFile(path.join(notebook, item.name))) found.push('notebook/_master-index.md lists topics (the shared master index)');
        continue;
      }
      found.push(item.isDirectory() ? `notebook/${item.name}/ (a topic in the shared tree)` : `notebook/${item.name} (a file directly under notebook/)`);
    }
  }
  const owners = path.join(workspace, 'internal', 'notebook-topic-owners.json');
  if (fs.existsSync(owners)) {
    let rows = -1;
    try {
      const parsed = readJsonFile(owners);
      const topics = parsed['topics'];
      rows = Array.isArray(topics) ? topics.length : topics === null || topics === undefined ? 0 : 1;
    } catch {
      rows = -1;
    }
    if (rows !== 0) found.push(rows < 0 ? 'internal/notebook-topic-owners.json (unreadable)' : `internal/notebook-topic-owners.json (${rows} ownership row(s))`);
  }
  const quarantine = path.join(workspace, 'internal', 'notebook-reset-quarantine');
  if (fs.existsSync(quarantine)) {
    const held = fs.readdirSync(quarantine, { withFileTypes: true }).filter((item) => item.isDirectory()).length;
    if (held) found.push(`internal/notebook-reset-quarantine/ (${held} quarantine(s) made under the shared layout)`);
  }
  return found;
}

export function readNotebookLayout(workspace: string): NotebookLayout {
  const recordFile = notebookLayoutRecordPath(workspace);
  // AN UNFINISHED JOURNAL OUTRANKS THE RECORD. The record is written by the migration's last step but
  // one, so a run that died between writing it and closing its journal has a record and is still not
  // finished -- and reading that as active would let writes land in a Notebook still being moved.
  const journalStatus = migrationJournalStatus(workspace);
  if (journalStatus === 'in-progress') return { state: 'migrating', legacy: [], record: null, migration_status: journalStatus };
  if (fs.existsSync(recordFile)) {
    let record: Record<string, unknown>;
    try {
      record = readJsonFile(recordFile);
    } catch (error) {
      throw new Error(`The Notebook layout record at ${recordFile} cannot be read: ${(error as Error).message}. Repair it before any Notebook verb runs.`);
    }
    if (String(record['layout'] ?? '') !== 'seat-owned') {
      throw new Error(`The Notebook layout record at ${recordFile} names layout '${String(record['layout'] ?? '')}'; this kernel knows only 'seat-owned'.`);
    }
    return { state: 'seat-owned', legacy: [], record, migration_status: migrationJournalStatus(workspace) };
  }
  const status = migrationJournalStatus(workspace);
  if (status && status !== 'complete' && status !== 'rolled-back') return { state: 'migrating', legacy: [], record: null, migration_status: status };
  const legacy = legacyNotebookMaterial(workspace);
  return { state: legacy.length ? 'legacy' : 'fresh', legacy, record: null, migration_status: status };
}

export function migratingRefusal(operation: string): string {
  return (
    `${operation} refused: a Notebook migration is in progress and has not completed. Until it completes or is rolled back, ` +
    "no Notebook verb acts, because a half-moved Notebook answers every question wrongly. Run 'library migrate --resume' to finish it " +
    "or 'library migrate --rollback' to put the shared layout back; 'library migrate --preflight' says how far it got."
  );
}

export function legacyRefusal(operation: string, layout: NotebookLayout): string {
  const shown = layout.legacy.slice(0, 4).join('; ');
  const more = layout.legacy.length > 4 ? `; and ${layout.legacy.length - 4} more` : '';
  return (
    `${operation} refused: this workspace's Notebook is still in the shared layout ADR-0029 retires, and this kernel writes only a seat's own ` +
    `Notebook. Found: ${shown}${more}. Run 'library migrate --preflight' to see every legacy item and the disposition each needs; ` +
    'nothing is moved until that migration is approved, and the PowerShell tools keep working on the shared layout until then.'
  );
}

/** A Notebook root: the seat's own under ADR-0029, or the shared tree a legacy workspace still has. */
export interface NotebookScope {
  workspace: string;
  layout: 'seat-owned' | 'legacy';
  /** True when the workspace is `fresh` and the first write will activate the seat-owned layout. */
  activates: boolean;
  seat: string | null;
  root: string;
  /** `notebook/<seat>` or `notebook`, forward slashes, for every path a verb reports. */
  relative: string;
}

export function seatNotebookRelative(seat: string): string {
  if (!SEAT_SLUG.test(seat)) throw new Error(`'${seat}' is not a seat slug, so it names no Notebook root.`);
  return `notebook/${seat}`;
}

/**
 * The Notebook a verb acts on. A `write` on a legacy or migrating workspace refuses; a `read` on a
 * legacy or fresh one sees the shared tree as it is, and on a migrating one refuses, because the tree
 * is half-moved.
 * The seat-owned layout needs a seat -- a seatless session has no Notebook of its own to read.
 */
export function notebookScope(workspace: string, seat: string | null, purpose: 'read' | 'write', operation: string): NotebookScope {
  const layout = readNotebookLayout(workspace);
  if (layout.state === 'migrating') throw new Error(migratingRefusal(operation));
  if (layout.state === 'legacy') {
    if (purpose === 'write') throw new Error(legacyRefusal(operation, layout));
    return { workspace, layout: 'legacy', activates: false, seat: null, root: path.join(workspace, 'notebook'), relative: 'notebook' };
  }
  // A FRESH WORKSPACE IS STILL THE SHARED TREE ON DISK until its first write activates the seat-owned
  // layout, and a read describes what is on disk: the empty shared index, and nothing else. Reading a
  // seat root that does not exist yet would report less than is there.
  if (layout.state === 'fresh' && purpose === 'read') {
    return { workspace, layout: 'legacy', activates: false, seat: null, root: path.join(workspace, 'notebook'), relative: 'notebook' };
  }
  if (!seat) {
    throw new Error(
      `${operation} refused: under ADR-0029 the Notebook belongs to a seat, and this session names none. Name one with --seat or ` +
        'LIBRARY_SEAT; a seatless session reads the Library\'s own files and no seat\'s Notebook.',
    );
  }
  const relative = seatNotebookRelative(seat);
  return { workspace, layout: 'seat-owned', activates: layout.state === 'fresh', seat, root: path.join(workspace, ...relative.split('/')), relative };
}

/** Write the layout record. The one act that makes the seat-owned layout active. */
export function writeNotebookLayoutRecord(workspace: string, activatedBy: 'fresh-workspace' | 'migration', planId: string | null): void {
  const record: Record<string, PsJsonValue> = {
    schema: 1,
    layout: 'seat-owned',
    adr: 'ADR-0029',
    activated_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
    activated_by: activatedBy,
    migration_plan_id: planId,
  };
  writeAtomicText(notebookLayoutRecordPath(workspace), psConvertToJson(record) + '\n');
}

/**
 * Make a writable scope real before its first write. On a `fresh` workspace that means activating the
 * seat-owned layout -- under its own lock, re-reading the state inside it, so two first writers
 * activate it once -- and retiring the empty shared index, which is byte-equal to what deriving it from
 * nothing produces and so holds nothing to keep. Then the seat's root is created.
 */
export function prepareNotebookScopeForWrite(scope: NotebookScope, operation: string): void {
  if (scope.layout !== 'seat-owned') throw new Error(legacyRefusal(operation, readNotebookLayout(scope.workspace)));
  if (scope.activates) {
    const lock = isBookLockHeld(scope.workspace, NOTEBOOK_LAYOUT_LOCK_ROOT) ? null : enterBookLock(scope.workspace, NOTEBOOK_LAYOUT_LOCK_ROOT);
    try {
      const layout = readNotebookLayout(scope.workspace);
      if (layout.state === 'fresh') {
        const shared = path.join(scope.workspace, 'notebook', SEAT_INDEX_NAME);
        writeNotebookLayoutRecord(scope.workspace, 'fresh-workspace', null);
        if (fs.existsSync(shared) && isEmptyIndexFile(shared)) fs.rmSync(shared);
      } else if (layout.state !== 'seat-owned') {
        throw new Error(layout.state === 'migrating' ? migratingRefusal(operation) : legacyRefusal(operation, layout));
      }
    } finally {
      exitBookLock(lock);
    }
    scope.activates = false;
  }
  fs.mkdirSync(scope.root, { recursive: true });
}

/** Every seat root on disk under the seat-owned layout, sorted. */
export function seatNotebookRoots(workspace: string): string[] {
  const notebook = path.join(workspace, 'notebook');
  if (!fs.existsSync(notebook)) return [];
  return fs
    .readdirSync(notebook, { withFileTypes: true })
    .filter((item) => item.isDirectory() && SEAT_SLUG.test(item.name))
    .map((item) => item.name)
    .sort();
}
