/**
 * `library migrate` -- the resumable migration from the shared Notebook to the seat-owned one.
 *
 * ADR-0029 and PLAN-public-release.md step 26 (S18). There is no PowerShell counterpart: the migration
 * exists only in the kernel, so its row is judged against a stated property rather than against an
 * oracle -- `tools/Test-NotebookMigration.ps1` builds every legacy state through the real legacy
 * writers and interrupts this verb at every step.
 *
 * EVERY LEGACY STATE IS ENUMERATED AND GIVEN A RECORDED DISPOSITION, and activation is refused until
 * none is unaccounted for:
 *
 *   owned by a live seat         -> that seat's root, automatically
 *   owned by a retired seat      -> set aside, automatically (the seat is gone; ADR-0016 gave its
 *                                   topics to a whole-tree reset, which ADR-0029 retires)
 *   owned by an unaccounted seat,
 *   declared shared, excluded,
 *   unmapped, a loose file       -> THE READER DECIDES: `--assign <item>=<seat>` or `--set-aside <item>`
 *                                   (the reader's ruling, S18). Unnamed is unaccounted.
 *   an ownership row whose topic
 *   is no longer on disk         -> dropped, recorded
 *   the shared master index      -> archived: it is derived, and each seat's is rendered fresh
 *   the ownership record         -> archived, never deleted
 *   a reset quarantine           -> kept where it is; `library reset restore` reads its journal
 *
 * "Set aside" is a quarantine directory, `internal/notebook-reset-quarantine/migration-<stamp>/`,
 * journalled like a reset's, so `library reset restore --adopt` brings any of it back into any seat.
 *
 * CONSEQUENTIAL, SO GATED. A preflight lists every item and its disposition and issues a `plan_id`
 * binding all of them; the apply re-enumerates under the registry lock and refuses unless the digest
 * matches. It refuses while any seat other than the caller's has a live session, because a seat's
 * Notebook cannot be moved out from under a session that is writing it.
 *
 * RESUMABLE, BECAUSE IT IS A SEQUENCE OF MOVES. Every step is written into
 * `internal/notebook-migration/journal.json` BEFORE the first one runs, and each is marked done after
 * it runs. Each step is idempotent against the disk: a move whose source is gone and whose destination
 * is present has already happened, whichever side of the journal write the process died on. While the
 * journal is neither complete nor rolled back, EVERY Notebook verb refuses (the reader's ruling, S18).
 * `--resume` finishes it; `--rollback` walks it backwards and puts the shared layout back.
 *
 * STAGED FIRST, PLACED SECOND. A legacy topic may be named like the seat that receives material, so
 * nothing lands in `notebook/<seat>/` until every legacy entry has left `notebook/` for the staging
 * directory. The layout record is written LAST: it is the activation.
 *
 * `--fault-after <step>` exists for the interruption fixtures and nothing else, as
 * `Export-CollectionToVault.ps1 -FaultAfterStage` does: `<step>` dies after the step's action and
 * before the journal records it; `<step>:recorded` dies after; `journal-created` dies before any step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { resolveSeatName } from './seatdesk.ts';
import { assertSeatClaimHeld, getSeatClaimState } from './seatclaim.ts';
import { readSeatRegistry, readSeatRetirementRecords, type SeatRegistryEntry } from './desk.ts';
import {
  invokeNotebookRender,
  masterIndexDrift,
  notebookQuarantineRoot,
  psSortCompare,
  readNotebookTopicOwners,
  readStrictUtf8,
  seatIncarnationStatus,
  topicHeading,
  type OwnerRow,
} from './notebook.ts';
import {
  isEmptyIndexFile,
  migrationJournalPath,
  NOTEBOOK_LAYOUT_RECORD,
  NOTEBOOK_MIGRATION_ROOT,
  notebookLayoutRecordPath,
  readNotebookLayout,
  SEAT_INDEX_NAME,
  seatNotebookRelative,
  writeNotebookLayoutRecord,
  type NotebookScope,
} from './notebooklayout.ts';

export interface MigrateResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

const LIBRARY_OUTPUT_SCHEMA = 1;
const OPERATION = 'Migrate the Notebook to the seat-owned layout (ADR-0029)';
const STAGING = `${NOTEBOOK_MIGRATION_ROOT}/staging`;
const LEGACY = `${NOTEBOOK_MIGRATION_ROOT}/legacy`;
const OWNERS_RECORD = 'internal/notebook-topic-owners.json';
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

type ItemKind = 'topic' | 'loose-file' | 'master-index' | 'stale-row' | 'owners-record' | 'quarantine';
type ItemState =
  | 'owned'
  | 'owned-retired'
  | 'owned-unaccounted'
  | 'shared'
  | 'excluded'
  | 'unmapped'
  | 'loose'
  | 'derived'
  | 'stale-row'
  | 'record'
  | 'quarantine';

interface LegacyItem {
  item: string;
  kind: ItemKind;
  state: ItemState;
  legacy_owner: string | null;
  legacy_seat_id: string;
  /** `seat`, `set-aside`, `archive`, `drop`, `keep`, or '' while the reader has not decided. */
  disposition: string;
  /** The seat a `seat` disposition names. */
  seat: string | null;
  destination: string;
  decided_by: 'automatic' | 'reader' | '';
  note: string;
}

