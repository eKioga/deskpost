/**
 * A stand-in Basic Memory server for the kernel self-test (PLAN-basic-memory.md steps 2, 3 and 5).
 *
 * A CHILD PROCESS, NEVER IN THE SUITE'S OWN: every behavioural case runs the CLI through `spawnSync`, which blocks
 * the suite's event loop, so a server listening in-process could never answer the call being judged.
 *
 * IT SERVES A FOLDER ON DISK AS ONE COLLECTION -- the same folder a connection names as its storage folder -- over
 * the streamable-HTTP MCP the kernel speaks: `initialize` with a session header, `notifications/initialized`,
 * and these tools: `list_memory_projects`, `read_note` (an absent note is `isError: false` with a null path and
 * content, as the real server answers it, measured S33), `write_note`, `create_memory_project`, `list_directory`
 * (the files and folders directly in one folder, each file with its `permalink`, `external_id` and `updated_at`,
 * `{total, nodes, has_more: false}`), `read_content` and `move_note` (kickoffs/s121 rows 7 and 9; kickoffs/s123 row 1).
 *
 * A NOTE AS THE REAL SERVER KEEPS IT (B's Stage 0 probes S5-S7, 2026-10-15; kickoffs/s123 row 1). Every `write_note`
 * leaves a file with the server's frontmatter (`storedNote`), and every note has a PERMALINK, kept in that frontmatter:
 * a `move_note` leaves it unchanged, so `read_note` on a moved note's old path answers with the moved note, even after
 * a new file is written there (that write gets the permalink with `-1` added). `read_note` finds a note by permalink
 * first and by file path second. A file a test lays down by hand, with no permalink line, is found by its path.
 * `read_content` IS NOT EXACT EITHER (B's probe of the real server, 2026-10-17, findings 3-6,
 * `projects/deskpost-desk/notes/2026-10-17-postbox-probes`; kickoffs/s131 row 2): it follows a permalink first, so a
 * moved note's old path answers the moved note even once a new file is there (4); a path with no file, in a folder that
 * holds notes, answers another note from that folder, here the first by name (3); only a folder with none answers "not
 * found". A permalink, with or without the project's name in front, answers its note (4). Only `list_directory` reports
 * the files actually at each path (6). `move_note` of a note already in the destination folder answers
 * `DESTINATION_SAME_AS_SOURCE` (5).
 *
 * WRITES, AS v0.23.2 ANSWERS THEM (B's Stage 0 probes, 2026-10-15): `write_note` with `overwrite: false` on an existing
 * note is `isError: false` with `action: "conflict"` and `error: "NOTE_ALREADY_EXISTS"`; otherwise the file is written
 * under the folder and `action: "created"` or `"updated"` comes back. Every write appends `<project>|<path>` to
 * `<folder>/.writes.log` (a move, `<project>|move <from> -> <to>`), so a test can count how often one was sent. A note
 * TITLE beginning `refuse-<form>-` answers that refusal instead of writing: `rpc-error`, `is-error`, `error-field`,
 * `conflict`, `edit-failed` (text `# Edit Failed - Text Not Found`), `error-heading` (text `# Error: Note already
 * exists`); `drop-landed-` writes the note and then answers HTTP 404 "Session not found", as a server restarted mid-call
 * would, and `drop-lost-` answers it without writing. A delivery id names its own file, so a Postbox letter carries its
 * cue as `metadata.stand_in_fault` instead: `drop-landed` as the title cue, and `conflict-landed`, which writes the note
 * and answers `action: "conflict"`, as a send that lost a race with another one sees it (kickoffs/s123 row 2).
 * `create_memory_project` answers `{created, already_exists, external_id}` and lists the project after. Projects live
 * in this process only.
 *
 *   node fake-basic-memory.ts <folder> <port-file> [--project <name>] [--id <uuid>] [--hang]
 *                             [--surface legacy|bm] [--drop-tool <name>] [--tools-list error|empty] [--call-log]
 *                             [--vanish <text>]
 *
 * `--hang` accepts every connection and answers none, which is what a black-holed host looks like to a client.
 * The port it listens on is written to <port-file> once it is listening.
 *
 * TWO SURFACES (kickoffs/s175 rows 1 and 3). `--surface legacy` answers as above, by the old names, and lists them from
 * `tools/list`. `--surface bm`, the default since row 3, answers as Basic Memory 1.0.0 does (the NAS since 2026-10-30; Shelf Book `basic-memory`
 * page `basic-memory/mcp-tool-surface`, its live lines of 2026-10-31, and the v1.0.0 source): `tools/list` offers the
 * twelve `bm_*` names and an old name is `Unknown tool`; every project-scoped call needs `project` (its name or UUID;
 * `project_id` is accepted as an alias, as 1.0's `tool_params.py` accepts it), and a call with neither is an
 * `isError: true` validation error naming `project`, with no typed code; a refusal is `isError: true` whose text is
 * `{"error": <code>, "message"}` with `output_format: "json"`; a `tools/call` answer is an event stream whose first frame
 * is a `notifications/message`, the result after it; `bm_list` is paged (`page`, `page_size` 1 to 100, default 10,
 * `has_more`), folders first, a file's `permalink` with the project's name in front, and a missing folder lists empty;
 * `bm_read` of a missing note is `NOT_FOUND`; `bm_write` over an existing note without `overwrite` is `ALREADY_EXISTS`;
 * `bm_move` to the note's own path is `INVALID_ARGUMENTS` "The note is already at '<path>'." Two more title cues:
 * `refuse-outcome-unknown-` writes the note and answers `OUTCOME_UNKNOWN`, `refuse-revision-conflict-` answers
 * `REVISION_CONFLICT` and writes nothing. A permalink with the project's name in front is found only when `project` is
 * the NAME (1.0 does not strip it for a UUID). UNMEASURED ON 1.0 (kickoffs/s175 STANDING ANSWER 8), kept as v0.23.2
 * measured it: a moved note's permalink stays, a read follows a permalink before a path, and `metadata` values are
 * quoted as v0.23.2 quoted them. `bm_edit`, `bm_delete`, `bm_find`, `bm_search`, `bm_context`, `bm_schema` and `bm_man`
 * are listed and answer `UNSUPPORTED`.
 *
 * `--drop-tool <name>` leaves one tool out of `tools/list` and answers it `Unknown tool`; `--tools-list error` answers
 * `tools/list` with an error and `--tools-list empty` with a result that has no `tools`. With `--call-log`, on both
 * surfaces, every request is logged to `<folder>/.calls.log` (only when asked: section 43 hashes and imports the folder),
 * one JSON line each: `method`, `tool` for a `tools/call`, the argument NAMES (never
 * their values), for `bm_list` its `path`, and `project_by` (`name` or `id`: how the project was named, not the value).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { listenFetchable } from './fetchable-port.ts';

const [folder, portFile, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1]! : fallback;
};
const hang = rest.includes('--hang');
const projectName = option('project', 'stand-in-collection');
const projectId = option('id', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa');
// 1.0 BY DEFAULT since kickoffs/s175 row 3, as the NAS is; `--surface legacy` for a section judging the old tools.
const surface = option('surface', 'bm') === 'legacy' ? 'legacy' : 'bm';
// `--vanish <text>`: a `bm_read` whose identifier holds it answers NOT_FOUND, as a file gone between a listing and its read.
const vanish = option('vanish', '');
const droppedTool = option('drop-tool', '');
const toolsList = option('tools-list', '');
// THE CALL LOG ONLY WHEN ASKED: a folder some sections hash and import from must hold no file the fake made unasked.
const callLog = rest.includes('--call-log');
const LEGACY_TOOLS = ['list_memory_projects', 'read_note', 'write_note', 'create_memory_project', 'list_directory', 'read_content', 'move_note'];
const BM_TOOLS = ['bm_read', 'bm_write', 'bm_edit', 'bm_move', 'bm_delete', 'bm_list', 'bm_find', 'bm_search', 'bm_context', 'bm_project', 'bm_schema', 'bm_man'];
/** Projects made by `create_memory_project`, by name: their id and their own folder under `<folder>/.projects/`. */
const created = new Map<string, { id: string; path: string }>();
let createdCount = 0;

