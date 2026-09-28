/**
 * A Basic Memory collection's storage folder, as import and status read it (PLAN-basic-memory.md steps 3 and 4,
 * ruling B2): enumerated FROM DISK, byte for byte, never written.
 *
 * THE DISK, NOT THE CATALOGS (Fable #9). A source catalog is a reader-facing list and can be incomplete -- Eric's
 * archive holds `archive/blog` and no catalog line for it -- so a root is any folder under `books/`, `projects/`,
 * `archive/` or `archive/projects/`. Markdown is canonical (ADR-0030); Basic Memory itself is not called.
 *
 * WHAT IS TAKEN, AND WHAT IS NAMED INSTEAD. `books/<slug>/**`, `projects/<slug>/**`, `archive/<slug>/**` and
 * `archive/projects/<slug>/**`. Everything else in the folder -- another program's material beside the Library's
 * -- is skipped and named; so is every dot-folder (`.owner/` and the like) and every dot-file; and a SYMLINK OR
 * JUNCTION anywhere is refused and named, never followed (Fable #11), because following one reads a place the
 * collection does not own. The four catalogs are merged into, never copied over.
 *
 * THE RECORD (`collection/imports.md`, B2). A note whose body is one fenced JSON block -- outside every dot-folder
 * and a `.md`, because Obsidian Sync skips dot-folders and syncs `.json` only when a setting it ships off is on.
 * It holds each imported file's path and its SHA-256 at import time, and it is what lets a re-import say WHICH
 * SIDE changed a file, rather than only that the two differ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256OfBytes } from './sha.ts';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { readUtf8 } from './shelfbook.ts';
import { localPublicationState, ownedLines, splitLocalFrontmatter } from './localcatalog.ts';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type RootKind = 'book' | 'project' | 'archived-book' | 'archived-project';

export interface SourceRoot {
  /** `books/<slug>`, `projects/<slug>`, `archive/<slug>` or `archive/projects/<slug>`. */
  root: string;
  kind: RootKind;
  slug: string;
}

export interface SourceFile {
  /** Collection-relative, forward slashes: the same path in the source and in `collection/`. */
  relative: string;
  root: string;
  full: string;
  sha256: string;
}

export interface SourceSkip {
  path: string;
  reason: string;
}

export interface SourceScan {
  storage: string;
  roots: SourceRoot[];
  files: SourceFile[];
  skipped: SourceSkip[];
  refused: SourceSkip[];
}

function relativeOf(storage: string, full: string): string {
  return path.relative(storage, full).split(path.sep).join('/');
}

/** Every file under one root, dot-entries skipped and every link refused, each hashed from its bytes. */
function walkRoot(storage: string, root: SourceRoot, scan: SourceScan): void {
  const pending = [path.join(storage, ...root.root.split('/'))];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(directory, entry.name);
      const relative = relativeOf(storage, full);
      if (entry.isSymbolicLink() || fs.lstatSync(full).isSymbolicLink()) {
        scan.refused.push({ path: relative, reason: 'a symlink or junction: refused, never followed' });
        continue;
      }
      if (entry.name.startsWith('.')) {
        scan.skipped.push({ path: relative + (entry.isDirectory() ? '/' : ''), reason: entry.isDirectory() ? 'a dot-folder' : 'a dot-file' });
        continue;
      }
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) scan.files.push({ relative, root: root.root, full, sha256: sha256OfBytes(fs.readFileSync(full)) });
    }
  }
}

