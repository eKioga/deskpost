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
import { deskEntriesForSeat, resolveSeatName } from './seatdesk.ts';
import { hubNewPage } from './hubnewpage.ts';
import { collectionAddPage } from './collectionpage.ts';
import { parseBookRoot } from './places.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import { notebookScope, prepareNotebookScopeForWrite } from './notebooklayout.ts';
import { invokeNotebookRender, notebookTopicLockRoot, scopeIndexDrift } from './notebook.ts';
import { localDate } from './localdate.ts';
import { setNoteField, shelfNotes } from './shelfnote.ts';
import {
  assertShelfBookOpen,
  assertWriteSetsDisjoint,
  convertToTriageAction,
  executionOrder,
  isFilingAction,
  getCaptureBook,
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

/** The default `--capture-date`: the local calendar date, as a capture names its note (S50). */
interface Resolved {
  action: TriageAction;
  raw: Record<string, unknown>;
}

interface Entry {
  resolved: Resolved;
  recordedState: string;
  gateError: string;
  childPlan: PsJsonValue | null;
  /** A filing action whose note is already closed and filed to this destination, which still exists (row 2a). */
  alreadyFiled: boolean;
  /** A confirming child's plan_id, from its own preview while the batch is planned (row 2c's collection-book). */
  childPlanId: string | null;
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

/** A value as canonical JSON, every object's keys in order, so two requests compare by content and not key order. */
function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item as object).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]))
        : item;
  return JSON.stringify(sorted(value));
}

/**
 * A FINISHED BATCH, RUN AGAIN WITH ITS APPROVED ID (kickoffs/s99 row K3, ruling 8). The batch's own run changed the notes
 * it closed, so the same --actions now digest to another batch id and the run said "not yet performed". When the id names
 * a journal of its own batch whose state is `complete`, whose plan record holds exactly these requests, and which records
 * every one of its actions as succeeded, nothing is written and the journal's result is said again, with
 * `already_complete: true` last. Anything else, an unreadable record included, is null and today's refusal stands. An
 * interrupted batch is not this: it is `incomplete`, and resuming one that skips what succeeded needs its own design.
 */
