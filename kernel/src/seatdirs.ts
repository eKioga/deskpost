/**
 * A seat's added folders (1.2.5, ADR-0061): `.claude/seats/<seat>/added-dirs.json`, the folders a seat's agent is
 * started with as `--add-dir`, and nobody else's.
 *
 * WHY A RECORD OF THE SEAT'S OWN. Claude Code loads a folder's `.claude/skills` and `.claude/agents` only from
 * `--add-dir` at launch or `/add-dir` mid-session, and the main menu could pass neither. So a reader typed `/add-dir`,
 * accepted "remember", and Claude Code wrote the folder into the WORKSPACE's `.claude/settings.local.json`, where every
 * seat in the Library then read it (Report 2026-09-29). No hook can intercept that write. The record makes it
 * unnecessary: `seat start` applies it on every launch, the menu's included, and it reaches one seat only.
 *
 * UNGATED, because it is the seat's own launch setting, additive, reversible by `--remove`, and changes nothing until
 * the next launch. It is not in `_registry.json`, the claim, or any plan id; `seat retire` archives it beside the Desk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { readSeatRegistry, readSeatRetirementRecords } from './desk.ts';
import { readSeatActivity } from './seatclaim.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import type { Assistant } from './conversation.ts';

const ADDED_DIRS_SCHEMA = 1;

/** A refusal of this module's: said to the reader as it stands, and nothing was written. */
export class SeatDirsRefusal extends Error {}

function refuse(message: string): never {
  throw new SeatDirsRefusal(message);
}

export function addedDirsPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'added-dirs.json');
}

/**
 * The seat's recorded folders, in the order they were added; empty when it has none. A record that does not parse is
 * refused by name rather than read as empty: an empty answer would launch the seat without folders it was given, and
 * say nothing.
 */
export function readAddedDirs(stateDirectory: string, seat: string): string[] {
  const file = addedDirsPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    refuse(`Seat '${seat}''s added folders record at ${file} could not be read: ${(error as Error).message}. Fix or delete it; nothing was changed.`);
  }
  const dirs = (parsed as { dirs?: unknown } | null)?.dirs;
  if (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== 'string')) {
    refuse(`Seat '${seat}''s added folders record at ${file} has no list of folders under "dirs". Fix or delete it; nothing was changed.`);
  }
  return dirs as string[];
}

