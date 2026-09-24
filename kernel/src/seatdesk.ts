/**
 * Desk state: which Books and Projects are open, at which seat.
 *
 * The PowerShell originals are the Desk half of `tools/BookRootSchema.ps1` and the cross-seat half
 * of `tools/LibrarySeat.ps1`. Four rules, each of them paid for:
 *
 *   THE TWO FILENAMES ARE SPELLED ONCE. `.open-books` and `.open-projects` live here and nowhere
 *   else, because the day the guards became seat-aware, three suites failed at once -- every one of
 *   them had composed `.claude/.open-books` by hand and kept passing against a layout production had
 *   stopped using.
 *
 *   A DESK IS PUBLISHED BY RENAME AND READ WHOLE. Every Desk READER holds no lock -- three of them
 *   are hooks -- so a truncating write leaves the file zero-length for the width of a write and the
 *   reader in that window believes it. An empty-looking Desk becomes a denied tool call with no
 *   explanation.
 *
 *   A TRAILING NEWLINE IS A TERMINATOR, NOT AN EMPTY LINE. Both writers end the body with one, so a
 *   reader that split naively would give every Desk file in the Library one phantom entry.
 *
 *   A CROSS-SEAT SCAN NEEDS THE REGISTRY LOCK, and it is asserted rather than documented. A decision
 *   made over MANY seats must see them all at one instant; a comment saying so was wrong in four
 *   helpers at once.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { assertSeatRegistryLockHeld } from './locks.ts';
import { seatBindingForAgent } from './seatclaim.ts';
import { currentAgentProcessId } from './procstart.ts';

export type DeskKind = 'books' | 'projects';

const SEATS_DIRECTORY_NAME = 'seats';
const SEAT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function seatsDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, SEATS_DIRECTORY_NAME);
}

/** THE TWO FILENAMES, SPELLED ONCE IN THE WHOLE KERNEL. */
export function deskFileName(kind: DeskKind): string {
  return kind === 'books' ? '.open-books' : '.open-projects';
}

export function deskStateDirectory(stateDirectory: string, seat: string): string {
  return path.join(seatsDirectory(stateDirectory), seat);
}

export function deskFilePath(stateDirectory: string, seat: string, kind: DeskKind): string {
  return path.join(deskStateDirectory(stateDirectory, seat), deskFileName(kind));
}

/**
 * One Desk file's lines. An ABSENT FILE READS AS EMPTY and the caller decides whether that is legal:
 * a hook says the Desk is not configured, a manifest run reads it as every Book closed, and throwing
 * here would take that wording away from the only place that knows what it means.
 */
