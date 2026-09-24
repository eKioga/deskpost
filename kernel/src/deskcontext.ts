/**
 * `library hook desk-context`: the Desk context hook, `.claude/hooks/Get-VirtualDeskContext.ps1`
 * (S36). On every prompt it tells the session which seat it is at, what is open there, and the exact
 * reader tool to call -- or, in one sentence, why it can tell nothing.
 *
 * IT ORIENTS; IT NEVER BLOCKS. Every answer is `additionalContext` for UserPromptSubmit, and every
 * failure is a SENTENCE: "in no workspace" and "two answers disagree" are different states from "the
 * Desk could not be read", and the last one advertises no reader at all, because a session that cannot
 * trust the Desk must not be handed a tool to use against it.
 *
 * THE ONE WRITE is the oracle's backstop recorder: a session bound to its seat by verified identity has
 * its conversation recorded on the binding, under the registry lock, at most once per session (the
 * serve ledger), and any failure there is swallowed -- it is a record, and a prompt must not wait on it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { splitBookRoot } from './desk.ts';
import { asText, BOOK_ROOT_ACCEPT_PATTERN, convertToBookRoot, field, readStateLines } from './guards.ts';
import { setHookServed, testHookServed } from './hookledger.ts';
import { currentAgentProcessId } from './procstart.ts';
import { getSeatClaimState } from './seatclaim.ts';
import { deskFileName, deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { updateSeatConversationRecord } from './seat.ts';
import { DEFAULT_READER_PREFIX, isReaderPrefix, readerPrefixFault } from './readerprefix.ts';
import { resolveWorkspace } from './workspace.ts';

const EVENT = 'UserPromptSubmit';
/**
 * THE READER'S CALLABLE PREFIX, which the harness composes and this hook cannot know (ADR-0007: the tool
 * is advertised by its exact callable name). A project-level server in Claude Code is `mcp__<server>__`,
 * the default; the same server supplied by the Claude plugin is `mcp__plugin_<plugin>_<server>__`, and
 * Codex spells the server with its hyphens as underscores -- each measured in a real session (S37). The
 * plugin packager composes the flag from its one table, so no manifest types a prefix of its own, and
 * `library init` passes Codex's form in a workspace's Codex bindings (S38). The rule is `readerprefix.ts`'s.
 */
const PROJECT_PATTERN = /^(projects|archive\/projects)\/[a-z0-9][a-z0-9-]*$/;
const INVALID =
  'Virtual Desk state is invalid. Do not read any shared Book or Project content. Only the relevant Catalog may be used until the state is repaired.';

export interface DeskContextOptions {
  workspace?: string | undefined;
  stateDirectory?: string | undefined;
  seat?: string | undefined;
  agentPid?: number | undefined;
  deadlineSeconds?: number | undefined;
  readerToolPrefix?: string | undefined;
}

function contextDocument(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } });
}

/** `Get-BookRootLabel`: how one open Book is named to the reader, the two archives told apart. */
export function bookRootLabel(entry: string): string {
  const parts = splitBookRoot(convertToBookRoot(entry));
  if (parts.shelf === 'archive') return parts.collection === 'shelf' ? `${parts.slug} (shelf, archived)` : `${parts.slug} (archived)`;
  return parts.collection === 'shelf' ? `${parts.slug} (shelf)` : `${parts.slug} (shared)`;
}

