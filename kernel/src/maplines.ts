/**
 * The lines a page writer adds to a reader map or a topic index, read and written one way for the Shelf and the local
 * collection alike (kickoffs/s101 row 3; PLAN-correct-and-find.md D3).
 *
 * A LINK COUNTS ONLY OUTSIDE FRONTMATTER AND FENCED CODE, and an index that ends inside a fence is refused rather than
 * appended to, because a line added there would render as code, not a link. ONE LINE AT THE END, the rest kept byte for
 * byte: appending removes no text, which is why a Shelf `book add-page` that gains a topic-index line stays ungated.
 */

export interface MapReading {
  /** The text OUTSIDE frontmatter and fenced code, where a link counts. */
  text: string;
  /** True when the map ends inside a fence, where an appended line would render as code. */
  unclosedFence: boolean;
}

export function readMap(content: string): MapReading {
  const withoutFront = content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of withoutFront.split(/\r?\n/)) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker) {
        fence = marker[1]!;
        continue;
      }
      kept.push(line);
    } else if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && line.trim() === marker[1]) {
      fence = null;
    }
  }
  return { text: kept.join('\n'), unclosedFence: fence !== null };
}

/**
 * Whether a map already links a page, in either form a Book's maps carry: `books/<slug>/wiki/<page>` (an imported
 * collection Book) or the bare Book-relative page (the Shelf, and a published topic index).
 */
export function mapLinksPage(reading: MapReading, slug: string, page: string): boolean {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targets = [`books/${slug}/wiki/${page}`, page].map(escaped).join('|');
  return new RegExp(`\\[\\[(?:${targets})(?:\\||\\]\\])`).test(reading.text);
}

/** The Shelf's end-of-file rule (capture.ts, addShelfBookIndexLink): the whole map kept, one line added at its end. */
export function mapWithLink(content: string, line: string): string {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = content.replace(/(?:\r?\n[ \t]*)+$/, '');
  if (!trimmed) return line + lineEnding;
  const lastLine = /[^\r\n]*$/.exec(trimmed)![0];
  const separator = /^-[ \t]/.test(lastLine) ? lineEnding : lineEnding + lineEnding;
  return trimmed + separator + line + lineEnding;
}

/** A page title as a link label: one line, and nothing that would end the link or split its label. */
export function linkLabel(title: string): string {
  return title.replace(/[\r\n]+/g, ' ').replace(/\]\]/g, '] ]').replace(/\|/g, '-');
}

/** The topic index beside a page: `<folder>/_index.md`, or null at the Book's top and for the topic index itself. */
export function topicIndexPage(page: string): string | null {
  if (!page.includes('/')) return null;
  const folder = page.substring(0, page.lastIndexOf('/'));
  return `${folder}/_index` === page ? null : `${folder}/_index`;
}

export interface TopicIndexPlan {
  /** `updated` when a line will be added, `already-listed` when the index already links the page. */
  status: 'updated' | 'already-listed';
  /** The index's new text, or null when it already lists the page. */
  newText: string | null;
}

/**
 * D3: the line a page added under a topic gains in that topic's index, `- [[<Book-relative page>|<label>]]`. An index
 * ending in an open fence is refused by the caller, which names its own file.
 */
export function planTopicIndexLine(content: string, slug: string, page: string, title: string): TopicIndexPlan | 'open-fence' {
  const reading = readMap(content);
  if (mapLinksPage(reading, slug, page)) return { status: 'already-listed', newText: null };
  if (reading.unclosedFence) return 'open-fence';
  return { status: 'updated', newText: mapWithLink(content, `- [[${page}|${linkLabel(title)}]]`) };
}

/** A page as a generated reader map lists it: its Book-relative path without `.md`, its label, and its text. */
export interface MapPage {
  page: string;
  label: string;
  text: string;
}

/** A topic index below a Book's top: `<folder>/_index`. */
function isTopicIndex(page: string): boolean {
  return page.includes('/') && page.endsWith('/_index');
}

function folderOf(page: string): string {
  return page.includes('/') ? page.substring(0, page.lastIndexOf('/')) : '';
}

/**
 * Whether a topic index reaches a page, by the reach rule `getUnlistedBookPages` reads (capture.ts): the index's text
 * holds `[[<Book-relative page>`. A published topic index keeps these Shelf-relative links, so publish reads it the same
 * way; an imported one's `books/<slug>/wiki/<page>` form counts as well.
 */
function topicReaches(indexText: string, page: string, slug: string | null): boolean {
  return indexText.includes(`[[${page}`) || (slug !== null && indexText.includes(`[[books/${slug}/wiki/${page}`));
}

/**
 * THE FOLDED READER MAP (PLAN-correct-and-find.md D4), one builder for `updateShelfBookIndex` and publish. Every page in
 * the order given, except that the pages a topic index reaches -- the index of the deepest topic folder holding the page,
 * one hop -- are replaced by ONE LINE for that index, where the folder's first page sorted, with the count inside the
 * label (`- [[sources/_index|Sources (59 pages)]]`), so the map still tests as generated. A topic index that reaches none
 * of its folder's pages is listed as any page is; a page its index does not reach stays on its own line, so nothing
 * becomes unreachable. Returns the lines after the `_book` line, and how many topic lines stand for pages.
 */
export function foldedMapLines(pages: MapPage[], target: (page: string) => string, slug: string | null = null): { lines: string[]; foldedTopics: number } {
  const topics = new Map<string, MapPage>();
  for (const entry of pages) if (isTopicIndex(entry.page)) topics.set(folderOf(entry.page), entry);
  const owner = (page: string): string | null => {
    for (let folder = folderOf(page); folder; folder = folderOf(folder)) if (topics.has(folder)) return folder;
    return null;
  };
  const folded = new Map<string, Set<string>>();
  for (const entry of pages) {
    if (isTopicIndex(entry.page)) continue;
    const folder = owner(entry.page);
    if (folder === null || !topicReaches(topics.get(folder)!.text, entry.page, slug)) continue;
    if (!folded.has(folder)) folded.set(folder, new Set());
    folded.get(folder)!.add(entry.page);
  }
  const anchors = new Map<number, string[]>();
  for (const folder of [...folded.keys()].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const first = pages.findIndex((entry) => entry.page.startsWith(`${folder}/`));
    if (!anchors.has(first)) anchors.set(first, []);
    anchors.get(first)!.push(folder);
  }
  const lines: string[] = [];
  pages.forEach((entry, index) => {
    for (const folder of anchors.get(index) ?? []) {
      const topic = topics.get(folder)!;
      const count = folded.get(folder)!.size;
      lines.push(`- [[${target(topic.page)}|${topic.label} (${count} ${count === 1 ? 'page' : 'pages'})]]`);
    }
    if (isTopicIndex(entry.page) && folded.has(folderOf(entry.page))) return;
    const folder = owner(entry.page);
    if (!isTopicIndex(entry.page) && folder !== null && folded.get(folder)?.has(entry.page)) return;
    lines.push(`- [[${target(entry.page)}|${entry.label}]]`);
  });
  return { lines, foldedTopics: folded.size };
}