function projectFolder(id: string): string | null {
  if (id === projectId) return folder!;
  for (const [name, project] of created) if (project.id === id) return path.join(folder!, '.projects', name);
  return null;
}

function projectNameOf(id: string): string | null {
  if (id === projectId) return projectName;
  for (const [name, project] of created) if (project.id === id) return name;
  return null;
}

/** What `call` answers when the session is to look dropped: the HTTP layer turns it into a 404. */
const DROPPED = Symbol('dropped');

function textOnly(body: string): unknown {
  return { content: [{ type: 'text', text: body }], isError: false };
}

/**
 * A plain string as the server's YAML writes it (B's probe S7): single-quoted, with `'` doubled, when a plain scalar
 * would read as something else (a timestamp, a number, a boolean or null) or holds `: `, ` #` or a leading indicator;
 * otherwise as it stands.
 */
function yamlString(value: string): string {
  const plainIsNotAString = /^(?:\d{4}-\d\d-\d\d(?:[Tt ].*)?|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|true|false|yes|no|on|off|null|~)$/i.test(value);
  const needsQuotes = value === '' || plainIsNotAString || /: | #|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$/.test(value);
  return needsQuotes ? `'${value.replace(/'/g, "''")}'` : value;
}

/**
 * THE FILE A `write_note` LEAVES, as B's probes measured the real server (S5, S7; kickoffs/s122 row 3, s123 row 1):
 * `metadata` values become frontmatter keys, quoted as YAML quotes them; the server adds `title`, `type` (from
 * `note_type`), `permalink` and `tags`; a body that opens with its own `---` block has that block merged into the
 * frontmatter, its `title` replaced by the note's, a timestamp turned into YAML's form and the body's trailing newline
 * dropped (S5); any other body is kept with its trailing newline (S7 point 5), after one blank line, so `read_note`
 * without the frontmatter answers it with one leading newline (S5).
 * UNPROBED (kickoffs/s123 STANDING ANSWER 8): the key order (title, type, permalink, then the body's block, then
 * `metadata`, then `tags`), `tags: []` for no tags, a body's own leading blank lines dropped, and the one blank line
 * after the frontmatter.
 */
