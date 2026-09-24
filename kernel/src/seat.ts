/**
 * `library seat` -- sit down at a seat, hold its claim, retire it. S14's second half.
 *
 * The PowerShell originals are `tools/Enter-LibrarySeat.ps1`, `tools/Invoke-SeatClaimHolder.ps1`,
 * `tools/Retire-Seat.ps1` and the binding, holder-attempt and conversation-record halves of
 * `tools/LibrarySeat.ps1`. What made this a half of its own rather than part of the Desk port is the
 * identity it rests on -- a pid AND the recorded start time of the process now at that pid -- which
 * Node does not expose and `procstart.ts` now reads.
 *
 * WHAT IS NOT HERE, STATED RATHER THAN THINNED:
 *
 *   `seat enter --create` VALIDATES AGAINST THE LOCAL COLLECTION ONLY (S30). Creating a seat checks its
 *   Project against the Active Project Catalog; a creation that skipped it is the divergence that once
 *   bound a seat to a Hub that did not exist. Until S30 the kernel had no catalog to read and refused
 *   by name. It reads the local collection's now, which is Tier 0 opening a Seat with no Basic Memory;
 *   a workspace attached to Basic Memory is still refused, naming the shared backend as unported.
 *   `seat start` (the launcher) and `seat status` are declared and refuse by name. Their rows are
 *   independent -- only a launched session can show the launcher -- and neither blocks S14's two.
 *
 * THE HOLDER IS THIS SAME PROGRAM, spawned detached as `seat hold`, because the verb that binds a seat
 * lives for a second and the agent it binds lives for hours. It holds the claim the kernel's way --
 * `.claim` share-everything and `.claim.lock` share-nothing -- which `seatclaim.ts` explains.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { utcRoundTrip } from './journal.ts';
import { parseArguments } from './argv.ts';
import { requireWorkspace } from './workspace.ts';
import { assertSeatRegistryLockHeld, enterSeatRegistryLock, exitBookLock, isSeatRegistryLockHeld } from './locks.ts';
import {
  deskFilePath,
  deskStateDirectory,
  readDeskFileLines,
  resolveSeatName,
  seatDirectoryNames,
  seatsDirectory,
  setDeskEntryForSeat,
} from './seatdesk.ts';
import { assertSeatRegistered, psSortCompare, readNotebookTopicOwners, seatIncarnationStatus } from './notebook.ts';
import { readSeatRegistry, readSeatRetirementRecords } from './desk.ts';
import { openCollection } from './collection.ts';
import { migratingRefusal, readNotebookLayout, seatNotebookRelative } from './notebooklayout.ts';
import {
  agentProcessIdentity,
  assertNoMaintenanceBarrier,
  enterSeatClaim,
  exitSeatClaim,
  getSeatClaimState,
  getSeatStateDecision,
  readSeatBinding,
  seatBindingForAgent,
  seatBindingPath,
  seatClaimField,
  testSeatAgentAlive,
  readSeatActivity,
  testSeatClaim,
  writeSeatActivity,
  type HeldClaim,
} from './seatclaim.ts';
import { currentAgentProcessId } from './procstart.ts';
import { isCompiled, programRoot } from './programroot.ts';

const LIBRARY_OUTPUT_SCHEMA = 1;

class SeatRefusal extends Error {}

function refuse(message: string): never {
  throw new SeatRefusal(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function seconds(from: number): number {
  return Date.now() + from * 1000;
}

// --- The holder attempt (ADR-0018, PLAN-seat-launch.md step 4) --------------------------------------
//
// A claim is an open handle, and the process that must hold it is not the process that decides to.
// The attempt id is what tells THIS verb's holder from one a previous, timed-out attempt left behind;
// its deadline is what makes every launch self-abandoning.

const HOLDER_ATTEMPT_STATES = ['pending', 'committed', 'abandoned'];

export function seatHolderAttemptPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'holder-attempt.json');
}

export function seatConversationsPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'conversations.json');
}

interface HolderAttempt {
  seat?: string;
  attempt_id: string;
  holder_pid?: number;
  started_utc?: string;
  deadline_utc: string;
  state: string;
}

/** LOCK-FREE ON PURPOSE -- the holder reads it while the verb holds the registry lock -- and fails closed. */
function readSeatHolderAttempt(stateDirectory: string, seat: string): HolderAttempt | null {
  const file = seatHolderAttemptPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return null;
  let parsed: HolderAttempt;
  try {
    parsed = JSON.parse(strictUtf8(file)) as HolderAttempt;
  } catch (error) {
    throw new Error(`The holder attempt at ${file} is not valid JSON: ${(error as Error).message}.`);
  }
  for (const required of ['attempt_id', 'state', 'deadline_utc']) {
    if (!(required in parsed)) throw new Error(`The holder attempt at ${file} has no '${required}' field.`);
  }
  if (!HOLDER_ATTEMPT_STATES.includes(String(parsed.state))) {
    throw new Error(
      `The holder attempt at ${file} has state '${String(parsed.state)}'; expected one of ${HOLDER_ATTEMPT_STATES.join(', ')}.`,
    );
  }
  return parsed;
}

function writeSeatHolderAttempt(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  attemptId: string;
  deadlineUtc: string;
  state: 'pending' | 'committed' | 'abandoned';
  holderPid?: number;
  startedUtc?: string;
}): string {
  assertSeatRegistryLockHeld(options.workspace, 'Writing a seat holder attempt');
  const record: Record<string, PsJsonValue> = {
    seat: options.seat,
    attempt_id: options.attemptId,
    holder_pid: options.holderPid ?? 0,
    started_utc: options.startedUtc ?? utcRoundTrip(),
    deadline_utc: options.deadlineUtc,
    state: options.state,
  };
  const file = seatHolderAttemptPath(options.stateDirectory, options.seat);
  writeAtomicText(file, psConvertToJson(record) + '\n');
  return file;
}

/** A LIVE handle is refused unless `force`: the record is the only instruction its holder is listening for. */
function removeSeatHolderAttempt(workspace: string, stateDirectory: string, seat: string, force = false): boolean {
  assertSeatRegistryLockHeld(workspace, 'Removing a seat holder attempt');
  const file = seatHolderAttemptPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return false;
  if (!force && testSeatClaim(stateDirectory, seat)) {
    throw new Error(
      `Seat '${seat}' has a LIVE claim handle, so its holder attempt is not removable: that record is the ` +
        'only thing telling the holder to let go. Mark the attempt abandoned and wait for the handle to close.',
    );
  }
  fs.unlinkSync(file);
  return true;
}

interface StartedAttempt {
  attemptId: string;
  holderPid: number;
  deadlineUtc: string;
  startedUtc: string;
}

/** The command that runs THIS program: the interpreter and script under Node, the binary alone when compiled. */
function selfCommand(): { file: string; args: string[] } {
  const script = process.argv[1] ?? '';
  const prefix = /\.(?:[cm]?[jt]s)$/i.test(script) ? [...process.execArgv, script] : [];
  return { file: process.execPath, args: prefix };
}

/**
 * Spawn a holder and wait for it to have the handle. THE CALLER MUST HOLD THE REGISTRY LOCK.
 *
 * THE RECORD IS WRITTEN BEFORE THE SPAWN, because a missing record means ABANDON to the holder. WHAT
 * COUNTS AS READY IS THE ATTEMPT ID in the claim file, never the handle alone: a live handle proves
 * somebody holds the seat, and only the id proves it is the holder this call started.
 */
