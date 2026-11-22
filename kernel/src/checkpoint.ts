/** Shared save/closeout state and checks. Harnesses supply observations, never completion claims. */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireWorkspace, readMarker } from './workspace.ts';
import { writingSeat } from './journal.ts';
import { parseArguments } from './argv.ts';
import { argumentTable, commandAction } from './verbs.ts';
export type CheckpointKind = 'save' | 'closeout';
export type OpenItem = { kind: 'book' | 'hub'; name: string; where?: string; root?: string };
export type CheckpointWrite = { kind: 'book' | 'hub' | 'report' | 'notebook'; name: string; page: string; where?: string; at: number; title?: string };
export type CheckpointTrouble = { id: string; text: string; at: number };
export type CheckpointRequest = {
  id: string; kind: CheckpointKind; at: number; since: number | null; open: OpenItem[];
  hub: string | null; trouble: string[]; turn?: string; writeCount?: number; troubleIds?: string[];
  pendingReports?: string[];
  decided?: 'tidied' | 'declined' | 'tidy-refused';
};
export type CheckpointState = {
  schema: 1; seatId: string; conversation: string; tracking: boolean;
  writes: CheckpointWrite[]; seen: string[]; trouble: CheckpointTrouble[];
  request: CheckpointRequest | null; savedAt: number | null; savedWrites: number; closedOutAt?: number | null;
  saveState: 'none' | 'asked' | 'saved' | 'gaps' | 'waits';
  closeout: 'none' | 'asked' | 'done' | 'gaps' | 'waits' | 'stale';
  gaps: string[]; waits: string[]; saveGaps: string[]; saveWaits: string[]; turnsSince: number;
  ledgerSeen?: string[]; ledgerGaps?: string[];
};

export function emptyCheckpoint(conversation: string, seatId = ''): CheckpointState {
  return { schema: 1, seatId, conversation, tracking: false, writes: [], seen: [], trouble: [],
    request: null, savedAt: null, savedWrites: 0, closedOutAt: null, saveState: 'none', closeout: 'none',
    gaps: [], waits: [], saveGaps: [], saveWaits: [], turnsSince: 0 };
}

export function itemKey(kind: string, name: string, where?: string): string {
  return `${kind}:${name}${kind === 'book' && where ? '@' + where.toLowerCase() : ''}`;
}
export function openSignature(open: readonly OpenItem[]): string {
  return JSON.stringify(open.map(o => itemKey(o.kind, o.name, o.where) + (o.root ? ':' + o.root : '')).sort());
}
export function beginCheckpoint(state: CheckpointState, request: CheckpointRequest): CheckpointState {
  if (state.request) throw Error(`A ${state.request.kind} request is waiting; check or cancel it first.`);
  return { ...state, request: { ...request, open: request.open.map(o => ({ ...o })),
    trouble: [...request.trouble], troubleIds: state.trouble.filter(t => request.trouble.includes(t.text)).map(t => t.id), writeCount: state.writes.length },
    ...(request.kind === 'save' ? { saveState: 'asked' as const } : { closeout: 'asked' as const }) };
}
export function cancelCheckpoint(state: CheckpointState): CheckpointState {
  if (!state.request) return state;
  return { ...state, request: null, ...(state.request.kind === 'save'
    ? { saveState: state.savedAt === null ? 'none' as const : 'saved' as const }
    : { closeout: 'none' as const, closedOutAt: null }) };
}
export function observeCheckpoint(state: CheckpointState, writes: CheckpointWrite[], eventId?: string): CheckpointState {
  if (eventId && state.seen.includes(eventId)) return state;
  return { ...state, tracking: true, writes: [...state.writes, ...writes],
    seen: eventId ? [...state.seen, eventId] : state.seen,
    closeout: writes.length && ['done', 'gaps', 'waits'].includes(state.closeout) ? 'stale' : state.closeout };
}

