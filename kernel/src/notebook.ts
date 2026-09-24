/**
 * The Notebook: its derived master index, who owns each topic, and the quarantine a reset moves
 * topics into.
 *
 * Step 24's Notebook group (S17). Ported from three PowerShell modules that are one subject:
 * `tools/NotebookIndex.ps1` (the renderer and its drift detector), `tools/NotebookOwnership.ps1`
 * (the ownership record, the reset's target selection and both ends of the quarantine) and the seat
 * registry reads in `tools/LibrarySeat.ps1` that selection classifies against. `reset.ts` and
 * `compile.ts` are its callers; `desk.ts` reads the quarantine inventory from here.
 *
 * THE MASTER INDEX IS DERIVED, NEVER WRITTEN. A renderer that snapshots {a}, is overtaken by one that
 * creates b and renders {a,b}, then writes its stale {a}, has lost a topic -- so the commit, the scan,
 * the write and the readback happen together under the render lock, and nothing else writes the file.
 *
 * THE LOCK ORDER IS ADR-0019's, AND THIS FILE IS WHERE IT LIVES:
 *
 *     registry/Desk -> Book (sorted) -> topic (sorted) -> render -> notebook-topic-owners
 *
 * A topic's ownership changes only while that topic's lock is held. The owners lock serialises one
 * small file's read-modify-write and is taken last, for microseconds.
 *
 * SORTING FOLLOWS `Sort-Object`, NOT ORDINAL, where the PowerShell arm sorts with it. `Sort-Object`
 * compares with the current culture, which weighs a hyphen below every letter and digit rather than
 * at its code point, so `house-style` and `houses` order differently there than under `<`. Every
 * ordering that reaches a file or a result goes through `psSortCompare`, so the two arms cannot
 * disagree about the order of the same slugs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock, isBookLockHeld, assertSeatRegistryLockHeld } from './locks.ts';
import { SLUG_PATTERN } from './shelfbook.ts';
import { getSeatClaimState, getSeatStateDecision } from './seatclaim.ts';
import { readSeatRegistry, readSeatRetirementRecords, type SeatRegistryEntry } from './desk.ts';
import { triageInventory } from './triageinventory.ts';
import { SEAT_INDEX_NAME, type NotebookScope } from './notebooklayout.ts';

export const NOTEBOOK_RENDER_LOCK_ROOT = 'render/notebook-master-index';
export const NOTEBOOK_OWNERS_LOCK_ROOT = 'internal/notebook-topic-owners';
const MASTER_HEADING = '# Notebook Index';
const EMPTY_PARAGRAPH = 'This Notebook is ready for a new topic. Add topic folders here as material is compiled.';
const OWNER_SCOPES = ['owned', 'shared', 'excluded'];
/** The files a quarantine directory owns, which are NOT restorable material. */
export const QUARANTINE_JOURNAL_NAMES = ['reset-journal.json', 'restore-journal.json'];

// --- Ordering and reading ---------------------------------------------------------------------------

import { psSortCompare } from './pssort.ts';
export { psSortCompare };

/** Strict UTF-8 with the BOM stripped rather than counted, as `[Text.UTF8Encoding]::new($false, $true)` reads. */
export function readStrictUtf8(file: string): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.substring(1) : text;
}

/** Every directory under `root`, refusing a reparse point rather than following it. */
function notebookDirectories(root: string, refusal: (name: string) => string): string[] {
  const names: string[] = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isSymbolicLink()) {
      let pointsAtDirectory = false;
      try {
        pointsAtDirectory = fs.statSync(full).isDirectory();
      } catch {
        pointsAtDirectory = false;
      }
      if (pointsAtDirectory) throw new Error(refusal(item.name));
      continue;
    }
    if (item.isDirectory()) names.push(item.name);
  }
  return names;
}

// --- The master index (tools/NotebookIndex.ps1) ---------------------------------------------------

/**
 * A topic's lock, named for the Notebook root that holds it. Under ADR-0029 that is
 * `notebook/<seat>/<topic>`: the same topic slug at two seats is two topics and two locks, and no seat
 * ever takes another's.
 */
export function notebookTopicLockRoot(topic: string, relative = 'notebook'): string {
  if (!topic.trim()) throw new Error('A Notebook topic lock needs a topic slug.');
  return `${relative}/${topic}`;
}

/** The render lock for one Notebook root: the per-Seat Notebook mutation lock ADR-0029 keeps. */
export function notebookRenderLockRoot(scope: NotebookScope): string {
  return scope.layout === 'legacy' ? NOTEBOOK_RENDER_LOCK_ROOT : `${NOTEBOOK_RENDER_LOCK_ROOT}/${scope.seat}`;
}

export function masterIndexPath(workspace: string): string {
  return path.join(workspace, 'notebook', '_master-index.md');
}

export function emptyMasterIndexText(): string {
  return `${MASTER_HEADING}\n\n${EMPTY_PARAGRAPH}\n`;
}

/**
 * The one column-zero H1 a topic index must carry, or a refusal naming what is wrong with it. Fenced
 * code is skipped: three or more backticks or tildes, indented up to three spaces, toggle the fence,
 * so a Markdown example inside a topic index is never counted as its heading.
 */
export function topicHeadingFromText(text: string, label = 'the topic index'): string {
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      const marker = fenceMark[1]!.substring(0, 1);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#[ \t]+(.+)$/.exec(line);
    if (heading) headings.push(heading[1]!);
  }
  if (headings.length === 0) throw new Error(`the topic index has no column-zero H1: ${label}`);
  if (headings.length > 1) {
    throw new Error(`the topic index carries ${headings.length} column-zero H1 headings and must carry exactly one: ${label}`);
  }
  const heading = headings[0]!.trim();
  if (!heading) throw new Error(`the topic index's H1 is empty: ${label}`);
  if (heading.includes('|') || heading.includes(']]')) {
    throw new Error(`the topic index's H1 cannot be rendered as a link label: ${label}`);
  }
  return heading;
}

