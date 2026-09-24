/**
 * One writable workspace per collection: the backend states and the fence every shared write passes
 * (PLAN-public-release.md step 21, ADR-0030; S33). The PowerShell original is
 * `tools/CollectionOwnership.ps1` -- `Get-CollectionBackendState`, `Read-CollectionOwnership` and
 * `Assert-CollectionWriteAllowed` -- and its refusals are carried word for word, because a reader asking
 * "why was that refused" must get the same sentence from either implementation.
 *
 * AND THE ROLE ITSELF (S43): `library collection owner` is `Set-CollectionOwner.ps1`, status, acquire and
 * release, over `Enter-CollectionOwnership` and `Exit-CollectionOwnership`. The record is a directory of
 * per-incarnation claims and releases, never rewritten, and the current owner is derived from it -- see the
 * oracle's header for why. It is judged by kernel self-test section 28, not compared: two implementations
 * can both take a lock and still interleave, so the property is exclusivity under contention.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { markerField, readMarker } from './workspace.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { utcRoundTrip } from './journal.ts';
import { parseArguments } from './argv.ts';
import { configuredCollectionId, configuredMcpUrl, configuredSharedRoot } from './basicmemory.ts';

const OWNERSHIP_SCHEMA = '1';
const RECORD_PATTERN = /^(\d{4,})\.(claim|release)\.json$/;
const COLLECTION_MARKERS = [['books', 'README.md'], ['projects', 'README.md']];

export class OwnershipRefusal extends Error {}

function refuse(message: string): never {
  throw new OwnershipRefusal(message);
}

export interface BackendState {
  state: 'attached' | 'local' | 'harness-exposed' | 'misconfigured' | 'unreachable';
  refusal: string;
  collection_root: string;
}

/** `Get-HarnessExposedBasicMemoryServers`: the reader's own Basic Memory servers, never the Library's. */
function harnessExposedServers(workspace: string): string[] {
  const found = new Set<string>();
  for (const file of [path.join(workspace, '.mcp.json'), path.join(workspace, '.claude', 'settings.json')]) {
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
    const servers = (doc as Record<string, unknown> | null)?.['mcpServers'];
    if (servers === null || typeof servers !== 'object') continue;
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (name === 'validated-book-reader') continue;
      if (/basic[-_]memory/.test(`${name} ${JSON.stringify(value)}`.toLowerCase())) found.add(name);
    }
  }
  return [...found].sort();
}

/** `Test-SharedCollectionRoot`: a directory carrying both Catalogs, and nothing less. */
export function isSharedCollectionRoot(root: string): boolean {
  try {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
    return COLLECTION_MARKERS.every((parts) => {
      const file = path.join(root, ...parts);
      return fs.existsSync(file) && fs.statSync(file).isFile();
    });
  } catch {
    return false;
  }
}

