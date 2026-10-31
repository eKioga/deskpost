/**
 * The main menu: bare `deskpost` (PLAN-install-onboarding.md step 5a, ADR-0059), and the fork an install ends on (step 5).
 *
 * THE PRODUCT'S FRONT DOOR IS THE SEAT PICKER, PORTED. `tools/SeatPicker.ps1`, with `SeatConversation.ps1` for titles
 * (`conversation.ts`) and `Start-LibrarySeat.ps1` for the launch (`seat start`), is what Eric uses daily through an
 * Orca Quick Command; without it the PowerShell Library is unusable for him. So the menu is that picker at parity, and
 * the one word to come back to is the product's name.
 *
 * IT DECIDES WHERE TO SIT AND NOTHING ELSE, as the picker does. The claim is `seat start`'s, creation's gate and its
 * plan_id are `seat.ts`'s, retirement is `seat retire`'s own preflight and approval, and a Hub is `hub new`'s. The menu
 * composes them in process; it re-implements none of them and authorises nothing on its own. EVERY LAUNCH GOES THROUGH
 * `seat start` (confirmation round, #2): the menu, the first-seat wizard and the tutorial have no second launcher.
 *
 * THE ROSTER IS DISPLAY. Two of its columns come from advisory records, so a state shown can be stale by the time the
 * reader types, which is exactly why `seat start` refuses atomically. ONE DIFFERENCE FROM THE PICKER, stated: a seat the
 * roster read as held is refused here, from that read, with who holds it and another seat offered (step 5a's
 * "occupied seat" row), where SeatPicker.ps1 leaves even that to the acquisition. The cost is one more keystroke for a
 * seat freed while the reader typed; `seat start` still refuses atomically whatever the menu thought.
 *
 * NOTHING HERE PROMPTS WHERE NOBODY CAN ANSWER. Bare `deskpost` without a terminal prints usage (cli.ts); `deskpost menu`
 * without one refuses, naming the seats. `--script <file>` supplies the answers a person would type, one per line, so a
 * suite drives THIS loop rather than a copy of it; it bypasses no gate, and running out of answers is a named failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { argumentTable, verbTable, VERBS } from './verbs.ts';
import type { PsJsonValue } from './psjson.ts';
import { findWorkspaceByMarker, markerField, markerPath, readMarker, readTextFile, registryPath, requireWorkspace, toWorkspaceRoot, withMarkerLock } from './workspace.ts';
import { writeAtomicText } from './fsx.ts';
import { sha256OfText } from './sha.ts';
import { psConvertToJson } from './psjson.ts';
import { registerWorkspace } from './init.ts';
import { COMMAND_NAME, findAssistant, installRootOf } from './machine.ts';
import { spawnSync } from 'node:child_process';
import { programRoot, releaseTuple } from './programroot.ts';
import { installedVersion, readUpdateRecord, readyVersion, recordUpdateCheck, updateCheckDue, updateCheckSetting, updateLineText, upgradeVerb } from './upgrade.ts';
import { getSeatClaimState, readSeatActivity } from './seatclaim.ts';
import { deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { activeProjects, newSeatVerdict, retireSeat, SeatPlanChanged, seatRegistryRows, seatStartChoiceArguments, startSeat, type SeatStartChoices } from './seat.ts';
import { departmentOrchestrator, registryDepartments } from './seatstartplan.ts';
import { shelfCatalogEntryInventory } from './shelfcatalog.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { readRegistryRows, registryFilePath, writeSeatRegistry } from './seatregistry.ts';
import { ASSISTANT_LABEL, newConversationId, seatConversationView, type Assistant, type ConversationView } from './conversation.ts';
import { runHubVerb } from './collection.ts';
import { markerConnection } from './basicmemory.ts';
import { psSortCompare } from './notebook.ts';
import { askAtTerminal, Interrupted } from './prompt.ts';
import { browseData, browseEntries, browseEntryLines, browseLines, filterBrowse } from './browse.ts';
import { changeSeatDirs, launchLine, planSeatDirs, readAddedDirs, seatDirsSentence } from './seatdirs.ts';
import { cardProblem, departmentProblem, destinationOf, metadataFor, roleLabel, seatLabel, seatMetadata, type DepartmentDestination } from './seatmeta.ts';
import { loadSeatTemplate, type SeatTemplate } from './seattemplates.ts';
import { pendingLetterCounts } from './desk.ts';
import { seatNameHistory } from './seatincarnation.ts';

import { readSeatLaunch, seatLaunchPreview, escapedArgv, validateStoredFlags } from './seatlaunch.ts';
import { MENU_ACCESS, LAUNCH_ACCESS_VALUES, accessName, fullAccessSettings, accessOptionValue } from './menuaccess.ts';
import { seatSettingsResult } from './seatinbound.ts';
import { askScreen, plainRequired, type ScreenModel, type ScreenItem } from './menuscreen.ts';

// --- the conversation with the reader -------------------------------------------------------------------------------

class MenuQuit extends Error {}

export interface Talk {
  scripted: boolean;
  say: (text?: string) => void;
  ask: (prompt: string) => Promise<string>;
  /** Injectable screen input for disposable fixture proofs; ordinary callers use the terminal. */
  screen?: (model: ScreenModel | ((text: string) => ScreenModel), text?: string) => Promise<{ id: string; text: string }>;
}

/**
 * One typed line: from the scripted answers when a caller supplied them, else from the terminal. END OF INPUT IS NOT
 * AN EMPTY ANSWER, and the difference is a hang: an empty answer re-prompts, so a closed stdin would re-prompt forever.
 * The readline is opened per question and closed after it, so nothing holds the terminal when an agent is started.
 */
export function makeTalk(script: string[] | null): Talk {
  const queue = script ? [...script] : null;
  const say = (text = '') => process.stdout.write(text + '\n');
  return {
    scripted: queue !== null,
    say,
    ask: (prompt) => {
      if (queue !== null) {
        if (!queue.length) {
          throw new Error(
            `The menu asked '${prompt.trim()}' and the supplied answers ran out, so nothing was chosen. Either it asked a ` +
              'question the caller did not expect, or an answer it did expect was used by an earlier question.',
          );
        }
        const line = queue.shift()!;
        say(`${prompt}${line}`);
        return Promise.resolve(line.trim());
      }
      // TYPE-AHEAD IS SET ASIDE, AND CTRL+C IS SAID AS ITSELF (S56, prompt.ts).
      return askAtTerminal(prompt).catch((error: unknown) => {
        if (error instanceof Interrupted) throw new MenuQuit(error.message);
        throw new MenuQuit(`The menu asked '${prompt.trim()}' and its input ended, so nothing was chosen.`);
      });
    },
  };
}

// --- which Library (step 5a's five rules) ---------------------------------------------------------------------------

interface RegisteredLibrary {
  id: string;
  root: string;
  isDefault: boolean;
  valid: boolean;
}

/** The registry's Libraries, each with its `default` mark and whether it is VALID: its marker there, naming its id. */
export function registeredLibraries(registryRoot?: string): RegisteredLibrary[] {
  const file = registryPath(registryRoot);
  let rows: unknown[] = [];
  try {
    const document = JSON.parse(readTextFile(file)) as { workspaces?: unknown };
    rows = Array.isArray(document.workspaces) ? document.workspaces : [];
  } catch {
    return [];
  }
  const out: RegisteredLibrary[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const root = toWorkspaceRoot(String(record['path'] ?? ''));
    if (!root) continue;
    const id = String(record['id'] ?? '');
    let valid = false;
    try {
      valid = id.trim() !== '' && markerField(readMarker(root), 'id') === id;
    } catch {
      valid = false;
    }
    out.push({ id, root, isDefault: record['default'] === true, valid });
  }
  return out;
}

/**
 * THE LIBRARY BARE `deskpost` SHOWS, so one word works from anywhere and an Orca button needs no path: the Library
 * holding this folder, else the default Library, else the only valid one, else the reader's choice of several (offering
 * to make it the default), else none -- and then `deskpost setup` is offered. A default that is gone is said once.
 */
export async function resolveMenuLibrary(options: { explicit?: string; cwd: string; registryRoot?: string }, talk: Talk): Promise<string | null> {
  if (options.explicit && options.explicit.trim()) return requireWorkspace({ explicit: options.explicit });
  const here = findWorkspaceByMarker(options.cwd);
  if (here) return here;
  const libraries = registeredLibraries(options.registryRoot);
  const marked = libraries.find((library) => library.isDefault);
  if (marked && marked.valid) return marked.root;
  if (marked) talk.say(`Your default Library at ${marked.root} is gone.`);
  const valid = libraries.filter((library) => library.valid);
  if (valid.length === 1) return valid[0]!.root;
  if (valid.length > 1) {
    talk.say('Which Library?');
    valid.forEach((library, index) => talk.say(`  ${String(index + 1).padStart(2)}  ${library.root}`));
    for (;;) {
      const typed = await talk.ask('Library number (q to quit) › ');
      if (/^q(uit)?$/i.test(typed)) throw new MenuQuit('No Library was chosen.');
      const number = Number(typed);
      if (!Number.isInteger(number) || number < 1 || number > valid.length) {
        talk.say(`There is no Library ${typed || '(nothing typed)'}; the list offers 1 to ${valid.length}.`);
        continue;
      }
      const chosen = valid[number - 1]!;
      // AN EXISTING DEFAULT IS NEVER SILENTLY REPLACED (confirmation round, #4); here there is none that is valid.
      if ((await talk.ask('Make it your default Library, so `deskpost` opens it from anywhere? [y/N] › ')).toLowerCase() === 'y') {
        registerWorkspace(chosen.root, chosen.id, options.registryRoot, true);
        talk.say(`${chosen.root} is your default Library.`);
      }
      return chosen.root;
    }
  }
  return null;
}

// --- the roster -----------------------------------------------------------------------------------------------------

export interface MenuRow {
  index: number;
  seat: string;
  project: string;
  state: string;
  state_note: string;
  agent_pid: number;
  last_active_utc: string;
  opened_utc?: string;
  view: ConversationView;
  /** How many added folders the seat is started with (1.2.5); 0 when it has none or its record cannot be read. */
  folders: number;
  launchAssistant?: Assistant | null;
  launchFlags?: boolean;
  launchArgs?: string[];
  /** Its role and department as one phrase, and its card (1.3.8, kickoffs/s96 row 1), through the one projection; '' for none. */
  role?: string;
  card?: string;
  /** Its pending letters (kickoffs/s109 ruling 5), from the counts the Desk computes; 0 when none or unreadable. */
  letters?: number;
  /** The name it gave up in its newest rename, within 30 days of it (kickoffs/s110 ruling 6); '' for none. */
  formerly?: string;
  /** Its nickname, shown as `<nickname> (<seat>)` (kickoffs/s112 ruling 4); '' for none. */
  nickname?: string;
}

/** How long the menu says "(formerly <old>)" after a rename (PLAN-seat-identity.md section 3). */
export const FORMERLY_DAYS = 30;

/**
 * The name a registry row gave up in its newest rename, while that rename is under FORMERLY_DAYS old at `now`; '' for a
 * seat never renamed, a history that does not parse, or a rename older than that. From the row the menu already read.
 */
export function formerlyName(seat: string, names: unknown, now: Date): string {
  if (names === undefined || names === null) return '';
  const history = seatNameHistory(seat, '', names);
  if (history.problem !== null) return '';
  let newest: { name: string; at: number } | null = null;
  for (const span of history.names) {
    if (span.to_utc === null) continue;
    const at = Date.parse(span.to_utc);
    if (!Number.isNaN(at) && (newest === null || at > newest.at)) newest = { name: span.name, at };
  }
  if (newest === null) return '';
  const age = now.getTime() - newest.at;
  return age >= 0 && age < FORMERLY_DAYS * 24 * 60 * 60 * 1000 ? newest.name : '';
}

/** The " (formerly <old>)" mark a recently renamed seat carries on its row; nothing otherwise. */
export function formerlyMark(row: MenuRow): string {
  return row.formerly ? ` (formerly ${row.formerly})` : '';
}

/** One row per registered seat, sorted by name, numbered from 1. One unreadable seat does not take the roster down. */
export function menuRows(workspace: string, options: { transcriptRoot?: string; skipTitles?: boolean; now?: Date; fallbackAssistant?: Assistant } = {}): MenuRow[] {
  const now = options.now ?? new Date();
  const stateDirectory = path.join(workspace, '.claude');
  const entries = [...seatRegistryRows(workspace)].sort((left, right) => psSortCompare(String(left['seat']), String(right['seat'])));
  const projection = seatMetadata(entries);
  // ONE READ PER REDRAW (ruling 5): the Desk's own counts, and an unreadable Shelf marks no seat.
  let letters = new Map<string, number>();
  try {
    letters = pendingLetterCounts(workspace);
  } catch {
    letters = new Map();
  }
  return entries.map((entry, position) => {
    const seat = String(entry['seat']);
    const meta = metadataFor(projection, seat);
    const row: MenuRow = {
      index: position + 1,
      seat,
      project: String(entry['project'] ?? ''),
      state: 'unreadable',
      state_note: '',
      agent_pid: 0,
      last_active_utc: '',
      folders: 0,
      role: roleLabel(meta),
      card: meta.card ?? '',
      letters: letters.get(seat) ?? 0,
      formerly: formerlyName(seat, entry['names'], now),
      nickname: meta.nickname ?? '',
      view: {
        session_id: '', conversation_source: 'none', recorded_utc: '', assistant: 'claude', title: '', title_status: 'no-conversation',
        title_note: 'nothing has recorded a conversation at this seat', entry_action: 'none', entry_note: '',
      },
    };
    try {
      const state = getSeatClaimState(stateDirectory, seat);
      row.state = state.state;
      row.agent_pid = Number(state.agentPid) || 0;
      row.opened_utc = state.bindingStale ? '' : state.boundUtc;
      if (state.state === 'orphaned') row.state_note = `agent ${row.agent_pid} alive, claim holder gone`;
      const activity = readSeatActivity(stateDirectory, seat);
      if (activity && typeof activity['last_seen_utc'] === 'string') row.last_active_utc = activity['last_seen_utc'];
      row.view = seatConversationView(stateDirectory, seat, { transcriptRoot: options.transcriptRoot, skipTitle: options.skipTitles });
      const record = readSeatLaunch(stateDirectory, seat, String(entry['seat_id'] ?? ''));
      if (record.state === 'valid') {
        row.launchAssistant = record.record.assistant;
        const chosen = record.record.assistant ?? (row.view.session_id ? row.view.assistant : options.fallbackAssistant ?? 'claude');
        row.launchFlags = record.record.args[chosen].length > 0;
        row.launchArgs = [...record.record.args[chosen]];
      }
      // A RECORD THAT CANNOT BE READ MARKS NOTHING HERE: `f<N>` and `seat start` say why, and the roster stays up.
      try {
        row.folders = readAddedDirs(stateDirectory, seat).length;
      } catch {
        row.folders = 0;
      }
    } catch (error) {
      row.state = 'unreadable';
      row.state_note = (error as Error).message;
    }
    return row;
  });
}

interface Glyphs {
  ascii: boolean;
  tl: string; tr: string; bl: string; br: string; h: string; v: string; sep: string;
  held: string; free: string; other: string; ellipsis: string; dot: string;
}

interface Palette { reset: string; dim: string; bold: string; held: string; free: string; other: string; frame: string; accent: string }

