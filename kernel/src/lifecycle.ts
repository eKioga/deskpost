/**
 * An install's life after it is made: the close-your-sessions rule, `deskpost uninstall` and `deskpost rollback`
 * (PLAN-install-onboarding.md step 8; ADR-0058).
 *
 * ONE LIFECYCLE RULE FOR EVERY CHANGE. `<root>\install-receipt.json` holds `owned` (what Deskpost created) and at most
 * one `pending` operation with its owner, a pid AND that process's start time. Checking and claiming happen under
 * `<root>\.lifecycle.lock`, opened share-nothing, and the lock is never held across a prompt. install.ps1 keeps the
 * same receipt with the same rules; the two are one format, read and written by both.
 *
 * CONSTRAINTS OVER MACHINERY (round 1). Sessions are closed before anything changes, so there is no live activation
 * race; the program folder was new or empty, so uninstall's reach is provable; the binary keeps its name, so a
 * rollback to 1.0 keeps every Library guarded.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import type { PsJsonValue } from './psjson.ts';
import { writeAtomicText } from './fsx.ts';
import { readRegistry } from './workspace.ts';
import { readSeatRegistry } from './desk.ts';
import { getSeatClaimState, openShareNothing, type ExclusiveHandle } from './seatclaim.ts';
import { agentProcessIdentity, UNREADABLE_IDENTITY } from './procstart.ts';
import { nativeProcessCalls, nativeProcessImagePath, nativeProcessTable, nativeStartDetached } from './win32proc.ts';
import { COMMAND_NAME, entryInvocation, installRootOf, isKernelBinary, powerShellScript } from './machine.ts';
import { isCompiled, programRoot } from './programroot.ts';
import { askAtTerminal } from './prompt.ts';
import { basicMemoryRollbackCheck } from './bmopen.ts';
import { librariesServedByRoot } from './installs.ts';
import { compareVersions } from './versions.ts';

// --- the receipt and the lock -----------------------------------------------------------------------------

export interface Receipt {
  schema: number;
  owned: Record<string, unknown>[];
  pending: Record<string, unknown> | null;
  path_change?: boolean | null;
  [key: string]: unknown;
}

export function receiptPath(root: string): string {
  return path.join(root, 'install-receipt.json');
}

export function readReceipt(root: string): Receipt {
  const file = receiptPath(root);
  if (!fs.existsSync(file)) return { schema: 1, owned: [], pending: null, path_change: null };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Receipt;
  parsed.owned = Array.isArray(parsed.owned) ? parsed.owned : parsed.owned ? [parsed.owned as unknown as Record<string, unknown>] : [];
  parsed.pending ??= null;
  return parsed;
}

export function writeReceipt(root: string, receipt: Receipt): void {
  writeAtomicText(receiptPath(root), JSON.stringify(receipt, null, 2) + '\n');
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `body` holding `<root>\.lifecycle.lock` share-nothing, waiting up to 15 s for another holder to let go. */
export function withLifecycleLock<T>(root: string, body: () => T): T {
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, '.lifecycle.lock');
  const deadline = Date.now() + 15000;
  let handle: ExclusiveHandle | null = null;
  while (handle === null) {
    try {
      handle = openShareNothing(lockPath);
    } catch {
      if (Date.now() > deadline) throw new Error(`another Deskpost install, upgrade or uninstall is changing ${root} right now (it holds ${lockPath}). Let it finish, then run this again.`);
      sleep(200);
    }
  }
  try {
    return body();
  } finally {
    handle.close();
  }
}

/** This process's owner record: its pid and start time, spelled as install.ps1 spells one (round 5, #2). */
export function selfOwner(): { pid: number; start_utc: string | null } {
  return { pid: process.pid, start_utc: agentProcessIdentity(process.pid, { fresh: true }) };
}

/** Alive only if a process with that id exists AND has that start time: a reused pid is someone else. */
export function ownerAlive(owner: unknown): boolean {
  if (!owner || typeof owner !== 'object') return false;
  const record = owner as Record<string, unknown>;
  const pid = Number(record['pid']);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const identity = agentProcessIdentity(pid, { fresh: true });
  if (identity === null) return false;
  return identity === UNREADABLE_IDENTITY || identity === String(record['start_utc'] ?? '');
}

/** Record `operation` as this process's pending transaction, or refuse naming what holds the root. */
function claimPending(root: string, operation: string, fields: Record<string, unknown>): string {
  return withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    if (receipt.pending !== null) {
      const pending = receipt.pending;
      if (ownerAlive(pending['owner'])) {
        throw new Error(`a Deskpost ${String(pending['operation'])} is running on ${root} (process ${String((pending['owner'] as Record<string, unknown>)['pid'])}). Let it finish, then run this again.`);
      }
      throw new Error(
        `an interrupted Deskpost ${String(pending['operation'])} is recorded at ${root} (transaction ${String(pending['id'])}). ` +
          'Re-run the installer to finish or undo it before anything else changes this install.',
      );
    }
    const id = randomUUID().replace(/-/g, '');
    receipt.pending = { id, operation, owner: selfOwner(), phase: 'recorded', ...fields };
    writeReceipt(root, receipt);
    return id;
  });
}

function updatePending(root: string, id: string, fields: Record<string, unknown>): void {
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    if (receipt.pending === null || receipt.pending['id'] !== id) throw new Error(`the pending transaction at ${root} is no longer this one (${id}); stopping.`);
    Object.assign(receipt.pending, fields);
    writeReceipt(root, receipt);
  });
}

function clearPending(root: string, id: string): void {
  withLifecycleLock(root, () => {
    const receipt = readReceipt(root);
    if (receipt.pending !== null && receipt.pending['id'] === id) {
      receipt.pending = null;
      writeReceipt(root, receipt);
    }
  });
}

// --- close your sessions (#7, #10) ----------------------------------------------------------------------------

export interface LiveSessions {
  /**
   * HELD OR ORPHANED, LABELLED (PLAN-one-step-upgrade.md D3): both are a running session and both block; the label says
   * what to close.
   */
  seats: { library: string; seat: string; agent_pid: number | null; state: 'held' | 'orphaned'; label: string }[];
  processes: { pid: number; path: string }[];
  unreadable: string[];
}

