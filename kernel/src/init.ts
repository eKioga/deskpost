/**
 * `library init`: make a folder a Library workspace, and tell this machine about it.
 *
 * The PowerShell original is `tools/Initialize-LibraryWorkspace.ps1`, and the four rules it spent
 * measurement on are carried here rather than re-decided:
 *
 *   THE SHAPE IS JUDGED BEFORE THE DIRECTORY IS CREATED. Creating first made a UNC path fail at
 *   mkdir with "the network path was not found" -- a true sentence about a machine, where the real
 *   fault is that a share can never be a workspace root on this design at all.
 *
 *   PREFLIGHT EVERY FILE BEFORE WRITING ANY OF THEM. The plan is built whole and refused whole. A
 *   run that rewrote CLAUDE.md and then found `.mcp.json` unmergeable would leave the reader half
 *   initialised with no record of which half.
 *
 *   ONE SECTION, BETWEEN MARKERS, AND MALFORMED IS A REFUSAL RATHER THAN A REPAIR. Every repair a
 *   managed section could attempt guesses at where the reader's own words stop, and guessing wrong
 *   silently deletes prose somebody wrote.
 *
 *   A MERGE NEVER REPLACES. A list merges by value, an object recurses, a leaf that disagrees is a
 *   conflict naming the key and both values; anything the tool does not name is not read and not
 *   written.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { psConvertToJson, psJsonString, type PsJsonValue } from './psjson.ts';
import { ensureDirectory, readTextIfPresent, writeAtomicText } from './fsx.ts';
import { createShelfBook } from './shelf.ts';
import { invokeShelfCatalogRender, shelfCatalogText } from './shelfcatalog.ts';
import { emptyMasterIndexText } from './notebook.ts';
import {
  markerField,
  markerPath,
  readMarker,
  readRegistry,
  HOST_FLAVOR,
  registryPath,
  rootFormName,
  toWorkspaceRoot,
} from './workspace.ts';
import { HOOK_VERB_FOR_SCRIPT } from './hookregistry.ts';
import { entryInvocation } from './machine.ts';
import { skillPlans } from './skillcopy.ts';

const SECTION_BEGIN = '<!-- library:begin -->';
const SECTION_END = '<!-- library:end -->';
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** The line `library init` stamps on a Codex binding it wrote. Ownership is read off the file. */
const CODEX_MANAGED_MARKER =
  '# Managed by `library init`. Re-run it after moving the program; edits here are replaced.';

/**
 * The four hooks a Codex session needs, with the matcher token each is bound to in the template. THREE
 * NAME THE READER (S38), and Codex offers it as `mcp__validated_book_reader__<tool>` -- a server's hyphens
 * spelled as underscores, measured S37 -- so each is handed that prefix, as `CodexBindings.ps1` does.
 */
const CODEX_READER_TOOL_PREFIX = 'mcp__' + 'validated-book-reader'.replace(/-/g, '_') + '__';
const CODEX_HOOK_TOKENS: { token: string; file: string; readerPrefix: boolean }[] = [
  { token: '__BASIC_MEMORY_GUARD_COMMAND__', file: 'Guard-BasicMemoryRead.ps1', readerPrefix: false },
  { token: '__SHELL_GUARD_COMMAND__', file: 'Guard-ShellShelfRead.ps1', readerPrefix: true },
  { token: '__PATCH_GUARD_COMMAND__', file: 'Guard-ShelfBookRead.ps1', readerPrefix: true },
  { token: '__DESK_CONTEXT_COMMAND__', file: 'Get-VirtualDeskContext.ps1', readerPrefix: true },
];

export interface InitOptions {
  workspacePath: string;
  mcpUrl?: string;
  collectionId?: string;
  writable?: boolean;
  registryRoot?: string;
  programRoot: string;
  /** The program root registrations name, when it is not yet the one the program is read from (planLibraryInit). */
  registerAs?: string;
}

interface FilePlan {
  path: string;
  name: string;
  action: string;
  content: string | null;
}

interface PlanResult {
  action: string;
  content: string | null;
  reason: string | null;
}

// --- the marker ---------------------------------------------------------------------------------

/**
 * The version the workspace was initialised by, read from the canonical package manifest rather
 * than kept as a second literal here. 'unknown' when the package is incomplete: a program whose
 * package is broken can still initialise a workspace and should say so in the marker.
 */
