/**
 * `deskpost collection replace-page`: correct one page of a Book in a local Library's own collection, in place
 * (kickoffs/s101 row 4; ADR-0070; PLAN-correct-and-find.md D2).
 *
 * GATED, AS `collection add-page` IS: a collection Book is shared material, so the reader's Q1 binding without a yes
 * belongs to the Shelf only. The plan_id covers the page's current text, the proposed text and the reader map; every
 * input is read again under the Book lock and a change refuses the run. The previous text is journaled and kept as a
 * restore file beside the journal. The reader map is append-only and never regenerated: when the H1 changed and
 * exactly one map line links the page, that line's label follows it, in the same plan.
 *
 * A BOOK PUBLISHED FROM THE SHELF is replaced from its Shelf copy at its next `publish refresh`, so the preview names
 * that copy and warns; correcting the Shelf page first is the advice, and the replace is not refused.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { resolveContentPath } from './contentpath.ts';
import { argumentTable } from './verbs.ts';
import { isLocalBackend } from './basicmemory.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { completeBookMutation, enterBookMutation, type BookMutation } from './mutation.ts';
import { getStoredBookManifest } from './manifeststore.ts';
import { collectionBookSlugs, collectionBookWiki, newBookManifestForCollectionBook, rebuildCollectionManifestHeld } from './collectionbooks.ts';
import { assertInsideRoot, convertToBookPagePath, renderPageBody } from './pagepath.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { parseBookRoot } from './places.ts';
import { pageComparisonSha256, sha256OfText } from './sha.ts';
import { writeAtomicText } from './fsx.ts';
import { strayControlRefusal } from './controlchars.ts';
import { changeCounts } from './hubedit.ts';
import { linkLabel, readMap } from './maplines.ts';
import { sourceShelfSlug } from './shelfrecall.ts';
import { writePublicationEvidence } from './collectionpage.ts';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const USAGE = 'library collection replace-page <slug> <page> --content-path <file> (--preflight | --user-confirmed --plan-id <id>)';

class CollectionReplaceRefusal extends Error {}

function refuse(message: string): never {
  throw new CollectionReplaceRefusal(message);
}

function readUtf8(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** A test hook, named in the self-test that uses it: where to stop a replace after its journal is written. */
function injectedFault(): string {
  return (process.env['LIBRARY_COLLECTION_REPLACE_PAGE_FAULT'] ?? '').trim();
}

function titleOf(content: string, fallback: string): string {
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  return heading && /[a-zA-Z0-9]/.test(heading[1]!) ? heading[1]!.trim() : fallback;
}

/**
 * The map with the one line that links the page given the new label, or null when no line or more than one links it
 * (outside frontmatter and fences, in either link form). The target keeps its own form.
 */
function mapWithLabel(mapText: string, slug: string, page: string, label: string): string | null {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `\\[\\[((?:${[`books/${slug}/wiki/${page}`, page].map(escaped).join('|')}))(?:\\|[^\\]\\r\\n]*)?\\]\\]`;
  const inReadable = readMap(mapText).text.match(new RegExp(pattern, 'g')) ?? [];
  const inRaw = mapText.match(new RegExp(pattern, 'g')) ?? [];
  if (inReadable.length !== 1 || inRaw.length !== 1) return null;
  return mapText.replace(new RegExp(pattern), (_whole, target: string) => `[[${target}|${linkLabel(label)}]]`);
}

interface ReplacePlan {
  slug: string;
  page: string;
  pageFull: string;
  mapPath: string;
  mapSha256: string;
  newMap: string | null;
  currentSha256: string;
  body: string;
  planId: string;
  sourceFile: string;
  sourceBytes: Buffer;
  value: Record<string, PsJsonValue>;
}

