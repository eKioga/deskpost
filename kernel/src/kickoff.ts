/**
 * `deskpost kickoff send` AND `deskpost kickoff receive` (kickoffs/s159 rows 2 and 3; PLAN-cross-office-build-loop.md
 * steps 2.1 and 2.2): a Kickoff carried to a seat in another Library byte for byte, in the envelope of
 * `kickoffenvelope.ts`, and landed on that seat's own Hub with its `Run` pointer, its hash checked.
 *
 * SEND is a letter to another Library (capture's `--library` path, so the note and its outbox entry are written in one
 * locked window and the Postbox's outbox owns every retry), written by capture's LITERAL ROUTE: no `{now}` or `{today}`
 * filled, no heading put in front, nothing trimmed that the envelope does not already drop. A second send of the same
 * Kickoff bytes to the same seat finds the letter it wrote and resumes its delivery instead of writing another.
 *
 * RECEIVE is one durable record (`internal/kickoffs/<id>.json`, the intent record's shape) with three stages, each
 * checking its own proof before it acts, so a retry after an interruption makes no second page or pointer:
 *   page     the canonical bytes written as `kickoffs/<id>` with new-page; an existing page is accepted only when its
 *            bytes hash to the envelope's value;
 *   pointer  `- [ ] Run <id>: [[projects/<hub>/kickoffs/<id>]] (r<n>, sha256 `<hex>`, from <card>)` at the end of
 *            `## Next` (a dev Hub queues up to three; kickoffs/s213 row 4), appended only when the
 *            link is absent, under the plan id of the page as checked, so a page that changed after the check refuses;
 *            the stage is done only after a fresh read sees exactly one pointer;
 *   close    the letter closed, last, after the page and the pointer are both verified on disk.
 *
 * Before any of them, a letter the Postbox filed `postbox_damaged` or `stale_delivery`, or whose `for_seat_id` is not
 * this seat's current id, is refused (kickoffs/s167 row 2). The envelope's hash is the hash the letter carries: it shows
 * the payload is the one the envelope describes, never who sent it.
 *
 * The record is kept apart from `intent.ts`'s folders on purpose: postbox recovery runs every outstanding record there
 * through the Report stage runners, and a receive is no delivery of theirs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureVerb, lettersCloseVerb } from './capture.ts';
import type { CheckpointState } from './checkpoint.ts';
import { readSeatRegistry, seatConversationRecord } from './desk.ts';
import { writeAtomicText } from './fsx.ts';
import { fencedLineMask, hubEdit, nextShownLines, toLines } from './hubedit.ts';
import { hubNewPage } from './hubnewpage.ts';
import { buildEnvelope, KICKOFF_ID, parseEnvelope } from './kickoffenvelope.ts';
import { chainHeader } from './kickoffcheck.ts';
import { checkBeforeReading, keptBody, readOutbox, resolveRemoteSeat, sendAfterCapture } from './postbox.ts';
import type { PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, resolveSeatName } from './seatdesk.ts';
import { pageComparisonSha256 } from './sha.ts';
import { getShelfBook } from './shelfbook.ts';
import { noteFrontmatter } from './shelfnote.ts';
import { assertShelfBookOpen } from './triage.ts';

export class KickoffRefusal extends Error {}

function refuse(message: string): never {
  throw new KickoffRefusal(message);
}

/**
 * THE LARGEST KICKOFF SENT (STANDING ANSWER 13 of kickoffs/s159): the size phase 0.1 proved reaches Webtop byte-equal.
 * Raised only past a size a probe has proved.
 */
export const KICKOFF_SIZE_LIMIT = 40_224;

const LETTERS = 'letters';

/** This session's seat and the Hub it owns, open on its Desk. */
function seatAndHub(workspace: string, verb: string): { seat: string; hub: string } {
  const stateDirectory = path.join(workspace, '.claude');
  const resolved = resolveSeatName({ stateDirectory });
  if (resolved.status !== 'named') refuse(`deskpost kickoff ${verb} works on this seat's own Hub, so it needs a seat. ${resolved.message}`.trim());
  const seat = resolved.seat!;
  const hub = readSeatRegistry(stateDirectory).find((row) => row.seat === seat)?.project ?? '';
  if (!hub) refuse(`Seat '${seat}' has no Project Hub in the seat registry, so it has no Hub for a Kickoff. Nothing was ${verb === 'send' ? 'sent' : 'written'}.`);
  if (!deskEntriesForSeat(stateDirectory, seat, 'projects').includes(`projects/${hub}`)) {
    refuse(`Project '${hub}' is not open. Open it first: deskpost desk open project ${hub}`);
  }
  return { seat, hub };
}

function kickoffId(word: string, prefix: string, verb: string): string {
  const id = word.trim().replace(/\\/g, '/').replace(/\.md$/i, '');
  const match = new RegExp(`^${prefix}/([^/]+)$`).exec(id);
  if (!match || !KICKOFF_ID.test(match[1]!)) {
    refuse(
      verb === 'send'
        ? 'deskpost kickoff send names one page of this seat\'s Hub as kickoffs/<id>, for example deskpost kickoff send kickoffs/w1 --library <card> --for <seat>. Nothing was sent.'
        : 'deskpost kickoff receive names one letter as notes/<page>, for example deskpost kickoff receive notes/2026-10-24-kickoff-w1. Nothing was written.',
    );
  }
  return match[1]!;
}

