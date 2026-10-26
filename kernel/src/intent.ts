/**
 * THE INTENT RECORD (kickoffs/s143 row 5; PLAN-reports-across-libraries.md, "The intent record"): every operation that
 * touches more than one durable thing is driven by one record written first, before any other write, naming every
 * identity it will create (delivery ids and page names, derived before the first write), its full payload, and its
 * stages in order, each `pending` or `done` with what proved it. A stage checks its own proof before acting, so a retry
 * resumes the pending stages and creates nothing twice. A record is complete only when every stage is `done`.
 *
 * WHERE RECORDS LIVE. An outgoing operation's record is under `internal/postbox/outbox/`, an incoming one's under
 * `internal/postbox/applied/`, each `<delivery-id>.intent.json` and created `wx`. The `.intent.json` name keeps a record
 * apart from an outbox entry (`<delivery-id>.json`), which `readOutbox` takes only by that exact name.
 *
 * RECOVERY, AND THE ONE LOCK ORDER. `recover` lists the outstanding records, takes the locks of the Books their pending
 * stages touch in the order `reports` then `letters`, and lists again under them. When the fresh listing needs a lock it
 * does not hold, it releases every lock and takes the wider set in the same order, at most three passes, then refuses
 * naming the records. Only the listing taken under the final lock set is run. It never takes `reports` while holding
 * `letters`, and a stage writer is handed the held locks and never takes one itself (the locks are not reentrant).
 *
 * RESERVATIONS. A page name an outstanding record owns is never taken by another writer: `selectNoteFile` skips it
 * (`reservedPages`). Recovery proves a note by its `delivery_id`, never by its path: a note at a reserved path that does
 * not carry the record's id is a collision, refused by name and never overwritten (`noteAtReservedPath`).
 *
 * K1 BUILDS THE HELPER ONLY: no existing operation is moved onto it yet (K2 and K3 do that).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { getShelfBook } from './shelfbook.ts';

export class IntentRefusal extends Error {}

/** A carrier failure leaves the move pending; local recovery has already finished. */
export class ControlMovePending extends Error {
  readonly reachable: boolean;
  readonly unverified: boolean;
  constructor(message: string, reachable: boolean, unverified = false) { super(message); this.reachable=reachable; this.unverified=unverified; }
}

// A command may enter recovery more than once. Never launch the same move child twice in that command.
const moveAttempts = new Map<string, Set<string>>();
const transportUnreachable = new Set<string>();
const inheritedControlChild = process.env['LIBRARY_CONTROL_TRANSPORT_CHILD']==='1';
let controlChildRestoreQueued=false;
/** Suppress recursive transport in synchronous carrier children, without leaking it into a later command turn. */
function markControlTransportChildren():void {
  if(!controlChildRestoreQueued){
    const previous=process.env['LIBRARY_CONTROL_TRANSPORT_CHILD'];controlChildRestoreQueued=true;
    queueMicrotask(()=>{
      if(previous===undefined)delete process.env['LIBRARY_CONTROL_TRANSPORT_CHILD'];
      else process.env['LIBRARY_CONTROL_TRANSPORT_CHILD']=previous;
      controlChildRestoreQueued=false;
    });
  }
  process.env['LIBRARY_CONTROL_TRANSPORT_CHILD']='1';
}
export function controlTransportUnreachable(workspace: string): void { transportUnreachable.add(workspace); }
export function pendingControlMoves(workspace: string): {delivery_id:string;why:string}[] {
  return listOutstanding(workspace).filter(r=>r.kind==='report-control-applied'&&r.payload['control_move_pending'])
    .map(r=>({delivery_id:r.delivery_id,why:String(r.payload['control_move_pending'])}));
}
export function recordPendingControlMove(workspace: string, record: IntentRecord, error: ControlMovePending): void {
  record.payload['control_move_pending']=error.message.substring(0,300);
  record.payload['control_move_unverified']=error.unverified;
  writeAtomicText(fileOf(workspace,record),JSON.stringify(record,null,2)+'\n');
}

function refuse(message: string): never {
  throw new IntentRefusal(message);
}

/** The Books an intent's stages may touch, in the one order their locks are taken. */
export const LOCK_ORDER = ['reports', 'letters'] as const;
export type IntentBook = (typeof LOCK_ORDER)[number];

