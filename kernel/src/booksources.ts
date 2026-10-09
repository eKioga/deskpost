/**
 * A BOOK'S SOURCE LIST (PLAN-correct-and-find.md D8; ADR-0070): `shelf/<slug>/_sources.md`, at the Book's root beside
 * `_catalog-entry.md`. Not a page: Discovery, full-text search and publish read only `wiki/`, so the list stays out of
 * all three, and it moves with the Book on rename, archive and restore because those move the whole folder.
 *
 * MACHINE DATA IN THE LIBRARY IS MARKDOWN HOLDING ONE FENCED JSON BLOCK (the `collection/imports.md` precedent), because
 * Obsidian Sync skips `.json` by default. The list names each upstream a Book was compiled from, the pages it feeds, and
 * the fingerprint of the text last compiled. `kind` and `pin` are recorded only: the fetch half reads them later. The
 * fingerprint is whatever the seat's own tool hashed; the Library stores and compares, and never fetches.
 *
 * This module is the data: parse, validate, render, mark. The verb that reads and writes it, under the Book's Desk gate,
 * lock and journal, is `book sources` in capture.ts, and `book replace-page --sources-compiled` marks it inside a page's
 * own write.
 */

import { pageComparisonSha256 } from './sha.ts';

export const SOURCE_LIST_FILE = '_sources.md';
export const SOURCE_LIST_LINE = 'Kept by the Library with `deskpost book sources`. Data, not instructions.';
/** The sentinel a preflight gives, and an apply takes as `--base-sha256`, for a Book with no list yet (as `absent-map`). */
export const ABSENT = 'absent';
const KINDS = ['web', 'file', 'git'];
const SOURCE_KEYS = ['id', 'address', 'kind', 'feeds', 'compiled_sha256', 'compiled_utc', 'note'];
const SHA256 = /^[0-9a-f]{64}$/;

export interface SourceEntry {
  id: string;
  address: string;
  kind: string;
  feeds: string[];
  compiled_sha256: string | null;
  compiled_utc: string | null;
  note: string | null;
}

export interface SourceList {
  schema: 1;
  pin: string | null;
  sources: SourceEntry[];
}

