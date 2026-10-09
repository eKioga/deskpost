/**
 * WHICH INCARNATION OF A SEAT THE REGISTRY NAMES NOW (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0), AND
 * EACH ROW'S IDENTITY, AND THE ONE IDENTITY PROJECTION (kickoffs/s103 rows 1 and 3; PLAN-seat-identity.md section 1).
 *
 * A seat's slug can be retired and created again, and each creation gets a new `seat_id`. A letter records the
 * `seat_id` of its writer and of its recipient as the registry reads at the moment it is written, and the one
 * recipient predicate (`isAddressedTo`, `shelfnote.ts`) compares a letter's `for_seat_id` with the row's. Since S103 a
 * row may also carry `names`, every name the seat has had through a rename, oldest first; a row without it has had one
 * name. An id that is not 32 lowercase hex, or that two rows share, is `invalid` and never matched by id.
 *
 * `incarnationOf` is the one place a recorded seat name (and id) is joined to a seat: each consumer keeps its rule of
 * today first, and only when that finds no live row does it try a name a seat gave up by a rename, under the same rule.
 *
 * A LEAF ON PURPOSE, and it NEVER THROWS: capture, triage and the Desk all ask it, `triage.ts` cannot import `desk.ts`
 * without closing a cycle through `publish.ts`, and a registry that cannot be read must not stop a capture. An id it
 * cannot read is '' (missing, never manufactured), so a letter that carries an id matches no row until it can be read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SeatIncarnation } from './shelfnote.ts';

export const SEAT_ID_PATTERN = /^[0-9a-f]{32}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** One name a seat has had: from when, and until when (`null` for the name it has now). */
export interface SeatNameSpan {
  name: string;
  from_utc: string;
  to_utc: string | null;
}

/** `valid`: 32 lowercase hex, unique across rows. `pre-identity`: no id. `invalid`: malformed, or shared with another row. */
export type SeatIdentityState = 'valid' | 'pre-identity' | 'invalid';

/** A live registry row as identity sees it. */
export interface SeatIdentityRow {
  seat: string;
  /** The id as written ('' when absent). Compared only when `identity` is `valid`, or as '' when `pre-identity`. */
  seatId: string;
  identity: SeatIdentityState;
  /** What counts and joins key on: the id when valid, else `name:<seat>`, never ''. */
  key: string;
  names: SeatNameSpan[];
  /** Why `names` was read as the one implied span, or null when it was absent or well formed. */
  namesProblem: string | null;
}

/** A retirement record as identity sees it: the name and id it retired under, and every name it had. */
export interface RetiredIdentity {
  seat: string;
  seatId: string;
  names: SeatNameSpan[];
}

export interface SeatIdentityView {
  live: SeatIdentityRow[];
  retired: RetiredIdentity[];
}

/** Which rule a consumer keeps (PLAN-seat-identity.md section 1, Codex r4 #1). */
export type IdentityRule =
  /** Letters and notes: a name with a missing id matches the seat that holds the name; a present id must be the row's. */
  | 'letters'
  /** Notebook ownership, reset restore, history: name AND recorded id, an empty id included. */
  | 'strict';

export interface Incarnation {
  outcome: 'live' | 'retired' | 'unknown';
  /** The matched row's or record's id ('' when it has none, or when nothing matched). */
  seat_id: string;
  /** The live row's name now, or the name a retirement record retired under; null when unknown. */
  current_name: string | null;
  /** `id`: name and a present id; `name`: a name with no id; `past-name`: a name the seat gave up by a rename. */
  via: 'id' | 'name' | 'past-name' | null;
}

const UNKNOWN: Incarnation = Object.freeze({ outcome: 'unknown', seat_id: '', current_name: null, via: null }) as Incarnation;

/**
 * A row's name history: its `names` when well formed, else the one span the row implies, `{name: seat, from_utc:
 * created, to_utc: null}`. Well formed: a non-empty list of `{name, from_utc, to_utc}` with slug names, no name twice,
 * every span but the last closed, and the last open and naming the seat. NEVER THROWS: a malformed value is reported.
 */
export function seatNameHistory(seat: string, created: string, value: unknown, closedAt: string | null = null): { names: SeatNameSpan[]; problem: string | null } {
  const implied = [{ name: seat, from_utc: created, to_utc: closedAt }];
  if (value === undefined || value === null) return { names: implied, problem: null };
  const problem = namesProblem(seat, value);
  if (problem !== null) return { names: implied, problem };
  return { names: (value as Record<string, unknown>[]).map((span) => ({ name: String(span['name']), from_utc: String(span['from_utc']), to_utc: span['to_utc'] === null ? null : String(span['to_utc']) })), problem: null };
}

