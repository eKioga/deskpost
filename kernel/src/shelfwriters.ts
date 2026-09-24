/**
 * The five destructive Shelf writers: rename, remove, archive, restore, stub.
 *
 * ONE PIECE OF MACHINERY, WHICH IS WHY THEY ARE ONE FILE AND ONE PORT. Each of them takes a
 * read-only preflight, issues a `plan_id` bound to the state it read, refuses anything but that
 * exact id, holds the Book's lock, journals prior state before the first mutation, verifies by
 * readback rather than assuming, rolls back on failure, and closes a Discovery manifest window at
 * the end. Porting any one of them is porting all of it.
 *
 * THE SHAPE OF A GATED OPERATION, in the order that keeps it honest:
 *
 *   1. Read everything the approval will bind, and refuse anything already certain to fail BEFORE a
 *      plan_id is issued. An approval for an operation that cannot succeed is worse than none.
 *   2. Preflight returns the plan and writes nothing.
 *   3. The confirming run takes the locks, RE-READS under them, and refuses if the plan_id it
 *      recomputes differs -- a preview is a snapshot by definition, and the window between it and
 *      the write is exactly the check-then-act race the plan_id exists to close.
 *   4. Journal, mutate, verify, commit the manifest LAST. Completing the manifest never throws: the
 *      mutation has already landed, and a manifest failure must not unwind the reader's material.
 *
 * WHY THE REFUSALS ARE WORDED IN POWERSHELL'S PARAMETER NAMES. The matrix compares `stderr` sentence
 * for sentence on eleven failure rows, so the two arms must say the same thing; a kernel that
 * improved the wording would report a difference about vocabulary as a difference about behaviour.
 * Where this kernel's own flag differs (`--plan-id` for `-ApprovedPlanId`), the sentence still names
 * the PowerShell one, because that is what the oracle says and the oracle is the contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { enterBookLock, enterSeatRegistryLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { newBookManifestForShelfBook } from './manifest.ts';
import { removeBookManifestStore } from './manifeststore.ts';
import {
  completeBookMutation,
  completeBookRenameMutation,
  enterBookMutation,
  undoBookMutation,
  type BookMutation,
} from './mutation.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { psSortCompare, psSortUnique } from './pssort.ts';
import {
  ARCHIVE_FOLDER,
  ARCHIVE_RECORD_NAME,
  archiveRecordPath,
  archivedBookRoot,
  findShelfCatalogEntry,
  getArchivedShelfBook,
  getShelfBook,
  listFilesRecursive,
  readUtf8,
  shelfCatalogPath,
  type PageHash,
  type ShelfBook,
} from './shelfbook.ts';
import {
  invokeShelfCatalogRender,
  invokeShelfCatalogRenderAfterRollback,
  refuse,
  shelfCatalogEntryPath,
} from './shelfcatalog.ts';
import {
  deskEntriesAcrossSeats,
  deskEntriesForSeat,
  deskFilePath,
  requireSeat,
  seatsHoldingEntry,
  setDeskEntryForSeat,
  updateDeskEntryAcrossSeats,
} from './seatdesk.ts';
import { psConvertToJson } from './psjson.ts';

/** The schema version `Write-LibraryResult -Json` stamps on every helper document. */
const LIBRARY_OUTPUT_SCHEMA = 1;
const LOCK_TIMEOUT_SECONDS = 20;

export interface WriterResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/** Lowercase letters, digits and SINGLE hyphens: the rule the gated helpers apply to a Book slug. */
const STRICT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hashFile(file: string): string {
  return sha256OfBytes(fs.readFileSync(file));
}