function programVersion(programRoot: string): string {
  const manifest = path.join(programRoot, '.codex-plugin', 'plugin.json');
  const text = readTextIfPresent(manifest);
  if (text === null) return 'unknown';
  try {
    const document = JSON.parse(text) as Record<string, unknown>;
    const version = 'version' in document ? String(document['version']) : '';
    return version.trim() ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The six fields init owns, and then EVERY OTHER FIELD THE MARKER ALREADY HAD, unchanged and in its order
 * (PLAN-basic-memory.md step 2): a Library's `connections` record, and whatever a later program writes there, is
 * not init's to drop. Until 1.1 the marker was rewritten from the six alone.
 *
 * THE BACKEND IS NO LONGER DERIVED FROM AN ENDPOINT (ADR-0050): it is kept as the workspace has it, and a new
 * Library's is `local`. A local Library's endpoint is a connection, recorded under `connections.basic_memory`.
 */
function newMarkerContent(
  fields: { id: string; programVersion: string; collectionId: string; backend: string; writable: boolean; created: string },
  existing: Record<string, unknown> | null,
  connection: Record<string, PsJsonValue> | null,
): Record<string, PsJsonValue> {
  const owned: Record<string, PsJsonValue> = {
    id: fields.id,
    program_version: fields.programVersion,
    collection_id: fields.collectionId,
    backend: fields.backend,
    writable: fields.writable,
    created: fields.created,
  };
  const marker: Record<string, PsJsonValue> = { ...owned };
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (!(key in owned)) marker[key] = value as PsJsonValue;
  }
  if (connection !== null) {
    const connections = marker['connections'];
    const others = connections !== null && typeof connections === 'object' && !Array.isArray(connections) ? { ...(connections as Record<string, PsJsonValue>) } : {};
    const previous = others['basic_memory'];
    const kept = previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? (previous as Record<string, PsJsonValue>) : {};
    // A URL given again keeps what set-up chose for it; a new URL starts a connection of its own.
    const sameServer = String(kept['url'] ?? '') === String(connection['url']);
    others['basic_memory'] = {
      url: connection['url']!,
      collection_id: String(connection['collection_id'] ?? '') || (sameServer ? String(kept['collection_id'] ?? '') : ''),
      collection_name: sameServer ? String(kept['collection_name'] ?? '') : '',
      storage: sameServer ? String(kept['storage'] ?? '') : '',
    };
    marker['connections'] = others;
  }
  return marker;
}

/** The `o` round-trip format PowerShell stamps `created` with, to the same seven fractional digits. */
function roundTripNow(): string {
  const now = new Date();
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  const local =
    `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}T` +
    `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.` +
    `${pad(now.getMilliseconds(), 3)}0000`;
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${local}${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

function readDeploymentState(file: string): string {
  const text = readTextIfPresent(file);
  return text === null ? '' : text.trim();
}

// --- the managed section ------------------------------------------------------------------------

export function managedSectionPlan(filePath: string, body: string): PlanResult {
  const block = SECTION_BEGIN + '\n' + body.replace(/\s+$/, '') + '\n' + SECTION_END;

  if (!fs.existsSync(filePath)) {
    return { action: 'create', content: block + '\n', reason: null };
  }

  const text = readTextIfPresent(filePath) ?? '';
  const begins = countOccurrences(text, SECTION_BEGIN);
  const ends = countOccurrences(text, SECTION_END);

  if (begins === 0 && ends === 0) {
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    return { action: 'append', content: text + separator + block + '\n', reason: null };
  }

  if (begins !== 1 || ends !== 1) {
    return {
      action: 'refuse',
      content: null,
      reason:
        `${filePath} carries ${begins} '${SECTION_BEGIN}' marker(s) and ${ends} ` +
        `'${SECTION_END}' marker(s). A managed section needs exactly one of each, and which of ` +
        'these encloses the managed text cannot be established without guessing at where your own ' +
        'writing stops. Repair the markers by hand, or remove them and re-run.',
    };
  }

  const beginAt = text.indexOf(SECTION_BEGIN);
  const endAt = text.indexOf(SECTION_END);
  if (endAt < beginAt) {
    return {
      action: 'refuse',
      content: null,
      reason:
        `${filePath} has '${SECTION_END}' before '${SECTION_BEGIN}', so the managed section ` +
        'has no inside. Repair the markers by hand, or remove them and re-run.',
    };
  }

  const rebuilt = text.substring(0, beginAt) + block + text.substring(endAt + SECTION_END.length);
  if (rebuilt === text) return { action: 'unchanged', content: text, reason: null };
  return { action: 'replace', content: rebuilt, reason: null };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

// --- the merge ----------------------------------------------------------------------------------

interface MergeResult {
  value: unknown;
  changed: boolean;
  conflicts: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every leaf the tool wants to set is compared with what is there: absent means set it, equal means
 * leave it and report nothing changed, different means REFUSE naming the key, both values and the
 * remedy. Conflicts are COLLECTED rather than thrown on the first, so a reader with three of them
 * is told about three instead of finding them one run at a time.
 */
export function mergeLibraryJsonValue(existing: unknown, desired: unknown, keyPath: string): MergeResult {
  if (existing === null || existing === undefined) {
    return { value: desired, changed: true, conflicts: [] };
  }

  if (isPlainObject(desired)) {
    if (!isPlainObject(existing)) {
      return {
        value: existing,
        changed: false,
        conflicts: [`${keyPath} holds a value where the Library needs an object`],
      };
    }
    const merged: Record<string, unknown> = { ...existing };
    const conflicts: string[] = [];
    let changed = false;
    for (const key of Object.keys(desired)) {
      const child = mergeLibraryJsonValue(
        Object.prototype.hasOwnProperty.call(merged, key) ? merged[key] : null,
        desired[key],
        `${keyPath}.${key}`,
      );
      conflicts.push(...child.conflicts);
      if (child.changed) {
        merged[key] = child.value;
        changed = true;
      }
    }
    return { value: merged, changed, conflicts };
  }

  if (Array.isArray(desired)) {
    if (!Array.isArray(existing)) {
      return {
        value: existing,
        changed: false,
        conflicts: [`${keyPath} holds a value where the Library needs a list`],
      };
    }
    // A list is merged by VALUE and never replaced: the permission allowlist is a set, and a
    // reader's own entries are theirs.
    const merged = [...existing];
    let changed = false;
    for (const item of desired) {
      if (merged.some((present) => present === item)) continue;
      merged.push(item);
      changed = true;
    }
    return { value: merged, changed, conflicts: [] };
  }

  if (existing === desired) return { value: existing, changed: false, conflicts: [] };
  return {
    value: existing,
    changed: false,
    conflicts: [`${keyPath} is '${String(existing)}' where the Library needs '${String(desired)}'`],
  };
}

function readJsonFileOrRefusal(
  filePath: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = readTextIfPresent(filePath);
  if (text === null || !text.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      reason: `${filePath} is not readable JSON, so the Library's entries cannot be merged into it without replacing what is there.`,
    };
  }
}

function jsonMergePlan(filePath: string, desired: Record<string, unknown>, releaseOwned?: (existing: unknown) => unknown): PlanResult {
  const read = readJsonFileOrRefusal(filePath);
  if (!read.ok) return { action: 'refuse', content: null, reason: read.reason };

  const result = mergeLibraryJsonValue(releaseOwned ? releaseOwned(read.value) : read.value, desired, path.basename(filePath));
  if (result.conflicts.length) {
    return {
      action: 'refuse',
      content: null,
      reason:
        `${filePath} cannot be merged: ${result.conflicts.join('; ')}` +
        '. Reconcile those entries by hand and re-run; nothing has been written.',
    };
  }
  if (!result.changed) return { action: 'unchanged', content: null, reason: null };
  return { action: 'merge', content: psConvertToJson(result.value as PsJsonValue) + '\n', reason: null };
}

// --- what the workspace is given ------------------------------------------------------------------

/**
 * The permission entries a workspace needs so the reader's tools do not raise a prompt on every
 * read, DERIVED FROM THE PROGRAM'S OWN SETTINGS and never spelled out here: a tool added to the
 * reader reaches a newly initialised workspace by the same edit that makes the gate pass.
 *
 * An empty result is not an error -- a packaged install supplies the server through the plugin
 * under a harness-composed prefix, and there is nothing here to copy.
 */
export function desiredPermissionAllowlist(programRoot: string): string[] {
  const text = readTextIfPresent(path.join(programRoot, '.claude', 'settings.json'));
  if (text === null) return [];
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isPlainObject(document) || !isPlainObject(document['permissions'])) return [];
  const allow = (document['permissions'] as Record<string, unknown>)['allow'];
  if (!Array.isArray(allow)) return [];
  return allow
    .map((entry) => String(entry))
    .filter((entry) => entry.startsWith('mcp__validated-book-reader__'))
    .sort();
}

// --- on macOS and Linux: the binary (S42) --------------------------------------------------------------

/**
 * A POSIX HOST HAS NO POWERSHELL, so every registration below names the compiled kernel instead (S42, the
 * reader's ruling). Measured in a clean Ubuntu 24.04 distro before it was written: `init` registered ten
 * `powershell.exe` Claude hooks, a `powershell.exe` reader and four `powershell.exe` Codex hooks, none of
 * which could start -- and a Claude hook that cannot start does not block, so the workspace was unguarded.
 * No PowerShell oracle runs there; kernel self-test section 21 is this branch's judge.
 */
const POSIX_BINDINGS = HOST_FLAVOR === 'posix';

/** `<program>/bin/library`, forward-slashed as every path init writes. */
function kernelBinary(programRoot: string): string {
  return path.join(programRoot, 'bin', 'library').replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * `.mcp.json` with the Library's OWN adapter entry taken out, so a compiled kernel's reader replaces it rather than
 * meeting it as a conflict (S46). An entry is the Library's when it is `powershell.exe` running the program's
 * `.claude/adapters/Validated-BookReader.ps1` -- what an earlier release's init wrote. Anything else under the same
 * name is someone's own, and the merge still refuses it.
 */
function withoutLibraryAdapterEntry(existing: unknown): unknown {
  if (!isPlainObject(existing) || !isPlainObject(existing['mcpServers'])) return existing;
  const servers = existing['mcpServers'] as Record<string, unknown>;
  const entry = servers['validated-book-reader'];
  if (!isPlainObject(entry) || String(entry['command'] ?? '').toLowerCase() !== 'powershell.exe' || !Array.isArray(entry['args'])) return existing;
  const ours = (entry['args'] as unknown[]).some((arg) => /(^|\/)\.claude\/adapters\/validated-bookreader\.ps1$/i.test(String(arg).replace(/\\/g, '/')));
  if (!ours) return existing;
  const rest: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(servers)) if (name !== 'validated-book-reader') rest[name] = value;
  return { ...existing, mcpServers: rest };
}

/**
 * WHICH READER A WORKSPACE IS GIVEN (S46, ADR-0044). The PowerShell adapter reads Books and Hubs from Basic
 * Memory only, so a workspace attached to its LOCAL collection that is handed the adapter can open a seat and
 * never read its own Project: S7 in Windows Sandbox, a Claude session's first Project read refused "Virtual Desk
 * configuration is missing .library-project". So the kernel serves the reader wherever it can -- on a POSIX host,
 * which has no PowerShell, and on Windows for a local collection when this program is a compiled release, whose
 * binary is there to name. A Basic Memory workspace on Windows keeps the adapter, and so does a kernel run from
 * source, which has no binary to register.
 */
function kernelServesReader(programRoot: string | undefined, mcpUrl: string): boolean {
  if (POSIX_BINDINGS) return true;
  if (!programRoot || mcpUrl.trim()) return false;
  return fs.existsSync(path.join(programRoot, 'bin', 'library.exe'));
}

/**
 * WHICH HOOKS A WORKSPACE IS GIVEN (S48, the reader's ruling, ADR-0046). The kernel's own verbs wherever it can
 * name itself: on a POSIX host always, and on Windows when this program is a compiled release, whose
 * `bin/library.exe` is there to name. Until S48 Windows registered the guard scripts even from a release, so ADR-0045's
 * rewrite -- which lives in the kernel's hook verbs -- never ran on the default route, and S7's closed-Book denial in
 * Windows Sandbox named tools/Set-VirtualDesk.ps1. A kernel run from source has no binary and keeps the scripts.
 */
function kernelRegistersHooks(programRoot: string): boolean {
  return POSIX_BINDINGS || fs.existsSync(path.join(programRoot, 'bin', 'library.exe'));
}

function binaryHookCommand(programRoot: string, verb: string, readerToolPrefix: string): string {
  const command = `"${kernelBinary(programRoot)}" hook ${verb}`;
  return readerToolPrefix ? `${command} --reader-tool-prefix ${readerToolPrefix}` : command;
}

/**
 * A Claude registration of a ported hook. On POSIX the quoted shell form, which `sh` runs. On Windows EXEC FORM,
 * `bin/library.exe` with the verb as `args`, spawned without a shell: with no Git Bash Claude Code runs a shell-form
 * hook through PowerShell, where a quoted path is a string and runs nothing (S46, measured in Windows Sandbox with
 * claude 2.1.282; the plugin's Windows render, tools/PluginPackage.ps1, for the same reason).
 */
function claudeKernelHook(programRoot: string, verb: string): Record<string, unknown> {
  if (POSIX_BINDINGS) return { type: 'command', command: binaryHookCommand(programRoot, verb, '') };
  return { type: 'command', command: `${kernelBinary(programRoot)}.exe`, args: ['hook', verb] };
}

/**
 * The program's own registrations, each hook the kernel has ported re-spelled as its verb. Each it has not -- the
 * playbook, the search-hit reminder, the compaction and seat-start hooks, all optional -- is left out on POSIX rather
 * than registered as a command that cannot start, and kept on Windows, which has the PowerShell to run it (S48).
 * Matchers, timeouts and messages are kept.
 */
function kernelHookRegistration(hooks: unknown, programRoot: string): Record<string, unknown> | null {
  if (!isPlainObject(hooks)) return null;
  const out: Record<string, unknown> = {};
  for (const eventName of Object.keys(hooks)) {
    const blocks = hooks[eventName];
    const kept: Record<string, unknown>[] = [];
    for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
      if (!isPlainObject(block) || !Array.isArray(block['hooks'])) continue;
      const entries: Record<string, unknown>[] = [];
      for (const entry of block['hooks']) {
        const text = hookEntryText(entry).toLowerCase();
        const script = Object.keys(HOOK_VERB_FOR_SCRIPT).find((name) => text.includes(name.toLowerCase()));
        if (!isPlainObject(entry)) continue;
        if (!script) {
          if (!POSIX_BINDINGS) entries.push(toProgramRootedValue(entry, programRoot) as Record<string, unknown>);
          continue;
        }
        const rewritten: Record<string, unknown> = claudeKernelHook(programRoot, HOOK_VERB_FOR_SCRIPT[script]!);
        for (const key of ['timeout', 'statusMessage']) if (key in entry) rewritten[key] = entry[key];
        entries.push(rewritten);
      }
      if (!entries.length) continue;
      const rebuilt: Record<string, unknown> = {};
      if ('matcher' in block) rebuilt['matcher'] = block['matcher'];
      rebuilt['hooks'] = entries;
      kept.push(rebuilt);
    }
    if (kept.length) out[eventName] = kept;
  }
  return Object.keys(out).length ? out : null;
}

function desiredMcpServers(adapterPath: string, stateDirectory?: string, programRoot?: string, kernelReader: boolean = POSIX_BINDINGS): Record<string, unknown> {
  if (kernelReader && programRoot) {
    const serve = ['mcp', 'serve'];
    if (stateDirectory && stateDirectory.trim()) serve.push('--state-directory', stateDirectory);
    return { mcpServers: { 'validated-book-reader': { command: kernelBinary(programRoot), args: serve } } };
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', adapterPath];
  if (stateDirectory && stateDirectory.trim()) args.push('-StateDirectory', stateDirectory);
  return {
    mcpServers: {
      'validated-book-reader': {
        command: 'powershell.exe',
        args,
      },
    },
  };
}

/**
 * The program's own hook registrations with `${CLAUDE_PROJECT_DIR}` resolved to the program root,
 * so they can be read from a session whose project directory is the WORKSPACE and not the program.
 * Forward slashes on purpose: the program's own settings spell the rest of the path that way.
 */
function toProgramRootedValue(value: unknown, programRoot: string): unknown {
  const rooted = programRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.split('${CLAUDE_PROJECT_DIR}').join(rooted);
  if (Array.isArray(value)) return value.map((item) => toProgramRootedValue(item, programRoot));
  if (isPlainObject(value)) {
    const map: Record<string, unknown> = {};
    for (const key of Object.keys(value)) map[key] = toProgramRootedValue(value[key], programRoot);
    return map;
  }
  return value;
}

export function desiredHookRegistration(programRoot: string, render: string = programRoot): unknown {
  const text = readTextIfPresent(path.join(programRoot, '.claude', 'settings.json'));
  if (text === null) return null;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(document) || !('hooks' in document) || document['hooks'] === null) return null;
  if (kernelRegistersHooks(programRoot)) return kernelHookRegistration(document['hooks'], render);
  return toProgramRootedValue(document['hooks'], render);
}

/**
 * Who wrote the hook block that is already there: `absent`, `library` or `foreign`, with the entries
 * that make it foreign named so the refusal can name them too.
 */
function hookOwnership(existingHooks: unknown, hookDirectory: string): { kind: string; foreign: string[] } {
  if (existingHooks === null || existingHooks === undefined) return { kind: 'absent', foreign: [] };
  const ours = hookDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  const foreign: string[] = [];
  let entries = 0;
  if (!isPlainObject(existingHooks)) return { kind: 'absent', foreign: [] };
  for (const eventName of Object.keys(existingHooks)) {
    const blocks = existingHooks[eventName];
    for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
      if (!isPlainObject(block) || !Array.isArray(block['hooks'])) continue;
      for (const entry of block['hooks']) {
        if (!entry) continue;
        entries += 1;
        const text = hookEntryText(entry).replace(/\\/g, '/');
        // THE INVOCATION TOO, UNQUOTED (#11): a single-quoted render of a path holding `'` spells it `''` in the text.
        const invocation = entryInvocation(entry);
        const invoked = invocation === null ? '' : [invocation.program, ...invocation.args].join(' ').replace(/\\/g, '/');
        if (!text.includes(ours) && !invoked.includes(ours)) foreign.push(`${eventName}: ${text}`);
      }
    }
  }
  if (!entries) return { kind: 'absent', foreign: [] };
  if (foreign.length) return { kind: 'foreign', foreign };
  return { kind: 'library', foreign: [] };
}

/** A hook entry's path arrives through `command` in one layout and through `args` in the other. */
function hookEntryText(entry: unknown): string {
  if (!isPlainObject(entry)) return String(entry);
  const parts: string[] = [];
  if (typeof entry['command'] === 'string') parts.push(entry['command']);
  if (Array.isArray(entry['args'])) parts.push(...entry['args'].map((item) => String(item)));
  return parts.join(' ');
}

/**
 * ONE PLAN FOR ONE FILE, and the caller decides which facts belong in which file. The allowlist is
 * portable text and belongs in the tracked `.claude/settings.json`; the hook block is ABSOLUTE
 * PATHS INTO THIS PROGRAM, which is a machine-local value, and belongs in `settings.local.json`.
 */
export function workspaceSettingsPlan(options: {
  filePath: string;
  desiredAllow?: string[];
  desiredHooks?: unknown;
  hookDirectory: string;
  removeOwnedHooks?: boolean;
}): PlanResult {
  const allow = options.desiredAllow ?? [];
  const read = readJsonFileOrRefusal(options.filePath);
  if (!read.ok) return { action: 'refuse', content: null, reason: read.reason };

  let value: unknown = read.value;
  let changed = false;

  if (allow.length) {
    const merged = mergeLibraryJsonValue(
      read.value,
      { permissions: { allow } },
      path.basename(options.filePath),
    );
    if (merged.conflicts.length) {
      return {
        action: 'refuse',
        content: null,
        reason:
          `${options.filePath} cannot be merged: ${merged.conflicts.join('; ')}` +
          '. Reconcile those entries by hand and re-run; nothing has been written.',
      };
    }
    value = merged.value;
    if (merged.changed) changed = true;
  }

  const map: Record<string, unknown> = isPlainObject(value) ? { ...value } : {};

  // THE MIGRATION HALF, AND WITHOUT IT THE MOVE IS NOT A MOVE. A block `library init` wrote into
  // the tracked file before the amendment LEAVES; a block the reader wrote is theirs and stays.
  if (options.removeOwnedHooks && 'hooks' in map) {
    if (hookOwnership(map['hooks'], options.hookDirectory).kind === 'library') {
      delete map['hooks'];
      changed = true;
    }
  }

  if (options.desiredHooks !== null && options.desiredHooks !== undefined) {
    const existingHooks = 'hooks' in map ? map['hooks'] : null;
    const ownership = hookOwnership(existingHooks, options.hookDirectory);
    if (ownership.kind === 'foreign') {
      return {
        action: 'refuse',
        content: null,
        reason:
          `${options.filePath} already registers hooks the Library did not write (` +
          `${ownership.foreign.join('; ')}), so its hook block cannot be replaced ` +
          'without discarding them. Move those entries to .claude/settings.json, or ' +
          'remove them, and re-run; nothing has been written.',
      };
    }
    // Compared through ONE serializer, so a block this tool wrote on a previous run reads as
    // unchanged rather than being rewritten byte-identically on every init.
    const desiredText = psConvertToJson(options.desiredHooks as PsJsonValue);
    const existingText =
      existingHooks === null || existingHooks === undefined
        ? ''
        : psConvertToJson(existingHooks as PsJsonValue);
    if (desiredText !== existingText) {
      map['hooks'] = options.desiredHooks;
      changed = true;
    }
  }

  if (!changed) return { action: 'unchanged', content: null, reason: null };
  return { action: 'merge', content: psConvertToJson(map as PsJsonValue) + '\n', reason: null };
}

// --- the same guards, in the other harness --------------------------------------------------------

function expandCodexToken(text: string, token: string, replacement: string, expected: number): string {
  const count = countOccurrences(text, token);
  if (count !== expected) {
    throw new Error(`Template token '${token}' must appear exactly ${expected} time(s); found ${count}.`);
  }
  return text.split(token).join(replacement);
}

function codexGuardCommand(scriptPath: string, readerToolPrefix: string): string {
  const command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '"';
  return readerToolPrefix ? `${command} -ReaderToolPrefix ${readerToolPrefix}` : command;
}

/** A PowerShell single-quoted string literal: nothing inside expands, and `'` is doubled. */
export function powerShellLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The script a binding names (under `hookDirectory`), required present where the program is read (`readDirectory`). */
function codexHookScriptPath(hookDirectory: string, fileName: string, readDirectory: string = hookDirectory): string {
  const full = path.join(hookDirectory, fileName).replace(/\\/g, '/');
  const read = path.join(readDirectory, fileName);
  if (!fs.existsSync(read)) {
    throw new Error(`Required Library hook is missing, so a Codex binding naming it would fail open: ${read.replace(/\\/g, '/')}`);
  }
  return full;
}

export function newCodexHooksDocument(templatePath: string, hookDirectory: string, programRoot?: string, resources: string | undefined = programRoot): string {
  if (!fs.existsSync(templatePath)) throw new Error(`Required Codex template is missing: ${templatePath}`);
  let text = fs.readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '');
  for (const entry of CODEX_HOOK_TOKENS) {
    const prefix = entry.readerPrefix ? CODEX_READER_TOOL_PREFIX : '';
    // On Windows Codex runs a hook through `powershell.exe -Command`, where a line opening with a quoted path is a
    // string expression and runs nothing, so a release's command carries `& ` (measured on codex-cli 0.153.4, S46;
    // ConvertTo-WindowsCodexHooks in tools/PluginPackage.ps1 renders the plugin's the same way).
    // A SINGLE-QUOTED LITERAL, NOT `& "<path>"` (PLAN-install-onboarding.md #11): inside double quotes PowerShell
    // expands `$`, so a program under `D:\$work` ran a path that does not exist. In single quotes nothing expands, and
    // a `'` (`C:\Users\O'Neil`) is written doubled. 1.0's double-quoted render is still recognised as Deskpost's.
    const command =
      programRoot && kernelRegistersHooks(resources ?? programRoot)
        ? POSIX_BINDINGS
          ? binaryHookCommand(programRoot, HOOK_VERB_FOR_SCRIPT[entry.file]!, prefix)
          : `& ${powerShellLiteral(kernelBinary(programRoot))} hook ${HOOK_VERB_FOR_SCRIPT[entry.file]!}` + (prefix ? ` --reader-tool-prefix ${prefix}` : '')
        : codexGuardCommand(codexHookScriptPath(hookDirectory, entry.file, resources !== undefined && programRoot !== undefined ? path.join(resources, '.claude', 'hooks') : hookDirectory), prefix);
    // Twice: `command` and `commandWindows` carry the same invocation, and a template that lost one
    // of them would leave Codex reading the other on one platform only.
    text = expandCodexToken(text, '"' + entry.token + '"', psJsonString(command), 2);
  }
  if (/__[A-Z0-9_]+__/.test(text)) throw new Error('The rendered Codex hooks still contain a template token.');
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The rendered Codex hooks are not valid JSON, so they were not written: ${(error as Error).message}`,
    );
  }
  return text;
}

function codexTomlString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function codexTomlArray(values: string[]): string {
  return '[' + values.map(codexTomlString).join(', ') + ']';
}

export function newCodexWorkspaceConfigDocument(
  templatePath: string,
  adapterPath: string,
  stateDirectory?: string,
  programRoot?: string,
  kernelReader: boolean = POSIX_BINDINGS,
  adapterReadPath: string = adapterPath,
): string {
  if (!fs.existsSync(templatePath)) throw new Error(`Required Codex template is missing: ${templatePath}`);
  if (kernelReader && programRoot) {
    const serve = ['mcp', 'serve'];
    if (stateDirectory && stateDirectory.trim()) serve.push('--state-directory', stateDirectory.replace(/\\/g, '/'));
    let posix = fs.readFileSync(templatePath, 'utf8').replace(/^﻿/, '');
    posix = expandCodexToken(posix, 'command = "powershell.exe"', 'command = ' + codexTomlString(kernelBinary(programRoot)), 1);
    posix = expandCodexToken(posix, '"__VALIDATED_READER_ARGS__"', codexTomlArray(serve), 1);
    if (/__[A-Z0-9_]+__/.test(posix)) throw new Error('The rendered Codex config still contains a template token.');
    return CODEX_MANAGED_MARKER + '\n' + posix;
  }
  if (!fs.existsSync(adapterReadPath)) {
    throw new Error(
      `The validated reader adapter is missing, so a Codex binding naming it would start no server: ${adapterPath}`,
    );
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', adapterPath.replace(/\\/g, '/')];
  if (stateDirectory && stateDirectory.trim()) args.push('-StateDirectory', stateDirectory.replace(/\\/g, '/'));
  let text = fs.readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '');
  text = expandCodexToken(text, '"__VALIDATED_READER_ARGS__"', codexTomlArray(args), 1);
  if (/__[A-Z0-9_]+__/.test(text)) throw new Error('The rendered Codex config still contains a template token.');
  // The ownership stamp goes on the OUTPUT rather than in the template: it is a statement about who
  // wrote this copy, not about what the document says.
  return CODEX_MANAGED_MARKER + '\n' + text;
}

function codexHooksPlan(filePath: string, desired: string, hookDirectory: string): PlanResult {
  if (!fs.existsSync(filePath)) return { action: 'created', content: desired, reason: null };
  const text = readTextIfPresent(filePath) ?? '';
  if (text === desired) return { action: 'unchanged', content: null, reason: null };
  let existing: unknown;
  try {
    existing = JSON.parse(text);
  } catch {
    return {
      action: 'refuse',
      content: null,
      reason: `${filePath} is not readable JSON, so the Library's Codex hooks cannot replace it without discarding what is there.`,
    };
  }
  const existingHooks = isPlainObject(existing) && 'hooks' in existing ? existing['hooks'] : null;
  const ownership = hookOwnership(existingHooks, hookDirectory);
  if (ownership.kind === 'foreign') {
    return {
      action: 'refuse',
      content: null,
      reason:
        `${filePath} already registers Codex hooks the Library did not write (` +
        `${ownership.foreign.join('; ')}), so it cannot be replaced without discarding them. ` +
        'Move them into $CODEX_HOME/hooks.json, which Codex loads alongside this file, or remove ' +
        'them, and re-run; nothing has been written.',
    };
  }
  return { action: 'merge', content: desired, reason: null };
}

