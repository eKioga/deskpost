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
import { convertFromShelfCatalogEntry, getShelfBook, readUtf8, shelfCatalogPath, shelfCatalogSections, SLUG_PATTERN, type ShelfBook } from './shelfbook.ts';
import { growingState, isAddressedTo, isStartedBy, isStuckLetter, shelfNotes, WHY_CATEGORIES, type ShelfNoteRow } from './shelfnote.ts';
import { incarnationOf, readSeatIdentityView, seatIncarnation, seatNameHistory, type SeatNameSpan } from './seatincarnation.ts';
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
  launcherProofDetail,
  readSeatActivity,
  readSeatBinding,
  writeSeatActivity,
} from './seatclaim.ts';
import { writeAtomicText } from './fsx.ts';
import { notebookQuarantineInventory } from './notebook.ts';
import { homeDirectory, readMarker } from './workspace.ts';
import { openCollection } from './collection.ts';
import { readNotebookLayout, seatNotebookRelative } from './notebooklayout.ts';
import { BOOK_ROOT_ACCEPT_PATTERN, BOOK_ROOT_PATTERN, parseBookRoot, placeOfRoot, rootForPlace, type BookPlace, type BookRootParts } from './places.ts';
import { markerConnection } from './basicmemory.ts';
import { addedDirsStatus } from './seatdirs.ts';
import { seatMessageAddress } from './conversation.ts';
import { seatInboundPolicy } from './seatinbound.ts';
import { metadataFor, metadataJson, readSeatMetadata } from './seatmeta.ts';

/** The schema version `Write-LibraryResult -Json` stamps on every helper document. */
const LIBRARY_OUTPUT_SCHEMA = 1;

const PROJECT_ROOT_PATTERN = /^(projects|archive\/projects)\/[a-z0-9][a-z0-9-]*$/;

export interface DeskOptions {
  workspace: string;
  seat?: string | undefined;
}

export class DeskRefusal extends Error {}

function refuse(message: string): never {
  throw new DeskRefusal(message);
}

/**
 * One Book root taken apart. `collection` decides HOW a page is fetched -- shared over MCP, shelf
 * from disk -- and `shelf` is which half of the shared collection it is in. Keeping them separate
 * matters: an archived Book is still shared, and a reader that branched on a single field would have
 * to re-derive one of the two. The grammar is `places.ts`'s since PLAN-basic-memory.md added `shared/`.
 */
