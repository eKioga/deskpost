/**
 * The shared collection's own writers, as far as S34 carries them: `library hub archive`
 * (tools/Archive-ProjectHub.ps1), `library shared archive` (tools/Archive-SharedBook.ps1), `library shared
 * list-entry` (tools/Add-CatalogEntry.ps1). `library publish`, which lived here as its write fence alone in S34,
 * is `src/publish.ts` since S35.
 *
 * EACH IS ITS ORACLE, STEP FOR STEP: the preflight since S34, the confirmed half since S39 -- the native
 * `move_note`, the link rewrites, the archive Catalogs, the emptied-directory cleanup, the Catalog
 * `edit_note` -- each ported only once rows held it (`hub.archive-confirmed-*`,
 * `publication.shared-book-archive-confirmed-*`, `publication.catalog-entry-confirmed-*`), with each oracle
 * run by hand in a disposable project first. What each reads is what its oracle reads, in its order and
 * with its own `include_frontmatter`, because a title parsed from a page with frontmatter is a different
 * title -- and a body read without it keeps the leading newline Basic Memory returns, which the Book
 * archiver writes back (measured S39).
 *
 * THE HUSK AND THIS MACHINE'S SMB CLIENT (measured S39). The cleanup lists the directory the move just
 * emptied through the share, and a client that listed it within its cache lifetime answers from that
 * listing: the oracle then reports `not-empty` and leaves the empty directory, and so does this port. That
 * is the oracle's behaviour, carried, not fixed here; the rows settle the share before the arm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import type { PsJsonValue } from './psjson.ts';
import { McpSession, noteBody, readExactOrNull, resolveCollectionId, resolveMcpUrl, configuredSharedRoot } from './basicmemory.ts';
import type { NoteRecord } from './basicmemory.ts';
import { assertCollectionWriteAllowed, isSharedCollectionRoot } from './ownership.ts';

class SharedWriterRefusal extends Error {}

function refuse(message: string): never {
  throw new SharedWriterRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

/** `Get-SharedCollectionRoot`, which never throws: the configured root when it carries both Catalogs. */
function sharedCollectionRoot(workspace: string): string | null {
  const configured = configuredSharedRoot(workspace);
  return configured && isSharedCollectionRoot(configured) ? configured : null;
}

function sourceTreeRemoval(workspace: string, activeDirectory: string): string {
  return sharedCollectionRoot(workspace) === null
    ? 'unavailable: the emptied directory will be left behind'
    : `the emptied ${activeDirectory}/ is removed if it holds no files`;
}

/** The first `# ` heading of a page, as the archivers and the lister read a title. */
function firstHeading(content: string): string | null {
  const match = /^#\s+(.+?)\s*$/im.exec(content);
  return match ? match[1]!.trim() : null;
}

/**
 * `Read-McpDirectoryListing`: every `*.md` path under `directory`, paged, and PROVED complete against the
 * server's own declared total -- a short, repeated or moving listing is refused, never returned.
 */