export interface IntentStage {
  name: string;
  /** The Book whose lock the stage needs, or null for a stage that touches no Book (an outbox entry, the server). */
  book: IntentBook | null;
  state: 'pending' | 'done';
  proof: string | null;
}

export interface IntentRecord {
  schema: 1;
  delivery_id: string;
  kind: string;
  direction: 'outgoing' | 'incoming';
  book: IntentBook;
  /** Every delivery id and page name the operation will create, derived before the first write. */
  identities: { delivery_ids: string[]; pages: { book: IntentBook; page: string }[] };
  payload: Record<string, unknown>;
  stages: IntentStage[];
  created_utc: string;
  completed_utc: string | null;
}

const DELIVERY_ID = /^[a-z0-9][a-z0-9-]*$/;
const SUFFIX = '.intent.json';

function utcSeconds(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function folderOf(workspace: string, direction: IntentRecord['direction']): string {
  return path.join(workspace, 'internal', 'postbox', direction === 'outgoing' ? 'outbox' : 'applied');
}

function fileOf(workspace: string, record: Pick<IntentRecord, 'direction' | 'delivery_id'>): string {
  return path.join(folderOf(workspace, record.direction), `${record.delivery_id}${SUFFIX}`);
}

/**
 * THE RECORD, WRITTEN FIRST AND ONCE (`wx`): a second record for one delivery id fails rather than replaces the first,
 * so no identity is ever derived twice.
 */
export function createRecord(
  workspace: string,
  input: Omit<IntentRecord, 'schema' | 'stages' | 'created_utc' | 'completed_utc'> & { stages: { name: string; book: IntentBook | null }[] },
): IntentRecord {
  if (!DELIVERY_ID.test(input.delivery_id)) refuse(`An intent record needs a delivery id in lowercase letters, digits and hyphens; got '${input.delivery_id}'.`);
  const names = input.stages.map((stage) => stage.name);
  if (!names.length || new Set(names).size !== names.length) refuse(`An intent record needs one or more stages with distinct names; got ${JSON.stringify(names)}.`);
  const record: IntentRecord = {
    schema: 1,
    delivery_id: input.delivery_id,
    kind: input.kind,
    direction: input.direction,
    book: input.book,
    identities: input.identities,
    payload: input.payload,
    stages: input.stages.map((stage) => ({ name: stage.name, book: stage.book, state: 'pending', proof: null })),
    created_utc: utcSeconds(),
    completed_utc: null,
  };
  fs.mkdirSync(folderOf(workspace, record.direction), { recursive: true });
  fs.writeFileSync(fileOf(workspace, record), JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return record;
}

export function isComplete(record: IntentRecord): boolean {
  return record.stages.every((stage) => stage.state === 'done');
}

/** Every record in both folders, oldest first; a file that is not one is skipped. */
export function readRecords(workspace: string): IntentRecord[] {
  const records: IntentRecord[] = [];
  for (const direction of ['outgoing', 'incoming'] as const) {
    const folder = folderOf(workspace, direction);
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder).filter((file) => file.endsWith(SUFFIX)).sort()) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8').replace(/^﻿/, '')) as IntentRecord;
        if (record.schema === 1 && record.direction === direction && `${record.delivery_id}${SUFFIX}` === name && Array.isArray(record.stages)) records.push(record);
      } catch {
        // not a record; doctor names the folder, never this file's text
      }
    }
  }
  return records.sort((left, right) => left.created_utc.localeCompare(right.created_utc) || left.delivery_id.localeCompare(right.delivery_id));
}

/** The records with a stage still pending. */
export function listOutstanding(workspace: string): IntentRecord[] {
  return readRecords(workspace).filter((record) => !isComplete(record));
}

/** A changed parent waits only for its own Report; other pending Book stages still require recovery. */
export function blocksReportAllocation(record: IntentRecord, reportId?: string): boolean {
  if (record.payload['control_set_aside']) {
    if (record.payload['report_id'] === reportId) refuse(`Report ${reportId} is waiting on set-aside control ${record.delivery_id}: its Report changed while its control waited.`);
    return false;
  }
  return record.stages.some(stage => stage.state === 'pending' && stage.book !== null);
}

/**
 * ONE STAGE MARKED DONE, WITH ITS PROOF, in one atomic rewrite; the record's `completed_utc` is set with its last stage.
 *
 * SELF-TEST ONLY (`LIBRARY_POSTBOX_FAULT=after:<stage>`): the operation stops right after that stage is recorded, as a
 * crash between two durable writes would stop it.
 */
