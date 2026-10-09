/**
 * `library hook compact-clear` (kickoffs/s82 row 2, PLAN-no-powershell-runtime.md D1, ADR-0064): the serve-ledger
 * clear `Restore-CompactedGuidance.ps1` does on PostCompact and SessionStart, and nothing else.
 *
 * WHY A VERB. An installed Library registered the script with no `-StateDirectory`, so it emptied the PROGRAM's
 * `.claude/.hook-served.json` and never the workspace's, which is the one the Desk hook writes (the compaction-clear
 * Report; S77 measured it). This clears THE WORKSPACE'S ledger, resolved as desk-context resolves it -- an explicit
 * workspace or state directory, then LIBRARY_WORKSPACE, then the working directory's marker, then the anchor -- so
 * the clear and the ledger it is for are the same file by construction.
 *
 * IT PRINTS NOTHING, on either event: Claude Code accepts no `hookSpecificOutput` for PostCompact (measured 2026-09-22,
 * see the script), and the script's other half -- re-serving the development rule's standing rules on a resumed or
 * compacted session -- is dropped (Q5): `init` writes no `.claude/rules/` into a workspace, and the development
 * checkout keeps the script. It runs on every SessionStart source, as the script does, because the cheapest wrong
 * answer is a redundant clear. With no workspace, or any failure, it exits 0 silently: it cannot block, and a ledger it
 * could not clear costs a repeated Desk block, never a withheld one.
 */

import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { field } from './guards.ts';
import { clearHookServed } from './hookledger.ts';
import { resolveWorkspace } from './workspace.ts';

/** The state directory this clear empties: `--state-directory`, else `<workspace>/.claude` as desk-context resolves it. */
export function compactClearStateDirectory(options: { workspace?: string; stateDirectory?: string }): string | null {
  if (options.stateDirectory && options.stateDirectory.trim()) return options.stateDirectory;
  const resolved = resolveWorkspace({ explicit: options.workspace ?? '' });
  if (resolved.kind !== 'resolved' || !resolved.workspace) return null;
  return path.join(resolved.workspace, '.claude');
}

/** `library hook compact-clear [--workspace <p>] [--state-directory <d>]`, payload on stdin. Always prints nothing. */
export function runCompactClearVerb(argv: string[], stdinText: string): string {
  try {
    const parsed = parseArguments(argv, argumentTable('hook', 'compact-clear'));
    const stateDirectory = compactClearStateDirectory({ workspace: parsed.options.get('workspace'), stateDirectory: parsed.options.get('state-directory') });
    if (stateDirectory === null) return '';
    const call = JSON.parse(stdinText.replace(/^﻿/, '') || 'null') as unknown;
    const sessionId = field(call, 'session_id');
    if (typeof sessionId === 'string') clearHookServed(stateDirectory, sessionId);
  } catch {
    // silent: see the header
  }
  return '';
}
