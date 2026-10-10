/**
 * `library install` (PLAN-install-without-powershell.md D1, D2, D5, D8; ADR-0066): install, upgrade, repair, finish or
 * undo an interrupted transaction, with no PowerShell running.
 *
 * TWO STAGES IN ONE VERB (D2). Run as the reader runs it, it is the BOOTSTRAP (bootstrap.ts): it reads the release,
 * checks it and runs the extracted release's own binary with `--extracted <folder> --archive-sha256 <hex>`. Run with
 * those, it is THE INSTALLER: install.ps1's transaction, step for step, on the same receipt, lock, pending marks and
 * phase names (`staging`, `staged`, `planned`, `placed-version`, `activated`, `shims`, `placed`), and the pending
 * record's whole shape, so a transaction begun by a 1.3.4 install.ps1 is finished or undone here and the reverse.
 *
 *   1. Recovery first: an interrupted transaction is finished, undone or started over, never on a dry run.
 *   2. Ask: `setup --ask`'s conversation, in this process.
 *   3. Stage on the destination: the pending transaction recorded FIRST, then the tree copied to
 *      versions\.incoming-<txn> and re-hashed, or a version already there from the same archive reused.
 *   4. Plan from the staged tree, kept in <root>\.pending until the transaction completes or is undone.
 *   5. Place: versions\<v>, `current` switched in four named substeps, current.json, the two shims, the PATH entry.
 *   6. Apply: `current\bin\library.exe setup --apply`, then the transaction moves into `owned` and `.pending` goes,
 *      both inside the lock.
 *   7. The closing doctor or refresh, the owner relinquished on any failure, and the welcome fork.
 *
 * AFTER PLACE, `current\bin\library.exe` RUNS (D2): `setup --apply`, `setup --refresh-served`, the closing doctor and
 * the welcome fork read the program root, and this process's is the temp tree.
 *
 * NOTHING HERE PROMPTS WHERE NOBODY CAN ANSWER (D8): `--yes`, `--json`, `DESKPOST_YES=1`, `CI` or input that is not a
 * terminal mean no prompts, and a recovery or a live session then refuses, naming the flag that decides it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { writeAtomicText } from './fsx.ts';
import { programRoot, releaseTuple } from './programroot.ts';
import { askAtTerminal } from './prompt.ts';
import { COMMAND_NAME, resolveOnPath } from './machine.ts';
import { liveSessions, ownerAlive, readReceipt, receiptPath, selfOwner, SHIM_FILES, sessionsText, waitForSessionsToClose, withLifecycleLock, writeReceipt } from './lifecycle.ts';
import { addUserPath, handOffLeftovers, lastPathBroadcast, LEFTOVER, pruneVersions, removeTreeMovingRunning, removeUninstallList, removeUserPath, sweepLeftovers, userPathKey } from './finisher.ts';
import { nativeUserPathRead } from './win32proc.ts';
import { doctorText } from './human.ts';
import { PROGRAM_WIDE_CHECKS } from './doctor.ts';
import {
  defaultInstallRoot,
  flagFor as flagIn,
  spellingOfRoute,
  planId,
  planText,
  planView,
  refreshServedText,
  setupAsk,
  setupPlan,
  SETUP_QUIT,
  type SetupAnswers,
  type SetupPlan,
  type Spelling,
} from './setup.ts';
import { DEFAULT_RELEASE, WINDOWS_PLATFORMS, defaultPlatform, newTempFolder, runBootstrap, sha256File, assertTuple, treeExecutable } from './bootstrap.ts';

/** What `library install` was asked, with install.ps1's defaults and environment fallbacks (`:123-126`). */
export interface InstallArgs {
  release: string;
  installRoot: string;
  /** undefined when not given; `none` for the program only. */
  library: string | undefined;
  platform: string;
  yes: boolean;
  dryRun: boolean;
  planId: string;
  json: boolean;
  allowOverlap: boolean;
  repair: boolean;
  keepLibraries: boolean;
  noPathChange: boolean;
  /** `--path-change` (D5): the PATH entry is added even where the install's receipt says it was declined. */
  pathChange: boolean;
  /** `--wait <seconds>` (D3): a run with nobody to ask looks again for open sessions up to this long. */
  waitSeconds: number | null;
  plugin: boolean;
  skipPlugin: boolean;
  resume: '' | 'finish' | 'undo';
  librarian: '' | 'claude' | 'codex';
  scriptSha: string;
  scriptPath: string;
  runAsFile: boolean;
  refusalFile: string;
  /** install.ps1 runs this: advice names its `-Resume` spelling, and it patches its caller's PATH after (D4). */
  forwarded: boolean;
  extracted: string;
  archiveSha256: string;
  /** The bootstrap's own program folder, which it passes with --extracted (D3, kickoffs/s91 ruling 2). */
  bootstrapFolder: string;
}

export function parseInstallArgs(argv: string[]): InstallArgs {
  const parsed = parseArguments(argv, argumentTable('install'));
  const unknown = [...parsed.flags].filter((name) => !(argumentTable('install').boolean ?? []).includes(name));
  if (unknown.length) throw new Error(`library install has no ${unknown.map((name) => `--${name}`).join(', ')}. Nothing was changed. Run \`library install --help\` for what it takes.`);
  if (parsed.positional.length) throw new Error(`library install takes no ${parsed.positional.length === 1 ? 'word' : 'words'} '${parsed.positional.join(' ')}'; name a release with --release. Nothing was changed.`);
  const resume = (parsed.options.get('resume') ?? '').trim().toLowerCase();
  if (!['', 'finish', 'undo'].includes(resume)) throw new Error(`--resume is finish or undo, not '${resume}'. Nothing was changed.`);
  const librarian = (parsed.options.get('librarian') ?? '').trim().toLowerCase();
  if (!['', 'claude', 'codex'].includes(librarian)) throw new Error(`--librarian is claude or codex, not '${librarian}'. Nothing was changed.`);
  const planIdGiven = (parsed.options.get('plan-id') ?? '').trim().toLowerCase();
  const waitWord = parsed.options.get('wait');
  if (waitWord !== undefined && !/^[1-9][0-9]{0,5}$/.test(waitWord.trim())) throw new Error(`--wait takes a number of seconds, not '${waitWord}'. Nothing was changed.`);
  const env = process.env;
  return {
    release: parsed.options.get('release') ?? DEFAULT_RELEASE,
    installRoot: parsed.options.get('install-root') ?? ((env['DESKPOST_INSTALL_ROOT'] ?? '').trim() || defaultInstallRoot()),
    library: parsed.options.has('library') ? parsed.options.get('library') : (env['DESKPOST_LIBRARY'] ?? '').trim() ? env['DESKPOST_LIBRARY'] : undefined,
    platform: parsed.options.get('platform') ?? defaultPlatform(),
    yes: parsed.flags.has('yes') || env['DESKPOST_YES'] === '1' || planIdGiven !== '',
    dryRun: parsed.flags.has('dry-run'),
    planId: planIdGiven,
    json: parsed.flags.has('json'),
    allowOverlap: parsed.flags.has('allow-overlap'),
    repair: parsed.flags.has('repair'),
    keepLibraries: parsed.flags.has('keep-libraries'),
    noPathChange: parsed.flags.has('no-path-change'),
    pathChange: parsed.flags.has('path-change'),
    waitSeconds: waitWord === undefined ? null : Number(waitWord.trim()),
    plugin: parsed.flags.has('plugin'),
    skipPlugin: parsed.flags.has('skip-plugin'),
    resume: resume as InstallArgs['resume'],
    librarian: librarian as InstallArgs['librarian'],
    scriptSha: (parsed.options.get('script-sha') ?? '').trim().toLowerCase(),
    scriptPath: parsed.options.get('script-path') ?? '',
    runAsFile: parsed.flags.has('run-as-file'),
    refusalFile: parsed.options.get('refusal-file') ?? '',
    forwarded: parsed.flags.has('forwarded'),
    extracted: parsed.options.get('extracted') ?? '',
    archiveSha256: (parsed.options.get('archive-sha256') ?? '').trim().toLowerCase(),
    bootstrapFolder: parsed.options.get('bootstrap-folder') ?? '',
  };
}

/**
 * THE PATH ANSWER AN INSTALL ASKS WITH (PLAN-one-step-upgrade.md D5): `--no-path-change` wins, `--path-change` turns it
 * on, and with neither an upgrade keeps the install's own answer from its receipt.
 */
export function pathAnswerOf(args: Pick<InstallArgs, 'noPathChange' | 'pathChange'>): boolean | 'receipt' {
  return args.noPathChange ? false : args.pathChange ? true : 'receipt';
}

/** The route that asked (PLAN-one-step-upgrade.md D6): install.ps1's when it forwarded the run, the kernel's otherwise. */
function spellingOf(args: InstallArgs): Spelling {
  return spellingOfRoute(args.forwarded);
}