/** The roots one catalog folder holds, and what else is in it. `README.md` is its catalog and is merged, not taken. */
function rootsIn(storage: string, folder: string, kind: RootKind, scan: SourceScan, except: string[] = []): SourceRoot[] {
  const directory = path.join(storage, ...folder.split('/'));
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  const roots: SourceRoot[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = `${folder}/${entry.name}`;
    if (except.includes(entry.name)) continue;
    if (entry.isSymbolicLink() || fs.lstatSync(path.join(directory, entry.name)).isSymbolicLink()) {
      scan.refused.push({ path: relative, reason: 'a symlink or junction: refused, never followed' });
      continue;
    }
    if (entry.name.startsWith('.')) {
      scan.skipped.push({ path: relative + (entry.isDirectory() ? '/' : ''), reason: entry.isDirectory() ? 'a dot-folder' : 'a dot-file' });
      continue;
    }
    if (entry.isFile()) {
      if (entry.name === 'README.md') continue;
      scan.skipped.push({ path: relative, reason: 'a file beside the roots, not inside one' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (!SLUG.test(entry.name)) {
      scan.skipped.push({ path: `${relative}/`, reason: 'not a slug, so not a Book or Hub root' });
      continue;
    }
    roots.push({ root: relative, kind, slug: entry.name });
  }
  return roots;
}

/**
 * The storage folder, read whole: every root and file the import takes, and everything it does not, named. Throws
 * only when the folder is not a collection at all.
 */
export function scanSource(storage: string): SourceScan {
  const root = path.resolve(storage);
  if (!fs.existsSync(path.join(root, 'books', 'README.md')) || !fs.existsSync(path.join(root, 'projects', 'README.md'))) {
    throw new Error(`${root} does not hold both books/README.md and projects/README.md, so it is not a collection's storage folder.`);
  }
  const scan: SourceScan = { storage: root, roots: [], files: [], skipped: [], refused: [] };
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (['books', 'projects', 'archive'].includes(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.isSymbolicLink()) scan.refused.push({ path: entry.name, reason: 'a symlink or junction: refused, never followed' });
    else scan.skipped.push({ path: entry.name + (entry.isDirectory() ? '/' : ''), reason: entry.name.startsWith('.') ? 'a dot-folder' : 'not Library material: only books/, projects/ and archive/ are taken' });
  }
  scan.roots.push(...rootsIn(root, 'books', 'book', scan));
  scan.roots.push(...rootsIn(root, 'projects', 'project', scan));
  scan.roots.push(...rootsIn(root, 'archive', 'archived-book', scan, ['projects']));
  scan.roots.push(...rootsIn(root, 'archive/projects', 'archived-project', scan));
  for (const sourceRoot of scan.roots) walkRoot(root, sourceRoot, scan);
  // ONE ORDER, whatever the walk's stack visited first: a preview and the plan it is re-checked against read alike.
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  scan.roots.sort((a, b) => byName(a.root, b.root));
  scan.files.sort((a, b) => byName(a.relative, b.relative));
  scan.skipped.sort((a, b) => byName(a.path, b.path));
  scan.refused.sort((a, b) => byName(a.path, b.path));
  return scan;
}

/** The root a collection-relative path sits in, or null when it sits in none. */
export function rootOfPath(relative: string): string | null {
  const parts = relative.split('/');
  if (parts[0] === 'archive' && parts[1] === 'projects') return parts.length > 3 ? parts.slice(0, 3).join('/') : null;
  if (['books', 'projects', 'archive'].includes(parts[0]!)) return parts.length > 2 ? parts.slice(0, 2).join('/') : null;
  return null;
}

/** A root, from its collection-relative spelling. */
export function sourceRootOf(root: string): SourceRoot | null {
  const parts = root.split('/');
  if (parts.length === 3 && parts[0] === 'archive' && parts[1] === 'projects' && SLUG.test(parts[2]!)) return { root, kind: 'archived-project', slug: parts[2]! };
  if (parts.length !== 2 || !SLUG.test(parts[1]!)) return null;
  if (parts[0] === 'books') return { root, kind: 'book', slug: parts[1]! };
  if (parts[0] === 'projects') return { root, kind: 'project', slug: parts[1]! };
  if (parts[0] === 'archive' && parts[1] !== 'projects') return { root, kind: 'archived-book', slug: parts[1]! };
  return null;
}

/**
 * THE LINKS THAT WILL DANGLE: every wikilink in a taken page whose target sits in a top-level folder the import
 * skips. Paths are preserved, so a link between two taken roots keeps working; one into `work/` or `_guild/` cannot.
 */
export function danglingLinks(scan: SourceScan): { count: number; folders: Record<string, number> } {
  const skippedFolders = scan.skipped.filter((skip) => /^[^/]+\/$/.test(skip.path)).map((skip) => skip.path.slice(0, -1));
  const folders: Record<string, number> = {};
  let count = 0;
  if (!skippedFolders.length) return { count, folders };
  for (const file of scan.files) {
    if (!file.relative.toLowerCase().endsWith('.md')) continue;
    for (const match of fs.readFileSync(file.full, 'utf8').matchAll(/\[\[([^\]|#]+)/g)) {
      const target = match[1]!.trim().replace(/\\/g, '/');
      const folder = skippedFolders.find((name) => target === name || target.startsWith(`${name}/`));
      if (folder === undefined) continue;
      count += 1;
      folders[folder] = (folders[folder] ?? 0) + 1;
    }
  }
  return { count, folders };
}

/** The catalog a root is listed in, the link target that names it, and the heading an unlisted one is filed under. */
export function catalogFor(root: SourceRoot): { catalog: string; target: string; defaultHeading: string } {
  switch (root.kind) {
    case 'book':
      return { catalog: 'books/README.md', target: `books/${root.slug}/wiki/_book`, defaultHeading: '## Open a Book' };
    case 'project':
      return { catalog: 'projects/README.md', target: `projects/${root.slug}/_project`, defaultHeading: '## Projects' };
    case 'archived-book':
      return { catalog: 'archive/README.md', target: `archive/${root.slug}/wiki/_book`, defaultHeading: '## Archived Books' };
    default:
      return { catalog: 'archive/projects/README.md', target: `archive/projects/${root.slug}/_project`, defaultHeading: '## Projects' };
  }
}

/**
 * The line a SOURCE catalog lists a root under, and its heading, or null when the root is uncatalogued (Eric's
 * `archive/blog`). The line is the source's own, title and summary as it wrote them (Fable #9).
 */
export function sourceCatalogLine(storage: string, root: SourceRoot): { line: string; heading: string } | null {
  const { catalog, target } = catalogFor(root);
  const file = path.join(storage, ...catalog.split('/'));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const owned = ownedLines(readUtf8(file), [target]);
  const first = owned[0];
  if (first === undefined) return null;
  return { line: first.line.trimEnd(), heading: first.heading ?? catalogFor(root).defaultHeading };
}

/** A root's own page: `wiki/_book.md` for a Book, `_project.md` for a Hub. */
export function rootPage(root: SourceRoot): string {
  return root.kind === 'book' || root.kind === 'archived-book' ? `${root.root}/wiki/_book.md` : `${root.root}/_project.md`;
}

/** The first `# ` heading of a page outside its frontmatter, or null. */
export function firstHeadingOf(text: string): string | null {
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(splitLocalFrontmatter(text).body);
  return match ? match[1]!.trim() : null;
}

/** A root's publication state as its own page records it, or null when it records none (the legacy spellings read). */
export function rootPublicationState(storage: string, root: SourceRoot): { state: string | null; legacy: boolean } | null {
  if (root.kind === 'project' || root.kind === 'archived-project') return null;
  const file = path.join(storage, ...rootPage(root).split('/'));
  if (!fs.existsSync(file)) return { state: null, legacy: false };
  const fields = splitLocalFrontmatter(readUtf8(file)).fields;
  return { state: localPublicationState(fields), legacy: fields !== null && !fields.has('publication_state') && fields.has('guild_state') };
}

// --- the import record ---------------------------------------------------------------------------------------

export const IMPORT_RECORD = 'imports.md';

export interface ImportRecord {
  schema: number;
  source: string;
  imports: Record<string, PsJsonValue>[];
  files: Record<string, string>;
}

const RECORD_HEAD =
  '# Imports\n\n' +
  'The record `library basic-memory import` keeps of what it brought into this collection from a Basic Memory ' +
  "server's storage folder: each file's path and its SHA-256 at the time it was imported. A re-import compares " +
  'both sides against it to say which side changed a file. It is written by the import alone; edit it and a ' +
  're-import can no longer tell your changes from the source\'s.\n\n';

export function importRecordPath(workspace: string): string {
  return path.join(workspace, 'collection', IMPORT_RECORD);
}

/** The record, or an empty one when there has been no import. A record that does not parse is a refusal. */
export function readImportRecord(workspace: string): ImportRecord {
  const file = importRecordPath(workspace);
  if (!fs.existsSync(file)) return { schema: 1, source: '', imports: [], files: {} };
  const match = /```json\r?\n([\s\S]*?)\r?\n```/.exec(readUtf8(file));
  let parsed: unknown = null;
  try {
    parsed = match ? JSON.parse(match[1]!) : null;
  } catch {
    parsed = null;
  }
  const files = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['files'] : undefined;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(
      `The import record ${file} carries no readable JSON block, so a re-import cannot tell which side changed a file. Restore it ` +
        'from the Library\'s history, or move it aside to start the record again -- every file then reads as new.',
    );
  }
  const record = parsed as Record<string, unknown>;
  return {
    schema: Number(record['schema'] ?? 1),
    source: String(record['source'] ?? ''),
    imports: Array.isArray(record['imports']) ? (record['imports'] as Record<string, PsJsonValue>[]) : [],
    files: Object.fromEntries(Object.entries(files as Record<string, unknown>).map(([key, value]) => [key, String(value)])),
  };
}

/** The record, written whole: its prose head and its one JSON block, files sorted so a diff reads. */
export function writeImportRecord(workspace: string, record: ImportRecord): void {
  const files: Record<string, PsJsonValue> = {};
  for (const key of Object.keys(record.files).sort()) files[key] = record.files[key]!;
  const body = psConvertToJson({ schema: record.schema, source: record.source, imports: record.imports, files } as PsJsonValue).replace(/\r\n/g, '\n');
  writeAtomicText(importRecordPath(workspace), `${RECORD_HEAD}\`\`\`json\n${body}\n\`\`\`\n`);
}

// --- one file, against both sides ------------------------------------------------------------------------------

export type ImportAction = 'add' | 'update' | 'same' | 'keep-local' | 'conflict' | 'removed-there' | 'local-only' | 'gone';

/**
 * PLAN-basic-memory.md step 4's table, one file at a time. `recorded` is the file's SHA-256 at the last import, or
 * null when no import brought it; `local` is the Library's copy now, or null when it has none.
 *
 *   source vs record   local vs record   result
 *   changed            unchanged         update (updated here)
 *   unchanged          changed           keep-local (kept as yours) -- a local deletion included
 *   changed            changed           conflict -- unless both now agree, which is `same`
 *   new                absent            add
 *   new                present           conflict -- unless it is already identical, which is `same`
 *   removed            unchanged         removed-there (kept here: import never deletes)
 *   removed            changed           conflict (kept here, and named)
 *   removed            absent            gone -- from both sides; the record forgets it
 *   never there        present           local-only -- this Library's own file
 */
export function classify(source: string | null, local: string | null, recorded: string | null): ImportAction {
  if (source === null) {
    if (recorded === null) return local === null ? 'gone' : 'local-only';
    if (local === null) return 'gone';
    return local === recorded ? 'removed-there' : 'conflict';
  }
  if (recorded === null) return local === null ? 'add' : local === source ? 'same' : 'conflict';
  const sourceChanged = source !== recorded;
  const localChanged = local !== recorded;
  if (!sourceChanged && !localChanged) return 'same';
  if (sourceChanged && !localChanged) return 'update';
  if (!sourceChanged && localChanged) return 'keep-local';
  return local === source ? 'same' : 'conflict';
}

/** A local file's SHA-256, or null when the Library has none at that path. */
export function localSha(workspace: string, relative: string): string | null {
  const file = path.join(workspace, 'collection', ...relative.split('/'));
  return fs.existsSync(file) && fs.statSync(file).isFile() ? sha256OfBytes(fs.readFileSync(file)) : null;
}

/** Every root the Library itself holds, as the four catalog folders lay them out, whatever brought them. */
export function localRoots(workspace: string): SourceRoot[] {
  const collection = path.join(workspace, 'collection');
  const found: SourceRoot[] = [];
  const add = (folder: string, kind: RootKind, except: string[] = []) => {
    const directory = path.join(collection, ...folder.split('/'));
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SLUG.test(entry.name) || except.includes(entry.name)) continue;
      found.push({ root: `${folder}/${entry.name}`, kind, slug: entry.name });
    }
  };
  add('books', 'book');
  add('projects', 'project');
  add('archive', 'archived-book', ['projects']);
  add('archive/projects', 'archived-project');
  return found.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

/** Every file under one local root, collection-relative. */
export function localFilesUnder(workspace: string, root: string): string[] {
  const directory = path.join(workspace, 'collection', ...root.split('/'));
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const at = pending.pop()!;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) found.push(path.relative(path.join(workspace, 'collection'), full).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

// --- the two sides against the record, root by root ------------------------------------------------------------

export type RootState = 'only-there' | 'only-here' | 'same' | 'differ' | 'root-conflict' | 'adopt' | 'gone';
export type Side = 'there' | 'here' | 'both';

export interface FileRow {
  path: string;
  root: string;
  source: string | null;
  local: string | null;
  recorded: string | null;
  action: ImportAction | 'root-conflict';
}

export interface RootRow {
  root: string;
  kind: RootKind;
  slug: string;
  there: boolean;
  here: boolean;
  /** Whether any import has recorded a file of this root. */
  recorded: boolean;
  state: RootState;
  /** Whether an import would ADD this root, and so its catalog line: new this run, or left pending by a crashed one. */
  added: boolean;
  /** Which side changed, for a root that differs. */
  changed: Side | null;
  reason: string | null;
  files: number;
}

export interface Comparison {
  roots: RootRow[];
  files: FileRow[];
}

const SIDE: Partial<Record<ImportAction, Side>> = {
  add: 'there',
  update: 'there',
  'removed-there': 'there',
  'keep-local': 'here',
  'local-only': 'here',
  conflict: 'both',
};

function kindWord(kind: RootKind): string {
  return kind === 'project' || kind === 'archived-project' ? 'Hub' : 'Book';
}

/**
 * Every root either side holds, or the record remembers, compared file by file (PLAN-basic-memory.md steps 3 and
 * 4). Reads only.
 *
 * A ROOT HERE THAT NO IMPORT BROUGHT -- a Book published locally, a Hub made here -- under a slug the source also
 * has is ONE root-level conflict, never merged file by file: two unrelated Books that happen to share a name are
 * not two versions of one. The one exception is a root identical file for file, with nothing of its own added,
 * which is ADOPTED into the record: nothing is written, and a record moved aside can be rebuilt that way. A Hub the
 * import would add under a slug a seat is bound to is a root-level conflict too.
 *
 * `pendingAdded` names the roots a crashed import was adding: they are not "here, unbrought" but half-brought, so
 * they compare file by file and still count as added, which is what gets their catalog line written on the re-run.
 */
export function compareWithSource(
  workspace: string,
  scan: SourceScan,
  record: ImportRecord,
  options: { pendingAdded?: string[]; boundProjects?: Map<string, string> } = {},
): Comparison {
  const pending = new Set(options.pendingAdded ?? []);
  const bound = options.boundProjects ?? new Map<string, string>();
  const sourceFiles = new Map<string, SourceFile[]>();
  for (const file of scan.files) sourceFiles.set(file.root, [...(sourceFiles.get(file.root) ?? []), file]);
  const recordedPaths = new Map<string, string[]>();
  for (const recordedPath of Object.keys(record.files)) {
    const root = rootOfPath(recordedPath);
    if (root !== null) recordedPaths.set(root, [...(recordedPaths.get(root) ?? []), recordedPath]);
  }
  const sourceRoots = new Map(scan.roots.map((root) => [root.root, root]));
  const hereRoots = new Map(localRoots(workspace).map((root) => [root.root, root]));
  const all = [...new Set([...sourceRoots.keys(), ...hereRoots.keys(), ...recordedPaths.keys()])].sort();

  const roots: RootRow[] = [];
  const files: FileRow[] = [];
  for (const name of all) {
    const described = sourceRoots.get(name) ?? hereRoots.get(name) ?? sourceRootOf(name);
    if (described === null) continue;
    const there = sourceRoots.has(name);
    const here = hereRoots.has(name);
    const recorded = recordedPaths.has(name);
    const fromSource = sourceFiles.get(name) ?? [];
    const row: RootRow = { root: name, kind: described.kind, slug: described.slug, there, here, recorded, state: 'same', added: false, changed: null, reason: null, files: fromSource.length };
    const rootConflict = (reason: string) => {
      row.state = 'root-conflict';
      row.reason = reason;
      for (const file of fromSource) files.push({ path: file.relative, root: name, source: file.sha256, local: localSha(workspace, file.relative), recorded: null, action: 'root-conflict' });
    };

    if (there && !recorded && !pending.has(name)) {
      if (!here) {
        const seat = described.kind === 'project' ? bound.get(described.slug) : undefined;
        if (seat !== undefined) {
          rootConflict(`seat '${seat}' is bound to a Project of this slug, so a Hub imported under it would be that seat's without its say`);
        } else {
          row.state = 'only-there';
          row.added = true;
          for (const file of fromSource) files.push({ path: file.relative, root: name, source: file.sha256, local: null, recorded: null, action: 'add' });
        }
      } else {
        const localPaths = localFilesUnder(workspace, name);
        const sourcePaths = new Set(fromSource.map((file) => file.relative));
        const identical = fromSource.every((file) => localSha(workspace, file.relative) === file.sha256) && localPaths.every((local) => sourcePaths.has(local));
        if (identical) {
          row.state = 'adopt';
          for (const file of fromSource) files.push({ path: file.relative, root: name, source: file.sha256, local: file.sha256, recorded: null, action: 'same' });
        } else {
          rootConflict(`a ${kindWord(described.kind)} of this slug is already here, and no import brought it`);
        }
      }
      roots.push(row);
      continue;
    }

    // FILE BY FILE, over everything either side or the record names under this root.
    const bySource = new Map(fromSource.map((file) => [file.relative, file.sha256]));
    const paths = [...new Set([...bySource.keys(), ...localFilesUnder(workspace, name), ...(recordedPaths.get(name) ?? [])])].sort();
    const sides = new Set<Side>();
    let moving = 0;
    for (const filePath of paths) {
      const source = bySource.get(filePath) ?? null;
      const local = localSha(workspace, filePath);
      const recordedSha = record.files[filePath] ?? null;
      const action = classify(source, local, recordedSha);
      files.push({ path: filePath, root: name, source, local, recorded: recordedSha, action });
      const side = SIDE[action];
      if (side !== undefined) {
        sides.add(side);
        moving += 1;
      }
    }
    row.added = pending.has(name) && there;
    if (!there && !here) row.state = 'gone';
    else if (!there) row.state = 'only-here';
    else if (!here) row.state = 'only-there';
    else row.state = moving === 0 ? 'same' : 'differ';
    if (moving > 0) row.changed = sides.has('both') || (sides.has('there') && sides.has('here')) ? 'both' : sides.has('there') ? 'there' : 'here';
    roots.push(row);
  }
  return { roots, files };
}
