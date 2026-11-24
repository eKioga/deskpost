import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArguments } from './argv.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { parseBookRoot } from './places.ts';
import { departmentProblem, metadataFor, readSeatMetadata, roleProblem, type SeatMetadata } from './seatmeta.ts';
import { readSeatRegistry, seatDeclinedBooks, seatOpenBooks, validateDeskBookRoot } from './desk.ts';
import { appendHistoryCommit, appendHistoryRecords, newAttemptId } from './seathistory.ts';
import { utcRoundTrip } from './journal.ts';
import { argumentTable } from './verbs.ts';
import { requireWorkspace } from './workspace.ts';
import { additiveUpkeep } from './sharedwrite.ts';

type Selector = { role: string } | { department: string };
export type BookDefaultRule = Selector & { id: string; books: string[]; keep: boolean };

function readRules(workspace: string) {
  const file = path.join(workspace, '.claude', 'seats', '_book-defaults.json');
  let bytes: Buffer | null = null;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (bytes === null) return { file, bytes, rules: [] as BookDefaultRule[] };
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value?.schema !== 1 || !Array.isArray(value.rules) || !value.rules.every((rule: Record<string, unknown>) =>
    rule && typeof rule.id === 'string' && typeof rule.keep === 'boolean' &&
    (rule.role === undefined ? !departmentProblem(rule.department) : rule.department === undefined && !roleProblem(rule.role)) &&
    Array.isArray(rule.books) && rule.books.length > 0 && rule.books.every(root => typeof root === 'string' && parseBookRoot(root)?.root === root)
  )) throw new Error('The default Books rules file is malformed.');
  return { file, bytes, rules: value.rules as BookDefaultRule[] };
}

export function matchingDefaultBooks(workspace: string, seat: Pick<SeatMetadata, 'role' | 'department'>) {
  const books = new Map<string, { root: string; source: string; keep: boolean }>();
  for (const rule of readRules(workspace).rules) {
    const matches = 'role' in rule
      ? seat.role === rule.role
      : seat.department === rule.department || seat.department?.startsWith(rule.department + '/');
    if (!matches) continue;
    for (const root of rule.books) {
      const existing = books.get(root);
      if (existing) existing.keep ||= rule.keep;
      else books.set(root, { root, source: 'role' in rule ? 'role ' + rule.role : 'department ' + rule.department, keep: rule.keep });
    }
  }
  return [...books.values()];
}

/** The local receipt is a hint for read-only views. The grants command checks the remote note. */
export function defaultGrantsMissing(workspace: string, defaults: ReturnType<typeof matchingDefaultBooks>, seatId: string): string[] {
  return defaults.filter(book => {
    if (!book.keep || !seatId) return false;
    const parts = parseBookRoot(book.root)!;
    if (parts.form !== 'shared' || parts.shelf !== 'active') return true;
    try {
      const file = path.join(workspace, 'internal', 'shared-upkeep', parts.slug + '.json');
      const copy = JSON.parse(fs.readFileSync(file, 'utf8'));
      return copy?.any_seat !== true && !copy?.seat_ids?.includes(seatId);
    } catch {
      return true;
    }
  }).map(book => book.root);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}


type DefaultGrantOutcome = {
  book: string;
  missing_seat_ids: string[];
  local_copy: string;
  outcome: string;
  reason: string;
};

async function defaultGrants(workspace: string, parsed: ReturnType<typeof parseArguments>, preview: boolean, suppliedId: string | undefined) {
  const prefix = 'seat-default-grants-';
  type Receipt = { state: string; books: Record<string, string> };
  let receipt: Receipt | null = null;
  if (!preview) {
    if (!suppliedId?.startsWith(prefix)) throw new Error('Use the exact seat defaults grants plan_id from preflight.');
    try {
      const token = suppliedId.slice(prefix.length);
      const separator = token.indexOf('.');
      const payload = token.slice(separator + 1);
      const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (separator !== 64 || digest(decoded) !== token.slice(0, separator)) throw new Error('invalid receipt');
      receipt = decoded as Receipt;
      if (typeof receipt.state !== 'string' || !receipt.books || typeof receipt.books !== 'object') throw new Error('invalid receipt');
    } catch {
      throw new Error('Use the exact seat defaults grants plan_id from preflight.');
    }
  }
  const stateDirectory = path.join(workspace, '.claude');
  const registry = path.join(stateDirectory, 'seats', '_registry.json');
  const lock = preview ? null : enterSeatRegistryLock(workspace);
  try {
    const { rules, bytes } = readRules(workspace);
    const state = digest({ rules: bytes, registry: fs.existsSync(registry) ? fs.readFileSync(registry) : null });
    const projection = readSeatMetadata(stateDirectory);
    const seats = readSeatRegistry(stateDirectory);
    const roots = [...new Set(rules.filter(rule => rule.keep).flatMap(rule => rule.books))];
    const wanted = new Map(roots.map(root => [root, [] as { seat: string; seatId: string }[]]));
    for (const row of seats) {
      if (!row.seatId) continue;
      const defaults = matchingDefaultBooks(workspace, metadataFor(projection, row.seat));
      for (const book of defaults) {
        if (book.keep) wanted.get(book.root)?.push({ seat: row.seat, seatId: row.seatId });
      }
    }
    const books: Record<string, string> = {};
    const outcomes: DefaultGrantOutcome[] = [];
    for (const book of new Set([...roots, ...Object.keys(receipt?.books ?? {})])) {
      const pending = wanted.get(book) ?? [];
      const row = { book, missing_seat_ids: pending.map(seat => seat.seatId), local_copy: 'unknown' };
      if (receipt && (receipt.state !== state || !wanted.has(book) || !Object.hasOwn(receipt.books, book))) {
        outcomes.push({ ...row, outcome: 'refused', reason: 'Rules or registry changed since preflight.' });
        continue;
      }
      const parts = parseBookRoot(book)!;
      if (parts.form !== 'shared' || parts.shelf !== 'active') {
        books[book] = 'ineligible';
        outcomes.push({ ...row, outcome: 'not written', reason: 'Upkeep grants require an active shared Book.' });
        continue;
      }
      try {
        const checked = await additiveUpkeep(workspace, parsed, parts.slug, pending, receipt?.books[book]);
        books[book] = checked.digest;
        outcomes.push({ book, missing_seat_ids: checked.missing_seat_ids, local_copy: checked.local_copy,
          outcome: checked.outcome, reason: checked.reason });
      } catch (error) {
        const reason = (error as Error).message;
        books[book] = 'unavailable';
        outcomes.push({ ...row, outcome: /unsettled/i.test(reason) ? 'unsettled' : /since it was read|server refused/i.test(reason) ? 'refused' : 'not written', reason });
      }
    }
    const plan = { state, books };
    const plan_id = suppliedId ?? prefix + digest(plan) + '.' + Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
    return { schema: 1, action: 'grants' as const, plan_id, preflight: preview, books: outcomes };
  } finally {
    exitBookLock(lock);
  }
}

