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
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { resolveContentPath } from './contentpath.ts';
import { argumentTable } from './verbs.ts';
import { inlineCutWarning } from './inlinecut.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import {
  completeBookMutation,
  enterBookMutation,
  undoBookMutation,
  type BookMutation,
} from './mutation.ts';
import { pageComparisonSha256, sha256OfText } from './sha.ts';
import { writeAtomicText } from './fsx.ts';
import { changeCounts } from './hubedit.ts';
import { foldedMapLines, linkLabel, planTopicIndexLine, topicIndexPage, type MapPage, type TopicIndexPlan } from './maplines.ts';
import {
  ABSENT,
  markCompiled,
  readCompiledMap,
  renderSourceList,
  SOURCE_LIST_FILE,
  sourceListBlock,
  sourceListSha256,
  validateSourceList,
  type SourceList,
} from './booksources.ts';
import { rawBatchOwner } from './rawowners.ts';
import { archiveRecordPath, getShelfBook, listFilesRecursive, readUtf8, type ShelfBook } from './shelfbook.ts';
import { assertSeatMayClose, isAddressedTo, seatNameForText, setNoteField, shelfNotes, whyRefusal, type SeatIncarnation, type ShelfNoteRow } from './shelfnote.ts';
import { idsOf, incarnationOf, readSeatIdentityView, seatIncarnation, type SeatIdentityView } from './seatincarnation.ts';
import { departmentProblem, readSeatMetadata } from './seatmeta.ts';

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
import { controlCharacterInLine, strayControlRefusal } from './controlchars.ts';

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

/**
 * The generated map's text, from the pages on disk: a topic's reached pages folded under its index (D4, `maplines.ts`).
 * `folded_topics` counts the topic lines that stand for pages.
 */
function shelfBookIndexText(book: ShelfBook): { text: string; pageCount: number; foldedTopics: number } {
  const relatives = bookPageRelatives(book.wikiPath);
  const pages: MapPage[] = relatives.map((relative) => {
    const text = readUtf8(path.join(book.wikiPath, ...relative.split('/')));
    return { page: relative.substring(0, relative.length - 3), label: readerMapLabel(text, relative), text };
  });
  const folded = foldedMapLines(pages, (page) => page);
  const links = ['- [[_book|Book metadata and limits]]'].concat(folded.lines);
  return { text: `# ${book.title} - Reader Map\n\n` + links.join('\n') + '\n', pageCount: relatives.length, foldedTopics: folded.foldedTopics };
}

/** Regenerated from the pages on disk, so a generated map can never drift from what the Book holds. */
export function updateShelfBookIndex(book: ShelfBook): { pageCount: number } {
  const built = shelfBookIndexText(book);
  writeUtf8(path.join(book.wikiPath, '_index.md'), built.text);
  return { pageCount: built.pageCount };
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
function supersededNote(book: ShelfBook, page: string, seat: SeatIncarnation): ShelfNoteRow {
  const note = shelfNotes(book).find((row) => row.page === page);
  if (!note) refuse(`--supersedes names ${page}, and Book '${book.slug}' has no such note. Nothing was captured.`);
  assertSeatMayClose(note, { slug: book.slug, closedBy: book.closedBy ?? 'any' }, seat, null, refuse);
  return note;
}

/**
 * THE LETTER `--answers` OR `--routes` NAMES (kickoffs/s98 rows 1 and 2; PLAN-seats-team.md session 3 items 1 and 2): it
 * exists, its frontmatter is whole, it is addressed to this seat by the recipient predicate, and it is still pending
 * with no closing link. Checked before the lock and again under it, so a letter answered or routed in between is
 * refused, never closed twice. Mutation is strict where display is tolerant: a malformed letter is refused here.
 */
function closableLetter(book: ShelfBook, page: string, seat: SeatIncarnation, flag: '--answers' | '--routes'): ShelfNoteRow {
  const act = flag === '--answers' ? 'answer' : 'route';
  const note = shelfNotes(book).find((row) => row.page === page);
  if (!note) refuse(`${flag} names ${page}, and Book '${book.slug}' has no such note. Nothing was captured.`);
  if (note.malformed.length) {
    refuse(
      `${page} carries frontmatter this program does not trust (${note.malformed.join(', ')}), so ${flag} refuses it: ` +
        "repair the note's frontmatter by hand, or close it with triage. Nothing was captured.",
    );
  }
  if (!isAddressedTo(note, seat)) {
    refuse(
      note.forSeat === seat.seat
        ? `${page} was addressed to an earlier seat named '${seat.seat}' (its for_seat_id is not this seat's), so this seat cannot ${act} it. Nothing was captured.`
        : note.forSeat
          ? `${page} is a letter for seat '${note.forSeat}', not for this seat '${seat.seat}', so this seat cannot ${act} it. Nothing was captured.`
          : `${page} is addressed to no seat, so it is not a letter ${flag} can ${act}. Nothing was captured.`,
    );
  }
  if (note.review === 'done') refuse(`${page} is already closed (review: done), so ${flag} refuses it. Nothing was captured.`);
  if (note.answeredBy || note.routedTo) {
    refuse(`${page} was reopened and still carries ${note.answeredBy ? 'answered_by' : 'routed_to'}: reopen is for triage, not for a second ${act}; write a new letter. Nothing was captured.`);
  }
  return note;
}

/**
 * WHOM AN ANSWER REACHES, KNOWN OR REFUSED (kickoffs/s98 row 1): the letter's `origin_seat`, the first asker, through any
 * number of routes, and only while the registry still names that incarnation: the letter carries `origin_seat_id` and
 * the row of `origin_seat` has that `seat_id`. The reply's `for_seat_id` is this validated id, never a later lookup.
 */
function knownAsker(note: ShelfNoteRow, view: SeatIdentityView): SeatIncarnation {
  const fallbacks = `Write a plain letter --for <seat> that names ${note.page}, or close it with a triage review. Nothing was captured.`;
  if (!note.originSeat || !note.originSeatId) {
    refuse(`${note.page} records no asker's seat_id (a letter written before 1.3.8, or by no seat), so --answers cannot know whom its answer reaches. ${fallbacks}`);
  }
  // THE ASKER BY THE IDENTITY PROJECTION (kickoffs/s103 row 3): found by its `origin_seat_id`, and the reply addressed to
  // its CURRENT name with that id, which is the recorded name until a rename.
  const asker = incarnationOf(view, note.originSeat, note.originSeatId, 'letters');
  if (asker.outcome !== 'live') {
    refuse(`${note.page}'s asker, seat '${note.originSeat}', is not the seat this Library's registry now names: it was retired, or retired and created again under that name. ${fallbacks}`);
  }
  return { seat: asker.current_name!, seatId: note.originSeatId, view };
}

/**
 * SELF-TEST ONLY (`LIBRARY_CAPTURE_ASKER_FAULT=recreate`, as `LIBRARY_SEAT_START_FAULT` is): the asker is retired and
 * created again between the check and the write, as a race with `seat retire` would leave it. Its registry row keeps its
 * slug and gets a new `seat_id`, so the reply's validated id is the stale delivery doctor names (plan, Risks).
 */
function recreateAskerForTest(workspace: string, seat: string): void {
  const file = path.join(stateDirectory(workspace), 'seats', '_registry.json');
  const parsed = JSON.parse(readUtf8(file)) as { seats: Record<string, unknown>[] };
  for (const row of parsed.seats) if (row['seat'] === seat) row['seat_id'] = randomUUID().replace(/-/g, '');
  writeAtomicText(file, JSON.stringify(parsed, null, 4) + '\n');
}

/** HOP LIMIT 3 (kickoffs/s98 row 2): a letter routed three times goes to the reader, never a fourth seat. */
function assertHopsLeft(note: ShelfNoteRow): void {
  const hops = note.hops ?? 0;
  if (hops + 1 > 3) {
    refuse(`${note.page} has been routed ${hops} times already, and a letter is routed at most 3 times: ask the reader where it should go. Nothing was captured.`);
  }
}

/**
 * THE FIRST ASKER OF A ROUTED LETTER, AS RECORDED (kickoffs/s98 row 2): its `origin_seat` and `origin_seat_id`, or for a
 * letter written before 1.3.8 its `from_seat` and no id. A value that is not a seat name is recorded as missing.
 */
function routedOrigin(note: ShelfNoteRow): SeatIncarnation {
  const seat = note.originSeat ?? note.fromSeat ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(seat)) return { seat: '', seatId: '' };
  return { seat, seatId: note.originSeat ? note.originSeatId ?? '' : '' };
}

