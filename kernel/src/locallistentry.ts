/**
 * `library shared list-entry <slug>` on a local Library: this Book's one line in `collection/books/README.md`, set to
 * its title and Summary (2nd-b-vault-dev's Report of 2026-10-11: the verb refused a local Library, so a stale local
 * Catalog Summary had no route). Until S118 the verb refused here while `shared archive` acted on the same collection.
 *
 * ONE WRITER: the line is placed by `placeOwnedEntry`, the Catalog-line writer a publication to this collection uses,
 * so a listing and a publication cannot disagree on where a Book's line goes or what it looks like.
 *
 * GATED AS A LOCAL ARCHIVE IS: a preflight that writes nothing and issues a plan id bound to the slug, the planned line
 * and the Catalog's current bytes, then `--user-confirmed --plan-id <id>`. The Catalog changed after the preview gives
 * another id, and the apply refuses it. A Project Hub's line is not listed here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { withBookLocks } from './locks.ts';
import { readUtf8 } from './shelfbook.ts';
import { sha256OfText } from './sha.ts';
import { LOCAL_BOOKS_CATALOG_TEXT, ownedLines, placeOwnedEntry, readCatalogOrTemplate, splitLocalFrontmatter, writeCatalog } from './localcatalog.ts';

class LocalListEntryRefusal extends Error {}

function refuse(message: string): never {
  throw new LocalListEntryRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLLECTIONS = ['Projects', 'Reference', 'Workflows'];

function firstHeading(text: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(splitLocalFrontmatter(text).body);
  return match ? match[1]!.trim() : null;
}

const STALE_PLAN_ID =
  'The Catalog line was not changed: rerun the current preflight and pass its exact plan_id. A different plan_id means ' +
  'the Catalog changed since you approved it. Nothing was written.';

export function localSharedListEntry(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, argumentTable('shared', 'list-entry'));
  const slug = parsed.positional[0] ?? '';
  if (!slug.trim()) refuse('Slug is required.');
  if (!SLUG.test(slug)) refuse('Slug must use lowercase letters, digits, and single hyphens.');
  const kind = (parsed.options.get('kind') ?? 'book').toLowerCase();
  if (kind !== 'book') refuse(`This Library's own Catalog lists a Book only, and --kind ${kind} names something else. Nothing was listed.`);
  const collectionWord = parsed.options.get('collection');
  const collection = collectionWord === undefined ? null : COLLECTIONS.find((name) => name.toLowerCase() === collectionWord.toLowerCase());
  if (collection === undefined) refuse(`library shared list-entry --collection is Projects, Reference or Workflows; got '${collectionWord}'.`);

  const bookDirectory = `books/${slug}`;
  const rootFile = path.join(workspace, 'collection', 'books', slug, 'wiki', '_book.md');
  if (!fs.existsSync(rootFile)) refuse(`Book '${slug}' is not in this Library's collection (no ${bookDirectory}/wiki/_book.md); nothing was listed.`);
  const suppliedTitle = parsed.options.get('title') ?? '';
  const suppliedSummary = parsed.options.get('summary') ?? '';
  for (const value of [suppliedTitle, suppliedSummary]) if (/[\x00-\x1f\x7f]/.test(value)) refuse('Catalog title and summary cannot hold control characters or DEL. Nothing was listed.');
  const title = suppliedTitle.trim() || firstHeading(readUtf8(rootFile)) || slug;
  const summary = suppliedSummary.trim();
  if (/[\x00-\x1f\x7f]/.test(title)) refuse('Catalog title cannot hold control characters or DEL. Nothing was listed.');
  const target = `${bookDirectory}/wiki/_book`;
  const entry = summary ? `- [[${target}|${title}]] — ${summary}` : `- [[${target}|${title}]]`;
  const catalogFile = path.join(workspace, 'collection', 'books', 'README.md');

  // What the apply would write, from the Catalog as it is now; the plan id binds the Catalog's bytes.
  const planFor = () => {
    const current = readCatalogOrTemplate(catalogFile, LOCAL_BOOKS_CATALOG_TEXT);
    const owned = ownedLines(current.text, [target]);
    // With no collection named, a listed line stays under the heading it has; a new one goes where a publication puts it.
    const heading = collection !== null ? `## ${collection}` : (owned.length === 1 && owned[0]!.heading) || '## Open a Book';
    const placed = placeOwnedEntry(current.text, target, entry, heading, collection !== null ? '## Open a Book' : null, collection !== null);
    if (placed.state === 'duplicate') {
      refuse(`The Book Catalog carries ${placed.count} entry lines linking '${target}'; it will not guess which one is this Book's. Nothing was listed.`);
    }
    const planId =
      'list-entry-' +
      sha256OfText([`slug=${slug}`, `entry=${entry}`, `collection=${collection ?? ''}`, `catalog=${current.existed ? sha256OfText(current.text) : 'absent'}`].join('\n'));
    return { current, owned, placed, heading, planId };
  };
  const operation = 'List a Book in its local Catalog';
  const now = planFor();
  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation,
    destination: 'collection',
    book_slug: slug,
    catalog_path: 'collection/books/README.md',
    heading: now.heading,
    previous_entry: now.owned.length === 1 ? now.owned[0]!.line : null,
    entry,
    action: now.placed.state,
    confirmation_required: now.placed.state !== 'already-current',
    destructive: false,
    shared_library_write: false,
    scope: "Changes this Book's one Catalog line, or adds it when it is missing. No other line changes.",
    plan_id: now.planId,
  };
  if (parsed.flags.has('preflight')) return plan;
  if (now.placed.state === 'already-current') return { schema: 1, operation, book_slug: slug, catalog_path: 'collection/books/README.md', entry, changed: false };
  if (!parsed.flags.has('user-confirmed')) refuse('Nothing was listed: review the preflight and rerun with --user-confirmed --plan-id <id>.');
  const approved = parsed.options.get('plan-id') ?? '';
  if (!approved) refuse('Nothing was listed: rerun --preflight and pass its plan_id with --user-confirmed --plan-id <id>.');
  if (approved !== now.planId) refuse(STALE_PLAN_ID);

  return withBookLocks(workspace, [bookDirectory, 'collection/books'], 20, () => {
    // THE PLAN, AGAIN, UNDER THE LOCKS: nothing can change the Catalog between this check and the write.
    const locked = planFor();
    if (locked.planId !== approved) refuse(STALE_PLAN_ID);
    const written = writeCatalog(catalogFile, locked.placed.text);
    const after = ownedLines(written, [target]);
    if (after.length !== 1 || after[0]!.line !== entry) refuse(`Book Catalog readback did not carry this Book's entry line exactly once: '${entry}'.`);
    return {
      schema: 1,
      operation,
      destination: 'collection',
      book_slug: slug,
      catalog_path: 'collection/books/README.md',
      heading: after[0]!.heading,
      previous_entry: locked.owned.length === 1 ? locked.owned[0]!.line : null,
      entry,
      action: locked.placed.state,
      moved_from: locked.placed.movedFrom,
      changed: true,
      catalog_entry_verified: true,
    };
  });
}
