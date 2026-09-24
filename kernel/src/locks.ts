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
import { ensureDirectory } from './fsx.ts';

/** Matches `$script:StaleLockMinutes`. A lock older than this was left by a crashed process. */
const STALE_LOCK_MINUTES = 30;

export const SEAT_REGISTRY_LOCK_ROOT = 'registry/desk';

export interface BookLock {
  path: string;
  bookRoot: string;
  lockName: string;
  ledgerKey: string;
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

  while (true) {
    let handle: number;
    try {
      handle = fs.openSync(lockPath, 'wx');
    } catch {
      // Someone holds it, or a crashed process left it behind. Only the latter may be stolen.
      try {
        const age = (Date.now() - fs.statSync(lockPath).mtimeMs) / 60000;
        if (age > STALE_LOCK_MINUTES) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* the lock went away between the failed open and the stat; try again */
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Another operation holds the lock for ${bookRoot}. Wait for it to finish, or investigate ${lockPath}.`,
        );
      }
      spin(250);
      continue;
    }
    try {
      fs.writeSync(
        handle,
        `pid=${process.pid}\nacquired=${new Date().toISOString()}\nbook=${bookRoot}\n`,
      );
    } finally {
      fs.closeSync(handle);
    }
    // Recorded AFTER the file exists, so a failed acquisition never reads as held.
    const ledgerKey = lockPath.toLowerCase();
    heldLocks.set(ledgerKey, (heldLocks.get(ledgerKey) ?? 0) + 1);
    return { path: lockPath, bookRoot, lockName, ledgerKey };
  }
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
