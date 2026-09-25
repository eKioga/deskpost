/**
 * The validated reader: the only route to Book and Project content.
 *
 * TWO DOORS, ONE DISPATCH. `library mcp call <tool> ...` answers one request with the adapter's response
 * envelope, which is how most reader rows ask their question without measuring a transport; `library mcp
 * serve` (S36, `mcpserve.ts`) is the stdio server a harness launches. Both answer through
 * `answerReaderTool` with a `ReaderContext` resolved as the adapter resolves it per request -- an explicit
 * seat, then this process's agent's binding BY ANCESTRY, then LIBRARY_SEAT -- and both read the Desk
 * through `deskState`, the adapter's `Get-DeskState`. Until S36 `mcp call` refused every tool without a
 * seat and skipped the Desk checks; the adapter serves the Shelf catalog to a seatless session and
 * refuses the rest at the first read that needs a Desk, and so does this now.
 *
 * WHAT THE GUARD IS, CARRIED RATHER THAN RE-DECIDED:
 *
 *   A CLOSED BOOK IS UNAVAILABLE. The Desk is consulted before any content is read, and a Book that
 *   no open root names is refused by name.
 *
 *   THERE IS NO DEFAULT SEAT. A seatless session reads the workspace's own files and nothing else,
 *   because a default would silently merge stray work into whichever seat holds it.
 *
 *   A REFUSAL NAMES WHICH OF TWO THINGS IS WRONG. A malformed slug and a ROOT passed where a slug
 *   goes are different mistakes with different fixes, and sharing one sentence sent readers to the
 *   wrong one for as long as they shared it.
 *
 *   AN AMBIGUOUS SLUG IS REFUSED RATHER THAN CHOSEN BETWEEN. `books/notes`, `archive/notes` and
 *   `shelf/notes` are three different Books that happen to share a name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { readMarker, requireWorkspace } from './workspace.ts';
import { openCollection, readLocalProjectCatalog } from './collection.ts';
import { deskFileEntries, deskFileName, deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { resolveAgentClientProcess } from './procstart.ts';
import { findOpenBookLines, formatFullTextResult } from './fulltext.ts';
import { findBookPages, formatDiscoveryResult } from './discovery.ts';
import { deskPin, McpSession, readValidatedRecord, resolveMcpUrl } from './basicmemory.ts';
import { psSortCompare } from './pssort.ts';
import { hostRemedies } from './remedy.ts';

export interface McpResult {
  refusal: string | null;
  value: PsJsonValue | null;
  exitCode: number;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ROOT_PATTERN = /^(?:shelf\/_archive|books|archive|shelf)\/[a-z0-9][a-z0-9-]*$/;
const ROOT_ACCEPT_PATTERN = /^(?:(?:shelf\/_archive|books|archive|shelf)\/)?[a-z0-9][a-z0-9-]*$/;

class ReaderRefusal extends Error {}

function refuse(message: string): never {
  throw new ReaderRefusal(message);
}

interface BookRoot {
  root: string;
  collection: 'shelf' | 'shared';
  shelf: 'active' | 'archive';
  slug: string;
  wikiRoot: string;
}

function toBookRoot(entry: string): string {
  if (ROOT_PATTERN.test(entry)) return entry;
  if (SLUG_PATTERN.test(entry)) return `books/${entry}`;
  refuse('Virtual Desk open-book state is malformed.');
}

function splitBookRoot(entry: string): BookRoot {
  const normalised = toBookRoot(entry);
  const match = /^(shelf\/_archive|books|archive|shelf)\/([a-z0-9][a-z0-9-]*)$/.exec(normalised);
  if (!match) refuse('Virtual Desk open-book state is malformed.');
  const prefix = match[1]!;
  const slug = match[2]!;
  const collection = prefix === 'shelf' || prefix === 'shelf/_archive' ? 'shelf' : 'shared';
  const shelf = prefix === 'archive' || prefix === 'shelf/_archive' ? 'archive' : 'active';
  return { root: normalised, collection, shelf, slug, wikiRoot: `${normalised}/wiki` };
}

function assertBookSlug(slug: string): void {
  if (SLUG_PATTERN.test(slug)) return;
  if (ROOT_PATTERN.test(slug)) {
    refuse(
      `'${slug}' is a Book ROOT, not a slug -- pass '${splitBookRoot(slug).slug}'. Discovery and the ` +
        "Catalogs print the root because that is the Book's identity; this surface takes the bare slug, " +
        'and refuses it as ambiguous when more than one open Book shares it.',
    );
  }
  // Anything else carrying a slash is DESCRIBED rather than diagnosed: a Project root reaches this
  // too, and claiming an arbitrary prefix is a valid root would be a second wrong reason.
  const tail = /^.+\/([a-z0-9][a-z0-9-]*)$/.exec(slug);
  if (tail) {
    refuse(
      `'${slug}' reads as a root rather than a slug -- pass '${tail[1]}' if that is the Book or ` +
        'Project you mean. A slug carries no slash.',
    );
  }
  refuse(`Slug '${slug}' is malformed: lowercase letters, digits and hyphens only, starting with a letter or a digit.`);
}

function assertPage(page: string): void {
  if (
    !page ||
    !page.trim() ||
    /[\\\x00-\x1F]/.test(page) ||
    page.startsWith('/') ||
    page.endsWith('/') ||
    /(^|\/)\.{1,2}($|\/)/.test(page) ||
    page.endsWith('.md')
  ) {
    refuse('Page must be a canonical Book page path without the .md extension.');
  }
}

// --- the Desk, as the adapter reads it (S36) ---------------------------------------------------------

/**
 * WHO IS ASKING, resolved once per request as the adapter resolves it: the workspace, its `.claude`, and
 * the seat's Desk directory -- or, with no seat, the resolver's own sentence, raised at the first read
 * that needs a Desk and at no other. The Shelf catalog needs none, and is served to a seatless session.
 */
