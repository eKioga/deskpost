/**
 * Which process is at a pid: its START TIME, and the agent client above this one.
 *
 * The PowerShell originals are `Get-AgentProcessIdentity`, `Test-SeatAgentAlive`,
 * `Get-ProcessAncestryRecord` and `Resolve-AgentClientProcess` in `tools/BookRootSchema.ps1`. S14's
 * second half, and the reason it was a question rather than a port: NODE EXPOSES NO PROCESS START
 * TIME, and a seat binding is verified by pid AND start time so that a REUSED pid is a different
 * process rather than an heir to the seat.
 *
 * THE READER CHOSE SPAWN-OR-PROCFS OVER A NATIVE CALL (2026-09-22), and the reason is the matrix:
 * `bun:ffi` would survive `bun build --compile`, but `node kernel/src/cli.ts` -- the invocation every
 * row runs -- cannot execute it, so the fast path would be the one path nothing measures. One code
 * path under Node and under the compiled binary instead, one spelling per platform:
 *
 *   Windows  spawn `powershell.exe` with THE ORACLE'S OWN EXPRESSION, `StartTime.ToUniversalTime()
 *            .ToString('o')`. The binding is compared with exact string equality, so a Windows
 *            spelling has to reproduce the FILETIME to 100 ns; running the same expression is the
 *            only spelling that is identical by construction rather than by care. Measured
 *            191-209 ms per read on the development machine, which is why a gone pid is answered
 *            by `process.kill(pid, 0)` first and costs no spawn at all.
 *   Linux    `/proc/<pid>/stat` field 22 (clock ticks since boot) plus `btime` from `/proc/stat`.
 *            A file read; 10 ms precision at the usual 100 Hz.
 *   macOS    `/bin/ps -o lstart=`, one second of precision. There is no PowerShell writer on a Mac
 *            to disagree with, so the only binding it is ever compared with is one it wrote itself.
 *
 * THE WRITER AND THE COMPARER CALL `agentProcessIdentity`, deliberately, for the oracle's reason:
 * two formattings of one instant that differ in precision read as two processes.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The sentinel for a process that exists and whose start time cannot be read. Alive, never gone. */
export const UNREADABLE_IDENTITY = 'unreadable';

/** The agent clients a seat binds to. Compared case-insensitively, and without `.exe` off Windows. */
export const AGENT_CLIENT_PROCESS_NAMES = ['claude.exe', 'codex.exe'];

/** How far up the ancestry walk goes; the oracle's `$script:AgentAncestryMaxDepth`. */
export const AGENT_ANCESTRY_MAX_DEPTH = 12;

// ONE READ PER PID PER PROCESS, unless the caller asks for a fresh one. A `seat enter` reads the
// same agent three or four times in a second, and at ~200 ms a read on Windows that is most of the
// verb. The claim HOLDER is the one caller that must never see a remembered answer -- it polls to
// learn when the agent has gone -- and passes `fresh`.
const identityCache = new Map<number, string | null>();

/**
 * One process's identity: its start time in UTC, round-trip format. `null` when the process is gone;
 * `'unreadable'` when it exists and its start time cannot be read -- "I cannot tell" must not read
 * as "it is gone", because freeing a seat whose agent may still be running is the destructive
 * direction.
 */
export function agentProcessIdentity(pid: number, options: { fresh?: boolean } = {}): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!options.fresh && identityCache.has(pid)) return identityCache.get(pid)!;
  const identity = readIdentity(pid);
  identityCache.set(pid, identity);
  return identity;
}

