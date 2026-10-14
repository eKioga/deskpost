/**
 * THE GATE BY TIERS (PLAN-powershell-free-development.md, Session 1 items 1-3; kickoffs/s113 rulings 14-15):
 *
 *   node tools/gate.ts --tier commit|cut|push|release [--json] [--no-wait] [--commit <sha>]
 *   npm --prefix kernel run gate -- --tier <tier> ...
 *
 * One line per check with its time (`PASS 6.3s kernel.typecheck`), then the total against the tier's budget
 * (`commit tier: 1m 32s of 2m`). Over budget is a warning, never a failure. A higher tier runs every check of the
 * tiers below it. Headless: no prompt, stdin unused.
 *
 *   exit 0  every check passed (a WARN passes, as the runner's does);
 *   exit 1  a check failed;
 *   exit 2  the gate itself failed (an unknown argument, git or a child that could not run, a malformed claim map);
 *   exit 3  waiting refused under --no-wait. Cut, push and release take the c2 machine-wide live gate lock.
 *
 * NOTHING CALLS THIS BUT A PERSON in S113: no hook and no runner. It ports no check (session 2 does). What each tier
 * runs today:
 *   commit   the kernel type check (tsc --noEmit); the claim map's coverage (rule a); the docs gate as it is
 *            (`node tools/docs-gate.ts`, which judges a docs-only commit and says "not docs-only" for any other);
 *            the kernel self-test sections the changed files select (tools/section-select.mts, rules b-d).
 *   cut      the commit tier's checks, but every self-test section runs inside `Invoke-LibraryChecks.ps1 -Fast`, run
 *            as a child for everything not yet ported.
 *   push     today's full gate's check set, exactly, in one pool (PLAN-fast-gates.md Unit B, S119): the static checks
 *            once (`Invoke-LibraryChecks.ps1 -Fast`), every kernel self-test section as its own child (Unit A's
 *            contract), and each -Fast roster suite as an `-Only <name>` child. Its kernel.selftest row is the
 *            sections' verdict, and its roster rows are the suites' own. The claim map's coverage and the docs gate
 *            are diagnostics here, never acceptance; self-test section 155 is its type check.
 *   release  the push tier, and the release checks gate.ts does not run yet, each named with where it runs today.
 *
 * EVERY CHILD HAS A LIMIT: git 60 seconds; the type check and the docs gate 10 minutes; the cut tier's runner 45; in
 * the push pool a section 10 (Unit A), a suite 15, the three slowest suites 25, the static run 15.
 *
 * THE CHILDREN'S ENVIRONMENT is the pre-commit hook's: LIBRARY_WORKSPACE, LIBRARY_SEAT and LIBRARY_SEAT_CLAIM blank,
 * every PATH entry holding a `deskpost` shim dropped; and, as the loop doc's push recipe and the release rules say,
 * ORCA_TERMINAL_HANDLE blank and DESKPOST_UPDATE_CHECK unset.
 *
 * --commit <sha> chooses the self-test sections as if <sha> were being committed (its diff against its parent, and
 * selftest.ts at <sha>), which is how S113 replayed S103's commits; every check still runs on this working tree.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from '../kernel/test/gate-env.ts';
import { acquireGateLock, LockError } from '../kernel/test/gate-lock.ts';
import { SERIAL_SECTIONS, fastRoster, parseOptions, rosterProblems, runBounded, runPool, runSection, sectionNumbers, startIdentity, terminateOwnedTree, type PoolItem, type Result } from '../kernel/test/run-parallel.ts';
import { COVERS_PATH, SELFTEST_PATH, parseCovers, parseHunks, selectSections, unclaimedFiles, type Selection } from './section-select.mts';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_GATE = 2;

type Tier = 'commit' | 'cut' | 'push' | 'release';
const TIERS: readonly Tier[] = ['commit', 'cut', 'push', 'release'];
/** Seconds; null is "measured" (no budget yet). The cut's 17 minutes is S103's -Fast gate, measured each run. */
const BUDGETS: Record<Tier, number | null> = { commit: 120, cut: 17 * 60, push: null, release: null };

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
const SUITE_LIMIT = 15 * MINUTE;
const STATIC_LIMIT = 15 * MINUTE;
/** The three slowest suites, measured 2026-10-11 (PLAN-fast-gates.md, "Measured"): 25 minutes each, started first. */
const SLOW_SUITES: Record<string, string> = { 'acceptance.harness-selftest': '690 s', 'library-helpers.boundary-suite': '551 s', 'notebook.migration': '524 s' };
const SLOW_SUITE_LIMIT = 25 * MINUTE;
/** Suites that start their own concurrency run alone, behind the barrier with the lane sections. None at b588e1e by
 * reading (S119): no roster suite starts a pool; library-helpers' nested -Fast run is against a scratch tree with no
 * kernel, and the rest start sleeper or lock-holder processes one or two at a time. A suite whose pooled verdict differs
 * from the serial gate's joins this list with both outputs in its comment (kickoffs/s119, standing answer 2). */