function codexConfigPlan(filePath: string, desired: string): PlanResult {
  if (!fs.existsSync(filePath)) return { action: 'created', content: desired, reason: null };
  const text = readTextIfPresent(filePath) ?? '';
  if (text === desired) return { action: 'unchanged', content: null, reason: null };
  if (!text.includes(CODEX_MANAGED_MARKER)) {
    return {
      action: 'refuse',
      content: null,
      reason:
        `${filePath} was not written by \`library init\` -- it carries no managed marker -- so its ` +
        'Codex server registration cannot be replaced without discarding what is there. Move it ' +
        'aside and re-run; nothing has been written.',
    };
  }
  return { action: 'merge', content: desired, reason: null };
}

// --- the registry ----------------------------------------------------------------------------------

/**
 * Add or refresh this workspace's line in the machine registry, REWRITTEN WHOLE AND MERGED BY PATH,
 * case-insensitively, because Windows paths are: registering `d:\ws` where `D:\WS` is already listed
 * must update that line rather than add a second one every containment test then matches twice.
 */
export function registerWorkspace(workspace: string, id: string, root?: string, makeDefault = false): { path: string; action: string } {
  const file = registryPath(root);
  const entries = readRegistry(root);
  // EVERY FIELD INIT DOES NOT SET IS KEPT (PLAN-install-onboarding.md step 0, measurement 1): 1.0 rewrote the file
  // from `{id, path}` alone, so a Library's `default: true`, or anything a later program writes, was silently dropped.
  // The rows are read as written, and each keeps its own fields; the document keeps its other top-level fields.
  const raw = fs.existsSync(file) ? (JSON.parse(readTextIfPresent(file)?.trim() || '{}') as Record<string, unknown>) : {};
  const rows = Array.isArray(raw['workspaces']) ? (raw['workspaces'] as unknown[]) : [];
  const out: PsJsonValue[] = [];
  let action = 'added';
  let kept: Record<string, PsJsonValue> = {};
  for (const entry of entries) {
    const row = (rows.find((candidate) => isPlainObject(candidate) && toWorkspaceRoot(String(candidate['path'])) === entry.root) ?? {}) as Record<string, PsJsonValue>;
    if (entry.root.toLowerCase() === workspace.toLowerCase()) {
      action = entry.id === id ? 'unchanged' : 'updated';
      kept = row;
      continue;
    }
    const { default: _wasDefault, ...rest } = row;
    out.push(makeDefault ? { ...rest, id: entry.id, path: entry.root } : { ...row, id: entry.id, path: entry.root });
  }
  const { id: _id, path: _path, ...others } = kept;
  // THE DEFAULT LIBRARY (step 5a) is one entry's `default: true`. Setting it moves it here; nothing else moves it.
  out.push(makeDefault ? { id, path: workspace, ...others, default: true } : { id, path: workspace, ...others });
  const document: Record<string, PsJsonValue> = { version: 1 };
  for (const [key, value] of Object.entries(raw)) if (key !== 'version' && key !== 'workspaces') document[key] = value as PsJsonValue;
  document['workspaces'] = out;
  ensureDirectory(path.dirname(file));
  writeAtomicText(file, psConvertToJson(document) + '\n');
  return { path: file, action };
}

