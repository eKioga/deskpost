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
import type { PsJsonValue } from './psjson.ts';
import { findWorkspaceByMarker, markerField, readMarker, readTextFile, registryPath, requireWorkspace, toWorkspaceRoot } from './workspace.ts';
import { registerWorkspace } from './init.ts';
import { COMMAND_NAME, findAssistant } from './machine.ts';
import { getSeatClaimState, readSeatActivity } from './seatclaim.ts';
import { deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { activeProjects, newSeatVerdict, retireSeat, SeatPlanChanged, seatRegistryRows, startSeat } from './seat.ts';
import { ASSISTANT_LABEL, conversationCell, newConversationId, seatConversationView, type Assistant, type ConversationView } from './conversation.ts';
import { runHubVerb } from './collection.ts';
import { markerConnection } from './basicmemory.ts';
import { psSortCompare } from './notebook.ts';
import { askAtTerminal, Interrupted } from './prompt.ts';

// --- the conversation with the reader -------------------------------------------------------------------------------

class MenuQuit extends Error {}

export interface Talk {
  scripted: boolean;
  say: (text?: string) => void;
  ask: (prompt: string) => Promise<string>;
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
  view: ConversationView;
}

/** One row per registered seat, sorted by name, numbered from 1. One unreadable seat does not take the roster down. */
export function menuRows(workspace: string, options: { transcriptRoot?: string; skipTitles?: boolean } = {}): MenuRow[] {
  const stateDirectory = path.join(workspace, '.claude');
  const entries = [...seatRegistryRows(workspace)].sort((left, right) => psSortCompare(String(left['seat']), String(right['seat'])));
  return entries.map((entry, position) => {
    const seat = String(entry['seat']);
    const row: MenuRow = {
      index: position + 1,
      seat,
      project: String(entry['project'] ?? ''),
      state: 'unreadable',
      state_note: '',
      agent_pid: 0,
      last_active_utc: '',
      view: {
        session_id: '', conversation_source: 'none', recorded_utc: '', assistant: 'claude', title: '', title_status: 'no-conversation',
        title_note: 'nothing has recorded a conversation at this seat', entry_action: 'none', entry_note: '',
      },
    };
    try {
      const state = getSeatClaimState(stateDirectory, seat);
      row.state = state.state;
      row.agent_pid = Number(state.agentPid) || 0;
      if (state.state === 'orphaned') row.state_note = `agent ${row.agent_pid} alive, claim holder gone`;
      const activity = readSeatActivity(stateDirectory, seat);
      if (activity && typeof activity['last_seen_utc'] === 'string') row.last_active_utc = activity['last_seen_utc'];
      row.view = seatConversationView(stateDirectory, seat, { transcriptRoot: options.transcriptRoot, skipTitle: options.skipTitles });
    } catch (error) {
      row.state = 'unreadable';
      row.state_note = (error as Error).message;
    }
    return row;
  });
}

// --- the shape of one render: width, alphabet, colour ---------------------------------------------------------------

export const CARD_BREAKPOINT = 120;

interface Glyphs {
  ascii: boolean;
  tl: string; tr: string; bl: string; br: string; h: string; v: string; sep: string;
  held: string; free: string; other: string; ellipsis: string; dot: string;
}

const ASCII_GLYPHS: Glyphs = { ascii: true, tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', sep: '-', held: '*', free: 'o', other: '!', ellipsis: '...', dot: '-' };
const UNICODE_GLYPHS: Glyphs = {
  ascii: false, tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', sep: '─',
  held: '●', free: '○', other: '▲', ellipsis: '…', dot: '·',
};

interface Palette { reset: string; dim: string; bold: string; held: string; free: string; other: string; frame: string; accent: string }

const NO_COLOUR: Palette = { reset: '', dim: '', bold: '', held: '', free: '', other: '', frame: '', accent: '' };
const E = '\x1b[';
const COLOUR: Palette = {
  reset: `${E}0m`, dim: `${E}2m`, bold: `${E}1m`, held: `${E}38;5;179m`, free: `${E}38;5;108m`, other: `${E}38;5;131m`, frame: `${E}38;5;66m`, accent: `${E}38;5;180m`,
};

export interface RenderPlan {
  width: number;
  plain: boolean;
  glyphs: Glyphs;
  palette: Palette;
  mode: 'table' | 'cards';
}

/**
 * Width, alphabet, colour and layout for one render. A REDIRECTED RUN IS A CAPTURED RUN: plain ASCII and no colour, so a
 * suite, a pipe and a transcript read the same bytes on any machine. Box drawing and the state marks are drawn where
 * the terminal renders them (step 0, measurement 4): off Windows, inside Windows Terminal, or in Orca's terminal.
 * NO_COLOR is honoured on its presence. The table is abandoned for cards below 120 columns, and wherever it would not
 * fit, because cutting its last column deletes the title the reader is choosing between (SeatPicker.ps1, 2026-09-11).
 */
export function renderPlan(options: { width?: number; plain?: boolean }, tableWidth = 0): RenderPlan {
  const plain = options.plain === true || process.stdout.isTTY !== true;
  const capable = process.platform !== 'win32' || Boolean(process.env['WT_SESSION'] || process.env['ORCA_TERMINAL_HANDLE'] || process.env['TERM_PROGRAM']);
  const width = options.width && options.width > 0 ? options.width : process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
  const mode = width < CARD_BREAKPOINT || (tableWidth > 0 && tableWidth > width) ? 'cards' : 'table';
  return {
    width,
    plain,
    glyphs: plain || !capable || process.env['DESKPOST_ASCII'] ? ASCII_GLYPHS : UNICODE_GLYPHS,
    palette: plain || process.env['NO_COLOR'] !== undefined ? NO_COLOUR : COLOUR,
    mode,
  };
}

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

function fit(text: string, width: number, glyphs: Glyphs): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= glyphs.ellipsis.length) return text.substring(0, width);
  return text.substring(0, width - glyphs.ellipsis.length).trimEnd() + glyphs.ellipsis;
}

