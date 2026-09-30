/**
 * THE RECALL RECORD (S70, PLAN-shelf-recall.md): what `shelf recall` leaves behind so the way back can tell whether
 * the collection Book moved while its Shelf copy was out.
 *
 * `internal/shelf-recalls/<shelf-slug>.json`, schema 1. It names the collection Book and the Shelf copy, the recall's
 * plan_id, time and seat, the title and summary it carried, and the collection Book's PAGE MANIFEST at the recall:
 * every `.md` under its `wiki/` but `_book.md` and `_index.md`, each with its full bytes' SHA-256 and its body's (the
 * frontmatter split off, as publish hashes it). `_book` and `_index` are hashed apart, because the return
 * regenerates both: a hand edit to either is REPORTED, never refused.
 *
 * WHO READS IT. The return routes -- `publish <shelf-slug>` and `publish refresh` -- default `--book-slug` from it,
 * refuse a different one, and refuse DRIFT: a collection page added, changed or removed since the recall. `publish
 * batch` refuses a Shelf Book that has one, because a batch never replaces. `shelf rename` moves it, `shelf archive`
 * and `shelf remove` delete it, and `shelf new` refuses a slug that has one. `internal/` is outside every reset.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { psSortCompare } from './pssort.ts';

export const RECALL_RECORD_SCHEMA = 1;

export interface RecallPage {
  path: string;
  sha256: string;
  body_sha256: string;
}

export interface CollectionManifest {
  pages: RecallPage[];
  book_sha256: string;
  index_sha256: string;
}

export interface RecallRecord extends CollectionManifest {
  schema: number;
  book_slug: string;
  shelf_slug: string;
  plan_id: string;
  recalled_utc: string;
  refreshed_utc: string | null;
  seat: string;
  title: string;
  summary: string;
}

export function recallRecordDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'shelf-recalls');
}

export function recallRecordPath(workspace: string, shelfSlug: string): string {
  return path.join(recallRecordDirectory(workspace), `${shelfSlug}.json`);
}

/** The workspace-relative spelling a result shows. */
export function recallRecordLabel(shelfSlug: string): string {
  return `internal/shelf-recalls/${shelfSlug}.json`;
}

/**
 * The record for a Shelf slug, or null when there is none. A record that cannot be read is a REFUSAL, never a null:
 * reading it as absent would let a return skip its drift check.
 */
export function readRecallRecord(workspace: string, shelfSlug: string): RecallRecord | null {
  const file = recallRecordPath(workspace, shelfSlug);
  if (!fs.existsSync(file)) return null;
  let value: Partial<RecallRecord>;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<RecallRecord>;
  } catch (error) {
    throw new Error(`The recall record ${recallRecordLabel(shelfSlug)} cannot be read (${(error as Error).message}), so the way back cannot check for drift. Repair or remove it by hand.`);
  }
  if (value.schema !== RECALL_RECORD_SCHEMA || typeof value.book_slug !== 'string' || !Array.isArray(value.pages)) {
    throw new Error(`The recall record ${recallRecordLabel(shelfSlug)} is not a schema-${RECALL_RECORD_SCHEMA} record, so the way back cannot check for drift. Repair or remove it by hand.`);
  }
  return value as RecallRecord;
}

export function writeRecallRecord(workspace: string, record: RecallRecord): void {
  ensureDirectory(recallRecordDirectory(workspace));
  writeAtomicText(recallRecordPath(workspace, record.shelf_slug), psConvertToJson(record as unknown as PsJsonValue) + '\n');
}

/**
 * A SLUG WITH A RECALL RECORD TAKES NO OTHER BOOK (S70 `shelf new`, S71 `shelf rename`): whatever landed on it would
 * inherit that record's return defaults and its drift digest. `shelf recall` replaces a record whose Book is gone, so
 * it is the route. `arrival` says how the Book would get there ("a new Book", "a Book renamed"), `outcome` what did not
 * happen ("Nothing was created.").
 */
export function recallRecordTakenRefusal(shelfSlug: string, record: RecallRecord, arrival: string, outcome: string): string {
  return (
    `shelf/${shelfSlug} has a recall record (${recallRecordLabel(shelfSlug)}, from collection/books/${record.book_slug}), so ${arrival} there ` +
    `would inherit its return defaults and its drift check. Recall the Book again with deskpost shelf recall ${record.book_slug} ` +
    `--shelf-slug ${shelfSlug}, which replaces a record whose Shelf Book is gone, or choose another slug. ${outcome}`
  );
}

