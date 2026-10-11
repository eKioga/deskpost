/**
 * A seat's card, department, role and template (1.3.8, kickoffs/s96 row 1, PLAN-seats-team.md session 1 row 1,
 * ADR-0069): four optional fields on `.claude/seats/_registry.json` rows, written after the existing four.
 *
 * - `department`: a slug. A department exists while a seat carries it; there is no departments file.
 * - `role`: `performer` or `orchestrator`. A role requires a department, and a department has at most one orchestrator.
 * - `card`: one line of at most 160 characters, with no control character (tab included: a card is one line of terminal
 *   text); what the seat handles, in its own words.
 * - `template`: `<name>@<version>`, the template the seat was created from. Validated here; session 2 writes it.
 * - `nickname` (kickoffs/s112 ruling 4; PLAN-seat-identity.md section 6): a short label for the menu and the tab, 1-16
 *   characters of letters, digits, space, `-`, `_` and `.`, no space at either end. Compared without regard to capital
 *   letters, shown as typed. Unique among nicknames and never any seat's name, current or past; NEVER AN ADDRESS.
 *
 * THE READER NEVER THROWS ON THESE FIELDS. The registry has many readers, and `readSeatRegistry` keeps failing closed
 * only on what it always did (bad JSON, a missing seat or project). A malformed value, a role with no department, or a
 * second orchestrator in a department reads as ABSENT here, and doctor's `seats.registry-fields` names it with the
 * repair. ONE PROJECTION OVER THE WHOLE REGISTRY serves every reader-facing surface (`seat status`, the menu, `seat
 * cards`, `library desk`), because "one orchestrator per department" is a property of the registry, not of a row; the
 * raw rows are kept for lossless writes only, so a malformed card never reaches a terminal.
 *
 * A LEAF MODULE: it imports nothing of the kernel's but the control-character rule, so `desk.ts`, `seat.ts` and the
 * menu can all use it without a cycle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { controlCharacterInLine } from './controlchars.ts';

export const METADATA_FIELDS = ['department', 'role', 'card', 'template', 'nickname'] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

export const SEAT_ROLES = ['performer', 'orchestrator'] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export const CARD_MAX_CHARACTERS = 160;
export const DEPARTMENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const TEMPLATE_PATTERN = /^[a-z0-9][a-z0-9-]*@[0-9]+(\.[0-9]+)*$/;
export const NICKNAME_MAX_CHARACTERS = 16;
const NICKNAME_CHARACTERS = /^[A-Za-z0-9 _.-]+$/;

export interface SeatMetadata {
  department: string | null;
  role: SeatRole | null;
  card: string | null;
  template: string | null;
  nickname: string | null;
}

export const NO_METADATA: SeatMetadata = Object.freeze({ department: null, role: null, card: null, template: null, nickname: null });

export interface DepartmentView {
  department: string;
  /** The department's one orchestrator, or null when it has none (or more than one, which reads as none). */
  orchestrator: string | null;
  /** Every seat whose department reads as this one, sorted. */
  seats: string[];
}

export interface SeatMetadataProjection {
  /** Every registry row's validated fields, by seat; a field that does not validate is null. */
  seats: Map<string, SeatMetadata>;
  /** The departments seats carry, sorted, each with its orchestrator. */
  departments: DepartmentView[];
  /** One sentence per value read as absent, naming the seat, the field and the repair. Never the value itself. */
  problems: string[];
}

/** Why a department value is refused, or null when it is a slug. */
export function departmentProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'a department is a slug (lowercase letters, digits and hyphens)';
  return DEPARTMENT_PATTERN.test(value) ? null : 'a department is a slug: lowercase letters, digits and hyphens, starting with a letter or a digit';
}

/** Why a role value is refused, or null when it is one of the two. */
export function roleProblem(value: unknown): string | null {
  return typeof value === 'string' && (SEAT_ROLES as readonly string[]).includes(value) ? null : `a role is ${SEAT_ROLES.join(' or ')}`;
}

