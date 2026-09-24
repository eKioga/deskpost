/**
 * `library reset` and `library reset restore` -- the Library Reset and its inverse.
 *
 * Ported from `tools/Reset-LocalNotebook.ps1` and `tools/Restore-NotebookQuarantine.ps1` (S17), and
 * re-cut for ADR-0029 (S18): A RESET IS "RESET THIS SEAT'S NOTEBOOK" AND TOUCHES NOTHING ELSE. It MOVES
 * every topic and loose file under `notebook/<seat>/` into a stamped directory under
 * `internal/notebook-reset-quarantine/`, journals whose it was, and re-renders that seat's index.
 * Nothing is deleted; the purge is a separate operation this kernel does not carry.
 *
 * WHAT ADR-0029 RETIRED FROM HERE. There is no ownership record to classify against, so there is no
 * protected, foreign, retired, unaccounted or unmapped topic -- every topic in a seat's root is that
 * seat's by where it lives. `--whole-tree` and `--all-idle-seats` reached OTHER seats' material and are
 * refused by name: a retired seat's Notebook is archived with the seat, and an idle seat's is reset
 * from that seat. The result keeps the oracle's field names, each answering for this seat's root, so
 * the comparison stays as wide as it can be; `notebook-is-seat-owned` carries the difference.
 *
 * GATED LIKE EVERY DESTRUCTIVE OPERATION HERE. A preflight states what would move and issues a
 * `plan_id` binding the seat, its incarnation, every target and the loose files; the confirming run
 * re-selects under the registry lock and refuses unless the digest matches. `--plan-id` stands for
 * `-ApprovedPlanId <id> -UserConfirmed`, as it does for every gated kernel verb.
 *
 * THE CLAIM IS PROBED BEFORE THE PLAN IS ISSUED, not after it is approved: a plan for an operation
 * certain to fail is worse than no plan.
 *
 * THE LOCK ORDER IS THE TOTAL ONE, OUTERMOST FIRST: the registry lock around the whole apply, each
 * topic's lock in sorted order, then the seat's render lock around the moves and the index.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, enterSeatRegistryLock, exitBookLock, type BookLock } from './locks.ts';
import { deskFileEntries, deskFilePath, resolveSeatName } from './seatdesk.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import { readSeatRegistry, readSeatRetirementRecords } from './desk.ts';
import { triageInventory } from './triageinventory.ts';
import {
  assertSeatRegistered,
  invokeNotebookRender,
  moveTopicToQuarantine,
  notebookQuarantineInventory,
  notebookQuarantineRoot,
  notebookTopicLockRoot,
  psSortCompare,
  QUARANTINE_JOURNAL_NAMES,
  quarantineTopicArticles,
  restoreTopicFromQuarantine,
  seatIncarnationStatus,
  type QuarantineRow,
} from './notebook.ts';
import { notebookScope, prepareNotebookScopeForWrite, SEAT_INDEX_NAME, type NotebookScope } from './notebooklayout.ts';

export interface ResetResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** `[DateTime]::UtcNow.ToString('o')`: seven fractional digits and a Z. */
function utcRoundTripNow(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

/** `[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')`, the name a quarantine directory carries. */
function utcDirectoryStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function withRegistryLock<T>(workspace: string, body: () => T): T {
  const lock = enterSeatRegistryLock(workspace);
  try {
    return body();
  } finally {
    exitBookLock(lock);
  }
}

/** A seat's open Books or Projects as the reset reports them: the entries, or a word saying why there are none. */
function deskEntries(stateDirectory: string, seat: string, kind: 'books' | 'projects'): string[] {
  const file = deskFilePath(stateDirectory, seat, kind);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return ['(Virtual Desk not configured)'];
  const entries = deskFileEntries(file);
  return entries.length ? entries : ['(none)'];
}

/** Every item under notebook/, directories and files alike, hidden ones included: `Get-ChildItem -Force -Recurse`. */
function countItems(root: string): number {
  let count = 0;
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      count += 1;
      if (item.isDirectory()) walk(path.join(directory, item.name));
    }
  };
  walk(root);
  return count;
}

/**
 * The loose files directly under a seat's Notebook root, LISTED rather than discovered at commit. A file
 * named like a quarantine journal is not moved at all: the commit writes `reset-journal.json` beside the
 * moved files, so moving one of that name would overwrite a reader's file rather than quarantine it.
 */