export function deleteRecallRecord(workspace: string, shelfSlug: string): boolean {
  const file = recallRecordPath(workspace, shelfSlug);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** The candidate's `Split-Frontmatter` body: what publish hashes a page by. */
export function pageBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return content;
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing < 0) return content;
  return normalized.substring(closing + 5).replace(/^[\r\n]+|[\r\n]+$/g, '');
}

function filesBelow(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * A collection Book's page manifest, FROM DISK: the recall's own function, and the one the drift check and the
 * refreshed record use, so the three can never disagree about which pages a Book has. `_book.md` and `_index.md` at
 * the top of `wiki/` are hashed apart, as publish excludes them; the same names in a topic folder are pages.
 */
export function collectionPageManifest(wiki: string): CollectionManifest {
  const hashOf = (name: string): string => {
    const file = path.join(wiki, name);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? sha256OfBytes(fs.readFileSync(file)) : '';
  };
  const pages = filesBelow(wiki)
    .filter((file) => path.extname(file).toLowerCase() === '.md')
    .map((file) => ({ file, relative: file.substring(wiki.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') }))
    .filter((item) => !['_book.md', '_index.md'].includes(item.relative.toLowerCase()))
    .sort((left, right) => psSortCompare(left.file, right.file))
    .map((item) => {
      const bytes = fs.readFileSync(item.file);
      return { path: item.relative, sha256: sha256OfBytes(bytes), body_sha256: sha256OfText(pageBody(bytes.toString('utf8').replace(/^﻿/, ''))) };
    });
  return { pages, book_sha256: hashOf('_book.md'), index_sha256: hashOf('_index.md') };
}

/** The digest a return's approval binds: the record's Book, Shelf slug and manifest, never its times. */
export function recallRecordDigest(record: RecallRecord): string {
  return sha256OfText(
    [
      `book=${record.book_slug}`,
      `shelf=${record.shelf_slug}`,
      ...record.pages.map((page) => `page=${page.path}|${page.sha256}`),
      `_book=${record.book_sha256}`,
      `_index=${record.index_sha256}`,
    ].join('\n'),
  );
}

export interface RecallDrift {
  added: string[];
  changed: string[];
  removed: string[];
}

/** What changed in the collection Book's pages since the record was written. `_book` and `_index` are not pages. */
export function recallDrift(record: CollectionManifest, now: CollectionManifest): RecallDrift {
  const then = new Map(record.pages.map((page) => [page.path.toLowerCase(), page]));
  const current = new Map(now.pages.map((page) => [page.path.toLowerCase(), page]));
  const added = now.pages.filter((page) => !then.has(page.path.toLowerCase())).map((page) => page.path);
  const removed = record.pages.filter((page) => !current.has(page.path.toLowerCase())).map((page) => page.path);
  const changed = now.pages.filter((page) => {
    const before = then.get(page.path.toLowerCase());
    return before !== undefined && before.sha256 !== page.sha256;
  }).map((page) => page.path);
  return { added, changed, removed };
}

export function hasDrift(drift: RecallDrift): boolean {
  return drift.added.length + drift.changed.length + drift.removed.length > 0;
}

/** The drift refusal, naming every page and both routes. */
export function driftRefusal(bookSlug: string, shelfSlug: string, drift: RecallDrift): string {
  const parts = [
    drift.added.length ? `added: ${drift.added.join(', ')}` : '',
    drift.changed.length ? `changed: ${drift.changed.join(', ')}` : '',
    drift.removed.length ? `removed: ${drift.removed.join(', ')}` : '',
  ].filter((part) => part);
  return (
    `collection/books/${bookSlug} changed after shelf/${shelfSlug} was recalled from it (${parts.join('; ')}), so returning the ` +
    'Shelf copy would overwrite work it never saw. Nothing was written. Either recall the Book again into a new Shelf slug ' +
    `(deskpost shelf recall ${bookSlug} --shelf-slug <new-slug>) and merge the two by hand, or discard this recall ` +
    `(deskpost shelf remove ${shelfSlug}).`
  );
}
