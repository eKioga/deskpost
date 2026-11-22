/**
 * `deskpost hub status <slug>`: a Hub's live state, built from the program's own records every time it is asked
 * (PLAN-hub-redesign.md section 2; kickoffs/s213 rows 17 to 20). Nothing it shows is written into the Hub, so it never
 * needs tidying.
 *
 * WHAT IT SHOWS, each line naming the record it came from:
 *   - each train id, `kickoffs/` id and letter path named in the Hub's `## Now` and `## Next`, with its state now, and
 *     `closed: tick or close this item` when an unticked item closes on that record (no closing condition, or one naming it);
 *   - this Hub's pending Run pointers, in queue order;
 *   - the Library train, labelled as the Library's: the one open car, if any, and the first five open items in register
 *     order with their recorded place. The register has no owner per seat (`train.ts`), so no lane grouping and no claim
 *     that the items are this seat's (HR-03, HR-07);
 *   - the needs-you lines whose seat owns this Hub;
 *   - this Hub's page sizes (`hubpages.ts`).
 *
 * IT READS ONLY WHAT THE CALLER'S DESK ALLOWS (HR-02). A Hub not open on this seat's Desk is one line
 * `<source>: closed on this Desk`; with the `letters` Book closed, letters are a count and the oldest date only. Another
 * Hub's Run pointer appears only when this Hub's items name its id and that Hub is open; authorship is never inferred
 * (HR-06). A source that cannot be read is one line naming it, never a refusal of the whole view.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSeatRegistry } from './desk.ts';
import { nextShownLines, removeFrontmatter, sectionSpan, shownText, toLines } from './hubedit.ts';
import { hubPages } from './hubpages.ts';
import { readNeedsYou } from './needsyou.ts';
import type { PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { getShelfBook } from './shelfbook.ts';
import { shelfNotes } from './shelfnote.ts';
import { frontCar, readTrain } from './train.ts';

/** The terminal view's width: Eric's terminal drawings are about 69 columns. */
export const STATUS_WIDTH = 69;

export interface StatusLine {
  /** The block the line belongs to. */
  group: 'hub' | 'pointers' | 'queue' | 'train' | 'letters' | 'needs-you' | 'pages';
  /** The record the line came from. */
  source: string;
  text: string;
}

const GROUP_HEADINGS: Record<StatusLine['group'], string> = {
  hub: '',
  pointers: 'Named in Now and Next',
  queue: 'Run queue',
  train: 'Library train',
  letters: 'Letters',
  'needs-you': 'Needs you',
  pages: 'Page sizes',
};

/**
 * A Hub root's top-level items of `## Now` and `## Next`, each with its wrapped and nested lines joined, and its box.
 * It reads the page's shown lines (`shownText`, kickoffs/s213-r6 row 1): a line in a fence or an HTML comment is no item.
 */
function rootItems(body: string): { section: string; text: string; ticked: boolean | null }[] {
  const lines = toLines(body);
  const shown = shownText(lines);
  const found: { section: string; text: string; ticked: boolean | null }[] = [];
  for (const section of ['Now', 'Next']) {
    const span = sectionSpan(lines, section);
    if (span === null) continue;
    for (let i = span.start + 1; i < span.end; i++) {
      const line = shown[i];
      if (line === null || line === undefined) continue;
      const top = /^(?:[-*+]|[0-9]+\.)[ \t]+(?:\[([ xX])\][ \t]*)?/.exec(line);
      if (top) found.push({ section, text: line, ticked: top[1] === undefined ? null : top[1] !== ' ' });
      else if (found.length && /^[ \t]+\S/.test(line) && found[found.length - 1]!.section === section) found[found.length - 1]!.text += ' ' + line.trim();
    }
  }
  return found;
}

/**
 * An item's closing condition: the text after `Closes when` up to the sentence's end (any case), or null when the item
 * has none (kickoffs/s219 row 1).
 */
function closingCondition(text: string): string | null {
  const match = /\bcloses when\b([\s\S]*?)(?:[.!?](?=\s|$)|$)/i.exec(text);
  return match === null ? null : match[1]!;
}

/** Whether a closing condition names a record (`<train id>`, `kickoffs/<id>` or `notes/<page>`) as a whole word. */
function namesRecord(condition: string, record: string): boolean {
  const escaped = record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i').test(condition);
}

/**
 * The Run pointers of a Hub's `## Next`, in page order, ticked or not, read through the one reading every other reader
 * of `## Next` uses (`nextShownLines`, kickoffs/s213-r6 row 1), so a pointer in a fence or an HTML comment is none here.
 */
