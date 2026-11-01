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
 *
 * BASIC MEMORY 1.0 (kickoffs/s175 row 1; the NAS moved to 1.0.0 unannounced on 2026-10-30). 1.0 removed every tool above
 * with no aliases and offers twelve `bm_*` tools; every project-scoped call needs `project`; a refusal is `isError: true`
 * with a typed `error` code. So a session reads the server's `tools/list` at connect and keeps the names: its SURFACE is
 * `bm` when it offers `bm_read`, `legacy` when it offers `read_note`, and `unknown` otherwise (a list that could not be
 * read included). The helpers below speak 1.0 on `bm` and keep today's calls on `legacy` and `unknown`; a caller that
 * needs a tool the server does not list refuses in one line (`needTools`), and the shared-collection writers, not yet
 * ported, refuse on anything but `legacy` (`refuseUnportedWriter`; train item basic-memory-1-0, step 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMarker } from './workspace.ts';
import { assertNotRedirected, plainHttpRequestUrl } from './netpolicy.ts';

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
 * writer calls it; a read is still resent once, as before. 1.0's four change tools join them (kickoffs/s175 row 1(d)).
 */
const WRITE_TOOLS = new Set(['write_note', 'edit_note', 'move_note', 'delete_note', 'create_memory_project', 'delete_project', 'bm_write', 'bm_edit', 'bm_move', 'bm_delete']);

/** A call that changes the server: a `WRITE_TOOLS` name, or `bm_project` creating or deleting a project (kickoffs/s175 row 1(d)). */
function changesServer(name: string, args: Record<string, Json>): boolean {
  return WRITE_TOOLS.has(name) || (name === 'bm_project' && (args['command'] === 'create' || args['command'] === 'delete'));
}

/** Which tools a server speaks, read from its `tools/list` at connect (kickoffs/s175 row 1(b)). */
export type ServerSurface = 'bm' | 'legacy' | 'unknown';

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
  /** The tool names the server's `tools/list` offered at connect, or null when the list could not be read. */
  tools: string[] | null = null;
  surface: ServerSurface = 'unknown';

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
      // NO SOCKET OUTLIVES ITS REQUEST (kickoffs/s149 row 3b): a pooled keep-alive socket that sat through a frozen event
      // loop longer than the server's idle timeout carried the next request to a closed socket (section 324's
      // ECONNRESET). The session travels in Mcp-Session-Id, never in the socket.
      Connection: 'close',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response: Response;
    let body: string;
    const timeout = mcpTimeoutMs();
    // PLAIN HTTP STAYS INSIDE THE HOME NETWORK (kickoffs/s164 row 2), judged before every request, not when the URL was saved,
    // and sent to the address judged (kickoffs/s167 row 5), so a second lookup cannot answer differently.
    let target = this.url;
    try { target = await plainHttpRequestUrl(this.url, 'The Basic Memory endpoint'); }
    catch (error) { refuse((error as Error).message); }
    try {
      // NO REDIRECT IS FOLLOWED (kickoffs/s164 row 1): a 307 or 308 would carry this body and the session elsewhere.
      response = await fetch(target, { method: 'POST', headers, body: asciiJson(payload), signal: AbortSignal.timeout(timeout), redirect: 'manual' });
      assertNotRedirected(response, this.url, 'The Basic Memory endpoint');
      body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.substring(0, 4096)}`);
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        refuse(`MCP ${method} failed: ${this.url} did not answer within ${Math.round(timeout / 100) / 10} s, so nothing was read from it.`);
      }
      const cause = (error as Error & { cause?: { code?: unknown; message?: unknown } }).cause;
      const detail = cause?.code ?? cause?.message;
      refuse(`MCP ${method} failed: ${(error as Error).message}${detail ? ` (${String(detail)})` : ''}`);
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
    await this.readTools();
  }

  /** The endpoint this session talks to, as a refusal names it. */
  get endpoint(): string {
    return this.url;
  }

  /**
   * WHAT THE SERVER OFFERS, READ AT CONNECT (kickoffs/s175 row 1(a), (b)): `tools/list`, following `nextCursor`. A list that
   * answers an error, or a result with no `tools`, leaves the surface `unknown` and the connection standing: the session
   * still works, and a caller that needs a tool says so in one line.
   */
  private async readTools(): Promise<void> {
    this.tools = null;
    this.surface = 'unknown';
    const names: string[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 50; page += 1) {
        const answer = await this.once('tools/list', cursor === null ? {} : { cursor }, false);
        const listed = field(field(answer, 'result'), 'tools');
        if (isRpcError(answer) || !Array.isArray(listed)) return;
        for (const tool of listed) {
          const name = field(tool, 'name');
          if (typeof name === 'string' && name) names.push(name);
        }
        const next = field(field(answer, 'result'), 'nextCursor');
        if (typeof next !== 'string' || !next) break;
        cursor = next;
      }
    } catch (error) {
      if (error instanceof BasicMemoryRefusal) return;
      throw error;
    }
    this.tools = names;
    this.surface = names.includes('bm_read') ? 'bm' : names.includes('read_note') ? 'legacy' : 'unknown';
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

  /** A read is resent once after a dropped session; a write (`changesServer`) never is (kickoffs/s121 row 7). */
  async callTool(name: string, args: Record<string, Json>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, !changesServer(name, args));
  }

  /**
   * `Test-McpRetryIsSafe`'s exclusion: an `append`, `prepend` or `insert_*` edit is not idempotent, so a
   * second application would duplicate its content silently. Such a call is never retried.
   */
  async callToolOnce(name: string, args: Record<string, Json>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, false);
  }
}

/**
 * A CALLER THAT NEEDS TOOLS THE SERVER DOES NOT LIST REFUSES IN ONE LINE (kickoffs/s175 row 1(a)), so an unannounced
 * server change is named at connect instead of surfacing as `Unknown tool` deep in a command.
 */
export function needTools(session: McpSession, needed: string[], who: string): void {
  const offered = session.tools ?? [];
  const missing = needed.filter((name) => !offered.includes(name));
  if (missing.length === 0) return;
  refuse(
    `${who}: the Basic Memory server at ${session.endpoint} offers ${offered.length ? offered.join(', ') : 'no tool list Deskpost could read'}; ` +
      `Deskpost needs ${needed.join(', ')}, and it lacks ${missing.join(', ')}. Nothing was read or written.`,
  );
}

/**
 * THE SHARED-COLLECTION WRITERS, NOT YET ON 1.0, REFUSE AT ONCE (kickoffs/s175 row 2). Their own calls name the old tools,
 * which would fail mid-write after some reads; so on a `bm` server, and on one whose tool list could not be read (it may
 * be 1.0), they refuse before anything is sent. Only on `legacy` does a writer go on as before.
 */
export function refuseUnportedWriter(session: McpSession, operation: string): void {
  if (session.surface === 'legacy') return;
  if (session.surface === 'bm') {
    refuse(
      `${operation} is refused: this Basic Memory server offers the 1.0 tools (bm_*), and Deskpost's shared-collection writers are not ported to them ` +
        'yet (train item basic-memory-1-0, step 2). Nothing was written.',
    );
  }
  refuse(
    `${operation} is refused: the Basic Memory server's tool list could not be read, so it may be a 1.0 server, which Deskpost's shared-collection ` +
      'writers are not ported to yet (train item basic-memory-1-0, step 2). Nothing was written.',
  );
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