async function startSeatClaimHolder(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  agentPid: number;
  agentStartUtc: string;
  deadlineSeconds: number;
}): Promise<StartedAttempt> {
  assertSeatRegistryLockHeld(options.workspace, 'Starting a seat claim holder');
  const attemptId = newId();
  const deadline = seconds(options.deadlineSeconds);
  const deadlineUtc = new Date(deadline).toISOString().replace('Z', '0000Z');
  const startedUtc = utcRoundTrip();
  const common = { workspace: options.workspace, stateDirectory: options.stateDirectory, seat: options.seat, attemptId, deadlineUtc, startedUtc };
  writeSeatHolderAttempt({ ...common, state: 'pending' });

  const self = selfCommand();
  let exited = false;
  let holder: ChildProcess;
  try {
    holder = spawn(
      self.file,
      [
        ...self.args,
        'seat',
        'hold',
        '--workspace',
        options.workspace,
        '--seat',
        options.seat,
        '--attempt-id',
        attemptId,
        '--agent-pid',
        String(options.agentPid),
        '--agent-start-utc',
        options.agentStartUtc,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
  } catch (error) {
    removeSeatHolderAttempt(options.workspace, options.stateDirectory, options.seat, true);
    throw new Error(`The claim holder could not be started, so a seat cannot be bound: ${(error as Error).message}`);
  }
  holder.on('exit', () => {
    exited = true;
  });
  holder.on('error', () => {
    exited = true;
  });
  holder.unref();
  const holderPid = holder.pid ?? 0;
  writeSeatHolderAttempt({ ...common, state: 'pending', holderPid });

  let ready = false;
  while (Date.now() < deadline) {
    if (testSeatClaim(options.stateDirectory, options.seat) && seatClaimField(options.stateDirectory, options.seat, 'attempt') === attemptId) {
      ready = true;
      break;
    }
    if (exited) break;
    await sleep(40);
  }

  if (!ready) {
    // THE ABORT, IN THIS ORDER: abandoned first -- the instruction a holder still starting up will
    // read -- then wait, bounded, for the handle, and remove the record only once it has closed.
    writeSeatHolderAttempt({ ...common, state: 'abandoned', holderPid });
    const freeBy = seconds(options.deadlineSeconds);
    while (Date.now() < freeBy && testSeatClaim(options.stateDirectory, options.seat)) await sleep(40);
    if (!testSeatClaim(options.stateDirectory, options.seat)) {
      removeSeatHolderAttempt(options.workspace, options.stateDirectory, options.seat);
    }
    throw new Error(
      `The claim holder for seat '${options.seat}' did not take the seat's handle within ${options.deadlineSeconds} second(s), so ` +
        'nothing was bound. The attempt is marked abandoned and the holder releases itself; try again, or start ' +
        `work at the seat from a terminal with tools/Start-LibrarySeat.ps1 -Seat ${options.seat}.`,
    );
  }
  return { attemptId, holderPid, deadlineUtc, startedUtc };
}

/**
 * Commit a readied attempt. THE BINDING COMMITS FIRST AND THE ATTEMPT SECOND: a verb that dies
 * between the two leaves a committed binding whose holder abandons itself at its deadline, which
 * reads `orphaned` and is repaired by the same agent's next enter. The reverse order leaves a held
 * handle over a binding nothing can recognise.
 */
function completeSeatClaimHolder(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  attempt: StartedAttempt;
  commitBinding?: { agentPid: number; agentStartUtc: string; sessionId: string; seatId: string };
}): void {
  assertSeatRegistryLockHeld(options.workspace, 'Committing a seat claim holder');
  if (options.commitBinding) {
    writeSeatBinding({
      workspace: options.workspace,
      stateDirectory: options.stateDirectory,
      seat: options.seat,
      ...options.commitBinding,
      state: 'committed',
    });
  } else {
    // RECOVERY WRITES NO BINDING, so it is the one commit point that would leave a pre-history seat
    // unmigrated without this.
    syncSeatConversationSeed(options.workspace, options.stateDirectory, options.seat);
  }
  writeSeatHolderAttempt({
    workspace: options.workspace,
    stateDirectory: options.stateDirectory,
    seat: options.seat,
    attemptId: options.attempt.attemptId,
    deadlineUtc: options.attempt.deadlineUtc,
    startedUtc: options.attempt.startedUtc,
    state: 'committed',
    holderPid: options.attempt.holderPid,
  });
}

// --- The binding's writer -------------------------------------------------------------------------

/**
 * Write a seat's binding. THE CALLER MUST HOLD THE REGISTRY LOCK. A committed binding whose agent is
 * alive is never overwritten by another agent -- that refusal is the whole protection, so it lives
 * here rather than at each call site. It also records the conversation, first, for the oracle's
 * reason: a crash between the two then costs one extra offer rather than a silent loss.
 */
function writeSeatBinding(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  agentPid: number;
  agentStartUtc: string;
  sessionId: string;
  seatId: string;
  state: 'pending' | 'committed';
}): void {
  assertSeatRegistryLockHeld(options.workspace, 'Writing a seat binding');
  const existing = readSeatBinding(options.stateDirectory, options.seat);
  if (existing && existing.state === 'committed') {
    const existingPid = Number(existing.agent_pid);
    if (testSeatAgentAlive(existingPid, existing.agent_start_utc ?? '') && existingPid !== options.agentPid) {
      throw new Error(
        `Seat '${options.seat}' is bound to agent process ${existingPid}, which is still running. A committed ` +
          'binding is never overwritten while its agent is alive: one agent process holds one seat for the life of ' +
          'that process. Work at another seat, or wait for that one to end.',
      );
    }
  }
  const startUtc = options.agentStartUtc.trim() ? options.agentStartUtc : String(agentProcessIdentity(options.agentPid) ?? '');
  // THE SEED RUNS AGAINST THE BINDING STILL ON DISK, pending writes included: the pending write is
  // the one that would otherwise destroy a pre-history seat's committed record.
  syncSeatConversationSeed(options.workspace, options.stateDirectory, options.seat);
  if (options.state === 'committed' && options.sessionId.trim()) {
    const plan = seatConversationDocument(options.stateDirectory, options.seat, options.sessionId, options.seatId, 'binding');
    saveSeatConversationDocument(options.workspace, options.stateDirectory, options.seat, plan.document);
  }
  const record: Record<string, PsJsonValue> = {
    seat: options.seat,
    seat_id: options.seatId,
    agent_pid: options.agentPid,
    agent_start_utc: startUtc,
    session_id: options.sessionId,
    bound_utc: utcRoundTrip(),
    state: options.state,
  };
  writeAtomicText(seatBindingPath(options.stateDirectory, options.seat), psConvertToJson(record) + '\n');
}

// --- conversations.json: a history, where the binding is one record ---------------------------------

const SEAT_CONVERSATIONS_SCHEMA = 1;

type ConversationRecord = Record<string, PsJsonValue>;

function readSeatConversations(stateDirectory: string, seat: string): ConversationRecord[] | null {
  const file = seatConversationsPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(strictUtf8(file)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `The seat conversation record at ${file} is not valid JSON: ${(error as Error).message}. Remove it to lose this seat's conversation history and keep working; nothing else reads it.`,
    );
  }
  for (const required of ['schema', 'conversations']) {
    if (!(required in parsed)) throw new Error(`The seat conversation record at ${file} has no '${required}' field.`);
  }
  if (Number(parsed['schema']) !== SEAT_CONVERSATIONS_SCHEMA) {
    throw new Error(
      `The seat conversation record at ${file} declares schema '${String(parsed['schema'])}'; this build writes ` +
        `schema ${SEAT_CONVERSATIONS_SCHEMA}. A newer Library wrote it -- update this checkout rather than overwriting it.`,
    );
  }
  const raw = parsed['conversations'];
  const entries = (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw]).filter(
    (entry) => entry !== null,
  ) as ConversationRecord[];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = String(entry['session_id'] ?? '');
    if (!id.trim()) throw new Error(`The seat conversation record at ${file} holds an entry with no 'session_id'.`);
    if (seen.has(id)) throw new Error(`The seat conversation record at ${file} names conversation '${id}' twice.`);
    seen.add(id);
  }
  return entries;
}

function saveSeatConversationDocument(workspace: string, stateDirectory: string, seat: string, document: Record<string, PsJsonValue>): void {
  assertSeatRegistryLockHeld(workspace, 'Writing a seat conversation record');
  writeAtomicText(seatConversationsPath(stateDirectory, seat), psConvertToJson(document) + '\n');
}