// --- the run -----------------------------------------------------------------------------------------

/**
 * A local collection's three starting catalogs, byte for byte Get-LocalCollectionCatalogs's: the two
 * files that mark a collection root and the archived Projects catalog the raw-batch owner reads.
 */
const WORKSPACE_FOLDERS = ['notebook', 'shelf', 'raw', 'output', 'internal'];

/**
 * THE TWO BOOKS THE PROGRAM'S OWN INSTRUCTIONS NAME (S42, the reader's ruling), as
 * `$script:StandardShelfBooks` in Initialize-LibraryWorkspace.ps1 carries them and says why: without them
 * `library init` and then `library doctor` failed three checks in every fresh workspace.
 */
interface StandardShelfBook {
  slug: string;
  title: string;
  summary: string;
  topics: string;
  origin: string;
}

const STANDARD_SHELF_BOOKS: StandardShelfBook[] = [
  {
    slug: 'holding',
    title: 'Holding Shelf',
    summary:
      'Findings set aside during a session for later review, one page per note. Survives a Notebook reset; closed by default so unreviewed material never crowds a new session.',
    topics: 'capture, holding, unreviewed',
    origin: "created by library init as the Library's capture surface",
  },
  {
    slug: 'reports',
    title: 'Report Inbox',
    summary:
      "Bugs and tooling gaps an agent found in the Library itself, kept for triage. A page here is one agent's claim about the Library, written while the context was live -- verify it against the code before acting on it.",
    topics: 'capture, reports',
    origin: "created by library init as the Library's report channel",
  },
];

