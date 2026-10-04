/**
 * A RELEASE'S BYTES ARE ITS COMMIT'S BLOBS (S74 row 0, the 2026-09-30 CRLF Report and S47).
 *
 * Measured on the published 1.2.3: the Linux archive's `library` launcher and the `install.sh` beside it carry CR
 * bytes (182 in `install.sh`) that their blobs do not. The cause was the publish clone, not the build: the clone of
 * `Kioga/deskpost` ran with this machine's `core.autocrlf=true`, the public tree has no `.gitattributes`, so every
 * text file was checked out CRLF, and `tools/Build-KernelRelease.ps1` copied the working tree as it found it. The old
 * archive audit compared the archives against that same working tree, so it agreed with the defect.
 *
 * So both checks compare against the one thing a checkout's configuration cannot change, the blob:
 *
 *   - `--tree`: the build's input. Every file the release will carry, the installers included, must hash (as a git
 *     blob, raw bytes, no filters) to the commit's blob at that path. The build refuses otherwise.
 *   - `--release`: the build's output. Every entry of every archive named in SHA256SUMS, and every loose file beside
 *     them, must be byte-equal to the blob at the commit its `release.json` names. The only exemptions are the files a
 *     build writes (`release.json`, `.inventory.json`, `bin/`) and, in a Windows archive, the two hook files
 *     tools/PluginPackage.ps1 renders with `& ` (S37); they are listed as `written`, never silently passed.
 *
 * Run directly (`bun kernel/src/releaseaudit.ts ...` or `node ...`); it is not a `library` verb, because a reader never
 * runs it. It prints one JSON object and exits 1 when anything differs.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { repositoryNeutralEnv } from './gitenv.ts';

export interface ByteEntry {
  path: string;
  bytes: Buffer;
}

export interface CommitComparison {
  checked: number;
  written: string[];
  differs: string[];
  not_in_commit: string[];
}

/** The id git gives these bytes as a blob: SHA-1 over `blob <length>\0` and the bytes, with no filter applied. */
export function gitBlobId(bytes: Uint8Array): string {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function git(gitDir: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-C', gitDir, ...args], { maxBuffer: 256 * 1024 * 1024, env: repositoryNeutralEnv() });
  if (result.error) throw new Error(`git ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${gitDir} exited ${result.status}: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

/** Every blob in the commit's tree, by its path with forward slashes. */
export function readCommitBlobIds(gitDir: string, commit: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const record of git(gitDir, ['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(record.slice(tab + 1), oid!);
  }
  return blobs;
}

export function resolveCommit(gitDir: string, revision: string): string {
  return git(gitDir, ['rev-parse', '--verify', `${revision}^{commit}`]).toString('utf8').trim();
}

export function compareToCommit(entries: Iterable<ByteEntry>, blobs: Map<string, string>, written: (entryPath: string) => boolean): CommitComparison {
  const result: CommitComparison = { checked: 0, written: [], differs: [], not_in_commit: [] };
  for (const entry of entries) {
    if (written(entry.path)) {
      result.written.push(entry.path);
      continue;
    }
    result.checked += 1;
    const blob = blobs.get(entry.path);
    if (blob === undefined) result.not_in_commit.push(entry.path);
    else if (blob !== gitBlobId(entry.bytes)) result.differs.push(entry.path);
  }
  return result;
}

/**
 * Every file entry of a zip, read from its central directory. The release archives are written entry by entry by
 * .NET's ZipArchive (stored or deflated, no zip64 at their size), so that is all this reads; anything else refuses
 * rather than being skipped.
 */
export function readZipEntries(file: string): ByteEntry[] {
  const zip = fs.readFileSync(file);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error(`${file} has no zip end-of-central-directory record.`);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error(`${file} is a zip64 archive, which a release is not.`);
  const entries: ByteEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: central directory entry ${index} is malformed.`);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localHeader = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (zip.readUInt32LE(localHeader) !== 0x04034b50) throw new Error(`${file}: ${name} has no local header.`);
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = zlib.inflateRawSync(data);
    else throw new Error(`${file}: ${name} uses compression method ${method}, which a release does not.`);
    entries.push({ path: name, bytes });
  }
  return entries;
}

/** What a build writes into an archive itself, so it has no blob: the tuple, the inventory, the binary, and S37's hooks. */
export function isBuildWritten(entryPath: string, platform: string): boolean {
  if (entryPath === 'release.json' || entryPath === '.inventory.json' || entryPath.startsWith('bin/')) return true;
  return platform.startsWith('win-') && (entryPath === '.claude-plugin/hooks/hooks.json' || entryPath === '.codex-plugin/hooks.json');
}

