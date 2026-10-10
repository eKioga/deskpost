/**
 * ONE PLANNER FOR A NEW SEAT, FOR `seat start --preflight` AND THE `+` WIZARD (PLAN-seats-team.md session 2 item 2,
 * kickoffs/s97 row 1): it validates a new seat's department, role, card, template and Books, applies the defaults, and
 * issues the WRAPPED plan id the apply must carry.
 *
 * THE CREATION ID IS UNTOUCHED. `seatCreationPlanId` is `Get-SeatCreationPlanId` (tools/SeatCreation.ps1) byte for
 * byte, moved here from seat.ts unchanged so the two callers share one copy; it covers only the `seat=project` pairs.
 * The wrapped id is sha256 over that id, THE DIGEST OF THE WHOLE REGISTRY FILE (so a metadata-only change to any row
 * still forces a new preview), the template's name and version, the department, role and card, and the Books in sorted
 * order. A seat started with none of the five options keeps the plain creation id route exactly as before; with any of
 * them, only the wrapped id applies.
 *
 * Every refusal ends "Nothing was created." and is raised before anything is written.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psSortCompare } from './notebook.ts';
import { cardProblem, departmentProblem, rawMetadata, roleProblem, type SeatRole } from './seatmeta.ts';
import { fillSeatTemplate, loadSeatTemplate, seatTemplateId, type SeatTemplate } from './seattemplates.ts';

export class SeatStartPlanRefusal extends Error {}

const NOTHING = 'Nothing was created.';

function refuse(message: string): never {
  throw new SeatStartPlanRefusal(message);
}

/** The five options that only a preview can set, as `seat start` spells them. */
export const SEAT_START_OPTIONS = ['department', 'role', 'card', 'template', 'open-book', 'inbound'] as const;

const BOOK_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WRAPPED_PLAN_PREFIX = 'seat-start-';

/** Get-SeatCreationPlanId: this seat, this Project, and the registry as it stands. The same bytes as PowerShell's. */
export function seatCreationPlanId(rows: Record<string, PsJsonValue>[], seat: string, project: string): string {
  const lines = rows.map((row) => `${String(row['seat'])}=${String(row['project'])}`).sort(psSortCompare);
  const digest = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  return crypto.createHash('sha256').update(`${seat}|${project}|${digest}`, 'utf8').digest('hex').substring(0, 16);
}

