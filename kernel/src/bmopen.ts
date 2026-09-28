/**
 * `library basic-memory open [<slug>]` and `library basic-memory rollback-check` (PLAN-basic-memory.md step 5).
 *
 * OPEN LISTS, THEN PUTS ONE BOOK ON THE DESK. With no slug it lists the connection's Books from the server's own
 * catalogs over MCP, each marked `also in your Library` when the Local collection holds that slug too. With a slug it
 * checks the Book is there -- its `_book` page read through the connection -- and opens `shared/<slug>` (or
 * `shared/archive/<slug>`) on this seat's Desk through the ordinary Desk write. Its pages are then read over MCP, with
 * the timeout, by the validated reader, as ADR-0049 set out. Nothing is written to Basic Memory.
 *
 * THE ROLLBACK CHECK (round 2; owned here, round 3). 1.0's reader refuses a whole Desk that holds a `shared/` entry,
 * so switching back to 1.0 with one open would close every Book on that seat at once. The check scans
 * `.claude/seats/<seat>/.open-books` in every registered Library, and in the current one, names each seat that holds
 * a `shared/` entry and the command that closes it. It writes nothing. `install.ps1 -Rollback` runs it through the
 * version it is leaving and refuses to switch while any is open (ADR-0054).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { isLocalBackend, markerConnection, readExactOrNull } from './basicmemory.ts';
import { openServer } from './bmconnection.ts';
import { deskWrite } from './desk.ts';
import { deskEntriesForSeat, seatDirectoryNames } from './seatdesk.ts';
import { readRegistry } from './workspace.ts';
import { BOOK_SLUG_PATTERN } from './places.ts';

class OpenRefusal extends Error {}

function refuse(message: string): never {
  throw new OpenRefusal(message);
}

interface SharedBook {
  slug: string;
  title: string;
  summary: string;
  shelf: 'active' | 'archive';
}

/** Every Book a catalog lists, by its link target: `books/<slug>/wiki/_book` or `archive/<slug>/wiki/_book`. */
function catalogBooks(text: string, shelf: 'active' | 'archive'): SharedBook[] {
  const prefix = shelf === 'archive' ? 'archive' : 'books';
  const found = new Map<string, SharedBook>();
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`\\[\\[${prefix}\\/([a-z0-9][a-z0-9-]*)\\/wiki\\/_book\\|([^\\]]*)\\]\\](.*)$`, 'i').exec(line);
    if (!match) continue;
    const slug = match[1]!.toLowerCase();
    if (!found.has(slug)) found.set(slug, { slug, title: match[2]!.trim(), summary: match[3]!.replace(/^\s*[—–-]\s*/, '').trim(), shelf });
  }
  return [...found.values()];
}

function connectionOrRefuse(workspace: string) {
  if (!isLocalBackend(workspace)) refuse('library basic-memory open is for a local Library; on a workspace whose backend is Basic Memory, open its Books as books/<slug>.');
  const connection = markerConnection(workspace);
  if (connection === null) refuse('This Library has no Basic Memory connection, so there is no shared Book to open. Connect one with `library basic-memory setup`.');
  // The reader's own rule (inspection #9): a connection `init --mcp-url` recorded without a collection id addresses nothing.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(connection.collection_id)) {
    refuse('The Basic Memory connection records no collection UUID, so no shared Book can be addressed. Run `library basic-memory setup` again.');
  }
  return connection;
}

