/**
 * A Project Hub's pages, measured (kickoffs/s125 rows 1-2; PLAN-tidy-redesign.md Part A items 1-2; ADR-0082).
 *
 * MEASURE, NEVER INFER. The Desk reports each page's size, its kind and its limit, read from the Hub's own files on
 * every call, so a client never has to infer a Hub's size from whatever `hub edit` output it happened to see (the
 * mod record every `/tidy` Report since 2026-10-04 traced to). Local collections only: a Basic Memory Library would
 * pay a network read per page per Desk call, so the Desk says `hub_pages: null` there.
 *
 * ONE COUNT FOR THE DESK AND THE VERB. `tickedEntries` is the selection `hub tidy` moves and the count the Desk shows,
 * through `hubedit.ts`'s own fence-aware `headings` and `topLevelEntries`, so a `- [x]` inside a fenced example, or a
 * `## Next` inside a fence, is neither counted nor moved.
 *
 * NO PAGE TEXT LEAVES. The scan returns names, sizes and counts only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { readMarker } from './workspace.ts';
import { itemBlocks, pageKind, pageLimitBytes, removeFrontmatter, sectionSpan, sizeExempt, toLines, topLevelEntries, utf8Length } from './hubedit.ts';

// The table and the kind rule live beside `pageSizeStatus` in hubedit.ts, so the two never import each other.
export { pageKind, pageLimitBytes } from './hubedit.ts';

/** A ticked top-level entry of `## Now` or `## Next`: its block's first and last line (0-based, inclusive). */
export interface TickedEntry {
  section: 'Now' | 'Next';
  start: number;
  end: number;
  line: string;
}

const TICKED = /^(?:[-*+]|[0-9]+\.)[ \t]+\[[xX]\](?:[ \t]+|$)/;

/**
 * Every ticked top-level entry in `## Now` and `## Next`, each with its whole block (nested lines and continuation
 * lines included, as `itemBlocks` holds them). Lines are the body's own, split as `hub edit` splits them. A heading that
 * appears twice refuses, in `hub edit`'s words.
 */
export function tickedEntries(body: string): TickedEntry[] {
  const lines = toLines(body);
  const found: TickedEntry[] = [];
  for (const section of ['Now', 'Next'] as const) {
    const span = sectionSpan(lines, section);
    if (span === null) continue;
    const blocks = itemBlocks(lines, span.start + 1, span.end);
    for (const entry of topLevelEntries(lines, span.start + 1, span.end)) {
      if (!TICKED.test(entry.line)) continue;
      const block = blocks.find((candidate) => candidate.start === entry.index) ?? { start: entry.index, end: entry.index };
      found.push({ section, start: block.start, end: block.end, line: entry.line });
    }
  }
  return found;
}

/** A page's body as `hub edit` measures it: the BOM and the front matter removed. */
export function hubPageBody(file: string): string {
  return removeFrontmatter(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** The Hub-relative page names (no `.md`) at the root and one level down, links skipped, in ordinal order. */
export function hubPageNames(hubRoot: string): string[] {
  const names: string[] = [];
  const isPage = (entry: fs.Dirent): boolean => entry.isFile() && entry.name.toLowerCase().endsWith('.md');
  for (const entry of fs.readdirSync(hubRoot, { withFileTypes: true })) {
    if (isPage(entry)) names.push(entry.name.substring(0, entry.name.length - 3));
    else if (entry.isDirectory()) {
      for (const inner of fs.readdirSync(path.join(hubRoot, entry.name), { withFileTypes: true })) {
        if (isPage(inner)) names.push(`${entry.name}/${inner.name.substring(0, inner.name.length - 3)}`);
      }
    }
  }
  return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The Desk's `hub_pages` (kickoffs/s125 row 2): for each `projects/<slug>` open at this seat, every non-exempt page's
 * `{ hub, page, kind, size_bytes, limit_bytes, over }`, and for `_project` its `ticked_now` and `ticked_next`. Null on a
 * shared backend. A page that cannot be read or counted is reported with what could be measured, never refused.
 */
export function hubPages(workspace: string, openProjects: string[]): PsJsonValue {
  const marker = readMarker(workspace);
  if (marker === null || String(marker['backend'] ?? '') !== 'local') return null;
  const rows: PsJsonValue[] = [];
  for (const entry of openProjects) {
    const match = /^projects\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(entry);
    if (!match) continue;
    const slug = match[1]!;
    const hubRoot = path.join(workspace, 'collection', 'projects', slug);
    let names: string[];
    try {
      if (fs.lstatSync(hubRoot).isSymbolicLink() || !fs.statSync(hubRoot).isDirectory()) continue;
      names = hubPageNames(hubRoot);
    } catch {
      continue;
    }
    for (const page of names) {
      if (sizeExempt(`${page}.md`)) continue;
      let body: string;
      try {
        body = hubPageBody(path.join(hubRoot, ...`${page}.md`.split('/')));
      } catch {
        continue;
      }
      const size = utf8Length(body);
      const limit = pageLimitBytes(page);
      const row: Record<string, PsJsonValue> = { hub: slug, page, kind: pageKind(page), size_bytes: size, limit_bytes: limit, over: size > limit };
      if (page === '_project') {
        try {
          const ticked = tickedEntries(body);
          row['ticked_now'] = ticked.filter((item) => item.section === 'Now').length;
          row['ticked_next'] = ticked.filter((item) => item.section === 'Next').length;
        } catch {
          row['ticked_now'] = null;
          row['ticked_next'] = null;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}
