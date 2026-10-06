/**
 * The three additive Book writers: capture a note, add a page, graduate a topic.
 *
 * ONE PIECE OF MACHINERY AGAIN, WHICH IS WHY THEY ARE ONE FILE. Each of them is create-only -- it
 * can bring a page into existence and can never change or remove one -- so none of them costs a
 * `plan_id`. What replaces the approval is different for each, and the difference is the whole
 * design:
 *
 *   CAPTURE IS UNGATED AND NEEDS NO OPEN BOOK. A note that costs a confirmation stops being
 *   written down, and nothing here can lose existing material. The Book's CATALOG ENTRY is the
 *   protection instead: only a Book carrying `- **Kind:** capture` accepts notes, so unvetted
 *   material can never land in a curated one.
 *
 *   ADDING A PAGE TO A CURATED BOOK REQUIRES THE DESK (ADR-0001). Choosing where a page belongs in
 *   a curated Book is a curatorial act, and having opened the Book is the evidence that somebody
 *   made that choice.
 *
 *   GRADUATING A TOPIC IS THE SAME ACT, REPEATED AND RESUMABLE. Its preflight binds the whole set
 *   into one digest, so a source edited between attempts invalidates the earlier journal rather
 *   than resuming against material that has since moved.
 *
 * EVERY PAGE GOES THROUGH THE SAME WINDOW AS THE DESTRUCTIVE WRITERS: the Book's lock, prior state
 * journaled before the first write -- the new page's prior ABSENCE, so a rollback deletes it rather
 * than leaving it behind -- a readback that proves what landed, and the Discovery manifest
 * generation committed LAST, where it cannot throw a landed page away.
 *
 * A captured note records the seat that wrote it and the conversation it came out of, read the way
 * `Add-ShelfNote.ps1` reads it: the newer of the seat's binding and its advisory activity record.
 * Until S14's second half this was a hardcoded empty string, because a workspace carrying a committed
 * binding was refused at this kernel's seat resolver -- and that also dropped the conversation a
 * LAUNCHER records in activity.json at a seat named by LIBRARY_SEAT, which never needed a binding.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { inlineCutWarning } from './inlinecut.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import {
  completeBookMutation,
  enterBookMutation,
  undoBookMutation,
  type BookMutation,
} from './mutation.ts';
import { sha256OfText } from './sha.ts';
import { writeAtomicText } from './fsx.ts';
import { getShelfBook, listFilesRecursive, readUtf8, type ShelfBook } from './shelfbook.ts';
import { assertSeatMayClose, setNoteField, shelfNotes, whyRefusal, type ShelfNoteRow } from './shelfnote.ts';

/** Said by a capture that records no why (S73 row 3), word for word as Add-ShelfNote.ps1 says it. */
const WHY_MISSING_NEXT =
  " This note records no why. Before the Holding Shelf, try the seat's own Hub (hub edit --mode new-page), a Book, " +
  'or the Notebook, and record a why category when none of them fits.';
import { deskEntriesForSeat, deskFilePath, resolveSeatName, seatDirectoryNames } from './seatdesk.ts';
import { launcherHoldsSeatForThisAgent } from './seatclaim.ts';
import { seatConversationRecord } from './desk.ts';
import { notebookScope } from './notebooklayout.ts';
import { assertInsideRoot, convertToBookPagePath, renderPageBody, type RenderedPage } from './pagepath.ts';
import { collectionBookSlugs } from './collectionbooks.ts';
import { isLocalBackend } from './basicmemory.ts';
import { localDate } from './localdate.ts';

/** The schema version `Write-LibraryResult -Json` stamps on every helper document. */
const LIBRARY_OUTPUT_SCHEMA = 1;
const LOCK_TIMEOUT_SECONDS = 20;
const ARCHIVE_FOLDER = '_archive';

export interface WriterResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function stateDirectory(workspace: string): string {
  return path.join(workspace, '.claude');
}