/** Text an ASCII console can print: known punctuation transliterates, anything else is '?'. A title is not ours. */
export function plainText(text: string): string {
  const map: Record<number, string> = { 0x2026: '...', 0x2014: '--', 0x2013: '-', 0x00b7: '-', 0x201c: '"', 0x201d: '"', 0x2018: "'", 0x2019: "'", 0x2192: '->', 0x203a: '>' };
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (map[code] !== undefined) out += map[code];
    else if (code === 9) out += ' ';
    else if (code >= 32 && code < 127) out += character;
    else out += '?';
  }
  return out;
}

// THE WORDMARK IS PURE ASCII IN BOTH ALPHABETS, so it needs no fallback of its own; only the frame changes.
const WORDMARK = [
  String.raw` ___   ___  ___  _  __ ___   ___   ___  _____ `,
  String.raw`|   \ | __|/ __|| |/ /| _ \ / _ \ / __||_   _|`,
  String.raw`| |) || _| \__ \| ' < |  _/| (_) |\__ \  | |  `,
  String.raw`|___/ |___||___/|_|\_\|_|   \___/ |___/  |_|  `,
];

/** The framed masthead, drawn once on entry and never inside the loop, so the list is not pushed off a short screen. */
export function bannerLines(width: number, glyphs: Glyphs, palette: Palette, seatCount: number, inUse: number): string[] {
  const content = width - 4;
  let summary = seatCount === 1 ? '1 seat' : `${seatCount} seats`;
  if (inUse > 0) summary += ` ${glyphs.dot} ${inUse} in use`;
  if (content < WORDMARK[0]!.length) return ['', `  ${palette.bold}DESKPOST${palette.reset}  ${palette.dim}${summary}${palette.reset}`, ''];
  const bar = (left: string, right: string) => `${palette.frame}${left}${glyphs.h.repeat(width - 2)}${right}${palette.reset}`;
  const side = `${palette.frame}${glyphs.v}${palette.reset}`;
  const lines = ['', bar(glyphs.tl, glyphs.tr)];
  for (const art of WORDMARK) lines.push(`${side} ${palette.accent}${art.padEnd(content)}${palette.reset} ${side}`);
  const heading = 'Pick a seat';
  const gap = Math.max(1, content - heading.length - summary.length);
  lines.push(`${side} ${' '.repeat(content)} ${side}`);
  lines.push(`${side} ${palette.bold}${heading}${palette.reset}${' '.repeat(gap)}${palette.dim}${summary}${palette.reset} ${side}`);
  lines.push(bar(glyphs.bl, glyphs.br));
  return lines;
}

// --- the choice grammar ---------------------------------------------------------------------------------------------

export interface Choice {
  action: 'resume' | 'new' | 'retire' | 'folders' | 'settings' | 'create' | 'basic-memory' | 'help' | 'browse' | 'switch' | 'upgrade' | 'quit' | 'reprompt' | 'invalid' | 'out-of-range';
  index: number;
  reason: string;
}

/**
 * What one typed line means. EVERY REFUSAL HAS ITS OWN REASON, because they need different next moves. Case does not
 * matter: `N1` and `Q` are a person typing, not a rule about stored state.
 */
export function resolveChoice(typed: string, rowCount: number, updateReady = false): Choice {
  const text = typed.trim();
  if (!text) return { action: 'reprompt', index: 0, reason: 'nothing was typed' };
  // `u` ONLY WHILE THE UPDATE LINE SHOWS (D2), and the invalid-key text names it only then.
  if (updateReady && /^u$/i.test(text)) return { action: 'upgrade', index: 0, reason: '' };
  if (/^q(uit)?$/i.test(text)) return { action: 'quit', index: 0, reason: '' };
  if (text === '+') return { action: 'create', index: 0, reason: '' };
  if (/^b$/i.test(text)) return { action: 'basic-memory', index: 0, reason: '' };
  if (/^h$/i.test(text)) return { action: 'help', index: 0, reason: '' };
  if (/^l$/i.test(text)) return { action: 'browse', index: 0, reason: '' };
  if (/^a$/i.test(text)) return { action: 'switch', index: 0, reason: '' };
  let action: Choice['action'] = 'resume';
  let digits = text;
  if (/^n\s*\d+$/i.test(text)) {
    action = 'new';
    digits = text.substring(1).trim();
  } else if (/^r\s*\d+$/i.test(text)) {
    action = 'retire';
    digits = text.substring(1).trim();
  } else if (/^f\s*\d+$/i.test(text)) {
    action = 'folders';
    digits = text.substring(1).trim();
  } else if (/^s\s*\d+$/i.test(text)) {
    action = 'settings';
    digits = text.substring(1).trim();
  } else if (!/^\d+$/.test(text)) {
    return { action: 'invalid', index: 0, reason: `'${text}' is not one of the commands: a number, n<number>, r<number>, f<number>, s<number>, +, h, l, b${updateReady ? ', u' : ''} or q` };
  }
  const number = Number(digits);
  if (rowCount <= 0) return { action: 'invalid', index: 0, reason: 'no seat exists in this Library yet, so no number applies; type + to create one' };
  if (!Number.isInteger(number) || number < 1 || number > rowCount) return { action: 'out-of-range', index: 0, reason: `there is no seat ${digits}; the list offers 1 to ${rowCount}` };
  return { action, index: number, reason: '' };
}

// --- the menu -------------------------------------------------------------------------------------------------------

export interface MenuOptions {
  explicit?: string;
  cwd: string;
  registryRoot?: string;
  width?: number;
  plain?: boolean;
  transcriptRoot?: string;
  assistant?: Assistant;
}

interface MenuState {
  workspace: string;
  talk: Talk;
  options: MenuOptions;
  claude: boolean;
  codex: boolean;
  assistant: Assistant | null;
  /** The install this program runs from, for the update line (D2); null from a checkout. */
  installRoot: string | null;
  /** The running program's version. */
  running: string;
  /** Whether the update line has been shown in this menu. */
  updateShown: boolean;
}

/** The assistants on this machine, found as `seat start` finds them (PATH, then ~/.local/bin), and the one to use. */
function assistants(preferred?: Assistant): { claude: boolean; codex: boolean; assistant: Assistant | null } {
  const claude = findAssistant('claude') !== null;
  const codex = findAssistant('codex') !== null;
  const assistant = preferred && (preferred === 'claude' ? claude : codex) ? preferred : claude ? 'claude' : codex ? 'codex' : null;
  return { claude, codex, assistant };
}

const NO_ASSISTANT = 'No assistant found. Install Claude Code or Codex to start a seat.';

/**
 * Bare `deskpost`: the Library's seats, and a choice. Returns the exit code: the agent's, once one was started and has
 * ended, or 0 when the reader quit. The agent's session ends the menu, as the PowerShell launcher's does.
 */
export async function runMenu(options: MenuOptions, talk: Talk): Promise<number> {
  let workspace: string | null;
  try {
    workspace = await resolveMenuLibrary(options, talk);
  } catch (error) {
    if (error instanceof MenuQuit) {
      talk.say(error.message);
      return 0;
    }
    throw error;
  }
  if (workspace === null) {
    talk.say(`No Library is set up on this machine yet. A Library is the folder where the Librarian keeps your Books.`);
    talk.say(`Make one with: ${COMMAND_NAME} setup <folder>   (in the folder you want, ${COMMAND_NAME} setup is enough)`);
    return 0;
  }
  const found = assistants(options.assistant);
  const installRoot = (() => {
    try {
      return installRootOf(programRoot());
    } catch {
      return null;
    }
  })();
  const state: MenuState = { workspace, talk, options, ...found, installRoot, running: String(releaseTuple()['plugin_version'] ?? ''), updateShown: false };
  // THE ONCE-A-DAY CHECK (D2; ADR-0068), in this process and never in the way: it starts before the first draw, waits
  // for nothing, gives up after 5 seconds, and is aborted when the menu returns, so `q` ends at once.
  const checking = new AbortController();
  const setting = updateCheckSetting();
  const person = !talk.scripted && interactive() && !(process.env['CI'] ?? '').trim();
  if (installRoot !== null && setting !== 'off' && !(process.env['LIBRARY_SEAT'] ?? '').trim() && (setting === 'forced' || (person && updateCheckDue(installRoot)))) {
    const timer = setTimeout(() => checking.abort(), 5000);
    timer.unref?.();
    recordUpdateCheck(installRoot, checking.signal)
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }
  try {
    state.options.plain = options.plain || !interactive() || plainRequired(options.width ?? process.stdout.columns ?? 60, process.stdout.rows ?? 30);
    return await screenMenuLoop(state);
  } catch (error) {
    if (error instanceof MenuQuit) {
      talk.say(error.message);
      return 0;
    }
    throw error;
  } finally {
    checking.abort();
  }
}

/**
 * `u` (D2): the upgrade runs in this terminal from the release the check read, so a fixture's record can point it at a
 * local folder. The menu is an ancestor, so the wait does not count it, and no seat it launched is running. On success a
 * person gets the new program's menu with this one's options; a scripted menu is told to start it again.
 */
async function upgradeFromMenu(state: MenuState): Promise<number | null> {
  const { talk } = state;
  const record = state.installRoot === null ? null : readUpdateRecord(state.installRoot);
  if (state.installRoot === null || record === null) {
    talk.say('No newer Deskpost is on record here. Run `deskpost upgrade --check` to look.');
    return null;
  }
  const result = await upgradeVerb(['--release', record.release, ...(talk.scripted ? ['--yes'] : [])]);
  if (result.refusal !== null) {
    talk.say(result.refusal);
    return null;
  }
  const now = installedVersion(state.installRoot);
  if (result.exitCode !== 0 || now === null || now === state.running) {
    talk.say(result.exitCode === 0 ? 'Nothing was upgraded.' : `The upgrade did not finish (exit ${result.exitCode}); what it said is above.`);
    return null;
  }
  if (talk.scripted) {
    talk.say(`Upgraded to ${now}; run \`${COMMAND_NAME}\` again.`);
    return 0;
  }
  const options = state.options;
  const forwarded = [
    ...(options.explicit ? ['--workspace', options.explicit] : []),
    ...(options.registryRoot ? ['--registry-root', options.registryRoot] : []),
    ...(options.transcriptRoot ? ['--transcript-root', options.transcriptRoot] : []),
    ...(options.width !== undefined ? ['--width', String(options.width)] : []),
    ...(options.plain ? ['--plain'] : []),
    ...(options.assistant ? ['--assistant', options.assistant] : []),
  ];
  const exe = path.join(state.installRoot, 'current', 'bin', process.platform === 'win32' ? 'library.exe' : 'library');
  const started = spawnSync(exe, ['menu', ...forwarded], { stdio: 'inherit', windowsHide: false });
  return started.status ?? 1;
}

/** The update line, when the record says a newer version is ready and this menu has not shown it yet. */
function updateLineDue(state: MenuState): string | null {
  if (state.updateShown) return null;
  const latest = readyVersion(state.installRoot, state.running);
  if (latest === null) return null;
  state.updateShown = true;
  return updateLineText(latest, state.running);
}

/** Whether a seat can be sat at now. An OCCUPIED seat says who holds it and offers another, never a second session. */
function occupied(row: MenuRow): string | null {
  if (row.state === 'held') return `Seat '${row.seat}' is in use: a live session holds it${row.agent_pid ? ` (agent process ${row.agent_pid})` : ''}. One session per seat: pick another seat, or + for a new one.`;
  if (row.state === 'orphaned') return `Seat '${row.seat}' is bound to agent process ${row.agent_pid}, which is still running though its claim holder is gone. Re-bind it from that conversation, or pick another seat.`;
  if (row.state === 'unreadable') return `Seat '${row.seat}' could not be read: ${row.state_note}`;
  return null;
}

/** A number resumes that seat's last conversation, in the assistant that owns it; `n<number>` starts a new one. */
async function sitDown(state: MenuState, row: MenuRow, action: 'resume' | 'new'): Promise<number | null> {
  const { talk } = state;
  // A reader can change settings while the menu waits for input. Its drawn row is only a preview.
  row = menuRows(state.workspace, { transcriptRoot: state.options.transcriptRoot, fallbackAssistant: state.assistant ?? undefined })
    .find(current => current.seat === row.seat) ?? row;
  const refusal = occupied(row);
  if (refusal) {
    talk.say(refusal);
    return null;
  }
  if (row.launchAssistant) {
  const chosen = row.launchAssistant;
  if (!(chosen === 'claude' ? state.claude : state.codex)) {
    talk.say("Seat " + row.seat + ' is set to ' + ASSISTANT_LABEL[chosen] + ', which is not found here; change it with s' + row.index + '.'); return null;
  }
  if (action === 'resume' && row.view.entry_action === 'restart' && row.view.assistant === chosen) talk.say('Conversation ' + row.view.session_id + ' started at this seat and recorded nothing, so it is being started rather than resumed.');
  if (action === 'new' && row.view.session_id && row.view.assistant !== chosen) talk.say('This starts a new ' + ASSISTANT_LABEL[chosen] + ' conversation; the last one stays resumable there.');
  try {
    const outcome = await startSeat([row.seat, '--workspace', state.workspace, '--intent', action,
      '--fallback-assistant', state.assistant ?? chosen,
      ...(state.options.transcriptRoot ? ['--transcript-root', state.options.transcriptRoot] : [])], { human: true });
    return outcome.exitCode;
  } catch (error) { talk.say((error as Error).message); return null; }
  }
  const view = row.view;
  if (action === 'resume') {
    if (!view.session_id || view.entry_action === 'none') {
      talk.say(`Seat '${row.seat}' has no conversation on record, so there is nothing to resume. Type n${row.index} to start a new conversation there.`);
      return null;
    }
    const owner = view.assistant;
    if (!(owner === 'claude' ? state.claude : state.codex)) {
      const other = state.assistant ? ` Type n${row.index} for a new ${ASSISTANT_LABEL[state.assistant]} conversation instead.` : '';
      talk.say(`Seat '${row.seat}''s last conversation is ${ASSISTANT_LABEL[owner]}'s, and ${ASSISTANT_LABEL[owner]} is not found here, so it cannot be resumed.${other}`);
      return null;
    }
    if (view.entry_action === 'restart') {
      talk.say(`Conversation ${view.session_id} started at seat '${row.seat}' and recorded nothing, so it is being started rather than resumed. Nothing is lost: there is nothing in it.`);
      return launch(state, [row.seat, '--session-id', view.session_id], owner);
    }
    return launch(state, [row.seat, '--resume', view.session_id], owner);
  }
  if (state.assistant === null) {
    talk.say(NO_ASSISTANT);
    return null;
  }
  // AN ID IS NEVER HANDED TO THE OTHER ASSISTANT: choosing it at a seat starts a new conversation, said as such.
  if (view.session_id && view.assistant !== state.assistant) {
    talk.say(`This starts a new ${ASSISTANT_LABEL[state.assistant]} conversation; the last one at '${row.seat}' was ${ASSISTANT_LABEL[view.assistant]}'s, and stays resumable there.`);
  }
  return launch(state, state.assistant === 'claude' ? [row.seat, '--session-id', newConversationId()] : [row.seat], state.assistant);
}

/** THE ONE LAUNCH PATH: `seat start`, in process. Its refusals are said and the menu goes on; its exit code ends it. */
async function launch(state: MenuState, args: string[], assistant: Assistant, passthrough: string[] = []): Promise<number | null> {
  try {
    const outcome = await startSeat([...args, '--workspace', state.workspace, '--command', assistant, ...(passthrough.length ? ['--', ...passthrough] : [])], { human: true });
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof SeatPlanChanged) throw error;
    state.talk.say((error as Error).message);
    return null;
  }
}

// --- the new-seat wizard --------------------------------------------------------------------------------------------

