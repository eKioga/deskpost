/**
 * `library basic-memory`: a local Library's CONNECTION to a Basic Memory server (PLAN-basic-memory.md steps 2, 3
 * and 5; ADR-0050). It replaces `tools/Initialize-CodexLibrary.ps1` for a local Library.
 *
 * LOCAL ALWAYS; BASIC MEMORY IS A CONNECTION (ruling B1). A local Library keeps every Book and Hub in its own
 * `collection/`; a connection only lets it READ the shared collection -- open a shared Book, compare, import
 * from the server's storage folder. Nothing is written to Basic Memory in 1.1, so nothing here writes to it.
 *
 * THE CONNECTION LIVES IN THE MARKER, AND ONLY THERE (Fable #1, blocking). `connections.basic_memory: { url,
 * collection_id, collection_name, storage }`. Set-up never writes `.claude/.library-mcp-url`, `.library-project`
 * or `.library-shared-root`: those three are what `init` reads to decide a workspace's BACKEND and what the
 * fence reads to decide who writes, so writing them turned the next `init` into a silent conversion to
 * `backend: basic-memory`.
 *
 * EVERY VALUE IS CHECKED LIVE BEFORE IT IS SAVED. The URL must answer MCP `initialize` within the timeout; the
 * collection is CHOSEN FROM THE SERVER'S OWN LIST and stored as its UUID, because a Desk pin and every exact read
 * need one; the storage folder, when one is given, must be a collection root (both catalogs). A value that fails
 * is named with its reason and nothing is saved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { writeAtomicText } from './fsx.ts';
import { markerPath, readMarker } from './workspace.ts';
import { isLocalBackend, markerConnection, McpSession, mcpTimeoutMs, type BasicMemoryConnection } from './basicmemory.ts';
import { isSharedCollectionRoot } from './ownership.ts';

export class ConnectionRefusal extends Error {}

function refuse(message: string): never {
  throw new ConnectionRefusal(message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRAY_FILES = ['.library-mcp-url', '.library-project', '.library-shared-root'];

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

export interface ServerProject {
  name: string;
  id: string;
  path: string;
}

/** The server's projects, as `list_memory_projects` names them: name, UUID (`external_id`), path. */
export async function listServerProjects(session: McpSession): Promise<ServerProject[]> {
  const response = await session.callTool('list_memory_projects', { output_format: 'json' });
  const result = field(response, 'result');
  if (field(response, 'error') !== undefined && field(response, 'error') !== null) refuse('The Basic Memory server refused to list its projects.');
  if (field(result, 'isError') === true) refuse('The Basic Memory server refused to list its projects.');
  let listed: unknown = field(field(result, 'structuredContent'), 'result');
  if (field(listed, 'projects') === undefined) {
    const block = (field(result, 'content') as unknown[] | undefined)?.find((item) => field(item, 'type') === 'text');
    try {
      listed = JSON.parse(String(field(block, 'text') ?? ''));
    } catch {
      refuse('The Basic Memory server answered list_memory_projects with nothing this program can read.');
    }
  }
  const projects = field(listed, 'projects');
  if (!Array.isArray(projects)) refuse('The Basic Memory server answered list_memory_projects with no project list.');
  return projects
    .map((project) => ({ name: String(field(project, 'name') ?? ''), id: String(field(project, 'external_id') ?? ''), path: String(field(project, 'path') ?? '') }))
    .filter((project) => project.name.trim());
}

/** Open a session, bounded by the MCP timeout, or the reason it could not be opened. */
export async function openServer(url: string): Promise<McpSession> {
  if (!/^https?:\/\/[^\s]+$/.test(url)) refuse(`The Basic Memory server URL must be an absolute http or https URL; got '${url}'.`);
  const session = new McpSession(url, 'deskpost-basic-memory-connection');
  await session.initialize();
  return session;
}

/** The marker rewritten whole with every field it had, `connections` replaced by `connections` as given. */
function writeMarkerConnections(workspace: string, connection: BasicMemoryConnection | null): void {
  const marker = readMarker(workspace);
  if (marker === null) refuse(`${workspace} has no workspace marker. Run library init first.`);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(marker)) if (key !== 'connections') next[key] = value;
  const others: Record<string, unknown> = {};
  const existing = marker['connections'];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) if (key !== 'basic_memory') others[key] = value;
  }
  if (connection !== null) others['basic_memory'] = { ...connection };
  if (Object.keys(others).length) next['connections'] = others;
  writeAtomicText(markerPath(workspace), psConvertToJson(next as PsJsonValue) + '\n');
}

function assertLocalLibrary(workspace: string, verb: string): void {
  const marker = readMarker(workspace);
  if (marker === null) refuse(`${workspace} has no workspace marker, so it is not a Library. Run library init first.`);
  if (!isLocalBackend(workspace)) {
    refuse(
      `library basic-memory ${verb} connects a LOCAL Library to a Basic Memory server, and this workspace's backend already is Basic ` +
        'Memory: its Books and Hubs live there. Nothing was changed.',
    );
  }
}

/** The three `.claude` files a 1.0 `init --mcp-url` could leave in a local Library. Named, never read, never removed. */
function strayConnectionFiles(workspace: string): string[] {
  return STRAY_FILES.filter((name) => fs.existsSync(path.join(workspace, '.claude', name))).map((name) => `.claude/${name}`);
}

// --- setup ---------------------------------------------------------------------------------------------------

