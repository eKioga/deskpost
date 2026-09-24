/**
 * The seat claim: whether a live session holds a seat, and whether THIS one may change it.
 *
 * The PowerShell original is the claim half of `tools/LibrarySeat.ps1`. Three things carry the
 * design, and the third is the one this port had to find a new way to express:
 *
 *   THE CLAIM IS AN OPEN FILE HANDLE, NOT A WRITTEN RECORD. The holder keeps `.claim` open with
 *   `FileAccess::Write, FileShare::Read` for the life of the session, so the claim ends exactly when
 *   the process does -- INCLUDING WHEN IT IS KILLED, which is the property a written-down "who is
 *   active" record can never have. It needs no staleness timeout and cannot be faked by writing the
 *   file.
 *
 *   THE PROBE NEVER WAITS. Callers reach it while holding the registry lock, so a retry or a sleep
 *   here would hold that lock for somebody else's timeout.
 *
 *   NODE HAS NO SHARE MODE, SO THE PROBE ASKS FOR WRITE INSTEAD. PowerShell probes by opening for
 *   READ with `FileShare::Read`: that fails while the holder's Write handle is open, because the
 *   probe's share mode does not permit Write. Node's `fs.openSync(path, 'r')` uses
 *   READ|WRITE|DELETE sharing, which the holder permits -- so it SUCCEEDS against a held claim and
 *   would report every occupied seat free. Opening `r+` asks for Write access, which the holder's
 *   `FileShare::Read` does not permit, and fails with EBUSY exactly when somebody holds the seat.
 *   Measured 2026-09-22 against a claim held by PowerShell: `r` opened, `r+` threw EBUSY held and
 *   opened once released. `r+` does not truncate and writes nothing.
 *
 *   AND A CLAIM THE KERNEL HOLDS IS TWO FILES (S14, the reader's ruling of 2026-09-22). Node can open
 *   with every share mode or with none -- libuv's `UV_FS_O_EXLOCK` (0x10000000) is honoured on
 *   Windows and means share-nothing, measured -- and PowerShell's `FileShare::Read` is neither. So a
 *   kernel holder writes `.claim` share-everything, which PowerShell's probe still reads as HELD and
 *   its acquire still refuses (it asks for Write against a handle that has it), and ALSO holds
 *   `.claim.lock` share-nothing. The lock is what makes the kernel's own acquisition exclusive -- two
 *   share-everything writers would both have succeeded -- and what the kernel's probe reads for a
 *   kernel holder, with an ordinary open that collides with nothing but a holder. Probing `.claim`
 *   share-nothing instead would have read every concurrent reader as a live session, which is the
 *   defect PowerShell's probe was corrected for on 2026-09-15.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { utcRoundTrip } from './journal.ts';
import { assertNoCollectionExport } from './locks.ts';
import { deskStateDirectory } from './seatdesk.ts';
import { agentProcessIdentity, currentAgentProcessId, testSeatAgentAlive } from './procstart.ts';

export type ClaimState = 'free' | 'held' | 'orphaned';
export type SeatOperation = 'enter' | 'mutate' | 'retire' | 'sweep';
export type SeatDecision = 'allow' | 'refuse' | 'no-op' | 'restore' | 'skip';

export function seatClaimPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), '.claim');
}

/** The kernel holder's share-nothing half of a claim. See the header. */
export function seatClaimLockPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), '.claim.lock');
}

export function seatBindingPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'binding.json');
}

export function seatActivityPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'activity.json');
}

/**
 * Is a live session holding this seat? Probes WITHOUT WAITING, ever.
 *
 * TWO QUESTIONS, ONE PER KIND OF HOLDER. `.claim` opened `r+` fails exactly when a PowerShell holder
 * has it (Write, `FileShare::Read`); `.claim.lock` opened for an ordinary read fails exactly when a
 * kernel holder has it share-nothing. A kernel holder's `.claim` is share-everything, so the first
 * question alone would report it free -- measured, which is why the second exists.
 */
export function testSeatClaim(stateDirectory: string, seat: string): boolean {
  // On POSIX the claim is the lock file's flock, and an open says nothing (S42; see openShareNothing).
  const posix = posixLockHeld(seatClaimLockPath(stateDirectory, seat));
  if (posix !== null) return posix;
  const claimPath = seatClaimPath(stateDirectory, seat);
  if (fs.existsSync(claimPath) && !opens(claimPath, 'r+')) return true;
  const lockPath = seatClaimLockPath(stateDirectory, seat);
  if (fs.existsSync(lockPath) && !opens(lockPath, 'r')) return true;
  return false;
}

