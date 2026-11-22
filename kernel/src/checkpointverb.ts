/** Seat/conversation front door. No harness registration or UI lives here. */
import { needsYouOn, refreshNeedsYou } from './needsyou.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArguments } from './argv.ts';
import { verbTable } from './verbs.ts';
import { requireWorkspace, readMarker } from './workspace.ts';
import { requireSeat, deskEntriesForSeat, deskFilePath } from './seatdesk.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import { beginSeatMutation, recheckSeatMutation } from './seatpaths.ts';
import { readSeatIdentityView } from './seatincarnation.ts';
import { readRegistryRows, registryFilePath } from './seatregistry.ts';
import { parseBookRoot, placeOfRoot } from './places.ts';
import { getShelfBook } from './shelfbook.ts';
import { shelfNotes } from './shelfnote.ts';
import { hubStatus } from './hubstatus.ts';
import { sectionSpan, shownText, toLines } from './hubedit.ts';
import { enterSeatRegistryLock, enterBookLock, exitBookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import type { PsJsonValue } from './psjson.ts';
import { beginCheckpoint, cancelCheckpoint, checkCheckpoint, checkpointPrompt, checkpointLedger, emptyCheckpoint, observeCheckpointResult,
  type CheckpointState, type CheckpointKind, type OpenItem, type CheckpointToolResult } from './checkpoint.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const own = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const choice = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);

/** Refuse damaged persisted state before it can erase evidence or manufacture a clean result. */
export function validateCheckpoint(value: unknown, seatId: string, conversation: string): CheckpointState {
  const fail = (): never => { throw Error('Checkpoint record is corrupt or belongs to another seat/conversation; preserve it for investigation.'); };
  if (!own(value)) return fail();
  if (value.schema !== 1 || value.seatId !== seatId || value.conversation !== conversation || typeof value.tracking !== 'boolean') return fail();
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  for (const key of ['seen','gaps','waits','saveGaps','saveWaits']) if (!strings(value[key])) return fail();
  for (const key of ['savedWrites','turnsSince']) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return fail();
  if (value.savedAt !== null && (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt))) return fail();
  if (value.closedOutAt !== undefined && value.closedOutAt !== null && (typeof value.closedOutAt !== 'number' || !Number.isFinite(value.closedOutAt))) return fail();
  if (!choice(value.saveState,['none','asked','saved','gaps','waits']) || !choice(value.closeout,['none','asked','done','gaps','waits','stale'])) return fail();
  if (!Array.isArray(value.writes) || !value.writes.every(w => own(w) && choice(w.kind,['hub','book','report','notebook']) && typeof w.name === 'string' && typeof w.page === 'string' && typeof w.at === 'number' && Number.isFinite(w.at) && (w.where === undefined || choice(w.where,['shelf','collection','shared'])))) return fail();
  for (const key of ['ledgerSeen', 'ledgerGaps']) if (value[key] !== undefined && !strings(value[key])) return fail();
  if (Number(value.savedWrites) > value.writes.length) return fail();
  if (value.savedAt === null && (value.saveState === 'saved' || value.closeout === 'done' || Number(value.savedWrites) > 0)) return fail();
  if (!Array.isArray(value.trouble) || !value.trouble.every(t => own(t) && typeof t.id === 'string' && typeof t.text === 'string' && typeof t.at === 'number' && Number.isFinite(t.at))) return fail();
  const r = value.request;
  if (r !== null && (!own(r) || typeof r.id !== 'string' || !choice(r.kind,['save','closeout']) || typeof r.at !== 'number' || !Number.isFinite(r.at) || (r.since !== null && (typeof r.since !== 'number' || !Number.isFinite(r.since))) || !strings(r.trouble) || (r.hub !== null && typeof r.hub !== 'string') || (r.turn !== undefined && typeof r.turn !== 'string') || !Number.isSafeInteger(r.writeCount) || Number(r.writeCount) < 0 || Number(r.writeCount) > value.writes.length || !Array.isArray(r.open) || !r.open.every(o=>own(o)&&choice(o.kind,['book','hub'])&&typeof o.name==='string'&&(o.where===undefined||choice(o.where,['shelf','collection','shared']))))) return fail();
  if ((r === null) !== (value.saveState !== 'asked' && value.closeout !== 'asked')) return fail();
  if (own(r) && ((r.kind === 'save' && (value.saveState !== 'asked' || value.closeout === 'asked')) || (r.kind === 'closeout' && (value.closeout !== 'asked' || value.saveState === 'asked')) || !strings(r.troubleIds))) return fail();
  if (own(r) && Array.isArray(r.open) && r.open.some(o=>own(o)&&o.root!==undefined&&typeof o.root!=='string')) return fail();
  return value as unknown as CheckpointState;
}