/**
 * A ROUTED LETTER'S BODY (kickoffs/s98 row 2; PLAN-seats-team.md session 3 item 2): a provenance line the PROGRAM writes,
 * from validated fields with the letter preface's own sanitizing (`seatNameForText`), so it can carry no writer's text;
 * then the router's own text; then the original's body, verbatim, under `## Original letter`.
 */
function routedBody(original: ShelfNoteRow, page: string, router: string, origin: string, body: string): string {
  const text = readUtf8(original.fullPath).replace(/\r\n/g, '\n');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const originalBody = (close >= 0 ? text.slice(close + 5) : text).replace(/^\n+/, '').replace(/\s+$/, '');
  const link = /^notes\/[a-z0-9][a-z0-9.-]*$/.test(page) ? `\`${page}\`` : '(a letter of this Book)';
  const to = original.forDepartment
    ? `to department ${seatNameForText(original.forDepartment)}, resolved to ${seatNameForText(original.forSeat)}`
    : `to seat ${seatNameForText(original.forSeat)}`;
  const provenance = `Originally from seat ${seatNameForText(origin)} (claimed by its capture, not proof), ${to}; routed by ${seatNameForText(router)} from ${link}.`;
  return `${provenance}\n\n${body.replace(/\s+$/, '')}\n\n## Original letter\n\n${originalBody}\n`;
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
    // addressed to no seat, so a recipient finds its own at once. `Update-ShelfNoteIndex` writes the same lines. THE
    // GROUP IS THE RECIPIENT'S CURRENT NAME by the identity projection (kickoffs/s103 row 3), which is the recorded name
    // until a rename; a letter it finds no live seat for stays under the name it was written to.
    const workspace = path.resolve(book.wikiPath, ...book.bookRoot.split('/').map(() => '..'), '..');
    const view = readSeatIdentityView(stateDirectory(workspace));
    const groupOf = (note: ShelfNoteRow): string => {
      if (!note.forSeat) return '';
      const found = incarnationOf(view, note.forSeat, note.malformed.length ? null : note.forSeatId, 'letters');
      return found.outcome === 'live' && !note.malformed.length ? found.current_name! : note.forSeat;
    };
    const recipients = [...new Set(pending.map(groupOf))].sort((left, right) => (left === '' ? 1 : right === '' ? -1 : left < right ? -1 : left > right ? 1 : 0));
    recipients.forEach((recipient, index) => {
      if (index) lines.push('');
      lines.push(recipient ? `### For ${recipient}` : '### For no seat', '');
      for (const note of pending.filter((row) => groupOf(row) === recipient)) lines.push(`- [[${note.page}|${note.title}]] - captured ${note.captured}`);
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
  // NO STRAY CONTROL CHARACTER REACHES A NOTE OR A PAGE (kickoffs/s94 row 3): capture and book add-page, before any write.
  const clean = (body: string, given: string) => {
    const stray = strayControlRefusal(body, given);
    if (stray !== null) refuse(stray);
    return body;
  };
  if (!hasPath) return { body: clean(inline!, '--body'), source: '(inline)' };
  // A body is often a scratch file outside the workspace, so an absolute path is taken as given and a relative one is
  // read by the one rule every writer shares (contentpath.ts): the working directory first, then the Library's folder.
  const full = resolveContentPath(workspace, contentPath!);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--content-path ${contentPath} was not found (resolved to ${full}).`);
  return { body: clean(readUtf8(full), `--content-path ${contentPath}`), source: contentPath! };
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
export function captureVerb(
  argv: string[],
  workspace: string,
  // INTERNAL, NEVER A CLI FLAG (kickoffs/s104 row 3, D6): lines a caller in this program adds to the note's frontmatter,
  // after every line capture writes itself. `doctor --report` records `doctor_check` and `doctor_digest` with it.
  internal: { extraFrontmatter?: [string, string][] } = {},
): WriterResult {
  for (const [key, value] of internal.extraFrontmatter ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || /[\r\n]/.test(value) || controlCharacterInLine(value) !== null) {
      return { refusal: `An internal frontmatter line '${key}' is not one plain line; nothing was captured.`, value: null };
    }
  }
  const parsed = parseArguments(argv, argumentTable('capture'));
  try {
    // THE AUTHOR IS RESOLVED, NEVER TYPED (ADR-0062): a seat a caller could type would let any shell file under
    // another seat's name. Refused for every Book, before anything is read.
    if (parsed.options.has('seat') || parsed.flags.has('seat')) {
      refuse("library capture does not take --seat: the writing seat is resolved from this session's binding or launcher, never typed, so no shell can file under another seat's name. Nothing was captured.");
    }
    // ONE LINE EACH (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0): every option but --body's text lands in the
    // note's frontmatter or its heading, where a line break would start a field no writer wrote, so a control character
    // in any of them is refused before anything is read, as a seat card's is (S96 ruling 3).
    for (const [name, value] of parsed.options) {
      if (name === 'body') continue;
      const stray = controlCharacterInLine(value);
      if (stray !== null) {
        refuse(`--${name} holds ${stray.name} (${stray.codePoint}): every capture option is one line of text with no control character, since it is written into the note's frontmatter or heading. Nothing was captured.`);
      }
    }
    // A LETTER TAKES ONE ADDRESS (kickoffs/s98 row 0): a seat and a department may share a name, so the two never share a flag.
    const given = (name: string): boolean => parsed.options.has(name) || parsed.flags.has(name);
    if (given('for') && given('for-department')) {
      refuse('--for and --for-department are two addresses, and a letter takes one: --for <seat> names a seat, --for-department <department> reaches its orchestrator. Nothing was captured.');
    }
    // AN ANSWER IS ADDRESSED BY THE LETTER IT ANSWERS, and closes it (kickoffs/s98 row 1, PLAN-seats-team.md's flag matrix).
    if (given('answers') && (given('for') || given('for-department'))) {
      refuse("--answers addresses the reply to the letter's first asker, so it takes neither --for nor --for-department. Nothing was captured.");
    }
    if (given('answers') && given('supersedes')) {
      refuse('--answers and --supersedes each close a note, and one capture closes one: use one of them. Nothing was captured.');
    }
    // A ROUTE HANDS A LETTER ON TO ONE SEAT (kickoffs/s98 row 2): `--for <seat>` only, so `for_department` always means
    // the department a letter was addressed to; a hand-off to another department is a new letter that names the page.
    if (given('routes') && given('for-department')) {
      refuse('--routes takes --for <seat> only: a hand-off to another department is a new letter --for-department <department> that names the page, with no link. Nothing was captured.');
    }
    if (given('routes') && (given('answers') || given('supersedes'))) {
      refuse(`--routes and ${given('answers') ? '--answers' : '--supersedes'} each close a note, and one capture closes one: use one of them. Nothing was captured.`);
    }
    if (given('routes') && !given('for')) {
      refuse('--routes hands a letter on to one seat, named with --for: library capture letters --for <seat> --routes notes/<page> --title <t> --content-path <file>. Nothing was captured.');
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
    let forSeat = (parsed.options.get('for') ?? '').trim();
    const refuseNoLetters = (flag: string): never =>
      refuse(
        `Shelf Book '${slug}' does not take letters (its catalog entry has no '- **Letters:** yes'), so it refuses ${flag}. ` +
          `A note for another seat is a letter: library capture letters --for <seat> --title <t> --content-path <file>. Nothing was captured.`,
      );
    if (parsed.options.has('for') || parsed.flags.has('for')) {
      if (!book.takesLetters) refuseNoLetters('--for');
      if (!forSeat) refuse('--for names the seat a letter is for: --for <seat>. Nothing was captured.');
      const seats = seatDirectoryNames(stateDirectory(workspace));
      if (!seats.includes(forSeat)) {
        refuse(`--for '${forSeat}' names no seat in this Library. Seats: ${seats.length ? seats.join(', ') : '(none)'}. Nothing was captured.`);
      }
      if (!why) why = 'for-seat';
    }

    // A LETTER TO A DEPARTMENT (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0; ADR-0069): resolved NOW, when the
    // letter is written, to the department's one orchestrator, so `for_seat` names a seat as on every other letter and
    // the reader's preface, the Desk count and the close rule need no second path. `for_department` keeps the address.
    let forDepartment = (parsed.options.get('for-department') ?? '').trim();
    if (given('for-department')) {
      if (!book.takesLetters) refuseNoLetters('--for-department');
      if (!forDepartment) refuse('--for-department names the department a letter is for: --for-department <department>. Nothing was captured.');
      const problem = departmentProblem(forDepartment);
      if (problem !== null) refuse(`--for-department '${forDepartment}' is not a department name: ${problem}. Nothing was captured.`);
      const departments = readSeatMetadata(stateDirectory(workspace)).departments;
      const orchestrator = departments.find((view) => view.department === forDepartment)?.orchestrator ?? null;
      if (orchestrator === null) {
        const reachable = departments.filter((view) => view.orchestrator !== null).map((view) => `${view.department} (${view.orchestrator})`);
        refuse(
          `Department '${forDepartment}' has no orchestrator in this Library, so a letter to it reaches no seat. ` +
            `Departments with one: ${reachable.length ? reachable.join(', ') : '(none)'}. Write to a seat with --for <seat>. Nothing was captured.`,
        );
      }
      forSeat = orchestrator;
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

    // AN ANSWER (kickoffs/s98 row 1; PLAN-seats-team.md session 3 item 1): `--answers notes/<page>` writes a reply to the
    // letter's first asker and closes the letter `answered_by` the reply, as `--supersedes` closes and links. The Book is
    // open on this seat's Desk, this seat is the letter's recipient, the letter is pending with no link, and its asker is
    // the same incarnation the registry names now; the reply is stamped with that validated id.
    const answers = (parsed.options.get('answers') ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    let asker: SeatIncarnation | null = null;
    if (given('answers')) {
      if (!book.takesLetters) refuseNoLetters('--answers');
      if (!/^notes\/[^/]+$/.test(answers)) refuse('--answers must name a letter of this Book as notes/<page>, for example notes/2026-10-07-a-question. Nothing was captured.');
      if (!fromSeat) refuse(`--answers names a letter, so it needs a seat. ${seatState.message ?? ''} Nothing was captured.`.replace(/ +/g, ' '));
      assertShelfBookOpen(workspace, slug, 'answering one of its letters with --answers', fromSeat);
      const view = readSeatIdentityView(stateDirectory(workspace));
      asker = knownAsker(closableLetter(book, answers, seatIncarnation(stateDirectory(workspace), fromSeat, view), '--answers'), view);
      forSeat = asker.seat;
      if (!why) why = 'for-seat';
      if ((process.env['LIBRARY_CAPTURE_ASKER_FAULT'] ?? '') === 'recreate') recreateAskerForTest(workspace, asker.seat);
    }

    // A ROUTE (kickoffs/s98 row 2; PLAN-seats-team.md session 3 item 2): `--for <seat> --routes notes/<page>` hands a
    // letter on, in its own Book (the page names a note of this Book, so material never crosses into a Book with another
    // audience), and closes it `routed_to` the new letter. The new letter keeps the department addressed and the first
    // asker AS RECORDED (nothing is looked up for it: routing certifies nothing about the asker), counts one more hop,
    // and carries a provenance line the program writes from validated fields, then the router's text, then the original.
    const routes = (parsed.options.get('routes') ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    let routed: ShelfNoteRow | null = null;
    if (given('routes')) {
      if (!book.takesLetters) refuseNoLetters('--routes');
      if (!/^notes\/[^/]+$/.test(routes)) refuse('--routes must name a letter of this Book as notes/<page>, for example notes/2026-10-07-a-question. Nothing was captured.');
      if (!fromSeat) refuse(`--routes names a letter, so it needs a seat. ${seatState.message ?? ''} Nothing was captured.`.replace(/ +/g, ' '));
      assertShelfBookOpen(workspace, slug, 'routing one of its letters with --routes', fromSeat);
      routed = closableLetter(book, routes, seatIncarnation(stateDirectory(workspace), fromSeat), '--routes');
      assertHopsLeft(routed);
      forDepartment = routed.forDepartment ?? '';
    }

    // BOTH ENDS OF A LETTER, AS THE REGISTRY READS NOW (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0): the
    // writer's `seat_id` and the recipient's, at the moment of writing. MISSING IDENTITY IS RECORDED AS MISSING, never
    // manufactured: a seatless capture records no origin, a pre-identity row gives its slug and no id, and nothing fills
    // an id in later. Not a lock: a retire in the same second is the stale delivery doctor names (plan, Risks).
    const letter = forSeat !== '';
    const identity: SeatIdentityView = letter || parsed.options.has('supersedes') ? readSeatIdentityView(stateDirectory(workspace)) : { live: [], retired: [] };
    const seatIds = idsOf(identity);
    const self = fromSeat ? seatIncarnation(stateDirectory(workspace), fromSeat, identity) : null;
    // A ROUTE COPIES THE FIRST ASKER AS IT IS RECORDED: a letter written before 1.3.8 gives its from_seat and no id.
    const originSeat = routed !== null ? routedOrigin(routed).seat : fromSeat;
    const originSeatId = routed !== null ? routedOrigin(routed).seatId : letter && fromSeat ? seatIds.get(fromSeat) ?? '' : '';
    const forSeatId = asker !== null ? asker.seatId : letter ? seatIds.get(forSeat) ?? '' : '';

    // A NEWER NOTE CLOSES AN OLDER ONE (S73 row 4): `--supersedes notes/<page>` names a note of this Book, so it needs
    // the Book open and a seat, where a capture without it stays seatless-capable. The note must exist, and the seat
    // rule must let this seat close it; both are checked again under the lock, with the note still pending.
    let supersedes = (parsed.options.get('supersedes') ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    if (parsed.options.has('supersedes')) {
      if (!/^notes\/[^/]+$/.test(supersedes)) refuse('--supersedes must name a note of this Book as notes/<page>, for example notes/2026-09-29-a-draft.');
      if (!fromSeat) refuse(`--supersedes names a note, so it needs a seat. ${seatState.message ?? ''}`.trim());
      assertShelfBookOpen(workspace, slug, 'closing one of its notes with --supersedes', fromSeat);
      supersededNote(book, supersedes, self!);
    } else {
      supersedes = '';
    }

    // A body that already leads with its own H1 keeps it, so that heading -- not --title -- is what
    // the page, the reader map, the validated reader and triage's -MatchText all call this note.
    const normalisedBody = (routed ? routedBody(routed, routes, fromSeat, originSeat, body) : body).replace(/\s+$/, '');
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
          : answers
            ? `It also closes ${answers} (review: done, reviewed:, answered_by:), journalled with the new note. Nothing is removed.`
            : routes
              ? `It also closes ${routes} (review: done, reviewed:, routed_to:), journalled with the new note. Nothing is removed.`
            : 'No existing page is read, changed, or removed.'),
      // A LETTER'S ADDRESS AND BOTH INCARNATIONS (kickoffs/s98 row 0), after every older key; null where none was read.
      ...(forDepartment ? { for_department: forDepartment } : {}),
      ...(letter ? { for_seat_id: forSeatId || null, origin_seat: originSeat || null, origin_seat_id: originSeatId || null } : {}),
      ...(answers ? { answers } : {}),
      ...(routed ? { routes, hops: (routed.hops ?? 0) + 1 } : {}),
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
    // A LETTER'S DEPARTMENT AND INCARNATIONS (kickoffs/s98 row 0), after every older line, and only what was read.
    if (forDepartment) frontmatter.push(`for_department: ${forDepartment}`);
    if (letter && forSeatId) frontmatter.push(`for_seat_id: ${forSeatId}`);
    if (letter && originSeat) frontmatter.push(`origin_seat: ${originSeat}`);
    if (letter && originSeatId) frontmatter.push(`origin_seat_id: ${originSeatId}`);
    if (answers) frontmatter.push(`answers: ${answers}`);
    if (routed) frontmatter.push(`routed_from: ${routes}`, `hops: ${(routed.hops ?? 0) + 1}`);
    for (const [key, value] of internal.extraFrontmatter ?? []) frontmatter.push(`${key}: ${value}`);
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
      const older = supersedes ? supersededNote(book, supersedes, self!) : null;
      // THE LETTER AN ANSWER CLOSES, AGAIN UNDER THE LOCK: still pending, still unlinked, still this seat's.
      const answered = answers ? closableLetter(book, answers, self!, '--answers') : null;
      // THE LETTER A ROUTE CLOSES, AGAIN UNDER THE LOCK, with its hop count.
      const routedAgain = routes ? closableLetter(book, routes, self!, '--routes') : null;
      if (routedAgain) assertHopsLeft(routedAgain);

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
        paths: [selected.full, mapPath, ...(older ? [older.fullPath] : []), ...(answered ? [answered.fullPath] : []), ...(routedAgain ? [routedAgain.fullPath] : [])],
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
      // ANSWERED BY THE REPLY: `review: done`, the stamp, and `answered_by:` (kickoffs/s98 row 1).
      if (answered) {
        const text = readUtf8(answered.fullPath);
        const closed = setNoteField(setNoteField(text.replace(/^review:\s*[^\n]*/m, 'review: done'), 'reviewed', utcStamp()), 'answered_by', selected.page);
        if (!/^review: done/m.test(closed)) refuse(`${answered.page} has no review field to close.`);
        writeAtomicText(answered.fullPath, closed);
        plan['answered'] = { page: answered.page, status: 'closed' };
      }
      // ROUTED ON: `review: done`, the stamp, and `routed_to:` (kickoffs/s98 row 2).
      if (routedAgain) {
        const text = readUtf8(routedAgain.fullPath);
        const closed = setNoteField(setNoteField(text.replace(/^review:\s*[^\n]*/m, 'review: done'), 'reviewed', utcStamp()), 'routed_to', selected.page);
        if (!/^review: done/m.test(closed)) refuse(`${routedAgain.page} has no review field to close.`);
        writeAtomicText(routedAgain.fullPath, closed);
        plan['routed'] = { page: routedAgain.page, status: 'closed' };
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
  const parsed = parseArguments(argv, argumentTable('book', 'add-page'));
  // THE SECOND FORM (D8): a raw/ batch as the Book's sources/ pages, with no <page> positional.
  if (parsed.options.has('from-folder') || parsed.flags.has('from-folder')) return addFromFolder(parsed, workspace);
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
  // THE TOPIC INDEX GAINS THE PAGE'S LINE (kickoffs/s101 row 3; PLAN-correct-and-find.md D3): a page added under a folder
  // whose `_index.md` does not already link it gets one line at that index's end. Appending removes no text, so this
  // writer stays ungated; the index is planned again under the lock and journaled with the page.
  const topicPage = topicIndexPage(page);
  const topicIndexFull = topicPage ? path.join(book.wikiPath, ...`${topicPage}.md`.split('/')) : null;
  const planTopicIndex = (): TopicIndexPlan | null => {
    if (topicIndexFull === null || !fs.existsSync(topicIndexFull)) return null;
    const planned = planTopicIndexLine(fs.readFileSync(topicIndexFull, 'utf8'), slug, page, rendered.title);
    if (planned === 'open-fence') {
      refuse(
        `The topic index shelf/${slug}/wiki/${topicPage}.md ends inside an unclosed code fence, so a link added at its end ` +
          'would show as code, not a link. Close the fence in the topic index first. Nothing was added.',
      );
    }
    return planned;
  };
  const topicPlan = planTopicIndex();

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
    topic_index: topicPlan === null ? null : topicPlan.status,
    confirmation_required: false,
    shared_library_write: false,
    scope:
      'Creates one new page in this open Shelf Book, regenerates its reader map, and commits a new Discovery ' +
      'manifest generation in the same locked window. ' +
      (topicPlan !== null && topicPlan.status === 'updated'
        ? `The topic index ${topicPage}.md gains one line at its end; no other existing page is changed, and none is removed.`
        : 'No existing page is read, changed, or removed.'),
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
    const topicNow = planTopicIndex();
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Add page ${relative}`,
      paths: [fullPath, mapPath, ...(topicNow !== null && topicNow.newText !== null ? [topicIndexFull!] : [])],
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
    // THE TOPIC INDEX BEFORE THE READBACK, so the reach check below sees it.
    if (topicNow !== null && topicNow.newText !== null) {
      writeAtomicText(topicIndexFull!, topicNow.newText);
      if (fs.readFileSync(topicIndexFull!, 'utf8') !== topicNow.newText) refuse(`The topic index ${topicPage}.md was written but did not read back identically.`);
    }
    plan['topic_index'] = topicNow === null ? null : topicNow.status;

    // A generated map is regenerated, so it can never drift. A curated one is appended to, because
    // regenerating it would destroy sections and annotations a reader wrote -- and an additive
    // write that can destroy text is not additive.
    if (mapIsGenerated) plan['reader_map_pages'] = updateShelfBookIndex(book).pageCount;
    else addShelfBookIndexLink(book, page, rendered.title);
    // REACHED, NOT LISTED (kickoffs/s101 ruling 4): the root map or a topic index it links reaches the new page.
    if (getUnlistedBookPages(book).includes(relative)) {
      refuse(`The reader map was updated but does not reach ${relative}.`);
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

// --- book add-page --from-folder: the source home ---------------------------------------------------

const FROM_FOLDER_USAGE = 'deskpost book add-page <slug> --from-folder raw/<batch> [--preflight]';
const SOURCES_TOPIC = 'sources';

/**
 * A source file's page name (D8): its stem lowercased, every run of characters outside `[a-z0-9]` turned to one hyphen,
 * and the ends trimmed. Empty when nothing is left, which refuses the batch.
 */
function sourcePageName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '');
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface SourceFile {
  file: string;
  name: string;
  page: string;
  fullPath: string;
  rendered: RenderedPage;
}

/**
 * `deskpost book add-page <slug> --from-folder raw/<batch>` (kickoffs/s104 row 1; PLAN-correct-and-find.md D8): a flat
 * batch directly under `raw/`, each `.md` or `.txt` file a page `sources/<name>` of an open curated Shelf Book, in one
 * lock, one journal, one manifest generation and one reader-map update.
 *
 * THE WHOLE BATCH OR NONE OF IT. Any file that cannot become a page -- a name two files reach, a name the Book already
 * has, an empty name, an unreadable or empty file, a refused character, a file that is neither `.md` nor `.txt`, a
 * subfolder -- refuses the batch, naming each, and nothing is written. A batch partly compiled would read as compiled.
 *
 * NOTHING IN `raw/` IS TOUCHED: eviction is offered and never performed, so the result's `next` names the batch as
 * ready to evict, with its owner when `internal/raw-batch-owners.json` records one.
 */
function addFromFolder(parsed: ReturnType<typeof parseArguments>, workspace: string): WriterResult {
  const slug = parsed.positional[0] ?? '';
  if (!slug) refuse(`book add-page --from-folder needs a Book slug: ${FROM_FOLDER_USAGE}.`);
  // D7 IS NOT BUILT, SO THIS FORM CHECKS ITS OWN ARITY, in words the declared tables can keep.
  if (parsed.positional.length > 1) {
    refuse(`book add-page --from-folder takes no <page>: each file in the batch names its own page under sources/. Nothing was added. Usage: ${FROM_FOLDER_USAGE}.`);
  }
  for (const option of ['content-path', 'body', 'title']) {
    if (parsed.options.has(option) || parsed.flags.has(option)) {
      refuse(`book add-page --from-folder takes no --${option}: each file is a page's text and names its own title. Nothing was added.`);
    }
  }
  const folderArgument = (parsed.options.get('from-folder') ?? '').trim();
  if (!folderArgument) refuse(`--from-folder needs the batch folder: ${FROM_FOLDER_USAGE}.`);

  const book = getShelfBook(workspace, slug);
  if (book.isCapture) {
    refuse(`Shelf Book '${slug}' is a capture Book. Capture into it with deskpost capture ${slug}; book add-page is for adding pages to a curated Book.`);
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  assertShelfBookOpen(workspace, slug, 'adding pages to it');

  // A BATCH DIRECTLY UNDER raw/, named plainly or as a path: not raw/ itself, nothing deeper, nothing outside.
  const rawRoot = path.resolve(workspace, 'raw');
  const folder = path.resolve(path.isAbsolute(folderArgument) ? folderArgument : path.join(workspace, folderArgument));
  const inRaw = path.relative(rawRoot, folder);
  if (!inRaw || inRaw.startsWith('..') || path.isAbsolute(inRaw) || /[\\/]/.test(inRaw)) {
    refuse(`--from-folder ${folderArgument} is not a batch directly under raw/ (resolved to ${folder}). Name a batch folder such as raw/<batch>. Nothing was added.`);
  }
  const batch = `raw/${inRaw}`;
  if (!fs.existsSync(folder) || !fs.lstatSync(folder).isDirectory()) {
    refuse(`${batch} is not a folder${fs.existsSync(folder) ? ' (a link or a file)' : ''}. Nothing was added.`);
  }

  const faults: string[] = [];
  const files: SourceFile[] = [];
  const entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const where = `${batch}/${entry.name}`;
    if (entry.isDirectory()) {
      faults.push(`${where}/ is a subfolder; a batch compiled with --from-folder is flat`);
      continue;
    }
    if (!entry.isFile()) {
      faults.push(`${where} is not a plain file`);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (extension !== '.md' && extension !== '.txt') {
      faults.push(`${where} is neither .md nor .txt`);
      continue;
    }
    const name = sourcePageName(entry.name);
    if (!name) {
      faults.push(`${where} leaves no page name (its name has no letter or digit)`);
      continue;
    }
    let body: string;
    try {
      body = readUtf8(path.join(folder, entry.name));
    } catch (error) {
      faults.push(`${where} could not be read: ${(error as Error).message}`);
      continue;
    }
    const stray = strayControlRefusal(body, where);
    if (stray !== null) {
      faults.push(stray.replace(/\s*Nothing was (?:added|written)\.?\s*$/i, ''));
      continue;
    }
    if (!body.trim()) {
      faults.push(`${where} is empty`);
      continue;
    }
    const page = `${SOURCES_TOPIC}/${name}`;
    const fullPath = path.join(book.wikiPath, SOURCES_TOPIC, `${name}.md`);
    if (fs.existsSync(fullPath)) {
      faults.push(`${where} would be the page ${page}, which shelf/${slug} already has`);
      continue;
    }
    // A .txt FILE, OR AN .md WITHOUT A LEADING H1, IS TITLED BY ITS STEM.
    const rendered = renderPageBody(body, entry.name.replace(/\.[^.]*$/, ''));
    files.push({ file: entry.name, name, page, fullPath, rendered });
  }
  const byName = new Map<string, string[]>();
  for (const source of files) byName.set(source.name, [...(byName.get(source.name) ?? []), source.file]);
  for (const [name, named] of byName) {
    if (named.length > 1) faults.push(`${named.map((file) => `${batch}/${file}`).join(' and ')} would all be the page ${SOURCES_TOPIC}/${name}`);
  }
  if (!faults.length && !files.length) faults.push(`${batch} holds no .md or .txt file`);
  if (faults.length) {
    refuse(`The batch ${batch} was not added: ${faults.length} problem(s), and a batch is added whole or not at all. ${faults.join('; ')}. Nothing was added.`);
  }

  // THE TOPIC INDEX: created with `# Sources` and one line per page, or gaining D3's line for each page it does not list.
  const topicIndexFull = path.join(book.wikiPath, SOURCES_TOPIC, '_index.md');
  const planTopicIndex = (): { status: 'created' | 'updated' | 'already-listed'; newText: string | null } => {
    const lines = files.map((source) => `- [[${source.page}|${linkLabel(source.rendered.title)}]]`);
    if (!fs.existsSync(topicIndexFull)) return { status: 'created', newText: `# Sources\n\n${lines.join('\n')}\n` };
    let text = fs.readFileSync(topicIndexFull, 'utf8');
    let changed = false;
    for (const source of files) {
      const planned = planTopicIndexLine(text, slug, source.page, source.rendered.title);
      if (planned === 'open-fence') {
        refuse(
          `The topic index shelf/${slug}/wiki/${SOURCES_TOPIC}/_index.md ends inside an unclosed code fence, so a link added at its end ` +
            'would show as code, not a link. Close the fence in the topic index first. Nothing was added.',
        );
      }
      if (planned.newText !== null) {
        text = planned.newText;
        changed = true;
      }
    }
    return changed ? { status: 'updated', newText: text } : { status: 'already-listed', newText: null };
  };
  const topicPlan = planTopicIndex();
  const mapPath = path.join(book.wikiPath, '_index.md');
  const mapIsGenerated = testGeneratedReaderMap(mapPath);
  let owner: { project: string } | null = null;
  let ownerUnread: string | null = null;
  try {
    owner = rawBatchOwner(workspace, inRaw);
  } catch (error) {
    ownerUnread = (error as Error).message;
  }

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Add a batch of source pages to a Shelf Book',
    book: book.bookRoot,
    book_title: book.title,
    batch,
    batch_owner: owner === null ? null : owner.project,
    ...(ownerUnread !== null ? { batch_owner_unread: ownerUnread } : {}),
    pages: files.map((source) => ({ file: source.file, page: `${book.bookRoot}/wiki/${source.page}.md`, page_title: source.rendered.title })),
    page_count: files.length,
    topic_index: topicPlan.status,
    reader_map_action: mapIsGenerated
      ? 'regenerate from the pages on disk'
      : `append the ${SOURCES_TOPIC}/_index link if the map does not reach it; this map is curated, so it is not regenerated`,
    confirmation_required: false,
    shared_library_write: false,
    scope:
      `Creates ${files.length} new page(s) under ${SOURCES_TOPIC}/ in this open Shelf Book, ` +
      `${topicPlan.status === 'created' ? 'creates' : topicPlan.status === 'updated' ? 'adds their lines to' : 'leaves'} the topic index ${SOURCES_TOPIC}/_index.md, ` +
      'updates the reader map, and commits one Discovery manifest generation in the same locked window. Nothing under raw/ is read ' +
      'after this, changed, moved or removed.',
  };
  if (parsed.flags.has('preflight')) return { refusal: null, value: plan };

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  const createdDirectories: string[] = [];
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);
    // Re-checked under the lock: a page named here may have been created while the batch was being read.
    for (const source of files) {
      assertInsideRoot(book.wikiPath, `${source.page}.md`, `shelf/${slug}/wiki`);
      if (fs.existsSync(source.fullPath)) refuse(`shelf/${slug}/wiki/${source.page}.md was created while this batch was being prepared. Nothing was written.`);
    }
    mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Add ${files.length} source page(s) from ${batch}`, lock });
    const topicNow = planTopicIndex();
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Add ${files.length} source page(s) from ${batch}`,
      paths: [...files.map((source) => source.fullPath), mapPath, topicIndexFull],
    }).journalPath;

    let parent = path.join(book.wikiPath, SOURCES_TOPIC);
    while (!fs.existsSync(parent)) {
      createdDirectories.push(parent);
      parent = path.dirname(parent);
    }
    if (createdDirectories.length) fs.mkdirSync(path.join(book.wikiPath, SOURCES_TOPIC), { recursive: true });

    for (const source of files) {
      fs.writeFileSync(source.fullPath, source.rendered.body, { encoding: 'utf8', flag: 'wx' });
      if (readUtf8(source.fullPath) !== source.rendered.body) refuse(`The page was written but did not read back identically: ${book.bookRoot}/wiki/${source.page}.md`);
    }
    if (fromFolderFault() === 'after-pages') refuse('FAULT INJECTED after the pages were written (a real run never reaches this)');
    if (topicNow.newText !== null) {
      writeAtomicText(topicIndexFull, topicNow.newText);
      if (fs.readFileSync(topicIndexFull, 'utf8') !== topicNow.newText) refuse(`The topic index ${SOURCES_TOPIC}/_index.md was written but did not read back identically.`);
    }
    plan['topic_index'] = topicNow.status;

    if (mapIsGenerated) plan['reader_map_pages'] = updateShelfBookIndex(book).pageCount;
    else if (getUnlistedBookPages(book).some((relative) => relative.startsWith(`${SOURCES_TOPIC}/`))) {
      addShelfBookIndexLink(book, `${SOURCES_TOPIC}/_index`, 'Sources');
    }
    // REACHED, NOT LISTED: the root map, or the topic index it links, reaches every new page.
    const unreached = files.filter((source) => getUnlistedBookPages(book).includes(`${source.page}.md`)).map((source) => source.page);
    if (unreached.length) refuse(`The reader map was updated but does not reach ${unreached.join(', ')}.`);

    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback(journalPath, () => {
      for (const directory of createdDirectories) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
    });
    settle(mutation, rollback);
    return { refusal: `The batch was not added. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  plan['status'] = 'added';
  plan['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
  plan['reader_map_unlisted'] = getUnlistedBookPages(book).length;
  plan['journal'] = workspaceRelative(workspace, journalPath!);
  plan['next'] =
    `${batch} is compiled into ${book.bookRoot}/wiki/${SOURCES_TOPIC}/ and is ready to evict` +
    (owner !== null ? ` (its owner is the Project ${owner.project})` : '') +
    '. Nothing under raw/ was deleted: remove the batch folder by hand once nothing else needs it. ' +
    `To record where these pages came from, keep the Book's source list with deskpost book sources ${slug} --set --content-path <json> --preflight.`;
  return { refusal: null, value: plan };
}

/** A test hook, named in the self-test that uses it: where to stop a --from-folder batch after its pages are written. */
function fromFolderFault(): string {
  return (process.env['LIBRARY_BOOK_FROM_FOLDER_FAULT'] ?? '').trim();
}

// --- book sources: the source list -----------------------------------------------------------------

const SOURCES_USAGE =
  'deskpost book sources <slug> [--json]; ' +
  'deskpost book sources <slug> (--set --content-path <list.json> | --mark-compiled --content-path <id-to-sha256.json>) (--preflight | --base-sha256 <current_sha256 or absent>)';

/** The Book's source list file, `shelf/<slug>/_sources.md`, beside `_catalog-entry.md`. */
function sourceListFile(book: ShelfBook): string {
  return path.join(path.dirname(book.wikiPath), SOURCE_LIST_FILE);
}

/** A page of this Book, by its Book-relative path: its canonical form when it exists, else null. */
function bookPageFinder(book: ShelfBook): (page: string) => string | null {
  return (page: string) => {
    let canonical: string;
    try {
      canonical = convertToBookPagePath(page);
    } catch {
      return null;
    }
    const full = path.join(book.wikiPath, ...`${canonical}.md`.split('/'));
    return fs.existsSync(full) && fs.statSync(full).isFile() ? canonical : null;
  };
}

/** The list on disk, validated; refused, naming each problem, when it is there and unreadable. */
function readSourceList(book: ShelfBook, slug: string): { text: string | null; list: SourceList | null } {
  const file = sourceListFile(book);
  if (!fs.existsSync(file)) return { text: null, list: null };
  const text = readUtf8(file);
  const block = sourceListBlock(text);
  const problems = 'problem' in block ? [block.problem] : validateSourceList(block.value, bookPageFinder(book)).problems;
  if (problems.length) {
    refuse(
      `shelf/${slug}/${SOURCE_LIST_FILE} cannot be read as a source list: ${problems.join('; ')}. Replace it whole with ` +
        `deskpost book sources ${slug} --set --content-path <json> --preflight. Nothing was written.`,
    );
  }
  return { text, list: validateSourceList((block as { value: unknown }).value, bookPageFinder(book)).list };
}

/** A JSON file given with --content-path (or --sources-compiled), parsed, or refused by name. */
function readJsonFile(workspace: string, given: string, option: string): unknown {
  const full = resolveContentPath(workspace, given, option);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`${option} ${given} was not found (resolved to ${full}). Nothing was written.`);
  try {
    return JSON.parse(readUtf8(full));
  } catch (error) {
    refuse(`${option} ${given} is not JSON: ${(error as Error).message}. Nothing was written.`);
  }
}