export function topicHeading(indexPath: string): string {
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) throw new Error(`the topic index is missing: ${indexPath}`);
  return topicHeadingFromText(readStrictUtf8(indexPath), indexPath);
}

export interface TopicInventoryRow {
  slug: string;
  heading: string;
  index_path: string;
}

export function notebookTopicInventory(notebookRoot: string, relative = 'notebook'): TopicInventoryRow[] {
  if (!fs.existsSync(notebookRoot) || !fs.statSync(notebookRoot).isDirectory()) {
    throw new Error(`the Notebook directory is missing: ${notebookRoot}`);
  }
  const rows = notebookDirectories(
    notebookRoot,
    (name) => `${relative}/${name} is a reparse point; the Notebook index refuses to render material that lives outside the workspace.`,
  ).map((slug) => {
    const indexPath = path.join(notebookRoot, slug, '_index.md');
    return { slug, heading: topicHeading(indexPath), index_path: indexPath };
  });
  return rows.sort((left, right) => psSortCompare(left.slug, right.slug));
}

export function masterIndexText(notebookRoot: string, relative = 'notebook'): string {
  const topics = notebookTopicInventory(notebookRoot, relative);
  if (!topics.length) return emptyMasterIndexText();
  return `${MASTER_HEADING}\n\n` + topics.map((topic) => `- [[${topic.slug}/_index|${topic.heading}]]`).join('\n') + '\n';
}

/** What is wrong with the master index on disk, or an empty list. Read-only; takes no lock; never repairs. */
export function masterIndexDrift(workspace: string): string[] {
  return indexDrift(path.join(workspace, 'notebook'), 'notebook', 'tools/NotebookIndex.ps1 -Render -WorkspacePath .', false);
}

/**
 * The same question of one Notebook root. A seat root that does not exist YET is not drift: a seat that
 * has never written has no Notebook, and its first write creates the root and renders its index.
 */
export function scopeIndexDrift(scope: NotebookScope): string[] {
  if (scope.layout === 'legacy') return masterIndexDrift(scope.workspace);
  return indexDrift(scope.root, scope.relative, 'library notebook render', true);
}