/** The hook's stdout: always one document, whatever happened. */
export function deskContext(options: DeskContextOptions, stdinText: string): string {
  let workspace = options.workspace ?? '';
  let stateDirectory = options.stateDirectory ?? '';
  let seatState: ReturnType<typeof resolveSeatName>;
  let sessionId: string;
  let agentPid: number;
  let deskDirectory: string | null;
  let deskPresent: boolean;
  const prefix = options.readerToolPrefix || DEFAULT_READER_PREFIX;
  // A prefix that is not one names no tool at all, and advertising it would be the defect this flag
  // exists to remove: said in one sentence, like every other state this hook cannot answer from.
  // The sentence is the oracle's since S38, which names no flag: the oracle spells it -ReaderToolPrefix.
  if (!isReaderPrefix(prefix)) return contextDocument(`Virtual Desk unavailable: ${readerPrefixFault(prefix)}`);
  try {
    if (!workspace || !stateDirectory) {
      // AN EXPLICIT STATE DIRECTORY NAMES THE WORKSPACE, as in every other hook.
      let selected = workspace;
      if (!selected && stateDirectory) selected = path.dirname(stateDirectory);
      const resolved = resolveWorkspace({ explicit: selected });
      if (resolved.kind === 'conflict') return contextDocument(`Virtual Desk unavailable: ${resolved.reason ?? ''}`);
      if (resolved.kind !== 'resolved') {
        return contextDocument(
          'Virtual Desk unavailable: this session is in no Library workspace, so no Book or Project ' +
            'can be open. Run from inside a workspace, set LIBRARY_WORKSPACE, or create one with ' +
            '`library init <folder>`.',
        );
      }
      if (!workspace) workspace = resolved.workspace!;
      if (!stateDirectory) stateDirectory = path.join(resolved.workspace!, '.claude');
    }
    const raw = stdinText.replace(/^﻿/, '');
    const call = raw.trim() ? (JSON.parse(raw) as unknown) : null;
    sessionId = asText(field(call, 'session_id'));
    agentPid = options.agentPid !== undefined && options.agentPid >= 0 ? options.agentPid : currentAgentProcessId();
    seatState = resolveSeatName({ seat: options.seat, stateDirectory, agentPid });
    deskDirectory = seatState.status === 'named' ? deskStateDirectory(stateDirectory, seatState.seat!) : null;
    deskPresent = deskDirectory !== null && fs.existsSync(deskDirectory) && fs.statSync(deskDirectory).isDirectory();
  } catch {
    return contextDocument(INVALID);
  }

  try {
    if (seatState.status !== 'named') {
      return contextDocument(
        'Virtual Desk - no seat. ' + seatState.message +
          ' Until a seat is entered no Book or Project can be opened or read, and nothing in the Library can be changed.' +
          " Reading the Library's own files is unaffected. Ask the reader which seat they want and bind it; a plain answer is enough.",
      );
    }
    const seat = seatState.seat!;
    if (!deskPresent) {
      return contextDocument(
        `Virtual Desk - seat '${seat}' has no Desk in this workspace. ` +
          `Create it with tools/Start-LibrarySeat.ps1 -Seat ${seat} -Project <project-slug>.`,
      );
    }
    let seatNote = '';
    let seatWarning = '';
    if (seatState.source === 'binding') {
      seatNote = ', bound to this conversation';
      if (getSeatClaimState(stateDirectory, seat, agentPid).state === 'orphaned') {
        seatNote = ', holder lost';
        seatWarning =
          " This seat's claim holder is gone while this conversation is still bound to it, so every write will refuse." +
          ` Re-bind before changing anything: tools/Enter-LibrarySeat.ps1 -Seat ${seat}.`;
      }
      // THE BACKSTOP RECORDER, and the lock is taken only when there is something to write.
      try {
        const ledgerKey = `seat-conversation:${seat}:${sessionId}`;
        if (!testHookServed(stateDirectory, sessionId, ledgerKey)) {
          const recorded = updateSeatConversationRecord({ workspace, stateDirectory, seat, agentPid, sessionId, deadlineSeconds: options.deadlineSeconds ?? 2 });
          if (recorded !== 'already-recorded') setHookServed(stateDirectory, sessionId, ledgerKey);
        }
      } catch {
        // swallowed: a record, and a prompt must not wait on it
      }
    } else {
      seatNote = `, ${seatState.source === 'environment' ? 'named by LIBRARY_SEAT' : 'named explicitly'} and not bound to this conversation`;
    }

    const openBooks = readStateLines(path.join(deskDirectory!, deskFileName('books')), BOOK_ROOT_ACCEPT_PATTERN, 'open-book', false).map(bookRootLabel);
    const openProjects = readStateLines(path.join(deskDirectory!, deskFileName('projects')), PROJECT_PATTERN, 'open-project', true);
    const books = openBooks.length ? openBooks.join(', ') : '(none)';
    const projects = openProjects.length ? openProjects.join(', ') : '(none)';
    // NAMING THE CALLABLE TOOL, for the kind of material actually open.
    const readerCalls: string[] = [];
    if (openBooks.length) readerCalls.push(`${prefix}read_open_book_page for an open Book`);
    if (openProjects.length) readerCalls.push(`${prefix}read_open_project_page for an open Project Hub`);
    const capability = readerCalls.length
      ? ' The validated reader is connected: call ' + readerCalls.join(', ') + '.'
      : ` The validated reader is connected: call ${prefix}read_book_catalog or ${prefix}read_project_catalog to see what could be opened.`;
    return contextDocument(
      `Virtual Desk (seat ${seat}${seatNote}) - Books: ${books}. Projects: ${projects}. Read Book and Project pages only through the validated reader, and only these open ones. Shelf Book pages are not readable with the Read tool while closed.${capability}${seatWarning}`,
    );
  } catch {
    return contextDocument(INVALID);
  }
}

/** `library hook desk-context [--workspace <p>] [--state-directory <d>] [--seat <s>] [--agent-pid <n>] [--deadline-seconds <n>] [--reader-tool-prefix <p>]`. */
export function runDeskContextVerb(argv: string[], stdinText: string): string {
  const parsed = parseArguments(argv, ['workspace', 'seat', 'state-directory', 'agent-pid', 'deadline-seconds', 'reader-tool-prefix']);
  const pid = parsed.options.get('agent-pid');
  const deadline = parsed.options.get('deadline-seconds');
  return deskContext(
    {
      workspace: parsed.options.get('workspace'),
      stateDirectory: parsed.options.get('state-directory'),
      seat: parsed.options.get('seat'),
      agentPid: pid !== undefined && /^-?\d+$/.test(pid) ? Number(pid) : undefined,
      deadlineSeconds: deadline !== undefined && Number.isFinite(Number(deadline)) ? Number(deadline) : undefined,
      readerToolPrefix: parsed.options.get('reader-tool-prefix'),
    },
    stdinText,
  );
}