interface ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string | null;
}

/**
 * Every process with its parent and image path, the rows Win32_Process gives. A compiled kernel reads them from one
 * Toolhelp32 snapshot and `QueryFullProcessImageNameW` (S83, ruling 3 of kickoffs/s83), with a null path where a
 * process cannot be opened, as the CIM row has; under Node the CIM query stays as the fallback.
 */
export function windowsProcesses(): ProcessRow[] {
  if (nativeProcessCalls() !== null) {
    return nativeProcessTable().map((row) => ({ ProcessId: row.pid, ParentProcessId: row.parentPid, ExecutablePath: nativeProcessImagePath(row.pid) }));
  }
  const text = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(text) as ProcessRow | ProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * EVERY LIVE SESSION THAT WOULD MEET A SWITCH (step 2). A seat claim held or orphaned in any registered Library, and any
 * running `library.exe` whose image is under `root` -- a hook, an `mcp serve`, a seat holder -- measured in step 0 to
 * show its launch path under the root. This process and its ancestors are excluded: the uninstall, rollback or
 * installer asking. Best effort, and said so: a session started a moment after the check is not prevented.
 */
export function liveSessions(root: string, options: { excludePids?: number[]; library?: string } = {}): LiveSessions {
  const found: LiveSessions = { seats: [], processes: [], unreadable: [] };
  let libraries: string[] = [];
  try {
    libraries = readRegistry().map((entry) => entry.root);
  } catch (error) {
    found.unreadable.push((error as Error).message);
  }
  const named = options.library ? path.resolve(options.library).toLowerCase() : null;
  if (options.library && !libraries.some((library) => path.resolve(library).toLowerCase() === named)) libraries.push(options.library);
  for (const library of libraries) {
    const state = path.join(library, '.claude');
    if (!fs.existsSync(path.join(state, 'seats'))) continue;
    // ONLY A LIBRARY THIS INSTALL RUNS: one whose registrations name the root. A Library bound to another program (a
    // checkout, another install) is not switched by this, and its sessions are not in the way -- unless it is the
    // Library the plan writes, whose registrations are rewritten under its sessions.
    if (path.resolve(library).toLowerCase() !== named && !libraryNamesInstall(library, root)) continue;
    try {
      for (const row of readSeatRegistry(state)) {
        const claim = getSeatClaimState(state, row.seat);
        if (claim.state === 'free') continue;
        found.seats.push({ library, seat: row.seat, agent_pid: claim.agentPid || null, state: claim.state, label: seatSessionLabel(claim) });
      }
    } catch (error) {
      found.unreadable.push(`${library}: ${(error as Error).message}`);
    }
  }
  if (process.platform === 'win32') {
    try {
      const rows = windowsProcesses();
      const byPid = new Map(rows.map((row) => [row.ProcessId, row]));
      const excluded = new Set<number>(options.excludePids ?? []);
      for (let pid: number | undefined = process.pid; pid && !excluded.has(pid); pid = byPid.get(pid)?.ParentProcessId) excluded.add(pid);
      const prefix = path.resolve(root).toLowerCase() + path.sep;
      for (const row of rows) {
        if (!row.ExecutablePath || excluded.has(row.ProcessId)) continue;
        if (!/[\\/]library\.exe$/i.test(row.ExecutablePath)) continue;
        if (!path.resolve(row.ExecutablePath).toLowerCase().startsWith(prefix)) continue;
        found.processes.push({ pid: row.ProcessId, path: row.ExecutablePath });
      }
    } catch (error) {
      found.unreadable.push(`the process list could not be read: ${(error as Error).message}`);
    }
  }
  return found;
}

/** What to close for a held or orphaned seat (D3): its open session, its launcher, or its orphaned session. */
export function seatSessionLabel(claim: { state: string; bindingState: string; bindingStale: boolean; agentPid: number }): string {
  if (claim.state === 'orphaned') return `orphaned: its launcher is gone but its Claude Code or Codex session is still running (process ${claim.agentPid}); end that session`;
  return claim.bindingState === 'committed' && !claim.bindingStale && claim.agentPid > 0
    ? `held: its session is open (agent process ${claim.agentPid})`
    : 'held: its launcher holds it, no session bound yet';
}

/** Whether any of a Library's registration files names a path under `root`, in either slash style. */
export function libraryNamesInstall(library: string, root: string): boolean {
  const needles = [path.resolve(root), path.resolve(root).replace(/\\/g, '/'), path.resolve(root).replace(/\\/g, '\\\\')].map((needle) => needle.toLowerCase());
  for (const relative of ['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.codex/hooks.json', '.codex/config.toml']) {
    const file = path.join(library, ...relative.split('/'));
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    if (needles.some((needle) => text.includes(needle))) return true;
  }
  return false;
}

export function sessionsText(found: LiveSessions): string {
  const lines: string[] = [];
  for (const seat of found.seats) lines.push(`  seat '${seat.seat}' in ${seat.library}: ${seat.label}`);
  for (const process of found.processes) lines.push(`  process ${process.pid}: ${process.path} (a hook or mcp serve of an open session)`);
  return lines.join('\n');
}

/** Whether a wait meets anything open. */
function sessionsOpen(found: LiveSessions): boolean {
  return found.seats.length > 0 || found.processes.length > 0;
}

/** A key in the wait's raw mode: `q`, `Q` or Ctrl+C (byte 0x03 in raw mode) stops it; any other key is ignored. */
export function waitKeyStops(chunk: Buffer | string): boolean {
  return /[qQ\x03]/.test(typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
}

export interface SessionWait {
  /** What is open now; called again every 2 seconds. */
  look: () => LiveSessions;
  /** The first line, which keeps `Close your sessions first` (Test-InstallProof.ps1:93 matches it). */
  header: string;
  interactive: boolean;
  /** `--wait <seconds>`: a non-interactive run looks again up to this long before it refuses. */
  waitSeconds?: number | null;
  /** The refusal's last sentence, for a run with nobody to wait for. */
  advice: string;
  say: (text: string) => void;
}

/**
 * THE ONE WAIT FOR OPEN SESSIONS (PLAN-one-step-upgrade.md D3; ADR-0068), for install, upgrade, uninstall and rollback.
 * Interactive, it lists what is open and looks again by itself every 2 seconds in raw mode: `q` or Ctrl+C stops it
 * with no Enter needed, and the terminal is restored however it ends. A terminal that refuses raw mode (a
 * pseudo-terminal that reports a TTY) falls back to the Enter loop. Non-interactive, it refuses at once, or with
 * `--wait <seconds>` looks every 2 seconds up to that limit and refuses with the list. True when nothing is open; false
 * when the reader stopped it.
 */
export async function waitForSessionsToClose(wait: SessionWait): Promise<boolean> {
  let found = wait.look();
  if (!sessionsOpen(found)) return true;
  const text = (now: LiveSessions) => `${wait.header}\n${sessionsText(now)}`;
  if (!wait.interactive) {
    const deadline = Date.now() + Math.max(0, wait.waitSeconds ?? 0) * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())));
      found = wait.look();
      if (!sessionsOpen(found)) return true;
    }
    throw new Error(`${text(found)}\n${wait.advice}`);
  }
  wait.say(text(found));
  const stdin = process.stdin;
  let raw = false;
  try {
    stdin.setRawMode(true);
    raw = true;
  } catch {
    raw = false;
  }
  if (!raw) {
    for (;;) {
      if ((await prompt('[Enter] look again   [q] quit › ')).toLowerCase() === 'q') return false;
      found = wait.look();
      if (!sessionsOpen(found)) return true;
      wait.say(text(found));
    }
  }
  wait.say('Looking again every 2 seconds as they close.   [q] quit');
  try {
    return await new Promise<boolean>((resolve) => {
      let shown = sessionsText(found);
      const finish = (clear: boolean) => {
        clearInterval(timer);
        stdin.off('data', onData);
        resolve(clear);
      };
      const onData = (chunk: Buffer | string) => {
        if (waitKeyStops(chunk)) finish(false);
      };
      const timer = setInterval(() => {
        const now = wait.look();
        if (!sessionsOpen(now)) return finish(true);
        const listed = sessionsText(now);
        if (listed !== shown) {
          shown = listed;
          wait.say(text(now));
        }
      }, 2000);
      stdin.on('data', onData);
      stdin.resume();
    });
  } finally {
    try {
      stdin.setRawMode(false);
    } catch {
      // A terminal that took raw mode gives it back; nothing else to restore.
    }
    stdin.pause();
  }
}

