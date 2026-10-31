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
import { agentProcessIdentity } from '../src/procstart.ts';
import { acquireGateLock, LockError, type GateWait, gateLockOffNotice } from './gate-lock.ts';
import { LINUX_SKIP_PATH, applyPlatformSkips, parseLinuxSkip, platformRefusals, platformSkips } from '../../tools/section-select.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERIAL_SECTIONS = [29, 31, 113];
// 2026-10-11: 29 and 31 failed at 12 workers; 113 failed at 8. All passed alone.
// 29 launches eight writers; 31 spins a reader beside concurrent CLI reads; 113 has timing assertions.
const SNAPSHOT_LIMIT = 30_000;
const CLEANUP_LIMIT = 30_000;
const STREAM_LIMIT = 10_000;
export interface ProcessRow { pid: number; parentPid: number; start: string; command: string; cpu?: number; threads?: unknown; group?: number; marker?: string }
/** The variable that names the section a process was started for (kickoffs/s157 row 4): its run folder. */
export const SECTION_MARKER = 'DESKPOST_GATE_SECTION';

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
  const text = await boundedCommand('ps', ['-eo', 'pid=,ppid=,pgid=,lstart=,args=']);
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parentPid: Number(m[2]), group: Number(m[3]), start: m[4]!, command: m[5]!, ...sectionMarker(Number(m[1])) }] : [];
  });
}
/** A Linux process's section marker from its environment; an environment this user cannot read has none. */
function sectionMarker(pid: number): { marker?: string } {
  if (process.platform !== 'linux') return {};
  try {
    const found = fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').find((entry) => entry.startsWith(`${SECTION_MARKER}=`));
    return found === undefined ? {} : { marker: found.slice(SECTION_MARKER.length + 1) };
  } catch { return {}; }
}
export function descendants(rows: ProcessRow[], root: number, since: number, marker?: string): ProcessRow[] {
  const owned = new Set([root]);
  // AN ORPHAN THAT STARTED ITS OWN SESSION leaves the section's group too (kickoffs/s157 row 4), but it keeps the
  // environment it was started with, and with it the section's marker.
  if (marker !== undefined) for (const row of rows) if (row.marker === marker) owned.add(row.pid);
  // Parent links are retained by the OS even after an exited root. Ignore earlier PID incarnations.
  // OFF WINDOWS AN ORPHAN IS RE-PARENTED and its link is gone (kickoffs/s156 row 2), but a section root leads its own
  // process group (it is started detached), and an orphan that did not start its own session stays in it.
  for (const row of rows) if (process.platform !== 'win32' && row.group === root && Date.parse(row.start) >= since - 1000) owned.add(row.pid);
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parentPid) &&
      (process.platform !== 'win32' || Date.parse(row.start) >= since - 1000)) { owned.add(row.pid); added = true; }
  }
  return rows.filter((row) => owned.has(row.pid));
}
/** A process's start identity. ON LINUX procstart.ts's, ticks since boot (kickoffs/s158 row 1): `ps lstart` moves whenever
 * WSL2 steps its clock, so a section's root read as another process and cleanup ended nothing (section 218). */
