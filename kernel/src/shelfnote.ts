/**
 * One reader for a capture Book's notes, the one frontmatter writer beside it, and the seat rule.
 *
 * ONE READER, NOT SIX (PLAN-holding-discipline.md, row 0). Triage, capture, the manifest, the triage
 * inventory, `shelf carry` and the Shelf writers each parsed note frontmatter with their own regex, and
 * they did not agree: five matched `review:` anywhere in the file, body included, and one of those let
 * `\s*` run past the end of an empty `review:` line into the next. This reader takes the manifest's
 * rule, which is the oracle's (`Get-NoteFrontmatter` in `ShelfNoteCommon.ps1`): only the leading
 * `---` block is frontmatter, a block with no closing `---` is none, and a blank value is an absent
 * one.
 *
 * A LEAF MODULE ON PURPOSE. `triage.ts` -> `triagebatch.ts` -> `capture.ts` -> `desk.ts` already chain,
 * and `argv.ts` records what an import cycle costs here, so this file imports only `shelfbook.ts`.
 * The seat-rule predicate lives here for the same reason: `resolveNoteSource` (triage) and
 * `captureVerb` (`--supersedes`) both call it, and `capture.ts` cannot import from `triage.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GROWING_DAYS, DEFAULT_GROWING_PENDING, readUtf8, type ClosedBy, type ShelfBook } from './shelfbook.ts';

export type { ClosedBy };

export interface ShelfNoteRow {
  file: string;
  page: string;
  fullPath: string;
  title: string;
  captured: string;
  review: string;
  /** Provenance and the discipline fields. Null when the note does not carry the line. */
  reviewed: string | null;
  fromSeat: string | null;
  forSeat: string | null;
  why: string | null;
  filedTo: string | null;
  supersededBy: string | null;
  supersedes: string | null;
  /** A letter's department and the incarnations at both ends (kickoffs/s98 row 0). Null when the note has no line. */
  forDepartment: string | null;
  forSeatId: string | null;
  originSeat: string | null;
  originSeatId: string | null;
  /** The links that close a letter (kickoffs/s98 row 3): the reply that answered it, the letter that routed it on. */
  answeredBy: string | null;
  routedTo: string | null;
  /** The letter a reply answers (kickoffs/s98 row 1). */
  answers: string | null;
  /** The letter a routed one came from, and how many routes it has taken, 0 to 3 (kickoffs/s98 row 2). */
  routedFrom: string | null;
  hops: number | null;
  /**
   * The reserved keys this note carries twice, or with a value of the wrong shape (`malformedNoteKeys`), sorted; empty
   * for a well-formed note. Display is tolerant and mutation strict: a malformed address reaches no seat.
   */
  malformed: string[];
}

/**
 * WHY A HOLDING NOTE IS THERE, AS A CLOSED CATEGORY (plan row 3, Q3): recorded by `capture --why`, never required,
 * and counted on the Desk. Closed so that a count carries no writer-typed text out of a closed Book.
 */
export const WHY_CATEGORIES = ['no-seat', 'no-home', 'needs-yes', 'reset-imminent', 'for-seat'] as const;

/** The refusal for a malformed `--why`, said the same way by every writer that takes one. */
export function whyRefusal(value: string): string | null {
  return (WHY_CATEGORIES as readonly string[]).includes(value) ? null : `--why must be one of: ${WHY_CATEGORIES.join(', ')}; '${value}' is not one.`;
}

/** The flat `key: value` pairs of a leading frontmatter block, or an empty map when there is none. */
export function noteFrontmatter(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 2 || lines[0]!.trim() !== '---') return fields;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') return fields;
    const match = /^([a-z_]+):\s*(.*)$/.exec(lines[index]!);
    if (match) fields.set(match[1]!, match[2]!.trim());
  }
  return new Map();
}

/**
 * EVERY KEY A WRITER OF THIS LIBRARY PUTS IN A NOTE'S FRONTMATTER (kickoffs/s98 row 0; PLAN-seats-team.md session 3
 * items 0 and 2). One of them twice makes the note MALFORMED rather than taking the later copy, as `noteFrontmatter`
 * does for every caller that only displays a note: a hand edit that appends a second `for_seat:` must not quietly move
 * a letter. A key no writer here uses is the note's own business.
 */
export const RESERVED_NOTE_KEYS: readonly string[] = [
  'captured',
  'review',
  'reviewed',
  'from_seat',
  'from_seat_source',
  'session_id',
  'for_seat',
  'source_project',
  'source_paths',
  'tags',
  'why',
  'filed_to',
  'supersedes',
  'superseded_by',
  'for_department',
  'for_seat_id',
  'origin_seat',
  'origin_seat_id',
  'answers',
  'answered_by',
  'routed_to',
  'routed_from',
  'hops',
];