/** `Get-CollectionBackendState`: one state, in the oracle's precedence. */
export function collectionBackendState(workspace: string): BackendState {
  const mcpUrl = configuredMcpUrl(workspace);
  const collectionId = configuredCollectionId(workspace);
  const sharedRoot = configuredSharedRoot(workspace);
  if (mcpUrl && !collectionId) {
    return {
      state: 'misconfigured',
      collection_root: '',
      refusal:
        `A Basic Memory endpoint is configured (${mcpUrl}) but no collection id is, so there is an ` +
        'address and nothing to address at it. Set AI_LIBRARY_PROJECT_ID, or run ' +
        'tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> once to write ' +
        '.claude/.library-project for this workspace.',
    };
  }
  if (collectionId && !mcpUrl) {
    return {
      state: 'misconfigured',
      collection_root: '',
      refusal:
        `A collection id is configured (${collectionId}) but no Basic Memory endpoint is, so no ` +
        'shared Book or Project Hub can be reached. Set AI_LIBRARY_MCP_URL, or run ' +
        'tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id> once to write ' +
        '.claude/.library-mcp-url for this workspace.',
    };
  }
  if (!mcpUrl) {
    const foreign = harnessExposedServers(workspace);
    if (foreign.length) {
      return {
        state: 'harness-exposed',
        collection_root: '',
        refusal:
          'This workspace has no Basic Memory backend configured, and your own harness config ' +
          `exposes ${foreign.length} Basic Memory server(s): ${foreign.join(', ')}. The Library ` +
          "neither uses nor guards those -- a guard inside the Library's own server cannot " +
          'intercept a server exposed beside it (ADR-0030), so reads and writes through them are ' +
          'outside every Desk and Shelf boundary this program enforces. To give the Library a ' +
          'backend, configure it explicitly with tools/Initialize-CodexLibrary.ps1 -McpUrl <url> ' +
          '-CollectionId <id>.',
      };
    }
    const local = path.join(workspace, 'collection');
    return {
      state: 'local',
      collection_root: fs.existsSync(local) ? local : '',
      refusal:
        'This workspace is in local mode: no Basic Memory endpoint is configured, so there is no ' +
        'shared collection to reach. Local-collection reads and writes are unaffected. To attach ' +
        'a shared collection, run tools/Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId ' +
        '<id>.',
    };
  }
  if (!sharedRoot) {
    return {
      state: 'misconfigured',
      collection_root: '',
      refusal:
        `This workspace is attached to a Basic Memory collection at ${mcpUrl} with no filesystem ` +
        'view of it, so its writes cannot be fenced: one writable workspace per collection is ' +
        "arbitrated by exclusive create in the collection's own folder, and the deployed Basic " +
        'Memory MCP surface has no exclusive-create verb to do it over the transport. Set ' +
        'LIBRARY_SHARED_COLLECTION_ROOT, or write the path into .claude/.library-shared-root, ' +
        'and run tools/Set-CollectionOwner.ps1 -Status to confirm it.',
    };
  }
  if (!isSharedCollectionRoot(sharedRoot)) {
    let why = 'it is not there';
    try {
      if (fs.statSync(sharedRoot).isDirectory()) {
        why = 'it is a directory that carries neither books\\README.md nor projects\\README.md, so it is not a collection';
      }
    } catch {
      // absent: 'it is not there'
    }
    return {
      state: 'unreachable',
      collection_root: '',
      refusal:
        `The collection's configured filesystem root is unreachable: ${sharedRoot} -- ${why}. If the ` +
        'share is simply disconnected, reconnect it and try again; if the path is wrong, correct ' +
        'LIBRARY_SHARED_COLLECTION_ROOT or .claude/.library-shared-root. Nothing was attempted ' +
        'against the collection.',
    };
  }
  return { state: 'attached', collection_root: sharedRoot, refusal: '' };
}

export interface Ownership {
  state: 'unowned' | 'held' | 'released';
  incarnation: number;
  workspace_id: string;
  machine: string;
  acquired: string;
  released: string;
  release_reason: string;
  claims: number;
  next_incarnation: number;
  owner_directory: string;
}

function recordField(doc: unknown, name: string): string {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return '';
  const value = (doc as Record<string, unknown>)[name];
  return value === undefined || value === null ? '' : String(value);
}

