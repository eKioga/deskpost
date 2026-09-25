/**
 * The Desk: what is open, at this seat -- and the writes that open and close it.
 *
 * Step 24's fourth port-order group (S14). Two surfaces live here because they are two halves of one
 * subject: `tools/Get-DeskOverview.ps1` reads it and `tools/Set-VirtualDesk.ps1` writes it.
 *
 * THE COSMETIC TIER IS A RULING, NOT A PREFERENCE. This seat is reported in full; every OTHER seat
 * is counts and liveness and nothing else. Another seat's open Books are its business, and listing
 * them here would put material on this reader's Desk that they did not open.
 *
 * EVERY DESK MUTATION IS SERIALIZED, AND IT WAS NOT ALWAYS. The writer took no lock at all, so a
 * cross-seat sweep -- rename, archive, remove -- could scan the Desks while this one was rewriting
 * its own: check-then-act across two processes. The registry lock is the FIRST class in the total
 * order, so taking it here is always safe.
 *
 * AND A DESK WRITE IS NOT AN ENTRY. Opening a Book starts no conversation and displaces none, so the
 * activity record keeps the one it already had; clearing there erased the only record of which
 * conversation was sitting at a launcher-started seat, which has no binding to fall back on.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { exitBookLock, enterSeatRegistryLock, type BookLock } from './locks.ts';
import { getShelfBook, readUtf8, shelfCatalogPath, shelfCatalogSections, SLUG_PATTERN } from './shelfbook.ts';
import { shelfNotes } from './manifest.ts';
import {
  deskFileEntries,
  deskFilePath,
  deskStateDirectory,
  readDeskFileLines,
  resolveSeatName,
  seatDirectoryNames,
  type DeskKind,
} from './seatdesk.ts';
import {
  assertNoMaintenanceBarrier,
  assertSeatClaimHeld,
  getSeatClaimState,
  readSeatActivity,
  readSeatBinding,
  writeSeatActivity,
} from './seatclaim.ts';
import { writeAtomicText } from './fsx.ts';
import { notebookQuarantineInventory } from './notebook.ts';
import { homeDirectory, readMarker } from './workspace.ts';
import { openCollection } from './collection.ts';
import { readNotebookLayout, seatNotebookRelative } from './notebooklayout.ts';

/** The schema version `Write-LibraryResult -Json` stamps on every helper document. */
const LIBRARY_OUTPUT_SCHEMA = 1;

const BOOK_ROOT_PATTERN = /^(shelf\/_archive|books|archive|shelf)\/([a-z0-9][a-z0-9-]*)$/;
const BOOK_ROOT_ACCEPT_PATTERN = /^(?:(?:shelf\/_archive|books|archive|shelf)\/)?[a-z0-9][a-z0-9-]*$/;
const PROJECT_ROOT_PATTERN = /^(projects|archive\/projects)\/[a-z0-9][a-z0-9-]*$/;

export interface DeskOptions {
  workspace: string;
  seat?: string | undefined;
}

export class DeskRefusal extends Error {}

function refuse(message: string): never {
  throw new DeskRefusal(message);
}

interface BookRootParts {
  root: string;
  collection: 'shelf' | 'shared';
  shelf: 'active' | 'archive';
  slug: string;
  wikiRoot: string;
}

/**
 * One Book root taken apart. `collection` decides HOW a page is fetched -- shared over MCP, shelf
 * from disk -- and `shelf` is which half of the shared collection it is in. Keeping them separate
 * matters: an archived Book is still shared, and a reader that branched on a single field would have
 * to re-derive one of the two.
 */
export function splitBookRoot(root: string): BookRootParts {
  const match = BOOK_ROOT_PATTERN.exec(root);
  if (!match) refuse('Virtual Desk open-book state is malformed.');
  const prefix = match[1]!;
  const slug = match[2]!;
  return {
    root,
    collection: prefix === 'shelf' || prefix === 'shelf/_archive' ? 'shelf' : 'shared',
    shelf: prefix === 'archive' || prefix === 'shelf/_archive' ? 'archive' : 'active',
    slug,
    // The value a caller must never re-derive: the archive's `archive/<slug>` shape is the one place
    // it differs from what a reader would guess.
    wikiRoot: `${prefix}/${slug}/wiki`,
  };
}

/**
 * A bare slug is the pre-symmetry spelling of a SHARED Book: `ConvertTo-BookRoot` answers
 * `books/<slug>`, and `Get-DeskOverview.ps1` and `Set-VirtualDesk.ps1` both read their Desk through
 * it. Until S31 this answered `shelf/<slug>` -- the one copy of the rule in the kernel that disagreed
 * with `reader.ts` and `fulltext.ts`, so a bare `demo` line was reported open on the Shelf while the
 * reader served it from the shared collection. No row had a bare-slug Desk line to show it.
 */
function convertToBookRoot(entry: string): string {
  return entry.includes('/') ? entry : `books/${entry}`;
}

function readStateLines(file: string, pattern: RegExp, label: string, optional = false): string[] {
  if (!fs.existsSync(file)) {
    if (optional) return [];
    refuse(`Virtual Desk configuration is missing ${label}.`);
  }
  const items = deskFileEntries(file);
  for (const item of items) {
    if (!pattern.test(item)) refuse(`Virtual Desk ${label} state is malformed.`);
  }
  if (new Set(items).size !== items.length) refuse(`Virtual Desk ${label} state contains duplicates.`);
  return items;
}

// --- the overview ---------------------------------------------------------------------------------

