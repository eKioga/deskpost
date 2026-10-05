/**
 * `library install`'s first stage, THE BOOTSTRAP (PLAN-install-without-powershell.md D2; ADR-0066).
 *
 * The `library.exe` a reader runs first may be any version from 1.3.5 on: a copy `tar` unpacked into %TEMP% by the
 * Command Prompt line (D3), or an installed `current\bin\library.exe` asked to install another release. It does only
 * what install.ps1's step 1 did -- resolve the release, read `SHA256SUMS`, read the archive and check its hash, extract
 * it into a temp folder of its own, and ask the extracted binary for its tuple -- and then runs THE EXTRACTED BINARY's
 * `install --extracted <folder> --archive-sha256 <hex>` with the same arguments, waiting for it. Everything from
 * recovery on is release N's own code placing release N (install.ts). When the child exits, this process removes the
 * temp folder (a running image cannot remove itself, finisher.ts) and exits with the child's code.
 *
 * THE NETWORK. Bun's `fetch` uses Bun's bundled roots, not the Windows certificate store, and honours HTTPS_PROXY; it
 * reads NODE_EXTRA_CA_CERTS only when handed it as `tls.ca`, so that file is read and handed over here (the row 0 spike,
 * kickoffs/s89). Under Node the runtime reads the variable itself at start. The Command Prompt line needs neither: it
 * downloads with `curl.exe` and installs from a local folder.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { zipExtract } from './lifecycle.ts';
import { locateProgramRoot } from './programroot.ts';

/** Where the latest release is served from: install.ps1's default `-Release`. */
export const DEFAULT_RELEASE = 'https://github.com/eKioga/deskpost/releases/latest/download';

/** The Windows platforms `library install` installs; macOS and Linux use install.sh. */
export const WINDOWS_PLATFORMS = ['win-x64', 'win-arm64'];

export function defaultPlatform(): string {
  return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
}

export function isReleaseUrl(release: string): boolean {
  return /^https?:\/\//i.test(release.trim());
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * THE ARCHIVE A `SHA256SUMS` NAMES FOR A PLATFORM (D2, D3). The versioned line (`deskpost-<v>-<platform>.zip`) is
 * preferred, as install.ps1's own pattern reads it (`install.ps1:620`); the unversioned name (`deskpost-<platform>.zip`,
 * which `releases/latest/download/` can address) is used only when no versioned line is there. Where both are listed
 * they are the same bytes, so their hashes must be equal. More than one line of either kind refuses.
 */
export function chooseArchive(sumsText: string, platform: string): { name: string; sha256: string } {
  const lines = sumsText.split(/\r?\n/);
  const pick = (pattern: RegExp) =>
    lines.map((line) => pattern.exec(line)).filter((match): match is RegExpExecArray => match !== null).map((match) => ({ sha256: match[1]!, name: match[2]! }));
  const versioned = pick(new RegExp(`^([0-9a-f]{64})\\s+\\*?(deskpost-[0-9A-Za-z.+-]+-${escapeRegex(platform)}\\.zip)\\s*$`));
  const unversioned = pick(new RegExp(`^([0-9a-f]{64})\\s+\\*?(deskpost-${escapeRegex(platform)}\\.zip)\\s*$`));
  if (versioned.length > 1 || unversioned.length > 1 || (!versioned.length && !unversioned.length)) {
    throw new Error(`SHA256SUMS names ${versioned.length || unversioned.length} archive(s) for ${platform}; an install needs exactly one.`);
  }
  if (versioned.length && unversioned.length && versioned[0]!.sha256 !== unversioned[0]!.sha256) {
    throw new Error(`SHA256SUMS gives ${versioned[0]!.name} and ${unversioned[0]!.name} different hashes, and a release ships them as the same bytes. Nothing was installed.`);
  }
  return versioned[0] ?? unversioned[0]!;
}

/**
 * THE ARCHIVE TO READ (S91, the Command Prompt line's run): a release URL serves both names, but the line downloads
 * only the unversioned one into its folder while SHA256SUMS lists both. So from a local folder that lacks the chosen
 * versioned file, its unversioned twin is read when SHA256SUMS lists it (chooseArchive has already held both to one
 * hash). Otherwise the chosen name stands, and a missing file refuses by that name.
 */