export interface ReaderContext {
  workspace: string;
  stateDirectory: string;
  deskDirectory: string | null;
  seatMessage: string;
}

/** `Update-AdapterSeatResolution`: the seat from `--seat`, then THIS process's agent's binding (by ancestry only), then LIBRARY_SEAT. */
export function readerContext(workspace: string, stateDirectory: string, seat: string | undefined): ReaderContext {
  // ANCESTRY ONLY: an MCP server is given no CLAUDE_PID of its own, so a value in its environment was
  // inherited from whatever launched the client, and would resolve another agent's binding.
  const agent = resolveAgentClientProcess().agentPid;
  const resolved = resolveSeatName({ seat, stateDirectory, agentPid: agent });
  return {
    workspace,
    stateDirectory,
    deskDirectory: resolved.status === 'named' ? deskStateDirectory(stateDirectory, resolved.seat!) : null,
    seatMessage: resolved.message,
  };
}

interface DeskState {
  projectId: string;
  openBooks: string[];
  openProjects: string[];
}

/** `Get-DeskState`: the seat gate, then `.open-books`, the workspace's pin, and `.open-projects` (written empty when missing, as the oracle writes it). */
function deskState(context: ReaderContext): DeskState {
  if (!context.deskDirectory) refuse(context.seatMessage);
  const booksFile = path.join(context.deskDirectory, deskFileName('books'));
  const projectsFile = path.join(context.deskDirectory, deskFileName('projects'));
  if (!fs.existsSync(booksFile) || !fs.statSync(booksFile).isFile()) refuse('Virtual Desk configuration is missing .open-books.');
  const projectId = collectionPin(context);
  const openBooks = deskFileEntries(booksFile).map((line) => toBookRoot(line));
  if (new Set(openBooks).size !== openBooks.length) refuse('Virtual Desk open-book state contains duplicates.');
  if (!fs.existsSync(projectsFile) || !fs.statSync(projectsFile).isFile()) writeAtomicText(projectsFile, '');
  const openProjects = deskFileEntries(projectsFile);
  for (const root of openProjects) if (!/^(projects|archive\/projects)\/[a-z0-9][a-z0-9-]*$/.test(root)) refuse('Virtual Desk open-project state is malformed.');
  if (new Set(openProjects).size !== openProjects.length) refuse('Virtual Desk open-project state contains duplicates.');
  return { projectId, openBooks, openProjects };
}