/** The whole registry file's digest, or `absent`, as `seat describe` binds it. */
export function registryFileDigest(file: string): string {
  if (!fs.existsSync(file)) return 'absent';
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Whether a plan id is the wrapped form rather than the plain creation id. */
export function isWrappedPlanId(planId: string): boolean {
  return planId.startsWith(WRAPPED_PLAN_PREFIX);
}

export interface SeatStartOptions {
  department?: string | undefined;
  role?: string | undefined;
  card?: string | undefined;
  template?: string | undefined;
  openBooks?: string[] | undefined;
  /** The new seat's inbound policy, `accept`, `hold`, `refuse` or `unset` (kickoffs/s108 ruling 6). */
  inbound?: string | undefined;
  /** The program tree the templates are read from. */
  programRoot: string;
  /** The workspace whose Shelf holds the Books. */
  workspace: string;
  /** `registryFileDigest` of the registry file the rows were read from. */
  registryDigest: string;
}

export interface SeatStartPlan {
  creationId: string;
  planId: string;
  /** Whether any of the five options was given. */
  options: boolean;
  department: string | null;
  role: SeatRole | null;
  card: string | null;
  template: SeatTemplate | null;
  /** `<name>@<version>`, as the registry's `template` field records it. */
  templateId: string | null;
  books: string[];
  /** The inbound policy written for the new seat at creation, or null when none was given (kickoffs/s108 ruling 6). */
  inbound: string | null;
  /** The template's purpose with `{project}` filled, or null with no template. */
  purpose: string | null;
  /** The department's orchestrator before this seat, or null (none, or no department). */
  orchestrator: string | null;
  /** A department no seat carries yet. */
  createsDepartment: boolean;
}

/** The orchestrator of a department in these rows, or null. */
export function departmentOrchestrator(rows: Record<string, PsJsonValue>[], department: string): string | null {
  const found = rows.find((row) => {
    const meta = rawMetadata(row);
    return meta.role === 'orchestrator' && meta.department === department;
  });
  return found ? String(found['seat']) : null;
}

/** The departments seats carry, sorted, for the wizard's list. */
export function registryDepartments(rows: Record<string, PsJsonValue>[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const department = rawMetadata(row).department;
    if (typeof department === 'string' && departmentProblem(department) === null) names.add(department);
  }
  return [...names].sort(psSortCompare);
}

/** The four registry fields a plan sets, in the registry's order, for the row and the history record. */
export function planFields(plan: SeatStartPlan): { department: string | null; role: string | null; card: string | null; template: string | null } {
  return { department: plan.department, role: plan.role, card: plan.card, template: plan.templateId };
}

/** Whether a plan sets any registry field (Books alone set none). */
export function planSetsFields(plan: SeatStartPlan): boolean {
  return plan.department !== null || plan.role !== null || plan.card !== null || plan.templateId !== null;
}

export function seatStartPlan(rows: Record<string, PsJsonValue>[], seat: string, project: string, options: SeatStartOptions): SeatStartPlan {
  const given = (value: string | undefined): value is string => value !== undefined;
  const books = [...new Set(options.openBooks ?? [])].sort(psSortCompare);
  const any = given(options.department) || given(options.role) || given(options.card) || given(options.template) || books.length > 0 || given(options.inbound);
  // THE INBOUND POLICY (kickoffs/s108 ruling 6), as `seat settings` takes it.
  const inbound = given(options.inbound) ? options.inbound.trim() : null;
  if (inbound !== null && !['accept', 'hold', 'refuse', 'unset'].includes(inbound)) {
    refuse(`--inbound takes accept, hold, refuse or unset; '${inbound}' is not one. ${NOTHING}`);
  }

  if (given(options.department)) {
    const problem = departmentProblem(options.department);
    if (problem) refuse(`--department '${options.department}' is refused: ${problem}. ${NOTHING}`);
  }
  if (given(options.role)) {
    const problem = roleProblem(options.role);
    if (problem) refuse(`--role '${options.role}' is refused: ${problem}. ${NOTHING}`);
  }
  if (given(options.card)) {
    // NEVER ECHOED: a card that fails may hold the very characters the rule keeps off a terminal.
    const problem = cardProblem(options.card);
    if (problem) refuse(`--card is refused: ${problem}. ${NOTHING}`);
  }
  let template: SeatTemplate | null = null;
  if (given(options.template)) {
    try {
      template = loadSeatTemplate(options.programRoot, options.template);
    } catch (error) {
      refuse(`${(error as Error).message} ${NOTHING}`);
    }
  }
  // THE TEMPLATE'S ROLE IS THE DEFAULT, AND A ROLE THAT DISAGREES WITH IT IS REFUSED rather than chosen between.
  let role = (given(options.role) ? options.role : null) as SeatRole | null;
  if (template !== null) {
    if (role !== null && role !== template.role) {
      refuse(`--role ${role} disagrees with template '${template.name}', whose role is ${template.role}. Leave out --role, or use the other template. ${NOTHING}`);
    }
    role = template.role;
  }
  const department = given(options.department) ? options.department : null;
  if (role !== null && department === null) {
    const from = template !== null && !given(options.role) ? `Template '${template.name}' gives this seat the role ${role}, and a` : 'A';
    refuse(`${from} role requires a department: give one with --department <slug>. ${NOTHING}`);
  }
  const orchestrator = department !== null ? departmentOrchestrator(rows, department) : null;
  if (role === 'orchestrator' && orchestrator !== null) {
    refuse(
      `Department '${department}' already has an orchestrator, '${orchestrator}', and a department has one. Create '${seat}' as a performer, ` +
        `then hand the role over with deskpost seat describe ${seat} --role orchestrator --from ${orchestrator}. ${NOTHING}`,
    );
  }
  for (const slug of books) {
    if (!BOOK_SLUG.test(slug)) refuse(`--open-book '${slug}' is not a Book slug: lowercase letters, digits and single hyphens. ${NOTHING}`);
    if (!fs.existsSync(path.join(options.workspace, 'shelf', slug, 'wiki'))) {
      refuse(`No Shelf Book '${slug}' exists at shelf/${slug}/wiki, so it cannot be opened on the new seat's Desk. ${NOTHING}`);
    }
  }

  const creationId = seatCreationPlanId(rows, seat, project);
  const card = given(options.card) ? options.card : null;
  const templateId = template !== null ? seatTemplateId(template) : null;
  const planId =
    WRAPPED_PLAN_PREFIX +
    crypto
      .createHash('sha256')
      // `inbound` ONLY WHEN GIVEN, so every plan id issued without it stays what it was.
      .update(JSON.stringify({ creation: creationId, registry: options.registryDigest, template: templateId, department, role, card, books, ...(inbound !== null ? { inbound } : {}) }), 'utf8')
      .digest('hex');
  return {
    creationId,
    planId,
    options: any,
    department,
    role,
    card,
    template,
    templateId,
    books,
    inbound,
    purpose: template !== null ? fillSeatTemplate(template, project) : null,
    orchestrator,
    createsDepartment: department !== null && !registryDepartments(rows).includes(department),
  };
}