function storedNote(args: Record<string, unknown>, title: string, permalink: string): string {
  const sent = String(args['content'] ?? '');
  const metadata = args['metadata'];
  const hasMetadata = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
  let body = sent.replace(/\r\n/g, '\n');
  const keys = new Map<string, string>();
  keys.set('title', yamlString(title));
  keys.set('type', String(args['note_type'] ?? 'note'));
  keys.set('permalink', permalink);
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (block) {
    body = body.slice(block[0].length);
    for (const line of block[1]!.split('\n')) {
      const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
      if (!pair || pair[1] === 'title' || pair[1] === 'permalink') continue;
      const stamp = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)Z$/.exec(pair[2]!);
      keys.set(pair[1]!, stamp ? `${stamp[1]} ${stamp[2]}+00:00` : pair[2]!);
    }
    body = body.replace(/\n$/, '');
  }
  if (hasMetadata) {
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) keys.set(key, yamlString(String(value)));
  }
  if (!keys.has('tags')) keys.set('tags', '[]');
  body = body.replace(/^\n+/, '');
  return `---\n${[...keys].map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${body}`;
}

/** Every `*.md` file under a project folder, by its path relative to that folder (`/` separators). */
function allNotes(root: string, under = ''): string[] {
  const full = path.join(root, ...under.split('/').filter(Boolean));
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
  const found: string[] = [];
  for (const name of fs.readdirSync(full).sort()) {
    if (name.startsWith('.')) continue;
    const relative = under ? `${under}/${name}` : name;
    const stat = fs.statSync(path.join(full, name));
    if (stat.isDirectory()) found.push(...allNotes(root, relative));
    else if (name.endsWith('.md')) found.push(relative);
  }
  return found;
}

/** A note's permalink, from its own frontmatter, or null for a file laid down with none. */
function permalinkOf(root: string, relative: string): string | null {
  const content = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  const line = front ? /^permalink:[ \t]*(.*?)[ \t]*$/m.exec(front[1]!) : null;
  return line ? line[1]! : null;
}

function permalinkFor(directory: string, title: string): string {
  return `${directory ? directory + '/' : ''}${title}`.toLowerCase().replace(/[^a-z0-9/]+/g, '-');
}

/**
 * WHICH FILE AN IDENTIFIER NAMES, as `read_note` and `move_note` resolve it (probe S6): the note whose permalink it is,
 * else the file at that path; with or without `.md`, the permalink compared in lower case.
 * UNPROBED for `move_note` (its resolution was not measured; it is assumed to be `read_note`'s).
 */
