/**
 * `library finish-uninstall` (kickoffs/s83 row 2, PLAN-no-powershell-runtime.md D8, ruling 4): the uninstall finisher,
 * run by a COPY of this program in %TEMP% that `deskpost uninstall` starts outside its own job and then exits. It
 * ports tools/Finish-Uninstall.ps1, which it replaces, rule for rule:
 *
 *   THE HANDSHAKE. It writes `started <pid>` and waits up to 30 s. The parent, on seeing it, makes this process the
 *   pending operation's owner and writes `go`; only then does this wait (up to 120 s) for the parent to exit and remove
 *   anything. `cancel`, or no `go` in time, and it exits having deleted nothing.
 *   THE REMOVAL is `removeUninstallList`, the same rules as install.ps1's removal block, which self-test sections 50
 *   (the files) and 116 (the PATH entry, through a compiled kernel) hold it to on the same frozen list.
 *   ONLY ON `completed` are `pending` cleared and the receipt deleted, last. On `failed` both stay, owned by no live
 *   process, and re-running the installer (-Resume finish) completes the list with no program present.
 *
 * A RUNNING EXE CANNOT DELETE ITSELF (EPERM, measured in S82's spike), so as it exits the copy hands its own delete to a
 * `cmd /c ping ... & del` child started with CREATE_NO_WINDOW, outside this process's job, as the spike measured.
 * Internal: listed in `library verbs`, never in the menu, and never run by hand.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArguments } from './argv.ts';
import { readReceipt, writeReceipt, withLifecycleLock, argvQuote, receiptPath, type RemovalList } from './lifecycle.ts';
import { nativeStartDetached, nativeUserPathRead, nativeUserPathWrite } from './win32proc.ts';

/** The HKCU subkey whose `Path` the PATH entry is removed from. A fixture names its own (self-test section 116). */
export function userPathKey(): string {
  return (process.env['DESKPOST_PATH_KEY'] ?? '').trim() || 'Environment';
}

/**
 * The one PATH entry Deskpost added, read and written raw (unexpanded) so REG_EXPAND_SZ and every other entry survive:
 * install.ps1's `Remove-DeskpostPathEntry`. Empty entries are dropped and nothing is written unless an entry went.
 */
export function removePathEntry(entry: string, key: string = userPathKey()): void {
  const raw = nativeUserPathRead(key);
  const wanted = entry.replace(/\\+$/, '').toLowerCase();
  const present = raw.split(';').filter((item) => item !== '');
  const kept = present.filter((item) => item.replace(/\\+$/, '').toLowerCase() !== wanted);
  if (kept.length !== present.length) nativeUserPathWrite(key, kept.join(';'));
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
 * Step 8's step 5 under its distinct rules (install.ps1's `Invoke-UninstallRemoval`): a link is removed as a link; a
 * file only if it still hashes to what was frozen, and only after it is revalidated as a physical path under the root;
 * a folder only if empty afterwards. Returns what could not be removed.
 */
export function removeUninstallList(root: string, removal: RemovalList, key: string = userPathKey()): string[] {
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
      problems.push(`${full}: ${message(error)}`);
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
  const parsed = parseArguments(argv, ['parent-pid', 'root', 'handshake', 'transaction', 'result']);
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
    // COMPLETED: the receipt goes last, then the lock, .pending and the root, each only if nothing else is left.
    fs.rmSync(receiptPath(root), { force: true });
    fs.rmSync(path.join(root, '.pending'), { recursive: true, force: true });
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
