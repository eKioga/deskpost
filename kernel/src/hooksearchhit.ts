/**
 * `library hook search-hit` (kickoffs/s82 row 3, PLAN-no-powershell-runtime.md D1, ADR-0064): the PostToolUse reminder
 * `Add-SearchHitReminder.ps1` gives, that a hit is a location and not a reading (docs/hit-is-a-location.md).
 *
 * WHAT COUNTS AS A SEARCH. The reader's `discover_book_pages` and `search_open_books` under THIS registration's reader
 * prefix -- `--reader-tool-prefix`, as desk-context takes it, because the script's exact names never matched a reader
 * named any other way -- and a shell command running `Search-RawBatch.ps1`, `deskpost raw search` or `library raw search`.
 *
 * IT FIRES ON EVERY SEARCH, with no once-per-session ledger, and it does not read the results: the line covers a hit
 * and an empty result alike and asserts nothing about which this is (the script's header says why). A payload it
 * cannot read, or a prefix that names no tool, is silence: it cannot block, and the Desk hook already says the second.
 */

import { field, hookCommandText } from './guards.ts';
import { DEFAULT_READER_PREFIX, isReaderPrefix } from './readerprefix.ts';
import { parseArguments } from './argv.ts';

export const SEARCH_HIT_REMINDER =
  'A hit is a location, not a reading: these results say only where the term occurs. ' +
  'Open what a hit names before answering from it, and cite the hit as where you looked. ' +
  'If nothing matched, that is a search that stopped early, not a finding of absence.';

/** A shell command that searches raw material: the script, or either spelling of the kernel's verb. */
const RAW_SEARCH = /Search-RawBatch\.ps1|(^|[\s;&|("'\\/])(deskpost|library)(\.cmd|\.exe)?["']?\s+raw\s+search(\s|$)/i;

export function isSearchCall(call: unknown, prefix: string): boolean {
  const toolName = String(field(call, 'tool_name') ?? '');
  if (toolName === `${prefix}discover_book_pages` || toolName === `${prefix}search_open_books`) return true;
  return RAW_SEARCH.test(hookCommandText(field(call, 'tool_input')));
}

/** `library hook search-hit [--reader-tool-prefix <p>]`, payload on stdin: the reminder, or nothing. */
export function runSearchHitVerb(argv: string[], stdinText: string): string {
  try {
    const parsed = parseArguments(argv, ['reader-tool-prefix']);
    const prefix = parsed.options.get('reader-tool-prefix') || DEFAULT_READER_PREFIX;
    if (!isReaderPrefix(prefix)) return '';
    const call = JSON.parse(stdinText.replace(/^﻿/, '') || 'null') as unknown;
    if (!isSearchCall(call, prefix)) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: SEARCH_HIT_REMINDER } });
  } catch {
    return '';
  }
}
