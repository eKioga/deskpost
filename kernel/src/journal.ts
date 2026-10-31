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
import { resolveSeatName } from './seatdesk.ts';
import { seatIncarnation } from './seatincarnation.ts';

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
  // ONLY THE INDEXES THE APPLICATION DERIVES (S67): the Notebook's master index, at its top or a seat's, and the
  // Shelf catalog. A Book PAGE may carry one of those names -- collection Books hold curated
  // `<topic>/_master-index` pages -- and refusing it by name alone made such a page impossible to write.
  const rendered = options.paths.filter((file) => {
    if (!RENDERED_INDEX_FILE_NAMES.includes(path.basename(file).toLowerCase())) return false;
    const relative = path.relative(path.resolve(options.workspace), path.resolve(file)).replace(/\\/g, '/').toLowerCase();
    return /^notebook\/(?:[^/]+\/)?_master-index\.md$/.test(relative) || relative === 'shelf/_catalog.md';
  });
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

// --- what undo needs (kickoffs/s165 row 1; PLAN-fewer-yeses.md Approach 2) ---------------------------------------

/**
 * ONE SHAPE FOR EVERY WRITE `deskpost undo` CAN REVERSE, kept in the writer's own journal under `undo`. Each path is
 * workspace-relative with forward slashes, and carries whether it existed and its prior bytes, as the Book journal
 * above keeps them, and `after_sha256`, the hash of what the write left there (null when it left nothing). The after
 * hash is what lets an undo tell a page that is still the writer's from one someone changed since. `evidence` names
 * every record the write produced that another verb reads as a fact (a publication-evidence file, a triage batch
 * journal), which an undo marks `undone_by`; `regenerates` names what the writer re-derived (a Discovery manifest, a
 * reader map, the Notebook index), which an undo re-derives in turn; `locks` are the lock roots the write held, in its
 * order; `marker` is the Book whose dirty marker the write's window set, or null.
 *
 * `written_by_seat` (kickoffs/s167 row 1) is the seat the writing process resolved, or null when it resolved none: an
 * undo or redo by another seat refuses, and a block written before the field existed refuses as predating the check.
 * `written_by_seat_id` (kickoffs/s168 row 4) is that seat's registry `seat_id`, which the undo compares: a block with a
 * name and no id refuses the same way.
 * The undo derives its locks from the paths and never takes them from `locks`, which stays as the writer's record.
 */
export interface UndoPathBefore {
  path: string;
  existed: boolean;
  content_base64: string | null;
}

export type UndoRegenerate = { kind: 'manifest'; collection: 'shelf' | 'collection'; slug: string } | { kind: 'shelf-note-index'; slug: string } | { kind: 'notebook-index'; seat: string };

export interface UndoBlockOptions {
  operationId?: string;
  kind: string;
  locks: string[];
  before: UndoPathBefore[];
  evidence?: { path: string; kind: string }[];
  regenerates?: UndoRegenerate[];
  marker?: { collection: 'shelf' | 'collection'; slug: string } | null;
  /** The seat the caller resolved, when it took one from `--seat`; otherwise this process's own is resolved. */
  seat?: string | null;
}

/** An operation's id: `op-` and 16 hex characters, random, so two writes in one second never share one. */
export function newOperationId(): string {
  return `op-${randomSuffix()}${randomSuffix()}`;
}

/** Workspace-relative, forward slashes; refused when the file is not inside the workspace. */
export function workspaceRelativePath(workspace: string, file: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${file} is not inside the Library at ${workspace}.`);
  return relative.replace(/\\/g, '/');
}

/** Each file's prior state, read before the write: its bytes, or its absence. */
export function capturePriorBytes(workspace: string, files: string[]): UndoPathBefore[] {
  return [...new Set(files)].map((file) => {
    const existed = fs.existsSync(file) && fs.statSync(file).isFile();
    return { path: workspaceRelativePath(workspace, file), existed, content_base64: existed ? fs.readFileSync(file).toString('base64') : null };
  });
}

/** The prior states a Book journal above already holds, so a Book writer reads nothing twice. */
export function priorBytesFromBookJournal(workspace: string, journalPath: string): UndoPathBefore[] {
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8').replace(/^﻿/, '')) as { entries?: { path: string; existed: boolean; content_base64: string | null }[] };
  return (journal.entries ?? []).map((entry) => ({ path: workspaceRelativePath(workspace, entry.path), existed: entry.existed, content_base64: entry.existed ? entry.content_base64 : null }));
}

/**
 * The seat this process writes as: the one its caller resolved (`hub edit --seat`), else `resolveSeatName`'s answer for
 * the Library's own `.claude`; null when none resolves. With it, the registry's `seat_id` for that seat, or null when the
 * registry gives none (kickoffs/s168 row 4): a name can pass to another seat, an id cannot.
 */
export function writingSeat(workspace: string, seat?: string | null): { name: string; id: string | null } | null {
  const stateDirectory = path.join(workspace, '.claude');
  let name = seat ?? null;
  if (!name) {
    const resolved = resolveSeatName({ stateDirectory });
    name = resolved.status === 'named' ? resolved.seat : null;
  }
  return name ? { name, id: seatIncarnation(stateDirectory, name).seatId || null } : null;
}

/** The `undo` block, its after hashes read from disk now: called once the write is verified. */
export function undoBlock(workspace: string, options: UndoBlockOptions): PsJsonValue {
  const writer = writingSeat(workspace, options.seat);
  const paths = options.before.map((entry) => {
    const full = path.join(workspace, ...entry.path.split('/'));
    const after = fs.existsSync(full) && fs.statSync(full).isFile() ? sha256OfBytes(fs.readFileSync(full)) : null;
    return { path: entry.path, existed: entry.existed, content_base64: entry.content_base64, after_sha256: after };
  });
  return {
    schema: 1,
    operation_id: options.operationId ?? newOperationId(),
    kind: options.kind,
    locks: options.locks,
    paths,
    evidence: (options.evidence ?? []) as PsJsonValue,
    regenerates: (options.regenerates ?? []) as PsJsonValue,
    marker: (options.marker ?? null) as PsJsonValue,
    written_by_seat: writer?.name ?? null,
    written_by_seat_id: writer?.id ?? null,
  };
}

/** Add the block to a journal already on disk, rewriting it whole and atomically. */
export function addUndoBlock(journalPath: string, block: PsJsonValue): void {
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8').replace(/^﻿/, '')) as Record<string, PsJsonValue>;
  journal['undo'] = block;
  writeAtomicBytes(journalPath, Buffer.from(psConvertToJson(journal), 'utf8'));
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