async function readDirectoryListing(session: McpSession, projectId: string, directory: string, requiredPath: string): Promise<string[]> {
  const pageSize = 200;
  const maxPages = 200;
  const paths: string[] = [];
  const seen = new Set<string>();
  let declaredTotal: number | null = null;
  let page = 1;
  while (true) {
    const response = await session.callTool('list_directory', {
      project_id: projectId,
      dir_name: directory,
      depth: 10,
      page,
      page_size: pageSize,
      output_format: 'json',
    });
    if (response === null || response === undefined) refuse(`Listing '${directory}' page ${page} returned nothing.`);
    const inner = field(response, 'result');
    if (field(inner, 'isError') === true) refuse(`Listing '${directory}' page ${page} was rejected by the shared Library.`);
    const result = field(field(inner, 'structuredContent'), 'result');
    if (result === undefined || result === null || field(result, 'total') === undefined || field(result, 'nodes') === undefined) {
      refuse(`Listing '${directory}' page ${page} did not return a recognised json listing; no result was produced.`);
    }
    const pageTotal = Math.trunc(Number(field(result, 'total')));
    if (declaredTotal === null) declaredTotal = pageTotal;
    else if (pageTotal !== declaredTotal) {
      refuse(
        `Listing '${directory}' changed its total from ${declaredTotal} to ${pageTotal} between pages; it is being written while it is read and no result was produced.`,
      );
    }
    const rawNodes = field(result, 'nodes');
    const nodes = Array.isArray(rawNodes) ? rawNodes : rawNodes === null ? [] : [rawNodes];
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const type = String(field(node, 'type') ?? '');
      const filePath = String(field(node, 'file_path') ?? '');
      const dirPath = String(field(node, 'directory_path') ?? '');
      if (type === 'file') {
        if (isBlank(filePath)) refuse(`Listing '${directory}' returned a file node with no path; no result was produced.`);
        seen.add(`f:${filePath}`);
        if (filePath.startsWith(`${directory}/`) && filePath.endsWith('.md')) paths.push(filePath);
      } else {
        const identity = !isBlank(dirPath) ? dirPath : !isBlank(filePath) ? filePath : '';
        if (isBlank(identity)) refuse(`Listing '${directory}' returned a node with no identity; no result was produced.`);
        seen.add(`d:${identity}`);
      }
    }
    const hasMore = field(result, 'has_more') === true;
    if (!hasMore || nodes.length === 0) break;
    page++;
    if (page > maxPages) refuse(`Listing '${directory}' did not terminate within ${maxPages} pages; no result was produced.`);
  }
  if (seen.size !== declaredTotal) {
    refuse(`Listing '${directory}' returned ${seen.size} of ${declaredTotal} declared items; the listing is incomplete and no result was produced.`);
  }
  // `Sort-Object -Unique` over strings: case-insensitive, so two paths differing only in case are one.
  const ordered: string[] = [];
  for (const candidate of [...paths].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))) {
    if (!ordered.some((kept) => kept.toLowerCase() === candidate.toLowerCase())) ordered.push(candidate);
  }
  if (requiredPath && !ordered.includes(requiredPath)) {
    refuse(`Listing '${directory}' did not return '${requiredPath}'; the listing is incomplete or is for another directory, and no result was produced.`);
  }
  return ordered;
}

// --- library hub archive --------------------------------------------------------------------------------

export async function hubArchive(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace']);
  const slug = parsed.positional[0] ?? '';
  // The fence and the collection id come BEFORE the slug is checked: the oracle's order.
  const url = resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'archiving a Project Hub');
  const projectId = resolveCollectionId(workspace);
  if (!SLUG.test(slug)) refuse('ProjectSlug must use lowercase letters, digits, and single hyphens.');

  const activeDirectory = `projects/${slug}`;
  const archiveDirectory = `archive/projects/${slug}`;
  const session = new McpSession(url, 'library-project-archiver');
  await session.initialize();
  const words = { stopped: 'archive stopped' };
  const activeRoot = await readExactOrNull(session, projectId, `${activeDirectory}/_project.md`, words);
  const archiveRoot = await readExactOrNull(session, projectId, `${archiveDirectory}/_project.md`, words);
  if (activeRoot === null) refuse(`Active Project Hub '${slug}' is missing; nothing was archived.`);
  if (archiveRoot !== null) refuse(`Archive already contains Project Hub '${slug}'; no move was attempted.`);
  const pages = await readDirectoryListing(session, projectId, activeDirectory, `${activeDirectory}/_project.md`);
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Archive Project Hub',
    project_id: projectId,
    project_slug: slug,
    active_path: activeDirectory,
    archive_path: archiveDirectory,
    page_count: pages.length,
    source_tree_removal: sourceTreeRemoval(workspace, activeDirectory),
    confirmation_required: true,
    shared_library_write: false,
  };
  if (parsed.flags.has('preflight')) return plan;
  if (!parsed.flags.has('user-confirmed')) refuse('Archiving is not yet performed: review the move plan and rerun with -UserConfirmed.');

  // THE CONFIRMED HALF (S39), in the oracle's order: the one native move, every page read back at its new
  // path, the root's own links, the archive Catalog, the active Catalog line, and last the husk. Any
  // failure is reported under the oracle's one sentence, which says whether the move had happened.
  const title = firstHeading(activeRoot.content) ?? slug;
  let moved = false;
  try {
    const move = await session.callTool('move_note', {
      project_id: projectId,
      identifier: activeDirectory,
      destination_path: archiveDirectory,
      is_directory: true,
      output_format: 'json',
    });
    if (toolRejected(move)) refuse('The native Basic Memory directory move was rejected.');
    moved = true;
    const activeRootPath = `${activeDirectory}/_project.md`;
    const archiveRootPath = `${archiveDirectory}/_project.md`;
    const former = await readExactOrNull(session, projectId, activeRootPath, { ...words, allowRedirect: true });
    if (former !== null && former.file_path !== archiveRootPath) refuse(`The active Project root resolved unexpectedly after the move: ${former.file_path}`);
    for (const page of pages) {
      // String.Replace: every occurrence, ordinal.
      const archivedPage = page.split(activeDirectory).join(archiveDirectory);
      if ((await readExactOrNull(session, projectId, archivedPage, words)) === null) refuse(`Archived Project page is missing: ${archivedPage}`);
    }
    await rewriteRootSelfLinks(session, projectId, activeDirectory, archiveDirectory, words);
    await ensureArchiveCatalog(session, projectId, archiveDirectory, title, words);
    await removeActiveCatalogEntry(session, projectId, activeDirectory, archiveDirectory, words);
    const husk = sharedHuskCleanup(workspace, activeDirectory);
    return {
      schema: 1,
      operation: 'Archive Project Hub',
      project_slug: slug,
      archive_path: archiveDirectory,
      page_count: pages.length,
      archive_complete: true,
      shared_library_write: true,
      source_tree: husk.source_tree,
      source_tree_removed: husk.status,
    };
  } catch (error) {
    const location = moved
      ? `The native move may have completed at '${archiveDirectory}'; inspect the archive before retrying.`
      : 'The active Project Hub was left in place.';
    refuse(`Project archival stopped. ${location} ${(error as Error).message}`);
  }
}