/**
 * A 1.0 REFUSAL BY ITS TYPED CODE (kickoffs/s175 row 1(e); 1.0's `refusals.py`): `isError: true` whose text is
 * `{"error": <code>, "message", "try_instead"?}` (asked for with `output_format: "json"`), or `<CODE>: <message>` in text.
 * Null for any other answer, a Pydantic validation error and `Unknown tool` among them.
 */
export function typedRefusal(response: unknown): { code: string; message: string } | null {
  const result = toolResult(response);
  if (field(result, 'isError') !== true) return null;
  const content = field(result, 'content');
  const block = Array.isArray(content) ? content.find((item) => field(item, 'type') === 'text') : undefined;
  const said = text(field(block, 'text')).trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(said) as unknown;
  } catch {
    parsed = null;
  }
  const code = field(parsed, 'error');
  if (typeof code === 'string' && /^[A-Z][A-Z_]+$/.test(code)) return { code, message: text(field(parsed, 'message')) };
  const plain = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(said);
  return plain ? { code: plain[1]!, message: plain[2]! } : null;
}

/** The text a refused read is named by: the typed code and message when there is one, else what the server said. */
function refusalText(response: unknown): string {
  const typed = typedRefusal(response);
  return (typed ? `${typed.code}: ${typed.message}` : JSON.stringify(field(toolResult(response), 'content') ?? null)).substring(0, 300);
}

/** How a Basic Memory write was refused, by the form the refusal took (kickoffs/s121 row 7). */
export type WriteRefusalForm = 'rpc-error' | 'is-error' | 'note-already-exists' | 'error-field' | 'conflict' | 'edit-failed' | 'error-heading' | 'outcome-unknown' | 'typed-refusal';

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
 *
 * 1.0's TYPED REFUSALS ONTO TODAY'S FORMS (kickoffs/s175 row 1(e), STANDING ANSWER 4): `ALREADY_EXISTS` is
 * `note-already-exists` and `REVISION_CONFLICT` is `conflict`, as before; `OUTCOME_UNKNOWN` is `outcome-unknown`, which
 * `sendWrite` treats as a dropped session (judged by readback, never resent); any other code is `typed-refusal`, named
 * with its code and message. A validation error (no typed code: Deskpost sent a bad call) stays `is-error`.
 */
