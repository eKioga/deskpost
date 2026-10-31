/**
 * WHERE A LASTING RECORD LINKS INTO THE NOTEBOOK (kickoffs/s109 ruling 1).
 *
 * A Hub page or a Shelf Book page outlives a Notebook reset; the Notebook does not. The twenty-second `/tidy`'s
 * reset left four Decisions on a Hub pointing into the quarantine, so a reset now refuses while any lasting
 * record names a path under what it would move, and doctor warns about a line naming a Notebook path that no
 * longer exists. Both read this one scan, which a later `search_open_projects` can reuse.
 *
 * THE MATCH IS LITERAL (standing answer 11). Any `notebook/<seg>/...` in a line counts, as a wikilink, in
 * backticks or in prose, with `/` or `\`: a false positive costs a repoint, a false negative a dead link. A
 * segment is a plain name, so a placeholder such as `notebook/<seat>/<topic>` is not a path and never matches.
 *
 * WHAT IS SCANNED: the records still being written (kickoffs/s112 ruling 1; Eric, 2026-10-09: "yes, go with A"). Every
 * `*.md` under the local collection's Project Hubs and Books (`collection/`) and under the Shelf (`shelf/`), EXCEPT
 * the local collection's `archive/` tree, the Shelf's `_archive/`, every Hub's `notes/` pages, and a capture Book's
 * note whose `review` is `done` (a closed letter, Report or Holding note), and each capture Book's `wiki/reviewed/`.
 * Leading page frontmatter records provenance and is not scanned. History is never rewritten, so a link
 * there is a dated record, not a defect: counting it made doctor's WARN permanent and let a closed Report block a
 * live topic's reset. Doctor's WARN and the reset's `inbound_links` read this one scan, so they cannot disagree.
 * The shared collection is not on this disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { localCollectionRoot } from './collection.ts';
import { ARCHIVE_FOLDER, convertFromShelfCatalogEntry, readUtf8, shelfCatalogPath, shelfCatalogSections } from './shelfbook.ts';
import { shelfNotes } from './shelfnote.ts';

export interface NotebookLink {
  /** The page, workspace-relative with forward slashes: `collection/projects/<slug>/_project.md`. */
  page: string;
  /** One-based. */
  line: number;
  /** The path as the line names it, separators made `/`: `notebook/<seat>/<topic>/<page>`. */
  path: string;
}

/** `notebook` and at least one plain segment after it, not inside a longer word (`mynotebook/`, `notebook-x/`). */
const LINK_PATTERN = /(?<![A-Za-z0-9_.-])notebook((?:[/\\][A-Za-z0-9_][A-Za-z0-9_.-]*)+)/g;

function markdownFiles(root: string, skip: (directory: string) => boolean = () => false): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (skip(directory)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort();
}

/** Closed capture notes and reviewed directories: dated records, never rescanned. */
function closedCaptureNotes(workspace: string): Set<string> {
  const closed = new Set<string>();
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) return closed;
  let sections;
  try {
    sections = shelfCatalogSections(readUtf8(catalogFile));
  } catch {
    return closed;
  }
  for (const section of sections) {
    if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
    const pathMatch = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body);
    if (!pathMatch) continue;
    const slug = pathMatch[1]!;
    const book = convertFromShelfCatalogEntry({ workspace, slug, title: section.title, body: section.body, bookRoot: `shelf/${slug}` });
    closed.add(path.resolve(book.wikiPath, 'reviewed').toLowerCase());
    try {
      for (const note of shelfNotes(book)) if (note.review === 'done') closed.add(path.resolve(note.fullPath).toLowerCase());
    } catch {
      continue;
    }
  }
  return closed;
}

/**
 * Every line of a record still being written that names a path under `notebook/`, in page then line order. What is
 * skipped as history is the header's list.
 */
export function notebookLinks(workspace: string): NotebookLink[] {
  const links: NotebookLink[] = [];
  const collection = localCollectionRoot(workspace);
  const shelf = path.join(workspace, 'shelf');
  const collectionArchive = path.resolve(collection, 'archive').toLowerCase();
  const shelfArchive = path.resolve(shelf, ARCHIVE_FOLDER).toLowerCase();
  const projects = path.resolve(collection, 'projects').toLowerCase();
  const history = (directory: string): boolean => {
    const full = path.resolve(directory).toLowerCase();
    if (full === collectionArchive || full === shelfArchive || closed.has(full)) return true;
    // A Hub's own `notes/`: `<collection>/projects/<slug>/notes`, and everything under it.
    return path.dirname(path.dirname(full)) === projects && path.basename(full) === 'notes';
  };
  const closed = closedCaptureNotes(workspace);
  for (const root of [collection, shelf]) {
    for (const file of markdownFiles(root, history)) {
      if (closed.has(path.resolve(file).toLowerCase())) continue;
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!/notebook[/\\]/.test(text)) continue;
      const page = path.relative(workspace, file).split(path.sep).join('/');
      const lines = text.split(/\r?\n/);
      const frontmatterEnd = lines[0]?.replace(/^\uFEFF/, '').trim() === '---' ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') : -1;
      lines.forEach((line, index) => {
        if (index <= frontmatterEnd) return;
        for (const match of line.matchAll(LINK_PATTERN)) {
          // A trailing full stop ends a sentence, not a name.
          const named = `notebook${match[1]!.replace(/\\/g, '/')}`.replace(/\.+$/, '');
          links.push({ page, line: index + 1, path: named });
        }
      });
    }
  }
  return links;
}

export interface InboundLink {
  page: string;
  line: number;
  topic: string;
}

/**
 * The lines that link into what a reset would move: a topic directory, or a loose file (named with or without
 * `.md`), directly under `notebookRelative` (`notebook/<seat>`). One row per page line and moved name.
 */
export function inboundNotebookLinks(workspace: string, notebookRelative: string, moved: string[]): InboundLink[] {
  const prefix = `${notebookRelative.replace(/\\/g, '/').replace(/\/+$/, '')}/`.toLowerCase();
  const names = new Map<string, string>();
  for (const name of moved) {
    names.set(name.toLowerCase(), name);
    if (/\.md$/i.test(name)) names.set(name.slice(0, -3).toLowerCase(), name);
  }
  const rows: InboundLink[] = [];
  const seen = new Set<string>();
  for (const link of notebookLinks(workspace)) {
    const lower = link.path.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const first = lower.slice(prefix.length).split('/')[0] ?? '';
    const topic = names.get(first) ?? names.get(first.replace(/\.md$/, ''));
    if (topic === undefined) continue;
    const key = `${link.page}\n${link.line}\n${topic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ page: link.page, line: link.line, topic });
  }
  return rows;
}

/** The lines naming a Notebook path that is not on disk, as a directory, a file, or a file once `.md` is added. */
export function deadNotebookLinks(workspace: string): NotebookLink[] {
  return notebookLinks(workspace).filter((link) => {
    const full = path.join(workspace, ...link.path.split('/'));
    return !fs.existsSync(full) && !fs.existsSync(`${full}.md`);
  });
}

/** The repair, said once for the reset's refusal and doctor's WARN. */
export const NOTEBOOK_LINK_REPAIR =
  'a lasting record links to a Hub notes page or a repo file, never into the Notebook: home the material on a dated ' +
  'Hub notes page (deskpost hub edit <slug> --mode new-page) or in a repo file, and repoint the link';