function indexDrift(notebookRoot: string, relative: string, repair: string, absentIsEmpty: boolean): string[] {
  const masterPath = path.join(notebookRoot, SEAT_INDEX_NAME);
  if (!fs.existsSync(notebookRoot) || !fs.statSync(notebookRoot).isDirectory()) return absentIsEmpty ? [] : [`${relative}/ is missing`];
  if (!fs.existsSync(masterPath) || !fs.statSync(masterPath).isFile()) return [`${relative}/_master-index.md is missing`];
  let expected: string;
  try {
    expected = masterIndexText(notebookRoot, relative);
  } catch (error) {
    return [`a topic cannot be rendered: ${(error as Error).message}`];
  }
  const problems: string[] = [];
  const bytes = fs.readFileSync(masterPath);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${relative}/_master-index.md still carries a UTF-8 BOM; the renderer writes UTF-8 with no BOM`);
  }
  let actual = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (actual.length > 0 && actual.charCodeAt(0) === 0xfeff) actual = actual.substring(1);
  if (actual !== expected) {
    problems.push(`${relative}/_master-index.md does not match the topics on disk; re-render it with ${repair}`);
  }
  return problems;
}

export interface RenderResult<T> {
  master_index_path: string;
  topic_count: number;
  rendered: boolean;
  commit_result: T | null;
}

/**
 * THE CRITICAL SECTION. Commit a visibility or H1 change and re-render the root's index. Everything
 * expensive happens before this is called; the commit is the caller's final, cheap act of making its
 * change visible, and it runs INSIDE the lock because a commit outside it is the overtaking that
 * loses a topic. The scan fails BEFORE the write, so a degenerate topic leaves the previous index.
 *
 * ONE ROOT, ONE LOCK. Under ADR-0029 the lock is the seat's and the index is the seat's, so two seats
 * never contend here -- which is the per-Seat Notebook mutation lock the ADR keeps on review.
 */
export function invokeNotebookRender<T>(scope: NotebookScope, commit?: () => T, timeoutSeconds = 20): RenderResult<T> {
  const notebookRoot = scope.root;
  const masterPath = path.join(notebookRoot, SEAT_INDEX_NAME);
  const lock = enterBookLock(scope.workspace, notebookRenderLockRoot(scope), timeoutSeconds);
  try {
    const committed = commit ? commit() : null;
    if (!fs.existsSync(notebookRoot)) fs.mkdirSync(notebookRoot, { recursive: true });
    let text: string;
    try {
      text = masterIndexText(notebookRoot, scope.relative);
    } catch (error) {
      throw new Error(
        'The Notebook master index was NOT changed, because a topic on disk cannot be rendered: ' +
          `${(error as Error).message}. Every directory under ${scope.relative}/ must hold an _index.md carrying exactly ` +
          'one column-zero H1, because that heading is the label the index shows. Repair or remove that ' +
          'directory: until it is renderable, no Notebook write that changes which topics exist can ' +
          'complete, since the index would have to leave out a topic that is really there.',
      );
    }
    writeAtomicText(masterPath, text);
    if (readStrictUtf8(masterPath) !== text) throw new Error('The rendered Notebook master index failed readback verification.');
    return {
      master_index_path: `${scope.relative}/_master-index.md`,
      topic_count: (text.match(/^- \[\[/gm) ?? []).length,
      rendered: true,
      commit_result: committed,
    };
  } finally {
    exitBookLock(lock);
  }
}

/** Re-derive the index once a rollback has put the topics back, saying what landed if it cannot. */
export function invokeNotebookRenderAfterRollback(scope: NotebookScope): RenderResult<null> {
  try {
    return invokeNotebookRender<null>(scope);
  } catch (error) {
    throw new Error(
      `the journaled files were restored, but ${scope.relative}/_master-index.md could not be re-derived afterwards: ` +
        `${(error as Error).message} Run library notebook render once that is repaired; ` +
        'until then the index still describes the Notebook as it was before this run.',
    );
  }
}

// --- The ownership record (tools/NotebookOwnership.ps1) --------------------------------------------

export type OwnerRow = Record<string, PsJsonValue>;

export function notebookOwnersPath(workspace: string): string {
  return path.join(workspace, 'internal', 'notebook-topic-owners.json');
}

function has(row: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, name);
}

/**
 * The ownership record, or an empty one. FAILS CLOSED on anything it cannot parse, because empty is
 * the DANGEROUS reading: a reset would see no owners and conclude every topic was unmapped.
 */
export function readNotebookTopicOwners(workspace: string): { schema: number; topics: OwnerRow[] } {
  const file = notebookOwnersPath(workspace);
  if (!fs.existsSync(file)) return { schema: 1, topics: [] };
  let raw: string;
  try {
    raw = readStrictUtf8(file);
  } catch (error) {
    throw new Error(`The Notebook ownership record at ${file} could not be read: ${(error as Error).message}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`The Notebook ownership record at ${file} is not valid JSON: ${(error as Error).message}. Repair it before resetting anything.`);
  }
  if (!has(parsed, 'topics')) throw new Error(`The Notebook ownership record at ${file} has no 'topics' list.`);
  const topics = (Array.isArray(parsed['topics']) ? parsed['topics'] : parsed['topics'] === null ? [] : [parsed['topics']]) as OwnerRow[];
  for (const entry of topics) {
    for (const required of ['topic', 'scope']) {
      if (!has(entry, required)) throw new Error(`A topic entry in ${file} has no '${required}' field.`);
    }
    const topic = String(entry['topic']);
    const scope = String(entry['scope']);
    if (!SLUG_PATTERN.test(topic)) throw new Error(`The ownership record names a malformed topic '${topic}'.`);
    if (!OWNER_SCOPES.includes(scope)) {
      throw new Error(`Topic '${topic}' has scope '${scope}'; expected one of ${OWNER_SCOPES.join(', ')}.`);
    }
    if (scope === 'owned') {
      if (!has(entry, 'seat')) throw new Error(`Topic '${topic}' is owned and names no seat.`);
      if (!SLUG_PATTERN.test(String(entry['seat']))) throw new Error(`Topic '${topic}' names a malformed seat.`);
    }
    if (has(entry, 'seat_id')) {
      if (scope !== 'owned') throw new Error(`Topic '${topic}' is '${scope}' and carries a seat_id; only an owned topic names an incarnation.`);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(String(entry['seat_id']))) {
        throw new Error(
          `Topic '${topic}' names a malformed seat incarnation. Omit the field for a topic recorded before incarnations existed; never write it empty.`,
        );
      }
    }
  }
  const keys = topics.map((entry) => String(entry['topic']));
  if (new Set(keys).size !== keys.length) throw new Error(`The Notebook ownership record at ${file} names the same topic twice.`);
  return { schema: 1, topics };
}

/** Replace the record atomically. The caller MUST hold the owners lock. */
export function writeNotebookTopicOwners(workspace: string, topics: OwnerRow[]): void {
  const ordered = [...topics].sort((left, right) => psSortCompare(String(left['topic']), String(right['topic'])));
  writeAtomicText(notebookOwnersPath(workspace), psConvertToJson({ schema: 1, topics: ordered }) + '\n');
}

export function topicOwnerEntry(owners: { topics: OwnerRow[] }, topic: string): OwnerRow | null {
  return owners.topics.find((entry) => String(entry['topic']) === topic) ?? null;
}

function entryIncarnation(entry: OwnerRow | null): string {
  return entry !== null && has(entry, 'seat_id') ? String(entry['seat_id']) : '';
}

export function assertNotebookTopicLockHeld(workspace: string, topic: string, operation: string, relative = 'notebook'): void {
  if (isBookLockHeld(workspace, notebookTopicLockRoot(topic, relative))) return;
  throw new Error(
    `${operation} requires the lock for ${relative}/${topic}, and this process does not hold it. Take it with ` +
      `Enter-BookLock -Workspace <workspace> -BookRoot (Get-NotebookTopicLockRoot '${topic}') and hold it across ` +
      "the ownership check and the change it authorises. A topic's ownership read without it is a snapshot " +
      'another writer can invalidate before it is used.',
  );
}

/** Every topic directory on disk, sorted as `Sort-Object -CaseSensitive` sorts them. */
export function notebookTopicDirectories(workspace: string): string[] {
  const root = path.join(workspace, 'notebook');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return notebookDirectories(
    root,
    (name) => `notebook/${name} is a reparse point; ownership refuses to map material that lives outside the workspace.`,
  ).sort(psSortCompare);
}

export interface OwnershipRow {
  topic: string;
  scope: string;
  seat: string | null;
  seat_id: string;
  project: string | null;
}

/** Every topic on disk beside what the record says about it. `unmapped` is reported, never folded. */
export function notebookOwnershipInventory(workspace: string): OwnershipRow[] {
  const owners = readNotebookTopicOwners(workspace);
  return notebookTopicDirectories(workspace).map((topic) => {
    const entry = topicOwnerEntry(owners, topic);
    if (entry === null) return { topic, scope: 'unmapped', seat: null, seat_id: '', project: null };
    const scope = String(entry['scope']);
    return {
      topic,
      scope,
      seat: scope === 'owned' ? String(entry['seat']) : null,
      seat_id: scope === 'owned' ? entryIncarnation(entry) : '',
      project: scope === 'owned' && has(entry, 'project') && entry['project'] !== null ? String(entry['project']) : null,
    };
  });
}

