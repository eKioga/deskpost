/**
 * `library basic-memory import`: a Basic Memory collection's storage folder brought into this Library's
 * `collection/` (PLAN-basic-memory.md step 4, ledger 1-4, ruling B2). For Eric this is the migration route.
 *
 *   library basic-memory import --preflight | --dry-run
 *   library basic-memory import --user-confirmed --plan-id <id> [--lock-timeout <s>]
 *
 * THE SOURCE IS READ, NEVER WRITTEN, and enumerated from disk (bmsource.ts). Basic Memory itself is not called.
 *
 * RE-RUNNABLE, NEVER OVERWRITING WORK (B2). Every file is judged by step 4's table against the import record, so a
 * re-import updates only what the source changed and this Library did not, keeps what this Library changed, and
 * names a file both changed as a conflict and leaves it. A root here that no import brought is ONE root-level
 * conflict (bmsource.ts). Nothing is ever deleted: a file the source dropped is `removed there` and kept here.
 *
 * THE PLAN IS WHAT THE YES APPROVES. `plan_id` hashes the sorted list of (path, source sha, local sha or absent,
 * action); the confirmed run recomputes it under the locks and refuses a mismatch. The source is live, so each file
 * is ALSO re-hashed as it is read for the write, and one that changed since is skipped and named -- never written
 * from a stale plan.
 *
 * A CRASH IS FINISHED BY RUNNING AGAIN. Before the first write the plan is journalled at
 * `internal/import-journals/<plan_id>.json`, `pending`. Writes are atomic per file, so after a crash each file holds
 * its old content or its new one, and the re-run's table reads the new ones as `same` (the three-state rule). The
 * journal's `added_roots` are what keep those half-brought roots from reading as "here, and no import brought it",
 * and what still gets their catalog lines written. THE RECORD IS WRITTEN LAST, from the finished list.
 *
 * CATALOGS ARE MERGED, NEVER REGENERATED (Fable #9). A line is added only for a root this run adds (or a crashed
 * run was adding), taken whole from the source's catalog under the source's heading; an uncatalogued root is filed
 * under its catalog's default heading with its root page's title. No line is ever removed or rewritten.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { writeAtomicBytes, writeAtomicText } from './fsx.ts';
import { withBookLocks, type BookLock } from './locks.ts';
import { markerConnection } from './basicmemory.ts';
import { readSeatRegistry } from './desk.ts';
import { readUtf8 } from './shelfbook.ts';
import { rebuildCollectionManifestHeld } from './collectionbooks.ts';
import { runDoctor } from './doctor.ts';
import { programRoot } from './programroot.ts';
import {
  ensureHeading,
  insertUnderHeading,
  LOCAL_ARCHIVE_CATALOG_TEXT,
  LOCAL_ARCHIVED_PROJECTS_CATALOG_TEXT,
  LOCAL_BOOKS_CATALOG_TEXT,
  LOCAL_PROJECTS_CATALOG_TEXT,
  ownedLines,
  readCatalogOrTemplate,
  writeCatalog,
} from './localcatalog.ts';
import {
  catalogFor,
  compareWithSource,
  danglingLinks,
  firstHeadingOf,
  localSha,
  readImportRecord,
  rootPage,
  rootPublicationState,
  scanSource,
  sourceCatalogLine,
  writeImportRecord,
  type Comparison,
  type FileRow,
  type RootKind,
  type SourceScan,
} from './bmsource.ts';

class ImportRefusal extends Error {}

function refuse(message: string): never {
  throw new ImportRefusal(message);
}

const KIND_LABEL: Record<RootKind, [string, string]> = {
  book: ['Book', 'Books'],
  project: ['Project', 'Projects'],
  'archived-book': ['archived Book', 'archived Books'],
  'archived-project': ['archived Project', 'archived Projects'],
};

function counted(count: number, kind: RootKind): string {
  return `${count} ${KIND_LABEL[kind][count === 1 ? 0 : 1]}`;
}

const CATALOG_TEMPLATES: Record<string, string> = {
  'books/README.md': LOCAL_BOOKS_CATALOG_TEXT,
  'projects/README.md': LOCAL_PROJECTS_CATALOG_TEXT,
  'archive/README.md': LOCAL_ARCHIVE_CATALOG_TEXT,
  'archive/projects/README.md': LOCAL_ARCHIVED_PROJECTS_CATALOG_TEXT,
};

/** The fixed locks every import takes, beside one per root it writes (Fable #8; the S52 kickoff). */
const CATALOG_LOCKS = ['collection/archive', 'collection/books', 'collection/projects'];

