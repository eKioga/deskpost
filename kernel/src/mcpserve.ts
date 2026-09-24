/**
 * `library mcp serve`: the validated reader as a stdio MCP server -- `.claude/adapters/Validated-BookReader.ps1`'s
 * request loop (S36, S20's last offline piece). One JSON-RPC message per line in, one response per line out.
 *
 * THE TOOLS ARE `mcp call`'s, and one dispatch answers both (`answerReaderTool`), so a row that holds a tool
 * through `mcp call` holds it here. What this file adds is what only a long-running process has:
 *
 *   THE WORKSPACE IS BOUND ONCE, AT START, AND CHECKED ON EVERY CALL. A call naming another workspace is
 *   refused, and so is one made after the marker this server bound has gone or changed its id -- the
 *   workspace re-initialised under a server still answering for it. A conflict or an unresolvable workspace
 *   does not kill the server: it is refused at each call, where it names itself.
 *
 *   THE SEAT IS RESOLVED PER REQUEST, never cached: a binding written while this process runs is the seat
 *   its very next request serves (PLAN-seat-launch.md step 11).
 *
 *   A LAUNCH THAT WOULD LEAVE THE GUARDS UNREGISTERED IS SAID ON STDERR, which is the only channel a server
 *   has that is not the protocol. Stdout carries JSON-RPC and nothing else.
 *
 * THE PROTOCOL EDGES ARE THE ADAPTER'S, measured (S36): a method and a tool name match case-insensitively; a
 * line that does not parse, or a message with no id that is not a request this server answers, gets no
 * response; a request with an id and no method gets -32600; an unknown method with an id gets -32601.
 * `suggest_active_projects` answers since S38, against Basic Memory (`reader.ts`); a local-collection
 * workspace is refused by name, because the adapter it is compared with has no local counterpart.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { parseArguments } from './argv.ts';
import type { McpResult, ReaderArguments } from './reader.ts';
import { answerReaderTool, readerContext, readerEnvelope } from './reader.ts';
import { homeDirectory, markerField, readMarker, resolveWorkspace, toWorkspaceRoot } from './workspace.ts';
import { programRoot } from './programroot.ts';
import type { PsJsonValue } from './psjson.ts';
import { enabledClaudePluginHooks, HOOK_VERB_FOR_SCRIPT, hookEntryText, namesHook, RECOGNISES_HOOK_VERBS } from './hookregistry.ts';

const TOOLS: PsJsonValue[] = [
  { name: 'read_book_catalog', description: "Read the AI Library Book Catalog: the shared collection, the local Shelf, both, or the shared ARCHIVE. The adapter returns shared content only when the response is the exact canonical catalog record. discover_book_pages covers archived Books and labels every archived hit ARCHIVED, so this listing is the archive's own index rather than the only way to find one; each Discovery answer states which archives it searched.", inputSchema: { type: 'object', additionalProperties: false, properties: { location: { type: 'string', enum: ['shared', 'shelf', 'all', 'archive'], description: 'Which collection to list. Defaults to all. Use archive to list Books retired from the shared collection.' } } } },
  { name: 'read_open_book_page', description: 'Read one exact page from an open AI Library Book, shared or Shelf. The adapter rejects closed Books and any page whose canonical file path differs from the requested path.', inputSchema: { type: 'object', additionalProperties: false, required: ['slug', 'page'], properties: { slug: { type: 'string', description: 'Open Book slug.' }, page: { type: 'string', description: 'Canonical page path below wiki/, without .md.' } } } },
  { name: 'read_project_catalog', description: 'Read the exact active or archived AI Library Project Catalog.', inputSchema: { type: 'object', additionalProperties: false, properties: { shelf: { type: 'string', enum: ['active', 'archive'], description: 'Project shelf. Defaults to active.' } } } },
  { name: 'suggest_active_projects', description: 'Search concise summaries of active AI Library Project Hubs using reader-provided words. Returns up to five ranked suggestions and never opens or changes a Project.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'Words describing the work or Project to find.' } } } },
  { name: 'read_open_project_page', description: 'Read one exact page from an open active or archived AI Library Project Hub.', inputSchema: { type: 'object', additionalProperties: false, required: ['slug', 'page'], properties: { slug: { type: 'string', description: 'Open Project slug.' }, page: { type: 'string', description: 'Canonical Project page path below the Project root, without .md. For example _project or research/Finding.' } } } },
  { name: 'read_open_project_briefing', description: "Give a short return briefing using an open Project Hub's explicit Connected knowledge and Connected tools sections, whether recorded on the Hub root or its companion connections page. It does not search, infer missing dependencies, or open Books.", inputSchema: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: { type: 'string', description: 'Open Project slug.' } } } },
  { name: 'search_open_books', description: 'Search the FULL TEXT of Shelf Books that are OPEN on the Desk, returning matching lines with the exact page path and line number that feed read_open_book_page. Closed Books are never searched -- use discover_book_pages for those. An open SHARED Book is named in the answer as out of scope rather than searched, because its pages arrive one network read at a time. Every answer reports what it could not read, what it skipped, and any cap that bound it. A matched line says the term occurs on that page; it is not a reading of the page.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'A literal term to look for in page text. Matching is literal, case-insensitive, and Unicode-normalised; regular expressions are not interpreted.' }, max_results: { type: 'integer', description: 'Maximum matching lines to return. Defaults to 50; the answer reports the total when it truncates.' } } } },
  { name: 'discover_book_pages', description: 'Find which Books and pages mention a term, across the local Shelf and the shared collection, from closed-readable metadata manifests only. Covers closed Books, opens nothing, reaches no network, and returns Book slug, canonical page path, the heading that matched, and the Book overlap status -- never page text. A hit licenses "shall I open it?", never an answer about what the page says. Every answer states its own coverage: which Books were searched, and any it could not read.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'A literal term to look for in Book titles, summaries, topics, reader-map links, page titles, and headings. Matching is literal and case-insensitive; regular expressions are not interpreted.' }, max_results: { type: 'integer', description: 'Maximum hits to return. Defaults to 50; the answer reports the total when it truncates.' } } } },
];

/** `ConvertTo-AsciiJson`: every character above U+007F escaped, so no console code page can bend a response. */
function asciiLine(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** A property, found case-insensitively as `$object.PSObject.Properties[$name]` finds it. */
function property(object: unknown, name: string): { found: boolean; value: unknown } {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return { found: false, value: undefined };
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(object as Record<string, unknown>)) if (key.toLowerCase() === lower) return { found: true, value };
  return { found: false, value: undefined };
}