function looseFiles(notebookRoot: string): { movable: string[]; reserved: string[] } {
  if (!fs.existsSync(notebookRoot)) return { movable: [], reserved: [] };
  const names = fs
    .readdirSync(notebookRoot, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name !== SEAT_INDEX_NAME)
    .map((item) => item.name)
    .sort(psSortCompare);
  return {
    movable: names.filter((name) => !QUARANTINE_JOURNAL_NAMES.includes(name)),
    reserved: names.filter((name) => QUARANTINE_JOURNAL_NAMES.includes(name)),
  };
}

/** The topics in a seat's Notebook root, sorted as `Sort-Object` sorts them. A reparse point is refused. */
function seatTopics(scope: NotebookScope): string[] {
  if (!fs.existsSync(scope.root)) return [];
  const names: string[] = [];
  for (const item of fs.readdirSync(scope.root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) {
      throw new Error(`${scope.relative}/${item.name} is a reparse point; a reset refuses to move material that lives outside the workspace.`);
    }
    if (item.isDirectory()) names.push(item.name);
  }
  return names.sort(psSortCompare);
}

interface SeatTarget {
  topic: string;
  seat: string;
  seat_id: string;
}

/**
 * THE PLAN DIGEST: everything the reader is approving and nothing that merely varies. The seat's
 * INCARNATION is bound with every topic, so an approval cannot execute against a seat that was retired
 * and recreated under the same name between the preview and the run.
 */
function resetPlanId(options: { seat: string; desk: boolean; targets: SeatTarget[]; loose: string[] }): string {
  const lines = [
    'action=reset-local-notebook',
    `seat=${options.seat}`,
    'whole_tree=false',
    'all_idle_seats=false',
    `clear_desk=${options.desk}`,
    ...options.targets.map((row) => `topic=${row.topic}:${row.seat}:${row.seat_id}`).sort(),
    ...options.loose.map((name) => `loose=${name}`),
  ];
  return `reset-local-notebook-${sha256Hex(lines.join('\n'))}`;
}

const COPY_ADVISORY_MESSAGE =
  'This advisory is based on local publication journals only. It does not verify NAS state and does not copy anything. Triage the Notebook first if anything in it should outlive this reset: the Holding Shelf counts above are material that already survives. In topics, only known_current_copy_count is proof -- pages_without_current_copy is the number to act on -- and known_books and known_projects are kept separate because a Book and a Project Hub are opened and read differently, not because one is safer. These rows describe the Notebook as it was read before any move; after a completed run, remaining_in_notebook is what is actually left.';

/** The sweep this kernel does not have, said in the place the oracle's result says it. */
const NO_SWEEP_MESSAGE =
  "Not requested. This reset takes only this seat's own topics. Under ADR-0029 there is no sweep: every seat's Notebook is its own, and an idle seat's is reset from that seat.";

