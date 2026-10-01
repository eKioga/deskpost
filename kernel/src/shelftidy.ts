/**
 * `library shelf tidy <slug>` and `--restore <page>`: closed notes move out of a capture Book's `notes/` (S77 row 1,
 * PLAN-holding-discipline.md row 5).
 *
 * WHAT MOVES. A `done` note whose `reviewed:` stamp is older than `--days` (14 by default, Q5) moves to
 * `wiki/reviewed/<yyyy-mm>/`, the month of its stamp. Every seat's notes are tidied: tidying moves and never closes or
 * reopens, so the seat rule, which is about closing, does not apply. A `done` note with no stamp (closed before the
 * stamp existed) is never tidied; the preview counts it and names the route, a `review` of it, which writes the stamp.
 *
 * STILL READABLE, NEVER DELETED (Q6). The move stays inside `wiki/`, so the validated reader serves it, and the reader
 * map links each month's `reviewed/<yyyy-mm>/_index`. `--restore` moves one note back to `notes/`, and refuses a name
 * that is already there rather than renaming it. A tidied note is not a triage source (`source_page` is `notes/...`),
 * so it is reopened or discarded only after `--restore`.
 *
 * A MOVE, SO A PLAN. Both preview with `--preflight` and run with `--user-confirmed --plan-id`. The id binds each note's
 * path, sha256 and destination, and is planned again under the Book lock, so a note edited, reopened or taken since the
 * preview invalidates it. The run is inside the Book mutation window, with every source journalled as present and
 * every destination as absent, and a failure rolls the journal back.
 *
 * NAMING NOTES IS READING (CONTEXT.md), so both need the Book open at this seat, as every capture-Book triage does.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { completeBookMutation, enterBookMutation, undoBookMutation, type BookMutation } from './mutation.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { getShelfBook, readUtf8, type ShelfBook } from './shelfbook.ts';
import { parseShelfNote, shelfNotes } from './shelfnote.ts';
import { reviewedMonths, updateShelfNoteIndex } from './capture.ts';
import { assertShelfBookOpen } from './triage.ts';

export const SHELF_TIDY_OPTIONS = ['workspace', 'plan-id', 'days', 'restore'];
export const DEFAULT_TIDY_DAYS = 14;
const MONTH = /^\d{4}-\d{2}$/;
const DAY_MS = 86_400_000;

class TidyRefusal extends Error {}

function refuse(message: string): never {
  throw new TidyRefusal(message);
}

interface MoveRow {
  /** The page as the reader names it, without `.md`: `notes/<stem>` or `reviewed/<yyyy-mm>/<stem>`. */
  page: string;
  file: string;
  sha256: string;
  destination: string;
  closedBy: string | null;
}

function captureBook(workspace: string, slug: string): ShelfBook {
  const book = getShelfBook(workspace, slug);
  if (!book.isCapture) refuse(`Shelf Book '${slug}' is not a capture Book ('- **Kind:** capture'), and only a capture Book's notes are tidied.`);
  return book;
}

function reviewedRoot(book: ShelfBook): string {
  return path.join(book.wikiPath, 'reviewed');
}

/** The month a stamp names, or null for a stamp that is not a readable UTC time. */
function stampTime(reviewed: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(reviewed)) return null;
  const time = Date.parse(reviewed);
  return Number.isFinite(time) ? time : null;
}

function planTidy(book: ShelfBook, days: number, now: number) {
  const moves: MoveRow[] = [];
  const conflicts: string[] = [];
  let unstamped = 0;
  let notYet = 0;
  for (const note of shelfNotes(book)) {
    if (note.review !== 'done') continue;
    const time = note.reviewed === null ? null : stampTime(note.reviewed);
    if (time === null) {
      unstamped += 1;
      continue;
    }
    if (now - time <= days * DAY_MS) {
      notYet += 1;
      continue;
    }
    const month = note.reviewed!.substring(0, 7);
    const destination = `reviewed/${month}/${note.file.replace(/\.md$/i, '')}`;
    if (fs.existsSync(path.join(book.wikiPath, ...destination.split('/')) + '.md')) {
      conflicts.push(note.page);
      continue;
    }
    moves.push({ page: note.page, file: note.file, sha256: sha256OfBytes(fs.readFileSync(note.fullPath)), destination, closedBy: note.filedTo ?? note.supersededBy });
  }
  const planId = sha256OfText(['tidy', book.slug, ...moves.map((row) => `${row.page}\t${row.sha256}\t${row.destination}`)].join('\n'));
  return { moves, conflicts, unstamped, notYet, planId };
}