/** `Read-CollectionOwnership`: derived from the records, and a record that contradicts itself is refused. */
export function readCollectionOwnership(collectionRoot: string): Ownership {
  const ownerDirectory = path.join(collectionRoot, '.owner');
  const result: Ownership = {
    state: 'unowned',
    incarnation: 0,
    workspace_id: '',
    machine: '',
    acquired: '',
    released: '',
    release_reason: '',
    claims: 0,
    next_incarnation: 1,
    owner_directory: ownerDirectory,
  };
  if (fs.existsSync(ownerDirectory) && fs.statSync(ownerDirectory).isFile()) {
    refuse(
      `The collection's ownership record at ${ownerDirectory} is a FILE. It is a directory of ` +
        'per-incarnation claim and release records, because a single file cannot be handed ' +
        'from one owner to the next atomically -- see tools/CollectionOwnership.ps1. Move that ' +
        'file aside by hand; nothing here will overwrite it.',
    );
  }
  if (!fs.existsSync(ownerDirectory)) return result;

  const claims = new Map<number, unknown>();
  const releases = new Map<number, unknown>();
  for (const entry of fs.readdirSync(ownerDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = RECORD_PATTERN.exec(entry.name);
    if (!parsed) continue;
    const number = Number(parsed[1]);
    const kind = parsed[2]!;
    const full = path.join(ownerDirectory, entry.name);
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      refuse(
        `The collection's ownership record ${entry.name} is not readable JSON, so who may ` +
          `write to this collection cannot be determined: ${(error as Error).message}. It is at ` +
          `${full}. Nothing here will overwrite it.`,
      );
    }
    const declared = recordField(doc, 'schema').trim() || 'none';
    if (declared !== OWNERSHIP_SCHEMA) {
      refuse(
        `The collection's ownership record ${entry.name} declares schema ${declared}, ` +
          `and this program writes and reads schema ${OWNERSHIP_SCHEMA}. A ` +
          'record from another version is not interpreted. Upgrade the program, or move that ' +
          `record aside by hand: ${full}.`,
      );
    }
    const recorded = Number(recordField(doc, 'incarnation') || '0');
    if (recorded !== number) {
      refuse(
        `The collection's ownership record ${entry.name} names incarnation ${number} in its ` +
          `filename and ${recorded} in its body. One of the two was edited by hand; ` +
          `neither is trusted. Nothing here will overwrite it: ${full}`,
      );
    }
    if (!recordField(doc, 'workspace_id').trim()) {
      refuse(`The collection's ownership record ${entry.name} names no workspace, so it cannot say who holds the writable role: ${full}.`);
    }
    (kind === 'claim' ? claims : releases).set(number, doc);
  }

  result.claims = claims.size;
  if (claims.size === 0) {
    if (releases.size) {
      refuse(
        `The collection's ownership record holds ${releases.size} release(s) and no ` +
          `claim, which cannot have happened: ${ownerDirectory}. Nothing here will overwrite it.`,
      );
    }
    return result;
  }
  const highest = Math.max(...claims.keys());
  const claim = claims.get(highest);
  result.incarnation = highest;
  result.workspace_id = recordField(claim, 'workspace_id');
  result.machine = recordField(claim, 'machine');
  result.acquired = recordField(claim, 'acquired');
  result.next_incarnation = highest + 1;
  const release = releases.get(highest);
  if (release !== undefined) {
    const reason = recordField(release, 'reason');
    const releasedBy = recordField(release, 'workspace_id');
    if (reason !== 'forced' && releasedBy !== result.workspace_id) {
      refuse(
        `The collection's release record for incarnation ${highest} is signed by workspace ` +
          `${releasedBy} and the claim it releases is workspace ${result.workspace_id}'s. A ` +
          'release by another workspace is only valid as a forced takeover, which records ' +
          `reason=forced. Neither record is trusted: ${ownerDirectory}.`,
      );
    }
    result.state = 'released';
    result.released = recordField(release, 'released');
    result.release_reason = reason;
  } else {
    result.state = 'held';
  }
  return result;
}

/**
 * `Assert-CollectionWriteAllowed`, entered as `Resolve-LibraryWriteEndpoint` enters it: an unreachable
 * view permits (the oracle's existing ruling), any other non-attached state refuses in its own words, an
 * unowned collection permits (day one), and a role held by another workspace refuses.
 */
export function assertCollectionWriteAllowed(workspace: string, operation: string): void {
  const state = collectionBackendState(workspace);
  if (state.state === 'unreachable') return;
  if (state.state !== 'attached') refuse(`${operation} is refused: ${state.refusal}`);
  const record = readCollectionOwnership(state.collection_root);
  const workspaceId = markerField(readMarker(workspace), 'id');
  if (record.state === 'unowned') return;
  if (record.state === 'released') {
    refuse(
      `${operation} is refused: no workspace holds the writable role for this collection. ` +
        `Incarnation ${record.incarnation} was released by ${record.workspace_id} at ` +
        `${record.released}. Acquire it here with tools/Set-CollectionOwner.ps1 -Acquire.`,
    );
  }
  if (!workspaceId.trim()) {
    refuse(
      `${operation} is refused: workspace ${record.workspace_id} holds the writable role for ` +
        `this collection at incarnation ${record.incarnation}, and this directory ` +
        `(${workspace}) carries no workspace marker, so it cannot be that workspace. Run ` +
        'tools/Initialize-LibraryWorkspace.ps1 to make it a workspace.',
    );
  }
  if (record.workspace_id !== workspaceId) {
    refuse(
      `${operation} is refused: workspace ${record.workspace_id} holds the writable role for ` +
        `this collection at incarnation ${record.incarnation}, on ${record.machine}. This ` +
        `workspace (${workspaceId}) is attached read-only. Release it there, or take it over ` +
        'here with tools/Set-CollectionOwner.ps1 -Acquire -Force if that workspace is gone.',
    );
  }
}

