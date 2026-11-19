/**
 * `library hub tidy <slug>`: decided Hub items moved to a history page, word for word, in one journaled step
 * (kickoffs/s125 rows 3-4; PLAN-tidy-redesign.md Part A item 3; ADR-0082).
 *
 * IT MOVES ONLY WHAT IS ALREADY DECIDED. By default every ticked top-level item of `## Now` and `## Next`, whole, with
 * its nested lines (`tickedEntries`, the count the Desk shows); with `--section`, a whole named section the seat chose,
 * refused for Purpose, Now, Next and Decisions and for any section still holding an unticked top-level item. It never
 * ticks, rewrites or deletes: every line it takes off the page is on the new history page, which the proof checks over
 * the proposed bodies at preflight and over the bodies read back at apply.
 *
 * ONE POINTER PER SECTION, PAGES CHAINED. Each shortened section keeps one kernel-written paragraph naming the newest
 * history page; the next tidy of that section replaces it and carries the old one onto its own page as
 * `Replaced pointer: ...`, so the proof has no exception. Each history page links the one before it.
 *
 * THE SAME GATE AS `hub edit`, IN ITS ORDER: the slug, the page name, this seat's Desk, the Hub active, the paths inside
 * the Hub; checked again under the Hub's lock, where the page hash, the history number and its predecessor must still
 * be the ones the plan was made from. Local collections only, as `new-page` is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { readMarker } from './workspace.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { sha256OfText } from './sha.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { hubSlug } from './hubslug.ts';
import { assertInsideRoot, lexists } from './pagepath.ts';
import { resolveContentPath } from './contentpath.ts';
import { strayControlRefusal } from './controlchars.ts';
import { localDate } from './localdate.ts';
import { entryLabel, headings, itemBlocks, joinLines, pageLimitBytes, pageSizeRemedy, pageSizeStatus, removeFrontmatter, sectionSpan, shownText, toLines, topLevelEntries } from './hubedit.ts';
import { tickedEntries } from './hubpages.ts';
import { capturePriorBytes, undoBlock, type UndoPathBefore } from './journal.ts';

class HubTidyRefusal extends Error {}

function refuse(message: string): never {
  throw new HubTidyRefusal(message);
}

const PROTECTED_SECTIONS = ['Purpose', 'Now', 'Next', 'Decisions'];
const HISTORY_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)-history-tidy-(\d+)\.md$/;

/** A test hook, named in the self-test that uses it. */
function injectedFault(): string {
  return (process.env['LIBRARY_HUB_TIDY_FAULT'] ?? '').trim();
}

/**
 * THE PAGE'S WORD IN A HISTORY PAGE'S NAME: `hub` for `_project` and `connections` (as `/meanwhile` reads them), else the
 * page path lowercased with every run outside `[a-z0-9]` one hyphen, trimmed, so the name always matches `new-page`'s
 * segment grammar and lands directly under `notes/` (`Release_Notes` gives `release-notes`, `design/Queue`
 * `design-queue`).
 */
export function pageWord(page: string): string {
  if (page === '_project' || page === 'connections') return 'hub';
  const word = page.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return word || 'page';
}

/** The pointer pattern, for this Hub: group 1 the history page's name, group 2 its number. */
function pointerPattern(slug: string): RegExp {
  return new RegExp(
    `^Tidied \\d{4}-\\d{2}-\\d{2}(?: from ## [^\\r\\n]+)?: \\d+ items? moved word for word to \\[\\[projects/${slug}/notes/(\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]+-history-tidy-(\\d+))\\]\\] \\(tidy \\2\\); that page links the one before it\\.(?: Points still open from them are on that page, under "## Still open from them"\\.)?$`,
  );
}

export function pointerLine(date: string, count: number, slug: string, notesName: string, number: number, section: string | null, hasNote: boolean): string {
  return `Tidied ${date} from ## ${section ?? '(page)'}: ${count} ${count === 1 ? 'item' : 'items'} moved word for word to [[projects/${slug}/notes/${notesName}]] (tidy ${number}); that page links the one before it.` +
    (hasNote ? ' Points still open from them are on that page, under "## Still open from them".' : '');
}

/** The history pages one level under `notes/`: the highest number, and the page that holds it. */
export function historyScan(hubRoot: string): { highest: number; previous: string | null } {
  const notes = path.join(hubRoot, 'notes');
  let highest = 0;
  let previous: string | null = null;
  if (!fs.existsSync(notes)) return { highest, previous };
  for (const name of fs.readdirSync(notes).sort()) {
    const match = HISTORY_NAME.exec(name);
    if (!match) continue;
    const number = Number(match[3]);
    if (number >= highest) {
      highest = number;
      previous = name.substring(0, name.length - 3);
    }
  }
  return { highest, previous };
}

/**
 * THE PROOF, OVER TWO BODIES (PLAN-tidy-redesign.md, "The proof"): every non-blank line the proposed page no longer
 * has, as many times as it lost it, is a line of the history page (a `Replaced pointer: ` line counted without that
 * prefix); and the only non-blank lines the proposed page gains are the new pointers. Blank lines are layout: a removed
 * block takes its blank neighbours with it, and a pointer stands between two.
 */
export function tidyProof(currentBody: string, proposedBody: string, notesBody: string, pointers: string[]): string[] {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) if (line.trim() !== '') map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const current = count(toLines(currentBody));
  const proposed = count(toLines(proposedBody));
  const notes = count(toLines(notesBody).map((line) => (line.startsWith('Replaced pointer: ') ? line.substring('Replaced pointer: '.length) : line)));
  const problems: string[] = [];
  for (const [line, times] of current) {
    const removed = times - (proposed.get(line) ?? 0);
    if (removed > 0 && (notes.get(line) ?? 0) < removed) problems.push(`removed ${removed} time(s) but not on the history page as often: ${line}`);
  }
  const allowed = count(pointers);
  for (const [line, times] of proposed) {
    const added = times - (current.get(line) ?? 0);
    if (added > 0 && (allowed.get(line) ?? 0) < added) problems.push(`added but not a pointer: ${line}`);
  }
  return problems;
}

interface Region {
  /** The heading line's index, or -1 for the lines above the first heading. */
  heading: number;
  start: number;
  end: number;
  name: string | null;
}

function regionsOf(lines: string[]): Region[] {
  const found = headings(lines);
  const regions: Region[] = [];
  const first = found.length ? found[0]!.index : lines.length;
  if (first > 0) regions.push({ heading: -1, start: 0, end: first, name: null });
  found.forEach((heading, i) => {
    regions.push({ heading: heading.index, start: heading.index, end: i + 1 < found.length ? found[i + 1]!.index : lines.length, name: heading.level === 2 ? heading.text : null });
  });
  return regions;
}

export interface TidyPlan {
  slug: string;
  page: string;
  pagePath: string;
  hubRoot: string;
  pageFull: string;
  raw: string;
  currentBody: string;
  proposedBody: string;
  notesName: string;
  notesPath: string;
  notesFull: string;
  notesBody: string;
  number: number;
  previous: string | null;
  planId: string;
  result: Record<string, PsJsonValue>;
  nothing: boolean;
}

interface Options {
  slug: string;
  page: string;
  sections: string[];
  note: string | null;
  seat: string | undefined;
}