function checkpointDesk(workspace: string, stateDirectory: string, seat: string): OpenItem[] {
  if(!fs.existsSync(deskFilePath(stateDirectory,seat,'books'))) throw Error(`Seat '${seat}' has no open-book Desk configuration; start the seat before requesting a checkpoint.`);
  const local = readMarker(workspace)?.['backend'] === 'local';
  const books = deskEntriesForSeat(stateDirectory, seat, 'books').map(root => {
    const parts = parseBookRoot(root);
    if (!parts) throw Error('Virtual Desk open-book state is malformed.');
    return {kind:'book' as const,name:parts.slug,where:placeOfRoot(parts,local),root};
  });
  const hubs = deskEntriesForSeat(stateDirectory, seat, 'projects').map(root => {
    const m = /^(?:archive\/)?projects\/([a-z0-9][a-z0-9-]*)$/.exec(root);
    if (!m) throw Error('Virtual Desk open-project state is malformed.');
    return {kind:'hub' as const,name:m[1]!,root};
  });
  return [...books,...hubs];
}

/** A read-only decision, before there is any pending closeout request. Commands are argument arrays. */
function prepareCloseout(workspace: string, stateDirectory: string, seat: string): PsJsonValue {
  const open = checkpointDesk(workspace, stateDirectory, seat);
  const row = readRegistryRows(registryFilePath(stateDirectory)).find(row => row.seat === seat);
  const hub = typeof row?.project === 'string' && open.some(item => item.kind === 'hub' && item.name === row.project) ? row.project : null;
  if (!hub) return { ask_first: null };
  const status = hubStatus(workspace, hub, seat);
  const over = status.lines.some(line => line.group === 'pages' && line.source === `projects/${hub}/_project` && line.text.includes(', over its limit'));
  const lines = toLines(fs.readFileSync(path.join(workspace, 'collection', 'projects', hub, '_project.md'), 'utf8')), shown = shownText(lines);
  const commands: PsJsonValue[] = [];
  for (const section of ['Now', 'Next']) {
    const span = sectionSpan(lines, section);
    if (!span) continue;
    for (let index = span.start + 1; index < span.end; index++) {
      const line = shown[index];
      if (line && /^(?:[-*+]|[0-9]+\.)[ \t]+\[[xX]\][ \t]+/.test(line)) commands.push({ argv: ['deskpost', 'hub', 'edit', hub, '--mode', 'close-item', '--section', section, '--match-text', line] });
    }
  }
  if (!commands.length && !over) return { ask_first: null };
  if (over) commands.push({ when: 'The Hub is still over its limit after closing ticked items',
    preflight: ['deskpost', 'hub', 'tidy', hub, '--preflight'],
    apply: ['deskpost', 'hub', 'tidy', hub, '--user-confirmed'], plan_id_from: 'the preflight result; append --plan-id and that exact value' });
  return { ask_first: { question: 'Tidy your Hub before closeout?', choices: [
    { label: 'Tidy it now', decided: 'tidied', commands }, { label: 'Not now', decided: 'declined', commands: [] },
  ] } };
}

