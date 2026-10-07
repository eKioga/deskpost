/**
 * `deskpost seat describe` (1.3.8, kickoffs/s96 row 2, ruling 4; PLAN-seats-team.md session 1 row 2; ADR-0069): a
 * seat's department, role and card, changed only under the reader's gate.
 *
 *   deskpost seat describe <seat> [--department <d>] [--role performer|orchestrator] [--card "<line>"]
 *     [--clear-department] [--clear-role] [--clear-card] [--from <seat>] --preflight | --plan-id <id>
 *
 * GATED AS `seat settings --inbound` IS (`seatinbound.ts`): the preflight shows `before` and `after` per field and per
 * row it touches, says `creates_department` when the department is new, and issues a plan id over the seat, the
 * requested changes and the digest of the WHOLE registry file (not the `seat=project` lines `seatCreationPlanId`
 * digests, which would let a concurrent describe pass). The apply rechecks under the registry lock and refuses on a
 * changed registry. Every refusal writes nothing.
 *
 * `--from <current>` SWAPS a department's orchestrator in one preview and one plan: the named seat becomes the
 * orchestrator and the current one a performer, so the department is never left between two. A role requires a
 * department; `--clear-department` on a seat with a role clears the role too, in the preview.
 *
 * Any seat, or no seat, may run it: the gate is the previewed plan id and the reader's yes, the limit every gated verb
 * has (a plan id proves the preview was read, not who read it; ADR-0062 on `LIBRARY_SEAT`). With no change named it
 * reads the seat's fields and changes nothing.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utcRoundTrip } from './journal.ts';
import type { PsJsonValue } from './psjson.ts';
import { readSeatRegistry, readSeatRetirementRecords } from './desk.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { resolveSeatName } from './seatdesk.ts';
import { readRegistryRows, registryFilePath, writeSeatRegistry } from './seatregistry.ts';
import {
  METADATA_FIELDS,
  cardProblem,
  departmentProblem,
  fieldProblem,
  rawMetadata,
  roleProblem,
  seatMetadata,
  type MetadataField,
} from './seatmeta.ts';
import {
  appendHistoryCommit,
  appendHistoryRecords,
  newAttemptId,
  readSeatHistory,
  seatHistoryFault,
  seatHistoryPath,
  seatHistoryState,
  SEAT_HISTORY_RELATIVE,
  type SeatHistoryRecord,
} from './seathistory.ts';

/** A refusal of this verb's: said to the reader as it stands, and nothing was written. */
export class SeatDescribeRefusal extends Error {}

function refuse(message: string): never {
  throw new SeatDescribeRefusal(message);
}

const NOTHING = 'Nothing was changed.';

export interface DescribeRequest {
  department?: string;
  role?: string;
  card?: string;
  clearDepartment: boolean;
  clearRole: boolean;
  clearCard: boolean;
  from?: string;
}

function requested(request: DescribeRequest): boolean {
  return request.department !== undefined || request.role !== undefined || request.card !== undefined || request.clearDepartment || request.clearRole || request.clearCard || request.from !== undefined;
}

/** The request in one canonical form, for the plan id. */
function canonicalRequest(request: DescribeRequest): string {
  return JSON.stringify({
    department: request.clearDepartment ? { clear: true } : request.department ?? null,
    role: request.clearRole ? { clear: true } : request.role ?? null,
    card: request.clearCard ? { clear: true } : request.card ?? null,
    from: request.from ?? null,
  });
}

