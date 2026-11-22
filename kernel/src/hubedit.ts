/**
 * `library hub edit`: tools/Edit-ProjectHub.ps1, step for step (S16's Hub-edit half, S34).
 *
 * TWO HALVES, AS THE ORACLE HAS THEM. The body editing is pure text -- `New-ProjectBodyRaw`, the `Now`
 * structure rule, the change counts and the three size warnings -- and is exported so the self-test can
 * hold it against the oracle's own functions without a collection. The rest is the oracle's order: the
 * write fence, the collection id, the page name, the arguments, THIS SEAT'S Desk, one read, the plan, and
 * then -- only when not a preflight -- the Hub's lock, a re-read that must still match the plan, the
 * journal, the write, a readback that must equal the approved text, and the journal closed.
 *
 * WHERE IT READS AND WRITES. Basic Memory, through `basicmemory.ts`, when the workspace is attached; the
 * local collection (`collection/projects/<slug>/`) when it is not. The oracle has no local half, so the
 * local half is this kernel's, under the approved delta `hubs-can-be-local` -- the same text rules, the
 * same journal, and a local page has no frontmatter to strip.
 *
 * WHAT IS NOT CARRIED. The oracle writes its size warnings with `Write-Warning`, which a caller across a
 * process boundary sees on the host rather than in the result; here they go to stderr as `WARNING: ...`.
 * No row reaches one yet -- a new Hub's page is far below every threshold -- so that spelling is stated,
 * not measured. The preflight reports them in the result either way, as the oracle's does.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { resolveContentPath } from './contentpath.ts';
import { argumentTable } from './verbs.ts';
import { readMarker } from './workspace.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { writeAtomicBytes, writeAtomicText } from './fsx.ts';
import { pageComparisonSha256, sha256OfBytes, sha256OfText } from './sha.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { McpSession, readExactOrNull, refuseRetiredWriter, resolveCollectionId, resolveMcpUrl, sendWrite } from './basicmemory.ts';
import { assertCollectionWriteAllowed } from './ownership.ts';
import { hubNewPage } from './hubnewpage.ts';
import { postedHeader } from './kickoffcheck.ts';
import { withInlineCutWarning } from './inlinecut.ts';
import { hubSlug } from './hubslug.ts';
import { strayControlRefusal } from './controlchars.ts';
import { localDate } from './localdate.ts';
import { capturePriorBytes, undoBlock, type UndoPathBefore } from './journal.ts';
import { assertInsideRoot } from './pagepath.ts';
import { seatConversationRecord } from './desk.ts';

class HubEditRefusal extends Error {}

export function hubRefusalJson(action: string, message: string): Record<string, PsJsonValue> {
  // Fixed openings: '<mode> is not yet performed: rerun the current preflight',
  // '<mode> was given a --plan-id that is not this edit\'s', and 'hub tidy is not yet performed: rerun the current preflight'.
  const stale = /^(?:remove-page|remove-section|replace-section|replace-body|replace-item|hub tidy) is not yet performed: rerun the current preflight/.test(message) ||
    /^(?:add-section|append-section|check-item|close-item|insert-item) was given a --plan-id that is not this edit's/.test(message);
  return { schema: 1, status: 'refused', verb: `hub ${action}`, reason: stale ? 'stale-plan' : 'refused', message };
}

function refuse(message: string): never {
  throw new HubEditRefusal(message);
}

/**
 * A HUB PAGE'S LIMIT FOLLOWS HOW OFTEN IT IS READ (kickoffs/s125 row 1; ADR-0082). `_project` and `connections` at the
 * Hub root are read on every return to the Hub, by every seat; every other page only when a seat asks for it. The
 * on-demand figure is provisional (PLAN-tidy-redesign.md): a readability floor for one reader call, not a token budget.
 * `notes/` pages and the `limits` page stay exempt (`sizeExempt`).
 */
export const PAGE_SIZE_LIMITS = { 'every-session': 40000, 'on-demand': 56000 } as const;
export type PageKind = keyof typeof PAGE_SIZE_LIMITS;

/** `every-session` for the Hub root's `_project` and `connections`, given bare or as `projects/<slug>/<page>.md`. */
export function pageKind(pagePath: string): PageKind {
  const normalized = pagePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return /^(?:projects\/[^/]+\/)?(?:_project|connections)(?:\.md)?$/.test(normalized) ? 'every-session' : 'on-demand';
}

export function pageLimitBytes(pagePath: string): number {
  return PAGE_SIZE_LIMITS[pageKind(pagePath)];
}

export const SECTION_SIZE_THRESHOLD = 12000;
export const ENTRY_SIZE_THRESHOLD = 1200;

export const EDIT_MODES = ['AddSection', 'AppendSection', 'RemoveSection', 'RemovePage', 'ReplaceSection', 'ReplaceBody', 'CheckItem', 'ReplaceItem', 'InsertItem', 'CloseItem'] as const;
export type EditMode = (typeof EDIT_MODES)[number];
const SECTION_MODES: EditMode[] = ['AddSection', 'AppendSection', 'RemoveSection', 'ReplaceSection'];
const ITEM_MODES: EditMode[] = ['CheckItem', 'ReplaceItem', 'InsertItem'];

// --- body editing: pure text ------------------------------------------------------------------------

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

export function toLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function joinLines(lines: string[]): string {
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

export function removeTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end--;
  return lines.slice(0, end);
}

/** `Remove-Frontmatter`. */
export function removeFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text);
  return match ? match[1]!.replace(/^[\r\n]+/, '') : text;
}

/** `Get-FencedLineMask`: a heading inside a fenced code block is content, not structure. */
export function fencedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceCharacter = '';
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!fenceCharacter) {
      const open = /^[ ]{0,3}((`{3,}|~{3,}))(.*)$/.exec(line);
      if (open) {
        fenceCharacter = open[1]!.substring(0, 1);
        fenceLength = open[1]!.length;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    const escaped = fenceCharacter === '`' ? '`' : '~';
    if (new RegExp(`^[ ]{0,3}(${escaped}{${fenceLength},})\\s*$`).test(line)) {
      fenceCharacter = '';
      fenceLength = 0;
    }
  }
  return mask;
}

/** Where `<!--` opens in `text` outside a backtick code span, from `from` on, or -1. */
function commentOpenAt(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(run, i + run.length);
      // An unmatched backtick run is text; a matched one is a code span, whose `<!--` is text too.
      if (close >= 0 && text.slice(close, close + run.length + 1) !== run + '`') { i = close + run.length - 1; continue; }
      i += run.length - 1;
      continue;
    }
    if (text.startsWith('<!--', i)) return i;
  }
  return -1;
}

/**
 * ONE READING OF WHAT A PAGE SHOWS (kickoffs/s213-r5 row 2; s198 row 1, s213-r4 row 4). The page is read once, top to
 * bottom. A fence (three or more backticks or tildes, up to three spaces in) runs to a line of the same character at
 * least as long, or to the page's end. An HTML comment runs from its `<!--` through the `-->` that closes it: at a line's
 * start (up to three spaces in) it runs to that `-->` wherever it is; opened after text on its line, outside a code span,
 * it is a comment when a `-->` follows before the next blank line, and text otherwise. A fence marker inside a comment
 * and a comment marker inside a fence are text. Each entry is the line's shown text (its parts outside comments, edge
 * spaces left by a removed comment trimmed at the end), or null when nothing of the line is shown.
 */
export function shownText(lines: string[]): (string | null)[] {
  return scanShown(lines).shown;
}

/** A fence or HTML comment still open at the end of the lines read: its kind and the index of the line that opened it. */
export interface OpenBlock {
  kind: 'fence' | 'comment';
  index: number;
}

/** `shownText`'s one pass, also naming the fence or comment left open after the last line (kickoffs/s213-r5 row 3). */
function scanShown(lines: string[]): { shown: (string | null)[]; open: OpenBlock | null } {
  const out: (string | null)[] = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  let inComment = false;
  let openedAt = -1;
  const closesBeforeBlank = (index: number, rest: string): boolean => {
    if (rest.includes('-->')) return true;
    for (let j = index + 1; j < lines.length && !isBlank(lines[j]); j++) if (lines[j]!.includes('-->')) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceCharacter) {
      if (new RegExp(`^[ ]{0,3}${fenceCharacter === '`' ? '`' : '~'}{${fenceLength},}\\s*$`).test(line)) fenceCharacter = '';
      out.push(null);
      continue;
    }
    if (!inComment) {
      const open = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fenceCharacter = open[1]!.substring(0, 1);
        fenceLength = open[1]!.length;
        openedAt = i;
        out.push(null);
        continue;
      }
    }
    let text = '';
    let at = 0;
    let hadComment = false;
    while (at <= line.length) {
      if (inComment) {
        hadComment = true;
        const close = line.indexOf('-->', at);
        if (close < 0) { at = line.length + 1; break; }
        inComment = false;
        at = close + 3;
        continue;
      }
      const open = commentOpenAt(line, at);
      if (open < 0) { text += line.slice(at); break; }
      const lineStart = /^[ ]{0,3}$/.test(line.slice(0, open)) && at === 0;
      if (!lineStart && !closesBeforeBlank(i, line.slice(open + 4))) {
        text += line.slice(at, open + 4);
        at = open + 4;
        continue;
      }
      text += line.slice(at, open);
      inComment = true;
      openedAt = i;
      at = open + 4;
    }
    out.push(!hadComment ? text : isBlank(text) ? null : text.replace(/[ \t]+$/, ''));
  }
  const open: OpenBlock | null = fenceCharacter ? { kind: 'fence', index: openedAt } : inComment ? { kind: 'comment', index: openedAt } : null;
  return { shown: out, open };
}

export interface Heading {
  index: number;
  level: number;
  text: string;
}

/** The level-one and level-two headings on shown lines (`shownText`): one in a fence or an HTML comment is content. */
export function headings(lines: string[]): Heading[] {
  const shown = shownText(lines);
  const found: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = shown[i];
    if (text === null || text === undefined) continue;
    const match = /^[ ]{0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(text);
    if (match) found.push({ index: i, level: match[1]!.length, text: match[2]! });
  }
  return found;
}

/** A shown line of `## Next`: its index in the page and its shown text. */
export interface ShownLine {
  index: number;
  text: string;
}

/**
 * THE ONE READING OF `## Next` (kickoffs/s213-r5 row 2): the shown lines (`shownText`) under every level-two `## Next`
 * heading of a page, in page order, each section ending at the next heading `headings` finds; null when the page has
 * no `## Next`. `kickoff next`, `kickoff check --open`, `kickoff receive`'s pointer stage and `hub edit`'s pointer rules
 * all read this, so a page cannot hold a pointer one of them sees and another does not.
 */
export function nextShownLines(lines: string[]): ShownLine[] | null {
  const shown = shownText(lines);
  const all = headings(lines);
  const found: ShownLine[] = [];
  let any = false;
  all.forEach((heading, at) => {
    if (heading.level !== 2 || heading.text !== 'Next') return;
    any = true;
    const end = all[at + 1]?.index ?? lines.length;
    for (let i = heading.index + 1; i < end; i++) {
      const text = shown[i];
      if (text !== null && text !== undefined) found.push({ index: i, text });
    }
  });
  return any ? found : null;
}

export interface Span {
  start: number;
  end: number;
}

/**
 * A DEV HUB (PLAN-hub-redesign.md section 3; ADR-0003, ADR-0009; kickoffs/s213): a Hub root with a level-two `## Repo`
 * heading outside fenced code. Only `deskpost hub new --dev` seeds one (`collection.ts` `devSections`).
 */
export function isDevHubBody(body: string): boolean {
  return headings(toLines(body)).some((heading) => heading.level === 2 && heading.text === 'Repo');
}

/** The most pending `Run` pointers a dev Hub's `## Next` holds (PLAN-hub-redesign.md amendment A1, A1-09). */
export const RUN_QUEUE_CAP = 3;

/** The largest new top-level item of a dev Hub root's `## Now` or `## Next` (PLAN-hub-redesign.md section 3). */
export const DEV_ITEM_LIMIT = 600;
/** The largest new `## Decisions` entry of a dev Hub root (PLAN-hub-redesign.md section 3). */
export const DEV_DECISION_LIMIT = 400;

/** Whether `id` is an item of this Library's train register; false when there is none or it cannot be read. */
export function trainIdKnown(workspace: string, id: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(workspace, 'internal', 'train', 'register.json'), 'utf8')) as { items?: { id?: unknown }[] };
    return Array.isArray(record.items) && record.items.some((item) => item?.id === id);
  } catch {
    return false;
  }
}

