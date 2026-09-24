/**
 * The Shelf catalog: the tracked header, one `_catalog-entry.md` per Book, and the render that puts
 * them together.
 *
 * THE CATALOG IS DERIVED, NEVER AUTHORED. A hand edit to `shelf/_catalog.md` is drift rather than
 * content, and the check that reports the drift deliberately does not repair it -- a check that
 * fixed what it found would report a healthy Library on every run while the writer that caused it
 * stayed broken.
 *
 * AN ENTRY IS CHECKED AGAINST THE DIRECTORY IT WAS FOUND IN, which is the whole reason an entry file
 * is safe to render unread. A copied Book directory would otherwise carry a Path line naming the
 * Book it was copied from, and the catalog would list one Book twice under two titles.
 *
 * THE RENDER TAKES THE SHELF'S OWN LOCK, and it is the last lock in the order: a holder acquires
 * nothing else, and callers take the Book's lock first.
 *
 * ITS OWN FILE SINCE S14, because the five Shelf WRITERS commit their entry change through the same
 * renderer. A writer that edited `shelf/_catalog.md` by offset would be computing an index against a
 * document another seat may have moved on since; passing an ENTRY instead means there is no offset
 * left to get wrong.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { readUtf8, SLUG_PATTERN } from './shelfbook.ts';

export const SHELF_RENDER_LOCK_ROOT = 'render/shelf-catalog';
export const ENTRY_NAME = '_catalog-entry.md';
const HEADER_RELATIVE = 'docs/templates/shelf-catalog-header.md';

export class ShelfRefusal extends Error {}

export function refuse(message: string): never {
  throw new ShelfRefusal(message);
}

/** One trailing newline, always, so a given set of entries has exactly one possible byte sequence. */
export function singleTrailingNewline(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

export function shelfCatalogEntryPath(workspace: string, slug: string): string {
  return path.join(workspace, 'shelf', slug, ENTRY_NAME);
}

function headerPath(workspace: string, programRoot: string): string {
  // THE WORKSPACE FIRST, THEN THE PROGRAM. Since the program and the workspace were split, a
  // reader's workspace has no `docs/` at all -- it has a Shelf -- and rendering that Shelf needs
  // both roots at once. The workspace is still consulted first so a fixture carrying its own
  // template is not quietly rendered through the real tree's header.
  const relative = HEADER_RELATIVE.split('/');
  const inWorkspace = path.join(workspace, ...relative);
  if (fs.existsSync(inWorkspace)) return inWorkspace;
  return path.join(programRoot, ...relative);
}

function shelfCatalogHeader(workspace: string, programRoot: string): string {
  const file = headerPath(workspace, programRoot);
  if (!fs.existsSync(file)) {
    refuse(
      'The Shelf catalog header template is missing. It was looked for at ' +
        `${path.join(workspace, ...HEADER_RELATIVE.split('/'))} and then at ${file}, which is where the ` +
        'program keeps it. It is tracked, so restore it from the repository rather than writing a new one.',
    );
  }
  const text = singleTrailingNewline(readUtf8(file));
  if (!text.startsWith('# ')) refuse(`${HEADER_RELATIVE} must begin with a column-zero H1.`);
  // A column-zero '##' in the header would render as a phantom Book: the catalog's readers find a
  // Book by matching a '## ' section and a Path line inside it.
  if (/^##/m.test(text)) {
    refuse(`${HEADER_RELATIVE} contains a column-zero '##', which would render as a Book entry the Shelf does not have.`);
  }
  if ((text.match(/^# /gm) ?? []).length !== 1) refuse(`${HEADER_RELATIVE} must carry exactly one column-zero H1.`);
  return text;
}

/** Validate one entry against the slug that owns it. Returns its title, or refuses. */
export function testShelfCatalogEntryText(text: string, slug: string, label: string): string {
  const normalised = text.replace(/\r\n/g, '\n');
  const headings = [...normalised.matchAll(/^##[ \t]+(.+)$/gm)];
  if (headings.length !== 1) {
    refuse(`${label} must carry exactly one column-zero '## ' heading; it carries ${headings.length}.`);
  }
  if (/^#[ \t]/m.test(normalised)) {
    refuse(`${label} carries a column-zero H1; an entry is a '## ' section of the catalog, not a document of its own.`);
  }
  if (!normalised.replace(/^\n+/, '').startsWith('## ')) refuse(`${label} must begin with its '## ' heading.`);

  const pathLines = [...normalised.matchAll(/^\s*-\s+\*\*Path:\*\*\s+shelf\/([a-z0-9][a-z0-9-]*)\s*$/gm)];
  if (pathLines.length !== 1) {
    refuse(`${label} must carry exactly one '- **Path:** shelf/<slug>' line; it carries ${pathLines.length}.`);
  }
  const declared = pathLines[0]![1]!;
  if (declared !== slug) {
    refuse(`${label} declares Path shelf/${declared} but lives under shelf/${slug}. An entry names the Book it belongs to.`);
  }
  const title = headings[0]![1]!.trim();
  if (!title) refuse(`${label} has an empty title.`);
  return title;
}

/** Compose one entry from a title and its detail lines, with the Path line added last. */
export function newShelfCatalogEntryText(slug: string, title: string, lines: string[]): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.includes('\n') || trimmedTitle.includes('\r')) refuse('A catalog entry title must be a single line.');
  const body = lines.filter((line) => line && line.trim()).map((line) => line.replace(/\s+$/, ''));
  // Appended by the composer rather than passed in, so no caller can produce an entry that names a
  // different Book than the one it is written under.
  body.push(`- **Path:** shelf/${slug}`);
  const text = singleTrailingNewline(`## ${trimmedTitle}\n` + body.join('\n'));
  testShelfCatalogEntryText(text, slug, `the composed entry for shelf/${slug}`);
  return text;
}

interface ShelfEntry {
  slug: string;
  title: string;
  text: string;
  path: string;
}

/**
 * Every Book's entry file, validated, ordered by slug. One level under `shelf/` only, so
 * `shelf/_archive/<slug>` is excluded by construction -- which is what keeps an archived Book out of
 * the active catalog. A directory with no entry file is REPORTED rather than skipped: silently
 * skipping is how a Book falls out of its own catalog.
 */
export function shelfCatalogEntryInventory(workspace: string): { entries: ShelfEntry[]; unlisted: string[] } {
  const shelfRoot = path.join(workspace, 'shelf');
  if (!fs.existsSync(shelfRoot)) refuse(`the Shelf directory is missing: ${shelfRoot}`);

  const entries: ShelfEntry[] = [];
  const unlisted: string[] = [];
  for (const item of fs.readdirSync(shelfRoot, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    // The Shelf's own namespace: `_archive` and anything else the lifecycle needs later, plus the
    // dot-prefixed staging directories a writer creates mid-operation. Never a Book.
    if (item.name.startsWith('_') || item.name.startsWith('.')) continue;
    if (!SLUG_PATTERN.test(item.name)) {
      refuse(`shelf/${item.name} is not a Book slug. Rename or remove it; the catalog cannot say what it is.`);
    }
    const entryPath = path.join(shelfRoot, item.name, ENTRY_NAME);
    if (!fs.existsSync(entryPath)) {
      unlisted.push(item.name);
      continue;
    }
    const text = singleTrailingNewline(readUtf8(entryPath));
    const title = testShelfCatalogEntryText(text, item.name, `shelf/${item.name}/${ENTRY_NAME}`);
    entries.push({ slug: item.name, title, text, path: entryPath });
  }
  entries.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  unlisted.sort();
  return { entries, unlisted };
}

export function shelfCatalogText(workspace: string, programRoot: string): string {
  const header = shelfCatalogHeader(workspace, programRoot);
  const inventory = shelfCatalogEntryInventory(workspace);
  if (inventory.unlisted.length) {
    refuse(
      `${inventory.unlisted.length} Book directory(ies) under shelf/ carry no ${ENTRY_NAME} and so cannot be listed: ` +
        `${inventory.unlisted.join(', ')}. Run tools/ShelfCatalog.ps1 -Migrate -WorkspacePath . to split an old shelf/_catalog.md into entry files.`,
    );
  }
  return header + inventory.entries.map((entry) => '\n' + entry.text).join('');
}

export interface RenderResult {
  catalogPath: string;
  entryCount: number;
}

/**
 * THE CRITICAL SECTION. Commit the entry files this operation changes and re-render the catalog from
 * what is left. The scan throws before anything is written, so a malformed entry leaves the previous
 * catalog exactly as it was rather than replacing it with a partial list.
 *
 * THE RENDERER DOES THE WRITE; A CALLER NEVER HANDS OVER A PROCEDURE THAT DOES IT. A caller that
 * passes an entry rather than a closure cannot get the atomic write wrong.
 */
export function invokeShelfCatalogRender(options: {
  workspace: string;
  programRoot: string;
  writeEntry?: { path: string; text: string }[];
  removeEntry?: string[];
  timeoutSeconds?: number;
}): RenderResult {
  // Validated BEFORE the lock is taken, so a malformed request costs nobody the render lock.
  for (const entry of options.writeEntry ?? []) {
    if (!entry.path || !entry.path.trim()) refuse('A write-entry path is empty.');
  }
  const catalogPath = path.join(options.workspace, 'shelf', '_catalog.md');
  ensureDirectory(path.join(options.workspace, 'internal', 'book-locks'));
  const lock = enterBookLock(options.workspace, SHELF_RENDER_LOCK_ROOT, options.timeoutSeconds ?? 20);
  try {
    for (const entry of options.writeEntry ?? []) writeAtomicText(entry.path, entry.text);
    for (const file of options.removeEntry ?? []) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    let text: string;
    try {
      text = shelfCatalogText(options.workspace, options.programRoot);
    } catch (error) {
      refuse(`shelf/_catalog.md was NOT changed, because the Shelf cannot be rendered: ${(error as Error).message}`);
    }
    writeAtomicText(catalogPath, text);
    // Readback verification: an atomic write that cannot be read back is a write that did not happen.
    if (readUtf8(catalogPath) !== text) refuse('The rendered Shelf catalog failed readback verification.');
    return { catalogPath: 'shelf/_catalog.md', entryCount: (text.match(/^## /gm) ?? []).length };
  } finally {
    exitBookLock(lock);
  }
}

/**
 * The rollback's renderer. THE LAST STEP OF A ROLLBACK IS A RENDER RATHER THAN A RESTORE: a failed
 * Shelf write unwinds its own directory move and restores its own entry file from the journal, and
 * those are the AUTHORITY the catalog is derived from. Writing back a snapshot the journal took
 * before the run started would drop whatever Book another seat published in the meantime.
 *
 * IT REPORTS ITS OWN FAILURE SEPARATELY, so a Shelf that cannot render does not make a rollback that
 * did restore its files read as one that restored nothing.
 */
export function invokeShelfCatalogRenderAfterRollback(workspace: string, programRoot: string): RenderResult {
  try {
    return invokeShelfCatalogRender({ workspace, programRoot });
  } catch (error) {
    throw new Error(
      'the Book and its journaled files were restored, but shelf/_catalog.md could not be re-derived ' +
        `afterwards: ${(error as Error).message} Run tools/ShelfCatalog.ps1 -Render -WorkspacePath . once that is ` +
        'repaired; until then the catalog still describes the Shelf as it was mid-operation.',
    );
  }
}
