/**
 * `library raw search` -- one named source batch under `raw/`, and never a scan across it.
 *
 * THE SHARED BOUNDARIES COME FIRST, because three tiers answer with them and a tier that kept its
 * own copy is how two search surfaces start disagreeing about what a match is.
 * `tools/SearchBoundaries.ps1` owns the numbers, the normalisation and the budget; this file owns
 * the walk and the provenance rule, exactly as `tools/RawSearch.ps1` does.
 *
 * WHAT MAKES THIS TIER DIFFERENT FROM THE BOOK TIERS. `raw/` has no Desk, no catalog, no slug and
 * no manifest, so there is nothing here for a validated reader to validate -- it is a filesystem
 * scan over untracked source material. What replaces the guard is PROVENANCE: every line carries a
 * label saying how it may be cited, and the rule fails closed twice. A path that does not
 * canonically resolve inside `raw/` is `unclassified`, and `unclassified` renders as strictly as
 * `historical`. There is no branch that can return "current", because nothing under `raw/` is.
 *
 * AN UNRECOGNISED BATCH IS REPORTED, NEVER GUESSED, and it is not an error: no scan happens, no
 * near match is chosen on the reader's behalf, the roster travels with the refusal so the next
 * attempt can be right, and the exit code stays 0 because the tool answered the question it was
 * asked. Widening to `raw/` is the one thing this tier must never do.
 *
 * REFUSING TO DESCEND IS THE CONTAINMENT. The walk is an explicit stack rather than a recursive
 * directory listing, for one reason: a recursive listing FOLLOWS a junction, and every file below
 * it still reports a path under the batch root -- so a junction into another batch, or out of
 * `raw/` entirely, would pass a textual containment test while serving content the reader never
 * named.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';

export const RAW_SEARCH_SCHEMA = 1;

/** `tools/SearchBoundaries.ps1`, value for value. */
const MAX_QUERY_LENGTH = 200;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CEILING = 500;
const MAX_MATCHED_BYTES = 65536;
const MAX_COLLECTED_MATCHES = 5000;
const MAX_LINE_CHARACTERS = 400;
const RAW_WALL_CLOCK_SECONDS = 20;
const RAW_MAX_FILES_SCANNED = 20000;
const RAW_MAX_FILE_BYTES = 1048576;
const RAW_SNIFF_BYTES = 8192;

/**
 * The declared retired-instruction roots. Declaring a parent covers its children, so a folder
 * inside one is not listed again -- a redundant entry would make the canary that removes one prove
 * nothing.
 */
const HISTORICAL_ROOTS = ['LLM Workflow Testing'];

const PROVENANCE_HISTORICAL = 'historical';
const PROVENANCE_EXTERNAL = 'external';
const PROVENANCE_UNCLASSIFIED = 'unclassified';

/** How many example paths a skip group shows. The group carries the true count. */
const SKIP_EXAMPLE_CAP = 5;

const SKIP_REPARSE = 'a reparse point (junction or symbolic link); this tier never follows one out of the batch';
const SKIP_EXTENSION = 'not a text extension this tier reads';
const SKIP_OVERSIZE = 'above the per-file size ceiling';
const SKIP_BINARY = 'binary content -- a NUL byte inside the sniffed prefix';
const SKIP_UNDECODABLE = 'not decodable as UTF-8';
const SKIP_UNREADABLE = 'could not be read';

/**
 * The cheap eligibility gate. An extension is a CLAIM about a file; the NUL sniff below is what
 * checks it. Names beginning with a dot land here too, because `.gitignore` reports as an
 * extension, so the handful worth reading are listed rather than special-cased.
 */
