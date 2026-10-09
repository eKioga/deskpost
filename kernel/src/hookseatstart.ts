/**
 * `library hook seat-start` (kickoffs/s82 row 3, PLAN-no-powershell-runtime.md D1, ADR-0064): the SessionStart hook
 * `Get-SeatStartContext.ps1` is, branch for branch -- the roster and the ask for a seatless session, the re-bind of a
 * resumed conversation to the seat it last held, and the note for a bound or launcher-named one.
 *
 * THE STATE IS THE WORKSPACE'S (the seat-start Report). An installed Library registered the script with no
 * `-StateDirectory`, so it read the PROGRAM's seats: a seatless session in a Library with seats was told "No seat exists
 * in this checkout yet", and a resume re-bind ran against the program. This resolves the workspace as desk-context
 * does (explicit, then LIBRARY_WORKSPACE, then the working directory's marker, then the anchor), and reads and binds
 * there. With no workspace it says nothing: the Desk hook says so on every prompt.
 *
 * THE DOCUMENT IS THE PROGRAM'S (ADR-0014): the served section is `## Sitting down at a seat` of the program's
 * `docs/seats.md`, verbatim; this file adds only state. THE RE-BIND GOES THROUGH THE GATE (ADR-0018): it runs this
 * program's own `seat enter`, which applies the operation-by-state matrix as it would for a seat the reader typed,
 * and a refusal is reported, never worked around.
 *
 * ITS FAILURE IS THE ROSTER, NEVER A BLOCKED SESSION: every path prints guidance or nothing, and none denies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { field } from './guards.ts';
import { readSeatRegistry } from './desk.ts';
import { resolveSeatName } from './seatdesk.ts';
import { getSeatClaimState, readSeatActivity } from './seatclaim.ts';
import { currentAgentProcessId } from './procstart.ts';
import { programRoot } from './programroot.ts';
import { resolveWorkspace } from './workspace.ts';
import { seatsForConversation, selfCommand, updateSeatConversationRecord } from './seat.ts';

const SECTION = '## Sitting down at a seat';

/** `Get-MarkdownSection`: a heading's section, cut at the next heading of the same or a higher level, or null. */
export function markdownSection(file: string, heading: string): string | null {
  const level = /^(#{1,6}) /.exec(heading)?.[1]?.length;
  if (level === undefined || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6}) /.exec(lines[index]!);
    if (match && match[1]!.length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

function servedSection(): string | null {
  try {
    return markdownSection(path.join(programRoot(), 'docs', 'seats.md'), SECTION);
  } catch {
    return null;
  }
}

/** One seat's liveness, or a named failure to read it: a binding that cannot be parsed must not take the roster down. */
function seatStateLabel(stateDirectory: string, seat: string, agentPid: number): string {
  try {
    const state = getSeatClaimState(stateDirectory, seat, agentPid);
    if (state.state === 'held' && state.thisAgent) return 'held by this conversation';
    if (state.state === 'orphaned') return 'orphaned (agent alive, claim holder gone)';
    return state.state;
  } catch (error) {
    return `unreadable: ${(error as Error).message}`;
  }
}

/** The roster, read now rather than remembered. */
export function seatRoster(stateDirectory: string, agentPid: number): string {
  const entries = [...readSeatRegistry(stateDirectory)].sort((left, right) => (left.seat < right.seat ? -1 : left.seat > right.seat ? 1 : 0));
  if (!entries.length) return 'No seat exists in this Library yet. Ask the reader what they are working on, then create the first seat with the confirmed route above.';
  const rows = entries.map((entry) => {
    const activity = readSeatActivity(stateDirectory, entry.seat);
    const lastSeen = activity !== null && typeof activity['last_seen_utc'] === 'string' ? `  last active ${activity['last_seen_utc']}` : '';
    return `  ${entry.seat}  ->  project ${entry.project}  [${seatStateLabel(stateDirectory, entry.seat, agentPid)}]${lastSeen}`;
  });
  return 'The seats in this Library, read now rather than remembered:\n' + rows.join('\n');
}

/** The re-bind, through this program's own `seat enter`: null on success, or why it failed, cut to a sentence. */
function enterSeat(workspace: string, seat: string, agentPid: number, sessionId: string, deadlineSeconds: number): string | null {
  const self = selfCommand();
  const ran = spawnSync(
    self.file,
    [...self.args, 'seat', 'enter', seat, '--workspace', workspace, '--agent-pid', String(agentPid), '--session-id', sessionId, '--deadline-seconds', String(deadlineSeconds), '--json'],
    { encoding: 'utf8', windowsHide: true, timeout: Math.max(10, deadlineSeconds * 5) * 1000 },
  );
  if (ran.status === 0) return null;
  let why = `${ran.stderr ?? ''} ${ran.error ? ran.error.message : ''}`.replace(/\s+/g, ' ').trim() || `seat enter exited ${String(ran.status)}`;
  if (why.length > 400) why = why.slice(0, 400).trimEnd() + ' [...]';
  return why;
}

/** `library hook seat-start [--workspace <p>] [--state-directory <d>] [--seat <s>] [--agent-pid <n>] [--deadline-seconds <n>]`. */
export function runSeatStartVerb(argv: string[], stdinText: string): string {
  const paragraphs: string[] = [];
  const add = (text: string | null | undefined) => {
    if (text && text.trim()) paragraphs.push(text.trimEnd());
  };
  try {
    const parsed = parseArguments(argv, argumentTable('hook', 'seat-start'));
    let workspace = parsed.options.get('workspace') ?? '';
    let stateDirectory = parsed.options.get('state-directory') ?? '';
    if (!workspace || !stateDirectory) {
      const resolved = resolveWorkspace({ explicit: workspace || (stateDirectory ? path.dirname(stateDirectory) : '') });
      if (resolved.kind !== 'resolved' || !resolved.workspace) return '';
      if (!workspace) workspace = resolved.workspace;
      if (!stateDirectory) stateDirectory = path.join(resolved.workspace, '.claude');
    }
    const deadlineSeconds = Number(parsed.options.get('deadline-seconds') ?? '2');
    const call = JSON.parse(stdinText.replace(/^﻿/, '') || 'null') as unknown;
    const source = String(field(call, 'source') ?? '');
    const sessionId = String(field(call, 'session_id') ?? '');
    const explicitAgent = parsed.options.get('agent-pid');
    const agentPid = explicitAgent !== undefined && Number(explicitAgent) >= 0 ? Number(explicitAgent) : currentAgentProcessId();
    const resolution = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory, agentPid });
    // A BINDING IS THE ONLY THING THAT COUNTS AS BOUND: LIBRARY_SEAT names a seat and authenticates nothing.
    const boundSeat = resolution.status === 'named' && resolution.source === 'binding' ? resolution.seat! : '';

    if (resolution.status === 'malformed') {
      // NO ROSTER: seat state that cannot be trusted is when a list of seats would be a claim, not a report.
      add('Seat state at session start: ' + resolution.message);
    } else if (boundSeat) {
      if (source !== 'compact') add(`Virtual Desk: seat '${boundSeat}' is bound to this conversation, verified by process identity.`);
      if (source === 'resume') {
        // THE CROSS-SEAT RESUME INFORMS AND NEVER MOVES: one agent process holds one seat for its life.
        const elsewhere = seatsForConversation(stateDirectory, sessionId).filter((entry) => entry.seat !== boundSeat);
        if (elsewhere.length) {
          add(
            `This conversation last sat at seat '${elsewhere[0]!.seat}'; it is at '${boundSeat}' now. ` +
              'One agent process holds one seat for its life, so nothing moves: end this conversation and start a new one ' +
              'if the other seat is the one you want.',
          );
        }
      }
      try {
        updateSeatConversationRecord({ workspace, stateDirectory, seat: boundSeat, agentPid, sessionId, deadlineSeconds });
      } catch {
        // its failure costs the resume lookup and nothing else
      }
    } else if (resolution.status === 'named') {
      if (source !== 'compact') {
        add(
          `Virtual Desk: seat '${resolution.seat}', named by the environment. Its claim is held ` +
            "by whatever started this session; when that is the deskpost launcher, the seat is this session's and " +
            'there is nothing to bind.',
        );
      }
    } else if (source === 'compact') {
      // NOTHING NEW: the Desk hook has told a seatless session so on every prompt.
    } else if (source === 'resume') {
      const prior = seatsForConversation(stateDirectory, sessionId);
      if (!prior.length) {
        add('This conversation is being resumed and holds no seat, and no seat records having been sat at by it.');
        add(servedSection());
        add(seatRoster(stateDirectory, agentPid));
      } else {
        const wanted = prior[0]!.seat;
        const entry = readSeatRegistry(stateDirectory).find((row) => row.seat === wanted) ?? null;
        let refusal = '';
        if (entry === null) {
          refusal = `The seat this conversation last sat at ('${wanted}') no longer exists; it has been retired since.`;
        } else if (entry.seatId && prior[0]!.seat_id && entry.seatId !== prior[0]!.seat_id) {
          refusal = `Seat '${wanted}' exists but is a different seat under the same name; it was retired and recreated since this conversation sat there.`;
        } else {
          const state = getSeatClaimState(stateDirectory, wanted, agentPid);
          if (state.state === 'free') {
            const failed = enterSeat(workspace, wanted, agentPid, sessionId, deadlineSeconds);
            if (failed === null) {
              add(`Virtual Desk: this conversation was resumed and has been re-bound to the seat it last held, '${wanted}' (project ${entry.project}). Its Desk is exactly as it was left.`);
            } else {
              refusal = `Seat '${wanted}' is the one this conversation last held and it is free, but binding it failed: ${failed}`;
            }
          } else if (state.state === 'orphaned') {
            refusal =
              `Seat '${wanted}' is the one this conversation last held. It is bound to agent process ` +
              `${state.agentPid}, which is still running, and its claim holder is gone -- that is not the same as free. ` +
              'It has to be re-bound from that conversation.';
          } else {
            const who = state.agentPid > 0 ? ` (process ${state.agentPid})` : '';
            refusal = `Seat '${wanted}' is the one this conversation last held, and another live session is at it now${who}.`;
          }
        }
        if (refusal) {
          add(refusal);
          add(servedSection());
          add(seatRoster(stateDirectory, agentPid));
        } else if (prior.length > 1) {
          add(`This conversation also has a record at ${prior.slice(1).map((row) => `'${row.seat}'`).join(', ')}. The most recent was taken; nothing else moved.`);
        }
      }
    } else {
      // startup, clear, fork, or a source not yet named: a fresh start, the safe default.
      add('Virtual Desk: this session holds no seat.');
      add(servedSection());
      add(seatRoster(stateDirectory, agentPid));
    }
  } catch (error) {
    add(
      `Seat state could not be read at session start, so no roster is offered: ${(error as Error).message} ` +
        'Sit down at a seat with deskpost seat enter <name>, or ask the reader which seat they want.',
    );
  }
  return paragraphs.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: paragraphs.join('\n\n') } }) : '';
}
