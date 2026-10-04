/**
 * `library hub edit <slug> --mode new-page`: a new page in a Project Hub on a local collection
 * (PLAN-local-collection-writers.md step B; deskpost-prompts-dev's Report "No route creates a new Project Hub notes
 * page on a local collection").
 *
 * A MODE OF `hub edit`, NOT A NEW VERB (Eric's Q2): the same fence, the same Desk gate -- the Hub open at THIS seat --
 * and the same `projects/<slug>` lock and playbook section. Its write half is its own, because the edit store
 * OVERWRITES (hubedit.ts, `localStore.write`) and a creation must never replace what is there.
 *
 * A CREATION CONTRACT. Under the lock: the Hub still active, the page still absent, the path still inside the Hub;
 * a journal saying the page was absent (`pending`); an exclusive create, after which -- and only after which -- the
 * journal says `created`; the write read back; the journal `complete`. A failure after `created` removes the file
 * only if its bytes are this run's, and says `rolled-back` only once the file is verified gone. Anything else -- the
 * bytes are not this run's, the file cannot be read, the removal fails -- is `recovery-required`, naming the file,
 * and a retry that meets that file is told which journal to read rather than only "already exists".
 *
 * LOCAL ONLY. A Hub on Basic Memory gains a page through tools/Copy-LocalPagesToProject.ps1, which is named.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readMarker } from './workspace.ts';
import { enterBookLock, exitBookLock, type BookLock } from './locks.ts';
import { sha256OfBytes, sha256OfText } from './sha.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { assertInsideRoot, lexists, renderPageBody } from './pagepath.ts';

class HubNewPageRefusal extends Error {}

function refuse(message: string): never {
  throw new HubNewPageRefusal(message);
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = ['_project', 'connections', 'readme'];

function journalDirectory(workspace: string): string {
  return path.join(workspace, 'internal', 'publication-journals');
}

/** A `recovery-required` new-page journal that names this page, so a retry can be told where to look. */
function recoveryJournalFor(workspace: string, pagePath: string): string | null {
  const directory = journalDirectory(workspace);
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory).filter((item) => item.startsWith('project-new-page-') && item.endsWith('.json')).sort().reverse()) {
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      if (journal['state'] === 'recovery-required' && journal['page_path'] === pagePath) return `internal/publication-journals/${name}`;
    } catch {
      /* an unreadable journal names nothing */
    }
  }
  return null;
}

export interface NewPageArguments {
  slug: string;
  page: string;
  content: string;
  contentPath: string;
  title: string;
  seat: string | undefined;
  preflight: boolean;
  lockTimeout: number;
}

/** A test hook, named in the self-test that uses it. */
function injectedFault(): string {
  return (process.env['LIBRARY_HUB_NEW_PAGE_FAULT'] ?? '').trim();
}

