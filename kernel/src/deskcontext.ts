/**
 * `library hook desk-context`: the Desk context hook, `.claude/hooks/Get-VirtualDeskContext.ps1`
 * (S36). On every prompt it tells the session which seat it is at, what is open there, and the exact
 * reader tool to call -- or, in one sentence, why it can tell nothing.
 *
 * SAID ONCE PER SESSION WHERE THAT IS SAFE (S77): an unchanged block already served into this conversation is not
 * sent again, and the stdout is then empty, or carries only `sessionTitle`. See `ledgerClearReaches`.
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
import { argumentTable } from './verbs.ts';
import { splitBookRoot } from './desk.ts';
import { asText, BOOK_ROOT_ACCEPT_PATTERN, convertToBookRoot, field, readStateLines } from './guards.ts';
import { setHookServed, testHookServed } from './hookledger.ts';
import { currentAgentProcessId, launcherDirectAgent } from './procstart.ts';
import { getSeatClaimState, launcherHoldsSeatForThisAgent, readSeatActivity, writeSeatActivity } from './seatclaim.ts';
import { conversationTitle, isConversationId, transcriptRoot } from './conversation.ts';
import { deskFileName, deskStateDirectory, resolveSeatName } from './seatdesk.ts';
import { recordLauncherConversation, updateSeatConversationRecord } from './seat.ts';
import { DEFAULT_READER_PREFIX, isReaderPrefix, readerPrefixFault } from './readerprefix.ts';
import { resolveWorkspace } from './workspace.ts';
import { placeOfRoot } from './places.ts';
import { isLocalBackend } from './basicmemory.ts';
import { readNotebookLayout } from './notebooklayout.ts';
import { sha256OfText } from './sha.ts';
import { asList, hookEntryText, isObject } from './hookregistry.ts';
import { departmentOf, metadataFor, readSeatMetadata } from './seatmeta.ts';

/**
 * ONE STATIC LINE FOR A SEAT IN A DEPARTMENT (1.3.8, kickoffs/s96 row 4, ruling 6; ADR-0069): its role and its
 * orchestrator's name, with no counts and no liveness, because the block is sent again whenever its text changes and
 * ADR-0062 forbids a per-prompt letter line. A seat with no department gets none, so its text is as it was.
 */
export function directoryLine(stateDirectory: string, seat: string): string {
  const projection = readSeatMetadata(stateDirectory);
  const own = metadataFor(projection, seat);
  if (own.department === null) return '';
  if (own.role === 'orchestrator') return ` This seat is the orchestrator of ${own.department}; \`deskpost seat cards\` lists it.`;
  if (own.role === 'performer') {
    const orchestrator = departmentOf(projection, seat)?.orchestrator ?? null;
    return orchestrator
      ? ` This seat is a performer in ${own.department}; its orchestrator is ${orchestrator}.`
      : ` This seat is a performer in ${own.department}, which has no orchestrator yet; \`deskpost seat cards\` lists who does what.`;
  }
  return ` This seat is in ${own.department}; \`deskpost seat cards\` lists it.`;
}

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

function contextDocument(text: string, sessionTitle?: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text, ...(sessionTitle ? { sessionTitle } : {}) } });
}

/**
 * THE NAME A SEAT'S SESSION ANSWERS TO (1.2.6, PLAN-seat-messaging.md Phase 2, kickoffs/s75-r2 row 1): `ListAgents` and
 * `/resume` show a session's name, and an unnamed one is named after the Library folder, so no seat could be found.
 *
 * ONLY ONCE THE GENERATED TITLE EXISTS. A session named before Claude Code titles it never gets a title, and the menu
 * shows that title, so the first prompt never names: the second or a later one does. THE READER'S OWN NAME WINS: an
 * input carrying any `session_title` (`--name`, `/rename`, an earlier answer here) is never renamed. A Codex seat has no
 * inbox and is never named. Only a seat this session is PROVEN to hold (bound, or held by its launcher) names it.
 *
 * THE RECORD FOLLOWS THE NAME THE SESSION ANSWERS TO (kickoffs/s79 row 0, the 1.2.6 proof's step 8): a session the
 * reader named or renamed carries that name as its `session_title`, and the record is rewritten to it whenever it
 * differs, with no `sessionTitle` sent back. So `message_name` is "the name it answers to", never "the seat's name", and
 * a peer is never handed a dead address. It needs no earlier record: a session renamed before it ever named itself, or
 * a new conversation renamed while the record names an earlier one, is recorded on its first prompt.
 *
 * The record goes into `activity.json` beside the conversation it names, written only when it is not there yet. Every
 * failure answers "no name": a prompt must not wait on it, and the context it carries is the same either way.
 */