export function deskOverview(options: DeskOptions): Record<string, PsJsonValue> {
  const workspace = options.workspace;
  const stateDirectory = path.join(workspace, '.claude');
  const resolved = resolveSeatName({ seat: options.seat, stateDirectory });
  if (resolved.status !== 'named') {
    // THE REMEDY THAT REFUSAL NAMES IS THIS COMMAND. The resolver's message ends "List the seats with
    // tools/Get-DeskOverview.ps1", and running it produced that same sentence back -- the reader was
    // sent to the helper that had just refused them. It is still a refusal: no Desk is rendered and
    // the exit code stays non-zero, because the reader asked for their Desk and did not get one.
    // What it now carries is the roster it sent them for.
    refuse(addSeatRosterToRefusal(resolved.message, workspace, stateDirectory));
  }
  const seat = resolved.seat!;

  const deskDirectory = deskStateDirectory(stateDirectory, seat);
  if (!fs.existsSync(deskDirectory)) {
    refuse(
      `Seat '${seat}' has no Desk in this workspace. Create it with ` +
        `tools/Start-LibrarySeat.ps1 -Seat ${seat} -Project <project-slug>.`,
    );
  }
  const sharedNotebook = path.join(workspace, 'notebook');
  if (!fs.existsSync(sharedNotebook)) refuse(`Notebook directory not found: ${sharedNotebook}`);
  // WHICH NOTEBOOK IS THIS SEAT'S (ADR-0029). A legacy or fresh workspace still has the shared tree
  // on disk, and the overview describes it as it is; any other shows the seat's own root.
  const layout = readNotebookLayout(workspace);
  const seatOwned = layout.state === 'seat-owned' || layout.state === 'migrating';
  const notebookRelative = seatOwned ? seatNotebookRelative(seat) : 'notebook';
  const notebookRoot = seatOwned ? path.join(workspace, ...notebookRelative.split('/')) : sharedNotebook;

  const openBookRoots = readStateLines(
    deskFilePath(stateDirectory, seat, 'books'),
    BOOK_ROOT_ACCEPT_PATTERN,
    'open-book',
  ).map(convertToBookRoot);
  if (new Set(openBookRoots).size !== openBookRoots.length) refuse('Virtual Desk open-book state contains duplicates.');
  const openBooks = openBookRoots.map((root) => {
    const parts = splitBookRoot(root);
    return { slug: parts.slug, location: parts.collection, shelf: parts.shelf, root: parts.root };
  });
  const openProjects = readStateLines(
    deskFilePath(stateDirectory, seat, 'projects'),
    PROJECT_ROOT_PATTERN,
    'open-project',
    true,
  );

  const topicOwners = seatOwned ? new Map<string, Record<string, unknown>>() : readNotebookTopicOwners(workspace);
  const topics: PsJsonValue[] = [];
  let topicArticleCount = 0;
  for (const directory of listDirectories(notebookRoot)) {
    const full = path.join(notebookRoot, directory);
    const articleCount = countMarkdownArticles(full);
    topicArticleCount += articleCount;
    // UNDER ADR-0029 A TOPIC IN THIS SEAT'S ROOT IS THIS SEAT'S, by where it lives.
    const ownerRow = seatOwned ? { scope: 'owned', seat } : topicOwners.get(directory);
    // THE THREE SCOPES AND THE ABSENCE ARE FOUR DIFFERENT ANSWERS, kept apart rather than folded
    // into "not yours". `unmapped` is the one that matters most to act on -- it is what stops a
    // reset outright -- so it is never rendered as though some seat owned it.
    const ownerScope = ownerRow === undefined ? 'unmapped' : String(ownerRow['scope']);
    const ownerSeat = ownerScope === 'owned' ? String(ownerRow!['seat']) : null;
    topics.push({
      folder: directory,
      index_path: `${notebookRelative}/${directory}/_index.md`,
      article_count: articleCount,
      overview: indexOverview(path.join(full, '_index.md')),
      owner_scope: ownerScope,
      owner_seat: ownerSeat,
      // DERIVED FROM THE TWO FIELDS ABOVE so it can never disagree with them, and phrased for a
      // reader rather than as a scope name.
      owner_label:
        ownerScope !== 'owned' ? ownerScope : ownerSeat === seat ? `yours (${ownerSeat})` : `seat ${ownerSeat}`,
    });
  }
  const standaloneArticleCount = (fs.existsSync(notebookRoot) ? fs.readdirSync(notebookRoot, { withFileTypes: true }) : [])
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md') && item.name !== '_master-index.md')
    .length;

  // THE INVENTORY THE RESET AND THE RESTORE READ, not a second one. Until S17 this file carried its
  // own, and it read `_reset.json` where the reset writes `reset-journal.json`, took its date from a
  // `yyyy-MM-dd` in a directory named `<seat>-yyyyMMdd-HHmmss`, and spelled the fallback source
  // `name` where PowerShell spells it `directory-name` -- three defects no row could see, because
  // no Desk row runs over a fixture holding a quarantine.
  const quarantineRows = notebookQuarantineInventory(workspace);
  const dated = quarantineRows.filter((row) => row.stamp_source !== 'unknown').sort((left, right) =>
    left.stamped_utc < right.stamped_utc ? -1 : left.stamped_utc > right.stamped_utc ? 1 : 0,
  );
  const quarantine: PsJsonValue = {
    count: quarantineRows.length,
    topic_count: quarantineRows.reduce((total, row) => total + row.topics.length, 0),
    oldest: dated.length
      ? {
          name: dated[0]!.name,
          quarantined_by: dated[0]!.seat,
          stamped_utc: dated[0]!.stamped_utc,
          stamp_source: dated[0]!.stamp_source,
          age_days: dated[0]!.age_days,
        }
      : null,
    undated_count: quarantineRows.length - dated.length,
    // NAMED EVEN WHEN THE COUNT IS ZERO. A reader who has just been told there is nothing in
    // quarantine is the one most likely to want to check that for themselves.
    list_route: 'tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List',
    note: 'Set aside by a reset and still recoverable. Both reads need no seat, unlike this overview.',
  };

  // A capture Book is closed by default, so its notes would otherwise be invisible until the reader
  // happened to remember them. ONLY COUNTS AND THE OLDEST PENDING DATE: note titles and bodies still
  // require opening the Book, exactly as any other Shelf Book's pages do.
  const openShelfSlugs = openBooks.filter((book) => book.location === 'shelf').map((book) => book.slug);
  const captureBooks = captureBookRows(workspace).map((book) => {
    const notes = shelfNotes(book);
    const pending = notes.filter((note) => note.review !== 'done');
    const oldestPending = pending
      .filter((note) => note.captured !== 'unknown')
      .sort((left, right) => (left.captured < right.captured ? -1 : left.captured > right.captured ? 1 : 0))[0];
    return {
      slug: book.slug,
      book_root: book.bookRoot,
      is_open: openShelfSlugs.includes(book.slug),
      pending_count: pending.length,
      reviewed_count: notes.length - pending.length,
      oldest_pending: oldestPending ? oldestPending.captured : null,
    };
  });

  const otherSeats = seatDirectoryNames(stateDirectory)
    .filter((other) => other !== seat)
    .map((other) => {
      const otherBooks = readStateLines(
        deskFilePath(stateDirectory, other, 'books'),
        BOOK_ROOT_ACCEPT_PATTERN,
        'open-book',
        true,
      );
      const otherProjects = readStateLines(
        deskFilePath(stateDirectory, other, 'projects'),
        PROJECT_ROOT_PATTERN,
        'open-project',
        true,
      );
      const activity = readSeatActivity(stateDirectory, other);
      // ONE READ, USED TWICE. Two calls could disagree, which is exactly what the derived field
      // below exists to make impossible.
      const claim = getSeatClaimState(stateDirectory, other);
      return {
        seat: other,
        open_book_count: otherBooks.length,
        open_project_count: otherProjects.length,
        // THREE STATES, NOT A BOOLEAN. `orphaned` -- the bound agent still running with its claim
        // holder gone -- used to report as unclaimed, which reads as "that seat is finished" and is
        // the opposite of true.
        claim_state: claim.state,
        claimed: claim.state !== 'free',
        last_activity_advisory: activity && 'last_seen_utc' in activity ? String(activity['last_seen_utc']) : null,
      };
    });

  // ONE READ OF THE CLAIM, USED FOR EVERY FIELD: a `bound_utc` beside an `agent_pid` taken from a
  // different read is two answers pretending to be one.
  const thisClaim = getSeatClaimState(stateDirectory, seat);
  const thisActivity = readSeatActivity(stateDirectory, seat);
  const conversation = seatConversationView(stateDirectory, seat);
  const thisSeat: Record<string, PsJsonValue> = {
    seat,
    // WHICH OF THE THREE SOURCES ANSWERED. A seat named by LIBRARY_SEAT is a name and not a verified
    // binding, and the reader is told that on every prompt of such a session.
    seat_source: resolved.source ?? '',
    claim_state: thisClaim.state,
    claimed: thisClaim.state !== 'free',
    state_note:
      thisClaim.state === 'orphaned'
        ? `agent ${thisClaim.agentPid} alive, claim holder gone; re-enter this seat to repair it`
        : '',
    agent_pid: thisClaim.agentPid,
    agent_start_utc: thisClaim.agentStartUtc,
    bound_utc: thisClaim.boundUtc,
    seat_id: thisClaim.seatId,
    binding_state: thisClaim.bindingState,
    binding_stale: thisClaim.bindingStale,
    this_agent: thisClaim.thisAgent,
    last_activity_advisory:
      thisActivity && 'last_seen_utc' in thisActivity ? String(thisActivity['last_seen_utc']) : null,
    session_id: conversation.session_id,
    conversation_source: conversation.conversation_source,
    recorded_utc: conversation.recorded_utc,
    title: conversation.title,
    title_status: conversation.title_status,
    title_note: conversation.title_note,
    entry_action: conversation.entry_action,
    entry_note: conversation.entry_note,
  };
  // NEVER BLANK, in the words the picker's own column uses. A blank here reads as an untitled
  // conversation and cannot be told from an old client, a pruned history or a redirected config dir.
  thisSeat['conversation_line'] = formatSeatConversationCell(conversation);
  // AND WHETHER THAT CONVERSATION IS THIS ONE, which is the difference between "your seat last held
  // X" and "you are X".
  thisSeat['is_this_conversation'] = thisClaim.thisAgent && conversation.conversation_source === 'binding';

  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Desk Overview',
    workspace,
    seat,
    this_seat: thisSeat,
    other_seats: otherSeats,
    seat_consistency: seatRegistryConsistency(workspace, stateDirectory),
    open_books: openBooks,
    open_projects: openProjects,
    capture_books: captureBooks,
    notebook: {
      path: notebookRoot,
      topic_count: topics.length,
      article_count: topicArticleCount + standaloneArticleCount,
      topics,
      standalone_article_count: standaloneArticleCount,
      // NOT PART OF `topic_count` OR `article_count` ABOVE, and kept a level down so it cannot be
      // read as one. Those describe what is IN notebook/; this describes what a reset took OUT of it.
      quarantine,
      // SAID ONLY WHILE IT IS TRUE: a half-moved Notebook is the one state the reader must hear about
      // from the overview, because every Notebook verb refuses until it is resolved.
      ...(layout.state === 'migrating'
        ? { migration: "A Notebook migration is in progress and has not completed; every Notebook verb refuses until 'library migrate --resume' finishes it or '--rollback' undoes it." }
        : {}),
    },
    scope:
      'Read-only local state: Virtual Desk lists, Notebook indexes, the Notebook topic-ownership record, ' +
      'the names and reset journals of the quarantine directories under internal/, ' +
      'capture-Book note counts, the seat registry ' +
      'against the seat directories and the retirement records in internal/seat-archive/, and -- for ' +
      "THIS seat only -- its claim, its binding, and the head of its last conversation's transcript. " +
      "No Book or Project page content was read, and no other seat's conversation was looked up.",
    shared_library_write: false,
  };
}

function listDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function countMarkdownArticles(root: string): number {
  let count = 0;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.toLowerCase().endsWith('.md') && item.name !== '_index.md') count += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return count;
}

/** The first prose paragraph of a topic index, capped. Headings, quotes and lists are not prose. */
function indexOverview(indexPath: string): string | null {
  if (!fs.existsSync(indexPath)) return null;
  const parts: string[] = [];
  let started = false;
  for (const rawLine of readUtf8(indexPath).replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (started) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('>') || /^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
    started = true;
    parts.push(line);
  }
  if (!parts.length) return null;
  const overview = parts.join(' ');
  return overview.length > 300 ? overview.substring(0, 297).replace(/\s+$/, '') + '...' : overview;
}

/**
 * The ownership record, keyed by topic. FAILS CLOSED on anything it cannot parse, because empty is
 * the DANGEROUS reading: reset would then see no owners and conclude every topic was unmapped.
 */
function readNotebookTopicOwners(workspace: string): Map<string, Record<string, unknown>> {
  const file = path.join(workspace, 'internal', 'notebook-topic-owners.json');
  const owners = new Map<string, Record<string, unknown>>();
  if (!fs.existsSync(file)) return owners;
  let parsed: { topics?: unknown };
  try {
    parsed = JSON.parse(readUtf8(file)) as { topics?: unknown };
  } catch (error) {
    throw new Error(
      `The Notebook ownership record at ${file} is not valid JSON: ${(error as Error).message}. ` +
        'Repair it before resetting anything.',
    );
  }
  if (!('topics' in parsed)) throw new Error(`The Notebook ownership record at ${file} has no 'topics' list.`);
  for (const entry of Array.isArray(parsed.topics) ? (parsed.topics as Record<string, unknown>[]) : []) {
    for (const required of ['topic', 'scope']) {
      if (!(required in entry)) throw new Error(`A topic entry in ${file} has no '${required}' field.`);
    }
    const topic = String(entry['topic']);
    if (!SLUG_PATTERN.test(topic)) throw new Error(`The ownership record names a malformed topic '${topic}'.`);
    const scope = String(entry['scope']);
    if (!['owned', 'shared', 'excluded'].includes(scope)) {
      throw new Error(`Topic '${topic}' has scope '${scope}'; expected one of owned, shared, excluded.`);
    }
    if (scope === 'owned' && !('seat' in entry)) throw new Error(`Topic '${topic}' is owned and names no seat.`);
    if (owners.has(topic)) throw new Error(`The Notebook ownership record at ${file} names the same topic twice.`);
    owners.set(topic, entry);
  }
  return owners;
}