// `## Open a Book` IS THE ONE HEADING A FRESH CATALOG CARRIES (PLAN-basic-memory.md step 1, Fable #3): the heading
// a publish with no --collection files under. Every other heading is inserted the first time a line needs it.
export const LOCAL_COLLECTION_CATALOGS: ReadonlyArray<{ relative: string[]; text: string }> = [
  { relative: ['books', 'README.md'], text: "# Books\n\nThe Books in this workspace's local collection.\n\n## Open a Book\n" },
  {
    relative: ['projects', 'README.md'],
    text:
      "# Active Projects\n\nProjects are living context in this workspace's local collection. Open one when you need its current notes.\n\n## Projects\n",
  },
  {
    relative: ['archive', 'projects', 'README.md'],
    text: '# Archived Projects\n\nProjects retired from the active catalog. An archived Hub stays searchable.\n\n## Projects\n',
  },
];

/**
 * EVERYTHING `library init` WOULD DO, AS A PLAN, WITH NOTHING WRITTEN (PLAN-install-onboarding.md step 2's pass 4, round
 * 2's #1). Until 1.1 init created the Library folder before it had judged anything; now not even that. The plan lists
 * every file with its content now and the content it will hold, and `applyLibraryInit` writes exactly that.
 *
 * TWO PROGRAM ROOTS, WHEN AN INSTALLER ASKS (step 2). `programRoot` is where the program's own files are READ: templates,
 * the hooks it ships, whether its binary is there -- the staged release. `registerAs` is what every registration NAMES:
 * the install's `current`, which is not switched yet when the plan is made. Without `registerAs` they are one root.
 */