export function readDeskFileLines(file: string): string[] {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  // The BOM is stripped because Get-Content stripped it. Nothing here writes one, but a Desk file is
  // plain text a reader may repair in an editor that does, and a surviving U+FEFF would make line
  // one `<U+FEFF>books/demo`, which matches no Book-root pattern: a malformed-state refusal for a
  // file whose content is right.
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** One Desk file's entries: trimmed, blanks and `#` comments dropped. What almost every caller wants. */
export function deskFileEntries(file: string): string[] {
  return readDeskFileLines(file)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function deskEntriesForSeat(stateDirectory: string, seat: string, kind: DeskKind): string[] {
  return deskFileEntries(deskFilePath(stateDirectory, seat, kind));
}

/**
 * Every seat directory on disk, defensively. Enumeration is a SECURITY-RELEVANT read: reset, archive
 * and rename all decide what to touch from it, so a name that is not a seat is refused rather than
 * skipped -- skipping is how "whole-tree" becomes a false name. Sorted, because every cross-seat
 * sweep walks seats in one deterministic order so two sweeps cannot deadlock.
 */
export function seatDirectoryNames(stateDirectory: string): string[] {
  const root = seatsDirectory(stateDirectory);
  if (!fs.existsSync(root)) return [];
  const names: string[] = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) {
      throw new Error(
        `Seat directory '${item.name}' is a reparse point. A seat's Desk must live inside this Library; ` +
          'remove the junction, or retire the seat with tools/Retire-Seat.ps1.',
      );
    }
    if (!item.isDirectory()) continue;
    if (!SEAT_SLUG_PATTERN.test(item.name)) {
      throw new Error(
        `'${item.name}' is under .claude/seats/ and is not a valid seat name. Every seat must be nameable, ` +
          'because reset and archive decide what to touch from this list.',
      );
    }
    names.push(item.name);
  }
  return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export interface SeatDesk {
  seat: string;
  entries: string[];
}

/** Every seat's Desk lines of one kind. Caller holds the registry lock. */
export function deskEntriesAcrossSeats(workspace: string, stateDirectory: string, kind: DeskKind): SeatDesk[] {
  assertSeatRegistryLockHeld(workspace, "Scanning every seat's Desk");
  return seatDirectoryNames(stateDirectory).map((seat) => ({
    seat,
    entries: deskEntriesForSeat(stateDirectory, seat, kind),
  }));
}

/**
 * The seats whose Desk names this entry. Empty means nothing anywhere has it open.
 *
 * A LIST OF SEATS RATHER THAN A BOOLEAN ABOUT THIS ONE, and that is step 27's whole point: a seat
 * missed here keeps an entry pointing at a Book that no longer exists -- and worse, at a slug a
 * future Book could occupy, which would hand that seat read access to a Book nobody opened there.
 */
export function seatsHoldingEntry(
  workspace: string,
  stateDirectory: string,
  kind: DeskKind,
  entry: string,
): string[] {
  assertSeatRegistryLockHeld(workspace, `Asking which seats hold '${entry}'`);
  return deskEntriesAcrossSeats(workspace, stateDirectory, kind)
    .filter((row) => row.entries.includes(entry))
    .map((row) => row.seat);
}

function writeDeskEntries(file: string, entries: string[]): void {
  writeAtomicText(file, entries.length ? entries.join('\n') + '\n' : '');
}

/** Rewrite one Desk entry at EVERY seat that holds it. Caller holds the registry lock. */
export function updateDeskEntryAcrossSeats(options: {
  workspace: string;
  stateDirectory: string;
  kind: DeskKind;
  from: string;
  to?: string;
}): string[] {
  assertSeatRegistryLockHeld(options.workspace, `Rewriting '${options.from}' on every seat's Desk`);
  const changed: string[] = [];
  for (const row of deskEntriesAcrossSeats(options.workspace, options.stateDirectory, options.kind)) {
    if (!row.entries.includes(options.from)) continue;
    const rewritten = options.to
      ? row.entries.map((entry) => (entry === options.from ? options.to! : entry))
      : row.entries.filter((entry) => entry !== options.from);
    writeDeskEntries(deskFilePath(options.stateDirectory, row.seat, options.kind), rewritten);
    changed.push(row.seat);
  }
  return changed;
}

/**
 * Add or remove ONE Desk entry at ONE named seat, with the registry lock already held. Returns true
 * when the file changed.
 *
 * THE LOCK-HELD ROUTE `Set-VirtualDesk.ps1` CANNOT BE for a caller inside the lock: that helper takes
 * the same non-reentrant lock, so a helper shelling out to it would wait on itself for ever. The
 * delete writer did exactly that, which is how a deletion came to close only the CALLER's Desk while
 * foreign seats kept an entry entitling them to whatever Book landed on the slug next.
 *
 * IT DOES NOT CHECK THE CLAIM, deliberately. The claim answers "may this session change things at
 * this seat", which is the caller's question and belongs at the caller.
 */
export function setDeskEntryForSeat(options: {
  workspace: string;
  stateDirectory: string;
  seat: string;
  kind: DeskKind;
  entry: string;
  action: 'Add' | 'Remove';
}): boolean {
  assertSeatRegistryLockHeld(options.workspace, `Writing seat '${options.seat}' Desk entry '${options.entry}'`);
  const entries = deskEntriesForSeat(options.stateDirectory, options.seat, options.kind);
  const updated =
    options.action === 'Remove'
      ? entries.filter((entry) => entry !== options.entry)
      : entries.includes(options.entry)
        ? entries
        : [...entries, options.entry];
  // Compared as joined text rather than by count: Add is a no-op when the entry is already there,
  // and both sides keep their order, so one comparison answers exactly "would this write change it".
  if (entries.join('\n') === updated.join('\n')) return false;
  writeDeskEntries(deskFilePath(options.stateDirectory, options.seat, options.kind), updated);
  return true;
}

export interface SeatResolution {
  status: 'named' | 'unset' | 'malformed';
  seat: string | null;
  source: string | null;
  message: string;
}

/**
 * WHICH SEAT THIS CALL IS ABOUT. Never throws; a caller that must fail closed turns any status but
 * `named` into the refusal this function worded.
 *
 * THREE SOURCES IN ONE ORDER, and the order is ADR-0018: `explicit` (an argument, and nothing else is
 * read), `binding` (a COMMITTED binding whose recorded agent is this process's own, verified by pid
 * and start time -- the authority), and `environment` (LIBRARY_SEAT, and only when this process holds
 * no binding). A binding and a disagreeing LIBRARY_SEAT are a refusal naming both, never a silent
 * preference: the environment identifies and does not authenticate.
 *
 * Until S14's second half the middle source was a refusal, because this kernel could not read a
 * process start time. It can now (`procstart.ts`).
 */
export function resolveSeatName(options: {
  seat?: string | undefined;
  stateDirectory?: string | undefined;
  environmentSeat?: string | undefined;
  /**
   * The seat this session is WORKING AT, for a helper whose own `--seat` means something else -- the
   * topic's assignee, for `notebook own`. No argument can name it, so the refusal must not offer
   * `--seat` as the remedy: that is the switch the reader has already passed, and a circle they were
   * sent round live on 2026-09-15. `seatArgumentMeans` says what that helper's `--seat` names instead.
   */
  actingSeatOnly?: boolean;
  seatArgumentMeans?: string;
  /** This process's agent. Supplied by a caller that identified it another way; resolved otherwise. */
  agentPid?: number;
}): SeatResolution {
  const malformed = (candidate: string, whose: string): SeatResolution => ({
    status: 'malformed',
    seat: null,
    source: null,
    message:
      `Seat name '${candidate}'${whose} is malformed. A seat is lowercase letters, digits and hyphens, ` +
      'starting with a letter or a digit. List the seats with tools/Get-DeskOverview.ps1.',
  });

  let seatArgumentClause = '';
  if (options.actingSeatOnly) {
    seatArgumentClause =
      ' This is the seat you are WORKING AT, so no -Seat argument to the helper you ran can name it' +
      (options.seatArgumentMeans && options.seatArgumentMeans.trim() ? ` -- its -Seat names ${options.seatArgumentMeans.trim()}.` : '.');
    if (options.seat && options.seat.trim()) {
      return {
        status: 'malformed',
        seat: null,
        source: null,
        message:
          `Resolve-SeatName was called with both -Seat ('${options.seat}') and -ActingSeatOnly, which contradict: ` +
          '-ActingSeatOnly says the acting seat comes only from a binding or LIBRARY_SEAT and no argument ' +
          'can name it. This is a defect at the call site rather than anything the reader did.',
      };
    }
  }

  if (options.seat && options.seat.trim()) {
    const candidate = options.seat.trim();
    if (!SEAT_SLUG_PATTERN.test(candidate)) return malformed(candidate, '');
    return { status: 'named', seat: candidate, source: 'explicit', message: '' };
  }

  const environmentSeat = (options.environmentSeat ?? process.env['LIBRARY_SEAT'] ?? '').trim();

  if (!options.stateDirectory) {
    return {
      status: 'malformed',
      seat: null,
      source: null,
      message:
        "No seat was named and no state directory was supplied, so this process's seat binding " +
        'could not be read and no seat may be resolved from the environment alone (ADR-0018). ' +
        'Pass -StateDirectory (the .claude directory) at the call site, or name the seat with -Seat.',
    };
  }

  // THE BINDING, WHICH IS THE AUTHORITY. Every fault here -- an unreadable binding, two bindings for
  // one agent, a seats directory that cannot be listed -- means "I cannot tell which seat", and
  // falling through to LIBRARY_SEAT would answer anyway, which is the one outcome that must not happen.
  let bound: { seat: string; agentPid: number } | null = null;
  try {
    bound = seatBindingForAgent(options.stateDirectory, seatDirectoryNames(options.stateDirectory), options.agentPid ?? -1);
  } catch (error) {
    return {
      status: 'malformed',
      seat: null,
      source: null,
      message: `This process's seat binding could not be read, so no seat is resolved: ${(error as Error).message}`,
    };
  }
  if (bound) {
    if (!SEAT_SLUG_PATTERN.test(bound.seat)) return malformed(bound.seat, ' recorded in a seat binding');
    if (environmentSeat && environmentSeat !== bound.seat) {
      return {
        status: 'malformed',
        seat: null,
        source: null,
        message:
          `Seat state disagrees. This agent process (PID ${bound.agentPid}) is bound to seat ` +
          `'${bound.seat}', and LIBRARY_SEAT names '${environmentSeat}'. The binding is the authority and the ` +
          'environment must agree with it, never override it, so nothing is resolved rather than one of ' +
          'the two being guessed at (ADR-0018). Unset LIBRARY_SEAT for this conversation' +
          (options.actingSeatOnly ? ` so the binding answers alone.${seatArgumentClause}` : ', or pass -Seat to name the one you mean.'),
      };
    }
    return { status: 'named', seat: bound.seat, source: 'binding', message: '' };
  }

  if (environmentSeat) {
    if (!SEAT_SLUG_PATTERN.test(environmentSeat)) return malformed(environmentSeat, '');
    return { status: 'named', seat: environmentSeat, source: 'environment', message: '' };
  }

  // WHICH SENTENCE DEPENDS ON WHETHER THERE IS AN AGENT AT ALL, as the oracle's does: "not recognised
  // as an agent tool child" and "holds no seat binding" send the reader to different fixes.
  const agent = options.agentPid !== undefined && options.agentPid >= 0 ? options.agentPid : currentAgentProcessId();
  const agentClause =
    agent <= 0
      ? 'This process is not recognised as an agent tool child, so no seat binding could be read, and LIBRARY_SEAT is unset'
      : 'This agent process holds no seat binding and LIBRARY_SEAT is unset';
  return {
    status: 'unset',
    seat: null,
    source: null,
    message:
      `No seat is named. ${agentClause}, and the ` +
      'Library has no default seat, because a default would silently merge stray work into whichever ' +
      'seat holds it. Sit down at a seat with tools/Enter-LibrarySeat.ps1 -Seat <name>, start one with ' +
      'tools/Start-LibrarySeat.ps1 -Seat <name>' +
      (options.actingSeatOnly ? `, or set LIBRARY_SEAT for this session.${seatArgumentClause}` : ', or pass -Seat explicitly.'),
  };
}

/** The resolved seat, or the resolver's own refusal. The one line a verb runs to answer "who". */
export function requireSeat(options: {
  seat?: string | undefined;
  stateDirectory: string;
  environmentSeat?: string | undefined;
}): string {
  const resolved = resolveSeatName(options);
  if (resolved.status !== 'named') throw new Error(resolved.message);
  return resolved.seat!;
}