function runPointers(body: string): { id: string; pending: boolean }[] {
  const runs: { id: string; pending: boolean }[] = [];
  for (const line of nextShownLines(toLines(body)) ?? []) {
    const match = /^\s*- \[([ xX])\] Run ([A-Za-z0-9._-]+):/.exec(line.text);
    if (match) runs.push({ id: match[2]!, pending: match[1] === ' ' });
  }
  return runs;
}

/** One line cut to the terminal width, ASCII only at the cut. */
export function fitLine(text: string, width = STATUS_WIDTH): string {
  return text.length <= width ? text : text.substring(0, width - 3).trimEnd() + '...';
}

export function hubStatus(workspace: string, slug: string, seatOption?: string): { schema: 1; operation: string; hub: string; seat: string; lines: StatusLine[] } {
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: seatOption, stateDirectory });
  const openProjects = deskEntriesForSeat(stateDirectory, seat, 'projects');
  const openBooks = deskEntriesForSeat(stateDirectory, seat, 'books');
  const lettersOpen = openBooks.includes('shelf/letters');
  const lines: StatusLine[] = [];
  const add = (group: StatusLine['group'], source: string, text: string) => lines.push({ group, source, text });
  const hubSource = `projects/${slug}/_project`;
  const readRoot = (hub: string): string => removeFrontmatter(fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8').replace(/^﻿/, ''));
  const hubOpen = openProjects.includes(`projects/${slug}`);
  const owner = readSeatRegistry(stateDirectory).find((row) => row.project === slug)?.seat ?? null;

  let body: string | null = null;
  if (!hubOpen) add('hub', `projects/${slug}`, `projects/${slug}: closed on this Desk`);
  else {
    try { body = readRoot(slug); } catch (error) { add('hub', hubSource, `${hubSource}: unreadable: ${(error as Error).message}`); }
  }

  // 1. WHAT THE ROOT'S ITEMS NAME, with each record's state now.
  if (body !== null) {
    let train: ReturnType<typeof readTrain> = null;
    let trainProblem: string | null = null;
    try { train = readTrain(workspace); } catch (error) { trainProblem = (error as Error).message; }
    const trainIds = new Map((train?.items ?? []).map((item) => [item.id, item.status]));
    const lettersBook = (() => { try { return getShelfBook(workspace, 'letters'); } catch { return null; } })();
    // Each letter's review state, through the Shelf's own note reader: the file name without `.md`, to `review`.
    const letterReview = new Map<string, string>();
    try { for (const note of lettersBook === null ? [] : shelfNotes(lettersBook)) letterReview.set(path.basename(note.file).replace(/\.md$/i, ''), note.review); } catch { /* no letters read */ }
    const ownRuns = runPointers(body);
    const otherRoots = new Map<string, string | null>();
    const kickoffPages = new Map<string, string[]>();
    // A Hub's `kickoffs/` page names, read once per Hub; a read that fails is one line in the group that asked.
    const kickoffPagesOf = (hub: string, group: StatusLine['group']): string[] => {
      let pages = kickoffPages.get(hub);
      if (pages === undefined) {
        const folder = path.join(workspace, 'collection', 'projects', hub, 'kickoffs');
        pages = [];
        try {
          pages = fs.readdirSync(folder, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
            .map(entry => entry.name.slice(0, -3)).sort();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add(group, `projects/${hub}/kickoffs`, `projects/${hub}/kickoffs: unreadable: ${(error as Error).message}`);
        }
        kickoffPages.set(hub, pages);
      }
      return pages;
    };
    const items = rootItems(body);
    const seen = new Set<string>();
    for (const item of items) {
      // The advice only when the item closes on that record: it has no closing condition, or its condition names it.
      const closedNote = (record: string, closed: boolean, names: (text: string) => boolean) => (closed && items.some(candidate => {
        const condition = closingCondition(candidate.text);
        return candidate.ticked === false && names(candidate.text) && (condition === null || namesRecord(condition, record));
      }) ? '; closed: tick or close this item' : '');
      const once = (key: string): boolean => (seen.has(key) ? false : (seen.add(key), true));
      // Train ids, in backticks.
      for (const match of item.text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) {
        const id = match[1]!;
        if (!trainIds.has(id) || !once(`train:${id}`)) continue;
        const state = trainIds.get(id)!;
        add('pointers', `train:${id}`, `train ${id}: ${state}${closedNote(id, state !== 'open', text => text.includes('`' + id + '`'))}`);
      }
      if (trainProblem !== null && /`[a-z0-9-]+`/.test(item.text) && once('train-problem')) add('pointers', 'internal/train/register.json', `train: unreadable: ${trainProblem}`);
      // Kickoffs: this Hub's own, by `Run <id>:` or `kickoffs/<id>`, and another Hub's only by its link, when open.
      for (const match of item.text.matchAll(/(?:\[\[projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/)?kickoffs\/([A-Za-z0-9._-]+?)(?=\]\]|[\s|,.;)]|$)/g)) {
        const hub = match[1] ?? slug;
        const id = match[2]!;
        if (!once(`kickoff:${hub}/${id}`)) continue;
        const source = `projects/${hub}/_project ## Next Run ${id}`;
        if (hub !== slug && !openProjects.includes(`projects/${hub}`)) {
          if (once(`closed:${hub}`)) add('pointers', `projects/${hub}`, `projects/${hub}: closed on this Desk`);
          continue;
        }
        let runs = ownRuns;
        if (hub !== slug) {
          if (!otherRoots.has(hub)) { try { otherRoots.set(hub, readRoot(hub)); } catch { otherRoots.set(hub, null); } }
          const other = otherRoots.get(hub);
          if (other === null || other === undefined) { add('pointers', `projects/${hub}/_project`, `projects/${hub}/_project: unreadable`); continue; }
          runs = runPointers(other);
        }
        const run = runs.find((row) => row.id.toLowerCase() === id.toLowerCase());
        let state = run === undefined ? 'no Run pointer' : run.pending ? 'pending' : 'ticked';
        if (run?.pending) {
          const pages = kickoffPagesOf(hub, 'pointers');
          const stem = run.id.replace(/-r\d+$/, '').toLowerCase();
          let highest = BigInt(/-r(\d+)$/.exec(run.id)?.[1] ?? '1');
          let newer: string | undefined;
          for (const page of pages) {
            const revision = /^(.*)-r(\d+)$/.exec(page);
            if (revision === null || revision[1]!.toLowerCase() !== stem || BigInt(revision[2]!) <= highest) continue;
            highest = BigInt(revision[2]!);
            newer = page;
          }
          if (newer !== undefined) state += `; newer revision kickoffs/${newer} posted`;
        }
        add('pointers', source, `${hub === slug ? '' : `projects/${hub} `}kickoffs/${id}: ${state}${closedNote(`kickoffs/${id}`, run !== undefined && !run.pending,
          text => [...text.matchAll(/(?:\[\[projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/)?kickoffs\/([A-Za-z0-9._-]+?)(?=\]\]|[\s|,.;)]|$)/g)]
            .some(named => (named[1] ?? slug) === hub && named[2] === id))}`);
      }
      // Letters, by their notes/ path, one by one only while the letters Book is open.
      for (const match of item.text.matchAll(/(?<![\w/])notes\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)/g)) {
        const page = match[1]!;
        if (!letterReview.has(page) || !once(`letter:${page}`)) continue;
        if (!lettersOpen) continue;
        const closed = letterReview.get(page) === 'done';
        add('pointers', `letters/notes/${page}`, `letter notes/${page}: ${closed ? 'closed' : 'open'}${closedNote(`notes/${page}`, closed,
          text => [...text.matchAll(/(?<![\w/])notes\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)/g)].some(named => named[1] === page))}`);
      }
    }
    // 2. THIS HUB'S QUEUE, in page order.
    const pending = ownRuns.filter((run) => run.pending);
    pending.forEach((run, index) => add('queue', `${hubSource} ## Next`, `${index + 1}. Run ${run.id}${index === 0 ? ' (the one to open)' : ''}`));
    // A Kickoff page no Run pointer names (kickoffs/s219 row 3): not in `## Next`, ticked or not, nor on a `notes/` page
    // a pointer moved to, and more than an hour old, so a page just posted waits for its pointer. Any `notes/` page holding
    // a pointer line counts, since tidy history has had other names (`hub-history-s142-tidy`, `h5-sort`).
    const named = new Set(ownRuns.map((run) => run.id.toLowerCase()));
    const notes = path.join(workspace, 'collection', 'projects', slug, 'notes');
    try {
      for (const entry of fs.readdirSync(notes, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        for (const line of shownText(toLines(fs.readFileSync(path.join(notes, entry.name), 'utf8')))) {
          const match = /^\s*[-*+] \[[ xX]\] Run ([A-Za-z0-9._-]+):/.exec(line ?? '');
          if (match) named.add(match[1]!.toLowerCase());
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add('queue', `projects/${slug}/notes`, `projects/${slug}/notes: unreadable: ${(error as Error).message}`);
    }
    const folder = path.join(workspace, 'collection', 'projects', slug, 'kickoffs');
    for (const id of kickoffPagesOf(slug, 'queue')) {
      if (named.has(id.toLowerCase())) continue;
      let age = 0;
      try { age = Date.now() - fs.statSync(path.join(folder, `${id}.md`)).mtimeMs; } catch { continue; }
      if (age > 60 * 60 * 1000) add('queue', `projects/${slug}/kickoffs/${id}`, `kickoffs/${id}: no Run pointer names it`);
    }
  }

  // 3. THE LIBRARY'S TRAIN: the one open car and the first five open items, in register order, with their place.
  try {
    const train = readTrain(workspace);
    if (train === null) add('train', 'internal/train/register.json', 'no train register in this Library');
    else {
      const car = frontCar(train);
      add('train', 'internal/train/register.json', car === null ? 'no open car' : `open car ${car.place}, opened ${car.opened}`);
      for (const item of train.items.filter((row) => row.status === 'open').slice(0, 5)) add('train', `train:${item.id}`, `${item.id} (${item.place})`);
    }
  } catch (error) {
    add('train', 'internal/train/register.json', `train: unreadable: ${(error as Error).message}`);
  }

  // 4. LETTERS FOR THE HUB'S SEAT: a count and the oldest date, which the Desk gives while the Book is closed too.
  if (owner !== null) {
    try {
      const book = getShelfBook(workspace, 'letters');
      const open = shelfNotes(book).filter((note) => note.review !== 'done' && note.forSeat === owner);
      const oldest = open.map((note) => note.captured).filter((at) => at && at !== 'unknown').sort()[0];
      add('letters', 'letters', `${lettersOpen ? '' : 'letters: closed on this Desk; '}${open.length} open for ${owner}${oldest ? `, the oldest from ${oldest}` : ''}`);
    } catch (error) {
      add('letters', 'letters', `letters: unreadable: ${(error as Error).message}`);
    }
  }

  // 5. NEEDS YOU, the lines whose seat owns this Hub; 6. this Hub's page sizes. Both read the Hub, so only while open.
  if (hubOpen && owner !== null) {
    try {
      const needs = readNeedsYou(workspace);
      for (const section of needs.sections) {
        for (const item of section.items) {
          if (item.seat === owner || (item.seat ?? '').endsWith(`(${owner})`)) add('needs-you', `needs-you:${section.key}`, item.text);
        }
      }
    } catch (error) {
      add('needs-you', 'needs-you', `needs-you: unreadable: ${(error as Error).message}`);
    }
  }
  if (hubOpen) {
    const rows = hubPages(workspace, [`projects/${slug}`]);
    for (const row of Array.isArray(rows) ? rows as Record<string, PsJsonValue>[] : []) {
      if (row['page'] !== '_project' && row['over'] !== true) continue;
      add('pages', `projects/${slug}/${String(row['page'])}`, `${String(row['page'])}: ${String(row['size_bytes'])} of ${String(row['limit_bytes'])} bytes${row['over'] === true ? ', over its limit' : ''}`);
    }
  }
  return { schema: 1, operation: 'Hub status', hub: `projects/${slug}`, seat, lines };
}

/** A text cut to `width` columns from its middle, keeping its start and its end (kickoffs/s219 row 2). */
function shortenMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  const keep = width - 3;
  return text.slice(0, Math.ceil(keep / 2)) + '...' + text.slice(text.length - Math.floor(keep / 2));
}

/** The shortest a record's name may be cut to before its state goes to a second line. */
const NAME_MINIMUM = 30;

/**
 * A long `pointers` line that keeps its state and advice whole (kickoffs/s219 row 2): the record's name is shortened from
 * its middle, and when the state and advice would leave it under NAME_MINIMUM columns they go to a second indented line.
 */
function fitPointer(text: string): string[] {
  const at = text.indexOf(': ');
  if (text.length <= STATUS_WIDTH || at < 0) return [fitLine(text)];
  const name = text.slice(0, at), rest = text.slice(at);
  if (STATUS_WIDTH - rest.length >= NAME_MINIMUM) return [shortenMiddle(name, STATUS_WIDTH - rest.length) + rest];
  return [shortenMiddle(name, STATUS_WIDTH - 1) + ':', fitLine('    ' + rest.slice(2))];
}

/** The terminal view: a heading per block, each line indented, none wider than STATUS_WIDTH columns. */
export function hubStatusText(status: ReturnType<typeof hubStatus>): string {
  const out: string[] = [fitLine(`${status.hub}: live state, read now`)];
  for (const group of Object.keys(GROUP_HEADINGS) as StatusLine['group'][]) {
    const lines = status.lines.filter((line) => line.group === group);
    if (!lines.length) continue;
    if (GROUP_HEADINGS[group]) out.push('', GROUP_HEADINGS[group]);
    for (const line of lines) {
      const text = `${GROUP_HEADINGS[group] ? '  ' : ''}${line.text}`;
      const revisionAt = text.indexOf('; newer revision kickoffs/');
      if (group === 'pointers' && revisionAt >= 0 && text.length > STATUS_WIDTH) {
        out.push(...fitPointer(text.slice(0, revisionAt + 1)), fitLine('    ' + text.slice(revisionAt + 2)));
      } else if (group === 'pointers') out.push(...fitPointer(text));
      else out.push(fitLine(text));
    }
  }
  return out.join('\n') + '\n';
}
