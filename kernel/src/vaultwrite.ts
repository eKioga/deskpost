/**
 * THE KERNEL WRITER (kickoffs/s161 row 3; plan vault-agent-contract D8, step 3, R2, R4): the only way Deskpost's own
 * files reach the connected vault.
 *
 * A page lands only under the vault's Librarian folder, at a relative path with no `..`; it is stamped
 * `written_by: deskpost` as the first field of its frontmatter; it is written whole, by `writeAtomicText`, inside a lock
 * keyed by the page's path (R4), so two writers leave one whole page; and it is never written through a link: at every
 * write, every existing component of the whole path, from its drive or file-system root down (the vault's own ancestors
 * included), is checked, and a symbolic link or junction anywhere refuses it (R2). The Obsidian command line is never
 * called (K8): it launches the app when it is closed, and the writer needs nothing from it.
 *
 * The answer is `written`, `unchanged` (when the caller's comparison says the page on disk already says this; the
 * comparison is the caller's, since only it knows which lines carry the time) or `refused` with the reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { sha256OfText } from './sha.ts';
import { linkedComponent, readVaultConnection } from './vault.ts';
import { readMarker } from './workspace.ts';

export type VaultWrite = { status: 'written' | 'unchanged'; path: string } | { status: 'refused'; path: string; reason: string };

/** `body` with `written_by: deskpost` as the first field of its frontmatter, adding the frontmatter when it has none. */
export function stampWrittenBy(body: string): string {
  const text = body.replace(/^﻿/, '');
  const open = /^---\r?\n/.exec(text);
  if (open === null) return `---\nwritten_by: deskpost\n---\n\n${text}`;
  const rest = text.substring(open[0].length);
  const close = /^---\r?$/m.exec(rest);
  if (close === null) return `---\nwritten_by: deskpost\n---\n\n${text}`;
  const fields = rest.substring(0, close.index).split(/\r?\n/).filter((line) => line !== '' && !/^written_by\s*:/.test(line));
  return ['---', 'written_by: deskpost', ...fields, rest.substring(close.index)].join('\n');
}

/** Write `body` to `<vault>/<librarian folder>/<relative>`, or say why not. Never throws for a refusal. */
export function writeVaultPage(workspace: string, relative: string, body: string, same?: (current: string) => boolean, timeoutSeconds = 20): VaultWrite {
  let connection;
  try {
    connection = readVaultConnection(readMarker(workspace));
  } catch (error) {
    return { status: 'refused', path: relative, reason: `the Library's marker could not be read: ${(error as Error).message}` };
  }
  if (connection === null) return { status: 'refused', path: relative, reason: 'this Library has no vault connection' };
  const parts = relative.split(/[\\/]/);
  if (!relative.trim() || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { status: 'refused', path: relative, reason: `'${relative}' is not a plain path inside the ${connection.librarian_folder} folder (no '..', no root, no empty part)` };
  }
  const librarian = path.join(connection.path, connection.librarian_folder);
  const target = path.join(librarian, ...parts);
  const inside = path.relative(librarian, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return { status: 'refused', path: target, reason: `${target} is outside ${librarian}` };
  }
  let lock: BookLock | null = null;
  try {
    lock = enterBookLock(workspace, `vault-page/${sha256OfText(path.resolve(target).toLowerCase()).substring(0, 32)}`, timeoutSeconds);
    // AT EVERY WRITE, INSIDE THE LOCK: the whole path, the vault's ancestors included (R2).
    const linked = linkedComponent(target);
    if (linked !== null) return { status: 'refused', path: target, reason: `${linked} is a symbolic link or junction, so nothing is written through it` };
    let librarianIsFolder = false;
    try { librarianIsFolder = fs.statSync(librarian).isDirectory(); } catch { /* absent */ }
    if (!librarianIsFolder) return { status: 'refused', path: target, reason: `the vault's ${connection.librarian_folder} folder (${librarian}) does not exist` };
    let current: string | null = null;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current !== null && same !== undefined && same(current)) return { status: 'unchanged', path: target };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomicText(target, stampWrittenBy(body));
    return { status: 'written', path: target };
  } catch (error) {
    return { status: 'refused', path: target, reason: (error as Error).message };
  } finally {
    exitBookLock(lock);
  }
}
