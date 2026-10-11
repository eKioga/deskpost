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
 *   exit 3  reserved for waiting refused under --no-wait. There is no gate lock yet: it comes in a later session
 *           (the plan's Session 1 item 4), so --no-wait is accepted and does nothing.
 *
 * NOTHING CALLS THIS BUT A PERSON in S113: no hook and no runner. It ports no check (session 2 does). What each tier
 * runs today:
 *   commit   the kernel type check (tsc --noEmit); the claim map's coverage (rule a); the docs gate as it is
 *            (`node tools/docs-gate.ts`, which judges a docs-only commit and says "not docs-only" for any other);
 *            the kernel self-test sections the changed files select (tools/section-select.mts, rules b-d).
 *   cut      the commit tier's checks, but every self-test section runs inside `Invoke-LibraryChecks.ps1 -Fast`, run
 *            as a child for everything not yet ported.
 *   push     the commit tier's checks, then the full `Invoke-LibraryChecks.ps1` as a child.
 *   release  the push tier, and the release checks gate.ts does not run yet, each named with where it runs today.
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
import path from 'node:path';
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
}

class GateError extends Error {}

const USAGE = 'Usage: node tools/gate.ts --tier commit|cut|push|release [--json] [--no-wait] [--commit <sha>]';

function parseArgs(argv: string[]): { tier: Tier; json: boolean; commit: string | null } {
  let tier: Tier | null = null;
  let json = false;
  let commit: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--tier' && i + 1 < argv.length) {
      const value = argv[++i]!;
      if (!(TIERS as readonly string[]).includes(value)) throw new GateError(`--tier is one of ${TIERS.join(', ')}; got '${value}'. ${USAGE}`);
      tier = value as Tier;
    } else if (arg === '--json') json = true;
    else if (arg === '--no-wait') {
      // Accepted and inert: the gate lock (and exit 3) come in a later session.
    } else if (arg === '--commit' && i + 1 < argv.length) commit = argv[++i]!;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\nThe lock that --no-wait refuses to wait for comes in a later session; today --no-wait does nothing.\n`);
      process.exit(EXIT_PASS);
    } else throw new GateError(`unknown argument '${arg}'. ${USAGE}`);
  }
  if (tier === null) throw new GateError(`name a tier. ${USAGE}`);
  return { tier, json, commit };
}

/** The hook's environment for every child (see the header). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', ORCA_TERMINAL_HANDLE: '' };
  delete env['DESKPOST_UPDATE_CHECK'];
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = process.platform === 'win32' ? ';' : ':';
  env[key] = (env[key] ?? '')
    .split(separator)
    .filter((entry) => entry && !fs.existsSync(path.join(entry, 'deskpost.cmd')) && !fs.existsSync(path.join(entry, 'deskpost')))
    .join(separator);
  return env;
}

function git(root: string, args: string[]): string {
  const ran = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (ran.status !== 0) throw new GateError(`git ${args.join(' ')} failed: ${`${ran.stderr ?? ''}`.trim()}`);
  return ran.stdout ?? '';
}

/** Run a child to its end, keeping its output; awaited, so a later lock can keep answering while it runs. */
function runChild(command: string, args: string[], root: string, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; output: string; seconds: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: { ...childEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', (error) => resolve({ status: null, output: `${output}${error.message}`, seconds: (Date.now() - started) / 1000 }));
    child.on('close', (status) => resolve({ status, output, seconds: (Date.now() - started) / 1000 }));
  });
}

const lastLines = (text: string, count: number) => text.trim().split(/\r?\n/).slice(-count).join(' | ');

async function typecheck(root: string, tier: Tier): Promise<Outcome> {
  const kernel = path.join(root, 'kernel');
  const tsc = path.join(kernel, 'node_modules', 'typescript', 'bin', 'tsc');
  const base = { check: 'kernel.typecheck', tier, caught: "the kernel's type errors, as self-test section 155 catches them" };
  if (!fs.existsSync(tsc)) throw new GateError(`TypeScript is not installed at ${path.dirname(path.dirname(tsc))}; run npm ci --offline in kernel/`);
  const ran = await runChild(process.execPath, [tsc, '-p', path.join(kernel, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], kernel);
  const errors = ran.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
  if (ran.status === 0 && errors.length === 0) return { ...base, status: 'pass', seconds: ran.seconds, detail: 'tsc --noEmit found no type error' };
  return { ...base, status: 'fail', seconds: ran.seconds, detail: `tsc found ${errors.length} type error(s) (exit ${ran.status}): ${errors.slice(0, 4).join(' | ')}` };
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
  const ran = await runChild(process.execPath, [path.join(root, 'tools', 'docs-gate.ts')], root);
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
  const ran = await runChild(process.execPath, [path.join(root, 'kernel', 'test', 'selftest.ts')], root, env);
  const what = chosen.all ? 'every section' : `sections ${chosen.sections.join(', ')}`;
  if (ran.status === 0) return { check, tier, status: 'pass', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 1)}` };
  return { check, tier, status: 'fail', seconds: ran.seconds, caught, detail: `${what}: ${lastLines(ran.output, 3).slice(0, 1200)}` };
}