/** THE DAY-ONE MIGRATION: a seat with no history gets the one record its committed binding implies. */
function syncSeatConversationSeed(workspace: string, stateDirectory: string, seat: string): 'seeded' | 'present' | 'nothing' {
  if (fs.existsSync(seatConversationsPath(stateDirectory, seat))) return 'present';
  const binding = readSeatBinding(stateDirectory, seat);
  if (!binding) return 'nothing';
  const prior = binding.session_id ?? '';
  if (binding.state !== 'committed' || !prior.trim()) return 'nothing';
  const bound = binding.bound_utc ?? '';
  saveSeatConversationDocument(workspace, stateDirectory, seat, {
    schema: SEAT_CONVERSATIONS_SCHEMA,
    seat,
    conversations: [
      { session_id: prior, seat_id: binding.seat_id ?? '', source: 'binding', first_seen_utc: bound, last_seen_utc: bound },
    ],
  });
  return 'seeded';
}

/** The document this seat's record WOULD become with one conversation recorded. Pure. */
function seatConversationDocument(
  stateDirectory: string,
  seat: string,
  sessionId: string,
  seatId: string,
  source: 'binding' | 'launcher',
): { outcome: string; document: Record<string, PsJsonValue> } {
  const records = readSeatConversations(stateDirectory, seat) ?? [];
  const now = utcRoundTrip();
  let outcome = 'recorded';
  const merged: ConversationRecord[] = [];
  for (const entry of records) {
    if (String(entry['session_id']) !== sessionId) {
      merged.push(entry);
      continue;
    }
    outcome = 'updated';
    // `first_seen_utc` NEVER MOVES AND `last_seen_utc` ALWAYS DOES.
    const first = 'first_seen_utc' in entry && String(entry['first_seen_utc']).trim() ? String(entry['first_seen_utc']) : now;
    merged.push({ session_id: sessionId, seat_id: seatId, source, first_seen_utc: first, last_seen_utc: now });
  }
  if (outcome === 'recorded') merged.push({ session_id: sessionId, seat_id: seatId, source, first_seen_utc: now, last_seen_utc: now });
  // OLDEST FIRST ON DISK, so two runs that recorded the same conversations produce the same bytes.
  const ordered = [...merged].sort((left, right) => psSortCompare(String(left['last_seen_utc'] ?? ''), String(right['last_seen_utc'] ?? '')));
  return { outcome, document: { schema: SEAT_CONVERSATIONS_SCHEMA, seat, conversations: ordered } };
}

/**
 * `Update-SeatConversationRecord`: record which conversation is sitting at a seat this agent already
 * holds -- `recorded`, `already-recorded`, `no-conversation`, `not-this-agent` or `no-binding`.
 *
 * THE READ IS OUTSIDE THE LOCK AND THE WRITE IS INSIDE IT, and the lock is DETECTED, never declared
 * (S36, the oracle's shape): enter's no-op calls this inside its own registry-locked transaction, and
 * the Desk context hook calls it on every prompt from outside one, where the common case -- a binding
 * already naming this conversation -- must cost one read and never touch an ordered lock. Under the lock
 * the binding is re-read for WHO, deliberately not for which conversation.
 */
export function updateSeatConversationRecord(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  agentPid: number;
  sessionId: string;
  deadlineSeconds?: number;
}): string {
  if (!options.sessionId.trim()) return 'no-conversation';
  const isThisAgent = (binding: ReturnType<typeof readSeatBinding>): boolean =>
    binding !== null &&
    binding.state === 'committed' &&
    Number(binding.agent_pid) === options.agentPid &&
    testSeatAgentAlive(options.agentPid, binding.agent_start_utc ?? '');
  const binding = readSeatBinding(options.stateDirectory, options.seat);
  if (!binding) return 'no-binding';
  if (!isThisAgent(binding)) return 'not-this-agent';
  if ((binding.session_id ?? '') === options.sessionId) return 'already-recorded';
  const lock = isSeatRegistryLockHeld(options.workspace) ? null : enterSeatRegistryLock(options.workspace, Math.ceil(options.deadlineSeconds ?? 2));
  try {
    const current = readSeatBinding(options.stateDirectory, options.seat);
    if (!current) return 'no-binding';
    if (!isThisAgent(current)) return 'not-this-agent';
    writeSeatBinding({
      workspace: options.workspace,
      stateDirectory: options.stateDirectory,
      seat: options.seat,
      agentPid: options.agentPid,
      agentStartUtc: current.agent_start_utc ?? '',
      sessionId: options.sessionId,
      seatId: current.seat_id ?? '',
      state: 'committed',
    });
    return 'recorded';
  } finally {
    exitBookLock(lock);
  }
}

function strictUtf8(file: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/^﻿/, '');
}

// --- seat enter --create (S30): tools/SeatCreation.ps1's gate and Enter-LibrarySeat.ps1 -Create ---------

/** The records that stop a seat slug being used again: an owned Notebook row no incarnation accounts for. */
function seatSlugReuseBlockers(workspace: string, stateDirectory: string, seat: string): string[] {
  const registry = readSeatRegistry(stateDirectory);
  const retirements = readSeatRetirementRecords(workspace).records;
  const blockers: string[] = [];
  for (const row of readNotebookTopicOwners(workspace).topics) {
    if (String(row['scope']) !== 'owned' || String(row['seat']) !== seat) continue;
    const incarnation = typeof row['seat_id'] === 'string' ? row['seat_id'] : '';
    if (seatIncarnationStatus(registry, retirements, seat, incarnation) === 'retired') continue;
    const which = incarnation.trim() ? `incarnation ${incarnation}` : 'the pre-identity incarnation';
    blockers.push(
      `the Notebook ownership record assigns notebook/${String(row['topic'])} to '${seat}' (${which}), and no ` +
        'retirement record in internal/seat-archive/ says that incarnation is finished',
    );
  }
  return blockers;
}

