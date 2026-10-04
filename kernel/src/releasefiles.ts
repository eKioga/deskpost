/**
 * WHAT A RELEASE SHIPS (PLAN-no-powershell-runtime.md D9, kickoffs/s83 ruling 5): the public tree, less the PowerShell
 * a reader's machine never runs.
 *
 * The public repository is unchanged: it keeps `tools/*.ps1`, the development oracle until "PowerShell-free
 * development". This filters the RELEASE ARCHIVE only. tools/Build-KernelRelease.ps1 passes the public tree's file list
 * (tools/PublicTreeAllowlist.ps1) on stdin and stages what this prints. It keeps:
 *   - every file that is not PowerShell -- the kernel, the plugin, the skills and docs the program reads at runtime;
 *   - `install.ps1` (the installer, the first named exception, until "Install without PowerShell");
 *   - the Basic Memory reader adapter, `.claude/adapters/Validated-BookReader.ps1`, and its transitive closure of
 *     dot-sourced `tools/` scripts, computed here from the files themselves (Q3: the second named exception).
 * It drops every other `.ps1`, the source checkout's hook scripts among them, and the root `library.cmd` and
 * `library.ps1`: the installed shims call `current\bin\library.exe`. The root `library` stays, for install.sh.
 *
 * Self-test section 117 judges a built tree against these same rules, and that the closure it holds is complete.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The reader adapter that is the root of the one PowerShell closure a release keeps. */
export const ADAPTER = '.claude/adapters/Validated-BookReader.ps1';

/** Kept whatever their extension: the installer. */
export const KEPT_SCRIPTS = ['install.ps1'];

/**
 * The root launchers a release drops: library.ps1 is the dispatcher, and library.cmd runs it; an install runs
 * bin\library.exe instead. THE EXTENSIONLESS `library` STAYS (S83 row 5, found in the clean distro): install.sh
 * `chmod`s it in the extracted tree (`install.sh:142`), so a release without it does not install on Linux.
 */
export const DROPPED_LAUNCHERS = ['library.cmd', 'library.ps1'];

/** Root files the installers touch in an extracted release, which every release must therefore carry. */
export const INSTALLER_NEEDS = ['library'];

function isPowerShell(file: string): boolean {
  return /\.ps(1|m1|d1)$/i.test(file);
}

/**
 * The `tools/` scripts a file dot-sources, by the two spellings the adapter's closure uses: `Join-Path $PSScriptRoot
 * 'X.ps1'` inside tools/, and `(Join-Path 'tools' 'X.ps1')` from the adapter. Conditional dot-sources count: a branch
 * the adapter can reach must find its file.
 */
export function dotSourcedTools(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/Join-Path\s+\$PSScriptRoot\s+'([A-Za-z0-9_-]+\.ps1)'/g)) found.add(`tools/${match[1]}`);
  for (const match of text.matchAll(/Join-Path\s+'tools'\s+'([A-Za-z0-9_-]+\.ps1)'/g)) found.add(`tools/${match[1]}`);
  return [...found].sort();
}

/** The adapter and every `tools/` script it reaches, transitively. A file that cannot be read ends that branch. */
export function adapterClosure(readFile: (relative: string) => string | null): string[] {
  const closure = new Set<string>();
  const queue = [ADAPTER];
  while (queue.length) {
    const file = queue.shift()!;
    if (closure.has(file)) continue;
    const text = readFile(file);
    if (text === null) continue;
    closure.add(file);
    for (const next of dotSourcedTools(text)) if (!closure.has(next)) queue.push(next);
  }
  return [...closure].sort();
}

/** The PowerShell a release may carry: the installer and the adapter's closure. */
export function allowedScripts(readFile: (relative: string) => string | null): Set<string> {
  return new Set([...KEPT_SCRIPTS, ...adapterClosure(readFile)]);
}

/** The release's files from the public tree's: every file but the PowerShell outside the allowlist and the launchers. */
export function releaseFiles(publicFiles: string[], readFile: (relative: string) => string | null): string[] {
  const allowed = allowedScripts(readFile);
  return publicFiles.filter((file) => !DROPPED_LAUNCHERS.includes(file) && (!isPowerShell(file) || allowed.has(file)));
}

/** The PowerShell in a tree that the rules do not allow: what self-test section 117 says a built release must not hold. */
export function disallowedScripts(files: string[], readFile: (relative: string) => string | null): string[] {
  const allowed = allowedScripts(readFile);
  return files.filter((file) => DROPPED_LAUNCHERS.includes(file) || (isPowerShell(file) && !allowed.has(file))).sort();
}

function treeReader(root: string): (relative: string) => string | null {
  return (relative) => {
    try {
      return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
    } catch {
      return null;
    }
  };
}

// RUN BY THE BUILD: `bun releasefiles.ts --tree <source root>`, the public tree's files on stdin, one per line, and the
// release's files on stdout, one per line. A closure file the public tree does not carry fails the build.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--tree');
  const tree = at >= 0 ? process.argv[at + 1] : undefined;
  if (!tree) {
    process.stderr.write('releasefiles: pass --tree <source root>, and the public tree\'s files on stdin\n');
    process.exit(2);
  }
  const publicFiles = fs
    .readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const read = treeReader(tree);
  const missing = adapterClosure(read).filter((file) => !publicFiles.includes(file));
  if (missing.length) {
    process.stderr.write(`releasefiles: the reader adapter's closure needs files the public tree does not carry: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(releaseFiles(publicFiles, read).join('\n') + '\n');
}