/** A slug from what the reader typed: lowercase, and every run of anything else one hyphen. '' when none can be made. */
export function slugFrom(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * `+`, or the whole menu the first time: a Project named, a seat named after it, one preview and one confirmation.
 * THE CONFIRMATION IS BOUND TO WHAT IT PREVIEWS (confirmation round, #3): it carries the seat-creation plan_id, and
 * `seat start --plan-id` revalidates it under the registry lock; anything changed meanwhile re-previews rather than
 * committing. Cancelling writes nothing. Returns the agent's exit code once one ran, or null to go back to the list.
 */
async function wizard(state: MenuState, first: boolean): Promise<number | null> {
  const { talk, workspace } = state;
  if (first) talk.say(`\n  Library  ${workspace}`);
  talk.say(first ? '\nYour first seat. A seat is a place to work, with its own Desk and one Project.' : '\nA new seat. It is named after its Project.');
  let projects: string[];
  try {
    projects = activeProjects(workspace);
  } catch (error) {
    talk.say((error as Error).message);
    return null;
  }
  for (;;) {
    const typed = await talk.ask('Name your project (empty to cancel) › ');
    if (!typed) {
      talk.say('No seat was created: nothing was typed.');
      return first ? 0 : null;
    }
    const slug = slugFrom(typed);
    if (!slug) {
      talk.say('That name has no letters or digits to make a Project name from; try another.');
      continue;
    }
    const title = typed.trim() === slug ? slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.substring(1)).join(' ') : typed.trim();
    const rows = seatRegistryRows(workspace);
    const bound = rows.find((row) => String(row['project']) === slug);
    if (bound) {
      talk.say(`Project '${slug}' already has a seat, '${String(bound['seat'])}'. Pick it from the list, or name another project.`);
      if (!first) return null;
      continue;
    }
    // THE SEAT IS NAMED AFTER THE PROJECT (round 2, #8); a colliding name is offered `<slug>-2`, never taken over.
    let seat = slug;
    const withHub = projects.includes(slug) ? projects : [...projects, slug];
    let verdict = newSeatVerdict(workspace, seat, slug, withHub, true);
    if (!verdict.creatable || resolveSeatName({ seat, stateDirectory: path.join(workspace, '.claude') }).status !== 'named') {
      let next = 2;
      while (!newSeatVerdict(workspace, `${slug}-${next}`, slug, withHub, true).creatable && next < 20) next += 1;
      const answer = (await talk.ask(`A seat cannot be named '${slug}' (${verdict.reason || 'that name is not usable'}). Use '${slug}-${next}'? [Enter] yes   [n] name the project again › `)).toLowerCase();
      if (answer === 'n') continue;
      seat = `${slug}-${next}`;
    }
    // THE NEW STEPS (S97 row 2, PLAN-seats-team.md session 2 item 1): template, department, card, Shelf Books. Each has
    // an [Enter] default, so the blank path stays a run of Enters.
    const chosen = await seatChoices(state, seat, slug, withHub);
    const choices = chosen.choices;
    seat = chosen.seat;
    const result = await preview(state, { seat, slug, title, projects, first, choices });
    if (result === 'again') continue;
    if (result === 'cancel') return first ? 0 : null;
    return result;
  }
}

/** The wizard's template keys, in the order it shows them (kickoffs/s110 ruling 10). */
export const WIZARD_TEMPLATE_KEYS: readonly (readonly [string, string])[] = [
  ['p', 'performer'],
  ['o', 'orchestrator'],
  ['l', 'planner'],
  ['b', 'builder'],
  ['a', 'auditor'],
];

/** What each template is for, one line each on the full-screen wizard's Template screen (kickoffs/s166 row 4). */
const WIZARD_TEMPLATE_WORDS: Record<string, string> = {
  performer: 'works its own lane in the department',
  orchestrator: 'orders the work and writes Kickoffs',
  planner: 'answers design questions for the reader',
  builder: 'builds one approved Kickoff at a time',
  auditor: 'audits read only; findings by letter',
};

/**
 * THE DEPARTMENT IS CHOSEN FROM A LIST (kickoffs/s166 row 4, Eric's option A): each department the registry knows, with
 * where its letters go, then "New department" and "No department". Typing narrows the list by its start and offers to
 * make a department of what was typed; the name is still checked by `departmentProblem` before it is used.
 */
export function departmentScreen(departments: readonly { name: string; destination: DepartmentDestination }[], text = ''): ScreenModel {
  const typed = text.trim();
  const shown = departments.filter((department) => department.name.startsWith(typed.toLowerCase()));
  const width = Math.max(0, ...shown.map((department) => department.name.length));
  const items = shown.map((department) => ({ id: 'department:' + department.name, text: department.name.padEnd(width) + '   ' +
    (department.destination.kind === 'none' ? 'no orchestrator yet' : 'letters go to ' + department.destination.seat) }));
  if (typed && !departments.some((department) => department.name === typed)) items.push({ id: 'create:' + typed, text: 'Make a new department called ' + typed });
  if (!typed) items.push({ id: 'new', text: 'New department' }, { id: 'none', text: 'No department' });
  return { title: 'Department', search: true, items };
}

/** The job a template gives the proposed seat name; performer and builder both propose `<department>-dev`. */
const WIZARD_JOBS: Record<string, string> = { performer: 'dev', orchestrator: 'lead', planner: 'plan', builder: 'dev', auditor: 'audit' };

/** Where a department's letters go, in the wizard's words. */
function destinationWords(destination: DepartmentDestination): string {
  if (destination.kind === 'orchestrator') return `letters go to its orchestrator, ${destination.seat}`;
  if (destination.kind === 'only-seat') return `letters go to its only seat, ${destination.seat}`;
  return 'no orchestrator yet, so letters to it are refused';
}

/**
 * THE WIZARD'S FOUR STEPS AFTER THE PROJECT NAME (S97 row 2, PLAN-seats-team.md session 2 item 1). The template gives
 * the role; a department is a slug, existing ones listed and a new one flagged; a performer is told its orchestrator; an
 * orchestrator is refused where its department has one, with the route; a role with no department is refused, and a
 * second [Enter] there drops the template. The card is one line; the Books are numbered from the Shelf catalog. Every
 * value is checked here as `seat start` checks it, and the preview runs the one planner again over all of them.
 */
/** A NEW SEAT STARTS WITH ITS LETTERS OPEN (kickoffs/s146 row 5) when this Library has a `letters` Book on its Shelf. */
function newSeatBooks(workspace: string): string[] {
  return fs.existsSync(path.join(workspace, 'shelf', 'letters', 'wiki')) ? ['letters'] : [];
}

async function seatChoices(state: MenuState, projectSeat: string, slug: string, withHub: string[]): Promise<{ choices: SeatStartChoices; seat: string }> {
  const { talk, workspace } = state;
  const rows = seatRegistryRows(workspace);
  const choices: SeatStartChoices = { openBooks: newSeatBooks(workspace) };
  let seat = projectSeat;

  // DEPARTMENT FIRST (kickoffs/s110 ruling 10), each existing one with where its letters go (ADR-0073).
  const projection = seatMetadata(rows);
  const departments = registryDepartments(rows);
  talk.say(
    departments.length
      ? `  Departments: ${departments.map((name) => `${name} (${destinationWords(destinationOf(projection, name))})`).join(', ')}.`
      : '  No seat has a department yet.',
  );
  for (;;) {
    const typed = await talk.ask('Department, a slug   [Enter] none › ');
    if (!typed) break;
    const problem = departmentProblem(typed);
    if (problem) {
      talk.say(`'${typed}' is not a department name: ${problem}.`);
      continue;
    }
    if (!departments.includes(typed)) talk.say(`  '${typed}' is a new department.`);
    choices.department = typed;
    break;
  }

  // THEN THE TEMPLATE, only with a department: a template gives a role, and a role requires a department. THE ROLE COMES
  // FROM THE LOADED TEMPLATE (ruling 10), never from the key: the plan reads it from `choices.template`.
  if (choices.department === undefined) {
    talk.say('  No department, so no template and no role: the seat is made without them.');
  } else {
    const department = choices.department;
    for (;;) {
      const key = (await talk.ask(`Template   ${WIZARD_TEMPLATE_KEYS.map(([letter, name]) => `[${letter}] ${name}`).join('  ')}  [Enter] none › `)).toLowerCase();
      if (key === '') break;
      const name = WIZARD_TEMPLATE_KEYS.find(([letter]) => letter === key)?.[1];
      if (name === undefined) {
        talk.say(`'${key}' is not one of the keys above.`);
        continue;
      }
      let template: SeatTemplate;
      try {
        template = loadSeatTemplate(programRoot(), name);
      } catch (error) {
        talk.say((error as Error).message);
        continue;
      }
      const orchestrator = departmentOrchestrator(rows, department);
      if (template.role === 'orchestrator' && orchestrator !== null) {
        talk.say(
          `Department '${department}' already has an orchestrator, '${orchestrator}', and a department has one. Create this seat as a performer, ` +
            `then hand the role over with ${COMMAND_NAME} seat describe <seat> --role orchestrator --from ${orchestrator}. Choose another template.`,
        );
        continue;
      }
      if (template.role === 'performer') {
        const destination = destinationOf(projection, department);
        talk.say(destination.seat !== null ? `  Letters to department '${department}' go to '${destination.seat}' (${destination.kind === 'orchestrator' ? 'its orchestrator' : 'its only seat'}).` : `  Department '${department}' has no orchestrator yet.`);
      }
      choices.template = name;
      break;
    }

    // THEN THE NAME, proposed as <department>-<job> (ruling 10): editable, checked as every creator checks it, and a
    // collision offered the next suffix, never taken over.
    const job = WIZARD_JOBS[choices.template ?? ''] ?? 'dev';
    const base = `${department}-${job}`;
    let proposed = base;
    for (let next = 2; !newSeatVerdict(workspace, proposed, slug, withHub, true).creatable && next < 20; next += 1) proposed = `${base}-${next}`;
    for (;;) {
      const typed = (await talk.ask(`Seat name   [Enter] ${proposed} › `)).trim().toLowerCase();
      const name = typed || proposed;
      const verdict = newSeatVerdict(workspace, name, slug, withHub, true);
      if (!verdict.creatable) {
        talk.say(`A seat cannot be named '${name}': ${verdict.reason || 'that name is not usable'}.`);
        continue;
      }
      seat = name;
      break;
    }
  }
  // CARD.
  for (;;) {
    const typed = await talk.ask('Card, one line on what this seat handles   [Enter] no card › ');
    if (!typed) break;
    const problem = cardProblem(typed);
    if (problem) {
      talk.say(`That card is refused: ${problem}.`);
      continue;
    }
    choices.card = typed;
    break;
  }

  // SHELF BOOKS, by number from the Shelf catalog; a Shelf with none skips the step.
  let books: string[] = [];
  try {
    books = shelfCatalogEntryInventory(workspace)
      .entries.filter((entry) => fs.existsSync(path.join(workspace, 'shelf', entry.slug, 'wiki')))
      .map((entry) => entry.slug);
  } catch (error) {
    talk.say(`The Shelf could not be listed, so no Book is opened: ${(error as Error).message}`);
  }
  if (books.length) {
    talk.say('  Shelf Books:');
    books.forEach((slug, index) => talk.say(`  ${String(index + 1).padStart(3)}  ${slug}`));
    for (;;) {
      const typed = await talk.ask(`Books to open at the first launch, by number (such as 1 3)   [Enter] ${choices.openBooks.length ? choices.openBooks.join(' ') : 'none'} › `);
      if (!typed) break;
      const numbers = typed.split(/[\s,]+/).filter((part) => part.length > 0);
      const bad = numbers.filter((part) => !/^\d+$/.test(part) || Number(part) < 1 || Number(part) > books.length);
      if (bad.length) {
        talk.say(`${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not ${books.length === 1 ? 'the number 1' : `a number from 1 to ${books.length}`}.`);
        continue;
      }
      choices.openBooks = [...new Set(numbers.map((part) => books[Number(part) - 1]!))];
      break;
    }
  }
  return { choices, seat };
}

/** One argument as the preview prints it: quoted when it holds a space. */
function shown(argument: string): string {
  return /\s/.test(argument) ? `"${argument}"` : argument;
}

/**
 * A FAULT FOR THE SELF-TEST ONLY: when `LIBRARY_MENU_TOUCH_REGISTRY` names a file that exists, the file is removed and
 * the first registry row gains a card, between the preview's [Enter] and `seat start`: a metadata-only change, which the
 * wrapped plan id must catch. A real run never sets it.
 */
function touchRegistryForSelfTest(workspace: string): void {
  const flag = (process.env['LIBRARY_MENU_TOUCH_REGISTRY'] ?? '').trim();
  if (!flag || !fs.existsSync(flag)) return;
  fs.rmSync(flag);
  const stateDirectory = path.join(workspace, '.claude');
  const lock = enterSeatRegistryLock(workspace, 5);
  try {
    const rows = readRegistryRows(registryFilePath(stateDirectory));
    if (rows.length) writeSeatRegistry(stateDirectory, [{ ...rows[0]!, card: 'Changed while the preview was open.' }, ...rows.slice(1)]);
  } finally {
    exitBookLock(lock);
  }
}

async function preview(
  state: MenuState,
  plan: { seat: string; slug: string; title: string; projects: string[]; first: boolean; choices: SeatStartChoices },
): Promise<number | 'again' | 'cancel'> {
  const { talk, workspace } = state;
  let projects = plan.projects;
  // RINGS REACH A NEW CLAUDE CODE SEAT AT ONCE UNLESS THE READER SAYS NO (kickoffs/s108 ruling 6): asked once, in the
  // preview, default yes; `[m]` turns it off. Never for Codex, which has no inbox.
  let acceptRings = true;
  for (;;) {
    const hubExists = projects.includes(plan.slug);
    const choices: SeatStartChoices = { ...plan.choices, recordAssistant: state.assistant ?? undefined, inbound: state.assistant === 'claude' && acceptRings ? 'accept' : undefined };
    const verdict = newSeatVerdict(workspace, plan.seat, plan.slug, hubExists ? projects : [...projects, plan.slug], false, choices);
    if (!verdict.creatable) {
      talk.say(verdict.reason);
      return 'again';
    }
    const planned = verdict.plan!;
    const local = String((readMarker(workspace) ?? {})['backend'] ?? '') === 'local';
    talk.say('');
    talk.say(`Create seat '${plan.seat}' for Project '${plan.slug}'.`);
    talk.say(`  Hub        projects/${plan.slug}${hubExists ? ': Hub reused, its Purpose kept' : `, titled "${plan.title}" (new)`}`);
    if (!hubExists && planned.purpose !== null) talk.say(`  Purpose    ${planned.purpose}`);
    talk.say(`  Department ${planned.department === null ? 'none' : `${planned.department}${planned.createsDepartment ? ' (new)' : ''}`}`);
    talk.say(`  Role       ${planned.role ?? 'none'}`);
    talk.say(`  Card       ${planned.card ?? 'none'}`);
    talk.say(`  Template   ${planned.templateId ?? 'none'}`);
    talk.say(`  Books      ${planned.books.length ? planned.books.map((slug) => `shelf/${slug}`).join(', ') : 'none'}`);
    if (state.assistant === 'claude') {
      talk.say(`  Messages   ${acceptRings ? "other seats' rings reach it at once (inbound accept)" : 'Claude Code decides (inbound unset): a seat that skips permission prompts holds each ring for you'}`);
    }
    talk.say(`  Desk       ${deskStateDirectory(path.join(workspace, '.claude'), plan.seat)}, with projects/${plan.slug} open`);
    talk.say(`  Librarian  ${state.assistant ? ASSISTANT_LABEL[state.assistant] : 'none found: the seat is made, and nothing is started'}`);
    talk.say(`  Touches    ${hubExists || local ? 'this Library only; no other seat' : 'the SHARED collection, for the Hub; no other seat'}`);
    talk.say(`  plan_id    ${verdict.plan_id}`);
    const firstStart = plan.first ? firstStartLine(state.assistant) : null;
    if (firstStart) talk.say(`  ${firstStart}`);
    const keys = [
      '[Enter] create it and start',
      ...(state.claude && state.codex ? [`[a] use ${ASSISTANT_LABEL[state.assistant === 'claude' ? 'codex' : 'claude']}`] : []),
      ...(state.assistant === 'claude' ? [acceptRings ? '[m] hold rings instead' : '[m] accept rings'] : []),
      '[q] cancel',
    ];
    const key = (await talk.ask(keys.join('   ') + ' › ')).toLowerCase();
    if (key === 'm' && state.assistant === 'claude') {
      acceptRings = !acceptRings;
      continue;
    }
    if (key === 'a' && state.claude && state.codex) {
      state.assistant = state.assistant === 'claude' ? 'codex' : 'claude';
      continue;
    }
    if (key === 'q') {
      talk.say('No seat was created.');
      return 'cancel';
    }
    if (key !== '') {
      talk.say(`'${key}' is not one of the keys above.`);
      continue;
    }
    if (!hubExists) {
      // A TEMPLATE'S FILLED PURPOSE IS THE NEW HUB'S (S97 row 2); an existing Hub is reused and not written.
      const purpose = planned.purpose !== null ? ['--purpose', planned.purpose] : [];
      talk.say(`  ${COMMAND_NAME} hub new ${plan.slug} --title "${plan.title}"${purpose.length ? ` --purpose <the ${planned.templateId} Purpose above>` : ''}`);
      const made = await runHubVerb(['new', plan.slug, '--title', plan.title, ...purpose, '--workspace', workspace], workspace);
      if (made.refusal !== null) {
        // A HUB THAT APPEARED WHILE THE PREVIEW WAS OPEN IS SHOWN AGAIN, as reused, rather than committed past.
        talk.say(made.refusal);
        try {
          projects = activeProjects(workspace);
        } catch (error) {
          talk.say((error as Error).message);
          return 'cancel';
        }
        if (projects.includes(plan.slug)) continue;
        return 'cancel';
      }
      projects = [...projects, plan.slug];
    }
    const args = [plan.seat, '--project', plan.slug, '--plan-id', verdict.plan_id, ...seatStartChoiceArguments(choices)];
    talk.say(`  ${COMMAND_NAME} seat start ${args.map(shown).join(' ')}`);
    touchRegistryForSelfTest(workspace);
    if (state.assistant === null) {
      try {
        await startSeat([...args, '--workspace', workspace, '--no-launch']);
        talk.say(`Seat '${plan.seat}' is ready. ${NO_ASSISTANT}`);
        return 0;
      } catch (error) {
        if (error instanceof SeatPlanChanged) {
          talk.say(error.message);
          continue;
        }
        talk.say((error as Error).message);
        return 'cancel';
      }
    }
    try {
      const conversation = state.assistant === 'claude' ? ['--session-id', newConversationId()] : [];
      const outcome = await startSeat([...args, ...conversation, '--workspace', workspace, '--command', state.assistant], { human: true });
      return outcome.exitCode;
    } catch (error) {
      if (error instanceof SeatPlanChanged) {
        talk.say(error.message);
        continue;
      }
      talk.say((error as Error).message);
      return 'cancel';
    }
  }
}

// --- r<number>, and b ---------------------------------------------------------------------------------------------

/** `r<number>`: `seat retire`'s own preflight, shown, then its own approval, bound to its plan_id. */
async function retire(state: MenuState, row: MenuRow): Promise<void> {
  const { talk, workspace } = state;
  let plan: Record<string, PsJsonValue>;
  try {
    plan = retireSeat([row.seat, '--workspace', workspace, '--preflight']);
  } catch (error) {
    talk.say(`Seat '${row.seat}' was not retired: ${(error as Error).message}`);
    return;
  }
  const list = (value: PsJsonValue | undefined) => (Array.isArray(value) && value.length ? value.join(', ') : '(none)');
  talk.say('');
  talk.say(`Retire seat '${row.seat}' (Project ${String(plan['project'])}).`);
  talk.say(`  Open Books     ${list(plan['open_books'])}`);
  talk.say(`  Open Projects  ${list(plan['open_projects'])}`);
  talk.say(`  Archived to    ${String(plan['archive_destination'])}`);
  talk.say(`  plan_id        ${String(plan['plan_id'])}`);
  talk.say('  The Desk is the only durable record of what was open, so it is archived rather than discarded.');
  const answer = await talk.ask(`Type yes to retire '${row.seat}' › `);
  if (answer !== 'yes') {
    talk.say(`Seat '${row.seat}' was not retired: the confirmation was '${answer}' rather than yes.`);
    return;
  }
  try {
    const done = retireSeat([row.seat, '--workspace', workspace, '--plan-id', String(plan['plan_id'])]);
    talk.say(`Seat '${row.seat}' retired. Its Desk is at ${String(done['archive_directory'])}.`);
  } catch (error) {
    talk.say(`Seat '${row.seat}' was not retired: ${(error as Error).message}`);
  }
}

/**
 * `f<number>`: the seat's added folders (1.2.5, ADR-0061). Lists them, and offers add, remove or back. A change is
 * validated and its launch line shown BEFORE anything is saved, and saved only on a y. The same code as `seat dirs`
 * (`planSeatDirs` to preview, `changeSeatDirs` to save), never a second implementation; a refusal is said and the
 * menu goes on.
 */
async function folders(state: MenuState, row: MenuRow): Promise<void> {
  const { talk, workspace } = state;
  const stateDirectory = path.join(workspace, '.claude');
  for (;;) {
    let current: string[];
    try {
      current = planSeatDirs({ workspace, seat: row.seat }).dirs;
    } catch (error) {
      talk.say(`Seat '${row.seat}''s folders could not be read: ${(error as Error).message}`);
      return;
    }
    talk.say('');
    talk.say(`Seat '${row.seat}' is started with ${current.length ? 'these added folders:' : 'no added folders.'}`);
    current.forEach((dir, position) => talk.say(`  ${String(position + 1).padStart(2)}  ${dir}`));
    const key = (await talk.ask('[a] add a folder   [r] remove one   [Enter] back › ')).toLowerCase();
    if (!key) return;
    if (key !== 'a' && key !== 'r') {
      talk.say(`'${key}' is not one of the keys above.`);
      continue;
    }
    const typed = await talk.ask(key === 'a' ? 'Folder to add, in full (empty to go back) › ' : 'Folder to remove, by number or in full (empty to go back) › ');
    if (!typed) continue;
    const change = key === 'a' ? { add: typed } : { remove: /^\d+$/.test(typed) && current[Number(typed) - 1] !== undefined ? current[Number(typed) - 1]! : typed };
    let plan: ReturnType<typeof planSeatDirs>;
    try {
      plan = planSeatDirs({ workspace, seat: row.seat, ...change });
    } catch (error) {
      talk.say((error as Error).message);
      continue;
    }
    talk.say(`  Launch line  ${launchLine(stateDirectory, row.seat, plan.dirs)}`);
    const answer = (await talk.ask('Save this? [y/N] › ')).toLowerCase();
    if (answer !== 'y') {
      talk.say(`Nothing was saved: the answer was '${answer}' rather than y.`);
      continue;
    }
    try {
      talk.say(seatDirsSentence(changeSeatDirs({ workspace, seat: row.seat, ...change })));
      row.folders = plan.dirs.length;
    } catch (error) {
      talk.say((error as Error).message);
    }
  }
}

/**
 * `b`, A RESERVED SLOT (step 5a). In 1.1 it says what Basic Memory is for, or, with one set up, which server; everything
 * behind it -- import, copying out, opening shared, the set-up conversation -- is its own plan.
 */
/**
 * `l`: WHAT THE LIBRARY HOLDS, as `deskpost browse` lists it (PLAN-correct-and-find.md D5). Under the list, words filter it by
 * title, slug, summary and topics; a number shows that entry's catalog text, page count and the line that opens it from a
 * seat; Enter returns to the menu. Line by line like the menu, no raw mode and no pager. It opens nothing, starts no agent,
 * claims no seat and writes nothing.
 */
async function browse(state: MenuState): Promise<void> {
  const data = browseData(state.workspace, false);
  const all = browseEntries(data);
  for (const line of browseLines(data)) state.talk.say(line);
  for (;;) {
    state.talk.say('Words filter the list; a number shows one entry; Enter goes back to the menu.');
    const typed = (await state.talk.ask('Browse › ')).trim();
    if (!typed) return;
    if (/^\d+$/.test(typed)) {
      const entry = all[Number(typed) - 1];
      if (entry === undefined) state.talk.say(all.length ? `There is no entry ${typed}; the list offers 1 to ${all.length}.` : 'The list is empty, so no number applies.');
      else for (const line of browseEntryLines(entry)) state.talk.say(line);
      continue;
    }
    const shown = filterBrowse(all, typed);
    if (!shown.length) state.talk.say(`Nothing in the list matches '${typed}'.`);
    else for (const line of browseLines(data, 80, shown)) state.talk.say(line);
  }
}

async function basicMemory(state: MenuState): Promise<void> {
  const { talk, workspace } = state;
  const connection = markerConnection(workspace);
  if (connection === null) {
    talk.say('Basic Memory is optional: it shares your Books across machines.');
    const key = (await talk.ask('[s] Set up   [Enter] back › ')).toLowerCase();
    if (key === 's') {
      talk.say(`Set it up with: ${COMMAND_NAME} basic-memory setup --url <mcp-url> --collection <name> --preflight`);
      talk.say('It connects this Library to a Basic Memory server; nothing is written to Basic Memory in 1.1.');
    }
    return;
  }
  talk.say(`Basic Memory  ${connection.url}, collection ${connection.collection_name || connection.collection_id}`);
  talk.say(`  How it and this Library differ: ${COMMAND_NAME} basic-memory status`);
}

// --- the fork an install ends on (step 5) ---------------------------------------------------------------------------

export const HELP_SEAT = 'deskpost-help';
export const HELP_TITLE = 'Deskpost Help';
// A WELCOME, NOT AN ABSENCE (S56, finding 16): "Start the Deskpost tutorial" named a tutorial not yet written, so the
// Librarian's first words to a new reader were that it did not exist. Until the tutorial plan lands, the prompt asks
// for a tour and the Hub says what the tour covers.
const HELP_PURPOSE =
  'Deskpost Help is where the Librarian shows you around. A first tour covers: the Library and its seats (the main menu, ' +
  '`deskpost`); the Desk, and opening a Book or a Project; the Notebook, where working knowledge is kept; and the Holding ' +
  'Shelf, where anything saved for later goes. Ask the Librarian anything about Deskpost here, any time.';
export const HELP_PROMPT = 'Welcome me to Deskpost and show me around.';

/**
 * WHAT CLAUDE CODE ASKS ON ITS FIRST START IN A FOLDER (S56, finding 15): its folder trust (default highlighted "No,
 * exit") and then the Library's MCP server (default highlighted "all future MCP servers"). A reader met both before the
 * Librarian said a word, with nothing from Deskpost first. The line says what they are and which to pick; "may",
 * because a folder already trusted is not asked again.
 *
 * AND WHAT IT CAN DROP (S58, the Windows Sandbox run): Claude Code 2.1.283, after those two answers, restarted itself
 * as `claude --permission-mode auto`, without the launcher's --session-id or the tour prompt, so the first start opened
 * with nothing typed. A second start was not restarted. Until the cause is measured, the line says what to type.
 */
export const CLAUDE_FIRST_START =
  'The first time here, Claude Code may ask you to trust this folder and to use its validated-book-reader: choose ' +
  '"Yes, I trust this folder", then "Use this MCP server". If Claude then opens with nothing typed, type: show me around';
const CODEX_FIRST_START = 'Codex will ask you to trust this folder and approve its hooks on first start.';

function firstStartLine(assistant: Assistant | null): string | null {
  return assistant === 'claude' ? CLAUDE_FIRST_START : assistant === 'codex' ? CODEX_FIRST_START : null;
}

/**
 * The installer's last screen: show me around, the main menu, or later. The lock is long released and `pending`
 * cleared before this runs (install.ps1), so a conversation never holds either (round 2, #4).
 */
export async function runWelcome(options: { workspace: string; assistant?: Assistant; registryRoot?: string }, talk: Talk): Promise<number> {
  const workspace = requireWorkspace({ explicit: options.workspace });
  const found = assistants(options.assistant);
  const state: MenuState = { workspace, talk, options: { cwd: workspace, registryRoot: options.registryRoot }, ...found, installRoot: null, running: '', updateShown: false };
  if (!talk.scripted && interactive()) {
    state.options.plain = plainRequired(process.stdout.columns ?? 60, process.stdout.rows ?? 30);
    return screenMenuLoop(state);
  }
  talk.say('');
  if (state.assistant === null) {
    talk.say(`  [m]     Main menu        your seats; type \`${COMMAND_NAME}\` any time to come back here`);
    talk.say('  [q]     Later');
    talk.say(`  ${NO_ASSISTANT}`);
    const key = (await talk.ask('› ')).toLowerCase();
    return key === 'm' ? runMenu(state.options, talk) : 0;
  }
  talk.say(`  [Enter] Show me around   builds a ${HELP_SEAT} seat with the Librarian as your guide (recommended)`);
  talk.say(`  [m]     Main menu        your seats; type \`${COMMAND_NAME}\` any time to come back here`);
  talk.say('  [q]     Later');
  for (;;) {
    const key = (await talk.ask('› ')).toLowerCase();
    if (key === 'q') {
      talk.say(`Type \`${COMMAND_NAME}\` whenever you want your seats.`);
      return 0;
    }
    if (key === 'm') return runMenu(state.options, talk);
    if (key === '') return (await showMeAround(state)) ?? 0;
    talk.say(`'${key}' is not one of the keys above.`);
  }
}

/**
 * Show me around: the Deskpost Help Hub and a seat of the same name, reused when they exist, then the Librarian.
 * Returns the agent's exit code once one ran, or null when nothing was started (the menu goes on).
 *
 * MADE SAFE BEFORE IT IS MADE ROUTINE (PLAN-assistant-onboarding.md step 5; Codex #12). Until S57 any answer but `q`
 * went ahead, "no" included, and the Hub was created before an existing seat of that name was checked. Now: only Enter
 * or `y` goes; every check comes before anything is created; a new seat is created through the wizard's bound path
 * (its plan_id, revalidated by `seat start` under the registry lock); an existing seat resumes, and is given the tour
 * prompt only when its last conversation recorded nothing.
 */
export async function showMeAround(state: MenuState): Promise<number | null> {
  const { talk, workspace } = state;
  if (state.assistant === null) {
    talk.say(NO_ASSISTANT);
    return null;
  }
  let projects: string[];
  try {
    projects = activeProjects(workspace);
  } catch (error) {
    talk.say((error as Error).message);
    return null;
  }
  const hubExists = projects.includes(HELP_SEAT);
  const seatRow = seatRegistryRows(workspace).find((row) => String(row['seat']) === HELP_SEAT);
  // COMPATIBILITY FIRST: a seat of that name bound to another Project is never taken over, and nothing is created.
  if (seatRow && String(seatRow['project']) !== HELP_SEAT) {
    talk.say(`A seat named ${HELP_SEAT} already exists for Project '${String(seatRow['project'])}', so Show me around cannot use it. Nothing was created.`);
    return null;
  }
  const row = seatRow ? menuRows(workspace, { transcriptRoot: state.options.transcriptRoot, skipTitles: true }).find((candidate) => candidate.seat === HELP_SEAT) : undefined;
  if (row) {
    const refusal = occupied(row);
    if (refusal) {
      talk.say(refusal);
      return null;
    }
  }
  const verdict = seatRow ? null : newSeatVerdict(workspace, HELP_SEAT, HELP_SEAT, hubExists ? projects : [...projects, HELP_SEAT], false, { openBooks: [], recordAssistant: state.assistant });
  if (verdict !== null && !verdict.creatable) {
    talk.say(`${verdict.reason} Nothing was created.`);
    return null;
  }
  // AN EXISTING SEAT RESUMES; the tour prompt goes only to a conversation that recorded nothing, or a first one.
  // The help seat uses its own preference, just like numbered entries.
  const helpAssistant = row?.launchAssistant ?? state.assistant;
  if (row?.launchAssistant) {
    if (!(row.launchAssistant === 'claude' ? state.claude : state.codex)) { talk.say('Seat ' + HELP_SEAT + ' is set to ' + ASSISTANT_LABEL[row.launchAssistant] + ', which is not found here; change it with s' + row.index + '.'); return null; }
  }
  const view = row?.view;
  const resumable = view !== undefined && Boolean(view.session_id) && view.entry_action === 'resume' && view.assistant === helpAssistant;
  const local = String((readMarker(workspace) ?? {})['backend'] ?? '') === 'local';
  talk.say('');
  talk.say(`  Hub   projects/${HELP_SEAT}, "${HELP_TITLE}"${hubExists ? ' (it exists, and is reused)' : ' (new)'}`);
  talk.say(`  Seat  ${HELP_SEAT}${seatRow ? ' (it exists, and is reused)' : ' (new)'}`);
  if (!hubExists && !local) talk.say('  Touches  the SHARED collection, for the Hub (this Library reads Basic Memory)');
  talk.say(`  Then  ${ASSISTANT_LABEL[helpAssistant]} ${resumable ? 'resumes your last conversation there' : 'starts there, as your guide'}`);
  const firstStart = firstStartLine(helpAssistant);
  if (firstStart) talk.say(`        ${firstStart}`);
  const key = (await talk.ask('[Enter] go   [q] not now › ')).toLowerCase();
  if (key !== '' && key !== 'y') {
    talk.say(`Nothing was created. Type \`${COMMAND_NAME}\` whenever you want your seats.`);
    return null;
  }
  if (!hubExists) {
    talk.say(`  ${COMMAND_NAME} hub new ${HELP_SEAT} --title "${HELP_TITLE}"`);
    const made = await runHubVerb(['new', HELP_SEAT, '--title', HELP_TITLE, '--purpose', HELP_PURPOSE, '--workspace', workspace], workspace);
    if (made.refusal !== null && !activeProjects(workspace).includes(HELP_SEAT)) {
      talk.say(made.refusal);
      return null;
    }
  }
  let args: string[];
  let passthrough: string[] = [HELP_PROMPT];
  if (resumable) {
    args = [HELP_SEAT, '--resume', view!.session_id];
    passthrough = [];
  } else if (view !== undefined && view.session_id && view.entry_action === 'restart' && view.assistant === helpAssistant) {
    args = [HELP_SEAT, '--session-id', view.session_id];
  } else {
    args = seatRow ? [HELP_SEAT] : [HELP_SEAT, '--project', HELP_SEAT, '--plan-id', verdict!.plan_id, '--record-assistant', helpAssistant];
    if (helpAssistant === 'claude') args.push('--session-id', newConversationId());
  }
  talk.say(`  ${COMMAND_NAME} seat start ${args.join(' ')}`);
  try {
    return await launch(state, args, helpAssistant, passthrough);
  } catch (error) {
    if (error instanceof SeatPlanChanged) {
      talk.say(`${error.message} Nothing was started; choose Show me around again to see what changed.`);
      return null;
    }
    throw error;
  }
}

// --- the verbs ------------------------------------------------------------------------------------------------------

export interface MenuVerbResult {
  refusal: string | null;
  exitCode: number;
}

function readScript(file: string | undefined): string[] | null {
  if (file === undefined) return null;
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '');
}

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** The refusal a caller that cannot be asked gets: it names the command that makes the call deterministic, and the seats. */
function nonInteractiveRefusal(options: MenuOptions): string {
  let seats: string[] = [];
  try {
    const workspace = options.explicit?.trim() ? options.explicit : findWorkspaceByMarker(options.cwd);
    if (workspace) seats = seatRegistryRows(workspace).map((row) => String(row['seat'])).sort(psSortCompare);
  } catch {
    seats = [];
  }
  const known = seats.length ? `Seats here: ${seats.join(', ')}.` : 'No seat exists here yet.';
  return `The menu asks, and this caller cannot answer: stdin or stdout is not a terminal. Start a seat by name instead: ${COMMAND_NAME} seat start <name> [--project <slug>]. ${known}`;
}