// --- send ----------------------------------------------------------------------------------------------------------

export interface SendOptions { page: string; library: string; forSeat: string }

export function kickoffSend(options: SendOptions, workspace: string): Record<string, PsJsonValue> {
  const id = kickoffId(options.page, 'kickoffs', 'send');
  if (!options.library.trim()) refuse('--library names the Library the Kickoff is for, by its id or its card. Nothing was sent.');
  if (!options.forSeat.trim()) refuse('--for names the seat there that runs the Kickoff. Nothing was sent.');
  const { seat, hub } = seatAndHub(workspace, 'send');
  const file = path.join(workspace, 'collection', 'projects', hub, 'kickoffs', `${id}.md`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) refuse(`There is no page projects/${hub}/kickoffs/${id} on this seat's Hub. Nothing was sent.`);
  const envelope = buildEnvelope(id, fs.readFileSync(file, 'utf8'));
  if (envelope.bytes > KICKOFF_SIZE_LIMIT) {
    refuse(`projects/${hub}/kickoffs/${id} is ${envelope.bytes} bytes, over the ${KICKOFF_SIZE_LIMIT} bytes a letter is proven to carry to another office. Nothing was sent.`);
  }
  const answer: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Send a Kickoff',
    kickoff: `projects/${hub}/kickoffs/${id}`,
    from_seat: seat,
    for_seat: options.forSeat,
    envelope_sha256: envelope.sha256,
    bytes: envelope.bytes,
    size_limit: KICKOFF_SIZE_LIMIT,
  };

  // THE LETTER ALREADY WRITTEN FOR THESE BYTES, if a send was interrupted: its delivery is resumed, never written twice.
  const remote = resolveRemoteSeat(workspace, options.library, options.forSeat);
  const book = getShelfBook(workspace, LETTERS);
  const head = envelope.text.substring(0, envelope.text.indexOf('\n\n') + 2);
  const sentBefore = fs.existsSync(book.notesPath)
    ? fs.readdirSync(book.notesPath).filter((name) => name.endsWith('.md')).sort().find((name) => {
      const text = fs.readFileSync(path.join(book.notesPath, name), 'utf8');
      const fields = noteFrontmatter(text);
      return fields.get('for_library_id') === remote.library_id && fields.get('for_seat') === options.forSeat && fields.get('from_seat') === seat && keptBody(text).startsWith(head);
    })
    : undefined;
  if (sentBefore !== undefined) {
    const deliveryId = noteFrontmatter(fs.readFileSync(path.join(book.notesPath, sentBefore), 'utf8')).get('delivery_id') ?? '';
    const entry = readOutbox(workspace).find((row) => row.delivery_id === deliveryId);
    const postbox = entry?.state === 'sent' ? { delivery_id: deliveryId, state: 'sent', detail: 'Already sent.' } : sendAfterCapture(workspace, deliveryId);
    return { ...answer, status: entry?.state === 'sent' ? 'already-sent' : 'resumed', letter: `notes/${sentBefore.replace(/\.md$/, '')}`, delivery_id: deliveryId, for_library_id: remote.library_id, for_library_card: remote.library_card, postbox };
  }

  const captured = captureVerb(['letters', '--for', options.forSeat, '--library', options.library, '--why', 'for-seat', '--body', envelope.text], workspace, { literal: true });
  if (captured.refusal !== null) refuse(captured.refusal);
  const value = captured.value as Record<string, PsJsonValue>;
  return {
    ...answer,
    status: 'sent-or-queued',
    letter: value['page'] ?? null,
    delivery_id: value['delivery_id'] ?? null,
    for_library_id: value['for_library_id'] ?? null,
    for_library_card: value['for_library_card'] ?? null,
    postbox: value['postbox'] ?? null,
  };
}

// --- receive -------------------------------------------------------------------------------------------------------

type StageName = 'page' | 'pointer' | 'close';

interface ReceiveRecord {
  schema: 1;
  kind: 'kickoff-receive';
  kickoff_id: string;
  letter: string;
  hub: string;
  sha256: string;
  bytes: number;
  from_library_card: string;
  /** The sending Library's id as the letter names it (kickoffs/s167 row 2): what the letter says, not a verified sender. */
  from_library_id?: string;
  identities: { pages: string[]; letter: string };
  stages: { name: StageName; state: 'pending' | 'done'; proof: string | null }[];
  created_utc: string;
  completed_utc: string | null;
}

function utcSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function recordFile(workspace: string, id: string): string {
  return path.join(workspace, 'internal', 'kickoffs', `${id}.json`);
}

/** SELF-TEST ONLY (`LIBRARY_KICKOFF_FAULT=after:<stage>` or `after:pointer-write`): the receive stops there, as a crash would. */
function fault(point: string): void {
  if ((process.env['LIBRARY_KICKOFF_FAULT'] ?? '') === `after:${point}`) refuse(`LIBRARY_KICKOFF_FAULT: kickoff receive stopped after ${point}.`);
}

