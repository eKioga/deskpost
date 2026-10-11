/**
 * THE AUDIT RECORD AND `audit due` (kickoffs/s112 rulings 5-6; PLAN-seat-identity.md section 7).
 *
 *   deskpost audit revision <target> [--json]
 *   deskpost audit record <target> --revision <r> --findings <n> [--report <page>] [--json]
 *   deskpost audit due [--days <n>] [--json]
 *
 * TARGETS, canonical: `shelf/<slug>` (a Shelf Book), `collection/<slug>` (a local collection Book), `projects/<slug>`
 * (a local Project Hub) and `repo:<absolute path>`. A capture Book (`holding`, `letters`, `reports`) is none: it holds
 * notes in transit, so `audit due` leaves it out and `revision` and `record` refuse it (kickoffs/s113 ruling 1).
 *
 * A REVISION NAMES WHAT AN AUDITOR READ, and is `unknown` with the reason whenever it cannot be vouched for:
 * - a Book: `book:<generation>:<source digest>` from its stored manifest, only AFTER the digest is recomputed from the
 *   page bytes on disk as Discovery does (`discovery.ts`): a page edited in place under an `ok` manifest, or a dirty,
 *   missing or unreadable manifest, is `unknown`;
 * - a Hub: `hub:<sha256>` over its sorted relative paths and file hashes;
 * - a repo: `commit:<HEAD>` while the working tree and index are clean (an untracked file counts as a change); a dirty
 *   repo, or a folder that is not one, is `unknown`. Only `git status` and `git rev-parse` run: NO NETWORK.
 *
 * `audit record` IS UNGATED (it writes only `internal/audit-records.jsonl`, an append-only log) and the auditor takes
 * the revision BEFORE it starts reading. A record also says whether the revision was already `superseded` when it was
 * written, which makes the target due at once. `audit due` reads; `unknown` is `due: unknown`, never counted as clean.
 * The kernel never judges content: the audits are the auditor seat's reading.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryNeutralEnv } from './gitenv.ts';
import type { PsJsonValue } from './psjson.ts';
import { localCollectionRoot } from './collection.ts';
import { CAPTURE_KIND_LINE, getShelfBook, listFilesRecursive, readUtf8, shelfCatalogPath, shelfCatalogSections, type ShelfBook } from './shelfbook.ts';
import { getShelfBookPageDigest } from './manifest.ts';
import { getStoredBookManifest } from './manifeststore.ts';
import { readRegistryRows, registryFilePath } from './seatregistry.ts';
import { deskEntriesForSeat, resolveSeatName, seatDirectoryNames } from './seatdesk.ts';
import { controlCharacterInLine } from './controlchars.ts';
import { destinationOf, type SeatMetadataProjection } from './seatmeta.ts';

export class AuditRefusal extends Error {}

function refuse(message: string): never {
  throw new AuditRefusal(message);
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const AUDIT_RECORDS_RELATIVE = 'internal/audit-records.jsonl';
export const AUDIT_DEFAULT_DAYS = 30;

export interface AuditTarget {
  kind: 'shelf' | 'collection' | 'project' | 'repo';
  /** The canonical form, as a record stores it. */
  target: string;
  slug: string | null;
  /** The repo's absolute folder; null for the others. */
  folder: string | null;
}

/** A target in its canonical form, or a refusal naming the four forms. */
export function parseAuditTarget(text: string): AuditTarget {
  const value = text.trim();
  const forms = 'shelf/<slug>, collection/<slug>, projects/<slug> or repo:<absolute path>';
  if (value.startsWith('repo:')) {
    const given = value.slice('repo:'.length);
    if (!given || !path.isAbsolute(given)) refuse(`An audit target 'repo:' takes an absolute path; got '${given}'. Targets are ${forms}.`);
    const folder = path.resolve(given);
    return { kind: 'repo', target: `repo:${folder.split(path.sep).join('/')}`, slug: null, folder };
  }
  const match = /^(shelf|collection|projects)\/([^/]+)$/.exec(value);
  if (!match || !SLUG.test(match[2]!)) refuse(`'${value}' is not an audit target. Targets are ${forms}.`);
  const kind = match[1] === 'projects' ? 'project' : (match[1] as 'shelf' | 'collection');
  return { kind, target: `${match[1]}/${match[2]}`, slug: match[2]!, folder: null };
}

