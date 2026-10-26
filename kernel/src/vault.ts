/**
 * THE LIBRARY'S VAULT CONNECTION (kickoffs/s161 row 1; plan `vault-agent-contract` step 1a, D19a, K9).
 *
 * `connections.vault` in the marker, beside `basic_memory`: the Obsidian vault this Library writes its own pages into,
 * the folder inside it that is the Librarian's, and the features that cross into it. Off by default: a Library with no
 * such key behaves exactly as before, and every reader of the connection answers null for it.
 *
 *   deskpost vault connect <folder> (--preflight | --user-confirmed --plan-id <id>)
 *   deskpost vault disconnect (--preflight | --user-confirmed --plan-id <id>)
 *   deskpost vault status
 *
 * THE CHECKS ARE NAMED, AND EACH ONE REFUSES. The folder exists; it holds `.obsidian/` (an Obsidian vault) and
 * `Librarian/` (which the vault's own scripts make); no component of its path, from the drive or file-system root
 * down, is a symbolic link or junction (R2: a link could carry a page out of the vault); it is not inside the Library
 * and the Library is not inside it; the Library is local (a Basic Memory backend's Hubs are not files this kernel
 * reads). The apply runs the checks again and replaces the marker inside the marker lock, from the marker as read
 * there, refusing when its hash is not the one the preview's plan_id was made from. Nothing here touches a vault file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isLocalBackend } from './basicmemory.ts';
import { writeAtomicText } from './fsx.ts';
import { COMMAND_NAME } from './machine.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { markerPath, readMarker, withMarkerLock } from './workspace.ts';

export const VAULT_FEATURES = ['needs-you'] as const;
export const LIBRARIAN_FOLDER = 'Librarian';

export interface VaultConnection {
  /** The vault's folder, absolute. */
  path: string;
  /** The folder inside the vault that is the Librarian's: the only place the kernel writer writes. */
  librarian_folder: string;
  /** The features that cross into the vault; a feature not listed is off. */
  features: string[];
}

/** The connection the marker records, or null when it records none or one this program cannot read. */
export function readVaultConnection(marker: Record<string, unknown> | null): VaultConnection | null {
  const connections = marker?.['connections'];
  if (connections === null || typeof connections !== 'object' || Array.isArray(connections)) return null;
  const vault = (connections as Record<string, unknown>)['vault'];
  if (vault === null || typeof vault !== 'object' || Array.isArray(vault)) return null;
  const record = vault as Record<string, unknown>;
  const folder = typeof record['path'] === 'string' ? record['path'].trim() : '';
  const librarian = typeof record['librarian_folder'] === 'string' ? record['librarian_folder'].trim() : '';
  if (!folder || !path.isAbsolute(folder) || !librarian || /[\\/]|^\.\.?$/.test(librarian)) return null;
  const features = Array.isArray(record['features']) ? record['features'].filter((item): item is string => typeof item === 'string') : [];
  return { path: folder, librarian_folder: librarian, features };
}

/**
 * THE FIRST COMPONENT OF `target` THAT IS A SYMBOLIC LINK OR JUNCTION, from its drive or file-system root down, or
 * null (R2). Components that do not exist yet cannot be links and end the walk. Node's lstat reports a Windows junction
 * as a symbolic link, so one test covers both.
 */
