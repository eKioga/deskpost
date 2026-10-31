/**
 * WHAT WAITS ON ERIC (kickoffs/s161 rows 4 to 6; plan vault-agent-contract acceptance criterion 5 and step 5; the
 * contract projects/deskpost-desk/notes/2026-10-24-needs-you-page-contract, which fixes the page's path, form, sections,
 * wording and when it is written).
 *
 * `deskpost needs-you [--json]` lists the contract's five sections, in its order and wording, from the Library's own
 * files: Kickoffs ready to start, letters waiting, items on a Hub addressed to Eric, saves that stopped on him, and
 * Reports to triage. It opens nothing, holds no seat and writes nothing, and it needs no vault connection.
 * `--write` renders the contract's page and writes it through the kernel writer to `Librarian/needs-you.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateCheckpoint } from './checkpointverb.ts';
import { openCollection } from './collection.ts';
import { captureBookRows } from './desk.ts';
import { readSeatMetadata } from './seatmeta.ts';
import { readSeatIdentityView, incarnationOf } from './seatincarnation.ts';
import { readRegistryRows, registryFilePath } from './seatregistry.ts';
import { shelfNotes } from './shelfnote.ts';
import { readVaultConnection } from './vault.ts';
import { writeVaultPage, type VaultWrite } from './vaultwrite.ts';
import { readMarker, requireWorkspace } from './workspace.ts';
import { readUtf8, shelfCatalogPath, shelfCatalogSections } from './shelfbook.ts';

export interface NeedsYouSection { key: string; heading: string; items: { seat: string | null; text: string }[] }
export interface NeedsYou { sections: NeedsYouSection[]; problems: string[] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `h:mm AM` in local time. */
function clock(date: Date): string {
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${String(date.getMinutes()).padStart(2, '0')} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** `October 24, 2026, 2:20 PM` in local time, or the text as written when it is no instant. */
export function dateAndTime(text: string): string {
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) return text || 'an unknown time';
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${clock(date)}`;
}

/** The older of two `captured` instants, by the instant; one that is no instant loses to one that is. */
function older(a: string, b: string): string {
  const [x, y] = [Date.parse(a), Date.parse(b)];
  if (!Number.isFinite(x)) return Number.isFinite(y) ? b : a || b;
  return Number.isFinite(y) && y < x ? b : a;
}

/** The `## <heading>` section's lines of a page, up to the next `#` or `##` heading; empty when there is none. */
function sectionLines(text: string, heading: string): string[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** Each top-level list item of a section, its wrapped lines joined: the item, not the line. */
function items(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (/^- /.test(line)) found.push(line.trim());
    else if (found.length && /^\s+\S/.test(line) && !/^\s+- /.test(line)) found[found.length - 1] += ' ' + line.trim();
    else if (!/^\s/.test(line)) found.push('');
  }
  return found.filter(Boolean);
}

/** The seat as the page names it: `<nickname> (<seat>)` when it has a nickname, else its name. */
function seatLabel(seat: string, nicknames: Map<string, string | null>): string {
  const nickname = nicknames.get(seat);
  return nickname ? `${nickname} (${seat})` : seat;
}

/** The five sections, from the Library's files only. A reader that cannot read a part names it in `problems`. */
export function readNeedsYou(workspace: string): NeedsYou {
  const stateDirectory = path.join(workspace, '.claude');
  const problems: string[] = [];
  let rows: Record<string, unknown>[] = [];
  try { rows = readRegistryRows(registryFilePath(stateDirectory)); } catch (error) { problems.push(`the seat registry: ${(error as Error).message}`); }
  const nicknames = new Map<string, string | null>();
  try { for (const [seat, meta] of readSeatMetadata(stateDirectory).seats) nicknames.set(seat, meta.nickname); } catch { /* no nicknames */ }
  const label = (seat: string) => seatLabel(seat, nicknames);
  const hubSeat = (hub: string): string => {
    const owner = rows.find((row) => String(row['project'] ?? '') === hub);
    return owner ? label(String(owner['seat'])) : `projects/${hub}`;
  };

  // 1 and 3: the active Hubs' `## Next` and `## Now`.
  const kickoffs: NeedsYouSection['items'] = [];
  const answers: NeedsYouSection['items'] = [];
  let hubs: string[] = [];
  try {
    const marker = readMarker(workspace);
    if (marker !== null && String(marker['backend'] ?? '') === 'local') hubs = openCollection(workspace).projectSlugs('active');
  } catch (error) {
    problems.push(`the Active Project Catalog: ${(error as Error).message}`);
  }
  for (const hub of [...hubs].sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8');
    } catch (error) {
      problems.push(`projects/${hub}/_project: ${(error as Error).message}`);
      continue;
    }
    const next = items(sectionLines(text, 'Next'));
    for (const item of next) {
      const run = /^- \[ \] Run ([A-Za-z0-9][A-Za-z0-9-]*):/.exec(item);
      if (run) kickoffs.push({ seat: hubSeat(hub), text: `${hubSeat(hub)}: ${run[1]}, waiting for you to start the seat and say yes.` });
    }
    for (const item of [...items(sectionLines(text, 'Now')), ...next]) {
      const open = /^- \[ \] (?:\*\*)?(Eric:.*)$/.exec(item);
      if (!open) continue;
      const plain = open[1]!.replace(/\*\*/g, '');
      const stop = /\.(\s|$)/.exec(plain);
      const said = (stop ? plain.substring(0, stop.index + 1) : plain).trim();
      answers.push({ seat: hubSeat(hub), text: `${hubSeat(hub)}: ${said.length > 200 ? said.substring(0, 199).trimEnd() + '…' : said}` });
    }
  }

  // 2 and 5: the capture Books' pending notes.
  const letters = new Map<string, { count: number; oldest: string }>();
  let reports = { count: 0, oldest: '' };
  try {
    const view = readSeatIdentityView(stateDirectory);
    // AN UNREADABLE CAPTURE BOOK IS A PROBLEM, NEVER "NO NOTES" (kickoffs/s168 row 5; the s167 second reader's finding 8):
    // `captureBookRows` leaves out a catalogued Book with no folder, and `shelfNotes` answers [] for a `notes` path that
    // is not a folder.
    const books = captureBookRows(workspace);
    const catalogFile = shelfCatalogPath(workspace);
    if (!fs.existsSync(catalogFile)) problems.push('shelf/_catalog.md: missing, so the capture Books cannot be listed');
    for (const section of fs.existsSync(catalogFile) ? shelfCatalogSections(readUtf8(catalogFile)) : []) {
      if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
      const slug = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body)?.[1];
      if (slug !== undefined && !books.some((book) => book.slug === slug)) problems.push(`shelf/${slug}: the Shelf catalog lists it as a capture Book, and its folder is missing`);
    }
    for (const book of books) {
      const notFolder = [path.dirname(book.notesPath), book.notesPath].find(file => fs.existsSync(file) && !fs.statSync(file).isDirectory());
      if (notFolder !== undefined) {
        problems.push(`${path.relative(workspace, notFolder).replace(/\\/g, '/')}: not a folder`);
        continue;
      }
      if (fs.existsSync(book.notesPath)) {
        try {
          fs.readdirSync(book.notesPath);
        } catch (error) {
          problems.push(`${path.relative(workspace, book.notesPath).replace(/\\/g, '/')}: ${(error as Error).message}`);
          continue;
        }
      }
      for (const note of shelfNotes(book)) {
        if (note.review === 'done') continue;
        const captured = note.captured === 'unknown' ? '' : note.captured;
        if (book.slug === 'reports') reports = { count: reports.count + 1, oldest: older(reports.oldest, captured) };
        if (book.takesLetters !== true || !note.forSeat || note.malformed.includes('for_seat') || note.malformed.includes('for_seat_id')) continue;
        const found = incarnationOf(view, note.forSeat, note.forSeatId, 'letters');
        if (found.outcome !== 'live' || !found.current_name) continue;
        const seat = found.current_name;
        const was = letters.get(seat);
        letters.set(seat, { count: (was?.count ?? 0) + 1, oldest: was ? older(was.oldest, captured) : captured });
      }
    }
  } catch (error) {
    problems.push(`the capture Books: ${(error as Error).message}`);
  }

  // 4: each seat's most recent checkpoint record, when its save or close-out waits.
  const stopped: NeedsYouSection['items'] = [];
  for (const row of [...rows].sort((a, b) => String(a['seat']).localeCompare(String(b['seat'])))) {
    const seat = String(row['seat'] ?? '');
    const seatId = String(row['seat_id'] ?? '');
    if (!/^[a-f0-9]{32}$/.test(seatId)) continue;
    const folder = path.join(workspace, 'internal', 'checkpoints', seatId);
    let newest: { file: string; at: number } | null = null;
    try {
      for (const component of [path.join(workspace, 'internal'), path.join(workspace, 'internal', 'checkpoints'), folder]) {
        if (fs.lstatSync(component).isSymbolicLink()) throw Error('a link');
      }
      for (const name of fs.readdirSync(folder)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)) continue;
        const stat = fs.lstatSync(path.join(folder, name));
        if (stat.isFile() && (newest === null || stat.mtimeMs > newest.at)) newest = { file: name, at: stat.mtimeMs };
      }
    } catch (error) {
      // A seat with no checkpoint folder has saved nothing yet; any other failure is a read that did not happen.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${seat}'s checkpoint folder internal/checkpoints/${seatId}: ${(error as Error).message}`);
      continue;
    }
    if (newest === null) continue;
    try {
      const state = validateCheckpoint(JSON.parse(fs.readFileSync(path.join(folder, newest.file), 'utf8')), seatId, newest.file.replace(/\.json$/, ''));
      const lines = [...(state.saveState === 'waits' ? state.saveWaits : []), ...(state.closeout === 'waits' ? state.waits : [])];
      for (const line of lines) stopped.push({ seat: label(seat), text: `${label(seat)}: ${line}` });
    } catch (error) {
      problems.push(`${seat}'s checkpoint record ${newest.file}: ${(error as Error).message}`);
    }
  }

  const sections: NeedsYouSection[] = [
    { key: 'kickoffs', heading: 'Kickoffs ready to start', items: kickoffs },
    {
      key: 'letters', heading: 'Letters waiting',
      items: [...letters].sort(([a], [b]) => a.localeCompare(b)).map(([seat, { count, oldest }]) => ({
        seat: label(seat), text: `${label(seat)}: ${count} ${count === 1 ? 'letter' : 'letters'}, the oldest from ${dateAndTime(oldest)}.`,
      })),
    },
    { key: 'answers', heading: 'Waiting on your answer', items: answers },
    { key: 'stopped', heading: 'Stopped saves', items: stopped },
    { key: 'reports', heading: 'Reports to triage', items: reports.count ? [{ seat: null, text: `${reports.count} pending, the oldest from ${dateAndTime(reports.oldest)}. deskpost-lead triages them.` }] : [] },
  ];
  return { sections, problems };
}