function workspaceRelative(workspace: string, file: string): string {
  return file.substring(workspace.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function writeUtf8(file: string, text: string): void {
  fs.writeFileSync(file, text, { encoding: 'utf8' });
}

/** `yyyy-MM-ddTHH:mm:ssZ`, which is what `[DateTimeOffset]::UtcNow.ToString(...)` writes. */
function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `yyyy-MM-dd` on this machine's own calendar: the note file name's stamp, as a reader would say the day
 * (S50, the reader's ruling). `captured:` stays the UTC instant; only the name is local.
 */
// --- shared page grammar ---------------------------------------------------------------------------

// The page grammar and the body rule live in pagepath.ts, which every page writer imports (S67).

/**
 * The exact bytes a Shelf Book page write will store, and the title it will carry. Shared with the
 * topic writer rather than reimplemented, because that writer's idempotence test -- "this page is
 * already here and identical, so that entry is done" -- is only true if it compares against what a
 * single-page write would actually produce.
 */
function convertToShelfPageBody(body: string, title: string): RenderedPage {
  return renderPageBody(body, title);
}

function convertToNoteSlug(title: string): string {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.substring(0, 60).replace(/^-+|-+$/g, '');
  if (!slug.trim()) refuse('Title must contain at least one letter or digit.');
  return slug;
}

/**
 * The Desk gate. An ARCHIVED Book is read-only rather than closed, and saying so is the difference
 * between sending the reader to `Restore` and sending them to re-open something already open.
 */
function assertShelfBookOpen(workspace: string, slug: string, action: string, resolvedSeat?: string): void {
  const desks = stateDirectory(workspace);
  let seat: string;
  if (resolvedSeat) {
    seat = resolvedSeat;
  } else {
    const resolved = resolveSeatName({ stateDirectory: desks });
    if (resolved.status !== 'named') refuse(resolved.message);
    seat = resolved.seat!;
  }
  if (!fs.existsSync(deskFilePath(desks, seat, 'books'))) refuse('Virtual Desk configuration is missing .open-books.');
  const openBooks = deskEntriesForSeat(desks, seat, 'books');
  if (openBooks.includes(`shelf/${slug}`)) return;
  if (openBooks.includes(`shelf/${ARCHIVE_FOLDER}/${slug}`)) {
    refuse(
      `Shelf Book '${slug}' is archived and read-only. Restore it with deskpost shelf restore ${slug} before ${action}.`,
    );
  }
  refuse(
    `Shelf Book '${slug}' is closed. Open it with deskpost desk open book ${slug} --location shelf before ${action}.`,
  );
}

// --- reader maps -----------------------------------------------------------------------------------

/**
 * Whether this map is one nothing but a generator wrote. A map a reader has CURATED carries
 * sections and annotations, and regenerating it would destroy real work -- so a curated map is
 * appended to and the drift is reported instead of enforced.
 */
function testGeneratedReaderMap(file: string): boolean {
  if (!fs.existsSync(file)) return true;
  for (const line of readUtf8(file).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#\s/.test(trimmed)) continue;
    if (/^-\s+\[\[[^\]]+\]\]\s*$/.test(trimmed)) continue;
    return false;
  }
  return true;
}

function bookPageRelatives(wikiPath: string): string[] {
  return listFilesRecursive(wikiPath)
    .filter((file) => file.toLowerCase().endsWith('.md'))
    .map((file) => file.substring(wikiPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
    .filter((relative) => !['_book.md', '_index.md'].includes(relative));
}

/**
 * Every page on disk that no reader-map link reaches, with ONE HOP through any topic index the root
 * map names: a Book may reach its pages hierarchically, and a flat check would report a deliberate
 * structure as drift.
 */
function getUnlistedBookPages(book: ShelfBook): string[] {
  const mapPath = path.join(book.wikiPath, '_index.md');
  if (!fs.existsSync(mapPath)) return [];
  const text = readUtf8(mapPath);
  const reachable = [text];
  const seen = new Set<string>();
  for (const hit of text.matchAll(/\[\[([^\]|]+)/g)) {
    const target = hit[1]!.trim();
    if (!/(?:^|\/)_index$/.test(target) || seen.has(target)) continue;
    seen.add(target);
    const indexPath = path.join(book.wikiPath, ...(target + '.md').split('/'));
    if (fs.existsSync(indexPath)) reachable.push(readUtf8(indexPath));
  }
  const all = reachable.join('\n');
  return bookPageRelatives(book.wikiPath).filter(
    (relative) => !all.includes(`[[${relative.substring(0, relative.length - 3)}`),
  );
}

/** What a reader map calls a page: its first H1, which is exactly what the manifest stores. */
function readerMapLabel(content: string, relative: string): string {
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  if (heading && /[a-zA-Z0-9]/.test(heading[1]!)) return heading[1]!.trim();
  return relative.substring(0, relative.length - 3);
}

/** Regenerated from the pages on disk, so a generated map can never drift from what the Book holds. */
export function updateShelfBookIndex(book: ShelfBook): { pageCount: number } {
  const relatives = bookPageRelatives(book.wikiPath);
  const links = ['- [[_book|Book metadata and limits]]'].concat(
    relatives.map((relative) => {
      const label = readerMapLabel(readUtf8(path.join(book.wikiPath, ...relative.split('/'))), relative);
      return `- [[${relative.substring(0, relative.length - 3)}|${label}]]`;
    }),
  );
  writeUtf8(path.join(book.wikiPath, '_index.md'), `# ${book.title} - Reader Map\n\n` + links.join('\n') + '\n');
  return { pageCount: relatives.length };
}

/**
 * One link added to a CURATED map without touching a character of what is already there. The target
 * is the identity, not the rendered line: every map written before labels became titles carries
 * `- [[<page>|<page>.md]]`, and comparing whole lines would append a second link to a page already
 * listed.
 */
function addShelfBookIndexLink(book: ShelfBook, page: string, label: string): void {
  const mapPath = path.join(book.wikiPath, '_index.md');
  const pageTitle = label.trim() ? label.trim() : page;
  const link = `- [[${page}|${pageTitle}]]`;
  if (!fs.existsSync(mapPath)) {
    writeUtf8(mapPath, `# ${book.title} - Reader Map\n\n` + link + '\n');
    return;
  }
  const text = readUtf8(mapPath);
  if (text.includes(`[[${page}|`) || text.includes(`[[${page}]]`)) return;
  const lineEnding = text.endsWith('\r\n') ? '\r\n' : '\n';
  const content = text.replace(/(?:\r?\n[ \t]*)+$/, '');
  const lastLine = /[^\r\n]*$/.exec(content)![0];
  const separator = !content ? lineEnding : /^[ \t]*-/.test(lastLine) ? lineEnding : lineEnding + lineEnding;
  writeUtf8(mapPath, content + separator + link + lineEnding);
}

/** The note `--supersedes` names, which must exist and which the seat rule must let this seat close (row 4). */
function supersededNote(book: ShelfBook, page: string, seat: string): ShelfNoteRow {
  const note = shelfNotes(book).find((row) => row.page === page);
  if (!note) refuse(`--supersedes names ${page}, and Book '${book.slug}' has no such note. Nothing was captured.`);
  assertSeatMayClose(note, { slug: book.slug, closedBy: book.closedBy ?? 'any' }, seat, null, refuse);
  return note;
}

/** The `wiki/reviewed/<yyyy-mm>` folders that hold a month map, oldest first. */
export function reviewedMonths(book: ShelfBook): string[] {
  const root = path.join(book.wikiPath, 'reviewed');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^\d{4}-\d{2}$/.test(item.name) && fs.existsSync(path.join(root, item.name, '_index.md')))
    .map((item) => item.name)
    .sort();
}

/** A capture Book's map is REGENERATED from the notes on disk, so it can never drift. */
export function updateShelfNoteIndex(book: ShelfBook): { pendingCount: number } {
  const notes = shelfNotes(book);
  const byCapturedDescending = (left: ShelfNoteRow, right: ShelfNoteRow): number =>
    left.captured < right.captured ? 1 : left.captured > right.captured ? -1 : 0;
  const pending = notes.filter((note) => note.review !== 'done').sort(byCapturedDescending);
  const reviewed = notes.filter((note) => note.review === 'done').sort(byCapturedDescending);
  const lines = [`# ${book.title} - Reader Map`, '', '- [[_book|Book metadata and limits]]', '', '## Pending review', ''];
  if (!pending.length) lines.push('- Nothing is waiting for review.');
  else if (!book.takesLetters) for (const note of pending) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
  else {
    // A BOOK THAT TAKES LETTERS GROUPS THEM BY RECIPIENT (S77 row 3, ADR-0062), seats in name order and then any note
    // addressed to no seat, so a recipient finds its own at once. `Update-ShelfNoteIndex` writes the same lines.
    const recipients = [...new Set(pending.map((note) => note.forSeat ?? ''))].sort((left, right) => (left === '' ? 1 : right === '' ? -1 : left < right ? -1 : left > right ? 1 : 0));
    recipients.forEach((recipient, index) => {
      if (index) lines.push('');
      lines.push(recipient ? `### For ${recipient}` : '### For no seat', '');
      for (const note of pending.filter((row) => (row.forSeat ?? '') === recipient)) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
    });
  }
  lines.push('', '## Reviewed', '');
  if (reviewed.length) for (const note of reviewed) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
  else lines.push('- No note has been reviewed yet.');
  // THE MONTHS `shelf tidy` MOVED CLOSED NOTES INTO (S77 row 1), newest first, and only when there is one, so a Book
  // never tidied keeps its map byte for byte. `Update-ShelfNoteIndex` writes the same lines.
  const months = reviewedMonths(book).reverse();
  if (months.length) {
    lines.push('', '## Tidied', '');
    for (const month of months) lines.push(`- [[reviewed/${month}/_index|Notes reviewed in ${month}]]`);
  }
  writeUtf8(path.join(book.wikiPath, '_index.md'), lines.join('\n') + '\n');
  return { pendingCount: pending.length };
}

// --- the body a writer was given -------------------------------------------------------------------

function resolveBody(workspace: string, contentPath: string | undefined, inline: string | undefined, what: string): {
  body: string;
  source: string;
} {
  const hasPath = contentPath !== undefined && contentPath.trim() !== '';
  const hasInline = inline !== undefined && inline.trim() !== '';
  if (hasPath && hasInline) refuse('Give either --content-path or --body, not both.');
  if (!hasPath && !hasInline) {
    refuse(`A ${what} needs a body: pass --content-path <file> (preferred for prose) or --body <text>.`);
  }
  if (!hasPath) return { body: inline!, source: '(inline)' };
  // A body is often a scratch file outside the workspace, so an absolute path is taken as given and
  // only a relative one is resolved against the workspace.
  const candidate = path.isAbsolute(contentPath!) ? contentPath! : path.join(workspace, contentPath!);
  const full = path.resolve(candidate);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--content-path ${contentPath} was not found (resolved to ${full}).`);
  return { body: readUtf8(full), source: contentPath! };
}

/** A `--body` the Windows shim may have cut short (S66, the S64 Report): `inlinecut.ts` says how it is seen. */
function inlineBodyWarning(argv: string[], source: string, body: string): string | null {
  if (source !== '(inline)') return null;
  return inlineCutWarning(argv, 'body', body, 'pass it with --content-path <file>.');
}

function settle(mutation: BookMutation | null, rollback: string): void {
  // Cleared only when the Book is provably back to the state the committed manifest describes.
  // After a rollback that FAILED the Book's state is unknown, and dirty is the only honest answer.
  if (mutation !== null && !rollback.startsWith('FAILED')) undoBookMutation(mutation);
}

function runRollback(journalPath: string | null, extra?: () => void): string {
  if (journalPath === null) return 'not required';
  try {
    restoreBookJournal(journalPath);
    if (extra) extra();
    return 'complete and verified';
  } catch (error) {
    return `FAILED: ${(error as Error).message}`;
  }
}

// --- capture ---------------------------------------------------------------------------------------

/**
 * `library capture <book> --title <t> --body <b>` -- `tools/Add-ShelfNote.ps1`.
 *
 * UNGATED BY DESIGN AND THEREFORE NOT ALLOWED TO BE FRAGILE. The manifest generation is committed
 * last and its failure is reported rather than thrown: a note that landed stays landed even when
 * its manifest cannot be written, which leaves the Book reading dirty and Discovery refusing to
 * describe it -- a rebuild rather than a lost note.
 */
export function captureVerb(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, [
    'title',
    'body',
    'content-path',
    'tags',
    'source-paths',
    'source-project',
    'require-note-file',
    'capture-date',
    'workspace',
    // KEPT VALUED SO IT CAN BE REFUSED (S77 row 3, the capture --seat Report): unlisted, `--seat x` would parse as a
    // flag and a stray positional, and `x` would become the Book slug (argv.ts).
    'seat',
    'why',
    'supersedes',
    'for',
  ]);
  try {
    // THE AUTHOR IS RESOLVED, NEVER TYPED (ADR-0062): a seat a caller could type would let any shell file under
    // another seat's name. Refused for every Book, before anything is read.
    if (parsed.options.has('seat') || parsed.flags.has('seat')) {
      refuse("library capture does not take --seat: the writing seat is resolved from this session's binding or launcher, never typed, so no shell can file under another seat's name. Nothing was captured.");
    }
    const slug = parsed.positional[0] ?? 'holding';
    const title = (parsed.options.get('title') ?? '').trim();
    // --title IS NEEDED ONLY WHEN THE BODY HAS NO H1 (S67, game-admin's Report): the H1 names the note either way.

    const book = getShelfBook(workspace, slug);
    if (!book.isCapture) {
      refuse(
        `Shelf Book '${slug}' is not capture-enabled. Only a Book whose catalog entry carries '- **Kind:** capture' accepts notes.`,
      );
    }
    if (!fs.existsSync(book.wikiPath)) refuse(`Capture Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);

    const { body, source } = resolveBody(workspace, parsed.options.get('content-path'), parsed.options.get('body'), 'note');
    if (!body.trim()) refuse('The note body is empty; nothing was captured.');
    const bodyWarning = inlineBodyWarning(argv, source, body);

    // THE DATE THAT NAMES THE NOTE, when a caller planned it (S44): a triage batch binds the note's file name
    // into its approval and asserts this writer's own plan against it, so naming it by today made every
    // holding action in a batch planned for another date refuse. It names the file and nothing else.
    const captureDate = (parsed.options.get('capture-date') ?? '').trim();
    if (captureDate) {
      const [year, month, day] = captureDate.split('-').map(Number);
      const probe = new Date(Date.UTC(year!, month! - 1, day!));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(captureDate) || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day) {
        refuse(`CaptureDate must be a calendar date written yyyy-MM-dd; '${captureDate}' is not one.`);
      }
    }

    // WHY THE NOTE IS HERE (S73 row 3): one closed category, recorded and never required. A capture without one still
    // lands; its result says so and names the homes to try first. A malformed one is refused, since that is the
    // option's grammar rather than a gate on saving.
    let why = (parsed.options.get('why') ?? '').trim();
    if (parsed.options.has('why')) {
      const malformed = whyRefusal(why);
      if (malformed !== null) refuse(malformed);
    }

    // A LETTER (S77 row 3, ADR-0062): `--for <seat>` addresses the note, writing `for_seat:`, and implies
    // `why: for-seat` unless an explicit --why says otherwise. Only a Book whose entry says `Letters: yes` takes it.
    const forSeat = (parsed.options.get('for') ?? '').trim();
    if (parsed.options.has('for') || parsed.flags.has('for')) {
      if (!book.takesLetters) {
        refuse(
          `Shelf Book '${slug}' does not take letters (its catalog entry has no '- **Letters:** yes'), so it refuses --for. ` +
            `A note for another seat is a letter: library capture letters --for <seat> --title <t> --content-path <file>. Nothing was captured.`,
        );
      }
      if (!forSeat) refuse('--for names the seat a letter is for: --for <seat>. Nothing was captured.');
      const seats = seatDirectoryNames(stateDirectory(workspace));
      if (!seats.includes(forSeat)) {
        refuse(`--for '${forSeat}' names no seat in this Library. Seats: ${seats.length ? seats.join(', ') : '(none)'}. Nothing was captured.`);
      }
      if (!why) why = 'for-seat';
    }

    // WHY_MISSING ONLY WHERE IT HELPS (S77 row 4, S73 parked item 2, kickoffs/s77 ruling 3): the "try a better home
    // first" advice is for a Book whose notes their writer closes. The Report Inbox (`Closed by: any`) is the right
    // home for what lands there, so it stays quiet. A Book with no line keeps saying it, as before the rule.
    const whyMissingSaid = book.closedByDeclared !== 'any';

    const capturedAt = utcStamp();

    // WHICH SEAT WROTE THIS, RESOLVED AND NEVER ACCEPTED -- and it never blocks a capture. A
    // seatless capture records no seat rather than the string 'unknown': empty is the real
    // pre-identity value, and a placeholder would be a claim nobody made.
    const seatState = resolveSeatName({ stateDirectory: stateDirectory(workspace) });
    const fromSeat = seatState.status === 'named' ? seatState.seat! : '';
    const seatSource = fromSeat ? seatState.source! : seatState.status;
    // HOW THE AUTHOR WAS RESOLVED (S77 row 3, ADR-0062), in the resolver's own words and never as a proof: `binding`
    // from a committed binding, with no process walk; `launcher` from the environment while the launcher's claim token
    // and process check hold; `environment` from the environment alone. Nothing with no seat.
    const fromSeatSource = !fromSeat
      ? ''
      : seatState.source === 'binding'
        ? 'binding'
        : launcherHoldsSeatForThisAgent(stateDirectory(workspace), fromSeat)
          ? 'launcher'
          : 'environment';
    // THE CONVERSATION READ NEVER BLOCKS A CAPTURE: a damaged record is carried as no id rather than
    // a wrong one, as the oracle carries it.
    let sessionId = '';
    if (fromSeat) {
      try {
        sessionId = seatConversationRecord(stateDirectory(workspace), fromSeat).sessionId;
      } catch {
        sessionId = '';
      }
    }

    // A NEWER NOTE CLOSES AN OLDER ONE (S73 row 4): `--supersedes notes/<page>` names a note of this Book, so it needs
    // the Book open and a seat, where a capture without it stays seatless-capable. The note must exist, and the seat
    // rule must let this seat close it; both are checked again under the lock, with the note still pending.
    let supersedes = (parsed.options.get('supersedes') ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    if (parsed.options.has('supersedes')) {
      if (!/^notes\/[^/]+$/.test(supersedes)) refuse('--supersedes must name a note of this Book as notes/<page>, for example notes/2026-09-29-a-draft.');
      if (!fromSeat) refuse(`--supersedes names a note, so it needs a seat. ${seatState.message ?? ''}`.trim());
      assertShelfBookOpen(workspace, slug, 'closing one of its notes with --supersedes', fromSeat);
      supersededNote(book, supersedes, fromSeat);
    } else {
      supersedes = '';
    }

    // A body that already leads with its own H1 keeps it, so that heading -- not --title -- is what
    // the page, the reader map, the validated reader and triage's -MatchText all call this note.
    const normalisedBody = body.replace(/\s+$/, '');
    const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(normalisedBody);
    const keepsOwnHeading = heading !== null && heading.index === 0 && /[a-zA-Z0-9]/.test(heading[1]!);
    if (!keepsOwnHeading && !title) refuse('Title is required: the body has no leading H1 to name the note, so pass --title.');
    const pageTitle = keepsOwnHeading ? heading![1]!.trim() : title;
    const noteSlug = convertToNoteSlug(pageTitle);
    // SAID, NOT SILENT (S67, deskpost-prompts-dev's Report): a --title the body's H1 replaced is named in the result.
    const titleNote =
      keepsOwnHeading && title && title !== pageTitle
        ? `The body's own H1 names this note ('${pageTitle}'); --title '${title}' was not used.`
        : null;

    const requireNoteFile = (parsed.options.get('require-note-file') ?? '').trim();
    // Picking a free name is a check-then-write sequence, so on its own it is a race. It is called
    // again under the Book's lock below and the file is created with CreateNew, so a collision
    // fails rather than overwrites even if the lock were ever bypassed.
    const selectNoteFile = (): { name: string; full: string; page: string } => {
      if (requireNoteFile) {
        if (!/^[a-z0-9][a-z0-9.-]*\.md$/.test(requireNoteFile)) refuse('RequireNoteFile must be a lowercase Markdown file name.');
        const pinned = path.join(book.notesPath, requireNoteFile);
        if (fs.existsSync(pinned)) {
          refuse(`The approved note path is no longer writable: notes/${requireNoteFile} already exists. Nothing was written.`);
        }
        return { name: requireNoteFile, full: pinned, page: `notes/${requireNoteFile.replace(/\.md$/i, '')}` };
      }
      const stamp = captureDate || localDate();
      // A TITLE THAT ALREADY STARTS WITH THE CAPTURE'S DATE IS NOT DATED TWICE (S67): `2026-09-28 -- x` names
      // `2026-09-28-x.md`, not `2026-09-28-2026-09-28-x.md`.
      const stem = noteSlug.startsWith(`${stamp}-`) ? noteSlug : `${stamp}-${noteSlug}`;
      let name = `${stem}.md`;
      let full = path.join(book.notesPath, name);
      let suffix = 2;
      while (fs.existsSync(full)) {
        name = `${stem}-${suffix}.md`;
        full = path.join(book.notesPath, name);
        suffix += 1;
      }
      return { name, full, page: `notes/${name.replace(/\.md$/i, '')}` };
    };

    let selected = selectNoteFile();

    const plan: Record<string, PsJsonValue> = {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: 'Capture a Shelf note',
      book: book.bookRoot,
      book_title: book.title,
      note_page: `${book.bookRoot}/wiki/${selected.page}`,
      note_title: pageTitle,
      title_source: keepsOwnHeading ? 'body H1' : '--title',
      ...(titleNote !== null ? { title_note: titleNote } : {}),
      body_characters: body.length,
      ...(bodyWarning !== null ? { body_warning: bodyWarning } : {}),
      source,
      from_seat: fromSeat,
      ...(fromSeatSource ? { from_seat_source: fromSeatSource } : {}),
      seat_source: seatSource,
      ...(forSeat ? { for_seat: forSeat } : {}),
      session_id: sessionId,
      ...(why ? { why } : whyMissingSaid ? { why_missing: true } : {}),
      ...(supersedes ? { supersedes } : {}),
      confirmation_required: false,
      survives_reset: true,
      shared_library_write: false,
      scope:
        'Creates one new page under this capture Book, regenerates its reader map, and commits a new Discovery ' +
        'manifest generation in the same locked window. ' +
        (supersedes
          ? `It also closes ${supersedes} (review: done, reviewed:, superseded_by:), journalled with the new note. Nothing is removed.`
          : 'No existing page is read, changed, or removed.'),
    };
    if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

    const frontmatter = ['---', `captured: ${capturedAt}`, 'review: pending'];
    if (fromSeat) frontmatter.push(`from_seat: ${fromSeat}`);
    if (fromSeatSource) frontmatter.push(`from_seat_source: ${fromSeatSource}`);
    if (sessionId) frontmatter.push(`session_id: ${sessionId}`);
    if (forSeat) frontmatter.push(`for_seat: ${forSeat}`);
    const sourceProject = (parsed.options.get('source-project') ?? '').trim();
    const sourcePaths = (parsed.options.get('source-paths') ?? '').trim();
    const tags = (parsed.options.get('tags') ?? '').trim();
    if (sourceProject) frontmatter.push(`source_project: ${sourceProject}`);
    if (sourcePaths) frontmatter.push(`source_paths: ${sourcePaths}`);
    if (tags) frontmatter.push(`tags: ${tags}`);
    if (why) frontmatter.push(`why: ${why}`);
    // ALWAYS WRITTEN WHEN GIVEN, so the relation is recorded even when the older note was already closed.
    if (supersedes) frontmatter.push(`supersedes: ${supersedes}`);
    frontmatter.push('---');

    const page = keepsOwnHeading
      ? frontmatter.join('\n') + '\n\n' + normalisedBody + '\n'
      : frontmatter.join('\n') + '\n\n' + `# ${pageTitle}\n\n` + normalisedBody + '\n';

    const mapPath = path.join(book.wikiPath, '_index.md');
    let lock: BookLock | null = null;
    let journalPath: string | null = null;
    let mutation: BookMutation | null = null;
    let pendingCount = 0;
    let manifestSummary = '';
    try {
      lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);
      fs.mkdirSync(book.notesPath, { recursive: true });
      // Re-selected while holding the lock. The name chosen for the preflight was chosen with
      // nobody excluded, so another session may have taken it since.
      selected = selectNoteFile();
      plan['note_page'] = `${book.bookRoot}/wiki/${selected.page}`;
      // THE OLDER NOTE, AGAIN UNDER THE LOCK: it exists, and this seat may close it. Its prior bytes are journalled
      // with the new note's, so a failure restores both.
      const older = supersedes ? supersededNote(book, supersedes, fromSeat) : null;

      mutation = enterBookMutation({
        workspace,
        slug: book.slug,
        bookRoot: book.bookRoot,
        reason: `Capture note ${selected.name}`,
        lock,
      });
      journalPath = writeBookJournal({
        workspace,
        bookRoot: book.bookRoot,
        operation: `Capture note ${selected.name}`,
        paths: older ? [selected.full, mapPath, older.fullPath] : [selected.full, mapPath],
      }).journalPath;

      // `wx` is CreateNew: a collision fails rather than overwrites, which is what makes the name
      // race above recoverable rather than silent.
      fs.writeFileSync(selected.full, page, { encoding: 'utf8', flag: 'wx' });
      if (readUtf8(selected.full) !== page) {
        refuse(`The note was written but did not read back identically: ${book.bookRoot}/wiki/${selected.page}`);
      }
      // CLOSED BY THE NEWER NOTE: `review: done`, the stamp, and `superseded_by:`. An older note already done is left
      // as it is and said `unchanged`, as a review of it would be.
      if (older) {
        if (older.review === 'done') {
          plan['superseded'] = { page: older.page, status: 'unchanged' };
        } else {
          const text = readUtf8(older.fullPath);
          const closed = setNoteField(setNoteField(text.replace(/^review:\s*[^\n]*/m, 'review: done'), 'reviewed', utcStamp()), 'superseded_by', selected.page);
          if (!/^review: done/m.test(closed)) refuse(`${older.page} has no review field to close.`);
          writeAtomicText(older.fullPath, closed);
          plan['superseded'] = { page: older.page, status: 'closed' };
        }
      }
      // Regenerated inside the same lock. An unlocked rewrite works from a listing that may already
      // be stale, dropping another session's note from the map while leaving its file on disk.
      pendingCount = updateShelfNoteIndex(book).pendingCount;

      manifestSummary = completeBookMutation(mutation).summary;
      mutation = null;
    } catch (error) {
      const failure = (error as Error).message;
      const rollback = runRollback(journalPath);
      settle(mutation, rollback);
      return { refusal: `The note was not captured. ${failure}. Rollback: ${rollback}.`, value: null };
    } finally {
      exitBookLock(lock);
    }

    plan['status'] = 'captured';
    plan['captured'] = capturedAt;
    plan['review'] = 'pending';
    plan['pending_count'] = pendingCount;
    plan['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
    plan['manifest'] = manifestSummary;
    // OPEN AT THIS SEAT ALREADY (S85 row 1): "closed by default" told a seat with the Book open to open it again.
    let openHere = false;
    try {
      openHere = fromSeat !== '' && deskEntriesForSeat(stateDirectory(workspace), fromSeat, 'books').includes(`shelf/${slug}`);
    } catch {
      openHere = false;
    }
    plan['next'] =
      (openHere
        ? 'This Book is open at this seat; read the note with read_open_book_page when you are ready to review.'
        : `This Book is closed by default. Open it with deskpost desk open book ${slug} --location shelf when you are ready to review.`) +
      (why || !whyMissingSaid ? '' : WHY_MISSING_NEXT);
    return { refusal: null, value: plan };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}

// --- book add-page ---------------------------------------------------------------------------------

function addPage(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['title', 'body', 'content-path', 'workspace', 'seat']);
  const slug = parsed.positional[0] ?? '';
  const pagePath = parsed.positional[1] ?? '';

  // A BOOK OF THIS LIBRARY'S OWN COLLECTION, NOT THE SHELF (S67, game-admin's Report): the refusal names its writer
  // rather than only saying no Shelf Book is listed.
  let book: ReturnType<typeof getShelfBook>;
  try {
    book = getShelfBook(workspace, slug);
  } catch (error) {
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && isLocalBackend(workspace) && collectionBookSlugs(workspace, 'active').includes(slug)) {
      refuse(
        `'${slug}' is a Book in this Library's own collection, not on the Shelf. Add a page to it with ` +
          `deskpost collection add-page ${slug} ${pagePath || '<page>'} --content-path <file> --preflight, then --user-confirmed --plan-id <id>.`,
      );
    }
    throw error;
  }
  if (book.isCapture) {
    refuse(
      `Shelf Book '${slug}' is a capture Book. Capture into it with deskpost capture ${slug}; book add-page is for adding a page to a curated Book.`,
    );
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  assertShelfBookOpen(workspace, slug, 'adding a page to it');

  const { body, source } = resolveBody(workspace, parsed.options.get('content-path'), parsed.options.get('body'), 'page');
  if (!body.trim()) refuse('The page body is empty; nothing was added.');
  const bodyWarning = inlineBodyWarning(argv, source, body);

  const page = convertToBookPagePath(pagePath);
  const relative = `${page}.md`;
  const fullPath = path.join(book.wikiPath, ...relative.split('/'));
  // THE PAGE STAYS INSIDE THE BOOK (S67, plan 0.3): a folder that is a link or junction would carry it out.
  assertInsideRoot(book.wikiPath, relative, `shelf/${slug}/wiki`);
  if (fs.existsSync(fullPath)) {
    refuse(`shelf/${slug}/wiki/${relative} already exists. book add-page only ever adds a page; choose another page path.`);
  }

  const rendered = convertToShelfPageBody(body, parsed.options.get('title') ?? '');
  const mapPath = path.join(book.wikiPath, '_index.md');
  const mapIsGenerated = testGeneratedReaderMap(mapPath);
  // THE TOPIC INDEX THIS WRITER LEAVES ALONE, named as `collection add-page` names it (S85 row 1): a page added under a
  // folder whose `_index.md` exists is not linked from it, and the reader should know to add the line.
  const folder = page.includes('/') ? page.substring(0, page.lastIndexOf('/')) : '';
  const topicIndexFull = folder ? path.join(book.wikiPath, ...folder.split('/'), '_index.md') : '';
  const topicIndex = folder && fs.existsSync(topicIndexFull) && `${folder}/_index` !== page ? `${book.bookRoot}/wiki/${folder}/_index.md` : null;

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Add a page to a Shelf Book',
    book: book.bookRoot,
    book_title: book.title,
    page: `${book.bookRoot}/wiki/${relative}`,
    page_title: rendered.title,
    title_source: rendered.titleSource,
    body_characters: body.length,
    ...(bodyWarning !== null ? { body_warning: bodyWarning } : {}),
    source,
    reader_map_action: mapIsGenerated
      ? 'regenerate from the pages on disk'
      : 'append the link; this map is curated, so it is not regenerated',
    reader_map_unlisted: getUnlistedBookPages(book).length,
    topic_index_not_updated: topicIndex,
    confirmation_required: false,
    shared_library_write: false,
    scope:
      'Creates one new page in this open Shelf Book, regenerates its reader map, and commits a new Discovery ' +
      'manifest generation in the same locked window. No existing page is read, changed, or removed.',
  };
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  const createdDirectories: string[] = [];
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);

    // Re-checked under the lock: the collision test above happened before anyone was excluded, so
    // on its own it is exactly the check-then-write race this item exists to close.
    assertInsideRoot(book.wikiPath, relative, `shelf/${slug}/wiki`);
    if (fs.existsSync(fullPath)) {
      refuse(`shelf/${slug}/wiki/${relative} was created while this page was being prepared. Nothing was written.`);
    }

    mutation = enterBookMutation({
      workspace,
      slug: book.slug,
      bookRoot: book.bookRoot,
      reason: `Add page ${relative}`,
      lock,
    });
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Add page ${relative}`,
      paths: [fullPath, mapPath],
    }).journalPath;

    let parent = path.dirname(fullPath);
    while (!fs.existsSync(parent)) {
      createdDirectories.push(parent);
      parent = path.dirname(parent);
    }
    if (createdDirectories.length) fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    fs.writeFileSync(fullPath, rendered.body, { encoding: 'utf8', flag: 'wx' });
    if (readUtf8(fullPath) !== rendered.body) {
      refuse(`The page was written but did not read back identically: ${book.bookRoot}/wiki/${relative}`);
    }

    // A generated map is regenerated, so it can never drift. A curated one is appended to, because
    // regenerating it would destroy sections and annotations a reader wrote -- and an additive
    // write that can destroy text is not additive.
    if (mapIsGenerated) plan['reader_map_pages'] = updateShelfBookIndex(book).pageCount;
    else addShelfBookIndexLink(book, page, rendered.title);
    if (!readUtf8(mapPath).includes(`[[${page}|`)) {
      refuse(`The reader map was updated but does not list ${relative}.`);
    }

    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;

    plan['status'] = 'added';
    plan['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
    plan['reader_map_unlisted'] = getUnlistedBookPages(book).length;
    plan['journal'] = workspaceRelative(workspace, journalPath);
    plan['next'] = mapIsGenerated
      ? 'The Book is open; read the new page with mcp__validated-book-reader__read_open_book_page.'
      : "This Book's reader map is curated, so the new link was appended at the end. Move it into the right section if it belongs elsewhere.";
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback(journalPath, () => {
      // A directory this operation created has no prior state to journal, so it is unwound here --
      // deepest first, and only while empty, so a concurrent writer's page survives.
      for (const directory of createdDirectories) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
    });
    settle(mutation, rollback);
    return { refusal: `The page was not added. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  return { refusal: null, value: plan };
}

// --- book graduate ---------------------------------------------------------------------------------

interface GraduateEntry {
  source: string;
  sourceFull: string;
  sourceSha256: string;
  pagePath: string;
  page: string;
  pageTitle: string;
  state: 'pending' | 'identical' | 'divergent';
}

/**
 * `library book graduate <slug> --topic <t>` -- `tools/Add-ShelfBookTopic.ps1`.
 *
 * THE TOPIC IS NAMED, NOT THE PATH, and the two arms still describe the same source. ADR-0029 puts
 * the Notebook under the seat in this kernel, so a reader here names the topic and the resolver
 * decides where it lives; the PowerShell arm takes `notebook/<topic>` because its Notebook is
 * workspace-wide. `source` reports the same workspace-relative path either way, which is what the
 * row compares.
 */
function graduate(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, ['topic', 'source-path', 'page-prefix', 'workspace', 'seat']);
  const slug = parsed.positional[0] ?? '';

  const book = getShelfBook(workspace, slug);
  if (book.isCapture) {
    refuse(
      `Shelf Book '${slug}' is a capture Book. Capture into it with deskpost capture ${slug}; book graduate moves curated material into a curated Book.`,
    );
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  assertShelfBookOpen(workspace, slug, 'graduating a topic into it');

  const topic = (parsed.options.get('topic') ?? '').trim();
  const explicitSource = (parsed.options.get('source-path') ?? '').trim();
  if (!topic && !explicitSource) refuse('A graduation needs --topic <slug>: the Notebook topic whose articles become pages.');
  // THE SEAT'S OWN NOTEBOOK under ADR-0029, the shared tree on a workspace not yet migrated, and a
  // refusal on one mid-migration -- `notebookScope` decides, as it does for every Notebook reader.
  let sourcePath = explicitSource;
  if (!sourcePath) {
    const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory: stateDirectory(workspace) });
    try {
      sourcePath = `${notebookScope(workspace, seatState.status === 'named' ? seatState.seat! : null, 'read', 'Graduating a Notebook topic').relative}/${topic}`;
    } catch (error) {
      refuse((error as Error).message);
    }
  }
  const sourceRoot = path.resolve(path.isAbsolute(sourcePath) ? sourcePath : path.join(workspace, sourcePath));
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    refuse(`SourcePath is not a directory: ${sourcePath}`);
  }

  const prefixOption = (parsed.options.get('page-prefix') ?? '').trim();
  const prefix = prefixOption ? convertToBookPagePath(prefixOption) + '/' : '';
  const recurse = parsed.flags.has('recurse');

  const articles = (
    recurse
      ? listFilesRecursive(sourceRoot)
      : fs
          .readdirSync(sourceRoot, { withFileTypes: true })
          .filter((item) => item.isFile())
          .map((item) => path.join(sourceRoot, item.name))
          .sort()
  ).filter((file) => file.toLowerCase().endsWith('.md'));
  if (!articles.length) {
    const hint = recurse ? '' : ' (pass --recurse to include subfolders)';
    refuse(`No .md articles found under ${sourcePath}${hint}.`);
  }

  const entries: GraduateEntry[] = [];
  const skipped: { source: string; reason: string }[] = [];
  const problems: string[] = [];

  for (const article of articles) {
    const sourceRelative = article.substring(sourceRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const stem = sourceRelative.substring(0, sourceRelative.length - 3);
    // A topic index is the Notebook's own map of its articles. Carrying it across would collide
    // with the Book's reader map -- reported, not silent.
    if (['_index', '_book'].includes(stem.split('/').pop()!)) {
      skipped.push({ source: sourceRelative, reason: "a topic index is the Notebook's own map, not a Book page" });
      continue;
    }
    let pagePath: string;
    try {
      pagePath = convertToBookPagePath(prefix + stem);
    } catch (error) {
      problems.push(`${sourceRelative} -> ${(error as Error).message}`);
      continue;
    }
    const raw = readUtf8(article);
    if (!raw.trim()) {
      problems.push(`${sourceRelative} is empty.`);
      continue;
    }
    // No title is passed, so an article without a leading H1 is refused by name rather than given a
    // filename-derived heading. A Book page's title is curatorial; guessing it is not this
    // helper's call to make.
    let rendered: RenderedPage;
    try {
      rendered = convertToShelfPageBody(raw, '');
    } catch (error) {
      problems.push(`${sourceRelative} -> ${(error as Error).message}`);
      continue;
    }
    const relative = `${pagePath}.md`;
    const fullPath = path.join(book.wikiPath, ...relative.split('/'));
    let state: GraduateEntry['state'] = 'pending';
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      state = readUtf8(fullPath) === rendered.body ? 'identical' : 'divergent';
    }
    entries.push({
      source: workspaceRelative(workspace, article),
      sourceFull: article,
      sourceSha256: sha256OfText(raw),
      pagePath,
      page: `${book.bookRoot}/wiki/${relative}`,
      pageTitle: rendered.title,
      state,
    });
  }

  if (problems.length) {
    refuse('These articles cannot be graduated as they stand; nothing was written:\n  ' + problems.join('\n  '));
  }
  if (!entries.length) refuse(`Every file under ${sourcePath} was skipped; there is nothing to graduate.`);

  const divergent = entries.filter((entry) => entry.state === 'divergent');
  const identical = entries.filter((entry) => entry.state === 'identical');
  const pending = entries.filter((entry) => entry.state === 'pending');

  // The digest binds the whole operation. Any change to a source, a target, or the set itself
  // produces a different digest, so a journal from an earlier attempt no longer applies and the run
  // starts clean rather than resuming against material that has moved underneath it.
  const canonical = [book.bookRoot].concat(
    [...entries]
      .sort((left, right) => (left.page < right.page ? -1 : left.page > right.page ? 1 : 0))
      .map((entry) => `${entry.page}|${entry.source}|${entry.sourceSha256}`),
  );
  const digest = sha256OfText(canonical.join('\n') + '\n');
  const journalPath = path.join(workspace, 'internal', 'graduate-journals', `${book.slug}-${digest.substring(0, 16)}.json`);

  let resumedFrom: string[] = [];
  let resuming = false;
  if (fs.existsSync(journalPath)) {
    // An unreadable or half-written journal is treated as ABSENT rather than fatal. The pages on
    // disk are the real authority, and idempotence by content reaches the same answer without it.
    try {
      const loaded = JSON.parse(readUtf8(journalPath)) as Record<string, unknown>;
      if ('digest' in loaded && 'entries' in loaded && String(loaded['digest']) === digest) {
        resuming = true;
        const journalEntries = loaded['entries'] as Record<string, { status?: string }>;
        resumedFrom = Object.keys(journalEntries).filter((key) => journalEntries[key]?.status === 'succeeded');
      }
    } catch {
      resuming = false;
    }
  }

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Graduate a topic into a Shelf Book',
    book: book.bookRoot,
    book_title: book.title,
    source: sourcePath,
    pages_total: entries.length,
    pages_pending: pending.length,
    pages_identical: identical.length,
    pages_divergent: divergent.length,
    skipped_sources: skipped.length,
    manifest_digest: digest,
    resuming,
    already_succeeded: resumedFrom.length,
    reader_map_action: testGeneratedReaderMap(path.join(book.wikiPath, '_index.md'))
      ? 'regenerate from the pages on disk, once per page added'
      : 'append each link; this map is curated, so it is not regenerated',
    reader_map_unlisted: getUnlistedBookPages(book).length,
    confirmation_required: false,
    shared_library_write: false,
    scope:
      'Creates new pages in this open Shelf Book, each through Add-ShelfBookPage.ps1 and so each with its own ' +
      'Discovery manifest generation. No existing page is changed or removed: an identical page is left alone and a ' +
      'divergent one refuses the whole operation.',
  };
  if (skipped.length) plan['skipped'] = skipped.map((entry) => ({ source: entry.source, reason: entry.reason }));
  if (divergent.length) {
    plan['blocked'] = true;
    plan['divergent_pages'] = divergent.map((entry) => entry.page);
    plan['next'] =
      'Each page listed in divergent_pages already exists with different content. Compare them and either update the ' +
      'source to match or choose another --page-prefix; book graduate will not overwrite or suffix.';
  }
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  if (divergent.length) {
    refuse(
      `Refused before writing anything: ${divergent.length} target page(s) already exist with different content -- ` +
        divergent.map((entry) => entry.page).join(', ') +
        '. Compare them and either update the source or choose another --page-prefix.',
    );
  }

  // THE APPLY HALF IS NOT PORTED, AND IT REFUSES BY NAME RATHER THAN WRITING A DIFFERENT OPERATION.
  // Its per-page progress journal is what makes an interrupted graduation resumable, and a version
  // that wrote the pages without one would be a writer whose whole distinctive property is missing.
  refuse(
    'library book graduate answers --preflight only: the resumable apply half, with its per-page progress journal, ' +
      'is not in this program yet (PLAN-public-release.md step 24). Add the pages one at a time with deskpost book add-page.',
  );
}

export function runBookVerb(argv: string[], workspace: string): WriterResult {
  const action = argv[0] ?? '';
  try {
    if (action === 'add-page') return addPage(argv.slice(1), workspace);
    if (action === 'graduate') return graduate(argv.slice(1), workspace);
    return { refusal: `library book has no action '${action}'. It has: add-page, graduate.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