export async function startIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return agentProcessIdentity(pid, { fresh: true });
  if (process.platform !== 'win32') return (await processTable()).find((row) => row.pid === pid)?.start ?? null;
  // An exiting process can still answer Get-Process with no StartTime (S119, under the push pool's load): it is gone.
  const text = await powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime){$p.StartTime.ToUniversalTime().ToString('o')}; exit 0`);
  return text.trim() || null;
}
/** A survivor has the ID AND start time observed while the fixture was alive, as cleanup's `endOwned` checks.
 * An ID reused before or after `runEnd` belongs to another process. An unreadable start time is an exiting
 * process, gone, as `startIdentity` reads it; it cannot establish ownership.
 * ON LINUX AN IDENTITY RECORDED AS procstart.ts SPELLS IT DECIDES (kickoffs/s157 row 5): `ps lstart` moves
 * whenever WSL2 steps its clock, so a live survivor read as another process; ticks since boot never move. */
export function survivorRows(rows: ProcessRow[], identities: (Pick<ProcessRow, 'pid' | 'start'> & { identity?: string })[], runEnd: number): ProcessRow[] {
  return rows.filter((row) => row.start !== '' && identities.some((owned) => owned.pid === row.pid &&
    (process.platform === 'linux' && owned.identity !== undefined ? agentProcessIdentity(row.pid, { fresh: true }) === owned.identity : owned.start === row.start && !(Date.parse(row.start) > runEnd))));
}
export async function endOwned(rows: ProcessRow[]): Promise<void> {
  // Before EACH PID-based kill compare its creation time again. Never kill by image or command-line match.
  if (process.platform === 'win32') {
    const identities = Buffer.from(JSON.stringify(rows.map(({ pid, start }) => ({ pid, start })))).toString('base64');
    await powershell(`$ErrorActionPreference='Stop'; $owned = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${identities}')) | ConvertFrom-Json;
      foreach($row in $owned){$p=Get-Process -Id $row.pid -ErrorAction SilentlyContinue; $s=$null; try { $s=$p.StartTime.ToUniversalTime().ToString('o') } catch { }; if($p -and $s -ceq $row.start){ & taskkill.exe /PID $row.pid /T /F | Out-Null }}
      $until=[DateTime]::UtcNow.AddSeconds(25); do { $live=@(foreach($row in $owned){$p=Get-Process -Id $row.pid -ErrorAction SilentlyContinue; $s=$null; try { $s=$p.StartTime.ToUniversalTime().ToString('o') } catch { }; if($p -and $s -ceq $row.start){$row.pid}}); if(!$live.Count){exit 0}; Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $until); throw ('owned processes still alive: '+($live -join ','))`, CLEANUP_LIMIT);
  } else {
    // On Linux each row's identity is read once, here, just after the table that owned it: its `start` is `ps lstart`.
    const linux = process.platform === 'linux';
    const owned = linux ? await Promise.all(rows.map(async (row) => ({ ...row, start: await startIdentity(row.pid) ?? '' }))) : rows;
    for (const row of owned) {
      if (row.start !== '' && await startIdentity(row.pid) === row.start) {
        try { process.kill(-row.pid, 'SIGKILL'); } // Detached section roots own a process group.
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
          if (await startIdentity(row.pid) === row.start) { try { process.kill(row.pid, 'SIGKILL'); } catch (again) { if ((again as NodeJS.ErrnoException).code !== 'ESRCH') throw again; } }
        }
      }
    }
    const until = Date.now() + CLEANUP_LIMIT;
    while (Date.now() < until) {
      const now = linux ? [] : await processTable();
      const alive = linux ? (await Promise.all(owned.map(async (row) => row.start !== '' && await startIdentity(row.pid) === row.start))).some(Boolean)
        : owned.some((row) => now.some((p) => p.pid === row.pid && p.start === row.start));
      if (!alive) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('owned processes still alive after cleanup');
  }
}
export async function terminateOwnedTree(pid: number, since: number, identity: string | null): Promise<void> {
  const rows = descendants(await processTable(), pid, since);
  const root = rows.find((row) => row.pid === pid);
  if (root && (identity === null || (process.platform === 'linux' ? await startIdentity(root.pid) : root.start) !== identity || root.parentPid !== process.pid)) throw new Error('child identity changed or could not be read; no process ended');
  await endOwned(rows);
}
/**
 * A SECTION A KICKOFF REQUIRES MUST PASS, NOT SKIP (kickoffs/s120 row 9; c14 ran two green gates that skipped section
 * 149): each named section whose verdict in a sections.log is SKIP, or which the log does not name, is a problem.
 * Moved here from tools/gate.ts so a focused run checks it with the same code (kickoffs/s140 row 4).
 */
export function requiredSectionProblems(logText: string, required: string[]): string[] {
  const verdicts = new Map<string, string>();
  for (const line of logText.split(/\r?\n/)) {
    const m = /^section (\d+): (\S+)/.exec(line);
    if (m) verdicts.set(m[1]!, m[2]!);
  }
  return required.flatMap((section) => {
    const verdict = verdicts.get(section);
    return verdict === undefined ? [`section ${section}: absent`] : verdict === 'SKIP' ? [`section ${section}: SKIP`] : [];
  });
}
/** The gate.required-sections verdict and its words, for tools/gate.ts and this runner alike. */
export function requiredSectionsVerdict(logText: string, required: string[]): { status: 'pass' | 'fail'; detail: string } {
  const problems = requiredSectionProblems(logText, required);
  return { status: problems.length ? 'fail' : 'pass',
    detail: problems.length ? `a section this gate was told to require did not pass: ${problems.join('; ')}` : `sections ${required.join(', ')} each ran with a verdict other than SKIP` };
}
/**
 * A REQUIRED SECTION THAT CANNOT PASS HERE IS REFUSED BEFORE ANYTHING RUNS (kickoffs/s153 row 5): s152's first push tier
 * ran 19m 43s and then failed only gate.required-sections, for seven sections it skips by declaration on Windows. A
 * section opened as `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))` skips whole when <condition> is
 * false, and the terms of <condition> a runner can judge without running the section are judged here: the platform,
 * the kernel under test (LIBRARY_SELFTEST_KERNEL), and that the suite is the TypeScript source. One term known false
 * makes the skip known. A term it cannot judge (a file on disk, a probe), and a prerequisite inside a section's body,
 * leave the section to the end-of-run verdict, as before.
 */
export interface DeclaredSkip { section: number; reason: string }
export interface SkipContext { platform: NodeJS.Platform; kernel: string[] }
export function runnerSkipContext(): SkipContext {
  return { platform: process.platform, kernel: (process.env['LIBRARY_SELFTEST_KERNEL'] ?? '').split(/\s+/).filter((part) => part.length > 0) };
}
/** The text of one call's arguments from just after its `(`, split at top-level commas; quotes and brackets respected. */
function callArguments(text: string, from: number): string[] | null {
  const args: string[] = [];
  let depth = 0, quote = '', start = from;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) { args.push(text.slice(start, i).trim()); return args; }
      depth -= 1;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}
/** `a && b && c` at the top level, as its terms. */
function conjuncts(condition: string): string[] {
  const terms: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < condition.length; i += 1) {
    const c = condition[i]!;
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && condition.startsWith('&&', i)) { terms.push(condition.slice(start, i).trim()); start = i + 2; i += 1; }
  }
  terms.push(condition.slice(start).trim());
  return terms;
}
/** One term's value in this context, or null when only the section could say. */
function knownTerm(term: string, context: SkipContext): boolean | null {
  const t = term.replace(/\s+/g, ' ');
  const exe = context.kernel.length === 1 && /\.exe$/i.test(context.kernel[0]!);
  switch (t) {
    case "process.platform === 'win32'": return context.platform === 'win32';
    case "process.platform !== 'win32'": return context.platform !== 'win32';
    case "process.platform === 'linux'": return context.platform === 'linux';
    case "process.platform !== 'linux'": return context.platform !== 'linux';
    case '!isCompiled()': return true; // a runner runs the TypeScript suite; a compiled kernel is LIBRARY_SELFTEST_KERNEL
    case 'KERNEL_COMMAND.length === 0': return context.kernel.length === 0;
    case 'KERNEL_COMMAND.length === 1': return context.kernel.length === 1;
    case '/\\.exe$/i.test(KERNEL_COMMAND[0]!)': return exe;
    case 'releaseTreeUnderTest() !== null': return context.platform === 'win32' && exe ? null : false;
    default: return null;
  }
}
/** This platform's skips by `kernel/test/linux-skip.json` (kickoffs/s153 row 6): the list on Linux, nothing elsewhere,
 * and nothing in a tree without the file. */
export function readPlatformSkips(platform: string = process.platform): Map<number, string> {
  const file = path.join(HERE, path.basename(LINUX_SKIP_PATH));
  return fs.existsSync(file) ? platformSkips(platform, parseLinuxSkip(fs.readFileSync(file, 'utf8'))) : new Map();
}
/** THE SKIP LIST A RUN APPLIES (kickoffs/s157 row 3): `linux-skip.json` names the real suite's sections, so it applies to
 * the real `selftest.ts` beside this runner only. Any other suite gets the list its caller hands it with `--skip-list
 * <file>`, or none: a fixture's section 4 is not the real section 4. */
export function suiteSkips(options: Pick<Options, 'suite' | 'skipList'>, platform: string = process.platform): Map<number, string> {
  if (options.skipList !== null) return platformSkips(platform, parseLinuxSkip(fs.readFileSync(options.skipList, 'utf8')));
  return path.resolve(options.suite) === path.join(HERE, 'selftest.ts') ? readPlatformSkips(platform) : new Map();
}
/** Every refusal of a required list before a run: the platform's skips, then the suite's known declared ones. */
export function requiredListRefusals(required: readonly string[], suiteText: string, skips: Map<number, string> = readPlatformSkips()): string[] {
  return [...platformRefusals(required, skips), ...requiredRefusals(required, knownDeclaredSkips(suiteText))];
}
/** Read a literal without evaluating source. Dynamic templates remain an explicit preflight refusal. */
function prerequisiteReason(source: string): string | undefined {
  const quote = source[0];
  if (!quote || !['\'', '"', '`'].includes(quote) || source.at(-1) !== quote) return undefined;
  const body = source.slice(1, -1);
  if (quote === '`' && body.includes('${')) return undefined;
  let result = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === quote || (quote !== '`' && /[\r\n]/.test(c))) return undefined;
    if (c !== '\\') { result += c; continue; }
    const escape = body[++i];
    if (escape === undefined || /[1-9]/.test(escape) || (escape === '0' && /[0-9]/.test(body[i + 1] ?? ''))) return undefined;
    if (escape === '\n') continue;
    if (escape === '\r') { if (body[i + 1] === '\n') i += 1; continue; }
    if (escape === 'x' || escape === 'u') {
      const rest = body.slice(i + 1);
      const hex = (escape === 'x' ? /^[0-9a-f]{2}/i : /^(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\})/i).exec(rest)?.[0];
      if (!hex) return undefined;
      const value = Number.parseInt(hex.replace(/[{}]/g, ''), 16);
      if (value > 0x10ffff) return undefined;
      result += String.fromCodePoint(value); i += hex.length;
    } else result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[escape] ?? escape;
  }
  return result;
}
export function knownDeclaredSkips(suiteText: string, context: SkipContext = runnerSkipContext()): DeclaredSkip[] {
  const skips: DeclaredSkip[] = [];
  for (const open of suiteText.matchAll(/^if \(selected\((\d+)\) && prerequisite\((\d+), \(\) => /gm)) {
    if (open[1] !== open[2]) continue;
    const args = callArguments(suiteText, open.index! + open[0].length);
    if (args === null || args.length !== 2) continue;
    const reason = prerequisiteReason(args[1]!);
    if (reason === undefined) { skips.push({ section: Number(open[1]), reason: `section ${open[1]}'s prerequisite reason could not be read` }); continue; }
    if (conjuncts(args[0]!).some((term) => knownTerm(term, context) === false)) skips.push({ section: Number(open[1]), reason });
  }
  return skips;
}
/** Each required section known to skip here, in its words: `section 21 cannot be required here: requires POSIX`. */
export function requiredRefusals(required: readonly string[], skips: readonly DeclaredSkip[]): string[] {
  return required.flatMap((section) => {
    const skip = skips.find((candidate) => String(candidate.section) === section);
    return skip ? [`section ${section} cannot be required here: ${skip.reason}`] : [];
  });
}
export interface Options { suite: string; workers: number; splitSerial: boolean; sectionTimeout: number; wholeTimeout: number; keepLogs: boolean; noWait: boolean; snapshotFailure: boolean; requireSections: string[]; skipList: string | null }
export function parseOptions(argv: string[]): Options {
  const options: Options = { suite: path.join(HERE, 'selftest.ts'), workers: Number(process.env['DESKPOST_GATE_WORKERS'] ?? 8), splitSerial: false, sectionTimeout: 600_000, wholeTimeout: 2_700_000, keepLogs: false, noWait: false, snapshotFailure: false, requireSections: [], skipList: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--split-serial') options.splitSerial = true;
    else if (arg === '--require-sections' && argv[i + 1]) {
      const value = argv[++i]!;
      if (!/^\d+(,\d+)*$/.test(value)) throw new Error(`--require-sections takes section numbers separated by commas, such as 147,148; got '${value}'`);
      options.requireSections = value.split(',');
    }
    else if (arg === '--keep-logs') options.keepLogs = true;
    else if (arg === '--no-wait') options.noWait = true;
    else if (arg === '--test-snapshot-failure') options.snapshotFailure = true;
    else if (arg === '--suite' && argv[i + 1]) options.suite = path.resolve(argv[++i]!);
    else if (arg === '--skip-list' && argv[i + 1]) options.skipList = path.resolve(argv[++i]!);
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
  // A whole run (a compiled kernel, or --workers 1) writes one 'section whole' line, so it cannot show which sections ran.
  if (options.requireSections.length && (process.env['LIBRARY_SELFTEST_KERNEL'] || options.workers === 1 && !options.splitSerial))
    throw new Error('--require-sections needs a run by section; a compiled kernel or --workers 1 runs the suite whole');
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
    env[SECTION_MARKER] = folder;
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
    owned = descendants(rows, child.pid!, started, folder);
    const root = owned.find((row) => row.pid === child.pid);
    const expected = await identity;
    if (root && (!expected || (process.platform === 'linux' ? await startIdentity(root.pid) : root.start) !== expected || root.parentPid !== process.pid)) {
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
      try { owned = descendants(await processTable(), child.pid!, started, folder); } catch (again) { problem += `; ownership scan failed: ${again}`; }
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
        if (root && (expected === null || (process.platform === 'linux' ? await startIdentity(root.pid) : root.start) !== expected || root.parentPid !== process.pid)) {
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
  const policy = applyPlatformSkips(sectionNumbers(fs.readFileSync(options.suite, 'utf8')), suiteSkips(options));
  if (policy.line) process.stdout.write(policy.line + '\n');
  const sections = policy.sections;
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
  // Checked before any section folder is removed, so a required section that SKIPs keeps its evidence.
  const required = options.requireSections.length ? requiredSectionsVerdict(lines.join('\n'), options.requireSections) : null;
  if (required) process.stdout.write(`${required.status.toUpperCase()} gate.required-sections: ${required.detail}\n`);
  const bad = failed.length || controller.signal.aborted;
  // Keep compact per-section evidence on success too; bulky child output is needed only on failure or request.
  if (!bad && required?.status !== 'fail' && !options.keepLogs) for (const result of results) fs.rmSync(path.join(folder, String(result.section)), { recursive: true, force: true });
  if (bad) process.stderr.write(`kernel self-test FAILED (${failed.length || 1} of ${total}): ${failed.map((r) => `section ${r.section}: ${flatten(r.detail)}`).join('; ') || 'cancelled'}; evidence: ${folder}\n`);
  else process.stdout.write(`kernel self-test passed (${total} checks)${wait ? ` after waiting ${wait.seconds.toFixed(1)}s for ${wait.seat}'s ${wait.tier} gate` : ''}.\n`);
  return bad || required?.status === 'fail' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (async () => {
    const options = parseOptions(process.argv.slice(2));
    const say = (line: string) => process.stdout.write(line + '\n');
    // Before the lock and before any section: a required section that cannot pass here ends the run (kickoffs/s153 row 5).
    const refusals = requiredListRefusals(options.requireSections, fs.readFileSync(options.suite, 'utf8'), suiteSkips(options));
    for (const line of refusals) process.stderr.write(`runner: ${line}\n`);
    // Printed on every required list, before the lock (kickoffs/s169 row 6): a list that all runs is shown too.
    if (options.requireSections.length) process.stderr.write(`runner: required sections this platform runs: ${options.requireSections.filter((s) => !refusals.some((r) => r.startsWith(`section ${s} `))).join(',') || 'none'}\n`);
    if (refusals.length) return 2;
    const lock = options.workers > 1 ? await acquireGateLock('parallel self-test', options.noWait, say) : null;
    const notice = lock && gateLockOffNotice(lock);
    if (notice) say(notice);
    try { return await run(options, lock?.wait); } finally { await lock?.release(); }
  })().then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`runner: ${String(error)}\n`); process.exitCode = error instanceof LockError ? error.code : 2; });
}
