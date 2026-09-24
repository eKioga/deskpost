/**
 * Where this program's own files are: the templates `init` renders, the plugin manifest whose version
 * it records, the hook and adapter scripts it registers, the Shelf catalog header.
 *
 * TWO ANSWERS, BECAUSE THE KERNEL RUNS TWO WAYS. From source (`node kernel/src/cli.ts`) this module
 * sits at `<program>/kernel/src/`, so the root is two directories up from it. Inside a binary built by
 * `bun build --compile` there is no such file: MEASURED 2026-09-22 (S29), `import.meta.url` is
 * `file:///B:/%7EBUN/root/<name>.exe` on Windows, so "two directories up" is `B:\` -- a virtual drive
 * holding nothing the kernel needs -- and every `init` row mismatched on 33 of 33 fields. A compiled
 * kernel is instead found where the release put it: `<program>/bin/library[.exe]`, beside the program
 * tree it ships with (`tools/Build-KernelRelease.ps1`), so the root is one directory above the
 * executable's own.
 *
 * A COMPILED BINARY OUTSIDE THAT LAYOUT REFUSES, NAMING WHERE IT LOOKED. The alternative -- answer
 * with the directory anyway -- is an `init` that writes a workspace whose instructions came from
 * nowhere and a doctor that reports on a program that is not there. It refuses lazily, when a verb
 * first asks, so `library help`, `--version` and every verb that never reads the program still run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The file whose presence says a directory is this program's root. `init` reads it for the version. */
export const PROGRAM_ROOT_PROOF = path.join('.codex-plugin', 'plugin.json');

/**
 * True inside a `bun build --compile` binary. Bun serves the bundled modules from a virtual
 * filesystem: `B:\~BUN\` on Windows (measured), `/$bunfs/` elsewhere (Bun's documented spelling).
 */
export function isCompiled(moduleUrl: string = import.meta.url): boolean {
  const file = decodeURIComponent(moduleUrl);
  return /[\\/]~BUN[\\/]/.test(file) || /[\\/]\$bunfs[\\/]/.test(file);
}

export interface ProgramRootAnswer {
  root: string | null;
  compiled: boolean;
  refusal: string | null;
}

export function locateProgramRoot(moduleUrl: string = import.meta.url, execPath: string = process.execPath): ProgramRootAnswer {
  if (!isCompiled(moduleUrl)) {
    return { root: path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..'), compiled: false, refusal: null };
  }
  const root = path.dirname(path.dirname(path.resolve(execPath)));
  if (fs.existsSync(path.join(root, PROGRAM_ROOT_PROOF))) return { root: stableProgramRoot(root), compiled: true, refusal: null };
  return {
    root: null,
    compiled: true,
    refusal:
      `This library binary (${execPath}) is not inside a Library release: a release keeps it at ` +
      `<program>/bin/, and ${path.join(root, PROGRAM_ROOT_PROOF)} does not exist. Install a release ` +
      'with install.ps1 or install.sh, or run the kernel from source with `node kernel/src/cli.ts`.',
  };
}

/**
 * THE INSTALL'S STABLE NAME FOR THIS VERSION, WHEN IT HAS ONE (S30, the reader's ruling). Every path
 * `init` writes -- hook scripts, the reader adapter -- is under the program root, so a root that moved
 * on every upgrade left every workspace's hooks naming the old version, and the next `init` refusing
 * them as hooks the Library did not write. The installers keep `<install>/current` as a link onto
 * `<install>/versions/<v>` and the shim runs through it; the program root is that link whenever it
 * resolves to this binary's own version, and never moves.
 *
 * ASKED OF THE LINK, NOT OF THE EXECUTABLE'S PATH, because Bun resolves the junction: MEASURED
 * 2026-09-22, a binary started as `<junction>\bin\library.exe` reported `process.execPath` under
 * `versions\<v>`. So the rule is the other way round -- from the version directory, is there a
 * `current` beside `versions/` that resolves here? A `current` naming another version (mid-upgrade, or
 * a version run by its own path to check it before switching) leaves the version's own path, which is
 * what the installer's tuple check needs to see.
 */
export function stableProgramRoot(root: string): string {
  const versions = path.dirname(root);
  if (path.basename(versions).toLowerCase() !== 'versions') return root;
  const current = path.join(path.dirname(versions), 'current');
  try {
    const target = fs.realpathSync.native(current);
    const own = fs.realpathSync.native(root);
    const same = process.platform === 'win32' ? target.toLowerCase() === own.toLowerCase() : target === own;
    return same ? current : root;
  } catch {
    return root;
  }
}

let cached: ProgramRootAnswer | null = null;

/** The program root, or a refusal naming where a compiled binary looked. Resolved once per process. */
export function programRoot(): string {
  cached ??= locateProgramRoot();
  if (cached.root === null) throw new Error(cached.refusal!);
  return cached.root;
}

// --- the release tuple --------------------------------------------------------------------------

/** Set by `bun build --compile --define` in tools/Build-KernelRelease.ps1; undeclared when run from source. */
declare const LIBRARY_KERNEL_VERSION: string | undefined;

/**
 * The workspace schema this kernel reads and writes. PLAN-public-release.md step 28 pins it in the
 * release tuple beside the plugin and binary versions; every record the kernel writes today is
 * `schema: 1`, and a change to that is what would move it.
 */
export const WORKSPACE_SCHEMA = 1;

function readVersion(file: string): string | null {
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const version = typeof document['version'] === 'string' ? document['version'].trim() : '';
    return version || null;
  } catch {
    return null;
  }
}

/**
 * `library --version`: the tuple an installer verifies and a doctor reports. THE BINARY'S VERSION IS
 * BAKED IN AT BUILD TIME, never read beside it, because a binary that read its version from the tree
 * it was dropped into would report whatever tree that was. From source there is no build, so it is
 * `kernel/package.json`'s, and `compiled` says which of the two answered.
 */
export function releaseTuple(): Record<string, string | number | boolean | null> {
  const located = (cached ??= locateProgramRoot());
  const binary =
    typeof LIBRARY_KERNEL_VERSION === 'string'
      ? LIBRARY_KERNEL_VERSION
      : located.root === null
        ? null
        : readVersion(path.join(located.root, 'kernel', 'package.json'));
  return {
    binary_version: binary,
    plugin_version: located.root === null ? null : readVersion(path.join(located.root, PROGRAM_ROOT_PROOF)),
    workspace_schema: WORKSPACE_SCHEMA,
    compiled: located.compiled,
    program_root: located.root,
  };
}
