/**
 * THE GATE BY TIERS (PLAN-powershell-free-development.md, Session 1 items 1-3; kickoffs/s113 rulings 14-15):
 *
 *   node tools/gate.ts --tier commit|cut|push|release [--json] [--no-wait] [--commit <sha>] [--compare-with <old-report-json>]
 *   npm --prefix kernel run gate -- --tier <tier> ...
 *
 * One line per check with its time (`PASS 6.3s kernel.typecheck`), then the total against the tier's budget
 * (`commit tier: 1m 32s of 2m`). Over budget is a warning, never a failure. A higher tier runs every check of the
 * tiers below it. Headless: no prompt, stdin unused.
 *
 *   exit 0  every check passed (a WARN passes, as the runner's does);
 *   exit 1  a check failed;
 *   exit 2  the gate itself failed (an unknown argument, git or a child that could not run, a malformed claim map);
 *   exit 3  waiting refused under --no-wait. The machine-wide lock is on by default; DESKPOST_GATE_SERIAL=0 switches it off for one run.
 *
 * The hook runs the commit tier beside the old gate only on request (DESKPOST_GATE_COMPARE=1). --compare-with
 * appends its observations and exits 0 even on disagreement or new-gate error; the old gate still decides.
 * Missing old check observations remain null.
 * What each tier runs today:
 *   commit   the kernel type check (tsc --noEmit); the claim map's coverage (rule a); the docs gate as it is
 *            (`node tools/docs-gate.ts`, which judges a docs-only commit and says "not docs-only" for any other);
 *            the TypeScript identity/deployment scans; the kernel self-test sections the changed files select
 *            (tools/section-select.mts, rules b-d). Comparisons also honor serial opt-in and fixture lock names.
 *   push     the commit checks, selected over origin/master..HEAD; required sections are included explicitly.
 *   cut      by hand only: the type check, coverage, docs gate, scans, every ported check (tools/gate-checks.ts) and
 *            every section the platform runs, through kernel/test/run-parallel.ts.
 *   release  the cut tier's checks and the release-only checks named below, on Windows or Linux.
 * No tier starts PowerShell (kickoffs/s224): the checks the old runner gave the gate are ported to tools/gate-checks.ts
 * or retired, each with its reason in the s224 ledger.
 *
 * EVERY CHILD HAS A LIMIT: git 60 seconds; the type check and the docs gate 10 minutes; a whole self-test run 45; in
 * the push pool a section 10 (Unit A).
 *
 * THE CHILDREN'S ENVIRONMENT is the pre-commit hook's: LIBRARY_WORKSPACE, LIBRARY_SEAT and LIBRARY_SEAT_CLAIM blank,
 * every PATH entry holding a `deskpost` shim dropped; and, as the loop doc's push recipe and the release rules say,
 * ORCA_TERMINAL_HANDLE blank and DESKPOST_UPDATE_CHECK unset.
 *
 * --commit <sha> chooses the self-test sections as if <sha> were being committed (its diff against its parent, and
 * selftest.ts at <sha>), which is how S113 replayed S103's commits; every check still runs on this working tree.
 */
import { pathChecks } from './section-select.mts';
import { inventoryChecks } from './inventory.mts';
import { estimateSeconds, parseTimes } from './section-times.mts';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryNeutralEnv } from '../kernel/src/gitenv.ts';
import { childEnv, withHookSeat } from '../kernel/test/gate-env.ts';
import { acquireGateLock, LockError, type GateWait, gateLockOffNotice } from '../kernel/test/gate-lock.ts';
import { SERIAL_SECTIONS, parseOptions, requiredListRefusals, requiredSectionsVerdict, sectionLimitWarning, runPool, runSection, sectionNumbers, startIdentity, terminateOwnedTree, type PoolItem, type Result } from '../kernel/test/run-parallel.ts';
import { PORTED_CHECKS } from './gate-checks.ts';
import { COVERS_PATH, SELFTEST_PATH, LINUX_SKIP_PATH, applyPlatformSkips, coversFiles, mergeCovers, parseLinuxSkip, platformSkips, parseHunks, platformRefusals, sectionSources, selectSections, stagedSelection, suiteText, unclaimedFiles, type Selection } from './section-select.mts';

/** Skip numbers belong to the checked suite; fixture section 4 is not the real section 4. */
export function readRootPlatformSkips(root: string, platform: string = process.platform): Map<number, string> {
  const file = path.join(root, LINUX_SKIP_PATH);
  return fs.existsSync(file) ? platformSkips(platform, parseLinuxSkip(fs.readFileSync(file, 'utf8'))) : new Map();
}
const readPlatformSkips = readRootPlatformSkips;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_GATE = 2;

type Tier = 'commit' | 'cut' | 'push' | 'release';
const TIERS: readonly Tier[] = ['commit', 'cut', 'push', 'release'];
/** Seconds; null is "measured" (no budget yet). The cut's 17 minutes is S103's -Fast gate, measured each run. */
const BUDGETS: Record<Tier, number | null> = { commit: 120, cut: 17 * 60, push: null, release: null };
/** Work budget only; the reporting budget above remains unchanged. */
export const COMMIT_SELECTION_BUDGET_SECONDS = 180;
export const COMMIT_MAX_WORKERS = 2;

type Status = 'pass' | 'warn' | 'fail' | 'skip';
interface Outcome {
  check: string;
  tier: Tier;
  status: Status;
  seconds: number | null;
  detail: string;
  /** The defect this check has caught, from git log or its own comment; "none found" when none is known. */
  caught: string;
  /** Reported, never acceptance: the push tier's claim-map coverage and docs gate (Unit B step 3). */
  diagnostic?: boolean;
}

const MINUTE = 60_000;
const GIT_LIMIT = 60_000;
const CHECK_LIMIT = 10 * MINUTE;
const RUNNER_LIMIT = 45 * MINUTE;

class GateError extends Error {}
let interrupted = false;

const USAGE = 'Usage: node tools/gate.ts --tier commit|cut|push|release [--json] [--no-wait] [--commit <sha>] [--compare-with <old-report-json>] [--require-sections <n,n,...>]; ' +
  'node tools/gate.ts --sections-log <file> --require-sections <n,n,...>; the hook uses --compare-with only on request (DESKPOST_GATE_COMPARE=1)';

