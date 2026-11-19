/**
 * `deskpost hub status <slug>`: a Hub's live state, built from the program's own records every time it is asked
 * (PLAN-hub-redesign.md section 2; kickoffs/s213 rows 17 to 20). Nothing it shows is written into the Hub, so it never
 * needs tidying.
 *
 * WHAT IT SHOWS, each line naming the record it came from:
 *   - each train id, `kickoffs/` id and letter path named in the Hub's `## Now` and `## Next`, with its state now, and
 *     `closed: tick or close this item` on an unticked item whose record has closed;
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
    const seen = new Set<string>();
    for (const item of rootItems(body)) {
      const closedNote = (closed: boolean) => (closed && item.ticked === false ? '; closed: tick or close this item' : '');
      const once = (key: string): boolean => (seen.has(key) ? false : (seen.add(key), true));
      // Train ids, in backticks.
      for (const match of item.text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) {
        const id = match[1]!;
        if (!trainIds.has(id) || !once(`train:${id}`)) continue;
        const state = trainIds.get(id)!;
        add('pointers', `train:${id}`, `train ${id}: ${state}${closedNote(state !== 'open')}`);
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
        const state = run === undefined ? 'no Run pointer' : run.pending ? 'pending' : 'ticked';
        add('pointers', source, `${hub === slug ? '' : `projects/${hub} `}kickoffs/${id}: ${state}${closedNote(run !== undefined && !run.pending)}`);
      }
      // Letters, by their notes/ path, one by one only while the letters Book is open.
      for (const match of item.text.matchAll(/(?<![\w/])notes\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)/g)) {
        const page = match[1]!;
        if (!letterReview.has(page) || !once(`letter:${page}`)) continue;
        if (!lettersOpen) continue;
        const closed = letterReview.get(page) === 'done';
        add('pointers', `letters/notes/${page}`, `letter notes/${page}: ${closed ? 'closed' : 'open'}${closedNote(closed)}`);
      }
    }
    // 2. THIS HUB'S QUEUE, in page order.
    const pending = ownRuns.filter((run) => run.pending);
    pending.forEach((run, index) => add('queue', `${hubSource} ## Next`, `${index + 1}. Run ${run.id}${index === 0 ? ' (the one to open)' : ''}`));
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

/** The terminal view: a heading per block, each line indented, none wider than STATUS_WIDTH columns. */
export function hubStatusText(status: ReturnType<typeof hubStatus>): string {
  const out: string[] = [fitLine(`${status.hub}: live state, read now`)];
  for (const group of Object.keys(GROUP_HEADINGS) as StatusLine['group'][]) {
    const lines = status.lines.filter((line) => line.group === group);
    if (!lines.length) continue;
    if (GROUP_HEADINGS[group]) out.push('', GROUP_HEADINGS[group]);
    for (const line of lines) out.push(fitLine(`${GROUP_HEADINGS[group] ? '  ' : ''}${line.text}`));
  }
  return out.join('\n') + '\n';
}