/** The gate, in `hub edit`'s order: this seat's Desk, the Hub active, the paths inside it. Run again under the lock. */
function gate(workspace: string, options: Options, hubRoot: string, notesRelative: string | null): void {
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: options.seat, stateDirectory });
  const openProjects = deskEntriesForSeat(stateDirectory, seat, 'projects');
  if (openProjects.includes(`archive/projects/${options.slug}`)) refuse(`Project '${options.slug}' is open from the archive shelf. Archived Project Hubs are read-only.`);
  if (!openProjects.includes(`projects/${options.slug}`)) refuse(`Project '${options.slug}' is not open. Open it first: deskpost desk open project ${options.slug}`);
  if (!fs.existsSync(path.join(hubRoot, '_project.md'))) refuse(`There is no active Project Hub '${options.slug}' in this Library's collection. Nothing was written.`);
  assertInsideRoot(hubRoot, `${options.page}.md`, `collection/projects/${options.slug}`);
  if (notesRelative !== null) assertInsideRoot(hubRoot, notesRelative, `collection/projects/${options.slug}`);
}

/** Everything a tidy would do, from the page as it is now. Pure but for reads. */
export function planTidy(workspace: string, options: Options, now: Date = new Date()): TidyPlan {
  if (/^kickoffs\//i.test(options.page)) refuse('kickoffs/ pages are written once: a revision is a new page made with --mode new-page. Nothing was written.');
  const hubRoot = path.join(workspace, 'collection', 'projects', options.slug);
  const pagePath = `projects/${options.slug}/${options.page}.md`;
  const pageFull = path.join(hubRoot, ...`${options.page}.md`.split('/'));
  gate(workspace, options, hubRoot, null);
  if (!lexists(pageFull) || !fs.statSync(pageFull).isFile()) refuse(`Page '${pagePath}' does not exist. Nothing was written.`);
  const raw = fs.readFileSync(pageFull, 'utf8').replace(/^﻿/, '');
  const currentBody = removeFrontmatter(raw);
  const lines = toLines(currentBody);
  // ONE READING OF THE PAGE (kickoffs/s214 row 3; docs/project-hub-design.md): lines are read through `shownText`, so a
  // fenced line or one inside an HTML comment (null) is never an item the tidy moves, nor its pointer.
  const shown = shownText(lines);
  const shownTicked = (index: number): boolean => { const text = shown[index]; return text !== null && text !== undefined && TICKED_ITEM.test(text); };
  const date = localDate(now);

  // Named sections are moved whole. Only the remaining sections can contribute individual items.
  const movedSections: { name: string; start: number; end: number }[] = [];
  const available = headings(lines).filter((heading) => heading.level === 2).map((heading) => heading.text);
  for (const given of options.sections) {
    const name = given.trim().replace(/^#+/, '').trim();
    if (movedSections.some((section) => section.name === name)) continue;
    if (PROTECTED_SECTIONS.includes(name)) {
      refuse(`hub tidy moves no '${name}' section: Purpose, Now, Next and Decisions stay on the page, and ticked items leave Now and Next without --section. Nothing was written.`);
    }
    const span = sectionSpan(lines, name);
    if (span === null) refuse(`Section '${name}' was not found on '${pagePath}'. Level-two sections on this page: ${available.length ? available.join(', ') : '(none)'}. Nothing was written.`);
    const open = topLevelEntries(lines, span.start + 1, span.end).filter((entry) => /^(?:[-*+]|[0-9]+\.)[ \t]+\[ \]/.test(entry.line));
    if (open.length) {
      refuse(
        `Section '${name}' holds ${open.length} unticked ${open.length === 1 ? 'item' : 'items'}, which hub tidy never moves: ` +
          open.map((entry) => `line ${entry.index + 1}: ${entry.line.trim()}`).join('; ') +
          '. Tick or move them first. Nothing was written.',
      );
    }
    movedSections.push({ name, start: span.start, end: span.end });
  }

  const ticked: { section: string; start: number; end: number; line: string }[] = tickedEntries(currentBody).filter((entry) => shownTicked(entry.start));
  for (const section of new Set(available)) {
    if (section === 'Now' || section === 'Next' || movedSections.some(entry => entry.name === section)) continue;
    const span = sectionSpan(lines, section)!;
    const blocks = itemBlocks(lines, span.start + 1, span.end).filter(block => topLevelEntries(lines, block.start, block.start + 1).length);
    const pointer = pointerPattern(options.slug);
    const wholeList = lines.slice(span.start + 1, span.end).every((line, offset) => {
      const index = span.start + 1 + offset;
      return !line.trim() || pointer.test(line) || blocks.some(block => index >= block.start && index <= block.end);
    });
    if (!wholeList) continue;
    for (const block of blocks) {
      const line = lines[block.start]!;
      if (shownTicked(block.start)) ticked.push({ ...block, section, line });
    }
  }

  const word = pageWord(options.page);
  const scan = historyScan(hubRoot);
  const number = scan.highest + 1;
  const notesName = `${date}-${word}-history-tidy-${number}`;
  const notesRelative = `notes/${notesName}.md`;
  const notesPath = `projects/${options.slug}/${notesRelative}`;
  const notesFull = path.join(hubRoot, 'notes', `${notesName}.md`);
  const previousLink = scan.previous === null ? null : `projects/${options.slug}/notes/${scan.previous}`;

  const base: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Tidy a Project Hub page',
    project_slug: options.slug,
    page_path: pagePath,
    page_file: `collection/${pagePath}`,
  };
  if (ticked.length === 0 && movedSections.length === 0) {
    const size = Buffer.byteLength(currentBody, 'utf8');
    const limit = pageLimitBytes(pagePath);
    return {
      slug: options.slug, page: options.page, pagePath, hubRoot, pageFull, raw, currentBody, proposedBody: currentBody, notesName, notesPath, notesFull, notesBody: '',
      number, previous: previousLink, planId: '', nothing: true,
      result: {
        ...base,
        nothing_selected: true,
        moved: [],
        moved_sections: [],
        page_size_bytes: size,
        page_limit_bytes: limit,
        message: `Nothing to move on '${pagePath}': no ticked item in a list section${options.sections.length ? '' : ', and no --section named'}. The page is ${size} bytes with a limit of ${limit} bytes. Nothing was written.`,
        confirmation_required: false,
      },
    };
  }
  gate(workspace, options, hubRoot, notesRelative);
  if (lexists(notesFull)) refuse(`'${notesPath}' already exists, so this tidy's history page cannot be made. Nothing was written.`);

  // WHAT LEAVES, BY REGION. A region is the lines under one heading (or above the first).
  const regions = regionsOf(lines);
  const regionOf = (index: number): Region => regions.find((region) => index >= region.start && index < region.end)!;
  const removed = new Set<number>();
  const pattern = pointerPattern(options.slug);
  interface Shortened {
    region: Region;
    count: number;
    at: number;
  }
  const shortened = new Map<number, Shortened>();
  const touch = (region: Region, count: number, at: number): void => {
    const known = shortened.get(region.start);
    if (known) known.count += count;
    else shortened.set(region.start, { region, count, at });
  };
  for (const item of ticked) {
    for (let i = item.start; i <= item.end; i++) removed.add(i);
    touch(regionOf(item.start), 1, item.start);
  }
  const sectionStarts = new Set(movedSections.map((section) => section.start));
  for (const section of [...movedSections].sort((left, right) => left.start - right.start)) {
    for (let i = section.start; i < section.end; i++) removed.add(i);
    // ITS POINTER STANDS WHERE IT STOOD: at the end of the nearest region above it that stays.
    const host = [...regions].reverse().find((region) => region.end <= section.start && !sectionStarts.has(region.start));
    shortened.set(section.start, {
      region: { ...(host ?? { heading: -1, start: 0, end: 0 }), name: section.name },
      count: 1,
      at: host?.end ?? 0,
    });
  }

  // THE KERNEL'S OWN POINTER, ONE PER SECTION: a standalone unfenced paragraph of the exact form whose link names a
  // history page that exists here. It is replaced, and carried onto the new page.
  const isStandalone = (index: number, region: Region): boolean => {
    const before = index - 1;
    const after = index + 1;
    const beforeOk = before < region.start || before === region.heading || lines[before]!.trim() === '';
    const afterOk = after >= region.end || lines[after]!.trim() === '';
    return beforeOk && afterOk;
  };
  const replacedPointers: { section: PsJsonValue; line: string }[] = [];
  for (const entry of shortened.values()) {
    for (let i = entry.region.start; i < entry.region.end; i++) {
      if (shown[i] !== lines[i] || removed.has(i)) continue;
      const match = pattern.exec(lines[i]!);
      if (!match || !isStandalone(i, entry.region)) continue;
      if (!fs.existsSync(path.join(hubRoot, 'notes', `${match[1]}.md`))) continue;
      removed.add(i);
      replacedPointers.push({ section: entry.region.name, line: lines[i]! });
      entry.at = i;
      break;
    }
  }

  // THE PROPOSED PAGE: kept lines in order, each new pointer where its region's first moved block (or old pointer)
  // stood, a blank line either side, and no run of blank lines a removal made.
  const pointers: string[] = [];
  const insertAt = new Map<number, string[]>();
  for (const entry of shortened.values()) {
    const line = pointerLine(date, entry.count, options.slug, notesName, number, entry.region.name, options.note !== null);
    pointers.push(line);
    insertAt.set(entry.at, [...(insertAt.get(entry.at) ?? []), line]);
  }
  const out: { text: string; orig: number | null }[] = [];
  for (let i = 0; i <= lines.length; i++) {
    for (const pointer of insertAt.get(i) ?? []) {
      out.push({ text: '', orig: null }, { text: pointer, orig: null }, { text: '', orig: null });
    }
    if (i < lines.length && !removed.has(i)) out.push({ text: lines[i]!, orig: i });
  }
  let proposedLines = collapseMadeBlanks(out);
  if (injectedFault() === 'drop-line') {
    const victim = proposedLines.findIndex((line, i) => line.trim() !== '' && !pointers.includes(line) && i > 0);
    if (victim >= 0) proposedLines = [...proposedLines.slice(0, victim), ...proposedLines.slice(victim + 1)];
  }
  const proposedBody = joinLines(proposedLines);

  // THE HISTORY PAGE.
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(removeFrontmatter(fs.readFileSync(path.join(hubRoot, '_project.md'), 'utf8').replace(/^﻿/, '')))?.[1] ?? options.slug;
  const notesLines: string[] = [`# ${title}: tidy ${number}`, '', `Moved from \`${options.page}\` on ${date} by \`deskpost hub tidy\`, word for word.`];
  if (previousLink !== null) notesLines.push('', `Previous history page: [[${previousLink}]]`);
  for (const pointer of replacedPointers) notesLines.push('', `Replaced pointer: ${pointer.line}`);
  for (const section of new Set(ticked.map(item => item.section))) {
    const blocks = ticked.filter((item) => item.section === section);
    if (!blocks.length) continue;
    notesLines.push('', `## From ## ${section}`, '');
    for (const block of blocks) notesLines.push(...lines.slice(block.start, block.end + 1));
  }
  for (const section of movedSections) {
    const kept = lines.slice(section.start, section.end);
    while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
    notesLines.push('', ...kept);
  }
  if (options.note !== null) notesLines.push('', '## Still open from them', '', ...toLines(options.note.replace(/\s+$/, '')));
  const notesBody = joinLines(notesLines);

  const problems = tidyProof(currentBody, proposedBody, notesBody, pointers);
  if (problems.length) refuse(`hub tidy's proof failed, so nothing is proposed and nothing was written: ${problems.join('; ')}`);

  // WHAT STAYS AND STILL NAMES WHAT LEFT.
  const needles = [
    ...ticked.map((item) => entryLabel(item.line).replace(/\.\.\.$/, '')).filter((label) => label.length >= 8),
    ...movedSections.map((section) => section.name),
  ];
  const dangling: PsJsonValue[] = [];
  const proposedRegions = regionsOf(proposedLines);
  proposedLines.forEach((line, i) => {
    if (line.trim() === '' || pointers.includes(line)) return;
    const hit = needles.find((needle) => line.includes(needle));
    if (hit !== undefined) dangling.push({ section: proposedRegions.find((region) => i >= region.start && i < region.end)?.name ?? null, line_number: i + 1, line, quotes: hit });
  });

  const sizeOf = (body: string, name: string): number => {
    const bodyLines = toLines(body);
    const span = sectionSpan(bodyLines, name);
    if (span === null) return 0;
    let bytes = 0;
    for (let j = span.start; j < span.end; j++) bytes += Buffer.byteLength(bodyLines[j]!, 'utf8') + 1;
    return bytes;
  };
  const touchedNames = [...new Set([...[...shortened.values()].map((entry) => entry.region.name), ...movedSections.map((section) => section.name)].filter((name): name is string => name !== null))];
  const currentSha = sha256OfText(currentBody);
  const proposedSha = sha256OfText(proposedBody);
  const notesSha = sha256OfText(notesBody);
  const planId = 'project-tidy-' + sha256OfText(`${pagePath}|${notesPath}|${previousLink ?? ''}|${currentSha}|${proposedSha}|${notesSha}`);
  const status = pageSizeStatus(proposedBody, pagePath, currentBody);
  const result: Record<string, PsJsonValue> = {
    ...base,
    plan_id: planId,
    notes_page_path: notesPath,
    notes_page_file: `collection/${notesPath}`,
    tidy_number: number,
    previous_history_page: previousLink,
    moved: ticked.map((item) => ({ section: item.section, label: entryLabel(item.line), size_bytes: lines.slice(item.start, item.end + 1).reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0) })),
    moved_sections: movedSections.map((section) => section.name),
    replaced_pointers: replacedPointers.map((pointer) => ({ section: pointer.section, line: pointer.line })),
    section_sizes: touchedNames.map((name) => ({ section: name, before: sizeOf(currentBody, name), after: sizeOf(proposedBody, name) })),
    page_size_before: Buffer.byteLength(currentBody, 'utf8'),
    page_size_after: Buffer.byteLength(proposedBody, 'utf8'),
    page_size_warning: status,
    dangling_references: dangling,
    current_sha256: currentSha,
    proposed_sha256: proposedSha,
    notes_page_sha256: notesSha,
    proof: 'passed',
    confirmation_required: true,
  };
  return { slug: options.slug, page: options.page, pagePath, hubRoot, pageFull, raw, currentBody, proposedBody, notesName, notesPath, notesFull, notesBody, number, previous: previousLink, planId, result, nothing: false };
}