/** The required-sections check lives in run-parallel.ts, which a focused self-test run also uses (kickoffs/s140 row 4). */
function requiredOutcome(logText: string, required: string[], tier: Tier): Outcome {
  const { status, detail } = requiredSectionsVerdict(logText, required);
  return { check: 'gate.required-sections', tier, status, seconds: null, caught: 'c14: a required section 149 skipped under two green gates', detail };
}

function parseArgs(argv: string[], platform: string = process.platform): { tier: Tier; json: boolean; commit: string | null; noWait: boolean; requireSections: string[]; sectionsLog: string | null; compare: OldGate | null } {
  let tier: Tier | null = null;
  let json = false;
  let commit: string | null = null;
  let noWait = false;
  let requireSections: string[] = [];
  let sectionsLog: string | null = null;
  let compare: OldGate | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--compare-with' && i + 1 < argv.length) compare = oldGate(argv[++i]!);
    else if (arg === '--require-sections' && i + 1 < argv.length) {
      const value = argv[++i]!;
      if (!/^\d+(,\d+)*$/.test(value)) throw new GateError(`--require-sections takes section numbers separated by commas, such as 147,148; got '${value}'. ${USAGE}`);
      requireSections = value.split(',');
    } else if (arg === '--sections-log' && i + 1 < argv.length) sectionsLog = argv[++i]!;
    else if (arg === '--tier' && i + 1 < argv.length) {
      const value = argv[++i]!;
      if (!(TIERS as readonly string[]).includes(value)) throw new GateError(`--tier is one of ${TIERS.join(', ')}; got '${value}'. ${USAGE}`);
      tier = value as Tier;
    } else if (arg === '--json') json = true;
    else if (arg === '--no-wait') noWait = true;
    else if (arg === '--commit' && i + 1 < argv.length) commit = argv[++i]!;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\nCut, push and release serialize participating live gates; --no-wait exits 3 on contention.\n`);
      process.exit(EXIT_PASS);
    } else throw new GateError(`unknown argument '${arg}'. ${USAGE}`);
  }
  if (compare && (tier !== 'commit' || sectionsLog !== null)) throw new GateError('--compare-with requires --tier commit');
  if (sectionsLog !== null) {
    if (tier !== null || !requireSections.length) throw new GateError(`--sections-log checks a written log against --require-sections, with no --tier. ${USAGE}`);
    return { tier: 'push', json, commit, noWait, requireSections, sectionsLog, compare };
  }
  if (tier === null) throw new GateError(`name a tier. ${USAGE}`);
  if (requireSections.length && tier !== 'push' && tier !== 'release') {
    // This argument refusal must work even without Git on PATH.
    let root = process.cwd();
    while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
    const refusals = platformRefusals(requireSections, readRootPlatformSkips(root, platform));
    throw new GateError(refusals.length ? refusals.join('; ') : `--require-sections reads the sections.log only the push and release tiers write. ${USAGE}`);
  }
  return { tier, json, commit, noWait, requireSections, sectionsLog, compare };
}

function git(root: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const ran = spawnSync('git', args, { cwd: root, env: { ...repositoryNeutralEnv(), ...extraEnv }, encoding: 'utf8', maxBuffer: 1 << 30, timeout: GIT_LIMIT, windowsHide: true });
  if (ran.error) throw new GateError(`git ${args.join(' ')} did not finish within ${GIT_LIMIT / 1000}s: ${ran.error.message}`);
  if (ran.status !== 0) throw new GateError(`git ${args.join(' ')} failed: ${`${ran.stderr ?? ''}`.trim()}`);
  return ran.stdout ?? '';
}

/** Staged text bytes: new files may use CRLF; an existing LF file may not acquire it silently. */
export function lineEndingProblems(root: string): string[] {
  const indexEnv: Record<string,string> = {};
  if (process.env['GIT_INDEX_FILE'] && path.resolve(root) === path.resolve(git(process.cwd(), ['rev-parse','--show-toplevel']).trim()))
    indexEnv['GIT_INDEX_FILE'] = process.env['GIT_INDEX_FILE'];
  const changed = git(root, ['diff','--cached','--name-only','--diff-filter=ACMR','-z','HEAD'], indexEnv).split('\0').filter(Boolean);
  const existing = new Set(git(root, ['ls-tree','-r','--name-only','-z','HEAD']).split('\0'));
  const problems: string[] = [];
  for (const file of changed.filter(file => /\.(?:md|ts|mts|json|ps1|py|sh|yml)$/i.test(file))) {
    const text = git(root, ['cat-file','blob',`:${file}`], indexEnv);
    if (text.includes('\0')) continue;
    const lineAt = (at: number) => text.slice(0,at).split('\n').length;
    for (const match of text.matchAll(/\r(?!\n)/g)) problems.push(`${file}:${lineAt(match.index!)}: lone carriage return`);
    const first = text.indexOf('\r\n');
    if (first >= 0 && existing.has(file) && !git(root,['cat-file','blob',`HEAD:${file}`]).includes('\r\n'))
      problems.push(`${file}:${lineAt(first)}: CRLF introduced over an LF file`);
  }
  return problems;
}

/** Advisory only: a moved or unreachable remote never changes a gate's verdict. */
export function masterMoved(root: string, selectedSha: string, lsRemote = (root: string) => git(root, ['ls-remote', 'origin', 'refs/heads/master'], { GIT_TERMINAL_PROMPT: '0' })): { line: string; master_moved?: { old: string; new: string } } | null {
  try {
    const remote = lsRemote(root).trim().split(/\s+/)[0] ?? '';
    if (!/^[a-f0-9]{40,64}$/.test(remote)) throw new Error('origin/master returned no SHA');
    return remote === selectedSha ? null : {
      line: `origin/master on the remote is ${remote}, not the selected ${selectedSha}: fetch and rebase before pushing`,
      master_moved: { old: selectedSha, new: remote },
    };
  } catch (error) {
    return { line: `could not check whether origin/master moved during the gate: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Run a child to its end or its limit, keeping its output; awaited, so a later lock can keep answering while it runs.
 * Past its limit the tree it owns is ended and the result is a failure that names the limit. */
function runChild(command: string, args: string[], root: string, limit: number, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; output: string; seconds: number }> {
  if (interrupted) throw new GateError('gate cancelled');
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: { ...childEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const identity = child.pid ? startIdentity(child.pid).catch(() => null) : Promise.resolve(null);
    let output = '';
    let finished = false;
    let cancelling = false;
    const finish = async (status: number | null, detail = '') => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      // The program exits explicitly: drain its identity helper before it can orphan a process in root.
      await identity;
      resolve({ status, output: output + detail, seconds: (Date.now() - started) / 1000 });
    };
    const end = async (why: string, cancelled: boolean) => {
      if (cancelling) return;
      cancelling = true; if (cancelled) interrupted = true;
      try { if (child.pid) await terminateOwnedTree(child.pid, started, await identity); }
      catch (error) { output += `cleanup failed: ${String(error)}\n`; }
      finish(1, `${why}\n`);
    };
    const cancel = () => end('cancelled', true);
    const timer = setTimeout(() => end(`exceeded its limit of ${Math.round(limit / 1000)}s`, false), limit);
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (status) => { if (!cancelling) finish(status); });
  });
}

