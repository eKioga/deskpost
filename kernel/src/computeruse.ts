/** Seat permission for Eric's mouse and keyboard, independent of the Shelf guards. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { requireSeat, resolveSeatName, SEAT_SLUG_PATTERN, deskStateDirectory } from './seatdesk.ts';
import { readSeatRegistry } from './desk.ts';
import { beginSeatMutation, recheckSeatMutation } from './seatpaths.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { resolveWorkspace } from './workspace.ts';
import { parseArguments } from './argv.ts';
import { tableFor } from './verbs.ts';
import type { PsJsonValue } from './psjson.ts';

function settingPath(stateDirectory: string, seat: string): string {
  if (!SEAT_SLUG_PATTERN.test(seat)) throw Error('A computer-use setting needs a valid seat name.');
  return path.join(deskStateDirectory(stateDirectory, seat), 'computer-use.json');
}
export function readComputerUseSetting(stateDirectory: string, seat: string): 'on' | 'off' {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(settingPath(stateDirectory, seat), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 &&
      'computer_use' in value && (value.computer_use === 'on' || value.computer_use === 'off')) return value.computer_use;
    throw Error('expected only computer_use: on or off');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write('Computer-use setting ignored: ' + String((error as Error).message).replace(/[\x00-\x1f\x7f-\x9f]+|\s+/g, ' ') + '; using off.\n');
    return 'off';
  }
}
export function writeComputerUseSetting(workspace: string, name: string, value: string): Record<string, PsJsonValue> {
  if (!name.trim()) throw Error('Name the seat: deskpost seat settings <seat> --computer-use on|off|unset.');
  if (!['on', 'off', 'unset'].includes(value)) throw Error('--computer-use takes on, off or unset. Nothing was changed.');
  const stateDirectory = path.join(workspace, '.claude'), seat = requireSeat({ stateDirectory, seat: name });
  const started = beginSeatMutation(workspace, seat), lock = enterSeatRegistryLock(workspace, 10);
  try {
    recheckSeatMutation(started);
    if (!readSeatRegistry(stateDirectory).some(row => row.seat === seat)) throw Error(`There is no live seat named '${seat}'. Nothing was changed.`);
    const file = settingPath(stateDirectory, seat);
    if (value === 'unset') fs.rmSync(file, { force: true });
    else writeAtomicText(file, JSON.stringify({ computer_use: value }) + '\n');
    return { schema: 1, operation: 'Seat computer-use setting', seat, file, computer_use: value === 'unset' ? 'off (default)' : value, shared_library_write: false };
  } finally { exitBookLock(lock); }
}

interface ComputerUseOptions {
  workspace?: string | undefined;
  stateDirectory?: string | undefined;
  seat?: string | undefined;
  environmentSeat?: string | undefined;
}
const reason = "This seat may not drive Eric's mouse or keyboard. Find a command-line route or stop and tell Eric. (Its computer-use setting is off; only Eric turns it on, in his own terminal, with deskpost seat settings <seat> --computer-use on.)";
const denyDocument = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });

export function computerUseGuard(stdinText: string, options: ComputerUseOptions): string {
  try {
    const call: unknown = JSON.parse(stdinText.replace(/^\uFEFF/, ''));
    if (!call || typeof call !== 'object' || !('tool_name' in call) || typeof call.tool_name !== 'string' || !call.tool_name.trim())
      return denyDocument('Virtual Desk failed closed: a computer-use payload needs tool_name.');
    const selected = options.workspace || (options.stateDirectory ? path.dirname(options.stateDirectory) : '');
    const resolved = resolveWorkspace({ explicit: selected });
    if (resolved.kind === 'conflict') throw Error(resolved.reason ?? 'Workspace selection conflicts.');
    const stateDirectory = options.stateDirectory ?? (resolved.workspace ? path.join(resolved.workspace, '.claude') : '');
    const seat = resolveSeatName({ seat: options.seat, stateDirectory, environmentSeat: options.environmentSeat });
    const command = ['Bash', 'PowerShell', 'exec'].includes(call.tool_name) && 'tool_input' in call && call.tool_input && typeof call.tool_input === 'object' &&
      'command' in call.tool_input && typeof call.tool_input.command === 'string' ? call.tool_input.command.replace(/['"\\\x60]/g, '') : '';
    // deskpost-lead's c100 review: judge every whole flag, including variable values and array items.
    // Only an explicit off or unset immediately after its separator permits the occurrence.
    if (/computer-use\.json/i.test(command) || [...command.matchAll(/--computer-use/gi)].some(match =>
      !/^(?:[=:]|\s+)(?:off|unset)(?=[\s;&|)]|$)/.test(command.slice(match.index! + match[0].length))))
      return denyDocument("Only Eric turns computer use on, in his own terminal: deskpost seat settings <seat> --computer-use on. A seat may turn it off (off or unset).");
    if (stateDirectory && seat.seat && readComputerUseSetting(stateDirectory, seat.seat) === 'on') return '';
    if (/^mcp__computer-use__|^mcp__remote-devices__computer/.test(call.tool_name)) return denyDocument(reason);
    if (/(?:^|[^\w.-])orca(?:\.exe|\.cmd)?\s+(?:-\S+\s+)*computer\b/i.test(command) ||
      (/orca/i.test(command) && /(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|%[A-Za-z_]\w*%)\s+computer\b/i.test(command))) return denyDocument(reason);
    return '';
  } catch (error) { return denyDocument(`Virtual Desk failed closed: ${(error as Error).message ?? String(error)}`); }
}

export function runComputerUseHook(argv: string[], stdinText: string): string {
  try {
    const parsed = parseArguments(argv, tableFor('hook', 'computer-use'));
    return computerUseGuard(stdinText, { workspace: parsed.options.get('workspace'), seat: parsed.options.get('seat'), stateDirectory: parsed.options.get('state-directory') });
  } catch (error) { return denyDocument(`Virtual Desk failed closed: ${(error as Error).message ?? String(error)}`); }
}