/** `deskpost menu [--workspace <p>] [--registry-root <d>] [--width <n>] [--plain] [--transcript-root <d>] [--assistant <a>] [--script <file>]`. */
export async function runMenuVerb(argv: string[]): Promise<MenuVerbResult> {
  const parsed = parseArguments(argv, argumentTable('menu'));
  const options: MenuOptions = {
    explicit: parsed.options.get('workspace'),
    cwd: parsed.options.get('cwd') ?? process.cwd(),
    registryRoot: parsed.options.get('registry-root'),
    width: parsed.options.has('width') ? Number(parsed.options.get('width')) : undefined,
    plain: parsed.flags.has('plain'),
    transcriptRoot: parsed.options.get('transcript-root'),
    assistant: parsed.options.get('assistant') === 'codex' ? 'codex' : parsed.options.get('assistant') === 'claude' ? 'claude' : undefined,
  };
  try {
    const script = readScript(parsed.options.get('script'));
    if (script === null && !interactive()) {
      const workspace = options.explicit?.trim() ? requireWorkspace({ explicit: options.explicit }) : findWorkspaceByMarker(options.cwd);
      const rows = workspace ? menuRows(workspace, { skipTitles: true, fallbackAssistant: options.assistant }) : [];
      for (const line of plainSeatLines(rows, new Date(), options.assistant)) process.stdout.write(plainText(line) + '\n');
      return { refusal: nonInteractiveRefusal(options), exitCode: 1 };
    }
    return { refusal: null, exitCode: await runMenu(options, makeTalk(script)) };
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1 };
  }
}