// --- the role: acquire, release, status (S43) --------------------------------------------------------------

/** `$env:COMPUTERNAME`, which is what the oracle records; a POSIX host has no such variable and says its name. */
function machineName(): string {
  return process.env['COMPUTERNAME'] ?? os.hostname();
}

function recordName(incarnation: number, kind: 'claim' | 'release'): string {
  return `${String(incarnation).padStart(4, '0')}.${kind}.json`;
}

/**
 * `Write-CollectionOwnershipRecord`: create one record, or report that its name is taken. EXCLUSIVE CREATE,
 * ALWAYS, and the record appears complete in one step -- the body is written under a staging name first,
 * because a reader landing on a zero-byte record would report the collection's ownership as corrupt.
 *
 * THE ORACLE'S ARBITRATION IS `File.Move` WITHOUT REPLACE, which Node cannot spell: `fs.renameSync` replaces an
 * existing name on every platform. A HARD LINK is the same arbitration -- `link(2)` and `CreateHardLinkW` are
 * atomic and fail when the name exists, and the linked name is complete the instant it appears -- and the
 * staging name is then removed. A filesystem that has no hard links (some SMB servers refuse them) falls back
 * to an exclusive open of the final name, which arbitrates as surely and leaves the zero-byte window the move
 * was chosen to close; that is said here rather than hidden.
 */
function writeOwnershipRecord(ownerDirectory: string, incarnation: number, kind: 'claim' | 'release', body: Record<string, PsJsonValue>): { created: boolean; path: string } {
  fs.mkdirSync(ownerDirectory, { recursive: true });
  const final = path.join(ownerDirectory, recordName(incarnation, kind));
  const json = psConvertToJson(body);
  const staging = path.join(ownerDirectory, `.staging-${crypto.randomUUID().replace(/-/g, '')}.tmp`);
  fs.writeFileSync(staging, json, 'utf8');
  try {
    fs.linkSync(staging, final);
    return { created: true, path: final };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return { created: false, path: final };
    try {
      fs.writeFileSync(final, json, { encoding: 'utf8', flag: 'wx' });
      return { created: true, path: final };
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return { created: false, path: final };
      throw fallback;
    }
  } finally {
    try {
      fs.unlinkSync(staging);
    } catch {
      // a staging name that is already gone cost nothing
    }
  }
}

/** `Enter-CollectionOwnership`: idempotent for the holder, a refusal for anyone else, a forced takeover on request. */
function enterCollectionOwnership(collectionRoot: string, workspaceId: string, workspace: string, force: boolean): Record<string, PsJsonValue> {
  let before = readCollectionOwnership(collectionRoot);
  const ownerDirectory = before.owner_directory;
  if (before.state === 'held') {
    if (before.workspace_id === workspaceId) {
      return {
        outcome: 'already_held',
        incarnation: before.incarnation,
        displaced: '',
        path: path.join(ownerDirectory, recordName(before.incarnation, 'claim')),
      };
    }
    if (!force) {
      refuse(
        `Workspace ${before.workspace_id} holds the writable role for this collection at ` +
          `incarnation ${before.incarnation}, acquired ${before.acquired} on ` +
          `${before.machine}. One writable workspace per collection: book locks live under ` +
          'each workspace, so a second writer would take a different lock over the same page ' +
          '(ADR-0015, ADR-0030). Either release it there with ' +
          'tools/Set-CollectionOwner.ps1 -Release, or -- only if that workspace is gone for ' +
          'good -- take it over here with tools/Set-CollectionOwner.ps1 -Acquire -Force, which ' +
          `records the takeover under this workspace's name. Record: ${ownerDirectory}`,
      );
    }
    // A forced release of the incumbent's incarnation, signed by the forcer. Losing that create means
    // somebody released concurrently, which is the outcome wanted anyway.
    writeOwnershipRecord(ownerDirectory, before.incarnation, 'release', {
      schema: OWNERSHIP_SCHEMA,
      incarnation: before.incarnation,
      workspace_id: workspaceId,
      released: utcRoundTrip(),
      reason: 'forced',
      displaced: before.workspace_id,
      machine: machineName(),
    });
    before = readCollectionOwnership(collectionRoot);
  }
  const next = before.next_incarnation;
  const written = writeOwnershipRecord(ownerDirectory, next, 'claim', {
    schema: OWNERSHIP_SCHEMA,
    incarnation: next,
    workspace_id: workspaceId,
    workspace_path: workspace,
    machine: machineName(),
    pid: process.pid,
    acquired: utcRoundTrip(),
  });
  if (!written.created) {
    // LOSING THE CREATE RACE IS A REFUSAL, NOT A RETRY: retrying at the next incarnation would be a second
    // writer politely taking a second role over the same collection.
    const after = readCollectionOwnership(collectionRoot);
    refuse(
      `Another workspace acquired incarnation ${next} of this collection's writable role while ` +
        `this acquire was in flight; it is now held by ${after.workspace_id} on ` +
        `${after.machine}. Nothing was written here. Run tools/Set-CollectionOwner.ps1 -Status ` +
        'to see the current record.',
    );
  }
  return {
    outcome: 'acquired',
    incarnation: next,
    displaced: before.release_reason === 'forced' ? before.workspace_id : '',
    path: written.path,
  };
}