/**
 * The kept lines with the pointers in place: a run of blank lines collapses to one wherever a removal or a pointer
 * touches it, a run the page already had elsewhere stays as it was, and no blank line opens or closes the page.
 */
function collapseMadeBlanks(out: { text: string; orig: number | null }[]): string[] {
  const result: string[] = [];
  let run: { text: string; orig: number | null }[] = [];
  let before: number | null = null;
  const flush = (after: number | null, atEdge: boolean): void => {
    if (!run.length) return;
    const origins = run.map((item) => item.orig);
    const pristine =
      !atEdge &&
      origins.every((orig) => orig !== null) &&
      origins.every((orig, i) => i === 0 || orig === origins[i - 1]! + 1) &&
      before !== null && origins[0] === before + 1 &&
      after !== null && origins[origins.length - 1]! + 1 === after;
    if (pristine) result.push(...run.map((item) => item.text));
    else if (!atEdge) result.push('');
    run = [];
  };
  for (const item of out) {
    if (item.text.trim() === '') {
      run.push(item);
      continue;
    }
    flush(item.orig, result.length === 0);
    result.push(item.text);
    before = item.orig;
  }
  flush(null, true);
  return result;
}

// --- the verb -------------------------------------------------------------------------------------------------------

export async function hubTidy(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('hub', 'tidy'));
  const { slug, problem } = hubSlug(parsed.positional[0] ?? '');
  if (problem !== null) refuse(`hub tidy needs a Hub: ${problem} Nothing was written.`);
  if (parsed.positional.length > 1) {
    refuse(`hub tidy takes one Hub slug and its --options, and nothing else: unexpected argument: ${parsed.positional[1]}. Nothing was written.`);
  }
  // LOCAL ONLY, as new-page is: the history page is made with an exclusive create in the Library's own collection.
  const marker = readMarker(workspace);
  if (marker === null || String(marker['backend'] ?? '') !== 'local') {
    refuse("hub tidy moves items within a local Library's own collection, and this workspace is attached to Basic Memory. Nothing was written.");
  }
  let page = (parsed.options.get('page') ?? '_project').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (/\.md$/i.test(page)) page = page.substring(0, page.length - 3);
  if (!page) refuse('Page is required.');
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)*$/.test(page) || /(^|\/)\.\.?($|\/)/.test(page)) {
    refuse('Page must be a canonical path below the Project root, such as _project or notes/topic/Article. Nothing was written.');
  }
  let note: string | null = null;
  const notePath = parsed.options.get('note-path');
  if (notePath !== undefined) {
    const full = resolveContentPath(workspace, notePath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`--note-path '${notePath}' is not a file (resolved to ${full}).`);
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)).replace(/^﻿/, '');
    } catch (error) {
      refuse(`--note-path '${notePath}' (resolved to ${full}) is not valid UTF-8: ${(error as Error).message}`);
    }
    const stray = strayControlRefusal(text, `--note-path '${notePath}'`);
    if (stray !== null) refuse(stray);
    if (!text.trim()) refuse(`--note-path '${notePath}' is empty.`);
    const split = toLines(text).findIndex((line) => /^ {0,3}#{1,2}[ \t]/.test(line));
    if (split >= 0) refuse(`Line ${split + 1} of --note-path is a level-one or level-two heading; the note goes under '## Still open from them', so use ### inside it.`);
    note = text;
  }
  const options: Options = { slug, page, sections: parsed.lists.get('section') ?? [], note, seat: parsed.options.get('seat') };
  const plan = planTidy(workspace, options);
  if (parsed.flags.has('preflight')) return plan.result;
  if (plan.nothing) refuse(String(plan.result['message']));
  if (!parsed.flags.has('user-confirmed')) refuse('hub tidy moves text off the page and is not yet performed: review the preflight and rerun with --user-confirmed --plan-id <id>.');
  if ((parsed.options.get('plan-id') ?? '').trim() !== plan.planId) {
    refuse(
      'hub tidy is not yet performed: rerun the current preflight and pass its exact plan_id as --plan-id. A different plan_id means the page, ' +
        `the history page's number or the page before it changed since the preview; the page reads ${String(plan.result['current_sha256'])} now. Nothing was written. ` +
        `The note (${notePath ? `--note-path '${notePath}'` : 'no --note-path'}) is part of the plan too.`,
    );
  }
  // TEST HOOKS, named in self-test section 276: what another writer could do between the plan and the lock.
  const fault = injectedFault();
  if (fault === 'change-page') fs.appendFileSync(plan.pageFull, '\nA line written after the preview.\n');
  if (fault === 'new-history' || fault === 'notes-appears') {
    fs.mkdirSync(path.join(plan.hubRoot, 'notes'), { recursive: true });
    const name = fault === 'new-history' ? `${localDate()}-other-history-tidy-${plan.number}.md` : `${plan.notesName}.md`;
    fs.writeFileSync(path.join(plan.hubRoot, 'notes', name), '# Made by another writer\n');
  }
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
  return applyTidy(workspace, options, plan, Number.isFinite(timeout) ? timeout : 20);
}