/**
 * The mark `--sources-compiled <file>` makes inside a page replace (D1, D8): the list as it will be written, or a
 * refusal that names `--sources-compiled`. Refused before anything else about the replace, so a Book with no list
 * says so first.
 */
function plannedSourcesMark(workspace: string, book: ShelfBook, slug: string, given: string): { list: SourceList; ids: string[] } {
  if (!fs.existsSync(sourceListFile(book))) {
    refuse(
      `--sources-compiled needs a source list, and shelf/${slug}/${SOURCE_LIST_FILE} does not exist. Create it with ` +
        `deskpost book sources ${slug} --set --content-path <json> --preflight first. Nothing was written.`,
    );
  }
  const map = readCompiledMap(readJsonFile(workspace, given, '--sources-compiled'));
  if (map.marks === null) refuse(`--sources-compiled ${given} is not a map of source id to sha256: ${map.problems.join('; ')}. Nothing was written.`);
  const current = readSourceList(book, slug).list!;
  const marked = markCompiled(current, map.marks, utcStamp());
  if (marked.problems.length) refuse(`--sources-compiled ${given} names a source the list does not hold: ${marked.problems.join('; ')}. Nothing was written.`);
  return { list: marked.list, ids: [...map.marks.keys()] };
}

/**
 * `deskpost book sources <slug>` (kickoffs/s104 row 2; PLAN-correct-and-find.md D8): reads a Shelf Book's source list,
 * seated, with the Book open. `--set` replaces the list whole after validating it, and is the only form that creates
 * the file; `--mark-compiled` records new fingerprints with the UTC instant. Each write is BOUND, NOT APPROVED, as a page
 * replace is: `--preflight` gives the file's `current_sha256` (or `absent`), and the apply requires it as `--base-sha256`,
 * under the Book lock and journal. The list is not a page, so no Discovery generation is committed for it.
 */
