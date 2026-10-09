/**
 * `deskpost browse [--json] [--archived]`: what the Library holds, from one seatless, offline read (PLAN-correct-and-find.md
 * D5; kickoffs/s102 ruling 5). The main menu's `l` renders it.
 *
 * METADATA ONLY, AND ONLY WHAT IS ALREADY SERVED SEATLESS. Books on the Shelf come from the Shelf catalog (title, slug,
 * summary, topics), Books in the collection from its own catalog and the stored manifests, and Projects by title and slug
 * only: a Hub's text is its seat's own (the 2026-09-07 ruling that another seat is counts and liveness; the 2026-10-06
 * one that the directory reads cards, never Hubs). A page's text is never read.
 *
 * NO NETWORK CALL ON EITHER BACKEND. On a Basic Memory Library the collection's Books come from the offline shared roster
 * and the stored manifests, with the roster's `generated_utc` as "as of"; its Projects live in Basic Memory, and only a
 * seat lists them.
 *
 * It opens nothing, starts no agent, claims no seat and writes nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { readMarker, requireWorkspace } from './workspace.ts';
import { ARCHIVE_FOLDER, convertFromShelfCatalogEntry, readUtf8, shelfCatalogPath, shelfCatalogSections } from './shelfbook.ts';
import { collectionBookIdentity, collectionBookSlugs, manifestCollectionFor } from './collectionbooks.ts';
import { getStoredBookManifest } from './manifeststore.ts';
import { openCollection } from './collection.ts';

export const BROWSE_USAGE = 'deskpost browse [--archived] [--json] [--workspace <path>]';

/** One thing the Library holds, as the browse list shows it. */
export interface BrowseEntry {
  kind: 'book' | 'project';
  place: 'shelf' | 'collection' | 'shared' | 'archive';
  slug: string;
  title: string;
  summary: string;
  topics: string[];
  /** The page count from the stored manifest, or null when no current manifest says it. */
  pages: number | null;
  /** The entry's catalog text: a Shelf Book's catalog entry, otherwise its title and summary. */
  catalog_text: string;
  /** The line that opens it from a seat. */
  open_line: string;
}

export interface BrowseData {
  library: string;
  backend: string;
  shelf: BrowseEntry[];
  collection: BrowseEntry[];
  /** On a Basic Memory Library, the offline roster's `generated_utc`; null otherwise. */
  collection_as_of: string | null;
  projects: BrowseEntry[];
  /** Said instead of a Project list on a Basic Memory Library. */
  projects_note: string | null;
  archived_count: { books: number; projects: number };
  /** Listed only with `--archived`. */
  archived: BrowseEntry[] | null;
}

