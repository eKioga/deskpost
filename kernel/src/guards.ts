/**
 * The Desk boundary's PreToolUse guards: `library hook shelf-read`, `library hook shell-shelf-read`
 * (S31) and `library hook basic-memory-read` (S32) -- S20, PLAN-public-release.md; the plugin manifests
 * cannot point at the binary until these exist. The Basic Memory guard is its own section below, and
 * `Guard-BasicMemoryRead.ps1` is its oracle. `library hook settings-integrity` (S36) is the ConfigChange
 * guard, `Guard-SettingsIntegrity.ps1`, and the one that FAILS OPEN; `library hook desk-context` (S36,
 * `deskcontext.ts`) is the UserPromptSubmit context hook, which orients and never denies.
 *
 * The PowerShell originals are `.claude/hooks/Guard-ShelfBookRead.ps1` and `Guard-ShellShelfRead.ps1`,
 * with `HookContext.ps1`, `ShelfBoundary.ps1` and the registry half of `tools/WorkspaceRegistry.ps1`
 * beneath them. The `guards` rows of the acceptance matrix hold this file to their answers, and the
 * three rules that carry the weight are theirs:
 *
 *   A PAYLOAD IN, A DECISION OUT, AND EVERY FAILURE IS A DENIAL. A guard that throws exits non-zero with
 *   nothing on stdout, and Claude Code proceeds past exactly that. So every path out of `runGuard`'s
 *   catch writes a deny, and nothing here returns a permissive default for state it could not read.
 *
 *   THE DESK IS CONSULTED LAST. Only a call that names a Shelf Book reads a seat's Desk, so a session
 *   with no seat can still write `docs/x.md`: the guard does not fail closed on state that path never
 *   needed.
 *
 *   `outside` IS ALLOWED AND `invalid` IS REFUSED. A path form this file cannot place -- `//?/`, UNC, a
 *   device path -- is not a path outside the workspace, and four such spellings walked past the
 *   PowerShell guard on 2026-09-07 while both answers were one.
 *
 * WHAT IS NOT THE ORACLE'S, STATED. The Notebook half judges a write the way THIS kernel's writers do
 * (ADR-0029): see `notebookWriteDenial`. The workspace comes from `resolveWorkspace`, which since S36
 * carries the oracle's anchor (the program root, admitted only on a marker the registry does not
 * contradict) and its selection-conflict refusals, so a contradictory selection fails closed here as it
 * does in the PowerShell guard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { splitBookRoot } from './desk.ts';
import { deskFileEntries, deskFileName, deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { legacyRefusal, migratingRefusal, readNotebookLayout } from './notebooklayout.ts';
import {
  HOST_FLAVOR,
  markerMissingReason,
  posixFullPath,
  readRegistry,
  resolveWorkspace,
  resolveWorkspaceForPath,
  rootFormName,
  toLocalFullPath,
  type PathFlavor,
} from './workspace.ts';
import { claudeHookShapeFaults, hookRegistrationProblems, isObject } from './hookregistry.ts';
import { programRoot } from './programroot.ts';
import { runDeskContextVerb } from './deskcontext.ts';
import { DEFAULT_READER_PREFIX, isReaderPrefix, readerPrefixFault } from './readerprefix.ts';

const EVENT = 'PreToolUse';
const BOOK_ROOT_PATTERN = /^(?:shelf\/_archive|books|archive|shelf)\/[a-z0-9][a-z0-9-]*$/;
export const BOOK_ROOT_ACCEPT_PATTERN = /^(?:(?:shelf\/_archive|books|archive|shelf)\/)?[a-z0-9][a-z0-9-]*$/;
const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

class GuardExit {}

export interface GuardOptions {
  workspace?: string | undefined;
  seat?: string | undefined;
  stateDirectory?: string | undefined;
  /** The reader's callable prefix, which the registration supplies (S38); `readerprefix.ts` says why. */
  readerToolPrefix?: string | undefined;
}

/** The tool a closed Book's denial sends the session to, under the prefix its registration named. */
function readerTool(options: { readerToolPrefix?: string | undefined }): string {
  return `${options.readerToolPrefix || DEFAULT_READER_PREFIX}read_open_book_page`;
}

// --- output ---------------------------------------------------------------------------------------

function denyDocument(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// --- the payload ----------------------------------------------------------------------------------

/**
 * One field of a payload object, or undefined. CASE-INSENSITIVE, because the oracle's payload is a
 * `ConvertFrom-Json` object and PowerShell's property names are: `Tool_Name` reads as `tool_name` there,
 * and a guard that answered differently for the same bytes would be two boundaries.
 */
export function field(object: unknown, name: string): unknown {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const record = object as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) if (key.toLowerCase() === lower) return record[key];
  return undefined;
}