function resolveNote(root: string, identifier: string): string | null {
  const bare = identifier.replace(/^\/+/, '').replace(/\.md$/i, '');
  const wanted = bare.toLowerCase();
  const byLink = allNotes(root).find((relative) => permalinkOf(root, relative) === wanted);
  if (byLink !== undefined) return byLink;
  const file = path.join(root, ...`${bare}.md`.split('/'));
  return file.startsWith(path.resolve(root)) && fs.existsSync(file) && fs.statSync(file).isFile() ? `${bare}.md` : null;
}

function writeNote(args: Record<string, unknown>): unknown {
  const root = projectFolder(String(args['project_id'] ?? ''));
  if (root === null) return { content: [{ type: 'text', text: `Project '${String(args['project_id'])}' not found.` }], isError: true };
  return writeAt(root, String(args['project_id']), args, false);
}

/** A 1.0 refusal: `isError: true`, its text the JSON form with `output_format: "json"`, else `<CODE>: <message>`. */
function refusal(code: string, message: string, args: Record<string, unknown>): unknown {
  const said = args['output_format'] === 'json' ? JSON.stringify({ error: code, message }) : `${code}: ${message}`;
  return { content: [{ type: 'text', text: said }], isError: true };
}

/** One write into a project folder, answered as v0.23.2 (`bm` false) or as 1.0 (`bm` true) answers it. */
function writeAt(root: string, key: string, args: Record<string, unknown>, bm: boolean): unknown {
  const directory = String(args['directory'] ?? '').replace(/^\/+|\/+$/g, '');
  const title = String(args['title'] ?? '');
  const relative = `${directory ? directory + '/' : ''}${title}.md`;
  const fault = String((args['metadata'] as Record<string, unknown> | undefined)?.['stand_in_fault'] ?? '');
  const form = /^(refuse-(rpc-error|is-error|error-field|conflict|edit-failed|error-heading|outcome-unknown|revision-conflict)|drop-(landed|lost))-/.exec(fault === 'drop-landed' ? 'drop-landed-' : title);
  const file = path.join(root, ...relative.split('/'));
  const record = () => fs.appendFileSync(path.join(folder!, '.writes.log'), `${key}|${relative}\n`);
  const outcomeUnknown = form?.[2] === 'outcome-unknown';
  if (form?.[2] === 'revision-conflict') {
    record();
    return refusal('REVISION_CONFLICT', `'${relative}' changed since you read it (current checksum 0). Nothing was replaced.`, args);
  }
  if (form?.[2] !== undefined && !outcomeUnknown) {
    record();
    switch (form[2]) {
      case 'rpc-error': return { rpcError: 'Internal error: the stand-in refused this write' };
      case 'is-error': return { content: [{ type: 'text', text: 'The stand-in refused this write.' }], isError: true };
      case 'error-field': return text({ file_path: relative, error: 'Text to replace not found: needle' });
      case 'conflict': return text({ file_path: relative, action: 'conflict' });
      case 'edit-failed': return textOnly('# Edit Failed - Text Not Found\n\nThe text to replace was not found.');
      default: return textOnly('# Error: Note already exists\n\nUse overwrite to replace it.');
    }
  }
  const exists = fs.existsSync(file);
  if (exists && args['overwrite'] !== true && form?.[3] === undefined) {
    record();
    if (bm) return refusal('ALREADY_EXISTS', `A note already exists at '${relative}'. Nothing was written.`, args);
    return text({ file_path: relative, action: 'conflict', error: 'NOTE_ALREADY_EXISTS' });
  }
  record();
  if (form?.[3] === 'lost') return DROPPED;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A NEW NOTE'S PERMALINK IS ITS PATH, unless another note holds it (a note moved away keeps it, S6): then `-1`, `-2`.
  const base = permalinkFor(directory, title);
  const taken = new Set(allNotes(root).filter((other) => other !== relative).map((other) => permalinkOf(root, other)));
  let permalink = exists ? (permalinkOf(root, relative) ?? base) : base;
  for (let n = 1; !exists && taken.has(permalink); n += 1) permalink = `${base}-${n}`;
  fs.writeFileSync(file, storedNote(args, title, permalink));
  if (form?.[3] === 'landed') return DROPPED;
  if (fault === 'conflict-landed') {
    if (bm) return refusal('ALREADY_EXISTS', `A note already exists at '${relative}'. Nothing was written.`, args);
    return text({ file_path: relative, action: 'conflict', error: 'NOTE_ALREADY_EXISTS' });
  }
  if (outcomeUnknown) return refusal('OUTCOME_UNKNOWN', `The write of '${relative}' may or may not have happened: the stand-in was told to say so.`, args);
  const checksum = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (bm) return text({ action: exists ? 'updated' : 'created', file_path: relative, permalink, checksum, title });
  return text({ file_path: relative, title, action: exists ? 'updated' : 'created', checksum: String(fs.statSync(file).size) });
}