/**
 * A tidy journal's time in its name, to the millisecond (kickoffs/s214 row 4), as close-item's is: a tidy rolled back and
 * retried in the same second has the same plan, and the journal is created exclusively, so a seconds-only name failed.
 */
export function tidyJournalStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1').replace('T', '-');
}

function applyTidy(workspace: string, options: Options, plan: TidyPlan, timeoutSeconds: number): Record<string, PsJsonValue> {
  const now = new Date();
  const stamp = tidyJournalStamp(now);
  const journalPath = path.join(
    workspace,
    'internal',
    'publication-journals',
    `project-tidy-${plan.slug}-${pageWord(plan.page)}-${stamp}-${plan.planId.substring(plan.planId.length - 8)}.json`,
  );
  const relativeJournal = path.relative(workspace, journalPath).replace(/\\/g, '/');
  let journalCreated = false;
  // WHAT `deskpost undo` NEEDS (kickoffs/s165 row 1): the page's and the history page's prior state, read under the
  // lock, and in the complete journal their after hashes.
  let prior: UndoPathBefore[] = [];
  const saveJournal = (state: string, errorText: string, surviving: string[] = []): void => {
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-tidy',
      timestamp_utc: now.toISOString(),
      project_slug: plan.slug,
      page_path: plan.pagePath,
      page_file: `collection/${plan.pagePath}`,
      notes_page_path: plan.notesPath,
      notes_page_file: `collection/${plan.notesPath}`,
      notes_page_previous_state: 'absent',
      approved_plan_id: plan.planId,
      previous_sha256: String(plan.result['current_sha256']),
      proposed_sha256: String(plan.result['proposed_sha256']),
      notes_page_sha256: String(plan.result['notes_page_sha256']),
      previous_body: plan.currentBody,
      previous_raw: plan.raw,
      surviving_paths: surviving,
      error: errorText,
      ...(state === 'complete' ? { undo: undoBlock(workspace, { kind: 'hub-tidy', seat: requireSeat({ seat: options.seat, stateDirectory: path.join(workspace, '.claude') }), locks: [`projects/${plan.slug}`], before: prior }) } : {}),
    };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, psConvertToJson(journal), { encoding: 'utf8', flag: journalCreated ? 'w' : 'wx' });
    journalCreated = true;
  };
  const sameText = (left: string, right: string): boolean => left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
  const notesRelative = `notes/${plan.notesName}.md`;

  let lock: BookLock | null = null;
  let notesCreated = false;
  let pageWritten = false;
  const createdDirectories: string[] = [];
  try {
    lock = enterBookLock(workspace, `projects/${plan.slug}`, timeoutSeconds);
    // AGAIN, UNDER THE LOCK: the Desk, the Hub, the paths, the page, the history number and the page before it.
    gate(workspace, options, plan.hubRoot, notesRelative);
    if (!lexists(plan.pageFull)) refuse(`Page '${plan.pagePath}' disappeared after this tidy was planned. Nothing was written.`);
    const raw = fs.readFileSync(plan.pageFull, 'utf8').replace(/^﻿/, '');
    if (!sameText(removeFrontmatter(raw), plan.currentBody)) {
      refuse(`Page '${plan.pagePath}' changed after this tidy was planned, so nothing was written. Run the preflight again.`);
    }
    const scan = historyScan(plan.hubRoot);
    const previous = scan.previous === null ? null : `projects/${plan.slug}/notes/${scan.previous}`;
    if (scan.highest + 1 !== plan.number || previous !== plan.previous) {
      refuse(
        `A history page was made on this Hub after the preview (the next number is now ${scan.highest + 1}, the page before it ${previous ?? 'none'}), ` +
          'so nothing was written. Run the preflight again.',
      );
    }
    if (lexists(plan.notesFull)) refuse(`'${plan.notesPath}' appeared after this tidy was planned. Nothing was written.`);
    prior = capturePriorBytes(workspace, [plan.pageFull, plan.notesFull]);
    saveJournal('pending', '');

    let parent = path.dirname(plan.notesFull);
    while (!fs.existsSync(parent)) {
      createdDirectories.push(parent);
      parent = path.dirname(parent);
    }
    if (createdDirectories.length) fs.mkdirSync(path.dirname(plan.notesFull), { recursive: true });
    const descriptor = fs.openSync(plan.notesFull, 'wx');
    notesCreated = true;
    try {
      saveJournal('notes-created', '');
      const written = fs.writeSync(descriptor, plan.notesBody, null, 'utf8');
      if (written !== Buffer.byteLength(plan.notesBody, 'utf8')) refuse(`Only ${written} of ${Buffer.byteLength(plan.notesBody, 'utf8')} bytes of ${plan.notesPath} were written.`);
    } finally {
      fs.closeSync(descriptor);
    }
    // THE PAGE'S OWN FRONT MATTER IS KEPT, as hub edit's local store keeps it.
    const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)*/.exec(raw);
    writeAtomicText(plan.pageFull, head ? head[0] + plan.proposedBody : plan.proposedBody);
    pageWritten = true;
    saveJournal('page-written', '');

    const notesBack = fs.readFileSync(plan.notesFull, 'utf8');
    let pageBack = removeFrontmatter(fs.readFileSync(plan.pageFull, 'utf8').replace(/^﻿/, ''));
    if (injectedFault() === 'readback') pageBack = pageBack + 'A line nobody approved.\n';
    if (!sameText(pageBack, plan.proposedBody) || notesBack !== plan.notesBody) {
      refuse(`The tidy was written but did not read back as the approved text: ${plan.pagePath}, ${plan.notesPath}`);
    }
    const before = new Set(toLines(plan.currentBody));
    const pointers = toLines(plan.proposedBody).filter((line) => line.startsWith('Tidied ') && !before.has(line));
    const problems = tidyProof(plan.currentBody, pageBack, notesBack, pointers);
    if (problems.length) refuse(`The proof failed on what was read back: ${problems.join('; ')}`);
    saveJournal('complete', '');
  } catch (error) {
    const failure = (error as Error).message;
    if (!notesCreated && !pageWritten) {
      exitBookLock(lock);
      lock = null;
      throw error;
    }
    // UNDONE ONLY IF IT IS PROVABLY OURS AND PROVABLY BACK.
    const problems: string[] = [];
    const surviving: string[] = [];
    if (pageWritten) {
      try {
        writeAtomicText(plan.pageFull, plan.raw);
        if (fs.readFileSync(plan.pageFull, 'utf8').replace(/^﻿/, '') !== plan.raw) throw new Error('it does not read back as it was');
      } catch (undo) {
        problems.push(`the page was not restored (${(undo as Error).message})`);
        surviving.push(plan.pagePath);
      }
    }
    if (notesCreated) {
      try {
        if (fs.readFileSync(plan.notesFull, 'utf8') !== plan.notesBody) throw new Error('its bytes are no longer the ones this run wrote');
        fs.rmSync(plan.notesFull, { force: true });
        if (lexists(plan.notesFull)) throw new Error('it is still there after the removal');
        for (const directory of createdDirectories) {
          if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
        }
      } catch (undo) {
        problems.push(`the history page was not removed (${(undo as Error).message})`);
        surviving.push(plan.notesPath);
      }
    }
    if (problems.length) {
      saveJournal('recovery-required', `${failure}; not undone: ${problems.join('; ')}`, surviving);
      refuse(`The tidy was not made. ${failure}. Rollback: ${problems.join('; ')}; read ${relativeJournal}.`);
    }
    saveJournal('rolled-back', failure);
    refuse(`The tidy was not made. ${failure}. Rollback: the page was restored and the history page removed, both verified; nothing is left. The journal is ${relativeJournal}.`);
  } finally {
    exitBookLock(lock);
  }

  const status = plan.result['page_size_warning'] as Record<string, PsJsonValue>;
  if (status['warn']) process.stderr.write(`WARNING: Project Hub page '${plan.pagePath}' is ${status['size_after_bytes']} bytes after this edit. ${pageSizeRemedy(plan.pagePath)}\n`);
  const dangling = plan.result['dangling_references'] as PsJsonValue[];
  return {
    schema: 1,
    operation: 'Tidy a Project Hub page',
    project_slug: plan.slug,
    page_path: plan.pagePath,
    page_file: `collection/${plan.pagePath}`,
    notes_page_path: plan.notesPath,
    notes_page_file: `collection/${plan.notesPath}`,
    tidy_number: plan.number,
    plan_id: plan.planId,
    written: true,
    status: 'written',
    journal_path: journalPath,
    journal: relativeJournal,
    moved_count: (plan.result['moved'] as PsJsonValue[]).length + (plan.result['moved_sections'] as PsJsonValue[]).length,
    page_size_after: plan.result['page_size_after']!,
    page_size_warning: status,
    dangling_references: dangling,
    written_sha256: plan.result['proposed_sha256']!,
    notes_page_sha256: plan.result['notes_page_sha256']!,
    next:
      `Read the history page with mcp__validated-book-reader__read_open_project_page (${plan.slug}, notes/${plan.notesName}).` +
      (dangling.length
        ? ` ${dangling.length} line(s) on the page still name what moved: point each at [[${plan.notesPath.replace(/\.md$/, '')}]] with deskpost hub edit ${plan.slug} --mode replace-item.`
        : ''),
    shared_library_write: false,
  };
}

