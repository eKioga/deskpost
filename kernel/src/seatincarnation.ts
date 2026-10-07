/**
 * WHICH INCARNATION OF A SEAT THE REGISTRY NAMES NOW (kickoffs/s98 row 0; PLAN-seats-team.md session 3 item 0).
 *
 * A seat's slug can be retired and created again, and each creation gets a new `seat_id`. A letter records the
 * `seat_id` of its writer and of its recipient as the registry reads at the moment it is written, and the one
 * recipient predicate (`isAddressedTo`, `shelfnote.ts`) compares a letter's `for_seat_id` with the row's. This module
 * reads those ids and nothing else.
 *
 * A LEAF ON PURPOSE, and it NEVER THROWS: capture, triage and the Desk all ask it, `triage.ts` cannot import `desk.ts`
 * without closing a cycle through `publish.ts`, and a registry that cannot be read must not stop a capture. An id it
 * cannot read is '' (missing, never manufactured), so a letter that carries an id matches no row until it can be read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SeatIncarnation } from './shelfnote.ts';

const SEAT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Every registry row's `seat_id` by seat; '' where a row has none (a pre-identity row) or one that is not 32 hex. */
export function readSeatIds(stateDirectory: string): Map<string, string> {
  const ids = new Map<string, string>();
  const file = path.join(stateDirectory, 'seats', '_registry.json');
  try {
    if (!fs.existsSync(file)) return ids;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { seats?: unknown };
    const rows = parsed && typeof parsed === 'object' && Array.isArray(parsed.seats) ? parsed.seats : [];
    for (const row of rows as unknown[]) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const seat = (row as Record<string, unknown>)['seat'];
      const id = (row as Record<string, unknown>)['seat_id'];
      if (typeof seat !== 'string' || !seat) continue;
      ids.set(seat, typeof id === 'string' && SEAT_ID_PATTERN.test(id) ? id : '');
    }
  } catch {
    return new Map();
  }
  return ids;
}

/** A seat as the recipient rule sees it: its slug and its registry row's `seat_id`, '' when there is none to read. */
export function seatIncarnation(stateDirectory: string, seat: string, ids: Map<string, string> = readSeatIds(stateDirectory)): SeatIncarnation {
  return { seat, seatId: ids.get(seat) ?? '' };
}
