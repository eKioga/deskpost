/**
 * THE KERNEL'S WINDOWS PROCESS CALLS, THROUGH `bun:ffi` (PLAN-no-powershell-runtime.md D7, kickoffs/s83 row 1).
 *
 * Until 1.3.2 every one of these was a `powershell.exe` spawn: the start time a seat binding is checked by, the
 * ancestry walk that finds the agent client, the wait that holds a seat for exactly its agent's life, and the process
 * list a lifecycle switch checks for live sessions. A compiled kernel carries `bun:ffi` (seatclaim.ts already opens
 * its claim through it), so each is now one kernel32 call, and a reader's machine starts no PowerShell for them.
 *
 * ONLY UNDER BUN ON WINDOWS. `nativeProcessCalls()` answers null anywhere else, and every caller then keeps its
 * PowerShell (or POSIX) path: a kernel run from source under Node has no FFI, and that fallback is what the
 * acceptance matrix's source arm measures (Q2). The "one code path" rule procstart.ts kept until S83 is revoked.
 *
 * THE START TIME IS THE ORACLE'S INSTANT. `Process.StartTime` is `GetProcessTimes`' creation FILETIME made local, and
 * the oracle turns it back to UTC with `ToUniversalTime().ToString('o')`; this reads the same FILETIME and formats it
 * with the same seven fractional digits. The two agree except in the hour a DST change repeats, which no check claims.
 */

import { roundTripFromHundredNanoseconds } from './procstart.ts';

/** One row of the process table: what Toolhelp32 says a process is, and its image path where it can be read. */
export interface NativeProcessRow {
  pid: number;
  parentPid: number;
  name: string;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const STILL_ACTIVE = 259;
const ERROR_INVALID_PARAMETER = 87;
const TH32CS_SNAPPROCESS = 0x2;
const WAIT_TIMEOUT = 0x102;
/** FILETIME counts 100 ns from 1601; the Unix epoch is this many of them later. */
const FILETIME_UNIX_EPOCH = 116444736000000000n;
/** sizeof(PROCESSENTRY32W) on x64: szExeFile starts at 44 and is 260 WCHARs, padded to 8. */
const PROCESSENTRY32W_SIZE = 568;

interface Kernel32 {
  symbols: {
    OpenProcess(access: number, inherit: number, pid: number): number;
    CloseHandle(handle: number): number;
    GetLastError(): number;
    GetProcessTimes(handle: number, creation: Uint8Array, exit: Uint8Array, kernel: Uint8Array, user: Uint8Array): number;
    GetExitCodeProcess(handle: number, code: Uint8Array): number;
    WaitForSingleObject(handle: number, milliseconds: number): number;
    CreateToolhelp32Snapshot(flags: number, pid: number): number;
    Process32FirstW(snapshot: number, entry: Uint8Array): number;
    Process32NextW(snapshot: number, entry: Uint8Array): number;
    QueryFullProcessImageNameW(handle: number, flags: number, name: Uint8Array, size: Uint8Array): number;
  };
}

let kernel32: Kernel32 | null = null;

/** The kernel32 calls, or null where there is no `bun:ffi` to make them: off Windows, or under Node. */
export function nativeProcessCalls(): Kernel32['symbols'] | null {
  if (process.platform !== 'win32' || typeof (globalThis as { Bun?: unknown }).Bun !== 'object') return null;
  if (kernel32 === null) {
    const ffi = (import.meta as unknown as { require(name: string): any }).require('bun:ffi');
    const { FFIType } = ffi;
    const handle = FFIType.i64_fast;
    kernel32 = ffi.dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: handle },
      CloseHandle: { args: [handle], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
      GetProcessTimes: { args: [handle, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetExitCodeProcess: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
      WaitForSingleObject: { args: [handle, FFIType.u32], returns: FFIType.u32 },
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: handle },
      Process32FirstW: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
      QueryFullProcessImageNameW: { args: [handle, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }) as Kernel32;
  }
  return kernel32!.symbols;
}

function validHandle(handle: number): boolean {
  return handle !== 0 && handle !== -1;
}

function readWide(buffer: Uint8Array, offset: number, maxChars: number): string {
  const view = Buffer.from(buffer.buffer, buffer.byteOffset + offset, maxChars * 2);
  const text = view.toString('utf16le');
  const end = text.indexOf('\0');
  return end < 0 ? text : text.slice(0, end);
}

function creationOf(api: Kernel32['symbols'], handle: number): string | null {
  const creation = new Uint8Array(8);
  const scratch = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)] as const;
  if (!api.GetProcessTimes(handle, creation, scratch[0], scratch[1], scratch[2])) return null;
  const filetime = new DataView(creation.buffer).getBigUint64(0, true);
  return roundTripFromHundredNanoseconds(filetime - FILETIME_UNIX_EPOCH);
}