function resetVerb(workspace: string, argv: string[]): PsJsonValue {
  const parsed = parseArguments(argv, ['seat', 'plan-id', 'workspace']);
  const clearDesk = parsed.flags.has('clear-desk');
  const preflight = parsed.flags.has('preflight');
  const approvedPlanId = parsed.options.get('plan-id') ?? '';
  const stateDirectory = path.join(workspace, '.claude');
  for (const retired of ['whole-tree', 'all-idle-seats']) {
    if (parsed.flags.has(retired)) {
      throw new Error(
        `Reset refused: --${retired} reaches other seats' Notebook material, and ADR-0029 makes a reset "reset this seat's Notebook" and ` +
          "nothing else. A retired seat's Notebook is archived with the seat; an idle seat's is reset from that seat.",
      );
    }
  }

  const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory });
  if (seatState.status !== 'named') throw new Error(seatState.message);
  const seat = seatState.seat!;
  const notebookPath = path.join(workspace, 'notebook');
  if (!fs.existsSync(notebookPath) || !fs.statSync(notebookPath).isDirectory()) {
    throw new Error(`Reset aborted: expected Notebook directory was not found at '${notebookPath}'.`);
  }
  const scope = notebookScope(workspace, seat, 'write', 'Reset');

  const itemCount = fs.existsSync(scope.root) ? countItems(scope.root) : 0;
  let libraryCopyAdvisory: PsJsonValue;
  try {
    const inventory = triageInventory(workspace, scope.relative);
    libraryCopyAdvisory = {
      page_count: inventory['page_count'] ?? null,
      known_current_copy_count: inventory['known_current_copy_count'] ?? null,
      known_copy_drifted_count: inventory['known_copy_drifted_count'] ?? null,
      legacy_copy_record_count: inventory['legacy_copy_record_count'] ?? null,
      no_known_copy_record_count: inventory['no_known_copy_record_count'] ?? null,
      topics: (Array.isArray(inventory['topics']) ? inventory['topics'] : []) as PsJsonValue,
      holding_pending_count: inventory['holding_pending_count'] ?? null,
      holding_note_count: inventory['holding_note_count'] ?? null,
      holding_survives_this_reset: true,
      message: COPY_ADVISORY_MESSAGE,
    };
  } catch (error) {
    libraryCopyAdvisory = { status: 'unavailable', message: `Could not calculate the local Library-copy advisory: ${(error as Error).message}` };
  }

  const select = (): SeatTarget[] => {
    const seatId = assertSeatRegistered(stateDirectory, seat).seatId;
    return seatTopics(scope).map((topic) => ({ topic, seat, seat_id: seatId }));
  };
  const targets = withRegistryLock(workspace, select);
  const looseScan = looseFiles(scope.root);
  const planId = resetPlanId({ seat, desk: clearDesk, targets, loose: looseScan.movable });

  const leftovers = looseScan.reserved.length;
  const predictedRemaining = {
    owned_by_this_seat: [] as PsJsonValue[],
    owned_by_other_seats: [] as PsJsonValue[],
    protected: [] as PsJsonValue[],
    owned_by_retired_seats: [] as PsJsonValue[],
    owned_by_unaccounted_seats: [] as PsJsonValue[],
    unmapped: [] as PsJsonValue[],
    loose_files_left: looseScan.reserved,
    protected_recoverability: [] as PsJsonValue[],
    notebook_will_be_empty: leftovers === 0,
    note:
      leftovers === 0
        ? `Nothing is predicted to survive this run: ${scope.relative}/ will hold its rebuilt _master-index.md and nothing else.`
        : `${leftovers} item(s) are predicted to survive this run, so ${scope.relative}/ will NOT be empty. Each row says which rule leaves it; protected_recoverability says whether a protected topic can be rebuilt if the reader decides to lift its declaration. Tell the reader this BEFORE taking their approval.`,
  };

  const result: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Reset local notebook',
    workspace,
    seat,
    target: scope.root,
    item_count: itemCount,
    confirmation_required: true,
    topics_to_quarantine: targets.map((row) => row.topic),
    topics_protected: [],
    topics_owned_by_other_seats: [],
    topics_owned_by_retired_seats: [],
    topics_owned_by_unaccounted_seats: [],
    topics_unmapped: [],
    predicted_remaining: predictedRemaining,
    sweep: { requested: false, seats_resolved: 0, claim_probes: 0, to_sweep: [], skipped: [], message: NO_SWEEP_MESSAGE },
    loose_files_to_quarantine: looseScan.movable,
    loose_files_left_reserved_name: looseScan.reserved,
    refusals: [],
    plan_id: planId,
    recoverable:
      'Topics are MOVED into internal/notebook-reset-quarantine/, never deleted. Bring them back with ' +
      'tools/Restore-NotebookQuarantine.ps1, or destroy them for good with tools/Remove-NotebookQuarantine.ps1 -- ' +
      'each is its own preflighted, approved operation.',
    open_books_advisory: deskEntries(stateDirectory, seat, 'books'),
    open_projects_advisory: deskEntries(stateDirectory, seat, 'projects'),
    library_copy_advisory: libraryCopyAdvisory,
    shared_library_write: false,
    desk_action: clearDesk
      ? 'cleared: this is the full Library Reset'
      : 'preserved: open Books and Project Hubs stay open. Pass -ClearDesk for the full Library Reset.',
    seat_scope: "this seat's own topics only. Every other seat's material is left where it is.",
    scope: clearDesk
      ? 'Only the named Notebook directory will be deleted and rebuilt, and the local Virtual Desk will be cleared. raw, output, docs, internal state, workspace configuration, and Basic Memory are excluded. No repository file is touched and no Git command is run, so a clean working tree is not evidence that this reset happened.'
      : 'Only the named Notebook directory will be deleted and rebuilt. The Virtual Desk is left exactly as it is, so every open Book and Project Hub stays open. raw, output, docs, internal state, workspace configuration, and Basic Memory are excluded. No repository file is touched and no Git command is run, so a clean working tree is not evidence that this reset happened.',
  };

  assertSeatClaimHeld({ workspace, stateDirectory, seat });
  if (preflight) return result;
  if (!approvedPlanId) throw new Error('Reset aborted: review the preflight and rerun with its exact --plan-id.');

  const topicLocks: BookLock[] = [];
  const registryLock = enterSeatRegistryLock(workspace);
  let quarantineDirectory = '';
  let moves: Record<string, PsJsonValue>[] = [];
  let looseMoved: string[] = [];
  let looseLeft: string[] = [];
  let applyLoose = looseScan;
  let masterTopicCount = 0;
  let remaining: string[] = [];
  try {
    // REVALIDATED UNDER THE LOCK, and the plan_id is what makes that mean something: a topic added
    // or a seat recreated since the preview becomes a refusal rather than a silent inclusion.
    const current = select();
    applyLoose = looseFiles(scope.root);
    const currentPlanId = resetPlanId({ seat, desk: clearDesk, targets: current, loose: applyLoose.movable });
    if (currentPlanId !== approvedPlanId) {
      throw new Error(
        `Reset aborted and nothing was moved: the seat, the scope switches, the topics selected, their owners, or the loose files under ${scope.relative}/ are not what that plan described. ` +
          'Rerun the current preflight and pass its exact plan_id as -ApprovedPlanId.',
      );
    }
    prepareNotebookScopeForWrite(scope, 'Reset');

    // Created only now, with the plan revalidated: a refused reset leaves no empty stamped directory.
    quarantineDirectory = path.join(notebookQuarantineRoot(workspace, true), `${seat}-${utcDirectoryStamp()}`);
    fs.mkdirSync(quarantineDirectory, { recursive: true });
    for (const topic of current.map((row) => row.topic).sort(psSortCompare)) {
      topicLocks.push(enterBookLock(workspace, notebookTopicLockRoot(topic, scope.relative)));
    }
    const render = invokeNotebookRender(scope, () => {
      const moved = current.map((row) => moveTopicToQuarantine({ scope, topic: row.topic, quarantineDirectory }));
      // EXACTLY THE APPROVED NAMES, not a fresh enumeration: a loose file that appeared since the
      // digest was revalidated is left and reported, because it is not what was approved.
      const movedLoose: string[] = [];
      for (const name of applyLoose.movable) {
        const loosePath = path.join(scope.root, name);
        if (!fs.existsSync(loosePath) || !fs.statSync(loosePath).isFile()) continue;
        fs.renameSync(loosePath, path.join(quarantineDirectory, name));
        movedLoose.push(name);
      }
      return { topics: moved, loose_moved: movedLoose, loose_unapproved: looseFiles(scope.root).movable };
    });
    moves = render.commit_result!.topics;
    looseMoved = render.commit_result!.loose_moved;
    looseLeft = render.commit_result!.loose_unapproved;
    masterTopicCount = render.topic_count;

    // The record of what moved, written BESIDE the material, so a restore needs nothing but this
    // directory. `targets` records whose each topic was -- this seat, this incarnation.
    const journal = {
      operation: 'Reset local notebook',
      seat,
      whole_tree: false,
      all_idle_seats: false,
      clear_desk: clearDesk,
      plan_id: approvedPlanId,
      quarantined_utc: utcRoundTripNow(),
      moves,
      targets: current.map((row) => ({ topic: row.topic, seat: row.seat, seat_id: row.seat_id })),
      loose_files: looseMoved,
    };
    writeAtomicText(path.join(quarantineDirectory, 'reset-journal.json'), psConvertToJson(journal as unknown as PsJsonValue) + '\n');

    remaining = seatTopics(scope);
    if (clearDesk) {
      for (const kind of ['books', 'projects'] as const) {
        const file = deskFilePath(stateDirectory, seat, kind);
        if (fs.existsSync(file)) writeAtomicText(file, '');
      }
    }
  } finally {
    for (const lock of topicLocks) exitBookLock(lock);
    exitBookLock(registryLock);
  }

  result['status'] = 'completed';
  result['rebuilt_files'] = ['_master-index.md'];
  result['quarantine_directory'] = quarantineDirectory;
  result['quarantined'] = moves.filter((row) => row['moved'] === true).map((row) => String(row['topic']));
  result['left_in_place'] = moves.filter((row) => row['moved'] !== true).map((row) => `${String(row['topic'])}: ${String(row['reason'])}`);
  result['loose_files_quarantined'] = looseMoved;
  result['loose_files_left_unapproved'] = looseLeft;
  result['loose_files_left_reserved_name'] = applyLoose.reserved;
  result['master_index_topic_count'] = masterTopicCount;
  result['remaining_in_notebook'] = {
    owned_by_this_seat: remaining,
    owned_by_other_seats: [],
    protected: [],
    owned_by_retired_seats: [],
    owned_by_unaccounted_seats: [],
    unmapped: [],
  };
  result['virtual_desk_cleared'] = clearDesk;
  result['open_books_after'] = deskEntries(stateDirectory, seat, 'books');
  result['open_projects_after'] = deskEntries(stateDirectory, seat, 'projects');
  result['basic_memory_write'] = false;
  return result;
}