export function runCheckpointVerb(argv: string[], input?: string, answerUnavailable = false): { value: PsJsonValue } {
  const parsed = parseArguments(argv, verbTable('checkpoint'));
  const [action,kind] = parsed.positional;
  if (!['prepare','request','observe','check','status','cancel'].includes(action ?? '')) throw Error('deskpost checkpoint takes prepare, request, observe, check, status or cancel.');
  if (action === 'prepare' && kind !== 'closeout') throw Error('checkpoint prepare needs closeout.');
  if (['request','check'].includes(action!) && !['save','closeout'].includes(kind ?? '')) throw Error('checkpoint request/check needs save or closeout.');
  const conversation = parsed.options.get('conversation');
  if (!conversation || !SAFE_ID.test(conversation)) throw Error('deskpost checkpoint requires --conversation <id>: 1-128 letters, digits, hyphens or underscores, starting with a letter or digit.');
  const workspace = requireWorkspace({explicit:parsed.options.get('workspace')});
  const stateDirectory = path.join(workspace,'.claude');
  const seat = requireSeat({stateDirectory,seat:parsed.options.get('seat')});
  if (action === 'prepare') return { value: prepareCloseout(workspace, stateDirectory, seat) };
  const started = beginSeatMutation(workspace,seat);
  const identity = readSeatIdentityView(stateDirectory).live.find(row=>row.seat===seat);
  if (!identity || identity.identity !== 'valid') throw Error(`Seat '${seat}' needs a valid seat_id before checkpoint records can be used.`);
  const seatId = identity.seatId;
  const file = path.join(workspace,'internal','checkpoints',seatId,conversation+'.json');
  // A safe component must not be redirected through an existing link outside this workspace.
  const assertRecordPath = () => {
    let current=workspace;
    for(const component of ['internal','checkpoints',seatId,conversation+'.json']) {
      current=path.join(current,component);
      try { if(fs.lstatSync(current).isSymbolicLink()) throw Error('Checkpoint record paths cannot contain symbolic links or junctions.'); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    }
  };
  assertRecordPath();
  const read = () => checkpointLedger(fs.existsSync(file) ? validateCheckpoint(JSON.parse(fs.readFileSync(file,'utf8')),seatId,conversation) : emptyCheckpoint(conversation,seatId), workspace);
  if (action === 'status') return {value:read() as unknown as PsJsonValue};
  assertSeatClaimHeld({workspace,stateDirectory,seat});
  const registryLock = enterSeatRegistryLock(workspace);
  let recordLock: ReturnType<typeof enterBookLock> | null = null;
  try {
    recheckSeatMutation(started);
    recordLock = enterBookLock(workspace,`checkpoint/${seatId}/${conversation}`);
    assertRecordPath();
    const state = read();
    const at = Date.now();
    let next: CheckpointState, prompt: string | undefined;
    const stdin = () => {
      const text=input ?? fs.readFileSync(0,'utf8');
      if (Buffer.byteLength(text,'utf8') > 8*1024*1024) throw Error('Checkpoint input exceeds 8 MiB.');
      return text;
    };
    if (action === 'request') {
      const open = checkpointDesk(workspace,stateDirectory,seat);
      const row = readRegistryRows(registryFilePath(stateDirectory)).find(r=>r.seat===seat);
      const project = typeof row?.project === 'string' ? row.project : null;
      const hub = project && open.some(o=>o.kind==='hub' && o.name===project) ? project : null;
      const decided = parsed.options.get('decided');
      if (decided !== undefined && !['tidied', 'declined', 'tidy-refused'].includes(decided)) throw Error('--decided is tidied, declined or tidy-refused.');
      const reports = state.writes.filter(write => write.kind === 'report');
      const pendingReports = reports.length ? shelfNotes(getShelfBook(workspace, 'reports'))
        .filter(note => note.review === 'pending' && reports.some(write => write.page === note.page)).map(note => note.title) : [];
      next = beginCheckpoint(state,{id:randomUUID(),kind:kind as CheckpointKind,at,since:state.savedAt,open,hub,pendingReports,...(decided ? { decided: decided as 'tidied' | 'declined' | 'tidy-refused' } : {}),trouble:state.trouble.map(t=>t.text),...(parsed.options.has('turn')?{turn:parsed.options.get('turn')!}:{})});
      const harness=parsed.options.get('harness') ?? 'codex';
      if (!['codex','claude'].includes(harness)) throw Error('--harness is codex or claude.');
      prompt=checkpointPrompt(next.request!,next,harness==='codex'?'$':'/');
    } else if (action === 'observe') {
      const event: unknown = JSON.parse(stdin());
      if (!own(event) || !['command', 'cmd', 'tool_input', 'input'].some(key => key in event))
        throw Error('checkpoint observe reads one tool-result object as JSON on stdin, with command, cmd, tool_input or input; a bare writer receipt is not that shape.');
      next=observeCheckpointResult(state,event as CheckpointToolResult,at,true);
    } else if (action === 'check') {
      if(!state.request || state.request.kind!==kind) {
        const checked = kind === 'save' ? state.saveState : state.closeout;
        if (checked !== 'none' && checked !== 'asked') throw Error(`The ${kind} request was already checked (${checked}). A check answers a request once. Start a new one with deskpost checkpoint request ${kind}.`);
        throw Error('No pending request of that kind.');
      }
      next=checkCheckpoint(state,parsed.options.get('request-id') ?? state.request.id,stdin(),checkpointDesk(workspace,stateDirectory,seat),at,parsed.options.get('turn'));
      if (answerUnavailable) {
        const gap = 'unchecked: the answer was not available';
        next = {...next, ...(kind==='save'?{saveState:'gaps' as const,saveGaps:[...next.saveGaps,gap]}:{closeout:'gaps' as const,gaps:[...next.gaps,gap]})};
      }
    } else next=cancelCheckpoint(state);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    recheckSeatMutation(started);
    writeAtomicText(file,JSON.stringify(next,null,2)+'\n');
    return {value:{...next,...(prompt===undefined?{}:{request_id:next.request!.id,prompt})} as unknown as PsJsonValue};
  } finally { exitBookLock(recordLock); exitBookLock(registryLock); }
}

/** Shared advisory adapter. Each harness supplies its conversation, turn and actual final answer.
 * Never denies or changes configuration; the same checkpoint front door owns every mutation. */
export function runCheckpointHook(argv: string[], input: string): string {
  try {
    if (Buffer.byteLength(input, 'utf8') > 8*1024*1024) throw Error('Checkpoint hook input exceeds 8 MiB.');
    const event: unknown = JSON.parse(input);
    if (!own(event) || typeof event.session_id !== 'string' || !SAFE_ID.test(event.session_id)) throw Error('Checkpoint hook needs a valid session_id.');
    const parsed = parseArguments(argv, verbTable('hook'));
    const workspace = requireWorkspace({...(parsed.options.has('workspace')?{explicit:parsed.options.get('workspace')!}:{}), ...(typeof event.cwd==='string'?{startDirectory:event.cwd}:{})});
    const args = ['--conversation', event.session_id, '--workspace', workspace, ...(parsed.options.has('seat')?['--seat',parsed.options.get('seat')!]:[])];
    const invoke = (action: string[], text?: string, unavailable = false) => runCheckpointVerb([...action,...args], text, unavailable).value as unknown as CheckpointState;
    // THE "NEEDS YOU" PAGE, REFRESHED ONLY WHEN A SAVE OR CLOSE-OUT STATE CHANGED (kickoffs/s161 row 6); with no vault
    // connection nothing more is read. A failed refresh is one line on standard error, never this hook's answer.
    const watching = needsYouOn(workspace);
    const refreshIfChanged = (before: CheckpointState | null, after: CheckpointState) => {
      const view = (s: CheckpointState | null) => JSON.stringify(s && [s.saveState, s.closeout, s.saveWaits, s.waits]);
      if (watching && view(before) !== view(after)) refreshNeedsYou(workspace);
    };
    const name = event.hook_event_name;
    if (name === 'PostToolUse') {
      let before: CheckpointState | null = null;
      if (watching) {
        const stateDirectory = path.join(workspace, '.claude'), seat = requireSeat({ stateDirectory, seat: parsed.options.get('seat') });
        const identity = readSeatIdentityView(stateDirectory).live.find(row => row.seat === seat);
        if (!identity || identity.identity !== 'valid') throw Error('Checkpoint hook needs a valid seat identity.');
        const file = path.join(workspace, 'internal', 'checkpoints', identity.seatId, event.session_id + '.json');
        if (fs.existsSync(file)) before = validateCheckpoint(JSON.parse(fs.readFileSync(file, 'utf8')), identity.seatId, event.session_id);
      }
      refreshIfChanged(before, invoke(['observe'], JSON.stringify(event))); return '';
    }
    if (!['UserPromptSubmit','Stop','Interrupt'].includes(String(name))) return '';
    let state = invoke(['status']);
    const turn = typeof event.turn_id === 'string' ? event.turn_id : typeof event.prompt_id === 'string' ? event.prompt_id : undefined;
    if (name === 'UserPromptSubmit') {
      if (typeof event.prompt_id === 'string' && state.request && state.request.turn !== turn) { const before = state; state = invoke(['cancel']); refreshIfChanged(before, state); }
      const context = `Checkpoint conversation id: ${event.session_id}.` + (turn !== undefined ? ` Checkpoint turn id: ${turn}.` : '') +
        ` Checkpoint harness: ${typeof event.prompt_id === 'string' ? 'claude' : 'codex'}.` +
        (state.request ? ` A ${state.request.kind} request waits (request id ${state.request.id}); check or cancel it before another request.` : ' No checkpoint request waits.');
      return JSON.stringify({hookSpecificOutput:{hookEventName:name,additionalContext:context}});
    }
    if (!state.request) return '';
    if (name === 'Interrupt') { refreshIfChanged(state, invoke(['cancel'])); return ''; }
    const answer = typeof event.last_assistant_message==='string' ? event.last_assistant_message : '';
    const next = invoke(['check',state.request.kind,'--request-id',state.request.id,...(turn !== undefined ? ['--turn',turn] : [])],answer,typeof event.last_assistant_message!=='string');
    refreshIfChanged(state, next);
    const gaps = state.request.kind==='save'?next.saveGaps:next.gaps;
    const waits = state.request.kind==='save'?next.saveWaits:next.waits;
    return JSON.stringify({systemMessage:`${state.request.kind}: ${state.request.kind==='save'?next.saveState:next.closeout}. Safe to stop: ${gaps.length||waits.length?'no':'yes'}.` + [...gaps,...waits].map(x=>' '+x).join('')});
  } catch (error) {
    process.stderr.write(`Checkpoint hook unchecked: ${(error as Error).message}\n`);
    return '';
  }
}
