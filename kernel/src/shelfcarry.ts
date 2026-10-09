/**
 * `library shelf carry <old-workspace> --book <capture-book>`: a capture Book's notes carried from another
 * workspace's Shelf into this Library's (PLAN-basic-memory.md step 4b).
 *
 * CARRY, NOT IMPORT. The glossary's Import brings an external document set into the collection as a Book; this moves
 * notes between two Shelves, which is why it has its own word (round 2).
 *
 * BYTE FOR BYTE, AND THE OLD WORKSPACE IS ONLY READ. Each note keeps its file name, its `captured:` and its `review:`
 * state. A note already here byte-identical is skipped; a same-name note with other content is a named conflict and
 * is left alone on both sides. Only capture Books are accepted, at both ends.
 *
 * `--book reports` CARRIES PENDING NOTES ONLY (round 2). `review:` has no "still true" state, so the old workspace's
 * triage marks each settled Report `done`, and what is still pending is what carries. Every other capture Book
 * carries whole: Eric's Holding Shelf is 21 pending notes and 3 done.
 *
 * INSIDE CAPTURE'S OWN MUTATION WINDOW (`capture.ts`): the Book lock, the manifest mutation, a journal of every path
 * written, the `wx` creates, the reader map regenerated, then the manifest committed. Without the window the Holding
 * Shelf's manifest would read `dirty` for ever. A failure rolls the journal back.
 *
 * PROVENANCE IS KEPT AND SAID. A carried note keeps `from_seat` and `session_id` from where it was written, which
 * nothing here resolves; the preview says so. Harmless, but visible.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { completeBookMutation, enterBookMutation, undoBookMutation, type BookMutation } from './mutation.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { getShelfBook, type ShelfBook } from './shelfbook.ts';
import { parseShelfNote } from './shelfnote.ts';
import { updateShelfNoteIndex } from './capture.ts';
import { findWorkspaceByMarker } from './workspace.ts';

class CarryRefusal extends Error {}

function refuse(message: string): never {
  throw new CarryRefusal(message);
}

type CarryAction = 'carry' | 'already-here' | 'conflict' | 'not-pending';

interface CarryRow {
  name: string;
  sha256: string;
  review: string;
  action: CarryAction;
}

function reviewOf(bytes: Buffer): string {
  return parseShelfNote('', '', bytes.toString('utf8')).review;
}

function captureBook(workspace: string, slug: string, which: string): ShelfBook {
  let book: ShelfBook;
  try {
    book = getShelfBook(workspace, slug);
  } catch (error) {
    refuse(`${which} has no capture Book '${slug}': ${(error as Error).message}`);
  }
  if (!book.isCapture) refuse(`${which}'s Shelf Book '${slug}' is not a capture Book ('- **Kind:** capture'), and only capture Books are carried.`);
  return book;
}

function planCarry(workspace: string, old: string, slug: string) {
  const source = captureBook(old, slug, `The old workspace ${old}`);
  const destination = captureBook(workspace, slug, 'This Library');
  const pendingOnly = slug === 'reports';
  const rows: CarryRow[] = [];
  const names = fs.existsSync(source.notesPath)
    ? fs.readdirSync(source.notesPath, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md')).map((entry) => entry.name).sort()
    : [];
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(source.notesPath, name));
    const sha256 = sha256OfBytes(bytes);
    const review = reviewOf(bytes);
    const here = path.join(destination.notesPath, name);
    let action: CarryAction;
    if (pendingOnly && review !== 'pending') action = 'not-pending';
    else if (!fs.existsSync(here)) action = 'carry';
    else action = sha256OfBytes(fs.readFileSync(here)) === sha256 ? 'already-here' : 'conflict';
    rows.push({ name, sha256, review, action });
  }
  const planId = sha256OfText(rows.map((row) => `${row.name}\t${row.sha256}\t${row.action}`).join('\n'));
  return { source, destination, pendingOnly, rows, planId };
}

function describe(workspace: string, old: string, slug: string, plan: ReturnType<typeof planCarry>): Record<string, PsJsonValue> {
  const by = (action: CarryAction) => plan.rows.filter((row) => row.action === action);
  const carrying = by('carry');
  const pending = carrying.filter((row) => row.review !== 'done').length;
  return {
    schema: 1,
    operation: 'Carry Shelf notes',
    book: `shelf/${slug}`,
    from: path.join(old, 'shelf', slug, 'wiki', 'notes'),
    into: path.join(workspace, 'shelf', slug, 'wiki', 'notes'),
    plan_id: plan.planId,
    rule: plan.pendingOnly ? 'review: pending notes only; the old triage marked each settled Report done' : 'every note, pending and done',
    counts: {
      carry: carrying.length,
      carry_pending: pending,
      carry_done: carrying.length - pending,
      already_here: by('already-here').length,
      conflicts: by('conflict').length,
      not_pending: by('not-pending').length,
    },
    carry: carrying.map((row) => row.name),
    conflicts: by('conflict').map((row) => row.name),
    already_here: by('already-here').map((row) => row.name),
    provenance:
      "Carried notes keep their old provenance -- from_seat and session_id name the seat and conversation that wrote them in the old workspace, which nothing in this Library resolves. Harmless, and visible.",
    old_workspace_write: false,
    shared_library_write: false,
  };
}

export function shelfCarryVerb(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('shelf', 'carry'));
  const given = (parsed.positional[0] ?? '').trim();
  if (!given) refuse('library shelf carry needs the old workspace: library shelf carry <old-workspace> --book <capture-book>.');
  const old = path.resolve(given);
  if (!fs.existsSync(old) || !fs.statSync(old).isDirectory()) refuse(`The old workspace ${old} is not a folder.`);
  const oldRoot = findWorkspaceByMarker(old) ?? old;
  if (path.resolve(oldRoot).toLowerCase() === path.resolve(workspace).toLowerCase()) refuse('The old workspace is this Library; there is nothing to carry.');
  const slug = (parsed.options.get('book') ?? '').trim();
  if (!slug) refuse('library shelf carry needs --book <capture-book>: holding, or reports.');

  const plan = planCarry(workspace, old, slug);
  const preview = describe(workspace, old, slug, plan);
  if (parsed.flags.has('preflight')) return { ...preview, confirmation_required: true };
  const planId = (parsed.options.get('plan-id') ?? '').trim();
  if (!parsed.flags.has('user-confirmed') || !planId) refuse("Nothing was carried: review the preview with --preflight, then run it with --user-confirmed --plan-id <the preview's plan_id>.");
  if (planId !== plan.planId) refuse(`The carry plan changed since its preview (it is now ${plan.planId}). Nothing was carried. Preview it again.`);

  const book = plan.destination;
  let lock: BookLock | null = null;
  let mutation: BookMutation | null = null;
  let journalPath: string | null = null;
  const written: string[] = [];
  try {
    lock = enterBookLock(workspace, book.bookRoot, 20);
    // RE-PLANNED UNDER THE LOCK: a capture since the preview may have taken a name.
    const held = planCarry(workspace, old, slug);
    if (held.planId !== planId) refuse(`The carry plan changed while its lock was being taken (it is now ${held.planId}). Nothing was carried. Preview it again.`);
    const carrying = held.rows.filter((row) => row.action === 'carry');
    if (carrying.length === 0) return { ...preview, status: 'nothing to carry', carried: [], manifest: 'unchanged' };
    fs.mkdirSync(book.notesPath, { recursive: true });
    mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Carry ${carrying.length} note(s) from ${old}`, lock });
    const mapPath = path.join(book.wikiPath, '_index.md');
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Carry ${carrying.length} note(s) from ${old}`,
      paths: [...carrying.map((row) => path.join(book.notesPath, row.name)), mapPath],
    }).journalPath;
    for (const row of carrying) {
      const bytes = fs.readFileSync(path.join(held.source.notesPath, row.name));
      if (sha256OfBytes(bytes) !== row.sha256) refuse(`${row.name} changed in the old workspace while it was being carried.`);
      const target = path.join(book.notesPath, row.name);
      // `wx` is CreateNew, as capture writes a note: a name taken since the plan fails rather than overwrites.
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      written.push(row.name);
      if (sha256OfBytes(fs.readFileSync(target)) !== row.sha256) refuse(`${row.name} did not read back byte for byte.`);
    }
    const pendingCount = updateShelfNoteIndex(book).pendingCount;
    const manifest = completeBookMutation(mutation).summary;
    mutation = null;
    return { ...preview, status: 'carried', carried: written, pending_count: pendingCount, reader_map: `${book.bookRoot}/wiki/_index.md`, manifest };
  } catch (error) {
    if (error instanceof CarryRefusal && written.length === 0 && journalPath === null) throw error;
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
    refuse(`Nothing was carried. ${(error as Error).message} Rollback: ${rollback}.`);
  } finally {
    exitBookLock(lock);
  }
}
