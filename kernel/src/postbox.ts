/**
 * `deskpost postbox`: a Library's PLACE IN THE POSTBOX (kickoffs/s121 row 9; PLAN-many-libraries.md Stage 1 items 2 and
 * 7; ADR-0080). Libraries pass letters through one Basic Memory project, the Deskpost project; each Library keeps an
 * entry there, `postbox/libraries/<library-id>.md`, naming its id, its card, when it last checked, and each seat here
 * that may receive letters. It sets a Library up, resolves an address, and (kickoffs/s123) sends a letter to another
 * Library exactly once by its path and files a letter from one exactly once by its delivery id.
 *
 * THE CARRIER BOUNDARY (plan item 7). This is the only module that knows Basic Memory carries letters. The entry, the
 * address rule and (session 2) the delivery id, digest, outbox and receive rules are the carrier's contract, so a
 * shared folder could replace Basic Memory later without touching letters.
 *
 * WHAT SETUP TOUCHES, AND NOTHING ELSE. It reads the server's project list, creates the Deskpost project only on the yes
 * its preflight named, writes this Library's entry with `overwrite: false` (or refreshes its own entry), records the
 * project's UUID as the connection's `collection_id` when no connection is recorded, and caches what it did in
 * `internal/postbox/state.json`. It never reads, moves or changes another project, nor anything outside `postbox/`.
 *
 * WHAT THE REAL SERVER DOES (B's Stage 0 probes, 2026-10-15, `projects/deskpost-desk/notes/2026-10-15-stage0-probes`):
 *   - S6: a title in `[a-z0-9-]` becomes the file name exactly, so `postbox/libraries/<library-id>.md` and
 *     `postbox/inbox/<recipient-id>/<delivery-id>.md` are their own titles;
 *   - S5: `metadata` keys come back as frontmatter keys beside the `title`, `type`, `permalink` and `tags` the server
 *     adds; a body that opens with `---` is merged into the frontmatter; a plain body reads back with one leading
 *     newline. So Deskpost's fields go as `metadata`, a body never opens with `---`, and the entry is parsed from the
 *     frontmatter in `content`;
 *   - S7: the server keeps a `metadata` string's value, not its text: a timestamp, or a value with `: `, `'` or `#`,
 *     comes back single-quoted with `''` inside (`unquoted`, `sameInstant`);
 *   - S6: after `move_note`, `read_note` on the old path answers the moved note, even once a new file is written there;
 *   - S1: `write_note` with `overwrite: false` on an existing path is `action: "conflict"`, `NOTE_ALREADY_EXISTS`;
 *   - `create_memory_project` takes `project_name` and `project_path` and answers `{created, already_exists,
 *     external_id}`.
 * AND (B's probe of the real server, 2026-10-17, `projects/deskpost-desk/notes/2026-10-17-postbox-probes`), which
 * corrects S6's reading of `read_content`:
 *   - 3: `read_content` of a path with no file, in a folder that holds notes, answers ANOTHER note from that folder,
 *     `isError: false`; only a folder with no notes answers "not found";
 *   - 4: `read_content` by a path follows the permalink first, so a moved note's old path answers the moved note even
 *     once a new file is there; a note's own permalink, with or without the project's name in front, answers it;
 *   - 5: `move_note` by an identifier that resolves to a note already in the destination answers
 *     `DESTINATION_SAME_AS_SOURCE`;
 *   - 6: `list_directory` answers `{nodes, page, page_size, total, has_more}`, each file with `file_path`, `permalink`,
 *     `external_id` and `updated_at`; a missing folder lists empty. It is the one call that reports the files actually
 *     at each path.
 * SO PRESENCE IS JUDGED BY LISTING (kickoffs/s131): whether a file is at a path is `list_directory` of its folder; a
 * listed file is read by its node's permalink and trusted only when its own `permalink:` line matches; a move names
 * the file by its permalink. UNPROBED: paging past 200, which this release refuses.
 */

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { writeAtomicText } from './fsx.ts';
import { sha256OfText } from './sha.ts';
import { strayControlRefusal } from './controlchars.ts';
import { markerField, markerPath, readMarker, withMarkerLock } from './workspace.ts';
import { BasicMemoryRefusal, isLocalBackend, markerConnection, McpSession, moveNoteTo, noteBody, readExactOrNull, readPermalinkContent, sendWrite } from './basicmemory.ts';
import { recover, readRecords, completeStage, removeCompleted, ControlMovePending, controlTransportUnreachable, recordPendingControlMove } from './intent.ts';
import { reportStageRunner, receiveReportOutcome, receiveReportControl } from './reportsend.ts';
import { captureVerb } from './capture.ts';
import { listServerProjects } from './bmconnection.ts';
import { getShelfBook } from './shelfbook.ts';
import { readSeatIdentityView } from './seatincarnation.ts';

export class PostboxRefusal extends Error {}

function refuse(message: string): never {
  throw new PostboxRefusal(message);
}

const DEFAULT_PROJECT = 'deskpost';
const ENTRY_DIRECTORY = 'postbox/libraries';
const LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = LIBRARY_ID;
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

function utcSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- the entry ------------------------------------------------------------------------------------------------------

/** A seat here that may receive letters, as the entry lists it. */
export interface PostboxSeat {
  seat: string;
  seat_id: string;
}

/** One Library's Postbox entry, as read back from the server. */
export interface PostboxEntry {
  library_id: string;
  library_card: string;
  last_check: string;
  seats: PostboxSeat[];
  /** The seat here that triages Reports for every Library (kickoffs/s143 row 2), or null when the entry names none. */
  reportsTriagedBy: PostboxSeat | null;
  /** The fields the entry carries in a form this program does not read, each read as absent (`reports_triaged_by`). */
  malformed: string[];
  path: string;
}

export function entryPath(libraryId: string): string {
  return `${ENTRY_DIRECTORY}/${libraryId}.md`;
}

const SEATS_HEADING = 'Seats that may receive letters';
const TRIAGER_HEADING = 'Reports are triaged by';
const SEAT_LINE = /^- ([a-z0-9][a-z0-9-]*) \(seat_id ([0-9a-f]{32})\)$/;

/** `<seat> (seat_id <32hex>)`, the triaging seat as the entry's metadata and body name it. */
function triagerText(seat: PostboxSeat): string {
  return `${seat.seat} (seat_id ${seat.seat_id})`;
}

/** A `{seat, seat_id}` read from a cache or an entry, or null when it is not one. */
function asSeat(value: unknown): PostboxSeat | null {
  const seat = field(value, 'seat');
  const seatId = field(value, 'seat_id');
  return typeof seat === 'string' && typeof seatId === 'string' && SEAT_SLUG.test(seat) && /^[0-9a-f]{32}$/.test(seatId) ? { seat, seat_id: seatId } : null;
}

/** Whether two triaging seats are the same, null (or absent, as in a cache from before s143) equal to null. */
function sameTriager(left: unknown, right: unknown): boolean {
  const a = asSeat(left);
  const b = asSeat(right);
  return a === null || b === null ? a === b : a.seat === b.seat && a.seat_id === b.seat_id;
}

/**
 * THE ENTRY'S FIELDS GO AS `write_note` METADATA, AND ITS BODY NEVER OPENS WITH `---` (kickoffs/s122 row 3; B's probes
 * S5 and S7). The server keeps metadata as frontmatter, the value and not the text: a string YAML must quote comes
 * back single-quoted. A body's own `---` block is merged into the frontmatter instead, and a timestamp in it comes back
 * as a YAML timestamp (`2026-10-15 21:40:00+00:00`), so s121's body-block entry would have refused its own readback.
 */
export function entryMetadata(libraryId: string, card: string, lastCheck: string, triagedBy: PostboxSeat | null = null): Record<string, string> {
  return { library_id: libraryId, library_card: card, last_check: lastCheck, ...(triagedBy ? { reports_triaged_by: triagerText(triagedBy) } : {}) };
}

/**
 * The entry's body: a line for a person, the seats, and the seat that triages Reports (kickoffs/s143 row 2), `- (none)`
 * when there is none. The fields are `entryMetadata`'s.
 */
export function entryText(card: string, seats: PostboxSeat[], triagedBy: PostboxSeat | null = null): string {
  return [
    `# ${card}`,
    '',
    "This Library's Postbox entry, written by Deskpost. Letters for it are addressed by its id, or by this card while no other Library has it.",
    '',
    `## ${SEATS_HEADING}`,
    '',
    ...(seats.length ? seats.map((row) => `- ${triagerText(row)}`) : ['- (none)']),
    '',
    `## ${TRIAGER_HEADING}`,
    '',
    triagedBy ? `- ${triagedBy.seat}, seat_id ${triagedBy.seat_id}` : '- (none)',
    '',
  ].join('\n');
}

/**
 * One frontmatter value as the server returns a plain string (probe S7): one pair of single quotes stripped and `''`
 * read as `'`, or one pair of double quotes stripped; anything else as it stands.
 */
function unquoted(raw: string): string {
  const single = /^'([\s\S]*)'$/.exec(raw);
  if (single) return single[1]!.replace(/''/g, "'");
  const double = /^"([\s\S]*)"$/.exec(raw);
  if (double) return double[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return raw;
}

/**
 * Two times as the same instant, whatever form the server gave back (`2026-10-15T21:40:00Z` sent may return as
 * `2026-10-15 21:40:00+00:00`). UNPROBED (kickoffs/s122 STANDING ANSWER 9): S7 measured a timestamp sent as metadata
 * come back quoted and unchanged; any other round trip is assumed to keep the instant, and left for B's probe.
 */
export function sameInstant(left: string, right: string): boolean {
  const parse = (value: string) => Date.parse(/^\d{4}-\d\d-\d\d \d/.test(value) ? value.replace(' ', 'T') : value);
  const a = parse(left);
  return !Number.isNaN(a) && a === parse(right);
}

/**
 * An entry's fields, from the frontmatter as the server returns it in `content`, or null when it is not one. Keys the
 * server adds (`title`, `type`, `permalink`, `tags`) and any others are ignored; the seats are read from the body.
 *
 * THE BODY BY ITS SECTIONS (kickoffs/s143 row 2): the seats from `## Seats that may receive letters` (the whole body when
 * an entry has no such heading), the triaging seat from `## Reports are triaged by`. That section holds one line: `- (none)`
 * or one seat; anything else reads as no triaging seat and is named in `malformed`. A 1.5.0 entry has no such section and
 * reads with none.
 */
export function parseEntry(content: string, filePath: string): PostboxEntry | null {
  const text = content.replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!front) return null;
  const value = (key: string) => unquoted(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(front[1]!)?.[1] ?? '');
  const id = value('library_id');
  if (!LIBRARY_ID.test(id)) return null;
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.slice(front[0].length).split('\n')) {
    const heading = /^## (.+?)[ \t]*$/.exec(line);
    if (heading) sections.set(heading[1]!, (current = []));
    else if (current !== null && line.trim()) current.push(line.trim());
  }
  const seatLines = sections.get(SEATS_HEADING) ?? text.split('\n');
  const seats = seatLines.flatMap((line) => {
    const match = SEAT_LINE.exec(line);
    return match ? [{ seat: match[1]!, seat_id: match[2]! }] : [];
  });
  const malformed: string[] = [];
  let reportsTriagedBy: PostboxSeat | null = null;
  const triager = sections.get(TRIAGER_HEADING);
  if (triager !== undefined) {
    const match = triager.length === 1 ? /^- ([a-z0-9][a-z0-9-]*), seat_id ([0-9a-f]{32})$/.exec(triager[0]!) ?? SEAT_LINE.exec(triager[0]!) : null;
    if (match) reportsTriagedBy = { seat: match[1]!, seat_id: match[2]! };
    else if (!(triager.length === 1 && triager[0] === '- (none)')) malformed.push('reports_triaged_by');
  }
  return { library_id: id, library_card: value('library_card'), last_check: value('last_check'), seats, reportsTriagedBy, malformed, path: filePath };
}

/**
 * THIS LIBRARY'S OWN TRIAGING SEAT, as its cache records it (`reports_triager` with this Library's id, kickoffs/s143 rows 2
 * and 3), checked against the seats here now: `dropped` names one whose registry row is gone or whose id changed.
 */
function ownTriager(state: Record<string, unknown> | null, libraryId: string, seats: PostboxSeat[]): { triager: PostboxSeat | null; dropped: PostboxSeat | null } {
  const recorded = state?.['reports_triager'];
  if (field(recorded, 'library_id') !== libraryId) return { triager: null, dropped: null };
  const seat = asSeat(recorded);
  if (seat === null) return { triager: null, dropped: null };
  return seats.some((row) => row.seat === seat.seat && row.seat_id === seat.seat_id) ? { triager: seat, dropped: null } : { triager: null, dropped: seat };
}