/** A flag as the caller types it: install.ps1's `-Resume` when it forwarded the run, `--resume` otherwise. */
function flagFor(args: InstallArgs, name: string): string {
  return flagIn(spellingOf(args), name);
}

export interface InstallResult {
  refusal: string | null;
  exitCode: number;
}

/** `library install`: the bootstrap, or with `--extracted` the installer. A refusal is also written to `--refusal-file`. */
export async function installVerb(argv: string[]): Promise<InstallResult> {
  let refusalFile = '';
  try {
    const args = parseInstallArgs(argv);
    refusalFile = args.refusalFile;
    // AN INSTALL ASKED FOR AS JSON MUST NAME THE PLAN IT WAS SHOWN (install.ps1:129-131), before any download.
    if (args.json && !args.dryRun && !args.planId) {
      throw new Error(`An install asked for as JSON must name the plan it was shown: run with ${flagFor(args, 'dry-run')} ${flagFor(args, 'json')} first, then again with ${flagFor(args, 'plan-id')} <plan_id>. Nothing was changed.`);
    }
    if (process.platform !== 'win32') throw new Error('library install installs a Windows release; on macOS and Linux, install.sh installs. Nothing was changed.');
    if (!WINDOWS_PLATFORMS.includes(args.platform)) throw new Error(`library install installs a Windows release; '${args.platform}' is not one. Use install.sh on macOS and Linux.`);
    const say = sayer(args.json);
    if (!args.extracted) {
      return { refusal: null, exitCode: await runBootstrap(argv, { release: args.release, platform: args.platform, json: args.json, say: (text) => say(`  ${text}`) }) };
    }
    return { refusal: null, exitCode: await installExtracted(args, say) };
  } catch (error) {
    const message = (error as Error).message;
    if (refusalFile) {
      try {
        fs.writeFileSync(refusalFile, message);
      } catch {
        // The refusal still goes to stderr.
      }
    }
    return { refusal: message, exitCode: 1 };
  }
}

// --- the terminal -----------------------------------------------------------------------------------------------

function sayer(json: boolean): (text: string) => void {
  const out = json ? process.stderr : process.stdout;
  return (text) => out.write(text.endsWith('\n') ? text : text + '\n');
}

/** One JSON result on stdout, ASCII on the wire as every kernel result is (cli.ts `asciiJson`). */
function emitJson(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value).replace(/[^\x00-\x7f]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
}

function isInteractive(args: InstallArgs): boolean {
  return !(args.yes || args.json || (process.env['CI'] ?? '') !== '' || process.stdin.isTTY !== true);
}

/** A question answered only by what is typed after it (prompt.ts); Ctrl+C or a closed input is `q`, the safe key. */
function prompt(question: string): Promise<string> {
  return askAtTerminal(question).then((answer) => answer.trim().toLowerCase()).catch(() => 'q');
}

/** A run the reader watches: the console is the child's. With --json its output is collected and said on stderr. */
function runShown(json: boolean, exe: string, args: string[]): number {
  if (json) {
    const ran = runCaptured(exe, args);
    if (ran.stdout.trim()) process.stderr.write(ran.stdout.trimEnd() + '\n');
    if (ran.stderr.trim()) process.stderr.write(ran.stderr.trimEnd() + '\n');
    return ran.exit;
  }
  const ran = spawnSync(exe, args, { stdio: 'inherit' });
  if (ran.error) throw new Error(`${exe} could not be started: ${ran.error.message}`);
  return ran.status ?? 1;
}