export async function basicMemoryOpen(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace', 'seat', 'claim-token', 'shelf']);
  const connection = connectionOrRefuse(workspace);
  const shelf = (parsed.options.get('shelf') ?? 'active') === 'archive' ? 'archive' : 'active';
  let session: Awaited<ReturnType<typeof openServer>>;
  try {
    session = await openServer(connection.url);
  } catch (error) {
    refuse(`Nothing was opened. The Basic Memory server did not answer: ${(error as Error).message}`);
  }
  const read = async (relative: string) => readExactOrNull(session, connection.collection_id, relative, { includeFrontmatter: false, stopped: 'nothing was opened' });
  const collection = path.join(workspace, 'collection');
  const alsoHere = (book: SharedBook) => fs.existsSync(path.join(collection, book.shelf === 'archive' ? 'archive' : 'books', book.slug, 'wiki'));

  const slug = (parsed.positional[0] ?? '').trim();
  if (!slug) {
    const active = catalogBooks((await read('books/README.md'))?.content ?? '', 'active');
    const archived = catalogBooks((await read('archive/README.md'))?.content ?? '', 'archive');
    const rows = [...active, ...archived].map((book) => ({
      slug: book.slug,
      shelf: book.shelf,
      title: book.title,
      summary: book.summary,
      also_in_your_library: alsoHere(book),
      opens_as: book.shelf === 'archive' ? `shared/archive/${book.slug}` : `shared/${book.slug}`,
    }));
    return {
      schema: 1,
      operation: 'List shared Books',
      connection: { url: connection.url, collection_name: connection.collection_name },
      books: rows,
      count: rows.length,
      also_in_your_library: rows.filter((row) => row.also_in_your_library).length,
      next: 'Open one with `library basic-memory open <slug>` (add --shelf archive for an archived Book). Its pages are read from the server, never copied.',
      shared_library_write: false,
    };
  }

  if (!BOOK_SLUG_PATTERN.test(slug)) refuse(`'${slug}' is not a Book slug: lowercase letters, digits and hyphens.`);
  const root = shelf === 'archive' ? `archive/${slug}` : `books/${slug}`;
  const page = await read(`${root}/wiki/_book.md`);
  if (page === null) refuse(`The Basic Memory collection '${connection.collection_name || connection.collection_id}' has no Book at ${root}. List what it has with \`library basic-memory open\`.`);
  const opened = deskWrite({
    workspace,
    action: 'open',
    kind: 'book',
    location: 'shared',
    shelf,
    slug,
    seat: parsed.options.get('seat'),
    claimToken: parsed.options.get('claim-token'),
  });
  const here = fs.existsSync(path.join(collection, root, 'wiki'));
  return {
    schema: 1,
    operation: 'Open a shared Book',
    book: shelf === 'archive' ? `shared/archive/${slug}` : `shared/${slug}`,
    title: /^#[ \t]+(.+?)[ \t]*$/m.exec(page.content)?.[1] ?? slug,
    desk: opened,
    also_in_your_library: here,
    ...(here ? { place_note: `This slug is also in your Local collection: open both and a read names which with place (collection or shared).` } : {}),
    shared_library_write: false,
  };
}

// --- the rollback check -------------------------------------------------------------------------------------

/** Each seat in one Library whose Desk holds a `shared/` entry. Unreadable seat folders are named, not skipped. */
function sharedDeskEntries(workspace: string): { seats: { seat: string; entries: string[] }[]; problems: string[] } {
  const stateDirectory = path.join(workspace, '.claude');
  const seats: { seat: string; entries: string[] }[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = seatDirectoryNames(stateDirectory);
  } catch (error) {
    problems.push((error as Error).message);
  }
  for (const seat of names) {
    try {
      const entries = deskEntriesForSeat(stateDirectory, seat, 'books').filter((entry) => entry.startsWith('shared/'));
      if (entries.length) seats.push({ seat, entries });
    } catch (error) {
      problems.push(`seat '${seat}': ${(error as Error).message}`);
    }
  }
  return { seats, problems };
}

export async function basicMemoryRollbackCheck(argv: string[], workspace: string): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace', 'registry-root']);
  const libraries = new Set<string>();
  if (workspace) libraries.add(path.resolve(workspace));
  let registryProblem: string | null = null;
  try {
    for (const entry of readRegistry(parsed.options.get('registry-root'))) libraries.add(path.resolve(entry.root));
  } catch (error) {
    registryProblem = (error as Error).message;
  }
  const blocking: Record<string, PsJsonValue>[] = [];
  const unreadable: string[] = registryProblem ? [registryProblem] : [];
  const checked: string[] = [];
  for (const library of [...libraries].sort()) {
    if (!fs.existsSync(path.join(library, '.claude', 'seats'))) {
      checked.push(library);
      continue;
    }
    const found = sharedDeskEntries(library);
    checked.push(library);
    unreadable.push(...found.problems.map((problem) => `${library}: ${problem}`));
    for (const seat of found.seats) {
      blocking.push({
        library,
        seat: seat.seat,
        entries: seat.entries,
        close: seat.entries.map((entry) => {
          const archived = entry.startsWith('shared/archive/');
          const slug = entry.substring(archived ? 'shared/archive/'.length : 'shared/'.length);
          return `library desk close book ${slug} --location shared${archived ? ' --shelf archive' : ''} --seat ${seat.seat} --workspace "${library}"`;
        }),
      });
    }
  }
  const ready = blocking.length === 0 && unreadable.length === 0;
  return {
    schema: 1,
    operation: 'Check a rollback to 1.0',
    ready,
    libraries_checked: checked,
    blocking,
    unreadable,
    reason: ready
      ? 'No Desk holds a shared/ entry, so 1.0 reads every Desk as it is.'
      : blocking.length
        ? "1.0's reader refuses a whole Desk that holds a shared/ entry, so these seats would lose every open Book. Close each shared Book first, with the commands given."
        : 'A seat folder or the registry could not be read, so the check cannot say every Desk is safe for 1.0.',
    writes: 'none',
    shared_library_write: false,
  };
}