/** `deskpost setup --welcome --workspace <Library> [--assistant <a>] [--script <file>]`: the fork install.ps1 ends on. */
export async function runWelcomeVerb(argv: string[]): Promise<MenuVerbResult> {
  const parsed = parseArguments(argv, argumentTable('setup'));
  const workspace = parsed.options.get('workspace');
  if (!workspace) return { refusal: 'setup --welcome needs --workspace <Library>.', exitCode: 1 };
  try {
    const script = readScript(parsed.options.get('script'));
    if (script === null && !interactive()) return { refusal: null, exitCode: 0 };
    const assistant = parsed.options.get('assistant') === 'codex' ? 'codex' : parsed.options.get('assistant') === 'claude' ? 'claude' : undefined;
    return { refusal: null, exitCode: await runWelcome({ workspace, assistant, registryRoot: parsed.options.get('registry-root') }, makeTalk(script)) };
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1 };
  }
}

/** Whether bare `deskpost` opens the menu: only where a person can answer (step 5a); anywhere else it prints usage. */
export function menuIsInteractive(): boolean {
  return interactive();
}

/** Dates people can read at a glance, in the terminal's local calendar. */
export function menuDate(utc: string, now = new Date()): string {
  const at = new Date(utc);
  if (!utc || Number.isNaN(at.getTime())) return 'not started';
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(day); yesterday.setDate(day.getDate() - 1);
  const tomorrow = new Date(day); tomorrow.setDate(day.getDate() + 1);
  const time = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  if (at >= day && at < tomorrow) return 'today ' + time;
  if (at >= yesterday && at < day) return 'yesterday ' + time;
  return at.getDate() + ' ' + at.toLocaleString('en', { month: 'long' });
}
export function plausibleSeatName(name: string): boolean { return /^[a-z][a-z0-9-]{2,}$/.test(name); }
function nearMatch(text: string, query: string): boolean {
  text = text.toLowerCase(); query = query.toLowerCase();
  if (text.includes(query)) return true;
  // A single adjacent transposition, such as vualt, is still the same search.
  for (let i = 0; i < query.length - 1; i++) {
    const swapped = query.slice(0, i) + query[i + 1] + query[i] + query.slice(i + 2);
    if (text.includes(swapped)) return true;
  }
  return false;
}
function rowAssistant(row: MenuRow, fallback: Assistant = 'claude'): Assistant {
  return row.launchAssistant ?? (row.view.session_id ? row.view.assistant : fallback);
}
function updateMenuItem(update: string | null): ScreenItem[] {
  const version = update?.match(/Deskpost (\S+) is ready/)?.[1];
  return version ? [{ id: 'upgrade', text: 'Upgrade to ' + version }] : [];
}
export function firstMenuScreen(rows: MenuRow[], search = '', now = new Date(), fallback: Assistant = 'claude', update: string | null = null): ScreenModel {
  const upgrade = updateMenuItem(update);
  const actions: ScreenItem[] = [{ id: 'create', text: '+ New seat' }, ...upgrade, { id: 'help', text: 'Help and more' }, { id: 'quit', text: 'Quit' }];
  if (!rows.length && !search) return {
    title: 'Deskpost', before: [...(update ? [update] : []), '   A seat is a place for one line of work: its own', '   assistant, its own folders and its own notes.', '   You have none yet.', ''],
    items: [{ id: 'create', text: '+ Make your first seat' }, { id: 'tour', text: 'Show me around' }, ...upgrade, actions.at(-1)!], esc: 'quit',
  };
  const free = rows.filter(row => row.state === 'free').sort((a, b) => b.last_active_utc.localeCompare(a.last_active_utc) || a.seat.localeCompare(b.seat));
  const busy = rows.filter(row => row.state !== 'free').sort((a, b) => b.last_active_utc.localeCompare(a.last_active_utc));
  const items: ScreenItem[] = [];
  if (!search && free[0]?.view.session_id && rowAssistant(free[0], fallback) === free[0].view.assistant) items.push({ id: 'continue:' + free[0].seat, text: 'Continue ' + seatLabel(free[0].seat, free[0].nickname) + (fullAccessSettings(rowAssistant(free[0], fallback), free[0].launchArgs ?? []) ? ' (!)' : '') + ' (' + menuDate(free[0].last_active_utc, now) + ')', group: 'Most recent free seat' });
  for (const row of [...free, ...busy]) {
    const name = seatLabel(row.seat, row.nickname) + (fullAccessSettings(rowAssistant(row, fallback), row.launchArgs ?? []) ? ' (!)' : '');
    const when = row.state === 'free' ? menuDate(row.last_active_utc, now) : row.state === 'unreadable' ? 'could not be checked' : row.opened_utc ? 'since ' + menuDate(row.opened_utc, now).replace(/^today /, '') : 'in another window';
    const letters = row.letters ? '  ' + row.letters + ' letter' + (row.letters === 1 ? '' : 's') : '';
    if (!search || nearMatch(name, search)) items.push({ id: 'seat:' + row.seat, text: name.padEnd(24) + when + letters,
      group: search ? undefined : row.state === 'free' ? 'Seats' : row.state === 'unreadable' ? 'Could not be checked' : 'Open in another window', dim: row.state !== 'free', nameLength: name.length });
  }
  items.push(...actions.filter(item => !search || nearMatch(item.text, search)));
  if (search && !items.length && plausibleSeatName(search)) items.push({ id: 'create:' + search, text: '+ Make a new seat called ' + search });
  if (search && items.length) items[0]!.group = items[0]!.id.startsWith('create:') ? 'No seat called ' + search : items.length + ' match' + (items.length === 1 ? '' : 'es');
  const fullRows = rows.filter(row => items.some(item => item.id === 'seat:' + row.seat) && fullAccessSettings(rowAssistant(row, fallback), row.launchArgs ?? []));
  const allNeverAsk = fullRows.every(row => rowAssistant(row, fallback) === 'claude' || (row.launchArgs ?? []).includes('--dangerously-bypass-approvals-and-sandbox') || accessOptionValue(row.launchArgs ?? [], '--ask-for-approval', '-a') === 'never');
  return { title: 'Deskpost', search: true, items, before: update ? [update] : [], esc: 'quit',
    after: search && !items.length ? ['   No seat or action matches ' + search + '.'] : fullRows.length ? [allNeverAsk ? '   (!) full access: never asks before acting' : '   (!) full access: can act outside this seat'] : [] };
}
export function seatActionScreen(row: MenuRow, now = new Date(), fallback: Assistant = 'claude'): ScreenModel {
  const assistant = rowAssistant(row, fallback);
  const before = ['   ' + ASSISTANT_LABEL[assistant] + '   ' + accessName(assistant, row.launchArgs ?? []) + '   ' + (row.folders || 0) + ' folder' + (row.folders === 1 ? '' : 's')];
  if (row.letters) before.push('   ' + row.letters + ' letter' + (row.letters === 1 ? '' : 's') + ' waiting (it reads it when it starts)');
  if (row.card) before.push('   ' + row.card);
  before.push('');
  if (row.state === 'unreadable') return { title: row.seat, before: [...before, ...menuMessageLines('This seat could not be checked: ' + row.state_note)], items: [{ id: 'back', text: 'Back' }, { id: 'settings', text: 'Settings' }] };
  if (row.state !== 'free') return { title: seatLabel(row.seat, row.nickname), before: [...before,
    '   Open in another window' + (row.opened_utc ? ' since ' + menuDate(row.opened_utc, now).replace(/^today /, '') : '') + '.',
    '   Switch to that window to keep working.', ''], items: [{ id: 'back', text: 'Back' }, { id: 'settings', text: 'Settings' }, { id: 'reopen', text: 'Open it here anyway' }] };
  const sameAssistant = row.view.assistant === assistant;
  const resume = !!row.view.session_id && sameAssistant;
  if (!row.view.session_id) before.push('   No conversations yet.', '');
  else if (!sameAssistant) before.push('   The last conversation uses ' + ASSISTANT_LABEL[row.view.assistant] + '.', '   This seat now starts ' + ASSISTANT_LABEL[assistant] + '.', '');
  return { title: seatLabel(row.seat, row.nickname), before, items: [
    ...(resume ? [{ id: 'resume', text: 'Continue last conversation (' + menuDate(row.last_active_utc, now) + ')' }] : []),
    { id: 'new', text: row.view.session_id ? 'Start a new conversation' : 'Start its first conversation' },
    { id: 'settings', text: 'Settings' }, { id: 'back', text: 'Back' }] };
}
async function chooseScreen(state: MenuState, model: ScreenModel | ((text: string) => ScreenModel), text = ''): Promise<{ id: string; text: string }> {
  const result = state.talk.screen ? await state.talk.screen(model, text) : state.options.plain ? await choosePlainScreen(state, model, text) : await askScreen(model, { width: state.options.width, text });
  if (result.id === 'interrupt') throw new MenuQuit('No seat was chosen.');
  if (result.id === 'plain') { state.options.plain = true; return choosePlainScreen(state, model, result.text); }
  return result;
}
async function screenNotice(state: MenuState, title: string, lines: string[]): Promise<void> {
  await chooseScreen(state, { title, before: lines, items: [{ id: 'back', text: 'Back' }] });
}
async function seatActionMenu(state: MenuState, original: MenuRow): Promise<number | null> {
  for (;;) {
    const row = menuRows(state.workspace, { fallbackAssistant: state.assistant ?? undefined, transcriptRoot: state.options.transcriptRoot }).find(r => r.seat === original.seat);
    if (!row) return null;
    const answer = await chooseScreen(state, seatActionScreen(row, new Date(), state.assistant ?? 'claude'));
    if (answer.id === 'back') return null;
    if (answer.id === 'settings') { await screenSettings(state, row); continue; }
    if (answer.id === 'reopen') {
      const confirmation = await chooseScreen(state, { title: row.seat, before: ['   Is the other window closed? Two windows in one', '   seat tangle its conversation.'], field: { label: 'Open it here? y/N >' }, items: [] });
      if (confirmation.id === 'back' || confirmation.text.toLowerCase() !== 'y') continue;
      // Confirmation never steals a live claim. The existing claim detector releases dead holders.
      const current = menuRows(state.workspace).find(r => r.seat === row.seat);
      if (!current || current.state !== 'free') { await screenNotice(state, row.seat, ['   Close its other window first, then try again.']); continue; }
      const started = await sitDown(state, current, current.view.session_id ? 'resume' : 'new');
      if (started !== null) return started;
      continue;
    }
    const messages: string[] = [];
    const launchState = { ...state, talk: { ...state.talk, say: (message = '') => { messages.push(message); state.talk.say(message); } } };
    const started = await sitDown(launchState, row, answer.id === 'resume' ? 'resume' : 'new');
    if (started !== null) return started;
    await screenNotice(state, row.seat, messages.length ? messages.flatMap(message => menuMessageLines(message, state.options.width)) : ['   The seat could not start. Choose Settings', '   to check its assistant, or try again.']);
  }
}
/** Preserve the script grammar and view while sharing the screen menu's controller. */
async function scriptedScreenChoice(state: MenuState, rows: MenuRow[], empty: {shown:boolean;upgrade:boolean}): Promise<{id:string;text:string}> {
  const { talk, workspace } = state;
  if (!rows.length) {
    if (!empty.shown) {
      talk.say(`\n  Library  ${workspace}`);
      talk.say('\nThis Library has no seats yet. A seat is a place to work, with its own Desk and one Project.');
      // `h` IS SHOWN AS WELL AS ENTER (S58 #6): the closing words say "`h`, or Enter", and `h` is the key every later menu
      // offers Show me around on, so the first screen teaches the key that keeps working.
      talk.say(`  [h, Enter] Show me around   a ${HELP_SEAT} seat with the Librarian as your guide`);
      talk.say('  [+]        Your first seat  name a project, and start working in it');
      talk.say('  [l]        Browse           what the Library holds, without a seat');
      const ready = readyVersion(state.installRoot, state.running);
      if (ready !== null) talk.say(`  [u]        Upgrade          Deskpost ${ready} is ready (you have ${state.running})`);
      talk.say('  [q]        Later');
      empty.upgrade = ready !== null; empty.shown = true;
    }
    const key = (await talk.ask('› ')).toLowerCase();
    const action = key === 'q' ? 'quit' : key === '' || key === 'h' ? 'tour' : key === '+' ? 'create' : key === 'l' ? 'legacy-browse' : key === 'u' && empty.upgrade ? 'upgrade' : null;
    return action ? {id:action,text:''} : {id:'legacy-again',text:`'${key}' is not one of the keys above.`};
  }
  talk.say('Library  ' + workspace);
    for (const line of plainSeatLines(rows, new Date(), state.assistant ?? 'claude')) talk.say(plainText(line));
    const update = updateLineDue(state);
    if (update !== null) talk.say(update);
  const choice = resolveChoice(await talk.ask('Seat › '), rows.length, readyVersion(state.installRoot, state.running) !== null);
  const target = choice.index > 0 ? rows[choice.index - 1]! : null;
  const direct: Partial<Record<Choice['action'],string>> = {quit:'quit',create:'create',help:'tour',upgrade:'upgrade',browse:'legacy-browse','basic-memory':'legacy-basic-memory',switch:'legacy-switch'};
  const action = direct[choice.action]; if (action) return {id:action,text:''};
  const selections: Partial<Record<Choice['action'],string>> = {resume:'continue',new:'new',retire:'legacy-retire',folders:'legacy-folders',settings:'legacy-settings'};
  const prefix = selections[choice.action];
  return prefix && target ? {id:prefix+':'+target.seat,text:''} : {id:'legacy-again',text:choice.reason};
}