const TEXT_EXTENSIONS = new Set(
  [
    '.md', '.mdx', '.markdown', '.txt', '.text', '.rst', '.adoc', '.org', '.log',
    '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
    '.csv', '.tsv',
    '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.zsh', '.bat', '.cmd',
    '.py', '.rb', '.pl', '.lua', '.r',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.sql',
    '.html', '.htm', '.xml', '.xhtml', '.svg', '.css', '.scss', '.less',
    '.gitignore', '.gitattributes', '.editorconfig', '.env', '.npmrc', '.dockerignore',
  ].map((extension) => extension.toLowerCase()),
);

// --- normalisation, comparison and display ---------------------------------------------------------

/**
 * Unicode normalisation, then control and format characters to SPACES, then whitespace flattened,
 * then a case fold. Control characters become spaces rather than vanishing, which is what lets the
 * cheap pre-check below be proved incapable of a false negative.
 */
export function convertToSearchComparable(value: string): string {
  if (!value) return '';
  let text = value.normalize('NFC');
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same, WITHOUT the case fold, so a reader's own capitalisation survives being echoed back. */
export function convertToSearchDisplay(value: string): string {
  if (!value) return '';
  let text = value.normalize('NFC');
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

const needleTokens = new Map<string, string>();

/** The needle's longest whitespace-free ASCII token, for the cheap reject in front of the exact test. */
function searchNeedleToken(comparableNeedle: string): string {
  const cached = needleTokens.get(comparableNeedle);
  if (cached !== undefined) return cached;
  let best = '';
  for (const token of comparableNeedle.split(' ')) {
    if (token.length <= best.length) continue;
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(token)) best = token;
  }
  needleTokens.set(comparableNeedle, best);
  return best;
}

export function testSearchContains(haystack: string, comparableNeedle: string): boolean {
  if (!comparableNeedle || !haystack) return false;
  const token = searchNeedleToken(comparableNeedle);
  if (token.length > 0 && !haystack.toLowerCase().includes(token.toLowerCase())) return false;
  return convertToSearchComparable(haystack).includes(comparableNeedle);
}

/** One matched line, sanitised, flattened and cut to the per-line cap with the cut REPORTED. */
function convertToSearchLine(value: string): { text: string; truncated: boolean } {
  const display = convertToSearchDisplay(value);
  if (display.length <= MAX_LINE_CHARACTERS) return { text: display, truncated: false };
  return { text: display.substring(0, MAX_LINE_CHARACTERS), truncated: true };
}

/**
 * The comparable needle, or a refusal. The length test is against the RAW query, because that is
 * what the reader typed; the emptiness test is against the normalised form, because a query of
 * three control characters is not a query.
 */
export function assertSearchQuery(query: string | undefined): string {
  if (query === undefined || query === null) throw new Error('A search needs a query.');
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`A search query is capped at ${MAX_QUERY_LENGTH} characters; this one is ${query.length}.`);
  }
  const needle = convertToSearchComparable(query);
  if (!needle) throw new Error('A search query needs at least one non-blank character.');
  return needle;
}

/** Clamps at the ceiling and refuses below one: asking for zero results is a mistake worth naming. */
export function resolveSearchResultCap(requested: number): number {
  if (requested < 1) throw new Error('MaxResults must be at least 1.');
  if (requested > MAX_RESULTS_CEILING) return MAX_RESULTS_CEILING;
  return requested;
}

// --- the budget ------------------------------------------------------------------------------------

export interface SearchBudget {
  started: number;
  wallClockSeconds: number;
  maxMatchedBytes: number;
  maxFilesScanned: number;
  maxCollectedMatches: number;
  matchedBytes: number;
  filesScanned: number;
  collectedMatches: number;
  wallClockHit: boolean;
  matchedBytesHit: boolean;
  filesScannedHit: boolean;
  collectedMatchesHit: boolean;
}

