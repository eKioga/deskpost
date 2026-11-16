/**
 * WHICH AREA AND LANE EACH FILE IS IN (PLAN-many-builders.md stage 2, points 1, 2 and 7; kickoffs/s206-r2 row 1).
 * `docs/areas.json` places every tracked file under `kernel/src/`, `tools/` and `kernel/test/` in exactly one area or in
 * `shared`, and each area in exactly one lane. The source `tools/kickoff-check.mts` reads it to keep a Kickoff's OWNS
 * PATHS in its lane (Two Builders rule 9).
 *
 *   node tools/areas.mts --check [--repo <dir>]       exit 0 when the file is complete, 1 naming each fault
 *   node tools/areas.mts --book <out file> [--repo <dir>]   the Book page in Markdown, written to <out file> only
 *
 * A listed file that is missing is a warning, not a fault: another unit may delete one, and a later unit removes its line.
 * No commit runs `--check` on the real file (a file another unit adds would turn it red); a Kickoff runs it by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LANE_SECTION_NUMBERS, sectionNumberingFaults } from '../kernel/src/kickoffcheck.ts';

export const AREAS_PATH = 'docs/areas.json';
export const AREA_FOLDERS: readonly string[] = ['kernel/src', 'tools', 'kernel/test'];
const USAGE = 'node tools/areas.mts --check [--repo <dir>] | --book <out file> [--repo <dir>]';

/**
 * `section_ranges` and `grandfathered_sections` (PLAN-lane-test-files.md, Design 1 and 5; kickoffs/s210 row 1): each
 * lane's numbers for new self-test sections, `[first, last]` inside LANE_NUMBERS, and the numbers below it a unit
 * posted before the lane files may still add, by unit id. Both are optional here (a record without them judges no
 * section number); `tools/kickoff-check.mts` refuses a Kickoff that adds sections when they cannot be read.
 */
export type AreasRecord = { schema: 1; lanes: Record<string, string[]>; areas: Record<string, string[]>; shared: string[];
  section_ranges?: Record<string, [number, number]>; grandfathered_sections?: Record<string, number[]> };
export const LANE_NUMBERS = LANE_SECTION_NUMBERS;

/** The record's shape; a record that fails it gets no further check. */
export function shapeProblems(record: unknown): string[] {
  const r = record as Partial<AreasRecord> | null;
  const listOf = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  const mapOf = (value: unknown, each: (item: unknown) => boolean = listOf) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(each);
  const numbers = (value: unknown) => Array.isArray(value) && value.every(item => Number.isInteger(item) && (item as number) > 0);
  if (!r || typeof r !== 'object' || r.schema !== 1) return [`${AREAS_PATH} is not a schema-1 record`];
  return [
    ...(mapOf(r.lanes) ? [] : ['lanes must map each lane to a list of area names']),
    ...(mapOf(r.areas) ? [] : ['areas must map each area to a list of files']),
    ...(listOf(r.shared) ? [] : ['shared must be a list of files']),
    ...(r.section_ranges === undefined || mapOf(r.section_ranges, item => numbers(item) && (item as number[]).length === 2) ? []
      : ['section_ranges must map each lane to [first, last] section numbers']),
    ...(r.grandfathered_sections === undefined || mapOf(r.grandfathered_sections, numbers) ? []
      : ['grandfathered_sections must map each unit id to a list of section numbers']),
  ];
}

/** Faults in a well-shaped record's section numbers: every lane one range, inside LANE_NUMBERS and disjoint; grandfathered numbers below it. */
export function sectionRangeFaults(record: AreasRecord): string[] {
  const ranges = record.section_ranges;
  // Every lane has a range here; the numbering rules themselves are kickoff-check's, so both read them alike (kickoffs/s210-r2 row 3).
  const missing = ranges === undefined ? [] : Object.keys(record.lanes).filter(lane => !Object.hasOwn(ranges, lane)).map(lane => `section_ranges has no range for lane ${lane}`);
  return [...missing, ...sectionNumberingFaults(ranges ?? {}, record.grandfathered_sections ?? {}, Object.keys(record.lanes))];
}

/** Faults and warnings for a well-shaped record against the tracked files under AREA_FOLDERS. */
export function areasProblems(record: AreasRecord, tracked: readonly string[], exists: (file: string) => boolean): { faults: string[]; warnings: string[] } {
  const faults: string[] = [], warnings: string[] = [];
  const homes = new Map<string, string[]>();
  for (const [area, files] of [...Object.entries(record.areas), ['shared', record.shared] as [string, string[]]]) {
    for (const file of files) homes.set(file, [...(homes.get(file) ?? []), area]);
  }
  for (const [file, places] of homes) if (places.length > 1) faults.push(`${file} is in ${places.length} places: ${places.join(', ')}`);
  for (const file of tracked) if (!homes.has(file)) faults.push(`${file} is in no area and not in shared`);
  for (const file of homes.keys()) if (!exists(file)) warnings.push(`${file} is listed but missing`);
  const laneOf = new Map<string, string[]>();
  for (const [lane, areas] of Object.entries(record.lanes)) for (const area of areas) laneOf.set(area, [...(laneOf.get(area) ?? []), lane]);
  if (Object.hasOwn(record.areas, 'shared')) faults.push('area shared is reserved for the shared list');
  for (const area of Object.keys(record.areas)) {
    const lanes = laneOf.get(area) ?? [];
    if (lanes.length === 0) faults.push(`area ${area} is in no lane`);
    if (lanes.length > 1) faults.push(`area ${area} is in ${lanes.length} lanes: ${lanes.join(', ')}`);
  }
  for (const [area, lanes] of laneOf) if (!Object.hasOwn(record.areas, area)) faults.push(`lane ${lanes.join(', ')} names area ${area}, which has no entry in areas`);
  faults.push(...sectionRangeFaults(record));
  return { faults, warnings };
}