/**
 * What a record reference is (PLAN-hub-redesign.md section 3): a train id in backticks that the register holds, a
 * `[[projects/...]]` or `[[books/...]]` link, a `kickoffs/` id, a letter or Report path (`notes/<date>-<words>`), or a
 * `PLAN-*.md`.
 */
export function namesRecord(text: string, knownTrainId: (id: string) => boolean): boolean {
  if (/\[\[(?:projects|books)\/[^\]]+\]\]/.test(text)) return true;
  if (/(?:^|[^\w-])kickoffs\/[A-Za-z0-9._-]+/.test(text)) return true;
  if (/(?:^|[^\w/])notes\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+/.test(text)) return true;
  if (/\bPLAN-[A-Za-z0-9-]+\.md\b/.test(text)) return true;
  return [...text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)].some((match) => knownTrainId(match[1]!));
}

/**
 * THE ROOT OF A DEV HUB HOLDS POINTERS (PLAN-hub-redesign.md section 3; kickoffs/s213 row 22). On a Hub with `## Repo`,
 * an edit may not add or replace a top-level item of `## Now` or `## Next` that runs past DEV_ITEM_LIMIT bytes or names
 * no record, nor add a `## Decisions` entry past DEV_DECISION_LIMIT bytes or with no link. Only new text is judged: an
 * item already on the page, ticked or not, is never refused, so no Hub breaks on upgrade; a Hub without `## Repo` is
 * unchanged. The refusal says where the wording goes and names `close-item` for what is done.
 */
export function devHubPointerProblem(currentBody: string, proposedBody: string, slug: string, knownTrainId: (id: string) => boolean): string | null {
  if (!isDevHubBody(proposedBody)) return null;
  // The top-level list entries of a section; for `## Decisions` also each top-level paragraph, a run of non-blank lines
  // outside a fence that is not a list item (kickoffs/s213-r3 row 4), so prose is judged like an entry.
  const blocksOf = (body: string, section: string): string[] => {
    const lines = toLines(body);
    const span = sectionSpan(lines, section);
    if (span === null) return [];
    const fenced = fencedLineMask(lines);
    const out: string[] = [];
    let paragraph: number[] = [];
    const flush = () => { if (paragraph.length) out.push(lines.slice(paragraph[0]!, paragraph[paragraph.length - 1]! + 1).join('\n')); paragraph = []; };
    for (const block of itemBlocks(lines, span.start + 1, span.end)) {
      if (fenced[block.start]) { flush(); continue; }
      if (topLevelEntries(lines, block.start, block.start + 1).length > 0) { flush(); out.push(removeTrailingBlank(lines.slice(block.start, block.end + 1)).join('\n')); continue; }
      if (section !== 'Decisions' || isListLine(lines[block.start]!)) { flush(); continue; }
      if (paragraph.length && block.start !== paragraph[paragraph.length - 1]! + 1) flush();
      paragraph.push(block.start);
    }
    flush();
    return out;
  };
  const unticked = (text: string) => text.replace(/^([ \t]*(?:[-*+]|[0-9]+\.)[ \t]+)\[[xX]\]/, '$1[ ]');
  const remedy = `Put the wording, quotes and hashes in the record and point to it here; close what is done with deskpost hub edit ${slug} --mode close-item --match-text "<text>". Nothing was written.`;
  for (const section of ['Now', 'Next']) {
    const had = new Set(blocksOf(currentBody, section).map(unticked));
    for (const block of blocksOf(proposedBody, section)) {
      if (had.has(unticked(block))) continue;
      const bytes = Buffer.byteLength(block, 'utf8');
      const named = namesRecord(block, knownTrainId);
      if (bytes <= DEV_ITEM_LIMIT && named) continue;
      const why = [bytes > DEV_ITEM_LIMIT ? `it is ${bytes} bytes, over ${DEV_ITEM_LIMIT}` : '', named ? '' : 'it names no record'].filter(Boolean).join(' and ');
      return `On a dev Hub, an item in ## ${section} is a short pointer to its record: at most ${DEV_ITEM_LIMIT} bytes, naming a train id in backticks, a [[projects/...]] or [[books/...]] link, a kickoffs/ id, a letter or Report path (notes/<date>-<words>) or a PLAN-*.md. This item is refused because ${why}: ${block.split('\n')[0]!.trim().slice(0, 120)}. ${remedy}`;
    }
  }
  const had = new Set(blocksOf(currentBody, 'Decisions'));
  for (const block of blocksOf(proposedBody, 'Decisions')) {
    if (had.has(block)) continue;
    const bytes = Buffer.byteLength(block, 'utf8');
    const linked = /\[\[[^\]]+\]\]/.test(block) || /\bPLAN-[A-Za-z0-9-]+\.md\b/.test(block);
    if (bytes <= DEV_DECISION_LIMIT && linked) continue;
    const why = [bytes > DEV_DECISION_LIMIT ? `it is ${bytes} bytes, over ${DEV_DECISION_LIMIT}` : '', linked ? '' : 'it links no record'].filter(Boolean).join(' and ');
    return `On a dev Hub, a ## Decisions entry is a one-line pointer: at most ${DEV_DECISION_LIMIT} bytes, with a [[...]] link to its record. This entry is refused because ${why}: ${block.split('\n')[0]!.trim().slice(0, 120)}. Put the decision's wording in the linked record (a dated record page) and point to it here; close the Now or Next item it finishes with deskpost hub edit ${slug} --mode close-item --match-text "<text>". Nothing was written.`;
  }
  return null;
}

/**
 * The unit a Run line names, twice: `id <id>` from `Run <id>:` and `page <id>` from its `kickoffs/<id>` link (A1-07),
 * lowercased, since `kickoff check --open` matches ids ignoring case: `Run S1:` and `Run s1:` are one unit.
 */