function planRestore(book: ShelfBook, page: string) {
  const match = /^reviewed\/(\d{4}-\d{2})\/([^/\\]+)$/.exec(page.replace(/\.md$/i, ''));
  if (!match || !MONTH.test(match[1]!)) refuse(`--restore takes a tidied note's page, reviewed/<yyyy-mm>/<name>; '${page}' is not one.`);
  const stem = match[2]!;
  const source = path.join(reviewedRoot(book), match[1]!, `${stem}.md`);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) refuse(`Book '${book.slug}' has no tidied note ${match[0]}.`);
  const destination = `notes/${stem}`;
  if (fs.existsSync(path.join(book.notesPath, `${stem}.md`))) {
    refuse(`${destination} already exists in Book '${book.slug}', so ${match[0]} cannot be restored over it. Nothing was moved; rename or close the note in notes/ first.`);
  }
  const row: MoveRow = { page: match[0], file: `${stem}.md`, sha256: sha256OfBytes(fs.readFileSync(source)), destination, closedBy: null };
  return { row, month: match[1]!, planId: sha256OfText(['restore', book.slug, `${row.page}\t${row.sha256}\t${row.destination}`].join('\n')) };
}

function pageFile(book: ShelfBook, page: string): string {
  return path.join(book.wikiPath, ...page.split('/')) + '.md';
}