export function hubNewPage(options: NewPageArguments, workspace: string): Record<string, PsJsonValue> {
  const marker = readMarker(workspace);
  if (marker === null || String(marker['backend'] ?? '') !== 'local') {
    refuse(
      "hub edit --mode new-page makes a page in a local Library's own collection, and this workspace is attached to Basic Memory: " +
        'a page is added to a shared Hub with deskpost hub copy-pages <slug>. Nothing was written.',
    );
  }

  // ITS OWN GRAMMAR, AND IT SAYS SO: the other modes accept an existing page's capitals and spaces.
  let page = options.page.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (/\.md$/i.test(page)) page = page.substring(0, page.length - 3);
  if (!page) refuse('--mode new-page needs --page, for example notes/2026-09-28-a-decision.');
  const segments = page.split('/');
  if (segments.length === 1 && RESERVED.includes(segments[0]!.toLowerCase())) {
    refuse(`'${segments[0]}' is a page hub new seeds and only the other modes edit; --mode new-page makes a page beside them.`);
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      refuse(
        `Page segment '${segment}' must contain only lowercase letters, digits, and hyphens. That is new-page's own rule; ` +
          'the other modes edit an existing page whatever it is called.',
      );
    }
  }

  const collectionRoot = path.join(workspace, 'collection');
  const hubRoot = path.join(collectionRoot, 'projects', options.slug);
  const pagePath = `projects/${options.slug}/${page}.md`;
  const pageFull = path.join(hubRoot, ...`${page}.md`.split('/'));
  const hubIsActive = (): boolean => fs.existsSync(path.join(hubRoot, '_project.md'));
  if (!hubIsActive()) refuse(`There is no active Project Hub '${options.slug}' in this Library's collection. Nothing was written.`);

  // THIS SEAT'S DESK, as every mode reads it.
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: options.seat, stateDirectory });
  const openProjects = deskEntriesForSeat(stateDirectory, seat, 'projects');
  if (openProjects.includes(`archive/projects/${options.slug}`)) refuse(`Project '${options.slug}' is open from the archive shelf. Archived Project Hubs are read-only.`);
  if (!openProjects.includes(`projects/${options.slug}`)) {
    refuse(`Project '${options.slug}' is not open. Open it first: deskpost desk open project ${options.slug}`);
  }

  assertInsideRoot(hubRoot, `${page}.md`, `collection/projects/${options.slug}`);
  if (lexists(pageFull)) {
    const journal = recoveryJournalFor(workspace, pagePath);
    refuse(
      journal
        ? `'${pagePath}' is still on disk from a new-page run that could not be undone; read ${journal} before deciding what to keep.`
        : `'${pagePath}' already exists. --mode new-page only ever makes a page; to change this one use another mode.`,
    );
  }

  // THE BODY: exactly one of --content or --content-path, and an H1 or --title.
  const hasContent = options.content.trim() !== '';
  const hasPath = options.contentPath.trim() !== '';
  if (hasContent === hasPath) refuse('Supply exactly one of --content or --content-path.');
  let raw = options.content;
  let sourceFile: string | null = null;
  let sourceBytes: Buffer | null = null;
  if (hasPath) {
    sourceFile = path.resolve(path.isAbsolute(options.contentPath) ? options.contentPath : path.join(workspace, options.contentPath));
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) refuse(`ContentPath '${options.contentPath}' is not a file.`);
    try {
      sourceBytes = fs.readFileSync(sourceFile);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes).replace(/^﻿/, '');
    } catch (error) {
      refuse(`ContentPath '${options.contentPath}' is not valid UTF-8: ${(error as Error).message}`);
    }
  }
  if (!raw.trim()) refuse('The page body is empty; nothing was written.');
  const rendered = renderPageBody(raw, options.title);
  const proposedSha = sha256OfText(rendered.body);

  // COPY EVIDENCE: a Notebook page carried whole, which triage reads as covered (plan 0.6).
  let evidence: { path: string; source: string; sha256: string } | null = null;
  if (sourceFile !== null && sourceBytes !== null && rendered.titleSource === 'body H1') {
    const relative = path.relative(path.resolve(workspace), sourceFile).replace(/\\/g, '/');
    if (/^notebook\/.+\.md$/i.test(relative)) evidence = { path: pagePath, source: relative, sha256: sha256OfBytes(sourceBytes) };
  }

  const plan: Record<string, PsJsonValue> = {
    schema: 1,
    operation: 'Create a Project Hub page',
    project_slug: options.slug,
    page_path: pagePath,
    mode: 'NewPage',
    page_title: rendered.title,
    title_source: rendered.titleSource,
    proposed_sha256: proposedSha,
    proposed_line_count: rendered.body.split('\n').length - 1,
    confirmation_required: false,
    shared_library_write: false,
  };
  if (options.preflight) return plan;

  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const label = page.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // A UNIQUE NAME, CREATED EXCLUSIVELY (inspection): `notes/a-b` and `notes/a/b` share a label, and two runs in one
  // second with one body would otherwise share a journal.
  const journalPath = path.join(journalDirectory(workspace), `project-new-page-${options.slug}-${label}-${stamp}-${randomUUID().replace(/-/g, '').substring(0, 12)}.json`);
  let journalCreated = false;
  const saveJournal = (state: string, errorText: string, surviving: string | null = null): void => {
    const journal: Record<string, PsJsonValue> = {
      state,
      operation: 'project-new-page',
      timestamp_utc: now.toISOString(),
      project_slug: options.slug,
      page_path: pagePath,
      previous_state: 'absent',
      proposed_sha256: proposedSha,
      planned_records: state === 'complete' && evidence !== null ? [evidence] : [],
      surviving_path: surviving,
      error: errorText,
    };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, psConvertToJson(journal), { encoding: 'utf8', flag: journalCreated ? 'w' : 'wx' });
    journalCreated = true;
  };

  let lock: BookLock | null = null;
  let created = false;
  const createdDirectories: string[] = [];
  try {
    lock = enterBookLock(workspace, `projects/${options.slug}`, options.lockTimeout);
    // AGAIN, UNDER THE LOCK: the preview's checks ran with nobody excluded.
    if (!hubIsActive()) refuse(`Project Hub '${options.slug}' left the active shelf after this page was planned. Nothing was written.`);
    assertInsideRoot(hubRoot, `${page}.md`, `collection/projects/${options.slug}`);
    if (lexists(pageFull)) refuse(`'${pagePath}' was created while this page was being prepared. Nothing was written.`);
    saveJournal('pending', '');

    let parent = path.dirname(pageFull);
    while (!fs.existsSync(parent)) {
      createdDirectories.push(parent);
      parent = path.dirname(parent);
    }
    if (createdDirectories.length) fs.mkdirSync(path.dirname(pageFull), { recursive: true });
    // CREATED THE MOMENT THE FILE EXISTS (inspection): a write that fails after the exclusive open -- a full disk --
    // leaves a file, and the recovery below must see it as this run's.
    const descriptor = fs.openSync(pageFull, 'wx');
    created = true;
    try {
      saveJournal('created', '');
      const written = fs.writeSync(descriptor, rendered.body, null, 'utf8');
      if (written !== Buffer.byteLength(rendered.body, 'utf8')) refuse(`Only ${written} of ${Buffer.byteLength(rendered.body, 'utf8')} bytes of ${pagePath} were written.`);
    } finally {
      fs.closeSync(descriptor);
    }

    const fault = injectedFault();
    if (fault === 'foreign') fs.writeFileSync(pageFull, '# Someone else\n\nWritten between the create and the readback.\n');
    const back = fs.readFileSync(pageFull, 'utf8');
    if (fault === 'readback' || fault === 'remove' || back !== rendered.body) {
      refuse(`The page was written but did not read back as the approved text: ${pagePath}`);
    }
    saveJournal('complete', '');
  } catch (error) {
    const failure = (error as Error).message;
    if (!created) {
      exitBookLock(lock);
      lock = null;
      throw error;
    }
    // UNDONE ONLY IF IT IS PROVABLY OURS AND PROVABLY GONE.
    let outcome: string;
    try {
      const bytes = fs.readFileSync(pageFull, 'utf8');
      if (bytes !== rendered.body) throw new Error('its bytes are no longer the ones this run wrote');
      if (injectedFault() === 'remove') throw new Error('the removal failed (injected)');
      fs.rmSync(pageFull, { force: true });
      if (lexists(pageFull)) throw new Error('it is still there after the removal');
      for (const directory of createdDirectories) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
      saveJournal('rolled-back', failure);
      outcome = 'the page was removed and verified gone; nothing is left';
    } catch (undo) {
      saveJournal('recovery-required', `${failure}; not undone: ${(undo as Error).message}`, pagePath);
      outcome = `the page is still on disk and was not removed (${(undo as Error).message}); read ${path.relative(workspace, journalPath).replace(/\\/g, '/')}`;
    }
    refuse(`The page was not made. ${failure}. Rollback: ${outcome}.`);
  } finally {
    exitBookLock(lock);
  }

  return {
    ...plan,
    journal_path: journalPath,
    written_sha256: proposedSha,
    written: true,
    // `status` AND `journal` AS collection add-page SAYS THEM (S72 row 5); `written` and `journal_path` stay.
    status: 'written',
    journal: path.relative(workspace, journalPath).replace(/\\/g, '/'),
    next:
      `Read it with mcp__validated-book-reader__read_open_project_page (${options.slug}, ${page}). To link it from the Hub, ` +
      `add a line under Next: deskpost hub edit ${options.slug} --mode append-section --section Next --content "- [[${pagePath.replace(/\.md$/, '')}]]"`,
  };
}
