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
 *
 * `--hang` accepts every connection and answers none, which is what a black-holed host looks like to a client.
 * The port it listens on is written to <port-file> once it is listening.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const [folder, portFile, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1]! : fallback;
};
const hang = rest.includes('--hang');
const projectName = option('project', 'stand-in-collection');
const projectId = option('id', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa');
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
  const directory = String(args['directory'] ?? '').replace(/^\/+|\/+$/g, '');
  const title = String(args['title'] ?? '');
  const relative = `${directory ? directory + '/' : ''}${title}.md`;
  const fault = String((args['metadata'] as Record<string, unknown> | undefined)?.['stand_in_fault'] ?? '');
  const form = /^(refuse-(rpc-error|is-error|error-field|conflict|edit-failed|error-heading)|drop-(landed|lost))-/.exec(fault === 'drop-landed' ? 'drop-landed-' : title);
  const file = path.join(root, ...relative.split('/'));
  const record = () => fs.appendFileSync(path.join(folder!, '.writes.log'), `${String(args['project_id'])}|${relative}\n`);
  if (form?.[2] !== undefined) {
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
  if (fault === 'conflict-landed') return text({ file_path: relative, action: 'conflict', error: 'NOTE_ALREADY_EXISTS' });
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
    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-basic-memory', version: '0' } };
      response.setHeader('Mcp-Session-Id', 'fake-session');
    } else if (method === 'tools/call') {
      const params = (message['params'] ?? {}) as Record<string, unknown>;
      result = call(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>);
      if (result === DROPPED) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Session not found');
        return;
      }
      const rpcError = (result as Record<string, unknown> | null)?.['rpcError'];
      if (typeof rpcError === 'string') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: rpcError } }));
        return;
      }
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(portFile!, String(typeof address === 'object' && address !== null ? address.port : 0));
});
