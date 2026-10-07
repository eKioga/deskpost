/**
 * The seat registry's raw rows, for its writers (moved out of `seat.ts` in S96 row 2, unchanged, so `seat describe` can
 * write the registry without importing the seat verbs back). `readSeatRegistry` (`desk.ts`) is the validating reader;
 * these keep every field of every row, so a writer never drops one it does not know.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { psSortCompare } from './notebook.ts';
import { seatsDirectory } from './seatdesk.ts';

export function registryFilePath(stateDirectory: string): string {
  return path.join(seatsDirectory(stateDirectory), '_registry.json');
}

function strictUtf8(file: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/^﻿/, '');
}

/** The registry's rows AS WRITTEN, every field kept, for a writer. `readSeatRegistry` validated them already. */
export function readRegistryRows(file: string): Record<string, PsJsonValue>[] {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(strictUtf8(file)) as { seats?: unknown };
  const seats = parsed.seats;
  return (Array.isArray(seats) ? seats : seats === null || seats === undefined ? [] : [seats]) as Record<string, PsJsonValue>[];
}

/** Replace the registry atomically, sorted by seat so the same seats are the same bytes. Lock held. */
export function writeSeatRegistry(stateDirectory: string, rows: Record<string, PsJsonValue>[]): void {
  const ordered = [...rows].sort((left, right) => psSortCompare(String(left['seat']), String(right['seat'])));
  writeAtomicText(registryFilePath(stateDirectory), psConvertToJson({ schema: 1, seats: ordered }) + '\n');
}