/**
 * A process's start time in UTC, round-trip format, as the oracle's expression spells it. `null` when no such process
 * is running; `'unreadable'` when it exists and cannot be opened or read -- the sentinel procstart.ts keeps alive.
 */
export function nativeProcessStartUtc(pid: number, unreadable: string): string | null {
  const api = nativeProcessCalls()!;
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!validHandle(handle)) return api.GetLastError() === ERROR_INVALID_PARAMETER ? null : unreadable;
  try {
    // AN EXITED PROCESS SOMEBODY STILL HOLDS OPEN can be opened, and `Get-Process` does not list it: it is gone.
    const code = new Uint8Array(4);
    if (api.GetExitCodeProcess(handle, code) && new DataView(code.buffer).getUint32(0, true) !== STILL_ACTIVE) return null;
    return creationOf(api, handle) ?? unreadable;
  } finally {
    api.CloseHandle(handle);
  }
}

/** Every process Toolhelp32 sees: pid, parent pid and image name, in one snapshot. */
export function nativeProcessTable(): NativeProcessRow[] {
  const api = nativeProcessCalls()!;
  const snapshot = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!validHandle(snapshot)) throw new Error(`CreateToolhelp32Snapshot failed with Windows error ${api.GetLastError()}`);
  const rows: NativeProcessRow[] = [];
  try {
    const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
    const view = new DataView(entry.buffer);
    view.setUint32(0, PROCESSENTRY32W_SIZE, true);
    for (let more = api.Process32FirstW(snapshot, entry); more; more = api.Process32NextW(snapshot, entry)) {
      rows.push({ pid: view.getUint32(8, true), parentPid: view.getUint32(32, true), name: readWide(entry, 44, 260) });
      view.setUint32(0, PROCESSENTRY32W_SIZE, true);
    }
  } finally {
    api.CloseHandle(snapshot);
  }
  return rows;
}

/** A process's full image path, or null where it cannot be opened or read -- as Win32_Process's ExecutablePath is null. */
export function nativeProcessImagePath(pid: number): string | null {
  const api = nativeProcessCalls()!;
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!validHandle(handle)) return null;
  try {
    const chars = 32768;
    const name = new Uint8Array(chars * 2);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, chars, true);
    if (!api.QueryFullProcessImageNameW(handle, 0, name, size)) return null;
    return readWide(name, 0, new DataView(size.buffer).getUint32(0, true));
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * Wait for a process to exit, without blocking the event loop: the handle is held open for the whole wait (so its pid
 * cannot be reused under it) and asked with a zero timeout between short sleeps. Before the wait, a process whose
 * start time readably differs from `expectedStartUtc` is a different process at the pid, and is not waited on.
 * Answers `'gone'` (nothing at the pid), `'different'`, `'exited'`, or `'unopenable'` when the pid cannot be opened
 * for waiting, and the caller then falls back to polling.
 */
