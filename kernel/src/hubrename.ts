/**
 * `library hub rename <old> <new> --title <t>`: a local Project Hub renamed by COPYING FORWARD AND ARCHIVING THE OLD
 * (PLAN-hub-rename.md). Never a move in place: the old Hub is archived intact under its old name, so its history keeps
 * the words it was written in, and nothing is destroyed.
 *
 * THE STEPS, EACH SAFE TO RUN AGAIN, in the order the journal records them:
 *   1. copy     every file of projects/<old>/ to projects/<new>/, byte for byte but for two changes: a `permalink:`
 *               naming projects/<old>/ names projects/<new>/, and _project.md's first H1 becomes the new title;
 *   2. catalog  the Active Project Catalog's line for <old> replaced, in place, by one for <new>;
 *   3. desks    every seat's `projects/<old>` Desk entry becomes `projects/<new>`;
 *   4. archive  projects/<old>/ moved whole (a native rename) to archive/projects/<old>/, unchanged;
 *   5. listed   the old Hub's line added to the archived Project Catalog.
 * Then every other page that mentions <old> is LISTED and left alone (Eric's S62 ruling, Q2), and so is every current
 * page of the new Hub itself that still names the old slug or title, for `hub edit`; its notes/ are history (S65).
 *
 * THE APPROVAL IS A PLAN_ID over every byte the rename reads -- each source file, both catalogs, every Desk file --
 * so anything that changes after the preview refuses the run. The plan is written to a journal before the first
 * write, and a run that stopped part-way is finished by the same command and the same plan_id, from the journal.
 *
 * SEATS ARE THE BOUNDARY. A seat bound to <old> is refused, because a binding is permanent; and so is any seat that
 * has <old> on its Desk while a session holds it, because its Desk would change under that session. A Library whose
 * collection is Basic Memory is refused by `openCollection`: a shared Hub is not this verb's to rename.
 *
 * BASIC MEMORY NEEDS NOTHING (bmsource.ts, `classify`): after a rename the old Hub's files are absent here and
 * recorded by the last import, which a re-import reads as `keep-local`, and the new Hub's are `local-only`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { psConvertToJson } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { writeAtomicText } from './fsx.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { withBookLocks, SEAT_REGISTRY_LOCK_ROOT } from './locks.ts';
import { readMarker } from './workspace.ts';
import { readSeatRegistry } from './desk.ts';
import { deskFilePath } from './seatdesk.ts';
import { getSeatClaimState } from './seatclaim.ts';
import { ensureHeading, insertUnderHeading, ownedLines, splitLocalFrontmatter, writeCatalog } from './localcatalog.ts';

class HubRenameRefusal extends Error {}

function refuse(message: string): never {
  throw new HubRenameRefusal(message);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEPS = ['copy', 'catalog', 'desks', 'archive', 'listed'] as const;
const NEW_HUB_MENTIONS_NOTE =
  "The new Hub's own current pages that still name the old slug or title; the rename changed only their permalinks and the root's title. Change them with library hub edit. notes/ is history and is not listed.";
type Step = (typeof STEPS)[number];

interface PlannedFile {
  path: string;
  source_sha256: string;
  target_sha256: string;
  changed: boolean;
}

interface RenamePlan {
  plan_id: string;
  old_slug: string;
  new_slug: string;
  new_title: string;
  old_title: string;
  files: PlannedFile[];
  active_catalog_sha256: string;
  archive_catalog_sha256: string;
  desks: { seat: string; sha256: string }[];
}

interface Journal {
  schema: 1;
  plan: RenamePlan;
  done: Step[];
  state: 'running' | 'complete';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A slug as a whole path token: `library-dev` must not match inside `library-dev-notes`. */
function tokenPattern(slug: string, flags = 'g'): RegExp {
  return new RegExp(`(?<![a-z0-9-])${escapeRegExp(slug)}(?![a-z0-9-])`, flags);
}

function sha(file: string): string {
  return sha256OfBytes(fs.readFileSync(file));
}

function shaOrAbsent(file: string): string {
  return fs.existsSync(file) ? sha(file) : 'absent';
}