/** The seats here that may receive letters: every live registry row with a valid seat_id. */
function receivingSeats(workspace: string): PostboxSeat[] {
  const view = readSeatIdentityView(path.join(workspace, '.claude'));
  return view.live
    .filter((row) => row.identity === 'valid' && /^[0-9a-f]{32}$/.test(row.seatId))
    .map((row) => ({ seat: row.seat, seat_id: row.seatId }))
    .sort((left, right) => left.seat.localeCompare(right.seat, 'en'));
}

/**
 * Whether two seat lists are the same sorted `{seat, seat_id}` pairs (kickoffs/s128 STANDING ANSWER 9). A list that is
 * not one, as in a cache from before s128 with no `seats`, is never the same, so the first check refreshes once.
 */
function sameSeats(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((row, at) => field(row, 'seat') === field(right[at], 'seat') && field(row, 'seat_id') === field(right[at], 'seat_id'));
}

// --- the server -----------------------------------------------------------------------------------------------------

/** Every `*.md` under `postbox/libraries/`, from one listing page (an assumption left for the probes: see the header). */
async function listEntryPaths(session: McpSession, projectId: string): Promise<string[]> {
  const response = await session.callTool('list_directory', { project_id: projectId, dir_name: ENTRY_DIRECTORY, depth: 1, page: 1, page_size: 200, output_format: 'json' });
  const result = field(field(field(response, 'result'), 'structuredContent'), 'result');
  if (field(field(response, 'result'), 'isError') === true || result === undefined || result === null) {
    const detail = JSON.stringify(field(field(response, 'result'), 'content') ?? field(response, 'error') ?? null);
    if (/not found|does not exist|no such/i.test(detail)) return [];
    refuse(`The Postbox's list of Libraries could not be read: ${detail.substring(0, 300)}`);
  }
  if (field(result, 'has_more') === true) refuse('The Postbox lists more than 200 Libraries, and this release reads one page. Nothing was changed.');
  const nodes = field(result, 'nodes');
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => field(node, 'type') === 'file')
    .map((node) => String(field(node, 'file_path') ?? ''))
    .filter((file) => file.startsWith(`${ENTRY_DIRECTORY}/`) && file.endsWith('.md'))
    .sort();
}

/** Every Library's entry in the Postbox, read back one by one; a note that is not an entry is skipped and named. */
export async function readEntries(session: McpSession, projectId: string): Promise<{ entries: PostboxEntry[]; unreadable: string[] }> {
  const entries: PostboxEntry[] = [];
  const unreadable: string[] = [];
  for (const file of await listEntryPaths(session, projectId)) {
    const record = await readExactOrNull(session, projectId, file, { includeFrontmatter: true, stopped: 'the Postbox read stopped' });
    const entry = record === null ? null : parseEntry(record.content, file);
    if (entry === null) unreadable.push(file);
    else entries.push(entry);
  }
  return { entries, unreadable };
}

/**
 * AN ADDRESS IS ONE REGISTERED LIBRARY (plan item 2, last bullet): its id, or a card that matches exactly one entry
 * (compared without regard to case, so a card cannot be squatted by changing its case). None or several is refused
 * with the list. A letter is never queued to an unregistered id.
 */
export function resolveAddress(entries: PostboxEntry[], address: string): PostboxEntry {
  const wanted = address.trim();
  const listed = entries.map((entry) => `${entry.library_card || '(no card)'} (${entry.library_id})`).join(', ') || '(none)';
  if (!wanted) refuse(`Name a Library by its id or its card. The Postbox has: ${listed}.`);
  if (LIBRARY_ID.test(wanted.toLowerCase())) {
    const byId = entries.find((entry) => entry.library_id === wanted.toLowerCase());
    if (byId) return byId;
    refuse(`No Library with id ${wanted.toLowerCase()} is in the Postbox, and a letter is never sent to an unregistered id. The Postbox has: ${listed}.`);
  }
  const byCard = entries.filter((entry) => entry.library_card.toLowerCase() === wanted.toLowerCase());
  if (byCard.length === 1) return byCard[0]!;
  if (byCard.length > 1) {
    refuse(`The card '${wanted}' names ${byCard.length} Libraries: ${byCard.map((entry) => entry.library_id).join(', ')}. Address one by its id.`);
  }
  refuse(`No Library in the Postbox has the card '${wanted}'. The Postbox has: ${listed}.`);
}

// --- the cache ------------------------------------------------------------------------------------------------------

function statePath(workspace: string): string {
  return path.join(workspace, 'internal', 'postbox', 'state.json');
}

function readState(workspace: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(workspace), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- setup ----------------------------------------------------------------------------------------------------------

interface SetupPlan {
  value: Record<string, PsJsonValue>;
  session: McpSession;
  projectId: string | null;
  connectionAction: 'keep' | 'record';
  entryAction: 'create' | 'refresh';
}

async function planSetup(parsed: ReturnType<typeof parseArguments>, workspace: string): Promise<SetupPlan> {
  const marker = readMarker(workspace);
  if (marker === null) refuse(`${workspace} has no Library marker. Run deskpost init first.`);
  if (!isLocalBackend(workspace)) refuse('deskpost postbox setup is for a local Library; this workspace keeps its collection in Basic Memory, whose route is not the Postbox.');
  const libraryId = markerField(marker, 'id').trim().toLowerCase();
  if (!LIBRARY_ID.test(libraryId)) refuse(`${markerPath(workspace)} has no Library id in the GUID form a Postbox entry is named by.`);
  try {
    getShelfBook(workspace, 'letters');
  } catch {
    refuse(`This Library has no letters Book, and the Postbox files the letters it receives there. Add it with deskpost init ${workspace}, then run setup again. Nothing was written.`);
  }
  const card = markerField(marker, 'card').trim();
  if (!card) refuse('This Library has no card, and its Postbox entry names it by one. Set it first: deskpost library card --set <name> --preflight. Nothing was written.');

  const connection = markerConnection(workspace);
  const url = (parsed.options.get('url') ?? connection?.url ?? '').trim();
  if (!url) refuse("deskpost postbox setup needs --url <the Basic Memory server's MCP URL>.");
  if (!/^https?:\/\/[^\s]+$/.test(url)) refuse(`The Postbox server URL must be an absolute http or https URL; got '${url}'.`);
  if (connection !== null && connection.url !== url) {
    refuse(`This Library's Basic Memory connection is to ${connection.url}, and the Postbox would be at ${url}. One Library keeps one Deskpost server; change the connection with deskpost basic-memory setup first. Nothing was written.`);
  }
  const projectName = (parsed.options.get('project') ?? DEFAULT_PROJECT).trim();
  if (!PROJECT_NAME.test(projectName)) refuse(`--project must be a project name in lowercase letters, digits and hyphens; got '${projectName}'.`);

  const session = new McpSession(url, 'deskpost-postbox');
  try {
    await session.initialize();
  } catch (error) {
    refuse(`Nothing was written. The Postbox server ${url} did not answer: ${(error as Error).message}`);
  }
  // THE PROJECT FROM THE SERVER'S OWN LIST, BY NAME, KEPT BY UUID (ADR-0050). No other project is read.
  const projects = await listServerProjects(session);
  const chosen = projects.find((project) => project.name === projectName) ?? null;
  if (chosen !== null && !UUID.test(chosen.id)) refuse(`The server lists '${projectName}' with no UUID ('${chosen.id}'), and the Postbox records its project by one.`);
  const recorded = connection?.collection_id ?? '';
  if (recorded && (chosen === null || chosen.id !== recorded)) {
    refuse(
      `This Library's connection already records the project ${recorded}${connection?.collection_name ? ` ('${connection.collection_name}')` : ''}, and the Postbox ` +
        `would use ${chosen === null ? `a new project '${projectName}'` : `'${chosen.name}' (${chosen.id})`}. One Library keeps everything Deskpost puts in Basic Memory in ` +
        'one project: choose that one with --project, or change the connection with deskpost basic-memory setup. Nothing was written.',
    );
  }

  // THE CARD IS THIS LIBRARY'S ALONE IN THE POSTBOX; the id never changes (plan item 2, second bullet).
  let entryAction: 'create' | 'refresh' = 'create';
  if (chosen !== null) {
    const { entries } = await readEntries(session, chosen.id);
    const taken = entries.find((entry) => entry.library_id !== libraryId && entry.library_card.toLowerCase() === card.toLowerCase());
    if (taken) {
      refuse(`The card '${card}' is already the Postbox entry of another Library, ${taken.library_id}. Choose another card with deskpost library card --set <name> --preflight; this Library's id never changes. Nothing was written.`);
    }
    if (entries.some((entry) => entry.library_id === libraryId)) entryAction = 'refresh';
  }
  const seats = receivingSeats(workspace);
  const connectionAction: 'keep' | 'record' = recorded ? 'keep' : 'record';
  const essentials = { workspace, libraryId, card, url, projectName, projectId: chosen?.id ?? null, connectionAction, entryAction, seats };
  const planId = 'postbox-setup-' + sha256OfText(JSON.stringify(essentials));
  const writes = [
    ...(chosen === null ? [`create the Basic Memory project '${projectName}' on ${url}`] : []),
    `${entryAction === 'create' ? 'write' : 'refresh'} this Library's Postbox entry, ${entryPath(libraryId)}${entryAction === 'create' ? ', never over another note' : ''}`,
    ...(connectionAction === 'record' ? [`record the project's UUID as this Library's Basic Memory connection in ${markerPath(workspace)}`] : []),
    `cache the result in ${statePath(workspace)}`,
  ];
  return {
    session,
    projectId: chosen?.id ?? null,
    connectionAction,
    entryAction,
    value: {
      schema: 1,
      operation: 'Set up the Postbox',
      workspace,
      library_id: libraryId,
      library_card: card,
      url,
      project_name: projectName,
      project_id: chosen?.id ?? null,
      project_action: chosen === null ? 'create' : 'use',
      connection_action: connectionAction,
      entry_path: entryPath(libraryId),
      entry_action: entryAction,
      seats: seats as unknown as PsJsonValue,
      writes,
      plan_id: planId,
      confirmation_required: true,
      shared_library_write: true,
      note: "Setup reads, moves and changes no other project on the server, and nothing outside postbox/. The card is a label: letters are addressed by this Library's id, or by its card while no other Library has it.",
    },
  };
}

async function setup(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('postbox', 'setup'));
  const plan = await planSetup(parsed, workspace);
  if (parsed.flags.has('preflight')) return { ...plan.value, written: false };
  if (!parsed.flags.has('user-confirmed') || (parsed.options.get('plan-id') ?? '').trim() !== plan.value['plan_id']) {
    refuse(
      'deskpost postbox setup writes to a server, so it needs --preflight first, then --user-confirmed --plan-id <its plan_id>. A different plan_id ' +
        'means the Library, the server or the Postbox changed since the preview. Nothing was written.',
    );
  }
  const { session } = plan;
  const libraryId = String(plan.value['library_id']);
  const card = String(plan.value['library_card']);
  const projectName = String(plan.value['project_name']);

  // 1. The project, created only on this yes.
  let projectId = plan.projectId;
  if (projectId === null) {
    const sent = await sendWrite(session, 'create_memory_project', { project_name: projectName, project_path: projectName }, `Creating the project '${projectName}'`);
    const record = field(field(field(sent.response, 'result'), 'structuredContent'), 'result');
    let said = String(field(record, 'external_id') ?? '');
    // A dropped session or an answer without the id: the server's own list is the readback.
    if (!UUID.test(said)) said = (await listServerProjects(session)).find((project) => project.name === projectName)?.id ?? '';
    if (!UUID.test(said)) refuse(`The project '${projectName}' was asked for and does not appear in the server's list with a UUID. Nothing else was written.`);
    projectId = said;
  }

  // 2. The entry: written with overwrite false, or this Library's own refreshed; then read back.
  const lastCheck = utcSeconds();
  const seats = plan.value['seats'] as unknown as PostboxSeat[];
  // A SETUP RUN AGAIN KEEPS THE TRIAGING SEAT this Library named, while that seat is still here (kickoffs/s143 row 2).
  const previous = readState(workspace);
  const triagedBy = ownTriager(previous, libraryId, seats).triager;
  const text = entryText(card, seats, triagedBy);
  const target = entryPath(libraryId);
  const sent = await sendWrite(
    session,
    'write_note',
    {
      project_id: projectId,
      directory: ENTRY_DIRECTORY,
      title: libraryId,
      content: text,
      metadata: entryMetadata(libraryId, card, lastCheck, triagedBy),
      note_type: 'note',
      overwrite: plan.entryAction === 'refresh',
      output_format: 'json',
    },
    `Writing the Postbox entry ${target}`,
  );
  const back = await readExactOrNull(session, projectId, target, { includeFrontmatter: true, stopped: 'the Postbox setup stopped' });
  const entry = back === null ? null : parseEntry(back.content, target);
  if (entry === null || entry.library_id !== libraryId || entry.library_card !== card || !sameInstant(entry.last_check, lastCheck) || !sameSeats(entry.seats, seats) || !sameTriager(entry.reportsTriagedBy, triagedBy)) {
    refuse(
      `${target} did not read back as this Library's entry${sent.dropped ? ' after its session dropped (it was not sent again)' : ''}. Run setup again; ` +
        `${back === null ? 'nothing is there' : `what is there: ${noteBody(back).substring(0, 200)}`}.`,
    );
  }

  // 3. The connection, recorded only when none was: the project by UUID (ADR-0050).
  if (plan.connectionAction === 'record') {
    // INSIDE THE MARKER LOCK, from the marker as read there (kickoffs/s161 row 1): a project recorded since the plan is
    // refused, and every other field and connection another writer left is kept.
    withMarkerLock(workspace, (marker) => {
      if (marker === null || (markerConnection(workspace)?.collection_id ?? '') !== '') {
        refuse(`${markerPath(workspace)} recorded a Basic Memory project after this setup was planned, so the connection was not written. The Postbox entry is written; run setup again.`);
      }
      const connections = field(marker, 'connections');
      const others = connections !== null && typeof connections === 'object' && !Array.isArray(connections) ? { ...(connections as Record<string, unknown>) } : {};
      others['basic_memory'] = { url: String(plan.value['url']), collection_id: projectId, collection_name: projectName, storage: '' };
      writeAtomicText(markerPath(workspace), psConvertToJson({ ...marker, connections: others } as PsJsonValue) + '\n');
    });
    if (markerConnection(workspace)?.collection_id !== projectId) refuse(`The connection was written to ${markerPath(workspace)} and did not read back. The Postbox entry is written.`);
  }

  // 4. The cache `postbox status` reads; nothing else reads the server for it.
  const state = {
    schema: 1,
    url: String(plan.value['url']),
    project_name: projectName,
    project_id: projectId,
    library_id: libraryId,
    library_card: card,
    entry_path: target,
    last_check: lastCheck,
    seats: seats as unknown as PsJsonValue,
    // THE TRIAGING SEAT, PINNED OR NAMED, OUTLIVES A SETUP RUN AGAIN (kickoffs/s143 rows 2-4); the entry's own is what was written.
    entry_reports_triaged_by: triagedBy as unknown as PsJsonValue,
    reports_triager: (field(previous?.['reports_triager'], 'library_id') === libraryId && triagedBy === null ? null : previous?.['reports_triager'] ?? null) as PsJsonValue,
    reports_triager_conflict: (previous?.['reports_triager_conflict'] ?? null) as PsJsonValue,
  };
  fs.mkdirSync(path.dirname(statePath(workspace)), { recursive: true });
  writeAtomicText(statePath(workspace), psConvertToJson(state as PsJsonValue) + '\n');
  return { ...plan.value, project_id: projectId, written: true, last_check: lastCheck, readback_matched: true };
}

