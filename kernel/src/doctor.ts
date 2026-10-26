/**
 * `library doctor` -- every check that reads the READER'S material, with one result each.
 *
 * Ported from the workspace half of `tools/Invoke-LibraryChecks.ps1` (S17): exactly the checks it
 * registers through `Invoke-WorkspaceCheck`, which is how that runner declares that a check reads a
 * Shelf, a Notebook, output/, internal/ or the Desk rather than the program. `-WorkspaceOnly` is the
 * oracle's name for this subset.
 *
 * WHAT IS NOT HERE, AND WHY IT IS NOT A GAP. The runner's other hundred-odd checks scan THIS
 * PROGRAM's PowerShell source or run PowerShell test suites. Those are the development gate, they
 * change with the program checkout rather than with any workspace, and a kernel reporting "130
 * PowerShell sources scanned" would be lying about which program answered. The nine workspace checks
 * registered inside the runner's suite branch are suites too, and a doctor is not a test runner.
 *
 * SKIP AND FAIL ARE DIFFERENT ANSWERS. With no workspace attached every check reports `skipped`, with
 * the reason, and the run exits 0; a failed check exits 1 WITH its report, because the report is the
 * outcome and a non-zero exit is part of it rather than a crash.
 *
 * THE REPORT HAS NO `schema` FIELD, deliberately: the runner writes its summary with `ConvertTo-Json`
 * directly rather than through `Write-LibraryResult`, and this answers in the shape it answers in.
 */

import { postboxCache } from './postbox.ts';
import { codexHookHash } from './codexhooktrust.ts';
import { spawnSync } from 'node:child_process'; import { CODEX_HOOK_HASH_CHECKED, parseCodexVersion, compareVersions, codexSandboxSettings } from './codexversion.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { SKILL_LOCATIONS, skillInstallationStatus } from './skillcopy.ts';
import { argumentTable } from './verbs.ts';
import { fileDoctorFindings } from './doctorreport.ts';
import { releaseTuple } from './programroot.ts';
import { homeDirectory, readMarker, resolveWorkspace } from './workspace.ts';
import { readVaultConnection, type VaultConnection } from './vault.ts';
import { enterBookLock, enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { captureBookRows, readSeatRegistry, readSeatRetirementRecords, seatRegistryConsistency } from './desk.ts';
import { listOutstanding } from './intent.ts';
import { readSeatIdentityView } from './seatincarnation.ts';
import { METADATA_FIELDS, readSeatMetadata } from './seatmeta.ts';
import { readSeatHistory, seatHistoryState } from './seathistory.ts';
import { identityView, incarnationOf } from './seatincarnation.ts';
import { addedDirsStatus, isAtOrInside } from './seatdirs.ts';
import { deadNotebookLinks, NOTEBOOK_LINK_REPAIR } from './notebooklinks.ts';
import { INBOUND_KEY, readInboundSettings, userSettingsPath } from './seatinbound.ts';
import { shelfCatalogEntryInventory, shelfCatalogText } from './shelfcatalog.ts';
import { getStoredBookManifest } from './manifeststore.ts';
import { DEFAULT_GROWING_DAYS, DEFAULT_GROWING_PENDING, getShelfBook, parseGrowingAt, readUtf8, shelfCatalogPath, shelfCatalogSections, STANDARD_SHELF_BOOK_SLUGS } from './shelfbook.ts';
import { growingState, isThisLibrary, noteFrontmatter, shelfNotes } from './shelfnote.ts';
import {
  masterIndexDrift,
  scopeIndexDrift,
  NOTEBOOK_OWNERS_LOCK_ROOT,
  notebookOwnershipInventory,
  notebookResetTargets,
  notebookTopicInventory,
  readNotebookTopicOwners,
  readStrictUtf8,
  seatIncarnationStatus,
  setNotebookTopicOwner,
  writeNotebookTopicOwners,
  type OwnerRow,
} from './notebook.ts';
import { readNotebookLayout, seatNotebookRoots } from './notebooklayout.ts';
import { librariesServedByRoot, sameFolder } from './installs.ts';
import { asList, codexHookShapeFaults, enabledClaudePluginHooks, codexRegistrationProblems, claudeHookShapeFaults, hookRegistrationProblems, isObject, REQUIRED_HOOKS, type Json } from './hookregistry.ts';
import { COMMAND_NAME, findAssistant, installRootOf, installShim, ownedRegistration, programOfBinary, programRelation, readInstallReceipt, resolveOnPath } from './machine.ts';

import { readSeatLaunch } from './seatlaunch.ts';
import { readRegistryRows, registryFilePath } from './seatregistry.ts';
import { clearLeftUndoMarkers, incompleteUndos } from './undo.ts';

const WORKSPACE_ABSENT_REASON =
  'no reader workspace is attached, so nothing was read from a Shelf, a Notebook or ' +
  'internal/; pass -WorkspacePath <folder>, set LIBRARY_WORKSPACE, or run from inside ' +
  'a workspace. `library init <folder>` creates one.';

const NEWLINE = process.platform === 'win32' ? '\r\n' : '\n';

interface CheckResult {
  check: string;
  status: string;
  detail: string;
}

/** Whether this machine can start a program: a path that exists and is executable, or a bare name on PATH. */
function canStart(program: string): boolean {
  const executable = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (program.includes('/')) return executable(program);
  return (process.env['PATH'] ?? '').split(':').some((directory) => directory && executable(path.join(directory, program)));
}

/**
 * Whether Claude Code on this Windows machine would run a shell-form hook through Git Bash (S47). Where it would, a
 * quoted shell-form command works -- rel46a's plugin guards passed on a host with Git Bash and failed open in a
 * Sandbox without it. Looked for as Claude Code documents it: CLAUDE_CODE_GIT_BASH_PATH, then the Git beside a
 * `git.exe` on PATH, then Git's default folder.
 */
function gitBashPresent(): boolean {
  // A SET CLAUDE_CODE_GIT_BASH_PATH IS THE ANSWER, present or not: Claude Code uses the bash it names and nothing else.
  const named = process.env['CLAUDE_CODE_GIT_BASH_PATH'];
  if (named) return fs.existsSync(named);
  const pathVariable = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  for (const directory of (process.env[pathVariable] ?? '').split(';').filter((entry) => entry.trim())) {
    const git = path.join(directory.replace(/^"|"$/g, ''), 'git.exe');
    if (!fs.existsSync(git)) continue;
    const gitRoot = path.dirname(path.dirname(git));
    if (fs.existsSync(path.join(gitRoot, 'bin', 'bash.exe'))) return true;
  }
  const programFiles = process.env['ProgramFiles'] ?? process.env['PROGRAMFILES'];
  return programFiles !== undefined && fs.existsSync(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
}

/**
 * DESKPOST'S OWN SCRIPT NAMES, lowercased: the hooks it requires, the reader adapter, and every script the running
 * program ships under `.claude/hooks`. A PowerShell registration is Deskpost's only when it runs one of these with
 * `-File` (PLAN-install-onboarding.md step 8's table); a reader's own `.ps1` hook is theirs and never judged.
 */
export function deskpostScripts(program: string): Set<string> {
  const names = new Set<string>([...REQUIRED_HOOKS.map((hook) => hook.file.toLowerCase()), 'validated-bookreader.ps1']);
  try {
    for (const name of fs.readdirSync(path.join(program, '.claude', 'hooks'))) if (name.toLowerCase().endsWith('.ps1')) names.add(name.toLowerCase());
  } catch {
    // A program with no hooks folder ships none; the required names still stand.
  }
  return names;
}

/** A kernel binary as the shell resolves it (S47): a registration naming `bin/library` on Windows runs `library.exe`. */
function kernelFileOnDisk(file: string): string {
  return process.platform === 'win32' && !/\.exe$/i.test(file) && !fs.existsSync(file) ? `${file}.exe` : file;
}

interface RegistrationFaults {
  registrations: number;
  unresolved: string[];
  unstartable: string[];
  shellForm: string[];
  /** A kernel binary of a different Deskpost program than the one running doctor (F16). */
  otherProgram: string[];
  /** This install's own `versions/<v>`, named directly rather than through `current` (ADR-0038). */
  versionFolder: string[];
}

/**
 * THE REGISTRATIONS DESKPOST OWNS, JUDGED ONE BY ONE (PLAN-install-onboarding.md step 9, #15, F16). Each entry is read
 * as the invocation its harness runs (machine.ts): exec form's `command` + `args`, or the command line tokenized
 * quote-aware, so a program path holding a space is seen. Only Deskpost's own are judged -- a kernel binary running
 * `hook` or `mcp`, or one of Deskpost's scripts run with `-File` -- and a reader's own hooks are counted but never
 * flagged. `judgeProgram` marks the trees the WORKSPACE wrote, whose kernel binaries must be the running program's:
 * an enabled plugin's tree is its own install and is judged only for presence.
 */
function registrationFaults(trees: { tree: unknown; judgeProgram: boolean }[], program: string): RegistrationFaults {
  const own = deskpostScripts(program);
  const faults: RegistrationFaults = { registrations: 0, unresolved: [], unstartable: [], shellForm: [], otherProgram: [], versionFolder: [] };
  for (const { tree, judgeProgram } of trees) {
    if (!isObject(tree) || !('hooks' in tree) || tree['hooks'] === null) continue;
    for (const [eventName, blocks] of Object.entries(isObject(tree['hooks']) ? (tree['hooks'] as Json) : {})) {
      for (const block of asList(blocks)) {
        if (!isObject(block) || !('hooks' in block)) continue;
        for (const entry of asList(block['hooks'])) {
          if (entry === null) continue;
          faults.registrations += 1;
          const owned = ownedRegistration(entry, own);
          if (owned === null) continue;
          // A REGISTRATION THIS MACHINE CANNOT START IS NO GUARD (S42). Measured in a clean Linux distro: every hook
          // `library init` wrote there was `powershell.exe`, which does not exist. POSIX only, where it was measured. It covers
          // every registration another program starts: a script, or a source checkout's `cli.ts` (kickoffs/s157 row 6).
          const starter = owned.invocation.program;
          if (process.platform !== 'win32' && owned.file !== starter && !starter.includes('${') && !canStart(starter)) {
            faults.unstartable.push(`${eventName} -> ${starter}`);
            continue;
          }
          if (owned.file.includes('${') || !path.isAbsolute(owned.file)) continue;
          const file = owned.kind === 'kernel' ? kernelFileOnDisk(owned.file) : owned.file;
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            faults.unresolved.push(`${eventName} -> ${owned.file}`);
            continue;
          }
          if (owned.kind !== 'kernel') continue;
          // ON WINDOWS WHAT FAILS IS THE FORM (S47): measured in S7's Windows Sandbox, a quoted command in shell form
          // runs through PowerShell where Git Bash is absent, and PowerShell refuses it as 'Unexpected token'.
          if (process.platform === 'win32' && isObject(entry) && !Array.isArray(entry['args']) && typeof entry['command'] === 'string' && /^\s*["']/.test(entry['command']) && !gitBashPresent()) {
            faults.shellForm.push(`${eventName} -> ${owned.file}`);
            continue;
          }
          if (!judgeProgram) continue;
          const relation = programRelation(programOfBinary(owned.file), program);
          if (relation === 'other') faults.otherProgram.push(`${eventName} -> ${owned.file}`);
          else if (relation === 'version-folder') faults.versionFolder.push(`${eventName} -> ${owned.file}`);
        }
      }
    }
  }
  return faults;
}

/** The refusal for a registration naming another program or a version folder, or null when there is none. */
function programFaultText(faults: RegistrationFaults, workspace: string, program: string, harness: string): string | null {
  if (faults.otherProgram.length) {
    return (
      `${harness} runs a different Deskpost program than this one (${program}): ${faults.otherProgram.join('; ')}. ` +
      `A Library answers to one install. Re-run \`library init ${workspace}\` with this one, or run doctor from the install it names.`
    );
  }
  if (faults.versionFolder.length) {
    return (
      `${harness} names a version folder directly rather than ${program}: ${faults.versionFolder.join('; ')}. ` +
      `The next upgrade would leave it running an old version (ADR-0038). Re-run \`library init ${workspace}\`.`
    );
  }
  return null;
}

function parseJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function codexHomeDirectory(): string {
  const configured = process.env['CODEX_HOME'];
  if (configured && configured.trim()) return configured;
  return path.join(process.platform === 'win32' ? (process.env['USERPROFILE'] ?? os.homedir()) : homeDirectory(), '.codex');
}

/** One `[mcp_servers.<name>]` or `[plugins."<id>"]` a Codex config defines: its name as written, and how it is set. */
export interface CodexConfigTable {
  /** The segment as written, quotes kept: `librarian`, `"computer-use@openai-bundled"`. */
  key: string;
  /** The same segment unquoted, for comparing. */
  name: string;
  /** No `enabled` key, `enabled = true` or `enabled = false`; anything else is left out as a shape not read. */
  enabled: boolean | null;
  /** The table has a `command` or a `url`: it starts a server rather than only setting one. */
  launches: boolean;
}

/** The MCP servers and plugins a Codex config defines, and the shapes the line reader left out (never guessed). */
export interface CodexConfigTables {
  servers: CodexConfigTable[];
  plugins: CodexConfigTable[];
  skipped: string[];
}

/** A dotted TOML key split into its segments as written, or null when a quote is never closed. */
function tomlKeySegments(text: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    let segment = '';
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i]!;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += quote === '"' && text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      segment = text.substring(i, j + 1);
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.substring(i));
      if (!bare) return null;
      segment = bare[0];
      i += segment.length;
    }
    segments.push(segment);
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    if (text[i] !== '.') return null;
    i += 1;
  }
  return segments.length ? segments : null;
}