function registryDigest(file: string): string {
  if (!fs.existsSync(file)) return 'absent';
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function planIdFor(seat: string, request: DescribeRequest, digest: string): string {
  return 'seat-describe-' + crypto.createHash('sha256').update(`${seat}|${canonicalRequest(request)}|${digest}`, 'utf8').digest('hex').substring(0, 16);
}

/** The seat, named and in the registry. A retired seat and an unknown one are refused, each by name. */
function registeredSeat(workspace: string, stateDirectory: string, name: string, what: string): string {
  const resolved = resolveSeatName({ seat: name, stateDirectory });
  if (resolved.status !== 'named') refuse(`${resolved.message} ${NOTHING}`);
  const seat = resolved.seat!;
  const registry = readSeatRegistry(stateDirectory);
  if (registry.some((row) => row.seat === seat)) return seat;
  if (readSeatRetirementRecords(workspace).records.some((record) => record.seat === seat)) refuse(`${what} '${seat}' is retired, so it has no card or role to set. ${NOTHING}`);
  const names = registry.map((row) => row.seat);
  refuse(`There is no seat named '${seat}'. ${names.length ? `The seats are: ${names.join(', ')}.` : 'This Library has no seats yet.'} ${NOTHING}`);
}

/** The options' own refusals, before anything is read: values, contradictions and the swap's shape. */
function assertRequestIsWellFormed(seat: string, request: DescribeRequest): void {
  const both = (set: boolean, clear: boolean, field: string): void => {
    if (set && clear) refuse(`--${field} and --clear-${field} contradict; give one. ${NOTHING}`);
  };
  both(request.department !== undefined, request.clearDepartment, 'department');
  both(request.role !== undefined, request.clearRole, 'role');
  both(request.card !== undefined, request.clearCard, 'card');
  if (request.department !== undefined) {
    const problem = departmentProblem(request.department);
    if (problem) refuse(`--department '${request.department}' is refused: ${problem}. ${NOTHING}`);
  }
  if (request.role !== undefined) {
    const problem = roleProblem(request.role);
    if (problem) refuse(`--role '${request.role}' is refused: ${problem}. ${NOTHING}`);
  }
  if (request.card !== undefined) {
    // NEVER ECHOED: a card that fails may hold the very characters the rule keeps off a terminal.
    const problem = cardProblem(request.card);
    if (problem) refuse(`--card is refused: ${problem}. ${NOTHING}`);
  }
  if (request.from !== undefined) {
    if (request.role !== 'orchestrator') refuse(`--from names the department's current orchestrator, which this seat replaces, so it needs --role orchestrator. ${NOTHING}`);
    if (request.from === seat) refuse(`--from names the seat that hands the role over, and '${seat}' cannot hand it to itself. ${NOTHING}`);
  }
}

interface RowChange {
  seat: string;
  seat_id: string;
  project: string;
  before: Record<MetadataField, unknown>;
  after: Record<MetadataField, unknown>;
  changed: MetadataField[];
  purpose_review_advised: boolean;
  advice: string | null;
}

/** A row rebuilt with its four fields set as `after`: other keys keep their order, the four follow in theirs. */
function rowWithMetadata(row: Record<string, PsJsonValue>, after: Record<MetadataField, unknown>): Record<string, PsJsonValue> {
  const out: Record<string, PsJsonValue> = {};
  for (const [key, value] of Object.entries(row)) if (!(METADATA_FIELDS as readonly string[]).includes(key)) out[key] = value;
  for (const field of METADATA_FIELDS) if (after[field] !== null && after[field] !== undefined) out[field] = after[field] as PsJsonValue;
  return out;
}

function purposeAdvice(seat: string, project: string, before: unknown, after: unknown, template: unknown): string {
  const from = typeof template === 'string' && template ? ` from template ${template}` : '';
  return (
    `Seat '${seat}''s role changes (${before ?? 'none'} -> ${after ?? 'none'}): the Hub's Purpose may carry role text${from}; ` +
    `review it with deskpost hub edit ${project} --mode replace-section --section Purpose.`
  );
}

/**
 * THE PLAN, from the registry's raw rows: the rows it changes, each with `before` and `after`, or a refusal. The same
 * function runs for the preview and, under the lock, for the apply, so the two cannot disagree.
 */
function describePlan(rows: Record<string, PsJsonValue>[], seat: string, request: DescribeRequest): { changes: RowChange[]; createsDepartment: boolean; department: string | null } {
  const row = rows.find((candidate) => String(candidate['seat']) === seat);
  if (!row) refuse(`There is no seat named '${seat}' in the registry. ${NOTHING}`);
  const before = rawMetadata(row);
  const after = { ...before };
  if (request.department !== undefined) after.department = request.department;
  if (request.clearDepartment) after.department = null;
  if (request.role !== undefined) after.role = request.role;
  if (request.clearRole) after.role = null;
  if (request.card !== undefined) after.card = request.card;
  if (request.clearCard) after.card = null;
  // CLEARING A SEAT'S DEPARTMENT CLEARS ITS ROLE TOO, shown in the preview; naming a role in the same call is refused.
  if (request.clearDepartment && after.role !== null) {
    if (request.role !== undefined) refuse(`A role requires a department, and --clear-department removes '${seat}''s. Give a --department, or --clear-role. ${NOTHING}`);
    after.role = null;
  }
  if (after.role !== null && after.department === null) {
    refuse(`A role requires a department: '${seat}' has none. Give one in the same call with --department <slug>. ${NOTHING}`);
  }
  // A VALUE KEPT FROM BEFORE MUST STILL VALIDATE: a writer never writes an invalid field back. The refusal names the
  // option that repairs it in the same call.
  for (const field of METADATA_FIELDS) {
    if (after[field] === null) continue;
    const problem = fieldProblem(field, after[field]);
    if (problem) {
      refuse(
        field === 'template'
          ? `Seat '${seat}''s registry row carries a template that is not valid (${problem}); remove "template" from that row in .claude/seats/_registry.json first. ${NOTHING}`
          : `Seat '${seat}''s ${field} in the registry is not valid (${problem}); set it in the same call with --${field} <value>, or remove it with --clear-${field}. ${NOTHING}`,
      );
    }
  }

  const department = typeof after.department === 'string' ? after.department : null;
  const changes: RowChange[] = [];
  let fromRow: Record<string, PsJsonValue> | undefined;
  if (request.from !== undefined) {
    fromRow = rows.find((candidate) => String(candidate['seat']) === request.from);
    if (!fromRow) refuse(`--from '${request.from}' names no seat in the registry. ${NOTHING}`);
    const fromMeta = rawMetadata(fromRow);
    if (fromMeta.role !== 'orchestrator' || fromMeta.department !== department) {
      refuse(`--from '${request.from}' is not the orchestrator of department '${department}', so there is nothing to hand over. Leave out --from. ${NOTHING}`);
    }
  }
  // ONE ORCHESTRATOR PER DEPARTMENT, judged on the rows as they would stand. `--from` is the route.
  if (after.role === 'orchestrator' && department !== null) {
    const others = rows.filter((candidate) => {
      const name = String(candidate['seat']);
      if (name === seat || name === request.from) return false;
      const meta = rawMetadata(candidate);
      return meta.role === 'orchestrator' && meta.department === department;
    });
    if (others.length) {
      const current = String(others[0]!['seat']);
      refuse(
        `Department '${department}' already has an orchestrator, '${current}', and a department has one. To hand the role over in one step, ` +
          `run deskpost seat describe ${seat} --role orchestrator --from ${current} (--department ${department} if '${seat}' is not in it yet). ${NOTHING}`,
      );
    }
  }

  const project = String(row['project'] ?? '');
  const changed = METADATA_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  const roleChanged = JSON.stringify(before.role) !== JSON.stringify(after.role);
  changes.push({
    seat,
    seat_id: String(row['seat_id'] ?? ''),
    project,
    before,
    after,
    changed,
    purpose_review_advised: roleChanged,
    advice: roleChanged ? purposeAdvice(seat, project, before.role, after.role, after.template ?? before.template) : null,
  });
  if (fromRow) {
    const fromBefore = rawMetadata(fromRow);
    const fromAfter = { ...fromBefore, role: 'performer' };
    const fromProject = String(fromRow['project'] ?? '');
    changes.push({
      seat: String(fromRow['seat']),
      seat_id: String(fromRow['seat_id'] ?? ''),
      project: fromProject,
      before: fromBefore,
      after: fromAfter,
      changed: ['role'],
      purpose_review_advised: true,
      advice: purposeAdvice(String(fromRow['seat']), fromProject, 'orchestrator', 'performer', fromBefore.template),
    });
  }
  // NEW WHEN NO OTHER ROW CARRIES IT NOW, valid or not: the department did not exist before this change.
  const createsDepartment =
    department !== null &&
    before.department !== department &&
    !rows.some((candidate) => String(candidate['seat']) !== seat && rawMetadata(candidate).department === department);
  return { changes: changes.filter((change) => change.changed.length > 0), createsDepartment, department };
}

/** One row's fields as JSON, `null` where absent. */
function fieldsJson(fields: Record<MetadataField, unknown>): Record<string, PsJsonValue> {
  const out: Record<string, PsJsonValue> = {};
  for (const field of METADATA_FIELDS) out[field] = (fields[field] ?? null) as PsJsonValue;
  return out;
}

function changesJson(changes: RowChange[]): PsJsonValue {
  return changes.map((change) => ({
    seat: change.seat,
    seat_id: change.seat_id,
    before: fieldsJson(change.before),
    after: fieldsJson(change.after),
    changed: change.changed,
    ...(change.purpose_review_advised ? { purpose_review_advised: true } : {}),
  }));
}

/** `seat describe <seat>` with no change: the seat's fields as the projection reads them, and its last change. */
function describeRead(workspace: string, stateDirectory: string, seat: string): Record<string, PsJsonValue> {
  const rows = readRegistryRows(registryFilePath(stateDirectory));
  const projection = seatMetadata(rows);
  const row = rows.find((candidate) => String(candidate['seat']) === seat)!;
  const meta = projection.seats.get(seat)!;
  const raw = rawMetadata(row);
  const invalid = METADATA_FIELDS.filter((field) => raw[field] !== null && meta[field] === null);
  const state = seatHistoryState(readSeatHistory(workspace), seat, String(row['seat_id'] ?? ''));
  return {
    schema: 1,
    operation: 'Describe a Library seat',
    seat,
    department: meta.department,
    role: meta.role,
    card: meta.card,
    template: meta.template,
    ...(invalid.length ? { read_as_absent: invalid } : {}),
    last_change: state.lastConfirmed as unknown as PsJsonValue,
    ...(state.unconfirmed ? { unconfirmed_attempts: state.unconfirmed } : {}),
    next: `To change it: deskpost seat describe ${seat} --department <slug> --role performer|orchestrator --card "<one line>" --preflight, then the same with --plan-id <id> after the reader's yes.`,
    shared_library_write: false,
  };
}

/** The verb. `request` holds the options; `preflight` and `planId` the gate. */
export function seatDescribeResult(options: { workspace: string; seat: string; request: DescribeRequest; preflight: boolean; planId: string }): Record<string, PsJsonValue> {
  const { workspace, request } = options;
  const stateDirectory = path.join(workspace, '.claude');
  if (!options.seat.trim()) refuse(`Name the seat: deskpost seat describe <seat> [--department <slug>] [--role performer|orchestrator] [--card "<one line>"] --preflight. ${NOTHING}`);
  const seat = registeredSeat(workspace, stateDirectory, options.seat, 'Seat');
  if (!requested(request)) {
    if (options.preflight || options.planId) refuse(`Name a change: --department, --role, --card, or a --clear- option. ${NOTHING}`);
    return describeRead(workspace, stateDirectory, seat);
  }
  assertRequestIsWellFormed(seat, request);
  if (request.from !== undefined) registeredSeat(workspace, stateDirectory, request.from, '--from seat');
  const file = registryFilePath(stateDirectory);

  if (options.preflight) {
    const lock = enterSeatRegistryLock(workspace, 10);
    try {
      const rows = readRegistryRows(file);
      const plan = describePlan(rows, seat, request);
      const digest = registryDigest(file);
      return {
        schema: 1,
        operation: 'Describe a Library seat (preflight)',
        seat,
        rows: changesJson(plan.changes),
        change: plan.changes.length ? 'write' : 'none',
        ...(plan.department !== null ? { department: plan.department, creates_department: plan.createsDepartment } : {}),
        ...(plan.changes.some((change) => change.purpose_review_advised) ? { purpose_review_advised: true, advice: plan.changes.flatMap((change) => (change.advice ? [change.advice] : [])) } : {}),
        registry_digest: digest,
        plan_id: plan.changes.length ? planIdFor(seat, request, digest) : null,
        ...(plan.changes.length ? { history: SEAT_HISTORY_RELATIVE } : { note: 'Nothing would change: the registry already says this.' }),
        confirmation_required: plan.changes.length > 0,
        shared_library_write: false,
      };
    } finally {
      exitBookLock(lock);
    }
  }

  if (!options.planId) refuse(`${NOTHING} Run with --preflight, show the reader what it reports, and rerun with its exact --plan-id after one clear yes.`);
  const caller = resolveSeatName({ stateDirectory });
  const fromSeat = caller.status === 'named' ? caller.seat! : null;
  const lock = enterSeatRegistryLock(workspace, 10);
  try {
    const rows = readRegistryRows(file);
    if (options.planId !== planIdFor(seat, request, registryDigest(file))) {
      refuse(`${NOTHING} That plan_id does not match this seat, these changes and the seat registry as it is now: the registry changed since the preview, or the id is not the one it issued. Rerun the preflight, show the reader what it says, and ask again.`);
    }
    const plan = describePlan(rows, seat, request);
    if (!plan.changes.length) refuse(`${NOTHING} The registry already says this, so there is nothing to write.`);
    const attempt = newAttemptId();
    const when = utcRoundTrip();
    const records: SeatHistoryRecord[] = plan.changes.map((change) => ({
      attempt,
      when,
      verb: 'describe',
      seat: change.seat,
      seat_id: change.seat_id,
      from_seat: fromSeat,
      plan_id: options.planId,
      before: change.before,
      after: change.after,
      ...(change.purpose_review_advised ? { purpose_review_advised: true } : {}),
    }));
    // THE ATTEMPT LOG'S ORDER: the row records, the one atomic replace, the commit line.
    appendHistoryRecords(workspace, records);
    seatHistoryFault('after-records');
    const byName = new Map(plan.changes.map((change) => [change.seat, change]));
    writeSeatRegistry(stateDirectory, rows.map((candidate) => {
      const change = byName.get(String(candidate['seat']));
      return change ? rowWithMetadata(candidate, change.after) : candidate;
    }));
    seatHistoryFault('after-replace');
    appendHistoryCommit(workspace, attempt);
    return {
      schema: 1,
      operation: 'Describe a Library seat',
      seat,
      rows: changesJson(plan.changes),
      changed: true,
      ...(plan.department !== null ? { department: plan.department, creates_department: plan.createsDepartment } : {}),
      ...(plan.changes.some((change) => change.purpose_review_advised) ? { purpose_review_advised: true, advice: plan.changes.flatMap((change) => (change.advice ? [change.advice] : [])) } : {}),
      history: seatHistoryPath(workspace),
      attempt,
      shared_library_write: false,
    };
  } finally {
    exitBookLock(lock);
  }
}