/**
 * THE ENTRY KEPT CURRENT (kickoffs/s128 row 1; PLAN-many-libraries.md item 3): this Library's own entry rewritten as
 * setup writes it, over itself, with `lastCheck` and `seats`, then read back and compared, the seats included. A refusal
 * or a readback that does not match refuses; a dropped session is judged by the readback and never resent.
 */
async function refreshEntry(
  session: McpSession,
  state: { project_id: string; library_id: string; library_card: string },
  seats: PostboxSeat[],
  lastCheck: string,
  triagedBy: PostboxSeat | null,
): Promise<void> {
  const target = entryPath(state.library_id);
  // SELF-TEST ONLY (`LIBRARY_POSTBOX_FAULT=refuse-entry`): the title cues the fixture's injected refusal, so nothing is written.
  const title = (process.env['LIBRARY_POSTBOX_FAULT'] ?? '') === 'refuse-entry' ? `refuse-is-error-${state.library_id}` : state.library_id;
  const sent = await sendWrite(
    session,
    'write_note',
    {
      project_id: state.project_id,
      directory: ENTRY_DIRECTORY,
      title,
      content: entryText(state.library_card, seats, triagedBy),
      metadata: entryMetadata(state.library_id, state.library_card, lastCheck, triagedBy),
      note_type: 'note',
      overwrite: true,
      output_format: 'json',
    },
    `Refreshing the Postbox entry ${target}`,
  );
  const back = await readExactOrNull(session, state.project_id, target, { includeFrontmatter: true, stopped: 'the Postbox entry refresh stopped' });
  const entry = back === null ? null : parseEntry(back.content, target);
  if (entry === null || entry.library_id !== state.library_id || entry.library_card !== state.library_card || !sameInstant(entry.last_check, lastCheck) || !sameSeats(entry.seats, seats) || !sameTriager(entry.reportsTriagedBy, triagedBy)) {
    refuse(`${target} did not read back as this Library's refreshed entry${sent.dropped ? ' after its session dropped (it was not sent again)' : ''}; the next check tries again.`);
  }
}

// --- letters across Libraries: the delivery id, the digest and the outbox (kickoffs/s123 rows 2-5) -------------------

const INBOX_DIRECTORY = 'postbox/inbox';
/** A delivery id's alphabet (plan item 4): lowercase letters, digits and hyphens, so it is its own file name (S6). */
export const DELIVERY_ID = /^[a-z0-9][a-z0-9-]*$/;
/** The 5-second budget a session-start check gives each MCP call, in place of `mcpTimeoutMs()`'s default (plan item 6). */
export const SESSION_CHECK_TIMEOUT_MS = 5000;

/** `<sender-id>-<yyyymmddthhmmssz>-<random>`, lowercase (plan item 4). */
export function newDeliveryId(senderId: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').toLowerCase();
  return `${senderId.toLowerCase()}-${stamp}-${randomBytes(4).toString('hex')}`;
}

export function inboxFolder(recipientId: string): string {
  return `${INBOX_DIRECTORY}/${recipientId}`;
}

export function inboxPath(recipientId: string, deliveryId: string): string {
  return `${inboxFolder(recipientId)}/${deliveryId}.md`;
}

function deliveredPath(recipientId: string, deliveryId: string): string {
  return `${inboxFolder(recipientId)}/delivered/${deliveryId}.md`;
}

/**
 * THE BODY AS THE SERVER KEEPS IT (probe S5): the text after the server's frontmatter, newline-normalised, with the
 * leading newline the server adds and any trailing whitespace dropped. The digest covers this and nothing else, so it
 * reads the same from what was sent and from what comes back.
 */
export function keptBody(text: string): string {
  const normal = text.replace(/\r\n/g, '\n');
  const front = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(normal);
  return (front ? normal.slice(front[0].length) : normal).replace(/^\n+/, '').replace(/\s+$/, '');
}

/** The payload digest (plan item 4): SHA-256 over the kept body. */
export function payloadDigest(text: string): string {
  return sha256OfText(keptBody(text));
}

/** A server note's frontmatter values, un-YAMLed as the server quotes them (S7). */
export function deliveredFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!front) return fields;
  for (const line of front[1]!.split('\n')) {
    const pair = /^([a-z_]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (pair && !fields.has(pair[1]!)) fields.set(pair[1]!, unquoted(pair[2]!));
  }
  return fields;
}

/** One letter waiting to be sent, or sent: `internal/postbox/outbox/<delivery-id>.json`. */
export interface OutboxEntry {
  schema: 1;
  delivery_id: string;
  created_utc: string;
  letter_page: string;
  recipient_library_id: string;
  recipient_library_card: string;
  for_seat: string;
  for_seat_id: string;
  path: string;
  digest: string;
  title: string;
  body: string;
  metadata: Record<string, string>;
  state: 'unsent' | 'sent' | 'refused';
  attempts: number;
  sent_utc: string | null;
  sent_path: string | null;
  refusal: string | null;
  last_error: string | null;
  /** The Book it is filed into at the other end (kickoffs/s143 row 4): `letters` when absent, as every entry before s143. */
  book?: 'letters' | 'reports';
  /** Why a `reports` entry waits although the Postbox answers (`triager-conflict`), or null; letters are never held. */
  held?: string | null;
}

function outboxDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'postbox', 'outbox');
}

function outboxFile(workspace: string, deliveryId: string): string {
  return path.join(outboxDirectory(workspace), `${deliveryId}.json`);
}

/** Every outbox entry, oldest first; a file that is not one is skipped. */
export function readOutbox(workspace: string): OutboxEntry[] {
  const folder = outboxDirectory(workspace);
  if (!fs.existsSync(folder)) return [];
  const entries: OutboxEntry[] = [];
  for (const name of fs.readdirSync(folder).filter((file) => file.endsWith('.json')).sort()) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8').replace(/^﻿/, '')) as OutboxEntry;
      if (entry.schema === 1 && DELIVERY_ID.test(entry.delivery_id) && `${entry.delivery_id}.json` === name) {
        entries.push({ ...entry, book: entry.book === 'reports' ? 'reports' : 'letters', held: typeof entry.held === 'string' ? entry.held : null });
      }
    } catch {
      // not an entry; doctor names the folder's count, never this file's text
    }
  }
  return entries.sort((left, right) => left.created_utc.localeCompare(right.created_utc) || left.delivery_id.localeCompare(right.delivery_id));
}

function saveOutboxEntry(workspace: string, entry: OutboxEntry): void {
  writeAtomicText(outboxFile(workspace, entry.delivery_id), JSON.stringify(entry, null, 2) + '\n');
}

/**
 * THE OUTBOX ENTRY, CREATED ONCE (plan item 4): written with `wx` inside capture's mutation window, so a second entry
 * for one delivery id fails rather than replaces the first. Returns the file, for the window's rollback.
 */
export function createOutboxEntry(workspace: string, entry: OutboxEntry): string {
  fs.mkdirSync(outboxDirectory(workspace), { recursive: true });
  const file = outboxFile(workspace, entry.delivery_id);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return file;
}

/** The rollback of `createOutboxEntry`: only the entry that window created, and only while it is still unsent. */
export function removeOutboxEntry(workspace: string, deliveryId: string): void {
  const file = outboxFile(workspace, deliveryId);
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as OutboxEntry;
    if (entry.state === 'unsent' && entry.attempts === 0) fs.rmSync(file, { force: true });
  } catch {
    // nothing there to roll back
  }
}

/** This Library's Postbox, from its cache, or a refusal naming setup. */
function requireState(workspace: string): Record<string, unknown> & { url: string; project_id: string; library_id: string; library_card: string } {
  const state = readState(workspace);
  if (state === null || !UUID.test(String(state['project_id'] ?? '')) || !LIBRARY_ID.test(String(state['library_id'] ?? ''))) {
    refuse('This Library has no Postbox yet: deskpost postbox setup --url <mcp-url> --preflight.');
  }
  return state as Record<string, unknown> & { url: string; project_id: string; library_id: string; library_card: string };
}

function writeState(workspace: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath(workspace)), { recursive: true });
  writeAtomicText(statePath(workspace), psConvertToJson(state as PsJsonValue) + '\n');
}

/** Merge `changes` into the cache, read fresh, so two verbs that each record one thing keep both. */
function updateState(workspace: string, changes: Record<string, unknown>): void {
  const state = readState(workspace);
  if (state === null) return;
  writeState(workspace, { ...state, ...changes });
}

/** The cached Postbox as the Desk and doctor read it: no server is called (plan item 6). */
export function postboxCache(workspace: string): { state: Record<string, unknown> | null; outbox: OutboxEntry[] } {
  return { state: readState(workspace), outbox: readOutbox(workspace) };
}

// --- the program, run as a child: an address for capture, a send after it, a check at session start -----------------

/** This program, as `seat.ts`'s `selfCommand` names it: the binary, or node and the source script. */
function selfCommand(): { file: string; args: string[] } {
  const script = process.argv[1] ?? '';
  const prefix = /\.(?:[cm]?[jt]s)$/i.test(script) ? [...process.execArgv, script] : [];
  return { file: process.execPath, args: prefix };
}

/**
 * ONE POSTBOX VERB IN A CHILD, WAITED FOR (capture is synchronous, and the Postbox is a server). Each MCP call in it
 * has the session-check budget, and the child as a whole a hard limit, so a capture never waits long on a server.
 */
function runPostboxChild(workspace: string, args: string[]): { ok: boolean; value: Record<string, unknown> | null; said: string } {
  const self = selfCommand();
  const ran = spawnSync(self.file, [...self.args, 'postbox', ...args, '--workspace', workspace, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, LIBRARY_MCP_TIMEOUT_MS: String(SESSION_CHECK_TIMEOUT_MS) },
  });
  let value: Record<string, unknown> | null = null;
  try {
    value = JSON.parse(ran.stdout ?? '') as Record<string, unknown>;
  } catch {
    value = null;
  }
  const said = `${ran.stderr ?? ''}`.trim() || (ran.error ? ran.error.message : '') || (ran.signal ? `stopped by ${ran.signal}` : '');
  return { ok: ran.status === 0 && value !== null, value, said };
}

/** Where a letter to another Library goes, as capture records it. */
export interface RemoteAddress {
  from_library_id: string;
  from_library_card: string;
  library_id: string;
  library_card: string;
  seat: string;
  seat_id: string;
}