function tomlUnquote(segment: string): string {
  if (segment.length >= 2 && segment.startsWith("'") && segment.endsWith("'")) return segment.substring(1, segment.length - 1);
  if (segment.length >= 2 && segment.startsWith('"') && segment.endsWith('"')) {
    return segment.substring(1, segment.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return segment;
}

/**
 * How a value's text leaves the reader: its open brackets (an array or inline table running onto later lines), an
 * unclosed multi-line string, or a single-line string never closed (null). Comments after the value are dropped.
 */
function tomlValueState(text: string, depth: number): { depth: number; multiline: '"""' | "'''" | null; value: string } | null {
  let value = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '#') break;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const fence = text.substring(i, i + 3) as '"""' | "'''";
      const end = text.indexOf(fence, i + 3);
      if (end < 0) return { depth, multiline: fence, value };
      value += text.substring(i, end + 3);
      i = end + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      value += text.substring(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    value += c;
    i += 1;
  }
  return { depth, multiline: null, value: value.trim() };
}

/**
 * THE SERVERS AND PLUGINS A CODEX CONFIG DEFINES, READ LINE BY LINE (kickoffs/s114-r2 ruling 3), in the style of
 * init's `codexConfigEntries` and `codexProjectTrust` here, never a TOML library. A server's name is the first segment
 * after `mcp_servers`, so `[mcp_servers.X.env]` names X and is never a server of its own; a value running onto later
 * lines (an array, an inline table, a multi-line string) is passed over, never read as keys. A server or plugin set in
 * a shape the reader does not read (an inline table, a dotted key, an `enabled` that is neither true nor false) is left
 * out and named in `skipped`. Null when a line is none of a comment, a table, a key or a value's continuation.
 */
export function readCodexConfigTables(text: string): CodexConfigTables | null {
  const servers = new Map<string, CodexConfigTable>();
  const plugins = new Map<string, CodexConfigTable>();
  const skipped: string[] = [];
  const table = (kind: Map<string, CodexConfigTable>, key: string): CodexConfigTable => {
    const name = tomlUnquote(key);
    let found = kind.get(name);
    if (!found) {
      found = { key, name, enabled: null, launches: false };
      kind.set(name, found);
    }
    return found;
  };
  let current: { kind: 'server' | 'plugin'; entry: CodexConfigTable } | null = null;
  let container: 'mcp_servers' | 'plugins' | 'root' | null = 'root';
  const odd = new Set<CodexConfigTable>();
  let depth = 0;
  let multiline: '"""' | "'''" | null = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (multiline !== null) {
      const end = raw.indexOf(multiline);
      if (end < 0) continue;
      const rest = tomlValueState(raw.substring(end + 3), depth);
      if (rest === null) return null;
      multiline = rest.multiline;
      depth = rest.depth;
      continue;
    }
    if (depth > 0) {
      const rest = tomlValueState(raw, depth);
      if (rest === null) return null;
      multiline = rest.multiline;
      depth = rest.depth;
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^(\[\[?)\s*(.+?)\s*(\]\]?)\s*(#.*)?$/.exec(line);
    if (header && line.startsWith('[')) {
      if (header[1]!.length !== header[3]!.length) return null;
      const segments = tomlKeySegments(header[2]!);
      if (segments === null) return null;
      current = null;
      container = null;
      if (header[1] === '[[') continue;
      const head = tomlUnquote(segments[0]!);
      if ((head === 'mcp_servers' || head === 'plugins') && segments.length === 1) container = head;
      else if (head === 'mcp_servers') {
        const entry = table(servers, segments[1]!);
        if (segments.length === 2) current = { kind: 'server', entry };
      } else if (head === 'plugins') {
        const entry = table(plugins, segments[1]!);
        if (segments.length === 2) current = { kind: 'plugin', entry };
      }
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) return null;
    const keySegments = tomlKeySegments(line.substring(0, equals));
    if (keySegments === null) return null;
    const state = tomlValueState(line.substring(equals + 1), 0);
    if (state === null) return null;
    multiline = state.multiline;
    depth = state.depth;
    const first = tomlUnquote(keySegments[0]!);
    if (container === 'root' && (first === 'mcp_servers' || first === 'plugins') && keySegments.length >= 2) {
      skipped.push(`${first}.${keySegments[1]} (a dotted key)`);
      continue;
    }
    if (container === 'mcp_servers' || container === 'plugins') {
      skipped.push(`${container}.${keySegments[0]} (${keySegments.length > 1 ? 'a dotted key' : 'an inline table'})`);
      continue;
    }
    if (current === null || keySegments.length !== 1) continue;
    if (first === 'command' || first === 'url') current.entry.launches = true;
    if (first !== 'enabled') continue;
    if (state.value === 'true') current.entry.enabled = true;
    else if (state.value === 'false') current.entry.enabled = false;
    else odd.add(current.entry);
  }
  if (multiline !== null || depth > 0) return null;
  const settled = (kind: Map<string, CodexConfigTable>, prefix: string): CodexConfigTable[] =>
    [...kind.values()].filter((entry) => {
      if (!odd.has(entry)) return true;
      skipped.push(`${prefix}.${entry.key} (an enabled value that is neither true nor false)`);
      return false;
    });
  return { servers: settled(servers, 'mcp_servers'), plugins: settled(plugins, 'plugins'), skipped };
}

/** `<CODEX_HOME>/config.toml` as a Library's render and doctor read it: absent, unreadable, or its servers and plugins. */
export function codexUserConfig(): { path: string; state: 'absent' | 'unreadable' | 'read'; tables: CodexConfigTables | null } {
  const file = path.join(codexHomeDirectory(), 'config.toml');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { path: file, state: 'absent', tables: null };
  let tables: CodexConfigTables | null = null;
  try {
    tables = readCodexConfigTables(fs.readFileSync(file, 'utf8'));
  } catch {
    tables = null;
  }
  return tables === null ? { path: file, state: 'unreadable', tables: null } : { path: file, state: 'read', tables };
}

/** The validated reader's server name, never turned off. */
export const CODEX_READER_SERVER = 'validated-book-reader';

/** What a user config turns on that a Library turns off: every server and plugin on, except the validated reader, sorted. */
export function codexTurnedOn(tables: CodexConfigTables): { servers: CodexConfigTable[]; plugins: CodexConfigTable[] } {
  const byName = (a: CodexConfigTable, b: CodexConfigTable) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    servers: tables.servers.filter((entry) => entry.enabled !== false && entry.name !== CODEX_READER_SERVER).sort(byName),
    plugins: tables.plugins.filter((entry) => entry.enabled === true).sort(byName),
  };
}

/** Whether one directory is trusted in the Codex home a session here would consult, and which home. */
function codexProjectTrust(target: string): { home: string; home_source: string; config: string; config_present: boolean; trusted: boolean } {
  const home = codexHomeDirectory();
  const homeSource = process.env['CODEX_HOME'] && process.env['CODEX_HOME'].trim() ? 'CODEX_HOME' : 'default';
  const config = path.join(home, 'config.toml');
  const result = { home, home_source: homeSource, config, config_present: false, trusted: false };
  if (!fs.existsSync(config) || !fs.statSync(config).isFile()) return result;
  result.config_present = true;
  const wanted = path.resolve(target).replace(/[\\/]+$/, '').toLowerCase();
  let inWanted = false;
  for (const raw of fs.readFileSync(config, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const text = raw.trim();
    if (text.startsWith('[')) {
      inWanted = false;
      const header = /^\[projects\.(.+)\]$/.exec(text);
      if (header) {
        let key = header[1]!.trim();
        if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) key = key.substring(1, key.length - 1);
        else if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) key = key.substring(1, key.length - 1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
        let normalised: string;
        try {
          normalised = path.resolve(key).replace(/[\\/]+$/, '');
        } catch {
          normalised = key.replace(/[\\/]+$/, '');
        }
        if (normalised.toLowerCase() === wanted) inWanted = true;
      }
      continue;
    }
    if (!inWanted) continue;
    const trust = /^trust_level\s*=\s*["']([^"']*)["']\s*$/.exec(text);
    if (trust && trust[1] === 'trusted') result.trusted = true;
  }
  return result;
}

// --- The nine checks ---------------------------------------------------------------------------------

function guardsRegistered(workspace: string, program: string): string {
  if (workspace === program) return 'the program and the workspace are one directory; settings.hooks-registered is the window on it';
  const files = ['settings.json', 'settings.local.json'].map((name) => path.join(workspace, '.claude', name)).filter((file) => fs.existsSync(file));
  // THE ENABLED PLUGIN'S REGISTRATIONS COUNT (S42), as the oracle's `Get-EnabledClaudePluginHooks` reads them.
  const plugin = enabledClaudePluginHooks(workspace, homeDirectory());
  const pluginTree = plugin !== null ? plugin.tree : null;
  if (!files.length && pluginTree === null) {
    throw new Error(
      `${workspace} registers no hooks at all: it has no .claude/settings.json, so a session rooted ` +
        `there runs with no Desk boundary and no closed-Book guard. Re-run \`library init ${workspace}\` to register them.`,
    );
  }
  const ownTrees = files.map(parseJsonFile);
  const trees = pluginTree !== null ? [...ownTrees, pluginTree] : ownTrees;
  const blocking = hookRegistrationProblems(trees).filter((problem) => !problem.optional);
  if (blocking.length) {
    throw new Error(blocking.map((problem) => problem.detail).join('; ') + ` -- a session rooted in ${workspace} would run without them. Re-run \`library init ${workspace}\`.`);
  }
  const faults = registrationFaults([...ownTrees.map((tree) => ({ tree, judgeProgram: true })), ...(pluginTree !== null ? [{ tree: pluginTree, judgeProgram: false }] : [])], program);
  const { registrations, unresolved, unstartable, shellForm } = faults;
  if (unresolved.length) {
    throw new Error(
      'a registered hook names a script that is not there, so it fails open silently: ' + unresolved.join('; ') + `. Re-run \`library init ${workspace}\` to re-point them.`,
    );
  }
  if (unstartable.length) {
    throw new Error(
      'a registered hook starts a program this machine does not have, so it cannot run and fails open silently: ' + unstartable.join('; ') + `. Re-run \`library init ${workspace}\` to re-point them.`,
    );
  }
  if (shellForm.length) {
    throw new Error(
      'a registered hook runs the kernel as a quoted command in shell form, which Claude Code runs through PowerShell ' +
        "where Git Bash is absent, and PowerShell refuses it as 'Unexpected token', so it fails open silently: " +
        shellForm.join('; ') + '. A release since 0.2.0 registers the binary in exec form; update the plugin, or re-run ' + `\`library init ${workspace}\`.`,
    );
  }
  const programFault = programFaultText(faults, workspace, program, `${workspace} registers a hook that`);
  if (programFault !== null) throw new Error(programFault);
  const shapeFaults: string[] = [];
  for (const tree of trees) {
    if (!isObject(tree) || !('hooks' in tree) || tree['hooks'] === null) continue;
    shapeFaults.push(...claudeHookShapeFaults(tree, `${workspace}'s registered hooks`));
  }
  if (shapeFaults.length) {
    throw new Error(
      shapeFaults.join('; ') + ' -- a settings file whose hooks block is malformed is skipped ENTIRELY ' +
        `by the harness, so a session rooted in ${workspace} would run with no Desk boundary and no closed-Book ` +
        `guard however many registrations are counted above. Re-run \`library init ${workspace}\`.`,
    );
  }
  const mcpPath = path.join(workspace, '.mcp.json');
  let serverDetail = 'no .mcp.json';
  if (fs.existsSync(mcpPath)) {
    let mcp: unknown = null;
    try {
      mcp = parseJsonFile(mcpPath);
    } catch {
      mcp = null;
    }
    if (isObject(mcp) && 'mcpServers' in mcp) {
      const servers = isObject(mcp['mcpServers']) ? Object.keys(mcp['mcpServers'] as Json) : [];
      serverDetail = servers.includes('validated-book-reader') ? 'reader declared' : `declares ${servers.length} server(s), none of them the validated reader`;
      // A reader this machine cannot start is no reader (S42; POSIX, as the hooks above).
      const reader = servers.includes('validated-book-reader') ? (mcp['mcpServers'] as Json)['validated-book-reader'] : null;
      const starter = process.platform !== 'win32' && isObject(reader) && typeof reader['command'] === 'string' ? reader['command'] : null;
      if (starter !== null && !starter.includes('${') && !canStart(starter)) serverDetail = `declares the validated reader as '${starter}', which this machine cannot start`;
      // THE READER IS A DESKPOST REGISTRATION TOO (step 8's table), held to the same two rules as a hook: its program
      // must be there, and a kernel reader must be this program's (F16).
      const owned = reader !== null ? ownedRegistration(reader, deskpostScripts(program)) : null;
      if (owned !== null && !owned.file.includes('${') && path.isAbsolute(owned.file)) {
        const file = owned.kind === 'kernel' ? kernelFileOnDisk(owned.file) : owned.file;
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          throw new Error(
            `${mcpPath} declares the validated reader as ${owned.file}, which is not there, so a session in ${workspace} has no ` +
              `tool to read an open Book. Re-run \`library init ${workspace}\` to re-point it.`,
          );
        }
        const relation = owned.kind === 'kernel' ? programRelation(programOfBinary(owned.file), program) : 'same';
        const fault = programFaultText(
          { registrations: 1, unresolved: [], unstartable: [], shellForm: [], otherProgram: relation === 'other' ? [`validated-book-reader -> ${owned.file}`] : [], versionFolder: relation === 'version-folder' ? [`validated-book-reader -> ${owned.file}`] : [] },
          workspace,
          program,
          `${mcpPath} declares a reader that`,
        );
        if (fault !== null) throw new Error(fault);
      }
    }
  }
  if (serverDetail !== 'reader declared' && plugin !== null && plugin.declaresReader) serverDetail = 'reader declared';
  if (serverDetail !== 'reader declared') {
    return (
      `WARN: ${workspace} registers its guards but ${serverDetail}, so a session there can be ` +
      'refused a closed Book and still has no tool to read an open one. A plugin install ' +
      'supplies the server instead; a direct one gets it from `library init`.'
    );
  }
  // BOTH AT ONCE IS EVERY GUARD TWICE (S42), as the oracle says it.
  if (pluginTree !== null && !hookRegistrationProblems(ownTrees).some((problem) => !problem.optional)) {
    return (
      `WARN: ${workspace} registers its guards itself AND through the enabled ${plugin!.key} plugin, so every guard ` +
      'runs twice and two validated readers are declared. Keep one: disable the plugin for this workspace, or ' +
      'remove the hooks `library init` wrote to .claude/settings.local.json.'
    );
  }
  const through = pluginTree !== null ? ` (through the enabled ${plugin!.key} plugin)` : '';
  return `${registrations} hook registration(s) resolve${through}, and the validated reader is declared`;
}

/** A `[... .<key>]` header's key as the path it names: a TOML literal in single quotes, or a basic string in double. */
function codexTableKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.substring(1, key.length - 1);
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) return key.substring(1, key.length - 1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  return key;
}

