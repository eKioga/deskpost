/**
 * `deskpost seat rename <old> <new>` (PLAN-seat-identity.md section 2; kickoffs/s109 ruling 8; ADR-0072).
 *
 * A SEAT IS RENAMED BY ITS ID, ONE SEAT PER RUN. Its `seat_id` never changes; its name is a label with a history. The
 * rename moves the seat's state folder `.claude/seats/<old>/` and, when it exists, its Notebook root `notebook/<old>/`;
 * edits the `seat` key of exactly four files in the folder; sets the registry row's `seat` and extends its `names`. The
 * Project and its Hub never change, and nothing else under the folder is touched byte for byte.
 *
 * GATED: a preflight that names every refusal and writes nothing, and an apply bound to its plan id. THE BARRIER: the
 * apply first writes `internal/seat-rename-journals/<seat_id>.json`; while it stands at `in-progress`, every verb that
 * acts at that seat, by either name, refuses (the resolver in `seatpaths.ts`). Each mutation is recorded with its
 * before-image and expected after-image, so a run stopped anywhere is classified mutation by mutation on recovery:
 * `--resume` finishes it, `--rollback` restores the seat's folder, its Notebook root and its registry row byte for byte,
 * and a mutation that is neither refuses, naming the target and both hashes. THE POINT OF NO RETURN is the journal's
 * `committed-maps-pending` state: after it, `--rollback` refuses (undo by renaming back) and `--resume` does only the
 * letters maps. The registry is restored or completed ROW BY ROW, so another seat's change made meanwhile survives.
 *
 * LOCK ORDER: the registry lock, then the seat's Notebook lock, then the barrier. Both are held from the barrier to the
 * commit point and released there; the letters maps are written after, each under its own Book's lock.
 *
 * A FAULT FOR THE SELF-TEST ONLY: `LIBRARY_SEAT_RENAME_FAULT=<point>` stops a run at that point, as a crash would. A
 * real run never sets it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { requireWorkspace } from './workspace.ts';
import { enterSeatRegistryLock, exitBookLock, type BookLock } from './locks.ts';
import { readRegistryRows, registryFilePath, writeSeatRegistry } from './seatregistry.ts';
import { getSeatClaimState } from './seatclaim.ts';
import { captureBookRows, readSeatRetirementRecords } from './desk.ts';
import { readNotebookLayout, notebookScope } from './notebooklayout.ts';
import { invokeNotebookRender } from './notebook.ts';
import { appendHistoryCommit, appendHistoryRecords, readSeatHistory } from './seathistory.ts';
import { seatConversationRecord } from './conversation.ts';
import { assertSeatNameFree } from './seat.ts';
import { SEAT_SLUG_PATTERN } from './seatdesk.ts';
import { shelfNotes } from './shelfnote.ts';
import { regenerateCaptureMap } from './capture.ts';
import { enterSeatNotebookLock, seatRenameJournalDirectory, seatRenameJournals } from './seatpaths.ts';
import { writeAtomicText } from './fsx.ts';

export class SeatRenameRefusal extends Error {}

function refuse(message: string): never {
  throw new SeatRenameRefusal(message);
}

const SEAT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** The four files whose `seat` key names the seat; everything else in the folder is untouched. */
const EDITED_FILES = ['binding.json', 'activity.json', 'conversations.json', 'holder-attempt.json'];
const TEMP_SUFFIX = '.rename-tmp';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function utcNow(): string {
  return new Date().toISOString();
}

/** Stops a run at a named point, as a crash would. The self-test's alone. */
function fault(point: string): void {
  if ((process.env['LIBRARY_SEAT_RENAME_FAULT'] ?? '').trim() === point) {
    throw new Error(`FAULT INJECTED at ${point} (a real run never reaches this).`);
  }
}

