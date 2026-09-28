/**
 * What this machine says about the installed program: the install it belongs to, what a bare command name starts,
 * which assistant is here, and what a registration invokes (PLAN-install-onboarding.md steps 1 and 9, ADR-0055).
 *
 * THE COMMAND IS `deskpost` AND THE BINARY STAYS `library.exe` THROUGH 1.x (ADR-0055). An install keeps
 * `<root>/current` as a link onto `<root>/versions/<v>` and `current.json` beside it (install.ps1, install.sh), and
 * puts both shims, `deskpost` and `library`, in `<root>/bin` on Windows. A program root that is not `<root>/current`
 * with `current.json` beside it is not an install: a checkout run from source, or a release tree being checked.
 *
 * A REGISTRATION IS READ AS AN INVOCATION, NOT SPLIT ON WHITESPACE (PLAN-install-onboarding.md #15). Until 1.1 doctor
 * split a hook's text on spaces, so a program path holding a space was never seen at all. A command is tokenized the
 * way the harness's shell reads it: double quotes as sh and PowerShell take them, single quotes as PowerShell takes
 * them (a doubled `''` is one quote), and Codex's leading `& ` call operator dropped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The shim a reader types. `library` stays as a quiet alias through 1.x (ADR-0055). */
export const COMMAND_NAME = 'deskpost';

// --- the install -----------------------------------------------------------------------------------------

/**
 * The install root a program root belongs to, or null when it belongs to none. `<root>/current` is the program root
 * every installed binary reports (programroot.ts); a binary run from `<root>/versions/<v>` belongs to the same install.
 */
export function installRootOf(programRoot: string): string | null {
  const full = path.resolve(programRoot);
  const parent = path.dirname(full);
  if (path.basename(full).toLowerCase() === 'current' && fs.existsSync(path.join(parent, 'current.json'))) return parent;
  if (path.basename(parent).toLowerCase() === 'versions' && fs.existsSync(path.join(path.dirname(parent), 'current.json'))) return path.dirname(parent);
  return null;
}

/** The shim this install puts first on PATH: `<root>\bin\deskpost.cmd` on Windows, and on POSIX the link install.sh makes. */
export function installShim(installRoot: string): string {
  return process.platform === 'win32' ? path.join(installRoot, 'bin', `${COMMAND_NAME}.cmd`) : path.join(installRoot, 'current', 'bin', 'library');
}

/** The install's receipt, or null when there is none or it cannot be read (step 8; 1.0 wrote none). */
export function readInstallReceipt(installRoot: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(installRoot, 'install-receipt.json'), 'utf8').replace(/^﻿/, '')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- what a bare name starts ----------------------------------------------------------------------------

function pathVariable(): string {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return process.env[key] ?? '';
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first file a bare name resolves to on a search path, as the shell resolves it (PATHEXT on Windows), or null. */
export function resolveOnPath(name: string, searchPath: string = pathVariable()): string | null {
  const windows = process.platform === 'win32';
  const extensions = windows && !path.extname(name) ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext) : [''];
  for (const raw of searchPath.split(path.delimiter)) {
    const directory = raw.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    for (const ext of extensions) {
      const candidate = path.join(directory, name + ext);
      if (!isFile(candidate)) continue;
      if (!windows) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

/**
 * THE AGENT A BARE NAME STARTS, AND WHERE CLAUDE CODE'S INSTALLER PUTS IT (S47). Measured in S7's Windows Sandbox:
 * Claude Code from https://claude.ai/install.ps1 installs `~\.local\bin\claude.exe` and does not put that folder on
 * PATH, so `library seat start` refused in a new terminal. On Windows a bare name found nowhere on PATH is looked for
 * there before the launch is attempted; anything else -- a path, a name PATH resolves, another platform -- is started
 * as given, and a name found in neither place is still refused, naming both. `seat start` and doctor's assistant
 * check both ask this one function (PLAN-install-onboarding.md step 3, "the same resolver `seat start` uses").
 */
export function agentExecutable(command: string, searchPath: string): { file: string; fallback: boolean; userBin: string | null } {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return { file: command, fallback: false, userBin: null };
  const home = process.env['USERPROFILE'] ?? '';
  const userBin = home ? path.join(home, '.local', 'bin', path.extname(command) ? command : `${command}.exe`) : null;
  const onPath = resolveOnPath(command, searchPath) !== null;
  if (!onPath && userBin !== null && fs.existsSync(userBin)) return { file: userBin, fallback: true, userBin };
  return { file: command, fallback: false, userBin };
}

/** Where an assistant would start from, or null when it is not on this machine: PATH, then `~/.local/bin`. */
export function findAssistant(command: 'claude' | 'codex', searchPath: string = pathVariable()): string | null {
  const onPath = resolveOnPath(command, searchPath);
  if (onPath !== null) return onPath;
  const home = process.platform === 'win32' ? (process.env['USERPROFILE'] ?? '') : (process.env['HOME'] ?? '');
  if (!home) return null;
  const local = path.join(home, '.local', 'bin', process.platform === 'win32' ? `${command}.exe` : command);
  return isFile(local) ? local : null;
}

// --- what a registration invokes ------------------------------------------------------------------------

/**
 * A command line's words, quote-aware. Double quotes group (no escapes inside, as `& "<path>"` and sh's `"<path>"`
 * are written); single quotes group with `''` as one literal quote, PowerShell's rule, which 1.1's Codex render uses
 * (PLAN-install-onboarding.md #11). An unclosed quote runs to the end.
 */
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      started = true;
      const end = text.indexOf('"', i + 1);
      current += end < 0 ? text.substring(i + 1) : text.substring(i + 1, end);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === "'") {
      started = true;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          current += "'";
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        current += text[j];
        j += 1;
      }
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export interface Invocation {
  program: string;
  args: string[];
}

/** What a hook or server entry starts: exec form's `command` + `args`, or a command line tokenized. Null for nothing. */
export function entryInvocation(entry: unknown): Invocation | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record['command'] !== 'string' || !record['command'].trim()) return null;
  if (Array.isArray(record['args'])) return { program: record['command'].trim(), args: record['args'].map((arg) => String(arg)) };
  const tokens = tokenizeCommand(record['command']);
  if (tokens[0] === '&') tokens.shift();
  if (!tokens.length) return null;
  return { program: tokens[0]!, args: tokens.slice(1) };
}