/** The Book page: each lane with its files, lines and areas, then each area's files. */
export function bookPage(record: AreasRecord, lines: (file: string) => number): string {
  const count = (files: readonly string[]) => files.reduce((sum, file) => sum + lines(file), 0);
  const rows = Object.entries(record.lanes).map(([lane, areas]) => {
    const files = areas.flatMap(area => record.areas[area] ?? []);
    return `| ${lane} | ${files.length} | ${count(files)} | ${areas.join(', ')} |`;
  });
  rows.push(`| shared | ${record.shared.length} | ${count(record.shared)} | files many areas use |`);
  const sections = [
    ...Object.entries(record.lanes).flatMap(([lane, areas]) => areas.map(area => [`${area} (${lane})`, record.areas[area] ?? []] as const)),
    ['shared', record.shared] as const,
  ].map(([title, files]) => `## ${title}\n\n${files.map(file => `- \`${file}\``).join('\n')}\n`);
  const ranges = record.section_ranges ? ['## New self-test sections', '',
    'Each lane\'s new sections go in `kernel/test/lanes/<lane>.ts` and claim their files in `kernel/test/lanes/<lane>.covers.json`, numbered in its range:', '',
    ...Object.entries(record.section_ranges).map(([lane, [first, last]]) => `- ${lane}: ${first} to ${last}`),
    ...Object.entries(record.grandfathered_sections ?? {}).map(([unit, numbers]) => `- grandfathered, unit ${unit}: ${numbers.join(', ')}`), ''] : [];
  return ['# Areas and lanes', '', `Generated by \`node tools/areas.mts --book\` from \`${AREAS_PATH}\`. A Kickoff names its lane in WHY NOW; its OWNS PATHS stay in that lane's areas or \`shared\`.`, '',
    '| Lane | Files | Lines | Areas |', '|---|---|---|---|', ...rows, '', ...ranges, ...sections].join('\n');
}

function main(argv: string[]): number {
  const take = (flag: string) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv.splice(at, 2)[1] ?? ''; };
  const given = take('--repo');
  const repo = path.resolve(given ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const check = argv[0] === '--check' ? (argv.shift(), true) : false;
  const book = check ? undefined : take('--book');
  if ((!check && !book) || argv.length || given === '') {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  let record: unknown;
  try { record = JSON.parse(fs.readFileSync(path.join(repo, AREAS_PATH), 'utf8')); }
  catch (error) { process.stderr.write(`areas: cannot read ${AREAS_PATH} in ${repo}: ${(error as Error).message}\n`); return 1; }
  const shape = shapeProblems(record);
  if (shape.length) { process.stdout.write(`areas: ${AREAS_PATH} is not complete:\n${shape.map(line => `- ${line}`).join('\n')}\n`); return 1; }
  const git = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', ...AREA_FOLDERS], { encoding: 'utf8', windowsHide: true });
  if (git.status !== 0) { process.stderr.write(`areas: git ls-files failed in ${repo}: ${(git.stderr || git.error?.message || '').trim()}\n`); return 1; }
  const tracked = git.stdout.split('\0').filter(Boolean);
  const exists = (file: string) => fs.existsSync(path.join(repo, file));
  const { faults, warnings } = areasProblems(record as AreasRecord, tracked, exists);
  const warned = warnings.map(line => `areas: warning: ${line}\n`).join('');
  if (faults.length) { process.stdout.write(`${warned}areas: ${AREAS_PATH} is not complete:\n${faults.map(line => `- ${line}`).join('\n')}\n`); return 1; }
  if (check) { process.stdout.write(`${warned}areas: ${AREAS_PATH} is complete (${tracked.length} tracked files).\n`); return 0; }
  const lines = (file: string) => {
    const text = exists(file) ? fs.readFileSync(path.join(repo, file), 'utf8') : '';
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  fs.writeFileSync(book!, bookPage(record as AreasRecord, lines));
  process.stdout.write(`${warned}areas: wrote ${book}\n`);
  return 0;
}

const invoked = process.argv[1] ?? '';
if (/areas\.mts$/.test(invoked.replace(/\\/g, '/'))) process.exit(main(process.argv.slice(2)));