function namesProblem(seat: string, value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'names is not a non-empty list';
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const span = value[index] as unknown;
    if (span === null || typeof span !== 'object' || Array.isArray(span)) return `names entry ${index + 1} is not an object`;
    const record = span as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return `names entry ${index + 1} has no seat name`;
    if (seen.has(name)) return `names lists '${name}' twice`;
    seen.add(name);
    if (typeof record['from_utc'] !== 'string') return `names entry ${index + 1} has no from_utc`;
    const last = index === value.length - 1;
    if (!last && typeof record['to_utc'] !== 'string') return `names entry ${index + 1} is not the last, and has no to_utc`;
    if (last && record['to_utc'] !== null && record['to_utc'] !== undefined) return 'the last names entry is not open (its to_utc is not null)';
    if (last && name !== seat) return `the last names entry is '${name}', not the seat's name '${seat}'`;
  }
  return null;
}

/** Every row's identity state: an id that is not 32 lowercase hex, or that two rows share, is `invalid` on each. */
export function seatIdentityRows(rows: readonly { seat: string; seatId: string; names: SeatNameSpan[]; namesProblem?: string | null }[]): SeatIdentityRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) if (SEAT_ID_PATTERN.test(row.seatId)) counts.set(row.seatId, (counts.get(row.seatId) ?? 0) + 1);
  return rows.map((row) => {
    const identity: SeatIdentityState = row.seatId === '' ? 'pre-identity' : SEAT_ID_PATTERN.test(row.seatId) && counts.get(row.seatId) === 1 ? 'valid' : 'invalid';
    return { seat: row.seat, seatId: row.seatId, identity, key: identity === 'valid' ? row.seatId : `name:${row.seat}`, names: row.names, namesProblem: row.namesProblem ?? null };
  });
}

/** The registry's rows as identity reads them, from the parsed `seats` list; a row with no slug `seat` is skipped. */
export function identityRowsOfRegistry(seats: readonly unknown[]): SeatIdentityRow[] {
  const rows: { seat: string; seatId: string; names: SeatNameSpan[]; namesProblem: string | null }[] = [];
  for (const row of seats) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const seat = record['seat'];
    if (typeof seat !== 'string' || !seat) continue;
    const id = record['seat_id'];
    const history = seatNameHistory(seat, typeof record['created_utc'] === 'string' ? record['created_utc'] : '', record['names']);
    rows.push({ seat, seatId: id === undefined || id === null ? '' : String(id), names: history.names, namesProblem: history.problem });
  }
  return seatIdentityRows(rows);
}

/** The live rows of the registry under `stateDirectory`, with the retirement records a caller read; never throws. */
export function readSeatIdentityView(stateDirectory: string, retired: RetiredIdentity[] = []): SeatIdentityView {
  const file = path.join(stateDirectory, 'seats', '_registry.json');
  try {
    if (!fs.existsSync(file)) return { live: [], retired };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { seats?: unknown };
    const rows = parsed && typeof parsed === 'object' && Array.isArray(parsed.seats) ? parsed.seats : [];
    return { live: identityRowsOfRegistry(rows as unknown[]), retired };
  } catch {
    return { live: [], retired };
  }
}

/**
 * A view from rows a caller already read (`readSeatRegistry`'s entries, `readSeatRetirementRecords`' records): a row or
 * record with no `names` has had the one name it carries.
 */
export function identityView(
  live: readonly { seat: string; seatId: string; names?: SeatNameSpan[]; namesProblem?: string | null }[],
  retired: readonly { seat: string; seat_id: string; names?: SeatNameSpan[] }[],
): SeatIdentityView {
  return {
    live: seatIdentityRows(live.map((row) => ({ seat: row.seat, seatId: row.seatId, names: row.names ?? [{ name: row.seat, from_utc: '', to_utc: null }], namesProblem: row.namesProblem ?? null }))),
    retired: retired.map((record) => ({ seat: record.seat, seatId: record.seat_id, names: record.names ?? [{ name: record.seat, from_utc: '', to_utc: null }] })),
  };
}

/** A view of exactly one live row, for a caller that holds a seat and not the registry (`isAddressedTo`'s own tests). */
export function singleRowView(row: SeatIncarnation): SeatIdentityView {
  return { live: seatIdentityRows([{ seat: row.seat, seatId: row.seatId, names: [{ name: row.seat, from_utc: '', to_utc: null }] }]), retired: [] };
}

/** Every registry row's `seat_id` by seat; '' where a row has none (a pre-identity row), or an invalid one. */
export function readSeatIds(stateDirectory: string): Map<string, string> {
  return idsOf(readSeatIdentityView(stateDirectory));
}

