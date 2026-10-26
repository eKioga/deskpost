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
 *   pointer  `- [ ] Run <id>: [[projects/<hub>/kickoffs/<id>]] (from <card>)` in `## Next`, appended only when the
 *            link is absent, under the plan id of the page as checked, so a page that changed after the check refuses;
 *            the stage is done only after a fresh read sees exactly one pointer;
 *   close    the letter closed, last, after the page and the pointer are both verified on disk.
 *
 * The record is kept apart from `intent.ts`'s folders on purpose: postbox recovery runs every outstanding record there
 * through the Report stage runners, and a receive is no delivery of theirs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureVerb, lettersCloseVerb } from './capture.ts';
import { readSeatRegistry } from './desk.ts';
import { writeAtomicText } from './fsx.ts';
import { hubEdit } from './hubedit.ts';
import { hubNewPage } from './hubnewpage.ts';
import { buildEnvelope, KICKOFF_ID, parseEnvelope } from './kickoffenvelope.ts';
import { keptBody, readOutbox, resolveRemoteSeat, sendAfterCapture } from './postbox.ts';
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

/** The `## Next` lines that name the Kickoff's link, ticked or not. */
function pointerLines(workspace: string, hub: string, link: string): string[] {
  const text = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##[ \t]+Next[ \t]*$/.test(line));
  if (start < 0) refuse(`projects/${hub}/_project has no ## Next section for the Kickoff's pointer. Nothing was written.`);
  let end = lines.findIndex((line, index) => index > start && /^##[ \t]/.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).filter((line) => line.includes(link));
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
  // THE HASH FIRST: a payload that is not the one sent is refused before anything is written.
  const envelope = parseEnvelope(keptBody(letterText));
  const id = envelope.id;
  const card = fields.get('from_library_card') ?? '';
  const link = `[[projects/${hub}/kickoffs/${id}]]`;
  const pointer = `- [ ] Run ${id}: ${link} (from ${card || 'this Library'})`;
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

  if (!done('page')) {
    if (fs.existsSync(pageFile)) {
      if (!pageMatches()) {
        refuse(`${pagePath} is already on this Hub and its bytes are not the Kickoff's (sha256 ${pageComparisonSha256(fs.readFileSync(pageFile, 'utf8'))}, not ${envelope.sha256}): it was not overwritten. Nothing was written.`);
      }
    } else {
      hubNewPage({ slug: hub, page: `kickoffs/${id}`, content: envelope.payload, contentPath: '', title: `Kickoff ${id}`, seat: undefined, preflight: false, lockTimeout: 20 }, workspace);
      if (!pageMatches()) refuse(`${pagePath} was written but does not hash to ${envelope.sha256}.`);
    }
    complete(workspace, record, 'page', `${pagePath} sha256 ${envelope.sha256}`);
    stagesRun.push('page');
  }

  if (!done('pointer')) {
    const judge = (lines: string[]): 'absent' | 'present' => {
      if (lines.length === 0) return 'absent';
      if (lines.length > 1) refuse(`## Next on projects/${hub}/_project names ${link} ${lines.length} times: ${lines.join(' | ')}. Nothing was written.`);
      if (unticked(lines[0]!) !== pointer) refuse(`## Next on projects/${hub}/_project already names ${link} with other text: ${lines[0]}. It was not changed.`);
      return 'present';
    };
    if (judge(pointerLines(workspace, hub, link)) === 'absent') {
      // THE CHECK AND THE APPEND BOUND TOGETHER: the preflight's plan id is over the page this check reads, and the apply
      // refuses a page that changed after it, so no other writer's pointer slips in between.
      const args = [`projects/${hub}`, '--mode', 'append-section', '--section', 'Next', '--content', pointer];
      const preview = await hubEdit([...args, '--preflight'], workspace);
      const pageNow = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8');
      if (pageComparisonSha256(pageNow) !== preview['current_sha256']) refuse(`projects/${hub}/_project changed while the pointer was being planned. Run deskpost kickoff receive ${letter} again.`);
      if (judge(pointerLines(workspace, hub, link)) === 'absent') {
        await hubEdit([...args, '--plan-id', String(preview['plan_id'])], workspace);
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
    record: `internal/kickoffs/${id}.json`,
    stages_run: stagesRun,
    next: `Run the Kickoff from its pointer: its OPEN takes one yes over ${pagePath} at sha256 ${envelope.sha256}.`,
  };
}