type DefaultsResult =
  | Awaited<ReturnType<typeof defaultGrants>>
  | { schema: number; rules: BookDefaultRule[]; seats: { seat: string; missing: string[]; declined: string[]; grants_missing: string[] }[] }
  | { schema: number; action: string; rule: BookDefaultRule; plan_id: string; written: boolean };

export async function seatDefaultsResult(argv: string[]): Promise<DefaultsResult> {
  const parsed = parseArguments(argv, argumentTable('seat', 'defaults'));
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const [action, target] = parsed.positional;
  const role = parsed.options.get('role');
  const department = parsed.options.get('department');
  const books = [...new Set(parsed.lists.get('book') ?? [])];
  const keep = parsed.flags.has('keep');
  const preview = parsed.flags.has('preflight');
  const confirmed = parsed.flags.has('user-confirmed');
  const suppliedId = parsed.options.get('plan-id');
  if (action === undefined) {
    if (role !== undefined || department !== undefined || books.length || keep || preview || confirmed || suppliedId) {
      throw new Error('List default Books without mutation arguments.');
    }
    const { rules } = readRules(workspace);
    const state = path.join(workspace, '.claude');
    const metadata = readSeatMetadata(state);
    const seats = readSeatRegistry(state).map(row => {
      const opened = new Set(seatOpenBooks(workspace, row.seat));
      const defaults = matchingDefaultBooks(workspace, metadataFor(metadata, row.seat));
      const declined = seatDeclinedBooks(workspace, row.seat);
      return { seat: row.seat, missing: defaults.filter(book => !opened.has(book.root) && !declined.includes(book.root)).map(book => book.root), declined, grants_missing: defaultGrantsMissing(workspace, defaults, row.seatId) };
    });
    return { schema: 1, rules, seats };
  }
  if (action !== 'add' && action !== 'remove' && action !== 'grants') throw new Error('Seat defaults actions are add, remove and grants.');
  if (preview ? confirmed || suppliedId !== undefined : !confirmed || !suppliedId) {
    throw new Error('Use --preflight, then --user-confirmed with its exact --plan-id.');
  }
  if (action === 'grants') {
    if (target !== undefined || role !== undefined || department !== undefined || books.length || keep) {
      throw new Error('Use grants with --preflight or --user-confirmed and its exact --plan-id.');
    }
    return defaultGrants(workspace, parsed, preview, suppliedId);
  }
  const lock = preview ? null : enterSeatRegistryLock(workspace);
  try {
    const { file, bytes, rules } = readRules(workspace);
    let next: BookDefaultRule[];
    let rule: BookDefaultRule;
    if (action === 'add') {
      if (target !== undefined || (role === undefined) === (department === undefined) || !books.length) {
        throw new Error('Use add with exactly one of --role or --department and at least one --book.');
      }
      const problem = role !== undefined ? roleProblem(role) : departmentProblem(department);
      if (problem) throw new Error(problem);
      for (const root of books) validateDeskBookRoot(workspace, root);
      const selector: Selector = role !== undefined ? { role } : { department: department! };
      const id = 'default-' + digest({ ...selector, books: [...books].sort(), keep }).slice(0, 16);
      if (rules.some(candidate => candidate.id === id)) throw new Error('That default Books rule already exists.');
      rule = { id, ...selector, books, keep };
      next = [...rules, rule];
    } else {
      if (!target || role !== undefined || department !== undefined || books.length || keep) {
        throw new Error('Use remove with one rule id.');
      }
      const found = rules.find(candidate => candidate.id === target);
      if (!found) throw new Error('No default Books rule has that id.');
      rule = found;
      next = rules.filter(candidate => candidate !== found);
    }
    const plan_id = 'seat-defaults-' + digest({ action, rule, bytes });
    if (preview) return { schema: 1, action, rule, plan_id, written: false };
    if (suppliedId !== plan_id) throw new Error('The default Books plan changed. Preview it again.');
    const attempt = newAttemptId();
    const record = { attempt, when: utcRoundTrip(), verb: 'seat defaults ' + action, seat: '', seat_id: '',
      from_seat: null, plan_id, before: {}, after: {}, rule };
    appendHistoryRecords(workspace, [record]);
    writeAtomicText(file, JSON.stringify({ schema: 1, rules: next }, null, 2) + '\n');
    appendHistoryCommit(workspace, attempt);
    return { schema: 1, action, rule, plan_id, written: true };
  } finally {
    exitBookLock(lock);
  }
}
