/**
 * `library shelf duplicates`: tools/Find-ShelfDuplicateTopics.ps1, step for step (S41).
 *
 * JUDGED AGAINST A STAND-IN, NEVER A READER'S SERVER (the reader's ruling). The matrix row runs both arms
 * against tools/AcceptanceEmbeddingStandIn.mjs, whose vectors are integer word counts: exact in every
 * parser, so what the row compares is each implementation's own arithmetic, order and rounding.
 *
 * WHAT WAS MEASURED BEFORE IT WAS WRITTEN (S41), by the oracle's own run over a scratch Shelf:
 *
 * - `Get-ChildItem -Directory` gives the Shelf's Books in the filesystem's order (`alpha`, `Bravo`,
 *   `charlie`), and `Get-ChildItem -Recurse` lists a directory's OWN files before it descends into any
 *   subdirectory: `beta/_index.md` before `beta/0sub/_index.md`, which a sorted walk would reverse.
 * - Pairs of equal similarity keep the order they were generated in (three ties at 1, of thirteen pairs).
 *   `Sort-Object` is not documented as stable in Windows PowerShell; with more than sixteen pairs .NET's
 *   sort stops being an insertion sort, and ties past that are unmeasured. This port is stable.
 * - `[Math]::Round(x, 4)` is .NET Framework's: scaled by 10^4, then rounded half to EVEN, then scaled back.
 *
 * WHAT IS CONCEDED: `Get-ChildItem` without `-Force` skips hidden and system entries, which Node cannot
 * see; a transport failure's sentence is the runtime's own, and no row reaches one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import type { PsJsonValue } from './psjson.ts';
import { requireWorkspace } from './workspace.ts';
import { readStrictUtf8 } from './notebook.ts';

class DuplicatesRefusal extends Error {}

function refuse(message: string): never {
  throw new DuplicatesRefusal(message);
}

const EXCERPT_LENGTH = 1800;

interface Topic {
  book: string;
  topic: string;
  path: string;
  excerpt: string;
}

/** `Get-ChildItem -LiteralPath <dir> -File -Recurse -Filter '_index.md'`: a directory's own files, then its subdirectories. */
function indexFilesBelow(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase() === '_index.md') found.push(path.join(directory, entry.name));
  for (const entry of entries) if (entry.isDirectory()) found.push(...indexFilesBelow(path.join(directory, entry.name)));
  return found;
}

/** `Get-TopicExcerpt`: the whole text, strictly decoded, cut at 1800 UTF-16 units. */
function excerpt(file: string): string {
  const text = readStrictUtf8(file);
  return text.length > EXCERPT_LENGTH ? text.substring(0, EXCERPT_LENGTH) : text;
}

/** .NET Framework's `Math.Round(double)`: floor(a + 0.5), stepped back to even on an exact half. */
function roundHalfEven(value: number): number {
  let floor = Math.floor(value + 0.5);
  if (floor === value + 0.5 && floor % 2 !== 0) floor -= 1;
  return floor === 0 && value < 0 ? -0 : floor;
}

/** `[Math]::Round(value, 4)`, as .NET Framework computes it: scaled, rounded half to even, scaled back. */
function round4(value: number): number {
  if (Math.abs(value) >= 1e16) return value;
  return roundHalfEven(value * 10000) / 10000;
}