/** `[string]$value`: what a required argument is compared as. */
function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return value.map(asString).join(' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// --- the launch check (Test-LaunchSettings) -----------------------------------------------------------------

const LAUNCH_REQUIRED = ['Guard-BasicMemoryRead.ps1', 'Guard-ShelfBookRead.ps1'];

/** `Get-RegisteredHookScript`: every `*.ps1` a hook's command or args names. */
function registeredHookScripts(settings: unknown): string[] {
  const names: string[] = [];
  const hooks = property(settings, 'hooks');
  if (!hooks.found || hooks.value === null || typeof hooks.value !== 'object') return names;
  for (const blocks of Object.values(hooks.value as Record<string, unknown>)) {
    for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
      const inner = property(block, 'hooks');
      if (!inner.found) continue;
      for (const hook of Array.isArray(inner.value) ? inner.value : [inner.value]) {
        if (hook === null || hook === undefined) continue;
        for (const fieldName of ['command', 'args']) {
          const value = property(hook, fieldName);
          if (!value.found) continue;
          for (const item of Array.isArray(value.value) ? value.value : [value.value]) {
            for (const match of asString(item).matchAll(/[^\\/]+\.ps1/g)) names.push(match[0]);
          }
        }
        // A hook spelled as the binary's verb (S42) stands for its script.
        if (RECOGNISES_HOOK_VERBS) {
          const text = hookEntryText(hook);
          for (const script of Object.keys(HOOK_VERB_FOR_SCRIPT)) if (!text.toLowerCase().includes(script.toLowerCase()) && namesHook(text, script)) names.push(script);
        }
      }
    }
  }
  return names;
}