export function completeStage(workspace: string, record: IntentRecord, stageName: string, proof: string): IntentRecord {
  const stage = record.stages.find((row) => row.name === stageName);
  if (!stage) refuse(`The intent record ${record.delivery_id} has no stage '${stageName}'.`);
  stage.state = 'done';
  stage.proof = proof;
  if (isComplete(record)) record.completed_utc = utcSeconds();
  writeAtomicText(fileOf(workspace, record), JSON.stringify(record, null, 2) + '\n');
  if ((process.env['LIBRARY_POSTBOX_FAULT'] ?? '') === `after:${stageName}`) {
    throw new IntentRefusal(`LIBRARY_POSTBOX_FAULT: the operation stopped after the stage '${stageName}' of ${record.delivery_id}.`);
  }
  return record;
}

/** The page names (`notes/<name>`) outstanding records own in one Book, which no other writer may take. */
export function reservedPages(workspace: string, bookSlug: string): Set<string> {
  const pages = new Set<string>();
  for (const record of listOutstanding(workspace)) {
    for (const page of record.identities?.pages ?? []) if (page.book === bookSlug) pages.add(page.page.replace(/\.md$/i, ''));
  }
  return pages;
}

/**
 * A NOTE PROVED BY IDENTITY, NEVER BY PATH: `absent` when no file is there, `ours` when it carries this delivery id, and a
 * refusal naming the page when it does not (a collision, never overwritten).
 */
export function noteAtReservedPath(file: string, page: string, deliveryId: string): 'absent' | 'ours' {
  if (!fs.existsSync(file)) return 'absent';
  if (new RegExp(`^delivery_id: ${deliveryId}\\r?$`, 'm').test(fs.readFileSync(file, 'utf8'))) return 'ours';
  refuse(`A note is already at ${page} and it does not carry delivery_id ${deliveryId}, so it is not this operation's: it was not overwritten, and the operation waits.`);
}

function booksNeeded(records: IntentRecord[]): IntentBook[] {
  const wanted = new Set<IntentBook>();
  for (const record of records) for (const stage of record.stages) if (stage.state === 'pending' && stage.book !== null) wanted.add(stage.book);
  for (const record of records) if (['report-outcome-applied','report-control-applied'].includes(record.kind) && record.stages.some(stage => ['effect','notice-note','control-apply'].includes(stage.name) && stage.state === 'pending')) {
    wanted.add('reports'); wanted.add('letters');
  }
  return LOCK_ORDER.filter((book) => wanted.has(book));
}

/** A stage's work, run with the locks recovery holds: it returns the proof recorded for it. */
export type StageRunner = (record: IntentRecord, stage: IntentStage, locks: ReadonlyMap<IntentBook, BookLock>) => string;

export interface RecoverOptions {
  /** SELF-TEST ONLY: called once the pass's locks are held, before the listing taken under them. */
  onLocked?: (pass: number, held: IntentBook[]) => void;
  lockTimeoutSeconds?: number;
}

/**
 * RECOVERY, FROM ONE ENTRY POINT THAT HOLDS NO BOOK LOCK (the plan's four: `postbox send`, `postbox check`, the `reports`
 * verbs and a `triage batch` close). Each outstanding record's pending stages run in order through `run`, from the
 * listing taken under the final lock set; the locks are released however it ends.
 */