// --- The seat registry, as the Notebook reads it (tools/LibrarySeat.ps1) ---------------------------

function seatRosterSentence(seats: string[]): string {
  return seats.length ? `Seats that exist: ${seats.join(', ')}.` : 'No seats exist yet.';
}

export function assertSeatRegistered(stateDirectory: string, seat: string): SeatRegistryEntry {
  const registry = readSeatRegistry(stateDirectory);
  const entry = registry.find((row) => row.seat === seat);
  if (!entry) {
    throw new Error(
      `There is no seat named '${seat}'. ${seatRosterSentence(registry.map((row) => row.seat))} ` +
        `Create one with tools/Start-LibrarySeat.ps1 -Seat ${seat} -Project <project-slug>.`,
    );
  }
  return entry;
}

/** `live`, `retired` or `unaccounted`, with live checked FIRST so a reused slug is never read off an archive. */
export function seatIncarnationStatus(
  registry: SeatRegistryEntry[],
  retirements: { seat: string; seat_id: string }[],
  seat: string,
  seatId: string,
): 'live' | 'retired' | 'unaccounted' {
  const entry = registry.find((row) => row.seat === seat);
  if (entry && entry.seatId === seatId) return 'live';
  if (retirements.some((record) => record.seat === seat && record.seat_id === seatId)) return 'retired';
  return 'unaccounted';
}

// --- Reproducibility evidence (ADR-0022, ADR-0025) --------------------------------------------------

/** Whether a completed publication journal names a Book of this topic's slug. EVIDENCE, never a verdict. */
export function topicJournalEvidence(workspace: string, topic: string): Record<string, PsJsonValue> {
  const root = path.join(workspace, 'internal', 'publication-journals');
  let complete = 0;
  let newest = '';
  let newestWhen = Number.NEGATIVE_INFINITY;
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    const pattern = new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-.*\\.json$`, 'i');
    for (const name of fs.readdirSync(root).filter((file) => pattern.test(file)).sort()) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(readStrictUtf8(path.join(root, name))) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (body === null || typeof body !== 'object') continue;
      if (!has(body, 'state') || !has(body, 'book_slug') || !has(body, 'timestamp_utc')) continue;
      if (String(body['state']) !== 'complete' || String(body['book_slug']) !== topic) continue;
      const when = Date.parse(String(body['timestamp_utc']));
      if (Number.isNaN(when)) continue;
      complete += 1;
      if (when > newestWhen) {
        newestWhen = when;
        newest = String(body['timestamp_utc']);
      }
    }
  }
  return {
    topic,
    complete_publication_journals: complete,
    newest_publication_utc: newest,
    note:
      complete > 0
        ? `a published Book of this slug has ${complete} completed publication journal(s), newest ${newest}. This topic's source can be rebuilt with tools/Restore-BookSource.ps1 -Book ${topic}, which needs that Book OPEN on the Desk, refuses to overwrite an existing notebook/${topic}, and aborts if any page fails its hash. Evidence that a route exists, not a promise that it will run.`
        : 'no completed publication journal names a Book of this slug, so nothing here can rebuild this topic if it is lost. Treat it as the only copy.',
  };
}

/** Whether every page of a topic is a proven copy of a published Book -- the look an `excluded` must survive. */
export function topicReproducibility(workspace: string, topic: string): Record<string, PsJsonValue> {
  const journals = topicJournalEvidence(workspace, topic);
  let row: Record<string, PsJsonValue> | null = null;
  let inventoryError = '';
  try {
    const inventory = triageInventory(workspace);
    const topics = (Array.isArray(inventory['topics']) ? inventory['topics'] : []) as Record<string, PsJsonValue>[];
    row = topics.find((candidate) => String(candidate['topic']) === topic) ?? null;
  } catch (error) {
    inventoryError = (error as Error).message;
  }
  const measured = row !== null;
  const pageCount = measured ? Number(row!['page_count']) : 0;
  const drifted = measured ? Number(row!['known_copy_drifted_count']) : 0;
  const unproven = measured ? Number(row!['pages_without_current_copy']) : 0;
  const completeJournals = Number(journals['complete_publication_journals']);
  const reproducible = completeJournals > 0 && measured && pageCount > 0 && unproven === 0;
  let note: string;
  if (reproducible) {
    note = `all ${pageCount} page(s) of notebook/${topic} are hash-bound current copies of a published Book, named by ${completeJournals} completed publication journal(s), newest ${String(journals['newest_publication_utc'])}. Nothing in this topic would be lost that tools/Restore-BookSource.ps1 -Book ${topic} could not rebuild.`;
  } else if (!measured) {
    const because = inventoryError ? `the Notebook inventory could not be read: ${inventoryError}` : 'no page of it was found on disk';
    note = `notebook/${topic}'s pages could not be measured, because ${because}. Nothing here says whether it is reproducible, and an unmeasured topic is not a proven one.`;
  } else if (completeJournals <= 0) {
    note = `no completed publication journal names a Book of this slug, so nothing here can rebuild notebook/${topic} if it is lost. Treat it as the only copy.`;
  } else {
    note = `${unproven} of notebook/${topic}'s ${pageCount} page(s) have no hash-bound current copy in a published Book, ${drifted} of them drifted -- holding a version the Book does not. A rebuild from the Book would lose that, so this topic holds more than it can get back.`;
  }
  return {
    topic,
    complete_publication_journals: completeJournals,
    newest_publication_utc: String(journals['newest_publication_utc']),
    pages_measured: measured,
    page_count: pageCount,
    known_copy_drifted_count: drifted,
    pages_without_current_copy: unproven,
    provably_reproducible: reproducible,
    inventory_error: inventoryError,
    note,
  };
}