const NOTE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const NOTE_LINK = /^notes\/[^/\s]+$/;
/** The fields whose value has a shape (plan session 3 item 2): a value that does not fit it makes the note malformed. */
const FIELD_SHAPES: Record<string, RegExp> = {
  for_seat_id: /^[0-9a-f]{32}$/,
  origin_seat_id: /^[0-9a-f]{32}$/,
  origin_seat: NOTE_SLUG,
  for_department: NOTE_SLUG,
  answers: NOTE_LINK,
  answered_by: NOTE_LINK,
  routed_to: NOTE_LINK,
  routed_from: NOTE_LINK,
  hops: /^[0-3]$/,
};

/**
 * The reserved keys a note's leading frontmatter carries twice, or with a value of the wrong shape, sorted. Read from
 * the same block `noteFrontmatter` reads; a blank value is an absent one, as there. Empty for a well-formed note.
 */
export function malformedNoteKeys(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 2 || lines[0]!.trim() !== '---') return [];
  const seen = new Set<string>();
  const bad = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') return [...bad].sort();
    const match = /^([a-z_]+):\s*(.*)$/.exec(lines[index]!);
    if (!match || !RESERVED_NOTE_KEYS.includes(match[1]!)) continue;
    const key = match[1]!;
    if (seen.has(key)) bad.add(key);
    seen.add(key);
    const value = match[2]!.trim();
    const shape = FIELD_SHAPES[key];
    if (value !== '' && shape !== undefined && !shape.test(value)) bad.add(key);
  }
  return [];
}

/**
 * A SEAT'S NAME AS A PAGE MAY REPEAT IT (the letter preface's rule, kickoffs/s79 row 1; shared with `--routes`' provenance
 * line, kickoffs/s98 row 2): a slug in a code span, else a placeholder. A value that is not a slug is never repeated, so
 * a line that frames a writer's text cannot carry that text.
 */
export function seatNameForText(value: string | null | undefined): string {
  return value && NOTE_SLUG.test(value) ? `\`${value}\`` : value && value.trim() ? '(not a seat name)' : '(none recorded)';
}

/** A seat as the recipient rule sees it: its slug and its registry row's `seat_id` ('' for a pre-identity row). */
export interface SeatIncarnation {
  seat: string;
  seatId: string;
}

/**
 * THE ONE RECIPIENT PREDICATE (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0; Risks, "What a stale delivery
 * means"). A note is addressed to a registry row when its `for_seat` names the row's seat and, WHEN THE NOTE CARRIES A
 * `for_seat_id`, that id is the row's `seat_id`: a letter written to an earlier incarnation of a slug is not the new
 * one's. A letter with no `for_seat_id`, whenever it was written, matches by slug alone (the legacy rule). A note whose
 * `for_seat` or `for_seat_id` is malformed reaches no seat: its address is not guessed. The Desk's counts, `seat cards`,
 * the close rule and the "may close" count all ask this, and nothing else compares a recipient.
 */
export function isAddressedTo(note: Pick<ShelfNoteRow, 'forSeat' | 'forSeatId' | 'malformed'>, row: SeatIncarnation | null): boolean {
  if (row === null || !note.forSeat || note.forSeat !== row.seat) return false;
  if (note.malformed.includes('for_seat') || note.malformed.includes('for_seat_id')) return false;
  return note.forSeatId === null || note.forSeatId === row.seatId;
}

function valueOr(fields: Map<string, string>, key: string, fallback: string): string {
  const value = fields.get(key);
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

function valueOrNull(fields: Map<string, string>, key: string): string | null {
  const value = fields.get(key);
  return value !== undefined && value.trim() !== '' ? value : null;
}

/** One note's row, from its file name and its text. Bodies are never returned. */
export function parseShelfNote(name: string, fullPath: string, content: string): ShelfNoteRow {
  const fields = noteFrontmatter(content);
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content);
  const base = name.replace(/\.md$/i, '');
  return {
    file: name,
    page: `notes/${base}`,
    fullPath,
    title: heading ? heading[1]!.trim() : base,
    captured: valueOr(fields, 'captured', 'unknown'),
    review: valueOr(fields, 'review', 'pending'),
    reviewed: valueOrNull(fields, 'reviewed'),
    fromSeat: valueOrNull(fields, 'from_seat'),
    forSeat: valueOrNull(fields, 'for_seat'),
    why: valueOrNull(fields, 'why'),
    filedTo: valueOrNull(fields, 'filed_to'),
    supersededBy: valueOrNull(fields, 'superseded_by'),
    supersedes: valueOrNull(fields, 'supersedes'),
    forDepartment: valueOrNull(fields, 'for_department'),
    forSeatId: valueOrNull(fields, 'for_seat_id'),
    originSeat: valueOrNull(fields, 'origin_seat'),
    originSeatId: valueOrNull(fields, 'origin_seat_id'),
    answeredBy: valueOrNull(fields, 'answered_by'),
    routedTo: valueOrNull(fields, 'routed_to'),
    answers: valueOrNull(fields, 'answers'),
    routedFrom: valueOrNull(fields, 'routed_from'),
    hops: /^[0-3]$/.test(fields.get('hops') ?? '') ? Number(fields.get('hops')) : null,
    malformed: malformedNoteKeys(content),
  };
}

