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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { homeDirectory, resolveWorkspace } from './workspace.ts';
import { enterBookLock, enterSeatRegistryLock, exitBookLock } from './locks.ts';
import { readSeatRegistry, readSeatRetirementRecords, seatRegistryConsistency } from './desk.ts';
import { shelfCatalogEntryInventory, shelfCatalogText } from './shelfcatalog.ts';
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
import { asList, codexHookShapeFaults, enabledClaudePluginHooks, codexRegistrationProblems, claudeHookShapeFaults, hookEntryText, hookRegistrationProblems, isObject, type Json } from './hookregistry.ts';

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

/** Every absolute `.ps1` a registration names that is not on disk. The count is of registrations. */
/**
 * The program a hook entry starts, on POSIX (S42): `command` itself when `args` carries the rest, and
 * otherwise the command line's first word, quoted or bare. Null when there is nothing to name.
 */
function hookProgram(entry: unknown): string | null {
  if (!isObject(entry) || typeof entry['command'] !== 'string') return null;
  const command = entry['command'].trim();
  if (!command) return null;
  if (Array.isArray(entry['args'])) return command;
  const quoted = /^"([^"]*)"/.exec(command) ?? /^'([^']*)'/.exec(command);
  return quoted ? quoted[1]! : command.split(/\s+/)[0]!;
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

function unresolvedHookPaths(trees: unknown[]): { registrations: number; unresolved: string[]; unstartable: string[]; shellForm: string[] } {
  let registrations = 0;
  const unresolved: string[] = [];
  const shellForm: string[] = [];
  // A REGISTRATION THIS MACHINE CANNOT START IS NO GUARD (S42). Measured in a clean Linux distro: every hook
  // `library init` wrote there was `powershell.exe`, which does not exist, and this check passed them all,
  // because it asked only whether the named SCRIPT exists. A Claude hook that cannot start does not block.
  // POSIX only, where it was measured; on Windows powershell.exe is part of the system.
  const unstartable: string[] = [];
  for (const tree of trees) {
    if (!isObject(tree) || !('hooks' in tree) || tree['hooks'] === null) continue;
    for (const [eventName, blocks] of Object.entries(isObject(tree['hooks']) ? (tree['hooks'] as Json) : {})) {
      for (const block of asList(blocks)) {
        if (!isObject(block) || !('hooks' in block)) continue;
        for (const entry of asList(block['hooks'])) {
          if (entry === null) continue;
          registrations += 1;
          if (process.platform !== 'win32') {
            const program = hookProgram(entry);
            if (program !== null && !program.includes('${') && !canStart(program)) unstartable.push(`${eventName} -> ${program}`);
          }
          for (const token of hookEntryText(entry).split(/\s+/)) {
            const candidate = token.replace(/^"+|"+$/g, '');
            // THE KERNEL BINARY A REGISTRATION NAMES (S42) must be there, as a script must.
            if (/[\\/]bin[\\/]library(\.exe)?$/i.test(candidate) && path.isAbsolute(candidate)) {
              // ON WINDOWS THE BINARY IS `library.exe` (S47, the Report Inbox): a registration naming `bin/library` is
              // resolved as the shell resolves it before it is called missing. What fails there is the FORM -- measured
              // in S7's Windows Sandbox, a quoted command in shell form runs through PowerShell where Git Bash is absent,
              // and PowerShell refuses it as 'Unexpected token' -- and doctor says that rather than "not there".
              const file = process.platform === 'win32' && !/\.exe$/i.test(candidate) && !fs.existsSync(candidate) ? `${candidate}.exe` : candidate;
              if (!fs.existsSync(file) || !fs.statSync(file).isFile()) unresolved.push(`${eventName} -> ${candidate}`);
              else if (process.platform === 'win32' && isObject(entry) && !Array.isArray(entry['args']) && typeof entry['command'] === 'string' && /^\s*["']/.test(entry['command']) && !gitBashPresent()) {
                shellForm.push(`${eventName} -> ${candidate}`);
              }
              continue;
            }
            if (!candidate.endsWith('.ps1')) continue;
            if (candidate.includes('${')) continue;
            if (!path.isAbsolute(candidate)) continue;
            if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) unresolved.push(`${eventName} -> ${candidate}`);
          }
        }
      }
    }
  }
  return { registrations, unresolved, unstartable, shellForm };
}

function parseJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function codexHomeDirectory(): string {
  const configured = process.env['CODEX_HOME'];
  if (configured && configured.trim()) return configured;
  return path.join(process.platform === 'win32' ? (process.env['USERPROFILE'] ?? os.homedir()) : homeDirectory(), '.codex');
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
  const { registrations, unresolved, unstartable, shellForm } = unresolvedHookPaths(trees);
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
      const program = process.platform !== 'win32' && isObject(reader) && typeof reader['command'] === 'string' ? reader['command'] : null;
      if (program !== null && !program.includes('${') && !canStart(program)) serverDetail = `declares the validated reader as '${program}', which this machine cannot start`;
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
  const { registrations, unresolved, unstartable } = unresolvedHookPaths([document]);
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
  if (!fs.existsSync(configPath)) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but has no .codex/config.toml, so a Codex seat there has no validated reader.`;
  }
  if (!/^\[mcp_servers\.validated-book-reader\]\s*$/im.test(fs.readFileSync(configPath, 'utf8'))) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but its .codex/config.toml does not declare the validated reader.`;
  }
  return `${registrations} Codex hook registration(s) resolve, the project is trusted in ${trust.home}, and the validated reader is declared`;
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
      problems.push('shelf/_catalog.md does not match the tracked header plus the validated entry files; re-render it with tools/ShelfCatalog.ps1 -Render -WorkspacePath .');
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

// --- The runner -----------------------------------------------------------------------------------

export interface DoctorResult {
  refusal: string | null;
  value: PsJsonValue | null;
  exitCode: number;
}

export function runDoctor(argv: string[], program: string): DoctorResult {
  const parsed = parseArguments(argv, ['workspace']);
  const resolved = resolveWorkspace({ explicit: parsed.options.get('workspace') });
  if (resolved.kind === 'conflict') return { refusal: resolved.reason ?? 'the workspace selection is contradictory', value: null, exitCode: 1 };
  const workspace = resolved.kind === 'resolved' ? path.resolve(resolved.workspace!) : '';

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
    try {
      const detail = body();
      return detail.startsWith('WARN: ') ? { check, status: 'warn', detail: detail.substring(6) } : { check, status: 'pass', detail };
    } catch (error) {
      return { check, status: 'fail', detail: (error as Error).message };
    }
  });

  const count = (status: string): number => results.filter((row) => row.status === status).length;
  const failed = count('fail');
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
      shared_library_write: false,
    },
    exitCode: failed ? 1 : 0,
  };
}
