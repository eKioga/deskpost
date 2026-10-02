/**
 * A seat's inbound policy (1.3.1, kickoffs/s79 row 3, PLAN-seat-network.md section 3, ADR-0062): the one-key file
 * `.claude/seats/<seat>/settings.json`, `{"crossSessionInbound": "accept" | "hold" | "refuse"}`, which the launcher
 * validates and passes to that seat's Claude Code as a VALUE on every launch, and to nobody else.
 *
 * WHY ONE KEY AND A VALIDATOR. `--settings` is a trusted source: it can carry permission rules, `defaultMode`, `env`
 * and hooks. A file the launcher passed as it found it would be a privilege path any process of the same user could
 * write. So the file is read, checked to hold exactly that key with one of the three values, and only the value is
 * passed, inline or as a fresh file the launcher writes itself. Anything else is never passed. WHO WROTE THE FILE IS
 * NOT VERIFIED: any process of the same user can write `accept` here, and the launcher will pass it (ADR-0062).
 *
 * WORDED AS THE FILE'S, never as the effective value: managed and user settings, and either session's permission
 * mode, also decide delivery, and the kernel cannot know them. Never written to user or workspace settings.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import type { PsJsonValue } from './psjson.ts';
import { deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { readSeatRegistry, readSeatRetirementRecords } from './desk.ts';
import { enterSeatRegistryLock, exitBookLock } from './locks.ts';

export const INBOUND_KEY = 'crossSessionInbound';
export const INBOUND_VALUES = ['accept', 'hold', 'refuse'] as const;
export type InboundValue = (typeof INBOUND_VALUES)[number];

/** A refusal of this module's: said to the reader as it stands, and nothing was written. */
export class SeatInboundRefusal extends Error {}

function refuse(message: string): never {
  throw new SeatInboundRefusal(message);
}

export function inboundSettingsPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'settings.json');
}

/** The file the launcher writes for one launch on the `claude.cmd` route, which cannot pass `"` inline. */
export function launchSettingsPath(stateDirectory: string, seat: string): string {
  return path.join(deskStateDirectory(stateDirectory, seat), 'launch-settings.json');
}

export type InboundRead = { state: 'unset' } | { state: 'valid'; value: InboundValue } | { state: 'invalid'; reason: string };