function sourcesVerb(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, argumentTable('book', 'sources'));
  const slug = parsed.positional[0] ?? '';
  if (!slug) refuse(`book sources needs a Book slug: ${SOURCES_USAGE}.`);
  if (parsed.positional.length > 1) refuse(`book sources takes one Book slug, not '${parsed.positional.slice(1).join(' ')}': ${SOURCES_USAGE}.`);
  const set = parsed.flags.has('set');
  const mark = parsed.flags.has('mark-compiled');
  if (set && mark) refuse(`book sources takes --set or --mark-compiled, not both: ${SOURCES_USAGE}.`);

  const book = getShelfBook(workspace, slug);
  if (book.isCapture) refuse(`Shelf Book '${slug}' is a capture Book; a source list belongs to a curated Book, whose pages it feeds. Nothing was written.`);
  const file = sourceListFile(book);
  const relative = `${book.bookRoot}/${SOURCE_LIST_FILE}`;

  if (!set && !mark) {
    for (const option of ['content-path', 'base-sha256']) {
      if (parsed.options.has(option) || parsed.flags.has(option)) refuse(`book sources takes --${option} only with --set or --mark-compiled: ${SOURCES_USAGE}.`);
    }
    if (parsed.flags.has('preflight')) refuse(`book sources takes --preflight only with --set or --mark-compiled: ${SOURCES_USAGE}.`);
    assertShelfBookOpen(workspace, slug, 'reading its source list');
    const { text, list } = readSourceList(book, slug);
    return {
      refusal: null,
      value: {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: 'Read a Shelf Book source list',
        book: book.bookRoot,
        book_title: book.title,
        path: relative,
        present: text !== null,
        current_sha256: sourceListSha256(text),
        pin: list === null ? null : list.pin,
        source_count: list === null ? 0 : list.sources.length,
        sources: (list === null ? [] : list.sources) as unknown as PsJsonValue,
        next:
          text === null
            ? `This Book keeps no source list yet. Write one with deskpost book sources ${slug} --set --content-path <json> --preflight.`
            : `Change it with --set (the whole list) or --mark-compiled (new fingerprints), each --preflight first.`,
      },
    };
  }

  const preflight = parsed.flags.has('preflight');
  const base = (parsed.options.get('base-sha256') ?? '').trim().toLowerCase();
  if (preflight === (base !== '')) refuse(`book sources --${set ? 'set' : 'mark-compiled'} needs exactly one of --preflight or --base-sha256 <the preflight's current_sha256>: ${SOURCES_USAGE}.`);
  if (base && base !== ABSENT && !/^[0-9a-f]{64}$/.test(base)) {
    refuse(`--base-sha256 must be the 64 hex characters the preflight gave as current_sha256, or ${ABSENT} for a Book with no source list yet. Nothing was written.`);
  }
  const contentPath = (parsed.options.get('content-path') ?? '').trim();
  if (!contentPath) refuse(`book sources --${set ? 'set' : 'mark-compiled'} needs --content-path <file>: ${SOURCES_USAGE}.`);
  assertShelfBookOpen(workspace, slug, 'changing its source list');

  const verb = set ? '--set' : '--mark-compiled';
  // THE PROPOSED LIST, from the file on disk as it is now. Planned again under the lock.
  const propose = (): { current: string; list: SourceList; marked: string[] } => {
    const onDisk = fs.existsSync(file) ? readUtf8(file) : null;
    const current = sourceListSha256(onDisk);
    const given = readJsonFile(workspace, contentPath, '--content-path');
    if (set) {
      const checked = validateSourceList(given, bookPageFinder(book));
      if (checked.list === null) refuse(`The source list in ${contentPath} is not valid: ${checked.problems.join('; ')}. Nothing was written.`);
      return { current, list: checked.list, marked: [] };
    }
    if (onDisk === null) {
      refuse(`shelf/${slug} has no source list yet, so there is nothing to mark. Create it with deskpost book sources ${slug} --set --content-path <json> --preflight. Nothing was written.`);
    }
    const map = readCompiledMap(given);
    if (map.marks === null) refuse(`${contentPath} is not a map of source id to sha256: ${map.problems.join('; ')}. Nothing was written.`);
    const marked = markCompiled(readSourceList(book, slug).list!, map.marks, utcStamp());
    if (marked.problems.length) refuse(`${contentPath} names a source the list does not hold: ${marked.problems.join('; ')}. Nothing was written.`);
    return { current, list: marked.list, marked: [...map.marks.keys()] };
  };
  const proposed = propose();
  const proposedText = renderSourceList(proposed.list);
  const proposedSha256 = sourceListSha256(proposedText);
  const applyLine = `deskpost book sources ${slug} ${verb} --content-path ${contentPath} --base-sha256 ${proposed.current}`;
  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: set ? 'Replace a Shelf Book source list' : 'Mark sources of a Shelf Book compiled',
    book: book.bookRoot,
    book_title: book.title,
    path: relative,
    current_sha256: proposed.current,
    proposed_sha256: proposedSha256,
    source_count: proposed.list.sources.length,
    ...(mark ? { marked: proposed.marked } : {}),
    confirmation_required: false,
    shared_library_write: false,
    scope:
      `${set ? (proposed.current === ABSENT ? 'Creates' : 'Replaces') : 'Records new fingerprints in'} this open Shelf Book's source list, ` +
      'bound to the file the preflight read and kept in the Book journal. It is not a page, so no page, reader map or Discovery generation changes.',
  };
  if (set && proposed.current !== ABSENT && proposed.current === proposedSha256) {
    plan['status'] = 'unchanged';
    plan['next'] = 'The source list already holds this; nothing was written.';
    return { refusal: null, value: plan };
  }
  if (preflight) {
    plan['next'] = applyLine;
    return { refusal: null, value: plan };
  }
  const stale = `${relative} changed after the preflight (its hash is not --base-sha256), so nothing was written. Run --preflight again.`;
  if (base !== proposed.current) refuse(stale);

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);
    // RE-READ UNDER THE LOCK: the hash check above happened before anyone was excluded, and a mark takes its instant now.
    const now = propose();
    if (now.current !== base) refuse(stale);
    const text = renderSourceList(now.list);
    journalPath = writeBookJournal({ workspace, bookRoot: book.bookRoot, operation: `${set ? 'Set' : 'Mark'} the source list`, paths: [file] }).journalPath;
    writeAtomicText(file, text);
    if (readUtf8(file) !== text) refuse(`The source list was written but did not read back identically: ${relative}`);
    plan['proposed_sha256'] = sourceListSha256(text);
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback(journalPath);
    return { refusal: `The source list was not written. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }
  delete plan['next'];
  plan['status'] = 'written';
  plan['current_sha256'] = plan['proposed_sha256']!;
  delete plan['proposed_sha256'];
  plan['journal'] = workspaceRelative(workspace, journalPath!);
  plan['next'] = `Read it with deskpost book sources ${slug}.`;
  return { refusal: null, value: plan };
}

// --- book replace-page -----------------------------------------------------------------------------

const REPLACE_PAGE_USAGE =
  'deskpost book replace-page <slug> <page> --content-path <file> [--sources-compiled <id-to-sha256.json>] (--preflight | --base-sha256 <the preflight\'s current_sha256>)';

/** A test hook, named in the self-test that uses it: where to stop a replace after its journal is written. */
function replacePageFault(): string {
  return (process.env['LIBRARY_BOOK_REPLACE_PAGE_FAULT'] ?? '').trim();
}

/**
 * `deskpost book replace-page <slug> <page> --content-path <file> (--preflight | --base-sha256 <h>)` (ADR-0070, D1).
 *
 * BOUND, NOT APPROVED (the reader's Q1): the preflight returns the page's hash and the apply requires it, so a write is
 * never blind to the page it replaces, and the previous text is kept twice, in the journal and as a restore file beside
 * it. No yes is asked: the Book is this seat's working copy, open on its Desk, and the restore is one command away.
 */
function replacePage(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, argumentTable('book', 'replace-page'));
  const slug = parsed.positional[0] ?? '';
  const pagePath = parsed.positional[1] ?? '';
  if (!slug || !pagePath) refuse(`book replace-page needs a Book slug and a page path: ${REPLACE_PAGE_USAGE}.`);
  if (parsed.flags.has('sources-compiled')) refuse('--sources-compiled needs a file: a JSON map of source id to sha256. Nothing was written.');
  const sourcesCompiled = (parsed.options.get('sources-compiled') ?? '').trim();
  if (parsed.options.has('body') || parsed.flags.has('body')) refuse(`book replace-page takes its text from --content-path only: ${REPLACE_PAGE_USAGE}.`);
  if (parsed.options.has('title') || parsed.flags.has('title')) {
    refuse('book replace-page takes no --title: the page keeps or changes its own H1 in the text you give. Nothing was written.');
  }
  const preflight = parsed.flags.has('preflight');
  const base = (parsed.options.get('base-sha256') ?? '').trim().toLowerCase();
  if (preflight === (base !== '')) {
    refuse(`book replace-page needs exactly one of --preflight or --base-sha256 <the preflight's current_sha256>: ${REPLACE_PAGE_USAGE}.`);
  }
  if (base && !/^[0-9a-f]{64}$/.test(base)) refuse('--base-sha256 must be the 64 hex characters the preflight gave as current_sha256. Nothing was written.');

  let book: ReturnType<typeof getShelfBook>;
  try {
    book = getShelfBook(workspace, slug);
  } catch (error) {
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && isLocalBackend(workspace) && collectionBookSlugs(workspace, 'active').includes(slug)) {
      refuse(`'${slug}' is a Book in this Library's own collection, not on the Shelf. Nothing was written.`);
    }
    throw error;
  }
  if (book.isCapture) {
    refuse(`Shelf Book '${slug}' is a capture Book; its notes have their own writers. book replace-page corrects a page of a curated Book. Nothing was written.`);
  }
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  assertShelfBookOpen(workspace, slug, 'correcting a page of it');

  const page = convertToBookPagePath(pagePath);
  const relative = `${page}.md`;
  const fullPath = path.join(book.wikiPath, ...relative.split('/'));
  assertInsideRoot(book.wikiPath, relative, `shelf/${slug}/wiki`);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    refuse(`shelf/${slug}/wiki/${relative} does not exist, so there is nothing to correct. Add a new page with deskpost book add-page ${slug} ${page} --content-path <file>.`);
  }
  // THE SOURCE LIST'S MARK (D1, D8), checked before anything else about the write, so a Book with no list says so first.
  const sourcesPlan = sourcesCompiled ? plannedSourcesMark(workspace, book, slug, sourcesCompiled) : null;

  const contentPath = parsed.options.get('content-path');
  if (contentPath === undefined || !contentPath.trim()) refuse(`book replace-page needs --content-path <file>: ${REPLACE_PAGE_USAGE}.`);
  const { body } = resolveBody(workspace, contentPath, undefined, 'page');
  if (!body.trim()) refuse('The page body is empty; nothing was written.');
  const rendered = renderPageBody(body, '');

  const currentText = readUtf8(fullPath);
  const currentSha256 = pageComparisonSha256(fs.readFileSync(fullPath, 'utf8'));
  const proposedSha256 = pageComparisonSha256(rendered.body);
  const titleBefore = readerMapLabel(currentText, relative);
  const titleAfter = rendered.title;
  const mapPath = path.join(book.wikiPath, '_index.md');
  const mapIsGenerated = testGeneratedReaderMap(mapPath);
  const counts = changeCounts(currentText.replace(/\r\n/g, '\n'), rendered.body.replace(/\r\n/g, '\n'));
  const lineCount = (text: string) => (text.replace(/\r\n/g, '\n').replace(/\n$/, '') === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length);
  const applyLine =
    `deskpost book replace-page ${slug} ${page} --content-path ${contentPath}` +
    (sourcesPlan !== null ? ` --sources-compiled ${sourcesCompiled}` : '') +
    ` --base-sha256 ${currentSha256}`;

  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Replace a page of a Shelf Book',
    book: book.bookRoot,
    book_title: book.title,
    page: `${book.bookRoot}/wiki/${relative}`,
    current_sha256: currentSha256,
    proposed_sha256: proposedSha256,
    current_lines: lineCount(currentText),
    proposed_lines: lineCount(rendered.body),
    added_lines: counts.added_lines,
    removed_lines: counts.removed_lines,
    title_before: titleBefore,
    title_after: titleAfter,
    reader_map: mapIsGenerated ? 'regenerated' : 'curated: unchanged',
    ...(sourcesPlan !== null ? { sources_compiled: sourcesPlan.ids } : {}),
    confirmation_required: false,
    shared_library_write: false,
    scope:
      (sourcesPlan !== null ? `Marks ${sourcesPlan.ids.length} source(s) of shelf/${slug}/${SOURCE_LIST_FILE} compiled in the same write. ` : '') +
      'Replaces the text of one existing page of this open Shelf Book, bound to the page the preflight read: the previous ' +
      'text is kept in the Book journal and as a restore file beside it, a generated reader map is regenerated (a curated ' +
      'one is left alone), and a new Discovery manifest generation is committed in the same locked window.',
  };

  if (currentSha256 === proposedSha256) {
    plan['status'] = 'unchanged';
    plan['next'] =
      'The page already holds this text; nothing was written' +
      (sourcesPlan !== null ? `, and no source was marked. Mark them with deskpost book sources ${slug} --mark-compiled --content-path ${sourcesCompiled} --preflight.` : '.');
    return { refusal: null, value: plan };
  }
  if (preflight) {
    plan['next'] = applyLine;
    return { refusal: null, value: plan };
  }
  if (base !== currentSha256) {
    refuse(`shelf/${slug}/wiki/${relative} changed after the preflight (its hash is not --base-sha256), so nothing was written. Run --preflight again.`);
  }

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let previousPath: string | null = null;
  let mutation: BookMutation | null = null;
  const reachedBefore = !getUnlistedBookPages(book).includes(relative);
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);

    // RE-READ UNDER THE LOCK: the hash check above happened before anyone was excluded.
    assertInsideRoot(book.wikiPath, relative, `shelf/${slug}/wiki`);
    if (!fs.existsSync(fullPath) || pageComparisonSha256(fs.readFileSync(fullPath, 'utf8')) !== base) {
      refuse(`shelf/${slug}/wiki/${relative} changed after the preflight (its hash is not --base-sha256), so nothing was written. Run --preflight again.`);
    }

    // The mark planned again under the lock: the list may have changed, and the instant is now.
    const sourcesNow = sourcesCompiled ? plannedSourcesMark(workspace, book, slug, sourcesCompiled) : null;
    const listFile = sourceListFile(book);
    mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Replace page ${relative}`, lock });
    journalPath = writeBookJournal({
      workspace,
      bookRoot: book.bookRoot,
      operation: `Replace page ${relative}`,
      paths: [fullPath, mapPath, ...(sourcesNow !== null ? [listFile] : [])],
    }).journalPath;
    // THE RESTORE FILE: the previous page's own bytes, `.txt` so Obsidian indexes no second copy of the page.
    previousPath = journalPath.replace(/\.json$/, '') + '.previous.txt';
    fs.writeFileSync(previousPath, fs.readFileSync(fullPath), { flag: 'wx' });

    if (replacePageFault() === 'after-journal') refuse('FAULT INJECTED after the journal was written (a real run never reaches this)');
    // ATOMIC: outside the journal, the page is the only copy of its text.
    writeAtomicText(fullPath, rendered.body);
    if (readUtf8(fullPath) !== rendered.body) refuse(`The page was written but did not read back identically: ${book.bookRoot}/wiki/${relative}`);
    if (sourcesNow !== null) {
      const listText = renderSourceList(sourcesNow.list);
      writeAtomicText(listFile, listText);
      if (readUtf8(listFile) !== listText) refuse(`The source list was written but did not read back identically: ${book.bookRoot}/${SOURCE_LIST_FILE}`);
      plan['sources_compiled'] = sourcesNow.ids;
    }
    if (replacePageFault() === 'after-write') refuse('FAULT INJECTED after the page was written (a real run never reaches this)');

    // A generated map is regenerated, so a changed H1 changes its label; a curated one is a reader's and is left alone.
    if (mapIsGenerated) updateShelfBookIndex(book);
    if (reachedBefore && getUnlistedBookPages(book).includes(relative)) {
      refuse(`The reader map no longer reaches ${relative} after the replace.`);
    }

    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback(journalPath, () => {
      if (previousPath !== null && fs.existsSync(previousPath)) fs.rmSync(previousPath);
    });
    settle(mutation, rollback);
    return { refusal: `The page was not replaced. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  const previousRelative = workspaceRelative(workspace, previousPath!);
  delete plan['next'];
  plan['status'] = 'written';
  plan['journal'] = workspaceRelative(workspace, journalPath!);
  plan['previous_body_path'] = previousRelative;
  plan['title_changed'] = titleBefore !== titleAfter;
  plan['restore'] = `deskpost book replace-page ${slug} ${page} --content-path ${previousRelative} --base-sha256 ${proposedSha256}`;
  plan['next'] = 'The Book is open; read the corrected page with mcp__validated-book-reader__read_open_book_page. To undo, run the restore line.';
  return { refusal: null, value: plan };
}