/**
 * THE ADDRESS OF A LETTER TO ANOTHER LIBRARY (plan items 2 and 3), for capture's `--library`: the Library resolved from
 * the Postbox now (`postbox resolve`), never from a guess; the seat must be in its entry with a `seat_id`, unless the
 * caller already knows the asker's (`--answers`), whose id is the letter's own record. This Library is never another.
 */
export function resolveRemoteSeat(workspace: string, address: string, seat: string, knownSeatId: string | null = null): RemoteAddress {
  const state = requireState(workspace);
  const card = String(state['library_card'] ?? '').trim();
  if (!card) refuse('This Library has no card in its Postbox entry. Run deskpost postbox setup again. Nothing was captured.');
  const resolved = runPostboxChild(workspace, ['resolve', address]);
  if (!resolved.ok) refuse(`The Library '${address}' could not be resolved through the Postbox, so the letter was not written: ${resolved.said.substring(0, 400) || 'no answer'}. Nothing was captured.`);
  const libraryId = String(resolved.value!['library_id'] ?? '');
  if (libraryId === state.library_id) refuse(`'${address}' is this Library. A letter to a seat here is a local letter: leave out --library. Nothing was captured.`);
  const seats = (resolved.value!['seats'] as PostboxSeat[] | undefined) ?? [];
  const listed = seats.find((row) => row.seat === seat);
  let seatId = knownSeatId ?? '';
  if (knownSeatId === null) {
    if (!listed || !/^[0-9a-f]{32}$/.test(listed.seat_id)) {
      refuse(
        `The Library '${String(resolved.value!['library_card'] ?? address)}' (${libraryId}) lists no seat '${seat}' with a seat_id in its Postbox entry, so a letter to it would reach no one. ` +
          `It lists: ${seats.map((row) => row.seat).join(', ') || '(none)'}. Nothing was captured.`,
      );
    }
    seatId = listed.seat_id;
  }
  return { from_library_id: state.library_id, from_library_card: card, library_id: libraryId, library_card: String(resolved.value!['library_card'] ?? ''), seat, seat_id: seatId };
}

/** Capture's one send, right after the letter is written: a child `postbox send --only <id>`, never a second try. */
export function sendAfterCapture(workspace: string, deliveryId: string): Record<string, PsJsonValue> {
  // SELF-TEST ONLY (`LIBRARY_POSTBOX_FAULT=hold-send`): the letter is left waiting in the outbox, as an unreachable
  // server would leave it, so a test can stage what the server holds before the send.
  if ((process.env['LIBRARY_POSTBOX_FAULT'] ?? '') === 'hold-send') return { delivery_id: deliveryId, state: 'unsent', detail: 'Held in the outbox by LIBRARY_POSTBOX_FAULT.' };
  const sent = runPostboxChild(workspace, ['send', '--only', deliveryId]);
  const row = ((sent.value?.['letters'] as Record<string, unknown>[] | undefined) ?? []).find((item) => item['delivery_id'] === deliveryId);
  if (!sent.ok || !row) {
    return { delivery_id: deliveryId, state: 'unsent', detail: `Queued in the outbox; deskpost postbox send tries again. ${sent.said.substring(0, 300)}`.trim() };
  }
  return { delivery_id: deliveryId, state: String(row['state']), detail: String(row['detail'] ?? '') };
}

// --- send (plan item 4) ----------------------------------------------------------------------------------------------

async function openPostbox(workspace: string, state: { url: string }): Promise<McpSession | string> {
  // One CLI command and its synchronous carriers share only a failed observation, never a live session.
  try {
    const seen = JSON.parse(process.env['LIBRARY_POSTBOX_UNREACHABLE'] ?? 'null') as {workspace:string;url:string;detail:string}|null;
    if (seen?.workspace === workspace && seen.url === state.url && typeof seen.detail === 'string') return seen.detail;
  } catch { /* An absent or malformed observation does not suppress a connection. */ }
  const session = new McpSession(state.url, 'deskpost-postbox');
  try {
    await session.initialize();
    return session;
  } catch (error) {
    const detail = (error as Error).message;
    process.env['LIBRARY_POSTBOX_UNREACHABLE'] = JSON.stringify({workspace,url:state.url,detail});
    return detail;
  }
}

/** Record that the Postbox could not be reached, keeping the first time it could not (plan item 6). */
function recordUnreachable(workspace: string, detail: string): string {
  const since = String(readState(workspace)?.['unreachable_since'] ?? '') || utcSeconds();
  updateState(workspace, { unreachable_since: since, unreachable_detail: detail.substring(0, 300) });
  return since;
}

/**
 * Where a delivery id is on the server, judged by LISTING each folder (kickoffs/s131 row 3; probe of 2026-10-17:
 * `read_content` by a path answers another note for a path with no file, and the moved note for a re-written path). The
 * inbox path first, then `delivered/`. A listed file is read by its permalink and checked; one whose read is refused is
 * there and not this letter, so its digest is empty and the refusal is named.
 */
async function findDelivered(session: McpSession, projectId: string, recipientId: string, deliveryId: string): Promise<{ path: string; digest: string; text: string; refused?: string } | null> {
  for (const relative of [inboxPath(recipientId, deliveryId), deliveredPath(recipientId, deliveryId)]) {
    const file = await fileAt(session, projectId, relative);
    if (file === null) continue;
    const read = await readListed(session, projectId, file);
    if (read === null) continue;
    if ('refused' in read) return { path: relative, digest: '', text: '', refused: read.refused };
    return { path: relative, digest: payloadDigest(read.text), text: read.text };
  }
  return null;
}

/**
 * ONE LETTER SENT EXACTLY ONCE (plan item 4). Look first, at both paths: the same digest at either is success (the
 * recipient may have filed and moved it); another digest is a refusal named in the entry, and nothing is overwritten.
 * Only when neither exists is the inbox path written, with `overwrite: false`. A conflict answer (a race with another
 * send) re-reads and judges by digest. Sent only after a digest-matching readback; a dropped session is judged by
 * readback and never resent.
 */
async function sendOne(session: McpSession, projectId: string, workspace: string, entry: OutboxEntry): Promise<Record<string, PsJsonValue>> {
  const done = (state: OutboxEntry['state'], detail: string, at: string | null = null): Record<string, PsJsonValue> => {
    entry.state = state;
    if (state === 'sent') {
      entry.sent_utc = utcSeconds();
      entry.sent_path = at;
      entry.last_error = null;
    } else if (state === 'refused') {
      entry.refusal = detail;
    } else {
      entry.last_error = detail;
    }
    saveOutboxEntry(workspace, entry);
    return { delivery_id: entry.delivery_id, state, detail, ...(at ? { path: at } : {}) };
  };
  const judge = (found: { path: string; digest: string; refused?: string }, wrote: boolean): Record<string, PsJsonValue> =>
    found.digest === entry.digest
      ? done('sent', wrote ? 'written and read back' : `already at ${found.path}`, found.path)
      : done('refused', `A different note is already at ${found.path} (${found.refused ? `its read was refused: ${found.refused.substring(0, 200)}` : 'its digest is not this letter\'s'}), so this letter was not sent and nothing was overwritten.`);

  entry.attempts += 1;
  saveOutboxEntry(workspace, entry);
  const before = await findDelivered(session, projectId, entry.recipient_library_id, entry.delivery_id);
  if (before !== null) return judge(before, false);
  let dropped = false;
  try {
    dropped = (await sendWrite(session, 'write_note', {
      project_id: projectId,
      directory: inboxFolder(entry.recipient_library_id),
      title: entry.delivery_id,
      content: entry.body,
      metadata: entry.metadata,
      note_type: 'note',
      overwrite: false,
      output_format: 'json',
    }, `Sending ${entry.delivery_id}`)).dropped;
  } catch (error) {
    // A CONFLICT IS NOT A REFUSAL HERE: another send may have written it first. Re-read and judge.
    const message = (error as Error).message;
    if (!/\((note-already-exists|conflict)\b/.test(message)) {
      // AN ERROR AFTER THE WRITE IS NOT AN UNSENT LETTER (kickoffs/s160 row 1): the server may have kept the note and then
      // failed a later step (its embedding, 2026-10-24). Look again, never write again; this letter's digest there is sent.
      const landed = await findDelivered(session, projectId, entry.recipient_library_id, entry.delivery_id).catch(() => null);
      if (landed === null) return done('unsent', message);
      if (landed.digest !== entry.digest) return judge(landed, true);
      return done('sent', `written, but the server reported an error after the write: ${message}`, landed.path);
    }
  }
  const after = await findDelivered(session, projectId, entry.recipient_library_id, entry.delivery_id);
  if (after !== null) return judge(after, true);
  return done('unsent', dropped
    ? 'The session dropped during the write and the letter is not there; it was not sent again. The next send looks first, then writes.'
    : 'The write was answered and the letter did not read back. The next send looks first, then writes.');
}

// --- discovery, the pin and the hold (kickoffs/s143 row 4; reports-across-Libraries step 3, criterion 2) -------------

/** A Library whose entry names a seat that triages Reports, as discovery records it. */
interface Claimant {
  library_id: string;
  library_card: string;
  seat: string;
  seat_id: string;
}

/**
 * THE RULES (criterion 2), applied to every entry seen. A Library whose own entry claims the field never pins another.
 * Otherwise: no pin and exactly one claimant pins it (`source: "auto"`); no claimant clears an `auto` pin; two or more
 * claimants with an `auto` pin or none, or a pinned Library that no longer claims, record `reports_triager_conflict` and
 * keep the pin. A pin the reader chose (`follow`) stands while its Library still claims. A conflict stays recorded until
 * `reports triager --follow` clears it. Returns the state as left.
 */
export function applyDiscovery(workspace: string, seen: { library_id: string; library_card: string; reportsTriagedBy: PostboxSeat | null }[]): Record<string, unknown> {
  const state = readState(workspace) ?? {};
  const own = String(state['library_id'] ?? '');
  const pin = state['reports_triager'];
  const ownClaims = field(pin, 'library_id') === own || seen.some((entry) => entry.library_id === own && entry.reportsTriagedBy !== null);
  if (ownClaims) return state;
  const claimants: Claimant[] = seen
    .filter((entry) => entry.library_id !== own && entry.reportsTriagedBy !== null)
    .map((entry) => ({ library_id: entry.library_id, library_card: entry.library_card, seat: entry.reportsTriagedBy!.seat, seat_id: entry.reportsTriagedBy!.seat_id }));
  const pinned = LIBRARY_ID.test(String(field(pin, 'library_id') ?? '')) ? String(field(pin, 'library_id')) : null;
  const source = String(field(pin, 'source') ?? '');
  const conflict = (): Record<string, unknown> => ({
    reports_triager_conflict: {
      seen_utc: String(field(state['reports_triager_conflict'], 'seen_utc') ?? '') || utcSeconds(),
      claimants: claimants.map((row) => ({ library_id: row.library_id, library_card: row.library_card, seat: row.seat })),
    },
  });
  let changes: Record<string, unknown> = {};
  const current = pinned === null ? undefined : claimants.find((row) => row.library_id === pinned);
  if (pinned === null) {
    if (claimants.length === 1) {
      const only = claimants[0]!;
      changes = { reports_triager: { library_id: only.library_id, seat: only.seat, seat_id: only.seat_id, pinned_utc: utcSeconds(), source: 'auto' } };
    } else if (claimants.length > 1) changes = conflict();
  } else if (current === undefined) {
    changes = claimants.length === 0 && source === 'auto' ? { reports_triager: null } : conflict();
  } else if (source !== 'follow' && claimants.length > 1) {
    changes = conflict();
  } else if (current.seat !== field(pin, 'seat') || current.seat_id !== field(pin, 'seat_id')) {
    // The pinned Library named another of its seats: the pin follows it, by the Library's id.
    changes = { reports_triager: { ...(pin as Record<string, unknown>), seat: current.seat, seat_id: current.seat_id } };
  }
  if (Object.keys(changes).length) updateState(workspace, changes);
  return { ...state, ...changes };
}

/** Whether an outbox entry may go now: letters always; a Report only to the pinned Library, with no conflict recorded. */
function mayGoNow(state: Record<string, unknown>, entry: OutboxEntry): boolean {
  if (entry.book !== 'reports') return true;
  const own = String(state['library_id'] ?? '');
  if (field(state['reports_triager'], 'library_id') === own) return true;
  return state['reports_triager_conflict'] == null && field(state['reports_triager'], 'library_id') === entry.recipient_library_id;
}

/**
 * Discovery from the entries now (and cached, for a later send the server does not answer), or from the cache; then each
 * queued Report marked `held` or cleared. Returns the test the send applies.
 */
async function discoverAndHold(workspace: string, session: McpSession | null, queued: OutboxEntry[]): Promise<(entry: OutboxEntry) => boolean> {
  const state = readState(workspace) ?? {};
  let seen: { library_id: string; library_card: string; reportsTriagedBy: PostboxSeat | null }[] | null = null;
  if (session !== null) {
    try {
      seen = (await readEntries(session, String(state['project_id']))).entries;
      updateState(workspace, { entries_seen: seen.map((entry) => ({ library_id: entry.library_id, library_card: entry.library_card, reports_triaged_by: entry.reportsTriagedBy })), entries_seen_utc: utcSeconds() });
    } catch {
      seen = null;
    }
  }
  if (seen === null) {
    const cached = state['entries_seen'];
    seen = (Array.isArray(cached) ? cached : []).map((row) => ({ library_id: String(field(row, 'library_id') ?? ''), library_card: String(field(row, 'library_card') ?? ''), reportsTriagedBy: asSeat(field(row, 'reports_triaged_by')) }));
  }
  const after = applyDiscovery(workspace, seen);
  for (const entry of queued) {
    const held = mayGoNow(after, entry) ? null : 'triager-conflict';
    if ((entry.held ?? null) !== held) {
      entry.held = held;
      saveOutboxEntry(workspace, entry);
    }
  }
  return (entry) => mayGoNow(after, entry);
}

async function send(argv: string[], workspace: string, recovered = false): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('postbox', 'send'));
  const recovery=!recovered?recover(workspace, 'postbox send', reportStageRunner(workspace)):null;
  const only = (parsed.options.get('only') ?? '').trim();
  const state = requireState(workspace);
  const queued = readOutbox(workspace).filter((entry) => entry.state === 'unsent' && (!only || entry.delivery_id === only));
  const value = (letters: Record<string, PsJsonValue>[], reachable: boolean): Record<string, PsJsonValue> => {
    for (const record of readRecords(workspace)) {
      if (record.kind !== 'report-outcome' || (only && record.delivery_id !== only)) continue;
      const attempted = letters.find(row=>row['delivery_id']===record.delivery_id);
      const existing = readOutbox(workspace).find(entry=>entry.delivery_id===record.delivery_id);
      if (!attempted && (!existing || existing.state === 'unsent')) continue;
      const stage=record.stages.find(s=>s.name==='send' && s.state==='pending');
      if(stage && record.stages.every(s=>s===stage || s.state==='done')) completeStage(workspace,record,'send',JSON.stringify(attempted ?? {delivery_id:record.delivery_id,state:existing!.state}));
    }
    return ({
    schema: 1,
    operation: 'Send letters through the Postbox',
    ...(recovery?.controls_set_aside?{controls_set_aside:recovery.controls_set_aside}:{}),
    ...(recovery?.controls_move_pending?{controls_move_pending:recovery.controls_move_pending}:{}),
    workspace,
    reachable,
    letters: letters as unknown as PsJsonValue,
    sent: letters.filter((row) => row['state'] === 'sent').length,
    unsent: readOutbox(workspace).filter((entry) => entry.state === 'unsent').length,
    refused: readOutbox(workspace).filter((entry) => entry.state === 'refused').length,
    held: readOutbox(workspace).filter((entry) => entry.state === 'unsent' && entry.held).length,
  });
  };
  if (!queued.length) return value([], true);
  const session = await openPostbox(workspace, state);
  // DISCOVERY BEFORE ANY REPORT GOES (kickoffs/s143 row 4; criterion 2), in `send`, `send --only` and `check --send-first`
  // alike: from the entries now, or from the ones last seen when the server does not answer. Letters alone need none.
  const mayGo = queued.some((entry) => entry.book === 'reports') ? await discoverAndHold(workspace, typeof session === 'string' ? null : session, queued) : () => true;
  if (typeof session === 'string') {
    recordUnreachable(workspace, session);
    return value(queued.map((entry) => ({ delivery_id: entry.delivery_id, state: 'unsent', detail: `The Postbox did not answer: ${session.substring(0, 200)}` })), false);
  }
  const letters: Record<string, PsJsonValue>[] = [];
  for (const entry of queued) {
    if (!mayGo(entry)) {
      letters.push({ delivery_id: entry.delivery_id, state: 'unsent', held: entry.held ?? null, detail: 'Held: the Library that triages Reports is in conflict or not pinned. deskpost reports triager --follow <library> --preflight chooses one.' });
      continue;
    }
    try {
      letters.push(await sendOne(session, state.project_id, workspace, entry));
    } catch (error) {
      entry.last_error = (error as Error).message.substring(0, 400);
      saveOutboxEntry(workspace, entry);
      letters.push({ delivery_id: entry.delivery_id, state: 'unsent', detail: entry.last_error });
    }
  }
  updateState(workspace, { last_send: utcSeconds(), unreachable_since: null, unreachable_detail: null });
  return value(letters, true);
}