/** The seat's file, validated: absent is `unset`; anything but one key with one of the three values is `invalid`. */
export function readInboundSettings(stateDirectory: string, seat: string): InboundRead {
  const file = inboundSettingsPath(stateDirectory, seat);
  if (!fs.existsSync(file)) return { state: 'unset' };
  let parsed: unknown;
  try {
    if (!fs.statSync(file).isFile()) return { state: 'invalid', reason: `${file} is not a file` };
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    return { state: 'invalid', reason: `${file} is not valid JSON: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid', reason: `${file} is not a JSON object` };
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== INBOUND_KEY) {
    const others = keys.filter((key) => key !== INBOUND_KEY);
    return { state: 'invalid', reason: others.length ? `${file} holds ${others.map((key) => `"${key}"`).join(', ')}, and it may hold only "${INBOUND_KEY}"` : `${file} does not hold "${INBOUND_KEY}"` };
  }
  const value = (parsed as Record<string, unknown>)[INBOUND_KEY];
  if (typeof value !== 'string' || !(INBOUND_VALUES as readonly string[]).includes(value)) {
    return { state: 'invalid', reason: `${file} sets "${INBOUND_KEY}" to ${JSON.stringify(value)}, which is not one of ${INBOUND_VALUES.join(', ')}` };
  }
  return { state: 'valid', value: value as InboundValue };
}

/** `inbound_policy` as `seat status` and the Desk say it: the file's own words. */
export function inboundPolicyLabel(read: InboundRead): string {
  if (read.state === 'unset') return 'unset';
  if (read.state === 'valid') return `seat file: ${read.value}`;
  return 'invalid (not passed)';
}

/** The label for a seat, or `invalid (not passed)` when even the read fails. */
export function seatInboundPolicy(stateDirectory: string, seat: string): string {
  try {
    return inboundPolicyLabel(readInboundSettings(stateDirectory, seat));
  } catch {
    return 'invalid (not passed)';
  }
}

/** The one document the launcher passes: the validated value, and nothing else. */
export function inboundDocument(value: InboundValue): string {
  return JSON.stringify({ [INBOUND_KEY]: value });
}

/**
 * THE ARGUMENTS ONE LAUNCH PASSES. Inline where the route allows it; on the `claude.cmd` route, which refuses `"`
 * (`agentSpawn`), the path of a fresh file the launcher writes from the value, never the seat's own file, so nothing
 * written after the check reaches Claude Code. `write` is false for a preview: the path is named and nothing written.
 */
export function inboundSettingsArguments(options: { stateDirectory: string; seat: string; value: InboundValue; commandScript: boolean; write: boolean }): string[] {
  if (!options.commandScript) return ['--settings', inboundDocument(options.value)];
  const file = launchSettingsPath(options.stateDirectory, options.seat);
  if (options.write) writeAtomicText(file, inboundDocument(options.value) + '\n');
  return ['--settings', file];
}

/** The file's bytes, digested for the plan id; `absent` when there is none. */
function fileDigest(file: string): string {
  if (!fs.existsSync(file)) return 'absent';
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function planIdFor(seat: string, value: string, digest: string): string {
  return 'seat-settings-' + crypto.createHash('sha256').update(`${seat}|${INBOUND_KEY}=${value}|${digest}`, 'utf8').digest('hex').substring(0, 16);
}

/** The seat, named and live. A retired seat and an unknown one are refused, each by name. */
function liveSeat(workspace: string, stateDirectory: string, name: string): string {
  if (!name.trim()) refuse('Name the seat: deskpost seat settings <seat> --inbound accept|hold|refuse|unset.');
  const resolved = resolveSeatName({ seat: name, stateDirectory });
  if (resolved.status !== 'named') refuse(resolved.message);
  const seat = resolved.seat!;
  const registry = readSeatRegistry(stateDirectory);
  if (registry.some((row) => row.seat === seat)) return seat;
  if (readSeatRetirementRecords(workspace).records.some((record) => record.seat === seat)) {
    refuse(`Seat '${seat}' is retired, so it has no launches to set an inbound policy for. Nothing was changed.`);
  }
  const names = registry.map((row) => row.seat);
  refuse(`There is no seat named '${seat}'. ${names.length ? `The seats are: ${names.join(', ')}.` : 'This Library has no seats yet.'} Nothing was changed.`);
}

const UNSET_NOTE =
  "With no file the seat's sessions take Claude Code's own default, where the two sessions' permission modes decide: " +
  'a session that bypasses permissions holds every message from a prompting one behind an approval dialog.';

/**
 * `library seat settings <seat> [--inbound accept|hold|refuse|unset] [--preflight | --plan-id <id>]`. With no
 * `--inbound` it says what the file holds. A change previews first; its plan id binds the seat, the value and the
 * file's current digest, so an approval never writes over a file that changed since it was shown. `unset` deletes the
 * file. It changes what reaches a seat, so it takes a yes; it applies from the seat's next launch.
 */
export function seatSettingsResult(options: { workspace: string; seat: string; inbound?: string; preflight: boolean; planId: string }): Record<string, PsJsonValue> {
  const stateDirectory = path.join(options.workspace, '.claude');
  const seat = liveSeat(options.workspace, stateDirectory, options.seat);
  const file = inboundSettingsPath(stateDirectory, seat);
  const current = readInboundSettings(stateDirectory, seat);
  const base = {
    schema: 1,
    operation: 'Seat settings',
    seat,
    file,
    inbound_policy: inboundPolicyLabel(current),
    ...(current.state === 'invalid' ? { invalid_reason: current.reason } : {}),
  };
  if (options.inbound === undefined) {
    if (options.preflight || options.planId) refuse('Name the change: deskpost seat settings <seat> --inbound accept|hold|refuse|unset. Nothing was changed.');
    return { ...base, ...(current.state === 'unset' ? { note: UNSET_NOTE } : {}), shared_library_write: false };
  }
  const value = options.inbound.trim();
  if (value !== 'unset' && !(INBOUND_VALUES as readonly string[]).includes(value)) {
    refuse(`--inbound takes accept, hold, refuse or unset; '${value}' is not one. Nothing was changed.`);
  }
  const proposed = value === 'unset' ? 'unset' : `seat file: ${value}`;
  const change = value === 'unset' ? (current.state === 'unset' ? 'none' : 'delete') : 'write';
  const digest = fileDigest(file);
  const planId = planIdFor(seat, value, digest);
  if (options.preflight) {
    return {
      ...base,
      proposed_inbound_policy: proposed,
      change,
      ...(change === 'write' ? { content: inboundDocument(value as InboundValue) } : {}),
      current_digest: digest,
      plan_id: planId,
      applies: 'from the next launch of this seat, Claude Code only; never passed to Codex',
      ...(value === 'unset' ? { note: UNSET_NOTE } : {}),
      confirmation_required: true,
      shared_library_write: false,
    };
  }
  if (!options.planId) refuse('Nothing was changed: run with --preflight, show the reader what it reports, and rerun with its exact --plan-id after one clear yes.');
  const lock = enterSeatRegistryLock(options.workspace, 10);
  try {
    if (options.planId !== planIdFor(seat, value, fileDigest(file))) {
      refuse("Nothing was changed: that plan_id does not match this seat, this value and the seat's settings file as it is now. Rerun the preflight, which shows the file as it stands, and pass its plan_id.");
    }
    if (change === 'delete') fs.rmSync(file, { force: true });
    else if (change === 'write') writeAtomicText(file, JSON.stringify({ [INBOUND_KEY]: value }, null, 2) + '\n');
  } finally {
    exitBookLock(lock);
  }
  return {
    ...base,
    inbound_policy: proposed,
    changed: change !== 'none',
    change,
    applies: 'from the next launch of this seat, Claude Code only; never passed to Codex',
    ...(value === 'unset' ? { note: UNSET_NOTE } : {}),
    shared_library_write: false,
  };
}

/**
 * Claude Code's user settings file, as Claude Code finds it: in `CLAUDE_CONFIG_DIR`, or in `~/.claude`. Read only, for
 * doctor's warning; nothing here ever writes it.
 */
export function userSettingsPath(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR']?.trim() || path.join(process.env['USERPROFILE'] || os.homedir(), '.claude');
  return path.join(configured, 'settings.json');
}