function planReplace(argv: string[], workspace: string): ReplacePlan {
  const parsed = parseArguments(argv, argumentTable('collection', 'replace-page'));
  const slug = parsed.positional[0] ?? '';
  const pageArgument = parsed.positional[1] ?? '';
  if (!slug || !pageArgument) refuse(`library collection replace-page needs a Book slug and a page path: ${USAGE}.`);
  if (parsed.options.has('body') || parsed.flags.has('body')) refuse(`library collection replace-page takes its text from --content-path only: ${USAGE}.`);
  if (parsed.options.has('title') || parsed.flags.has('title')) {
    refuse('library collection replace-page takes no --title: the page keeps or changes its own H1 in the text you give. Nothing was changed.');
  }
  if (!isLocalBackend(workspace)) {
    refuse(
      "library collection replace-page writes a local Library's own collection, and this workspace is attached to Basic Memory: " +
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
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
  const open = deskEntriesForSeat(stateDirectory, seat, 'books').some((entry) => parseBookRoot(entry.trim())?.root === `books/${slug}`);
  if (!open) refuse(`Book '${slug}' is not open at seat '${seat}'. Open it first: deskpost desk open book ${slug} --location collection`);

  const page = convertToBookPagePath(pageArgument);
  const wiki = collectionBookWiki(workspace, 'active', slug);
  const pageFull = path.join(wiki, ...`${page}.md`.split('/'));
  assertInsideRoot(wiki, `${page}.md`, `collection/books/${slug}/wiki`);
  if (!fs.existsSync(pageFull) || !fs.statSync(pageFull).isFile()) {
    refuse(
      `collection/books/${slug}/wiki/${page}.md does not exist, so there is nothing to correct. Add a new page with ` +
        `deskpost collection add-page ${slug} ${page} --content-path <file> --preflight. Nothing was changed.`,
    );
  }

  const contentPath = (parsed.options.get('content-path') ?? '').trim();
  if (!contentPath) refuse(`library collection replace-page needs --content-path <file>: ${USAGE}.`);
  const full = resolveContentPath(workspace, contentPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--content-path was not found: ${contentPath}`);
  let raw: string;
  const sourceBytes = fs.readFileSync(full);
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes).replace(/^﻿/, '');
  } catch (error) {
    refuse(`--content-path '${contentPath}' is not valid UTF-8: ${(error as Error).message}`);
  }
  if (!raw.trim()) refuse('The page body is empty; nothing was changed.');
  const stray = strayControlRefusal(raw, `--content-path '${contentPath}'`);
  if (stray !== null) refuse(stray);
  const rendered = renderPageBody(raw, '');

  const currentText = readUtf8(pageFull);
  const currentSha256 = pageComparisonSha256(fs.readFileSync(pageFull, 'utf8'));
  const proposedSha256 = pageComparisonSha256(rendered.body);
  const titleBefore = titleOf(currentText, page);
  const titleAfter = rendered.title;

  const mapPath = path.join(wiki, '_index.md');
  const mapExists = fs.existsSync(mapPath);
  const mapText = mapExists ? readUtf8(mapPath) : '';
  const mapSha256 = mapExists ? sha256OfText(mapText) : 'absent-map';
  const newMap = titleBefore !== titleAfter && mapExists ? mapWithLabel(mapText, slug, page, titleAfter) : null;

  const shelfSource = sourceShelfSlug(wiki);
  const shelfCopy = shelfSource !== null && fs.existsSync(path.join(workspace, 'shelf', shelfSource)) ? shelfSource : null;
  const counts = changeCounts(currentText.replace(/\r\n/g, '\n'), rendered.body.replace(/\r\n/g, '\n'));
  const lines = (text: string) => {
    const body = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return body === '' ? 0 : body.split('\n').length;
  };
  const planId = 'collection-replace-' + sha256OfText([slug, page, currentSha256, proposedSha256, mapSha256].join('|'));
  const value: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Replace a page of a collection Book',
    book: `collection/books/${slug}`,
    page: `collection/books/${slug}/wiki/${page}.md`,
    current_sha256: currentSha256,
    proposed_sha256: proposedSha256,
    current_lines: lines(currentText),
    proposed_lines: lines(rendered.body),
    added_lines: counts.added_lines,
    removed_lines: counts.removed_lines,
    title_before: titleBefore,
    title_after: titleAfter,
    reader_map: `collection/books/${slug}/wiki/_index.md`,
    reader_map_label: newMap !== null ? 'updated' : 'unchanged',
    shelf_source: shelfCopy,
    ...(shelfCopy !== null
      ? {
          warning:
            `This Book was published from the Shelf Book '${shelfCopy}', and the next deskpost publish refresh ${shelfCopy} replaces this page ` +
            `with the Shelf copy's text. Correct the Shelf page first (deskpost book replace-page ${shelfCopy} ${page} ...) unless this ` +
            'correction is meant for the collection copy only.',
        }
      : {}),
    plan_id: planId,
    confirmation_required: true,
    shared_library_write: false,
    scope:
      "Replaces the text of one existing page of this Book of the Library's own collection, keeping the previous text in the " +
      'Book journal and as a restore file beside it, ' +
      (newMap !== null ? "updates the one reader-map line that links the page to the page's new title, " : 'leaves the reader map as it is, ') +
      'and commits a new Discovery manifest generation, all under the Book lock. No other page is changed, and none is removed. ' +
      'Nothing is written to Basic Memory.',
  };
  if (currentSha256 === proposedSha256) {
    value['status'] = 'unchanged';
    value['next'] = 'The page already holds this text; nothing was changed.';
  }
  return { slug, page, pageFull, mapPath, mapSha256, newMap, currentSha256, body: rendered.body, planId, sourceFile: full, sourceBytes, value };
}

