/**
 * WHICH KERNEL SELF-TEST SECTIONS A COMMIT RUNS (PLAN-powershell-free-development.md, Session 1 item 3; kickoffs/s113
 * ruling 15). Pure: `tools/gate.ts` feeds it what git says changed, and self-test section 215 judges it on fixtures.
 *
 * THE CLAIM MAP is `kernel/test/section-covers.json`: each section names the `kernel/src` files it covers. It was
 * seeded in S113 from each section's own imports, the verbs it runs through the CLI and the modules those verbs call,
 * and every file no section reached that way is claimed by the sections that claim a file importing it. The rules:
 *   (a) a `kernel/src` file no section claims is refused, so the map cannot go stale quietly (`unclaimedFiles`);
 *   (b) every section claiming a changed `kernel/src` file runs;
 *   (c) a changed file on the shared list (below) runs every section; added claim-map keys select their sections,
 *       while changed existing claims, removed keys or an unavailable earlier map run every section;
 *   (d) a changed `kernel/test/selftest.ts` maps each changed hunk to the sections whose `if (selected(N))` blocks hold
 *       it, read from the file at the new revision. A hunk may span sections' functions and run guards, in either
 *       order, with blank lines between; every nonblank line must belong to a section, and each section's lines select
 *       it. A hunk reaching imports, shared helpers, the runner or the verdict runs every section, and so does a hunk
 *       across two sections with any old side (only the new side is read, so a replaced line could be a helper); only
 *       a pure addition (old count 0, or no `oldCount` at all) selects each section it touches.
 * The cut tier always runs every section, so a wrong claim costs at most one cut.
 *
 * THE LINUX SELECTION (kickoffs/s153 row 6), below, is the one platform policy every caller applies after these rules.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

export const CHECK_MAP_PATH = 'tools/check-map.json';
class UnmappedPathError extends Error {
  constructor(file: string) { super(`unmapped changed path ${file}: add its covering checks to ${CHECK_MAP_PATH}`); }
}
type CheckRule = { pattern: string; sections: number[] | 'named'; checks: string[]; contract?: string };
const checkMap = JSON.parse(fs.readFileSync(new URL('./check-map.json', import.meta.url), 'utf8')) as {schema:number;paths:CheckRule[];wholeSuite?:Record<string,string>};
if (checkMap.schema !== 1 || !Array.isArray(checkMap.paths) || checkMap.paths.some(row =>
  typeof row.pattern !== 'string' || !(row.sections === 'named' || Array.isArray(row.sections) && row.sections.every(n => Number.isInteger(n) && n > 0))
  || (row.contract !== undefined && (typeof row.contract !== 'string' || !row.contract || row.sections !== 'named' && !row.sections.length && !row.checks?.length))
  || !Array.isArray(row.checks) || row.checks.some(n => typeof n !== 'string' || !n))) throw Error(`${CHECK_MAP_PATH}: invalid mapping`);
const rules = checkMap.paths.map(row => ({...row, match: new RegExp(row.pattern)}));
export function contractDocuments(): { match: (file: string) => boolean; why: string }[] {
  return rules.filter(row => row.contract).map(row => ({match: file => row.match.test(file), why: row.contract!}));
}
export function pathChecks(changed: readonly string[]): string[] {
  return [...new Set(changed.flatMap(file => rules.filter(row => row.match.test(file)).flatMap(row => row.checks)))].sort();
}

export const COVERS_PATH = 'kernel/test/section-covers.json';
export const SELFTEST_PATH = 'kernel/test/selftest.ts';

/**
 * THE LANE FILES (PLAN-lane-test-files.md, Design 2, 3 and 5; kickoffs/s210 row 2). Each lane's new sections live in
 * `kernel/test/lanes/<lane>.ts` and claim their files in `kernel/test/lanes/<lane>.covers.json`; `selftest.ts` runs them
 * after its own, in this order (docs/areas.json `lanes`). Every reader of sections reads the SECTION SOURCES: the legacy
 * file, then each lane file, in that order. A lane file absent from a tree (a fixture, an older commit) is no source.
 */
const FALLBACK_LANES: readonly string[] = ['seats-and-screens', 'books-and-memory', 'hubs-and-letters', 'notebook-and-install', 'guards-and-tooling'];
function configuredLanes(areasText: string | null): readonly string[] {
  if (areasText !== null) {
    try {
      const ranges = JSON.parse(areasText.replace(/^\uFEFF/, '')).section_ranges;
      if (ranges && typeof ranges === 'object' && !Array.isArray(ranges))
        return [...new Set([...Object.keys(ranges), ...FALLBACK_LANES])];
    } catch { /* checkedLanes reports malformed areas files, including their path. */ }
  }
  return FALLBACK_LANES;
}
const areasUrl = new URL('../docs/areas.json', import.meta.url);
export const LANES: readonly string[] = configuredLanes(fs.existsSync(areasUrl) ? fs.readFileSync(areasUrl, 'utf8') : null);
export const LANES_FOLDER = 'kernel/test/lanes';
export const laneTestPath = (lane: string): string => `${LANES_FOLDER}/${lane}.ts`;
export const laneCoversPath = (lane: string): string => `${LANES_FOLDER}/${lane}.covers.json`;
export const isLaneTestFile = (file: string): boolean => LANES.some(lane => file === laneTestPath(lane));
export const isLaneCoversFile = (file: string): boolean => LANES.some(lane => file === laneCoversPath(lane));

