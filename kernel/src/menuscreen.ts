/** Familiar terminal controls; the reducer and drawing never touch a terminal. */
import { StringDecoder } from 'node:string_decoder';
export interface ScreenItem { id: string; text: string; group?: string; disabled?: boolean; dim?: boolean; nameLength?: number; detail?: string[] }
export interface ScreenModel {
  title: string; before?: string[]; items: ScreenItem[]; after?: string[];
  warning?: boolean; afterKind?: 'error' | 'detail';
  field?: { label: string; hint?: string; enter?: string | null; allowEmpty?: boolean }; search?: boolean; esc?: string; initial?: string;
}
export interface ScreenState { model: ScreenModel; index: number; text: string; offset: number; width: number; height: number; lastClick?: { index: number; at: number }; result?: string }
export type ScreenKey = { kind: 'up' | 'down' | 'enter' | 'escape' | 'interrupt' | 'backspace' } |
  { kind: 'text' | 'paste'; text: string } | { kind: 'click'; row: number; at: number } | { kind: 'wheel'; delta: number };
export const terminalStart = '\x1b[?25l\x1b[?2004h';
export const terminalRestore = '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\r\n';
export const mouseMode = (field: boolean): string => field ? '\x1b[?1000l\x1b[?1006l' : '\x1b[?1000h\x1b[?1006h';
export function screenState(model: ScreenModel, width = 60, height = 30, text = ''): ScreenState {
  return { model, index: Math.max(0, model.items.findIndex(i => i.id === model.initial)), text, offset: 0, width, height };
}
export function plainRequired(width: number, height: number): boolean { return width < 60 || height < 14; }
export function screenNeedsPlain(state: ScreenState): boolean {
  const model = state.model;
  const minimum = 2 + (model.before?.length ?? 0) + (model.field || model.search ? 2 : 0) +
    (model.items[state.index]?.detail?.length ?? 0) + (model.after?.length ?? 0) + 2 + (model.items.length ? 4 : 0);
  return plainRequired(state.width, state.height) || state.height < minimum;
}
const ascii = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const truncate = (s: string, width: number) => s.length <= width ? s : width < 4 ? s.slice(0, width) : s.slice(0, width - 3).trimEnd() + '...';
export interface ScreenDrawing { lines: string[]; itemRows: Map<number, number>; offset: number }
export function drawScreen(state: ScreenState, colour = false): ScreenDrawing {
  const { model } = state;
  const style = (s: string, code: number) => colour ? `\x1b[${code}m${s}\x1b[0m` : s;
  const lines = [style(truncate(ascii((model.warning ? '   ' : ' ') + model.title), state.width), model.warning ? 33 : 1), ...(model.warning ? [] : ['']), ...(model.before ?? []).map(s => truncate(ascii(s), state.width))];
  if (model.field || model.search) {
    lines.push(truncate(ascii(`${model.field ? '   ' : ' '}${model.field?.label ?? 'Search'}  ${state.text || model.field?.hint || '_ type a seat name, or a new one'}${state.text ? '_' : ''}`), state.width));
    if (!model.field) lines.push('');
  }
  const details = model.items[state.index]?.detail ?? [];
  const footer = model.field ? `${model.field.enter === null ? '   ' : `   Enter ${model.field.enter ?? 'next'}   `}Esc ${model.esc ?? 'go back'}` : `   Arrows move   Enter choose   Esc ${state.text && model.search ? 'clear search' : model.esc ?? 'go back'}`;
  const tail = (!model.field && (details.length || model.after?.length) ? [''] : []).concat(details.map(s => style(truncate(ascii(s), state.width), 90)), (model.after ?? []).map(s => style(truncate(ascii(s), state.width), model.afterKind === 'error' ? 31 : s.includes('(!)') ? 33 : 90)), model.field && !model.after?.length ? [] : [''], style(truncate(footer, state.width), 34));
  const header = [...lines];
  let start = Math.max(0, Math.min(state.offset, state.index));
  const itemRows = new Map<number, number>();
  let end = start;
  for (;;) {
    lines.splice(0, lines.length, ...header); itemRows.clear();
    if (start > 0) lines.push(style(`   ${start} more above`, 90));
    let group = '';
    for (end = start; end < model.items.length; end++) {
      const item = model.items[end]!;
      const changedGroup = item.group && item.group !== group;
      const headingRows = changedGroup ? (group ? 2 : 1) : !item.group && group ? 1 : 0;
      if (lines.length + headingRows + 1 > state.height - tail.length - (end < model.items.length - 1 ? 1 : 0)) break;
      if (changedGroup) { if (group) lines.push(''); group = item.group!; lines.push(style('   ' + group, 90)); }
      else if (!item.group && group) { lines.push(''); group = ''; }
      itemRows.set(lines.length + 1, end);
      const text = truncate(ascii(item.text), Math.max(0, state.width - 4));
      const unselected = item.disabled || item.dim ? style(text, 90) : item.nameLength ? style(text.slice(0, item.nameLength), 1) + style(text.slice(item.nameLength), 90) : style(text, text.includes('(!)') ? 33 : 0);
      lines.push(end === state.index ? ' > ' + style(text.padEnd(Math.max(0, state.width - 4)), item.disabled ? 90 : 7) : '   ' + unselected);
    }
    if (end > state.index || start >= state.index) break;
    start++;
  }
  if (end < model.items.length) lines.push(style(`   ${model.items.length - end} more below`, 90));
  lines.push(...tail);
  return { lines: lines.slice(0, state.height).map(line => {
    if (!colour) return truncate(ascii(line), state.width);
    return line; // coloured item widths were measured before adding escapes
  }), itemRows, offset: start };
}
export function reduceScreen(previous: ScreenState, key: ScreenKey): ScreenState {
  const state: ScreenState = { ...previous, result: undefined };
  if (key.kind !== 'click') state.lastClick = undefined;
  const move = (n: number) => { state.index = Math.max(0, Math.min(state.model.items.length - 1, state.index + n)); state.lastClick = undefined; };
  if (key.kind === 'interrupt') state.result = 'interrupt';
  else if (key.kind === 'escape') {
    if (state.model.search && state.text) { state.text = ''; state.index = 0; state.offset = 0; }
    else state.result = 'back';
  } else if (key.kind === 'text' || key.kind === 'paste') { state.text += key.text.replace(/[\x00-\x1f\x7f]/g, ''); state.index = 0; state.offset = 0; }
  else if (key.kind === 'backspace') { state.text = [...state.text].slice(0, -1).join(''); state.index = 0; state.offset = 0; }
  else if (key.kind === 'up') move(-1);
  else if (key.kind === 'down') move(1);
  else if (key.kind === 'wheel') move(key.delta);
  else if (key.kind === 'enter') state.result = state.model.field ? 'submit' : state.model.items[state.index]?.disabled ? undefined : state.model.items[state.index]?.id;
  else if (key.kind === 'click' && !state.model.field) {
    const index = drawScreen(state).itemRows.get(key.row);
    if (index !== undefined) {
      if (state.lastClick?.index === index && key.at - state.lastClick.at <= 400 && !state.model.items[index]?.disabled) state.result = state.model.items[index]?.id;
      state.index = index; state.lastClick = { index, at: key.at };
    }
  }
  state.offset = drawScreen(state).offset;
  return state;
}
/** Incremental decoder: escape sequences and bracketed paste may cross stream chunks. */
export function screenDecoder(): ((chunk: string) => ScreenKey[]) & { isPasting: () => boolean } {
  let pending = '', paste: string | null = null;
  const decode = (chunk: string): ScreenKey[] => {
    if (chunk.includes('\x03')) { pending = ''; paste = null; return [{ kind: 'interrupt' }]; }
    pending += chunk;
    const keys: ScreenKey[] = [];
    while (pending) {
      if (paste !== null) {
        const end = pending.indexOf('\x1b[201~');
        if (end < 0) break;
        paste += pending.slice(0, end); pending = pending.slice(end + 6);
        keys.push({ kind: 'paste', text: paste }); paste = null; continue;
      }
      if (pending.startsWith('\x1b[200~')) { paste = ''; pending = pending.slice(6); continue; }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(pending);
      if (mouse) {
        pending = pending.slice(mouse[0].length);
        const button = Number(mouse[1]);
        if (button === 64 || button === 65) keys.push({ kind: 'wheel', delta: button === 64 ? -1 : 1 });
        else if (button === 0 && mouse[4] === 'M') keys.push({ kind: 'click', row: Number(mouse[3]), at: Date.now() });
        continue;
      }
      if (pending.startsWith('\x1b[A') || pending.startsWith('\x1b[B')) {
        keys.push({ kind: pending[2] === 'A' ? 'up' : 'down' }); pending = pending.slice(3); continue;
      }
      if (pending.startsWith('\x1b[')) {
        const other = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
        if (!other) break;
        pending = pending.slice(other[0].length); continue;
      }
      const character = [...pending][0]!; pending = pending.slice(character.length);
      keys.push(character === '\x03' ? { kind: 'interrupt' } : character === '\x1b' ? { kind: 'escape' } :
        character === '\r' || character === '\n' ? { kind: 'enter' } : character === '\x7f' || character === '\b' ? { kind: 'backspace' } : { kind: 'text', text: character });
    }
    return keys;
  };
  return Object.assign(decode, { isPasting: () => paste !== null });
}
export interface ScreenTerminal {
  input: { isRaw?: boolean; setRawMode: (raw: boolean) => unknown; resume: () => unknown; pause: () => unknown;
    on: (event: string, listener: (...args: any[]) => void) => unknown; removeListener: (event: string, listener: (...args: any[]) => void) => unknown };
  output: { write: (s: string) => unknown; columns?: number; rows?: number;
    on?: (event: string, listener: () => void) => unknown; removeListener?: (event: string, listener: () => void) => unknown };
}
/** Every listener and terminal mode belongs to this question, never to the program it launches. */
export async function askScreen(model: ScreenModel | ((text: string) => ScreenModel), options: { width?: number; height?: number; text?: string; terminal?: ScreenTerminal; colour?: boolean } = {}): Promise<{ id: string; text: string }> {
  const terminal = options.terminal ?? { input: process.stdin, output: process.stdout };
  const initial = typeof model === 'function' ? model(options.text ?? '') : model;
  const columns = terminal.output.columns ?? process.stdout.columns ?? options.width ?? 60;
  const rows = terminal.output.rows ?? process.stdout.rows ?? options.height ?? 30;
  let state = screenState(initial, Math.min(options.width ?? columns, columns), Math.min(options.height ?? rows, rows), options.text);
  const decode = screenDecoder();
  const utf8 = new StringDecoder('utf8');
  let onData: (data: Buffer | string) => void = () => {};
  let onError: (error: Error) => void = () => {};
  let onEnd: () => void = () => {};
  let onResize: () => void = () => {};
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingEscape = false;
  const paint = () => {
    if (screenNeedsPlain(state)) { state.result = 'plain'; return; }
    const drawing = drawScreen(state, options.colour ?? process.env['NO_COLOR'] === undefined);
    terminal.output.write('\x1b[?25l\x1b[H\x1b[2J' + drawing.lines.join('\r\n') + mouseMode(!!state.model.field));
    if (state.model.field) {
      const row = (state.model.warning ? 2 : 3) + (state.model.before?.length ?? 0);
      const column = Math.min(state.width, 6 + state.model.field.label.length + state.text.length);
      terminal.output.write(`\x1b[${row};${column}H\x1b[?25h`);
    }
  };
  try {
    terminal.input.setRawMode(true); terminal.input.resume(); terminal.output.write(terminalStart);
    return await new Promise((resolve, reject) => {
      const apply = (key: ScreenKey) => {
        state = reduceScreen(state, key);
        if (typeof model === 'function' && !state.result) state.model = model(state.text);
        if (!state.result) paint();
        if (state.result) resolve({ id: state.result, text: state.text });
      };
      onData = data => {
        try {
          if (escapeTimer) clearTimeout(escapeTimer);
          let text = typeof data === 'string' ? data : utf8.write(data);
          if (pendingEscape) { text = '\x1b' + text; pendingEscape = false; }
          // Wait briefly for the remainder of a split escape sequence.
          if (text === '\x1b' && !decode.isPasting()) { pendingEscape = true; escapeTimer = setTimeout(() => { pendingEscape = false; try { apply({ kind: 'escape' }); } catch (error) { reject(error); } }, 30); return; }
          for (const key of decode(text)) { apply(key); if (state.result) break; }
        } catch (error) { reject(error); }
      };
      onError = reject; onEnd = () => reject(new Error('The menu input ended.'));
      onResize = () => {
        try {
          state.width = Math.min(options.width ?? terminal.output.columns ?? state.width, terminal.output.columns ?? options.width ?? state.width);
          state.height = terminal.output.rows ?? state.height;
          if (screenNeedsPlain(state)) resolve({ id: 'plain', text: state.text }); else paint();
        } catch (error) { reject(error); }
      };
      terminal.input.on('data', onData); terminal.input.on('error', onError); terminal.input.on('end', onEnd);
      terminal.output.on?.('resize', onResize);
      paint();
      if (state.result === 'plain') resolve({ id: 'plain', text: state.text });
    });
  } finally {
    if (escapeTimer) clearTimeout(escapeTimer);
    terminal.input.removeListener('data', onData); terminal.input.removeListener('error', onError); terminal.input.removeListener('end', onEnd);
    terminal.output.removeListener?.('resize', onResize);
    try { terminal.input.setRawMode(false); } finally { terminal.input.pause(); terminal.output.write(terminalRestore); }
  }
}