function pageManifest(wikiPath: string): PageHash[] {
  return listFilesRecursive(wikiPath).map((file) => ({
    relative: file.substring(wikiPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'),
    sha256: hashFile(file),
  }));
}

function workspaceRelative(workspace: string, file: string): string {
  return file.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function stateDirectory(workspace: string): string {
  return path.join(workspace, '.claude');
}

/** `yyyy-MM-dd` in LOCAL time, which is what `(Get-Date).ToString('yyyy-MM-dd')` gives. */
function today(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Tracked text naming this Book by path, split into the two lists the reader actually needs.
 *
 * `blocking` are mentions on the NARROW set of surfaces `shelf.references-resolve` reads, and those
 * really do fail the gate. `other` are mentions anywhere else, which the gate never reads: a doc
 * recording a dated event under this Book's name stays true, and editing it would be falsifying a
 * record rather than fixing a link. The first live use archived a Book with eleven such mentions,
 * the gate passed clean, and an earlier version had flatly predicted failure -- sending the reader
 * hunting for edits nobody needed.
 */
function sourceReferences(workspace: string, slug: string): { blocking: string[]; other: string[] } {
  // Mirrors the gate's own pattern rather than a substring test, so shelf/<slug>-v2 is not counted.
  const pattern = new RegExp(`shelf/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
  const gateFiles = new Set<string>();
  const skills = path.join(workspace, '.claude', 'skills');
  if (fs.existsSync(skills)) {
    for (const file of listFilesRecursive(skills)) {
      if (path.extname(file) === '.md') gateFiles.add(file);
    }
  }
  for (const name of ['CLAUDE.md', 'CONTEXT.md']) {
    const candidate = path.join(workspace, name);
    if (fs.existsSync(candidate)) gateFiles.add(candidate);
  }

  const blocking: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const name of ['docs', 'internal', 'output', '.claude']) {
    const root = path.join(workspace, name);
    if (!fs.existsSync(root)) continue;
    for (const file of listFilesRecursive(root)) {
      if (!['.md', '.json', '.ps1'].includes(path.extname(file))) continue;
      if (seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      let text: string;
      try {
        text = readUtf8(file);
      } catch {
        continue;
      }
      if (!pattern.test(text)) continue;
      const relative = workspaceRelative(workspace, file);
      if (gateFiles.has(file)) blocking.push(relative);
      else other.push(relative);
    }
  }
  for (const file of gateFiles) {
    if (seen.has(file.toLowerCase())) continue;
    let text: string;
    try {
      text = readUtf8(file);
    } catch {
      continue;
    }
    if (pattern.test(text)) blocking.push(workspaceRelative(workspace, file));
  }
  return { blocking: sortUnique(blocking), other: sortUnique(other) };
}

/** `Sort-Object -Unique`, which is culture-ordered and case-insensitive; this was ordinal until S35. */
function sortUnique(values: string[]): string[] {
  return psSortUnique(values);
}

/**
 * The rollback every writer runs, in the ONE order that is not an accident: unwind the directory
 * move, restore the journaled bytes, reopen the Desk this run closed, and RE-DERIVE the catalog
 * last. Re-deriving is the one step that can legitimately refuse -- the Shelf may be unrenderable
 * for reasons this operation did not cause -- and it was briefly placed above the Desk restore,
 * where its throw skipped reopening the reader's Book. Every step that can still be completed is
 * completed before the one that might not be.
 */
function runRollback(steps: (() => void)[]): string {
  try {
    for (const step of steps) step();
    return 'complete and verified';
  } catch (error) {
    return `FAILED: ${(error as Error).message}`;
  }
}

/**
 * Close a mutation window after a rollback. The Book is back to the state the committed manifest
 * already describes, so the marker is stale and clearing it restores a true answer -- but only when
 * the rollback VERIFIED. After one that FAILED the Book is in an unknown state and the marker stays
 * down, because refusing to describe it is the only honest answer.
 */
function settleMutation(mutation: BookMutation | null, rollback: string): void {
  if (mutation && !rollback.startsWith('FAILED')) undoBookMutation(mutation);
}

// --- rename ---------------------------------------------------------------------------------------

export function renameVerb(argv: string[], programRoot: string, workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['new-title', 'workspace', 'plan-id']);
  const slug = parsed.positional[0] ?? '';
  const newSlug = parsed.positional[1] ?? '';
  for (const candidate of [
    { value: slug, label: 'Slug' },
    { value: newSlug, label: 'NewSlug' },
  ]) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate.value)) {
      refuse(`${candidate.label} must contain only lowercase letters, digits, and hyphens.`);
    }
  }

  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) refuse('This workspace has no local Shelf catalog.');
  const catalogText = readUtf8(catalogFile);

  const entry = findShelfCatalogEntry(
    catalogText,
    slug,
    `shelf/_catalog.md lists 'shelf/${slug}' more than once; repair the catalog before renaming.`,
  );
  if (!entry) refuse(`No Shelf Book '${slug}' is listed in shelf/_catalog.md.`);
  const currentTitle = entry.title.trim();
  const isCapture = /^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(entry.body);
  let newTitle = (parsed.options.get('new-title') ?? '').trim();
  if (!newTitle) newTitle = currentTitle;
  if (newTitle.includes('\n') || newTitle.includes('\r')) refuse('NewTitle must be a single line.');
  if (newSlug === slug && newTitle === currentTitle) {
    refuse('NewSlug and NewTitle both match the current Book; there is nothing to rename.');
  }

  const oldRoot = path.join(workspace, 'shelf', slug);
  const newRoot = path.join(workspace, 'shelf', newSlug);
  const oldWiki = path.join(oldRoot, 'wiki');
  if (!fs.existsSync(oldWiki)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);

  // Collision is checked before a plan_id is issued, not after.
  if (newSlug !== slug) {
    if (fs.existsSync(newRoot)) {
      refuse(`shelf/${newSlug} already exists. Choose a slug that is free, or move that Book out of the way first.`);
    }
    if (findShelfCatalogEntry(catalogText, newSlug, `shelf/_catalog.md lists 'shelf/${newSlug}' more than once.`)) {
      refuse(`shelf/_catalog.md already lists a Book at shelf/${newSlug}.`);
    }
  }

  // EVERY SEAT THAT HOLDS THIS BOOK, not just this one, and UNDER THE REGISTRY LOCK even in the
  // preview: the scan is only true while the set of seats and their Desks cannot change.
  const desks = stateDirectory(workspace);
  const previewLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
  let previewSeats: string[];
  try {
    previewSeats = seatsHoldingEntry(workspace, desks, 'books', `shelf/${slug}`);
  } finally {
    exitBookLock(previewLock);
  }
  let seatsHolding = [...previewSeats];
  let deskHasBook = seatsHolding.length > 0;

  const manifest = pageManifest(oldWiki);
  const titlePages = ['_book.md', '_index.md'];
  const contentPages = manifest.filter((page) => !titlePages.includes(page.relative));

  const bookPagePath = path.join(oldWiki, '_book.md');
  let bookPageAction = 'absent';
  let bookPageHeading = '';
  if (fs.existsSync(bookPagePath)) {
    const headingMatch = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(readUtf8(bookPagePath));
    if (headingMatch) {
      bookPageHeading = headingMatch[1]!.trim();
      bookPageAction =
        bookPageHeading === currentTitle
          ? 'rewrite the H1 to the new title'
          : 'leave unchanged (its H1 does not match the catalog title)';
    } else {
      bookPageAction = 'leave unchanged (no H1)';
    }
  }

  // The Path line is rewritten in place, so its exact shape has to be checkable BEFORE an approval
  // is issued rather than discovered after the directory has already moved.
  const catalogPathPattern = new RegExp(
    '^([ \\t]*-[ \\t]+\\*\\*Path:\\*\\*[ \\t]+)shelf/' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([ \\t\\r]*)$',
    'm',
  );
  if (newSlug !== slug && !catalogPathPattern.test(entry.text)) {
    refuse(`The catalog entry for shelf/${slug} has no Path line this helper can rewrite. Repair shelf/_catalog.md before renaming.`);
  }

  const references = sourceReferences(workspace, slug);
  const referenceRows = referenceHits(workspace, slug, currentTitle);

  const digestSource = [
    `slug=${slug}`,
    `new_slug=${newSlug}`,
    `old_title=${currentTitle}`,
    `new_title=${newTitle}`,
    `catalog=${sha256OfText(catalogText)}`,
    `desk_open=${deskHasBook ? 'True' : 'False'}`,
    ...manifest.map((page) => `page=${page.relative}:${page.sha256}`),
  ];
  const planId = 'rename-shelf-book-' + sha256OfText(digestSource.join('\n'));

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Rename a Shelf Book',
    book: `shelf/${slug}`,
    new_book: `shelf/${newSlug}`,
    current_title: currentTitle,
    new_title: newTitle,
    kind: isCapture ? 'capture' : 'curated',
    page_count: manifest.length,
    verified_pages: contentPages.length,
    book_page_h1: bookPageHeading,
    book_page_action: bookPageAction,
    reader_map_action: isCapture ? 'regenerate from the notes on disk' : 'rewrite the H1 to the new title',
    desk_state_action: deskHasBook
      ? `rewrite shelf/${slug} to shelf/${newSlug} on ${seatsHolding.length} seat(s): ${seatsHolding.join(', ')}`
      : 'no change (the Book is not open at any seat)',
    source_references: referenceRows,
    plan_id: planId,
    confirmation_required: true,
    recoverable: true,
    shared_library_write: false,
    scope:
      "Moves this Book's directory, rewrites its catalog entry, its title pages, and the Desk state if it is open. " +
      "Every other page is verified byte-identical afterwards. Its Discovery manifest is regenerated under the new " +
      "slug and the old slug's manifest store is retired. Source references listed above are tracked text and are " +
      'migrated with the same commit; this helper does not edit them.',
  };
  void references;
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('The Book was not renamed: review the preflight and rerun with its exact --plan-id.');
  if (approved !== planId) {
    refuse(
      'The Book was not renamed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. ' +
        'A different plan_id means the Book, its catalog entry, or the Desk changed since you approved it.',
    );
  }

  // Both roots, in a fixed order, so two renames crossing each other cannot deadlock. The new root
  // is held as well because a rename is the one operation whose Book identity changes: a writer
  // creating shelf/<NewSlug> mid-move would otherwise be silently absorbed.
  const lockRoots = [...new Set([`shelf/${slug}`, `shelf/${newSlug}`])].sort();
  const locks: BookLock[] = [];
  let registryLock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  let moved = false;
  // SET AFTER THE RENDER RETURNS, NEVER BEFORE IT IS CALLED. The flag means "this operation changed
  // the catalog", and a render that THREW did not: it writes atomically and verifies by readback, so
  // a failure leaves the previous catalog exactly where it was. A rollback that says it failed when
  // it did not is the same defect as one that says it succeeded when it did not.
  let catalogRendered = false;

  try {
    // THE REGISTRY LOCK FIRST. The Desk writer holds only this lock, so the Book locks below exclude
    // nothing a seat opening the Book would do.
    registryLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
    for (const root of lockRoots) locks.push(enterBookLock(workspace, root, LOCK_TIMEOUT_SECONDS));

    // Rescanned under the lock and compared to what the reader approved. `desk_open` in the digest
    // binds only whether ANY seat held it; the SET is what this operation acts on, so the set is
    // what is revalidated.
    seatsHolding = seatsHoldingEntry(workspace, desks, 'books', `shelf/${slug}`);
    if (seatsHolding.join(',') !== previewSeats.join(',')) {
      refuse(
        `the seats holding shelf/${slug} changed after approval (was: ` +
          `${previewSeats.length ? previewSeats.join(', ') : 'none'}; ` +
          `now: ${seatsHolding.length ? seatsHolding.join(', ') : 'none'}). Rerun the preflight`,
      );
    }
    deskHasBook = seatsHolding.length > 0;

    // The window opens on the Book's CURRENT identity, before the directory moves -- that identity
    // is the one the stored manifest describes, and it is the one that stops being true.
    const oldLock = locks.find((lock) => lock.bookRoot === `shelf/${slug}`)!;
    mutation = enterBookMutation({
      workspace,
      slug,
      bookRoot: `shelf/${slug}`,
      reason: `Rename shelf/${slug} to shelf/${newSlug}`,
      lock: oldLock,
    });

    // Prior state, at the paths it currently occupies. shelf/_catalog.md IS NOT AMONG THEM: it is
    // rendered from the entry files, so a journaled snapshot of it is a snapshot of every OTHER Book
    // too. The entry file is the half this operation owns; the catalog is re-derived in the rollback.
    const journalTargets = [
      ...seatsHolding.map((seat) => deskFilePath(desks, seat, 'books')),
      path.join(oldWiki, '_book.md'),
      path.join(oldWiki, '_index.md'),
      shelfCatalogEntryPath(workspace, slug),
    ];
    journalPath = writeBookJournal({
      workspace,
      bookRoot: `shelf/${slug}`,
      operation: `Rename shelf/${slug} to shelf/${newSlug}`,
      paths: journalTargets,
      operationDigest: planId,
    }).journalPath;

    if (newSlug !== slug) {
      fs.renameSync(oldRoot, newRoot);
      moved = true;
    }
    const liveRoot = newSlug !== slug ? newRoot : oldRoot;
    const liveWiki = path.join(liveRoot, 'wiki');

    // The rewrite is confined to this Book's FILE: no offset into a shared document, so a catalog
    // that moved on since the plan was made cannot be mangled by a stale index. The entry travelled
    // with the directory, so the path below is the one under the new slug either way.
    let updatedSection = entry.text.replace(/^##[ \t]+.+?[ \t]*(\r?\n|$)/, `## ${newTitle}$1`);
    if (newSlug !== slug) {
      updatedSection = updatedSection.replace(catalogPathPattern, `$1shelf/${newSlug}$2`);
    }
    invokeShelfCatalogRender({
      workspace,
      programRoot,
      writeEntry: [{ path: shelfCatalogEntryPath(workspace, newSlug), text: updatedSection }],
    });
    catalogRendered = true;

    const liveBookPage = path.join(liveWiki, '_book.md');
    if (fs.existsSync(liveBookPage) && bookPageAction === 'rewrite the H1 to the new title') {
      const text = readUtf8(liveBookPage);
      writeUtf8(liveBookPage, text.replace(/^#[ \t]+.+?[ \t]*(\r?\n|$)/, `# ${newTitle}$1`));
    }

    if (isCapture) {
      // The catalog is the authority for a capture Book's title, so regenerating the map from disk
      // picks up the new one and re-proves the map against the notes in the same step.
      updateShelfNoteIndex(getShelfBook(workspace, newSlug));
    } else {
      const liveMap = path.join(liveWiki, '_index.md');
      if (fs.existsSync(liveMap)) {
        const text = readUtf8(liveMap);
        const mapHeading = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(text);
        if (mapHeading && mapHeading[1]!.trim().startsWith(currentTitle)) {
          const rewritten = newTitle + mapHeading[1]!.trim().substring(currentTitle.length);
          writeUtf8(liveMap, text.replace(/^#[ \t]+.+?[ \t]*(\r?\n|$)/, `# ${rewritten}$1`));
        }
      }
    }

    if (deskHasBook && newSlug !== slug) {
      updateDeskEntryAcrossSeats({
        workspace,
        stateDirectory: desks,
        kind: 'books',
        from: `shelf/${slug}`,
        to: `shelf/${newSlug}`,
      });
    }

    // --- verify, rather than assume ---------------------------------------------------------------
    const problems: string[] = [];
    if (newSlug !== slug && fs.existsSync(oldRoot)) problems.push(`shelf/${slug} still exists after the move`);
    if (!fs.existsSync(liveWiki)) problems.push(`shelf/${newSlug}/wiki is missing after the move`);

    const afterByPath = new Map(pageManifest(liveWiki).map((page) => [page.relative, page.sha256]));
    for (const page of contentPages) {
      if (!afterByPath.has(page.relative)) problems.push(`${page.relative} is missing after the move`);
      else if (afterByPath.get(page.relative) !== page.sha256) {
        problems.push(`${page.relative} is not byte-identical after the move`);
      }
    }

    const afterCatalog = readUtf8(shelfCatalogPath(workspace));
    const afterEntry = findShelfCatalogEntry(afterCatalog, newSlug, 'the rendered catalog lists this Book twice');
    if (!afterEntry) problems.push(`shelf/_catalog.md no longer lists a Book at shelf/${newSlug}`);
    else if (afterEntry.title.trim() !== newTitle) problems.push('the catalog heading was not rewritten to the new title');
    if (newSlug !== slug && findShelfCatalogEntry(afterCatalog, slug, 'the rendered catalog lists the old slug twice')) {
      problems.push(`shelf/_catalog.md still lists shelf/${slug}`);
    }

    if (newSlug !== slug) {
      for (const seat of seatsHolding) {
        const afterDesk = deskEntriesForSeat(desks, seat, 'books');
        if (!afterDesk.includes(`shelf/${newSlug}`)) {
          problems.push(`seat '${seat}' no longer has this Book open under its new root`);
        }
        if (afterDesk.includes(`shelf/${slug}`)) problems.push(`seat '${seat}' still names the old Book root`);
      }
      // OUTSIDE the deskHasBook branch, and that is the fix: a rename whose snapshot found no holder
      // used to skip the straggler check altogether -- exactly the case where a seat opening the Book
      // after the snapshot would be left behind. The registry lock now makes that race impossible;
      // running the sweep anyway is what would notice if the lock ever stopped being taken.
      const stragglers = seatsHoldingEntry(workspace, desks, 'books', `shelf/${slug}`);
      if (stragglers.length) problems.push(`these seats still name the old Book root: ${stragglers.join(', ')}`);
    }

    if (problems.length) refuse(problems.join('; '));

    // Only now, with the move verified. A slug change moves the Book's IDENTITY, so the old slug's
    // store is retired rather than carried across; a title-only rename keeps the identity and simply
    // commits the next generation. Neither can throw: the rename has landed and must not be undone
    // over metadata.
    plan['manifest'] =
      newSlug !== slug
        ? completeBookRenameMutation({
            mutation,
            newSlug,
            newBookRoot: `shelf/${newSlug}`,
            newLock: locks.find((lock) => lock.bookRoot === `shelf/${newSlug}`)!,
          }).summary
        : completeBookMutation(mutation).summary;
    mutation = null;

    plan['status'] = 'renamed';
    plan['book_path'] = `shelf/${newSlug}/wiki`;
    plan['reader_map'] = `shelf/${newSlug}/wiki/_index.md`;
    plan['pages_verified_identical'] = contentPages.length;
    plan['journal'] = workspaceRelative(workspace, journalPath);
    plan['next'] = 'Migrate the source references listed above in the same commit, then run tools/Invoke-LibraryChecks.ps1.';
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback([
      () => {
        if (moved && fs.existsSync(newRoot) && !fs.existsSync(oldRoot)) fs.renameSync(newRoot, oldRoot);
      },
      () => {
        if (journalPath) restoreBookJournal(journalPath);
      },
      () => {
        if (catalogRendered) invokeShelfCatalogRenderAfterRollback(workspace, programRoot);
      },
    ]);
    settleMutation(mutation, rollback);
    return {
      refusal: `The Book was not renamed. ${failure}. Rollback: ${rollback}. Journal: ${journalPath}`,
      value: null,
    };
  } finally {
    for (const lock of locks) exitBookLock(lock);
    // Released last, in reverse acquisition order.
    exitBookLock(registryLock);
  }

  return { refusal: null, value: plan };
}

/**
 * The reference rows the rename reports: one per (file, needle) pair, with a count. Reported and
 * NEVER rewritten -- a doc recording a dated event under the old name is a true record, and this
 * helper is not the judge of which is which.
 */
function referenceHits(workspace: string, slug: string, title: string): PsJsonValue {
  const roots = ['tools', 'docs', '.claude/skills', '.claude/hooks', '.claude/adapters'].map((name) =>
    path.join(workspace, ...name.split('/')),
  );
  const files: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of listFilesRecursive(root)) {
      if (['.ps1', '.md'].includes(path.extname(file))) files.push(file);
    }
  }
  for (const name of ['CLAUDE.md', 'CONTEXT.md', 'PLAN.md']) {
    const candidate = path.join(workspace, name);
    if (fs.existsSync(candidate)) files.push(candidate);
  }

  const needles = [`shelf/${slug}`];
  if (title.trim()) needles.push(title);
  const hits: { path: string; names: string; count: number }[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readUtf8(file);
    } catch {
      continue;
    }
    for (const needle of needles) {
      // Ordinal, so 'shelf/inbox-archive' never counts as a hit on 'shelf/inbox'.
      if (!text.includes(needle)) continue;
      hits.push({ path: workspaceRelative(workspace, file), names: needle, count: countOccurrences(text, needle) });
    }
  }
  hits.sort((left, right) =>
    left.path === right.path ? (left.names < right.names ? -1 : 1) : left.path < right.path ? -1 : 1,
  );
  return hits as unknown as PsJsonValue;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function writeUtf8(file: string, text: string): void {
  fs.writeFileSync(file, text, { encoding: 'utf8' });
}

/** The reader map of a capture Book, regenerated from the notes on disk rather than appended to. */
function updateShelfNoteIndex(book: ShelfBook): void {
  const notesRoot = book.notesPath;
  const notes = fs.existsSync(notesRoot)
    ? fs
        .readdirSync(notesRoot, { withFileTypes: true })
        .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md'))
        .map((item) => item.name)
        .sort()
        .map((name) => {
          const content = readUtf8(path.join(notesRoot, name));
          const titleMatch = /^#[ \t]+(.+?)[ \t]*$/m.exec(content);
          const base = name.replace(/\.md$/i, '');
          const captured = /^captured:\s*(.*)$/m.exec(content);
          const review = /^review:\s*(.*)$/m.exec(content);
          return {
            page: `notes/${base}`,
            title: titleMatch ? titleMatch[1]!.trim() : base,
            captured: captured && captured[1]!.trim() ? captured[1]!.trim() : 'unknown',
            review: review && review[1]!.trim() ? review[1]!.trim() : 'pending',
          };
        })
    : [];
  const byCapturedDescending = (left: { captured: string }, right: { captured: string }): number =>
    left.captured < right.captured ? 1 : left.captured > right.captured ? -1 : 0;
  const pending = notes.filter((note) => note.review !== 'done').sort(byCapturedDescending);
  const reviewed = notes.filter((note) => note.review === 'done').sort(byCapturedDescending);
  const lines = [`# ${book.title} - Reader Map`, '', '- [[_book|Book metadata and limits]]', '', '## Pending review', ''];
  if (pending.length) for (const note of pending) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
  else lines.push('- Nothing is waiting for review.');
  lines.push('', '## Reviewed', '');
  if (reviewed.length) for (const note of reviewed) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
  else lines.push('- No note has been reviewed yet.');
  writeUtf8(path.join(book.wikiPath, '_index.md'), lines.join('\n') + '\n');
}

// --- remove ---------------------------------------------------------------------------------------

/**
 * The local Shelf's destructive exit. NO LOCAL ARCHIVE COPY IS CREATED -- that is the whole
 * difference from `archive`, and it is why the plan says `recoverable: false`.
 *
 * A FOREIGN HOLDER IS A REFUSAL, not something to close on the reader's behalf. Detecting every seat
 * was only half of it: the apply path used to close the CALLER's Desk and delete anyway, leaving each
 * foreign seat an entry that would entitle it to whatever Book landed on that slug next.
 */
export function removeVerb(argv: string[], programRoot: string, workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['reason', 'seat', 'workspace', 'plan-id']);
  const slug = parsed.positional[0] ?? '';
  if (!STRICT_SLUG_PATTERN.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');

  const desks = stateDirectory(workspace);
  const actingSeat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory: desks });
  const reason = parsed.options.get('reason') ?? '';

  const previewLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
  let preview: DeletePlan;
  try {
    preview = deletePlan(workspace, slug, reason, actingSeat);
  } finally {
    exitBookLock(previewLock);
  }
  if (parsed.flags.has('preflight')) return { refusal: null, value: preview.document };

  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('The Shelf Book was not deleted: review the preflight and rerun with its exact --plan-id.');
  if (approved !== preview.planId) {
    refuse('The Shelf Book was not deleted: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.');
  }

  const activeRoot = path.join(workspace, 'shelf', slug);
  const stagingParent = path.join(workspace, 'internal', 'shelf-delete-staging');
  const stagingRoot = path.join(stagingParent, preview.planId);
  let lock: BookLock | null = null;
  let registryLock: BookLock | null = null;
  let mutation: BookMutation | null = null;
  let journalPath: string | null = null;
  let moved = false;
  let catalogChanged = false;
  let deskClosed = false;
  let permanentDeleteStarted = false;
  const wasOpen = preview.wasOpen;
  const document = preview.document;

  try {
    // Registry lock first: the total order is registry -> book, and the cross-seat holder scan is
    // only true while no seat can open the Book underneath it.
    registryLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
    lock = enterBookLock(workspace, `shelf/${slug}`, LOCK_TIMEOUT_SECONDS);
    const current = deletePlan(workspace, slug, reason, actingSeat);
    if (current.planId !== approved) refuse('the Book, Shelf Catalog, reason, or Desk state changed after approval');
    if (fs.existsSync(stagingRoot)) {
      refuse(`deletion staging already exists at internal/shelf-delete-staging/${preview.planId}; inspect it before retrying`);
    }

    mutation = enterBookMutation({
      workspace,
      slug,
      bookRoot: `shelf/${slug}`,
      reason: `Delete shelf/${slug}`,
      lock,
    });
    // NO PATHS. Everything this operation owns -- the Book's pages and its _catalog-entry.md -- moves
    // into staging as one tree and is moved back as one tree, which a journal of file bytes cannot
    // express anyway.
    journalPath = writeBookJournal({
      workspace,
      bookRoot: `shelf/${slug}`,
      operation: `Delete shelf/${slug}`,
      paths: [],
      operationDigest: approved,
    }).journalPath;

    if (wasOpen) {
      deskClosed = setDeskEntryForSeat({
        workspace,
        stateDirectory: desks,
        seat: actingSeat,
        kind: 'books',
        entry: `shelf/${slug}`,
        action: 'Remove',
      });
    }
    ensureDirectory(stagingParent);
    fs.renameSync(activeRoot, stagingRoot);
    moved = true;

    // The entry file went into staging with the rest of the Book, so the catalog is re-rendered from
    // what is left rather than edited by offset.
    if (!findShelfCatalogEntry(readUtf8(shelfCatalogPath(workspace)), slug, 'the catalog lists this Book twice')) {
      refuse(`the approved Shelf Catalog entry for shelf/${slug} disappeared before deletion`);
    }
    invokeShelfCatalogRender({ workspace, programRoot });
    catalogChanged = true;

    const after = new Map(pageManifest(stagingRoot).map((file) => [file.relative, file.sha256]));
    for (const file of preview.files) {
      if (!after.has(file.relative)) refuse(`staged file '${file.relative}' is missing`);
      if (after.get(file.relative) !== file.sha256) refuse(`staged file '${file.relative}' is not byte-identical`);
    }
    if (after.size !== preview.files.length) refuse('the staged Book contains an unapproved file');
    if (fs.existsSync(activeRoot)) refuse(`shelf/${slug} still exists after staging`);
    if (findShelfCatalogEntry(readUtf8(shelfCatalogPath(workspace)), slug, 'the catalog lists this Book twice')) {
      refuse(`shelf/_catalog.md still lists shelf/${slug}`);
    }

    if (!isWithin(stagingRoot, stagingParent)) refuse('the resolved deletion staging path escaped internal/shelf-delete-staging');
    permanentDeleteStarted = true;
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    if (fs.existsSync(stagingRoot)) refuse('the staged Book still exists after permanent deletion');
    moved = false;

    let manifestResult = 'not present';
    try {
      manifestResult = removeBookManifestStore(workspace, slug) ? 'retired' : 'not present';
    } catch (error) {
      // The dirty marker was placed before any mutation. If derived-store cleanup fails after the
      // irreversible delete, leaving it dirty is safer than claiming searchable metadata is valid.
      manifestResult = `dirty orphan requiring Update-BookManifests: ${(error as Error).message}`;
    }
    mutation = null;

    document['status'] = 'deleted';
    document['local_book_deleted'] = true;
    document['manifest'] = manifestResult;
    document['journal'] = workspaceRelative(workspace, journalPath);
  } catch (error) {
    const failure = (error as Error).message;
    let rollback = 'not required';
    if (permanentDeleteStarted) {
      rollback = 'not possible after permanent deletion began';
    } else {
      rollback = runRollback([
        () => {
          if (moved && fs.existsSync(stagingRoot) && !fs.existsSync(activeRoot)) fs.renameSync(stagingRoot, activeRoot);
        },
        () => {
          if (journalPath) restoreBookJournal(journalPath);
        },
        () => {
          // Reopened only if this run actually closed it, and BEFORE the catalog: re-deriving is the
          // one step that can legitimately refuse, and it was briefly placed above this, where its
          // throw skipped reopening the reader's Book.
          if (deskClosed && fs.existsSync(activeRoot)) {
            setDeskEntryForSeat({
              workspace,
              stateDirectory: desks,
              seat: actingSeat,
              kind: 'books',
              entry: `shelf/${slug}`,
              action: 'Add',
            });
          }
        },
        () => {
          if (catalogChanged) invokeShelfCatalogRenderAfterRollback(workspace, programRoot);
        },
      ]);
      settleMutation(mutation, rollback);
    }
    return { refusal: `The Shelf Book was not deleted. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
    exitBookLock(registryLock);
  }

  return { refusal: null, value: document };
}

interface DeletePlan {
  planId: string;
  document: Record<string, PsJsonValue>;
  files: PageHash[];
  wasOpen: boolean;
}

function deletePlan(workspace: string, slug: string, reason: string, actingSeat: string): DeletePlan {
  const activeRoot = path.join(workspace, 'shelf', slug);
  const catalogFile = shelfCatalogPath(workspace);
  const desks = stateDirectory(workspace);
  if (!fs.existsSync(activeRoot)) refuse(`Shelf Book '${slug}' was not found at shelf/${slug}.`);
  if (!fs.existsSync(catalogFile)) refuse('shelf/_catalog.md was not found.');
  const book = getShelfBook(workspace, slug);
  if (book.isCapture) {
    refuse(
      `Shelf Book '${slug}' is a capture Book. Its notes must be triaged individually; the capture surface cannot be deleted wholesale.`,
    );
  }
  const catalogText = readUtf8(catalogFile);
  const entry = findShelfCatalogEntry(
    catalogText,
    slug,
    `shelf/_catalog.md lists 'shelf/${slug}' more than once; repair the Catalog before deleting.`,
  );
  if (!entry) refuse(`shelf/_catalog.md lists no Book at shelf/${slug}.`);
  // `Get-ChildItem -File -Recurse | Sort-Object FullName`: the measured culture order, over the path as
  // Windows spells it, since a `/` and a `\` weigh differently (S35).
  const files = pageManifest(activeRoot).sort((left, right) => psSortCompare(left.relative.replace(/\//g, '\\'), right.relative.replace(/\//g, '\\')));
  if (files.length === 0) refuse(`Shelf Book '${slug}' contains no files; repair or remove it by hand.`);

  const holders = seatsHoldingEntry(workspace, desks, 'books', `shelf/${slug}`);
  const foreign = holders.filter((seat) => seat !== actingSeat).sort();
  if (foreign.length) {
    // Refused BEFORE a plan_id is issued: an approval for an operation already certain to fail is
    // worse than no approval.
    refuse(
      `shelf/${slug} is open at ${foreign.length} other seat(s): ${foreign.join(', ')}. ` +
        'Deletion would leave each of them an entry naming a Book that no longer exists, and entitling ' +
        'them to whatever Book lands on that slug next. Close it at those seats first.',
    );
  }
  const wasOpen = holders.length > 0;
  const reasonText = reason.trim();
  const digestSource = [
    'action=delete-shelf-book',
    `slug=${slug}`,
    `title=${book.title}`,
    `reason=${reasonText}`,
    // The approved action removes this exact entry. Binding the whole Catalog made two otherwise
    // independent deletions invalidate each other merely because the first removed its own entry.
    `catalog_entry=${sha256OfText(entry.text)}`,
    // The acting seat is bound too: `desk_open` means "open at THIS seat", so the same digest under
    // a different seat would describe a different operation.
    `acting_seat=${actingSeat}`,
    `desk_open=${wasOpen ? 'true' : 'false'}`,
    ...files.map((file) => `file=${file.relative}:${file.sha256}`),
  ];
  const planId = 'delete-shelf-book-' + sha256OfText(digestSource.join('\n'));
  const references = sourceReferences(workspace, slug);
  return {
    planId,
    files,
    wasOpen,
    document: {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: 'Permanently delete a Shelf Book',
      book: `shelf/${slug}`,
      book_title: book.title,
      file_count: files.length,
      files: files.map((file) => ({ relative: file.relative, sha256: file.sha256 })),
      reason: reasonText ? reasonText : '(none given)',
      catalog_action: `remove the '${entry.title.trim()}' entry from shelf/_catalog.md`,
      acting_seat: actingSeat,
      desk_action: wasOpen
        ? `close this Book on seat '${actingSeat}' before deletion (a live claim is required for that write)`
        : 'none (the Book is already closed)',
      blocking_references: references.blocking,
      other_references: references.other,
      plan_id: planId,
      confirmation_required: true,
      destructive: true,
      recoverable: false,
      shared_library_write: false,
      scope:
        'Permanently deletes this local Shelf Book after staging and verification. No local archive copy is created. ' +
        'The action cannot be undone after staged deletion succeeds.',
    },
  };
}

/**
 * `Remove-ShelfBook.ps1 -Preflight` as another helper runs it (S35): the acting seat resolved as the oracle
 * resolves it with no `-Seat`, the plan read under the registry lock, and the document WITHOUT `schema` --
 * `Write-LibraryResult` stamps that only on what reaches stdout, so a plan nested in a publisher's plan
 * carries none, measured.
 */
export function shelfDeletePreflight(workspace: string, slug: string, reason: string): Record<string, PsJsonValue> {
  if (!STRICT_SLUG_PATTERN.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');
  const actingSeat = requireSeat({ stateDirectory: stateDirectory(workspace) });
  const previewLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
  try {
    const { schema: _schema, ...document } = deletePlan(workspace, slug, reason, actingSeat).document;
    return document;
  } finally {
    exitBookLock(previewLock);
  }
}

function isWithin(child: string, parent: string): boolean {
  const parentPath = path.resolve(parent).replace(/[\\/]+$/, '') + path.sep;
  return path.resolve(child).toLowerCase().startsWith(parentPath.toLowerCase());
}

// --- archive and restore ----------------------------------------------------------------------------

/**
 * AN ARCHIVED BOOK RESTS; IT IS NOT FORGOTTEN. Archiving used to RETIRE the Book's Discovery
 * manifest, which made it the act that removed a Book from search -- and left every Discovery answer
 * still claiming it had covered the whole collection, because the roster it counted against had
 * quietly shrunk with it. The manifest now MOVES, from the `shelf` store to `shelf-archive`.
 *
 * WHAT ARCHIVING STILL MEANS: out of `shelf/_catalog.md`, so no Shelf writer will touch it and it is
 * absent from the active Shelf a reader browses; findable, labelled, and read-only.
 */
export function archiveVerb(argv: string[], programRoot: string, workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['reason', 'workspace', 'plan-id']);
  const slug = parsed.positional[0] ?? '';
  if (!STRICT_SLUG_PATTERN.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');

  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) refuse('shelf/_catalog.md was not found.');
  const catalogText = readUtf8(catalogFile);
  const desks = stateDirectory(workspace);
  const activeRoot = path.join(workspace, 'shelf', slug);
  const archiveRoot = path.join(workspace, 'shelf', ARCHIVE_FOLDER);
  const archivedRoot = path.join(archiveRoot, slug);
  const recordFile = archiveRecordPath(workspace, slug);
  const reason = parsed.options.get('reason') ?? '';

  const book = getShelfBook(workspace, slug);
  if (book.isCapture) {
    refuse(
      `Shelf Book '${slug}' is a capture Book. Its notes are triaged with tools/Invoke-LibraryTriage.ps1; a capture surface is not archived wholesale.`,
    );
  }
  const previewLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
  let openRoots: string[];
  try {
    openRoots = openBookRootsEverywhere(workspace, desks);
  } finally {
    exitBookLock(previewLock);
  }
  if (openRoots.includes(`shelf/${slug}`)) {
    refuse(
      `shelf/${slug} is open on the Desk. Close it first with tools/Set-VirtualDesk.ps1 -Action Close -Kind Book -Location Shelf -Slug ${slug}, so archiving never happens to material in play.`,
    );
  }
  if (fs.existsSync(archivedRoot)) {
    refuse(`shelf/${ARCHIVE_FOLDER}/${slug} already exists. Restore or move that archived Book out of the way first.`);
  }
  const entry = findShelfCatalogEntry(
    catalogText,
    slug,
    `shelf/_catalog.md lists 'shelf/${slug}' more than once; repair the catalog before archiving.`,
  );
  if (!entry) refuse(`shelf/_catalog.md lists no Book at shelf/${slug}.`);

  const wikiPath = path.join(activeRoot, 'wiki');
  if (!fs.existsSync(wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  const manifest = pageManifest(wikiPath);
  const references = sourceReferences(workspace, slug);

  const digestSource = [
    'action=archive',
    `slug=${slug}`,
    `title=${book.title}`,
    `catalog=${sha256OfText(catalogText)}`,
    ...manifest.map((page) => `page=${page.relative}:${page.sha256}`),
  ];
  const planId = 'archive-shelf-book-' + sha256OfText(digestSource.join('\n'));

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Archive a Shelf Book',
    book: `shelf/${slug}`,
    book_title: book.title,
    destination: `shelf/${ARCHIVE_FOLDER}/${slug}`,
    page_count: manifest.length,
    reason: reason.trim() ? reason : '(none given)',
    catalog_action: `remove the '${entry.title.trim()}' entry from shelf/_catalog.md`,
    manifest_action:
      "move this Book's Discovery manifest into the archive store, so search keeps covering it and labels it archived",
    desk_action: 'none (the Book must already be closed)',
    blocking_references: references.blocking,
    other_references: references.other,
    plan_id: planId,
    confirmation_required: true,
    recoverable: true,
    shared_library_write: false,
    scope:
      "Moves this Book's whole directory into the local archive, removes its Book Catalog entry, and moves its " +
      'Discovery manifest into the archive store. Every page is verified byte-identical at the archive path ' +
      'afterwards. The Book stays findable and is LABELLED archived: Discovery covers it, and it opens read-only on ' +
      'the Desk with -Shelf Archive, which is what full text needs. It is out of the active Shelf catalog, so no ' +
      'Shelf writer will touch it. Nothing is deleted, and -Action Restore puts it back.',
    next: references.blocking.length
      ? `blocking_references lists ${references.blocking.length} file(s) on a surface shelf.references-resolve reads, so the gate WILL fail until they are updated in the same commit. other_references are mentions the gate does not read; a dated record naming this Book stays true and needs no edit.`
      : `No blocking references: nothing on a surface shelf.references-resolve reads names this Book, so the gate will pass. other_references lists ${references.other.length} mention(s) elsewhere -- history rather than live claims, and no edit is needed for the gate.`,
  };
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('The Book was not archived: review the preflight and rerun with its exact --plan-id.');
  if (approved !== planId) {
    refuse(
      'The Book was not archived: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. ' +
        'A different plan_id means the Book or the catalog changed since you approved it.',
    );
  }

  let lock: BookLock | null = null;
  let registryLock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  let moved = false;
  let catalogRendered = false;

  try {
    registryLock = enterSeatRegistryLock(workspace, LOCK_TIMEOUT_SECONDS);
    lock = enterBookLock(workspace, `shelf/${slug}`, LOCK_TIMEOUT_SECONDS);

    // Re-asserted under the lock, not trusted from the preview. This is the check-then-act the lock
    // exists to close, so the act has to sit on this side of it.
    if (openBookRootsEverywhere(workspace, desks).includes(`shelf/${slug}`)) {
      refuse(`shelf/${slug} was opened on a Desk after the preflight. Close it at every seat, then rerun the preflight`);
    }

    mutation = enterBookMutation({
      workspace,
      slug,
      bookRoot: `shelf/${slug}`,
      reason: `Archive shelf/${slug}`,
      lock,
    });
    journalPath = writeBookJournal({
      workspace,
      bookRoot: `shelf/${slug}`,
      operation: `Archive shelf/${slug}`,
      paths: [],
      operationDigest: planId,
    }).journalPath;

    ensureDirectory(archiveRoot);
    fs.renameSync(activeRoot, archivedRoot);
    moved = true;

    // The catalog entry, VERBATIM. A restore puts back what the reader wrote rather than a
    // regenerated approximation of it -- summary lines, Kind markers and annotations included.
    const record: PsJsonValue = {
      schema: 1,
      slug,
      title: book.title,
      archived_on: today(),
      reason: reason.trim() ? reason : '',
      page_count: manifest.length,
      catalog_entry: entry.text,
    };
    writeUtf8(recordFile, psConvertToJson(record) + '\n');

    // THE ENTRY FILE ARCHIVED ITSELF: it lives inside shelf/<slug>/, so the move above already took
    // it out of the active Shelf. There is no offset arithmetic left to get wrong, and no window in
    // which the catalog and the entry disagree about which Books exist.
    invokeShelfCatalogRender({ workspace, programRoot });
    catalogRendered = true;

    const problems: string[] = [];
    if (fs.existsSync(activeRoot)) problems.push(`shelf/${slug} still exists after the move`);
    const archivedWiki = path.join(archivedRoot, 'wiki');
    if (!fs.existsSync(archivedWiki)) problems.push('the archived Book has no wiki directory');
    else {
      const after = new Map(pageManifest(archivedWiki).map((page) => [page.relative, page.sha256]));
      for (const page of manifest) {
        if (!after.has(page.relative)) problems.push(`${page.relative} is missing after the move`);
        else if (after.get(page.relative) !== page.sha256) problems.push(`${page.relative} is not byte-identical after the move`);
      }
    }
    if (findShelfCatalogEntry(readUtf8(shelfCatalogPath(workspace)), slug, 'the catalog lists this Book twice')) {
      problems.push(`shelf/_catalog.md still lists shelf/${slug}`);
    }
    if (problems.length) refuse(problems.join('; '));

    // Only now, with the move verified. THE MANIFEST FOLLOWS THE BOOK. It is generated HERE, from
    // the pages at their ARCHIVE path, because the transaction refuses to self-generate for any
    // collection but the active Shelf -- and rightly, since resolving a slug goes through a catalog
    // this Book has just left.
    let archivedLock: BookLock | null = null;
    try {
      archivedLock = enterBookLock(workspace, archivedBookRoot(slug), LOCK_TIMEOUT_SECONDS);
      const archivedManifest = newBookManifestForShelfBook(getArchivedShelfBook(workspace, slug)) as PsJsonValue;
      plan['manifest'] = completeBookRenameMutation({
        mutation,
        newSlug: slug,
        newBookRoot: archivedBookRoot(slug),
        newLock: archivedLock,
        newCollection: 'shelf-archive',
        manifest: archivedManifest,
      }).summary;
    } finally {
      exitBookLock(archivedLock);
    }
    mutation = null;

    plan['status'] = 'archived';
    plan['archive_record'] = `shelf/${ARCHIVE_FOLDER}/${slug}/${ARCHIVE_RECORD_NAME}`;
    plan['pages_verified_identical'] = manifest.length;
    plan['journal'] = workspaceRelative(workspace, journalPath);
    plan['next'] = references.blocking.length
      ? 'Run tools/Invoke-LibraryChecks.ps1. shelf.references-resolve will fail until blocking_references are updated.'
      : 'Run tools/Invoke-LibraryChecks.ps1; nothing here should need editing for it to pass.';
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback([
      () => {
        if (moved && fs.existsSync(archivedRoot) && !fs.existsSync(activeRoot)) {
          if (fs.existsSync(recordFile)) fs.rmSync(recordFile, { force: true });
          fs.renameSync(archivedRoot, activeRoot);
        }
      },
      () => {
        if (journalPath) restoreBookJournal(journalPath);
      },
      () => {
        if (catalogRendered) invokeShelfCatalogRenderAfterRollback(workspace, programRoot);
      },
    ]);
    settleMutation(mutation, rollback);
    return { refusal: `The Book was not archived. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
    exitBookLock(registryLock);
  }

  return { refusal: null, value: plan };
}

function openBookRootsEverywhere(workspace: string, desks: string): string[] {
  const seen = new Set<string>();
  for (const row of deskEntriesAcrossSeats(workspace, desks, 'books')) {
    for (const entry of row.entries) seen.add(entry);
  }
  return [...seen];
}

/**
 * RESTORE IS PART OF THE FEATURE, NOT A FOLLOW-UP. An archive with no way back re-creates by hand
 * exactly the hand-editing the archiver exists to remove, and the entry it puts back is the one the
 * reader WROTE rather than a regenerated approximation of it.
 */
export function restoreVerb(argv: string[], programRoot: string, workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['workspace', 'plan-id']);
  const slug = parsed.positional[0] ?? '';
  if (!STRICT_SLUG_PATTERN.test(slug)) refuse('BookSlug must use lowercase letters, digits, and single hyphens.');

  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) refuse('shelf/_catalog.md was not found.');
  const catalogText = readUtf8(catalogFile);
  const activeRoot = path.join(workspace, 'shelf', slug);
  const archivedRoot = path.join(workspace, 'shelf', ARCHIVE_FOLDER, slug);
  const recordFile = archiveRecordPath(workspace, slug);

  if (!fs.existsSync(archivedRoot)) {
    refuse(`shelf/${ARCHIVE_FOLDER}/${slug} was not found. Run -Action List to see what is archived.`);
  }
  if (fs.existsSync(activeRoot)) refuse(`shelf/${slug} already exists on the active Shelf. Rename or archive that Book first.`);
  if (!fs.existsSync(recordFile)) {
    refuse(
      `shelf/${ARCHIVE_FOLDER}/${slug} has no ${ARCHIVE_RECORD_NAME}, so the catalog entry it was archived with is not ` +
        'recoverable. Restore it by hand, or re-add it with tools/Import-ExternalWikiToShelf.ps1.',
    );
  }
  // Read before anything moves: the rollback needs these exact bytes to put the record back, and by
  // then the file it came from is inside a directory that has been moved.
  const recordText = readUtf8(recordFile);
  const record = JSON.parse(recordText) as Record<string, unknown>;
  if (!('catalog_entry' in record)) refuse(`The archive record for ${slug} carries no catalog entry.`);
  if (findShelfCatalogEntry(catalogText, slug, `shelf/_catalog.md lists 'shelf/${slug}' more than once.`)) {
    refuse(`shelf/_catalog.md already lists a Book at shelf/${slug}. Repair the catalog before restoring.`);
  }

  const archivedWiki = path.join(archivedRoot, 'wiki');
  if (!fs.existsSync(archivedWiki)) refuse(`The archived Book at shelf/${ARCHIVE_FOLDER}/${slug} has no wiki directory.`);
  const restoreManifest = pageManifest(archivedWiki);
  const entryText = String(record['catalog_entry']);

  const digestSource = [
    'action=restore',
    `slug=${slug}`,
    `catalog=${sha256OfText(catalogText)}`,
    `entry=${sha256OfText(entryText)}`,
    ...restoreManifest.map((page) => `page=${page.relative}:${page.sha256}`),
  ];
  const planId = 'restore-shelf-book-' + sha256OfText(digestSource.join('\n'));

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Restore an archived Shelf Book',
    book: `shelf/${ARCHIVE_FOLDER}/${slug}`,
    destination: `shelf/${slug}`,
    book_title: 'title' in record ? String(record['title']) : slug,
    archived_on: 'archived_on' in record ? String(record['archived_on']) : '',
    page_count: restoreManifest.length,
    catalog_action: 'append the archived entry back to shelf/_catalog.md, exactly as it was removed',
    manifest_action:
      "retire the archive store's manifest and regenerate this Book's active one from the pages as they now stand",
    plan_id: planId,
    confirmation_required: true,
    recoverable: true,
    shared_library_write: false,
    scope:
      'Moves the archived Book back to shelf/<slug>, restores its Book Catalog entry verbatim, and commits a fresh ' +
      'Discovery manifest. Every page is verified byte-identical afterwards. The Book is restored CLOSED; open it ' +
      'with tools/Set-VirtualDesk.ps1.',
  };
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('The Book was not restored: review the preflight and rerun with its exact --plan-id.');
  if (approved !== planId) {
    refuse(
      'The Book was not restored: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. ' +
        'A different plan_id means the archived Book or the catalog changed since you approved it.',
    );
  }

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  let moved = false;
  let catalogRendered = false;

  try {
    lock = enterBookLock(workspace, `shelf/${slug}`, LOCK_TIMEOUT_SECONDS);
    journalPath = writeBookJournal({
      workspace,
      bookRoot: `shelf/${slug}`,
      operation: `Restore shelf/${slug}`,
      paths: [],
      operationDigest: planId,
    }).journalPath;

    fs.renameSync(archivedRoot, activeRoot);
    moved = true;
    // The archive record travels with the directory and does not belong on the active Shelf. Its
    // bytes were read before the move, so the rollback can put it back -- deleting it without having
    // captured it would make the rollback lossy in exactly the way the journal exists to prevent,
    // and the journal cannot cover it because it MOVED rather than changed.
    const restoredRecord = path.join(activeRoot, ARCHIVE_RECORD_NAME);
    if (fs.existsSync(restoredRecord)) fs.rmSync(restoredRecord, { force: true });

    // RESTORED FROM THE RECORD, INTO THE BOOK'S OWN ENTRY FILE, inside the render lock: no offset
    // from the archive has to still be valid.
    invokeShelfCatalogRender({
      workspace,
      programRoot,
      writeEntry: [{ path: shelfCatalogEntryPath(workspace, slug), text: entryText }],
    });
    catalogRendered = true;

    // The window opens AFTER the move here, because the identity this manifest describes is the one
    // the Book is ARRIVING at rather than the one it is leaving.
    mutation = enterBookMutation({
      workspace,
      slug,
      bookRoot: `shelf/${slug}`,
      reason: `Restore shelf/${slug}`,
      lock,
    });
    // The ARCHIVED store is retired in the same breath: leaving it behind would leave Discovery
    // answering for an archived Book whose pages have moved back, offering a reader `-Shelf Archive`
    // on a Book that is no longer there.
    removeBookManifestStore(workspace, slug, 'shelf-archive');

    const problems: string[] = [];
    if (fs.existsSync(archivedRoot)) problems.push(`shelf/${ARCHIVE_FOLDER}/${slug} still exists after the move`);
    const liveWiki = path.join(activeRoot, 'wiki');
    if (!fs.existsSync(liveWiki)) problems.push('the restored Book has no wiki directory');
    else {
      const after = new Map(pageManifest(liveWiki).map((page) => [page.relative, page.sha256]));
      for (const page of restoreManifest) {
        if (!after.has(page.relative)) problems.push(`${page.relative} is missing after the move`);
        else if (after.get(page.relative) !== page.sha256) problems.push(`${page.relative} is not byte-identical after the move`);
      }
    }
    if (!findShelfCatalogEntry(readUtf8(shelfCatalogPath(workspace)), slug, 'the catalog lists this Book twice')) {
      problems.push(`shelf/_catalog.md does not list shelf/${slug} after the restore`);
    }
    if (problems.length) refuse(problems.join('; '));

    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;

    plan['status'] = 'restored';
    plan['book_path'] = `shelf/${slug}/wiki`;
    plan['pages_verified_identical'] = restoreManifest.length;
    plan['journal'] = workspaceRelative(workspace, journalPath);
    plan['next'] =
      `The Book is on the Shelf and closed. Open it with tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Slug ${slug}, then run tools/Invoke-LibraryChecks.ps1.`;
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback([
      () => {
        if (moved && fs.existsSync(activeRoot) && !fs.existsSync(archivedRoot)) {
          fs.renameSync(activeRoot, archivedRoot);
          writeUtf8(path.join(archivedRoot, ARCHIVE_RECORD_NAME), recordText);
        }
      },
      () => {
        if (journalPath) restoreBookJournal(journalPath);
      },
      () => {
        if (catalogRendered) invokeShelfCatalogRenderAfterRollback(workspace, programRoot);
      },
    ]);
    settleMutation(mutation, rollback);
    return { refusal: `The Book was not restored. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  return { refusal: null, value: plan };
}

// --- stub -------------------------------------------------------------------------------------------

/**
 * Replace one page of an OPEN, curated Shelf Book with a superseded-stub pointing at the canonical
 * copy elsewhere.
 *
 * WHY THIS IS NOT AN OVERWRITE MODE ON THE PAGE WRITER. That helper's whole justification for
 * applying with no plan_id is that it provably CANNOT lose text; a mode that overwrites makes the
 * justification conditional on a flag. And a generic overwrite is a bigger capability than any
 * recorded need: it can put arbitrary bytes over arbitrary bytes. This can only ever write a stub,
 * in the one shape the doc specifies, and the reader sees the whole replacement in the preflight.
 *
 * IDEMPOTENT BY CONTENT. A page that already holds exactly these bytes is reported `already-stubbed`
 * with no write, no journal and no manifest generation, so a retry after an interruption is safe.
 */
export function stubVerb(argv: string[], programRoot: string, workspace: string): WriterResult {
  void programRoot;
  const parsed = parseArguments(argv, ['canonical', 'reason', 'superseded-on', 'workspace', 'plan-id']);
  const bookSlug = parsed.positional[0] ?? '';
  const pagePath = parsed.positional[1] ?? '';
  const canonical = parsed.options.get('canonical') ?? '';
  // `<book>/<page>` split at the FIRST slash, because a canonical page may be nested and the Book
  // slug never is.
  const slash = canonical.indexOf('/');
  const canonicalBook = slash < 0 ? canonical : canonical.substring(0, slash);
  const canonicalPage = slash < 0 ? '' : canonical.substring(slash + 1);

  let supersededOn = (parsed.options.get('superseded-on') ?? '').trim();
  if (!supersededOn) supersededOn = today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(supersededOn)) refuse('SupersededOn must be an ISO date, yyyy-MM-dd.');

  const book = getShelfBook(workspace, bookSlug);
  if (book.isCapture) {
    refuse(
      `Shelf Book '${bookSlug}' is a capture Book. Its notes are triaged with tools/Invoke-LibraryTriage.ps1; the stub pattern is for curated Books.`,
    );
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${bookSlug}' has no pages directory at shelf/${bookSlug}/wiki.`);
  assertShelfBookOpen(workspace, bookSlug, 'replacing one of its pages with a stub');

  const page = convertToBookPagePath(pagePath);
  const canonicalPageClean = convertToBookPagePath(canonicalPage);
  if (!canonicalBook.trim()) refuse('CanonicalBook must name the Book the topic now lives in.');

  const relative = `${page}.md`;
  const fullPath = path.join(book.wikiPath, ...relative.split('/'));
  if (!fs.existsSync(fullPath)) {
    refuse(
      `shelf/${bookSlug}/wiki/${relative} does not exist. This helper only ever replaces an existing page; use tools/Add-ShelfBookPage.ps1 to create one.`,
    );
  }

  const currentBody = readUtf8(fullPath);
  // The page keeps its own name. A stub that renamed the topic would break the one thing the stub
  // exists to preserve -- a reader arriving from an old link recognising where they landed.
  const headingMatch = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(currentBody);
  const title = headingMatch ? headingMatch[1]!.trim() : page.split('/').pop()!;
  const titleSource = headingMatch ? "the page's own H1" : 'the page file name (it has no H1)';

  // Depth from the page's directory to the workspace root: shelf/<slug>/wiki is three, plus one for
  // every directory the page sits inside. Computed rather than assumed -- the surviving hand-written
  // stubs are all at one level of nesting, so a constant would be right by coincidence.
  const docsDepth = 3 + page.split('/').length - 1;
  const stubBody = newStubBody({
    title,
    date: supersededOn,
    canonicalBookTitle: canonicalBook,
    canonicalPagePath: canonicalPageClean,
    because: parsed.options.get('reason') ?? '',
    docsDepth,
  });

  // Idempotence by content, decided BEFORE a plan_id is issued: a retry that needs no write should
  // not ask for an approval it does not need.
  if (currentBody === stubBody) {
    return {
      refusal: null,
      value: {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: 'Stub a Shelf Book page',
        status: 'already-stubbed',
        book: book.bookRoot,
        page: `${book.bookRoot}/wiki/${relative}`,
        canonical_book: canonicalBook,
        canonical_page: canonicalPageClean,
        confirmation_required: false,
        shared_library_write: false,
        scope: 'This page already holds exactly this stub. Nothing was written, journaled, or regenerated.',
      },
    };
  }

  const alreadyStub = /^>\s+\*\*Superseded\s/m.test(currentBody);
  const digestSource = [
    `book=${book.bookRoot}`,
    `page=${relative}`,
    `current=${sha256OfText(currentBody)}`,
    `stub=${sha256OfText(stubBody)}`,
  ].join('\n');
  const planId = 'stub-shelf-book-page-' + sha256OfText(digestSource);

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Stub a Shelf Book page',
    book: book.bookRoot,
    book_title: book.title,
    page: `${book.bookRoot}/wiki/${relative}`,
    page_title: title,
    title_source: titleSource,
    canonical_book: canonicalBook,
    canonical_page: canonicalPageClean,
    superseded_on: supersededOn,
    replacing_characters: currentBody.length,
    with_characters: stubBody.length,
    page_is_already_a_stub: alreadyStub,
    replacement_text: stubBody,
    reader_map_action: 'no change (the page keeps its path, so every existing link still resolves)',
    plan_id: planId,
    confirmation_required: true,
    recoverable: true,
    shared_library_write: false,
    scope:
      'Replaces the ENTIRE body of this one page with the stub shown above, under the Book\u0027s lock, with the prior ' +
      'body journaled first and a rollback verified by readback. A new Discovery manifest generation is committed in ' +
      'the same window. No other page, the reader map, and the Book Catalog are not changed.',
    next:
      'Read the page first if you have not. Then rerun with -UserConfirmed and this exact -ApprovedPlanId. The prior ' +
      'body is recoverable from the journal until the next write to this Book.',
  };
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('The page was not stubbed: review the preflight and rerun with its exact --plan-id.');
  if (approved !== planId) {
    refuse(
      'The page was not stubbed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. ' +
        'A different plan_id means the page, or the stub that would replace it, changed since you approved it.',
    );
  }

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);

    // Re-read under the lock. The approval was bound to a hash taken before anyone was excluded, so
    // without this the window between preflight and write is exactly the check-then-write race the
    // plan_id is supposed to close.
    if (readUtf8(fullPath) !== currentBody) {
      refuse(
        `shelf/${bookSlug}/wiki/${relative} changed while the approval was being given. Nothing was written; rerun the preflight.`,
      );
    }

    mutation = enterBookMutation({
      workspace,
      slug: book.slug,
      bookRoot: book.bookRoot,
      reason: `Stub page ${relative}`,
      lock,
    });
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Stub page ${relative}`,
      paths: [fullPath],
    }).journalPath;

    writeUtf8(fullPath, stubBody);
    if (readUtf8(fullPath) !== stubBody) {
      refuse(`The stub was written but did not read back identically: ${book.bookRoot}/wiki/${relative}`);
    }

    // Closed last and cannot throw: the stub has landed, and a manifest problem must never unwind
    // into the rollback below and resurrect the body the reader approved replacing.
    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;

    plan['status'] = 'stubbed';
    plan['journal'] = workspaceRelative(workspace, journalPath);
    delete plan['replacement_text'];
    plan['next'] =
      'The Book is open; read the stub back with mcp__validated-book-reader__read_open_book_page. Record the ' +
      'resolution with tools/Set-TopicOverlap.ps1 if this page was part of a topic overlap.';
  } catch (error) {
    const failure = (error as Error).message;
    let rollback = 'not required';
    if (journalPath) {
      rollback = runRollback([() => restoreBookJournal(journalPath!)]);
    }
    settleMutation(mutation, rollback);
    return { refusal: `The page was not stubbed. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  return { refusal: null, value: plan };
}

