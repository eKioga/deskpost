/**
 * `library compile <batch>` -- one source-attributed synthesis from ONE named raw batch, written as a
 * Notebook article. Ported from `tools/Compile-RawBatchToNotebook.ps1` (S17).
 *
 * IT DOES NOT SUMMARIZE ANYTHING. The Librarian supplies a finished Markdown synthesis and names the
 * exact source files it used; this validates and hashes those files, appends the `## Sources` block
 * generated from that manifest, and keeps the topic index and the derived master index linked. Only
 * the requested batch is ever read: `.`, `..` and an empty name are refused by shape, because they are
 * how a name becomes a scan of the whole raw tree.
 *
 * CREATING A NEW ARTICLE IS ADDITIVE AND APPLIES DIRECTLY. Replacing a divergent one can lose text, so
 * it needs `--replace-existing`, a preflight and the exact content-bound `--plan-id`. Every Notebook
 * path is journaled before it is touched and restored on failure; the master index is re-derived in
 * the rollback rather than restored, because it is not this operation's to snapshot.
 *
 * A NEW TOPIC IS STAGED OUTSIDE notebook/ AND PROMOTED BY ONE DIRECTORY MOVE inside the render lock, so
 * a killed run cannot leave a topic directory the renderer would meet with no index in it.
 *
 * THE ARTICLE LANDS IN THE SEAT'S OWN NOTEBOOK (ADR-0029, S18): `notebook/<seat>/<topic>/`, indexed by
 * `notebook/<seat>/_master-index.md`. No ownership row is written, because where a topic lives is now
 * whose it is. A legacy workspace is refused until it is migrated, a migrating one until the migration
 * completes, and a fresh one is activated by this write -- see `notebooklayout.ts`.
 *
 * WHAT THIS PORT DOES NOT CARRY, SAID RATHER THAN THINNED. The PowerShell arm captures an UPSTREAM PIN
 * for a source file that lies in a git repository: HEAD, its tracked remote ref, a status sample either
 * side of the read, and a bounded blobless fetch proving the commit is really on that remote. None of
 * that is here yet. A batch with NO repository compiles exactly as the oracle does, pin withheld with
 * the same reason; a source file that lies inside one is REFUSED BY NAME, pointing at the PowerShell
 * helper -- because withholding a pin the oracle would have captured is a thinner answer under the
 * same verb, and an article compiled that way would read `not anchored` for a reason that is not true.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { restoreBookJournal, writeBookJournal } from './journal.ts';
import { resolveRawBatch } from './rawsearch.ts';
import { resolveSeatName } from './seatdesk.ts';
import { assertSeatClaimHeld } from './seatclaim.ts';
import {
  invokeNotebookRender,
  invokeNotebookRenderAfterRollback,
  notebookTopicLockRoot,
  readStrictUtf8,
  scopeIndexDrift,
  topicHeadingFromText,
} from './notebook.ts';
import { notebookScope, prepareNotebookScopeForWrite, type NotebookScope } from './notebooklayout.ts';

export interface CompileResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

const GIT_FIELD_LENGTH_CAP = 512;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest('hex');
}

/** `[IO.File]::ReadAllText`: BOM-detecting UTF-8, lenient, BOM stripped. */
function readAllText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** A field a `## Sources` line can carry: no backtick, no semicolon, no control character, bounded. */
function testRecordableField(value: string): boolean {
  if (value.length === 0 || value.length > GIT_FIELD_LENGTH_CAP) return false;
  if (value.includes('`') || value.includes(';')) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/** The file line, byte for byte the spelling every published article already carries. */
function formatSourcesFileLine(source: { path: string; sha256: string; provenance: string }): string {
  for (const field of [source.path, source.provenance]) {
    if (!testRecordableField(field)) throw new Error(`A source field cannot be recorded in a ## Sources line: '${field}'.`);
  }
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) throw new Error(`A source hash must be 64 lowercase hex characters: '${source.sha256}'.`);
  return `- \`${source.path}\` - SHA-256 \`${source.sha256}\`; provenance: \`${source.provenance}\``;
}

function formatSourcesBlock(sources: { path: string; sha256: string; provenance: string }[]): string {
  const lines = sources.map(formatSourcesFileLine);
  if (!lines.length) throw new Error('A ## Sources block needs at least one source line.');
  return '## Sources\n\n' + lines.join('\n') + '\n';
}