// --- the journal --------------------------------------------------------------------------------------------

export interface ImportJournal {
  schema: number;
  plan_id: string;
  state: 'pending' | 'complete' | 'superseded';
  started_at: string;
  storage: string;
  added_roots: string[];
  writes: { path: string; source_sha256: string }[];
}

function journalDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'import-journals');
}

function writeJournal(workspace: string, journal: ImportJournal): void {
  writeAtomicText(path.join(journalDirectory(workspace), `${journal.plan_id}.json`), psConvertToJson(journal as unknown as PsJsonValue) + '\n');
}

/** Every journal an import left `pending`: a run that crashed, or was stopped, between its first write and its record. */
export { boundProjects };

export function unfinishedImportJournals(workspace: string): ImportJournal[] {
  const directory = journalDirectory(workspace);
  if (!fs.existsSync(directory)) return [];
  const found: ImportJournal[] = [];
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const journal = JSON.parse(readUtf8(path.join(directory, name))) as ImportJournal;
      if (journal.state === 'pending') found.push({ ...journal, added_roots: Array.isArray(journal.added_roots) ? journal.added_roots.map(String) : [] });
    } catch {
      refuse(`The import journal internal/import-journals/${name} does not parse, so an interrupted import cannot be finished safely. Inspect it before importing again.`);
    }
  }
  return found;
}

// --- the plan ------------------------------------------------------------------------------------------------

interface ImportPlan {
  storage: string;
  scan: SourceScan;
  comparison: Comparison;
  planId: string;
  pendingAdded: string[];
  writes: FileRow[];
  lockRoots: string[];
}