/** The sections for a person, as the page lists them, or the contract's one line when none has anything. */
export function needsYouText(needs: NeedsYou): string {
  const filled = needs.sections.filter((section) => section.items.length);
  const lines = filled.length ? filled.flatMap((section) => [`## ${section.heading}`, ...section.items.map((item) => `- ${item.text}`), '']) : ['Nothing needs you right now.', ''];
  return [...lines, ...needs.problems.map((problem) => `Not read: ${problem}`)].join('\n').trimEnd();
}

/** `2026-10-24T14:20:05-07:00`: the local time with its offset. */
function localIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export const NEEDS_YOU_PAGE = 'needs-you.md';

/** The contract's page: its four frontmatter fields, `# Needs you`, the `As of` line, and the sections that have items. */
export function renderNeedsYouPage(workspace: string, needs: NeedsYou, now = new Date()): string {
  const lines = [
    '---', 'written_by: deskpost', 'schema: 1', `library: ${path.resolve(workspace).replace(/\\/g, '/')}`, `generated: ${localIso(now)}`, '---', '',
    '# Needs you', '', `As of ${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}, ${clock(now)}.`, '',
  ];
  const filled = needs.sections.filter((section) => section.items.length);
  if (!filled.length) lines.push('Nothing needs you right now.', '');
  for (const section of filled) lines.push(`## ${section.heading}`, '', ...section.items.map((item) => `- ${item.text}`), '');
  return lines.join('\n');
}