export function linkedComponent(target: string): string | null {
  const full = path.resolve(target);
  const root = path.parse(full).root;
  let current = root;
  for (const part of full.substring(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

type Check = { check: string; status: 'ok' | 'refused'; detail: string };

/** The six named checks, in order; the first refusal stops the rest, since each later check needs the earlier. */
function connectChecks(workspace: string, folder: string): Check[] {
  const checks: Check[] = [];
  const add = (check: string, ok: boolean, good: string, bad: string): boolean => {
    checks.push({ check, status: ok ? 'ok' : 'refused', detail: ok ? good : bad });
    return ok;
  };
  const isDirectory = (target: string) => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  };
  if (!add('the Library is local', isLocalBackend(workspace), 'its backend is local, so its Hubs are files this program reads',
    "this Library's backend is Basic Memory: its Hubs live on the server, and the vault connection is for a local Library")) return checks;
  if (!add('the folder exists', isDirectory(folder), `${folder} is a folder`, `${folder} is not a folder that exists`)) return checks;
  if (!add('it is an Obsidian vault', isDirectory(path.join(folder, '.obsidian')), 'it holds .obsidian/',
    'it holds no .obsidian/ folder, so Obsidian has never opened it as a vault')) return checks;
  if (!add('it has a Librarian folder', isDirectory(path.join(folder, LIBRARIAN_FOLDER)), `it holds ${LIBRARIAN_FOLDER}/`,
    `it holds no ${LIBRARIAN_FOLDER}/ folder; the vault's own scaffold makes it, and this program writes only inside it`)) return checks;
  const linked = linkedComponent(path.join(folder, LIBRARIAN_FOLDER));
  if (!add('no link in its path', linked === null, 'no component of its path is a symbolic link or junction',
    `${linked} is a symbolic link or junction, and a page written through it could land outside the vault`)) return checks;
  const library = path.resolve(workspace);
  const nested = inside(folder, library) ? 'the vault is inside the Library' : inside(library, folder) ? 'the Library is inside the vault' : '';
  add('the Library and the vault are apart', nested === '', 'neither folder holds the other', `${nested}, and each must stay out of the other`);
  return checks;
}

function markerSha(workspace: string): string {
  return sha256OfBytes(fs.readFileSync(markerPath(workspace)));
}

function refused(checks: Check[]): string | null {
  const bad = checks.find((item) => item.status === 'refused');
  return bad ? `The vault connection was not saved: the check '${bad.check}' refused it: ${bad.detail}.` : null;
}

/** The marker as given, with `connections.vault` set to `vault` or removed, and every other field and connection kept. */
function withVault(marker: Record<string, unknown>, vault: VaultConnection | null): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(marker)) if (key !== 'connections') next[key] = value;
  const others: Record<string, unknown> = {};
  const existing = marker['connections'];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) if (key !== 'vault') others[key] = value;
  }
  if (vault !== null) others['vault'] = { path: vault.path, librarian_folder: vault.librarian_folder, features: [...vault.features] };
  if (Object.keys(others).length) next['connections'] = others;
  return next;
}

export interface VaultVerbOptions {
  folder?: string;
  preflight: boolean;
  userConfirmed: boolean;
  planId?: string;
}