/** `Get-DeskProjectId`: the seat gate, then the pin, for a read that needs no Desk FILE. */
function deskProjectId(context: ReaderContext): string {
  if (!context.deskDirectory) refuse(context.seatMessage);
  return collectionPin(context);
}

/**
 * THE COLLECTION A READ ADDRESSES, ON EITHER BACKEND (S46, ADR-0044). A workspace attached to its local
 * collection has no Basic Memory pin -- a Tier 0 init writes none -- and asking for one refused every read
 * of the default route. The marker says which backend the workspace is attached to, and it is the only
 * authority: a stray `.library-project` in a local workspace is not a reason to reach for Basic Memory.
 */
function isLocalCollection(context: ReaderContext): boolean {
  const marker = readMarker(context.workspace);
  return marker !== null && String(marker['backend'] ?? '') === 'local';
}

function collectionPin(context: ReaderContext): string {
  return isLocalCollection(context) ? openCollection(context.workspace).id : deskPin(context.stateDirectory);
}

/**
 * One exact record of the collection, `readValidatedRecord`'s contract on either backend: 'absent' for a
 * record that is not there, the refusal the caller named for an empty one. A local record is resolved
 * segment by segment in its on-disk spelling and must stay inside the collection, as a Shelf page must.
 */
async function readCollectionRecord(
  context: ReaderContext,
  projectId: string,
  requested: string,
  words: { rejected: string; unreadable: string; different: string; empty: string },
): Promise<{ content: string } | 'absent'> {
  if (!isLocalCollection(context)) return readValidatedRecord(await remoteSession(context.workspace), projectId, requested, words);
  const collectionRoot = path.resolve(openCollection(context.workspace).root);
  const exact = exactRelativePath(collectionRoot, `${requested}.md`);
  if (!exact || !fs.statSync(exact).isFile()) return 'absent';
  if (!path.resolve(exact).startsWith(collectionRoot + path.sep)) refuse(words.different);
  const content = fs.readFileSync(exact, 'utf8').replace(/^\uFEFF/, '');
  if (!content.trim()) refuse(words.empty);
  return { content };
}

// --- Books -----------------------------------------------------------------------------------------------

/**
 * `Resolve-ExactRelativePath`: the path, confirmed segment by segment in its on-disk spelling. Windows
 * opens `Alpha.md` for `alpha.md`; an exact read must not.
 */
function exactRelativePath(root: string, relative: string): string | null {
  let current = root;
  for (const segment of relative.split('/')) {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return null;
    const matches = fs.readdirSync(current).filter((name) => name === segment);
    if (matches.length !== 1) return null;
    current = path.join(current, matches[0]!);
  }
  return current;
}

/** `Read-ShelfBookPage`: the exact page, resolved from the WORKSPACE against the Book's wiki root. */
function readShelfBookPage(workspace: string, wikiRoot: string, page: string): string {
  if (!fs.existsSync(path.join(workspace, 'shelf')) || !fs.statSync(path.join(workspace, 'shelf')).isDirectory()) refuse('This workspace has no local Shelf.');
  const exact = exactRelativePath(workspace, `${wikiRoot}/${page}.md`);
  if (!exact || !fs.statSync(exact).isFile()) refuse('That page is not in this Book.');
  const bookWikiRoot = path.resolve(workspace, ...wikiRoot.split('/'));
  if (!path.resolve(exact).startsWith(bookWikiRoot + path.sep)) refuse('The resolved page lies outside this Book; its content was withheld.');
  const content = fs.readFileSync(exact, 'utf8').replace(/^﻿/, '');
  if (!content.trim()) refuse('The exact Shelf Book page has no readable content.');
  return content;
}

