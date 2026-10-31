/**
 * `deskpost asks`: how often the reader was asked, counted from this Library's Claude Code transcripts (kickoffs/s166
 * row 3; PLAN-fewer-yeses.md Approach 6 and Goal criterion 1, the plan's one measure of success).
 *
 * WHAT IS READ. The main-thread transcripts of THIS Library's project folder only: `<transcriptRoot>/<folder>/*.jsonl`,
 * where `<folder>` is the workspace path with every character but a letter or digit turned into '-', as Claude Code
 * names it (`D:\2nd_b\40-Resources\Deskpost` is `D--2nd-b-40-Resources-Deskpost`). A session's own sub-folder holds its
 * subagents' transcripts, which are not the reader's, and a record marked `isSidechain` is skipped for the same reason.
 * A file last written before the window is not opened; one over FILE_LIMIT bytes is refused rather than half read.
 *
 * WHAT IS COUNTED, in the window (`--since` and `--until`, local dates, both whole days; the last 7 days by default):
 *   - the reader's typed messages: a `user` record with `origin.kind` "human", or, in a record older than that field,
 *     plain text that is neither a meta record nor a tool result nor a harness tag such as `<command-name>`;
 *   - typed approvals among them, by the evidence page's rule (projects/deskpost-desk/notes/2026-10-25-fewer-yeses-
 *     transcript-evidence): 80 characters or less, starting with a yes-like word or a lone option letter; each takes the
 *     first of seven kinds whose keywords occur in the last 600 characters of the assistant's text before it;
 *   - auto-mode refusals: a tool result marked `is_error` whose text starts AUTO_MODE_REFUSAL;
 *   - Deskpost's own refusals: a tool result marked `is_error` whose text starts one of DESKPOST_REFUSALS;
 *   - permission prompts the reader answered: a record whose `permissionDecision.source` starts "user".
 *
 * THE DRIFT RULE (the plan's Risks): this reader was written for the layout LAYOUT names. A line that is not a JSON
 * object, a record `type` not in RECORD_TYPES, or a reader message whose content is not text, an image or a tool result
 * refuses the whole count, naming the file and the line, rather than counting a shape it does not know.
 *
 * `--write` keeps the count as `internal/asks/measure-<ISO week>.json`, atomically; the Desk shows the newest such file
 * as one line and never runs the count (`asksDeskLine`). Codex session logs are not read: their layout is not known.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { transcriptRoot } from './conversation.ts';

export const LAYOUT = 'Claude Code 2.1 transcripts (2.1.284 to 2.1.312, read 2026-10-28)';

/** Every record `type` the layout above was seen to write. A new one is drift. */
export const RECORD_TYPES: ReadonlySet<string> = new Set([
  'agent-name', 'ai-title', 'api-request', 'api-request-blob', 'api-request-shape', 'artifact-autoreact-ledger',
  'artifact-comment-monitor', 'assistant', 'atis-latch', 'attachment', 'continued-in', 'cost-state', 'custom-title',
  'dev-mods', 'file-history-delta', 'file-history-snapshot', 'frame-link', 'isolation-latch', 'last-prompt', 'mode',
  'permission-mode', 'queue-operation', 'summary', 'system', 'tools-used', 'user',
]);
const CONTENT_ITEMS: ReadonlySet<string> = new Set(['text', 'image', 'tool_result']);

export const AUTO_MODE_REFUSAL = 'Permission for this action was denied by the Claude Code auto mode classifier';
/** The validated reader's two refusals and a guard hook's (every PreToolUse hook here is Deskpost's). */
export const DESKPOST_REFUSALS: readonly { name: string; test: RegExp }[] = [
  { name: 'Book read rejected', test: /^Book read rejected:/ },
  { name: 'Project read rejected', test: /^Project read rejected:/ },
  { name: 'guard hook', test: /^PreToolUse:\w+ hook error:/ },
];

