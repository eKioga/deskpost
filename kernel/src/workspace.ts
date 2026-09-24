/**
 * The workspace resolver and the machine registry: step 24's first port-order group.
 *
 * The PowerShell original is `tools/WorkspaceRegistry.ps1`, and its contract is the one this file
 * keeps rather than improves on. Two rules carry most of the weight:
 *
 *   THE MARKER IS WHAT MAKES A DIRECTORY A WORKSPACE. `.library/workspace.json` at the root. The
 *   registry is a convenience index over those markers and never the authority.
 *
 *   A ROOT THAT IS NOT DRIVE-ROOTED CANNOT BE ONE. Every containment test in the guards is a prefix
 *   comparison, and a UNC path cannot be reasoned about that way, so a share is refused by the rule
 *   rather than by whatever error the network happens to raise.
 *
 *   ON macOS AND LINUX A ROOT IS AN ABSOLUTE `/` PATH (S42, the reader's ruling), resolved by
 *   path.posix: a leading `//`, which POSIX leaves to the implementation, and a NUL are refused, and so
 *   is a backslash IN A ROOT, because the guards read one as a separator and a root spelled with one
 *   could not be judged by prefix. Comparisons stay case-insensitive, so a guard errs toward denying.
 *   Measured in a clean Ubuntu 24.04 distro, where until S42 every POSIX workspace was refused.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { programRoot } from './programroot.ts';

export interface RegistryEntry {
  id: string;
  root: string;
}

export interface ResolvedWorkspace {
  kind: 'resolved' | 'conflict' | 'none';
  workspace: string | null;
  source: string | null;
  reason: string | null;
  cwd: string | null;
}

export const MARKER_RELATIVE = path.join('.library', 'workspace.json');

/** Which rules a path is judged by: Windows' drive-rooted form, or the POSIX absolute one (S42). */
export type PathFlavor = 'win32' | 'posix';

export const HOST_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';

/** The rule's name, as every refusal of a root says it. Windows' sentence is the oracle's, unchanged. */
export function rootFormName(flavor: PathFlavor = HOST_FLAVOR): string {
  return flavor === 'win32' ? 'a drive-rooted local path' : 'an absolute local path';
}

/**
 * A POSIX TARGET's full path, or null where it cannot be placed: backslashes read as separators, as the
 * guards read them everywhere, then `.`, `..` and repeated slashes resolved. A leading `//` and a NUL
 * are null. A relative value resolves against the working directory.
 */
export function posixFullPath(candidate: string): string | null {
  const text = candidate.replace(/\\/g, '/');
  if (text.includes('\x00') || text.startsWith('//')) return null;
  return path.posix.resolve(text);
}

/**
 * One shape for every root this file compares against, or null when the value cannot be one.
 *
 * `path.resolve` is `[IO.Path]::GetFullPath`'s counterpart here, including for a UNC path, which it
 * returns unchanged -- and which then fails the drive-letter test, which is the point.
 */
export function toWorkspaceRoot(candidate: string | null | undefined, flavor: PathFlavor = HOST_FLAVOR): string | null {
  if (!candidate || !candidate.trim()) return null;
  if (flavor === 'posix') return candidate.includes('\\') ? null : posixFullPath(candidate);
  let full: string;
  try {
    full = path.win32.resolve(candidate);
  } catch {
    return null;
  }
  full = full.replace(/[\\/]+$/, (match, offset: number) => (offset <= 2 ? match : ''));
  if (!/^[A-Za-z]:[\\/]/.test(full)) return null;
  return full;
}

/**
 * A TARGET's full path, for placing it against the roots: Windows' is the root form itself; POSIX's
 * reads a backslash as a separator, which a root may not contain, so a target spelled with one is
 * still placed rather than dropped as no path at all.
 */
export function toLocalFullPath(candidate: string | null | undefined, flavor: PathFlavor = HOST_FLAVOR): string | null {
  if (flavor === 'win32') return toWorkspaceRoot(candidate, flavor);
  if (!candidate || !candidate.trim()) return null;
  return posixFullPath(candidate);
}