/** Invoke-LibraryChecks.ps1 as a child; each of its check lines becomes an outcome with no time of its own. */
async function runner(root: string, tier: Tier, fast: boolean): Promise<Outcome[]> {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'Invoke-LibraryChecks.ps1'), ...(fast ? ['-Fast'] : [])];
  const ran = await runChild('powershell.exe', args, root);
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

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const root = path.resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const started = Date.now();
  const outcomes: Outcome[] = [];
  const say = (outcome: Outcome) => {
    outcomes.push(outcome);
    if (!options.json) {
      const time = outcome.seconds === null ? '   -  ' : `${outcome.seconds.toFixed(1).padStart(5)}s`;
      process.stdout.write(`${outcome.status.toUpperCase().padEnd(4)} ${time} ${outcome.check}${outcome.detail ? `: ${outcome.detail}` : ''}\n`);
    }
  };

  say(await typecheck(root, 'commit'));
  say(coverage(root, 'commit'));
  say(await docsGate(root, 'commit'));
  const chosen = selection(root, options.commit);
  if (!options.json) {
    const what = chosen.selection.all ? 'every section' : chosen.selection.sections.length ? `sections ${chosen.selection.sections.join(', ')}` : 'no section';
    process.stdout.write(`     self-test selection: ${what}${options.tier === 'commit' ? '' : ' (this tier runs every section in the runner child instead)'}\n`);
    for (const reason of chosen.selection.reasons) process.stdout.write(`       ${reason}\n`);
  }
  if (options.tier === 'commit') say(await selftestSections(root, 'commit', chosen.selection));
  else {
    if (!options.json) process.stdout.write(`     ${options.tier} tier: running tools/Invoke-LibraryChecks.ps1${options.tier === 'cut' ? ' -Fast' : ''} as a child for everything not yet ported${options.tier === 'cut' ? '; its kernel.selftest runs every section' : ''}\n`);
    for (const outcome of await runner(root, options.tier, options.tier === 'cut')) say(outcome);
    if (options.tier === 'release') releaseOnly().forEach(say);
  }

  const total = (Date.now() - started) / 1000;
  const budget = BUDGETS[options.tier];
  const failed = outcomes.filter((outcome) => outcome.status === 'fail').length;
  const overBudget = budget !== null && total > budget;
  const exit = failed ? EXIT_FAIL : EXIT_PASS;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schema: 1, tier: options.tier, commit: options.commit, budget_seconds: budget, total_seconds: Math.round(total * 10) / 10, over_budget: overBudget, exit, selection: { ...chosen.selection, changed: chosen.changed }, checks: outcomes })}\n`);
  } else {
    const count = (status: Status) => outcomes.filter((outcome) => outcome.status === status).length;
    process.stdout.write(`${options.tier} tier: ${clock(total)}${budget === null ? ' (measured; no budget yet)' : ` of ${clock(budget)}`}. ${count('pass')} passed, ${count('warn')} warned, ${failed} failed, ${count('skip')} skipped.\n`);
    if (overBudget) process.stdout.write(`WARN: the ${options.tier} tier took ${clock(total)}, over its ${clock(budget!)} budget. Over budget is a warning, never a failure.\n`);
  }
  return exit;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_GATE);
  },
);