/** A canonical form of a registry row, so two equal rows compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Every file under a directory, relative with forward slashes, and its sha256. A missing directory is empty. */
function treeDigest(directory: string): string[] {
  const lines: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(at, entry.name);
      if (entry.isSymbolicLink()) refuse(`${full} is a link; a rename moves only what lives in this Library. Nothing was renamed.`);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path.relative(directory, full).split(path.sep).join('/')} ${sha256(fs.readFileSync(full))}`);
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return lines;
}

// --- the journal ------------------------------------------------------------------------------------------------------

interface MoveMutation {
  kind: 'move';
  target: 'seat-folder' | 'notebook-root';
  from: string;
  to: string;
}
interface EditMutation {
  kind: 'edit';
  /** The file's name inside the seat folder; it is edited after the folder moves, so at `<new>/`. */
  file: string;
  before_sha256: string;
  after_sha256: string;
  before: string;
  after: string;
}
interface RenderMutation {
  kind: 'render';
}
interface HistoryMutation {
  kind: 'history-record';
}
interface RegistryMutation {
  kind: 'registry-row';
  before: Record<string, PsJsonValue>;
  after: Record<string, PsJsonValue>;
}
type Mutation = MoveMutation | EditMutation | RenderMutation | HistoryMutation | RegistryMutation;

interface RenameJournal {
  schema: 1;
  operation: 'Rename a seat';
  seat_id: string;
  old: string;
  new: string;
  attempt: string;
  plan_id: string;
  started_utc: string;
  state: 'in-progress' | 'committed-maps-pending';
  undo: boolean;
  mutations: Mutation[];
  maps_pending: string[];
}

function journalPath(workspace: string, seatId: string): string {
  return path.join(seatRenameJournalDirectory(workspace), `${seatId}.json`);
}

function writeJournal(workspace: string, journal: RenameJournal): void {
  fs.mkdirSync(seatRenameJournalDirectory(workspace), { recursive: true });
  writeAtomicText(journalPath(workspace, journal.seat_id), JSON.stringify(journal, null, 2) + '\n');
}

function readJournal(file: string): RenameJournal {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as RenameJournal;
  } catch (error) {
    refuse(`The rename journal ${file} cannot be read (${(error as Error).message}). Nothing was changed; repair or move it by hand.`);
  }
}

/** The journal at a seat by either name, or null. */
function journalFor(workspace: string, name: string): RenameJournal | null {
  const found = seatRenameJournals(workspace).find((journal) => journal.old === name || journal.new === name);
  return found ? readJournal(found.file) : null;
}

/** A finished or rolled-back journal is kept, out of the barrier's reach, as the record of the attempt. */
function archiveJournal(workspace: string, journal: RenameJournal, outcome: 'done' | 'rolled-back'): void {
  const from = journalPath(workspace, journal.seat_id);
  const directory = path.join(seatRenameJournalDirectory(workspace), 'done');
  fs.mkdirSync(directory, { recursive: true });
  fs.renameSync(from, path.join(directory, `${journal.seat_id}-${journal.attempt}-${outcome}.json`));
}

// --- the classification ---------------------------------------------------------------------------------------------

type Classified = 'before' | 'after' | 'neither';

function rowById(stateDirectory: string, seatId: string): Record<string, PsJsonValue> | null {
  return readRegistryRows(registryFilePath(stateDirectory)).find((row) => String(row['seat_id'] ?? '') === seatId) ?? null;
}

function historyHasRecord(workspace: string, attempt: string): boolean {
  return readSeatHistory(workspace).records.some((record) => record.attempt === attempt && record.verb === 'seat rename');
}

function seatFolderOf(stateDirectory: string, name: string): string {
  return path.join(stateDirectory, 'seats', name);
}

/** Where a mutation stands now, judged from the disk alone. */
function classify(workspace: string, journal: RenameJournal, mutation: Mutation): { state: Classified; detail: string } {
  const stateDirectory = path.join(workspace, '.claude');
  switch (mutation.kind) {
    case 'move': {
      const from = path.join(workspace, ...mutation.from.split('/'));
      const to = path.join(workspace, ...mutation.to.split('/'));
      const fromThere = fs.existsSync(from);
      const toThere = fs.existsSync(to);
      if (fromThere && !toThere) return { state: 'before', detail: '' };
      if (!fromThere && toThere) return { state: 'after', detail: '' };
      return { state: 'neither', detail: `${mutation.from} and ${mutation.to} ${fromThere ? 'both exist' : 'are both missing'}` };
    }
    case 'edit': {
      // EDITED AFTER THE FOLDER MOVED, so before the move the file is still the old folder's, unedited.
      const moved = !fs.existsSync(seatFolderOf(stateDirectory, journal.old)) && fs.existsSync(seatFolderOf(stateDirectory, journal.new));
      const file = path.join(seatFolderOf(stateDirectory, moved ? journal.new : journal.old), mutation.file);
      const now = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : '(missing)';
      if (now === mutation.before_sha256) return { state: 'before', detail: '' };
      if (now === mutation.after_sha256 && moved) return { state: 'after', detail: '' };
      return { state: 'neither', detail: `${path.relative(workspace, file).split(path.sep).join('/')} is ${now}, expected ${mutation.before_sha256} before or ${mutation.after_sha256} after` };
    }
    case 'render':
      // DERIVED: the index is rebuilt from the topics on disk, so it is always safe to run again.
      return { state: 'before', detail: '' };
    case 'history-record':
      return { state: historyHasRecord(workspace, journal.attempt) ? 'after' : 'before', detail: '' };
    case 'registry-row': {
      const row = rowById(stateDirectory, journal.seat_id);
      if (row !== null && canonical(row) === canonical(mutation.before)) return { state: 'before', detail: '' };
      if (row !== null && canonical(row) === canonical(mutation.after)) return { state: 'after', detail: '' };
      return { state: 'neither', detail: `the registry row of seat id ${journal.seat_id} is ${row === null ? 'missing' : sha256(canonical(row))}, expected ${sha256(canonical(mutation.before))} before or ${sha256(canonical(mutation.after))} after` };
    }
  }
}

/** A write that is a temp file and one rename, with the self-test's stop between the two. */
function writeByRename(file: string, text: string, point: string): void {
  const temp = `${file}${TEMP_SUFFIX}`;
  fs.writeFileSync(temp, text, 'utf8');
  fault(point);
  fs.renameSync(temp, file);
}

/** A temp file a stopped run left in the seat folder is its own; it is removed before any recovery step. */
function removeTempFiles(stateDirectory: string, journal: RenameJournal): void {
  for (const name of [journal.old, journal.new]) {
    const folder = seatFolderOf(stateDirectory, name);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder)) if (entry.endsWith(TEMP_SUFFIX)) fs.rmSync(path.join(folder, entry), { force: true });
  }
}

// --- the steps ------------------------------------------------------------------------------------------------------

function doMutation(workspace: string, journal: RenameJournal, mutation: Mutation): void {
  const stateDirectory = path.join(workspace, '.claude');
  switch (mutation.kind) {
    case 'move':
      fs.renameSync(path.join(workspace, ...mutation.from.split('/')), path.join(workspace, ...mutation.to.split('/')));
      fault(`after-move:${mutation.target}`);
      return;
    case 'edit':
      writeByRename(path.join(seatFolderOf(stateDirectory, journal.new), mutation.file), mutation.after, `mid-edit:${mutation.file}`);
      fault(`after-edit:${mutation.file}`);
      return;
    case 'render':
      invokeNotebookRender(notebookScope(workspace, journal.new, 'write', 'Seat rename'));
      fault('after-render');
      return;
    case 'history-record':
      appendHistoryRecords(workspace, [
        {
          attempt: journal.attempt,
          when: utcNow(),
          verb: 'seat rename',
          seat: journal.new,
          seat_id: journal.seat_id,
          from_seat: null,
          plan_id: journal.plan_id,
          before: { seat: journal.old } as never,
          after: { seat: journal.new } as never,
        },
      ]);
      fault('after-history-record');
      return;
    case 'registry-row': {
      // ROW BY ROW: the other rows are read now, so a change another seat made meanwhile is kept.
      const rows = readRegistryRows(registryFilePath(stateDirectory));
      writeSeatRegistry(stateDirectory, rows.map((row) => (String(row['seat_id'] ?? '') === journal.seat_id ? mutation.after : row)));
      fault('after-registry');
      return;
    }
  }
}

function undoMutation(workspace: string, journal: RenameJournal, mutation: Mutation): void {
  const stateDirectory = path.join(workspace, '.claude');
  switch (mutation.kind) {
    case 'move':
      fs.renameSync(path.join(workspace, ...mutation.to.split('/')), path.join(workspace, ...mutation.from.split('/')));
      return;
    case 'edit':
      writeByRename(path.join(seatFolderOf(stateDirectory, journal.new), mutation.file), mutation.before, `mid-undo:${mutation.file}`);
      return;
    case 'render':
    case 'history-record':
      // The index is derived (rendered again below), and the history is append-only: a rollback appends its own line.
      return;
    case 'registry-row': {
      const rows = readRegistryRows(registryFilePath(stateDirectory));
      writeSeatRegistry(stateDirectory, rows.map((row) => (String(row['seat_id'] ?? '') === journal.seat_id ? mutation.before : row)));
      return;
    }
  }
}

/** The capture Books that take letters and hold one to, from or started by this seat, under either name or its id. */
function lettersBooksOf(workspace: string, journal: RenameJournal): string[] {
  const names = new Set([journal.old, journal.new]);
  return captureBookRows(workspace)
    .filter((book) => book.takesLetters)
    .filter((book) =>
      shelfNotes(book).some(
        (note) =>
          (note.forSeat !== null && names.has(note.forSeat)) ||
          (note.fromSeat !== null && names.has(note.fromSeat)) ||
          (note.originSeat !== null && names.has(note.originSeat)) ||
          note.forSeatId === journal.seat_id ||
          note.originSeatId === journal.seat_id,
      ),
    )
    .map((book) => book.slug);
}

/** Each Book's map regenerated from the state on disk now; each its own idempotent step. Returns the Books left. */
function regenerateMaps(workspace: string, slugs: string[]): { done: string[]; left: { slug: string; reason: string }[] } {
  const done: string[] = [];
  const left: { slug: string; reason: string }[] = [];
  for (const slug of slugs) {
    try {
      fault(`before-map:${slug}`);
      regenerateCaptureMap(workspace, slug);
      done.push(slug);
    } catch (error) {
      left.push({ slug, reason: (error as Error).message });
    }
  }
  return { done, left };
}

// --- the preflight --------------------------------------------------------------------------------------------------

interface RenamePlan {
  workspace: string;
  stateDirectory: string;
  old: string;
  new: string;
  seatId: string;
  undo: boolean;
  row: Record<string, PsJsonValue>;
  notebookRootExists: boolean;
  planId: string;
  edits: EditMutation[];
}

/** The `seat` key's value replaced in place, and nothing else of the file; null when the file does not carry it. */
function editedText(text: string, oldName: string, newName: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed['seat'] !== oldName) return null;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const after = text.replace(new RegExp(`("seat"\\s*:\\s*)"${escaped}"`), `$1"${newName}"`);
  try {
    const check = JSON.parse(after.replace(/^﻿/, '')) as Record<string, unknown>;
    if (check['seat'] !== newName || canonical({ ...check, seat: oldName }) !== canonical(parsed)) return null;
  } catch {
    return null;
  }
  return after;
}

function planRename(workspace: string, oldName: string, newName: string): RenamePlan {
  const stateDirectory = path.join(workspace, '.claude');
  if (!oldName || !newName) refuse('seat rename needs the seat\'s name and its new name: deskpost seat rename <old> <new>. Nothing was renamed.');
  if (oldName === newName) refuse(`Seat '${oldName}' already has that name. Nothing was renamed.`);
  if (!SEAT_SLUG_PATTERN.test(newName)) refuse(`Seat name '${newName}' is not a seat name: lowercase letters, digits and hyphens, starting with a letter or a digit. Nothing was renamed.`);
  const rows = readRegistryRows(registryFilePath(stateDirectory));
  const row = rows.find((candidate) => String(candidate['seat']) === oldName);
  if (!row) refuse(`There is no seat named '${oldName}' in this Library's registry. Nothing was renamed.`);
  const seatId = String(row['seat_id'] ?? '');
  if (!SEAT_ID_PATTERN.test(seatId) || rows.filter((candidate) => String(candidate['seat_id'] ?? '') === seatId).length !== 1) {
    refuse(`Seat '${oldName}' has no valid seat_id of its own (32 lowercase hex characters, unique), so it cannot be renamed by id. deskpost doctor names the fault. Nothing was renamed.`);
  }
  const claim = getSeatClaimState(stateDirectory, oldName).state;
  if (claim !== 'free') {
    refuse(`Seat '${oldName}' is ${claim}: a seat is renamed only while no session holds it. Close its session first. Nothing was renamed.`);
  }
  const unfinished = seatRenameJournals(workspace).find((journal) => journal.seat_id === seatId || [journal.old, journal.new].some((name) => name === oldName || name === newName));
  if (unfinished) {
    refuse(`An unfinished rename of seat '${unfinished.old}' to '${unfinished.new}' stands; run deskpost seat rename --resume ${unfinished.old} or --rollback ${unfinished.old} first. Nothing was renamed.`);
  }
  const layout = readNotebookLayout(workspace).state;
  if (layout === 'legacy' || layout === 'migrating') {
    refuse(`This Library's Notebook is ${layout === 'legacy' ? 'still in the shared layout' : 'being migrated'}, and a rename moves only a seat-owned Notebook root. Run deskpost migrate first. Nothing was renamed.`);
  }
  const retirement = readSeatRetirementRecords(workspace);
  if (retirement.faults.length) {
    refuse(`A retirement record cannot be read: ${retirement.faults.join('; ')}. Repair it, then rename. Nothing was renamed.`);
  }
  if (retirement.records.some((record) => record.seat === newName)) {
    refuse(`Seat name '${newName}' is a retired seat's name. A rename takes a name no seat has had. Choose another. Nothing was renamed.`);
  }
  // THE UNDO: the seat's immediately previous name, which is reserved for it, may be taken back.
  const names = Array.isArray(row['names']) ? (row['names'] as Record<string, PsJsonValue>[]) : [];
  const previous = names.length >= 2 ? String(names[names.length - 2]!['name'] ?? '') : '';
  const undo = previous === newName;
  if (!undo) assertSeatNameFree({ workspace, stateDirectory, rows, seat: newName });
  else if (rows.some((candidate) => String(candidate['seat']) === newName)) refuse(`Seat '${newName}' already exists. Nothing was renamed.`);
  const oldNotebook = path.join(workspace, 'notebook', oldName);
  const newNotebook = path.join(workspace, 'notebook', newName);
  if (fs.existsSync(oldNotebook) && (fs.lstatSync(oldNotebook).isSymbolicLink() || !fs.statSync(oldNotebook).isDirectory())) {
    refuse(`notebook/${oldName} is not this seat's own Notebook folder. Nothing was renamed.`);
  }
  if (fs.existsSync(newNotebook)) refuse(`notebook/${newName} already exists, and a rename never writes over another root. Nothing was renamed.`);
  if (fs.existsSync(seatFolderOf(stateDirectory, newName))) refuse(`.claude/seats/${newName} already exists. Nothing was renamed.`);
  const folder = seatFolderOf(stateDirectory, oldName);
  if (!fs.existsSync(folder)) refuse(`Seat '${oldName}' has no state folder at .claude/seats/${oldName}. Nothing was renamed.`);

  const edits: EditMutation[] = [];
  for (const file of EDITED_FILES) {
    const full = path.join(folder, file);
    if (!fs.existsSync(full)) continue;
    const before = fs.readFileSync(full, 'utf8');
    const after = editedText(before, oldName, newName);
    if (after === null) {
      // A FILE WITH NO `seat` KEY (or another seat's) IS LEFT AS IT IS: it names no seat to change.
      continue;
    }
    edits.push({ kind: 'edit', file, before_sha256: sha256(Buffer.from(before, 'utf8')), after_sha256: sha256(Buffer.from(after, 'utf8')), before, after });
  }

  const registryFile = registryFilePath(stateDirectory);
  const lines = [
    'action=seat-rename',
    `old=${oldName}`,
    `new=${newName}`,
    `seat_id=${seatId}`,
    `registry=${fs.existsSync(registryFile) ? sha256(fs.readFileSync(registryFile)) : ''}`,
    `row=${canonical(row)}`,
    `claim=${claim}`,
    ...treeDigest(folder).map((line) => `seat-file=${line}`),
    ...treeDigest(oldNotebook).map((line) => `notebook-file=${line}`),
  ];
  return {
    workspace,
    stateDirectory,
    old: oldName,
    new: newName,
    seatId,
    undo,
    row,
    notebookRootExists: fs.existsSync(oldNotebook),
    planId: `seat-rename-${sha256(lines.join('\n'))}`,
    edits,
  };
}

