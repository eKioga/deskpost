/**
 * `library collection add-page`: one page added to a Book in a local Library's own collection
 * (PLAN-local-collection-writers.md, step A; game-admin's Report "Adding one compiled page to a collection Book takes
 * a full Shelf rebuild").
 *
 * ONLY EVER ADDS. The page must not exist; the root reader map gains one line at its end and is never regenerated
 * (Eric's Q5: collection maps carry frontmatter and file-path labels, and a regenerate would rewrite every line); a
 * topic `_index` beside the page is named, never edited; `_book.md` is not touched. Nothing is written to Basic Memory.
 *
 * GATED, UNLIKE THE SHELF'S `book add-page`, because this writes the Library's published tier: a preview, then a run
 * bound to its `plan_id`. Every input the id covers is recomputed under the Book's lock before anything is written, so
 * a map, a page or a Book that changed after the preview refuses the run.
 *
 * SUCCESS IS THE PERSISTED MANIFEST, NOT A RETURN VALUE. The store can report a commit whose dirty marker would not
 * clear, or fail to prune after its pointer committed (manifeststore.ts:182-188), so the writer reads the stored
 * manifest back and requires `ok` at the generation it committed. On any failure after the first write the dirty
 * marker is put back up first, then the journal restores the map and removes the page, then the manifest is rebuilt
 * under the same lock and read again, and the refusal says which state the Book is in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { resolveContentPath } from './contentpath.ts';
import { argumentTable } from './verbs.ts';
import { isLocalBackend } from './basicmemory.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { completeBookMutation, enterBookMutation, type BookMutation, type MutationResult } from './mutation.ts';
import { getStoredBookManifest } from './manifeststore.ts';
import { collectionBookSlugs, collectionBookWiki, newBookManifestForCollectionBook, rebuildCollectionManifestHeld } from './collectionbooks.ts';
import { assertInsideRoot, convertToBookPagePath, lexists, renderPageBody } from './pagepath.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { parseBookRoot } from './places.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { writeAtomicText } from './fsx.ts';
import { withInlineCutWarning } from './inlinecut.ts';
import { strayControlRefusal } from './controlchars.ts';
import { linkLabel, mapLinksPage, mapWithLink, planTopicIndexLine, readMap, topicIndexPage } from './maplines.ts';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const USAGE =
  'library collection add-page <slug> <page> (--content-path <file> | --body <text>) [--title <t>] ' +
  '(--preflight | --user-confirmed --plan-id <id>)';

class CollectionPageRefusal extends Error {}

function refuse(message: string): never {
  throw new CollectionPageRefusal(message);
}

function readUtf8(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

// --- the plan ---------------------------------------------------------------------------------------------------

interface AddPagePlan {
  slug: string;
  page: string;
  wiki: string;
  pageFull: string;
  mapPath: string;
  mapText: string;
  mapSha256: string;
  newMap: string | null;
  body: string;
  title: string;
  titleSource: string;
  source: string;
  sourceFile: string | null;
  /** The source's bytes as read for this plan, so its evidence hash is of exactly what was stored (inspection). */
  sourceBytes: Buffer | null;
  planId: string;
  /** The topic index beside the page, its text's hash as planned, and its new text (null: none, or already listed). */
  topicIndexFull: string | null;
  topicSha256: string | null;
  newTopicIndex: string | null;
  value: Record<string, PsJsonValue>;
}