async function screenMenuLoop(state: MenuState): Promise<number> {
  const { talk } = state;
  const empty = {shown:false,upgrade:false};
  const update = talk.scripted ? null : updateLineDue(state);
  for (;;) {
    const rows = talk.scripted && empty.shown ? [] : menuRows(state.workspace, { fallbackAssistant: state.assistant ?? undefined, transcriptRoot: state.options.transcriptRoot });
    const answer = talk.scripted ? await scriptedScreenChoice(state, rows, empty) : state.options.plain ? await plainMainChoice(state, rows, update) : await chooseScreen(state, text => firstMenuScreen(rows, text, new Date(), state.assistant ?? 'claude', update));
    if (answer.id === 'quit' || answer.id === 'back') {
      if (talk.scripted) { if (!rows.length) { talk.say(`Nothing was created. Type \`${COMMAND_NAME}\` whenever you are ready.`); } else { talk.say('No seat was chosen.'); } }
      return 0;
    }
    if (talk.scripted && answer.id === 'legacy-again') { talk.say(answer.text); continue; }
    if (talk.scripted && answer.id === 'legacy-switch') { if (state.claude && state.codex) {
          state.assistant = state.assistant === 'claude' ? 'codex' : 'claude';
          talk.say(`New conversations now use ${ASSISTANT_LABEL[state.assistant]}. This default applies only to seats with no recorded assistant.`);
        } else talk.say(state.assistant ? `Only ${ASSISTANT_LABEL[state.assistant]} is found here, so there is nothing to switch to.` : NO_ASSISTANT); continue; }
    if (talk.scripted && answer.id === 'legacy-browse') { await browse(state); continue; }
    if (talk.scripted && answer.id === 'legacy-basic-memory') { await basicMemory(state); continue; }
    if (answer.id === 'upgrade') { const result = await upgradeFromMenu(state); if (result !== null) return result; continue; }
    if (answer.id === 'tour') { const result = await showMeAround(state); if (talk.scripted && !rows.length) return result ?? 0; if (result !== null) return result; continue; }
    if (answer.id === 'help') {
      const help = await chooseScreen(state, helpMenuScreen());
      if (help.id === 'tour') { const result = await showMeAround(state); if (result !== null) return result; }
      else if (help.id === 'browse') await screenBrowse(state);
      else if (help.id === 'basic-memory') await screenBasicMemory(state);
      else if (help.id === 'plain') state.options.plain = true;
      continue;
    }
    if (answer.id === 'create' || answer.id.startsWith('create:')) { const result = talk.scripted ? await wizard(state, !rows.length) : await screenWizard(state, answer.id.startsWith('create:') ? answer.id.slice(7) : ''); if (talk.scripted && !rows.length) return result ?? 0; if (result !== null) return result; continue; }
    const name = answer.id.slice(answer.id.indexOf(':') + 1), row = rows.find(r => r.seat === name);
    if (!row) continue;
    if (talk.scripted && answer.id.startsWith('legacy-retire:')) { await retire(state, row); continue; }
    if (talk.scripted && answer.id.startsWith('legacy-folders:')) { await folders(state, row); continue; }
    if (talk.scripted && answer.id.startsWith('legacy-settings:')) { await launchSettingsScreen(state, row); continue; }
    const result = answer.id.startsWith('continue:') ? await sitDown(state, row, 'resume') : answer.id.startsWith('new:') ? await sitDown(state, row, 'new') : await seatActionMenu(state, row);
    if (result !== null) return result;
  }
}

export function assistantMenuScreen(name: string, installed: { claude: boolean; codex: boolean }): ScreenModel {
  return { title: 'New seat  step 2 of 3', before: ['   Name  ' + name, '', '   Which assistant should this seat use?', ''], items: [
    { id: 'claude', text: 'Claude Code   (usual choice)' + (installed.claude ? '' : '   not installed'), disabled: !installed.claude,
      detail: installed.claude ? ["   Anthropic's coding assistant. It runs as the", '   claude command in this terminal.'] : ['   The claude command was not found. Install it,', '   then come back.'] },
    { id: 'codex', text: 'Codex' + (installed.codex ? '' : '   not installed'), disabled: !installed.codex,
      detail: installed.codex ? ['   OpenAI coding assistant. It runs as the', '   codex command in this terminal.'] : ['   The codex command was not found. Install it,', '   then come back.'] },
    { id: 'back', text: 'Back' }] };
}
export function accessMenuScreen(name: string, assistant: Assistant, settings = false): ScreenModel {
  return { title: settings ? 'Access for ' + name : 'New seat  step 3 of 3',
    before: ['   Name  ' + name + '   Assistant  ' + ASSISTANT_LABEL[assistant], '',
      '   How much may ' + (assistant === 'claude' ? 'Claude' : 'Codex') + ' do without asking you?', ''],
    items: [...MENU_ACCESS[assistant].map(access => ({ id: access.id, text: access.name + (access.usual ? '   (usual choice)' : '') + (access.full ? ' (!)' : ''),
      detail: access.detail.map(line => '   ' + line) })),
      { id: 'custom', text: 'Type my own settings', detail: ['   Type command settings; each value is checked.'] }, { id: 'back', text: 'Back' }],
    initial: MENU_ACCESS[assistant].find(access => access.usual)?.id };
}
export function newSeatReadyScreen(name: string, assistant: Assistant, args: string[], warning = '', rings?: boolean): ScreenModel {
  // TYPED SETTINGS ARE SHOWN AS TYPED, AND FULL ACCESS IS MARKED AS THE ACCESS LIST MARKS IT (kickoffs/s120 row 4).
  const listed = MENU_ACCESS[assistant].find(access => access.args.length === args.length && access.args.every((arg, index) => arg === args[index]));
  const access = (listed || !args.length ? accessName(assistant, args) : 'My own settings: ' + escapedArgv(args)) + (fullAccessSettings(assistant, args) ? ' (!)' : '');
  return { title: 'New seat  ready', before: ['   Name       ' + name, '   Assistant  ' + ASSISTANT_LABEL[assistant],
    '   Access     ' + access,
    // A CLAUDE CODE SEAT'S MESSAGES, in the line wizard's words (kickoffs/s166 row 4), when the wizard says which.
    ...(rings === undefined ? [] : ['   Messages   ' + (rings ? 'rings reach it at once (inbound accept)' : 'Claude Code decides (inbound unset)')]),
    ...(warning ? ['', '   ' + warning] : []), ''],
    items: [{ id: 'start', text: 'Make it and start ' + ASSISTANT_LABEL[assistant] }, { id: 'make', text: 'Make it, but do not start it yet' },
      { id: 'more', text: 'More choices (department, template, card)' }, { id: 'back', text: 'Back' }] };
}
export function menuNameSuggestion(typed: string): string { return slugFrom(typed.replace(/\.+$/, '')); }
function menuMessageLines(text: string, width = 60): string[] {
  const lines: string[] = [];
  let rest = text;
  const room = Math.max(10, width - 3);
  while (rest.length > room) {
    const space = rest.lastIndexOf(' ', room);
    const end = space > 0 ? space : room;
    lines.push('   ' + rest.slice(0, end)); rest = rest.slice(end).trimStart();
  }
  if (rest) lines.push('   ' + rest);
  return lines;
}
async function inputScreen(state: MenuState, title: string, label: string, text = '', hint = '', error = '', errorColour = true): Promise<{ id: string; text: string }> {
  return chooseScreen(state, { title, field: { label, hint, enter: label === 'Folder' ? 'add' : 'next', allowEmpty: label === 'Department' || label === 'Card' || label.endsWith(' settings') }, items: [], after: error ? menuMessageLines(error, state.options.width) : label === 'Name' ? ['         Lowercase letters, numbers and dashes.'] : [], afterKind: error && errorColour ? 'error' : 'detail', esc: 'cancel' }, text);
}
async function confirmFullAccess(state: MenuState, assistant: Assistant, custom = false): Promise<boolean> {
  let text = '', error = '';
  for (;;) {
    const answer = await chooseScreen(state, { title: custom ? 'These settings give full access.' : 'Full access', warning: true, afterKind: error ? 'error' : 'detail',
      before: custom ? [] : ['   ' + ASSISTANT_LABEL[assistant] + ' can change or delete any file on this computer', '   and run any command, and never stops to ask you.', ''],
      field: { label: 'Type full and press Enter:', hint: '_', enter: null }, items: [], after: menuMessageLines(error, state.options.width), esc: 'go back and choose again' }, text);
    if (answer.id === 'back') return false;
    if (answer.text.trim().toLowerCase() === 'full') return true;
    text = answer.text; error = 'Type full to continue, or Esc to choose again.';
  }
}
async function pickAccess(state: MenuState, name: string, assistant: Assistant, settings = false): Promise<string[] | null> {
  for (;;) {
    const answer = await chooseScreen(state, accessMenuScreen(name, assistant, settings));
    if (answer.id === 'back') return null;
    let args: string[];
    if (answer.id === 'custom') {
      let text = '', error = '', suggestion = '';
      for (;;) {
        const typed = await inputScreen(state, ASSISTANT_LABEL[assistant] + ' settings', ASSISTANT_LABEL[assistant] + ' settings', text, '_ type settings', error);
        if (typed.id === 'back') break;
        if (suggestion && typed.text === text) text = suggestion; else text = typed.text;
        try { const tokens = splitMenuFlags(text); validateStoredFlags(assistant, tokens); args = tokens; break; }
        catch (problem) {
          error = (problem as Error).message;
          const tokens = splitMenuFlags(text), last = tokens.at(-1) ?? '';
          const trimmed = last.replace(/[.,;:]+$/, '');
          suggestion = Object.values(LAUNCH_ACCESS_VALUES[assistant]).some(values => values.includes(trimmed)) && trimmed !== last ?
            [...tokens.slice(0, -1), trimmed].join(' ') : '';
          if (suggestion) error += ' Enter uses ' + trimmed + ', or keep typing.';
        }
      }
      if (args! === undefined) continue;
    } else args = [...MENU_ACCESS[assistant].find(access => access.id === answer.id)!.args];
    validateStoredFlags(assistant, args!);
    if (fullAccessSettings(assistant, args!) && !(await confirmFullAccess(state, assistant, answer.id === 'custom'))) continue;
    return args!;
  }
}
export async function screenWizard(state: MenuState, initialName = ''): Promise<number | null> {
  let name = initialName, projectName = initialName, assistant: Assistant | null = null, args: string[] | null = null;
  let step = initialName ? 2 : 1, error = '', suggestion = '';
  let choices: SeatStartChoices = { openBooks: newSeatBooks(state.workspace) };
  // RINGS REACH A NEW CLAUDE CODE SEAT AT ONCE, as in the line wizard (kickoffs/s108 ruling 6; s166 row 4); More choices
  // turns it off. Never for Codex, which has no inbox.
  let acceptRings = true;
  for (;;) {
    if (step === 1) {
      const answer = await inputScreen(state, 'New seat  step 1 of 3', 'Name', name, '_ type a name', error);
      if (answer.id === 'back') return null;
      if (suggestion && answer.text === name) name = suggestion; else name = answer.text.trim();
      suggestion = '';
      const projects = activeProjects(state.workspace);
      const verdict = newSeatVerdict(state.workspace, name, name, projects.includes(name) ? projects : [...projects, name], true);
      if (!verdict.creatable || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        suggestion = menuNameSuggestion(name);
        if (suggestion === name) suggestion = '';
        error = seatRegistryRows(state.workspace).some(row => row['seat'] === name) ? 'There is already a seat called ' + name + '. Type another name.' :
          'Names use lowercase letters, numbers and dashes.' + (suggestion ? ' Did you mean ' + suggestion + '? Enter uses it, or keep typing.' : ' ' + verdict.reason);
        continue;
      }
      projectName = name; error = ''; step = 2;
    }
    if (step === 2) {
      const answer = await chooseScreen(state, assistantMenuScreen(name, state));
      if (answer.id === 'back') { step = 1; continue; }
      assistant = answer.id as Assistant; step = 3;
    }
    if (step === 3) {
      args = await pickAccess(state, name, assistant!);
      if (args === null) { step = 2; continue; }
      step = 4;
    }
    const answer = await chooseScreen(state, newSeatReadyScreen(name, assistant!, args!, error, assistant === 'claude' ? acceptRings : undefined));
    if (answer.id === 'back') { step = 3; error = ''; continue; }
    if (answer.id === 'more') {
      const rows = seatRegistryRows(state.workspace), projection = seatMetadata(rows);
      const known = registryDepartments(rows).map((department) => ({ name: department, destination: destinationOf(projection, department) }));
      const picked = await chooseScreen(state, (text: string) => departmentScreen(known, text));
      if (picked.id === 'back') continue;
      // A typed name submitted as text (a script's answer) is taken as typed, as the list's own items are.
      let typed = picked.id.startsWith('department:') ? picked.id.slice('department:'.length) : picked.id.startsWith('create:') ? picked.id.slice('create:'.length) : picked.id === 'submit' ? picked.text.trim() : '';
      if (picked.id === 'new') {
        const named = await inputScreen(state, 'More choices', 'Department', '', '_ a new department name');
        if (named.id === 'back') continue;
        typed = named.text.trim();
      }
      const problem = typed ? departmentProblem(typed) : null;
      if (problem) { error = problem; continue; }
      choices = { openBooks: newSeatBooks(state.workspace), ...(choices.card !== undefined ? { card: choices.card } : {}), ...(typed ? { department: typed } : {}) };
      if (typed) {
        const template = await chooseScreen(state, { title: 'Template', items: [
          { id: 'none', text: 'No template' }, ...WIZARD_TEMPLATE_KEYS.map(([, template]) => ({ id: template, text: (template.charAt(0).toUpperCase() + template.slice(1)).padEnd(15) + WIZARD_TEMPLATE_WORDS[template] })),
          { id: 'back', text: 'Back' }] });
        if (template.id !== 'none' && template.id !== 'back') {
          choices.template = template.id;
          // THE NAME TYPED AT STEP 1 IS KEPT while it is free (kickoffs/s166 row 4); only a taken one gives way to the
          // template's `<department>-<job>`, and the existing planner checks every choice.
          const projects = activeProjects(state.workspace);
          const free = (seat: string) => newSeatVerdict(state.workspace, seat, projectName, [...projects, projectName], true, choices).creatable;
          const base = choices.department + '-' + WIZARD_JOBS[template.id];
          const kept = !!name && free(name);
          let proposed = kept ? name : base, suffix = 2;
          while (!kept && !free(proposed) && suffix < 20) proposed = base + '-' + suffix++;
          const changed = await inputScreen(state, 'Seat name', 'Name', proposed, '', 'Project stays ' + projectName + '.', false);
          if (changed.id !== 'back') name = changed.text;
        }
      }
      // THE CARD (kickoffs/s146 row 5): one line, checked as `seat describe --card` checks it; empty leaves none.
      for (let problem = ''; ;) {
        const card = await inputScreen(state, 'More choices', 'Card', choices.card ?? '', '_ one line on what this seat handles; leave empty for none', problem);
        if (card.id === 'back') break;
        problem = card.text ? (cardProblem(card.text) ?? '') : '';
        if (problem) { problem = 'That card is refused: ' + problem + '.'; continue; }
        if (card.text) choices.card = card.text; else delete choices.card;
        break;
      }
      if (assistant === 'claude') {
        const messages = await chooseScreen(state, { title: 'Messages', before: ["   How other seats' rings reach this seat.", ''], initial: acceptRings ? 'accept' : 'decides', items: [
          { id: 'accept', text: 'Messages: rings reach it at once' }, { id: 'decides', text: 'Messages: Claude Code decides' }, { id: 'back', text: 'Back' }] });
        if (messages.id !== 'back') acceptRings = messages.id === 'accept';
      }
      error = ''; continue;
    }
    try {
      const projects = activeProjects(state.workspace), hubExists = projects.includes(projectName);
      const approvedChoices = { ...choices, recordAssistant: assistant!, ...(assistant === 'claude' && acceptRings ? { inbound: 'accept' } : {}) };
      const planned = newSeatVerdict(state.workspace, name, projectName, hubExists ? projects : [...projects, projectName], false, approvedChoices);
      if (!planned.creatable) { error = planned.reason; continue; }
      if (!hubExists) {
        const made = await runHubVerb(['new', projectName, '--title', projectName, ...(planned.plan!.purpose ? ['--purpose', planned.plan!.purpose] : []), '--workspace', state.workspace], state.workspace);
        if (made.refusal) { error = made.refusal; continue; }
      }
      await startSeat([name, '--project', projectName, '--workspace', state.workspace, '--plan-id', planned.plan_id, ...seatStartChoiceArguments(approvedChoices), '--no-launch']);
      // The ready choice approves these exact access flags. The existing writer binds them to the newly created incarnation.
      const setting = { workspace: state.workspace, seat: name, flags: assistant!, args: args!, preflight: true, planId: '', fallbackAssistant: assistant! };
      const access = seatSettingsResult(setting);
      seatSettingsResult({ ...setting, preflight: false, planId: String(access['plan_id']) });
      state.talk.say('Made ' + name + '.' + (answer.id === 'start' ? ' Starting ' + ASSISTANT_LABEL[assistant!] + '.' : ' Ready for later.'));
      if (answer.id === 'make') return null;
      const row = menuRows(state.workspace).find(row => row.seat === name)!;
      return sitDown(state, row, 'new');
    } catch (problem) {
      error = (problem as Error).message;
      if (seatRegistryRows(state.workspace).some(row => row['seat'] === name)) {
        await screenNotice(state, name, ['   The seat was made, but could not finish starting.', '   ' + error, '   Choose Settings before starting it again.']); return null;
      }
    }
  }
}