/** Why a card value is refused, or null when it is one line of at most 160 characters with no control character. */
export function cardProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'a card is one line of text';
  if (value.trim() === '') return 'a card is one line of text, and this one is empty; clear it with --clear-card instead';
  const control = controlCharacterInLine(value);
  if (control !== null) return `a card is one line with no control character, and this one holds ${control.codePoint} (${control.name})`;
  const length = [...value].length;
  if (length > CARD_MAX_CHARACTERS) return `a card is at most ${CARD_MAX_CHARACTERS} characters, and this one is ${length}`;
  return null;
}

/** Why a template value is refused, or null when it is `<name>@<version>`. */
export function templateProblem(value: unknown): string | null {
  return typeof value === 'string' && TEMPLATE_PATTERN.test(value) ? null : 'a template is <name>@<version>, such as performer@1';
}

/** Why a nickname value is refused, or null when it is 1-16 allowed characters with no space at either end. */
export function nicknameProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return `a nickname is 1-${NICKNAME_MAX_CHARACTERS} characters`;
  const length = [...value].length;
  if (length > NICKNAME_MAX_CHARACTERS) return `a nickname is at most ${NICKNAME_MAX_CHARACTERS} characters, and this one is ${length}`;
  if (!NICKNAME_CHARACTERS.test(value)) return "a nickname holds only letters, digits, spaces, '-', '_' and '.'";
  if (value !== value.trim()) return 'a nickname has no space at either end';
  return null;
}

/** A nickname or a name as nicknames compare: without regard to capital letters. */
export function nicknameKey(value: string): string {
  return value.toLowerCase();
}

const PROBLEM: Record<MetadataField, (value: unknown) => string | null> = {
  department: departmentProblem,
  role: roleProblem,
  card: cardProblem,
  template: templateProblem,
  nickname: nicknameProblem,
};

/** Why one field's value is refused, or null. */
export function fieldProblem(field: MetadataField, value: unknown): string | null {
  return PROBLEM[field](value);
}

/** Whether a raw row carries any of the fields (any value, valid or not). */
export function carriesMetadata(row: Record<string, unknown>): boolean {
  return METADATA_FIELDS.some((field) => field in row && row[field] !== null && row[field] !== undefined);
}

/** A raw row's values as written (null when absent), for a history record or a plan id. Never validated. */
export function rawMetadata(row: Record<string, unknown> | undefined): Record<MetadataField, unknown> {
  const out = {} as Record<MetadataField, unknown>;
  for (const field of METADATA_FIELDS) {
    const present = row && field in row && row[field] !== undefined && row[field] !== null;
    // A NICKNAME IS LEFT OUT WHERE A SEAT HAS NONE, so a history record or a preview of a seat without one reads as it
    // did before nicknames (kickoffs/s112 ruling 4; the plan's Proof keeps every existing expectation).
    if (OPTIONAL_FIELDS.includes(field) && !present) continue;
    out[field] = present ? row[field] : null;
  }
  return out;
}

/** The fields a record or a preview names only when set. */
export const OPTIONAL_FIELDS: readonly MetadataField[] = ['nickname'];

