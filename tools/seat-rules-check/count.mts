/**
 * Counting for `tools/seat-rules-check.mts` (PLAN-start-and-prove.md, Approach 2, "Counting"; review SP-05 and SP-09).
 * Pure functions over a work folder's before and after copies and a session's final reply. Node built-ins only.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Relative path (forward slashes) to full content, for every file under `dir`. Links are not followed. */
export type Files = Record<string, string>;

export type FolderDiff = {
  created: string[];
  deleted: string[];
  changed: { path: string; added: number; removed: number }[];
  /** Lines added over changed and created files. */
  linesAdded: number;
  /** Lines removed over changed and deleted files. */
  linesRemoved: number;
};

export function snapshotFolder(dir: string): Files {
  const files: Files = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
      else if (entry.isFile()) files[relative] = fs.readFileSync(path.join(folder, entry.name), 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

function lines(text: string): string[] {
  if (text === '') return [];
  const split = text.split(/\r?\n/);
  if (split[split.length - 1] === '') split.pop();
  return split;
}

/** Longest common subsequence length over lines, two rows of memory after trimming the common ends. */
function commonLines(a: string[], b: string[]): number {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const same = start + (a.length - endA);
  const x = a.slice(start, endA), y = b.slice(start, endB);
  let previous = new Uint32Array(y.length + 1), current = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = x[i - 1] === y[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return same + previous[y.length]!;
}

export function diffFolders(before: Files, after: Files, options: { exclude?: string[] } = {}): FolderDiff {
  const excluded = new Set(options.exclude ?? []);
  const diff: FolderDiff = { created: [], deleted: [], changed: [], linesAdded: 0, linesRemoved: 0 };
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => !excluded.has(name)).sort();
  for (const name of names) {
    const was = before[name], now = after[name];
    if (was === undefined && now !== undefined) { diff.created.push(name); diff.linesAdded += lines(now).length; }
    else if (was !== undefined && now === undefined) { diff.deleted.push(name); diff.linesRemoved += lines(was).length; }
    else if (was !== undefined && now !== undefined && was !== now) {
      const a = lines(was), b = lines(now), common = commonLines(a, b);
      const entry = { path: name, added: b.length - common, removed: a.length - common };
      diff.changed.push(entry);
      diff.linesAdded += entry.added; diff.linesRemoved += entry.removed;
    }
  }
  return diff;
}

/** The reply without fenced code, inline code and URLs, which never hold a question to the reader. */
function prose(reply: string): string {
  let fence = '';
  const kept: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker) { fence = fence === '' ? marker[1]! : (fence === marker[1] ? '' : fence); kept.push(''); continue; }
    kept.push(fence === '' ? line : '');
  }
  return kept.join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ');
}

/** Sentences split at `.`, `!`, `?` and line ends; each one ending in `?` counts once. */
export function countQuestions(reply: string): number {
  let count = 0;
  for (const line of prose(reply).split(/\r?\n/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (/\?+$/.test(sentence.trim().replace(/[)"'*_\]]+$/, ''))) count += 1;
    }
  }
  return count;
}

/** `yes`, `no` or `unknown` as a whole word in the reply's last paragraph, or null. */
export function verdictWord(reply: string): string | null {
  const paragraphs = reply.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter((part) => part !== '');
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const match = /\b(yes|no|unknown)\b/i.exec(last);
  return match ? match[1]!.toLowerCase() : null;
}

export function wordCount(reply: string): number {
  return reply.split(/\s+/).filter((word) => word !== '').length;
}