export function newSearchBudget(options: {
  wallClockSeconds: number;
  maxMatchedBytes: number;
  maxFilesScanned: number;
  maxCollectedMatches: number;
}): SearchBudget {
  return {
    started: Date.now(),
    wallClockSeconds: options.wallClockSeconds,
    maxMatchedBytes: options.maxMatchedBytes,
    maxFilesScanned: options.maxFilesScanned,
    maxCollectedMatches: options.maxCollectedMatches,
    matchedBytes: 0,
    filesScanned: 0,
    collectedMatches: 0,
    wallClockHit: false,
    matchedBytesHit: false,
    filesScannedHit: false,
    collectedMatchesHit: false,
  };
}

/**
 * True once a SCAN budget is spent -- the three that mean pages went unread. The matched-byte
 * budget is deliberately not among them: it shortens the answer, it does not stop the search.
 */
export function testSearchBudgetSpent(budget: SearchBudget): boolean {
  if ((Date.now() - budget.started) / 1000 >= budget.wallClockSeconds) budget.wallClockHit = true;
  if (budget.filesScanned >= budget.maxFilesScanned) budget.filesScannedHit = true;
  if (budget.collectedMatches >= budget.maxCollectedMatches) budget.collectedMatchesHit = true;
  return budget.wallClockHit || budget.filesScannedHit || budget.collectedMatchesHit;
}

/**
 * Charged against a line actually being RETURNED, in UTF-8 bytes, because the cap exists to bound
 * what crosses a wire. The first line is always returned: an answer of nothing at all, because one
 * line happened to be large, is not a better answer.
 */
export function testSearchBudgetAcceptsText(budget: SearchBudget, text: string, isFirst: boolean): boolean {
  const size = Buffer.byteLength(text, 'utf8');
  if (!isFirst && budget.matchedBytes + size > budget.maxMatchedBytes) {
    budget.matchedBytesHit = true;
    return false;
  }
  budget.matchedBytes += size;
  return true;
}

/**
 * What a caller renders when a budget bound the answer. TWO SENTENCES, NEVER MERGED: a search that
 * stopped early MISSED PAGES, while an answer trimmed to the reply budget missed nothing -- it just
 * did not show it all.
 */
export function getSearchBudgetNote(budget: SearchBudget): string {
  const notes: string[] = [];
  const reasons: string[] = [];
  if (budget.wallClockHit) reasons.push(`the ${budget.wallClockSeconds}-second time budget`);
  if (budget.filesScannedHit) reasons.push(`the ${budget.maxFilesScanned}-page scan budget`);
  if (budget.collectedMatchesHit) reasons.push(`the ${budget.maxCollectedMatches}-match collection budget`);
  if (reasons.length) {
    notes.push(
      `This search STOPPED EARLY on ${reasons.join(' and ')}, so pages after that point were never read and this ` +
        'answer is INCOMPLETE -- the match total is a floor, not a count. Narrow the query or close a Book and ask again.',
    );
  }
  if (budget.matchedBytesHit) {
    notes.push(
      `The answer was trimmed to the ${budget.maxMatchedBytes}-byte reply budget, so fewer lines are shown than were ` +
        'found. Every page was still searched; ask a narrower query to see the rest.',
    );
  }
  // `[Environment]::NewLine` on the oracle's platform, and the harness normalises line endings.
  return notes.join('\r\n');
}

// --- paths and provenance --------------------------------------------------------------------------

function rawRootOf(workspace: string): string {
  return path.join(workspace, 'raw');
}