// --- check (plan item 5) ---------------------------------------------------------------------------------------------

/** An inbox delivery passed to capture (letters or Reports, kickoffs/c47 row 4). */
export interface PostboxFiling {
  book: 'letters' | 'reports';
  kind: DeliveryKind;
  droppedKeys: number;
  /** Digest of the carrier body before control-format decoding, for move reconciliation. */
  wireDigest?: string;
  body: string;
  fromSeat: string;
  forSeat: string;
  forSeatId: string;
  originSeat: string;
  originSeatId: string;
  deliveryId: string;
  /** The asker's own delivery id when this is an answer: the letter it closes here (plan item 3). */
  answersDeliveryId: string;
  /** The Library lines the filed copy carries, in order, after every older line. */
  fields: [string, string][];
}

const SEAT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CARD_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} '._&()-]{0,59}$/u;

/** An inbox copy left beside its delivered twin (plan item 5): counted once, skipped after, named by doctor. */
interface LeftCopy {
  path: string;
  delivery_id: string;
  updated_at: string;
}

function leftCopies(state: Record<string, unknown> | null): LeftCopy[] {
  const rows = state?.['left_inbox_copies'];
  return Array.isArray(rows) ? (rows as LeftCopy[]).filter((row) => typeof row?.path === 'string') : [];
}

/** A file as `list_directory` reports it: the one record of what is actually at a path (probe of 2026-10-17, finding 6). */
interface ListedFile {
  path: string;
  updated_at: string;
  permalink: string;
}

/**
 * The files directly in one Postbox folder, each with the server's `updated_at` and `permalink`; one page of 200
 * (UNPROBED paging).
 */
async function listFolderFiles(session: McpSession, projectId: string, folder: string): Promise<ListedFile[]> {
  const response = await session.callTool('list_directory', { project_id: projectId, dir_name: folder, depth: 1, page: 1, page_size: 200, output_format: 'json' });
  const result = field(field(field(response, 'result'), 'structuredContent'), 'result');
  if (field(field(response, 'result'), 'isError') === true || result === undefined || result === null) {
    const detail = JSON.stringify(field(field(response, 'result'), 'content') ?? field(response, 'error') ?? null);
    if (/not found|does not exist|no such/i.test(detail)) return [];
    refuse(`The Postbox folder ${folder} could not be listed: ${detail.substring(0, 300)}`);
  }
  // UNPROBED (kickoffs/s123 STANDING ANSWER 9): paging past 200. Refuse rather than read part of an inbox.
  if (field(result, 'has_more') === true) refuse(`The Postbox folder ${folder} holds more than 200 notes, and this release reads one page. Nothing was filed.`);
  const nodes = field(result, 'nodes');
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => field(node, 'type') === 'file')
    .map((node) => ({ path: String(field(node, 'file_path') ?? ''), updated_at: String(field(node, 'updated_at') ?? ''), permalink: String(field(node, 'permalink') ?? '') }))
    .filter((node) => node.path.startsWith(`${folder}/`) && node.path.endsWith('.md') && !node.path.slice(folder.length + 1).includes('/'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** The file at exactly `relative`, as its folder's listing reports it, or null when the listing has none there. */
async function fileAt(session: McpSession, projectId: string, relative: string): Promise<ListedFile | null> {
  const folder = relative.slice(0, relative.lastIndexOf('/'));
  return (await listFolderFiles(session, projectId, folder)).find((file) => file.path === relative) ?? null;
}

/**
 * A listed file's text, read by the permalink its node gave and checked (`readPermalinkContent`): the text, a refusal
 * named in words, or null when the server says it is gone.
 */
async function readListed(session: McpSession, projectId: string, file: ListedFile): Promise<{ text: string } | { refused: string } | null> {
  try {
    const text = await readPermalinkContent(session, projectId, file.permalink);
    return text === null ? null : { text };
  } catch (error) {
    if (error instanceof BasicMemoryRefusal) return { refused: error.message };
    throw error;
  }
}

type DeliveryKind = 'letter' | 'report' | 'control' | 'outcome';
type DeliveryField = {shape:RegExp; kinds:DeliveryKind[]; local:string | null; envelope?:boolean};
const ALL_DELIVERIES: DeliveryKind[] = ['letter','report','control','outcome'];
const REPORT_DELIVERIES: DeliveryKind[] = ['report','control'];
/** The wire-to-local contract: unknown/invalid keys are dropped; controls and outcomes wait for K3. */
const DELIVERY_FIELDS: Record<string,DeliveryField> = {
  delivery_id:{shape:DELIVERY_ID,kinds:ALL_DELIVERIES,local:'delivery_id'},
  book:{shape:/^(letters|reports)$/,kinds:ALL_DELIVERIES,local:'book',envelope:true},
  from_library_id:{shape:LIBRARY_ID,kinds:ALL_DELIVERIES,local:'from_library_id'},
  from_library_card:{shape:CARD_SHAPE,kinds:ALL_DELIVERIES,local:'from_library_card'},
  for_library_id:{shape:LIBRARY_ID,kinds:ALL_DELIVERIES,local:'for_library_id'},
  for_seat:{shape:SEAT_SLUG,kinds:ALL_DELIVERIES,local:'for_seat'},
  for_seat_id:{shape:/^[0-9a-f]{32}$/,kinds:ALL_DELIVERIES,local:'for_seat_id'},
  from_seat:{shape:SEAT_SLUG,kinds:ALL_DELIVERIES,local:'from_seat'},
  origin_seat:{shape:SEAT_SLUG,kinds:ALL_DELIVERIES,local:'origin_seat'},
  origin_seat_id:{shape:/^[0-9a-f]{32}$/,kinds:ALL_DELIVERIES,local:'origin_seat_id'},
  origin_library_id:{shape:LIBRARY_ID,kinds:ALL_DELIVERIES,local:'origin_library_id'},
  origin_delivery_id:{shape:DELIVERY_ID,kinds:ALL_DELIVERIES,local:'origin_delivery_id'},
  answers_delivery_id:{shape:DELIVERY_ID,kinds:['letter'],local:'answers_delivery_id'},
  payload_digest:{shape:/^[0-9a-f]{64}$/,kinds:ALL_DELIVERIES,local:'postbox_damaged'},
  deskpost_version:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:REPORT_DELIVERIES,local:'deskpost_version',envelope:true},
  mods_commit:{shape:/^[0-9a-f]{40}$/,kinds:REPORT_DELIVERIES,local:'mods_commit',envelope:true},
  source_project:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:REPORT_DELIVERIES,local:'source_project',envelope:true},
  source_paths:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:REPORT_DELIVERIES,local:'source_paths',envelope:true},
  tags:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:REPORT_DELIVERIES,local:'tags',envelope:true},
  session_id:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:REPORT_DELIVERIES,local:'session_id',envelope:true},
  report_seq:{shape:/^\d+$/,kinds:REPORT_DELIVERIES,local:'report_seq_applied'},
  control_body_format:{shape:/^update-text-v1$/,kinds:['control'],local:null},
  amends_delivery_id:{shape:DELIVERY_ID,kinds:['control'],local:'amends_delivery_id'},
  withdraws_delivery_id:{shape:DELIVERY_ID,kinds:['control'],local:'withdraws_delivery_id'},
  closes_delivery_id:{shape:DELIVERY_ID,kinds:['outcome'],local:'closes_delivery_id'},
  outcome:{shape:/^(confirmed|confirmed-by-design|not-reproduced|already-fixed|declined)$/,kinds:['outcome'],local:'outcome'},
  outcome_gen:{shape:/^\d+$/,kinds:['outcome'],local:'outcome_gen'},
  sent_for:{shape:/^[^\x00-\x1f\x7f-\x9f]+$/,kinds:['report','control','outcome'],local:'sent_for'},
};
function deliveryKind(fields: Map<string,string>): DeliveryKind {
  if (fields.has('amends_delivery_id') || fields.has('withdraws_delivery_id')) return 'control';
  if (fields.has('closes_delivery_id') || fields.has('outcome') || fields.has('outcome_gen')) return 'outcome';
  return fields.get('book') === 'reports' ? 'report' : 'letter';
}

/**
 * THE FILING (plan item 5), handed to capture's internal route, which takes the Book's lock and files only when no
 * local note carries this delivery id. A recipient whose `seat_id` no longer matches is filed `stale_delivery: true`;
 * a body whose digest is not the one the sender recorded is filed `postbox_damaged: true`. No delivery body is dropped.
 */
