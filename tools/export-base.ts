/**
 * A SCANNED BASE FOR ANOTHER OFFICE (kickoffs/s158 row 6; PLAN-cross-office-build-loop.md step 2.3):
 *
 *   node tools/export-base.ts --base <sha> --to <folder> --for <id> [--repo <dir>] [--term-root <dir>]
 *
 * The allowlisted tree of <sha> (tools/PublicTreeAllowlist.ps1, read as scan.ts's productFiles reads it) is taken from git
 * objects, never the working tree, and written into a fresh staging repository under the system temp folder (`git init`,
 * `git add -A`, so the scans that read index blobs have an index to read). There it is scanned in the public export's
 * order (tools/Export-PublicTree.ps1): (a) the identity scan with this machine's denylist, which refuses when the
 * denylist is missing and never downgrades to contributor mode; (b) the deployment scan; (c) gitleaks over the files and
 * the staged index (`scan.ts --secrets`). Each must cover something. A finding refuses naming the file, the line and the
 * scan, never a denylisted term, and the staging folder is discarded. Only then are the scanned bytes copied to <to>,
 * which must not exist, each checked by SHA-256 against the staging copy, and committed once as a root commit with
 * core.hooksPath=.githooks, beside `.deskpost-export.json` (kept out of the commit by `.git/info/exclude`).
 * `--repo` (default this checkout) and `--term-root` (default `~/.library`) are for fixtures.
 * Exit 0 exported, 1 refused, 2 the export itself failed.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryNeutralEnv } from '../kernel/src/gitenv.ts';
import { deploymentScan, identityScan, secretsScan } from './scan.ts';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node tools/export-base.ts --base <sha> --to <folder> --for <id> [--repo <dir>] [--term-root <dir>]';
const AUTHOR = ['-c', 'user.name=Deskpost export', '-c', 'user.email=export@deskpost.invalid'];

export class Refusal extends Error {}
interface Entry { mode: string; oid: string; file: string }

/** An export on a share may have another owner. Trust only its canonical path, for this call alone. */
export function destinationGitArgs(folder: string, args: string[]): string[] {
  return ['-c', `safe.directory=${fs.realpathSync.native(folder).replace(/\\/g, '/')}`, ...args];
}

function git(cwd: string, args: string[], input?: Buffer | string, destination = false): Buffer {
  const ran = spawnSync('git', destination ? destinationGitArgs(cwd, args) : args, { cwd, env: repositoryNeutralEnv(), input, windowsHide: true, maxBuffer: 1 << 30, timeout: 300_000 });
  if (ran.error || ran.status !== 0) throw Error(`git ${args.join(' ')} failed: ${ran.error?.message ?? ran.stderr.toString().trim()}`);
  return ran.stdout;
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The public allowlist's three lists, read from its PowerShell source as scan.ts's productFiles reads them. */
export function allowlist(): (file: string) => boolean {
  const oracle = fs.readFileSync(path.join(TOOLS, 'PublicTreeAllowlist.ps1'), 'utf8');
  const list = (name: string) => {
    const block = new RegExp('\\$script:' + name + ' = @\\(([\\s\\S]*?)\\n\\)').exec(oracle)?.[1];
    if (!block) throw Error(`Cannot read canonical allowlist ${name}`);
    return [...block.matchAll(/^\s*'((?:[^']|'')*)'\s*,?\s*(?:#.*)?$/gm)].map((match) => match[1]!.replaceAll("''", "'"));
  };
  const directories = list('PublicTreeIncludeDirectories'), files = list('PublicTreeIncludeFiles');
  const deny = list('PublicTreeDenyPatterns').map((rule) => new RegExp(rule, 'i'));
  return (file) => (files.includes(file) || directories.some((folder) => file.startsWith(`${folder}/`))) && !deny.some((rule) => rule.test(file));
}

/** The allowlisted blobs of `base`, with their bytes, from one `git cat-file --batch`. */
function treeOf(repo: string, base: string): { entry: Entry; bytes: Buffer }[] {
  const allowed = allowlist();
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', base]).toString('utf8').split('\0').filter(Boolean).flatMap((line) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    if (!match) throw Error(`git ls-tree printed a line this tool cannot read: ${line}`);
    const entry = { mode: match[1]!, oid: match[3]!, file: match[4]! };
    if (!allowed(entry.file)) return [];
    if (match[2] !== 'blob' || entry.mode === '120000') throw new Refusal(`${entry.file} is a ${entry.mode === '120000' ? 'symbolic link' : match[2]}, which this export does not carry`);
    return [entry];
  });
  if (!entries.length) throw new Refusal(`no allowlisted file in ${base}, so there is nothing to export`);
  const out = git(repo, ['cat-file', '--batch'], entries.map((entry) => entry.oid).join('\n') + '\n');
  let at = 0;
  return entries.map((entry) => {
    const end = out.indexOf(0x0a, at);
    const size = Number(/ blob (\d+)$/.exec(out.subarray(at, end).toString('latin1'))?.[1]);
    if (!Number.isInteger(size)) throw Error(`git cat-file --batch did not return ${entry.file}'s blob`);
    const bytes = out.subarray(end + 1, end + 1 + size);
    at = end + 1 + size + 1;
    return { entry, bytes };
  });
}