// --- The restore -------------------------------------------------------------------------------------

interface Disposition {
  topic: string;
  action: string;
  reason: string;
  current_scope: string;
  current_seat: string;
  current_seat_id: string;
  current_status: string;
  recorded_seat: string;
  recorded_seat_id: string;
}

/** Said where the oracle says "the row already names this seat's current incarnation": there is no row now. */
export const RESTORE_KEEP_REASON = "the quarantine records it as this seat's current incarnation's, and a seat's own Notebook is the only record ADR-0029 keeps";

/**
 * What each quarantined topic's RECORDED owner means now, classified by (seat, incarnation) against the
 * registry and the retirement records: `keep`, `adopt`, or `blocked`. There is no ownership row to
 * consult (ADR-0029); the quarantine's own journal is the record. A topic recorded as ANOTHER LIVE
 * seat's is blocked outright and `--adopt` does not lift it: that seat restores its own.
 */
function restoreDispositions(scope: NotebookScope, actingSeat: string, quarantine: QuarantineRow, topics: string[], adopt: boolean): { seat_id: string; rows: Disposition[] } {
  const stateDirectory = path.join(scope.workspace, '.claude');
  const registry = readSeatRegistry(stateDirectory);
  const actingIncarnation = assertSeatRegistered(stateDirectory, actingSeat).seatId;
  const retirements = readSeatRetirementRecords(scope.workspace).records;
  const rows = topics.map((name): Disposition => {
    const recorded = quarantine.recorded_owners.find((row) => row.topic === name);
    const recordedSeat = recorded?.seat ?? '';
    const recordedIncarnation = recorded?.seat_id ?? '';
    const which = recordedIncarnation.trim() ? `incarnation ${recordedIncarnation}` : 'the pre-identity incarnation';
    let action: string;
    let reason: string;
    let status = '';
    let currentSeat = '';
    let currentIncarnation = '';
    let currentScope = '';
    if (fs.existsSync(path.join(scope.root, name))) {
      action = 'blocked';
      reason = `a topic of that name exists in ${scope.relative}/ again, and a restore never writes over newer material; move or merge it by hand`;
    } else if (recordedSeat.trim() && recordedSeat === actingSeat && recordedIncarnation === actingIncarnation) {
      action = 'keep';
      reason = RESTORE_KEEP_REASON;
      currentSeat = actingSeat;
      currentIncarnation = actingIncarnation;
      currentScope = 'owned';
    } else {
      status = recordedSeat.trim() ? seatIncarnationStatus(registry, retirements, recordedSeat, recordedIncarnation) : '';
      if (status === 'live') {
        action = 'blocked';
        reason = `the quarantine records ${name} as seat '${recordedSeat}''s (${which}), which is still registered. Restore it from that seat`;
      } else if (adopt) {
        action = 'adopt';
        reason = recordedSeat.trim()
          ? `the quarantine records it as seat '${recordedSeat}''s (${which}), which is ${status}; -Adopt takes it over`
          : 'nothing records who owned it; -Adopt takes it over';
      } else {
        action = 'blocked';
        reason = recordedSeat.trim()
          ? `the quarantine records ${name} as seat '${recordedSeat}''s (${which}), which is ${status} rather than this seat. Pass -Adopt to take it over`
          : `nothing records who owned ${name}, so restoring it here would be taking it over rather than getting it back. Pass -Adopt to do that deliberately`;
      }
    }
    return {
      topic: name,
      action,
      reason,
      current_scope: currentScope,
      current_seat: currentSeat,
      current_seat_id: currentIncarnation,
      current_status: status,
      recorded_seat: recordedSeat,
      recorded_seat_id: recordedIncarnation,
    };
  });
  return { seat_id: actingIncarnation, rows };
}