/** `Get-HeldBookLockFiles`: read off disk, because a release must see every process's lock, not this one's. */
function heldBookLockFiles(workspace: string): string[] {
  const directory = path.join(workspace, 'internal', 'book-locks');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.lock'))
    .map((entry) => entry.name);
}

/** `Exit-CollectionOwnership`: only by the holder, only with no Book lock held, and once. */
function exitCollectionOwnership(collectionRoot: string, workspaceId: string, workspace: string): Record<string, PsJsonValue> {
  const state = readCollectionOwnership(collectionRoot);
  const ownerDirectory = state.owner_directory;
  if (state.state === 'unowned') {
    refuse(`No workspace holds the writable role for this collection, so there is nothing to release. Record: ${ownerDirectory}`);
  }
  if (state.workspace_id !== workspaceId) {
    refuse(
      `This workspace (${workspaceId}) does not hold the writable role for this collection; ` +
        `workspace ${state.workspace_id} holds incarnation ${state.incarnation}. A release ` +
        'by another workspace is only valid as a forced takeover: ' +
        `tools/Set-CollectionOwner.ps1 -Acquire -Force. Record: ${ownerDirectory}`,
    );
  }
  if (state.state === 'released') return { outcome: 'already_released', incarnation: state.incarnation };
  const locks = heldBookLockFiles(workspace);
  if (locks.length) {
    refuse(
      `This workspace holds ${locks.length} Book lock(s), so the writable role cannot be ` +
        `released: ${locks.join(', ')}. A release states that no write of this workspace's is ` +
        'in flight, and the next owner would otherwise begin writing pages this one is part ' +
        'way through. Wait for the writer to finish; if no writer is running, those files are a ' +
        `crashed run's leftovers in ${path.join(workspace, 'internal', 'book-locks')} and ` +
        'removing them is safe.',
    );
  }
  const written = writeOwnershipRecord(ownerDirectory, state.incarnation, 'release', {
    schema: OWNERSHIP_SCHEMA,
    incarnation: state.incarnation,
    workspace_id: workspaceId,
    released: utcRoundTrip(),
    reason: 'released',
    machine: machineName(),
  });
  return { outcome: written.created ? 'released' : 'already_released', incarnation: state.incarnation };
}