const lastLines = (text: string, count: number) => text.trim().split(/\r?\n/).slice(-count).join(' | ');

async function typecheck(root: string, tier: Tier): Promise<Outcome[]> {
  const kernel = path.join(root, 'kernel');
  const tsc = path.join(kernel, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new GateError('TypeScript is not installed at ' + path.dirname(path.dirname(tsc)) + '; run npm ci --offline in kernel/');
  const outcomes: Outcome[] = [];
  for (const folder of ['kernel', 'tools']) {
    const base = { check: folder + '.typecheck', tier, caught: folder + "'s type errors, as self-test section 155 catches them" };
    const ran = await runChild(process.execPath, [tsc, '-p', path.join(root, folder, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], kernel, CHECK_LIMIT);
    const errors = ran.output.split(/\r?\n/).filter(line => /error TS\d+/.test(line));
    outcomes.push(ran.status === 0 && errors.length === 0
      ? { ...base, status: 'pass', seconds: ran.seconds, detail: 'tsc --noEmit found no type error' }
      : { ...base, status: 'fail', seconds: ran.seconds, detail: 'tsc found ' + errors.length + ' type error(s) (exit ' + ran.status + '): ' + errors.slice(0, 4).join(' | ') });
  }
  return outcomes;
}

function kernelSrcFiles(root: string): string[] {
  return fs.readdirSync(path.join(root, 'kernel', 'src')).filter((file) => file.endsWith('.ts')).map((file) => `kernel/src/${file}`);
}

/** A file of the working tree, or null when it is not there. */
function treeFile(root: string, file: string): string | null {
  const full = path.join(root, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/** A file at a revision (`''` is the index), or null when the revision does not hold it; any other git failure throws. */
function revisionFile(root: string, revision: string, file: string): string | null {
  const spec = `${revision}:${file}`;
  const present = spawnSync('git', ['cat-file', '-e', spec], { cwd: root, env: repositoryNeutralEnv(), encoding: 'utf8', timeout: GIT_LIMIT, windowsHide: true });
  if (present.error) throw new GateError(`git cat-file -e ${spec} did not finish within ${GIT_LIMIT / 1000}s: ${present.error.message}`);
  return present.status === 0 ? git(root, ['show', spec]) : null;
}

function coverage(root: string, tier: Tier): Outcome {
  const started = Date.now();
  // section-covers.json and each lane's claim file, as one map (kickoffs/s210 row 2).
  const covers = mergeCovers(coversFiles(file => treeFile(root, file)), sectionSources(file => treeFile(root, file)));
  const missing = unclaimedFiles(covers, kernelSrcFiles(root));
  const base = { check: 'selftest.claims-cover-kernel', tier, seconds: (Date.now() - started) / 1000, caught: 'none found (new in S113)' };
  if (missing.length) return { ...base, status: 'fail', detail: `no self-test section claims ${missing.join(', ')}: add each to a section in ${COVERS_PATH}` };
  return { ...base, status: 'pass', detail: `every kernel/src file is claimed by a section in ${COVERS_PATH}` };
}

/** A mixed code commit skips the document-only gate; the full Windows checks are optional. */
export function docsSkipDetail(powerShell: boolean): string {
  return powerShell ? 'not a docs-only commit: document checks are available in the optional cut tier'
    : 'not a docs-only commit: no document checks run on this platform';
}

async function docsGate(root: string, tier: Tier, powerShell = powerShellPresent(), documents: string[] = []): Promise<Outcome> {
  const ran = await runChild(process.execPath, [path.join(root, 'tools', 'docs-gate.ts'), ...documents.flatMap(file => ['--file', file])], root, CHECK_LIMIT);
  const base = { check: 'docs.gate', tier, seconds: ran.seconds, caught: 'the document checks it names, for a docs-only commit (S104 row 0b)' };
  if (ran.status === 0) return { ...base, status: 'pass', detail: lastLines(ran.output, 1) };
  if (ran.status === 3) return { ...base, status: 'fail', detail: ran.output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).join(' | ') || lastLines(ran.output, 3) };
  if (ran.status === 4) return { ...base, status: 'skip', detail: docsSkipDetail(powerShell) };
  throw new GateError(`the docs gate could not decide (exit ${ran.status}): ${lastLines(ran.output, 2)}`);
}

/** What the commit (or --commit <sha>) changed, and the selection rules over it. */
export function selection(root: string, commit: string | null, outgoing = false): { selection: Selection; changed: string[]; selectedSha: string | null } {
  if (commit === null && !outgoing) {
    const changed = git(root, ['diff', '--name-only', '--no-renames', '--cached', 'HEAD']).split(/\r?\n/).filter(Boolean);
    return {selection: stagedSelection(args => git(root, args), true, file => treeFile(root, file)), changed, selectedSha:null};
  }
  const selectedSha = outgoing ? git(root, ['rev-parse', 'origin/master']).trim() : null;
  const range = outgoing ? [selectedSha!, 'HEAD'] : commit === null ? ['--cached', 'HEAD'] : [`${commit}^`, commit];
  const current = outgoing ? 'HEAD' : commit === null ? '' : commit;
  const previous = outgoing ? selectedSha! : commit === null ? 'HEAD' : `${commit}^`;
  const changed = git(root, ['diff', '--name-only', '--no-renames', ...range]).split(/\r?\n/).filter(Boolean);
  // The legacy file and each lane file (kickoffs/s210 row 2): a changed one is read at the selected revision, any other
  // from the working tree, and each changed one brings its own hunks for rule (d).
  const sources = sectionSources(file => changed.includes(file) ? revisionFile(root, current, file) : treeFile(root, file));
  const covers = mergeCovers(coversFiles(file => revisionFile(root, current, file)), sources);
  const previousCovers = mergeCovers(coversFiles(file => revisionFile(root, previous, file)));
  const hunks = (file: string) => changed.includes(file) ? parseHunks(git(root, ['diff', '-U0', '--no-renames', ...range, '--', file])) : [];
  return { selection: selectSections({ changed, selftestHunks: hunks(SELFTEST_PATH), selftestText: sources[0]!.text, covers, previousCovers,
    laneSources: sources.slice(1).map(source => ({ ...source, hunks: hunks(source.file) })) }), changed, selectedSha };
}

async function selftestSections(root: string, tier: Tier, chosen: Selection, workers?: number, platform: string = process.platform, note: (line: string) => void = line => { process.stdout.write(line + '\n'); }): Promise<{ outcome: Outcome; sections: number[] }> {
  const check = 'kernel.selftest (selected sections)';
  const caught = 'every defect the kernel self-test catches, for the sections a commit touches';
  if (!chosen.all && chosen.sections.length === 0) return { outcome: { check, tier, status: 'skip', seconds: 0, caught, detail: 'no change selects a section' }, sections: [] };
  // The platform's skips leave the selection (kickoffs/s153 row 6); on Windows nothing changes.
  const skips = readPlatformSkips(root, platform);
  const policy = skips.size ? applyPlatformSkips(chosen.all ? sectionNumbers(suiteText(path.join(root, SELFTEST_PATH)), '') : chosen.sections, skips) : null;
  if (policy?.line) note(`     ${policy.line}`);
  if (policy && policy.sections.length === 0) return { outcome: { check, tier, status: 'skip', seconds: 0, caught, detail: `every selected section is skipped here: ${policy.line}` }, sections: [] };
  const env = { LIBRARY_SELFTEST_SECTIONS: policy ? policy.sections.join(',') : chosen.all ? '' : chosen.sections.join(',') };
  const ran = await runChild(process.execPath, [path.join(root, 'kernel', 'test', 'run-parallel.ts'), ...(workers === undefined ? [] : ['--workers', String(workers)])], path.join(root, 'kernel'), RUNNER_LIMIT, env);
  for (const line of ran.output.split(/\r?\n/)) if (/^section (?:\d+|whole) took [\d.]+ s of its [\d.]+ s limit$/.test(line)) process.stderr.write(line + '\n');
  const what = chosen.all ? 'every section' : `sections ${chosen.sections.join(', ')}`;
  const outcome: Outcome = ran.status === 0 ? { check, tier, status: 'pass', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 1)}` }
    : { check, tier, status: 'fail', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 3).slice(0, 1200)}` };
  return { outcome, sections: policy?.sections ?? (chosen.all ? sectionNumbers(suiteText(path.join(root, SELFTEST_PATH)), '') : chosen.sections) };
}

/** Keep the changed text in an expensive commit; the runners retain its full selection. */
export function boundedCommitSelection(root: string, chosen: Selection, workers: number): { selection: Selection; deferred: number; line: string | null } {
  const inventory = sectionNumbers(suiteText(path.join(root, SELFTEST_PATH)), '');
  const selected = chosen.all ? inventory : chosen.sections;
  const file = path.join(root, 'kernel/test/section-times.json');
  const times = parseTimes(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{"schema":1,"from":[],"sections":{}}');
  const measured = selected.every(section => Object.hasOwn(times.sections, section));
  const fits = estimateSeconds(selected, times, workers) <= COMMIT_SELECTION_BUDGET_SECONDS;
  // Zero or one section cannot exceed any valid, nonempty smoke set.
  if (fits && (measured || selected.length <= 1)) return { selection: chosen, deferred: 0, line: null };
  const smoke = JSON.parse(fs.readFileSync(path.join(root, 'kernel/test/smoke-sections.json'), 'utf8')) as {schema:number;sections:Record<string,string>};
  if (!smoke || smoke.schema !== 1 || !smoke.sections || Array.isArray(smoke.sections) || typeof smoke.sections !== 'object'
    || !Object.keys(smoke.sections).length || Object.entries(smoke.sections).some(([key, why]) => !/^[1-9]\d*$/.test(key) || typeof why !== 'string' || !why.trim() || !inventory.includes(Number(key)))) throw new GateError('invalid smoke-sections.json');
  // Without complete measurements, only selections no larger than smoke may use the estimate.
  if (!measured && fits && selected.length <= Object.keys(smoke.sections).length) return { selection: chosen, deferred: 0, line: null };
  const sections = Object.keys(smoke.sections).map(Number);
  const own = [...new Set(chosen.ownSections ?? [])];
  if (own.some(section => !inventory.includes(section))) throw new GateError('bounded commit names a missing changed section');
  own.sort((a,b) => (times.sections[a] ?? Infinity) - (times.sections[b] ?? Infinity) || a-b);
  for (const section of own) {
    if (sections.includes(section)) continue;
    if (!own.some(value => sections.includes(value)) || estimateSeconds([...sections, section], times, workers) <= COMMIT_SELECTION_BUDGET_SECONDS) sections.push(section);
  }
  sections.sort((a,b) => a-b);
  const deferredOwn = own.filter(section => !sections.includes(section)).sort((a,b) => a-b);
  const left = selected.filter(section => !sections.includes(section)).length;
  return { selection: {...chosen, all:false, sections}, deferred:left, line:`commit check: ran ${sections.length} sections; left ${left} to the runners${deferredOwn.length ? '; deferred changed sections: ' + deferredOwn.join(', ') : ''}` };
}

/**
 * WHETHER POWERSHELL IS ON THIS MACHINE (kickoffs/s157 row 7). Windows always has `powershell.exe`; elsewhere it is
 * whatever PATH holds. No tier depends on it any more (kickoffs/s224 row 3); only the docs gate's skip wording reads it.
 */
export function powerShellPresent(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (file: string) => boolean = fs.existsSync): boolean {
  if (platform === 'win32') return true;
  return (env['PATH'] ?? '').split(':').filter(Boolean).some((folder) => exists(path.posix.join(folder, 'powershell.exe')));
}
/** WHERE A TIER RUNS: every tier in Node, on every platform, with or without PowerShell (kickoffs/s224 row 3). */
export function tierRoute(_tier: Tier, _powerShell: boolean): { route: 'node' } {
  return { route: 'node' };
}

/** Every ported check over the whole tree, for the cut and release tiers (the old runner ran them all by hand). */
async function everyPortedCheck(root: string): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const run of Object.values(PORTED_CHECKS)) outcomes.push(await run(root));
  return outcomes;
}