interface Step {
  id: string;
  action: 'move' | 'set-aside-journal' | 'render' | 'activate';
  from?: string;
  to?: string;
  seat?: string;
  done: boolean;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function utcRoundTripNow(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

function utcDirectoryStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function abs(workspace: string, relative: string): string {
  return path.join(workspace, ...relative.split('/'));
}

function has(row: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, name);
}

// --- The enumeration ------------------------------------------------------------------------------

/** `name=seat,name=seat` into a map, refusing anything ambiguous rather than guessing. */
function parseAssignments(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of value.split(',').map((item) => item.trim()).filter((item) => item)) {
    const at = pair.lastIndexOf('=');
    if (at <= 0 || at === pair.length - 1) throw new Error(`--assign takes <item>=<seat>; '${pair}' is not that.`);
    const name = pair.substring(0, at).trim();
    const seat = pair.substring(at + 1).trim();
    if (map.has(name)) throw new Error(`--assign names '${name}' twice.`);
    map.set(name, seat);
  }
  return map;
}

function parseList(value: string): Set<string> {
  const names = value.split(',').map((item) => item.trim()).filter((item) => item);
  const set = new Set(names);
  if (set.size !== names.length) throw new Error('--set-aside names the same item twice.');
  return set;
}

interface Enumeration {
  items: LegacyItem[];
  refusals: string[];
  seatsReceiving: string[];
  setAside: LegacyItem[];
}

/**
 * Every legacy thing on disk, with its disposition. A READ: it moves nothing and takes no lock of its
 * own, and the caller holds the registry lock when the answer is about to be acted on.
 */