function opens(file: string, flags: string | number): boolean {
  let handle: number;
  try {
    handle = fs.openSync(file, flags);
  } catch (error) {
    // A file removed between the existence test and the open is a claim that has just been
    // released, not one that is held.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  fs.closeSync(handle);
  return true;
}

/**
 * libuv's share-nothing open, which is a Windows meaning only. Elsewhere Node passes open flags to
 * open(2) as they are, where this bit is not libuv's to define -- so it is not sent there at all.
 */
const UV_FS_O_EXLOCK = process.platform === 'win32' ? 0x10000000 : 0;

/** A handle held share-nothing, however it was opened. */
export interface ExclusiveHandle {
  close(): void;
}

type Kernel32 = {
  symbols: {
    CreateFileW(name: unknown, access: number, share: number, security: null, disposition: number, flags: number, template: null): number;
    CloseHandle(handle: number): number;
    GetLastError(): number;
  };
};
let kernel32: Kernel32 | null = null;

/**
 * THE SAME OPEN UNDER BUN, WHICH IS NOT libuv (S29). Measured 2026-09-22 with one probe run three
 * ways: under Node an `r` or `r+` open against a file held with `UV_FS_O_EXLOCK` fails EBUSY; under
 * `bun` and under a `bun build --compile` binary both OPEN, because Bun ignores the bit. A compiled
 * kernel's claim was therefore not exclusive, and its own probe -- an ordinary open of `.claim.lock`
 * -- read every kernel-held seat as free: `seat.enter-an-existing-free-seat` mismatched on 21 fields
 * with the binary as the kernel, its holder never seen to take the handle it had taken.
 *
 * `CreateFileW` with a share mode of 0 is the one spelling of the same open Bun can make, through
 * `bun:ffi`, which `bun build --compile` carries. procstart.ts records why a native call was declined
 * for the start time -- `node src/cli.ts` could not run it, so nothing would measure it -- and that
 * reason no longer holds here: the matrix now runs against the installed binary (`-Kernel <exe>`),
 * and that run is what found this. Node keeps libuv's flag, so the source path is unchanged.
 */
function openShareNothingUnderBun(file: string): ExclusiveHandle {
  if (kernel32 === null) {
    const ffi = (import.meta as unknown as { require(name: string): any }).require('bun:ffi');
    const { FFIType } = ffi;
    kernel32 = ffi.dlopen('kernel32.dll', {
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i64_fast,
      },
      CloseHandle: { args: [FFIType.i64_fast], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }) as Kernel32;
  }
  const api = kernel32!.symbols;
  const GENERIC_READ_WRITE = 0xc0000000;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  const ERROR_SHARING_VIOLATION = 32;
  const name = Buffer.from(file + '\0', 'utf16le');
  const handle = Number(api.CreateFileW(name, GENERIC_READ_WRITE, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null));
  if (handle === -1 || handle === 0) {
    const code = api.GetLastError();
    const error = new Error(`CreateFileW ${file} failed with Windows error ${code}`) as NodeJS.ErrnoException;
    error.code = code === ERROR_SHARING_VIOLATION ? 'EBUSY' : `WIN32_${code}`;
    throw error;
  }
  let open = true;
  return {
    close() {
      if (open) {
        open = false;
        api.CloseHandle(handle);
      }
    },
  };
}

/**
 * ON macOS AND LINUX A SHARE-NOTHING OPEN DOES NOT EXIST, AND UNTIL S42 NOTHING STOOD IN FOR IT. Measured in
 * a clean Ubuntu 24.04 distro: the open below was a plain open(2), the probe in `testSeatClaim` asked only
 * whether the file opens -- which it always does -- and so every held seat read free and a second session
 * could take a held seat. There the claim is `flock(2)`, exclusive and non-blocking, on the same
 * `.claim.lock`: held exactly while the holder's descriptor is open, released when it closes or the process
 * dies, which is the property the Windows handle has. Through `bun:ffi`, which a compiled kernel carries,
 * as `CreateFileW` is above. CONCEDED: a kernel run from source under Node on POSIX has no FFI, so there
 * its claim does not exclude; no release runs that way. And musl's libc is not `libc.so.6`.
 */
type Libc = { symbols: { flock(fd: number, operation: number): number } };
let libc: Libc | null = null;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function posixFlock(): ((fd: number, operation: number) => number) | null {
  if (process.platform === 'win32' || typeof (globalThis as { Bun?: unknown }).Bun !== 'object') return null;
  if (libc === null) {
    const ffi = (import.meta as unknown as { require(name: string): any }).require('bun:ffi');
    libc = ffi.dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    }) as Libc;
  }
  return (fd, operation) => libc!.symbols.flock(fd, operation);
}