function toolRejected(response: unknown): boolean {
  const error = field(response, 'error');
  return (error !== undefined && error !== null) || field(field(response, 'result'), 'isError') === true;
}

/** PowerShell's `-match` against an escaped literal: a case-insensitive substring test. */
function containsIgnoringCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** `Write-Note` (Archive-ProjectHub.ps1): no "did not become readable" check -- the readback may be null. */
async function archiverWriteNote(
  session: McpSession,
  projectId: string,
  directory: string,
  title: string,
  body: string,
  overwrite: boolean,
  words: { stopped: string },
): Promise<NoteRecord | null> {
  const response = await session.callTool('write_note', {
    project_id: projectId,
    directory,
    title,
    content: body,
    note_type: 'note',
    overwrite,
    output_format: 'json',
  });
  if (toolRejected(response)) refuse(`Write '${directory}/${title}' was rejected.`);
  if (String(field(field(field(field(response, 'result'), 'structuredContent'), 'result'), 'action') ?? '') === 'conflict') {
    refuse(`Write '${directory}/${title}' was refused: a note already exists there, written by someone else since this run read the collection. Nothing was overwritten.`);
  }
  return readExactOrNull(session, projectId, `${directory}/${title}.md`, words);
}

/** `Rewrite-RootSelfLinks`: every `[[<active>/` in the moved root, counted case-sensitively and replaced in one edit. */
async function rewriteRootSelfLinks(session: McpSession, projectId: string, activeDirectory: string, archiveDirectory: string, words: { stopped: string }): Promise<void> {
  const archiveRootPath = `${archiveDirectory}/_project.md`;
  const root = await readExactOrNull(session, projectId, archiveRootPath, words);
  const find = `[[${activeDirectory}/`;
  const count = (root?.content ?? '').split(find).length - 1;
  if (count === 0) return;
  const response = await session.callTool('edit_note', {
    project_id: projectId,
    identifier: archiveRootPath.substring(0, archiveRootPath.length - 3),
    operation: 'find_replace',
    find_text: find,
    content: `[[${archiveDirectory}/`,
    expected_replacements: count,
    output_format: 'json',
  });
  if (toolRejected(response)) refuse('Project root self-link update was rejected.');
  const after = await readExactOrNull(session, projectId, archiveRootPath, words);
  if (containsIgnoringCase(after?.content ?? '', find)) refuse('Project root still contains an active self-link after archive.');
}

/** `Ensure-ArchiveCatalog`: created with the one entry when missing, rewritten whole when it lacks it. */
async function ensureArchiveCatalog(session: McpSession, projectId: string, archiveDirectory: string, title: string, words: { stopped: string }): Promise<void> {
  const link = `[[${archiveDirectory}/_project|${title}]]`;
  const entry = `- ${link}`;
  let catalog = await readExactOrNull(session, projectId, 'archive/projects/README.md', words);
  if (catalog === null) {
    const body = `# Archived Projects\n\nInactive Project Hubs remain available here when you need their context again.\n\n## Archived Projects\n\n${entry}\n`;
    catalog = await archiverWriteNote(session, projectId, 'archive/projects', 'README', body, false, words);
  } else if (!containsIgnoringCase(noteBody(catalog), link)) {
    const catalogBody = noteBody(catalog);
    const replacement = /^## Archived Projects\s*$/im.test(catalogBody)
      ? `${catalogBody.trimEnd()}\n${entry}\n`
      : `${catalogBody.trimEnd()}\n\n## Archived Projects\n\n${entry}\n`;
    catalog = await archiverWriteNote(session, projectId, 'archive/projects', 'README', replacement, true, words);
  }
  if (!containsIgnoringCase(catalog?.content ?? '', link)) refuse('Archived Project Catalog readback did not include the Project Hub.');
}