const APPROVAL = /^(?:(?:yes|yep|yeah|proceed|go(?: ahead)?|do it|ok(?:ay)?|sure|approved?)\b|[abc][.!]?$)/i;
const APPROVAL_LIMIT = 80;
const CONTEXT_CHARACTERS = 600;
const FILE_LIMIT = 256 * 1024 * 1024;

/**
 * The seven kinds, first match wins, in this order. Outside-world words come last but one (Decision of 2026-10-26,
 * kickoffs/s170-r2 row 1): a recommendation or a tidy that mentions a push is not a yes only the reader can give.
 */
export const KINDS: readonly { id: string; label: string; test: RegExp }[] = [
  { id: 'fingerprint', label: 'fingerprint gates', test: /\b(?:sha-?256|hash|fingerprint|plan[ _-]id)\b/i },
  { id: 'relay', label: 'relay between seats', test: /\b(?:paste|relay|letters?|ring)\b/i },
  { id: 'design', label: 'design questions with a recommendation', test: /\brecommend(?:ed|s)?\b/i },
  { id: 'next', label: "shall I start the next step", test: /\b(?:shall i|should i|want me to)\b[^?]{0,60}\b(?:start|begin|go on|continue|run|open)\b|\bnext (?:step|unit|row)\b/i },
  { id: 'record', label: 'record or tidy', test: /\b(?:hub|notes?|backlog|reports?|tidy|record|save|capture|close)\b/i },
  { id: 'outside', label: 'outside-world or irreversible', test: /\b(?:delete|push|publish|credentials?|install|uninstall|release|irreversible|force)\b/i },
  { id: 'other', label: 'other', test: /$/ },
];

export interface AsksOptions { since?: string; until?: string; now?: Date; configDirectory?: string }

export class AsksRefusal extends Error {}

/** Claude Code's project folder name for a workspace path. */
export function projectFolderName(workspace: string): string {
  return path.resolve(workspace).replace(/[^A-Za-z0-9]/g, '-');
}

function localDay(value: string, flag: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const day = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  if (!day || day.getMonth() !== Number(match![2]) - 1) throw new AsksRefusal(`${flag} takes a date as YYYY-MM-DD; got '${value}'.`);
  return day;
}

function dayText(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** The ISO week a date falls in, as `2026-W43`. */
export function isoWeek(day: Date): string {
  const date = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date.getTime() - first.getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '')).join(' ');
}

/** Last Kickoff named in assistant text or tool input, in content order, without the kind-context truncation. */
function lastKickoff(content: unknown): string | undefined {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((item) => {
    if (item?.type === 'text') return item.text;
    if (item?.type === 'tool_use') return JSON.stringify(item.input);
    return '';
  }) : [];
  let last: string | undefined;
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const match of part.matchAll(/\bkickoffs\/([a-z]+\d+[a-z]?(?:-r\d+)?)\b/g)) last = match[1];
  }
  return last;
}