async function setup(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, argumentTable('basic-memory', 'setup'));
  assertLocalLibrary(workspace, 'setup');
  const current = markerConnection(workspace);
  const url = (parsed.options.get('url') ?? current?.url ?? '').trim();
  if (!url) refuse("library basic-memory setup needs --url <the server's MCP URL>, the address its streamable-HTTP MCP answers at.");
  const checks: Record<string, PsJsonValue>[] = [];

  // THE URL, live: it answers `initialize` within the timeout, or nothing else is asked of it.
  let session: McpSession;
  try {
    session = await openServer(url);
  } catch (error) {
    refuse(`Nothing was saved. The server URL ${url} failed its check: ${(error as Error).message}`);
  }
  checks.push({ field: 'Basic Memory server URL', value: url, status: 'ok', detail: `answered MCP initialize within ${mcpTimeoutMs() / 1000} s` });

  // THE COLLECTION, from the server's own list, stored as its UUID.
  const projects = await listServerProjects(session);
  const wanted = (parsed.options.get('collection') ?? current?.collection_name ?? '').trim();
  const names = projects.map((project) => project.name).join(', ') || '(none)';
  if (!wanted) refuse(`Nothing was saved. Choose the collection with --collection <name>; this server has: ${names}.`);
  const chosen = projects.find((project) => project.name === wanted || project.id === wanted.toLowerCase());
  if (chosen === undefined) refuse(`Nothing was saved. The server has no collection '${wanted}'; it has: ${names}.`);
  if (!UUID.test(chosen.id)) refuse(`Nothing was saved. The server lists '${chosen.name}' with no UUID ('${chosen.id}'), and a shared read needs one.`);
  checks.push({ field: 'Collection', value: chosen.name, status: 'ok', detail: `chosen from the server's projects; its id ${chosen.id} is stored` });

  // THE STORAGE FOLDER, optional: import reads it, status and open-shared work without it.
  const storageOption = parsed.options.get('storage');
  const storage = (storageOption ?? current?.storage ?? '').trim();
  if (storage) {
    const full = path.resolve(storage);
    if (!isSharedCollectionRoot(full)) {
      refuse(`Nothing was saved. The storage folder ${full} failed its check: it does not hold both books/README.md and projects/README.md, so it is not this collection's folder.`);
    }
    checks.push({ field: 'Storage folder', value: full, status: 'ok', detail: 'holds books/README.md and projects/README.md; import reads it and never writes it' });
  } else {
    checks.push({ field: 'Storage folder', value: '', status: 'blank', detail: 'status and open-shared work; import needs the folder' });
  }

  const connection: BasicMemoryConnection = { url, collection_id: chosen.id, collection_name: chosen.name, storage: storage ? path.resolve(storage) : '' };
  const result: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Connect Basic Memory',
    workspace,
    checks,
    connection: { ...connection },
    stored_in: '.library/workspace.json, as connections.basic_memory',
    backend: 'local',
    shared_library_write: false,
  };
  const stray = strayConnectionFiles(workspace);
  if (stray.length) {
    result['stray_connection_files'] = stray;
    result['stray_note'] =
      'These files are what a Basic Memory BACKEND reads, and this Library is local: nothing here reads them, and set-up did not ' +
      'remove them. An earlier `library init --mcp-url` may have left them.';
  }
  if (parsed.flags.has('preflight')) return { ...result, saved: false };
  writeMarkerConnections(workspace, connection);
  // READ BACK: the marker now carries exactly this connection, and the Library is still local.
  const back = markerConnection(workspace);
  if (back === null || back.url !== url || back.collection_id !== chosen.id || !isLocalBackend(workspace)) {
    refuse('The connection was written to the marker and did not read back as written. Check .library/workspace.json.');
  }
  for (const name of STRAY_FILES) {
    if (!stray.includes(`.claude/${name}`) && fs.existsSync(path.join(workspace, '.claude', name))) refuse(`Set-up must never write .claude/${name}, and it is there now.`);
  }
  return { ...result, saved: true };
}

// --- disconnect ----------------------------------------------------------------------------------------------

function disconnect(argv: string[], workspace: string): Record<string, PsJsonValue> {
  parseArguments(argv, argumentTable('basic-memory', 'disconnect'));
  assertLocalLibrary(workspace, 'disconnect');
  const current = markerConnection(workspace);
  if (current === null) return { schema: 1, operation: 'Disconnect Basic Memory', workspace, disconnected: false, note: 'This Library has no Basic Memory connection.', shared_library_write: false };
  writeMarkerConnections(workspace, null);
  if (markerConnection(workspace) !== null) refuse('The connection was removed from the marker and still reads back. Check .library/workspace.json.');
  return {
    schema: 1,
    operation: 'Disconnect Basic Memory',
    workspace,
    disconnected: true,
    removed: { ...current },
    note: "Only the marker's record of the connection was removed. Neither collection was touched: the Library's own Books and Hubs, and the server's, are exactly as they were.",
    shared_library_write: false,
  };
}

export interface ConnectionVerbResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/** `library basic-memory <setup|disconnect|...>`. */
export async function runBasicMemoryVerb(argv: string[], workspace: string, extra: Record<string, (argv: string[], workspace: string) => Promise<Record<string, PsJsonValue>>> = {}): Promise<ConnectionVerbResult> {
  const action = argv[0] ?? '';
  try {
    if (action === 'setup') return { refusal: null, value: await setup(argv.slice(1), workspace) };
    if (action === 'disconnect') return { refusal: null, value: disconnect(argv.slice(1), workspace) };
    const handler = extra[action];
    if (handler !== undefined) return { refusal: null, value: await handler(argv.slice(1), workspace) };
    return { refusal: `library basic-memory has no action '${action}'. It has: ${['setup', 'disconnect', ...Object.keys(extra)].sort().join(', ')}.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