interface CaptureBookRow {
  slug: string;
  title: string;
  bookRoot: string;
  wikiPath: string;
  notesPath: string;
  isCapture: boolean;
  summary: string;
  topics: string[];
}

/** Every capture-enabled Book the catalog names, whose pages directory exists. */
function captureBookRows(workspace: string): CaptureBookRow[] {
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) return [];
  const books: CaptureBookRow[] = [];
  for (const section of shelfCatalogSections(readUtf8(catalogFile))) {
    if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
    const pathMatch = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body);
    if (!pathMatch) continue;
    const slug = pathMatch[1]!;
    const wikiPath = path.join(workspace, 'shelf', slug, 'wiki');
    if (!fs.existsSync(wikiPath)) continue;
    books.push({
      slug,
      title: section.title.trim(),
      bookRoot: `shelf/${slug}`,
      wikiPath,
      notesPath: path.join(wikiPath, 'notes'),
      isCapture: true,
      summary: '',
      topics: [],
    });
  }
  return books.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

/**
 * Does the registry agree with `.claude/seats/`, and is every archive a readable retirement?
 *
 * A REPORT ANSWERS; IT DOES NOT FAIL CLOSED. Every DECISION in this family refuses an unreadable
 * registry, which is right -- but this is the Desk overview's source, and a reader whose registry has
 * been hand-edited into nonsense needs to be TOLD that rather than to lose the orientation tool that
 * would say so.
 */