export async function nativeWaitForExit(pid: number, expectedStartUtc: string, sliceMs: number): Promise<'gone' | 'different' | 'exited' | 'unopenable'> {
  const api = nativeProcessCalls()!;
  const handle = api.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!validHandle(handle)) return api.GetLastError() === ERROR_INVALID_PARAMETER ? 'gone' : 'unopenable';
  try {
    const start = creationOf(api, handle);
    if (expectedStartUtc.trim() && start !== null && start !== expectedStartUtc) return 'different';
    while (api.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT) await new Promise((resolve) => setTimeout(resolve, sliceMs));
    return 'exited';
  } finally {
    api.CloseHandle(handle);
  }
}

// --- THE UNINSTALL FINISHER'S CALLS (PLAN-no-powershell-runtime.md D8, kickoffs/s83 row 2) ---------------------------

interface Advapi32 {
  symbols: {
    RegOpenKeyExW(key: number, subkey: Uint8Array, options: number, access: number, result: Uint8Array): number;
    RegQueryValueExW(key: number, name: Uint8Array, reserved: null, type: Uint8Array, data: Uint8Array | null, size: Uint8Array): number;
    RegSetValueExW(key: number, name: Uint8Array, reserved: number, type: number, data: Uint8Array, size: number): number;
    RegCloseKey(key: number): number;
  };
}

interface Kernel32Start {
  symbols: {
    CreateProcessW(
      application: Uint8Array,
      commandLine: Uint8Array,
      processAttributes: null,
      threadAttributes: null,
      inherit: number,
      flags: number,
      environment: null,
      directory: Uint8Array | null,
      startup: Uint8Array,
      information: Uint8Array,
    ): number;
    CloseHandle(handle: number): number;
    GetLastError(): number;
  };
}

let advapi32: Advapi32 | null = null;
let kernel32Start: Kernel32Start | null = null;

const ERROR_ACCESS_DENIED = 5;
const ERROR_FILE_NOT_FOUND = 2;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NO_WINDOW = 0x08000000;
/** sizeof(STARTUPINFOW) and sizeof(PROCESS_INFORMATION) on x64. */
const STARTUPINFOW_SIZE = 104;
const PROCESS_INFORMATION_SIZE = 24;
/** HKEY_CURRENT_USER, `(HKEY)(LONG)0x80000001` sign-extended to 64 bits. */
const HKEY_CURRENT_USER = -2147483647;
const KEY_QUERY_VALUE = 0x1;
const KEY_SET_VALUE = 0x2;
const REG_EXPAND_SZ = 2;

function wide(text: string): Uint8Array {
  return Buffer.from(text + '\0', 'utf16le');
}

function ffiOrRefuse(what: string): any {
  if (process.platform !== 'win32' || typeof (globalThis as { Bun?: unknown }).Bun !== 'object') throw new Error(`${what} needs bun:ffi on Windows: run the installed program`);
  return (import.meta as unknown as { require(name: string): any }).require('bun:ffi');
}