function assertExclusionEarned(workspace: string, topic: string, acceptReproducible: boolean): void {
  const evidence = topicReproducibility(workspace, topic);
  if (evidence['provably_reproducible'] === true && !acceptReproducible) {
    throw new Error(
      `notebook/${topic} may not be declared -Scope excluded: it is provably reproducible (ADR-0025). ` +
        String(evidence['note']) +
        " An excluded topic sits outside every seat's reset at every scope, so this " +
        'declaration would make a rebuildable topic unreachable -- which is the 2026-09-15 episode ADR-0025 ' +
        'records, and a judgement two sessions have already got wrong. Let a reset clear it and rebuild with ' +
        `tools/Restore-BookSource.ps1 -Book ${topic}, which needs that Book open on the Desk. If this topic must ` +
        'be excluded regardless, pass -AcceptReproducible and the record is written with that choice reported.',
    );
  }
}

// --- The writers' gate ------------------------------------------------------------------------------

/**
 * May this seat write into this topic? A read: no lock, no throw, so a PREFLIGHT can report it.
 * Owned by this seat, shared, excluded and unmapped are all writable; only another seat's owned topic
 * is not, because that seat's ordinary reset would quarantine this material as its own. It compares
 * the SLUG, not the incarnation: two incarnations of one slug are never both live.
 */
export function testNotebookTopicWritable(workspace: string, topic: string, seat: string): { writable: boolean; reason: string | null } {
  const entry = topicOwnerEntry(readNotebookTopicOwners(workspace), topic);
  if (entry === null) return { writable: true, reason: null };
  const scope = String(entry['scope']);
  const owner = scope === 'owned' ? String(entry['seat']) : null;
  const project = scope === 'owned' && has(entry, 'project') && entry['project'] !== null ? String(entry['project']) : null;
  if (scope !== 'owned' || owner === seat) return { writable: true, reason: null };
  const projectNote = project && project.trim() ? ` for project '${project}'` : '';
  return {
    writable: false,
    reason:
      `notebook/${topic} is owned by seat '${owner}'${projectNote}, and seat '${seat}' may not write into it: that seat's ` +
      `ordinary reset would quarantine this material as its own. Work at seat '${owner}' instead; or, if that seat ` +
      `is dormant, reassign the topic with tools/Set-NotebookTopicOwner.ps1 -Topic ${topic} -Seat ${seat}; or declare ` +
      'it shared with -Scope shared if it is genuinely common ground.',
  };
}

/** The writers' gate under the topic's own lock, so the answer cannot change under the write it authorises. */
export function assertNotebookTopicWritable(workspace: string, topic: string, seat: string): void {
  assertNotebookTopicLockHeld(workspace, topic, 'Writing into a Notebook topic');
  const verdict = testNotebookTopicWritable(workspace, topic, seat);
  if (!verdict.writable) throw new Error(verdict.reason!);
}

// --- The ownership writer ---------------------------------------------------------------------------

/**
 * Record or reassign who owns a topic: the only route by which a topic changes hands. The TOPIC lock
 * first, then the owners lock -- each taken only if this process does not already hold it, DETECTED
 * rather than declared. Reassignment away from another LIVE seat is refused unless the acting seat
 * IS the current owner; a dormant owner's topic may be taken, which is the reset's recovery route.
 */
export function setNotebookTopicOwner(options: {
  workspace: string;
  topic: string;
  seat: string | null;
  actingSeat: string | null;
  project?: string | null;
  scope: 'owned' | 'shared' | 'excluded';
  acceptReproducible?: boolean;
}): void {
  const { workspace, topic, scope } = options;
  if (!SLUG_PATTERN.test(topic)) throw new Error(`Topic '${topic}' is malformed: lowercase letters, digits and hyphens only.`);
  if (scope === 'excluded') assertExclusionEarned(workspace, topic, options.acceptReproducible === true);
  const stateDirectory = path.join(workspace, '.claude');
  let seat = options.seat ?? '';
  let project = options.project ?? '';
  let seatId = '';
  if (scope === 'owned') {
    if (!seat) throw new Error('An owned topic names a seat.');
    const entry = readSeatRegistry(stateDirectory).find((row) => row.seat === seat) ?? null;
    seatId = entry?.seatId ?? '';
    if (!project && entry) project = entry.project;
  }

  const topicLock = isBookLockHeld(workspace, notebookTopicLockRoot(topic)) ? null : enterBookLock(workspace, notebookTopicLockRoot(topic));
  try {
    assertNotebookTopicLockHeld(workspace, topic, "Recording a Notebook topic's owner");
    const previous = topicOwnerEntry(readNotebookTopicOwners(workspace), topic);
    if (previous !== null && String(previous['scope']) === 'owned' && String(previous['seat']) !== seat) {
      const owner = String(previous['seat']);
      if (owner !== (options.actingSeat ?? '')) {
        const ownerState = getSeatClaimState(stateDirectory, owner).state;
        if (ownerState !== 'free') {
          const because = ownerState === 'held' ? 'has a live session' : 'has a live agent process whose claim holder was lost';
          throw new Error(
            `notebook/${topic} is owned by seat '${owner}', which ${because}, so it may not be reassigned. Its reset ` +
              'would otherwise stop covering material it is still writing. Wait for that session to end, or make ' +
              'the change from that seat.',
          );
        }
      }
    }
    const ownersLock = isBookLockHeld(workspace, NOTEBOOK_OWNERS_LOCK_ROOT) ? null : enterBookLock(workspace, NOTEBOOK_OWNERS_LOCK_ROOT);
    try {
      const owners = readNotebookTopicOwners(workspace);
      const kept = owners.topics.filter((entry) => String(entry['topic']) !== topic);
      const entry: OwnerRow = { topic, scope, recorded_utc: new Date().toISOString().replace('Z', '0000Z') };
      if (scope === 'owned') {
        entry['seat'] = seat;
        entry['project'] = project || null;
        // OMITTED WHEN THE SEAT HAS NO INCARNATION, never written empty: absence is the one spelling
        // of "recorded before ids existed", and the reader refuses the other one.
        if (seatId) entry['seat_id'] = seatId;
      }
      writeNotebookTopicOwners(workspace, [...kept, entry]);
    } finally {
      exitBookLock(ownersLock);
    }
  } finally {
    exitBookLock(topicLock);
  }
}

