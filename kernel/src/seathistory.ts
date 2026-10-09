/**
 * THE SEAT REGISTRY'S HISTORY, AN ATTEMPT LOG (1.3.8, kickoffs/s96 row 2, PLAN-seats-team.md session 1 row 2,
 * ADR-0069): `internal/seat-registry-history.jsonl`, one JSON object per line.
 *
 * Every registry write that sets or changes a seat's `department`, `role`, `card` or `template` appends, under the
 * registry lock, ONE RECORD PER CHANGED ROW, all sharing one `attempt` id; then the registry is replaced atomically, as
 * every registry write is (the one commit point); then one line `{"attempt": <id>, "committed": true}` is appended. A
 * record with no commit line is an UNCONFIRMED attempt: the replace may or may not have happened, and after later
 * changes nothing can say which, so `seat status` and doctor say "unconfirmed" rather than guess. A line that does not
 * parse (a truncated last line after a crash) is ignored, and EVERY APPEND FIRST WRITES A NEWLINE when the file does not
 * end in one, so damaged bytes stay their own line and the next record is whole. No transaction log beyond that: the
 * registry is the one truth, and this file is evidence of attempts and commits.
 *
 * A registry write that touches none of the four fields on any row writes nothing here, so a Library whose seats never
 * carry one has no history file at all.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { METADATA_FIELDS, type MetadataField } from './seatmeta.ts';
import { resolvesTo, type SeatIdentityView } from './seatincarnation.ts';

export const SEAT_HISTORY_RELATIVE = 'internal/seat-registry-history.jsonl';

export function seatHistoryPath(workspace: string): string {
  return path.join(workspace, ...SEAT_HISTORY_RELATIVE.split('/'));
}

export interface SeatHistoryRecord {
  attempt: string;
  when: string;
  verb: string;
  seat: string;
  seat_id: string;
  from_seat: string | null;
  plan_id: string;
  before: Record<MetadataField, unknown>;
  after: Record<MetadataField, unknown>;
  purpose_review_advised?: boolean;
}

export function newAttemptId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The fields whose value differs between a record's `before` and `after`. */
export function changedFields(record: Pick<SeatHistoryRecord, 'before' | 'after'>): MetadataField[] {
  return METADATA_FIELDS.filter((field) => JSON.stringify(record.before?.[field] ?? null) !== JSON.stringify(record.after?.[field] ?? null));
}

/** Appends lines, after a newline when the file's last byte is not one. The caller holds the registry lock. */
function appendLines(workspace: string, lines: string[]): void {
  if (!lines.length) return;
  const file = seatHistoryPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lead = '';
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const handle = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(handle, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = '\n';
      } finally {
        fs.closeSync(handle);
      }
    }
  }
  fs.appendFileSync(file, lead + lines.map((line) => line + '\n').join(''), 'utf8');
}

/** One attempt's row records, before the registry is replaced. */
export function appendHistoryRecords(workspace: string, records: SeatHistoryRecord[]): void {
  appendLines(workspace, records.map((record) => JSON.stringify(record)));
}

/** The attempt's commit line, after the registry was replaced. */
export function appendHistoryCommit(workspace: string, attempt: string): void {
  appendLines(workspace, [JSON.stringify({ attempt, committed: true })]);
}

/**
 * A FAULT FOR THE SELF-TEST ONLY: `LIBRARY_SEAT_HISTORY_FAULT=after-records` stops an apply after its row records and
 * before the registry replace; `after-replace` after the replace and before the commit line. A real run never sets it.
 */
export function seatHistoryFault(phase: 'after-records' | 'after-replace'): void {
  if ((process.env['LIBRARY_SEAT_HISTORY_FAULT'] ?? '').trim() === phase) {
    throw new Error(`FAULT INJECTED ${phase === 'after-records' ? 'after the history records, before the registry replace' : 'after the registry replace, before the commit line'} (a real run never reaches this).`);
  }
}

export interface SeatHistoryRead {
  file: string;
  exists: boolean;
  records: SeatHistoryRecord[];
  committed: Set<string>;
  /** 1-based line numbers that did not parse as a record or a commit line. */
  unparsable: number[];
}

function isRecord(value: unknown): value is SeatHistoryRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row['attempt'] === 'string' && typeof row['seat'] === 'string' && typeof row['verb'] === 'string' && typeof row['before'] === 'object' && typeof row['after'] === 'object';
}

/** The whole file, read; never throws on its content. */
export function readSeatHistory(workspace: string): SeatHistoryRead {
  const file = seatHistoryPath(workspace);
  const read: SeatHistoryRead = { file, exists: false, records: [], committed: new Set(), unparsable: [] };
  if (!fs.existsSync(file)) return read;
  read.exists = true;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    read.unparsable.push(0);
    return read;
  }
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      read.unparsable.push(index + 1);
      return;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['committed'] === true && typeof (value as Record<string, unknown>)['attempt'] === 'string') {
      read.committed.add(String((value as Record<string, unknown>)['attempt']));
      return;
    }
    if (isRecord(value)) read.records.push(value);
    else read.unparsable.push(index + 1);
  });
  return read;
}

export interface SeatHistoryState {
  /** The seat's last change whose attempt has a commit line, or null. */
  lastConfirmed: { when: string; verb: string; changed: MetadataField[]; plan_id: string } | null;
  /** Attempts naming the seat that have no commit line and come after its last confirmed change. */
  unconfirmed: number;
}

/**
 * One seat incarnation's state in the history: its records are those naming the seat with the same `seat_id` (a slug
 * retired and created again starts afresh). AN UNCONFIRMED ATTEMPT COUNTS ONLY UNTIL A LATER CONFIRMED CHANGE to the
 * same seat, which says again what its fields are. Joined by the identity projection's strict rule (kickoffs/s103 row
 * 3): given the registry's `view`, a record under a name the seat gave up by a rename, with its id, is the seat's too.
 */
export function seatHistoryState(history: SeatHistoryRead, seat: string, seatId: string, view?: SeatIdentityView): SeatHistoryState {
  const row = view ? { seat, seatId, view } : { seat, seatId };
  const mine = history.records.filter((record) => resolvesTo(record.seat, String(record.seat_id ?? ''), row, 'strict'));
  let lastIndex = -1;
  for (let index = mine.length - 1; index >= 0; index -= 1) {
    if (history.committed.has(mine[index]!.attempt)) {
      lastIndex = index;
      break;
    }
  }
  const last = lastIndex >= 0 ? mine[lastIndex]! : null;
  const after = mine.slice(lastIndex + 1).filter((record) => !history.committed.has(record.attempt));
  return {
    lastConfirmed: last ? { when: last.when, verb: last.verb, changed: changedFields(last), plan_id: last.plan_id } : null,
    unconfirmed: new Set(after.map((record) => record.attempt)).size,
  };
}