/** Refuse, or wait for the sessions to close, while anything in `liveSessions` is open. */
async function requireSessionsClosed(root: string, verb: string, interactive: boolean): Promise<void> {
  const clear = await waitForSessionsToClose({
    look: () => liveSessions(root),
    header: `Close your sessions first: ${verb} changes the program they are running.`,
    interactive,
    advice: `Close them (end each Claude Code or Codex session at those seats; an orphaned claim, whose holder is gone, clears when its agent process ends), then run ${verb} again.`,
    say: (text) => process.stdout.write(text + '\n'),
  });
  if (!clear) throw new Error(`${verb} stopped; nothing was changed.`);
}

// --- the terminal ------------------------------------------------------------------------------------------------

function isInteractive(yes: boolean, json: boolean): boolean {
  return !yes && !json && process.env['DESKPOST_YES'] !== '1' && !process.env['CI'] && process.stdin.isTTY === true;
}

/** A confirmation answered only by what is typed after it (S56, prompt.ts); Ctrl+C or a closed input is `q`, the safe key. */
function prompt(question: string): Promise<string> {
  return askAtTerminal(question).catch(() => 'q');
}

// --- what Deskpost owns under the root (step 8) -------------------------------------------------------------------------

export const SHIM_TEXT = '@"%~dp0..\\current\\bin\\library.exe" %*\r\n';

/**
 * THE GIT BASH SHIM (kickoffs/s94 row 1; three Reports, the latest "library is not runnable from Git Bash: bin has only
 * .cmd shims"). Git Bash runs no `.cmd` by its bare name, so `deskpost` and `library` there found nothing. Beside each
 * `.cmd` shim is an extensionless `sh` script with LF endings, as npm writes beside its own: cmd.exe and PowerShell
 * resolve the bare name through PATHEXT and never run it, and Git Bash runs it through its shebang.
 */
export const SH_SHIM_TEXT = '#!/bin/sh\nexec "$(dirname "$0")/../current/bin/library.exe" "$@"\n';

/** The first release that writes the Git Bash shims. */
export const SH_SHIMS_SINCE = '1.3.7';

/**
 * A ROLLBACK TO A VERSION OLDER THAN THE GIT BASH SHIMS TAKES THEM AWAY (kickoffs/s94 row 1): that version neither writes
 * nor removes them, so its own uninstall would leave `bin` and the install folder behind. Only a file holding exactly
 * the shim Deskpost writes is removed; the next upgrade writes the pair again.
 */
export function dropShimsNewerThan(root: string, version: string): string[] {
  if (compareVersions(version, SH_SHIMS_SINCE) !== 'older') return [];
  const dropped: string[] = [];
  for (const shim of SHIM_FILES.filter((entry) => entry.text === SH_SHIM_TEXT)) {
    const file = path.join(root, 'bin', shim.name);
    try {
      if (fs.readFileSync(file, 'utf8') !== shim.text) continue;
      fs.rmSync(file, { force: true });
      dropped.push(shim.name);
    } catch {
      // Not there, or not readable: left as it is.
    }
  }
  return dropped;
}

/** Every shim an install writes in `<root>\bin`, with its text: written, owned, listed and removed as one set. */
export const SHIM_FILES: readonly { name: string; text: string }[] = [
  { name: 'deskpost.cmd', text: SHIM_TEXT },
  { name: 'library.cmd', text: SHIM_TEXT },
  { name: 'deskpost', text: SH_SHIM_TEXT },
  { name: 'library', text: SH_SHIM_TEXT },
];