function sortText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * THE ONE VALIDATED PROJECTION (plan row 1, kickoffs/s96 ruling 3), over the whole registry's raw rows. Nothing throws:
 * a row that is not an object, or names no seat, is skipped (the registry's own reader refuses it elsewhere).
 */
export function seatMetadata(rows: readonly unknown[]): SeatMetadataProjection {
  const seats = new Map<string, SeatMetadata>();
  const problems: string[] = [];
  const said = (seat: string, field: MetadataField, why: string, repair: string): void => {
    problems.push(`seat '${seat}' has a ${field} that is read as absent (${why}); ${repair}`);
  };
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row['seat'] !== 'string' || !row['seat']) continue;
    const seat = row['seat'];
    const meta: SeatMetadata = { department: null, role: null, card: null, template: null, nickname: null };
    for (const field of METADATA_FIELDS) {
      const value = row[field];
      if (value === undefined || value === null) continue;
      const problem = PROBLEM[field](value);
      if (problem !== null) {
        const repair =
          field === 'template'
            ? `remove "template" from that row in .claude/seats/_registry.json, or set it to <name>@<version>`
            : `set it again with deskpost seat describe ${seat} --${field} <value>, or remove it with deskpost seat describe ${seat} --clear-${field}`;
        said(seat, field, problem, repair);
        continue;
      }
      (meta as unknown as Record<string, unknown>)[field] = value;
    }
    if (meta.role !== null && meta.department === null) {
      said(seat, 'role', 'a role requires a department', `give it one with deskpost seat describe ${seat} --department <slug>, or remove the role with --clear-role`);
      meta.role = null;
    }
    seats.set(seat, meta);
  }
  // A NICKNAME IS NO SEAT'S NAME AND ONE SEAT'S ONLY, properties of the whole registry: one that equals a current or past
  // name, or that two seats share, reads as absent, and each is named. Retired names are judged where one is set.
  const names = new Map<string, string>();
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row['seat'] !== 'string' || !row['seat']) continue;
    names.set(nicknameKey(row['seat']), row['seat']);
    if (Array.isArray(row['names'])) {
      for (const span of row['names']) {
        const name = span !== null && typeof span === 'object' ? (span as Record<string, unknown>)['name'] : undefined;
        if (typeof name === 'string' && name) names.set(nicknameKey(name), row['seat']);
      }
    }
  }
  const byNickname = new Map<string, string[]>();
  for (const [seat, meta] of seats) {
    if (meta.nickname === null) continue;
    const owner = names.get(nicknameKey(meta.nickname));
    if (owner !== undefined) {
      meta.nickname = null;
      said(seat, 'nickname', `it is a name of seat '${owner}', and a nickname is never a seat's name`, `set another with deskpost seat describe ${seat} --nickname <value>, or remove it with deskpost seat describe ${seat} --clear-nickname`);
      continue;
    }
    byNickname.set(nicknameKey(meta.nickname), [...(byNickname.get(nicknameKey(meta.nickname)) ?? []), seat]);
  }
  for (const holders of byNickname.values()) {
    if (holders.length < 2) continue;
    for (const seat of holders) {
      seats.get(seat)!.nickname = null;
      said(seat, 'nickname', `seats ${holders.join(', ')} share it, and a nickname is one seat's`, `keep it on one and set another on the rest with deskpost seat describe <seat> --nickname <value>`);
    }
  }
  // ONE ORCHESTRATOR PER DEPARTMENT, a property of the whole registry: two read as none, and each is named.
  const byDepartment = new Map<string, string[]>();
  for (const [seat, meta] of seats) {
    if (meta.department === null) continue;
    const list = byDepartment.get(meta.department) ?? [];
    list.push(seat);
    byDepartment.set(meta.department, list);
  }
  const departments: DepartmentView[] = [];
  for (const department of [...byDepartment.keys()].sort(sortText)) {
    const members = byDepartment.get(department)!.sort(sortText);
    const orchestrators = members.filter((seat) => seats.get(seat)!.role === 'orchestrator');
    if (orchestrators.length > 1) {
      for (const seat of orchestrators) {
        seats.get(seat)!.role = null;
        said(
          seat,
          'role',
          `department '${department}' has ${orchestrators.length} orchestrators (${orchestrators.join(', ')}), and a department has one`,
          `keep one and make the others performers with deskpost seat describe <seat> --role performer`,
        );
      }
    }
    departments.push({ department, orchestrator: orchestrators.length === 1 ? orchestrators[0]! : null, seats: members });
  }
  return { seats, departments, problems };
}