/** Whether a POSIX lock file is held by another descriptor: a non-blocking try, released at once. Null where there is no flock. */
function posixLockHeld(file: string): boolean | null {
  const flock = posixFlock();
  if (flock === null) return null;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return true;
    flock(fd, LOCK_UN);
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Open (creating) a file share-nothing, so that any other open of it fails EBUSY while this is held. */
export function openShareNothing(file: string): ExclusiveHandle {
  if (process.platform === 'win32' && typeof (globalThis as { Bun?: unknown }).Bun === 'object') {
    return openShareNothingUnderBun(file);
  }
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | UV_FS_O_EXLOCK);
  const flock = posixFlock();
  if (flock !== null && flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    fs.closeSync(fd);
    const error = new Error(`${file} is locked by another holder`) as NodeJS.ErrnoException;
    error.code = 'EBUSY';
    throw error;
  }
  return { close: () => fs.closeSync(fd) };
}

export interface HeldClaim {
  path: string;
  lockPath: string;
  claimHandle: number;
  lockHandle: ExclusiveHandle;
  seat: string;
  token: string;
  attemptId: string;
}

/**
 * Take a seat's claim, or fail. The kernel's `Enter-SeatClaim`, for the kernel's own holder.
 *
 * THE LOCK FIRST, SHARE-NOTHING, and a few short retries on it -- the only wait anywhere in the claim
 * code, and it is not waiting for a HOLDER: an ordinary probe holds `.claim.lock` open for
 * microseconds, and a share-nothing open colliding with one is a probe, never a session. A holder is
 * refused on the first try of `.claim` below, which never retries.
 */