/**
 * The stub body. DETERMINISTIC ON PURPOSE: the idempotence test compares an existing page against
 * exactly these bytes, so a body that varied with the clock or with line-wrapping luck would make
 * every retry look like a divergent change.
 */
function newStubBody(options: {
  title: string;
  date: string;
  canonicalBookTitle: string;
  canonicalPagePath: string;
  because: string;
  docsDepth: number;
}): string {
  const docsLink = '../'.repeat(options.docsDepth) + 'docs/duplicate-topic-resolution.md';
  const reasonClause = options.because.trim() ? ' -- ' + options.because.trim().replace(/\.+$/, '') : '';
  return [
    `# ${options.title}`,
    '',
    `> **Superseded ${options.date}.** This topic now lives in the **${options.canonicalBookTitle}** Book, page`,
    '> `' + options.canonicalPagePath + '`' + reasonClause + '. Kept here as a stub so nothing that links to this page',
    `> breaks. See [Duplicate Topic Resolution](${docsLink}).`,
    '',
  ].join('\n');
}

/**
 * A page path is a Book-relative LOCATION, never a filesystem path: no drive, no traversal, no
 * absolute form. Reserved names are checked first so they are refused for the accurate reason --
 * being told `_index is not lowercase` would be true and useless.
 */
function convertToBookPagePath(raw: string): string {
  let candidate = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!candidate) refuse('PagePath is required, for example rendering/shaders.');
  if (candidate.endsWith('.md')) candidate = candidate.substring(0, candidate.length - 3);
  const segments = candidate.split('/');
  if (['_book', '_index'].includes(segments[segments.length - 1]!)) {
    refuse('PagePath must not name the Book metadata page or the reader map.');
  }
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(segment)) {
      refuse(`PagePath segment '${segment}' must contain only lowercase letters, digits, and hyphens.`);
    }
  }
  return segments.join('/');
}