/** What a letter's state reads as: worked out from `review` and its closing links, never stored. */
export type LetterStatus = 'open' | 'answered' | 'routed' | 'closed';

/**
 * A LETTER'S STATUS, WORKED OUT AND NEVER STORED (kickoffs/s98 row 3; PLAN-seats-team.md session 3 item 3; Key decision
 * 2). `pending` is open; `done` with `answered_by` is answered; `done` with `routed_to` is routed; `done` alone is closed.
 * `review` keeps its two values, so every pending-or-done filter stands and `docs/cross-seat-reports.md` holds. A note
 * reopened by triage keeps its links as history and reads open. A malformed note (`malformedNoteKeys`) reads from
 * `review` alone, with no links: display is tolerant, while answering and routing refuse it.
 */
export function letterStatus(note: Pick<ShelfNoteRow, 'review' | 'answeredBy' | 'routedTo' | 'malformed'>): LetterStatus {
  if (note.review !== 'done') return 'open';
  if (note.malformed.length) return 'closed';
  if (note.answeredBy) return 'answered';
  if (note.routedTo) return 'routed';
  return 'closed';
}

/** Every note directly under a capture Book's `notes/`, sorted by file name. */
export function shelfNotes(book: ShelfBook): ShelfNoteRow[] {
  if (!fs.existsSync(book.notesPath) || !fs.statSync(book.notesPath).isDirectory()) return [];
  return fs
    .readdirSync(book.notesPath, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md'))
    .map((item) => item.name)
    .sort()
    .map((name) => {
      const fullPath = path.join(book.notesPath, name);
      return parseShelfNote(name, fullPath, readUtf8(fullPath));
    });
}

/**
 * Sets, replaces or (with `null`) removes one `key:` line inside the leading frontmatter block, and
 * touches nothing else. A new line goes just before the closing `---`, in the block's own line
 * ending. Text with no frontmatter block comes back unchanged, so a caller can tell by equality.
 * The oracle gets its twin in `ShelfNoteCommon.ps1` when it first writes one of these fields, and
 * the twin places a line the same way, so a note both arms close hashes the same.
 */
export function setNoteField(content: string, key: string, value: string | null): string {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`Not a frontmatter key: '${key}'.`);
  const opening = /^---[ \t]*(\r?\n)/.exec(content);
  if (!opening) return content;
  const eol = opening[1]!;
  const lines = content.split('\n');
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.replace(/\r$/, '').trim() === '---') {
      close = index;
      break;
    }
  }
  if (close < 0) return content;
  const keyLine = new RegExp(`^${key}:`);
  const at = lines.slice(1, close).findIndex((line) => keyLine.test(line));
  const cr = eol === '\r\n' ? '\r' : '';
  if (at >= 0) {
    if (value === null) lines.splice(at + 1, 1);
    else lines[at + 1] = `${key}: ${value}${cr}`;
  } else if (value !== null) {
    lines.splice(close, 0, `${key}: ${value}${cr}`);
  }
  return lines.join('\n');
}


/**
 * WHETHER A CAPTURE BOOK IS GROWING (S77 row 2, plan row 6): more pending notes than its threshold, or an oldest
 * pending note older than its age, from the Book's own `Growing at:` line or the defaults. `mayClose` counts the pending
 * notes this seat may close under the seat rule: every one in an `any` Book, else its own, the seatless ones, and those
 * addressed to it by the recipient predicate (`isAddressedTo`). Counts only, as everything a closed Book says on the Desk.
 */