/** One file that holds sections, repository-relative, with its text. */
export interface SectionSource { file: string; text: string }

/** The section sources from a reader of repository-relative paths (null: no such file); the legacy file must exist. */
export function sectionSources(read: (file: string) => string | null): SectionSource[] {
  const legacy = read(SELFTEST_PATH);
  if (legacy === null) throw new Error(`${SELFTEST_PATH} is missing`);
  const areasText = read('docs/areas.json');
  return checkedLanes([{ file: SELFTEST_PATH, text: legacy }, ...configuredLanes(areasText).flatMap(lane => {
    const text = read(laneTestPath(lane));
    return text === null ? [] : [{ file: laneTestPath(lane), text, lane }];
  })], areasText, 'docs/areas.json');
}

/** The section sources of a suite on disk: the suite file, then each lane file in the `lanes` folder beside it. */
export function suiteSources(suite: string): SectionSource[] {
  const folder = suite.replace(/[\\/][^\\/]*$/, '');
  const areas = `${folder}/../../docs/areas.json`;
  const areasText = fs.existsSync(areas) ? fs.readFileSync(areas, 'utf8') : null;
  return checkedLanes([{ file: suite, text: fs.readFileSync(suite, 'utf8') }, ...configuredLanes(areasText).flatMap(lane => {
    const file = `${folder}/lanes/${lane}.ts`;
    return fs.existsSync(file) ? [{ file, text: fs.readFileSync(file, 'utf8'), lane }] : [];
  })], areasText, areas);
}

/**
 * EVERY READER REFUSES A LANE FILE IT CANNOT READ (kickoffs/s210-r2 row 2): each lane file is held to `laneFormatProblems`
 * and to its lane's `section_ranges` whenever docs/areas.json exists. One error names every problem, so no reader drops
 * a section quietly; fixture suites without an areas file keep their format checks.
 */
function checkedLanes(sources: (SectionSource & { lane?: string })[], areasText: string | null, areasFile: string): SectionSource[] {
  let ranges: Record<string, unknown> = {};
  let grandfathered = new Set<number>();
  if (areasText !== null) {
    try {
      const areas = JSON.parse(areasText.replace(/^﻿/, '')) as { section_ranges?: Record<string, unknown>; grandfathered_sections?: Record<string, number[]> };
      ranges = areas.section_ranges ?? {};
      grandfathered = new Set(Object.values(areas.grandfathered_sections ?? {}).flat().filter(Number.isInteger));
    }
    catch (error) { throw new Error(`${areasFile} cannot be read for the lane ranges: ${(error as Error).message}`); }
  }
  const problems = sources.flatMap(source => {
    const dispatch = dispatchProblems(source.file, source.text);
    if (source.lane === undefined) return [...dispatch, ...legacyNumberProblems(source.file, source.text, grandfathered)];
    const range = ranges[source.lane];
    const valid = Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger)
      && range[0] >= 1000 && range[1] <= 1999 && range[0] <= range[1];
    const missing = areasText !== null && !valid
      ? [`${source.file}: lane ${source.lane} needs a valid [first, last] range in ${areasFile} section_ranges`] : [];
    return [...dispatch, ...missing, ...laneFormatProblems(source.file, source.text, valid ? range as [number, number] : undefined)];
  });
  const owners = new Map<number, string>();
  for (const source of sources) {
    const numbers = new Set([...source.text.matchAll(/^(?:if \(selected\(|(?:export\s+)?async function section)(\d+)/gm)].map(match => Number(match[1])));
    for (const n of numbers) {
      const previous = owners.get(n);
      if (previous !== undefined && previous !== source.file) problems.push(`section ${n} occurs in two source files: ${previous} and ${source.file}`);
      else owners.set(n, source.file);
    }
  }
  if (problems.length) throw new Error(`lane files the section readers cannot read: ${problems.join('; ')}`);
  return sources.map(({ file, text }) => ({ file, text }));
}

/** New tests belong to a lane; only explicitly grandfathered legacy numbers may exceed 820. */
function legacyNumberProblems(file: string, text: string, grandfathered: ReadonlySet<number>): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const n = Number(/^(?:if \(selected\(|(?:export\s+)?async function section)(\d+)/.exec(line)?.[1] ?? NaN);
    return n >= 1000 || n > 820 && !grandfathered.has(n)
      ? [`${file} line ${index + 1}: section ${n} is outside the frozen legacy numbers; new sections go in the lane's file and range`] : [];
  });
}