export function seatRegistryConsistency(workspace: string, stateDirectory: string): PsJsonValue {
  const faults: string[] = [];
  let readable = true;
  let registered: SeatRegistryEntry[] = [];
  let onDisk: string[] = [];
  try {
    registered = readSeatRegistry(stateDirectory);
  } catch (error) {
    readable = false;
    faults.push((error as Error).message);
  }
  try {
    onDisk = seatDirectoryNames(stateDirectory);
  } catch (error) {
    readable = false;
    faults.push((error as Error).message);
  }
  const retirement = readSeatRetirementRecords(workspace);

  const names = [...new Set([...registered.map((entry) => entry.seat), ...onDisk])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rows: PsJsonValue[] = [];
  for (const seat of names) {
    const entry = registered.find((row) => row.seat === seat);
    const inRegistry = entry !== undefined;
    const hasDirectory = onDisk.includes(seat);
    // `unknown` RATHER THAN A GUESS when one of the two sources could not be read at all. With an
    // unreadable registry every seat would otherwise read `unregistered`, which is a different fault
    // with a different remedy and would send the reader to delete Desks.
    const state = !readable ? 'unknown' : inRegistry && hasDirectory ? 'ok' : inRegistry ? 'desk-missing' : 'unregistered';
    rows.push({ seat, in_registry: inRegistry, has_directory: hasDirectory, seat_id: entry?.seatId ?? '', state });
    if (state === 'desk-missing') {
      faults.push(
        `seat '${seat}' is in the registry with no .claude/seats/${seat} directory: its Desk is gone and ` +
          "nothing treats it as retired, so its Notebook topics stay out of every other seat's reset. Retire it with " +
          `tools/Retire-Seat.ps1 -Seat ${seat} to record that it is finished, or recreate its Desk by entering it.`,
      );
    } else if (state === 'unregistered') {
      faults.push(
        `.claude/seats/${seat} exists and no registry entry names it, so no helper can enter, retire or ` +
          'reset it. Copy anything you need out of that directory and remove it, or restore the registry entry.',
      );
    }
  }
  for (const fault of retirement.faults) faults.push(fault);

  return {
    seats: rows,
    retirements: retirement.records as unknown as PsJsonValue,
    faults,
    consistent: faults.length === 0,
  };
}

export interface SeatRegistryEntry {
  seat: string;
  seatId: string;
  project: string;
}

/**
 * The registry, or an empty one. FAILS CLOSED on anything it cannot parse.
 *
 * THE PROJECT IS CARRIED AND CHECKED SINCE S17, because the Notebook's ownership writer records a
 * topic's project from here -- a caller that restated it could disagree with the registry -- and
 * because `Read-SeatRegistry` refuses a registry that binds one project to two seats, which this
 * reader used to let through.
 */
export function readSeatRegistry(stateDirectory: string): SeatRegistryEntry[] {
  const file = path.join(stateDirectory, 'seats', '_registry.json');
  if (!fs.existsSync(file)) return [];
  let parsed: { seats?: unknown };
  try {
    parsed = JSON.parse(readUtf8(file)) as { seats?: unknown };
  } catch (error) {
    throw new Error(
      `The seat registry at ${file} is not valid JSON: ${(error as Error).message}. Repair it or retire the seats it names.`,
    );
  }
  if (!('seats' in parsed)) throw new Error(`The seat registry at ${file} has no 'seats' list.`);
  const rows = Array.isArray(parsed.seats) ? (parsed.seats as Record<string, unknown>[]) : [];
  const seats: SeatRegistryEntry[] = [];
  for (const row of rows) {
    for (const required of ['seat', 'project']) {
      if (!(required in row)) throw new Error(`A seat entry in ${file} has no '${required}' field.`);
    }
    const seat = String(row['seat']);
    if (!SLUG_PATTERN.test(seat)) throw new Error(`The seat registry names a malformed seat '${seat}'.`);
    const project = String(row['project']);
    if (!SLUG_PATTERN.test(project)) throw new Error(`Seat '${seat}' is bound to a malformed project slug.`);
    seats.push({ seat, seatId: 'seat_id' in row ? String(row['seat_id']) : '', project });
  }
  if (new Set(seats.map((entry) => entry.seat)).size !== seats.length) {
    throw new Error(`The seat registry at ${file} names the same seat twice.`);
  }
  if (new Set(seats.map((entry) => entry.project)).size !== seats.length) {
    throw new Error(
      `The seat registry at ${file} binds one project to two seats. A project has at most one seat; retire one with tools/Retire-Seat.ps1.`,
    );
  }
  return seats;
}

/**
 * Every readable retirement record. FAILS CLOSED PER ARCHIVE rather than for the whole read: the
 * only thing a retirement record licenses is a whole-tree reset moving somebody's topics, and a
 * half-written archive must never license that. Throwing instead would take the Desk overview down
 * over a directory nobody is asking about.
 */
export function readSeatRetirementRecords(workspace: string): {
  records: { seat: string; seat_id: string; retired_utc: string; directory: string }[];
  faults: string[];
} {
  const root = path.join(workspace, 'internal', 'seat-archive');
  if (!fs.existsSync(root)) return { records: [], faults: [] };
  const records: { seat: string; seat_id: string; retired_utc: string; directory: string }[] = [];
  const faults: string[] = [];
  for (const name of listDirectories(root)) {
    const file = path.join(root, name, 'seat.json');
    if (!fs.existsSync(file)) {
      faults.push(
        `internal/seat-archive/${name} carries no seat.json, so it records no retirement; nothing treats the seat it is named for as retired`,
      );
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readUtf8(file)) as Record<string, unknown>;
    } catch (error) {
      faults.push(`internal/seat-archive/${name}/seat.json could not be read: ${(error as Error).message}`);
      continue;
    }
    if (!('seat' in parsed)) {
      faults.push(`internal/seat-archive/${name}/seat.json names no seat`);
      continue;
    }
    records.push({
      seat: String(parsed['seat']),
      // ABSENT IS '' AND MEANS THE PRE-IDENTITY INCARNATION. A retirement archived before
      // incarnations existed carries no id.
      seat_id: 'seat_id' in parsed ? String(parsed['seat_id']) : '',
      retired_utc: 'retired_utc' in parsed ? String(parsed['retired_utc']) : '',
      directory: name,
    });
  }
  return { records, faults };
}

/** ONLY REGISTERED SEATS ARE OFFERED: a directory no registry entry names cannot be entered. */
function addSeatRosterToRefusal(message: string, workspace: string, stateDirectory: string): string {
  let report: PsJsonValue;
  try {
    report = seatRegistryConsistency(workspace, stateDirectory);
  } catch (error) {
    return `${message} The seats could not be listed: ${(error as Error).message}`;
  }
  const record = report as Record<string, PsJsonValue>;
  const rows = record['seats'] as Record<string, PsJsonValue>[];
  // `unknown` means a source could not be read at all, and every row carries it together. Listing
  // the rows anyway would report "no seats exist" about a workspace whose registry is merely
  // unreadable -- a different fault with a different remedy.
  if (rows.some((row) => row['state'] === 'unknown')) {
    return `${message} The seats could not be listed: ${(record['faults'] as string[]).join(' ')}`;
  }
  const registered = rows.filter((row) => row['in_registry'] === true).map((row) => String(row['seat']));
  let sentence = seatRosterSentence(registered);
  const stray = rows.filter((row) => row['state'] === 'unregistered').map((row) => String(row['seat']));
  if (stray.length) {
    sentence +=
      ' No helper can enter these, so they are not offered as seats: ' +
      stray.map((seat) => `.claude/seats/${seat}`).join(', ') +
      '.';
  }
  return `${message} ${sentence}`;
}

