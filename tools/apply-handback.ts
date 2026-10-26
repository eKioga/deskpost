/** Apply one cross-office generation, checked against the integrator's Kickoff and Handback letter.
 * Usage: node tools/apply-handback.ts <folder> --base <private sha> --export-root <sha>
 *   --letter notes/<page> --onto int/<id>
 * The letter has exactly one fenced JSON block under ## Manifest:
 * {generation, head, cover:{name,sha256}, patches:[{name,sha256}, ...]}.
 * No share value grants authority. All git input after the snapshot is local. No gate is run here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { repositoryNeutralEnv } from '../kernel/src/gitenv.ts';
import { answerReaderTool } from '../kernel/src/reader.ts';
import { requireWorkspace } from '../kernel/src/workspace.ts';
import { deskStateDirectory, resolveSeatName } from '../kernel/src/seatdesk.ts';

type Entry = { name: string; sha256: string };
export type Manifest = { generation: string; head: string; cover: Entry; patches: Entry[] };
export type ApplyOptions = { folder: string; base: string; exportRoot: string; letter: string; onto: string; cwd?: string };
const USAGE = 'Usage: node tools/apply-handback.ts <folder> --base <private sha> --export-root <sha> --letter notes/<page> --onto int/<id>';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function plainName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..') || /[.]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`${what} is not a plain name: ${String(value)}`);
  }
}

function manifestValue(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest must be an object');
  const m = value as Manifest;
  plainName(m.generation, 'manifest generation');
  if (typeof m.head !== 'string' || !/^[a-f0-9]{40}$/.test(m.head)) throw new Error('manifest head must be a full commit SHA');
  const entry = (e: Entry | undefined): void => {
    if (!e || typeof e !== 'object') throw new Error('manifest patch entry must have name and sha256');
    plainName(e.name, 'manifest filename');
    if (!e.name.endsWith('.patch')) throw new Error(`manifest patch has no .patch suffix: ${e.name}`);
    if (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error(`manifest hash is not SHA-256: ${e.name}`);
  };
  entry(m.cover);
  if (!Array.isArray(m.patches) || m.patches.length === 0) throw new Error('manifest patches must be a nonempty ordered array');
  const names = new Set([m.cover.name.toLowerCase()]);
  for (const patch of m.patches) {
    entry(patch);
    if (patch.name.toLowerCase() === m.cover.name.toLowerCase()) throw new Error(`cover letter listed as a commit patch: ${patch.name}`);
    if (names.has(patch.name.toLowerCase())) throw new Error(`manifest duplicates patch: ${patch.name}`);
    names.add(patch.name.toLowerCase());
  }
  return m;
}

export function letterManifest(text: string): Manifest {
  const sections = [...text.matchAll(/^## Manifest\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  if (sections.length !== 1) throw new Error('Handback letter must have exactly one ## Manifest section');
  const blocks = [...sections[0]![1]!.matchAll(/^```json\s*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error('Handback letter Manifest must have exactly one fenced json block');
  return manifestValue(JSON.parse(blocks[0]![1]!));
}

/** Open a plain regular file without following a link; retain the descriptor while reading its bytes. */
function regularBytes(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()) throw new Error(`link refused: ${path.basename(file)}`);
  if (!before.isFile()) throw new Error(`non-file refused: ${path.basename(file)}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const after = fs.lstatSync(file);
    if (!opened.isFile() || after.isSymbolicLink() || opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== opened.ino || after.dev !== opened.dev) {
      throw new Error(`file changed or became a link while copying: ${path.basename(file)}`);
    }
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function directory(folder: string, label: string): string {
  const info = fs.lstatSync(folder);
  if (info.isSymbolicLink()) throw new Error(`link refused: ${label}`);
  if (!info.isDirectory()) throw new Error(`not a directory: ${label}`);
  return fs.realpathSync(folder);
}

/** Only this function reads the share. Validate every name before copying anything to staging. */
export function snapshotGeneration(folder: string, trusted: Manifest, stagingParent: string = os.tmpdir()): string {
  const root = directory(path.resolve(folder), 'handback folder');
  const current = regularBytes(path.join(root, 'CURRENT')).toString('utf8').replace(/\r?\n$/, '');
  plainName(current, 'CURRENT');
  manifestValue(trusted);
  if (current !== trusted.generation) throw new Error(`CURRENT names ${current}; letter manifest names ${trusted.generation}`);
  const source = path.join(root, current);
  const resolved = directory(source, current);
  if (path.dirname(resolved) !== root) throw new Error(`generation outside handback folder: ${current}`);
  const names = fs.readdirSync(resolved).sort();
  if (!names.includes('MANIFEST.json')) throw new Error('generation missing MANIFEST.json');
  const folded = new Set<string>();
  for (const name of names) {
    plainName(name, 'generation filename');
    if (folded.has(name.toLowerCase())) throw new Error(`generation duplicate filename: ${name}`);
    folded.add(name.toLowerCase());
    const stat = fs.lstatSync(path.join(resolved, name));
    if (stat.isSymbolicLink()) throw new Error(`link refused: ${name}`);
    if (!stat.isFile()) throw new Error(`generation entry is not a regular file: ${name}`);
  }
  // Validate manifest paths before any copy, then validate the copied manifest again below.
  const sourceManifest = manifestValue(JSON.parse(regularBytes(path.join(resolved, 'MANIFEST.json')).toString('utf8')));
  if (!isDeepStrictEqual(sourceManifest, trusted)) throw new Error('generation manifest differs from Handback letter manifest');
  const stage = fs.mkdtempSync(path.join(stagingParent, 'deskpost-handback-'));
  try {
    for (const name of names) {
      // Reject a generation-directory swap before reading through it.
      if (directory(source, current) !== resolved) throw new Error(`generation changed while copying: ${current}`);
      fs.writeFileSync(path.join(stage, name), regularBytes(path.join(source, name)), { flag: 'wx' });
    }
    return stage;
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}

function verifySnapshot(stage: string, trusted: Manifest, exportRoot: string): void {
  const copied = manifestValue(JSON.parse(fs.readFileSync(path.join(stage, 'MANIFEST.json'), 'utf8')));
  if (!isDeepStrictEqual(copied, trusted)) throw new Error('copied manifest differs from Handback letter manifest');
  const expected = new Set([trusted.cover.name, ...trusted.patches.map(p => p.name)]);
  for (const name of fs.readdirSync(stage)) {
    if (/\.patch$/i.test(name) && !expected.has(name)) throw new Error(`extra .patch file: ${name}`);
  }
  for (const entry of [trusted.cover, ...trusted.patches]) {
    const file = path.join(stage, entry.name);
    if (!fs.existsSync(file)) throw new Error(`missing listed patch: ${entry.name}`);
    const actual = sha(fs.readFileSync(file));
    if (actual !== entry.sha256) throw new Error(`hash mismatch ${entry.name}: expected ${entry.sha256}; actual ${actual}`);
  }
  const cover = fs.readFileSync(path.join(stage, trusted.cover.name), 'utf8');
  const bases = [...cover.matchAll(/^base-commit: ([a-f0-9]{40})\r?$/gm)].map(m => m[1]);
  if (bases.length !== 1 || bases[0] !== exportRoot) throw new Error(`cover ${trusted.cover.name} base-commit: ${bases.join(',') || 'missing'}; expected ${exportRoot}`);
  if (/^diff --git /m.test(cover)) throw new Error(`cover letter contains a commit patch: ${trusted.cover.name}`);
  for (const patch of trusted.patches) {
    const text = fs.readFileSync(path.join(stage, patch.name), 'utf8');
    if (!/^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001\r?$/m.test(text) || !/^diff --git /m.test(text)) throw new Error(`not a commit patch (possibly a cover letter): ${patch.name}`);
  }
}

async function readLetter(page: string): Promise<string> {
  if (!/^notes\/[a-z0-9][a-z0-9-]*$/.test(page)) throw new Error('--letter must name notes/<page> in this Library letters Book');
  const workspace = requireWorkspace({});
  const stateDirectory = path.join(workspace, '.claude');
  // A seated tool has an explicit environment address. Resolve that address without process discovery.
  const seat = process.env['LIBRARY_SEAT']?.trim();
  if (!seat) throw new Error('Handback letter read needs the integrator session LIBRARY_SEAT');
  const resolved = resolveSeatName({ seat });
  if (resolved.status !== 'named') throw new Error(resolved.message);
  const values: Record<string, string> = { slug: 'letters', page, place: 'shelf' };
  const answer = await answerReaderTool({ workspace, stateDirectory, deskDirectory: deskStateDirectory(stateDirectory, resolved.seat!), seatMessage: '' }, 'read_open_book_page', {
    required: name => { if (!values[name]) throw new Error(`missing reader argument ${name}`); return values[name]!; },
    optional: name => values[name],
  });
  return answer.text;
}

export async function applyHandback(options: ApplyOptions, observer: { afterSnapshot?: () => void } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (!/^[a-f0-9]{40}$/.test(options.base) || !/^[a-f0-9]{40}$/.test(options.exportRoot)) throw new Error('--base and --export-root must be full commit SHAs');
  if (!/^int\/[a-z0-9][a-z0-9-]*$/.test(options.onto)) throw new Error('--onto must name int/<id>');
  const git = (...args: string[]): string => {
    const run = spawnSync('git', args, { cwd, env: repositoryNeutralEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
    if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.error?.message ?? ''}${run.stderr}${run.stdout}`);
    return run.stdout.trimEnd();
  };
  const checkBase = (): void => {
    const branch = git('symbolic-ref', '--short', 'HEAD');
    const tip = git('rev-parse', 'HEAD');
    if (branch !== options.onto || tip !== options.base) throw new Error(`${options.onto} must be checked out at --base ${options.base}; checked out ${branch} tip ${tip}`);
    if (git('status', '--porcelain').trim()) throw new Error('integration working tree and index must be clean');
    if (fs.existsSync(path.resolve(cwd, git('rev-parse', '--git-path', 'rebase-apply')))) throw new Error('an unfinished git am is present; resolve it before applying a handback');
  };
  checkBase();
  const trusted = letterManifest(await readLetter(options.letter));
  const stage = snapshotGeneration(options.folder, trusted);
  try {
    observer.afterSnapshot?.();
    verifySnapshot(stage, trusted, options.exportRoot);
    checkBase();
    process.stdout.write(`Verified generation ${trusted.generation}; ${trusted.patches.length} commit patches\n`);
    git('am', '-3', '--', ...trusted.patches.map(p => path.join(stage, p.name)));
    for (const commit of git('rev-list', '--reverse', `${options.base}..HEAD`).split('\n').filter(Boolean)) process.stdout.write(`Applied ${commit}\n`);
    process.stdout.write(git('diff', '--no-ext-diff', '--no-textconv', `${options.base}..HEAD`) + '\n');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [folder, ...args] = process.argv.slice(2);
    if (!folder || folder.startsWith('-') || args.length !== 8) throw new Error(USAGE);
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!; const value = args[i + 1]!;
      if (!['--base', '--export-root', '--letter', '--onto'].includes(flag) || flags.has(flag) || !value || value.startsWith('--')) throw new Error(USAGE);
      flags.set(flag, value);
    }
    await applyHandback({ folder, base: flags.get('--base')!, exportRoot: flags.get('--export-root')!, letter: flags.get('--letter')!, onto: flags.get('--onto')! });
  } catch (error) { process.stderr.write(`apply-handback: ${(error as Error).message}\n`); process.exitCode = 1; }
}
