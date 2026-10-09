/**
 * ONE RULE FOR A RELATIVE `--content-path`, on every verb that takes one (kickoffs/s106 row 6c). Until 1.4.0 the Hub,
 * collection, capture and book writers joined a relative path to the Library's folder while `compile` read it from the
 * working directory, and no help line said which, so a seat that wrote a scratch file beside itself was told it did not
 * exist. Now: an absolute path is taken as given; a relative one is looked for in the working directory first, then in
 * the Library's folder; a path found in neither is refused naming both places; and one found in both takes the working
 * directory's, which the verb's result says (`content_path_resolved`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The help line each verb that takes a `--content-path` prints. */
export const CONTENT_PATH_RULE = 'A relative --content-path is read from the working directory first, then from the Library\'s folder.';

let resolvedInBoth: string | null = null;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a `--content-path` names. An absolute path comes back as given, found or not: the caller's own refusal
 * names it. A relative one found in neither place is refused here, before anything is read or written.
 */
export function resolveContentPath(workspace: string, given: string, option = '--content-path'): string {
  if (path.isAbsolute(given)) return path.resolve(given);
  const fromWorkingDirectory = path.resolve(process.cwd(), given);
  const fromLibrary = path.resolve(workspace, given);
  if (isFile(fromWorkingDirectory)) {
    if (fromLibrary.toLowerCase() !== fromWorkingDirectory.toLowerCase() && isFile(fromLibrary)) {
      resolvedInBoth = `${option} ${given} was read from the working directory (${fromWorkingDirectory}); the Library's folder also holds ${fromLibrary}, which was not read.`;
    }
    return fromWorkingDirectory;
  }
  if (isFile(fromLibrary)) return fromLibrary;
  throw new Error(
    `${option} ${given} is not a file: it was looked for in the working directory (${fromWorkingDirectory}) and then in the ` +
      `Library's folder (${fromLibrary}). Pass an absolute path, or a path relative to one of those. Nothing was written.`,
  );
}

/** What the last resolution said when a relative path was found in both places, once; null when it was not. */
export function takeContentPathNote(): string | null {
  const note = resolvedInBoth;
  resolvedInBoth = null;
  return note;
}
