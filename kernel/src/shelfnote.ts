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
  };
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
 * addressed to it. Counts only, as everything a closed Book says on the Desk.
 */
export function growingState(book: ShelfBook, notes: ShelfNoteRow[], seat: string | null, now: number = Date.now()): { growing: boolean; mayClose: number } {
  const pending = notes.filter((note) => note.review !== 'done');
  const threshold = book.growingPending ?? DEFAULT_GROWING_PENDING;
  const days = book.growingDays ?? DEFAULT_GROWING_DAYS;
  const ages = pending.map((note) => Date.parse(note.captured)).filter((time) => Number.isFinite(time));
  const oldest = ages.length ? Math.min(...ages) : null;
  const growing = pending.length > threshold || (oldest !== null && now - oldest > days * 86_400_000);
  const mayClose = (book.closedBy ?? 'any') === 'any'
    ? pending.length
    : pending.filter((note) => !note.fromSeat || (seat !== null && (note.fromSeat === seat || note.forSeat === seat))).length;
  return { growing, mayClose };
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
  note: Pick<ShelfNoteRow, 'page' | 'fromSeat' | 'forSeat'>,
  book: { slug: string; closedBy: ClosedBy },
  seat: string | null,
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
  if (seat !== null && (note.fromSeat === seat || note.forSeat === seat)) return;
  if (otherSeat === note.fromSeat) return;
  refuse(
    `${note.page} in Book '${book.slug}' was written by seat '${note.fromSeat}', and in this Book a seat closes only its own notes. To sort it at the reader's ask, add "other_seat": "${note.fromSeat}" to the action.`,
  );
}