/** `Test-LaunchSettings`: the faults a launch into this `.claude` owes the reader, on stderr. */
export function launchSettingsFaults(stateDirectory: string): string[] {
  const faults: string[] = [];
  try {
    const files = ['settings.json', 'settings.local.json'].filter((name) => {
      const file = path.join(stateDirectory, name);
      return fs.existsSync(file) && fs.statSync(file).isFile();
    });
    // THE ENABLED PLUGIN'S HOOKS ARE REGISTERED HOOKS (S42); the workspace is the state directory's parent.
    const plugin = enabledClaudePluginHooks(path.dirname(stateDirectory), homeDirectory());
    const pluginNames = plugin !== null && plugin.tree !== null ? registeredHookScripts(plugin.tree) : [];
    if (files.length === 0 && pluginNames.length === 0) return ['no .claude/settings.json or settings.local.json found'];
    const parsed = new Map<string, unknown>();
    for (const name of files) {
      const text = fs.readFileSync(path.join(stateDirectory, name), 'utf8').replace(/^﻿/, '');
      try {
        parsed.set(name, text.trim() ? (JSON.parse(text) as unknown) : null);
      } catch (error) {
        faults.push(`${name} is not valid JSON: ${(error as Error).message}`);
      }
    }
    if (faults.length) return faults;
    const registered = new Map<string, string[]>();
    for (const [name, tree] of parsed) registered.set(name, registeredHookScripts(tree));
    const effective = [...[...registered.values()].flat(), ...pluginNames].map((name) => name.toLowerCase());
    for (const hook of LAUNCH_REQUIRED) if (!effective.includes(hook.toLowerCase())) faults.push(`guard hook not registered: ${hook}`);
    if (parsed.has('settings.local.json') && property(parsed.get('settings.local.json'), 'hooks').found) {
      const local = (registered.get('settings.local.json') ?? []).map((name) => name.toLowerCase());
      const shadowed = LAUNCH_REQUIRED.filter((hook) => !local.includes(hook.toLowerCase()));
      if (shadowed.length) faults.push(`settings.local.json declares its own hooks block and does not register: ${shadowed.join(', ')}`);
    }
  } catch (error) {
    faults.push(`settings could not be checked: ${(error as Error).message}`);
  }
  return faults;
}

// --- the bound workspace ------------------------------------------------------------------------------------

interface Binding {
  workspace: string;
  stateDirectory: string;
  bound: string | null;
  hadMarker: boolean;
  id: string;
  refusal: string | null;
}

/** The binding `Set-AdapterWorkspaceBinding` records at start, and the refusal every call raises when there is none. */
function bindWorkspace(explicitWorkspace: string | undefined, explicitStateDirectory: string | undefined): Binding {
  let selected = explicitWorkspace ?? '';
  if (!selected.trim() && explicitStateDirectory && explicitStateDirectory.trim()) selected = path.dirname(explicitStateDirectory);
  let anchor = '';
  try {
    anchor = programRoot();
  } catch {
    anchor = '';
  }
  const resolution = resolveWorkspace({ explicit: selected, anchor });
  let workspace: string;
  let refusal: string | null = null;
  if (resolution.kind === 'resolved') workspace = resolution.workspace!;
  else {
    workspace = explicitStateDirectory && explicitStateDirectory.trim() ? path.dirname(explicitStateDirectory) : anchor;
    refusal =
      resolution.kind === 'conflict'
        ? `This reader is not bound to a workspace: ${resolution.reason ?? ''}`
        : 'This reader is not bound to a Library workspace, so no Book or Project can be open. Launch it from ' +
          'inside a workspace, set LIBRARY_WORKSPACE, or create one with `library init <folder>`.';
  }
  let marker: Record<string, unknown> | null = null;
  try {
    marker = readMarker(workspace);
  } catch {
    marker = null;
  }
  return {
    workspace,
    stateDirectory: explicitStateDirectory && explicitStateDirectory.trim() ? explicitStateDirectory : path.join(workspace, '.claude'),
    bound: toWorkspaceRoot(workspace),
    hadMarker: marker !== null,
    id: marker ? markerField(marker, 'id') : '',
    refusal,
  };
}