/** `Remove-ActiveCatalogEntry`: the one line naming the Hub, removed by an exact find_replace; two are refused. */
async function removeActiveCatalogEntry(session: McpSession, projectId: string, activeDirectory: string, archiveDirectory: string, words: { stopped: string }): Promise<void> {
  const activeLink = `[[${activeDirectory}/_project|`;
  const archiveLink = `[[${archiveDirectory}/_project|`;
  const names = (content: string) => containsIgnoringCase(content, activeLink) || containsIgnoringCase(content, archiveLink);
  const catalog = await readExactOrNull(session, projectId, 'projects/README.md', words);
  if (catalog === null) refuse('The active Project Catalog is missing; archive stopped.');
  const lines = catalog.content.split(/\r?\n/).filter(names);
  if (lines.length > 1) refuse('The active Project Catalog has more than one matching entry; archive stopped without changing the Catalog.');
  if (lines.length === 1) {
    const response = await session.callTool('edit_note', {
      project_id: projectId,
      identifier: 'projects/README',
      operation: 'find_replace',
      find_text: lines[0]!,
      content: '',
      expected_replacements: 1,
      output_format: 'json',
    });
    if (toolRejected(response)) refuse('Active Project Catalog update was rejected.');
  }
  const after = await readExactOrNull(session, projectId, 'projects/README.md', words);
  if (names(after?.content ?? '')) refuse('Active Project Catalog readback still includes the archived Project Hub.');
}

// --- the husk (tools/SharedCollectionFiles.ps1) ---------------------------------------------------------

/** `Test-SharedTreeIsHusk`: a directory that exists and holds no file at any depth, hidden ones counted. */
function isHusk(full: string): boolean {
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return false;
    const pending = [full];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
        else return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * `Invoke-SharedHuskCleanup` with no override: the emptied directory a native move leaves behind, removed
 * only when it provably holds nothing. A status, never a throw -- it runs after the archive has committed.
 */
function sharedHuskCleanup(workspace: string, relativePath: string): { source_tree: string; status: string } {
  const root = sharedCollectionRoot(workspace);
  if (root === null) return { source_tree: relativePath, status: 'unavailable' };
  const full = path.join(root, ...relativePath.split('/'));
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return { source_tree: relativePath, status: 'absent' };
    if (!isHusk(full)) return { source_tree: relativePath, status: 'not-empty' };
    // Re-checked immediately before the delete, as the oracle re-checks.
    if (!isHusk(full)) return { source_tree: relativePath, status: 'not-empty' };
    fs.rmSync(full, { recursive: true, force: true });
    if (fs.existsSync(full)) return { source_tree: relativePath, status: 'failed:the directory survived its own removal' };
    return { source_tree: relativePath, status: 'removed' };
  } catch (error) {
    return { source_tree: relativePath, status: `failed:${(error as Error).message}` };
  }
}

// --- library shared archive -----------------------------------------------------------------------------