function nextLines(stateDirectory: string, oldName: string, newName: string): Record<string, PsJsonValue> {
  const record = seatConversationRecord(stateDirectory, newName);
  const resume = record.session_id
    ? record.assistant === 'codex'
      ? `deskpost seat start ${newName} --command codex --resume ${record.session_id}`
      : `deskpost seat start ${newName} --resume ${record.session_id}`
    : null;
  return {
    menu: `Pick ${newName} from the main menu (deskpost); it resumes the seat's recorded conversation.`,
    resume_command: resume,
    first_line: `You are now ${newName}, formerly ${oldName}.`,
    note: `Claude Code's live messages reach the seat by its session name, which becomes ${newName} at its next launch. Text outside Deskpost (other Hubs, memory notes, Kickoffs) still says ${oldName}.`,
  };
}

// --- apply, resume, rollback ----------------------------------------------------------------------------------------

/** Runs the remaining steps of a journal to the commit point, classifying each first. Locks are held by the caller. */
function runToCommit(workspace: string, journal: RenameJournal): void {
  const stateDirectory = path.join(workspace, '.claude');
  removeTempFiles(stateDirectory, journal);
  for (const mutation of journal.mutations) {
    const now = classify(workspace, journal, mutation);
    if (now.state === 'after') continue;
    if (now.state === 'neither') refuse(`The rename of '${journal.old}' to '${journal.new}' cannot go on: ${now.detail}. Nothing more was changed; repair it by hand or run --rollback.`);
    doMutation(workspace, journal, mutation);
  }
  // THE POINT OF NO RETURN.
  journal.state = 'committed-maps-pending';
  journal.maps_pending = lettersBooksOf(workspace, journal);
  writeJournal(workspace, journal);
  fault('after-committed-marker');
  if (!readSeatHistory(workspace).committed.has(journal.attempt)) appendHistoryCommit(workspace, journal.attempt);
  fault('after-commit-line');
}

