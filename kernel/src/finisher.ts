/**
 * `library finish-uninstall` (kickoffs/s83 row 2, PLAN-no-powershell-runtime.md D8, ruling 4): the uninstall finisher,
 * run by a COPY of this program in %TEMP% that `deskpost uninstall` starts outside its own job and then exits. It
 * ports tools/Finish-Uninstall.ps1, which it replaces, rule for rule:
 *
 *   THE HANDSHAKE. It writes `started <pid>` and waits up to 30 s. The parent, on seeing it, makes this process the
 *   pending operation's owner and writes `go`; only then does this wait (up to 120 s) for the parent to exit and remove
 *   anything. `cancel`, or no `go` in time, and it exits having deleted nothing.
 *   THE REMOVAL is `removeUninstallList`, the rules install.ps1's removal block had, which self-test sections 50 (the
 *   files) and 116 (the PATH entry, through a compiled kernel) hold. Since 1.3.5 it is the only copy: an interrupted
 *   uninstall is finished by `library install --resume finish`, which runs it too (install.ts; ADR-0066).
 *   ONLY ON `completed` are `pending` cleared and the receipt deleted, last. On `failed` both stay, owned by no live
 *   process, and re-running the installer (-Resume finish) completes the list with no program present.
 *
 * A RUNNING EXE CANNOT DELETE ITSELF (EPERM, measured in S82's spike), so as it exits the copy hands its own delete to a
 * `cmd /c ping ... & del` child started with CREATE_NO_WINDOW, outside this process's job, as the spike measured.
 * Internal: listed in `library verbs`, never in the menu, and never run by hand.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { readReceipt, writeReceipt, withLifecycleLock, argvQuote, receiptPath, type RemovalList } from './lifecycle.ts';
import { nativeBroadcastEnvironment, nativeStartDetached, nativeUserPathRead, nativeUserPathWrite } from './win32proc.ts';

/** The HKCU subkey whose `Path` the PATH entry is removed from. A fixture names its own (self-test section 116). */
export function userPathKey(): string {
  return (process.env['DESKPOST_PATH_KEY'] ?? '').trim() || 'Environment';
}

/**
 * The one PATH entry Deskpost added, read and written raw (unexpanded) so REG_EXPAND_SZ and every other entry survive:
 * what install.ps1's `Remove-DeskpostPathEntry` did. Empty entries are dropped and nothing is written unless an entry
 * went, which it returns.
 */
export function removePathEntry(entry: string, key: string = userPathKey()): boolean {
  const raw = nativeUserPathRead(key);
  const wanted = entry.replace(/\\+$/, '').toLowerCase();
  const present = raw.split(';').filter((item) => item !== '');
  const kept = present.filter((item) => item.replace(/\\+$/, '').toLowerCase() !== wanted);
  if (kept.length === present.length) return false;
  nativeUserPathWrite(key, kept.join(';'));
  return true;
}

/** Whether the last environment broadcast after a PATH add answered; null when none was sent (kickoffs/s90 row 5). */
export let lastPathBroadcast: boolean | null = null;

/**
 * THE PATH ENTRY, ADDED (PLAN-install-without-powershell.md D4; install.ps1's `Add-UserPath`): `Path` read raw and
 * written back as REG_EXPAND_SZ, so every `%VARIABLE%` entry already there survives unexpanded, with `bin` appended
 * once. Returns whether it added. A process cannot change its caller's PATH: a new terminal reads the registry.
 */
export function addUserPath(bin: string, key: string = userPathKey()): boolean {
  const raw = nativeUserPathRead(key);
  const wanted = bin.replace(/\\+$/, '').toLowerCase();
  if (raw.split(';').some((item) => item.replace(/\\+$/, '').toLowerCase() === wanted)) return false;
  nativeUserPathWrite(key, raw.trim() ? raw.replace(/;+$/, '') + ';' + bin : bin);
  lastPathBroadcast = nativeBroadcastEnvironment();
  return true;
}