function runPointerKeys(line: string): string[] {
  const keys: string[] = [];
  const id = /\bRun ([A-Za-z0-9._-]+):/.exec(line)?.[1];
  if (id !== undefined) keys.push(`id ${id.toLowerCase()}`);
  const page = /\[\[projects\/[^\]/]+\/kickoffs\/([^\]|#]+)/.exec(line)?.[1];
  if (page !== undefined) keys.push(`page ${page.toLowerCase()}`);
  return keys;
}

export function sectionSpan(lines: string[], section: string): Span | null {
  const all = headings(lines);
  let start = -1;
  for (const heading of all) {
    if (heading.level === 2 && heading.text === section) {
      if (start >= 0) refuse(`Section '${section}' appears more than once on this page; edit it by hand or name a unique section.`);
      start = heading.index;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (const heading of all) {
    if (heading.index > start) {
      end = heading.index;
      break;
    }
  }
  return { start, end };
}

/**
 * The shown lines under every level-two `## Next` heading of a body, together (`nextShownLines`); unlike sectionSpan it
 * never refuses a repeat. A `Run` line in a fence or an HTML comment is an example, not a pointer.
 */
export function nextSectionLines(body: string): string[] {
  return (nextShownLines(toLines(body)) ?? []).map((line) => line.text);
}

export function sectionText(lines: string[], span: Span | null): string {
  if (span === null) return '';
  return removeTrailingBlank(lines.slice(span.start, span.end)).join('\n');
}

/** A Markdown table row: its first non-blank character is `|`. */
function isTableLine(line: string): boolean {
  return /^[ \t]{0,3}\|/.test(line);
}

/** `Test-ListLine`, whose `-match` is case-insensitive -- which no character in it can feel. */
function isListLine(line: string): boolean {
  return /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+/.test(line);
}

export interface Entry {
  index: number;
  line: string;
  hasStatus: boolean;
}

export function topLevelEntries(lines: string[], start: number, end: number): Entry[] {
  const shown = shownText(lines);
  const entries: Entry[] = [];
  for (let i = start; i < end; i++) {
    const line = shown[i];
    if (line == null) continue;
    const match = /^(?:[-*+]|[0-9]+\.)[ \t]+(.*)$/.exec(line);
    if (match) entries.push({ index: i, line: lines[i]!, hasStatus: /^\[[ xX]\](?:[ \t]+|$)/.test(match[1]!) });
  }
  return entries;
}

export function linesPreserved(oldLines: string[], newLines: string[]): boolean {
  const oldMeaningful = oldLines.filter((line) => !isBlank(line));
  const newMeaningful = newLines.filter((line) => !isBlank(line));
  let cursor = 0;
  for (const line of oldMeaningful) {
    while (cursor < newMeaningful.length && newMeaningful[cursor] !== line) cursor++;
    if (cursor >= newMeaningful.length) return false;
    cursor++;
  }
  return true;
}

function insideList(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isBlank(line)) return false;
    if (isListLine(line)) return true;
    if (/^[ \t]+\S/.test(line)) continue;
    return false;
  }
  return false;
}

/**
 * The index just past the section's last list item and its continuation lines, or -1 when it has no list. A list line
 * inside fenced code or an HTML comment is an example, not an item (kickoffs/s213-r4 row 4): taking it as the last item
 * put an appended pointer inside the fence, where neither the pointer count nor kickoff receive could see it.
 */
function lastListEnd(lines: string[]): number {
  const shown = shownText(lines);
  let last = -1;
  for (let i = 1; i < lines.length; i++) if (shown[i] !== null && isListLine(shown[i]!)) last = i;
  if (last < 0) return -1;
  // The item runs on over its indented lines, and over every line of a fence or comment one of them opened, blank ones
  // too (kickoffs/s213-r5 row 3): a blank line inside an item's fenced example does not end the item.
  let end = last + 1;
  let hiddenRun = false;
  while (end < lines.length) {
    const hidden = shown[end] === null;
    if (/^[ \t]+\S/.test(lines[end]!)) hiddenRun = hidden;
    else if (!(hidden && hiddenRun)) break;
    end++;
  }
  return end;
}

export interface Block {
  start: number;
  end: number;
}

/** A line's indent in columns, a tab counting four. */
function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
}

/**
 * AN ITEM KEEPS ITS NESTED LIST (S87, ruling 5; backlog Row F): a list item's block runs to the next list line at the
 * same or a lesser indent, or to a blank line followed by a line with no indent, so its sub-list and its continuation
 * lines go with it. Before S87 it ended at the first nested `  - ` line, and `replace-item` left the sub-list behind.
 * A nested item is a block of its own as well, so blocks may nest, and `findUniqueBlock` picks the innermost. Any
 * other line no item holds is a block of one line, as before.
 */
export function itemBlocks(lines: string[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let heldUntil = -1;
  for (let index = start; index < end; index++) {
    const line = lines[index]!;
    if (!isListLine(line)) {
      if (!isBlank(line) && index > heldUntil) blocks.push({ start: index, end: index });
      continue;
    }
    const indent = indentOf(line);
    let last = index;
    let scan = index + 1;
    while (scan < end) {
      const next = lines[scan]!;
      if (isBlank(next)) {
        let after = scan + 1;
        while (after < end && isBlank(lines[after])) after++;
        if (after >= end || !/^[ \t]+\S/.test(lines[after]!)) break;
        scan = after;
        continue;
      }
      if (isListLine(next) ? indentOf(next) <= indent : !/^[ \t]+\S/.test(next)) break;
      last = scan;
      scan++;
    }
    blocks.push({ start: index, end: last });
    heldUntil = Math.max(heldUntil, last);
  }
  return blocks;
}

/** True when `inner` lies inside `outer`. */
function within(inner: Block, outer: Block): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function findUniqueBlock(lines: string[], start: number, end: number, matchText: string, checkboxOnly = false): Block {
  if (isBlank(matchText)) refuse('MatchText is required: give text that appears in exactly one item or line. Nothing was written.');
  let matched = itemBlocks(lines, start, end).filter((block) => lines.slice(block.start, block.end + 1).join(' ').includes(matchText));
  if (checkboxOnly) {
    const checkboxes = matched.filter(block => /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+\[[ xX]\]/.test(lines[block.start]!));
    if (!checkboxes.length && matched.length === 1) setCheckboxState(lines[matched[0]!.start]!, true);
    matched = checkboxes;
    const ownLine = matched.filter(block => lines[block.start]!.includes(matchText));
    if (ownLine.length) matched = ownLine;
  }
  if (matched.length === 0) refuse(`No item or line contains '${matchText}'. Give text from one item of the section, or name the section with --section. Nothing was written.`);
  // TEXT IN A NESTED ITEM MATCHES ITS PARENTS TOO (S87): when the matches nest, one inside the next, the innermost is
  // the item meant, as it was before a block carried its sub-list. Siblings still refuse.
  const innermost = matched.find((block) => matched.every((other) => within(block, other)));
  if (innermost !== undefined) matched = [innermost];
  if (matched.length > 1) {
    const preview = matched
      .slice(0, 4)
      .map((block) => lines[block.start]!.trim())
      .join(' | ');
    refuse(`'${matchText}' matches ${matched.length} items; give text unique to one. Matches begin: ${preview}`);
  }
  return matched[0]!;
}

function setCheckboxState(line: string, checked: boolean): string {
  const match = /^([ \t]*(?:[-*+]|[0-9]+\.)[ \t]+)\[([ xX])\](.*)$/.exec(line);
  if (!match) refuse(`That item is not a checkbox: ${line.trim()}. check-item ticks a - [ ] item; edit this one with replace-item. Nothing was written.`);
  return `${match[1]}[${checked ? 'x' : ' '}]${match[3]}`;
}

/** Keep the matched item's prefix unless the replacement supplies its own list marker. */
function replacementItemLines(line: string, addition: string[]): string[] {
  if (!addition.length) return addition;
  if (isListLine(addition[0]!)) {
    const indent = /^[ \t]/.test(addition[0]!) ? '' : /^[ \t]*/.exec(line)![0];
    return addition.map((part) => part === '' ? '' : indent + part);
  }
  // A LEADING `[ ]` OR `[x]` IN THE CONTENT IS ITS OWN CHECKBOX (kickoffs/s199-r2 item 6): it replaces the kept one, so
  // `[x] New` over `- [ ] Old` writes `- [x] New`, never `- [ ] [x] New`. Only the marker is kept then.
  const ownBox = /^\[[ xX]\](?:[ \t]|$)/.test(addition[0]!);
  const prefix = (ownBox ? /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+/ : /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+(?:\[[ xX]\][ \t]*)?/).exec(line)?.[0];
  return prefix === undefined ? addition : [prefix + addition[0]!, ...addition.slice(1)];
}

/** `New-ProjectBodyRaw`. */
function newProjectBodyRaw(currentBody: string, mode: EditMode, section: string, content: string, matchText: string, uncheck: boolean): string {
  const lines = toLines(currentBody);
  const addition = removeTrailingBlank(toLines(content));
  if (mode === 'RemoveSection') {
    if (!isBlank(content)) refuse('remove-section takes no content.');
    if (!isBlank(matchText)) refuse('remove-section takes no --match-text.');
    if (section === 'Purpose' || section === 'Now' || section === 'Next') refuse(`Section '${section}' is structural and cannot be removed.`);
  }
  if (!['ReplaceBody', 'CheckItem', 'RemoveSection'].includes(mode) && addition.length === 0) refuse('The supplied content is empty.');
  // THE CONTENT IS THE SECTION'S BODY ONLY (S85 row 3, ruling 3, backlog Row E). Content that repeats its own heading
  // was refused as "appears more than once on this page", which blamed the page for the content's mistake. It is
  // refused by name before the page is built, and never stripped: the tool does not guess what the writer meant.
  if (SECTION_MODES.includes(mode) && mode !== 'RemoveSection') {
    const heading = `## ${section}`;
    if (addition.some((line) => line.trim() === heading)) {
      refuse(`The content repeats the heading '${heading}'. --content and --content-path are the section's body only; remove that line.`);
    }
    // ANY OTHER LEVEL-TWO HEADING SPLITS THE SECTION (kickoffs/s122 row 2; the S120 Report "hub edit add-section accepts
    // ## headings in its content"). The page gained a second section, sometimes one it already had (two `## Stall log`
    // on s120-a1). Refused by line before the page is built; a `###` heading stays inside the section.
    const split = addition.findIndex((line) => /^ {0,3}##[ \t]/.test(line));
    if (split >= 0) {
      refuse(
        `Line ${split + 1} of the content is a level-two heading, '${addition[split]!.trim()}', which would end section '${section}' ` +
          "and start another. --section supplies the heading; the content is its body only. Use ### inside a section" +
          (mode === 'AddSection' ? '.' : ', or add-section for a new one.'),
      );
    }
  }

  if (ITEM_MODES.includes(mode)) {
    let start = 0;
    let end = lines.length;
    if (!isBlank(section)) {
      const itemSpan = sectionSpan(lines, section);
      if (itemSpan === null) refuse(`Section '${section}' was not found.`);
      start = itemSpan.start + 1;
      end = itemSpan.end;
    }
    const block = findUniqueBlock(lines, start, end, matchText, mode === 'CheckItem');
    if (mode === 'InsertItem') {
      const anchor = lines[block.start]!;
      if (!isListLine(anchor)) {
        refuse(`The --after line '${anchor.trim().slice(0, 120)}' is not a list item. insert-item goes after a list item. ` +
          'Use --mode append-section --section <name> to add the first item in a section. Nothing was written.');
      }
      const first = addition[0] ?? '';
      if (!isListLine(first)) {
        refuse(`The first content line '${first.trim().slice(0, 120)}' must start with a list marker (-, *, +, or 1.) for --mode insert-item. Nothing was written.`);
      }
      const eol = currentBody.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      const offset = (currentBody.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).slice(0, block.end + 1).join('').length;
      const prefix = currentBody.slice(0, offset);
      const inserted = replacementItemLines(lines[block.start]!, addition).join(eol) + eol;
      return prefix + (prefix.endsWith('\n') || prefix.endsWith('\r') ? '' : eol) + inserted + currentBody.slice(offset);
    }
    const result = lines.slice(0, block.start);
    if (mode === 'CheckItem') {
      result.push(setCheckboxState(lines[block.start]!, !uncheck));
      result.push(...lines.slice(block.start + 1, block.end + 1));
    } else {
      result.push(...replacementItemLines(lines[block.start]!, addition));
    }
    result.push(...lines.slice(block.end + 1));
    return joinLines(result);
  }

  if (mode === 'ReplaceBody') {
    if (addition.length === 0) refuse('replace-body requires a non-empty body.');
    return joinLines(addition);
  }

  const span = sectionSpan(lines, section);
  if (mode === 'AddSection') {
    if (span !== null) refuse(`Section '${section}' already exists; use append-section or replace-section.`);
    const kept = removeTrailingBlank(lines);
    const result: string[] = [];
    if (kept.length) result.push(...kept, '');
    result.push(`## ${section}`, '', ...addition);
    return joinLines(result);
  }

  if (span === null) {
    const available = headings(lines)
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.text);
    refuse(`Section '${section}' was not found. Level-two sections on this page: ${available.length ? available.join(', ') : '(none)'}.`);
  }

  const before = lines.slice(0, span.start);
  const after = lines.slice(span.end);
  const sectionLines = removeTrailingBlank(lines.slice(span.start, span.end));

  if (mode === 'RemoveSection') {
    const kept = removeTrailingBlank(before);
    const result: string[] = [...kept];
    if (kept.length && after.length) result.push('');
    result.push(...after);
    return joinLines(result);
  }

  const result: string[] = [...before];
  if (mode === 'AppendSection') {
    // A bullet added to a list continues that list; prose gets its own paragraph break.
    const continuesList = insideList(sectionLines) && isListLine(addition[0]!);
    // A ROW ADDED TO A TABLE AT THE SECTION'S END continues that table (kickoffs/s102 K4): a blank line would end it.
    const continuesTable = sectionLines.length > 1 && isTableLine(sectionLines[sectionLines.length - 1]!) && isTableLine(addition[0]!);
    // A BULLET ADDED TO A SECTION WHOSE LIST IS FOLLOWED BY PROSE joins that list, before the prose (Report
    // 2026-09-29): appended after the prose, it read as the prose's own item.
    const listEnd = !continuesList && isListLine(addition[0]!) ? lastListEnd(sectionLines) : -1;
    // AN APPENDED LINE IS ALWAYS SHOWN (kickoffs/s213-r5 row 3): text written where a fence or comment is still open
    // would be hidden in it, where no reader of the section sees it, so the append is refused instead.
    const open = scanShown([...before, ...sectionLines.slice(0, listEnd > 0 ? listEnd : sectionLines.length)]).open;
    if (open !== null && open.index >= span.start) {
      const what = open.kind === 'fence' ? 'fence' : 'HTML comment';
      const remedy = open.kind === 'fence' ? `Close the fence with a line of ${/^[ ]*(`+|~+)/.exec(lines[open.index]!)?.[1] ?? '```'} after its last line` : 'Close the comment with -->';
      refuse(`## ${section} ends inside a ${what} that is never closed, opened by '${lines[open.index]!.trim().slice(0, 80)}' (${open.index - span.start} lines below the ## ${section} heading), so an appended line would be hidden in it. ${remedy}, then append again. Nothing was written.`);
    }
    if (listEnd > 0) {
      result.push(...sectionLines.slice(0, listEnd), ...addition, ...sectionLines.slice(listEnd));
    } else {
      result.push(...sectionLines);
      if (!continuesList && !continuesTable) result.push('');
      result.push(...addition);
    }
  } else {
    result.push(sectionLines[0]!, '', ...addition);
  }
  if (after.length) result.push('', ...after);
  return joinLines(result);
}