const EXCLUSIVE_SUITES: string[] = [];
/** The static run's own kernel.selftest runs this one section, and the push tier replaces that row with the verdict of
 * every section run in the pool: the static checks then run once without a second whole self-test beside the pool. */
const STATIC_RUN_SECTION = '1';

class GateError extends Error {}
let interrupted = false;

const USAGE = 'Usage: node tools/gate.ts --tier commit|cut|push|release [--json] [--no-wait] [--commit <sha>]';

function parseArgs(argv: string[]): { tier: Tier; json: boolean; commit: string | null; noWait: boolean } {
  let tier: Tier | null = null;
  let json = false;
  let commit: string | null = null;
  let noWait = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--tier' && i + 1 < argv.length) {
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
  if (tier === null) throw new GateError(`name a tier. ${USAGE}`);
  return { tier, json, commit, noWait };
}

function git(root: string, args: string[]): string {
  const ran = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, timeout: GIT_LIMIT, windowsHide: true });
  if (ran.error) throw new GateError(`git ${args.join(' ')} did not finish within ${GIT_LIMIT / 1000}s: ${ran.error.message}`);
  if (ran.status !== 0) throw new GateError(`git ${args.join(' ')} failed: ${`${ran.stderr ?? ''}`.trim()}`);
  return ran.stdout ?? '';
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
    const finish = (status: number | null, detail = '') => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
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

function coverage(root: string, tier: Tier): Outcome {
  const started = Date.now();
  const covers = parseCovers(fs.readFileSync(path.join(root, COVERS_PATH), 'utf8'));
  const missing = unclaimedFiles(covers, kernelSrcFiles(root));
  const base = { check: 'selftest.claims-cover-kernel', tier, seconds: (Date.now() - started) / 1000, caught: 'none found (new in S113)' };
  if (missing.length) return { ...base, status: 'fail', detail: `no self-test section claims ${missing.join(', ')}: add each to a section in ${COVERS_PATH}` };
  return { ...base, status: 'pass', detail: `every kernel/src file is claimed by a section in ${COVERS_PATH}` };
}

async function docsGate(root: string, tier: Tier): Promise<Outcome> {
  const ran = await runChild(process.execPath, [path.join(root, 'tools', 'docs-gate.ts')], root, CHECK_LIMIT);
  const base = { check: 'docs.gate', tier, seconds: ran.seconds, caught: 'the document checks it names, for a docs-only commit (S104 row 0b)' };
  if (ran.status === 0) return { ...base, status: 'pass', detail: lastLines(ran.output, 1) };
  if (ran.status === 3) return { ...base, status: 'fail', detail: ran.output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).join(' | ') || lastLines(ran.output, 3) };
  if (ran.status === 4) return { ...base, status: 'skip', detail: 'not a docs-only commit: its document checks run in the runner child (cut and push tiers) until session 2 ports them' };
  throw new GateError(`the docs gate could not decide (exit ${ran.status}): ${lastLines(ran.output, 2)}`);
}

/** What the commit (or --commit <sha>) changed, and the selection rules over it. */
function selection(root: string, commit: string | null): { selection: Selection; changed: string[] } {
  const covers = parseCovers(fs.readFileSync(path.join(root, COVERS_PATH), 'utf8'));
  const range = commit === null ? ['--cached', 'HEAD'] : [`${commit}^`, commit];
  const changed = git(root, ['diff', '--name-only', '--no-renames', ...range]).split(/\r?\n/).filter(Boolean);
  const hunks = changed.includes(SELFTEST_PATH) ? parseHunks(git(root, ['diff', '-U0', '--no-renames', ...range, '--', SELFTEST_PATH])) : [];
  const text = changed.includes(SELFTEST_PATH) ? git(root, ['show', commit === null ? `:${SELFTEST_PATH}` : `${commit}:${SELFTEST_PATH}`]) : '';
  return { selection: selectSections({ changed, selftestHunks: hunks, selftestText: text, covers }), changed };
}

