/**
 * THE BUILT-IN SEAT TEMPLATES (PLAN-seats-team.md session 2 item 0, kickoffs/s97 row 0): `templates/seats/<name>.json`
 * in the program's own tree, found by the route `init` takes to `templates/workspace-instructions.md`, in the checkout
 * and in a release alike (the release keeps every file that is not PowerShell, `releasefiles.ts`).
 *
 * A TEMPLATE IS `{schema: 1, name, version, role, purpose}` AND NOTHING MORE. Books are chosen in the wizard, and only
 * "Show me around" has a first prompt. `purpose` is appendix B's role text: `{project}` is filled at creation, and it
 * names no seat and no department, since both come from `seat cards` when read. Its last sentence, "Seat template:
 * <name> v<n>.", is creation provenance for a human reader; the registry's `template` field is what the program reads.
 *
 * AN UNKNOWN NAME, AN UNKNOWN SCHEMA OR A MALFORMED FILE IS REFUSED, naming what was wrong, never guessed past.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { controlCharacterInLine } from './controlchars.ts';

export const SEAT_TEMPLATE_SCHEMA = 1;
export const SEAT_TEMPLATE_ROLES = ['performer', 'orchestrator'] as const;
export type SeatTemplateRole = (typeof SEAT_TEMPLATE_ROLES)[number];

export interface SeatTemplate {
  schema: number;
  name: string;
  version: number;
  role: SeatTemplateRole;
  purpose: string;
}

export class SeatTemplateRefusal extends Error {}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = ['schema', 'name', 'version', 'role', 'purpose'];
const PROJECT = '{project}';

function refuse(message: string): never {
  throw new SeatTemplateRefusal(message);
}

/** Where the built-in templates live in a program tree. */
export function seatTemplateDirectory(programRoot: string): string {
  return path.join(programRoot, 'templates', 'seats');
}

/** The built-in template names, sorted: every `<name>.json` whose name is a slug. */
export function seatTemplateNames(programRoot: string): string[] {
  const directory = seatTemplateDirectory(programRoot);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.json') && NAME.test(file.slice(0, -5)))
    .map((file) => file.slice(0, -5))
    .sort();
}

/** The template `<name>@<version>`, as the registry's `template` field records it. */
export function seatTemplateId(template: SeatTemplate): string {
  return `${template.name}@${template.version}`;
}

/** The provenance sentence a template's purpose ends with. */
export function seatTemplateProvenance(name: string, version: number): string {
  return `Seat template: ${name} v${version}.`;
}

/** One built-in template, read and validated whole. */
export function loadSeatTemplate(programRoot: string, name: string): SeatTemplate {
  const names = seatTemplateNames(programRoot);
  const known = names.length ? names.join(', ') : 'none (templates/seats/ is missing from this program)';
  if (!NAME.test(name) || !names.includes(name)) refuse(`Unknown seat template '${name}'. The built-in templates are: ${known}.`);
  const file = path.join(seatTemplateDirectory(programRoot), `${name}.json`);
  const label = `templates/seats/${name}.json`;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    refuse(`Seat template ${label} is malformed: it is not valid JSON (${(error as Error).message}).`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(`Seat template ${label} is malformed: it is not a JSON object.`);
  const record = value as Record<string, unknown>;
  if (record['schema'] !== SEAT_TEMPLATE_SCHEMA) {
    refuse(`Seat template ${label} has an unknown schema (${JSON.stringify(record['schema'] ?? null)}); this program reads schema ${SEAT_TEMPLATE_SCHEMA}.`);
  }
  const extra = Object.keys(record).filter((key) => !KEYS.includes(key));
  if (extra.length) refuse(`Seat template ${label} is malformed: it has keys a template does not carry (${extra.join(', ')}); a template is ${KEYS.join(', ')} and nothing more.`);
  if (record['name'] !== name) refuse(`Seat template ${label} is malformed: its name is ${JSON.stringify(record['name'] ?? null)}, not '${name}'.`);
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    refuse(`Seat template ${label} is malformed: its version must be a whole number from 1, not ${JSON.stringify(version ?? null)}.`);
  }
  const role = record['role'];
  if (typeof role !== 'string' || !(SEAT_TEMPLATE_ROLES as readonly string[]).includes(role)) {
    refuse(`Seat template ${label} is malformed: its role must be ${SEAT_TEMPLATE_ROLES.join(' or ')}, not ${JSON.stringify(role ?? null)}.`);
  }
  const purpose = record['purpose'];
  if (typeof purpose !== 'string' || !purpose.trim()) refuse(`Seat template ${label} is malformed: its purpose is missing or empty.`);
  const stray = controlCharacterInLine(purpose);
  if (stray !== null) refuse(`Seat template ${label} is malformed: its purpose holds ${stray.name} (${stray.codePoint}); it is one paragraph of text.`);
  if (!purpose.includes(PROJECT)) refuse(`Seat template ${label} is malformed: its purpose does not name ${PROJECT}.`);
  if (!purpose.endsWith(seatTemplateProvenance(name, version))) {
    refuse(`Seat template ${label} is malformed: its purpose must end with "${seatTemplateProvenance(name, version)}", its own name and version.`);
  }
  return { schema: SEAT_TEMPLATE_SCHEMA, name, version, role: role as SeatTemplateRole, purpose };
}

/** The purpose a new seat's Hub is created with: `{project}` filled, everything else word for word. */
export function fillSeatTemplate(template: SeatTemplate, project: string): string {
  return template.purpose.split(PROJECT).join(project);
}
