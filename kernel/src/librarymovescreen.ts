/** One terminal owner from the first move check through its receipt. Rendering and reduction are terminal-free. */
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { screenState, drawScreen, reduceScreen, screenDecoder, plainRequired, terminalStart, terminalRestore, type ScreenModel, type ScreenState, type ScreenKey, type ScreenTerminal } from './menuscreen.ts';
import type { MoveControl, Blocker } from './librarymove.ts';
import { cleanupPlanId } from './librarymove.ts';

export interface MoveReply { refusal: string | null; value: any; humanText?: string; exitCode?: number; uninspectable?: number }
export interface MoveEngine { check(selected?: string[]): Promise<MoveReply>; apply(planId: string, control: MoveControl, selected?: string[]): Promise<MoveReply> }
export type MovePhase = 'checking' | 'waiting' | 'ready' | 'moving' | 'done' | 'refused';
export interface MoveView { phase: MovePhase; value?: any; refusal?: string | null; progress?: { phase: string; file?: string; bytes?: number }; notice?: string; cleared?: string[] }

const wrapMove = (text: string, width = 56): string[] => text.split('\n').flatMap(line => {
  const rows: string[] = [];
  while (line.length > width) { let at = line.lastIndexOf(' ', width); if (at < width / 3) at = width; rows.push(line.slice(0, at)); line = line.slice(at).trimStart(); }
  rows.push(line); return rows;
});
const moveWords = (text: string) => text.replace(/\bambiguous occurrences\b/g, 'places to check').replace(/\baside\b/g, 'old folder').replace(/\bmanifest\b/g, 'recorded file list').replace(/\bjournal\b/g, 'move record').replace(/\bbarrier\b/g, 'maintenance flag');
export function moveScreenModel(view: MoveView): ScreenModel {
  const value = view.value ?? {}, blockers: Blocker[] = value.blockers ?? [];
  const before = [value.workspace || value.source ? 'From  ' + (value.workspace ?? value.source) : '', value.destination ? 'To    ' + value.destination : ''].filter(Boolean).flatMap(line => wrapMove(line));
  if (value.cleanup && view.phase === 'ready') {
    if (value.confirming) return { title: 'Delete the ticked old Library copies', before: (value.selected ?? []).flatMap((file: string) => wrapMove(file)), field: { label: 'Type delete', hint: 'delete', enter: 'delete' }, items: [], after: ['Only these copies are deleted. Your Library is kept.'], esc: 'quit' };
    return { title: 'Delete old Library copies', before: [value.candidates?.length ? 'Tick only the copies you want to delete.' : 'No unchanged old copies can be deleted.'],
      items: [...(value.candidates ?? []).map((row: any) => ({ id: 'copy:' + row.path, text: ((value.selected ?? []).includes(row.path) ? '[x] ' : '[ ] ') + row.path, detail: wrapMove(row.path + ' (' + row.bytes.toLocaleString('en-US') + ' bytes)') })),
        { id: 'move', text: 'Delete the ticked folders', disabled: !value.selected?.length }, { id: 'cancel', text: 'Cancel' }], after: ['Enter or Space ticks a copy.'], esc: 'quit' };
  }
  if (value.cleanup && (view.phase === 'done' || view.phase === 'refused')) return { title: view.refusal ? 'Old Library copies were kept.' : 'Old Library copies deleted.',
    before: view.refusal ? wrapMove(moveWords(view.refusal)) : [(value.deleted?.length ?? 0) + ' copies deleted. Your Library is kept.'],
    items: [...(value.deleted ?? []).map((file: string) => 'Deleted ' + file), ...(value.things_for_you ?? [])].flatMap((line: string, index: number) => wrapMove(line).map((text, row) => ({ id: index + '-' + row, text, disabled: true }))), esc: 'quit' };
  if (value.cleanup && view.phase === 'moving') return { title: 'Deleting selected old Library copies', before: ['Your Library is kept.', ...wrapMove(view.notice ?? 'Checking each copy again before deleting it.')], items: [], esc: 'quit' };
  if (view.phase === 'ready') return { title: 'Ready. Nothing else is using the Library.', before: [...before, ...(view.notice ? wrapMove(view.notice) : [])], items: [{ id: 'move', text: 'Move it now' }, { id: 'cancel', text: 'Cancel' }], esc: 'quit' };
  if (view.phase === 'waiting') {
    const groups = new Map<string, Blocker[]>();
    for (const row of blockers) groups.set(row.name, [...(groups.get(row.name) ?? []), row]);
    const items = [...(view.cleared ?? []).map(name => ({ id: name, text: '[x] ' + name + '  closed', disabled: true })), ...[...groups].map(([name, rows]) => {
      const count = new Set(rows.map(row => row.pid).filter(Boolean)).size;
      const structural = rows.some(row => row.kind === 'reason' || row.kind === 'folder');
      const label = name + (count > 1 ? ` (${count} processes)` : '');
      return { id: name, text: '[ ] ' + label + (structural ? '' : '  still open'), disabled: true,
        detail: rows.flatMap(row => wrapMove(moveWords(structural ? row.detail + '. ' + row.fix : row.kind === 'holder' ? row.fix : /sandbox-service/i.test(name) ? row.fix : ''))) };
    })];
    if (typeof value.files === 'number') before.push(`${value.files.toLocaleString('en-US')} files, ${Math.ceil(value.bytes / 1024 / 1024)} megabytes;`, `${Math.floor(value.destination_free_bytes / 1024 / 1024)} megabytes free.`);
    if (value.obsidian_vault) before.push(...wrapMove('It leaves your Obsidian vault ' + value.obsidian_vault + '.'));
    const scrollItems = items.flatMap(item => [item, ...((item as any).detail ?? []).filter(Boolean).map((line: string, index: number) => ({ id: item.id + '-' + index, text: '  ' + line, disabled: true }))].map(row => ({ ...row, detail: undefined })));
    return { title: blockers.some(row => row.kind === 'holder') ? 'Waiting. A program still has the Library open.' : 'Move the Library', before: [...before, '', 'Close or fix these; this list updates by itself:'], items: scrollItems, after: ['Nothing has moved.', ...(view.notice ? wrapMove(view.notice) : [])], esc: 'quit' };
  }
  if (view.phase === 'moving') {
    const stage = value.move_stage ?? 2, copied = value.move_copied ?? 0, total = value.files ?? 0;
    const steps = ['preparing the folder', 'copying files', 'checking the copy', 'finishing'];
    const filled = total ? Math.min(20, Math.floor(copied / total * 20)) : 0;
    return { title: 'Moving the Library', before: [...before, '', `Step ${stage} of 4: ${steps[stage - 1]}`, '[' + '#'.repeat(filled) + '-'.repeat(20 - filled) + ']', `${copied} of ${total} files`, ...(value.move_seconds === undefined ? [] : [`About ${value.move_seconds} seconds left`]), ...wrapMove(view.notice ?? '(!) Leave Orca and Obsidian closed until this finishes.')], items: [], esc: 'cancel' };
  }
  if (view.phase === 'done') {
    const cancelled = value.state === 'aborted' || value.state === 'cancelled', things: string[] = cancelled ? [] : value.things_for_you ?? [];
    const lines = cancelled ? [value.retained ? 'The partial copy is kept at ' + value.retained : 'Nothing was moved.'] : [value.workspace ?? value.destination ?? '', things.length ? `${things.length} things for you:` : 'Nothing left for you to do.'];
    const items = things.flatMap((line, index) => wrapMove(`${index + 1}. ${moveWords(line)}`).map((text, row) => ({ id: index + '-' + row, text, disabled: true })));
    return { title: cancelled ? 'Cancelled. The Library folder is restored.' : 'Moved. The Library is now at', before: lines.flatMap(line => wrapMove(line)), items,
      after: value.aside || value.retained ? [...wrapMove('The old copy is kept at ' + (value.aside ?? value.retained)), 'Once all is well:', 'deskpost library move --clean-up'] : [], esc: 'quit' };
  }
  if (view.phase === 'refused') return { title: 'The Library could not be moved.', before: [...before, ...wrapMove(moveWords(view.refusal ?? 'Check the listed paths and run the preview again.'))], items: [], esc: 'quit' };
  return { title: 'Checking the Library', before, items: [], esc: 'quit' };
}
function moveDrawing(view: MoveView, state: ScreenState, colour: boolean): string[] {
  const lines = drawScreen(state, colour).lines.map(line => {
    if (view.phase !== 'ready' && line.startsWith(' > ')) line = '   ' + line.slice(3);
    if (view.phase !== 'ready' && line.includes('Arrows move')) line = view.phase === 'waiting' || view.phase === 'done' ? '   Arrows scroll   Esc quit' : '   Esc ' + (view.phase === 'moving' ? 'cancel' : 'quit');
    return colour ? line.replace(/\x1b\[34m/g, '\x1b[38;2;137;180;250m').replace(/\x1b\[90m/g, '\x1b[38;2;166;173;200m').replace(/\x1b\[33m/g, '\x1b[38;2;249;226;175m') : line;
  });
  return lines;
}
export function drawMoveScreen(view: MoveView, width = 60, height = 24, colour = false): string[] {
  const model = moveScreenModel(view);
  if (plainRequired(width, height)) return ['Move the Library', ...[...(model.before ?? []), ...model.items.map(item => item.text), ...(model.after ?? [])].map((line, index) => `${index + 1}. ${line}`)].flatMap(line => wrapMove(line, width));
  return moveDrawing(view, screenState(model, width, height), colour);
}

/** Bun's setRawMode(false) resets extra Windows input flags; preserve both actual console modes. */
export function preserveConsoleModes(): (() => void) | undefined {
  if (process.platform !== 'win32' || typeof (globalThis as any).Bun !== 'object') return;
  const ffi = createRequire(import.meta.url)('bun:ffi'), t = ffi.FFIType;
  const library = ffi.dlopen('kernel32.dll', {
    GetStdHandle: { args: [t.i32], returns: t.i64_fast },
    GetConsoleMode: { args: [t.i64_fast, t.ptr], returns: t.i32 },
    SetConsoleMode: { args: [t.i64_fast, t.u32], returns: t.i32 },
  });
  try {
    const modes = [-10, -11].map(which => {
      const handle = library.symbols.GetStdHandle(which), mode = new Uint32Array(1);
      if (!library.symbols.GetConsoleMode(handle, mode)) throw new Error('The terminal mode could not be read; use --plain.');
      return { handle, mode: mode[0]! };
    });
    return () => {
      try {
        let failed = false;
        for (const entry of modes) if (!library.symbols.SetConsoleMode(entry.handle, entry.mode)) failed = true;
        if (failed) throw new Error('The terminal mode could not be restored; reopen this window.');
      }
      finally { library.close(); }
    };
  } catch (error) { library.close(); throw error; }
}

export class MoveSession {
  private engine: MoveEngine;
  private options: { terminal?: ScreenTerminal; colour?: boolean; refreshMilliseconds?: number };
  constructor(engine: MoveEngine, options: { terminal?: ScreenTerminal; colour?: boolean; refreshMilliseconds?: number } = {}) { this.engine = engine; this.options = options; }
  async run(): Promise<MoveReply> {
    const terminal = this.options.terminal ?? { input: process.stdin, output: process.stdout };
    let width = Math.min(60, terminal.output.columns ?? 60), height = terminal.output.rows ?? 24;
    if (plainRequired(width, height) || (!this.options.terminal && (!process.stdin.isTTY || !process.stdout.isTTY || typeof terminal.input.setRawMode !== 'function'))) return this.engine.check();
    const restoreConsoleModes = this.options.terminal ? undefined : preserveConsoleModes();
    const originalRaw = terminal.input.isRaw ?? false, decode = screenDecoder(), utf8 = new StringDecoder('utf8');
    let view: MoveView = { phase: 'checking' }, state: ScreenState = screenState(moveScreenModel(view), width, height);
    let busy = false, settled = false, cancelled = false, promoted = false, restored = false;
    let receiptReply: MoveReply | undefined;
    const selectedCopies = new Set<string>(); let typedDelete = false;
    let escapeTimer: ReturnType<typeof setTimeout> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined;
    let pendingEscape = false, resolveRun: (reply: MoveReply) => void = () => {}, rejectRun: (error: unknown) => void = () => {};
    const previouslyBlocked = new Set<string>();
    const restore = () => {
      if (restored) return; restored = true; settled = true;
      if (escapeTimer) clearTimeout(escapeTimer); if (refreshTimer) clearInterval(refreshTimer);
      terminal.input.removeListener('data', onData); terminal.input.removeListener('error', onError); terminal.input.removeListener('end', onEnd);
      terminal.output.removeListener?.('resize', onResize); process.removeListener('exit', restore); process.removeListener('SIGINT', onInterrupt);
      try { terminal.input.setRawMode(originalRaw); }
      finally { try { terminal.input.pause(); terminal.output.write(terminalRestore); } finally { restoreConsoleModes?.(); } }
    };
    const paint = () => {
      if (settled) return;
      const model = moveScreenModel(view);
      state = { ...state, model, width, height, index: Math.max(0, Math.min(state.index, model.items.length - 1)), result: undefined };
      const lines = moveDrawing(view, state, this.options.colour ?? process.env['NO_COLOR'] === undefined);
      terminal.output.write('\x1b[H\x1b[2J' + lines.join('\r\n'));
    };
    const finish = (reply: MoveReply) => { if (!settled) { settled = true; resolveRun(reply); } };
    const cancel = () => {
      if (promoted) { view.notice = 'Almost done; this cannot stop safely now'; paint(); return; }
      cancelled = true;
      if (view.phase !== 'moving' && !busy) finish({ refusal: null, value: { state: 'cancelled', written: false }, exitCode: 130 });
    };
    const refresh = async () => {
      if (busy || settled) return;
      busy = true;
      try {
        const reply = await this.engine.check([...selectedCopies]);
        if (cancelled) { finish({ refusal: null, value: { state: 'cancelled', written: false }, exitCode: 130 }); return; }
        const blockers: Blocker[] = reply.value?.blockers ?? [];
        for (const blocker of blockers) previouslyBlocked.add(blocker.name);
        view = { phase: reply.refusal ? 'refused' : reply.value?.ready ? 'ready' : 'waiting', value: reply.value, refusal: reply.refusal, notice: reply.uninspectable ? `${reply.uninspectable} programs could not be checked.` : undefined,
          cleared: [...previouslyBlocked].filter(name => !blockers.some(blocker => blocker.name === name)) };
        if (view.phase === 'ready') state.index = 0;
        paint();
        if (reply.refusal) finish({ ...reply, exitCode: reply.exitCode ?? 1 });
      } finally { busy = false; }
    };
    const start = async () => {
      if (busy || settled || view.phase !== 'ready') return;
      if (view.value?.cleanup && !typedDelete) { view.value.confirming = true; state.text = ''; paint(); return; }
      busy = true;
      try {
        const confirmed = view.value?.plan_id;
        const latest = await this.engine.check([...selectedCopies]);
        if (cancelled) { finish({ refusal: null, value: { state: 'cancelled', written: false }, exitCode: 130 }); return; }
        if (latest.refusal || !latest.value?.ready || latest.value.plan_id !== confirmed) {
          typedDelete = false;
          if (latest.value?.cleanup) {
            for (const file of selectedCopies) if (!latest.value.candidates.some((row: any) => row.path === file)) selectedCopies.delete(file);
            latest.value.selected = [...selectedCopies]; latest.value.plan_id = cleanupPlanId(latest.value.candidates, latest.value.selected);
          }
          view = { phase: latest.refusal ? 'refused' : latest.value?.ready ? 'ready' : 'waiting', value: latest.value, refusal: latest.refusal, notice: 'Something in the Library changed; checking again' }; paint(); return;
        }
        let copied = 0; const started = Date.now();
        promoted = latest.value?.past_promotion === true;
        view = { phase: 'moving', value: { ...latest.value, move_stage: 1, move_copied: 0 } }; paint();
        const reply = await this.engine.apply(confirmed, { cancelled: () => cancelled, progress: event => {
          if (event.phase === 'promote') promoted = true;
          if (event.phase === 'copy' || event.phase === 'rewrite') view.value.move_stage = 2;
          if (['copy-verify', 'before-stat', 'promote'].includes(event.phase)) view.value.move_stage = 3;
          if (['cutover', 'registry', 'verify', 'complete', 'journal-copy'].includes(event.phase) || event.phase.startsWith('pointer-')) view.value.move_stage = 4;
          if (event.phase === 'copy' && event.file) { copied++; view.value.move_copied = copied; view.value.move_seconds = Math.max(0, Math.ceil((Date.now() - started) / 1000 / copied * Math.max(0, (latest.value.files ?? copied) - copied))); }
          view.progress = event; paint();
        } }, [...selectedCopies]);
        if (reply.value?.state === 'held') { cancelled = false; promoted = false; view = { phase: 'waiting', value: { ...latest.value, ...reply.value } }; paint(); return; }
        view = { phase: reply.refusal ? 'refused' : 'done', value: { ...latest.value, ...reply.value }, refusal: reply.refusal, notice: view.notice }; state.index = 0; paint();
        receiptReply = { ...reply, exitCode: reply.exitCode ?? (reply.refusal ? 1 : 0) };
      } finally { busy = false; }
    };
    const applyKey = (key: ScreenKey) => {
      if (receiptReply) {
        if (key.kind === 'enter' || key.kind === 'escape' || key.kind === 'interrupt') finish(receiptReply);
        else { state = reduceScreen(state, key); paint(); }
        return;
      }
      if (key.kind === 'escape' || key.kind === 'interrupt') { cancel(); return; }
      if (view.phase === 'waiting' && ['up', 'down', 'wheel', 'click'].includes(key.kind)) { state = reduceScreen(state, key); paint(); return; }
      if (view.phase !== 'ready' || busy) return;
      const toggle = (id: string) => {
        const file = id.slice(5); if (selectedCopies.has(file)) selectedCopies.delete(file); else selectedCopies.add(file);
        view.value.selected = [...selectedCopies]; view.value.plan_id = cleanupPlanId(view.value.candidates, view.value.selected); paint();
      };
      if (view.value?.cleanup && !view.value.confirming && key.kind === 'text' && key.text === ' ' && state.model.items[state.index]?.id.startsWith('copy:')) { toggle(state.model.items[state.index]!.id); return; }
      state = reduceScreen(state, key);
      if (view.value?.cleanup && state.result?.startsWith('copy:')) toggle(state.result);
      else if (view.value?.cleanup && state.result === 'submit') {
        if (state.text === 'delete') { typedDelete = true; void start().catch(rejectRun); } else paint();
      }
      else if (state.result === 'cancel') cancel();
      else if (state.result === 'move') void start().catch(rejectRun);
      else paint();
    };
    const onData = (data: Buffer | string) => {
      try {
        if (escapeTimer) clearTimeout(escapeTimer);
        let text = typeof data === 'string' ? data : utf8.write(data);
        if (pendingEscape) { text = '\x1b' + text; pendingEscape = false; }
        if (text === '\x1b' && !decode.isPasting()) { pendingEscape = true; escapeTimer = setTimeout(() => { pendingEscape = false; applyKey({ kind: 'escape' }); }, 30); return; }
        for (const key of decode(text)) applyKey(key);
      } catch (error) { rejectRun(error); }
    };
    const onError = (error: Error) => { if (view.phase === 'moving') { cancelled = true; view.notice = error.message; } else rejectRun(error); };
    const onEnd = () => { if (view.phase === 'moving') cancelled = true; else cancel(); };
    const onInterrupt = () => cancel();
    const onResize = () => { width = Math.min(60, terminal.output.columns ?? width); height = terminal.output.rows ?? height; if (plainRequired(width, height) && view.phase !== 'moving') finish({ refusal: null, value: view.value, exitCode: view.value?.ready ? 0 : 3 }); else paint(); };
    try {
      terminal.input.on('data', onData); terminal.input.on('error', onError); terminal.input.on('end', onEnd);
      terminal.output.on?.('resize', onResize); process.on('exit', restore); process.on('SIGINT', onInterrupt);
      terminal.input.setRawMode(true); terminal.input.resume(); terminal.output.write(terminalStart);
      return await new Promise<MoveReply>((resolve, reject) => {
        resolveRun = resolve; rejectRun = reject;
        refreshTimer = setInterval(() => { if (view.phase === 'waiting') void refresh().catch(rejectRun); }, this.options.refreshMilliseconds ?? 1000);
        paint(); void refresh().catch(rejectRun);
      });
    } finally { restore(); }
  }
}
