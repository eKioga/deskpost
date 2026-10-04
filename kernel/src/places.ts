/**
 * Where a Book lives, said once (PLAN-basic-memory.md step 1, the Desk's added form; ADR-0049).
 *
 * THE ROOT GRAMMAR HAD SIX COPIES -- the reader, the Desk, the guards, full text, Discovery and the mutation
 * window each carried `(shelf/_archive|books|archive|shelf)` -- and the `shared/` form had to reach all of
 * them at once or a Desk holding one would read as malformed wherever a copy was missed. So the grammar is
 * here and every one of them reads it.
 *
 * THREE PLACES, SIX FORMS. The glossary's places (CONTEXT.md): the **Shelf**, the Library's own **Local
 * collection**, and the **shared** collection reached through a Basic Memory connection.
 *
 *   shelf/<slug>, shelf/_archive/<slug>     the Shelf, on this disk
 *   books/<slug>, archive/<slug>            the Library's own collection: `collection/` on a local Library,
 *                                           and Basic Memory itself on a workspace whose backend it is
 *   shared/<slug>, shared/archive/<slug>    a Book read from a local Library's Basic Memory CONNECTION
 *
 * NOTHING EXISTING CHANGES MEANING. `books/<slug>` was already a local Library's collection form
 * (`desk.ts`, S46), so no Desk needs migrating; `shared/` is only ever added. A bare slug is still the
 * pre-symmetry spelling of `books/<slug>`.
 *
 * `shared/archive/x` IS THE ARCHIVED BOOK x, AND `shared/archive` IS THE ACTIVE BOOK CALLED `archive`. The
 * alternation tries the longer prefix first, and a prefix needs a slug after it, so the two never collide.
 */

export type BookForm = 'shelf' | 'books' | 'shared';
export type BookPlace = 'shelf' | 'collection' | 'shared';

const PREFIXES = 'shelf\\/_archive|shared\\/archive|books|archive|shelf|shared';

/** A Book root, and nothing else: `<prefix>/<slug>`. */
export const BOOK_ROOT_PATTERN = new RegExp(`^(${PREFIXES})\\/([a-z0-9][a-z0-9-]*)$`);
/** What a Desk line may hold: a root, or the bare slug that means `books/<slug>`. */
export const BOOK_ROOT_ACCEPT_PATTERN = new RegExp(`^(?:(?:${PREFIXES})\\/)?[a-z0-9][a-z0-9-]*$`);
export const BOOK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface BookRootParts {
  root: string;
  form: BookForm;
  /** How a page is FETCHED, as every caller already branched on it: from this disk, or from a collection. */
  collection: 'shelf' | 'shared';
  shelf: 'active' | 'archive';
  slug: string;
  /** The root's own `wiki/`, as the Desk spells it. A `shared/` root's is not a path on any disk. */
  wikiRoot: string;
  /** The Book's `wiki/` inside the store that holds it: the workspace, the collection, or Basic Memory. */
  storeWiki: string;
}

/** A Desk line or a root, taken apart; null when it is neither. */
export function parseBookRoot(entry: string): BookRootParts | null {
  const normalised = BOOK_SLUG_PATTERN.test(entry) ? `books/${entry}` : entry;
  const match = BOOK_ROOT_PATTERN.exec(normalised);
  if (!match) return null;
  const prefix = match[1]!;
  const slug = match[2]!;
  const form: BookForm = prefix.startsWith('shelf') ? 'shelf' : prefix.startsWith('shared') ? 'shared' : 'books';
  const shelf = prefix === 'archive' || prefix === 'shelf/_archive' || prefix === 'shared/archive' ? 'archive' : 'active';
  const storeWiki =
    form === 'shelf' ? `${normalised}/wiki` : shelf === 'archive' ? `archive/${slug}/wiki` : `books/${slug}/wiki`;
  return {
    root: normalised,
    form,
    collection: form === 'shelf' ? 'shelf' : 'shared',
    shelf,
    slug,
    wikiRoot: `${normalised}/wiki`,
    storeWiki,
  };
}

/**
 * THE PLACE A ROOT NAMES, which depends on the workspace for one form only: `books/` is the Local collection
 * on a local Library and the shared collection on a workspace attached to Basic Memory.
 */
export function placeOfRoot(parts: BookRootParts, localBackend: boolean): BookPlace {
  if (parts.form === 'shelf') return 'shelf';
  if (parts.form === 'shared') return 'shared';
  return localBackend ? 'collection' : 'shared';
}

/** The root a place gives a slug. `shared` on a workspace attached to Basic Memory is its own `books/`. */
export function rootForPlace(place: BookPlace, shelf: 'active' | 'archive', slug: string, localBackend: boolean): string {
  if (place === 'shelf') return shelf === 'archive' ? `shelf/_archive/${slug}` : `shelf/${slug}`;
  if (place === 'shared' && localBackend) return shelf === 'archive' ? `shared/archive/${slug}` : `shared/${slug}`;
  return shelf === 'archive' ? `archive/${slug}` : `books/${slug}`;
}

export const BOOK_PLACES: BookPlace[] = ['shelf', 'collection', 'shared'];

/** An optional `place` argument: absent is null, a known place is itself, anything else is a refusal. */
export function parsePlaceArgument(value: unknown): BookPlace | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const named = String(value).trim().toLowerCase();
  // AN ARCHIVE IS A SHELF, NOT A PLACE (S85 row 2, backlog Row B): `place: archive` was refused with the list alone,
  // and the list did not say where an archived Book is read.
  if (named === 'archive') {
    throw new Error(
      `place is one of ${BOOK_PLACES.join(', ')}; got '${String(value)}'. An archived Book reads with place: collection ` +
        '(place: shelf for an archived Shelf Book), once it is open on the Desk with --shelf archive.',
    );
  }
  if (!(BOOK_PLACES as string[]).includes(named)) {
    throw new Error(`place is one of ${BOOK_PLACES.join(', ')}; got '${String(value)}'.`);
  }
  return named as BookPlace;
}
