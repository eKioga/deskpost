/**
 * Which conversation a seat last recorded, which assistant owns it, and what it is called: `tools/SeatConversation.ps1`
 * ported for the main menu (PLAN-install-onboarding.md step 5a, ADR-0059).
 *
 * THE RULES ARE THE POWERSHELL FILE'S, and its header carries the measurements behind them. In short:
 *   - the NEWER of the two records wins, the binding's `session_id` or the launcher's advisory one in `activity.json`,
 *     never the more trusted one: a launcher-started session can never hold a binding, so preferring the binding
 *     would offer the conversation before last at exactly the seat a terminal reader uses;
 *   - a title is read from the head of a Claude Code transcript, bounded, and every way it can be missing is its own
 *     status, because a blank column cannot tell "an old client wrote none" from "we stopped looking";
 *   - a conversation this Library's own launcher minted, with no transcript, is RESTARTED under its own id rather than
 *     resumed, because it recorded nothing and `claude --resume` would refuse it.
 *
 * WHAT IS NEW HERE IS THE ASSISTANT (confirmation round, #1). A record carries the assistant that owns it; one written
 * before 1.1 carries none and is Claude Code's, because nothing else was ever launched or bound. A Codex conversation's
 * title is a recorded "not read" reason rather than a second transcript reader, and it is never handed to Claude.
 *
 * EVERY READ HERE IS ADVISORY AND TAKES NO LOCK. Nothing derived here gates anything: `seat start`'s acquisition
 * refuses atomically, and the menu is a read until a choice is made.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { deskStateDirectory } from './seatdesk.ts';
import { readSeatActivity, readSeatBinding } from './seatclaim.ts';

export type Assistant = 'claude' | 'codex';

export const ASSISTANT_LABEL: Record<Assistant, string> = { claude: 'Claude Code', codex: 'Codex' };

// THE BOUND IS SeatConversation.ps1's, from its measurement: the worst first title seen was at line 282 and 682 KB.
const TRANSCRIPT_LINE_BUDGET = 2000;
const TRANSCRIPT_BYTE_BUDGET = 4194304;

const CONVERSATION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A conversation id is DATA from files anything with write access can author, so it is checked by shape first. */
export function isConversationId(value: string | null | undefined): boolean {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/** A minted conversation id for `claude --session-id`, dashed and lowercase. */
export function newConversationId(): string {
  return crypto.randomUUID();
}

/** An assistant name as a record carries it; anything else, a pre-1.1 record included, is Claude Code's. */
export function recordAssistant(value: unknown): Assistant {
  return value === 'codex' ? 'codex' : 'claude';
}

/** Claude Code's transcript folder, honouring CLAUDE_CONFIG_DIR, which moves every transcript elsewhere. */
export function transcriptRoot(configDirectory?: string): string {
  const configured = configDirectory?.trim() || process.env['CLAUDE_CONFIG_DIR']?.trim() || path.join(process.env['USERPROFILE'] || os.homedir(), '.claude');
  return path.join(configured, 'projects');
}

/** One conversation's transcript, found BY NAME across the project folders rather than by guessing Claude's mangling. */
export function transcriptPath(root: string, sessionId: string): string | null {
  if (!isConversationId(sessionId)) return null;
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const candidate = path.join(root, folder.name, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export type TitleStatus =
  | 'titled'
  | 'no-conversation'
  | 'malformed-conversation'
  | 'no-transcript-root'
  | 'no-transcript'
  | 'no-title'
  | 'budget-exhausted'
  | 'unreadable'
  | 'not-read'
  | 'not-looked-up';

export interface TitleAnswer {
  status: TitleStatus;
  title: string;
  reason: string;
}

/** The title of one Claude Code conversation, with a DISTINCT status for every way it can be absent. */
export function conversationTitle(root: string, sessionId: string): TitleAnswer {
  if (!sessionId.trim()) return { status: 'no-conversation', title: '', reason: 'nothing has recorded a conversation at this seat' };
  if (!isConversationId(sessionId)) {
    return { status: 'malformed-conversation', title: '', reason: 'the recorded conversation id is not a uuid, so no transcript was looked for' };
  }
  let rootIsFolder = false;
  try {
    rootIsFolder = fs.statSync(root).isDirectory();
  } catch {
    rootIsFolder = false;
  }
  if (!rootIsFolder) return { status: 'no-transcript-root', title: '', reason: `no transcript directory at ${root}` };
  const file = transcriptPath(root, sessionId);
  // A TRANSCRIPT NOT FOUND IS NOT A DELETED TRANSCRIPT: another CLAUDE_CONFIG_DIR, machine or a pruned history.
  if (file === null) return { status: 'no-transcript', title: '', reason: 'no transcript for it under this configuration' };
  let lines = 0;
  let bytes = 0;
  let reachedEnd = false;
  let title = '';
  try {
    // SHARED FOR WRITING, in effect: the newest row may be the reader's own live conversation.
    const descriptor = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(65536);
      let carry = '';
      const decoder = new TextDecoder('utf-8');
      outer: while (lines < TRANSCRIPT_LINE_BUDGET && bytes < TRANSCRIPT_BYTE_BUDGET) {
        const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (read === 0) {
          if (carry.length) {
            lines += 1;
            bytes += carry.length;
            title = titleFromLine(carry) || title;
          }
          reachedEnd = true;
          break;
        }
        carry += decoder.decode(chunk.subarray(0, read), { stream: true });
        let newline = carry.indexOf('\n');
        while (newline >= 0) {
          const line = carry.substring(0, newline).replace(/\r$/, '');
          carry = carry.substring(newline + 1);
          lines += 1;
          bytes += line.length;
          const found = titleFromLine(line);
          if (found) title = found;
          if (lines >= TRANSCRIPT_LINE_BUDGET || bytes >= TRANSCRIPT_BYTE_BUDGET) break outer;
          newline = carry.indexOf('\n');
        }
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return { status: 'unreadable', title: '', reason: `its transcript could not be read: ${(error as Error).message}` };
  }
  if (title) return { status: 'titled', title, reason: '' };
  if (!reachedEnd) return { status: 'budget-exhausted', title: '', reason: `no title in its first ${lines} lines` };
  return { status: 'no-title', title: '', reason: 'its transcript records no title' };
}

/** THE MARKER TEST BEFORE THE PARSE: a transcript line is a whole turn, and parsing every one would cost seconds. */
function titleFromLine(line: string): string {
  if (!line.includes('"ai-title"')) return '';
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['type'] !== 'ai-title' || typeof record['aiTitle'] !== 'string') return '';
    return record['aiTitle'].trim();
  } catch {
    return '';
  }
}

// --- what a seat remembers ------------------------------------------------------------------------------------------

export interface ConversationRecordView {
  session_id: string;
  /** `binding`, `activity`, `malformed` (a record is there and unusable) or `none`. */
  source: 'binding' | 'activity' | 'malformed' | 'none';
  recorded_utc: string;
  assistant: Assistant;
}

function newer(candidate: string, than: string): boolean {
  const at = Date.parse(candidate);
  if (Number.isNaN(at)) return false;
  const before = Date.parse(than);
  if (Number.isNaN(before)) return true;
  return at > before;
}

/** The conversation a seat last recorded: the NEWER of the committed binding and the launcher's advisory record. */
export function seatConversationRecord(stateDirectory: string, seat: string): ConversationRecordView {
  let record: ConversationRecordView = { session_id: '', source: 'none', recorded_utc: '', assistant: 'claude' };
  let malformed = false;
  let binding: ReturnType<typeof readSeatBinding> = null;
  try {
    binding = readSeatBinding(stateDirectory, seat);
  } catch {
    binding = null;
  }
  if (binding !== null && binding.state === 'committed' && binding.session_id !== undefined) {
    const id = String(binding.session_id);
    if (isConversationId(id)) {
      // A BINDING IS CLAUDE CODE'S OR CODEX'S: the hook that bound it says which, and a pre-1.1 one is Claude's.
      record = { session_id: id, source: 'binding', recorded_utc: String(binding.bound_utc ?? ''), assistant: recordAssistant((binding as unknown as Record<string, unknown>)['assistant']) };
    } else if (id.trim()) malformed = true;
  }
  const activity = readSeatActivity(stateDirectory, seat);
  if (activity !== null && 'session_id' in activity && 'conversation_recorded_utc' in activity) {
    const id = String(activity['session_id']);
    const at = String(activity['conversation_recorded_utc']);
    if (isConversationId(id)) {
      if (newer(at, record.recorded_utc)) record = { session_id: id, source: 'activity', recorded_utc: at, assistant: recordAssistant(activity['assistant']) };
    } else if (id.trim()) malformed = true;
  }
  if (record.source === 'none' && malformed) return { session_id: '', source: 'malformed', recorded_utc: '', assistant: 'claude' };
  return record;
}

/** Whether this Library's own launcher minted this id at this seat. False for anything it cannot prove. */
export function mintedHere(stateDirectory: string, seat: string, sessionId: string): boolean {
  if (!isConversationId(sessionId)) return false;
  const file = path.join(deskStateDirectory(stateDirectory, seat), 'conversations.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { conversations?: unknown };
    const raw = parsed.conversations;
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return entries.some((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>)['source'] === 'launcher' && (entry as Record<string, unknown>)['session_id'] === sessionId);
  } catch {
    return false;
  }
}

export interface ConversationView {
  session_id: string;
  conversation_source: ConversationRecordView['source'];
  recorded_utc: string;
  assistant: Assistant;
  title: string;
  title_status: TitleStatus;
  title_note: string;
  /** `resume`, `restart` (the empty one this launcher minted), `none`, or `not-derived` when titles were not read. */
  entry_action: 'resume' | 'restart' | 'none' | 'not-derived';
  entry_note: string;
}

/** One seat's last conversation, what it is called, and what entering it would do: Get-SeatConversationView. */
export function seatConversationView(stateDirectory: string, seat: string, options: { transcriptRoot?: string; skipTitle?: boolean } = {}): ConversationView {
  const record = seatConversationRecord(stateDirectory, seat);
  const view: ConversationView = {
    session_id: record.session_id,
    conversation_source: record.source,
    recorded_utc: record.recorded_utc,
    assistant: record.assistant,
    title: '',
    title_status: 'no-conversation',
    title_note: '',
    entry_action: 'none',
    entry_note: '',
  };
  if (record.source === 'malformed') {
    view.title_status = 'malformed-conversation';
    view.title_note = 'the conversation it records is not a uuid, so nothing was looked up';
    view.entry_note = 'the conversation it records is not a uuid, so there is nothing to enter';
    return view;
  }
  if (!record.session_id) {
    view.title_note = 'nothing has recorded a conversation at this seat';
    view.entry_note = 'nothing has recorded a conversation at this seat';
    return view;
  }
  if (options.skipTitle) {
    view.title_status = 'not-looked-up';
    view.title_note = 'titles were not read';
    view.entry_action = 'not-derived';
    view.entry_note = 'titles were not read, so the transcript it turns on was never looked for';
    return view;
  }
  if (record.assistant === 'codex') {
    // A CODEX CONVERSATION'S TITLE IS A RECORDED REASON, NOT A SECOND TRANSCRIPT READER; Codex answers whether it resumes.
    view.title_status = 'not-read';
    view.title_note = 'a Codex conversation; its title is not read';
    view.entry_action = 'resume';
    return view;
  }
  const answer = conversationTitle(options.transcriptRoot ?? transcriptRoot(), record.session_id);
  view.title = answer.title;
  view.title_status = answer.status;
  view.title_note = answer.reason;
  if (answer.status === 'no-transcript' && mintedHere(stateDirectory, seat, record.session_id)) {
    view.entry_action = 'restart';
    view.entry_note = 'it was started at this seat and recorded nothing, so a number starts it rather than resuming it';
  } else view.entry_action = 'resume';
  return view;
}

/** The last column: the title in quotes, or the reason there is none. NEVER BLANK. */
export function conversationCell(view: ConversationView, ellipsis = '…', titleWidth = 52): string {
  let cell: string;
  if (view.entry_action === 'restart' && view.entry_note) {
    cell = view.entry_note;
  } else if (view.title_status === 'titled') {
    const title = view.title.length > titleWidth ? view.title.substring(0, titleWidth - ellipsis.length).trimEnd() + ellipsis : view.title;
    cell = `"${title}"`;
  } else cell = view.title_note || view.title_status;
  // ADVISORY IS LABELLED WHEREVER IT IS SHOWN: recorded by a launcher, not a verified binding.
  if (view.conversation_source === 'activity' && view.title_status !== 'no-conversation') cell += ' (advisory)';
  return cell;
}
