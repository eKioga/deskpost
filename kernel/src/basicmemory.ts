/**
 * The Basic Memory half of a collection (ADR-0030; S16's shared half, S33): the deployment a workspace
 * is attached through, the MCP transport, and the exact-record read and write every shared helper builds
 * on. The PowerShell originals are `tools/LibraryDeployment.ps1`, the `Invoke-Mcp` / `Read-ExactOrNull` /
 * `Write-Exact` trio `tools/New-ProjectHub.ps1` carries, and the reader adapter's exact-record reads.
 *
 * WHERE THE DEPLOYMENT COMES FROM, AND ONE DIFFERENCE STATED. The chain is the oracle's: the environment
 * (`AI_LIBRARY_MCP_URL`, `AI_LIBRARY_PROJECT_ID`, `LIBRARY_SHARED_COLLECTION_ROOT`), then the workspace's
 * own `.claude/.library-*` files. The oracle's LAST resort is the PROGRAM ROOT's `.claude/`, which in the
 * maintainer's checkout names the reader's own collection (S32) -- and this kernel has none: a workspace
 * with no deployment is refused, never answered from the program's files.
 *
 * TWO ANSWERS OF THE SERVER, MEASURED BEFORE A LINE WAS WRITTEN (2026-09-22, S33, against a disposable
 * project). A note that does not exist is NOT an error: `read_note` answers `isError: false` with a
 * record whose `file_path` and `content` are null. And a no-overwrite `write_note` over an existing note
 * is NOT an error either: `isError: false`, `action: "conflict"`, `error: "NOTE_ALREADY_EXISTS"`. The
 * first the oracle already handled; the second made New-ProjectHub.ps1 report `created` over another
 * writer's Hub, which was fixed there first (Test-McpHelpers.ps1 holds it) and is refused here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMarker } from './workspace.ts';

const PIN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BasicMemoryRefusal extends Error {}

/**
 * A WRITE WHOSE SESSION DROPPED (kickoffs/s121 row 7; PLAN-many-libraries.md Stage 0, third bullet). The session is
 * re-opened and the call is NOT sent again: the server may have committed it before it forgot the session, so whether it
 * landed is judged by reading it back, never by retrying blind.
 */
export class SessionDropped extends BasicMemoryRefusal {}

/**
 * THE TOOLS THAT CHANGE THE SERVER. `callTool` never resends one of these after a dropped session (row 7), whichever
 * writer calls it; a read is still resent once, as before.
 */
const WRITE_TOOLS = new Set(['write_note', 'edit_note', 'move_note', 'delete_note', 'create_memory_project', 'delete_project']);

function refuse(message: string): never {
  throw new BasicMemoryRefusal(message);
}

function readState(file: string): string {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return '';
  }
}

function stateFile(workspace: string, name: string): string {
  return path.join(workspace, '.claude', name);
}

// --- a local Library's connection (PLAN-basic-memory.md step 2; ADR-0050) --------------------------------
//
// A LOCAL LIBRARY'S BASIC MEMORY LIVES IN ITS MARKER AND NOWHERE ELSE, as `connections.basic_memory`. The three
// `.claude/.library-*` files are what `init` reads to decide a workspace's BACKEND and what the fence reads to
// decide who may write, so a connection written there would turn the next `init` into a silent conversion to
// `backend: basic-memory` (the plan's Fable #1). And the marker's `backend: local` is honoured BEFORE the
// environment: a shell with AI_LIBRARY_MCP_URL set must not make a local Library reach for a server it never
// connected (round 2). A workspace whose backend IS Basic Memory reads the environment and the files as before.

export interface BasicMemoryConnection {
  url: string;
  collection_id: string;
  /** The collection's name on the server, as set-up chose it. Shown, never addressed by. */
  collection_name: string;
  /** The server's storage folder on this machine, which import reads. '' when set-up was given none. */
  storage: string;
}

/** Whether this workspace's marker says `backend: local`. An unreadable marker is not local: it answers nothing. */
export function isLocalBackend(workspace: string): boolean {
  let marker: Record<string, unknown> | null = null;
  try {
    marker = readMarker(workspace);
  } catch {
    return false;
  }
  return marker !== null && String(marker['backend'] ?? '') === 'local';
}

