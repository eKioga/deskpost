/**
 * Per-Book locking, and the one registry lock every Desk write and cross-seat scan serialises on.
 *
 * The PowerShell originals are `tools/BookWriteGuard.ps1` (the Book lock) and `tools/LibrarySeat.ps1`
 * (the registry lock, which is a Book lock under a reserved name). Three rules carry the weight, and
 * each of them is a defect this program already paid for:
 *
 *   THE LOCK IS THE BOOK'S, NOT THE HELPER'S, AND ITS NAME IS NORMALISED. `shelf/demo`,
 *   `shelf\demo` and `shelf/demo/` name one Book; a writer spelling it differently from the next
 *   writer takes a lock nobody else contends for, which is exclusion that looks present and is not.
 *
 *   THE ORDER IS FIXED: registry, then book. Both are the same primitive, so a helper that took
 *   them the other way round would deadlock against one that did not.
 *
 *   A LEDGER SAYS WHICH LOCKS THIS PROCESS HOLDS. The lock file cannot answer it -- it is opened
 *   exclusively, so not even the holder can read its own `pid=` line back -- and a cross-seat scan
 *   that merely DOCUMENTED needing the lock is a contract asserted in prose, which is what
 *   BookWriteGuard found wrong in four helpers at once. Here it is checked.
 *
 * `wx` IS THE `CreateNew` OF THIS RUNTIME: exactly one caller wins the race and the rest throw.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDirectory } from './fsx.ts';
import { agentProcessIdentity, testSeatAgentAlive, UNREADABLE_IDENTITY } from './procstart.ts';
import { nativeProcessCalls } from './win32proc.ts';

/** Matches `$script:StaleLockMinutes`. A lock older than this was left by a crashed process. */
const STALE_LOCK_MINUTES = 30;

export const SEAT_REGISTRY_LOCK_ROOT = 'registry/desk';

export interface BookLock {
  path: string;
  bookRoot: string;
  lockName: string;
  ledgerKey: string;
  /** The text this holder wrote; release removes the file only while it still holds exactly this (kickoffs/s164 row 4). */
  record?: string;
}

/** The locks this process holds right now, keyed the way the lock file is named. */
const heldLocks = new Map<string, number>();

export function bookLockDirectory(workspace: string): string {
  const directory = path.join(workspace, 'internal', 'book-locks');
  ensureDirectory(directory);
  return directory;
}

