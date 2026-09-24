/**
 * Where a Book's manifest lives: versioned generations, a dirty marker, and a commit pointer.
 *
 * The PowerShell original is `tools/BookManifestStore.ps1`. What this file owns is an ORDER, and the
 * order is the whole design:
 *
 *   MARKER DOWN, GENERATION WRITTEN, COMMIT POINTER PUBLISHED, MARKER CLEARED LAST OF ALL. Every
 *   crash point then leaves a state the read path can classify. A generation written without a
 *   marker is exactly the silently-stale case the marker exists to prevent, so writing one is
 *   REFUSED rather than merely discouraged.
 *
 *   THE STORE IS KEYED ON THE COLLECTION AS WELL AS THE SLUG. Keying on the slug alone relied on a
 *   coincidence -- that no shared Book happens to share a slug with a Shelf Book -- and an archived
 *   Book is `shelf-archive` rather than `shelf`, so a Book moving into the archive cannot land in
 *   its active twin's store.
 *
 * DETERMINISTIC SERIALIZATION: `ConvertTo-Json`'s layout, CRLF normalised to LF, exactly one
 * trailing LF. The same manifest object must produce byte-identical files across runs, because the
 * commit pointer stores a hash of those bytes and compares it on every read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { sha256OfBytes } from './sha.ts';
import { utcRoundTrip } from './journal.ts';

const STORE_SCHEMA = 1;
const STORE_ROOT = 'internal/book-manifests';
const KEEP_GENERATIONS = 5;

export const MANIFEST_COLLECTIONS = ['shelf', 'shelf-archive', 'shared', 'shared-archive'];

export interface CommitPointer {
  generation: number;
  manifestSha256: string;
  sourceDigest: string;
  committedUtc: string;
}

export function convertToStoreJson(value: PsJsonValue): string {
  let json = psConvertToJson(value).replace(/\r\n/g, '\n');
  if (!json.endsWith('\n')) json += '\n';
  return json;
}

function storeSha256(file: string): string {
  return sha256OfBytes(fs.readFileSync(file));
}

/**
 * Atomic write: a `.tmp` beside the destination, then a swap, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. Retried, because the swap can lose a race it did
 * nothing wrong in -- a rebuild over thirteen Books lost one to a momentary sharing violation from
 * something else on the machine, and the cost was a spurious dirty Book and a second approved pass.
 */
