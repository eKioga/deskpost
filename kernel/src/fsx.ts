/**
 * File writes, with the two properties the PowerShell tools spent measurement on.
 *
 * UTF-8 WITHOUT A BOM, ALWAYS. `tools/AtomicFile.ps1` writes through an explicit
 * `UTF8Encoding($false)` for the same reason: a BOM is three bytes at the head of a file that every
 * text comparison then reports as a difference, and half the readers in this tree strip it and half
 * do not.
 *
 * ATOMIC REPLACEMENT, NEVER TRUNCATE-IN-PLACE. A derived index is read by other processes while it
 * is being rewritten, so the bytes go to a uniquely named staging file in the DESTINATION'S OWN
 * directory -- same volume, so publishing is a rename rather than a copy -- and the rename swaps the
 * two entries. A reader sees the whole old file or the whole new one, and a crash leaves the old one
 * untouched. The staging name is unique rather than a fixed `.tmp`: two writers sharing one staging
 * name is a collision with no lock behind it, and the second would publish the first one's bytes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

/**
 * THE PUBLISHING RENAME, RETRIED AGAINST A HOLDER (S43). `Write-AtomicBytes` renames with `MoveFileEx` and
 * MOVEFILE_REPLACE_EXISTING -- which is what `fs.renameSync` calls on Windows -- and Windows refuses that
 * rename, ACCESS_DENIED, while ANY process holds the destination open, a reader included. The oracle retries
 * eight times, 120 ms apart, and this port renamed once: kernel self-test section 31 found every fourth
 * replacement of a page failing with EPERM while another process read it. So the rename is retried the same
 * way, and a holder that outlasts the retries is refused in the oracle's words, the file unchanged.
 *
 * CONCEDED: the oracle falls back to `File.Replace` for the second half of its attempts, which serves a holder
 * that shares Delete where `MoveFileEx` cannot; Node has no `ReplaceFileW`, so a persistent delete-sharing
 * holder is refused here where the oracle would have written. A transient holder -- a reader, a virus scan --
 * is served either way. THE RETRY IS FOR A HOLDER, NOT A RACE: bounded, so a genuine holder is still reported.
 */
const RENAME_ATTEMPTS = 8;
const RENAME_PAUSE_MS = 120;

function publishByRename(staging: string, file: string): void {
  let last: unknown = null;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(staging, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      last = error;
      // JITTERED, where the oracle's pause is a fixed 120 ms: a holder that polls on a period -- a watcher, a
      // sync client, the reader kernel self-test section 31 runs -- stays in phase with a fixed retry, and was
      // measured (S43) to refuse all eight attempts of one write in ten. Between half and one and a half pauses.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(RENAME_PAUSE_MS * (0.5 + Math.random())));
    }
  }
  throw new Error(
    `Could not atomically replace '${file}' after ${RENAME_ATTEMPTS} attempt(s); it is held by another process. ` +
      `The file was NOT changed. ${(last as Error).message}`,
  );
}

export function writeAtomicText(file: string, text: string): void {
  const directory = path.dirname(file);
  ensureDirectory(directory);
  const staging = path.join(
    directory,
    `.${path.basename(file)}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(36)}.tmp`,
  );
  try {
    fs.writeFileSync(staging, text, { encoding: 'utf8' });
    publishByRename(staging, file);
  } finally {
    if (fs.existsSync(staging)) {
      try {
        fs.unlinkSync(staging);
      } catch {
        /* the staging file is debris, never the outcome; a failure to remove it is not a failed write */
      }
    }
  }
}

/**
 * The same publish-by-rename, for bytes rather than text. The journal restores prior BODIES, which
 * are bytes: a restore that re-encoded them through a string could not reproduce a UTF-8 BOM, and
 * would then fail the hash check meant to prove it had restored anything.
 */
export function writeAtomicBytes(file: string, bytes: Uint8Array): void {
  const directory = path.dirname(file);
  ensureDirectory(directory);
  const staging = path.join(
    directory,
    `.${path.basename(file)}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(36)}.tmp`,
  );
  try {
    fs.writeFileSync(staging, bytes);
    // A read-only destination made a rollback fail where a deletion would have succeeded, which
    // leaves a Book half-migrated -- strictly worse than restoring it. Found by the rename writer.
    if (fs.existsSync(file)) {
      try {
        fs.chmodSync(file, 0o666);
      } catch {
        /* an attribute this runtime cannot clear is reported by the rename below, not here */
      }
    }
    publishByRename(staging, file);
  } finally {
    if (fs.existsSync(staging)) {
      try {
        fs.unlinkSync(staging);
      } catch {
        /* the staging file is debris, never the outcome */
      }
    }
  }
}

export function readTextIfPresent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}