function pageCount(workspace: string, slug: string, collection: string): number | null {
  try {
    const stored = getStoredBookManifest(workspace, slug, collection);
    if (stored.status !== 'ok' || stored.manifest === null) return null;
    const count = stored.manifest['page_count'];
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

function manifestField(workspace: string, slug: string, collection: string): Record<string, unknown> | null {
  try {
    const stored = getStoredBookManifest(workspace, slug, collection);
    return stored.status === 'ok' ? stored.manifest : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.trim().length > 0) : [];
}

/** The Shelf catalog's Books, in catalog order; a section with no `Path: shelf/<slug>` line is not a Book. */
function shelfEntries(workspace: string): BrowseEntry[] {
  const file = shelfCatalogPath(workspace);
  if (!fs.existsSync(file)) return [];
  const entries: BrowseEntry[] = [];
  for (const section of shelfCatalogSections(readUtf8(file))) {
    const slug = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body)?.[1];
    if (!slug) continue;
    const book = convertFromShelfCatalogEntry({ workspace, slug, title: section.title, body: section.body, bookRoot: `shelf/${slug}` });
    entries.push({
      kind: 'book',
      place: 'shelf',
      slug,
      title: book.title,
      summary: book.summary,
      topics: book.topics,
      pages: pageCount(workspace, slug, 'shelf'),
      catalog_text: section.text.replace(/\s+$/, ''),
      open_line: `deskpost desk open book ${slug} --location shelf`,
    });
  }
  return entries;
}

function collectionEntry(workspace: string, slug: string, place: 'collection' | 'shared', manifestCollection: string): BrowseEntry {
  const manifest = manifestField(workspace, slug, manifestCollection);
  const identity = place === 'collection' ? collectionBookIdentity(workspace, 'active', slug) : null;
  const title = identity?.title ?? (manifest && typeof manifest['title'] === 'string' && manifest['title'] ? String(manifest['title']) : slug);
  const summary = (identity?.summary ?? (manifest && typeof manifest['summary'] === 'string' ? String(manifest['summary']) : '')).replace(/\*\*/g, '');
  const count = manifest && typeof manifest['page_count'] === 'number' ? (manifest['page_count'] as number) : null;
  return {
    kind: 'book',
    place,
    slug,
    title,
    summary,
    topics: stringList(manifest?.['topics']),
    pages: count,
    catalog_text: summary ? `${title} - ${summary}` : title,
    open_line: `deskpost desk open book ${slug} --location ${place}`,
  };
}

/** The shared roster a Basic Memory Library keeps offline, or null. */
function sharedRoster(workspace: string): { slugs: string[]; asOf: string } | null {
  const file = path.join(workspace, 'internal', 'book-manifests', 'shared', '_roster.json');
  if (!fs.existsSync(file)) return null;
  try {
    const roster = JSON.parse(readUtf8(file)) as Record<string, unknown>;
    const slugs = (Array.isArray(roster['books']) ? (roster['books'] as Record<string, unknown>[]) : [])
      .map((entry) => String(entry['slug']))
      .filter((slug) => /^[a-z0-9][a-z0-9-]*$/.test(slug));
    return { slugs, asOf: typeof roster['generated_utc'] === 'string' ? roster['generated_utc'] : '' };
  } catch {
    return null;
  }
}

/** A Project catalog's `[[<root>/<slug>/_project|Title]]` lines, as title and slug. */
function catalogProjects(text: string, root: string): { slug: string; title: string }[] {
  const found: { slug: string; title: string }[] = [];
  const pattern = new RegExp(`\\[\\[${root.replace(/\//g, '\\/')}\\/([a-z0-9][a-z0-9-]*)\\/_project\\|([^\\]\\r\\n]+)\\]\\]`, 'g');
  for (const match of text.matchAll(pattern)) if (!found.some((entry) => entry.slug === match[1])) found.push({ slug: match[1]!, title: match[2]!.trim() });
  return found;
}

function projectEntry(slug: string, title: string, place: 'collection' | 'archive'): BrowseEntry {
  return {
    kind: 'project',
    place,
    slug,
    title,
    summary: '',
    topics: [],
    pages: null,
    catalog_text: title,
    open_line: place === 'archive' ? `deskpost desk open project ${slug} --shelf archive` : `deskpost desk open project ${slug}`,
  };
}

/** The archived Shelf Books: folders under `shelf/_archive/` holding a `wiki/`. */
function archivedShelfSlugs(workspace: string): string[] {
  const directory = path.join(workspace, 'shelf', ARCHIVE_FOLDER);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name) && fs.existsSync(path.join(directory, entry.name, 'wiki')))
    .map((entry) => entry.name)
    .sort();
}

export function browseData(workspace: string, listArchived: boolean): BrowseData {
  const marker = readMarker(workspace);
  const backend = String(marker?.['backend'] ?? '') === 'local' ? 'local' : 'basic-memory';
  const shelf = shelfEntries(workspace);
  let collection: BrowseEntry[] = [];
  let collectionAsOf: string | null = null;
  let projects: BrowseEntry[] = [];
  let projectsNote: string | null = null;
  const archived: BrowseEntry[] = [];

  for (const slug of archivedShelfSlugs(workspace)) {
    archived.push({ ...projectEntry(slug, slug, 'archive'), kind: 'book', open_line: `deskpost shelf restore ${slug}` });
  }
  if (backend === 'local') {
    collection = collectionBookSlugs(workspace, 'active').map((slug) => collectionEntry(workspace, slug, 'collection', manifestCollectionFor('active')));
    for (const slug of collectionBookSlugs(workspace, 'archive')) {
      const identity = collectionBookIdentity(workspace, 'archive', slug);
      archived.push({ ...projectEntry(slug, identity.title, 'archive'), kind: 'book', summary: identity.summary, open_line: `deskpost desk open book ${slug} --shelf archive` });
    }
    try {
      const store = openCollection(workspace);
      const active = store.readPage('projects/README.md');
      projects = (active === null ? [] : catalogProjects(active, 'projects')).map((entry) => projectEntry(entry.slug, entry.title, 'collection'));
      const old = store.readPage('archive/projects/README.md');
      for (const entry of old === null ? [] : catalogProjects(old, 'archive/projects')) archived.push(projectEntry(entry.slug, entry.title, 'archive'));
    } catch {
      projects = [];
    }
  } else {
    const roster = sharedRoster(workspace);
    collection = (roster?.slugs ?? []).map((slug) => collectionEntry(workspace, slug, 'shared', 'shared'));
    collectionAsOf = roster ? roster.asOf || null : null;
    projectsNote = 'Projects live in Basic Memory; a seat lists them.';
  }

  return {
    library: workspace,
    backend,
    shelf,
    collection,
    collection_as_of: collectionAsOf,
    projects,
    projects_note: projectsNote,
    archived_count: { books: archived.filter((entry) => entry.kind === 'book').length, projects: archived.filter((entry) => entry.kind === 'project').length },
    archived: listArchived ? archived : null,
  };
}