function textField(record: unknown, name: string): string {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return '';
  const value = (record as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** The connection a local Library's marker records, or null when it records none (or is not local). */
export function markerConnection(workspace: string): BasicMemoryConnection | null {
  if (!isLocalBackend(workspace)) return null;
  const connections = (readMarker(workspace) ?? {})['connections'];
  const record = connections !== null && typeof connections === 'object' && !Array.isArray(connections)
    ? (connections as Record<string, unknown>)['basic_memory']
    : undefined;
  const url = textField(record, 'url');
  if (!url) return null;
  return {
    url,
    collection_id: textField(record, 'collection_id'),
    collection_name: textField(record, 'collection_name'),
    storage: textField(record, 'storage'),
  };
}

/** `Resolve-LibraryMcpUrl` without its program-root fallback: the endpoint, or '' when none is configured. */
export function configuredMcpUrl(workspace: string): string {
  if (isLocalBackend(workspace)) return markerConnection(workspace)?.url ?? '';
  const fromEnvironment = (process.env['AI_LIBRARY_MCP_URL'] ?? '').trim();
  return fromEnvironment || readState(stateFile(workspace, '.library-mcp-url'));
}

/** The endpoint, or `Resolve-LibraryMcpUrl`'s own refusal, naming all three routes. */
export function resolveMcpUrl(workspace: string): string {
  const resolved = configuredMcpUrl(workspace);
  if (!resolved && isLocalBackend(workspace)) {
    refuse(
      'This Library has no Basic Memory connection, so there is nothing to talk to. Connect one with ' +
        '`library basic-memory setup`; the Library itself needs none.',
    );
  }
  if (!resolved) {
    refuse(
      'No Basic Memory endpoint is configured, so there is nothing to talk to. Pass -McpUrl <url>, ' +
        'set AI_LIBRARY_MCP_URL, or run tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> ' +
        'once to write .claude/.library-mcp-url for this workspace.',
    );
  }
  // Case-sensitive, as the oracle's -cnotmatch: 'HTTP://' is not admitted into a request line.
  if (!/^https?:\/\/[^\s]+$/.test(resolved)) refuse(`The Basic Memory endpoint must be an absolute http or https URL; got '${resolved}'.`);
  return resolved;
}

/** `Resolve-LibraryCollectionId -Optional`: the collection id, or ''. */
export function configuredCollectionId(workspace: string): string {
  if (isLocalBackend(workspace)) return markerConnection(workspace)?.collection_id ?? '';
  const fromEnvironment = (process.env['AI_LIBRARY_PROJECT_ID'] ?? '').trim();
  return fromEnvironment || readState(stateFile(workspace, '.library-project'));
}

/** `Resolve-LibraryCollectionId`: the collection id, or its refusal. */
export function resolveCollectionId(workspace: string): string {
  const resolved = configuredCollectionId(workspace);
  if (!resolved) {
    refuse(
      'No collection id is configured, so no shared Book or Project Hub can be addressed. Pass ' +
        '-ProjectId <id>, set AI_LIBRARY_PROJECT_ID, or run tools/Initialize-CodexLibrary.ps1 ' +
        '-McpUrl <url> -CollectionId <id> once to write .claude/.library-project for this workspace.',
    );
  }
  return resolved;
}

/** `Resolve-LibrarySharedCollectionRoot`, which never throws: the share root, or ''. */
export function configuredSharedRoot(workspace: string): string {
  if (isLocalBackend(workspace)) return markerConnection(workspace)?.storage ?? '';
  const fromEnvironment = (process.env['LIBRARY_SHARED_COLLECTION_ROOT'] ?? '').trim();
  return fromEnvironment || readState(stateFile(workspace, '.library-shared-root'));
}

/**
 * `Get-LibraryProjectId` as the reader adapter reads it: the DESK's pin, `.claude/.library-project`, and
 * not the environment. The Desk is what a read is gated on, so the collection a read addresses is the
 * one the Desk is pinned to.
 */
export function deskPin(stateDirectory: string): string {
  const file = path.join(stateDirectory, '.library-project');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) refuse('Virtual Desk configuration is missing .library-project.');
  const pin = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  if (!PIN_PATTERN.test(pin)) refuse('Virtual Desk project pin is malformed.');
  return pin;
}

// --- the transport ---------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** `ConvertTo-AsciiJson`: every non-ASCII character escaped, so the body is ASCII on the wire as the oracle sends it. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  return (object as Record<string, unknown>)[name];
}

