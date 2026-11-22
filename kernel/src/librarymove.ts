/** A Library move is planned from bytes; history and ambiguous paths (a match inside a longer path, on either side) are never rewritten. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { windowsProcesses } from './lifecycle.ts';
import { nativeProcessCalls, nativeProcessTable } from './win32proc.ts';
import { findWorkspaceByMarker, readMarker, registryPath, homeDirectory } from './workspace.ts';
import { relocateWorkspace } from './init.ts';
import { quoteSharedCommandPath } from './sharedwrite.ts';
import { readSeatRegistry } from './desk.ts';
import { assertNoMaintenanceBarrier, getSeatClaimState, launcherProofForThisAgent } from './seatclaim.ts';
import type { PsJsonValue } from './psjson.ts';

export interface MoveOptions {
  destination?: string; workspace?: string; registryRoot?: string; preflight: boolean;
  historyByteLimit?: number;
  destinationRule?: 'any';
  processTable?: () => MoveProcess[];
  userConfirmed?: boolean; planId?: string; resume?: string; rollback?: string;
  faultAt?: string; faultMarker?: string; faultRelease?: string;
}
export type MoveProcess = { pid: number; parentPid: number; name: string; commandLine?: string | null };

function processTable(): MoveProcess[] {
  if (process.platform === 'win32') {
    let rows: MoveProcess[] = nativeProcessCalls() ? nativeProcessTable() : windowsProcesses().map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.ExecutablePath ? path.win32.basename(row.ExecutablePath) : '' }));
    // Image paths can be denied although the image name remains readable.
    if (rows.some(row => !row.name)) {
      const names = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true }));
      for (const row of rows) if (!row.name) row.name = ([] as { Id: number; ProcessName: string }[]).concat(names).find(p => p.Id === row.pid)?.ProcessName ?? '';
      rows = rows.filter(row => {
        if (row.name || row.pid <= 4) return true;
        try { process.kill(row.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
        throw new Error(`the image name for process ${row.pid} could not be read`);
      });
    }
    const commands = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true }).trim() || '[]');
    for (const row of rows) if (/^node(?:\.exe)?$/i.test(row.name)) row.commandLine = ([] as { ProcessId: number; CommandLine: string | null }[]).concat(commands).find(p => p.ProcessId === row.pid)?.CommandLine ?? null;
    return rows;
  }
  if (process.platform !== 'linux') throw new Error('the process table is not supported on this platform');
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      let commandLine: string | null = null;
      try { commandLine = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* node without a readable command line is a writer */ }
      return [{ pid: Number(name), parentPid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), name: fs.readFileSync(`/proc/${name}/comm`, 'utf8').trim(), commandLine }];
    } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; }
  });
}

