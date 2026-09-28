/**
 * The Local collection's catalogs and frontmatter, as plain files (PLAN-basic-memory.md step 1, B0).
 *
 * THE LOCAL BRANCH IS A FILE WRITER. Publish, refresh and archive into `collection/` open no MCP session and touch
 * neither the ownership fence nor a Basic Memory collection id; what Basic Memory did for them -- frontmatter
 * written from metadata, a catalog line placed by `edit_note find_replace` -- is done here on the text itself.
 *
 * A CATALOG HEADING IS INSERTED ON DEMAND, never refused (Fable #3, round 2). A fresh local Books catalog carries
 * `## Open a Book` only; `## Projects`, `## Reference`, `## Workflows`, an archive's `## Archived Books` and an
 * import's own headings are each added the first time a line needs them. A missing catalog is created from its
 * template, then merged into.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { writeAtomicText } from './fsx.ts';
import { readUtf8 } from './shelfbook.ts';

// --- frontmatter ------------------------------------------------------------------------------------------

/** A scalar as YAML says it: bare when it is plainly a word, a path, a hash or a number; quoted otherwise. */
function yamlScalar(value: PsJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(text) ? text : JSON.stringify(text);
}

/** A frontmatter block, keys in the order given, ending with the closing `---` and one newline. */
export function composeFrontmatter(entries: Record<string, PsJsonValue>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}: ${yamlScalar(value)}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

/** A page's leading frontmatter and the rest, split: `null` frontmatter when the page opens with none. */
export function splitLocalFrontmatter(text: string): { fields: Map<string, string> | null; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: null, body: text };
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    let value = pair[2]!.trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        /* a value that only looks quoted is kept as written */
      }
    } else if (/^'.*'$/.test(value)) {
      value = value.substring(1, value.length - 1).replace(/''/g, "'");
    }
    // `@{}` in the oracle: case-insensitive keys, the last one read winning.
    fields.set(pair[1]!.toLowerCase(), value);
  }
  return { fields, body: text.substring(match[0].length) };
}

/** `Get-PublicationState` over a local page: `publication_state`, or the pilot's `guild_state` spellings. */
export function localPublicationState(fields: Map<string, string> | null): string | null {
  if (fields === null) return null;
  const state = fields.get('publication_state');
  if (state !== undefined && state.trim()) return state;
  switch ((fields.get('guild_state') ?? '').toLowerCase()) {
    case 'incomplete-candidate':
      return 'copying';
    case 'candidate':
      return 'complete';
    default:
      return null;
  }
}

// --- catalogs ---------------------------------------------------------------------------------------------

export const LOCAL_BOOKS_CATALOG_TEXT = "# Books\n\nThe Books in this workspace's local collection.\n\n## Open a Book\n";
export const LOCAL_ARCHIVE_CATALOG_TEXT = '# Archive\n\nInactive Books remain available here when you need them again.\n\n## Archived Books\n';
export const LOCAL_PROJECTS_CATALOG_TEXT =
  "# Active Projects\n\nProjects are living context in this workspace's local collection. Open one when you need its current notes.\n\n## Projects\n";
export const LOCAL_ARCHIVED_PROJECTS_CATALOG_TEXT =
  '# Archived Projects\n\nProjects retired from the active catalog. An archived Hub stays searchable.\n\n## Projects\n';

/** A catalog's text, or its template when the file is not there yet. */
export function readCatalogOrTemplate(file: string, template: string): { text: string; existed: boolean } {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return { text: readUtf8(file), existed: true };
  return { text: template, existed: false };
}

/** The line indexes that ARE this heading, trailing space aside. */
function headingLines(lines: string[], heading: string): number[] {
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (line.trimEnd() === heading) found.push(index);
  });
  return found;
}

/**
 * The catalog with `heading` present exactly once: unchanged when it is already there, inserted when it is not --
 * before `beforeHeading` when that is present, at the end otherwise. Twice is a refusal, as Basic Memory's
 * `expected_replacements: 1` refuses it: a line placed under one of two identical headings is a guess.
 */
/** The line ending a catalog already uses, so an edit changes only the lines it adds (S53 post-build inspection #7). */
function endingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function ensureHeading(text: string, heading: string, beforeHeading: string | null): { text: string; inserted: boolean } {
  const eol = endingOf(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const present = headingLines(lines, heading);
  if (present.length > 1) throw new Error(`The catalog carries '${heading}' ${present.length} times; it will not guess which one a line belongs under.`);
  if (present.length === 1) return { text, inserted: false };
  const before = beforeHeading === null ? [] : headingLines(lines, beforeHeading);
  if (before.length === 1) {
    lines.splice(before[0]!, 0, heading, '');
    return { text: lines.join(eol), inserted: true };
  }
  const trimmed = text.replace(/\s+$/, '');
  return { text: `${trimmed}${eol}${eol}${heading}${eol}`, inserted: true };
}

/** One entry line put directly under its heading, the heading's other lines kept below it. */
export function insertUnderHeading(text: string, heading: string, entry: string): string {
  const eol = endingOf(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = headingLines(lines, heading);
  if (at.length !== 1) throw new Error(`The catalog carries '${heading}' ${at.length} times; exactly one is needed to place a line under it.`);
  lines.splice(at[0]! + 1, 0, '', entry);
  // `## H`, '', entry, and then what was under the heading -- whose own leading blank line stays as the separator.
  return lines.join(eol);
}

/** Every line carrying one of these link targets, with the `## ` heading it sits under. */
export function ownedLines(text: string, targets: string[]): { index: number; line: string; heading: string | null }[] {
  let heading: string | null = null;
  const owned: { index: number; line: string; heading: string | null }[] = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    if (/^##\s+\S/.test(line)) heading = line.trimEnd();
    else if (targets.some((target) => line.toLowerCase().includes(`[[${target.toLowerCase()}|`))) owned.push({ index, line, heading });
  });
  return owned;
}

/** The catalog with one line removed, by its index. */
export function withoutLine(text: string, index: number): string {
  const eol = endingOf(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.splice(index, 1);
  return lines.join(eol);
}

/** Written whole and read back, as every other local write is. */
export function writeCatalog(file: string, text: string): string {
  const normalised = text.endsWith('\n') ? text : text + '\n';
  writeAtomicText(file, normalised);
  const back = readUtf8(file);
  if (back !== normalised) throw new Error(`The catalog ${path.basename(path.dirname(file))}/${path.basename(file)} did not read back as written.`);
  return back;
}
