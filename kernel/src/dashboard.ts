/** Read-only presentation of the existing seat-scoped Desk overview. */
import type { PsJsonValue } from './psjson.ts';
import { deskOverview, readSeatRegistry } from './desk.ts';
import { isDevHubBody, nextShownLines, removeFrontmatter, toLines } from './hubedit.ts';
import { handbackOutcome } from './kickoff.ts';
import { deskEntriesForSeat } from './seatdesk.ts';
import { daysBetween, frontCar, localDate, readTrain } from './train.ts';
import { readNeedsYou } from './needsyou.ts';
import { readUpdateRecord } from './upgrade.ts';
import { installRootOf } from './machine.ts';
import { programRoot } from './programroot.ts';
import { compareVersions } from './versions.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateCheckpoint } from './checkpointverb.ts';
import { checkpointView } from './checkpoint.ts';

type ObjectValue = Record<string, PsJsonValue>;
const object = (value: PsJsonValue | undefined): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: PsJsonValue | undefined): PsJsonValue[] => Array.isArray(value) ? value : [];
// Overview labels are data, including in a terminal. Never interpret control sequences in them.
const label = (value: PsJsonValue | undefined): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '') : '';

export const DEFAULT_DASHBOARD_WIDTH = 80;
export type DashboardColor = 'none' | '256' | 'truecolor';
const RESET = '\x1b[0m';
// Nearest xterm-256 palette entries by RGB distance, including its grayscale ramp.
const ROLES = {
  label: { rgb: [108, 112, 134], index: 243 },
  name: { rgb: [205, 214, 244], index: 189 },
  zero: { rgb: [166, 173, 200], index: 146 },
  attention: { rgb: [250, 179, 135], index: 216 },
  held: { rgb: [166, 227, 161], index: 151 },
} as const;
type Role = keyof typeof ROLES;
type Run = { text: string; role: Role };
type Line = Run[];
const run = (text: string, role: Role = 'name'): Run => ({ text, role });
const plain = (line: Line): string => line.map(part => part.text).join('');

export function dashboardColor(tty: boolean, env: { NO_COLOR?: string; COLORTERM?: string }): DashboardColor {
  if (!tty || Boolean(env.NO_COLOR)) return 'none';
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' ? 'truecolor' : '256';
}

export function dashboardWidth(width: number | undefined, columns?: number): number {
  const resolved = Number.isInteger(width) && width! >= 0 ? width! : Number.isInteger(columns) && columns! > 0 ? columns! : DEFAULT_DASHBOARD_WIDTH;
  const requested = resolved || 30;
  return Number.isInteger(columns) && columns! > 0 ? Math.min(requested, columns!) : requested;
}

// W/F intervals from EastAsianWidth-18.0.0.txt; combining marks are handled first.
// Source: https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt (Unicode data license).
const WIDE_CELLS: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2630, 0x2637], [0x2648, 0x2653], [0x267f, 0x267f], [0x268a, 0x268f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5],
  [0x2ff0, 0x303e], [0x3041, 0x3096], [0x3099, 0x30ff], [0x3105, 0x312f],
  [0x3131, 0x318e], [0x3190, 0x31e5], [0x31ef, 0x321e], [0x3220, 0x3247],
  [0x3250, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe52], [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff6], [0x17000, 0x18cda], [0x18cff, 0x18d20], [0x18d80, 0x18df2],
  [0x18e00, 0x19191], [0x191a0, 0x191d2], [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe], [0x1b000, 0x1b128], [0x1b132, 0x1b132], [0x1b150, 0x1b152],
  [0x1b155, 0x1b155], [0x1b164, 0x1b168], [0x1b170, 0x1b2fb], [0x1d300, 0x1d356],
  [0x1d360, 0x1d376], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f1ae, 0x1f1ae], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d9], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc],
  [0x1f7da, 0x1f7da], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fac6],
  [0x1fac8, 0x1fac8], [0x1facc, 0x1fadd], [0x1fadf, 0x1faeb], [0x1faef, 0x1fafa],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** The one width measure used by fitting, wrapping and cursor placement. */
export function dashboardCells(text: string): number {
  let cells = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, '')) {
    if (/\p{Mark}/u.test(char)) continue;
    const code = char.codePointAt(0)!;
    const wide = WIDE_CELLS.some(([start, end]) => code >= start && code <= end);
    cells += wide ? 2 : 1;
  }
  return cells;
}

function paint(line: Line, color: DashboardColor): string {
  if (color === 'none') return plain(line);
  return line.map(part => {
    const role = ROLES[part.role];
    const ink = color === 'truecolor' ? `38;2;${role.rgb.join(';')}` : `38;5;${role.index}`;
    return `\x1b[${part.role === 'attention' ? '1;' : part.role === 'label' ? '2;' : ''}${ink}m${part.text}${RESET}`;
  }).join('') + RESET;
}

function join(items: Line[], gap: string): Line {
  return items.flatMap((item, index) => index ? [run(gap), ...item] : item);
}

/** Cut by terminal cells, preserving color roles and whole characters. */
function clip(line: Line, width: number): Line {
  const result: Line = [];
  let used = 0;
  for (const part of line) for (const char of part.text) {
    used += dashboardCells(char);
    if (used > width) return result;
    result.push(run(char, part.role));
  }
  return result;
}