/** `$env:USERPROFILE` on Windows, as the oracle's; POSIX has none and uses HOME (S42). */
export function homeDirectory(): string {
  if (process.platform === 'win32') return process.env['USERPROFILE'] ?? '';
  return process.env['HOME'] || os.homedir();
}

export function markerPath(workspace: string): string {
  return path.join(workspace, '.library', 'workspace.json');
}

export function registryRoot(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const fromEnvironment = process.env['LIBRARY_WORKSPACES'];
  if (fromEnvironment && fromEnvironment.trim()) return fromEnvironment;
  return path.join(homeDirectory(), '.library');
}

export function registryPath(explicit?: string): string {
  return path.join(registryRoot(explicit), 'workspaces.json');
}

export function readTextFile(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/**
 * The marker's parsed contents, or null when there is none.
 *
 * AN UNREADABLE MARKER THROWS. State that cannot vouch for itself must not be read as absent: a
 * workspace whose marker is corrupt is a workspace this machine cannot characterise, and treating
 * it as "not initialised yet" is how `library init` would overwrite an id somebody is registered
 * under.
 */
export function readMarker(workspace: string): Record<string, unknown> | null {
  const file = markerPath(workspace);
  if (!fs.existsSync(file)) return null;
  const text = readTextFile(file);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `the workspace marker at ${file} is not readable JSON, so this workspace's identity cannot be established`,
    );
  }
}

export function markerField(marker: Record<string, unknown> | null, name: string): string {
  if (!marker || !(name in marker)) return '';
  const value = marker[name];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * The registered workspaces. An ABSENT registry is an empty list and not an error; an UNREADABLE one
 * throws, because both guards turn a throw into a denial and that is the only correct direction for
 * state that cannot vouch for itself.
 */
export function readRegistry(explicitRoot?: string): RegistryEntry[] {
  const file = registryPath(explicitRoot);
  if (!fs.existsSync(file)) return [];
  const text = readTextFile(file);
  if (!text.trim()) return [];
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(
      `the workspace registry at ${file} is not readable JSON, so which workspace a path belongs to cannot be established`,
    );
  }
  if (!document || typeof document !== 'object' || !('workspaces' in document)) {
    throw new Error(
      `the workspace registry at ${file} has no 'workspaces' list, so which workspace a path belongs to cannot be established`,
    );
  }
  const rows = (document as { workspaces: unknown }).workspaces;
  const entries: RegistryEntry[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (!('path' in record)) continue;
    const root = toWorkspaceRoot(String(record['path']));
    if (!root) continue;
    entries.push({ id: 'id' in record ? String(record['id']) : '', root });
  }
  return entries;
}

export function pathIsInsideWorkspace(fullPath: string, root: string): boolean {
  if (!fullPath || !root) return false;
  const left = fullPath.toLowerCase();
  const right = root.toLowerCase();
  if (left === right) return true;
  return left.startsWith(right + path.sep.toLowerCase());
}