function lastActive(row: MenuRow): string {
  if (!row.last_active_utc.trim()) return 'never active';
  const at = new Date(row.last_active_utc);
  if (Number.isNaN(at.getTime())) return row.last_active_utc;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function stateCell(row: MenuRow): string {
  return row.state_note.trim() ? `${row.state} (${row.state_note})` : row.state;
}

function stateMark(state: string, glyphs: Glyphs, palette: Palette): { mark: string; color: string } {
  if (state === 'held') return { mark: glyphs.held, color: palette.held };
  if (state === 'free') return { mark: glyphs.free, color: palette.free };
  return { mark: glyphs.other, color: palette.other };
}

/** A Codex conversation says so on its row; a Claude Code one is the unmarked case, as every pre-1.1 one is. */
function conversationText(row: MenuRow, glyphs: Glyphs): string {
  const cell = conversationCell(row.view, glyphs.ellipsis);
  return row.view.assistant === 'codex' && row.view.session_id ? `${cell} [Codex]` : cell;
}

/** The numbered table lines. THE CELLS ARE BUILT BEFORE THE WIDTHS ARE MEASURED, so a state note cannot misalign them. */
export function tableLines(rows: MenuRow[], glyphs: Glyphs): string[] {
  const cells = rows.map((row) => ({ index: row.index, seat: row.seat, project: row.project, state: stateCell(row), last: lastActive(row), says: conversationText(row, glyphs) }));
  const width = (key: 'seat' | 'project' | 'state' | 'last') => Math.max(0, ...cells.map((cell) => cell[key].length));
  const widths = { seat: width('seat'), project: width('project'), state: width('state'), last: width('last') };
  return cells.map(
    (cell) =>
      `  ${String(cell.index).padStart(2)}  ${cell.seat.padEnd(widths.seat)}  ${cell.project.padEnd(widths.project)}  ${cell.state.padEnd(widths.state)}  ${cell.last.padEnd(widths.last)}  ${cell.says}`,
  );
}

/** One card per seat. NO LINE IS SIZED FROM ANOTHER ROW, and the number sits at a fixed column on every card. */
export function cardLines(rows: MenuRow[], width: number, glyphs: Glyphs, palette: Palette): string[] {
  const lines: string[] = [];
  const labelWidth = 9;
  const indent = 8;
  const room = Math.max(12, width - indent - labelWidth - 1);
  for (const row of rows) {
    const marker = stateMark(row.state, glyphs, palette);
    // THE PLAIN HEAD IS MEASURED, NOT THE COLOURED ONE: an escape has no visible width.
    const prefix = `  ${String(row.index).padStart(2)} ${marker.mark} `;
    const seat = fit(row.seat, width - prefix.length - row.state.length - 2, glyphs);
    const gap = Math.max(1, width - prefix.length - seat.length - row.state.length - 1);
    lines.push(`  ${String(row.index).padStart(2)} ${marker.color}${marker.mark}${palette.reset} ${palette.bold}${seat}${palette.reset}${' '.repeat(gap)}${marker.color}${row.state}${palette.reset}`);
    const fields: [string, string][] = [];
    if (row.state_note.trim()) fields.push(['Note', row.state_note]);
    fields.push(['Project', row.project], ['Last', lastActive(row)], ['Says', conversationText(row, glyphs)]);
    for (const [label, value] of fields) lines.push(`${' '.repeat(indent)}${palette.dim}${label.padEnd(labelWidth)}${palette.reset}${fit(value, room, glyphs)}`);
    lines.push('');
  }
  return lines;
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

/** The tools under the list, worded once. `b` is a reserved slot (step 5a). */
export function footerLines(both: boolean, assistant: Assistant | null): string[] {
  // `h` IS PERMANENT (PLAN-assistant-onboarding.md step 5; Codex #13): no state decides whether it is offered, so an
  // aborted first start -- trust refused, a launch that failed, an empty conversation -- never loses it.
  const lines = ['  +  new seat     h  Show me around     b  Basic Memory     q  quit'];
  const second = ['  n<number>  new conversation', '   r<number>  retire'];
  if (both && assistant) second.push(`   a  new conversations use ${ASSISTANT_LABEL[assistant]}; a switches to ${ASSISTANT_LABEL[assistant === 'claude' ? 'codex' : 'claude']}`);
  lines.push(second.join(''));
  return lines;
}

export const FIRST_HINT = 'Pick a seat to continue its last session, or n<number> for a new one.';

// --- the choice grammar ---------------------------------------------------------------------------------------------

export interface Choice {
  action: 'resume' | 'new' | 'retire' | 'create' | 'basic-memory' | 'help' | 'switch' | 'quit' | 'reprompt' | 'invalid' | 'out-of-range';
  index: number;
  reason: string;
}

/**
 * What one typed line means. EVERY REFUSAL HAS ITS OWN REASON, because they need different next moves. Case does not
 * matter: `N1` and `Q` are a person typing, not a rule about stored state.
 */
export function resolveChoice(typed: string, rowCount: number): Choice {
  const text = typed.trim();
  if (!text) return { action: 'reprompt', index: 0, reason: 'nothing was typed' };
  if (/^q(uit)?$/i.test(text)) return { action: 'quit', index: 0, reason: '' };
  if (text === '+') return { action: 'create', index: 0, reason: '' };
  if (/^b$/i.test(text)) return { action: 'basic-memory', index: 0, reason: '' };
  if (/^h$/i.test(text)) return { action: 'help', index: 0, reason: '' };
  if (/^a$/i.test(text)) return { action: 'switch', index: 0, reason: '' };
  let action: Choice['action'] = 'resume';
  let digits = text;
  if (/^n\s*\d+$/i.test(text)) {
    action = 'new';
    digits = text.substring(1).trim();
  } else if (/^r\s*\d+$/i.test(text)) {
    action = 'retire';
    digits = text.substring(1).trim();
  } else if (!/^\d+$/.test(text)) {
    return { action: 'invalid', index: 0, reason: `'${text}' is not one of the commands: a number, n<number>, r<number>, +, h, b or q` };
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
}

function write(state: { talk: Talk }, plan: RenderPlan, line: string): void {
  state.talk.say(plan.plain ? plainText(line) : line);
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
  const state: MenuState = { workspace, talk, options, ...found };
  try {
    return await menuLoop(state);
  } catch (error) {
    if (error instanceof MenuQuit) {
      talk.say(error.message);
      return 0;
    }
    throw error;
  }
}

async function menuLoop(state: MenuState): Promise<number> {
  const { talk, workspace } = state;
  let bannerDrawn = false;
  let hinted = false;
  for (;;) {
    const rows = menuRows(workspace, { transcriptRoot: state.options.transcriptRoot });
    // FIRST TIME, WITH NO SEATS: THE FORK, whatever route made the Library (PLAN-assistant-onboarding.md step 5, amending
    // ADR-0059's "only the wizard"): an assistant's install reaches the same Show me around a terminal install offers.
    if (!rows.length) {
      talk.say(`\n  Library  ${workspace}`);
      talk.say('\nThis Library has no seats yet. A seat is a place to work, with its own Desk and one Project.');
      // `h` IS SHOWN AS WELL AS ENTER (S58 #6): the closing words say "`h`, or Enter", and `h` is the key every later menu
      // offers Show me around on, so the first screen teaches the key that keeps working.
      talk.say(`  [h, Enter] Show me around   a ${HELP_SEAT} seat with the Librarian as your guide`);
      talk.say('  [+]        Your first seat  name a project, and start working in it');
      talk.say('  [q]        Later');
      for (;;) {
        const key = (await talk.ask('› ')).toLowerCase();
        if (key === 'q') {
          talk.say(`Nothing was created. Type \`${COMMAND_NAME}\` whenever you are ready.`);
          return 0;
        }
        if (key === '' || key === 'h') {
          const shown = await showMeAround(state);
          if (shown !== null) return shown;
          return 0;
        }
        if (key === '+') {
          const started = await wizard(state, true);
          return started ?? 0;
        }
        talk.say(`'${key}' is not one of the keys above.`);
      }
    }
    // SHOW ME AROUND IS PROMINENT UNTIL ITS SEAT EXISTS; after that it stays in the footer.
    const helpSeatExists = rows.some((row) => row.seat === HELP_SEAT);
    const measured = renderPlan(state.options);
    const plan = renderPlan(state.options, Math.max(0, ...tableLines(rows, measured.glyphs).map((line) => line.length)));
    if (!bannerDrawn) {
      for (const line of bannerLines(plan.width, plan.glyphs, plan.palette, rows.length, rows.filter((row) => row.state === 'held').length)) write(state, plan, line);
      write(state, plan, `  Library  ${workspace}`);
      if (!helpSeatExists) write(state, plan, `  h  Show me around   a ${HELP_SEAT} seat with the Librarian as your guide`);
      bannerDrawn = true;
    }
    write(state, plan, '');
    if (plan.mode === 'cards') {
      for (const line of cardLines(rows, plan.width, plan.glyphs, plan.palette)) write(state, plan, line);
    } else {
      write(state, plan, 'Seats in this Library:');
      for (const line of tableLines(rows, plan.glyphs)) write(state, plan, line);
      write(state, plan, '');
    }
    for (const line of footerLines(state.claude && state.codex, state.assistant)) write(state, plan, line);
    if (!hinted) {
      write(state, plan, FIRST_HINT);
      hinted = true;
    }
    const choice = resolveChoice(await talk.ask('Seat › '), rows.length);
    const target = choice.index > 0 ? rows[choice.index - 1]! : null;
    switch (choice.action) {
      case 'quit':
        talk.say('No seat was chosen.');
        return 0;
      case 'create': {
        const started = await wizard(state, false);
        if (started !== null) return started;
        break;
      }
      case 'retire':
        await retire(state, target!);
        break;
      case 'basic-memory':
        await basicMemory(state);
        break;
      case 'help': {
        const shown = await showMeAround(state);
        if (shown !== null) return shown;
        break;
      }
      case 'switch':
        if (state.claude && state.codex) {
          state.assistant = state.assistant === 'claude' ? 'codex' : 'claude';
          talk.say(`New conversations now use ${ASSISTANT_LABEL[state.assistant]}.`);
        } else talk.say(state.assistant ? `Only ${ASSISTANT_LABEL[state.assistant]} is found here, so there is nothing to switch to.` : NO_ASSISTANT);
        break;
      case 'resume':
      case 'new': {
        const started = await sitDown(state, target!, choice.action);
        if (started !== null) return started;
        break;
      }
      default:
        talk.say(choice.reason);
    }
  }
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
  const refusal = occupied(row);
  if (refusal) {
    talk.say(refusal);
    return null;
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
    const result = await preview(state, { seat, slug, title, projects, first });
    if (result === 'again') continue;
    if (result === 'cancel') return first ? 0 : null;
    return result;
  }
}

async function preview(
  state: MenuState,
  plan: { seat: string; slug: string; title: string; projects: string[]; first: boolean },
): Promise<number | 'again' | 'cancel'> {
  const { talk, workspace } = state;
  let projects = plan.projects;
  for (;;) {
    const hubExists = projects.includes(plan.slug);
    const verdict = newSeatVerdict(workspace, plan.seat, plan.slug, hubExists ? projects : [...projects, plan.slug]);
    if (!verdict.creatable) {
      talk.say(verdict.reason);
      return 'again';
    }
    const local = String((readMarker(workspace) ?? {})['backend'] ?? '') === 'local';
    talk.say('');
    talk.say(`Create seat '${plan.seat}' for Project '${plan.slug}'.`);
    talk.say(`  Hub        projects/${plan.slug}${hubExists ? ' (it exists, and is reused)' : `, titled "${plan.title}" (new)`}`);
    talk.say(`  Desk       ${deskStateDirectory(path.join(workspace, '.claude'), plan.seat)}, with projects/${plan.slug} open`);
    talk.say(`  Librarian  ${state.assistant ? ASSISTANT_LABEL[state.assistant] : 'none found: the seat is made, and nothing is started'}`);
    talk.say(`  Touches    ${hubExists || local ? 'this Library only; no other seat' : 'the SHARED collection, for the Hub; no other seat'}`);
    talk.say(`  plan_id    ${verdict.plan_id}`);
    const firstStart = plan.first ? firstStartLine(state.assistant) : null;
    if (firstStart) talk.say(`  ${firstStart}`);
    const keys = ['[Enter] create it and start', ...(state.claude && state.codex ? [`[a] use ${ASSISTANT_LABEL[state.assistant === 'claude' ? 'codex' : 'claude']}`] : []), '[q] cancel'];
    const key = (await talk.ask(keys.join('   ') + ' › ')).toLowerCase();
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
      talk.say(`  ${COMMAND_NAME} hub new ${plan.slug} --title "${plan.title}"`);
      const made = await runHubVerb(['new', plan.slug, '--title', plan.title, '--workspace', workspace], workspace);
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
    const args = [plan.seat, '--project', plan.slug, '--plan-id', verdict.plan_id];
    talk.say(`  ${COMMAND_NAME} seat start ${args.join(' ')}`);
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
 * `b`, A RESERVED SLOT (step 5a). In 1.1 it says what Basic Memory is for, or, with one set up, which server; everything
 * behind it -- import, copying out, opening shared, the set-up conversation -- is its own plan.
 */
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
  const state: MenuState = { workspace, talk, options: { cwd: workspace, registryRoot: options.registryRoot }, ...found };
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
  const verdict = seatRow ? null : newSeatVerdict(workspace, HELP_SEAT, HELP_SEAT, hubExists ? projects : [...projects, HELP_SEAT]);
  if (verdict !== null && !verdict.creatable) {
    talk.say(`${verdict.reason} Nothing was created.`);
    return null;
  }
  // AN EXISTING SEAT RESUMES; the tour prompt goes only to a conversation that recorded nothing, or a first one.
  const view = row?.view;
  const resumable = view !== undefined && Boolean(view.session_id) && view.entry_action === 'resume' && view.assistant === state.assistant;
  const local = String((readMarker(workspace) ?? {})['backend'] ?? '') === 'local';
  talk.say('');
  talk.say(`  Hub   projects/${HELP_SEAT}, "${HELP_TITLE}"${hubExists ? ' (it exists, and is reused)' : ' (new)'}`);
  talk.say(`  Seat  ${HELP_SEAT}${seatRow ? ' (it exists, and is reused)' : ' (new)'}`);
  if (!hubExists && !local) talk.say('  Touches  the SHARED collection, for the Hub (this Library reads Basic Memory)');
  talk.say(`  Then  ${ASSISTANT_LABEL[state.assistant]} ${resumable ? 'resumes your last conversation there' : 'starts there, as your guide'}`);
  const firstStart = firstStartLine(state.assistant);
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
  } else if (view !== undefined && view.session_id && view.entry_action === 'restart' && view.assistant === state.assistant) {
    args = [HELP_SEAT, '--session-id', view.session_id];
  } else {
    args = seatRow ? [HELP_SEAT] : [HELP_SEAT, '--project', HELP_SEAT, '--plan-id', verdict!.plan_id];
    if (state.assistant === 'claude') args.push('--session-id', newConversationId());
  }
  talk.say(`  ${COMMAND_NAME} seat start ${args.join(' ')}`);
  try {
    return await launch(state, args, state.assistant, passthrough);
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
  const parsed = parseArguments(argv, ['workspace', 'registry-root', 'width', 'transcript-root', 'assistant', 'script', 'cwd']);
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
    if (script === null && !interactive()) return { refusal: nonInteractiveRefusal(options), exitCode: 1 };
    return { refusal: null, exitCode: await runMenu(options, makeTalk(script)) };
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1 };
  }
}

/** `deskpost setup --welcome --workspace <Library> [--assistant <a>] [--script <file>]`: the fork install.ps1 ends on. */
export async function runWelcomeVerb(argv: string[]): Promise<MenuVerbResult> {
  const parsed = parseArguments(argv, ['workspace', 'assistant', 'script', 'registry-root']);
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

// --- deskpost library default ---------------------------------------------------------------------------------------

/** `deskpost library [list | default <folder>]`: the registered Libraries, and which one bare `deskpost` opens. */
export function runLibraryVerb(argv: string[]): { refusal: string | null; value: PsJsonValue | null; humanText?: string } {
  const parsed = parseArguments(argv, ['registry-root']);
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
  return { refusal: `${COMMAND_NAME} library has no action '${action}'. It has: default, list.`, value: null };
}