/** Is the process a binding names still the same process? Pid AND start time, never pid alone. */
export function testSeatAgentAlive(pid: number, startUtc: string, options: { fresh?: boolean } = {}): boolean {
  const identity = agentProcessIdentity(pid, options);
  if (identity === null) return false;
  // A process that can be seen and not inspected, or a binding written before start times were
  // recorded, counts as alive -- the oracle's sentinel rule.
  if (identity === UNREADABLE_IDENTITY || !startUtc.trim()) return true;
  return identity === startUtc;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process that exists and belongs to somebody else. It is not gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readIdentity(pid: number): string | null {
  if (!processExists(pid)) return null;
  try {
    if (process.platform === 'win32') return readWindowsIdentity(pid);
    // A ZOMBIE IS NOT RUNNING (S43). An exited process its parent has not yet reaped keeps its pid, its
    // /proc entry and its start time, so it answered as alive: measured in the clean distro, an agent killed
    // while its parent was busy held its seat until the parent turned, and the seat could not be retaken.
    if (process.platform === 'linux' && linuxProcessState(pid) === 'Z') return null;
    if (process.platform === 'linux') return readLinuxStart(pid);
    if (process.platform === 'darwin') return readDarwinStart(pid);
  } catch {
    return processExists(pid) ? UNREADABLE_IDENTITY : null;
  }
  return UNREADABLE_IDENTITY;
}

function runPowerShell(script: string): string {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function readWindowsIdentity(pid: number): string | null {
  // THE ORACLE'S EXPRESSION, VERBATIM, and its two exits: a process Get-Process cannot find is gone,
  // and one whose StartTime throws (another user's elevated process) is the unreadable sentinel.
  const answer = runPowerShell(
    `$p = $null; try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch { 'gone'; exit 0 }; ` +
      `try { $p.StartTime.ToUniversalTime().ToString('o') } catch { '${UNREADABLE_IDENTITY}' }`,
  ).trim();
  if (answer === 'gone') return null;
  return answer || UNREADABLE_IDENTITY;
}

let linuxClockTicks: number | null = null;
let linuxBootSeconds: number | null = null;

/** The state letter of /proc/<pid>/stat (the field after the parenthesised name). */
function linuxProcessState(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '';
}

function readLinuxStart(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // THE NAME IS IN PARENTHESES AND MAY CONTAIN BOTH SPACES AND PARENTHESES, so fields are counted
  // from the LAST ')' rather than split from the front.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTicks = BigInt(fields[19]!);
  if (linuxClockTicks === null) {
    try {
      linuxClockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
    } catch {
      linuxClockTicks = 100;
    }
  }
  if (linuxBootSeconds === null) {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n').find((row) => row.startsWith('btime '));
    if (!line) throw new Error('/proc/stat carries no btime');
    linuxBootSeconds = Number(line.split(/\s+/)[1]);
  }
  const hundredNanoseconds = BigInt(linuxBootSeconds) * 10_000_000n + (startTicks * 10_000_000n) / BigInt(linuxClockTicks);
  return roundTripFromHundredNanoseconds(hundredNanoseconds);
}

function readDarwinStart(pid: number): string {
  const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim();
  const parsed = Date.parse(`${text} UTC`);
  if (Number.isNaN(parsed)) throw new Error(`ps reported an unparseable start time '${text}'`);
  return roundTripFromHundredNanoseconds(BigInt(parsed) * 10_000n);
}

/** `yyyy-MM-ddTHH:mm:ss.fffffffZ` -- .NET's round-trip `o` for a UTC instant, seven fractional digits. */
export function roundTripFromHundredNanoseconds(value: bigint): string {
  const milliseconds = Number(value / 10_000n);
  const fraction = (value % 10_000_000n).toString().padStart(7, '0');
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}

// --- WHICH AGENT THIS PROCESS BELONGS TO ------------------------------------------------------------

export interface AncestryRecord {
  pid: number;
  parentPid: number;
  name: string;
  createdUtc: string | null;
}

/** Is this image name an agent client? Case-insensitively, the oracle's one deliberate exception. */
export function isAgentClientProcessName(name: string): boolean {
  const lowered = name.toLowerCase();
  return AGENT_CLIENT_PROCESS_NAMES.some(
    (client) => lowered === client || (process.platform !== 'win32' && lowered === client.replace(/\.exe$/, '')),
  );
}

/**
 * The records from `pid` upwards, AT MOST `depth + 1` of them, read in one go. On Windows that is one
 * spawn for the whole chain rather than one per step: the walk's stop rules are applied in
 * `resolveAgentClientProcess`, so this only has to be faithful about what each process IS.
 */
export function readProcessAncestry(pid: number, depth = AGENT_ANCESTRY_MAX_DEPTH): AncestryRecord[] {
  if (pid <= 0) return [];
  try {
    if (process.platform === 'win32') {
      // Win32_Process, as Get-ProcessAncestryRecord reads it: .NET exposes no parent at all.
      const text = runPowerShell(
        `$id = ${pid}; $rows = @(); for ($i = 0; $i -le ${depth}; $i++) { ` +
          `$r = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue); ` +
          `if ($r.Count -lt 1 -or $null -eq $r[0]) { break }; $r = $r[0]; ` +
          `$c = $null; try { if ($null -ne $r.CreationDate) { $c = ([DateTime]$r.CreationDate).ToUniversalTime().ToString('o') } } catch { $c = $null }; ` +
          `$rows += [pscustomobject]@{ pid = [int]$r.ProcessId; parent_pid = [int]$r.ParentProcessId; name = [string]$r.Name; created_utc = $c }; ` +
          `if ([int]$r.ParentProcessId -le 0 -or [int]$r.ParentProcessId -eq [int]$r.ProcessId) { break }; $id = [int]$r.ParentProcessId }; ` +
          `ConvertTo-Json -InputObject @($rows) -Compress`,
      ).trim();
      if (!text) return [];
      const parsed = JSON.parse(text) as { pid: number; parent_pid: number; name: string; created_utc: string | null }[];
      return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
        pid: row.pid,
        parentPid: row.parent_pid,
        name: row.name,
        createdUtc: row.created_utc,
      }));
    }
    const records: AncestryRecord[] = [];
    let current = pid;
    for (let index = 0; index <= depth && current > 0; index += 1) {
      const record = readPosixRecord(current);
      if (!record) break;
      records.push(record);
      if (record.parentPid <= 0 || record.parentPid === record.pid) break;
      current = record.parentPid;
    }
    return records;
  } catch {
    // A FAULT IS A STOPPED WALK, never a throw: the fail-closed direction is "no agent", which is the
    // seatless refusal that already exists.
    return [];
  }
}

