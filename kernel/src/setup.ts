/**
 * `deskpost setup`: the one question, the one screen, the plan and its apply (PLAN-install-onboarding.md steps 2-4, 7;
 * ADR-0057).
 *
 * THE INSTALLER IS A FETCHER AND THE PROGRAM DOES THE CONVERSATION (Q1). install.ps1 downloads and checks a release in
 * %TEMP%, then runs that release's own binary three times:
 *
 *   setup --ask   --answers <file> [options]   the question, the screen, the checks. Writes only the answers file.
 *                                              Exit 0 = go, 3 = the reader quit, anything else = an error.
 *   setup --plan  --answers <file> --resources <tree> --register-as <root>\current --out <file>
 *                                              init with its writes split off: every file, its content now, and what it
 *                                              will hold. It creates nothing, not even the Library folder.
 *   setup --apply --plan-file <file>           writes exactly what the plan lists, under the three-state rule, and
 *                                              registers the Library. Re-running it finishes a half-written Library.
 *
 * `deskpost setup [<folder>]` on its own is the same plan and apply against this installed program, shown and taken
 * with one yes: how a Library is made after an install that made none (`-Library none`).
 *
 * NOTHING HERE PROMPTS WHERE NOBODY CAN ANSWER (step 7). `--yes`, `DESKPOST_YES=1`, `CI`, `--json` or a stdin that is not
 * a terminal mean defaults only; a consequential choice (overlap, repair) is never a default and refuses, naming the
 * flag that makes it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { applyLibraryInit, planLibraryInit, registerWorkspace, type LibraryInitPlan } from './init.ts';
import { findWorkspaceByMarker, markerField, readMarker, registryPath, toWorkspaceRoot } from './workspace.ts';
import { COMMAND_NAME, findAssistant, ownedRegistration, readInstallReceipt } from './machine.ts';
import { discoverInstalls, librariesServedByRoot, missingProgramRoot, sameFolder } from './installs.ts';
import { sha256OfText } from './sha.ts';
import { deskpostScripts } from './doctor.ts';
import { programRoot, releaseTuple } from './programroot.ts';
import { liveSessions, readReceipt, sessionsText, sessionsVerb, withLifecycleLock, writeReceipt } from './lifecycle.ts';
import { runDoctor } from './doctor.ts';
import { doctorText } from './human.ts';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { createHash } from 'node:crypto';
import { askAtTerminal, Interrupted } from './prompt.ts';
import { compareVersions } from './versions.ts';
import { versionsToPrune } from './finisher.ts';

export const SETUP_QUIT = 3;

export interface SetupAnswers {
  schema: 1;
  version: string;
  install_root: string;
  /** new: an empty or absent folder. upgrade/repair: an install is there (current.json). */
  install_state: 'new' | 'upgrade' | 'repair';
  from_version: string | null;
  /** null for `-Library none`. */
  library: string | null;
  library_state: 'new' | 'existing' | 'none';
  repair: boolean;
  make_default: boolean;
  overlap_accepted: boolean;
  assistant: 'claude' | 'codex' | null;
  path_change: boolean;
  // THE SCREEN'S INPUTS, so `setup --plan` can give an assistant the same rows (PLAN-assistant-onboarding.md step 2).
  // Additive: a 1.1 answers file without them still plans.
  checksum_note?: string;
  unguarded?: boolean;
  both_assistants?: boolean;
  /** install.ps1 ran as a file, not in the reader's own session: there is no "this window" to be ready in. */
  run_as_file?: boolean;
  /** Repairs the plan leaves out unless asked: `repair` for an existing, guarded Library used as it is. */
  offered?: string[];
  /** An upgrade or repair: the served Libraries kept as they are, by `--keep-libraries` or `[k]` (S74 row 1, ADR-0063 D4). */
  kept_libraries?: string[];
  /**
   * AN UPGRADE OR REPAIR BRINGS THE LIBRARIES IT SERVES UP TO DATE (ADR-0063, PLAN-one-upgrade.md r7 R1): every served
   * Library but one the transaction itself writes (`-Library <new>`, `-Library <L> -Repair`; R1a), refreshed by
   * `setup --refresh-served` once the program transaction commits. Unattended runs refresh by default (D5).
   */
  refresh_libraries?: string[];
  /** `--keep-libraries` or `[k]` (D4): the served Libraries lag the program until `deskpost init <folder>`. */
  keep_libraries?: boolean;
  /**
   * A SAME-VERSION RUN WHILE AN APPROVED REFRESH IS UNFINISHED (R2b): refresh only. The installer runs
   * `setup --refresh-served <root>` and no program transaction; this is the kernel's decision, read off the receipt.
   */
  refresh_only?: boolean;
  /** The route that asked (D6): the screen and its advice name flags in that route's spelling. Not hashed. */
  spelling?: Spelling;
  /** The plan screen's PATH row (D5): what this run does to the user PATH, and why. Not hashed; path_change is. */
  path_row?: string;
}

/** The approved refresh an install's receipt still carries (`refresh_pending`, r9 amendment 2), parsed, or null. */
export function refreshPendingOf(root: string): RefreshApproval | null {
  const receipt = readInstallReceipt(root);
  const raw = receipt?.['refresh_pending'];
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as RefreshApproval;
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.libraries) ? parsed : null;
  } catch {
    return null;
  }
}

/** One served Library's refresh as the plan has it: the writes init would make, or why it is kept as it is. */
export interface RefreshEntry {
  workspace: string;
  decision: 'refresh' | 'refused';
  reason: string | null;
  plan: LibraryInitPlan | null;
}

/**
 * THE APPROVAL IS THE WRITE SET ITSELF (r9 amendment 1): per Library, each relative path, its old SHA-256 or null, and
 * its new content byte-exact, plus the folders to create. `setup --apply` writes it as `.pending\refresh-approval.json`;
 * the installer copies its text into the receipt as `refresh_pending` in the write that commits the transaction.
 */
export interface RefreshApproval {
  schema: 1;
  version: string;
  install_root: string;
  libraries: {
    workspace: string;
    decision: 'refresh' | 'refused';
    reason: string | null;
    writes: { relative: string; path: string; old_sha256: string | null; new_sha256: string; content: string }[];
    directories: string[];
  }[];
  /** Libraries kept as they are by `--keep-libraries` or `[k]`: never written, and doctor's WARNs only. */
  kept: string[];
}

/** Each served Library's refresh, planned: what `setup --ask` previews and `setup --plan` binds into the plan id (D9). */
export function planRefreshes(libraries: string[], resources: string, registerAs: string | undefined, registryRoot: string | undefined): RefreshEntry[] {
  return libraries.map((workspace) => {
    try {
      return { workspace, decision: 'refresh' as const, reason: null, plan: planLibraryInit({ workspacePath: workspace, programRoot: resources, registerAs, registryRoot }) };
    } catch (error) {
      // EACH LIBRARY STANDS ALONE (D2): one whose refresh refuses is kept as it is and named, and the rest go on.
      return { workspace, decision: 'refused' as const, reason: (error as Error).message.replace(/^library init refused and wrote nothing: /, ''), plan: null };
    }
  });
}

// --- the terminal -----------------------------------------------------------------------------------------

interface Conversation {
  interactive: boolean;
  /** Where the screen is printed: stdout, or stderr when stdout carries one JSON result. */
  say: (text: string) => void;
  ask: (question: string) => Promise<string>;
  close: () => void;
}

function conversation(options: { yes: boolean; json: boolean }): Conversation {
  const interactive =
    !options.yes && !options.json && process.env['DESKPOST_YES'] !== '1' && !process.env['CI'] && process.stdin.isTTY === true;
  const out = options.json ? process.stderr : process.stdout;
  return {
    interactive,
    say: (text) => out.write(text.endsWith('\n') ? text : text + '\n'),
    // ONLY WHAT IS TYPED AFTER A QUESTION ANSWERS IT (S56, prompt.ts): type-ahead once answered the plan screen unread.
    // Nothing is written before the answers are frozen, so Ctrl+C or a closed input ends the run with nothing installed.
    ask: (question) =>
      askAtTerminal(question).catch((error: unknown) => {
        throw new Error(error instanceof Interrupted ? 'Ctrl+C: nothing was changed.' : 'The input ended before an answer, so nothing was changed.');
      }),
    close: () => {},
  };
}

/** `→` and `·` render in every console font measured (step 0, measurement 4), but a captured stream is ASCII. */
function arrow(): string {
  return process.stdout.isTTY ? '→' : '->';
}

// --- the checks ---------------------------------------------------------------------------------------------

/** The characters the program folder cannot hold (#11; round 2, #10), each with why. Null when there are none. */
export function programFolderCharacterRefusal(folder: string): string | null {
  if (folder.includes(';')) return `The program folder cannot contain ';': the PATH list is ';'-separated, so ${folder} would split into two entries.`;
  if (folder.includes('%')) return `The program folder cannot contain '%': the user PATH expands %NAME%, so ${folder} would not be the folder PATH names.`;
  if (folder.split(/[\\/]/).some((segment) => segment !== segment.replace(/[ .]+$/, '') && segment !== '.' && segment !== '..')) {
    return `A folder name in ${folder} ends with a space or a dot, which Windows strips, so it would not be the folder created.`;
  }
  return null;
}