// --- book reader-map -------------------------------------------------------------------------------

const READER_MAP_USAGE = 'deskpost book reader-map <slug>';

/**
 * `deskpost book reader-map <slug>` (D4): the generated reader map of a curated Shelf Book open on this seat's Desk,
 * built again by the folding rule, so an existing Book's topic pages fold under their topic index as a new page's do.
 *
 * UNGATED, because the map is derived: it is rebuilt from the pages on disk and a curated map is refused, never
 * rewritten. Under the Book's lock and journal, with a Discovery manifest generation in the same window, since the map is
 * part of the page digest Discovery compares. A map that would leave a page unreached is rolled back. `shelf rebuild`
 * is unchanged: it writes manifests only.
 */
function readerMapVerb(argv: string[], workspace: string): WriterResult {
  const parsed = parseArguments(argv, argumentTable('book', 'reader-map'));
  const slug = parsed.positional[0] ?? '';
  if (!slug) refuse(`book reader-map needs a Book slug: ${READER_MAP_USAGE}.`);
  if (parsed.positional.length > 1) refuse(`book reader-map takes one Book slug, not '${parsed.positional.slice(1).join(' ')}': ${READER_MAP_USAGE}. Nothing was written.`);
  if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && fs.existsSync(archiveRecordPath(workspace, slug))) {
    refuse(`Shelf Book '${slug}' is archived. Restore it with deskpost shelf restore ${slug} first. Nothing was written.`);
  }
  const book = getShelfBook(workspace, slug);
  if (book.isCapture) refuse(`Shelf Book '${slug}' is a capture Book; its map is its notes' own. book reader-map rebuilds a curated Book's map. Nothing was written.`);
  if (!fs.existsSync(book.wikiPath)) refuse(`Shelf Book '${slug}' has no pages directory at shelf/${slug}/wiki.`);
  assertShelfBookOpen(workspace, slug, 'rebuilding its reader map');
  const mapPath = path.join(book.wikiPath, '_index.md');
  const mapRelative = `${book.bookRoot}/wiki/_index.md`;
  if (!testGeneratedReaderMap(mapPath)) {
    refuse(`${mapRelative} is curated (a line in it is not a heading or a bare link), so it is a reader's and is never rebuilt. Fold its topics by hand. Nothing was written.`);
  }

  const built = shelfBookIndexText(book);
  const plan: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: "Rebuild a Shelf Book's reader map",
    book: book.bookRoot,
    book_title: book.title,
    reader_map: mapRelative,
    reader_map_pages: built.pageCount,
    folded_topics: built.foldedTopics,
  };
  if (fs.existsSync(mapPath) && readUtf8(mapPath) === built.text) {
    plan['status'] = 'unchanged';
    plan['reader_map_unlisted'] = getUnlistedBookPages(book).length;
    plan['next'] = 'The reader map is already built by the folding rule; nothing was written.';
    return { refusal: null, value: plan };
  }

  let lock: BookLock | null = null;
  let journalPath: string | null = null;
  let mutation: BookMutation | null = null;
  try {
    lock = enterBookLock(workspace, book.bookRoot, LOCK_TIMEOUT_SECONDS);
    // RE-READ UNDER THE LOCK: a page added since the text above was built is in the map written.
    if (!testGeneratedReaderMap(mapPath)) refuse(`${mapRelative} became curated before the lock was taken. Nothing was written.`);
    const unlistedBefore = getUnlistedBookPages(book).length;
    mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: 'Rebuild the reader map', lock });
    journalPath = writeBookJournal({ workspace, bookRoot: book.bookRoot, operation: 'Rebuild the reader map', paths: [mapPath] }).journalPath;
    const written = shelfBookIndexText(book);
    writeUtf8(mapPath, written.text);
    if (readUtf8(mapPath) !== written.text) refuse(`The reader map was written but did not read back identically: ${mapRelative}`);
    const unlistedAfter = getUnlistedBookPages(book).length;
    if (unlistedAfter > unlistedBefore) refuse(`The rebuilt map reaches fewer pages (${unlistedAfter} unreached, ${unlistedBefore} before)`);
    plan['reader_map_pages'] = written.pageCount;
    plan['folded_topics'] = written.foldedTopics;
    plan['reader_map_unlisted'] = unlistedAfter;
    plan['manifest'] = completeBookMutation(mutation).summary;
    mutation = null;
  } catch (error) {
    const failure = (error as Error).message;
    const rollback = runRollback(journalPath);
    settle(mutation, rollback);
    return { refusal: `The reader map was not rebuilt. ${failure}. Rollback: ${rollback}.`, value: null };
  } finally {
    exitBookLock(lock);
  }

  plan['status'] = 'written';
  plan['journal'] = workspaceRelative(workspace, journalPath!);
  plan['next'] = `Read the map with mcp__validated-book-reader__read_open_book_page (${slug}, _index).`;
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
  const parsed = parseArguments(argv, argumentTable('book', 'graduate'));
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
    if (action === 'replace-page') return replacePage(argv.slice(1), workspace);
    if (action === 'reader-map') return readerMapVerb(argv.slice(1), workspace);
    if (action === 'sources') return sourcesVerb(argv.slice(1), workspace);
    if (action === 'graduate') return graduate(argv.slice(1), workspace);
    return { refusal: `library book has no action '${action}'. It has: add-page, graduate, reader-map, replace-page, sources.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