export function archiveToRead(release: string, sumsText: string, platform: string): { name: string; sha256: string } {
  const chosen = chooseArchive(sumsText, platform);
  if (isReleaseUrl(release) || fs.existsSync(path.join(release, chosen.name))) return chosen;
  const twin = `deskpost-${platform}.zip`;
  const listed = sumsText.split(/\r?\n/).some((line) => new RegExp(`^${chosen.sha256}\\s+\\*?${escapeRegex(twin)}\\s*$`).test(line));
  return twin !== chosen.name && listed && fs.existsSync(path.join(release, twin)) ? { sha256: chosen.sha256, name: twin } : chosen;
}

/** The PEM text NODE_EXTRA_CA_CERTS names, for `tls.ca`; undefined when it is not set. A file it cannot read refuses. */
export function extraCertificates(): string | undefined {
  const file = (process.env['NODE_EXTRA_CA_CERTS'] ?? '').trim();
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`NODE_EXTRA_CA_CERTS names ${file}, which could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}). Nothing was installed.`);
  }
}

/** Download `url` to `to` with this runtime's `fetch`, handing Bun the extra roots as `tls.ca`. */
export async function fetchToFile(url: string, to: string): Promise<void> {
  const ca = extraCertificates();
  const init: Record<string, unknown> = {};
  if (ca !== undefined && typeof (globalThis as { Bun?: unknown }).Bun === 'object') init['tls'] = { ca };
  let response: Response;
  try {
    response = await fetch(url, init as RequestInit);
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    throw new Error(`${url} could not be downloaded: ${(error as Error).message}${cause ? ` (${cause})` : ''}. Nothing was installed.`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}. Nothing was installed.`);
  fs.writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

/** A release file into `temp`: copied from a local release folder, or downloaded from a release URL. */
export async function readReleaseFile(release: string, name: string, temp: string): Promise<string> {
  const to = path.join(temp, name);
  if (isReleaseUrl(release)) await fetchToFile(release.replace(/\/+$/, '') + '/' + name, to);
  else {
    const from = path.join(release, name);
    if (!fs.existsSync(from)) throw new Error(`${release} holds no ${name}, so it is not a release folder. Nothing was installed.`);
    fs.copyFileSync(from, to);
  }
  return to;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The release's own executable inside an extracted tree. */
export function treeExecutable(tree: string): string {
  return path.join(tree, 'bin', process.platform === 'win32' ? 'library.exe' : 'library');
}

function sameFolder(left: string, right: string): boolean {
  const norm = (value: string) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return norm(left) === norm(right);
}

/**
 * THE TUPLE CHECK, install.ps1's `Assert-Tuple` (`:235-250`): the binary is asked, not the file beside it. It must
 * report the release's plugin, binary and schema versions, `compiled: true`, and `expectRoot` as its program root
 * (`current` once switched). Returns what it reported.
 */
export function assertTuple(tree: string, expected: Record<string, unknown>, expectRoot: string = tree): Record<string, unknown> {
  const exe = treeExecutable(tree);
  const ran = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (ran.error || ran.status !== 0) {
    throw new Error(`${exe} exited ${ran.status ?? 'without starting'} on --version; the release does not run on this machine. ${(ran.stderr ?? ran.error?.message ?? '').trim()}`);
  }
  let reported: Record<string, unknown>;
  try {
    reported = JSON.parse(ran.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${exe} --version printed no readable tuple: ${ran.stdout.trim().slice(0, 200)}`);
  }
  const mismatch: string[] = [];
  for (const field of ['plugin_version', 'binary_version', 'workspace_schema']) {
    if (String(reported[field]) !== String(expected[field])) mismatch.push(`${field} is ${String(reported[field])}, release.json says ${String(expected[field])}`);
  }
  if (reported['compiled'] !== true) mismatch.push('it does not report itself compiled');
  if (!sameFolder(String(reported['program_root'] ?? ''), expectRoot)) mismatch.push(`its program root is ${String(reported['program_root'])}, not ${expectRoot}`);
  if (mismatch.length) throw new Error(`the installed binary does not match its release: ${mismatch.join('; ')}.`);
  return reported;
}