function text(result: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result }, isError: false };
}

function readNote(root: string, identifier: string, includeFrontmatter: boolean): unknown {
  const relative = resolveNote(root, identifier);
  if (relative === null) return { file_path: null, title: null, content: null };
  let content = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
  if (!includeFrontmatter) content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return { file_path: relative, title: path.basename(relative, '.md'), content };
}

/**
 * `read_content`, AS THE REAL SERVER ANSWERS IT (probe of 2026-10-17, findings 2-4): the note whose permalink the path
 * names (with or without `.md`, or the project's name in front) first; else the file at the path; else, when the path's
 * folder holds notes, the first of them by name, `isError: false`; else `{type: "error", error: "Resource not found:
 * <path>"}`. The answer is `{type: "text", text, content_type, encoding}`, `text` the whole file (finding 2).
 */
function readContent(root: string, project: string | null, requested: string): unknown {
  let bare = requested.replace(/^\/+/, '');
  if (project !== null && bare.startsWith(`${project}/`)) bare = bare.slice(project.length + 1);
  const answer = (relative: string) =>
    text({ type: 'text', text: fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'), content_type: 'text/markdown; charset=utf-8', encoding: 'utf-8' });
  const wanted = bare.replace(/\.md$/i, '').toLowerCase();
  const byLink = allNotes(root).find((relative) => permalinkOf(root, relative) === wanted);
  if (byLink !== undefined) return answer(byLink);
  const relative = /\.md$/i.test(bare) ? bare : `${bare}.md`;
  const file = path.join(root, ...relative.split('/'));
  if (file.startsWith(path.resolve(root)) && fs.existsSync(file) && fs.statSync(file).isFile()) return answer(relative);
  const directory = path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);
  const beside = allNotes(root, directory).filter((other) => !other.slice(directory ? directory.length + 1 : 0).includes('/'));
  if (beside.length) return answer(beside[0]!);
  return text({ type: 'error', error: `Resource not found: ${bare}` });
}

/** A file node's `external_id`: a UUID-shaped digest of its permalink, so it stays the same across a move. */
function externalIdOf(permalink: string): string {
  const hex = createHash('sha256').update(permalink).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `move_note` with `destination_folder` (probe S6): the file moves, its permalink does not, and the answer is
 * `{moved: true, file_path}`. UNPROBED: a destination that already holds a file of that name is refused with
 * `{moved: false, error}` and nothing changes (the safer reading).
 */
function moveNote(root: string, args: Record<string, unknown>): unknown {
  const from = resolveNote(root, String(args['identifier'] ?? ''));
  if (from === null) return text({ moved: false, error: `Note not found: ${String(args['identifier'] ?? '')}` });
  const folderName = String(args['destination_folder'] ?? '').replace(/^\/+|\/+$/g, '');
  const to = `${folderName ? folderName + '/' : ''}${path.basename(from)}`;
  const target = path.join(root, ...to.split('/'));
  fs.appendFileSync(path.join(folder!, '.writes.log'), `${String(args['project_id'])}|move ${from} -> ${to}\n`);
  // Finding 5 (probe of 2026-10-17): an identifier that resolves to a note already in the destination folder.
  if (path.posix.dirname(from) === (folderName || '.')) return text({ moved: false, error: 'DESTINATION_SAME_AS_SOURCE' });
  if (fs.existsSync(target)) return text({ moved: false, error: `Destination already exists: ${to}` });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(root, ...from.split('/')), target);
  return text({ moved: true, file_path: to, title: path.basename(to, '.md') });
}

// --- the 1.0 surface (kickoffs/s175 row 1(f)) ----------------------------------------------------------------------

/** The project a 1.0 call names, by its name or its UUID, or null. */
function projectOf(value: string): { root: string; name: string; id: string } | null {
  if (value === projectName || value === projectId) return { root: folder!, name: projectName, id: projectId };
  for (const [name, project] of created) if (value === name || value === project.id) return { root: path.join(folder!, '.projects', name), name, id: project.id };
  return null;
}

/** 1.0 refuses a call with no `project` before the tool runs: Pydantic's validation error, no typed code. */
function missingProject(name: string): unknown {
  const said = `1 validation error for call[${name}]\nproject\n  Missing required keyword only argument [type=missing_keyword_only_argument, input_value=ArgsKwargs(()), input_type=ArgsKwargs]`;
  return { content: [{ type: 'text', text: said }], isError: true };
}

/**
 * An identifier as 1.0 resolves it in a project: a leading slash dropped, and the project's name in front stripped only
 * when the project was named by NAME (1.0's `project_context.py`; a UUID leaves a `<project>/...` permalink unfound).
 */
function bareIdentifier(project: { name: string }, addressedBy: string, identifier: string): string {
  const bare = identifier.replace(/^\/+/, '');
  return addressedBy === project.name && bare.startsWith(`${project.name}/`) ? bare.slice(project.name.length + 1) : bare;
}

function bmRead(project: { root: string; name: string }, addressedBy: string, args: Record<string, unknown>): unknown {
  const identifier = String(args['identifier'] ?? '');
  const relative = vanish && identifier.includes(vanish) ? null : resolveNote(project.root, bareIdentifier(project, addressedBy, identifier));
  if (relative === null) return refusal('NOT_FOUND', `Note '${identifier}' not found.`, args);
  const file = path.join(project.root, ...relative.split('/'));
  const whole = fs.readFileSync(file, 'utf8');
  const permalink = permalinkOf(project.root, relative) ?? relative.replace(/\.md$/, '').toLowerCase();
  const head = { title: path.basename(relative, '.md'), permalink, file_path: relative, checksum: createHash('sha256').update(whole).digest('hex') };
  if (args['include_content'] === false) return text({ ...head, updated_at: fs.statSync(file).mtime.toISOString() });
  const content = args['include_frontmatter'] === false ? whole.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') : whole;
  return text({ ...head, content, frontmatter: null });
}

function bmMove(project: { root: string; name: string; id: string }, addressedBy: string, args: Record<string, unknown>): unknown {
  const identifier = String(args['identifier'] ?? '');
  const from = resolveNote(project.root, bareIdentifier(project, addressedBy, identifier));
  if (from === null) return refusal('NOT_FOUND', `Note '${identifier}' not found.`, args);
  const destination = String(args['destination'] ?? args['destination_folder'] ?? '');
  const into = destination.replace(/^\/+/, '');
  const to = into === '' || into.endsWith('/') ? `${into}${path.posix.basename(from)}` : into;
  if (!to.endsWith('.md')) return refusal('INVALID_ARGUMENTS', `A note destination needs its extension: '${destination}'.`, args);
  fs.appendFileSync(path.join(folder!, '.writes.log'), `${project.id}|move ${from} -> ${to}\n`);
  if (to === from) return refusal('INVALID_ARGUMENTS', `The note is already at '${from}'.`, args);
  const target = path.join(project.root, ...to.split('/'));
  if (fs.existsSync(target)) return refusal('ALREADY_EXISTS', `A note already exists at '${to}'. Nothing was moved.`, args);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(project.root, ...from.split('/')), target);
  return text({ action: 'moved', file_path: to, previous_file_path: from, permalink: permalinkOf(project.root, to), title: path.basename(to, '.md') });
}