function complete(workspace: string, record: ReceiveRecord, name: StageName, proof: string): void {
  const stage = record.stages.find((row) => row.name === name)!;
  stage.state = 'done';
  stage.proof = proof;
  if (record.stages.every((row) => row.state === 'done')) record.completed_utc = utcSeconds();
  writeAtomicText(recordFile(workspace, record.kickoff_id), JSON.stringify(record, null, 2) + '\n');
  fault(name);
}

/**
 * The shown lines of a Hub's `## Next`, or null when its `_project.md` text has none: `hub edit`'s own reading
 * (`nextShownLines`, kickoffs/s213-r5 row 2), so a line in a fence or an HTML comment is no pointer here either.
 */
function nextLines(text: string): string[] | null {
  return nextShownLines(toLines(text))?.map((line) => line.text) ?? null;
}

/**
 * This seat's own Hub and its `## Next` lines, fenced code left out (kickoffs/s213 rows 7 and 8): what
 * `kickoff check --open` and `kickoff next` read. Refused when there is no seat, no Hub, the Hub is closed, or it has
 * no `## Next`.
 */
export function seatHubNext(workspace: string, verb: string): { seat: string; hub: string; lines: string[] } {
  const { seat, hub } = seatAndHub(workspace, verb);
  if (verb === 'check --open') checkBeforeReading(workspace);
  const next = nextLines(fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8'));
  if (next === null) refuse(`projects/${hub}/_project has no ## Next section, so it holds no Run pointer.`);
  return { seat, hub, lines: next };
}

// --- next ----------------------------------------------------------------------------------------------------------

/** The share of the context window below which a chained Kickoff may start (`docs/dev-session-loop.md`, new work). */
export const CHAIN_CONTEXT_LIMIT = 60;

/** A Kickoff page says `CHAIN: yes` as its header line (`docs/kickoff-template.md`; `kickoffcheck.ts` `chainHeader`). */
export function saysChainYes(text: string): boolean {
  return chainHeader(text) === 'yes';
}

/**
 * The Handback's Outcome words (`docs/dev-session-loop.md`, "Close": `Outcome: <pushed | published | parked | stopped>`;
 * kickoffs/s213-r3 row 2). A unit that reached its pull request or its publish finished, so the builder may chain on;
 * a parked or stopped unit ends the session. `done` is the older word and still reads as finished. Section 1532 reads
 * the doc's own line, so a word the doc adds fails it until it is placed here.
 */
export const FINISHED_OUTCOMES: readonly string[] = ['pushed', 'published', 'done'];
export const STOPPING_OUTCOMES: readonly string[] = ['parked', 'stopped'];

/**
 * A stored closeout value as a stop line names it (kickoffs/s213-r4 row 1): a plain word as it is (`stale`, `waits`,
 * `done yesterday`), a missing value as `none`, and anything else, a string with edge spaces or quotes included,
 * as its JSON (`["done"]`, `{"done":true}`, `"done "`).
 */
function storedValueText(value: unknown): string {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string' && value !== '' && value === value.trim() && JSON.stringify(value) === `"${value}"`) return value;
  return JSON.stringify(value) ?? String(value);
}

/** The first match of `pattern` on an unfenced line of a page's `## Handback` section, or null. */
function handbackMatch(text: string, pattern: RegExp): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fenced = fencedLineMask(lines);
  const start = lines.findIndex((line, index) => !fenced[index] && /^##[ \t]+Handback[ \t]*$/.test(line));
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length; index++) {
    if (!fenced[index] && /^##[ \t]/.test(lines[index]!)) break;
    const found = pattern.exec(lines[index]!)?.[1];
    if (found !== undefined && !fenced[index]) return found;
  }
  return null;
}

/** The first `Outcome:` line of a page's `## Handback` section, or null when it has no Handback or no Outcome. */
export function handbackOutcome(text: string): string | null {
  return handbackMatch(text, /^Outcome:\s*(\S+)/)?.replace(/[.,;]$/, '') ?? null;
}

/**
 * The Kickoff id a Handback's `Ran: kickoffs/<id> r<N>, sha256 ...` line names (`docs/dev-session-loop.md`, "Close";
 * kickoffs/s213-r4 row 2), or null when the page has no Handback or no such line.
 */
export function handbackRan(text: string): string | null {
  return handbackMatch(text, /^Ran:\s*kickoffs\/([A-Za-z0-9._-]+)/)?.replace(/[.,;]+$/, '') ?? null;
}

/** A Kickoff's unit: its id without a revision suffix (`s213-r3` is unit `s213`), lower case. */
export function kickoffUnit(id: string): string {
  return id.toLowerCase().replace(/-r\d+$/, '');
}

/**
 * The attempt pages a session wrote on its own Hub (kickoffs/s213-r3 row 3): the record's Hub writes to
 * `notes/<date>-<id>-a<n>`, each once, in the order of their newest write, the newest last (kickoffs/s213-r5 row 4: the
 * record keeps every write of the conversation in the order made). The closeout may close the unit's Run pointer away,
 * so the session's own record, not pointer order, says which unit it finished.
 */
function recordedAttempts(record: CheckpointState, hub: string): { id: string; page: string }[] {
  const found = new Map<string, { id: string; page: string }>();
  for (const write of Array.isArray(record.writes) ? record.writes : []) {
    if (write?.kind !== 'hub' || write.name !== hub || typeof write.page !== 'string') continue;
    const match = /^notes\/(\d{4}-\d{2}-\d{2})-([A-Za-z0-9._-]+?)-a(\d+)$/.exec(write.page);
    if (!match) continue;
    found.delete(write.page);
    found.set(write.page, { id: match[2]!.toLowerCase(), page: write.page });
  }
  return [...found.values()];
}

/** A Hub's attempt pages `notes/<date>-<id>-a<n>` of one unit, oldest first (by date, then attempt number). */
function unitAttemptPages(hubDirectory: string, unit: string): { id: string; page: string }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(hubDirectory, 'notes')); } catch { names = []; }
  return names.map((name) => /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9._-]+?)-a(\d+)\.md$/.exec(name))
    .filter((match) => match !== null && kickoffUnit(match[2]!) === unit)
    .map((match) => ({ id: match![2]!.toLowerCase(), page: `notes/${match![0].slice(0, -3)}`, date: match![1]!, n: Number(match![3]) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n).map(({ id, page }) => ({ id, page }));
}

/**
 * DOES THIS BUILDER CHAIN ON? (PLAN-hub-redesign.md amendment A1, A1-01 to A1-03 and A1-05; kickoffs/s213 row 8).
 * Read only. It answers `start` with the next queued Kickoff's id only when every condition holds, in this order:
 * this session's closeout record names the finished unit by the newest attempt page it wrote on this seat's Hub (any
 * earlier one there handed back with an Outcome); that page's
 * Handback names the Kickoff it ran (`Ran: kickoffs/<id>`, a Kickoff of the same unit) and says `Outcome: pushed` or
 * `published`; the record's stored closeout is exactly `done` with a finite closedOutAt;
 * a next pending Run pointer exists and its Kickoff page's sha256 equals the one the pointer carries; both Kickoffs say
 * `CHAIN: yes`; and the context reading is below 60% or `unknown`, with no compaction. Otherwise `stop`, naming the
 * first condition that failed. The finished unit's Run pointer may be ticked, or gone because close-item closed it.
 *
 * THE CLAUDE CODE ROUTE (kickoffs/s214 row 1; section 1544): only Codex registers `hook checkpoint` (ADR 0079), so a
 * Claude Code builder writes the same record by command. After each Hub write it hands that write's JSON answer to
 * `deskpost checkpoint observe --conversation <session>` as one tool result on standard input
 * (`{"tool_use_id":..., "tool_input":{"command":"deskpost hub edit ..."}, "tool_response":{"stdout":"<the answer>"}}`);
 * then `deskpost checkpoint request closeout --conversation <session> --harness claude`, does the steps its prompt
 * gives, and `deskpost checkpoint check closeout --conversation <session>` with the ```closeout block on standard
 * input. Without the observe step the record tracks no tool result, the check records a gap, and this answers stop.
 */
export function kickoffNext(options: { context: string; compacted: boolean }, workspace: string): Record<string, PsJsonValue> {
  const reading = options.context.trim().toLowerCase();
  const percent = /^(\d{1,3}(?:\.\d+)?)%?$/.exec(reading)?.[1];
  if (reading !== 'unknown' && (percent === undefined || Number(percent) > 100)) {
    refuse(`--context takes this session's context reading as a percent (for example 42 or 42%) or the word unknown, not '${options.context}'. Nothing was decided.`);
  }
  const { seat, hub, lines } = seatHubNext(workspace, 'next');
  const answer: Record<string, PsJsonValue> = { schema: 1, operation: 'Decide whether to chain on', seat, hub: `projects/${hub}`, context: options.context.trim(), compacted: options.compacted };
  const stop = (reason: string, extra: Record<string, PsJsonValue> = {}) => ({ ...answer, ...extra, decision: 'stop', reason });
  const runs = lines.map((line) => /^\s*- \[([ xX])\] Run ([A-Za-z0-9._-]+):/.exec(line)).filter((match) => match !== null)
    .map((match) => ({ ticked: match![1] !== ' ', id: match![2]!, line: match!.input.trim() }));
  const firstPending = runs.findIndex((run) => !run.ticked);
  const kickoffFile = (id: string) => path.join(workspace, 'collection', 'projects', hub, 'kickoffs', `${id}.md`);
  const readPage = (id: string): string | null => { try { return fs.readFileSync(kickoffFile(id), 'utf8'); } catch { return null; } };

  // 1. This session's own record, which names the unit it finished.
  const stateDirectory = path.join(workspace, '.claude');
  const seatId = readSeatRegistry(stateDirectory).find((row) => row.seat === seat)?.seatId ?? '';
  let session = '';
  try { session = seatConversationRecord(stateDirectory, seat).sessionId; } catch { session = ''; }
  if (!seatId || !session) return stop(`This session's closeout record cannot be found: the seat ${seat} records no ${seatId ? 'session' : 'seat id'}.`);
  let record: CheckpointState | null = null;
  try { record = JSON.parse(fs.readFileSync(path.join(workspace, 'internal', 'checkpoints', seatId, `${session}.json`), 'utf8')) as CheckpointState; } catch { record = null; }
  if (record === null) return stop(`This session's closeout record is not complete (closeout: none); run the closeout before chaining.`, { session });
  if (record.seatId !== seatId || record.conversation !== session) return stop(`This session's closeout record is not complete (closeout: another session); run the closeout before chaining.`, { session });
  const attempts = recordedAttempts(record, hub);
  let attempt: string;
  let unit: string;
  if (attempts.length > 0) {
    // A SESSION THAT CHAINED HOLDS SEVERAL UNITS' ATTEMPT PAGES (kickoffs/s213-r5 row 4): the finished unit is the one
    // of the newest attempt-page write. An earlier attempt page stops the chain only when its own Handback has no
    // Outcome: line, a unit this session left unfinished.
    const newest = attempts[attempts.length - 1]!;
    for (const earlier of attempts.slice(0, -1)) {
      let text: string | null = null;
      try { text = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, `${earlier.page}.md`), 'utf8'); } catch { text = null; }
      if (text === null || handbackOutcome(text) === null) {
        return stop(`This session's closeout record also holds ${earlier.page}, ${text === null ? 'which is not on projects/' + hub : 'whose ## Handback has no Outcome: line'}, so this session left that unit unfinished.`, { session, unfinished: earlier.page });
      }
    }
    attempt = newest.page;
    unit = newest.id;
  } else {
    // The pointer-order fallback (kickoffs/s213-r4 row 3; s213-r3's standing answer 12): a record that holds no writes at
    // all (a session whose writes were not tracked) names its unit by the one ticked Run pointer before the first pending
    // one. A record that tracked other writes but no attempt page stops as before.
    const none = `This session's closeout record holds no attempt page notes/<date>-<id>-a<n> written on projects/${hub}, so it names no finished Kickoff to chain from`;
    const writes = Array.isArray(record.writes) ? record.writes : [];
    if (writes.length > 0) return stop(`${none}.`, { session });
    const before = firstPending < 0 ? runs : runs.slice(0, firstPending);
    if (firstPending < 0 || before.length !== 1) return stop(`${none}, and ## Next holds ${firstPending < 0 ? 'no pending Run pointer' : `${before.length} ticked Run pointers before the first pending one, not exactly one`}, so pointer order cannot name it either.`, { session });
    const pointerUnit = kickoffUnit(before[0]!.id);
    const newest = unitAttemptPages(path.join(workspace, 'collection', 'projects', hub), pointerUnit).pop();
    if (newest === undefined) return stop(`${none}; pointer order names Run ${before[0]!.id}, and projects/${hub} holds no attempt page notes/<date>-${pointerUnit}-a<n>.`, { session });
    attempt = newest.page;
    unit = newest.id;
  }

  // 2. The finished Kickoff is the one the attempt page's own Handback says it ran (kickoffs/s213-r4 row 2): an attempt
  // page is named by its unit (`s213-a3`), never by the revision it ran (`Ran: kickoffs/s213-r3`).
  let attemptText: string | null = null;
  try { attemptText = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, `${attempt}.md`), 'utf8'); } catch { attemptText = null; }
  if (attemptText === null) return stop(`This session's record names ${attempt}, and that page is not on projects/${hub}.`, { unit, attempt });
  const ran = handbackRan(attemptText);
  if (ran === null) return stop(`${attempt} has no ## Handback with a Ran: kickoffs/<id> line, so which Kickoff finished is not clear.`, { unit, attempt });
  if (kickoffUnit(ran) !== kickoffUnit(unit)) return stop(`${attempt}'s Handback says Ran: kickoffs/${ran}, a Kickoff of unit ${kickoffUnit(ran)}, and the attempt page is of unit ${kickoffUnit(unit)}.`, { unit, attempt, ran });
  const finished = { id: runs.find((run) => run.id.toLowerCase() === ran.toLowerCase())?.id ?? ran };
  if (runs.some((run) => !run.ticked && run.id.toLowerCase() === ran.toLowerCase())) return stop(`Run ${finished.id} is still pending in ## Next, so this session has not finished it.`, { finished: finished.id, attempt, session });

  // 3. The finished unit is done.
  const outcome = handbackOutcome(attemptText);
  if (outcome === null) return stop(`${attempt} has no ## Handback with an Outcome: line.`, { finished: finished.id, attempt });
  const word = outcome.toLowerCase();
  if (STOPPING_OUTCOMES.includes(word)) return stop(`${attempt}'s Handback says Outcome: ${outcome}, so the unit did not finish; the session ends as it would without a queue.`, { finished: finished.id, attempt });
  if (!FINISHED_OUTCOMES.includes(word)) return stop(`${attempt}'s Handback says Outcome: ${outcome}, which is not one of the loop doc's words (pushed, published, parked, stopped); the session ends as it would without a queue.`, { finished: finished.id, attempt });

  // 4. This session's closeout record is complete. One exact rule (A1-03; kickoffs/s213-r3 row 1): finished means the
  // stored closeout is exactly `done` and closedOutAt is a finite number. A closeout that writes followed is saved as
  // `stale`, which is not done. Only the two stored fields are read, never a derived view (kickoffs/s213-r4 row 1): any
  // other stored value stops, named as stored, so `["done"]` reads as an array and `"done "` shows its space.
  const stored: unknown = record.closeout;
  const closedAt: unknown = record.closedOutAt;
  const finishedCloseout = typeof stored === 'string' && stored === 'done' && typeof closedAt === 'number' && Number.isFinite(closedAt);
  const closeout = finishedCloseout ? 'done' : stored === 'done' ? 'done, with no closedOutAt time' : storedValueText(stored);
  if (closeout !== 'done') return stop(`This session's closeout record is not complete (closeout: ${closeout}); run the closeout before chaining.`, { finished: finished.id, attempt, session });

  // 5. The next pointer exists, and its page is the one it names.
  const next = firstPending < 0 ? undefined : runs[firstPending]!;
  if (next === undefined) return stop(`projects/${hub} has no next pending Run pointer in ## Next.`, { finished: finished.id, attempt });
  const pointerSha = /sha256 `([0-9a-f]{64})`/.exec(next.line)?.[1];
  const nextText = readPage(next.id);
  if (nextText === null) return stop(`The next pointer names kickoffs/${next.id}, and that page is not on projects/${hub}.`, { finished: finished.id, next: next.id });
  const nextSha = pageComparisonSha256(nextText);
  if (pointerSha === undefined) return stop(`The next pointer Run ${next.id} carries no sha256, so its page cannot be matched to it.`, { finished: finished.id, next: next.id });
  if (pointerSha !== nextSha) return stop(`kickoffs/${next.id} has sha256 ${nextSha}, and its pointer carries sha256 ${pointerSha}: the page changed after it was posted.`, { finished: finished.id, next: next.id });

  // 6. Both Kickoffs chain.
  const finishedText = readPage(finished.id);
  if (finishedText === null || !saysChainYes(finishedText)) return stop(`kickoffs/${finished.id} does not say CHAIN: yes, so the unit after it waits for a fresh session.`, { finished: finished.id, next: next.id });
  if (!saysChainYes(nextText)) return stop(`kickoffs/${next.id} does not say CHAIN: yes, so it waits for a fresh session.`, { finished: finished.id, next: next.id });

  // 7. Room in the window, read fresh after the closeout.
  if (options.compacted) return stop('This session was compacted, so the next Kickoff waits for a fresh session.', { finished: finished.id, next: next.id });
  if (Number(percent) >= CHAIN_CONTEXT_LIMIT) return stop(`The context reading is ${Number(percent)}%, at or over ${CHAIN_CONTEXT_LIMIT}%, so the next Kickoff waits for a fresh session.`, { finished: finished.id, next: next.id });

  return { ...answer, decision: 'start', id: next.id, finished: finished.id, attempt, sha256: nextSha,
    next_step: `Run kickoffs/${next.id}'s whole OPEN as a fresh session would: record the standing yes against sha256 ${nextSha}, clean checkout, git fetch, its own row 0 from its own pinned base.` };
}