/** The entry an undone transaction had added, taken out again, and said (install.ps1's `Remove-UserPath`). */
export function removeUserPath(bin: string, key: string = userPathKey()): void {
  if (removePathEntry(bin, key)) nativeBroadcastEnvironment();
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isLinkPath(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Under the root physically: no folder between them is a link or junction, so nothing is reached through one. */
function underRootWithoutLinks(root: string, full: string): boolean {
  const rootFull = path.resolve(root).replace(/\\+$/, '');
  const resolved = path.resolve(full);
  if (!resolved.toLowerCase().startsWith(rootFull.toLowerCase() + '\\')) return false;
  for (let parent = path.dirname(resolved); parent.length > rootFull.length; parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && isLinkPath(parent)) return false;
  }
  return true;
}

/**
 * Step 8's step 5 under its distinct rules (what install.ps1's `Invoke-UninstallRemoval` did): a link is removed as a link; a
 * file only if it still hashes to what was frozen, and only after it is revalidated as a physical path under the root;
 * a folder only if empty afterwards. Returns what could not be removed. With `aside`, a file in use is moved into
 * `.leftover` and listed there instead (ADR-0067).
 */
export function removeUninstallList(root: string, removal: RemovalList, key: string = userPathKey(), aside: { tag: string; moved: string[] } | null = null): string[] {
  const problems: string[] = [];
  const message = (error: unknown) => (error as Error).message;
  if (removal.path_entry) {
    try {
      removePathEntry(removal.path_entry, key);
    } catch (error) {
      problems.push(`the PATH entry ${removal.path_entry}: ${message(error)}`);
    }
  }
  for (const name of removal.links ?? []) {
    const full = path.join(root, name);
    if (!fs.existsSync(full) && !isLinkPath(full)) continue;
    if (!isLinkPath(full)) {
      problems.push(`${full} is not a link; left in place`);
      continue;
    }
    try {
      fs.rmdirSync(full);
    } catch (error) {
      problems.push(`${full}: ${message(error)}`);
    }
  }
  for (const file of removal.files ?? []) {
    const full = path.join(root, file.path.replace(/\//g, '\\'));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    if (!underRootWithoutLinks(root, full)) {
      problems.push(`${full} is reached through a link; left in place`);
      continue;
    }
    if (sha256(full) !== file.sha256) {
      problems.push(`${full} changed since uninstall was planned; left in place`);
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch (error) {
      // A RUNNING IMAGE, when the caller runs from inside the root (ADR-0067): moved aside, its delete handed on.
      const to = aside !== null && inUse(error) ? moveAside(root, full, aside.tag) : null;
      if (to !== null) aside!.moved.push(to);
      else problems.push(`${full}: ${message(error)}`);
    }
  }
  const folders = [...(removal.folders ?? [])].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const folder of folders) {
    const full = path.join(root, folder.replace(/\//g, '\\'));
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory() || isLinkPath(full)) continue;
    if (fs.readdirSync(full).length) continue;
    try {
      fs.rmdirSync(full);
    } catch (error) {
      problems.push(`${full}: ${message(error)}`);
    }
  }
  return problems;
}

// --- a running image in a tree being removed (kickoffs/s90 row 0; ADR-0067) -------------------------------------------

/** Where a running image is moved when the tree it sits in is removed: under the root, so the move is a rename. */
export const LEFTOVER = '.leftover';

function inUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * A FILE THAT CANNOT BE DELETED BECAUSE IT IS RUNNING IS MOVED ASIDE (ADR-0067): Windows refuses to delete a running
 * image (EPERM, measured in S82's spike and again in S90's) but renames it on the same volume, so it goes to
 * `<root>\.leftover`, and the tree it was in can go. Returns where it went, or null when the move failed too.
 */
export function moveAside(root: string, file: string, tag: string): string | null {
  const folder = path.join(root, LEFTOVER);
  try {
    fs.mkdirSync(folder, { recursive: true });
    const to = path.join(folder, `${tag}-${randomUUID().replace(/-/g, '').slice(0, 8)}-${path.basename(file)}`);
    fs.renameSync(file, to);
    return to;
  } catch {
    return null;
  }
}

/**
 * A TREE REMOVED WITH ANY RUNNING IMAGE IN IT MOVED ASIDE FIRST (ADR-0067). `library install` run from
 * `current\bin\library.exe` is a bootstrap waiting on its child, its image inside `versions\<v>`: an undo or an
 * uninstall's finish that removes that version meets it. What was moved is added to `moved`; throws if the tree
 * still stands.
 */
export function removeTreeMovingRunning(root: string, tree: string, tag: string, moved: string[]): void {
  try {
    fs.rmSync(tree, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!inUse(error)) throw error;
  }
  const walk = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory() && !isLinkPath(full)) {
        walk(full);
        continue;
      }
      try {
        if (isLinkPath(full) && item.isDirectory()) fs.rmdirSync(full);
        else fs.unlinkSync(full);
      } catch (error) {
        if (!inUse(error)) throw error;
        const to = moveAside(root, full, tag);
        if (to === null) throw error;
        moved.push(to);
      }
    }
  };
  walk(tree);
  fs.rmSync(tree, { recursive: true, force: true });
}

