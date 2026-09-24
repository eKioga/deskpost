/**
 * The rollback journal every Shelf writer records before it touches anything.
 *
 * The PowerShell original is `Write-BookJournal` / `Restore-BookJournal` in
 * `tools/BookWriteGuard.ps1`, and the matrix compares the journal FILE, so this is a port of a
 * document as much as of a behaviour.
 *
 * WHAT IT RECORDS, BEFORE ANY MUTATION: the prior body of every page the operation will change, and
 * the prior ABSENCE of every page it will create -- so a rollback deletes rather than resurrects.
 * The list MAY BE EMPTY: an operation whose only durable change is a directory move has no file
 * bytes to record, and a journal of zero entries is still its dated record and still the shape its
 * rollback is built around. Three of the five writers here journal nothing for exactly that reason.
 *
 * BYTES, NOT TEXT. Schema 2 stores base64 rather than a string because a journal that round-trips
 * prior state through text cannot reproduce a UTF-8 BOM -- so restoring a BOM-carrying file changed
 * its bytes and then failed the very hash check meant to prove the restore.
 *
 * A DERIVED INDEX IS RE-DERIVED, NEVER RESTORED, and it is refused HERE rather than at restore time.
 * `notebook/_master-index.md` and `shelf/_catalog.md` are rendered from state that outlives any one
 * operation, so journaling one records a snapshot of a SHARED view: a rollback would then write that
 * snapshot back over whatever the view has legitimately become, dropping a Book another seat
 * published while this operation was running. Refusing at journal time stops the operation before it
 * mutates anything; refusing at restore time would fire only once a rollback was already under way
 * and had nowhere good to go.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, writeAtomicBytes } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { sha256OfBytes } from './sha.ts';

const JOURNAL_SCHEMA = 2;

/** Lowercase, because NTFS is case-insensitive and a caller spelling one `_Catalog.md` means it. */
const RENDERED_INDEX_FILE_NAMES = ['_master-index.md', '_catalog.md'];

export interface JournalHandle {
  journalPath: string;
  entryCount: number;
}

export function bookJournalDirectory(workspace: string): string {
  const directory = path.join(workspace, 'internal', 'shelf-journals');
  ensureDirectory(directory);
  return directory;
}

/** `yyyyMMdd-HHmmss` in UTC, the spelling `[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')` gives. */
function utcStamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** The round-trip `o` format, which is what every timestamp in this store is written in. */
export function utcRoundTrip(): string {
  return new Date().toISOString().replace('Z', '0000Z');
}

export function writeBookJournal(options: {
  workspace: string;
  bookRoot: string;
  operation: string;
  paths: string[];
  operationDigest?: string;
}): JournalHandle {
  const rendered = options.paths.filter((file) =>
    RENDERED_INDEX_FILE_NAMES.includes(path.basename(file).toLowerCase()),
  );
  if (rendered.length) {
    throw new Error(
      `A journal cannot carry a derived index: ${rendered.join(', ')}. ` +
        'notebook/_master-index.md and shelf/_catalog.md are rendered from state this operation does not own, so ' +
        'restoring a snapshot of one overwrites whatever another seat has rendered since -- and does it with a ' +
        'whole-file write outside the render lock. Journal the authoritative file instead (the topic _index.md, ' +
        'the Book _catalog-entry.md) and re-render in the rollback. See docs/derived-indexes.md.',
    );
  }

  const entries: PsJsonValue[] = [];
  for (const file of [...new Set(options.paths)]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const bytes = fs.readFileSync(file);
      entries.push({
        path: file,
        existed: true,
        sha256: sha256OfBytes(bytes),
        content_base64: bytes.toString('base64'),
      });
    } else {
      // Prior absence is state too: without it, rollback would leave a created file behind.
      entries.push({ path: file, existed: false, sha256: '', content_base64: null });
    }
  }

  const suffix = randomSuffix();
  const name = options.bookRoot.replace(/[\\/]/g, '-');
  const journalPath = path.join(bookJournalDirectory(options.workspace), `${utcStamp()}-${name}-${suffix}.json`);
  const journal: PsJsonValue = {
    schema: JOURNAL_SCHEMA,
    operation: options.operation,
    book_root: options.bookRoot,
    operation_digest: options.operationDigest ?? '',
    recorded: utcRoundTrip(),
    entries,
  };
  // NOT ATOMIC, AND THAT MATCHES THE ORIGINAL. `Write-BookJournal` writes the file directly; the
  // journal is created once, under the Book's lock, at a name nothing else can collide with.
  fs.writeFileSync(journalPath, psConvertToJson(journal), { encoding: 'utf8' });
  return { journalPath, entryCount: entries.length };
}

/** The eight hex characters `[guid]::NewGuid().ToString('N').Substring(0, 8)` produces. */
function randomSuffix(): string {
  let out = '';
  for (let index = 0; index < 8; index += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * Put every journaled path back the way it was, and VERIFY BY READBACK rather than assuming.
 *
 * Every restore is an atomic replacement, for the same reason every ordinary write is one: this is
 * the one write in the Library that happens while something has already gone wrong, and it must not
 * also be the one a concurrent reader can catch half-finished.
 */
export function restoreBookJournal(journalPath: string): { restoredCount: number } {
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8').replace(/^﻿/, '')) as {
    entries?: { path: string; existed: boolean; sha256: string; content_base64: string | null }[];
  };
  const failures: string[] = [];
  let restored = 0;

  for (const entry of journal.entries ?? []) {
    if (entry.existed) {
      ensureDirectory(path.dirname(entry.path));
      if (entry.content_base64 === null || entry.content_base64 === undefined) {
        throw new Error(`the journal entry for ${entry.path} records no prior content`);
      }
      const bytes = Buffer.from(entry.content_base64, 'base64');
      writeAtomicBytes(entry.path, bytes);
      if (sha256OfBytes(fs.readFileSync(entry.path)) !== entry.sha256) {
        failures.push(`${entry.path}: restored content does not match the journaled hash`);
      }
    } else {
      if (fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true });
      if (fs.existsSync(entry.path)) failures.push(`${entry.path}: should be absent but still exists`);
    }
    restored += 1;
  }

  if (failures.length) throw new Error(`Rollback verification failed: ${failures.join('; ')}`);
  return { restoredCount: restored };
}