function enumerateLegacy(workspace: string, assign: Map<string, string>, setAsideNames: Set<string>, setAsideName: string): Enumeration {
  const stateDirectory = path.join(workspace, '.claude');
  const registry = readSeatRegistry(stateDirectory);
  const retirements = readSeatRetirementRecords(workspace).records;
  const owners = readNotebookTopicOwners(workspace);
  const ownerOf = (topic: string): OwnerRow | null => owners.topics.find((entry) => String(entry['topic']) === topic) ?? null;
  const items: LegacyItem[] = [];
  const refusals: string[] = [];
  const notebook = path.join(workspace, 'notebook');
  const onDisk = new Set<string>();

  for (const [name, seat] of assign) {
    if (setAsideNames.has(name)) refusals.push(`'${name}' is both assigned to seat '${seat}' and set aside; name it once.`);
    if (!registry.some((entry) => entry.seat === seat)) {
      refusals.push(`'${name}' is assigned to seat '${seat}', which is not registered. Seats that exist: ${registry.map((entry) => entry.seat).join(', ') || '(none)'}.`);
    }
  }

  const decide = (item: LegacyItem, automatic: { disposition: string; seat: string | null } | null): void => {
    const assigned = assign.get(item.item);
    if (assigned !== undefined) {
      item.disposition = 'seat';
      item.seat = assigned;
      item.decided_by = 'reader';
    } else if (setAsideNames.has(item.item)) {
      item.disposition = 'set-aside';
      item.decided_by = 'reader';
    } else if (automatic !== null) {
      item.disposition = automatic.disposition;
      item.seat = automatic.seat;
      item.decided_by = 'automatic';
    }
    if (item.disposition === 'seat') item.destination = `${seatNotebookRelative(item.seat!)}/${item.item}`;
    else if (item.disposition === 'set-aside') item.destination = `internal/notebook-reset-quarantine/${setAsideName}/${item.item}`;
  };

  if (fs.existsSync(notebook)) {
    for (const entry of fs.readdirSync(notebook, { withFileTypes: true }).sort((left, right) => psSortCompare(left.name, right.name))) {
      onDisk.add(entry.name);
      if (entry.isSymbolicLink()) {
        refusals.push(`notebook/${entry.name} is a reparse point; the migration refuses to move material that lives outside the workspace.`);
        continue;
      }
      if (entry.isFile() && entry.name === SEAT_INDEX_NAME) {
        const drift = masterIndexDrift(workspace);
        items.push({
          item: SEAT_INDEX_NAME,
          kind: 'master-index',
          state: 'derived',
          legacy_owner: null,
          legacy_seat_id: '',
          disposition: 'archive',
          seat: null,
          destination: `${LEGACY}/${SEAT_INDEX_NAME}`,
          decided_by: 'automatic',
          note: isEmptyIndexFile(path.join(notebook, entry.name))
            ? 'the empty shared index; each seat that receives material gets its own, rendered fresh'
            : drift.length
              ? `the shared index, archived as it was -- including drift it carried: ${drift.join('; ')}`
              : 'the shared index, archived as it was; each seat that receives material gets its own, rendered fresh',
        });
        continue;
      }
      if (entry.isFile()) {
        const item: LegacyItem = {
          item: entry.name,
          kind: 'loose-file',
          state: 'loose',
          legacy_owner: null,
          legacy_seat_id: '',
          disposition: '',
          seat: null,
          destination: '',
          decided_by: '',
          note: 'a file directly under notebook/, which belongs to no topic and so to no seat',
        };
        decide(item, null);
        items.push(item);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const row = ownerOf(entry.name);
      const item: LegacyItem = {
        item: entry.name,
        kind: 'topic',
        state: 'unmapped',
        legacy_owner: null,
        legacy_seat_id: '',
        disposition: '',
        seat: null,
        destination: '',
        decided_by: '',
        note: 'no ownership row names this topic',
      };
      let automatic: { disposition: string; seat: string | null } | null = null;
      if (row !== null) {
        const scope = String(row['scope']);
        if (scope === 'shared' || scope === 'excluded') {
          item.state = scope;
          item.note =
            scope === 'shared'
              ? 'declared shared: ADR-0029 has no shared Notebook, so it needs one seat, or setting aside (the Shelf is the exit ramp for material two seats want)'
              : 'declared excluded from every reset: ADR-0029 has no cross-seat reset to exclude it from, so it needs one seat, or setting aside';
        } else {
          const seat = String(row['seat']);
          const seatId = has(row, 'seat_id') ? String(row['seat_id']) : '';
          item.legacy_owner = seat;
          item.legacy_seat_id = seatId;
          const status = seatIncarnationStatus(registry, retirements, seat, seatId);
          const which = seatId ? `incarnation ${seatId}` : 'the pre-identity incarnation';
          if (status === 'live') {
            item.state = 'owned';
            item.note = `owned by seat '${seat}' (${which}), which is registered`;
            automatic = { disposition: 'seat', seat };
          } else if (status === 'retired') {
            item.state = 'owned-retired';
            item.note = `owned by seat '${seat}' (${which}), which is retired; set aside, restorable into any seat with library reset restore --adopt`;
            automatic = { disposition: 'set-aside', seat: null };
          } else {
            item.state = 'owned-unaccounted';
            item.note = `owned by seat '${seat}' (${which}), which neither the registry nor any retirement record names`;
          }
        }
      }
      decide(item, automatic);
      if (item.disposition === 'seat') {
        try {
          topicHeading(path.join(notebook, entry.name, '_index.md'));
        } catch (error) {
          refusals.push(
            `notebook/${entry.name} cannot be rendered into seat '${item.seat}''s index (${(error as Error).message}). Repair its _index.md, or set it aside.`,
          );
        }
      }
      items.push(item);
    }
  }

  // Rows whose topic is gone: the record says something the disk does not.
  for (const row of owners.topics) {
    const topic = String(row['topic']);
    if (onDisk.has(topic)) continue;
    const scope = String(row['scope']);
    items.push({
      item: topic,
      kind: 'stale-row',
      state: 'stale-row',
      legacy_owner: scope === 'owned' ? String(row['seat']) : null,
      legacy_seat_id: scope === 'owned' && has(row, 'seat_id') ? String(row['seat_id']) : '',
      disposition: 'drop',
      seat: null,
      destination: '',
      decided_by: 'automatic',
      note: `an ownership row (${scope}${scope === 'owned' ? `, seat '${String(row['seat'])}'` : ''}) for a topic that is not on disk; dropped, and kept in the archived record`,
    });
  }

  if (fs.existsSync(abs(workspace, OWNERS_RECORD))) {
    items.push({
      item: 'notebook-topic-owners.json',
      kind: 'owners-record',
      state: 'record',
      legacy_owner: null,
      legacy_seat_id: '',
      disposition: 'archive',
      seat: null,
      destination: `${LEGACY}/notebook-topic-owners.json`,
      decided_by: 'automatic',
      note: `${owners.topics.length} ownership row(s). ADR-0029 retires the record; it is archived, never deleted`,
    });
  }

  const quarantineRoot = notebookQuarantineRoot(workspace);
  if (fs.existsSync(quarantineRoot)) {
    for (const entry of fs.readdirSync(quarantineRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((l, r) => psSortCompare(l.name, r.name))) {
      items.push({
        item: entry.name,
        kind: 'quarantine',
        state: 'quarantine',
        legacy_owner: null,
        legacy_seat_id: '',
        disposition: 'keep',
        seat: null,
        destination: `internal/notebook-reset-quarantine/${entry.name}`,
        decided_by: 'automatic',
        note: 'kept where it is: its reset journal records whose each topic was, and library reset restore returns it into a seat\'s own Notebook',
      });
    }
  }

  // A NAME THE READER GAVE THAT MATCHES NOTHING is a typo, and a typo in a disposition is refused.
  const decidable = new Set(items.filter((item) => item.kind === 'topic' || item.kind === 'loose-file').map((item) => item.item));
  for (const name of [...assign.keys(), ...setAsideNames]) {
    if (!decidable.has(name)) refusals.push(`'${name}' names no topic or loose file under notebook/, so there is nothing to give it a disposition.`);
  }

  const unaccounted = items.filter((item) => !item.disposition);
  if (unaccounted.length) {
    refusals.push(
      `activation is refused until every legacy item has a disposition, and ${unaccounted.length} do not: ` +
        unaccounted.map((item) => `${item.item} (${item.state})`).join(', ') +
        '. Give each one --assign <item>=<seat> or --set-aside <item>.',
    );
  }
  const seatsReceiving = [...new Set(items.filter((item) => item.disposition === 'seat').map((item) => item.seat!))].sort(psSortCompare);
  return { items, refusals, seatsReceiving, setAside: items.filter((item) => item.disposition === 'set-aside') };
}

function migrationPlanId(items: LegacyItem[]): string {
  const lines = [
    'action=migrate-notebook-to-seat-owned',
    ...items
      .map((item) => `item=${item.kind}:${item.item}:${item.state}:${item.legacy_owner ?? ''}:${item.legacy_seat_id}:${item.disposition}:${item.seat ?? ''}`)
      .sort(),
  ];
  return `migrate-notebook-${sha256Hex(lines.join('\n'))}`;
}

/** Every seat but the caller's must be free: a seat's Notebook is never moved under a live session. */
function claimRefusals(workspace: string, actingSeat: string | null, registry: SeatRegistryEntry[]): string[] {
  const stateDirectory = path.join(workspace, '.claude');
  const refusals: string[] = [];
  for (const entry of registry) {
    if (entry.seat === actingSeat) continue;
    const state = getSeatClaimState(stateDirectory, entry.seat).state;
    if (state !== 'free') {
      refusals.push(
        `seat '${entry.seat}' ${state === 'held' ? 'has a live session' : 'has a live agent whose claim holder was lost'}, and its Notebook is ` +
          'not moved out from under it. End that session first.',
      );
    }
  }
  return refusals;
}

// --- The journal and its steps --------------------------------------------------------------------

function readJournal(workspace: string): Record<string, unknown> {
  return JSON.parse(readStrictUtf8(migrationJournalPath(workspace))) as Record<string, unknown>;
}

function writeJournal(workspace: string, journal: Record<string, unknown>): void {
  fs.mkdirSync(abs(workspace, NOTEBOOK_MIGRATION_ROOT), { recursive: true });
  writeAtomicText(migrationJournalPath(workspace), psConvertToJson(journal as PsJsonValue) + '\n');
}

function planSteps(enumeration: Enumeration, setAsideName: string): Step[] {
  const steps: Step[] = [];
  for (const item of enumeration.items.filter((row) => row.kind === 'topic' || row.kind === 'loose-file')) {
    steps.push({ id: `stage:${item.item}`, action: 'move', from: `notebook/${item.item}`, to: `${STAGING}/${item.item}`, done: false });
  }
  for (const item of enumeration.items.filter((row) => row.kind === 'master-index')) {
    steps.push({ id: 'archive:master-index', action: 'move', from: `notebook/${SEAT_INDEX_NAME}`, to: item.destination, done: false });
  }
  for (const item of enumeration.items.filter((row) => row.kind === 'owners-record')) {
    steps.push({ id: 'archive:owners-record', action: 'move', from: OWNERS_RECORD, to: item.destination, done: false });
  }
  for (const item of enumeration.items.filter((row) => (row.kind === 'topic' || row.kind === 'loose-file') && (row.disposition === 'seat' || row.disposition === 'set-aside'))) {
    steps.push({ id: `place:${item.item}`, action: 'move', from: `${STAGING}/${item.item}`, to: item.destination, done: false });
  }
  if (enumeration.setAside.length) {
    steps.push({ id: 'set-aside-journal', action: 'set-aside-journal', to: `internal/notebook-reset-quarantine/${setAsideName}/reset-journal.json`, done: false });
  }
  for (const seat of enumeration.seatsReceiving) steps.push({ id: `render:${seat}`, action: 'render', seat, done: false });
  steps.push({ id: 'activate', action: 'activate', to: NOTEBOOK_LAYOUT_RECORD, done: false });
  return steps;
}

/** One move, idempotent against the disk: gone-here-and-present-there is a move that already happened. */
function moveIdempotent(workspace: string, from: string, to: string): void {
  const source = abs(workspace, from);
  const destination = abs(workspace, to);
  const sourceThere = fs.existsSync(source);
  const destinationThere = fs.existsSync(destination);
  if (sourceThere && destinationThere) {
    throw new Error(`both ${from} and ${to} exist, and the migration will not choose between them. Move one aside by hand, then resume.`);
  }
  if (!sourceThere && !destinationThere) {
    throw new Error(`neither ${from} nor ${to} exists, so the item this step moves is lost to the migration. Nothing further was moved.`);
  }
  if (!sourceThere) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function seatScope(workspace: string, seat: string): NotebookScope {
  const relative = seatNotebookRelative(seat);
  return { workspace, layout: 'seat-owned', activates: false, seat, root: abs(workspace, relative), relative };
}

function runStep(workspace: string, step: Step, journal: Record<string, unknown>): void {
  switch (step.action) {
    case 'move':
      moveIdempotent(workspace, step.from!, step.to!);
      return;
    case 'set-aside-journal': {
      const items = (journal['items'] as LegacyItem[]).filter((item) => item.disposition === 'set-aside');
      const record = {
        operation: 'Notebook migration set-aside',
        seat: '',
        whole_tree: false,
        all_idle_seats: false,
        clear_desk: false,
        plan_id: String(journal['plan_id']),
        quarantined_utc: String(journal['started_utc']),
        moves: [] as PsJsonValue[],
        targets: items.filter((item) => item.kind === 'topic').map((item) => ({ topic: item.item, seat: item.legacy_owner ?? '', seat_id: item.legacy_seat_id })),
        loose_files: items.filter((item) => item.kind === 'loose-file').map((item) => item.item),
      };
      writeAtomicText(abs(workspace, step.to!), psConvertToJson(record as unknown as PsJsonValue) + '\n');
      return;
    }
    case 'render':
      invokeNotebookRender(seatScope(workspace, step.seat!));
      return;
    case 'activate':
      if (!fs.existsSync(notebookLayoutRecordPath(workspace))) writeNotebookLayoutRecord(workspace, 'migration', String(journal['plan_id']));
      return;
  }
}

function faultCheck(fault: string, step: Step, recorded: boolean): void {
  if (!fault) return;
  if (fault === (recorded ? `${step.id}:recorded` : step.id)) {
    throw new Error(`FAULT INJECTED after ${step.id}${recorded ? ' was recorded' : ', before the journal recorded it'} (a real run never reaches this).`);
  }
}

/** Run every step not yet done, in order, marking each as it lands. The resume and the apply are this. */
function drive(workspace: string, journal: Record<string, unknown>, fault: string): void {
  const steps = journal['steps'] as Step[];
  for (const step of steps) {
    if (step.done) continue;
    runStep(workspace, step, journal);
    faultCheck(fault, step, false);
    step.done = true;
    writeJournal(workspace, journal);
    faultCheck(fault, step, true);
  }
  const staging = abs(workspace, STAGING);
  if (fs.existsSync(staging) && fs.readdirSync(staging).length === 0) fs.rmdirSync(staging);
  journal['status'] = 'complete';
  journal['completed_utc'] = utcRoundTripNow();
  writeJournal(workspace, journal);
}

/** Walk the journal backwards, undoing whatever the disk shows happened -- recorded or not. */
function rollback(workspace: string, journal: Record<string, unknown>): string[] {
  const steps = journal['steps'] as Step[];
  const undone: string[] = [];
  for (const step of [...steps].reverse()) {
    switch (step.action) {
      case 'activate': {
        const record = notebookLayoutRecordPath(workspace);
        if (fs.existsSync(record)) {
          fs.rmSync(record);
          undone.push(step.id);
        }
        break;
      }
      case 'render': {
        const index = path.join(seatScope(workspace, step.seat!).root, SEAT_INDEX_NAME);
        if (fs.existsSync(index)) {
          fs.rmSync(index);
          undone.push(step.id);
        }
        break;
      }
      case 'set-aside-journal': {
        const file = abs(workspace, step.to!);
        if (fs.existsSync(file)) {
          fs.rmSync(file);
          undone.push(step.id);
        }
        break;
      }
      case 'move': {
        const source = abs(workspace, step.from!);
        const destination = abs(workspace, step.to!);
        // AN EMPTY DIRECTORY WHERE A LEGACY ITEM GOES BACK is a seat root this migration made and has
        // already emptied -- a topic named like its seat leaves exactly that -- never legacy material,
        // which always holds at least its index. It goes, so the topic can come home.
        if (fs.existsSync(destination) && fs.existsSync(source) && fs.statSync(source).isDirectory() && fs.readdirSync(source).length === 0) {
          fs.rmdirSync(source);
        }
        if (fs.existsSync(destination) && !fs.existsSync(source)) {
          fs.mkdirSync(path.dirname(source), { recursive: true });
          fs.renameSync(destination, source);
          undone.push(step.id);
        } else if (fs.existsSync(destination) && fs.existsSync(source)) {
          throw new Error(`Rollback stopped at ${step.id}: both ${step.from} and ${step.to} exist. Nothing further was moved; resolve that pair by hand and roll back again.`);
        }
        break;
      }
    }
    step.done = false;
  }
  // The directories the migration made, once empty: seat roots, the set-aside quarantine, staging.
  const created = [
    STAGING,
    ...((journal['seats_receiving'] as string[]) ?? []).map((seat) => seatNotebookRelative(seat)),
    ...(String(journal['set_aside_quarantine'] ?? '') ? [String(journal['set_aside_quarantine'])] : []),
  ];
  for (const relative of created) {
    const directory = abs(workspace, relative);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
  return undone;
}

// --- The verb ---------------------------------------------------------------------------------------

function publicItems(items: LegacyItem[]): PsJsonValue {
  return items as unknown as PsJsonValue;
}

function progress(journal: Record<string, unknown>): Record<string, PsJsonValue> {
  const steps = journal['steps'] as Step[];
  return {
    steps_total: steps.length,
    steps_done: steps.filter((step) => step.done).length,
    next_step: steps.find((step) => !step.done)?.id ?? '',
  };
}

function migrateVerb(workspace: string, argv: string[]): PsJsonValue {
  const parsed = parseArguments(argv, ['assign', 'set-aside', 'plan-id', 'seat', 'workspace', 'fault-after']);
  const preflight = parsed.flags.has('preflight');
  const resume = parsed.flags.has('resume');
  const rollingBack = parsed.flags.has('rollback');
  const approvedPlanId = parsed.options.get('plan-id') ?? '';
  const fault = parsed.options.get('fault-after') ?? '';
  const stateDirectory = path.join(workspace, '.claude');
  if ([preflight, resume, rollingBack, approvedPlanId !== ''].filter((flag) => flag).length > 1) {
    throw new Error('library migrate takes one of --preflight, --plan-id <id>, --resume or --rollback, never two.');
  }
  const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory });
  const actingSeat = seatState.status === 'named' ? seatState.seat! : null;
  const layout = readNotebookLayout(workspace);

  if (layout.state === 'seat-owned') {
    return {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: OPERATION,
      workspace,
      layout_state: 'seat-owned',
      status: 'already-seat-owned',
      activated_by: String(layout.record?.['activated_by'] ?? ''),
      migration_record: fs.existsSync(migrationJournalPath(workspace)) ? `${NOTEBOOK_MIGRATION_ROOT}/journal.json` : '',
      note: 'This workspace already keeps each seat\'s Notebook under notebook/<seat>/. There is nothing to migrate.',
      shared_library_write: false,
    };
  }

  // A RUN IN PROGRESS: report it, resume it, or roll it back. Nothing else.
  if (layout.state === 'migrating') {
    const journal = readJournal(workspace);
    if (!resume && !rollingBack) {
      return {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: OPERATION,
        workspace,
        layout_state: 'migrating',
        status: 'interrupted',
        plan_id: String(journal['plan_id']),
        ...progress(journal),
        items: journal['items'] as PsJsonValue,
        note: "A migration was interrupted. Every Notebook verb refuses until 'library migrate --resume' finishes it or 'library migrate --rollback' puts the shared layout back.",
        shared_library_write: false,
      };
    }
    const registryLock = enterSeatRegistryLock(workspace);
    try {
      const refusals = claimRefusals(workspace, actingSeat, readSeatRegistry(stateDirectory));
      if (refusals.length) throw new Error(`${resume ? 'Resume' : 'Rollback'} refused and nothing was moved: ${refusals.join(' ')}`);
      if (actingSeat) assertSeatClaimHeld({ workspace, stateDirectory, seat: actingSeat });
      if (resume) {
        const before = progress(journal);
        drive(workspace, journal, fault);
        return {
          schema: LIBRARY_OUTPUT_SCHEMA,
          operation: OPERATION,
          workspace,
          layout_state: 'seat-owned',
          status: 'complete',
          resumed_at: before['next_step']!,
          steps_resumed: Number(before['steps_total']) - Number(before['steps_done']),
          migration_record: `${NOTEBOOK_MIGRATION_ROOT}/journal.json`,
          layout_record: NOTEBOOK_LAYOUT_RECORD,
          shared_library_write: false,
        };
      }
      const undone = rollback(workspace, journal);
      journal['status'] = 'rolled-back';
      journal['rolled_back_utc'] = utcRoundTripNow();
      writeJournal(workspace, journal);
      // KEPT AS HISTORY under its own name, so the next migration starts a journal of its own.
      const history = abs(workspace, `${NOTEBOOK_MIGRATION_ROOT}/journal-rolled-back-${utcDirectoryStamp()}.json`);
      fs.renameSync(migrationJournalPath(workspace), history);
      return {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: OPERATION,
        workspace,
        layout_state: readNotebookLayout(workspace).state,
        status: 'rolled-back',
        steps_undone: undone,
        journal_kept: path.relative(workspace, history).replace(/\\/g, '/'),
        shared_library_write: false,
      };
    } finally {
      exitBookLock(registryLock);
    }
  }
  if (resume || rollingBack) {
    throw new Error(`There is no interrupted migration to ${resume ? 'resume' : 'roll back'}: this workspace's Notebook is ${layout.state}.`);
  }

  // A NEW MIGRATION: enumerate, plan, and -- with the exact plan -- run.
  const assign = parseAssignments(parsed.options.get('assign') ?? '');
  const setAsideNames = parseList(parsed.options.get('set-aside') ?? '');
  for (const seat of assign.values()) {
    if (!SLUG.test(seat)) throw new Error(`'${seat}' is not a seat slug.`);
  }
  const setAsideName = `migration-${utcDirectoryStamp()}`;
  const registry = readSeatRegistry(stateDirectory);
  const look = enumerateLegacy(workspace, assign, setAsideNames, setAsideName);
  const refusals = [...look.refusals, ...claimRefusals(workspace, actingSeat, registry)];
  const planId = refusals.length ? '' : migrationPlanId(look.items);
  const counts: Record<string, PsJsonValue> = {};
  for (const item of look.items) counts[item.state] = Number(counts[item.state] ?? 0) + 1;

  const result: Record<string, PsJsonValue> = {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: OPERATION,
    workspace,
    layout_state: layout.state,
    items: publicItems(look.items),
    counts,
    unaccounted: look.items.filter((item) => !item.disposition).map((item) => item.item),
    seats_receiving: look.seatsReceiving,
    set_aside: look.setAside.map((item) => item.item),
    set_aside_quarantine: look.setAside.length ? `internal/notebook-reset-quarantine/${setAsideName}` : '',
    refusals,
    activation: refusals.length ? 'refused' : 'ready',
    plan_id: planId,
    confirmation_required: refusals.length === 0,
    how_to_decide:
      '--assign <item>=<seat>[,<item>=<seat>...] gives a topic or loose file to one registered seat; --set-aside <item>[,...] moves it ' +
      'into a quarantine library reset restore --adopt can bring back into any seat. Pass the same choices to the preflight and to the run.',
    recoverable:
      'Nothing is deleted. Every move is journalled in internal/notebook-migration/journal.json before it runs; the ownership record and ' +
      "the shared index are archived under internal/notebook-migration/legacy/. 'library migrate --rollback' puts the shared layout back " +
      "from any point before completion, and 'library migrate --resume' finishes an interrupted run.",
    shared_library_write: false,
  };
  if (actingSeat) assertSeatClaimHeld({ workspace, stateDirectory, seat: actingSeat });
  if (preflight) return result;
  if (!approvedPlanId) throw new Error('Migration aborted and nothing was moved: review the preflight and rerun with its exact --plan-id.');

  const registryLock = enterSeatRegistryLock(workspace);
  try {
    // RE-ENUMERATED UNDER THE LOCK: a topic written, a seat retired or a session started since the
    // preview is a refusal rather than a silent inclusion.
    const current = enumerateLegacy(workspace, assign, setAsideNames, setAsideName);
    const currentRefusals = [...current.refusals, ...claimRefusals(workspace, actingSeat, readSeatRegistry(stateDirectory))];
    if (currentRefusals.length) throw new Error(`Migration aborted and nothing was moved: ${currentRefusals.join(' ')}`);
    if (migrationPlanId(current.items) !== approvedPlanId) {
      throw new Error(
        'Migration aborted and nothing was moved: the legacy items, their owners or their dispositions are not what that plan described. ' +
          'Rerun the preflight with the same choices and pass its exact plan_id.',
      );
    }
    const journal: Record<string, unknown> = {
      schema: 1,
      operation: OPERATION,
      adr: 'ADR-0029',
      status: 'in-progress',
      plan_id: approvedPlanId,
      started_utc: utcRoundTripNow(),
      acting_seat: actingSeat,
      items: current.items,
      seats_receiving: current.seatsReceiving,
      set_aside_quarantine: current.setAside.length ? `internal/notebook-reset-quarantine/${setAsideName}` : '',
      steps: planSteps(current, setAsideName),
    };
    // THE JOURNAL BEFORE THE FIRST MOVE, which is what makes every later instant resumable.
    writeJournal(workspace, journal);
    if (fault === 'journal-created') throw new Error('FAULT INJECTED after journal-created (a real run never reaches this).');
    drive(workspace, journal, fault);
    return {
      ...result,
      layout_state: 'seat-owned',
      status: 'complete',
      migration_record: `${NOTEBOOK_MIGRATION_ROOT}/journal.json`,
      layout_record: NOTEBOOK_LAYOUT_RECORD,
      steps_run: (journal['steps'] as Step[]).length,
    };
  } finally {
    exitBookLock(registryLock);
  }
}

export function runMigrateVerb(argv: string[], workspace: string): MigrateResult {
  try {
    return { refusal: null, value: migrateVerb(workspace, argv) };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