/** The `## Next` lines that name the Kickoff's link, ticked or not. */
function pointerLines(workspace: string, hub: string, link: string): string[] {
  const next = nextLines(fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8'));
  if (next === null) refuse(`projects/${hub}/_project has no ## Next section for the Kickoff's pointer. Nothing was written.`);
  return next.filter((line) => line.includes(link));
}

/**
 * The ids (lower case) of the Kickoffs a Hub's `## Next` still holds an unticked pointer to: a `- [ ]` line naming
 * `[[projects/<hub>/kickoffs/<id>]]`, the link `pointerLines` finds. Never a refusal: a Hub with no `_project.md` or no
 * `## Next` has none pending (kickoffs/s180 row 2(f); `notebooklinks.ts` reads every other Kickoff page as history).
 */
export function pendingKickoffIds(workspace: string, hub: string): Set<string> {
  const ids = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8');
  } catch {
    return ids;
  }
  const prefix = `[[projects/${hub}/kickoffs/`.toLowerCase();
  for (const line of nextLines(text) ?? []) {
    if (!/^\s*- \[ \]/.test(line)) continue;
    const lower = line.toLowerCase();
    for (let at = lower.indexOf(prefix); at >= 0; at = lower.indexOf(prefix, at + 1)) {
      const id = /^[^\]|/]+/.exec(lower.slice(at + prefix.length))?.[0];
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * A Kickoff's revision number: its header's `Revision: **r<n>**` line (`docs/kickoff-template.md`), else the `-r<n>` its
 * id ends with, else 1, the first revision.
 */
export function kickoffRevision(id: string, text: string): number {
  const stated = /^Revision:\s*\*\*r(\d+)\*\*/m.exec(text)?.[1] ?? /-r(\d+)$/.exec(id)?.[1];
  return stated === undefined ? 1 : Number(stated);
}

function unticked(line: string): string {
  return line.replace(/^(\s*- )\[[ xX]\]/, '$1[ ]');
}

export async function kickoffReceive(options: { letter: string }, workspace: string): Promise<Record<string, PsJsonValue>> {
  const letter = `notes/${kickoffId(options.letter, 'notes', 'receive')}`;
  const { seat, hub } = seatAndHub(workspace, 'receive');
  assertShelfBookOpen(workspace, LETTERS, 'receiving a Kickoff with deskpost kickoff receive', seat);
  const book = getShelfBook(workspace, LETTERS);
  const letterFile = path.join(book.notesPath, `${letter.substring('notes/'.length)}.md`);
  if (!fs.existsSync(letterFile)) refuse(`There is no letter ${letter} in the letters Book. Nothing was written.`);
  const letterText = fs.readFileSync(letterFile, 'utf8');
  const fields = noteFrontmatter(letterText);
  if (fields.get('for_seat') !== seat) refuse(`${letter} is addressed to ${fields.get('for_seat') || 'no seat'}, not to this seat (${seat}). Nothing was written.`);
  // WHAT THE POSTBOX FLAGGED IS NEVER A WORK ORDER (kickoffs/s167 row 2; the audit's B1). Its verdicts are read where it
  // filed them, before any record, page or pointer: a damaged body or a stale address is the sender's to send again.
  if (fields.get('postbox_damaged') === 'true') {
    refuse(`${letter} is filed postbox_damaged: the Postbox found its body does not match the digest the delivery carries, so it may have changed on the way. Ask the sender to send the Kickoff again. Nothing was written.`);
  }
  if (fields.get('stale_delivery') === 'true') {
    refuse(`${letter} is filed stale_delivery: it was addressed to an earlier seat named ${seat}, not this one. Ask the sender to send the Kickoff again. Nothing was written.`);
  }
  const seatId = readSeatRegistry(path.join(workspace, '.claude')).find((row) => row.seat === seat)?.seatId ?? '';
  if (!seatId || fields.get('for_seat_id') !== seatId) {
    refuse(`${letter} is for seat id ${fields.get('for_seat_id') || 'none'}, and this seat (${seat}) is ${seatId || 'not in the seat registry'}: it was addressed to an earlier seat of that name. Ask the sender to send the Kickoff again. Nothing was written.`);
  }
  // THE HASH FIRST: a payload that is not the one sent is refused before anything is written.
  const envelope = parseEnvelope(keptBody(letterText));
  const id = envelope.id;
  const card = fields.get('from_library_card') ?? '';
  const libraryId = fields.get('from_library_id') ?? '';
  const link = `[[projects/${hub}/kickoffs/${id}]]`;
  // THE POINTER READS AS A POSTED ONE (PLAN-hub-redesign.md A1-02; kickoffs/s213 row 4): its revision and the page's
  // sha256, so a builder can match its standing yes against it, then where it came from.
  const pointer = `- [ ] Run ${id}: ${link} (r${kickoffRevision(id, envelope.payload)}, sha256 \`${envelope.sha256}\`, from ${card || 'this Library'})`;
  const pagePath = `projects/${hub}/kickoffs/${id}`;
  const pageFile = path.join(workspace, 'collection', 'projects', hub, 'kickoffs', `${id}.md`);

  const file = recordFile(workspace, id);
  let record: ReceiveRecord;
  if (fs.existsSync(file)) {
    record = JSON.parse(fs.readFileSync(file, 'utf8')) as ReceiveRecord;
    if (record.letter !== letter || record.sha256 !== envelope.sha256 || record.hub !== hub) {
      refuse(`internal/kickoffs/${id}.json records the Kickoff ${id} from ${record.letter} (sha256 ${record.sha256}) on projects/${record.hub}, not ${letter} (sha256 ${envelope.sha256}) on projects/${hub}. Nothing was written.`);
    }
  } else {
    if (fields.get('review') !== 'pending') refuse(`${letter} is already closed, and no receive of it is recorded here. Nothing was written.`);
    record = {
      schema: 1,
      kind: 'kickoff-receive',
      kickoff_id: id,
      letter,
      hub,
      sha256: envelope.sha256,
      bytes: envelope.bytes,
      from_library_card: card,
      from_library_id: libraryId,
      identities: { pages: [pagePath], letter },
      stages: [{ name: 'page', state: 'pending', proof: null }, { name: 'pointer', state: 'pending', proof: null }, { name: 'close', state: 'pending', proof: null }],
      created_utc: utcSeconds(),
      completed_utc: null,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  const done = (name: StageName): boolean => record.stages.find((row) => row.name === name)!.state === 'done';
  const pageMatches = (): boolean => fs.existsSync(pageFile) && pageComparisonSha256(fs.readFileSync(pageFile, 'utf8')) === envelope.sha256;
  const stagesRun: string[] = [];
  const judge = (lines: string[]): 'absent' | 'present' => {
    if (lines.length === 0) return 'absent';
    if (lines.length > 1) refuse(`## Next on projects/${hub}/_project names ${link} ${lines.length} times: ${lines.join(' | ')}. Nothing was written.`);
    if (unticked(lines[0]!) !== pointer) refuse(`## Next on projects/${hub}/_project already names ${link} with other text: ${lines[0]}. It was not changed.`);
    return 'present';
  };
  const pointerArgs = [`projects/${hub}`, '--mode', 'append-section', '--section', 'Next', '--content', pointer];

  // THE POINTER'S REFUSALS BEFORE THE PAGE (kickoffs/s198 row 1): a pointer the stage would refuse (the same link with
  // other text, or a Run line over `hub edit`'s pending cap: one, or three on a dev Hub, appended last; kickoffs/s213
  // row 4) leaves no Kickoff page and no stage done.
  // A FULL QUEUE NAMES ITS REMEDY AND THE WAY BACK (kickoffs/s219 row 4): `hub edit`'s Run-pointer refusal names the
  // `check-item` and `--supersedes` commands; receive passes it on with the one command it takes to try again.
  const pointerEdit = async (args: string[]): ReturnType<typeof hubEdit> => {
    try { return await hubEdit(args, workspace); } catch (error) {
      const message = (error as Error).message ?? '';
      if (/pending Run pointer/.test(message)) refuse(`${message} Then run deskpost kickoff receive ${letter} again.`);
      throw error;
    }
  };
  if (!done('pointer') && judge(pointerLines(workspace, hub, link)) === 'absent') await pointerEdit([...pointerArgs, '--preflight']);

  if (!done('page')) {
    if (fs.existsSync(pageFile)) {
      if (!pageMatches()) {
        refuse(`${pagePath} is already on this Hub and its bytes are not the Kickoff's (sha256 ${pageComparisonSha256(fs.readFileSync(pageFile, 'utf8'))}, not ${envelope.sha256}): it was not overwritten. Nothing was written.`);
      }
    } else {
      hubNewPage({ slug: hub, page: `kickoffs/${id}`, content: envelope.payload, contentPath: '', title: `Kickoff ${id}`, seat: undefined, preflight: false, lockTimeout: 20, received: true }, workspace);
      if (!pageMatches()) refuse(`${pagePath} was written but does not hash to ${envelope.sha256}.`);
    }
    complete(workspace, record, 'page', `${pagePath} sha256 ${envelope.sha256}`);
    stagesRun.push('page');
  }

  if (!done('pointer')) {
    if (judge(pointerLines(workspace, hub, link)) === 'absent') {
      // THE CHECK AND THE APPEND BOUND TOGETHER: the preflight's plan id is over the page this check reads, and the apply
      // refuses a page that changed after it, so no other writer's pointer slips in between.
      const args = pointerArgs;
      const preview = await pointerEdit([...args, '--preflight']);
      const pageNow = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8');
      if (pageComparisonSha256(pageNow) !== preview['current_sha256']) refuse(`projects/${hub}/_project changed while the pointer was being planned. Run deskpost kickoff receive ${letter} again.`);
      if (judge(pointerLines(workspace, hub, link)) === 'absent') {
        await pointerEdit([...args, '--plan-id', String(preview['plan_id'])]);
        fault('pointer-write');
      }
    }
    const seen = pointerLines(workspace, hub, link);
    if (seen.length !== 1 || unticked(seen[0]!) !== pointer) refuse(`## Next on projects/${hub}/_project does not hold exactly the one pointer ${pointer}.`);
    complete(workspace, record, 'pointer', seen[0]!);
    stagesRun.push('pointer');
  }

  if (!done('close')) {
    // BOTH ON DISK FIRST: the letter is the last thing to change.
    if (!pageMatches()) refuse(`${pagePath} no longer hashes to ${envelope.sha256}, so ${letter} was left open.`);
    if (pointerLines(workspace, hub, link).length !== 1) refuse(`## Next on projects/${hub}/_project no longer holds the one pointer, so ${letter} was left open.`);
    const now = noteFrontmatter(fs.readFileSync(letterFile, 'utf8'));
    if (now.get('review') !== 'done') {
      const closed = lettersCloseVerb([letter, '--note', `kickoff receive: ${pagePath} written and its Run pointer added`], workspace);
      if (closed.refusal !== null) refuse(closed.refusal);
    }
    complete(workspace, record, 'close', `${letter} review: done`);
    stagesRun.push('close');
  }

  return {
    schema: 1,
    operation: 'Receive a Kickoff',
    status: stagesRun.length === 0 ? 'already-received' : 'received',
    kickoff: pagePath,
    sha256: envelope.sha256,
    bytes: envelope.bytes,
    pointer,
    letter,
    from_library_card: card || null,
    from_library_id: libraryId || null,
    record: `internal/kickoffs/${id}.json`,
    stages_run: stagesRun,
    next: `Run the Kickoff from its pointer: its OPEN takes one yes over ${pagePath} at sha256 ${envelope.sha256}.`,
  };
}