/** After the commit point: the commit line if a stop lost it, then the letters maps, then the journal is archived. */
function finishMaps(workspace: string, journal: RenameJournal): { done: string[]; left: { slug: string; reason: string }[] } {
  if (!readSeatHistory(workspace).committed.has(journal.attempt)) appendHistoryCommit(workspace, journal.attempt);
  const maps = regenerateMaps(workspace, journal.maps_pending);
  if (maps.left.length) {
    journal.maps_pending = maps.left.map((row) => row.slug);
    writeJournal(workspace, journal);
  } else {
    archiveJournal(workspace, journal, 'done');
  }
  return maps;
}

function withRenameLocks<T>(workspace: string, name: string, body: () => T): T {
  const registry = enterSeatRegistryLock(workspace);
  let notebook: BookLock | null = null;
  try {
    notebook = enterSeatNotebookLock(workspace, name);
    return body();
  } finally {
    exitBookLock(notebook);
    exitBookLock(registry);
  }
}

function applyRename(plan: RenamePlan, approved: string): Record<string, PsJsonValue> {
  const { workspace } = plan;
  let journal: RenameJournal | null = null;
  withRenameLocks(workspace, plan.old, () => {
    // REVALIDATED UNDER THE LOCKS: the plan id binds the registry, the row, the claim and every file it would move.
    const current = planRename(workspace, plan.old, plan.new);
    if (current.planId !== approved) {
      refuse('The seat, its registry row, its claim or a file under its folder or its Notebook root changed since the preflight. Rerun --preflight and pass its exact plan_id. Nothing was renamed.');
    }
    const now = utcNow();
    const names = Array.isArray(current.row['names'])
      ? (current.row['names'] as Record<string, PsJsonValue>[]).map((span) => ({ ...span }))
      : [{ name: current.old, from_utc: String(current.row['created_utc'] ?? ''), to_utc: null }];
    const last = names[names.length - 1]!;
    last['to_utc'] = now;
    // NO NAME TWICE (session 1's rule for `names`): the undo takes back the previous name, so that name's earlier span
    // gives way to the new open one. The name given up stays in the list, reserved; the history file keeps every span.
    const kept = names.filter((span) => span['name'] !== current.new);
    names.length = 0;
    names.push(...kept, { name: current.new, from_utc: now, to_utc: null });
    const after: Record<string, PsJsonValue> = { ...current.row, seat: current.new, names: names as unknown as PsJsonValue };
    const mutations: Mutation[] = [
      { kind: 'move', target: 'seat-folder', from: `.claude/seats/${current.old}`, to: `.claude/seats/${current.new}` },
      ...current.edits,
      ...(current.notebookRootExists
        ? ([{ kind: 'move', target: 'notebook-root', from: `notebook/${current.old}`, to: `notebook/${current.new}` }, { kind: 'render' }] as Mutation[])
        : []),
      { kind: 'history-record' },
      { kind: 'registry-row', before: current.row, after },
    ];
    journal = {
      schema: 1,
      operation: 'Rename a seat',
      seat_id: current.seatId,
      old: current.old,
      new: current.new,
      attempt: randomUUID().replace(/-/g, ''),
      plan_id: approved,
      started_utc: now,
      state: 'in-progress',
      undo: current.undo,
      mutations,
      maps_pending: [],
    };
    // THE BARRIER, before anything moves.
    writeJournal(workspace, journal);
    fault('after-journal');
    runToCommit(workspace, journal);
  });
  const maps = finishMaps(workspace, journal!);
  return renamedResult(plan.stateDirectory, journal!, maps, 'renamed');
}

