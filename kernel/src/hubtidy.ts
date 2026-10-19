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
import { entryLabel, fencedLineMask, headings, joinLines, pageSizeRemedy, pageSizeStatus, removeFrontmatter, sectionSpan, toLines, topLevelEntries } from './hubedit.ts';
import { tickedEntries } from './hubpages.ts';

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
    `^Tidied \\d{4}-\\d{2}-\\d{2}: \\d+ items? moved word for word to \\[\\[projects/${slug}/notes/(\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]+-history-tidy-(\\d+))\\]\\] \\(tidy \\2\\); that page links the one before it\\.$`,
  );
}

export function pointerLine(date: string, count: number, slug: string, notesName: string, number: number): string {
  return `Tidied ${date}: ${count} ${count === 1 ? 'item' : 'items'} moved word for word to [[projects/${slug}/notes/${notesName}]] (tidy ${number}); that page links the one before it.`;
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
  const hubRoot = path.join(workspace, 'collection', 'projects', options.slug);
  const pagePath = `projects/${options.slug}/${options.page}.md`;
  const pageFull = path.join(hubRoot, ...`${options.page}.md`.split('/'));
  gate(workspace, options, hubRoot, null);
  if (!lexists(pageFull) || !fs.statSync(pageFull).isFile()) refuse(`Page '${pagePath}' does not exist. Nothing was written.`);
  const raw = fs.readFileSync(pageFull, 'utf8').replace(/^﻿/, '');
  const currentBody = removeFrontmatter(raw);
  const lines = toLines(currentBody);
  const fenced = fencedLineMask(lines);
  const date = localDate(now);

  // THE SELECTION. Ticked blocks of Now and Next, then the named sections, each refused by name when it may not move.
  const ticked = tickedEntries(currentBody);
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
  };
  if (ticked.length === 0 && movedSections.length === 0) {
    return {
      slug: options.slug, page: options.page, pagePath, hubRoot, pageFull, raw, currentBody, proposedBody: currentBody, notesName, notesPath, notesFull, notesBody: '',
      number, previous: previousLink, planId: '', nothing: true,
      result: {
        ...base,
        nothing_selected: true,
        moved: [],
        moved_sections: [],
        message: `Nothing to move on '${pagePath}': no ticked item in Now or Next${options.sections.length ? '' : ', and no --section named'}. Nothing was written.`,
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
    if (host) touch(host, 1, host.end);
    else touch({ heading: -1, start: 0, end: 0, name: null }, 1, 0);
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
      if (fenced[i] || removed.has(i)) continue;
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
  const insertAt = new Map<number, string>();
  for (const entry of shortened.values()) {
    const line = pointerLine(date, entry.count, options.slug, notesName, number);
    pointers.push(line);
    insertAt.set(entry.at, line);
  }
  const out: { text: string; orig: number | null }[] = [];
  for (let i = 0; i <= lines.length; i++) {
    const pointer = insertAt.get(i);
    if (pointer !== undefined) out.push({ text: '', orig: null }, { text: pointer, orig: null }, { text: '', orig: null });
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
  for (const section of ['Now', 'Next'] as const) {
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
        `the history page's number or the page before it changed since the preview; the page reads ${String(plan.result['current_sha256'])} now. Nothing was written.`,
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

function applyTidy(workspace: string, options: Options, plan: TidyPlan, timeoutSeconds: number): Record<string, PsJsonValue> {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const journalPath = path.join(
    workspace,
    'internal',
    'publication-journals',
    `project-tidy-${plan.slug}-${pageWord(plan.page)}-${stamp}-${plan.planId.substring(plan.planId.length - 8)}.json`,
  );
  const relativeJournal = path.relative(workspace, journalPath).replace(/\\/g, '/');
  let journalCreated = false;
  const saveJournal = (state: string, errorText: string, surviving: string[] = []): void => {
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-tidy',
      timestamp_utc: now.toISOString(),
      project_slug: plan.slug,
      page_path: plan.pagePath,
      notes_page_path: plan.notesPath,
      notes_page_previous_state: 'absent',
      approved_plan_id: plan.planId,
      previous_sha256: String(plan.result['current_sha256']),
      proposed_sha256: String(plan.result['proposed_sha256']),
      notes_page_sha256: String(plan.result['notes_page_sha256']),
      previous_body: plan.currentBody,
      previous_raw: plan.raw,
      surviving_paths: surviving,
      error: errorText,
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
    notes_page_path: plan.notesPath,
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