export async function sharedArchive(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace']);
  const slug = parsed.positional[0] ?? '';
  const url = resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'archiving a shared Book');
  const projectId = resolveCollectionId(workspace);
  if (isBlank(slug)) refuse('BookSlug is required.');
  if (!SLUG.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');

  const activeDirectory = `books/${slug}`;
  const archiveDirectory = `archive/${slug}`;
  const session = new McpSession(url, 'pilot-book-archiver');
  await session.initialize();
  const words = { includeFrontmatter: false, stopped: 'archive stopped' };
  const activeRoot = await readExactOrNull(session, projectId, `${activeDirectory}/wiki/_book.md`, words);
  const archiveRoot = await readExactOrNull(session, projectId, `${archiveDirectory}/wiki/_book.md`, words);
  const activeIndex = await readExactOrNull(session, projectId, `${activeDirectory}/wiki/_index.md`, words);
  if (activeRoot === null || activeIndex === null) refuse(`Active Book '${slug}' is incomplete or missing; nothing was archived.`);
  if (archiveRoot !== null) refuse(`Archive already contains '${slug}'; no move was attempted.`);
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Archive Book',
    project_id: projectId,
    book_slug: slug,
    book_title: firstHeading(activeRoot.content) ?? slug,
    active_path: activeDirectory,
    archive_path: archiveDirectory,
    active_catalog_entry_removed: true,
    source_tree_removal: sourceTreeRemoval(workspace, activeDirectory),
    confirmation_required: true,
    shared_library_write: false,
  };
  if (parsed.flags.has('preflight')) return plan;
  if (!parsed.flags.has('user-confirmed')) refuse('Archiving is not yet performed: review the move plan and rerun with -UserConfirmed.');

  // THE CONFIRMED HALF (S39), in the oracle's order: the move, the root found at its new path, the two
  // publisher-owned pages relinked, the reader map proved, the archive Catalog (and its one prose repair),
  // the active Catalog line, and last the husk.
  const bookTitle = firstHeading(activeRoot.content) ?? slug;
  const activeRootPath = `${activeDirectory}/wiki/_book.md`;
  const archiveRootPath = `${archiveDirectory}/wiki/_book.md`;
  const archiveIndexPath = `${archiveDirectory}/wiki/_index.md`;
  let moved = false;
  try {
    const move = await session.callTool('move_note', {
      project_id: projectId,
      identifier: activeDirectory,
      destination_path: archiveDirectory,
      is_directory: true,
      output_format: 'json',
    });
    if (toolRejected(move)) refuse('The native Basic Memory directory move was rejected.');
    moved = true;
    const former = await readExactOrNull(session, projectId, activeRootPath, { ...words, allowRedirect: true });
    if (former !== null && former.file_path !== archiveRootPath) refuse(`The active Book root resolved unexpectedly after the archive move: ${former.file_path}`);
    if ((await readExactOrNull(session, projectId, archiveRootPath, words)) === null) refuse('The archived Book root is missing after the move.');
    await rewritePublisherOwnedLinks(session, projectId, archiveRootPath, activeDirectory, archiveDirectory, words);
    await rewritePublisherOwnedLinks(session, projectId, archiveIndexPath, activeDirectory, archiveDirectory, words);
    await assertReaderMap(session, projectId, archiveIndexPath, archiveDirectory, words);
    const emptinessClaim = await ensureArchiveIndex(session, projectId, archiveDirectory, bookTitle, words);
    await removeActiveBookCatalogEntry(session, projectId, activeDirectory, archiveDirectory, words);
    const husk = sharedHuskCleanup(workspace, activeDirectory);
    return {
      schema: 1,
      operation: 'Archive Book',
      book_slug: slug,
      archive_path: archiveDirectory,
      archive_complete: true,
      active_catalog_updated: true,
      emptiness_claim: emptinessClaim,
      source_tree: husk.source_tree,
      source_tree_removed: husk.status,
    };
  } catch (error) {
    const location = moved
      ? `The native move may have completed at '${archiveDirectory}'; inspect the archive and Catalog before retrying.`
      : 'The active Book was left in place.';
    refuse(`Book archival stopped. ${location} ${(error as Error).message}`);
  }
}

type BookWords = { includeFrontmatter: boolean; stopped: string };