function lineSequenceInSpan(lines: string[], needle: string[], span: Span | null): boolean {
  if (needle.length === 0 || span === null) return false;
  const lastStart = span.end - needle.length;
  for (let start = span.start + 1; start <= lastStart; start++) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (lines[start + offset] !== needle[offset]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/** `Assert-NowStructure`: `Now` is orientation and open items, every column-zero entry with a status. */
function assertNowStructure(currentBody: string, proposedBody: string, mode: EditMode, section: string, content: string, matchText: string): void {
  if (mode === 'CheckItem') return;
  if (!['AppendSection', 'AddSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem', 'InsertItem'].includes(mode)) return;
  const proposedLines = toLines(proposedBody);
  const proposedSpan = sectionSpan(proposedLines, 'Now');
  if (proposedSpan === null) return;
  let targetsNow = mode === 'ReplaceBody' || section === 'Now';
  if ((mode === 'ReplaceItem' || mode === 'InsertItem') && !targetsNow) {
    const currentLines = toLines(currentBody);
    const currentSpan = sectionSpan(currentLines, 'Now');
    if (currentSpan !== null) targetsNow = sectionText(currentLines, currentSpan) !== sectionText(proposedLines, proposedSpan);
  }
  if (!targetsNow) return;
  if (mode !== 'ReplaceBody') {
    let contentLines = removeTrailingBlank(toLines(content));
    if (mode === 'ReplaceItem' || mode === 'InsertItem') {
      const currentLines = toLines(currentBody);
      const scope = section ? sectionSpan(currentLines, section) : null;
      const block = findUniqueBlock(currentLines, scope ? scope.start + 1 : 0, scope ? scope.end : currentLines.length, matchText, false);
      contentLines = replacementItemLines(currentLines[block.start]!, contentLines);
    }
    if (headings(contentLines).some((heading) => heading.level <= 2)) {
      refuse("Content targeting 'Now' must not contain a level-one or level-two heading.");
    }
    if (!lineSequenceInSpan(proposedLines, contentLines, proposedSpan)) {
      refuse("The resulting 'Now' section does not contain the entire intended addition; the edit stopped without writing.");
    }
  }
  if (topLevelEntries(proposedLines, proposedSpan.start + 1, proposedSpan.end).some((entry) => !entry.hasStatus)) {
    refuse("Every column-zero list entry in 'Now' requires a status marker; add - [ ] or - [x].");
  }
}

/**
 * APPEND-SECTION INTO ONE `###` SUBSECTION (kickoffs/s219 row 5): the lines go at the end of that subsection, before the
 * next `###` or `##` heading, with its trailing blank lines kept after them. The section append's own checks run first
 * (the content, the section, a fence or comment left open), then the subsection is found among the section's shown
 * lines: absent or doubled, the edit is refused naming the subsections the section holds.
 */
function appendToSubsection(currentBody: string, section: string, subsection: string, content: string): string {
  newProjectBody(currentBody, 'AppendSection', section, content, '', false);
  const lines = toLines(currentBody);
  const span = sectionSpan(lines, section);
  if (span === null) refuse(`Section '${section}' was not found. Nothing was written.`);
  const scan = scanShown(lines);
  const headingText = (text: string) => text.trim().replace(/[ \t]+#+$/, '').trimEnd();
  const wanted = headingText(subsection.trim().replace(/^#+/, ''));
  const subheadings: { index: number; text: string }[] = [];
  for (let i = span.start + 1; i < span.end; i++) {
    const match = /^[ ]{0,3}###[ \t]+(.+?)[ \t]*$/.exec(scan.shown[i] ?? '');
    if (match) subheadings.push({ index: i, text: headingText(match[1]!) });
  }
  const named = subheadings.filter((heading) => heading.text === wanted);
  const held = subheadings.length ? subheadings.map((heading) => `'${heading.text}'`).join(', ') : 'none';
  if (named.length === 0) refuse(`## ${section} holds no subsection '### ${wanted}'. Its subsections: ${held}. Nothing was written.`);
  if (named.length > 1) refuse(`## ${section} holds the subsection '### ${wanted}' ${named.length} times; name a unique one. Its subsections: ${held}. Nothing was written.`);
  const start = named[0]!.index;
  const end = subheadings.find((heading) => heading.index > start)?.index ?? span.end;
  let last = end - 1;
  while (last > start && isBlank(lines[last])) last--;
  const open = scanShown(lines.slice(0, last + 1)).open;
  if (open !== null && open.index > start) {
    refuse(`### ${wanted} ends inside a ${open.kind === 'fence' ? 'fence' : 'HTML comment'} that is never closed, so an appended line would be hidden in it. Close it, then append again. Nothing was written.`);
  }
  const addition = removeTrailingBlank(toLines(content));
  const joins = (isListLine(lines[last]!) && isListLine(addition[0]!)) || (isTableLine(lines[last]!) && isTableLine(addition[0]!));
  const result = [...lines.slice(0, last + 1), ...(joins ? [] : ['']), ...addition, ...lines.slice(last + 1)];
  const proposed = joinLines(result);
  assertNowStructure(currentBody, proposed, 'AppendSection', section, content, '');
  return proposed;
}

/** `New-ProjectBody`: the proposed page, or the refusal that stops the edit before any write. */
export function newProjectBody(currentBody: string, mode: EditMode, section: string, content: string, matchText: string, uncheck: boolean, checkNow = true): string {
  const proposed = newProjectBodyRaw(currentBody, mode, section, content, matchText, uncheck);
  if (checkNow) assertNowStructure(currentBody, proposed, mode, section, content, matchText);
  return proposed;
}

/**
 * EVERY LINE COUNTS, BLANK ONES TOO (S85 row 5, ruling 6): the counts left blank lines out while the line counts beside
 * them did not, so a preview and the page it described disagreed. The field names are kept.
 */
export function changeCounts(oldBody: string, newBody: string): { added_lines: number; removed_lines: number } {
  const oldLines = toLines(oldBody);
  const newLines = toLines(newBody);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const count = oldCounts.get(line) ?? 0;
    if (count > 0) oldCounts.set(line, count - 1);
    else added++;
  }
  let removed = 0;
  for (const value of oldCounts.values()) removed += value;
  return { added_lines: added, removed_lines: removed };
}

// --- the three size warnings ------------------------------------------------------------------------

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function sizeExempt(pagePath: string): boolean {
  return /(^|\/)(notes\/|limits(\.md)?$)/.test(pagePath.replace(/\\/g, '/'));
}

export function pageSizeRemedy(pagePath: string, body = ''): string {
  const normalized = pagePath.replace(/\\/g, '/');
  if (/(^|\/)connections\.md$/.test(normalized)) return 'Prune entries that no longer earn their place, or split them onto topic pages.';
  if (/(^|\/)_project\.md$/.test(normalized)) {
    const slug = /(?:^|\/)projects\/([^/]+)\/_project\.md$/.exec(normalized)?.[1] ?? '<slug>';
    const tidy = ` Run deskpost hub tidy ${slug} --preflight to move ticked and named items off the page word for word.`;
    const largest = sectionSizes(body).sort((a, b) => b.size_bytes - a.size_bytes)[0];
    if (largest?.section === 'Decisions') {
      return 'Move whole entries from ## Decisions, word for word, to a dated notes/ record page with new-page; leave one grouped pointer line with replace-section.' + tidy;
    }
    return 'Move history to a dated notes/ page, connections to the companion connections page, and accepted limits to the limits page (ADR-0013).' + tidy;
  }
  return 'Move detail onto a linked page and keep this one to what a reader needs on arrival.';
}

export function pageSizeStatus(body: string, pagePath: string, previousBody: string): Record<string, PsJsonValue> {
  const size = utf8Length(body);
  const exempt = sizeExempt(pagePath);
  const kind = pageKind(pagePath);
  const limit = PAGE_SIZE_LIMITS[kind];
  const oversized = size > limit;
  // Both sides of the proposed edit, measured from the same bodies used to plan it; `threshold_bytes` is this kind's limit.
  return { size_after_bytes: size, size_before_bytes: utf8Length(previousBody), kind, threshold_bytes: limit, oversized, exempt, warn: oversized && !exempt };
}

export function sectionSizes(body: string): { section: string; size_bytes: number }[] {
  const lines = toLines(body);
  const level2 = headings(lines).filter((heading) => heading.level === 2);
  return level2.map((heading, i) => {
    const end = i + 1 < level2.length ? level2[i + 1]!.index : lines.length;
    let bytes = 0;
    for (let j = heading.index; j < end; j++) bytes += utf8Length(lines[j]!) + 1;
    return { section: heading.text, size_bytes: bytes };
  });
}

function sectionTotals(body: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of sectionSizes(body)) totals.set(entry.section, (totals.get(entry.section) ?? 0) + entry.size_bytes);
  return totals;
}

function sectionSizeStatus(body: string, pagePath: string, previousBody: string): Record<string, PsJsonValue> {
  const exempt = sizeExempt(pagePath);
  const oversized = sectionSizes(body).filter((entry) => entry.size_bytes > SECTION_SIZE_THRESHOLD);
  const before = sectionTotals(previousBody);
  const after = sectionTotals(body);
  // ITS SIZE BEFORE THE EDIT, BESIDE IT (kickoffs/s98 row K1), so the warning says how much it grew.
  const warned = oversized
    .filter((entry) => (after.get(entry.section) ?? 0) > (before.get(entry.section) ?? 0))
    .map((entry) => ({ ...entry, size_before_bytes: before.get(entry.section) ?? 0 }));
  return {
    threshold_bytes: SECTION_SIZE_THRESHOLD,
    exempt,
    oversized_sections: oversized,
    warned_sections: warned,
    warn: warned.length > 0 && !exempt,
  };
}

/** `Get-HubEntryLabel`: the first line of an entry, condensed to something a warning can name. */
export function entryLabel(line: string): string {
  let text = line.replace(/^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+/, '').replace(/^\[[ xX]\][ \t]*/, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= 60) return text;
  let cut = 60;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return text.substring(0, cut).trimEnd() + '...';
}

export function entrySizes(body: string): { section: string; key: string; label: string; size_bytes: number }[] {
  const lines = toLines(body);
  const level2 = headings(lines).filter((heading) => heading.level === 2);
  const sizes: { section: string; key: string; label: string; size_bytes: number }[] = [];
  level2.forEach((heading, h) => {
    const sectionEnd = h + 1 < level2.length ? level2[h + 1]!.index : lines.length;
    const entries = topLevelEntries(lines, heading.index + 1, sectionEnd);
    entries.forEach((entry, e) => {
      // AN ENTRY ENDS AT THE NEXT LIST LINE OR AT THE NEXT UNINDENTED PARAGRAPH (kickoffs/s98 row K1; three Reports): a
      // paragraph after a list, such as `Now`'s orientation text, is no part of the list's last item.
      let end = e + 1 < entries.length ? entries[e + 1]!.index : sectionEnd;
      for (let j = entry.index + 1; j < end; j++) {
        if (isBlank(lines[j - 1]!) && !isBlank(lines[j]!) && !/^[ \t]/.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      while (end - 1 > entry.index && isBlank(lines[end - 1]!)) end--;
      let bytes = 0;
      for (let j = entry.index; j < end; j++) bytes += utf8Length(lines[j]!) + 1;
      // A SHORT, STABLE KEY: the section and a sha256 prefix of the entry's first line, never the line itself.
      sizes.push({ section: heading.text, key: `${heading.text}#${sha256OfText(entry.line).substring(0, 16)}`, label: entryLabel(entry.line), size_bytes: bytes });
    });
  });
  return sizes;
}

function entrySizeStatus(body: string, pagePath: string, previousBody: string): Record<string, PsJsonValue> {
  const exempt = sizeExempt(pagePath);
  const oversized = entrySizes(body).filter((entry) => entry.size_bytes > ENTRY_SIZE_THRESHOLD);
  const before = new Map<string, number>();
  for (const entry of entrySizes(previousBody)) if (!before.has(entry.key)) before.set(entry.key, entry.size_bytes);
  const warned = oversized.filter((entry) => !before.has(entry.key) || entry.size_bytes > before.get(entry.key)!);
  return {
    threshold_bytes: ENTRY_SIZE_THRESHOLD,
    exempt,
    oversized_entries: oversized,
    warned_entries: warned,
    warn: warned.length > 0 && !exempt,
  };
}

function sizeWarningLines(warnings: Record<string, PsJsonValue>[], pagePath: string, written: boolean, body = ''): string[] {
  const out: string[] = [];
  const [page, section, entry] = warnings as [Record<string, PsJsonValue>, Record<string, PsJsonValue>, Record<string, PsJsonValue>];
  if (page['warn']) out.push(`Project Hub page '${pagePath}' ${written ? 'is' : 'would be'} ${page['size_after_bytes']} bytes after this edit. ${pageSizeRemedy(pagePath, body)}`);
  if (section['warn']) {
    for (const oversized of section['warned_sections'] as { section: string; size_bytes: number; size_before_bytes: number }[]) {
      // SAID AS WHAT IT IS (kickoffs/s98 row K1): a preflight's section WOULD grow; an apply's grew, and the first sentence
      // stays as it was, since deskpost-mods reads it.
      const grew = written
        ? `grew to ${oversized.size_bytes} bytes. It was ${oversized.size_before_bytes} bytes before this edit.`
        : `would grow to ${oversized.size_bytes} bytes (from ${oversized.size_before_bytes}).`;
      out.push(
        `Section '${oversized.section}' on '${pagePath}' ${grew} Usually this section is holding items it cannot close rather than verbose ones: send a limit whose proof needs an event you cannot cause to the limits page with a disposition, a settled question to ## Decisions and its record, and a standing practice to the subject's own rules. Sort before you shorten (ADR-0013).`,
      );
    }
  }
  if (entry['warn']) {
    for (const oversized of entry['warned_entries'] as { section: string; label: string; size_bytes: number }[]) {
      out.push(
        `Entry '${oversized.label}' in '${oversized.section}' on '${pagePath}' is ${oversized.size_bytes} bytes. Keep the entry to its decision and its link, and put the detail on a linked page.`,
      );
    }
  }
  return out;
}

// --- where the page lives ---------------------------------------------------------------------------

interface PageStore {
  /** The page's whole content (frontmatter included, where the backend has any), or null. */
  read(pagePath: string): Promise<string | null>;
  /** Overwrite the page with `body`; the caller reads it back. */
  write(pagePath: string, body: string): Promise<void>;
  projectId: string;
}

async function sharedStore(workspace: string): Promise<PageStore> {
  const url = resolveMcpUrl(workspace);
  assertCollectionWriteAllowed(workspace, 'editing a Project Hub');
  const projectId = resolveCollectionId(workspace);
  const session = new McpSession(url, 'library-project-edit');
  let initialised = false;
  const ready = async (): Promise<void> => {
    if (!initialised) {
      await session.initialize();
      refuseRetiredWriter(session, 'hub edit');
      initialised = true;
    }
  };
  return {
    projectId,
    async read(pagePath: string): Promise<string | null> {
      await ready();
      const record = await readExactOrNull(session, projectId, pagePath, { stopped: 'the edit stopped without writing' });
      return record === null ? null : record.content;
    },
    async write(pagePath: string, body: string): Promise<void> {
      await ready();
      // SENT ONCE AND JUDGED (kickoffs/s121 row 7); a dropped session is judged by the apply's own readback.
      await sendWrite(session, 'write_note', {
        project_id: projectId,
        directory: pagePath.substring(0, pagePath.lastIndexOf('/')),
        title: path.posix.basename(pagePath, '.md'),
        content: body,
        note_type: 'note',
        overwrite: true,
        output_format: 'json',
      }, `Write '${pagePath}'`);
    },
  };
}

function localStore(workspace: string): PageStore {
  const root = path.join(workspace, 'collection');
  const idText = fs.existsSync(path.join(root, '.library', 'collection.json'))
    ? fs.readFileSync(path.join(root, '.library', 'collection.json'), 'utf8').replace(/^﻿/, '')
    : '';
  let projectId = '';
  try {
    projectId = String((JSON.parse(idText) as Record<string, unknown>)['id'] ?? '');
  } catch {
    projectId = '';
  }
  if (!projectId.trim()) refuse(`This workspace has no local collection yet: ${path.join(root, '.library', 'collection.json')} does not exist or names no id. Run library init.`);
  const file = (pagePath: string): string => path.join(root, ...pagePath.split('/'));
  return {
    projectId,
    async read(pagePath: string): Promise<string | null> {
      const full = file(pagePath);
      return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8').replace(/^﻿/, '') : null;
    },
    // THE PAGE'S OWN FRONTMATTER IS KEPT (S62). Every edit plans against the body alone (`removeFrontmatter`), and a
    // local page imported from Basic Memory carries `title`, `type` and `permalink` above it: writing the body alone
    // dropped them on the first edit, and the body-only readback could not see it. Basic Memory's own write keeps
    // them on its side, which is why the shared store never showed it.
    async write(pagePath: string, body: string): Promise<void> {
      const full = file(pagePath);
      const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/^﻿/, '') : '';
      const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)*/.exec(current);
      writeAtomicText(full, head ? head[0] + body : body);
    },
  };
}

function pagesLinkingTo(workspace: string, slug: string, pageName: string): string[] {
  const directory = path.join(workspace, 'collection', 'projects', slug);
  const target = `projects/${slug}/${pageName}`;
  const links: string[] = [];
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(entry.parentPath, entry.name);
    const name = path.relative(directory, full).replace(/\\/g, '/').slice(0, -3);
    if (name === pageName) continue;
    const content = fs.readFileSync(full, 'utf8');
    const wikiLinks = [...content.matchAll(/\[\[([^|#\]]+)(?:[|#][^\]]*)?\]\]/g)];
    const hasWikiLink = wikiLinks.some(match => {
      const destination = match[1]!.trim().replace(/\.md$/i, '');
      return destination === target || destination === pageName ||
        path.posix.join(path.posix.dirname(name), destination) === pageName;
    });
    const markdownLinks = content.matchAll(/(?<!!)\[[^\]\r\n]*\]\([ \t]*(?:<([^>\r\n]+)>|((?:[^\s()]|\([^\s()]*\))+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)/g);
    const hasMarkdownLink = Array.from(markdownLinks).some(match => {
      const destination = (match[1] ?? match[2]!).split('#', 1)[0]!.replace(/\.md$/i, '');
      return destination !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(destination) &&
        path.posix.join(path.posix.dirname(name), destination) === pageName;
    });
    if (hasWikiLink || hasMarkdownLink) links.push(`projects/${slug}/${name}`);
  }
  return links.sort();
}

// --- the verb -----------------------------------------------------------------------------------------

const MODE_WORDS: Record<string, EditMode> = {
  'add-section': 'AddSection',
  'append-section': 'AppendSection',
  'remove-section': 'RemoveSection',
  'remove-page': 'RemovePage',
  'replace-section': 'ReplaceSection',
  'replace-body': 'ReplaceBody',
  'check-item': 'CheckItem',
  'replace-item': 'ReplaceItem',
  'insert-item': 'InsertItem',
  'close-item': 'CloseItem',
};

/** The quote characters a `new-page --title` may not start or end with: straight, typographic and guillemets. */
const QUOTE_CHARACTERS = '"\'`“”‘’„«»';

function nullable(value: string): PsJsonValue {
  return isBlank(value) ? null : value;
}

/** The verb, with the inline-cut warning (S70 row 2) in its result: a `--content` the shim may have cut says so. */
export async function hubEdit(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('hub', 'edit'));
  let warning: string | null = null;
  const result = withInlineCutWarning(await hubEditUnwarned(argv, workspace, content => { warning = writeTimeWarning(content, new Date()); }), argv, 'content', 'pass it with --content-path <file>.');
  if (warning && !parsed.flags.has('json')) process.stderr.write(`WARN: ${warning}\n`);
  return { ...result, time_warning: warning };
}

async function hubEditUnwarned(argv: string[], workspace: string, loadedContent: (content: string) => void): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('hub', 'edit'));
  const showSections = parsed.flags.has('show-sections');
  if (showSections && !parsed.flags.has('preflight')) refuse('--show-sections requires --preflight. Nothing was written.');
  // ONE SLUG HELPER FOR EVERY HUB WRITER (PLAN-one-step-upgrade.md small fix 2): `projects/<slug>` is taken, and a
  // refusal names `<slug>`, not the PowerShell parameter. The oracle's order is kept: a blank slug, then the mode.
  const { slug, problem: slugProblem } = hubSlug(parsed.positional[0] ?? '');
  const modeWord = parsed.options.get('mode') ?? '';
  if (isBlank(slug)) refuse(slugProblem!);
  // MODE NAMES IN A REFUSAL ARE THE CLI'S (kickoffs/s106 ruling 2): `add-section`, never the PowerShell `AddSection`.
  if (isBlank(modeWord)) refuse(`--mode is required: ${Object.keys(MODE_WORDS).join(', ')}, or new-page.`);
  // ONE POSITIONAL WORD, THE HUB'S SLUG, IN EVERY MODE (S97 row 4, deskpost-prompts-dev's Report). No mode reads a second,
  // so one is a value the shell split or a quote left open: refused before anything is read or written.
  if (parsed.positional.length > 1) {
    refuse(
      `hub edit takes one Hub slug and its --options, and nothing else: unexpected argument: ${parsed.positional[1]}. A value with ` +
        'spaces goes in quotes right after its option. Nothing was written.',
    );
  }
  if (slugProblem !== null && ['new-page', 'newpage'].includes(modeWord.toLowerCase())) refuse(slugProblem);
  // A NEW PAGE ON A LOCAL HUB (S67, PLAN-local-collection-writers.md step B): a mode of this verb with a write half of
  // its own, because the edit store below overwrites and a creation must never replace a page.
  if (['new-page', 'newpage'].includes(modeWord.toLowerCase())) {
    if (parsed.options.has('supersedes')) refuse('--supersedes is for append-section on the Hub root’s Next section only.');
    // A TITLE THAT STARTS OR ENDS WITH A QUOTE is almost always one the shell left in place (S97 row 4), and a page's H1
    // is written once: until 1.4.0 nothing changes it, so it is refused rather than written.
    const title = (parsed.options.get('title') ?? '').trim();
    const edge = title ? [title[0]!, title[title.length - 1]!].find((character) => QUOTE_CHARACTERS.includes(character)) : undefined;
    if (edge !== undefined) {
      refuse(
        `--title starts or ends with a quote character (${edge}), which is usually a quote the shell left in place. A page's H1 is ` +
          'written once and cannot be changed until 1.4.0, so remove the quote and run the command again. Nothing was written.',
      );
    }
    const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
    const newPage = {
      slug,
      page: parsed.options.get('page') ?? '',
      content: parsed.options.get('content') ?? '',
      planId: (parsed.options.get('plan-id') ?? '').trim(),
      contentPath: parsed.options.get('content-path') ?? '',
      title: parsed.options.get('title') ?? '',
      seat: parsed.options.get('seat'),
      preflight: parsed.flags.has('preflight'),
      lockTimeout: Number.isFinite(timeout) ? timeout : 20,
    };
    // THE TIME OF THE WRITE, FILLED AT APPLY (kickoffs/s121 row 6). The preflight and its plan id cover the text as
    // given, placeholders and all; the apply checks that plan id against the unfilled text, then writes the filled one.
    // Two sources are refused first, as the edit modes refuse them: the fill below passes on the inline text only.
    if (!isBlank(newPage.content) && !isBlank(newPage.contentPath)) refuse('Supply exactly one of --content or --content-path.');
    const given = newPageText(newPage.content, newPage.contentPath, workspace);
    if (given !== null) loadedContent(given);
    const posted = given === null ? null : postedHeader(given);
    if (given === null || (!posted && !hasWritePlaceholders(given))) return hubNewPage(newPage, workspace);
    if (newPage.preflight) return { ...(await hubNewPage(newPage, workspace)), time_placeholders: HUB_PLACEHOLDER_NOTE };
    if (newPage.planId) {
      const planned = (await hubNewPage({ ...newPage, preflight: true }, workspace)) as Record<string, PsJsonValue>;
      // A stale plan id is refused by new-page itself, in its own words, with nothing written.
      if (planned['plan_id'] !== newPage.planId) return hubNewPage(newPage, workspace);
    }
    const states = path.join(workspace, '.claude');
    const sourceLines = given.split(/(\r?\n)/);
    if (posted) {
      const lineIndex = posted.line * 2;
      const line = sourceLines[lineIndex]!;
      sourceLines[lineIndex] = line.slice(0, posted.column) + '{now}' + line.slice(posted.column + '{posted}'.length);
    }
    const filled = fillWritePlaceholders(sourceLines.join(''), new Date(), states, () => requireSeat({ seat: newPage.seat, stateDirectory: states }));
    // A `kickoffs/` page is judged by the text as given (kickoffs/s174 standing answer 3), as the preflight judged it: in
    // the filled text a doubled-brace time word is single, which the placeholder rule would refuse.
    const written = await hubNewPage({ ...newPage, content: filled, contentPath: '', planId: '', judgedText: given }, workspace);
    // THE PLAN ID IT CHECKED (kickoffs/s159 row 5), as the edit modes name `approved_sha256`: `plan_id` is the filled text's.
    return { ...(written as Record<string, PsJsonValue>), ...(newPage.planId ? { approved_plan_id: newPage.planId } : {}), time_placeholders_filled: true };
  }
  const mode = MODE_WORDS[modeWord] ?? EDIT_MODES.find((name) => name.toLowerCase() === modeWord.toLowerCase());
  if (mode === undefined) {
    refuse(`library hub edit has no mode '${modeWord}'. It has: ${Object.keys(MODE_WORDS).join(', ')}, new-page.`);
  }
  // THE MODE AS THE READER TYPES IT, for every refusal below (kickoffs/s108 ruling 8): the one inverse of MODE_WORDS.
  const cliMode = Object.keys(MODE_WORDS).find((key) => MODE_WORDS[key] === mode) ?? mode;
  // `--title` IS NEW-PAGE'S ALONE (PLAN-correct-and-find.md D7 bullet 2): every other mode ignored it, so a seat that gave one
  // to rename a page heard nothing and the page kept its H1.
  if (parsed.options.has('title')) {
    const word = Object.keys(MODE_WORDS).find((key) => MODE_WORDS[key] === mode) ?? mode;
    refuse(`hub edit --mode ${word} takes no --title: only new-page reads one, as a new page's H1. Nothing was written.`);
  }
  if (slugProblem !== null) refuse(slugProblem);

  // CLOSING AN ITEM IS AS CHEAP AS ADDING ONE (PLAN-hub-redesign.md section 1; kickoffs/s213 row 12): one top-level item of
  // the root's Now or Next moved, ticked, to the newest tidy-history page (hubtidy.ts), with no gate beyond check-item's.
  if (mode === 'CloseItem') {
    if (parsed.options.has('after')) refuse('--after is for insert-item only; close-item finds its item with --match-text.');
    if (parsed.options.has('content') || parsed.options.has('content-path')) refuse('close-item moves an item word for word; it takes no content.');
    if (parsed.flags.has('uncheck') || parsed.options.has('supersedes')) refuse('close-item takes --match-text and, optionally, --section Now or --section Next.');
    const page = (parsed.options.get('page') ?? '_project').trim().replace(/\.md$/i, '');
    if (page !== '_project') refuse('close-item closes items on the Hub root, _project, only.');
    const matches = parsed.lists.get('match-text') ?? [];
    const match = parsed.options.get('match-text') ?? '';
    if (matches.length > 1) refuse('close-item closes one item: give one --match-text.');
    if (isBlank(match)) refuse('close-item requires --match-text: text appearing in exactly one top-level item of ## Now or ## Next, matched case-sensitively.');
    const given = parsed.options.get('section');
    const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
    const { closeItem } = await import('./hubtidy.ts');
    return closeItem(workspace, {
      slug, matchText: match, section: given === undefined ? null : given.trim().replace(/^#+/, '').trim(), seat: parsed.options.get('seat'),
      preflight: parsed.flags.has('preflight'), planId: (parsed.options.get('plan-id') ?? '').trim(), lockTimeout: Number.isFinite(timeout) ? timeout : 20,
    });
  }

  // THE FENCE, THEN THE COLLECTION ID, before anything about the page: the oracle's order, so a
  // workspace that may not write learns that first.
  const marker = readMarker(workspace);
  const shared = marker !== null && String(marker['backend'] ?? '') !== 'local';
  const store = shared ? await sharedStore(workspace) : localStore(workspace);

  let pageName = (parsed.options.get('page') ?? '_project').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (/\.md$/i.test(pageName)) pageName = pageName.substring(0, pageName.length - 3);
  if (isBlank(pageName)) refuse('Page is required.');
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)*$/.test(pageName) || /(^|\/)\.\.?($|\/)/.test(pageName)) {
    refuse('Page must be a canonical path below the Project root, such as _project or notes/topic/Article.');
  }
  const pagePath = `projects/${slug}/${pageName}.md`;
  const removingPage = mode === 'RemovePage';
  if (removingPage && (shared || !pageName.startsWith('notes/'))) {
    refuse('remove-page is available only for notes/ pages in a local Hub.');
  }
  const localPage = path.join(workspace, 'collection', ...pagePath.split('/'));
  const assertLocalFile = (): void => {
    assertInsideRoot(path.join(workspace, 'collection'), pagePath, 'the local collection');
    if (!fs.lstatSync(localPage).isFile()) {
      refuse('remove-page requires a regular page in this Hub. Nothing was written.');
    }
  };
  // A KICKOFF IS WRITTEN ONCE (kickoffs/s174 row 3; CONTEXT.md, "Kickoff"): the rule was on paper only, and every mode
  // below could edit the page the reader's yes was bound to. Refused at --preflight too.
  if (/^kickoffs\//i.test(pageName)) refuse('kickoffs/ pages are written once: a revision is a new page made with --mode new-page. Nothing was written.');

  let section = parsed.options.get('section') ?? '';
  if (mode !== 'InsertItem' && parsed.options.has('after')) refuse('--after is for insert-item only.');
  if (mode === 'InsertItem' && parsed.options.has('match-text')) refuse('insert-item takes --after, not --match-text.');
  const matchText = parsed.options.get(mode === 'InsertItem' ? 'after' : 'match-text') ?? '';
  const matches = parsed.lists.get('match-text') ?? [];
  if (matches.length > 1 && mode !== 'CheckItem' && mode !== 'ReplaceItem') {
    refuse('Repeated --match-text is for check-item and replace-item only.');
  }
  if (matches.some(isBlank)) refuse('--match-text needs non-empty text.');

  const supersedes = parsed.options.get('supersedes');
  const contentGiven = parsed.options.has('content');
  const contentPathGiven = parsed.options.has('content-path');
  let content = parsed.options.get('content') ?? '';
  const contentPath = parsed.options.get('content-path') ?? '';
  if (SECTION_MODES.includes(mode) && isBlank(section)) refuse(`${cliMode} requires --section, the exact level-two heading text without the leading '##'.`);
  if (!isBlank(section)) section = section.trim().replace(/^#+/, '').trim();
  if (supersedes !== undefined && (mode !== 'AppendSection' || section !== 'Next' || pageName !== '_project')) {
    refuse('--supersedes is for append-section on the Hub root’s Next section only.');
  }
  // --subsection (kickoffs/s219 row 5): append-section only, never with --supersedes.
  const subsection = parsed.options.get('subsection');
  if (subsection !== undefined) {
    if (mode !== 'AppendSection') refuse('--subsection is for --mode append-section only. Nothing was written.');
    if (supersedes !== undefined) refuse('--subsection cannot be used with --supersedes: a Run pointer goes in ## Next itself. Nothing was written.');
    if (isBlank(subsection.replace(/^\s*#+/, ''))) refuse('--subsection needs the ### heading text. Nothing was written.');
  }
  if (removingPage && (section || matchText || contentGiven || contentPathGiven || parsed.flags.has('uncheck'))) {
    refuse('remove-page takes --page and no section, match or content.');
  }
  if (mode === 'RemoveSection') {
    if (section === 'Purpose' || section === 'Now' || section === 'Next') refuse(`Section '${section}' is structural and cannot be removed.`);
    if (contentGiven || contentPathGiven) refuse('remove-section takes no content; do not supply --content or --content-path.');
    if (parsed.options.has('match-text')) refuse('remove-section takes no --match-text.');
  }
  if (ITEM_MODES.includes(mode) && isBlank(matchText)) {
    refuse(`${cliMode} requires ${mode === 'InsertItem' ? '--after' : '--match-text'}: text appearing in exactly one item, matched case-sensitively. --section is optional and narrows the search.`);
  }
  const usedContent = !isBlank(content);
  const usedContentPath = !isBlank(contentPath);
  let contentFull = '';
  if (mode === 'CheckItem') {
    if (usedContent || usedContentPath) refuse('check-item changes only the checkbox marker; it takes no content.');
  } else if (mode !== 'RemoveSection' && !removingPage && usedContent === usedContentPath) {
    refuse('Supply exactly one of --content or --content-path.');
  }
  if (usedContentPath) {
    contentFull = resolveContentPath(workspace, contentPath);
    if (!fs.existsSync(contentFull) || !fs.statSync(contentFull).isFile()) refuse(`--content-path '${contentPath}' is not a file (resolved to ${contentFull}).`);
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(contentFull));
    } catch (error) {
      refuse(`--content-path '${contentPath}' (resolved to ${contentFull}) is not valid UTF-8: ${(error as Error).message}`);
    }
  }
  loadedContent(content);
  // NO STRAY CONTROL CHARACTER REACHES A PAGE (kickoffs/s94 row 3), from a file or inline, refused before any write.
  if (usedContent || usedContentPath) {
    const stray = strayControlRefusal(content, usedContentPath ? `--content-path '${contentPath}'` : '--content');
    if (stray !== null) refuse(stray);
  }

  // COPY EVIDENCE, AND ONLY FOR ReplaceBody FROM notebook/ -- the oracle's rule and its reasons: only
  // there does the whole source become the whole page. The hash is of the file's raw bytes.
  let notebookSource: string | null = null;
  let notebookSourceHash: string | null = null;
  if (usedContentPath && mode === 'ReplaceBody') {
    let root = path.resolve(workspace);
    if (!root.endsWith(path.sep)) root += path.sep;
    if (contentFull.toLowerCase().startsWith(root.toLowerCase())) {
      const candidate = contentFull.substring(root.length).replace(/\\/g, '/');
      if (/^notebook\/.+/.test(candidate)) {
        notebookSourceHash = sha256OfBytes(fs.readFileSync(contentFull));
        notebookSource = candidate;
      }
    }
  }

  // THIS SEAT'S DESK, not the union: a Hub open at another seat does not entitle this one.
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
  const openProjects = deskEntriesForSeat(stateDirectory, seat, 'projects');
  if (openProjects.includes(`archive/projects/${slug}`)) refuse(`Project '${slug}' is open from the archive shelf. Archived Project Hubs are read-only.`);
  if (!openProjects.includes(`projects/${slug}`)) {
    refuse(
      shared
        ? `Project '${slug}' is not open. Open it first: deskpost desk open project ${slug}`
        : `Project '${slug}' is not open. Open it first: deskpost desk open project ${slug}`,
    );
  }

  const isReplacing = ['RemovePage', 'RemoveSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem'].includes(mode);
  if (removingPage) assertInsideRoot(path.join(workspace, 'collection'), pagePath, 'the local collection');
  const existing = await store.read(pagePath);
  if (existing === null) {
    // THE ROUTE NAMED IS THE ONE THAT WORKS HERE (S67, deskpost-prompts-dev's Report): both PowerShell helpers need
    // Basic Memory, so a local Library is sent to the mode that makes a page in its own collection.
    refuse(
      shared
        ? `Page '${pagePath}' does not exist. This mode edits an existing page; create a Hub with deskpost hub new ${slug} --title <title> or copy Notebook pages with deskpost hub copy-pages ${slug}.`
        : `Page '${pagePath}' does not exist. This mode edits an existing page; make a new one with deskpost hub edit ${slug} --mode new-page --page ${pageName} --content-path <file>.`,
    );
  }
  if (removingPage) assertLocalFile();
  const linkedFrom = removingPage ? pagesLinkingTo(workspace, slug, pageName) : [];
  const currentBody = removeFrontmatter(existing);
  let appendBase = currentBody;
  if (supersedes !== undefined) {
    const runPointer = /^- \[ \] (Run [A-Za-z0-9._-]+:) \[\[projects\/[^\]/]+\/kickoffs\/[^\]]+\]\]/;
    const key = supersedes.trim();
    const pointers = nextSectionLines(currentBody).filter(line => runPointer.exec(line)?.[1] === key);
    if (pointers.length !== 1) refuse('--supersedes must name exactly one unticked Run pointer in Next.');
    const newPointer = runPointer.exec(content.trim());
    if (!newPointer || toLines(content.trim()).length !== 1 || newPointer[1] === key) {
      refuse('--supersedes requires one new unticked Run pointer as content.');
    }
    appendBase = newProjectBody(currentBody, 'CheckItem', 'Next', '', pointers[0]!, false);
  }
  const uncheck = parsed.flags.has('uncheck');
  const originalLines = toLines(currentBody);
  const scope = matches.length > 1 && section ? sectionSpan(originalLines, section) : null;
  if (matches.length > 1 && section && !scope) refuse(`Section '${section}' was not found.`);
  const blocks = matches.length > 1 ? matches.map(match => ({
    match,
    ...findUniqueBlock(originalLines, scope ? scope.start + 1 : 0, scope?.end ?? originalLines.length, match, mode === 'CheckItem'),
  })) : [];
  const ordered = [...blocks].sort((a, b) => b.start - a.start);
  if (ordered.some((block, index) => index > 0 && block.end >= ordered[index - 1]!.start)) {
    refuse('Each --match-text must name a different item. Matched items cannot overlap.');
  }
  const batchReplacement = (block: Span, text: string): string[] => mode === 'CheckItem'
    ? [setCheckboxState(originalLines[block.start]!, !uncheck), ...originalLines.slice(block.start + 1, block.end + 1)]
    : replacementItemLines(originalLines[block.start]!, removeTrailingBlank(toLines(text)));
  const buildBody = (text: string): string => {
    if (subsection !== undefined) return appendToSubsection(appendBase, section, subsection, text);
    if (!ordered.length) return newProjectBody(appendBase, mode, section, text, matchText, uncheck);
    const lines = [...originalLines];
    for (const block of ordered) {
      newProjectBody(currentBody, mode, section, text, block.match, uncheck);
      lines.splice(block.start, block.end - block.start + 1, ...batchReplacement(block, text));
    }
    return joinLines(lines);
  };
  const proposedBody = removingPage ? '' : buildBody(content);
  // ON A DEV HUB, A NEW ITEM IS A SHORT POINTER (PLAN-hub-redesign.md section 3; kickoffs/s213 row 22).
  if (pageName === '_project' && !removingPage) {
    const problem = devHubPointerProblem(currentBody, proposedBody, slug, (id) => trainIdKnown(workspace, id));
    if (problem !== null) refuse(problem);
  }
  // ONE PENDING Run POINTER (kickoffs/s174 row 3, standing answer 7), judged on the `## Next` this edit would write, for
  // every mode, at --preflight and at apply: an edit that changes `## Next` may not leave two unticked `Run` lines unless
  // it lowers their count. `check-item --uncheck` could revive an old pointer beside the pending one.
  const nextBefore = nextSectionLines(currentBody);
  const nextAfter = nextSectionLines(proposedBody);
  if (nextBefore.join('\n') !== nextAfter.join('\n')) {
    const pending = (lines: string[]): string[] => lines.filter((line) => /^\s*- \[ \] Run /.test(line)).map((line) => line.trim());
    const after = pending(nextAfter);
    // A DEV HUB HOLDS A QUEUE OF THREE (PLAN-hub-redesign.md amendment A1, A1-09; kickoffs/s213 row 2): a Hub with
    // `## Repo` may hold up to three pending pointers, run in page order; every other Hub keeps one, word for word.
    const queueCap = isDevHubBody(proposedBody) ? RUN_QUEUE_CAP : 1;
    if (after.length > queueCap && after.length >= pending(nextBefore).length) {
      // THE REMEDY NAMES THE COMMANDS (kickoffs/s219 row 4): the first pending pointer's id where there is one.
      const firstId = /Run ([A-Za-z0-9._-]+):/.exec(pending(nextBefore)[0] ?? '')?.[1] ?? '<id>';
      const remedy = `Tick the one that is done first (deskpost hub edit ${slug} --mode check-item --section Next --match-text "Run ${firstId}:"), ` +
        `or replace an unrun Kickoff (deskpost hub edit ${slug} --mode append-section --section Next --supersedes "Run <old id>:" --content-path <file>). Nothing was written.`;
      refuse(queueCap === 1
        ? `## Next holds one pending Run pointer, and this edit would leave ${after.length}: ${after.join(' | ')}. ${remedy}`
        : `## Next on a dev Hub holds at most three pending Run pointers, and this edit would leave ${after.length}: ${after.join(' | ')}. ${remedy}`);
    }
    // ONE PENDING POINTER A UNIT (A1-07; kickoffs/s213 row 3): two unticked pointers naming one `<id>` or one
    // `kickoffs/<id>` page are refused; a revision replaces its pointer where it stands (replace-item keeps its place).
    const repeated = (lines: string[]): string[] => {
      const seen = new Set<string>(), twice = new Set<string>();
      for (const line of lines) {
        for (const key of runPointerKeys(line)) (seen.has(key) ? twice : seen).add(key);
      }
      return [...twice];
    };
    const doubledBefore = new Set(repeated(pending(nextBefore)));
    const doubled = repeated(pending(nextAfter)).filter((key) => !doubledBefore.has(key));
    if (doubled.length > 0) {
      refuse(`This edit would leave a second pending Run pointer for ${doubled[0]!.replace(/^(id|page) /, '')} in ## Next. A revision replaces its pointer where it stands (deskpost hub edit ${slug} --mode replace-item --section Next --match-text "Run <id>:" --content-path <file>), or replace an unrun Kickoff (deskpost hub edit ${slug} --mode append-section --section Next --supersedes "Run <old id>:" --content-path <file>). Nothing was written.`);
    }
    // A RUN POINTER THE RULE CAN SEE (kickoffs/s181-r2 spare S1): a line this edit adds that names `Run <id>:` and a
    // `kickoffs/` link must be the canonical form (`kickoff.ts`), or the count above and /meanwhile miss it. A line already
    // there, ticked or not, is never judged.
    const unticked = (line: string) => line.trim().replace(/^- \[[xX]\]/, '- [ ]');
    const had = new Set(nextBefore.map(unticked));
    const shaped = nextAfter.map((line) => line.trim()).find((line) => !had.has(unticked(line)) && /\bRun [A-Za-z0-9._-]+:/.test(line) && line.includes('kickoffs/')
      && !/^- \[[ xX]\] Run [A-Za-z0-9._-]+: \[\[projects\/[^\]/]+\/kickoffs\/[^\]]+\]\]/.test(line));
    if (shaped !== undefined) {
      refuse(`A Run pointer in ## Next must read "- [ ] Run <id>: [[projects/<hub>/kickoffs/<id>]] ...", the form the one-pointer rule and /meanwhile read; this line does not: ${shaped}. Nothing was written.`);
    }
  }
  const currentLines = toLines(currentBody);
  const proposedLines = toLines(proposedBody);
  const now = new Date();
  // THE TIME OF THE WRITE (kickoffs/s121 row 6): the plan id above bound the text as given; only the new text is filled,
  // never the page's existing lines, and the readback judges what was written.
  const filling = hasWritePlaceholders(content);
  const fillBody = () => buildBody(fillWritePlaceholders(content, now, stateDirectory, () => seat));
  const filledReplacement = mode === 'ReplaceItem' && filling ? fillBody() : null;
  const needsConfirmation = isReplacing && (mode !== 'ReplaceItem'
    || !linesPreserved(currentLines, proposedLines) || !linesPreserved(currentLines, toLines(filledReplacement ?? proposedBody)));
  if (mode === 'CheckItem') {
    if (currentLines.length !== proposedLines.length) refuse('check-item would change the page shape; the edit stopped without writing.');
    const differing = currentLines.map((_, i) => i).filter((i) => currentLines[i] !== proposedLines[i]);
    if (differing.length > Math.max(1, blocks.length)) refuse(`check-item would change ${differing.length} lines; the edit stopped without writing.`);
    for (const line of differing) {
      const normalizedOld = currentLines[line]!.replace(/\[[ xX]\]/g, '[ ]');
      const normalizedNew = proposedLines[line]!.replace(/\[[ xX]\]/g, '[ ]');
      if (normalizedOld !== normalizedNew) refuse('check-item would change more than the checkbox marker; the edit stopped without writing.');
    }
  } else if (!isReplacing && !linesPreserved(toLines(appendBase), proposedLines)) {
    refuse(`${cliMode} would not preserve the existing page text; the edit stopped without writing.`);
  }

  // Hash the page the reader sees, including the front matter the store preserves.
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)*/.exec(existing)?.[0] ?? '';
  const currentHash = pageComparisonSha256(existing);
  const proposedHash = removingPage ? null : pageComparisonSha256(front + proposedBody);
  const counts = changeCounts(currentBody, proposedBody);
  const planId = 'project-edit-' + sha256OfText(`${pagePath}|${mode}|${section}|${blocks.length ? JSON.stringify(matches) : matchText}|${currentHash}|${proposedHash}${removingPage ? JSON.stringify(linkedFrom) : ''}`);
  let sectionBefore: PsJsonValue = null;
  let sectionAfter: PsJsonValue = null;
  let itemBefore: PsJsonValue = null;
  let itemAfter: PsJsonValue = null;
  // THE SECTION'S BODY WITHOUT ITS HEADING (kickoffs/s106 row 7d): `section_before` starts at the `## ` line, which
  // replace-section refuses in its content, so a seat editing the preview had to cut it first. Both are given.
  let sectionBodyBefore: PsJsonValue = null;
  if (SECTION_MODES.includes(mode)) {
    const beforeSpan = sectionSpan(currentLines, section);
    sectionBefore = sectionText(currentLines, beforeSpan);
    sectionBodyBefore = beforeSpan === null ? null : sectionText(currentLines, { ...beforeSpan, start: beforeSpan.start + 1 }).replace(/^(\s*\n)+/, '');
    const afterSpan = sectionSpan(proposedLines, section);
    sectionAfter = afterSpan === null ? null : sectionText(proposedLines, afterSpan);
  }
  if (ITEM_MODES.includes(mode) && !blocks.length) {
    let scopeStart = 0;
    let scopeEnd = currentLines.length;
    if (!isBlank(section)) {
      const itemSpan = sectionSpan(currentLines, section)!;
      scopeStart = itemSpan.start + 1;
      scopeEnd = itemSpan.end;
    }
    const block = findUniqueBlock(currentLines, scopeStart, scopeEnd, matchText, mode === 'CheckItem');
    itemBefore = currentLines.slice(block.start, block.end + 1).join('\n');
    itemAfter = mode === 'InsertItem' ? proposedLines.slice(block.start, block.end + 1 + removeTrailingBlank(toLines(content)).length).join('\n') : mode === 'CheckItem' ? proposedLines.slice(block.start, block.end + 1).join('\n') : replacementItemLines(currentLines[block.start]!, removeTrailingBlank(toLines(content))).join('\n');
  }

  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Edit Project Hub',
    project_slug: slug,
    page_path: pagePath,
    page_file: shared ? null : `collection/${pagePath}`,
    mode,
    section: nullable(section),
    match_text: ITEM_MODES.includes(mode) ? matchText : null,
    unchanged: currentHash === proposedHash,
    current_sha256: currentHash,
    proposed_sha256: proposedHash,
    added_lines: counts.added_lines,
    removed_lines: counts.removed_lines,
    current_line_count: currentLines.length,
    proposed_line_count: proposedLines.length,
    section_before: sectionBefore,
    section_body_before: sectionBodyBefore,
    section_after: sectionAfter,
    item_before: itemBefore,
    item_after: itemAfter,
    ...(blocks.length ? { items: blocks.map(block => ({
      match_text: block.match,
      before: currentLines.slice(block.start, block.end + 1).join('\n'),
      after: batchReplacement(block, content).join('\n'),
    })) } : {}),
    plan_id: planId,
    confirmation_required: needsConfirmation,
    ...(removingPage ? { linked_from: linkedFrom } : {}),
    advice: null,
    shared_library_write: false,
  };

  if (plan['unchanged'] && mode === 'CheckItem') {
    plan['unchanged_reason'] = `${parsed.flags.has('uncheck') ? 'already unticked' : 'already ticked'}: ${blocks.length ? matches.join(', ') : String(itemBefore)}`;
  }

  // Computed BEFORE the preflight return, from the proposed body, so a preflight can report them.
  const sizeWarnings = [
    pageSizeStatus(proposedBody, pagePath, currentBody),
    sectionSizeStatus(proposedBody, pagePath, currentBody),
    entrySizeStatus(proposedBody, pagePath, currentBody),
  ];
  const warn = (written: boolean): void => {
    for (const line of sizeWarningLines(sizeWarnings, pagePath, written, proposedBody)) process.stderr.write(`WARNING: ${line}\n`);
  };

  if (parsed.flags.has('preflight')) {
    if (!showSections) {
      for (const field of ['section_before', 'section_body_before', 'section_after']) {
        const value = plan[field];
        if (typeof value !== 'string') continue;
        const bytes = Buffer.byteLength(value, 'utf8');
        if (bytes <= 8192) continue;
        plan[field] = null;
        plan[field + '_summary'] = {
          lines: toLines(value).length,
          bytes,
          sha256: sha256OfText(value),
        };
      }
    }
    if (hasWritePlaceholders(content)) plan['time_placeholders'] = HUB_PLACEHOLDER_NOTE;
    plan['page_size_warning'] = sizeWarnings[0]!;
    plan['section_size_warning'] = sizeWarnings[1]!;
    plan['entry_size_warning'] = sizeWarnings[2]!;
    warn(false);
    return plan;
  }
  if (plan['unchanged']) {
    // `status` AND `journal` AS collection add-page SAYS THEM (S72 row 5), beside `written`, which stays.
    return { schema: 1, operation: 'Edit Project Hub', project_slug: slug, page_path: pagePath, page_file: shared ? null : `collection/${pagePath}`, mode, unchanged: true, ...(plan['unchanged_reason'] ? { unchanged_reason: plan['unchanged_reason'] } : {}), written: false, status: 'unchanged', journal: null, shared_library_write: false };
  }
  if (needsConfirmation) {
    if (!parsed.flags.has('user-confirmed')) refuse(`${cliMode} removes existing text and is not yet performed: review the preflight and rerun with --user-confirmed.`);
    // THE SECOND SENTENCE SAYS WHAT A STALE ID USUALLY MEANS (kickoffs/s99 row K2, ruling 7), with the page's hash now; the
    // first stays word for word. An id never issued reads the same: telling the two apart would need stored previews.
    if ((parsed.options.get('plan-id') ?? '') !== planId) {
      refuse(`${cliMode} is not yet performed: rerun the current preflight and pass its exact plan_id as --plan-id. A different plan_id means the page changed since the preview; it reads ${currentHash} now.`);
    }
  } else if (parsed.options.has('plan-id') && (parsed.options.get('plan-id') ?? '').trim() !== planId) {
    // AN ADDITIVE EDIT GIVEN A PLAN ID IS BOUND BY IT (kickoffs/s106 row 5; the Report triaged 2026-10-08 06:58 PDT): it
    // was ignored, so a seat that previewed, then applied after the page moved, wrote anyway. Without one it stays ungated.
    const word = Object.keys(MODE_WORDS).find((key) => MODE_WORDS[key] === mode) ?? mode;
    refuse(
      `${word} was given a --plan-id that is not this edit's: rerun --preflight and pass its exact plan_id, or leave --plan-id out. ` +
        `A different plan_id means the page changed since the preview; it reads ${currentHash} now. Nothing was written.`,
    );
  }

  const pageLabel = pageName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const writtenBody = filledReplacement ?? (filling ? fillBody() : proposedBody);
  let writtenHash = removingPage ? null : pageComparisonSha256(front + writtenBody);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  // `Join-Path $workspace "internal/publication-journals/..."`, which normalises every separator:
  // measured against the NAS in S34, the oracle's result reports backslashes throughout.
  const journalPath = path.join(workspace, 'internal', 'publication-journals', `project-edit-${slug}-${pageLabel}-${stamp}-${planId.substring(planId.length - 8)}.json`);
  // THE HUB'S WRITE ORDER (kickoffs/s160 row 6): a number per Hub, taken at the first save, which is always under the Hub
  // lock, so `hub history` orders by it where a clock step back (WSL2's) would reorder the times.
  let sequence: number | null = null;
  const nextSequence = (): number => {
    const counter = path.join(workspace, 'internal', 'hub-sequences', `${slug}.txt`);
    const last = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim()) : 0;
    const next = (Number.isSafeInteger(last) && last > 0 ? last : 0) + 1;
    fs.mkdirSync(path.dirname(counter), { recursive: true });
    fs.writeFileSync(counter, `${next}\n`, 'utf8');
    return next;
  };
  // WHAT `deskpost undo` NEEDS (kickoffs/s165 row 1), for the gated modes on a local Hub: the page's prior bytes, read
  // under the lock, and in the complete journal its after hash. A Hub edit from a Notebook page is its own evidence.
  const undoable = !shared && isReplacing;
  let prior: UndoPathBefore[] = [];
  const saveJournal = (state: string, errorText: string): void => {
    sequence ??= nextSequence();
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-edit',
      timestamp_utc: now.toISOString(),
      sequence,
      project_id: store.projectId,
      project_slug: slug,
      page_path: pagePath,
      page_file: shared ? null : `collection/${pagePath}`,
      mode,
      section: nullable(section),
      match_text: ITEM_MODES.includes(mode) ? matchText : null,
      approved_plan_id: planId,
      previous_sha256: currentHash,
      proposed_sha256: proposedHash,
      ...(filling ? { written_sha256: writtenHash } : {}),
      planned_records: notebookSource === null ? [] : [{ path: pagePath, source: notebookSource, sha256: notebookSourceHash }],
      previous_body: currentBody,
      error: errorText,
      ...(state === 'complete' && undoable
        ? {
            undo: undoBlock(workspace, {
              kind: 'hub-edit',
              locks: [`projects/${slug}`],
              before: prior,
              evidence: notebookSource === null ? [] : [{ path: path.relative(workspace, journalPath).replace(/\\/g, '/'), kind: 'publication-evidence' }],
              seat,
            }),
          }
        : {}),
    };
    const file = path.resolve(journalPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, psConvertToJson(journal), 'utf8');
  };

  // THE LOCK IS TAKEN BEFORE THE FINAL RE-READ AND HELD THROUGH THE JOURNAL, as the oracle holds it.
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const lock = enterBookLock(workspace, `projects/${slug}`, Number.isFinite(timeout) ? timeout : 20);
  let verified = false;
  let removed = false;
  try {
    const recheck = await store.read(pagePath);
    if (recheck === null) refuse(`Page '${pagePath}' disappeared between the plan and the write; nothing was written.`);
    if (sha256OfText(removeFrontmatter(recheck).replace(/\r\n/g, '\n')) !== sha256OfText(currentBody.replace(/\r\n/g, '\n'))) {
      refuse(
        `Page '${pagePath}' changed after this edit was planned, so nothing was written. Re-read the page and plan the edit again; the text you were editing is no longer what is there.`,
      );
    }
    if (removingPage) {
      assertLocalFile();
      if (pageComparisonSha256(recheck) !== currentHash
        || JSON.stringify(pagesLinkingTo(workspace, slug, pageName)) !== JSON.stringify(linkedFrom)) {
        refuse('The page or its links changed after preflight. Nothing was written.');
      }
    }
    if (undoable) prior = capturePriorBytes(workspace, [localPage]);
    saveJournal('pending', '');
    if (removingPage) {
      fs.unlinkSync(localPage);
      removed = true;
      if (fs.existsSync(localPage)) refuse(`Removed page '${pagePath}' is still present.`);
    } else {
      await store.write(pagePath, writtenBody);
      const readback = await store.read(pagePath);
      if (readback === null) refuse(`Write '${pagePath}' did not become readable.`);
      if (sha256OfText(removeFrontmatter(readback).replace(/\r\n/g, '\n')) !== sha256OfText(writtenBody.replace(/\r\n/g, '\n'))) {
        refuse(`Readback of '${pagePath}' did not match the approved text; the previous text is in ${journalPath}.`);
      }
      writtenHash = pageComparisonSha256(readback);
    }
    warn(true);
    verified = !removingPage;
    saveJournal('complete', '');
    verified = true;
  } catch (error) {
    let failure = (error as Error).message;
    if (removed && !verified && !fs.existsSync(localPage)) {
      try { writeAtomicBytes(localPage, Buffer.from(prior[0]!.content_base64!, 'base64')); }
      catch (rollback) { failure += ` Page restore failed: ${(rollback as Error).message}`; }
    }
    if (!verified) {
      try {
        saveJournal('incomplete', failure);
      } catch {
        /* the refusal in flight is the one to report */
      }
    }
    if (verified) refuse(`The Project edit was verified, but its journal could not be saved: ${failure}`);
    if (failure !== (error as Error).message) refuse(failure);
    throw error;
  } finally {
    exitBookLock(lock);
  }

  return {
    schema: 1,
    operation: 'Edit Project Hub',
    project_slug: slug,
    page_path: pagePath,
    page_file: shared ? null : `collection/${pagePath}`,
    mode,
    section: nullable(section),
    match_text: ITEM_MODES.includes(mode) ? matchText : null,
    plan_id: planId,
    previous_sha256: currentHash,
    written_sha256: writtenHash,
    ...(filling ? { approved_sha256: proposedHash, time_placeholders_filled: true } : {}),
    added_lines: counts.added_lines,
    removed_lines: counts.removed_lines,
    journal_path: journalPath,
    precondition_verified: true,
    written: true,
    // THE SAME TWO FIELDS collection add-page REPORTS (S72 row 5, Report 2026-09-29): an agent that checks `status`
    // could not tell a Hub write from a failure without reading the page back. Additive: `written` and `journal_path`
    // stay. `journal` is workspace-relative with forward slashes, as collectionpage.ts says it.
    status: 'written',
    journal: path.relative(workspace, journalPath).replace(/\\/g, '/'),
    advice: null,
    shared_library_write: !shared ? false : true,
  };
}