function filingOf(workspace: string, relative: string, text: string, delivered: Map<string, string>): PostboxFiling {
  const kind = deliveryKind(delivered);
  const fields = new Map<string,string>();
  let droppedKeys=0;
  for (const [key,value] of delivered) {
    const rule=DELIVERY_FIELDS[key];
    if (rule && rule.kinds.includes(kind) && rule.shape.test(value)) fields.set(key,value);
    else if (!['title','type','permalink','created','modified'].includes(key)) droppedKeys++;
  }
  const book=fields.get('book') === 'reports' ? 'reports' : 'letters';
  let body = keptBody(text);
  const wireDigest=sha256OfText(body);
  const deliveryId = fields.get('delivery_id') ?? '';
  const forSeat = fields.get('for_seat') ?? '';
  const forSeatId = fields.get('for_seat_id') ?? '';
  const view = readSeatIdentityView(path.join(workspace, '.claude'));
  const live = view.live.some((row) => row.seat === forSeat && row.seatId === forSeatId && row.identity === 'valid');
  let damaged = (fields.get('payload_digest') ?? '') !== wireDigest || (kind==='control'&&delivered.has('control_body_format')&&!fields.has('control_body_format'));
  if(kind==='control'&&fields.get('control_body_format')==='update-text-v1'){
    const prefix='### Report amendment\n\n';
    if(body.startsWith(prefix))body=body.slice(prefix.length);else damaged=true;
  }
  const fromLibraryId = fields.get('from_library_id') ?? '';
  const card = fields.get('from_library_card') ?? '';
  const originDelivery = fields.get('origin_delivery_id') ?? '';
  const originLibrary = fields.get('origin_library_id') ?? '';
  const answers = fields.get('answers_delivery_id') ?? '';
  const line = (wire: string, value: string): [string,string] => {
    const local = DELIVERY_FIELDS[wire]?.local;
    if (!local) throw new Error(`The delivery field ${wire} has no local line.`);
    return [local,value];
  };
  // Keep the established provenance order; names and envelope membership come from the one table.
  const lines: [string,string][] = [
    line('from_library_id',fromLibraryId),
    ...(CARD_SHAPE.test(card) ? [line('from_library_card',card)] : []),
    line('for_library_id',fields.get('for_library_id') ?? ''),
    line('delivery_id',deliveryId),
    line('origin_library_id',LIBRARY_ID.test(originLibrary) ? originLibrary : fromLibraryId),
    line('origin_delivery_id',DELIVERY_ID.test(originDelivery) ? originDelivery : deliveryId),
    ...(DELIVERY_ID.test(answers) ? [line('answers_delivery_id',answers)] : []),
    ...(kind === 'control' ? ['amends_delivery_id','withdraws_delivery_id','report_seq'].filter(key=>fields.has(key)).map(key=>line(key,fields.get(key)!)) : []),
    ...(kind === 'outcome' ? ['closes_delivery_id','outcome','outcome_gen'].filter(key=>fields.has(key)).map(key=>line(key,fields.get(key)!)) : []),
    ...(fields.has('sent_for') && (kind === 'report' || kind === 'outcome') ? [line('sent_for',fields.get('sent_for')!)] : []),
    ['postbox_path',relative],
    ...(live ? [] : [['stale_delivery','true'] as [string,string]]),
    ...(damaged ? [line('payload_digest','true')] : []),
    ...[...fields].flatMap(([key,value]) => DELIVERY_FIELDS[key]?.envelope && kind === 'report' ? [line(key,value)] : []),
    ...(kind === 'report' ? [line('report_seq','0'),['outcome_gen','0'] as [string,string],...(!asSeat(readState(workspace)?.['entry_reports_triaged_by']) ? [['unexpected_report','true'] as [string,string]] : [])] : []),
  ];
  const fromSeat = fields.get('from_seat') ?? '';
  const originSeat = fields.get('origin_seat') ?? '';
  return {
    book,kind,droppedKeys,wireDigest,
    body,
    fromSeat: SEAT_SLUG.test(fromSeat) ? fromSeat : '',
    forSeat: SEAT_SLUG.test(forSeat) ? forSeat : '',
    forSeatId: /^[0-9a-f]{32}$/.test(forSeatId) ? forSeatId : '',
    originSeat: SEAT_SLUG.test(originSeat) ? originSeat : SEAT_SLUG.test(fromSeat) ? fromSeat : '',
    originSeatId: /^[0-9a-f]{32}$/.test(fields.get('origin_seat_id') ?? '') ? fields.get('origin_seat_id')! : '',
    deliveryId,
    answersDeliveryId: DELIVERY_ID.test(answers) ? answers : '',
    fields: lines,
  };
}

/**
 * MOVED TO `delivered/` ONLY AFTER THE LOCAL COPY IS VERIFIED (plan item 5). A destination that already holds the
 * delivery id with the same digest counts as moved: the inbox copy is left (nothing is deleted) and recorded, so later
 * checks count it once and skip it. `delivered/` is listed before the move, the move names the file by its permalink,
 * and both folders are listed after it, each file there read by its permalink (kickoffs/s131 row 3). A move the server
 * refuses, `DESTINATION_SAME_AS_SOURCE` among them, is judged by those listings, so it is never counted as moved.
 *
 * THE MOVE'S ANSWER COMES BACK WITH THE OUTCOME (kickoffs/s133 row 2): `answer` is `moveNoteTo`'s `{moved, dropped,
 * detail}` when a move was sent, and null when the listing settled it first. It only explains; the outcome is still the
 * listings'.
 */
async function moveToDelivered(
  session: McpSession,
  projectId: string,
  workspace: string,
  recipientId: string,
  file: ListedFile,
  deliveryId: string,
  digest: string,
): Promise<{ outcome: 'moved' | 'left' | 'not-moved'; answer: { moved: boolean; dropped: boolean; detail: string } | null }> {
  const target = deliveredPath(recipientId, deliveryId);
  const leave = (): 'left' => {
    const state = readState(workspace);
    const rows = leftCopies(state).filter((row) => row.path !== file.path);
    updateState(workspace, { left_inbox_copies: [...rows, { path: file.path, delivery_id: deliveryId, updated_at: file.updated_at }] });
    return 'left';
  };
  const sameText = async (listed: ListedFile | null): Promise<boolean | null> => {
    if (listed === null) return null;
    const read = await readListed(session, projectId, listed);
    return read !== null && 'text' in read && payloadDigest(read.text) === digest;
  };
  const there = await sameText(await fileAt(session, projectId, target));
  if (there !== null) return { outcome: there ? leave() : 'not-moved', answer: null };
  // UNPROBED (kickoffs/s123 STANDING ANSWER 9): a move onto an existing file. Looked for first, above, so it is never asked.
  // SELF-TEST ONLY (`LIBRARY_POSTBOX_FAULT=move-in-place`, kickoffs/s133 row 2): the move names the inbox folder itself,
  // so the server refuses it with `DESTINATION_SAME_AS_SOURCE`, as a move racing another check's can be refused.
  const destination = (process.env['LIBRARY_POSTBOX_FAULT'] ?? '') === 'move-in-place' ? inboxFolder(recipientId) : `${inboxFolder(recipientId)}/delivered`;
  const answer = await moveNoteTo(session, projectId, file.permalink, destination);
  const atTarget = await sameText(await fileAt(session, projectId, target));
  const atInbox = await fileAt(session, projectId, file.path);
  if (atTarget !== true) return { outcome: 'not-moved', answer };
  return { outcome: atInbox === null ? 'moved' : leave(), answer };
}

/** SELF-TEST ONLY (`LIBRARY_POSTBOX_FAULT=crash-after-file`): the check stops after its first filing, before the move. */
function crashAfterFileForTest(): void {
  if ((process.env['LIBRARY_POSTBOX_FAULT'] ?? '') === 'crash-after-file') refuse('LIBRARY_POSTBOX_FAULT: the check stopped between filing and moving.');
}

/** Synchronous control transport stays in the carrier, bounded like capture's existing child. */
function controlChild(workspace:string,args:string[],extra:Record<string,string>):{ok:boolean;value:Record<string,unknown>|null;said:string}{
  const self=selfCommand();
  const ran=spawnSync(self.file,[...self.args,'postbox',...args,'--workspace',workspace,'--json'],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,LIBRARY_MCP_TIMEOUT_MS:String(SESSION_CHECK_TIMEOUT_MS),...extra}});
  let value:Record<string,unknown>|null=null;try{value=JSON.parse(ran.stdout??'') as Record<string,unknown>;}catch{/* named below */}
  if (value?.['reachable'] === false) {
    const state=readState(workspace), detail=String(value['detail'] ?? state?.['unreachable_detail'] ?? '');
    if (detail) process.env['LIBRARY_POSTBOX_UNREACHABLE']=JSON.stringify({workspace,url:state?.['url'],detail});
  }
  return {ok:ran.status===0&&value!==null,value,said:(ran.stderr??'').trim()||(ran.error?ran.error.message:'')};
}

/** Suppress recursive control transport in the child; the parent records the actual attempt afterward. */
export function sendControlNotice(workspace:string,id:string):Record<string,PsJsonValue>{
  if(process.env['LIBRARY_POSTBOX_FAULT']==='hold-send')return {delivery_id:id,state:'unsent',detail:'Held in the outbox by LIBRARY_POSTBOX_FAULT.'};
  const sent=controlChild(workspace,['send','--only',id],{LIBRARY_CONTROL_TRANSPORT_CHILD:'1'});
  if(sent.value?.['reachable']===false)controlTransportUnreachable(workspace);
  const row=((sent.value?.['letters'] as Record<string,unknown>[]|undefined)??[]).find(r=>r['delivery_id']===id);
  return sent.ok&&row?{delivery_id:id,state:String(row['state']),detail:String(row['detail']??'')}:{delivery_id:id,state:'unsent',detail:'Queued in the outbox; postbox send retries. '+sent.said.substring(0,300)};
}

export function finishReportControlMove(workspace:string,id:string):string{
  const result=controlChild(workspace,['check'],{LIBRARY_CONTROL_MOVE_ONLY:id,LIBRARY_CONTROL_TRANSPORT_CHILD:'1'});
  if(!result.ok||result.value?.['completed']!==true){
    const why=result.said||String(result.value?.['detail']??'the carrier could not verify it');
    if(why.startsWith('LIBRARY_POSTBOX_FAULT:'))throw new Error(why);
    throw new ControlMovePending('Control '+id+' still needs its server move: '+why,result.value?.['reachable']!==false,/not verified|does not match/.test(why));
  }
  return 'control-only check verified delivered/ and the local receipt for '+id;
}

function clearControlDeferral(workspace:string,id:string):void{
  const state=readState(workspace);const changes:Record<string,unknown>={};
  for(const key of ['controls_deferred','controls_refused']){
    const rows=state?.[key];if(!Array.isArray(rows))continue;
    const kept=rows.filter(row=>!row||typeof row!=='object'||(row as Record<string,unknown>)['delivery_id']!==id);
    if(kept.length!==rows.length)changes[key]=kept;
  }
  if(Object.keys(changes).length)updateState(workspace,changes);
}

/** Finish only an existing intent: no fresh inbox filing, discovery, or full-check timestamp update. */
async function finishControlMoveOnly(workspace:string,id:string):Promise<Record<string,PsJsonValue>>{
  const record=readRecords(workspace).find(r=>r.direction==='incoming'&&r.kind==='report-control-applied'&&r.delivery_id===id);
  const stage=record?.stages.find(s=>s.name==='server-move');
  if(!DELIVERY_ID.test(id)||!record||!stage||record.stages.some(s=>s!==stage&&s.state!=='done'))refuse('Control transport needs an existing incoming intent with its local stages complete. Run a normal postbox check first.');
  const value:Record<string,PsJsonValue>={schema:1,operation:'Finish a received Report control',delivery_id:id,completed:false};
  if(stage.state==='done'){clearControlDeferral(workspace,id);return {...value,completed:true};}
  const state=requireState(workspace);const session=await openPostbox(workspace,state);
  if(typeof session==='string')return {...value,reachable:false,detail:session.substring(0,300)};
  const file=await fileAt(session,state.project_id,inboxPath(state.library_id,id));
  if(file){
    const read=await readListed(session,state.project_id,file);
    if(!read||!('text' in read)||payloadDigest(read.text)!==record.payload['wire_digest'])refuse('The recorded control does not match its inbox copy; it was not moved.');
    const moved=await moveToDelivered(session,state.project_id,workspace,state.library_id,file,id,payloadDigest(read.text));
    if(moved.outcome==='not-moved')return {...value,reachable:true,detail:moved.answer?.detail??'The carrier did not verify the move.'};
    if(process.env['LIBRARY_POSTBOX_FAULT']==='after:control-server-write')refuse('LIBRARY_POSTBOX_FAULT: the control server move landed before its local receipt.');
    clearControlDeferral(workspace,id);recordControlMove(workspace,id,'control-only move verified in delivered/');
    return {...value,reachable:true,completed:true};
  }
  const there=await fileAt(session,state.project_id,deliveredPath(state.library_id,id));
  const read=there?await readListed(session,state.project_id,there):null;
  if(!read||!('text' in read)||payloadDigest(read.text)!==record.payload['wire_digest'])refuse('The recorded control is not verified in the inbox or delivered/; its move remains pending.');
  clearControlDeferral(workspace,id);recordControlMove(workspace,id,'control-only reconciliation verified delivered/');
  return {...value,reachable:true,completed:true};
}

