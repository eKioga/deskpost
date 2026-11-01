/** Existence only, with the reader's exact path spelling and collection locations; no Desk or page-content reads. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openCollection } from './collection.ts';
import type { NameResolution } from './kickoffcheck.ts';

export function kickoffNameResolver(workspace: string): (name: string) => NameResolution {
  return name => {
    try {
      if (name.startsWith('shared/')) return { status: 'unreadable', reason: 'shared Book names cannot be resolved offline' };
      const collection = openCollection(workspace).root;
      const pieces = name.split('/');
      if (pieces.some(p => !p || p === '.' || p === '..' || p.includes('\\') || /[:\x00-\x1f]/.test(p))) return { status: 'unreadable', reason: 'page path is malformed' };
      const candidates: { root: string; relative: string }[] = [];
      if (pieces[0] === 'projects') {
        for (const prefix of ['', 'archive/']) candidates.push({ root: collection, relative: `${prefix}${name}.md` });
      } else {
        const explicit = pieces[0] === 'shelf' || pieces[0] === 'books' || pieces[0] === 'archive';
        const archived = pieces[0] === 'archive' || (pieces[0] === 'shelf' && pieces[1] === '_archive');
        const slugAt = explicit ? (pieces[1] === '_archive' ? 2 : 1) : 0;
        const slug = pieces[slugAt]!;
        const page = pieces.slice(slugAt + 1).join('/').replace(/^wiki\//, '');
        if (!slug || !page) return { status: 'absent' };
        if (!explicit || pieces[0] === 'shelf') for (const prefix of archived ? ['shelf/_archive'] : ['shelf', 'shelf/_archive']) candidates.push({ root: workspace, relative: `${prefix}/${slug}/wiki/${page}.md` });
        if (!explicit || pieces[0] !== 'shelf') for (const prefix of archived ? ['archive'] : ['books', 'archive']) candidates.push({ root: collection, relative: `${prefix}/${slug}/wiki/${page}.md` });
      }
      let unreadable: string | undefined;
      for (const { root, relative } of candidates) {
        try {
          let current = root;
          let absent = false;
          for (const segment of relative.split('/')) {
            if (!fs.readdirSync(current).includes(segment)) { absent = true; break; }
            current = path.join(current, segment);
            if (fs.lstatSync(current).isSymbolicLink()) return { status: 'unreadable', reason: 'page path passes through a link' };
          }
          if (!absent && fs.statSync(current).isFile()) {
            if (!fs.realpathSync(current).startsWith(fs.realpathSync(root) + path.sep)) return { status: 'unreadable', reason: 'page resolves outside its store' };
            return { status: 'exists' };
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable = (error as Error).message;
        }
      }
      return unreadable ? { status: 'unreadable', reason: unreadable } : { status: 'absent' };
    } catch (error) { return { status: 'unreadable', reason: (error as Error).message }; }
  };
}
