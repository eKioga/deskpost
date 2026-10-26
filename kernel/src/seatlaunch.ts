/** A seat's launch record and the shared, pure launch planner (ADR-0076). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeAtomicText } from './fsx.ts';
import { enterSeatRegistryLock, exitBookLock, assertSeatRegistryLockHeld } from './locks.ts';
import { beginSeatMutation, recheckSeatMutation, seatFilePaths } from './seatpaths.ts';
import { addedDirsStatus, addedDirArguments, lettersPromptArguments, nameArguments } from './seatdirs.ts';
import { ASSISTANT_LABEL, isConversationId, type Assistant, type ConversationView } from './conversation.ts';

import { resolveSeatName } from './seatdesk.ts';
import { readRegistryRows, registryFilePath, writeSeatRegistry } from './seatregistry.ts';
import { readInboundSettings, inboundSettingsArguments } from './seatinbound.ts';
import { seatConversationView, newConversationId } from './conversation.ts';
import { agentExecutable, resolveOnPath } from './machine.ts';
import { pendingLetterPagesForSeat } from './desk.ts';
import type { PsJsonValue } from './psjson.ts';
import { LAUNCH_ACCESS_VALUES } from './menuaccess.ts';
export { LAUNCH_ACCESS_VALUES } from './menuaccess.ts';

export class SeatLaunchRefusal extends Error {}
export const launchDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface LaunchApproval { plan_id: string; utc: string; args_sha256: string }
export interface LaunchRecord {
  schema: 1; seat_id: string; assistant: Assistant | null;
  args: Record<Assistant, string[]>;
  approved: Record<Assistant, LaunchApproval | null>;
}
export type LaunchRead =
  | { state: 'unset'; digest: 'absent' }
  | { state: 'valid'; digest: string; record: LaunchRecord }
  | { state: 'invalid'; digest: string; reason: string }
  | { state: 'unreadable'; reason: string };
export function seatLaunchPath(stateDirectory: string, seat: string): string {
  return path.join(seatFilePaths(stateDirectory, seat).stateDirectory, 'launch.json');
}
export function emptyLaunchRecord(seatId: string): LaunchRecord {
  return { schema: 1, seat_id: seatId, assistant: null, args: { claude: [], codex: [] }, approved: { claude: null, codex: null } };
}
const keysAre = (value: unknown, keys: string[]): boolean => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
export function readSeatLaunch(stateDirectory: string, seat: string, seatId: string): LaunchRead {
  const file = seatLaunchPath(stateDirectory, seat);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'unset', digest: 'absent' };
    return { state: 'unreadable', reason: `${file}: ${(error as Error).message}` };
  }
  const digest = launchDigest(bytes);
  try {
    const r = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as LaunchRecord;
    if (!keysAre(r, ['schema', 'seat_id', 'assistant', 'args', 'approved']) || r.schema !== 1 || !seatId || r.seat_id !== seatId ||
      ![null, 'claude', 'codex'].includes(r.assistant) || !keysAre(r.args, ['claude', 'codex']) || !keysAre(r.approved, ['claude', 'codex'])) {
      throw new Error('expected strict schema 1 and this seat_id');
    }
    for (const a of ['claude', 'codex'] as const) {
      const args = r.args[a], approval = r.approved[a];
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(`${a} args must be strings`);
      validateStoredFlags(a, args);
      if (args.length === 0) { if (approval !== null) throw new Error(`${a} empty args require null approval`); }
      else if (!keysAre(approval, ['plan_id', 'utc', 'args_sha256']) || typeof approval?.plan_id !== 'string' ||
        !/^seat-launch-[0-9a-f]{64}$/.test(approval.plan_id) || typeof approval.utc !== 'string' || !Number.isFinite(Date.parse(approval.utc)) ||
        approval.args_sha256 !== launchDigest(JSON.stringify(args))) throw new Error(`${a} flags have no matching approval`);
    }
    return { state: 'valid', digest, record: r };
  } catch (error) { return { state: 'invalid', digest, reason: `${file}: ${(error as Error).message}` }; }
}
/** The caller owns the registry lock and has checked this incarnation before every write. */
export function writeSeatLaunch(workspace: string, seat: string, record: LaunchRecord): void {
  assertSeatRegistryLockHeld(workspace, 'Writing a seat launch record');
  writeAtomicText(seatLaunchPath(path.join(workspace, '.claude'), seat), JSON.stringify(record, null, 2) + '\n');
}

