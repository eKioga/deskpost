/**
 * `library basic-memory status`: how a local Library and its Basic Memory connection differ (PLAN-basic-memory.md
 * step 3). WRITES NOTHING, ANYWHERE: not the Library, not the storage folder, not Basic Memory.
 *
 *   Basic Memory  <server URL>   reachable
 *     Collection  ai-library   24 Books · 10 Projects · 18 archived
 *     Access      read-only (import reads the storage folder; nothing is ever written to Basic Memory in 1.1)
 *     Compared    3 Books only there · 1 only here · 2 differ · last import 2026-09-27 10:14
 *
 * REACHABILITY IS MCP; COUNTS AND THE COMPARISON ARE THE STORAGE FOLDER. The folder is read byte for byte, as import
 * reads it, so what status says differs is exactly what an import would act on. Without a folder the counts come
 * from the server's own catalogs over MCP, and the comparison says it needs the folder -- a catalog is a
 * reader-facing list, and can be incomplete (Fable #9).
 *
 * "DIFFER" NAMES WHICH SIDE CHANGED, judged against the import record (`collection/imports.md`): a file the source
 * changed since the last import is `there`, one this Library changed is `here`, and both is `both`. A root that is
 * in both places and that no import brought cannot be judged that way, and says so (`unrecorded`).
 */

import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { markerConnection, mcpTimeoutMs, readExactOrNull, type BasicMemoryConnection } from './basicmemory.ts';
import { openServer } from './bmconnection.ts';
import { compareWithSource, readImportRecord, scanSource, type RootKind, type RootRow } from './bmsource.ts';
import { boundProjects, unfinishedImportJournals } from './bmimport.ts';

/** The server answers `initialize` within the timeout, or the reason it did not. */
async function reachability(connection: BasicMemoryConnection): Promise<{ reachable: boolean; detail: string; session: Awaited<ReturnType<typeof openServer>> | null }> {
  try {
    const session = await openServer(connection.url);
    return { reachable: true, detail: `answered MCP initialize within ${mcpTimeoutMs() / 1000} s`, session };
  } catch (error) {
    return { reachable: false, detail: (error as Error).message, session: null };
  }
}