/** Assert-NewSeatIsCreatable, rule for rule and sentence for sentence. The registry is read by the caller, under the lock. */
function assertNewSeatIsCreatable(options: {
  workspace: string;
  stateDirectory: string;
  rows: Record<string, PsJsonValue>[];
  seat: string;
  project: string;
  activeProjects: string[];
  seatOnly?: boolean;
}): void {
  const { seat, project } = options;
  if (options.rows.some((row) => String(row['seat']) === seat)) {
    refuse(
      `Seat '${seat}' already exists. Enter it with tools/Enter-LibrarySeat.ps1 -Seat ${seat}, or work at it from a ` +
        `terminal with tools/Start-LibrarySeat.ps1 -Seat ${seat}; creation is for a seat that does not exist yet.`,
    );
  }
  const blockers = seatSlugReuseBlockers(options.workspace, options.stateDirectory, seat);
  if (blockers.length) {
    refuse(
      `Seat name '${seat}' cannot be used yet: ${blockers.join('; ')}. Taking the name would strand that material ` +
        'for good -- the slug would belong to the new seat, so the old incarnation could never be retired and no ' +
        'reset would reach the topic again. Take it over with tools/Set-NotebookTopicOwner.ps1 -Topic <topic> -Seat ' +
        '<a seat that exists>, or declare it with -Scope shared, and then this name is free.',
    );
  }
  if (options.seatOnly) return;
  const listed = [...options.activeProjects].sort(psSortCompare).join(', ');
  if (!project.trim()) {
    refuse(
      `Seat '${seat}' does not exist yet, so it needs the Project it is for: -Project <project-slug>. A seat is ` +
        'bound to exactly one Project, which is what makes its Notebook and output namespaces unambiguous. ' +
        `Active Projects: ${listed}.`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) refuse(`Project slug '${project}' is malformed: lowercase letters, digits and hyphens only.`);
  if (!options.activeProjects.includes(project)) {
    refuse(
      `There is no active Project Hub '${project}', so a seat cannot be bound to it. Active Projects: ${listed}. ` +
        'Create the Hub first with library hub new, or name one of those.',
    );
  }
  const clash = options.rows.find((row) => String(row['project']) === project);
  if (clash) {
    refuse(
      `Project '${project}' is already bound to seat '${String(clash['seat'])}'. A project has at most one seat: ` +
        `work it there, or retire that seat first with tools/Retire-Seat.ps1 -Seat ${String(clash['seat'])}.`,
    );
  }
}

/** Get-SeatCreationPlanId: this seat, this Project, and the registry as it stands. The same bytes as PowerShell's. */
function seatCreationPlanId(rows: Record<string, PsJsonValue>[], seat: string, project: string): string {
  const lines = rows.map((row) => `${String(row['seat'])}=${String(row['project'])}`).sort(psSortCompare);
  const digest = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  return crypto.createHash('sha256').update(`${seat}|${project}|${digest}`, 'utf8').digest('hex').substring(0, 16);
}

/**
 * THE ACTIVE PROJECT CATALOG, OUTSIDE EVERY LOCK (D10), from the collection the workspace is attached
 * to. In Tier 0 that is the local collection, which is why this verb stopped refusing in S30: the
 * catalog it validates against is now one the kernel can read. An unreadable catalog is a refusal,
 * never a default -- the oracle's sentence, with the collection's own reason in it.
 */
function activeProjectSlugs(workspace: string): string[] {
  try {
    return openCollection(workspace).projectSlugs('active');
  } catch (error) {
    refuse(
      'The Active Project Catalog could not be read, so it cannot be confirmed that a Project Hub exists for ' +
        `this seat: ${(error as Error).message} Nothing was created. A seat bound to a Project that does ` +
        'not exist would namespace its Notebook and output under a name nothing else knows. Entering an EXISTING ' +
        'seat needs no network and is unaffected.',
    );
  }
}

async function seatCreate(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  project: string;
  planId: string;
  preflight: boolean;
  agentPid: number;
  agentStartUtc: string;
  sessionId: string;
  deadlineSeconds: number;
}): Promise<Record<string, PsJsonValue>> {
  const { workspace, stateDirectory, seat, project } = options;
  const registryFile = path.join(seatsDirectory(stateDirectory), '_registry.json');
  const activeProjects = activeProjectSlugs(workspace);

  if (options.preflight) {
    const lock = enterSeatRegistryLock(workspace, Math.ceil(options.deadlineSeconds));
    try {
      const rows = readRegistryRows(registryFile);
      // THE SEAT HALF FIRST, so the offer below is only made to a reader whose seat name is usable.
      assertNewSeatIsCreatable({ workspace, stateDirectory, rows, seat, project, activeProjects, seatOnly: true });
      if (!project.trim() || !activeProjects.includes(project)) {
        return {
          operation: 'Create a Library seat (preflight)',
          seat,
          project,
          plan_id: null,
          because: project.trim() ? `There is no active Project Hub '${project}'.` : 'A new seat is bound to exactly one Project, and none was named.',
          active_projects: activeProjects,
          taken_projects: rows.map((row) => String(row['project'])).sort(psSortCompare),
          next: 'Rerun with --project <slug> from active_projects, then confirm with the plan_id it issues.',
          confirmation_required: true,
          shared_library_write: false,
        };
      }
      assertNewSeatIsCreatable({ workspace, stateDirectory, rows, seat, project, activeProjects });
      return {
        operation: 'Create a Library seat (preflight)',
        seat,
        project,
        plan_id: seatCreationPlanId(rows, seat, project),
        desk_directory: path.join(seatsDirectory(stateDirectory), seat),
        desk_created_empty: true,
        project_hub_opened: `projects/${project}`,
        agent_pid: options.agentPid,
        session_id: options.sessionId,
        other_seats: rows.map((row) => String(row['seat'])).sort(psSortCompare),
        confirmation_required: true,
        note: 'The new seat opens its own Project Hub and nothing else. No other seat is touched, and no shared-collection write happens.',
        shared_library_write: false,
      };
    } finally {
      exitBookLock(lock);
    }
  }

  if (!options.planId.trim()) {
    refuse(
      'No seat was created: run with --create --preflight, show the reader the seat and the Project it would be ' +
        'bound to, and rerun with the exact --plan-id it issued after one clear yes.',
    );
  }
  if (!project.trim()) refuse('The confirmed run needs the same --project the preflight planned.');

  const lock = enterSeatRegistryLock(workspace, Math.ceil(options.deadlineSeconds));
  let attempt: StartedAttempt | null = null;
  let seatCreated = false;
  let registryWritten = false;
  try {
    // REVALIDATED UNDER THE LOCK, against the registry this transaction writes; the digest binds the
    // approval to the registry the reader saw.
    const rows = readRegistryRows(registryFile);
    assertNewSeatIsCreatable({ workspace, stateDirectory, rows, seat, project, activeProjects });
    if (options.planId !== seatCreationPlanId(rows, seat, project)) {
      refuse(
        'The seat was not created: that plan_id does not match this seat, this project and the registry as ' +
          'it stands now. Either the id is not the one the preflight issued, or the registry changed since ' +
          'it was. Rerun the preflight, show the reader what it says, and ask again.',
      );
    }

    const seatId = newId();
    // BOTH Desk files, always (New-SeatDirectory): every reader of the pair throws on a missing one.
    fs.mkdirSync(deskStateDirectory(stateDirectory, seat), { recursive: true });
    for (const kind of ['books', 'projects'] as const) {
      const file = deskFilePath(stateDirectory, seat, kind);
      if (!fs.existsSync(file)) writeAtomicText(file, '');
    }
    seatCreated = true;
    setDeskEntryForSeat({ workspace, stateDirectory, seat, kind: 'projects', entry: `projects/${project}`, action: 'Add' });

    writeSeatRegistry(stateDirectory, [...rows, { seat, project, created_utc: utcRoundTrip(), seat_id: seatId }]);
    registryWritten = true;

    const binding = { agentPid: options.agentPid, agentStartUtc: options.agentStartUtc, sessionId: options.sessionId, seatId };
    writeSeatBinding({ workspace, stateDirectory, seat, ...binding, state: 'pending' });
    attempt = await startSeatClaimHolder({
      workspace,
      stateDirectory,
      seat,
      agentPid: options.agentPid,
      agentStartUtc: options.agentStartUtc,
      deadlineSeconds: options.deadlineSeconds,
    });
    completeSeatClaimHolder({ workspace, stateDirectory, seat, attempt, commitBinding: binding });
    const committed = readSeatBinding(stateDirectory, seat);
    writeSeatActivity({ stateDirectory, seat, note: 'seat created and bound' });
    return {
      operation: 'Create a Library seat',
      seat,
      seat_id: seatId,
      project,
      desk_directory: deskStateDirectory(stateDirectory, seat),
      bound: true,
      binding_source: 'binding',
      agent_pid: options.agentPid,
      session_id: committed?.session_id ?? '',
      holder_pid: attempt.holderPid,
      shared_library_write: false,
    };
  } catch (error) {
    // THE ABORT, IN THE ORACLE'S ORDER: the handle first, and the seat removed only once it has closed.
    // A seat whose handle will not close is LEFT WHOLE AND REGISTERED rather than half-removed.
    if (attempt !== null) {
      writeSeatHolderAttempt({
        workspace,
        stateDirectory,
        seat,
        attemptId: attempt.attemptId,
        deadlineUtc: attempt.deadlineUtc,
        startedUtc: attempt.startedUtc,
        state: 'abandoned',
        holderPid: attempt.holderPid,
      });
      const freeBy = seconds(options.deadlineSeconds);
      while (Date.now() < freeBy && testSeatClaim(stateDirectory, seat)) await sleep(40);
    }
    if (testSeatClaim(stateDirectory, seat)) {
      throw new Error(
        `Seat '${seat}' was created but not bound, and its claim handle is still open, so it was LEFT IN ` +
          `PLACE rather than half-removed: ${(error as Error).message} The seat is registered and its Desk holds ` +
          `projects/${project}. Enter it with library seat enter ${seat} once that holder has gone, or retire it ` +
          `with library seat retire ${seat}.`,
      );
    }
    if (registryWritten) {
      writeSeatRegistry(stateDirectory, readRegistryRows(registryFile).filter((row) => String(row['seat']) !== seat));
    }
    if (seatCreated) fs.rmSync(deskStateDirectory(stateDirectory, seat), { recursive: true, force: true });
    throw error;
  } finally {
    exitBookLock(lock);
  }
}

