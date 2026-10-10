/**
 * `deskpost upgrade` (PLAN-one-step-upgrade.md D1; ADR-0068): the install it runs from, upgraded in one word.
 *
 * It upgrades `installRootOf(programRoot())`, never a guess and never `--install-root`. `--check` reads the release's
 * `SHA256SUMS` only and compares its versioned line with `current.json` (D0); it never downloads an archive, and
 * `releases/latest/download/` needs no API call or token. Without `--check`, a release that is not newer is said and
 * nothing changes; could-not-tell refuses; a newer one goes through `install` as every route does since 1.3.5: the
 * bootstrap fetches and checks the release into its own temp folder and runs the extracted program's own `install
 * --extracted ... --install-root <root>`, so the NEW version does its own install, and the wait for open sessions (D3)
 * is that install's. `upgrade` passes the child only `install`'s flags; `--dry-run`, `--json`, `--plan-id` and `--yes`
 * keep their meaning, so an assistant upgrades in two commands as `llms-install.md` installs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { programRoot } from './programroot.ts';
import { installRootOf } from './machine.ts';
import { DEFAULT_RELEASE, defaultPlatform, newTempFolder, readReleaseFile } from './bootstrap.ts';
import { installVerb } from './install.ts';
import { compareVersions, latestVersionIn } from './versions.ts';
import { UPGRADE_OPENED_ENV, upgradeLine } from './setup.ts';

export interface UpgradeCheck {
  installed: string | null;
  latest: string | null;
  /** null when it could not tell. */
  newer: boolean | null;
  checked_utc: string;
  /** null, or why it could not tell (offline, refused, unreadable). */
  error: string | null;
  /** The URL or folder the check read. */
  release: string;
}

/** The platform whose versioned line names the latest version. */
export function upgradePlatform(): string {
  return process.platform === 'win32' ? defaultPlatform() : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/** The version `current.json` at `root` names, or null. */
export function installedVersion(root: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    return typeof record['version'] === 'string' ? record['version'] : null;
  } catch {
    return null;
  }
}

/** D1's `--check`: one read of the release's SHA256SUMS, compared with the install's version. Never throws. */
export async function checkForUpgrade(root: string, release: string, platform: string = upgradePlatform(), signal?: AbortSignal): Promise<UpgradeCheck> {
  const installed = installedVersion(root);
  const result: UpgradeCheck = { installed, latest: null, newer: null, checked_utc: new Date().toISOString(), error: null, release };
  const temp = newTempFolder();
  try {
    const sums = fs.readFileSync(await readReleaseFile(release, 'SHA256SUMS', temp, signal), 'utf8');
    result.latest = latestVersionIn(sums, platform);
    if (result.latest === null) {
      result.error = `the release's SHA256SUMS names no versioned ${platform} archive, so its version cannot be read`;
    } else if (installed === null) {
      result.error = `${path.join(root, 'current.json')} names no version`;
    } else {
      const order = compareVersions(result.latest, installed);
      if (order === 'unknown') result.error = `the versions ${result.latest} and ${installed} cannot be compared`;
      else result.newer = order === 'newer';
    }
  } catch (error) {
    result.error = (error as Error).message.replace(/\s*Nothing was installed\.$/, '');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return result;
}

/** The one line `--check` says. */
export function checkText(check: UpgradeCheck): string {
  if (check.newer === true) return `Deskpost ${check.latest} is ready (you have ${check.installed}). Run \`deskpost upgrade\`.`;
  if (check.newer === false) return `Deskpost ${check.installed} is up to date.`;
  return `Could not tell whether a newer Deskpost is ready: ${check.error}.`;
}

// --- the menu's update line (D2) ---------------------------------------------------------------------------------

/** The record of the last check, at the install root; uninstall removes it (`programRemoval`). */
export const UPDATE_CHECK_FILE = 'update-check.json';

export interface UpdateRecord {
  checked_utc: string;
  installed: string | null;
  latest: string | null;
  /** The URL or folder the check read: what `u` upgrades from. */
  release: string;
  error: string | null;
}

export function readUpdateRecord(root: string): UpdateRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, UPDATE_CHECK_FILE), 'utf8').replace(/^\uFEFF/, '')) as UpdateRecord;
    return typeof record === 'object' && record !== null && typeof record.checked_utc === 'string' ? record : null;
  } catch {
    return null;
  }
}

/** `DESKPOST_UPDATE_CHECK`'s reading lives in `updatecheck.ts` (kickoffs/s102 K3); it is re-exported here for its callers. */
import { updateCheckSetting } from './updatecheck.ts';
export { updateCheckSetting };

/** Whether a day has passed since the last attempt, error included, so the gate holds offline. */
export function updateCheckDue(root: string, now: number = Date.now()): boolean {
  const record = readUpdateRecord(root);
  const at = record === null ? NaN : Date.parse(record.checked_utc);
  return Number.isNaN(at) || now - at >= 24 * 60 * 60 * 1000 || at > now;
}

/**
 * One check, recorded after every attempt. The release is `DESKPOST_UPDATE_RELEASE` when a fixture names one (a local
 * folder or URL), else `releases/latest/download/`.
 */