function seatRosterSentence(seats: string[]): string {
  if (!seats.length) {
    return 'This workspace has no seats yet. Create one with tools/Start-LibrarySeat.ps1 -Seat <name> -Project <project-slug>.';
  }
  if (seats.length === 1) return `This workspace has one seat: ${seats[0]}.`;
  return `This workspace has ${seats.length} seats: ${seats.join(', ')}.`;
}

// --- this seat's last conversation ------------------------------------------------------------------

interface ConversationView {
  session_id: string;
  conversation_source: string;
  recorded_utc: string;
  title: string;
  title_status: string;
  title_note: string;
  entry_action: string;
  entry_note: string;
}

const CONVERSATION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// THE BOUND IS DERIVED FROM A MEASUREMENT: worst observed first title at line 282 and 682 KB, so
// these are roughly 7x and 6x the worst real case.
const TRANSCRIPT_LINE_BUDGET = 2000;
const TRANSCRIPT_BYTE_BUDGET = 4194304;

/**
 * One seat's last conversation, what it is called, AND what entering it would do.
 *
 * THE BRANCHING IS THE POINT, not the two lookups it wraps: a record that is present and unusable
 * gets its own status and no lookup at all, and a second copy of that three-arm decision is how
 * "malformed" quietly becomes "no title" on one surface only.
 */
function seatConversationView(stateDirectory: string, seat: string): ConversationView {
  const record = seatConversationRecord(stateDirectory, seat);
  const view: ConversationView = {
    session_id: record.sessionId,
    conversation_source: record.source,
    recorded_utc: record.recordedUtc,
    title: '',
    title_status: 'no-conversation',
    title_note: '',
    entry_action: 'none',
    entry_note: '',
  };
  if (record.source === 'malformed') {
    // NO LOOKUP AND NO RESUME, and the answer says which of the two blank-column facts this is: a
    // record that is there and unusable, rather than no record at all.
    view.title_status = 'malformed-conversation';
    view.title_note = 'the conversation it records is not a uuid, so nothing was looked up';
    view.entry_note = 'the conversation it records is not a uuid, so there is nothing to enter';
    return view;
  }
  const answer = seatConversationTitle(seatTranscriptRoot(), record.sessionId);
  view.title = answer.title;
  view.title_status = answer.status;
  view.title_note = answer.reason;
  if (!record.sessionId.trim()) {
    view.entry_action = 'none';
    view.entry_note = 'nothing has recorded a conversation at this seat';
  } else {
    // THE TITLE LOOKUP'S OWN STATUS IS THE TRANSCRIPT FACT, not a proxy for it: `no-transcript` means
    // the file was searched for by name across every project directory and not found. Every other
    // status found the file, so the conversation is there to resume.
    view.entry_action = 'resume';
    view.entry_note = '';
  }
  return view;
}

function seatTranscriptRoot(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR'];
  const root = configured && configured.trim() ? configured : path.join(homeDirectory(), '.claude');
  return path.join(root, 'projects');
}

/**
 * The conversation a seat last recorded. THE NEWER OF TWO RECORDS, NOT THE MORE TRUSTED ONE: the
 * binding's id is verified identity, and the advisory one is written by the LAUNCHER, because a
 * launcher-started session can never hold a binding. Preferring the binding unconditionally would
 * offer a resume of the conversation BEFORE last at exactly the seat a terminal reader uses.
 */
export function seatConversationRecord(
  stateDirectory: string,
  seat: string,
): { sessionId: string; source: string; recordedUtc: string } {
  let record = { sessionId: '', source: 'none', recordedUtc: '' };
  // A RECORD THAT IS PRESENT AND UNUSABLE IS NOT AN ABSENT RECORD. Reporting it as "nothing has
  // recorded a conversation here" would be absence standing in for a fault.
  let malformed = false;

  const binding = readSeatBinding(stateDirectory, seat);
  if (binding && binding.state === 'committed' && binding.session_id !== undefined) {
    if (CONVERSATION_ID_PATTERN.test(binding.session_id)) {
      record = { sessionId: binding.session_id, source: 'binding', recordedUtc: binding.bound_utc ?? '' };
    } else if (binding.session_id.trim()) {
      malformed = true;
    }
  }

  const activity = readSeatActivity(stateDirectory, seat);
  if (activity && 'session_id' in activity && 'conversation_recorded_utc' in activity) {
    const advisoryId = String(activity['session_id']);
    const advisoryAt = String(activity['conversation_recorded_utc']);
    if (CONVERSATION_ID_PATTERN.test(advisoryId)) {
      if (isRecordNewer(advisoryAt, record.recordedUtc)) {
        record = { sessionId: advisoryId, source: 'activity', recordedUtc: advisoryAt };
      }
    } else if (advisoryId.trim()) {
      malformed = true;
    }
  }
  if (record.source === 'none' && malformed) record = { sessionId: '', source: 'malformed', recordedUtc: '' };
  return record;
}

/** An unparseable or absent `than` is older than anything; an unparseable candidate is newer than nothing. */
function isRecordNewer(candidate: string, than: string): boolean {
  const candidateTime = Date.parse(candidate);
  if (Number.isNaN(candidateTime)) return false;
  const thanTime = Date.parse(than);
  if (Number.isNaN(thanTime)) return true;
  return candidateTime > thanTime;
}