function restorePlanId(seat: string, seatId: string, quarantine: string, adopt: boolean, rows: Disposition[], loose: string[]): string {
  const lines = [
    'action=restore-notebook-quarantine',
    `seat=${seat}`,
    `seat_id=${seatId}`,
    `quarantine=${quarantine}`,
    `adopt=${adopt}`,
    ...rows.map((row) => `topic=${row.topic}:${row.current_seat}:${row.current_seat_id}:${row.action}`).sort(),
    ...[...loose].sort().map((name) => `loose=${name}`),
  ];
  return `restore-notebook-quarantine-${sha256Hex(lines.join('\n'))}`;
}

function unknownQuarantine(workspace: string, name: string): Error {
  const known = notebookQuarantineInventory(workspace).map((row) => row.name);
  const because = known.length ? `There are: ${known.join(', ')}.` : 'This workspace holds no quarantined material at all.';
  return new Error(`Restore aborted: internal/notebook-reset-quarantine/${name} does not exist. ${because}`);
}

function restoreVerb(workspace: string, argv: string[]): PsJsonValue {
  const parsed = parseArguments(argv, ['seat', 'plan-id', 'workspace', 'quarantine', 'topic']);
  const quarantineName = parsed.options.get('quarantine') ?? '';
  const topicFilter = (parsed.options.get('topic') ?? '').split(',').map((item) => item.trim()).filter((item) => item);
  const adopt = parsed.flags.has('adopt');
  const list = parsed.flags.has('list');
  const show = parsed.flags.has('show');
  const preflight = parsed.flags.has('preflight');
  const approvedPlanId = parsed.options.get('plan-id') ?? '';
  const stateDirectory = path.join(workspace, '.claude');
  const notebookPath = path.join(workspace, 'notebook');
  if (!fs.existsSync(notebookPath) || !fs.statSync(notebookPath).isDirectory()) {
    throw new Error(`Restore aborted: expected Notebook directory was not found at '${notebookPath}'.`);
  }

  // THE TWO READS NEED NO SEAT: a reader whose session lost its seat is exactly the reader asking what survived.
  if (list && show) {
    throw new Error(
      'Restore aborted: -List and -Show are two reads, not one. -List is the roster of every quarantine; ' +
        '-Quarantine <name> -Show names the articles in one of them.',
    );
  }
  if (list) {
    return {
      schema: 1,
      operation: 'List quarantined Notebook material',
      workspace,
      quarantine_root: path.join(workspace, 'internal/notebook-reset-quarantine'),
      quarantines: notebookQuarantineInventory(workspace).map((row) => ({
        name: row.name,
        quarantined_by: row.seat,
        quarantined_utc: row.quarantined_utc,
        stamped_utc: row.stamped_utc,
        stamp_source: row.stamp_source,
        age_days: row.age_days,
        whole_tree: row.whole_tree,
        all_idle_seats: row.all_idle_seats,
        journal: row.journal_status,
        topics: row.topics,
        article_count: quarantineTopicArticles(row.directory).reduce((total, topic) => total + topic.article_count, 0),
        loose_files: row.loose_files,
      })),
      show_route: 'tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine <name> -Show',
      shared_library_write: false,
    };
  }
  if (show) {
    if (preflight || approvedPlanId) {
      throw new Error('Restore aborted: -Show is a read and plans nothing. Run it on its own, then rerun with -Preflight to plan the restore it showed you.');
    }
    if (!quarantineName.trim()) {
      throw new Error('Restore aborted: name the quarantine to show with -Quarantine <name>. Run this helper with -List to see which ones there are.');
    }
    const shown = notebookQuarantineInventory(workspace, quarantineName);
    if (!shown.length) throw unknownQuarantine(workspace, quarantineName);
    const row = shown[0]!;
    const articles = quarantineTopicArticles(row.directory);
    return {
      schema: 1,
      operation: "Show one quarantine's contents",
      workspace,
      quarantine: row.name,
      directory: row.directory,
      quarantined_by: row.seat,
      quarantined_utc: row.quarantined_utc,
      stamped_utc: row.stamped_utc,
      stamp_source: row.stamp_source,
      age_days: row.age_days,
      whole_tree: row.whole_tree,
      all_idle_seats: row.all_idle_seats,
      journal: row.journal_status,
      journal_reason: row.journal_reason,
      topics: row.topics,
      topic_articles: articles as unknown as PsJsonValue,
      recorded_owners: row.recorded_owners as unknown as PsJsonValue,
      article_count: articles.reduce((total, topic) => total + topic.article_count, 0),
      loose_files: row.loose_files,
      scope:
        'Read-only: the names of the files in one quarantine directory. No page content was ' +
        'read, nothing was moved, and no lock was taken. `_index.md` is rendered from a topic ' +
        'rather than written into it, so it is counted in file_count and not named as an article.',
      restore_route: `tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine ${row.name} -Preflight`,
      shared_library_write: false,
    };
  }

  const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory });
  if (seatState.status !== 'named') throw new Error(seatState.message);
  const seat = seatState.seat!;
  if (!quarantineName.trim()) {
    throw new Error(
      'Restore aborted: name the quarantine to restore with -Quarantine <name>. Run this helper with -List to ' +
        'see what is there; a restore plans one stamped directory, because "restore my Notebook" is ambiguous the ' +
        'moment a second reset has run.',
    );
  }
  const scope = notebookScope(workspace, seat, 'write', 'Restore');
  const inventory = notebookQuarantineInventory(workspace, quarantineName);
  if (!inventory.length) throw unknownQuarantine(workspace, quarantineName);
  const quarantineRow = inventory[0]!;

  const held = quarantineRow.topics;
  const wholeQuarantine = topicFilter.length === 0;
  const selectedTopics = wholeQuarantine ? held : [...new Set(topicFilter)].sort(psSortCompare);
  const unknownTopics = selectedTopics.filter((name) => !held.includes(name));
  if (unknownTopics.length) {
    throw new Error(
      `Restore aborted: internal/notebook-reset-quarantine/${quarantineName} holds no topic named ` +
        `${unknownTopics.join(', ')}. It holds: ${held.length ? held.join(', ') : '(no topics)'}.`,
    );
  }
  let looseToRestore = wholeQuarantine ? quarantineRow.loose_files : [];
  const looseLeft = wholeQuarantine ? [] : quarantineRow.loose_files;
  const looseColliding = looseToRestore.filter((name) => fs.existsSync(path.join(scope.root, name)));
  looseToRestore = looseToRestore.filter((name) => !looseColliding.includes(name));

  const selection = withRegistryLock(workspace, () => restoreDispositions(scope, seat, quarantineRow, selectedTopics, adopt));
  const blocked = selection.rows.filter((row) => row.action === 'blocked');
  const movable = selection.rows.filter((row) => row.action !== 'blocked');
  const refusals = [
    ...blocked.map((row) => `${row.topic}: ${row.reason}.`),
    ...looseColliding.map((name) => `${name}: a file of that name is already directly under ${scope.relative}/, and a restore never writes over it.`),
  ];
  const planId = refusals.length ? '' : restorePlanId(seat, selection.seat_id, quarantineName, adopt, movable, looseToRestore);

  const result: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Restore quarantined Notebook material',
    workspace,
    seat,
    seat_id: selection.seat_id,
    quarantine: quarantineRow.name,
    quarantine_directory: quarantineRow.directory,
    quarantined_by_seat: quarantineRow.seat,
    quarantined_utc: quarantineRow.quarantined_utc,
    journal_status: quarantineRow.journal_status,
    journal_note: quarantineRow.journal_reason,
    scope: wholeQuarantine
      ? 'the whole quarantine: every topic it holds, and the loose files beside them'
      : 'only the named topics. Loose files travel with a whole-quarantine restore, so they are left where they are.',
    topics_to_restore: movable.map((row) => `${row.topic} (ownership: ${row.action} -- ${row.reason})`),
    topics_blocked: blocked.map((row) => `${row.topic}: ${row.reason}`),
    loose_files_to_restore: looseToRestore,
    loose_files_left: [...looseLeft, ...looseColliding].sort(psSortCompare),
    adopt,
    refusals,
    plan_id: planId,
    confirmation_required: refusals.length === 0,
    shared_library_write: false,
  };

  assertSeatClaimHeld({ workspace, stateDirectory, seat });
  if (preflight) return result;
  if (!approvedPlanId) throw new Error('Restore aborted: review the preflight and rerun with its exact --plan-id.');

  const topicLocks: BookLock[] = [];
  const registryLock = enterSeatRegistryLock(workspace);
  let moves: Record<string, PsJsonValue>[] = [];
  let looseMoved: string[] = [];
  let masterTopicCount = 0;
  const ownership: Record<string, PsJsonValue>[] = [];
  try {
    const current = restoreDispositions(scope, seat, notebookQuarantineInventory(workspace, quarantineName)[0]!, selectedTopics, adopt);
    const currentRows = current.rows.filter((row) => row.action !== 'blocked');
    const currentBlocked = current.rows.filter((row) => row.action === 'blocked');
    const currentLoose = looseToRestore.filter((name) => !fs.existsSync(path.join(scope.root, name)));
    const currentPlanId = restorePlanId(seat, current.seat_id, quarantineName, adopt, currentRows, currentLoose);
    if (currentPlanId !== approvedPlanId) {
      throw new Error(
        'Restore aborted and nothing was moved: the seat, the quarantine, the topics selected, their owners, their dispositions, or the loose files are not what that plan described. ' +
          'Rerun the current preflight and pass its exact plan_id as -ApprovedPlanId.',
      );
    }
    if (currentBlocked.length) {
      throw new Error('Restore aborted and nothing was moved: ' + currentBlocked.map((row) => `${row.topic}: ${row.reason}`).join('; '));
    }
    prepareNotebookScopeForWrite(scope, 'Restore');
    for (const name of currentRows.map((row) => row.topic).sort(psSortCompare)) {
      topicLocks.push(enterBookLock(workspace, notebookTopicLockRoot(name, scope.relative)));
    }
    const render = invokeNotebookRender(scope, () => {
      const moved = currentRows.map((row) => restoreTopicFromQuarantine({ scope, topic: row.topic, quarantineDirectory: quarantineRow.directory }));
      const movedLoose: string[] = [];
      for (const name of currentLoose) {
        const source = path.join(quarantineRow.directory, name);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
        const destination = path.join(scope.root, name);
        // NEVER OVER A FILE THAT APPEARED since the plan was revalidated: skipped and named instead.
        if (fs.existsSync(destination)) continue;
        fs.renameSync(source, destination);
        movedLoose.push(name);
      }
      return { topics: moved, loose_moved: movedLoose };
    });
    moves = render.commit_result!.topics;
    looseMoved = render.commit_result!.loose_moved;
    masterTopicCount = render.topic_count;

    // WHOSE EACH TOPIC IS NOW, said rather than written: under ADR-0029 the seat's root IS the record,
    // so a restored topic is this seat's by having landed in it, and nothing else is written.
    for (const row of currentRows) {
      const restored = moves.find((move) => String(move['topic']) === row.topic && move['restored'] === true);
      if (!restored) continue;
      ownership.push({ topic: row.topic, ownership: row.action === 'keep' ? 'kept' : row.action, seat, scope: 'owned' });
    }

    const journal = {
      operation: 'Restore quarantined Notebook material',
      seat,
      seat_id: current.seat_id,
      plan_id: approvedPlanId,
      adopt,
      restored_utc: utcRoundTripNow(),
      topics: moves,
      ownership,
      loose_files: looseMoved,
    };
    writeAtomicText(path.join(quarantineRow.directory, 'restore-journal.json'), psConvertToJson(journal as unknown as PsJsonValue) + '\n');
  } finally {
    for (const lock of topicLocks) exitBookLock(lock);
    exitBookLock(registryLock);
  }

  const remaining = notebookQuarantineInventory(workspace, quarantineName);
  result['status'] = 'completed';
  result['restored'] = moves.filter((row) => row['restored'] === true).map((row) => String(row['topic']));
  result['left_in_quarantine'] = moves.filter((row) => row['restored'] !== true).map((row) => `${String(row['topic'])}: ${String(row['reason'])}`);
  result['ownership_recorded'] = ownership.map((row) => `${String(row['topic'])}: ${String(row['ownership'])} (seat ${String(row['seat'])}, ${String(row['scope'])})`);
  result['loose_files_restored'] = looseMoved;
  result['master_index_topic_count'] = masterTopicCount;
  result['quarantine_topics_remaining'] = remaining.length ? remaining[0]!.topics : [];
  result['quarantine_loose_files_remaining'] = remaining.length ? remaining[0]!.loose_files : [];
  result['basic_memory_write'] = false;
  return result;
}

export function runResetVerb(argv: string[], workspace: string): ResetResult {
  try {
    if ((argv[0] ?? '') === 'restore') return { refusal: null, value: restoreVerb(workspace, argv.slice(1)) };
    if (argv[0] !== undefined && !argv[0].startsWith('--')) {
      return { refusal: `library reset has no action '${argv[0]}'. It has: restore, or no action at all for the reset itself.`, value: null };
    }
    return { refusal: null, value: resetVerb(workspace, argv) };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