/** The length-prefixed digest every approval in the kernel uses, so no two plans render to one string. */
function planDigest(fields: string[]): string {
  return sha256OfText(fields.map((field) => `${field.length}:${field}`).join('')).substring(0, 16);
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) refuse(`${full} is a link; a Hub is renamed only when every entry in it is a plain file or folder.`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * What a file becomes in the new Hub. Only Markdown changes, and only in two places: the frontmatter's `permalink:`
 * line (Q1), and the root page's first H1. Every other byte -- dated notes included -- is copied as it is.
 */
function transformed(bytes: Buffer, relative: string, oldSlug: string, newSlug: string, newTitle: string): Buffer {
  if (!relative.toLowerCase().endsWith('.md')) return bytes;
  let text = bytes.toString('utf8');
  const front = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (front) {
    const pattern = new RegExp(`(^|/)projects/${escapeRegExp(oldSlug)}(?=/|$)`);
    const lines = front[2]!.split(/(\r?\n)/);
    const rewritten = lines.map((line) => (/^permalink:/i.test(line) ? line.replace(pattern, `$1projects/${newSlug}`) : line)).join('');
    text = front[1]! + rewritten + front[3]! + text.substring(front[0].length);
  }
  if (relative === '_project.md') {
    // MEASURED ON THE REWRITTEN TEXT: the permalink changed the frontmatter's length whenever the two slugs differ in
    // length, and an offset from before it landed inside the body and missed the H1 (S62, home-lab-admin).
    const rewrittenFront = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
    const head = rewrittenFront ? rewrittenFront[0].length : 0;
    const body = text.substring(head).replace(/^#[ \t]+.*$/m, `# ${newTitle}`);
    text = text.substring(0, head) + body;
  }
  return Buffer.from(text, 'utf8');
}

function firstHeading(text: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(splitLocalFrontmatter(text).body);
  return match ? match[1]!.trim() : null;
}

function journalDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'hub-rename-journals');
}

function journalPath(workspace: string, oldSlug: string, newSlug: string): string {
  return path.join(journalDirectory(workspace), `${oldSlug}--${newSlug}.json`);
}

function readJournal(file: string): Journal | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Journal;
  } catch {
    refuse(`The rename journal at ${file} is not readable JSON; nothing was changed. Inspect it before retrying.`);
  }
}

function writeJournal(file: string, journal: Journal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomicText(file, psConvertToJson(journal as unknown as PsJsonValue) + '\n');
}

/** Every unfinished rename journal that names either slug, other than this exact rename's. */
function otherUnfinished(workspace: string, oldSlug: string, newSlug: string): string[] {
  const directory = journalDirectory(workspace);
  if (!fs.existsSync(directory)) return [];
  const mine = path.basename(journalPath(workspace, oldSlug, newSlug));
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json') && name !== mine)
    .filter((name) => {
      const [a, b] = name.replace(/\.json$/, '').split('--');
      return [a, b].some((slug) => slug === oldSlug || slug === newSlug);
    })
    .filter((name) => readJournal(path.join(directory, name))?.state !== 'complete');
}

interface Context {
  workspace: string;
  collection: string;
  stateDirectory: string;
  oldSlug: string;
  newSlug: string;
  newTitle: string;
}

function activeCatalogFile(context: Context): string {
  return path.join(context.collection, 'projects', 'README.md');
}

function archiveCatalogFile(context: Context): string {
  return path.join(context.collection, 'archive', 'projects', 'README.md');
}

/** The seats whose Desk has projects/<old> open, with the claim each is under. */
function desksWithOld(context: Context): { seat: string; file: string; claim: string }[] {
  const found: { seat: string; file: string; claim: string }[] = [];
  for (const entry of readSeatRegistry(context.stateDirectory)) {
    const file = deskFilePath(context.stateDirectory, entry.seat, 'projects');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(`projects/${context.oldSlug}`)) found.push({ seat: entry.seat, file, claim: getSeatClaimState(context.stateDirectory, entry.seat).state });
  }
  return found;
}

