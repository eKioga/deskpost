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
import { COMMAND_NAME, findAssistant, ownedRegistration } from './machine.ts';
import { discoverInstalls, missingProgramRoot, sameFolder } from './installs.ts';
import { sha256OfText } from './sha.ts';
import { deskpostScripts } from './doctor.ts';
import { programRoot, releaseTuple } from './programroot.ts';
import { sessionsVerb } from './lifecycle.ts';
import { askAtTerminal, Interrupted } from './prompt.ts';

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
  const ours = new Set(['install-receipt.json', '.lifecycle.lock', '.pending', 'versions']);
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
function otherInstall(root: string, userPath: string | undefined): { root: string; via: string } | null {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const searchPaths = [{ text: process.env[pathKey] ?? '', via: "this shell's PATH" }];
  if (userPath) searchPaths.push({ text: userPath, via: 'the user PATH' });
  const found = discoverInstalls({ searchPaths, libraries: [] });
  return found.find((install) => !sameFolder(install.root, root)) ?? null;
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
  pathChange: boolean;
  checksumNote: string;
  registryRoot?: string;
  /** The user PATH as stored (HKCU, raw), handed in by install.ps1 so an install this shell cannot see is found. */
  userPath?: string;
  /** `-Librarian`: the assistant named, not the one found first. */
  assistant?: 'claude' | 'codex';
  runAsFile?: boolean;
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

  // THE PROGRAM FOLDER: new, empty, or an install; never someone else's files (#1).
  const judgeRoot = (root: string) => {
    const characters = programFolderCharacterRefusal(root);
    if (characters) refuseWith(characters);
    let other: { root: string; via: string } | null;
    try {
      other = otherInstall(root, options.userPath);
    } catch (error) {
      refuseWith((error as Error).message);
    }
    if (other) {
      refuseWith(
        `Deskpost is already installed at ${other.root} (found on ${other.via}). Two installs would race for the ` +
          `\`${COMMAND_NAME}\` command, so a second is refused. Upgrade that one in place (run the installer with -InstallRoot ${other.root}), or run \`${COMMAND_NAME} uninstall\` first.`,
      );
    }
    const state = programFolderState(root);
    if (state.state === 'refused') refuseWith(state.reason!);
    return state;
  };
  let folderState = judgeRoot(installRoot);
  const installState: SetupAnswers['install_state'] =
    folderState.state === 'new' ? 'new' : folderState.version === version ? 'repair' : 'upgrade';
  if (installState === 'repair' && !options.repair && !talk.interactive) {
    refuseWith(`Deskpost ${version} is already installed at ${installRoot}. Pass -Repair to reinstall it over itself; nothing was changed.`);
  }

  // THE ONE QUESTION (Q2).
  talk.say(
    'Deskpost gives your assistant a Library to work in. Claude Code or Codex becomes its Librarian,\n' +
      'and it reads only what you open.\n',
  );
  const suggested = defaultLibraryAnswer(options.cwd, options.registryRoot);
  let library: string | null;
  let state: 'new' | 'existing' | 'none';
  const given = options.library?.trim();
  if (given && given.toLowerCase() === 'none') {
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
    if (!talk.interactive) refuseWith(`Your Library would be ${where} (${library}; program ${installRoot}). Deleting one would delete the other. Choose another folder, or pass -AllowOverlap.`);
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
          ? 'Claude Code was named as the Librarian (-Librarian claude) and is not on this machine. Install it (https://claude.ai/install.ps1), or name codex. Nothing was installed.'
          : 'Codex was named as the Librarian (-Librarian codex) and is not on this machine. Install it (npm install -g @openai/codex), or name claude. Nothing was installed.',
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
          `(-InstallRoot ${gone}), and the guards work again. Nothing was installed.`,
      );
    }
  }
  // AN UNGUARDED EXISTING LIBRARY IS REPAIRED BY DEFAULT, said on the screen; nobody-to-ask needs -Repair (S55).
  const unguarded = state === 'existing' && library !== null && !libraryIsGuarded(library);
  if (unguarded && !options.repair && !talk.interactive) {
    refuseWith(
      `The Library at ${library} has no Deskpost guards registered (an uninstall removes them), so using it as it is would leave ` +
        'every session there unguarded. Pass -Repair to register them again, or -Library <another folder>. Nothing was installed.',
    );
  }
  let repairLibrary = (options.repair || unguarded) && state === 'existing';

  // THE ONE SCREEN, AND THE ONE KEYPRESS.
  for (;;) {
    talk.say('\n' + screenText({ version, checksumNote: options.checksumNote, installRoot, installState, fromVersion: folderState.version, library, state, repairLibrary, unguarded, assistant, both: claude !== null && codex !== null, pathChange: options.pathChange, overlapAccepted, runAsFile: options.runAsFile === true }));
    if (!talk.interactive) break;
    const keys = ['[Enter] install'];
    if (installState === 'new') keys.push('[p] other program folder');
    if (state === 'existing') keys.push(repairLibrary ? (unguarded ? '[r] leave it unguarded' : '[r] leave the Library as it is') : '[r] repair this Library');
    if (claude !== null && codex !== null) keys.push(`[a] use ${assistant === 'claude' ? 'Codex' : 'Claude Code'}`);
    keys.push('[q] quit');
    const key = (await talk.ask('\n' + keys.join('   ') + ' › ')).toLowerCase();
    if (key === '') break;
    if (key === 'q') {
      talk.say('Nothing was installed.');
      return SETUP_QUIT;
    }
    if (key === 'a' && claude !== null && codex !== null) assistant = assistant === 'claude' ? 'codex' : 'claude';
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
    path_change: options.pathChange,
    checksum_note: options.checksumNote,
    unguarded,
    both_assistants: claude !== null && codex !== null,
    run_as_file: options.runAsFile === true,
    offered: state === 'existing' && !(repairLibrary && state === 'existing') ? ['repair'] : [],
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
}