/** Whether an extracted release's binary knows `install`: a capability check, never a version compare (D6). */
export function hasInstallVerb(tree: string): boolean {
  const ran = spawnSync(treeExecutable(tree), ['install', '--help'], { encoding: 'utf8', windowsHide: true });
  return !ran.error && ran.status === 0;
}

export interface FetchedRelease {
  temp: string;
  archive: string;
  archiveSha256: string;
  extracted: string;
  release: Record<string, unknown>;
  version: string;
}

/**
 * install.ps1's step 1 (`:607-637`): SHA256SUMS and this platform's archive into `temp`, the hash against its line, the
 * archive extracted, release.json's platform and version, and the extracted binary's tuple. Nothing is created under an
 * install root.
 */
export async function fetchRelease(release: string, platform: string, temp: string, say: (text: string) => void): Promise<FetchedRelease> {
  say(`Reading the release's checksums from ${release}`);
  const sums = fs.readFileSync(await readReleaseFile(release, 'SHA256SUMS', temp), 'utf8');
  const chosen = archiveToRead(release, sums, platform);
  const archive = await readReleaseFile(release, chosen.name, temp);
  const actual = sha256File(archive);
  if (actual !== chosen.sha256) throw new Error(`${chosen.name} hashes to ${actual} and SHA256SUMS says ${chosen.sha256}. Nothing was installed.`);
  const extracted = zipExtract(archive, path.join(temp, 'x'));
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(fs.readFileSync(path.join(extracted, 'release.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    throw new Error(`${chosen.name} holds no readable release.json, so it is not a Deskpost release. Nothing was installed.`);
  }
  if (record['platform'] !== platform) throw new Error(`${chosen.name} is built for ${String(record['platform'])}, not ${platform}.`);
  const version = String(record['plugin_version'] ?? '');
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`release.json's version '${version}' cannot name a directory.`);
  assertTuple(extracted, record);
  return { temp, archive, archiveSha256: actual, extracted, release: record, version };
}

/** A fresh temp folder of this run's own, `%TEMP%\deskpost-<guid>`, as install.ps1 made one. */
export function newTempFolder(): string {
  const temp = path.join(os.tmpdir(), `deskpost-${randomUUID().replace(/-/g, '')}`);
  fs.mkdirSync(temp, { recursive: true });
  return temp;
}

/**
 * THE BOOTSTRAP ITSELF: fetch and check, then run the extracted binary's `install --extracted` with these same
 * arguments and the console, wait, remove the temp folder, and return the child's exit code. A release whose binary
 * has no `install` verb predates this, and is installed by its own install.ps1.
 */
export async function runBootstrap(argv: string[], options: { release: string; platform: string; json: boolean; say: (text: string) => void }): Promise<number> {
  const temp = newTempFolder();
  try {
    const fetched = await fetchRelease(options.release, options.platform, temp, options.say);
    if (!hasInstallVerb(fetched.extracted)) {
      throw new Error(`This release (${fetched.version}) predates \`library install\`. Use that release's own install.ps1. Nothing was installed.`);
    }
    const passed = withoutInternalOptions(argv);
    // THIS BOOTSTRAP'S OWN PROGRAM FOLDER (D3, kickoffs/s91 ruling 2), so the closing text can name it as safe to delete
    // when it is outside the install root. Only a compiled binary has one; from source it would be the checkout.
    const own = locateProgramRoot();
    const ownFolder = own.compiled && own.root !== null ? ['--bootstrap-folder', own.root] : [];
    const child = spawnSync(treeExecutable(fetched.extracted), ['install', ...passed, '--extracted', fetched.extracted, '--archive-sha256', fetched.archiveSha256, ...ownFolder], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (child.error) throw new Error(`the release's own program could not be started: ${child.error.message}. Nothing was installed.`);
    return child.status ?? 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** The arguments a caller gave, less the three only a bootstrap passes, so a caller cannot name another tree. */
export function withoutInternalOptions(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--extracted' || argv[index] === '--archive-sha256' || argv[index] === '--bootstrap-folder') {
      index += 1;
      continue;
    }
    out.push(argv[index]!);
  }
  return out;
}