async function remoteSession(workspace: string): Promise<McpSession> {
  const session = new McpSession(resolveMcpUrl(workspace), 'ai-library-validated-book-reader');
  await session.initialize();
  return session;
}

/** `Read-ValidatedBookPage`: a page of a Book open at this seat, from the Shelf or from Basic Memory. */
async function readValidatedBookPage(context: ReaderContext, slug: string, page: string): Promise<string> {
  assertBookSlug(slug);
  assertPage(page);
  const state = deskState(context);
  const roots = state.openBooks.filter((entry) => splitBookRoot(entry).slug === slug);
  if (roots.length === 0) refuse(`Book '${slug}' is closed.`);
  if (roots.length !== 1) refuse(`Book '${slug}' is ambiguous; close one location before reading.`);
  const bookRoot = splitBookRoot(roots[0]!);
  if (bookRoot.collection === 'shelf') return readShelfBookPage(context.workspace, bookRoot.wikiRoot, page);
  const record = await readCollectionRecord(context, state.projectId, `${bookRoot.wikiRoot}/${page}`, {
    rejected: 'The shared Library rejected this exact page request.',
    unreadable: 'The shared Library returned an unreadable page response.',
    different: 'The shared Library returned a different record; its content was withheld.',
    empty: 'The exact shared Book page has no readable content.',
  });
  if (record === 'absent') refuse('That page is not in this Book.');
  return record.content;
}

function readShelfCatalog(workspace: string): string {
  const file = path.join(workspace, 'shelf', '_catalog.md');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) refuse('The local Shelf catalog has not been created yet.');
  const content = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!content.trim()) refuse('The local Shelf catalog has no readable content.');
  return content;
}

/** `Read-SharedBookCatalog`: the Book Catalog, or the archive's, named by the record that was asked for. */
async function readSharedBookCatalog(context: ReaderContext, requested: string): Promise<string> {
  const state = deskState(context);
  const what = requested === 'books/README' ? 'Book Catalog' : `record ${requested}.md`;
  const record = await readCollectionRecord(context, state.projectId, requested, {
    rejected: `The shared Library rejected the exact ${what} request.`,
    unreadable: `The shared Library returned an unreadable ${what} response.`,
    different: 'The shared Library returned a different record; its content was withheld.',
    empty: `The exact shared ${what} has no readable content.`,
  });
  if (record === 'absent') refuse(`The ${what} has not been created yet.`);
  return record.content;
}

const ARCHIVE_CATALOG_NOTE =
  "\n\nThis is the SHARED collection's archive. Archived Books here can be opened with Set-VirtualDesk -Location Archive. The local Shelf keeps its own separate archive; list it with tools/Archive-ShelfBook.ps1 -Action List. discover_book_pages covers archived Books in both archives and labels every archived hit ARCHIVED; each answer states which archives it actually searched, and names tools/Update-SharedBookManifests.ps1 -IncludeArchive when this one has no manifests yet. search_open_books reaches an archived Book only while it is open on the Desk.";

/** `Read-ValidatedBookCatalog`: `shelf`, `archive`, `shared`, or anything else as `all`. */
async function readValidatedBookCatalog(context: ReaderContext, location: string): Promise<string> {
  if (location === 'shelf') return readShelfCatalog(context.workspace);
  if (location === 'archive') return (await readSharedBookCatalog(context, 'archive/README')) + ARCHIVE_CATALOG_NOTE;
  if (location === 'shared') return readSharedBookCatalog(context, 'books/README');
  const shared = await readSharedBookCatalog(context, 'books/README');
  // The Shelf is local and must not make the whole catalog unreadable if it is absent.
  let shelf: string;
  try {
    shelf = readShelfCatalog(context.workspace);
  } catch (error) {
    shelf = `# Local Shelf\n\n${(error as Error).message}`;
  }
  return (
    shared + '\n\n---\n\n' + shelf +
    '\n\nShared Books open with -Location Shared; Shelf Books open with -Location Shelf. Both are read through read_open_book_page.'
  );
}