/**
 * Which of a hooks file's registrations the Codex home has never reviewed, as `<Event> <i>:<j>`.
 *
 * HOOK TRUST IS THE THIRD GATE, AND AN UNREVIEWED HOOK IS SKIPPED IN SILENCE (S49, measured in S7's Windows
 * Sandbox on codex-cli 0.153.4). With the project trusted and no hook reviewed, `codex exec` ran a shell read of a
 * closed Book's page and printed it, no hook firing, while this check passed. The reader's first interactive
 * session wrote one `[hooks.state.'<hooks.json>:<event>:<i>:<j>']` table per hook, each with a `trusted_hash`, and
 * the same read was then blocked. The oracle's `Get-CodexUnreviewedHooks` asks the same question.
 *
 * Codex rust-v0.163.0 hashes the normalized event, matcher and single command handler as canonical JSON:
 * codex-rs/hooks/src/engine/discovery.rs:478-581, 747-813; config/src/fingerprint.rs:54-66 in openai/codex.
 * codexHookHash reproduces that identity offline. A changed hash is out of date and Codex skips it until
 * reviewed again. Unknown forms, fields or handler kinds remain reviewed but not checked (named in WARN
 * detail), never called stale. Recheck this rule after a Codex change. Read, never written.
 */
function codexUnreviewedHooks(hooksPath: string, document: unknown, config: string): { unreviewed: string[]; stale: string[]; unchecked: string[] } {
  const normalise = (text: string) => text.replace(/\\/g, '/').toLowerCase();
  const reviewed = new Map<string, string>();
  if (fs.existsSync(config) && fs.statSync(config).isFile()) {
    let current: string | null = null;
    for (const raw of fs.readFileSync(config, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const text = raw.trim();
      if (text.startsWith('[')) {
        const header = /^\[hooks\.state\.(.+)\]$/.exec(text);
        current = header ? codexTableKey(header[1]!) : null;
        continue;
      }
      const hash = /^trusted_hash\s*=\s*["']([^"']+)["']\s*$/.exec(text);
      if (current !== null && hash) reviewed.set(normalise(current), hash[1]!);
    }
  }
  const file = path.resolve(hooksPath);
  const unreviewed: string[] = [];
  const stale: string[] = [];
  const unchecked: string[] = [];
  const events = ((document as { hooks?: Record<string, unknown> }).hooks ?? {}) as Record<string, unknown>;
  for (const [event, value] of Object.entries(events)) {
    const snake = event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const groups = Array.isArray(value) ? value : [value];
    groups.forEach((group, i) => {
      const hooks = (group as { hooks?: unknown } | null)?.hooks;
      (Array.isArray(hooks) ? hooks : hooks === undefined || hooks === null ? [] : [hooks]).forEach((hook, j) => {
        const label = `${event} ${i}:${j}`;
        const saved = reviewed.get(normalise(`${file}:${snake}:${i}:${j}`));
        if (saved === undefined) unreviewed.push(label);
        else {
          const current = codexHookHash(event, group, hook);
          if (!/^sha256:[0-9a-f]{64}$/.test(saved) || current === null) unchecked.push(label);
          else if (saved !== current) stale.push(label);
        }
      });
    });
  }
  return { unreviewed, stale, unchecked };
}

/**
 * THE WORKSPACE FILE AGAINST THE USER CONFIG (kickoffs/s114-r2 ruling 5). A turn-off table (no `command`, no `url`) for
 * a server the user config no longer defines stops Codex loading any config, so that FAILs; a server or plugin the user
 * config turns on that the workspace file does not turn off was added after the last `init`, a WARN. Null when the
 * user config or the workspace file cannot be read, so nothing is judged from a guess.
 */
function codexConfigGuards(configPath: string): { ghosts: string[]; added: string[]; turnedOff: number; userConfig: string } | null {
  const user = codexUserConfig();
  let workspaceTables: CodexConfigTables | null = null;
  try {
    workspaceTables = readCodexConfigTables(fs.readFileSync(configPath, 'utf8'));
  } catch {
    workspaceTables = null;
  }
  if (workspaceTables === null || user.state === 'unreadable') return null;
  const defined = new Set((user.tables?.servers ?? []).map((entry) => entry.name));
  const ghosts = workspaceTables.servers.filter((entry) => !entry.launches && !defined.has(entry.name)).map((entry) => entry.key);
  if (user.tables === null) return { ghosts, added: [], turnedOff: 0, userConfig: user.path };
  const off = (entries: CodexConfigTable[]) => new Set(entries.filter((entry) => entry.enabled === false).map((entry) => entry.name));
  const serversOff = off(workspaceTables.servers);
  const pluginsOff = off(workspaceTables.plugins);
  const on = codexTurnedOn(user.tables);
  const added = [
    ...on.servers.filter((entry) => !serversOff.has(entry.name)).map((entry) => entry.key),
    ...on.plugins.filter((entry) => !pluginsOff.has(entry.name)).map((entry) => `plugin ${entry.key}`),
  ];
  const turnedOff = on.servers.filter((entry) => serversOff.has(entry.name)).length + on.plugins.filter((entry) => pluginsOff.has(entry.name)).length;
  return { ghosts, added, turnedOff, userConfig: user.path };
}

function codexGuardsRegistered(workspace: string, program: string): string {
  if (workspace === program) return 'the program and the workspace are one directory; codex.project-access-config is the window on it';
  if (!fs.existsSync(path.join(program, '.codex', 'hooks.template.json'))) {
    return 'this install ships no Codex hooks template, so `library init` writes no Codex bindings';
  }
  const hooksPath = path.join(workspace, '.codex', 'hooks.json');
  if (!fs.existsSync(hooksPath)) {
    throw new Error(
      `${workspace} has no .codex/hooks.json, so a Codex seat opened there runs with no Desk boundary, ` +
        `no closed-Book guard and no shell guard. Re-run \`library init ${workspace}\` to write them.`,
    );
  }
  let document: unknown;
  try {
    document = parseJsonFile(hooksPath);
  } catch (error) {
    throw new Error(`${hooksPath} is not valid JSON, so Codex registers nothing from it: ${(error as Error).message}`);
  }
  const shapeFaults = codexHookShapeFaults(document, `${workspace}'s .codex/hooks.json`);
  if (shapeFaults.length) {
    throw new Error(
      shapeFaults.join('; ') + ` -- Codex rejects the whole file, so a session rooted in ${workspace} ` +
        `would run with no Library hook at all however many are registered in it. Re-run \`library init ${workspace}\`.`,
    );
  }
  const problems = codexRegistrationProblems(document);
  if (problems.length) throw new Error(problems.join(' ') + ` A Codex seat in ${workspace} would run without them. Re-run \`library init ${workspace}\`.`);
  const codexFaults = registrationFaults([{ tree: document, judgeProgram: true }], program);
  const { registrations, unresolved, unstartable } = codexFaults;
  if (unresolved.length) {
    throw new Error(
      'a registered Codex hook names a script that is not there, so it cannot start and the boundary is ' +
        'absent: ' + unresolved.join('; ') + `. Re-run \`library init ${workspace}\` to re-point them.`,
    );
  }
  if (unstartable.length) {
    throw new Error(
      'a registered Codex hook starts a program this machine does not have, so the boundary is absent: ' +
        unstartable.join('; ') + `. Re-run \`library init ${workspace}\` to re-point them.`,
    );
  }
  const codexProgramFault = programFaultText(codexFaults, workspace, program, `${workspace} registers a Codex hook that`);
  if (codexProgramFault !== null) throw new Error(codexProgramFault);
  const trust = codexProjectTrust(workspace);
  if (!trust.trusted) {
    const where = trust.config_present ? trust.config : `${trust.config} (which does not exist)`;
    return (
      `WARN: ${workspace} registers ${registrations} Codex hook(s) that resolve, and Codex will not read them: ` +
      `the project is not trusted in ${where}, resolved from ${trust.home_source}. Codex ignores an untrusted ` +
      "project's .codex/ in SILENCE, so the bindings are correct and inert. Open a Codex session in that " +
      'folder once and answer its trust prompt; the grant is per Codex home, and Orca substitutes ' +
      'CODEX_HOME, so a seat launched from Orca needs it in the home that seat uses.'
    );
  }
  const configPath = path.join(workspace, '.codex', 'config.toml');
  const guards = fs.existsSync(configPath) ? codexConfigGuards(configPath) : null;
  if (guards !== null && guards.ghosts.length) {
    throw new Error(
      `Codex will not start in this Library: \`.codex/config.toml\` turns off ${guards.ghosts.map((name) => '`' + name + '`').join(', ')}, ` +
        `which \`${guards.userConfig}\` no longer defines. Run \`${COMMAND_NAME} init ${workspace}\`.`,
    );
  }
  // THE THIRD GATE (S49): a trusted project's hooks still run only once that Codex home has reviewed them.
  const { unreviewed, stale, unchecked } = codexUnreviewedHooks(hooksPath, document, trust.config);
  const notChecked = unchecked.length ? `; ${unchecked.length} reviewed hook(s) not checked: ${unchecked.join(', ')}` : '';
  if (unreviewed.length || stale.length) {
    return (
      `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but ` +
      (unreviewed.length ? `${unreviewed.length} have not been reviewed in ${trust.config}: ${unreviewed.join(', ')}. Codex skips an unreviewed hook in SILENCE, so those bindings are inert. ` : '') +
      (stale.length ? `${stale.length} were reviewed before the hook changed: ${stale.join(', ')} (out of date in ${trust.config}). Codex skips them until reviewed again. ` : '') +
      (notChecked ? `${notChecked.slice(2)}. ` : '') +
      'Open a Codex session in that folder once and accept its hook ' +
      'review; the review is per Codex home, like the trust grant.'
    );
  }
  if (!fs.existsSync(configPath)) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but has no .codex/config.toml, so a Codex seat there has no validated reader.`;
  }
  if (!/^\[mcp_servers\.validated-book-reader\]\s*$/im.test(fs.readFileSync(configPath, 'utf8'))) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but its .codex/config.toml does not declare the validated reader.`;
  }
  if (guards !== null && guards.added.length) {
    return `WARN: ${guards.added.map((name) => '`' + name + '`').join(', ')} are on in Codex sessions here (added after the last \`${COMMAND_NAME} init\`). Run \`${COMMAND_NAME} init ${workspace}\`.`;
  }
  return `${registrations} Codex hook registration(s) resolve, the project is trusted in ${trust.home} with every hook reviewed, and the validated reader is declared` +
    (guards !== null ? `, and ${guards.turnedOff} user-level servers and plugins are turned off` : '');
}

function catalogBookSlugs(workspace: string): string[] {
  const catalogPath = path.join(workspace, 'shelf/_catalog.md');
  if (!fs.existsSync(catalogPath)) throw new Error('shelf/_catalog.md is missing.');
  const slugs = [...fs.readFileSync(catalogPath, 'utf8').matchAll(/^\s*-\s+\*\*Path:\*\*\s+shelf\/([a-z0-9][a-z0-9-]*)\s*$/gm)].map((match) => match[1]!);
  if (!slugs.length) throw new Error('shelf/_catalog.md lists no Books.');
  return slugs;
}

/** A record file with a `schema` and a `records` list, read the way both record helpers read theirs. */
function readRecordFile(workspace: string, relative: string): Json[] {
  const raw = fs.readFileSync(path.join(workspace, relative), 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${relative} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed) || !('schema' in parsed)) throw new Error(`${relative} has no schema field.`);
  if (Number(parsed['schema']) !== 1) throw new Error(`${relative} is schema ${String(parsed['schema'])}; this helper writes schema 1.`);
  return asList(parsed['records']) as Json[];
}

function recordProblems(relative: string, problems: string[]): Error {
  return new Error(`${relative} has ${problems.length} problem(s):${NEWLINE}  - ${problems.join(`${NEWLINE}  - `)}`);
}

const ALLOWED_RESOLUTIONS: Record<string, string[]> = { unverified: ['open'], complementary: ['open', 'accepted'], canonical: ['open', 'resolved'] };