export function collectionReplacePage(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('collection', 'replace-page'));
  const plan = planReplace(argv, workspace);
  if (plan.value['status'] === 'unchanged') return plan.value;
  if (parsed.flags.has('preflight')) return plan.value;
  if (!parsed.flags.has('user-confirmed')) {
    refuse('The page is not yet replaced: review the preview (--preflight) and rerun with --user-confirmed --plan-id <id>.');
  }
  if ((parsed.options.get('plan-id') ?? '') !== plan.planId) {
    refuse(
      "The page is not yet replaced: the plan_id given is not this preview's. The page or its reader map may have changed since the preview; " +
        'rerun --preflight and pass its exact plan_id.',
    );
  }

  const timeoutOption = Number(parsed.options.get('lock-timeout') ?? '20');
  const bookRoot = `books/${plan.slug}`;
  const reason = `Replace page ${plan.page} of the collection Book`;
  let lock: BookLock | null = null;
  let mutation: BookMutation | null = null;
  let journalPath: string | null = null;
  let previousPath: string | null = null;
  let evidenceFile: string | null = null;
  try {
    lock = enterBookLock(workspace, bookRoot, Number.isFinite(timeoutOption) ? timeoutOption : 20);

    // EVERY INPUT THE plan_id COVERS, AGAIN, UNDER THE LOCK.
    if (!collectionBookSlugs(workspace, 'active').includes(plan.slug)) {
      refuse(`Book '${plan.slug}' left the collection's active shelf after the preview. Nothing was written.`);
    }
    if (!fs.existsSync(plan.pageFull) || pageComparisonSha256(fs.readFileSync(plan.pageFull, 'utf8')) !== plan.currentSha256) {
      refuse(
        `collection/books/${plan.slug}/wiki/${plan.page}.md changed after this edit was planned, so nothing was written. ` +
          'Re-read the page and plan the edit again; the text you were correcting is no longer what is there.',
      );
    }
    const mapNow = fs.existsSync(plan.mapPath) ? sha256OfText(readUtf8(plan.mapPath)) : 'absent-map';
    if (mapNow !== plan.mapSha256) refuse('The reader map changed after this edit was planned, so nothing was written. Rerun --preflight.');

    mutation = enterBookMutation({ workspace, slug: plan.slug, bookRoot, reason, lock, collection: 'collection' });
    journalPath = writeBookJournal({ workspace, bookRoot, operation: reason, paths: [plan.pageFull, plan.mapPath] }).journalPath;
    previousPath = journalPath.replace(/\.json$/, '') + '.previous.txt';
    fs.writeFileSync(previousPath, fs.readFileSync(plan.pageFull), { flag: 'wx' });

    if (injectedFault() === 'after-journal') refuse('FAULT INJECTED after the journal was written (a real run never reaches this)');
    writeAtomicText(plan.pageFull, plan.body);
    if (readUtf8(plan.pageFull) !== plan.body) refuse(`The page was written but did not read back identically: ${plan.value['page']}`);
    if (plan.newMap !== null) {
      writeAtomicText(plan.mapPath, plan.newMap);
      if (readUtf8(plan.mapPath) !== plan.newMap) refuse('The reader map was written but did not read back identically.');
    }
    if (injectedFault() === 'after-write') refuse('FAULT INJECTED after the page was written (a real run never reaches this)');

    const committed = completeBookMutation(mutation, newBookManifestForCollectionBook(workspace, 'active', plan.slug));
    const stored = getStoredBookManifest(workspace, plan.slug, 'collection');
    if (committed.status !== 'committed' || stored.status !== 'ok' || stored.generation !== committed.generation) {
      refuse(`The Discovery manifest did not commit: ${committed.summary}; the stored manifest reads '${stored.status}'${stored.reason ? ` (${stored.reason})` : ''}`);
    }
    // THE EVIDENCE BEFORE THE WINDOW CLOSES, as collection add-page writes it: a Notebook page filed whole is covered.
    evidenceFile = writePublicationEvidence(
      workspace,
      { slug: plan.slug, page: plan.page, planId: plan.planId, sourceFile: plan.sourceFile, sourceBytes: plan.sourceBytes, operation: 'collection-replace-page' },
      (relative) => (evidenceFile = relative),
    );
    mutation = null;
    const journal = path.relative(workspace, journalPath).replace(/\\/g, '/');
    const previous = path.relative(workspace, previousPath).replace(/\\/g, '/');
    return {
      ...plan.value,
      status: 'written',
      manifest: committed.summary,
      manifest_status: stored.status,
      journal,
      previous_body_path: previous,
      publication_evidence: evidenceFile,
      title_changed: plan.value['title_before'] !== plan.value['title_after'],
      restore: `deskpost collection replace-page ${plan.slug} ${plan.page} --content-path ${previous} --preflight`,
      next: `Read the corrected page with mcp__validated-book-reader__read_open_book_page (slug ${plan.slug}, page ${plan.page}, place collection). To undo, run the restore line and approve its preview.`,
    };
  } catch (error) {
    const failure = (error as Error).message;
    if (mutation === null || lock === null) throw error;
    let rollback: string;
    try {
      enterBookMutation({ workspace, slug: plan.slug, bookRoot, reason: `Roll back: ${reason}`, lock, collection: 'collection' });
      if (evidenceFile !== null) fs.rmSync(path.join(workspace, ...evidenceFile.split('/')), { force: true });
      if (journalPath !== null) restoreBookJournal(journalPath);
      if (previousPath !== null && fs.existsSync(previousPath)) fs.rmSync(previousPath);
      rollback = 'complete and verified';
    } catch (rollbackError) {
      rollback = `FAILED: ${(rollbackError as Error).message}`;
    }
    let discovery: string;
    if (rollback.startsWith('FAILED')) {
      discovery = 'dirty until rebuilt; run deskpost collection rebuild';
    } else {
      rebuildCollectionManifestHeld(workspace, 'active', plan.slug, lock, 'Rebuild after a rolled-back replace-page');
      const after = getStoredBookManifest(workspace, plan.slug, 'collection');
      discovery = after.status === 'ok' ? 'the Book is as it was' : `the stored manifest reads '${after.status}'; run deskpost collection rebuild`;
    }
    refuse(`The page was not replaced. ${failure}. Rollback: ${rollback}. Discovery: ${discovery}.`);
  } finally {
    exitBookLock(lock);
  }
}