function sha256File(file: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    // A FILE THAT CANNOT BE READ CANNOT BE PROVED DESKPOST'S, so the preview refuses whole, saying which (S55).
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'is in use or not readable' : `could not be read (${code ?? (error as Error).message})`;
    throw new Error(`${file} ${why}, so it cannot be checked against what Deskpost installed. Close what holds it and run this again. Nothing was changed.`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** One ZIP's file entries in central-directory order: each name, and its uncompressed bytes read on demand. */
function zipEntries(zipFile: string): { name: string; bytes: () => Buffer }[] {
  const data = fs.readFileSync(zipFile);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${zipFile} is not a ZIP archive this can read (no end of central directory).`);
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const out: { name: string; bytes: () => Buffer }[] = [];
  for (let n = 0; n < count; n += 1) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error(`${zipFile} has a malformed central directory.`);
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    out.push({
      name,
      bytes: () => {
        const localName = data.readUInt16LE(local + 26);
        const localExtra = data.readUInt16LE(local + 28);
        const start = local + 30 + localName + localExtra;
        const raw = data.subarray(start, start + compressed);
        const bytes = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
        if (bytes === null) throw new Error(`${zipFile} holds ${name} compressed with method ${method}, which this cannot read.`);
        return bytes;
      },
    });
  }
  return out;
}

/** One ZIP's file entries, name and uncompressed bytes' SHA-256, read from its central directory (legacy adoption). */
export function zipInventory(zipFile: string): { path: string; sha256: string }[] {
  return zipEntries(zipFile)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ path: entry.name, sha256: createHash('sha256').update(entry.bytes()).digest('hex') }));
}

/**
 * EXTRACT A RELEASE ARCHIVE (PLAN-install-without-powershell.md D2), as install.ps1's `ZipFile.ExtractToDirectory` and
 * its one-top-folder check did, refusing before anything is written: an absolute name, a drive, a `..` segment, and
 * anything but exactly one top folder holding every file. Returns that folder, under `destination`.
 */
export function zipExtract(zipFile: string, destination: string): string {
  const entries = zipEntries(zipFile);
  const tops = new Set<string>();
  const label = path.basename(zipFile);
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`${label} names an absolute path (${entry.name}); a release holds relative paths only. Nothing was extracted.`);
    const segments = name.split('/').filter((segment) => segment !== '');
    if (segments.some((segment) => segment === '..' || segment === '.')) throw new Error(`${label} names a path that leaves its folder (${entry.name}). Nothing was extracted.`);
    // A ':' is a drive or an alternate data stream on Windows, never a file name a release ships.
    if (segments.some((segment) => segment.includes(':'))) throw new Error(`${label} names a path with ':' in it (${entry.name}), which is not a file name. Nothing was extracted.`);
    if (!segments.length) continue;
    if (segments.length === 1 && !name.endsWith('/')) throw new Error(`${label} holds the file ${entry.name} outside a top-level folder; a release holds one folder. Nothing was extracted.`);
    tops.add(segments[0]!);
  }
  if (tops.size !== 1) throw new Error(`${label} holds ${tops.size} top-level folders; a release holds one. Nothing was extracted.`);
  const top = path.join(destination, [...tops][0]!);
  fs.mkdirSync(top, { recursive: true });
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    const target = path.join(destination, ...name.split('/').filter((segment) => segment !== ''));
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.bytes());
  }
  return top;
}

export interface RemovalList {
  /** Files removed only if they still hash to `sha256` (relative to the root, forward-slashed). */
  files: { path: string; sha256: string }[];
  /** Links removed as links, never walked into. */
  links: string[];
  /** Folders removed only if empty afterwards, deepest first. */
  folders: string[];
  /** Named items kept, with why. */
  kept: string[];
  /** The PATH entry, when Deskpost added it. */
  path_entry: string | null;
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * THE WHOLE REMOVAL, COMPUTED WHILE `current` STILL RESOLVES (round 2, #7). Per file, from each version's inventory
 * (`.inventory.json` from 1.1; for 1.0, the kept archive in `downloads\` checked against `.archive-sha256`); a file is
 * Deskpost's only if listed and still matching. The shims, `current`, `current.json` and the receipt are adopted by
 * name. Anything unrecognised is kept, with its folders and the root.
 */
export function programRemoval(root: string): RemovalList {
  const receipt = readReceipt(root);
  const list: RemovalList = { files: [], links: [], folders: [], kept: [], path_entry: null };
  const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');
  const addFile = (file: string) => {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) list.files.push({ path: rel(file), sha256: sha256File(file) });
  };
  const versions = path.join(root, 'versions');
  const downloads = path.join(root, 'downloads');
  const adoptedArchives: string[] = [];
  if (fs.existsSync(versions)) {
    for (const version of fs.readdirSync(versions)) {
      const folder = path.join(versions, version);
      if (isLink(folder) || !fs.statSync(folder).isDirectory()) {
        list.kept.push(`versions/${version} (not a version folder)`);
        continue;
      }
      let inventory: { path: string; sha256: string }[] | null = null;
      const inventoryFile = path.join(folder, '.inventory.json');
      if (fs.existsSync(inventoryFile)) {
        try {
          inventory = (JSON.parse(fs.readFileSync(inventoryFile, 'utf8').replace(/^﻿/, '')) as { files: { path: string; sha256: string }[] }).files;
        } catch {
          inventory = null;
        }
      } else {
        // LEGACY ADOPTION (round 2, #6; round 3, #5): 1.0 kept the archive it installed from.
        const recorded = path.join(folder, '.archive-sha256');
        const archive = fs.existsSync(downloads) ? fs.readdirSync(downloads).find((name) => name.startsWith(`deskpost-${version}-`) && name.endsWith('.zip')) : undefined;
        if (archive && fs.existsSync(recorded) && sha256File(path.join(downloads, archive)) === fs.readFileSync(recorded, 'utf8').trim()) {
          inventory = zipInventory(path.join(downloads, archive)).map((entry) => ({ path: entry.path.split('/').slice(1).join('/'), sha256: entry.sha256 }));
          adoptedArchives.push(archive);
        }
      }
      if (inventory === null) {
        list.kept.push(`versions/${version} (not recognised: no inventory, and no kept archive matching it), left in place`);
        continue;
      }
      for (const entry of inventory) {
        const file = path.join(folder, ...entry.path.split('/'));
        if (!fs.existsSync(file)) continue;
        if (sha256File(file) === entry.sha256) list.files.push({ path: rel(file), sha256: entry.sha256 });
        else list.kept.push(`${rel(file)} (changed since it was installed)`);
      }
      for (const name of ['.inventory.json', '.archive-sha256']) addFile(path.join(folder, name));
      const folders: string[] = [];
      const walk = (directory: string) => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory() && !isLink(path.join(directory, item.name))) walk(path.join(directory, item.name));
        folders.push(rel(directory));
      };
      walk(folder);
      list.folders.push(...folders);
    }
    list.folders.push('versions');
  }
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (/^current(\.(new|old)-.+)?$/.test(name) && isLink(path.join(root, name))) list.links.push(name);
  }
  for (const shim of SHIM_FILES) {
    const file = path.join(root, 'bin', shim.name);
    if (!fs.existsSync(file)) continue;
    if (fs.readFileSync(file, 'utf8') === shim.text) addFile(file);
    else list.kept.push(`bin/${shim.name} (not the shim Deskpost writes)`);
  }
  list.folders.push('bin');
  addFile(path.join(root, 'current.json'));
  // THE MENU'S UPDATE RECORD (D2) is Deskpost's, so an uninstall removes it and an empty root stays empty.
  addFile(path.join(root, 'update-check.json'));
  if (fs.existsSync(downloads)) {
    for (const name of adoptedArchives) addFile(path.join(downloads, name));
    const sums = path.join(downloads, 'SHA256SUMS');
    if (fs.existsSync(sums) && adoptedArchives.length) addFile(sums);
    list.folders.push('downloads');
  }
  const owned = receipt.owned.find((item) => item['kind'] === 'path');
  if (owned && typeof owned['entry'] === 'string') list.path_entry = owned['entry'];
  // THE RECEIPT, THE LOCK AND .pending GO LAST, by the finisher, after it has written its result.
  return list;
}

// --- the Libraries' registrations (step 8's table) ---------------------------------------------------------------------

function underRoot(file: string, root: string): boolean {
  const full = path.resolve(file.replace(/\//g, path.sep)).toLowerCase();
  return full.startsWith(path.resolve(root).toLowerCase() + path.sep);
}

/** Whether a hook or server entry is one this install wrote: a Deskpost form whose binary or -File script is under root. */
export function isThisInstallsEntry(entry: unknown, root: string): boolean {
  const invocation = entryInvocation(entry);
  if (invocation === null) return false;
  if (isKernelBinary(invocation.program)) return underRoot(invocation.program, root);
  const script = powerShellScript(invocation);
  return script !== null && underRoot(script, root);
}

function withoutEntries(hooks: unknown, root: string): { hooks: unknown; removed: number } {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { hooks, removed: 0 };
  let removed = 0;
  const out: Record<string, unknown> = {};
  for (const [event, blocks] of Object.entries(hooks as Record<string, unknown>)) {
    const kept: unknown[] = [];
    for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
      if (!block || typeof block !== 'object' || !Array.isArray((block as Record<string, unknown>)['hooks'])) {
        kept.push(block);
        continue;
      }
      const entries = ((block as Record<string, unknown>)['hooks'] as unknown[]).filter((entry) => {
        const ours = isThisInstallsEntry(entry, root);
        if (ours) removed += 1;
        return !ours;
      });
      if (entries.length) kept.push({ ...(block as Record<string, unknown>), hooks: entries });
    }
    if (kept.length) out[event] = kept;
  }
  return { hooks: out, removed };
}

export interface LibraryEdit {
  library: string;
  file: string;
  removed: number;
  content: string | null;
  /** The file's hash when the edit was computed; it is written only while it still holds it (inspection #4). */
  old_sha256: string;
}

/** Each registered Library's files with this install's entries taken out: a matching entry, never a file (step 8). */
export function libraryEdits(root: string): { edits: LibraryEdit[]; skipped: string[] } {
  const edits: LibraryEdit[] = [];
  const skipped: string[] = [];
  let libraries: string[] = [];
  try {
    libraries = readRegistry().map((entry) => entry.root);
  } catch (error) {
    skipped.push((error as Error).message);
  }
  for (const library of libraries) {
    if (!fs.existsSync(path.join(library, '.library', 'workspace.json'))) {
      skipped.push(`${library} (not there)`);
      continue;
    }
    for (const relative of ['.claude/settings.local.json', '.claude/settings.json', '.codex/hooks.json']) {
      const file = path.join(library, ...relative.split('/'));
      if (!fs.existsSync(file)) continue;
      let document: Record<string, unknown>;
      try {
        document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      } catch {
        skipped.push(`${file} (not readable JSON; left as it is)`);
        continue;
      }
      if (!('hooks' in document)) continue;
      const result = withoutEntries(document['hooks'], root);
      if (!result.removed) continue;
      const next = { ...document };
      if (Object.keys(result.hooks as Record<string, unknown>).length) next['hooks'] = result.hooks;
      else if (relative === '.codex/hooks.json') next['hooks'] = {};
      else delete next['hooks'];
      edits.push({ library, file, removed: result.removed, content: JSON.stringify(next, null, 2) + '\n', old_sha256: sha256File(file) });
    }
    const mcp = path.join(library, '.mcp.json');
    if (fs.existsSync(mcp)) {
      try {
        const document = JSON.parse(fs.readFileSync(mcp, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
        const servers = document['mcpServers'] as Record<string, unknown> | undefined;
        if (servers && isThisInstallsEntry(servers['validated-book-reader'], root)) {
          const { ['validated-book-reader']: _reader, ...rest } = servers;
          edits.push({ library, file: mcp, removed: 1, content: JSON.stringify({ ...document, mcpServers: rest }, null, 2) + '\n', old_sha256: sha256File(mcp) });
        }
      } catch {
        skipped.push(`${mcp} (not readable JSON; left as it is)`);
      }
    }
    const toml = path.join(library, '.codex', 'config.toml');
    if (fs.existsSync(toml)) {
      const text = fs.readFileSync(toml, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((line) => /^\[mcp_servers\.validated-book-reader\]\s*$/.test(line.trim()));
      if (start >= 0) {
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i += 1) if (/^\s*\[/.test(lines[i]!) && !/^\s*\[mcp_servers\.validated-book-reader\./.test(lines[i]!)) { end = i; break; }
        const command = lines.slice(start, end).map((line) => /^\s*command\s*=\s*"(.*)"\s*$/.exec(line)).find((match) => match)?.[1]?.replace(/\\\\/g, '\\');
        const args = lines.slice(start, end).join(' ');
        const script = /"-File",\s*"([^"]+)"/.exec(args)?.[1];
        if ((command && isKernelBinary(command) && underRoot(command, root)) || (script && underRoot(script.replace(/\\\\/g, '\\'), root))) {
          edits.push({ library, file: toml, removed: 1, content: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), old_sha256: sha256File(toml) });
        }
      }
    }
  }
  return { edits, skipped };
}

// --- uninstall ---------------------------------------------------------------------------------------------------------

export interface LifecycleResult {
  refusal: string | null;
  exitCode: number;
  value: PsJsonValue | null;
  humanText?: string;
  asJson: boolean;
}

function installRootHere(): string {
  const root = installRootOf(programRoot());
  if (root === null) throw new Error(`this program is not an installed release (it runs from ${programRoot()}), so there is no install to change. Run the installed \`${COMMAND_NAME}\`.`);
  return root;
}

function uninstallPreview(root: string, removal: RemovalList, edits: LibraryEdit[], skipped: string[]): string {
  const lines = [`Uninstall Deskpost from ${root}`, '', 'From your Libraries (their own files and Books are not touched):'];
  if (!edits.length) lines.push('  nothing registered by this install');
  for (const edit of edits) lines.push(`  ${edit.file}: ${edit.removed} Deskpost entr${edit.removed === 1 ? 'y' : 'ies'}`);
  for (const skip of skipped) lines.push(`  skipped: ${skip}`);
  lines.push('', 'From the program folder:');
  lines.push(`  ${removal.files.length} file(s) Deskpost installed, ${removal.links.length} link(s)`);
  if (removal.path_entry) lines.push(`  the PATH entry ${removal.path_entry}`);
  for (const kept of removal.kept) lines.push(`  kept: ${kept}`);
  lines.push('', 'Your Libraries stay where they are; only what Deskpost added is removed.');
  return lines.join('\n');
}

/**
 * `deskpost uninstall [--dry-run] [--yes]`, in the order step 8 sets: resolve and preview; record `pending: uninstall`
 * with the frozen list; edit the Libraries; then hand the PATH entry and the program files to the finisher, a copy of
 * this program in %TEMP% running `finish-uninstall` (finisher.ts, S83), which waits for this process to exit. Ownership passes to the finisher, live,
 * before this process exits (round 4, #1).
 */
export async function uninstallVerb(argv: string[]): Promise<LifecycleResult> {
  const parsed = parseArguments(argv, argumentTable('uninstall'));
  const json = parsed.flags.has('json');
  const interactive = isInteractive(parsed.flags.has('yes'), json);
  try {
    const root = installRootHere();
    const removal = programRemoval(root);
    let { edits, skipped } = libraryEdits(root);
    const preview = uninstallPreview(root, removal, edits, skipped);
    if (parsed.flags.has('dry-run')) {
      return { refusal: null, exitCode: 0, value: { operation: 'Uninstall Deskpost (dry run)', root, removal: removal as unknown as PsJsonValue, library_edits: edits.map((edit) => ({ file: edit.file, removed: edit.removed })), skipped }, humanText: preview + '\n\nDry run: nothing was changed.', asJson: json };
    }
    // THE FINISHER IS A COPY OF THIS PROGRAM (S83, D8), so a kernel run from source has none to hand over to. Refused
    // before anything is changed; a checkout never reaches here, since it is not an installed release.
    if (!isCompiled()) throw new Error(`${COMMAND_NAME} uninstall runs from the installed program, whose own copy finishes it; this kernel is run from source. Run the installed \`${COMMAND_NAME}\`. Nothing was changed.`);
    await requireSessionsClosed(root, `${COMMAND_NAME} uninstall`, interactive);
    if (interactive) {
      process.stdout.write(preview + '\n');
      if ((await prompt('\n[Enter] uninstall   [q] quit › ')).toLowerCase() === 'q') return { refusal: null, exitCode: 3, value: null, humanText: 'Nothing was changed.', asJson: json };
    } else if (!parsed.flags.has('yes')) {
      return { refusal: `${COMMAND_NAME} uninstall needs a yes: pass --yes to uninstall without a prompt, or --dry-run to see what it removes. Nothing was changed.`, exitCode: 1, value: null, asJson: json };
    }
    // RECOMPUTED AFTER THE WAIT AND THE PROMPT, and each written only while it still holds what it was computed from.
    ({ edits, skipped } = libraryEdits(root));
    const id = claimPending(root, 'uninstall', { phase: 'recorded', removal, library_edits_begun: false });
    const stale = edits.filter((edit) => !fs.existsSync(edit.file) || sha256File(edit.file) !== edit.old_sha256);
    if (stale.length) {
      clearPending(root, id);
      throw new Error(`these Library files changed while uninstall was being prepared, so nothing was changed: ${stale.map((edit) => edit.file).join(', ')}. Run ${COMMAND_NAME} uninstall again.`);
    }
    // FROM HERE THERE IS NO UNDO (round 4, #4): reversing deletions would need a second backup system.
    updatePending(root, id, { library_edits_begun: true });
    for (const edit of edits) writeAtomicText(edit.file, edit.content ?? '');
    updatePending(root, id, { phase: 'libraries-edited' });
    const handed = handToFinisher(root, id);
    return {
      refusal: null,
      exitCode: handed.started ? 0 : 1,
      value: { operation: 'Uninstall Deskpost', root, transaction: id, library_edits: edits.length, finisher: handed.started, result: handed.result },
      humanText: handed.started
        ? `Your Libraries no longer name this install. Finishing in the background; result: ${handed.result}`
        : `Your Libraries no longer name this install, but the finisher did not start, so the program files were not removed. Re-run the installer with -Resume finish -InstallRoot "${root}" to complete it.`,
      asJson: json,
    };
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1, value: null, asJson: json };
  }
}