function overlapRecords(workspace: string): string {
  const relative = 'internal/overlap-records.json';
  if (!fs.existsSync(path.join(workspace, relative))) return 'no overlap records yet';
  const known = catalogBookSlugs(workspace);
  const records = readRecordFile(workspace, relative);
  const problems: string[] = [];
  const seen = new Map<string, number>();
  records.forEach((record, position) => {
    const index = position + 1;
    const missing = ['topic', 'book', 'counterpart', 'relationship', 'resolution', 'date'].filter((field) => !isObject(record) || !(field in record));
    if (missing.length) {
      problems.push(`record ${index} is missing ${missing.join(', ')}`);
      return;
    }
    const label = `record ${index} (${String(record['topic'])}: ${String(record['book'])}/${String(record['counterpart'])})`;
    for (const field of ['topic', 'book', 'counterpart']) {
      const value = record[field] === null ? '' : String(record[field]);
      if (!value.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(value)) problems.push(`${label} has a malformed ${field} '${value}'`);
    }
    if (String(record['book']) === String(record['counterpart'])) problems.push(`${label} pairs a Book with itself`);
    for (const field of ['book', 'counterpart']) {
      const value = record[field] === null ? '' : String(record[field]);
      if (value && !known.includes(value)) problems.push(`${label} names shelf/${value}, which shelf/_catalog.md does not list`);
    }
    const relationship = String(record['relationship']);
    if (!(relationship in ALLOWED_RESOLUTIONS)) problems.push(`${label} has an unknown relationship '${relationship}'`);
    else if (!ALLOWED_RESOLUTIONS[relationship]!.includes(String(record['resolution']))) {
      problems.push(`${label} is '${relationship}' with resolution '${String(record['resolution'])}'; allowed: ${ALLOWED_RESOLUTIONS[relationship]!.join(', ')}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record['date']))) problems.push(`${label} has a malformed date '${String(record['date'])}'`);
    const pair = [String(record['book']), String(record['counterpart'])].sort();
    const key = `${String(record['topic'])}|${pair[0]}|${pair[1]}`;
    if (seen.has(key)) problems.push(`${label} duplicates the pair already recorded as record ${seen.get(key)}; one topic and Book pair holds exactly one relationship`);
    else seen.set(key, index);
  });
  if (problems.length) throw recordProblems(relative, problems);
  return `${records.length} overlap record(s), all valid`;
}

function batchKey(batch: string): string {
  return batch.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function rawBatchOwners(workspace: string): string {
  const relative = 'internal/raw-batch-owners.json';
  if (!fs.existsSync(path.join(workspace, relative))) return 'no raw batch ownership records yet';
  const records = readRecordFile(workspace, relative);
  const problems: string[] = [];
  const seen = new Map<string, number>();
  records.forEach((record, position) => {
    const index = position + 1;
    const missing = ['batch', 'project', 'date'].filter((field) => !isObject(record) || !(field in record));
    if (missing.length) {
      problems.push(`record ${index} is missing ${missing.join(', ')}`);
      return;
    }
    const batch = record['batch'] === null ? '' : String(record['batch']);
    const label = `record ${index} (raw/${batch})`;
    const segments = batch.split('/');
    if (!batch.trim()) problems.push(`${label} has an empty batch`);
    else if (batch !== batchKey(batch)) problems.push(`${label} has a batch that is not canonical: '${batch}' should be stored as '${batchKey(batch)}'`);
    else if (/[\x00-\x1F]/.test(batch) || batch.includes('\\')) problems.push(`${label} has a batch carrying a backslash or control character`);
    else if (segments.includes('.') || segments.includes('..') || segments.includes('')) problems.push(`${label} has a batch with a relative or empty path segment: '${batch}'`);
    else if (/^[A-Za-z]:/.test(batch) || batch.startsWith('//')) problems.push(`${label} has a batch that is not relative to raw/: '${batch}'`);
    const project = record['project'] === null ? '' : String(record['project']);
    if (!project.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(project)) problems.push(`${label} has a malformed project slug '${project}'`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record['date']))) problems.push(`${label} has a malformed date '${String(record['date'])}'`);
    const key = batchKey(batch).toLowerCase();
    if (seen.has(key)) problems.push(`${label} duplicates the batch already mapped by record ${seen.get(key)}; one batch has exactly one owner`);
    else seen.set(key, index);
  });
  if (problems.length) throw recordProblems(relative, problems);
  return `${records.length} raw batch ownership record(s), all valid`;
}

/** `Get-ChildItem -Recurse -File` order: a directory's own files, then each subdirectory in name order. */
function markdownFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    const items = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0,
    );
    for (const item of items) if (item.isFile() && path.extname(item.name).toLowerCase() === '.md') out.push(path.join(directory, item.name));
    for (const item of items) if (item.isDirectory()) walk(path.join(directory, item.name));
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** The literal default of a helper's `[string]$BookSlug = '<slug>'`, or null when it has none. */
function bookSlugDefault(helperPath: string): string | null {
  if (!fs.existsSync(helperPath)) return null;
  const text = fs.readFileSync(helperPath, 'utf8');
  const block = /\bparam\s*\(([\s\S]*?)\n\)/i.exec(text);
  if (!block) return null;
  const match = /\$BookSlug\s*=\s*'([^']*)'/i.exec(block[1]!);
  return match ? match[1]! : null;
}

function referencesResolve(workspace: string, program: string): string {
  const catalogPath = path.join(workspace, 'shelf/_catalog.md');
  if (!fs.existsSync(catalogPath)) throw new Error('shelf/_catalog.md is missing.');
  const catalog = fs.readFileSync(catalogPath, 'utf8').replace(/^﻿/, '');
  const known = new Map<string, boolean>();
  for (const section of catalog.matchAll(/^##\s+(.+?)\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)) {
    const pathLine = /^\s*-\s+\*\*Path:\*\*\s+shelf\/([a-z0-9][a-z0-9-]*)\s*$/m.exec(section[2]!);
    if (!pathLine) continue;
    const slug = pathLine[1]!;
    if (known.has(slug)) throw new Error(`shelf/_catalog.md lists shelf/${slug} more than once`);
    known.set(slug, /^\s*-\s+\*\*Kind:\*\*\s+capture\s*$/m.test(section[2]!));
  }
  if (!known.size) throw new Error('shelf/_catalog.md lists no Books.');
  const missing = [...known.keys()].filter((slug) => !(fs.existsSync(path.join(workspace, 'shelf', slug, 'wiki')) && fs.statSync(path.join(workspace, 'shelf', slug, 'wiki')).isDirectory()));
  if (missing.length) throw new Error(`catalog entries with no Book on disk: ${missing.sort().join(', ')}`);

  const sources = [
    ...markdownFilesRecursive(path.join(program, '.claude', 'skills')),
    ...['CLAUDE.md', 'CONTEXT.md'].map((name) => path.join(program, name)).filter((file) => fs.existsSync(file)),
  ];
  const stale: string[] = [];
  for (const file of sources) {
    for (const hit of fs.readFileSync(file, 'utf8').matchAll(/shelf\/([a-z0-9][a-z0-9-]*)/g)) {
      if (!known.has(hit[1]!)) stale.push(`${path.basename(file)} names shelf/${hit[1]}, which is not in the Shelf catalog`);
    }
  }
  for (const helper of ['Add-ShelfNote.ps1', 'Invoke-LibraryTriage.ps1']) {
    const slug = bookSlugDefault(path.join(program, 'tools', helper));
    if (slug === null) continue;
    if (!known.has(slug)) stale.push(`${helper} defaults to -BookSlug '${slug}', which is not in the Shelf catalog`);
    else if (!known.get(slug)) stale.push(`${helper} defaults to -BookSlug '${slug}', which is not capture-enabled`);
  }
  if (stale.length) throw new Error(stale.join('; '));
  return `${known.size} Books catalogued, ${sources.length} sources reference only Books that exist`;
}

function unaccountedOwnership(root: string): { topic: string; seat: string | null }[] {
  const registry = readSeatRegistry(path.join(root, '.claude'));
  const retirements = readSeatRetirementRecords(root).records;
  return notebookOwnershipInventory(root).filter(
    (row) => row.scope === 'owned' && seatIncarnationStatus(registry, retirements, row.seat ?? '', row.seat_id) === 'unaccounted',
  );
}

/** A seat as `Initialize-SeatForFixture` leaves one: a registry row with a fresh incarnation, and its Desk. */
function plantSeat(stateDirectory: string, seat: string, project: string): void {
  const registryPath = path.join(stateDirectory, 'seats', '_registry.json');
  const seats = fs.existsSync(registryPath) ? ((parseJsonFile(registryPath) as Json)['seats'] as Json[]) : [];
  seats.push({ seat, project, seat_id: randomUUID() });
  fs.mkdirSync(path.join(stateDirectory, 'seats', seat), { recursive: true });
  for (const file of ['.open-books', '.open-projects']) fs.writeFileSync(path.join(stateDirectory, 'seats', seat, file), '');
  fs.writeFileSync(registryPath, psConvertToJson({ schema: 1, seats } as unknown as PsJsonValue) + '\n');
}

/**
 * The retirement classifier, driven over four PLANTED states through the real selector, and then this
 * workspace's own seats and owned topics accounted for. The planted half is the kernel's own selector
 * answering, not a transcription of the PowerShell one's answers.
 */
function seatRetirementIdentity(workspace: string): string {
  const problems: string[] = [];
  const fixture = path.join(os.tmpdir(), 'seat-retire-' + randomUUID().replace(/-/g, '').substring(0, 8));
  try {
    const fixtureState = path.join(fixture, '.claude');
    for (const directory of [fixtureState, path.join(fixture, 'notebook'), path.join(fixture, 'internal')]) fs.mkdirSync(directory, { recursive: true });
    for (const seat of ['actor', 'living']) plantSeat(fixtureState, seat, `${seat}-proj`);
    for (const topic of ['actor-topic', 'living-topic', 'gone-topic', 'stranded-topic']) fs.mkdirSync(path.join(fixture, 'notebook', topic), { recursive: true });
    setNotebookTopicOwner({ workspace: fixture, topic: 'actor-topic', seat: 'actor', actingSeat: 'actor', scope: 'owned' });
    setNotebookTopicOwner({ workspace: fixture, topic: 'living-topic', seat: 'living', actingSeat: 'living', scope: 'owned' });
    const planted: OwnerRow[] = [
      ...readNotebookTopicOwners(fixture).topics,
      { topic: 'gone-topic', scope: 'owned', seat: 'gone', project: 'gone-proj', recorded_utc: '2026-01-01T00:00:00.0000000Z', seat_id: 'gone-one' },
      { topic: 'stranded-topic', scope: 'owned', seat: 'stranded', project: 'stranded-proj', recorded_utc: '2026-01-01T00:00:00.0000000Z', seat_id: 'stranded-one' },
    ];
    const ownersLock = enterBookLock(fixture, NOTEBOOK_OWNERS_LOCK_ROOT);
    try {
      writeNotebookTopicOwners(fixture, planted);
    } finally {
      exitBookLock(ownersLock);
    }
    const archive = path.join(fixture, 'internal', 'seat-archive', 'gone-20260101-000000');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'seat.json'), '{"seat":"gone","seat_id":"gone-one","project":"gone-proj","retired_utc":"2026-01-01T00:00:00.0000000Z"}\n');

    const select = (): ReturnType<typeof notebookResetTargets> => {
      const lock = enterSeatRegistryLock(fixture);
      try {
        return notebookResetTargets({ workspace: fixture, seat: 'actor', wholeTree: true, allIdleSeats: false });
      } finally {
        exitBookLock(lock);
      }
    };
    const selection = select();
    const expected: { bucket: 'targets' | 'foreign' | 'retired' | 'unaccounted'; topics: string; why: string }[] = [
      { bucket: 'targets', topics: 'actor-topic,gone-topic', why: "this seat's own topic and the one whose seat has a retirement record" },
      { bucket: 'foreign', topics: 'living-topic', why: 'the topic of a seat that is still registered' },
      { bucket: 'retired', topics: 'gone-topic', why: 'the topic of the one seat with a retirement record' },
      { bucket: 'unaccounted', topics: 'stranded-topic', why: 'the topic of a seat with neither a registry entry nor a retirement record' },
    ];
    for (const row of expected) {
      const actual = selection[row.bucket].map((entry) => entry.topic).sort().join(',');
      if (actual !== row.topics) problems.push(`reset selection put '${actual}' in ${row.bucket} where it should hold ${row.topics} -- ${row.why}`);
    }
    if (!selection.refusals.join(' ').includes('cannot be accounted for')) {
      problems.push('a whole-tree reset over a seat with no registry entry and no retirement record did not refuse');
    }
    const swept = unaccountedOwnership(fixture).map((row) => row.topic).sort().join(',');
    if (swept !== 'stranded-topic') problems.push(`the ownership sweep found '${swept}' where the fixture plants exactly stranded-topic`);
    fs.rmSync(path.join(archive, 'seat.json'), { force: true });
    if (select().targets.some((row) => row.topic === 'gone-topic')) {
      problems.push('an archive with no seat.json still licensed a whole-tree reset over the topics it names');
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  const consistency = seatRegistryConsistency(workspace, path.join(workspace, '.claude')) as Json;
  for (const fault of asList(consistency['faults'])) problems.push(String(fault));
  for (const row of unaccountedOwnership(workspace)) {
    problems.push(
      `notebook/${row.topic} is owned by seat '${row.seat}', which has no registry entry and no ` +
        'retirement record in internal/seat-archive/: no reset can reach that topic and the seat name cannot be reused. ' +
        'Take it over with tools/Set-NotebookTopicOwner.ps1, or declare it shared.',
    );
  }
  const ownedHere = notebookOwnershipInventory(workspace).filter((row) => row.scope === 'owned').length;
  if (problems.length) throw new Error(problems.join('; '));
  return (
    '4 planted states classified by the real selector, the archive record proved load-bearing, the ownership sweep caught its planted row, ' +
    `and this workspace's ${asList(consistency['seats']).length} seat(s) and ${ownedHere} owned topic(s) all accounted for`
  );
}

function masterIndexRenders(workspace: string): string {
  // UNDER ADR-0029 EVERY SEAT'S ROOT HAS ITS OWN INDEX, and each is held to its topics exactly as the
  // shared one was. A workspace still in the shared layout -- or a fresh one, which is that layout
  // with nothing in it -- is read as it is.
  if (readNotebookLayout(workspace).state === 'seat-owned') {
    const problems: string[] = [];
    let topics = 0;
    const seats = seatNotebookRoots(workspace);
    for (const seat of seats) {
      const relative = `notebook/${seat}`;
      const root = path.join(workspace, 'notebook', seat);
      const scope = { workspace, layout: 'seat-owned' as const, activates: false, seat, root, relative };
      problems.push(...scopeIndexDrift(scope));
      try {
        topics += notebookTopicInventory(root, relative).length;
      } catch {
        // Already reported by the drift check above, in its own words.
      }
    }
    if (problems.length) throw new Error(problems.join('; '));
    return `each of ${seats.length} seat Notebook index(es) matches its ${topics} topic(s) on disk and their headings`;
  }
  const problems = masterIndexDrift(workspace);
  if (problems.length) throw new Error(problems.join('; '));
  return `notebook/_master-index.md matches the ${notebookTopicInventory(path.join(workspace, 'notebook')).length} topic(s) on disk and their headings`;
}

function catalogRendersFromEntries(workspace: string, program: string): string {
  const problems: string[] = [];
  const catalogPath = path.join(workspace, 'shelf', '_catalog.md');
  if (!fs.existsSync(path.join(workspace, 'shelf'))) problems.push('shelf/ is missing');
  else if (!fs.existsSync(catalogPath)) problems.push('shelf/_catalog.md is missing');
  else {
    let expected: string | null = null;
    try {
      expected = shelfCatalogText(workspace, program);
    } catch (error) {
      problems.push(`the Shelf cannot be rendered: ${(error as Error).message}`);
    }
    if (expected !== null && readStrictUtf8(catalogPath) !== expected) {
      problems.push('shelf/_catalog.md does not match the tracked header plus the validated entry files; re-render it with deskpost shelf render');
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return `shelf/_catalog.md matches the tracked header plus ${shelfCatalogEntryInventory(workspace).entries.length} validated entry file(s)`;
}

function outputNamespaced(workspace: string): string {
  const outputRoot = path.join(workspace, 'output');
  if (!fs.existsSync(outputRoot) || !fs.statSync(outputRoot).isDirectory()) return 'output/ does not exist yet';
  const items = fs.readdirSync(outputRoot, { withFileTypes: true });
  const loose = items.filter((item) => item.isFile()).map((item) => item.name);
  if (loose.length) {
    throw new Error(
      `${loose.length} file(s) sit directly in output/: ${loose.sort().join(', ')}. ` +
        'A deliverable goes under its project slug -- output/<project-slug>/<name>.md -- because every ' +
        'seat in this workspace shares one output/, so two projects writing output/report.md collide.',
    );
  }
  const slugs = items.filter((item) => item.isDirectory()).map((item) => item.name);
  const bad = slugs.filter((slug) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
  if (bad.length) throw new Error(`output/ holds directory(ies) that are not project slugs: ${bad.sort().join(', ')}`);
  return `${slugs.length} project namespace(s), no loose files`;
}

// --- The program's own checks (PLAN-install-onboarding.md step 9, ADR-0055) -------------------------------

function samePath(left: string, right: string): boolean {
  // BY NAME, THEN PHYSICALLY (post-build inspection #10): a PATH entry spelled through a junction, subst or 8.3 name is the same shim.
  if (process.platform === 'win32' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()) return true;
  try {
    const [a, b] = [fs.realpathSync.native(left), fs.realpathSync.native(right)];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/**
 * WHETHER TYPING `deskpost` RUNS THIS INSTALL. Only an installed program is asked: a checkout run from source, or a
 * release tree being checked, has no command to resolve and says so. A shim that resolves elsewhere -- another
 * install's `bin`, an earlier PATH entry -- fails, naming it, because a reader typing the word would run that one.
 * Not on PATH fails too, unless the receipt records that the reader chose `-NoPathChange` (step 7).
 */
function commandResolves(program: string): string {
  const root = installRootOf(program);
  if (root === null) return `SKIP: this program is not an installed release (it runs from ${program}), so no \`${COMMAND_NAME}\` command is expected`;
  const shim = installShim(root);
  const found = resolveOnPath(COMMAND_NAME);
  const expected = process.platform === 'win32' ? shim : path.join(program, 'bin', 'library');
  if (found !== null && samePath(found, expected)) return `\`${COMMAND_NAME}\` resolves to this install (${found})`;
  if (found !== null) {
    throw new Error(
      `\`${COMMAND_NAME}\` in this terminal runs ${found}, not this install's ${expected}: an earlier PATH entry shadows it. ` +
        `Remove that entry, or put ${path.dirname(shim)} before it.`,
    );
  }
  if (process.platform === 'win32' && !fs.existsSync(shim)) throw new Error(`this install has no ${shim}, so \`${COMMAND_NAME}\` cannot run it. Re-run the installer to put it back.`);
  if (readInstallReceipt(root)?.['path_change'] === false) {
    return `WARN: \`${COMMAND_NAME}\` is not on PATH, as chosen at install (-NoPathChange); run it as ${expected}`;
  }
  throw new Error(
    `\`${COMMAND_NAME}\` is not on this terminal's PATH, so typing it runs nothing. Open a new terminal; if it is still ` +
      `missing, add ${path.dirname(shim)} to your user PATH or re-run the installer.`,
  );
}

/** Which assistant can be the Librarian here: informational, never a failure (step 9). */
function assistantPresent(): string {
  const claude = findAssistant('claude');
  const codex = findAssistant('codex');
  if (claude === null && codex === null) {
    return 'WARN: no assistant found: install Claude Code or Codex to talk to the Librarian. Deskpost itself works without one.';
  }
  return [claude !== null ? `Claude Code at ${claude}` : null, codex !== null ? `Codex at ${codex}` : null].filter((part) => part !== null).join('; ');
}

/** Codex's version and configured sandbox, read only; an uncertain assessment is always a warning. */
function codexVersion(): string {
  try {
    const found = findAssistant('codex');
    if (found === null) return 'SKIP: no Codex on this machine';
    const warnings: string[] = [];
    const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(found);
    const command = batch ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe') : found;
    const args = batch ? ['/d', '/s', '/c', `""${found}" --version"`] : ['--version'];
    const ran = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, ...(batch ? { windowsVerbatimArguments: true } : {}) });
    const printed = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.slice(0, 200).replace(/\s+/g, ' ').trim();
    const version = parseCodexVersion(ran.stdout ?? '');
    if (ran.error) {
      const error = ran.error as NodeJS.ErrnoException;
      warnings.push(`--version ${error.code === 'ETIMEDOUT' ? 'timed out after 10000ms' : `could not run (${error.code ?? error.message})`}: ${printed}`);
    } else if (ran.status !== 0) {
      warnings.push(`--version exited ${ran.status ?? `on signal ${ran.signal}`}: ${printed}`);
    } else if (version === null) {
      warnings.push(`--version printed no version: ${printed}`);
    }
    if (version !== null && compareVersions(version, CODEX_HOOK_HASH_CHECKED) > 0) {
      warnings.push(`newer than ${CODEX_HOOK_HASH_CHECKED}, the version doctor's hook review check was checked against, so its stale-hook verdicts may be wrong until Deskpost is updated`);
    }
    const home = codexHomeDirectory(), config = path.join(home, 'config.toml');
    let settings = codexSandboxSettings(''), configDetail = `from ${config}`, configPresent = false;
    try {
      const stat = fs.statSync(config);
      configPresent = true;
      if (!stat.isFile()) throw new Error('not a readable file');
      settings = codexSandboxSettings(fs.readFileSync(config, 'utf8'));
    } catch (error) {
      if (!configPresent && (error as NodeJS.ErrnoException).code === 'ENOENT') configDetail = `no config.toml in ${home}`;
      else warnings.push(`config exists but cannot be read at ${config} (${(error as NodeJS.ErrnoException).code ?? 'not a readable file'})`);
    }
    const detail = `${version === null ? 'Codex' : `codex-cli ${version}`} at ${found}; sandbox: ${settings.sandbox_mode ?? 'sandbox_mode not set'}, Windows ${settings.windows_sandbox ?? 'not set'} (${configDetail})`;
    return `${warnings.length ? 'WARN: ' : ''}${detail}${warnings.length ? `; ${warnings.join('; ')}` : ''}`;
  } catch (error) {
    return `WARN: could not assess Codex version and sandbox (${(error as NodeJS.ErrnoException).code ?? 'read or process error'})`;
  }
}

/**
 * WHERE A SEAT'S FOLDERS COME FROM, AND WHETHER THEY ARE STILL THERE (1.2.5, ADR-0061). Two things WARN, never FAIL:
 * a folder a seat's record names that is gone, which `seat start` skips; and an `additionalDirectories` entry in the
 * workspace's own Claude settings that points outside the Library, which every seat reads -- what `/add-dir` with
 * "remember" writes (Report 2026-09-29). Doctor never edits either file.
 */
function seatAddedFolders(workspace: string): string {
  const stateDirectory = path.join(workspace, '.claude');
  const problems: string[] = [];
  let recorded = 0;
  for (const row of readSeatRegistry(stateDirectory)) {
    let dirs: { path: string; exists: boolean }[] = [];
    try {
      dirs = addedDirsStatus(stateDirectory, row.seat);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    recorded += dirs.length;
    for (const dir of dirs.filter((candidate) => !candidate.exists)) {
      problems.push(`seat '${row.seat}' records the added folder ${dir.path}, which no longer exists; remove it with deskpost seat dirs ${row.seat} --remove "${dir.path}"`);
    }
  }
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(stateDirectory, name);
    if (!fs.existsSync(file)) continue;
    let entries: unknown;
    try {
      entries = (JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { permissions?: { additionalDirectories?: unknown } })?.permissions?.additionalDirectories;
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')) {
      const resolved = path.resolve(workspace, entry);
      if (isAtOrInside(resolved, workspace)) continue;
      problems.push(
        `${entry} in .claude/${name} is outside this Library, and every seat can read this folder; record it for one seat with ` +
          `deskpost seat dirs <seat> --add "${resolved}", then remove it from .claude/${name}`,
      );
    }
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  return recorded ? `${recorded} added folder${recorded === 1 ? '' : 's'} recorded across the seats, all present; no workspace setting adds a folder outside the Library` : 'no seat records an added folder, and no workspace setting adds a folder outside the Library';
}

/**
 * EACH SEAT'S INBOUND FILE, VALIDATED AS THE LAUNCHER VALIDATES IT (1.3.1, kickoffs/s79 row 3, ADR-0062): one that
 * fails is never passed, so the seat starts without the policy it was given. A WARN naming the seat and the fix.
 */
function seatInboundFiles(workspace: string): string {
  const stateDirectory = path.join(workspace, '.claude');
  const problems: string[] = [];
  let set = 0;
  for (const row of readSeatRegistry(stateDirectory)) {
    const read = readInboundSettings(stateDirectory, row.seat);
    if (read.state === 'valid') set += 1;
    if (read.state === 'invalid') {
      problems.push(`seat '${row.seat}''s inbound file is invalid and is never passed: ${read.reason}; set it again with deskpost seat settings ${row.seat} --inbound accept|hold|refuse|unset`);
    }
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  return set ? `${set} seat${set === 1 ? ' sets' : 's set'} an inbound policy, each file valid` : 'no seat sets an inbound policy';
}

/**
 * A SEAT'S CARD, DEPARTMENT, ROLE AND TEMPLATE (1.3.8, kickoffs/s96 rows 1 and 2, rulings 3 and 4; ADR-0069): every value
 * the one projection reads as absent, named with its repair and never printed, since a malformed card may hold what the
 * rule keeps off a terminal; and the registry history's lines that do not parse and its unconfirmed attempts (an attempt
 * with no commit line after the seat's last confirmed change), each naming the file. A WARN, never a FAIL.
 */
function seatRegistryFields(workspace: string): string {
  const stateDirectory = path.join(workspace, '.claude');
  const projection = readSeatMetadata(stateDirectory);
  const problems = [...projection.problems];
  const history = readSeatHistory(workspace);
  for (const line of history.unparsable) {
    problems.push(line === 0 ? `${history.file} cannot be read` : `line ${line} of ${history.file} does not parse and is ignored; remove it by hand once you have read it`);
  }
  let registry: ReturnType<typeof readSeatRegistry> = [];
  try {
    registry = readSeatRegistry(stateDirectory);
  } catch {
    // the registry's own checks say why; the projection above already read what it could
  }
  const identity = identityView(registry, []);
  for (const row of registry) {
    const unconfirmed = seatHistoryState(history, row.seat, row.seatId, identity).unconfirmed;
    if (unconfirmed) {
      problems.push(
        `seat '${row.seat}' has ${unconfirmed} unconfirmed attempt${unconfirmed === 1 ? '' : 's'} in ${history.file}: a change whose commit line was never written, so whether it reached the registry cannot be said; ` +
          `check the seat with deskpost seat status, and set it again with deskpost seat describe if it is not as intended`,
      );
    }
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  const carrying = [...projection.seats.values()].filter((meta) => METADATA_FIELDS.some((field) => meta[field] !== null)).length;
  return carrying
    ? `${carrying} seat${carrying === 1 ? ' carries' : 's carry'} a card, department, role or template, each valid`
    : 'no seat carries a card, department, role or template';
}

/**
 * EVERY LETTER'S LINKS AND IDENTITY FIELDS ARE WHOLE (kickoffs/s98 row 2; PLAN-seats-team.md session 3 item 2): a WARN
 * naming each note of a Book that takes letters which carries a reserved key twice, or `answers`, `answered_by`,
 * `routed_to`, `routed_from`, `hops`, `origin_seat`, `for_department`, `origin_seat_id` or `for_seat_id` of the wrong
 * shape. Such a letter is shown with no links and its status from `review` alone; `--answers` and `--routes` refuse it.
 * Never a write: the repair is by hand, or a triage close.
 */
function lettersRelationshipFields(workspace: string): string {
  const problems: string[] = [];
  let notes = 0;
  // EVERY CAPTURE BOOK SINCE s130 (row 3; the plan r3, decision 9), under the same registered name: a Report's reserved
  // keys are checked as a letter's are, and an update_count that does not match its `## Update` sections is named.
  for (const book of captureBookRows(workspace)) {
    for (const note of shelfNotes(book)) {
      notes += 1;
      if (note.malformed.length) problems.push(`${book.slug} ${note.page} carries ${note.malformed.join(', ')} twice or of the wrong shape; repair its frontmatter by hand, or close it with triage`);
      if (note.updateCount !== null) {
        const sections = (readUtf8(note.fullPath).match(/^## Update /gm) ?? []).length;
        if (sections !== note.updateCount) problems.push(`${book.slug} ${note.page} records update_count ${note.updateCount} but has ${sections} ## Update section${sections === 1 ? '' : 's'}; repair its frontmatter by hand`);
      }
    }
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  return notes ? `${notes} capture note${notes === 1 ? "'s" : "s'"} reserved fields are whole` : 'no capture note to check';
}

/**
 * EVERY PENDING LETTER IS FOR A SEAT THAT IS STILL THERE (1.3.8, kickoffs/s96 row 1, ruling 3; PLAN-seats-team.md Risks,
 * "What a stale delivery means"): a WARN for a pending letter whose `for_seat` is no longer in the registry, or whose
 * `for_seat_id` (written from session 3) names another incarnation of that slug. A letter with no `for_seat_id` matches
 * by slug, the legacy rule. Its writer closes it, or the reader with `other_seat`. Never a write.
 *
 * A SEAT IS JUDGED ONLY IN ITS OWN LIBRARY (kickoffs/s133 row 1; PLAN-many-libraries.md Stage 1 item 3): a letter whose
 * `for_library_id` names another Library is this Library's copy of a letter to that Library's seat, so it is not judged
 * against this registry; it is counted apart. An empty id is this Library's; a malformed one, or a note whose own
 * Library's id cannot be read, keeps the judgement above, so an unreadable marker never hides a real WARN.
 */
function lettersRecipientIncarnation(workspace: string): string {
  let registry: ReturnType<typeof readSeatRegistry>;
  try {
    registry = readSeatRegistry(path.join(workspace, '.claude'));
  } catch (error) {
    return `SKIP: the seat registry cannot be read, so no letter's recipient can be checked: ${(error as Error).message}`;
  }
  const problems: string[] = [];
  let pending = 0;
  let elsewhere = 0;
  // BY IDENTITY (kickoffs/s103 row 3): a letter the projection joins to a live seat, under its name or one the seat gave
  // up by a rename, is that seat's; otherwise its name says which of the two it is.
  const identity = identityView(registry, []);
  for (const book of captureBookRows(workspace)) {
    for (const note of shelfNotes(book)) {
      if (note.review === 'done' || !note.forSeat) continue;
      // Another Library's side by `isThisLibrary`, and only once this Library's own id was read.
      if (note.localLibraryId && !isThisLibrary(note.forLibraryId, note.localLibraryId) && !note.malformed.includes('for_library_id')) {
        elsewhere += 1;
        continue;
      }
      pending += 1;
      const closes = `${note.fromSeat ? `its writer '${note.fromSeat}' closes it` : 'the reader closes it'}, or the reader with other_seat`;
      const forSeatId = (noteFrontmatter(readUtf8(note.fullPath)).get('for_seat_id') ?? '').trim();
      if (incarnationOf(identity, note.forSeat, forSeatId || null, 'letters').outcome === 'live') continue;
      const row = registry.find((candidate) => candidate.seat === note.forSeat);
      if (!row) {
        problems.push(`${book.slug} ${note.page} is a pending letter for seat '${note.forSeat}', which is not in the registry; ${closes}`);
        continue;
      }
      problems.push(`${book.slug} ${note.page} is a pending letter for seat '${note.forSeat}' that was addressed to another incarnation of it (for_seat_id ${forSeatId}); ${closes}`);
    }
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  const apart = elsewhere ? `; ${elsewhere} pending letter${elsewhere === 1 ? ' is' : 's are'} for another Library's seats, judged in that Library` : '';
  return (pending ? `${pending} pending letter${pending === 1 ? ' is' : 's are'} each for a seat in the registry` : 'no pending letter is addressed to a seat') + apart;
}

/**
 * EVERY SEAT IS ONE IDENTITY (kickoffs/s103 row 6; PLAN-seat-identity.md section 1): a FAIL naming each registry row
 * whose `seat_id` is malformed or shared with another row, each name history that does not parse, each name two seats'
 * histories share (a seat's past name that another live seat is called now included), each retirement record that
 * cannot be read, and each letter whose `for_seat_id` or `origin_seat_id` names no seat in the registry and no retirement
 * record. A row with no id at all (pre-identity) is not a failure, and a malformed letter id is the relationship-fields
 * check's. Never a write: every repair is by hand.
 *
 * A SEAT ID BELONGS TO THE LIBRARY ITS SIDE NAMES (kickoffs/s133 row 1; PLAN-many-libraries.md Stage 1 item 3):
 * `for_seat_id` is judged here only when `for_library_id` is this Library's, `origin_seat_id` only when
 * `origin_library_id` is, and `from_seat_id` only when `from_library_id` is; an id on another Library's side cannot be in
 * this registry, so it is counted apart and judged in that Library. An empty id is this Library's; a malformed one, or a
 * note whose own Library's id cannot be read, keeps today's judgement, so an unreadable marker never hides a real FAIL.
 */
function seatsIdentity(workspace: string): string {
  let registry: ReturnType<typeof readSeatRegistry>;
  try {
    registry = readSeatRegistry(path.join(workspace, '.claude'));
  } catch (error) {
    return `SKIP: the seat registry cannot be read, so no seat's identity can be checked: ${(error as Error).message}`;
  }
  const view = identityView(registry, []);
  const problems: string[] = [];
  for (const row of view.live) {
    if (row.identity === 'invalid') {
      const sharing = view.live.filter((other) => other !== row && other.seatId === row.seatId).map((other) => `'${other.seat}'`);
      problems.push(
        sharing.length
          ? `seat '${row.seat}' shares its seat_id ${row.seatId} with seat ${sharing.join(', ')}, so no record is matched to either by id; give each its own id (32 lowercase hex characters) by hand`
          : `seat '${row.seat}' has a seat_id that is not 32 lowercase hex characters (${JSON.stringify(row.seatId)}), so no record is matched to it by id; repair it by hand`,
      );
    }
    if (row.namesProblem !== null) problems.push(`seat '${row.seat}' has a names history that does not parse (${row.namesProblem}), and reads as its one current name until it is repaired by hand`);
  }
  const holders = new Map<string, string[]>();
  for (const row of view.live) for (const span of row.names) holders.set(span.name, [...(holders.get(span.name) ?? []), row.seat]);
  for (const [name, seats] of [...holders].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (seats.length < 2) continue;
    const current = view.live.find((row) => row.seat === name);
    problems.push(
      current
        ? `the name '${name}' is seat '${name}''s now, and also in the name history of seat ${seats.filter((seat) => seat !== name).map((seat) => `'${seat}'`).join(', ')}, so a record under it cannot be told apart; repair the history by hand`
        : `the name '${name}' is in the name history of more than one seat (${seats.map((seat) => `'${seat}'`).join(', ')}), so a record under it cannot be told apart; repair the histories by hand`,
    );
  }
  const retirement = readSeatRetirementRecords(workspace);
  problems.push(...retirement.faults);
  const known = new Set([...view.live.map((row) => row.seatId), ...retirement.records.map((record) => record.seat_id)].filter((id) => id !== ''));
  let recorded = 0;
  let elsewhere = 0;
  for (const book of captureBookRows(workspace)) {
    for (const note of shelfNotes(book)) {
      const sides = [
        ['for_seat_id', note.forSeatId, 'for_library_id', note.forLibraryId],
        ['origin_seat_id', note.originSeatId, 'origin_library_id', note.originLibraryId],
        ['from_seat_id', note.fromSeatId, 'from_library_id', note.fromLibraryId],
      ] as const;
      for (const [field, id, libraryField, libraryId] of sides) {
        if (id === null || note.malformed.includes(field)) continue;
        // The same rule as lettersRecipientIncarnation's.
        if (note.localLibraryId && !isThisLibrary(libraryId, note.localLibraryId) && !note.malformed.includes(libraryField)) {
          elsewhere += 1;
          continue;
        }
        recorded += 1;
        if (!known.has(id)) problems.push(`${book.slug} ${note.page} records ${field} ${id}, which names no seat in the registry and no retirement record`);
      }
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return `${view.live.length} seat${view.live.length === 1 ? '' : 's'}, each with ${view.live.every((row) => row.identity === 'valid') ? 'its own id' : 'its own id or none'} and its own names; ${recorded} recorded letter id${recorded === 1 ? '' : 's'}, each naming a seat or a retirement record${elsewhere ? `; ${elsewhere} letter id${elsewhere === 1 ? ' names' : 's name'} another Library's seats, judged in that Library` : ''}`;
}

/**
 * A USER-LEVEL `crossSessionInbound` (ADR-0062): Claude Code reads it for every session this user runs, every seat's
 * included, so it is the one place the Library never writes the value. A WARN naming the per-seat route. Read only.
 */
function userInboundSetting(): string {
  const file = userSettingsPath();
  if (!fs.existsSync(file)) return `no user settings file at ${file}, so no user-level crossSessionInbound`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return `SKIP: ${file} is not valid JSON, so whether it sets crossSessionInbound cannot be read`;
  }
  if (parsed === null || typeof parsed !== 'object' || !(INBOUND_KEY in parsed)) return `${file} sets no crossSessionInbound`;
  const value = JSON.stringify((parsed as Record<string, unknown>)[INBOUND_KEY]);
  return (
    `WARN: ${file} sets crossSessionInbound to ${value}, which applies to every session you run, every seat's included. ` +
    'Remove it there and set each seat its own with deskpost seat settings <seat> --inbound accept|hold|refuse'
  );
}

/**
 * WHERE `crossSessionInbound` IS SET, AND TO WHAT (1.3.8, kickoffs/s96 row 5, rulings 7 and 8; PLAN-seats-team.md session
 * 1 row 5; ADR-0069's open question): this Library's `.claude/settings.local.json` and `.claude/settings.json`, each
 * seat's own file, and the user level, in their own words. Informational: it never WARNs on `hold` (a stricter choice),
 * never writes, and names the per-seat route only (the workspace route waits on ADR-0062:28's live check).
 */
function inboundOverview(workspace: string): string {
  const read = (file: string): string | null => {
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || !(INBOUND_KEY in parsed)) return null;
      return JSON.stringify((parsed as Record<string, unknown>)[INBOUND_KEY]);
    } catch {
      return 'unreadable (not valid JSON)';
    }
  };
  const set: string[] = [];
  if (workspace) {
    const stateDirectory = path.join(workspace, '.claude');
    for (const name of ['settings.local.json', 'settings.json']) {
      const value = read(path.join(stateDirectory, name));
      if (value !== null) set.push(`this Library's .claude/${name}: ${value}`);
    }
    let registry: ReturnType<typeof readSeatRegistry> = [];
    try {
      registry = readSeatRegistry(stateDirectory);
    } catch {
      // the registry's own checks say why; the Library's files above are still reported
    }
    for (const row of registry) {
      const seatFile = readInboundSettings(stateDirectory, row.seat);
      if (seatFile.state === 'valid') set.push(`seat '${row.seat}''s own file: "${seatFile.value}"`);
      if (seatFile.state === 'invalid') set.push(`seat '${row.seat}''s own file: invalid, never passed`);
    }
  }
  const user = read(userSettingsPath());
  if (user !== null) set.push(`user settings ${userSettingsPath()}: ${user}`);
  const route = 'A seat accepts its peers\' messages with deskpost seat settings <seat> --inbound accept.';
  if (!set.length) return `nothing sets crossSessionInbound, so Claude Code's own default applies: two sessions that prompt for permission deliver each other's messages at once, and a session that bypasses permissions holds every message from a prompting one behind an approval dialog. ${route}`;
  return `crossSessionInbound is set in ${set.length} place${set.length === 1 ? '' : 's'}: ${set.join('; ')}. ${route}`;
}

/**
 * EVERY CAPTURE BOOK SAYS WHO CLOSES ITS NOTES (S73 row 4). Keyed on the capture Kind, never on a slug. An entry with
 * no `- **Closed by:**` line is any-seat at runtime, as every Book was before the line, and an unrecognised value reads
 * as `writer`; both WARN with the one-line edit. Doctor never edits an entry: the reader does, then renders.
 */
function captureBooksSayWhoCloses(workspace: string): string {
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) return 'SKIP: this Library has no Shelf catalog, so no capture Book to check';
  const problems: string[] = [];
  let checked = 0;
  for (const section of shelfCatalogSections(readUtf8(catalogFile))) {
    if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
    const slug = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body)?.[1];
    if (!slug) continue;
    checked += 1;
    const declared = getShelfBook(workspace, slug).closedByDeclared ?? null;
    const edit = `add the line '- **Closed by:** writer' (or 'any', as the Report Inbox's is) to shelf/${slug}/_catalog-entry.md, then run deskpost shelf render`;
    if (declared === null) problems.push(`capture Book '${slug}' does not say who closes its notes, so any seat may; ${edit}`);
    else if (!['writer', 'any'].includes(declared)) problems.push(`capture Book '${slug}' says '- **Closed by:** ${declared}', which reads as writer; ${edit.replace('add the line', 'make the line')}`);
  }
  if (problems.length) return `WARN: ${problems.join('; ')}`;
  return checked ? `${checked} capture Book${checked === 1 ? '' : 's'}, each saying who closes its notes` : 'no capture Book on the Shelf';
}

/**
 * WHETHER A CAPTURE BOOK IS GROWING (S77 row 2, PLAN-holding-discipline.md row 6): past its pending count or the age
 * of its oldest pending note, from its own `Growing at:` line or 5 and 7. A WARN and never a FAIL, since a growing
 * Shelf is a signal that the Library lacks a home, not a defect; and counts only, since the Book may be closed.
 */
function captureBooksGrowing(workspace: string): string {
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) return 'SKIP: this Library has no Shelf catalog, so no capture Book to check';
  const growing: string[] = [];
  const unread: string[] = [];
  let checked = 0;
  // BY RECIPIENT (kickoffs/s109 ruling 2): a letter for a live seat is that seat's to close, so the reader is told to open
  // the seat, not to triage. Read once; a registry that cannot be read leaves every letter counted as growing.
  let identity: ReturnType<typeof identityView> | null = null;
  try {
    identity = identityView(readSeatRegistry(path.join(workspace, '.claude')), readSeatRetirementRecords(workspace).records);
  } catch {
    identity = null;
  }
  // ONLY A BOOK THAT TAKES LETTERS counts by recipient; the Holding Shelf's notes are its writers' and grow as before.
  const letterBooks = new Set(captureBookRows(workspace).filter((row) => row.takesLetters).map((row) => row.slug));
  for (const section of shelfCatalogSections(readUtf8(catalogFile))) {
    if (!/^[ \t]*-[ \t]+\*\*Kind:\*\*[ \t]+capture[ \t]*$/m.test(section.body)) continue;
    const slug = /^[ \t]*-[ \t]+\*\*Path:\*\*[ \t]+shelf\/([a-z0-9][a-z0-9-]*)[ \t]*$/m.exec(section.body)?.[1];
    if (!slug) continue;
    checked += 1;
    const book = getShelfBook(workspace, slug);
    if (book.growingDeclared !== null && book.growingDeclared !== undefined && parseGrowingAt(book.growingDeclared) === null) {
      unread.push(`capture Book '${slug}' says '- **Growing at:** ${book.growingDeclared}', which is not '<n> pending or <d> days', so the defaults (${DEFAULT_GROWING_PENDING} pending or ${DEFAULT_GROWING_DAYS} days) apply`);
    }
    const notes = shelfNotes(book);
    if (!growingState(book, notes, null).growing) continue;
    const open = notes.filter((note) => note.review !== 'done');
    // In a Book closed by recipient, a pending letter whose recipient is a live seat waits for that seat; what is left
    // (letters to a retired or unknown seat, and notes for no one) is what the Book's own growing signal counts.
    const waiting = new Map<string, number>();
    const rest = (book.closedBy ?? 'any') === 'any' || identity === null || !letterBooks.has(slug)
      ? open
      : open.filter((note) => {
          const reached = incarnationOf(identity!, note.forSeat, note.forSeatId, 'letters');
          if (reached.outcome !== 'live') return true;
          const name = reached.current_name ?? note.forSeat!;
          waiting.set(name, (waiting.get(name) ?? 0) + 1);
          return false;
        });
    const parts: string[] = [];
    if (waiting.size) {
      const total = [...waiting.values()].reduce((sum, count) => sum + count, 0);
      const bySeat = [...waiting.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([seat, count]) => `${seat} ${count}`);
      parts.push(
        `capture Book '${slug}': ${total} letter${total === 1 ? ' waits' : 's wait'} for ${waiting.size === 1 ? 'its recipient' : 'their recipients'}: ${bySeat.join(', ')}; ` +
          `open ${waiting.size === 1 ? 'that seat' : 'those seats'}, where each recipient reads and closes its own`,
      );
    }
    if (rest.length && growingState(book, rest, null).growing) {
      parts.push(
        `capture Book '${slug}' is growing: ${rest.length} pending${waiting.size ? ' with no live recipient' : ''}, past ${book.growingPending} pending or ${book.growingDays} days; ` +
          `open it with deskpost desk open book ${slug} --location shelf and triage its notes`,
      );
    }
    growing.push(...parts);
  }
  if (growing.length || unread.length) return `WARN: ${[...growing, ...unread].join('; ')}`;
  return checked ? `${checked} capture Book${checked === 1 ? '' : 's'}, none growing` : 'no capture Book on the Shelf';
}

/**
 * EVERY STANDARD CAPTURE BOOK IS THERE (S77 row 3, ADR-0062): `setup` never re-runs `init` on a Library it keeps, so
 * a Library made before `letters` existed lacks it until one `library init`. A WARN naming that route.
 */
function standardBooksPresent(workspace: string): string {
  const catalogFile = shelfCatalogPath(workspace);
  if (!fs.existsSync(catalogFile)) return 'SKIP: this Library has no Shelf catalog, so no standard Book to check';
  const text = readUtf8(catalogFile);
  const missing = STANDARD_SHELF_BOOK_SLUGS.filter(
    (slug) => !shelfCatalogSections(text).some((section) => new RegExp(`^[ \\t]*-[ \\t]+\\*\\*Path:\\*\\*[ \\t]+shelf/${slug}[ \\t]*$`, 'm').test(section.body)),
  );
  if (missing.length) {
    return `WARN: this Library has no ${missing.map((slug) => `'${slug}'`).join(', ')} Book, which every library init lays out; run library init ${workspace} to add ${missing.length === 1 ? 'it' : 'them'} (it adds only what is missing)`;
  }
  return `all ${STANDARD_SHELF_BOOK_SLUGS.length} standard capture Books are on the Shelf`;
}

/**
 * EVERY SHELF BOOK HAS A DISCOVERY MANIFEST (kickoffs/s149 row 3): a Book whose stored manifest is missing (it never had
 * one written) or dirty (a write did not finish) is named unread by Discovery, and nothing said so. A WARN, never a
 * FAIL: a Library made before s149 meets it after an upgrade, and `shelf rebuild` is the repair.
 */
function booksHaveManifests(workspace: string): string {
  if (!fs.existsSync(shelfCatalogPath(workspace))) return 'SKIP: this Library has no Shelf catalog, so no Book to check';
  const slugs = shelfCatalogEntryInventory(workspace).entries.map((entry) => entry.slug);
  const unread = slugs
    .map((slug) => ({ slug, stored: getStoredBookManifest(workspace, slug) }))
    .filter((book) => book.stored.status === 'missing' || book.stored.status === 'dirty');
  if (unread.length) {
    return (
      `WARN: ${unread.map((book) => `'${book.slug}' (${book.stored.status})`).join(', ')} ${unread.length === 1 ? 'has' : 'have'} no Discovery manifest, ` +
      `so Discovery names ${unread.length === 1 ? 'it' : 'them'} unread; run ${unread.map((book) => `deskpost shelf rebuild ${book.slug}`).join(', ')}`
    );
  }
  return `all ${slugs.length} Shelf Book${slugs.length === 1 ? ' has' : 's have'} a Discovery manifest`;
}

function undoIncompleteCheck(workspace: string): string {
  const incomplete = incompleteUndos(workspace);
  return incomplete.length ? `WARN: undo incomplete: ${incomplete.join('; ')}` : 'no undo or redo stopped part-way';
}

function undoMarkerLeftCheck(workspace: string): string {
  const cleared = clearLeftUndoMarkers(workspace);
  return cleared.length ? `WARN: marker left: ${cleared.join('; ')}` : 'no finished undo or redo left its dirty marker down';
}

/**
 * A LASTING RECORD NEVER LINKS INTO THE NOTEBOOK (kickoffs/s109 ruling 1): a Hub or Shelf Book line naming a Notebook
 * path that no longer exists, as a reset that came before the refusal would have left it. A WARN, with the repair.
 */
function notebookLinksResolve(workspace: string): string {
  const dead = deadNotebookLinks(workspace);
  if (!dead.length) return 'no Hub or Shelf Book line names a Notebook path that is gone';
  const shown = dead.slice(0, 10).map((link) => `${link.page} line ${link.line} (${link.path})`);
  const more = dead.length > shown.length ? `; and ${dead.length - shown.length} more` : '';
  return (
    `WARN: ${dead.length} line${dead.length === 1 ? '' : 's'} of a Hub or Shelf Book name${dead.length === 1 ? 's' : ''} a Notebook path that no longer exists: ` +
    `${shown.join('; ')}${more}. ${NOTEBOOK_LINK_REPAIR.charAt(0).toUpperCase()}${NOTEBOOK_LINK_REPAIR.slice(1)} (deskpost reset restore --list shows what a reset set aside)`
  );
}

function runCheck(check: string, body: () => string): CheckResult {
  try {
    const detail = body();
    if (detail.startsWith('WARN: ')) return { check, status: 'warn', detail: detail.substring(6) };
    if (detail.startsWith('SKIP: ')) return { check, status: 'skipped', detail: detail.substring(6) };
    return { check, status: 'pass', detail };
  } catch (error) {
    return { check, status: 'fail', detail: (error as Error).message };
  }
}

/**
 * THE POSTBOX'S OUTBOX (kickoffs/s123 row 4; PLAN-many-libraries.md item 6), from the cache alone, never a server call: a
 * WARN for a letter still waiting to be sent a day after it was written, and for one that could not be sent (a
 * different note at its path). Inbox copies left beside their delivered twin are named, never a WARN. Skipped for a
 * Library with no Postbox.
 */
function postboxOutbox(workspace: string): string {
  const { state, outbox } = postboxCache(workspace);
  if (state === null) return 'SKIP: this Library has no Postbox';
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const stale = outbox.filter((entry) => entry.state === 'unsent' && Date.parse(entry.created_utc) < dayAgo);
  const refused = outbox.filter((entry) => entry.state === 'refused');
  const left = Array.isArray(state['left_inbox_copies']) ? (state['left_inbox_copies'] as unknown[]).length : 0;
  const leftLine = left ? `; ${left} inbox ${left === 1 ? 'copy' : 'copies'} left beside ${left === 1 ? 'its' : 'their'} delivered twin, counted once and never deleted` : '';
  const problems: string[] = [];
  if (stale.length) {
    problems.push(`${stale.length} ${stale.length === 1 ? 'letter' : 'letters'} in the outbox older than a day and not yet sent (${stale.map((entry) => `${entry.delivery_id}, written ${entry.created_utc}`).join('; ')}): deskpost postbox send tries again`);
  }
  if (refused.length) {
    problems.push(`${refused.length} ${refused.length === 1 ? 'letter' : 'letters'} could not be sent (${refused.map((entry) => `${entry.delivery_id}: ${entry.refusal ?? 'refused'}`).join('; ')}); nothing was overwritten`);
  }
  if (problems.length) return `WARN: ${problems.join('; ')}${leftLine}`;
  const unsent = outbox.filter((entry) => entry.state === 'unsent').length;
  return `${outbox.length} ${outbox.length === 1 ? 'letter' : 'letters'} in the outbox, ${unsent} waiting to be sent${leftLine}`;
}

/** THE POSTBOX ANSWERED AT ITS LAST CHECK (kickoffs/s123 row 4): a WARN, from the cache, naming since when it has not. */
function postboxReachable(workspace: string): string {
  const { state } = postboxCache(workspace);
  if (state === null) return 'SKIP: this Library has no Postbox';
  const since = String(state['unreachable_since'] ?? '');
  if (since) return `WARN: the Postbox at ${String(state['url'] ?? '')} has not answered since ${since}: ${String(state['unreachable_detail'] ?? '')}`.trim();
  const last = String(state['last_check'] ?? '');
  return last ? `the Postbox answered at its last check, ${last}` : 'the Postbox has not been checked since setup';
}

/** Report warnings are local facts; doctor never contacts the Postbox server. */
function postboxReports(workspace:string):string {
  const {state}=postboxCache(workspace);
  if(state===null) return 'SKIP: this Library has no Postbox';
  const warnings:string[]=[];
  const conflict=state['reports_triager_conflict'] as {claimants?:{library_id:string;library_card:string;seat:string}[]} | null;
  if(conflict) warnings.push(`Reports triager conflict: ${(conflict.claimants ?? []).map(c=>`${c.library_card} (${c.library_id}), ${c.seat}`).join('; ')}; reports triager --follow <library> --preflight chooses one`);
  const pin=state['reports_triager'] as {library_id:string;seat:string;seat_id:string} | null;
  if(pin && pin.library_id===state['library_id'] && !readSeatIdentityView(path.join(workspace,'.claude')).live.some(row=>row.identity==='valid' && row.seat===pin.seat && row.seatId===pin.seat_id)) warnings.push(`The triaging seat ${pin.seat} is no longer a live seat; reports triager <seat> --preflight names another`);
  for(const entry of Array.isArray(state['controls_deferred'])?state['controls_deferred']:[]){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
    const row=entry as Record<string,unknown>;const age=Date.now()-Date.parse(String(row['first_deferred_utc']??''));
    if(age>86400000)warnings.push('Control '+String(row['delivery_id'])+', parent '+String(row['parent'])+', deferred '+Math.floor(age/3600000)+' hours'+(typeof row['blocked_by']==='string'?', blocked by refused control '+row['blocked_by']:''));
  }
  for(const entry of Array.isArray(state['controls_refused'])?state['controls_refused']:[]){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
    const row=entry as Record<string,unknown>;const age=Date.now()-Date.parse(String(row['first_refused_utc']??''));
    warnings.push('Control '+String(row['delivery_id'])+', parent '+String(row['parent']??'(unknown)')+', refused '+(Number.isFinite(age)?Math.max(0,Math.floor(age/3600000)):'unknown')+' hours: '+String(row['why']??'control refused'));
  }
  let inboxReadLimit='';
  try {
    for(const note of shelfNotes(getShelfBook(workspace,'reports'))) {
      const fields=noteFrontmatter(readUtf8(note.fullPath));
      const age=Date.now()-Date.parse(note.captured);
      const foreign=!!note.fromLibraryId && note.fromLibraryId!==note.localLibraryId;
      if(note.review==='pending' && fields.has('delivery_id') && fields.has('for_library_id') && !foreign && age>7*86400000) warnings.push(`Report ${fields.get('delivery_id')} pending ${Math.floor(age/86400000)} days at triaging Library ${fields.get('for_library_id')}`);
    }
  } catch(error) { inboxReadLimit=`Report Inbox not checked: ${(error as Error).message.substring(0,200)}`; }
  return warnings.length ? `WARN: ${warnings.join('; ')}${inboxReadLimit ? '; '+inboxReadLimit : ''}` : inboxReadLimit ? `SKIP: ${inboxReadLimit}` : 'No Report triager conflict, stale sent copy or missing triaging seat';
}
function postboxRecords(workspace:string):string {
  if(postboxCache(workspace).state===null) return 'SKIP: this Library has no Postbox';
  const pending=listOutstanding(workspace).filter(record=>record.payload['control_move_pending']);
  const old=listOutstanding(workspace).filter(record=>!record.payload['control_move_pending']&&Date.now()-Date.parse(record.created_utc)>3600000);
  const lines=pending.map(record=>`${record.delivery_id}, pending ${Math.max(0,Math.floor((Date.now()-Date.parse(record.created_utc))/3600000))} hours: ${record.payload['control_move_unverified']?'its server copy cannot be verified':String(record.payload['control_move_pending'])}`);
  for(const record of listOutstanding(workspace).filter(r=>r.payload['control_set_aside']))lines.push(`${record.delivery_id}, pending ${Math.max(0,Math.floor((Date.now()-Date.parse((record.payload['control_set_aside'] as {first_set_aside_utc:string}).first_set_aside_utc))/3600000))} hours: its Report changed while its control waited`);
  if(old.length)lines.push(`incomplete intent records older than an hour: ${old.map(record=>`${record.delivery_id}, pending ${record.stages.filter(s=>s.state==='pending').map(s=>s.name).join(', ')}`).join('; ')}`);
  return lines.length?'WARN: '+lines.join('; '):'No incomplete intent record older than an hour';
}

// --- The runner -----------------------------------------------------------------------------------

export interface DoctorResult {
  refusal: string | null;
  value: PsJsonValue | null;
  exitCode: number;
}

export function runDoctor(argv: string[], program: string): DoctorResult {
  const parsed = parseArguments(argv, argumentTable('doctor'));
  if (parsed.options.has('served-by')) return runServedBy(argv, parsed.options.get('served-by')!, program, parsed.options.get('registry-root'));
  if (parsed.flags.has('warnings') && !parsed.flags.has('report')) {
    return { refusal: 'doctor --warnings files WARNs too, so it needs --report: deskpost doctor --report [--warnings].', value: null, exitCode: 1 };
  }
  const resolved = resolveWorkspace({ explicit: parsed.options.get('workspace') });
  if (resolved.kind === 'conflict') return { refusal: resolved.reason ?? 'the workspace selection is contradictory', value: null, exitCode: 1 };
  const workspace = resolved.kind === 'resolved' ? path.resolve(resolved.workspace!) : '';
  const { results, programChecks: own } = doctorChecks(workspace, program);
  // GROUPED AS --served-by GROUPS THEM (kickoffs/s109 ruling 3): `program_checks` holds the program-wide checks only, and
  // the Library's own kernel checks are `library_checks`. `checks` keeps the rows the PowerShell runner compares.
  const programChecks = own.filter((row) => PROGRAM_WIDE_CHECKS.has(row.check));
  const libraryChecks = workspace ? own.filter((row) => !PROGRAM_WIDE_CHECKS.has(row.check)) : [];

  const count = (status: string): number => results.filter((row) => row.status === status).length;
  const tallyRows = (rows: { status: string }[]) => {
    const of = (status: string) => rows.filter((row) => row.status === status).length;
    return { total: rows.length, passed: of('pass'), warned: of('warn'), failed: of('fail'), skipped: of('skipped') };
  };
  const failed = count('fail');
  const programFailed = [...programChecks, ...libraryChecks].filter((row) => row.status === 'fail').length;
  return {
    refusal: null,
    value: {
      operation: 'Library Checks',
      program,
      workspace,
      total: results.length,
      passed: count('pass'),
      warned: count('warn'),
      failed,
      skipped: count('skipped'),
      checks: results as unknown as PsJsonValue,
      program_checks: programChecks as unknown as PsJsonValue,
      library_checks: libraryChecks as unknown as PsJsonValue,
      // THE COUNTS THE TEXT SAYS (kickoffs/s141 row 5): `Program:` over program_checks and `Library:` over checks and
      // library_checks, as doctorText tallies them; the counts above stay the `checks` list's, which the matrix compares.
      totals: {
        program: tallyRows(programChecks),
        library: tallyRows(workspace ? [...results, ...libraryChecks] : []),
      },
      shared_library_write: false,
      // D6: each FAIL (and WARN with --warnings) filed once into the Report Inbox; never a change to the exit code.
      ...(parsed.flags.has('report')
        ? { report: fileDoctorFindings(workspace, [...programChecks, ...libraryChecks, ...results], parsed.flags.has('warnings'), String(releaseTuple()['plugin_version'] ?? '')) }
        : {}),
    },
    exitCode: failed || programFailed ? 1 : 0,
  };
}

/** The checks that need no Library: the program's own, run once whatever the Libraries are. */
export const PROGRAM_WIDE_CHECKS = new Set(['program.command-resolves', 'program.assistant-present', 'program.codex-version', 'settings.user-inbound', 'program.refresh-finished']);

/**
 * `doctor --served-by <root>` (D8, PLAN-one-upgrade.md r6 amendment 10): every Library the install at <root> serves,
 * each with its own checks, and the registered Libraries that could not be reached, named rather than dropped. A
 * Library named with `--kept <folder>` (kept as it is, or refused by the refresh) reports a failing check as a WARN, so
 * the Library the reader chose to keep never turns the install red; any other failing check does. `--workspace` keeps
 * its one-Library shape, which the acceptance matrix compares row for row.
 */
function runServedBy(argv: string[], root: string, program: string, registryRoot: string | undefined): DoctorResult {
  // `--kept` MAY BE GIVEN MORE THAN ONCE, one folder each, so it is read off the arguments rather than the one-value map.
  const kept = argv.flatMap((item, index) => (item === '--kept' && index + 1 < argv.length ? [path.resolve(argv[index + 1]!)] : []));
  let found: { served: string[]; unreached: string[] };
  try {
    found = librariesServedByRoot(path.resolve(root), registryRoot);
  } catch (error) {
    return { refusal: (error as Error).message, value: null, exitCode: 1 };
  }
  let programChecks: CheckResult[] | null = null;
  let failed = 0;
  const libraries = found.served.map((workspace) => {
    const { results, programChecks: own } = doctorChecks(workspace, program);
    if (programChecks === null) programChecks = own.filter((row) => PROGRAM_WIDE_CHECKS.has(row.check));
    const isKept = kept.some((folder) => sameFolder(folder, workspace));
    const checks = [...results, ...own.filter((row) => !PROGRAM_WIDE_CHECKS.has(row.check))].map((row) =>
      isKept && row.status === 'fail' ? { ...row, status: 'warn', detail: `kept as it is, not brought up to date: ${row.detail}` } : row,
    );
    failed += checks.filter((row) => row.status === 'fail').length;
    return { workspace, kept: isKept, checks };
  });
  const wide = programChecks ?? doctorChecks('', program).programChecks.filter((row) => PROGRAM_WIDE_CHECKS.has(row.check));
  const programFailed = wide.filter((row) => row.status === 'fail').length;
  return {
    refusal: null,
    value: {
      operation: 'Library Checks',
      program,
      served_by: path.resolve(root),
      libraries: libraries as unknown as PsJsonValue,
      unreached: found.unreached,
      failed: failed + programFailed,
      program_checks: wide as unknown as PsJsonValue,
      shared_library_write: false,
    },
    exitCode: failed || programFailed ? 1 : 0,
  };
}

/** One Library's checks, and the program's: `results` the workspace rows the PowerShell runner compares row for row. */
function doctorChecks(workspace: string, program: string): { results: CheckResult[]; programChecks: CheckResult[] } {
  const checks: [string, () => string][] = [
    ['workspace.guards-registered', () => guardsRegistered(workspace, program)],
    ['workspace.codex-guards-registered', () => codexGuardsRegistered(workspace, program)],
    ['shelf.overlap-records', () => overlapRecords(workspace)],
    ['raw.batch-owners', () => rawBatchOwners(workspace)],
    ['shelf.references-resolve', () => referencesResolve(workspace, program)],
    ['desk.seat-retirement-identity', () => seatRetirementIdentity(workspace)],
    ['notebook.master-index-renders', () => masterIndexRenders(workspace)],
    ['shelf.catalog-renders-from-entries', () => catalogRendersFromEntries(workspace, program)],
    ['output.namespaced-by-project', () => outputNamespaced(workspace)],
  ];
  const results: CheckResult[] = checks.map(([check, body]) => {
    if (!workspace) return { check, status: 'skipped', detail: WORKSPACE_ABSENT_REASON };
    return runCheck(check, body);
  });
  // THE PROGRAM'S OWN CHECKS RUN WITH OR WITHOUT A LIBRARY (F4), in their own list: `checks` stays the workspace checks
  // the PowerShell runner's -WorkspaceOnly reports, which the acceptance matrix compares row for row.
  const programChecks: CheckResult[] = [
    ...SKILL_LOCATIONS.map((location) => workspace
      ? runCheck(`workspace.${location.startsWith('.agents') ? 'codex' : 'claude'}-skills-installed`, () => skillInstallationStatus(workspace, program, location))
      : { check: `workspace.${location.startsWith('.agents') ? 'codex' : 'claude'}-skills-installed`, status: 'skipped', detail: 'no Library here, so no workspace skills to check' }),
    runCheck('program.command-resolves', () => commandResolves(program)),
    runCheck('program.assistant-present', assistantPresent),
    runCheck('program.codex-version', codexVersion),
    // KEPT IN THIS LIST, NOT `checks` (1.2.5): the PowerShell runner has no added folders to check, and `checks` is
    // compared with it row for row. Skipped with no Library, as a workspace check is.
    workspace ? runCheck('seats.added-folders', () => seatAddedFolders(workspace)) : { check: 'seats.added-folders', status: 'skipped', detail: 'no Library here, so no seats whose folders to check' },
    // HERE FOR THE SAME REASON (S73 row 4): the PowerShell runner has no seat rule to check.
    workspace ? runCheck('shelf.capture-books-say-who-closes', () => captureBooksSayWhoCloses(workspace)) : { check: 'shelf.capture-books-say-who-closes', status: 'skipped', detail: 'no Library here, so no capture Books to check' },
    // AND THIS ONE (S77 row 2): the PowerShell runner has no growing signal. A WARN, never a FAIL.
    workspace ? runCheck('shelf.capture-books-growing', () => captureBooksGrowing(workspace)) : { check: 'shelf.capture-books-growing', status: 'skipped', detail: 'no Library here, so no capture Books to check' },
    // AND THIS ONE (S77 row 3): the PowerShell runner has no standard-Book check.
    workspace ? runCheck('shelf.standard-books-present', () => standardBooksPresent(workspace)) : { check: 'shelf.standard-books-present', status: 'skipped', detail: 'no Library here, so no standard Books to check' },
    // AND THIS ONE (kickoffs/s149 row 3): the PowerShell runner has no manifest check. A WARN, never a FAIL.
    workspace ? runCheck('shelf.books-have-manifests', () => booksHaveManifests(workspace)) : { check: 'shelf.books-have-manifests', status: 'skipped', detail: 'no Library here, so no Shelf Books to check' },
    // AND THESE TWO (S79 row 3): the PowerShell runner has no inbound policy. WARNs, never FAILs.
    workspace ? runCheck('seats.inbound-policy', () => seatInboundFiles(workspace)) : { check: 'seats.inbound-policy', status: 'skipped', detail: 'no Library here, so no seats whose inbound files to check' },
    runCheck('settings.user-inbound', userInboundSetting),
    // AND THESE TWO (1.3.8, kickoffs/s96 row 1): the PowerShell runner has no seat cards or letters' recipients. WARNs.
    workspace ? runCheck('seats.registry-fields', () => seatRegistryFields(workspace)) : { check: 'seats.registry-fields', status: 'skipped', detail: 'no Library here, so no seats whose cards and roles to check' },
    workspace ? runCheck('letters.recipient-incarnation', () => lettersRecipientIncarnation(workspace)) : { check: 'letters.recipient-incarnation', status: 'skipped', detail: 'no Library here, so no letters to check' },
    // AND THIS ONE (kickoffs/s98 row 2): a letter whose relationship fields do not validate. A WARN; never a write.
    workspace ? runCheck('letters.relationship-fields', () => lettersRelationshipFields(workspace)) : { check: 'letters.relationship-fields', status: 'skipped', detail: 'no Library here, so no letters to check' },
    // AND THIS ONE (kickoffs/s103 row 6): every seat one identity, every recorded letter id a known seat. A FAIL.
    workspace ? runCheck('seats.identity', () => seatsIdentity(workspace)) : { check: 'seats.identity', status: 'skipped', detail: 'no Library here, so no seats whose identity to check' },
    // AND THIS ONE (kickoffs/s109 ruling 1): a Hub or Shelf Book line naming a Notebook path that is gone. A WARN.
    workspace ? runCheck('notebook.links-resolve', () => notebookLinksResolve(workspace)) : { check: 'notebook.links-resolve', status: 'skipped', detail: 'no Library here, so no Hub or Shelf Book links to check' },
    // AND THESE TWO (kickoffs/s165 row 5): an undo or redo that stopped part-way, and a finished one's own dirty marker
    // still down, which is cleared here. A marker another operation owns, or an unfinished one's, is never touched.
    workspace ? runCheck('undo.incomplete', () => undoIncompleteCheck(workspace)) : { check: 'undo.incomplete', status: 'skipped', detail: 'no Library here, so no undo records to check' },
    workspace ? runCheck('undo.marker-left', () => undoMarkerLeftCheck(workspace)) : { check: 'undo.marker-left', status: 'skipped', detail: 'no Library here, so no undo records to check' },
    // AND THESE TWO (kickoffs/s123 row 4): the Postbox's outbox and whether it answered, from its cache. Skipped with none.
    workspace ? runCheck('postbox.outbox', () => postboxOutbox(workspace)) : { check: 'postbox.outbox', status: 'skipped', detail: 'no Library here, so no Postbox to check' },
    workspace ? runCheck('postbox.reachable', () => postboxReachable(workspace)) : { check: 'postbox.reachable', status: 'skipped', detail: 'no Library here, so no Postbox to check' },
    workspace ? runCheck('postbox.reports',()=>postboxReports(workspace)) : {check:'postbox.reports',status:'skipped',detail:'no Library here'},
    workspace ? runCheck('postbox.records',()=>postboxRecords(workspace)) : {check:'postbox.records',status:'skipped',detail:'no Library here'},
    // AND THIS ONE (S96 row 5): where crossSessionInbound is set, informational; never a WARN, never a write.
    runCheck('settings.inbound-overview', () => inboundOverview(workspace)),
    ...(workspace ? (() => { try { return readRegistryRows(registryFilePath(path.join(workspace, '.claude'))).flatMap(row => {
      const seat = String(row['seat']), read = readSeatLaunch(path.join(workspace, '.claude'), seat, String(row['seat_id'] ?? ''));
      return read.state === 'invalid' || read.state === 'unreadable' ? [{ check: 'seats.launch-record.' + seat, status: 'warn', detail: read.reason + '; reset with deskpost seat settings ' + seat + ' --reset-launch --preflight, then its --plan-id' }] : [];
    }); } catch { return []; /* The existing registry checks name a malformed registry. */ } })() : []),
    // AND THIS ONE (kickoffs/s161 row 2): the vault connection, named; no row with none.
    ...vaultConnectionCheck(workspace),
    ...refreshUnfinished(program),
  ];
  return { results, programChecks };
}

/**
 * THE VAULT CONNECTION, NAMED (kickoffs/s161 row 2; plan acceptance criterion 1): with `connections.vault` in the marker,
 * one row naming the vault's folder, whether it and its Librarian folder exist, and the features on. A missing folder is
 * a WARN, never a FAIL. With no connection there is no row, so a Library without a vault reports exactly what it did.
 */
function vaultConnectionCheck(workspace: string): CheckResult[] {
  if (!workspace) return [];
  let connection: VaultConnection | null;
  try {
    connection = readVaultConnection(readMarker(workspace));
  } catch {
    return [];
  }
  if (connection === null) return [];
  const vault = connection;
  return [runCheck('vault.connection', () => {
    const features = vault.features.length ? vault.features.join(', ') : 'none';
    const librarian = path.join(vault.path, vault.librarian_folder);
    if (!fs.existsSync(vault.path)) return `WARN: the vault folder ${vault.path} is gone; Deskpost writes nothing there until it is back, or until deskpost vault disconnect (features on: ${features})`;
    if (!fs.existsSync(librarian)) return `WARN: the vault at ${vault.path} has no ${vault.librarian_folder}/ folder, so Deskpost writes nothing there; the vault's own scaffold makes it (features on: ${features})`;
    return `connected to the vault at ${vault.path}; its ${vault.librarian_folder}/ folder exists; features on: ${features}`;
  })];
}

/**
 * AN APPROVED REFRESH THAT DID NOT FINISH IS NAMED (PLAN-one-upgrade.md r8 R2b): the install's receipt still carries
 * `refresh_pending`, so a Library it serves may be behind the program. A WARN, with both routes; no row otherwise, so a
 * finished install's report is as it was.
 */
function refreshUnfinished(program: string): CheckResult[] {
  const root = installRootOf(program);
  if (root === null) return [];
  const receipt = readInstallReceipt(root);
  const raw = receipt?.['refresh_pending'];
  if (raw === undefined || raw === null || raw === '') return [];
  return [{
    check: 'program.refresh-finished',
    status: 'warn',
    detail: `an approved refresh of the Libraries this install serves did not finish. Run the install one-liner again (it finishes the refresh and changes nothing else), or ${COMMAND_NAME} init <folder> in each Library.`,
  }];
}