function isReparsePoint(full: string): boolean {
  try {
    return fs.lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The path a reader sees and a provenance decision is made from. Empty when the file does not
 * canonically sit under `raw/` at all, which is the input that makes a path `unclassified` rather
 * than `external` -- the fail-closed direction.
 */
function convertToRawRelativePath(rawRoot: string, full: string): string {
  if (!rawRoot || !full) return '';
  const root = path.resolve(rawRoot).replace(/[\\/]+$/, '');
  const resolved = path.resolve(full);
  // Windows paths compare case-insensitively, and the declared roots carry capitals and spaces.
  if (!resolved.toLowerCase().startsWith((root + path.sep).toLowerCase())) return '';
  return resolved.substring(root.length + 1).split(path.sep).join('/');
}

export function getRawProvenance(relative: string): string {
  if (!relative || !relative.trim()) return PROVENANCE_UNCLASSIFIED;
  const normalised = relative.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalised) return PROVENANCE_UNCLASSIFIED;
  for (const declared of HISTORICAL_ROOTS) {
    const root = declared.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!root) continue;
    const lower = normalised.toLowerCase();
    if (lower === root.toLowerCase()) return PROVENANCE_HISTORICAL;
    if (lower.startsWith(root.toLowerCase() + '/')) return PROVENANCE_HISTORICAL;
  }
  return PROVENANCE_EXTERNAL;
}

// --- the roster --------------------------------------------------------------------------------------

export interface RosterEntry {
  batch: string;
  depth: number;
  children: number;
  provenance: string;
}

function directoryNames(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isDirectory() || (item.isSymbolicLink() && safeIsDirectory(path.join(directory, item.name))))
      .map((item) => item.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch {
    return [];
  }
}

function safeIsDirectory(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function newRosterEntry(rawRoot: string, directory: string, depth: number): RosterEntry {
  const relative = convertToRawRelativePath(rawRoot, directory);
  return {
    batch: relative,
    depth,
    children: directoryNames(directory).length,
    provenance: getRawProvenance(relative),
  };
}

/**
 * The real directory shape of `raw/`, at the TWO depths a batch is actually found at -- reported,
 * never inferred into ownership. Deliberately does not count files: a file count means walking
 * everything to answer "what is here", which is a scan across `raw/` wearing an orientation's
 * clothes.
 */
export function getRawBatchRoster(workspace: string): RosterEntry[] {
  const rawRoot = rawRootOf(workspace);
  if (!safeIsDirectory(rawRoot)) return [];
  const entries: RosterEntry[] = [];
  for (const top of directoryNames(rawRoot)) {
    const topFull = path.join(rawRoot, top);
    if (isReparsePoint(topFull)) continue;
    entries.push(newRosterEntry(rawRoot, topFull, 1));
    for (const child of directoryNames(topFull)) {
      const childFull = path.join(topFull, child);
      if (isReparsePoint(childFull)) continue;
      entries.push(newRosterEntry(rawRoot, childFull, 2));
    }
  }
  return entries;
}

interface ResolvedBatch {
  recognised: boolean;
  batch: string;
  full: string;
  provenance: string;
  reason: string;
}

/**
 * A reader-named batch, or the reason it could not be resolved. NEVER widens to `raw/` itself and
 * never picks a near match: an unrecognised batch is reported with the roster.
 */
export function resolveRawBatch(workspace: string, batch: string | undefined): ResolvedBatch {
  const rawRoot = rawRootOf(workspace);
  const name = String(batch ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  const failure = (reason: string): ResolvedBatch => ({ recognised: false, batch: name, full: '', provenance: '', reason });

  if (!name.trim()) return failure('no source batch was named, and this tier never scans all of raw/');
  // `.` and `..` are how a name becomes a scan across raw/ or an escape out of it, so they are
  // refused by SHAPE rather than caught after resolution.
  const segments = name.split('/');
  if (name === '.' || segments.includes('..') || segments.includes('.')) {
    return failure('a source batch is a directory under raw/, named plainly; relative segments are not accepted');
  }
  if (!safeIsDirectory(rawRoot)) return failure('this workspace has no raw/ directory');

  const candidate = path.join(rawRoot, ...segments);
  if (!safeIsDirectory(candidate)) return failure(`no directory raw/${name} exists`);
  if (isReparsePoint(candidate)) return failure('that path is a reparse point, and this tier does not follow one');

  const relative = convertToRawRelativePath(rawRoot, candidate);
  if (!relative.trim()) return failure('that path does not canonically resolve inside raw/');

  return { recognised: true, batch: relative, full: path.resolve(candidate), provenance: getRawProvenance(relative), reason: '' };
}

// --- skip reporting ------------------------------------------------------------------------------------

interface SkipGroup {
  reason: string;
  count: number;
  examples: string[];
}

function addSkip(groups: Map<string, SkipGroup>, reason: string, relative: string): void {
  let group = groups.get(reason);
  if (!group) {
    group = { reason, count: 0, examples: [] };
    groups.set(reason, group);
  }
  group.count += 1;
  if (group.examples.length < SKIP_EXAMPLE_CAP) group.examples.push(relative);
}

function convertToSkipList(groups: Map<string, SkipGroup>): SkipGroup[] {
  return [...groups.values()].sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
  });
}

