#!/usr/bin/env node
/**
 * THE REQUIRED-CHECK MANIFEST (kickoffs/s200 row 1; PLAN-build-regroup.md, end state point 1). Which runner must run
 * each kernel self-test section, derived from what the suite itself declares, never from a list kept by hand:
 *
 *   plan   every section of `kernel/test/selftest.ts` and its lane files (`kernel/test/lanes/<lane>.ts`) assigned to `linux`, `windows`, `both` or `release`; each
 *          `windows`, `linux` and `release` entry names the prerequisite that put it there. `--sections linux|windows`
 *          prints the comma list for LIBRARY_SELFTEST_SECTIONS instead (that runner's sections and `both`).
 *   check  one or more `run-parallel.ts` result.json files, each followed by its runner's name. Exits 1 unless every
 *          section assigned to that runner, and every `both` section, shows a verdict other than SKIP; a runner not
 *          reported fails too, unless `--partial` (then its sections are named, not judged).
 *
 * The prerequisites are judged as the runner's own preflight judges them (`knownDeclaredSkips`, kernel/test/run-parallel.ts):
 * a guard `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))`, or one inside the section's body, skips on
 * a platform when a term of <condition> is known false there. Known false on Linux only: `windows`. On Windows only:
 * `linux`. On both, for the TypeScript suite: `release` (a compiled kernel, a release tree, a previous installer; the
 * release tier keeps those). A section in `kernel/test/linux-skip.json` is `windows`. Everything else is `both`.
 *
 *   node tools/ci-manifest.mts plan [--suite <selftest.ts>] [--skip-list <linux-skip.json>] [--sections linux|windows]
 *   node tools/ci-manifest.mts check [--suite <f>] [--skip-list <f>] [--manifest <plan.json>] [--partial] <result.json> <runner> ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { knownDeclaredSkips, sectionNumbers, type DeclaredSkip } from '../kernel/test/run-parallel.ts';
import { suiteText as readSuiteText } from './section-select.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SUITE = path.join(ROOT, 'kernel', 'test', 'selftest.ts');
export const DEFAULT_SKIP_LIST = path.join(ROOT, 'kernel', 'test', 'linux-skip.json');
export const RUNNERS = ['linux', 'windows'] as const;
export type Runner = typeof RUNNERS[number];
export type RunnerClass = Runner | 'both' | 'release';
export interface Entry { section: number; class: RunnerClass; prerequisite?: string }
export interface Manifest { schema: 1; sections: Entry[] }

/** A prerequisite inside a section's body (`if (!prerequisite(N, () => ...)) return;`), rewritten as the guard form the
 * runner's preflight reads, so both are judged by one rule. A call inside a string or template is not at a statement's start. */
