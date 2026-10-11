/**
 * The serve ledger: `.claude/.hook-served.json`, session id -> the keys already served into it. The
 * half of `.claude/hooks/HookContext.ps1` a ported hook needs (S36).
 *
 * EVERY FAILURE IS SWALLOWED, as in the oracle, and that is the right direction for this file only: a
 * ledger that cannot be read reports "not served", so guidance repeats; one that cannot be written
 * reports success, so it repeats next time. Neither withholds guidance, and neither blocks a call.
 *
 * THE FILE'S OWN ORDER IS THE ONLY RECORD OF WHICH SESSION CAME FIRST, and the cap keeps the last
 * twenty. A JavaScript object keeps insertion order for any key that is not an array index, and a
 * session id is never one; the oracle paid for a hashtable that did not keep it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { psJsonString } from './psjson.ts';

const LEDGER_CAP = 20;

export function hookLedgerPath(stateDirectory: string): string {
  return path.join(stateDirectory, '.hook-served.json');
}

/** `Read-HookLedger`: an ordered table, every value a list (a one-key session round-trips as a bare string). */
export function readHookLedger(stateDirectory: string): Map<string, string[]> {
  const table = new Map<string, string[]>();
  const file = hookLedgerPath(stateDirectory);
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return table;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      table.set(key, (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).map((item) => String(item)));
    }
    return table;
  } catch {
    return new Map();
  }
}

/** `Save-HookLedger`: the last twenty sessions, as `ConvertTo-Json -Compress` writes them. */
export function saveHookLedger(stateDirectory: string, ledger: Map<string, string[]>): void {
  let entries = [...ledger.entries()];
  if (entries.length > LEDGER_CAP) entries = entries.slice(-LEDGER_CAP);
  try {
    const body = entries.map(([key, keys]) => `${psJsonString(key)}:[${keys.map((item) => psJsonString(item)).join(',')}]`).join(',');
    fs.writeFileSync(hookLedgerPath(stateDirectory), `{${body}}`, { encoding: 'utf8' });
  } catch {
    // swallowed: see the header
  }
}

export function testHookServed(stateDirectory: string, sessionId: string, key: string): boolean {
  if (!sessionId.trim()) return false;
  return (readHookLedger(stateDirectory).get(sessionId) ?? []).includes(key);
}

/** `Clear-HookServed` (`HookContext.ps1`): this session's keys removed, every other session's left as they were. */
export function clearHookServed(stateDirectory: string, sessionId: string): void {
  if (!sessionId.trim()) return;
  const ledger = readHookLedger(stateDirectory);
  if (!ledger.has(sessionId)) return;
  ledger.delete(sessionId);
  saveHookLedger(stateDirectory, ledger);
}

export function setHookServed(stateDirectory: string, sessionId: string, key: string): void {
  if (!sessionId.trim()) return;
  const ledger = readHookLedger(stateDirectory);
  const existing = ledger.get(sessionId) ?? [];
  if (existing.includes(key)) return;
  ledger.set(sessionId, [...existing, key]);
  saveHookLedger(stateDirectory, ledger);
}

/**
 * ONE SERVING WHEN THE PLUGIN AND THE WORKSPACE BOTH REGISTER A HOOK (S114 row 6, kickoffs/s114-r2 ruling 13). A Library
 * that also has the Deskpost Claude plugin enabled registers seat-start and search-hit twice -- in its own
 * `.claude/settings.local.json` and in the plugin's `hooks/hooks.json` -- and Claude Code runs both, at once, on the same
 * payload, so a session was given the seat-start text and the search reminder twice (measured on 1.4.3's Eric-layout
 * fixture). The serve ledger above is read-modify-write, so two hooks started together would both see "not served";
 * this claim is one exclusive file create instead: the first to create the key's file serves, and a second within
 * `windowMs` stays silent. Every failure answers "serve": a claim that cannot be made never withholds guidance.
 */
export function claimHookOnce(key: string, windowMs = 10_000): boolean {
  const directory = path.join(os.tmpdir(), 'deskpost-hook-once');
  const file = path.join(directory, createHash('sha256').update(key).digest('hex').slice(0, 32));
  try {
    fs.mkdirSync(directory, { recursive: true });
    const now = Date.now();
    for (const name of fs.readdirSync(directory)) {
      try {
        const old = path.join(directory, name);
        if (now - fs.statSync(old).mtimeMs > 86_400_000) fs.rmSync(old, { force: true });
      } catch {
        // another hook removed it first
      }
    }
  } catch {
    return true;
  }
  try {
    fs.writeFileSync(file, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return true;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < windowMs) return false;
      fs.writeFileSync(file, String(Date.now()));
    } catch {
      // unreadable or gone: serve
    }
    return true;
  }
}