export function splitBookRoot(root: string): BookRootParts {
  const parts = parseBookRoot(root);
  if (parts === null || parts.root !== root) refuse('Virtual Desk open-book state is malformed.');
  return parts;
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
        `deskpost seat start ${seat} --project <project-slug>.`,
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
  // A BOOK'S LOCATION IS ITS PLACE (PLAN-basic-memory.md step 1): `shelf`, `shared`, and on a local Library
  // `collection` for its own `books/` -- which until 1.1 this reported as `shared`, a Book the Library holds
  // itself described as one it reaches.
  const overviewMarker = readMarker(workspace);
  const overviewLocal = overviewMarker !== null && String(overviewMarker['backend'] ?? '') === 'local';
  const openBooks = openBookRoots.map((root) => {
    const parts = splitBookRoot(root);
    return { slug: parts.slug, location: placeOfRoot(parts, overviewLocal), shelf: parts.shelf, root: parts.root };
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
  // THIS SEAT'S QUARANTINES ONLY, by the journal's `seat` (kickoffs/s106 row 7c): a Desk is one seat's, and every seat's
  // count read as this seat's. `reset restore --list` still lists them all.
  const quarantineRows = notebookQuarantineInventory(workspace).filter((row) => row.seat === seat);
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
    list_route: 'deskpost reset restore --list',
    scope: `seat ${seat}: its own quarantines only; reset restore --list lists every seat's`,
    note: 'Set aside by a reset and still recoverable. Both reads need no seat, unlike this overview.',
  };

  // A capture Book is closed by default, so its notes would otherwise be invisible until the reader
  // happened to remember them. ONLY COUNTS AND THE OLDEST PENDING DATE: note titles and bodies still
  // require opening the Book, exactly as any other Shelf Book's pages do.
  const openShelfSlugs = openBooks.filter((book) => book.location === 'shelf').map((book) => book.slug);
  // THIS SEAT AS THE RECIPIENT RULE SEES IT (kickoffs/s98 row 0): its slug and its registry row's seat_id, read once.
  const self = seatIncarnation(stateDirectory, seat);
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
      // WHY THE PENDING NOTES ARE THERE (S73 row 3b), a count per closed category and one for the rest. No value a
      // writer typed is ever said here: a `why:` outside the category counts as missing.
      pending_by_why: Object.fromEntries(WHY_CATEGORIES.map((category) => [category, pending.filter((note) => note.why === category).length])),
      // NOT FOR A `Closed by: any` BOOK (S85 row 4): capture says no why-missing advice there (S77 row 4), so the count
      // was a nag with no remedy. The Report Inbox is the case.
      ...(book.closedByDeclared === 'any'
        ? {}
        : { pending_why_missing: pending.filter((note) => !(WHY_CATEGORIES as readonly string[]).includes(note.why ?? '')).length }),
      // GROWING (S77 row 2): past the Book's pending count or age, from its own `Growing at:` line or 5 and 7. Then
      // the route, and how many of the pending notes this seat may close. Counts only.
      ...((): Record<string, PsJsonValue> => {
        const state = growingState(book, notes, self);
        return state.growing
          ? { growing: true, growing_route: `library desk open book ${book.slug} --location shelf, then library triage batch`, pending_this_seat_may_close: state.mayClose }
          : { growing: false };
      })(),
    };
  });

  // ONE READ OF THE REGISTRY'S FIELDS AND OF THE LETTERS (1.3.8, kickoffs/s96 rows 1 and 4), used for every row below.
  const projection = readSeatMetadata(stateDirectory);
  const letterCounts = pendingLetterCounts(workspace);
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
        // THE NAME A PEER ANSWERS TO (kickoffs/s79 row 2, plan section 2), only while it is held, from the same claim
        // read: a seat finds its peers here rather than by guessing from ListAgents. A Codex peer has no inbox, and
        // says so instead.
        ...(seatMessageAddress(stateDirectory, other, claim.state) as Record<string, PsJsonValue>),
        // ITS INBOUND POLICY, while held (1.3.1, kickoffs/s79 row 3), in its own file's words.
        ...(claim.state === 'held' ? { inbound_policy: seatInboundPolicy(stateDirectory, other) } : {}),
        // ITS PENDING LETTERS, AS A NUMBER (1.3.8, kickoffs/s96 row 4), by today's recipient rule; never a title.
        pending_letters: letterCounts.get(other) ?? 0,
      };
    });

  // ONE READ OF THE CLAIM, USED FOR EVERY FIELD: a `bound_utc` beside an `agent_pid` taken from a
  // different read is two answers pretending to be one.
  const thisClaim = getSeatClaimState(stateDirectory, seat);
  const thisActivity = readSeatActivity(stateDirectory, seat);
  const conversation = seatConversationView(stateDirectory, seat);
  // THE LAUNCHER PROOF, READ ONCE (kickoffs/s98 row G): `unchecked` is a run whose own walk and CLAUDE_PID both left
  // nothing to look at, which the note below says rather than leaving it blank.
  // AND `other-agent` (kickoffs/s104 row 4): the launcher holds this seat for an agent that is not this one, named by pid.
  const launcherDetail =
    resolved.source === 'environment' && thisClaim.state === 'held' ? launcherProofDetail(stateDirectory, seat) : { outcome: 'not-held' as const, agentPid: null };
  const launcherProof = launcherDetail.outcome;
  const launcherHeld = launcherProof === 'held';
  const thisSeat: Record<string, PsJsonValue> = {
    seat,
    // WHICH OF THE THREE SOURCES ANSWERED. A seat named by LIBRARY_SEAT is a name and not a verified
    // binding, and the reader is told that on every prompt of such a session.
    seat_source: resolved.source ?? '',
    claim_state: thisClaim.state,
    claimed: thisClaim.state !== 'free',
    // A LAUNCHER-HELD SEAT SAYS SO HERE TOO (the S60 report, #1), in the field that already carries the claim's story,
    // so `this_agent: false` -- no ADR-0018 binding -- is not read as "this seat is not yours".
    state_note:
      thisClaim.state === 'orphaned'
        ? `agent ${thisClaim.agentPid} alive, claim holder gone; re-enter this seat to repair it`
        : launcherHeld
          ? 'held for this session by the deskpost launcher that started it; there is nothing to bind'
          : launcherProof === 'unchecked'
            ? 'could not check the launcher from this process: no agent above it and none named by CLAUDE_PID, so this seat reads as named by LIBRARY_SEAT'
            : launcherProof === 'other-agent'
              ? `held by the deskpost launcher for another agent (pid ${launcherDetail.agentPid ?? 'unknown: the launcher has no agent child this process can see'})`
              : '',
    agent_pid: thisClaim.agentPid,
    agent_start_utc: thisClaim.agentStartUtc,
    bound_utc: thisClaim.boundUtc,
    // THE REGISTRY ROW'S ID, IN EVERY CLAIM STATE (kickoffs/s106 row 7a): the binding's was null for a free seat and could
    // name an earlier incarnation's; the claim's stays only where the registry carries no valid id.
    seat_id: self.seatId || thisClaim.seatId,
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
    // THE FOLDERS THIS SEAT IS STARTED WITH (1.2.5, ADR-0061), each with whether it is there now. A record that cannot be
    // read is an empty list here; `seat dirs` and `seat start` say why.
    added_dirs: (() => {
      try {
        return addedDirsStatus(stateDirectory, seat) as unknown as PsJsonValue;
      } catch {
        return [];
      }
    })(),
  };
  // THE NAME THIS SEAT'S SESSION ANSWERS TO (1.2.6), only while held, as `seat status` says it. A Codex seat has no
  // inbox, so it has no `message_name` here; `seat status` says why.
  const address = seatMessageAddress(stateDirectory, seat, thisClaim.state);
  if ('message_name' in address) thisSeat['message_name'] = address.message_name ?? null;
  if (address.assistant) thisSeat['assistant'] = address.assistant;
  // ITS INBOUND POLICY, only while held (1.3.1, kickoffs/s79 row 3, ruling 3): what the seat's own file says, never the
  // effective value, which managed and user settings and both sessions' permission modes also decide.
  if (thisClaim.state === 'held') thisSeat['inbound_policy'] = seatInboundPolicy(stateDirectory, seat);
  // THE LETTERS WAITING FOR THIS SEAT (kickoffs/s79 row 2, ADR-0062), only while it is held: its pending notes addressed
  // to it by the recipient predicate (kickoffs/s98 row 0), in any capture Book, and no other seat's. Counts and the oldest date only, as the capture
  // Books above are said: a letter's title and text still need its Book opened.
  const pendingNotes = pendingCaptureNotes(workspace);
  const lettersForThisSeat: PsJsonValue | null = ((): PsJsonValue | null => {
    if (thisClaim.state !== 'held') return null;
    const mine = pendingNotes.filter(({ note }) => isAddressedTo(note, self));
    const tally = letterTally(mine);
    return tally.count
      ? {
          count: tally.count,
          by_book: tally.byBook,
          oldest_pending: tally.oldest,
          // WHERE THEY ARE LISTED (kickoffs/s99 row 4, ruling 2): the reader map's group for this seat, or the inventory.
          // THE SECTION THE READER CAN READ (kickoffs/s110 ruling 6): its `section` takes a `##` heading, so the route
          // names `## Pending review` and the `### For <seat>` group to look for inside it.
          route: `library desk open book ${Object.keys(tally.byBook)[0]} --location shelf, then read section 'Pending review' of its reader map (_index) and its letters under '### For ${seat}' there, or list them with library triage inventory --pending`,
          // STUCK (kickoffs/s99 row 4, ruling 2), the last key: its department letters older than their own Book's age.
          stuck: mine.filter(({ book, note }) => isStuckLetter(note, book)).length,
        }
      : { count: 0 };
  })();
  // THE LETTERS THIS SEAT SENT THAT ARE STILL PENDING (kickoffs/s99 row 4, ruling 2), only while it is held, in the same
  // shape with no route: the ones it started (`isStartedBy`; a route stays its first asker's). A letter also addressed
  // to this seat is counted above only, so `letters_for_this_seat.count` keeps meaning the letters this seat may close.
  const lettersFromThisSeat: PsJsonValue | null = ((): PsJsonValue | null => {
    if (thisClaim.state !== 'held') return null;
    const tally = letterTally(pendingNotes.filter(({ note }) => note.forSeat !== null && isStartedBy(note, self) && !isAddressedTo(note, self)));
    return tally.count ? { count: tally.count, by_book: tally.byBook, oldest_pending: tally.oldest } : { count: 0 };
  })();
  // NEVER BLANK, in the words the picker's own column uses. A blank here reads as an untitled
  // conversation and cannot be told from an old client, a pruned history or a redirected config dir.
  thisSeat['conversation_line'] = formatSeatConversationCell(conversation);
  // AND WHETHER THAT CONVERSATION IS THIS ONE, which is the difference between "your seat last held
  // X" and "you are X".
  // A LAUNCHER-HELD SEAT HAS NO BINDING (S85 row 4, ruling 5), so the binding rule said false of the very conversation
  // that ran this. There the recorded conversation is matched by session id against Claude Code's own
  // CLAUDE_CODE_SESSION_ID; a bound seat keeps the binding rule. The field keeps its name: the dashboard reads it.
  const thisSessionId = (process.env['CLAUDE_CODE_SESSION_ID'] ?? '').trim();
  thisSeat['is_this_conversation'] = launcherHeld
    ? thisSessionId !== '' && conversation.session_id === thisSessionId
    : thisClaim.thisAgent && conversation.conversation_source === 'binding';
  // AN EARLIER BINDING ON A LAUNCHER-HELD SEAT IS LABELLED (PLAN-one-step-upgrade.md small fix 9; the Report "the Desk
  // calls a launcher-held seat's binding stale and not this agent's"). The launcher's claim makes the seat this
  // session's, so a binding record left by an earlier conversation is not used: its fields move under
  // `previous_binding`, and the top-level ones read null rather than "stale, not this agent". NULL WHETHER OR NOT ONE
  // EXISTS (kickoffs/s98 row G, ruling 3): with none they read 0, "" and false, a binding's values for a seat that has
  // none; and the agent's pid and start time are the binding's too, so they go with it (after the older keys).
  if (launcherHeld) {
    if (thisClaim.bindingState !== '') {
      thisSeat['previous_binding'] = {
        bound_utc: thisSeat['bound_utc'] ?? null,
        binding_state: thisSeat['binding_state'] ?? null,
        binding_stale: thisSeat['binding_stale'] ?? null,
        this_agent: thisSeat['this_agent'] ?? null,
        note: "an earlier conversation's binding record; not used while the deskpost launcher holds this seat",
        agent_pid: thisSeat['agent_pid'] ?? null,
        agent_start_utc: thisSeat['agent_start_utc'] ?? null,
      };
    }
    for (const key of ['agent_pid', 'agent_start_utc', 'bound_utc', 'binding_state', 'binding_stale', 'this_agent']) thisSeat[key] = null;
  }
  // ITS CARD, DEPARTMENT, ROLE AND TEMPLATE (1.3.8, kickoffs/s96 row 1, ADR-0069), through the one validated projection,
  // after every existing key: null where absent, and a value that does not validate reads as absent (doctor names it).
  const own = metadataFor(projection, seat);
  Object.assign(thisSeat, metadataJson(own));
  // THIS SEAT'S DIRECTORY FACTS (1.3.8, kickoffs/s96 row 4, ruling 6): its department and role, the department's
  // orchestrator with its liveness, and the department's seat and open counts. Numbers and liveness, the cosmetic tier;
  // `seat cards` has the cards.
  const ownDepartment = own.department === null ? null : projection.departments.find((view) => view.department === own.department) ?? null;
  const claimStateOf = (name: string): string => (name === seat ? thisClaim.state : getSeatClaimState(stateDirectory, name).state);
  const directory: Record<string, PsJsonValue> = {
    department: own.department,
    role: own.role,
    orchestrator:
      ownDepartment?.orchestrator
        ? ((): Record<string, PsJsonValue> => {
            const name = ownDepartment.orchestrator!;
            const state = claimStateOf(name);
            const address = seatMessageAddress(stateDirectory, name, state);
            return { seat: name, open: state === 'held', message_name: state === 'held' && 'message_name' in address ? address.message_name ?? null : null };
          })()
        : null,
    seats: ownDepartment ? ownDepartment.seats.length : null,
    open: ownDepartment ? ownDepartment.seats.filter((name) => claimStateOf(name) === 'held').length : null,
    // THE DEPARTMENT'S STUCK LETTERS (kickoffs/s99 row 4, ruling 2), the last key, for its orchestrator only: its pending
    // letters in every Book that takes letters, past their own Book's age, whatever seat they now name (a route keeps
    // `for_department`). Null for any other seat, as `seats` and `open` are with no department.
    stuck_letters:
      ownDepartment !== null && ownDepartment.orchestrator === seat
        ? pendingNotes.filter(({ book, note }) => book.takesLetters === true && note.forDepartment === own.department && isStuckLetter(note, book)).length
        : null,
  };

  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Desk Overview',
    workspace,
    seat,
    this_seat: thisSeat,
    ...(lettersForThisSeat !== null ? { letters_for_this_seat: lettersForThisSeat } : {}),
    ...(lettersFromThisSeat !== null ? { letters_from_this_seat: lettersFromThisSeat } : {}),
    other_seats: otherSeats,
    directory,
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
      // THE LAYOUT, SAID ONLY WHEN WRITES WILL REFUSE (S67, two seats' Reports): a legacy Notebook refused every
      // Notebook write, and the overview said nothing until one did. Absent in the ordinary case, as `migration` is,
      // so the overview's differential row is unchanged there.
      ...(layout.state === 'legacy' || layout.state === 'migrating'
        ? {
            layout: layout.state,
            write_note:
              layout.state === 'legacy'
                ? `This Library's Notebook is still in the shared layout ADR-0029 retires (${layout.legacy.join('; ')}), so every Notebook write refuses. Run 'deskpost migrate --preflight' to see what moving it takes; every other session must be closed first.`
                : "Every Notebook write refuses until 'deskpost migrate --resume' finishes the migration or '--rollback' undoes it.",
          }
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

type CaptureBookRow = ShelfBook;

/**
 * Every capture-enabled Book the catalog names, whose pages directory exists. Read by the one entry grammar
 * (`convertFromShelfCatalogEntry`, S77 row 2), so its seat rule and `Growing at:` thresholds come with it.
 */
export function captureBookRows(workspace: string): CaptureBookRow[] {
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
    books.push(convertFromShelfCatalogEntry({ workspace, slug, title: section.title, body: section.body, bookRoot: `shelf/${slug}` }));
  }
  return books.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

/**
 * THIS SEAT'S PENDING LETTERS, AS PAGE NAMES (kickoffs/s108 ruling 3; ADR-0071): `<book>/notes/<page>` for each pending
 * note addressed to the seat by the one recipient predicate, in the Books that take letters only, sorted OLDEST FIRST
 * BY ARRIVAL: the note's `captured` instant, then the page name. A page name is `<local date>-<title>`, so two letters
 * of one day sort by title, not by time (deskpost-desk's letter of 2026-10-09); the last here is the newest that
 * arrived. Read for the Desk hook's letter line and its ledger key, and for `seat enter`'s count: never a title or a
 * sender. A note whose address is malformed is no seat's.
 */
export function pendingLetterPagesForSeat(workspace: string, seat: string): string[] {
  const stateDirectory = path.join(workspace, '.claude');
  const self = seatIncarnation(stateDirectory, seat, readSeatIdentityView(stateDirectory));
  const pages: { page: string; captured: string }[] = [];
  for (const book of captureBookRows(workspace)) {
    if (!book.takesLetters) continue;
    for (const note of shelfNotes(book)) {
      if (note.review === 'done' || !note.forSeat || note.malformed.length) continue;
      // `unknown` (no captured line) sorts before every instant, so a note with no stamp is never taken as the newest.
      if (isAddressedTo(note, self)) pages.push({ page: `${book.slug}/${note.page}`, captured: note.captured === 'unknown' ? '' : note.captured });
    }
  }
  const byName = (left: string, right: string): number => {
    const a = left.replace(/^[^/]+\//, '');
    const b = right.replace(/^[^/]+\//, '');
    return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
  };
  return pages
    .sort((left, right) => (left.captured < right.captured ? -1 : left.captured > right.captured ? 1 : byName(left.page, right.page)))
    .map((entry) => entry.page);
}

/** A pending note of a capture Book, beside its Book (kickoffs/s99 row 4). */
export interface PendingNote {
  book: CaptureBookRow;
  note: ShelfNoteRow;
}

/** Every pending note of every capture Book, read once: the Desk's letter counts and `seat retire`'s check ask it. */
export function pendingCaptureNotes(workspace: string): PendingNote[] {
  return captureBookRows(workspace).flatMap((book) => shelfNotes(book).filter((note) => note.review !== 'done').map((note) => ({ book, note })));
}

/**
 * THE LETTERS GIVEN, AS COUNTS (kickoffs/s99 rows 4 and 5): how many, how many in each Book in the Books' order, and the
 * oldest `captured` among them (`unknown` is no date). The Desk and `seat retire` say these, and never a title.
 */
export function letterTally(letters: PendingNote[]): { count: number; byBook: Record<string, number>; oldest: string | null } {
  const byBook: Record<string, number> = {};
  let oldest: string | null = null;
  for (const { book, note } of letters) {
    byBook[book.slug] = (byBook[book.slug] ?? 0) + 1;
    if (note.captured !== 'unknown' && (oldest === null || note.captured < oldest)) oldest = note.captured;
  }
  return { count: letters.length, byBook, oldest };
}

/**
 * EVERY SEAT'S PENDING LETTERS, AS A COUNT (1.3.8, kickoffs/s96 rows 3 and 4): the pending notes in any capture Book
 * addressed to the seat by the one recipient predicate (kickoffs/s98 row 0), as `letters_for_this_seat` counts them: a
 * letter stamped for an earlier incarnation of the slug, or with a malformed address, counts for no seat. Numbers only.
 * SINCE S103 (row 3) COUNTED BY IDENTITY: each letter is joined to a seat by the identity projection, counted under the
 * seat's key (its `seat_id`, or `name:<seat>` for a row without a valid one), and shown under its current name.
 */
export function pendingLetterCounts(workspace: string): Map<string, number> {
  const view = readSeatIdentityView(path.join(workspace, '.claude'));
  const byKey = new Map<string, number>();
  for (const book of captureBookRows(workspace)) {
    for (const note of shelfNotes(book)) {
      if (note.review === 'done' || !note.forSeat) continue;
      if (note.malformed.includes('for_seat') || note.malformed.includes('for_seat_id')) continue;
      const found = incarnationOf(view, note.forSeat, note.forSeatId, 'letters');
      const row = found.outcome === 'live' ? view.live.find((candidate) => candidate.seat === found.current_name) : undefined;
      if (row) byKey.set(row.key, (byKey.get(row.key) ?? 0) + 1);
    }
  }
  return new Map(view.live.filter((row) => byKey.has(row.key)).map((row) => [row.seat, byKey.get(row.key)!]));
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
          `deskpost seat retire ${seat} to record that it is finished, or recreate its Desk by entering it.`,
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
  /** `created_utc` as written, '' when absent. */
  createdUtc: string;
  /** Every name the seat has had (kickoffs/s103 row 1): its `names`, or the one name it carries since its creation. */
  names: SeatNameSpan[];
  /** Why a written `names` was read as the one implied name, or null. Doctor's identity check names it. */
  namesProblem: string | null;
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
    const createdUtc = typeof row['created_utc'] === 'string' ? row['created_utc'] : '';
    // A NAME HISTORY THAT DOES NOT PARSE READS AS THE ONE NAME, never as a refusal: the registry has many readers, and
    // doctor's identity check names it (kickoffs/s103 row 1).
    const history = seatNameHistory(seat, createdUtc, row['names']);
    seats.push({ seat, seatId: 'seat_id' in row ? String(row['seat_id']) : '', project, createdUtc, names: history.names, namesProblem: history.problem });
  }
  if (new Set(seats.map((entry) => entry.seat)).size !== seats.length) {
    throw new Error(`The seat registry at ${file} names the same seat twice.`);
  }
  if (new Set(seats.map((entry) => entry.project)).size !== seats.length) {
    throw new Error(
      `The seat registry at ${file} binds one project to two seats. A project has at most one seat; retire one with deskpost seat retire <name>.`,
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
  records: { seat: string; seat_id: string; retired_utc: string; directory: string; names: SeatNameSpan[] }[];
  faults: string[];
} {
  const root = path.join(workspace, 'internal', 'seat-archive');
  if (!fs.existsSync(root)) return { records: [], faults: [] };
  const records: { seat: string; seat_id: string; retired_utc: string; directory: string; names: SeatNameSpan[] }[] = [];
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
    // EVERY NAME THE SEAT HAD (kickoffs/s103 row 2): a record written before S103, or for a seat never renamed, has had
    // the one name it retired under. A history that does not parse is a fault, so a caller that checks names refuses
    // rather than reading a reserved name as free; the record itself still says the seat is retired.
    const history = seatNameHistory(String(parsed['seat']), '', parsed['names']);
    if (history.problem !== null) {
      faults.push(`internal/seat-archive/${name}/seat.json carries a names history that does not parse (${history.problem}); repair it by hand`);
    }
    records.push({
      seat: String(parsed['seat']),
      // ABSENT IS '' AND MEANS THE PRE-IDENTITY INCARNATION. A retirement archived before
      // incarnations existed carries no id.
      seat_id: 'seat_id' in parsed ? String(parsed['seat_id']) : '',
      retired_utc: 'retired_utc' in parsed ? String(parsed['retired_utc']) : '',
      directory: name,
      names: history.names,
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
    return 'This workspace has no seats yet. Create one with deskpost seat start <name> --project <project-slug>.';
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
  /**
   * WHERE THE BOOK IS (PLAN-basic-memory.md step 1). `collection` is the Library's own collection, which is what
   * no location has always meant. `shared` is the shared collection: on a workspace attached to Basic Memory that
   * IS its collection, and on a local Library it is the Basic Memory CONNECTION's `shared/` form -- or, with no
   * connection set up, the old spelling of `collection` it has always been. `undefined` is the collection.
   */
  location: 'shared' | 'shelf' | 'collection' | undefined;
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
  let bookPlace: BookPlace | null = null;
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
      const connected = local && markerConnection(workspace) !== null;
      const place =
        options.location === 'shelf' ? 'shelf' : options.location === 'shared' && (!local || connected) ? 'shared' : 'collection';
      const bookRoot = rootForPlace(place, options.shelf, options.slug, local);
      bookPlace = placeOfRoot(parseBookRoot(bookRoot)!, local);
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
        } else if (localCollection && place === 'collection') {
          // A LOCAL COLLECTION IS AS CHECKABLE AS THE SHELF, so a Book it does not hold is refused here
          // rather than opened and refused at every read. A `shared/` Book is the connection's, and like a
          // Basic Memory backend's it is validated by the reader at read time.
          const wikiRelative = splitBookRoot(bookRoot).wikiRoot;
          if (!fs.existsSync(path.join(localCollection.root, ...wikiRelative.split('/')))) {
            refuse(`No Book '${options.slug}' exists in this workspace's local collection at collection/${wikiRelative}.`);
          }
        }
        if (!openBooks.includes(bookRoot)) openBooks.push(bookRoot);
      } else if (options.location === undefined) {
        // NO --location CLOSES THE ONE OPEN BOOK OF THAT SLUG, WHEREVER IT IS OPEN (S85 row 4, ruling 4). It meant the
        // collection, so closing a Shelf Book without `--location shelf` closed nothing, exited 0, and left the seat
        // believing a Book was closed that was still readable. Two places is a question, so it refuses naming both.
        const matches = openBooks.filter((entry) => {
          const parts = parseBookRoot(entry);
          return parts !== null && parts.slug === options.slug && parts.shelf === options.shelf;
        });
        const archived = options.shelf === 'archive' ? 'archived ' : '';
        if (matches.length === 0) {
          refuse(`No ${archived}Book '${options.slug}' is open on this seat's Desk, so there is nothing to close. Nothing was changed.`);
        }
        if (matches.length > 1) {
          const places = matches.map((entry) => placeOfRoot(parseBookRoot(entry)!, local));
          refuse(
            `${archived ? 'Archived ' : ''}Book '${options.slug}' is open in ${matches.length} places on this seat's Desk: ${places.join(', ')}. ` +
              `Close one with --location ${places.join(' or --location ')}. Nothing was changed.`,
          );
        }
        bookPlace = placeOfRoot(parseBookRoot(matches[0]!)!, local);
        openBooks = openBooks.filter((entry) => entry !== matches[0]);
      } else {
        // A `shared/` ENTRY CLOSES WHETHER OR NOT THE CONNECTION IS STILL THERE (S53 post-build inspection #2): after a
        // disconnect `--location shared` would otherwise mean `books/<slug>`, leaving the entry on the Desk for good --
        // and the rollback check's own close command a silent no-op.
        const sharedForm = local && options.location === 'shared' ? rootForPlace('shared', options.shelf, options.slug, true) : null;
        const kept = openBooks.filter((entry) => entry !== bookRoot && entry !== sharedForm);
        // A CLOSE THAT MATCHES NOTHING REFUSES (S85 row 4, ruling 4), with a non-zero exit, rather than reporting a close.
        if (kept.length === openBooks.length) {
          refuse(`Book '${options.slug}' is not open on this seat's Desk at --location ${options.location}, so there is nothing to close. Nothing was changed.`);
        }
        openBooks = kept;
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
    // THE PLACE THE BOOK IS, as the Desk overview names it (S65): on a local Library with no connection, `--location
    // shared` or none opens the Local collection's Book, and echoing the request said `shared` of it. On a workspace
    // attached to Basic Memory that place is `shared`, as the oracle says. `clear` names no Book and still echoes
    // `shared`, the oracle's default.
    location: options.kind === 'book' ? (bookPlace ?? options.location ?? 'shared') : null,
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

void getShelfBook;
void readDeskFileLines;
void assertNoMaintenanceBarrier;
export type { DeskKind };
