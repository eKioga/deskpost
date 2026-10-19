/** c2 Unit A: isolated section workers, a drained serial lane, bounded children and owned cleanup.
 * --workers 1 keeps the original whole-suite environment; --split-serial is the isolated reference.
 * Time options are milliseconds. Logs and result.json are kept on failure, or with --keep-logs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv } from './gate-env.ts';
import { acquireGateLock, LockError, type GateWait, gateLockOffNotice } from './gate-lock.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERIAL_SECTIONS = [29, 31, 113];
// 2026-10-11: 29 and 31 failed at 12 workers; 113 failed at 8. All passed alone.
// 29 launches eight writers; 31 spins a reader beside concurrent CLI reads; 113 has timing assertions.
const SNAPSHOT_LIMIT = 30_000;
const CLEANUP_LIMIT = 30_000;
const STREAM_LIMIT = 10_000;
export interface ProcessRow { pid: number; parentPid: number; start: string; command: string; cpu?: number; threads?: unknown }

/** Small diagnostic commands also have exit and stream deadlines. No shell interpolation of caller text. */
export function boundedCommand(command: string, args: string[], timeout = SNAPSHOT_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', finished = false;
    let stream: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(stream);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(out);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} exceeded ${timeout}ms`)); }, timeout);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', finish);
    child.on('exit', () => { stream = setTimeout(() => finish(new Error(`${command}: output streams did not close`)), STREAM_LIMIT); });
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(`${command} exit ${code}: ${err.trim()}`)));
  });
}
export function powershell(script: string, timeout = SNAPSHOT_LIMIT): Promise<string> {
  return boundedCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], timeout);
}
export async function processTable(detail = false): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const text = await powershell(`$ErrorActionPreference='Stop'; $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
      $item = $_; $cpu = $null; $threads = $null; $start = '';
      try { $proc = Get-Process -Id $item.ProcessId -ErrorAction Stop; $start = $proc.StartTime.ToUniversalTime().ToString('o');
        ${detail ? `$cpu = $proc.CPU; $threads = @($proc.Threads | ForEach-Object { try { [string]$_.ThreadState + ':' + [string]$_.WaitReason } catch { [string]$_.ThreadState } })` : ''}
      } catch {}
      [pscustomobject]@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;start=$start;command=[string]$item.CommandLine;cpu=$cpu;threads=$threads}
    }); ConvertTo-Json -InputObject $rows -Depth 5 -Compress`);
    return JSON.parse(text.trim() || '[]') as ProcessRow[];
  }
  const text = await boundedCommand('ps', ['-eo', 'pid=,ppid=,lstart=,args=']);
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parentPid: Number(m[2]), start: m[3]!, command: m[4]! }] : [];
  });
}
export function descendants(rows: ProcessRow[], root: number, since: number): ProcessRow[] {
  const owned = new Set([root]);
  // Parent links are retained by the OS even after an exited root. Ignore earlier PID incarnations.
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parentPid) &&
      (process.platform !== 'win32' || Date.parse(row.start) >= since - 1000)) { owned.add(row.pid); added = true; }
  }
  return rows.filter((row) => owned.has(row.pid));
}
export async function startIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return (await processTable()).find((row) => row.pid === pid)?.start ?? null;
  // An exiting process can still answer Get-Process with no StartTime (S119, under the push pool's load): it is gone.
  const text = await powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime){$p.StartTime.ToUniversalTime().ToString('o')}; exit 0`);
  return text.trim() || null;
}
/** A survivor has the ID AND start time observed while the fixture was alive, as cleanup's `endOwned` checks.
 * An ID reused before or after `runEnd` belongs to another process. An unreadable start time is an exiting
 * process, gone, as `startIdentity` reads it; it cannot establish ownership. */