// --- Projects against Basic Memory (S33) -------------------------------------------------------------------
//
// The adapter's `Read-ValidatedProjectCatalog`, `Read-ValidatedProjectPage` and `Get-ProjectReturnBriefing`.
// The collection a read addresses is the DESK's pin, and every record is validated exactly: an absent note is
// absent, a record for another path is withheld.

/** `Read-ValidatedProjectCatalog`: the active or archived Project Catalog, exactly as written. */
async function readSharedProjectCatalog(context: ReaderContext, shelf: 'active' | 'archive'): Promise<string> {
  const projectId = deskProjectId(context);
  const requested = shelf === 'archive' ? 'archive/projects/README' : 'projects/README';
  const record = await readCollectionRecord(context, projectId, requested, {
    rejected: 'The shared Library rejected this exact Project Catalog request.',
    unreadable: 'The shared Library returned an unreadable Project Catalog response.',
    different: 'The shared Library returned a different Project Catalog record; its content was withheld.',
    empty: 'The exact shared Project Catalog has no readable content.',
  });
  if (record === 'absent') {
    if (shelf === 'archive') {
      return '# Archived Projects\n\nNo Projects have been archived yet.\n\nThis list is created the first time you archive a Project.';
    }
    refuse('The active Project Catalog has not been created yet.');
  }
  return record.content;
}

/** `Read-ValidatedProjectPage`: one exact page of a Project open at this seat. */
async function readSharedProjectPage(context: ReaderContext, slug: string, page: string): Promise<{ path: string; content: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) refuse('Project slug is malformed.');
  assertPage(page);
  const state = deskState(context);
  // CASE-INSENSITIVE, as the oracle's `-match` is. Carried, not corrected: every root on a Desk has
  // already passed the lowercase pattern, so no spelling reaches here that it would change.
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const roots = state.openProjects.filter((root) => new RegExp(`/(?:${escaped})$`, 'i').test(root));
  if (roots.length === 0) refuse(`Project '${slug}' is closed.`);
  if (roots.length !== 1) refuse(`Project '${slug}' is ambiguous; close one location before reading.`);
  const requested = `${roots[0]}/${page}`;
  const record = await readCollectionRecord(context, state.projectId, requested, {
    rejected: 'The shared Library rejected this exact Project page request.',
    unreadable: 'The shared Library returned an unreadable Project page response.',
    different: 'The shared Library returned a different Project record; its content was withheld.',
    empty: 'The exact shared Project page has no readable content.',
  });
  if (record === 'absent') refuse('That page is not in this Project.');
  return { path: requested, content: record.content };
}

/** `Get-MarkdownSectionItems`: a section's bullets, each with its wrapped continuation lines. */
function sectionItems(content: string | null, heading: string): string[] {
  if (content === null) return [];
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'm').exec(content);
  if (!match) return [];
  const items: string[] = [];
  let current: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^-\s+.+/.test(trimmed)) {
      if (current !== null) items.push(current);
      current = trimmed;
    } else if (current !== null) {
      if (!trimmed || /^#{1,6}\s/.test(trimmed)) {
        items.push(current);
        current = null;
      } else {
        current = `${current} ${trimmed}`;
      }
    }
  }
  if (current !== null) items.push(current);
  return items;
}

function briefingSection(label: string, items: string[]): string {
  if (items.length === 0) return `- ${label}: none recorded.`;
  const shown = items.slice(0, 5);
  const lines = [`- ${label}:`, ...shown.map((item) => `  ${item}`)];
  if (items.length > shown.length) lines.push(`  - and ${items.length - shown.length} more.`);
  return lines.join('\n');
}