/** `Assert-BoundWorkspace`: another workspace named, or this one's identity gone or changed. */
function assertBoundWorkspace(binding: Binding, args: ReaderArguments): void {
  if (binding.refusal) throw new Error(binding.refusal);
  const named = args.optional('workspace');
  if (named !== null && named !== undefined && asString(named).trim()) {
    const requested = toWorkspaceRoot(asString(named));
    if (!requested || requested.toLowerCase() !== (binding.bound ?? '').toLowerCase()) {
      throw new Error(
        `this reader is bound to the workspace ${binding.bound ?? ''} for the whole of this session and ` +
          `cannot answer for '${asString(named)}'. Open a seat in that workspace and read the page there.`,
      );
    }
  }
  if (!binding.hadMarker) return;
  let marker: Record<string, unknown> | null;
  try {
    marker = readMarker(binding.bound ?? binding.workspace);
  } catch {
    throw new Error(`the workspace marker for ${binding.bound} is no longer readable, so this reader can no longer establish which workspace it is answering for.`);
  }
  if (marker === null) {
    throw new Error(
      `the workspace marker for ${binding.bound} has been removed since this reader started, so it ` +
        'can no longer establish what is open there. Restart the reader once the workspace is whole.',
    );
  }
  const current = markerField(marker, 'id');
  if (current !== binding.id) {
    throw new Error(
      `${binding.bound} has been re-initialised since this reader started -- it bound workspace ` +
        `'${binding.id}' and the marker now says '${current}'. Restart the reader to bind the new one.`,
    );
  }
}

// --- one message ----------------------------------------------------------------------------------------------

/** One inbound line, answered: a response line, or null for none. */
export async function answerLine(line: string, binding: Binding, seat: string | undefined): Promise<string | null> {
  let id: unknown = null;
  try {
    const request = JSON.parse(line) as unknown;
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('not a request');
    const idProperty = property(request, 'id');
    if (idProperty.found) id = idProperty.value;
    const methodProperty = property(request, 'method');
    // StrictMode's missing property: the oracle's `[string]$request.method` throws here, and its catch
    // answers -32600 when there is an id to answer.
    if (!methodProperty.found) throw new Error('no method');
    const method = asString(methodProperty.value).toLowerCase();
    if (method === 'initialize') {
      return asciiLine({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'AI Library Validated Book Reader', version: '0.1.0' } } });
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return asciiLine({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const params = property(request, 'params');
        const callParams = params.found ? params.value : null;
        const name = property(callParams, 'name');
        const callName = name.found ? asString(name.value) : '';
        const argumentsProperty = property(callParams, 'arguments');
        const callArguments = argumentsProperty.found ? argumentsProperty.value : null;
        const args: ReaderArguments = {
          required(argument) {
            const found = property(callArguments, argument);
            if (!found.found) throw new Error(`missing required parameter '${argument}'.`);
            if (found.value === null || found.value === undefined || !asString(found.value).trim()) throw new Error(`parameter '${argument}' must be a non-empty string.`);
            return asString(found.value);
          },
          optional(argument) {
            const found = property(callArguments, argument);
            return found.found ? found.value : null;
          },
        };
        // THE SEAT, THEN THE BOUND WORKSPACE, BEFORE ANY TOOL RUNS -- both per call, because both can change
        // under a server that is already running.
        const context = readerContext(binding.workspace, binding.stateDirectory, seat);
        assertBoundWorkspace(binding, args);
        const text = await answerReaderTool(context, callName, args);
        return asciiLine(readerEnvelope(id as PsJsonValue, text, false));
      } catch (error) {
        return asciiLine(readerEnvelope(id as PsJsonValue, `Book read rejected: ${(error as Error).message}`, true));
      }
    }
    return id === null || id === undefined ? null : asciiLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } });
  } catch {
    return id === null || id === undefined ? null : asciiLine({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request.' } });
  }
}

/** `library mcp serve [--workspace <p>] [--state-directory <d>] [--seat <s>]`: until stdin closes. */
export async function runMcpServe(argv: string[]): Promise<McpResult> {
  const parsed = parseArguments(argv, ['workspace', 'state-directory', 'seat']);
  const binding = bindWorkspace(parsed.options.get('workspace'), parsed.options.get('state-directory'));
  const faults = launchSettingsFaults(binding.stateDirectory);
  if (faults.length) {
    const lines = ['', '!!! LIBRARY GUARD WARNING ' + '!'.repeat(52), ...faults.map((fault) => `  - ${fault}`),
      '  The Virtual Desk guards may not be active. Closed Books and the Basic Memory',
      '  boundary are NOT being enforced. Repair the settings file and restart.', '!'.repeat(78), ''];
    process.stderr.write(lines.join('\n') + '\n');
  }
  // ONE AT A TIME, IN ORDER: a response is written before the next line is read, as the oracle's loop does.
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of reader) {
    const answer = await answerLine(line, binding, parsed.options.get('seat'));
    if (answer !== null) process.stdout.write(answer + '\n');
  }
  return { refusal: null, value: null, exitCode: 0 };
}