/**
 * THE MOVED FILES' DELETE, HANDED ON (ADR-0067; as `handOffOwnDelete` hands on the finisher's): a `cmd /c` child started
 * outside this process's job retries each delete once a second for up to 20 s, so it lands as soon as the bootstrap
 * that runs the file exits, then removes `.leftover`, and after an uninstall the root, each only when empty. If it
 * cannot start, the next `library install` at this root sweeps `.leftover` under the lock.
 */
export function handOffLeftovers(root: string, moved: string[], removeRoot: boolean): void {
  if (!moved.length || process.platform !== 'win32') return;
  const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const retry = (file: string) => Array.from({ length: 20 }, () => `(if exist "${file}" (ping -n 2 127.0.0.1 >nul & del /f /q "${file}" >nul 2>&1))`).join(' & ');
  const tail = [`rmdir "${path.join(root, LEFTOVER)}" >nul 2>&1`, ...(removeRoot ? [`rmdir "${root}" >nul 2>&1`] : [])];
  try {
    nativeStartDetached(cmd, `${argvQuote(cmd)} /d /c ${[...moved.map(retry), ...tail].join(' & ')}`, path.dirname(cmd));
  } catch {
    // The next install run at this root sweeps .leftover.
  }
}

/**
 * OLD VERSIONS ARE PRUNED (PLAN-one-step-upgrade.md D7). After a committed upgrade, every `versions\<v>` but the two
 * `current.json` names (`version`, and `previous`, which rollback switches to) goes; a `.`-prefixed name (`.incoming-*`)
 * is never touched. Each removal goes through `removeTreeMovingRunning`, so an image still running from a pruned
 * version is moved aside and its delete handed on (ADR-0067). A folder that cannot go is a warning, never a failed
 * upgrade. `remove` is the remover, for a fixture that needs one to fail.
 */
export function pruneVersions(
  root: string,
  keep: string[],
  moved: string[],
  remove: (root: string, tree: string, tag: string, moved: string[]) => void = removeTreeMovingRunning,
): { removed: string[]; warned: string[] } {
  const versions = path.join(root, 'versions');
  const removed: string[] = [];
  const warned: string[] = [];
  for (const name of versionsToPrune(root, keep)) {
    const tree = path.join(versions, name);
    try {
      remove(root, tree, `pruned-${name}`, moved);
      removed.push(name);
    } catch (error) {
      warned.push(`versions\\${name} could not be removed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); it is left, and the next upgrade tries again.`);
    }
  }
  return { removed, warned };
}

/**
 * THE KEEP RULE, ONCE (kickoffs/s94 row 2): the `versions\<v>` folders a prune keeping `keep` removes, in its order, so
 * the upgrade's plan names before the run exactly what the run removes after it. Dot-named folders and files are never
 * among them.
 */