async function selftestSections(root: string, tier: Tier, chosen: Selection): Promise<Outcome> {
  const check = 'kernel.selftest (selected sections)';
  const caught = 'every defect the kernel self-test catches, for the sections a commit touches';
  if (!chosen.all && chosen.sections.length === 0) return { check, tier, status: 'skip', seconds: 0, caught, detail: 'no change selects a section' };
  const env: Record<string, string> = chosen.all ? {} : { LIBRARY_SELFTEST_SECTIONS: chosen.sections.join(',') };
  const ran = await runChild(process.execPath, [path.join(root, 'kernel', 'test', 'selftest.ts')], root, RUNNER_LIMIT, env);
  const what = chosen.all ? 'every section' : `sections ${chosen.sections.join(', ')}`;
  if (ran.status === 0) return { check, tier, status: 'pass', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 1)}` };
  return { check, tier, status: 'fail', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 3).slice(0, 1200)}` };
}

/** Invoke-LibraryChecks.ps1 as a child; each of its check lines becomes an outcome with no time of its own. */
async function runner(root: string, tier: Tier, fast: boolean): Promise<Outcome[]> {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'Invoke-LibraryChecks.ps1'), ...(fast ? ['-Fast'] : [])];
  const ran = await runChild('powershell.exe', args, root, RUNNER_LIMIT);
  const outcomes: Outcome[] = [];
  for (const line of ran.output.split(/\r?\n/)) {
    const match = /^\[\s*(OK|WARN|FAIL|SKIP)\s*\]\s+(\S+)\s*(.*)$/.exec(line.trim());
    const statusOf: Record<string, Status> = { OK: 'pass', WARN: 'warn', FAIL: 'fail', SKIP: 'skip' };
    if (match) outcomes.push({ check: `${match[2]} (runner)`, tier, status: statusOf[match[1]!]!, seconds: null, detail: match[3]!.trim(), caught: 'as its row in docs/powershell-inventory.md says' });
  }
  const summary = /(\d+) passed, (\d+) warned, (\d+) failed, (\d+) skipped/.exec(ran.output);
  const status: Status = ran.status === 0 && summary !== null ? 'pass' : 'fail';
  outcomes.push({
    check: `Invoke-LibraryChecks.ps1${fast ? ' -Fast' : ''} (child, for everything not yet ported)`,
    tier,
    status,
    seconds: ran.seconds,
    caught: 'everything the PowerShell runner catches until session 2 ports it',
    detail: summary ? `${summary[0]} (exit ${ran.status})` : `no summary line (exit ${ran.status}): ${lastLines(ran.output, 3)}`,
  });
  return outcomes;
}

interface RunnerRow { check: string; status: string; detail: string }
const STATUS_OF: Record<string, Status> = { pass: 'pass', warn: 'warn', fail: 'fail', skipped: 'skip' };
const RUNNER_CAUGHT = 'as its row in docs/powershell-inventory.md says';

/** The last line of a -Json run that parses as its report, or null. */
function runnerReport(output: string): { checks: RunnerRow[] } | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    if (!line.startsWith('{')) continue;
    try { const report = JSON.parse(line) as { checks?: RunnerRow[] }; if (Array.isArray(report.checks)) return { checks: report.checks }; } catch { /* not the report */ }
  }
  return null;
}

/** Each roster suite as `Invoke-LibraryChecks.ps1 -Only <name> -Json`: the real profile, its own TEMP (Unit B step 4). */
async function suiteChild(root: string, name: string, folder: string, signal: AbortSignal): Promise<Outcome> {
  const temp = path.join(folder, 'temp');
  fs.mkdirSync(temp, { recursive: true });
  const limit = name in SLOW_SUITES ? SLOW_SUITE_LIMIT : SUITE_LIMIT;
  const ran = await runBounded({
    label: name, command: 'powershell.exe', cwd: root, limit, folder, env: { ...childEnv(), TEMP: temp, TMP: temp },
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'Invoke-LibraryChecks.ps1'), '-Only', name, '-Json'],
  }, signal);
  const base = { check: name, tier: 'push' as Tier, seconds: ran.seconds, caught: RUNNER_CAUGHT };
  if (ran.problem) return { ...base, status: 'fail', detail: ran.problem };
  const rows = runnerReport(ran.output)?.checks ?? null;
  if (rows === null) return { ...base, status: 'fail', detail: `${name}: no -Json report (exit ${ran.status}): ${lastLines(ran.output, 3)}` };
  if (rows.length !== 1 || rows[0]!.check !== name) return { ...base, status: 'fail', detail: `${name}: -Only reported ${rows.map((row) => row.check).join(', ') || 'nothing'}` };
  const status = STATUS_OF[rows[0]!.status] ?? 'fail';
  if ((status === 'fail') !== (ran.status !== 0)) return { ...base, status: 'fail', detail: `${name}: verdict ${rows[0]!.status} but exit ${ran.status}` };
  return { ...base, status, detail: rows[0]!.detail };
}