/** The cut and release tiers' self-test: every section the platform policy selects, as run-parallel.ts runs them. */
async function parallelSections(root: string, tier: Tier): Promise<Outcome> {
  const ran = await runChild(process.execPath, [path.join(root, 'kernel', 'test', 'run-parallel.ts')], path.join(root, 'kernel'), RUNNER_LIMIT, { LIBRARY_SELFTEST_SECTIONS: '' });
  const skipped = /^linux: .*$/m.exec(ran.output)?.[0];
  if (skipped) process.stdout.write(`     ${skipped}\n`);
  return {
    check: 'kernel.selftest (every section, run-parallel.ts)', tier, status: ran.status === 0 ? 'pass' : 'fail', seconds: ran.seconds,
    caught: 'every defect the kernel self-test catches', detail: ran.status === 0 ? lastLines(ran.output, 1) : `exit ${ran.status}: ${lastLines(ran.output, 3).slice(0, 1200)}`,
  };
}

/**
 * THE PUSH TIER'S POOL (PLAN-fast-gates.md Unit B): the selected self-test sections in one pool of 8 slots
 * (DESKPOST_GATE_WORKERS overrides), exclusive sections after the barrier. The old runner's static run and suites are
 * gone (kickoffs/s224 row 3): their checks are ported to tools/gate-checks.ts or retired.
 */