/** The screen as a title and rows, the one source for the terminal screen and an assistant's table (step 2). */
export function screenRows(view: ScreenView): { title: string; rows: [string, string, string][] } {
  const rows: [string, string, string][] = [];
  const libraryNote =
    view.state === 'none'
      ? `none; later: ${COMMAND_NAME} setup <folder>`
      : view.state === 'new'
        ? 'your Books, Notebook and seats (new folder)'
        : view.repairLibrary && view.unguarded
          ? 'existing Library, with no Deskpost guards: they are registered again'
          : view.repairLibrary
          ? 'existing Library, repaired (its managed files brought up to date)'
          : 'existing Library, used as it is';
  rows.push(['Library', view.library ?? '-', libraryNote]);
  const programNote =
    view.installState === 'new'
      ? 'a new folder; updates and undo touch only this'
      : view.installState === 'upgrade'
        ? `Upgrade ${view.fromVersion ?? '?'} ${arrow()} ${view.version} · undo: ${COMMAND_NAME} rollback`
        : `Repair ${view.version} over itself`;
  rows.push(['Program', view.installRoot, programNote]);
  if (view.installState !== 'new') rows.push(['', '', 'installed here; moving it comes in a later version']);
  rows.push([
    'Command',
    COMMAND_NAME,
    !view.pathChange
      ? `not added to PATH (-NoPathChange): run ${path.join(view.installRoot, 'bin', `${COMMAND_NAME}.cmd`)}`
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
  } as PsJsonValue;
}

export function planId(plan: SetupPlan, release: { archiveSha256: string; scriptSha256: string }): string {
  return sha256OfText(JSON.stringify(canonicalPlan(plan, release)));
}

/** The view an assistant shows, built from the answers and the plan (the same rows as the screen). */
export function planView(plan: SetupPlan, registryRoot?: string): PlanView {
  const answers = plan.answers;
  const { title, rows } = screenRows(viewOfAnswers(answers));
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

export function setupApply(plan: SetupPlan): Record<string, unknown> {
  if (plan.library !== null) return { library: applyLibraryInit(plan.library, { makeDefault: plan.answers.make_default }) };
  if (plan.register !== null) {
    const registration = registerWorkspace(plan.register.workspace, plan.register.id, undefined, plan.answers.make_default);
    return { library: { status: 'used_as_it_is', workspace: plan.register.workspace, id: plan.register.id, registry: registration.path, registration: registration.action, files: [] } };
  }
  return { library: null };
}

function planText(plan: SetupPlan): string {
  if (plan.library === null && plan.register === null) return 'No Library is set up: the program only.';
  if (plan.register !== null) return `The Library at ${plan.register.workspace} is used as it is: nothing inside it is written.`;
  const library = plan.library!;
  const lines = [`The Library at ${library.workspace}: ${library.writes.length} file(s) to write, ${library.directories.length} folder(s) to create.`];
  for (const write of library.writes) lines.push(`  ${write.old_sha256 === null ? 'create ' : 'update '} ${write.relative}`);
  return lines.join('\n');
}

// --- the verb -------------------------------------------------------------------------------------------------------

export interface SetupVerbResult {
  refusal: string | null;
  exitCode: number;
  value: PsJsonValue | null;
  humanText?: string;
  asJson: boolean;
}

const VALUED = ['answers', 'install-root', 'library', 'cwd', 'resources', 'register-as', 'out', 'plan-file', 'checksum-note', 'registry-root', 'workspace', 'release-sha', 'script-sha', 'user-path', 'assistant'];

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
      const defaultRoot = process.platform === 'win32' ? path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'deskpost') : path.join(os.homedir(), '.local', 'share', 'deskpost');
      const code = await setupAsk({
        answersFile,
        installRoot: parsed.options.get('install-root') ?? defaultRoot,
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
      });
      return { refusal: null, exitCode: code, value: null, asJson: json };
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
      const result = setupApply(plan);
      return { refusal: null, exitCode: 0, value: result as PsJsonValue, humanText: applyText(result), asJson: json };
    }
    return await setupHere(parsed.positional[0] ?? parsed.options.get('workspace') ?? process.cwd(), { yes: parsed.flags.has('yes'), json, registryRoot: parsed.options.get('registry-root'), repair: parsed.flags.has('repair') });
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1, value: null, asJson: json };
  }
}

function applyText(result: Record<string, unknown>): string {
  const library = result['library'] as Record<string, unknown> | null;
  if (library === null) return 'No Library was set up.';
  if (library['status'] === 'used_as_it_is') return `The Library at ${String(library['workspace'])} is registered, and was left as it is.`;
  return `The Library at ${String(library['workspace'])} is ready (${String(library['status']).replace('_', ' ')}).`;
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