// --- Reset target selection -------------------------------------------------------------------------

interface SweepAnswer {
  topic: string;
  seat: string;
  seat_id: string;
  incarnation_status: string;
  claim_state: string;
  decision: string;
  reason: string;
  note: string;
}

function sweepDisposition(
  stateDirectory: string,
  registry: SeatRegistryEntry[],
  retirements: { seat: string; seat_id: string }[],
  seat: string,
  seatId: string,
  actingSeat: string,
  actingSeatId: string,
): Omit<SweepAnswer, 'topic'> {
  if (seat === actingSeat && seatId === actingSeatId) {
    return {
      seat, seat_id: seatId, incarnation_status: 'acting', claim_state: 'not-probed', decision: 'allow', reason: 'acting-seat',
      note: "notebook/<topic> belongs to this seat's own incarnation; a reset takes it on the claim this session holds, not because any seat is idle.",
    };
  }
  const status = seatIncarnationStatus(registry, retirements, seat, seatId);
  if (status !== 'live') {
    const which = seatId.trim() ? `incarnation ${seatId}` : 'the pre-identity incarnation';
    if (status === 'retired') {
      return {
        seat, seat_id: seatId, incarnation_status: status, claim_state: 'not-probed', decision: 'skip', reason: 'retired-incarnation',
        note: `seat '${seat}' (${which}) is retired, so its topics belong to a whole-tree reset rather than to a sweep (ADR-0016). Include them with -WholeTree.`,
      };
    }
    return {
      seat, seat_id: seatId, incarnation_status: status, claim_state: 'not-probed', decision: 'skip', reason: 'unaccounted-incarnation',
      note:
        `no registry entry and no retirement record name ${which} of seat '${seat}', so nothing can say the work there is finished -- ` +
        'and a seat directory deleted by hand is not a retirement. Take the topic over with tools/Set-NotebookTopicOwner.ps1, declare it shared, or recreate the seat and retire it properly.',
    };
  }
  const state = getSeatClaimState(stateDirectory, seat).state;
  const decision = getSeatStateDecision('sweep', state, false);
  if (decision !== 'allow' && decision !== 'skip') {
    throw new Error(
      `The seat-state matrix answers '${decision}' for a sweep of a ${state} seat, and a sweep can only allow or skip. A sweep that refuses would abort over one busy seat; correct the sweep rows in Get-SeatStateMatrix.`,
    );
  }
  let reason = 'idle';
  let note = `seat '${seat}' is idle, so its Notebook topics may be set aside; the quarantine journal records that they were its.`;
  if (state === 'held') {
    reason = 'live-session';
    note = `seat '${seat}' has a live session, so its Notebook topics are left alone. Wait for that session to end.`;
  } else if (state === 'orphaned') {
    reason = 'lost-holder';
    note = `seat '${seat}' has a live agent process whose claim holder was lost, so its Notebook topics are left alone. Wait for it to end, or re-bind and close it from that conversation.`;
  }
  return { seat, seat_id: seatId, incarnation_status: status, claim_state: state, decision, reason, note };
}

export interface ResetSelection {
  seat: string;
  seat_id: string;
  whole_tree: boolean;
  all_idle_seats: boolean;
  targets: OwnershipRow[];
  protected: OwnershipRow[];
  foreign: OwnershipRow[];
  retired: OwnershipRow[];
  unaccounted: OwnershipRow[];
  unmapped: OwnershipRow[];
  swept: SweepAnswer[];
  skipped: SweepAnswer[];
  sweep_probes: number;
  sweep_seats: number;
  refusals: string[];
}

/**
 * Which topics a reset at this seat may move, and why every other one is out. The caller MUST hold
 * the registry lock: deciding which incarnations are retired is a cross-seat read, and a seat created
 * or retired under the scan changes the answer.
 */