export function judgeWriteResult(response: unknown): WriteVerdict {
  const refused = (form: WriteRefusalForm, detail: string): WriteVerdict => ({ refused: true, form, detail: detail.substring(0, 300) });
  if (isRpcError(response)) return refused('rpc-error', text(field(field(response, 'error'), 'message')));
  const result = toolResult(response);
  const content = field(result, 'content');
  const block = Array.isArray(content) ? content.find((item) => field(item, 'type') === 'text') : undefined;
  const firstText = text(field(block, 'text'));
  const typed = typedRefusal(response);
  if (typed !== null) {
    const said = `${typed.code}: ${typed.message}`;
    if (typed.code === 'ALREADY_EXISTS') return refused('note-already-exists', said);
    if (typed.code === 'REVISION_CONFLICT') return refused('conflict', said);
    if (typed.code === 'OUTCOME_UNKNOWN') return refused('outcome-unknown', said);
    return refused('typed-refusal', said);
  }
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
  // OUTCOME_UNKNOWN (1.0): the write may have landed, as after a dropped session; the caller's readback decides.
  if (verdict.form === 'outcome-unknown') return { dropped: true, response };
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
  // On 1.0 the same read is `bm_read` with `project`; a missing note is the typed NOT_FOUND (kickoffs/s175 row 1(c)).
  const bm = session.surface === 'bm';
  const identifier = relative.substring(0, relative.length - 3);
  const includeFrontmatter = options.includeFrontmatter ?? true;
  const response = await session.callTool(
    bm ? 'bm_read' : 'read_note',
    bm
      ? { identifier, include_frontmatter: includeFrontmatter, output_format: 'json', project: projectId }
      : { project_id: projectId, identifier, output_format: 'json', include_frontmatter: includeFrontmatter },
  );
  if (isRpcError(response)) refuse(`Read '${relative}' failed: ${text(field(field(response, 'error'), 'message'))}`);
  const result = toolResult(response);
  if (field(result, 'isError') === true) {
    if (typedRefusal(response)?.code === 'NOT_FOUND') return null;
    const detail = JSON.stringify(field(result, 'content') ?? null);
    if (!bm && /not found|does not exist|no note/i.test(detail)) return null;
    refuse(`Read '${relative}' was rejected: ${bm ? refusalText(response) : detail}`);
  }
  const record = bm ? structuredRecord(response) : field(field(result, 'structuredContent'), 'result');
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
  if (session.surface === 'bm') {
    // 1.0: the whole file, frontmatter included, by `bm_read` (kickoffs/s175 row 1(c)).
    const answer = await session.callTool('bm_read', { identifier: relative, include_frontmatter: true, output_format: 'json', project: projectId });
    if (isRpcError(answer)) refuse(`Read '${relative}' failed: ${text(field(field(answer, 'error'), 'message'))}`);
    if (field(toolResult(answer), 'isError') === true) {
      if (typedRefusal(answer)?.code === 'NOT_FOUND') return null;
      refuse(`Read '${relative}' was rejected: ${refusalText(answer)}`);
    }
    const content = field(structuredRecord(answer), 'content');
    if (typeof content !== 'string') refuse(`Read '${relative}' gave no text.`);
    return content;
  }
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
  checkPermalinkLine(body, permalink, permalink);
  return body;
}