// --- seat enter -------------------------------------------------------------------------------------

async function seatEnter(argv: string[]): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace', 'agent-pid', 'session-id', 'deadline-seconds', 'project', 'plan-id']);
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const stateDirectory = path.join(workspace, '.claude');
  const deadlineSeconds = Number(parsed.options.get('deadline-seconds') ?? '2');
  const sessionId = parsed.options.get('session-id') ?? '';

  // A CUTOVER STOPS THIS ROUTE BEFORE ANYTHING ELSE, a preflight included.
  assertNoMaintenanceBarrier(workspace, 'sitting down at a seat');

  // THE SEAT IS NAMED, ALWAYS: resolving it implicitly would make "enter a seat" mean "enter the seat
  // I am already at", which is the one thing this verb has no use for.
  const resolved = resolveSeatName({ seat: parsed.positional[0] ?? '', stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;

  // WHO IS ASKING, before any lock and any plan: a caller whose process cannot be identified has
  // nothing to bind.
  const explicitAgent = parsed.options.get('agent-pid');
  const agentPid = explicitAgent !== undefined ? Number(explicitAgent) : currentAgentProcessId();
  if (!Number.isInteger(agentPid) || agentPid <= 0) {
    refuse(
      'This process is not recognised as an agent tool child, so there is no agent process to bind a seat to. ' +
        'CLAUDE_PID is set in Claude Code tool and hook children and nowhere else. Run this from a tool call in the ' +
        `conversation that should hold the seat, or start work at a terminal with tools/Start-LibrarySeat.ps1 -Seat ${seat}.`,
    );
  }
  const agentStartUtc = agentProcessIdentity(agentPid);
  if (agentStartUtc === null) {
    refuse(
      `Agent process ${agentPid} is not running, so nothing may be bound to it. If this came from CLAUDE_PID, the ` +
        'value is stale; pass --agent-pid explicitly or start a new conversation.',
    );
  }

  if (parsed.flags.has('create')) {
    return await seatCreate({
      workspace,
      stateDirectory,
      seat,
      project: parsed.options.get('project') ?? '',
      planId: parsed.options.get('plan-id') ?? '',
      preflight: parsed.flags.has('preflight'),
      agentPid,
      agentStartUtc,
      sessionId,
      deadlineSeconds,
    });
  }
  if (parsed.flags.has('preflight')) {
    refuse(
      "Entering an EXISTING seat needs no preflight: it is entered on the reader's word, and it changes no " +
        'material -- the Desk is left exactly as it was. --preflight belongs to --create, which needs one confirmation ' +
        'of both slugs.',
    );
  }

  const lock = enterSeatRegistryLock(workspace, Math.ceil(deadlineSeconds));
  let result: Record<string, PsJsonValue>;
  let noOp = false;
  try {
    const entry = assertSeatRegistered(stateDirectory, seat);

    // ONE SEAT PER AGENT PROCESS FOR ITS LIFE (D11), checked before the matrix: "you are already
    // sitting somewhere else" is a different sentence from "somebody else has that seat".
    const boundElsewhere = seatBindingForAgent(stateDirectory, seatDirectoryNames(stateDirectory), agentPid);
    if (boundElsewhere && boundElsewhere.seat !== seat) {
      refuse(
        `This agent process is already bound to seat '${boundElsewhere.seat}', so it may not also take ` +
          `'${seat}'. One agent process holds one seat for the life of that process: a seat given away mid-session ` +
          'could have a queued write land at it afterwards. End this conversation and sit down at ' +
          `'${seat}' in a new one.`,
      );
    }

    const state = getSeatClaimState(stateDirectory, seat, agentPid);
    const decision = getSeatStateDecision('enter', state.state, state.thisAgent);
    if (decision === 'refuse') {
      if (state.state === 'orphaned') {
        refuse(
          `Seat '${seat}' is bound to agent process ${state.agentPid}, which is still running; its claim ` +
            'holder is gone, which is not the same as the seat being free. Re-bind it from that conversation, or ' +
            'work at another seat.',
        );
      }
      refuse(
        `Seat '${seat}' has a live session at agent process ${state.agentPid}. One live agent per seat: ` +
          'finish or close that one, or work at another seat.',
      );
    }

    if (decision === 'no-op') {
      // ALREADY BOUND, AND NOT AN ERROR -- and still the place the conversation is recorded.
      noOp = true;
      const conversationRecord = updateSeatConversationRecord({ workspace, stateDirectory, seat, agentPid, sessionId });
      result = {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: 'Enter a Library seat',
        seat,
        project: entry.project,
        bound: true,
        already_bound: true,
        conversation_record: conversationRecord,
        binding_source: 'binding',
        agent_pid: agentPid,
        session_id: conversationRecord === 'recorded' ? sessionId : state.sessionId,
        desk_directory: deskStateDirectory(stateDirectory, seat),
        desk_action: 'untouched',
        shared_library_write: false,
      };
    } else {
      const attempt = await startSeatClaimHolder({ workspace, stateDirectory, seat, agentPid, agentStartUtc, deadlineSeconds });
      if (decision === 'restore') {
        // RECOVERY WRITES ONLY AN ATTEMPT: the committed binding is the identity that made it safe.
        completeSeatClaimHolder({ workspace, stateDirectory, seat, attempt });
      } else {
        const binding = { agentPid, agentStartUtc, sessionId, seatId: entry.seatId };
        writeSeatBinding({ workspace, stateDirectory, seat, ...binding, state: 'pending' });
        completeSeatClaimHolder({ workspace, stateDirectory, seat, attempt, commitBinding: binding });
      }
      // THE CONVERSATION IS READ BACK OFF THE BINDING, never echoed from the argument: a recovery
      // passes none and must not report the seat as having lost its conversation.
      const committed = readSeatBinding(stateDirectory, seat);
      result = {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: 'Enter a Library seat',
        seat,
        project: entry.project,
        bound: true,
        already_bound: false,
        recovered_orphan: decision === 'restore',
        binding_source: 'binding',
        agent_pid: agentPid,
        session_id: committed?.session_id ?? '',
        holder_pid: attempt.holderPid,
        desk_directory: deskStateDirectory(stateDirectory, seat),
        // ADR-0010: entering a seat is not a reset and not a migration. What was open stays open.
        desk_action: 'untouched',
        shared_library_write: false,
      };
    }
  } finally {
    exitBookLock(lock);
  }
  // THE ORACLE WRITES THIS AFTER ITS LOCK AND ONLY ON THE BINDING PATH: its no-op `return`s from
  // inside the try, so the trailing activity write never runs there.
  if (!noOp) writeSeatActivity({ stateDirectory, seat, note: 'seat bound' });
  return result;
}

// --- seat hold: the holder, spawned by enter and never run by hand ----------------------------------

/**
 * Hold one seat's claim for exactly as long as its agent lives. Exit codes are the oracle's: 3 the
 * attempt is gone or not pending, 4 the agent is not the agent, 5 the handle was refused, 6 the
 * attempt was never committed, 7 the attempt record could not be read.
 *
 * IT TAKES NO LOCK, EVER: the verb that spawned it waits for it while holding the registry lock.
 */
async function seatHold(argv: string[]): Promise<number> {
  const parsed = parseArguments(argv, ['workspace', 'seat', 'attempt-id', 'agent-pid', 'agent-start-utc', 'poll-ms']);
  const workspace = parsed.options.get('workspace') ?? '';
  const stateDirectory = path.join(workspace, '.claude');
  const seat = parsed.options.get('seat') ?? '';
  const attemptId = parsed.options.get('attempt-id') ?? '';
  const agentPid = Number(parsed.options.get('agent-pid') ?? '0');
  const agentStartUtc = parsed.options.get('agent-start-utc') ?? '';
  const pollMs = Number(parsed.options.get('poll-ms') ?? '2000');
  if (resolveSeatName({ seat, stateDirectory }).status !== 'named') return 2;

  // --- 1. Is this attempt still wanted, and is the agent still the agent? Both BEFORE the handle.
  let attempt: HolderAttempt | null;
  try {
    attempt = readSeatHolderAttempt(stateDirectory, seat);
  } catch {
    return 7;
  }
  if (!attempt || attempt.attempt_id !== attemptId || attempt.state !== 'pending') return 3;
  if (!testSeatAgentAlive(agentPid, agentStartUtc, { fresh: true })) return 4;
  const deadline = Date.parse(attempt.deadline_utc);
  if (Number.isNaN(deadline)) return 3;

  // --- 2. The handle, taken and refused in one act.
  let claim: HeldClaim;
  try {
    claim = enterSeatClaim(stateDirectory, seat, attemptId);
  } catch {
    return 5;
  }
  try {
    // --- 3. Wait for the commit; abandon at the deadline.
    let committed = false;
    while (Date.now() < deadline) {
      let current: HolderAttempt | null;
      try {
        current = readSeatHolderAttempt(stateDirectory, seat);
      } catch {
        break;
      }
      if (!current || current.attempt_id !== attemptId || current.state === 'abandoned') break;
      if (current.state === 'committed') {
        committed = true;
        break;
      }
      await sleep(25);
    }
    if (!committed) return 6;

    // --- 4. Hold for exactly the agent's life.
    await waitForAgentExit(agentPid, agentStartUtc, pollMs);
    return 0;
  } finally {
    exitSeatClaim(claim);
  }
}

/**
 * Resolve when the agent is no longer the process the seat was bound to.
 *
 * ON WINDOWS ONE WAITING CHILD, NOT A POLL. A fresh start-time read there is a PowerShell spawn, and
 * polling that every two seconds for an hours-long session would spend a fifth of a core on a seat
 * nobody is touching. The child opens the agent ONCE, verifies its start time, and blocks in
 * `WaitForExit` -- and holding the process open is also what stops its pid being reused while we
 * wait, which a poll cannot promise. If the waiter itself dies, the seat is released: that reads
 * `orphaned`, which the same agent's next enter repairs, and is the safe direction.
 * Elsewhere the read is a file or a `ps`, and the oracle's poll is kept.
 */
async function waitForAgentExit(agentPid: number, agentStartUtc: string, pollMs: number): Promise<void> {
  if (process.platform === 'win32') {
    const expected = agentStartUtc.replace(/'/g, "''");
    const script =
      `$p = $null; try { $p = Get-Process -Id ${agentPid} -ErrorAction Stop } catch { exit 3 }; ` +
      `$s = $null; try { $s = $p.StartTime.ToUniversalTime().ToString('o') } catch { $s = 'unreadable' }; ` +
      `if ('${expected}'.Trim() -and $s -cne 'unreadable' -and $s -cne '${expected}') { exit 4 }; ` +
      `$p.WaitForExit(); exit 0`;
    await new Promise<void>((resolve) => {
      const waiter = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
      waiter.on('exit', () => resolve());
      waiter.on('error', () => resolve());
    });
    return;
  }
  while (testSeatAgentAlive(agentPid, agentStartUtc, { fresh: true })) await sleep(pollMs);
}

// --- seat start (S42) ---------------------------------------------------------------------------------

/**
 * `library seat start <name> [--project <slug>] [--command <agent>] [--no-launch] [--preflight] [-- <agent args>]`:
 * tools/Start-LibrarySeat.ps1 with a seat named. Create the seat if it is new -- bound to an ACTIVE Project,
 * as the launcher creates one, with no approval step, because the reader named both -- hold its claim in THIS
 * process, start the agent in the workspace with LIBRARY_SEAT, LIBRARY_SEAT_CLAIM and LIBRARY_WORKSPACE set,
 * and release the claim when the agent exits: the claim lasts exactly as long as the session.
 *
 * WHAT IS NOT PORTED, AND REFUSES BY NAME: the picker (no seat named), `-RestoreDeskFromArchive`,
 * `-RetireLegacyDesk`, and entering a workspace that still has a pre-seat Desk, which the launcher copies in.
 * No PowerShell oracle is compared: the row is judged in a real session (ADR-0037), and kernel self-test
 * section 24 holds the claim's life. `--no-launch` releases the claim as it exits, as the launcher's does.
 */
async function seatStart(argv: string[]): Promise<{ result: Record<string, PsJsonValue> | null; exitCode: number }> {
  const split = argv.indexOf('--');
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const agentArguments = split >= 0 ? argv.slice(split + 1) : [];
  const parsed = parseArguments(own, ['workspace', 'project', 'command', 'deadline-seconds', 'restore-desk-from-archive']);
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const stateDirectory = path.join(workspace, '.claude');
  const deadlineSeconds = Number(parsed.options.get('deadline-seconds') ?? '20');
  assertNoMaintenanceBarrier(workspace, 'starting a session at a seat');

  const name = parsed.positional[0] ?? '';
  if (!name.trim()) {
    refuse(
      'library seat start has no picker yet. Name the seat: library seat start <name>, or ' +
        'library seat start <name> --project <slug> to create one. library seat status lists the seats there are.',
    );
  }
  if (parsed.options.has('restore-desk-from-archive') || parsed.flags.has('retire-legacy-desk')) {
    refuse(
      "Restoring a retired seat's Desk and retiring a pre-seat Desk are not ported to the kernel yet; they are " +
        `tools/Start-LibrarySeat.ps1 -Seat ${name} -RestoreDeskFromArchive <archive> and -RetireLegacyDesk.`,
    );
  }
  const resolved = resolveSeatName({ seat: name, stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;
  const project = parsed.options.get('project') ?? '';
  const command = parsed.options.get('command') ?? 'claude';
  const noLaunch = parsed.flags.has('no-launch');
  const deskDirectory = deskStateDirectory(stateDirectory, seat);
  if (fs.existsSync(path.join(stateDirectory, '.open-books')) && !fs.existsSync(deskDirectory)) {
    refuse(
      `This workspace still keeps a pre-seat Desk in .claude/.open-books, which the kernel does not migrate yet. Start ` +
        `seat '${seat}' once with tools/Start-LibrarySeat.ps1 -Seat ${seat}, which copies it in.`,
    );
  }

  const registryFile = path.join(seatsDirectory(stateDirectory), '_registry.json');
  const lock = enterSeatRegistryLock(workspace, Math.ceil(deadlineSeconds));
  let claim: HeldClaim | null = null;
  let existing: Record<string, PsJsonValue> | null = null;
  let bound = '';
  let otherSeats: string[] = [];
  try {
    const rows = readRegistryRows(registryFile);
    existing = rows.find((row) => String(row['seat']) === seat) ?? null;
    otherSeats = rows.map((row) => String(row['seat'])).filter((other) => other !== seat);
    if (existing === null) {
      assertNewSeatIsCreatable({ workspace, stateDirectory, rows, seat, project, activeProjects: activeProjectSlugs(workspace) });
      bound = project;
    } else {
      bound = String(existing['project']);
      if (project.trim() && project !== bound) {
        refuse(
          `Seat '${seat}' is already bound to project '${bound}', not '${project}'. Rebinding a seat would orphan the ` +
            'Notebook topics it owns; create another seat for the other project.',
        );
      }
    }

    const claimState = getSeatClaimState(stateDirectory, seat);
    if (parsed.flags.has('preflight')) {
      if (claimState.state !== 'free') {
        const because =
          claimState.state === 'orphaned'
            ? `is bound to agent process ${claimState.agentPid}, which is still running even though its claim holder is gone`
            : 'already has a live session';
        refuse(
          `Seat '${seat}' ${because}, so starting one here would be refused and this preflight will not plan it. One ` +
            'session per seat: finish or close that one, or start work at another seat with tools/Start-LibrarySeat.ps1 -Seat <name>.',
        );
      }
      return {
        result: {
          operation: 'Start a Library seat (preflight)',
          seat,
          project: bound,
          seat_exists: existing !== null,
          desk_directory: deskDirectory,
          claim_live: false,
          desk_migration: [],
          legacy_desk_retired: false,
          other_seats: otherSeats,
          launch: noLaunch ? 'none' : command,
          shared_library_write: false,
        },
        exitCode: 0,
      };
    }
    if (claimState.state === 'orphaned' && getSeatStateDecision('enter', 'orphaned', claimState.thisAgent) === 'refuse') {
      refuse(
        `Seat '${seat}' is bound to agent process ${claimState.agentPid}, which is still running; its claim holder is gone, ` +
          'which is not the same as the seat being free. Re-bind it from that conversation, or start work at another ' +
          'seat with tools/Start-LibrarySeat.ps1 -Seat <name>.',
      );
    }
    claim = enterSeatClaim(stateDirectory, seat);
    if (existing === null) {
      // BOTH Desk files, always, and the seat's own Project Hub open on it, as seat creation does.
      fs.mkdirSync(deskDirectory, { recursive: true });
      for (const kind of ['books', 'projects'] as const) {
        const file = deskFilePath(stateDirectory, seat, kind);
        if (!fs.existsSync(file)) writeAtomicText(file, '');
      }
      setDeskEntryForSeat({ workspace, stateDirectory, seat, kind: 'projects', entry: `projects/${bound}`, action: 'Add' });
      writeSeatRegistry(stateDirectory, [...rows, { seat, project: bound, created_utc: utcRoundTrip(), seat_id: newId() }]);
    }
  } catch (error) {
    exitSeatClaim(claim);
    throw error;
  } finally {
    exitBookLock(lock);
  }

  try {
    writeSeatActivity({ stateDirectory, seat, note: 'seat entered', keepConversation: noLaunch });
    const binDirectory = isCompiled() ? path.dirname(process.execPath) : programRoot();
    const pathVariable = process.platform === 'win32' ? Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH' : 'PATH';
    const onPath = (process.env[pathVariable] ?? '').split(path.delimiter).some((entry) => entry.replace(/[\\/]+$/, '').toLowerCase() === binDirectory.replace(/[\\/]+$/, '').toLowerCase());
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      LIBRARY_SEAT: seat,
      LIBRARY_SEAT_CLAIM: claim!.token,
      LIBRARY_WORKSPACE: workspace,
      [pathVariable]: onPath ? process.env[pathVariable] : binDirectory + path.delimiter + (process.env[pathVariable] ?? ''),
    };
    const result: Record<string, PsJsonValue> = {
      operation: 'Start a Library seat',
      seat,
      project: bound,
      seat_created: existing === null,
      desk_directory: deskDirectory,
      desk_migrated: false,
      legacy_desk_retired: false,
      claim_held: true,
      environment: ['LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'LIBRARY_WORKSPACE', 'PATH'],
      workspace,
      picked: false,
      conversation: '',
      conversation_action: 'named',
      conversation_recorded: false,
      command_args: agentArguments,
      shared_library_write: false,
    };
    if (noLaunch) return { result, exitCode: 0 };
    process.stdout.write(psConvertToJson(result) + '\n');
    // THE AGENT, IN THE WORKSPACE, ON THIS TERMINAL -- and this process waits for it, because the claim is
    // this process's handle and must outlive nothing and be outlived by nothing.
    const exitCode = await new Promise<number>((resolve) => {
      const agent = spawn(command, agentArguments, { cwd: workspace, env: environment, stdio: 'inherit' });
      agent.on('exit', (code) => resolve(code ?? 1));
      agent.on('error', (error) => {
        process.stderr.write(`The agent '${command}' could not be started: ${error.message}\n`);
        resolve(127);
      });
    });
    return { result: null, exitCode };
  } finally {
    exitSeatClaim(claim);
  }
}

// --- seat status (S42) --------------------------------------------------------------------------------

/**
 * `library seat status [--seat <s>]`: every registered seat, its Project, whether a session holds it, and its
 * advisory last activity -- the roster a reader picks a seat from. Reads only, and needs no seat. The oracle's
 * nearest is Get-DeskOverview's seat lines; there is no differential row, and self-test section 24 reads it.
 */
function seatStatus(argv: string[]): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, ['workspace', 'seat']);
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const stateDirectory = path.join(workspace, '.claude');
  const rows = readRegistryRows(path.join(seatsDirectory(stateDirectory), '_registry.json'));
  const named = resolveSeatName({ seat: parsed.options.get('seat') ?? '', stateDirectory });
  const seats = rows
    .map((row) => String(row['seat']))
    .sort(psSortCompare)
    .map((seat) => {
      const row = rows.find((candidate) => String(candidate['seat']) === seat)!;
      const state = getSeatClaimState(stateDirectory, seat);
      const activity = readSeatActivity(stateDirectory, seat);
      return {
        seat,
        project: String(row['project'] ?? ''),
        claim: state.state,
        agent_pid: state.state === 'free' ? null : state.agentPid || null,
        last_seen_utc: activity && typeof activity['last_seen_utc'] === 'string' ? activity['last_seen_utc'] : null,
        this_seat: named.status === 'named' && named.seat === seat,
      } as Record<string, PsJsonValue>;
    });
  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Library seat status',
    workspace,
    seat: named.status === 'named' ? named.seat! : null,
    seats,
    advisory: 'Whether a seat is held is its claim; last_seen_utc is advice only.',
    shared_library_write: false,
  };
}

// --- seat retire ------------------------------------------------------------------------------------

function seatRetire(argv: string[]): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, ['workspace', 'plan-id']);
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const stateDirectory = path.join(workspace, '.claude');
  const resolved = resolveSeatName({ seat: parsed.positional[0] ?? '', stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;
  const approvedPlanId = parsed.options.get('plan-id') ?? '';

  const lock = enterSeatRegistryLock(workspace);
  try {
    const registryFile = path.join(seatsDirectory(stateDirectory), '_registry.json');
    const entry = assertSeatRegistered(stateDirectory, seat);

    // THE DECISION COMES FROM THE MATRIX, and it is checked BEFORE a plan id is issued: an approval
    // for an operation already certain to fail is worse than no approval.
    const claim = getSeatClaimState(stateDirectory, seat);
    if (getSeatStateDecision('retire', claim.state, false) !== 'allow') {
      const because =
        claim.state === 'orphaned'
          ? `is bound to agent process ${claim.agentPid}, which is still running even though its claim holder is gone`
          : 'has a live session';
      refuse(
        `Seat '${seat}' ${because}, and cannot be retired. Retirement makes a seat's material ` +
          'eligible for a whole-tree reset, so retiring an active seat would hand its work to the next one. ' +
          'Wait for that agent to end, then retire it.',
      );
    }

    // THE SEAT'S OWN NOTEBOOK TRAVELS WITH IT (ADR-0029). Under the shared layout a retired
    // incarnation's topics waited for a whole-tree reset; under the seat-owned one there is no such
    // reset, so the root is archived beside the Desk -- and a half-migrated workspace refuses, because
    // the migration's plan binds every seat in the registry.
    const layout = readNotebookLayout(workspace);
    if (layout.state === 'migrating') refuse(migratingRefusal(`Retiring seat '${seat}'`));
    const notebookRelative = seatNotebookRelative(seat);
    const notebookRoot = path.join(workspace, ...notebookRelative.split('/'));
    const seatOwned = layout.state === 'seat-owned';
    const notebookEntries = seatOwned && fs.existsSync(notebookRoot) ? fs.readdirSync(notebookRoot).sort() : [];

    // RAW LINES, NOT ENTRIES: the fingerprint is of what is literally in the file, `#` lines included.
    const booksPath = deskFilePath(stateDirectory, seat, 'books');
    const projectsPath = deskFilePath(stateDirectory, seat, 'projects');
    const bookLines = readDeskFileLines(booksPath).filter((line) => line.trim());
    const projectLines = readDeskFileLines(projectsPath).filter((line) => line.trim());
    // THE NOTEBOOK IS BOUND ONLY WHEN THERE IS ONE to archive, so a seat with none fingerprints exactly
    // as it did before ADR-0029 -- and an approval cannot move a Notebook that grew since it was given.
    const material =
      `${seat}|${entry.project}|${bookLines.join(';')}|${projectLines.join(';')}` +
      (notebookEntries.length ? `|notebook=${notebookEntries.join(';')}` : '');
    const planId = crypto.createHash('sha256').update(material, 'utf8').digest('hex').substring(0, 16);

    // WHAT WILL TRAVEL BESIDE THE DESK, read now -- and deliberately NOT in the plan id: a conversation
    // recorded between preflight and approval is the record doing its job, not a change to the Desk.
    const records: { kind: string; file: string }[] = [
      { kind: 'conversations', file: seatConversationsPath(stateDirectory, seat) },
      { kind: 'binding', file: seatBindingPath(stateDirectory, seat) },
      { kind: 'holder-attempt', file: seatHolderAttemptPath(stateDirectory, seat) },
    ];
    const recordsPresent = records.filter((record) => isFile(record.file)).map((record) => record.kind);

    const archiveRoot = path.join(workspace, 'internal', 'seat-archive');
    if (parsed.flags.has('preflight')) {
      return {
        schema: LIBRARY_OUTPUT_SCHEMA,
        operation: 'Retire a Library seat',
        seat,
        seat_id: entry.seatId,
        project: entry.project,
        plan_id: planId,
        open_books: bookLines,
        open_projects: projectLines,
        records_to_archive: recordsPresent,
        ...(seatOwned ? { notebook_to_archive: notebookEntries.map((name) => `${notebookRelative}/${name}`) } : {}),
        archive_destination: path.join(archiveRoot, `${seat}-<timestamp>`),
        recoverable: true,
        note: seatOwned
          ? "The Desk is the only durable record of what was open, so it is archived rather than discarded, and the seat's own Notebook goes with it (ADR-0029): no other seat can reach it afterwards. The archive record is also what MAKES this seat retired, and what lets the name be used again by a new seat that will not inherit either."
          : "The Desk is the only durable record of what was open, so it is archived rather than discarded. The archive record is also what MAKES this seat retired: it is what lets a whole-tree reset reach this incarnation's Notebook topics, and what lets the name be used again by a new seat that will not inherit them.",
        shared_library_write: false,
      };
    }
    if (!approvedPlanId) {
      refuse(
        'The seat was not retired: run with --preflight, show the reader what it reports, and rerun with the exact --plan-id after one clear yes.',
      );
    }
    if (approvedPlanId !== planId) {
      refuse(
        "The seat was not retired: rerun the current preflight and pass its exact plan_id as --plan-id. A different plan_id means the seat's Desk changed since you approved it.",
      );
    }

    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp =
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const archiveDirectory = path.join(archiveRoot, `${seat}-${stamp}`);
    fs.mkdirSync(archiveDirectory, { recursive: true });

    // ARCHIVE FIRST, VERIFY, AND ONLY THEN REMOVE -- both Desk files, and the seat's own records with
    // them, because removing the seat directory below deletes the only copy of conversations.json.
    const archived: string[] = [];
    for (const pair of [{ kind: 'books', file: booksPath }, { kind: 'projects', file: projectsPath }, ...records]) {
      if (!isFile(pair.file)) continue;
      const destination = path.join(archiveDirectory, path.basename(pair.file));
      writeAtomicText(destination, new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(pair.file)));
      if (!Buffer.from(fs.readFileSync(pair.file)).equals(Buffer.from(fs.readFileSync(destination)))) {
        refuse(`The seat was NOT retired: ${destination} did not read back identical to ${pair.file}. Nothing has been removed.`);
      }
      archived.push(pair.kind);
    }
    // THE NOTEBOOK, BY ONE DIRECTORY MOVE, before the record that makes the retirement real: a
    // retirement whose Notebook failed to move is refused with nothing removed.
    if (notebookEntries.length) {
      fs.renameSync(notebookRoot, path.join(archiveDirectory, 'notebook'));
      archived.push('notebook');
    }
    // THIS FILE IS THE RETIREMENT, not a receipt for it.
    writeAtomicText(
      path.join(archiveDirectory, 'seat.json'),
      psConvertToJson({
        seat,
        seat_id: entry.seatId,
        project: entry.project,
        retired_utc: utcRoundTrip(),
        open_books: bookLines,
        open_projects: projectLines,
      }) + '\n',
    );

    const rows = readRegistryRows(registryFile).filter((row) => String(row['seat']) !== seat);
    writeSeatRegistry(stateDirectory, rows);

    const deskDirectory = deskStateDirectory(stateDirectory, seat);
    if (fs.existsSync(deskDirectory)) fs.rmSync(deskDirectory, { recursive: true, force: true });

    return {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: 'Retire a Library seat',
      seat,
      seat_id: entry.seatId,
      project: entry.project,
      archived,
      archive_directory: archiveDirectory,
      seats_remaining: rows.map((row) => String(row['seat'])),
      shared_library_write: false,
    };
  } finally {
    exitBookLock(lock);
  }
}

function isFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

/** The registry's rows AS WRITTEN, every field kept, for a writer. `readSeatRegistry` validated them already. */
function readRegistryRows(file: string): Record<string, PsJsonValue>[] {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(strictUtf8(file)) as { seats?: unknown };
  const seats = parsed.seats;
  return (Array.isArray(seats) ? seats : seats === null || seats === undefined ? [] : [seats]) as Record<string, PsJsonValue>[];
}

/** Replace the registry atomically, sorted by seat so the same seats are the same bytes. Lock held. */
function writeSeatRegistry(stateDirectory: string, rows: Record<string, PsJsonValue>[]): void {
  const ordered = [...rows].sort((left, right) => psSortCompare(String(left['seat']), String(right['seat'])));
  writeAtomicText(path.join(seatsDirectory(stateDirectory), '_registry.json'), psConvertToJson({ schema: 1, seats: ordered }) + '\n');
}

// --- dispatch ---------------------------------------------------------------------------------------

/**
 * `library seat <action> ...`. Returns the exit code; a refusal goes to stderr through `onRefusal`.
 * `hold` is internal -- `enter` spawns it -- and prints nothing: the attempt record and the handle are
 * its whole interface.
 */
export async function runSeatVerb(
  argv: string[],
  emitResult: (value: PsJsonValue) => void,
  onRefusal: (message: string) => never,
): Promise<number> {
  const action = argv[0] ?? '';
  const rest = argv.slice(1);
  try {
    switch (action) {
      case 'enter':
        emitResult(await seatEnter(rest));
        return 0;
      case 'retire':
        emitResult(seatRetire(rest));
        return 0;
      case 'hold':
        return await seatHold(rest);
      case 'start': {
        const outcome = await seatStart(rest);
        if (outcome.result !== null) emitResult(outcome.result);
        return outcome.exitCode;
      }
      case 'status':
        emitResult(seatStatus(rest));
        return 0;
      default:
        onRefusal(`library seat has no action '${action}'. It has: enter, retire, start, status.`);
    }
  } catch (error) {
    onRefusal((error as Error).message);
  }
}