export function importPlanId(files: FileRow[]): string {
  const lines = files
    .map((file) => `${file.path}\t${file.source ?? 'absent'}\t${file.local ?? 'absent'}\t${file.action}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256OfText(lines.join('\n'));
}

function boundProjects(workspace: string): Map<string, string> {
  const bound = new Map<string, string>();
  for (const entry of readSeatRegistry(path.join(workspace, '.claude'))) bound.set(entry.project, entry.seat);
  return bound;
}

function buildPlan(workspace: string): ImportPlan {
  const connection = markerConnection(workspace);
  if (connection === null) refuse('This Library has no Basic Memory connection, so there is nothing to import from. Connect one with `library basic-memory setup`.');
  if (!connection.storage) {
    refuse(
      "Import reads the Basic Memory collection's storage folder, and this connection names none. Add it with " +
        '`library basic-memory setup --storage <folder>`; status and opening a shared Book work without it.',
    );
  }
  const storage = path.resolve(connection.storage);
  const collection = path.resolve(workspace, 'collection');
  const inside = (child: string, parent: string) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + path.sep);
  if (inside(storage, collection) || inside(collection, storage)) refuse(`The storage folder ${storage} and this Library's collection ${collection} overlap; an import would read what it writes.`);
  let scan: SourceScan;
  try {
    scan = scanSource(storage);
  } catch (error) {
    refuse(`Nothing was imported. ${(error as Error).message}`);
  }
  const record = readImportRecord(workspace);
  // ONE SOURCE PER RECORD (S53 post-build inspection #4). A record or an unfinished journal made from another storage
  // folder would read its roots as half-brought from this one, and its files as changed there: a wrong merge.
  const same = (other: string) => path.resolve(other).toLowerCase() === storage.toLowerCase();
  if (record.source && !same(record.source)) {
    refuse(
      `The import record names another storage folder (${record.source}) than this connection's (${storage}), so it cannot say which side ` +
        'changed a file. Point the connection back at that folder, or move collection/imports.md aside to start a new record.',
    );
  }
  const unfinished = unfinishedImportJournals(workspace);
  const foreign = unfinished.filter((journal) => journal.storage && !same(journal.storage));
  if (foreign.length) {
    refuse(`An unfinished import from another storage folder (${foreign[0]!.storage}) is pending; finish it from that folder first, or inspect internal/import-journals/${foreign[0]!.plan_id}.json.`);
  }
  const pendingAdded = [...new Set(unfinished.flatMap((journal) => journal.added_roots))].sort();
  const comparison = compareWithSource(workspace, scan, record, { pendingAdded, boundProjects: boundProjects(workspace) });
  const writes = comparison.files.filter((file) => file.action === 'add' || file.action === 'update');
  // Adopted roots are locked too: their Discovery manifest is rebuilt (S53 post-build inspection #5).
  const adopted = comparison.roots.filter((row) => row.state === 'adopt').map((row) => row.root);
  const lockRoots = [...new Set([...CATALOG_LOCKS, ...writes.map((file) => file.root), ...adopted])].sort();
  return { storage, scan, comparison, planId: importPlanId(comparison.files), pendingAdded, writes, lockRoots };
}

function namesBy(files: FileRow[], action: string): string[] {
  return files.filter((file) => file.action === action).map((file) => file.path);
}

/** The preview: what the yes approves, in the words the plan's screen uses. Writes nothing. */
function describePlan(plan: ImportPlan, workspace: string): Record<string, PsJsonValue> {
  const { scan, comparison } = plan;
  const added = comparison.roots.filter((row) => row.added);
  const byKind = (kind: RootKind) => added.filter((row) => row.kind === kind).length;
  const addFiles = comparison.files.filter((file) => file.action === 'add').length;
  const rootConflicts = comparison.roots.filter((row) => row.state === 'root-conflict');
  const adopted = comparison.roots.filter((row) => row.state === 'adopt');
  const dangling = danglingLinks(scan);
  const unstated: string[] = [];
  const legacy: string[] = [];
  const copying: string[] = [];
  // Named for the roots this run brings: a root it skips is not arriving with or without a state.
  const arriving = new Set(added.map((row) => row.root));
  for (const root of scan.roots.filter((candidate) => arriving.has(candidate.root))) {
    const state = rootPublicationState(scan.storage, root);
    if (state === null) continue;
    if (state.state === null) unstated.push(root.root);
    else if (state.legacy) legacy.push(root.root);
    if (state.state === 'copying') copying.push(root.root);
  }
  const uncatalogued = added.filter((row) => {
    const source = scan.roots.find((root) => root.root === row.root);
    return source !== undefined && sourceCatalogLine(scan.storage, source) === null;
  });
  const topSkipped = scan.skipped.filter((skip) => /^[^/]+\/$/.test(skip.path)).map((skip) => skip.path);

  const kinds: RootKind[] = ['book', 'project', 'archived-book', 'archived-project'];
  const newLine = kinds.filter((kind) => byKind(kind) > 0).map((kind) => counted(byKind(kind), kind));
  const updates = namesBy(comparison.files, 'update');
  const kept = namesBy(comparison.files, 'keep-local');
  const conflicts = namesBy(comparison.files, 'conflict');
  const removedThere = namesBy(comparison.files, 'removed-there');
  const notes: string[] = [];
  if (unstated.length) notes.push(`${unstated.length} ${unstated.length === 1 ? 'Book has' : 'Books have'} no publication state (imported as-is: ${unstated.join(', ')})`);
  if (legacy.length) notes.push(`${legacy.length} ${legacy.length === 1 ? 'Book records' : 'Books record'} only the legacy guild_state (${legacy.join(', ')})`);
  if (copying.length) notes.push(`${copying.length} ${copying.length === 1 ? 'Book is' : 'Books are'} still 'copying' at the source, imported and flagged (${copying.join(', ')})`);
  for (const row of uncatalogued) {
    const source = scan.roots.find((root) => root.root === row.root)!;
    const title = firstHeadingOf(fs.existsSync(path.join(scan.storage, ...rootPage(source).split('/'))) ? readUtf8(path.join(scan.storage, ...rootPage(source).split('/'))) : '') ?? source.slug;
    notes.push(`${row.root} is uncatalogued at the source (title '${title}' from its ${path.posix.basename(rootPage(source))})`);
  }
  if (adopted.length) notes.push(`${adopted.length} root(s) already here, identical, adopted into the record without a write (${adopted.map((row) => row.root).join(', ')})`);
  if (plan.pendingAdded.length) notes.push(`an earlier import did not finish; this run finishes it (${plan.pendingAdded.length} root(s) it was adding)`);

  const summary = [
    `Import from ${scan.storage} into ${path.join(workspace, 'collection')}`,
    `  New        ${newLine.length ? newLine.join(', ') : 'nothing'}   (${addFiles} file${addFiles === 1 ? '' : 's'})`,
  ];
  if (updates.length || kept.length) summary.push(`  Changed    ${updates.length} updated here · ${kept.length} kept as yours`);
  if (conflicts.length || rootConflicts.length) summary.push(`  Conflicts  ${conflicts.length} file(s) changed on both sides · ${rootConflicts.length} root(s) already here: skipped and named`);
  if (removedThere.length) summary.push(`  Removed    ${removedThere.length} file(s) removed there, kept here (import never deletes)`);
  summary.push(`  Skipped    ${topSkipped.length ? topSkipped.join(' ') : 'nothing'}` + (dangling.count ? `   · ${dangling.count} link${dangling.count === 1 ? '' : 's'} into them will dangle` : ''));
  if (scan.refused.length) summary.push(`  Refused    ${scan.refused.length} symlink(s) or junction(s), never followed: ${scan.refused.map((item) => item.path).join(', ')}`);
  if (notes.length) summary.push(`  Notes      ${notes.join(' · ')}`);

  return {
    schema: 1,
    operation: 'Import from Basic Memory',
    source: scan.storage,
    destination: path.join(workspace, 'collection'),
    plan_id: plan.planId,
    added_roots: added.map((row) => row.root),
    counts: {
      new_roots: added.length,
      files_to_add: addFiles,
      files_to_update: updates.length,
      unchanged: namesBy(comparison.files, 'same').length,
      kept_as_yours: kept.length,
      conflicts: conflicts.length,
      root_conflicts: rootConflicts.length,
      removed_there: removedThere.length,
      local_only: namesBy(comparison.files, 'local-only').length,
      taken_files: scan.files.length,
    },
    updates,
    kept_as_yours: kept,
    conflicts,
    root_conflicts: rootConflicts.map((row) => ({ root: row.root, reason: row.reason ?? '' })),
    removed_there: removedThere,
    skipped: scan.skipped.map((skip) => ({ path: skip.path, reason: skip.reason })),
    refused: scan.refused.map((item) => ({ path: item.path, reason: item.reason })),
    dangling_links: { count: dangling.count, by_folder: dangling.folders },
    no_publication_state: unstated,
    legacy_guild_state: legacy,
    copying,
    uncatalogued: uncatalogued.map((row) => row.root),
    adopted: adopted.map((row) => row.root),
    summary,
    source_write: false,
    shared_library_write: false,
  };
}

// --- the confirmed run ---------------------------------------------------------------------------------------

/** The catalog line for one added root: the source's own under its heading, or a made one under the default. */
function mergeCatalogLines(workspace: string, plan: ImportPlan, roots: string[]): string[] {
  const added: string[] = [];
  const collection = path.join(workspace, 'collection');
  const byCatalog = new Map<string, { target: string; line: string; heading: string }[]>();
  for (const name of roots) {
    const source = plan.scan.roots.find((root) => root.root === name);
    if (source === undefined || !fs.existsSync(path.join(collection, ...name.split('/')))) continue;
    const { catalog, target, defaultHeading } = catalogFor(source);
    const listed = sourceCatalogLine(plan.storage, source);
    let entry = listed;
    if (entry === null) {
      const page = path.join(plan.storage, ...rootPage(source).split('/'));
      const title = (fs.existsSync(page) ? firstHeadingOf(readUtf8(page)) : null) ?? source.slug;
      entry = { line: `- [[${target}|${title}]]`, heading: defaultHeading };
    }
    byCatalog.set(catalog, [...(byCatalog.get(catalog) ?? []), { target, ...entry }]);
  }
  for (const [catalog, entries] of [...byCatalog.entries()].sort()) {
    const file = path.join(collection, ...catalog.split('/'));
    let text = readCatalogOrTemplate(file, CATALOG_TEMPLATES[catalog]!).text;
    let changed = false;
    // Reversed, because each line goes directly under its heading: the source's order is kept.
    for (const entry of [...entries].reverse()) {
      if (ownedLines(text, [entry.target]).length > 0) continue;
      text = ensureHeading(text, entry.heading, null).text;
      text = insertUnderHeading(text, entry.heading, entry.line);
      changed = true;
      added.push(`${catalog}: ${entry.line}`);
    }
    if (changed) writeCatalog(file, text);
  }
  return added.sort();
}

function localDateTime(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function applyImport(workspace: string, planId: string, timeoutSeconds: number): Record<string, PsJsonValue> {
  const outline = buildPlan(workspace);
  if (outline.planId !== planId) {
    refuse(`The import plan changed since its preview (it is now ${outline.planId}). Nothing was written. Review the new preview with --preflight and confirm that one.`);
  }
  const fault = Number((process.env['LIBRARY_IMPORT_FAULT_AFTER'] ?? '').trim() || NaN);
  return withBookLocks(workspace, outline.lockRoots, timeoutSeconds, (locks: BookLock[]) => {
    // RE-PLANNED UNDER THE LOCKS: the preview and the outline above ran with nobody excluded.
    const plan = buildPlan(workspace);
    if (plan.planId !== planId) refuse(`The import plan changed while its locks were being taken (it is now ${plan.planId}). Nothing was written. Preview it again.`);
    const preview = describePlan(plan, workspace);
    const addedRoots = plan.comparison.roots.filter((row) => row.added).map((row) => row.root);
    const journal: ImportJournal = {
      schema: 1,
      plan_id: planId,
      state: 'pending',
      started_at: new Date().toISOString(),
      storage: plan.storage,
      added_roots: addedRoots,
      writes: plan.writes.map((file) => ({ path: file.path, source_sha256: file.source! })),
    };
    writeJournal(workspace, journal);
    // TWO FIXTURE SWITCHES, for kernel self-test section 43 and nothing else, as migrate's --fault-after is:
    // LIBRARY_IMPORT_PAUSE_BEFORE_WRITES_MS holds the run between its journal and its first write, so a source file
    // can be changed in the one window only the re-hash guards; LIBRARY_IMPORT_FAULT_AFTER (below) crashes it.
    const pause = Number((process.env['LIBRARY_IMPORT_PAUSE_BEFORE_WRITES_MS'] ?? '').trim() || 0);
    if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pause, 60000));

    const collection = path.join(workspace, 'collection');
    const changedSincePreview: string[] = [];
    const changedHereSincePreview: string[] = [];
    const written = new Set<string>();
    let count = 0;
    for (const file of plan.writes) {
      const bytes = fs.readFileSync(path.join(plan.storage, ...file.path.split('/')));
      if (sha256OfBytes(bytes) !== file.source) {
        changedSincePreview.push(file.path);
        continue;
      }
      // THE LOCAL SIDE IS RE-HASHED TOO (S53 post-build inspection #1): a sync client takes no Book lock, so an edit it
      // lands mid-run on a path planned as `update` or `add` would otherwise be overwritten. It is skipped and named, and
      // the record keeps what it said, so the next import judges it `keep-local` or a conflict.
      if (localSha(workspace, file.path) !== file.local) {
        changedHereSincePreview.push(file.path);
        continue;
      }
      const destination = path.join(collection, ...file.path.split('/'));
      writeAtomicBytes(destination, bytes);
      if (sha256OfBytes(fs.readFileSync(destination)) !== file.source) refuse(`${file.path} did not read back as written. The import stopped; run it again to finish it.`);
      written.add(file.path);
      count += 1;
      if (count === fault) throw new ImportRefusal(`FAULT INJECTED after ${count} file(s) were written (a real run never reaches this).`);
    }

    let catalogLines: string[];
    try {
      catalogLines = mergeCatalogLines(workspace, plan, [...new Set([...addedRoots, ...plan.pendingAdded])]);
    } catch (error) {
      refuse(
        `${written.size} file(s) were written and the import stopped at the catalogs: ${(error as Error).message} Its journal is left ` +
          'pending and the record unwritten, so nothing is lost: repair the catalog and run the import again to finish it.',
      );
    }

    // THE RECORD, LAST: every file both sides now agree on, at its source hash. A file skipped as changed since the
    // preview keeps what the record said, so the next import judges it afresh.
    const record = readImportRecord(workspace);
    for (const file of plan.comparison.files) {
      if (file.action === 'gone') delete record.files[file.path];
      else if (file.action === 'same' || ((file.action === 'add' || file.action === 'update') && written.has(file.path))) record.files[file.path] = file.source!;
    }
    const counts = preview['counts'] as Record<string, PsJsonValue>;
    record.schema = 1;
    record.source = plan.storage;
    record.imports.push({
      at: localDateTime(),
      plan_id: planId,
      source: plan.storage,
      added_roots: addedRoots.length,
      files_written: written.size,
      updated: Number(counts['files_to_update']),
      kept_as_yours: Number(counts['kept_as_yours']),
      conflicts: Number(counts['conflicts']) + Number(counts['root_conflicts']),
      changed_since_preview: changedSincePreview.length,
      changed_here_since_preview: changedHereSincePreview.length,
    });
    writeImportRecord(workspace, record);

    // The journal, and any a crashed run left, are finished.
    writeJournal(workspace, { ...journal, state: 'complete' });
    for (const earlier of unfinishedImportJournals(workspace)) writeJournal(workspace, { ...earlier, state: 'superseded' });

    // THE TOUCHED BOOKS' DISCOVERY MANIFESTS, rebuilt under the locks this run holds.
    const manifests: Record<string, PsJsonValue>[] = [];
    const touched = [...new Set([...[...written].map((file) => plan.writes.find((row) => row.path === file)!.root), ...plan.comparison.roots.filter((row) => row.state === 'adopt').map((row) => row.root)])].sort();
    for (const root of touched) {
      const [top, slug] = root.split('/');
      if (top !== 'books' && top !== 'archive') continue;
      if (root.startsWith('archive/projects/')) continue;
      const lock = locks.find((held) => held.bookRoot === root)!;
      const shelf = top === 'archive' ? 'archive' : 'active';
      const rebuilt = rebuildCollectionManifestHeld(workspace, shelf, slug!, lock, `library basic-memory import ${planId}`);
      manifests.push({ book_root: root, status: rebuilt.status, summary: rebuilt.summary });
    }

    return {
      ...preview,
      imported: true,
      files_written: written.size,
      changed_since_preview: changedSincePreview,
      changed_here_since_preview: changedHereSincePreview,
      catalog_lines_added: catalogLines,
      record: 'collection/imports.md',
      journal: `internal/import-journals/${planId}.json`,
      manifests,
      manifests_dirty: manifests.filter((row) => row['status'] === 'dirty').length,
    };
  });
}

export async function basicMemoryImport(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('basic-memory', 'import'));
  const preview = parsed.flags.has('preflight') || parsed.flags.has('dry-run');
  if (preview) {
    const plan = buildPlan(workspace);
    return { ...describePlan(plan, workspace), preview: true, dry_run: parsed.flags.has('dry-run'), confirmation_required: true };
  }
  const planId = (parsed.options.get('plan-id') ?? '').trim();
  if (!parsed.flags.has('user-confirmed') || !planId) {
    refuse('Import is not yet performed: review the preview with --preflight, then run it with --user-confirmed --plan-id <the preview\'s plan_id>.');
  }
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const result = applyImport(workspace, planId, Number.isFinite(timeout) && timeout > 0 ? timeout : 20);
  // AFTERWARDS, DOCTOR: every check that reads the reader's material, with the locks released.
  const doctor = runDoctor(['--workspace', workspace], programRoot());
  const report = (doctor.value ?? {}) as Record<string, PsJsonValue>;
  result['doctor'] = doctor.refusal !== null
    ? { status: 'refused', detail: doctor.refusal }
    : { exit_code: doctor.exitCode, failed: report['failed'] ?? null, warned: report['warned'] ?? null, checks: report['checks'] ?? null };
  return result;
}