/**
 * THE PUSH TIER (PLAN-fast-gates.md Unit B, steps 2-5): today's full gate's check set, exactly, in one pool of 8 slots
 * (DESKPOST_GATE_WORKERS overrides). The static run reports every static check, the -IncludeShared stand-ins and the
 * -Fast roster; its kernel.selftest row becomes the pooled sections' verdict and each roster row the suite's own
 * -Only verdict. The pool's suite list is read where gate.fast-roster-matches-suites reads it and must equal the roster
 * the static run reports, and that check (in the static run) proves the roster equals every else-arm registration.
 */
async function pushChecks(root: string, say: (outcome: Outcome) => void, note: (line: string) => void): Promise<void> {
  const options = parseOptions([]);
  const selftest = path.join(root, 'kernel', 'test', 'selftest.ts');
  const sections = sectionNumbers(fs.readFileSync(selftest, 'utf8'), '');
  const suites = fastRoster(fs.readFileSync(path.join(root, 'tools', 'Invoke-LibraryChecks.ps1'), 'utf8'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-push-'));
  fs.mkdirSync(path.join(folder, 'sections'));
  note(`     push tier: ${suites.length} suites, ${sections.length} self-test sections and the static run in ${options.workers} slots; exclusive after the barrier: sections ${SERIAL_SECTIONS.join(', ')}${EXCLUSIVE_SUITES.length ? `, ${EXCLUSIVE_SUITES.join(', ')}` : ''}. Log: ${folder}`);

  type Done = { kind: 'suite'; outcome: Outcome } | { kind: 'section'; result: Result } | { kind: 'static'; outcome: Outcome; rows: RunnerRow[] | null };
  const staticRun = async (signal: AbortSignal): Promise<Done> => {
    const where = path.join(folder, 'static');
    const temp = path.join(where, 'temp');
    fs.mkdirSync(temp, { recursive: true });
    const ran = await runBounded({
      label: 'Invoke-LibraryChecks.ps1 -Fast (static run)', command: 'powershell.exe', cwd: root, limit: STATIC_LIMIT, folder: where,
      env: { ...childEnv(), TEMP: temp, TMP: temp, LIBRARY_SELFTEST_SECTIONS: STATIC_RUN_SECTION },
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'Invoke-LibraryChecks.ps1'), '-Fast', '-Json'],
    }, signal);
    const rows = ran.problem ? null : runnerReport(ran.output)?.checks ?? null;
    const detail = ran.problem || (rows === null ? `no -Json report (exit ${ran.status}): ${lastLines(ran.output, 3)}` : `${rows.length} rows (exit ${ran.status})`);
    return { kind: 'static', rows, outcome: { check: 'Invoke-LibraryChecks.ps1 -Fast (static run)', tier: 'push', status: rows === null ? 'fail' : 'pass', seconds: ran.seconds, detail, caught: 'none found (new in S119)' } };
  };
  const items: PoolItem<Done>[] = [
    ...suites.filter((name) => name in SLOW_SUITES).map((name) => ({ name, exclusive: EXCLUSIVE_SUITES.includes(name), run: async (signal: AbortSignal): Promise<Done> => ({ kind: 'suite', outcome: await suiteChild(root, name, path.join(folder, name), signal) }) })),
    { name: 'static', exclusive: false, run: staticRun },
    ...suites.filter((name) => !(name in SLOW_SUITES)).map((name) => ({ name, exclusive: EXCLUSIVE_SUITES.includes(name), run: async (signal: AbortSignal): Promise<Done> => ({ kind: 'suite', outcome: await suiteChild(root, name, path.join(folder, name), signal) }) })),
    ...sections.map((section) => ({ name: `section ${section}`, exclusive: SERIAL_SECTIONS.includes(section), run: async (signal: AbortSignal): Promise<Done> => ({ kind: 'section', result: await runSection(options, section, path.join(folder, 'sections'), signal) }) })),
  ];

  const controller = new AbortController();
  const cancel = () => { interrupted = true; controller.abort(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let done: Done[];
  try { done = await runPool(items, options.workers, controller.signal); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }

  const results = done.flatMap((item) => (item.kind === 'section' ? [item.result] : [])).sort((a, b) => Number(a.section) - Number(b.section));
  const total = results.reduce((sum, result) => sum + result.checks, 0);
  const failedSections = results.filter((result) => result.verdict === 'FAIL');
  const flatten = (value: string) => value.replace(/[\r\n]+/g, ' | ');
  fs.writeFileSync(path.join(folder, 'sections.log'), results.map((r) => `section ${r.section}: ${r.verdict} ${r.checks} checks ${r.seconds.toFixed(3)}s${r.detail ? ` ${flatten(r.detail)}` : ''}`).join('\n') + '\n');
  const missingSections = sections.filter((section) => !results.some((result) => result.section === section));
  const selftestOutcome: Outcome = failedSections.length || missingSections.length || controller.signal.aborted
    ? { check: 'kernel.selftest', tier: 'push', status: 'fail', seconds: null, caught: RUNNER_CAUGHT, detail: `kernel self-test FAILED (${failedSections.length || 1} of ${total}): ${[...failedSections.map((r) => `section ${r.section}: ${flatten(r.detail)}`), ...missingSections.map((n) => `section ${n}: not run`)].join('; ').slice(0, 1200) || 'cancelled'}` }
    : { check: 'kernel.selftest', tier: 'push', status: 'pass', seconds: null, caught: RUNNER_CAUGHT, detail: `kernel self-test passed (${total} checks). ${results.length} sections pooled` };

  const suiteOutcomes = new Map(done.flatMap((item) => (item.kind === 'suite' ? [[item.outcome.check, item.outcome] as const] : [])));
  const staticDone = done.find((item) => item.kind === 'static') as Extract<Done, { kind: 'static' }> | undefined;
  note(`     ${staticDone?.outcome.check ?? 'static run'}: ${staticDone ? `${staticDone.outcome.detail}, ${staticDone.outcome.seconds?.toFixed(1)}s` : 'did not run'}`);
  // The static run and the roster agreement are the gate's own machinery, not checks of the full gate's set: either
  // going wrong is the gate failing (exit 2) after every row it has is shown, never an extra row in the comparison.
  if (!staticDone || staticDone.rows === null) {
    say(selftestOutcome);
    for (const name of suites) say(suiteOutcomes.get(name) ?? { check: name, tier: 'push', status: 'fail', seconds: null, caught: RUNNER_CAUGHT, detail: 'not run' });
    throw new GateError(`the static run gave no report: ${staticDone?.outcome.detail ?? 'did not run'}; its log is under ${folder}`);
  }
  const reported = staticDone.rows.filter((row) => row.status === 'skipped' && row.detail === 'suite skipped in -Fast mode').map((row) => row.check);
  for (const row of staticDone.rows) {
    if (row.check === 'kernel.selftest') { say(selftestOutcome); continue; }
    const suite = reported.includes(row.check) ? suiteOutcomes.get(row.check) : undefined;
    if (suite) { say(suite); continue; }
    say({ check: row.check, tier: 'push', status: STATUS_OF[row.status] ?? 'fail', seconds: null, caught: RUNNER_CAUGHT, detail: row.detail });
  }
  if (!staticDone.rows.some((row) => row.check === 'kernel.selftest')) say(selftestOutcome);
  const problems = rosterProblems(suites, reported);
  if (problems.length) throw new GateError(`the pool's suites differ from the -Fast roster: ${problems.join('; ')}`);
  note(`     the pool ran the ${suites.length} suites the -Fast roster reports`);
  const bad = failedSections.length > 0 || [...suiteOutcomes.values()].some((outcome) => outcome.status === 'fail');
  if (!bad) for (const entry of fs.readdirSync(folder)) if (!entry.endsWith('.log')) fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
}

function releaseOnly(): Outcome[] {
  const later = (check: string, where: string): Outcome => ({ check, tier: 'release', status: 'skip', seconds: null, caught: 'see docs/releasing.md', detail: `not in gate.ts yet: ${where}` });
  return [
    later('matrix (compiled arm)', 'tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel <the release library.exe>, until tools/matrix.ts (session 4)'),
    later('built-release tests', 'tools/Test-BuiltRelease.ps1 -PreviousRelease <the previous rel>, until tools/test-built-release.ts (session 5)'),
    later('compiled self-test sections', "LIBRARY_SELFTEST_KERNEL=<the release library.exe>: 116, 117, 130-133, and 143, 144, 146, 147 on an unbumped build (docs/releasing.md)"),
    later('reader adapter checks', 'reader.launch-validation, .dispatch-selftest, .shelf-selftest, .project-pin-selftest, .shared-selftest: in the runner child today; the release tier beside the adapter exception (docs/powershell-inventory.md)'),
  ];
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

async function runTier(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const root = path.resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const started = Date.now();
  const outcomes: Outcome[] = [];
  const say = (outcome: Outcome) => {
    outcomes.push(outcome);
    if (!options.json) {
      const time = outcome.seconds === null ? '   -  ' : `${outcome.seconds.toFixed(1).padStart(5)}s`;
      process.stdout.write(`${outcome.status.toUpperCase().padEnd(4)} ${time} ${outcome.check}${outcome.diagnostic ? ' (diagnostic)' : ''}${outcome.detail ? `: ${outcome.detail}` : ''}\n`);
    }
  };

  const pooled = options.tier === 'push' || options.tier === 'release';
  // Section 155 is the push tier's type check; its claim-map coverage and docs gate are reported, not acceptance.
  if (!pooled) for (const outcome of await typecheck(root, 'commit')) say(outcome);
  say({ ...coverage(root, 'commit'), diagnostic: pooled });
  say({ ...(await docsGate(root, 'commit')), diagnostic: pooled });
  const chosen = selection(root, options.commit);
  if (!options.json) {
    const what = chosen.selection.all ? 'every section' : chosen.selection.sections.length ? `sections ${chosen.selection.sections.join(', ')}` : 'no section';
    process.stdout.write(`     self-test selection: ${what}${options.tier === 'commit' ? '' : pooled ? ' (this tier runs every section in its pool instead)' : ' (this tier runs every section in the runner child instead)'}\n`);
    for (const reason of chosen.selection.reasons) process.stdout.write(`       ${reason}\n`);
  }
  if (options.tier === 'commit') say(await selftestSections(root, 'commit', chosen.selection));
  else if (pooled) {
    await pushChecks(root, say, (line) => (options.json ? process.stderr : process.stdout).write(line + '\n'));
    if (options.tier === 'release') releaseOnly().forEach(say);
  } else {
    if (!options.json) process.stdout.write(`     ${options.tier} tier: running tools/Invoke-LibraryChecks.ps1${options.tier === 'cut' ? ' -Fast' : ''} as a child for everything not yet ported${options.tier === 'cut' ? '; its kernel.selftest runs every section' : ''}\n`);
    for (const outcome of await runner(root, options.tier, options.tier === 'cut')) say(outcome);
    if (options.tier === 'release') releaseOnly().forEach(say);
  }

  const total = (Date.now() - started) / 1000;
  const budget = BUDGETS[options.tier];
  const failed = outcomes.filter((outcome) => outcome.status === 'fail' && !outcome.diagnostic).length;
  const overBudget = budget !== null && total > budget;
  const exit = failed ? EXIT_FAIL : EXIT_PASS;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schema: 1, tier: options.tier, commit: options.commit, budget_seconds: budget, total_seconds: Math.round(total * 10) / 10, over_budget: overBudget, exit, selection: { ...chosen.selection, changed: chosen.changed }, checks: outcomes })}\n`);
  } else {
    const count = (status: Status) => outcomes.filter((outcome) => outcome.status === status && !outcome.diagnostic).length;
    const diagnostics = outcomes.filter((outcome) => outcome.diagnostic);
    const aside = diagnostics.length ? ` Diagnostics, not acceptance: ${diagnostics.map((outcome) => `${outcome.check} ${outcome.status}`).join(', ')}.` : '';
    process.stdout.write(`${options.tier} tier: ${clock(total)}${budget === null ? ' (measured; no budget yet)' : ` of ${clock(budget)}`}. ${count('pass')} passed, ${count('warn')} warned, ${failed} failed, ${count('skip')} skipped.${aside}\n`);
    if (overBudget) process.stdout.write(`WARN: the ${options.tier} tier took ${clock(total)}, over its ${clock(budget!)} budget. Over budget is a warning, never a failure.\n`);
  }
  return exit;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const say = (line: string) => (options.json ? process.stderr : process.stdout).write(line + '\n');
  const lock = options.tier === 'commit' ? null : await acquireGateLock(options.tier, options.noWait, say);
  try { return await runTier(argv); } finally { await lock?.release(); }
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof LockError ? error.code : EXIT_GATE);
  },
);