/** The seat whose nickname `name` is, compared without regard to capital letters; null when it is no seat's. */
export function nicknameOwner(projection: SeatMetadataProjection, name: string): string | null {
  const key = nicknameKey(name);
  for (const [seat, meta] of projection.seats) if (meta.nickname !== null && nicknameKey(meta.nickname) === key) return seat;
  return null;
}

/** How the menu row and the tab name a seat: `<nickname> (<seat>)` when it has one, else the seat. */
export function seatLabel(seat: string, nickname: string | null | undefined): string {
  return nickname ? `${nickname} (${seat})` : seat;
}

/** One seat's validated fields from a projection, or none. */
export function metadataFor(projection: SeatMetadataProjection, seat: string): SeatMetadata {
  return projection.seats.get(seat) ?? { ...NO_METADATA };
}

/** The department a seat's projection names, with its orchestrator, or null. */
export function departmentOf(projection: SeatMetadataProjection, seat: string): DepartmentView | null {
  const department = projection.seats.get(seat)?.department ?? null;
  return department === null ? null : projection.departments.find((view) => view.department === department) ?? null;
}

/**
 * ONE DESTINATION PER DEPARTMENT (kickoffs/s110 ruling 7; PLAN-seat-identity.md section 4; ADR-0073): its orchestrator,
 * else its only seat, else none, with its seats. `capture --for-department`, `seat cards`, the retire preview and the
 * wizard all ask here, so they cannot disagree. A department no seat carries has no destination and no seats.
 */
export type DepartmentDestination =
  | { kind: 'orchestrator'; seat: string; seats: string[] }
  | { kind: 'only-seat'; seat: string; seats: string[] }
  | { kind: 'none'; seat: null; seats: string[] };

export function departmentDestination(view: DepartmentView | null | undefined): DepartmentDestination {
  const seats = view?.seats ?? [];
  if (view && view.orchestrator !== null) return { kind: 'orchestrator', seat: view.orchestrator, seats };
  if (seats.length === 1) return { kind: 'only-seat', seat: seats[0]!, seats };
  return { kind: 'none', seat: null, seats };
}

/** A department's destination in a projection, by name; a department no seat carries is `none` with no seats. */
export function destinationOf(projection: SeatMetadataProjection, department: string): DepartmentDestination {
  return departmentDestination(projection.departments.find((view) => view.department === department));
}

/**
 * The projection of the registry file under a state directory, read here and NEVER THROWING: a file that cannot be
 * read or parsed gives an empty projection with one problem, and the registry's own reader says the rest.
 */
export function readSeatMetadata(stateDirectory: string): SeatMetadataProjection {
  const file = path.join(stateDirectory, 'seats', '_registry.json');
  if (!fs.existsSync(file)) return { seats: new Map(), departments: [], problems: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { seats?: unknown };
    const seats = parsed && typeof parsed === 'object' ? parsed.seats : undefined;
    const rows = Array.isArray(seats) ? seats : seats === null || seats === undefined ? [] : [seats];
    return seatMetadata(rows);
  } catch (error) {
    return { seats: new Map(), departments: [], problems: [`the seat registry at ${file} could not be read for its seats' cards and roles: ${(error as Error).message}`] };
  }
}

/** A seat's metadata as JSON keys, always all four (null when absent), for `seat status` and the Desk. */
export function metadataJson(meta: SeatMetadata): { department: string | null; role: string | null; card: string | null; template: string | null } {
  return { department: meta.department, role: meta.role, card: meta.card, template: meta.template };
}

/** "orchestrator of engineering", "performer in engineering", "in engineering", or '' with no department. */
export function roleLabel(meta: SeatMetadata): string {
  if (meta.department === null) return '';
  if (meta.role === 'orchestrator') return `orchestrator of ${meta.department}`;
  if (meta.role === 'performer') return `performer in ${meta.department}`;
  return `in ${meta.department}`;
}