/** Declarations must reach the runner's column-zero inventory through exactly one canonical dispatch. */
const dispatchCache = new Map<string, string[]>();
export let dispatchParseCount = 0;
function dispatchProblems(file: string, text: string): string[] {
  const cached = dispatchCache.get(text);
  if (cached) return cached.map(problem => file + problem);
  const lines = text.split(/\r?\n/), problems: string[] = [];
  // Fixture programs inside strings are data: inspect statements in this source, not their text.
  let ts: any;
  try { ts = createRequire(import.meta.url)('../kernel/node_modules/typescript/lib/typescript.js'); }
  catch { return [`${file}: cannot load kernel/node_modules/typescript; run npm ci in kernel/ before reading sections`]; }
  dispatchParseCount++;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations: { n: string; line: number }[] = [];
  const dispatches = new Map<string, number>();
  const visit = (node: any): void => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
    if (ts.isFunctionDeclaration(node)) {
      const n = /^section(\d+)$/.exec(node.name?.text ?? '')?.[1];
      if (n) declarations.push({n, line});
    }
    if (ts.isIfStatement(node)) {
      if (/^selected\s*\(/.test(node.expression.getText(tree)) && !/^if \(selected\(\d/.test(lines[line] ?? ''))
        problems.push(`${file} line ${line + 1}: write the dispatch as \`if (selected(N)) await sectionN();\``);
      const n = /^if \(selected\((\d+)\)/.exec(lines[line] ?? '')?.[1];
      if (n && new RegExp('^await section' + n + '\\(').test(node.thenStatement.getText(tree))) dispatches.set(n, (dispatches.get(n) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const {n, line} of declarations) {
    const count = dispatches.get(n) ?? 0;
    if (count !== 1) problems.push(`${file} line ${line + 1}: section ${n} has ${count} dispatch lines; write exactly one \`if (selected(${n})) await section${n}();\``);
  }
  dispatchCache.set(text, problems.map(problem => problem.slice(file.length)));
  return problems;
}

/**
 * A LANE FILE KEEPS THE PARSERS' FORMAT (PLAN-lane-test-files.md, Design 2): every reader anchors at column zero, so an
 * indented section declaration or dispatch line is a section no reader sees, and an indented closing brace lets a
 * section's range run on into the next. Given its lane's `[first, last]`, a section numbered outside it is refused too
 * (kickoffs/s210-r2 row 2). Each problem names the file and line.
 */
export function laneFormatProblems(file: string, text: string, range?: readonly [number, number]): string[] {
  const lines = text.split(/\r?\n/);
  const problems: string[] = [];
  if (range) {
    const lane = /([^\\/]+)\.ts$/.exec(file)?.[1] ?? file;
    const seen = new Set<number>();
    lines.forEach((line, index) => {
      const n = Number(/^(?:if \(selected\(|(?:export\s+)?async function section)(\d+)/.exec(line)?.[1] ?? NaN);
      if (Number.isNaN(n) || seen.has(n)) return;
      seen.add(n);
      if (n < range[0] || n > range[1]) problems.push(`${file} line ${index + 1}: section ${n} is outside lane ${lane}'s range ${range[0]} to ${range[1]} in docs/areas.json`);
    });
  }
  lines.forEach((line, index) => {
    if (/^\s+(?:export\s+)?async function section\d+\(/.test(line)) problems.push(`${file} line ${index + 1}: an indented section declaration; it starts at column zero`);
    if (/^\s+if \(selected\(\d+\)/.test(line)) problems.push(`${file} line ${index + 1}: an indented dispatch line; it starts at column zero`);
    if (/^if \(selected\(\d+\)/.test(line) && /\{\s*$/.test(line)) problems.push(`${file} line ${index + 1}: a dispatch line opens a block; it is one line, \`if (selected(N)...) await sectionN();\``);
  });
  try {
    for (const range of sectionRanges(text)) {
      // From the line after the opening (the comment lines above it are part of the range) to the line before its end.
      let open = range.start - 1;
      while (open < range.end - 1 && !/^(?:async function section|if \(selected\()/.test(lines[open]!)) open += 1;
      const inner = lines.slice(open + 1, range.end - 1).findIndex(line => /^(?:async function |export |if \(selected\()/.test(line));
      if (inner >= 0) problems.push(`${file} line ${open + inner + 2}: section ${range.section} has no closing '}' at column zero before this line`);
    }
  } catch (error) {
    problems.push(`${file}: ${(error as Error).message}`);
  }
  return problems;
}

/** The sources as one text, for the readers that match whole lines (`sectionNumbers`, `knownDeclaredSkips`, the CI plan). */
export function joinedText(sources: readonly SectionSource[]): string {
  return sources.map(source => source.text).join('\n');
}

/** A suite's sources on disk as one text. */
export function suiteText(suite: string): string {
  return joinedText(suiteSources(suite));
}

/** Files every section depends on: a change to one runs the whole self-test (rule c). */
export const SHARED_FILES: ReadonlySet<string> = new Set([
  'kernel/src/cli.ts',
  'kernel/src/verbs.ts',
  'kernel/package.json',
  'kernel/package-lock.json',
  'kernel/tsconfig.json',
  'tools/section-select.mts',
  CHECK_MAP_PATH,
]);

/** One section's block in selftest.ts: 1-based lines, inclusive, its leading comment lines included. */
export interface SectionRange {
  section: number;
  start: number;
  end: number;
}

/**
 * Every declared `async function sectionN(` and inline `if (selected(N)...) {` block at column 0, to its closing `}`
 * at column 0, with the comment lines above it. A one-line run guard owns just its line. Section 208 has two blocks.
 */
export function sectionRanges(selftestText: string): SectionRange[] {
  const lines = selftestText.split(/\r?\n/);
  const ranges: SectionRange[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const declaration = /^async function section(\d+)\(/.exec(lines[i]!);
    const open = declaration ?? /^if \(selected\((\d+)\)/.exec(lines[i]!);
    if (!open) continue;
    let start = i;
    while (start > 0) {
      if (/^\/\/( |$)/.test(lines[start - 1]!)) { start -= 1; continue; }
      if (!/\*\/\s*$/.test(lines[start - 1]!)) break;
      let opening = start - 1;
      while (opening >= 0 && !/^\/\*/.test(lines[opening]!)) opening -= 1;
      if (opening < 0 || lines.slice(opening, start - 1).some(line => /\*\//.test(line))) break;
      start = opening;
    }
    if (!declaration && !/\{\s*$/.test(lines[i]!)) {
      ranges.push({ section: Number(open[1]), start: start + 1, end: i + 1 });
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end] !== '}') end += 1;
    if (end >= lines.length) throw new Error(`section ${open[1]} opened at line ${i + 1} has no closing '}' at column 0`);
    ranges.push({ section: Number(open[1]), start: start + 1, end: end + 1 });
    i = end;
  }
  return ranges;
}

export interface Covers {
  schema: 1;
  /** How the claims were made, for a reader of the file. */
  about: string;
  /** Section number to the kernel/src files it claims. */
  sections: Record<string, string[]>;
  wholeTreeSections?: number[];
}

/** The claim map, checked for shape; a malformed map is an error, never an empty selection. `file` names it in errors. */
export function parseCovers(text: string, file: string = COVERS_PATH): Covers {
  const parsed = JSON.parse(text.replace(/^﻿/, '')) as Partial<Covers>;
  if (parsed.schema !== 1 || typeof parsed.sections !== 'object' || parsed.sections === null) throw new Error(`${file} is not a schema-1 claim map`);
  for (const [section, files] of Object.entries(parsed.sections)) {
    if (!/^[1-9][0-9]*$/.test(section)) throw new Error(`${file}: '${section}' is not a section number`);
    if (!Array.isArray(files) || files.some((claim) => typeof claim !== 'string' || !/^kernel\/src\/[^/]+\.ts$/.test(claim))) {
      throw new Error(`${file}: section ${section} must list kernel/src/<file>.ts paths`);
    }
  }
  if (parsed.wholeTreeSections !== undefined && (!Array.isArray(parsed.wholeTreeSections) || parsed.wholeTreeSections.some(n => !Number.isSafeInteger(n) || n < 1))) throw new Error(`${file}: invalid wholeTreeSections`);
  return parsed as Covers;
}

/**
 * THE ONE CLAIM MAP: `section-covers.json` and each lane's claim file, read as one (PLAN-lane-test-files.md, Design 3).
 * A number claimed in two files is refused by name. Given the sources, a section a lane file holds may be claimed only
 * in that lane's claim file, and a lane claim file may claim only its own lane file's sections.
 */
export function mergeCovers(parts: readonly { file: string; text: string }[], sources?: readonly SectionSource[]): Covers {
  const home = new Map<number, string>();
  for (const source of sources ?? []) for (const range of sectionRanges(source.text)) if (!home.has(range.section)) home.set(range.section, source.file);
  const sections: Record<string, string[]> = {};
  const claimedIn = new Map<string, string>();
  const wholeTreeSections = new Set<number>();
  for (const part of parts) {
    const covers = parseCovers(part.text, part.file);
    for (const n of covers.wholeTreeSections ?? []) wholeTreeSections.add(n);
    const lane = LANES.find(name => part.file === laneCoversPath(name));
    for (const [section, files] of Object.entries(covers.sections)) {
      const earlier = claimedIn.get(section);
      if (earlier !== undefined) throw new Error(`section ${section} is claimed in two files: ${earlier} and ${part.file}`);
      const held = home.get(Number(section));
      if (sources && lane !== undefined && held !== laneTestPath(lane)) throw new Error(`${part.file} claims section ${section}, which ${held === undefined ? 'no section source holds' : `${held} holds`}: a lane claims only its own file's sections`);
      if (sources && lane === undefined && held !== undefined && isLaneTestFile(held)) throw new Error(`${part.file} claims section ${section}, which ${held} holds: claim it in ${held.replace(/\.ts$/, '.covers.json')}`);
      claimedIn.set(section, part.file);
      sections[section] = files;
    }
  }
  return { schema: 1, about: `merged from ${parts.map(part => part.file).join(', ')}`, sections, wholeTreeSections: [...wholeTreeSections].sort((a,b) => a-b) };
}

/** The claim-map files from a reader of repository-relative paths (null: no such file); section-covers.json must exist. */
export function coversFiles(read: (file: string) => string | null): { file: string; text: string }[] {
  const legacy = read(COVERS_PATH);
  if (legacy === null) throw new Error(`${COVERS_PATH} is missing`);
  return [{ file: COVERS_PATH, text: legacy }, ...configuredLanes(read('docs/areas.json')).flatMap(lane => {
    const text = read(laneCoversPath(lane));
    return text === null ? [] : [{ file: laneCoversPath(lane), text }];
  })];
}

/** Tracked tool and test paths with neither a map nor a deliberate whole-suite reason. */
export function unmappedPaths(files: readonly string[], covers: Covers, mapping = checkMap): string[] {
  const claimed = new Set(Object.values(covers.sections).flat());
  const deliberate = (mapping as typeof checkMap & { wholeSuite?: Record<string, string> }).wholeSuite ?? {};
  return [...new Set(files)].filter(file => /^(tools|kernel\/test)\//.test(file)
    && !claimed.has(file) && !mapping.paths.some(row => new RegExp(row.pattern).test(file))
    && !(typeof deliberate[file] === 'string' && deliberate[file]!.trim())).sort();
}

/** Rule (a): the kernel/src files no section claims, sorted. */
export function unclaimedFiles(covers: Covers, kernelSrcFiles: readonly string[]): string[] {
  const claimed = new Set(Object.values(covers.sections).flat());
  return kernelSrcFiles.filter((file) => !claimed.has(file)).sort();
}

/** A hunk of the new revision, as `git diff -U0`'s `+start,count` gives it; `oldCount` is its `-a,b` side's count. */
export interface Hunk {
  start: number;
  count: number;
  oldCount?: number;
}

/**
 * `@@ -a,b +c,d @@` headers of a `git diff -U0` of one file, as new-side hunks. `oldCount` is attached but not
 * enumerable, so a hunk serializes as `{start, count}` as it always has (section 215 pins that form).
 */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const match of diffText.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const hunk: Hunk = { start: Number(match[2]), count: match[3] === undefined ? 1 : Number(match[3]) };
    Object.defineProperty(hunk, 'oldCount', { value: match[1] === undefined ? 1 : Number(match[1]), enumerable: false });
    hunks.push(hunk);
  }
  return hunks;
}

export interface Selection {
  /** Every section runs. */
  all: boolean;
  /** The sections chosen, sorted (empty when `all`, or when nothing a section covers changed). */
  sections: number[];
  /** Own changed self-test text and new claim keys, retained even when all is true. */
  ownSections?: number[];
  /** Why, one line each: `sections 12, 88: claim lifecycle.ts`. */
  reasons: string[];
}

function listed(sections: Iterable<number>): string {
  const sorted = [...new Set(sections)].sort((a, b) => a - b);
  return `${sorted.length === 1 ? 'section' : 'sections'} ${sorted.join(', ')}`;
}

/**
 * Rules (b)-(d) over one commit's changed paths (repository-relative, forward slashes). `laneSources` are the lane files
 * at the new revision, each with its own hunks (empty when unchanged): rule (d) and the name search read them after the
 * legacy file, and `covers` and `previousCovers` are the merged claim maps (`mergeCovers`).
 */
export function selectSections(input: { changed: readonly string[]; selftestHunks: readonly Hunk[]; selftestText: string; covers: Covers; previousCovers?: Covers;
  laneSources?: readonly (SectionSource & { hunks: readonly Hunk[] })[] }): Selection {
  const reasons: string[] = [];
  const chosen = new Set<number>();
  const ownSections = new Set<number>();
  let all = false;
  let claimsJudged = false;
  const sources = [{ file: SELFTEST_PATH, text: input.selftestText, hunks: input.selftestHunks }, ...(input.laneSources ?? [])];
  const claimants = new Map<string, number[]>();
  for (const [section, files] of Object.entries(input.covers.sections)) {
    for (const file of files) claimants.set(file, [...(claimants.get(file) ?? []), Number(section)]);
  }
  for (const file of [...input.changed].sort()) {
    if (file.startsWith('kernel/src/') && input.covers.wholeTreeSections?.length) {
      input.covers.wholeTreeSections.forEach(n => chosen.add(n));
      reasons.push(`${listed(input.covers.wholeTreeSections)}: read the whole source tree`);
    }
    const mapped = rules.filter(row => row.match.test(file));
    for (const row of mapped) if (Array.isArray(row.sections)) {
      row.sections.forEach(section => chosen.add(section));
      if (row.sections.length) reasons.push(`${listed(row.sections)}: ${CHECK_MAP_PATH} maps ${file}`);
    }
    const staticChecks = pathChecks([file]);
    if (staticChecks.length) reasons.push(`${file}: ${staticChecks.join(', ')}`);
    if (mapped.length && !staticChecks.length && mapped.every(row => Array.isArray(row.sections) && !row.sections.length)) reasons.push(`document gate: ${file}`);
    if (file === COVERS_PATH || isLaneCoversFile(file)) {
      // The maps are merged, so one comparison judges every changed claim file at once.
      if (claimsJudged) continue;
      claimsJudged = true;
      const before = input.previousCovers?.sections;
      const after = input.covers.sections;
      const added = Object.keys(after).filter(section => !before || !Object.hasOwn(before, section)).map(Number);
      added.forEach(section => ownSections.add(section));
      if (JSON.stringify(input.previousCovers?.wholeTreeSections ?? []) !== JSON.stringify(input.covers.wholeTreeSections ?? [])) {
        all = true;
        reasons.push('every section: whole-source-tree reader list changed');
      }
      if (!before || Object.entries(before).some(([section, claims]) =>
        !Object.hasOwn(after, section) || JSON.stringify([...claims].sort()) !== JSON.stringify([...after[section]!].sort()))) {
        all = true;
        reasons.push(`every section: existing claims in ${file} changed or the earlier map is unavailable`);
      } else {
        added.forEach(section => chosen.add(section));
        if (added.length) reasons.push(`${listed(added)}: added claim-map keys`);
      }
    } else if (file !== SELFTEST_PATH && Object.hasOwn(checkMap.wholeSuite ?? {}, file)) {
      all = true;
      reasons.push(`every section: ${file} is on the whole-suite list in ${CHECK_MAP_PATH}`);
    } else if (SHARED_FILES.has(file)) {
      all = true;
      reasons.push(`every section: ${file} is on the shared list`);
    } else if (file.startsWith('kernel/test/') && file !== SELFTEST_PATH && !isLaneTestFile(file)) {
      all = true;
      reasons.push(`every section: ${file} is a self-test helper`);
    } else if (isLaneTestFile(file) && !sources.some((source) => source.file === file)) {
      all = true;
      reasons.push(`every section: ${file} changed and is not among the section sources read`);
    } else if (/^kernel\/src\/[^/]+\.ts$/.test(file)) {
      const sections = claimants.get(file) ?? [];
      if (sections.length === 0) {
        all = true;
        reasons.push(`every section: no section claims ${file}`);
      } else {
        sections.forEach((section) => chosen.add(section));
        reasons.push(`${listed(sections)}: claim ${file.slice('kernel/src/'.length)}`);
      }
    } else if (isLaneTestFile(file)) {
      // The source hunks below select lane sections; never infer from the lane filename.
    } else if (mapped.length && mapped.every(row => Array.isArray(row.sections))) {
      // An explicit map names the readers; filename inference is only the fallback.
    } else if (file.startsWith('.githooks/') || file.startsWith('tools/') || mapped.some(row => row.sections === 'named')) {
      const name = file.slice(file.lastIndexOf('/') + 1);
      const named = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      // Every source: a tool named by a legacy section and a lane section selects both (kickoffs/s210 row 2).
      const sections = [...new Set(sources.flatMap((source) => {
        const lines = source.text.split(/\r?\n/);
        return sectionRanges(source.text).filter((range) => named.test(lines.slice(range.start - 1, range.end).join('\n'))).map((range) => range.section);
      }))];
      if (sections.length === 0 || sections.length > 40) {
        all = true;
        reasons.push(sections.length === 0 ? `every section: no section names ${file}` : `every section: more than 40 sections name ${file}`);
      } else {
        for (const section of sections) { chosen.add(section); reasons.push(`section ${section}: names ${file}`); }
      }
    } else if (!file.startsWith('kernel/') && mapped.length === 0) {
      throw new UnmappedPathError(file);
    }
  }
  // Rule (d), for the legacy file and each lane file alike: a lane file's hunks map to that file's own sections.
  for (const source of sources) {
    if (!input.changed.includes(source.file)) continue;
    const ranges = sectionRanges(source.text);
    const lines = source.text.split(/\r?\n/);
    const blank = (line: number) => (lines[line - 1] ?? '').trim() === '';
    const inside = (line: number) => ranges.find((range) => line >= range.start && line <= range.end);
    for (const hunk of source.hunks) {
      // Blank lines at either end of a hunk belong to no section and change nothing: a new section arrives with one.
      let first = Math.max(hunk.start, 1);
      let last = hunk.count === 0 ? first : hunk.start + hunk.count - 1;
      if (hunk.count > 0) {
        while (first <= last && blank(first)) first += 1;
        while (last >= first && blank(last)) last -= 1;
        if (first > last) {
          reasons.push(`no section: ${source.file} lines ${hunk.start}-${hunk.start + hunk.count - 1} are blank`);
          continue;
        }
      }
      const span = hunk.count === 0 ? `after line ${hunk.start}` : first === last ? `line ${first}` : `lines ${first}-${last}`;
      // Each nonblank line's section; the first line inside none runs every section and is named.
      const touched = new Set<number>();
      let stray: number | undefined;
      // A PURE ADDITION CAN BE SPLIT ANOTHER WAY (kickoffs/s210 row 4): git may count the unchanged line just after the
      // hunk as added and an equal line inside it as unchanged. The first section added to a lane file did that with
      // `runLane`'s closing `}`: the hunk held runLane's `}` and the new section's `}` lay just past it. So in a pure
      // addition, one line outside every section that equals the line just after the hunk is that line, unchanged, and
      // the line after is the added one; the swap is taken only when that line is inside a section.
      const after = hunk.start + hunk.count;
      const swappable = hunk.count > 0 && (hunk.oldCount ?? 0) === 0 && inside(after) !== undefined ? lines[after - 1] : undefined;
      let swapped = false;
      for (let line = first; line <= last; line += 1) {
        if (hunk.count > 0 && blank(line)) continue;
        const home = inside(line);
        if (home) { touched.add(home.section); ownSections.add(home.section); }
        else if (!swapped && swappable !== undefined && lines[line - 1] === swappable) {
          swapped = true;
          const moved = inside(after)!;
          touched.add(moved.section); ownSections.add(moved.section);
        } else stray ??= line;
      }
      if (stray !== undefined) {
        all = true;
        reasons.push(`every section: ${source.file} line ${stray} is outside every section`);
      } else if (touched.size > 1 && (hunk.oldCount ?? 0) > 0) {
        // Only the new side is read, so any old line between two sections could have been a shared helper; only a
        // pure addition (no `oldCount`, as hand-built hunks have, counts as one) selects each section it touches.
        all = true;
        reasons.push(`every section: ${source.file} ${span} replaces lines across ${listed(touched)}`);
      } else {
        touched.forEach(section => chosen.add(section));
        reasons.push(`${listed(touched)}: ${source.file} ${span} ${touched.size === 1 ? 'is inside it' : 'are inside them'}`);
      }
    }
  }
  return { all, sections: all ? [] : [...chosen].sort((a, b) => a - b), ownSections: [...ownSections].sort((a, b) => a - b), reasons };
}

/**
 * THE LINUX SELECTION (PLAN-cross-office-build-loop.md step 1.2; kickoffs/s153 row 6). `kernel/test/linux-skip.json`
 * lists the sections that judge a Windows-only rule by design, `{ "<n>": "<reason>" }`; on Linux they leave every
 * selection (the commit tier's, the parallel runner's and so the cut and push tiers', an all-sections run), the run says
 * so in one line, and a required one is refused by name rather than dropped. Anywhere else the policy is the identity.
 * A section that fails on Linux for a reason that could be fixed is never listed here: it is a defect, not a skip.
 */
export const LINUX_SKIP_PATH = 'kernel/test/linux-skip.json';

/** The list, checked for shape; a malformed list is an error, never an empty one. */
export function parseLinuxSkip(text: string): Map<number, string> {
  const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${LINUX_SKIP_PATH} is not an object of section numbers to reasons`);
  const skips = new Map<number, string>();
  for (const [section, reason] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(section)) throw new Error(`${LINUX_SKIP_PATH}: '${section}' is not a section number`);
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`${LINUX_SKIP_PATH}: section ${section} needs its reason`);
    skips.set(Number(section), reason.trim());
  }
  return skips;
}

/** The sections this platform skips by the list: the list on Linux, nothing elsewhere. */
export function platformSkips(platform: string, linuxSkip: ReadonlyMap<number, string>): Map<number, string> {
  return platform === 'linux' ? new Map(linuxSkip) : new Map();
}

/** A selection with the platform's skips taken out, and the one line that says so (null when none was taken). */
export function applyPlatformSkips(sections: readonly number[], skips: ReadonlyMap<number, string>): { sections: number[]; skipped: number[]; line: string | null } {
  const skipped = sections.filter((section) => skips.has(section));
  return {
    sections: sections.filter((section) => !skips.has(section)),
    skipped,
    line: skipped.length ? `linux: ${skipped.length} sections skipped by linux-skip.json (${skipped.join(', ')})` : null,
  };
}

/**
 * SECTIONS STAY IN ASCENDING ORDER, CHECKED (kickoffs/s156 row 4; a clean merge put c51's sections after s154's). The
 * inventory sorts and dedups (`sectionNumbers`), and JSON keys that look like numbers read back sorted, so neither shows
 * disorder: this reads both files as text. Each top-level guard (`if (selected(N)` or `if (prerequisite(N,`) and each
 * claim-map key must be greater than the one before; 208 is the one section opened twice.
 */
export const OPENED_TWICE: ReadonlySet<number> = new Set([208]);
export function sectionOrderProblems(selftestText: string, coversText: string): string[] {
  const problems: string[] = [];
  const inOrder = (where: string, numbers: number[]) => {
    for (let i = 1; i < numbers.length; i += 1) {
      const before = numbers[i - 1]!, after = numbers[i]!;
      if (after < before || (after === before && !OPENED_TWICE.has(after))) problems.push(`${where}: ${after} ${after === before ? 'repeats' : 'comes after'} ${before}`);
    }
  };
  inOrder(`${SELFTEST_PATH}'s top-level guards`, [...selftestText.matchAll(/^if \((?:selected\((\d+)\)|prerequisite\((\d+),)/gm)].map((m) => Number(m[1] ?? m[2])));
  inOrder(`${COVERS_PATH}'s keys`, [...coversText.matchAll(/^\s*"(\d+)"\s*:/gm)].map((m) => Number(m[1])));
  // A GUARD THE RUNNER'S INVENTORY CANNOT LIST never runs when every section runs (kickoffs/s157 row 9: section 400 since
  // s155): the inventory reads `if (selected(N)` only, so a top-level guard opens with it.
  for (const m of selftestText.matchAll(/^if \(prerequisite\((\d+),/gm)) problems.push(`${SELFTEST_PATH}'s top-level guard for ${m[1]} has no selected(${m[1]}), so a run of every section leaves it out`);
  return problems;
}

/** Each required section the platform skips, in the plan's words. */
export function platformRefusals(required: readonly string[], skips: ReadonlyMap<number, string>): string[] {
  return required.flatMap((section) => {
    const reason = skips.get(Number(section));
    return reason === undefined ? [] : [`section ${section} is Linux-skipped: ${reason}; it cannot be required here`];
  });
}

/** Staged selection shared by the commit tier and its hook fixtures. Strict callers propagate invalid input. */
export function stagedSelection(git: (args: string[]) => string, strict = false, readUnchanged?: (file: string) => string | null): Selection {
  try {
    const changed = git(['diff', '--name-only', '--no-renames', '--cached', 'HEAD']).split(/\r?\n/).filter(Boolean);
    // A lane file the tree does not hold (or a git that cannot show it) is no source: the legacy files still decide.
    const optional = (spec: string) => { try { return git(['show', spec]); } catch { return null; } };
    const at = (revision: string) => (file: string) => file === COVERS_PATH || file === SELFTEST_PATH ? git(['show', `${revision}:${file}`]) : optional(`${revision}:${file}`);
    const sources = sectionSources(file => readUnchanged && !changed.includes(file) ? readUnchanged(file) : at('')(file));
    const covers = mergeCovers(coversFiles(at('')), sources);
    const previousCovers = mergeCovers(coversFiles(at('HEAD')));
    const hunks = (file: string) => changed.includes(file) ? parseHunks(git(['diff', '-U0', '--no-renames', '--cached', 'HEAD', '--', file])) : [];
    const chosen = selectSections({ changed, covers, previousCovers, selftestText: sources[0]!.text, selftestHunks: hunks(SELFTEST_PATH),
      laneSources: sources.slice(1).map(source => ({ ...source, hunks: hunks(source.file) })) });
    return strict || chosen.all ? chosen : { ...chosen, sections: [...new Set([...chosen.sections, 155])].sort((a, b) => a - b) };
  } catch (error) {
    if (strict || error instanceof UnmappedPathError) throw error;
    return { all: true, sections: [], reasons: [`selection unavailable: ${String(error).replace(/[\r\n]+/g, ' ')}`] };
  }
}