/** `Get-ProjectReturnBriefing`: the Hub's recorded connections, from its root or its connections page. */
async function readSharedProjectBriefing(context: ReaderContext, slug: string): Promise<string> {
  const root = await readSharedProjectPage(context, slug, '_project');
  const titleMatch = /^#\s+(.+?)\s*$/m.exec(root.content);
  const title = titleMatch ? titleMatch[1]!.trim() : slug;
  // EITHER ROOT HEADING KEEPS BOTH SECTIONS ON THE ROOT: falling through section by section would hide a
  // half-finished migration by combining two pages.
  const onRoot = /^##\s+Connected knowledge\s*\r?$/m.test(root.content) || /^##\s+Connected tools\s*\r?$/m.test(root.content);
  let knowledge = sectionItems(root.content, 'Connected knowledge');
  let tools = sectionItems(root.content, 'Connected tools');
  if (!onRoot) {
    const connections = await readSharedProjectPage(context, slug, 'connections');
    knowledge = sectionItems(connections.content, 'Connected knowledge');
    tools = sectionItems(connections.content, 'Connected tools');
  }
  return (
    `Project return briefing - ${title}\n\n` +
    briefingSection('Related Books to consider opening', knowledge) +
    '\n' +
    briefingSection('Connected tools', tools) +
    '\n\n' +
    'These are recorded project connections only; no additional Books were opened automatically.'
  );
}

// --- suggest_active_projects (S38) -----------------------------------------------------------------------------
//
// The adapter's `Get-ProjectSuggestions`, `Get-ProjectSearchTerms` and `Get-ProjectPurposeExcerpt`. It reads
// catalog-class material -- the active Project Catalog and each listed Hub's root -- through the Desk's pin,
// returns pointers, and opens nothing. WHAT IT CONCEDES: .NET's `\b` is Unicode-aware and is reproduced with
// .NET's `\w` class; `ToLowerInvariant` is JavaScript's `toLowerCase`, which differs from it on a handful of
// characters no row reaches; and a tie in score AND title is left in the order JavaScript's stable sort gives.

/** .NET's `\w`, which its `\b` is built on: letters, non-spacing marks, decimal digits and connectors. */
const DOTNET_WORD = '[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]';

function wholeWordCount(text: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`(?<!${DOTNET_WORD})${escaped}(?!${DOTNET_WORD})`, 'gu')) ?? []).length;
}

/** `Get-ProjectSearchTerms`: the query's lowercase words of two or more ASCII letters or digits, once each. */
function projectSearchTerms(query: string): string[] {
  if (!query.trim() || query.length > 160 || /[\x00-\x1F]/.test(query)) {
    refuse('Project search words must be between 1 and 160 printable characters.');
  }
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
}

/** `Get-ProjectPurposeExcerpt`: the Purpose section's prose on one line, bullets dropped, at most 240 characters. */
function projectPurposeExcerpt(content: string): string {
  const match = /^##\s+Purpose\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/m.exec(content);
  if (!match) return '';
  const text = match[1]!
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[-*]\s/.test(line))
    .join(' ')
    .trim();
  return text.length > 240 ? text.substring(0, 237).trimEnd() + '...' : text;
}

