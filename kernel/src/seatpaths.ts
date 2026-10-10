/**
 * ONE SEAT-PATH RESOLVER, AND ONE PER-SEAT NOTEBOOK LOCK (PLAN-seat-identity.md section 2, "First, in session 2, two
 * prerequisites"; kickoffs/s109 ruling 7).
 *
 * Every verb that turns a seat name into a path asks here: the seat's state folder under `.claude/seats/`, its Notebook
 * root, its inbound settings file and its added folders. The resolver also reads the rename journals in
 * `internal/seat-rename-journals/` BY BOTH THE OLD AND THE NEW NAME, so a rename in progress is a barrier any caller
 * can see, whichever name it was given.
 *
 * A MUTATION CHECKS AGAIN INSIDE ITS CRITICAL SECTION. `beginSeatMutation` notes what the seat was when the verb began;
 * `recheckSeatMutation`, called after the verb has taken its lock, refuses if a rename barrier now stands at that seat
 * or the name now belongs to another incarnation (or to none). With no journal and no rename, both are pass-throughs:
 * nothing a reader sees changes until `seat rename` exists.
 *
 * THE NOTEBOOK LOCK is the seat's: every Notebook writer takes it around its final check and write, after the
 * registry lock and before any topic lock or the render lock. So the order is registry, Notebook, topic, render; a
 * rename takes the registry lock and then this one, and a writer already holding it finishes first.
 *
 * Low in the import graph on purpose: it reads files with `fs` and nothing of the kernel's but the lock primitives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { enterBookLock, isBookLockHeld, type BookLock } from './locks.ts';

/** Where a rename in progress keeps its journal, one file per seat id. */
export function seatRenameJournalDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'seat-rename-journals');
}

/** What the resolver needs of a rename journal: whose it is, the two names, and how far it got. */
export interface SeatRenameBarrier {
  seat_id: string;
  old: string;
  new: string;
  state: string;
  file: string;
}

/** The workspace a `.claude` state directory belongs to. */
function workspaceOf(stateDirectory: string): string {
  return path.dirname(path.resolve(stateDirectory));
}

/**
 * The unfinished rename journals, each read once. An unreadable journal file is a barrier for no seat, but the rename
 * verb names it: this reader must never stop every seat in the Library over one bad file.
 */