/** The four catalogs over MCP, each root counted once by its link target. A catalog the server lacks counts nothing. */
async function countsOverMcp(session: Awaited<ReturnType<typeof openServer>>, collectionId: string): Promise<Record<string, PsJsonValue>> {
  const catalogs: [RootKind, string, RegExp][] = [
    ['book', 'books/README.md', /\[\[books\/([a-z0-9][a-z0-9-]*)\/wiki\/_book\|/gi],
    ['project', 'projects/README.md', /\[\[projects\/([a-z0-9][a-z0-9-]*)\/_project\|/gi],
    ['archived-book', 'archive/README.md', /\[\[archive\/([a-z0-9][a-z0-9-]*)\/wiki\/_book\|/gi],
    ['archived-project', 'archive/projects/README.md', /\[\[archive\/projects\/([a-z0-9][a-z0-9-]*)\/_project\|/gi],
  ];
  const counts: Record<string, PsJsonValue> = {};
  for (const [kind, catalog, pattern] of catalogs) {
    const note = await readExactOrNull(session, collectionId, catalog, { includeFrontmatter: false, stopped: 'status read nothing more' });
    counts[kind.replace('-', '_')] = note === null ? 0 : new Set([...note.content.matchAll(pattern)].map((match) => match[1]!.toLowerCase())).size;
  }
  return counts;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word.replace(/s$/, '') : word}`;
}

export async function basicMemoryStatus(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  parseArguments(argv, ['workspace']);
  const connection = markerConnection(workspace);
  if (connection === null) {
    return {
      schema: 1,
      operation: 'Basic Memory status',
      workspace,
      connected: false,
      offer: 'Optional: a Basic Memory server shares your Books across machines. Connect one with `library basic-memory setup --url <mcp-url> --collection <name> [--storage <folder>]`.',
      writes: 'none',
      shared_library_write: false,
    };
  }

  const reached = await reachability(connection);
  const result: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Basic Memory status',
    workspace,
    connected: true,
    connection: { url: connection.url, collection_name: connection.collection_name, collection_id: connection.collection_id, storage: connection.storage },
    reachable: reached.reachable,
    reachability: reached.detail,
    access: 'read-only (import reads the storage folder; nothing is ever written to Basic Memory in 1.1)',
  };

  // COUNTS AND THE COMPARISON: the storage folder when there is one.
  let counts: Record<string, PsJsonValue> | null = null;
  let countsFrom = 'unavailable';
  let compared: Record<string, PsJsonValue> = { status: 'needs the storage folder', detail: 'set one with `library basic-memory setup --storage <folder>`; the comparison reads it byte for byte, as import does' };
  const lines: string[] = [];
  if (connection.storage) {
    try {
      const scan = scanSource(connection.storage);
      counts = { book: 0, project: 0, archived_book: 0, archived_project: 0 };
      for (const root of scan.roots) counts[root.kind.replace('-', '_')] = Number(counts[root.kind.replace('-', '_')]) + 1;
      countsFrom = 'the storage folder';
      const record = readImportRecord(workspace);
      const pendingAdded = unfinishedImportJournals(workspace).flatMap((journal) => journal.added_roots);
      // The same seat bindings the import applies, so `only there` is what an import would bring (inspection #6).
      const comparison = compareWithSource(workspace, scan, record, { pendingAdded, boundProjects: boundProjects(workspace) });
      const pick = (states: string[]) => comparison.roots.filter((row) => states.includes(row.state));
      const describe = (row: RootRow): Record<string, PsJsonValue> => {
        const moving = comparison.files.filter((file) => file.root === row.root && !['same', 'gone'].includes(file.action));
        const byAction: Record<string, PsJsonValue> = {};
        for (const file of moving) byAction[file.action] = Number(byAction[file.action] ?? 0) + 1;
        return {
          root: row.root,
          changed: row.state === 'root-conflict' ? 'unrecorded' : row.changed,
          ...(row.reason ? { reason: row.reason } : {}),
          files: byAction,
        };
      };
      const onlyThere = pick(['only-there']);
      const onlyHere = pick(['only-here']);
      const differ = pick(['differ', 'root-conflict']);
      const booksOnlyThere = onlyThere.filter((row) => row.kind === 'book' || row.kind === 'archived-book').length;
      compared = {
        status: 'compared',
        only_there: onlyThere.map((row) => row.root),
        only_here: onlyHere.map((row) => row.root),
        differ: differ.map(describe),
        same: pick(['same', 'adopt']).length,
        pending_import: pendingAdded.length > 0,
      };
      const lastImport = record.imports[record.imports.length - 1] ?? null;
      result['last_import'] = lastImport === null ? null : (lastImport as PsJsonValue);
      lines.push(
        `Compared    ${plural(booksOnlyThere, 'Books')} only there` +
          (onlyThere.length > booksOnlyThere ? ` (+${plural(onlyThere.length - booksOnlyThere, 'Projects')})` : '') +
          ` · ${onlyHere.length} only here · ${differ.length} differ · ` +
          (lastImport === null ? 'never imported' : `last import ${String((lastImport as Record<string, PsJsonValue>)['at'] ?? '').replace('T', ' ').slice(0, 16)}`),
      );
      if (pendingAdded.length) lines.push('Pending     an import did not finish; run `library basic-memory import` again to finish it');
    } catch (error) {
      compared = { status: 'unavailable', detail: (error as Error).message };
      lines.push(`Compared    unavailable: ${(error as Error).message}`);
    }
  } else if (reached.session !== null) {
    try {
      counts = await countsOverMcp(reached.session, connection.collection_id);
      countsFrom = "the server's catalogs over MCP";
    } catch (error) {
      countsFrom = `unavailable: ${(error as Error).message}`;
    }
    lines.push('Compared    needs the storage folder');
  } else {
    lines.push('Compared    needs the storage folder');
  }
  if (!('last_import' in result)) {
    const record = (() => {
      try {
        return readImportRecord(workspace);
      } catch {
        return null;
      }
    })();
    const last = record?.imports[record.imports.length - 1];
    result['last_import'] = last === undefined ? null : (last as PsJsonValue);
  }
  result['counts'] = counts;
  result['counts_from'] = countsFrom;
  result['compared'] = compared;

  const archived = counts === null ? 0 : Number(counts['archived_book']) + Number(counts['archived_project']);
  const head = [
    `Basic Memory  ${connection.url}   ${reached.reachable ? 'reachable' : `NOT reachable: ${reached.detail}`}`,
    `  Collection  ${connection.collection_name || connection.collection_id}   ` +
      (counts === null ? `counts ${countsFrom}` : `${plural(Number(counts['book']), 'Books')} · ${plural(Number(counts['project']), 'Projects')} · ${archived} archived`),
    `  Access      ${String(result['access'])}`,
    ...lines.map((line) => `  ${line}`),
  ];
  result['summary'] = head;
  result['writes'] = 'none';
  result['shared_library_write'] = false;
  return result;
}