export function enterSeatClaim(stateDirectory: string, seat: string, attemptId = ''): HeldClaim {
  const directory = deskStateDirectory(stateDirectory, seat);
  fs.mkdirSync(directory, { recursive: true });
  const claimPath = seatClaimPath(stateDirectory, seat);
  const lockPath = seatClaimLockPath(stateDirectory, seat);
  const refused = (): Error =>
    new Error(
      `Seat '${seat}' already has a live session. One session per seat: finish or close that one, ` +
        'or start work at another seat with tools/Start-LibrarySeat.ps1 -Seat <name>.',
    );

  let lockHandle: ExclusiveHandle | null = null;
  for (let attempt = 0; attempt < 10 && lockHandle === null; attempt += 1) {
    try {
      lockHandle = openShareNothing(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      const until = Date.now() + 5;
      while (Date.now() < until) {
        /* a probe's microseconds; see above */
      }
    }
  }
  if (lockHandle === null) throw refused();

  let claimHandle: number;
  try {
    // Create-or-truncate, as the oracle does: what excludes a second session is the live handle,
    // never the file's existence, which is why a claim survives a crash with no staleness timeout.
    claimHandle = fs.openSync(claimPath, 'w');
  } catch {
    lockHandle.close();
    throw refused();
  }
  const token = randomHex();
  const lines = [`token=${token}`, `pid=${process.pid}`, `claimed=${utcRoundTrip()}`];
  if (attemptId) lines.push(`attempt=${attemptId}`);
  // StreamWriter.WriteLine's line ending, which is the platform's.
  fs.writeSync(claimHandle, lines.join(os.EOL) + os.EOL);
  return { path: claimPath, lockPath, claimHandle, lockHandle, seat, token, attemptId };
}

/** Release a claim. NEVER THROWS: almost every call site is a finally. */
export function exitSeatClaim(claim: HeldClaim | null): void {
  if (!claim) return;
  for (const release of [
    () => fs.closeSync(claim.claimHandle),
    () => fs.unlinkSync(claim.path),
    () => claim.lockHandle.close(),
    () => fs.unlinkSync(claim.lockPath),
  ]) {
    try {
      release();
    } catch {
      /* never throws */
    }
  }
}

function randomHex(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * One `name=value` field out of a live claim file, or null. Every value here is 32 hex characters,
 * so the pattern is anchored rather than split on '='.
 */
export function seatClaimField(stateDirectory: string, seat: string, name: 'token' | 'attempt'): string | null {
  const claimPath = seatClaimPath(stateDirectory, seat);
  if (!fs.existsSync(claimPath)) return null;
  let text: string;
  try {
    // An ordinary shared read: the holder still has the file open for writing, which is the point of
    // the claim, and any narrower access would refuse the very read that verifies it.
    text = fs.readFileSync(claimPath, 'utf8');
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${name}=([0-9a-f]{32})$`, 'm');
  const match = pattern.exec(text.replace(/\r\n/g, '\n'));
  return match ? match[1]! : null;
}

export interface SeatClaimStatus {
  seat: string;
  state: ClaimState;
  bindingState: string;
  agentPid: number;
  agentStartUtc: string;
  boundUtc: string;
  sessionId: string;
  seatId: string;
  thisAgent: boolean;
  bindingStale: boolean;
}

export interface SeatBinding {
  state: string;
  agent_pid: number;
  agent_start_utc?: string;
  session_id?: string;
  seat_id?: string;
  bound_utc?: string;
}

/**
 * A seat's binding, or null. FAILS CLOSED on anything it cannot parse: absent is the DANGEROUS
 * reading, because it would make an occupied seat look free.
 *
 * A COMMITTED BINDING IS READ NOW, where until S14's second half it was refused by name: the kernel
 * reads a process start time (`procstart.ts`), so it can make the pid-AND-start-time comparison that
 * stops a reused pid inheriting a seat, and no longer has to decline to answer.
 */
export function readSeatBinding(stateDirectory: string, seat: string): SeatBinding | null {
  const file = seatBindingPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    throw new Error(`The seat binding at ${file} could not be read: ${(error as Error).message}`);
  }
  let parsed: SeatBinding;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, '')) as SeatBinding;
  } catch (error) {
    throw new Error(
      `The seat binding at ${file} is not valid JSON: ${(error as Error).message}. ` +
        'Remove it only if no agent process holds this seat.',
    );
  }
  for (const required of ['agent_pid', 'state']) {
    if (!(required in parsed)) throw new Error(`The seat binding at ${file} has no '${required}' field.`);
  }
  if (!SEAT_BINDING_STATES.includes(String(parsed.state))) {
    throw new Error(
      `The seat binding at ${file} has state '${String(parsed.state)}'; expected one of ${SEAT_BINDING_STATES.join(', ')}.`,
    );
  }
  const agentPid = String(parsed.agent_pid);
  if (!/^\s*[+-]?\d+\s*$/.test(agentPid) || Number(agentPid) <= 0) {
    throw new Error(`The seat binding at ${file} names a malformed agent_pid '${agentPid}'.`);
  }
  return parsed;
}

export const SEAT_BINDING_STATES = ['pending', 'committed'];

/**
 * `free`, `held` or `orphaned` for one seat, with the identity behind the answer.
 *
 * THE THIRD STATE IS THE POINT. A claim holder that died while its agent kept running used to read
 * as "not claimed" -- so the seat looked free, another agent could take it, and the live agent's
 * mutations started refusing with a message about somebody else's session.
 *
 * A `pending` binding leaves a seat FREE: it is provisional state belonging to an attempt that has
 * not committed, and treating it as occupancy would let a crashed attempt hold a seat for ever. A
 * COMMITTED binding whose agent is gone is STALE and reads free too; it is archived by the next
 * registry-locked operation, never by this read.
 *
 * `agentPid` is THIS process's agent, for "is that me?". Omitted, it is resolved -- but only when a
 * committed binding makes the answer matter, because resolving it off the environment can cost an
 * ancestry walk, and a seat with no binding has no agent to compare.
 */
export function getSeatClaimState(stateDirectory: string, seat: string, agentPid = -1): SeatClaimStatus {
  const binding = readSeatBinding(stateDirectory, seat);
  const committed = binding !== null && binding.state === 'committed';
  const bindingPid = binding ? Number(binding.agent_pid) : 0;
  const bindingStart = binding?.agent_start_utc ?? '';
  const agentAlive = committed && testSeatAgentAlive(bindingPid, bindingStart);
  const handleLive = testSeatClaim(stateDirectory, seat);
  let state: ClaimState = 'free';
  if (handleLive) state = 'held';
  else if (agentAlive) state = 'orphaned';
  // This process's agent is only looked up when the binding could name it.
  const self = committed && agentAlive ? (agentPid < 0 ? currentAgentProcessId() : agentPid) : 0;
  return {
    seat,
    state,
    bindingState: binding ? String(binding.state) : '',
    agentPid: bindingPid,
    agentStartUtc: bindingStart,
    boundUtc: binding?.bound_utc ?? '',
    sessionId: binding?.session_id ?? '',
    seatId: binding?.seat_id ?? '',
    // $agentAlive IS PART OF THE ANSWER: it compares the RECORDED start time against the process now
    // at that pid, so a reused pid reports false here instead of inheriting the binding.
    thisAgent: committed && agentAlive && self > 0 && bindingPid === self,
    bindingStale: committed && !agentAlive,
  };
}

/**
 * WHICH SEAT THIS AGENT PROCESS IS BOUND TO, or null. `Get-SeatBindingForAgent`. Reads only.
 *
 * A COMMITTED binding only, its agent verified by pid AND start time: a reused pid is a different
 * process and resolves to no seat, which is the direction that matters. The seat is the DIRECTORY
 * name, never the record's own field, which a hand edit could make disagree. Two seats for one agent
 * is corrupt state and throws rather than choosing.
 *
 * `agentPid` below zero means "resolve it" -- and it is resolved only once a committed binding
 * exists to compare it with, so a workspace with no bindings never pays for an ancestry walk.
 */
export function seatBindingForAgent(
  stateDirectory: string,
  seats: string[],
  agentPid = -1,
): { seat: string; binding: SeatBinding; agentPid: number } | null {
  const committed: { seat: string; binding: SeatBinding }[] = [];
  for (const seat of seats) {
    const binding = readSeatBinding(stateDirectory, seat);
    if (binding && binding.state === 'committed') committed.push({ seat, binding });
  }
  if (!committed.length) return null;
  const self = agentPid < 0 ? currentAgentProcessId() : agentPid;
  if (self <= 0) return null;
  const found = committed.filter(
    (row) => Number(row.binding.agent_pid) === self && testSeatAgentAlive(self, row.binding.agent_start_utc ?? ''),
  );
  if (found.length > 1) {
    throw new Error(
      `Agent process ${self} is bound to ${found.length} seats -- ${found.map((row) => row.seat).join(', ')} ` +
        '-- and one agent process holds exactly one seat. Remove the binding that does not belong, ' +
        'with tools/Retire-Seat.ps1 or by ending this conversation and starting a new one.',
    );
  }
  return found.length ? { seat: found[0]!.seat, binding: found[0]!.binding, agentPid: self } : null;
}

/** Re-exported so a caller that records an identity uses the same function the comparer does. */
export { agentProcessIdentity, testSeatAgentAlive };

/**
 * ONE TABLE GOVERNING WHAT EACH OPERATION DOES IN EACH CLAIM STATE, declared once so every consumer
 * reads it rather than re-deriving it.
 *
 * RETIREMENT AND MUTATION ARE DIFFERENT ROWS. A mutator acts FROM a seat and is authorised by that
 * seat's held claim; retirement acts ON a seat and is authorised by that seat being idle. One
 * combined row either refuses every legitimate reset or lets a foreign seat's mere freeness widen a
 * whole-tree reset past retirement.
 *
 * AND `skip` IS NOT `refuse`. A refused operation stops and changes nothing; a sweep names the seat
 * it skipped and carries on, because one busy seat must not cancel "clear every idle seat".
 */
const SEAT_STATE_MATRIX: { operation: SeatOperation; state: ClaimState; sameAgent: boolean | null; decision: SeatDecision }[] = [
  { operation: 'enter', state: 'free', sameAgent: null, decision: 'allow' },
  { operation: 'enter', state: 'held', sameAgent: true, decision: 'no-op' },
  { operation: 'enter', state: 'held', sameAgent: false, decision: 'refuse' },
  { operation: 'enter', state: 'orphaned', sameAgent: true, decision: 'restore' },
  { operation: 'enter', state: 'orphaned', sameAgent: false, decision: 'refuse' },
  { operation: 'mutate', state: 'free', sameAgent: null, decision: 'refuse' },
  { operation: 'mutate', state: 'held', sameAgent: true, decision: 'allow' },
  { operation: 'mutate', state: 'held', sameAgent: false, decision: 'refuse' },
  { operation: 'mutate', state: 'orphaned', sameAgent: true, decision: 'refuse' },
  { operation: 'mutate', state: 'orphaned', sameAgent: false, decision: 'refuse' },
  { operation: 'retire', state: 'free', sameAgent: null, decision: 'allow' },
  { operation: 'retire', state: 'held', sameAgent: null, decision: 'refuse' },
  { operation: 'retire', state: 'orphaned', sameAgent: null, decision: 'refuse' },
  { operation: 'sweep', state: 'free', sameAgent: null, decision: 'allow' },
  { operation: 'sweep', state: 'held', sameAgent: null, decision: 'skip' },
  { operation: 'sweep', state: 'orphaned', sameAgent: null, decision: 'skip' },
];

/** What the matrix says. Throws on a combination the table does not cover, rather than defaulting. */
export function getSeatStateDecision(operation: SeatOperation, state: ClaimState, sameAgent: boolean): SeatDecision {
  for (const row of SEAT_STATE_MATRIX) {
    if (row.operation !== operation) continue;
    if (row.state !== state) continue;
    if (row.sameAgent !== null && row.sameAgent !== sameAgent) continue;
    return row.decision;
  }
  throw new Error(
    `No seat-state rule covers operation '${operation}' in state '${state}' (same agent: ${sameAgent}). ` +
      'Add the row to the seat state matrix rather than defaulting.',
  );
}

/**
 * A mutator that writes a Desk requires a MATCHING LIVE CLAIM and fails closed without one.
 *
 * Without this the claim is bypassable and the whole liveness model is advisory: an agent launched
 * directly, inheriting or being handed a LIBRARY_SEAT, would carry no claim and could still change
 * its Desk -- and reset would then classify genuinely active work as dormant and quarantine it.
 *
 * THE MAINTENANCE BARRIER COMES FIRST, AND IT IS ITS OWN STOP REASON. A barrier cannot go up while
 * any claim is live, so under one the claim check would refuse with "no live session" -- true,
 * useless, and it sends the reader to a helper the barrier refuses too, for a reason the first
 * message never mentioned. One refusal per guard, each naming its own fix.
 *
 * EITHER PROOF IS ENOUGH. The token proves this session was handed the claim by the launcher; a
 * committed binding naming this process's agent, verified by pid and start time, proves the seat was
 * bound to it.
 */
export function assertSeatClaimHeld(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  token?: string | undefined;
  agentPid?: number;
}): void {
  const token = options.token && options.token.trim() ? options.token : (process.env['LIBRARY_SEAT_CLAIM'] ?? '');

  assertNoMaintenanceBarrier(options.workspace, `changing anything at seat '${options.seat}'`);
  assertNoCollectionExport(options.workspace, `changing anything at seat '${options.seat}'`);

  const claim = getSeatClaimState(options.stateDirectory, options.seat, options.agentPid ?? -1);
  const held = seatClaimField(options.stateDirectory, options.seat, 'token');
  const sameAgent = claim.thisAgent || (held !== null && held !== '' && token === held);
  if (getSeatStateDecision('mutate', claim.state, sameAgent) === 'allow') return;

  // ONE REFUSAL PER STATE, EACH NAMING ITS OWN FIX. A reader told the wrong one takes the wrong
  // action: "start a session" is useless to somebody whose agent is running and whose holder died.
  if (claim.state === 'orphaned') {
    throw new Error(
      `Seat '${options.seat}' is bound to agent process ${claim.agentPid}, which is still running, but its claim ` +
        'holder is gone -- so nothing may be changed at it until the seat is re-bound. Re-bind it from that ' +
        'conversation; the material is untouched and the binding is intact.',
    );
  }
  if (claim.state === 'free') {
    throw new Error(
      `Seat '${options.seat}' has no live session, so nothing may be changed at it. Start work with ` +
        `tools/Start-LibrarySeat.ps1 -Seat ${options.seat}, which holds the seat for the life of the session. ` +
        'Reading is unaffected.',
    );
  }
  throw new Error(
    `This session does not hold seat '${options.seat}' -- neither LIBRARY_SEAT_CLAIM nor this agent process matches the ` +
      'live claim. Another session is working that seat. Start your own with tools/Start-LibrarySeat.ps1 -Seat <name>.',
  );
}

/**
 * The maintenance barrier: a cutover stops the whole tree, and this is the one door the claim-gated
 * set already goes through, so it is enforced here rather than in each of them.
 *
 * FAIL CLOSED ON A DAMAGED RECORD, which is the half that decides whether this is a barrier at all.
 * A marker that exists and cannot be parsed reads as ENGAGED, not as absent: the unsafe direction is
 * the one where corruption re-opens the Library mid-cutover.
 */
export function assertNoMaintenanceBarrier(workspace: string, operation: string): void {
  const file = path.join(workspace, 'internal', 'maintenance-barrier.json');
  if (!fs.existsSync(file)) return;
  let record: Record<string, unknown> | null = null;
  let detail = '';
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch (error) {
    detail = `could not be read: ${(error as Error).message}`;
  }
  if (record === null) {
    throw new Error(
      `The Library is under a maintenance barrier, so ${operation} is refused. The barrier record at ` +
        `${file} exists and ${detail} -- a damaged marker is treated as ENGAGED, because a ` +
        'barrier that reads as absent when it is corrupt is not a barrier. Read the run it belongs to with ' +
        'tools/Move-LibraryFolder.ps1 -Action Status, or repair the record by hand. Reading is unaffected.',
    );
  }
  const runId = 'run_id' in record ? String(record['run_id']) : '';
  const lift =
    'lift_command' in record && String(record['lift_command']).trim()
      ? String(record['lift_command'])
      : runId.trim()
        ? `tools/Move-LibraryFolder.ps1 -Action LiftBarrier -RunId ${runId} -UserConfirmed`
        : 'tools/Move-LibraryFolder.ps1 -Action Status';
  throw new Error(
    `The Library is under a maintenance barrier, so ${operation} is refused. ${String(record['operation'] ?? '')} engaged it at ` +
      `${String(record['engaged_utc'] ?? '')} for: ${String(record['reason'] ?? '')}. Nothing may be changed at any seat until it is ` +
      `lifted, which is what keeps a cutover's verified copy from going stale under a late write. Lift it with: ${lift}. ` +
      'Reading is unaffected.',
  );
}

/**
 * Record when a seat was last touched. ADVISORY ONLY -- it never authorizes or unblocks a mutation,
 * and it is not a lease.
 *
 * `keepConversation` IS FOR A WRITE THAT STARTS NO CONVERSATION AT ALL. The record is replaced whole
 * by the next ENTRY, deliberately -- an entry that did not mint a conversation cannot name the one
 * it started. But opening or closing a Book is not an entry, and clearing there left a
 * launcher-started seat, which has no binding to fall back on, with nothing naming the conversation
 * sitting at it. Observed on a real seat: the launcher recorded its conversation at 20:05, one Book
 * was opened at 20:54, and the picker then refused to resume a live session.
 */
export function writeSeatActivity(options: {
  stateDirectory: string;
  seat: string;
  note: string;
  keepConversation?: boolean;
}): string | null {
  const deskDirectory = deskStateDirectory(options.stateDirectory, options.seat);
  if (!fs.existsSync(deskDirectory)) return null;
  const record: Record<string, PsJsonValue> = {
    advisory:
      'ADVICE ONLY. This record never authorizes or unblocks a mutation, and it is not a lease. Liveness is the seat claim.',
    seat: options.seat,
    last_seen_utc: utcRoundTrip(),
    note: options.note,
  };
  if (options.keepConversation) {
    const previous = readSeatActivity(options.stateDirectory, options.seat);
    if (previous && 'session_id' in previous && 'conversation_recorded_utc' in previous) {
      record['session_id'] = String(previous['session_id']);
      // THE ORIGINAL STAMP TRAVELS WITH IT. Re-stamping would make an old conversation look newer
      // than a binding written since, which is the comparison that decides which record is a seat's
      // last.
      record['conversation_recorded_utc'] = String(previous['conversation_recorded_utc']);
    }
  }
  const file = seatActivityPath(options.stateDirectory, options.seat);
  writeAtomicText(file, psConvertToJson(record) + '\n');
  return file;
}

/** Advisory, so an unreadable record is reported as absent rather than raised. */
export function readSeatActivity(stateDirectory: string, seat: string): Record<string, unknown> | null {
  const file = seatActivityPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
