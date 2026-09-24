/**
 * The local Shelf: step 24's second port-order group.
 *
 * This file is the VERB SURFACE. The catalog's own machinery -- the header, the entry grammar, the
 * inventory and the render lock -- lives in `shelfcatalog.ts`, and the five destructive writers live
 * in `shelfwriters.ts`, because they share one piece of machinery: the rollback journal under
 * `internal/shelf-journals/` and the Discovery manifest transaction under `internal/book-manifests/`.
 * Porting any one of the five was porting all of it, so they landed together (S14).
 *
 * `duplicates` IS `src/duplicates.ts` SINCE S41, dispatched by cli.ts before this file is reached, because it
 * is the one Shelf verb that waits on a network answer. Its row is judged against the harness's embedding
 * stand-in, never a reader's server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { requireWorkspace } from './workspace.ts';
import { readUtf8, SLUG_PATTERN } from './shelfbook.ts';
import {
  ENTRY_NAME,
  invokeShelfCatalogRender,
  newShelfCatalogEntryText,
  refuse,
  ShelfRefusal,
  testShelfCatalogEntryText,
} from './shelfcatalog.ts';
import { archiveVerb, removeVerb, renameVerb, restoreVerb, stubVerb } from './shelfwriters.ts';
import { updateShelfNoteIndex } from './capture.ts';

export interface VerbResult {
  refusal: string | null;
  value: PsJsonValue | null;
  asJson: boolean;
  humanText?: string;
}

const ACTIONS = ['render', 'new', 'rename', 'remove', 'archive', 'restore', 'stub', 'duplicates'];

/** The schema version `Write-LibraryResult -Json` stamps on every helper document. */
const LIBRARY_OUTPUT_SCHEMA = 1;

function renderVerb(argv: string[], programRoot: string): VerbResult {
  const parsed = parseArguments(argv, ['workspace']);
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const render = invokeShelfCatalogRender({ workspace, programRoot });
  const result: PsJsonValue = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Render the Shelf catalog',
    workspace,
    catalog_path: render.catalogPath,
    entry_count: render.entryCount,
    shared_library_write: false,
  };
  return { refusal: null, value: result, asJson: true };
}

function newBookVerb(argv: string[], programRoot: string): VerbResult {
  const parsed = parseArguments(argv, ['title', 'summary', 'topics', 'origin', 'workspace']);
  const slug = parsed.positional[0] ?? '';
  if (!SLUG_PATTERN.test(slug)) {
    refuse(`Book slug '${slug}' is malformed. A slug is lowercase letters, digits and hyphens, starting with a letter or a digit.`);
  }
  const title = parsed.options.get('title') ?? '';
  const summary = parsed.options.get('summary') ?? '';
  if (!title.trim()) refuse('Title is required.');
  if (!summary.trim()) {
    refuse('Summary is required: it is what the catalog shows a reader deciding whether to open this Book.');
  }
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const plan = createShelfBook({
    workspace,
    programRoot,
    slug,
    title,
    summary,
    topics: parsed.options.get('topics'),
    capture: parsed.flags.has('capture'),
    origin: parsed.options.get('origin'),
    preflight: parsed.flags.has('preflight'),
  });
  return { refusal: null, value: plan as PsJsonValue, asJson: true };
}

/**
 * `New-ShelfBook.ps1` from its validated arguments on: one EMPTY Book, curated or capture, and the catalog
 * re-rendered with it. `library shelf new` and `library init` (S42) both create a Book through this, so an
 * init-made Book is byte for byte a `shelf new` one.
 */