/** `Add-IndexLink`: append one wikilink to a topic index unless it already names the target. */
function addIndexLink(existing: string, target: string, label: string): string {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\[\\[${escaped}(?:\\||\\]\\])`).test(existing)) return existing;
  const line = `- [[${target}|${label}]]\n`;
  if (!existing) return line;
  if (existing.endsWith('\r\n\r\n') || existing.endsWith('\n\n')) return existing + line;
  if (existing.endsWith('\r\n')) return existing + '\r\n' + line;
  if (existing.endsWith('\n')) return existing + '\n' + line;
  return existing + '\n\n' + line;
}

function isReparse(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether any segment from `root` down to `relative` is a reparse point. */
function crossesReparsePoint(root: string, relative: string): boolean {
  let cursor = root;
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    cursor = path.join(cursor, segment);
    if (isReparse(cursor)) return true;
  }
  return false;
}

function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase();
  const full = path.resolve(candidate).toLowerCase();
  return full === base || full.startsWith(base + path.sep);
}

/**
 * The first `.git` marker between a source file's directory and the batch root, or null. Discovery
 * walks the filesystem before any git runs -- the order the PowerShell arm's guard depends on.
 */
function findBatchRepository(batchRoot: string, sourceDirectory: string): string | null {
  const root = path.resolve(batchRoot).replace(/[\\/]+$/, '');
  let cursor = path.resolve(sourceDirectory).replace(/[\\/]+$/, '');
  if (!isInside(root, cursor)) return null;
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
    if (cursor.toLowerCase() === root.toLowerCase()) return null;
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor || !isInside(root, parent)) return null;
    cursor = parent;
  }
}

interface CompileRequest {
  workspace: string;
  batch: string;
  topic: string;
  topicTitle: string;
  topicOverview: string;
  articleSlug: string;
  contentPath: string;
  sourceFiles: string[];
  allowReplace: boolean;
  requirePin: boolean;
  allowHost: string[];
}

interface CompilationPlan {
  public: Record<string, PsJsonValue>;
  article: string;
  visibilityChanges: boolean;
  indexBefore: string;
  indexAfter: string;
  articlePath: string;
  indexPath: string;
  topicPath: string;
  digest: string;
}

function compilationPlan(request: CompileRequest, scope: NotebookScope): CompilationPlan {
  const { workspace, topic, topicTitle, topicOverview, articleSlug } = request;
  if (!SLUG.test(topic)) throw new Error('Topic must be a lowercase slug using letters, digits, and hyphens.');
  if (!SLUG.test(articleSlug)) throw new Error('ArticleSlug must be a lowercase slug using letters, digits, and hyphens.');
  if (!topicTitle.trim()) throw new Error('TopicTitle cannot be blank.');
  if (!topicOverview.trim()) throw new Error('TopicOverview cannot be blank.');
  if (/[\r\n|[\]]/.test(topicTitle)) throw new Error('TopicTitle must be one wikilink-safe line without brackets or a pipe.');
  if (/[\r\n]/.test(topicOverview)) throw new Error('TopicOverview must be one concise line.');
  if (!fs.existsSync(request.contentPath) || !fs.statSync(request.contentPath).isFile()) {
    throw new Error(`ContentPath is not a file: ${request.contentPath}`);
  }
  if (!request.sourceFiles.length) throw new Error('At least one -SourceFile is required.');

  const resolved = resolveRawBatch(workspace, request.batch);
  if (!resolved.recognised) throw new Error(`Raw batch '${request.batch}' was refused: ${resolved.reason}`);

  const draft = readStrictUtf8(request.contentPath);
  const heading = /^# ([^\r\n]+)(?:\r?\n|$)/.exec(draft);
  if (!heading || heading.index !== 0) throw new Error('The compiled article must begin with one H1 heading.');
  if (!/^## Key Takeaways\s*$/m.test(draft)) throw new Error('The compiled article must contain a ## Key Takeaways section.');
  if (/^## Sources\s*$/m.test(draft)) {
    throw new Error('Omit ## Sources from ContentPath; this helper generates it from the exact -SourceFile manifest.');
  }
  const articleTitle = heading[1]!.trim();
  if (/[|[\]]/.test(articleTitle)) {
    throw new Error('The article H1 must not contain brackets or a pipe, because it becomes an index link label.');
  }

  const seen = new Set<string>();
  const sources: { path: string; sha256: string; provenance: string }[] = [];
  const files: { rawPath: string; full: string }[] = [];
  for (const named of request.sourceFiles) {
    const relative = named.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
    const segments = relative.split('/');
    if (!relative.trim() || path.isAbsolute(relative) || segments.includes('.') || segments.includes('..')) {
      throw new Error(`SourceFile '${named}' must be a plain path relative to the named raw batch.`);
    }
    if (segments.includes('') || relative.includes(':')) {
      throw new Error(`SourceFile '${named}' must not contain empty path segments, drive syntax, or alternate data streams.`);
    }
    if (relative.includes('`') || /[\r\n]/.test(relative)) {
      throw new Error(`SourceFile '${named}' contains characters that cannot be rendered safely in the provenance block.`);
    }
    if (seen.has(relative.toLowerCase())) continue;
    seen.add(relative.toLowerCase());
    const full = path.resolve(resolved.full, ...segments);
    if (!isInside(resolved.full, full) || path.resolve(resolved.full).toLowerCase() === full.toLowerCase()) {
      throw new Error(`SourceFile '${relative}' does not resolve inside raw/${resolved.batch}.`);
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`SourceFile '${relative}' is not a file in raw/${resolved.batch}.`);
    if (crossesReparsePoint(resolved.full, relative)) {
      throw new Error(`SourceFile '${relative}' crosses a reparse point; raw compilation never follows one.`);
    }
    const rawPath = `raw/${resolved.batch}/${relative}`;
    sources.push({ path: rawPath, sha256: '', provenance: resolved.provenance });
    files.push({ rawPath, full });
  }

  // REPOSITORY CONTEXT, SAMPLED BEFORE THE BYTES ARE READ. One answer per source directory, as the
  // oracle keys it. A repository found is the pin path this port does not carry: refused by name.
  const withheld: Record<string, PsJsonValue>[] = [];
  const directories: string[] = [];
  for (const file of files) {
    const directory = path.dirname(file.full);
    if (directories.includes(directory)) continue;
    directories.push(directory);
    const repository = findBatchRepository(resolved.full, directory);
    if (repository !== null) {
      throw new Error(
        `${file.rawPath} lies in a git repository at ${repository}, and compiling it means capturing an upstream pin -- ` +
          'HEAD, its tracked remote ref, and a bounded fetch proving that commit is on the remote -- which this kernel ' +
          'does not carry yet. Compile this batch with tools/Compile-RawBatchToNotebook.ps1; withholding the pin here ' +
          'would record the article as unanchored for a reason that is not true.',
      );
    }
    withheld.push({ scope: directory, reason: 'no git repository lies between the source file and the batch root' });
  }
  for (const file of files) {
    sources.find((source) => source.path === file.rawPath)!.sha256 = sha256Hex(fs.readFileSync(file.full));
  }
  if (request.requirePin && withheld.length) {
    throw new Error('RequirePin was set but a pin was withheld: ' + withheld.map((row) => `${String(row['scope'])}: ${String(row['reason'])}`).join('; '));
  }

  const article = draft.replace(/[\r\n]+$/, '') + '\n\n' + formatSourcesBlock(sources);

  const notebook = path.join(workspace, 'notebook');
  if (!fs.existsSync(notebook) || !fs.statSync(notebook).isDirectory()) throw new Error(`Notebook directory not found: ${notebook}`);
  const topicPath = path.join(scope.root, topic);
  const indexPath = path.join(topicPath, '_index.md');
  const articlePath = path.join(topicPath, `${articleSlug}.md`);
  const topicExists = fs.existsSync(topicPath) && fs.statSync(topicPath).isDirectory();
  if (topicExists && !(fs.existsSync(indexPath) && fs.statSync(indexPath).isFile())) {
    throw new Error(
      `${scope.relative}/${topic} exists with no _index.md. Repair or remove that directory before compiling into it; a topic with no index cannot be rendered into the Notebook master index.`,
    );
  }
  const indexBefore = fs.existsSync(indexPath) ? readAllText(indexPath) : '';
  const articleBefore = fs.existsSync(articlePath) ? readAllText(articlePath) : null;
  const indexBase = indexBefore ? indexBefore : `# ${topicTitle}\n\n${topicOverview.trim()}\n\n## Articles\n\n`;
  const indexAfter = addIndexLink(indexBase, articleSlug, articleTitle);
  const headingBefore = indexBefore ? topicHeadingFromText(indexBefore) : '';
  const headingAfter = topicHeadingFromText(indexAfter);
  const visibilityChanges = !topicExists || headingBefore !== headingAfter;
  const masterDrift = scopeIndexDrift(scope);
  const articleHash = sha256Hex(article);
  const existingHash = articleBefore === null ? '' : sha256Hex(articleBefore);
  const articleExists = articleBefore !== null;
  const articleUnchanged = articleExists && existingHash === articleHash;
  if (articleExists && !articleUnchanged && !request.allowReplace) {
    throw new Error(
      `Notebook article ${scope.relative}/${topic}/${articleSlug}.md already exists with different content. Use -ReplaceExisting and preflight the replacement.`,
    );
  }

  // THE PLAN BINDS THE CONTENT: every field an approval is FOR, so a replacement approved against one
  // draft can never execute against another.
  const digest = sha256Hex(
    JSON.stringify({
      schema: 1,
      operation: 'compile-raw-batch-to-notebook',
      batch: resolved.batch,
      batch_provenance: resolved.provenance,
      topic,
      topic_title: topicTitle,
      topic_overview: topicOverview,
      article_slug: articleSlug,
      article_sha256: articleHash,
      prior_article_sha256: existingHash,
      topic_exists: topicExists,
      topic_heading_after: headingAfter,
      index_before_sha256: sha256Hex(indexBefore),
      index_after_sha256: sha256Hex(indexAfter),
      sources,
      upstreams: [],
      allow_host: [...request.allowHost].sort(),
    }),
  );

  return {
    public: {
      schema: 1,
      operation: 'Compile raw batch to Notebook',
      status: articleUnchanged && indexBefore === indexAfter && !masterDrift.length ? 'unchanged' : 'ready',
      batch: resolved.batch,
      batch_provenance: resolved.provenance,
      source_count: sources.length,
      sources,
      upstreams: [],
      pins_withheld: withheld,
      article_title: articleTitle,
      article_path: `${scope.relative}/${topic}/${articleSlug}.md`,
      topic_index_path: `${scope.relative}/${topic}/_index.md`,
      master_index_path: `${scope.relative}/_master-index.md`,
      topic_is_new: !topicExists,
      takes_render_lock: visibilityChanges || masterDrift.length > 0,
      master_index_drift: masterDrift,
      article_exists: articleExists,
      article_unchanged: articleUnchanged,
      replacement: articleExists && !articleUnchanged,
      confirmation_required: articleExists && !articleUnchanged,
      plan_id: `compile-raw-${digest}`,
      shared_library_write: false,
      next: 'Use this article path as source_path in Invoke-LibraryTriage.ps1, or pass its topic to Publish-BookCopy.ps1 / Copy-LocalPagesToProject.ps1.',
    },
    article,
    visibilityChanges,
    indexBefore,
    indexAfter,
    articlePath,
    indexPath,
    topicPath,
    digest,
  };
}

