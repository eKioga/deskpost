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
import { readMarker } from './workspace.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { McpSession, readExactOrNull, resolveCollectionId, resolveMcpUrl } from './basicmemory.ts';
import { assertCollectionWriteAllowed } from './ownership.ts';

class HubEditRefusal extends Error {}

function refuse(message: string): never {
  throw new HubEditRefusal(message);
}

const PAGE_SIZE_THRESHOLD = 40000;
const SECTION_SIZE_THRESHOLD = 12000;
const ENTRY_SIZE_THRESHOLD = 1200;

export const EDIT_MODES = ['AddSection', 'AppendSection', 'RemoveSection', 'ReplaceSection', 'ReplaceBody', 'CheckItem', 'ReplaceItem'] as const;
export type EditMode = (typeof EDIT_MODES)[number];
const SECTION_MODES: EditMode[] = ['AddSection', 'AppendSection', 'RemoveSection', 'ReplaceSection'];
const ITEM_MODES: EditMode[] = ['CheckItem', 'ReplaceItem'];

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

function removeTrailingBlank(lines: string[]): string[] {
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
function fencedLineMask(lines: string[]): boolean[] {
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

interface Heading {
  index: number;
  level: number;
  text: string;
}

function headings(lines: string[]): Heading[] {
  const fenced = fencedLineMask(lines);
  const found: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const match = /^[ ]{0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(lines[i]!);
    if (match) found.push({ index: i, level: match[1]!.length, text: match[2]! });
  }
  return found;
}

interface Span {
  start: number;
  end: number;
}

function sectionSpan(lines: string[], section: string): Span | null {
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

function sectionText(lines: string[], span: Span | null): string {
  if (span === null) return '';
  return removeTrailingBlank(lines.slice(span.start, span.end)).join('\n');
}

/** `Test-ListLine`, whose `-match` is case-insensitive -- which no character in it can feel. */
function isListLine(line: string): boolean {
  return /^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+/.test(line);
}

interface Entry {
  index: number;
  line: string;
  hasStatus: boolean;
}

function topLevelEntries(lines: string[], start: number, end: number): Entry[] {
  const fenced = fencedLineMask(lines);
  const entries: Entry[] = [];
  for (let i = start; i < end; i++) {
    const match = fenced[i] ? null : /^(?:[-*+]|[0-9]+\.)[ \t]+(.*)$/.exec(lines[i]!);
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

interface Block {
  start: number;
  end: number;
}

function itemBlocks(lines: string[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let index = start;
  while (index < end) {
    if (isListLine(lines[index]!)) {
      let last = index;
      let scan = index + 1;
      while (scan < end && !isListLine(lines[scan]!) && /^[ \t]+\S/.test(lines[scan]!)) {
        last = scan;
        scan++;
      }
      blocks.push({ start: index, end: last });
      index = scan;
      continue;
    }
    if (!isBlank(lines[index])) blocks.push({ start: index, end: index });
    index++;
  }
  return blocks;
}

function findUniqueBlock(lines: string[], start: number, end: number, matchText: string): Block {
  if (isBlank(matchText)) refuse('MatchText is required: give text that appears in exactly one item or line.');
  const matched = itemBlocks(lines, start, end).filter((block) => lines.slice(block.start, block.end + 1).join(' ').includes(matchText));
  if (matched.length === 0) refuse(`No item or line contains '${matchText}'.`);
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
  if (!match) refuse(`That item is not a checkbox: ${line.trim()}`);
  return `${match[1]}[${checked ? 'x' : ' '}]${match[3]}`;
}

/** `New-ProjectBodyRaw`. */
function newProjectBodyRaw(currentBody: string, mode: EditMode, section: string, content: string, matchText: string, uncheck: boolean): string {
  const lines = toLines(currentBody);
  const addition = removeTrailingBlank(toLines(content));
  if (mode === 'RemoveSection') {
    if (!isBlank(content)) refuse('RemoveSection takes no content.');
    if (!isBlank(matchText)) refuse('RemoveSection takes no MatchText.');
    if (section === 'Purpose' || section === 'Now' || section === 'Next') refuse(`Section '${section}' is structural and cannot be removed.`);
  }
  if (!['ReplaceBody', 'CheckItem', 'RemoveSection'].includes(mode) && addition.length === 0) refuse('The supplied content is empty.');

  if (ITEM_MODES.includes(mode)) {
    let start = 0;
    let end = lines.length;
    if (!isBlank(section)) {
      const itemSpan = sectionSpan(lines, section);
      if (itemSpan === null) refuse(`Section '${section}' was not found.`);
      start = itemSpan.start + 1;
      end = itemSpan.end;
    }
    const block = findUniqueBlock(lines, start, end, matchText);
    const result = lines.slice(0, block.start);
    if (mode === 'CheckItem') {
      result.push(setCheckboxState(lines[block.start]!, !uncheck));
      result.push(...lines.slice(block.start + 1, block.end + 1));
    } else {
      result.push(...addition);
    }
    result.push(...lines.slice(block.end + 1));
    return joinLines(result);
  }

  if (mode === 'ReplaceBody') {
    if (addition.length === 0) refuse('ReplaceBody requires a non-empty body.');
    return joinLines(addition);
  }

  const span = sectionSpan(lines, section);
  if (mode === 'AddSection') {
    if (span !== null) refuse(`Section '${section}' already exists; use AppendSection or ReplaceSection.`);
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
    result.push(...sectionLines);
    // A bullet added to a list continues that list; prose gets its own paragraph break.
    const continuesList = insideList(sectionLines) && isListLine(addition[0]!);
    if (!continuesList) result.push('');
    result.push(...addition);
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
function assertNowStructure(currentBody: string, proposedBody: string, mode: EditMode, section: string, content: string): void {
  if (mode === 'CheckItem') return;
  if (!['AppendSection', 'AddSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem'].includes(mode)) return;
  const proposedLines = toLines(proposedBody);
  const proposedSpan = sectionSpan(proposedLines, 'Now');
  if (proposedSpan === null) return;
  let targetsNow = mode === 'ReplaceBody' || section === 'Now';
  if (mode === 'ReplaceItem' && !targetsNow) {
    const currentLines = toLines(currentBody);
    const currentSpan = sectionSpan(currentLines, 'Now');
    if (currentSpan !== null) targetsNow = sectionText(currentLines, currentSpan) !== sectionText(proposedLines, proposedSpan);
  }
  if (!targetsNow) return;
  if (mode !== 'ReplaceBody') {
    const contentLines = removeTrailingBlank(toLines(content));
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

/** `New-ProjectBody`: the proposed page, or the refusal that stops the edit before any write. */
export function newProjectBody(currentBody: string, mode: EditMode, section: string, content: string, matchText: string, uncheck: boolean): string {
  const proposed = newProjectBodyRaw(currentBody, mode, section, content, matchText, uncheck);
  assertNowStructure(currentBody, proposed, mode, section, content);
  return proposed;
}

export function changeCounts(oldBody: string, newBody: string): { added_lines: number; removed_lines: number } {
  const oldLines = toLines(oldBody).filter((line) => !isBlank(line));
  const newLines = toLines(newBody).filter((line) => !isBlank(line));
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

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sizeExempt(pagePath: string): boolean {
  return /(^|\/)(notes\/|limits(\.md)?$)/.test(pagePath.replace(/\\/g, '/'));
}

export function pageSizeRemedy(pagePath: string): string {
  const normalized = pagePath.replace(/\\/g, '/');
  if (/(^|\/)connections\.md$/.test(normalized)) return 'Prune entries that no longer earn their place, or split them onto topic pages.';
  if (/(^|\/)_project\.md$/.test(normalized)) {
    return 'Move history to a dated notes/ page, connections to the companion connections page, and accepted limits to the limits page (ADR-0013).';
  }
  return 'Move detail onto a linked page and keep this one to what a reader needs on arrival.';
}

function pageSizeStatus(body: string, pagePath: string): Record<string, PsJsonValue> {
  const size = utf8Length(body);
  const exempt = sizeExempt(pagePath);
  const oversized = size > PAGE_SIZE_THRESHOLD;
  return { size_bytes: size, threshold_bytes: PAGE_SIZE_THRESHOLD, oversized, exempt, warn: oversized && !exempt };
}

function sectionSizes(body: string): { section: string; size_bytes: number }[] {
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
  const warned = oversized.filter((entry) => (after.get(entry.section) ?? 0) > (before.get(entry.section) ?? 0));
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

function entrySizes(body: string): { section: string; key: string; label: string; size_bytes: number }[] {
  const lines = toLines(body);
  const level2 = headings(lines).filter((heading) => heading.level === 2);
  const sizes: { section: string; key: string; label: string; size_bytes: number }[] = [];
  level2.forEach((heading, h) => {
    const sectionEnd = h + 1 < level2.length ? level2[h + 1]!.index : lines.length;
    const entries = topLevelEntries(lines, heading.index + 1, sectionEnd);
    entries.forEach((entry, e) => {
      const end = e + 1 < entries.length ? entries[e + 1]!.index : sectionEnd;
      let bytes = 0;
      for (let j = entry.index; j < end; j++) bytes += utf8Length(lines[j]!) + 1;
      sizes.push({ section: heading.text, key: `${heading.text}\n${entry.line}`, label: entryLabel(entry.line), size_bytes: bytes });
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

function sizeWarningLines(warnings: Record<string, PsJsonValue>[], pagePath: string): string[] {
  const out: string[] = [];
  const [page, section, entry] = warnings as [Record<string, PsJsonValue>, Record<string, PsJsonValue>, Record<string, PsJsonValue>];
  if (page['warn']) out.push(`Project Hub page '${pagePath}' is ${page['size_bytes']} bytes. ${pageSizeRemedy(pagePath)}`);
  if (section['warn']) {
    for (const oversized of section['warned_sections'] as { section: string; size_bytes: number }[]) {
      out.push(
        `Section '${oversized.section}' on '${pagePath}' grew to ${oversized.size_bytes} bytes. Usually this section is holding items it cannot close rather than verbose ones: send a limit whose proof needs an event you cannot cause to the limits page with a disposition, a settled question to ## Decisions and its record, and a standing practice to the subject's own rules. Sort before you shorten (ADR-0013).`,
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
      const response = (await session.callTool('write_note', {
        project_id: projectId,
        directory: pagePath.substring(0, pagePath.lastIndexOf('/')),
        title: path.posix.basename(pagePath, '.md'),
        content: body,
        note_type: 'note',
        overwrite: true,
        output_format: 'json',
      })) as Record<string, unknown> | null;
      const result = response?.['result'] as Record<string, unknown> | undefined;
      if ((response?.['error'] ?? null) !== null || result?.['isError'] === true) refuse(`Write '${pagePath}' was rejected.`);
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
    async write(pagePath: string, body: string): Promise<void> {
      writeAtomicText(file(pagePath), body);
    },
  };
}

// --- the verb -----------------------------------------------------------------------------------------

const MODE_WORDS: Record<string, EditMode> = {
  'add-section': 'AddSection',
  'append-section': 'AppendSection',
  'remove-section': 'RemoveSection',
  'replace-section': 'ReplaceSection',
  'replace-body': 'ReplaceBody',
  'check-item': 'CheckItem',
  'replace-item': 'ReplaceItem',
};

function nullable(value: string): PsJsonValue {
  return isBlank(value) ? null : value;
}

export async function hubEdit(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['mode', 'section', 'match-text', 'content', 'content-path', 'page', 'seat', 'plan-id', 'workspace', 'lock-timeout']);
  const slug = parsed.positional[0] ?? '';
  const modeWord = parsed.options.get('mode') ?? '';
  if (isBlank(slug)) refuse('ProjectSlug is required.');
  if (isBlank(modeWord)) refuse('Mode is required: AddSection, AppendSection, CheckItem, RemoveSection, ReplaceItem, ReplaceSection, or ReplaceBody.');
  const mode = MODE_WORDS[modeWord] ?? (EDIT_MODES as readonly string[]).find((name) => name.toLowerCase() === modeWord.toLowerCase());
  if (mode === undefined) {
    refuse(`library hub edit has no mode '${modeWord}'. It has: ${Object.keys(MODE_WORDS).join(', ')}.`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) refuse('ProjectSlug must use lowercase letters, digits, and single hyphens.');

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

  let section = parsed.options.get('section') ?? '';
  const matchText = parsed.options.get('match-text') ?? '';
  const contentGiven = parsed.options.has('content');
  const contentPathGiven = parsed.options.has('content-path');
  let content = parsed.options.get('content') ?? '';
  const contentPath = parsed.options.get('content-path') ?? '';
  if (SECTION_MODES.includes(mode) && isBlank(section)) refuse(`${mode} requires -Section, the exact level-two heading text without the leading '##'.`);
  if (!isBlank(section)) section = section.trim().replace(/^#+/, '').trim();
  if (mode === 'RemoveSection') {
    if (section === 'Purpose' || section === 'Now' || section === 'Next') refuse(`Section '${section}' is structural and cannot be removed.`);
    if (contentGiven || contentPathGiven) refuse('RemoveSection takes no content; do not supply -Content or -ContentPath.');
    if (parsed.options.has('match-text')) refuse('RemoveSection takes no -MatchText.');
  }
  if (ITEM_MODES.includes(mode) && isBlank(matchText)) {
    refuse(`${mode} requires -MatchText: text appearing in exactly one item, matched case-sensitively. -Section is optional and narrows the search.`);
  }
  const usedContent = !isBlank(content);
  const usedContentPath = !isBlank(contentPath);
  let contentFull = '';
  if (mode === 'CheckItem') {
    if (usedContent || usedContentPath) refuse('CheckItem changes only the checkbox marker; it takes no content.');
  } else if (mode !== 'RemoveSection' && usedContent === usedContentPath) {
    refuse('Supply exactly one of -Content or -ContentPath.');
  }
  if (usedContentPath) {
    contentFull = path.resolve(path.isAbsolute(contentPath) ? contentPath : path.join(workspace, contentPath));
    if (!fs.existsSync(contentFull) || !fs.statSync(contentFull).isFile()) refuse(`ContentPath '${contentPath}' is not a file.`);
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(contentFull));
    } catch (error) {
      refuse(`ContentPath '${contentPath}' is not valid UTF-8: ${(error as Error).message}`);
    }
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
    refuse(`Project '${slug}' is not open. Open it first: tools/Set-VirtualDesk.ps1 -Action Open -Kind Project -Slug ${slug}`);
  }

  const isReplacing = ['RemoveSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem'].includes(mode);
  const existing = await store.read(pagePath);
  if (existing === null) {
    refuse(
      `Page '${pagePath}' does not exist. This helper edits existing Project pages; create a Hub with tools/New-ProjectHub.ps1 or copy Notebook pages with tools/Copy-LocalPagesToProject.ps1.`,
    );
  }
  const currentBody = removeFrontmatter(existing);
  const proposedBody = newProjectBody(currentBody, mode, section, content, matchText, parsed.flags.has('uncheck'));
  const currentLines = toLines(currentBody);
  const proposedLines = toLines(proposedBody);
  if (mode === 'CheckItem') {
    if (currentLines.length !== proposedLines.length) refuse('CheckItem would change the page shape; the edit stopped without writing.');
    const differing = currentLines.map((_, i) => i).filter((i) => currentLines[i] !== proposedLines[i]);
    if (differing.length > 1) refuse(`CheckItem would change ${differing.length} lines; the edit stopped without writing.`);
    if (differing.length === 1) {
      const normalizedOld = currentLines[differing[0]!]!.replace(/\[[ xX]\]/g, '[ ]');
      const normalizedNew = proposedLines[differing[0]!]!.replace(/\[[ xX]\]/g, '[ ]');
      if (normalizedOld !== normalizedNew) refuse('CheckItem would change more than the checkbox marker; the edit stopped without writing.');
    }
  } else if (!isReplacing && !linesPreserved(currentLines, proposedLines)) {
    refuse(`${mode} would not preserve the existing page text; the edit stopped without writing.`);
  }

  const currentHash = sha256OfText(currentBody);
  const proposedHash = sha256OfText(proposedBody);
  const counts = changeCounts(currentBody, proposedBody);
  const planId = 'project-edit-' + sha256OfText(`${pagePath}|${mode}|${section}|${matchText}|${currentHash}|${proposedHash}`);
  let sectionBefore: PsJsonValue = null;
  let sectionAfter: PsJsonValue = null;
  let itemBefore: PsJsonValue = null;
  let itemAfter: PsJsonValue = null;
  if (SECTION_MODES.includes(mode)) {
    sectionBefore = sectionText(currentLines, sectionSpan(currentLines, section));
    const afterSpan = sectionSpan(proposedLines, section);
    sectionAfter = afterSpan === null ? null : sectionText(proposedLines, afterSpan);
  }
  if (ITEM_MODES.includes(mode)) {
    let scopeStart = 0;
    let scopeEnd = currentLines.length;
    if (!isBlank(section)) {
      const itemSpan = sectionSpan(currentLines, section)!;
      scopeStart = itemSpan.start + 1;
      scopeEnd = itemSpan.end;
    }
    const block = findUniqueBlock(currentLines, scopeStart, scopeEnd, matchText);
    itemBefore = currentLines.slice(block.start, block.end + 1).join('\n');
    itemAfter = mode === 'CheckItem' ? proposedLines.slice(block.start, block.end + 1).join('\n') : removeTrailingBlank(toLines(content)).join('\n');
  }

  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Edit Project Hub',
    project_slug: slug,
    page_path: pagePath,
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
    section_after: sectionAfter,
    item_before: itemBefore,
    item_after: itemAfter,
    plan_id: planId,
    confirmation_required: isReplacing,
    advice: null,
    shared_library_write: false,
  };

  // Computed BEFORE the preflight return, from the proposed body, so a preflight can report them.
  const sizeWarnings = [
    pageSizeStatus(proposedBody, pagePath),
    sectionSizeStatus(proposedBody, pagePath, currentBody),
    entrySizeStatus(proposedBody, pagePath, currentBody),
  ];
  const warn = (): void => {
    for (const line of sizeWarningLines(sizeWarnings, pagePath)) process.stderr.write(`WARNING: ${line}\n`);
  };

  if (parsed.flags.has('preflight')) {
    plan['page_size_warning'] = sizeWarnings[0]!;
    plan['section_size_warning'] = sizeWarnings[1]!;
    plan['entry_size_warning'] = sizeWarnings[2]!;
    warn();
    return plan;
  }
  if (plan['unchanged']) {
    return { schema: 1, operation: 'Edit Project Hub', project_slug: slug, page_path: pagePath, mode, unchanged: true, written: false, shared_library_write: false };
  }
  if (isReplacing) {
    if (!parsed.flags.has('user-confirmed')) refuse(`${mode} removes existing text and is not yet performed: review the preflight and rerun with -UserConfirmed.`);
    if ((parsed.options.get('plan-id') ?? '') !== planId) refuse(`${mode} is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId.`);
  }

  const pageLabel = pageName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  // `Join-Path $workspace "internal/publication-journals/..."`, which normalises every separator:
  // measured against the NAS in S34, the oracle's result reports backslashes throughout.
  const journalPath = path.join(workspace, 'internal', 'publication-journals', `project-edit-${slug}-${pageLabel}-${stamp}-${planId.substring(planId.length - 8)}.json`);
  const saveJournal = (state: string, errorText: string): void => {
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-edit',
      timestamp_utc: now.toISOString(),
      project_id: store.projectId,
      project_slug: slug,
      page_path: pagePath,
      mode,
      section: nullable(section),
      match_text: ITEM_MODES.includes(mode) ? matchText : null,
      approved_plan_id: planId,
      previous_sha256: currentHash,
      proposed_sha256: proposedHash,
      planned_records: notebookSource === null ? [] : [{ path: pagePath, source: notebookSource, sha256: notebookSourceHash }],
      previous_body: currentBody,
      error: errorText,
    };
    const file = path.resolve(journalPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, psConvertToJson(journal), 'utf8');
  };

  // THE LOCK IS TAKEN BEFORE THE FINAL RE-READ AND HELD THROUGH THE JOURNAL, as the oracle holds it.
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const lock = enterBookLock(workspace, `projects/${slug}`, Number.isFinite(timeout) ? timeout : 20);
  let verified = false;
  try {
    const recheck = await store.read(pagePath);
    if (recheck === null) refuse(`Page '${pagePath}' disappeared between the plan and the write; nothing was written.`);
    if (sha256OfText(removeFrontmatter(recheck).replace(/\r\n/g, '\n')) !== sha256OfText(currentBody.replace(/\r\n/g, '\n'))) {
      refuse(
        `Page '${pagePath}' changed after this edit was planned, so nothing was written. Re-read the page and plan the edit again; the text you were editing is no longer what is there.`,
      );
    }
    saveJournal('pending', '');
    await store.write(pagePath, proposedBody);
    const readback = await store.read(pagePath);
    if (readback === null) refuse(`Write '${pagePath}' did not become readable.`);
    if (sha256OfText(removeFrontmatter(readback).replace(/\r\n/g, '\n')) !== sha256OfText(proposedBody.replace(/\r\n/g, '\n'))) {
      refuse(`Readback of '${pagePath}' did not match the approved text; the previous text is in ${journalPath}.`);
    }
    warn();
    verified = true;
    saveJournal('complete', '');
  } catch (error) {
    const failure = (error as Error).message;
    if (!verified) {
      try {
        saveJournal('incomplete', failure);
      } catch {
        /* the refusal in flight is the one to report */
      }
    }
    if (verified) refuse(`The Project edit was verified, but its journal could not be saved: ${failure}`);
    throw error;
  } finally {
    exitBookLock(lock);
  }

  return {
    schema: 1,
    operation: 'Edit Project Hub',
    project_slug: slug,
    page_path: pagePath,
    mode,
    section: nullable(section),
    match_text: ITEM_MODES.includes(mode) ? matchText : null,
    plan_id: planId,
    previous_sha256: currentHash,
    written_sha256: proposedHash,
    added_lines: counts.added_lines,
    removed_lines: counts.removed_lines,
    journal_path: journalPath,
    precondition_verified: true,
    written: true,
    advice: null,
    shared_library_write: !shared ? false : true,
  };
}
