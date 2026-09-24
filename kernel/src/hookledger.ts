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
import * as path from 'node:path';
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

export function setHookServed(stateDirectory: string, sessionId: string, key: string): void {
  if (!sessionId.trim()) return;
  const ledger = readHookLedger(stateDirectory);
  const existing = ledger.get(sessionId) ?? [];
  if (existing.includes(key)) return;
  ledger.set(sessionId, [...existing, key]);
  saveHookLedger(stateDirectory, ledger);
}