/** `Get-CosineSimilarity`, summed in the oracle's order. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k]! * b[k]!;
    normA += a[k]! * a[k]!;
    normB += b[k]! * b[k]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function numberOption(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) refuse(`library shelf duplicates --${name} must be a number; got '${value}'.`);
  return parsed;
}

export async function shelfDuplicates(argv: string[]): Promise<Record<string, PsJsonValue>> {
  const parsed = parseArguments(argv, ['workspace', 'embedding-url', 'embedding-model', 'api-key', 'similarity-threshold', 'batch-size']);
  const embeddingUrl = parsed.options.get('embedding-url') ?? process.env['TEI_EMBEDDING_URL'] ?? '';
  const embeddingModel = parsed.options.get('embedding-model') ?? 'tei-bge-small-en-v1-5';
  const apiKey = parsed.options.get('api-key') ?? process.env['TEI_API_KEY'] ?? '';
  const threshold = numberOption(parsed.options.get('similarity-threshold'), 0.85, 'similarity-threshold');
  const batchSize = Math.trunc(numberOption(parsed.options.get('batch-size'), 8, 'batch-size'));

  // THE ORACLE'S ORDER: the endpoint and the key before the workspace.
  if (embeddingUrl.trim().length === 0) {
    refuse(
      'No embedding endpoint. Pass -EmbeddingUrl <url>, or set $env:TEI_EMBEDDING_URL before running. There is deliberately no default: ' +
        'the address of your inference server is yours, and a value committed here would ship in every clone.',
    );
  }
  if (apiKey.trim().length === 0) {
    refuse('No embedding API key. Pass -ApiKey, or set $env:TEI_API_KEY before running. Never hardcode the key in this script or paste it into chat/logs.');
  }
  const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
  const shelfRoot = path.join(workspace, 'shelf');
  if (!fs.existsSync(shelfRoot) || !fs.statSync(shelfRoot).isDirectory()) refuse(`No Shelf found at ${shelfRoot}`);

  const bookDirs = fs.readdirSync(shelfRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const topics: Topic[] = [];
  for (const book of bookDirs) {
    const wikiRoot = path.join(shelfRoot, book, 'wiki');
    if (!fs.existsSync(wikiRoot) || !fs.statSync(wikiRoot).isDirectory()) continue;
    const bookMd = path.join(wikiRoot, '_book.md');
    if (fs.existsSync(bookMd) && fs.statSync(bookMd).isFile()) topics.push({ book, topic: '(whole book)', path: bookMd, excerpt: excerpt(bookMd) });
    for (const index of indexFilesBelow(wikiRoot)) {
      const parent = path.dirname(index);
      // `-ne`: a case-insensitive comparison of the two paths.
      if (parent.toLowerCase() === wikiRoot.toLowerCase()) continue;
      const relativeDir = parent.substring(wikiRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      topics.push({ book, topic: relativeDir, path: index, excerpt: excerpt(index) });
    }
  }
  if (topics.length === 0) refuse(`No topics found under ${shelfRoot} (no Book has a wiki/_book.md or a subfolder _index.md).`);

  const embeddings: number[][] = [];
  for (let i = 0; i < topics.length; i += batchSize) {
    const batch = topics.slice(i, i + Math.min(batchSize, topics.length - i));
    let response: unknown;
    try {
      const answer = await fetch(embeddingUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: batch.map((topic) => topic.excerpt), model: embeddingModel }),
      });
      if (!answer.ok) throw new Error(`The remote server returned an error: (${answer.status}) ${answer.statusText}.`);
      response = await answer.json();
    } catch (error) {
      refuse(`Embedding request failed against ${embeddingUrl} (topics ${i + 1}-${i + batch.length} of ${topics.length}): ${(error as Error).message}`);
    }
    const data = (response as { data?: unknown })?.data;
    for (const item of Array.isArray(data) ? data : data === undefined || data === null ? [] : [data]) {
      embeddings.push(((item as { embedding?: unknown[] }).embedding ?? []).map(Number));
    }
  }
  if (embeddings.length !== topics.length) refuse(`Embedding count mismatch: got ${embeddings.length}, expected ${topics.length}.`);

  const pairs: { similarity: number; book_a: string; topic_a: string; book_b: string; topic_b: string }[] = [];
  for (let x = 0; x < topics.length; x++) {
    for (let y = x + 1; y < topics.length; y++) {
      // `-eq`: case-insensitive. Only cross-Book overlap is the duplicate-topic concern.
      if (topics[x]!.book.toLowerCase() === topics[y]!.book.toLowerCase()) continue;
      const score = cosine(embeddings[x]!, embeddings[y]!);
      if (score >= threshold) {
        pairs.push({ similarity: round4(score), book_a: topics[x]!.book, topic_a: topics[x]!.topic, book_b: topics[y]!.book, topic_b: topics[y]!.topic });
      }
    }
  }
  // `Sort-Object -Property similarity -Descending`; Array.prototype.sort is stable, as the measured ties are.
  pairs.sort((left, right) => right.similarity - left.similarity);

  return {
    schema: 1,
    operation: 'Find candidate duplicate topics across the Shelf',
    embedding_url: embeddingUrl,
    embedding_model: embeddingModel,
    similarity_threshold: threshold,
    topics_scanned: topics.length,
    books_scanned: bookDirs,
    candidate_pairs: pairs,
    guidance:
      'A high score is a lead, not a verdict — read both topics before deciding anything. See docs/duplicate-topic-resolution.md for the ' +
      'survivorship rule and the canonical + stub pattern. This tool only reads the Shelf; it never writes.',
    shared_library_write: false,
  };
}