export const RETIRE_MENU_TEXT = (seat: string): string[] => [
  '   Retiring takes ' + seat + ' off the list. Its notes and',
  '   desk are kept in an archive, but the menu cannot',
  '   bring it back.',
];
export function settingsMenuScreen(row: MenuRow, fallback: Assistant = 'claude'): ScreenModel {
  const assistant = rowAssistant(row, fallback);
  return { title: 'Settings for ' + row.seat, items: [
    { id: 'assistant', text: 'Assistant      ' + ASSISTANT_LABEL[assistant] },
    { id: 'access', text: 'Access         ' + accessName(assistant, row.launchArgs ?? []) + (fullAccessSettings(assistant, row.launchArgs ?? []) ? ' (!)' : '') },
    { id: 'folders', text: 'Folders        ' + row.folders + ' folder' + (row.folders === 1 ? '' : 's') },
    { id: 'command', text: 'Exact command  show it' }, { id: 'retire', text: 'Retire         take this seat off the list' }, { id: 'back', text: 'Back' }],
    after: ['   Changes apply the next time the seat starts.'] };
}
export function foldersMenuScreen(seat: string, dirs: string[]): ScreenModel {
  return { title: 'Folders for ' + seat, before: ['   The assistant may also work in these folders:', ''],
    items: [...dirs.map((dir, index) => ({ id: String(index), text: dir })), { id: 'add', text: '+ Add a folder' }, { id: 'back', text: 'Back' }] };
}
export function helpMenuScreen(): ScreenModel {
  return { title: 'Help and more', items: [
    { id: 'tour', text: 'Show me around (a guided seat with a helper)' }, { id: 'browse', text: 'Browse what the Library holds' },
    { id: 'basic-memory', text: 'Basic Memory (the shared notes server)' },
    { id: 'plain', text: 'Use plain text menus for this visit', detail: ['   Applies until you leave this menu.', '   Use deskpost menu --plain each time.'] }, { id: 'back', text: 'Back' }] };
}
export function commandMenuScreen(seat: string, command: string, width = 60): ScreenModel {
  const room = Math.max(10, width - 4);
  const chunks: ScreenItem[] = [];
  for (let at = 0; at < command.length; at += room) chunks.push({ id: 'command:' + at, text: command.slice(at, at + room), disabled: true, group: 'Command (read only)' });
  return { title: 'Exact command for ' + seat, items: [{ id: 'back', text: 'Back' }, ...chunks] };
}
export function plainSeatLines(rows: MenuRow[], now = new Date(), fallback: Assistant = 'claude', update: string | null = null): string[] {
  const upgrade = updateMenuItem(update);
  return [...(update ? [update] : []), 'Deskpost seats', ...rows.map(row => {
    const assistant = rowAssistant(row, fallback);
    const access = fullAccessSettings(assistant, row.launchArgs ?? []) ? ', full access' : '';
    return row.index + '. ' + seatLabel(row.seat, row.nickname) + formerlyMark(row) + ': ' + ASSISTANT_LABEL[assistant] + access + ', ' +
      (row.state === 'free' ? menuDate(row.last_active_utc, now) : 'in another window') +
      (row.letters ? ', ' + row.letters + ' letter' + (row.letters === 1 ? '' : 's') : '');
  }), (rows.length + 1) + '. Make a new seat', ...upgrade.map(item => (rows.length + 2) + '. ' + item.text), (rows.length + 2 + upgrade.length) + '. Help and more', (rows.length + 3 + upgrade.length) + '. Quit', 'Type a number or part of a name.'];
}
async function choosePlainScreen(state: MenuState, model: ScreenModel | ((text: string) => ScreenModel), text = ''): Promise<{ id: string; text: string }> {
  for (;;) {
    const page = typeof model === 'function' ? model(text) : model;
    state.talk.say(page.title);
    for (const line of page.before ?? []) state.talk.say(plainText(line));
    if (page.field) {
      for (const line of page.after ?? []) state.talk.say(plainText(line));
      const answer = await state.talk.ask(page.field.label + ' (Esc or blank cancels): ');
      if ((!answer && !page.field.allowEmpty) || answer === '\x1b') return { id: 'back', text };
      return { id: 'submit', text: answer };
    }
    page.items.forEach((item, index) => state.talk.say((index + 1) + '. ' + plainText(item.text) + (item.disabled ? ' (unavailable)' : '')));
    for (const line of page.after ?? []) state.talk.say(plainText(line));
    const typed = await state.talk.ask('Choose (blank goes back): ');
    if (!typed || typed === '\x1b') return { id: 'back', text };
    const item = /^\d+$/.test(typed) ? page.items[Number(typed) - 1] : page.items.find(i => i.text.toLowerCase().includes(typed.toLowerCase()));
    if (item && !item.disabled) return { id: item.id, text };
    if (typeof model === 'function') { text = typed; continue; }
    state.talk.say('Choose one of the numbered lines, or leave it blank to go back.');
  }
}
async function screenFolders(state: MenuState, row: MenuRow): Promise<void> {
  for (;;) {
    try {
      const current = planSeatDirs({ workspace: state.workspace, seat: row.seat }).dirs;
      const choice = await chooseScreen(state, foldersMenuScreen(row.seat, current));
      if (choice.id === 'back') return;
      const value = choice.id === 'add' ? await inputScreen(state, 'Add a folder', 'Folder', '', '_ type or paste a path') : null;
      if (value?.id === 'back') continue;
      const change = value ? { add: value.text } : { remove: current[Number(choice.id)]! };
      const planned = planSeatDirs({ workspace: state.workspace, seat: row.seat, ...change });
      const confirm = await chooseScreen(state, { title: value ? 'Add this folder?' : 'Remove this folder?', before: menuMessageLines(value?.text ?? current[Number(choice.id)]!, state.options.width), field: { label: 'Save this? y/N >', hint: '_ No unless you type y' }, items: [] });
      if (confirm.id === 'back' || confirm.text.toLowerCase() !== 'y') continue;
      const saved = changeSeatDirs({ workspace: state.workspace, seat: row.seat, ...change });
      state.talk.say(seatDirsSentence(saved)); row.folders = planned.dirs.length;
    } catch (error) { await screenNotice(state, row.seat, ['   ' + (error as Error).message]); }
  }
}
export async function screenRetire(state: MenuState, row: MenuRow): Promise<void> {
  try {
    const plan = retireSeat([row.seat, '--workspace', state.workspace, '--preflight']);
    let error = '';
    for (;;) {
      const typed = await chooseScreen(state, { title: 'Retire ' + row.seat + '?', warning: true, afterKind: error ? 'error' : 'detail', before: [...RETIRE_MENU_TEXT(row.seat), ''], items: [],
        field: { label: 'Type retire and press Enter:', enter: null }, after: error ? ['   ' + error] : [] });
      if (typed.id === 'back') return;
      if (typed.text.toLowerCase() !== 'retire' && typed.text !== row.seat) { error = 'Type retire, or press Esc to go back.'; continue; }
      retireSeat([row.seat, '--workspace', state.workspace, '--plan-id', String(plan['plan_id'])]);
      state.talk.say('Retired ' + row.seat + '. Its notes and desk are kept in an archive.'); return;
    }
  } catch (error) { await screenNotice(state, 'Retire ' + row.seat, ['   ' + (error as Error).message]); }
}
export async function screenSettings(state: MenuState, original: MenuRow): Promise<void> {
  for (;;) {
    const row = menuRows(state.workspace, { fallbackAssistant: state.assistant ?? undefined }).find(r => r.seat === original.seat);
    if (!row) return;
    const choice = await chooseScreen(state, settingsMenuScreen(row, state.assistant ?? 'claude'));
    if (choice.id === 'back') return;
    try {
      const assistant = rowAssistant(row, state.assistant ?? 'claude');
      if (choice.id === 'assistant') {
        const selected = await chooseScreen(state, { ...assistantMenuScreen(row.seat, state), title: 'Assistant for ' + row.seat });
        if (selected.id !== 'back') seatSettingsResult({ workspace: state.workspace, seat: row.seat, assistant: selected.id, preflight: false, planId: '' });
      } else if (choice.id === 'access') {
        const args = await pickAccess(state, row.seat, assistant, true);
        if (!args) continue;
        const options = { workspace: state.workspace, seat: row.seat, flags: assistant, args, preflight: true, planId: '', fallbackAssistant: assistant };
        const preview = seatSettingsResult(options);
        const approval = await chooseScreen(state, { title: 'Save access for ' + row.seat + '?', before: ['   ' + accessName(assistant, args), ...(MENU_ACCESS[assistant].find(a => a.name === accessName(assistant, args))?.detail.map(l => '   ' + l) ?? []),
          '   Exact settings: ' + escapedArgv(args)], items: [{ id: 'cancel', text: 'Cancel' }, { id: 'save', text: 'Save these settings' }] });
        if (approval.id === 'save') seatSettingsResult({ ...options, preflight: false, planId: String(preview['plan_id']) });
      } else if (choice.id === 'folders') await screenFolders(state, row);
      else if (choice.id === 'retire') { await screenRetire(state, row); if (!menuRows(state.workspace).some(r => r.seat === row.seat)) return; }
      else if (choice.id === 'command') {
        const preview = seatLaunchPreview(state.workspace, row.seat, undefined, state.assistant ?? 'claude', 'resume', state.options.transcriptRoot);
        await chooseScreen(state, commandMenuScreen(row.seat, escapedArgv([preview.command, ...preview.args]), state.options.width));
      }
    } catch (error) { await screenNotice(state, row.seat, ['   ' + (error as Error).message]); }
  }
}
async function screenBrowse(state: MenuState): Promise<void> {
  const data = browseData(state.workspace, false), entries = browseEntries(data);
  for (;;) {
    const chosen = await chooseScreen(state, query => ({ title: 'Browse what the Library holds', search: true, items: [
      ...filterBrowse(entries, query).map(entry => ({ id: 'entry:' + entries.indexOf(entry), text: entry.title + ' (' + entry.slug + ')' })), { id: 'back', text: 'Back' }] }));
    if (chosen.id === 'back') return;
    const entry = entries[Number(chosen.id.slice(6))];
    if (entry) await screenNotice(state, entry.title, browseEntryLines(entry));
  }
}
async function screenBasicMemory(state: MenuState): Promise<void> {
  const connection = markerConnection(state.workspace);
  await screenNotice(state, 'Basic Memory', connection ? [
    '   Connected to ' + connection.url, '   Collection ' + (connection.collection_name || connection.collection_id), '   Compare with: deskpost basic-memory status'] :
    ['   Basic Memory shares Books across machines.', '   Set it up with:', '   deskpost basic-memory setup --url <mcp-url>', '     --collection <name> --preflight']);
}