export function toBookLockName(bookRoot: string): string {
  let normalised = bookRoot.replace(/\\/g, '/').trim();
  normalised = normalised.replace(/\/+/g, '/').replace(/\/+$/, '');
  if (!normalised) throw new Error('A Book lock needs a Book root.');
  return normalised.replace(/\//g, '-');
}

function ledgerKeyFor(workspace: string, bookRoot: string): string {
  return path.join(bookLockDirectory(workspace), `${toBookLockName(bookRoot)}.lock`).toLowerCase();
}

export function isBookLockHeld(workspace: string, bookRoot: string): boolean {
  return (heldLocks.get(ledgerKeyFor(workspace, bookRoot)) ?? 0) > 0;
}

/**
 * THE ASSERTION, NOT A COMMENT. A scan over every seat's Desk is only true while the set of seats
 * and their Desks cannot change, and a caller that forgot the lock gets a refusal rather than a
 * plausible answer computed at the wrong moment.
 */
/** `Test-SeatRegistryLockHeld`: whether THIS process holds the registry lock, from the in-process ledger. */
export function isSeatRegistryLockHeld(workspace: string): boolean {
  return isBookLockHeld(workspace, SEAT_REGISTRY_LOCK_ROOT);
}

export function assertSeatRegistryLockHeld(workspace: string, operation: string): void {
  if (isBookLockHeld(workspace, SEAT_REGISTRY_LOCK_ROOT)) return;
  throw new Error(
    `${operation} needs the seat registry lock, and this process does not hold it. ` +
      'Take it with the registry lock before reading or writing any seat Desk.',
  );
}

/** A short spin rather than a wait primitive: a contended lock clears in milliseconds or is stuck. */
function spin(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * The collection-wide export lock. `tools/Export-CollectionToVault.ps1` captures the whole collection
 * and must not have a write land in the middle of that capture, so it takes a lock that is not a
 * Book's -- it excludes every Book at once -- and it lives in the same directory, by the same race,
 * so there is one lock namespace rather than two that cannot see each other.
 *
 * THE MUTUAL EXCLUSION IS SYMMETRIC AND NEITHER SIDE RETRIES. The exporter creates its lock first
 * and then looks for any other; a writer looks for the export lock BEFORE creating its own.
 * Interleaved, the worst case is that both back off -- a refusal rather than a deadlock, which is
 * why the exporter refuses instead of waiting. Waiting is the shape that turns two careful
 * operations into a livelock.
 *
 * CHECKED HERE, at the one door every Shelf writer, Hub edit and manifest transaction passes
 * through, rather than in thirty helpers.
 */
export function assertNoCollectionExport(workspace: string, operation = 'this write'): void {
  const lockPath = path.join(workspace, 'internal', 'book-locks', 'collection-export.lock');
  if (!fs.existsSync(lockPath)) return;
  let detail = '';
  try {
    detail = fs
      .readFileSync(lockPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .join('; ');
  } catch {
    /* an unreadable lock is still a lock; the refusal stands without its detail */
  }
  throw new Error(
    `A collection-wide export holds this workspace, so ${operation} is refused: the export is ` +
      'copying the whole collection and a write landing inside that capture would be mirrored ' +
      `half-done. Wait for tools/Export-CollectionToVault.ps1 to finish. ${lockPath} (${detail}). ` +
      "If no export is running, that file is a crashed run's leftover and removing it is safe.",
  );
}

export function enterBookLock(workspace: string, bookRoot: string, timeoutSeconds = 20): BookLock {
  const lockName = toBookLockName(bookRoot);
  // BEFORE the lock file is created, so a writer never holds a Book while an export is capturing it.
  // The export's own lock is taken by the exporter and never through here, so this cannot refuse it.
  assertNoCollectionExport(workspace, `writing to ${bookRoot}`);
  const lockPath = path.join(bookLockDirectory(workspace), `${lockName}.lock`);
  const deadline = Date.now() + timeoutSeconds * 1000;

  const judgedAlive = new Map<string, number>();
  while (true) {
    let handle: number;
    try {
      handle = fs.openSync(lockPath, 'wx');
    } catch {
      // Someone holds it, or a crashed process left it behind. Only the latter may be taken.
      if (takeStaleLock(lockPath, judgedAlive)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Another operation holds the lock for ${bookRoot}. Wait for it to finish, or investigate ${lockPath}.`,
        );
      }
      spin(250);
      continue;
    }
    const start = cheapOwnStart();
    const record = `pid=${process.pid}\n${start ? `start=${start}\n` : ''}acquired=${new Date().toISOString()}\nbook=${bookRoot}\n`;
    try {
      fs.writeSync(handle, record);
    } finally {
      fs.closeSync(handle);
    }
    // Recorded AFTER the file exists, so a failed acquisition never reads as held.
    const ledgerKey = lockPath.toLowerCase();
    heldLocks.set(ledgerKey, (heldLocks.get(ledgerKey) ?? 0) + 1);
    return { path: lockPath, bookRoot, lockName, ledgerKey, record };
  }
}

/**
 * THIS PROCESS'S START TIME, ONLY WHERE IT IS CHEAP (kickoffs/s164 row 4): the compiled kernel reads it natively, Linux
 * from /proc, macOS from one `ps`. Under Node on Windows it costs a PowerShell start (measured about a second on a busy
 * machine), so a source run there records none and its lock is judged by age, as before.
 */
function cheapOwnStart(): string | null {
  if (process.platform === 'win32' && nativeProcessCalls() === null) return null;
  const identity = agentProcessIdentity(process.pid);
  return identity && identity !== UNREADABLE_IDENTITY ? identity : null;
}

function recordField(text: string, name: string): string {
  return new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
}

/** A test seam: called after a lock is judged stale and before it is taken (section 492 pauses two recoverers here). */
let afterJudgedStale: ((lockPath: string) => void) | undefined;
export function setAfterJudgedStale(hook: ((lockPath: string) => void) | undefined): void {
  afterJudgedStale = hook;
}

/**
 * A LOCK IS STALE ONLY WHEN ITS OWNER IS DEAD (backlog "Code audit 2", finding 1). A file naming its owner's pid and
 * start time is stale when that process is gone; a file with no readable owner (a PowerShell writer's, an older
 * kernel's, one caught between its create and its write) is stale by age, as before. A live owner's lock is never
 * taken, however old.
 *
 * TAKEN BY A STEP THAT CANNOT REMOVE A FRESH FILE. The stale file is renamed to a name only this taker uses, read again,
 * and deleted only when it is still the one judged (the same text and time); a fresh file moved by mistake goes back
 * where it was. Two recoverers that both judged one stale file never both delete: the second moves nothing it judged.
 * Answers true when a stale lock was removed, so the caller tries the create again.
 */
function takeStaleLock(lockPath: string, judgedAlive: Map<string, number>): boolean {
  let text: string;
  let mtimeMs: number;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return false; // gone between the failed create and the read: the next create decides
  }
  const pid = Number(recordField(text, 'pid'));
  const start = recordField(text, 'start');
  if (Number.isInteger(pid) && pid > 0 && start) {
    // A live owner is asked again at most once a second while this caller waits.
    const asked = judgedAlive.get(text);
    if (asked !== undefined && Date.now() - asked < 1000) return false;
    if (testSeatAgentAlive(pid, start, { fresh: true })) {
      judgedAlive.set(text, Date.now());
      return false;
    }
  } else if ((Date.now() - mtimeMs) / 60000 <= STALE_LOCK_MINUTES) {
    return false;
  }
  afterJudgedStale?.(lockPath);
  const moved = `${lockPath}.taken-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockPath, moved);
  } catch {
    return false; // another recoverer moved it first
  }
  let same = false;
  try {
    same = fs.readFileSync(moved, 'utf8') === text && fs.statSync(moved).mtimeMs === mtimeMs;
  } catch {
    /* unreadable after the move: treated as not the one judged */
  }
  if (same) {
    try { fs.unlinkSync(moved); } catch { /* a leftover under a taken- name holds nothing */ }
    return true;
  }
  // A fresh lock was moved: put it back without overwriting one made meanwhile.
  try {
    fs.linkSync(moved, lockPath);
  } catch {
    /* a newer lock now stands at the path; the moved one's holder still releases by its own record */
  }
  try { fs.unlinkSync(moved); } catch { /* best effort */ }
  return false;
}

/**
 * NEVER THROWS, deliberately: almost every call site is a `finally`, and a throw from there replaces
 * the exception in flight and destroys the diagnosis the caller was about to report.
 */
export function exitBookLock(lock: BookLock | null): void {
  if (!lock) return;
  // Deregistered FIRST and unconditionally. A ledger that outlived a released lock would let a
  // later unlocked call pass the assertion, which is worse than a surviving lock file -- that one
  // is stealable once it goes stale.
  const remaining = (heldLocks.get(lock.ledgerKey) ?? 0) - 1;
  if (remaining > 0) heldLocks.set(lock.ledgerKey, remaining);
  else heldLocks.delete(lock.ledgerKey);
  // ONLY ITS OWN FILE (kickoffs/s164 row 4): a successor's lock at the same path is left where it is.
  if (lock.record !== undefined) {
    try {
      if (fs.readFileSync(lock.path, 'utf8') !== lock.record) return;
    } catch {
      return;
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.unlinkSync(lock.path);
      return;
    } catch {
      if (!fs.existsSync(lock.path)) return;
    }
  }
}

export function enterSeatRegistryLock(workspace: string, timeoutSeconds = 20): BookLock {
  return enterBookLock(workspace, SEAT_REGISTRY_LOCK_ROOT, timeoutSeconds);
}

/** Run `body` holding these Book roots, in a fixed order, and release them in reverse. */
export function withBookLocks<T>(
  workspace: string,
  bookRoots: string[],
  timeoutSeconds: number,
  body: (locks: BookLock[]) => T,
): T {
  const ordered = [...new Set(bookRoots)].sort();
  const locks: BookLock[] = [];
  try {
    for (const root of ordered) locks.push(enterBookLock(workspace, root, timeoutSeconds));
    return body(locks);
  } finally {
    for (const lock of [...locks].reverse()) exitBookLock(lock);
  }
}