/**
 * The Desk gate. Everything that names or curates an individual page requires the reader to have
 * OPENED the Book.
 *
 * AN ARCHIVED SHELF BOOK IS READ-ONLY, said here rather than left to be inferred. The refusal held
 * by accident of string comparison -- `shelf/_archive/<slug>` never equals `shelf/<slug>` -- but it
 * told a reader the Book was "closed" when it was open and merely retired, sending them to re-open
 * something already open.
 */
function assertShelfBookOpen(workspace: string, slug: string, action: string): void {
  const desks = stateDirectory(workspace);
  const seat = requireSeat({ stateDirectory: desks });
  const openBooksPath = deskFilePath(desks, seat, 'books');
  if (!fs.existsSync(openBooksPath)) refuse('Virtual Desk configuration is missing .open-books.');
  const openBooks = deskEntriesForSeat(desks, seat, 'books');
  if (openBooks.includes(`shelf/${slug}`)) return;
  if (openBooks.includes(`shelf/${ARCHIVE_FOLDER}/${slug}`)) {
    refuse(
      `Shelf Book '${slug}' is archived and read-only. Restore it with tools/Archive-ShelfBook.ps1 -Action Restore -BookSlug ${slug} before ${action}.`,
    );
  }
  refuse(
    `Shelf Book '${slug}' is closed. Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug ${slug} before ${action}.`,
  );
}