/** `Get-ProjectSuggestions`: up to five active Hubs ranked against the reader's words. */
async function suggestActiveProjects(context: ReaderContext, query: string): Promise<string> {
  const terms = projectSearchTerms(query);
  const catalog = await readSharedProjectCatalog(context, 'active');
  const listed = [...catalog.matchAll(/^\s*-\s+\[\[projects\/([a-z0-9][a-z0-9-]*)\/_project\|([^\]\r\n]+)\]\]\s*$/gm)].map((match) => ({
    slug: match[1]!,
    title: match[2]!.trim(),
  }));
  // `Sort-Object slug -Unique`: the measured order, and one entry per slug, case-insensitively.
  const entries: { slug: string; title: string }[] = [];
  for (const entry of [...listed].sort((a, b) => psSortCompare(a.slug, b.slug))) {
    if (!entries.some((kept) => kept.slug.toLowerCase() === entry.slug.toLowerCase())) entries.push(entry);
  }
  if (entries.length === 0) return '# Active Project suggestions\n\nThere are no active Projects to search. No Project was opened.';
  if (entries.length > 25) refuse('The active Project Catalog has more than 25 entries; narrow discovery before requesting suggestions.');

  const projectId = deskProjectId(context);
  const suggestions: { slug: string; title: string; score: number; matched: string[]; purpose: string }[] = [];
  for (const entry of entries) {
    const record = await readCollectionRecord(context, projectId, `projects/${entry.slug}/_project`, {
      rejected: 'The shared Library rejected this exact active Project root request.',
      unreadable: 'The shared Library returned an unreadable active Project root response.',
      different: 'The shared Library returned a different active Project record; its content was withheld.',
      empty: 'The exact active Project root has no readable content.',
    });
    if (record === 'absent') refuse(`Active Project '${entry.slug}' is missing its root note.`);
    const titleMatch = /^#\s+(.+?)\s*$/m.exec(record.content);
    const title = titleMatch ? titleMatch[1]!.trim() : entry.title;
    const identity = `${entry.slug} ${title}`.toLowerCase();
    const body = record.content.toLowerCase();
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const identityMatches = wholeWordCount(identity, term);
      const bodyMatches = wholeWordCount(body, term);
      if (identityMatches + bodyMatches > 0) {
        if (!matched.includes(term)) matched.push(term);
        score += 10 * identityMatches + Math.min(bodyMatches, 3);
      }
    }
    if (score > 0) suggestions.push({ slug: entry.slug, title, score, matched, purpose: projectPurposeExcerpt(record.content) });
  }
  const ranked = suggestions.sort((a, b) => b.score - a.score || psSortCompare(a.title, b.title)).slice(0, 5);
  if (ranked.length === 0) return `# Active Project suggestions\n\nNo active Project matched '${query}'. No Project was opened.`;
  const lines = ['# Active Project suggestions', '', `Matches for '${query}':`];
  for (const suggestion of ranked) {
    lines.push(`- ${suggestion.title} [${suggestion.slug}]: matched ${suggestion.matched.join(', ')}.`);
    if (suggestion.purpose.trim()) lines.push(`  Purpose: ${suggestion.purpose}`);
  }
  lines.push('', 'No Project was opened. Ask the reader which Project to open.');
  return lines.join('\n');
}

// --- one tool call -----------------------------------------------------------------------------------------

/** How a tool reads its arguments: `Get-RequiredArgument` and `Get-OptionalArgument`, whatever carried them. */
export interface ReaderArguments {
  required(name: string): string;
  optional(name: string): unknown;
}

/** `max_results`: a whole number or the default of 50, as `[int]::TryParse([string]$value)` reads it. */
function resultCap(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
  if (!/^\s*[+-]?\d+\s*$/.test(text) || Math.abs(Number(text)) > 2147483647) refuse('max_results must be a whole number.');
  return Number(text);
}

/**
 * THE ONE DISPATCH both `mcp call` and `mcp serve` answer through: the tool's text, or a throw carrying
 * the refusal. A tool name and a `location` are matched case-insensitively, as the adapter's `switch` does.
 */