/**
 * The title of one conversation, with a DISTINCT status for every way it can be absent. A single
 * empty string would collapse "an old client wrote none", "this configuration has no transcript for
 * that id", "the file is there and unreadable" and "nothing recorded a conversation here" into the
 * answer that happens to be commonest.
 */
function seatConversationTitle(
  transcriptRoot: string,
  sessionId: string,
): { status: string; title: string; reason: string } {
  if (!sessionId.trim()) {
    return { status: 'no-conversation', title: '', reason: 'nothing has recorded a conversation at this seat' };
  }
  if (!CONVERSATION_ID_PATTERN.test(sessionId)) {
    return {
      status: 'malformed-conversation',
      title: '',
      reason: 'the recorded conversation id is not a uuid, so no transcript was looked for',
    };
  }
  if (!fs.existsSync(transcriptRoot)) {
    return { status: 'no-transcript-root', title: '', reason: `no transcript directory at ${transcriptRoot}` };
  }
  // FOUND BY NAME ACROSS THE PROJECT DIRECTORIES RATHER THAN BY COMPOSING ONE. The client derives a
  // project directory from the workspace path by a mangling rule it does not document, and a
  // reimplementation of that rule would be a lookalike of the consumer whose files it reads.
  let transcript: string | null = null;
  for (const directory of listDirectories(transcriptRoot)) {
    const candidate = path.join(transcriptRoot, directory, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcript = candidate;
      break;
    }
  }
  if (transcript === null) {
    // A TRANSCRIPT NOT FOUND IS NOT A DELETED TRANSCRIPT. A different config dir, a different machine
    // or a pruned history all land here, so this says what was searched rather than that it is gone.
    return { status: 'no-transcript', title: '', reason: 'no transcript for it under this configuration' };
  }

  let title = '';
  let lines = 0;
  let bytes = 0;
  let reachedEnd = false;
  try {
    const text = fs.readFileSync(transcript, 'utf8');
    for (const line of text.split('\n')) {
      if (lines >= TRANSCRIPT_LINE_BUDGET || bytes >= TRANSCRIPT_BYTE_BUDGET) break;
      lines += 1;
      bytes += line.length;
      // THE MARKER TEST BEFORE THE PARSE, and it is not an optimisation for its own sake: a
      // transcript line is a whole assistant turn, tens of kilobytes of it.
      if (!line.includes('"ai-title"')) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
        if (record.type !== 'ai-title' || record.aiTitle === undefined) continue;
        const candidate = String(record.aiTitle);
        if (candidate.trim()) title = candidate.trim();
      } catch {
        continue;
      }
    }
    reachedEnd = lines < TRANSCRIPT_LINE_BUDGET && bytes < TRANSCRIPT_BYTE_BUDGET;
  } catch (error) {
    return { status: 'unreadable', title: '', reason: `its transcript could not be read: ${(error as Error).message}` };
  }

  if (title) return { status: 'titled', title, reason: '' };
  // WHETHER THE FILE ENDED, not whether the budget was reached: a transcript of exactly the budget's
  // length with no title has been read WHOLE.
  if (!reachedEnd) return { status: 'budget-exhausted', title: '', reason: `no title in its first ${lines} lines` };
  return { status: 'no-title', title: '', reason: 'its transcript records no title' };
}

/** The last column: the title in quotes, or the reason there is none. NEVER BLANK. */
function formatSeatConversationCell(row: ConversationView, titleWidth = 52): string {
  if (row.entry_action === 'restart' && row.entry_note.trim()) {
    let cell = row.entry_note;
    if (row.conversation_source === 'activity') cell += ' (advisory)';
    return cell;
  }
  let cell: string;
  if (row.title_status === 'titled') {
    let title = row.title;
    if (title.length > titleWidth) title = title.substring(0, titleWidth - 1).replace(/\s+$/, '') + '…';
    cell = `"${title}"`;
  } else {
    cell = row.title_note.trim() ? row.title_note : row.title_status;
  }
  // ADVISORY IS LABELLED WHEREVER IT IS SHOWN: this conversation was recorded by a launcher rather
  // than by a verified binding.
  if (row.conversation_source === 'activity' && row.title_status !== 'no-conversation') cell += ' (advisory)';
  return cell;
}

// --- the writes -------------------------------------------------------------------------------------

export interface DeskWriteOptions {
  workspace: string;
  action: 'open' | 'close' | 'clear';
  kind: 'book' | 'project';
  location: 'shared' | 'shelf';
  shelf: 'active' | 'archive';
  slug: string;
  seat?: string | undefined;
  claimToken?: string | undefined;
}

/**
 * Open, close or clear this seat's Desk.
 *
 * THE DESK BELONGS TO A SEAT, and there is no default one. This is the canonical Desk writer, so it
 * is also the place a missing seat is felt first and has to say the most useful thing.
 */