/** The incoming control dispatcher is separate from ordinary filing (kickoffs/c50 row 2). */
function applyControl(workspace:string,filing:PostboxFiling){return receiveReportControl(workspace,filing);}

function recordControlMove(workspace:string,id:string,proof:string):void {
  const record=readRecords(workspace).find(r=>r.kind==='report-control-applied'&&r.direction==='incoming'&&r.delivery_id===id);
  const stage=record?.stages.find(s=>s.name==='server-move'&&s.state==='pending');
  if(record&&stage&&record.stages.every(s=>s===stage||s.state==='done')){
    delete record.payload['control_move_pending'];delete record.payload['control_move_unverified'];
    completeStage(workspace,record,stage.name,proof);
  }
}

async function check(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('postbox', 'check'));
  const finishOnly=process.env['LIBRARY_CONTROL_MOVE_ONLY']??'';
  if(finishOnly)return finishControlMoveOnly(workspace,finishOnly);
  const recovery = recover(workspace, 'postbox check', reportStageRunner(workspace));
  const removed = removeCompleted(workspace, 30);
  const state = requireState(workspace);
  const value: Record<string, PsJsonValue> = { schema: 1, operation: 'Check the Postbox for letters', workspace, reachable: true, records_removed: removed,
    ...(recovery.controls_set_aside ? {controls_set_aside: recovery.controls_set_aside} : {}),
    ...(recovery.controls_move_pending ? {controls_move_pending: recovery.controls_move_pending} : {}),
  };
  // THE SESSION CHECK SENDS FIRST (kickoffs/s123 row 5): what waits in the outbox, then the inbox, in one child.
  if (parsed.flags.has('send-first')) {
    try {
      const sent = await send([], workspace, true);
      value['sent'] = sent['sent'] ?? 0;
    } catch (error) {
      value['send_detail'] = (error as Error).message.substring(0, 300);
    }
  }
  const session = await openPostbox(workspace, state);
  if (typeof session === 'string') {
    const since = recordUnreachable(workspace, session);
    return { ...value, reachable: false, unreachable_since: since, detail: session.substring(0, 300) };
  }
  const folder = inboxFolder(state.library_id);
  const filed: Record<string, PsJsonValue>[] = [];
  const skipped: Record<string, PsJsonValue>[] = [];
  const notHandled: Record<string,PsJsonValue>[] = [];
  const priorDeferred=Array.isArray(state['controls_deferred'])?state['controls_deferred'] as {delivery_id:string;first_deferred_utc:string}[]:[];
  const priorRefused=Array.isArray(state['controls_refused'])?state['controls_refused'].filter((row:unknown)=>row&&typeof row==='object'&&!Array.isArray(row)) as Record<string,unknown>[]:[];
  const refused:Record<string,PsJsonValue>[]=[];
  const deferred:Record<string,PsJsonValue>[]=[];
  const controls:Record<string,PsJsonValue>[]=[];
  const controlConflict:Record<string,PsJsonValue>[]=[];
  let alreadyFiled = 0;
  let moved = 0;
  let left = 0;
  const known = new Map(leftCopies(state).map((row) => [row.path, row.updated_at]));
  for (const file of await listFolderFiles(session, state.project_id, folder)) {
    if (known.get(file.path) === file.updated_at) continue;
    const deliveryId = file.path.slice(folder.length + 1).replace(/\.md$/, '');
    const read = DELIVERY_ID.test(deliveryId) ? await readListed(session, state.project_id, file) : null;
    if (read === null) {
      skipped.push({ path: file.path, why: DELIVERY_ID.test(deliveryId) ? 'gone before it was read' : 'not named by a delivery id' });
      continue;
    }
    if ('refused' in read) {
      skipped.push({ path: file.path, why: `${read.refused.substring(0, 300)} Left in the inbox.` });
      continue;
    }
    const text = read.text;
    const fields = deliveredFields(text);
    if (fields.get('delivery_id') !== deliveryId || fields.get('for_library_id') !== state.library_id || !LIBRARY_ID.test(fields.get('from_library_id') ?? '')) {
      skipped.push({ path: file.path, why: 'its delivery id, its sender or its recipient Library is not this file\'s or this Library\'s; left in the inbox' });
      continue;
    }
    if (fields.get('from_library_id') === state.library_id) {
      skipped.push({ path: file.path, why: 'a letter from this Library itself; left in the inbox' });
      continue;
    }
    const filing = filingOf(workspace, file.path, text, fields);
    if (filing.kind === 'control') {
      let control:ReturnType<typeof applyControl>;
      const controlFields=new Map(filing.fields);
      try {control=applyControl(workspace,filing);}
      catch(error){
        if((error as Error).message.startsWith('LIBRARY_POSTBOX_FAULT:'))throw error;
        const why=(error as Error).message.substring(0,300);
        const parent=controlFields.get('amends_delivery_id')??controlFields.get('withdraws_delivery_id')??'';
        const seq=Number(controlFields.get('report_seq_applied'));
        const first=priorRefused.find(row=>row['delivery_id']===deliveryId)?.['first_refused_utc'];
        refused.push({delivery_id:deliveryId,...(parent?{parent}:{}),why,first_refused_utc:typeof first==='string'&&Number.isFinite(Date.parse(first))?first:utcSeconds(),...(Number.isSafeInteger(seq)&&seq>0?{report_seq:seq}:{})});
        skipped.push({path:file.path,why});continue;
      }
      const row={delivery_id:deliveryId,parent:control.parent,status:control.status,report_seq:Number(controlFields.get('report_seq_applied')),...(control.effect?{effect:control.effect}:{})};
      if(control.status==='deferred'){deferred.push({...row,why:control.why??'',first_deferred_utc:priorDeferred.find(r=>r.delivery_id===deliveryId)?.first_deferred_utc??utcSeconds()});continue;}
      controls.push(row);if(control.status==='conflict')controlConflict.push(row);
      crashAfterFileForTest();
      const result=await moveToDelivered(session,state.project_id,workspace,state.library_id,file,deliveryId,payloadDigest(text));
      // SELF-TEST ONLY: the server move landed, but its local stage receipt did not.
      if(result.outcome!=='not-moved'&&process.env['LIBRARY_POSTBOX_FAULT']==='after:control-server-write')refuse('LIBRARY_POSTBOX_FAULT: the control server move landed before its local receipt.');
      if(result.outcome==='moved'){moved++;recordControlMove(workspace,deliveryId,'verified in delivered/');}
      else if(result.outcome==='left'){left++;recordControlMove(workspace,deliveryId,'matching delivered/ copy; inbox copy recorded');}
      else skipped.push({path:file.path,why:'control applied here and not yet moved to delivered/; the next check moves it',move_answer:result.answer?.detail??'no move was sent'});
      continue;
    }
    let said: Record<string, PsJsonValue>;
    if (filing.kind === 'outcome') {
      const bodyRefusal = filing.body.trim() ? strayControlRefusal(filing.body, `postbox ${filing.deliveryId}`) : 'The note body is empty; nothing was captured.';
      if (bodyRefusal !== null) { skipped.push({path:file.path,why:bodyRefusal}); continue; }
      const outcomeFields = new Map(filing.fields);
      const gen = Number(outcomeFields.get('outcome_gen'));
      if (filing.book !== 'letters' || !outcomeFields.get('closes_delivery_id') || !outcomeFields.get('outcome') || !Number.isSafeInteger(gen) || gen < 1 || !filing.forSeat || !filing.forSeatId) {
        notHandled.push({delivery_id:deliveryId,kind:'outcome',path:file.path,why:'No complete verdict, generation or recipient address; left in the inbox.'});
        continue;
      }
      const received = receiveReportOutcome(workspace,filing);
      said = {status:received.already?'already-filed':'captured', note_page:'shelf/letters/wiki/'+received.page, answered:{effect:received.effect}};
    } else {
      const result = captureVerb([filing.book, '--title', deliveryId], workspace, { postbox: filing, mode:'filing' });
      if (result.refusal !== null) {
        skipped.push({ path: file.path, why: `not filed: ${result.refusal.substring(0, 300)}` });
        continue;
      }
      said = (result.value ?? {}) as Record<string, PsJsonValue>;
    }
    if (said['status'] === 'already-filed') alreadyFiled += 1;
    else filed.push({ book:filing.book, kind:filing.kind, dropped_keys:filing.droppedKeys, delivery_id: deliveryId, note_page: said['note_page'] ?? null, for_seat: filing.forSeat, stale_delivery: filing.fields.some(([key]) => key === 'stale_delivery'), postbox_damaged: filing.fields.some(([key]) => key === 'postbox_damaged'), ...(said['answered'] ? { answered: said['answered'] } : {}) });
    crashAfterFileForTest();
    const { outcome, answer } = await moveToDelivered(session, state.project_id, workspace, state.library_id, file, deliveryId, payloadDigest(text));
    if (outcome === 'moved') moved += 1;
    else if (outcome === 'left') left += 1;
    else {
      // WHAT THE MOVE WAS ANSWERED (kickoffs/s133 row 2): the server's words, cut at 300 characters, or `dropped`.
      const moveAnswer = answer === null ? 'no move was sent' : answer.dropped ? 'dropped' : answer.detail ? answer.detail.substring(0, 300) : 'answered as moved, but the listings do not find it in delivered/';
      skipped.push({ path: file.path, why: 'filed here, and not yet moved to delivered/; the next check moves it', move_answer: moveAnswer });
    }
  }
  // Enrich after the whole listing: a refused predecessor may sort after its waiting successor.
  for(const row of deferred){
    const blocker=refused.filter(r=>r['parent']===row['parent']&&Number.isSafeInteger(Number(r['report_seq']))&&Number(r['report_seq'])<Number(row['report_seq']))
      .sort((a,b)=>Number(a['report_seq'])-Number(b['report_seq']))[0];
    if(blocker){row['blocked_by']=blocker['delivery_id']!;row['why']='waiting for refused control '+String(blocker['delivery_id'])+': '+String(blocker['why']);}
  }
  // A crash can land a server move before its local receipt. Verify that pending stage by listing and digest.
  for(const record of readRecords(workspace).filter(r=>r.kind==='report-control-applied'&&r.direction==='incoming'&&r.stages.some(s=>s.name==='server-move'&&s.state==='pending'))){
    if(!record.stages.every(s=>s.name==='server-move'||s.state==='done'))continue;
    const there=await fileAt(session,state.project_id,deliveredPath(state.library_id,record.delivery_id));
    if(there){const read=await readListed(session,state.project_id,there);if(read&&'text' in read&&payloadDigest(read.text)===record.payload['wire_digest']){recordControlMove(workspace,record.delivery_id,'reconciled matching delivered/ copy');continue;}}
    if(!await fileAt(session,state.project_id,inboxPath(state.library_id,record.delivery_id)))recordPendingControlMove(workspace,record,new ControlMovePending('its server copy cannot be verified',true,true));
  }
  const lastCheck = utcSeconds();
  // THE ENTRY'S SEATS, REFRESHED WHEN THEY CHANGED (kickoffs/s128 row 1): a seat added after setup can then be written
  // to from another Library. A refresh that fails never fails the check; the cache keeps its old seats, so the next
  // check tries again. The entry's `last_check` is written only with a refresh.
  const seats = receivingSeats(workspace);
  // AND WHEN ITS TRIAGING SEAT CHANGED (kickoffs/s143 row 2): named here and not yet in the entry, or no longer a live seat
  // here (its registry row gone or its id changed), when the line is dropped and this Library's own setting cleared.
  const { triager, dropped } = ownTriager(state, state.library_id, seats);
  let refreshed = false;
  let entryDetail: string | null = null;
  if (!sameSeats(seats, state['seats']) || !sameTriager(triager, state['entry_reports_triaged_by'])) {
    try {
      await refreshEntry(session, state, seats, lastCheck, triager);
      refreshed = true;
    } catch (error) {
      entryDetail = (error as Error).message.substring(0, 300);
    }
  }
  // DISCOVERY (kickoffs/s143 row 4): every entry read, the pin and the conflict recorded by criterion 2's rules. A listing
  // that fails never fails the check; the pin and the cache stay as they were.
  let discoveryDetail: string | null = null;
  try {
    const { entries } = await readEntries(session, state.project_id);
    updateState(workspace, { entries_seen: entries.map((entry) => ({ library_id: entry.library_id, library_card: entry.library_card, reports_triaged_by: entry.reportsTriagedBy })), entries_seen_utc: lastCheck });
    applyDiscovery(workspace, entries);
  } catch (error) {
    discoveryDetail = (error as Error).message.substring(0, 300);
  }
  const droppedLine = refreshed && dropped !== null
    ? `The triaging seat ${dropped.seat} (seat_id ${dropped.seat_id}) is no longer a live seat here, so this Library's Postbox entry no longer names a seat that triages Reports, and its own setting is cleared. Name another with deskpost reports triager <seat> --preflight.`
    : null;
  updateState(workspace, {
    last_check: lastCheck, unreachable_since: null, unreachable_detail: null, controls_deferred:deferred, controls_refused:refused, last_check_counts: { filed: filed.length, already_filed: alreadyFiled, moved, left, skipped: skipped.length },
    ...(refreshed ? { seats, entry_reports_triaged_by: triager } : {}),
    ...(droppedLine !== null ? { reports_triager: null } : {}),
  });
  return {
    ...value, last_check: lastCheck, controls_refused:refused, controls_refused_count:refused.length, controls:controls as unknown as PsJsonValue, deferred:deferred as unknown as PsJsonValue, deferred_count:deferred.length, control_conflict:controlConflict as unknown as PsJsonValue, control_conflict_count:controlConflict.length, not_handled:notHandled as unknown as PsJsonValue, not_handled_count:notHandled.length, filed: filed as unknown as PsJsonValue, already_filed: alreadyFiled, moved, left, skipped: skipped as unknown as PsJsonValue,
    entry_refreshed: refreshed, ...(entryDetail === null ? {} : { entry_detail: entryDetail }), ...(droppedLine === null ? {} : { reports_triager_dropped: droppedLine }),
    reports_triager: (readState(workspace)?.['reports_triager'] ?? null) as PsJsonValue, reports_triager_conflict: (readState(workspace)?.['reports_triager_conflict'] ?? null) as PsJsonValue,
    held: readOutbox(workspace).filter((entry) => entry.state === 'unsent' && entry.held).length, ...(discoveryDetail === null ? {} : { discovery_detail: discoveryDetail }),
  };
}