/** One month's own map, regenerated from the notes in it; removed with its folder when the month is empty. */
function updateMonthIndex(book: ShelfBook, month: string): void {
  const folder = path.join(reviewedRoot(book), month);
  const indexFile = path.join(folder, '_index.md');
  const names = fs.existsSync(folder)
    ? fs.readdirSync(folder, { withFileTypes: true }).filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md') && item.name !== '_index.md').map((item) => item.name).sort()
    : [];
  if (!names.length) {
    if (fs.existsSync(indexFile)) fs.rmSync(indexFile);
    if (fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
    if (fs.existsSync(reviewedRoot(book)) && !fs.readdirSync(reviewedRoot(book)).length) fs.rmdirSync(reviewedRoot(book));
    return;
  }
  const notes = names.map((name) => ({ ...parseShelfNote(name, path.join(folder, name), readUtf8(path.join(folder, name))), page: `reviewed/${month}/${name.replace(/\.md$/i, '')}` }));
  notes.sort((left, right) => (left.captured < right.captured ? 1 : left.captured > right.captured ? -1 : 0));
  const lines = [`# ${book.title} - Reviewed in ${month}`, '', '- [[_index|Reader Map]]', '', '## Tidied notes', ''];
  for (const note of notes) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}, reviewed ${note.reviewed ?? 'unknown'}`);
  fs.writeFileSync(indexFile, lines.join('\n') + '\n', { encoding: 'utf8' });
}

function runMoves(options: {
  workspace: string;
  book: ShelfBook;
  lock: BookLock;
  operation: string;
  rows: MoveRow[];
  months: string[];
}): string {
  const { workspace, book, lock, operation, rows, months } = options;
  let mutation: BookMutation | null = null;
  let journalPath: string | null = null;
  try {
    mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: operation, lock });
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation,
      paths: [
        ...rows.flatMap((row) => [pageFile(book, row.page), pageFile(book, row.destination)]),
        ...months.map((month) => path.join(reviewedRoot(book), month, '_index.md')),
        path.join(book.wikiPath, '_index.md'),
      ],
    }).journalPath;
    for (const row of rows) {
      const source = pageFile(book, row.page);
      const target = pageFile(book, row.destination);
      const bytes = fs.readFileSync(source);
      if (sha256OfBytes(bytes) !== row.sha256) refuse(`${row.page} changed while it was being moved.`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // `wx` is CreateNew: a name taken since the plan fails rather than overwrites.
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      if (sha256OfBytes(fs.readFileSync(target)) !== row.sha256) refuse(`${row.destination} did not read back byte for byte.`);
      fs.rmSync(source);
    }
    for (const month of months) updateMonthIndex(book, month);
    updateShelfNoteIndex(book);
    const manifest = completeBookMutation(mutation).summary;
    mutation = null;
    return manifest;
  } catch (error) {
    let rollback = 'not required';
    if (journalPath !== null) {
      try {
        restoreBookJournal(journalPath);
        rollback = 'complete and verified';
      } catch (restoreError) {
        rollback = `FAILED: ${(restoreError as Error).message}`;
      }
    }
    if (mutation !== null && !rollback.startsWith('FAILED')) undoBookMutation(mutation);
    refuse(`Nothing was moved. ${(error as Error).message} Rollback: ${rollback}.`);
  }
}

export function shelfTidyVerb(argv: string[], workspace: string, now: number = Date.now()): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, SHELF_TIDY_OPTIONS);
  const slug = (parsed.positional[0] ?? '').trim();
  const book = captureBook(workspace, slug);
  const restore = parsed.options.get('restore');
  const action = restore !== undefined ? 'restoring a tidied note' : 'tidying its notes';
  assertShelfBookOpen(workspace, slug, action);
  const daysText = (parsed.options.get('days') ?? String(DEFAULT_TIDY_DAYS)).trim();
  if (restore !== undefined && parsed.options.has('days')) refuse('--days chooses which notes tidy moves, so it means nothing with --restore.');
  if (!/^\d+$/.test(daysText)) refuse(`--days must be a whole number of days; '${daysText}' is not one.`);
  const days = Number(daysText);
  const planIdGiven = (parsed.options.get('plan-id') ?? '').trim();
  const confirmed = parsed.flags.has('user-confirmed') && planIdGiven !== '';
  const base = { schema: 1, book: `shelf/${slug}`, shared_library_write: false } as const;

  if (restore !== undefined) {
    const plan = planRestore(book, restore.trim());
    const preview: Record<string, PsJsonValue> = {
      ...base,
      operation: 'Restore a tidied Shelf note',
      plan_id: plan.planId,
      restore: plan.row.page,
      to: plan.row.destination,
      scope: 'Moves one tidied note back to notes/, byte for byte, and regenerates the reader map and its month map. No note is closed, reopened or deleted.',
    };
    if (parsed.flags.has('preflight')) return { ...preview, confirmation_required: true };
    if (!confirmed) refuse("Nothing was moved: review the preview with --preflight, then run it with --user-confirmed --plan-id <the preview's plan_id>.");
    if (planIdGiven !== plan.planId) refuse(`The restore plan changed since its preview (it is now ${plan.planId}). Nothing was moved. Preview it again.`);
    let lock: BookLock | null = null;
    try {
      lock = enterBookLock(workspace, book.bookRoot, 20);
      const held = planRestore(book, restore.trim());
      if (held.planId !== planIdGiven) refuse(`The restore plan changed while its lock was being taken (it is now ${held.planId}). Nothing was moved. Preview it again.`);
      const manifest = runMoves({ workspace, book, lock, operation: `Restore ${held.row.page} in ${slug}`, rows: [held.row], months: [held.month] });
      return { ...preview, status: 'restored', reader_map: `${book.bookRoot}/wiki/_index.md`, manifest };
    } finally {
      exitBookLock(lock);
    }
  }

  const plan = planTidy(book, days, now);
  const routeForUnstamped =
    'A done note with no reviewed: stamp is never tidied. A triage review of it writes the stamp; for a note another seat wrote in a writer Book, that needs "other_seat" and so the reader\'s ask.';
  const preview: Record<string, PsJsonValue> = {
    ...base,
    operation: 'Tidy a capture Book',
    plan_id: plan.planId,
    days,
    rule: `done notes whose reviewed: stamp is more than ${days} day(s) old move to wiki/reviewed/<yyyy-mm>/, the month of the stamp; every seat's notes, since tidying closes and reopens nothing`,
    counts: { move: plan.moves.length, conflicts: plan.conflicts.length, done_not_yet_due: plan.notYet, done_unstamped: plan.unstamped },
    move: plan.moves.map((row) => ({ page: row.page, to: row.destination, closed_by: row.closedBy })) as PsJsonValue,
    conflicts: plan.conflicts,
    ...(plan.unstamped ? { unstamped_route: routeForUnstamped } : {}),
    restore: `deskpost shelf tidy ${slug} --restore reviewed/<yyyy-mm>/<name> moves one back.`,
  };
  if (parsed.flags.has('preflight')) return { ...preview, confirmation_required: true };
  if (!confirmed) refuse("Nothing was moved: review the preview with --preflight, then run it with --user-confirmed --plan-id <the preview's plan_id>.");
  if (planIdGiven !== plan.planId) refuse(`The tidy plan changed since its preview (it is now ${plan.planId}). Nothing was moved. Preview it again.`);
  let lock: BookLock | null = null;
  try {
    lock = enterBookLock(workspace, book.bookRoot, 20);
    // RE-PLANNED UNDER THE LOCK: a note edited, reopened or captured since the preview changes the id.
    const held = planTidy(book, days, now);
    if (held.planId !== planIdGiven) refuse(`The tidy plan changed while its lock was being taken (it is now ${held.planId}). Nothing was moved. Preview it again.`);
    if (!held.moves.length) return { ...preview, status: 'nothing to tidy', manifest: 'unchanged' };
    const months = [...new Set([...held.moves.map((row) => row.destination.split('/')[1]!), ...reviewedMonths(book)])].sort();
    const manifest = runMoves({ workspace, book, lock, operation: `Tidy ${held.moves.length} note(s) in ${slug}`, rows: held.moves, months });
    return { ...preview, status: 'tidied', reader_map: `${book.bookRoot}/wiki/_index.md`, manifest };
  } finally {
    exitBookLock(lock);
  }
}