// --- close-item -----------------------------------------------------------------------------------------------------
//
// `hub edit --mode close-item` (PLAN-hub-redesign.md section 1; kickoffs/s213 rows 12 to 16): one top-level item of the
// Hub root's `## Now` or `## Next`, with its sub-items, moved word for word (ticked) onto the Hub's newest tidy-history
// page, and taken off the root, in one locked, journaled step. Closing an item is as cheap as adding one: no gate beyond
// check-item's. The text survives on a page the root links to, so a close is not a deletion (ADR-0026).

/** The root's one pointer per section to the history page closed items went to (HR-05). */
const CLOSED_POINTER = /^Closed items: \[\[(projects\/[^\]]+)\]\]$/;
/** A top-level list item's first line, and a ticked one's, as read from its shown text (kickoffs/s214 row 3). */
const LIST_ITEM = /^(?:[-*+]|[0-9]+\.)[ \t]+/;
const TICKED_ITEM = /^(?:[-*+]|[0-9]+\.)[ \t]+\[[xX]\](?:[ \t]|$)/;

export function closedPointerLine(slug: string, notesName: string): string {
  return `Closed items: [[projects/${slug}/notes/${notesName}]]`;
}

/** The first `[ ]` of an item's first line made `[x]`; an item already ticked, or with no checkbox, is unchanged. */
export function closedFirstLine(line: string): string {
  return /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+\[ \]/.test(line) ? line.replace('[ ]', '[x]') : line;
}