/** `bm_list`: one level, folders first, paged; a missing folder lists empty (the NAS, 2026-10-31). */
function bmList(project: { root: string; name: string }, args: Record<string, unknown>): unknown {
  const page = Number(args['page'] ?? 1);
  const pageSize = Number(args['page_size'] ?? 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { content: [{ type: 'text', text: `1 validation error for call[bm_list]\npage_size\n  Input should be between 1 and 100 [input_value=${pageSize}]` }], isError: true };
  }
  const directory = String(args['path'] ?? '/').replace(/^\/+|\/+$/g, '');
  const full = path.join(project.root, ...directory.split('/').filter(Boolean));
  const names = fs.existsSync(full) && fs.statSync(full).isDirectory() ? fs.readdirSync(full).filter((name) => !name.startsWith('.')).sort() : [];
  const inside = (name: string) => `${directory ? directory + '/' : ''}${name}`;
  const folders = names.filter((name) => fs.statSync(path.join(full, name)).isDirectory())
    .map((name) => ({ type: 'directory', name, title: name, directory_path: `/${inside(name)}`, file_path: null }));
  const files = names.filter((name) => name.endsWith('.md') && fs.statSync(path.join(full, name)).isFile()).map((name) => {
    const relative = inside(name);
    const permalink = permalinkOf(project.root, relative) ?? relative.replace(/\.md$/, '').toLowerCase();
    return {
      type: 'file', name, title: path.basename(name, '.md'), file_path: relative, permalink: `${project.name}/${permalink}`, external_id: externalIdOf(permalink),
      entity_id: externalIdOf(relative), note_type: 'note', content_type: 'text/markdown', updated_at: fs.statSync(path.join(full, name)).mtime.toISOString().replace('Z', '000Z'),
    };
  });
  const nodes = [...folders, ...files];
  return text({ nodes: nodes.slice((page - 1) * pageSize, page * pageSize), page, page_size: pageSize, total: nodes.length, has_more: page * pageSize < nodes.length });
}