/**
 * THE TWO-WAY HANDSHAKE (round 4, #1). The finisher writes `started <pid>` and waits; this process, on seeing it within
 * 10 s, rewrites the pending owner to the finisher's pid and start time, then writes `go`. With no `started` in time it
 * writes `cancel` and keeps ownership until it exits; a late finisher that finds `cancel`, or no `go` in 30 s, deletes nothing.
 */
function handToFinisher(root: string, id: string): { started: boolean; result: string } {
  const tag = randomUUID().replace(/-/g, '');
  const copy = path.join(os.tmpdir(), `deskpost-finish-${tag}.exe`);
  const handshake = path.join(os.tmpdir(), `deskpost-finish-${tag}.handshake`);
  const result = path.join(os.tmpdir(), 'deskpost-uninstall-result.json');
  // FAULT INJECTION FOR THE PROOF FIXTURE (step 7): no finisher starts, so the handshake times out and writes `cancel`,
  // as a machine that refuses the start would leave it. tools/Test-InstallProof.ps1 and self-test section 116 set it.
  if (process.env['DESKPOST_UNINSTALL_FAULT'] !== 'no-finisher') {
    // A COPY OF THIS PROGRAM, STARTED OUTSIDE THIS PROCESS'S JOB (S83, D8 from S82's spike): `library finish-uninstall`
    // run from %TEMP%, so it outlives this process and never deletes itself mid-run. CreateProcessW with breakaway, then
    // without it; never the runtime's attached spawn, which Bun's kill-on-close job ends with this process. Its arguments
    // are quoted by the CommandLineToArgvW rules. A start that fails lands on the `cancel` below, and the remedy.
    try {
      fs.copyFileSync(process.execPath, copy);
      const commandLine = [copy, 'finish-uninstall', '--parent-pid', String(process.pid), '--root', root, '--handshake', handshake, '--transaction', id, '--result', result]
        .map(argvQuote)
        .join(' ');
      nativeStartDetached(copy, commandLine, os.tmpdir());
    } catch {
      fs.rmSync(copy, { force: true });
    }
  }
  const deadline = Date.now() + 10000;
  let started: number | null = null;
  while (Date.now() < deadline) {
    const text = fs.existsSync(handshake) ? fs.readFileSync(handshake, 'utf8') : '';
    const match = /^started (\d+)/m.exec(text);
    if (match) {
      started = Number(match[1]);
      break;
    }
    sleep(100);
  }
  if (started === null) {
    fs.appendFileSync(handshake, 'cancel\n');
    return { started: false, result };
  }
  const start = agentProcessIdentity(started, { fresh: true });
  updatePending(root, id, { owner: { pid: started, start_utc: start }, phase: 'handed-to-finisher' });
  fs.appendFileSync(handshake, 'go\n');
  return { started: true, result };
}