export function notebookResetTargets(options: { workspace: string; seat: string; wholeTree: boolean; allIdleSeats: boolean }): ResetSelection {
  const { workspace, seat, wholeTree, allIdleSeats } = options;
  if (wholeTree && allIdleSeats) {
    throw new Error(
      'A whole-tree reset and an idle-seat sweep are two different authorisations and cannot be ' +
        'combined: -WholeTree covers this seat plus explicitly RETIRED ones (ADR-0016), and ' +
        '-AllIdleSeats covers seats that are merely idle now (ADR-0023). Run the sweep first and ' +
        'the whole-tree reset after, each with its own preflight and its own approval.',
    );
  }
  assertSeatRegistryLockHeld(workspace, "Selecting a reset's targets");
  const stateDirectory = path.join(workspace, '.claude');
  const registry = readSeatRegistry(stateDirectory);
  const actingIncarnation = assertSeatRegistered(stateDirectory, seat).seatId;
  const retirements = readSeatRetirementRecords(workspace).records;
  const selection: ResetSelection = {
    seat, seat_id: actingIncarnation, whole_tree: wholeTree, all_idle_seats: allIdleSeats,
    targets: [], protected: [], foreign: [], retired: [], unaccounted: [], unmapped: [],
    swept: [], skipped: [], sweep_probes: 0, sweep_seats: 0, refusals: [],
  };
  for (const row of notebookOwnershipInventory(workspace)) {
    if (row.scope === 'unmapped') { selection.unmapped.push(row); continue; }
    if (row.scope === 'shared' || row.scope === 'excluded') { selection.protected.push(row); continue; }
    if (row.scope !== 'owned') continue;
    if (row.seat === seat && row.seat_id === actingIncarnation) { selection.targets.push(row); continue; }
    const status = seatIncarnationStatus(registry, retirements, row.seat ?? '', row.seat_id);
    if (status === 'live') selection.foreign.push(row);
    else if (status === 'retired') {
      selection.retired.push(row);
      if (wholeTree) selection.targets.push(row);
    } else selection.unaccounted.push(row);
  }

  if (allIdleSeats) {
    const memo = new Map<string, Omit<SweepAnswer, 'topic'>>();
    for (const row of selection.foreign) {
      const key = `${row.seat ?? ''}\n${row.seat_id}`;
      if (!memo.has(key)) {
        selection.sweep_probes += 1;
        memo.set(key, sweepDisposition(stateDirectory, registry, retirements, row.seat ?? '', row.seat_id, seat, actingIncarnation));
      }
      const answer = { topic: row.topic, ...memo.get(key)! };
      if (answer.decision === 'allow') {
        selection.targets.push(row);
        selection.swept.push(answer);
      } else selection.skipped.push(answer);
    }
    selection.sweep_seats = memo.size;
  }

  if (selection.unmapped.length) {
    selection.refusals.push(
      `these Notebook topics are owned by no seat: ${selection.unmapped.map((row) => row.topic).join(', ')}. ` +
        'Map each one with tools/Set-NotebookTopicOwner, or declare it shared or excluded. A reset will not ' +
        'guess at material nobody has claimed.',
    );
  }
  if (wholeTree && selection.foreign.length) {
    const detail = selection.foreign
      .map((row) => {
        const state = getSeatClaimState(stateDirectory, row.seat ?? '').state;
        const remedy =
          state === 'held'
            ? 'wait for that session to end'
            : state === 'orphaned'
              ? "that seat's agent is still running with its claim holder lost; wait for it to end, or re-bind and close it from that conversation"
              : `retire it with tools/Retire-Seat.ps1 -Seat ${row.seat}`;
        return `${row.topic} (seat ${row.seat}: ${remedy})`;
      })
      .join('; ');
    selection.refusals.push(`a whole-tree reset will not touch another seat's material: ${detail}`);
  }
  if (wholeTree && selection.unaccounted.length) {
    const detail = selection.unaccounted
      .map((row) => `${row.topic} (seat ${row.seat}, ${row.seat_id.trim() ? `incarnation ${row.seat_id}` : 'the pre-identity incarnation'})`)
      .join('; ');
    selection.refusals.push(
      `a whole-tree reset will not touch material whose owning seat cannot be accounted for: ${detail}. ` +
        'No registry entry names those incarnations and internal/seat-archive/ holds no retirement record for them, so ' +
        'nothing can say the work there is finished -- and a seat directory deleted by hand is not a retirement. Take the ' +
        `topic over with tools/Set-NotebookTopicOwner.ps1 -Topic <topic> -Seat ${seat}, declare it with -Scope shared ` +
        'if it is common ground, or recreate the seat and retire it properly.',
    );
  }
  return selection;
}

// --- The quarantine: both ends of the move -----------------------------------------------------------