export function growingState(book: ShelfBook, notes: ShelfNoteRow[], seat: SeatIncarnation | null, now: number = Date.now()): { growing: boolean; mayClose: number } {
  const pending = notes.filter((note) => note.review !== 'done');
  const threshold = book.growingPending ?? DEFAULT_GROWING_PENDING;
  const days = book.growingDays ?? DEFAULT_GROWING_DAYS;
  const ages = pending.map((note) => Date.parse(note.captured)).filter((time) => Number.isFinite(time));
  const oldest = ages.length ? Math.min(...ages) : null;
  const growing = pending.length > threshold || (oldest !== null && now - oldest > days * 86_400_000);
  const mayClose = (book.closedBy ?? 'any') === 'any'
    ? pending.length
    : pending.filter((note) => !note.fromSeat || (seat !== null && (note.fromSeat === seat.seat || isAddressedTo(note, seat)))).length;
  return { growing, mayClose };
}

/**
 * A STUCK LETTER (kickoffs/s99 row 4, ruling 2; PLAN-seats-team.md session 3 item 4): a pending letter to a department
 * (it carries `for_department`; a route of one keeps it) whose `captured` is older than ITS OWN Book's `Growing at` age,
 * read as `growingState` reads it. A `captured` that does not parse is never stuck, and a malformed letter is not
 * counted. A direct `--for` letter is never stuck: it is its recipient's own pending count (the plan's Risks).
 */
export function isStuckLetter(
  note: Pick<ShelfNoteRow, 'review' | 'captured' | 'forDepartment' | 'malformed'>,
  book: Pick<ShelfBook, 'growingDays'>,
  now: number = Date.now(),
): boolean {
  if (note.review === 'done' || !note.forDepartment || note.malformed.length) return false;
  const time = Date.parse(note.captured);
  return Number.isFinite(time) && now - time > (book.growingDays ?? DEFAULT_GROWING_DAYS) * 86_400_000;
}

/**
 * THE SEAT A LETTER STARTED FROM (kickoffs/s99 row 4, ruling 2): its `origin_seat`, and, where the note carries an
 * `origin_seat_id`, that id is the row's `seat_id`; a letter with no `origin_seat` (written before 1.3.8) by its
 * `from_seat`. A route copies its original's origin, so it stays the first asker's and never becomes the router's. A
 * malformed letter started from no seat.
 */
export function isStartedBy(note: Pick<ShelfNoteRow, 'fromSeat' | 'originSeat' | 'originSeatId' | 'malformed'>, row: SeatIncarnation | null): boolean {
  if (row === null || note.malformed.length) return false;
  if (note.originSeat !== null) return note.originSeat === row.seat && (note.originSeatId === null || note.originSeatId === row.seatId);
  return note.fromSeat === row.seat;
}

/**
 * THE SEAT RULE, stated once (plan row 4). In a `writer` Book a seat may close, reopen or delete only a
 * note it wrote, a note with no `from_seat` (a seatless capture), or a message whose `for_seat` names
 * it. An `any` Book (the Report Inbox) lets any seat. The reader's override is an action's
 * `other_seat`, which must name the note's writer: a WRONG one is refused everywhere, and a correct
 * but unneeded one is accepted, so a script has one shape. The caller's own `refuse` raises the
 * refusal, so each verb reports it the way it reports every other.
 */
export function assertSeatMayClose(
  note: Pick<ShelfNoteRow, 'page' | 'fromSeat' | 'forSeat' | 'forSeatId' | 'malformed'>,
  book: { slug: string; closedBy: ClosedBy },
  seat: SeatIncarnation | null,
  otherSeat: string | null,
  refuse: (message: string) => never,
): void {
  if (otherSeat !== null && otherSeat !== note.fromSeat) {
    const writer = note.fromSeat ? `seat '${note.fromSeat}'` : 'no seat (a seatless capture)';
    refuse(
      `other_seat '${otherSeat}' does not name the writer of ${note.page} in Book '${book.slug}', which was written by ${writer}. Remove other_seat, or name the writing seat.`,
    );
  }
  if (book.closedBy === 'any') return;
  if (!note.fromSeat) return;
  // ITS RECIPIENT BY THE ONE PREDICATE (kickoffs/s98 row 0): a letter to an earlier incarnation of this slug is not its.
  if (seat !== null && (note.fromSeat === seat.seat || isAddressedTo(note, seat))) return;
  if (otherSeat === note.fromSeat) return;
  refuse(
    `${note.page} in Book '${book.slug}' was written by seat '${note.fromSeat}', and in this Book a seat closes only its own notes. To sort it at the reader's ask, add "other_seat": "${note.fromSeat}" to the action.`,
  );
}