export function versionsToPrune(root: string, keep: string[]): string[] {
  const versions = path.join(root, 'versions');
  if (!fs.existsSync(versions)) return [];
  const kept = new Set(keep.filter((name) => name).map((name) => name.toLowerCase()));
  return fs.readdirSync(versions).sort().filter((name) => {
    if (name.startsWith('.') || kept.has(name.toLowerCase())) return false;
    try {
      return fs.lstatSync(path.join(versions, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** What an earlier hand-off left in `.leftover`, removed where it can be (the next install run, under the lock). */
export function sweepLeftovers(root: string): void {
  const folder = path.join(root, LEFTOVER);
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) {
    try {
      fs.rmSync(path.join(folder, name), { recursive: true, force: true });
    } catch {
      // Still running: the next run tries again.
    }
  }
  try {
    if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
  } catch {
    // Left for the next run.
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Hand this copy's own delete to a child that outlives it: a running exe cannot unlink itself. */
function handOffOwnDelete(): void {
  const self = process.execPath;
  if (!/^deskpost-finish-[0-9a-f]+\.exe$/i.test(path.basename(self))) return;
  const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
  try {
    nativeStartDetached(cmd, `${argvQuote(cmd)} /d /c ping -n 4 127.0.0.1 >nul & del /f /q "${self}"`, path.dirname(self));
  } catch {
    // The copy stays in %TEMP%, which Windows cleans; nothing of the install depends on it.
  }
}

export interface FinisherResult {
  refusal: string | null;
  exitCode: number;
}

export function runFinishUninstall(argv: string[]): FinisherResult {
  const parsed = parseArguments(argv, argumentTable('finish-uninstall'));
  const parent = Number(parsed.options.get('parent-pid') ?? '');
  const root = parsed.options.get('root') ?? '';
  const handshake = parsed.options.get('handshake') ?? '';
  const transaction = parsed.options.get('transaction') ?? '';
  const result = parsed.options.get('result') ?? '';
  if (!Number.isInteger(parent) || parent <= 0 || !root || !handshake || !transaction || !result) {
    return { refusal: 'library finish-uninstall is started by `deskpost uninstall` and takes --parent-pid, --root, --handshake, --transaction and --result; it is never run by hand.', exitCode: 1 };
  }
  const writeResult = (status: string, left: string[]) =>
    fs.writeFileSync(result, JSON.stringify({ status, root, transaction, left, utc: new Date().toISOString() }, null, 2) + '\n');
  try {
    fs.appendFileSync(handshake, `started ${process.pid}\r\n`);
    const deadline = Date.now() + 30000;
    let word = '';
    while (Date.now() < deadline) {
      const text = fs.existsSync(handshake) ? fs.readFileSync(handshake, 'utf8') : '';
      if (/^cancel/m.test(text)) {
        word = 'cancel';
        break;
      }
      if (/^go/m.test(text)) {
        word = 'go';
        break;
      }
      sleep(100);
    }
    if (word !== 'go') {
      writeResult('cancelled', []);
      return { refusal: null, exitCode: 0 };
    }
    // THE PARENT EXITS FIRST: it is the program being removed.
    const parentDeadline = Date.now() + 120000;
    while (Date.now() < parentDeadline && processExists(parent)) sleep(100);

    let problems: string[];
    try {
      const receipt = readReceipt(root);
      const pending = receipt.pending as { id?: string; removal?: RemovalList } | null;
      if (!pending || pending.id !== transaction || !pending.removal) {
        writeResult('failed', [`the receipt no longer records transaction ${transaction}`]);
        return { refusal: null, exitCode: 0 };
      }
      problems = removeUninstallList(root, pending.removal);
    } catch (error) {
      problems = [`the removal stopped: ${(error as Error).message}`];
    }
    if (problems.length) {
      // FAILED: pending and the receipt stay, owned by no live process, for -Resume finish.
      try {
        withLifecycleLock(root, () => {
          const receipt = readReceipt(root);
          if (receipt.pending) (receipt.pending as Record<string, unknown>)['owner'] = null;
          writeReceipt(root, receipt);
        });
      } catch {
        // The result below still says what was left.
      }
      writeResult('failed', problems);
      return { refusal: null, exitCode: 0 };
    }
    // COMPLETED: the receipt and .pending go last, together INSIDE THE LOCK (PLAN-install-without-powershell.md D5), so an
    // install that claims the root in a gap loses nothing; then the lock and the root, each only if nothing else is left.
    withLifecycleLock(root, () => {
      fs.rmSync(receiptPath(root), { force: true });
      fs.rmSync(path.join(root, '.pending'), { recursive: true, force: true });
    });
    try {
      fs.rmSync(path.join(root, '.lifecycle.lock'), { force: true });
    } catch {
      // Held by another process: left, as the script left it.
    }
    try {
      if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
    } catch {
      // Not empty after all, or in use: the result still says completed for what was frozen.
    }
    writeResult('completed', []);
    return { refusal: null, exitCode: 0 };
  } finally {
    handOffOwnDelete();
  }
}