async function plainMainChoice(state: MenuState, rows: MenuRow[], update: string | null = null): Promise<{ id: string; text: string }> {
  if (!rows.length) return choosePlainScreen(state, firstMenuScreen([], '', new Date(), state.assistant ?? 'claude', update));
  rows = [...rows].sort((a,b) => Number(a.state !== 'free') - Number(b.state !== 'free') || b.last_active_utc.localeCompare(a.last_active_utc) || a.seat.localeCompare(b.seat)).map((row,index)=>({...row,index:index+1}));
  const upgrade = updateMenuItem(update).length;
  for (const line of plainSeatLines(rows, new Date(), state.assistant ?? 'claude', update)) state.talk.say(plainText(line));
  for (;;) {
    const typed = await state.talk.ask('Seat: ');
    const number = Number(typed);
    if (number === rows.length + 1) return { id: 'create', text: '' };
    if (upgrade && number === rows.length + 2) return { id: 'upgrade', text: '' };
    if (number === rows.length + 2 + upgrade) return { id: 'help', text: '' };
    if (number === rows.length + 3 + upgrade || /^q(uit)?$/i.test(typed)) return { id: 'quit', text: '' };
    if (/^n\d+$/i.test(typed)) {
      const row = rows.find(row => row.index === Number(typed.slice(1)));
      if (row) return { id: 'new:' + row.seat, text: '' };
    }
    const matches = /^\d+$/.test(typed) ? rows.filter(row => row.index === number) : typed ? rows.filter(row => nearMatch(seatLabel(row.seat,row.nickname),typed)) : [];
    if (matches.length === 1) return { id: 'seat:' + matches[0]!.seat, text: '' };
    state.talk.say('Choose a listed number or name; q quits.');
  }
}

// --- deskpost library default ---------------------------------------------------------------------------------------

/** `deskpost library [list | default <folder>]`: the registered Libraries, and which one bare `deskpost` opens. */
export function runLibraryVerb(argv: string[]): { refusal: string | null; value: PsJsonValue | null; humanText?: string } {
  const parsed = parseArguments(argv, verbTable('library'));
  const action = parsed.positional[0] ?? 'list';
  const registryRoot = parsed.options.get('registry-root');
  if (action === 'list') {
    const libraries = registeredLibraries(registryRoot);
    const lines = libraries.length
      ? libraries.map((library) => `  ${library.isDefault ? '*' : ' '} ${library.root}${library.valid ? '' : '   (not found, or its marker names another Library)'}`)
      : ['  (none registered)'];
    return {
      refusal: null,
      value: { schema: 1, operation: 'Library list', registry: registryPath(registryRoot), libraries: libraries.map((library) => ({ id: library.id, path: library.root, default: library.isDefault, valid: library.valid })) } as PsJsonValue,
      humanText: ['Libraries on this machine (* is the default, which `deskpost` opens from anywhere):', ...lines].join('\n'),
    };
  }
  if (action === 'default') {
    const folder = parsed.positional[1];
    if (!folder) return { refusal: `${COMMAND_NAME} library default needs the Library's folder: ${COMMAND_NAME} library default <folder>.`, value: null };
    const root = findWorkspaceByMarker(folder);
    if (!root) return { refusal: `${folder} is not inside a Library, so it cannot be the default. Make it one with ${COMMAND_NAME} setup ${folder}.`, value: null };
    const id = markerField(readMarker(root), 'id');
    if (!id.trim()) return { refusal: `${root} has a Library marker with no id, so it cannot be registered; repair it with ${COMMAND_NAME} setup ${root} --repair.`, value: null };
    const registration = registerWorkspace(root, id, registryRoot, true);
    return {
      refusal: null,
      value: { schema: 1, operation: 'Set the default Library', workspace: root, registry: registration.path, registration: registration.action, default: true } as PsJsonValue,
      humanText: `${root} is your default Library: \`${COMMAND_NAME}\` opens it from anywhere outside a Library.`,
    };
  }
  if (action === 'card') return libraryCardAction(parsed);
  // THE REFUSAL NAMES EVERY ACTION THE VERB TABLE DECLARES (kickoffs/s147 row 1): `forget` is routed by cli.ts before this.
  return { refusal: `${COMMAND_NAME} library has no action '${action}'. It has: ${(VERBS['library']?.actions ?? []).join(', ')}.`, value: null };
}

/**
 * A CARD IS A LABEL (kickoffs/s121 row 8; PLAN-many-libraries.md Stage 1 item 1): letters, digits, spaces and a few marks,
 * up to 60 characters. It is never a credential and never an address -- the marker's `id` stays the identity -- so it
 * takes no slash, colon or other character a path or address would need, and nothing finds a Library on disk by it.
 */
const LIBRARY_CARD = /^[\p{L}\p{N}][\p{L}\p{N} '._&()-]{0,59}$/u;

/** `deskpost library card [--set <name> (--preflight | --user-confirmed --plan-id <id>)] [--workspace <path>]`. */
function libraryCardAction(parsed: ReturnType<typeof parseArguments>): { refusal: string | null; value: PsJsonValue | null; humanText?: string } {
  let root: string;
  try {
    root = requireWorkspace({ explicit: parsed.options.get('workspace'), registryRoot: parsed.options.get('registry-root') });
  } catch (error) {
    return { refusal: `${COMMAND_NAME} library card reads a Library's own marker: ${(error as Error).message}`, value: null };
  }
  const marker = readMarker(root);
  const id = markerField(marker, 'id');
  if (marker === null || !id.trim()) return { refusal: `${root} has no Library marker with an id, so it has no card; repair it with ${COMMAND_NAME} setup ${root} --repair.`, value: null };
  const current = markerField(marker, 'card').trim();
  const wantsSet = parsed.options.has('set');
  if (!wantsSet) {
    if (parsed.flags.has('preflight') || parsed.flags.has('user-confirmed') || parsed.options.has('plan-id')) {
      return { refusal: `${COMMAND_NAME} library card takes --preflight, --user-confirmed and --plan-id only with --set <name>.`, value: null };
    }
    return {
      refusal: null,
      value: { schema: 1, operation: 'Library card', workspace: root, id, card: current || null } as PsJsonValue,
      humanText: current
        ? `This Library's card is '${current}' (id ${id}).`
        : `This Library has no card yet (id ${id}). Give it one with ${COMMAND_NAME} library card --set <name> --preflight.`,
    };
  }
  const proposed = (parsed.options.get('set') ?? '').trim();
  if (!LIBRARY_CARD.test(proposed)) {
    return {
      refusal: `'${proposed}' cannot be a Library card: use letters, digits, spaces and . ' _ & ( ) -, starting with a letter or digit, up to 60 characters. A card is a label, never an address. Nothing was written.`,
      value: null,
    };
  }
  const planId = 'library-card-' + sha256OfText(`${root}|${id}|${current}|${proposed}`);
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Set the Library card',
    workspace: root,
    id,
    current_card: current || null,
    proposed_card: proposed,
    unchanged: current === proposed,
    plan_id: planId,
    confirmation_required: true,
    note: "A card is this Library's display name, shown on the Desk, in owner status and to other Libraries. It is a label: the id stays the identity, and the card is never an address or a credential.",
  };
  if (parsed.flags.has('preflight')) {
    return { refusal: null, value: { ...plan, written: false } as PsJsonValue, humanText: `Would set this Library's card to '${proposed}'${current ? ` (now '${current}')` : ''}. Apply with --user-confirmed --plan-id ${planId}.` };
  }
  if (!parsed.flags.has('user-confirmed') || (parsed.options.get('plan-id') ?? '').trim() !== planId) {
    return {
      refusal: `${COMMAND_NAME} library card --set needs --preflight first, then --user-confirmed --plan-id <its plan_id>. A different plan_id means the card changed since the preview. Nothing was written.`,
      value: null,
    };
  }
  if (current !== proposed) {
    // INSIDE THE MARKER LOCK, from the marker as read there (kickoffs/s161 row 1): a card or id changed since the preview
    // is refused as the plan_id would be, and a field another writer added meanwhile is kept.
    const changed = withMarkerLock(root, (fresh) => {
      if (fresh === null || markerField(fresh, 'id') !== id || markerField(fresh, 'card').trim() !== current) {
        return `${markerPath(root)} changed since the preview, so the card was not written. Preview it again with --preflight.`;
      }
      writeAtomicText(markerPath(root), psConvertToJson({ ...fresh, card: proposed } as PsJsonValue) + '\n');
      return null;
    });
    if (changed !== null) return { refusal: changed, value: null };
    if (markerField(readMarker(root), 'card') !== proposed || markerField(readMarker(root), 'id') !== id) {
      return { refusal: `The card was written to ${markerPath(root)} and did not read back as written. Check the marker.`, value: null };
    }
  }
  return { refusal: null, value: { ...plan, written: current !== proposed } as PsJsonValue, humanText: `This Library's card is '${proposed}' (id ${id}).` };
}


/** One-line menu flags have no quoting grammar: CLI settings preserves richer argv. */
export function splitMenuFlags(line: string): string[] { return line.trim() ? line.trim().split(/\s+/) : []; }
async function launchSettingsScreen(state: MenuState, row: MenuRow): Promise<void> {
  const { talk, workspace } = state;
  const settings = (extra: Record<string, unknown> = {}) => seatSettingsResult({ workspace, seat: row.seat, preflight: false, planId: '', transcriptRoot: state.options.transcriptRoot, fallbackAssistant: state.assistant ?? 'claude', ...extra });
  const showLaunch = (value: Record<string, PsJsonValue>) => talk.say('Planned launch: ' + String(value['launch_line']));
  for (;;) {
    try {
      const current = settings();
      const preview = seatLaunchPreview(workspace, row.seat, undefined, state.assistant ?? 'claude', 'resume', state.options.transcriptRoot);
      talk.say('Seat ' + row.seat + ': assistant ' + (current['assistant'] ?? 'menu default'));
      const flags = current['flags_preview'] as Record<string, string>;
      const approvals = current['approvals'] as Record<string, { utc: string; plan_id: string } | null> | null;
      for (const assistant of ['claude', 'codex'] as const) {
        talk.say('  ' + ASSISTANT_LABEL[assistant] + ' flags: ' + (flags[assistant] || '(none)'));
        const approval = approvals?.[assistant];
        if (approval) talk.say('    approved ' + approval.utc + ' (plan ' + approval.plan_id.slice(0, 24) + ')');
      }
      if (current['launch_record_ignored']) talk.say('Ignored launch record: ' + String(current['launch_record_ignored']));
      talk.say('Planned launch: ' + escapedArgv([preview.command, ...preview.args]));
      const key = (await talk.ask('[a] assistant  [f] flags  [c] copy flags  [x] clear flags  [r] reset launch  [q] back › ')).toLowerCase();
      if (key === 'q' || key === '') return;
      if (key === 'a') {
        const assistant = (await talk.ask('Assistant: claude, codex or none › ')).toLowerCase();
        const changed = settings({ assistant });
        talk.say('Assistant saved: ' + (changed['assistant'] ?? 'menu default'));
        showLaunch(changed); continue;
      }
      if (!['f', 'c', 'x', 'r'].includes(key)) { talk.say('Use a key above.'); continue; }
      let change: Record<string, unknown>;
      if (key === 'r') change = { resetLaunch: true };
      else {
        const savedAssistant = settings()['assistant'];
        const assistant = savedAssistant ? String(savedAssistant) : (await talk.ask('Flags for claude or codex › ')).toLowerCase();
        if (assistant !== 'claude' && assistant !== 'codex') { talk.say('Name claude or codex.'); continue; }
        if (key === 'x') change = { clearFlags: assistant };
        else {
          let args: string[];
          if (key === 'c') {
            const seats = readRegistryRows(registryFilePath(path.join(workspace, '.claude'))).flatMap(entry => {
              const seat = String(entry['seat']);
              const read = readSeatLaunch(path.join(workspace, '.claude'), seat, String(entry['seat_id'] ?? ''));
              return read.state === 'valid' && read.record.args[assistant].length ? [{ seat, args: read.record.args[assistant] }] : [];
            });
            talk.say('Copy from a live registered seat: ' + seats.map(s => s.seat).join(', '));
            const name = await talk.ask('Seat name (q cancels) › ');
            if (name === 'q') continue;
            const source = seats.find(s => s.seat === name);
            if (!source) { talk.say('That seat has no valid stored flags for this assistant.'); continue; }
            args = [...source.args];
          } else {
            talk.say('Enter one line split on whitespace, with no quoting. Use seat settings --flags from the command line for a value with spaces or quotes.');
            args = splitMenuFlags(await talk.ask('Flags › '));
          }
          change = { flags: assistant, args };
        }
      }
      const proposed = settings({ ...change, preflight: true });
      const proposedFlags = proposed['proposed_flags'] as Record<string, string> | null;
      if (proposedFlags) for (const assistant of ['claude', 'codex'] as const) talk.say('  ' + ASSISTANT_LABEL[assistant] + ' flags after this change: ' + (proposedFlags[assistant] || '(none)'));
      else talk.say('Reset the assistant and both assistants\' flags.');
      showLaunch(proposed);
      talk.say('Preview: ' + String(proposed['plan_id']));
      const approve = await talk.ask('[Enter] apply this preview  [q] cancel › ');
      if (approve === '') { const changed = settings({ ...change, planId: String(proposed['plan_id']) }); talk.say('Launch settings saved.'); showLaunch(changed); }
      else talk.say('Nothing was changed.');
    } catch (error) { talk.say((error as Error).message); }
  }
}
