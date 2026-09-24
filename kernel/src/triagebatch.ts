/**
 * `library triage batch` -- `tools/Invoke-LibraryTriage.ps1 -ActionJson`, the batch runner, ported for the
 * local destinations (S43, S21's group 3).
 *
 * THE STATE MACHINE IS THE ORACLE'S, STEP FOR STEP, because it is what a reader already relies on:
 *
 *   1. every action is resolved and preflighted, and any failure refuses the whole batch before a write;
 *   2. the batch runs in the fixed order -- review, holding, notebook, shelf-book, project, book, discard --
 *      cheapest and most reversible first;
 *   3. each action's gate is revalidated at execution: source hashes, open Books, writable paths;
 *   4. a failed action does not stop the batch, because losing nothing beats stopping early;
 *   5. the batch is `incomplete` unless every action succeeded;
 *   6. a retry re-runs only what did not succeed, and an action a killed run left `attempting` is reported
 *      `interrupted`, never re-run blindly -- whether its output landed is unknown, and running it again
 *      could do it twice;
 *   7. a durable journal, rewritten whole after every action, owns that state.
 *
 * THE BATCH ID IS THE APPROVAL AND THE JOURNAL'S NAME: `triage-` and the hash of every action's content-bound
 * digest, so the same request over the same material resumes the same journal, and any drift in a source is
 * a new batch that needs its own preflight. That is also why an action that rewrites its own source -- a
 * review, a copy to the Notebook -- cannot be resumed past: once it has succeeded the batch it belonged to no
 * longer resolves. Said here because it surprises; it is the oracle's rule, not this port's.
 *
 * WHAT IS PORTED: review, holding (`library capture`), notebook (into this seat's Notebook, ADR-0029),
 * shelf-book (`library book add-page`) and discard. WHAT IS NOT, REFUSED BY NAME: project and book, which
 * reach the shared collection through writers this runner would call confirmed; the single-note surface
 * (`-Source`/`-To`); and re-running a stored plan by path. The judge is kernel self-test section 33; the
 * preflight is compared with the oracle's by `triage.batch-preflight-binds-every-action`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { completeBookMutation, enterBookMutation, type BookMutation } from './mutation.ts';
import { captureVerb, runBookVerb, updateShelfNoteIndex } from './capture.ts';
import { resolveSeatName } from './seatdesk.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import { notebookScope, prepareNotebookScopeForWrite } from './notebooklayout.ts';
import { invokeNotebookRender, notebookTopicLockRoot, scopeIndexDrift } from './notebook.ts';
import {
  assertShelfBookOpen,
  assertWriteSetsDisjoint,
  convertToTriageAction,
  executionOrder,
  getCaptureBook,
  shelfNotes,
  splitNoteFrontmatter,
  triageHash,
  type TriageAction,
} from './triage.ts';

const LIBRARY_OUTPUT_SCHEMA = 1;
/** `$script:TriagePlanSchema` in TriagePlanCommon.ps1. */
const TRIAGE_PLAN_SCHEMA = 3;
const CONFIRMING_KINDS = ['discard', 'project', 'book'];
const INLINE_KINDS = ['review', 'notebook', 'discard'];
const SHELF_KINDS = ['holding', 'shelf-book', 'review', 'discard', 'notebook'];
const SHARED_KINDS = ['project', 'book'];

class TriageRefusal extends Error {}

function refuse(message: string): never {
  throw new TriageRefusal(message);
}

/** `[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')`. */
function utcSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function utcDate(): string {
  return new Date().toISOString().substring(0, 10);
}

interface Resolved {
  action: TriageAction;
  raw: Record<string, unknown>;
}

interface Entry {
  resolved: Resolved;
  recordedState: string;
  gateError: string;
  childPlan: PsJsonValue | null;
}

interface JournalRecord {
  action_id: string;
  kind: string;
  source: string;
  slug: string;
  destination: string;
  action_digest: string;
  write_set: string[];
  delete_set: string[];
  state: string;
  attempts: number;
  completed_utc: string;
  error: string;
}