function registry(): Advapi32['symbols'] {
  if (advapi32 === null) {
    const ffi = ffiOrRefuse('the PATH edit');
    const { FFIType } = ffi;
    advapi32 = ffi.dlopen('advapi32.dll', {
      RegOpenKeyExW: { args: [FFIType.i64_fast, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      RegQueryValueExW: { args: [FFIType.i64_fast, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      RegSetValueExW: { args: [FFIType.i64_fast, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      RegCloseKey: { args: [FFIType.i64_fast], returns: FFIType.i32 },
    }) as Advapi32;
  }
  return advapi32!.symbols;
}

function withUserKey<T>(subkey: string, access: number, body: (api: Advapi32['symbols'], key: number) => T): T {
  const api = registry();
  const result = new Uint8Array(8);
  const status = api.RegOpenKeyExW(HKEY_CURRENT_USER, wide(subkey), 0, access, result);
  if (status !== 0) throw new Error(`HKCU\\${subkey} could not be opened (Windows error ${status})`);
  const key = Number(new DataView(result.buffer).getBigInt64(0, true));
  try {
    return body(api, key);
  } finally {
    api.RegCloseKey(key);
  }
}

/** HKCU\<subkey>'s `Path` as stored, never expanded: `%USERPROFILE%\x` stays as written. Empty when there is none. */
export function nativeUserPathRead(subkey: string): string {
  return withUserKey(subkey, KEY_QUERY_VALUE, (api, key) => {
    const name = wide('Path');
    const type = new Uint8Array(4);
    const size = new Uint8Array(4);
    const first = api.RegQueryValueExW(key, name, null, type, null, size);
    if (first === ERROR_FILE_NOT_FOUND) return '';
    if (first !== 0) throw new Error(`HKCU\\${subkey}'s Path could not be read (Windows error ${first})`);
    const data = new Uint8Array(new DataView(size.buffer).getUint32(0, true) + 2);
    new DataView(size.buffer).setUint32(0, data.length, true);
    const second = api.RegQueryValueExW(key, name, null, type, data, size);
    if (second !== 0) throw new Error(`HKCU\\${subkey}'s Path could not be read (Windows error ${second})`);
    return Buffer.from(data.buffer, 0, new DataView(size.buffer).getUint32(0, true)).toString('utf16le').replace(/\0+$/, '');
  });
}

/** Write HKCU\<subkey>'s `Path` as REG_EXPAND_SZ, as `Set-ItemProperty -Type ExpandString` does. */
export function nativeUserPathWrite(subkey: string, value: string): void {
  withUserKey(subkey, KEY_SET_VALUE, (api, key) => {
    const data = wide(value);
    const status = api.RegSetValueExW(key, wide('Path'), 0, REG_EXPAND_SZ, data, data.length);
    if (status !== 0) throw new Error(`HKCU\\${subkey}'s Path could not be written (Windows error ${status})`);
  });
}

/** What `CreateProcessW` started. */
export interface NativeStart {
  pid: number;
  breakaway: boolean;
}

/**
 * Start a program OUTSIDE this process's job (PLAN-no-powershell-runtime.md D8, S82's spike): `CreateProcessW` with
 * `CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW`, and on `ERROR_ACCESS_DENIED` -- a job that does not allow breakaway
 * -- the same start without it. Never the runtime's attached `spawn`: Bun puts that child in its own kill-on-close job
 * (`0x3c00`, measured), and it dies when this process exits. A plain `CreateProcessW` child is not caught by that job,
 * which carries SILENT_BREAKAWAY_OK. Throws with the Windows error when neither start works.
 */
export function nativeStartDetached(application: string, commandLine: string, directory: string | null = null): NativeStart {
  if (kernel32Start === null) {
    const ffi = ffiOrRefuse('a detached start');
    const { FFIType } = ffi;
    kernel32Start = ffi.dlopen('kernel32.dll', {
      CreateProcessW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.i64_fast], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }) as Kernel32Start;
  }
  const api = kernel32Start!.symbols;
  const attempt = (flags: number): { pid: number } | { error: number } => {
    const startup = new Uint8Array(STARTUPINFOW_SIZE);
    new DataView(startup.buffer).setUint32(0, STARTUPINFOW_SIZE, true);
    const information = new Uint8Array(PROCESS_INFORMATION_SIZE);
    // The command line is a WRITABLE buffer, as CreateProcessW requires.
    const ok = api.CreateProcessW(wide(application), wide(commandLine), null, null, 0, flags, null, directory === null ? null : wide(directory), startup, information);
    if (!ok) return { error: api.GetLastError() };
    const view = new DataView(information.buffer);
    api.CloseHandle(Number(view.getBigInt64(0, true)));
    api.CloseHandle(Number(view.getBigInt64(8, true)));
    return { pid: view.getUint32(16, true) };
  };
  const first = attempt(CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW);
  if ('pid' in first) return { pid: first.pid, breakaway: true };
  if (first.error !== ERROR_ACCESS_DENIED) throw new Error(`CreateProcessW failed with Windows error ${first.error}`);
  const second = attempt(CREATE_NO_WINDOW);
  if ('pid' in second) return { pid: second.pid, breakaway: false };
  throw new Error(`CreateProcessW failed with Windows error ${second.error}`);
}