/**
 * EVERY MCP CALL IS BOUNDED (PLAN-basic-memory.md step 2, Fable #11). Until 1.1 `fetch` ran with no signal, so a
 * host that accepted the connection and never answered -- a black-holed route, a server stuck in a start --
 * hung whatever asked it, the menu included. Twenty seconds per request, or LIBRARY_MCP_TIMEOUT_MS; the
 * request and the reading of its answer share the one deadline.
 */
export function mcpTimeoutMs(): number {
  const configured = Number((process.env['LIBRARY_MCP_TIMEOUT_MS'] ?? '').trim());
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20000;
}

export class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly url: string;
  private readonly clientName: string;

  // Plain fields, not parameter properties: Node runs this file by stripping types, and a parameter
  // property is syntax it will not strip.
  constructor(url: string, clientName: string) {
    this.url = url;
    this.clientName = clientName;
  }

  private async once(method: string, params: unknown, notification: boolean): Promise<unknown> {
    const id = notification ? null : this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (id !== null) payload['id'] = id;
    if (params !== undefined) payload['params'] = params;
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response: Response;
    let body: string;
    const timeout = mcpTimeoutMs();
    try {
      response = await fetch(this.url, { method: 'POST', headers, body: asciiJson(payload), signal: AbortSignal.timeout(timeout) });
      body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.substring(0, 4096)}`);
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        refuse(`MCP ${method} failed: ${this.url} did not answer within ${Math.round(timeout / 100) / 10} s, so nothing was read from it.`);
      }
      refuse(`MCP ${method} failed: ${(error as Error).message}`);
    }
    if (method === 'initialize') {
      const session = response.headers.get('Mcp-Session-Id');
      if (!session) refuse('The shared Library did not establish an MCP session.');
      this.sessionId = session;
    }
    if (notification) return null;
    if (body.trim().startsWith('{')) return JSON.parse(body) as unknown;
    // Server-sent events: the LAST frame carrying this request's id. An id-less log frame is skipped
    // rather than read, as the oracle skips it.
    const frames = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.substring(5).trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((frame) => frame !== null && field(frame, 'id') === id);
    if (frames.length === 0) refuse(`MCP response for request ${id} was incomplete.`);
    return frames[frames.length - 1];
  }

  async initialize(): Promise<void> {
    const answer = await this.once(
      'initialize',
      { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: this.clientName, version: '1.0.0' } },
      false,
    );
    const error = field(answer, 'error');
    if (error !== undefined && error !== null) refuse(`MCP initialization was rejected: ${String(field(error, 'message') ?? '')}`);
    await this.once('notifications/initialized', {}, true);
  }

  /**
   * One request, retried ONCE after re-initialising when the server has forgotten the session -- the
   * oracle's whole recovery, and only for the calls this file makes, all of which are safe to repeat.
   */
  async request(method: string, params: unknown, retry = true): Promise<unknown> {
    try {
      return await this.once(method, params, false);
    } catch (error) {
      if (!this.sessionId || !/Session not found/.test((error as Error).message)) throw error;
      // Re-opened either way, so the next call (the readback that judges a write) has a session.
      this.sessionId = null;
      await this.initialize();
      if (!retry) {
        const tool = String(field(params, 'name') ?? method);
        throw new SessionDropped(
          `The Basic Memory session dropped during ${tool}. It was re-opened and the call was not sent again, because the ` +
            'server may already have made it; read it back to see whether it landed.',
        );
      }
      return await this.once(method, params, false);
    }
  }

  /** A read is resent once after a dropped session; a write (WRITE_TOOLS) never is (kickoffs/s121 row 7). */
  async callTool(name: string, args: Record<string, Json>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, !WRITE_TOOLS.has(name));
  }

  /**
   * `Test-McpRetryIsSafe`'s exclusion: an `append`, `prepend` or `insert_*` edit is not idempotent, so a
   * second application would duplicate its content silently. Such a call is never retried.
   */
  async callToolOnce(name: string, args: Record<string, Json>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, false);
  }
}

// --- exact records ---------------------------------------------------------------------------------

export interface NoteRecord {
  file_path: string;
  title: string;
  content: string;
  /** The structured frontmatter, present whether or not `include_frontmatter` put it in `content` (measured S39). */
  frontmatter?: unknown;
}

function toolResult(response: unknown): unknown {
  return field(response, 'result');
}

function isRpcError(response: unknown): boolean {
  const error = field(response, 'error');
  return error !== undefined && error !== null;
}

function structuredRecord(response: unknown): unknown {
  const result = toolResult(response);
  const structured = field(result, 'structuredContent');
  const record = field(structured, 'result');
  if (record !== undefined && record !== null) return record;
  // The adapter falls back to the first text block's JSON when no structured result came back.
  const content = field(result, 'content');
  if (Array.isArray(content)) {
    const block = content.find((item) => field(item, 'type') === 'text');
    const text = field(block, 'text');
    if (typeof text === 'string') {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** How a Basic Memory write was refused, by the form the refusal took (kickoffs/s121 row 7). */
export type WriteRefusalForm = 'rpc-error' | 'is-error' | 'note-already-exists' | 'error-field' | 'conflict' | 'edit-failed' | 'error-heading';

export interface WriteVerdict {
  refused: boolean;
  form: WriteRefusalForm | null;
  detail: string;
}

/**
 * THE ONE JUDGE OF A BASIC MEMORY WRITE (kickoffs/s121 row 7; PLAN-many-libraries.md Stage 0; B's Stage 0 probes,
 * 2026-10-15). Basic Memory v0.23.2 reports most refusals as ORDINARY RESULTS, `isError: false`: with
 * `output_format: json` a `result.error` (`NOTE_ALREADY_EXISTS` beside `action: conflict` for an existing note, `Text to
 * replace not found: ...` for a refused edit_note), and in text a heading (`# Error: Note already exists`, `# Edit Failed
 * - Text Not Found`). So `isError` alone is never trusted: any of these is a refusal, and the form is named. Every kernel
 * write is still followed by its readback.
 */
export function judgeWriteResult(response: unknown): WriteVerdict {
  const refused = (form: WriteRefusalForm, detail: string): WriteVerdict => ({ refused: true, form, detail: detail.substring(0, 300) });
  if (isRpcError(response)) return refused('rpc-error', text(field(field(response, 'error'), 'message')));
  const result = toolResult(response);
  const content = field(result, 'content');
  const block = Array.isArray(content) ? content.find((item) => field(item, 'type') === 'text') : undefined;
  const firstText = text(field(block, 'text'));
  if (field(result, 'isError') === true) return refused('is-error', firstText);
  const record = structuredRecord(response);
  const error = field(record, 'error');
  if (error !== undefined && error !== null && text(error).trim() !== '') {
    return refused(text(error) === 'NOTE_ALREADY_EXISTS' ? 'note-already-exists' : 'error-field', text(error));
  }
  if (text(field(record, 'action')) === 'conflict') return refused('conflict', 'action: conflict');
  const heading = firstText.trimStart().split(/\r?\n/, 1)[0] ?? '';
  if (/^#\s*Edit Failed\b/i.test(heading)) return refused('edit-failed', heading);
  if (/^#\s*Error\b/i.test(heading)) return refused('error-heading', heading);
  return { refused: false, form: null, detail: '' };
}

/**
 * ONE WRITE, SENT ONCE AND JUDGED (kickoffs/s121 row 7). A refusal in any form refuses, naming it. A dropped session
 * returns `dropped: true` with the session re-opened and nothing resent: the caller's readback decides.
 */
export async function sendWrite(session: McpSession, name: string, args: Record<string, Json>, label: string): Promise<{ dropped: boolean; response: unknown }> {
  let response: unknown;
  try {
    response = await session.callToolOnce(name, args);
  } catch (error) {
    if (error instanceof SessionDropped) return { dropped: true, response: null };
    throw error;
  }
  const verdict = judgeWriteResult(response);
  if (verdict.refused) refuse(`${label} was refused (${verdict.form}${verdict.detail ? `: ${verdict.detail}` : ''}). Nothing was overwritten.`);
  return { dropped: false, response };
}

/**
 * `Read-ExactOrNull` (New-ProjectHub.ps1): the note at exactly `relative` (with `.md`), or null when it
 * does not exist. A record for any other path is refused rather than read.
 *
 * Every helper carries its own copy, and they differ in two places only, both carried here: whether the
 * frontmatter comes back (the Hub helpers ask for it, the Book archiver and the Catalog lister do not --
 * which changes the text a title is read from), and the words that end a substituted-path refusal.
 */
export async function readExactOrNull(
  session: McpSession,
  projectId: string,
  relative: string,
  // `allowRedirect`: the archivers' `-AllowRedirect`, for the one read that asks where a moved note went.
  options: { includeFrontmatter?: boolean; stopped?: string; allowRedirect?: boolean } = {},
): Promise<NoteRecord | null> {
  const stopped = options.stopped ?? 'creation stopped';
  const response = await session.callTool('read_note', {
    project_id: projectId,
    identifier: relative.substring(0, relative.length - 3),
    output_format: 'json',
    include_frontmatter: options.includeFrontmatter ?? true,
  });
  if (isRpcError(response)) refuse(`Read '${relative}' failed: ${text(field(field(response, 'error'), 'message'))}`);
  const result = toolResult(response);
  if (field(result, 'isError') === true) {
    const detail = JSON.stringify(field(result, 'content') ?? null);
    if (/not found|does not exist|no note/i.test(detail)) return null;
    refuse(`Read '${relative}' was rejected: ${detail}`);
  }
  const record = field(field(result, 'structuredContent'), 'result');
  if (record === undefined || record === null || !text(field(record, 'file_path')).trim()) return null;
  if (text(field(record, 'file_path')) !== relative && !options.allowRedirect) refuse(`Read '${relative}' returned '${text(field(record, 'file_path'))}'; ${stopped}.`);
  return {
    file_path: text(field(record, 'file_path')),
    title: text(field(record, 'title')),
    content: text(field(record, 'content')),
    frontmatter: field(record, 'frontmatter'),
  };
}

/**
 * ONE READ THROUGH `read_content` (kickoffs/s123 row 2): the text the server answers for `relative`, or null when it
 * says not found. NOT the file actually at a path (B's probe of the real server, 2026-10-17,
 * `projects/deskpost-desk/notes/2026-10-17-postbox-probes`, findings 2-4): the server follows a permalink first, so a
 * moved note's old path answers the moved note even once a new file is there, and a path with no file, in a folder that
 * holds notes, answers another note from that folder; only a folder with no notes answers not found. The answer is
 * `{type: "text", text, content_type, encoding}`. Presence is `list_directory`'s to judge; a listed file is read with
 * `readPermalinkContent` below.
 */
export async function readContentOrNull(session: McpSession, projectId: string, relative: string): Promise<string | null> {
  const response = await session.callTool('read_content', { project_id: projectId, path: relative });
  if (isRpcError(response)) refuse(`Read '${relative}' failed: ${text(field(field(response, 'error'), 'message'))}`);
  const result = toolResult(response);
  const record = structuredRecord(response);
  const said = JSON.stringify(record ?? field(result, 'content') ?? null);
  if (field(result, 'isError') === true || field(record, 'type') === 'error') {
    if (/not found|does not exist|no such/i.test(said)) return null;
    refuse(`Read '${relative}' was rejected: ${said.substring(0, 300)}`);
  }
  const body = field(record, 'text');
  if (typeof body !== 'string') refuse(`Read '${relative}' gave no text: ${said.substring(0, 300)}`);
  return body;
}

/**
 * ONE LISTED FILE BY ITS PERMALINK, CHECKED (kickoffs/s131 row 3; probe of 2026-10-17, findings 3, 4 and 6): the text
 * `read_content` answers for the `permalink` a `list_directory` node gave, accepted only when the text's own
 * `permalink:` line is that permalink, or that permalink without the project's name in front (STANDING ANSWER 12).
 * Anything else is refused by name, never trusted: the real server answers a read it cannot match with another note.
 * Null only when the server says not found. Presence is the listing's to judge, never this read's.
 */
export async function readPermalinkContent(session: McpSession, projectId: string, permalink: string): Promise<string | null> {
  if (!permalink.trim()) refuse('A listed file came with no permalink, so it was not read and not trusted.');
  const body = await readContentOrNull(session, projectId, permalink);
  if (body === null) return null;
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  const line = front ? /^permalink:[ \t]*['"]?(.*?)['"]?[ \t]*$/m.exec(front[1]!) : null;
  const said = line ? line[1]! : '';
  if (!said || (said !== permalink && !(permalink.endsWith(`/${said}`) && !permalink.slice(0, -said.length - 1).includes('/')))) {
    refuse(`Read '${permalink}' answered a note whose permalink is '${said || '(none)'}', not the one listed, so it was not trusted.`);
  }
  return body;
}

/**
 * `move_note` to a folder (kickoffs/s123 row 3; probe S6: the permalink stays at the old path), sent once and judged by
 * the one judge. A refusal or a dropped session is returned, never thrown or resent: the caller lists both folders
 * after it and judges by the files actually there (kickoffs/s131). An identifier that resolves to a note already in
 * the destination answers `DESTINATION_SAME_AS_SOURCE` (probe of 2026-10-17, finding 5), returned as not moved.
 */
export async function moveNoteTo(session: McpSession, projectId: string, identifier: string, destinationFolder: string): Promise<{ moved: boolean; dropped: boolean; detail: string }> {
  try {
    const sent = await sendWrite(session, 'move_note', { project_id: projectId, identifier, destination_folder: destinationFolder, output_format: 'json' }, `Moving '${identifier}'`);
    return { moved: !sent.dropped, dropped: sent.dropped, detail: '' };
  } catch (error) {
    if (error instanceof BasicMemoryRefusal) return { moved: false, dropped: false, detail: error.message };
    throw error;
  }
}

/**
 * `Write-Exact` (New-ProjectHub.ps1), with the S33 correction: a conflict is a refusal, and the page is
 * read back before the write is reported.
 */
export async function writeExact(
  session: McpSession,
  projectId: string,
  directory: string,
  title: string,
  body: string,
  overwrite: boolean,
): Promise<NoteRecord> {
  // SENT ONCE, JUDGED BY THE ONE JUDGE (kickoffs/s121 row 7). An existing note under `overwrite: false` keeps the
  // sentence it always had; a dropped session is judged by the readback below, whose body must be this write's.
  let sent: { dropped: boolean; response: unknown };
  try {
    sent = await sendWrite(session, 'write_note', { project_id: projectId, directory, title, content: body, note_type: 'note', overwrite, output_format: 'json' }, `Write '${directory}/${title}'`);
  } catch (error) {
    if (/\((note-already-exists|conflict)\b/.test((error as Error).message)) {
      refuse(
        `Write '${directory}/${title}' was refused: a note already exists there, written by someone else since this run read ` +
          'the collection. Nothing was overwritten.',
      );
    }
    throw error;
  }
  const record = await readExactOrNull(session, projectId, `${directory}/${title}.md`);
  if (record === null) {
    refuse(sent.dropped
      ? `Write '${directory}/${title}.md' was not found after its session dropped, and it was not sent again. Run the command again.`
      : `Write '${directory}/${title}.md' did not become readable.`);
  }
  if (sent.dropped && noteBody(record).replace(/\r\n/g, '\n').trim() !== body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n').trim()) {
    refuse(`Write '${directory}/${title}.md' cannot be confirmed: its session dropped, and the note there now is not this write's text. It was not sent again.`);
  }
  return record;
}