function planAddPage(argv: string[], workspace: string): AddPagePlan {
  const parsed = parseArguments(argv, argumentTable('collection', 'add-page'));
  const slug = parsed.positional[0] ?? '';
  const pageArgument = parsed.positional[1] ?? '';
  if (!slug || !pageArgument) refuse(`library collection add-page needs a Book slug and a page path: ${USAGE}.`);
  if (!isLocalBackend(workspace)) {
    refuse(
      "library collection add-page writes a local Library's own collection, and this workspace is attached to Basic Memory: " +
        'a shared Book changes through its Shelf Book and library publish refresh. Nothing was changed.',
    );
  }
  if (!SLUG.test(slug)) refuse('Book slug must contain only lowercase letters, digits, and hyphens.');
  if (!collectionBookSlugs(workspace, 'active').includes(slug)) {
    if (collectionBookSlugs(workspace, 'archive').includes(slug)) {
      refuse(`Book '${slug}' is in the collection's archive, which is read-only. Nothing was changed.`);
    }
    refuse(`There is no Book '${slug}' in this Library's collection (collection/books/${slug}/wiki). Nothing was changed.`);
  }

  // THIS SEAT'S DESK, each line read as a root: a bare `<slug>` on a local Library's Desk means `books/<slug>`.
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
  const open = deskEntriesForSeat(stateDirectory, seat, 'books').some((entry) => parseBookRoot(entry.trim())?.root === `books/${slug}`);
  if (!open) {
    refuse(`Book '${slug}' is not open at seat '${seat}'. Open it first: deskpost desk open book ${slug} --location collection`);
  }

  const page = convertToBookPagePath(pageArgument);
  const wiki = collectionBookWiki(workspace, 'active', slug);
  const pageFull = path.join(wiki, ...`${page}.md`.split('/'));
  assertInsideRoot(wiki, `${page}.md`, `collection/books/${slug}/wiki`);
  if (lexists(pageFull)) {
    refuse(`collection/books/${slug}/wiki/${page}.md already exists. This writer only ever adds a page; choose another page path. ` +
        `To change that page, recall the Book (deskpost shelf recall ${slug}), edit the Shelf copy, and return it with ` +
        `deskpost publish refresh <shelf-slug>, or correct it in place with deskpost collection replace-page ${slug} ${page} --content-path <file> --preflight.`);
  }

  // THE BODY: a file (preferred for prose) or inline text, never both.
  const contentPath = (parsed.options.get('content-path') ?? '').trim();
  const inline = parsed.options.get('body');
  if (contentPath && inline !== undefined && inline.trim()) refuse('Give either --content-path or --body, not both.');
  let raw: string;
  let source: string;
  let sourceFile: string | null = null;
  let sourceBytes: Buffer | null = null;
  if (contentPath) {
    const full = resolveContentPath(workspace, contentPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--content-path was not found: ${contentPath}`);
    try {
      sourceBytes = fs.readFileSync(full);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes).replace(/^﻿/, '');
    } catch (error) {
      refuse(`--content-path '${contentPath}' is not valid UTF-8: ${(error as Error).message}`);
    }
    source = contentPath;
    sourceFile = full;
  } else {
    if (inline === undefined || !inline.trim()) refuse(`A page needs a body: pass --content-path <file> (preferred for prose) or --body <text>. ${USAGE}.`);
    raw = inline;
    source = '(inline)';
  }
  if (!raw.trim()) refuse('The page body is empty; nothing was added.');
  // NO STRAY CONTROL CHARACTER REACHES A PAGE (kickoffs/s94 row 3), refused before the preview as before the run.
  const stray = strayControlRefusal(raw, source === '(inline)' ? '--body' : `--content-path '${contentPath}'`);
  if (stray !== null) refuse(stray);
  const rendered = renderPageBody(raw, parsed.options.get('title') ?? '');

  // THE READER MAP, appended to and never regenerated.
  const mapPath = path.join(wiki, '_index.md');
  const mapExists = fs.existsSync(mapPath);
  const mapText = mapExists ? readUtf8(mapPath) : '';
  const reading = readMap(mapText);
  if (reading.unclosedFence) {
    refuse(
      `The reader map collection/books/${slug}/wiki/_index.md ends inside an unclosed code fence, so a link added at its end ` +
        'would show as code, not a link. Close the fence in the map first. Nothing was changed.',
    );
  }
  const label = linkLabel(rendered.title);
  const mapLine = `- [[books/${slug}/wiki/${page}|${label}]]`;
  const listed = mapLinksPage(reading, slug, page);
  const newMap = listed ? null : mapWithLink(mapText, mapLine);

  // THE TOPIC INDEX GAINS THE PAGE'S LINE (kickoffs/s101 row 3; PLAN-correct-and-find.md D3): one line at its end when it
  // does not already link the page in either form, its hash bound into the plan_id and rechecked under the lock.
  const topicPage = topicIndexPage(page);
  const topicIndexFull = topicPage ? path.join(wiki, ...`${topicPage}.md`.split('/')) : null;
  const topicText = topicIndexFull !== null && fs.existsSync(topicIndexFull) ? fs.readFileSync(topicIndexFull, 'utf8') : null;
  const topicPlan = topicText === null ? null : planTopicIndexLine(topicText, slug, page, rendered.title);
  if (topicPlan === 'open-fence') {
    refuse(
      `The topic index collection/books/${slug}/wiki/${topicPage}.md ends inside an unclosed code fence, so a link added at its end ` +
        'would show as code, not a link. Close the fence in the topic index first. Nothing was changed.',
    );
  }
  const topicSha256 = topicText === null ? null : sha256OfText(topicText);

  const mapSha256 = sha256OfText(mapText);
  const planId =
    'collection-page-' +
    sha256OfText([slug, page, sha256OfText(rendered.body), mapExists ? mapSha256 : 'absent-map', 'page-absent', ...(topicSha256 === null ? [] : [`topic-index:${topicSha256}`])].join('|'));
  const value: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Add a page to a collection Book',
    book: `collection/books/${slug}`,
    page: `collection/books/${slug}/wiki/${page}.md`,
    page_title: rendered.title,
    title_source: rendered.titleSource,
    body_characters: rendered.body.length,
    source,
    reader_map: `collection/books/${slug}/wiki/_index.md`,
    reader_map_action: listed ? 'already links this page; left unchanged' : mapExists ? 'append one line at its end' : 'create it with one line',
    reader_map_line: listed ? null : mapLine,
    topic_index: topicPlan === null ? null : topicPlan.status,
    plan_id: planId,
    confirmation_required: true,
    shared_library_write: false,
    scope:
      "Creates one new page in this Book of the Library's own collection and adds one line at the end of its reader map, " +
      'then commits a new Discovery manifest generation, all under the Book lock. ' +
      (topicPlan !== null && topicPlan.status === 'updated'
        ? `The topic index ${topicPage}.md gains one line at its end; no other existing page is changed, and none is removed; _book.md is left as it is. `
        : 'No existing page is changed or removed; _book.md and any topic index are left as they are. ') +
      'Nothing is written to Basic Memory.',
  };
  return {
    slug,
    page,
    wiki,
    pageFull,
    mapPath,
    mapText,
    mapSha256: mapExists ? mapSha256 : 'absent-map',
    newMap,
    body: rendered.body,
    title: rendered.title,
    titleSource: rendered.titleSource,
    source,
    sourceFile,
    sourceBytes,
    planId,
    topicIndexFull: topicText === null ? null : topicIndexFull,
    topicSha256,
    newTopicIndex: topicPlan === null ? null : topicPlan.newText,
    value,
  };
}

// --- the run ------------------------------------------------------------------------------------------------------

/** A test hook, named in the self-test that uses it: which manifest outcome to simulate after the page lands. */
function injectedFault(): string {
  return (process.env['LIBRARY_COLLECTION_ADD_PAGE_FAULT'] ?? '').trim();
}

/**
 * THE PUBLICATION EVIDENCE TRIAGE READS (plan 0.6). A Notebook page filed whole into a Book is covered, exactly as a
 * published one is: a `complete` journal in internal/publication-journals/ whose planned record names the source and
 * its bytes' SHA-256 (triageinventory.ts).
 */
function writeEvidence(workspace: string, plan: AddPagePlan, claim: (relative: string) => void): string | null {
  if (plan.sourceFile === null || plan.sourceBytes === null || plan.titleSource !== 'body H1') return null;
  return writePublicationEvidence(
    workspace,
    { slug: plan.slug, page: plan.page, planId: plan.planId, sourceFile: plan.sourceFile, sourceBytes: plan.sourceBytes, operation: 'collection-add-page' },
    claim,
  );
}

/** The evidence record itself, shared with `collection replace-page` (kickoffs/s101 row 4): a Notebook source only. */
export function writePublicationEvidence(
  workspace: string,
  plan: { slug: string; page: string; planId: string; sourceFile: string; sourceBytes: Buffer; operation: 'collection-add-page' | 'collection-replace-page' },
  claim: (relative: string) => void,
): string | null {
  const relative = path.relative(path.resolve(workspace), plan.sourceFile).replace(/\\/g, '/');
  if (!/^notebook\/.+\.md$/i.test(relative)) return null;
  const directory = path.join(workspace, 'internal', 'publication-journals');
  fs.mkdirSync(directory, { recursive: true });
  const prefix = plan.operation === 'collection-add-page' ? 'collection-page' : 'collection-replace';
  const file = path.join(directory, `${prefix}-${plan.slug}-${plan.planId.substring(plan.planId.length - 12)}.json`);
  // CLAIMED BEFORE IT IS WRITTEN (inspection round 2), so a write that fails part-way is still removed by the rollback.
  claim(path.relative(workspace, file).replace(/\\/g, '/'));
  const journal: PsJsonValue = {
    state: 'complete',
    timestamp_utc: new Date().toISOString(),
    destination: 'collection',
    operation: plan.operation,
    book_slug: plan.slug,
    approved_plan_id: plan.planId,
    planned_records: [{ path: `books/${plan.slug}/wiki/${plan.page}.md`, source: relative, sha256: sha256OfBytes(plan.sourceBytes) }],
    error: '',
  };
  fs.writeFileSync(file, psConvertToJson(journal), 'utf8');
  return path.relative(workspace, file).replace(/\\/g, '/');
}

/** The verb, with the inline-cut warning (S70 row 2) in its result: a `--body` the shim may have cut says so. */
export function collectionAddPage(argv: string[], workspace: string): Record<string, PsJsonValue> {
  return withInlineCutWarning(collectionAddPageUnwarned(argv, workspace), argv, 'body', 'pass it with --content-path <file>.');
}

function collectionAddPageUnwarned(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('collection', 'add-page'));
  const plan = planAddPage(argv, workspace);
  if (parsed.flags.has('preflight')) return plan.value;
  if (!parsed.flags.has('user-confirmed')) {
    refuse('A page added to a collection Book is not yet written: review the preview (--preflight) and rerun with --user-confirmed --plan-id <id>.');
  }
  if ((parsed.options.get('plan-id') ?? '') !== plan.planId) {
    refuse('The page is not yet written: the plan_id given is not this preview\'s. Rerun --preflight and pass its exact plan_id.');
  }

  const timeoutOption = Number(parsed.options.get('lock-timeout') ?? '20');
  const bookRoot = `books/${plan.slug}`;
  let lock: BookLock | null = null;
  let mutation: BookMutation | null = null;
  let journalPath: string | null = null;
  const createdDirectories: string[] = [];
  const reason = `Add page ${plan.page} to the collection Book`;
  let evidenceFile: string | null = null;
  try {
    lock = enterBookLock(workspace, bookRoot, Number.isFinite(timeoutOption) ? timeoutOption : 20);

    // EVERY INPUT THE plan_id COVERS, AGAIN, UNDER THE LOCK (plan 0.4). The preview ran with nobody excluded.
    if (!collectionBookSlugs(workspace, 'active').includes(plan.slug)) {
      refuse(`Book '${plan.slug}' left the collection's active shelf after the preview. Nothing was written.`);
    }
    assertInsideRoot(plan.wiki, `${plan.page}.md`, `collection/books/${plan.slug}/wiki`);
    if (lexists(plan.pageFull)) refuse(`collection/books/${plan.slug}/wiki/${plan.page}.md was created after the preview. Nothing was written.`);
    const mapNow = fs.existsSync(plan.mapPath) ? sha256OfText(readUtf8(plan.mapPath)) : 'absent-map';
    if (mapNow !== plan.mapSha256) {
      refuse(`The reader map changed after the preview, so the line this run would add is no longer what was approved. Rerun --preflight. Nothing was written.`);
    }
    const topicNow = plan.topicIndexFull !== null && fs.existsSync(plan.topicIndexFull) ? sha256OfText(fs.readFileSync(plan.topicIndexFull, 'utf8')) : null;
    if (topicNow !== plan.topicSha256) {
      refuse(`The topic index changed after the preview, so the line this run would add is no longer what was approved. Rerun --preflight. Nothing was written.`);
    }

    mutation = enterBookMutation({ workspace, slug: plan.slug, bookRoot, reason, lock, collection: 'collection' });
    journalPath = writeBookJournal({ workspace, bookRoot, operation: reason, paths: [plan.pageFull, plan.mapPath, ...(plan.newTopicIndex !== null ? [plan.topicIndexFull!] : [])] }).journalPath;

    let parent = path.dirname(plan.pageFull);
    while (!fs.existsSync(parent)) {
      createdDirectories.push(parent);
      parent = path.dirname(parent);
    }
    if (createdDirectories.length) fs.mkdirSync(path.dirname(plan.pageFull), { recursive: true });
    fs.writeFileSync(plan.pageFull, plan.body, { encoding: 'utf8', flag: 'wx' });
    if (readUtf8(plan.pageFull) !== plan.body) refuse(`The page was written but did not read back identically: ${plan.value['page']}`);
    if (plan.newMap !== null) {
      writeAtomicText(plan.mapPath, plan.newMap);
      if (readUtf8(plan.mapPath) !== plan.newMap) refuse('The reader map was written but did not read back identically.');
    }
    if (plan.newTopicIndex !== null) {
      writeAtomicText(plan.topicIndexFull!, plan.newTopicIndex);
      if (fs.readFileSync(plan.topicIndexFull!, 'utf8') !== plan.newTopicIndex) refuse('The topic index was written but did not read back identically.');
    }

    const fault = injectedFault();
    let committed: MutationResult;
    if (fault === 'commit') {
      committed = { status: 'dirty', slug: plan.slug, generation: 0, summary: 'dirty until rebuilt: injected commit failure' };
    } else {
      committed = completeBookMutation(mutation, newBookManifestForCollectionBook(workspace, 'active', plan.slug));
      if (fault === 'marker') {
        // The store swallows a marker that will not clear; this puts one back where the commit said it had gone.
        const store = path.join(workspace, 'internal', 'book-manifests', 'collection', plan.slug);
        fs.writeFileSync(path.join(store, 'dirty.json'), JSON.stringify({ reason: 'injected: the marker did not clear', pid: process.pid }));
      }
      if (fault === 'prune') committed = { ...committed, status: 'dirty', summary: 'dirty until rebuilt: injected failure after the pointer committed' };
    }
    const stored = getStoredBookManifest(workspace, plan.slug, 'collection');
    if (committed.status !== 'committed' || stored.status !== 'ok' || stored.generation !== committed.generation) {
      refuse(`The Discovery manifest did not commit: ${committed.summary}; the stored manifest reads '${stored.status}'${stored.reason ? ` (${stored.reason})` : ''}`);
    }
    // THE EVIDENCE BEFORE THE WINDOW CLOSES (inspection): a journal that cannot be written is a failure like any
    // other, rolled back with the page, not a committed page with no record.
    evidenceFile = writeEvidence(workspace, plan, (relative) => (evidenceFile = relative));
    mutation = null;
    const evidence = evidenceFile;
    return {
      ...plan.value,
      status: 'added',
      manifest: committed.summary,
      manifest_status: stored.status,
      journal: path.relative(workspace, journalPath).replace(/\\/g, '/'),
      publication_evidence: evidence,
      next:
        `Read the new page with mcp__validated-book-reader__read_open_book_page (slug ${plan.slug}, page ${plan.page}, place collection).`,
    };
  } catch (error) {
    const failure = (error as Error).message;
    if (mutation === null || lock === null) throw error;
    // IN THIS ORDER: the marker up first, so no committed generation answers while files change; then the journal;
    // then the directories this run made, deepest first and only while empty; then a rebuild, read back.
    let rollback: string;
    try {
      enterBookMutation({ workspace, slug: plan.slug, bookRoot, reason: `Roll back: ${reason}`, lock, collection: 'collection' });
      // THE EVIDENCE FIRST: a restore that fails must not leave a `complete` claim behind it.
      if (evidenceFile !== null) fs.rmSync(path.join(workspace, ...evidenceFile.split('/')), { force: true });
      if (journalPath !== null) restoreBookJournal(journalPath);
      for (const directory of createdDirectories) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
      rollback = 'complete and verified';
    } catch (rollbackError) {
      rollback = `FAILED: ${(rollbackError as Error).message}`;
    }
    let discovery: string;
    if (rollback.startsWith('FAILED')) {
      discovery = 'dirty until rebuilt; run deskpost collection rebuild';
    } else {
      rebuildCollectionManifestHeld(workspace, 'active', plan.slug, lock, `Rebuild after a rolled-back add-page`);
      const after = getStoredBookManifest(workspace, plan.slug, 'collection');
      discovery = after.status === 'ok' ? 'the Book is as it was' : `the stored manifest reads '${after.status}'; run deskpost collection rebuild`;
    }
    refuse(`The page was not added. ${failure}. Rollback: ${rollback}. Discovery: ${discovery}.`);
  } finally {
    exitBookLock(lock);
  }
}