function runCaptured(exe: string, args: string[]): { exit: number; stdout: string; stderr: string } {
  const ran = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (ran.error) throw new Error(`${exe} could not be started: ${ran.error.message}`);
  return { exit: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

// --- times, as PowerShell spells them -------------------------------------------------------------------------------

/** `(Get-Date).ToString('o')`: local time, seven fractional digits, and the offset. */
function localRoundTripNow(): string {
  const now = new Date();
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  const local =
    `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}T` +
    `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.${pad(now.getMilliseconds(), 3)}0000`;
  const offset = -now.getTimezoneOffset();
  const absolute = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

/** `(Get-Date).ToUniversalTime().ToString('o')`. */
function utcRoundTripNow(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

// --- links, as install.ps1 keeps them --------------------------------------------------------------------------------

function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function sameText(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

function full(file: string): string {
  return path.resolve(file).replace(/[\\/]+$/, '');
}

/**
 * THE BOOTSTRAP'S FOLDER, WHEN IT IS OUTSIDE THE INSTALL ROOT (D3, kickoffs/s91 ruling 2): the Command Prompt line
 * extracts a bootstrap into `%TEMP%\deskpost-setup` and leaves it, so the closing text names it as safe to delete. A
 * bootstrap run from the install itself (`current\bin`) is the install, and is never named.
 */
function setupFolderOf(args: InstallArgs, root: string): string | null {
  if (!args.bootstrapFolder) return null;
  const folder = full(args.bootstrapFolder);
  const relative = path.relative(full(root), folder);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? null : folder;
}

/** A link's target, or null for no link. A REAL directory at the path refuses: it is never the installer's to replace. */
function linkTarget(file: string): string | null {
  if (!present(file)) return null;
  if (!isLink(file)) throw new Error(`${file} is a real directory, not the link the installer keeps there; nothing was changed. Move it aside and re-run.`);
  return full(fs.readlinkSync(file).replace(/^\\\\\?\\/, ''));
}

/** A link removed as a link, never walked into, dangling or not (install.ps1's `Remove-Link`). */
function removeLink(file: string): void {
  if (!present(file)) return;
  if (!isLink(file)) throw new Error(`${file} is a real directory, not a link the installer keeps; nothing was changed. Move it aside and re-run.`);
  fs.rmdirSync(file);
}

/**
 * `current` onto `target` in FOUR RECOGNISABLE SUBSTEPS (install.ps1's `Set-CurrentLink`, round 4 #3): a new link,
 * the old renamed aside, the new renamed in, the old removed. Each is judged by which names exist, so a re-run after an
 * interruption goes on from where it stopped and never refuses a state its own substeps produce.
 */
export function setCurrentLink(root: string, targetGiven: string, tag: string): void {
  const current = path.join(root, 'current');
  const fresh = `${current}.new-${tag}`;
  const old = `${current}.old-${tag}`;
  const target = full(targetGiven);
  const there = present(current);
  if (there && !isLink(current)) throw new Error(`${current} is a real directory, not the link the installer keeps there; nothing was changed. Move it aside and re-run.`);
  const now = there && fs.existsSync(current) ? linkTarget(current) : null;
  if (sameText(now, target)) {
    removeLink(fresh);
    removeLink(old);
    return;
  }
  if (!present(fresh)) fs.symlinkSync(target, fresh, 'junction');
  else if (!fs.existsSync(fresh) || !sameText(linkTarget(fresh), target)) throw new Error(`${fresh} does not point at ${target}; it is not this transaction's. Move it aside and re-run.`);
  // A PRESENT current IS MOVED ASIDE EVEN WHEN ITS TARGET IS GONE: a dangling link still holds the name.
  if (there) fs.renameSync(current, old);
  fs.renameSync(fresh, current);
  removeLink(old);
}

// --- the transaction's records ----------------------------------------------------------------------------------------

type Pending = Record<string, unknown>;

interface RunState {
  args: InstallArgs;
  say: (text: string) => void;
  txn: string | null;
  root: string | null;
  ownsPending: boolean;
  /** Whether this run's Place added the PATH entry (kickoffs/s90 row 5: the install's JSON says so, with the broadcast). */
  pathAdded?: boolean;
  /** The old versions a committed upgrade pruned, and the ones it could not (D7). */
  pruned?: { removed: string[]; warned: string[] };
}

function step(state: RunState, text: string): void {
  state.say(`  ${text}`);
}

/** A mark on this run's pending transaction, under the lock; then the fault the interruption fixtures inject (step 10). */
function setPendingMark(state: RunState, root: string, phase: string, fields: Record<string, unknown> = {}): void {
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    if (receipt.pending === null || receipt.pending['id'] !== state.txn) throw new Error(`the pending transaction at ${root} is no longer this one (${state.txn}); stopping.`);
    receipt.pending['phase'] = phase;
    Object.assign(receipt.pending, fields);
    writeReceipt(root, receipt);
  });
  faultAfter(phase);
}

/** DESKPOST_INSTALL_FAULT_AFTER: a stop right after a named mark, as a crash would leave it. */
function faultAfter(phase: string): void {
  const fault = process.env['DESKPOST_INSTALL_FAULT_AFTER'] ?? '';
  if (fault && fault === phase) throw new Error(`fault injected after '${phase}' (DESKPOST_INSTALL_FAULT_AFTER)`);
}

/** Pending cleared, and `.pending` removed INSIDE THE SAME LOCK (D5): a run that claims the root in a gap loses nothing. */
function clearPendingAndFolder(root: string): void {
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    receipt.pending = null;
    writeReceipt(root, receipt);
    fs.rmSync(path.join(root, '.pending'), { recursive: true, force: true });
  });
}

function writeCurrentRecord(root: string, version: string, previous: string | null, archiveSha256: string): void {
  const record = { schema: 1, version, previous, archive_sha256: archiveSha256, switched: localRoundTripNow() };
  writeAtomicText(path.join(root, 'current.json'), psConvertToJson(record as PsJsonValue) + '\n');
}

/**
 * `deskpost` IS THE COMMAND, `library` ITS ALIAS THROUGH 1.x (ADR-0055): one binary, a `.cmd` shim for cmd.exe and
 * PowerShell and an `sh` one for Git Bash (kickoffs/s94 row 1), each rewritten only when its text differs.
 */
function setShims(root: string): void {
  for (const shim of SHIM_FILES) {
    const file = path.join(root, 'bin', shim.name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === shim.text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomicText(file, shim.text);
  }
}

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** This process's PATH, as the caller handed it, before Place adds to it: what the Command row is judged against. */
const CALLER_PATH = process.env[Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';

/**
 * THIS PROCESS'S CHILDREN SEE THE ENTRY (install.ps1's "this window too", `:381`): the closing doctor, the refresh and the
 * welcome fork run with `<root>\bin` on PATH, as they did under the script. The caller's own window cannot be changed
 * (D4); install.ps1 adds it there after this exits, and a new terminal reads it from the registry.
 */
function addToOwnPath(bin: string): void {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const now = process.env[key] ?? '';
  if (!now.split(';').some((entry) => entry.replace(/\\+$/, '').toLowerCase() === bin.toLowerCase())) process.env[key] = now.replace(/;+$/, '') + ';' + bin;
}

// --- Place, Apply, Undo -----------------------------------------------------------------------------------------------

/** Pass 5, every step idempotent: a re-run after an interruption goes on from where it stopped (`:462-491`). */
function place(state: RunState, root: string, pending: Pending): void {
  const versions = path.join(root, 'versions');
  const version = text(pending['version']);
  const target = path.join(versions, version);
  const candidate = text(pending['candidate']);
  if (candidate.toLowerCase() !== target.toLowerCase()) {
    if (candidate && fs.existsSync(candidate) && !fs.existsSync(target)) fs.renameSync(candidate, target);
    else if (!fs.existsSync(target)) throw new Error(`the staged release ${candidate} is gone, and ${target} was never placed. Run ${flagFor(state.args, 'resume')} undo, then install again.`);
    else if (candidate && fs.existsSync(candidate)) {
      // BOTH THERE (post-build inspection #3): the placed folder must be this archive's, and the staging then goes.
      const recorded = path.join(target, '.archive-sha256');
      const placedSha = fs.existsSync(recorded) ? fs.readFileSync(recorded, 'utf8').trim() : '';
      if (placedSha !== text(pending['archive_sha256'])) throw new Error(`${target} is not this transaction's release (${placedSha}), and its staged copy is still at ${candidate}. Run ${flagFor(state.args, 'resume')} undo.`);
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
  setPendingMark(state, root, 'placed-version');
  setCurrentLink(root, target, text(pending['id']));
  const recordVersion = text(pending['previous_version']);
  const previous = recordVersion && recordVersion !== version ? recordVersion : text(pending['previous_previous']) || null;
  writeCurrentRecord(root, version, previous, text(pending['archive_sha256']));
  setPendingMark(state, root, 'activated');
  setShims(root);
  setPendingMark(state, root, 'shims');
  let pathAdded = false;
  // A --no-path-change GIVEN NOW WINS OVER THE SAVED TRANSACTION (kickoffs/s90 ruling 4): nothing is added.
  if (pending['path_change'] === true && !state.args.noPathChange) {
    pathAdded = addUserPath(path.join(root, 'bin'));
    addToOwnPath(path.join(root, 'bin'));
  }
  state.pathAdded = pathAdded;
  setPendingMark(state, root, 'placed', { path_added: pathAdded || pending['path_added'] === true });
  const stable = path.join(root, 'current');
  assertTuple(stable, readJsonFile(path.join(target, 'release.json')), stable);
}

/** Pass 6: the Library from the frozen plan, then the transaction moves into `owned` (`:493-525`). */
function apply(state: RunState, root: string, pending: Pending): void {
  const moved: string[] = [];
  const plan = path.join(root, '.pending', 'plan.json');
  const code = runShown(state.args.json, path.join(root, 'current', 'bin', 'library.exe'), ['setup', '--apply', '--plan-file', plan]);
  if (code !== 0) throw new Error(`writing the Library from the plan failed (exit ${code}); its refusal is above. Re-run the installer to finish or undo.`);
  const frozen = readJsonFile(plan) as unknown as SetupPlan;
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    const owned = [...receipt.owned];
    const stamp = utcRoundTripNow();
    if (pending['created_version'] === true) owned.push({ kind: 'version', path: `versions\\${text(pending['version'])}`, archive_sha256: pending['archive_sha256'], utc: stamp });
    for (const name of ['current', 'current.json', ...SHIM_FILES.map((shim) => `bin\\${shim.name}`), 'install-receipt.json', '.lifecycle.lock']) {
      if (!owned.some((item) => item['kind'] === 'file' && item['path'] === name)) owned.push({ kind: 'file', path: name, utc: stamp });
    }
    // ADOPTED IS NOT ADDED (post-build inspection #2): 1.0's entry becomes Deskpost's to remove at uninstall, but an undo
    // of this transaction reads only path_added, so it never strips an entry this transaction did not write.
    if (pending['path_added'] === true || pending['path_adopted'] === true) owned.push({ kind: 'path', entry: path.join(root, 'bin'), utc: stamp });
    if (frozen.library !== null && frozen.library !== undefined) {
      const created = frozen.library.writes.filter((write) => write.old_sha256 === null).map((write) => write.relative);
      owned.push({ kind: 'library', path: frozen.library.workspace, created, utc: stamp });
    }
    receipt.owned = owned;
    receipt.pending = null;
    receipt.path_change = pending['path_change'] === true && !(state.args.noPathChange && pending['path_added'] !== true);
    // THE APPROVED REFRESH IS DURABLE FROM THE INSTANT THE TRANSACTION IS (PLAN-one-upgrade.md r9 amendment 2).
    const approval = path.join(root, '.pending', 'refresh-approval.json');
    if (fs.existsSync(approval)) receipt['refresh_pending'] = fs.readFileSync(approval, 'utf8');
    writeReceipt(root, receipt);
    // THE `committed` FAULT (D5, kickoffs/s89 row 5): a stop between the commit and .pending's removal, as a crash would
    // leave it. The next run finds .pending with no pending transaction under the lock, and removes it.
    faultAfter('committed');
    // .pending GOES BEFORE THE LOCK IS RELEASED (the Report of 2026-10-02).
    removePendingFolder(root);
    // OLD VERSIONS ARE PRUNED AFTER A COMMITTED UPGRADE, INSIDE ITS LOCK (D7): the two current.json names stay.
    if (pending['operation'] === 'upgrade') {
      const record = readJsonFile(path.join(root, 'current.json'));
      state.pruned = pruneVersions(root, [text(record['version']) ?? '', text(record['previous']) ?? ''], moved);
      if (state.pruned.removed.length) {
        const gone = new Set(state.pruned.removed.map((name) => `versions\\${name}`.toLowerCase()));
        const after = readReceipt(root);
        after.owned = after.owned.filter((item) => !(item['kind'] === 'version' && gone.has(String(item['path']).toLowerCase())));
        writeReceipt(root, after);
      }
    }
  });
  handOffLeftovers(root, moved, false);
}

/**
 * `.pending` removed, CALLED INSIDE THE LOCK. DESKPOST_INSTALL_PAUSE_PENDING_REMOVAL=<ms> waits first, so self-test
 * section 133's claimant, trying the lock all the while, would see a committed receipt beside `.pending` if this call
 * ever moved outside `withLifecycleLock` (kickoffs/s90 row 4; the Codex review's finding 7). The wait moves with it.
 */
function removePendingFolder(root: string): void {
  const pause = Number(process.env['DESKPOST_INSTALL_PAUSE_PENDING_REMOVAL'] ?? '');
  if (Number.isInteger(pause) && pause > 0 && pause <= 10000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  fs.rmSync(path.join(root, '.pending'), { recursive: true, force: true });
}

/**
 * Reverse what this transaction did (`:527-581`). A Library file is restored from the plan's saved text only while it
 * still holds this transaction's new content; one someone has changed since is left, and named. A running image in the
 * version being removed -- the bootstrap, run from `current\bin\library.exe` -- is moved aside and its delete handed on
 * (ADR-0067); `handedOn` names where it went.
 */
function undo(root: string, pending: Pending, keepPath: boolean): { left: string[]; handedOn: string[]; pathKept: string | null } {
  const left: string[] = [];
  const handedOn: string[] = [];
  const planFile = path.join(root, '.pending', 'plan.json');
  if (fs.existsSync(planFile)) {
    const frozen = readJsonFile(planFile) as unknown as SetupPlan;
    if (frozen.library !== null && frozen.library !== undefined) {
      for (const write of frozen.library.writes) {
        if (!fs.existsSync(write.path)) continue;
        if (sha256File(write.path) !== write.new_sha256) {
          left.push(write.path);
          continue;
        }
        if (write.old_sha256 === null) fs.rmSync(write.path, { force: true });
        else writeAtomicText(write.path, text((write as unknown as Record<string, unknown>)['old_text']));
      }
      // THE FOLDERS THIS TRANSACTION MADE, planned or made on the way to a created file (post-build inspection #6): each
      // removed only when empty. The Library folder itself is kept: it may be the empty folder the reader ran from.
      const workspace = full(frozen.library.workspace);
      const made = new Map<string, string>();
      for (const directory of frozen.library.directories) made.set(directory.toLowerCase(), directory);
      for (const write of frozen.library.writes.filter((item) => item.old_sha256 === null)) {
        for (let parent = path.dirname(write.path); parent && parent.length > workspace.length; parent = path.dirname(parent)) made.set(parent.toLowerCase(), parent);
      }
      for (const directory of [...made.values()].sort((a, b) => b.length - a.length)) {
        if (fs.existsSync(directory) && !isLink(directory) && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
      }
    }
  }
  const current = path.join(root, 'current');
  const id = text(pending['id']);
  for (const name of fs.readdirSync(root)) {
    if (name.toLowerCase() === `current.new-${id}`.toLowerCase() || name.toLowerCase() === `current.old-${id}`.toLowerCase()) removeLink(path.join(root, name));
  }
  const previous = text(pending['previous_target']);
  if (previous) {
    if (fs.existsSync(previous)) setCurrentLink(root, previous, `undo${id}`);
    if (text(pending['previous_record'])) writeAtomicText(path.join(root, 'current.json'), text(pending['previous_record']));
  } else {
    if (present(current)) removeLink(current);
    fs.rmSync(path.join(root, 'current.json'), { force: true });
    for (const shim of SHIM_FILES) fs.rmSync(path.join(root, 'bin', shim.name), { force: true });
    const bin = path.join(root, 'bin');
    if (fs.existsSync(bin) && !fs.readdirSync(bin).length) fs.rmdirSync(bin);
  }
  // A --no-path-change GIVEN NOW WINS (ruling 4): the entry this transaction added stays, and is named.
  const pathKept = pending['path_added'] === true && keepPath ? path.join(root, 'bin') : null;
  if (pending['path_added'] === true && !keepPath) removeUserPath(path.join(root, 'bin'));
  if (pending['created_version'] === true) {
    const placed = path.join(root, 'versions', text(pending['version']));
    let now: string | null = null;
    try {
      now = linkTarget(current);
    } catch {
      now = null;
    }
    if (fs.existsSync(placed) && !sameText(now, full(placed))) removeTreeMovingRunning(root, placed, text(pending['id']).slice(0, 8), handedOn);
  }
  const candidate = text(pending['candidate']);
  if (candidate && /[\\/]\.incoming-/.test(candidate) && fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
  clearPendingAndFolder(root);
  handOffLeftovers(root, handedOn, false);
  return { left, handedOn, pathKept };
}

/** The line that names a PATH entry a resume's --no-path-change left as it is (ruling 4), or nothing. */
function pathKeptText(args: InstallArgs, entry: string | null, what: 'added' | 'removed'): string {
  return entry ? ` ${entry} was not ${what} ${what === 'added' ? 'to' : 'from'} your PATH, as ${flagFor(args, 'no-path-change')} asked.` : '';
}

/** The line that names a running program moved aside (ADR-0067), or nothing. */
function handedOnText(root: string, handedOn: string[]): string {
  return handedOn.length
    ? ` The program this ran from was still running, so it was moved to ${path.join(root, LEFTOVER)} and is deleted once it exits; the next install here removes it if it is still there.`
    : '';
}

// --- the closing check (D7) -------------------------------------------------------------------------------------------

export type ClosingPart = 'program' | 'library' | 'refresh' | null;

/**
 * WHICH PART A CLOSING CHECK THAT IS NOT GREEN IS ABOUT (D7; the Report "Installer ends in a raw PowerShell exception
 * when its closing doctor finds a Library issue"): the program's own checks, a Library's, or a refresh that refused
 * before doctor ran. Only a program failure is the install's to roll back. A report that could not be read is the
 * program's, since its own doctor did not answer. Pure, so self-test section 132 judges it on any host.
 *
 * ONLY THE PROGRAM-WIDE CHECKS ARE THE PROGRAM'S (the Codex review's finding 6): the ordinary doctor kept Library checks
 * in `program_checks` (`seats.added-folders`, the `shelf.*` ones, `seats.inbound-policy`) until 1.4.1 moved them to
 * `library_checks` (kickoffs/s109 ruling 3), and `--served-by` folds them into each Library's rows; a failure among
 * those is the Library's, and names no rollback. An older report's are still read as the Library's.
 */
export function closingPart(exit: number, report: Record<string, unknown> | null, refreshing: boolean): ClosingPart {
  if (report === null) return exit === 0 ? null : refreshing ? 'refresh' : 'program';
  const failing = (rows: unknown) => (Array.isArray(rows) ? (rows as (Record<string, unknown> | null)[]) : []).filter((row) => row?.['status'] === 'fail');
  const programRows = failing(report['program_checks']);
  if (programRows.some((row) => PROGRAM_WIDE_CHECKS.has(String(row?.['check'])))) return 'program';
  const libraries = Array.isArray(report['libraries']) ? (report['libraries'] as { checks?: unknown }[]) : [];
  if (programRows.length || failing(report['checks']).length || failing(report['library_checks']).length || libraries.some((library) => failing(library.checks).length)) return 'library';
  return exit === 0 ? null : 'program';
}

/** The one plain message a committed transaction ends with when its closing check is not green: never a stack trace. */
export function closingMessage(part: Exclude<ClosingPart, null>, done: string, canRollBack: boolean, detail = ''): string {
  const lead = done ? `${done} ` : '';
  if (part === 'library') return `${lead}Doctor found a problem inside a Library, not in the program: the lines marked as failed under that Library above say how to fix it. Rolling back would not change it.`;
  if (part === 'refresh') return `${lead}Its Libraries were not brought up to date${detail ? `: ${detail}` : '.'} Run the installer again to finish the refresh.`;
  return `${lead}But the program's own check failed${detail ? ` (${detail})` : ''}: the Program lines marked as failed above say what to fix.${canRollBack ? ` ${COMMAND_NAME} rollback switches back to the version before.` : ' Run the installer again with --repair once that is fixed.'}`;
}

/**
 * WHAT THE CLOSING CHECK COVERS (kickoffs/s94 row 2; the Report "Suspected: a program-only install's closing doctor judges
 * the Library of the folder it was run from"). The approved refresh when the receipt carries one; the Library this run
 * was given; otherwise the program and every Library the install serves (`doctor --served-by`, a kept one as WARNs),
 * never the Library of the folder the installer was started in. Exported for self-test section 151.
 */
export function closingArgsFor(root: string, answers: Partial<Pick<SetupAnswers, 'library' | 'kept_libraries'>>, refreshPending: boolean): string[] {
  if (refreshPending) return ['setup', '--refresh-served', root];
  if (answers.library) return ['doctor', '--workspace', answers.library];
  return ['doctor', '--served-by', root, ...(answers.kept_libraries ?? []).filter((folder) => folder).flatMap((folder) => ['--kept', folder])];
}

export interface Closing {
  exit: number;
  report: Record<string, unknown> | null;
  part: ClosingPart;
  detail: string;
}

/**
 * THE CLOSING DOCTOR OR REFRESH, run through `current` and read as JSON, then said here: to a person as doctor's own
 * lines (the same rendering `deskpost doctor` prints), with --json only in the one result. Never thrown (D7): a closing
 * program that cannot start is the program's failure, its start error the detail (the Codex review's finding 5).
 * Exported for self-test section 132.
 */
export function runClosing(state: Pick<RunState, 'args' | 'say'>, exe: string, closingArgs: string[]): Closing {
  const refreshing = closingArgs[0] === 'setup';
  let ran: { exit: number; stdout: string; stderr: string };
  try {
    ran = runCaptured(exe, [...closingArgs, '--json']);
  } catch (error) {
    const detail = (error as Error).message;
    if (!state.args.json) {
      state.say('');
      state.say(detail);
      state.say('');
    }
    return { exit: 1, report: null, part: 'program', detail };
  }
  let report: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(ran.stdout) as unknown;
    report = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    report = null;
  }
  const detail = ran.stderr.trim().split(/\r?\n/).filter((line) => line.trim()).pop() ?? '';
  if (!state.args.json) {
    state.say('');
    state.say(report !== null ? (refreshing ? refreshServedText(report) : doctorText(report)) : ran.stderr.trim() || `${closingArgs.join(' ')} exited ${ran.exit} and said nothing.`);
    state.say('');
  } else if (ran.stderr.trim()) process.stderr.write(ran.stderr.trimEnd() + '\n');
  return { exit: ran.exit, report, part: closingPart(ran.exit, report, refreshing), detail };
}

function closingField(closing: Closing, message: string | null): Record<string, unknown> {
  return { ok: closing.part === null, failed: closing.part, message };
}

// --- the run ------------------------------------------------------------------------------------------------------

/** The installer proper: the extracted release's own binary, run by the bootstrap or by install.ps1. */
async function installExtracted(args: InstallArgs, say: (text: string) => void): Promise<number> {
  // THE TREE IS THIS BINARY'S OWN (D2): the code that places release N is release N's.
  const extracted = full(args.extracted);
  if (!sameText(full(programRoot()), extracted)) {
    throw new Error(`library install --extracted is run by the bootstrap on the extracted release's own binary; this program runs from ${programRoot()}, not ${extracted}. Run library install --release <folder>. Nothing was changed.`);
  }
  if (!/^[0-9a-f]{64}$/.test(args.archiveSha256)) throw new Error('library install --extracted needs the archive\'s SHA-256 (--archive-sha256 <hex>), which the bootstrap passes. Nothing was changed.');
  const release = readJsonFile(path.join(extracted, 'release.json'));
  if (release['platform'] !== args.platform) throw new Error(`this release is built for ${String(release['platform'])}, not ${args.platform}.`);
  const version = text(release['plugin_version']);
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`release.json's version '${version}' cannot name a directory.`);
  const tuple = releaseTuple();
  const mismatch = ['plugin_version', 'binary_version', 'workspace_schema'].filter((field) => String(tuple[field]) !== String(release[field]));
  if (mismatch.length || tuple['compiled'] !== true) throw new Error(`the extracted binary does not match its release (${mismatch.join(', ') || 'not compiled'}). Nothing was installed.`);
  const tempExe = sha256File(treeExecutable(extracted));

  const state: RunState = { args, say, txn: null, root: null, ownsPending: false };
  const interactive = isInteractive(args);
  const installRoot = full(args.installRoot);
  const temp = newTempFolder();
  let welcome: { exe: string; library: string; assistant: string } | null = null;
  try {
    const outcome = await transaction(state, { extracted, version, tempExe, installRoot, temp, interactive });
    if (typeof outcome === 'number') return outcome;
    welcome = outcome.welcome;
  } finally {
    // AN UNFINISHED TRANSACTION THIS RUN OWNS IS RELINQUISHED (round 5, #1): the recovery data stays; the next run claims it.
    if (state.ownsPending && state.root) {
      try {
        withLifecycleLock(state.root, () => {
          const receipt = readReceipt(state.root!);
          if (receipt.pending !== null && receipt.pending['id'] === state.txn) {
            receipt.pending['owner'] = null;
            writeReceipt(state.root!, receipt);
          }
        });
      } catch (error) {
        process.stderr.write(`The interrupted transaction at ${state.root} could not be released: ${(error as Error).message}\n`);
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
  // THE LOCK IS NEVER HELD DURING A CONVERSATION (round 2, #4): the fork runs only here, after `pending` was cleared and
  // the finally above released what this run held. Its console is the reader's.
  if (welcome !== null) {
    const welcomeArgs = ['setup', '--welcome', '--workspace', welcome.library];
    if (welcome.assistant) welcomeArgs.push('--assistant', welcome.assistant);
    runShown(false, welcome.exe, welcomeArgs);
  }
  return 0;
}

interface TransactionInputs {
  extracted: string;
  version: string;
  tempExe: string;
  installRoot: string;
  temp: string;
  interactive: boolean;
}

/** Steps 1-7. A number is the run's exit code, returned early; otherwise the welcome fork to run, if any. */
async function transaction(state: RunState, inputs: TransactionInputs): Promise<number | { welcome: { exe: string; library: string; assistant: string } | null }> {
  const { args } = state;
  const { extracted, version, tempExe, installRoot, temp, interactive } = inputs;
  const resumeFlag = flagFor(args, 'resume');

  // --- an interrupted transaction first: re-running the installer is the recovery ----------------------------------
  // RECOVERY IS DISPATCHED FIRST, AND NEVER ON A DRY RUN: claiming rewrites the receipt, so a dry run only reports it,
  // read without the lock, and a --json install refuses with the same report.
  if ((args.dryRun || args.json) && fs.existsSync(receiptPath(installRoot))) {
    const seen = readReceipt(installRoot);
    if (seen.pending !== null) {
      const phase = text(seen.pending['phase']);
      const operation = text(seen.pending['operation']);
      const frozen = !['staging', 'staged'].includes(phase);
      const allowed = operation === 'uninstall' ? `${resumeFlag} finish` : frozen ? `${resumeFlag} finish or ${resumeFlag} undo` : `${resumeFlag} finish (which starts over)`;
      const report = `An interrupted Deskpost ${operation} is recorded at ${installRoot} (transaction ${text(seen.pending['id'])}, stopped at '${phase}'). Run the installer at a terminal with ${allowed}.`;
      if (args.dryRun) {
        step(state, `${report} Nothing was changed.`);
        if (args.json) emitJson({ status: 'pending', install_root: installRoot, operation, transaction: text(seen.pending['id']), phase, resume: allowed });
        return 0;
      }
      throw new Error(`${report} Nothing was changed.`);
    }
  }
  let recovering: Pending | null = null;
  let staleCleared = false;
  if (fs.existsSync(receiptPath(installRoot))) {
    withLifecycleLock(installRoot, () => {
      // WHAT AN EARLIER RUN MOVED ASIDE AND COULD NOT DELETE (ADR-0067), removed where it can be now.
      if (!args.dryRun) sweepLeftovers(installRoot);
      const receipt = readReceipt(installRoot);
      if (receipt.pending !== null) {
        const owner = receipt.pending['owner'];
        if (ownerAlive(owner)) {
          throw new Error(`another Deskpost ${text(receipt.pending['operation'])} is running on ${installRoot} (process ${text((owner as Record<string, unknown>)['pid'])}). Let it finish, then run this again.`);
        }
        // A DEAD OR EMPTY OWNER IS CLAIMED, UNDER THE LOCK (round 4, #1): two recoverers can never both claim.
        receipt.pending['owner'] = selfOwner();
        writeReceipt(installRoot, receipt);
        recovering = receipt.pending;
      } else if (!args.dryRun && fs.existsSync(path.join(installRoot, '.pending'))) {
        // A COMMITTED TRANSACTION'S .pending (D5): with no pending transaction under the lock, it is a leftover.
        fs.rmSync(path.join(installRoot, '.pending'), { recursive: true, force: true });
        staleCleared = true;
      }
    });
  }
  if (staleCleared && args.resume) {
    // A COMMITTED TRANSACTION STILL OWES ITS REFRESH (the Codex review's finding 2): a crash after the commit leaves
    // `refresh_pending` in the receipt, so the refresh and its closing check run here, as a finish runs them.
    let closing: Closing | null = null;
    let message: string | null = null;
    if ('refresh_pending' in readReceipt(installRoot)) {
      if (readReceipt(installRoot).path_change === true && !args.noPathChange) addToOwnPath(path.join(installRoot, 'bin'));
      closing = runClosing(state, path.join(installRoot, 'current', 'bin', 'library.exe'), ['setup', '--refresh-served', installRoot]);
      if (closing.part !== null) message = closingMessage(closing.part, `The interrupted transaction at ${installRoot} had already committed.`, false, closing.detail);
    }
    if (message === null) {
      step(state, `The interrupted transaction at ${installRoot} had already committed; its leftover .pending folder is removed, ${closing !== null ? 'and the refresh it approved has run.' : 'and nothing else needed finishing.'}`);
    } else if (!args.json) state.say(message);
    if (args.json) emitJson({ status: 'finished', install_root: installRoot, transaction: null, ...(closing !== null ? { doctor_exit: closing.exit, doctor: closing.report, closing: closingField(closing, message) } : {}) });
    return message === null ? 0 : 1;
  }
  if (recovering !== null) {
    const pending: Pending = recovering;
    state.txn = text(pending['id']);
    state.root = installRoot;
    state.ownsPending = true;
    const operation = text(pending['operation']);
    if (operation === 'rollback') {
      // AN INTERRUPTED `deskpost rollback` (post-build inspection #1): current is put back as it was, never recovered
      // as an install, whose undo removes current and the shims.
      const record = JSON.parse(text(pending['previous_record'])) as Record<string, unknown>;
      const back = path.join(installRoot, 'versions', text(record['version']));
      if (!fs.existsSync(path.join(back, 'bin', 'library.exe'))) throw new Error(`An interrupted rollback is recorded at ${installRoot}, and ${back} is not there to switch back to. Nothing was changed.`);
      setCurrentLink(installRoot, back, `recover${state.txn}`);
      writeAtomicText(path.join(installRoot, 'current.json'), text(pending['previous_record']));
      clearPendingAndFolder(installRoot);
      state.ownsPending = false;
      step(state, `The interrupted rollback is undone: current runs ${text(record['version'])} again. Run ${COMMAND_NAME} rollback again if you still want it.`);
      if (args.json) emitJson({ status: 'rollback-undone', install_root: installRoot, version: text(record['version']) });
      return 0;
    }
    if (!['install', 'upgrade', 'repair', 'uninstall'].includes(operation)) {
      throw new Error(`An interrupted Deskpost '${operation}' is recorded at ${installRoot} (transaction ${state.txn}), which this installer does not know how to recover. Nothing was changed.`);
    }
    if (operation === 'uninstall') return await recoverUninstall(state, installRoot, pending, interactive);
    const frozen = !['staging', 'staged'].includes(text(pending['phase']));
    let choice: string = args.resume;
    if (!choice) {
      if (!interactive) {
        const allowed = frozen ? `${resumeFlag} finish or ${resumeFlag} undo` : `${resumeFlag} finish (which starts over)`;
        throw new Error(`An interrupted Deskpost ${operation} of ${text(pending['version'])} is recorded at ${installRoot} (transaction ${state.txn}, stopped at '${text(pending['phase'])}'). Run the installer again with ${allowed}.`);
      }
      state.say(`An earlier ${operation} of Deskpost ${text(pending['version'])} at ${installRoot} was interrupted (at '${text(pending['phase'])}').`);
      const key = await prompt(frozen ? '[f] finish it   [u] undo it   [q] quit › ' : '[s] start over   [q] quit › ');
      choice = key === 'f' || key === 's' ? 'finish' : key === 'u' && frozen ? 'undo' : '';
      if (!choice) {
        state.say('Nothing was changed. The interrupted transaction is kept for next time.');
        return SETUP_QUIT;
      }
    }
    if (choice === 'undo') {
      if (!frozen) throw new Error(`The interrupted ${operation} stopped before its plan was frozen, so there is nothing to undo; run with ${resumeFlag} finish to start over.`);
      const { left, handedOn, pathKept } = undo(installRoot, pending, args.noPathChange);
      state.ownsPending = false;
      step(state, `Undone. ${left.length ? `Left as they are, because they changed since: ${left.join(', ')}.` : 'Nothing was left behind.'}${pathKeptText(args, pathKept, 'removed')}${handedOnText(installRoot, handedOn)}`);
      if (args.json) emitJson({ status: 'undone', transaction: state.txn, left, handed_on: handedOn, path_not_changed: pathKept });
      return 0;
    }
    if (frozen) {
      // FINISH FROM THE FROZEN PLAN AND THE RETAINED CANDIDATE, never the release just fetched (round 4, #4).
      step(state, `Finishing the interrupted ${operation} of ${text(pending['version'])}`);
      const pathSkipped = args.noPathChange && pending['path_change'] === true && pending['path_added'] !== true ? path.join(installRoot, 'bin') : null;
      if (text(pending['phase']) !== 'placed') place(state, installRoot, pending);
      else if (pending['path_change'] === true && !args.noPathChange) addToOwnPath(path.join(installRoot, 'bin'));
      apply(state, installRoot, readReceipt(installRoot).pending!);
      state.ownsPending = false;
      // THE REFRESH, ONLY WHEN THE RECEIPT CARRIES ONE (ADR-0063; R1d). The transaction is committed: said, never thrown (D7).
      let closing: Closing | null = null;
      let message: string | null = null;
      if ('refresh_pending' in readReceipt(installRoot)) {
        closing = runClosing(state, path.join(installRoot, 'current', 'bin', 'library.exe'), ['setup', '--refresh-served', installRoot]);
        const previous = text(pending['previous_version']);
        if (closing.part !== null) message = closingMessage(closing.part, `Finished the interrupted ${operation} of ${text(pending['version'])}.`, previous !== '' && previous !== text(pending['version']), closing.detail);
      }
      if (message === null) step(state, `Finished.${pathKeptText(args, pathSkipped, 'added')} Run: ${COMMAND_NAME} doctor, and ${COMMAND_NAME} init <folder> in any Library it serves that is behind.`);
      else if (pathSkipped !== null && !args.json) step(state, pathKeptText(args, pathSkipped, 'added').trim());
      else if (!args.json) state.say(message);
      if (args.json) emitJson({ status: 'finished', transaction: state.txn, version: text(pending['version']), install_root: installRoot, path_not_changed: pathSkipped, ...(closing !== null ? { doctor_exit: closing.exit, doctor: closing.report, closing: closingField(closing, message) } : {}) });
      return message === null ? 0 : 1;
    }
    // BEFORE THE PLAN WAS FROZEN NOTHING WAS PLACED: only the receipt and staging. Start over with this release.
    const candidate = text(pending['candidate']);
    if (candidate && /[\\/]\.incoming-/.test(candidate) && fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
    clearPendingAndFolder(installRoot);
    state.ownsPending = false;
    state.txn = null;
    step(state, 'Starting over.');
  }

  // --- 2. ask: the program holds the conversation ----------------------------------------------------------------
  const answersFile = path.join(temp, 'answers.json');
  // THE USER PATH AS STORED (step 3): an install on it that this shell cannot see is still another install.
  // DESKPOST_USER_PATH stands in for it when set; `;` is a user PATH with no entries.
  const storedUserPath = process.env['DESKPOST_USER_PATH'] !== undefined ? process.env['DESKPOST_USER_PATH']! : nativeUserPathRead(userPathKey());
  const asked = await setupAsk({
    answersFile,
    installRoot,
    installRootGiven: true,
    library: args.library,
    cwd: process.cwd(),
    yes: !interactive,
    json: args.json,
    allowOverlap: args.allowOverlap,
    repair: args.repair,
    pathChange: pathAnswerOf(args),
    checksumNote: "checksum matches the release's SHA256SUMS",
    userPath: storedUserPath || undefined,
    assistant: args.librarian || undefined,
    runAsFile: args.runAsFile,
    keepLibraries: args.keepLibraries,
    spelling: spellingOf(args),
    dryRun: args.dryRun,
  });
  if (asked === SETUP_QUIT) {
    if (args.json) emitJson({ status: 'quit' });
    return SETUP_QUIT;
  }
  if (asked !== 0) throw new Error(`setup stopped (exit ${asked}); what it said is above. Nothing was installed.`);
  const answers = readJsonFile(answersFile) as unknown as SetupAnswers;
  const root = full(answers.install_root);
  const currentExe = path.join(root, 'current', 'bin', 'library.exe');

  // REFRESH ONLY, WHEN THE KERNEL SAYS SO (PLAN-one-upgrade.md r8 R2b): an approved refresh did not finish.
  if (answers.refresh_only === true) {
    if (args.dryRun) {
      step(state, 'Dry run: this would finish the refresh of the Libraries, and change nothing else. Nothing was changed.');
      return 0;
    }
    const closing = runClosing(state, currentExe, ['setup', '--refresh-served', root]);
    const message = closing.part === null ? null : closingMessage(closing.part, '', false, closing.detail);
    if (args.json) emitJson({ status: 'refreshed', version, install_root: root, doctor_exit: closing.exit, doctor: closing.report, closing: closingField(closing, message) });
    else if (message !== null) state.say(message);
    return message === null ? 0 : 1;
  }

  // CLOSE YOUR SESSIONS FIRST (#7, #10): an upgrade or repair switches the program they are running. Best effort. A
  // REPAIRED LIBRARY COUNTS WHATEVER ITS PROGRAM (S58 post-build inspection #2).
  const repairsLibrary = answers.library_state === 'existing' && answers.repair === true;
  const switches = ['upgrade', 'repair'].includes(answers.install_state) || repairsLibrary;
  const lookSessions = () => liveSessions(root, { library: repairsLibrary && answers.library ? answers.library : undefined });
  // THE ONE WAIT (PLAN-one-step-upgrade.md D3): it looks again by itself until they close, or `q`; with nobody to ask it
  // refuses, or waits `--wait <seconds>`. The dry run never waits; it names what is open beside the plan.
  if (switches && !args.dryRun) {
    const what = ['upgrade', 'repair'].includes(answers.install_state) ? `this ${answers.install_state} switches the program they are running` : 'this repair rewrites the guards they are running under';
    const clear = await waitForSessionsToClose({
      look: lookSessions,
      header: `Close your sessions first: ${what}.`,
      interactive,
      waitSeconds: args.waitSeconds,
      advice: 'End those sessions, then run the installer again.',
      say: (line) => state.say(line),
    });
    if (!clear) {
      state.say('Nothing was changed.');
      return SETUP_QUIT;
    }
  }

  // THE PLAN FROM THE TEMP TREE (step 2): what a dry run shows, and what --plan-id is compared with, before any root write.
  const currentLink = path.join(root, 'current');
  const plan = (resources: string): SetupPlan => {
    const made = setupPlan({ answers, resources, registerAs: currentLink });
    made.plan_id = planId(made, { archiveSha256: args.archiveSha256, scriptSha256: args.scriptSha });
    made.view = planView(made);
    return made;
  };
  let tempPlan: SetupPlan | null = null;
  if (args.dryRun || args.planId) {
    try {
      tempPlan = plan(extracted);
    } catch (error) {
      throw new Error(`the plan was refused: ${(error as Error).message} Nothing was changed.`);
    }
    if (args.dryRun) state.say(planText(tempPlan));
  }
  if (args.dryRun) {
    // THE SESSIONS ROW (D3), beside the plan and outside what its id hashes, so the id does not move as sessions open.
    const open = switches ? lookSessions() : { seats: [], processes: [], unreadable: [] };
    const openCount = open.seats.length + open.processes.length;
    state.say(openCount ? `  Sessions    ${openCount} open: they must close before the switch\n${sessionsText(open)}` : '  Sessions    none open');
    step(state, 'Dry run: nothing was changed.');
    if (args.json) {
      emitJson({
        status: 'dry-run',
        version,
        install_root: root,
        library: answers.library,
        plan_id: tempPlan!.plan_id,
        plan: tempPlan!.view,
        sessions: { open: openCount, seats: open.seats, processes: open.processes, text: sessionsText(open) } as unknown as PsJsonValue,
        script: { path: args.scriptPath, sha256: args.scriptSha },
        command_path: path.join(root, 'bin', `${COMMAND_NAME}.cmd`),
      });
    }
    return 0;
  }
  if (args.planId && tempPlan!.plan_id !== args.planId) {
    throw new Error(`This is not the plan that was shown (plan_id ${args.planId}; the plan now is ${tempPlan!.plan_id}): the release, an answer, the program folder or the Library changed since. Run the dry run again and show the new plan. Nothing was changed.`);
  }

  // --- 3. stage on the destination -----------------------------------------------------------------------------
  const versions = path.join(root, 'versions');
  const target = path.join(versions, version);
  const previousTarget = fs.existsSync(currentLink) || present(currentLink) ? linkTarget(currentLink) : null;
  const recordFile = path.join(root, 'current.json');
  const previousRecord = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : null;
  let previousVersion: string | null = null;
  let previousPrevious: string | null = null;
  if (previousRecord !== null) {
    const parsed = JSON.parse(previousRecord.replace(/^﻿/, '')) as Record<string, unknown>;
    previousVersion = text(parsed['version']);
    previousPrevious = text(parsed['previous']);
  }
  const operation = answers.install_state === 'upgrade' ? 'upgrade' : answers.install_state === 'repair' ? 'repair' : 'install';
  // A DIFFERENT TREE UNDER THIS VERSION IS REFUSED BEFORE ANYTHING IS RECORDED (post-build inspection #2).
  const recordedSha = path.join(target, '.archive-sha256');
  if (fs.existsSync(recordedSha)) {
    const had = fs.readFileSync(recordedSha, 'utf8').trim();
    if (had !== args.archiveSha256) throw new Error(`versions\\${version} differs from the release (${had}); run ${COMMAND_NAME} uninstall, then install again. Nothing was changed.`);
  } else if (fs.existsSync(target)) {
    throw new Error(`versions\\${version} is already there with no record of its archive; run ${COMMAND_NAME} uninstall, then install again. Nothing was changed.`);
  }
  // A 1.0 INSTALL IS ADOPTED WITH ITS PATH ENTRY (S55): `current.json` and no receipt, and that exact entry on the user PATH.
  let legacyPath = false;
  if (fs.existsSync(recordFile) && !fs.existsSync(receiptPath(root))) {
    const bin = path.join(root, 'bin').toLowerCase();
    legacyPath = nativeUserPathRead(userPathKey()).split(';').some((entry) => entry.replace(/\\+$/, '').toLowerCase() === bin);
  }
  state.root = root;
  state.txn = randomUUID().replace(/-/g, '');
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    if (receipt.pending !== null) throw new Error(`a Deskpost transaction appeared at ${root} while this one was being asked; run the installer again.`);
    // THE FIRST WRITE INTO THE ROOT IS THE PENDING TRANSACTION (round 2, #2), before anything is staged. Its shape is
    // install.ps1's, field for field (D5), so either can finish what the other began.
    receipt.pending = {
      id: state.txn,
      operation,
      version,
      archive_sha256: args.archiveSha256,
      root,
      owner: selfOwner(),
      phase: 'staging',
      candidate: null,
      created_version: false,
      path_change: answers.path_change,
      path_adopted: legacyPath,
      previous_target: previousTarget,
      previous_record: previousRecord,
      previous_version: previousVersion,
      previous_previous: previousPrevious,
      steps: ['stage', 'plan', 'place-version', 'activate-current', 'shims', 'path', 'apply'],
    };
    writeReceipt(root, receipt);
  });
  state.ownsPending = true;

  let candidate: string;
  let createdVersion: boolean;
  if (fs.existsSync(target)) {
    // THE SAME VERSION ALREADY THERE (round 3, #3): the same archive is the candidate, and Place skips the rename.
    const had = fs.existsSync(recordedSha) ? fs.readFileSync(recordedSha, 'utf8').trim() : '';
    if (had !== args.archiveSha256) throw new Error(`versions\\${version} differs from the release (${had}); run ${COMMAND_NAME} uninstall, then install again. Nothing else was changed.`);
    candidate = target;
    createdVersion = false;
    step(state, `Version ${version} is already here from this archive; reusing it`);
  } else {
    candidate = path.join(versions, `.incoming-${state.txn}`);
    step(state, `Copying ${version} into ${root}`);
    fs.mkdirSync(versions, { recursive: true });
    fs.cpSync(extracted, candidate, { recursive: true });
    if (sha256File(treeExecutable(candidate)) !== tempExe) throw new Error(`the copied binary does not match the one checked in ${extracted}; the copy to ${root} is not trusted. Nothing was switched.`);
    fs.writeFileSync(path.join(candidate, '.archive-sha256'), `${args.archiveSha256}\n`);
    createdVersion = true;
  }
  const inventory = path.join(candidate, '.inventory.json');
  if (fs.existsSync(inventory)) {
    const files = (readJsonFile(inventory)['files'] ?? []) as { path: string; sha256: string }[];
    const bad = files.filter((entry) => {
      const file = path.join(candidate, ...entry.path.split('/'));
      return !fs.existsSync(file) || sha256File(file) !== entry.sha256;
    });
    if (bad.length) throw new Error(`${bad.length} file(s) in the staged release do not match its inventory (${bad.slice(0, 5).map((entry) => entry.path).join(', ')}); nothing was switched.`);
  }
  setPendingMark(state, root, 'staged', { candidate, created_version: createdVersion });

  // --- 4. plan, read-only, before anything is switched -----------------------------------------------------------
  const pendingDirectory = path.join(root, '.pending');
  fs.mkdirSync(pendingDirectory, { recursive: true });
  const planFile = path.join(pendingDirectory, 'plan.json');
  // THE STAGED PLAN IS THE APPROVED ONE (step 2): the same archive gives the same plan; a difference is a staging fault.
  let stagedPlan: SetupPlan | null = null;
  let fault: string | null = null;
  try {
    stagedPlan = plan(candidate);
    fs.writeFileSync(planFile, psConvertToJson(stagedPlan as unknown as PsJsonValue) + '\n');
    if (args.planId && stagedPlan.plan_id !== tempPlan!.plan_id) fault = `the staged release plans differently from the plan that was shown (${stagedPlan.plan_id}, not ${tempPlan!.plan_id}). Staging was removed; nothing was switched, and the Library was not touched.`;
  } catch (error) {
    // A REFUSAL HERE LEAVES ONLY STAGING TO REMOVE (round 2, #1): nothing was switched and the Library is untouched.
    fault = `the plan was refused: ${(error as Error).message} Nothing was switched, and the Library was not touched.`;
  }
  if (fault !== null) {
    if (createdVersion) fs.rmSync(candidate, { recursive: true, force: true });
    clearPendingAndFolder(root);
    state.ownsPending = false;
    throw new Error(fault);
  }
  fs.copyFileSync(answersFile, path.join(pendingDirectory, 'answers.json'));
  setPendingMark(state, root, 'planned');

  // --- 5 and 6. place, then apply ----------------------------------------------------------------------------------
  place(state, root, readReceipt(root).pending!);
  apply(state, root, readReceipt(root).pending!);
  state.ownsPending = false;
  const status = operation === 'upgrade' ? 'upgraded' : operation === 'repair' ? 'repaired' : 'installed';

  // THE COMMAND ROW IS HONEST ABOUT PATH (#17). A process cannot change its caller's PATH (D4): install.ps1 adds the
  // entry to the window it runs in after this, and a new terminal reads the user PATH from the registry.
  const shim = path.join(root, 'bin', `${COMMAND_NAME}.cmd`);
  const resolved = resolveOnPath(COMMAND_NAME, CALLER_PATH);
  const command =
    resolved !== null && sameText(full(resolved), full(shim))
      ? 'ready in this window; other open terminals after a restart'
      : resolved !== null
        ? `this window runs ${resolved} as ${COMMAND_NAME}, not this install; move ${path.dirname(shim)} earlier on PATH`
        : !answers.path_change
          ? `not on this window's PATH; run ${shim}`
          : args.forwarded && !args.runAsFile
            ? 'ready in this window; other open terminals after a restart'
            : `on PATH in new terminals; in this one, run ${shim}`;

  // --- the plugin, opt-in ------------------------------------------------------------------------------------------
  let pluginResult = 'not installed (opt-in with --plugin)';
  if (args.plugin && !args.skipPlugin) {
    const claude = resolveOnPath('claude');
    if (claude === null) pluginResult = `claude is not on PATH. Run: claude plugin marketplace add "${currentLink}" ; claude plugin install deskpost@deskpost`;
    else {
      const viaShell = /\.(cmd|bat)$/i.test(claude);
      const run = (words: string[]) => spawnSync(claude, words, { encoding: 'utf8', windowsHide: true, shell: viaShell }).status ?? 1;
      const added = run(['plugin', 'marketplace', 'add', currentLink]);
      const installed = run(['plugin', 'install', 'deskpost@deskpost']);
      pluginResult = added === 0 && installed === 0 ? `installed from ${currentLink}` : `FAILED: marketplace add exited ${added}, plugin install exited ${installed}`;
    }
  }

  // --- doctor: its result is the install's result ----------------------------------------------------------------
  // THE APPROVED REFRESH, THEN DOCTOR OVER EVERY LIBRARY THIS INSTALL SERVES (ADR-0063 decisions 1 and 8), in one kernel
  // call, when the receipt carries one.
  const closingArgs = closingArgsFor(root, answers, 'refresh_pending' in readReceipt(root));
  const kept = [...(answers.kept_libraries ?? []), ...(answers.refresh_libraries ?? [])].filter((folder) => folder);
  // THE TRANSACTION IS COMMITTED: a closing check that is not green is said in one plain message and exit 1, never thrown,
  // and names a rollback only when the program itself failed and there is a version to go back to (D7).
  const closing = runClosing(state, currentExe, closingArgs);
  const done = status === 'upgraded' ? `Deskpost is upgraded to ${version}.` : status === 'repaired' ? `Deskpost ${version} is repaired.` : `Deskpost ${version} is installed.`;
  const message = closing.part === null ? null : closingMessage(closing.part, done, operation === 'upgrade', closing.detail);
  const setupFolder = setupFolderOf(args, root);
  if (args.json) {
    // THE PATH ENTRY, AS THIS RUN LEFT IT (kickoffs/s90 row 5): whether it was added, and whether its broadcast answered.
    const pathEntry = answers.path_change ? { added: state.pathAdded === true, broadcast: state.pathAdded === true ? lastPathBroadcast : null } : null;
    emitJson({ status, version, install_root: root, library: answers.library, command, command_path: shim, plan_id: args.planId || null, opens: stagedPlan?.view?.opens ?? null, plugin: pluginResult, path_entry: pathEntry, setup_folder: setupFolder, removed_versions: state.pruned?.removed ?? [], prune_warnings: state.pruned?.warned ?? [], doctor_exit: closing.exit, doctor: closing.report, closing: closingField(closing, message) });
    return message === null ? { welcome: null } : 1;
  }
  const setupLine = setupFolder !== null ? `  Setup    ${setupFolder} only started this install; delete it once this command has ended.` : null;
  // THE PRUNE, SAID (D7): what went, and a WARN per folder that could not.
  if (state.pruned?.removed.length) state.say(`Removed old versions: ${state.pruned.removed.join(', ')}`);
  for (const warning of state.pruned?.warned ?? []) state.say(`WARN: ${warning}`);
  if (message !== null) {
    state.say(message);
    if (setupLine !== null) state.say(setupLine);
    return 1;
  }
  state.say(answers.library ? `${done} Your Library is at ${answers.library}.` : kept.length ? `${done} Its Libraries: ${kept.join(', ')}.` : `${done} No Library was set up.`);
  state.say(`  Command  ${COMMAND_NAME}: ${command}`);
  if (args.plugin) state.say(`  Plugin   ${pluginResult}`);
  if (setupLine !== null) state.say(setupLine);
  // THE FORK, OR ONE LINE (step 5): a person is offered the tutorial or the main menu once everything is let go of.
  if (!answers.library && !kept.length) state.say(`Next: ${COMMAND_NAME} setup <folder>, to make a Library.`);
  else if (interactive && status === 'installed' && answers.library) return { welcome: { exe: currentExe, library: answers.library, assistant: answers.assistant ?? '' } };
  else state.say(`Next: ${COMMAND_NAME}`);
  return { welcome: null };
}

/**
 * AN INTERRUPTED UNINSTALL (round 3, #7; `:697-730`). Retry never needs the program: the installer is not what is
 * being removed. Once its Library edits began the only choice is finish; before them, undo just clears it.
 */
async function recoverUninstall(state: RunState, root: string, pending: Pending, interactive: boolean): Promise<number> {
  const { args } = state;
  const resumeFlag = flagFor(args, 'resume');
  const begun = pending['library_edits_begun'] === true;
  let choice: string = args.resume;
  if (!choice) {
    if (!interactive) throw new Error(`An interrupted Deskpost uninstall is recorded at ${root} (transaction ${state.txn}). Run the installer again with ${begun ? `${resumeFlag} finish` : `${resumeFlag} finish or ${resumeFlag} undo`}.`);
    const key = await prompt(`An uninstall of ${root} was interrupted. ${begun ? '[f] finish it   [q] quit' : '[f] finish it   [u] undo it   [q] quit'} › `);
    choice = key === 'f' ? 'finish' : key === 'u' && !begun ? 'undo' : '';
    if (!choice) return SETUP_QUIT;
  }
  if (choice === 'undo') {
    if (begun) throw new Error(`The interrupted uninstall had begun editing your Libraries, so it can only be finished: run with ${resumeFlag} finish.`);
    clearPendingAndFolder(root);
    state.ownsPending = false;
    step(state, 'The interrupted uninstall is undone; nothing had been removed.');
    if (args.json) emitJson({ status: 'uninstall-undone', install_root: root });
    return 0;
  }
  if (!begun) throw new Error(`The interrupted uninstall never reached your Libraries; run ${path.join(root, 'bin', `${COMMAND_NAME}.cmd`)} uninstall again, or ${resumeFlag} undo.`);
  // THE PROGRAM THIS RUNS FROM MAY BE ONE BEING REMOVED (ADR-0067): run as `current\bin\library.exe install`, the
  // bootstrap waits inside versions\<v>, so its image is moved aside, and its delete and the root's handed on.
  const aside = { tag: text(pending['id']).slice(0, 8), moved: [] as string[] };
  // A --no-path-change GIVEN NOW WINS (ruling 4): the PATH entry the uninstall froze stays, and is named.
  const removal = { ...(pending['removal'] as Parameters<typeof removeUninstallList>[1]) };
  const pathKept = args.noPathChange && removal.path_entry ? removal.path_entry : null;
  if (pathKept !== null) removal.path_entry = null;
  const problems = removeUninstallList(root, removal, userPathKey(), aside);
  if (problems.length) throw new Error(`The uninstall could not remove everything: ${problems.join('; ')}. Close what holds them and run ${resumeFlag} finish again.`);
  // THE RECEIPT AND .pending GO TOGETHER, INSIDE THE LOCK (D5); then the lock file and the root, each only if nothing is left.
  withLifecycleLock(root, () => {
    fs.rmSync(receiptPath(root), { force: true });
    fs.rmSync(path.join(root, '.pending'), { recursive: true, force: true });
  });
  try {
    fs.rmSync(path.join(root, '.lifecycle.lock'), { force: true });
  } catch {
    // Held by another process: left, as the script left it.
  }
  if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  handOffLeftovers(root, aside.moved, true);
  state.ownsPending = false;
  step(state, `The uninstall of ${root} is finished.${pathKeptText(args, pathKept, 'removed')}${handedOnText(root, aside.moved)}`);
  if (args.json) emitJson({ status: 'uninstalled', install_root: root, handed_on: aside.moved, path_not_changed: pathKept });
  return 0;
}