/**
 * ONCE PER SESSION, OUT OF THE WAY (kickoffs/s123 row 5; plan item 6): for a Library with a Postbox, one detached child
 * runs `postbox check --send-first`, with the 5-second budget for each MCP call, and is never waited for (the
 * `detached: true` + `unref` pattern of `seat.ts`'s claim holder). At most once per session: the session is recorded
 * in the cache first, and a second start with the same one spawns nothing. Its result lands in the cache, where the
 * Desk reads it. A Library with no Postbox spawns nothing and gets no answer.
 */
export function startSessionCheck(workspace: string, session: string): 'started' | 'already-checked' | null {
  const state = readState(workspace);
  if (state === null || !UUID.test(String(state['project_id'] ?? ''))) return null;
  const last = state['session_check'] as Record<string, unknown> | null | undefined;
  if (session && last?.['session'] === session) return 'already-checked';
  updateState(workspace, { session_check: { session: session || null, started_utc: utcSeconds() } });
  const self = selfCommand();
  const child = spawn(self.file, [...self.args, 'postbox', 'check', '--send-first', '--workspace', workspace], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, LIBRARY_MCP_TIMEOUT_MS: String(SESSION_CHECK_TIMEOUT_MS) },
  });
  child.on('error', () => {
    // a check that could not start leaves the cache as it was; the next session tries again
  });
  child.unref();
  return 'started';
}

// --- status and resolve ---------------------------------------------------------------------------------------------

function status(workspace: string): Record<string, PsJsonValue> {
  const state = readState(workspace);
  if (state === null) {
    return { schema: 1, operation: 'Postbox status', workspace, set_up: false, note: 'This Library has no Postbox yet: deskpost postbox setup --url <mcp-url> --preflight.' };
  }
  return {
    schema: 1, operation: 'Postbox status', workspace, set_up: true, reports_triager: null, reports_triager_conflict: null, ...(state as Record<string, PsJsonValue>),
    source: 'the cache from the last setup or check; status calls no server',
  };
}

// --- reports triager (kickoffs/s143 row 3; reports-across-Libraries step 2) -----------------------------------------

interface TriagerPlan {
  value: Record<string, PsJsonValue>;
  session: McpSession;
  state: ReturnType<typeof requireState>;
  mode: 'set' | 'clear' | 'follow';
  seats: PostboxSeat[];
  after: PostboxSeat | null;
  followed: PostboxEntry | null;
}

/**
 * THE PREVIEW `reports triager` WRITES FROM: this Library's entry before and after, or the Library it would follow. The
 * plan id binds the entry as read now (its `last_check`, seats and triaging seat), so an entry changed since the preview
 * refuses the apply.
 */
async function planTriager(parsed: ReturnType<typeof parseArguments>, workspace: string): Promise<TriagerPlan> {
  const state = requireState(workspace);
  const name = (parsed.positional[0] ?? '').trim();
  const follow = (parsed.options.get('follow') ?? '').trim();
  const clear = parsed.flags.has('clear');
  if ([name !== '', follow !== '', clear].filter(Boolean).length !== 1) {
    refuse('deskpost reports triager takes one of: a seat here (<seat>), --clear, or --follow <library-id-or-card>. Nothing was written.');
  }
  const session = await openPostbox(workspace, state);
  if (typeof session === 'string') refuse(`The Postbox did not answer, so nothing was written: ${session.substring(0, 300)}`);
  const { entries } = await readEntries(session, state.project_id);
  if (follow) {
    const followed = resolveAddress(entries, follow);
    if (followed.library_id === state.library_id) refuse(`'${follow}' is this Library. To name a seat here as the one that triages Reports: deskpost reports triager <seat> --preflight. Nothing was written.`);
    if (followed.reportsTriagedBy === null) refuse(`The Library '${followed.library_card}' (${followed.library_id}) names no seat that triages Reports in its Postbox entry, so it cannot be followed. Nothing was written.`);
    const essentials = { workspace, mode: 'follow', library_id: followed.library_id, card: followed.library_card, seat: followed.reportsTriagedBy, last_check: followed.last_check };
    return {
      session, state, mode: 'follow', seats: [], after: followed.reportsTriagedBy, followed,
      value: {
        schema: 1, operation: 'Follow the Library that triages Reports', workspace, library_id: followed.library_id, library_card: followed.library_card,
        reports_triaged_by: followed.reportsTriagedBy as unknown as PsJsonValue, reports_triager_before: (state['reports_triager'] ?? null) as PsJsonValue,
        writes: [`record that Reports go to ${followed.library_card} (${followed.library_id}) in ${statePath(workspace)}`, 'clear any recorded reports_triager_conflict'],
        plan_id: 'reports-triager-' + sha256OfText(JSON.stringify(essentials)), confirmation_required: true, shared_library_write: false,
      },
    };
  }
  const seats = receivingSeats(workspace);
  let after: PostboxSeat | null = null;
  if (name) {
    after = seats.find((row) => row.seat === name) ?? null;
    if (after === null) {
      const elsewhere = entries.find((entry) => entry.library_id !== state.library_id && entry.seats.some((row) => row.seat === name));
      refuse(
        elsewhere
          ? `'${name}' is a seat of the Library '${elsewhere.library_card}' (${elsewhere.library_id}), not of this one: only a seat here can be named. To send Reports there: deskpost reports triager --follow ${elsewhere.library_id} --preflight. Nothing was written.`
          : `This Library has no live seat '${name}' with a valid seat_id, so it cannot triage Reports. Seats here: ${seats.map((row) => row.seat).join(', ') || '(none)'}. Nothing was written.`,
      );
    }
  }
  const own = entries.find((entry) => entry.library_id === state.library_id) ?? null;
  const card = state.library_card;
  const essentials = { workspace, mode: clear ? 'clear' : 'set', library_id: state.library_id, after, seats, own: own === null ? null : { card: own.library_card, last_check: own.last_check, seats: own.seats, triager: own.reportsTriagedBy } };
  return {
    session, state, mode: clear ? 'clear' : 'set', seats, after, followed: null,
    value: {
      schema: 1, operation: clear ? 'Clear the seat that triages Reports' : 'Name the seat that triages Reports', workspace, library_id: state.library_id, library_card: card,
      entry_path: entryPath(state.library_id),
      reports_triaged_by_before: (own?.reportsTriagedBy ?? null) as unknown as PsJsonValue, reports_triaged_by_after: after as unknown as PsJsonValue,
      entry_before: own === null ? null : entryText(own.library_card, own.seats, own.reportsTriagedBy), entry_after: entryText(card, seats, after),
      writes: [`rewrite this Library's Postbox entry, ${entryPath(state.library_id)}, and read it back`, `record the setting in ${statePath(workspace)}`],
      plan_id: 'reports-triager-' + sha256OfText(JSON.stringify(essentials)), confirmation_required: true, shared_library_write: true,
    },
  };
}

/**
 * `deskpost reports triager <seat> | --clear | --follow <library-id-or-card>` (kickoffs/s143 row 3; reports-across-Libraries
 * step 2 and criterion 1): names the seat here that triages Reports for every Library in this Library's own Postbox entry
 * (written over itself and read back, as setup does), or removes it, or pins the Library another entry names. Each takes
 * `--preflight`, then `--user-confirmed --plan-id <id>`.
 */
export async function reportsTriagerVerb(argv: string[], workspace: string): Promise<{ refusal: string | null; value: Record<string, PsJsonValue> | null }> {
  try {
    const parsed = parseArguments(argv, argumentTable('reports', 'triager'));
    const plan = await planTriager(parsed, workspace);
    if (parsed.flags.has('preflight')) return { refusal: null, value: { ...plan.value, written: false } };
    if (!parsed.flags.has('user-confirmed') || (parsed.options.get('plan-id') ?? '').trim() !== plan.value['plan_id']) {
      refuse(
        'deskpost reports triager needs --preflight first, then --user-confirmed --plan-id <its plan_id>. A different plan_id means this Library, ' +
          'its seats or the Postbox entry changed since the preview. Nothing was written.',
      );
    }
    const pinned = utcSeconds();
    if (plan.mode === 'follow') {
      const followed = plan.followed!;
      updateState(workspace, {
        reports_triager: { library_id: followed.library_id, seat: plan.after!.seat, seat_id: plan.after!.seat_id, pinned_utc: pinned, source: 'follow' },
        reports_triager_conflict: null,
      });
      return { refusal: null, value: { ...plan.value, written: true, pinned_utc: pinned } };
    }
    await refreshEntry(plan.session, plan.state, plan.seats, pinned, plan.after);
    const previous = plan.state['reports_triager'];
    updateState(workspace, {
      seats: plan.seats,
      entry_reports_triaged_by: plan.after,
      reports_triager: plan.after !== null
        ? { library_id: plan.state.library_id, seat: plan.after.seat, seat_id: plan.after.seat_id, pinned_utc: pinned, source: 'self' }
        : field(previous, 'library_id') === plan.state.library_id ? null : previous ?? null,
    });
    return { refusal: null, value: { ...plan.value, written: true, readback_matched: true } };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}

async function resolve(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('postbox', 'resolve'));
  const address = parsed.positional[0] ?? '';
  const state = readState(workspace);
  if (state === null || !UUID.test(String(state['project_id'] ?? ''))) refuse('This Library has no Postbox yet, so no address can be resolved: deskpost postbox setup --url <mcp-url> --preflight.');
  const session = new McpSession(String(state['url']), 'deskpost-postbox');
  await session.initialize();
  const { entries } = await readEntries(session, String(state['project_id']));
  const entry = resolveAddress(entries, address);
  return {
    schema: 1, operation: 'Resolve a Library address', workspace, address, library_id: entry.library_id, library_card: entry.library_card, seats: entry.seats as unknown as PsJsonValue,
    reports_triaged_by: entry.reportsTriagedBy as unknown as PsJsonValue, entry_path: entry.path,
  };
}

export const POSTBOX_ACTIONS = ['check', 'resolve', 'send', 'setup', 'status'];

/** `deskpost postbox setup|status|resolve|send|check`. */
export async function runPostboxVerb(argv: string[], workspace: string): Promise<{ refusal: string | null; value: Record<string, PsJsonValue> | null }> {
  const action = argv[0] ?? '';
  try {
    if (action === 'setup') return { refusal: null, value: await setup(argv.slice(1), workspace) };
    if (action === 'status') return { refusal: null, value: status(workspace) };
    if (action === 'resolve') return { refusal: null, value: await resolve(argv.slice(1), workspace) };
    if (action === 'send') return { refusal: null, value: await send(argv.slice(1), workspace) };
    if (action === 'check') return { refusal: null, value: await check(argv.slice(1), workspace) };
    return { refusal: `deskpost postbox has no action '${action}'. It has: ${POSTBOX_ACTIONS.join(', ')}.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