export function survivorRows(rows: ProcessRow[], identities: Pick<ProcessRow, 'pid' | 'start'>[], runEnd: number): ProcessRow[] {
  return rows.filter((row) => row.start !== '' && identities.some((owned) => owned.pid === row.pid && owned.start === row.start) && !(Date.parse(row.start) > runEnd));
}
async function endOwned(rows: ProcessRow[]): Promise<void> {
  // Before EACH PID-based kill compare its creation time again. Never kill by image or command-line match.
  if (process.platform === 'win32') {
    const identities = Buffer.from(JSON.stringify(rows.map(({ pid, start }) => ({ pid, start })))).toString('base64');
    await powershell(`$ErrorActionPreference='Stop'; $owned = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${identities}')) | ConvertFrom-Json;
      foreach($row in $owned){$p=Get-Process -Id $row.pid -ErrorAction SilentlyContinue; if($p -and $p.StartTime -and $p.StartTime.ToUniversalTime().ToString('o') -ceq $row.start){ & taskkill.exe /PID $row.pid /T /F | Out-Null }}
      $until=[DateTime]::UtcNow.AddSeconds(25); do { $live=@(foreach($row in $owned){$p=Get-Process -Id $row.pid -ErrorAction SilentlyContinue; if($p -and $p.StartTime -and $p.StartTime.ToUniversalTime().ToString('o') -ceq $row.start){$row.pid}}); if(!$live.Count){exit 0}; Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $until); throw ('owned processes still alive: '+($live -join ','))`, CLEANUP_LIMIT);
  } else {
    for (const row of rows) {
      if (await startIdentity(row.pid) === row.start) {
        try { process.kill(-row.pid, 'SIGKILL'); } // Detached section roots own a process group.
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
          if (await startIdentity(row.pid) === row.start) { try { process.kill(row.pid, 'SIGKILL'); } catch (again) { if ((again as NodeJS.ErrnoException).code !== 'ESRCH') throw again; } }
        }
      }
    }
    const until = Date.now() + CLEANUP_LIMIT;
    while (Date.now() < until) {
      const now = await processTable();
      if (!rows.some((row) => now.some((p) => p.pid === row.pid && p.start === row.start))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('owned processes still alive after cleanup');
  }
}
export async function terminateOwnedTree(pid: number, since: number, identity: string | null): Promise<void> {
  const rows = descendants(await processTable(), pid, since);
  const root = rows.find((row) => row.pid === pid);
  if (root && (identity === null || root.start !== identity || root.parentPid !== process.pid)) throw new Error('child identity changed or could not be read; no process ended');
  await endOwned(rows);
}
export interface Options { suite: string; workers: number; splitSerial: boolean; sectionTimeout: number; wholeTimeout: number; keepLogs: boolean; noWait: boolean; snapshotFailure: boolean }
export function parseOptions(argv: string[]): Options {
  const options: Options = { suite: path.join(HERE, 'selftest.ts'), workers: Number(process.env['DESKPOST_GATE_WORKERS'] ?? 8), splitSerial: false, sectionTimeout: 600_000, wholeTimeout: 2_700_000, keepLogs: false, noWait: false, snapshotFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--split-serial') options.splitSerial = true;
    else if (arg === '--keep-logs') options.keepLogs = true;
    else if (arg === '--no-wait') options.noWait = true;
    else if (arg === '--test-snapshot-failure') options.snapshotFailure = true;
    else if (arg === '--suite' && argv[i + 1]) options.suite = path.resolve(argv[++i]!);
    else if (['--workers', '--section-timeout', '--whole-timeout'].includes(arg) && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} must be a positive integer (timeouts in milliseconds)`);
      if (arg === '--workers') options.workers = value;
      else if (arg === '--section-timeout') options.sectionTimeout = value;
      else options.wholeTimeout = value;
    } else throw new Error(`unknown or incomplete argument '${arg}'`);
  }
  if (!Number.isInteger(options.workers) || options.workers < 1) throw new Error('DESKPOST_GATE_WORKERS must be a positive integer');
  if (options.splitSerial) options.workers = 1;
  if (options.snapshotFailure && options.suite === path.join(HERE, 'selftest.ts')) throw new Error('--test-snapshot-failure requires a fixture --suite');
  return options;
}
export function sectionNumbers(text: string, selection = process.env['LIBRARY_SELFTEST_SECTIONS'] ?? ''): number[] {
  const values = selection.split(',').map((value) => value.trim()).filter(Boolean).map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 1)) throw new Error(`LIBRARY_SELFTEST_SECTIONS must be section numbers, got '${selection}'`);
  return [...new Set(values.length ? values : [...text.matchAll(/^if \(selected\((\d+)\)/gm)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}
export interface Result { section: number | 'whole'; verdict: 'PASS' | 'FAIL' | 'SKIP'; checks: number; seconds: number; detail: string; output: string }
export function verdict(section: number | 'whole', status: number | null, output: string): Pick<Result, 'verdict' | 'checks' | 'detail'> {
  const last = output.trim().split(/\r?\n/).at(-1) ?? '';
  const firstError = output.split(/\r?\n/).find(line => /Error|error:/.test(line));
  const pass = /^kernel self-test passed \((\d+) checks\)(?: after waiting \d+(?:\.\d+)?s for .+'s .+ gate)?\.$/.exec(last);
  if (status === 0 && pass && Number(pass[1]) > 0) return { verdict: 'PASS', checks: Number(pass[1]), detail: '' };
  // A failing assertion can contain a multiline CLI response. Its canonical header carries the count;
  // the final physical line can be ordinary fixture text, never a zero-check inference.
  const failed = /^kernel self-test FAILED \((\d+) of (\d+)\): ([\s\S]*)$/m.exec(output.trim());
  const skip = typeof section === 'number' && new RegExp(`^SKIP section ${section}: .+$`, 'm').test(output);
  const earlierFailure = output.trim().split(/\r?\n/).slice(0, -1).some((line) => /\b(FAILED|FAIL|ERROR|Error:)\b/.test(line));
  if (status === 1 && skip && !earlierFailure && failed && failed[1] === '1' && failed[2] === '0' && failed[3] === `LIBRARY_SELFTEST_SECTIONS selected no checks: ${section}`) {
    return { verdict: 'SKIP', checks: 0, detail: output.split(/\r?\n/).find((line) => line.startsWith(`SKIP section ${section}:`))! };
  }
  return { verdict: 'FAIL', checks: failed ? Number(failed[2]) : pass ? Number(pass[1]) : 0, detail: `exit ${status}: ${failed ? `kernel self-test FAILED (${failed[1]} of ${failed[2]}): ${failed[3]}` : firstError?.trim() || last || 'no verdict'}` };
}
function decodedCommand(command: string): string {
  return command.replace(/(-InputJsonBase64\s+)["']?([A-Za-z0-9+/=]+)["']?/gi, (_m, prefix: string, data: string) => `${prefix}${Buffer.from(data, 'base64').toString('utf8')}`);
}
export function sectionEnvironment(section: number | 'whole', folder: string): NodeJS.ProcessEnv {
  const env = childEnv();
  if (section !== 'whole') {
    for (const key of ['TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const value = path.join(folder, key.toLowerCase()); fs.mkdirSync(value); env[key] = value;
    }
    env['LIBRARY_SELFTEST_SECTIONS'] = String(section);
    const cacheFolder = path.join(folder, 'psmodule'); fs.mkdirSync(cacheFolder);
    env['PSModuleAnalysisCachePath'] = path.join(cacheFolder, 'ModuleAnalysisCache');
  }
  return env;
}
export async function runSection(options: Options, section: number | 'whole', runFolder: string, signal: AbortSignal): Promise<Result> {
  const started = Date.now();
  const folder = path.join(runFolder, String(section)); fs.mkdirSync(folder);
  const env = sectionEnvironment(section, folder);
  let output = '', problem = '', status: number | null = null;
  const child = spawn(process.execPath, [options.suite], { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = child.pid ? startIdentity(child.pid).catch(() => null) : Promise.resolve(null);
  const log = fs.createWriteStream(path.join(folder, 'output.log'));
  child.stdout.on('data', (chunk) => { output += String(chunk); log.write(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); log.write(chunk); });
  let owned: ProcessRow[] = [];
  const snapshot = async () => {
    if (options.snapshotFailure) throw new Error('planted snapshot failure (fixture suite only)');
    const rows = await processTable(true);
    owned = descendants(rows, child.pid!, started);
    const root = owned.find((row) => row.pid === child.pid);
    const expected = await identity;
    if (root && (!expected || root.start !== expected || root.parentPid !== process.pid)) {
      owned = [];
      if (!expected) problem += '; root identity unavailable; cleanup cannot be verified';
    }
    const savedEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, /^(LIBRARY_|DESKPOST_|ORCA_|CLAUDE_PID$)/.test(key) && !/(TOKEN|SECRET|PASSWORD|KEY)$/i.test(key) ? value : '(value not recorded)']));
    fs.writeFileSync(path.join(folder, 'snapshot.json'), JSON.stringify({ reason: problem, runner: process.pid, environment: savedEnv, descendantsEnvironment: 'not readable', processes: owned.map((row) => ({ ...row, command: decodedCommand(row.command) })) }, null, 2));
  };
  await new Promise<void>((resolve) => {
    let done = false, stream: ReturnType<typeof setTimeout> | undefined;
    const finish = (why = '') => { if (done) return; done = true; problem = why; clearTimeout(timer); clearTimeout(stream); signal.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => finish('cancelled');
    const timer = setTimeout(() => finish(`timeout after ${section === 'whole' ? options.wholeTimeout : options.sectionTimeout}ms`), section === 'whole' ? options.wholeTimeout : options.sectionTimeout);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.on('error', (error) => finish(`could not start: ${error.message}`));
    child.on('exit', (code) => { status = code; stream = setTimeout(() => finish('output streams did not close within 10000ms'), STREAM_LIMIT); });
    child.on('close', (code) => { status = code; finish(); });
  });
  // Even a zero-check or tiny section can finish before its identity helper. Drain that bounded helper
  // before the section leaves its slot, so the lane and lock release are barriers for ALL owned spawns.
  await identity;
  let parsed = verdict(section, status, output);
  if (problem || parsed.verdict === 'FAIL') {
    try { await snapshot(); } catch (error) {
      fs.writeFileSync(path.join(folder, 'snapshot-error.txt'), String(error));
      // Diagnostics can fail independently. Obtain a minimal ownership table for cleanup regardless.
      try { owned = descendants(await processTable(), child.pid!, started); } catch (again) { problem += `; ownership scan failed: ${again}`; }
    } finally {
      try {
        // Revalidate the root against the identity observed just after spawn, even in the fallback path.
        const expected = await identity;
        if (expected && !owned.some((row) => row.pid === child.pid)) {
          // The snapshot and its fallback may both fail. The observed direct child's identity still permits
          // a checked /T kill in finally; absent descendant data cannot be called verified cleanup.
          if (await startIdentity(child.pid!) === expected) owned.unshift({ pid: child.pid!, parentPid: process.pid, start: expected, command: options.suite });
        }
        const root = owned.find((row) => row.pid === child.pid);
        if (root && (expected === null || root.start !== expected || root.parentPid !== process.pid)) {
          owned = [];
          if (!expected) problem += '; root identity unavailable; cleanup cannot be verified';
        }
        await endOwned(owned);
      } catch (error) { problem += `; cleanup failed: ${error}`; }
    }
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref(); log.end();
  if (problem) parsed = { ...parsed, verdict: 'FAIL', detail: `${problem}; ${parsed.detail}` };
  return { section, ...parsed, seconds: (Date.now() - started) / 1000, output };
}
/** Unit B: one bounded child of the push tier's pool. On its limit, a cancel or a stream that will not close, the
 * snapshot is written beside its log, then the tree it owns is ended and checked gone; `problem` names `label`. */
export interface Bounded { status: number | null; output: string; problem: string; seconds: number }
export async function runBounded(spec: { label: string; command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; limit: number; folder: string; onOutput?: (chunk: string) => void }, signal: AbortSignal): Promise<Bounded> {
  const started = Date.now();
  fs.mkdirSync(spec.folder, { recursive: true });
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = child.pid ? startIdentity(child.pid).catch(() => null) : Promise.resolve(null);
  const log = fs.createWriteStream(path.join(spec.folder, 'output.log'));
  let output = '', problem = '', status: number | null = null;
  child.stdout.on('data', (chunk) => { output += String(chunk); log.write(chunk); spec.onOutput?.(String(chunk)); });
  child.stderr.on('data', (chunk) => { output += String(chunk); log.write(chunk); spec.onOutput?.(String(chunk)); });
  await new Promise<void>((resolve) => {
    let done = false, stream: ReturnType<typeof setTimeout> | undefined;
    const finish = (why = '') => { if (done) return; done = true; problem = why; clearTimeout(timer); clearTimeout(stream); signal.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => finish(`${spec.label}: cancelled`);
    const timer = setTimeout(() => finish(`${spec.label}: exceeded its limit of ${Math.round(spec.limit / 1000)}s`), spec.limit);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.on('error', (error) => finish(`${spec.label}: could not start: ${error.message}`));
    child.on('exit', (code) => { status = code; stream = setTimeout(() => finish(`${spec.label}: output streams did not close within ${STREAM_LIMIT}ms`), STREAM_LIMIT); });
    child.on('close', (code) => { status = code; finish(); });
  });
  const expected = await identity;
  if (problem && child.pid) {
    try {
      const rows = descendants(await processTable(true), child.pid, started);
      fs.writeFileSync(path.join(spec.folder, 'snapshot.json'), JSON.stringify({ reason: problem, runner: process.pid, processes: rows.map((row) => ({ ...row, command: decodedCommand(row.command) })) }, null, 2));
    } catch (error) { fs.writeFileSync(path.join(spec.folder, 'snapshot-error.txt'), String(error)); }
    try { await terminateOwnedTree(child.pid, started, expected); } catch (error) { problem += `; cleanup failed: ${String(error)}`; }
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref(); log.end();
  return { status, output, problem, seconds: (Date.now() - started) / 1000 };
}
/** Unit B's one pool: shared items `slots` at a time, in the order given; then each exclusive item alone, after every
 * shared item has exited (the lane's global barrier). An item that throws stops new starts; the error is rethrown once
 * every started item has ended. */
export interface PoolItem<T> { name: string; exclusive: boolean; run(signal: AbortSignal): Promise<T> }
export async function runPool<T>(items: PoolItem<T>[], slots: number, signal: AbortSignal): Promise<T[]> {
  const shared = items.filter((item) => !item.exclusive);
  const results: T[] = [];
  let next = 0, error: unknown = null;
  const take = async (item: PoolItem<T>) => { try { results.push(await item.run(signal)); } catch (thrown) { error ??= thrown; } };
  await Promise.all(Array.from({ length: Math.min(slots, shared.length) }, async () => {
    while (next < shared.length && !signal.aborted && error === null) await take(shared[next++]!);
  }));
  for (const item of items.filter((candidate) => candidate.exclusive)) {
    if (signal.aborted || error !== null) break;
    await take(item);
  }
  if (error !== null) throw error;
  return results;
}
/** The -Fast roster as gate.fast-roster-matches-suites reads it: the one foreach's array under the bare if ($Fast),
 * whose AST check proves it equals every registration in the else arm. A reshaped branch throws, never an empty list. */
export function fastRoster(runnerSource: string): string[] {
  const found = /^if \(\$Fast\) \{\r?\n\s*foreach \(\$name in @\(([^)]*)\)\) \{/m.exec(runnerSource);
  if (!found) throw new Error('the -Fast roster is not where gate.fast-roster-matches-suites reads it (the foreach under the bare if ($Fast))');
  const names = [...found[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  if (!names.length) throw new Error('the -Fast roster is empty');
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  if (twice.length) throw new Error(`the -Fast roster names ${twice.join(', ')} more than once`);
  return names;
}
/** The pool's suite list against the roster a -Fast run reported: empty when they are equal both ways. */
export function rosterProblems(pool: readonly string[], reported: readonly string[]): string[] {
  const problems: string[] = [];
  const unrun = reported.filter((name) => !pool.includes(name));
  const extra = pool.filter((name) => !reported.includes(name));
  if (unrun.length) problems.push(`the -Fast run reports ${unrun.join(', ')}, which the pool does not run`);
  if (extra.length) problems.push(`the pool runs ${extra.join(', ')}, which the -Fast run does not report`);
  return problems;
}
export async function run(options: Options, wait: GateWait | null = null): Promise<number> {
  const sections = sectionNumbers(fs.readFileSync(options.suite, 'utf8'));
  if (!sections.length) throw new Error('suite has no sections');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-gate-'));
  process.stdout.write(`runner log: ${folder}\n`);
  const controller = new AbortController();
  const cancel = () => controller.abort(); process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const results: Result[] = [];
  const started = Date.now();
  try {
    const whole = Boolean(process.env['LIBRARY_SELFTEST_KERNEL']) || (options.workers === 1 && !options.splitSerial);
    if (whole) results.push(await runSection(options, 'whole', folder, controller.signal));
    else {
      const queue = sections.filter((section) => !SERIAL_SECTIONS.includes(section));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(options.workers, queue.length) }, async () => {
        while (next < queue.length && !controller.signal.aborted) results.push(await runSection(options, queue[next++]!, folder, controller.signal));
      }));
      // The barrier waits on all workers, including their stream and cleanup deadlines.
      for (const section of sections.filter((n) => SERIAL_SECTIONS.includes(n))) {
        if (controller.signal.aborted) break;
        results.push(await runSection(options, section, folder, controller.signal));
      }
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  results.sort((a, b) => Number(a.section) - Number(b.section));
  const total = results.reduce((sum, result) => sum + result.checks, 0);
  const failed = results.filter((result) => result.verdict === 'FAIL');
  const flatten = (value: string) => value.replace(/[\r\n]+/g, ' | ');
  const lines = results.map((r) => `section ${r.section}: ${r.verdict} ${r.checks} checks ${r.seconds.toFixed(3)}s${r.detail ? ` ${flatten(r.detail)}` : ''}`);
  fs.writeFileSync(path.join(folder, 'sections.log'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ seconds: (Date.now() - started) / 1000, total, cancelled: controller.signal.aborted, results: results.map(({ output: _output, ...r }) => r) }, null, 2));
  for (const line of lines) process.stdout.write(line + '\n');
  const bad = failed.length || controller.signal.aborted;
  // Keep compact per-section evidence on success too; bulky child output is needed only on failure or request.
  if (!bad && !options.keepLogs) for (const result of results) fs.rmSync(path.join(folder, String(result.section)), { recursive: true, force: true });
  if (bad) process.stderr.write(`kernel self-test FAILED (${failed.length || 1} of ${total}): ${failed.map((r) => `section ${r.section}: ${flatten(r.detail)}`).join('; ') || 'cancelled'}; evidence: ${folder}\n`);
  else process.stdout.write(`kernel self-test passed (${total} checks)${wait ? ` after waiting ${wait.seconds.toFixed(1)}s for ${wait.seat}'s ${wait.tier} gate` : ''}.\n`);
  return bad ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (async () => {
    const options = parseOptions(process.argv.slice(2));
    const say = (line: string) => process.stdout.write(line + '\n');
    const lock = options.workers > 1 ? await acquireGateLock('parallel self-test', options.noWait, say) : null;
    const notice = lock && gateLockOffNotice(lock);
    if (notice) say(notice);
    try { return await run(options, lock?.wait); } finally { await lock?.release(); }
  })().then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`runner: ${String(error)}\n`); process.exitCode = error instanceof LockError ? error.code : 2; });
}