export interface CloseOptions {
  slug: string;
  matchText: string;
  section: string | null;
  seat: string | undefined;
  preflight: boolean;
  planId: string;
  lockTimeout: number;
}

export interface ClosePlan {
  slug: string;
  hubRoot: string;
  pagePath: string;
  pageFull: string;
  raw: string;
  currentBody: string;
  proposedBody: string;
  section: string;
  block: string[];
  /** The block's first and last line in `currentBody`, as planned: the proof after the write reads these lines. */
  blockStart: number;
  blockEnd: number;
  notesName: string;
  notesPath: string;
  notesFull: string;
  notesExisted: boolean;
  oldNotes: string;
  notesBody: string;
  pointer: string;
  pointerChange: 'insert' | 'retarget' | 'none';
  replacedPointer: string | null;
  planId: string;
  result: Record<string, PsJsonValue>;
}

/** A test hook, named in self-test sections 1512 (`a`, `b`, `c`: corrupts one part of the plan so its proof must refuse) and 1525 (`write`: a new history page's body write throws). */
function closeFault(): string {
  return (process.env['LIBRARY_CLOSE_ITEM_FAULT'] ?? '').trim();
}

/**
 * THE ROOT AFTER A CLOSE (HR-05), the one form the plan writes and the proof accepts: the block's lines removed, and the
 * block's own ## section given its one `Closed items:` pointer at its one permitted place: retargeted where it stands, or
 * inserted before the section's first top-level item (with a blank line after it) or, with no item left, at the section's
 * end (with a blank line before it). `pointers` counts the section's pointers outside the block; with more than one there
 * is no permitted place, and `lines` is empty.
 */
export function closedRoot(lines: string[], blockStart: number, blockEnd: number, pointer: string):
  { lines: string[]; section: string; change: 'insert' | 'retarget' | 'none'; replaced: string | null; pointers: number } | null {
  const heading = headings(lines).filter((one) => one.level === 2 && one.index < blockStart).pop();
  if (heading === undefined) return null;
  const span = sectionSpan(lines, heading.text)!;
  if (blockEnd >= span.end || blockEnd < blockStart) return null;
  // Read through `shownText` (kickoffs/s214 row 3): a Closed items line inside a fence or a comment is not a pointer.
  const shown = shownText(lines);
  const present: number[] = [];
  for (let i = span.start + 1; i < span.end; i++) if (shown[i] === lines[i] && (i < blockStart || i > blockEnd) && CLOSED_POINTER.test(lines[i]!)) present.push(i);
  if (present.length > 1) return { lines: [], section: heading.text, change: 'none', replaced: null, pointers: present.length };
  const change = present.length === 0 ? 'insert' : lines[present[0]!] === pointer ? 'none' : 'retarget';
  const out = [...lines];
  if (change === 'retarget') out[present[0]!] = pointer;
  out.splice(blockStart, blockEnd - blockStart + 1);
  if (change === 'insert') {
    const after = sectionSpan(out, heading.text)!;
    const first = topLevelEntries(out, after.start + 1, after.end)[0]?.index;
    if (first !== undefined) out.splice(first, 0, pointer, '');
    else {
      let last = after.start;
      for (let i = after.start + 1; i < after.end; i++) if (out[i]!.trim() !== '') last = i;
      out.splice(last + 1, 0, '', pointer);
    }
  }
  return { lines: out, section: heading.text, change, replaced: change === 'retarget' ? lines[present[0]!]! : null, pointers: present.length };
}

/**
 * CLOSE-ITEM'S OWN PROOF (PLAN-hub-redesign.md section 1, HR-01), run before the write and on what was read back:
 * (a) the root after is exactly the root before with the block's lines removed and the pointer set at its one permitted
 *     place (`closedRoot`): a pointer in another section, moved, or doubled fails;
 * (b) the text added to the history page holds the block exactly once, byte for byte but for the first `[ ]` of its first
 *     line made `[x]`, and at its end, where the plan appends it;
 * (c) the history page after starts with its whole previous body, byte for byte.
 */
export function closeItemProof(input: { currentBody: string; proposedBody: string; blockStart: number; blockEnd: number; oldNotes: string; notesBody: string; pointer: string }): string[] {
  const problems: string[] = [];
  const before = toLines(input.currentBody);
  const expected = closedRoot(before, input.blockStart, input.blockEnd, input.pointer);
  if (expected === null) problems.push('(a) the closed block is not one item inside one ## section of the root');
  else if (expected.pointers > 1) problems.push(`(a) ## ${expected.section} holds ${expected.pointers} Closed items lines, so the pointer has no one place`);
  else {
    const after = toLines(joinLines(toLines(input.proposedBody)));
    const want = toLines(joinLines(expected.lines));
    if (after.join('\n') !== want.join('\n')) {
      let at = 0;
      while (at < after.length && after[at] === want[at]) at++;
      problems.push(`(a) the root after is not the root before with only the closed item removed and its Closed items pointer set in ## ${expected.section}; it first differs at line ${at + 1}`);
    }
  }
  if (!input.notesBody.startsWith(input.oldNotes)) problems.push('(c) the history page does not start with its whole previous body');
  const block = before.slice(input.blockStart, input.blockEnd + 1);
  const moved = [closedFirstLine(block[0] ?? ''), ...block.slice(1)];
  const added = toLines(input.notesBody.substring(input.oldNotes.length));
  let count = 0;
  for (let index = 0; index + moved.length <= added.length; index++) if (moved.every((line, offset) => added[index + offset] === line)) count++;
  // The plan appends the block last and ends the page with one line ending, so the added lines end with the block and ''.
  const end = added.length - 1 - moved.length;
  const atEnd = end >= 0 && added[added.length - 1] === '' && moved.every((line, offset) => added[end + offset] === line);
  if (count === 0) problems.push('(b) the history page does not hold the closed block word for word');
  else if (count > 1) problems.push(`(b) the history page gains the closed block ${count} times, not once`);
  else if (!atEnd) problems.push('(b) the closed block is not at the end of what the history page gains');
  return problems;
}