export function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => asText(item)).join(' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `Get-HookCommandText`: the text of a shell command, whatever shape the client wrapped it in. */
export function hookCommandText(toolInput: unknown): string {
  if (toolInput === undefined || toolInput === null) return '';
  for (const name of ['command', 'commands']) {
    const value = field(toolInput, name);
    if (value === undefined || value === null) continue;
    return asText(value);
  }
  const action = field(toolInput, 'action');
  if (action !== undefined && action !== null) {
    const nested = field(action, 'command');
    if (nested !== undefined && nested !== null) return asText(nested);
  }
  // THE FALLBACK SCANS THE SERIALISED INPUT, which is the safe direction for a guard: a Shelf path
  // anywhere in a shell tool's arguments is worth denying, whatever field it arrived in.
  try {
    return JSON.stringify(toolInput);
  } catch {
    return '';
  }
}

// --- where a path sits (ShelfBoundary.ps1) ----------------------------------------------------------

/** `[IO.Path]::IsPathRooted` under .NET Framework: a leading separator, or a drive letter and colon. */
export function dotnetIsPathRooted(value: string): boolean {
  return /^[\\/]/.test(value) || (value.length >= 2 && value[1] === ':');
}

/** Rooted by this platform's rule: .NET's on Windows, and on POSIX a leading separator -- a backslash is one to a guard (S42). */
function isRootedForm(value: string, flavor: PathFlavor = HOST_FLAVOR): boolean {
  return flavor === 'win32' ? dotnetIsPathRooted(value) : /^[\\/]/.test(value);
}

/**
 * `[IO.Path]::GetFullPath` for a drive-rooted Windows path, or null where it throws.
 *
 * MEASURED ON POWERSHELL 5.1, NOT RECALLED (S31). It throws on `* ? < > " |`, on a control character
 * and on a colon past the drive; it strips TRAILING DOTS from each segment (`holding.` is `holding`,
 * which is also what Windows opens) but keeps trailing spaces and keeps an all-dots segment such as
 * `...`; and it collapses repeated separators and resolves `.` and `..`. `path.win32.resolve` does the
 * last of those and none of the others, so a guard built on it alone would read `shelf/holding./x` as
 * no Book at all while the file system opened the closed one.
 */
export function dotnetFullPath(candidate: string): string | null {
  if (/[*?<>"|\u0000-\u001f]/.test(candidate)) return null;
  if (candidate.indexOf(':', 2) >= 0) return null;
  const resolved = path.win32.resolve(candidate);
  const match = /^([A-Za-z]:)(\\.*)?$/.exec(resolved);
  if (!match) return resolved;
  const rest = (match[2] ?? '\\')
    .split('\\')
    .map((segment) => (/^\.+$/.test(segment) ? segment : segment.replace(/\.+$/, '')))
    .join('\\');
  return match[1] + rest;
}

/** `Join-Path`: one separator between the two, and no normalisation, which GetFullPath does after. */
function joinPath(left: string, right: string): string {
  return left.replace(/[\\/]+$/, '') + '\\' + right.replace(/^[\\/]+/, '');
}

export interface Placement {
  kind: 'inside' | 'outside' | 'invalid';
  relative: string | null;
  reason: string | null;
}

/**
 * The POSIX tri-state (S42, the reader's ruling), which no PowerShell oracle has: kernel self-test
 * section 19 is its judge. A backslash is a separator here as everywhere in the guards, which errs toward
 * placing a path in the workspace; a leading `//` and a NUL cannot be placed; `..` is resolved before the
 * prefix test, and the test is case-insensitive, as Windows' is, so a case-sensitive file system's
 * `SHELF/` is judged as `shelf/`. CONCEDED: a symbolic link is not followed, as a junction is not on
 * Windows; a link inside the workspace that points into a closed Book is judged by where it sits.
 */
function posixWorkspaceRelative(target: string, workspace: string): Placement {
  const text = target.replace(/\\/g, '/');
  if (text.startsWith('//')) {
    return {
      kind: 'invalid',
      relative: null,
      reason: `the path form is not ${rootFormName('posix')}, so where it points cannot be established`,
    };
  }
  const root = posixFullPath(workspace) ?? workspace;
  const full = posixFullPath(text.startsWith('/') ? text : root.replace(/\/+$/, '') + '/' + text);
  if (full === null) return { kind: 'invalid', relative: null, reason: 'the path could not be normalised' };
  if (full.toLowerCase() === root.toLowerCase()) return { kind: 'inside', relative: '', reason: null };
  const prefix = root.endsWith('/') ? root : root + '/';
  if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return { kind: 'outside', relative: null, reason: null };
  return { kind: 'inside', relative: full.substring(prefix.length), reason: null };
}

/** `ConvertTo-WorkspaceRelative`: the tri-state, with a forward-slash relative for `inside`. */
export function workspaceRelative(target: string, workspace: string, flavor: PathFlavor = HOST_FLAVOR): Placement {
  if (!target || !target.trim()) return { kind: 'invalid', relative: null, reason: 'the path is empty' };
  if (flavor === 'posix') return posixWorkspaceRelative(target, workspace);
  let candidate = target;
  if (dotnetIsPathRooted(candidate)) {
    // THE WHOLE ALLOWLIST: a drive-rooted local path. `\\?\`, `//?/`, `\\.\`, `\\host\share`, a bare
    // `\x` and `/d/x` all fail it, UNC included, because `\\localhost\D$\` is a UNC path.
    if (!/^[A-Za-z]:[\\/]/.test(candidate)) {
      return {
        kind: 'invalid',
        relative: null,
        reason: 'the path form is not a drive-rooted local path, so where it points cannot be established',
      };
    }
  } else {
    candidate = joinPath(workspace, candidate);
  }
  const normalised = dotnetFullPath(candidate);
  if (normalised === null) return { kind: 'invalid', relative: null, reason: 'the path could not be normalised' };
  const full = normalised.replace(/\\+$/, '');
  if (!/^[A-Za-z]:[\\/]/.test(full)) {
    return { kind: 'invalid', relative: null, reason: 'the normalised path left the drive-rooted form it was accepted as' };
  }
  const root = (dotnetFullPath(workspace) ?? workspace).replace(/\\+$/, '');
  if (full.toLowerCase() === root.toLowerCase()) return { kind: 'inside', relative: '', reason: null };
  if (!full.toLowerCase().startsWith(root.toLowerCase() + '\\')) return { kind: 'outside', relative: null, reason: null };
  return { kind: 'inside', relative: full.substring(root.length + 1).replace(/\\/g, '/'), reason: null };
}

/** `Get-ShelfRootForPath`: the Shelf root a workspace-relative path names, archived form first. */
export function shelfRootForPath(relative: string): string | null {
  let match = /^shelf\/_archive\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i.exec(relative);
  if (match) return `shelf/_archive/${match[1]!.toLowerCase()}`;
  match = /^shelf\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i.exec(relative);
  if (match) return `shelf/${match[1]!.toLowerCase()}`;
  return null;
}

/** `Get-ShelfOpenCommand`: the two shelves take different flags. */
export function shelfOpenCommand(root: string): string {
  const parts = splitBookRoot(root);
  if (parts.shelf === 'archive') {
    return `tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Shelf Archive -Slug ${parts.slug}`;
  }
  return `tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug ${parts.slug}`;
}

function isShelfBrowseSurface(relative: string): boolean {
  return /^shelf\/_catalog\.md$/i.test(relative);
}

function trimStartDotsAndSlashes(value: string): string {
  return value.replace(/^[./]+/, '');
}

/** `Get-ShelfPatternTarget`: the closed root a pattern reaches, `*` for a span, or null. */
export function shelfPatternTarget(pattern: string, openRoots: string[]): string | null {
  if (!pattern || !pattern.trim()) return null;
  const normalised = trimStartDotsAndSlashes(pattern.replace(/\\/g, '/'));
  if (!/^shelf\//i.test(normalised)) return null;
  const root = shelfRootForPath(normalised);
  if (root) return openRoots.includes(root) ? null : root;
  return '*';
}

// --- Codex's apply_patch -----------------------------------------------------------------------------

const APPLY_PATCH_PATH_DIRECTIVES = ['Add File:', 'Update File:', 'Delete File:', 'Move to:'];
const APPLY_PATCH_BARE_DIRECTIVES = ['Begin Patch', 'End Patch', 'End of File'];

/**
 * `Get-ApplyPatchPaths`: every path a patch names, THROWING on a directive it was not taught. An
 * allowlist, because a parser that skips what it does not recognise fails open, silently.
 */
export function applyPatchPaths(patchText: string): string[] {
  if (!patchText || !patchText.trim()) throw new Error('apply_patch carried no patch document.');
  const paths: string[] = [];
  let sawBegin = false;
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.startsWith('*** ')) continue;
    const body = line.substring(4).trim();
    if (APPLY_PATCH_BARE_DIRECTIVES.includes(body)) {
      if (body === 'Begin Patch') sawBegin = true;
      continue;
    }
    const directive = APPLY_PATCH_PATH_DIRECTIVES.find((candidate) => body.startsWith(candidate));
    if (directive === undefined) {
      throw new Error(
        `apply_patch used the directive '${line}', which this guard has not been taught. ` +
          'Refusing rather than guessing which file it names.',
      );
    }
    const named = body.substring(directive.length).trim();
    if (!named) throw new Error(`apply_patch names a '${directive}' directive with no path.`);
    paths.push(named);
  }
  if (!sawBegin) throw new Error('apply_patch carried no "*** Begin Patch" envelope, so its file list cannot be trusted.');
  return paths;
}

// --- the Desk ------------------------------------------------------------------------------------

/** `ConvertTo-BookRoot`: a bare slug is the pre-symmetry spelling of a SHARED Book. */
export function convertToBookRoot(entry: string): string {
  if (BOOK_ROOT_PATTERN.test(entry)) return entry;
  if (BOOK_SLUG_PATTERN.test(entry)) return `books/${entry}`;
  throw new Error('Virtual Desk open-book state is malformed.');
}

/** `Get-OpenShelfRoots`: the Shelf ROOTS open at one seat, never slugs -- an archived twin is another Book. */
export function openShelfRoots(deskDirectory: string): string[] {
  const file = path.join(deskDirectory, deskFileName('books'));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Virtual Desk configuration is missing .open-books.');
  const items = deskFileEntries(file);
  for (const item of items) if (!BOOK_ROOT_ACCEPT_PATTERN.test(item)) throw new Error('Virtual Desk open-book state is malformed.');
  return items
    .map((item) => splitBookRoot(convertToBookRoot(item)))
    .filter((parts) => parts.collection === 'shelf')
    .map((parts) => parts.root);
}

/** `Get-DeskStateDirectory`: one seat's Desk directory, or the seat resolver's own refusal. */
function seatDeskDirectory(stateDirectory: string, seat: string | undefined): string {
  const resolved = resolveSeatName({ seat, stateDirectory });
  if (resolved.status !== 'named') throw new Error(resolved.message);
  return deskStateDirectory(stateDirectory, resolved.seat!);
}

function closedBookDenial(root: string, openRoots: string[], tool: string): string | null {
  if (openRoots.includes(root)) return null;
  const parts = splitBookRoot(root);
  const kind = parts.shelf === 'archive' ? 'Archived Shelf Book' : 'Shelf Book';
  return `${kind} '${parts.slug}' is closed. Open it with ${shelfOpenCommand(root)}, then read its pages with ${tool}.`;
}

// --- another workspace (WorkspaceRegistry.ps1) -------------------------------------------------------

const WORKSPACE_GUARDED_SURFACES = ['shelf', 'notebook'];

/** `Get-CrossWorkspaceDenial`: a path into a DIFFERENT registered workspace, whose Shelf is closed here. */
export function crossWorkspaceDenial(target: string, hookWorkspace: string): string | null {
  if (!target || !target.trim()) return null;
  if (!isRootedForm(target)) return null;
  const registry = readRegistry();
  if (registry.length === 0) return null;
  const placed = resolveWorkspaceForPath(target, hookWorkspace, registry);
  // A workspace this machine can no longer characterise refuses EVERY path into it, surface or not.
  if (placed.kind === 'marker-missing') return markerMissingReason(placed.workspace!);
  if (placed.kind !== 'registered') return null;
  const full = toLocalFullPath(target)!;
  const relative = full.substring(placed.workspace!.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const surface = (relative.split('/')[0] ?? '').toLowerCase();
  if (!WORKSPACE_GUARDED_SURFACES.includes(surface)) return null;
  return (
    `${relative} is in the Library workspace at ${placed.workspace}, which is not this workspace. ` +
    'Nothing is open there: a Desk belongs to a seat in a session, and this session holds no seat in that ' +
    'workspace, so its Shelf and Notebook are closed here whatever their own Desk says. Open a seat in that ' +
    'workspace and read the page there.'
  );
}

// --- writing into notebook/ ------------------------------------------------------------------------

const NOTEBOOK_WRITE_OPERATION = 'Writing into notebook/';

/**
 * A direct write into `notebook/`, judged the way THIS KERNEL'S writers judge one (ADR-0029), which is
 * the oracle's own principle: "a guard that permitted what the helpers refuse would teach the reader a
 * rule the rest of the system does not have." So it is the oracle's rule only where the two layouts
 * agree -- a session with no seat is refused, in the same words -- and the kernel's everywhere else:
 *
 *   seat-owned   a write under `notebook/<this seat>/` is allowed; another seat's root, or a file
 *                directly under `notebook/`, is refused, because under ADR-0029 a topic belongs to the
 *                seat whose Notebook holds it and nothing else is a Notebook page.
 *   legacy       refused, naming `library migrate`: this kernel writes only a seat's own Notebook (the
 *                reader's ruling, S18), and the PowerShell guard keeps judging the shared layout.
 *   migrating    refused, naming `--resume` and `--rollback`: a half-moved Notebook answers wrongly.
 *   fresh        refused until the layout is active. A direct write into `notebook/<seat>/` would put a
 *                folder under `notebook/` with no layout record, which `legacyNotebookMaterial` reads as
 *                a shared-tree topic -- the write would turn a fresh workspace legacy. Any kernel
 *                Notebook write activates it; `library notebook render` is the one that writes nothing
 *                else.
 */
export function notebookWriteDenial(options: {
  target: string;
  workspace: string;
  toolName: string;
  seat: string | undefined;
  stateDirectory: string;
}): string | null {
  if (!['Write', 'Edit', 'apply_patch'].includes(options.toolName)) return null;
  const placed = workspaceRelative(options.target, options.workspace);
  if (placed.kind !== 'inside') return null;
  const relative = placed.relative ?? '';
  if (!relative) return null;
  if (!/^notebook\//i.test(relative)) return null;

  const resolved = resolveSeatName({ seat: options.seat, stateDirectory: options.stateDirectory });
  if (resolved.status !== 'named') {
    return (
      'Writing into notebook/ needs a seat, and this session has none, so it would leave material in a ' +
      "seat's namespace with no claim, no ownership record and no rendered index. " + resolved.message
    );
  }
  const seat = resolved.seat!;
  const layout = readNotebookLayout(options.workspace);
  if (layout.state === 'migrating') return migratingRefusal(NOTEBOOK_WRITE_OPERATION);
  if (layout.state === 'legacy') return legacyRefusal(NOTEBOOK_WRITE_OPERATION, layout);
  if (layout.state === 'fresh') {
    return (
      `${NOTEBOOK_WRITE_OPERATION} refused: this workspace's seat-owned Notebook is not active yet (ADR-0029), and a file ` +
      `written straight into notebook/${seat}/ would make it read as the shared layout instead. Run ` +
      `'library notebook render --seat ${seat}' once to activate it, then write the page again.`
    );
  }
  const owner = relative.split('/')[1] ?? '';
  if (relative.split('/').length < 3) {
    return (
      `${NOTEBOOK_WRITE_OPERATION} refused: '${relative}' is directly under notebook/, and under ADR-0029 every Notebook page ` +
      `lives under a seat's own root. This session's is notebook/${seat}/.`
    );
  }
  if (owner.toLowerCase() !== seat) {
    return (
      `${NOTEBOOK_WRITE_OPERATION} refused: '${relative}' is under notebook/${owner}/, which is seat '${owner}''s Notebook, ` +
      `and this session is at seat '${seat}'. A topic belongs to the seat whose Notebook holds it (ADR-0029); write under ` +
      `notebook/${seat}/ instead.`
    );
  }
  return null;
}

// --- the two guards ----------------------------------------------------------------------------------

interface GuardContext {
  workspace: string;
  stateDirectory: string;
  seat: string | undefined;
  call: unknown;
  readerTool: string;
}

function guardContext(options: GuardOptions, stdinText: string, deny: (reason: string) => never): GuardContext {
  let selected = options.workspace ?? '';
  if (!selected && options.stateDirectory) selected = path.dirname(options.stateDirectory);
  const resolved = resolveWorkspace({ explicit: selected });
  if (resolved.kind === 'conflict') deny(`Virtual Desk failed closed: ${resolved.reason ?? ''}`);
  const workspace = resolved.workspace ?? '';
  const stateDirectory = options.stateDirectory ?? (workspace ? path.join(workspace, '.claude') : '');
  const raw = stdinText.replace(/^﻿/, '');
  const call = raw.trim() ? (JSON.parse(raw) as unknown) : null;
  return { workspace, stateDirectory, seat: options.seat, call, readerTool: readerTool(options) };
}

function shelfTargetRoot(target: string, base: string): { root: string | null; denial: string | null } {
  const placed = workspaceRelative(target, base);
  if (placed.kind === 'outside') return { root: null, denial: null };
  if (placed.kind === 'invalid') {
    return {
      root: null,
      denial:
        `Virtual Desk cannot establish where '${target}' points: ${placed.reason}. Name it as a path ` +
        `relative to the workspace, or as ${rootFormName()}.`,
    };
  }
  const relative = placed.relative ?? '';
  if (!relative) return { root: null, denial: null };
  if (!/^shelf\//i.test(relative)) return { root: null, denial: null };
  if (isShelfBrowseSurface(relative)) return { root: null, denial: null };
  const root = shelfRootForPath(relative);
  if (!root) return { root: null, denial: 'Virtual Desk requires a canonical Shelf path.' };
  return { root, denial: null };
}

/** `Guard-ShelfBookRead.ps1`: Read, Grep, Glob, Write, Edit and apply_patch. */
function shelfReadGuard(context: GuardContext, deny: (reason: string) => never): void {
  const { workspace, stateDirectory, seat, call } = context;
  const toolName = asText(field(call, 'tool_name'));
  const toolInput = field(call, 'tool_input');

  let openRootsCache: string[] | null = null;
  const openRoots = (): string[] => {
    if (openRootsCache === null) openRootsCache = openShelfRoots(seatDeskDirectory(stateDirectory, seat));
    return openRootsCache;
  };

  const patterns: string[] = [];
  if (workspace) {
    const glob = field(toolInput, 'glob');
    if (glob !== undefined && glob !== null) patterns.push(asText(glob));
    if (toolName === 'Glob') {
      const pattern = field(toolInput, 'pattern');
      if (pattern !== undefined && pattern !== null) patterns.push(asText(pattern));
    }
  }
  for (const pattern of patterns) {
    if (!/^shelf\//i.test(trimStartDotsAndSlashes(pattern.replace(/\\/g, '/')))) continue;
    const target = shelfPatternTarget(pattern, openRoots());
    if (target === '*') {
      deny(
        'That pattern spans Shelf Books that are closed. Narrow it to an open Book, or open the one you need with ' +
          'tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>.',
      );
    }
    if (target) {
      deny(`Shelf Book '${splitBookRoot(target).slug}' is closed. Open it with ${shelfOpenCommand(target)}, then read its pages with ${context.readerTool}.`);
    }
  }

  if (toolName === 'apply_patch') {
    const patchText = asText(field(toolInput, 'command'));
    const patchCwd = asText(field(call, 'cwd'));
    for (const named of applyPatchPaths(patchText)) {
      const readings = [named];
      if (patchCwd.trim() && !isRootedForm(named)) readings.push(joinPath(patchCwd, named));
      for (const reading of readings) {
        let denial = crossWorkspaceDenial(reading, workspace);
        if (!denial && workspace) {
          const judged = shelfTargetRoot(reading, workspace);
          denial = judged.denial;
          if (!denial && judged.root) denial = closedBookDenial(judged.root, openRoots(), context.readerTool);
          if (!denial) denial = notebookWriteDenial({ target: reading, workspace, toolName, seat, stateDirectory });
        }
        if (denial) deny(`This patch writes '${named}'. ${denial}`);
      }
    }
    return;
  }

  const filePath = field(toolInput, 'file_path');
  const pathField = field(toolInput, 'path');
  const target = filePath !== undefined && filePath !== null ? asText(filePath) : pathField !== undefined && pathField !== null ? asText(pathField) : '';
  if (!target.trim()) return;

  const cross = crossWorkspaceDenial(target, workspace);
  if (cross) deny(cross);
  if (!workspace) return;

  const judged = shelfTargetRoot(target, workspace);
  let denial = judged.denial;
  if (!denial && judged.root) denial = closedBookDenial(judged.root, openRoots(), context.readerTool);
  if (!denial) denial = notebookWriteDenial({ target, workspace, toolName, seat, stateDirectory });
  if (denial) deny(denial);
}

// --- the shell guard's text rules (Guard-ShellShelfRead.ps1) ---------------------------------------

/**
 * `Remove-HeredocBodies`: a QUOTED-delimiter heredoc body is data, and the one exemption. The
 * delimiter is captured with its quote -- `(['"])(\w+)\1` -- rather than as two alternatives, because
 * a JavaScript backreference to a group that did not participate matches the empty string where .NET's
 * fails, and the oracle's `(?:\1|\2)` would then have ended every body at the first blank line.
 */
export function removeHeredocBodies(text: string): string {
  return text.replace(/<<-?\s*(['"])(\w+)\1([^\n]*)\n[\s\S]*?^\s*\2\s*$/gm, ' $3 <<heredoc-body-elided ');
}

/** `ConvertTo-PathSeparators`: a backslash separates only where it introduces a segment; else it breaks the token. */
export function convertToPathSeparators(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch !== '\\') {
      out += ch;
      map.push(index);
      continue;
    }
    if (index + 1 >= text.length) continue;
    const next = text[index + 1]!;
    if (next === '\\' || next === '/' || /^[A-Za-z0-9_]$/.test(next)) {
      out += '/';
      map.push(index);
      continue;
    }
    out += ' ';
    map.push(index);
    index += 1;
  }
  return { text: out, map };
}

/** `Get-ShelfTokens`: every `shelf/<something>` the command names, with the command's own characters. */
export function shelfTokens(command: string): { token: string; text: string }[] {
  if (!command || !command.trim()) return [];
  const stripped = removeHeredocBodies(command);
  const normalised = convertToPathSeparators(stripped);
  const seen = new Set<string>();
  const hits: { token: string; text: string }[] = [];
  for (const match of normalised.text.matchAll(/(?<![A-Za-z0-9_.-])shelf\**\/[A-Za-z0-9_*?.[\]/-]+/gi)) {
    const canonical = match[0].replace(/^(shelf)\*+\//i, '$1/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    if (canonical.toLowerCase() === 'shelf') continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const from = normalised.map[match.index!]!;
    const to = normalised.map[match.index! + match[0].length - 1]!;
    hits.push({ token: canonical, text: stripped.substring(from, to + 1) });
  }
  return hits;
}

const PATTERN_REMEDY =
  'If that text is a search pattern rather than a path, the Grep tool is judged on its path and glob, never on its pattern.';

function formatMatchedText(text: string): string {
  if (text.length > 120) return `'${text.substring(0, 117)}...'`;
  return `'${text}'`;
}

/** `Guard-ShellShelfRead.ps1`: a shell command, judged on its literal text. */
function shellShelfReadGuard(context: GuardContext, deny: (reason: string) => never): void {
  const { workspace, stateDirectory, seat, call } = context;
  const command = hookCommandText(field(call, 'tool_input'));
  if (!command.trim()) return;

  // A POSIX command names another workspace by a `/`-rooted token, which a letter, digit or one of
  // `_.~$-` before it makes part of a word (`sed s/a/b/`, `$HOME/x`, `~/x`) rather than a path (S42).
  const rootedToken = HOST_FLAVOR === 'win32' ? /[A-Za-z]:\/[^\s"'|;&<>]*/gi : /(?<![A-Za-z0-9_.~$-])\/[^\s"'|;&<>]*/g;
  for (const rooted of convertToPathSeparators(command).text.matchAll(rootedToken)) {
    const cross = crossWorkspaceDenial(rooted[0], workspace);
    if (cross) deny(`This command names '${rooted[0]}'. ${cross}`);
  }
  if (!workspace) return;

  const hits = shelfTokens(command);
  if (hits.length === 0) return;
  const roots = openShelfRoots(seatDeskDirectory(stateDirectory, seat));
  for (const hit of hits) {
    if (isShelfBrowseSurface(hit.token)) continue;
    const target = shelfPatternTarget(hit.token, roots);
    if (target === null) continue;
    const quoted = formatMatchedText(hit.text);
    if (target === '*') {
      deny(
        `This command's text ${quoted} spans Shelf Books that are closed. Narrow it to an open Book, or open the one you need with ` +
          `tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>. ${PATTERN_REMEDY}`,
      );
    }
    const parts = splitBookRoot(target);
    const kind = parts.shelf === 'archive' ? 'Archived Shelf Book' : 'Shelf Book';
    deny(
      `${kind} '${parts.slug}' is closed, and a shell command cannot read around that. This command names it as ${quoted}. ` +
        `Open it with ${shelfOpenCommand(target)}, then read its pages with ${context.readerTool}. ${PATTERN_REMEDY}`,
    );
  }
}

// --- the Basic Memory guard (Guard-BasicMemoryRead.ps1) ---------------------------------------------

/**
 * A property the oracle reads under `Set-StrictMode -Version Latest`, which throws when it is absent --
 * on `$null`, on an array and on a string as on an object without it -- and the catch turns that into
 * a denial carrying PowerShell's own sentence. A property that is PRESENT and null is not absent.
 */
function strictProperty(object: unknown, name: string): unknown {
  if (object !== null && typeof object === 'object' && !Array.isArray(object)) {
    const record = object as Record<string, unknown>;
    const lower = name.toLowerCase();
    for (const key of Object.keys(record)) if (key.toLowerCase() === lower) return record[key];
  }
  throw new Error(`The property '${name}' cannot be found on this object. Verify that the property exists.`);
}

function hasProperty(object: unknown, name: string): boolean {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return false;
  const lower = name.toLowerCase();
  return Object.keys(object as Record<string, unknown>).some((key) => key.toLowerCase() === lower);
}

/**
 * A .NET regex ending in `$`, as JavaScript. .NET's `$` also matches BEFORE A FINAL NEWLINE, so the
 * oracle accepts `projects/demo\n` where a JavaScript `$` would not; a port that was stricter here
 * would deny what the PowerShell guard allows, and the two would be two boundaries.
 */
function dotnetTest(pattern: string, value: string, flags = ''): boolean {
  return new RegExp(pattern.replace(/\$(?=\)|$)/g, '\\n?$'), flags).test(value);
}

const BASIC_MEMORY_PREFIX = 'mcp__basic-memory__';
const CODEX_BASIC_MEMORY_PREFIX = 'mcp__basic_memory__';
const BASIC_MEMORY_READERS = [
  'mcp__basic-memory__read_note',
  'mcp__basic-memory__read_content',
  'mcp__basic-memory__view_note',
  'mcp__basic-memory__fetch',
  'mcp__basic-memory__search',
  'mcp__basic-memory__search_notes',
  'mcp__basic-memory__build_context',
  'mcp__basic-memory__recent_activity',
];
const BASIC_MEMORY_WRITERS = ['mcp__basic-memory__write_note', 'mcp__basic-memory__edit_note'];
const IDEMPOTENT_EDIT_OPERATIONS = ['replace_section', 'find_replace'];
const PROJECT_ROOT_PATTERN = /^(projects|archive\/projects)\/[a-z0-9][a-z0-9-]*$/;
const PIN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `Read-StateLines`: one Desk file, every line well-formed and none repeated. */
export function readStateLines(file: string, pattern: RegExp, label: string, optional: boolean): string[] {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (!optional) throw new Error(`Virtual Desk configuration is missing ${label}.`);
    // THE ORACLE WRITES THE MISSING OPTIONAL FILE, empty, and a port that did not would leave a
    // different workspace behind the same call.
    writeAtomicText(file, '');
    return [];
  }
  const items = deskFileEntries(file);
  for (const item of items) if (!dotnetTest(pattern.source, item)) throw new Error(`Virtual Desk ${label} state is malformed.`);
  if (new Set(items).size !== items.length) throw new Error(`Virtual Desk ${label} state contains duplicates.`);
  return items;
}

/** `Get-DeskState`: the pin every seat shares, and this seat's open shared Books and Projects. */
function basicMemoryDeskState(stateDirectory: string, seat: string | undefined): { pin: string; books: string[]; projects: string[] } {
  const directory = seatDeskDirectory(stateDirectory, seat);
  const pinFile = path.join(stateDirectory, '.library-project');
  if (!fs.existsSync(pinFile) || !fs.statSync(pinFile).isFile()) throw new Error('Virtual Desk configuration is missing .library-project.');
  const pin = fs.readFileSync(pinFile, 'utf8').replace(/^﻿/, '').trim();
  if (!PIN_PATTERN.test(pin)) throw new Error('Virtual Desk project pin is malformed.');
  // THE ROOT IS KEPT, never reduced to a slug: `books/<slug>` and `archive/<slug>` are two Books.
  const books = readStateLines(path.join(directory, deskFileName('books')), BOOK_ROOT_ACCEPT_PATTERN, 'open-book', false)
    .map((item) => splitBookRoot(convertToBookRoot(item)))
    .filter((parts) => parts.collection === 'shared')
    .map((parts) => parts.root);
  const projects = readStateLines(path.join(directory, deskFileName('projects')), PROJECT_ROOT_PATTERN, 'open-project', true);
  return { pin, books, projects };
}

/** `Test-CanonicalPath`: no backslash, no leading, doubled, `.` or `..` segment, and a plain alphabet. */
function isCanonicalDirectory(value: string): boolean {
  return (
    value.length > 0 &&
    !/[\\]/.test(value) &&
    !dotnetTest('(^/|//|(^|/)\\.\\.(/|$)|(^|/)\\./)', value, 'i') &&
    dotnetTest('^[A-Za-z0-9._/-]+$', value, 'i')
  );
}

/** `Test-DotSegment`: a `.` or `..` segment is never a page name (S32). */
function hasDotSegment(value: string): boolean {
  return dotnetTest('(^|/)\\.{1,2}(/|$)', value, 'i');
}

/** `Test-ActiveProjectWrite`: an exact page path under a Project Hub open at this seat. */
function isActiveProjectWrite(toolInput: unknown, openProjects: string[]): boolean {
  let projectRoot: string | null = null;
  if (hasProperty(toolInput, 'directory')) {
    const directory = asText(strictProperty(toolInput, 'directory'));
    const title = asText(strictProperty(toolInput, 'title'));
    if (!dotnetTest('^projects/[a-z0-9][a-z0-9-]*(?:/[A-Za-z0-9._-]+)*$', directory)) return false;
    if (!dotnetTest('^(?:_project|[A-Za-z0-9][A-Za-z0-9 _.-]*)$', title, 'i')) return false;
    if (hasDotSegment(directory)) return false;
    const parts = directory.split('/');
    projectRoot = `${parts[0]}/${parts[1]}`;
  } else if (hasProperty(toolInput, 'identifier')) {
    const identifier = asText(strictProperty(toolInput, 'identifier'));
    if (!dotnetTest('^projects/[a-z0-9][a-z0-9-]*(?:/[A-Za-z0-9._ -]+)*$', identifier)) return false;
    if (hasDotSegment(identifier)) return false;
    const parts = identifier.split('/');
    projectRoot = `${parts[0]}/${parts[1]}`;
  }
  if (projectRoot === null) return false;
  return openProjects.includes(projectRoot);
}

/** `Test-EditOperationAllowed`: the two operations safe to repeat, compared exactly; no operation is refused. */
function isEditOperationAllowed(toolInput: unknown): boolean {
  if (!hasProperty(toolInput, 'operation')) return false;
  return IDEMPOTENT_EDIT_OPERATIONS.includes(asText(strictProperty(toolInput, 'operation')));
}

/** `Test-HubRootWrite`: `projects/<slug>` exactly, titled as its root page. */
function isHubRootWrite(toolInput: unknown): boolean {
  if (!hasProperty(toolInput, 'directory') || !hasProperty(toolInput, 'title')) return false;
  if (!dotnetTest('^projects/[a-z0-9][a-z0-9-]*$', asText(strictProperty(toolInput, 'directory')))) return false;
  return ['_project', '_project.md'].includes(asText(strictProperty(toolInput, 'title')));
}

const DUPLICATING_EDIT_DENIAL =
  'Only the edit_note operations replace_section and find_replace take this direct path. append, prepend, insert_before_section and ' +
  'insert_after_section duplicate content silently when applied twice, and nothing here journals a previous body or reads back what it ' +
  'wrote; any other operation is one this guard has not been taught. Use replace_section or find_replace, or go through ' +
  'tools/Edit-ProjectHub.ps1, which journals, locks and verifies.';

const HUB_ROOT_DENIAL =
  "A Project Hub's root page is the one page every session touches, so a whole-page overwrite of it goes through " +
  'tools/Edit-ProjectHub.ps1 -- which journals the previous body, holds the projects/<slug> lock across the write, and ' +
  'verifies the readback. Every other page under projects/<slug>/ still takes this direct path.';

/**
 * `Guard-BasicMemoryRead.ps1`: every `mcp__basic-memory__*` call, and Codex's `mcp__basic_memory__*` (S38).
 *
 * NO WORKSPACE IS A DENIAL HERE, unlike the Shelf guards: this one is asked about a SHARED Book, and
 * only a Desk in a workspace can open one. And THE DESK IS READ FIRST, before the tool is even named,
 * because every call it sees needs it -- so a seatless session is refused in the seat resolver's words
 * whatever it called. Every tool name is compared exactly (S32).
 */
function basicMemoryReadGuard(options: GuardOptions, stdinText: string, deny: (reason: string) => never): void {
  let stateDirectory = options.stateDirectory ?? '';
  if (!stateDirectory) {
    const resolved = resolveWorkspace({ explicit: options.workspace ?? '' });
    if (resolved.kind === 'conflict') throw new Error(resolved.reason ?? '');
    if (resolved.kind !== 'resolved' || !resolved.workspace) {
      throw new Error(
        'this session is in no Library workspace, so there is no Desk and no Book is open. ' +
          'Run from inside a workspace, set LIBRARY_WORKSPACE, or create one with `library init <folder>`.',
      );
    }
    stateDirectory = path.join(resolved.workspace, '.claude');
  }
  const raw = stdinText.replace(/^﻿/, '');
  const call = raw.trim() ? (JSON.parse(raw) as unknown) : null;
  const state = basicMemoryDeskState(stateDirectory, options.seat);
  const toolName = asText(strictProperty(call, 'tool_name'));
  // CODEX SPELLS THE SERVER `basic_memory` (S38): it turns a server's hyphens into underscores in every
  // tool name it offers and in a PreToolUse tool_name (measured S37), so a Codex call is judged as the
  // same tool. Only the exact lowercase prefix is rewritten, so the exact-case rule holds, and the
  // "blocks" sentence still quotes the name the harness sent.
  const judgedName = toolName.startsWith(CODEX_BASIC_MEMORY_PREFIX)
    ? BASIC_MEMORY_PREFIX + toolName.substring(CODEX_BASIC_MEMORY_PREFIX.length)
    : toolName;
  const toolInput = strictProperty(call, 'tool_input');
  if (asText(strictProperty(toolInput, 'project_id')) !== state.pin) deny('Virtual Desk requires the pinned project_id.');
  if (hasProperty(toolInput, 'project')) {
    const project = strictProperty(toolInput, 'project');
    if (project !== null && project !== undefined && asText(project).trim()) deny('Virtual Desk does not permit project-name routing.');
  }

  if (BASIC_MEMORY_READERS.includes(judgedName)) {
    deny('Direct shared-content readers and search are suspended pending a return-validating adapter.');
  }
  if (BASIC_MEMORY_WRITERS.includes(judgedName)) {
    if (!isActiveProjectWrite(toolInput, state.projects)) deny('Direct shared writes are limited to an exact open active Project Hub path.');
    if (judgedName === 'mcp__basic-memory__edit_note' && !isEditOperationAllowed(toolInput)) deny(DUPLICATING_EDIT_DENIAL);
    if (judgedName === 'mcp__basic-memory__write_note' && isHubRootWrite(toolInput)) deny(HUB_ROOT_DENIAL);
    return;
  }
  if (judgedName !== 'mcp__basic-memory__list_directory') deny(`Virtual Desk blocks Basic Memory tool '${toolName}'.`);

  const target = asText(strictProperty(toolInput, 'dir_name'));
  if (!isCanonicalDirectory(target)) deny('Virtual Desk requires a canonical directory path.');
  if (['books', 'projects', 'archive/projects'].includes(target)) return;
  // `archive` is NOT allowed wholesale the way `books` is: it would disclose which Books were retired.
  for (const root of [...state.books, ...state.projects]) if (target === root || target.startsWith(`${root}/`)) return;
  deny('That Book or Project is closed, or the directory is outside the safe discovery boundary.');
}

// --- the settings guard (Guard-SettingsIntegrity.ps1) -----------------------------------------------

const SETTINGS_EVENT = 'ConfigChange';
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

/**
 * A settings file's text as `[IO.File]::ReadAllText | ConvertFrom-Json` reads it, or the sentence it
 * refuses with. Blank text is NULL, not an error, as in the oracle. Two refusals are .NET's own words,
 * because they are decisions JSON.parse would not make -- an empty key, and two keys differing only in
 * case (measured on 5.1, S36). A syntax error is worded by this engine: its sentence is not the oracle's,
 * and the refusal is.
 */
export function readSettingsTree(file: string): { tree: unknown; error: string | null } {
  const bytes = fs.readFileSync(file);
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else text = bytes.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) return { tree: null, error: null };
  let tree: unknown;
  try {
    tree = JSON.parse(text) as unknown;
  } catch (error) {
    return { tree: null, error: (error as Error).message };
  }
  const walk = (value: unknown): string | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (value === null || typeof value !== 'object') return null;
    const seen: string[] = [];
    for (const key of Object.keys(value)) {
      if (key === '') {
        return 'Cannot process argument because the value of argument "name" is not valid. Change the value of the "name" argument and run the operation again.';
      }
      const twin = seen.find((earlier) => earlier.toLowerCase() === key.toLowerCase());
      if (twin !== undefined) {
        return `Cannot convert the JSON string because a dictionary that was converted from the string contains the duplicated keys '${twin}' and '${key}'.`;
      }
      seen.push(key);
    }
    for (const key of Object.keys(value)) {
      const found = walk((value as Record<string, unknown>)[key]);
      if (found) return found;
    }
    return null;
  };
  const refused = walk(tree);
  return refused ? { tree: null, error: refused } : { tree, error: null };
}

function settingsDocument(fields: Record<string, string>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: SETTINGS_EVENT, ...fields } });
}

/**
 * `Guard-SettingsIntegrity.ps1`: a settings file edited DURING a session, refused when it no longer
 * parses, when its hooks block has a shape Claude Code skips, or when it stops registering a
 * load-bearing guard under the event that guard acts on. An optional hook dropped is allowed and said.
 *
 * IT FAILS OPEN, unlike every other guard here, and that is the oracle's own asymmetry: this hook stands
 * between the reader and their own configuration, and a defect that refused every edit would lock them
 * out of the one file that could disable it. So the caller returns silence on a throw.
 *
 * WHICH `.claude/` IT JUDGES is the oracle's rule: the one named, or else the PROGRAM's -- the oracle's
 * `Split-Path -Parent $PSScriptRoot`. `library init` registers this hook in no reader's workspace.
 */
function settingsIntegrityGuard(options: GuardOptions, stdinText: string): string {
  const stateDirectory = options.stateDirectory && options.stateDirectory.trim() ? options.stateDirectory : path.join(programRoot(), '.claude');
  const raw = stdinText.replace(/^﻿/, '');
  const call = raw.trim() ? (JSON.parse(raw) as unknown) : null;
  // `source`, MEASURED, NOT `config_source`, ASSUMED: see the oracle's account of thirteen open days.
  const source = asText(field(call, 'source'));
  if (source !== 'project_settings' && source !== 'local_settings') return '';

  const files = SETTINGS_FILES.map((name) => path.join(stateDirectory, name)).filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (files.length === 0) {
    return settingsDocument({
      permissionDecision: 'deny',
      permissionDecisionReason: 'That change would leave .claude/ with no settings file, and the Virtual Desk guards are defined there.',
    });
  }
  const trees: unknown[] = [];
  for (const file of files) {
    const read = readSettingsTree(file);
    if (read.error !== null) {
      return settingsDocument({
        permissionDecision: 'deny',
        permissionDecisionReason: `${path.basename(file)} is no longer valid JSON: ${read.error}. The previous settings stay in force; fix the file and save again.`,
      });
    }
    trees.push(read.tree);
  }

  // THE SHAPE BEFORE THE REGISTRATION: a file the harness will not load registers nothing at all. A tree
  // with no `hooks` key is skipped -- settings.local.json may legitimately hold none.
  const shapeFaults: string[] = [];
  trees.forEach((tree, index) => {
    if (!isObject(tree) || !Object.prototype.hasOwnProperty.call(tree, 'hooks') || tree['hooks'] === null) return;
    shapeFaults.push(...claudeHookShapeFaults(tree, path.basename(files[index]!)));
  });
  if (shapeFaults.length) {
    return settingsDocument({
      permissionDecision: 'deny',
      permissionDecisionReason:
        'That change would leave a hooks block Claude Code will not load: ' + shapeFaults.join('; ') + '. A settings file whose hooks block is malformed is skipped ' +
        'ENTIRELY by the harness, so every Virtual Desk guard defined in it would go silent. The previous settings stay in force.',
    });
  }

  const problems = hookRegistrationProblems(trees);
  const blocking = problems.filter((problem) => !problem.optional);
  if (blocking.length) {
    return settingsDocument({
      permissionDecision: 'deny',
      permissionDecisionReason: `That change would disable a load-bearing Virtual Desk guard: ${blocking.map((problem) => problem.detail).join('; ')}. The previous settings stay in force.`,
    });
  }
  const advisory = problems.filter((problem) => problem.optional);
  if (advisory.length) {
    return settingsDocument({ systemMessage: `Settings accepted. Not registered after this change: ${advisory.map((problem) => problem.detail).join('; ')}.` });
  }
  return '';
}

// --- the verb ----------------------------------------------------------------------------------------

export const HOOK_ACTIONS = ['shelf-read', 'shell-shelf-read', 'basic-memory-read', 'settings-integrity', 'desk-context'] as const;

/**
 * Run one guard over one payload and return what goes on stdout: a deny document, or '' to allow.
 *
 * EVERY THROW BELOW IS A DENIAL. A guard's stdout is the only thing a harness reads, and an exit with
 * nothing on it is a call the harness lets through.
 */
export function runGuard(action: string, options: GuardOptions, stdinText: string): string {
  // THE ONE GUARD THAT FAILS OPEN: see settingsIntegrityGuard.
  if (action === 'settings-integrity') {
    try {
      return settingsIntegrityGuard(options, stdinText);
    } catch {
      return '';
    }
  }
  let decision = '';
  const deny = (reason: string): never => {
    decision = denyDocument(reason);
    throw new GuardExit();
  };
  try {
    // The Basic Memory guard resolves its own workspace and payload: its order differs from the Shelf
    // guards' (no workspace is a denial, and the Desk is read before the tool is named).
    if (action === 'basic-memory-read') basicMemoryReadGuard(options, stdinText, deny);
    else {
      // A PREFIX THAT NAMES NO TOOL IS A BROKEN REGISTRATION (S38), refused before the workspace is even
      // resolved, as the oracle does: a denial naming a tool that does not exist sends the session nowhere.
      const prefix = options.readerToolPrefix || DEFAULT_READER_PREFIX;
      if (!isReaderPrefix(prefix)) deny(`Virtual Desk failed closed: ${readerPrefixFault(prefix)}`);
      const context = guardContext(options, stdinText, deny);
      if (action === 'shelf-read') shelfReadGuard(context, deny);
      else if (action === 'shell-shelf-read') shellShelfReadGuard(context, deny);
      else throw new Error(`library hook has no guard '${action}'. It has: ${HOOK_ACTIONS.join(', ')}.`);
    }
  } catch (error) {
    if (!(error instanceof GuardExit)) decision = denyDocument(`Virtual Desk failed closed: ${(error as Error).message ?? String(error)}`);
  }
  return decision;
}

/** `library hook <guard> [--workspace <p>] [--seat <s>] [--state-directory <d>] [--reader-tool-prefix <p>]`, payload on stdin. */
export function runHookVerb(argv: string[]): { stdout: string; refusal: string | null } {
  const action = argv[0] ?? '';
  if (!(HOOK_ACTIONS as readonly string[]).includes(action)) {
    return { stdout: '', refusal: `library hook needs a guard: ${HOOK_ACTIONS.join(' or ')}. Its payload is read from stdin.` };
  }
  let stdinText = '';
  try {
    stdinText = fs.readFileSync(0, 'utf8');
  } catch {
    stdinText = '';
  }
  // The Desk context hook is not a guard: it orients, never denies, and takes its own arguments.
  if (action === 'desk-context') return { stdout: runDeskContextVerb(argv.slice(1), stdinText), refusal: null };
  const parsed = parseArguments(argv.slice(1), ['workspace', 'seat', 'state-directory', 'reader-tool-prefix']);
  return {
    stdout: runGuard(
      action,
      {
        workspace: parsed.options.get('workspace'),
        seat: parsed.options.get('seat'),
        stateDirectory: parsed.options.get('state-directory'),
        readerToolPrefix: parsed.options.get('reader-tool-prefix'),
      },
      stdinText,
    ),
    refusal: null,
  };
}