function bmProject(args: Record<string, unknown>): unknown {
  const command = String(args['command'] ?? '');
  if (command === 'list') return call('list_memory_projects', {});
  if (command !== 'create') return refusal('UNSUPPORTED', `The stand-in does not model bm_project command '${command}'.`, args);
  const name = String(args['name'] ?? args['project_name'] ?? '');
  const where = args['path'] ?? args['project_path'];
  if (!name || where === undefined) return refusal('INVALID_ARGUMENTS', 'create needs `name` and `path`.', args);
  const answer = call('create_memory_project', { project_name: name, project_path: where }) as { structuredContent?: { result?: Record<string, unknown> } };
  const made = answer.structuredContent?.result;
  if (made === undefined) return refusal('INVALID_ARGUMENTS', `Invalid project name '${name}'.`, args);
  return text({ name, external_id: made['external_id'], path: String(where), created: made['created'], already_exists: made['already_exists'] });
}

function callBm(name: string, args: Record<string, unknown>): unknown {
  if (!BM_TOOLS.includes(name)) return { content: [{ type: 'text', text: `Unknown tool: '${name}'` }], isError: true };
  if (name === 'bm_project') return bmProject(args);
  if (name === 'bm_man') return refusal('UNSUPPORTED', 'The stand-in carries no manual pages.', args);
  const addressedBy = String(args['project'] ?? args['project_id'] ?? '');
  if (!addressedBy) return missingProject(name);
  const project = projectOf(addressedBy);
  if (project === null) return refusal('NOT_FOUND', `Project '${addressedBy}' not found.`, args);
  switch (name) {
    case 'bm_read': return bmRead(project, addressedBy, args);
    case 'bm_write': return writeAt(project.root, project.id, args, true);
    case 'bm_move': return bmMove(project, addressedBy, args);
    case 'bm_list': return bmList(project, args);
    default: return refusal('UNSUPPORTED', `The stand-in does not model ${name}.`, args);
  }
}

