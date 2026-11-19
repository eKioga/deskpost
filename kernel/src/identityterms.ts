/** Shared identity matching and deployment terms for the kernel and source tooling. */
import fs from 'node:fs';
import path from 'node:path';

export interface IdentityHit { source: string; line: number; kind: 'identity'; match: string }

export const lineAt = (text: string, at: number) => 1 + (text.slice(0, at).match(/\n/g) ?? []).length;
export function occurrences(text: string, term: string): number[] {
  // Case folding per character preserves UTF-16 positions (a full Unicode lower-case can grow).
  const fold = (s: string) => s.replace(/[\s\S]/g, ch => { const upper = ch.toUpperCase(); return upper.length === 1 ? upper : ch; });
  const source = fold(text), needle = fold(term), found: number[] = [];
  if (!needle) return found;
  for (let start = 0; start <= source.length;) {
    const at = source.indexOf(needle, start); if (at < 0) break;
    found.push(at); start = at + 1;
  }
  return found;
}
export function identityHits(sources: { source: string; text: string }[], deny: string[], allow: string[]): IdentityHit[] {
  const hits: IdentityHit[] = [];
  for (const entry of sources) {
    const spans = allow.filter(t => t.trim()).flatMap(term => occurrences(entry.text, term).map(start => ({ start, end: start + term.length })));
    for (const term of deny.filter(t => t.trim())) for (const at of occurrences(entry.text, term)) {
      if (!spans.some(span => span.start <= at && span.end >= at + term.length)) hits.push({ source: entry.source, line: lineAt(entry.text, at), kind: 'identity', match: term });
    }
  }
  return hits;
}

export function deploymentDenylist(root: string): string[] {
  const values: string[] = [];
  for (const name of ['.library-mcp-url', '.library-project', '.library-shared-root']) {
    let value = ''; try { value = fs.readFileSync(path.join(root, '.claude', name), 'utf8').replace(/^\uFEFF/, '').trim(); } catch { continue; }
    if (!value) continue;
    values.push(value); const host = /^https?:\/\/([^/:\s]+)/.exec(value)?.[1]; if (host) values.push(host);
  } return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