export async function recordUpdateCheck(root: string, signal?: AbortSignal): Promise<UpdateRecord> {
  const release = (process.env['DESKPOST_UPDATE_RELEASE'] ?? '').trim() || DEFAULT_RELEASE;
  const found = await checkForUpgrade(root, release, upgradePlatform(), signal);
  const record: UpdateRecord = { checked_utc: found.checked_utc, installed: found.installed, latest: found.latest, release, error: found.error };
  try {
    fs.writeFileSync(path.join(root, UPDATE_CHECK_FILE), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // A root it cannot write keeps no record; the next menu checks again.
  }
  return record;
}

/** The version the record says is ready, when it is newer than the running program; null otherwise or when off. */
export function readyVersion(root: string | null, running: string): string | null {
  if (root === null || updateCheckSetting() === 'off' || (process.env['LIBRARY_SEAT'] ?? '').trim() !== '') return null;
  const record = readUpdateRecord(root);
  if (record === null || record.latest === null) return null;
  return compareVersions(record.latest, running) === 'newer' ? record.latest : null;
}

/** The menu's line under `Library` (D2). */
export function updateLineText(latest: string, running: string): string {
  return `  Update   Deskpost ${latest} is ready (you have ${running})   u upgrade`;
}

/** Whether this process runs inside a seat's session: `LIBRARY_SEAT` set, or a seat claim (D1). */
function insideSeat(): boolean {
  return (process.env['LIBRARY_SEAT'] ?? '').trim() !== '' || (process.env['LIBRARY_SEAT_CLAIM'] ?? '').trim() !== '';
}

export interface UpgradeResult {
  refusal: string | null;
  exitCode: number;
}

export async function upgradeVerb(argv: string[]): Promise<UpgradeResult> {
  const parsed = parseArguments(argv, argumentTable('upgrade'));
  const unknown = [...parsed.flags].filter((name) => !(argumentTable('upgrade').boolean ?? []).includes(name));
  if (unknown.length) return { refusal: `deskpost upgrade has no ${unknown.map((name) => `--${name}`).join(', ')}. Run \`deskpost upgrade --help\` for what it takes. Nothing was changed.`, exitCode: 1 };
  if (parsed.positional.length) return { refusal: `deskpost upgrade takes no words ('${parsed.positional.join(' ')}'); it upgrades the install it runs from. Nothing was changed.`, exitCode: 1 };
  const check = parsed.flags.has('check');
  const json = parsed.flags.has('json');
  // INSIDE A SEAT'S SESSION IT REFUSES (D1): the upgrade waits for every session, this one included. `--check` and
  // `--dry-run` change nothing and are answered anywhere (kickoffs/s102 K1); the dry run's Sessions row then names this
  // session among the open ones.
  if (!check && !parsed.flags.has('dry-run') && insideSeat()) {
    return { refusal: 'Run `deskpost upgrade` from a terminal or the main menu, not from a seat\'s session: the upgrade waits for every session, including this one. Nothing was changed.', exitCode: 1 };
  }
  const root = installRootOf(programRoot());
  if (root === null) {
    return {
      refusal: `deskpost upgrade upgrades the install it runs from, and this program (${programRoot()}) is not an installed Deskpost. Install one with the line in the README, or run an installed \`deskpost upgrade\`. Nothing was changed.`,
      exitCode: 1,
    };
  }
  const release = parsed.options.get('release') ?? DEFAULT_RELEASE;
  const found = await checkForUpgrade(root, release);
  if (check) {
    if (json) {
      const { release: _read, ...fields } = found;
      process.stdout.write(JSON.stringify(fields) + '\n');
    } else process.stdout.write(checkText(found) + '\n');
    return { refusal: null, exitCode: 0 };
  }
  const say = (text: string) => (json ? process.stderr : process.stdout).write(text + '\n');
  if (found.newer === null) return { refusal: `${checkText(found)} Nothing was changed.`, exitCode: 1 };
  if (!found.newer) {
    say(`Deskpost ${found.installed} at ${root} is up to date (the release has ${found.latest}). Nothing was changed.`);
    if (json) process.stdout.write(JSON.stringify({ status: 'up-to-date', installed: found.installed, latest: found.latest, install_root: root }) + '\n');
    return { refusal: null, exitCode: 0 };
  }
  if (process.platform !== 'win32') {
    return { refusal: `On macOS and Linux, install.sh upgrades Deskpost: ${upgradeLine(root, '1.3.5', 'kernel')}. Nothing was changed.`, exitCode: 1 };
  }
  // THE ARGUMENT TRANSLATION (D1): only `install`'s flags, and the root this program runs from. The install's receipt
  // keeps its Library and Librarian; `upgrade` names neither.
  const child = ['--release', release, '--install-root', root];
  for (const flag of ['dry-run', 'json', 'yes', 'path-change', 'no-path-change']) if (parsed.flags.has(flag)) child.push(`--${flag}`);
  for (const option of ['plan-id', 'wait']) if (parsed.options.has(option)) child.push(`--${option}`, parsed.options.get(option)!);
  // ONE OPENING LINE ON EVERY ROUTE (kickoffs/s110 ruling 3): said here, before the install's own refusals, the download
  // and its check, so a run that stops before `setup` still says what it was doing. `setup`, run by the release being
  // installed, reads UPGRADE_OPENED_ENV and does not say it again; `deskpost setup` on its own keeps its line.
  say(`Upgrading Deskpost ${found.installed} to ${found.latest} at ${root}.`);
  process.env[UPGRADE_OPENED_ENV] = '1';
  const installed = await installVerb(child);
  return { refusal: installed.refusal, exitCode: installed.exitCode };
}