export async function answerReaderTool(context: ReaderContext, tool: string, args: ReaderArguments): Promise<string> {
  switch (tool.toLowerCase()) {
    case 'read_book_catalog': {
      const location = args.optional('location');
      const named = location === null || location === undefined ? '' : String(location).toLowerCase();
      return readValidatedBookCatalog(context, ['shared', 'shelf', 'archive'].includes(named) ? named : 'all');
    }
    case 'read_open_book_page':
      return readValidatedBookPage(context, args.required('slug'), args.required('page'));
    case 'read_project_catalog': {
      // A Project Hub lives in the collection the workspace is attached to: the local collection in Tier 0
      // (ADR-0030, S30), which the adapter has no counterpart for, and Basic Memory otherwise (S33).
      const shelf = args.optional('shelf');
      const archived = shelf !== null && shelf !== undefined && String(shelf).toLowerCase() === 'archive';
      if (!archived && isLocalCollection(context)) return readLocalProjectCatalog(context.workspace);
      return readSharedProjectCatalog(context, archived ? 'archive' : 'active');
    }
    case 'suggest_active_projects': {
      // THE LOCAL COLLECTION IS RANKED BY THE SAME RULE (S46): until ADR-0044 a Tier 0 workspace was refused
      // here by name, because no oracle reads a local collection; on the default route that refusal was the
      // first answer a stranger got. The rule is the adapter's, compared on Basic Memory by two shared rows,
      // and the records it reads come from whichever collection the workspace is attached to.
      return suggestActiveProjects(context, args.required('query'));
    }
    case 'read_open_project_page':
      return (await readSharedProjectPage(context, args.required('slug'), args.required('page'))).content;
    case 'read_open_project_briefing':
      return readSharedProjectBriefing(context, args.required('slug'));
    case 'search_open_books': {
      const query = args.required('query');
      const cap = resultCap(args.optional('max_results'));
      if (!context.deskDirectory) refuse(context.seatMessage);
      return formatFullTextResult(findOpenBookLines({ workspace: context.workspace, query, maxResults: cap, deskStateDirectory: context.deskDirectory }));
    }
    case 'discover_book_pages': {
      const query = args.required('query');
      const cap = resultCap(args.optional('max_results'));
      if (!context.deskDirectory) refuse(context.seatMessage);
      return formatDiscoveryResult(findBookPages({ workspace: context.workspace, query, maxResults: cap, deskStateDirectory: context.deskDirectory }));
    }
    default:
      refuse('This adapter exposes only validated Book and Project reader tools.');
  }
}

/** The response envelope, which is what the row compares -- one text block and an error flag. */
export function readerEnvelope(id: PsJsonValue, text: string, isError: boolean): PsJsonValue {
  // A refusal's remedy, never a page's content, is said as this host should say it (S42, remedy.ts).
  if (isError) text = hostRemedies(text);
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      isError,
    },
  };
}

/** `library mcp call <tool> [--slug] [--page] [--location] [--shelf] [--query] [--max-results] [--seat] [--workspace] [--id]`. */
export async function runMcpVerb(argv: string[]): Promise<McpResult> {
  const action = argv[0] ?? '';
  if (action === 'serve') return (await import('./mcpserve.ts')).runMcpServe(argv.slice(1));
  if (action !== 'call') {
    return { refusal: `library mcp has no action '${action}'. It has: call, serve.`, value: null, exitCode: 1 };
  }

  const parsed = parseArguments(argv.slice(1), ['slug', 'page', 'location', 'shelf', 'workspace', 'seat', 'id', 'query', 'max-results']);
  const tool = parsed.positional[0] ?? '';
  const id = Number(parsed.options.get('id') ?? '1');
  // The CLI's spelling of an argument is the option's; `max_results` arrives as `--max-results`.
  const option = (name: string): string | undefined => parsed.options.get(name.replace(/_/g, '-'));
  const args: ReaderArguments = {
    required(name) {
      const value = option(name);
      if (value === undefined) refuse(`missing required parameter '${name}'.`);
      if (!value.trim()) refuse(`parameter '${name}' must be a non-empty string.`);
      return value;
    },
    optional: (name) => option(name),
  };

  try {
    const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
    const context = readerContext(workspace, path.join(workspace, '.claude'), parsed.options.get('seat'));
    return { refusal: null, value: readerEnvelope(id, await answerReaderTool(context, tool, args), false), exitCode: 0 };
  } catch (error) {
    // A REFUSAL IS A RESULT HERE, NOT A CRASH. The adapter answers a rejected call with a well-formed
    // response whose `isError` is true and whose exit code is 0, because the transport succeeded even
    // where the read did not.
    const message = error instanceof Error ? error.message : String(error);
    return { refusal: null, value: readerEnvelope(id, `Book read rejected: ${message}`, true), exitCode: 0 };
  }
}