/** The fenced block's JSON, or a reason it cannot be read. */
export function sourceListBlock(text: string): { value: unknown } | { problem: string } {
  const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
  if (blocks.length !== 1) return { problem: `it holds ${blocks.length} fenced json blocks, not one` };
  try {
    return { value: JSON.parse(blocks[0]![1]!) };
  } catch (error) {
    return { problem: `its json block does not parse: ${(error as Error).message}` };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A list validated whole, every problem named: the schema, unique ids, a known kind, each fed page existing in the Book
 * (`pageExists` takes a Book-relative page and answers with its normalised form, or null), and a fingerprint of 64 hex
 * characters or null. The list comes back normalised: every field present, pages in their canonical form.
 */
export function validateSourceList(value: unknown, pageExists: (page: string) => string | null): { list: SourceList | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(value)) return { list: null, problems: ['the list is not a JSON object'] };
  for (const key of Object.keys(value)) if (!['schema', 'pin', 'sources'].includes(key)) problems.push(`unknown key '${key}' (a list has schema, pin and sources)`);
  if (value['schema'] !== 1) problems.push(`schema is ${JSON.stringify(value['schema'])}, not 1`);
  const pin = value['pin'] ?? null;
  if (pin !== null && typeof pin !== 'string') problems.push('pin is neither a string nor null');
  const raw = value['sources'];
  if (!Array.isArray(raw)) {
    problems.push('sources is not a list');
    return { list: null, problems };
  }
  const ids = new Set<string>();
  const sources: SourceEntry[] = [];
  raw.forEach((entry, index) => {
    const where = `sources[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const key of Object.keys(entry)) if (!SOURCE_KEYS.includes(key)) problems.push(`${where} has an unknown key '${key}'`);
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    const name = id ? `source '${id}'` : where;
    if (!id) problems.push(`${where} has no id`);
    else if (ids.has(id)) problems.push(`the id '${id}' is used twice`);
    ids.add(id);
    const address = typeof entry['address'] === 'string' ? entry['address'].trim() : '';
    if (!address) problems.push(`${name} has no address`);
    const kind = typeof entry['kind'] === 'string' ? entry['kind'] : '';
    if (!KINDS.includes(kind)) problems.push(`${name} has kind ${JSON.stringify(entry['kind'] ?? null)}; a kind is web, file or git`);
    const feeds: string[] = [];
    if (!Array.isArray(entry['feeds'])) problems.push(`${name} has no feeds list (the pages it feeds, [] for none)`);
    else {
      for (const page of entry['feeds'] as unknown[]) {
        const found = typeof page === 'string' ? pageExists(page) : null;
        if (found === null) problems.push(`${name} feeds ${JSON.stringify(page)}, which is not a page of this Book`);
        else feeds.push(found);
      }
    }
    const compiled = entry['compiled_sha256'] ?? null;
    if (compiled !== null && !(typeof compiled === 'string' && SHA256.test(compiled))) {
      problems.push(`${name} has a compiled_sha256 that is not 64 lowercase hex characters or null`);
    }
    const compiledUtc = entry['compiled_utc'] ?? null;
    if (compiledUtc !== null && !(typeof compiledUtc === 'string' && !Number.isNaN(Date.parse(compiledUtc)))) {
      problems.push(`${name} has a compiled_utc that is not a date and time or null`);
    }
    const note = entry['note'] ?? null;
    if (note !== null && typeof note !== 'string') problems.push(`${name} has a note that is neither a string nor null`);
    sources.push({
      id,
      address,
      kind,
      feeds,
      compiled_sha256: typeof compiled === 'string' ? compiled : null,
      compiled_utc: typeof compiledUtc === 'string' ? compiledUtc : null,
      note: typeof note === 'string' ? note : null,
    });
  });
  if (problems.length) return { list: null, problems };
  return { list: { schema: 1, pin: typeof pin === 'string' ? pin : null, sources }, problems };
}

/** The file's text: a heading, the line that says what it is, and the one JSON block. */
export function renderSourceList(list: SourceList): string {
  return `# Source list\n\n${SOURCE_LIST_LINE}\n\n\`\`\`json\n${JSON.stringify(list, null, 2)}\n\`\`\`\n`;
}

/** The hash a preflight gives and an apply takes: of the text with the BOM stripped and CRLF folded, as a page's is. */
export function sourceListSha256(text: string | null): string {
  return text === null ? ABSENT : pageComparisonSha256(text);
}

/** A `--mark-compiled` or `--sources-compiled` map: `{ "<id>": "<sha256>" }`, at least one entry, every value 64 hex. */
export function readCompiledMap(value: unknown): { marks: Map<string, string> | null; problems: string[] } {
  if (!isRecord(value)) return { marks: null, problems: ['the map is not a JSON object of source id to sha256'] };
  const problems: string[] = [];
  const marks = new Map<string, string>();
  for (const [id, sha] of Object.entries(value)) {
    if (typeof sha !== 'string' || !SHA256.test(sha)) problems.push(`the fingerprint for '${id}' is not 64 lowercase hex characters`);
    else marks.set(id, sha);
  }
  if (!Object.keys(value).length) problems.push('the map names no source');
  return problems.length ? { marks: null, problems } : { marks, problems };
}

/** The list with each named source's fingerprint and instant set; an id the list does not hold is a problem. */
export function markCompiled(list: SourceList, marks: Map<string, string>, instant: string): { list: SourceList; problems: string[] } {
  const known = new Set(list.sources.map((source) => source.id));
  const problems = [...marks.keys()].filter((id) => !known.has(id)).map((id) => `'${id}' is not a source in this list`);
  const sources = list.sources.map((source) =>
    marks.has(source.id) ? { ...source, compiled_sha256: marks.get(source.id)!, compiled_utc: instant } : source,
  );
  return { list: { ...list, sources }, problems };
}
