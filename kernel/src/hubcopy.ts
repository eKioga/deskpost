/**
 * `library hub copy-pages`: tools/Copy-LocalPagesToProject.ps1 as far as its preflight, step for step (S16's
 * Hub half, S35).
 *
 * THE PREFLIGHT SINCE S35, THE CONFIRMED COPY SINCE S39. `hub.local-pages-copy-into-a-project` holds the
 * preflight -- the plan, its two digests and its records -- and three `hub.local-pages-copy-confirmed-*` rows
 * hold the rest: a Hub created through New-ProjectHub when the plan said `create`, a read, compare and
 * no-overwrite write per record, a readback, and the completion journal under
 * `internal/publication-journals/` -- `complete`, or `incomplete` with the records it reached and the error.
 * Measured by the oracle's own run first: the journal is ConvertTo-Json's layout with no trailing newline,
 * and `-ReplaceExisting`, like the refresh's, is in neither the plan nor its `plan_id`.
 *
 * THE ORACLE'S ORDER: the write fence, the collection id, the slug, the destination rules, the local source
 * root (`Resolve-LocalSourceRoot`, with its Desk gate for a capture note), the files in `Sort-Object FullName`
 * order, `-IncludePage`, every composed target checked by `Assert-ProjectTargetSafe`, the two digests, and
 * then New-ProjectHub's own preflight, whose `action` is part of the plan and of its `plan_id`.
 *
 * WHAT THE MATRIX CANNOT SEE, AND WAS MEASURED BY HAND. The harness normalises every SHA-256 and the
 * `plan_id`, so the row compares their presence and not their value. The digests and the `plan_id` were
 * compared raw, oracle against kernel, over one workspace pinned to a disposable project (S35), for both a
 * new and an existing Hub; the file order was measured against `Sort-Object FullName` itself, and
 * `psSortCompare` is now that measured order.
 *
 * A LOCAL COLLECTION IS REFUSED. The oracle has no local half, and no row holds a local copy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { readMarker } from './workspace.ts';
import { sha256OfText } from './sha.ts';
import { psConvertToJson } from './psjson.ts';
import type { PsJsonValue } from './psjson.ts';
import { psSortCompare, readStrictUtf8 } from './notebook.ts';
import { assertShelfBookOpen, getCaptureBook, splitNoteFrontmatter } from './triage.ts';
import { McpSession, readExactOrNull, resolveCollectionId, resolveMcpUrl } from './basicmemory.ts';
import type { NoteRecord } from './basicmemory.ts';
import { assertCollectionWriteAllowed } from './ownership.ts';

class HubCopyRefusal extends Error {}

function refuse(message: string): never {
  throw new HubCopyRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `-in`, not `-cin`: a denylist, so the case-insensitive operator refuses MORE spellings, as the oracle's. */
const RESERVED_ROOT_PAGES = ['_project', 'connections', 'readme'];

/**
 * New-ProjectHub, handed in by collection.ts so this file does not import it back: its preflight's `action`,
 * or with `preflight` false the creation itself, whose result the oracle discards.
 */
export type HubPlanAction = (slug: string, title: string, purpose: string, nextActions: string[], preflight?: boolean) => Promise<string>;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/** Every value given for a repeatable option, in order: PowerShell's `[string[]]` parameters. */
function repeated(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${name}`) values.push(argv[i + 1]!);
  return values;
}

/** `Test-PathWithin`: `child` strictly inside `parent`, case-insensitively, as `OrdinalIgnoreCase`. */
function isWithin(child: string, parent: string): boolean {
  const parentPath = parent.replace(/[\\/]+$/, '') + path.sep;
  return child.toLowerCase().startsWith(parentPath.toLowerCase());
}

interface SourceRoot {
  kind: 'notebook' | 'capture-note';
  root: string;
  labelRoot: string;
}

/** `Resolve-LocalSourceRoot`: notebook/, or ONE note under a capture Book's wiki/notes/, and nothing else. */
function resolveLocalSourceRoot(workspace: string, sourcePath: string): SourceRoot {
  if (isBlank(sourcePath)) refuse('SourcePath is required.');
  const full = path.resolve(workspace, sourcePath);
  const notebookRoot = path.resolve(workspace, 'notebook');
  if (isWithin(full, notebookRoot)) return { kind: 'notebook', root: notebookRoot, labelRoot: 'notebook' };
  const shelfRoot = path.resolve(workspace, 'shelf');
  if (isWithin(full, shelfRoot)) {
    const relative = full.substring(shelfRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    // -cmatch: the segments are lowercase by rule.
    const match = /^([a-z0-9][a-z0-9-]*)\/wiki\/notes\/[^/]+\.md$/.exec(relative);
    if (match) {
      const slug = match[1]!;
      const book = getCaptureBook(workspace, slug);
      assertShelfBookOpen(workspace, slug, 'publishing one of its notes');
      return { kind: 'capture-note', root: path.resolve(book.notesPath), labelRoot: `shelf/${slug}/wiki/notes` };
    }
    refuse(
      `SourcePath '${sourcePath}' is under shelf/ but is not one note in a capture Book. Only 'shelf/<capture-book>/wiki/notes/<file>.md' ` +
        'can be published directly; a curated Shelf Book is published whole with -FromShelf.',
    );
  }
  refuse(`SourcePath '${sourcePath}' must name a file or folder inside notebook/, or one note under a capture Book's wiki/notes/.`);
}