function finishedBatchResult(workspace: string, planId: string, requested: Record<string, unknown>[]): PsJsonValue | null {
  if (!/^triage-[0-9a-f]{64}$/.test(planId)) return null;
  const journalPath = path.join(workspace, 'internal', 'triage-journals', `${planId}.json`);
  const planPath = path.join(workspace, 'internal', 'triage-plans', `${planId}.json`);
  let journal: Record<string, unknown>;
  let plan: Record<string, unknown>;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (journal === null || plan === null || typeof journal !== 'object' || typeof plan !== 'object') return null;
  if (Number(journal['schema']) !== 1 || journal['batch_id'] !== planId || journal['state'] !== 'complete' || plan['batch_id'] !== planId) return null;
  const planned = (Array.isArray(plan['actions']) ? plan['actions'] : []) as Record<string, unknown>[];
  const records = new Map(((Array.isArray(journal['actions']) ? journal['actions'] : []) as Record<string, unknown>[]).map((record) => [String(record?.['action_id'] ?? ''), record]));
  const wanted = requested.map(canonicalJson).sort();
  const approved = planned.map((action) => canonicalJson(action?.['request'])).sort();
  if (!planned.length || wanted.length !== approved.length || wanted.some((item, index) => item !== approved[index])) return null;
  if (records.size !== planned.length || planned.some((action) => String(records.get(String(action['action_id'] ?? ''))?.['state'] ?? '') !== 'succeeded')) return null;
  const outcomes = planned.map((action) => {
    const record = records.get(String(action['action_id']))!;
    return {
      action_id: String(action['action_id']),
      kind: (record['kind'] ?? null) as PsJsonValue,
      source: (record['source'] ?? null) as PsJsonValue,
      slug: (record['slug'] ?? null) as PsJsonValue,
      destination: (record['destination'] ?? null) as PsJsonValue,
      state: 'succeeded',
      skipped: true,
      error: '',
      note: 'Already recorded as succeeded in the batch journal; re-running it would be a no-op.',
      result: null,
    };
  });
  return {
    schema: LIBRARY_OUTPUT_SCHEMA,
    operation: 'Library Triage',
    mode: 'batch',
    plan_id: planId,
    plan_path: planPath,
    status: 'complete',
    all_succeeded: true,
    action_count: outcomes.length,
    succeeded_count: outcomes.length,
    failed_count: 0,
    interrupted_count: 0,
    outcomes,
    journal_path: journalPath,
    // THIS RUN WROTE NOTHING, so it says no write; the journal is the record of the run that did.
    shelf_write: false,
    shared_collection_write: false,
    notebook_write: false,
    shared_library_write: false,
    next: 'This batch was already complete: its journal records every action as succeeded, so this run wrote nothing.',
    already_complete: true,
  };
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
  const captureDate = (parsed.options.get('capture-date') ?? '').trim() || localDate();
  const lockTimeout = Number(parsed.options.get('lock-timeout') ?? '20');
  const stateDirectory = path.join(workspace, '.claude');
  const preflight = parsed.flags.has('preflight');

  // A FINISHED BATCH SAYS SO (kickoffs/s99 row K3, ruling 8), before anything is resolved: see `finishedBatchResult`.
  if (!preflight && parsed.flags.has('user-confirmed')) {
    const finished = finishedBatchResult(workspace, parsed.options.get('plan-id') ?? '', requested);
    if (finished !== null) return finished;
  }

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
  // THE SEAT RESOLVED ABOVE IS THE ONE EVERY GATE READS (S73 row 4): the Desk, the Notebook scope and the seat rule.
  const pairs: Resolved[] = requested.map((raw) => ({ action: convertToTriageAction(raw, workspace, captureDate, notebookRelative, seat), raw }));
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
      // A LOCAL HUB PAGE NEEDS THE HUB OPEN AT THIS SEAT (row 2b), as `hub edit --mode new-page` does.
      // A COLLECTION BOOK OPEN AT THIS SEAT (row 2c), read the way `collection add-page` reads it.
      const collectionBook = /^collection-book-open:(.+)$/.exec(required);
      if (collectionBook) {
        if (seat === null) refuse(seatState.message);
        const slug = collectionBook[1]!;
        if (!deskEntriesForSeat(stateDirectory, seat, 'books').some((entry) => parseBookRoot(entry.trim())?.root === `books/${slug}`)) {
          refuse(`Book '${slug}' is not open at seat '${seat}'. Open it first: deskpost desk open book ${slug} --location collection`);
        }
        continue;
      }
      const project = /^project-open:(.+)$/.exec(required);
      if (project) {
        if (seat === null) refuse(seatState.message);
        if (!deskEntriesForSeat(stateDirectory, seat, 'projects').includes(`projects/${project[1]!}`)) {
          refuse(`Project '${project[1]!}' is not open. Open it first: deskpost desk open project ${project[1]!}`);
        }
        continue;
      }
      const match = /^shelf-book-open:(.+)$/.exec(required);
      if (!match) refuse(`Unknown required Desk state '${required}'.`);
      const slug = match[1]!;
      assertShelfBookOpen(workspace, slug, slug === action.source_slug && action.source === 'holding' ? 'triaging its notes' : 'graduating a page into it', seat);
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
        // A PAGE THAT LANDED WHOSE CLOSE DID NOT (row 2a): `filed_to` was never written, so this is not the
        // already-filed skip, and the reader is told the one step left.
        const filing = isFilingAction(action);
        refuse(
          `The approved write set is no longer writable: '${relative}' already exists. Nothing was written for this action.` +
            (filing ? ` If an earlier run filed ${action.source_note} there and could not close it, close the note with a review action instead of filing it again.` : ''),
        );
      }
    }
  };
  const sourceNoteOf = (action: TriageAction) => {
    const book = getCaptureBook(workspace, action.source_slug);
    return { book, note: shelfNotes(book).find((row) => action.source_note === `${book.bookRoot}/wiki/${row.page}.md`) ?? null };
  };
  const isAlreadyFiled = (action: TriageAction): boolean => {
    if (!isFilingAction(action)) return false;
    const { note } = sourceNoteOf(action);
    const filedTo = String(action.metadata['filed_to'] ?? '');
    return note !== null && note.review === 'done' && note.filedTo === filedTo && fs.existsSync(path.join(workspace, ...filedTo.split('/')));
  };
  // FILING CLOSES THE NOTE (row 2a): `review: done`, the `reviewed:` stamp and `filed_to:`, under the source Book's
  // lock, after the page has landed. A note already `done` is filed and its close half reports `unchanged`. If the
  // close fails, the page stays where it landed and the refusal says so, since `filed_to` is then never written.
  const closeFiledNote = (action: TriageAction): PsJsonValue => {
    const filedTo = String(action.metadata['filed_to'] ?? '');
    try {
      if ((process.env['LIBRARY_TRIAGE_CLOSE_FAULT'] ?? '').trim() === 'after-page') refuse('LIBRARY_TRIAGE_CLOSE_FAULT=after-page: the close was made to fail after the page landed');
      const { book, note } = sourceNoteOf(action);
      if (!note) refuse(`the note is gone`);
      if (note.review === 'done') return { status: 'unchanged', note_page: action.source_note, filed_to: filedTo };
      const lock: BookLock = enterBookLock(workspace, book.bookRoot, lockTimeout);
      try {
        const content = fs.readFileSync(note.fullPath, 'utf8');
        const closed = setNoteField(setNoteField(content.replace(/^review:\s*[^\n]*/m, 'review: done'), 'reviewed', utcSeconds()), 'filed_to', filedTo);
        if (closed === content || !/^review: done/m.test(closed)) refuse(`the note has no review field to close`);
        const mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Close ${note.page}, filed to ${filedTo}`, lock });
        writeAtomicText(note.fullPath, closed);
        const pendingCount = updateShelfNoteIndex(book).pendingCount;
        return { status: 'closed', note_page: action.source_note, filed_to: filedTo, pending_count: pendingCount, manifest: completeBookMutation(mutation).summary };
      } finally {
        exitBookLock(lock);
      }
    } catch (error) {
      refuse(
        `The page landed at ${filedTo}, but ${action.source_note} could not be closed: ${(error as Error).message}. ` +
          'Close the note with a review action; filing it again is refused because the page now exists.',
      );
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
  // A LOCAL HUB PAGE (row 2b) through `hub edit --mode new-page`'s own writer: a Holding note's body with its
  // frontmatter separated, as every other destination receives it, or the Notebook page itself.
  const hubPage = (pair: Resolved, confirmed: boolean): Record<string, PsJsonValue> => {
    const action = pair.action;
    let content = '';
    let contentPath = '';
    if (action.source === 'holding') {
      const { note } = sourceNoteOf(action);
      if (!note) refuse(`The approved source '${action.source_note}' is gone. Nothing was written for this action.`);
      content = splitNoteFrontmatter(fs.readFileSync(note.fullPath, 'utf8')).body;
    } else {
      contentPath = action.source_path;
    }
    try {
      return hubNewPage(
        { slug: action.slug, page: String(action.metadata['page_path'] ?? ''), content, contentPath, title: String(action.metadata['page_title'] ?? ''), seat: seat ?? undefined, preflight: !confirmed, lockTimeout },
        workspace,
      );
    } catch (error) {
      refuse((error as Error).message);
    }
  };
  // A COLLECTION BOOK PAGE (row 2c) through `collection add-page`, which confirms: previewed while the batch is planned,
  // and run with that preview's plan_id.
  const collectionPage = (pair: Resolved, childPlanId: string | null): Record<string, PsJsonValue> => {
    const action = pair.action;
    const args = [action.slug, String(action.metadata['page_path'] ?? ''), '--lock-timeout', String(lockTimeout)];
    if (seat !== null) args.push('--seat', seat);
    const pageTitle = String(action.metadata['page_title'] ?? '');
    if (pageTitle.trim()) args.push('--title', pageTitle);
    if (action.source === 'holding') {
      const { note } = sourceNoteOf(action);
      if (!note) refuse(`The approved source '${action.source_note}' is gone. Nothing was written for this action.`);
      args.push('--body', splitNoteFrontmatter(fs.readFileSync(note.fullPath, 'utf8')).body);
    } else {
      args.push('--content-path', action.source_path);
    }
    args.push(...(childPlanId === null ? ['--preflight'] : ['--user-confirmed', '--plan-id', childPlanId]));
    try {
      return collectionAddPage(args, workspace);
    } catch (error) {
      refuse((error as Error).message);
    }
  };
  const holdingArguments = (action: TriageAction, confirmed: boolean) => {
    const args = [action.slug, '--title', action.title, '--content-path', action.source_path, '--source-paths', action.source_path, '--workspace', workspace];
    // The plan's capture date names the note, so the child plans the name the approval binds (S44).
    const captureDate = String(action.metadata['capture_date'] ?? '');
    if (captureDate) args.push('--capture-date', captureDate);
    const why = String(action.metadata['why'] ?? '');
    if (why) args.push('--why', why);
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
    if (action.kind === 'collection-book') {
      const plan = collectionPage(pair, null);
      assertChildWriteSetMatches(action, [String(plan['page'])]);
      return stripSchema(plan)!;
    }
    if (action.destination === 'local-hub') {
      const plan = hubPage(pair, false);
      assertChildWriteSetMatches(action, [`collection/${String(plan['page_path'])}`]);
      return stripSchema(plan)!;
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
    // ALREADY FILED IS NOT A COLLISION (S73 row 2a). Once a filing action closes its note, the batch it belonged
    // to no longer resolves to the same id, so the retry of a batch whose later action failed is a new plan, and
    // in it the landed action's destination exists. It is skipped, never refused, while the destination is there;
    // if the page has since gone, filing it again is legitimate.
    const alreadyFiled = recorded !== 'succeeded' && isAlreadyFiled(pair.action);
    if (recorded !== 'succeeded' && !alreadyFiled) {
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
    const childPlanId = pair.action.kind === 'collection-book' && childPlan !== null ? String((childPlan as Record<string, PsJsonValue>)['plan_id'] ?? '') || null : null;
    entries.push({ resolved: pair, recordedState: recorded, gateError, childPlan, alreadyFiled, childPlanId });
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
          child_plan_id: entry.childPlanId,
          recorded_state: entry.alreadyFiled ? 'already-filed' : entry.recordedState,
          plan: entry.childPlan,
        };
      }),
      journal_path: journalPath,
      // ANOTHER SEAT'S NOTES, LISTED APART (S73 row 4), so the reader's yes is to them by name. Only when there are any.
      ...(entries.some((entry) => entry.resolved.action.metadata['other_seat'] !== undefined)
        ? {
            other_seat_actions: entries
              .filter((entry) => entry.resolved.action.metadata['other_seat'] !== undefined)
              .map((entry) => ({
                action_id: entry.resolved.action.action_id,
                kind: entry.resolved.action.kind,
                note: entry.resolved.action.source_note,
                other_seat: String(entry.resolved.action.metadata['other_seat']),
              })),
          }
        : {}),
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
  if (!parsed.flags.has('user-confirmed')) refuse('Library Triage is not yet performed: review the preflight and rerun with --user-confirmed.');
  if (parsed.options.get('plan-id') !== batchId) {
    refuse('Library Triage is not yet performed: rerun the current preflight and pass its exact plan_id as --plan-id. A different plan_id means the material changed since you approved it.');
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
        // Only a confirming child's (row 2c): every other kind's record keeps the shape the oracle writes.
        ...(entries.find((entry) => entry.resolved === pair)?.childPlanId ? { child_plan_id: entries.find((entry) => entry.resolved === pair)!.childPlanId! } : {}),
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
      if (entry.alreadyFiled) {
        record.state = 'succeeded';
        record.completed_utc = utcSeconds();
        const filedTo = String(action.metadata['filed_to'] ?? '');
        outcomes.push(outcome(action, 'succeeded', true, { status: 'already-filed', filed_to: filedTo }, '', `Already filed: ${action.source_note} is closed and filed to ${filedTo}, which exists.`));
        saveJournal('in-progress');
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
        const result = invokeChildAction(entry.resolved, entry.childPlanId);
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
      // A LOCAL HUB PAGE (row 2b) and a collection Book page (2c) write no shared collection, and close a Shelf note
      // when they file one.
      shelf_write: succeededKinds.some((kind) => SHELF_KINDS.includes(kind)) || succeeded.some((row) => ['local-hub', 'collection'].includes(String(row['destination'])) && row['source'] === 'holding'),
      shared_collection_write: succeeded.some((row) => row['destination'] === 'shared-collection'),
      notebook_write: succeededKinds.includes('notebook'),
      shared_library_write: succeeded.some((row) => row['destination'] === 'shared-collection'),
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

  function invokeChildAction(pair: Resolved, childPlanId: string | null): PsJsonValue {
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
      const result = stripSchema(child.value)! as Record<string, PsJsonValue>;
      if (action.source === 'holding') result['note_close'] = closeFiledNote(action);
      return result;
    }
    if (action.kind === 'collection-book') {
      if (childPlanId === null) refuse('The collection-book action has no plan_id from its own preview, so nothing was written; rerun the batch preflight.');
      const result = stripSchema(collectionPage(pair, childPlanId))! as Record<string, PsJsonValue>;
      if (action.source === 'holding') result['note_close'] = closeFiledNote(action);
      return result;
    }
    if (action.destination === 'local-hub') {
      const result = stripSchema(hubPage(pair, true))! as Record<string, PsJsonValue>;
      if (action.source === 'holding') result['note_close'] = closeFiledNote(action);
      return result;
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
    // EVERY CLOSE IS STAMPED, AND A REOPEN UNSTAMPS (S73 row 1). The stamp is the runner's, written here at
    // execution like `completed_utc`, and never enters the action's metadata: a clock in the digest would make
    // every batch refuse its own plan id. `shelf tidy` ages a closed note from it.
    const closeState = (content: string, state: string) => setNoteField(setReview(content, state), 'reviewed', state === 'done' ? utcSeconds() : null);
    const lock: BookLock = enterBookLock(workspace, book.bookRoot, lockTimeout);
    let mutation: BookMutation | null = null;
    try {
      if (action.kind === 'review') {
        const newState = String(action.metadata['new_review'] ?? '');
        result['new_review'] = newState;
        // A note closed before the stamp existed is `done` with no `reviewed:`. Reviewing it again writes the stamp
        // and says `stamped`, which is the only route that lets it age.
        const stamped = note.reviewed !== null;
        // Nothing written, so nothing marked dirty.
        if (note.review === newState && stamped === (newState === 'done')) {
          result['status'] = 'unchanged';
          result['reader_map'] = `${book.bookRoot}/wiki/_index.md`;
          return result;
        }
        const content = fs.readFileSync(note.fullPath, 'utf8');
        if (!/^review:/m.test(content)) refuse(`This note has no review field to update: ${note.page}`);
        const updated = closeState(content, newState);
        if (updated === content) refuse(`This note has no frontmatter to update: ${note.page}`);
        mutation = enterBookMutation({ workspace, slug: book.slug, bookRoot: book.bookRoot, reason: `Review ${note.page} as ${newState}`, lock });
        writeAtomicText(note.fullPath, updated);
        result['status'] = note.review === newState && newState === 'done' ? 'stamped' : 'updated';
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
        writeAtomicText(note.fullPath, closeState(content, 'done'));
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