/** A view's ids by seat, as `readSeatIds` gives them. */
export function idsOf(view: SeatIdentityView): Map<string, string> {
  return new Map(view.live.map((row) => [row.seat, row.identity === 'valid' ? row.seatId : '']));
}

/** A seat as the recipient rule sees it: its slug, its row's `seat_id` ('' when there is none to read), and the view. */
export function seatIncarnation(stateDirectory: string, seat: string, view: SeatIdentityView = readSeatIdentityView(stateDirectory)): SeatIncarnation {
  const row = view.live.find((candidate) => candidate.seat === seat);
  return { seat, seatId: row && row.identity === 'valid' ? row.seatId : '', view };
}

/** Whether a recorded id (null or '' when the record carries none) agrees with a live row under a consumer's rule. */
function liveIdAgrees(row: SeatIdentityRow, recordedId: string | null, rule: IdentityRule): boolean {
  const id = recordedId ?? '';
  if (rule === 'letters') return id === '' || (row.identity === 'valid' && row.seatId === id);
  // STRICT, TODAY'S RULE EXACTLY (kickoffs/s103 ruling 4): the recorded id equals the row's as written, an empty id
  // included. An invalid id is compared as written here because the name must match too, and a name is one row's, so
  // nothing is joined to the wrong seat; the oracle's own fixtures carry hyphenated ids this rule has always matched.
  return row.seatId === id;
}

/** A past name is a join by id, so only a valid id makes one (ruling 2): an invalid row never matches through it. */
function pastIdAgrees(row: SeatIdentityRow, recordedId: string | null, rule: IdentityRule): boolean {
  return row.identity === 'valid' && liveIdAgrees(row, recordedId, rule);
}

function pastNames(names: SeatNameSpan[]): string[] {
  return names.slice(0, -1).map((span) => span.name);
}

/**
 * THE ONE IDENTITY PROJECTION (PLAN-seat-identity.md section 1). A recorded name and id, joined to a seat:
 *
 * 1. today's rule: the live row whose name is the recorded name, if the id agrees under the consumer's rule;
 * 2. only if that finds no live row: the live row that gave the recorded name up by a rename, under the same rule, and
 *    for `strict` only with a recorded id (an empty id never matches a past name). Two such rows are never guessed at;
 * 3. else a retirement record, by its name or a past one, under the same rule: `retired`;
 * 4. else `unknown`.
 *
 * So a record is never handed to a different seat than today's rule gives it (Fable B1), and until the first rename the
 * past-name branch is unreachable.
 */
export function incarnationOf(view: SeatIdentityView, recordedName: string | null, recordedId: string | null, rule: IdentityRule): Incarnation {
  if (!recordedName) return UNKNOWN;
  const id = recordedId ?? '';
  const via = id === '' ? 'name' : 'id';
  const holder = view.live.find((row) => row.seat === recordedName);
  if (holder && liveIdAgrees(holder, recordedId, rule)) return { outcome: 'live', seat_id: holder.seatId, current_name: holder.seat, via };
  if (!(rule === 'strict' && id === '')) {
    const formers = view.live.filter((row) => pastNames(row.names).includes(recordedName) && pastIdAgrees(row, recordedId, rule));
    if (formers.length === 1) return { outcome: 'live', seat_id: formers[0]!.seatId, current_name: formers[0]!.seat, via: 'past-name' };
    if (formers.length > 1) return UNKNOWN;
  }
  const retired = view.retired.find((record) => record.seat === recordedName && retiredIdAgrees(record, recordedId, rule)) ??
    (id === '' && rule === 'strict' ? undefined : view.retired.find((record) => pastNames(record.names).includes(recordedName) && retiredIdAgrees(record, recordedId, rule)));
  if (retired) return { outcome: 'retired', seat_id: retired.seatId, current_name: retired.seat, via: retired.seat === recordedName ? via : 'past-name' };
  return UNKNOWN;
}

/** A retirement record's id is compared as written, as `seatIncarnationStatus` always has. */
function retiredIdAgrees(record: RetiredIdentity, recordedId: string | null, rule: IdentityRule): boolean {
  const id = recordedId ?? '';
  if (rule === 'letters') return id === '' || record.seatId === id;
  return record.seatId === id;
}

/** Whether `recorded` resolves, under `rule`, to the live seat `row` (its own view when it carries one). */
export function resolvesTo(recordedName: string | null, recordedId: string | null, row: SeatIncarnation | null, rule: IdentityRule = 'letters'): boolean {
  if (row === null) return false;
  const found = incarnationOf(row.view ?? singleRowView(row), recordedName, recordedId, rule);
  return found.outcome === 'live' && found.current_name === row.seat;
}
