/**
 * EVERY DESKPOST INSTALL THIS MACHINE CAN SEE, NOT ONLY THE ONE THIS SHELL RUNS (PLAN-assistant-onboarding.md step 3).
 *
 * Measured in S57: an assistant's shell inherits the environment of whatever launched it, so an install on the user
 * PATH since that launch is not on the shell's PATH. Setup resolved only `deskpost`/`library` on the invoking PATH, first
 * match only, so from such a shell the plan offered a second install at the default root while one was already in use.
 * Candidate roots now come from three places, each read exactly:
 *
 *   1. every entry of the invoking PATH, and of the user PATH as stored (HKCU, handed in raw by install.ps1 and
 *      expanded here), whose folder holds a Deskpost shim under a root with `current.json`;
 *   2. the program roots named by KERNEL-FORM registrations in registered Libraries: `<root>\current\bin\library[.exe]`
 *      and `<root>\versions\<v>\bin\library[.exe]`. A script-form registration (`powershell.exe -File …`, the
 *      PowerShell workspace's hooks) names a checkout, not an install, and is never read as one.
 *
 * AN INPUT THAT CANNOT BE READ IS NOT "NONE" (Codex #14): an unreadable registry or `current.json` refuses, naming it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { entryInvocation, isKernelBinary, programOfBinary } from './machine.ts';
import { registryPath, toWorkspaceRoot } from './workspace.ts';

export class DiscoveryRefusal extends Error {}

/** `%NAME%` expanded from this process's environment, as Windows expands a REG_EXPAND_SZ value; unknown names kept. */
export function expandEnvironment(value: string): string {
  return value.replace(/%([^%;]+)%/g, (whole: string, name: string) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key !== undefined ? (process.env[key] ?? whole) : whole;
  });
}

function comparable(folder: string): string {
  let full = path.resolve(folder).replace(/[\\/]+$/, '');
  try {
    full = fs.realpathSync.native(full).replace(/[\\/]+$/, '');
  } catch {
    // A folder that cannot be resolved is compared as written.
  }
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Whether two folders are the same one, physically (a junction or a differently-cased path is the same). */
export function sameFolder(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
}

/** The install root a kernel binary's path names by its shape alone, whether or not anything is there. */
export function installRootByShape(binary: string): string | null {
  const program = programOfBinary(binary);
  const parent = path.dirname(program);
  if (path.basename(program).toLowerCase() === 'current') return parent;
  if (path.basename(parent).toLowerCase() === 'versions') return path.dirname(parent);
  return null;
}

/** Whether a root is a live install: its `current.json` is there and readable. An unreadable one refuses. */
function liveInstall(root: string): boolean {
  const record = path.join(root, 'current.json');
  if (!fs.existsSync(record)) return false;
  try {
    JSON.parse(fs.readFileSync(record, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw new DiscoveryRefusal(`${record} names a Deskpost install but cannot be read, so whether a second install would race it cannot be told. Move it aside, or repair that install; nothing was changed.`);
  }
  return true;
}

/** The kernel binaries a Library's own registrations name: every exec-form or command-line entry that runs one. */
export function libraryKernelBinaries(library: string): string[] {
  const found: string[] = [];
  const files = ['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.codex/hooks.json'];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const invocation = entryInvocation(node);
    if (invocation !== null && isKernelBinary(invocation.program) && ['hook', 'mcp'].includes((invocation.args[0] ?? '').toLowerCase())) {
      found.push(invocation.program);
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  for (const relative of files) {
    const file = path.join(library, relative);
    if (!fs.existsSync(file)) continue;
    let tree: unknown;
    try {
      tree = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      continue; // A Library's own broken settings file is doctor's to report; it names no install to find.
    }
    walk(tree);
  }
  return found;
}

/** The registered Libraries' folders, as the registry holds them. A registry that exists and cannot be read refuses. */
export function registeredLibraryFolders(registryRoot?: string): string[] {
  const file = registryPath(registryRoot);
  if (!fs.existsSync(file)) return [];
  let rows: unknown;
  try {
    rows = (JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { workspaces?: unknown }).workspaces;
  } catch {
    throw new DiscoveryRefusal(`${file}, the registry of this machine's Libraries, cannot be read, so the installs it points to cannot be checked. Repair or move it aside; nothing was changed.`);
  }
  const out: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const root = toWorkspaceRoot(String((row as Record<string, unknown>)['path'] ?? ''));
    if (root && fs.existsSync(root)) out.push(root);
  }
  return out;
}

export interface FoundInstall {
  root: string;
  /** Where it was seen: `this shell's PATH`, `the user PATH`, or `the registrations of <Library>`. */
  via: string;
}

/** Every live install on the given search paths and in the given Libraries' registrations, one entry per physical root. */
export function discoverInstalls(options: { searchPaths: { text: string; via: string }[]; libraries: string[] }): FoundInstall[] {
  const out: FoundInstall[] = [];
  const add = (root: string, via: string) => {
    if (!out.some((known) => sameFolder(known.root, root)) && liveInstall(root)) out.push({ root: path.resolve(root), via });
  };
  for (const { text, via } of options.searchPaths) {
    for (const raw of text.split(path.delimiter)) {
      const folder = expandEnvironment(raw.trim().replace(/^"|"$/g, ''));
      if (!folder || path.basename(folder.replace(/[\\/]+$/, '')).toLowerCase() !== 'bin') continue;
      const shims = process.platform === 'win32' ? ['deskpost.cmd', 'library.cmd'] : ['deskpost', 'library'];
      if (!shims.some((name) => fs.existsSync(path.join(folder, name)))) continue;
      add(path.dirname(folder.replace(/[\\/]+$/, '')), via);
    }
  }
  for (const library of options.libraries) {
    for (const binary of libraryKernelBinaries(library)) {
      const root = installRootByShape(binary);
      if (root !== null) add(root, `the registrations of ${library}`);
    }
  }
  return out;
}

/**
 * A LIBRARY GUARDED ONLY BY A PROGRAM THAT IS NOT INSTALLED (Codex #9, replacing Fable #10's repair): its kernel
 * registrations all name a binary that is gone. Returns the install root they name, or null when any of them runs, or
 * there are none. Migrating registrations between roots is machinery for a rare case; the caller refuses instead.
 */
export function missingProgramRoot(library: string): string | null {
  const binaries = libraryKernelBinaries(library);
  if (!binaries.length) return null;
  const onDisk = (file: string) => fs.existsSync(file) || (process.platform === 'win32' && !/\.exe$/i.test(file) && fs.existsSync(`${file}.exe`));
  if (binaries.some(onDisk)) return null;
  return installRootByShape(binaries[0]!) ?? programOfBinary(binaries[0]!);
}