function stripSchema(value: PsJsonValue | null): PsJsonValue | null {
  // A child called in process returns its object WITHOUT the `schema` field `Write-LibraryResult -Json`
  // adds at the process boundary, and that object is what the oracle's preflight carries.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy: Record<string, PsJsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, PsJsonValue>)) if (key !== 'schema') copy[key] = item;
  return copy;
}

export function triageBatch(argv: string[], workspace: string): { refusal: string | null; value: PsJsonValue | null } {
  try {
    return { refusal: null, value: runBatch(argv, workspace) };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}

function runBatch(argv: string[], workspace: string): PsJsonValue {
  const parsed = parseArguments(argv, ['actions', 'capture-date', 'seat', 'plan-id', 'plan-path', 'lock-timeout', 'workspace']);
  if (parsed.options.has('plan-path')) {
    refuse('library triage batch does not re-run a stored plan by path yet; pass the same --actions again, which resumes the same batch. tools/Invoke-LibraryTriage.ps1 -PlanPath reads a stored plan.');
  }
  const actionsJson = parsed.options.get('actions');
  if (actionsJson === undefined) refuse('library triage batch needs --actions <json>: the batch, as a JSON array of actions.');
  let requested: Record<string, unknown>[];
  try {
    const parsedJson: unknown = JSON.parse(actionsJson);
    requested = Array.isArray(parsedJson) ? (parsedJson as Record<string, unknown>[]) : [parsedJson as Record<string, unknown>];
  } catch {
    refuse('ActionJson must be valid JSON.');
  }
  if (!requested.length) refuse('A Library Triage plan needs at least one action.');
  const captureDate = (parsed.options.get('capture-date') ?? '').trim() || utcDate();
  const lockTimeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const stateDirectory = path.join(workspace, '.claude');
  const preflight = parsed.flags.has('preflight');

  // THE ACTING SEAT, resolved once and never refusing here: only the Notebook route needs one, and that
  // route is where its absence is refused.
  const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory });
  const seat = seatState.status === 'named' ? seatState.seat! : null;

  // THE NOTEBOOK IS THE SEAT'S (ADR-0029). A batch that WRITES one resolves the writable scope, which on a
  // fresh workspace is the seat's root; one that only reads from it resolves the readable scope.
  const writesNotebook = requested.some((item) => item !== null && typeof item === 'object' && String(item['kind'] ?? '') === 'notebook');
  const readsNotebook = requested.some((item) => item !== null && typeof item === 'object' && (String(item['source'] ?? '').trim() || 'notebook') === 'notebook');
  let notebookRelative = 'notebook';
  if (writesNotebook) notebookRelative = notebookScope(workspace, seat, 'write', 'Triaging into the Notebook').relative;
  else if (readsNotebook) notebookRelative = notebookScope(workspace, seat, 'read', 'Triaging from the Notebook').relative;

  // Resolved one by one so each action keeps the reader's own request beside it -- the plan record stores
  // it, and the children are called with its words -- then checked as a set and put in execution order.
  const pairs: Resolved[] = requested.map((raw) => ({ action: convertToTriageAction(raw, workspace, captureDate, notebookRelative), raw }));
  assertWriteSetsDisjoint(pairs.map((pair) => pair.action));
  const ordered = executionOrder(pairs.map((pair) => pair.action)).map((action) => pairs.find((pair) => pair.action === action)!);

  const batchId = 'triage-' + triageHash([`schema=${TRIAGE_PLAN_SCHEMA}`, ...ordered.map((pair) => `${pair.action.action_id}|${pair.action.action_digest}`)].join('\n'));
  const journalPath = path.join(workspace, 'internal', 'triage-journals', `${batchId}.json`);

  // A JOURNAL IS ONLY EVIDENCE ABOUT ITS OWN BATCH. A record that fails any of these is refused, never
  // interpreted: accepting a `succeeded` it cannot vouch for would skip real work.
  let existingJournal: Record<string, unknown> | null = null;
  const journalState = new Map<string, Record<string, unknown>>();
  if (fs.existsSync(journalPath)) {
    existingJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (Number(existingJournal['schema']) !== 1) refuse(`The batch journal at ${journalPath} has an unsupported schema; move it aside and rerun the preflight.`);
    if (String(existingJournal['batch_id'] ?? '') !== batchId) {
      refuse(`The batch journal at ${journalPath} belongs to batch '${String(existingJournal['batch_id'] ?? '')}', not '${batchId}'. Give this run its own journal or rebuild the plan.`);
    }
    const digestById = new Map(ordered.map((pair) => [pair.action.action_id, pair.action.action_digest]));
    for (const record of (existingJournal['actions'] as Record<string, unknown>[] | undefined) ?? []) {
      const id = String(record['action_id'] ?? '');
      if (journalState.has(id)) refuse(`The batch journal records '${id}' more than once; move it aside and rerun the preflight.`);
      if (!digestById.has(id)) refuse(`The batch journal records '${id}', which is not in this plan; move it aside and rerun the preflight.`);
      if (String(record['action_digest'] ?? '') !== digestById.get(id)) refuse(`The batch journal's record for '${id}' was written against different content; rebuild the plan.`);
      journalState.set(id, record);
    }
  }
  const recordedState = (id: string) => (journalState.has(id) ? String(journalState.get(id)!['state'] ?? '') : 'pending');
  const recordedAttempts = (id: string) => (journalState.has(id) ? Number(journalState.get(id)!['attempts'] ?? 0) : 0);

  // --- gates ---------------------------------------------------------------------------------------
  const assertDeskState = (action: TriageAction) => {
    for (const required of action.required_desk_state) {
      const match = /^shelf-book-open:(.+)$/.exec(required);
      if (!match) refuse(`Unknown required Desk state '${required}'.`);
      const slug = match[1]!;
      assertShelfBookOpen(workspace, slug, slug === action.source_slug && action.source === 'holding' ? 'triaging its notes' : 'graduating a page into it');
    }
  };
  // A NOTEBOOK ACTION'S WRITE SET NAMES TWO FILES IT DOES NOT CREATE: the seat's index, re-rendered under the
  // render lock, and an existing topic's index, which the existing-topic branch leaves as it is. Found in the
  // oracle while porting this (S43) -- it refused both whenever they existed, which since ADR-0041 is always --
  // and fixed there first with a regression in Test-ShelfNoteBoundary.ps1.
  const isDerivedWritePath = (action: TriageAction, relative: string) => {
    if (action.kind !== 'notebook') return false;
    if (/(^|\/)_master-index\.md$/.test(relative)) return true;
    const topic = String(action.metadata['topic'] ?? '');
    if (relative === `${notebookRelative}/${topic}/_index.md`) return fs.existsSync(path.join(workspace, ...notebookRelative.split('/'), topic));
    return false;
  };
  const assertWriteSetWritable = (action: TriageAction) => {
    for (const relative of action.write_set.filter((item) => !/^(books|projects)\//.test(item))) {
      if (isDerivedWritePath(action, relative)) continue;
      if (fs.existsSync(path.join(workspace, ...relative.split('/')))) {
        refuse(`The approved write set is no longer writable: '${relative}' already exists. Nothing was written for this action.`);
      }
    }
  };
  const assertSourceUnchanged = (action: TriageAction) => {
    for (const entry of action.source_manifest) {
      const split = entry.lastIndexOf('|');
      const relative = entry.substring(0, split);
      const expected = entry.substring(split + 1);
      const full = path.join(workspace, ...relative.split('/'));
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) refuse(`The approved source '${relative}' is gone. Nothing was written for this action.`);
      const actual = triageHash(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)).replace(/^\uFEFF/, ''));
      if (actual !== expected) refuse(`The approved source '${relative}' changed after the approval. Nothing was written for this action; rebuild the plan.`);
    }
  };
  const assertChildWriteSetMatches = (action: TriageAction, planned: string[]) => {
    const expected = [...action.write_set].sort();
    const actual = [...planned].sort();
    if (expected.join('|') !== actual.join('|')) {
      refuse(`Action '${action.action_id}' would write paths the approval does not cover. Approved: ${expected.join(', ')}. Planned: ${actual.join(', ')}.`);
    }
  };

  // --- children ------------------------------------------------------------------------------------
  const shelfPageArguments = (pair: Resolved, confirmed: boolean) => {
    const action = pair.action;
    const pageArgs = ['add-page', action.slug, String(action.metadata['page_path'] ?? ''), '--title', action.title, '--workspace', workspace];
    if (action.source === 'holding') {
      const sourceBook = getCaptureBook(workspace, action.source_slug);
      const note = shelfNotes(sourceBook).find((row) => action.source_note === `${sourceBook.bookRoot}/wiki/${row.page}.md`);
      if (!note) refuse(`The approved source '${action.source_note}' is gone. Nothing was written for this action.`);
      pageArgs.push('--body', splitNoteFrontmatter(fs.readFileSync(note.fullPath, 'utf8')).body);
    } else {
      pageArgs.push('--content-path', action.source_path);
    }
    if (!confirmed) pageArgs.push('--preflight');
    return pageArgs;
  };
  const holdingArguments = (action: TriageAction, confirmed: boolean) => {
    const args = [action.slug, '--title', action.title, '--content-path', action.source_path, '--source-paths', action.source_path, '--workspace', workspace];
    // The plan's capture date names the note, so the child plans the name the approval binds (S44).
    const captureDate = String(action.metadata['capture_date'] ?? '');
    if (captureDate) args.push('--capture-date', captureDate);
    // The approved file name is pinned, not chosen again: an approval naming one path never writes another.
    if (confirmed) args.push('--require-note-file', path.basename(action.write_set[0]!));
    else args.push('--preflight');
    return args;
  };
  const childPreflight = (pair: Resolved): PsJsonValue => {
    const action = pair.action;
    if (INLINE_KINDS.includes(action.kind)) {
      return {
        operation: action.operation,
        note_page: action.source_note,
        current_review: String(action.metadata['current_review'] ?? ''),
        new_review: String(action.metadata['new_review'] ?? ''),
        write_set: action.write_set,
        delete_set: action.delete_set,
      };
    }
    if (action.kind === 'holding') {
      const child = captureVerb(holdingArguments(action, false), workspace);
      if (child.refusal !== null) refuse(child.refusal);
      const plan = child.value as Record<string, PsJsonValue>;
      assertChildWriteSetMatches(action, [`${String(plan['note_page'])}.md`]);
      return stripSchema(child.value)!;
    }
    if (action.kind === 'shelf-book') {
      const child = runBookVerb(shelfPageArguments(pair, false), workspace);
      if (child.refusal !== null) refuse(child.refusal);
      assertChildWriteSetMatches(action, [String((child.value as Record<string, PsJsonValue>)['page'])]);
      return stripSchema(child.value)!;
    }
    if (SHARED_KINDS.includes(action.kind)) {
      refuse(
        `Triage to ${action.kind === 'project' ? 'a Project Hub' : 'a new shared Book'} is not ported yet: the kernel's confirmed ` +
          `${action.kind === 'project' ? 'hub copy-pages' : 'publish'} is not called from a batch. Run a batch that carries a ${action.kind} ` +
          'action with tools/Invoke-LibraryTriage.ps1.',
      );
    }
    refuse(`Unknown triage action kind '${action.kind}'.`);
  };

  // --- preflight -----------------------------------------------------------------------------------
  const entries: Entry[] = [];
  for (const pair of ordered) {
    const recorded = recordedState(pair.action.action_id);
    let childPlan: PsJsonValue | null = null;
    let gateError = '';
    if (recorded !== 'succeeded') {
      // Before approval a gate failure refuses the batch; after it, the action fails and the rest run.
      try {
        assertDeskState(pair.action);
        assertWriteSetWritable(pair.action);
        childPlan = childPreflight(pair);
      } catch (error) {
        if (preflight) throw error;
        gateError = (error as Error).message;
      }
    }
    entries.push({ resolved: pair, recordedState: recorded, gateError, childPlan });
  }
  const pending = entries.filter((entry) => entry.recordedState !== 'succeeded');
  const done = entries.filter((entry) => entry.recordedState === 'succeeded');

  if (preflight) {
    return {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: 'Library Triage',
      mode: 'batch',
      plan_path: '(preflight -- the plan record is written when the run is confirmed)',
      plan_id: batchId,
      action_count: entries.length,
      execution_order: entries.map((entry) => `${entry.resolved.action.kind}:${entry.resolved.action.slug}`),
      actions: entries.map((entry) => {
        const action = entry.resolved.action;
        return {
          action_id: action.action_id,
          kind: action.kind,
          source: action.source,
          slug: action.slug,
          destination: action.destination,
          operation: action.operation,
          source_path: action.source_path,
          source_manifest: action.source_manifest,
          source_file_count: action.source_file_count,
          delivered_sha256: action.delivered_sha256,
          required_desk_state: action.required_desk_state,
          write_set: action.write_set,
          touch_set: action.touch_set,
          delete_set: action.delete_set,
          action_digest: action.action_digest,
          child_plan_id: null,
          recorded_state: entry.recordedState,
          plan: entry.childPlan,
        };
      }),
      journal_path: journalPath,
      resume: existingJournal !== null,
      pending_count: pending.length,
      already_succeeded: done.length,
      confirmation_required: true,
      recoverable: entries.every((entry) => entry.resolved.action.delete_set.length === 0),
      shared_library_write: false,
    };
  }

  // A NOTEBOOK WRITE IS A MUTATION AND NEEDS THIS SEAT'S LIVE CLAIM -- only the Notebook route.
  if (ordered.some((pair) => pair.action.kind === 'notebook')) {
    if (seat === null) refuse(seatState.message);
    assertSeatClaimHeld({ workspace, stateDirectory, seat });
  }
  if (!parsed.flags.has('user-confirmed')) refuse('Library Triage is not yet performed: review the preflight and rerun with -UserConfirmed.');
  if (parsed.options.get('plan-id') !== batchId) {
    refuse('Library Triage is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the material changed since you approved it.');
  }

  // THE PLAN RECORD, written at the first confirmed run and only if absent, named by the batch id.
  const planPath = path.join(workspace, 'internal', 'triage-plans', `${batchId}.json`);
  if (!fs.existsSync(planPath)) {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    const envelope = ordered.map((pair) => {
      const action = pair.action;
      return {
        action_id: action.action_id,
        kind: action.kind,
        source: action.source,
        source_slug: action.source_slug,
        source_note: action.source_note,
        slug: action.slug,
        destination: action.destination,
        operation: action.operation,
        collision_policy: action.collision_policy,
        required_desk_state: action.required_desk_state,
        source_path: action.source_path,
        source_file_count: action.source_file_count,
        source_manifest: action.source_manifest,
        delivered_sha256: action.delivered_sha256,
        write_set: action.write_set,
        touch_set: action.touch_set,
        delete_set: action.delete_set,
        action_digest: action.action_digest,
        request: pair.raw as unknown as PsJsonValue,
      };
    });
    fs.writeFileSync(
      planPath,
      psConvertToJson({ version: TRIAGE_PLAN_SCHEMA, created_utc: utcSeconds(), capture_date: captureDate, batch_id: batchId, actions: envelope }),
      'utf8',
    );
  }

  const records = new Map<string, JournalRecord>();
  for (const entry of entries) {
    const action = entry.resolved.action;
    records.set(action.action_id, {
      action_id: action.action_id,
      kind: action.kind,
      source: action.source,
      slug: action.slug,
      destination: action.destination,
      action_digest: action.action_digest,
      write_set: action.write_set,
      delete_set: action.delete_set,
      state: recordedState(action.action_id),
      attempts: recordedAttempts(action.action_id),
      completed_utc: journalState.has(action.action_id) ? String(journalState.get(action.action_id)!['completed_utc'] ?? '') : '',
      error: '',
    });
  }
  const createdUtc = existingJournal !== null ? String(existingJournal['created_utc'] ?? '') : utcSeconds();
  // REWRITTEN WHOLE AND MOVED INTO PLACE after every action, so a killed run leaves the previous complete
  // journal rather than a truncated one.
  const saveJournal = (state: string) => {
    writeAtomicText(
      journalPath,
      psConvertToJson({
        schema: 1,
        batch_id: batchId,
        plan_path: planPath,
        state,
        created_utc: createdUtc,
        updated_utc: utcSeconds(),
        actions: [...records.values()] as unknown as PsJsonValue,
      }),
    );
  };

  // ONE WRITER PER BATCH, held through the final save: two processes running the same pending action would
  // otherwise overwrite each other's journal.
  const batchLock = enterBookLock(workspace, `triage/${batchId}`, 30);
  try {
    saveJournal('in-progress');
    const outcomes: Record<string, PsJsonValue>[] = [];
    const outcome = (action: TriageAction, state: string, skipped: boolean, result: PsJsonValue | null, error: string, note: string) => ({
      action_id: action.action_id,
      kind: action.kind,
      source: action.source,
      slug: action.slug,
      destination: action.destination,
      state,
      skipped,
      error,
      note,
      result,
    });
    for (const entry of entries) {
      const action = entry.resolved.action;
      const record = records.get(action.action_id)!;
      if (record.state === 'succeeded') {
        outcomes.push(outcome(action, 'succeeded', true, null, '', 'Already recorded as succeeded in the batch journal; re-running it would be a no-op.'));
        continue;
      }
      // A PREVIOUS RUN DIED BETWEEN STARTING THIS ACTION AND RECORDING ITS OUTCOME. Whether its output landed
      // is unknown, so it is reported and left alone: retrying could do it twice, and succeeding it would be
      // a claim nothing checked.
      if (record.state === 'attempting') {
        record.state = 'interrupted';
        record.error = 'A previous run was interrupted after this action began and before its outcome was recorded.';
        outcomes.push(
          outcome(action, 'interrupted', false, null, record.error, `Check whether these paths exist before rerunning: ${[...action.write_set, ...action.delete_set].join(', ')}. Rebuild the plan once you have.`),
        );
        saveJournal('in-progress');
        continue;
      }
      record.attempts += 1;
      // WRITTEN BEFORE THE CHILD RUNS, so durable output never exists while the journal still says pending.
      record.state = 'attempting';
      saveJournal('in-progress');
      try {
        if (entry.gateError) refuse(entry.gateError);
        assertDeskState(action);
        assertWriteSetWritable(action);
        assertSourceUnchanged(action);
        const result = invokeChildAction(entry.resolved);
        record.state = 'succeeded';
        record.completed_utc = utcSeconds();
        record.error = '';
        outcomes.push(outcome(action, 'succeeded', false, result, '', ''));
      } catch (error) {
        record.state = 'failed';
        record.error = (error as Error).message;
        outcomes.push(outcome(action, 'failed', false, null, record.error, ''));
      }
      saveJournal('in-progress');
    }

    const succeeded = outcomes.filter((row) => row['state'] === 'succeeded');
    const failed = outcomes.filter((row) => row['state'] !== 'succeeded');
    const interrupted = outcomes.filter((row) => row['state'] === 'interrupted');
    const status = failed.length === 0 ? 'complete' : 'incomplete';
    saveJournal(status);
    const succeededKinds = [...new Set(succeeded.map((row) => String(row['kind'])))];
    return {
      schema: LIBRARY_OUTPUT_SCHEMA,
      operation: 'Library Triage',
      mode: 'batch',
      plan_id: batchId,
      plan_path: planPath,
      status,
      all_succeeded: failed.length === 0,
      action_count: outcomes.length,
      succeeded_count: succeeded.length,
      failed_count: failed.length,
      interrupted_count: interrupted.length,
      outcomes,
      journal_path: journalPath,
      shelf_write: succeededKinds.some((kind) => SHELF_KINDS.includes(kind)),
      shared_collection_write: succeededKinds.some((kind) => SHARED_KINDS.includes(kind)),
      notebook_write: succeededKinds.includes('notebook'),
      shared_library_write: succeededKinds.some((kind) => SHARED_KINDS.includes(kind)),
      next:
        failed.length === 0
          ? 'Every action succeeded. Nothing was removed that the plan did not name.'
          : interrupted.length
            ? `This triage is incomplete: ${failed.length} of ${outcomes.length} actions did not succeed, and ${interrupted.length} was interrupted by an earlier run. Check the write set of each interrupted action by hand, then rebuild the plan.`
            : `This triage is incomplete: ${failed.length} of ${outcomes.length} actions failed. Fix the cause and rerun the same plan -- succeeded actions are skipped.`,
    };
  } finally {
    exitBookLock(batchLock);
  }

  function invokeChildAction(pair: Resolved): PsJsonValue {
    const action = pair.action;
    if (INLINE_KINDS.includes(action.kind)) return invokeNoteAction(action);
    if (action.kind === 'holding') {
      const child = captureVerb(holdingArguments(action, true), workspace);
      if (child.refusal !== null) refuse(child.refusal);
      return stripSchema(child.value)!;
    }
    if (action.kind === 'shelf-book') {
      const child = runBookVerb(shelfPageArguments(pair, true), workspace);
      if (child.refusal !== null) refuse(child.refusal);
      return stripSchema(child.value)!;
    }
    refuse(`Triage action kind '${action.kind}' is not ported; run this batch with tools/Invoke-LibraryTriage.ps1.`);
  }

  // review, notebook and discard, performed here -- there is no child helper for a note's own state. Each
  // rewrites the Book's reader map, so each holds the Book's lock, and the mutation window opens at the first
  // write to the Book. There is no undo path: this journals nothing per note, so a failure inside the window
  // leaves the Book dirty, which is then the truthful answer.
  function invokeNoteAction(action: TriageAction): PsJsonValue {
    const book = getCaptureBook(workspace, action.source_slug);
    const note = shelfNotes(book).find((row) => action.source_note === `${book.bookRoot}/wiki/${row.page}.md`);
    if (!note) refuse(`The approved source '${action.source_note}' is gone. Nothing was written for this action.`);
    const result: Record<string, PsJsonValue> = {
      operation: action.operation,
      book: book.bookRoot,
      note_page: action.source_note,
      note_title: note.title,
      current_review: note.review,
      captured: note.captured,
      shared_library_write: false,
    };
    // .NET's `.` is everything but LF, so `review:\s*.*$` there takes a CR with it; `[^\n]*` here does too.
    const setReview = (content: string, state: string) => content.replace(/^review:\s*[^\n]*/m, `review: ${state}`);
    const lock: BookLock = enterBookLock(workspace, book.bookRoot, lockTimeout);
    let mutation: BookMutation | null = null;
    try {
      if (action.kind === 'review') {
        const newState = String(action.metadata['new_review'] ?? '');
        result['new_review'] = newState;
        // Nothing written, so nothing marked dirty.
        if (note.review === newState) {
          result['status'] = 'unchanged';
          result['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
          return result;
        }
        const content = fs.readFileSync(note.fullPath, 'utf8');
        const updated = setReview(content, newState);
        if (updated === content) refuse(`This note has no review field to update: ${note.page}`);
        mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Review ${note.page} as ${newState}`, lock });
        writeAtomicText(note.fullPath, updated);
        result['status'] = 'updated';
        result['pending_count'] = updateShelfNoteIndex(book).pendingCount;
      } else if (action.kind === 'notebook') {
        const topic = String(action.metadata['topic'] ?? '');
        if (seat === null) refuse(seatState.message);
        const scope = notebookScope(workspace, seat, 'write', 'Triaging a note into the Notebook');
        prepareNotebookScopeForWrite(scope, 'Triaging a note into the Notebook');
        const topicDirectory = path.join(scope.root, topic);
        const destination = path.join(topicDirectory, note.file);
        result['destination'] = action.write_set.find((item) => item.endsWith(`/${note.file}`)) ?? action.write_set[0]!;
        const topicExists = fs.existsSync(topicDirectory) && fs.statSync(topicDirectory).isDirectory();
        if (topicExists && !fs.existsSync(path.join(topicDirectory, '_index.md'))) {
          refuse(`${scope.relative}/${topic} exists with no _index.md. Repair or remove that directory before triaging into it; a topic with no index cannot be rendered into the Notebook master index.`);
        }
        result['topic_is_new'] = !topicExists;
        // Book, then topic, then render: the lock order every Notebook writer shares. The Book's is held.
        const topicLock = enterBookLock(workspace, notebookTopicLockRoot(topic, scope.relative), lockTimeout);
        try {
          const original = fs.readFileSync(note.fullPath, 'utf8');
          if (topicExists) {
            fs.copyFileSync(note.fullPath, destination, fs.constants.COPYFILE_EXCL);
            if (fs.readFileSync(destination, 'utf8') !== original) refuse(`The note was copied but did not read back identically: ${String(result['destination'])}`);
            // An existing topic whose heading nobody touched changes nothing the index derives from, unless
            // the index has drifted, in which case this run repairs it.
            const drifted = scopeIndexDrift(scope).length > 0;
            result['master_index_rendered'] = drifted;
            if (drifted) invokeNotebookRender(scope);
          } else {
            const stagingRoot = path.join(workspace, 'internal', 'notebook-staging');
            const staging = path.join(stagingRoot, randomUUID().replace(/-/g, ''));
            fs.mkdirSync(staging, { recursive: true });
            try {
              fs.copyFileSync(note.fullPath, path.join(staging, note.file), fs.constants.COPYFILE_EXCL);
              if (fs.readFileSync(path.join(staging, note.file), 'utf8') !== original) refuse(`The note was copied but did not read back identically: ${String(result['destination'])}`);
              // The generated index says only what is true: the slug as its heading, and where it came from.
              writeAtomicText(path.join(staging, '_index.md'), `# ${topic}\n\nNotebook topic opened by triage from a capture Book. Add an overview here when the topic takes shape.\n`);
              invokeNotebookRender(scope, () => {
                if (fs.existsSync(topicDirectory)) refuse(`${scope.relative}/${topic} appeared while this note was being staged; nothing was promoted.`);
                fs.renameSync(staging, topicDirectory);
                return null;
              });
              // NO OWNERSHIP RECORD: under ADR-0029 a topic belongs to the seat whose Notebook holds it.
              result['master_index_rendered'] = true;
            } finally {
              if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
              if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) fs.rmdirSync(stagingRoot);
            }
          }
        } finally {
          exitBookLock(topicLock);
        }
        // The Notebook copy is not a Book write, so the window opens here, at the Shelf note's frontmatter.
        const content = fs.readFileSync(note.fullPath, 'utf8');
        mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Copy ${note.page} to ${scope.relative}/${topic}`, lock });
        writeAtomicText(note.fullPath, setReview(content, 'done'));
        result['status'] = 'copied';
        result['new_review'] = 'done';
        result['pending_count'] = updateShelfNoteIndex(book).pendingCount;
        result['next'] = 'The Notebook copy is volatile. Triage it onward to a Shelf Book, a Project Hub, or a new shared Book to give it a durable home.';
      } else {
        mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Discard ${note.page}`, lock });
        fs.rmSync(note.fullPath, { force: true });
        result['status'] = 'discarded';
        result['recoverable'] = false;
        result['pending_count'] = updateShelfNoteIndex(book).pendingCount;
      }
      if (mutation !== null) result['manifest'] = completeBookMutation(mutation).summary;
    } finally {
      exitBookLock(lock);
    }
    result['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
    return result;
  }
}