/** Whether a program path is a Deskpost kernel binary: `<program>/bin/library` or `library.exe`. */
export function isKernelBinary(program: string): boolean {
  return /(^|[\\/])bin[\\/]library(\.exe)?$/i.test(program);
}

function isPowerShell(program: string): boolean {
  return /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(program);
}

/** The script a PowerShell invocation runs with `-File`, or null. */
export function powerShellScript(invocation: Invocation): string | null {
  if (!isPowerShell(invocation.program)) return null;
  const at = invocation.args.findIndex((arg) => arg.toLowerCase() === '-file');
  return at >= 0 && at + 1 < invocation.args.length ? invocation.args[at + 1]! : null;
}

export interface OwnedRegistration {
  /** `kernel`: the binary itself, judged by the binary. `script`: powershell.exe -File, judged by the script. */
  kind: 'kernel' | 'script';
  invocation: Invocation;
  /** The file that must be on disk: the binary, or the script passed to -File (step 8's rule). */
  file: string;
}

/**
 * WHETHER AN ENTRY IS DESKPOST'S, AND WHAT PROVES IT (PLAN-install-onboarding.md step 8's table and #15). A kernel
 * form runs `<…>/bin/library[.exe] hook <verb>` or `mcp serve`; a PowerShell form runs one of Deskpost's own scripts
 * with `-File`, named in `ownScripts`. Anything else -- a reader's own hook, another MCP server -- is not Deskpost's,
 * and doctor never judges it.
 */
export function ownedRegistration(entry: unknown, ownScripts: ReadonlySet<string>): OwnedRegistration | null {
  const invocation = entryInvocation(entry);
  if (invocation === null) return null;
  if (isKernelBinary(invocation.program) && ['hook', 'mcp'].includes((invocation.args[0] ?? '').toLowerCase())) {
    return { kind: 'kernel', invocation, file: invocation.program };
  }
  const script = powerShellScript(invocation);
  if (script !== null && ownScripts.has(path.basename(script.replace(/\\/g, '/')).toLowerCase())) return { kind: 'script', invocation, file: script };
  return null;
}

/** The program root a kernel binary belongs to: two folders above `bin/library[.exe]`. */
export function programOfBinary(binary: string): string {
  return path.dirname(path.dirname(binary));
}

function comparable(file: string): string {
  const resolved = path.resolve(file).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function physical(file: string): string | null {
  try {
    return comparable(fs.realpathSync.native(file));
  } catch {
    return null;
  }
}

/**
 * HOW A REGISTERED PROGRAM ROOT RELATES TO THE ONE RUNNING (F16, ADR-0038). `same` is this program by name or by its
 * physical folder. `version-folder` is this install's own `versions/<v>`, named directly instead of through `current`,
 * which an upgrade leaves behind. `other` is another program: a different install, or a checkout.
 */
export function programRelation(registered: string, running: string): 'same' | 'version-folder' | 'other' {
  if (comparable(registered) === comparable(running)) return 'same';
  const left = physical(registered);
  const right = physical(running);
  const installed = installRootOf(running);
  if (installed !== null && comparable(path.dirname(registered)) === comparable(path.join(installed, 'versions'))) return 'version-folder';
  if (left !== null && right !== null && left === right) return 'same';
  return 'other';
}