/** One argument as CommandLineToArgvW reads it back: quoted when it holds a space or a quote, backslashes before a quote doubled. */
export function argvQuote(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

// --- rollback --------------------------------------------------------------------------------------------------------

function linkTarget(link: string): string | null {
  try {
    return fs.realpathSync.native(link);
  } catch {
    return null;
  }
}

/** `current` onto `target` in step 2's four substeps, each judged by which names exist. */
export function switchCurrent(root: string, target: string, tag: string): void {
  const current = path.join(root, 'current');
  const fresh = `${current}.new-${tag}`;
  const old = `${current}.old-${tag}`;
  const want = fs.realpathSync.native(target).toLowerCase();
  if ((linkTarget(current) ?? '').toLowerCase() === want) return;
  if (!fs.existsSync(fresh)) fs.symlinkSync(target, fresh, 'junction');
  if (isLink(current)) fs.renameSync(current, old);
  fs.renameSync(fresh, current);
  if (isLink(old)) fs.unlinkSync(old);
}

/**
 * `deskpost rollback`: `current` back to the version before it, as `install.ps1 -Rollback` does, under the lifecycle
 * rule and the close-your-sessions rule, and keeping ADR-0054's preflight: a shared Book open on any Desk blocks a
 * switch to a version whose reader would refuse that Desk whole. Safe because every version's hooks name library.exe.
 */
export async function rollbackVerb(argv: string[]): Promise<LifecycleResult> {
  const parsed = parseArguments(argv, argumentTable('rollback'));
  const json = parsed.flags.has('json');
  const interactive = isInteractive(parsed.flags.has('yes'), json);
  try {
    const root = installRootHere();
    const recordFile = path.join(root, 'current.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    const previous = typeof record['previous'] === 'string' && record['previous'] ? record['previous'] : null;
    if (previous === null) throw new Error(`nothing to roll back to: ${recordFile} names no previous version.`);
    const target = path.join(root, 'versions', previous);
    if (!fs.existsSync(path.join(target, 'bin', 'library.exe'))) throw new Error(`the previous version ${previous} is no longer under ${path.join(root, 'versions')}.`);
    const check = await basicMemoryRollbackCheck(['--json'], '');
    const blocking = (check['blocking'] as unknown as { close: string[] }[]) ?? [];
    if (blocking.length) {
      throw new Error(`Not rolled back: ${blocking.length} seat(s) hold a shared Book on their Desk, and ${previous}'s reader would refuse those Desks whole. Close them first:\n` + blocking.flatMap((row) => row.close.map((line) => `  ${line}`)).join('\n'));
    }
    await requireSessionsClosed(root, `${COMMAND_NAME} rollback`, interactive);
    if (!interactive && !parsed.flags.has('yes')) throw new Error(`${COMMAND_NAME} rollback needs a yes: pass --yes to switch back to ${previous} without a prompt. Nothing was changed.`);
    if (interactive && (await prompt(`Switch back from ${String(record['version'])} to ${previous}? [Enter] roll back   [q] quit › `)).toLowerCase() === 'q') {
      return { refusal: null, exitCode: 3, value: null, humanText: 'Nothing was changed.', asJson: json };
    }
    const id = claimPending(root, 'rollback', { version: previous, from: record['version'], previous_record: JSON.stringify(record) });
    // ANY FAILURE FROM HERE PUTS current BACK AND CLEARS THE PENDING (post-build inspection #1): a rollback left
    // pending was recovered by install.ps1 as an install, whose undo removed current and the shims.
    try {
      return rollbackSwitch(root, id, record, previous, target, recordFile, json);
    } catch (error) {
      try {
        switchCurrent(root, path.join(root, 'versions', String(record['version'])), `${id}r`);
        writeAtomicText(recordFile, JSON.stringify(record, null, 4) + '\n');
      } finally {
        clearPending(root, id);
      }
      throw error;
    }
  } catch (error) {
    return { refusal: (error as Error).message, exitCode: 1, value: null, asJson: json };
  }
}

function rollbackSwitch(root: string, id: string, record: Record<string, unknown>, previous: string, target: string, recordFile: string, json: boolean): LifecycleResult {
  {
    switchCurrent(root, target, id);
    const archive = path.join(target, '.archive-sha256');
    const next = { schema: 1, version: previous, previous: record['version'], archive_sha256: fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trim() : null, switched: new Date().toISOString() };
    writeAtomicText(recordFile, JSON.stringify(next, null, 4) + '\n');
    const ran = spawnSync(path.join(root, 'current', 'bin', 'library.exe'), ['--version'], { encoding: 'utf8' });
    let reported: Record<string, unknown> = {};
    try {
      reported = JSON.parse(ran.stdout) as Record<string, unknown>;
    } catch {
      reported = {};
    }
    if (ran.status !== 0 || String(reported['plugin_version']) !== previous) {
      throw new Error(`${previous} did not answer through current after the switch (exit ${ran.status}), so current points at ${String(record['version'])} again.`);
    }
    clearPending(root, id);
    dropShimsNewerThan(root, previous);
    const libraries = rollbackLibraryLines(root, previous);
    return {
      refusal: null,
      exitCode: 0,
      value: { status: 'rolled-back', version: previous, from: record['version'] as PsJsonValue, install_root: root, libraries: libraries.libraries as unknown as PsJsonValue, unreached: libraries.unreached },
      humanText: `Rolled back to ${previous} (from ${String(record['version'])}). The plugin, if you installed one, is not rolled back by this switch.` + (libraries.text ? `\n${libraries.text}` : ''),
      asJson: json,
    };
  }
}

/**
 * WHAT A PROGRAM-ONLY ROLLBACK LEAVES EACH LIBRARY THE INSTALL SERVES (ADR-0063 decision 9; PLAN-one-upgrade.md r8, the
 * reader's ruling, and r9 amendment 4). Rollback never writes in a Library: each keeps the newer program's registrations,
 * whose guards the older program still runs, and a hook verb it does not know is a non-blocking error. So each is named
 * with its two lines: `deskpost init <folder>`, run with the older program, returns its managed files and hooks to that
 * program's form; and `deskpost seat enter <seat>`, because a conversation already open there is not bound to its seat
 * again until one of them runs. It only reads, and a Library it cannot reach is named rather than dropped.
 */
export function rollbackLibraryLines(root: string, previous: string, registryRoot?: string): {
  libraries: { workspace: string; init: string; seats: string[]; seat_enter: string[] }[];
  unreached: string[];
  text: string;
} {
  let found: { served: string[]; unreached: string[] };
  try {
    found = librariesServedByRoot(root, registryRoot);
  } catch (error) {
    return { libraries: [], unreached: [], text: `The Libraries this install serves could not be listed (${(error as Error).message}); none was changed. In each, run ${COMMAND_NAME} init <folder>, and ${COMMAND_NAME} seat enter <seat> in a conversation already open there.` };
  }
  const libraries = found.served.map((workspace) => {
    let seats: string[] = [];
    try {
      seats = readSeatRegistry(path.join(workspace, '.claude')).map((row) => row.seat);
    } catch {
      seats = [];
    }
    return {
      workspace,
      init: `${COMMAND_NAME} init ${workspace}`,
      seats,
      seat_enter: seats.length ? seats.map((seat) => `${COMMAND_NAME} seat enter ${seat}`) : [`${COMMAND_NAME} seat enter <seat>`],
    };
  });
  if (!libraries.length && !found.unreached.length) return { libraries, unreached: [], text: '' };
  const lines = [
    `Your Libraries were not changed: a rollback switches the program only. Each keeps the newer registrations, whose guards ${previous} still runs; a hook it does not know shows an error and blocks nothing.`,
  ];
  for (const library of libraries) {
    lines.push(`  ${library.workspace}`);
    lines.push(`    ${library.init}   returns its managed files and hooks to ${previous}'s form`);
    lines.push(`    ${library.seat_enter.join(', ')}   in a conversation already open there, which is not bound to its seat until then`);
  }
  for (const folder of found.unreached) lines.push(`  Could not reach the registered Library ${folder}; if this install serves it, run the same two lines there.`);
  return { libraries, unreached: found.unreached, text: lines.join('\n') };
}

/**
 * `setup --sessions --install-root <root> [--library <folder>]`: what would have to close first, for the installer's
 * upgrade and repair. `--library` also counts that Library's live seats whatever program its guards name, because a
 * plan that rewrites its registrations changes what those sessions run (S58 post-build inspection #2).
 */
export function sessionsVerb(root: string, library?: string): Record<string, PsJsonValue> {
  const found = liveSessions(root, { library });
  return { operation: 'Live sessions', root, clear: !found.seats.length && !found.processes.length, seats: found.seats as unknown as PsJsonValue, processes: found.processes as unknown as PsJsonValue, unreadable: found.unreadable, text: sessionsText(found) };
}