function renamedResult(stateDirectory: string, journal: RenameJournal, maps: { done: string[]; left: { slug: string; reason: string }[] }, status: string): Record<string, PsJsonValue> {
  return {
    schema: 1,
    operation: 'Rename a seat',
    status,
    seat_id: journal.seat_id,
    old: journal.old,
    new: journal.new,
    undo: journal.undo,
    attempt: journal.attempt,
    letters_maps_regenerated: maps.done,
    letters_maps_left: maps.left as unknown as PsJsonValue,
    ...(maps.left.length ? { resume: `deskpost seat rename --resume ${journal.new}` } : {}),
    next: nextLines(stateDirectory, journal.old, journal.new),
    project_unchanged: true,
    shared_library_write: false,
  };
}

function resumeRename(workspace: string, name: string): Record<string, PsJsonValue> {
  const journal = journalFor(workspace, name);
  if (journal === null) refuse(`No rename of seat '${name}' is unfinished. Nothing was changed.`);
  if (journal.state === 'in-progress') withRenameLocks(workspace, journal.old, () => runToCommit(workspace, journal));
  const maps = finishMaps(workspace, journal);
  return renamedResult(path.join(workspace, '.claude'), journal, maps, 'resumed');
}

function rollbackRename(workspace: string, name: string): Record<string, PsJsonValue> {
  const journal = journalFor(workspace, name);
  if (journal === null) refuse(`No rename of seat '${name}' is unfinished. Nothing was changed.`);
  if (journal.state !== 'in-progress') {
    refuse(`The rename of '${journal.old}' to '${journal.new}' is committed; undo it with deskpost seat rename ${journal.new} ${journal.old}. To finish its letters maps, run --resume ${journal.new}. Nothing was changed.`);
  }
  const stateDirectory = path.join(workspace, '.claude');
  withRenameLocks(workspace, journal.old, () => {
    removeTempFiles(stateDirectory, journal);
    // EVERY MUTATION CLASSIFIED FIRST: one that is neither refuses before anything is restored.
    const states = journal.mutations.map((mutation) => ({ mutation, now: classify(workspace, journal, mutation) }));
    const stuck = states.find((row) => row.now.state === 'neither');
    if (stuck) refuse(`The rename of '${journal.old}' to '${journal.new}' cannot be rolled back: ${stuck.now.detail}. Nothing was restored; repair it by hand.`);
    for (const row of [...states].reverse()) if (row.now.state === 'after') undoMutation(workspace, journal, row.mutation);
    if (journal.mutations.some((mutation) => mutation.kind === 'render') && fs.existsSync(path.join(workspace, 'notebook', journal.old))) {
      invokeNotebookRender(notebookScope(workspace, journal.old, 'write', 'Seat rename rollback'));
    }
    if (historyHasRecord(workspace, journal.attempt)) {
      appendHistoryRecords(workspace, [
        {
          attempt: journal.attempt,
          when: utcNow(),
          verb: 'seat rename rolled back',
          seat: journal.old,
          seat_id: journal.seat_id,
          from_seat: null,
          plan_id: journal.plan_id,
          before: { seat: journal.new } as never,
          after: { seat: journal.old } as never,
        },
      ]);
    }
  });
  const maps = regenerateMaps(workspace, lettersBooksOf(workspace, journal));
  archiveJournal(workspace, journal, 'rolled-back');
  return {
    schema: 1,
    operation: 'Roll back a seat rename',
    status: 'rolled-back',
    seat_id: journal.seat_id,
    seat: journal.old,
    not_renamed_to: journal.new,
    attempt: journal.attempt,
    letters_maps_regenerated: maps.done,
    letters_maps_left: maps.left as unknown as PsJsonValue,
    shared_library_write: false,
  };
}