export function recover(workspace: string, entryPoint: string, run: StageRunner, options: RecoverOptions = {}): { records: number; stages_run: number; passes: number; locks: IntentBook[]; controls_move_pending?: {delivery_id:string;why:string}[]; controls_set_aside?: {delivery_id:string;parent:string;why:string;first_set_aside_utc:string}[] } {
  let want = booksNeeded(listOutstanding(workspace));
  for (let pass = 1; pass <= 3; pass += 1) {
    const held = new Map<IntentBook, BookLock>();
    let result: { records: number; stages_run: number; passes: number; locks: IntentBook[] } | null = null;
    try {
      for (const book of want) held.set(book, enterBookLock(workspace, getShelfBook(workspace, book).bookRoot, options.lockTimeoutSeconds ?? 20));
      options.onLocked?.(pass, [...held.keys()]);
      const fresh = listOutstanding(workspace);
      const need = booksNeeded(fresh);
      if (need.some((book) => !held.has(book))) {
        want = LOCK_ORDER.filter((book) => want.includes(book) || need.includes(book));
        continue;
      }
      let stagesRun = 0;
      for (const record of fresh) {
        for (const stage of record.stages) {
          if (stage.state === 'done' || ((record.kind === 'report-outcome' || record.kind === 'report-control-applied') && stage.name === 'send') || (record.kind === 'report-control-applied' && stage.name === 'server-move')) continue;
          try {
            const proof = run(record, stage, held);
            if (stage.name === 'control-apply') delete record.payload['control_set_aside'];
            completeStage(workspace, record, stage.name, proof);
          } catch (error) {
            if (record.kind !== 'report-control-applied' || stage.name !== 'control-apply' || (error as Error).message !== 'The Report changed while its control waited; nothing was overwritten.') throw error;
            record.payload['control_set_aside'] ??= {why:(error as Error).message,first_set_aside_utc:utcSeconds()};
            writeAtomicText(fileOf(workspace,record),JSON.stringify(record,null,2)+'\n');
            break;
          }
          stagesRun += 1;
        }
      }
      result = { records: fresh.length, stages_run: stagesRun, passes: pass, locks: [...held.keys()] };
    } finally {
      // Released in the reverse of the order taken.
      for (const lock of [...held.values()].reverse()) exitBookLock(lock);
    }
    if (result !== null) {
      // Transport runs without Book locks. postbox send completes these stages after its async attempt.
      const controlChild=inheritedControlChild;
      if(!controlChild)markControlTransportChildren();
      for (const record of listOutstanding(workspace)) {
        if (record.kind==='report-outcome' ? entryPoint==='postbox send' : record.kind!=='report-control-applied'||controlChild) continue;
        const send = record.stages.find(stage => stage.name === 'send' && stage.state === 'pending');
        if (send && record.stages.every(stage => stage === send || (record.kind === 'report-control-applied' && stage.name === 'server-move') || stage.state === 'done')) {
          completeStage(workspace, record, send.name, run(record, send, new Map()));
          result.stages_run += 1;
        }
      }
      // A normal check owns its carrier loop. Other entrypoints finish only already-recorded controls.
      const attempted=moveAttempts.get(workspace)??new Set<string>();moveAttempts.set(workspace,attempted);
      let unreachable=transportUnreachable.has(workspace);
      if(!controlChild&&entryPoint!=='postbox check')for(const record of listOutstanding(workspace)){
        if(record.kind!=='report-control-applied')continue;
        const move=record.stages.find(stage=>stage.name==='server-move'&&stage.state==='pending');
        if(move&&record.stages.every(stage=>stage===move||stage.state==='done')){
          if(attempted.has(record.delivery_id))continue;
          attempted.add(record.delivery_id);
          try {
            if(unreachable)throw new ControlMovePending('Postbox already unreachable in this recovery',false);
            completeStage(workspace,record,move.name,run(record,move,new Map()));result.stages_run++;
          } catch(error) {
            if(!(error instanceof ControlMovePending))throw error;
            unreachable ||= !error.reachable;
            if(unreachable)controlTransportUnreachable(workspace);
            recordPendingControlMove(workspace,record,error);
          }
        }
      }
      const pending=pendingControlMoves(workspace);
      const aside=listOutstanding(workspace).filter(r=>r.payload['control_set_aside']).map(r=>({delivery_id:r.delivery_id,parent:String(r.payload['report_id']),...(r.payload['control_set_aside'] as {why:string;first_set_aside_utc:string})}));
      return {...result,...(pending.length?{controls_move_pending:pending}:{}),...(aside.length?{controls_set_aside:aside}:{})};
    }
  }
  refuse(
    `${entryPoint} could not hold the locks its outstanding intent records need after three passes, so nothing was run: ` +
      `${listOutstanding(workspace).map((record) => record.delivery_id).join(', ') || '(none now)'}.`,
  );
}

/** Complete `applied/` records older than `days`, removed (the plan's criterion 6): their proof lives in the notes they changed. */
export function removeCompleted(workspace: string, days = 30, now: Date = new Date()): string[] {
  const removed: string[] = [];
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  for (const record of readRecords(workspace)) {
    if (record.direction !== 'incoming' || !isComplete(record) || record.completed_utc === null) continue;
    const at = Date.parse(record.completed_utc);
    if (Number.isNaN(at) || at >= cutoff) continue;
    fs.rmSync(fileOf(workspace, record), { force: true });
    removed.push(record.delivery_id);
  }
  return removed;
}