export function countAsks(workspace: string, options: AsksOptions = {}): Record<string, PsJsonValue> {
  const now = options.now ?? new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = options.until ? localDay(options.until, '--until') : today;
  const since = options.since ? localDay(options.since, '--since') : new Date(until.getFullYear(), until.getMonth(), until.getDate() - 6);
  if (since > until) throw new AsksRefusal(`--since ${dayText(since)} is after --until ${dayText(until)}.`);
  const start = since.getTime();
  const end = new Date(until.getFullYear(), until.getMonth(), until.getDate() + 1).getTime();
  const folder = path.join(transcriptRoot(options.configDirectory), projectFolderName(workspace));
  if (!fs.existsSync(folder)) throw new AsksRefusal(`No Claude Code transcripts for this Library: ${folder} does not exist.`);

  const kinds: Record<string, number> = Object.fromEntries(KINDS.map((kind) => [kind.id, 0]));
  const refusals: Record<string, number> = Object.fromEntries(DESKPOST_REFUSALS.map((refusal) => [refusal.name, 0]));
  const byKickoff: Record<string, { messages: number; approvals: number }> = {};
  let messages = 0, approvals = 0, autoMode = 0, promptsAccepted = 0, promptsRejected = 0, filesRead = 0;
  const sessions = new Set<string>();
  const names = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
  for (const name of names) {
    const file = path.join(folder, name);
    const stat = fs.statSync(file);
    if (stat.mtimeMs < start) continue;
    if (stat.size > FILE_LIMIT) throw new AsksRefusal(`${file} is ${stat.size} bytes, over the ${FILE_LIMIT}-byte limit for one transcript; nothing was counted.`);
    filesRead += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let before = '';
    let kickoff = 'none';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const where = `${file}, line ${index + 1}`;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new AsksRefusal(`${where} is not JSON; this count was written for ${LAYOUT}, and nothing was counted.`);
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new AsksRefusal(`${where} is not a JSON object; this count was written for ${LAYOUT}, and nothing was counted.`);
      const type = record['type'];
      if (typeof type !== 'string' || !RECORD_TYPES.has(type)) {
        throw new AsksRefusal(`${where} has a record type this count does not know (${JSON.stringify(type ?? null)}, keys ${Object.keys(record).sort().join(',')}); it was written for ${LAYOUT}, and nothing was counted.`);
      }
      if (record['isSidechain'] === true) continue;
      const message = record['message'] as { content?: unknown } | undefined;
      const content = message?.content;
      if (type === 'user') {
        const shapeKnown = typeof content === 'string' || (Array.isArray(content) && content.every((item) => item && typeof item === 'object' && CONTENT_ITEMS.has(String((item as { type?: unknown }).type))));
        if (!shapeKnown) throw new AsksRefusal(`${where} is a user record whose content this count does not know (keys ${Object.keys(record).sort().join(',')}); it was written for ${LAYOUT}, and nothing was counted.`);
      }
      if (type === 'assistant') kickoff = lastKickoff(content) ?? kickoff;
      const time = Date.parse(String(record['timestamp'] ?? ''));
      if (Number.isNaN(time) || time < start || time >= end) {
        if (type === 'assistant') before = (before + ' ' + textOf(content)).slice(-CONTEXT_CHARACTERS);
        continue;
      }
      if (typeof record['sessionId'] === 'string') sessions.add(record['sessionId']);
      const decision = record['permissionDecision'] as { source?: unknown; decision?: unknown } | undefined;
      if (decision && typeof decision.source === 'string' && decision.source.startsWith('user')) {
        if (decision.decision === 'reject') promptsRejected += 1;
        else promptsAccepted += 1;
      }
      if (type === 'assistant') {
        before = (before + ' ' + textOf(content)).slice(-CONTEXT_CHARACTERS);
        continue;
      }
      if (type !== 'user') continue;
      if (Array.isArray(content) && content.some((item) => (item as { type?: unknown }).type === 'tool_result')) {
        for (const item of content as { type?: unknown; is_error?: unknown; content?: unknown }[]) {
          if (item.type !== 'tool_result' || item.is_error !== true) continue;
          const said = textOf(item.content).trimStart();
          if (said.startsWith(AUTO_MODE_REFUSAL)) autoMode += 1;
          const refusal = DESKPOST_REFUSALS.find((candidate) => candidate.test.test(said));
          if (refusal) refusals[refusal.name]! += 1;
        }
        continue;
      }
      if (record['isMeta'] === true) continue;
      const origin = record['origin'] as { kind?: unknown } | undefined;
      const text = textOf(content).trim();
      const typed = origin !== undefined ? origin?.kind === 'human' : !/^(?:<[a-z-]+>|\[Request interrupted)/.test(text);
      if (!typed || /^<[a-z-]+>/.test(text)) continue;
      messages += 1;
      const group = byKickoff[kickoff] ??= { messages: 0, approvals: 0 };
      group.messages += 1;
      if (text.length <= APPROVAL_LIMIT && APPROVAL.test(text)) {
        approvals += 1;
        group.approvals += 1;
        kinds[KINDS.find((kind) => kind.test.test(before))!.id]! += 1;
      }
      before = '';
    }
  }
  const deskpostRefusals = Object.values(refusals).reduce((sum, value) => sum + value, 0);
  return {
    schema: 1,
    operation: 'Count the asks',
    layout: LAYOUT,
    folder,
    since: dayText(since),
    until: dayText(until),
    week: isoWeek(until),
    files_read: filesRead,
    sessions: sessions.size,
    messages,
    approvals,
    by_kickoff: Object.fromEntries(Object.entries(byKickoff).sort(([left], [right]) => left.localeCompare(right))),
    approvals_by_kind: kinds,
    auto_mode_refusals: autoMode,
    deskpost_refusals: deskpostRefusals,
    deskpost_refusals_by_sentence: refusals,
    permission_prompts: { accepted: promptsAccepted, rejected: promptsRejected },
  };
}

