/**
 * A collection, through one interface with two implementations (ADR-0030; PLAN-public-release.md
 * step 27). S30 lands the LOCAL implementation and the verbs Tier 0 needs to open a Seat with no Basic
 * Memory: `library hub new` into the local collection, the Active Project Catalog read from it, and
 * `seat enter --create` validated against that catalog.
 *
 * WHERE IT LIVES, as the reader ruled in S30: `<workspace>/collection/`, in the shared collection's
 * exact layout (`books/`, `projects/`, `archive/`), laid out by `library init` whenever no Basic Memory
 * endpoint is configured, with its persistent id in `collection/.library/collection.json`. It takes NO
 * ownership claim: the one-writable-workspace fence exists because two workspaces would hold different
 * Book locks on one shared page, and a folder inside one workspace has one set of locks.
 *
 * THE BASIC MEMORY IMPLEMENTATION BEGAN WITH `hub new` (S33), measured against disposable projects on the
 * NAS: `src/basicmemory.ts` is the transport and `src/ownership.ts` the write fence. Its result carries
 * New-ProjectHub.ps1's own field names, and so does the local one's since S33 -- until then the local verb
 * said `project_root` and `connections` where the oracle says `project_path` and `connections_path`, which
 * no row could see while no row reached a shared Hub. S34 added `hub edit` against both backends
 * (`src/hubedit.ts`) and the `hub archive` preflight against Basic Memory (`src/sharedwriters.ts`), which
 * also holds `library shared`. S35 added the `copy-pages` preflight (`src/hubcopy.ts`) and the three `library publish` preflights (`src/publish.ts`),
 * and a local collection read never falls back to Basic Memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { parseArguments } from './argv.ts';
import { readMarker } from './workspace.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import type { PsJsonValue } from './psjson.ts';
import { McpSession, noteBody, readExactOrNull, resolveCollectionId, resolveMcpUrl, writeExact } from './basicmemory.ts';
import { assertCollectionWriteAllowed } from './ownership.ts';
import { hubEdit } from './hubedit.ts';
import { hubArchive, sharedArchive, sharedListEntry } from './sharedwriters.ts';
import { runPublish } from './publish.ts';
import { hubCopyPages } from './hubcopy.ts';

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE_CATALOG = ['projects', 'README.md'];
const ARCHIVE_CATALOG = ['archive', 'projects', 'README.md'];

class CollectionRefusal extends Error {}

function refuse(message: string): never {
  throw new CollectionRefusal(message);
}

export interface Collection {
  backend: 'local';
  id: string;
  root: string;
  /** A page's text by its collection-relative path, or null when it does not exist. */
  readPage(relative: string): string | null;
  /** The slugs listed in the Active (or archived) Project Catalog, in catalog order. */
  projectSlugs(which: 'active' | 'archive'): string[];
}

export const SHARED_BACKEND_NOT_PORTED =
  'This workspace is attached to a shared collection through Basic Memory, and this verb does not speak to ' +
  "Basic Memory yet: of the shared half of S16's row only `library hub new`, `hub edit`, the `hub archive`, `hub copy-pages` and " +
  '`library shared` preflights and the three `library publish` preflights are ported. Use the PowerShell helpers ' +
  'for the shared collection until then. A workspace with no endpoint uses its local collection, which the kernel ' +
  'does read and write.';

export function localCollectionRoot(workspace: string): string {
  return path.join(workspace, 'collection');
}