export function planCloseItem(workspace: string, options: CloseOptions, now: Date = new Date()): ClosePlan {
  const hubRoot = path.join(workspace, 'collection', 'projects', options.slug);
  const gateOptions: Options = { slug: options.slug, page: '_project', sections: [], note: null, seat: options.seat };
  gate(workspace, gateOptions, hubRoot, null);
  const pagePath = `projects/${options.slug}/_project.md`;
  const pageFull = path.join(hubRoot, '_project.md');
  const raw = fs.readFileSync(pageFull, 'utf8').replace(/^﻿/, '');
  const currentBody = removeFrontmatter(raw);
  const lines = toLines(currentBody);
  // Read through `shownText` (kickoffs/s214 row 3): an item inside a fence or an HTML comment is never the one closed.
  const shown = shownText(lines);
  const sections = options.section === null ? ['Now', 'Next'] : [options.section];
  if (options.section !== null && options.section !== 'Now' && options.section !== 'Next') {
    refuse(`close-item closes items of ## Now and ## Next only, not '${options.section}'. Nothing was written.`);
  }
  const found: { section: string; start: number; end: number }[] = [];
  for (const section of sections) {
    const span = sectionSpan(lines, section);
    if (span === null) continue;
    for (const block of itemBlocks(lines, span.start + 1, span.end)) {
      const first = shown[block.start];
      if (first === null || first === undefined || !LIST_ITEM.test(first) || !topLevelEntries(lines, block.start, block.start + 1).length) continue;
      if (lines.slice(block.start, block.end + 1).join(' ').includes(options.matchText)) found.push({ section, ...block });
    }
  }
  const where = sections.map((name) => `## ${name}`).join(' or ');
  if (found.length === 0) refuse(`No top-level item in ${where} of ${pagePath} contains '${options.matchText}'. Nothing was written.`);
  if (found.length > 1) {
    refuse(`'${options.matchText}' matches ${found.length} items in ${where}; give text unique to one. Matches begin: ${found.slice(0, 4).map((item) => lines[item.start]!.trim()).join(' | ')}. Nothing was written.`);
  }
  const item = found[0]!;
  const block = lines.slice(item.start, item.end + 1);

  // THE HISTORY PAGE: the newest one (the highest number), appended to; or, on a Hub with none, the first.
  const scan = historyScan(hubRoot);
  const date = localDate(now);
  const notesExisted = scan.highest > 0 && scan.previous !== null;
  const notesName = notesExisted ? scan.previous! : `${date}-hub-history-tidy-1`;
  const notesRelative = `notes/${notesName}.md`;
  gate(workspace, gateOptions, hubRoot, notesRelative);
  const notesFull = path.join(hubRoot, 'notes', `${notesName}.md`);
  const notesPath = `projects/${options.slug}/${notesRelative}`;
  if (!notesExisted && lexists(notesFull)) refuse(`'${notesPath}' already exists. Nothing was written.`);
  const oldNotes = notesExisted ? fs.readFileSync(notesFull, 'utf8') : '';
  const pointer = closedPointerLine(options.slug, notesName);

  // THE ROOT POINTER, in the item's section: at most one plain `Closed items:` paragraph (HR-05), set as `closedRoot` says.
  const closed = closedRoot(lines, item.start, item.end, pointer)!;
  if (closed.pointers > 1) refuse(`## ${item.section} holds ${closed.pointers} Closed items lines; it holds one. Edit them to one by hand first. Nothing was written.`);
  const pointerChange: ClosePlan['pointerChange'] = closed.change;
  const replacedPointer = closed.replaced;
  const proposed = closed.lines;

  // THE BLOCK ON THE HISTORY PAGE, in `hub tidy`'s format.
  const eol = oldNotes.includes('\r\n') ? '\r\n' : '\n';
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(currentBody)?.[1] ?? options.slug;
  const head = notesExisted ? [] : [`# ${title}: tidy 1`, '', `Moved from \`_project\` on ${date} by \`deskpost hub edit --mode close-item\`, word for word.`];
  const lastHeading = notesExisted ? [...toLines(oldNotes)].reverse().find((line) => /^##[ \t]/.test(line)) ?? null : null;
  const addition = [
    ...(lastHeading === `## From ## ${item.section}` ? [''] : ['', `## From ## ${item.section}`, '']),
    ...(replacedPointer !== null ? [`Replaced pointer: ${replacedPointer}`, ''] : []),
    closedFirstLine(block[0]!),
    ...block.slice(1),
  ];
  // An existing page is appended to (its last line ended first when it has no newline); a new one starts with its head.
  let notesBody = notesExisted
    ? oldNotes + (oldNotes.endsWith('\n') ? '' : eol) + addition.join(eol) + eol
    : [...head, ...addition].join(eol) + eol;
  let proposedBody = joinLines(proposed);

  const fault = closeFault();
  if (fault === 'a') proposedBody = joinLines([...toLines(proposedBody), 'A line nobody approved.']);
  if (fault === 'b') {
    const last = block.length > 1 ? block[block.length - 1]! : closedFirstLine(block[0]!);
    const at = notesBody.lastIndexOf(last);
    notesBody = notesBody.substring(0, at) + last + ' (changed)' + notesBody.substring(at + last.length);
  }
  if (fault === 'c' && oldNotes.length > 0) notesBody = notesBody.substring(1);
  const problems = closeItemProof({ currentBody, proposedBody, blockStart: item.start, blockEnd: item.end, oldNotes, notesBody, pointer });
  if (problems.length) refuse(`close-item's proof failed, so nothing is proposed and nothing was written: ${problems.join('; ')}`);

  const currentSha = sha256OfText(currentBody);
  const proposedSha = sha256OfText(proposedBody);
  const notesSha = sha256OfText(notesBody);
  const planId = 'project-close-' + sha256OfText(`${pagePath}|${notesPath}|${currentSha}|${proposedSha}|${sha256OfText(oldNotes)}|${notesSha}`);
  const result: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Close a Project Hub item',
    project_slug: options.slug,
    page_path: pagePath,
    section: item.section,
    item: block[0]!.trim(),
    item_lines: block.length,
    notes_page_path: notesPath,
    notes_page_existed: notesExisted,
    pointer_change: pointerChange,
    pointer,
    replaced_pointer: replacedPointer,
    plan_id: planId,
    current_sha256: currentSha,
    proposed_sha256: proposedSha,
    notes_page_sha256: notesSha,
    proof: 'passed',
    confirmation_required: false,
  };
  return { slug: options.slug, hubRoot, pagePath, pageFull, raw, currentBody, proposedBody, section: item.section, block, blockStart: item.start, blockEnd: item.end, notesName, notesPath, notesFull, notesExisted, oldNotes, notesBody,
    pointer, pointerChange, replacedPointer, planId, result };
}