function saveStoreFile(file: string, content: string): void {
  ensureDirectory(path.dirname(file));
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8' });
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      // Bounded on purpose: a destination held open indefinitely is a state we do not understand,
      // and failing there is right.
      if (attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

export function bookManifestStorePath(workspace: string, slug: string, collection = 'shelf'): string {
  // Built from a NAME, so traversal is refused at the door rather than discovered inside a path.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Book slug '${slug}' must contain only lowercase letters, digits, and hyphens.`);
  }
  if (!MANIFEST_COLLECTIONS.includes(collection)) {
    throw new Error(`Book collection '${collection}' must be one of: ${MANIFEST_COLLECTIONS.join(', ')}.`);
  }
  return path.join(workspace, ...STORE_ROOT.split('/'), collection, slug);
}

/**
 * Overwriting an existing marker is allowed and REFRESHES it: the Book lock makes concurrent markers
 * impossible, and a marker left behind by a crash must not block the repair that clears it.
 */
export function setBookManifestDirty(options: {
  workspace: string;
  slug: string;
  reason: string;
  collection?: string;
}): string {
  const directory = bookManifestStorePath(options.workspace, options.slug, options.collection ?? 'shelf');
  ensureDirectory(directory);
  const marker: PsJsonValue = {
    schema: STORE_SCHEMA,
    slug: options.slug,
    reason: options.reason,
    pid: process.pid,
    started_utc: utcRoundTrip(),
  };
  const file = path.join(directory, 'dirty.json');
  saveStoreFile(file, convertToStoreJson(marker));
  return file;
}

export function nextGeneration(workspace: string, slug: string, collection = 'shelf'): number {
  const directory = bookManifestStorePath(workspace, slug, collection);
  let max = 0;
  const generations = path.join(directory, 'generations');
  if (fs.existsSync(generations)) {
    for (const name of fs.readdirSync(generations)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const parsed = Number.parseInt(name.replace(/\.json$/i, ''), 10);
      if (Number.isInteger(parsed) && parsed > max) max = parsed;
    }
  }
  const currentPath = path.join(directory, 'current.json');
  if (fs.existsSync(currentPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as { generation?: unknown };
      const parsed = Number.parseInt(String(current.generation), 10);
      if (Number.isInteger(parsed) && parsed > max) max = parsed;
    } catch {
      /* an unreadable pointer cannot raise the floor; the generations on disk already did */
    }
  }
  return max + 1;
}

export function writeBookManifestGeneration(options: {
  workspace: string;
  slug: string;
  manifest: PsJsonValue;
  collection?: string;
}): { generation: number; path: string; manifestSha256: string } {
  const collection = options.collection ?? 'shelf';
  const directory = bookManifestStorePath(options.workspace, options.slug, collection);
  // The ordering rule made mechanical rather than merely documented.
  if (!fs.existsSync(path.join(directory, 'dirty.json'))) {
    throw new Error(
      `Book '${options.slug}' has no dirty marker; a manifest generation may only be written inside a mutation.`,
    );
  }
  const generation = nextGeneration(options.workspace, options.slug, collection);
  const file = path.join(directory, 'generations', `${generation}.json`);
  saveStoreFile(file, convertToStoreJson(options.manifest));
  return { generation, path: file, manifestSha256: storeSha256(file) };
}

export function completeBookManifestGeneration(options: {
  workspace: string;
  slug: string;
  generation: number;
  collection?: string;
}): CommitPointer {
  const collection = options.collection ?? 'shelf';
  const directory = bookManifestStorePath(options.workspace, options.slug, collection);
  const generationPath = path.join(directory, 'generations', `${options.generation}.json`);
  if (!fs.existsSync(generationPath)) {
    throw new Error(`Generation ${options.generation} of Book '${options.slug}' has no stored file; nothing to commit.`);
  }
  // Never trust a hash passed in: re-read the generation from disk and re-hash it.
  const stored = JSON.parse(fs.readFileSync(generationPath, 'utf8')) as { source_digest?: unknown };
  const pointer: PsJsonValue = {
    schema: STORE_SCHEMA,
    slug: options.slug,
    generation: options.generation,
    committed_utc: utcRoundTrip(),
    manifest_sha256: storeSha256(generationPath),
    source_digest: stored.source_digest === undefined ? '' : String(stored.source_digest),
  };
  saveStoreFile(path.join(directory, 'current.json'), convertToStoreJson(pointer));
  // The commit pointer is on disk; ONLY NOW is the dirty marker cleared.
  try {
    fs.rmSync(path.join(directory, 'dirty.json'), { force: true });
  } catch {
    /* a marker that will not clear leaves the Book dirty, which is the safe direction */
  }
  pruneBookManifestGenerations(options.workspace, options.slug, collection);
  return {
    generation: options.generation,
    manifestSha256: String((pointer as Record<string, PsJsonValue>)['manifest_sha256']),
    sourceDigest: String((pointer as Record<string, PsJsonValue>)['source_digest']),
    committedUtc: String((pointer as Record<string, PsJsonValue>)['committed_utc']),
  };
}

export function saveBookManifest(options: {
  workspace: string;
  slug: string;
  manifest: PsJsonValue;
  reason: string;
  collection?: string;
}): CommitPointer {
  // The Book lock wraps THIS function. Nothing here acquires one; the ordering is what makes an
  // outer lock sufficient.
  setBookManifestDirty({
    workspace: options.workspace,
    slug: options.slug,
    reason: options.reason,
    collection: options.collection,
  });
  const written = writeBookManifestGeneration({
    workspace: options.workspace,
    slug: options.slug,
    manifest: options.manifest,
    collection: options.collection,
  });
  return completeBookManifestGeneration({
    workspace: options.workspace,
    slug: options.slug,
    generation: written.generation,
    collection: options.collection,
  });
}

/**
 * A Book that no longer exists under this slug must not leave a store behind. The WHOLE directory
 * goes -- marker, generations and pointer -- because half a store is a state the read path would
 * have to classify for a Book that is not there. Deleting a manifest is safe in a way deleting a
 * page never is: it is DERIVED, so the worst a wrong deletion costs is a rebuild.
 */
export function removeBookManifestStore(workspace: string, slug: string, collection = 'shelf'): boolean {
  const directory = bookManifestStorePath(workspace, slug, collection);
  if (!fs.existsSync(directory)) return false;
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}

function pruneBookManifestGenerations(workspace: string, slug: string, collection: string): void {
  const directory = bookManifestStorePath(workspace, slug, collection);
  const generations = path.join(directory, 'generations');
  if (!fs.existsSync(generations)) return;

  let committed = 0;
  const currentPath = path.join(directory, 'current.json');
  if (fs.existsSync(currentPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as { generation?: unknown };
      const parsed = Number.parseInt(String(current.generation), 10);
      if (Number.isInteger(parsed)) committed = parsed;
    } catch {
      /* an unreadable pointer protects nothing; the keep window below still does */
    }
  }

  const entries: { n: number; path: string }[] = [];
  for (const name of fs.readdirSync(generations)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const parsed = Number.parseInt(name.replace(/\.json$/i, ''), 10);
    if (Number.isInteger(parsed)) entries.push({ n: parsed, path: path.join(generations, name) });
  }
  const sorted = entries.sort((left, right) => right.n - left.n);
  const keep = new Set(sorted.slice(0, KEEP_GENERATIONS).map((entry) => entry.n));
  for (const entry of sorted) {
    if (entry.n === committed || keep.has(entry.n)) continue;
    fs.rmSync(entry.path, { force: true });
  }
}

export interface StoredBookManifest {
  status: 'ok' | 'missing' | 'dirty' | 'corrupt' | 'incomplete';
  reason: string;
  slug: string;
  generation: number | null;
  manifest: Record<string, unknown> | null;
  sourceDigest: string | null;
  committedUtc: string | null;
}

/**
 * The READ side of the store, and the authority every query defers to.
 *
 * DIRTY IS CHECKED FIRST, before a pointer and a matching generation are even looked for: a Book
 * whose mutation window is open may be halfway through a write, and answering from the last
 * committed generation would describe a Book that no longer exists in that shape.
 *
 * EVERY FAILURE IS A NAMED STATE RATHER THAN AN ERROR. `missing`, `corrupt`, `incomplete` and
 * `dirty` are four different things a reader can act on, and a caller that could only tell "not ok"
 * would report an un-generated Book and a tampered one the same way.
 */
export function getStoredBookManifest(workspace: string, slug: string, collection = 'shelf'): StoredBookManifest {
  const directory = bookManifestStorePath(workspace, slug, collection);
  const result: StoredBookManifest = {
    status: 'missing',
    reason: '',
    slug,
    generation: null,
    manifest: null,
    sourceDigest: null,
    committedUtc: null,
  };

  const dirtyPath = path.join(directory, 'dirty.json');
  if (fs.existsSync(dirtyPath)) {
    result.status = 'dirty';
    try {
      const marker = JSON.parse(fs.readFileSync(dirtyPath, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      result.reason = `mutation in progress: ${String(marker['reason'])} (pid ${String(marker['pid'])})`;
    } catch {
      result.reason = 'a dirty marker is present but does not parse';
    }
    return result;
  }

  const currentPath = path.join(directory, 'current.json');
  if (!fs.existsSync(currentPath)) {
    result.status = 'missing';
    result.reason = 'no commit pointer exists for this Book';
    return result;
  }

  let current: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(currentPath, 'utf8').replace(/^﻿/, ''));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    current = null;
  }
  if (current === null || Object.keys(current).length === 0) {
    result.status = 'corrupt';
    result.reason = 'current.json does not parse as a JSON object';
    return result;
  }

  const required = ['schema', 'slug', 'generation', 'committed_utc', 'manifest_sha256', 'source_digest'];
  const missing = required.filter((name) => !(name in current!));
  if (missing.length) {
    result.status = 'corrupt';
    result.reason = `current.json is missing required field(s): ${missing.join(', ')}`;
    return result;
  }

  const schema = Number.parseInt(String(current['schema']), 10);
  if (!Number.isInteger(schema)) {
    result.status = 'corrupt';
    result.reason = 'current.json carries a non-numeric schema';
    return result;
  }
  if (schema !== STORE_SCHEMA) {
    result.status = 'corrupt';
    result.reason = `current.json carries schema ${schema}, expected ${STORE_SCHEMA}`;
    return result;
  }

  const generation = Number.parseInt(String(current['generation']), 10);
  if (!Number.isInteger(generation)) {
    result.status = 'corrupt';
    result.reason = 'current.json carries a non-numeric generation';
    return result;
  }
  result.generation = generation;

  const generationPath = path.join(directory, 'generations', `${generation}.json`);
  if (!fs.existsSync(generationPath)) {
    result.status = 'incomplete';
    result.reason = `generation ${generation} named by the commit pointer is absent`;
    return result;
  }

  if (storeSha256(generationPath) !== String(current['manifest_sha256'])) {
    result.status = 'corrupt';
    result.reason = 'the generation file bytes do not match the committed hash';
    return result;
  }

  let manifest: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(generationPath, 'utf8').replace(/^﻿/, ''));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
  } catch {
    manifest = null;
  }
  if (manifest === null || Object.keys(manifest).length === 0) {
    result.status = 'corrupt';
    result.reason = 'the generation file does not parse as a JSON object';
    return result;
  }

  result.status = 'ok';
  result.reason = '';
  result.sourceDigest = String(current['source_digest']);
  result.committedUtc = String(current['committed_utc']);
  result.manifest = manifest;
  return result;
}