function call(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_memory_projects':
      return text({ projects: [{ name: projectName, external_id: projectId, path: `/${projectName}` }, { name: 'main', external_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', path: '/main' },
        ...[...created].map(([name, project]) => ({ name, external_id: project.id, path: project.path }))], default_project: 'main' });
    case 'write_note':
      return writeNote(args);
    case 'list_directory': {
      const root = projectFolder(String(args['project_id'] ?? ''));
      if (root === null) return { content: [{ type: 'text', text: `Project '${String(args['project_id'])}' not found.` }], isError: true };
      const directory = String(args['dir_name'] ?? '').replace(/^\/+|\/+$/g, '');
      const full = path.join(root, ...directory.split('/'));
      const names = fs.existsSync(full) && fs.statSync(full).isDirectory() ? fs.readdirSync(full).filter((name) => !name.startsWith('.')).sort() : [];
      // Each file with the server's own `updated_at` (probe S3: UTC, to the microsecond), its `permalink` and
      // `external_id` (finding 6; a file laid down with no permalink line gets its path's); a folder with `null`s.
      type Node = { type: string; name: string; file_path: string; permalink: string | null; external_id: string | null; updated_at: string | null };
      const nodes = names.flatMap((name): Node[] => {
        const stat = fs.statSync(path.join(full, name));
        if (stat.isDirectory()) return [{ type: 'directory', name, file_path: `${directory}/${name}`, permalink: null, external_id: null, updated_at: null }];
        if (!name.endsWith('.md')) return [];
        const relative = `${directory ? directory + '/' : ''}${name}`;
        const permalink = permalinkOf(root, relative) ?? relative.replace(/\.md$/, '').toLowerCase();
        return [{ type: 'file', name, file_path: `${directory}/${name}`, permalink, external_id: externalIdOf(permalink), updated_at: stat.mtime.toISOString().replace('Z', '000Z') }];
      });
      return text({ total: nodes.length, nodes, has_more: false });
    }
    case 'create_memory_project': {
      const name = String(args['project_name'] ?? '');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { content: [{ type: 'text', text: `Invalid project name '${name}'.` }], isError: true };
      const already = name === projectName ? { id: projectId, path: `/${projectName}` } : created.get(name);
      if (already) return text({ created: false, already_exists: true, external_id: already.id, name });
      createdCount += 1;
      const id = `cccccccc-${String(createdCount).padStart(4, '0')}-4ccc-8ccc-cccccccccccc`;
      created.set(name, { id, path: String(args['project_path'] ?? `/${name}`) });
      fs.mkdirSync(path.join(folder!, '.projects', name), { recursive: true });
      fs.appendFileSync(path.join(folder!, '.writes.log'), `create_memory_project|${name}\n`);
      return text({ created: true, already_exists: false, external_id: id, name });
    }
    case 'read_content':
    case 'move_note': {
      const root = projectFolder(String(args['project_id'] ?? ''));
      if (root === null) return { content: [{ type: 'text', text: `Project '${String(args['project_id'])}' not found.` }], isError: true };
      return name === 'read_content' ? readContent(root, projectNameOf(String(args['project_id'] ?? '')), String(args['path'] ?? '')) : moveNote(root, args);
    }
    case 'read_note': {
      const root = projectFolder(String(args['project_id'] ?? ''));
      if (root === null) return { content: [{ type: 'text', text: `Project '${String(args['project_id'])}' not found.` }], isError: true };
      return text(readNote(root, String(args['identifier'] ?? ''), args['include_frontmatter'] !== false));
    }
    default:
      return { content: [{ type: 'text', text: `The stand-in has no tool '${name}'.` }], isError: true };
  }
}

const server = http.createServer((request, response) => {
  if (hang) return; // never answered; the client's timeout is the only way out
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    let message: Record<string, unknown> = {};
    try {
      message = JSON.parse(body) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end('not JSON');
      return;
    }
    const id = message['id'];
    const method = String(message['method'] ?? '');
    // THE CALL LOG (kickoffs/s175 row 1(f)): every request, its tool and argument NAMES, never their values (but `bm_list`'s path).
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    const logged: Record<string, unknown> = { method };
    if (method === 'tools/call') {
      logged['tool'] = String(params['name'] ?? '');
      logged['args'] = Object.keys(args).sort();
      if (logged['tool'] === 'bm_list') logged['path'] = String(args['path'] ?? '/');
      // Whether the project was named by its name or its UUID: a kind, not the value (kickoffs/s175 row 1's file_path reads).
      const named = String(args['project'] ?? args['project_id'] ?? '');
      if (named) logged['project_by'] = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(named) ? 'id' : 'name';
    }
    if (callLog) fs.appendFileSync(path.join(folder!, '.calls.log'), JSON.stringify(logged) + '\n');
    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-basic-memory', version: '0' } };
      response.setHeader('Mcp-Session-Id', 'fake-session');
    } else if (method === 'tools/list') {
      if (toolsList === 'error') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The stand-in was told to refuse tools/list' } }));
        return;
      }
      const offered = (surface === 'bm' ? BM_TOOLS : LEGACY_TOOLS).filter((name) => name !== droppedTool);
      result = toolsList === 'empty' ? {} : { tools: offered.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    } else if (method === 'tools/call') {
      const name = String(params['name'] ?? '');
      result = name === droppedTool
        ? { content: [{ type: 'text', text: `Unknown tool: '${name}'` }], isError: true }
        : surface === 'bm' ? callBm(name, args) : call(name, args);
      if (result === DROPPED) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Session not found');
        return;
      }
      const rpcError = (result as Record<string, unknown> | null)?.['rpcError'];
      if (typeof rpcError === 'string') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: rpcError } }));
        return;
      }
      if (surface === 'bm') {
        // 1.0 ON STREAMABLE HTTP (the NAS, 2026-10-31): a log message first, then the answer whose `id` is the request's.
        const log = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `stand-in: ${name}` } };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          .end(`event: message\ndata: ${JSON.stringify(log)}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
        return;
      }
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

fs.writeFileSync(portFile!, String(await listenFetchable(server)));