function readText(file: string): string | null {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** The slugs a catalog lists, parsed exactly as tools/RawBatchOwnership.ps1 parses the shared one. */
export function catalogSlugs(text: string, prefix: string): string[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*-\\s*\\[\\[${escaped}/([a-z0-9][a-z0-9-]*)/_project\\|`, 'gm');
  const slugs: string[] = [];
  for (const match of text.matchAll(pattern)) if (!slugs.includes(match[1]!)) slugs.push(match[1]!);
  return slugs;
}

/**
 * The collection this workspace is attached to. REFUSES rather than guessing: a workspace attached to
 * Basic Memory is not read as local, and a local workspace whose collection is missing or carries no id
 * is told to run `library init`, which is what lays one out.
 */
export function openCollection(workspace: string): Collection {
  const marker = readMarker(workspace);
  if (marker === null) refuse(`${workspace} has no workspace marker, so it is attached to no collection. Run library init.`);
  if (String(marker['backend'] ?? '') !== 'local') refuse(SHARED_BACKEND_NOT_PORTED);

  const root = localCollectionRoot(workspace);
  const idFile = path.join(root, '.library', 'collection.json');
  const idText = readText(idFile);
  if (idText === null) {
    refuse(
      `This workspace has no local collection yet: ${idFile} does not exist. Run library init in the workspace, ` +
        'which lays out collection/ and never rewrites what is already there.',
    );
  }
  let id = '';
  try {
    const record = JSON.parse(idText) as Record<string, unknown>;
    id = typeof record['id'] === 'string' ? record['id'] : '';
  } catch {
    id = '';
  }
  if (!id.trim()) refuse(`${idFile} carries no readable id, so the local collection's identity cannot be confirmed.`);
  const markerId = String(marker['collection_id'] ?? '');
  if (markerId && markerId !== id) {
    refuse(
      `The workspace marker names collection ${markerId}, and ${idFile} names ${id}. A workspace is attached to ` +
        'one collection; one of the two was replaced. Nothing was read.',
    );
  }

  return {
    backend: 'local',
    id,
    root,
    readPage(relative: string): string | null {
      const resolved = path.resolve(root, relative);
      if (!resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) {
        refuse(`'${relative}' is not a path inside the collection.`);
      }
      return readText(resolved);
    },
    projectSlugs(which: 'active' | 'archive'): string[] {
      const relative = which === 'active' ? ACTIVE_CATALOG : ARCHIVE_CATALOG;
      const text = readText(path.join(root, ...relative));
      if (text === null) refuse(`The ${which === 'active' ? 'Active' : 'archived'} Project Catalog ${relative.join('/')} is missing from the local collection.`);
      return catalogSlugs(text, which === 'active' ? 'projects' : 'archive/projects');
    },
  };
}

/** `read_project_catalog` against the local collection: the Active Project Catalog as written. */
export function readLocalProjectCatalog(workspace: string): string {
  const collection = openCollection(workspace);
  const text = collection.readPage(ACTIVE_CATALOG.join('/'));
  if (text === null || !text.trim()) refuse('The Active Project Catalog in the local collection has no readable content.');
  return text;
}

// --- library hub new ----------------------------------------------------------------------------------
//
// The bodies are tools/New-ProjectHub.ps1's, byte for byte (New-ProjectRootBody, New-ProjectDevSections,
// New-ProjectConnectionsBody), so a Hub made locally is the Hub the shared helper makes, and a local
// collection handed to Basic Memory later is already a valid project.

function devSections(): string {
  const repoSeed =
    "- **Working tree:** the local checkout this project's work happens in. Replace this line.\n" +
    '- **Remote:** sanitized remote URL -- no credentials or userinfo.\n' +
    '- **Branch:** the branch work lands on.\n' +
    '- **Gate:** the command that must pass before a change is done.\n' +
    "- **Agent guidance:** point at the working tree's own `AGENTS.md`; never copy it here, because a copy goes stale silently.\n\n" +
    'Delete any label that does not apply to this subject rather than writing `n/a`: this section names the working tree the work happens in and what proves a change is done, and the git-shaped labels are the common case rather than the definition. A subject with no repository of its own keeps Working tree and Gate and loses the rest. A dead label costs a reader attention on every orientation, and several would make a live section look broken rather than deliberately short.';
  const decisionsSeed =
    'Settled ground, as one-line pointers. Replace this line.\n\n' +
    '- **<date> -- <what was decided>.** <where its record lives>\n\n' +
    "Pointers only: the reasoning lives in the subject's own `docs/adr/` when it has a repository you control, and in this Hub's `decisions/` page when it does not. Operative entries only -- remove a pointer when its decision is superseded, and let the record it names carry that history.";
  return `## Repo\n\n${repoSeed}\n\n## Decisions\n\n${decisionsSeed}\n`;
}

export function projectRootBody(title: string, purpose: string, nextActions: string[], dev: boolean): string {
  const next = nextActions.length ? nextActions.map((item) => `- [ ] ${item}`).join('\n') : '- [ ] Add the next useful action.';
  const purposeText = purpose.trim() ? purpose.trim() : 'Describe what this project is for.';
  const nowSeed =
    'Where this project stands, and anything still open or unproven. Replace this line.\n\n' +
    "Orientation and open items only. **Every item here must have a closing condition this project can cause.** What *happened* belongs on a dated `notes/` history page, append-only and unlimited. Anything that will not close by doing the work leaves: a limit whose proof needs an event you cannot cause goes to the `limits` page with a disposition, a settled question goes to `## Decisions` and the record it names, and a standing practice goes to the subject's own rules or docs.";
  const devText = dev ? '\n' + devSections() : '';
  return `# ${title}\n\n## Purpose\n\n${purposeText}\n\n## Now\n\n${nowSeed}\n\n## Next\n\n${next}\n${devText}`;
}

export const PROJECT_CONNECTIONS_BODY =
  '# Connections\n\nThe return briefing reads this page instead of the Hub root so the root stays small.\n\n## Connected knowledge\n\n## Connected tools\n';

/** The catalog with one entry added under `## Projects`, as New-ProjectHub.ps1 adds it. */
export function catalogWithEntry(catalog: string, entry: string): string {
  return /^## Projects\s*$/m.test(catalog) ? `${catalog.trimEnd()}\n${entry}\n` : `${catalog.trimEnd()}\n\n## Projects\n\n${entry}\n`;
}

export interface HubResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/** The `## <heading>` names a body declares, as the oracle's `planned_root_sections` lists them. */
function sectionNames(body: string): string[] {
  return [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `library hub new` against Basic Memory: New-ProjectHub.ps1, step for step. The fence first (a
 * preflight is fenced too, as the oracle's is), then the three reads, the plan, and the writes in the
 * oracle's order -- connections, root, catalog -- each wrapped in the oracle's sentence for what a
 * failure there leaves behind.
 *
 * THE CATALOG MATCH IS CASE-INSENSITIVE, AS THE ORACLE'S `-notmatch` IS, and that is carried rather than
 * corrected: `[[projects/x/_project|acceptance]]` counts as listing a Hub titled `Acceptance`. A stricter
 * port would add a second line where the PowerShell helper adds none.
 */
async function hubNewShared(
  slug: string,
  title: string,
  purpose: string,
  nextActions: string[],
  dev: boolean,
  preflight: boolean,
  workspace: string,
): Promise<Record<string, PsJsonValue>> {
  const url = resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'creating a Project Hub');
  const projectId = resolveCollectionId(workspace);
  const directory = `projects/${slug}`;
  const rootPath = `${directory}/_project.md`;
  const connectionsPath = `${directory}/connections.md`;

  const session = new McpSession(url, 'library-project-hub');
  await session.initialize();
  const existingRoot = await readExactOrNull(session, projectId, rootPath);
  let catalog = await readExactOrNull(session, projectId, ACTIVE_CATALOG.join('/'));
  const existingConnections = await readExactOrNull(session, projectId, connectionsPath);
  const body = projectRootBody(title, purpose, nextActions, dev);
  if (preflight) {
    return {
      schema: 1,
      operation: 'Create Project Hub',
      project_slug: slug,
      project_path: directory,
      catalog_path: ACTIVE_CATALOG.join('/'),
      connections_path: connectionsPath,
      existing_project: existingRoot !== null,
      action: existingRoot !== null ? 'existing' : 'create',
      dev_template: dev,
      planned_root_sections: sectionNames(body),
      planned_root_bytes: Buffer.byteLength(body, 'utf8'),
      shared_library_write: false,
    };
  }
  if (existingRoot !== null) refuse(`Project Hub '${slug}' already exists; no write was performed.`);
  const entry = `- [[${directory}/_project|${title}]]`;
  const listed = new RegExp(escapeRegExp(`[[${directory}/_project|${title}]]`), 'i');
  // An orphaned connections page -- one with no root beside it -- is what a creation that failed half
  // way leaves, and the next creation overwrites it rather than refusing.
  const connectionsOverwrite = existingRoot === null && existingConnections !== null;
  try {
    await writeExact(session, projectId, directory, 'connections', PROJECT_CONNECTIONS_BODY, connectionsOverwrite);
  } catch (error) {
    if (existingConnections !== null) {
      refuse(
        `The companion connections page '${connectionsPath}' already exists but could not be refreshed, and the Hub root ` +
          `'${rootPath}' does not exist; re-run this command to finish the creation. ${(error as Error).message}`,
      );
    }
    refuse(
      `Neither the companion connections page '${connectionsPath}' nor the Hub root '${rootPath}' was created; re-run this ` +
        `command to try again. ${(error as Error).message}`,
    );
  }
  try {
    await writeExact(session, projectId, directory, '_project', body, false);
  } catch (error) {
    refuse(
      `The companion connections page '${connectionsPath}' was created but the Hub root '${rootPath}' was not; re-run this ` +
        `command to finish the creation. ${(error as Error).message}`,
    );
  }
  try {
    if (catalog === null) {
      const created = `# Active Projects\n\nProjects are living context on the NAS. Open one when you need its current notes.\n\n## Projects\n\n${entry}\n`;
      catalog = await writeExact(session, projectId, 'projects', 'README', created, false);
    } else {
      const catalogBody = noteBody(catalog);
      if (!listed.test(catalogBody)) {
        const replacement = /^## Projects\s*$/m.test(catalogBody)
          ? `${catalogBody.trimEnd()}\n${entry}\n`
          : `${catalogBody.trimEnd()}\n\n## Projects\n\n${entry}\n`;
        catalog = await writeExact(session, projectId, 'projects', 'README', replacement, true);
      }
    }
    if (!listed.test(catalog.content)) refuse('Active Project Catalog readback did not include the new Project Hub.');
  } catch (error) {
    refuse(
      `The companion connections page '${connectionsPath}' and Hub root '${rootPath}' were created, but the Active Project ` +
        `Catalog '${ACTIVE_CATALOG.join('/')}' was not updated with the new Hub entry. ${(error as Error).message}`,
    );
  }
  return {
    schema: 1,
    operation: 'Create Project Hub',
    project_slug: slug,
    project_path: directory,
    catalog_path: ACTIVE_CATALOG.join('/'),
    connections_path: connectionsPath,
    created: true,
    shared_library_write: true,
  };
}

async function hubNew(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['title', 'purpose', 'next-action', 'workspace']);
  const slug = parsed.positional[0] ?? '';
  if (!slug) refuse('library hub new needs the Project slug: library hub new <slug> --title <title>.');
  if (!PROJECT_SLUG.test(slug)) refuse('ProjectSlug must use lowercase letters, digits, and single hyphens.');
  const title = (parsed.options.get('title') ?? '').trim();
  if (!title) refuse('Title is required.');
  const nextAction = parsed.options.get('next-action');
  const dev = parsed.flags.has('dev');

  const marker = readMarker(workspace);
  if (marker !== null && String(marker['backend'] ?? '') !== 'local') {
    return hubNewShared(
      slug,
      title,
      parsed.options.get('purpose') ?? '',
      nextAction === undefined ? [] : [nextAction],
      dev,
      parsed.flags.has('preflight'),
      workspace,
    );
  }

  const collection = openCollection(workspace);
  const directory = `projects/${slug}`;
  const rootPath = `${directory}/_project.md`;
  const connectionsPath = `${directory}/connections.md`;
  const entry = `- [[${directory}/_project|${title}]]`;

  const plan = {
    backend: 'local',
    collection_id: collection.id,
    project_slug: slug,
    project_path: directory,
    catalog_path: ACTIVE_CATALOG.join('/'),
    connections_path: connectionsPath,
    catalog_entry: entry,
  };
  if (parsed.flags.has('preflight')) {
    const exists = collection.readPage(rootPath) !== null;
    return {
      schema: 1,
      operation: 'Create Project Hub',
      ...plan,
      existing_project: exists,
      action: exists ? 'existing' : 'create',
      would_write: exists ? [] : [connectionsPath, rootPath, ACTIVE_CATALOG.join('/')],
      shared_library_write: false,
    };
  }

  // ONE LOCK OVER THE HUB AND THE CATALOG LINE, so two creations cannot both read a catalog without
  // the other's entry. A local collection has one set of locks: this workspace's.
  const lock = enterBookLock(workspace, 'collection/projects');
  try {
    if (collection.readPage(rootPath) !== null) {
      refuse(`Project Hub '${slug}' already exists at collection/${rootPath}; nothing was written.`);
    }
    const written: string[] = [];
    // CONNECTIONS FIRST, then the root, then the catalog: the shared helper's order, so a failure
    // leaves at worst an orphaned connections page -- which the next creation overwrites, as there.
    writeAtomicText(path.join(collection.root, ...connectionsPath.split('/')), PROJECT_CONNECTIONS_BODY);
    written.push(connectionsPath);
    writeAtomicText(
      path.join(collection.root, ...rootPath.split('/')),
      projectRootBody(title, parsed.options.get('purpose') ?? '', nextAction === undefined ? [] : [nextAction], dev),
    );
    written.push(rootPath);
    const catalogFile = path.join(collection.root, ...ACTIVE_CATALOG);
    const catalog = fs.readFileSync(catalogFile, 'utf8').replace(/^﻿/, '');
    const catalogAction = catalogSlugs(catalog, 'projects').includes(slug) ? 'already_listed' : 'added';
    if (catalogAction === 'added') writeAtomicText(catalogFile, catalogWithEntry(catalog, entry));
    // READ BACK, as the shared helper reads back every write: a Hub the catalog lists and the disk
    // does not hold is the defect the Active Project Catalog exists to prevent.
    if (collection.readPage(rootPath) === null || !collection.projectSlugs('active').includes(slug)) {
      refuse(`Project Hub '${slug}' did not read back after its write; check collection/${directory}.`);
    }
    return {
      schema: 1,
      operation: 'Create Project Hub',
      ...plan,
      created: true,
      written,
      catalog: catalogAction,
      shared_library_write: false,
    };
  } finally {
    exitBookLock(lock);
  }
}

/**
 * `library hub <action>`. `new` against both backends; `edit` against both (S34, `hubedit.ts`); `archive`
 * against Basic Memory, its preflight only (`sharedwriters.ts`), and `copy-pages` likewise (`hubcopy.ts`).
 */
export async function runHubVerb(argv: string[], workspace: string): Promise<HubResult> {
  const action = argv[0] ?? '';
  try {
    switch (action) {
      case 'new':
        return { refusal: null, value: await hubNew(argv.slice(1), workspace) };
      case 'edit':
        return { refusal: null, value: await hubEdit(argv.slice(1), workspace) };
      case 'archive': {
        const marker = readMarker(workspace);
        if (marker !== null && String(marker['backend'] ?? '') === 'local') {
          refuse(
            'library hub archive is ported against Basic Memory only, and this workspace uses its local collection. ' +
              'A local archive shelf is collection/archive/projects/, and no row holds a local archive yet. Nothing was changed.',
          );
        }
        return { refusal: null, value: await hubArchive(argv.slice(1), workspace) };
      }
      case 'copy-pages':
        // The Hub-creation preflight is handed in, so hubcopy.ts does not import this file back.
        return {
          refusal: null,
          value: await hubCopyPages(argv.slice(1), workspace, async (slug, title, purpose, nextActions, preflight = true) =>
            String((await hubNewShared(slug, title, purpose, nextActions, false, preflight, workspace))['action']),
          ),
        };
      default:
        refuse(`library hub has no action '${action}'. It has: new, edit, archive, copy-pages.`);
    }
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}

/** `library shared <archive|list-entry>`: the collection's own Catalog, against Basic Memory only. */
export async function runSharedVerb(argv: string[], workspace: string): Promise<HubResult> {
  const action = argv[0] ?? '';
  try {
    const marker = readMarker(workspace);
    if (marker !== null && String(marker['backend'] ?? '') === 'local' && (action === 'archive' || action === 'list-entry')) {
      refuse(
        `library shared ${action} acts on a shared collection, and this workspace uses its local collection: there is no ` +
          'shared Book Catalog to change. Nothing was changed.',
      );
    }
    switch (action) {
      case 'archive':
        return { refusal: null, value: await sharedArchive(argv.slice(1), workspace) };
      case 'list-entry':
        return { refusal: null, value: await sharedListEntry(argv.slice(1), workspace) };
      default:
        refuse(`library shared has no action '${action}'. It has: archive, list-entry.`);
    }
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}

/** `library publish [batch|refresh]`: the three preflights (S35, `publish.ts`); `publish` and `refresh` confirmed since S39. */
export async function runPublishVerb(argv: string[], workspace: string): Promise<HubResult> {
  try {
    return { refusal: null, value: await runPublish(argv, workspace) };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