/** Each recorded folder, and whether it is there now. */
export function addedDirsStatus(stateDirectory: string, seat: string): { path: string; exists: boolean }[] {
  return readAddedDirs(stateDirectory, seat).map((dir) => ({ path: dir, exists: isDirectory(dir) }));
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The comparison form of a path: case-folded on Windows, and with no trailing separator unless it is a root. */
function comparable(dir: string): string {
  const trimmed = dir.length > path.parse(dir).root.length ? dir.replace(/[\\/]+$/, '') : dir;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Whether `inner` is `outer` or inside it, as whole segments. */
export function isAtOrInside(inner: string, outer: string): boolean {
  const left = comparable(inner);
  const right = comparable(outer);
  if (left === right) return true;
  // A ROOT KEEPS ITS SEPARATOR (`D:\`), so it is not doubled.
  return left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

/**
 * THE FOLDER, VALIDATED FOR ONE SEAT (ruling 3). Every refusal names the path and the reason. Returned as
 * `path.resolve` gives it.
 */
export function validateAddedDir(workspace: string, candidate: string, recorded: string[]): string {
  const typed = candidate.trim();
  if (!typed) refuse('Name the folder to add: deskpost seat dirs <seat> --add <folder>.');
  // THE cmd.exe ROUTE CANNOT PASS THESE UNCHANGED (seat.ts, agentSpawn), so they are refused now rather than at launch.
  if (/["%]/.test(typed)) refuse(`The folder '${typed}' holds " or %, which the launcher cannot pass to an agent unchanged. Nothing was recorded.`);
  if (!path.isAbsolute(typed)) refuse(`The folder '${typed}' is not an absolute path. Name it in full, for example D:\\dev\\my-repo. Nothing was recorded.`);
  const dir = path.resolve(typed);
  if (!fs.existsSync(dir)) refuse(`The folder '${dir}' does not exist. Nothing was recorded.`);
  if (!isDirectory(dir)) refuse(`'${dir}' is a file, not a folder. Nothing was recorded.`);
  if (recorded.some((existing) => comparable(existing) === comparable(dir))) refuse(`The folder '${dir}' is already recorded for this seat. Nothing was changed.`);
  if (comparable(dir) === comparable(workspace)) refuse(`'${dir}' is this Library itself, which every seat already works in. Nothing was recorded.`);
  if (isAtOrInside(dir, workspace)) {
    refuse(`'${dir}' is inside this Library, which every seat already works in; recording it would open a route around the Shelf and collection guards. Nothing was recorded.`);
  }
  if (isAtOrInside(workspace, dir)) refuse(`'${dir}' contains this Library, so it would hand the seat the whole Library again and everything around it. Nothing was recorded.`);
  if (fs.existsSync(path.join(dir, '.library', 'workspace.json'))) refuse(`'${dir}' is a Library of its own (it holds .library/workspace.json). Work in it from its own seats. Nothing was recorded.`);
  return dir;
}

/** `--add-dir <folder>` once per folder, in the recorded order. */
export function addedDirArguments(dirs: string[]): string[] {
  return dirs.flatMap((dir) => ['--add-dir', dir]);
}

function quoted(argument: string): string {
  return /[\s"]/.test(argument) ? `"${argument}"` : argument;
}

/**
 * THE LAUNCH LINE THE RECORD WOULD PRODUCE, for a reader to check before it is saved: the seat's recorded conversation
 * resumed in the assistant that owns it, or a new Claude Code conversation when there is none. The folders come after
 * the conversation arguments, as `seat start` puts them.
 */
/**
 * THE SEAT'S NAME AT LAUNCH (PLAN-one-step-upgrade.md small fix 11, Step 0 of "Seats that work as a team"): Claude Code
 * names the session after its seat from the first prompt (`--name`, `claude --help` 2.1.290), new or resumed (S92's
 * spike: `--resume <id> --name <seat>` keeps the conversation and records its title). Codex has no such flag, and a
 * reader's own `--name` or `-n` in the passthrough is theirs.
 */
export function nameArguments(assistant: Assistant | null, seat: string, passthrough: string[]): string[] {
  if (assistant !== 'claude') return [];
  if (passthrough.some((arg) => arg === '--name' || arg === '-n' || arg.startsWith('--name='))) return [];
  return ['--name', seat];
}

export function launchLine(stateDirectory: string, seat: string, dirs: string[]): string {
  const activity = readSeatActivity(stateDirectory, seat);
  const session = typeof activity?.['session_id'] === 'string' ? (activity['session_id'] as string) : '';
  const assistant: Assistant = activity?.['assistant'] === 'codex' ? 'codex' : 'claude';
  const conversation = session ? (assistant === 'codex' ? ['resume', session] : ['--resume', session]) : [];
  return [assistant, ...conversation, ...nameArguments(assistant, seat, []), ...addedDirArguments(dirs)].map(quoted).join(' ');
}

/** The seat, named and live. A retired seat and an unknown one are refused, each by name. */
function liveSeat(workspace: string, stateDirectory: string, name: string): string {
  if (!name.trim()) refuse('Name the seat: deskpost seat dirs <seat> [--list | --add <folder> | --remove <folder>].');
  const resolved = resolveSeatName({ seat: name, stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;
  const registry = readSeatRegistry(stateDirectory);
  if (registry.some((row) => row.seat === seat)) return seat;
  if (readSeatRetirementRecords(workspace).records.some((record) => record.seat === seat)) {
    refuse(`Seat '${seat}' is retired, so it has no launches to add folders to. Nothing was changed.`);
  }
  const names = registry.map((row) => row.seat);
  refuse(`There is no seat named '${seat}'. ${names.length ? `The seats are: ${names.join(', ')}.` : 'This Library has no seats yet.'} Nothing was changed.`);
}

export interface SeatDirsChange {
  seat: string;
  dirs: string[];
  changed: boolean;
  added: string | null;
  removed: string | null;
}

/**
 * WHAT ONE CHANGE WOULD MAKE THE RECORD, validated and not written: the menu shows its launch line before it saves, and
 * `changeSeatDirs` commits the same plan under the lock. No change is a listing.
 */
export function planSeatDirs(options: { workspace: string; seat: string; add?: string; remove?: string }): SeatDirsChange {
  const stateDirectory = path.join(options.workspace, '.claude');
  const seat = liveSeat(options.workspace, stateDirectory, options.seat);
  const recorded = readAddedDirs(stateDirectory, seat);
  if (options.add !== undefined) {
    const added = validateAddedDir(options.workspace, options.add, recorded);
    return { seat, dirs: [...recorded, added], changed: true, added, removed: null };
  }
  if (options.remove !== undefined) {
    const typed = options.remove.trim();
    const target = comparable(typed && path.isAbsolute(typed) ? path.resolve(typed) : typed);
    const match = recorded.find((dir) => comparable(dir) === target);
    if (match === undefined) {
      refuse(`'${typed}' is not recorded for seat '${seat}'. ${recorded.length ? `Its folders are: ${recorded.join(', ')}.` : 'It has none.'} Nothing was changed.`);
    }
    return { seat, dirs: recorded.filter((dir) => dir !== match), changed: true, added: null, removed: match };
  }
  return { seat, dirs: recorded, changed: false, added: null, removed: null };
}

/**
 * List, add or remove one folder: the one implementation `seat dirs` and the menu's `f<N>` both call. Planned again and
 * written atomically under the seat registry's lock, so two additions at once both land. Works while the seat is held:
 * the change applies from its next launch.
 */
export function changeSeatDirs(options: { workspace: string; seat: string; add?: string; remove?: string }): SeatDirsChange {
  if (options.add === undefined && options.remove === undefined) return planSeatDirs(options);
  const lock = enterSeatRegistryLock(options.workspace, 10);
  try {
    const change = planSeatDirs(options);
    writeAtomicText(addedDirsPath(path.join(options.workspace, '.claude'), change.seat), psConvertToJson({ schema: ADDED_DIRS_SCHEMA, dirs: change.dirs }) + '\n');
    return change;
  } finally {
    exitBookLock(lock);
  }
}

/** What a change says, for `seat dirs` and the menu alike. */
export function seatDirsSentence(change: SeatDirsChange): string {
  if (change.added) {
    return (
      `${path.join(change.added, '.claude', 'skills')} and .claude${path.sep}agents load in seat '${change.seat}' only, from its next launch. ` +
      'In Codex the folder is a writable sandbox root.'
    );
  }
  if (change.removed) return `${change.removed} is no longer added to seat '${change.seat}', from its next launch.`;
  if (!change.dirs.length) return `Seat '${change.seat}' has no added folders.`;
  return `Seat '${change.seat}' is started with ${change.dirs.length === 1 ? 'one added folder' : `${change.dirs.length} added folders`}.`;
}

/** `library seat dirs <seat> [--list] | --add <folder> | --remove <folder>`. */
export function seatDirsResult(workspace: string, seat: string, options: { add?: string; remove?: string }): Record<string, PsJsonValue> {
  if (options.add !== undefined && options.remove !== undefined) refuse('--add and --remove are two changes; make one at a time. Nothing was changed.');
  const change = changeSeatDirs({ workspace, seat, ...options });
  const stateDirectory = path.join(workspace, '.claude');
  return {
    schema: 1,
    operation: 'Seat added folders',
    seat: change.seat,
    dirs: change.dirs,
    changed: change.changed,
    ...(change.added ? { added: change.added } : {}),
    ...(change.removed ? { removed: change.removed } : {}),
    launch_line: launchLine(stateDirectory, change.seat, change.dirs),
    applies: change.changed ? 'from the next launch' : 'unchanged',
    note: seatDirsSentence(change),
    shared_library_write: false,
  };
}
