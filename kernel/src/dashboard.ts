/** Read-only presentation of the existing seat-scoped Desk overview. */
import type { PsJsonValue } from './psjson.ts';
import { deskOverview } from './desk.ts';
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
  return Math.max(30, resolved);
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

/** Wrap only when an item itself exceeds the pane; never discard seat/count text. */
function wrap(line: Line, width: number): Line[] {
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
export function readDashboardCheckpoint(workspace: string, overview: ObjectValue, now: number): { checkpoint: DashboardCheckpoint | null; checkpoint_error?: string } {
  const me = object(overview['this_seat']), conversation = me['session_id'], seatId = me['seat_id'];
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

type FrameOptions = { width?: number; now: number | Date; color?: DashboardColor; rows?: number; checkpoint?: DashboardCheckpoint | null };
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
  const hubs = list(overview['open_projects']).map(label).filter(Boolean).map(name => run(name.replace(/^projects\//, '')));
  const field = clockField(now);
  let clock: Frame['clock'];
  let first: Line | undefined;
  for (const gap of ['    ', '  ']) {
    const candidate = join([[run('● ', claim === 'held' ? 'held' : 'attention'), ...seatLine], ...counts], gap);
    const used = dashboardCells(plain(candidate));
    if (used + dashboardCells(gap + 'as of ' + field) <= width) {
      first = [...candidate, run(' '.repeat(width - used - 14)), run('as of ', 'label'), run(field, 'label')];
      clock = { row: 1, column: width - 7, field }; break;
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
  if (!first && Number.isInteger(options.rows) && options.rows! > 0) lines = lines.slice(0, options.rows);
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
  let lastRead = 0;
  let displayedKey: string | undefined;
  let displayedClock: string | undefined;
  let displayedRows = 0;
  let unknownSince: number | undefined;
  let refusal = '';
  // A DAMAGED RECORD IS NOT AN UNREACHABLE DESK (kickoffs/s164 row 5; the planner's review of c54): the Desk was read,
  // and the line names the record that could not be.
  let damaged = '';
  let damagedSince: number | undefined;
  let observedNow = 0;

  const render = (force = false) => {
    const width = dashboardWidth(options.width, process.stdout.columns);
    const frame: Frame = lastOverview ? dashboardFrame(lastOverview, { width, rows: process.stdout.rows, now: lastRead, color, checkpoint: lastCheckpoint }) : { text: '', key: '' };
    for (const text of [
      damagedSince !== undefined ? `checkpoint unknown since ${elapsedAge(observedNow - damagedSince)}: ${damaged}` : '',
      unknownSince !== undefined ? `unknown since ${elapsedAge(observedNow - unknownSince)}: ${refusal}` : '',
    ]) {
      if (!text) continue;
      const warning = wrap([run(text, 'attention')], width).map(line => paint(line, color)).join('\n');
      frame.text += `${frame.text ? '\n' : ''}${warning}`;
      frame.key += `\n${warning}`;
    }
    if (force || frame.key !== displayedKey) {
      displayedKey = frame.key;
      displayedClock = frame.clock?.field;
      displayedRows = frame.text.split('\n').length;
      // One write and no final newline: a frame filling the pane must not scroll.
      process.stdout.write(tty ? `\x1b[?25l\x1b[H\x1b[2J${frame.text}\x1b[1;1H\x1b[?25l` : `---\n${frame.text}\n`);
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
      process.stdout.write(`${RESET}\x1b[${Math.max(1, displayedRows)};1H\r\n\x1b[?25h`);
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