// --- reading -------------------------------------------------------------------------------------------

/** The decoded text, or null with the reason set -- one place decides a file is unreadable. */
function readRawFileText(full: string): { text: string | null; reason: string } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(full);
  } catch {
    return { text: null, reason: SKIP_UNREADABLE };
  }
  const sniff = Math.min(RAW_SNIFF_BYTES, bytes.length);
  for (let index = 0; index < sniff; index += 1) {
    if (bytes[index] === 0) return { text: null, reason: SKIP_BINARY };
  }
  // STRICT UTF-8. A lenient decoder returns mojibake as though it were the text the file holds,
  // and naming an undecodable file is the difference between an answer and a guess.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { text: null, reason: SKIP_UNDECODABLE };
  }
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.substring(1);
  return { text, reason: '' };
}

// --- the scan ------------------------------------------------------------------------------------------

export interface RawHit {
  batch: string;
  path: string;
  line: number;
  text: string;
  line_truncated: boolean;
  provenance: string;
}

export function findRawBatchLines(options: {
  workspace: string;
  batch: string | undefined;
  query: string;
  maxResults: number;
}): Record<string, PsJsonValue> {
  const workspace = path.resolve(options.workspace);
  const rawRoot = rawRootOf(workspace);

  // The query is validated BEFORE the batch is resolved, so a malformed query is reported as a
  // malformed query rather than as whatever the batch happened to be.
  const needle = assertSearchQuery(options.query);
  const cap = resolveSearchResultCap(options.maxResults);
  const resolved = resolveRawBatch(workspace, options.batch);

  if (!resolved.recognised) {
    return {
      schema: RAW_SEARCH_SCHEMA,
      query: convertToSearchDisplay(options.query),
      batch: resolved.batch,
      batch_recognised: false,
      batch_reason: resolved.reason,
      provenance: '',
      roster: getRawBatchRoster(workspace) as unknown as PsJsonValue,
      files_seen: 0,
      files_scanned: 0,
      files_skipped: [],
      files_skipped_total: 0,
      match_count: 0,
      match_count_is_floor: false,
      result_count: 0,
      truncated: false,
      max_results: cap,
      provenance_classes: [],
      budget_note: '',
      results: [],
    };
  }

  const budget = newSearchBudget({
    wallClockSeconds: RAW_WALL_CLOCK_SECONDS,
    maxMatchedBytes: MAX_MATCHED_BYTES,
    maxFilesScanned: RAW_MAX_FILES_SCANNED,
    maxCollectedMatches: MAX_COLLECTED_MATCHES,
  });

  const hits: RawHit[] = [];
  const skips = new Map<string, SkipGroup>();
  let filesSeen = 0;
  let filesScanned = 0;

  const stack: string[] = [resolved.full];
  while (stack.length > 0) {
    if (testSearchBudgetSpent(budget)) break;
    const current = stack.pop()!;

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      addSkip(skips, SKIP_UNREADABLE, convertToRawRelativePath(rawRoot, current));
      continue;
    }

    // NOT sorted here. Every result is sorted by path and line before it is returned.
    for (const child of children) {
      if (testSearchBudgetSpent(budget)) break;
      const full = path.join(current, child.name);
      const relative = convertToRawRelativePath(rawRoot, full);

      if (child.isSymbolicLink()) {
        addSkip(skips, SKIP_REPARSE, relative);
        continue;
      }
      if (child.isDirectory()) {
        stack.push(full);
        continue;
      }

      filesSeen += 1;
      if (!TEXT_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        addSkip(skips, SKIP_EXTENSION, relative);
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        addSkip(skips, SKIP_UNREADABLE, relative);
        continue;
      }
      if (size > RAW_MAX_FILE_BYTES) {
        addSkip(skips, SKIP_OVERSIZE, relative);
        continue;
      }

      const read = readRawFileText(full);
      if (read.text === null) {
        addSkip(skips, read.reason, relative);
        continue;
      }

      budget.filesScanned += 1;
      filesScanned += 1;
      const provenance = getRawProvenance(relative);

      let lineNumber = 0;
      for (const line of read.text.replace(/\r\n/g, '\n').split('\n')) {
        lineNumber += 1;
        if (!testSearchContains(line, needle)) continue;
        const rendered = convertToSearchLine(line);
        hits.push({
          batch: resolved.batch,
          path: relative,
          line: lineNumber,
          text: rendered.text,
          line_truncated: rendered.truncated,
          provenance,
        });
        budget.collectedMatches += 1;
        if (testSearchBudgetSpent(budget)) break;
      }
    }
  }

  const sorted = [...hits].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  });

  // The reply budget is spent HERE, on lines the reader will actually see. It can only make the
  // ANSWER shorter; it never stops the scan, and the two are reported by different sentences.
  const returned: RawHit[] = [];
  for (const hit of sorted.slice(0, cap)) {
    if (!testSearchBudgetAcceptsText(budget, hit.text, returned.length === 0)) break;
    returned.push(hit);
  }

  // Attached to the classes that actually CONTRIBUTED A LINE, not to whatever the batch contains,
  // because the warning is about the lines on the screen.
  const classes = [...new Set(returned.map((hit) => hit.provenance))].sort();
  const skipList = convertToSkipList(skips);
  let skippedTotal = 0;
  for (const group of skipList) skippedTotal += group.count;

  return {
    schema: RAW_SEARCH_SCHEMA,
    query: convertToSearchDisplay(options.query),
    batch: resolved.batch,
    batch_recognised: true,
    batch_reason: '',
    provenance: resolved.provenance,
    roster: [],
    files_seen: filesSeen,
    files_scanned: filesScanned,
    files_skipped: skipList as unknown as PsJsonValue,
    files_skipped_total: skippedTotal,
    match_count: sorted.length,
    match_count_is_floor: budget.wallClockHit || budget.filesScannedHit || budget.collectedMatchesHit,
    result_count: returned.length,
    truncated: sorted.length > returned.length,
    max_results: cap,
    provenance_classes: classes,
    budget_note: getSearchBudgetNote(budget),
    results: returned as unknown as PsJsonValue,
  };
}

export interface RawResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/**
 * `argv` is the whole `raw` verb's tail, so `positional[0]` is the action word itself. Sliced by
 * POSITION rather than by searching for 'search' in the list: a reader whose query happens to be
 * the word `search` would otherwise have their command cut in the wrong place.
 */
export function runRawSearch(argv: string[], workspace: string): RawResult {
  const parsed = parseArguments(argv, ['max-results', 'workspace']);
  const batch = parsed.positional[1];
  const query = parsed.positional[2];
  try {
    if (query === undefined || !String(query).trim()) {
      return {
        refusal: 'A search needs -Query. Run with -List to see the source batches you can name.',
        value: null,
      };
    }
    const maxResults = Number(parsed.options.get('max-results') ?? DEFAULT_MAX_RESULTS);
    return {
      refusal: null,
      value: findRawBatchLines({ workspace, batch, query, maxResults }) as PsJsonValue,
    };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