/** Everything that must be true before a fresh rename starts. Run again under the locks. */
function assertRenamable(context: Context): void {
  const { collection, oldSlug, newSlug } = context;
  const oldRoot = path.join(collection, 'projects', oldSlug);
  if (!fs.existsSync(path.join(oldRoot, '_project.md'))) refuse(`There is no active Project Hub '${oldSlug}' in this Library's collection; nothing was changed.`);
  const catalog = fs.readFileSync(activeCatalogFile(context), 'utf8');
  const owned = ownedLines(catalog, [`projects/${oldSlug}/_project`]);
  if (owned.length !== 1) refuse(`The Active Project Catalog lists '${oldSlug}' ${owned.length} times; exactly one line is needed to replace. Nothing was changed.`);
  for (const taken of [path.join(collection, 'projects', newSlug), path.join(collection, 'archive', 'projects', newSlug)]) {
    if (fs.existsSync(taken)) refuse(`'${newSlug}' is already taken at ${taken}; choose another name. Nothing was changed.`);
  }
  if (fs.existsSync(path.join(collection, 'archive', 'projects', oldSlug))) {
    refuse(`The archive already holds a Hub named '${oldSlug}', so this one cannot be archived under its name. Nothing was changed.`);
  }
  const bound = readSeatRegistry(context.stateDirectory).filter((entry) => entry.project === oldSlug).map((entry) => entry.seat);
  if (bound.length) {
    refuse(
      `Seat ${bound.map((seat) => `'${seat}'`).join(', ')} is bound to Project '${oldSlug}', and a seat's binding is permanent. ` +
        'Retire it first (library seat retire <name> --preflight); nothing was changed.',
    );
  }
  const live = desksWithOld(context).filter((desk) => desk.claim !== 'free');
  if (live.length) {
    refuse(
      `Seat ${live.map((desk) => `'${desk.seat}'`).join(', ')} has '${oldSlug}' on its Desk and a session holds it, so its Desk would change under ` +
        `that session. Close the Hub there (library desk close project ${oldSlug}) or end that session first; nothing was changed.`,
    );
  }
  const unfinished = otherUnfinished(context.workspace, oldSlug, newSlug);
  if (unfinished.length) refuse(`An unfinished rename names one of these slugs (${unfinished.join(', ')}); finish it first. Nothing was changed.`);
}

function buildPlan(context: Context): RenamePlan {
  const { collection, oldSlug, newSlug, newTitle } = context;
  const oldRoot = path.join(collection, 'projects', oldSlug);
  const files: PlannedFile[] = listFiles(oldRoot).map((relative) => {
    const bytes = fs.readFileSync(path.join(oldRoot, ...relative.split('/')));
    const target = transformed(bytes, relative, oldSlug, newSlug, newTitle);
    const source = sha256OfBytes(bytes);
    const targetSha = sha256OfBytes(target);
    return { path: relative, source_sha256: source, target_sha256: targetSha, changed: source !== targetSha };
  });
  const oldTitle = firstHeading(fs.readFileSync(path.join(oldRoot, '_project.md'), 'utf8')) ?? oldSlug;
  const desks = desksWithOld(context).map((desk) => ({ seat: desk.seat, sha256: sha(desk.file) }));
  const active = sha(activeCatalogFile(context));
  const archive = shaOrAbsent(archiveCatalogFile(context));
  const plan_id = planDigest([
    'hub-rename',
    oldSlug,
    newSlug,
    newTitle,
    ...files.flatMap((file) => [file.path, file.source_sha256]),
    active,
    archive,
    ...desks.flatMap((desk) => [desk.seat, desk.sha256]),
  ]);
  return { plan_id, old_slug: oldSlug, new_slug: newSlug, new_title: newTitle, old_title: oldTitle, files, active_catalog_sha256: active, archive_catalog_sha256: archive, desks };
}

/** Every page outside the renamed Hubs that mentions <old>, with its line numbers. Listed, never changed (Q2). */
function mentions(context: Context): { path: string; lines: number[] }[] {
  const skip = new Set([
    `projects/${context.oldSlug}`,
    `projects/${context.newSlug}`,
    `archive/projects/${context.oldSlug}`,
  ]);
  const skipFiles = new Set(['imports.md', 'projects/README.md', 'archive/projects/README.md']);
  const pattern = tokenPattern(context.oldSlug, '');
  const out: { path: string; lines: number[] }[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(context.collection, full).split(path.sep).join('/');
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!skip.has(relative)) walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !skipFiles.has(relative)) {
        const lines: number[] = [];
        fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, index) => {
          if (pattern.test(line)) lines.push(index + 1);
        });
        if (lines.length) out.push({ path: `collection/${relative}`, lines });
      }
    }
  };
  walk(context.collection);
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/**
 * The new Hub's own CURRENT pages that still name the old slug or the old title, with their line numbers (S62, "Found in
 * the first real runs"): a `limits` heading, a `read_open_project_page(<old>, ...)` instruction. The copy changes only
 * the permalinks and the root's H1, so these are left for `hub edit`. `notes/` is history and is not listed. Read from
 * the new Hub once it is written, and before that from the old Hub as the copy will write it.
 */