/** The build's input: each named file under `root`, raw bytes, against the commit. */
export function auditTree(root: string, files: string[], gitDir: string, commit: string): CommitComparison {
  const blobs = readCommitBlobIds(gitDir, commit);
  const entries = files.map((file) => ({ path: file, bytes: fs.readFileSync(path.join(root, file)) }));
  return compareToCommit(entries, blobs, () => false);
}

export interface ArchiveAudit extends CommitComparison {
  archive: string;
  platform: string;
  source_commit: string;
}

export interface ReleaseAudit {
  release: string;
  source_commit: string;
  archives: ArchiveAudit[];
  loose: CommitComparison;
  clean: boolean;
}

const LOOSE_FILES = ['install.ps1', 'install.sh', 'llms-install.md'];

/** The build's output: every archive SHA256SUMS names, and the loose files beside them, against the commit. */
export function auditRelease(release: string, gitDir: string): ReleaseAudit {
  const sums = path.join(release, 'SHA256SUMS');
  if (!fs.existsSync(sums)) throw new Error(`${release} holds no SHA256SUMS, so it is not a release folder.`);
  const names = fs
    .readFileSync(sums, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name): name is string => name !== undefined && name.length > 0);
  if (names.length === 0) throw new Error(`${sums} names no archive.`);
  const archives: ArchiveAudit[] = [];
  const blobsByCommit = new Map<string, Map<string, string>>();
  const blobsFor = (commit: string): Map<string, string> => {
    let blobs = blobsByCommit.get(commit);
    if (blobs === undefined) {
      blobs = readCommitBlobIds(gitDir, commit);
      blobsByCommit.set(commit, blobs);
    }
    return blobs;
  };
  for (const name of names) {
    const all = readZipEntries(path.join(release, name));
    const top = all[0]?.path.split('/')[0] ?? '';
    const entries = all.map((entry) => {
      if (!entry.path.startsWith(`${top}/`)) throw new Error(`${name}: ${entry.path} is outside the archive's one top folder ${top}.`);
      return { path: entry.path.slice(top.length + 1), bytes: entry.bytes };
    });
    const tuple = entries.find((entry) => entry.path === 'release.json');
    if (tuple === undefined) throw new Error(`${name} holds no release.json, so it names no commit to audit against.`);
    const parsed = JSON.parse(tuple.bytes.toString('utf8').replace(/^﻿/, '')) as { platform?: string; source_commit?: string | null };
    if (!parsed.source_commit) throw new Error(`${name}'s release.json names no source_commit; a release built outside git cannot be audited.`);
    const platform = parsed.platform ?? '';
    const comparison = compareToCommit(entries, blobsFor(parsed.source_commit), (entryPath) => isBuildWritten(entryPath, platform));
    archives.push({ archive: name, platform, source_commit: parsed.source_commit, ...comparison });
  }
  const commits = [...new Set(archives.map((archive) => archive.source_commit))];
  if (commits.length !== 1) throw new Error(`the archives name ${commits.length} different commits (${commits.join(', ')}); one release is built from one.`);
  const commit = commits[0]!;
  const loose = compareToCommit(
    LOOSE_FILES.filter((file) => fs.existsSync(path.join(release, file))).map((file) => ({ path: file, bytes: fs.readFileSync(path.join(release, file)) })),
    blobsFor(commit),
    () => false,
  );
  const clean = [...archives, loose].every((part) => part.differs.length === 0 && part.not_in_commit.length === 0);
  return { release, source_commit: commit, archives, loose, clean };
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

export function main(args: string[]): number {
  const usage = 'usage: releaseaudit.ts --release <folder> --source <git dir> | --tree <root> --files <list file> --source <git dir> [--commit <rev>]';
  const source = option(args, 'source');
  const release = option(args, 'release');
  const tree = option(args, 'tree');
  if (!source || (!release && !tree) || (release && tree)) {
    process.stderr.write(usage + '\n');
    return 2;
  }
  if (release) {
    const audit = auditRelease(path.resolve(release), path.resolve(source));
    process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
    return audit.clean ? 0 : 1;
  }
  const listFile = option(args, 'files');
  if (!listFile) {
    process.stderr.write(usage + '\n');
    return 2;
  }
  const commit = resolveCommit(path.resolve(source), option(args, 'commit') ?? 'HEAD');
  const files = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const comparison = auditTree(path.resolve(tree!), files, path.resolve(source), commit);
  const clean = comparison.differs.length === 0 && comparison.not_in_commit.length === 0;
  process.stdout.write(JSON.stringify({ tree: path.resolve(tree!), source_commit: commit, ...comparison, clean }, null, 2) + '\n');
  return clean ? 0 : 1;
}

// THE FILE NAME TOO (S85 row 6): inside a compiled bundle every module's import.meta.url is the executable, so the
// path test alone ran this as main in a compiled self-test, printed its usage and set exit code 2 after a green run.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === 'releaseaudit.ts' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(((error as Error).message ?? String(error)) + '\n');
    process.exitCode = 2;
  }
}