function seatSessionName(stateDirectory: string, seat: string, sessionId: string, call: unknown, proven: boolean): string {
  if (!proven || !isConversationId(sessionId)) return '';
  if ((process.env['DESKPOST_ASSISTANT'] ?? '') === 'codex') return '';
  const given = asText(field(call, 'session_title')).trim();
  if (given) {
    const recorded = readSeatActivity(stateDirectory, seat);
    if (!recorded || recorded['message_name'] !== given || recorded['message_session_id'] !== sessionId) {
      writeSeatActivity({ stateDirectory, seat, note: 'session renamed', keepConversation: true, messageName: { name: given, sessionId } });
    }
    return '';
  }
  const answer = conversationTitle(transcriptRoot(), sessionId);
  if (answer.status !== 'titled' || answer.source !== 'ai-title') return '';
  const activity = readSeatActivity(stateDirectory, seat);
  if (!activity || activity['message_name'] !== seat || activity['message_session_id'] !== sessionId) {
    writeSeatActivity({ stateDirectory, seat, note: 'session named', keepConversation: true, messageName: { name: seat, sessionId } });
  }
  return seat;
}

const CLEAR_HOOK = 'restore-compactedguidance.ps1';
const CLEAR_EVENTS = ['PostCompact', 'SessionStart'];

/** A registration's words, quoted ones kept whole: its `command` and `args`, whichever shape it is in. */
function entryTokens(entry: unknown): string[] {
  if (!isObject(entry)) return [];
  if (Array.isArray(entry['args'])) return [String(entry['command'] ?? ''), ...entry['args'].map((arg) => String(arg))];
  const tokens: string[] = [];
  for (const match of hookEntryText(entry).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  return tokens;
}

function samePath(left: string, right: string): boolean {
  const normal = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normal(left) === normal(right);
}

/**
 * WHETHER THE SERVE-LEDGER CLEAR REACHES THIS LEDGER (kickoffs/s77 row 0). The Desk block is withheld only when a
 * compaction or a resume is certain to empty the ledger it is recorded in, or a session would lose its Desk with its
 * context. The clear is `Restore-CompactedGuidance.ps1`, which is optional, and it empties the ledger in its
 * `-StateDirectory`, or by default the `.claude` its own script sits in. So it reaches this one only when this
 * workspace's settings register it on BOTH events, its script exists, and its state directory is this one.
 *
 * MEASURED, NOT ASSUMED (S77): an installed Library registers `<program>/.claude/hooks/Restore-CompactedGuidance.ps1`
 * with no `-StateDirectory`, so its clear empties the PROGRAM's `.claude/.hook-served.json`, never the workspace's this
 * hook writes, and this answers false there. Since S82 a compiled or POSIX init registers the kernel's own
 * `hook compact-clear` instead, which empties the workspace's ledger, so an installed Library answers true. The file
 * the harness reads is the one judged: when `settings.local.json`
 * declares its own `hooks` block only it counts (`launchSettingsFaults`' rule), and the plugin registers no clear.
 */
export function ledgerClearReaches(workspace: string, stateDirectory: string): boolean {
  const trees = new Map<string, unknown>();
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(stateDirectory, name);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) trees.set(name, JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown);
    } catch {
      return false;
    }
  }
  const local = trees.get('settings.local.json');
  const tree = isObject(local) && 'hooks' in local ? local : trees.get('settings.json');
  if (!isObject(tree) || !isObject(tree['hooks'])) return false;
  const events = tree['hooks'] as Record<string, unknown>;
  const clears = (entry: unknown): boolean => {
    const tokens = entryTokens(entry);
    // THE KERNEL'S VERB (S82, ADR-0064): `<binary> hook compact-clear` empties `--state-directory` if it names one, and
    // otherwise `<workspace>/.claude` of the workspace it resolves as this hook does -- this one, so it reaches this
    // ledger exactly when that is the state directory this hook writes. The binary must be there to run at all.
    const verbAt = tokens.findIndex((token, index) => token === 'hook' && tokens[index + 1] === 'compact-clear');
    if (verbAt >= 0) {
      const binary = tokens[0] ?? '';
      if (!binary.trim() || !fs.existsSync(path.isAbsolute(binary) ? binary : path.join(workspace, binary))) return false;
      const flag = tokens.findIndex((token) => token === '--state-directory');
      const target = flag >= 0 ? tokens[flag + 1] ?? '' : path.join(workspace, '.claude');
      return target.trim() !== '' && samePath(path.isAbsolute(target) ? target : path.join(workspace, target), stateDirectory);
    }
    const at = tokens.findIndex((token) => path.basename(token.replace(/\\/g, '/')).toLowerCase() === CLEAR_HOOK);
    if (at < 0) return false;
    const script = path.isAbsolute(tokens[at]!) ? tokens[at]! : path.join(workspace, tokens[at]!);
    if (!fs.existsSync(script)) return false;
    const flag = tokens.findIndex((token) => token.toLowerCase() === '-statedirectory');
    const target = flag >= 0 ? tokens[flag + 1] ?? '' : path.dirname(path.dirname(script));
    return target.trim() !== '' && samePath(path.isAbsolute(target) ? target : path.join(workspace, target), stateDirectory);
  };
  return CLEAR_EVENTS.every((event) => asList(events[event]).some((block) => isObject(block) && asList(block['hooks']).some(clears)));
}