/** Write the files and make them one repository's index; executables keep their mode in the index and, off Windows, on disk. */
function writeRepository(folder: string, files: { entry: Entry; bytes: Buffer }[], destination = false): void {
  for (const { entry, bytes } of files) {
    const target = path.join(folder, ...entry.file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
  git(folder, ['init', '-q'], undefined, destination);
  git(folder, ['config', 'core.autocrlf', 'false'], undefined, destination);
  git(folder, ['add', '-A'], undefined, destination);
  const executables = files.filter(({ entry }) => entry.mode === '100755').map(({ entry }) => entry.file);
  if (executables.length) git(folder, ['update-index', '--chmod=+x', '--', ...executables], undefined, destination);
}

const covered = (detail: string, rule: RegExp, scan: string): number => {
  const count = Number(rule.exec(detail)?.[1] ?? 0);
  if (!(count > 0)) throw new Refusal(`the ${scan} scan covered nothing, so it proved nothing: ${detail}`);
  return count;
};

/** The three scans over the staging repository; a finding refuses naming the file, the line and the scan only. */
function scan(staging: string, termRoot: string, files: number): Record<string, Record<string, number>> {
  // CONTRIBUTOR MODE NEVER APPLIES HERE: a missing denylist refuses (the plan's step 2.3).
  delete process.env['LIBRARY_IDENTITY_SCAN'];
  const identity = identityScan(staging, '', termRoot);
  if (identity.status === 'fail' && !identity.hits.length) throw new Refusal('the identity scan found no denylist in its term root, so nothing was scanned for this machine\'s identity');
  const deployment = deploymentScan(staging);
  const secrets = secretsScan(staging);
  const findings = [
    ...identity.hits.map((hit) => `identity scan: ${hit.source}:${hit.line}`),
    ...deployment.hits.map((hit) => `deployment scan: ${hit.file}:${hit.line} [${hit.kind}]`),
    ...(secrets.status === 'fail' ? [`secrets scan: ${secrets.detail}`] : []),
  ];
  if (findings.length) throw new Refusal(`${findings.length} finding(s): ${[...new Set(findings)].join('; ')}`);
  const staged = git(staging, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean).length;
  if (!(staged > 0 && files > 0)) throw new Refusal('the secrets scan covered nothing, so it proved nothing');
  return {
    identity: { staged_blobs: covered(identity.detail, /^(\d+) staged blob/, 'identity') },
    deployment: { product_documents: covered(deployment.detail, /^(\d+) staged product document/, 'deployment') },
    secrets: { files, staged_blobs: staged },
  };
}

export function exportBase(options: { base: string; to: string; id: string; repo: string; termRoot: string }): Record<string, unknown> {
  const to = path.resolve(options.to);
  if (fs.existsSync(to)) throw new Refusal(`${to} already exists; an export is written only into a new folder`);
  const base = git(options.repo, ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`]).toString().trim();
  const files = treeOf(options.repo, base);
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-export-')));
  let written = false;
  try {
    writeRepository(staging, files);
    const scans = scan(staging, options.termRoot, files.length);
    fs.mkdirSync(to, { recursive: true });
    written = true;
    for (const { entry } of files) {
      const from = fs.readFileSync(path.join(staging, ...entry.file.split('/')));
      const target = path.join(to, ...entry.file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, from, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      if (sha256(fs.readFileSync(target)) !== sha256(from)) throw Error(`the copy of ${entry.file} did not hash back to the staging copy`);
    }
    writeRepository(to, files.map(({ entry }) => ({ entry, bytes: fs.readFileSync(path.join(to, ...entry.file.split('/'))) })), true);
    git(to, [...AUTHOR, 'commit', '-q', '-m', `Deskpost base ${base.slice(0, 12)} for ${options.id}`], undefined, true);
    git(to, ['config', 'core.hooksPath', '.githooks'], undefined, true);
    const manifest = { private_base: base, export_root: git(to, ['rev-parse', 'HEAD'], undefined, true).toString().trim(), exported: new Date().toISOString(), kickoff: options.id, files: files.length, scans };
    fs.writeFileSync(path.join(to, '.deskpost-export.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.appendFileSync(path.join(to, '.git', 'info', 'exclude'), '.deskpost-export.json\n');
    const left = git(to, ['status', '--porcelain'], undefined, true).toString().trim();
    if (left) throw Error(`the export's tree does not equal its commit: ${left.split('\n').slice(0, 5).join(' | ')}`);
    return manifest;
  } catch (error) {
    if (written) fs.rmSync(to, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main(args: string[]): number {
  const value: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    if (!['--base', '--to', '--for', '--repo', '--term-root'].includes(name) || i + 1 >= args.length) throw new Refusal(`unknown or incomplete argument ${name}; ${USAGE}`);
    value[name] = args[i + 1]!;
  }
  if (!value['--base'] || !value['--to'] || !value['--for']) throw new Refusal(USAGE);
  const manifest = exportBase({
    base: value['--base'], to: value['--to'], id: value['--for'],
    repo: path.resolve(value['--repo'] ?? path.join(TOOLS, '..')),
    termRoot: path.resolve(value['--term-root'] ?? path.join(process.env['USERPROFILE'] || os.homedir(), '.library')),
  });
  process.stdout.write(`exported ${manifest['files']} files to ${path.resolve(value['--to'])}\n${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    const refused = error instanceof Refusal;
    process.stderr.write(`export-base ${refused ? 'refused' : 'failed'}: ${error instanceof Error ? error.message : String(error)}. The staging folder was discarded and nothing was exported.\n`);
    process.exitCode = refused ? 1 : 2;
  }
}