function readPosixRecord(pid: number): AncestryRecord | null {
  if (!processExists(pid)) return null;
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parentPid: Number(fields[1]), name, createdUtc: readLinuxStart(pid) };
  }
  const text = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const match = /^(\d+)\s+(.*)$/.exec(text);
  if (!match) return null;
  const command = match[2]!;
  return { pid, parentPid: Number(match[1]), name: command.slice(command.lastIndexOf('/') + 1), createdUtc: readDarwinStart(pid) };
}

export interface AgentClientAnswer {
  agentPid: number;
  agentName: string;
  depth: number;
  stopped: string;
  chain: string[];
}

/**
 * THE NEAREST AGENT CLIENT ABOVE A PROCESS. Nearest wins, which answers codex-under-claude with no
 * special case; a parent that STARTED AFTER its child is a reused pid and stops the walk, because
 * attaching to whatever now holds that number could serve a different agent's seat.
 */
export function resolveAgentClientProcess(
  pid: number = process.pid,
  records: AncestryRecord[] = readProcessAncestry(pid),
): AgentClientAnswer {
  const chain: string[] = [];
  const answer = (agentPid: number, agentName: string, depth: number, stopped: string): AgentClientAnswer => ({
    agentPid,
    agentName,
    depth,
    stopped,
    chain: [...chain],
  });
  let current = records[0];
  if (!current || current.pid !== pid) return answer(0, '', -1, 'start-gone');
  chain.push(current.name);
  if (isAgentClientProcessName(current.name)) return answer(current.pid, current.name, 0, 'found');
  for (let depth = 1; depth <= AGENT_ANCESTRY_MAX_DEPTH; depth += 1) {
    const parentId = current.parentPid;
    if (parentId <= 0) return answer(0, '', depth, 'no-parent');
    if (parentId === current.pid) return answer(0, '', depth, 'self-parent');
    const parent = records[depth];
    if (!parent || parent.pid !== parentId) return answer(0, '', depth, 'parent-gone');
    if (parent.createdUtc && current.createdUtc && Date.parse(parent.createdUtc) > Date.parse(current.createdUtc)) {
      return answer(0, '', depth, 'parent-reused');
    }
    chain.push(parent.name);
    if (isAgentClientProcessName(parent.name)) return answer(parent.pid, parent.name, depth, 'found');
    current = parent;
  }
  return answer(0, '', AGENT_ANCESTRY_MAX_DEPTH, 'depth');
}

let currentAgentCache: { pid: number; route: string } | null = null;

/**
 * THIS process's agent, and which route answered: `environment-pid`, `parent-chain` or `none`.
 * `CLAUDE_PID` first -- it names the agent rather than inferring it, and costs one environment read
 * -- then the walk, which is remembered for the life of this process because a process's parent is
 * fixed at creation.
 */
export function resolveCurrentAgentProcess(): { pid: number; route: string } {
  const raw = (process.env['CLAUDE_PID'] ?? '').trim();
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { pid: Number(raw), route: 'environment-pid' };
  if (currentAgentCache) return currentAgentCache;
  const walked = resolveAgentClientProcess();
  currentAgentCache = walked.agentPid > 0 ? { pid: walked.agentPid, route: 'parent-chain' } : { pid: 0, route: 'none' };
  return currentAgentCache;
}

export function currentAgentProcessId(): number {
  return resolveCurrentAgentProcess().pid;
}
