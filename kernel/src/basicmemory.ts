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

const PIN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BasicMemoryRefusal extends Error {}

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

/** `Resolve-LibraryMcpUrl` without its program-root fallback: the endpoint, or '' when none is configured. */
export function configuredMcpUrl(workspace: string): string {
  const fromEnvironment = (process.env['AI_LIBRARY_MCP_URL'] ?? '').trim();
  return fromEnvironment || readState(stateFile(workspace, '.library-mcp-url'));
}

/** The endpoint, or `Resolve-LibraryMcpUrl`'s own refusal, naming all three routes. */
export function resolveMcpUrl(workspace: string): string {
  const resolved = configuredMcpUrl(workspace);
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
    try {
      response = await fetch(this.url, { method: 'POST', headers, body: asciiJson(payload) });
      body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.substring(0, 4096)}`);
    } catch (error) {
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
      if (!retry || !this.sessionId || !/Session not found/.test((error as Error).message)) throw error;
      this.sessionId = null;
      await this.initialize();
      return await this.once(method, params, false);
    }
  }

  async callTool(name: string, args: Record<string, Json>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
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
  const response = await session.callTool('write_note', {
    project_id: projectId,
    directory,
    title,
    content: body,
    note_type: 'note',
    overwrite,
    output_format: 'json',
  });
  if (isRpcError(response) || field(toolResult(response), 'isError') === true) refuse(`Write '${directory}/${title}' was rejected.`);
  const written = field(field(toolResult(response), 'structuredContent'), 'result');
  if (text(field(written, 'action')) === 'conflict') {
    refuse(
      `Write '${directory}/${title}' was refused: a note already exists there, written by someone else since this run read ` +
        'the collection. Nothing was overwritten.',
    );
  }
  const record = await readExactOrNull(session, projectId, `${directory}/${title}.md`);
  if (record === null) refuse(`Write '${directory}/${title}.md' did not become readable.`);
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