export function asksText(count: Record<string, PsJsonValue>): string {
  const kinds = count['approvals_by_kind'] as Record<string, number>;
  const refusals = count['deskpost_refusals_by_sentence'] as Record<string, number>;
  const prompts = count['permission_prompts'] as { accepted: number; rejected: number };
  const kickoffs = count['by_kickoff'] as Record<string, { messages: number; approvals: number }>;
  const ids = Object.keys(kickoffs).filter((id) => id !== 'none').sort();
  if (kickoffs['none']) ids.push('none');
  return [
    `Asks from ${count['since']} to ${count['until']}: ${count['files_read']} transcripts, ${count['sessions']} sessions read (${count['layout']}).`,
    `Typed messages: ${count['messages']}`,
    `Typed yeses: ${count['approvals']}`,
    ...KINDS.map((kind) => `  ${kind.label}: ${kinds[kind.id] ?? 0}`),
    'By Kickoff:',
    ...ids.map((id) => `  ${id}: ${kickoffs[id]!.messages} messages, ${kickoffs[id]!.approvals} yeses`),
    `Auto-mode refusals: ${count['auto_mode_refusals']}`,
    `Deskpost refusals: ${count['deskpost_refusals']}`,
    ...DESKPOST_REFUSALS.map((refusal) => `  ${refusal.name}: ${refusals[refusal.name] ?? 0}`),
    `Permission prompts answered: ${prompts.accepted + prompts.rejected} (${prompts.rejected} declined)`,
  ].join('\n');
}

const MEASURE = /^measure-\d{4}-W\d{2}\.json$/;

/** Keeps the count as `internal/asks/measure-<week>.json`, replacing that week's earlier count. */
export function writeAsksMeasure(workspace: string, count: Record<string, PsJsonValue>): string {
  const directory = path.join(workspace, 'internal', 'asks');
  ensureDirectory(directory);
  const file = path.join(directory, `measure-${count['week']}.json`);
  writeAtomicText(file, JSON.stringify(count, null, 2) + '\n');
  return file;
}

/** The Desk's one line from the newest stored count, or null when there is none or it cannot be read. */
export function asksDeskLine(workspace: string): Record<string, PsJsonValue> | null {
  const directory = path.join(workspace, 'internal', 'asks');
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => MEASURE.test(name)).sort();
  } catch {
    return null;
  }
  const newest = names.at(-1);
  if (newest === undefined) return null;
  try {
    const count = JSON.parse(fs.readFileSync(path.join(directory, newest), 'utf8')) as Record<string, unknown>;
    const kinds = Object.entries(count['approvals_by_kind'] as Record<string, number>).sort((left, right) => right[1] - left[1]);
    const top = kinds[0];
    const refusals = Number(count['auto_mode_refusals']) + Number(count['deskpost_refusals']);
    const label = KINDS.find((kind) => kind.id === top?.[0])?.label ?? 'none';
    return {
      week: String(count['week']),
      file: `internal/asks/${newest}`,
      line: `Asks this week: ${Number(count['approvals'])} typed yeses (${label} ${top?.[1] ?? 0}), ${refusals} refusals`,
    };
  } catch {
    return null;
  }
}
