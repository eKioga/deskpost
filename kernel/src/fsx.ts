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
 * untouched. (Since 1.1 a write inside a Library stages in its one staging folder instead; see below.)
 * The staging name is unique rather than a fixed `.tmp`: two writers sharing one staging name is a
 * collision with no lock behind it, and the second would publish the first one's bytes.
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

/**
 * ONE STAGING FOLDER PER LIBRARY (PLAN-basic-memory.md step 4a, Eric's ruling (a)). Until 1.1 each write staged as
 * `.<name>.<random>.tmp` BESIDE its file, so a sync client watching a Library -- Obsidian Sync in Eric's vault --
 * saw transient files come and go in every folder the program touched. A write inside a Library now stages in
 * `<Library>/.deskpost-staging/`: one dot-folder, which Obsidian ignores, and one exclude rule for any other sync.
 *
 * THE LIBRARY IS FOUND BY THE MARKER WALK (`.library/workspace.json`), cached per directory for this process, and
 * only when found: a folder that becomes a Library mid-process -- `init` writing its marker -- is seen on its
 * next write. Two fallbacks stage beside the file as before: a write OUTSIDE any Library (the registry, a doctor
 * fixture), and a rename refused with EXDEV, because a Library subfolder that is a junction to another drive
 * cannot be renamed into from the Library's own volume. Without the second such a folder would be unwritable.
 */
export const STAGING_FOLDER = '.deskpost-staging';

const libraryOfDirectory = new Map<string, string>();

function libraryRootOf(directory: string): string | null {
  const start = path.resolve(directory);
  const cached = libraryOfDirectory.get(start);
  if (cached !== undefined) return cached;
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, '.library', 'workspace.json'))) {
      libraryOfDirectory.set(start, current);
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function stagingName(file: string): string {
  return `.${path.basename(file)}.${process.pid.toString(36)}${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(36)}.tmp`;
}

function removeDebris(staging: string): void {
  if (!fs.existsSync(staging)) return;
  try {
    fs.unlinkSync(staging);
  } catch {
    /* the staging file is debris, never the outcome; a failure to remove it is not a failed write */
  }
}

/** Stage `write` in the Library's staging folder, or beside the file; publish it by rename, EXDEV re-staged beside. */
function writeStaged(file: string, write: (staging: string) => void, beforeRename: () => void = () => {}): void {
  const directory = path.dirname(file);
  ensureDirectory(directory);
  const library = libraryRootOf(directory);
  const besideOnly = library === null || path.resolve(directory).toLowerCase().startsWith(path.join(library, STAGING_FOLDER).toLowerCase());
  const attempts = besideOnly ? [directory] : [path.join(library!, STAGING_FOLDER), directory];
  for (let index = 0; index < attempts.length; index += 1) {
    const stagingDirectory = attempts[index]!;
    ensureDirectory(stagingDirectory);
    const staging = path.join(stagingDirectory, stagingName(file));
    try {
      write(staging);
      beforeRename();
      publishByRename(staging, file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV' && index + 1 < attempts.length) continue;
      throw error;
    } finally {
      removeDebris(staging);
    }
  }
}

export function writeAtomicText(file: string, text: string): void {
  writeStaged(file, (staging) => fs.writeFileSync(staging, text, { encoding: 'utf8' }));
}

/**
 * The same publish-by-rename, for bytes rather than text. The journal restores prior BODIES, which
 * are bytes: a restore that re-encoded them through a string could not reproduce a UTF-8 BOM, and
 * would then fail the hash check meant to prove it had restored anything.
 */
export function writeAtomicBytes(file: string, bytes: Uint8Array): void {
  writeStaged(
    file,
    (staging) => fs.writeFileSync(staging, bytes),
    () => {
      // A read-only destination made a rollback fail where a deletion would have succeeded, which
      // leaves a Book half-migrated -- strictly worse than restoring it. Found by the rename writer.
      if (fs.existsSync(file)) {
        try {
          fs.chmodSync(file, 0o666);
        } catch {
          /* an attribute this runtime cannot clear is reported by the rename below, not here */
        }
      }
    },
  );
}

/**
 * Staging files older than a day, cleared at seat start: a write that crashed between its staging and its rename
 * leaves one, and nothing else ever will. Never throws; returns how many were removed.
 */
export function clearStaleStaging(workspace: string, olderThanMs = 24 * 60 * 60 * 1000): number {
  const directory = path.join(workspace, STAGING_FOLDER);
  let removed = 0;
  try {
    if (!fs.existsSync(directory)) return 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(directory, entry.name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > olderThanMs) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch {
        /* held, or gone already: the next seat start tries again */
      }
    }
  } catch {
    /* an unreadable staging folder is not a reason to refuse a seat */
  }
  return removed;
}

export function readTextIfPresent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}