/** `Set-CollectionOwner.ps1`: `library collection owner [--status | --acquire [--force [--user-confirmed]] | --release]`. */
export function runCollectionVerb(argv: string[], workspace: string): { refusal: string | null; value: Record<string, PsJsonValue> | null } {
  try {
    const parsed = parseArguments(argv, ['workspace']);
    const action = parsed.positional[0] ?? '';
    if (action !== 'owner') {
      return { refusal: `library collection has no action '${action}'. It has: owner.`, value: null };
    }
    const acquire = parsed.flags.has('acquire');
    const release = parsed.flags.has('release');
    if (acquire && release) {
      refuse('Pass one of -Acquire or -Release, or neither for -Status. Acquiring and releasing in one run would be two decisions in one command.');
    }
    const backend = collectionBackendState(workspace);
    const workspaceId = markerField(readMarker(workspace), 'id');
    const harnessServers = harnessExposedServers(workspace);

    if (backend.state !== 'attached') {
      if (acquire || release) refuse(`The writable role cannot be ${acquire ? 'acquired' : 'released'}: ${backend.refusal}`);
      return {
        refusal: null,
        value: {
          operation: 'collection ownership',
          mode: 'status',
          workspace,
          workspace_id: workspaceId,
          backend: backend.state,
          collection_root: backend.collection_root,
          harness_servers: harnessServers,
          role: 'unavailable',
          refusal: backend.refusal,
        },
      };
    }
    if (!workspaceId.trim()) {
      refuse(
        `${workspace} carries no workspace marker, so it has no identity to record against the ` +
          'collection. Run tools/Initialize-LibraryWorkspace.ps1 to make it a workspace first.',
      );
    }
    const collectionRoot = backend.collection_root;
    const record = readCollectionOwnership(collectionRoot);

    if (acquire) {
      const force = parsed.flags.has('force');
      if (force && !parsed.flags.has('user-confirmed') && record.state === 'held' && record.workspace_id !== workspaceId) {
        return {
          refusal: null,
          value: {
            operation: 'collection ownership',
            mode: 'acquire-preflight',
            workspace,
            workspace_id: workspaceId,
            collection_root: collectionRoot,
            would_displace: record.workspace_id,
            displaced_machine: record.machine,
            displaced_since: record.acquired,
            incarnation_now: record.incarnation,
            incarnation_next: record.next_incarnation,
            confirmed: false,
            advice:
              `Re-run with -Force -UserConfirmed only if workspace ${record.workspace_id} ` +
              `on ${record.machine} is gone for good. If it is merely idle, run ` +
              'tools/Set-CollectionOwner.ps1 -Release there instead: a forced takeover is ' +
              "recorded permanently and the displaced workspace's next shared write is refused " +
              'wherever it is running.',
          },
        };
      }
      const acquired = enterCollectionOwnership(collectionRoot, workspaceId, workspace, force);
      return {
        refusal: null,
        value: {
          operation: 'collection ownership',
          mode: 'acquire',
          outcome: acquired['outcome']!,
          workspace,
          workspace_id: workspaceId,
          collection_root: collectionRoot,
          incarnation: acquired['incarnation']!,
          displaced: acquired['displaced']!,
          record: acquired['path']!,
        },
      };
    }

    if (release) {
      const released = exitCollectionOwnership(collectionRoot, workspaceId, workspace);
      return {
        refusal: null,
        value: {
          operation: 'collection ownership',
          mode: 'release',
          outcome: released['outcome']!,
          workspace,
          workspace_id: workspaceId,
          collection_root: collectionRoot,
          incarnation: released['incarnation']!,
        },
      };
    }

    // STATUS, which never writes. The refusal is the fence's own sentence, asked of the fence.
    let role = 'read-only';
    if (record.state === 'unowned') role = 'unowned';
    else if (record.workspace_id === workspaceId && record.state === 'held') role = 'writable';
    let refusal = '';
    if (record.state === 'unowned') {
      refusal =
        'No workspace owns this collection yet, so shared writes are not fenced. ' +
        'tools/Set-CollectionOwner.ps1 -Acquire claims the writable role for this workspace ' +
        'and refuses every other workspace from then on.';
    } else {
      try {
        assertCollectionWriteAllowed(workspace, 'a shared write');
      } catch (error) {
        refusal = (error as Error).message;
      }
    }
    return {
      refusal: null,
      value: {
        operation: 'collection ownership',
        mode: 'status',
        workspace,
        workspace_id: workspaceId,
        backend: backend.state,
        collection_root: collectionRoot,
        harness_servers: harnessServers,
        role,
        state: record.state,
        incarnation: record.incarnation,
        held_by: record.workspace_id,
        held_on: record.machine,
        acquired: record.acquired,
        released: record.released,
        release_reason: record.release_reason,
        incarnations: record.claims,
        record: record.owner_directory,
        refusal,
      },
    };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