/** `deskpost vault <connect|disconnect|status>`: the result, and a line for a person. A refusal throws. */
export function vaultVerb(action: string, workspace: string, options: VaultVerbOptions): { value: Record<string, PsJsonValue>; text: string } {
  if (!fs.existsSync(markerPath(workspace))) throw new Error(`${workspace} has no workspace marker, so it is not a Library. Nothing was written.`);
  if (action === 'status') {
    const connection = readVaultConnection(readMarker(workspace));
    if (connection === null) {
      return { value: { schema: 1, operation: 'Vault connection', workspace, connected: false }, text: `This Library has no vault connection. Make one with ${COMMAND_NAME} vault connect <folder> --preflight.` };
    }
    const exists = fs.existsSync(connection.path);
    const librarian = fs.existsSync(path.join(connection.path, connection.librarian_folder));
    return {
      value: { schema: 1, operation: 'Vault connection', workspace, connected: true, connection: { ...connection }, folder_exists: exists, librarian_folder_exists: librarian },
      text: `This Library writes into the vault at ${connection.path} (${connection.librarian_folder}/), with ${connection.features.length ? connection.features.join(', ') : 'no features'} on.` +
        (exists ? (librarian ? '' : ` Its ${connection.librarian_folder}/ folder is missing.`) : ' That folder is missing.'),
    };
  }
  if (options.preflight === options.userConfirmed) {
    throw new Error(`${COMMAND_NAME} vault ${action} takes --preflight first, then --user-confirmed --plan-id <its plan_id>. Nothing was written.`);
  }

  if (action === 'connect') {
    if (!options.folder || !options.folder.trim()) throw new Error(`${COMMAND_NAME} vault connect needs the vault's folder: ${COMMAND_NAME} vault connect <folder> --preflight. Nothing was written.`);
    const folder = path.resolve(options.folder.trim());
    const connection: VaultConnection = { path: folder, librarian_folder: LIBRARIAN_FOLDER, features: [...VAULT_FEATURES] };
    const plan = (sha: string) => 'vault-connect-' + sha256OfText(`${path.resolve(workspace)}|${folder}|${sha}`);
    const checks = connectChecks(workspace, folder);
    const refusal = refused(checks);
    if (refusal !== null) throw new Error(refusal);
    const result: Record<string, PsJsonValue> = {
      schema: 1, operation: 'Connect a vault', workspace, checks, connection: { ...connection },
      stored_in: '.library/workspace.json, as connections.vault', marker_sha256: markerSha(workspace), plan_id: plan(markerSha(workspace)),
      confirmation_required: true, shared_library_write: false,
    };
    if (options.preflight) {
      return { value: { ...result, saved: false }, text: `Would connect this Library to the vault at ${folder}. Apply with --user-confirmed --plan-id ${String(result['plan_id'])}.` };
    }
    return withMarkerLock(workspace, (marker) => {
      if (marker === null) throw new Error(`${workspace} has no workspace marker. Nothing was written.`);
      const again = refused(connectChecks(workspace, folder));
      if (again !== null) throw new Error(again);
      const now = markerSha(workspace);
      if ((options.planId ?? '').trim() !== plan(now)) {
        throw new Error('The plan_id does not match: the marker or the folder changed since the preview, or the plan_id is from another one. Nothing was written. Preview it again with --preflight.');
      }
      writeAtomicText(markerPath(workspace), psConvertToJson(withVault(marker, connection) as PsJsonValue) + '\n');
      const back = readVaultConnection(JSON.parse(fs.readFileSync(markerPath(workspace), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>);
      if (back === null || JSON.stringify(back) !== JSON.stringify(connection)) {
        throw new Error('The vault connection was written to the marker and did not read back as written. Check .library/workspace.json.');
      }
      return { value: { ...result, plan_id: plan(now), saved: true }, text: `This Library is connected to the vault at ${folder}; it writes only inside ${LIBRARIAN_FOLDER}/.` };
    });
  }

  if (action === 'disconnect') {
    const current = readVaultConnection(readMarker(workspace));
    if (current === null) return { value: { schema: 1, operation: 'Disconnect the vault', workspace, disconnected: false, note: 'This Library has no vault connection.' }, text: 'This Library has no vault connection.' };
    const plan = (sha: string) => 'vault-disconnect-' + sha256OfText(`${path.resolve(workspace)}|${sha}`);
    const result: Record<string, PsJsonValue> = {
      schema: 1, operation: 'Disconnect the vault', workspace, would_remove: { ...current }, marker_sha256: markerSha(workspace), plan_id: plan(markerSha(workspace)),
      note: "Removes only the marker's record of the connection. No file in the vault is touched, the page Deskpost wrote there included.",
      confirmation_required: true, shared_library_write: false,
    };
    if (options.preflight) return { value: { ...result, disconnected: false }, text: `Would disconnect the vault at ${current.path}. Apply with --user-confirmed --plan-id ${String(result['plan_id'])}.` };
    return withMarkerLock(workspace, (marker) => {
      if (marker === null) throw new Error(`${workspace} has no workspace marker. Nothing was written.`);
      const now = markerSha(workspace);
      if ((options.planId ?? '').trim() !== plan(now)) {
        throw new Error('The plan_id does not match: the marker changed since the preview, or the plan_id is from another one. Nothing was written. Preview it again with --preflight.');
      }
      writeAtomicText(markerPath(workspace), psConvertToJson(withVault(marker, null) as PsJsonValue) + '\n');
      return { value: { ...result, plan_id: plan(now), disconnected: true }, text: `The vault at ${current.path} is disconnected; no file in it was touched.` };
    });
  }
  throw new Error(`${COMMAND_NAME} vault has no action '${action}'. It has: connect, disconnect, status. Nothing was run.`);
}