export type Verdict = { verdict: 'updated' | 'nothing new' | 'needs update' | 'waits for eric'; detail: string };
export type ReportsVerdict = { verdict: 'filed' | 'none'; detail: string };
function lastBlock(answer: string, fence: CheckpointKind): string | undefined {
  return [...answer.matchAll(new RegExp('```' + fence + String.raw`\s*\r?\n([\s\S]*?)` + '```', 'g'))].at(-1)?.[1];
}
export function parseCloseoutBlock(answer: string, fence: CheckpointKind = 'closeout'): Map<string, Verdict> | null {
  const body = lastBlock(answer, fence);
  if (body === undefined) return null;
  const values = new Map<string, Verdict>();
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(book|hub)\s+([^:\s]+)\s*:\s*(updated|nothing new|needs update|waits for (?:eric|approval))\b\s*:?\s*(.*)$/i.exec(line);
    if (!m) continue;
    const word = m[3]!.toLowerCase();
    values.set(`${m[1]!.toLowerCase()}:${m[2]}`, { verdict: (word.startsWith('waits') ? 'waits for eric' : word) as Verdict['verdict'], detail: m[4]!.trim() });
  }
  return values;
}
export function parseReportsLine(answer: string, fence: CheckpointKind = 'closeout'): ReportsVerdict | null {
  const body = lastBlock(answer, fence);
  if (body === undefined) return null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*reports\s*:\s*(filed|none)\b\s*:?\s*(.*)$/i.exec(line);
    if (m) return { verdict: m[1]!.toLowerCase() as ReportsVerdict['verdict'], detail: m[2]!.trim() };
  }
  return null;
}
const WAITS_NOTE = /(?<!\b(?:what|which|that) )\bwait(?:s|ing)? (?:for|on) (?:(?:eric'?s?|your) (?:yes|approval|ok|answer|decision|sign-off)\b|approval\b|eric\b(?!'?s\b))|\b(?:needs|pending|until|awaiting|awaits) (?:your|eric'?s) (?:yes|approval|ok)\b/i;
export function isWaiting(v: Verdict): boolean { return v.verdict === 'waits for eric' || WAITS_NOTE.test(v.detail); }

/** Consumes exactly one pending request; a wrong identity leaves it available for cancellation. */
export function checkCheckpoint(state: CheckpointState, id: string, answer: string, open: readonly OpenItem[], at: number, turn?: string): CheckpointState {
  const r = state.request;
  if (!r || r.id !== id) throw Error('No matching pending checkpoint request; completed requests cannot be replayed.');
  if (r.turn !== undefined && r.turn !== turn) throw Error('The answer belongs to a different turn.');
  const gaps: string[] = [], waits: string[] = [];
  gaps.push(...(state.ledgerGaps ?? []));
  if (!state.tracking) gaps.push('Tool-result tracking has not begun.');
  if (openSignature(open) !== openSignature(r.open)) gaps.push('The open Books and Hubs changed after the request.');
  const values = parseCloseoutBlock(answer, r.kind);
  if (!values) gaps.push(`The answer had no \`\`\`${r.kind} block.`);
  else {
    const body = lastBlock(answer, r.kind)!;
    const keys = [...body.matchAll(/^\s*((?:book|hub)\s+[^:\s]+|reports)\s*:/gim)].map(m => m[1]!.toLowerCase());
    if (new Set(keys).size !== keys.length) gaps.push('The block has duplicate verdict lines.');
    const reports = parseReportsLine(answer, r.kind);
    const hadTrouble = r.trouble.length > 0 || (r.kind === 'closeout' && state.trouble.length > 0);
    const reportWrites = state.writes.filter((w, i) => w.kind === 'report' && (r.kind === 'save'
      ? i >= (r.writeCount ?? 0) && w.at >= r.at : i >= state.savedWrites));
    const filed = reportWrites.length > 0;
    if (!reports && (r.kind === 'closeout' || r.trouble.length)) gaps.push('Reports: no reports line.');
    else if (reports?.verdict === 'filed' && !filed) gaps.push('Reports: said filed, but no Report was seen for this checkpoint.');
    else if (reports?.verdict === 'none' && hadTrouble && !filed && !reports.detail) gaps.push('Reports: none, but Library commands failed and no reason was given.');
    for (const o of r.open) {
      const label = `${o.kind === 'book' ? 'Book' : 'Hub'} ${o.name}${o.where ? ' (' + o.where + ')' : ''}`;
      const base = itemKey(o.kind, o.name), key = itemKey(o.kind, o.name, o.where);
      const ambiguous = r.open.filter(other => itemKey(other.kind, other.name) === base).length > 1;
      const v = values.get(key) ?? (!ambiguous ? values.get(base) : undefined);
      if (!v) { gaps.push(`${label}: ${ambiguous && values.has(base) ? 'ambiguous location' : 'no verdict'}.`); continue; }
      if (v.verdict === 'needs update') gaps.push(`${label}: still needs an update.`);
      if (isWaiting(v)) waits.push(`${label}${v.detail ? ': ' + v.detail : ''}`);
      if (v.verdict === 'updated') {
        if (o.kind === 'hub' && o.name !== r.hub) gaps.push(`${label}: cannot update another seat's Hub.`);
        const written = state.writes.filter((w, i) => i >= state.savedWrites && w.kind === o.kind && w.name === o.name && (!o.where || w.where === o.where.toLowerCase()));
        if (!written.length) gaps.push(`${label}: said updated, but no successful write since the last clean save.`);
        else {
          const page = v.detail.split(/[\s(;,:]/)[0]?.replace(/[.,;]+$/, '').replace(/^`|`$/g, '').replace(/\.md$/, '');
          const canonical = canonicalWrite(page, at);
          if (!page || !written.some(w => w.page === page || (canonical && canonical.kind === w.kind && canonical.name === w.name && canonical.page === w.page && canonical.where === w.where))) gaps.push(`${label}: named page does not match a successful write.`);
        }
      }
      if (r.kind === 'save' && o.kind === 'hub' && o.name === r.hub && v.verdict === 'nothing new' && !v.detail && state.savedAt === null && state.turnsSince > 0)
        gaps.push(`${label}: nothing new on the first save after work, with no reason.`);
    }
    if (r.kind === 'save' && r.hub === null) gaps.push("This seat's Hub is not open, so Now and Next were not saved.");
  }
  const clean = !gaps.length && !waits.length;
  return { ...state, request: null,
    ...(r.kind === 'save' ? { saveState: gaps.length ? 'gaps' as const : waits.length ? 'waits' as const : 'saved' as const, saveGaps: gaps, saveWaits: waits }
      : { closeout: gaps.length ? 'gaps' as const : waits.length ? 'waits' as const : 'done' as const, gaps, waits }),
    ...(clean && r.kind === 'closeout' ? { closedOutAt: at } : {}),
    ...(clean ? { savedAt: at, savedWrites: state.writes.length, saveState: 'saved' as const, saveGaps: [], saveWaits: [], turnsSince: 0,
      trouble: state.trouble.filter(t => !(r.troubleIds ?? []).includes(t.id)) } : {}) };
}

/** Read-only display words; an older record never acquires a guessed closeout age. */
export function checkpointView(state: CheckpointState, now: number): { save: string; closeout: string } {
  const age = (at: number): string => {
    if (!Number.isFinite(at) || at > now) return 'unknown';
    const minutes = Math.floor((now - at) / 60000);
    return minutes >= 1440 ? `${Math.floor(minutes / 1440)} d` : minutes >= 60 ? `${Math.floor(minutes / 60)} h` : minutes >= 1 ? `${minutes} min` : '<1 min';
  };
  return {
    save: ['asked', 'gaps', 'waits'].includes(state.saveState) ? state.saveState : state.savedAt === null ? 'unsaved' : `saved ${age(state.savedAt)}`,
    closeout: state.closeout === 'done' && typeof state.closedOutAt === 'number' && Number.isFinite(state.closedOutAt)
      ? `done ${age(state.closedOutAt)}` : state.closeout,
  };
}

/** R9: last-save information is built from observed writes, never the assistant's claims. */
export function checkpointPrompt(request: CheckpointRequest, state?: CheckpointState, harness: '/' | '$' = '/'): string {
  const displayed = request.open.map(o => request.open.filter(p => p.kind === o.kind && p.name === o.name).length > 1 && o.where ? {...o,name:o.name+'@'+o.where} : o);
  const command = (text: string) => text.replaceAll('/closeout', harness + 'closeout').replaceAll('/save', harness + 'save');
  if (request.kind === 'save') return command(saveText(displayed, 'this seat', request.hub, request.trouble,
    request.since === null ? 'this session began' : 'the last save'));
  const since = state && state.savedAt !== null ? [
    `Last clean save: ${Math.max(0, Math.floor((request.at - state.savedAt) / 1000))}s ago.`,
    state.writes.length > state.savedWrites ? `Written since then: ${[...new Set(state.writes.slice(state.savedWrites).map(w => `${w.kind === 'hub' ? 'Hub' : 'Book'} ${w.name}`))].join(', ')}.` : 'Nothing has been written since then.',
    'An item saved then with nothing written since is "nothing new: saved at the last save"; "updated" needs a write since the save.',
  ].join(' ') : null;
  const writes = state?.writes.slice(state.savedWrites) ?? [];
  let text = fillText(displayed, request.hub, request.trouble, 0, since);
  if (request.decided === 'tidied' || request.decided === 'declined') text = text.replace('close what is done (`hub edit --mode close-item`) and ', '');
  return command(text) + '\n' + [
    ...writes.map(w => `Recorded write: ${w.kind} ${w.name}${w.where ? '@' + w.where : ''} ${w.page}.`),
    ...displayed.filter(o => !writes.some(w => w.kind === o.kind && w.name === o.name && (!o.where || w.where === o.where)))
      .map(o => `${o.kind} ${o.name}: nothing new: no write recorded`),
    ...(state?.ledgerGaps?.length ? ['The write list is incomplete:', ...state.ledgerGaps,
      ...new Set(state.trouble.flatMap(trouble => writers(trouble.text).map(hint => `Shell hint only: ${hint.kind} ${hint.name ?? 'unknown target'}.`)))] : []),
    ...(request.pendingReports ?? []).map(title => `Pending Report filed this conversation: ${title}`),
    'Use the closeout skill to finish this checkpoint.',
  ].join('\n');
}

export const FILL_MARKER = 'Closeout before /clear.';
export const SAVE_MARKER = 'Save point, continuing.';
/** Request words from the procedure letter; checking rules still follow the mod (C21 standing answer 8). */
export function reportsStep(trouble: readonly string[]): string[] {
  return [
    '1. **Reports first** (Eric: Reports from seats matter most). Look back over the whole session for anything that went wrong with Deskpost or the Library: a command that failed or refused when it should not have, a wrong or confusing message, a guard that fired wrongly, a missing verb or tool, a workaround you used, or wrong docs or Skill text. File each one not already filed: `library capture reports --title "<what broke>" --content-path <file>`, with the failing command and its output. File a suspected defect too, titled "Suspected: ...". Your own slips (a typo, a wrong flag you then fixed) are not Reports. List every Library command that ended in an error this session and say, for each, defect or your own mistake.',
    ...trouble.map(t => `- ${t}`),
  ];
}

/** Letter steps 1-5, with this request's open items, seat Hub and examples substituted. */
export function fillText(
  open: readonly OpenItem[],
  seatHub: string | null,
  trouble: readonly string[] = [],
  _upkeepItems = 0,
  lastSave: string | null = null,
): string {
  const lines = open.map(o => `- ${o.kind === 'book' ? 'Book' : 'Hub'} ${o.name}${o.where ? ` (${o.where})` : ''}`);
  const example = open.slice(0, 2).map(o => o.kind === 'hub' && o.name === seatHub
    ? `hub ${o.name}: updated _project (Now, Next)` : `${o.kind} ${o.name}: nothing new: read only`);
  return [
    FILL_MARKER,
    ...reportsStep(trouble),
    ...(lastSave === null ? [] : [lastSave]),
    '2. **Each open Book and Hub** (`library desk` names them): check that this session\'s work is saved where the next session will find it, and make any missing update. Give each one verdict:',
    ...lines,
    '   - `updated <page>`: only for a write the program recorded for this conversation. A preflight is not a write.',
    '   - `nothing new: <why>`.',
    '   - `needs update`: then make the update before you answer, and answer `updated`.',
    '   - `waits for Eric: <what needs his yes>`: for a gated edit you could not make. Never write "updated" with a note that it still waits.',
    '   - A Hub that belongs to another seat is never written: answer `nothing new` and say where the work went instead.',
    seatHub
      ? `3. **Your own Hub** (\`${seatHub}\`): close what is done (\`hub edit --mode close-item\`) and add pointers only to \`## Now\` and \`## Next\`, so a fresh session can resume from the Hub alone.`
      : '3. This seat\'s Hub is not open, so Now and Next cannot be updated. Say where the next session should resume from.',
    '4. **End with a fenced block**, one reports line, then one line per open Book and Hub:',
    '```closeout',
    'reports: none: <why>',
    ...example,
    '```',
    '5. **After the block**, only if something is stuck: a list headed `Needs you (<count>):`, one numbered line per item, saying what is stuck and exactly what Eric should answer ("yes", "no" or "retry"). Leave it out when nothing needs him.',
  ].join('\n');
}

export const NEEDS_YOU_RULE =
  'If any item waits for Eric\'s yes or could not be done, add a list after the block headed "Needs you (<count>):", one numbered line per item: what is stuck, and exactly what Eric should answer (for example "yes" or "no", or "retry"). Leave it out when nothing needs him.'

/**
 * An update that needs Eric's yes (a gated edit) cannot be made before the
 * answer, so it gets its own verdict. Live, 2026-10-04: deskpost-desk answered
 * "updated ...; Now's entry waits for Eric's yes", and the row went green.
 */
export const WAITS_RULE =
  'An update you could not make because it needs Eric\'s yes (a gated edit) is answered "waits for Eric: <what needs his yes>", never "updated" with a note.'


export const REPORTS_EARLIER_RULE =
  'A Report you already filed earlier this session for one of these is not filed again: answer "none" and name it, like `reports: none: filed earlier, "<title>"`.'

/**
 * The save request, sent as the plugin (framed, never asUser). The brevity
 * rule comes first and last; the Reports step only when Library commands
 * failed (decision 1); the block is ```save in /closeout's format.
 */
export function saveText(
  open: readonly OpenItem[],
  seat: string | null,
  seatHub: string | null,
  trouble: readonly string[],
  since: string,
): string {
  const lines = open.map(o => `- ${o.kind === 'book' ? 'Book' : 'Hub'} ${o.name}${o.where ? ` (${o.where})` : ''}`)
  const example = [
    ...(trouble.length > 0 ? ['reports: filed "<title>"'] : []),
    ...open.slice(0, 2).map(o =>
      o.kind === 'hub' && o.name === seatHub ? `hub ${o.name}: updated _project (Now, Next)`
        : o.kind === 'hub' ? `hub ${o.name}: nothing new: read only` : `book ${o.name}: nothing new: no work for this Book since ${since}`,
    ),
  ]
  return [
    `Eric ran /save. ${SAVE_MARKER}`,
    // Live, 2026-10-04: a seat fresh from a long job answered in one status line with no block.
    'This is a checked save, not a status question: go through each item below, make any write it needs, then answer with the ```save block. The block is required, even when every item is "nothing new". Keep it short; this is not a wrap-up.',
    ...(trouble.length > 0
      ? [
          'Reports: these Library commands ended in an error this session. For each, decide: a defect (file it to the Report Inbox now, with the failing command and its output: `library capture reports --title "<what broke>" --content-path <file>`), or your own mistake?',
          ...trouble.map(t => `- ${t}`),
          REPORTS_EARLIER_RULE,
        ]
      : []),
    ...(open.length > 0
      ? [
          `For each open Book and Hub below: is the work since ${since} saved where the next session will find it? If not, make that update now.`,
          ...lines,
          'For each, answer "updated" (name the page), "nothing new" (say why), or "needs update". A Hub that belongs to another seat is never written: answer "nothing new" and say where the work went instead.',
          WAITS_RULE,
        ]
      : []),
    ...(seatHub
      ? [`In this seat's Hub (${seatHub}), close what is done (hub edit --mode close-item) and add pointers only to Now and Next, so a fresh session could resume from it alone. If nothing changed since ${since}, skip it and answer "nothing new" with that reason.`]
      : seat
        ? [`This seat's Hub (${seat}) is not open, so Now and Next cannot be saved.`]
        : []),
    `End with a fenced block: ${trouble.length > 0 ? 'one reports line ("filed" with each title, or "none" with why), then ' : ''}one line per item, like:`,
    '```save',
    ...example,
    '```',
    NEEDS_YOU_RULE,
    'An answer without this block is a failed save. Stop after the block and its "Needs you" list, if any: no summary. Carry on with the same work on the next prompt.',
  ].join('\n')
}



// Writer evidence: decode receipts, then match them against independently parsed writer commands.
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

/** All complete top-level documents; braces in JSON strings never terminate a document. */
export function checkpointResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(checkpointResults);
  const record = object(value);
  if (record) {
    for (const key of ['stdout', 'output', 'text', 'content']) if (record[key] !== undefined) return checkpointResults(record[key]);
    return [record];
  }
  if (typeof value !== 'string') return [];
  try { return checkpointResults(JSON.parse(value)); } catch { /* shell framing surrounds the documents */ }
  const results: unknown[] = [];
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== '{' && value[start] !== '[') continue;
    if(value[start]==='{' && !/^[\s]*["}]/.test(value.slice(start+1))) continue;
    let quoted = false, escaped = false, end = start;
    const stack: string[] = [];
    let malformed = false;
    for (; end < value.length; end++) {
      const ch = value[end];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== (ch === '}' ? '{' : '[')) { malformed = true; break; }
        if (!stack.length) { end++; break; }
      }
    }
    if (stack.length || malformed || quoted) continue;
    try {
      results.push(...checkpointResults(JSON.parse(value.slice(start, end))));
      start = end - 1;
    } catch { /* Keep scanning after a malformed candidate, including nested starts. */ }
  }
  return results;
}