/** `Get-BookRootLabel`: how one open Book is named to the reader, the two archives told apart. */
/**
 * A Book as the prompt names it. ITS PLACE, NOT ITS PREFIX (PLAN-basic-memory.md step 1): a local Library's own
 * `books/` Book is `(collection)`, where until 1.1 it read `(shared)`; a `shared/` connection Book is `(shared)`.
 */
export function bookRootLabel(entry: string, localBackend = false): string {
  const parts = splitBookRoot(convertToBookRoot(entry));
  const place = placeOfRoot(parts, localBackend);
  if (parts.shelf === 'archive') {
    return place === 'shelf' ? `${parts.slug} (shelf, archived)` : place === 'collection' ? `${parts.slug} (collection, archived)` : `${parts.slug} (archived)`;
  }
  return `${parts.slug} (${place})`;
}

/** The hook's stdout: always one document, whatever happened. */
export function deskContext(options: DeskContextOptions, stdinText: string): string {
  let workspace = options.workspace ?? '';
  let stateDirectory = options.stateDirectory ?? '';
  let seatState: ReturnType<typeof resolveSeatName>;
  let sessionId: string;
  let call: unknown;
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
    call = raw.trim() ? (JSON.parse(raw) as unknown) : null;
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
          `Create it with deskpost seat start ${seat} --project <project-slug>.`,
      );
    }
    let seatNote = '';
    let seatWarning = '';
    let proven = false;
    if (seatState.source === 'binding') {
      seatNote = ', bound to this conversation';
      proven = true;
      if (getSeatClaimState(stateDirectory, seat, agentPid).state === 'orphaned') {
        proven = false;
        seatNote = ', holder lost';
        seatWarning =
          " This seat's claim holder is gone while this conversation is still bound to it, so every write will refuse." +
          ` Re-bind before changing anything: deskpost seat enter ${seat}.`;
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
      // A LAUNCHER-HELD SEAT IS SAID AS ONE (the S60 report, #1): "not bound" sent a new user, seconds after `deskpost`
      // started the seat, off to bind it. Only when the claim's token and the process tree both prove it.
      proven = seatState.source === 'environment' && launcherHoldsSeatForThisAgent(stateDirectory, seat);
      seatNote = proven
        ? ', held for this session by the deskpost launcher that started it'
        : `, ${seatState.source === 'environment' ? 'named by LIBRARY_SEAT' : 'named explicitly'} and not bound to this conversation`;
      // A LAUNCHER-HELD SESSION REPORTS ITS CONVERSATION (ADR-0059): Codex takes no id at launch, so `seat start` could
      // not record one, and this is the first moment the id is known. The token proves the seat; THE PROCESS TREE PROVES
      // THE SESSION (inspection #1): the environment is inherited by anything run under the agent, a nested Codex
      // included, so only the launcher's direct agent may report, and its image name, not the variable, is the assistant.
      const claimToken = process.env['LIBRARY_SEAT_CLAIM'] ?? '';
      const launcherPid = Number(process.env['DESKPOST_LAUNCHER_PID'] ?? '');
      if (seatState.source === 'environment' && claimToken.trim() && sessionId.trim() && launcherPid > 0) {
        try {
          const ledgerKey = `launcher-conversation:${seat}:${sessionId}`;
          if (!testHookServed(stateDirectory, sessionId, ledgerKey)) {
            const direct = launcherDirectAgent(launcherPid);
            const declared = process.env['DESKPOST_ASSISTANT'] ?? '';
            if (direct !== null && (!declared || declared === direct.assistant)) {
              const recorded = recordLauncherConversation({ workspace, seat, sessionId, claimToken, assistant: direct.assistant });
              if (recorded !== 'not-this-launcher') setHookServed(stateDirectory, sessionId, ledgerKey);
            } else setHookServed(stateDirectory, sessionId, ledgerKey);
          }
        } catch {
          // swallowed: a record, and a prompt must not wait on it
        }
      }
    }

    const localBackend = isLocalBackend(workspace);
    const openBooks = readStateLines(path.join(deskDirectory!, deskFileName('books')), BOOK_ROOT_ACCEPT_PATTERN, 'open-book', false).map((entry) =>
      bookRootLabel(entry, localBackend),
    );
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
    // ONE SENTENCE, AND ONLY WHEN NOTEBOOK WRITES WILL REFUSE (S67), so the always-on margin is unchanged otherwise.
    let notebookWarning = '';
    try {
      const layoutState = readNotebookLayout(workspace).state;
      if (layoutState === 'legacy') notebookWarning = " This Library's Notebook is in the retired shared layout, so Notebook writes refuse until 'deskpost migrate' runs; save to the Holding Shelf meanwhile.";
      if (layoutState === 'migrating') notebookWarning = " A Notebook migration is unfinished, so Notebook writes refuse until 'deskpost migrate --resume' or '--rollback'.";
    } catch {
      // a layout that cannot be read is the migration verb's to report, not a prompt's to wait on
    }
    let sessionTitle = '';
    try {
      sessionTitle = seatSessionName(stateDirectory, seat, sessionId, call, proven);
    } catch {
      // swallowed: a name, and a prompt must not wait on it
    }
    let roleLine = '';
    try {
      roleLine = directoryLine(stateDirectory, seat);
    } catch {
      // swallowed: a static line, and a prompt must not wait on it
    }
    const text = `Virtual Desk (seat ${seat}${seatNote}) - Books: ${books}. Projects: ${projects}. Read Book and Project pages only through the validated reader, and only these open ones. Shelf Book pages are not readable with the Read tool while closed.${capability}${roleLine}${seatWarning}${notebookWarning}`;
    // ONCE PER SESSION, KEYED ON THE TEXT ITSELF (kickoffs/s77 row 0, the desk-context Report): an identical block
    // already served into this conversation is still in it, so it is not sent again. A changed Desk, seat or warning
    // is a different text and is sent. Only where the ledger clear is proven to reach this ledger (above), only for
    // Claude Code's own reader prefix -- a Codex or plugin session runs no clear of its own -- and never without a
    // session id. A withheld block still carries the session's name: naming is its own once-only record.
    try {
      const claudeCode = prefix === DEFAULT_READER_PREFIX && (process.env['DESKPOST_ASSISTANT'] ?? '') !== 'codex';
      if (claudeCode && sessionId.trim() && ledgerClearReaches(workspace, stateDirectory)) {
        const ledgerKey = `desk-context:${seat}:${sha256OfText(text)}`;
        if (testHookServed(stateDirectory, sessionId, ledgerKey)) {
          return sessionTitle ? JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, sessionTitle } }) : '';
        }
        setHookServed(stateDirectory, sessionId, ledgerKey);
      }
    } catch {
      // a ledger that cannot be read or written sends the block: repetition, never a withheld Desk
    }
    return contextDocument(text, sessionTitle);
  } catch {
    return contextDocument(INVALID);
  }
}

/** `library hook desk-context [--workspace <p>] [--state-directory <d>] [--seat <s>] [--agent-pid <n>] [--deadline-seconds <n>] [--reader-tool-prefix <p>]`. */
export function runDeskContextVerb(argv: string[], stdinText: string): string {
  const parsed = parseArguments(argv, argumentTable('hook', 'desk-context'));
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