/** Narrow panes cut a logical line; wider panes wrap an item that exceeds the pane. */
function wrap(line: Line, width: number): Line[] {
  if (width < 30) return [clip(line, width)];
  const lines: Line[] = [];
  let current: Line = [];
  for (const part of line) {
    for (const token of part.text.split(/(\s+)/).filter(Boolean)) {
      if (dashboardCells(plain(current) + token) > width && current.length) {
        lines.push(current); current = [];
      }
      if (!current.length && /^\s+$/.test(token)) continue;
      for (const char of token) {
        if (dashboardCells(plain(current) + char) > width) { lines.push(current); current = []; }
        current.push(run(char, part.role));
      }
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

/** Unknown or invalid capture dates never acquire a guessed age. */
export function dashboardAge(stamp: PsJsonValue | undefined, now: number): string {
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(stamp)) return 'unknown';
  const time = Date.parse(stamp);
  if (!Number.isFinite(time) || time > now) return 'unknown';
  const seconds = Math.floor((now - time) / 1000);
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return '<1 min';
}

function namesLine(title: string, names: Run[], width: number, strip: boolean): Line {
  const prefix = run(strip ? title === 'Books' ? 'Books  ' : 'Hubs   ' : `${title}: `, 'label');
  if (!names.length) return [prefix, run('none', 'zero')];
  // Remove entire names, including a single name wider than the pane. Never slice a slug.
  for (let keep = names.length; keep >= 0; keep--) {
    const shown = names.slice(0, keep).map(name => [name]);
    if (keep < names.length) shown.push([run(`+${names.length - keep} more`, 'label')]);
    const line = [prefix, ...join(shown, strip ? '  ' : ', ')];
    if (dashboardCells(plain(line)) <= width) return line;
  }
  return [prefix, run(`+${names.length} more`, 'label')];
}

export type DashboardCheckpoint = { conversation: string; record_at: string; save: string; closeout: string };
/** Read only the overview's exact identity; absence is normal, damage is named. */
export function readDashboardCheckpoint(workspace: string, overview: ObjectValue, now: number, conversationId?: string): { checkpoint: DashboardCheckpoint | null; checkpoint_error?: string } {
  // A NAMED CONVERSATION IS READ AND NO OTHER (kickoffs/s220 row 3): two conversations on one seat each get their own record.
  const me = object(overview['this_seat']), conversation = conversationId ?? me['session_id'], seatId = me['seat_id'];
  if (typeof conversation !== 'string' || !conversation) return { checkpoint: null };
  try {
    if (typeof seatId !== 'string' || !/^[a-f0-9]{32}$/.test(seatId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(conversation)) throw Error('Checkpoint identity is malformed.');
    let file = workspace;
    for (const component of ['internal', 'checkpoints', seatId, conversation + '.json']) {
      file = path.join(file, component);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('Checkpoint record paths cannot contain symbolic links or junctions.');
    }
    const fd = fs.openSync(file, 'r');
    try {
      const record_at = fs.fstatSync(fd).mtime.toISOString();
      const state = validateCheckpoint(JSON.parse(fs.readFileSync(fd, 'utf8')), seatId, conversation);
      return { checkpoint: { conversation, record_at, ...checkpointView(state, now) } };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { checkpoint: null };
    return { checkpoint: null, checkpoint_error: label(String((error as Error).message).split(/\r?\n/)[0]) };
  }
}

type FrameOptions = { width?: number; now: number | Date; color?: DashboardColor; rows?: number; checkpoint?: DashboardCheckpoint | null; report?: DisplayReport | null };
/** The pane groups the frame appends after its own lines (kickoffs/s220 row 5); the rest it already draws. */
export const FRAME_PANE_GROUPS = ['needs-you', 'builders', 'train', 'update', 'notebook'] as const;
const TONE_ROLE: Record<ReportTone, Role> = { attention: 'attention', normal: 'name', quiet: 'label', good: 'held' };
type Frame = { text: string; key: string; clock?: { row: number; column: number; field: string } };
function clockField(now: number): string {
  const date = new Date(now);
  return `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${date.getHours() < 12 ? 'AM' : 'PM'}`.padStart(8, ' ');
}

function dashboardFrame(overview: ObjectValue, options: FrameOptions): Frame {
  const width = dashboardWidth(options.width);
  const now = Number(options.now);
  const me = object(overview['this_seat']);
  const seat = label(overview['seat']) || label(me['seat']) || '?';
  const claim = label(me['claim_state']) || 'unknown';
  const seatLine = [run(seat), run(` ${claim === 'held' ? 'held' : 'seat not held'}`, claim === 'held' ? 'label' : 'attention')];
  const captures = list(overview['capture_books']).map(object);
  const pending = (title: string, row: ObjectValue, key: string): Line => {
    const count = row[key];
    const known = typeof count === 'number' && Number.isFinite(count) && count >= 0;
    return [run(`${title} `, 'label'), run(`${known ? count : '?'}${known && count > 0 ? ` (${dashboardAge(row['oldest_pending'], now)})` : ''}`, known && count === 0 ? 'zero' : 'attention')];
  };
  const counts = [
    pending('Letters', object(overview['letters_for_this_seat']), 'count'),
    pending('Reports', captures.find(book => book['slug'] === 'reports') ?? {}, 'pending_count'),
    pending('Holding', captures.find(book => book['slug'] === 'holding') ?? {}, 'pending_count'),
  ];
  const books = list(overview['open_books']).map(object).sort((a, b) => Number(b['audit_due'] === true) - Number(a['audit_due'] === true));
  const bookNames = books.filter(book => label(book['slug'])).map(book => run(`${label(book['slug'])}${book['audit_due'] === true ? ' (audit due)' : ''}`, book['audit_due'] === true ? 'attention' : 'name'));
  // A HUB WHOSE EVERY-SESSION PAGE IS OVER ITS LIMIT IS NAMED FIRST, AS AN AUDIT IS (kickoffs/s170-r2 row 3).
  const tidyDue = new Set(list(overview['hub_pages']).map(object).filter(row => row['kind'] === 'every-session' && row['over'] === true).map(row => label(row['hub'])));
  const hubs = list(overview['open_projects']).map(label).filter(Boolean).map(name => name.replace(/^projects\//, ''))
    .sort((a, b) => Number(tidyDue.has(b)) - Number(tidyDue.has(a)))
    .map(name => tidyDue.has(name) ? run(`${name} (tidy due)`, 'attention') : run(name));
  const field = clockField(now);
  let clock: Frame['clock'];
  let first: Line | undefined;
  // THE CLOCK FOLLOWS THE COUNTS, NOT THE RIGHT EDGE (2026-11-01, projects/deskpost-desk notes/2026-11-01-dashboard-scroll-cause):
  // an Orca split pane can be narrower than the width its console reports (117 shown, 231 reported), and a clock
  // right-aligned to the reported width fell outside the pane.
  for (const gap of ['    ', '  ']) {
    const candidate = join([[run('● ', claim === 'held' ? 'held' : 'attention'), ...seatLine], ...counts], gap);
    const used = dashboardCells(plain(candidate));
    if (used + dashboardCells(gap + 'as of ' + field) <= width) {
      first = [...candidate, run(gap), run('as of ', 'label'), run(field, 'label')];
      clock = { row: 1, column: used + dashboardCells(gap + 'as of ') + 1, field }; break;
    }
  }
  if (!first) {
    const candidate = join([[run('● ', claim === 'held' ? 'held' : 'attention'), ...seatLine], ...counts], '  ');
    if (dashboardCells(plain(candidate)) <= width) first = candidate;
  }
  let lines: Line[];
  if (first) {
    lines = [first, namesLine('Books', bookNames, width, true), namesLine('Hubs', hubs, width, true)];
  } else {
    lines = wrap(seatLine, width);
    // Preserve c38's stacked count order; the strip gives Letters first place.
    let countLine: Line = [];
    for (const count of [counts[1]!, counts[2]!, counts[0]!]) {
      const candidate = countLine.length ? [...countLine, run(' · ', 'label'), ...count] : count;
      if (dashboardCells(plain(candidate)) > width && countLine.length) { lines.push(...wrap(countLine, width)); countLine = count; }
      else countLine = candidate;
    }
    lines.push(...wrap(countLine, width), namesLine('Books', bookNames, width, false), namesLine('Hubs', hubs, width, false));
    clock = { row: lines.length + 1, column: 7, field };
    lines.push([run('as of ', 'label'), run(field, 'label')]);
  }
  if (options.checkpoint) {
    const value = (text: string): Run => run(label(text), /^(unsaved|gaps|waits|stale)\b/.test(text) ? 'attention' : 'name');
    const save = value(options.checkpoint.save), closeout = value(options.checkpoint.closeout);
    let checkpointLines: Line[] | undefined;
    if (first) for (const gap of ['    ', '  ']) {
      const candidate = join([[run('Save   ', 'label'), save], [run('Closeout  ', 'label'), closeout]], gap);
      if (dashboardCells(plain(candidate)) <= width) { checkpointLines = [candidate]; break; }
    }
    checkpointLines ??= [[run('Save: ', 'label'), save], [run('Closeout: ', 'label'), closeout]].flatMap(line => wrap(line, width));
    lines.splice(clock && clock.row > 1 ? clock.row - 1 : lines.length, 0, ...checkpointLines);
    if (clock && clock.row > 1) clock.row += checkpointLines.length;
  }
  const train = object(overview['train']);
  for (const guard of list(overview['stale_recovery_guards'])) {
    for (const line of String(object(guard)['message'] ?? '').split('\n')) lines.push(...wrap([run(label(line), 'attention')], width));
  }
  if (typeof overview['recovery_guards_unreadable'] === 'string') {
    lines.push(...wrap([run(label(String(overview['recovery_guards_unreadable'])), 'attention')], width));
  }
  if (typeof train['unreadable'] === 'string') {
    lines.push(...wrap([run(`Train  unreadable (${label(train['unreadable'])}); repair internal/train/register.json`, 'attention')], width));
  } else if (typeof train['changed_at'] === 'string') {
    const changed = label(train['changed_at']), handbacks = Number(train['handbacks_since']);
    const attention = handbacks > 0 || now - Date.parse(changed) > 7 * 86400000;
    lines.push(...wrap([run(`Train  changed ${changed}, ${handbacks} handbacks since`, attention ? 'attention' : 'name')], width));
    // kickoffs/s184 row 2: the front car's days open and the week's arrivals, in full words.
    const front = object(train['front_car']), arrived = Number(train['cars_arrived_last_7_days'] ?? 0);
    const days = Number(front['days_open']);
    const open = typeof front['place'] === 'string'
      ? `${label(front['place'].replace(/^car:/, ''))}, ${days === 0 ? 'opened today' : `open ${days} ${days === 1 ? 'day' : 'days'}`}`
      : 'No front car';
    lines.push(...wrap([run(`Front car  ${open}; ${arrived} ${arrived === 1 ? 'car' : 'cars'} arrived in the last 7 days`, 'name')], width));
  }
  // THE REPORT'S PANE LINES FOLLOW EVERY LINE ABOVE, which stay word for word (kickoffs/s220 row 5): one renderer of words.
  if (options.report) {
    for (const line of paneLines(options.report, width, 0, FRAME_PANE_GROUPS)) lines.push(line.map(part => run(part.text, TONE_ROLE[part.tone])));
  }
  if (width < 30) { lines = lines.map(line => clip(line, width)); clock = undefined; }
  if (Number.isInteger(options.rows) && options.rows! > 0) lines = lines.slice(0, options.rows);
  if (clock && clock.row > lines.length) clock = undefined;
  const keyLines = lines.map(plain);
  if (clock) keyLines[clock.row - 1] = keyLines[clock.row - 1]!.slice(0, -8) + ' '.repeat(8);
  return { text: lines.map(line => paint(line, options.color ?? 'none')).join('\n'), key: keyLines.join('\n') + (options.checkpoint ? JSON.stringify(options.checkpoint) : ''), ...(clock ? { clock } : {}) };
}

/** Facts are supplied by the caller; this pure function opens no page and writes nothing. */
export function dashboardText(overview: ObjectValue, options: FrameOptions): string {
  return dashboardFrame(overview, options).text;
}

/** Poll the overview and its exact checkpoint, retaining the last good read across overview failures. */
export async function watchDashboard(options: { workspace: string; seat: string; width?: number; intervalSeconds: number; iterations?: number; now?: () => number }): Promise<void> {
  let stopped = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); wake?.(); };
  const tty = process.stdout.isTTY === true;
  const color = dashboardColor(tty, process.env);
  const clockNow = options.now ?? Date.now;
  let lastOverview: ObjectValue | undefined;
  let lastCheckpoint: DashboardCheckpoint | null = null;
  let lastReport: DisplayReport | null = null;
  let lastRead = 0;
  let displayedKey: string | undefined;
  let displayedClock: string | undefined;
  // THE WATCH DRAWS ON THE ALTERNATE SCREEN, WHICH KEEPS NO SCROLLBACK (report 2026-10-31, "Desk dashboard watch mode
  // scrolls in an Orca panel"): an Orca pane can show fewer rows than the console it hosts reports, so each full redraw
  // scrolled the first line into the pane's history, and the clear-scrollback code never reached that copy.
  let onAlternateScreen = false;
  let unknownSince: number | undefined;
  let refusal = '';
  // A DAMAGED RECORD IS NOT AN UNREACHABLE DESK (kickoffs/s164 row 5; the planner's review of c54): the Desk was read,
  // and the line names the record that could not be.
  let damaged = '';
  let damagedSince: number | undefined;
  let observedNow = 0;

  const render = (force = false) => {
    const width = dashboardWidth(options.width, process.stdout.columns);
    const frame: Frame = lastOverview ? dashboardFrame(lastOverview, { width, rows: process.stdout.rows, now: lastRead, color, checkpoint: lastCheckpoint, report: lastReport }) : { text: '', key: '' };
    const warnings: string[][] = [];
    for (const text of [
      damagedSince !== undefined ? `checkpoint unknown since ${elapsedAge(observedNow - damagedSince)}: ${damaged}` : '',
      unknownSince !== undefined ? `unknown since ${elapsedAge(observedNow - unknownSince)}: ${refusal}` : '',
    ]) {
      if (text) warnings.push(wrap([run(text, 'attention')], width).map(line => paint(line, color)));
    }
    const limit = Number.isInteger(process.stdout.rows) && process.stdout.rows > 0 ? process.stdout.rows : Infinity;
    let room = Math.max(0, limit - (frame.text ? 1 : 0));
    const shown = warnings.flatMap((lines, index) => {
      const take = Math.min(lines.length, room > 0 ? Math.max(1, room - warnings.length + index + 1) : 0);
      room -= take; return lines.slice(0, take);
    });
    const kept = Math.max(0, limit - shown.length);
    frame.text = [...(frame.text ? frame.text.split('\n').slice(0, kept) : []), ...shown].join('\n');
    frame.key += '\n' + shown.join('\n');
    if (frame.clock && frame.clock.row > kept) frame.clock = undefined;
    if (force || frame.key !== displayedKey) {
      displayedKey = frame.key;
      displayedClock = frame.clock?.field;
      // One write, and nothing in it can scroll the screen: the first frame enters the alternate screen with line
      // wrapping off, and each line is placed at its own row, never after a newline. A pane shorter or narrower than
      // its console reports then clips the frame's end instead of scrolling its first line away.
      const enter = tty && !onAlternateScreen ? '\x1b[?1049h\x1b[?7l' : '';
      if (enter) onAlternateScreen = true;
      const placed = frame.text ? frame.text.split('\n').map((line, index) => `\x1b[${index + 1};1H${line}`).join('') : '';
      process.stdout.write(tty ? `${enter}\x1b[?25l\x1b[H\x1b[2J\x1b[3J${placed}\x1b[1;1H\x1b[?25l` : `---\n${frame.text}\n`);
    } else if (tty && unknownSince === undefined && frame.clock && frame.clock.field !== displayedClock) {
      displayedClock = frame.clock.field;
      // The entire eight-cell field clears the previous value, including its padding.
      process.stdout.write(`\x1b[${frame.clock.row};${frame.clock.column}H${paint([run(frame.clock.field, 'label')], color)}${RESET}\x1b[1;1H\x1b[?25l`);
    } else if (tty) {
      process.stdout.write('\x1b[1;1H\x1b[?25l');
    }
  };
  // Resize uses the cached overview and last successful read time, never another Desk read.
  const resize = () => { if (!stopped && displayedKey !== undefined) render(true); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (tty) process.stdout.on('resize', resize);
  try {
    for (let read = 0; !stopped && (options.iterations === undefined || read < options.iterations); read++) {
      observedNow = clockNow();
      try {
        lastOverview = deskOverview({ workspace: options.workspace, seat: options.seat });
        const checkpoint = readDashboardCheckpoint(options.workspace, lastOverview, observedNow);
        lastCheckpoint = checkpoint.checkpoint;
        lastReport = dashboardReport(options.workspace, { seat: options.seat, now: observedNow, overview: lastOverview });
        lastRead = observedNow;
        unknownSince = undefined;
        refusal = '';
        if (checkpoint.checkpoint_error) {
          const me = object(lastOverview['this_seat']);
          damagedSince ??= observedNow;
          damaged = `the record internal/checkpoints/${String(me['seat_id'])}/${String(me['session_id'])}.json is damaged (${checkpoint.checkpoint_error})`;
        } else {
          damagedSince = undefined;
          damaged = '';
        }
      } catch (error) {
        unknownSince ??= observedNow;
        refusal = label((error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0] ?? '');
      }
      render();
      if (!stopped && (options.iterations === undefined || read + 1 < options.iterations)) {
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, options.intervalSeconds * 1000); });
        wake = undefined;
      }
    }
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (tty) {
      process.stdout.removeListener('resize', resize);
      // Leaving the alternate screen restores what the pane showed before the watch started.
      process.stdout.write(`${RESET}${onAlternateScreen ? '\x1b[?7h\x1b[?1049l' : ''}\x1b[?25h`);
    }
  }
}

function elapsedAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${seconds} s`;
}

// ---------------------------------------------------------------------------------------------------------------------
// THE DISPLAY REPORT (PLAN-mods-redesign.md r9 unit U1; kickoffs/s220): one report the program builds, so the Claude Code
// mod and the Codex pane draw the same words from the same facts, and no mod parses a Deskpost file.

/** One builder's run state (kickoffs/s220 row 1): read from its dev Hub's `## Next` and `notes/` pages, never guessed. */
export type BuilderRunState = {
  seat: string; hub: string;
  queue?: string[]; current?: string | null;
  state?: 'posted' | 'running' | 'handed back' | 'reviewed' | null;
  outcome?: string | null; attempt_page?: string | null; minutes_running?: number | null;
  problem?: string; source: string; read_at: string;
};

// An attempt number is short: `notes/2026-11-09-c135-review-accepted-a504733` ends in a commit, not an attempt.
const ATTEMPT_PAGE = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9._-]+)-a([1-9]\d{0,2})$/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `.md` page names directly in a Hub's `notes/` folder, without `.md`; none when it has no such folder. */
function hubNotesNames(workspace: string, hub: string): string[] {
  try {
    return fs.readdirSync(path.join(workspace, 'collection', 'projects', hub, 'notes'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** When a Hub page was first written: the UTC time in its oldest new-page publication journal's file name, or null. */
function pageCreatedAt(workspace: string, hub: string, page: string): number | null {
  const prefix = `project-new-page-${hub}-${page.replace(/\//g, '-')}-`;
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(workspace, 'internal', 'publication-journals')); } catch { return null; }
  const times = names.filter(name => name.startsWith(prefix) && name.endsWith('.json')).map(name => {
    const stamp = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[A-Za-z0-9]+\.json$/.exec(name.slice(prefix.length));
    return stamp ? Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!) : NaN;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  return times[0] ?? null;
}

/** The first path in backticks on the `## Repo` line naming the `Working tree:`, or null. */
function repoWorkingTree(body: string): string | null {
  const lines = toLines(body);
  const start = lines.findIndex(line => /^##[ \t]+Repo[ \t]*$/.test(line));
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length && !/^##[ \t]/.test(lines[index]!); index++) {
    if (!/Working tree:/.test(lines[index]!)) continue;
    return /Working tree:\**\s*`([^`]+)`/.exec(lines[index]!)?.[1] ?? null;
  }
  return null;
}

/**
 * Every dev Hub builder's run state, as the caller's Desk can see it (kickoffs/s220 row 1; trains meanwhile-review-records,
 * meanwhile-tree-exists). The queue is read as `hub status` reads it (`nextShownLines`), the Outcome as `kickoff next`
 * reads it (`handbackOutcome`). A Hub closed on the caller's Desk is a problem row, never a guessed state.
 */
export function builderRunStates(workspace: string, seat: string, now: number = Date.now()): BuilderRunState[] {
  const stateDirectory = path.join(workspace, '.claude');
  const read_at = new Date(now).toISOString();
  const openHubs = deskEntriesForSeat(stateDirectory, seat, 'projects').map(entry => entry.replace(/^projects\//, ''));
  const rows: BuilderRunState[] = [];
  // Review pages may sit on any Hub open on this Desk (deskpost-lead keeps them on its own), so each is listed once.
  const listed = new Map<string, string[]>();
  const notesOf = (hub: string): string[] => {
    if (!listed.has(hub)) listed.set(hub, hubNotesNames(workspace, hub));
    return listed.get(hub)!;
  };
  for (const entry of readSeatRegistry(stateDirectory)) {
    const hub = entry.project, hubFolder = path.join(workspace, 'collection', 'projects', hub);
    const source = `projects/${hub}/_project ## Next; projects/${hub}/notes`;
    let body: string;
    try { body = removeFrontmatter(fs.readFileSync(path.join(hubFolder, '_project.md'), 'utf8').replace(/^﻿/, '')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      rows.push({ seat: entry.seat, hub, problem: `projects/${hub}/_project is unreadable: ${label((error as Error).message.split(/\r?\n/)[0])}`, source, read_at });
      continue;
    }
    if (!isDevHubBody(body)) continue;
    if (!openHubs.includes(hub)) { rows.push({ seat: entry.seat, hub, problem: 'closed on this Desk', source: `projects/${hub}`, read_at }); continue; }
    const queue: string[] = [];
    for (const line of nextShownLines(toLines(body)) ?? []) {
      const match = /^\s*- \[ \] Run ([A-Za-z0-9._-]+):/.exec(line.text);
      if (match) queue.push(match[1]!);
    }
    const row: BuilderRunState = { seat: entry.seat, hub, queue, current: null, state: null, outcome: null, attempt_page: null, minutes_running: null, source, read_at };
    const problems: string[] = [];
    const tree = repoWorkingTree(body);
    if (tree !== null && !fs.existsSync(tree)) problems.push(`the working tree ${label(tree)} named in ## Repo does not exist`);
    let notes: string[] = [];
    try { notes = notesOf(hub); } catch (error) { problems.push(`projects/${hub}/notes is unreadable: ${label((error as Error).message.split(/\r?\n/)[0])}`); }
    // The attempt pages, oldest first: by date, then by creation time, then by attempt number.
    const attempts = notes.flatMap(name => {
      const found = ATTEMPT_PAGE.exec(name);
      return found ? [{ page: `notes/${name}`, id: found[2]!, date: found[1]!, attempt: Number(found[3]), created: pageCreatedAt(workspace, hub, `notes/${name}`) }] : [];
    }).sort((a, b) => a.date.localeCompare(b.date) || (a.created ?? 0) - (b.created ?? 0) || a.attempt - b.attempt || a.page.localeCompare(b.page));
    const outcomes = new Map<string, string | null>();
    const outcomeOf = (page: string): string | null => {
      if (!outcomes.has(page)) {
        try { outcomes.set(page, handbackOutcome(fs.readFileSync(path.join(hubFolder, page + '.md'), 'utf8'))); }
        catch (error) { problems.push(`projects/${hub}/${page} is unreadable: ${label((error as Error).message.split(/\r?\n/)[0])}`); outcomes.set(page, null); }
      }
      return outcomes.get(page)!;
    };
    // The unit being run is the newest attempt page with no Outcome; else the first pending pointer; else the last run.
    const newest = attempts[attempts.length - 1];
    const chosen = newest !== undefined && outcomeOf(newest.page) === null ? newest
      : queue.length ? [...attempts].reverse().find(attempt => attempt.id.toLowerCase() === queue[0]!.toLowerCase())
      : newest;
    if (chosen === undefined && queue.length) {
      row.current = queue[0]!;
      row.state = 'posted';
    } else if (chosen !== undefined) {
      const outcome = outcomeOf(chosen.page);
      row.current = chosen.id;
      row.attempt_page = chosen.page;
      if (outcome === null) {
        row.state = 'running';
        if (chosen.created !== null && chosen.created <= now) row.minutes_running = Math.floor((now - chosen.created) / 60000);
      } else {
        row.outcome = outcome;
        const review = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(chosen.id)}-review`, 'i');
        const reviewed = openHubs.some(open => { try { return notesOf(open).some(name => review.test(name)); } catch { return false; } });
        row.state = reviewed ? 'reviewed' : 'handed back';
      }
    }
    if (problems.length) row.problem = problems.join('; ');
    rows.push(row);
  }
  return rows;
}

/**
 * `deskpost kickoff status`'s text (kickoffs/s220-r2 row 6): one line per builder, `<seat>  <state> <unit>` with its minutes
 * while running and `; <problem>` when it has one; a row with no state is its problem alone.
 */
export function kickoffStatusText(rows: BuilderRunState[]): string {
  if (!rows.length) return 'No seat in this Library has a dev Hub, so there is no builder to show.\n';
  return rows.map(row => {
    const problem = row.problem ? label(row.problem) : '';
    if (row.state === undefined) return `${row.seat}  ${problem || 'no state could be read'}`;
    const words = row.state === null ? 'no unit posted'
      : `${row.state} ${row.current}${row.state === 'running' && typeof row.minutes_running === 'number' ? `, ${plural(row.minutes_running, 'minute')}` : ''}`;
    return `${row.seat}  ${words}${problem ? `; ${problem}` : ''}`;
  }).join('\n') + '\n';
}

/** The front car as the report shows it (kickoffs/s220 row 2; plan criterion 13). */
export type TrainFront = {
  place: string | null; days_open?: number; next?: { id: string; title: string } | null;
  running?: { id: string; title: string }[]; finished?: boolean; source: string; read_at: string;
};

/**
 * The open car, its days open, its next item (its first open item in register order) and the running items. A front car
 * with no open item is `finished`: the report asks for it to be marked arrived. Throws when the register is unreadable.
 */
export function trainFront(workspace: string, now: number = Date.now()): TrainFront {
  const source = 'internal/train/register.json', read_at = new Date(now).toISOString();
  const record = readTrain(workspace);
  const car = record === null ? null : frontCar(record);
  if (record === null || car === null) return { place: null, source, read_at };
  const brief = (item: { id: string; title: string }) => ({ id: item.id, title: item.title });
  const open = record.items.filter(item => item.status === 'open');
  const mine = open.filter(item => item.place === car.place);
  return {
    place: car.place, days_open: Math.max(0, daysBetween(car.opened, localDate(new Date(now)))),
    next: mine.length ? brief(mine[0]!) : null,
    running: open.filter(item => item.place === 'running').map(brief),
    finished: mine.length === 0, source, read_at,
  };
}

/** The Notebook's limits, moved into the program from the mod's own defaults (deskpost-mods `hooks/notebook.ts:12`). */
export const NOTEBOOK_LIMITS = { notes: 25, topics: 6 } as const;

export type ReportProblem = { source: string; problem: string };
type Sourced = { source: string; read_at: string };
export type DisplayReport = {
  schema: 2; seat: string; read_at: string;
  needs_you: (Sourced & { count: number | null; sections: { key: string; heading: string; items: { seat: string | null; text: string }[] }[] }) | null;
  builders: BuilderRunState[] | null;
  train_front: TrainFront | null;
  closeout: (Sourced & { conversation: string | null; label: string; save: string | null; state: string | null; record_at: string | null }) | null;
  hub_over_limit: (Sourced & { pages: ObjectValue[] }) | null;
  desk: (Sourced & { open_books: PsJsonValue; open_projects: PsJsonValue; hub_pages: PsJsonValue; other_seats: PsJsonValue; letters_for_this_seat: PsJsonValue; capture_books: PsJsonValue }) | null;
  notebook: (Sourced & { notes: number; topics: number; limit_notes: number; limit_topics: number; over: boolean }) | null;
  update: (Sourced & { checked: 'yes' | 'never' | 'not installed'; installed: string | null; latest: string | null; checked_utc: string | null; error: string | null; newer: boolean }) | null;
  problems: ReportProblem[];
  row: ReportLine[] | null; pane: ReportLine[] | null;
};
export type ReportTone = 'attention' | 'normal' | 'quiet' | 'good';
export type ReportLine = { text: string; tone: ReportTone }[];

const firstLine = (error: unknown): string => label((error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]);

/**
 * The display report, schema 2 (kickoffs/s220 row 3; plan criteria 1 and 7): every fact the row and the pane show, each
 * with its source and when it was read. A source that cannot be read is a named problem and its field is null, never zero.
 * `installRoot` is the install root to read the update check from; by default the running program's own.
 */
export function dashboardReport(workspace: string, options: { seat: string; conversation?: string; columns?: number; reserve?: number; now: number; installRoot?: string | null; overview?: ObjectValue }): DisplayReport {
  const now = options.now, read_at = new Date(now).toISOString(), seat = options.seat;
  const problems: ReportProblem[] = [];
  const attempt = <T>(source: string, read: () => T): T | null => {
    try { return read(); } catch (error) { problems.push({ source, problem: firstLine(error) }); return null; }
  };
  // A caller that has just read the overview (the watch) passes it, so the Desk is read once per frame.
  const overview = options.overview ?? attempt('Desk overview', () => deskOverview({ workspace, seat }));
  const needs = attempt('needs-you', () => readNeedsYou(workspace));
  for (const problem of needs?.problems ?? []) problems.push({ source: 'needs-you', problem: label(problem) });
  // A source needs-you could not read leaves the count unknown: null, never the sum of what was read.
  const needs_you = needs === null ? null : {
    count: needs.problems.length ? null : needs.sections.reduce((sum, section) => sum + section.items.length, 0),
    sections: needs.sections.map(section => ({ key: section.key, heading: section.heading, items: section.items.map(item => ({ seat: item.seat, text: label(item.text) })) })),
    source: 'needs-you: the active Hubs, the capture Books and the checkpoint records', read_at,
  };
  const builders = attempt('builders', () => builderRunStates(workspace, seat, now));
  const train_front = attempt('internal/train/register.json', () => trainFront(workspace, now));

  let closeout: DisplayReport['closeout'] = null;
  if (overview !== null) {
    const me = object(overview['this_seat']);
    const conversation = options.conversation ?? (typeof me['session_id'] === 'string' && me['session_id'] ? me['session_id'] : null);
    const source = conversation === null ? 'internal/checkpoints' : `internal/checkpoints/${label(me['seat_id'])}/${conversation}.json`;
    const read = conversation === null ? { checkpoint: null } : readDashboardCheckpoint(workspace, overview, now, conversation);
    if (read.checkpoint_error !== undefined) problems.push({ source, problem: read.checkpoint_error });
    else closeout = {
      conversation, label: options.conversation === undefined ? "this seat's recorded conversation" : 'the conversation named',
      save: read.checkpoint?.save ?? null, state: read.checkpoint?.closeout ?? null, record_at: read.checkpoint?.record_at ?? null, source, read_at,
    };
  }

  const overviewSource = 'deskpost desk --json', field = (key: string): PsJsonValue => overview?.[key] ?? null;
  const hubPagesRows = Array.isArray(field('hub_pages')) ? list(field('hub_pages')).map(object) : null;
  if (overview !== null && hubPagesRows === null) problems.push({ source: 'hub_pages', problem: 'the Hub page sizes are not measured on this backend' });
  const hub_over_limit = hubPagesRows === null ? null : { pages: hubPagesRows.filter(row => row['over'] === true), source: `${overviewSource} hub_pages`, read_at };
  const desk = overview === null ? null : {
    open_books: field('open_books'), open_projects: field('open_projects'), hub_pages: field('hub_pages'), other_seats: field('other_seats'),
    letters_for_this_seat: field('letters_for_this_seat'), capture_books: field('capture_books'), source: overviewSource, read_at,
  };
  let notebook: DisplayReport['notebook'] = null;
  if (overview !== null) {
    const book = object(overview['notebook']), notes = book['article_count'], topics = book['topic_count'];
    if (typeof notes !== 'number' || typeof topics !== 'number') problems.push({ source: `${overviewSource} notebook`, problem: 'the Notebook counts are missing from the Desk overview' });
    else notebook = { notes, topics, limit_notes: NOTEBOOK_LIMITS.notes, limit_topics: NOTEBOOK_LIMITS.topics, over: notes > NOTEBOOK_LIMITS.notes || topics > NOTEBOOK_LIMITS.topics, source: `${overviewSource} notebook`, read_at };
  }

  let installRoot = options.installRoot;
  if (installRoot === undefined) { try { installRoot = installRootOf(programRoot()); } catch { installRoot = null; } }
  const updateSource = installRoot === null ? 'no install root' : path.join(installRoot, 'update-check.json');
  const record = installRoot === null ? null : readUpdateRecord(installRoot);
  const update: DisplayReport['update'] = {
    checked: installRoot === null ? 'not installed' : record === null ? 'never' : 'yes',
    installed: record?.installed ?? null, latest: record?.latest ?? null, checked_utc: record?.checked_utc ?? null, error: record?.error ?? null,
    newer: typeof record?.latest === 'string' && typeof record.installed === 'string' && compareVersions(record.latest, record.installed) === 'newer',
    source: updateSource, read_at,
  };
  if (record?.error) problems.push({ source: updateSource, problem: label(record.error) });

  const report: DisplayReport = { schema: 2, seat, read_at, needs_you, builders, train_front, closeout, hub_over_limit, desk, notebook, update, problems, row: null, pane: null };
  const lines = reportLines(report, options.columns ?? DEFAULT_DASHBOARD_WIDTH, options.reserve ?? 0);
  return { ...report, row: lines.row, pane: lines.pane };
}

// ---------------------------------------------------------------------------------------------------------------------
// THE ROW AND THE PANE (kickoffs/s220 row 4; plan criterion 2's program half). Words are full words; only at 60 columns or
// fewer may `minutes`, `hours` and `days` become `min`, `h` and `d`. A slot the row folds is always in the pane in full.

type Segment = ReportLine[number];
const seg = (text: string, tone: ReportTone = 'normal'): Segment => ({ text, tone });
const lineCells = (line: ReportLine): number => dashboardCells(line.map(part => part.text).join(''));
const plural = (count: number, word: string): string => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
const carName = (place: string): string => label(place).replace(/^car:/, '');

/** A duration in whole units: full words, or the short forms at 60 columns or fewer. */
function span(count: number, unit: 'minute' | 'hour' | 'day', short: boolean): string {
  return short ? `${count} ${unit === 'minute' ? 'min' : unit === 'hour' ? 'h' : 'd'}` : plural(count, unit);
}

/** A closeout or save state as the program keeps it (`done 12 min`, `saved 3 h`), in this report's words. */
function stateWords(text: string, short: boolean): string {
  return label(text).replace(/(\d+) (min|h|d)\b/g, (_whole, count: string, unit: string) =>
    `${span(Number(count), unit === 'min' ? 'minute' : unit === 'h' ? 'hour' : 'day', short)} ago`).replace(/^<1 min$/, 'less than a minute ago');
}

const closeoutTone = (state: string): ReportTone => /^(gaps|waits|stale|asked)\b/.test(state) ? 'attention' : /^done\b/.test(state) ? 'good' : 'normal';
const builderTone = (state: string | null | undefined): ReportTone => state === 'handed back' ? 'attention' : state === 'reviewed' ? 'good' : 'normal';

/** Cut a line's end to `width` cells, ending in `...`; whole characters only. */
function cutEnd(line: ReportLine, width: number): ReportLine {
  if (lineCells(line) <= width) return line;
  const room = Math.max(0, width - 3), out: ReportLine = [];
  let used = 0;
  for (const part of line) {
    let text = '';
    for (const char of part.text) {
      const cells = dashboardCells(char);
      if (used + cells > room) { if (text) out.push(seg(text, part.tone)); out.push(seg('...'.slice(0, Math.min(3, width)), 'quiet')); return out; }
      used += cells; text += char;
    }
    if (text) out.push(seg(text, part.tone));
  }
  return out;
}

/** Word wrap for the pane: nothing is cut; a continuation line is indented two spaces. */
function wrapPane(line: ReportLine, width: number): ReportLine[] {
  if (lineCells(line) <= width) return [line];
  const lines: ReportLine[] = [];
  // `start` is where a line's own text begins: after its leading spaces on the first line, after the indent on the rest.
  let current: ReportLine = [], used = 0, start = 0, leading = true;
  const push = (text: string, tone: ReportTone) => {
    const last = current[current.length - 1];
    if (last && last.tone === tone) last.text += text; else current.push(seg(text, tone));
    used += dashboardCells(text);
  };
  const breakLine = () => { lines.push(current); current = [seg('  ', 'quiet')]; used = start = 2; };
  for (const part of line) {
    for (const token of part.text.split(/(\s+)/).filter(Boolean)) {
      const cells = dashboardCells(token);
      if (/^\s+$/.test(token)) {
        if (leading) { push(token, part.tone); start = used; } else if (used > start && used + cells <= width) push(token, part.tone);
        continue;
      }
      leading = false;
      if (used + cells > width && used > start) breakLine();
      for (const char of token) {
        if (used + dashboardCells(char) > width && used > start) breakLine();
        push(char, part.tone);
      }
    }
  }
  if (used > start) lines.push(current);
  return lines.map(row => row.map((part, index, all) => index === all.length - 1 ? { ...part, text: part.text.trimEnd() } : part));
}

/** What needs Eric, newest first and oldest last: a finished car, the needs-you items and the sources not read. */
function needsYouItems(report: DisplayReport): string[] {
  const train = trainNeedsYouItem(report.train_front);
  const items = [...(train ? [train] : []), ...(report.needs_you?.sections ?? []).flatMap(section => section.items.map(item => item.text))];
  if (report.problems.length) items.push(`${plural(report.problems.length, 'source')} could not be read`);
  return items;
}

/** The pane's groups, in order; `dashboardFrame` appends the needs-you, builders, train, update and Notebook groups. */
function paneGroups(report: DisplayReport, short: boolean): { key: string; lines: ReportLine[] }[] {
  const groups: { key: string; lines: ReportLine[] }[] = [];
  const add = (key: string, lines: ReportLine[]) => { if (lines.length) groups.push({ key, lines }); };
  const needs = needsYouItems(report).filter(text => !report.needs_you?.sections.some(section => ['letters', 'reports'].includes(section.key) && section.items.some(item => item.text === text)));
  // Letters and Reports have their own groups below; with nothing else waiting, the line names those groups, never a count
  // (each section holds one summary item per seat or per Book), and says nothing only when no section holds an item.
  const waiting = ([['letters', 'letters waiting'], ['reports', 'Reports pending']] as const)
    .filter(([key]) => report.needs_you?.sections.some(section => section.key === key && section.items.length)).map(([, words]) => words);
  add('needs-you', needs.length ? [[seg('Needs you:', 'normal')], ...needs.map(text => [seg('  '), seg(text, 'attention')])]
    : waiting.length ? [[seg('Needs you: ', 'normal'), seg(`${waiting.join(' and ')}, listed below`, 'attention')]]
    : [[seg('Needs you: nothing', 'good')]]);
  add('builders', (report.builders ?? []).map(row => {
    if (row.state === undefined) return [seg(`Builder ${row.seat}: `, 'normal'), seg(label(row.problem), 'quiet')];
    const words = row.state === null ? 'no unit posted' : `${row.state} ${row.current}${row.outcome ? ` (${label(row.outcome)})` : ''}`;
    const minutes = row.state === 'running' && typeof row.minutes_running === 'number' ? `, ${span(row.minutes_running, 'minute', short)}` : '';
    const queued = row.queue && row.queue.length > (row.state === 'posted' ? 1 : 0) ? `; queued: ${row.queue.slice(row.state === 'posted' ? 1 : 0).join(', ')}` : '';
    return [seg(`Builder ${row.seat}: `, 'normal'), seg(words + minutes, builderTone(row.state)), seg(queued, 'quiet'), ...(row.problem ? [seg(`; ${label(row.problem)}`, 'attention')] : [])];
  }));
  const front = report.train_front;
  if (front) {
    add('train', front.place === null ? [[seg('Front car: none open', 'quiet')]] : [
      [seg('Front car: ', 'normal'), seg(`${carName(front.place)}, open ${span(front.days_open ?? 0, 'day', short)}`, front.finished ? 'attention' : 'normal')],
      [seg('  Next: ', 'normal'), front.next ? seg(`${front.next.id}: ${label(front.next.title)}`) : seg('no open items', 'attention')],
      ...(front.running ?? []).map(item => [seg('  Running: ', 'normal'), seg(`${item.id}: ${label(item.title)}`)]),
    ]);
  }
  if (report.closeout && (report.closeout.state || report.closeout.save)) {
    add('closeout', [[seg('Closeout: ', 'normal'), seg(stateWords(report.closeout.state ?? 'none', short), closeoutTone(report.closeout.state ?? '')),
      seg(`; save ${stateWords(report.closeout.save ?? 'none', short)} (${report.closeout.label})`, 'quiet')]]);
  }
  const update = report.update;
  if (update) {
    add('update', [update.checked === 'not installed' ? [seg('Update: not checked, this program is not an installed copy', 'quiet')]
      : update.checked === 'never' ? [seg('Update: never checked', 'quiet')]
      : update.newer ? [seg('Update: ', 'normal'), seg(`Deskpost ${label(update.latest)} is out; ${label(update.installed)} is installed`, 'attention')]
      // A failed check read no release, so it never says up to date.
      : update.error ? [seg('Update: ', 'normal'), seg(`the last check failed (${label(update.error)}); ${label(update.installed) || 'this copy'} is installed${update.checked_utc ? `, checked ${label(update.checked_utc)}` : ''}`, 'attention')]
      : [seg(`Update: ${label(update.installed) || 'this copy'} is up to date, checked ${label(update.checked_utc)}`, 'quiet')]]);
  }
  if (report.notebook) {
    const n = report.notebook;
    add('notebook', [[seg('Notebook: ', 'normal'), seg(`${n.notes} of ${n.limit_notes} notes, ${n.topics} of ${n.limit_topics} topics${n.over ? ', over its limit' : ''}`, n.over ? 'attention' : 'normal')]]);
  }
  if (report.desk) {
    const books = list(report.desk.open_books).map(object).map(book => label(book['slug'])).filter(Boolean);
    add('books', [[seg('Books: ', 'normal'), seg(books.length ? books.join(', ') : 'none', books.length ? 'normal' : 'quiet')]]);
    const pages = list(report.desk.hub_pages).map(object);
    const bytes = (row: ObjectValue): string => `${Number(row['size_bytes']).toLocaleString('en-US')} of ${Number(row['limit_bytes']).toLocaleString('en-US')} bytes`;
    const hubs = list(report.desk.open_projects).map(label).map(name => name.replace(/^projects\//, '')).filter(Boolean).map(hub => {
      const root = pages.find(row => row['hub'] === hub && row['page'] === '_project');
      // `_project`'s size is already beside the Hub's name; any other page over its limit carries its own.
      const over = pages.filter(row => row['hub'] === hub && row['over'] === true).map(row => `${label(row['page'])} over its limit${row['page'] === '_project' ? '' : ` (${bytes(row)})`}`);
      return `${hub}${root ? ` (${bytes(root)})` : ''}${over.length ? `, ${over.join(', ')}` : ''}`;
    });
    add('hubs', [[seg('Hubs: ', 'normal'), seg(hubs.length ? hubs.join('; ') : 'none', hubs.some(hub => hub.includes('over its limit')) ? 'attention' : hubs.length ? 'normal' : 'quiet')]]);
    const seats = list(report.desk.other_seats).map(object);
    const held = seats.filter(row => row['claim_state'] === 'held').map(row => label(row['seat']));
    add('other-seats', [[seg('Other seats: ', 'normal'), seg(seats.length ? `${held.length ? `${held.join(', ')} held` : 'none held'}; ${seats.length - held.length} free` : 'none', 'quiet')]]);
  }
  const lettersSection = report.needs_you?.sections.find(section => section.key === 'letters');
  const mine = object(report.desk?.letters_for_this_seat ?? null)['count'];
  add('letters', [
    ...(typeof mine === 'number' && mine > 0 ? [[seg('Letters for this seat: ', 'normal'), seg(String(mine), 'attention')]] : []),
    ...(lettersSection?.items.length ? [[seg('Letters waiting:', 'normal')], ...lettersSection.items.map(item => [seg('  '), seg(item.text)])] : []),
  ]);
  const reports = report.needs_you?.sections.find(section => section.key === 'reports')?.items ?? [];
  if (report.needs_you) add('reports', [[seg('Reports: ', 'normal'), ...(reports.length ? reports.map(item => seg(item.text, 'attention')) : [seg('none pending', 'quiet')])]]);
  add('problems', report.problems.map(problem => [seg('Could not read ', 'normal'), seg(`${label(problem.source)}: ${label(problem.problem)}`, 'attention')]));
  return groups;
}

/** The pane's lines, wrapped to the width; `keys` keeps only those groups, in the pane's order. */
function paneLines(report: DisplayReport, columns: number, reserve: number, keys?: readonly string[]): ReportLine[] {
  const width = Math.max(1, columns - reserve), short = columns <= 60;
  return paneGroups(report, short).filter(group => keys === undefined || keys.includes(group.key)).flatMap(group => group.lines.flatMap(line => wrapPane(line, width)));
}

/** Line 1: `Needs you:` and its items, oldest folded first into `+N more`; or `Nothing needs you`. */
function needsYouRow(report: DisplayReport, width: number): ReportLine {
  const items = needsYouItems(report);
  if (!items.length) return cutEnd([seg('Nothing needs you', 'good')], width);
  for (let keep = items.length; keep >= 1; keep--) {
    const line: ReportLine = [seg('Needs you: ', 'normal')];
    items.slice(0, keep).forEach((text, index) => { if (index) line.push(seg('; ', 'quiet')); line.push(seg(text, 'attention')); });
    if (keep < items.length) line.push(seg(`; +${items.length - keep} more`, 'quiet'));
    if (lineCells(line) <= width) return line;
    if (keep === 1) {
      // A single item still too long is cut from its end, and `+N more` stays whole after it.
      const more: ReportLine = keep < items.length ? [seg(`; +${items.length - keep} more`, 'quiet')] : [];
      const head = cutEnd([seg('Needs you: ', 'normal'), seg(items[0]!, 'attention')], Math.max(14, width - lineCells(more)));
      return cutEnd([...head, ...more], width);
    }
  }
  return cutEnd([seg('Nothing needs you', 'good')], width);
}

/** Line 2: builders, the train, what is running and the closeout, folded in the plan's order until it fits. */
function statusRow(report: DisplayReport, width: number, short: boolean): ReportLine {
  const builders = (report.builders ?? []).filter(row => row.state);
  const front = report.train_front;
  const running = front?.running ?? [];
  const closeout = report.closeout?.state ?? null;
  const fold = { closeout: false, next: false, running: false, minutes: false, count: false };
  let carRoom: number | null = null;
  const build = (): ReportLine => {
    const slots: ReportLine[] = [];
    if (builders.length) {
      if (fold.count) slots.push([seg(plural(builders.length, 'builder'))]);
      else builders.forEach(row => slots.push([seg(`${row.seat} `), seg(`${row.state} ${row.current}${!fold.minutes && row.state === 'running' && typeof row.minutes_running === 'number' ? `, ${span(row.minutes_running, 'minute', short)}` : ''}`, builderTone(row.state))]));
    }
    if (front) {
      if (front.place === null) slots.push([seg('Train: no car open', 'quiet')]);
      else {
        let name = carName(front.place);
        if (carRoom !== null) name = cutEnd([seg(name)], Math.max(4, carRoom)).map(part => part.text).join('');
        slots.push([seg('Train: '), seg(name, front.finished ? 'attention' : 'normal'), ...(fold.next ? [] : [seg(front.next ? `, next ${front.next.id}` : ', no open items', front.next ? 'normal' : 'attention')])]);
      }
    }
    if (running.length && !fold.running) slots.push([seg('Running: '), seg(running.map(item => item.id).join(', '))]);
    if (closeout && !fold.closeout) slots.push([seg('Closeout: '), seg(stateWords(closeout, short), closeoutTone(closeout))]);
    return slots.flatMap((slot, index) => index ? [seg(' · ', 'quiet'), ...slot] : slot);
  };
  let line = build();
  for (const step of ['closeout', 'next', 'running', 'minutes', 'count'] as const) {
    if (lineCells(line) <= width) return line;
    fold[step] = true;
    line = build();
  }
  if (lineCells(line) > width && front?.place) {
    // The front car's name is cut from its end with `...`, to what the rest of the line leaves.
    const name = carName(front.place);
    carRoom = dashboardCells(name) - (lineCells(line) - width);
    line = build();
  }
  return cutEnd(line, width);
}

/**
 * The row's two lines and the pane, from the report alone (kickoffs/s220 row 4). Each line is a list of segments with a
 * tone; no line is wider than `columns - reserve` cells.
 */
export function reportLines(report: DisplayReport, columns = DEFAULT_DASHBOARD_WIDTH, reserve = 0): { row: ReportLine[]; pane: ReportLine[] } {
  const width = Math.max(1, columns - reserve), short = columns <= 60;
  return { row: [needsYouRow(report, width), statusRow(report, width, short)], pane: paneLines(report, columns, reserve) };
}

/** The train's needs-you item for line 1 (a finished front car), or null; plan r9 criterion 13. */
export function trainNeedsYouItem(front: TrainFront | null): string | null {
  return front?.place && front.finished ? `Train: ${front.place} has no open items; mark it arrived` : null;
}