/** `hub edit --mode close-item`: the plan, and unless `--preflight`, the write. A given `--plan-id` must be this one. */
export function closeItem(workspace: string, options: CloseOptions): Record<string, PsJsonValue> {
  const marker = readMarker(workspace);
  if (marker === null || String(marker['backend'] ?? '') !== 'local') {
    refuse("close-item moves an item within a local Library's own collection, and this workspace is attached to Basic Memory. Nothing was written.");
  }
  const plan = planCloseItem(workspace, options);
  if (options.preflight) return plan.result;
  if (options.planId && options.planId !== plan.planId) {
    refuse(`close-item was given a --plan-id that is not this edit's: the page or its history page changed since the preview. Run --preflight again. Nothing was written.`);
  }
  return applyCloseItem(workspace, options, plan);
}

function applyCloseItem(workspace: string, options: CloseOptions, plan: ClosePlan): Record<string, PsJsonValue> {
  const now = new Date();
  // Milliseconds in the name: a rolled-back close and its retry in the same second have the same plan, and the journal is created exclusively.
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1').replace('T', '-');
  const journalPath = path.join(workspace, 'internal', 'publication-journals', `project-close-${plan.slug}-${stamp}-${plan.planId.substring(plan.planId.length - 8)}.json`);
  const relativeJournal = path.relative(workspace, journalPath).replace(/\\/g, '/');
  const gateOptions: Options = { slug: plan.slug, page: '_project', sections: [], note: null, seat: options.seat };
  let journalCreated = false;
  let prior: UndoPathBefore[] = [];
  const saveJournal = (state: string, errorText: string): void => {
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-close-item',
      timestamp_utc: now.toISOString(),
      project_slug: plan.slug,
      page_path: plan.pagePath,
      notes_page_path: plan.notesPath,
      notes_page_previous_state: plan.notesExisted ? 'present' : 'absent',
      approved_plan_id: plan.planId,
      previous_sha256: String(plan.result['current_sha256']),
      proposed_sha256: String(plan.result['proposed_sha256']),
      notes_page_sha256: String(plan.result['notes_page_sha256']),
      previous_raw: plan.raw,
      previous_notes: plan.oldNotes,
      error: errorText,
      ...(state === 'complete' ? { undo: undoBlock(workspace, { kind: 'hub-tidy', seat: requireSeat({ seat: options.seat, stateDirectory: path.join(workspace, '.claude') }), locks: [`projects/${plan.slug}`], before: prior }) } : {}),
    };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, psConvertToJson(journal), { encoding: 'utf8', flag: journalCreated ? 'w' : 'wx' });
    journalCreated = true;
  };
  const sameText = (left: string, right: string): boolean => left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
  let lock: BookLock | null = null;
  let notesWritten = false;
  let pageWritten = false;
  try {
    lock = enterBookLock(workspace, `projects/${plan.slug}`, options.lockTimeout);
    // AGAIN, UNDER THE LOCK: the Desk, the Hub, the root and its newest history page as planned.
    gate(workspace, gateOptions, plan.hubRoot, `notes/${plan.notesName}.md`);
    const raw = fs.readFileSync(plan.pageFull, 'utf8').replace(/^﻿/, '');
    if (!sameText(removeFrontmatter(raw), plan.currentBody)) refuse(`Page '${plan.pagePath}' changed after this close was planned, so nothing was written. Run it again.`);
    const scan = historyScan(plan.hubRoot);
    const newest = scan.highest > 0 ? scan.previous : null;
    if ((plan.notesExisted ? plan.notesName : null) !== newest) refuse(`A history page was made on this Hub after this close was planned, so nothing was written. Run it again.`);
    if (plan.notesExisted ? fs.readFileSync(plan.notesFull, 'utf8') !== plan.oldNotes : lexists(plan.notesFull)) {
      refuse(`'${plan.notesPath}' changed after this close was planned, so nothing was written. Run it again.`);
    }
    prior = capturePriorBytes(workspace, [plan.pageFull, plan.notesFull]);
    saveJournal('pending', '');
    fs.mkdirSync(path.dirname(plan.notesFull), { recursive: true });
    if (plan.notesExisted) writeAtomicText(plan.notesFull, plan.notesBody);
    else {
      // A NEW PAGE COUNTS AS WRITTEN ONCE IT EXISTS, as `hub tidy` makes one: opened exclusively first, so a body write
      // that throws still leaves the rollback a page to remove.
      const descriptor = fs.openSync(plan.notesFull, 'wx');
      notesWritten = true;
      try {
        if (closeFault() === 'write') refuse(`A test fault stopped the write of ${plan.notesPath} after the file was made.`);
        const written = fs.writeSync(descriptor, plan.notesBody, null, 'utf8');
        if (written !== Buffer.byteLength(plan.notesBody, 'utf8')) refuse(`Only ${written} of ${Buffer.byteLength(plan.notesBody, 'utf8')} bytes of ${plan.notesPath} were written.`);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    notesWritten = true;
    saveJournal('notes-written', '');
    const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)*/.exec(raw);
    writeAtomicText(plan.pageFull, head ? head[0] + plan.proposedBody : plan.proposedBody);
    pageWritten = true;
    saveJournal('page-written', '');
    const notesBack = fs.readFileSync(plan.notesFull, 'utf8');
    const pageBack = removeFrontmatter(fs.readFileSync(plan.pageFull, 'utf8').replace(/^﻿/, ''));
    if (!sameText(pageBack, plan.proposedBody) || notesBack !== plan.notesBody) refuse(`The close was written but did not read back as planned: ${plan.pagePath}, ${plan.notesPath}`);
    // The block the plan selected, by its planned lines: never found again, since the same text may stand earlier on the page.
    const problems = closeItemProof({ currentBody: plan.currentBody, proposedBody: pageBack, blockStart: plan.blockStart, blockEnd: plan.blockEnd, oldNotes: plan.oldNotes, notesBody: notesBack, pointer: plan.pointer });
    if (problems.length) refuse(`The proof failed on what was read back: ${problems.join('; ')}`);
    saveJournal('complete', '');
  } catch (error) {
    const failure = (error as Error).message;
    if (!notesWritten && !pageWritten) {
      exitBookLock(lock);
      lock = null;
      throw error;
    }
    const problems: string[] = [];
    if (pageWritten) {
      try { writeAtomicText(plan.pageFull, plan.raw); } catch (undo) { problems.push(`the root was not restored (${(undo as Error).message})`); }
    }
    try {
      if (plan.notesExisted) writeAtomicText(plan.notesFull, plan.oldNotes);
      else fs.rmSync(plan.notesFull, { force: true });
    } catch (undo) { problems.push(`the history page was not restored (${(undo as Error).message})`); }
    saveJournal(problems.length ? 'recovery-required' : 'rolled-back', problems.length ? `${failure}; not undone: ${problems.join('; ')}` : failure);
    refuse(`The close was not made. ${failure}. ${problems.length ? `Rollback: ${problems.join('; ')}; read ${relativeJournal}.` : `The root and the history page were restored. The journal is ${relativeJournal}.`}`);
  } finally {
    exitBookLock(lock);
  }
  return {
    ...plan.result,
    written: true,
    status: 'written',
    journal: relativeJournal,
    next: `The item is on [[${plan.notesPath.replace(/\.md$/, '')}]], ticked; the root's ## ${plan.section} points there with its Closed items line.`,
    shared_library_write: false,
  };
}
