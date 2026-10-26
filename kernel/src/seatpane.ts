/** Cosmetic pane preference, separate from the inbound policy. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { requireSeat, SEAT_SLUG_PATTERN, deskStateDirectory } from './seatdesk.ts';
import { readSeatRegistry } from './desk.ts';
import { beginSeatMutation, recheckSeatMutation } from './seatpaths.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import type { PsJsonValue } from './psjson.ts';

export type PaneSetting = 'on' | 'off' | null;
function panePath(stateDirectory: string, seat: string): string {
  if (!SEAT_SLUG_PATTERN.test(seat)) throw Error('A pane setting needs a valid seat name.');
  return path.join(deskStateDirectory(stateDirectory, seat), 'pane.json');
}
export function readPaneSetting(stateDirectory: string, seat: string): PaneSetting {
  const file = panePath(stateDirectory, seat);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && Object.keys(value)[0] === 'pane' && 'pane' in value &&
      (value.pane === 'on' || value.pane === 'off')) return value.pane;
    throw Error('expected only pane: on or off');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write('Desk pane setting ignored: ' + String((error as Error).message).replace(/[\x00-\x1f\x7f-\x9f]+|\s+/g, ' ') + '; using the assistant default.\n');
    return null;
  }
}
export function writePaneSetting(workspace: string, name: string, value: string): Record<string, PsJsonValue> {
  if (!name.trim()) throw Error('Name the seat: deskpost seat settings <seat> --pane on|off|unset.');
  if (!['on', 'off', 'unset'].includes(value)) throw Error('--pane takes on, off or unset. Nothing was changed.');
  const stateDirectory = path.join(workspace, '.claude'), seat = requireSeat({ stateDirectory, seat: name });
  const started = beginSeatMutation(workspace, seat), lock = enterSeatRegistryLock(workspace, 10);
  try {
    recheckSeatMutation(started);
    if (!readSeatRegistry(stateDirectory).some(row => row.seat === seat)) throw Error(`There is no live seat named '${seat}'. Nothing was changed.`);
    const file = panePath(stateDirectory, seat);
    if (value === 'unset') fs.rmSync(file, { force: true });
    else writeAtomicText(file, JSON.stringify({ pane: value }) + '\n');
    return { schema: 1, operation: 'Seat pane setting', seat, file, pane: value === 'unset' ? 'default (on for Codex, off for Claude)' : value, shared_library_write: false };
  } finally { exitBookLock(lock); }
}

/** Decide from a captured terminal list; no process, filesystem or guessed tab identity. */
export function paneDecision(assistant: string | null, setting: PaneSetting, handle: string, available: boolean, terminals: unknown, seat: string): 'off' | 'manual' | 'list' | 'existing' | 'split' {
  if (setting === 'off' || assistant !== 'codex' && !(assistant === 'claude' && setting === 'on')) return 'off';
  if (!handle.trim() || !available) return 'manual';
  if (terminals === undefined) return 'list';
  if (!Array.isArray(terminals)) throw Error('orca terminal list returned no terminal array');
  const rows = terminals.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  const current = rows.find(row => row['handle'] === handle);
  if (!current || typeof current['tabId'] !== 'string' || !current['tabId'] || typeof current['worktreeId'] !== 'string' || !current['worktreeId']) throw Error('orca terminal list did not identify this terminal and its tab');
  return rows.some(row => row['tabId'] === current['tabId'] && row['worktreeId'] === current['worktreeId'] && row['title'] === `Desk: ${seat}`) ? 'existing' : 'split';
}