export function notebookQuarantineRoot(workspace: string, create = false): string {
  const directory = path.join(workspace, 'internal', 'notebook-reset-quarantine');
  if (create) fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * Atomically rename one topic of a seat's Notebook into the quarantine, under the topic lock the caller
 * holds. There is no owner to revalidate: under ADR-0029 a topic in a seat's root is that seat's by
 * where it lives, so the only change a move can meet is the topic having gone.
 */
export function moveTopicToQuarantine(options: { scope: NotebookScope; topic: string; quarantineDirectory: string }): Record<string, PsJsonValue> {
  const { scope, topic } = options;
  assertNotebookTopicLockHeld(scope.workspace, topic, 'Quarantining a Notebook topic', scope.relative);
  const source = path.join(scope.root, topic);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return { topic, moved: false, reason: 'absent' };
  const destination = path.join(options.quarantineDirectory, topic);
  fs.renameSync(source, destination);
  return { topic, moved: true, source: `${scope.relative}/${topic}`, destination };
}

/** Rename one quarantined topic back into a seat's Notebook. NEVER overwrites: a name that exists again is newer work. */
export function restoreTopicFromQuarantine(options: { scope: NotebookScope; topic: string; quarantineDirectory: string }): Record<string, PsJsonValue> {
  const { scope, topic } = options;
  assertNotebookTopicLockHeld(scope.workspace, topic, 'Restoring a Notebook topic from quarantine', scope.relative);
  const source = path.join(options.quarantineDirectory, topic);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return { topic, restored: false, reason: 'absent from the quarantine' };
  const destination = path.join(scope.root, topic);
  if (fs.existsSync(destination)) {
    return {
      topic,
      restored: false,
      reason: `a topic of that name exists in ${scope.relative}/ again; the quarantined copy was left where it is rather than written over newer material`,
    };
  }
  fs.mkdirSync(scope.root, { recursive: true });
  fs.renameSync(source, destination);
  return { topic, restored: true, source, destination: `${scope.relative}/${topic}` };
}

function readQuarantineJournal(directory: string): { status: string; journal: Record<string, unknown> | null; reason: string } {
  const file = path.join(directory, 'reset-journal.json');
  if (!fs.existsSync(file)) {
    return {
      status: 'missing',
      journal: null,
      reason: 'this quarantine carries no reset-journal.json, so nothing records which seat made it or who owned each topic',
    };
  }
  try {
    return { status: 'read', journal: JSON.parse(readStrictUtf8(file)) as Record<string, unknown>, reason: '' };
  } catch (error) {
    return { status: 'unreadable', journal: null, reason: `reset-journal.json could not be read: ${(error as Error).message}` };
  }
}

/** Round-trip `o` spelling of a UTC instant, with .NET's seven fractional digits. */
function roundTripUtc(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

/**
 * When a quarantine was made: from its journal if it has one, from its own `<seat>-yyyyMMdd-HHmmss`
 * name if not, and which of the two answered. It never fills the journal's own field in.
 */
export function quarantineStamp(name: string, journalUtc: string): { stamped_utc: string; stamp_source: string; age_days: number | null } {
  let stamped = Number.NaN;
  let source = 'unknown';
  if (journalUtc.trim()) {
    const parsed = Date.parse(journalUtc);
    if (!Number.isNaN(parsed)) {
      stamped = parsed;
      source = 'journal';
    }
  }
  if (source === 'unknown') {
    const match = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
    if (match) {
      const parsed = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
      if (!Number.isNaN(parsed)) {
        stamped = parsed;
        source = 'directory-name';
      }
    }
  }
  if (source === 'unknown') return { stamped_utc: '', stamp_source: source, age_days: null };
  // [math]::Round(x, 1) -- banker's rounding, which only differs from half-up on an exact .x5.
  return { stamped_utc: roundTripUtc(stamped), stamp_source: source, age_days: Math.round(((Date.now() - stamped) / 86400000) * 10) / 10 };
}

export interface QuarantineRow {
  name: string;
  directory: string;
  seat: string;
  quarantined_utc: string;
  stamped_utc: string;
  stamp_source: string;
  age_days: number | null;
  whole_tree: boolean;
  all_idle_seats: boolean;
  journal_status: string;
  journal_reason: string;
  recorded_owners: { topic: string; seat: string; seat_id: string }[];
  topics: string[];
  loose_files: string[];
}

function childNames(directory: string, kind: 'directory' | 'file'): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((item) => (kind === 'directory' ? item.isDirectory() : item.isFile()))
    .map((item) => item.name);
}

/** Every quarantine directory with what it actually holds. WHAT IS ON DISK IS THE INVENTORY; the journal only explains it. */
export function notebookQuarantineInventory(workspace: string, only = ''): QuarantineRow[] {
  const root = notebookQuarantineRoot(workspace);
  if (!fs.existsSync(root)) return [];
  const rows: QuarantineRow[] = [];
  for (const name of childNames(root, 'directory').sort(psSortCompare)) {
    if (only && name !== only) continue;
    const directory = path.join(root, name);
    const read = readQuarantineJournal(directory);
    let seat = '';
    let stamped = '';
    let wholeTree = false;
    let allIdleSeats = false;
    const recorded: { topic: string; seat: string; seat_id: string }[] = [];
    if (read.status === 'read' && read.journal !== null) {
      const journal = read.journal;
      if (has(journal, 'seat')) seat = String(journal['seat']);
      if (has(journal, 'quarantined_utc')) stamped = String(journal['quarantined_utc']);
      if (has(journal, 'whole_tree')) wholeTree = journal['whole_tree'] === true;
      if (has(journal, 'all_idle_seats')) allIdleSeats = journal['all_idle_seats'] === true;
      if (has(journal, 'targets')) {
        const targets = Array.isArray(journal['targets']) ? journal['targets'] : [journal['targets']];
        for (const row of targets as Record<string, unknown>[]) {
          if (row === null || typeof row !== 'object' || !has(row, 'topic')) continue;
          recorded.push({
            topic: String(row['topic']),
            seat: has(row, 'seat') ? String(row['seat']) : '',
            seat_id: has(row, 'seat_id') ? String(row['seat_id']) : '',
          });
        }
      }
    }
    const stamp = quarantineStamp(name, stamped);
    rows.push({
      name,
      directory,
      seat,
      quarantined_utc: stamped,
      stamped_utc: stamp.stamped_utc,
      stamp_source: stamp.stamp_source,
      age_days: stamp.age_days,
      whole_tree: wholeTree,
      all_idle_seats: allIdleSeats,
      journal_status: read.status,
      journal_reason: read.reason,
      recorded_owners: recorded,
      topics: childNames(directory, 'directory').sort(psSortCompare),
      loose_files: childNames(directory, 'file').filter((file) => !QUARANTINE_JOURNAL_NAMES.includes(file)).sort(psSortCompare),
    });
  }
  return rows;
}

/** One row per topic in a quarantine directory, naming the articles it holds. `_index.md` is not an article. */
export function quarantineTopicArticles(directory: string): { topic: string; article_count: number; file_count: number; articles: string[] }[] {
  return childNames(directory, 'directory')
    .sort(psSortCompare)
    .map((topic) => {
      const topicRoot = path.join(directory, topic);
      const files: string[] = [];
      const walk = (current: string): void => {
        for (const item of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.isFile()) files.push(full);
        }
      };
      walk(topicRoot);
      const articles = files
        .filter((file) => path.extname(file).toLowerCase() === '.md' && path.basename(file) !== '_index.md')
        .map((file) => file.substring(topicRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
        .sort(psSortCompare);
      return { topic, article_count: articles.length, file_count: files.length, articles };
    });
}