/** What the program folder is: absent or empty (new), an install (current.json), or anything else (refused). */
export function programFolderState(folder: string): { state: 'new' | 'installed' | 'refused'; version: string | null; reason: string | null } {
  if (!fs.existsSync(folder)) return { state: 'new', version: null, reason: null };
  if (!fs.statSync(folder).isDirectory()) return { state: 'refused', version: null, reason: `${folder} is a file, not a folder.` };
  const record = path.join(folder, 'current.json');
  if (fs.existsSync(record)) {
    try {
      const current = JSON.parse(fs.readFileSync(record, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      return { state: 'installed', version: typeof current['version'] === 'string' ? current['version'] : null, reason: null };
    } catch {
      return { state: 'refused', version: null, reason: `${record} is not readable, so this install cannot be upgraded safely. Move it aside, or choose another folder.` };
    }
  }
  const entries = fs.readdirSync(folder);
  // AN INTERRUPTED INSTALL IS NOT "NOT EMPTY" (round 2, #2): a root holding only its receipt, its lock and staging.
  const ours = new Set(['install-receipt.json', '.lifecycle.lock', '.pending', 'versions', 'update-check.json']);
  if (entries.every((name) => ours.has(name))) return { state: 'new', version: null, reason: null };
  return { state: 'refused', version: null, reason: `${folder} is not empty. Choose an empty folder; Deskpost removes only what it put there.` };
}

/** A path's physical form: its nearest existing ancestor resolved (links followed), and the rest appended (#2). */
export function physicalPath(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let resolved = existing;
  try {
    resolved = fs.realpathSync.native(existing);
  } catch {
    // An ancestor that cannot be resolved is compared as written.
  }
  return path.join(resolved, ...rest);
}

/** Whether one folder contains the other, judged on physical paths, so a junction between them is seen. */
export function foldersOverlap(left: string, right: string): boolean {
  const norm = (value: string) => {
    const full = physicalPath(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  const a = norm(left);
  const b = norm(right);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

function isSystemFolder(folder: string): boolean {
  if (process.platform !== 'win32') return false;
  const windows = (process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows').toLowerCase();
  const full = path.resolve(folder).toLowerCase();
  return full === windows || full.startsWith(windows + '\\');
}

/** The registered Library the machine calls its default, when one is marked and still valid. */
export function defaultLibrary(registryRoot?: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(registryPath(registryRoot), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  try {
    const rows = (JSON.parse(text) as { workspaces?: unknown }).workspaces;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object' || (row as Record<string, unknown>)['default'] !== true) continue;
      const root = toWorkspaceRoot(String((row as Record<string, unknown>)['path'] ?? ''));
      if (root && fs.existsSync(path.join(root, '.library', 'workspace.json'))) return root;
    }
  } catch {
    return null;
  }
  return null;
}

/** The Library question's default (step 3): this folder when it is one, the default Library, or a folder here. */
export function defaultLibraryAnswer(cwd: string, registryRoot?: string): { folder: string; state: 'new' | 'existing' } {
  const here = findWorkspaceByMarker(cwd);
  if (here) return { folder: here, state: 'existing' };
  // THE FOLDER RUN FROM WINS (the plan's rule, and the complaint that started it; the Sandbox run in S55 found the
  // default Library answering first). The default Library stands in only where the folder run from cannot be used.
  if (isSystemFolder(cwd)) {
    const known = defaultLibrary(registryRoot);
    if (known) return { folder: known, state: 'existing' };
  }
  const base = isSystemFolder(cwd) ? path.join(process.env['USERPROFILE'] ?? os.homedir(), 'Library') : path.resolve(cwd);
  if (!fs.existsSync(base) || (fs.statSync(base).isDirectory() && fs.readdirSync(base).length === 0)) return { folder: base, state: 'new' };
  const inside = path.join(base, 'Library');
  if (findWorkspaceByMarker(inside) === path.resolve(inside)) return { folder: inside, state: 'existing' };
  return { folder: inside, state: 'new' };
}

/**
 * WHETHER AN EXISTING LIBRARY CARRIES ANY DESKPOST GUARD (S55, found in the Windows Sandbox run). `deskpost uninstall`
 * removes a Library's registrations and keeps it registered, so a reinstall offered it "used as it is" -- and the
 * install ended on a red doctor, the Library unguarded. A Library with no Deskpost hook in its Claude settings is
 * repaired by default, and a caller that cannot be asked is refused without -Repair.
 */
export function libraryIsGuarded(folder: string, program = programRoot()): boolean {
  const own = deskpostScripts(program);
  for (const name of ['settings.local.json', 'settings.json']) {
    let tree: unknown;
    try {
      tree = JSON.parse(fs.readFileSync(path.join(folder, '.claude', name), 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
    const hooks = tree !== null && typeof tree === 'object' ? (tree as Record<string, unknown>)['hooks'] : null;
    if (hooks === null || typeof hooks !== 'object') continue;
    for (const blocks of Object.values(hooks as Record<string, unknown>)) {
      for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
        const entries = block !== null && typeof block === 'object' ? (block as Record<string, unknown>)['hooks'] : null;
        for (const entry of Array.isArray(entries) ? entries : [entries]) if (ownedRegistration(entry, own) !== null) return true;
      }
    }
  }
  return false;
}

function libraryState(folder: string): { folder: string; state: 'new' | 'existing' } {
  const above = findWorkspaceByMarker(folder);
  if (above) return { folder: above, state: 'existing' };
  return { folder: path.resolve(folder), state: 'new' };
}

/**
 * ANOTHER INSTALL THAT RACES FOR THE COMMAND (PLAN-assistant-onboarding.md step 3): on this shell's PATH, or on the user
 * PATH as stored, which a shell started before an install does not see. Physically the same root is not another install
 * (post-build inspection #10). An input that cannot be read refuses (DiscoveryRefusal).
 *
 * NOT FROM REGISTRATIONS (decided while building, S57; the plan's step 3 and its log record it). A registered Library's
 * kernel-form registrations name its program, but an install made with -NoPathChange races for no command, and one that
 * changed PATH is already on the user PATH. Refusing on registrations blocked side-by-side installs the fixtures (and a
 * developer) rely on, for no hazard the PATH check misses. Registrations are read for the missing-program refusal only.
 */
function otherInstalls(root: string, userPath: string | undefined): { root: string; via: string }[] {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const searchPaths = [{ text: process.env[pathKey] ?? '', via: "this shell's PATH" }];
  if (userPath) searchPaths.push({ text: userPath, via: 'the user PATH' });
  const found = discoverInstalls({ searchPaths, libraries: [] });
  return found.filter((install) => !sameFolder(install.root, root));
}

/** Where an install goes when the reader names no folder: install.ps1's and this verb's default, one rule. */
export function defaultInstallRoot(): string {
  return process.platform === 'win32' ? path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'deskpost') : path.join(os.homedir(), '.local', 'share', 'deskpost');
}

/**
 * THE SPELLING OF THE ROUTE THAT ASKED (PLAN-one-step-upgrade.md D6). install.ps1 forwards its run (`--forwarded`) and
 * the 1.3.4 install.ps1 calls `setup --ask` itself, so those read PowerShell's `-Repair`; the kernel's own routes (the
 * Command Prompt line, the bootstrap, `deskpost install`, `deskpost upgrade`) read `--repair`.
 */
export type Spelling = 'kernel' | 'powershell';

const POWERSHELL_FLAGS: Record<string, string> = {
  resume: '-Resume',
  'dry-run': '-DryRun',
  json: '-Json',
  'plan-id': '-PlanId',
  'install-root': '-InstallRoot',
  repair: '-Repair',
  library: '-Library',
  librarian: '-Librarian',
  'no-path-change': '-NoPathChange',
};

/** The spelling of a route: the forwarder's (install.ps1 passes `--forwarded`) or the kernel's own. */
export function spellingOfRoute(forwarded: boolean): Spelling {
  return forwarded ? 'powershell' : 'kernel';
}

/** A flag as the caller types it: `-Repair` for the PowerShell route, `--repair` for the kernel's. */
export function flagFor(spelling: Spelling, name: string): string {
  return spelling === 'powershell' ? (POWERSHELL_FLAGS[name] ?? `--${name}`) : `--${name}`;
}

const RELEASE_DOWNLOAD = 'https://github.com/eKioga/deskpost/releases/latest/download';

/** The README's Command Prompt line, which downloads the release into %TEMP%\deskpost-setup and runs its bootstrap. */
const COMMAND_PROMPT_LINE =
  '(if not exist "%TEMP%\\deskpost-setup\\release" mkdir "%TEMP%\\deskpost-setup\\release") && ' +
  '(if not exist "%TEMP%\\deskpost-setup\\program" mkdir "%TEMP%\\deskpost-setup\\program") && ' +
  `curl.exe -fLo "%TEMP%\\deskpost-setup\\release\\SHA256SUMS" ${RELEASE_DOWNLOAD}/SHA256SUMS && ` +
  `curl.exe -fLo "%TEMP%\\deskpost-setup\\release\\deskpost-win-x64.zip" ${RELEASE_DOWNLOAD}/deskpost-win-x64.zip && ` +
  'tar -xf "%TEMP%\\deskpost-setup\\release\\deskpost-win-x64.zip" -C "%TEMP%\\deskpost-setup\\program" --strip-components=1 && ' +
  '"%TEMP%\\deskpost-setup\\program\\bin\\library.exe" install --release "%TEMP%\\deskpost-setup\\release"';

/**
 * THE EXACT LINE THAT UPGRADES THE INSTALL AT `root` IN PLACE (D6), for the install's own version and the route that
 * asked. An install of 1.3.6 or later upgrades itself: its shim's full path, since the install may be on the stored
 * PATH and not this shell's. An older one takes the route's line: the Command Prompt line for the kernel's routes, the
 * `irm` scriptblock for PowerShell's, `install.sh` on Linux, each naming the root.
 */
export function upgradeLine(root: string, version: string | null, spelling: Spelling): string {
  const order = version === null ? 'unknown' : compareVersions(version, '1.3.6');
  const upgrades = order === 'newer' || order === 'equal' || order === 'different';
  if (process.platform !== 'win32') {
    return upgrades
      ? `${path.join(root, 'current', 'bin', 'library')} upgrade`
      : `curl -fsSL ${RELEASE_DOWNLOAD}/install.sh | DESKPOST_INSTALL_ROOT=${root} sh`;
  }
  if (upgrades) return `${path.join(root, 'bin', `${COMMAND_NAME}.cmd`)} upgrade`;
  return spelling === 'powershell'
    ? `& ([scriptblock]::Create((irm ${RELEASE_DOWNLOAD}/install.ps1))) -InstallRoot ${root}`
    : `${COMMAND_PROMPT_LINE} --install-root "${root}"`;
}

/**
 * THE LIBRARIES AN INSTALL SERVES: every registered Library whose own registrations run this install's kernel, through
 * `current` or a `versions/<v>` folder. An upgrade keeps them as they are; their hooks name `current`, which it switches.
 */
export function librariesServedBy(root: string, registryRoot?: string): string[] {
  return librariesServedByRoot(root, registryRoot).served;
}

// --- setup --ask ------------------------------------------------------------------------------------------

export interface AskOptions {
  answersFile: string;
  installRoot: string;
  installRootGiven: boolean;
  library?: string;
  cwd: string;
  yes: boolean;
  json: boolean;
  allowOverlap: boolean;
  repair: boolean;
  /**
   * `'receipt'` (D5): an upgrade keeps the install's own answer, read from its receipt once the root is judged; a new
   * install, or a 1.0 install with no receipt, means on. `--path-change` and `--no-path-change` give it outright.
   */
  pathChange: boolean | 'receipt';
  checksumNote: string;
  registryRoot?: string;
  /** The user PATH as stored (HKCU, raw), handed in by install.ps1 so an install this shell cannot see is found. */
  userPath?: string;
  /** `-Librarian`: the assistant named, not the one found first. */
  assistant?: 'claude' | 'codex';
  runAsFile?: boolean;
  /** `--keep-libraries` (`install.ps1 -KeepLibraries`): the served Libraries are kept as they are (D4). */
  keepLibraries?: boolean;
  /** The route that asked (D6): `setup --ask` defaults to PowerShell's, since the 1.3.4 install.ps1 calls it. */
  spelling?: Spelling;
}

class Refusal extends Error {}

function refuseWith(message: string): never {
  throw new Refusal(message);
}

export async function setupAsk(options: AskOptions): Promise<number> {
  const talk = conversation(options);
  try {
    return await ask(options, talk);
  } finally {
    talk.close();
  }
}

async function ask(options: AskOptions, talk: Conversation): Promise<number> {
  const version = String(releaseTuple()['plugin_version'] ?? 'unknown');
  let installRoot = path.resolve(options.installRoot);
  const spelling: Spelling = options.spelling ?? 'powershell';
  const flag = (name: string) => flagFor(spelling, name);

  const findOthers = (root: string) => {
    try {
      return otherInstalls(root, options.userPath);
    } catch (error) {
      refuseWith((error as Error).message);
    }
  };

  // THE BARE ONE-LINER GOES AHEAD ON THE ONE INSTALL IT FINDS (PLAN-one-step-upgrade.md D4; ADR-0068 decision 5). A
  // root that is the default and holds nothing reads as "none given" (install.ps1 and install.sh pass the default).
  // With exactly one install elsewhere on PATH the run is about that install: said on its first line, and bound by the
  // plan id, which hashes the root; the run's one existing yes covers it. No downgrade by a found install; the same
  // version gets the same-version answer naming that root; two or more are refused below, each with its own line.
  if (sameFolder(installRoot, defaultInstallRoot()) && programFolderState(installRoot).state === 'new') {
    const others = findOthers(installRoot);
    if (others.length === 1) {
      const other = others[0]!;
      const otherVersion = programFolderState(other.root).version;
      if (otherVersion !== null && compareVersions(otherVersion, version) === 'newer') {
        refuseWith(`Deskpost ${otherVersion} at ${other.root} is newer than this release ${version}; nothing was changed.`);
      }
      talk.say(`Deskpost ${otherVersion ?? '?'} is installed at ${other.root} (found on ${other.via}).`);
      installRoot = path.resolve(other.root);
    }
  }

  // THE PROGRAM FOLDER: new, empty, or an install; never someone else's files (#1).
  const judgeRoot = (root: string) => {
    const characters = programFolderCharacterRefusal(root);
    if (characters) refuseWith(characters);
    const others = findOthers(root);
    if (others.length === 1) {
      const other = others[0]!;
      refuseWith(
        `Deskpost is already installed at ${other.root} (found on ${other.via}). Two installs would race for the ` +
          `\`${COMMAND_NAME}\` command, so a second is refused. Upgrade that one in place (${upgradeLine(other.root, programFolderState(other.root).version, spelling)}), or run \`${COMMAND_NAME} uninstall\` first.`,
      );
    }
    // TWO OR MORE, EACH WITH ITS OWN LINE (D4): the run cannot tell which one is meant.
    if (others.length > 1) {
      refuseWith(
        `Deskpost is already installed in ${others.length} places, and this run cannot tell which one is meant:\n` +
          others.map((other) => `  ${other.root} (found on ${other.via}): ${upgradeLine(other.root, programFolderState(other.root).version, spelling)}`).join('\n') +
          `\nUpgrade the one you use in place with its line, or run \`${COMMAND_NAME} uninstall\` from the others. Nothing was installed.`,
      );
    }
    const state = programFolderState(root);
    if (state.state === 'refused') refuseWith(state.reason!);
    return state;
  };
  let folderState = judgeRoot(installRoot);
  // THE INSTALL'S OWN PATH ANSWER (PLAN-one-step-upgrade.md D5; S91 standing answer 12): resolved after the root is
  // judged, so after D4's discovery. An install made with -NoPathChange keeps it on upgrade.
  const pathChangeFor = (root: string): boolean =>
    options.pathChange === 'receipt' ? readInstallReceipt(root)?.['path_change'] !== false : options.pathChange;
  const pathRowFor = (root: string): string => {
    const bin = path.join(root, 'bin');
    if (!pathChangeFor(root)) {
      return options.pathChange === 'receipt' ? `${bin}: left alone (chosen at install)` : `${bin}: left alone (${flag('no-path-change')})`;
    }
    const there = (options.userPath ?? '').split(';').some((entry) => entry.trim() && sameFolder(entry.trim().replace(/[\\/]+$/, ''), bin));
    return there ? `${bin}: already there` : `${bin}: added to your user PATH`;
  };
  const installState: SetupAnswers['install_state'] =
    folderState.state === 'new' ? 'new' : folderState.version === version ? 'repair' : 'upgrade';
  // A REFRESH THAT DID NOT FINISH IS FINISHED, AND NOTHING ELSE (R2b): the same version, with the receipt still carrying
  // an approved refresh, is offered refresh only, no program reinstall, as its default. `deskpost init <folder>` stays
  // the per-Library route. -Repair still asks for the whole repair.
  const unfinished = installState === 'repair' && !options.repair ? refreshPendingOf(installRoot) : null;
  if (unfinished !== null) {
    const libraries = unfinished.libraries.filter((library) => library.decision === 'refresh').map((library) => library.workspace);
    talk.say(`Deskpost ${version} at ${installRoot} has a refresh of its Libraries that did not finish: ${libraries.join(', ') || 'none left to write'}.`);
    talk.say('This run finishes it and changes nothing else. Or run deskpost init <folder> in each Library.');
    if (talk.interactive && (await talk.ask('[Enter] finish the refresh   [q] quit › ')).toLowerCase() === 'q') {
      talk.say('Nothing was changed.');
      return SETUP_QUIT;
    }
    const answers: SetupAnswers = {
      schema: 1, version, install_root: installRoot, install_state: 'repair', from_version: folderState.version, library: null, library_state: 'none',
      repair: false, make_default: false, overlap_accepted: false, assistant: null, path_change: pathChangeFor(installRoot), checksum_note: options.checksumNote,
      run_as_file: options.runAsFile === true, refresh_only: true, refresh_libraries: libraries, kept_libraries: unfinished.kept ?? [],
    };
    fs.mkdirSync(path.dirname(path.resolve(options.answersFile)), { recursive: true });
    fs.writeFileSync(options.answersFile, psConvertToJson(answers as unknown as PsJsonValue) + '\n');
    return 0;
  }
  // THE SAME VERSION IS SAID AS SUCH, to a person as to a script (S74 row 1): a repair is only ever asked for.
  if (installState === 'repair' && !options.repair) {
    refuseWith(`Deskpost is already at ${version} at ${installRoot}; nothing to upgrade. ${flag('repair')} reinstalls it. Nothing was changed.`);
  }

  const given = options.library?.trim();
  // AN UPGRADE OR REPAIR ASKS NO NEW-INSTALL QUESTION (S74 row 1, the Report "with -InstallRoot on an existing install,
  // the installer asks the new-install Library question"). Measured cause: the question's default is the folder run
  // from, and the registry's default Library stands in only from a system folder (defaultLibraryAnswer). Run from
  // the reader's home folder, which holds files and is no Library, it offered <home>\Library, a second, empty Library,
  // while the registry marked the real one default. With no -Library, the Libraries this install serves are kept as
  // they are: their hooks name `current`, which the upgrade switches, so nothing inside them is written.
  // THE LIBRARIES IT SERVES ARE BROUGHT UP TO DATE IN THE SAME RUN (ADR-0063, r7 R1), unless the reader keeps them (D4).
  let served: string[] = [];
  let keepLibraries = options.keepLibraries === true;
  if (installState !== 'new') {
    try {
      served = librariesServedBy(installRoot, options.registryRoot);
    } catch (error) {
      refuseWith((error as Error).message);
    }
  }
  if (installState !== 'new' && !given) {
    talk.say(
      installState === 'upgrade'
        ? `Upgrading Deskpost ${folderState.version ?? '?'} to ${version} at ${installRoot}.`
        : `Repairing Deskpost ${version} at ${installRoot}.`,
    );
    if (!served.length) talk.say('No registered Library runs this install; none is made.');
  } else {
    // THE ONE QUESTION (Q2).
    talk.say(
      'Deskpost gives your assistant a Library to work in. Claude Code or Codex becomes its Librarian,\n' +
        'and it reads only what you open.\n',
    );
  }
  const suggested = defaultLibraryAnswer(options.cwd, options.registryRoot);
  let library: string | null;
  let state: 'new' | 'existing' | 'none';
  if (installState !== 'new' && !given) {
    library = null;
    state = 'none';
  } else if (given && given.toLowerCase() === 'none') {
    library = null;
    state = 'none';
  } else if (given) {
    const judged = libraryState(given);
    library = judged.folder;
    state = judged.state;
  } else if (talk.interactive) {
    talk.say('Where should your Library live?  (the folder where the Librarian keeps your Books; `none` for the program only)');
    const typed = await talk.ask(`  [${suggested.folder}] › `);
    if (typed.toLowerCase() === 'none') {
      library = null;
      state = 'none';
    } else {
      const judged = typed ? libraryState(typed) : suggested;
      library = judged.folder;
      state = judged.state;
    }
  } else {
    library = suggested.folder;
    state = suggested.state;
  }
  if (library !== null && !toWorkspaceRoot(library)) refuseWith(`${library} is not a drive-rooted local path, so it cannot be a Library.`);

  // KEPT APART (Q4): the Library and the program folder must not contain each other, judged physically.
  let overlapAccepted = false;
  while (library !== null && foldersOverlap(library, installRoot)) {
    const where = path.resolve(library).length > installRoot.length ? 'inside the program folder' : 'around the program folder';
    if (options.allowOverlap) {
      overlapAccepted = true;
      break;
    }
    if (!talk.interactive) refuseWith(`Your Library would be ${where} (${library}; program ${installRoot}). Deleting one would delete the other. Choose another folder, or pass --allow-overlap.`);
    talk.say(`\nYour Library would be ${where}. Deleting one would delete the other.`);
    const choice = (await talk.ask('[Enter] choose another folder   [k] keep them together — I understand › ')).toLowerCase();
    if (choice === 'k') {
      overlapAccepted = true;
      break;
    }
    const typed = await talk.ask('  Library folder › ');
    if (!typed) continue;
    const judged = libraryState(typed);
    library = judged.folder;
    state = judged.state;
  }

  // THE LIBRARIAN ROW (#14): the assistant `seat start` would find.
  const claude = findAssistant('claude');
  const codex = findAssistant('codex');
  let assistant: 'claude' | 'codex' | null = claude !== null ? 'claude' : codex !== null ? 'codex' : null;
  // `-Librarian` NAMES IT (PLAN-assistant-onboarding.md step 4): the assistant installing Deskpost says which it is.
  if (options.assistant) {
    if ((options.assistant === 'claude' ? claude : codex) === null) {
      refuseWith(
        options.assistant === 'claude'
          ? `Claude Code was named as the Librarian (${flag('librarian')} claude) and is not on this machine. Install it (https://claude.ai/install.ps1), or name codex. Nothing was installed.`
          : `Codex was named as the Librarian (${flag('librarian')} codex) and is not on this machine. Install it (npm install -g @openai/codex), or name claude. Nothing was installed.`,
      );
    }
    assistant = options.assistant;
  }
  // A LIBRARY GUARDED ONLY BY A PROGRAM THAT IS GONE IS REFUSED, NOT REPAIRED (Codex #9): its reader command names that
  // program, and init refuses to replace a reader command it did not write. Installing there makes the guards run again.
  if (state === 'existing' && library !== null) {
    const gone = missingProgramRoot(library);
    if (gone !== null && !sameFolder(gone, installRoot)) {
      refuseWith(
        `The Library at ${library} has guards that name Deskpost at ${gone}, which is not installed. Install it there ` +
          `(${flag('install-root')} ${gone}), and the guards work again. Nothing was installed.`,
      );
    }
  }
  // AN UNGUARDED EXISTING LIBRARY IS REPAIRED BY DEFAULT, said on the screen; nobody-to-ask needs -Repair (S55).
  const unguarded = state === 'existing' && library !== null && !libraryIsGuarded(library);
  if (unguarded && !options.repair && !talk.interactive) {
    refuseWith(
      `The Library at ${library} has no Deskpost guards registered (an uninstall removes them), so using it as it is would leave ` +
        `every session there unguarded. Pass ${flag('repair')} to register them again, or ${flag('library')} <another folder>. Nothing was installed.`,
    );
  }
  let repairLibrary = (options.repair || unguarded) && state === 'existing';

  // R1a: a Library this transaction writes itself (`-Library <new>`, `-Library <L> -Repair`) is not refreshed again.
  const refreshTargets = () => served.filter((folder) => !(library !== null && sameFolder(folder, library) && (state === 'new' || repairLibrary)));
  const previews = new Map<string, RefreshPreview[]>();
  const preview = (): RefreshPreview[] => {
    const targets = refreshTargets();
    const key = targets.join('|');
    if (!previews.has(key)) {
      previews.set(key, planRefreshes(targets, programRoot(), path.join(installRoot, 'current'), options.registryRoot).map((entry) => ({
        workspace: entry.workspace,
        writes: entry.plan?.writes.length ?? 0,
        refused: entry.reason,
        codex: (entry.plan?.writes ?? []).some((write) => write.relative === '.codex/hooks.json'),
      })));
    }
    return previews.get(key)!;
  };

  // THE ONE SCREEN, AND THE ONE KEYPRESS.
  for (;;) {
    const removesVersions = installState === 'upgrade' ? versionsToPrune(installRoot, [version, folderState.version ?? '']) : [];
    talk.say('\n' + screenText({ version, checksumNote: options.checksumNote, installRoot, installState, fromVersion: folderState.version, library, state, repairLibrary, unguarded, assistant, both: claude !== null && codex !== null, pathChange: pathChangeFor(installRoot), overlapAccepted, runAsFile: options.runAsFile === true, keptLibraries: keepLibraries ? refreshTargets() : [], refresh: keepLibraries ? [] : preview(), spelling, pathRow: pathRowFor(installRoot), removesVersions }));
    if (!talk.interactive) break;
    const keys = screenKeys({ installState, state, repairLibrary, unguarded, refreshing: refreshTargets().length > 0, keepLibraries, both: claude !== null && codex !== null, assistant });
    const key = (await talk.ask('\n' + keys.join('   ') + ' › ')).toLowerCase();
    if (key === '') break;
    if (key === 'q') {
      talk.say(quitText(installState));
      return SETUP_QUIT;
    }
    if (key === 'k' && refreshTargets().length) keepLibraries = !keepLibraries;
    else if (key === 'a' && claude !== null && codex !== null) assistant = assistant === 'claude' ? 'codex' : 'claude';
    else if (key === 'r' && state === 'existing') repairLibrary = !repairLibrary;
    else if (key === 'p' && installState === 'new') {
      const typed = await talk.ask('  Program folder › ');
      if (!typed) continue;
      try {
        const candidate = path.resolve(typed);
        const judged = judgeRoot(candidate);
        if (judged.state !== 'new') {
          talk.say(`${candidate} already holds an install; choose a new or empty folder.`);
          continue;
        }
        installRoot = candidate;
        folderState = judged;
      } catch (error) {
        talk.say((error as Error).message);
      }
      if (library !== null && foldersOverlap(library, installRoot) && !overlapAccepted) {
        talk.say('That folder overlaps your Library; choose another.');
        installRoot = path.resolve(options.installRoot);
      }
    }
  }

  // THE DEFAULT LIBRARY (step 5a): the first one is; a later one only on a yes; an existing default is never replaced.
  let makeDefault = false;
  if (library !== null) {
    const current = defaultLibrary(options.registryRoot);
    if (current === null || current.toLowerCase() === library.toLowerCase()) makeDefault = true;
    else if (talk.interactive) makeDefault = (await talk.ask(`Make this your default Library, instead of ${current}? [y/N] › `)).toLowerCase() === 'y';
  }

  const answers: SetupAnswers = {
    schema: 1,
    version,
    install_root: installRoot,
    install_state: installState,
    from_version: folderState.version,
    library,
    library_state: state,
    repair: repairLibrary && state === 'existing',
    make_default: makeDefault,
    overlap_accepted: overlapAccepted,
    assistant,
    path_change: pathChangeFor(installRoot),
    checksum_note: options.checksumNote,
    unguarded,
    both_assistants: claude !== null && codex !== null,
    run_as_file: options.runAsFile === true,
    kept_libraries: keepLibraries ? refreshTargets() : [],
    refresh_libraries: keepLibraries ? [] : refreshTargets(),
    keep_libraries: keepLibraries,
    offered: state === 'existing' && !(repairLibrary && state === 'existing') ? ['repair'] : [],
    spelling,
    path_row: pathRowFor(installRoot),
  };
  fs.mkdirSync(path.dirname(path.resolve(options.answersFile)), { recursive: true });
  fs.writeFileSync(options.answersFile, psConvertToJson(answers as unknown as PsJsonValue) + '\n');
  return 0;
}

export interface ScreenView {
  version: string;
  checksumNote: string;
  installRoot: string;
  installState: SetupAnswers['install_state'];
  fromVersion: string | null;
  library: string | null;
  state: 'new' | 'existing' | 'none';
  repairLibrary: boolean;
  /** An existing Library with no Deskpost guard registered, as an uninstall leaves one (S55). */
  unguarded?: boolean;
  assistant: 'claude' | 'codex' | null;
  both: boolean;
  pathChange: boolean;
  overlapAccepted: boolean;
  /** install.ps1 ran as a file (an assistant's route): no "this window" is made ready. */
  runAsFile?: boolean;
  /** The Libraries an upgrade or repair keeps as they are (`--keep-libraries`, `[k]`). */
  keptLibraries?: string[];
  /** The route that asked (D6), for the flags the rows name. */
  spelling?: Spelling;
  /** The PATH row (D5): what this run does to the user PATH. */
  pathRow?: string;
  /** Each served Library's refresh, beside the program plan (ADR-0063 decision 1). */
  refresh?: RefreshPreview[];
  /** An upgrade: the old `versions\<v>` folders it removes once it commits, by the prune's keep rule (kickoffs/s94 row 2). */
  removesVersions?: string[];
}

/** What the screen's keys depend on. */
export interface ScreenKeyView {
  installState: SetupAnswers['install_state'];
  state: 'new' | 'existing' | 'none';
  repairLibrary: boolean;
  unguarded: boolean;
  /** Served Libraries the run would bring up to date, so `[k]` has something to keep. */
  refreshing: boolean;
  keepLibraries: boolean;
  both: boolean;
  assistant: 'claude' | 'codex' | null;
}

/**
 * THE ONE KEYPRESS, SAID FOR WHAT IT DOES (kickoffs/s94 row 2; the Report "The 1.3.6 upgrade screen says \"[Enter]
 * install\" ..."): Enter upgrades on an upgrade and repairs on a repair; a new install keeps `[Enter] install`, which
 * the release fixtures match. The other keys are as before. Exported for self-test section 151.
 */
export function screenKeys(view: ScreenKeyView): string[] {
  const keys = [view.installState === 'upgrade' ? '[Enter] upgrade' : view.installState === 'repair' ? '[Enter] repair' : '[Enter] install'];
  if (view.installState === 'new') keys.push('[p] other program folder');
  if (view.state === 'existing') keys.push(view.repairLibrary ? (view.unguarded ? '[r] leave it unguarded' : '[r] leave the Library as it is') : '[r] repair this Library');
  if (view.refreshing) keys.push(view.keepLibraries ? '[k] bring the Libraries up to date' : '[k] keep the Libraries as they are');
  if (view.both) keys.push(`[a] use ${view.assistant === 'claude' ? 'Codex' : 'Claude Code'}`);
  keys.push('[q] quit');
  return keys;
}

/** What `q` on the screen says: a new install installed nothing; an upgrade or repair changed nothing. */
export function quitText(installState: SetupAnswers['install_state']): string {
  return installState === 'new' ? 'Nothing was installed.' : 'Nothing was changed.';
}

/** One served Library's refresh as the screen says it: how many files, or why it is kept as it is. */
export interface RefreshPreview {
  workspace: string;
  writes: number;
  refused: string | null;
  /** Its `.codex/hooks.json` is rewritten, so Codex asks to review its hooks again (D10). */
  codex: boolean;
}

/** The screen as a title and rows, the one source for the terminal screen and an assistant's table (step 2). */
export function screenRows(view: ScreenView): { title: string; rows: [string, string, string][] } {
  const rows: [string, string, string][] = [];
  const kept = view.installState !== 'new' ? (view.keptLibraries ?? []) : [];
  const refresh = view.installState !== 'new' ? (view.refresh ?? []) : [];
  const servedOnly = view.state === 'none' && (kept.length > 0 || refresh.length > 0);
  const libraryNote =
    servedOnly && refresh.length
      ? `brought up to date in this run: ${refresh.length === 1 ? 'the Library' : 'the Libraries'} this install serves`
      : servedOnly
      ? `kept as ${kept.length === 1 ? 'it is' : 'they are'}, behind the program until ${COMMAND_NAME} init <folder>`
      : view.state === 'none'
      ? `none; later: ${COMMAND_NAME} setup <folder>`
      : view.state === 'new'
        ? 'your Books, Notebook and seats (new folder)'
        : view.repairLibrary && view.unguarded
          ? 'existing Library, with no Deskpost guards: they are registered again'
          : view.repairLibrary
          ? 'existing Library, repaired (its managed files brought up to date)'
          : 'existing Library, used as it is';
  rows.push(['Library', view.library ?? (servedOnly ? (refresh.length ? refresh.map((entry) => entry.workspace) : kept).join(', ') : '-'), libraryNote]);
  // EACH SERVED LIBRARY'S REFRESH, BESIDE THE PROGRAM PLAN (ADR-0063 decisions 1 and 4): a count, or the reason it is kept.
  for (const entry of refresh) {
    if (view.state !== 'none' || refresh.length > 1 || entry.refused !== null) {
      rows.push(['', entry.workspace, entry.refused !== null ? `kept as it is: ${entry.refused}` : `brought up to date: ${entry.writes} file(s)`]);
    } else rows.push(['', '', `${entry.writes} file(s) brought up to date after the program switches`]);
    if (entry.refused === null && entry.codex) rows.push(['', '', 'Codex will ask you to review this Library\'s hooks again on its next start.']);
  }
  if (view.state !== 'none') for (const folder of kept) rows.push(['', folder, `kept as it is, behind the program until ${COMMAND_NAME} init <folder>`]);
  const programNote =
    view.installState === 'new'
      ? 'a new folder; updates and undo touch only this'
      : view.installState === 'upgrade'
        ? `Upgrade ${view.fromVersion ?? '?'} ${arrow()} ${view.version} · undo: ${COMMAND_NAME} rollback`
        : `Repair ${view.version} over itself`;
  rows.push(['Program', view.installRoot, programNote]);
  // THE OLD VERSIONS AN UPGRADE REMOVES, NAMED BEFORE IT RUNS (kickoffs/s94 row 2): the run said them only afterwards.
  const removes = view.installState === 'upgrade' ? (view.removesVersions ?? []) : [];
  if (removes.length) rows.push(['', '', `removes ${removes.length === 1 ? 'an older version' : `${removes.length} older versions`}: ${removes.join(', ')}`]);
  rows.push([
    'Command',
    COMMAND_NAME,
    !view.pathChange
      ? `not added to PATH (${flagFor(view.spelling ?? 'powershell', 'no-path-change')}): run ${path.join(view.installRoot, 'bin', `${COMMAND_NAME}.cmd`)}`
      : view.runAsFile
        ? 'new terminals; restart an app to refresh its built-in terminal'
        : 'ready in this window; other open terminals after a restart',
  ]);
  const librarian =
    view.assistant === null
      ? 'No assistant found. Install Claude Code or Codex to talk to the Librarian'
      : view.assistant === 'claude'
        ? 'Claude Code' + (view.both ? '   (Codex also found)' : '')
        : 'Codex' + (view.both ? '   (Claude Code also found)' : '');
  // THE PATH ROW (D5), a view row like the Command row, outside what canonicalPlan hashes; path_change is hashed.
  if (view.pathRow) {
    const split = view.pathRow.lastIndexOf(': ');
    rows.push(['PATH', view.pathRow.substring(0, split), view.pathRow.substring(split + 2)]);
  }
  // THE UPDATE CHECK IS SAID WHERE THE INSTALL IS ASKED (D2; ADR-0068): the kernel's one call the reader did not ask for.
  rows.push(['Updates', 'once a day', 'the menu checks GitHub for a newer release; DESKPOST_UPDATE_CHECK=0 turns it off']);
  rows.push(['Librarian', librarian, '']);
  if (view.assistant === 'codex') rows.push(['', '', 'Codex will ask you to trust this folder and approve its hooks on first start.']);
  rows.push(['Undo', `${COMMAND_NAME} uninstall`, 'shows what it removes first']);
  rows.push(['', '', view.overlapAccepted ? 'your Library and the program folder are kept together, as you chose' : '(or delete the program folder; your Library is never inside it)']);
  return { title: `Deskpost ${view.version}  (${view.checksumNote || 'a release run from its own folder'})`, rows };
}

export function screenText(view: ScreenView): string {
  const { title, rows } = screenRows(view);
  // ALIGNED WHILE IT FITS: a long path is not padded, so the notes do not run off a normal terminal.
  const width = Math.min(Math.max(...rows.map((row) => row[1].length)), 36);
  const lines = [title];
  for (const [label, value, note] of rows) lines.push(`  ${label.padEnd(10)}  ${value.length > width ? value : value.padEnd(width)}  ${note}`.trimEnd());
  return lines.join('\n');
}

/** The screen view an answers file describes: what `setup --ask` showed, rebuilt for `setup --plan`'s JSON. */
export function viewOfAnswers(answers: SetupAnswers): ScreenView {
  return {
    version: answers.version,
    checksumNote: answers.checksum_note ?? '',
    installRoot: answers.install_root,
    installState: answers.install_state,
    fromVersion: answers.from_version,
    library: answers.library,
    state: answers.library_state,
    repairLibrary: answers.repair,
    unguarded: answers.unguarded === true,
    assistant: answers.assistant,
    both: answers.both_assistants === true,
    pathChange: answers.path_change,
    overlapAccepted: answers.overlap_accepted,
    runAsFile: answers.run_as_file === true,
    keptLibraries: answers.kept_libraries ?? [],
    spelling: answers.spelling ?? 'powershell',
    pathRow: answers.path_row,
    removesVersions: answers.install_state === 'upgrade' && answers.install_root ? versionsToPrune(answers.install_root, [answers.version, answers.from_version ?? '']) : [],
  };
}

// --- setup --plan / --apply -------------------------------------------------------------------------------------------

export interface SetupPlan {
  schema: 1;
  operation: 'Plan a Deskpost setup';
  answers: SetupAnswers;
  /** Init's plan for a new or repaired Library; null when the Library is used as it is, or there is none. */
  library: LibraryInitPlan | null;
  /** An existing Library used as it is: only registered (outside it), never written. */
  register: { workspace: string; id: string } | null;
  /** The served Libraries' refresh (ADR-0063), applied by `setup --refresh-served` once the transaction commits. */
  refresh?: RefreshEntry[];
  /** The hash of the canonical plan (step 2), when the release and script hashes were given; else null. */
  plan_id?: string | null;
  /** What an assistant shows: the screen's rows and what the plan does and does not do (step 2). */
  view?: PlanView;
}

export interface PlanView {
  title: string;
  rows: { label: string; value: string; note: string }[];
  state: 'install' | 'upgrade' | 'repair' | 'existing-library' | 'existing-library-repair' | 'program-only';
  library_files: { write: number; create_folders: number; files: { path: string; action: 'create' | 'update' }[] };
  assistants: { librarian: 'claude' | 'codex' | null; both_found: boolean };
  offered: string[];
  /** Which command opens this Library from a new terminal (Codex #7). */
  opens: { command: string; inside: string | null };
}

/**
 * THE CANONICAL PLAN, AND ITS HASH (PLAN-assistant-onboarding.md step 2; Fable confirmation, flaw A). Exactly the
 * release (archive and version), install.ps1's own hash, the answers, the root state, and every Library path with its
 * action and its expected old hash. NEW CONTENT IS LEFT OUT: the archive hash already pins it, and a new Library's marker and
 * collection record mint an id and a timestamp on every plan (init.ts:920-923, 995-996), so hashing content would make
 * no two plans of one Library agree. The program root is left out too: the dry run plans from %TEMP% and the install
 * from its staging, which are different folders holding the same archive.
 */
export function canonicalPlan(plan: SetupPlan, release: { archiveSha256: string; scriptSha256: string }): PsJsonValue {
  const a = plan.answers;
  // THE ROOT STATE, AS THE PLAN NAMES IT (step 2; S58 post-build inspection #1): absent, or current.json's version AND
  // previous, read when the plan is made. from_version alone let a changed `previous` (the rollback target) through.
  let rootState: PsJsonValue = null;
  if (a.install_root) {
    const record = path.join(a.install_root, 'current.json');
    if (fs.existsSync(record)) {
      try {
        const current = JSON.parse(fs.readFileSync(record, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
        rootState = { version: typeof current['version'] === 'string' ? current['version'] : null, previous: typeof current['previous'] === 'string' ? current['previous'] : null };
      } catch {
        rootState = { unreadable: true };
      }
    }
  }
  const writes = (plan.library?.writes ?? [])
    .map((write) => [write.relative, write.old_sha256 === null ? 'create' : 'update', write.old_sha256 ?? ''] as [string, string, string])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const workspace = plan.library?.workspace ?? '';
  const directories = (plan.library?.directories ?? []).map((folder) => path.relative(workspace, folder).replace(/\\/g, '/')).sort();
  // THE PLAN ID BINDS THE REFRESH (D9): each served Library's writes and folders as the Library's own are bound above,
  // its refusal, and the keep flag. Content is left out for the same reason, and the archive hash pins it.
  const refresh = (plan.refresh ?? []).map((entry) => ({
    workspace: entry.workspace.toLowerCase(),
    decision: entry.decision,
    reason: entry.reason,
    writes: (entry.plan?.writes ?? [])
      .map((write) => [write.relative, write.old_sha256 === null ? 'create' : 'update', write.old_sha256 ?? ''] as [string, string, string])
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    directories: (entry.plan?.directories ?? []).map((folder) => path.relative(entry.workspace, folder).replace(/\\/g, '/')).sort(),
  }));
  return {
    archive_sha256: release.archiveSha256.toLowerCase(),
    version: a.version,
    script_sha256: release.scriptSha256.toLowerCase(),
    answers: {
      install_root: a.install_root.toLowerCase(),
      install_state: a.install_state,
      from_version: a.from_version,
      library: a.library === null ? null : a.library.toLowerCase(),
      library_state: a.library_state,
      repair: a.repair,
      make_default: a.make_default,
      overlap_accepted: a.overlap_accepted,
      assistant: a.assistant,
      path_change: a.path_change,
    },
    root_state: rootState,
    register: plan.register === null ? null : { workspace: plan.register.workspace.toLowerCase(), id: plan.register.id },
    directories,
    writes,
    keep_libraries: a.keep_libraries === true,
    kept_libraries: (a.kept_libraries ?? []).map((folder) => folder.toLowerCase()).sort(),
    refresh,
  } as PsJsonValue;
}

export function planId(plan: SetupPlan, release: { archiveSha256: string; scriptSha256: string }): string {
  return sha256OfText(JSON.stringify(canonicalPlan(plan, release)));
}

/** The view an assistant shows, built from the answers and the plan (the same rows as the screen). */
export function planView(plan: SetupPlan, registryRoot?: string): PlanView {
  const answers = plan.answers;
  const refresh: RefreshPreview[] = (plan.refresh ?? []).map((entry) => ({
    workspace: entry.workspace,
    writes: entry.plan?.writes.length ?? 0,
    refused: entry.reason,
    codex: (entry.plan?.writes ?? []).some((write) => write.relative === '.codex/hooks.json'),
  }));
  const { title, rows } = screenRows({ ...viewOfAnswers(answers), refresh });
  const state: PlanView['state'] =
    answers.library_state === 'none'
      ? 'program-only'
      : answers.library_state === 'existing'
        ? answers.repair
          ? 'existing-library-repair'
          : 'existing-library'
        : answers.install_state === 'new'
          ? 'install'
          : answers.install_state;
  const writes = plan.library?.writes ?? [];
  // WHICH COMMAND OPENS IT (Codex #7): bare `deskpost` opens the default Library from outside any Library, so it opens
  // this one only when this one is, or becomes, the default, or is the only valid one registered.
  let bare = answers.library === null;
  if (answers.library !== null) {
    const current = defaultLibrary(registryRoot);
    bare = answers.make_default || (current !== null && sameFolder(current, answers.library));
  }
  return {
    title,
    rows: rows.map(([label, value, note]) => ({ label, value, note })),
    state,
    library_files: {
      write: writes.length,
      create_folders: plan.library?.directories.length ?? 0,
      files: writes.map((write) => ({ path: write.relative, action: write.old_sha256 === null ? 'create' : 'update' })),
    },
    assistants: { librarian: answers.assistant, both_found: answers.both_assistants === true },
    offered: answers.offered ?? [],
    opens: { command: COMMAND_NAME, inside: bare || answers.library === null ? null : answers.library },
  };
}

function readAnswers(file: string): SetupAnswers {
  const answers = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as SetupAnswers;
  if (answers.schema !== 1) throw new Error(`${file} is not a setup answers file this program reads.`);
  return answers;
}

/** The read-only planner (step 2, pass 4). Reads the program from `resources`, names `registerAs`, and writes nothing. */
export function setupPlan(options: { answers: SetupAnswers; resources: string; registerAs?: string; registryRoot?: string }): SetupPlan {
  const plan = setupLibraryPlan(options);
  // THE SERVED LIBRARIES' REFRESH, IN THE SAME PLAN (ADR-0063 decision 1): planned with the staged program and named by
  // `register-as`, as the Library's own writes are; one that refuses is kept as it is and named (D2).
  const targets = options.answers.refresh_libraries ?? [];
  if (targets.length) plan.refresh = planRefreshes(targets, options.resources, options.registerAs, options.registryRoot);
  return plan;
}

function setupLibraryPlan(options: { answers: SetupAnswers; resources: string; registerAs?: string; registryRoot?: string }): SetupPlan {
  const { answers } = options;
  if (answers.library === null || answers.library_state === 'none') return { schema: 1, operation: 'Plan a Deskpost setup', answers, library: null, register: null };
  if (answers.library_state === 'existing' && !answers.repair) {
    // USED AS IT IS (#8): nothing inside it is written. Its id is read from its marker, for the registry outside it.
    const id = markerField(readMarker(answers.library), 'id');
    if (!id.trim()) throw new Error(`${answers.library} has a Library marker with no id, so it cannot be registered as it is. Choose repair, or another folder.`);
    return { schema: 1, operation: 'Plan a Deskpost setup', answers, library: null, register: { workspace: answers.library, id } };
  }
  const library = planLibraryInit({ workspacePath: answers.library, programRoot: options.resources, registerAs: options.registerAs, registryRoot: options.registryRoot });
  return { schema: 1, operation: 'Plan a Deskpost setup', answers, library, register: null };
}

/**
 * `setup --apply`: the Library half the transaction writes, as before, and THE APPROVED REFRESH WRITTEN BESIDE THE PLAN
 * (r9 amendment 2): `<plan folder>\refresh-approval.json`, which is `.pending` in a transaction, so an Undo before the
 * commit discards it with `.pending`. Nothing in a served Library is written here: that is `setup --refresh-served`,
 * after the commit. A Library whose refresh refused is reported, and the apply still exits 0 (D2).
 */
export function setupApply(plan: SetupPlan, approvalFolder?: string): Record<string, unknown> {
  const result = setupLibraryApply(plan);
  const refresh = plan.refresh ?? [];
  const kept = plan.answers.kept_libraries ?? [];
  if ((refresh.length || kept.length) && approvalFolder) {
    const approval: RefreshApproval = {
      schema: 1,
      version: plan.answers.version,
      install_root: plan.answers.install_root,
      libraries: refresh.map((entry) => ({
        workspace: entry.workspace,
        decision: entry.decision,
        reason: entry.reason,
        writes: (entry.plan?.writes ?? []).map((write) => ({ relative: write.relative, path: write.path, old_sha256: write.old_sha256, new_sha256: write.new_sha256, content: write.content })),
        directories: entry.plan?.directories ?? [],
      })),
      kept,
    };
    fs.mkdirSync(approvalFolder, { recursive: true });
    writeAtomicText(path.join(approvalFolder, REFRESH_APPROVAL), JSON.stringify(approval) + '\n');
  }
  if (refresh.length) {
    result['refresh_libraries'] = refresh.filter((entry) => entry.decision === 'refresh').map((entry) => entry.workspace);
    result['refused_libraries'] = refresh.filter((entry) => entry.decision === 'refused').map((entry) => ({ workspace: entry.workspace, reason: entry.reason }));
  }
  return result;
}

/** The approval's file name beside the frozen plan. */
export const REFRESH_APPROVAL = 'refresh-approval.json';

/** What the refresh did to one served Library. */
interface RefreshOutcome {
  workspace: string;
  status: 'refreshed' | 'kept' | 'refused' | 'partly-refreshed';
  detail: string;
  /** The line that finishes it by hand, when it is not refreshed. */
  finish: string | null;
  written: number;
  /** Its `.codex/hooks.json` was rewritten, so Codex asks to review its hooks again (D10). */
  codex: boolean;
}

function fileSha(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  } catch {
    return null;
  }
}

/**
 * `setup --refresh-served <root>` (ADR-0063 decisions 2-4, r8 R1b, r9 amendments 1-2): the approved refresh the receipt
 * carries, replayed under the lifecycle lock, then `doctor --served-by <root>`, whose report and exit are this verb's.
 *
 * It REFUSES, writing nothing, while a transaction is pending or `current` is not the approved version, and while a live
 * session would meet the rewrite; the approval is then kept, and the one-liner run again finishes it (R2b). Each Library
 * is replayed by the THREE-STATE RULE, judged whole before it is written: a file still at its old state is written, one
 * at its new state is done, and anything else is a conflict, so that Library is left as it is and reported partly
 * refreshed, with `deskpost init <folder>` as the way to finish. Nothing is re-planned. `refresh_pending` is cleared once
 * every Library is done or reported, so nothing of the refresh stays under the root. With no approval it is doctor alone,
 * which is how the installer's closing check is one call whatever it installed.
 */
export function refreshServed(rootGiven: string, program: string, registryRoot: string | undefined): { value: Record<string, unknown>; exitCode: number; humanText: string } {
  const root = path.resolve(rootGiven);
  const outcomes: RefreshOutcome[] = [];
  let kept: string[] = [];
  const approval = withLifecycleLock(root, () => {
    const receipt = readReceipt(root) as unknown as Record<string, unknown> & { pending: Record<string, unknown> | null };
    const raw = receipt['refresh_pending'];
    if (raw === undefined || raw === null || raw === '') return null;
    if (receipt.pending !== null) {
      throw new Error(`a Deskpost ${String(receipt.pending['operation'])} is recorded at ${root} and not finished, so the approved refresh waits; nothing was written. Run the installer to finish or undo it first.`);
    }
    let parsed: RefreshApproval;
    try {
      parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as RefreshApproval;
    } catch {
      throw new Error(`the approved refresh recorded at ${root} cannot be read; nothing was written. Run ${COMMAND_NAME} init <folder> in each Library it serves.`);
    }
    let currentVersion: string | null = null;
    try {
      currentVersion = String((JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>)['version'] ?? '') || null;
    } catch {
      currentVersion = null;
    }
    if (currentVersion !== parsed.version) {
      throw new Error(`the approved refresh is for Deskpost ${parsed.version}, and ${root} runs ${currentVersion ?? 'no readable version'}; nothing was written. Run the installer for ${parsed.version} again, or ${COMMAND_NAME} init <folder> in each Library.`);
    }
    // TIME HAS PASSED SINCE THE INSTALLER'S CHECK (r7 R1): the sessions are looked at again just before anything is written.
    const live = liveSessions(root);
    if (live.seats.length || live.processes.length) {
      throw new Error(`Close your sessions first: bringing the Libraries up to date rewrites the guards they run under.\n${sessionsText(live)}\nNothing was written, and the approved refresh is kept: run the installer again to finish it.`);
    }
    for (const library of parsed.libraries) {
      const finish = `${COMMAND_NAME} init ${library.workspace}`;
      if (library.decision === 'refused') {
        outcomes.push({ workspace: library.workspace, status: 'refused', detail: library.reason ?? 'its refresh refused', finish, written: 0, codex: false });
        continue;
      }
      const states = library.writes.map((write) => {
        const now = fileSha(write.path);
        return now === write.new_sha256 ? 'done' : now === write.old_sha256 ? 'write' : 'conflict';
      });
      const conflicts = library.writes.filter((_, index) => states[index] === 'conflict').map((write) => write.relative);
      if (conflicts.length) {
        const done = states.filter((state) => state === 'done').length;
        outcomes.push({
          workspace: library.workspace,
          status: 'partly-refreshed',
          detail: `${conflicts.join(', ')} changed since the plan was shown, so ${done ? `${done} of its ${library.writes.length} files are new and the rest were left` : 'nothing in it was written'}`,
          finish,
          written: 0,
          codex: false,
        });
        continue;
      }
      for (const directory of library.directories) ensureDirectory(directory);
      let written = 0;
      library.writes.forEach((write, index) => {
        if (states[index] !== 'write') return;
        ensureDirectory(path.dirname(write.path));
        writeAtomicText(write.path, write.content);
        written += 1;
      });
      outcomes.push({ workspace: library.workspace, status: 'refreshed', detail: `${written} file(s) written`, finish: null, written, codex: library.writes.some((write) => write.relative === '.codex/hooks.json') });
    }
    kept = parsed.kept ?? [];
    for (const folder of kept) outcomes.push({ workspace: folder, status: 'kept', detail: 'kept as it is (--keep-libraries)', finish: `${COMMAND_NAME} init ${folder}`, written: 0, codex: false });
    delete receipt['refresh_pending'];
    writeReceipt(root, receipt as unknown as Parameters<typeof writeReceipt>[1]);
    return parsed;
  });
  // DOCTOR OVER EVERY SERVED LIBRARY (D8), a Library not brought up to date reporting WARNs, never a failure.
  const notRefreshed = outcomes.filter((outcome) => outcome.status !== 'refreshed').map((outcome) => outcome.workspace);
  const doctor = runDoctor(['--served-by', root, ...(registryRoot ? ['--registry-root', registryRoot] : []), ...notRefreshed.flatMap((folder) => ['--kept', folder])], program);
  if (doctor.refusal !== null) throw new Error(doctor.refusal);
  const report = doctor.value as Record<string, unknown>;
  const value: Record<string, unknown> = { ...report, refresh: { approved: approval !== null, libraries: outcomes } };
  return { value, exitCode: doctor.exitCode, humanText: refreshServedText(value) };
}

/**
 * `setup --refresh-served`'s report as lines for a person: each Library's refresh, then doctor. The installer renders
 * the same report it read as JSON with this (kickoffs/s89 row 3), so a closing check reads alike either way.
 */
export function refreshServedText(value: Record<string, unknown>): string {
  const refresh = value['refresh'] as { libraries?: RefreshOutcome[] } | undefined;
  const lines: string[] = [];
  for (const outcome of refresh?.libraries ?? []) {
    if (outcome.status === 'refreshed') lines.push(`Brought up to date: ${outcome.workspace} (${outcome.detail}).`);
    else if (outcome.status === 'kept') lines.push(`Kept as it is: ${outcome.workspace}. Run ${outcome.finish} to bring it up to date.`);
    else if (outcome.status === 'refused') lines.push(`Kept as it is: ${outcome.workspace}, because ${outcome.detail} Run ${outcome.finish} once that is fixed.`);
    else lines.push(`Partly refreshed: ${outcome.workspace}: ${outcome.detail}. Run ${outcome.finish} to finish it.`);
    if (outcome.codex) lines.push(`  Codex will ask you to review ${outcome.workspace}'s hooks again on its next start.`);
  }
  return [...lines, ...(lines.length ? [''] : []), doctorText(value)].join('\n');
}

function setupLibraryApply(plan: SetupPlan): Record<string, unknown> {
  if (plan.library !== null) return { library: applyLibraryInit(plan.library, { makeDefault: plan.answers.make_default }) };
  if (plan.register !== null) {
    const registration = registerWorkspace(plan.register.workspace, plan.register.id, undefined, plan.answers.make_default);
    return { library: { status: 'used_as_it_is', workspace: plan.register.workspace, id: plan.register.id, registry: registration.path, registration: registration.action, files: [] } };
  }
  const kept = plan.answers.kept_libraries ?? [];
  return kept.length ? { library: null, kept_libraries: kept } : { library: null };
}

/** An upgrade's kept Libraries, said as such rather than as "no Library" (S74 row 1). */
function keptText(kept: string[]): string {
  return `${kept.join(', ')} ${kept.length === 1 ? 'is' : 'are'} kept as ${kept.length === 1 ? 'it is' : 'they are'}: nothing inside ${kept.length === 1 ? 'it' : 'them'} is written. Run ${COMMAND_NAME} init <folder> to bring ${kept.length === 1 ? 'it' : 'each'} up to date.`;
}

export function planText(plan: SetupPlan): string {
  const kept = plan.answers.kept_libraries ?? [];
  const refresh = refreshPlanLines(plan.refresh ?? []);
  if (plan.library === null && plan.register === null) return [...(refresh.length ? refresh : []), ...(kept.length ? [keptText(kept)] : []), ...(!refresh.length && !kept.length ? ['No Library is set up: the program only.'] : [])].join('\n');
  if (plan.register !== null) return [`The Library at ${plan.register.workspace} is used as it is: nothing inside it is written.`, ...refresh].join('\n');
  const library = plan.library!;
  const lines = [`The Library at ${library.workspace}: ${library.writes.length} file(s) to write, ${library.directories.length} folder(s) to create.`];
  for (const write of library.writes) lines.push(`  ${write.old_sha256 === null ? 'create ' : 'update '} ${write.relative}`);
  return [...lines, ...refresh].join('\n');
}

/** The served Libraries' refresh as plan lines: each brought up to date after the switch, or kept with its reason. */
function refreshPlanLines(refresh: RefreshEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of refresh) {
    if (entry.decision === 'refused') lines.push(`${entry.workspace} is kept as it is: ${entry.reason}`);
    else lines.push(`${entry.workspace}: ${entry.plan?.writes.length ?? 0} file(s) brought up to date once the program switches.`);
  }
  return lines;
}

// --- the verb -------------------------------------------------------------------------------------------------------

export interface SetupVerbResult {
  refusal: string | null;
  exitCode: number;
  value: PsJsonValue | null;
  humanText?: string;
  asJson: boolean;
}

const VALUED = ['answers', 'install-root', 'library', 'cwd', 'resources', 'register-as', 'out', 'plan-file', 'checksum-note', 'registry-root', 'workspace', 'release-sha', 'script-sha', 'user-path', 'assistant', 'refresh-served'];

function assistantOption(value: string | undefined): 'claude' | 'codex' | undefined {
  if (value === undefined) return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'claude' || lower === 'codex') return lower;
  throw new Error(`--assistant takes claude or codex, not '${value}'. Nothing was installed.`);
}

export async function runSetupVerb(argv: string[]): Promise<SetupVerbResult> {
  const parsed = parseArguments(argv, VALUED);
  const json = parsed.flags.has('json');
  try {
    if (parsed.flags.has('ask')) {
      const answersFile = parsed.options.get('answers');
      if (!answersFile) return { refusal: 'setup --ask needs --answers <file>.', exitCode: 1, value: null, asJson: json };
      const code = await setupAsk({
        answersFile,
        installRoot: parsed.options.get('install-root') ?? defaultInstallRoot(),
        installRootGiven: parsed.options.has('install-root'),
        library: parsed.options.get('library'),
        cwd: parsed.options.get('cwd') ?? process.cwd(),
        yes: parsed.flags.has('yes'),
        json,
        allowOverlap: parsed.flags.has('allow-overlap'),
        repair: parsed.flags.has('repair'),
        pathChange: !parsed.flags.has('no-path-change'),
        checksumNote: parsed.options.get('checksum-note') ?? '',
        registryRoot: parsed.options.get('registry-root'),
        userPath: parsed.options.get('user-path'),
        assistant: assistantOption(parsed.options.get('assistant')),
        runAsFile: parsed.flags.has('run-as-file'),
        keepLibraries: parsed.flags.has('keep-libraries'),
      });
      return { refusal: null, exitCode: code, value: null, asJson: json };
    }
    if (parsed.options.has('refresh-served')) {
      // AFTER THE PROGRAM TRANSACTION COMMITS (ADR-0063 decision 1): the approved refresh, then doctor over every served Library.
      const done = refreshServed(parsed.options.get('refresh-served')!, programRoot(), parsed.options.get('registry-root'));
      return { refusal: null, exitCode: done.exitCode, value: done.value as PsJsonValue, humanText: done.humanText, asJson: json };
    }
    if (parsed.flags.has('sessions')) {
      const root = parsed.options.get('install-root');
      if (!root) return { refusal: 'setup --sessions needs --install-root <folder>.', exitCode: 1, value: null, asJson: json };
      const library = parsed.options.get('library');
      const found = sessionsVerb(path.resolve(root), library ? path.resolve(library) : undefined);
      return { refusal: null, exitCode: 0, value: found, humanText: found['clear'] ? 'No live session holds this install.' : String(found['text']), asJson: json };
    }
    if (parsed.flags.has('plan')) {
      const answersFile = parsed.options.get('answers');
      const resources = parsed.options.get('resources');
      const out = parsed.options.get('out');
      if (!answersFile || !resources || !out) return { refusal: 'setup --plan needs --answers <file>, --resources <program tree> and --out <file>.', exitCode: 1, value: null, asJson: json };
      const plan = setupPlan({ answers: readAnswers(answersFile), resources: path.resolve(resources), registerAs: parsed.options.get('register-as'), registryRoot: parsed.options.get('registry-root') });
      // THE PLAN'S ID, WHEN install.ps1 GIVES THE RELEASE'S AND ITS OWN HASHES (step 2), AND THE VIEW AN ASSISTANT SHOWS.
      const releaseSha = parsed.options.get('release-sha');
      const scriptSha = parsed.options.get('script-sha');
      plan.plan_id = releaseSha ? planId(plan, { archiveSha256: releaseSha, scriptSha256: scriptSha ?? '' }) : null;
      plan.view = planView(plan, parsed.options.get('registry-root'));
      fs.writeFileSync(out, psConvertToJson(plan as unknown as PsJsonValue) + '\n');
      const summary = { operation: plan.operation, plan: path.resolve(out), library: plan.library?.workspace ?? plan.register?.workspace ?? null, writes: plan.library?.writes.length ?? 0, directories: plan.library?.directories.length ?? 0, plan_id: plan.plan_id };
      return { refusal: null, exitCode: 0, value: summary as PsJsonValue, humanText: planText(plan), asJson: json };
    }
    if (parsed.flags.has('apply')) {
      const planFile = parsed.options.get('plan-file');
      if (!planFile) return { refusal: 'setup --apply needs --plan-file <file>.', exitCode: 1, value: null, asJson: json };
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8').replace(/^\uFEFF/, '')) as SetupPlan;
      const result = setupApply(plan, path.dirname(path.resolve(planFile)));
      return { refusal: null, exitCode: 0, value: result as PsJsonValue, humanText: applyText(result), asJson: json };
    }
    return await setupHere(parsed.positional[0] ?? parsed.options.get('workspace') ?? process.cwd(), { yes: parsed.flags.has('yes'), json, registryRoot: parsed.options.get('registry-root'), repair: parsed.flags.has('repair') });
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1, value: null, asJson: json };
  }
}

/**
 * `setup --apply`'s result as lines. Exported for self-test section 151. Its refresh line is the plan, said before the
 * switch; "Brought up to date" is the refresh's own line after it, once per Library (kickoffs/s94 row 2).
 */
export function applyText(result: Record<string, unknown>): string {
  const library = result['library'] as Record<string, unknown> | null;
  const refreshing = Array.isArray(result['refresh_libraries']) ? (result['refresh_libraries'] as unknown[]).map(String) : [];
  const refused = Array.isArray(result['refused_libraries']) ? (result['refused_libraries'] as { workspace: string; reason: string }[]) : [];
  // THE REFUSED LIST REACHES THE APPLY'S TEXT (D2): under -PlanId an outcome was approved, and this one is part of it.
  const tail = [
    ...(refreshing.length ? [`Will bring up to date once the program switches: ${refreshing.join(', ')}.`] : []),
    ...refused.map((entry) => `Kept as it is: ${entry.workspace}, because ${entry.reason} Run ${COMMAND_NAME} init ${entry.workspace} once that is fixed.`),
  ];
  if (library === null) {
    const kept = Array.isArray(result['kept_libraries']) ? (result['kept_libraries'] as unknown[]).map(String) : [];
    return [...(kept.length ? [keptText(kept)] : []), ...tail, ...(!kept.length && !tail.length ? ['No Library was set up.'] : [])].join('\n');
  }
  if (library['status'] === 'used_as_it_is') return [`The Library at ${String(library['workspace'])} is registered, and was left as it is.`, ...tail].join('\n');
  return [`The Library at ${String(library['workspace'])} is ready (${String(library['status']).replace('_', ' ')}).`, ...tail].join('\n');
}

/** `deskpost setup [<folder>]`: plan a Library against this installed program, show it, and apply it on one yes. */
async function setupHere(folder: string, options: { yes: boolean; json: boolean; registryRoot?: string; repair: boolean }): Promise<SetupVerbResult> {
  const judged = libraryState(folder);
  const answers: SetupAnswers = {
    schema: 1,
    version: String(releaseTuple()['plugin_version'] ?? 'unknown'),
    install_root: '',
    install_state: 'repair',
    from_version: null,
    library: judged.folder,
    library_state: judged.state,
    repair: judged.state === 'existing',
    make_default: defaultLibrary(options.registryRoot) === null,
    overlap_accepted: false,
    assistant: null,
    path_change: true,
  };
  if (judged.state === 'existing' && !options.repair) {
    return { refusal: `${judged.folder} is already a Library. Pass --repair to bring its managed files up to date; nothing was changed.`, exitCode: 1, value: null, asJson: options.json };
  }
  const plan = setupPlan({ answers, resources: programRoot(), registryRoot: options.registryRoot });
  const talk = conversation(options);
  try {
    talk.say(planText(plan));
    if (talk.interactive) {
      const key = (await talk.ask('\n[Enter] set it up   [q] quit › ')).toLowerCase();
      if (key === 'q') return { refusal: null, exitCode: SETUP_QUIT, value: null, humanText: 'Nothing was written.', asJson: options.json };
    } else if (!options.yes) {
      return { refusal: `setup needs a yes: pass --yes to set up ${judged.folder} without a prompt. Nothing was written.`, exitCode: 1, value: null, asJson: options.json };
    }
  } finally {
    talk.close();
  }
  const result = setupApply(plan);
  return { refusal: null, exitCode: 0, value: result as PsJsonValue, humanText: applyText(result) + `\nNext: ${COMMAND_NAME}, from inside the Library, opens its main menu.`, asJson: options.json };
}

