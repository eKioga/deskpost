/** A reader go removes a wait, never a gate (ADR-0093). No authority is derived from its words. */
import * as fs from 'node:fs';
import { isAddressedTo, noteFrontmatter, parseShelfNote, type SeatIncarnation } from './shelfnote.ts';
import { seatConversationRecord, transcriptPath, transcriptRoot } from './conversation.ts';

export const GO_MAX_AGE_HOURS = 24;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function letterGo(text: string, thisLibraryId: string): { typed: string } | null {
  const fields = noteFrontmatter(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const keys = lines.slice(1, end).flatMap(line => /^\s*(go_[^:\s]*):/.exec(line)?.[1] ?? []);
  if (keys.length !== 3 || !['go_words', 'go_typed', 'go_check'].every(key => keys.filter(k => k === key).length === 1)) return null;
  const typed = fields.get('go_typed') ?? '';
  if (!fields.get('for_seat') || !fields.get('go_words') || fields.get('go_check') !== 'transcript' ||
      !UTC_INSTANT.test(typed) || !Number.isFinite(Date.parse(typed)) ||
      !['binding', 'launcher'].includes(fields.get('from_seat_source') ?? '') || fields.has('from_library_id') ||
      (fields.get('for_library_id') && fields.get('for_library_id') !== thisLibraryId)) return null;
  return { typed };
}

export function goFor(text: string, thisLibraryId: string, self: SeatIncarnation | null): 'recipient' | 'other' | null {
  if (!letterGo(text, thisLibraryId)) return null;
  const note = parseShelfNote('', '', text);
  note.localLibraryId = thisLibraryId;
  return isAddressedTo(note, self) ? 'recipient' : 'other';
}

const normalise = (text: string): string => text.normalize('NFC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
function goRefusal(reason: string): never { throw new Error(`--go ${reason}. Send without --go, or ask the reader in this conversation. Nothing was captured.`); }

/** Reads only the sending seat's recorded Claude conversation. A fixture supplies its own transcript root. */
export function checkLetterGo(stateDirectory: string, seat: string, source: string, words: string, now = new Date()): { typed: string; check: string } {
  if (!words.trim() || words.length > 300 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(words)) goRefusal('needs 1 to 300 characters on one line, without control characters');
  if (!seat || !['binding', 'launcher'].includes(source)) goRefusal('needs a sending seat resolved by binding or launcher');
  const record = seatConversationRecord(stateDirectory, seat);
  if (!record.session_id || record.assistant !== 'claude') goRefusal('needs a recorded Claude Code conversation; Codex cannot send a go');
  const file = transcriptPath(transcriptRoot(), record.session_id);
  if (!file) goRefusal('found no transcript for the sending conversation');
  if (fs.statSync(file).size > 256 * 1024 * 1024) goRefusal('refuses a transcript over 256 MB');
  let newest = -Infinity;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { goRefusal('refuses a transcript line that is not a JSON object'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) goRefusal('refuses a transcript line that is not a JSON object');
    if (row.type !== 'user' || row.isSidechain || row.isMeta || row.origin?.kind !== 'human') continue;
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) && content.every((item: any) => item?.type === 'text' && typeof item.text === 'string') ? content.map((item: any) => item.text).join(' ') : '';
    if (/^\s*<[a-z-]+(?:\s[^>]*)?>/.test(text) && !/^\s*<pasted_content\b/.test(text)) continue;
    // Pasted spans have an id on both delimiters in 2.1.319. An incomplete span discards its tail, too.
    const typedText = text.replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content\b[^>]*>|$)/g, ' ');
    const time = Date.parse(row.timestamp);
    const haystack = normalise(typedText), needle = normalise(words);
    const match = [...haystack.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'))].some(hit => {
      const start = hit.index!, end = start + needle.length;
      const before = [...haystack.slice(Math.max(0, start - 2), start)].at(-1) ?? '';
      const after = String.fromCodePoint(haystack.codePointAt(end) ?? 0);
      return !/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after);
    });
    if (time <= now.getTime() && time >= now.getTime() - GO_MAX_AGE_HOURS * 3600000 && match) newest = Math.max(newest, time);
  }
  if (!Number.isFinite(newest)) goRefusal('found no matching typed message in the last 24 hours');
  return { typed: new Date(newest).toISOString(), check: 'transcript' };
}