function readbackMatches(file: string, text: string): boolean {
  return sha256Hex(readAllText(file)) === sha256Hex(text);
}

function compileVerb(workspace: string, argv: string[]): PsJsonValue {
  const parsed = parseArguments(argv, [
    'topic', 'topic-title', 'topic-overview', 'article-slug', 'content-path', 'source-file', 'seat', 'allow-host', 'plan-id', 'workspace',
  ]);
  const batch = parsed.positional[0] ?? '';
  const contentPath = parsed.options.get('content-path') ?? '';
  if (!contentPath || !fs.existsSync(contentPath)) {
    throw new Error(`Cannot find path '${path.resolve(contentPath)}' because it does not exist.`);
  }
  const request: CompileRequest = {
    workspace,
    batch,
    topic: parsed.options.get('topic') ?? '',
    topicTitle: parsed.options.get('topic-title') ?? '',
    topicOverview: parsed.options.get('topic-overview') ?? '',
    articleSlug: parsed.options.get('article-slug') ?? '',
    contentPath: path.resolve(contentPath),
    sourceFiles: (parsed.options.get('source-file') ?? '').split(',').map((item) => item.trim()).filter((item) => item),
    allowReplace: parsed.flags.has('replace-existing'),
    requirePin: parsed.flags.has('require-pin'),
    allowHost: (parsed.options.get('allow-host') ?? '').split(',').map((item) => item.trim()).filter((item) => item),
  };
  const approvedPlanId = parsed.options.get('plan-id') ?? '';
  const stateDirectory = path.join(workspace, '.claude');

  // THE SEAT DECIDES WHICH NOTEBOOK, so it is resolved before the plan rather than only before the
  // write. A preflight of a write this workspace would refuse is refused too: a plan for an operation
  // certain to fail is worse than no plan.
  const namedSeat = resolveSeatName({ seat: parsed.options.get('seat'), stateDirectory });
  const scope = notebookScope(workspace, namedSeat.status === 'named' ? namedSeat.seat! : null, 'write', 'Compiling into the Notebook');
  const preview = compilationPlan(request, scope);
  if (parsed.flags.has('preflight')) return preview.public;

  // A NOTEBOOK WRITE IS A MUTATION AND NEEDS THIS SEAT'S LIVE CLAIM.
  if (namedSeat.status !== 'named') throw new Error(namedSeat.message);
  const seat = namedSeat.seat!;
  assertSeatClaimHeld({ workspace, stateDirectory, seat });
  if (preview.public['confirmation_required'] === true && !approvedPlanId) {
    throw new Error('Replacement requires -Preflight, one approval, then -UserConfirmed with the exact -ApprovedPlanId.');
  }

  let journalPath: string | null = null;
  const topicExisted = fs.existsSync(preview.topicPath) && fs.statSync(preview.topicPath).isDirectory();
  const lock = enterBookLock(workspace, notebookTopicLockRoot(request.topic, scope.relative));
  try {
    try {
      const current = compilationPlan(request, scope);
      if (current.public['confirmation_required'] === true && approvedPlanId !== current.public['plan_id']) {
        throw new Error(`Approved plan_id does not match current content. Re-run -Preflight and approve exactly ${String(current.public['plan_id'])}.`);
      }
      if (current.public['status'] === 'unchanged') return current.public;

      // ACTIVATED HERE, at the first write, when the workspace is fresh: the layout record, then the root.
      prepareNotebookScopeForWrite(scope, 'Compiling into the Notebook');

      // THE AUTHORITY ONLY: the article and this topic's own index. Never the master index.
      journalPath = writeBookJournal({
        workspace,
        bookRoot: `${scope.relative}/${request.topic}`,
        operation: 'compile-raw-batch-to-notebook',
        operationDigest: current.digest,
        paths: [current.articlePath, current.indexPath],
      }).journalPath;

      let rendered = false;
      if (current.public['topic_is_new'] === true) {
        const stagingRoot = path.join(workspace, 'internal', 'notebook-staging');
        const staging = path.join(stagingRoot, randomUUID().replace(/-/g, ''));
        fs.mkdirSync(staging, { recursive: true });
        try {
          const stagedArticle = path.join(staging, path.basename(current.articlePath));
          const stagedIndex = path.join(staging, '_index.md');
          writeAtomicText(stagedArticle, current.article);
          writeAtomicText(stagedIndex, current.indexAfter);
          if (!readbackMatches(stagedArticle, current.article)) throw new Error('Staged Notebook article failed readback verification; nothing was promoted.');
          if (!readbackMatches(stagedIndex, current.indexAfter)) throw new Error('Staged topic index failed readback verification; nothing was promoted.');
          // THE CRITICAL SECTION: one directory move, the scan, the write, the readback.
          invokeNotebookRender(scope, () => {
            if (fs.existsSync(current.topicPath)) {
              throw new Error(`${scope.relative}/${request.topic} appeared while this compile was staging; nothing was promoted.`);
            }
            fs.renameSync(staging, current.topicPath);
            return null;
          });
          rendered = true;
        } finally {
          if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
          if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) fs.rmdirSync(stagingRoot);
        }
      } else {
        // CREATE-ONLY for a new article: an atomic replace would overwrite a file that appeared since
        // the plan was re-derived, and the topic lock excludes Library writers, not every process.
        if (current.public['article_exists'] !== true) fs.writeFileSync(current.articlePath, current.article, { encoding: 'utf8', flag: 'wx' });
        else if (current.public['article_unchanged'] !== true) writeAtomicText(current.articlePath, current.article);
        if (current.indexBefore !== current.indexAfter) writeAtomicText(current.indexPath, current.indexAfter);
        if (!readbackMatches(current.articlePath, current.article)) throw new Error('Notebook article failed readback verification.');
        if (!readbackMatches(current.indexPath, current.indexAfter)) throw new Error('Topic index failed readback verification.');
        if (current.public['takes_render_lock'] === true) {
          invokeNotebookRender(scope);
          rendered = true;
        }
      }

      return { ...current.public, status: 'complete', journal_path: journalPath, master_index_rendered: rendered };
    } catch (error) {
      const failure = (error as Error).message;
      if (journalPath !== null) {
        try {
          restoreBookJournal(journalPath);
          if (!topicExisted && fs.existsSync(preview.topicPath) && fs.readdirSync(preview.topicPath).length === 0) {
            fs.rmdirSync(preview.topicPath);
          }
          // LAST, AND ONLY NOW: the topics on disk are the authority and they are back.
          invokeNotebookRenderAfterRollback(scope);
        } catch (rollback) {
          throw new Error(`${failure} Rollback also failed: ${(rollback as Error).message}`);
        }
      }
      throw error;
    }
  } finally {
    exitBookLock(lock);
  }
}

export function runCompileVerb(argv: string[], workspace: string): CompileResult {
  try {
    return { refusal: null, value: compileVerb(workspace, argv) };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