/** One table for forbidden names, aliases and value-taking options; unknown bare flags remain possible. */
export const LAUNCH_FLAG_TABLE = {
  claude: {
    forbidden: ['--resume', '-r', '--session-id', '--continue', '-c', '--fork-session', '--teleport', '--from-pr', '--name', '-n', '--add-dir', '--settings', '--mcp-config', '--strict-mcp-config', '-i', '--image', '-w', '--worktree', '--bare', '--safe-mode', '--setting-sources', '--bg', '--background', '--desktop', '--tmux', '--no-daemon', 'daemon_auto_start'],
    values: ['--model', '--permission-mode', '--effort', '--agent', '--output-format', '--input-format', '--max-budget-usd', '--fallback-model', '--system-prompt', '--append-system-prompt', '--plugin-dir', '--plugin-url', '-m'],
  },
  codex: {
    forbidden: ['--last', '--name', '-n', '--add-dir', '-i', '--image', '-C', '--cd', '--worktree', '--remote', '--remote-auth-token-env', '--no-daemon', 'daemon_auto_start', '--dangerously-bypass-hook-trust', '--approve-for-me'],
    values: ['-a', '--ask-for-approval', '-s', '--sandbox', '-m', '--model', '-p', '--profile', '-c', '--config', '--enable', '--disable', '--color'],
  },
} as const;
/** The launcher owns these config roots (ADR-0076 C8 amendment), including whole-table replacements. */
export const GUARDED_CODEX_CONFIG = ['hooks', 'mcp_servers', 'plugins', 'features', 'profiles', 'profile', 'shell_environment_policy'] as const;
function validateFlagValue(assistant: Assistant, option: string, value: string): void {
  const allowed = LAUNCH_ACCESS_VALUES[assistant][ALIASES[option] ?? option];
  if (allowed && !allowed.includes(value)) throw new SeatLaunchRefusal(`${option} takes ${allowed.join(', ')}; got ${JSON.stringify(value)}. Nothing was saved.`);
  if (assistant !== 'codex') return;
  if (option === '-p' || option === '--profile') throw new SeatLaunchRefusal(`${option} loads another config profile; profiles are owned by the seated launcher.`);
  if (option === '-c' || option === '--config') {
    const key = value.split('=')[0]!.trim();
    const root = key.split('.')[0]!.replace(/^['"]|['"]$/g, '').trim();
    if ((GUARDED_CODEX_CONFIG as readonly string[]).includes(root)) throw new SeatLaunchRefusal(`${root} is owned by the seated launcher; it cannot be overridden in stored flags.`);
  }
  // --enable/--disable are feature overrides. Guard-loading features cannot be toggled here.
  if ((option === '--enable' || option === '--disable') && (GUARDED_CODEX_CONFIG as readonly string[]).includes(value))
    throw new SeatLaunchRefusal(`${value} is owned by the seated launcher; it cannot be toggled in stored flags.`);
}
function forbiddenIn(assistant: Assistant, token: string): string | undefined {
  const equals = token.indexOf('=');
  if (equals >= 0) { const inside = forbiddenIn(assistant, token.slice(equals + 1)); if (inside) return inside; }
  return LAUNCH_FLAG_TABLE[assistant].forbidden.find(name => name === 'daemon_auto_start' ? token.includes(name) :
    token === name || token.startsWith(name + '=') || (/^-[^-]$/.test(name) && token.startsWith(name) && token.length > 2));
}
export function validateStoredFlags(assistant: Assistant, args: string[]): void {
  const table = LAUNCH_FLAG_TABLE[assistant];
  let expectsValue = '';
  for (const arg of args) {
    if (/[\x00-\x1f\x7f"%]/.test(arg)) throw new SeatLaunchRefusal('Stored flags cannot hold control characters, DEL, " or %: the launch must preserve each argument.');
    const forbidden = forbiddenIn(assistant, arg);
    if (forbidden) throw new SeatLaunchRefusal(`${forbidden} is owned by the seated launcher (conversation, name, folders, guards, working root or claim); it cannot be stored.`);
    if (arg === '--') throw new SeatLaunchRefusal('A bare -- cannot be stored: it could introduce a prompt or subcommand.');
    if (expectsValue) {
      if (arg.startsWith('-')) throw new SeatLaunchRefusal(`Expected one value before ${arg}.`);
      validateFlagValue(assistant, expectsValue, arg);
      expectsValue = ''; continue;
    }
    if (!arg.startsWith('-') || arg === '-') throw new SeatLaunchRefusal(`Stored token ${JSON.stringify(arg)} is a prompt or subcommand, not an option value.`);
    if (/^-[^-].+/.test(arg)) {
      const shorts = [...table.values, ...table.forbidden].filter(name => /^-[^-]$/.test(name)).map(name => name.slice(1));
      if ([...arg.slice(1)].every(letter => shorts.includes(letter))) throw new SeatLaunchRefusal(`Grouped short options (${arg}) are refused; use one option per token, and a separate token for a one-letter value.`);
      if (!(table.values as readonly string[]).includes(arg.slice(0, 2))) throw new SeatLaunchRefusal(`Grouped short options (${arg}) are refused; use one option per token.`);
      const hidden = forbiddenIn(assistant, arg.slice(2));
      if (hidden) throw new SeatLaunchRefusal(`${hidden} cannot be stored as an attached value.`);
      validateFlagValue(assistant, arg.slice(0, 2), arg.slice(2).replace(/^=/, ''));
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals >= 0) validateFlagValue(assistant, arg.slice(0, equals), arg.slice(equals + 1));
    expectsValue = equals < 0 && (table.values as readonly string[]).includes(arg) ? arg : '';
  }
  if (expectsValue) throw new SeatLaunchRefusal('The last stored option needs one value.');
}
const ALIASES: Record<string, string> = { '-a': '--ask-for-approval', '-s': '--sandbox', '-m': '--model', '-p': '--profile', '-c': '--config', '-r': '--resume', '-n': '--name', '-i': '--image', '-C': '--cd', '-w': '--worktree' };
function optionNames(args: string[]): string[] {
  return args.filter(a => a.startsWith('-')).map(a => {
    const name = /^-[^-].+/.test(a) ? a.slice(0, 2) : a.split('=')[0]!;
    return ALIASES[name] ?? name;
  });
}
export function escapedArgv(args: string[], platform: NodeJS.Platform = process.platform): string {
  return args.map(arg => platform === 'win32'
    ? arg && !/[\s"]/.test(arg) ? arg : '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
    : /^[a-zA-Z0-9_@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'").join(' ');
}
function canonicalLaunchJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalLaunchJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalLaunchJson(object[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function classifyCommand(command: string, explicit?: string): Assistant | null {
  const name = path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const known = name === 'codex' || name === 'claude' ? name : null;
  if (explicit && !['claude', 'codex'].includes(explicit)) throw new SeatLaunchRefusal('--assistant takes claude or codex.');
  if (known && explicit && known !== explicit) throw new SeatLaunchRefusal(`--command ${command} conflicts with --assistant ${explicit}.`);
  return (explicit as Assistant | undefined) ?? known;
}
export interface LaunchInput {
  seat: string; row: { seat_id?: unknown } | null; record: LaunchRead;
  command?: string; assistant?: string; resume?: string; sessionId?: string; noLaunch?: boolean;
  intent: 'new' | 'resume'; fallback: Assistant; view?: ConversationView;
  mintedId: string; dirs: string[]; inbound: string[]; letters: number; passthrough: string[];
}
export function planSeatLaunch(input: LaunchInput): {
  command: string; assistant: Assistant | null; args: string[]; resume: string; sessionId: string;
  action: 'resume' | 'new' | 'restart' | 'minted' | 'named'; notice: string; stored: string[]; approval: LaunchApproval | null;
} {
  const record = input.record.state === 'valid' ? input.record.record : null;
  const preference = record?.assistant ?? null;
  const view = input.view;
  let chosen = input.command ?? preference ?? input.fallback;
  // An unconfigured seat keeps its recorded conversation's owner on resume.
  if (!input.command && !preference && input.intent === 'resume' && view?.session_id) chosen = view.assistant;
  const assistant = classifyCommand(chosen, input.assistant);
  let resume = input.resume ?? '', sessionId = input.sessionId ?? '';
  let action: 'resume' | 'new' | 'restart' | 'minted' | 'named' = resume ? 'resume' : sessionId ? 'new' : 'named';
  let notice = '';
  if (resume && sessionId) throw new SeatLaunchRefusal('--resume and --session-id are two different conversations; pass one.');
  for (const id of [resume, sessionId]) if (id && !isConversationId(id)) throw new SeatLaunchRefusal('A conversation id must be a uuid.');
  if ((resume || sessionId) && assistant === null) throw new SeatLaunchRefusal(`--resume and --session-id need --assistant claude|codex for ${chosen}.`);
  if (!resume && !sessionId && input.intent === 'resume' && view?.session_id) {
    if (view.assistant !== assistant) notice = `Seat ${input.seat} is set to ${assistant ? ASSISTANT_LABEL[assistant] : chosen}; its last conversation was ${ASSISTANT_LABEL[view.assistant]}'s and stays resumable there.`;
    else if (view.entry_action === 'restart') { sessionId = view.session_id; action = 'restart'; }
    else if (view.entry_action === 'resume' || view.entry_action === 'not-derived') { resume = view.session_id; action = 'resume'; }
  }
  if (assistant === 'codex' && sessionId) throw new SeatLaunchRefusal('Codex takes no conversation id at launch, so --session-id is for Claude Code.');
  const typed = input.passthrough;
  if (assistant === 'codex' && typed.some(a => a.includes('daemon_auto_start') || a === '--no-daemon' || a.startsWith('--no-daemon=') || a === '--remote' || a.startsWith('--remote=')))
    throw new SeatLaunchRefusal('Deskpost owns --no-daemon and daemon_auto_start; --remote cannot hold a local seat claim.');
  if (!resume && !sessionId && assistant === 'claude' && !typed.some(a => ['--resume', '-r', '--session-id', '--continue', '-c', 'resume'].includes(a) || a.startsWith('--resume=') || a.startsWith('--session-id='))) {
    sessionId = input.mintedId; action = notice ? 'new' : 'minted';
  }
  const stored = assistant ? record?.args[assistant] ?? [] : [];
  const repeatable = assistant === 'codex' ? ['--config', '--enable', '--disable'] : assistant === 'claude' ? ['--plugin-dir', '--plugin-url'] : [];
  const names = optionNames(stored), duplicate = optionNames(typed).find(n => names.includes(n) && !repeatable.includes(n));
  if (duplicate) throw new SeatLaunchRefusal(`${duplicate} occurs in stored flags (${escapedArgv(stored)}) and typed passthrough (${escapedArgv(typed)}); change s<number> or leave it out of the typed arguments.`);
  const conversation = resume ? (assistant === 'codex' ? ['resume', resume] : ['--resume', resume]) : sessionId ? ['--session-id', sessionId] : [];
  const args = [...conversation, ...nameArguments(assistant, input.seat, typed), ...lettersPromptArguments(assistant, input.letters, typed),
    ...(assistant ? addedDirArguments(input.dirs) : []), ...(assistant === 'claude' ? input.inbound : []),
    ...(assistant === 'codex' ? ['--no-daemon'] : []), ...stored, ...typed];
  return { command: chosen, assistant, args, resume, sessionId, action, notice, stored, approval: assistant ? record?.approved[assistant] ?? null : null };
}


/** The exact planner preview used by settings: no record, Desk or generated settings file is written. */
export function seatLaunchPreview(workspace: string, seat: string, recordOverride?: LaunchRecord | null, fallback: Assistant = 'claude', intent: 'new' | 'resume' = 'resume', transcriptRoot?: string, dirsOverride?: string[], mintedId = newConversationId()) {
  const state = path.join(workspace, '.claude');
  const row = readRegistryRows(registryFilePath(state)).find(r => r['seat'] === seat) ?? null;
  const record: LaunchRead = recordOverride === undefined ? readSeatLaunch(state, seat, String(row?.['seat_id'] ?? '')) :
    recordOverride === null ? { state: 'unset', digest: 'absent' } : { state: 'valid', digest: launchDigest(JSON.stringify(recordOverride)), record: recordOverride };
  let dirs: string[] = dirsOverride ?? []; if (dirsOverride === undefined) try { dirs = addedDirsStatus(state, seat).filter(d => d.exists).map(d => d.path); } catch { /* launch names malformed folders separately */ }
  const inbound = readInboundSettings(state, seat);
  const input: LaunchInput = { seat, row, record, intent, fallback, view: seatConversationView(state, seat, { transcriptRoot }), mintedId,
    dirs, inbound: [], letters: pendingLetterPagesForSeat(workspace, seat).length, passthrough: [] };
  // The conversation owner can select the executable when no assistant is saved. Its actual route decides encoding.
  const command = planSeatLaunch(input).command;
  const searchPath = process.env[Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';
  const executable = agentExecutable(command, searchPath).file;
  const commandScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolveOnPath(executable, searchPath) ?? executable);
  input.inbound = inbound.state === 'valid' ? inboundSettingsArguments({ stateDirectory: state, seat, value: inbound.value, commandScript, write: false }) : [];
  return planSeatLaunch(input);
}
export interface LaunchSettingsOptions {
  workspace: string; seat: string; assistant?: string; flags?: string; clearFlags?: string; resetLaunch?: boolean;
  args?: string[]; preflight: boolean; planId: string; transcriptRoot?: string; fallbackAssistant?: Assistant;
}
/** Modes are checked by seat settings before it reads either setting for writing. */
export function launchSettingsResult(options: LaunchSettingsOptions): Record<string, PsJsonValue> {
  const state = path.join(options.workspace, '.claude');
  const resolved = resolveSeatName({ stateDirectory: state, seat: options.seat });
  if (resolved.status !== 'named') throw new SeatLaunchRefusal(resolved.message);
  const seat = resolved.seat!;
  const start = beginSeatMutation(options.workspace, seat);
  const row = readRegistryRows(registryFilePath(state)).find(r => r['seat'] === seat);
  if (!row) throw new SeatLaunchRefusal('There is no live seat named ' + seat + '. Nothing was changed.');
  const seatId = String(row['seat_id'] ?? '');
  const file = seatLaunchPath(state, seat);
  const describe = (read: LaunchRead): Record<string, PsJsonValue> => ({ launch_file: file,
    assistant: read.state === 'valid' ? read.record.assistant : null,
    stored_flags: read.state === 'valid' ? { claude: read.record.args.claude, codex: read.record.args.codex } : { claude: [], codex: [] },
    flags_preview: read.state === 'valid' ? { claude: escapedArgv(read.record.args.claude), codex: escapedArgv(read.record.args.codex) } : { claude: '', codex: '' },
    approvals: read.state === 'valid' ? JSON.parse(JSON.stringify(read.record.approved)) as PsJsonValue : null,
    ...(read.state === 'invalid' || read.state === 'unreadable' ? { launch_record_ignored: read.reason } : {}) });
  const mutation = options.assistant !== undefined || options.flags !== undefined || options.clearFlags !== undefined || options.resetLaunch;
  if (!mutation) return describe(readSeatLaunch(state, seat, seatId));
  if (options.assistant !== undefined && !['claude', 'codex', 'none'].includes(options.assistant)) throw new SeatLaunchRefusal('--assistant takes claude, codex or none.');
  const scope = options.flags ?? options.clearFlags ?? 'all';
  if ((options.flags !== undefined || options.clearFlags !== undefined) && !['claude', 'codex'].includes(scope)) throw new SeatLaunchRefusal('--flags and --clear-flags take claude or codex.');
  if (options.flags !== undefined) validateStoredFlags(scope as Assistant, options.args ?? []);
  const operation = options.resetLaunch ? 'reset' : options.clearFlags !== undefined ? 'clear' : 'set';
  const propose = (read: LaunchRead): LaunchRecord | null => {
    if (read.state === 'unreadable') throw new SeatLaunchRefusal('Cannot read ' + read.reason + '; no plan id was issued.');
    if (options.resetLaunch) return null;
    if (read.state === 'invalid') throw new SeatLaunchRefusal('The launch record is invalid; use --reset-launch. ' + read.reason);
    const record = read.state === 'valid' ? structuredClone(read.record) : emptyLaunchRecord(seatId);
    if (options.assistant !== undefined) record.assistant = options.assistant === 'none' ? null : options.assistant as Assistant;
    else {
      const a = scope as Assistant;
      record.args[a] = options.clearFlags !== undefined ? [] : [...(options.args ?? [])];
      record.approved[a] = record.args[a].length ? { plan_id: '', utc: '', args_sha256: launchDigest(JSON.stringify(record.args[a])) } : null;
    }
    return record;
  };
  const idFor = (read: LaunchRead, proposed: LaunchRecord | null): string => {
    if (read.state === 'unreadable') throw new SeatLaunchRefusal('Cannot read ' + read.reason + '; no plan id was issued.');
    const semantic = proposed ? structuredClone(proposed) as unknown as Record<string, unknown> : null;
    if (semantic && options.assistant === undefined && !options.resetLaunch) {
      const approved = semantic['approved'] as Record<string, Record<string, string> | null>;
      if (approved[scope]) { delete approved[scope]!['plan_id']; delete approved[scope]!['utc']; }
    }
    return 'seat-launch-' + launchDigest(canonicalLaunchJson({ operation, scope, seat, seat_id: seatId,
      ...(seatId ? {} : { legacy_row: row }), current_sha256: read.digest, proposed: semantic }));
  };
  const read = readSeatLaunch(state, seat, seatId), proposed = propose(read);
  const planId = idFor(read, proposed);
  const preview = seatLaunchPreview(options.workspace, seat, proposed, options.fallbackAssistant ?? 'claude', 'resume', options.transcriptRoot);
  const base = { schema: 1, operation: 'Seat launch settings', seat, ...describe(read),
    proposed_assistant: proposed?.assistant ?? null,
    proposed_flags: proposed ? { claude: escapedArgv(proposed.args.claude), codex: escapedArgv(proposed.args.codex) } : null,
    launch_line: escapedArgv([preview.command, ...preview.args]), plan_id: planId, shared_library_write: false };
  if (options.preflight) return { ...base, confirmation_required: true, changed: false };
  if (options.assistant === undefined && !options.planId) throw new SeatLaunchRefusal('Nothing was changed: run --preflight, then apply its exact --plan-id after the reader approves it.');
  const lock = enterSeatRegistryLock(options.workspace, 10);
  try {
    recheckSeatMutation(start);
    const rows = readRegistryRows(registryFilePath(state));
    const live = rows.find(r => r['seat'] === seat);
    if (!live || String(live['seat_id'] ?? '') !== seatId ||
      (!seatId && canonicalLaunchJson(live) !== canonicalLaunchJson(row))) throw new SeatLaunchRefusal('The live seat incarnation changed; nothing was written.');
    const locked = readSeatLaunch(state, seat, seatId), next = propose(locked);
    if (options.assistant === undefined && idFor(locked, next) !== options.planId) throw new SeatLaunchRefusal('That plan_id does not match this operation, seat incarnation and current launch record; rerun --preflight. Nothing was changed.');
    if (next) {
      if (!seatId) {
        // The same UUID format as new seats; existing schema 1 already permits this field.
        next.seat_id = randomUUID().replace(/-/g, '');
        live['seat_id'] = next.seat_id;
        writeSeatRegistry(state, rows);
      }
      if (options.assistant === undefined) {
        const approval = next.approved[scope as Assistant];
        if (approval) { approval.plan_id = options.planId; approval.utc = new Date().toISOString(); }
      }
      writeSeatLaunch(options.workspace, seat, next);
    } else fs.rmSync(file, { force: true });
    const after = readSeatLaunch(state, seat, String(live['seat_id'] ?? ''));
    const planned = seatLaunchPreview(options.workspace, seat, undefined, options.fallbackAssistant ?? 'claude', 'resume', options.transcriptRoot);
    return { ...base, ...describe(after), changed: true, launch_line: escapedArgv([planned.command, ...planned.args]), confirmation_required: false };
  } finally { exitBookLock(lock); }
}