/** The text's own `permalink:` line must be `permalink`, or `permalink` without the project's name in front; refused otherwise. */
function checkPermalinkLine(body: string, permalink: string, read: string): void {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  const line = front ? /^permalink:[ \t]*['"]?(.*?)['"]?[ \t]*$/m.exec(front[1]!) : null;
  const said = line ? line[1]! : '';
  if (!said || (said !== permalink && !(permalink.endsWith(`/${said}`) && !permalink.slice(0, -said.length - 1).includes('/')))) {
    refuse(`Read '${read}' answered a note whose permalink is '${said || '(none)'}', not the one listed, so it was not trusted.`);
  }
}

/**
 * ONE LISTED FILE ON 1.0 (kickoffs/s175 row 1(c), STANDING ANSWER 6): read by its `bm_list` node's `file_path` (no leading
 * slash) with `project` the project's NAME -- 1.0 does not strip the project's name from a `deskpost/...` permalink when
 * `project` is a UUID, so a read by permalink would not be found. Trusted only when the answer is for that very path and
 * its own `permalink:` line is the node's (with or without the project's name in front). Null only on NOT_FOUND; on a
 * server that is not `bm`, today's read by permalink. The optional callback receives the identifier only after the
 * answer's path, text and permalink are trusted, so a subsequent move can name the same file (kickoffs/c85 row 2).
 */
export async function readListedContent(session: McpSession, project: { id: string; name: string }, filePath: string, permalink: string, trustedIdentifier?: (identifier: string) => void): Promise<string | null> {
  if (session.surface !== 'bm') {
    const body = await readPermalinkContent(session, project.id, permalink);
    if (body !== null) trustedIdentifier?.(permalink);
    return body;
  }
  if (!permalink.trim()) refuse('A listed file came with no permalink, so it was not read and not trusted.');
  const response = await session.callTool('bm_read', { identifier: filePath, include_frontmatter: true, output_format: 'json', project: project.name });
  if (isRpcError(response)) refuse(`Read '${filePath}' failed: ${text(field(field(response, 'error'), 'message'))}`);
  if (field(toolResult(response), 'isError') === true) {
    if (typedRefusal(response)?.code === 'NOT_FOUND') return null;
    refuse(`Read '${filePath}' was rejected: ${refusalText(response)}`);
  }
  let identifier = filePath;
  let record = structuredRecord(response);
  let answered = text(field(record, 'file_path'));
  if (answered !== filePath) {
    // 1.0 STILL FOLLOWS A PERMALINK BEFORE A PATH (its `link_resolver.py`, for an identifier with no leading slash): a
    // file re-created at a moved note's old path is answered with the moved note. Asked once more by the node's own
    // permalink, with the project's name, it is the listed file -- trusted only if the answer says so.
    const again = await session.callTool('bm_read', { identifier: permalink, include_frontmatter: true, output_format: 'json', project: project.name });
    if (!isRpcError(again) && field(toolResult(again), 'isError') !== true) {
      record = structuredRecord(again);
      answered = text(field(record, 'file_path'));
      identifier = permalink;
    }
  }
  if (answered !== filePath) refuse(`Read '${filePath}' answered '${answered || '(no path)'}', not the file listed, so it was not trusted.`);
  const body = field(record, 'content');
  if (typeof body !== 'string') refuse(`Read '${filePath}' gave no text.`);
  checkPermalinkLine(body, permalink, filePath);
  trustedIdentifier?.(identifier);
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
    // On 1.0, `bm_move` into `<folder>/` keeps the file's name (kickoffs/s175 row 1(c)); `projectId` is whatever the caller
    // addresses the project by (the Postbox uses its trusted read's identifier and the project's name).
    const sent = session.surface === 'bm'
      ? await sendWrite(session, 'bm_move', { identifier, destination: `${destinationFolder}/`, output_format: 'json', project: projectId }, `Moving '${identifier}'`)
      : await sendWrite(session, 'move_note', { project_id: projectId, identifier, destination_folder: destinationFolder, output_format: 'json' }, `Moving '${identifier}'`);
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
    sent = session.surface === 'bm'
      ? await sendWrite(session, 'bm_write', { directory, title, content: body, note_type: 'note', overwrite, output_format: 'json', project: projectId }, `Write '${directory}/${title}'`)
      : await sendWrite(session, 'write_note', { project_id: projectId, directory, title, content: body, note_type: 'note', overwrite, output_format: 'json' }, `Write '${directory}/${title}'`);
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
  const bm = session.surface === 'bm';
  const response = await session.callTool(
    bm ? 'bm_read' : 'read_note',
    bm
      ? { identifier: requestedPath, include_frontmatter: true, output_format: 'json', project: projectId }
      : { project_id: projectId, identifier: requestedPath, output_format: 'json', include_frontmatter: true },
  );
  // On 1.0 an absent note is the typed NOT_FOUND, not an empty record (kickoffs/s175 STANDING ANSWER 4).
  if (bm && typedRefusal(response)?.code === 'NOT_FOUND') return 'absent';
  if (isRpcError(response) || field(toolResult(response), 'isError') === true) refuse(words.rejected);
  const record = structuredRecord(response);
  if (record === null || record === undefined) refuse(words.unreadable);
  if (!text(field(record, 'file_path')).trim() && !text(field(record, 'content')).trim()) return 'absent';
  if (text(field(record, 'file_path')) !== `${requestedPath}.md`) refuse(words.different);
  if (!text(field(record, 'content')).trim()) refuse(words.empty);
  return { file_path: text(field(record, 'file_path')), title: text(field(record, 'title')), content: text(field(record, 'content')) };
}