/** Every entry the list numbers, in the order it shows them. */
export function browseEntries(data: BrowseData): BrowseEntry[] {
  return [...data.shelf, ...data.collection, ...data.projects, ...(data.archived ?? [])];
}

function fit(text: string, width: number): string {
  return text.length <= width ? text : text.substring(0, Math.max(0, width - 3)).trimEnd() + '...';
}

/**
 * The plain list, line by line, each within `width` columns: a heading per group, then one numbered line per entry
 * (title, slug and summary), and the archived count. The numbers run across the groups, so one number names one entry.
 */
export function browseLines(data: BrowseData, width = 80, entries: BrowseEntry[] = browseEntries(data)): string[] {
  const lines: string[] = [];
  const numbered = browseEntries(data);
  const shown = new Set(entries);
  const group = (heading: string, items: BrowseEntry[]) => {
    const visible = items.filter((entry) => shown.has(entry));
    lines.push(`${heading} (${visible.length === items.length ? items.length : `${visible.length} of ${items.length}`})`);
    if (!items.length) lines.push('  none');
    for (const entry of visible) {
      const number = String(numbered.indexOf(entry) + 1).padStart(3);
      const head = `${number}  ${entry.title} [${entry.slug}]`;
      lines.push(fit(entry.summary ? `${head}  ${entry.summary}` : head, width));
    }
  };
  group('Books on the Shelf', data.shelf);
  group(data.collection_as_of ? `Books in the collection, as of ${data.collection_as_of}` : 'Books in the collection', data.collection);
  if (data.projects_note) lines.push(data.projects_note);
  else group('Projects', data.projects);
  if (data.archived) group('Archived', data.archived);
  else {
    const { books, projects } = data.archived_count;
    lines.push(fit(`Archived: ${books} ${books === 1 ? 'Book' : 'Books'}, ${projects} ${projects === 1 ? 'Project' : 'Projects'} (deskpost browse --archived)`, width));
  }
  return lines;
}

/** The entries whose title, slug, summary or topics hold every typed word, case-insensitively: metadata only. */
export function filterBrowse(entries: BrowseEntry[], typed: string): BrowseEntry[] {
  const words = typed.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  return entries.filter((entry) => {
    const text = [entry.title, entry.slug, entry.summary, ...entry.topics].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const PLACE_LABEL: Record<BrowseEntry['place'], string> = {
  shelf: 'on the Shelf',
  collection: 'in the collection',
  shared: 'in the shared collection',
  archive: 'archived',
};

/** One entry, shown by its number: its catalog text, page count and the line that opens it from a seat. */
export function browseEntryLines(entry: BrowseEntry, width = 80): string[] {
  const lines = [fit(`${entry.title} [${entry.slug}], a ${entry.kind === 'book' ? 'Book' : 'Project'} ${PLACE_LABEL[entry.place]}`, width)];
  for (const line of entry.catalog_text.split(/\r?\n/)) if (line.trim()) lines.push(fit(`  ${line.trimEnd()}`, width));
  if (entry.kind === 'book') lines.push(entry.pages === null ? '  Pages: not counted yet (no current manifest)' : `  Pages: ${entry.pages}`);
  if (entry.topics.length) lines.push(fit(`  Topics: ${entry.topics.join(', ')}`, width));
  lines.push(fit(`  From a seat: ${entry.open_line}`, width));
  return lines;
}

export function browseValue(data: BrowseData): PsJsonValue {
  return { schema: 1, operation: 'Browse the Library', ...(data as unknown as Record<string, PsJsonValue>) } as PsJsonValue;
}

/** `deskpost browse [--archived] [--json] [--workspace <path>]`: seatless; refuses only a missing Library. */
export function runBrowseVerb(argv: string[]): { refusal: string | null; value: PsJsonValue | null; humanText: string } {
  const parsed = parseArguments(argv, argumentTable('browse'));
  if (parsed.positional.length) return { refusal: `deskpost browse takes no words, not '${parsed.positional.join(' ')}': ${BROWSE_USAGE}.`, value: null, humanText: '' };
  let workspace: string;
  try {
    workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  } catch (error) {
    return { refusal: `deskpost browse: ${(error as Error).message}`, value: null, humanText: '' };
  }
  const data = browseData(workspace, parsed.flags.has('archived'));
  return { refusal: null, value: browseValue(data), humanText: browseLines(data).join('\n') + '\n' };
}