export function planLibraryInit(options: InitOptions): LibraryInitPlan {
  if (!options.workspacePath || !options.workspacePath.trim()) {
    throw new Error('A workspace folder is required.');
  }
  const workspace = toWorkspaceRoot(options.workspacePath);
  if (!workspace) {
    throw new Error(
      `'${options.workspacePath}' is not ${rootFormName()}, so it cannot be a Library workspace: a workspace root has to be a place every tool on this machine can name the same way.`,
    );
  }

  const programRoot = options.programRoot;
  const render = options.registerAs && options.registerAs.trim() ? path.resolve(options.registerAs) : programRoot;
  const existingMarker = readMarker(workspace);
  const alreadyInitialised = existingMarker !== null;

  let id = alreadyInitialised ? markerField(existingMarker, 'id') : randomGuid();
  let created = alreadyInitialised ? markerField(existingMarker, 'created') : roundTripNow();
  if (!id.trim()) id = randomGuid();
  if (!created.trim()) created = roundTripNow();

  // THE BACKEND IS KEPT, AND A NEW LIBRARY IS LOCAL (PLAN-basic-memory.md step 2, the S51 friction log's F21;
  // ADR-0050). Until 1.1 the backend was re-derived on every run from whether an endpoint was configured, so an
  // `--mcp-url`, or a `.claude/.library-mcp-url` another tool had written, silently converted a local Library to
  // a Basic Memory backend on its next init -- a repair, an upgrade -- after which its own collection refused.
  // A workspace that already IS Basic Memory stays so, and reads its endpoint as before; a local one never reads
  // the three `.claude/.library-*` files, and an `--mcp-url` given it is recorded as its CONNECTION.
  const backend = alreadyInitialised && markerField(existingMarker, 'backend') === 'basic-memory' ? 'basic-memory' : 'local';

  // An endpoint or collection id already written for this workspace is kept unless a new one is
  // passed: init is not a chance to silently detach a workspace from its collection.
  let resolvedMcpUrl = '';
  let resolvedCollectionId = '';
  if (backend === 'basic-memory') {
    resolvedMcpUrl = options.mcpUrl ?? '';
    if (!resolvedMcpUrl.trim()) {
      resolvedMcpUrl = readDeploymentState(path.join(workspace, '.claude', '.library-mcp-url'));
    }
    resolvedCollectionId = options.collectionId ?? '';
    if (!resolvedCollectionId.trim()) {
      resolvedCollectionId = readDeploymentState(path.join(workspace, '.claude', '.library-project'));
    }
  } else if (!(options.mcpUrl ?? '').trim()) {
    // With no endpoint, --collection-id is the Local collection's own id, as it always was.
    resolvedCollectionId = options.collectionId ?? '';
  }
  // THE MARKER'S OWN RECORD (S30, the Report Inbox's defect of 2026-09-22): a re-run with no
  // collection id emptied a workspace's only record of its collection. Fixed in both arms at once.
  if (!resolvedCollectionId.trim() && alreadyInitialised) {
    resolvedCollectionId = markerField(existingMarker, 'collection_id');
  }

  // A LOCAL LIBRARY'S CONNECTION, when init is handed one: recorded, not checked -- `library basic-memory setup`
  // is what checks a connection live, and says so in its answer.
  let connectionRecorded: Record<string, PsJsonValue> | null = null;
  if (backend === 'local' && (options.mcpUrl ?? '').trim()) {
    connectionRecorded = {
      url: options.mcpUrl!.trim(),
      collection_id: (options.collectionId ?? '').trim(),
      collection_name: '',
      storage: '',
    };
  }

  // THE LOCAL COLLECTION (ADR-0030; S30). Tools/Initialize-LibraryWorkspace.ps1 says why at length;
  // the rule is the same: no endpoint means <workspace>/collection/, laid out once and never
  // rewritten, its id in collection/.library/collection.json, and an id file naming another
  // collection than this init names refuses rather than retargeting the workspace.
  const collectionPlans: FilePlan[] = [];
  let collectionRefusal: string | null = null;
  const isProgramRootForCollection = fs.existsSync(path.join(workspace, 'tools', 'BookRootSchema.ps1'));
  if (backend === 'local' && !isProgramRootForCollection) {
    const collectionRoot = path.join(workspace, 'collection');
    const idFile = path.join(collectionRoot, '.library', 'collection.json');
    if (fs.existsSync(idFile)) {
      let recordedId = '';
      try {
        const record = JSON.parse(fs.readFileSync(idFile, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
        recordedId = typeof record['id'] === 'string' ? record['id'] : '';
      } catch {
        recordedId = '';
      }
      if (!recordedId.trim()) {
        collectionRefusal = `${idFile} carries no readable id, so the local collection's identity cannot be confirmed. Repair or remove it and re-run; nothing has been written.`;
      } else if (resolvedCollectionId.trim() && recordedId !== resolvedCollectionId) {
        collectionRefusal = `${idFile} names collection ${recordedId}, and this init names ${resolvedCollectionId}. A local collection's id is persistent, so init will not retarget the workspace; nothing has been written.`;
      } else {
        resolvedCollectionId = recordedId;
      }
      collectionPlans.push({ path: idFile, name: 'collection/.library/collection.json', action: 'unchanged', content: null });
    } else {
      if (!resolvedCollectionId.trim()) resolvedCollectionId = randomGuid();
      const record = psConvertToJson({ schema: 1, id: resolvedCollectionId, created: roundTripNow() }) + '\n';
      collectionPlans.push({ path: idFile, name: 'collection/.library/collection.json', action: 'created', content: record });
    }
    for (const catalog of LOCAL_COLLECTION_CATALOGS) {
      const target = path.join(collectionRoot, ...catalog.relative);
      collectionPlans.push({
        path: target,
        name: 'collection/' + catalog.relative.join('/'),
        action: fs.existsSync(target) ? 'unchanged' : 'created',
        content: catalog.text,
      });
    }
  }

  // `--writable` absent keeps what the marker says: init preserves what it does not set.
  const writable = options.writable === true || (alreadyInitialised && existingMarker!['writable'] === true);
  const markerContent = newMarkerContent(
    { id, programVersion: programVersion(programRoot), collectionId: resolvedCollectionId, backend, writable, created },
    existingMarker,
    connectionRecorded,
  );

  const plans: FilePlan[] = [];
  const refusals: string[] = [];
  const skillLeft: string[] = [];
  const skillFiles: { path: string; name: string; action: string; content: string | null }[] = [];
  const body = fs
    .readFileSync(path.join(programRoot, 'templates', 'workspace-instructions.md'), 'utf8')
    .replace(/^\uFEFF/, '');

  // AN UN-SPLIT CHECKOUT'S INSTRUCTION FILES BELONG TO THE PROGRAM, NOT TO THE WORKSPACE. Where the
  // two are still one directory, CLAUDE.md is a tracked source file written by the program's
  // authors; appending the reader template to it duplicates the Librarian's opening paragraph and
  // dirties the working tree.
  const isProgramRoot = fs.existsSync(path.join(workspace, 'tools', 'BookRootSchema.ps1'));
  for (const name of INSTRUCTION_FILES) {
    const target = path.join(workspace, name);
    if (isProgramRoot) {
      plans.push({ path: target, name, action: 'skipped-program-file', content: null });
      continue;
    }
    const plan = managedSectionPlan(target, body);
    if (plan.action === 'refuse') {
      refusals.push(plan.reason!);
      continue;
    }
    plans.push({ path: target, name, action: plan.action, content: plan.content });
  }

  // The adapter is only in a DIRECT install; a plugin brings its own server and needs no entry. Two
  // direct layouts: in the workspace it binds on its own anchor, and in the PROGRAM it must be told
  // which workspace it is serving, because the program is not a workspace at all.
  const adapter = path.join(workspace, '.claude', 'adapters', 'Validated-BookReader.ps1');
  const programAdapter = path.join(programRoot, '.claude', 'adapters', 'Validated-BookReader.ps1');
  const renderAdapter = path.join(render, '.claude', 'adapters', 'Validated-BookReader.ps1');
  let desiredServers: Record<string, unknown> | null = null;
  // A Basic Memory backend keeps the adapter; the question is the backend's, not whether its endpoint file is there.
  const kernelReader = kernelServesReader(programRoot, backend === 'basic-memory' ? resolvedMcpUrl || 'basic-memory' : '');
  if (fs.existsSync(adapter)) {
    desiredServers = desiredMcpServers('.claude/adapters/Validated-BookReader.ps1');
  } else if (!isProgramRoot && (kernelReader || fs.existsSync(programAdapter))) {
    desiredServers = desiredMcpServers(
      renderAdapter.replace(/\\/g, '/'),
      path.join(workspace, '.claude').replace(/\\/g, '/'),
      render,
      kernelReader,
    );
  }
  if (desiredServers !== null) {
    const mcpPath = path.join(workspace, '.mcp.json');
    const mcpPlan = jsonMergePlan(mcpPath, desiredServers, kernelReader ? withoutLibraryAdapterEntry : undefined);
    if (mcpPlan.action === 'refuse') refusals.push(mcpPlan.reason!);
    else plans.push({ path: mcpPath, name: '.mcp.json', action: mcpPlan.action, content: mcpPlan.content });
  }

  if (!isProgramRoot) {
    // WHAT MAKES A HOOK THE LIBRARY'S: a path into this program. Where the kernel registers itself that is the
    // program root, so a block an earlier init wrote with `.ps1` paths is still recognised as ours and replaced
    // (S42 on POSIX; S48 for a compiled Windows release, over what v0.2.1 wrote).
    const hookDirectory = kernelRegistersHooks(programRoot) ? render : path.join(render, '.claude', 'hooks');
    const settingsPath = path.join(workspace, '.claude', 'settings.json');
    const settingsPlan = workspaceSettingsPlan({
      filePath: settingsPath,
      desiredAllow: desiredPermissionAllowlist(programRoot),
      hookDirectory,
      removeOwnedHooks: true,
    });
    if (settingsPlan.action === 'refuse') refusals.push(settingsPlan.reason!);
    else {
      plans.push({
        path: settingsPath,
        name: '.claude/settings.json',
        action: settingsPlan.action,
        content: settingsPlan.content,
      });
    }

    const desiredHooks = desiredHookRegistration(programRoot, render);
    if (desiredHooks !== null) {
      const localPath = path.join(workspace, '.claude', 'settings.local.json');
      const localPlan = workspaceSettingsPlan({ filePath: localPath, desiredHooks, hookDirectory });
      if (localPlan.action === 'refuse') refusals.push(localPlan.reason!);
      else {
        plans.push({
          path: localPath,
          name: '.claude/settings.local.json',
          action: localPlan.action,
          content: localPlan.content,
        });
      }
    }

    const codexDirectory = path.join(programRoot, '.codex');
    const codexHooksTemplate = path.join(codexDirectory, 'hooks.template.json');
    const codexConfigTemplate = path.join(codexDirectory, 'workspace-config.template.toml');
    if (fs.existsSync(codexHooksTemplate)) {
      const codexHooksPath = path.join(workspace, '.codex', 'hooks.json');
      const plan = codexHooksPlan(
        codexHooksPath,
        newCodexHooksDocument(codexHooksTemplate, hookDirectory, render, programRoot),
        hookDirectory,
      );
      if (plan.action === 'refuse') refusals.push(plan.reason!);
      else plans.push({ path: codexHooksPath, name: '.codex/hooks.json', action: plan.action, content: plan.content });
    }
    if (fs.existsSync(codexConfigTemplate)) {
      let codexAdapter: string | null = null;
      let codexStateDirectory: string | undefined;
      if (fs.existsSync(adapter)) codexAdapter = adapter;
      else if (kernelReader || fs.existsSync(programAdapter)) {
        codexAdapter = renderAdapter;
        codexStateDirectory = path.join(workspace, '.claude');
      }
      if (codexAdapter !== null) {
        const codexConfigPath = path.join(workspace, '.codex', 'config.toml');
        const plan = codexConfigPlan(
          codexConfigPath,
          newCodexWorkspaceConfigDocument(codexConfigTemplate, codexAdapter, codexStateDirectory, render, kernelReader, codexAdapter === renderAdapter ? programAdapter : codexAdapter),
        );
        if (plan.action === 'refuse') refusals.push(plan.reason!);
        else {
          plans.push({
            path: codexConfigPath,
            name: '.codex/config.toml',
            action: plan.action,
            content: plan.content,
          });
        }
      }
    }

    // THE SKILL THE INSTRUCTIONS NAME, OWNED FILE BY FILE (PLAN-assistant-onboarding.md step 7; skillcopy.ts).
    // Reported under result.skill, not result.files: the PowerShell initializer (the oracle) writes no Skill, and a
    // list of its own keeps every other file's entry where the acceptance matrix compares it.
    const skill = skillPlans(workspace, programRoot);
    if (skill.refusal !== null) refusals.push(skill.refusal);
    skillFiles.push(...skill.plans);
    skillLeft.push(...skill.left);
  }

  plans.push(...collectionPlans);
  if (collectionRefusal !== null) refusals.push(collectionRefusal);

  // The standard Books are judged with every other file, so a husk -- or a Shelf that cannot be rendered,
  // which would throw halfway through the writes below -- refuses the whole run.
  const bookPlans: { book: StandardShelfBook; action: 'created' | 'unchanged' }[] = [];
  if (!isProgramRoot) {
    for (const book of STANDARD_SHELF_BOOKS) {
      const bookRoot = path.join(workspace, 'shelf', book.slug);
      if (!fs.existsSync(bookRoot)) {
        bookPlans.push({ book, action: 'created' });
        continue;
      }
      const wiki = path.join(bookRoot, 'wiki');
      if (fs.existsSync(wiki) && fs.statSync(wiki).isDirectory()) {
        bookPlans.push({ book, action: 'unchanged' });
        continue;
      }
      refusals.push(
        `shelf/${book.slug} exists but has no wiki/, so it is a husk rather than a Book, and init will not adopt it as the ${book.title}. ` +
          `Remove shelf/${book.slug} if nothing needs it and re-run; nothing has been written.`,
      );
    }
    const needsRender = bookPlans.some((plan) => plan.action === 'created') || !fs.existsSync(path.join(workspace, 'shelf', '_catalog.md'));
    const shelfDirectory = path.join(workspace, 'shelf');
    if (needsRender && fs.existsSync(shelfDirectory) && fs.statSync(shelfDirectory).isDirectory()) {
      try {
        shelfCatalogText(workspace, programRoot);
      } catch (error) {
        refusals.push(`the Shelf cannot be rendered, so init cannot add its Books to the catalog: ${(error as Error).message} Nothing has been written.`);
      }
    }
  }

  if (refusals.length) {
    throw new Error('library init refused and wrote nothing: ' + refusals.join(' | '));
  }

  // --- FROM HERE ON NOTHING IS WRITTEN: every write init would make is planned (PLAN-install-onboarding.md step 4) ---
  const marker = markerPath(workspace);
  const writes: PlannedWrite[] = [plannedWrite(workspace, marker, psConvertToJson(markerContent) + '\n')];
  const directories: string[] = [];
  const files: { file: string; action: string }[] = [];
  for (const plan of plans) {
    files.push({ file: plan.name, action: plan.action });
    if (plan.action === 'unchanged' || plan.action === 'skipped-program-file') continue;
    writes.push(plannedWrite(workspace, plan.path, plan.content ?? ''));
  }
  for (const plan of skillFiles) if (plan.action === 'created' || plan.action === 'updated') writes.push(plannedWrite(workspace, plan.path, plan.content ?? ''));

  // THE FOLDERS THE WORKSPACE INSTRUCTIONS NAME (S30), as Initialize-LibraryWorkspace.ps1 now makes
  // them: without notebook/, "what's on my desk?" refused in a freshly initialised workspace.
  if (!isProgramRoot) {
    for (const folder of WORKSPACE_FOLDERS) directories.push(path.join(workspace, folder));

    // THE BOOKS, THROUGH THE WRITER THAT CREATES ANY EMPTY BOOK (S42), which renders the catalog as it creates each.
    // PLANNED BY RUNNING THAT WRITER ON A SCRATCH COPY OF THE SHELF and reading back what it wrote, so a planned Book
    // is byte for byte what `library shelf new` makes, and the Library itself is only read.
    const catalogMissing = !fs.existsSync(path.join(workspace, 'shelf', '_catalog.md'));
    const creating = bookPlans.filter((plan) => plan.action === 'created');
    if (creating.length || catalogMissing) {
      const shelfWrites = scratchShelfWrites(workspace, programRoot, (scratch) => {
        for (const { book } of creating) {
          createShelfBook({ workspace: scratch, programRoot, slug: book.slug, title: book.title, summary: book.summary, topics: book.topics, capture: true, origin: book.origin });
        }
        if (!creating.length) invokeShelfCatalogRender({ workspace: scratch, programRoot });
      });
      writes.push(...shelfWrites.writes);
      directories.push(...shelfWrites.directories);
    }
    for (const plan of bookPlans) files.push({ file: `shelf/${plan.book.slug}`, action: plan.action });
    files.push({ file: 'shelf/_catalog.md', action: creating.length || catalogMissing ? 'rendered' : 'unchanged' });

    // AN EMPTY MASTER INDEX ONLY OVER AN EMPTY NOTEBOOK: its text is the one the layout reader counts as
    // no material, so a fresh workspace stays fresh; a Notebook with anything in it keeps its own renderer.
    const notebook = path.join(workspace, 'notebook');
    const masterIndex = path.join(notebook, '_master-index.md');
    let masterAction = 'unchanged';
    if (!fs.existsSync(masterIndex)) {
      if (fs.existsSync(notebook) && fs.readdirSync(notebook).length) masterAction = 'skipped-notebook-has-content';
      else {
        writes.push(plannedWrite(workspace, masterIndex, emptyMasterIndexText()));
        masterAction = 'created';
      }
    }
    files.push({ file: 'notebook/_master-index.md', action: masterAction });
  }

  return {
    schema: 1,
    operation: 'Plan a Library',
    workspace,
    id,
    registry_root: options.registryRoot ?? null,
    program_root: render,
    directories: directories.filter((directory) => !fs.existsSync(directory)),
    // A FILE ALREADY HOLDING WHAT IT WOULD BE GIVEN IS NOT A WRITE: a re-run of init rewrites nothing.
    writes: writes.filter((write) => write.old_sha256 !== write.new_sha256),
    result: {
      status: alreadyInitialised ? 'already_initialized' : 'initialized',
      workspace,
      id,
      marker,
      backend: String(markerContent['backend']),
      writable,
      files,
      ...(skillFiles.length || skillLeft.length ? { skill: { files: skillFiles.map((plan) => ({ file: plan.name, action: plan.action })), left: skillLeft } as unknown as PsJsonValue } : {}),
      ...(connectionRecorded !== null
        ? {
            connection: connectionRecorded as PsJsonValue,
            connection_note:
              "The endpoint is recorded as this local Library's Basic Memory connection, in its marker, and not checked: run " +
              '`library basic-memory setup` to check it live and choose its collection from the server. The Library itself stays local.',
          }
        : {}),
    },
  };
}

/** One file a plan writes: where, its content now (null when absent), and what it will hold. */
export interface PlannedWrite {
  /** Relative to the Library, forward-slashed. */
  relative: string;
  path: string;
  old_sha256: string | null;
  /** The previous text, kept so an undo can restore it (step 2's recovery); null for a file the plan creates. */
  old_text: string | null;
  new_sha256: string;
  content: string;
}

export interface LibraryInitPlan {
  schema: 1;
  operation: 'Plan a Library';
  workspace: string;
  id: string;
  registry_root: string | null;
  program_root: string;
  directories: string[];
  writes: PlannedWrite[];
  result: Record<string, PsJsonValue>;
}

function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentSha(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? sha256Of(fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

function plannedWrite(workspace: string, file: string, content: string): PlannedWrite {
  const old = currentSha(file);
  return {
    relative: path.relative(workspace, file).replace(/\\/g, '/'),
    path: file,
    old_sha256: old,
    old_text: old === null ? null : fs.readFileSync(file, 'utf8'),
    new_sha256: sha256Of(Buffer.from(content, 'utf8')),
    content,
  };
}

/**
 * THE SHELF WRITERS, RUN ON A SCRATCH COPY. The Library's `shelf/` is copied to a temporary folder, the writers run
 * there, and every file that is new or different (and every folder that is new) becomes a planned write against the
 * Library. The render lock the writers take lives under the scratch copy's `internal/`, which is not planned.
 */
function scratchShelfWrites(workspace: string, programRoot: string, run: (scratch: string) => void): { writes: PlannedWrite[]; directories: string[] } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-plan-'));
  try {
    const realShelf = path.join(workspace, 'shelf');
    if (fs.existsSync(realShelf)) fs.cpSync(realShelf, path.join(scratch, 'shelf'), { recursive: true });
    else fs.mkdirSync(path.join(scratch, 'shelf'));
    run(scratch);
    const writes: PlannedWrite[] = [];
    const directories: string[] = [];
    const walk = (relative: string): void => {
      for (const item of fs.readdirSync(path.join(scratch, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const child = path.join(relative, item.name);
        const real = path.join(workspace, child);
        if (item.isDirectory()) {
          if (!fs.existsSync(real)) directories.push(real);
          walk(child);
          continue;
        }
        const content = fs.readFileSync(path.join(scratch, child), 'utf8');
        const planned = plannedWrite(workspace, real, content);
        if (planned.old_sha256 !== planned.new_sha256) writes.push(planned);
      }
    };
    walk('shelf');
    return { writes, directories };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * THE THREE-STATE RULE (PLAN-install-onboarding.md step 2's Place and step 6's Apply). Each planned file is compared
 * with the plan: still its old state, so it is written; already its new state, so it is done (a crash after the write);
 * anything else, so the whole apply refuses, naming every such file, BEFORE anything is written.
 */
export function libraryPlanConflicts(plan: LibraryInitPlan): string[] {
  const conflicts: string[] = [];
  for (const write of plan.writes) {
    const now = currentSha(write.path);
    if (now === write.old_sha256 || now === write.new_sha256) continue;
    conflicts.push(`${write.relative} (${now === null ? 'removed' : 'changed'} since it was planned)`);
  }
  return conflicts;
}

/** Write exactly what a plan lists, under the three-state rule, then register the Library. Re-running it finishes it. */
export function applyLibraryInit(plan: LibraryInitPlan, options: { makeDefault?: boolean } = {}): Record<string, unknown> {
  const conflicts = libraryPlanConflicts(plan);
  if (conflicts.length) {
    throw new Error(
      `the Library at ${plan.workspace} changed after it was planned, so nothing was written: ${conflicts.join('; ')}. ` +
        'Plan it again to see what would change now.',
    );
  }
  ensureDirectory(plan.workspace);
  for (const directory of plan.directories) ensureDirectory(directory);
  let written = 0;
  for (const write of plan.writes) {
    if (currentSha(write.path) === write.new_sha256) continue;
    ensureDirectory(path.dirname(write.path));
    writeAtomicText(write.path, write.content);
    written += 1;
  }
  // THE REGISTRY IS MERGED WHEN THE PLAN IS APPLIED, NOT FROZEN WITH IT: another Library registered meanwhile is not a
  // conflict, and registering is the same answer however often it runs.
  const registration = registerWorkspace(plan.workspace, plan.id, plan.registry_root ?? undefined, options.makeDefault === true);
  const result = plan.result;
  return {
    status: result['status'],
    workspace: result['workspace'],
    id: result['id'],
    marker: result['marker'],
    backend: result['backend'],
    writable: result['writable'],
    registry: registration.path,
    registration: registration.action,
    files: result['files'],
    ...('skill' in result ? { skill: result['skill'] } : {}),
    ...('connection' in result ? { connection: result['connection'], connection_note: result['connection_note'] } : {}),
    ...(written !== plan.writes.length ? { resumed: plan.writes.length - written } : {}),
  };
}

/** `library init`: plan the Library, then apply the plan. One code path, so the installer's planner is the same init. */
export function invokeLibraryWorkspaceInit(options: InitOptions): Record<string, unknown> {
  const plan = planLibraryInit(options);
  // THE FIRST LIBRARY IS THE DEFAULT, however it was made (post-build inspection #6): `setup` marked one and `init` did
  // not, so a Library made with `init` was never the one bare `deskpost` opened from anywhere. Never replaces a default.
  return applyLibraryInit(plan, { makeDefault: !hasLiveDefaultLibrary(plan.registry_root ?? undefined) });
}

/** Whether the registry already marks a default Library that is still there. */
function hasLiveDefaultLibrary(root?: string): boolean {
  try {
    const document = JSON.parse(readTextIfPresent(registryPath(root))?.trim() || '{}') as { workspaces?: unknown };
    return (Array.isArray(document.workspaces) ? document.workspaces : []).some((row) => {
      if (!isPlainObject(row) || row['default'] !== true) return false;
      const root = toWorkspaceRoot(String(row['path'] ?? ''));
      return root !== null && fs.existsSync(path.join(root, '.library', 'workspace.json'));
    });
  } catch {
    return true;
  }
}

function randomGuid(): string {
  return (globalThis.crypto as Crypto).randomUUID();
}