/** `Get-NoteBody`: a record's content with its frontmatter removed. */
export function noteBody(record: NoteRecord): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(record.content);
  return match ? match[1]!.replace(/^[\r\n]+/, '') : record.content;
}

/**
 * The reader adapter's exact-record read (`Read-ValidatedProjectCatalog`, `Read-ValidatedProjectPage`):
 * an absent record is `absent`, a record for another path is withheld, and an empty one is refused. The
 * refusals are the caller's, because each read words them for what it asked for.
 */
export async function readValidatedRecord(
  session: McpSession,
  projectId: string,
  requestedPath: string,
  words: { rejected: string; unreadable: string; different: string; empty: string },
): Promise<NoteRecord | 'absent'> {
  const response = await session.callTool('read_note', {
    project_id: projectId,
    identifier: requestedPath,
    output_format: 'json',
    include_frontmatter: true,
  });
  if (isRpcError(response) || field(toolResult(response), 'isError') === true) refuse(words.rejected);
  const record = structuredRecord(response);
  if (record === null || record === undefined) refuse(words.unreadable);
  if (!text(field(record, 'file_path')).trim() && !text(field(record, 'content')).trim()) return 'absent';
  if (text(field(record, 'file_path')) !== `${requestedPath}.md`) refuse(words.different);
  if (!text(field(record, 'content')).trim()) refuse(words.empty);
  return { file_path: text(field(record, 'file_path')), title: text(field(record, 'title')), content: text(field(record, 'content')) };
}