/** The page with what changes on every write taken out: `generated` and the `As of` line. Unchanged means unwritten. */
function comparable(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n').filter((line) => !/^generated: /.test(line) && !/^As of .*\.$/.test(line)).join('\n');
}

/** Why the page may not be written here, or null: no connection, or the `needs-you` feature off. */
function notWritable(workspace: string): string | null {
  const connection = readVaultConnection(readMarker(workspace));
  if (connection === null) return 'this Library has no vault connection; make one with deskpost vault connect <folder> --preflight';
  if (!connection.features.includes('needs-you')) return "the vault connection does not have the 'needs-you' feature on";
  return null;
}

/**
 * `deskpost needs-you --write`: the page through the kernel writer, or unchanged. A refusal throws.
 *
 * AN INCOMPLETE READING WRITES NOTHING (kickoffs/s167 row 4; the audit's B5): a page made from it could say "Nothing needs
 * you right now" when Deskpost could not look. The previous page stays, and the refusal names what was not read.
 */
export function writeNeedsYou(workspace: string, needs = readNeedsYou(workspace)): VaultWrite {
  const why = notWritable(workspace);
  if (why !== null) throw new Error(`The page was not written: ${why}. Nothing was written.`);
  if (needs.problems.length) {
    throw new Error(`The page was not written: Deskpost could not read ${needs.problems.map((problem) => problem.replace(/\s+/g, ' ')).join('; ')}. The previous page was left as it was.`);
  }
  const page = renderNeedsYouPage(workspace, needs);
  return writeVaultPage(workspace, NEEDS_YOU_PAGE, page, (current) => comparable(current) === comparable(page));
}