/** The Desk line that holds this target open, or null for a repo. */
function deskEntryOf(target: AuditTarget): { kind: 'books' | 'projects'; entry: string } | null {
  if (target.kind === 'shelf') return { kind: 'books', entry: `shelf/${target.slug}` };
  if (target.kind === 'collection') return { kind: 'books', entry: `books/${target.slug}` };
  if (target.kind === 'project') return { kind: 'projects', entry: `projects/${target.slug}` };
  return null;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export interface AuditRevision {
  target: string;
  kind: AuditTarget['kind'];
  revision: string;
  /** Why the revision is `unknown`; null when it is known. */
  reason: string | null;
}

/** Whether the target is there to audit; a refusal for `record` and `revision` when it is not. */
function assertTargetExists(workspace: string, target: AuditTarget): void {
  if (target.kind === 'shelf') {
    try {
      getShelfBook(workspace, target.slug!);
    } catch (error) {
      refuse(`There is no Shelf Book '${target.slug}' to audit: ${(error as Error).message}`);
    }
  } else if (target.kind === 'collection') {
    if (!fs.existsSync(path.join(localCollectionRoot(workspace), 'books', target.slug!, 'wiki'))) refuse(`There is no collection Book '${target.slug}' in this Library to audit.`);
  } else if (target.kind === 'project') {
    if (!fs.existsSync(path.join(localCollectionRoot(workspace), 'projects', target.slug!, '_project.md'))) refuse(`There is no Project Hub '${target.slug}' in this Library to audit.`);
  } else if (!fs.existsSync(target.folder!) || !fs.statSync(target.folder!).isDirectory()) {
    refuse(`There is no folder at '${target.folder}' to audit.`);
  }
}

/** A capture Book has no audit (kickoffs/s113 ruling 1); a Book that cannot be read is left to the other refusals. */
function refuseCaptureBook(workspace: string, target: AuditTarget, nothing: string): void {
  if (target.kind !== 'shelf') return;
  let book: ShelfBook;
  try {
    book = getShelfBook(workspace, target.slug!);
  } catch {
    return;
  }
  if (book.isCapture) refuse(`'${target.slug}' is a capture Book: it holds notes in transit, not reference material, so it has no audit. ${nothing}`);
}

function bookRevision(workspace: string, target: AuditTarget): AuditRevision {
  const unknown = (reason: string): AuditRevision => ({ target: target.target, kind: target.kind, revision: 'unknown', reason });
  const collection = target.kind === 'shelf' ? 'shelf' : 'collection';
  let stored;
  try {
    stored = getStoredBookManifest(workspace, target.slug!, collection);
  } catch (error) {
    return unknown(`its manifest cannot be read: ${(error as Error).message}`);
  }
  const repair = target.kind === 'shelf' ? `run deskpost shelf rebuild ${target.slug}` : 'run deskpost collection rebuild';
  if (stored.status !== 'ok' || stored.generation === null || !stored.sourceDigest) return unknown(`its manifest is ${stored.status}${stored.reason ? ` (${stored.reason})` : ''}; ${repair}`);
  const wikiPath = target.kind === 'shelf' ? getShelfBook(workspace, target.slug!).wikiPath : path.join(localCollectionRoot(workspace), 'books', target.slug!, 'wiki');
  let digest = '';
  try {
    digest = getShelfBookPageDigest({ wikiPath } as ShelfBook);
  } catch (error) {
    return unknown(`its pages cannot be read: ${(error as Error).message}`);
  }
  if (digest !== stored.sourceDigest) return unknown(`a page changed after its manifest was written; ${repair}`);
  return { target: target.target, kind: target.kind, revision: `book:${stored.generation}:${stored.sourceDigest}`, reason: null };
}

function hubRevision(workspace: string, target: AuditTarget): AuditRevision {
  const root = path.join(localCollectionRoot(workspace), 'projects', target.slug!);
  try {
    const lines = listFilesRecursive(root).map((file) => `${path.relative(root, file).split(path.sep).join('/')}:${sha256(fs.readFileSync(file))}`);
    lines.sort();
    return { target: target.target, kind: target.kind, revision: `hub:${sha256(lines.join('\n'))}`, reason: null };
  } catch (error) {
    return { target: target.target, kind: target.kind, revision: 'unknown', reason: `its files cannot be read: ${(error as Error).message}` };
  }
}

/** `git` in the folder, local commands only, with no prompt and no pager. */
function git(folder: string, args: string[]): { ok: boolean; out: string } {
  // REPOSITORY-NEUTRAL (gitenv.ts): under a hook's GIT_DIR the folder named here would not be the one read.
  const env = { ...repositoryNeutralEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const ran = spawnSync('git', ['-C', folder, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: repositoryNeutralEnv(env) });
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}`.trim() || `${ran.stderr ?? ''}${ran.error?.message ?? ''}`.trim() };
}

function repoRevision(target: AuditTarget): AuditRevision {
  const unknown = (reason: string): AuditRevision => ({ target: target.target, kind: target.kind, revision: 'unknown', reason });
  const head = git(target.folder!, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok || !/^[0-9a-f]{40,64}$/.test(head.out)) return unknown(`it is not a git repository with a commit (${head.out.split(/\r?\n/)[0] || 'git said nothing'})`);
  const status = git(target.folder!, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (!status.ok) return unknown(`git status failed (${status.out.split(/\r?\n/)[0]})`);
  if (status.out !== '') return unknown('its working tree or index has changes; an audit reads a commit, so commit or set them aside first');
  return { target: target.target, kind: target.kind, revision: `commit:${head.out}`, reason: null };
}

/** The target's revision now, or `unknown` with the reason. Refuses a target that is not there. */
export function auditRevision(workspace: string, target: AuditTarget): AuditRevision {
  assertTargetExists(workspace, target);
  refuseCaptureBook(workspace, target, 'Nothing was read.');
  if (target.kind === 'shelf' || target.kind === 'collection') return bookRevision(workspace, target);
  if (target.kind === 'project') return hubRevision(workspace, target);
  return repoRevision(target);
}

const REVISION_FORMS: Record<AuditTarget['kind'], RegExp> = {
  shelf: /^book:[0-9]+:[0-9a-f]{64}$/,
  collection: /^book:[0-9]+:[0-9a-f]{64}$/,
  project: /^hub:[0-9a-f]{64}$/,
  repo: /^commit:[0-9a-f]{40,64}$/,
};

export interface AuditRecord {
  target: string;
  revision: string;
  by_seat: string | null;
  by_seat_id: string | null;
  utc: string;
  findings: number;
  report_page: string | null;
  /** The target's revision had already moved on from `revision` when this was recorded. */
  superseded: boolean;
}

export function auditRecordsPath(workspace: string): string {
  return path.join(workspace, ...AUDIT_RECORDS_RELATIVE.split('/'));
}

/** Every record in the log, oldest first; a line that does not parse is skipped and counted. */
export function readAuditRecords(workspace: string): { records: AuditRecord[]; unparsable: number } {
  const file = auditRecordsPath(workspace);
  if (!fs.existsSync(file)) return { records: [], unparsable: 0 };
  const records: AuditRecord[] = [];
  let unparsable = 0;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (typeof parsed.target !== 'string' || typeof parsed.revision !== 'string' || typeof parsed.utc !== 'string') throw new Error('not a record');
      records.push(parsed);
    } catch {
      unparsable += 1;
    }
  }
  return { records, unparsable };
}

/** `audit record`: one line appended, ungated. */
export function auditRecord(workspace: string, options: { target: string; revision: string | undefined; findings: string | undefined; report: string | undefined }): AuditRecord {
  const target = parseAuditTarget(options.target);
  refuseCaptureBook(workspace, target, 'Nothing was recorded.');
  const revision = (options.revision ?? '').trim();
  if (!revision) refuse(`Name the revision you read with --revision; take it first with deskpost audit revision ${target.target}. Nothing was recorded.`);
  if (!REVISION_FORMS[target.kind].test(revision)) {
    refuse(`--revision '${revision}' is not a revision of ${target.target}: take it with deskpost audit revision ${target.target}, before you start reading. Nothing was recorded.`);
  }
  const findingsText = (options.findings ?? '').trim();
  if (!/^[0-9]+$/.test(findingsText)) refuse(`--findings is how many findings the audit made, a whole number (0 for none); got '${findingsText}'. Nothing was recorded.`);
  const report = options.report === undefined ? null : options.report.trim();
  if (report !== null && (report === '' || controlCharacterInLine(report) !== null)) refuse('--report names the page the findings are on, on one line. Nothing was recorded.');
  const now = auditRevision(workspace, target);
  const stateDirectory = path.join(workspace, '.claude');
  const caller = resolveSeatName({ stateDirectory });
  const bySeat = caller.status === 'named' ? caller.seat! : null;
  let bySeatId: string | null = null;
  if (bySeat !== null) {
    try {
      bySeatId = String(readRegistryRows(registryFilePath(stateDirectory)).find((row) => row['seat'] === bySeat)?.['seat_id'] ?? '') || null;
    } catch {
      bySeatId = null;
    }
  }
  const record: AuditRecord = {
    target: target.target,
    revision,
    by_seat: bySeat,
    by_seat_id: bySeatId,
    utc: new Date().toISOString(),
    findings: Number(findingsText),
    report_page: report,
    superseded: now.revision !== revision,
  };
  const file = auditRecordsPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/** Every active Shelf Book, collection Book and Hub in this Library, and every repo recorded at least once. */
function dueTargets(workspace: string, records: AuditRecord[]): AuditTarget[] {
  const targets: AuditTarget[] = [];
  const catalog = shelfCatalogPath(workspace);
  if (fs.existsSync(catalog)) {
    for (const section of shelfCatalogSections(readUtf8(catalog))) {
      // A CAPTURE BOOK IS NOT AN AUDIT TARGET (kickoffs/s113 ruling 1): an inbox, not reference material.
      if (CAPTURE_KIND_LINE.test(section.body)) continue;
      const match = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body);
      if (match) targets.push(parseAuditTarget(`shelf/${match[1]}`));
    }
  }
  const collection = localCollectionRoot(workspace);
  for (const [folder, prefix] of [['books', 'collection'], ['projects', 'projects']] as const) {
    const root = path.join(collection, folder);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && SLUG.test(entry.name)) targets.push(parseAuditTarget(`${prefix}/${entry.name}`));
    }
  }
  for (const record of records) {
    if (record.target.startsWith('repo:') && !targets.some((target) => target.target === record.target)) targets.push(parseAuditTarget(record.target));
  }
  const seen = new Set<string>();
  return targets.filter((target) => (seen.has(target.target) ? false : (seen.add(target.target), true))).sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/** The seats whose Desk holds each Book and Hub open, by Desk line. */
function openOnDesks(workspace: string): Map<string, string[]> {
  const stateDirectory = path.join(workspace, '.claude');
  const open = new Map<string, string[]>();
  let seats: string[] = [];
  try {
    seats = seatDirectoryNames(stateDirectory);
  } catch {
    seats = [];
  }
  for (const seat of seats) {
    for (const kind of ['books', 'projects'] as const) {
      let entries: string[] = [];
      try {
        entries = deskEntriesForSeat(stateDirectory, seat, kind);
      } catch {
        entries = [];
      }
      for (const entry of entries) open.set(`${kind}:${entry}`, [...(open.get(`${kind}:${entry}`) ?? []), seat]);
    }
  }
  return open;
}

export interface AuditDueRow {
  target: string;
  last_audit: string | null;
  examined_revision: string | null;
  current_revision: string;
  current_reason: string | null;
  changed: boolean | 'unknown' | null;
  open_on_desks: string[];
  superseded: boolean;
  due: boolean | 'unknown';
  why: string;
}

/** `audit due`: one row per target, read only. */
export function auditDue(workspace: string, days: number, now = Date.now(), only: Set<string> | null = null): { rows: AuditDueRow[]; unparsable: number } {
  const { records, unparsable } = readAuditRecords(workspace);
  const open = openOnDesks(workspace);
  const rows: AuditDueRow[] = [];
  for (const target of dueTargets(workspace, records)) {
    if (only !== null && !only.has(target.target)) continue;
    const last = [...records].reverse().find((record) => record.target === target.target) ?? null;
    let current: AuditRevision;
    try {
      current = auditRevision(workspace, target);
    } catch (error) {
      current = { target: target.target, kind: target.kind, revision: 'unknown', reason: (error as Error).message };
    }
    const desk = deskEntryOf(target);
    const seats = desk ? open.get(`${desk.kind}:${desk.entry}`) ?? [] : [];
    const changed: AuditDueRow['changed'] = current.revision === 'unknown' ? 'unknown' : last === null ? null : last.revision !== current.revision;
    const superseded = last?.superseded === true;
    const age = last === null ? Number.POSITIVE_INFINITY : now - Date.parse(last.utc);
    let due: AuditDueRow['due'];
    let why: string;
    if (current.revision === 'unknown') {
      due = 'unknown';
      why = `its revision is unknown: ${current.reason}`;
    } else if (last === null) {
      due = seats.length > 0;
      why = seats.length > 0 ? `never audited, and open on ${seats.join(', ')}` : 'never audited, and open on no Desk';
    } else if (superseded) {
      due = true;
      why = 'the last audit read a revision that had already moved on';
    } else if (changed === true && !(age < days * 24 * 60 * 60 * 1000)) {
      due = true;
      why = `changed since the last audit, which is older than ${days} day${days === 1 ? '' : 's'}`;
    } else {
      due = false;
      why = changed === true ? `changed since the last audit, which is under ${days} day${days === 1 ? '' : 's'} old` : 'unchanged since the last audit';
    }
    rows.push({
      target: target.target,
      last_audit: last?.utc ?? null,
      examined_revision: last?.revision ?? null,
      current_revision: current.revision,
      current_reason: current.reason,
      changed,
      open_on_desks: seats,
      superseded,
      due,
      why,
    });
  }
  return { rows, unparsable };
}

/**
 * THE DESK COUNTS (kickoffs/s112 ruling 6), only when the Library has a department `audit` with a destination: without
 * an auditor nobody acts on them, and every Desk would otherwise gain a field. The destination's Desk gets `audits_due`;
 * any seat's Desk learns which of its open Books and Hubs are due. Null when there is no such department; the Desk
 * reads a failure here as nothing to say, never as a refusal.
 */
export function deskAuditFacts(
  workspace: string,
  projection: SeatMetadataProjection,
  seat: string,
  openTargets: string[],
): { auditsDue: number | null; dueTargets: Set<string> } | null {
  const destination = destinationOf(projection, 'audit');
  if (destination.seat === null) return null;
  const isDestination = destination.seat === seat;
  // ONLY WHAT THIS DESK SHOWS IS HASHED: every target for the auditor, the seat's open ones for anyone else.
  const { rows } = auditDue(workspace, AUDIT_DEFAULT_DAYS, Date.now(), isDestination ? null : new Set(openTargets));
  const due = rows.filter((row) => row.due === true);
  return { auditsDue: isDestination ? due.length : null, dueTargets: new Set(due.map((row) => row.target).filter((target) => openTargets.includes(target))) };
}

/** The verb: `revision`, `record` or `due`. */
export function auditVerb(action: string, options: { workspace: string; target: string | undefined; revision?: string; findings?: string; report?: string; days?: string }): { value: Record<string, PsJsonValue>; text: string } {
  if (action === 'revision' || action === 'record') {
    if (!options.target) refuse(`Name the target: deskpost audit ${action} <target>, one of shelf/<slug>, collection/<slug>, projects/<slug> or repo:<absolute path>.`);
  }
  if (action === 'revision') {
    const found = auditRevision(options.workspace, parseAuditTarget(options.target!));
    return {
      value: { schema: 1, operation: 'Audit revision', target: found.target, revision: found.revision, reason: found.reason, shared_library_write: false },
      text: found.reason === null ? `${found.target}: ${found.revision}` : `${found.target}: unknown (${found.reason})`,
    };
  }
  if (action === 'record') {
    const record = auditRecord(options.workspace, { target: options.target!, revision: options.revision, findings: options.findings, report: options.report });
    return {
      value: { schema: 1, operation: 'Audit record', ...(record as unknown as Record<string, PsJsonValue>), records: AUDIT_RECORDS_RELATIVE, shared_library_write: false },
      text: `Recorded the audit of ${record.target} at ${record.revision} (${record.findings} finding${record.findings === 1 ? '' : 's'})${record.superseded ? '; that revision had already moved on, so it is due again at once' : ''}.`,
    };
  }
  if (action === 'due') {
    const daysText = (options.days ?? String(AUDIT_DEFAULT_DAYS)).trim();
    if (!/^[0-9]+$/.test(daysText)) refuse(`--days is a whole number of days; got '${daysText}'.`);
    const days = Number(daysText);
    const { rows, unparsable } = auditDue(options.workspace, days);
    const dueRows = rows.filter((row) => row.due === true);
    const unknownRows = rows.filter((row) => row.due === 'unknown');
    const lines = [
      `${dueRows.length} due, ${unknownRows.length} unknown, of ${rows.length} (an audit older than ${days} days counts once its target has changed).`,
      ...rows.filter((row) => row.due !== false).map((row) => `  ${row.due === true ? 'due    ' : 'unknown'} ${row.target}: ${row.why}`),
      ...(unparsable ? [`  ${unparsable} line${unparsable === 1 ? '' : 's'} of ${AUDIT_RECORDS_RELATIVE} did not parse and ${unparsable === 1 ? 'was' : 'were'} skipped.`] : []),
    ];
    return {
      value: { schema: 1, operation: 'Audits due', days, due_count: dueRows.length, unknown_count: unknownRows.length, targets: rows as unknown as PsJsonValue, unparsable_records: unparsable, shared_library_write: false },
      text: lines.join('\n'),
    };
  }
  refuse(`deskpost audit has no action '${action}'. It has: due, record, revision.`);
}
