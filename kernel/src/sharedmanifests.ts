/** Shared Discovery metadata, rebuilt on demand by a connected local Library. No server writes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { markerConnection, McpSession, listFolderNodes, readListedContent } from './basicmemory.ts';
import { getMarkdownHeadings, newBookManifestFromPages, type ManifestPage } from './manifest.ts';
import { saveBookManifest, removeBookManifestStore } from './manifeststore.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { writeAtomicText } from './fsx.ts';
import { utcRoundTrip } from './journal.ts';
import type { PsJsonValue } from './psjson.ts';
import { postboxCache } from './postbox.ts';
import { readSeatIdentityView, idsOf } from './seatincarnation.ts';

export type SharedMaintainer = { library_id: string; card: string; any_seat: boolean; names: string[] };
export const SHARED_FAILURE_CLASSES = ['listing failed', 'page would not read', '_book.md would not read', "the Book's lock was held", 'invalid upkeep note', 'server error'] as const;
export function sharedFailureClass(message: string): string {
  if (/invalid upkeep note/i.test(message)) return 'invalid upkeep note';
  if (/_book\.md.*could not be read/i.test(message)) return '_book.md would not read';
  if (/\block\b.*\bheld\b|\bholds the lock\b/i.test(message)) return "the Book's lock was held";
  if (/listing|bm_list|list_directory|^(?:.*(?<!\.md) )?could not be read:/i.test(message)) return 'listing failed';
  if (/not.found|could not be read|bm_read/i.test(message)) return 'page would not read';
  return 'server error';
}

/** Upkeep notes carry display metadata only. Reject an incomplete block rather than imply no grant. */
function upkeepGrants(text: string, slug: string, ownId: string, namesById: Map<string, string>): SharedMaintainer[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim();
  const blocks = body.split(/^## library /m);
  if (blocks.shift()?.trim() !== `# Upkeep grants for ${slug}` || !blocks.length) throw new Error('Invalid upkeep note.');
  const seen = new Set<string>();
  return blocks.map(block => {
    const match = /^([^\r\n]+)\r?\n- card:[ \t]*(\S[^\r\n]*?)\s*\r?\n- seat_ids:[ \t]*([^\r\n]*?)\s*\r?\n- any_seat:[ \t]*(true|false)\s*\r?\n- names:[ \t]*(\S[^\r\n]*?)\s*\r?\n- book_record:[ \t]*(\S+)\s*\r?\n- time:[ \t]*(\S+)\s*$/.exec(block);
    if (!match) throw new Error('Invalid upkeep note.');
    const [, rawId, card, seats, any, names, record, time] = match;
    const id = rawId!.trim();
    const seatIds = seats!.trim() ? seats!.split(',').map(value => value.trim()) : [];
    const displayNames = names!.split(',').map(value => value.trim());
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || seen.has(id) ||
      (any === 'true' ? seatIds.length !== 0 || names!.trim() !== 'any seat' : !seatIds.length || seatIds.some(value => !/^[0-9a-f]{32}$/.test(value))) ||
      displayNames.some(value => !value) || !record || !/^\d{4}-\d\d-\d\dT.*Z$/.test(time!) || !Number.isFinite(Date.parse(time!))) throw new Error('Invalid upkeep note.');
    seen.add(id);
    return { library_id: id, card: card!.trim(), any_seat: any === 'true',
      names: any === 'true' ? ['any seat'] : id === ownId ? seatIds.map(value => namesById.get(value) ?? 'retired seat') : displayNames };
  });
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
class SharedWalkStopped extends Error {}

type Node = { type: string; file_path?: string; directory_path?: string; name?: string; permalink?: string };

/** List one level and validate that every returned identifier stays directly inside the requested folder. */
export async function sharedFolder(session: McpSession, project: string, folder: string): Promise<Node[]> {
  const nodes = await listFolderNodes(session, project, folder, folder, `${folder} exceeds the listing cap.`) as Node[];
  for (const node of nodes) {
    const identifier = node.type === 'directory' ? String(node.directory_path ?? '').replace(/^\//, '') : String(node.file_path ?? '');
    const relative = identifier.startsWith(`${folder}/`) ? identifier.slice(folder.length + 1) : '';
    if (!relative || relative === '.' || relative === '..' || /[\\/\x00-\x1f]/.test(relative)) {
      throw new Error(`Listing '${folder}' returned an identifier outside that folder: '${identifier}'.`);
    }
  }
  return nodes;
}

/** The same paged walk feeds manifests and full-text search; files retain their listed read identifiers. */
export async function* sharedPages(session: McpSession, project: string, folder: string, stop: () => boolean = () => false): AsyncGenerator<Node> {
  if (stop()) return;
  // listFolderNodes may need fifty network pages. Stop before EACH request, not only after a whole folder.
  const listing = new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'callTool') return async (...args: Parameters<McpSession['callTool']>) => {
        if (stop()) throw new SharedWalkStopped();
        return target.callTool(...args);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  let nodes: Node[];
  try { nodes = await sharedFolder(listing, project, folder); }
  catch (error) { if (error instanceof SharedWalkStopped) return; throw error; }
  for (const node of nodes) {
    if (stop()) return;
    if (node.type === 'directory') yield* sharedPages(session, project, String(node.directory_path).replace(/^\//, ''), stop);
    else if (String(node.file_path).endsWith('.md')) yield node;
  }
}

export async function rebuildSharedManifests(workspace: string): Promise<Record<string, PsJsonValue> | null> {
  const connection = markerConnection(workspace);
  if (!connection) return null;
  const books: Record<string, PsJsonValue>[] = [];
  const unavailable: Record<string, PsJsonValue>[] = [];
  const withheld: Record<string, PsJsonValue>[] = [];
  const session = new McpSession(connection.url, 'deskpost-shared-manifests');
  let active: Node[];
  let archive: Node[];
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(connection.collection_id)) throw new Error('The Basic Memory connection records no collection UUID; run deskpost basic-memory setup again.');
    await session.initialize();
    // Establish both complete rosters before retiring anything. A connection failure preserves old shared stores.
    active = await sharedFolder(session, connection.collection_id, 'books');
    archive = await sharedFolder(session, connection.collection_id, 'archive');
  } catch (error) {
    return { status: 'not reached', reason: (error as Error).message, books, pages_withheld: withheld, books_unavailable: unavailable };
  }
  const project = { id: connection.collection_id, name: connection.collection_name || connection.collection_id };
  const grants = new Map<string, { maintained_by?: SharedMaintainer[]; maintained_unreadable?: string }>();
  const upkeepErrors: Record<string, PsJsonValue>[] = [];
  let upkeepUnreadable = '';
  try {
    const notes = await sharedFolder(session, project.id, '_deskpost/upkeep');
    const ownId = String(postboxCache(workspace).state?.['library_id'] ?? '');
    const namesById = new Map([...idsOf(readSeatIdentityView(path.join(workspace, '.claude')))].map(([name, id]) => [id, name]));
    for (const note of notes) {
      const slug = String(note.file_path ?? '').slice('_deskpost/upkeep/'.length, -3);
      if (note.type === 'directory' || !String(note.file_path).endsWith('.md') || !active.some(node => node.type === 'directory' && String(node.directory_path).replace(/^\//, '') === `books/${slug}`)) continue;
      try {
        const text = await readListedContent(session, project, String(note.file_path), String(note.permalink ?? ''));
        if (text === null) throw new Error('The listed page could not be read (not found).');
        grants.set(slug, { maintained_by: upkeepGrants(text, slug, ownId, namesById) });
      } catch (error) {
        grants.set(slug, { maintained_unreadable: sharedFailureClass((error as Error).message) });
        upkeepErrors.push({ book: `shared/${slug}`, reason: (error as Error).message });
      }
    }
  } catch (error) {
    upkeepUnreadable = sharedFailureClass((error as Error).message);
    upkeepErrors.push({ reason: (error as Error).message });
  }
  for (const [folder, collection, nodes] of [['books', 'shared', active], ['archive', 'shared-archive', archive]] as const) {
    const listed = nodes.filter(node => node.type === 'directory').map(node => String(node.directory_path).split('/').pop()!).filter(slug => SLUG.test(slug));
    const roster: { slug: string; unavailable?: string; unavailable_class?: string; pages_withheld?: { page: string; reason: string }[]; maintained_by?: SharedMaintainer[]; maintained_unreadable?: string }[] = [];
    for (const slug of listed) {
      const entry: typeof roster[number] = { slug };
      if (collection === 'shared') Object.assign(entry, grants.get(slug));
      roster.push(entry);
      const root = `${collection}/${slug}`;
      let lock: ReturnType<typeof enterBookLock> | null = null;
      try {
        lock = enterBookLock(workspace, root);
        const wiki = `${folder}/${slug}/wiki`;
        const pages: ManifestPage[] = [];
        const pagesWithheld: { page: string; reason: string }[] = [];
        for await (const node of sharedPages(session, project.id, wiki)) {
          const file = String(node.file_path);
          try {
            const text = await readListedContent(session, project, file, String(node.permalink ?? ''));
            if (text === null) throw new Error('The listed page could not be read (not found).');
            pages.push({ path: file.slice(wiki.length + 1, -3), text, bytes: Buffer.from(text, 'utf8') });
          } catch (error) {
            const missing = { page: file, reason: (error as Error).message };
            pagesWithheld.push(missing);
            withheld.push({ book: root, ...missing });
          }
        }
        const book = pages.find(page => page.path === '_book');
        if (!book) throw new Error(`${wiki}/_book.md could not be read; Book stays in the roster, marked unavailable.`);
        const title = getMarkdownHeadings(book.text).find(heading => heading.level === 1)?.text ?? slug;
        const summary = /^## Purpose[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(book.text)?.[1]?.trim() ?? '';
        const isCapture = /^\s*-\s+\*\*Kind:\*\*\s+capture\s*$/m.test(book.text);
        const manifest = newBookManifestFromPages({ slug, title, summary, isCapture, pages, capturePageCount: pages.filter(page => page.path.startsWith('notes/')).length, linkPrefix: `${folder}/${slug}/wiki/` });
        saveBookManifest({ workspace, slug, collection, manifest, reason: 'deskpost collection rebuild' });
        if (pagesWithheld.length) entry.pages_withheld = pagesWithheld;
        books.push({ book_root: root, status: 'committed', pages: pages.length });
      } catch (error) {
        entry.unavailable = (error as Error).message;
        entry.unavailable_class = sharedFailureClass(entry.unavailable);
        unavailable.push({ book: root, reason: entry.unavailable });
      }
      finally { exitBookLock(lock); }
    }
    const store = path.join(workspace, 'internal', 'book-manifests', collection);
    fs.mkdirSync(store, { recursive: true });
    for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SLUG.test(entry.name) || listed.includes(entry.name)) continue;
      const lock = enterBookLock(workspace, `${collection}/${entry.name}`);
      try { removeBookManifestStore(workspace, entry.name, collection); } finally { exitBookLock(lock); }
    }
    writeAtomicText(path.join(store, '_roster.json'), JSON.stringify({ schema: 1, generated_utc: utcRoundTrip(), books: roster, ...(collection === 'shared' && upkeepUnreadable ? { upkeep_unreadable: upkeepUnreadable } : {}) }, null, 2) + '\n');
  }
  return { status: 'rebuilt', books, committed: books.length, pages: books.reduce((sum, book) => sum + Number(book['pages']), 0), books_unavailable: unavailable, pages_withheld: withheld, ...(upkeepErrors.length ? { upkeep_unreadable: upkeepErrors } : {}) };
}