/** PowerShell's `-notin` over the frontmatter keys a rewrite leaves to the server: case-insensitive. */
function isOneOf(name: string, names: string[]): boolean {
  return names.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function frontmatterEntries(frontmatter: unknown): [string, unknown][] {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return [];
  return Object.entries(frontmatter as Record<string, unknown>);
}

/**
 * `Rewrite-PublisherOwnedLinks`: the active path, in the body and in every string of the Book's own
 * metadata, replaced with the archive path by one overwrite. The body is the record's content as read --
 * without frontmatter, since the archiver asks for none, so the strip below does not fire and the leading
 * newline Basic Memory returns is written back (measured S39).
 */
async function rewritePublisherOwnedLinks(
  session: McpSession,
  projectId: string,
  page: string,
  activeDirectory: string,
  archiveDirectory: string,
  words: BookWords,
): Promise<void> {
  const record = await readExactOrNull(session, projectId, page, words);
  if (record === null) refuse(`Archived publisher-owned page '${page}' is missing.`);
  let body = record.content;
  const stripped = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/i.exec(body);
  if (stripped) body = stripped[1]!.replace(/^[\r\n]+/, '');  // `@{}`: a case-insensitive hashtable, so a key repeated in another case is one key, the last one read.
  const metadata = new Map<string, [string, unknown]>();
  for (const [name, value] of frontmatterEntries(record.frontmatter)) {
    if (!isOneOf(name, ['title', 'type', 'permalink', 'tags'])) metadata.set(name.toLowerCase(), [metadata.get(name.toLowerCase())?.[0] ?? name, value]);
  }
  const bodyNeedsRewrite = containsIgnoringCase(body, activeDirectory);
  const metadataNeedsRewrite = [...metadata.values()].some(([, value]) => typeof value === 'string' && containsIgnoringCase(value, activeDirectory));
  if (!bodyNeedsRewrite && !metadataNeedsRewrite) return;
  body = body.split(activeDirectory).join(archiveDirectory);
  const rewritten: Record<string, unknown> = {};
  for (const [name, value] of metadata.values()) rewritten[name] = typeof value === 'string' ? value.split(activeDirectory).join(archiveDirectory) : value;
  const type = field(record.frontmatter, 'type');
  const response = await session.callTool('write_note', {
    project_id: projectId,
    directory: page.substring(0, page.lastIndexOf('/')),
    title: page.substring(page.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''),
    content: body,
    note_type: (type ? type : 'note') as string,
    metadata: rewritten as Record<string, never>,
    overwrite: true,
    output_format: 'json',
  });
  if (toolRejected(response)) refuse(`Archive link update was rejected for '${page}'.`);
  const readback = await readExactOrNull(session, projectId, page, words);
  const stale = frontmatterEntries(readback?.frontmatter).filter(
    ([name, value]) => !isOneOf(name, ['title', 'type', 'permalink']) && typeof value === 'string' && containsIgnoringCase(value, activeDirectory),
  );
  if (containsIgnoringCase(readback?.content ?? '', activeDirectory) || stale.length > 0) {
    refuse(`Archive link readback still contains the active Book path in '${page}'.`);
  }
}

/** `Assert-ReaderMap`: every archive-local page the reader map links, read back at its archive path. */
async function assertReaderMap(session: McpSession, projectId: string, indexPath: string, archiveDirectory: string, words: BookWords): Promise<void> {
  const index = await readExactOrNull(session, projectId, indexPath, words);
  if (index === null) refuse(`Archive reader map '${indexPath}' is missing.`);
  const prefix = `${archiveDirectory}/wiki/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [...index.content.matchAll(new RegExp(`\\[\\[(${prefix}[^\\]|]+)`, 'g'))].map((match) => match[1]!);
  // `Sort-Object -Unique`: case-insensitive, so two targets differing only in case are read once.
  const targets: string[] = [];
  for (const candidate of found.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))) {
    if (!targets.some((kept) => kept.toLowerCase() === candidate.toLowerCase())) targets.push(candidate);
  }
  if (targets.length === 0) refuse('Archive reader map contains no archive-local links.');
  for (const target of targets) {
    if ((await readExactOrNull(session, projectId, `${target}.md`, words)) === null) refuse(`Archive reader map links to a missing page: ${target}.md`);
  }
}

/** `Get-Date -Format 'yyyy-MM-dd'`: the local date. */
function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** `Ensure-ArchiveIndex`: `archive/README` created with the entry, or the entry inserted under its heading. */
async function ensureArchiveIndex(session: McpSession, projectId: string, archiveDirectory: string, bookTitle: string, words: BookWords): Promise<string> {
  const link = `[[${archiveDirectory}/wiki/_book|${bookTitle}]]`;
  const entry = `- ${link} — Archived ${localDate()}`;
  let index = await readExactOrNull(session, projectId, 'archive/README.md', words);
  if (index === null) {
    const body = `# Archive\n\nInactive Books remain available here when you need them again.\n\n## Archived Books\n\n${entry}\n`;
    const response = await session.callTool('write_note', {
      project_id: projectId,
      directory: 'archive',
      title: 'README',
      content: body,
      note_type: 'note',
      overwrite: false,
      output_format: 'json',
    });
    if (toolRejected(response)) refuse('Archive index creation was rejected.');
    if (String(field(field(field(field(response, 'result'), 'structuredContent'), 'result'), 'action') ?? '') === 'conflict') {
      refuse("Write 'archive/README' was refused: a note already exists there, written by someone else since this run read the collection. Nothing was overwritten.");
    }
  } else if (!containsIgnoringCase(index.content, link)) {
    const response = /^## Archived Books\s*$/im.test(index.content)
      ? await session.callTool('edit_note', {
          project_id: projectId,
          identifier: 'archive/README',
          operation: 'find_replace',
          content: `## Archived Books\n\n${entry}`,
          output_format: 'json',
          find_text: '## Archived Books',
          expected_replacements: 1,
        })
      : await session.callToolOnce('edit_note', {
          project_id: projectId,
          identifier: 'archive/README',
          operation: 'append',
          content: `\n## Archived Books\n\n${entry}\n`,
          output_format: 'json',
        });
    if (toolRejected(response)) refuse('Archive index update was rejected.');
  }
  index = await readExactOrNull(session, projectId, 'archive/README.md', words);
  if (index === null || !containsIgnoringCase(index.content, link)) refuse('Archive index readback did not include the Book.');
  // Last, on the readback that just proved the entry: a failed repair costs a sentence, never an entry.
  return repairEmptinessClaim(session, projectId, index.content, words);
}

// The pilot-era sentence, in its two spellings; the leading-space one first, as the wider match.
const ARCHIVE_EMPTINESS_CLAIMS = [' The initial pilot has no archived content.', 'The initial pilot has no archived content.'];

/** `Get-EmptinessClaimRepair`: the one known sentence, exactly once, or nothing. */
function emptinessClaimRepair(catalogText: string): { status: 'absent' | 'ready' | 'ambiguous'; findText: string | null; occurrences: number } {
  if (!catalogText) return { status: 'absent', findText: null, occurrences: 0 };
  for (const claim of ARCHIVE_EMPTINESS_CLAIMS) {
    const count = catalogText.split(claim).length - 1;
    if (count === 0) continue;
    return { status: count === 1 ? 'ready' : 'ambiguous', findText: claim, occurrences: count };
  }
  return { status: 'absent', findText: null, occurrences: 0 };
}

/** `Repair-EmptinessClaim`: never throws, and reports what happened as `emptiness_claim`. */
async function repairEmptinessClaim(session: McpSession, projectId: string, catalogText: string, words: BookWords): Promise<string> {
  const repair = emptinessClaimRepair(catalogText);
  if (repair.status !== 'ready') return repair.status === 'ambiguous' ? `not-repaired: the emptiness sentence appears ${repair.occurrences} times` : 'absent';
  try {
    const response = await session.callTool('edit_note', {
      project_id: projectId,
      identifier: 'archive/README',
      operation: 'find_replace',
      find_text: repair.findText!,
      content: '',
      expected_replacements: 1,
      output_format: 'json',
    });
    if (toolRejected(response)) throw new Error('the shared Library rejected the edit');
    const index = await readExactOrNull(session, projectId, 'archive/README.md', words);
    if (index === null) throw new Error('the catalog could not be read back');
    return emptinessClaimRepair(index.content).status === 'absent' ? 'repaired' : 'not-repaired: the sentence survived readback';
  } catch (error) {
    return `not-repaired: ${(error as Error).message}`;
  }
}

/** `Remove-ActiveCatalogEntry` (Archive-SharedBook.ps1): the Book's one Catalog line, removed exactly. */
async function removeActiveBookCatalogEntry(session: McpSession, projectId: string, activeDirectory: string, archiveDirectory: string, words: BookWords): Promise<void> {
  const activeLink = `[[${activeDirectory}/wiki/_book|`;
  const archiveLink = `[[${archiveDirectory}/wiki/_book|`;
  const names = (content: string) => containsIgnoringCase(content, activeLink) || containsIgnoringCase(content, archiveLink);
  const catalog = await readExactOrNull(session, projectId, 'books/README.md', words);
  if (catalog === null) refuse('The Book Catalog is missing; archive stopped.');
  const links = catalog.content.split(/\r?\n/).filter(names);
  if (links.length > 1) refuse('The active Book Catalog has more than one matching entry; archive stopped without changing the Catalog.');
  if (links.length === 1) {
    const response = await session.callTool('edit_note', {
      project_id: projectId,
      identifier: 'books/README',
      operation: 'find_replace',
      find_text: links[0]!,
      content: '',
      expected_replacements: 1,
      output_format: 'json',
    });
    if (toolRejected(response)) refuse('Active Book Catalog update was rejected.');
  }
  const after = await readExactOrNull(session, projectId, 'books/README.md', words);
  if (names(after?.content ?? '')) refuse('Active Book Catalog readback still includes the archived Book.');
}

// --- library shared list-entry --------------------------------------------------------------------------

export async function sharedListEntry(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['title', 'summary', 'kind', 'collection', 'workspace']);
  const url = resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'listing a Catalog entry');
  const projectId = resolveCollectionId(workspace);
  const slug = parsed.positional[0] ?? '';
  const kind = (parsed.options.get('kind') ?? 'book').toLowerCase();
  if (kind !== 'book' && kind !== 'project') refuse(`library shared list-entry --kind is book or project; got '${kind}'.`);
  const collectionWord = parsed.options.get('collection') ?? 'Reference';
  const collection = ['Projects', 'Reference', 'Workflows'].find((name) => name.toLowerCase() === collectionWord.toLowerCase());
  if (collection === undefined) refuse(`library shared list-entry --collection is Projects, Reference or Workflows; got '${collectionWord}'.`);
  if (isBlank(slug)) refuse('Slug is required.');
  if (!SLUG.test(slug)) refuse('Slug must use lowercase letters, digits, and single hyphens.');

  const isBook = kind === 'book';
  const root = isBook ? `books/${slug}` : `projects/${slug}`;
  const rootPage = isBook ? `${root}/wiki/_book.md` : `${root}/_project.md`;
  const catalogPath = isBook ? 'books/README.md' : 'projects/README.md';
  const linkTarget = isBook ? `${root}/wiki/_book` : `${root}/_project`;
  const heading = isBook ? `## ${collection}` : '## Projects';

  const session = new McpSession(url, 'library-catalog-lister');
  await session.initialize();
  const words = { includeFrontmatter: false, stopped: 'listing stopped' };
  const rootRecord = await readExactOrNull(session, projectId, rootPage, words);
  if (rootRecord === null) refuse(`'${rootPage}' does not exist; nothing was listed.`);
  let title = parsed.options.get('title') ?? '';
  if (isBlank(title)) title = firstHeading(rootRecord.content) ?? slug;
  const catalog = await readExactOrNull(session, projectId, catalogPath, words);
  if (catalog === null) refuse(`The Catalog '${catalogPath}' is missing; nothing was listed.`);
  const catalogBody = catalog.content;
  // `-match`: case-insensitive, as the oracle's is. A line naming the link in another case counts.
  const alreadyListed = catalogBody.toLowerCase().includes(`[[${linkTarget}|`.toLowerCase());
  const summary = parsed.options.get('summary') ?? '';
  const entry = isBlank(summary) ? `- [[${linkTarget}|${title}]]` : `- [[${linkTarget}|${title}]] — ${summary.trim()}`;
  const headingPresent = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(catalogBody);
  const operation = `List an existing ${isBook ? 'Book' : 'Project Hub'} in its Catalog`;
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation,
    root,
    title,
    catalog_path: catalogPath,
    heading,
    heading_present: headingPresent,
    entry,
    already_listed: alreadyListed,
    action: alreadyListed ? 'none (already listed)' : headingPresent ? `insert one line under '${heading}'` : `create '${heading}' and insert one line`,
    confirmation_required: !alreadyListed,
    destructive: false,
    shared_library_write: !alreadyListed,
    scope: 'Adds exactly one Catalog line. Removes nothing and rewrites no other entry.',
  };
  if (parsed.flags.has('preflight')) return plan;
  if (alreadyListed) return { schema: 1, operation, root, catalog_path: catalogPath, already_listed: true, changed: false };
  if (!parsed.flags.has('user-confirmed')) refuse('Nothing was listed: review the preflight and rerun with -UserConfirmed.');

  // THE CONFIRMED HALF (S39): one edit, never a rewrite -- a find_replace on the heading when it is there,
  // an append (never retried, being non-idempotent) when it is not -- and the entry read back.
  const identifier = catalogPath.substring(0, catalogPath.length - 3);
  const response = headingPresent
    ? await session.callTool('edit_note', {
        project_id: projectId,
        identifier,
        operation: 'find_replace',
        find_text: heading,
        content: `${heading}\n\n${entry}`,
        expected_replacements: 1,
        output_format: 'json',
      })
    : await session.callToolOnce('edit_note', {
        project_id: projectId,
        identifier,
        operation: 'append',
        content: `\n${heading}\n\n${entry}\n`,
        output_format: 'json',
      });
  if (toolRejected(response)) refuse(`The Catalog edit was rejected for '${catalogPath}'.`);
  const after = await readExactOrNull(session, projectId, catalogPath, words);
  if (after === null || !containsIgnoringCase(after.content, `[[${linkTarget}|`)) refuse('The Catalog readback does not contain the new entry.');
  return { schema: 1, operation, root, title, catalog_path: catalogPath, heading, entry, changed: true };
}