function bodyGuards(suiteText: string): string {
  const guards: string[] = [];
  for (const m of suiteText.matchAll(/^[ \t]+if \(!?prerequisite\((\d+), \(\) => /gm)) {
    const after = m.index! + m[0].length;
    guards.push(`if (selected(${m[1]}) && prerequisite(${m[1]}, () => ${suiteText.slice(after, after + 4000)}`);
  }
  return guards.join('\n');
}
const unreadable = (skip: DeclaredSkip) => skip.reason.endsWith("'s prerequisite reason could not be read");
function skipsOn(suiteText: string, platform: NodeJS.Platform): Map<number, string> {
  const found = new Map<number, string>();
  for (const text of [suiteText, bodyGuards(suiteText)])
    for (const skip of knownDeclaredSkips(text, { platform, kernel: [] })) if (!unreadable(skip) && !found.has(skip.section)) found.set(skip.section, skip.reason);
  return found;
}
export function parseSkipList(text: string): Map<number, string> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the skip list must be a JSON object of section numbers and reasons');
  return new Map(Object.entries(value as Record<string, unknown>).map(([key, reason]) => {
    if (!/^[1-9]\d*$/.test(key) || typeof reason !== 'string') throw new Error(`skip list entry '${key}' must be a section number with a reason`);
    return [Number(key), reason] as const;
  }));
}

export function plan(suiteText: string, skipList: Map<number, string> = new Map()): Manifest {
  const linux = skipsOn(suiteText, 'linux'), windows = skipsOn(suiteText, 'win32');
  const sections = sectionNumbers(suiteText, '').map((section): Entry => {
    const onLinux = linux.get(section), onWindows = windows.get(section);
    if (onLinux !== undefined && onWindows !== undefined) return { section, class: 'release', prerequisite: onWindows };
    if (skipList.has(section)) return { section, class: 'windows', prerequisite: `linux-skip.json: ${skipList.get(section)}` };
    if (onLinux !== undefined) return { section, class: 'windows', prerequisite: onLinux };
    if (onWindows !== undefined) return { section, class: 'linux', prerequisite: onWindows };
    return { section, class: 'both' };
  });
  return { schema: 1, sections };
}
/** The sections a runner must run: its own and `both`. */
export function sectionsFor(manifest: Manifest, runner: Runner): number[] {
  return manifest.sections.filter((entry) => entry.class === runner || entry.class === 'both').map((entry) => entry.section);
}

export interface Report { runner: string; file: string; results: { section: number | 'whole'; verdict: string; detail?: string }[] }
export interface CheckOutcome { problems: string[]; notes: string[] }
export function check(manifest: Manifest, suiteSections: readonly number[], reports: readonly Report[], partial = false): CheckOutcome {
  const problems: string[] = [], notes: string[] = [];
  const assigned = new Map<number, RunnerClass>();
  for (const entry of manifest.sections) {
    if (!['linux', 'windows', 'both', 'release'].includes(entry.class)) problems.push(`manifest: section ${entry.section} has no runner class ('${String(entry.class)}')`);
    else if (assigned.has(entry.section)) problems.push(`manifest: section ${entry.section} is assigned twice`);
    else assigned.set(entry.section, entry.class);
  }
  for (const section of suiteSections) if (!assigned.has(section)) problems.push(`manifest: section ${section} is not assigned to a runner`);
  for (const section of assigned.keys()) if (!suiteSections.includes(section)) problems.push(`manifest: section ${section} is not in the suite`);
  for (const report of reports) if (!(RUNNERS as readonly string[]).includes(report.runner)) problems.push(`${report.file}: unknown runner '${report.runner}' (linux or windows)`);
  for (const runner of RUNNERS) {
    const required = sectionsFor(manifest, runner);
    const mine = reports.filter((report) => report.runner === runner);
    if (!mine.length) {
      (partial ? notes : problems).push(`${runner}: not reported; ${required.length} sections wait for it${partial ? ' (--partial)' : ''}`);
      continue;
    }
    const verdicts = new Map<number, { verdict: string; detail?: string }>();
    for (const report of mine) for (const result of report.results) {
      if (result.section === 'whole') { problems.push(`${report.file}: a whole run cannot show which sections ran`); continue; }
      const earlier = verdicts.get(result.section);
      if (!earlier || earlier.verdict === 'SKIP') verdicts.set(result.section, result);
    }
    const missing = required.filter((section) => verdicts.get(section)?.verdict === undefined);
    const skipped = required.filter((section) => verdicts.get(section)?.verdict === 'SKIP');
    for (const section of missing) problems.push(`${runner}: section ${section} (${assigned.get(section)}) did not run: absent`);
    for (const section of skipped) problems.push(`${runner}: section ${section} (${assigned.get(section)}) did not run: ${verdicts.get(section)!.detail || 'SKIP'}`);
    const failed = required.filter((section) => verdicts.get(section)?.verdict === 'FAIL');
    notes.push(`${runner}: ${required.length - missing.length - skipped.length} of ${required.length} required sections ran${failed.length ? `; ${failed.length} failed (${failed.join(', ')})` : ''}`);
  }
  return { problems, notes };
}

function readResult(file: string, runner: string): Report {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { results?: unknown };
  if (!Array.isArray(value.results)) throw new Error(`${file} has no results list (a run-parallel.ts result.json)`);
  return { runner, file, results: value.results as Report['results'] };
}
function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  let suite = DEFAULT_SUITE, skipFile: string | null = null, manifestFile: string | null = null, partial = false, sectionsOf: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const value = () => { const next = rest[++i]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--suite') suite = path.resolve(value());
    else if (arg === '--skip-list') skipFile = path.resolve(value());
    else if (arg === '--manifest' && mode === 'check') manifestFile = path.resolve(value());
    else if (arg === '--partial' && mode === 'check') partial = true;
    else if (arg === '--sections' && mode === 'plan') sectionsOf = value();
    else if (arg.startsWith('--')) throw new Error(`unknown option '${arg}' for ${mode ?? 'no mode'}`);
    else positional.push(arg);
  }
  // linux-skip.json names the real suite's sections, so it applies to that suite only (as in run-parallel.ts suiteSkips).
  if (skipFile === null && suite === DEFAULT_SUITE && fs.existsSync(DEFAULT_SKIP_LIST)) skipFile = DEFAULT_SKIP_LIST;
  // The suite and its lane files, as the runner reads them (kickoffs/s210 row 2).
  const suiteText = readSuiteText(suite);
  const skipList = skipFile ? parseSkipList(fs.readFileSync(skipFile, 'utf8')) : new Map<number, string>();
  if (mode === 'plan') {
    if (positional.length) throw new Error(`plan takes no file arguments, got '${positional[0]}'`);
    const manifest = plan(suiteText, skipList);
    if (sectionsOf === null) { process.stdout.write(JSON.stringify(manifest, null, 2) + '\n'); return 0; }
    if (!(RUNNERS as readonly string[]).includes(sectionsOf)) throw new Error(`--sections takes linux or windows, got '${sectionsOf}'`);
    process.stdout.write(sectionsFor(manifest, sectionsOf as Runner).join(',') + '\n');
    return 0;
  }
  if (mode === 'check') {
    if (!positional.length || positional.length % 2) throw new Error('check takes pairs: <result.json> <runner> ...');
    const reports: Report[] = [];
    for (let i = 0; i < positional.length; i += 2) reports.push(readResult(positional[i]!, positional[i + 1]!));
    const manifest = manifestFile ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest : plan(suiteText, skipList);
    if (!Array.isArray(manifest.sections)) throw new Error(`${manifestFile} has no sections list`);
    const outcome = check(manifest, sectionNumbers(suiteText, ''), reports, partial);
    for (const line of outcome.notes) process.stdout.write(`ci-manifest: ${line}\n`);
    for (const line of outcome.problems) process.stdout.write(`ci-manifest: FAIL ${line}\n`);
    process.stdout.write(outcome.problems.length ? `ci-manifest: check FAILED (${outcome.problems.length} problems)\n` : 'ci-manifest: check passed\n');
    return outcome.problems.length ? 1 : 0;
  }
  throw new Error(`mode must be plan or check, got '${mode ?? ''}'`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { process.stderr.write(`ci-manifest: ${(error as Error).message}\n`); process.exitCode = 2; }
}