/** The nearest directory at or above `start` that carries a marker, or null. */
export function findWorkspaceByMarker(start: string | null | undefined): string | null {
  if (!start) return null;
  let current: string;
  try {
    current = path.resolve(start);
  } catch {
    return null;
  }
  while (true) {
    if (fs.existsSync(path.join(current, '.library', 'workspace.json'))) {
      const root = toWorkspaceRoot(current);
      if (root) return root;
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// --- which registered workspace a path is in (Resolve-WorkspaceForPath) -------------------------------

export interface WorkspacePlacement {
  kind: 'hook' | 'registered' | 'marker-missing' | 'none';
  workspace: string | null;
  id: string | null;
}

/**
 * `Resolve-WorkspaceForPath`: the hook's own workspace first, then the MOST SPECIFIC registered root,
 * and `marker-missing` for a registered root this machine can no longer characterise.
 */
export function resolveWorkspaceForPath(fullPath: string, hookWorkspace: string | null, registry: RegistryEntry[]): WorkspacePlacement {
  const target = toLocalFullPath(fullPath);
  if (!target) return { kind: 'none', workspace: null, id: null };
  const hookRoot = toWorkspaceRoot(hookWorkspace);
  if (hookRoot && pathIsInsideWorkspace(target, hookRoot)) return { kind: 'hook', workspace: hookRoot, id: null };
  let match: RegistryEntry | null = null;
  for (const entry of registry) {
    if (!pathIsInsideWorkspace(target, entry.root)) continue;
    if (!match || entry.root.length > match.root.length) match = entry;
  }
  if (!match) return { kind: 'none', workspace: null, id: null };
  if (!fs.existsSync(markerPath(match.root)) || !fs.statSync(markerPath(match.root)).isFile()) {
    return { kind: 'marker-missing', workspace: match.root, id: match.id };
  }
  return { kind: 'registered', workspace: match.root, id: match.id };
}

/** `Get-WorkspaceMarkerMissingReason`: one wording, naming the remedy. The registry path is the default one, as the oracle's. */
export function markerMissingReason(workspace: string): string {
  return (
    `${workspace} is registered as a Library workspace but its marker ${markerPath(workspace)} is missing, ` +
    'so this machine cannot establish what is open there and will not read into it. Restore the marker, ' +
    'or remove the workspace from ' + registryPath() + '.'
  );
}

/**
 * `Test-LibraryWorkspaceAnchor`: whether a caller's OWN LOCATION may stand in for a workspace -- the
 * marker, and not a marker the registry maps to a different directory, which is a COPY of that
 * workspace's marker (a plugin install copied one on 2026-09-20). An id the registry has never seen is
 * accepted; only a contradiction refuses. A marker or registry that cannot be read grants nothing.
 */
export function isWorkspaceAnchor(candidate: string | null | undefined, explicitRegistryRoot?: string): boolean {
  if (!candidate || !candidate.trim()) return false;
  const file = markerPath(candidate);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const here = toWorkspaceRoot(candidate);
  if (!here) return false;
  let id = '';
  try {
    id = markerField(JSON.parse(readTextFile(file)) as Record<string, unknown>, 'id');
  } catch {
    return false;
  }
  if (!id.trim()) return false;
  let entries: RegistryEntry[];
  try {
    entries = readRegistry(explicitRegistryRoot);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.id !== id) continue;
    if (entry.root.toLowerCase() !== here.toLowerCase()) return false;
  }
  return true;
}

/**
 * `Get-WorkspaceSelectionConflict`: the refusal a selected workspace owes when the REGISTRY contradicts
 * it, or null. A selection the registry has never heard of is no contradiction; one that sits inside a
 * registered root is not a root at all; a registered root with no marker cannot be characterised; and a
 * root whose marker and registry line carry two ids is a stale index. The cwd-derived answer is named,
 * never used to decide. An unreadable registry or marker THROWS, as the oracle's does.
 */
export function workspaceSelectionConflict(
  selected: string,
  source: string,
  cwdWorkspace: string | null,
  explicitRegistryRoot?: string,
): string | null {
  const registry = readRegistry(explicitRegistryRoot);
  if (registry.length === 0) return null;
  const placed = resolveWorkspaceForPath(selected, null, registry);
  if (placed.kind === 'none') return null;
  const cwdText = cwdWorkspace && cwdWorkspace.trim() ? cwdWorkspace : 'no workspace above the working directory';
  const sourceText = source && source.trim() ? `the ${source} selection` : 'the selection';
  if (placed.kind === 'marker-missing') return markerMissingReason(placed.workspace!);
  const registered = placed.workspace!;
  if (registered.toLowerCase() !== selected.toLowerCase()) {
    return (
      `${sourceText} names ${selected}, which is not a workspace root: it sits inside the registered workspace ` +
      `${registered}. The working directory derives ${cwdText}, and ${registryPath(explicitRegistryRoot)}` +
      ` registers ${registered}. Name the workspace root itself, or register ${selected} as a workspace of its own.`
    );
  }
  const markerId = markerField(readMarker(selected), 'id');
  const registryId = placed.id ?? '';
  if (markerId.trim() && registryId.trim() && markerId !== registryId) {
    return (
      `${sourceText} names ${selected}, whose marker calls it '${markerId}' while ${registryPath(explicitRegistryRoot)}` +
      ` registers that same path as '${registryId}'. The working directory derives ${cwdText}. ` +
      'The marker is the authority: re-register the workspace, or restore the registry line that matches it.'
    );
  }
  return null;
}

/**
 * The anchor every kernel caller offers: the PROGRAM ROOT, as the oracle's hooks and helpers offer
 * their own grandparent. It is admitted only when it is a workspace, which an installed program never
 * is; a binary whose program cannot be found offers none.
 */
export function programAnchor(): string {
  try {
    return programRoot();
  } catch {
    return '';
  }
}

/**
 * `Resolve-LibraryWorkspace`: explicit, then LIBRARY_WORKSPACE, then a walk up from the working
 * directory, then the ANCHOR -- the only candidate that must prove itself before it is offered -- and
 * the chosen one is then held to the registry by `workspaceSelectionConflict`.
 *
 * `none` is NOT a failure and is why this returns a kind rather than throwing. A caller that has
 * nothing to do without a workspace turns it into a refusal itself, in the resolver's own words.
 */
export function resolveWorkspace(options: {
  explicit?: string;
  environmentWorkspace?: string;
  startDirectory?: string;
  anchor?: string;
  registryRoot?: string;
}): ResolvedWorkspace {
  const start = options.startDirectory ?? process.cwd();
  const cwdWorkspace = findWorkspaceByMarker(start);

  const candidates: { source: string; value: string }[] = [];
  const environmentWorkspace =
    options.environmentWorkspace !== undefined
      ? options.environmentWorkspace
      : (process.env['LIBRARY_WORKSPACE'] ?? '');
  for (const pair of [
    { source: 'explicit', value: options.explicit ?? '' },
    { source: 'environment', value: environmentWorkspace },
    { source: 'cwd', value: cwdWorkspace ?? '' },
  ]) {
    if (!pair.value || !pair.value.trim()) continue;
    candidates.push(pair);
  }
  const anchor = options.anchor ?? programAnchor();
  if (anchor.trim() && isWorkspaceAnchor(anchor, options.registryRoot)) candidates.push({ source: 'anchor', value: anchor });

  if (candidates.length === 0) {
    return { kind: 'none', workspace: null, source: null, reason: null, cwd: cwdWorkspace };
  }

  const chosen = candidates[0]!;
  const normalised = toWorkspaceRoot(chosen.value);
  if (!normalised) {
    return {
      kind: 'conflict',
      workspace: null,
      source: chosen.source,
      reason:
        `the ${chosen.source} workspace selection '${chosen.value}' is not ${rootFormName()}, ` +
        'so which workspace this session is about cannot be established',
      cwd: cwdWorkspace,
    };
  }
  const conflict = workspaceSelectionConflict(normalised, chosen.source, cwdWorkspace, options.registryRoot);
  if (conflict) return { kind: 'conflict', workspace: null, source: chosen.source, reason: conflict, cwd: cwdWorkspace };
  return { kind: 'resolved', workspace: normalised, source: chosen.source, reason: null, cwd: cwdWorkspace };
}

export const NO_WORKSPACE_REFUSAL =
  'no Library workspace was selected and none could be derived: pass -WorkspacePath, set LIBRARY_WORKSPACE, ' +
  'or run from inside a workspace. `library init <folder>` creates one.';

/**
 * The one line a verb runs to answer "which workspace", throwing the resolver's own refusal.
 * Passed on verbatim rather than re-worded: a refusal naming three routes beats a second opinion
 * about which one to take.
 */
export function requireWorkspace(options: {
  explicit?: string;
  startDirectory?: string;
  anchor?: string;
  registryRoot?: string;
}): string {
  const resolved = resolveWorkspace(options);
  if (resolved.kind === 'conflict') throw new Error(resolved.reason ?? 'the workspace selection is contradictory');
  if (resolved.kind === 'none') throw new Error(NO_WORKSPACE_REFUSAL);
  return resolved.workspace!;
}