export function createShelfBook(options: {
  workspace: string;
  programRoot: string;
  slug: string;
  title: string;
  summary: string;
  topics?: string | undefined;
  capture: boolean;
  origin?: string | undefined;
  preflight?: boolean;
}): Record<string, PsJsonValue> {
  const { workspace, programRoot, slug, title, summary, capture } = options;
  const bookRoot = path.join(workspace, 'shelf', slug);
  const bookWiki = path.join(bookRoot, 'wiki');
  const entryPath = path.join(bookRoot, ENTRY_NAME);

  // REFUSED BEFORE ANYTHING IS CREATED, and the two refusals are different because the fixes are.
  // A directory with a wiki/ is a Book; one without is a husk, and creating a Book over it would
  // adopt whatever catalog entry it carries.
  if (fs.existsSync(bookRoot)) {
    if (fs.existsSync(bookWiki) && fs.statSync(bookWiki).isDirectory()) {
      refuse(`Shelf Book 'shelf/${slug}' already exists. Choose another slug, or add to that Book directly.`);
    }
    refuse(
      `shelf/${slug} exists but has no wiki/, so it is a husk rather than a Book -- creating one here would adopt whatever ` +
        `catalog entry it carries. Remove shelf/${slug} if nothing needs it, then re-render with ` +
        'tools/ShelfCatalog.ps1 -Render -WorkspacePath . (see docs/derived-indexes.md).',
    );
  }

  const origin = options.origin;
  const originLine = origin && origin.trim() ? origin.trim() : `created ${new Date().toISOString().substring(0, 10)}`;
  const kind = capture ? 'capture' : 'curated';
  const plannedPaths: string[] = [`shelf/${slug}/wiki/_book.md`, `shelf/${slug}/wiki/_index.md`];
  if (capture) plannedPaths.push(`shelf/${slug}/wiki/notes/`);

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Create a Shelf Book',
    slug,
    title: title.trim(),
    book_root: `shelf/${slug}`,
    kind,
    catalog_entry: `shelf/${slug}/_catalog-entry.md`,
    planned_paths: plannedPaths,
    confirmation_required: false,
    shared_library_write: false,
    scope:
      'Creates one local Shelf Book and re-renders shelf/_catalog.md. No shared-collection write, and no existing file is read or replaced.',
  };
  if (options.preflight) return plan;

  const limits = capture
    ? 'Pages in this Book are captures, appended by Add-ShelfNote.ps1 and unchecked since they were written. Read one as a claim to verify, never as a finding.'
    : 'This Book preserves local working knowledge. Refresh its source when current information matters.';
  const bookPage = [
    `# ${title.trim()}`,
    '',
    '- **Type:** Local Book',
    `- **Kind:** ${kind}`,
    `- **Origin:** ${originLine}`,
    `- **Limits:** ${limits}`,
    '',
    '## Purpose',
    '',
    summary.trim(),
    '',
    '## Reader map',
    '',
    '- [[_index|Open the reader map]]',
  ].join('\n');

  ensureDirectory(bookWiki);
  let entryCount: number;
  try {
    writeAtomicText(path.join(bookWiki, '_book.md'), bookPage + '\n');
    if (capture) {
      // THE MAP EVERY CAPTURE REGENERATES, as the oracle's Update-ShelfNoteIndex writes it here -- until
      // S42 this wrote a curated Book's map, which no row compared because no row made a capture Book.
      const notesPath = path.join(bookWiki, 'notes');
      ensureDirectory(notesPath);
      updateShelfNoteIndex({ slug, title: title.trim(), bookRoot, wikiPath: bookWiki, notesPath, isCapture: true, summary: summary.trim(), topics: [] });
    } else {
      writeAtomicText(
        path.join(bookWiki, '_index.md'),
        `# ${title.trim()} - Reader Map\n\n- [[_book|Book metadata and limits]]\n`,
      );
    }
    const topics = options.topics;
    const entryText = newShelfCatalogEntryText(slug, title.trim(), [
      `- **Summary:** ${summary.trim()}`,
      topics && topics.trim() ? `- **Topics:** ${topics.trim()}` : '',
      capture ? '- **Kind:** capture' : '',
      `- **Origin:** ${originLine}`,
    ]);
    entryCount = invokeShelfCatalogRender({
      workspace,
      programRoot,
      writeEntry: [{ path: entryPath, text: entryText }],
    }).entryCount;
  } catch (error) {
    // NOTHING IS LEFT BEHIND. A half-created Book is a Book the catalog cannot describe and the
    // reader cannot open, and the next render would refuse over it.
    fs.rmSync(bookRoot, { recursive: true, force: true });
    refuse(`The Shelf Book was not created, and nothing was left behind. ${(error as Error).message}`);
  }

  // VERIFIED BY READING IT BACK THROUGH THE CATALOG, not by assuming the write worked.
  const verifyTitle = testShelfCatalogEntryText(readUtf8(entryPath), slug, `shelf/${slug}/${ENTRY_NAME}`);
  if (verifyTitle !== title.trim()) {
    refuse(`The Book was created but the catalog resolves its title as '${verifyTitle}'.`);
  }

  plan['status'] = 'created';
  plan['is_capture'] = capture;
  plan['catalog_entry_count'] = entryCount;
  plan['reader_map'] = `shelf/${slug}/wiki/_index.md`;
  plan['manifest'] = 'none yet: a new Book has no Discovery manifest until the backfill builds one.';
  plan['next'] = capture
    ? `Capture into it with tools/Add-ShelfNote.ps1 -BookSlug ${slug}. It is closed by default; open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug ${slug} to read a page.`
    : `Add pages with tools/Add-ShelfBookPage.ps1, which needs the Book open: tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug ${slug}.`;
  return plan;
}

export function runShelfVerb(argv: string[], programRoot: string): VerbResult {
  const action = argv[0] ?? '';
  if (!ACTIONS.includes(action)) {
    return { refusal: `library shelf has no action '${action}'. It has: ${ACTIONS.join(', ')}.`, value: null, asJson: false };
  }
  try {
    switch (action) {
      case 'render':
        return renderVerb(argv.slice(1), programRoot);
      case 'new':
        return newBookVerb(argv.slice(1), programRoot);
      case 'rename':
      case 'remove':
      case 'archive':
      case 'restore':
      case 'stub': {
        // THE WORKSPACE IS RESOLVED ONCE, HERE, so the five writers cannot disagree about which one
        // they are operating on -- and so a workspace refusal reaches the reader before any of them
        // has read a catalog.
        const parsed = parseArguments(argv.slice(1), [
          'workspace',
          'plan-id',
          'new-title',
          'reason',
          'seat',
          'canonical',
          'superseded-on',
        ]);
        const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
        const rest = argv.slice(1);
        const written =
          action === 'rename'
            ? renameVerb(rest, programRoot, workspace)
            : action === 'remove'
              ? removeVerb(rest, programRoot, workspace)
              : action === 'archive'
                ? archiveVerb(rest, programRoot, workspace)
                : action === 'restore'
                  ? restoreVerb(rest, programRoot, workspace)
                  : stubVerb(rest, programRoot, workspace);
        return { refusal: written.refusal, value: written.value, asJson: true };
      }
      default:
        // `duplicates` is answered by src/duplicates.ts before this function is called; reaching here is a
        // dispatch defect, and says so rather than answering.
        return { refusal: 'library shelf duplicates was dispatched to the synchronous Shelf verbs; it is answered by src/duplicates.ts.', value: null, asJson: false };
    }
  } catch (error) {
    // A ShelfRefusal is this program's own sentence and goes through verbatim; anything else is a
    // fault, and its message is still the most useful thing to say.
    void ShelfRefusal;
    return { refusal: (error as Error).message, value: null, asJson: false };
  }
}