function newHubMentions(context: Context, plan: RenamePlan): { path: string; lines: number[] }[] {
  const oldRoot = path.join(context.collection, 'projects', plan.old_slug);
  const newRoot = path.join(context.collection, 'projects', plan.new_slug);
  const slug = tokenPattern(plan.old_slug, '');
  const title = plan.old_title ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(plan.old_title)}(?![\\p{L}\\p{N}])`, 'iu') : null;
  const out: { path: string; lines: number[] }[] = [];
  for (const file of plan.files) {
    if (!file.path.toLowerCase().endsWith('.md') || file.path.startsWith('notes/')) continue;
    const written = path.join(newRoot, ...file.path.split('/'));
    const source = path.join(oldRoot, ...file.path.split('/'));
    let text: string;
    if (fs.existsSync(written)) text = fs.readFileSync(written, 'utf8');
    else if (fs.existsSync(source)) text = transformed(fs.readFileSync(source), file.path, plan.old_slug, plan.new_slug, plan.new_title).toString('utf8');
    else continue;
    const lines: number[] = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (slug.test(line) || (title !== null && title.test(line))) lines.push(index + 1);
    });
    if (lines.length) out.push({ path: `collection/projects/${plan.new_slug}/${file.path}`, lines });
  }
  return out;
}

function describe(plan: RenamePlan): Record<string, PsJsonValue> {
  return {
    old_slug: plan.old_slug,
    old_title: plan.old_title,
    new_slug: plan.new_slug,
    new_title: plan.new_title,
    new_path: `collection/projects/${plan.new_slug}`,
    archive_path: `collection/archive/projects/${plan.old_slug}`,
    file_count: plan.files.length,
    files_changed_in_copy: plan.files.filter((file) => file.changed).map((file) => file.path),
    catalog_entry: `- [[projects/${plan.new_slug}/_project|${plan.new_title}]]`,
    archive_catalog_entry: `- [[archive/projects/${plan.old_slug}/_project|${plan.old_title}]]`,
    desks_rewritten: plan.desks.map((desk) => desk.seat),
  };
}

function runStep(context: Context, plan: RenamePlan, step: Step): void {
  const { collection, oldSlug, newSlug } = context;
  const oldRoot = path.join(collection, 'projects', oldSlug);
  const newRoot = path.join(collection, 'projects', newSlug);
  const archived = path.join(collection, 'archive', 'projects', oldSlug);
  switch (step) {
    case 'copy': {
      for (const file of plan.files) {
        const target = path.join(newRoot, ...file.path.split('/'));
        if (fs.existsSync(target)) {
          if (sha(target) === file.target_sha256) continue;
          refuse(`collection/projects/${newSlug}/${file.path} exists and is not what this rename writes; nothing more was changed. Inspect it before retrying.`);
        }
        const source = path.join(oldRoot, ...file.path.split('/'));
        const bytes = fs.readFileSync(source);
        if (sha256OfBytes(bytes) !== file.source_sha256) refuse(`collection/projects/${oldSlug}/${file.path} changed after the plan was made; nothing more was changed.`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, transformed(bytes, file.path, oldSlug, newSlug, plan.new_title));
      }
      // READ BACK every file before anything points at the new Hub.
      for (const file of plan.files) {
        if (sha(path.join(newRoot, ...file.path.split('/'))) !== file.target_sha256) refuse(`collection/projects/${newSlug}/${file.path} did not read back as planned.`);
      }
      return;
    }
    case 'catalog': {
      const file = activeCatalogFile(context);
      const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      const entry = `- [[projects/${newSlug}/_project|${plan.new_title}]]`;
      const owned = ownedLines(text, [`projects/${oldSlug}/_project`]);
      if (owned.length === 0 && ownedLines(text, [`projects/${newSlug}/_project`]).length === 1) return;
      if (owned.length !== 1) refuse(`The Active Project Catalog lists '${oldSlug}' ${owned.length} times; the catalog was not changed.`);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      lines[owned[0]!.index] = entry;
      const after = writeCatalog(file, lines.join(eol));
      if (ownedLines(after, [`projects/${oldSlug}/_project`]).length || ownedLines(after, [`projects/${newSlug}/_project`]).length !== 1) {
        refuse('The Active Project Catalog did not read back with exactly the new line in place of the old.');
      }
      return;
    }
    case 'desks': {
      for (const desk of plan.desks) {
        const file = deskFilePath(context.stateDirectory, desk.seat, 'projects');
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        if (!lines.some((line) => line.trim() === `projects/${oldSlug}`)) continue;
        if (getSeatClaimState(context.stateDirectory, desk.seat).state !== 'free') {
          refuse(`Seat '${desk.seat}' is now held by a session, so its Desk was not changed. Close '${oldSlug}' there, then run the same command again.`);
        }
        const hasNew = lines.some((line) => line.trim() === `projects/${newSlug}`);
        const next = lines.flatMap((line) => (line.trim() === `projects/${oldSlug}` ? (hasNew ? [] : [`projects/${newSlug}`]) : [line]));
        writeAtomicText(file, next.join(eol));
      }
      return;
    }
    case 'archive': {
      if (!fs.existsSync(oldRoot) && fs.existsSync(archived)) return;
      if (fs.existsSync(archived)) refuse(`The archive already holds '${oldSlug}' while the active Hub is still there; nothing more was changed.`);
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      fs.renameSync(oldRoot, archived);
      for (const file of plan.files) {
        if (sha(path.join(archived, ...file.path.split('/'))) !== file.source_sha256) refuse(`collection/archive/projects/${oldSlug}/${file.path} did not read back unchanged.`);
      }
      return;
    }
    case 'listed': {
      const file = archiveCatalogFile(context);
      const link = `[[archive/projects/${oldSlug}/_project|`;
      let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '# Archived Projects\n\nProjects retired from the active catalog. An archived Hub stays searchable.\n\n## Projects\n';
      if (text.toLowerCase().includes(link.toLowerCase())) return;
      // UNDER THE HEADING THAT ALREADY HOLDS ENTRIES: an imported catalog carries `## Archived Projects` beside init's
      // empty `## Projects` (PLAN-hub-rename.md, "Found while drafting").
      const heading = /^## Archived Projects\s*$/m.test(text) ? '## Archived Projects' : '## Projects';
      text = ensureHeading(text, heading, null).text;
      const after = writeCatalog(file, insertUnderHeading(text, heading, `- ${link}${plan.old_title}]]`));
      if (!after.toLowerCase().includes(link.toLowerCase())) refuse('The archived Project Catalog did not read back with the old Hub listed.');
      return;
    }
  }
}