async function pushChecks(root: string, say: (outcome: Outcome) => void, note: (line: string) => void, requireSections: string[], chosen: Selection, platform: string = process.platform, tier: Tier = 'push'): Promise<number[]> {
  const options = parseOptions(['--suite', path.join(root, SELFTEST_PATH)]);
  const all = sectionNumbers(suiteText(path.join(root, 'kernel', 'test', 'selftest.ts')), '');
  const selected = chosen.all ? all : chosen.sections;
  const policy = applyPlatformSkips([...new Set([...selected, ...requireSections.map(Number)])].sort((a,b) => a-b), readRootPlatformSkips(root, platform));
  if (policy.line) note(`     ${policy.line}`);
  const sections = policy.sections;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-push-'));
  fs.mkdirSync(path.join(folder, 'sections'));
  note(`     ${tier} tier: ${sections.length} self-test sections in ${options.workers} slots; exclusive after the barrier: sections ${SERIAL_SECTIONS.join(', ')}. Log: ${folder}`);
  const items: PoolItem<Result>[] = sections.map((section) => ({ name: `section ${section}`, exclusive: SERIAL_SECTIONS.includes(section), run: (signal: AbortSignal) => runSection(options, section, path.join(folder, 'sections'), signal) }));

  const controller = new AbortController();
  const cancel = () => { interrupted = true; controller.abort(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let results: Result[];
  try { results = await runPool(items, options.workers, controller.signal); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }

  results = [...results].sort((a, b) => Number(a.section) - Number(b.section));
  const total = results.reduce((sum, result) => sum + result.checks, 0);
  const failedSections = results.filter((result) => result.verdict === 'FAIL');
  const flatten = (value: string) => value.replace(/[\r\n]+/g, ' | ');
  fs.writeFileSync(path.join(folder, 'sections.log'), results.map((r) => `section ${r.section}: ${r.verdict} ${r.checks} checks ${r.seconds.toFixed(3)}s${r.detail ? ` ${flatten(r.detail)}` : ''}`).join('\n') + '\n');
  for (const result of results) { const warning = sectionLimitWarning(result, options.sectionTimeout); if (warning) note(warning); }
  if (requireSections.length) say(requiredOutcome(fs.readFileSync(path.join(folder, 'sections.log'), 'utf8'), requireSections, tier));
  const missingSections = sections.filter((section) => !results.some((result) => result.section === section));
  const caught = 'every defect the kernel self-test catches, for the sections the outgoing commits select';
  say(failedSections.length || missingSections.length || controller.signal.aborted
    ? { check: 'kernel.selftest', tier, status: 'fail', seconds: null, caught, detail: `kernel self-test FAILED (${failedSections.length || 1} of ${total}): ${[...failedSections.map((r) => `section ${r.section}: ${flatten(r.detail)}`), ...missingSections.map((n) => `section ${n}: not run`)].join('; ').slice(0, 1200) || 'cancelled'}` }
    : { check: 'kernel.selftest', tier, status: 'pass', seconds: null, caught, detail: `kernel self-test passed (${total} checks). ${results.length} sections pooled` });
  return results.map(result => Number(result.section));
}

function releaseOnly(): Outcome[] {
  const later = (check: string, where: string): Outcome => ({ check, tier: 'release', status: 'skip', seconds: null, caught: 'see docs/releasing.md', detail: `not in gate.ts yet: ${where}` });
  return [
    later('built-release tests', 'tools/Test-BuiltRelease.ps1 -PreviousRelease <the previous rel>, until tools/test-built-release.ts (session 5)'),
    later('compiled self-test sections', "LIBRARY_SELFTEST_KERNEL=<the release library.exe>: 116, 117, 130-133, and 143, 144, 146, 147 on an unbumped build (docs/releasing.md)"),
    later('reader adapter checks', 'reader.launch-validation, .dispatch-selftest, .shelf-selftest, .project-pin-selftest, .shared-selftest: in the runner child today; the release tier beside the adapter exception (docs/powershell-inventory.md)'),
  ];
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

interface OldGate { status: Status; seconds: number | null; checks: { check: string; status: Status; seconds?: number | null }[] }
function oldGate(value: string): OldGate {
  const parsed = JSON.parse(value) as OldGate;
  const statuses = ['pass','warn','fail','skip'];
  if (!parsed || !statuses.includes(parsed.status) || !(parsed.seconds === null || (Number.isFinite(parsed.seconds) && parsed.seconds >= 0)) || !Array.isArray(parsed.checks)
    || parsed.checks.some(check => !check || typeof check.check !== 'string' || !statuses.includes(check.status))) throw new GateError('--compare-with requires {status, seconds: number|null, checks: [{check,status,seconds?}]}');
  if (new Set(parsed.checks.map(check => check.check)).size !== parsed.checks.length) throw new GateError('--compare-with repeats a check name');
  return parsed;
}

/** A pre-commit has no final commit object yet. Bind the row to its parent and exact staged diff.
 * The handback records the resulting commit SHA beside this identity. Missing old observations stay missing. */
function compareGates(root: string, old: OldGate, outcomes: Outcome[], seconds: number, exit: number, selection: unknown, error?: string, json = false): void {
  const output = json ? process.stderr : process.stdout;
  const normal = (name: string) => name.replace(' (selected sections)', '');
  const newStatus: Status = exit === 0 ? 'pass' : 'fail';
  const checks = outcomes.filter(outcome => !outcome.diagnostic).map(outcome => {
    const prior = old.checks.find(check => normal(check.check) === normal(outcome.check));
    return { check: normal(outcome.check), old: prior?.status ?? null, new: outcome.status, old_seconds: prior?.seconds ?? null, new_seconds: outcome.seconds };
  });
  const disagreements = checks.filter(check => check.old !== null && check.old !== check.new).map(check => check.check);
  if (old.status !== newStatus) disagreements.unshift('gate verdict');
  const gaps = old.checks.length ? [] : ['The old hook provides its passing aggregate verdict only; no old per-check observations are available.'];
  const common = path.resolve(root, git(root, ['rev-parse','--git-common-dir']).trim());
  const log = path.join(common, 'deskpost-gate-compare.log');
  const record = { schema: 1, at: new Date().toISOString(), commit: { parent: git(root, ['rev-parse','HEAD']).trim(), staged_diff_sha256: createHash('sha256').update(git(root,['diff','--cached','--binary','--no-ext-diff'])).digest('hex') }, old: {status:old.status,seconds:old.seconds}, new: {status:newStatus,seconds,exit}, checks, selection, disagreements, gaps, ...(error ? {error} : {}) };
  fs.appendFileSync(log, JSON.stringify(record)+'\n');
  output.write(`gate comparison appended: ${log}; extra ${seconds.toFixed(1)}s\n`);
  if (gaps.length) output.write(`WARN: gate comparison: ${gaps.join(' ')}\n`);
  if (disagreements.length || exit === EXIT_GATE) output.write(`WARN: gate comparison ${exit === EXIT_GATE ? 'new gate failed to run' : 'disagrees'}: ${error ?? disagreements.join(', ')}; the old gate still decides.\n`);
}

async function scanChecks(root: string): Promise<Outcome[]> {
  const ran = await runChild(process.execPath, [fs.realpathSync(path.join(root,'tools/scan.ts')),'--identity','--deployment','--root',root,'--json'],root,CHECK_LIMIT);
  if (ran.status === 2 || ran.status === null) throw new GateError('the scans failed to run: '+lastLines(ran.output,2));
  let parsed: Record<string,{status:Status;detail:string}>;
  try { parsed=JSON.parse(ran.output) as typeof parsed; } catch { throw new GateError('the scans returned no JSON report: '+lastLines(ran.output,2)); }
  return ['identity','deployment'].map(name => {
    const result=parsed[name];
    if (!result || !['pass','warn','fail'].includes(result.status)) throw new GateError('the scans omitted a verdict for '+name);
    return { check: name==='identity'?'public.identity-scan':'public.no-deployment-defaults',tier:'commit',status:result.status,seconds:ran.seconds,detail:result.detail,caught:'DeploymentScan.ps1 oracle parity, section 262' };
  });
}

/** Settings and hook templates keep their static checks even when the full runner is not used. */
export function settingsChecksForPaths(changed: readonly string[]): string[] {
  return pathChecks(changed);
}

export async function settingsChecks(root: string, changed: string[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const file of changed.filter(file => file.endsWith('.json'))) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue; // A deletion has no new JSON to parse; semantic checks still run.
    try { JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')); }
    catch(error) { outcomes.push({check:`json.parse: ${file}`,tier:'commit',status:'fail',seconds:0,detail:String(error),caught:'malformed changed configuration'}); }
  }
  // Each named check is a function in tools/gate-checks.ts; none starts a process (kickoffs/s224 row 2). The only names
  // the map may hold without one are c174's acceptance checks, which leave with the matrix (section 1961).
  for (const name of settingsChecksForPaths(changed)) {
    const port = PORTED_CHECKS[name];
    outcomes.push(port ? await port(root) : { check: name, tier: 'commit', status: 'skip', seconds: 0,
      detail: `not in the gate: tools/gate-checks.ts has no ${name}; it leaves tools/check-map.json with the acceptance matrix (c174)`, caught: 'none: a check retired with the matrix' });
  }
  return outcomes;
}

/** Sample only for the record; no admission or verdict depends on free memory. */
export function memorySampler(read = () => os.freemem(), now = () => new Date().toISOString()) {
  let free_min_mb = Math.floor(read() / 1048576), free_min_at = now();
  return {
    sample: () => { const value = Math.floor(read() / 1048576); if (value < free_min_mb) { free_min_mb = value; free_min_at = now(); } return value; },
    minimum: () => ({ free_min_mb, free_min_at }),
  };
}

async function runTier(argv: string[], tierWait: GateWait | null = null, platform: string = process.platform): Promise<number> {
  const options = parseArgs(argv, platform);
  const root = path.resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const started = Date.now();
  // Free memory at the start and end of the run, in whole megabytes (s196 row 3); nothing reads it yet.
  const megabytes = (bytes: number) => Math.floor(bytes / 1048576);
  const memory = memorySampler();
  const freeStart = memory.minimum().free_min_mb;
  const memoryTimer = setInterval(() => memory.sample(), 1000);
  try {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const clean = git(root, ['status', '--porcelain']).trim() === '';
  const outcomes: Outcome[] = [];
  const say = (outcome: Outcome) => {
    outcomes.push(outcome);
    if (!options.json) {
      const time = outcome.seconds === null ? '   -  ' : `${outcome.seconds.toFixed(1).padStart(5)}s`;
      process.stdout.write(`${outcome.status.toUpperCase().padEnd(4)} ${time} ${outcome.check}${outcome.diagnostic ? ' (diagnostic)' : ''}${outcome.detail ? `: ${outcome.detail}` : ''}\n`);
    }
  };

  for (const outcome of await typecheck(root, 'commit')) say(outcome);
  say(coverage(root, 'commit'));
  const chosen = selection(root, options.commit, options.tier === 'push');
  let executed: Selection | null = null, deferred = 0, workerCount: number | null = null;
  const documents = chosen.changed.filter(file => /\.md$/.test(file) && !/^(?:kernel|tools|templates|\.)/.test(file) && fs.existsSync(path.join(root, file)));
  say(await docsGate(root, 'commit', powerShellPresent(), documents));
  if (!options.json) {
    const what = chosen.selection.all ? 'every section' : chosen.selection.sections.length ? `sections ${chosen.selection.sections.join(', ')}` : 'no section';
    process.stdout.write(`     self-test selection: ${what}${options.tier === 'commit' || options.tier === 'push' ? '' : ' (this tier runs every section through kernel/test/run-parallel.ts instead)'}\n`);
    for (const reason of chosen.selection.reasons) process.stdout.write(`       ${reason}\n`);
  }
  if (options.tier === 'commit' || options.tier === 'push') {
    if (options.tier === 'commit') {
      const started = performance.now(), problems = lineEndingProblems(root);
      say({check:'staged.line-endings',tier:'commit',status:problems.length ? 'fail' : 'pass',seconds:(performance.now()-started)/1000,detail:problems.length ? problems.join('; ') : 'staged text has no lone carriage return or new CRLF over LF',caught:'staged line-ending changes, section 1852'});
    }
    for (const outcome of await scanChecks(root)) say(outcome);
    for (const outcome of await settingsChecks(root, chosen.changed)) say(outcome);
    for (const outcome of inventoryChecks(root, options.tier)) say(outcome);
    const earlyFailures = outcomes.filter(outcome => outcome.status === 'fail' && !outcome.diagnostic);
    if (!options.compare && earlyFailures.length) {
      say({ check: options.tier === 'push' ? 'kernel.selftest' : 'kernel.selftest (selected sections)', tier: options.tier,
        status: 'skip', seconds: 0, detail: `not run: ${earlyFailures.map(outcome => outcome.check).join(', ')} failed first`,
        caught: 'failed early checks must stop the tier before its self-test' });
    } else {
      // Wait outside the child's run limit; its inherited hold also covers opt-in whole-suite comparisons.
      const lockSay = (line: string) => (options.json ? process.stderr : process.stdout).write(line + '\n');
      const workers = options.tier === 'commit' && !options.compare ? Math.min(COMMIT_MAX_WORKERS, parseOptions([]).workers) : undefined;
      const bounded = workers === undefined ? {selection:chosen.selection,deferred:0,line:null} : boundedCommitSelection(root, chosen.selection, workers);
      const selectionLock = options.tier === 'commit' && (chosen.selection.all || chosen.selection.sections.length > 0) ? await withHookSeat(() => acquireGateLock(options.compare ? 'commit comparison' : 'commit', options.noWait, lockSay, {exclusive: Boolean(options.compare) && chosen.selection.all})) : null;
      const notice = selectionLock && gateLockOffNotice(selectionLock);
      if (notice) lockSay(notice);
      try {
        deferred = bounded.deferred; workerCount = workers ?? parseOptions([]).workers;
        if (options.tier === 'push') executed = { ...chosen.selection, all: false, sections: await pushChecks(root, say, lockSay, options.requireSections, chosen.selection, platform) };
        else {
          const ran = await selftestSections(root, 'commit', bounded.selection, workers, platform, lockSay);
          say(ran.outcome); executed = { ...bounded.selection, all: false, sections: ran.sections };
          if (bounded.line) lockSay(bounded.line);
        }
      } finally { await selectionLock?.release(); }
      if (selectionLock?.wait) tierWait = selectionLock.wait;
    }
  }
  else {
    // The cut and release tiers (tierRoute: Node everywhere): the scans, every ported check over the whole tree, then
    // every section. The release tier pools its sections so --require-sections can read their log (kickoffs/s224 row 3).
    const note = (line: string) => (options.json ? process.stderr : process.stdout).write(line + '\n');
    if (!options.json) process.stdout.write(`     ${options.tier} tier: the scans, every ported check (tools/gate-checks.ts), then every section through kernel/test/run-parallel.ts\n`);
    for (const outcome of await scanChecks(root)) say(outcome);
    for (const outcome of await everyPortedCheck(root)) say(outcome);
    if (options.tier === 'cut') say(await parallelSections(root, options.tier));
    else {
      executed = { ...chosen.selection, all: false, sections: await pushChecks(root, say, note, options.requireSections, { ...chosen.selection, all: true }, platform, 'release') };
      releaseOnly().forEach(say);
    }
  }

  const movement = options.tier === 'push' ? masterMoved(root, chosen.selectedSha!) : null;
  if (movement) (options.json ? process.stderr : process.stdout).write(movement.line + '\n');
  const total = (Date.now() - started) / 1000;
  const budget = BUDGETS[options.tier];
  const failed = outcomes.filter((outcome) => outcome.status === 'fail' && !outcome.diagnostic).length;
  const overBudget = budget !== null && total > budget;
  const exit = failed ? EXIT_FAIL : EXIT_PASS;
  const recordedSelection = { requested: { ...chosen.selection, changed: chosen.changed }, executed,
    ...(executed === null ? {} : { executed_basis: 'planned sections after skips and required additions; a failed run may stop before completing this list' }),
    deferred, workers: workerCount };
  const freeEnd = memory.sample();
  const report = { schema: 1, tier: options.tier, commit: options.commit, head, clean, budget_seconds: budget, total_seconds: Math.round(total * 10) / 10, over_budget: overBudget, exit, memory: { total_mb: megabytes(os.totalmem()), free_start_mb: freeStart, free_end_mb: freeEnd, ...memory.minimum() }, selection: recordedSelection, checks: outcomes, ...(movement?.master_moved ? { master_moved: movement.master_moved } : {}) };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    const count = (status: Status) => outcomes.filter((outcome) => outcome.status === status && !outcome.diagnostic).length;
    const diagnostics = outcomes.filter((outcome) => outcome.diagnostic);
    const aside = diagnostics.length ? ` Diagnostics, not acceptance: ${diagnostics.map((outcome) => `${outcome.check} ${outcome.status}`).join(', ')}.` : '';
    process.stdout.write(`${options.tier} tier: ${clock(total)}${budget === null ? ' (measured; no budget yet)' : ` of ${clock(budget)}`}. ${count('pass')} passed, ${count('warn')} warned, ${failed} failed, ${count('skip')} skipped${tierWait ? `, after a ${tierWait.seconds} s lock wait` : ''}.${aside}\n`);
    if (overBudget) process.stdout.write(`WARN: the ${options.tier} tier took ${clock(total)}, over its ${clock(budget!)} budget. Over budget is a warning, never a failure.\n`);
  }
  keepRecord(root, report, tierWait, options.json);
  if (options.compare) { compareGates(root, options.compare, outcomes, total, exit, { ...chosen.selection, changed: chosen.changed, ...recordedSelection }, undefined, options.json); return EXIT_PASS; }
  return exit;
  } finally { clearInterval(memoryTimer); }
}

/** EVERY GATE RUN KEEPS ITS RECORD (kickoffs/s136 row 2; PLAN-develops-itself.md criterion 8): the object `--json` prints,
 * with the lock waits the run recorded, at `.gate/runs/<UTC stamp>-<tier>.json` in the checkout (git-ignored). A failed
 * write says so in one line and never changes the verdict or the exit code. */
function keepRecord(root: string, report: { tier: string }, wait: GateWait | null, json: boolean): void {
  const output = json ? process.stderr : process.stdout;
  try {
    const folder = path.join(root, '.gate', 'runs');
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    let file = path.join(folder, `${stamp}-${report.tier}.json`);
    for (let n = 2; fs.existsSync(file); n += 1) file = path.join(folder, `${stamp}-${report.tier}-${n}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...report, waits: wait ? [wait] : [] }) + '\n', { flag: 'wx' });
    output.write(`gate record: ${path.relative(root, file).split(path.sep).join('/')}\n`);
  } catch (error) {
    output.write(`gate record not written: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// Platform is an in-process test seam only, never a flag or environment override.
export async function main(argv: string[], platform: string = process.platform): Promise<number> {
  const options = parseArgs(argv, platform);
  if (options.sectionsLog !== null) {
    const outcome = requiredOutcome(fs.readFileSync(options.sectionsLog, 'utf8'), options.requireSections, 'push');
    process.stdout.write(`${outcome.status.toUpperCase()} ${outcome.check}: ${outcome.detail}\n`);
    return outcome.status === 'fail' ? EXIT_FAIL : EXIT_PASS;
  }
  // A REQUIRED SECTION THAT CANNOT PASS HERE IS REFUSED BEFORE THE LOCK AND BEFORE ANY CHECK (kickoffs/s153 row 5): s152's
  // first push tier ran 19m 43s to fail only on sections it skips by declaration. Exit 2, the gate's own failure.
  if (options.requireSections.length) {
    const root = path.resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
    const refusals = requiredListRefusals(options.requireSections, suiteText(path.join(root, SELFTEST_PATH)), readRootPlatformSkips(root, platform));
    // Printed on every required list, not on a refusal only (kickoffs/s169 row 6): a list that all runs is shown too.
    process.stderr.write(`required sections this platform runs: ${options.requireSections.filter((s) => !refusals.some((r) => r.startsWith(`section ${s} `))).join(',') || 'none'}\n`);
    if (refusals.length) throw new GateError(refusals.join('; '));
  }
  const say = (line: string) => (options.json ? process.stderr : process.stdout).write(line + '\n');
  const lock = options.tier === 'commit' ? null : await acquireGateLock(options.tier, options.noWait, say, {exclusive: options.tier === 'cut'});
  const notice = lock && gateLockOffNotice(lock);
  if (notice) say(notice);
  const started=Date.now();
  try { return await runTier(argv, lock?.wait ?? null, platform); }
  catch (error) {
    if (!options.compare) throw error;
    const root=path.resolve(git(process.cwd(),['rev-parse','--show-toplevel']).trim());
    compareGates(root,options.compare,[],(Date.now()-started)/1000,EXIT_GATE,null,error instanceof Error?error.message:String(error), options.json);
    if (options.json) process.stdout.write(JSON.stringify({schema:1,tier:options.tier,exit:EXIT_GATE,error:String(error)})+String.fromCharCode(10));
    return EXIT_PASS;
  } finally { await lock?.release(); }
}
// Run as a program, not when a self-test imports the tier choice above (section 433); a junctioned path is the same file.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof LockError ? error.code : EXIT_GATE);
  },
);