// --- the time of the write (kickoffs/s121 row 6) ---------------------------------------------------------------------

/**
 * `{now}` AND `{today}`, FILLED WHEN THE WRITE IS APPLIED (the Report "Missing tool: hub edit cannot stamp the time of a
 * write", 2026-10-14): seats typed clock times into Hub records and got them wrong. `{now}` is the local time with the
 * system's zone (`2026-10-15 11:14 AM PDT`), `{today}` the local date; `{{now}}` and `{{today}}` write the word in
 * single braces. Shared by `hub edit` (every mode) and `capture`.
 */
const TIME_PLACEHOLDER = /\{\{(now|today)\}\}|\{(now|today)\}/g;

export const TIME_PLACEHOLDER_NOTE =
  'The text holds {now} or {today}: they are shown here as written, and filled with the time and date of the write when it is applied ({{now}} writes {now}).';

function mapMarkdownProse(text: string, map: (prose: string) => string): string {
  const pieces = text.split(/(\r\n|\n|\r)/);
  const lines = pieces.filter((_, index) => index % 2 === 0);
  const fenced = fencedLineMask(lines);
  const quotes = lines.map((line, index) => {
    const prefix = fenced[index] ? '' : /^(?:[ \t]*>[ \t]*)+/.exec(line)?.[0] ?? '';
    return { depth: prefix.replace(/[ \t]/g, '').length, text: line.slice(prefix.length) };
  });
  // A quoted fence is scoped to consecutive lines at the same quote depth.
  for (let start = 0; start < quotes.length;) {
    const { depth } = quotes[start]!;
    if (depth === 0) {
      start++;
      continue;
    }
    let end = start + 1;
    while (quotes[end]?.depth === depth) end++;
    const quotedFence = fencedLineMask(quotes.slice(start, end).map(line => line.text));
    quotedFence.forEach((inside, index) => { fenced[start + index] = inside; });
    start = end;
  }
  const mapInline = (chunk: string): string => {
    const ticks = [...chunk.matchAll(/`+/g)];
    const nextByLength = new Map<number, number>();
    const closing = new Map<number, number>();
    for (let index = ticks.length - 1; index >= 0; index--) {
      const size = ticks[index]![0].length;
      const next = nextByLength.get(size);
      if (next !== undefined) closing.set(index, next);
      nextByLength.set(size, index);
    }
    let result = '', start = 0;
    for (let index = 0; index < ticks.length; index++) {
      const open = ticks[index]!;
      const close = closing.get(index);
      if (close === undefined || (/(?:^|[^\\])(?:\\\\)*\\$/.test(chunk.slice(0, open.index)))) continue;
      const end = ticks[close]!.index + ticks[close]![0].length;
      result += map(chunk.slice(start, open.index)) + chunk.slice(open.index, end);
      start = end;
      index = close;
    }
    return result + map(chunk.slice(start));
  };
  let result = '', prose = '';
  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index]! + (pieces[index + 1] ?? '');
    if (fenced[index / 2]) {
      result += mapInline(prose) + line;
      prose = '';
    } else prose += line;
  }
  return result + mapInline(prose);
}

export function hasTimePlaceholders(text: string): boolean {
  let found = false;
  mapMarkdownProse(text, prose => { found ||= new RegExp(TIME_PLACEHOLDER.source).test(prose); return prose; });
  return found;
}

export function fillTimePlaceholders(text: string, now: Date = new Date()): string {
  return mapMarkdownProse(text, prose => formatTimePlaceholders(prose, now));
}

function formatTimePlaceholders(text: string, now: Date): string {
  const hours = now.getHours();
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? '';
  const time = `${localDate(now)} ${hours % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}${zone ? ` ${zone}` : ''}`;
  return text.replace(TIME_PLACEHOLDER, (_match, escaped: string | undefined, word: string | undefined) =>
    escaped !== undefined ? `{${escaped}}` : word === 'now' ? time : localDate(now));
}

/** Advisory only: check the text supplied by the caller before filling its placeholders. */
export function writeTimeWarning(text: string, now: Date): string | null {
  const stamps: string[] = [];
  for (const match of text.split(/\r\n|\n|\r/).slice(0, 5).join('\n').matchAll(/\b(\d{4}-\d{2}-\d{2}) ([1-9]|1[0-2]):([0-5]\d) (AM|PM)(?: [A-Za-z][A-Za-z0-9+:-]*)?\b/g)) {
    const minute = (Number(match[2]) % 12 + (match[4] === 'PM' ? 12 : 0)) * 60 + Number(match[3]);
    if (match[1] === localDate(now) && Math.abs(minute - (now.getHours() * 60 + now.getMinutes())) > 5) stamps.push(match[0]);
  }
  return stamps.length ? `Typed time ${stamps.join('; ')} differs from the write's time ${fillTimePlaceholders('{now}', now)} by more than 5 minutes: if it is the time of this write, use {now}; a past time quoted with its date is history and stays as written.` : null;
}

/**
 * `{session}`, FILLED BESIDE `{now}` BY `hub edit` ALONE (kickoffs/s169 row 2): a Kickoff's attempt page asks for the session
 * id, and a seat had no plain way to read it. The seat's recorded conversation, `unrecorded` when none is or it cannot be
 * read (a failed read never blocks the write, as in `capture`); `{{session}}` writes `{session}`.
 */
const SESSION_PLACEHOLDER = /\{\{session\}\}|\{session\}/g;

const HUB_PLACEHOLDER_NOTE =
  "The text holds {now}, {today} or {session}: they are shown here as written, and filled with the time, the date and this seat's session id (unrecorded when none is recorded) when it is applied ({{now}} writes {now}, {{session}} writes {session}).";

function hasWritePlaceholders(text: string): boolean {
  let found = false;
  mapMarkdownProse(text, prose => {
    found ||= new RegExp(TIME_PLACEHOLDER.source).test(prose) || new RegExp(SESSION_PLACEHOLDER.source).test(prose);
    return prose;
  });
  return found;
}

function fillWritePlaceholders(text: string, now: Date, stateDirectory: string, seat: () => string): string {
  let session = '';
  if (new RegExp(SESSION_PLACEHOLDER.source).test(text)) {
    try { session = seatConversationRecord(stateDirectory, seat()).sessionId; } catch { session = ''; }
  }
  return mapMarkdownProse(text, prose => formatTimePlaceholders(prose.replace(SESSION_PLACEHOLDER,
    match => match === '{{session}}' ? '{session}' : session || 'unrecorded'), now));
}

/** new-page's text as given, read the way new-page reads it, or null when it cannot be read (new-page then says why). */
function newPageText(content: string, contentPath: string, workspace: string): string | null {
  if (content.trim() !== '') return content;
  if (contentPath.trim() === '') return null;
  try {
    const full = resolveContentPath(workspace, contentPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}