export function hubRename(argv: string[], workspace: string): Record<string, PsJsonValue> {
  const parsed = parseArguments(argv, ['title', 'plan-id', 'lock-timeout', 'workspace']);
  const [oldSlug = '', newSlug = ''] = parsed.positional;
  if (!oldSlug || !newSlug) refuse('library hub rename needs both names: library hub rename <old-slug> <new-slug> --title "<new title>" --preflight.');
  for (const slug of [oldSlug, newSlug]) if (!SLUG.test(slug)) refuse(`'${slug}' is not a Project slug: lowercase letters, digits, and single hyphens.`);
  if (oldSlug === newSlug) refuse('The old and new names are the same; there is nothing to rename.');
  const newTitle = (parsed.options.get('title') ?? '').trim();
  if (!newTitle) refuse('A rename needs the new title: --title "<new title>".');
  if (/[\r\n]|\]\]|\|/.test(newTitle)) refuse('The title goes into a catalog link, so it cannot hold a line break, a | or ]].');

  // NOT `openCollection`: collection.ts dispatches to this file, and importing it back is the cycle argv.ts warns of.
  const marker = readMarker(workspace);
  if (marker === null || String(marker['backend'] ?? '') !== 'local') {
    refuse('library hub rename renames a Hub in this Library\'s own collection, and this Library\'s collection is Basic Memory (or it has no marker). Nothing was changed.');
  }
  const collectionRoot = path.join(workspace, 'collection');
  if (!fs.existsSync(path.join(collectionRoot, '.library', 'collection.json'))) refuse(`This Library has no local collection at ${collectionRoot}; run library init. Nothing was changed.`);
  const context: Context = {
    workspace,
    collection: collectionRoot,
    stateDirectory: path.join(workspace, '.claude'),
    oldSlug,
    newSlug,
    newTitle,
  };
  const journalFile = journalPath(workspace, oldSlug, newSlug);
  const existing = readJournal(journalFile);
  const resuming = existing !== null && existing.state !== 'complete';
  if (resuming && existing!.plan.new_title !== newTitle) {
    refuse(`An unfinished rename of '${oldSlug}' to '${newSlug}' was planned with the title '${existing!.plan.new_title}'; finish it with that title.`);
  }

  if (parsed.flags.has('preflight')) {
    if (!resuming) assertRenamable(context);
    const plan = resuming ? existing!.plan : buildPlan(context);
    return {
      schema: 1,
      operation: 'Rename Project Hub (preflight)',
      plan_id: plan.plan_id,
      resuming,
      steps_done: resuming ? existing!.done : [],
      ...describe(plan),
      mentions_left_alone: mentions(context) as unknown as PsJsonValue,
      mentions_in_new_hub: newHubMentions(context, plan) as unknown as PsJsonValue,
      mentions_in_new_hub_note: NEW_HUB_MENTIONS_NOTE,
      confirmation_required: true,
      next: `library hub rename ${oldSlug} ${newSlug} --title "${newTitle}" --user-confirmed --plan-id ${plan.plan_id}`,
      shared_library_write: false,
    };
  }
  if (!parsed.flags.has('user-confirmed')) refuse('The rename is not performed yet: run it with --preflight, show the reader what it reports, and rerun with --user-confirmed --plan-id <id> after one clear yes.');
  const approved = parsed.options.get('plan-id') ?? '';
  const timeout = Number(parsed.options.get('lock-timeout') ?? '20');

  return withBookLocks(
    workspace,
    ['collection/projects', 'collection/archive', `projects/${oldSlug}`, `projects/${newSlug}`, SEAT_REGISTRY_LOCK_ROOT],
    Number.isFinite(timeout) ? timeout : 20,
    () => {
      let journal: Journal;
      const current = readJournal(journalFile);
      if (current !== null && current.state !== 'complete') {
        journal = current;
      } else {
        // RE-JUDGED UNDER THE LOCKS: the preview ran with nobody excluded.
        assertRenamable(context);
        const plan = buildPlan(context);
        if (approved !== plan.plan_id) {
          refuse('The rename was not performed: rerun the preflight and pass its exact plan_id. A different plan_id means something changed since you approved it.');
        }
        journal = { schema: 1, plan, done: [], state: 'running' };
        writeJournal(journalFile, journal);
      }
      if (approved !== journal.plan.plan_id) refuse(`An unfinished rename is in its journal under plan_id ${journal.plan.plan_id}; pass that one to finish it.`);
      for (const step of STEPS) {
        if (journal.done.includes(step)) continue;
        runStep(context, journal.plan, step);
        journal.done.push(step);
        writeJournal(journalFile, journal);
        // THE CRASH A SELF-TEST NEEDS, as `migrate --fault-after` and LIBRARY_IMPORT_FAULT_AFTER give theirs.
        if ((process.env['LIBRARY_HUB_RENAME_FAULT_AFTER'] ?? '') === step) refuse(`Stopped after step '${step}' (LIBRARY_HUB_RENAME_FAULT_AFTER).`);
      }
      journal.state = 'complete';
      writeJournal(journalFile, journal);
      return {
        schema: 1,
        operation: 'Rename Project Hub',
        plan_id: journal.plan.plan_id,
        renamed: true,
        ...describe(journal.plan),
        source_tree_removed: fs.existsSync(path.join(context.collection, 'projects', oldSlug)) ? 'not-removed' : 'moved',
        mentions_left_alone: mentions(context) as unknown as PsJsonValue,
        mentions_in_new_hub: newHubMentions(context, journal.plan) as unknown as PsJsonValue,
        mentions_in_new_hub_note: NEW_HUB_MENTIONS_NOTE,
        journal: path.relative(workspace, journalFile).split(path.sep).join('/'),
        shared_library_write: false,
      };
    },
  );
}
