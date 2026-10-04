/**
 * A Book page's LOCATION and its BODY, for every writer that adds a page (PLAN-local-collection-writers.md, 0.1-0.2).
 *
 * ONE GRAMMAR, NOT THREE. `capture.ts`, `triage.ts` and `shelfwriters.ts` each carried a byte-identical copy of
 * `convertToBookPagePath`, so a change to what a page may be called reached one writer and not the others. They
 * import this one.
 *
 * AN UNDERSCORE PAGE BELOW THE TOP LEVEL IS A PAGE (S67, Eric's Q3). Collection Books carry curated topic indexes --
 * `game-server-admin/_master-index`, `odysseus/architecture/_index` -- and a grammar that refused them made a Shelf
 * rebuild of such a Book silently drop them. What stays refused is the top level, where `_book` and `_index` are the
 * pages the writers DERIVE, and an underscore anywhere but the last segment. A topic index is never derived: it is
 * curated prose with sections, and regenerating it would destroy it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The error every refusal here throws; each caller already reports an Error's message as its refusal. */
export class PagePathRefusal extends Error {}

function refuse(message: string): never {
  throw new PagePathRefusal(message);
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const UNDERSCORE_PAGE = /^_[a-z0-9][a-z0-9-]*$/;

/**
 * A page path is a Book-relative LOCATION, never a filesystem path: no drive, no traversal, no absolute form.
 * Reserved names are checked first so they are refused for the accurate reason -- being told `_index is not
 * lowercase` would be true and useless.
 */
export function convertToBookPagePath(raw: string): string {
  let candidate = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!candidate) refuse('PagePath is required, for example rendering/shaders.');
  if (candidate.endsWith('.md')) candidate = candidate.substring(0, candidate.length - 3);
  const segments = candidate.split('/');
  const last = segments.length - 1;
  if (last === 0 && ['_book', '_index'].includes(segments[0]!)) {
    refuse('PagePath must not name the Book metadata page or the reader map.');
  }
  segments.forEach((segment, index) => {
    if (SEGMENT.test(segment)) return;
    if (index === last && UNDERSCORE_PAGE.test(segment)) {
      if (index > 0) return;
      refuse(
        `PagePath '${segment}' is an underscore name at the top of the Book, where the writers keep the pages they derive. ` +
          `A topic index goes below its folder, for example topic/${segment}.`,
      );
    }
    refuse(
      `PagePath segment '${segment}' must contain only lowercase letters, digits, and hyphens` +
        (index === last && index > 0 ? ', or be an underscore topic-index name such as _index' : '') +
        '.',
    );
  });
  return segments.join('/');
}

export interface RenderedPage {
  title: string;
  titleSource: string;
  body: string;
}

/** A leading frontmatter block, exactly as written, or '' when the text opens with none. */
function leadingFrontmatter(text: string): string {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[0] : '';
}

/**
 * The exact bytes a page write will store, and the title it will carry. The body's own H1 names the page; `title`
 * is needed only when there is none.
 *
 * FRONTMATTER STAYS ON TOP (S67, R1 defect 3). A page imported from Basic Memory opens with `---` and its `title`,
 * `type` and `permalink`; until S67 its H1 was looked for only at offset 0, so such a page was refused without a
 * title and, given one, had `# <title>` put ABOVE its frontmatter, which stops the frontmatter being frontmatter. The
 * H1 is now looked for after the block, and a synthesised one goes after the closing delimiter. A body with no
 * frontmatter renders byte for byte as it always has, which the topic writer's idempotence test depends on.
 *
 * ONE NORMALISATION, AND IT IS DELIBERATE: trailing whitespace becomes exactly one newline, for every page writer, as
 * it always has, and that newline is LF: a CRLF body keeps its CRLF inside and ends in LF, as pages written before
 * S67 do (a CRLF tail would make graduate read every such page as divergent). Publication evidence is the
 * source's own hash, so a source that differs from its page only there still reads as that page's copy.
 */
export function renderPageBody(body: string, title: string): RenderedPage {
  const normalised = body.replace(/\s+$/, '');
  const head = leadingFrontmatter(normalised);
  const rest = normalised.substring(head.length).replace(/^(?:[ \t]*\r?\n)+/, '');
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(rest);
  const keepsOwn = heading !== null && heading.index === 0 && /[a-zA-Z0-9]/.test(heading[1]!);
  if (!keepsOwn && !title.trim()) {
    refuse('The body has no leading H1, so --title is required to give the page a heading.');
  }
  const pageTitle = keepsOwn ? heading![1]!.trim() : title.trim();
  let rendered: string;
  if (keepsOwn) rendered = normalised + '\n';
  else if (!head) rendered = `# ${pageTitle}\n\n` + normalised + '\n';
  else rendered = head + (/\n$/.test(head) ? '' : '\n') + '\n' + `# ${pageTitle}\n` + (rest ? '\n' + rest : '') + '\n';
  return { title: pageTitle, titleSource: keepsOwn ? 'body H1' : '-Title', body: rendered };
}

/** Whether a path exists AS ITSELF: a dangling link is something, which `existsSync` would call nothing. */
export function lexists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE DESTINATION STAYS INSIDE THE BOOK (plan 0.3). A legal `topic/page` could otherwise pass through a `topic` that
 * is a link or junction into another Book or out of the collection; `wx` protects only the leaf. Every existing
 * segment below the Book's `wiki/` is checked with `lstat`, and a link of any kind -- dangling included -- is refused.
 */
export function assertInsideRoot(root: string, relative: string, what: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) refuse(`${what} is a link, so a write under it could land anywhere. Nothing was written.`);
  const realRoot = fs.realpathSync(root);
  let at = root;
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    at = path.join(at, segments[index]!);
    if (!lexists(at)) return;
    const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink()) {
      refuse(`'${segments.slice(0, index + 1).join('/')}' under ${what} is a link or junction, so a page written through it could land outside. Nothing was written.`);
    }
    const real = fs.realpathSync(at);
    if (real !== realRoot && !real.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)) {
      refuse(`'${segments.slice(0, index + 1).join('/')}' resolves outside ${what}. Nothing was written.`);
    }
  }
}
