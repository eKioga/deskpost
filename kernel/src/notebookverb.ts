/**
 * `library notebook render` and `library notebook own` -- the two Notebook operations a reader runs
 * directly. Ported from `tools/NotebookIndex.ps1 -Render` and `tools/Set-NotebookTopicOwner.ps1`
 * (S17). The machinery is `notebook.ts`; this file is argument binding and the result each helper
 * reports, field for field.
 *
 * UNDER ADR-0029 (S18) render re-derives THIS SEAT'S index, `notebook/<seat>/_master-index.md`, and
 * `own` is retired: a topic belongs to the seat whose Notebook holds it, so there is no ownership to
 * record. It refuses by name rather than disappearing, so a reader who types it learns what replaced it.
 */

import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { resolveSeatName } from './seatdesk.ts';
import { invokeNotebookRender, scopeIndexDrift } from './notebook.ts';
import { notebookScope, prepareNotebookScopeForWrite } from './notebooklayout.ts';

export interface NotebookResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/**
 * Re-derive this seat's index, reporting the drift it repaired. The drift is read BEFORE the render,
 * because this is the named repair for exactly that drift and a repair that cannot say what it
 * repaired is indistinguishable from a no-op.
 */
function renderVerb(workspace: string, argv: string[]): PsJsonValue {
  const parsed = parseArguments(argv, ['seat', 'workspace']);
  const seatState = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory: path.join(workspace, '.claude') });
  const scope = notebookScope(workspace, seatState.status === 'named' ? seatState.seat! : null, 'write', 'Rendering the Notebook index');
  const driftBefore = scopeIndexDrift(scope);
  prepareNotebookScopeForWrite(scope, 'Rendering the Notebook index');
  const render = invokeNotebookRender(scope);
  return {
    schema: 1,
    operation: 'Render the Notebook master index',
    workspace,
    master_index_path: render.master_index_path,
    topic_count: render.topic_count,
    drift_repaired: driftBefore,
    shared_library_write: false,
  };
}

export const OWN_RETIRED_REFUSAL =
  "library notebook own is retired by ADR-0029: a topic belongs to the seat whose Notebook holds it, notebook/<seat>/<topic>/, so there is " +
  'no ownership to record, share or exclude. Material two seats both want graduates to a Shelf Book, which is the designed exit ramp. ' +
  "A workspace still in the shared layout keeps tools/Set-NotebookTopicOwner.ps1 until 'library migrate' moves it.";

export function runNotebookVerb(argv: string[], workspace: string): NotebookResult {
  const action = argv[0] ?? '';
  try {
    if (action === 'render') return { refusal: null, value: renderVerb(workspace, argv.slice(1)) };
    if (action === 'own') return { refusal: OWN_RETIRED_REFUSAL, value: null };
    return { refusal: `library notebook has no action '${action}'. It has: own, render.`, value: null };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