/** Whether the page is kept here: a vault connection with the `needs-you` feature on. Reads the marker and nothing else. */
export function needsYouOn(workspace: string): boolean {
  try {
    return readVaultConnection(readMarker(workspace))?.features.includes('needs-you') === true;
  } catch {
    return false;
  }
}

/**
 * KEEP THE PAGE CURRENT (kickoffs/s161 row 6; the contract's "When it is written"): write it when the Library has a vault
 * connection with `needs-you` on, and say nothing when it is unchanged. A failure prints one line to standard error naming
 * the page and the reason, and never throws: the command or hook that called it answers as it would have.
 */
export function refreshNeedsYou(workspace: string): void {
  if (!needsYouOn(workspace)) return;
  try {
    const done = writeNeedsYou(workspace);
    if (done.status === 'refused') process.stderr.write(`Deskpost did not refresh the page ${done.path}: ${done.reason}.\n`);
  } catch (error) {
    process.stderr.write(`Deskpost did not refresh the page Librarian/${NEEDS_YOU_PAGE}: ${String((error as Error).message ?? error).split(/\r?\n/)[0]}\n`);
  }
}

/**
 * THE VERBS THAT CAN CHANGE A SECTION (kickoffs/s161 row 6): a Kickoff pointer or a Hub item (`hub`, `kickoff`), a letter
 * (`letters`, `capture`, `postbox`), a Report (`capture`, `reports`, `triage`), a stopped save (`checkpoint`), a seat's
 * name, nickname or Hub (`seat`). Never `hook` (the checkpoint hook refreshes on its own state change), `mcp`, `menu`,
 * `dashboard`, `vault` (connecting writes nothing in the vault) or a read.
 */
const REFRESH_VERBS = new Set(['hub', 'letters', 'capture', 'reports', 'triage', 'kickoff', 'checkpoint', 'seat', 'postbox', 'undo', 'redo']);
const READ_ACTIONS = new Set(['list', 'status', 'resolve', 'show']);

/** After a `deskpost` command that exited 0: refresh the page when the command can have changed it. */
export function refreshAfterCommand(argv: string[]): void {
  let args = argv;
  if (args[0] === '--workspace') args = [...args.slice(2), '--workspace', args[1] ?? ''];
  const [verb, action] = args;
  if (verb === undefined || !REFRESH_VERBS.has(verb) || READ_ACTIONS.has(action ?? '') || (verb === 'undo' && args.includes('--list'))) return;
  if (args.some((item) => ['--preflight', '--help', '-h', '--dry-run'].includes(item))) return;
  let workspace: string;
  try {
    const at = args.indexOf('--workspace');
    workspace = requireWorkspace(at >= 0 && args[at + 1] ? { explicit: args[at + 1] } : {});
  } catch {
    return;
  }
  refreshNeedsYou(workspace);
}