export function seatRenameResult(argv: string[]): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('seat', 'rename'));
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const resume = parsed.options.get('resume');
  const rollback = parsed.options.get('rollback');
  if (resume !== undefined && rollback !== undefined) refuse('--resume and --rollback are two recoveries, not one. Choose one. Nothing was changed.');
  if (resume !== undefined || rollback !== undefined) {
    if (parsed.positional.length) refuse(`--${resume !== undefined ? 'resume' : 'rollback'} takes the seat's name as its value, not '${parsed.positional.join(' ')}'. Nothing was changed.`);
    return resume !== undefined ? resumeRename(workspace, resume) : rollbackRename(workspace, rollback!);
  }
  const [oldName = '', newName = ''] = parsed.positional;
  const plan = planRename(workspace, oldName, newName);
  if (parsed.flags.has('preflight')) {
    return {
      schema: 1,
      operation: 'Rename a seat',
      seat_id: plan.seatId,
      old: plan.old,
      new: plan.new,
      undo: plan.undo,
      moves: [`.claude/seats/${plan.old}/ -> .claude/seats/${plan.new}/`, ...(plan.notebookRootExists ? [`notebook/${plan.old}/ -> notebook/${plan.new}/`] : [])],
      edits: plan.edits.map((edit) => `${edit.file}: seat ${plan.old} -> ${plan.new}`),
      untouched:
        'every other file in the seat folder, byte for byte (added-dirs.json, the inbound settings.json, .open-books, .open-projects, the claim files, and activity.json\'s message_name); the Project and its Hub; letters and Hub pages',
      registry: `the row of seat id ${plan.seatId}: seat ${plan.old} -> ${plan.new}, and its names history extended`,
      plan_id: plan.planId,
      confirmation_required: true,
      next: `deskpost seat rename ${plan.old} ${plan.new} --user-confirmed --plan-id ${plan.planId}`,
      shared_library_write: false,
    };
  }
  if (!parsed.flags.has('user-confirmed')) refuse('A rename is not yet performed: review the preflight and rerun with --user-confirmed --plan-id <id>. Nothing was renamed.');
  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('A rename needs the plan_id its --preflight issued: --user-confirmed --plan-id <id>. Nothing was renamed.');
  if (approved !== plan.planId) {
    refuse('The seat, its registry row, its claim or a file under its folder or its Notebook root changed since the preflight. Rerun --preflight and pass its exact plan_id. Nothing was renamed.');
  }
  return applyRename(plan, approved);
}

/** For `psConvertToJson` callers that print a rename's result as PowerShell would. */
export function seatRenameJson(value: Record<string, PsJsonValue>): string {
  return psConvertToJson(value);
}