export function deskWrite(options: DeskWriteOptions): Record<string, PsJsonValue> {
  const workspace = options.workspace;
  const stateDirectory = path.join(workspace, '.claude');
  const resolved = resolveSeatName({ seat: options.seat, stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;

  const deskDirectory = deskStateDirectory(stateDirectory, seat);
  const openBooksPath = deskFilePath(stateDirectory, seat, 'books');
  const openProjectsPath = deskFilePath(stateDirectory, seat, 'projects');
  // THE COLLECTION THE DESK IS PINNED TO, ON EITHER BACKEND (S46, ADR-0044). A workspace attached to its
  // local collection has no Basic Memory pin, and asking for one refused every Desk write on the default
  // route, a Shelf Book's included. Its collection is the one the marker names, confirmed by opening it.
  const marker = readMarker(workspace);
  const local = marker !== null && String(marker['backend'] ?? '') === 'local';
  const localCollection = local ? openCollection(workspace) : null;
  const projectPin = path.join(stateDirectory, '.library-project');
  if ((!local && !fs.existsSync(projectPin)) || !fs.existsSync(openBooksPath)) {
    refuse('Virtual Desk is not configured in this workspace.');
  }
  if (!local && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(readUtf8(projectPin).trim())) {
    refuse('Virtual Desk project pin is malformed.');
  }

  // Step 15b: a mutator requires a matching live claim. Checked BEFORE the lock, so a session that is
  // not entitled to write does not queue behind one that is.
  assertSeatClaimHeld({ workspace, stateDirectory, seat, token: options.claimToken });
  let deskLock: BookLock | null = null;
  let openBooks: string[];
  let openProjects: string[];
  try {
    deskLock = enterSeatRegistryLock(workspace);
    openBooks = readStateLines(openBooksPath, BOOK_ROOT_ACCEPT_PATTERN, 'open-book').map(convertToBookRoot);
    if (new Set(openBooks).size !== openBooks.length) refuse('Virtual Desk open-book state contains duplicates.');
    openProjects = readStateLines(openProjectsPath, PROJECT_ROOT_PATTERN, 'open-project');

    if (options.action === 'open' || options.action === 'close') {
      // The slug rule, and the two refusals it separates: "that is a root, pass its slug" is a
      // different mistake from "that is not a slug at all", and one sentence for both sent readers
      // to the wrong fix for as long as they shared it.
      assertBookSlug(options.slug);
    }

    if (options.action === 'clear') {
      openBooks = [];
      openProjects = [];
    } else if (options.kind === 'book') {
      const bookRoot = newBookRoot(options.location, options.shelf, options.slug);
      if (options.action === 'open') {
        // A Shelf Book is local, so its existence is checkable here; a shared Book -- active or
        // archived -- is validated by the reader against the collection at read time.
        if (options.location === 'shelf') {
          // wiki_root FROM THE SCHEMA, never composed here. An archived Shelf Book's pages are at
          // shelf/_archive/<slug>/wiki, and the composed path tested the wrong directory -- which
          // survived its own self-test because that fixture also held an ACTIVE Book of the same name.
          const wikiRelative = splitBookRoot(bookRoot).wikiRoot;
          if (!fs.existsSync(path.join(workspace, ...wikiRelative.split('/')))) {
            refuse(`No Shelf Book '${options.slug}' exists at ${wikiRelative}.`);
          }
        } else if (localCollection) {
          // A LOCAL COLLECTION IS AS CHECKABLE AS THE SHELF, so a Book it does not hold is refused here
          // rather than opened and refused at every read.
          const wikiRelative = splitBookRoot(bookRoot).wikiRoot;
          if (!fs.existsSync(path.join(localCollection.root, ...wikiRelative.split('/')))) {
            refuse(`No Book '${options.slug}' exists in this workspace's local collection at collection/${wikiRelative}.`);
          }
        }
        if (!openBooks.includes(bookRoot)) openBooks.push(bookRoot);
      } else {
        openBooks = openBooks.filter((entry) => entry !== bookRoot);
      }
    } else {
      const projectRoot = options.shelf === 'archive' ? `archive/projects/${options.slug}` : `projects/${options.slug}`;
      if (options.action === 'open') {
        if (localCollection && !fs.existsSync(path.join(localCollection.root, ...projectRoot.split('/'), '_project.md'))) {
          refuse(`No Project Hub '${options.slug}' exists in this workspace's local collection at collection/${projectRoot}/_project.md.`);
        }
        if (!openProjects.includes(projectRoot)) openProjects.push(projectRoot);
      } else {
        openProjects = openProjects.filter((entry) => entry !== projectRoot);
      }
    }

    writeDeskFile(openBooksPath, openBooks);
    writeDeskFile(openProjectsPath, openProjects);
  } finally {
    exitBookLock(deskLock);
  }

  void deskDirectory;
  // `keepConversation`, BECAUSE A DESK WRITE IS NOT AN ENTRY. It starts nothing and displaces
  // nothing, so clearing here would erase the only record of which conversation is sitting at a
  // launcher-started seat.
  writeSeatActivity({ stateDirectory, seat, note: `desk ${options.action}`, keepConversation: true });

  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    action: options.action,
    seat,
    kind: options.kind,
    location: options.kind === 'book' ? options.location : null,
    // Reported for a Book too, now that it means something there.
    shelf: options.shelf,
    slug: options.slug,
    open_books: openBooks,
    open_projects: openProjects,
    shared_library_write: false,
    same_session_note:
      'This changes future Library reads only, at this seat. Start a new Claude session for a clean conversation context.',
  };
}

function writeDeskFile(file: string, entries: string[]): void {
  // PUBLISHED BY RENAME, NOT TRUNCATED IN PLACE. The registry lock serialises WRITERS, and every
  // Desk READER holds no lock at all -- three of them are hooks, which is where an empty-looking Desk
  // turns into a denied tool call with no explanation.
  writeAtomicText(file, entries.length ? entries.join('\r\n') + '\r\n' : '');
}

function assertBookSlug(slug: string): void {
  if (SLUG_PATTERN.test(slug)) return;
  if (BOOK_ROOT_PATTERN.test(slug)) {
    refuse(`'${slug}' is a Book root, not a slug. Pass its slug (${splitBookRoot(slug).slug}) instead.`);
  }
  refuse(
    `Book slug '${slug}' is malformed. A slug is lowercase letters, digits and hyphens, starting with a letter or a digit.`,
  );
}

function newBookRoot(location: 'shared' | 'shelf', shelf: 'active' | 'archive', slug: string): string {
  if (location === 'shelf') {
    return shelf === 'archive' ? `shelf/_archive/${slug}` : `shelf/${slug}`;
  }
  return shelf === 'archive' ? `archive/${slug}` : `books/${slug}`;
}

void getShelfBook;
void readDeskFileLines;
void assertNoMaintenanceBarrier;
export type { DeskKind };