export function seatRenameJournals(workspace: string): SeatRenameBarrier[] {
  const directory = seatRenameJournalDirectory(workspace);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
  const found: SeatRenameBarrier[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      if (typeof parsed['old'] !== 'string' || typeof parsed['new'] !== 'string') continue;
      found.push({ seat_id: name.slice(0, -5), old: parsed['old'], new: parsed['new'], state: String(parsed['state'] ?? ''), file: path.join(directory, name) });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * The rename in progress at a seat, found by its old name or its new one; null when there is none. Only a journal
 * before its commit point is a barrier: once `committed-maps-pending`, the seat is renamed and only maps are left.
 */
export function seatRenameBarrier(workspace: string, seat: string): SeatRenameBarrier | null {
  return seatRenameJournals(workspace).find((journal) => (journal.old === seat || journal.new === seat) && journal.state === 'in-progress') ?? null;
}

/** The refusal every verb gives while a rename stands at the seat it names. */
export function seatRenameBarrierMessage(seat: string): string {
  return `Seat '${seat}' is being renamed; run deskpost seat rename --resume ${seat} or --rollback ${seat}.`;
}

export class SeatRenameBarrierRefusal extends Error {}

/** Refuses while a rename stands at this seat, by either name. */
export function assertNoSeatRename(workspace: string, seat: string): void {
  if (seatRenameBarrier(workspace, seat) !== null) throw new SeatRenameBarrierRefusal(seatRenameBarrierMessage(seat));
}

export interface SeatPaths {
  seat: string;
  /** `.claude/seats/<seat>`. */
  stateDirectory: string;
  /** `notebook/<seat>`, forward slashes. */
  notebookRelative: string;
  notebookRoot: string;
  /** The inbound settings file (`settings.json`) and the added folders record (`added-dirs.json`). */
  inboundSettings: string;
  addedDirs: string;
  /** The rename in progress at this seat, by either name, or null. */
  rename: SeatRenameBarrier | null;
}

/**
 * THE ONE RESOLVER'S PATHS, without the journals: what every hot path (each Desk read, each launch) asks. Pure, so it
 * costs nothing; `seatPaths` adds the rename in progress.
 */
export function seatFilePaths(stateDirectory: string, seat: string): Omit<SeatPaths, 'rename'> {
  const workspace = workspaceOf(stateDirectory);
  const folder = path.join(stateDirectory, 'seats', seat);
  return {
    seat,
    stateDirectory: folder,
    notebookRelative: seatNotebookPath(seat),
    notebookRoot: path.join(workspace, 'notebook', seat),
    inboundSettings: path.join(folder, 'settings.json'),
    addedDirs: path.join(folder, 'added-dirs.json'),
  };
}

/** THE ONE RESOLVER: a seat name's paths, and the rename in progress at it by either name. */
export function seatPaths(stateDirectory: string, seat: string): SeatPaths {
  return { ...seatFilePaths(stateDirectory, seat), rename: seatRenameBarrier(workspaceOf(stateDirectory), seat) };
}

/** The seat's state folder alone. */
export function seatStatePath(stateDirectory: string, seat: string): string {
  return seatFilePaths(stateDirectory, seat).stateDirectory;
}

/** A seat's Notebook root, workspace-relative: `notebook/<seat>`. */
export function seatNotebookPath(seat: string): string {
  return `notebook/${seat}`;
}

/** What a seat was when a mutation began: its name and the registry's id for it ('' for none or unreadable). */
export interface SeatMutationStart {
  workspace: string;
  seat: string;
  seatId: string;
}

function registryIdOf(workspace: string, seat: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspace, '.claude', 'seats', '_registry.json'), 'utf8').replace(/^﻿/, '')) as { seats?: unknown };
    const rows = Array.isArray(parsed.seats) ? (parsed.seats as Record<string, unknown>[]) : [];
    const row = rows.find((candidate) => candidate['seat'] === seat);
    return row ? String(row['seat_id'] ?? '') : '';
  } catch {
    return '';
  }
}

/** Notes the seat as it stands, refusing at once if a rename stands at it. */
export function beginSeatMutation(workspace: string, seat: string): SeatMutationStart {
  assertNoSeatRename(workspace, seat);
  return { workspace, seat, seatId: registryIdOf(workspace, seat) };
}

/**
 * INSIDE THE CRITICAL SECTION, after the lock: refuses if a rename barrier now stands at the seat, or the name now
 * belongs to another incarnation than when the verb began. A seat that had no id when it began is judged by the
 * barrier alone, as a pre-identity row always was.
 */
export function recheckSeatMutation(start: SeatMutationStart): void {
  assertNoSeatRename(start.workspace, start.seat);
  if (!start.seatId) return;
  const now = registryIdOf(start.workspace, start.seat);
  if (now !== start.seatId) {
    throw new SeatRenameBarrierRefusal(
      `Seat '${start.seat}' changed while this ran: the name now belongs to ${now ? 'another seat' : 'no seat'}. Nothing was written; run it again under the seat's current name.`,
    );
  }
}

/** The per-seat Notebook lock's root: one per seat root, and one for a legacy shared tree. */
export function seatNotebookLockRoot(seat: string | null): string {
  return seat ? `notebook-seat/${seat}` : 'notebook-seat';
}

/**
 * Takes the seat's Notebook lock unless this process already holds it (a writer that calls another, as reset calls
 * the render). Returns the lock to release, or null when it was already held.
 */
export function enterSeatNotebookLock(workspace: string, seat: string | null, timeoutSeconds = 20): BookLock | null {
  const root = seatNotebookLockRoot(seat);
  return isBookLockHeld(workspace, root) ? null : enterBookLock(workspace, root, timeoutSeconds);
}