/** The command line never accepts a replacement process table. */
export function quietCheck(options: { processTable?: () => MoveProcess[]; inside_obsidian_vault?: boolean } = {}) {
  try {
    const rows = (options.processTable ?? processTable)();
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const excludedPids = new Set<number>();
    for (let pid: number | undefined = process.pid; pid && !excludedPids.has(pid); pid = byPid.get(pid)?.parentPid) excludedPids.add(pid);
    const writers = rows.filter(row => {
      if (excludedPids.has(row.pid)) return false;
      const image = row.name.toLowerCase().replace(/\.exe$/, '');
      if (image === 'node') return !row.commandLine || /(?:(?:^|[\\/\s"'])(?:cli|library)\.ts|(?:^|[\\/\s"'])library(?:\.exe)?)(?:["'\s]|$)|claude|codex|orca/i.test(row.commandLine);
      return /^(?:claude|orca|library|deskpost)$/.test(image) || image.startsWith('codex') || (image === 'obsidian' && options.inside_obsidian_vault === true);
    });
    return { writers, refusal: writers.length ? writers.map(row => `${row.name} (process ${row.pid}): close it, then run the command again`).join('\n') : null };
  } catch (error) { return { writers: [] as MoveProcess[], refusal: `The process table could not be read: ${(error as Error).message}; close the applications and repair process-table access, then run the command again` }; }
}
type ManifestEntry = { relative: string; type: 'file' | 'folder'; size: number; sha256: string };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const within = (child: string, parent: string) => {
  const key = (v: string) => process.platform === 'win32' ? v.toLowerCase() : v;
  const relative = path.relative(key(parent), key(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const excluded = (relative: string) => relative === 'internal/maintenance-barrier.json' || relative === 'internal/move-journals' || relative.startsWith('internal/move-journals/');
const longPath = (file: string) => process.platform === 'win32' && file.length > 248 ? path.toNamespacedPath(file) : file;
function pathExists(file: string) {
  try { fs.lstatSync(longPath(file)); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}
function fileDigest(file: string) {
  const handle = fs.openSync(longPath(file), 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    for (let count = fs.readSync(handle, buffer); count; count = fs.readSync(handle, buffer)) { hash.update(buffer.subarray(0, count)); size += count; }
  } finally { fs.closeSync(handle); }
  return { size, sha256: hash.digest('hex') };
}

function manifest(root: string, reasons: string[] = []): ManifestEntry[] {
  const rows: ManifestEntry[] = [];
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(longPath(path.join(root, relative)), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (excluded(name)) continue;
      const file = path.join(root, name);
      if (entry.isSymbolicLink()) { reasons.push(`${file} is a symbolic link or junction; resolve it by hand, then run the preview again`); continue; }
      try {
        if (entry.isDirectory()) { rows.push({ relative: name, type: 'folder', size: 0, sha256: '' }); visit(name); }
        else if (entry.isFile()) rows.push({ relative: name, type: 'file', ...fileDigest(file) });
        else reasons.push(`${file} is not a regular file; move it by hand, then run the preview again`);
      } catch (error) { reasons.push(`${file}: ${(error as Error).message}; repair it, then run the preview again`); }
    }
  };
  visit('');
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

const displayPath = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase());
function movePlan(options: MoveOptions, barrierRun?: string, includeWarnings = true) {
    const started = performance.now();
    const destination = options.destination ?? '';
    if (!destination) throw new Error('Run deskpost library move <destination> --preflight [--workspace <path>] [--json].');
    if (!path.isAbsolute(destination) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(destination))) throw new Error('Give a full path, such as P:\\dev\\Deskpost\\Library.');
    if (/[\u0000-\u001f\u007f]/.test(destination)) throw new Error(`${displayPath(destination)} holds a control character, which the settings files that name this Library cannot hold; choose a folder name without one`);
    if (/['"`]/.test(destination)) throw new Error(`${displayPath(destination)} holds a quote character, which the settings files that name this Library cannot hold unescaped; choose a folder name without quotes`);
    const root = options.workspace ? path.resolve(options.workspace) : findWorkspaceByMarker(process.cwd());
    if (!root || !readMarker(root)) throw new Error('No Library marker found. Run inside a Library, or give --workspace <path>.');
    const target = path.resolve(destination);
    let ancestor = target;
    while (!pathExists(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`${displayPath(ancestor)} is unavailable; mount the drive or choose an available destination, then run the preview again`);
      ancestor = parent;
    }
    if (!fs.statSync(ancestor).isDirectory()) throw new Error(`${displayPath(ancestor)} is a file; choose a destination under a folder`);
    const resolvedTarget = path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, target));
    const resolvedRoot = fs.realpathSync.native(root);
    if (within(resolvedTarget, resolvedRoot) || within(resolvedRoot, resolvedTarget)) throw new Error(`Choose a folder outside ${root}; neither folder may contain the other.`);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Choose a new folder, or empty it first.');
    if (options.destinationRule !== 'any' && process.platform === 'win32' && target.slice(path.parse(target).root.length).split(path.sep)[0]?.toLowerCase() !== 'dev') throw new Error(`New folders go under a drive's dev folder (Eric, 2026-10-17): use ${displayPath(path.parse(target).root)}dev\\<name>.`);
    if (!barrierRun) assertNoMaintenanceBarrier(root, 'library move');
    else if (JSON.parse(fs.readFileSync(path.join(root, 'internal/maintenance-barrier.json'), 'utf8')).run_id !== barrierRun) throw new Error('The maintenance barrier changed; inspect the move journal before continuing');
    const warnings: string[] = [];
    const stateDirectory = path.join(root, '.claude');
    const busy = readSeatRegistry(stateDirectory).filter(({ seat }) => {
      const claim = getSeatClaimState(stateDirectory, seat);
      return claim.state !== 'free' && launcherProofForThisAgent(stateDirectory, seat) !== 'held';
    });
    if (busy.length) warnings.push(`the move will refuse until these are closed: ${busy.map(row => row.seat).join(', ')}; close each session first`);
    const reasons: string[] = [];
    if (!pathExists(path.join(root, 'internal'))) reasons.push(`${path.join(root, 'internal')} is missing; create it as an empty folder, then run the preview again`);
    else if (fs.lstatSync(path.join(root, 'internal')).isSymbolicLink() || !fs.statSync(path.join(root, 'internal')).isDirectory()) reasons.push(`${path.join(root, 'internal')} is not a folder; move it aside and create an empty folder named internal, then run the preview again`);
    const sourceManifest = manifest(root, reasons);
    const recorded = recordedPaths(root, options.registryRoot, target, reasons);
    if (includeWarnings) {
      const quiet = quietCheck({ processTable: options.processTable, inside_obsidian_vault: recorded.vault !== null });
      if (quiet.refusal) warnings.push('the move will refuse until these are closed: ' + quiet.refusal);
    }
    const expectedManifest = sourceManifest.map(row => {
      const pointer = recorded.pointers.find(p => p.file === path.join(root, row.relative) && p.newBytes);
      return pointer?.newBytes ? { ...row, size: pointer.newBytes.length, sha256: digest(pointer.newBytes) } : row;
    });
    const stat = fs.statfsSync(ancestor, { bigint: true });
    const free = stat.bavail * stat.bsize;
    const bytes = sourceManifest.reduce((sum, row) => sum + row.size, 0);
    const room = free >= BigInt(Math.max(bytes, expectedManifest.reduce((sum, row) => sum + row.size, 0)));
    if (!room) reasons.push(`${displayPath(ancestor)} has insufficient free space; free space or choose another destination, then run the preview again`);
    const planId = digest(JSON.stringify({ root, target, sourceManifest, pointers: recorded.pointers.map(({ file, sha256, occurrences, ambiguous, newBytes }) => ({ file, sha256, occurrences, ambiguous, output: newBytes ? digest(newBytes) : null })) }));
    return { root, target, sourceManifest, expectedManifest, recorded, warnings, reasons, bytes, room, free: Number(free), planId, seconds: (performance.now() - started) / 1000 };
}

type SavedPointer = { file: string; before: string; after: string; priorSha: string; outputSha: string };
type MoveJournal = {
  schema: 1; run_id: string; root: string; target: string; staging: string; aside: string; directory: string;
  sourceManifest: ManifestEntry[]; expectedManifest: ManifestEntry[]; insideVault: boolean;
  registryRoot: string; registryFile: string; registryBefore: string; registryOutputSha: string; registryRow: { path: string; id: string };
  pointers: SavedPointer[]; programPointers: { relative: string; after: string }[]; listed: string[];
  steps: Record<string, 'intent' | 'done'>; state: string; emptyDestination: boolean;
  rollbackManifest?: ManifestEntry[];
  rollbackCommitted?: boolean;
};
type MoveResult = { refusal: string | null; value: PsJsonValue | null; humanText?: string };

/** Stage beside the file, flush its bytes, then replace with a single filesystem rename. */
function atomic(file: string, bytes: Buffer | string, mode = pathExists(file) ? fs.statSync(longPath(file)).mode & 0o7777 : 0o600) {
  fs.mkdirSync(longPath(path.dirname(file)), { recursive: true });
  const temporary = longPath(file + `.move-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const handle = fs.openSync(temporary, 'wx', mode);
  try { fs.writeFileSync(handle, bytes); fs.fchmodSync(handle, mode); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, longPath(file));
}
function saveJournal(journal: MoveJournal) {
  const bytes = JSON.stringify(journal, null, 2) + '\n';
  atomic(path.join(journal.directory, 'journal.json'), bytes, 0o600);
  const copy = path.join(journal.target, 'internal/move-journals', journal.run_id);
  // Keep the completed copy current without recreating a destination renamed by rollback.
  if (journal.state === 'complete' && journal.steps['journal-copy'] === 'done' && fs.existsSync(copy)) atomic(path.join(copy, 'journal.json'), bytes, 0o600);
}
function barrier(root: string, runId: string) {
  if (!pathExists(path.join(root, 'internal'))) throw new Error(`${path.join(root, 'internal')} is missing; create it as an empty folder, then run the preview again`);
  if (fs.lstatSync(path.join(root, 'internal')).isSymbolicLink() || !fs.statSync(path.join(root, 'internal')).isDirectory()) throw new Error(`${path.join(root, 'internal')} is not a folder; move it aside and create an empty folder named internal, then run the preview again`);
  const file = path.join(root, 'internal/maintenance-barrier.json');
  if (fs.existsSync(file)) {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).run_id !== runId) throw new Error(`${file} belongs to another run; inspect its journal before continuing`);
    return;
  }
  atomic(file, JSON.stringify({ run_id: runId, operation: 'Library move', reason: 'A Library move is in progress' }) + '\n');
}
/** Before a run's first step, refuse when a barrier it would place names another run, so nothing is written; barrier() keeps its own check. */
function refuseForeignBarriers(roots: (string | null)[], runId: string) {
  for (const root of roots) {
    const file = root && path.join(root, 'internal/maintenance-barrier.json');
    if (file && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).run_id !== runId) throw new Error(`${file} belongs to another run; inspect its journal before continuing`);
  }
}
function liftBarrier(root: string, runId: string) {
  const file = path.join(root, 'internal/maintenance-barrier.json');
  if (!fs.existsSync(file)) return;
  if (JSON.parse(fs.readFileSync(file, 'utf8')).run_id !== runId) throw new Error(`${file} belongs to another run; inspect its journal before continuing`);
  fs.unlinkSync(file); // Only this run's maintenance flag; reader files are retained.
}
function verifyTree(root: string, expected: ManifestEntry[]) {
  const reasons: string[] = [];
  const actual = manifest(root, reasons);
  const wanted = new Map(expected.map(row => [row.relative, JSON.stringify(row)]));
  const seen = new Set(actual.map(row => row.relative));
  const changed = actual.filter(row => wanted.get(row.relative) !== JSON.stringify(row)).map(row => row.relative);
  changed.push(...expected.filter(row => !seen.has(row.relative)).map(row => row.relative), ...reasons);
  if (changed.length) throw new Error(`${root} differs from its manifest: ${changed.join(', ')}; keep both trees and inspect these files before recovery`);
}
function requireQuiet(journal: Pick<MoveJournal, 'insideVault'>, options: MoveOptions) {
  const quiet = quietCheck({ processTable: options.processTable, inside_obsidian_vault: journal.insideVault });
  if (quiet.refusal) throw new Error(quiet.refusal);
}
function obsidianVault(root: string, unreadable?: (file: string, error: unknown) => void): string | null {
  for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
    const file = path.join(folder, '.obsidian');
    try { if (fs.statSync(file).isDirectory()) return folder; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { if (unreadable) unreadable(file, error); else throw error; }
    }
    if (path.dirname(folder) === folder) return null;
  }
}
function fault(options: MoveOptions, point: string) {
  if (options.faultAt !== point) return;
  if (options.faultMarker) {
    fs.writeFileSync(options.faultMarker, point);
    // A fixture child waits here until its parent kills it. Never accepted from argv.
    while (!options.faultRelease || !fs.existsSync(options.faultRelease)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    return;
  }
  throw new Error('Injected move fault at ' + point);
}
function step(journal: MoveJournal, name: string, effect: () => void, options: MoveOptions) {
  journal.steps[name] = 'intent'; saveJournal(journal);
  fault(options, name + ':before');
  effect();
  fault(options, name + ':before-done');
  journal.steps[name] = 'done'; saveJournal(journal);
  fault(options, name + ':after-done');
}
function copyTree(journal: MoveJournal, options: MoveOptions) {
  fs.mkdirSync(longPath(journal.staging), { recursive: true });
  for (const entry of journal.sourceManifest) {
    const from = longPath(path.join(journal.root, entry.relative)), to = longPath(path.join(journal.staging, entry.relative));
    if (entry.type === 'folder') { fs.mkdirSync(to, { recursive: true }); continue; }
    fs.mkdirSync(longPath(path.dirname(to)), { recursive: true });
    if (options.faultAt === 'copy-file:before-done') {
      const bytes = fs.readFileSync(from); fs.writeFileSync(to, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      fault(options, 'copy-file:before-done');
    }
    for (let attempt = 0; ; attempt++) {
      try { fs.copyFileSync(from, to); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error(`${from} could not be copied after three retries: ${(error as Error).message}; close its reader, then roll back this move`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      }
    }
  }
  for (const pointer of journal.programPointers) atomic(path.join(journal.staging, pointer.relative), Buffer.from(pointer.after, 'base64'));
  barrier(journal.staging, journal.run_id);
}
function listOnce(journal: MoveJournal, text: string) { if (!journal.listed.includes(text)) journal.listed.push(text); }
function finishMove(journal: MoveJournal, options: MoveOptions) {
  requireQuiet(journal, options);
  step(journal, 'cutover', () => {
    if (fs.existsSync(journal.aside)) {
      if (fs.existsSync(journal.root)) throw new Error(`${journal.root} and ${journal.aside} both exist; inspect the move journal before recovery`);
      verifyTree(journal.aside, journal.sourceManifest); return;
    }
    verifyTree(journal.root, journal.sourceManifest);
    fs.renameSync(longPath(journal.root), longPath(journal.aside));
  }, options);
  requireQuiet(journal, options);
  for (const [index, pointer] of journal.pointers.entries()) step(journal, 'pointer-' + index, () => {
    let actual = '';
    try { if (!fs.lstatSync(pointer.file).isSymbolicLink()) actual = digest(fs.readFileSync(pointer.file)); } catch { /* drift is left and listed */ }
    if (actual === pointer.outputSha) return;
    if (actual !== pointer.priorSha) { listOnce(journal, `${pointer.file}: changed since the preview; left as written`); return; }
    atomic(pointer.file, Buffer.from(pointer.after, 'base64'));
    if (digest(fs.readFileSync(pointer.file)) !== pointer.outputSha) throw new Error(`${pointer.file} did not read back; resume or roll back this move`);
  }, options);
  requireQuiet(journal, options);
  step(journal, 'registry', () => {
    const current = fs.readFileSync(journal.registryFile);
    if (digest(current) === journal.registryOutputSha) return;
    if (digest(current) !== digest(Buffer.from(journal.registryBefore, 'base64'))) throw new Error(`the registry row for ${journal.root} changed since the preview; run the preview again after recovering this move`);
    relocateWorkspace(journal.registryRoot, journal.registryRow, journal.target);
    if (digest(fs.readFileSync(journal.registryFile)) !== journal.registryOutputSha) throw new Error('The registry relocation did not read back; resume or roll back this move');
  }, options);
  step(journal, 'verify', () => { verifyTree(journal.aside, journal.sourceManifest); verifyTree(journal.target, journal.expectedManifest); }, options);
  step(journal, 'complete', () => { liftBarrier(journal.target, journal.run_id); }, options);
  step(journal, 'journal-copy', () => {
    const copy = path.join(journal.target, 'internal/move-journals', journal.run_id);
    fs.mkdirSync(copy, { recursive: true, mode: 0o700 }); fs.chmodSync(copy, 0o700);
    for (const [index, file] of fs.readdirSync(journal.directory).entries()) {
      atomic(path.join(copy, file), fs.readFileSync(path.join(journal.directory, file)), 0o600);
      if (index === 0) fault(options, 'journal-copy:file');
    }
  }, options);
  journal.state = 'complete'; saveJournal(journal);
}
function moveValue(journal: MoveJournal): MoveResult {
  return { refusal: null, value: { operation: 'Library move', run_id: journal.run_id, state: journal.state, workspace: journal.target, aside: journal.aside, journal: journal.directory, left_and_listed: journal.listed, written: true,
    rollback: `deskpost library move --rollback ${journal.run_id} --preflight` },
    humanText: `Library moved to ${journal.target}. The source stays at ${journal.aside}.\n${journal.listed.join('\n')}\nRollback preview: deskpost library move --rollback ${journal.run_id} --preflight` };
}

export function moveLibrary(options: MoveOptions): MoveResult {
  if (options.resume || options.rollback) return recoverMove(options);
  if (options.preflight) return previewLibraryMove(options);
  if (!options.userConfirmed) return { refusal: `run the preview first: deskpost library move ${options.destination ?? '<destination>'} --preflight`, value: null };
  let journal: MoveJournal | undefined;
  try {
    const insideVault = obsidianVault(options.workspace ?? findWorkspaceByMarker(process.cwd()) ?? process.cwd()) !== null;
    requireQuiet({ insideVault }, options);
    const plan = movePlan(options, undefined, false);
    if (within(fs.realpathSync.native(process.cwd()), fs.realpathSync.native(plan.root))) throw new Error(`run it from a folder outside ${plan.root}`);
    if (plan.reasons.length) throw new Error(plan.reasons.join('\n'));
    if (options.planId !== plan.planId) throw new Error('the Library changed since the preview; run the preview again');
    const registryFile = registryPath(options.registryRoot), registryBefore = fs.readFileSync(registryFile);
    const registryDocument = JSON.parse(registryBefore.toString('utf8')) as { workspaces: { path: string; id: string }[] };
    const registryRow = registryDocument.workspaces.find(row => row.path === plan.root);
    if (!registryRow || registryRow.id !== readMarker(plan.root)?.['id']) throw new Error(`the registry row for ${plan.root} changed since the preview; run the preview again`);
    const runId = 'move-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    const directory = path.join(path.dirname(registryFile), 'move-journals', runId);
    if (within(directory, plan.root) || within(directory, plan.target)) throw new Error('The move journal must be outside both trees; choose an outside --registry-root before previewing');
    refuseForeignBarriers([plan.root, plan.target], runId);
    const priorRow = { ...registryRow }; registryRow.path = plan.target;
    journal = { schema: 1, run_id: runId, root: plan.root, target: plan.target, staging: plan.target + '.partial-' + runId, aside: plan.root + '.moved-' + runId,
      directory, sourceManifest: plan.sourceManifest, expectedManifest: plan.expectedManifest, insideVault: plan.recorded.vault !== null,
      registryRoot: path.dirname(registryFile), registryFile, registryBefore: registryBefore.toString('base64'), registryOutputSha: digest(JSON.stringify(registryDocument, null, 2) + '\n'), registryRow: priorRow,
      pointers: [], programPointers: [], listed: [], steps: {}, state: 'phase-a', emptyDestination: fs.existsSync(plan.target) };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    for (const pointer of plan.recorded.pointers) {
      if (pointer.ambiguous || pointer.reason) journal.listed.push(`${pointer.file}: ${pointer.ambiguous} ambiguous occurrences; ${pointer.reason ?? 'left as written'}`);
      if (!pointer.newBytes || !pointer.occurrences) continue;
      if (pointer.rewrite === 'program' && within(pointer.file, plan.root)) journal.programPointers.push({ relative: path.relative(plan.root, pointer.file), after: pointer.newBytes.toString('base64') });
      if (pointer.rewrite === 'eric' || pointer.rewrite === 'orca') {
        const before = fs.readFileSync(pointer.file);
        if (digest(before) !== pointer.sha256) { journal.listed.push(`${pointer.file}: changed since the preview; left as written`); continue; }
        journal.pointers.push({ file: pointer.file, before: before.toString('base64'), after: pointer.newBytes.toString('base64'), priorSha: digest(before), outputSha: digest(pointer.newBytes) });
      }
    }
    saveJournal(journal);
    atomic(path.join(directory, 'source-manifest.json'), JSON.stringify(plan.sourceManifest));
    atomic(path.join(directory, 'destination-manifest.json'), JSON.stringify(plan.expectedManifest));
    atomic(path.join(directory, 'registry-before'), registryBefore);
    for (const [index, pointer] of journal.pointers.entries()) atomic(path.join(directory, 'pointer-' + index + '-before'), Buffer.from(pointer.before, 'base64'));
    step(journal, 'barrier', () => {
      barrier(plan.root, runId);
      try { if (movePlan(options, runId, false).planId !== plan.planId) throw new Error('the Library changed since the preview; run the preview again'); }
      catch (error) { liftBarrier(plan.root, runId); throw error; }
    }, options);
    step(journal, 'copy', () => copyTree(journal!, options), options);
    step(journal, 'copy-verify', () => { verifyTree(journal!.staging, journal!.expectedManifest); verifyTree(journal!.root, journal!.sourceManifest); }, options);
    step(journal, 'promote', () => {
      if (journal!.emptyDestination) fs.renameSync(journal!.target, journal!.target + '.empty-' + journal!.run_id);
      fs.renameSync(longPath(journal!.staging), longPath(journal!.target));
    }, options);
    finishMove(journal, options);
    return moveValue(journal);
  } catch (error) {
    let recovery = '';
    if (journal) {
      journal.state = fs.existsSync(journal.aside) ? 'phase-b-failed' : 'phase-a-failed';
      try { saveJournal(journal); if (fs.existsSync(journal.aside)) { barrier(journal.aside, journal.run_id); if (fs.existsSync(journal.target)) barrier(journal.target, journal.run_id); } }
      catch (recordError) { recovery += `\nThe recovery record could not be updated: ${(recordError as Error).message}; keep every copy and inspect ${journal.directory}`; }
      recovery += `\n${journal.state === 'phase-b-failed' ? `deskpost library move --resume ${journal.run_id} --user-confirmed\n` : ''}deskpost library move --rollback ${journal.run_id} --preflight`;
    }
    return { refusal: (error as Error).message + recovery, value: null };
  }
}

function readMoveJournal(options: MoveOptions): MoveJournal {
  const id = options.resume ?? options.rollback ?? '';
  if (!/^move-[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error('Give the run id printed by the move; preview the rollback with --rollback <run-id> --preflight');
  const directory = path.join(path.dirname(registryPath(options.registryRoot)), 'move-journals', id);
  const journal = JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'), 'utf8')) as MoveJournal;
  if (journal.schema !== 1 || journal.run_id !== id || journal.directory !== directory || journal.aside !== journal.root + '.moved-' + id || journal.staging !== journal.target + '.partial-' + id || within(journal.root, journal.target) || within(journal.target, journal.root)) throw new Error('The move journal is inconsistent; inspect it before recovery');
  for (const row of [...journal.sourceManifest, ...journal.expectedManifest, ...(journal.rollbackManifest ?? [])]) {
    if (path.isAbsolute(row.relative) || row.relative.split(/[\\/]/).includes('..')) throw new Error('The move manifest has an unsafe path; inspect the journal before recovery');
  }
  for (const pointer of journal.pointers) if (digest(Buffer.from(pointer.before, 'base64')) !== pointer.priorSha || digest(Buffer.from(pointer.after, 'base64')) !== pointer.outputSha) throw new Error(`${pointer.file}: saved pointer bytes do not match their hashes; inspect the journal before recovery`);
  return journal;
}
function recoveryLocations(journal: MoveJournal) {
  const rolled = journal.target + '.rolled-back-' + journal.run_id;
  const emptyAside = journal.target + '.empty-' + journal.run_id;
  const targetIsOriginalEmpty = journal.emptyDestination && fs.existsSync(journal.target) && !fs.readdirSync(journal.target).length && (!journal.steps['promote'] || fs.existsSync(journal.staging) || (fs.existsSync(rolled) && !fs.existsSync(emptyAside)));
  const destination = !targetIsOriginalEmpty && fs.existsSync(journal.target) ? journal.target : fs.existsSync(rolled) ? rolled : fs.existsSync(journal.staging) ? journal.staging : null;
  const source = fs.existsSync(journal.aside) ? journal.aside : fs.existsSync(journal.root) ? journal.root : null;
  if (!source || (fs.existsSync(journal.aside) && fs.existsSync(journal.root))) throw new Error('The source tree location is unclear; inspect the move journal before recovery');
  if (fs.existsSync(journal.target) && !targetIsOriginalEmpty && fs.existsSync(rolled)) throw new Error('Both destination copies exist; inspect the move journal before recovery');
  return { rolled, emptyAside, destination, source };
}
function recoverySnapshot(journal: MoveJournal) {
  const locations = recoveryLocations(journal);
  const trees = [journal.root, journal.aside, journal.target, journal.staging, locations.rolled, locations.emptyAside].map(root => {
    if (!fs.existsSync(root)) return { root, manifest: null };
    const reasons: string[] = []; const rows = manifest(root, reasons); return { root, manifest: rows, reasons };
  });
  const hashFile = (file: string) => { try { return digest(fs.readFileSync(file)); } catch { return 'unreadable'; } };
  return digest(JSON.stringify({ journal, trees, registry: hashFile(journal.registryFile), pointers: journal.pointers.map(row => [row.file, hashFile(row.file)]) }));
}
function verifyRecovery(journal: MoveJournal) {
  const locations = recoveryLocations(journal);
  const committed = locations.source === journal.aside || journal.steps['cutover'] === 'done' || journal.rollbackCommitted === true;
  if (committed) verifyTree(locations.source, journal.sourceManifest);
  if (locations.destination && locations.destination !== journal.staging) verifyTree(locations.destination, journal.rollbackManifest ?? journal.expectedManifest);
  return locations;
}
/** One key for a registry row's path, used by the rollback's judgement and its readback alike: an alias of a path is that path. */
const registryKey = (value: unknown) => process.platform === 'win32' ? path.resolve(String(value)).toLowerCase() : path.resolve(String(value));
function rollbackMove(journal: MoveJournal, options: MoveOptions, validated: () => void) {
  const locations = verifyRecovery(journal); // Refusals here change no bytes, including barriers and the journal.
  if (journal.state === 'rolled-back') return;
  const registryBytes = fs.readFileSync(journal.registryFile), registryBefore = Buffer.from(journal.registryBefore, 'base64');
  let registryState: 'before' | 'output' | 'moved' | 'restored';
  if (digest(registryBytes) === digest(registryBefore)) registryState = 'before';
  else if (digest(registryBytes) === journal.registryOutputSha) registryState = 'output';
  else {
    const rows = (JSON.parse(registryBytes.toString('utf8')) as { workspaces: Record<string, unknown>[] }).workspaces;
    const movedRows = rows.filter(row => registryKey(row['path']) === registryKey(journal.target));
    const sourceRows = rows.filter(row => registryKey(row['path']) === registryKey(journal.root));
    if (!movedRows.length && sourceRows.length === 1 && sourceRows[0]!['id'] === journal.registryRow.id) registryState = 'restored';
    else if (movedRows.length === 1 && !sourceRows.length && JSON.stringify(movedRows[0]) === JSON.stringify({ ...journal.registryRow, path: journal.target })) registryState = 'moved';
    else throw new Error('The moved registry row changed; inspect it before retrying the rollback');
  }
  refuseForeignBarriers([locations.source, locations.destination], journal.run_id);
  validated();
  journal.rollbackCommitted ??= locations.source === journal.aside || journal.steps['cutover'] === 'done';
  step(journal, 'rollback-barriers', () => {
    barrier(locations.source, journal.run_id);
    if (locations.destination && journal.rollbackCommitted) barrier(locations.destination, journal.run_id);
  }, options);
  if (!journal.rollbackManifest && locations.destination) {
    const reasons: string[] = []; journal.rollbackManifest = manifest(locations.destination, reasons);
    if (reasons.length) throw new Error(reasons.join('\n')); saveJournal(journal);
  }
  step(journal, 'rollback-destination', () => {
    const current = recoveryLocations(journal);
    if (current.destination === current.rolled || !current.destination) return;
    verifyTree(current.destination, journal.rollbackManifest!);
    fs.renameSync(longPath(current.destination), longPath(current.rolled));
  }, options);
  step(journal, 'rollback-source', () => {
    const current = recoveryLocations(journal);
    if (current.source === journal.root) return;
    verifyTree(journal.aside, journal.sourceManifest);
    fs.renameSync(longPath(journal.aside), longPath(journal.root));
    verifyTree(journal.root, journal.sourceManifest);
  }, options);
  step(journal, 'rollback-registry', () => {
    if (registryState === 'before') return;
    if (registryState === 'output') atomic(journal.registryFile, registryBefore);
    else if (registryState === 'moved') relocateWorkspace(journal.registryRoot, { path: journal.target, id: journal.registryRow.id }, journal.root);
    const rows = (JSON.parse(fs.readFileSync(journal.registryFile, 'utf8')) as { workspaces: { path: string; id: string }[] }).workspaces;
    if (!rows.some(row => registryKey(row.path) === registryKey(journal.root) && row.id === journal.registryRow.id) || rows.some(row => registryKey(row.path) === registryKey(journal.target))) throw new Error('The restored registry did not read back; inspect it before retrying the rollback');
  }, options);
  for (const [index, pointer] of journal.pointers.entries()) step(journal, 'rollback-pointer-' + index, () => {
    let actual = '';
    try { if (!fs.lstatSync(pointer.file).isSymbolicLink()) actual = digest(fs.readFileSync(pointer.file)); } catch { /* drift stays untouched */ }
    if (actual === pointer.priorSha) return;
    if (actual !== pointer.outputSha) { listOnce(journal, `${pointer.file}: changed after the move; left as written`); return; }
    atomic(pointer.file, Buffer.from(pointer.before, 'base64'));
    if (digest(fs.readFileSync(pointer.file)) !== pointer.priorSha) throw new Error(`${pointer.file}: restored bytes did not read back; retry the rollback`);
  }, options);
  step(journal, 'rollback-empty', () => {
    const current = recoveryLocations(journal);
    if (fs.existsSync(current.emptyAside) && !fs.existsSync(journal.target)) fs.renameSync(current.emptyAside, journal.target);
  }, options);
  step(journal, 'rollback-complete', () => { liftBarrier(journal.root, journal.run_id); }, options);
  journal.state = 'rolled-back'; saveJournal(journal);
}
function recoverMove(options: MoveOptions): MoveResult {
  let active: MoveJournal | undefined;
  try {
    if (options.resume && options.rollback) throw new Error('Choose --resume or --rollback, then preview that recovery');
    const journal = readMoveJournal(options);
    const locations = verifyRecovery(journal);
    const planId = recoverySnapshot(journal);
    if (options.preflight) return { refusal: null, value: { operation: options.rollback ? 'Library move rollback preview' : 'Library move resume preview', run_id: journal.run_id, plan_id: planId, written: false, source: locations.source, destination: locations.destination, nothing_deleted: true },
      humanText: `Nothing is deleted. Recovery keeps a copy at ${locations.rolled}.\ndeskpost library move --${options.rollback ? 'rollback' : 'resume'} ${journal.run_id} --user-confirmed --plan-id ${planId}` };
    if (!options.userConfirmed || (options.rollback && !options.planId)) throw new Error(`Run deskpost library move --${options.rollback ? 'rollback' : 'resume'} ${journal.run_id} --preflight, then its --user-confirmed --plan-id command`);
    if (options.planId && options.planId !== planId) throw new Error('The recovery changed since the preview; run the recovery preview again');
    if ([journal.root, journal.target, journal.aside, journal.staging, locations.rolled].some(root => within(fs.realpathSync.native(process.cwd()), root))) throw new Error(`run it from a folder outside ${journal.root} and its move copies`);
    requireQuiet(journal, options);
    if (options.rollback) rollbackMove(journal, options, () => { active = journal; });
    else {
      if (locations.source !== journal.aside || locations.destination !== journal.target || journal.state === 'rolled-back') throw new Error('Only a move past its commit point can resume; run its --rollback <run-id> --preflight instead');
      refuseForeignBarriers([journal.aside, journal.target], journal.run_id);
      active = journal;
      step(journal, 'resume-barriers', () => { barrier(journal.aside, journal.run_id); barrier(journal.target, journal.run_id); }, options);
      finishMove(journal, options);
    }
    const value = moveValue(journal);
    if (options.rollback) {
      value.humanText = `Library restored to ${journal.root}. The move copy stays at ${locations.rolled}.\n${journal.listed.join('\n')}`;
      value.value = { operation: 'Library move rollback', state: journal.state, run_id: journal.run_id, workspace: journal.root, retained: locations.rolled, left_and_listed: journal.listed, written: true };
    }
    return value;
  } catch (error) {
    if (active) {
      try {
        const actual = recoveryLocations(active);
        barrier(actual.source, active.run_id);
        if (actual.destination && active.rollbackCommitted !== false && actual.destination !== active.staging) barrier(actual.destination, active.run_id);
      } catch (recordError) { return { refusal: `${(error as Error).message}\nThe recovery barriers could not be updated: ${(recordError as Error).message}; keep every copy and inspect ${active.directory} before recovery.`, value: null }; }
    }
    return { refusal: `${(error as Error).message}\nRecovery stopped; keep every copy and run the same recovery preview again.`, value: null };
  }
}

export function previewLibraryMove(options: MoveOptions): { refusal: string | null; value: PsJsonValue | null; humanText?: string } {
  const no = (refusal: string) => ({ refusal, value: null });
  const destination = options.destination ?? '';
  if (!destination) return no('Run deskpost library move <destination> --preflight [--workspace <path>] [--json].');
  if (!path.isAbsolute(destination) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(destination))) {
    return no('Give a full path, such as P:\\dev\\Deskpost\\Library.');
  }
  if (!options.preflight) return no(`run the preview first: deskpost library move ${destination} --preflight`);
  try {
    const plan = movePlan(options);
    const { root, target, recorded } = plan;
    const history = historyPaths(root, options.historyByteLimit ?? 8 * 1024 * 1024);
    const value = { operation: 'Library move preview', workspace: root, destination: target, written: false,
      history: history.history, history_skipped: history.history_skipped, history_unreadable: history.history_unreadable,
      pointers: recorded.pointers.map(({ newBytes: _new, ...row }) => row), inside_obsidian_vault: recorded.vault !== null, obsidian_vault: recorded.vault,
      plan_id: plan.planId, executable: !plan.reasons.length, not_executable_reasons: plan.reasons, warnings: plan.warnings,
      source_manifest: plan.sourceManifest, expected_destination_manifest: plan.expectedManifest,
      files: plan.sourceManifest.filter(row => row.type === 'file').length, bytes: plan.bytes, seconds: plan.seconds, destination_free_bytes: plan.free, room: plan.room,
      cwd_inside_library: within(process.cwd(), root), search_limits: recorded.didNotSearch };
    return { refusal: null, value, humanText: `Library move preview: ${root} -> ${target}. Nothing was written.\n` +
      (process.platform === 'win32' ? '' : "The drive's dev folder check does not apply on this platform.\n") +
      `Obsidian vault above the Library: ${recorded.vault ?? 'none found'}.\n` +
      `Current folder inside the Library: ${value.cwd_inside_library ? 'yes; run the move from outside it' : 'no'}.\n` +
      recorded.humanText + '\n' + history.humanText + '\n' + recorded.didNotSearch + '\n' +
      [...plan.warnings, ...plan.reasons].join('\n') + `\n${value.files} files; ${plan.bytes} bytes; ${plan.seconds.toFixed(2)} seconds; ${plan.free} bytes free.\n` +
      `deskpost library move ${quoteSharedCommandPath(target)} --workspace ${quoteSharedCommandPath(root)} --user-confirmed --plan-id ${plan.planId}` };
  } catch (error) {
    return no(`${(error as Error).message} Check the named path or record, repair it, then run the preview again.`);
  }
}

type Pointer = { place: string; file: string; occurrences: number; ambiguous: number; rewrite: string; reason?: string; sha256?: string; newBytes?: Buffer };

function recordedPaths(root: string, registryRoot?: string, destination = root, reasons: string[] = []) {
  const pointers: Pointer[] = [];
  const matches = pathCounter(root);
  const unknown = (place: string, file: string, error: unknown) => pointers.push({ place, file, rewrite: 'unknown', occurrences: 0, ambiguous: 0, reason: String((error as Error).message ?? error) });
  const inspect = (place: string, file: string, rewrite: string) => {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) { unknown(place, file, 'Symbolic link left unread; check its target separately.'); return; }
      const bytes = fs.readFileSync(file);
      const binary = /\.db$/i.test(file);
      const format = binary ? 'binary' : /\.json$/i.test(file) ? 'json' : /\.toml$/i.test(file) ? 'toml' : 'text';
      let counts: PathCount;
      try { counts = matches(bytes, destination, format); }
      catch {
        counts = matches(bytes, destination, 'binary');
        if (!counts.occurrences && !counts.ambiguous) return;
        const reason = `${file} is not valid UTF-8; change it by hand or remove the path, then run the preview again`;
        reasons.push(reason); pointers.push({ place, file, rewrite, occurrences: counts.occurrences, ambiguous: counts.ambiguous, reason, sha256: digest(bytes) }); return;
      }
      const { reason, notExecutable, ...count } = counts;
      // A file the counter refuses (plan D5.2, D5.3) is listed with its reason and stops the move, as a file that is not UTF-8 does.
      if (notExecutable) {
        const refused = `${file}: ${notExecutable}`;
        reasons.push(refused);
        pointers.push({ place, file, rewrite, ...count, reason: reason ? `${reason}; ${notExecutable}` : notExecutable, sha256: digest(bytes) }); return;
      }
      if (counts.occurrences || counts.ambiguous) pointers.push({ place, file, rewrite, ...count, sha256: digest(bytes),
        ...(binary ? { reason: 'open the workspace again in Orca after the move' } : reason ? { reason } : {}) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown(place, file, error);
    }
  };
  const entries = (place: string, folder: string): fs.Dirent[] => {
    try { return fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown(place, folder, error); return []; }
  };
  const walkAgents = (folder: string) => {
    for (const entry of entries('Library agent files', folder)) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walkAgents(file); else inspect('Library agent files', file, 'program');
    }
  };
  inspect('Machine Library registry', registryPath(registryRoot), 'program');
  for (const relative of ['.mcp.json', '.codex/config.toml', '.codex/hooks.json', '.claude/settings.json', '.claude/settings.local.json']) {
    inspect('Library configuration', path.join(root, relative), 'program');
  }
  walkAgents(path.join(root, '.agents'));
  const home = homeDirectory();
  for (const relative of ['.claude/settings.json', '.claude.json', '.codex/config.toml']) inspect('Home configuration', path.join(home, relative), 'eric');
  if (process.platform === 'win32' && process.env['APPDATA']) {
    const orca = path.join(process.env['APPDATA'], 'orca');
    for (const profile of entries('Orca profiles', path.join(orca, 'claude-profiles'))) {
      if (!profile.isDirectory()) continue;
      for (const relative of ['.claude.json', '.claude/settings.json', 'CLAUDE.md']) {
        inspect('Orca profile', path.join(orca, 'claude-profiles', profile.name, 'home', relative), 'orca');
      }
    }
    for (const entry of entries('Orca stores', orca)) if (/\.(json|db)$/i.test(entry.name)) inspect('Orca store', path.join(orca, entry.name), 'orca');
  }
  const vault = obsidianVault(root, (file, error) => { unknown('Obsidian vault check', file, error); });
  const didNotSearch = 'Not searched: other homes, other application stores, other drives, remote services, and files outside the named locations. Symbolic links are not followed.';
  const humanText = ['program', 'eric', 'orca', 'unknown'].flatMap(rewrite => {
    const rows = pointers.filter(row => row.rewrite === rewrite);
    return rows.length ? [`Who may rewrite: ${rewrite}`, ...rows.map(row => `${row.place}: ${row.file}: ${row.occurrences} occurrences; ${row.ambiguous} ambiguous${row.reason ? '; ' + row.reason : ''}`)] : [];
  }).concat('Check any rewritten value whose earlier text is not a command word: a relative folder named like an option, or ending in a space or a quote, before the Library path is rewritten too.').join('\n');
  return { pointers, vault, didNotSearch, humanText };
}

/** What pathCounter found in one file: occurrences it would rewrite, ambiguous ones it lists, the new bytes (never for a .db
 * file or a refused one), a reason to list beside the counts, and a reason the move must refuse the file (plan D5.2, D5.3). */
export type PathCount = { occurrences: number; ambiguous: number; newBytes?: Buffer; reason?: string; notExecutable?: string };

const ESCAPED_REASON = 'the old path is written here with an escaped character; change it by hand';
const RESIDUE_REASON = 'the old path may be written here in a form the move cannot read; change it by hand, then run the preview again';
const COLLISION_REASON = 'two keys would become one; merge them by hand';

export function pathCounter(root: string) {
  const fold = (text: string) => process.platform !== 'win32' ? text : Array.from(text, char => {
    const lower = char.toLowerCase(); return lower.length === char.length && Array.from(lower).length === 1 ? lower : char;
  }).join('');
  const pattern = () => new RegExp(fold(root).split(/[\\/]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'), 'g');
  const leading = (value: string) => /^[\\/]*/.exec(value)![0].length;
  // The first path in its value: no / or \ before it there; between it and the nearest whitespace, quote or the value's start,
  // nothing, an option, a variable or a tool pattern (D1.4, D1.5).
  const starts = (prior: string) => !/[\\/]/.test(prior) &&
    /^(?:|--?[A-Za-z][A-Za-z0-9-]*=|[A-Za-z_][A-Za-z0-9_]*=|[A-Za-z][A-Za-z0-9]*\()$/.test(/[^\s"'`]*$/u.exec(prior)![0]);
  return (bytes: Buffer, destination = root, format: 'json' | 'toml' | 'text' | 'binary' = 'text'): PathCount => {
    const binary = format === 'binary';
    // A .db file is counted, never rewritten; its bytes are read as UTF-8 (a broken sequence reads as U+FFFD, which ends a
    // run), so the case-fold on Windows compares letters, not Latin-1 bytes (D1.1, plan r6).
    const text = binary ? bytes.toString('utf8') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // Nothing that continues a path after it (D1.7); undefined is the end of the value.
    const ends = (next: string | undefined) => next === undefined || (binary ? !/[a-z0-9_. -]/i.test(next) : /[\\/"'<>|*?\r\n\t]/.test(next));
    let occurrences = 0, ambiguous = 0, escapedCharacter = false;
    const edits: { start: number; end: number; text: string }[] = [];
    const strings = format === 'json' ? jsonStrings(text) : format === 'toml' ? tomlStrings(text) : null;
    if (format === 'text' || binary) {
      // The value is the line (in binary, the run of printable bytes); no escapes, so the raw text is the decoded text.
      for (const match of fold(text).matchAll(pattern())) {
        const start = match.index!, end = start + match[0].length;
        let from = start;
        if (binary) while (from > 0 && /[\x20-\x7e]/.test(text[from - 1]!)) from--;
        else from = text.lastIndexOf('\n', start - 1) + 1;
        if (!starts(text.slice(from, start)) || leading(match[0]) > leading(root) || !ends(text[end])) { ambiguous++; continue; }
        occurrences++;
        const original = text.slice(start, end);
        edits.push({ start, end, text: original.includes('\\\\') ? destination.replace(/[\\/]/g, '\\\\') : original.includes('\\') ? destination.replace(/[\\/]/g, '\\') : destination.replace(/\\/g, '/') });
      }
    } else {
      // A raw match not wholly inside one string (outside any, crossing a string's end, or anywhere in a file the scanner
      // cannot read) is ambiguous; one inside a string is judged on the string's decoded text below, so a raw run that only
      // looks like the path (\root/library: a \r escape, then oot/library) is no occurrence (D1.1, D1.2).
      for (const match of fold(text).matchAll(pattern())) {
        const start = match.index!, end = start + match[0].length;
        if (!strings?.some(span => span.start <= start && end <= span.end)) ambiguous++;
      }
      for (const span of strings ?? []) {
        const value = decodeString(text, span);
        for (const match of fold(value.text).matchAll(pattern())) {
          const start = match.index!, end = start + match[0].length;
          // An escape outside the format's table, or malformed, before the occurrence leaves its value unread (D1.3).
          if (value.unreadFrom < start || !starts(value.text.slice(0, start)) || leading(match[0]) > leading(root) || !ends(value.text[end])) { ambiguous++; continue; }
          // The occurrence's own raw characters: a separator written as an escape (\\ for \, and in JSON \/ for /) keeps it
          // a path; any other escape makes it ambiguous, listed with its reason (D1.3).
          let slashEscape = false, doubled = false, single = false, escaped = false;
          for (let i = start; i < end; i++) {
            const raw = text.slice(value.from[i], value.to[i]);
            if (raw === '\\') single = true;
            else if (raw.length === 1) continue;
            else if (raw === '\\\\' && value.text[i] === '\\') doubled = true;
            else if (raw === '\\/' && span.kind === 'json') slashEscape = true;
            else escaped = true;
          }
          if (escaped) { ambiguous++; escapedCharacter = true; continue; }
          occurrences++;
          // The occurrence keeps its slash form, read from its raw text as in a text file (a literal string's backslashes
          // too); a JSON span written with \/ is rewritten with \/ for every separator (D1.8).
          const rawStart = value.from[start]!, rawEnd = value.to[end - 1]!;
          edits.push({ start: rawStart, end: rawEnd, text: slashEscape ? destination.replace(/[\\/]/g, '\\/')
            : doubled || text.slice(rawStart, rawEnd).includes('\\\\') ? destination.replace(/[\\/]/g, '\\\\') : single ? destination.replace(/[\\/]/g, '\\') : destination.replace(/\\/g, '/') });
        }
      }
    }
    const listed = escapedCharacter ? { reason: ESCAPED_REASON } : {};
    // A TOML file the scanner cannot read (three quotes in a row) holding the path, raw or after every transform a basic
    // string applies, is refused: the move cannot tell where the path is written (D5.2).
    if (format === 'toml' && !strings && (ambiguous || fold(tomlResidue(text)).search(pattern()) >= 0)) return { occurrences, ambiguous, ...listed, notExecutable: RESIDUE_REASON };
    if (binary) return { occurrences, ambiguous, ...listed };
    let output = '', cursor = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) { output += text.slice(cursor, edit.start) + edit.text; cursor = edit.end; }
    output += text.slice(cursor);
    // A rewritten key that would equal another key of its object (JSON) or of the file (TOML, read without its tables, so
    // it leans to refusing) is refused: two keys would become one (D5.3).
    if (format !== 'text' && edits.length && keysCollide(text, output, format)) return { occurrences, ambiguous, ...listed, notExecutable: COLLISION_REASON };
    return { occurrences, ambiguous, ...listed, newBytes: Buffer.from(output) };
  };
}

// One string's decoded text, with each decoded UTF-16 unit's raw span (from, to) in the file. An escape outside the format's
// table, or malformed, reads as U+FFFD and sets unreadFrom, the first decoded index it covers (Infinity when none).
function decodeString(text: string, span: StringSpan) {
  const json = new Map([['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
  const toml = new Map([['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['"', '"'], ['\\', '\\'], ['e', '\x1b']]);
  const out = { text: '', from: [] as number[], to: [] as number[], unreadFrom: Infinity };
  const put = (decoded: string, from: number, to: number) => { for (const unit of decoded.split('')) { out.text += unit; out.from.push(from); out.to.push(to); } };
  for (let i = span.start; i < span.end;) {
    if (span.kind === 'literal' || text[i] !== '\\') { put(text[i]!, i, i + 1); i++; continue; }
    const letter = text[i + 1] ?? '', simple = (span.kind === 'json' ? json : toml).get(letter);
    if (simple !== undefined) { put(simple, i, i + 2); i += 2; continue; }
    const width = span.kind === 'json' ? (letter === 'u' ? 4 : 0) : ({ x: 2, u: 4, U: 8 } as Record<string, number>)[letter] ?? 0;
    const hex = text.slice(i + 2, i + 2 + width);
    const code = width && new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex) ? parseInt(hex, 16) : -1;
    // JSON's \u names one UTF-16 unit (a lone surrogate decodes to itself); TOML's escapes name a Unicode scalar value.
    if (code >= 0 && (span.kind === 'json' || (code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)))) {
      put(span.kind === 'json' ? String.fromCharCode(code) : String.fromCodePoint(code), i, i + 2 + width); i += 2 + width; continue;
    }
    out.unreadFrom = Math.min(out.unreadFrom, out.text.length);
    put('\ufffd', i, Math.min(i + 2, span.end)); i += 2;
  }
  return out;
}

// D5.2's second reading of a TOML file the scanner cannot read: every transform a basic string applies, across the whole
// file (a line-ending backslash with the whitespace and line breaks after it removed, then each escape decoded). It may find
// the path where TOML would not, never the reverse, since the raw text is searched too.
function tomlResidue(text: string): string {
  const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
  return text.replace(/\\(?:[ \t]*\r?\n[ \t\r\n]*|x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([btnfr"\\e]))/g, (all, x?: string, u?: string, long?: string, letter?: string) => {
    if (letter) return simple[letter]!;
    const hex = x ?? u ?? long;
    if (hex === undefined) return '';
    const code = parseInt(hex, 16);
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all;
  });
}

// D5.3: whether a rewrite makes two keys one. Keys are the strings in key places (in JSON, before a colon; in TOML, before =
// or . or a table header's ]), decoded; a JSON key's scope is its object, a TOML key's the whole file. Two keys collide when
// a rewritten key's new text is shared, in its scope, by keys whose old texts differ.
function keysCollide(before: string, after: string, format: 'json' | 'toml'): boolean {
  const keys = (text: string) => {
    const spans = format === 'json' ? jsonStrings(text) : tomlStrings(text);
    if (!spans) return null;
    const found: { scope: number; text: string }[] = [];
    const stack: number[] = []; let objects = 0, cursor = 0;
    for (const span of spans) {
      if (format === 'json') {
        for (; cursor < span.start - 1; cursor++) {
          const char = text[cursor];
          if (char === '{' || char === '[') stack.push(char === '{' ? ++objects : -1); else if (char === '}' || char === ']') stack.pop();
        }
        cursor = span.end + 1;
      }
      const next = (format === 'json' ? /^\s*(.?)/ : /^[ \t]*(.?)/).exec(text.slice(span.end + 1))![1];
      const header = /^[ \t]*\[/.test(text.slice(text.lastIndexOf('\n', span.start) + 1, span.start));
      if (format === 'json' ? next === ':' : next === '=' || next === '.' || (next === ']' && header)) {
        const raw = text.slice(span.start, span.end);
        found.push({ scope: format === 'json' ? stack.at(-1) ?? 0 : 0, text: (span.kind === 'json' ? jsonDecode(raw) : span.kind === 'toml' ? tomlDecode(raw) : raw) ?? raw });
      }
    }
    return { count: spans.length, found };
  };
  const old = keys(before), now = keys(after);
  if (!old || !now || old.count !== now.count || old.found.length !== now.found.length) return true;
  const groups = new Map<string, Set<string>>();
  now.found.forEach((key, i) => { const id = key.scope + '\u0000' + key.text; groups.set(id, (groups.get(id) ?? new Set()).add(old.found[i]!.text)); });
  return now.found.some((key, i) => key.text !== old.found[i]!.text && groups.get(key.scope + '\u0000' + key.text)!.size > 1);
}

// A string's text between its quotes, and how its escapes read: JSON, a TOML basic string, or a TOML literal string (none).
type StringSpan = { start: number; end: number; kind: 'json' | 'toml' | 'literal' };

// JSON's escapes (RFC 8259 section 7): \" \\ \/ \b \f \n \r \t, and \u with four hex digits, one UTF-16 code unit (a lone
// surrogate decodes to itself). Any other escape, or a malformed one, is undecodable (null).
function jsonDecode(raw: string): string | null {
  const simple = new Map([['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const letter = raw[++i] ?? '', hex = raw.slice(i + 1, i + 5);
    if (simple.has(letter)) out += simple.get(letter);
    else if (letter === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
    else return null;
  }
  return out;
}

// TOML basic strings' escapes (1.0, plus 1.1's \e and \x): \b \t \n \f \r \" \\ \e, \x with two hex digits, \u with four and
// \U with eight, each naming a Unicode scalar value (no surrogate, nothing above U+10FFFF). Any other escape, or a malformed
// one, is undecodable (null).
function tomlDecode(raw: string): string | null {
  const simple = new Map([['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['"', '"'], ['\\', '\\'], ['e', '\x1b']]);
  const widths = new Map([['x', 2], ['u', 4], ['U', 8]]);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const letter = raw[++i] ?? '', width = widths.get(letter) ?? 0, hex = raw.slice(i + 1, i + 1 + width);
    if (simple.has(letter)) { out += simple.get(letter); continue; }
    const code = width && new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex) ? parseInt(hex, 16) : -1;
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code); i += width;
  }
  return out;
}

// JSON strings: outside one, " opens a string; inside, \ escapes the next character and an unescaped " closes it. An
// unclosed string leaves the whole file unread (null).
function jsonStrings(text: string): StringSpan[] | null {
  const spans: StringSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    const start = ++i;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) return null;
    spans.push({ start, end: i, kind: 'json' });
  }
  return spans;
}

// TOML strings, line by line: basic "..." (with \ escapes) and literal '...'; # outside a string ends the line, and a string
// unclosed at its line's end or the file's end leaves the file unread. Three quotes in a row anywhere (a multiline string) leave the file unread (null).
function tomlStrings(text: string): StringSpan[] | null {
  if (/"""|'''/.test(text)) return null;
  const spans: StringSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote === '#') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (quote !== '"' && quote !== "'") continue;
    const start = ++i;
    while (i < text.length && text[i] !== quote && text[i] !== '\n' && text[i] !== '\r') {
      i += quote === '"' && text[i] === '\\' && text[i + 1] !== '\n' && text[i + 1] !== '\r' ? 2 : 1;
    }
    if (text[i] !== quote) return null;
    spans.push({ start, end: i, kind: quote === '"' ? 'toml' : 'literal' });
  }
  return spans;
}

function historyPaths(root: string, limit: number) {
  const counts = new Map<string, number>(), skipped = new Map<string, number>();
  const unreadable: { file: string; reason: string }[] = [];
  const matches = pathCounter(root);
  const visit = (folder: string, group: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { unreadable.push({ file: folder, reason: (error as Error).message }); return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      const key = folder === root ? entry.isDirectory() ? entry.name : '.' : folder === path.join(root, 'internal') && entry.isDirectory() ? 'internal/' + entry.name : group;
      if (entry.isSymbolicLink()) { unreadable.push({ file, reason: 'Symbolic link left unread; check its target separately.' }); continue; }
      if (entry.isDirectory()) { visit(file, key); continue; }
      if (!entry.isFile()) continue;
      try {
        if (fs.statSync(file).size > limit) { skipped.set(key, (skipped.get(key) ?? 0) + 1); continue; }
        const bytes = fs.readFileSync(file);
        const format = /\.db$/i.test(file) ? 'binary' : /\.json$/i.test(file) ? 'json' : /\.toml$/i.test(file) ? 'toml' : 'text';
        let hits: ReturnType<ReturnType<typeof pathCounter>>;
        try { hits = matches(bytes, root, format); } catch { hits = matches(bytes, root, 'binary'); }
        if (hits.occurrences || hits.ambiguous) counts.set(key, (counts.get(key) ?? 0) + 1);
      } catch (error) { unreadable.push({ file, reason: (error as Error).message }); }
    }
  };
  visit(root, '.');
  const rows = (map: Map<string, number>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([folder, files]) => ({ folder, files }));
  return { history: rows(counts), history_skipped: rows(skipped), history_unreadable: unreadable,
    humanText: [...rows(counts).map(row => `History: ${row.folder}: ${row.files} files; left as written and readable by their old path in the aside copy.`),
      ...rows(skipped).map(row => `History skipped: ${row.folder}: ${row.files} files larger than ${limit} bytes; not read.`),
      ...unreadable.map(row => `History unreadable: ${row.file}: ${row.reason}`)].join('\n') };
}
