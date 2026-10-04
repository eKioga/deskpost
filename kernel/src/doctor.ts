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
import { addedDirsStatus, isAtOrInside } from './seatdirs.ts';
import { INBOUND_KEY, readInboundSettings, userSettingsPath } from './seatinbound.ts';
import { shelfCatalogEntryInventory, shelfCatalogText } from './shelfcatalog.ts';
import { DEFAULT_GROWING_DAYS, DEFAULT_GROWING_PENDING, getShelfBook, parseGrowingAt, readUtf8, shelfCatalogPath, shelfCatalogSections, STANDARD_SHELF_BOOK_SLUGS } from './shelfbook.ts';
import { growingState, shelfNotes } from './shelfnote.ts';
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
          // `library init` wrote there was `powershell.exe`, which does not exist. POSIX only, where it was measured.
          const starter = owned.invocation.program;
          if (process.platform !== 'win32' && owned.kind === 'script' && !starter.includes('${') && !canStart(starter)) {
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
 * PRESENCE ONLY. What the hash is taken over is Codex's and is not reproduced here, so a review that went stale
 * when a hook changed reads as reviewed; Codex asks again in that case. Read, never written.
 */
function codexUnreviewedHooks(hooksPath: string, document: unknown, config: string): string[] {
  const normalise = (text: string) => text.replace(/\\/g, '/').toLowerCase();
  const reviewed = new Set<string>();
  if (fs.existsSync(config) && fs.statSync(config).isFile()) {
    let current: string | null = null;
    for (const raw of fs.readFileSync(config, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const text = raw.trim();
      if (text.startsWith('[')) {
        const header = /^\[hooks\.state\.(.+)\]$/.exec(text);
        current = header ? codexTableKey(header[1]!) : null;
        continue;
      }
      if (current !== null && /^trusted_hash\s*=\s*["'][^"']+["']\s*$/.test(text)) reviewed.add(normalise(current));
    }
  }
  const file = path.resolve(hooksPath);
  const unreviewed: string[] = [];
  const events = ((document as { hooks?: Record<string, unknown> }).hooks ?? {}) as Record<string, unknown>;
  for (const [event, value] of Object.entries(events)) {
    const snake = event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const groups = Array.isArray(value) ? value : [value];
    groups.forEach((group, i) => {
      const hooks = (group as { hooks?: unknown } | null)?.hooks;
      (Array.isArray(hooks) ? hooks : hooks === undefined || hooks === null ? [] : [hooks]).forEach((_hook, j) => {
        if (!reviewed.has(normalise(`${file}:${snake}:${i}:${j}`))) unreviewed.push(`${event} ${i}:${j}`);
      });
    });
  }
  return unreviewed;
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
  // THE THIRD GATE (S49): a trusted project's hooks still run only once that Codex home has reviewed them.
  const unreviewed = codexUnreviewedHooks(hooksPath, document, trust.config);
  if (unreviewed.length) {
    return (
      `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but ${unreviewed.length} ` +
      `have not been reviewed in ${trust.config}: ${unreviewed.join(', ')}. Codex skips an unreviewed hook ` +
      'in SILENCE, so those bindings are inert. Open a Codex session in that folder once and accept its hook ' +
      'review; the review is per Codex home, like the trust grant.'
    );
  }
  const configPath = path.join(workspace, '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but has no .codex/config.toml, so a Codex seat there has no validated reader.`;
  }
  if (!/^\[mcp_servers\.validated-book-reader\]\s*$/im.test(fs.readFileSync(configPath, 'utf8'))) {
    return `WARN: ${workspace} registers ${registrations} trusted Codex hook(s) that resolve, but its .codex/config.toml does not declare the validated reader.`;
  }
  return `${registrations} Codex hook registration(s) resolve, the project is trusted in ${trust.home} with every hook reviewed, and the validated reader is declared`;
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
    const pending = notes.filter((note) => note.review !== 'done').length;
    growing.push(
      `capture Book '${slug}' is growing: ${pending} pending, past ${book.growingPending} pending or ${book.growingDays} days; ` +
        `open it with deskpost desk open book ${slug} --location shelf and triage its notes`,
    );
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

// --- The runner -----------------------------------------------------------------------------------

export interface DoctorResult {
  refusal: string | null;
  value: PsJsonValue | null;
  exitCode: number;
}

export function runDoctor(argv: string[], program: string): DoctorResult {
  const parsed = parseArguments(argv, ['workspace', 'served-by', 'kept', 'registry-root']);
  if (parsed.options.has('served-by')) return runServedBy(argv, parsed.options.get('served-by')!, program, parsed.options.get('registry-root'));
  const resolved = resolveWorkspace({ explicit: parsed.options.get('workspace') });
  if (resolved.kind === 'conflict') return { refusal: resolved.reason ?? 'the workspace selection is contradictory', value: null, exitCode: 1 };
  const workspace = resolved.kind === 'resolved' ? path.resolve(resolved.workspace!) : '';
  const { results, programChecks } = doctorChecks(workspace, program);

  const count = (status: string): number => results.filter((row) => row.status === status).length;
  const failed = count('fail');
  const programFailed = programChecks.filter((row) => row.status === 'fail').length;
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
      shared_library_write: false,
    },
    exitCode: failed || programFailed ? 1 : 0,
  };
}

/** The checks that need no Library: the program's own, run once whatever the Libraries are. */
const PROGRAM_WIDE_CHECKS = new Set(['program.command-resolves', 'program.assistant-present', 'settings.user-inbound', 'program.refresh-finished']);

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
    runCheck('program.command-resolves', () => commandResolves(program)),
    runCheck('program.assistant-present', assistantPresent),
    // KEPT IN THIS LIST, NOT `checks` (1.2.5): the PowerShell runner has no added folders to check, and `checks` is
    // compared with it row for row. Skipped with no Library, as a workspace check is.
    workspace ? runCheck('seats.added-folders', () => seatAddedFolders(workspace)) : { check: 'seats.added-folders', status: 'skipped', detail: 'no Library here, so no seats whose folders to check' },
    // HERE FOR THE SAME REASON (S73 row 4): the PowerShell runner has no seat rule to check.
    workspace ? runCheck('shelf.capture-books-say-who-closes', () => captureBooksSayWhoCloses(workspace)) : { check: 'shelf.capture-books-say-who-closes', status: 'skipped', detail: 'no Library here, so no capture Books to check' },
    // AND THIS ONE (S77 row 2): the PowerShell runner has no growing signal. A WARN, never a FAIL.
    workspace ? runCheck('shelf.capture-books-growing', () => captureBooksGrowing(workspace)) : { check: 'shelf.capture-books-growing', status: 'skipped', detail: 'no Library here, so no capture Books to check' },
    // AND THIS ONE (S77 row 3): the PowerShell runner has no standard-Book check.
    workspace ? runCheck('shelf.standard-books-present', () => standardBooksPresent(workspace)) : { check: 'shelf.standard-books-present', status: 'skipped', detail: 'no Library here, so no standard Books to check' },
    // AND THESE TWO (S79 row 3): the PowerShell runner has no inbound policy. WARNs, never FAILs.
    workspace ? runCheck('seats.inbound-policy', () => seatInboundFiles(workspace)) : { check: 'seats.inbound-policy', status: 'skipped', detail: 'no Library here, so no seats whose inbound files to check' },
    runCheck('settings.user-inbound', userInboundSetting),
    ...refreshUnfinished(program),
  ];
  return { results, programChecks };
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