type Writer = { kind: 'hub' | 'book' | 'capture' | 'letters' | 'triage'; name?: string; page?: string; where?: string };
/** `$name`, `${name}`, `$name.Member` (a loop's `$p.BaseName`), `$(...)` and `%name%` (kickoffs/s180 row 2(h)). */
function variable(value: string | undefined): boolean { return !!value && /^(?:\$(?:\{?[\w:]+\}?(?:\.\w+)*|\(.*\))|%\w+%)$/s.test(value); }
function literal(value: string | undefined): string | undefined { return value && !variable(value) ? value : undefined; }

/** Quoted command text and heredoc bodies are data, never another command. */
function shellStatements(command: string): string[][] {
  const lines = command.split('\n'), safe: string[] = [];
  for (let i=0; i<lines.length; i++) {
    const line = lines[i]!;
    const hereString = /@["']\s*\r?$/.test(line);
    safe.push(hereString ? line.replace(/@["']\s*\r?$/, '') : line);
    const delimiters = [...line.matchAll(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_]\w*)\2/g)];
    for (const d of delimiters) while (++i < lines.length) {
      const body = lines[i]!.replace(/\r$/, ''); if ((d[1] ? body.replace(/^\t+/, '') : body) === d[3]) break;
    }
    if (hereString) {
      while (++i < lines.length && !/^["']@/.test(lines[i]!)) { /* PowerShell here-string */ }
      if (i < lines.length) safe.push(lines[i]!.slice(2));
    }
  }
  const text = safe.join('\n'), statements: string[][] = []; let tokens: string[] = [], token='', quote='', escaped=false;
  // Open `${`, `$(`, `@{`, `@(` still in the word, so their closes stay in it too (kickoffs/s180 row 2(h)).
  const held: string[] = [];
  const word = () => { if (token) { tokens.push(token); token=''; } };
  const statement = () => { word(); if(tokens.length) statements.push(tokens); tokens=[]; };
  for (let i=0; i<text.length; i++) {
    const ch=text[i]!;
    if (escaped) { token+=ch; escaped=false; continue; }
    if (quote) { if(ch===quote) quote=''; else if(ch==='`' && quote==='"') escaped=true; else token+=ch; continue; }
    if(ch==='"'||ch==="'") { quote=ch; continue; }
    if((ch==='{'||ch==='(') && (held.length || /[$@]$/.test(token))) { held.push(ch); token+=ch; continue; }
    if(held.length) { if(ch===(held[held.length-1]==='{'?'}':')')) held.pop(); else if(ch==='}'||ch===')') held.length=0; token+=ch; continue; }
    // A block's braces and parentheses end a statement, so `foreach (...) { deskpost ... }` keeps its writer.
    if(ch==='{'||ch==='}'||ch==='('||ch===')') { statement(); continue; }
    if(ch===';'||ch==='\n'||ch==='|'||(ch==='&' && text[i+1]==='&')) { statement(); if(text[i+1]===ch) i++; continue; }
    if(/\s/.test(ch)) word(); else token+=ch;
  }
  statement(); return statements;
}
function libraryStatements(command: string): string[][] {
  return shellStatements(command).flatMap(words => {
    while(words[0]==='&' || /^(?:do|then|else|elif)$/.test(words[0] ?? '') || /^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift();
    const exe=words.shift() ?? '';
    if(!/(?:^|[\\/])(?:deskpost|library)(?:\.exe|\.cmd)?$/i.test(exe)) return [];
    if(words[0]==='--workspace') words.splice(0,2);
    if(words.includes('--preflight')) return [];
    return [words];
  });
}
function writers(command: string): Writer[] {
  return libraryStatements(command).flatMap<Writer>(words => {
    const option=(name:string) => literal(words[words.indexOf(name)+1]);
    const opt=(name:string) => words.includes(name) ? option(name) : undefined;
    const [verb,action,name,page]=words;
    if(verb==='hub'&&action==='edit') return [{kind:'hub',name:literal(name)?.replace(/^projects\//,''),page:words.includes('--page') ? opt('--page') : '_project'}];
    if(verb==='book' && ['add-page','replace-page','graduate'].includes(action ?? ''))
      return [{kind:'book',name:literal(name),page:literal(page)?.startsWith('--') ? undefined : literal(page),where:'shelf'}];
    if(verb==='collection' && ['add-page','replace-page'].includes(action ?? ''))
      return [{kind:'book',name:literal(name),page:literal(page)?.startsWith('--') ? undefined : literal(page),where:'collection'}];
    if(verb==='shared' && ['add-page','replace-page'].includes(action ?? ''))
      return [{kind:'book',name:literal(name),page:literal(page)?.startsWith('--') ? undefined : literal(page),where:'shared'}];
    if(verb==='capture') return [{kind:'capture',name:literal(action),where:'shelf'}];
    if(verb==='letters'&&action==='close') return [{kind:'letters',name:'letters',page:literal(name),where:'shelf'}];
    if(verb==='reports'&&action==='amend') return [{kind:'book',name:'reports',page:literal(name),where:'shelf'}];
    if(verb==='triage'&&action==='batch') return [{kind:'triage'}];
    return [];
  });
}

function canonicalWrite(value: unknown, at: number): CheckpointWrite | null {
  if(typeof value!=='string') return null;
  const p=value.replace(/\\/g,'/');
  if(/[\x00-\x1f\x7f]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(s=>!s || s==='.' || s==='..')) return null;
  const hub=/^(?:collection\/)?(?:archive\/)?projects\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(p);
  if(hub) return {kind:'hub',name:hub[1]!,page:hub[2]!.replace(/\.md$/,''),at};
  const notebook = /^notebook\/(.+)$/.exec(p);
  if (notebook) return { kind: 'notebook', name: 'notebook', page: notebook[1]!.replace(/\.md$/, ''), at };
  const book=/^(shelf(?:\/_archive)?|collection\/(?:books|archive)|books|archive|shared(?:\/archive)?)\/([a-z0-9][a-z0-9-]*)\/wiki\/(.+)$/.exec(p);
  if(!book) return null;
  return {kind:'book',name:book[2]!,page:book[3]!.replace(/\.md$/,''),where:book[1]!.startsWith('shelf')?'shelf':book[1]!.startsWith('collection/')?'collection':'shared',at};
}

/** Receipt decoder alone is useful for fixtures; observation also requires a matching command. */
export function checkpointWrites(value: unknown, at: number): CheckpointWrite[] {
  const r=object(value);
  if(!r || r.written===false || r.preflight===true || r.error || r.refusal) return [];
  if((r.written!==undefined && typeof r.written!=='boolean') || (r.status!==undefined && typeof r.status!=='string')) return [];
  const status=String(r.status ?? '');
  if(['planned','preview','refused','failed','error','unchanged'].includes(status)) return [];
  const shared=r.verdict==='written' && r.shared_library_write===true && typeof r.book==='string' && /^shared\/[a-z0-9][a-z0-9-]*$/.test(r.book);
  if(typeof r.book==='string' && r.book.startsWith('shared/') && !shared) return [];
  if(r.written!==true && !['added','written','captured','closed','amended'].includes(status) && !shared) return [];
  const paths=[r.page_path,r.page,r.note_page];
  if(status==='closed' && typeof r.book==='string' && typeof r.letter==='string') paths.push(r.book+'/wiki/'+r.letter);
  if(status==='amended' && typeof r.book==='string' && typeof r.report==='string') paths.push(r.book+'/wiki/'+r.report);
  if(Array.isArray(r.pages)) for(const entry of r.pages) { const page=object(entry); if(page) paths.push(page.page ?? page.page_path); }
  const out: CheckpointWrite[]=[];
  for(const p of paths) {
    const w=canonicalWrite(p,at);
    if(shared && (w?.where!=='shared' || r.book!=='shared/'+w.name)) continue;
    if(w && !out.some(x=>itemKey(x.kind,x.name,x.where)===itemKey(w.kind,w.name,w.where)&&x.page===w.page)) out.push(w);
  }
  if(status==='captured' && out.some(w=>w.kind==='book'&&w.name==='reports')) {
    const report=out.find(w=>w.kind==='book'&&w.name==='reports')!;
    out.push({...report,kind:'report',...(typeof r.note_title==='string'?{title:r.note_title}:{})});
  }
  return out;
}

/** Triage's own successful, non-skipped outcomes; no journal or preflight is consulted. */
function triageWrites(value: unknown, at: number): CheckpointWrite[] {
  const r=object(value);
  if(!r || r.written===false || r.preflight===true || r.error || r.refusal || (r.written!==undefined && typeof r.written!=='boolean') || r.operation!=='Library Triage' || r.status!=='complete' || !Array.isArray(r.outcomes)) return [];
  return r.outcomes.flatMap(value => {
    const outcome=object(value);
    if(!outcome || outcome.state!=='succeeded' || outcome.skipped!==false || outcome.error) return [];
    const result=object(outcome.result);
    if(!result) return [];
    const status=String(result.status ?? '');
    const writes=checkpointWrites(['updated','stamped','copied','discarded'].includes(status)?{...result,written:true}:result,at);
    return [...writes,...checkpointWrites(result.note_close,at)];
  });
}

export type CheckpointToolResult = {
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_use_id?: string;
  tool?: string; input?: unknown; result?: unknown; call_id?: string;
  command?: string; cmd?: string; output?: unknown; exit_code?: number; exitCode?: number;
  session_id?: string; conversation?: string; turn_id?: string; hook_event_name?: string; error?: unknown;
};

/** Decode literal commands from Codex exec scripts without running JavaScript. */
function codexExecCommands(value: unknown): string {
  if (typeof value !== 'string') return '';
  const commands: string[] = [];
  for (const match of value.matchAll(/\bexec_command\s*\(\s*\{\s*cmd\s*:\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)(?=\s*[,}])/g)) {
    const quoted = match[1]!;
    if (quoted.startsWith('`') && /(?<!\\)\$\{/.test(quoted)) continue;
    try {
      commands.push(quoted.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r?\n)|([\s\S]))/gi,
        (_escape, point: string, unicode: string, hex: string, newline: string, simple: string) => point || unicode || hex
          ? String.fromCodePoint(parseInt(point || unicode || hex, 16)) : newline ? ''
          : ({ '0': '\0', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[simple] ?? simple));
    } catch { /* A malformed literal cannot establish a writer. */ }
  }
  return commands.join('\n');
}

export function observeCheckpointResult(state: CheckpointState, event: CheckpointToolResult, at: number, ledgerOnly = false): CheckpointState {
  for(const id of [event.tool_use_id,event.call_id,event.turn_id]) if(id!==undefined && typeof id!=='string') throw Error('Tool call and turn identities must be strings.');
  const conversation=event.conversation ?? event.session_id;
  if(conversation!==undefined && conversation!==state.conversation) throw Error('Tool result belongs to another conversation.');
  const rawInput=event.tool_input ?? event.input, input=object(rawInput) ?? {};
  const command=String(input.command ?? input.cmd ?? event.command ?? event.cmd ?? codexExecCommands(typeof rawInput==='string' ? rawInput : input.code ?? input.input));
  const response=event.tool_response ?? event.result ?? event.output;
  const r=object(response);
  const output=r?.stdout ?? r?.output ?? r?.content ?? response ?? event.error;
  const rendered=typeof output==='string'?output:JSON.stringify(output ?? '');
  const framedExit=/Process exited with code (\d+)|Exit code:\s*(\d+)/i.exec(rendered);
  const exit=event.exit_code ?? event.exitCode ?? r?.exit_code ?? r?.exitCode ?? (framedExit ? Number(framedExit[1] ?? framedExit[2]) : undefined);
  const failedChunk = (value: unknown): boolean => {
    if (typeof value==='string') { try { return failedChunk(JSON.parse(value)); } catch { return false; } }
    if (Array.isArray(value)) return value.some(failedChunk);
    const chunk=object(value);
    return !!chunk && (typeof chunk.exit_code==='number' && chunk.exit_code!==0 || ['stdout','output','text','content'].some(key => failedChunk(chunk[key])));
  };
  const failed=exit!==undefined && exit!==0 || failedChunk(response) || event.hook_event_name==='PostToolUseFailure' || !!r?.error || r?.isError===true;
  const pending=exit===undefined && (r?.session_id!==undefined || r?.sessionId!==undefined || /(?:Process|Script) running with (?:session|cell) ID/i.test(rendered));
  if(pending) return {...state,tracking:true}; // The terminal result may reuse this call id; do not consume it yet.
  const id=event.tool_use_id ?? event.call_id ?? '';
  // Hash fallback is deterministic: c22 should pass a real tool-call id whenever the harness exposes one.
  const key=id || evidenceHash(JSON.stringify(event));
  if(state.seen.includes(key)) return state;
  const intents=ledgerOnly ? [] : writers(command);
  const writes: CheckpointWrite[]=[];
  if(!failed && !pending) for(const document of checkpointResults(output)) {
    for(const w of [...checkpointWrites(document,at),...(intents.some(i=>i.kind==='triage')?triageWrites(document,at):[])]) {
      if(intents.some(intent => {
        const kind=w.kind==='report'?'book':w.kind;
        if(intent.kind==='triage') return triageWrites(document,at).some(t=>itemKey(t.kind,t.name,t.where)===itemKey(w.kind,w.name,w.where)&&t.page===w.page);
        if(intent.kind==='hub' && kind!=='hub' || intent.kind!=='hub' && kind!=='book') return false;
        if(intent.name && intent.name!==w.name || intent.where && intent.where!==w.where) return false;
        if(intent.page && intent.page.replace(/\.md$/,'')!==w.page) return false;
        if(w.kind==='report' && intent.kind!=='capture') return false;
        return true;
      })) writes.push(w);
    }
  }
  const turnKey=event.turn_id ? 'turn:'+event.turn_id : null;
  const newTurn=turnKey!==null && !state.seen.includes(turnKey);
  const next=observeCheckpoint({...state,turnsSince:state.turnsSince+(newTurn?1:0),seen:newTurn?[...state.seen,turnKey!]:state.seen},writes,key);
  if(failed && libraryStatements(command).length) return {...next,trouble:[...next.trouble,{id:key,text:command+' -> '+rendered.slice(0,300),at}]};
  return next;
}

function evidenceHash(text: string): string {
  // Imported once by the kernel core; no dependency on either harness.
  return createHash('sha256').update(text).digest('hex');
}

/** The audit is deliberately independent of shell syntax: the process already has its arguments. */
export const LEDGER_WRITERS: Record<string, readonly string[]> = {
  // graduate has no apply half at this base; sources is read-only without its mutation flag.
  book: ['add-page', 'replace-page', 'sources', 'reader-map'],
  collection: ['add-page', 'replace-page'], capture: [''], compile: [''],
  hub: ['edit', 'new', 'copy-pages', 'rename', 'tidy', 'archive'], kickoff: ['receive'],
  letters: ['close'], reports: ['amend', 'withdraw', 'send-pending'], postbox: ['check'], notebook: ['render'],
  publish: ['', 'batch', 'refresh'], reset: ['', 'restore'],
  shared: ['add-page', 'replace-page', 'remove-page', 'new-book', 'promote', 'catalog-line', 'archive', 'restore', 'sources'],
  shelf: ['new', 'rename', 'remove', 'stub', 'tidy', 'carry', 'recall', 'archive', 'restore', 'describe'],
  triage: ['batch'], undo: [''], redo: [''], 'basic-memory': ['import'],
};
export type LedgerRecord = {
  schema: 1; entry: string; state: 'started' | 'committed' | 'unchanged' | 'rolled-back' | 'failed'; at: number;
  verb: string; action: string; mode: string | null; seat: string | null;
  claude_session: string | null; codex_thread: string | null;
  targets?: CheckpointWrite[] | null; unattributed?: boolean;
  target?: string; settledJournal?: string;
};
type JournalSnapshot = { path: string; ctimeMs: number; mtimeMs: number; hash: string }[];
export type LedgerRun = { workspace: string; record: LedgerRecord; receipts: unknown[]; journalEvidence?: { paths: string[]; snapshot: JournalSnapshot | null } };
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function safeLedgerPath(workspace: string, components: string[]): string {
  let current = workspace;
  for (const component of components) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Ledger paths cannot contain symbolic links or junctions.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
function ledgerPath(workspace: string, conversation: string): string {
  if (!LEDGER_ID.test(conversation)) throw Error('Invalid ledger conversation identity.');
  return safeLedgerPath(workspace, ['internal', 'checkpoints', 'ledger', conversation + '.jsonl']);
}
function ledgerFailure(workspace: string, conversation: string): string {
  return safeLedgerPath(workspace, ['internal', 'checkpoints', 'ledger-unreadable-' + conversation]);
}
function appendLedger(run: LedgerRun, record: LedgerRecord): void {
  for (const id of new Set([record.claude_session, record.codex_thread])) {
    if (!id) continue;
    try {
      const file = ledgerPath(run.workspace, id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // This side channel survives a ledger directory that is unwritable. Never change a command's result.
      try { fs.writeFileSync(ledgerFailure(run.workspace, id), 'unreadable\n', { flag: 'wx' }); } catch { /* The reader also probes accessibility. */ }
    }
  }
}

/** A failed probe or a link means unknown evidence, never an empty snapshot. */
function ledgerJournalSnapshot(paths: string[]): JournalSnapshot | null {
  try {
    const rows: JournalSnapshot = [];
    const safe = (file: string) => { const root = path.parse(file).root; return safeLedgerPath(root, file.slice(root.length).split(path.sep)); };
    for (const file of paths) {
      const full = safe(file);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const files = stat.isDirectory() ? fs.readdirSync(full).filter(name => name.endsWith('.json')).map(name => safe(path.join(full, name))) : [full];
      for (const journal of files) {
        const stat = fs.statSync(journal);
        rows.push({ path: journal, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, hash: createHash('sha256').update(fs.readFileSync(journal)).digest('hex') });
      }
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path));
  } catch { return null; }
}

/** Failure is advisory only, including resolution failures before the verb has selected a Library. */
export function startWriteLedger(argv: string[]): LedgerRun | null {
  try {
    const claude_session = process.env['CLAUDE_CODE_SESSION_ID'] || null, codex_thread = process.env['CODEX_THREAD_ID'] || null;
    if (!claude_session && !codex_thread) return null;
    if ([claude_session, codex_thread].some(id => id !== null && !LEDGER_ID.test(id))) return null;
    let args = argv;
    if (args[0] === '--workspace') args = [...args.slice(2), '--workspace', args[1]!];
    const verb = args[0] ?? '', actions = LEDGER_WRITERS[verb];
    if (!actions) return null;
    const action = actions.includes(args[1] ?? '') ? args[1] ?? '' : '';
    if (!actions.includes(action)) return null;
    const parsed = parseArguments(commandAction(verb, args.slice(1)).argv, argumentTable(verb, action));
    if (['preflight', 'dry-run', 'help', 'list'].some(name => parsed.flags.has(name)) || parsed.positional.some(word => ['-h', '-?', '/?'].includes(word))) return null;
    if (verb === 'book' && action === 'sources' && !parsed.flags.has('set') && !parsed.flags.has('mark-compiled')) return null;
    const option = (name: string) => parsed.options.get(name);
    const workspace = requireWorkspace({ explicit: option('workspace') });
    const record: LedgerRecord = { schema: 1, entry: randomUUID(), state: 'started', at: Date.now(), verb, action,
      mode: option('mode') ?? null, seat: writingSeat(workspace, option('seat'))?.name ?? null, claude_session, codex_thread,
      ...(['book', 'hub'].includes(verb) && parsed.positional[0] ? { target: parsed.positional[0] } : {}) };
    const paths = verb === 'book' ? [path.join(workspace, 'internal', 'shelf-journals')]
      : verb === 'hub' && action === 'edit' ? [path.join(workspace, 'internal', 'publication-journals')]
      : verb === 'publish' && action === 'refresh' && readMarker(workspace)?.['backend'] === 'local'
        ? [path.join(workspace, 'internal', 'publication-journals'), ...(option('journal-path') ? [path.resolve(option('journal-path')!)] : [])] : null;
    const run: LedgerRun = { workspace, record, receipts: [], ...(paths ? { journalEvidence: { paths, snapshot: ledgerJournalSnapshot(paths) } } : {}) };
    appendLedger(run, record);
    return run;
  } catch { return null; }
}

/** Decodes the verb's emitted receipt, including compound receipts and undo/redo paths. */
export function ledgerReceipt(value: unknown, at: number): { written: boolean; targets: CheckpointWrite[] } {
  const r = object(value);
  if (!r || r.written === false || r.preflight === true || r.error || r.refusal ||
    ['planned', 'preview', 'refused', 'failed', 'error', 'unchanged'].includes(String(r.status))) return { written: false, targets: [] };
  if (r.operation === 'Library Triage' && Array.isArray(r.outcomes)) {
    const receipts = r.outcomes.flatMap(value => {
      const outcome = object(value), result = object(outcome?.result);
      if (!result || outcome?.state !== 'succeeded' || outcome.skipped !== false || outcome.error) return [];
      const receipt = ledgerReceipt(['updated', 'stamped', 'copied', 'discarded'].includes(String(result.status)) ? { ...result, written: true } : result, at);
      return [receipt, ledgerReceipt(result.note_close, at)];
    });
    return { written: receipts.some(receipt => receipt.written), targets: receipts.flatMap(receipt => receipt.targets) };
  }
  const triage = triageWrites(r, at);
  const written = r.written === true || r.renamed === true || r.archive_complete === true || r.restored === true || r.created === true && Array.isArray(r.written) && r.written.length > 0 || r.verdict === 'written' || r.imported === true && Number(r.files_written) > 0 ||
    r.operation === 'Render the Notebook master index' && typeof r.master_index_path === 'string' ||
    r.publication_complete === true || Array.isArray(r.created_records) && r.created_records.length > 0 || Array.isArray(r.filed) && r.filed.length > 0 ||
    ['added', 'written', 'captured', 'closed', 'amended', 'undone', 'redone', 'withdrawn', 'sent', 'rendered', 'complete', 'completed', 'published', 'refreshed', 'restored', 'archived', 'removed', 'deleted', 'renamed', 'created', 'carried', 'recalled', 'described', 'stubbed', 'tidied', 'sent-pending', 'received'].includes(String(r.status));
  const targets = [...checkpointWrites(r, at), ...triage];
  for (const candidate of [...(Array.isArray(r.paths) ? r.paths : []), ...(Array.isArray(r.written) ? r.written : []), r.note, r.capture_note, r.path, r.page_file, r.kickoff, r.reader_map, r.article_path, r.topic_index_path, r.master_index_path,
    ...(r.status === 'withdrawn' && typeof r.book === 'string' && typeof r.report === 'string' ? [r.book + '/wiki/' + r.report] : [])]) {
    const p = object(candidate);
    const target = canonicalWrite(p ? p.path ?? p.page_path ?? p.page : candidate, at);
    if (target) targets.push(target);
  }
  return { written: written || targets.length > 0, targets: targets.filter((w, index) =>
    targets.findIndex(other => itemKey(other.kind, other.name, other.where) === itemKey(w.kind, w.name, w.where) && other.page === w.page) === index) };
}

export function finishWriteLedger(run: LedgerRun | null, exit: number, beforeDispatch = false): void {
  if (!run) return;
  try {
    const at = Date.now(), receipts = run.receipts.map(value => ledgerReceipt(value, at));
    const written = receipts.some(r => r.written), targets = receipts.flatMap(r => r.targets);
    const evidence = run.journalEvidence, after = evidence ? ledgerJournalSnapshot(evidence.paths) : null;
    const state = written ? 'committed' : exit === 0 || beforeDispatch ? 'unchanged' : evidence
      ? evidence.snapshot !== null && after !== null && JSON.stringify(evidence.snapshot) === JSON.stringify(after) ? 'unchanged' : 'started' : 'started';
    if (state === 'committed' && evidence?.snapshot && after) {
      const beforeHashes = new Map(evidence.snapshot.map(journal => [journal.path, journal.hash]));
      for (const journal of after) {
        if (beforeHashes.get(journal.path) !== journal.hash) claimLedgerJournal(run.workspace, journal.path, run.record.entry);
      }
    }
    appendLedger(run, { ...run.record, state, at: state === 'started' ? run.record.at : at, ...(written ? { targets: targets.length ? targets : null,
      ...(targets.length ? {} : { unattributed: true }) } : {}) });
  } catch { /* Ledger failures never become command failures. */ }
}

/** An exclusive claim also covers interrupted entries in other conversations. */
function claimLedgerJournal(workspace: string, journal: string, entry: string): boolean {
  try {
    const root = safeLedgerPath(workspace, ['internal', 'checkpoints', 'ledger']);
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.jsonl'))) {
      const file = safeLedgerPath(workspace, ['internal', 'checkpoints', 'ledger', name]);
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as LedgerRecord;
        if (record.settledJournal === journal && record.entry !== entry) return false;
      }
    }
    const relative = path.relative(workspace, journal).split(path.sep).join('/');
    const file = safeLedgerPath(workspace, ['internal', 'checkpoints', 'journal-claims', evidenceHash(relative)]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, entry, { flag: 'wx' }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return fs.readFileSync(file, 'utf8') === entry; }
  } catch { return false; }
}

/** A journal is only completion evidence after its verified undo block was recorded. */
function completedLedgerJournal(workspace: string, record: LedgerRecord, until: number, used: Set<string>): { targets: CheckpointWrite[]; journal: string } | null {
  for (const directory of ['publication-journals', 'shelf-journals', 'triage-journals']) {
    const root = path.join(workspace, 'internal', directory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
      const file = path.join(root, name), stat = fs.statSync(file);
      if (used.has(file)) continue;
      if (stat.birthtimeMs < record.at || Math.floor(stat.mtimeMs) > until) continue;
      const journal = object(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))), undo = object(journal?.undo);
      if (!undo || undo.written_by_seat !== record.seat || !Array.isArray(undo.paths) || !undo.paths.length) continue;
      // Only an explicit command identity can settle an interrupted writer. Unknown journal forms stay uncertain.
      const identity = String(journal?.operation ?? '');
      const named = identity === `${record.verb}-${record.action}` || record.verb === 'book' && (
        record.action === 'add-page' && /^Add page .+/.test(identity) || record.action === 'replace-page' && /^Replace page .+/.test(identity)) ||
        record.verb === 'hub' && record.action === 'edit' && identity === 'project-edit';
      if (!named || record.mode && journal?.mode !== record.mode) continue;
      if (record.target && journal?.book_root !== `shelf/${record.target}` && journal?.book_root !== `collection/books/${record.target}` && journal?.project_slug !== record.target) continue;
      const targets: CheckpointWrite[] = [];
      let verified = true;
      for (const item of undo.paths) {
        const entry = object(item), relative = entry?.path;
        if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) { verified = false; break; }
        const full = path.join(workspace, relative);
        const hash = fs.existsSync(full) ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null;
        if (hash !== entry!.after_sha256) { verified = false; break; }
        const target = canonicalWrite(relative, stat.mtimeMs);
        if (target) targets.push(target);
      }
      if (verified && claimLedgerJournal(workspace, file, record.entry)) { used.add(file); return { targets, journal: file }; }
    }
  }
  return null;
}

export function readWriteLedger(workspace: string, conversation: string): {
  ledger: 'readable' | 'unreadable'; entries: (LedgerRecord | (Omit<LedgerRecord, 'state'> & { state: 'uncertain' }))[];
} {
  try {
    const file = ledgerPath(workspace, conversation);
    if (fs.existsSync(ledgerFailure(workspace, conversation))) throw Error('A ledger write failed.');
    let probe = file;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    fs.accessSync(probe, fs.constants.R_OK | fs.constants.W_OK);
    const latest = new Map<string, LedgerRecord>();
    if (!fs.existsSync(file)) {
      // A non-directory ledger is a damaged store, not an empty conversation.
      const root = path.dirname(file);
      if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw Error('Unreadable ledger folder.');
      return { ledger: 'readable', entries: [] };
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as LedgerRecord;
      if (record.schema !== 1 || typeof record.entry !== 'string' || !Number.isFinite(record.at) ||
        !['started', 'committed', 'unchanged', 'rolled-back', 'failed'].includes(record.state) ||
        ![record.claude_session, record.codex_thread].includes(conversation)) throw Error('Damaged ledger record.');
      if (typeof record.verb !== 'string' || typeof record.action !== 'string' ||
        record.targets != null && (!Array.isArray(record.targets) || !record.targets.every(target => target &&
          ['hub', 'book', 'report', 'notebook'].includes(target.kind) && typeof target.name === 'string' && typeof target.page === 'string' && Number.isFinite(target.at)))) throw Error('Damaged ledger targets.');
      latest.set(record.entry, record);
    }
    const used = new Set([...latest.values()].flatMap(record => record.settledJournal ? [record.settledJournal] : []));
    const entries = [...latest.values()].map(record => {
      if (record.state !== 'started') return record;
      const completedJournal = completedLedgerJournal(workspace, record, Date.now(), used);
      if (completedJournal !== null) {
        const { targets, journal: settledJournal } = completedJournal;
        const completed: LedgerRecord = { ...record, state: 'committed', targets: targets.length ? targets : null,
          settledJournal,
          ...(targets.length ? {} : { unattributed: true }) };
        appendLedger({ workspace, record, receipts: [] }, completed);
        return completed;
      }
      return { ...record, state: 'uncertain' as const };
    });
    return { ledger: 'readable', entries };
  } catch { return { ledger: 'unreadable', entries: [] }; }
}

/** Import each committed entry once. Unsettled evidence cannot justify a claim of no new work. */
export function checkpointLedger(state: CheckpointState, workspace: string): CheckpointState {
  const read = readWriteLedger(workspace, state.conversation), seen = new Set(state.ledgerSeen ?? []);
  const added = read.entries.filter(entry => entry.state === 'committed' && !seen.has(entry.entry));
  const writes = added.flatMap(entry => entry.targets ?? []);
  const gaps = read.ledger === 'unreadable' ? ['ledger: unreadable for this conversation.'] : read.entries
    .filter(entry => entry.state === 'uncertain' || entry.at >= (state.savedAt ?? 0) && (entry.unattributed || entry.state === 'committed' && !entry.targets?.length))
    .map(entry => `ledger entry ${entry.entry}: ${entry.state === 'uncertain' ? 'uncertain' : 'unattributed target'} (${entry.verb} ${entry.action}).`);
  return { ...state, tracking: state.tracking || read.entries.length > 0, writes: [...state.writes, ...writes], ledgerSeen: [...seen, ...added.map(entry => entry.entry)], ledgerGaps: gaps,
    closeout: writes.length && ['done', 'gaps', 'waits'].includes(state.closeout) ? 'stale' : state.closeout };
}