/** `Get-ChildItem -Recurse -File`: every file below `directory`, full paths. */
function filesBelow(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** `Assert-ProjectTargetSafe`: the one rule for every composed target, on every route. */
function assertProjectTargetSafe(target: string, slug: string): void {
  const prefix = `projects/${slug}/`;
  if (!target.startsWith(prefix)) refuse(`Destination '${target}' is not under ${prefix}; a Project copy writes nowhere else.`);
  const relative = target.substring(prefix.length);
  if (isBlank(relative)) refuse(`Destination '${target}' names no page below ${prefix}.`);
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(relative)) refuse(`Destination '${target}' walks out of ${prefix} through a relative segment.`);
  if (!relative.includes('/') && RESERVED_ROOT_PAGES.includes(path.posix.parse(relative).name.toLowerCase())) {
    refuse(
      `Destination '${target}' is a Project root page. _project, connections and README belong to New-ProjectHub.ps1 and ` +
        'Edit-ProjectHub.ps1, which journal a previous body, hold the projects/<slug> lock and verify the readback; a copy does none of those.',
    );
  }
}

interface CopyRecord {
  source: string;
  path: string;
  content: string;
  sha256: string;
}

export async function hubCopyPages(argv: string[], workspace: string, hubPlanAction: HubPlanAction): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, [
    'source', 'title', 'purpose', 'next-action', 'include-page', 'destination-directory', 'plan-id', 'journal-path', 'workspace',
  ]);
  const slug = parsed.positional[0] ?? '';
  const sourcePath = parsed.options.get('source') ?? '';
  const title = parsed.options.get('title') ?? '';
  const purpose = parsed.options.get('purpose') ?? '';
  // THE MANDATORY PARAMETERS, which PowerShell's binder refuses before the script's body runs: an absent
  // or empty -SourcePath, -ProjectSlug, -Title or -Purpose. The binder's sentence is the host's, not the
  // helper's, so the kernel names the option instead; no row reaches one.
  for (const [name, value] of [['slug', slug], ['--source', sourcePath], ['--title', title], ['--purpose', purpose]] as const) {
    if (value === '') refuse(`library hub copy-pages needs ${name}: library hub copy-pages <slug> --source <path> --title <t> --purpose <p>.`);
  }
  const nextActions = repeated(argv, 'next-action');
  const includePages = repeated(argv, 'include-page');
  const atProjectRoot = parsed.flags.has('at-project-root');

  const marker = readMarker(workspace);
  if (marker !== null && String(marker['backend'] ?? '') === 'local') {
    refuse(
      'library hub copy-pages is ported against Basic Memory only, and this workspace uses its local collection: the ' +
        'oracle has no local half and no row holds a local copy. Nothing was copied.',
    );
  }
  resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'copying local pages to a Project Hub');
  const projectId = resolveCollectionId(workspace);
  if (!SLUG.test(slug)) refuse('ProjectSlug must use lowercase letters, digits, and single hyphens.');

  let destination = '';
  if (parsed.options.has('destination-directory')) {
    if (atProjectRoot) refuse('DestinationDirectory and AtProjectRoot both name the destination; pass one, not both.');
    destination = parsed.options.get('destination-directory')!.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (isBlank(destination)) refuse('DestinationDirectory must name at least one directory below projects/<slug>/.');
    for (const segment of destination.split('/')) {
      if (!SLUG.test(segment)) refuse(`DestinationDirectory segment '${segment}' must use lowercase letters, digits, and single hyphens.`);
    }
  }

  const local = resolveLocalSourceRoot(workspace, sourcePath);
  const sourceFull = path.resolve(workspace, sourcePath);
  if (!isWithin(sourceFull, local.root)) refuse(`SourcePath must be inside ${local.labelRoot}/.`);
  if (!fs.existsSync(sourceFull)) refuse(`Cannot find path '${sourceFull}' because it does not exist.`);
  const isContainer = fs.statSync(sourceFull).isDirectory();
  if (atProjectRoot && isContainer) {
    refuse('AtProjectRoot is available only when SourcePath names one Markdown file; a folder would scatter pages beside _project.');
  }
  let allFiles: string[];
  if (isContainer) {
    // `$_.Extension -eq '.md'`, case-insensitive; `Sort-Object FullName`, the measured culture order.
    allFiles = filesBelow(sourceFull)
      .filter((file) => path.extname(file).toLowerCase() === '.md')
      .sort(psSortCompare);
  } else {
    if (path.extname(sourceFull).toLowerCase() !== '.md') refuse('A Project-copy source must be Markdown.');
    allFiles = [sourceFull];
  }
  let files = allFiles;
  if (includePages.length) {
    if (!isContainer) refuse('IncludePage is available only when SourcePath names a Notebook folder.');
    const selected = new Set<string>();
    for (const page of includePages) {
      const normalized = page.trim().replace(/^[\\/]+/, '').replace(/\//g, '\\');
      if (!/\.md$/i.test(normalized)) refuse(`IncludePage '${page}' must name a Markdown file relative to SourcePath.`);
      const candidate = path.resolve(sourceFull, normalized);
      if (!isWithin(candidate, sourceFull) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        refuse(`IncludePage '${page}' is not an exact Markdown file below SourcePath.`);
      }
      selected.add(candidate);
    }
    // `ContainsKey` on a PowerShell hashtable: case-insensitive, so `A.md` selects `a.md`.
    const keys = new Set([...selected].map((key) => key.toLowerCase()));
    files = allFiles.filter((file) => keys.has(file.toLowerCase()));
  }
  if (files.length === 0) refuse('The selected source contains no Markdown articles.');
  const sourceName = isContainer ? path.basename(sourceFull) : path.parse(sourceFull).name;

  const records: CopyRecord[] = files.map((file) => {
    const relative = isContainer ? file.substring(sourceFull.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : path.basename(file);
    let content = readStrictUtf8(file);
    // A capture note's frontmatter is provenance, not prose: the Project record is a Basic Memory note with
    // frontmatter of its own.
    if (local.kind === 'capture-note') content = splitNoteFrontmatter(content).body;
    const target =
      `projects/${slug}/` +
      (destination ? `${destination}/${relative}` : isContainer ? `notes/${sourceName}/${relative}` : atProjectRoot ? relative : `notes/${relative}`);
    assertProjectTargetSafe(target, slug);
    // RELATIVE TO THE RESOLVED ROOT, not the leaf folder: the provenance label triage reads.
    const source = isContainer
      ? `${local.labelRoot}/${file.substring(local.root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`
      : sourcePath.replace(/\\/g, '/');
    return { source, path: target, content, sha256: sha256OfText(content) };
  });

  const sourceDigest = sha256OfText(records.map((record) => `${record.source}|${record.sha256}`).join('\n'));
  const manifestDigest = sha256OfText(records.map((record) => `${record.source}|${record.path}|${record.sha256}`).join('\n'));
  const projectAction = await hubPlanAction(slug, title, purpose, nextActions);
  const projectDetails = `${slug}|${title}|${purpose}|${nextActions.join('\n')}|${projectAction}`;
  const planId = 'project-copy-' + sha256OfText(`${sourceDigest}|${manifestDigest}|${projectDetails}`);
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Copy Local Pages to Project',
    project_id: projectId,
    project_slug: slug,
    project_action: projectAction,
    source: sourcePath,
    at_project_root: atProjectRoot,
    destination_directory: destination ? destination : '(default)',
    source_file_count: records.length,
    source_digest_sha256: sourceDigest,
    page_manifest_sha256: manifestDigest,
    plan_id: planId,
    planned_project_records: records.map((record) => ({ path: record.path, source_path: record.source, sha256: record.sha256 })),
    confirmation_required: true,
    shared_library_write: false,
  };
  if (parsed.flags.has('preflight')) return plan;
  if (!parsed.flags.has('user-confirmed')) refuse('Project copy is not yet performed: review the plan and rerun with -UserConfirmed.');
  if ((parsed.options.get('plan-id') ?? '') !== planId) {
    refuse('Project copy is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.');
  }

  // THE CONFIRMED HALF (S39), in the oracle's order. KEYED ON THE MANIFEST DIGEST, as the oracle keys it.
  const journalOption = parsed.options.get('journal-path') ?? '';
  const journalPath = isBlank(journalOption)
    ? path.join(workspace, 'internal', 'publication-journals', `project-${slug}-${manifestDigest}.json`)
    : path.resolve(journalOption);
  const replaceExisting = parsed.flags.has('replace-existing');
  const attempted: string[] = [];
  const created: string[] = [];
  const reused: string[] = [];
  const saveJournal = (state: string, errorText: string): void => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const journal: Record<string, PsJsonValue> = {
      state,
      copy_kind: 'project',
      // .NET's round-trip `o`: seven fractional digits.
      timestamp_utc: new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'),
      project_id: projectId,
      project_slug: slug,
      destination_directory: destination ? destination : '(default)',
      source_digest_sha256: sourceDigest,
      page_manifest_sha256: manifestDigest,
      approved_plan_id: planId,
      planned_records: records.map((record) => ({ path: record.path, source: record.source, sha256: record.sha256 })),
      attempted_records: [...attempted],
      created_records: [...created],
      reused_records: [...reused],
      error: errorText,
    };
    // `[IO.File]::WriteAllText` of ConvertTo-Json: no trailing newline.
    fs.writeFileSync(journalPath, psConvertToJson(journal), 'utf8');
  };
  let recordsVerified = false;
  try {
    if (projectAction === 'create') await hubPlanAction(slug, title, purpose, nextActions, false);
    const session = new McpSession(resolveMcpUrl(workspace), 'library-project-copy');
    await session.initialize();
    const words = { includeFrontmatter: false, stopped: 'Project copy stopped' };
    for (const expected of records) {
      const existing = await readExactOrNull(session, projectId, expected.path, words);
      let overwrite = false;
      if (existing !== null) {
        if (recordMatches(existing, expected)) {
          reused.push(expected.path);
          continue;
        }
        if (!replaceExisting) refuse(`Existing Project record '${expected.path}' differs from the approved manifest.`);
        overwrite = true;
      }
      attempted.push(expected.path);
      const response = await session.callTool('write_note', {
        project_id: projectId,
        directory: expected.path.substring(0, expected.path.lastIndexOf('/')),
        title: path.posix.parse(expected.path).name,
        content: expected.content,
        note_type: 'note',
        overwrite,
        output_format: 'json',
      });
      if (field(field(response, 'result'), 'isError') === true) refuse(`Write '${expected.path}' was rejected.`);
      if (String(field(field(field(field(response, 'result'), 'structuredContent'), 'result'), 'action') ?? '') === 'conflict') {
        refuse(
          `Write '${expected.path.substring(0, expected.path.length - 3)}' was refused: a note already exists there, written by someone else ` +
            'since this run read the collection. Nothing was overwritten.',
        );
      }
      const readback = await readExactOrNull(session, projectId, expected.path, words);
      if (readback === null) refuse(`Write '${expected.path}' did not become readable.`);
      if (!recordMatches(readback, expected)) refuse(`Existing Project record '${expected.path}' differs from the approved manifest.`);
      created.push(expected.path);
    }
    recordsVerified = true;
    saveJournal('complete', '');
  } catch (error) {
    const failure = (error as Error).message;
    if (!recordsVerified) {
      try {
        saveJournal('incomplete', failure);
      } catch {
        // The oracle swallows a journal that cannot be saved while it reports the failure that mattered.
      }
    }
    if (recordsVerified) refuse(`Project copy was verified, but its local completion journal could not be saved: ${failure}`);
    throw error;
  }
  return {
    schema: 1,
    operation: 'Copy Local Pages to Project',
    project_slug: slug,
    plan_id: planId,
    page_manifest_sha256: manifestDigest,
    created_records: created,
    reused_records: reused,
    journal_path: journalPath,
    shared_library_write: true,
  };
}

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

/**
 * `Assert-Matches`: the record as read against the approved text, hashed. A record that carries frontmatter
 * has its leading newlines trimmed (Basic Memory returns one before a body it read without it); the approved
 * text is not trimmed; both have CRLF made LF.
 */
function recordMatches(record: NoteRecord, expected: CopyRecord): boolean {
  let actual = record.content;
  if (record.frontmatter !== null && record.frontmatter !== undefined) actual = actual.replace(/^[\r\n]+/, '');
  return sha256OfText(actual.split('\r\n').join('\n')) === sha256OfText(expected.content.split('\r\n').join('\n'));
}
