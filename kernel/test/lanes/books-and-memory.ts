/**
 * THE BOOKS-AND-MEMORY LANE'S SELF-TEST SECTIONS (PLAN-lane-test-files.md; kickoffs/s210 row 1). This lane's new sections go here,
 * numbered in its range in docs/areas.json `section_ranges` (1200 to 1399), and claim their kernel/src files in
 * `books-and-memory.covers.json` beside this file. kernel/test/selftest.ts awaits `runLane` after its last own section, so all of
 * its initialization has run; the names below are its helpers (./harness.ts says what each is).
 *
 * THE FORMAT IS THE PARSERS' OWN, AT COLUMN ZERO (tools/section-select.mts `sectionRanges`, kernel/test/run-parallel.ts
 * `sectionNumbers` and `knownDeclaredSkips`, tools/ci-manifest.mts): each section is a top-level `async function
 * sectionN(): Promise<void> {` whose closing `}` is at column zero, and `runLane` holds one dispatch line per section at
 * column zero, `if (selected(N)) await sectionN();` or `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))
 * await sectionN();` on one line, in number order. No formatter runs on this file.
 */
import type { Harness } from './harness.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpSession } from '../../src/basicmemory.ts';
import { createHash } from 'node:crypto';
import { createNote } from '../../src/bmwrite.ts';

/** A child server: synchronous CLI calls must not block its event loop. */
async function startFakeBasicMemory(folder: string, extra: string[] = []): Promise<{ url: string; stop(): void }> {
  const portFile = path.join(os.tmpdir(), `kernel-fake-bm-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.port`);
  const child = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), folder, portFile, ...extra], { stdio: 'ignore' });
  const until = Date.now() + 15000;
  while (!(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim())) {
    if (Date.now() > until) { child.kill(); throw new Error('the stand-in Basic Memory server did not start'); }
    await sleep(50);
  }
  const port = fs.readFileSync(portFile, 'utf8').trim();
  fs.rmSync(portFile, { force: true });
  return { url: `http://127.0.0.1:${port}/mcp`, stop: () => { child.kill(); } };
}

/** Isolated Library, seat, and shared collection; no real connection or home is inherited. */
async function fixture(label: string, extra: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kernel-c156-${label}-`));
  const workspace = path.join(root, 'ws'), storage = path.join(root, 'server');
  const put = (relative: string, text: string) => { const full = path.join(root, relative); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); return full; };
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent.pid), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const cli = (args: string[], more: Record<string, string> = {}) => runCli([...args, '--workspace', workspace], { cwd: root, env: { ...env, ...more } });
  const json = (r: { stdout: string }): Record<string, any> => { try { return JSON.parse(r.stdout); } catch { return {}; } };
  let server: { url: string; stop(): void } | null = null;
  const dispose = async () => {
    server?.stop(); agent.kill();
    // Only this fixture's disposable Library, storage and registry are removed.
    for (let n = 0; n < 50; n++) { try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { await sleep(100); } }
    throw new Error(`fixture cleanup failed: ${root}`);
  };
  try {
    equal(runCli(['init', workspace, '--registry-root', env.LIBRARY_WORKSPACES], { cwd: root, env }).exit, 0, `${label}: init`);
    equal(cli(['hub', 'new', 'alpha', '--title', 'Alpha']).exit, 0, `${label}: Hub`);
    const enter = ['seat', 'enter', 'first', '--create', '--project', 'alpha', '--agent-pid', String(agent.pid), '--deadline-seconds', '10'];
    equal(cli([...enter, '--plan-id', String(json(cli([...enter, '--preflight']))['plan_id'])]).exit, 0, `${label}: seat`);
    put('server/books/README.md', '# Books\n\n## Open a Book\n');
    put('server/projects/README.md', '# Projects\n\n## Projects\n');
    server = await startFakeBasicMemory(storage, ['--call-log', ...extra]);
    const session = new McpSession(server.url, `selftest-${label}`); await session.initialize();
    put('ws/internal/postbox/state.json', JSON.stringify({ schema: 1, url: server.url, project_name: 'deskpost', project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', library_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', library_card: 'Home', server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    const setup = cli(['basic-memory', 'setup', '--url', server.url, '--collection', 'stand-in-collection', '--shared-writes', 'on', '--json']);
    equal(setup.exit, 0, `${label}: connection ${setup.stderr}`);
    const gated = (args: string[]) => { const p = cli([...args, '--seat', 'first', '--preflight', '--json']); return cli([...args, '--seat', 'first', '--user-confirmed', '--plan-id', String(json(p)['plan_id']), '--json']); };
    const book = (slug: string, map = '# Reader map\n') => {
      put(`ws/collection/books/${slug}/wiki/_book.md`, `# ${slug}\n`);
      put(`ws/collection/books/${slug}/wiki/_index.md`, map);
      fs.appendFileSync(path.join(workspace, 'collection/books/README.md'), `\n- [[books/${slug}/wiki/_book|${slug}]] — A fixture Book.\n`);
    };
    return { root, workspace, storage, put, cli, json, gated, book, dispose, session };
  } catch (error) { await dispose(); throw error; }
}

async function section1200(): Promise<void> {
  const f = await fixture('1200');
  try {
    for (const slug of ['empty', 'resume', 'missing']) f.book(slug, slug === 'missing' ? '# Map\n\n[[books/missing/wiki/absent|Absent]]\n' : '# Map\n\nNo local links.\n');
    const empty = f.gated(['shared', 'promote', 'empty']);
    check(empty.exit === 0, `1200: no-links promote finishes: ${empty.stderr}`);
    // The precise old stop: shared copies exist, local archive moved, Catalog not written.
    for (const name of ['_book', '_index']) await createNote(f.session, 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', `books/resume/wiki/${name}.md`, fs.readFileSync(path.join(f.workspace, `collection/books/resume/wiki/${name}.md`), 'utf8'));
    const resumeFiles = Object.fromEntries(['_book', '_index'].map(name => [`wiki/${name}.md`, createHash('sha256').update(fs.readFileSync(path.join(f.workspace, `collection/books/resume/wiki/${name}.md`))).digest('hex')]));
    f.put('ws/internal/shared-promote/resume.json', JSON.stringify({ slug: 'resume', collection_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', files: resumeFiles, relinked: resumeFiles, shared_pages: Object.fromEntries(Object.keys(resumeFiles).map(name => [`books/resume/${name}`, createHash('sha256').update(fs.readFileSync(path.join(f.workspace, `collection/books/resume/${name}`), 'utf8').trim()).digest('hex')])) }));
    f.put('server/books/README.md', fs.readFileSync(path.join(f.storage, 'books/README.md'), 'utf8') + '\n- [[books/resume/wiki/_book|resume]] — A fixture Book.\n');
    fs.mkdirSync(path.join(f.workspace, 'collection/archive'), { recursive: true });
    fs.renameSync(path.join(f.workspace, 'collection/books/resume'), path.join(f.workspace, 'collection/archive/resume'));
    const resumed = f.gated(['shared', 'promote', 'resume']);
    check(resumed.exit === 0, `1200: stopped no-links promote resumes: ${resumed.stderr}`);
    const missing = f.gated(['shared', 'promote', 'missing']);
    check(missing.exit !== 0 && missing.stderr.includes('missing page: archive/missing/wiki/absent.md'), `1200: missing target refused by name: ${missing.stderr}`);
    // The legacy shared writer has the same rule on its supported legacy surface.
    const legacy = await startFakeBasicMemory(f.storage, ['--surface', 'legacy']);
    try {
      f.put('server/books/legacy/wiki/_book.md', '# Legacy\n'); f.put('server/books/legacy/wiki/_index.md', '# Empty map\n');
      const legacyWorkspace = path.join(f.root, 'legacy');
      equal(runCli(['init', legacyWorkspace, '--registry-root', path.join(f.root, 'legacy-reg')]).exit, 0, '1200: legacy init');
      const marker = JSON.parse(fs.readFileSync(path.join(legacyWorkspace, '.library/workspace.json'), 'utf8'));
      marker.backend = 'basic-memory'; marker.collection_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
      f.put('legacy/.library/workspace.json', JSON.stringify(marker));
      f.put('legacy/.claude/.library-mcp-url', legacy.url); f.put('legacy/.claude/.library-project', marker.collection_id);
      f.put('legacy/.claude/.library-shared-root', f.storage);
      const result = runCli(['shared', 'archive', 'legacy', '--workspace', legacyWorkspace, '--user-confirmed', '--json']);
      check(result.exit === 0, `1200: legacy no-links archive finishes: ${result.stderr}`);
    } finally { legacy.stop(); }
  } finally { await f.dispose(); }
}

let selected: Harness['selected'], prerequisite: Harness['prerequisite'], check: Harness['check'], equal: Harness['equal'], same: Harness['same'];
let failures: Harness['failures'], runCli: Harness['runCli'], runCliAsync: Harness['runCliAsync'];
let HERE: Harness['HERE'], PROGRAM_ROOT: Harness['PROGRAM_ROOT'], KERNEL_COMMAND: Harness['KERNEL_COMMAND'], isCompiled: Harness['isCompiled'];

async function section1201(): Promise<void> {
  const f = await fixture('1201');
  try {
    for (const slug of ['one', 'two', 'changed']) f.book(slug);
    const args = (slug: string) => ['shared', 'promote', slug, '--seat', 'first'];
    const plans = new Map(['one', 'two', 'changed'].map(slug => [slug, f.json(f.cli([...args(slug), '--preflight', '--json']))['plan_id']]));
    const apply = (slug: string) => f.cli([...args(slug), '--user-confirmed', '--plan-id', String(plans.get(slug)), '--json']);
    equal(apply('one').exit, 0, '1201: first prepared promote applies');
    const second = apply('two');
    equal(second.exit, 0, `1201: unrelated Catalog line keeps second plan valid: ${second.stderr}`);
    const catalog = path.join(f.storage, 'books/README.md');
    fs.appendFileSync(catalog, '\n- [[books/changed/wiki/_book|Other title]] — Another writer.\n');
    const changed = apply('changed');
    check(changed.exit !== 0 && (changed.stderr.includes('plan_id') || changed.stderr.includes('already lists shared/changed')), `1201: own-line change refuses: ${changed.stderr}`);
    check(!fs.existsSync(path.join(f.storage, 'books/changed/wiki/_book.md')), '1201: stale own-line plan wrote nothing');
  } finally { await f.dispose(); }
}

async function section1202(): Promise<void> {
  const f = await fixture('1202');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Title rule.']).exit, 0, '1202: shared Book');
    const content = f.put('content.md', '---\ntitle: start\n---\n# Start\n');
    const args = ['shared', 'add-page', 'demo', 'start', '--content-path', content, '--seat', 'first'];
    const preview = f.cli([...args, '--preflight', '--json']);
    check(preview.exit === 0 && String(f.json(preview)['scope']).includes('title: start'), `1202: preview names file-name title: ${preview.stdout} ${preview.stderr}`);
    equal(f.gated(args).exit, 0, '1202: matching title accepted');
    f.put('content.md', '---\ntitle: Different\n---\n# Body\n');
    f.put('server/.calls.log', '');
    const refused = f.cli(['shared', 'add-page', 'demo', 'other', '--content-path', content, '--seat', 'first', '--preflight', '--json']);
    check(refused.exit !== 0 && refused.stderr.includes('Different') && refused.stderr.includes('other') && refused.stderr.includes('file name'), `1202: different title refused with both titles: ${refused.stderr}`);
    equal(fs.readFileSync(path.join(f.storage, '.calls.log'), 'utf8'), '', '1202: title mismatch sends nothing');
  } finally { await f.dispose(); }
}

async function section1203(): Promise<void> {
  const started = Date.now(), f = await fixture('1203');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Round trip.']).exit, 0, '1203: shared Book');
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1203: open shared Book');
    const content = f.put('content.md', '# Start\n\nThe original body.\n');
    const read = () => f.cli(['mcp', 'call', 'read_open_book_page', '--slug', 'demo', '--page', 'start', '--place', 'shared', '--seat', 'first']);
    for (const writer of ['add-page', 'replace-page']) {
      f.put('content.md', `# Start\n\nBody from ${writer}.\n`);
      equal(f.gated(['shared', writer, 'demo', 'start', '--content-path', content]).exit, 0, `1203: initial ${writer}`);
      const before = read(); equal(before.exit, 0, `1203: validated reader after ${writer}`);
      const page = JSON.parse(before.stdout).result.content[0].text as string;
      f.put('content.md', page);
      const returned = f.gated(['shared', 'replace-page', 'demo', 'start', '--content-path', content]);
      equal(returned.exit, 0, `1203: ${writer} returned page accepted: ${returned.stderr}`);
      equal(f.json(returned)['status'], 'unchanged', `1203: ${writer} returned text unchanged`);
      const after = read();
      const again = JSON.parse(after.stdout).result.content[0].text as string;
      equal(again, page, `1203: ${writer} reader text preserved`);
      equal((again.match(/^---$/gm) ?? []).length, 2, `1203: ${writer} one frontmatter block: ${again}`);
      equal(f.json(f.gated(['shared', 'replace-page', 'demo', 'start', '--content-path', content]))['status'], 'unchanged', `1203: ${writer} second pass unchanged`);
    }
    // EVERY SHARED WRITER TAKES THE READER'S TEXT BACK (kickoffs/s211 row 3): get-page's file, and a section append.
    const taken = path.join(f.root, 'taken', 'start.md');
    const got = f.cli(['shared', 'get-page', 'demo', 'start', '--out', taken, '--seat', 'first', '--json']);
    equal(got.exit, 0, `1203: get-page writes the reader's text: ${got.stderr}`);
    if (!fs.existsSync(taken)) f.put('taken/start.md', JSON.parse(read().stdout).result.content[0].text as string);
    const gotBack = f.gated(['shared', 'replace-page', 'demo', 'start', '--content-path', taken]);
    equal(f.json(gotBack)['status'], 'unchanged', `1203: get-page's file passed back is unchanged: ${gotBack.stderr}`);
    f.put('content.md', '- one\n');
    equal(f.gated(['shared', 'replace-page', 'demo', 'start', '--add-section', 'Log', '--content-path', content]).exit, 0, '1203: a section added');
    const logged = JSON.parse(read().stdout).result.content[0].text as string;
    f.put('content.md', '- two\n');
    const appended = f.gated(['shared', 'replace-page', 'demo', 'start', '--append-section', 'Log', '--content-path', content]);
    equal(appended.exit, 0, `1203: one line appended to a page read through the reader: ${appended.stderr}`);
    const plusOne = JSON.parse(read().stdout).result.content[0].text as string;
    equal(plusOne, logged + '- two\n', "1203: the reader's text is the old text plus that line");
    equal((plusOne.match(/^---$/gm) ?? []).length, 2, `1203: one frontmatter block after the append: ${plusOne}`);
    const current = JSON.parse(read().stdout).result.content[0].text as string;
    f.put('content.md', current.replace(/^title:.*$/m, 'title: Another'));
    const changed = f.cli(['shared', 'replace-page', 'demo', 'start', '--content-path', content, '--seat', 'first', '--preflight', '--json']);
    check(changed.exit !== 0 && changed.stderr.includes('body-only'), `1203: altered frontmatter refused: ${changed.stderr}`);
  } finally { await f.dispose(); console.log(`1203 measured seconds: ${((Date.now() - started) / 1000).toFixed(3)}`); }
}

async function section1205(): Promise<void> {
  const f = await fixture('1205');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Placeholders.']).exit, 0, '1205: shared Book');
    const content = f.put('content.md', '# Start\nBody.\n');
    equal(f.gated(['shared', 'add-page', 'demo', 'start', '--content-path', content]).exit, 0, '1205: seed page');
    for (const writer of ['add-page', 'replace-page']) for (const placeholder of ['{now}', '{today}']) {
      f.put('content.md', `# Body\n${placeholder}\n`); f.put('server/.calls.log', '');
      const result = f.cli(['shared', writer, 'demo', writer === 'add-page' ? 'new' : 'start', '--content-path', content, '--seat', 'first', '--preflight', '--json']);
      check(result.exit !== 0 && result.stderr.includes(placeholder), `1205: ${writer} refuses ${placeholder}: ${result.stderr}`);
      equal(fs.readFileSync(path.join(f.storage, '.calls.log'), 'utf8'), '', `1205: ${writer} ${placeholder} sends nothing`);
    }
    f.put('content.md', '# Literal\n{{now}} and {{today}}\n');
    for (const writer of ['add-page', 'replace-page']) equal(f.gated(['shared', writer, 'demo', writer === 'add-page' ? 'literal' : 'start', '--content-path', content]).exit, 0, `1205: ${writer} doubled braces accepted`);
  } finally { await f.dispose(); }
}

async function section1206(): Promise<void> {
  const f = await fixture('1206');
  try {
    const { findOpenBookLines } = await import('../../src/fulltext.ts');
    f.book('local', '# Reader map\n\nMapneedle\n');
    f.put('ws/collection/books/local/wiki/page.md', '# Page\n\nMapneedle\n');
    const project = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    for (const [page, text] of [['_book', '# Remote\n'], ['_index', '# Reader map\n\nMapneedle\n'], ['page', '# Page\n\nMapneedle\n']]) await createNote(f.session, project, `books/remote/wiki/${page}.md`, text!);
    const desk = path.join(f.root, 'desk');
    f.put('desk/.open-books', 'books/local\nshared/remote\n');
    const found = await findOpenBookLines({ workspace: f.workspace, deskStateDirectory: desk, query: 'Mapneedle' });
    equal(found.results.length, 2, `1206: only the two pages match: ${JSON.stringify(found.results)}`);
    check(found.results.every(hit => hit.page === 'page') && found.results.some(hit => hit.book_root === 'shared/remote') && found.results.some(hit => hit.book_root === 'books/local'), '1206: local and shared top reader maps skipped');
  } finally { await f.dispose(); }
}

async function section1207(): Promise<void> {
  const f = await fixture('1207');
  try {
    const { findOpenBookLines, formatFullTextResult } = await import('../../src/fulltext.ts');
    const project = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    for (const slug of ['one', 'two']) for (const page of ['_book', 'a', 'b']) await createNote(f.session, project, `books/${slug}/wiki/${page}.md`, `# ${page}\n\nNeedle\n`);
    f.put('desk/.open-books', 'shared/one\nshared/two\n');
    f.put('server/.calls.log', '');
    const found = await findOpenBookLines({ workspace: f.workspace, deskStateDirectory: path.join(f.root, 'desk'), query: 'Needle', limits: { maxFilesScanned: 1 } });
    const coverage = found as unknown as Record<string, any>;
    equal(found.books_searched, 0, '1207: neither Book counted fully searched');
    equal(coverage['books_partly_searched']?.map((b: any) => b.book).join(), 'one', '1207: first Book named partly searched');
    equal(coverage['books_not_reached']?.map((b: any) => b.book).join(), 'two', '1207: second Book named not reached');
    const words = formatFullTextResult(found);
    check(words.includes('partly searched: one') && words.includes('not reached: two'), `1207: formatted answer names both: ${words}`);
    const log = fs.readFileSync(path.join(f.storage, '.calls.log'), 'utf8');
    equal(log.split('\n').filter(line => line.includes('"tool":"bm_read"')).length, 1, '1207: exactly one page read under the budget');
    check(!log.includes('"path":"books/two/wiki"'), '1207: unreached Book was not listed');
    // Closing after a query still removes a Book's coverage on the unconditional second Desk read.
    f.put('desk/.open-books', 'shared/two\n');
    const closed = await findOpenBookLines({ workspace: f.workspace, deskStateDirectory: path.join(f.root, 'desk'), query: 'Needle', limits: { maxFilesScanned: 1 } });
    check(!String(JSON.stringify((closed as unknown as Record<string, unknown>)['books_partly_searched'])).includes('one'), '1207: closed Book contributes no partial coverage');
  } finally { await f.dispose(); }
}

async function section1208(): Promise<void> {
  const f = await fixture('1208');
  try {
    const { findOpenBookLines, formatFullTextResult } = await import('../../src/fulltext.ts');
    f.put('desk/.open-books', '');
    const options = { workspace: f.workspace, deskStateDirectory: path.join(f.root, 'desk') };
    const phrase = formatFullTextResult(await findOpenBookLines({ ...options, query: 'small longestword' }));
    check(phrase.includes("The phrase 'small longestword' was matched whole, as written. Try one word, such as 'longestword'."), `1208: empty phrase result explains matching: ${phrase}`);
    const single = formatFullTextResult(await findOpenBookLines({ ...options, query: 'longestword' }));
    check(!single.includes('was matched whole'), '1208: single word has no phrase advice');
  } finally { await f.dispose(); }
}

async function section1204(): Promise<void> {
  const f = await fixture('1204');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Map.']).exit, 0, '1204: Book');
    const content = f.put('content.md', '# Page\nBody.\n');
    const args = ['shared', 'add-page', 'demo', 'page', '--content-path', content];
    const map = path.join(f.storage, 'books/demo/wiki/_index.md');
    const stale = f.json(f.cli([...args, '--seat', 'first', '--preflight', '--json']));
    fs.appendFileSync(map, '\nAnother writer.\n');
    const refused = f.cli([...args, '--seat', 'first', '--user-confirmed', '--plan-id', stale['plan_id'], '--json']);
    check(refused.exit !== 0 && refused.stderr.includes('plan_id'), '1204: changed map refuses stale preview');
    const added = f.gated(args);
    equal(added.exit, 0, `1204: add ${added.stderr}`);
    check(fs.readFileSync(map, 'utf8').includes('[[books/demo/wiki/page|page]]'), '1204: added page listed');
    check(typeof f.json(added)['map_record_id'] === 'string', '1204: map change recorded');
    for (const from of [true, false]) {
      equal(f.gated(['shared', 'remove-page', 'demo', 'page', ...(from ? ['--from-change', f.json(added)['record_id']] : [])]).exit, 0, '1204: remove');
      check(!fs.readFileSync(map, 'utf8').includes('[[books/demo/wiki/page|page]]'), '1204: removed page dropped');
      if (from) equal(f.gated(args).exit, 0, '1204: add again');
    }
    fs.appendFileSync(map, '\n- [[books/demo/wiki/page|page]]\n');
    const before = fs.readFileSync(map, 'utf8');
    const listed = f.gated(args);
    equal(listed.exit, 0, '1204: already listed add');
    equal(fs.readFileSync(map, 'utf8'), before, '1204: already listed map untouched');
    check(!('map_record_id' in f.json(listed)), '1204: no redundant map record');
    // Seed a second isolated connection so call seven is the map write: two page record writes,
    // the page, then three map record writes. The stand-in changes that target just before writing.
    const race = await fixture('1204-race', ['--change-before', 'bm_write:7']);
    try {
      race.put('server/books/demo/wiki/_book.md', '# Demo\n');
      race.put('server/books/demo/wiki/_index.md', '# Map\n');
      const file = race.put('content.md', '# Page\n');
      const r = race.gated(['shared', 'add-page', 'demo', 'page', '--content-path', file]);
      equal(r.exit, 0, `1204: map conflict retried ${r.stderr}`);
      const text = fs.readFileSync(path.join(race.storage, 'books/demo/wiki/_index.md'), 'utf8');
      check(text.includes('[[books/demo/wiki/page|page]]') && text.includes('another writer'), `1204: retry preserves other writer: ${text}`);
      check(fs.readFileSync(path.join(race.storage, '.writes.log'), 'utf8').split('\n').filter(x => x.endsWith('|books/demo/wiki/_index.md')).length === 2, '1204: map attempted twice');
    } finally { await race.dispose(); }
  } finally { await f.dispose(); }
}

async function section1209(): Promise<void> {
  const started = Date.now();
  const { splitLocalFrontmatter } = await import('../../src/localcatalog.ts');
  const { noteBody } = await import('../../src/basicmemory.ts');
  const { stripTypeScriptTypes } = await import('node:module');
  const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'kernel/src/sharedwrite.ts'), 'utf8');
  // Run the production readers, rather than copies of their frontmatter patterns.
  const sameSource = source.match(/function sameText\([\s\S]*?\n\}/)![0];
  const sameReader = new Function('splitLocalFrontmatter', 'bodyOf', stripTypeScriptTypes(sameSource) + '; return sameText;')(splitLocalFrontmatter, (content: string) => noteBody({ file_path: '', title: '', content }));
  const withoutSource = source.match(/const withoutFrontmatter = ([^\n]+);/)![1];
  const without = new Function('splitLocalFrontmatter', 'return ' + stripTypeScriptTypes(`const reader = ${withoutSource};`).replace(/^const reader = /, '').replace(/;\s*$/, '') + ';')(splitLocalFrontmatter);
  const expression = source.match(/const frontmatter = ([^\n]+);/)![1];
  const blockReader = new Function('splitLocalFrontmatter', 'proposed', 'return ' + expression + ';');
  for (const [name, text] of [
    ['none', '# Body\n'], ['plain', '---\ntitle: page\n---\n# Body\n'],
    ['BOM', '\uFEFF---\ntitle: page\n---\n# Body\n'], ['spaces', '---\ntitle: page\n--- \n# Body\n'],
    ['tab', '---\ntitle: page\n---\t\n# Body\n'], ['CRLF', '---\r\ntitle: page\r\n---\r\n# Body\r\n'],
    ['body delimiter', '---\ntitle: page\n---\n# Body\n---\nLater\n'],
  ]) {
    const expected = splitLocalFrontmatter(text!);
    equal(without(text), expected.body, `1209: ${name} withoutFrontmatter body agrees`);
    check(sameReader(expected.body, text), `1209: ${name} sameText agrees`);
    const got = blockReader(splitLocalFrontmatter, text);
    const block = typeof got === 'string' ? got : got === null ? '' : Array.isArray(got) ? got[0] : text!.slice(0, text!.length - got.body.length);
    equal(block, text!.slice(0, text!.length - expected.body.length), `1209: ${name} body-only block agrees`);
  }
  const f = await fixture('1209');
  try {
    f.put('server/books/demo/wiki/_book.md', '# Demo\n');
    const file = f.put('content.md', '# Body\n');
    f.put('server/books/demo/wiki/page.md', '---\ntitle: page\ntype: note\npermalink: books/demo/wiki/page\n---\n# Body\n');
    const current = fs.readFileSync(path.join(f.storage, 'books/demo/wiki/page.md'), 'utf8');
    f.put('content.md', '\uFEFF' + current);
    const returned = f.gated(['shared', 'replace-page', 'demo', 'page', '--content-path', file]);
    equal(f.json(returned)['status'], 'unchanged', `1209: BOM reader text writes nothing ${returned.stderr}`);
    f.put('content.md', current.replace('title: page', 'title: Different'));
    const different = f.cli(['shared', 'replace-page', 'demo', 'page', '--content-path', file, '--seat', 'first', '--preflight', '--json']);
    check(different.exit !== 0 && different.stderr.includes('body-only'), '1209: changed block refused');
  } finally { await f.dispose(); console.log(`1209 measured seconds: ${((Date.now() - started) / 1000).toFixed(3)}`); }
}

async function section1210(): Promise<void> {
  const f = await fixture('1210');
  try {
    const { findOpenBookLines, formatFullTextResult } = await import('../../src/fulltext.ts');
    for (const slug of ['moved', 'missing']) f.book(slug);
    fs.mkdirSync(path.join(f.workspace, 'collection/archive'), { recursive: true });
    for (const slug of ['moved', 'missing']) fs.renameSync(path.join(f.workspace, `collection/books/${slug}`), path.join(f.workspace, `collection/archive/${slug}`));
    f.put('ws/collection/archive/moved/wiki/_moved.md', '# Moved\n\nMoved to shared/moved.\n');
    f.put('desk/.open-books', 'books/moved\nbooks/missing\n');
    const result = await findOpenBookLines({ workspace: f.workspace, deskStateDirectory: path.join(f.root, 'desk'), query: 'needle' });
    const moved = result.books_unavailable.find(x => x['book'] === 'moved')!;
    check(String(moved['reason']).includes('moved to shared/moved'), `1210: moved Book named ${JSON.stringify(moved)}`);
    check(String(moved['repair']).includes('deskpost basic-memory open moved') && String(moved['repair']).includes('deskpost desk close book moved --location collection'), '1210: both moved commands');
    const missing = result.books_unavailable.find(x => x['book'] === 'missing')!;
    equal(missing['repair'], 'restore the Book directory, or close it with deskpost desk close book missing', '1210: missing restore advice preserved');
    check(formatFullTextResult(result).includes('moved to shared/moved'), '1210: tool text carries moved advice');
  } finally { await f.dispose(); }
}

async function section1211(): Promise<void> {
  const f = await fixture('1211');
  const legacy = await startFakeBasicMemory(f.storage, ['--surface', 'legacy']);
  try {
    const ws = path.join(f.root, 'legacy');
    equal(runCli(['init', ws, '--registry-root', path.join(f.root, 'legacy-reg')]).exit, 0, '1211: init');
    const marker = JSON.parse(fs.readFileSync(path.join(ws, '.library/workspace.json'), 'utf8'));
    marker.backend = 'basic-memory'; marker.collection_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    f.put('legacy/.library/workspace.json', JSON.stringify(marker));
    f.put('legacy/.claude/.library-mcp-url', legacy.url); f.put('legacy/.claude/.library-project', marker.collection_id);
    f.put('legacy/.claude/.library-shared-root', f.storage);
    for (const slug of ['empty', 'missing']) {
      f.put(`server/books/${slug}/wiki/_book.md`, `# ${slug}\n`);
      f.put(`server/books/${slug}/wiki/_index.md`, slug === 'empty' ? '# Map\nNo local links.\n' : '# Map\n[[books/missing/wiki/absent|Absent]]\n');
      f.put(`server/books/${slug}/nested/page.md`, '# Nested\n');
    }
    const empty = runCli(['shared', 'archive', 'empty', '--workspace', ws, '--user-confirmed', '--json']);
    equal(empty.exit, 0, `1211: legacy no-links archive finishes ${empty.stderr}`);
    check(fs.existsSync(path.join(f.storage, 'archive/empty/nested/page.md')), '1211: nested relative path moved');
    check(!fs.existsSync(path.join(f.storage, 'books/empty/wiki/_book.md')), '1211: source moved');
    const missing = runCli(['shared', 'archive', 'missing', '--workspace', ws, '--user-confirmed', '--json']);
    check(missing.exit !== 0 && missing.stderr.includes('missing page: archive/missing/wiki/absent.md'), `1211: missing link still refused ${missing.stderr}`);
    const moves = fs.readFileSync(path.join(f.storage, '.writes.log'), 'utf8').split('\n').filter(x => x.includes('|move books/empty -> archive/empty'));
    equal(moves.length, 1, '1211: one directory move line');
  } finally { legacy.stop(); await f.dispose(); }
}

async function section1212(): Promise<void> {
  const f = await fixture('1212');
  try {
    const { findOpenBookLines, formatFullTextResult } = await import('../../src/fulltext.ts');
    for (const [page, text] of [['_book', '# Demo\n'], ['_index', '# Map\n'], ['zlast', '# Last\n']]) await createNote(f.session, 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', `books/demo/wiki/${page}.md`, text!);
    f.put('desk/.open-books', 'shared/demo\n');
    const result = await findOpenBookLines({ workspace: f.workspace, deskStateDirectory: path.join(f.root, 'desk'), query: 'no hit', limits: { maxFilesScanned: 2 } });
    equal(result.pages_scanned, 2, `1212: both pages read ${JSON.stringify(result)}`);
    equal(result.pages_withheld.length, 0, `1212: no withheld pages ${JSON.stringify(result.pages_withheld)}`);
    equal(result.books_partly_searched.length, 0, '1212: exact last page fully searched');
    equal(result.books_searched, 1, '1212: exhausted complete Book counted searched');
    const clean = { ...result, query: 'small\tlongestword', match_count_is_floor: false, budget_note: '', books_partly_searched: [], books_not_reached: [] };
    check(formatFullTextResult(clean).includes("Try one word, such as 'longestword'."), '1212: phrase splits on tab');
    check(!formatFullTextResult({ ...clean, query: 'small longestword', books_unavailable: [{ book: 'broken', reason: 'unreadable', repair: 'repair' }] }).includes('was matched whole'), '1212: unreadable Book suppresses phrase hint');
    check(!formatFullTextResult({ ...clean, query: 'small longestword', pages_withheld: [{ book: 'demo', page: 'page', reason: 'unreadable' }] }).includes('was matched whole'), '1212: unreadable page suppresses phrase hint');
    check(!formatFullTextResult({ ...clean, query: 'small longestword', books_partly_searched: [{ book: 'demo' }] }).includes('was matched whole'), '1212: partial Book suppresses phrase hint');
  } finally { await f.dispose(); }
}

async function section1213(): Promise<void> {
  const f = await fixture('1213');
  try {
    f.book('demo'); f.put('ws/collection/books/demo/wiki/x/page.md', '# Secret body\n');
    f.put('ws/collection/projects/alpha/x/page.md', '# Secret body\n');
    f.put('ws/.claude/seats/first/.open-books', 'books/demo\n');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\n');
    for (const tool of ['read_open_book_page', 'read_open_project_page']) {
      const r = f.cli(['mcp', 'call', tool, '--slug', tool === 'read_open_book_page' ? 'demo' : 'alpha', '--page', 'notes/x/page', '--seat', 'first']);
      const envelope = f.json(r)['result'];
      const text = (envelope?.content?.[0]?.text ?? r.stderr).replace(/^(?:Book|Project) read rejected: /, '');
      check(envelope?.isError === true, `1213: ${tool} refuses`);
      equal(text.split('.')[0] + '.', tool === 'read_open_book_page' ? 'That page is not in this Book.' : 'That page is not in this Project.', `1213: ${tool} first sentence unchanged`);
      check(text.includes('Did you mean x/page?') && !text.includes('Secret body'), `1213: ${tool} suggests extra-prefix page ${text}`);
    }
  } finally { await f.dispose(); }
}

async function section1214(): Promise<void> {
  const f = await fixture('1214');
  try {
    f.book('letters'); f.book('closed');
    f.put('ws/collection/books/letters/wiki/notes/same.md', '# Private letter body\n');
    f.put('ws/collection/books/closed/wiki/notes/same.md', '# Closed body\n');
    f.put('ws/.claude/seats/first/.open-books', 'books/letters\n');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\n');
    const read = (page: string) => {
      const r = f.cli(['mcp', 'call', 'read_open_project_page', '--slug', 'alpha', '--page', page, '--seat', 'first']);
      return (f.json(r)['result']?.content?.[0]?.text ?? r.stderr).replace(/^Project read rejected: /, '');
    };
    const text = read('notes/same');
    check(text.startsWith('That page is not in this Project.'), '1214: first sentence unchanged');
    check(text.includes('read_open_book_page') && text.includes('letters') && text.includes('notes/same'), `1214: names open Book and read route ${text}`);
    check(!text.includes('Private letter body') && !text.includes('Closed body') && !text.includes("slug: closed"), '1214: no content or closed Book disclosed');
    equal(read('notes/absent'), "That page is not in this Project. A Project Hub's root page is '_project'.", '1214: absent everywhere preserves wording');
  } finally { await f.dispose(); }
}

async function section1216(): Promise<void> {
  const f = await fixture('1216');
  try {
    const gated = (args: string[]) => { const p = f.cli([...args, '--preflight', '--json']); return f.cli([...args, '--user-confirmed', '--plan-id', String(f.json(p)['plan_id']), '--json']); };
    f.book('empty', '# Map\nNo local links.\n');
    equal(gated(['shared', 'archive', 'empty']).exit, 0, '1216: no-links archive');
    const restored = gated(['shared', 'restore', 'empty']);
    equal(restored.exit, 0, `1216: no-links restore ${restored.stderr}`);
    const original = '# Map\n[[books/links/wiki/_book|Root]]\nbooks/links/wiki/_book\ncollection/books/links/wiki/_book\nshared/books/links/wiki/_book\n';
    f.book('links', original);
    equal(gated(['shared', 'archive', 'links']).exit, 0, '1216: path archive');
    equal(gated(['shared', 'restore', 'links']).exit, 0, '1216: path restore');
    equal(fs.readFileSync(path.join(f.workspace, 'collection/books/links/wiki/_index.md'), 'utf8'), original, '1216: all path forms round-trip');
    f.book('missing', '# Map\n[[books/missing/wiki/_book|Root]]\n');
    equal(gated(['shared', 'archive', 'missing']).exit, 0, '1216: seed missing-page archive');
    f.put('ws/collection/archive/missing/wiki/_index.md', '# Map\n[[archive/missing/wiki/absent|Absent]]\n');
    const missing = gated(['shared', 'restore', 'missing']);
    check(missing.exit !== 0 && missing.stderr.includes('missing page: books/missing/wiki/absent.md'), `1216: missing target still refused ${missing.stderr}`);
    check(!fs.existsSync(path.join(f.workspace, 'collection/books/missing')), '1216: missing page never moves Book');
  } finally { await f.dispose(); }
}

async function section1217(): Promise<void> {
  const f = await fixture('1217');
  try {
    equal(f.cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'Publish.']).exit, 0, '1217: Shelf Book');
    f.put('ws/shelf/demo/wiki/page.md', '# Page\nBody.\n');
    equal(f.cli(['shelf', 'rebuild', 'demo']).exit, 0, '1217: rebuild');
    f.put('ws/.claude/seats/first/.open-books', 'shelf/demo\n');
    const r = f.cli(['publish', 'demo', '--title', 'Demo', '--summary', 'Publish.', '--preflight', '--json']);
    equal(r.exit, 0, `1217: preview ${r.stderr}`);
    const route = String(f.json(r)['shared_route'] ?? '');
    check(route.includes('deskpost shared promote') && route.includes('shared new-book'), `1217: connected preview names shared route ${r.stdout}`);
  } finally { await f.dispose(); }
}

async function section1218(): Promise<void> {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'kernel/src/shelfcarry.ts'), 'utf8');
  const implementation = source.match(/function carriedBytes\([\s\S]*?\n\}/)![0];
  const carry = new Function('refuse', stripTypeScriptTypes(implementation) + '; return carriedBytes;')((message: string) => { throw new Error(message); });
  for (const tail of ['  go_words: still here\n', '\tgo_words: still here\r\n']) {
    const bytes = Buffer.from('---\nreview: pending\n---\n' + tail);
    let output: Buffer | undefined, error = '';
    try { output = carry(bytes, 'letter.md'); } catch (e) { error = (e as Error).message; }
    check(output === undefined && error.includes('still has go fields; nothing was carried'), `1218: surviving field refused: ${JSON.stringify(tail)}`);
    equal(bytes.toString('utf8'), '---\nreview: pending\n---\n' + tail, '1218: input untouched');
  }
  const ordinary = Buffer.from('---\r\nreview: pending\r\ngo_words: old\r\n---\r\nOrdinary letter.\r\n');
  const result = carry(ordinary, 'ordinary.md').toString('utf8');
  check(result.includes('Ordinary letter.') && !result.includes('go_words:'), '1218: ordinary letter carries without go field');
  // Node emits the TypeScript-strip warning on the next turn; leave the suite's result line last.
  await sleep(0);
}

async function section1219(): Promise<void> {
  // ONE SECTION OF A SHARED PAGE ADDED OR EXTENDED, AND NOTHING ELSE MOVES (kickoffs/s211 row 1).
  const f = await fixture('1219');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Sections.']).exit, 0, '1219: shared Book');
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1219: open shared Book');
    const content = f.put('content.md', '# Notes\n\nIntro line.\n\n## One\n\n- first item\n\n## Two\n\nSome prose.\n\n```text\n## not a heading\n```\n\n## Three\n\nLast line.\n');
    equal(f.gated(['shared', 'add-page', 'demo', 'notes', '--content-path', content]).exit, 0, '1219: seed page');
    const read = () => { const r = f.cli(['mcp', 'call', 'read_open_book_page', '--slug', 'demo', '--page', 'notes', '--place', 'shared', '--seat', 'first']); return JSON.parse(r.stdout).result.content[0].text as string; };
    const changes = (preview: Record<string, any>, tag: string) => ((preview['diff'] ?? []) as string[]).slice(2).filter((line) => line.startsWith(tag)).map((line) => line.slice(1));
    const cases: { option: string; heading: string; body: string; added: string[]; expected: (before: string) => string }[] = [
      { option: '--append-section', heading: 'One', body: '- second item\n', added: ['- second item'], expected: (before) => before.replace('- first item\n', '- first item\n- second item\n') },
      { option: '--append-section', heading: 'Two', body: 'More prose.\n', added: ['', 'More prose.'], expected: (before) => before.replace('```\n\n## Three', '```\n\nMore prose.\n\n## Three') },
      { option: '--add-section', heading: 'Four', body: 'Added body.\n', added: ['', '## Four', '', 'Added body.'], expected: (before) => before.replace(/\n+$/, '') + '\n\n## Four\n\nAdded body.\n' },
    ];
    for (const one of cases) {
      const before = read();
      check((before.match(/^---$/gm) ?? []).length === 2, `1219: ${one.option} ${one.heading}: the page has one frontmatter block: ${before}`);
      f.put('content.md', one.body);
      const args = ['shared', 'replace-page', 'demo', 'notes', one.option, one.heading, '--content-path', content, '--seat', 'first'];
      const preview = f.cli([...args, '--preflight', '--json']);
      const planned = f.json(preview);
      check(preview.exit === 0, `1219: ${one.option} ${one.heading} previews: ${preview.stderr}`);
      equal(changes(planned, '-').join('|'), '', `1219: ${one.option} ${one.heading} removes no line`);
      equal(changes(planned, '+').sort().join('|'), [...one.added].sort().join('|'), `1219: ${one.option} ${one.heading} adds exactly its lines`);
      const applied = f.cli([...args, '--user-confirmed', '--plan-id', String(planned['plan_id']), '--json']);
      equal(applied.exit, 0, `1219: ${one.option} ${one.heading} applies: ${applied.stderr}`);
      equal(read(), one.expected(before), `1219: ${one.option} ${one.heading}: every other byte of the reader's text is equal`);
    }
    const settled = read();
    const refusals: { why: string; body: string; args: string[]; names: string }[] = [
      { why: 'a level-two heading in the content', body: '## Sneaky\nline\n', args: ['--append-section', 'One'], names: '--append-section' },
      { why: 'a frontmatter block in the content', body: '---\ntitle: notes\n---\nline\n', args: ['--add-section', 'Five'], names: '--add-section' },
      { why: 'append to a missing section', body: 'line\n', args: ['--append-section', 'Missing'], names: '--add-section' },
      { why: 'add an existing section', body: 'line\n', args: ['--add-section', 'One'], names: '--append-section' },
      { why: 'both options', body: 'line\n', args: ['--append-section', 'One', '--add-section', 'Five'], names: '--add-section' },
    ];
    // EVERY REFUSAL ALSO ON APPLY (kickoffs/s211-r2 row 2, Nit 4): with the plan_id of an earlier preview, never applied.
    f.put('content.md', '- never applied\n');
    const earlier = String(f.json(f.cli(['shared', 'replace-page', 'demo', 'notes', '--append-section', 'One', '--content-path', content, '--seat', 'first', '--preflight', '--json']))['plan_id']);
    for (const one of refusals) {
      f.put('content.md', one.body);
      for (const mode of [['--preflight'], ['--user-confirmed', '--plan-id', earlier]]) {
        const refused = f.cli(['shared', 'replace-page', 'demo', 'notes', ...one.args, '--content-path', content, '--seat', 'first', ...mode, '--json']);
        check(refused.exit !== 0 && refused.stderr.includes(one.names), `1219: ${one.why} refused naming ${one.names} (${mode[0]}): ${refused.stdout} ${refused.stderr}`);
      }
    }
    for (const mode of [['--preflight'], ['--user-confirmed', '--plan-id', earlier]]) {
      const fromChange = f.cli(['shared', 'replace-page', 'demo', 'notes', '--append-section', 'One', '--from-change', '20261115T000000Z-aaaaaaaa-0000-4000-8000-000000000000-00000000', '--base', '--seat', 'first', ...mode, '--json']);
      check(fromChange.exit !== 0 && fromChange.stderr.includes('--from-change') && fromChange.stderr.includes('--append-section'), `1219: --from-change with --append-section refused (${mode[0]}): ${fromChange.stderr}`);
    }
    equal(read(), settled, '1219: every refusal wrote nothing');
    // A CRLF PAGE KEEPS ITS LINE ENDINGS (kickoffs/s211-r2 row 2, Nit 1). The stand-in folds CRLF on every write_note, so
    // the page is written through it and its stored file then given CRLF; the text sent is the one proposed_sha256 names,
    // which the plan_id binds and the apply writes.
    f.put('content.md', '# Crlf\n\nIntro.\n\n## One\n\n- first\n');
    equal(f.gated(['shared', 'add-page', 'demo', 'crlf', '--content-path', content]).exit, 0, '1219: seed the CRLF page');
    const stored = path.join(f.storage, 'books', 'demo', 'wiki', 'crlf.md');
    fs.writeFileSync(stored, fs.readFileSync(stored, 'utf8').replace(/\r?\n/g, '\r\n'));
    const crlfBody = '# Crlf\r\n\r\nIntro.\r\n\r\n## One\r\n\r\n- first\r\n';
    f.put('content.md', '- added\n');
    const crlfArgs = ['shared', 'replace-page', 'demo', 'crlf', '--append-section', 'One', '--content-path', content, '--seat', 'first'];
    const crlfPlan = f.json(f.cli([...crlfArgs, '--preflight', '--json']));
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    equal(crlfPlan['current_sha256'], digest(crlfBody), '1219: the CRLF page is read with its CRLF line endings');
    equal(crlfPlan['proposed_sha256'], digest(crlfBody + '- added\r\n'), '1219: a CRLF page gains its line with CRLF, every other byte equal');
    equal(f.cli([...crlfArgs, '--user-confirmed', '--plan-id', String(crlfPlan['plan_id']), '--json']).exit, 0, '1219: the CRLF append applies');
    // AN UPKEEP-GRANTED SEAT applies with --plan-id alone, as with a whole replace-page.
    equal(f.gated(['shared', 'upkeep', 'demo', '--seats', 'first']).exit, 0, '1219: upkeep granted');
    f.put('content.md', '- third item\n');
    const args = ['shared', 'replace-page', 'demo', 'notes', '--append-section', 'One', '--content-path', content, '--seat', 'first'];
    const kept = f.json(f.cli([...args, '--preflight', '--json']));
    equal(kept['confirmation_required'], false, '1219: an upkeep-granted section append needs no yes');
    const alone = f.cli([...args, '--plan-id', String(kept['plan_id']), '--json']);
    equal(alone.exit, 0, `1219: --plan-id alone applies under upkeep: ${alone.stderr}`);
    equal(read(), settled.replace('- second item\n', '- second item\n- third item\n'), '1219: the upkeep append added only its line');
  } finally { await f.dispose(); }
}

async function section1220(): Promise<void> {
  // A SHARED PAGE TAKEN OUT TO A FILE WITH THE READER'S HASH, AND THE PREVIEW NAMES THE SAME HASH (kickoffs/s211 row 2).
  const f = await fixture('1220');
  try {
    for (const slug of ['demo', 'other']) equal(f.gated(['shared', 'new-book', slug, '--title', slug, '--summary', 'Get page.']).exit, 0, `1220: shared Book ${slug}`);
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1220: open shared Book demo only');
    const content = f.put('content.md', '# Notes\n\nIntro line.\n\n## One\n\n- first item\n');
    for (const slug of ['demo', 'other']) equal(f.gated(['shared', 'add-page', slug, 'notes', '--content-path', content]).exit, 0, `1220: seed page in ${slug}`);
    const read = () => { const r = f.cli(['mcp', 'call', 'read_open_book_page', '--slug', 'demo', '--page', 'notes', '--place', 'shared', '--seat', 'first']); const items = JSON.parse(r.stdout).result.content; return { text: items[0].text as string, sha256: String(items[1]?.text ?? '').replace(/^sha256: /, '') }; };
    const before = read();
    check(/^[0-9a-f]{64}$/.test(before.sha256), `1220: the reader gives a hash: ${before.sha256}`);
    const out = path.join(f.root, 'out', 'notes.md');
    const got = f.cli(['shared', 'get-page', 'demo', 'notes', '--out', out, '--seat', 'first', '--json']);
    equal(got.exit, 0, `1220: get-page runs: ${got.stderr}`);
    const answer = f.json(got);
    equal(answer['sha256'], before.sha256, "1220: get-page's sha256 is the reader's");
    equal(createHash('sha256').update(fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0)).digest('hex'), before.sha256, "1220: the file's hash is the reader's");
    equal(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', before.text, "1220: the file is the reader's text, frontmatter and body");
    check(String(answer['next'] ?? '').includes('replace-page demo notes --content-path') && String(answer['next'] ?? '').includes('--preflight'), `1220: next takes it back: ${answer['next']}`);
    check(String(answer['page'] ?? '').includes('notes') && String(answer['out'] ?? '') !== '', `1220: page and out named: ${got.stdout}`);
    // A PATH WITH A SPACE STAYS ONE ARGUMENT in the next line (kickoffs/s211-r2 row 2, Nit 5).
    const spaced = path.join(f.root, 'out with space', 'notes.md');
    const spacedNext = String(f.json(f.cli(['shared', 'get-page', 'demo', 'notes', '--out', spaced, '--seat', 'first', '--json']))['next'] ?? '');
    check(spacedNext.includes(`--content-path '${spaced}'`) && spacedNext.includes('--preflight'), `1220: next quotes a path with a space: ${spacedNext}`);
    const closedOut = path.join(f.root, 'out', 'other.md');
    const closed = f.cli(['shared', 'get-page', 'other', 'notes', '--out', closedOut, '--seat', 'first', '--json']);
    check(closed.exit !== 0 && closed.stderr.includes('closed') && !fs.existsSync(closedOut), `1220: a Book closed on the Desk is refused with no file: ${closed.stderr}`);
    const taken = f.put('out/taken.md', 'keep me\n');
    const exists = f.cli(['shared', 'get-page', 'demo', 'notes', '--out', taken, '--seat', 'first', '--json']);
    check(exists.exit !== 0 && exists.stderr.includes('--out'), `1220: an existing --out is refused: ${exists.stderr}`);
    equal(fs.readFileSync(taken, 'utf8'), 'keep me\n', '1220: the existing file is kept');
    if (!fs.existsSync(out)) f.put('out/notes.md', before.text); // already failed above; the rest still runs
    const back = f.json(f.cli(['shared', 'replace-page', 'demo', 'notes', '--content-path', out, '--seat', 'first', '--preflight', '--json']));
    equal(back['status'], 'unchanged', '1220: the file passed back unchanged answers unchanged');
    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('Intro line.', 'Intro line, edited.'));
    const edited = f.cli(['shared', 'replace-page', 'demo', 'notes', '--content-path', out, '--seat', 'first', '--preflight', '--json']);
    const preview = f.json(edited);
    check(edited.exit === 0, `1220: the edited file previews: ${edited.stderr}`);
    const diff = ((preview['diff'] ?? []) as string[]).slice(2);
    equal(diff.filter((line) => line.startsWith('-')).join('|') + ' / ' + diff.filter((line) => line.startsWith('+')).join('|'), '-Intro line. / +Intro line, edited.', '1220: one line edited previews a one-line diff');
    equal(preview['reader_sha256'], before.sha256, "1220: the preview's reader_sha256 is the reader's hash before the write");
    equal(f.cli(['shared', 'replace-page', 'demo', 'notes', '--content-path', out, '--seat', 'first', '--user-confirmed', '--plan-id', String(preview['plan_id']), '--json']).exit, 0, '1220: the edit applies');
    equal(read().text, before.text.replace('Intro line.', 'Intro line, edited.'), "1220: the reader's text changed in that line only");
  } finally { await f.dispose(); }
}

async function section1221(): Promise<void> {
  // A SEARCH NAMES THE OPEN BOOKS IT READS (kickoffs/s211-r2 spare S1, train search-one-book).
  const f = await fixture('1221');
  try {
    const { answerReaderTool, readerContext } = await import('../../src/reader.ts');
    const { toolArgumentRefusal } = await import('../../src/mcpserve.ts');
    for (const slug of ['one', 'two', 'three']) {
      equal(f.gated(['shared', 'new-book', slug, '--title', slug, '--summary', 'Search one.']).exit, 0, `1221: shared Book ${slug}`);
      f.put('content.md', `# Page\n\nNeedle in ${slug}.\n`);
      equal(f.gated(['shared', 'add-page', slug, 'page', '--content-path', path.join(f.root, 'content.md')]).exit, 0, `1221: page in ${slug}`);
    }
    for (const slug of ['one', 'two']) equal(f.cli(['basic-memory', 'open', slug, '--seat', 'first', '--json']).exit, 0, `1221: open ${slug}`);
    const context = readerContext(f.workspace, path.join(f.workspace, '.claude'), 'first');
    const search = async (extra: Record<string, unknown>) => {
      const asked: Record<string, unknown> = { query: 'Needle', ...extra };
      try { return (await answerReaderTool(context, 'search_open_books', { required: (name) => String(asked[name] ?? ''), optional: (name) => asked[name] ?? null })).text; } catch (error) { return `REFUSED: ${(error as Error).message}`; }
    };
    const both = await search({});
    check(both.includes('Needle in one') && both.includes('Needle in two') && !both.includes('Needle in three'), `1221: no books searches every open Book, as before: ${both}`);
    const empty = await search({ books: [] });
    check(empty.startsWith('REFUSED') && empty.includes('at least one open Book slug') && !empty.includes('Needle'), `1221: empty books refuses before searching: ${empty}`);
    const onlyOne = await search({ books: ['one'] });
    check(onlyOne.includes('Needle in one') && !onlyOne.includes('Needle in two'), `1221: books ["one"] returns only one's lines: ${onlyOne}`);
    const closed = await search({ books: ['one', 'three'] });
    check(closed.startsWith('REFUSED') && closed.includes("'three'") && closed.includes('one, two') && !closed.includes('Needle'), `1221: a closed slug is refused naming it and the open ones: ${closed}`);
    check((await search({ books: 'one' })).startsWith('REFUSED'), '1221: books that is not a list is refused');
    equal(toolArgumentRefusal('search_open_books', { query: 'Needle', books: ['one'] }), null, '1221: the tool declares books');
  } finally { await f.dispose(); }
}

async function section1222(): Promise<void> {
  const f = await fixture('1222');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Endings.']).exit, 0, '1222: Book');
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1222: open');
    const content = f.put('content.md', '- added\n');
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    for (const ending of ['\n', '\r\n', 'mixed']) {
      const body = ending === 'mixed' ? '# Page\r\n\n## Log\n\n- first\n' : ['# Page', '', '## Log', '', '- first', ''].join(ending);
      const stored = f.put('server/books/demo/wiki/page.md', body);
      const args = ['shared', 'replace-page', 'demo', 'page', '--append-section', 'Log', '--content-path', content];
      const r = f.cli([...args, '--seat', 'first', '--preflight', '--json']);
      if (ending === 'mixed') {
        check(r.exit !== 0 && /mixed/i.test(r.stderr) && /nothing was written/i.test(r.stderr), `1222: mixed endings refused: ${r.stderr}`);
        equal(fs.readFileSync(stored, 'utf8'), body, '1222: mixed page untouched');
      } else {
        equal(r.exit, 0, `1222: ${JSON.stringify(ending)} preview ${r.stderr}`);
        equal(f.json(r)['proposed_sha256'], digest(body + '- added' + ending), '1222: all existing endings preserved');
      }
    }
    f.put('server/books/demo/wiki/page.md', '# Page\n');
    const special = path.join(f.root, process.platform === 'win32' ? 'space $dollar `tick' : 'space "quote $dollar `tick', 'page.md');
    const r = f.cli(['shared', 'get-page', 'demo', 'page', '--out', special, '--seat', 'first', '--json']);
    equal(r.exit, 0, `1222: get-page ${r.stderr}`);
    const next = String(f.json(r)['next'] ?? '');
    // The shared grammar subset: one literal single-quoted argument, no embedded single quote.
    const posix = /--content-path '([^']*)' --preflight$/.exec(next)?.[1];
    const powershell = /--content-path '((?:[^'\u2018-\u201b]|['\u2018-\u201b]{2})*)' --preflight$/.exec(next)?.[1]?.replace(/(['\u2018-\u201b])\1/g, '$1');
    equal(posix, special, `1222: POSIX parser reads literal path ${next}`);
    equal(powershell, special, `1222: PowerShell parser reads literal path ${next}`);
    const apostrophe = path.join(f.root, "it's", 'page.md');
    const refused = f.cli(['shared', 'get-page', 'demo', 'page', '--out', apostrophe, '--seat', 'first', '--json']);
    check(refused.exit !== 0 && /single quote/i.test(refused.stderr) && !fs.existsSync(apostrophe), '1222: single quote refused before writing');
    for (const quote of ['\u2018', '\u2019', '\u201a', '\u201b']) {
      const out = path.join(f.root, `curly${quote}`, 'page.md');
      const got = f.cli(['shared', 'get-page', 'demo', 'page', '--out', out, '--seat', 'first', '--json']);
      check(got.exit !== 0 && /nothing was written/i.test(got.stderr) && !fs.existsSync(out), `1222: U+${quote.codePointAt(0)!.toString(16)} refused before writing`);
    }
  } finally { await f.dispose(); }
}

async function section1232(): Promise<void> {
  const started = Date.now();
  const f = await fixture('1232', ['--change-before', 'bm_write:7', '--change-before', 'bm_write:11']);
  try {
    f.put('server/books/demo/wiki/_book.md', '# Demo\n');
    f.put('server/books/demo/wiki/_index.md', '# Map\n');
    f.put('server/books/demo/wiki/page.md', '# Page\n');
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1232: open');
    const out = path.join(f.root, 'space $dollar `tick', 'page.md');
    const next = String(f.json(f.cli(['shared', 'get-page', 'demo', 'page', '--out', out, '--seat', 'first', '--json']))['next']);
    // One actual repair output pins the helper's use; every quote character then crosses the real parser too.
    const content = f.put('content\u2019;Write-Output marker;#.md', '# Page\n');
    const failed = f.gated(['shared', 'add-page', 'demo', 'new-page', '--content-path', content]);
    const repair = /Repair: (deskpost shared [^\r\n]* --preflight)/.exec(failed.stdout + failed.stderr)?.[1];
    check(!!repair, `1232: actual repair printed: ${failed.stderr}`);
    const cases = [{ line: next, path: out }, ...(repair ? [{ line: repair, path: content }] : [])];
    const shared = await import('../../src/sharedwrite.ts');
    check(typeof shared.quoteSharedCommandPath === 'function', '1232: the repair quoting helper is available for every character');
    if (typeof shared.quoteSharedCommandPath === 'function') {
      for (const quote of ["'", '\u2018', '\u2019', '\u201a', '\u201b', '\u2032']) {
        const value = path.join(f.root, `path${quote};Write-Output marker;#.md`);
        cases.push({ line: `deskpost shared add-page demo page --content-path ${shared.quoteSharedCommandPath(value, 'win32')} --preflight`, path: value });
      }
    }
    const input = f.put('parser-input.json', JSON.stringify(cases));
    // Data travels in files. ParseInput never executes any of the printed commands.
    const script = f.put('parser.txt', [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$cases = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json',
      '$results = @(foreach ($case in $cases) {',
      '  $tokens = $null; $errors = $null',
      '  $tree = [System.Management.Automation.Language.Parser]::ParseInput($case.line, [ref]$tokens, [ref]$errors)',
      '  $statements = @($tree.EndBlock.Statements)',
      '  $elements = @($statements[0].PipelineElements[0].CommandElements)',
      '  $index = 0; while ($index -lt $elements.Count -and $elements[$index].Extent.Text -ne "--content-path") { $index++ }',
      '  $value = if ($index + 1 -lt $elements.Count) { $elements[$index + 1].Value } else { $null }',
      '  @{ statements = $statements.Count; errors = @($errors).Count; value = $value; expected = $case.path }',
      '})',
      'ConvertTo-Json -InputObject $results -Compress',
    ].join('\n'));
    const parser = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:DESKPOST_QUOTE_SCRIPT))) $env:DESKPOST_QUOTE_INPUT'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, DESKPOST_QUOTE_SCRIPT: script, DESKPOST_QUOTE_INPUT: input } });
    equal(parser.status, 0, `1232: PowerShell parser ran: ${parser.stderr}`);
    const results = JSON.parse(parser.stdout || '[]') as { statements: number; errors: number; value: string; expected: string }[];
    equal(results.length, cases.length, '1232: every printed command parsed');
    for (const result of results) {
      equal(result.statements, 1, `1232: one statement for ${result.expected}`);
      equal(result.errors, 0, `1232: no parser errors for ${result.expected}`);
      equal(result.value, result.expected, '1232: one literal path argument');
    }
  } finally { await f.dispose(); }
  check(Date.now() - started < 20000, `1232: focused proof under 20 seconds (${Date.now() - started}ms)`);
}

async function section1223(): Promise<void> {
  const f = await fixture('1223');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Now prose.']).exit, 0, '1223: Book');
    const original = '# Book page\n\n## Now\n\nPlain paragraphs.\n';
    const content = f.put('content.md', original);
    equal(f.gated(['shared', 'add-page', 'demo', 'page', '--content-path', content]).exit, 0, '1223: page');
    f.put('content.md', '- ordinary list entry\n');
    const appended = f.gated(['shared', 'replace-page', 'demo', 'page', '--append-section', 'Now', '--content-path', content]);
    equal(appended.exit, 0, `1223: Book Now accepts ordinary list: ${appended.stderr}`);
    check(fs.readFileSync(path.join(f.storage, 'books/demo/wiki/page.md'), 'utf8').includes('- ordinary list entry'), '1223: Book addition written');
    f.put('ws/collection/projects/alpha/prose.md', original);
    const refused = f.cli(['hub', 'edit', 'alpha', '--page', 'prose', '--mode', 'append-section', '--section', 'Now', '--content-path', content]);
    check(refused.exit !== 0 && /status marker/.test(refused.stderr), `1223: Hub Now still refuses: ${refused.stderr}`);
    equal(fs.readFileSync(path.join(f.workspace, 'collection/projects/alpha/prose.md'), 'utf8'), original, '1223: Hub untouched');
  } finally { await f.dispose(); }
}

async function section1224(): Promise<void> {
  const f = await fixture('1224');
  try {
    equal(f.cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'Hashes.']).exit, 0, '1224: Book');
    f.put('ws/shelf/demo/wiki/page.md', '# Page\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n');
    f.put('ws/collection/projects/alpha/page.md', '# Page\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n');
    f.put('ws/.claude/seats/first/.open-books', 'shelf/demo\n');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\n');
    for (const [tool, slug] of [['read_open_book_page', 'demo'], ['read_open_project_page', 'alpha']]) {
      const args = ['mcp', 'call', tool!, '--slug', slug!, '--page', 'page', '--seat', 'first'];
      const full = JSON.parse(f.cli(args).stdout).result.content;
      const section = JSON.parse(f.cli([...args, '--section', 'One']).stdout).result.content;
      check(/^sha256: [a-f0-9]{64}$/.test(full[1]?.text ?? ''), `1224: ${tool} full label unchanged`);
      equal(section[1]?.text, 'page ' + full[1]?.text, `1224: ${tool} section names whole-page hash`);
      check(section[0]?.text.includes('First.') && !section[0]?.text.includes('Second.'), `1224: ${tool} section text only`);
    }
  } finally { await f.dispose(); }
}

async function section1225(): Promise<void> {
  const started = Date.now();
  for (const action of ['add-page', 'remove-page']) {
    const first = action === 'add-page' ? 7 : 6;
    const f = await fixture('1225-' + action, ['--change-before', `bm_write:${first}`, '--change-before', `bm_write:${first + 4}`]);
    try {
      f.put('server/books/demo/wiki/_book.md', '# Demo\n');
      const mapFile = f.put('server/books/demo/wiki/_index.md', '# Map\n' + (action === 'remove-page' ? '\n- [[books/demo/wiki/page|page]]\n' : ''));
      const content = f.put('content.md', '# Page\n\nKept unchanged.\n');
      const page = path.join(f.storage, 'books/demo/wiki/page.md');
      if (action === 'remove-page') f.put('server/books/demo/wiki/page.md', '# Page\n\nKept unchanged.\n');
      const args = ['shared', action, 'demo', 'page', ...(action === 'add-page' ? ['--content-path', content] : [])];
      const failed = f.gated(args);
      check(failed.exit !== 0, `1225: ${action} map conflicts twice`);
      const answer = failed.stderr + failed.stdout;
      check(answer.includes(action === 'add-page' ? 'page was written' : 'page was removed') && answer.includes('reader map was not written'), `1225: partial result says what landed ${answer}`);
      check(!answer.includes("this Book's line"), '1225: no Catalog wording');
      const repair = /Repair: (deskpost shared [^\r\n]* --preflight)/.exec(answer)?.[1];
      check(!!repair, `1225: repair command named ${answer}`);
      const before = fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : null;
      const writesFile = path.join(f.storage, '.writes.log');
      const beforeWrites = fs.readFileSync(writesFile, 'utf8');
      if (repair) {
        const words = [...repair.matchAll(/'([^']*)'|([^\s]+)/g)].map(m => m[1] ?? m[2]!);
        const repairArgs = words.slice(1).filter(w => w !== '--preflight');
        const fixed = f.gated(repairArgs);
        equal(fixed.exit, 0, `1225: named repair succeeds ${fixed.stderr}`);
      }
      const writes = fs.readFileSync(writesFile, 'utf8').slice(beforeWrites.length).split('\n').map(line => line.split('|')[1]?.replace(/^(?:edit|delete) /, ''));
      check(!writes.includes('books/demo/wiki/page.md'), `1225: ${action} repair sent no page write or removal: ${writes.join(', ')}`);
      check(writes.includes('books/demo/wiki/_index.md'), `1225: ${action} repair wrote the map`);
      const map = fs.readFileSync(mapFile, 'utf8');
      equal(map.includes('[[books/demo/wiki/page|page]]'), action === 'add-page', '1225: repaired map matches page state');
      check(map.includes('another writer'), '1225: concurrent map text preserved');
      equal(fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : null, before, '1225: repair never rewrites the page');
    } finally { await f.dispose(); }
  }
  check(Date.now() - started < 30000, `1225: focused proof under 30 seconds (${Date.now() - started}ms)`);
}

async function section1226(): Promise<void> {
  const f = await fixture('1226');
  try {
    equal(f.cli(['shelf', 'new', 'letters-like', '--title', 'Letters', '--summary', 'Reader remedy.']).exit, 0, '1226: Book');
    f.put('ws/shelf/letters-like/wiki/notes/x.md', '# A letter\n');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\n');
    const args = ['mcp', 'call', 'read_open_project_page', '--slug', 'alpha', '--page', 'notes/x', '--seat', 'first'];
    const read = () => JSON.parse(f.cli(args).stdout).result.content[0].text as string;
    const original = read();
    check(original.includes('That page is not in this Project.') && !original.includes('read_open_book_page'), '1226: original refusal');
    f.put('ws/.claude/seats/first/.open-books', 'shelf/letters-like\n');
    const withBook = read();
    check(withBook.startsWith(original) && withBook.includes('read_open_book_page') && withBook.includes('slug: letters-like') && withBook.includes('page: notes/x'), `1226: remedy names open Book ${withBook}`);
    f.put('ws/.claude/seats/first/.open-books', '');
    equal(read(), original, '1226: no such open Book leaves refusal unchanged');
  } finally { await f.dispose(); }
}

async function section1227(): Promise<void> {
  const f = await fixture('1227');
  try {
    const { answerReaderTool, readerContext, readerEnvelope } = await import('../../src/reader.ts');
    const { toolArgumentRefusal } = await import('../../src/mcpserve.ts');
    const content = '# First heading\n\n## One\n\nPrivate body words.\n';
    equal(f.cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'Hash only.']).exit, 0, '1227: Book');
    f.put('ws/shelf/demo/wiki/page.md', content);
    f.put('ws/collection/projects/alpha/page.md', content);
    f.put('ws/.claude/seats/first/.open-books', 'shelf/demo\n');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\n');
    const context = readerContext(f.workspace, path.join(f.workspace, '.claude'), 'first');
    for (const [tool, slug] of [['read_open_book_page', 'demo'], ['read_open_project_page', 'alpha']]) {
      const ask = (extra: Record<string, unknown>) => {
        const given: Record<string, unknown> = { slug, page: 'page', ...extra };
        return answerReaderTool(context, tool!, { required: name => String(given[name] ?? ''), optional: name => given[name] });
      };
      const full = await ask({});
      const only = await ask({ hash_only: true });
      equal(only.text, `sha256: ${full.sha256}\nlines: 5\ntitle: First heading`, `1227: ${tool} summary is whole-page hash, line count and title`);
      check(!JSON.stringify(readerEnvelope(1, only.text, false, only.sha256)).includes('Private body words'), '1227: no body in envelope');
      equal((await ask({ hash_only: false })).text, full.text, '1227: false unchanged');
      equal(toolArgumentRefusal(tool!, { slug, page: 'page', hash_only: true }), null, '1227: tool declares boolean');
      let invalid = false;
      try { await ask({ hash_only: 'true' }); } catch { invalid = true; }
      check(invalid, '1227: nonboolean refused');
      let missing = false;
      try { await ask({ hash_only: true, page: 'missing' }); } catch { missing = true; }
      check(missing, '1227: missing page checks retained');
      const desk = tool === 'read_open_book_page' ? 'books' : 'projects';
      const deskFile = path.join(f.workspace, `.claude/seats/first/.open-${desk}`);
      const saved = fs.readFileSync(deskFile, 'utf8'); fs.writeFileSync(deskFile, '');
      let closed = false;
      try { await ask({ hash_only: true }); } catch { closed = true; }
      check(closed, '1227: closed read checks retained'); fs.writeFileSync(deskFile, saved);
    }
  } finally { await f.dispose(); }
}

async function section1229(): Promise<void> {
  const f = await fixture('1229');
  try {
    const { findBookPages, formatDiscoveryResult } = await import('../../src/discovery.ts');
    equal(f.cli(['shelf', 'new', 'inbox', '--title', 'Inbox', '--summary', 'Capture coverage.', '--capture']).exit, 0, '1229: capture Book');
    f.put('ws/shelf/inbox/wiki/notes/private.md', '# Secret subject\n\nUnsearched body.\n');
    equal(f.cli(['shelf', 'rebuild', 'inbox']).exit, 0, '1229: manifest');
    const defaults = 'shelf/holding\nshelf/letters\nshelf/reports\n';
    f.put('ws/.claude/seats/first/.open-books', defaults);
    const search = () => formatDiscoveryResult(findBookPages({ workspace: f.workspace, query: 'Secret', deskStateDirectory: path.join(f.workspace, '.claude/seats/first') }));
    const closed = search();
    check(closed.includes('Capture notes were not searched: shelf/inbox') && closed.includes('search_open_books') && closed.includes('deskpost triage inventory'), `1229: closed coverage and remedies ${closed}`);
    check(!closed.includes('Unsearched body.'), '1229: coverage never exposes body');
    f.put('ws/.claude/seats/first/.open-books', defaults + 'shelf/inbox\n');
    check(!search().includes('Capture notes were not searched:'), '1229: no warning when no capture notes were skipped');
  } finally { await f.dispose(); }
}

async function section1230(): Promise<void> {
  const f = await fixture('1230');
  try {
    const { findOpenBookLines, formatFullTextResult } = await import('../../src/fulltext.ts');
    for (const slug of ['one', 'two']) {
      equal(f.cli(['shelf', 'new', slug, '--title', slug, '--summary', 'Budget.']).exit, 0, `1230: ${slug}`);
      f.put(`ws/shelf/${slug}/wiki/page.md`, '# Page\nNeedle\n');
    }
    f.put('ws/.claude/seats/first/.open-books', 'shelf/one\nshelf/two\n');
    const result = await findOpenBookLines({ workspace: f.workspace, query: 'Needle', deskStateDirectory: path.join(f.workspace, '.claude/seats/first'), limits: { maxFilesScanned: 1 } });
    equal(result.books_searched, 0, '1230: incomplete local Books never counted as searched');
    equal(result.books_partly_searched.map(b => b['book']).join(), 'one', '1230: first local Book named partial');
    equal(result.books_not_reached.map(b => b['book']).join(), 'two', '1230: second local Book named not reached');
    const answer = formatFullTextResult(result);
    check(answer.includes('Books partly searched: one.') && answer.includes('Books not reached: two.'), `1230: answer names every unfinished Book ${answer}`);
  } finally { await f.dispose(); }
}

async function section1231(): Promise<void> {
  const f = await fixture('1231');
  try {
    const { answerReaderTool, readerContext } = await import('../../src/reader.ts');
    const { toolArgumentRefusal } = await import('../../src/mcpserve.ts');
    for (const slug of ['alpha', 'beta', 'closed']) {
      f.put(`ws/collection/projects/${slug}/_project.md`, `# ${slug}\n`);
      f.put(`ws/collection/projects/${slug}/notes/page.md`, `# Page\nNeedle ${slug}\n`);
    }
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\nprojects/beta\n');
    const context = readerContext(f.workspace, path.join(f.workspace, '.claude'), 'first');
    const search = (given: Record<string, unknown>) => answerReaderTool(context, 'search_open_books', { required: name => String(given[name] ?? ''), optional: name => given[name] });
    const result = (await search({ query: 'Needle', place: 'project' })).text;
    check(result.includes('projects/alpha') && result.includes('projects/beta') && !result.includes('Needle closed'), `1231: only open Projects ${result}`);
    check(result.includes('notes/page:2: Needle alpha') && result.includes('notes/page:2: Needle beta'), '1231: canonical page and line');
    equal(toolArgumentRefusal('search_open_books', { query: 'Needle', place: 'project' }), null, '1231: project place declared');
    const books = (await search({ query: 'Needle', place: 'shelf' })).text;
    check(!books.includes('Needle alpha') && !books.includes('Needle beta'), '1231: Book place unchanged');
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\narchive/projects/alpha\n');
    const ambiguous = (await search({ query: 'Needle', place: 'project' })).text;
    check(!ambiguous.includes('Needle alpha') && ambiguous.includes('ambiguous'), `1231: ambiguous Project withheld ${ambiguous}`);
    const { markerPath, readMarker } = await import('../../src/workspace.ts');
    const { markerConnection } = await import('../../src/basicmemory.ts');
    const connection = markerConnection(f.workspace)!;
    f.put('ws/.claude/.library-mcp-url', connection.url);
    f.put('ws/.claude/.library-project', connection.collection_id);
    fs.writeFileSync(markerPath(f.workspace), JSON.stringify({ ...readMarker(f.workspace), backend: 'basic-memory' }));
    for (const slug of ['alpha', 'beta', 'closed']) f.put(`server/projects/${slug}/notes/page.md`, `# Remote page\nRemote needle ${slug}\n`);
    f.put('ws/.claude/seats/first/.open-projects', 'projects/alpha\nprojects/beta\n');
    const remoteCall = f.cli(['mcp', 'call', 'search_open_books', '--query', 'Remote needle', '--place', 'project', '--seat', 'first']);
    const remote = String(JSON.parse(remoteCall.stdout).result.content[0].text);
    check(remote.includes('[projects/alpha] notes/page:2: Remote needle alpha') && remote.includes('[projects/beta] notes/page:2: Remote needle beta') && !remote.includes('Remote needle closed'), `1231: shared Project pages use the same open checks ${remote}`);
  } finally { await f.dispose(); }
}

async function section1233(): Promise<void> {
  const f = await fixture('1233');
  try {
    f.book('local-only');
    f.put('server/books/README.md', '# Connection catalog\n\n- [[books/remote-only/wiki/_book|Remote only]]\n');
    const read = () => JSON.parse(f.cli(['mcp', 'call', 'read_book_catalog', '--location', 'all', '--seat', 'first']).stdout).result;
    const all = read();
    check(!all.isError && all.content[0].text.includes('local-only') && all.content[0].text.includes('remote-only'), '1233: all includes local and connected Books');
    check(all.content[0].text.includes('## Basic Memory connection') && all.content[0].text.indexOf('local-only') < all.content[0].text.indexOf('## Basic Memory connection'), '1233: connection has its own heading after the local catalog');
    f.put('server/books/README.md', '');
    const partial = read();
    check(!partial.isError && partial.content[0].text.includes('local-only') && partial.content[0].text.includes("connection's catalog was left out") && partial.content[0].text.includes('no readable content'), '1233: a failed connection catalog is named without losing the local catalog');
    const marker = JSON.parse(fs.readFileSync(path.join(f.workspace, '.library/workspace.json'), 'utf8'));
    delete marker.connections;
    f.put('ws/.library/workspace.json', JSON.stringify(marker));
    const expected = fs.readFileSync(path.join(f.workspace, 'collection/books/README.md'), 'utf8') + '\n\n---\n\n' + fs.readFileSync(path.join(f.workspace, 'shelf/_catalog.md'), 'utf8') + '\n\nShared Books open with deskpost desk open book <slug> --location shared; Shelf Books with --location shelf. Both are read through read_open_book_page.';
    equal(read().content[0].text, expected, '1233: without a connection the answer stays unchanged');
  } finally { await f.dispose(); }
}

async function section1234(): Promise<void> {
  const f = await fixture('1234');
  try {
    equal(f.cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'Missing pages.']).exit, 0, '1234: ordinary Book');
    f.put('ws/shelf/demo/wiki/_index.md', '# Map\n');
    f.put('ws/shelf/demo/wiki/topic/_index.md', '# Topic map\n');
    for (const slug of ['letters', 'reports']) f.put(`ws/shelf/${slug}/wiki/_book.md`, `# ${slug}\n`);
    f.put('ws/.claude/seats/first/.open-books', 'shelf/demo\nshelf/letters\nshelf/reports\n');
    const read = (slug: string, page: string) => JSON.parse(f.cli(['mcp', 'call', 'read_open_book_page', '--slug', slug, '--page', page, '--seat', 'first']).stdout).result;
    for (const page of ['index', 'topic/index']) {
      const result = read('demo', page);
      const suggested = page.replace(/index$/, '_index');
      check(result.isError && result.content[0].text.includes(`Did you mean ${suggested}?`), `1234: ${page} suggests ${suggested}: ${result.content[0].text}`);
    }
    for (const [slug, route] of [['letters', 'deskpost letters list'], ['reports', 'deskpost triage inventory']]) {
      const result = read(slug!, 'absent');
      check(result.isError && result.content[0].text.includes('That page is not in this Book.') && result.content[0].text.includes(route), `1234: ${slug} names its notes route: ${result.content[0].text}`);
    }
    equal(read('demo', 'absent').content[0].text, 'Book read rejected: That page is not in this Book.', '1234: ordinary Book refusal unchanged');
  } finally { await f.dispose(); }
}

async function section1235(): Promise<void> {
  const f = await fixture('1235');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Unchanged upkeep.']).exit, 0, '1235: make Book');
    equal(f.gated(['shared', 'upkeep', 'demo', '--seats', 'first']).exit, 0, '1235: grant upkeep');
    const args = ['shared', 'upkeep', 'demo', '--seats', 'first', '--seat', 'first'];
    const preview = f.json(f.cli([...args, '--preflight', '--json']));
    f.put('server/.calls.log', '');
    const applied = f.cli([...args, '--user-confirmed', '--plan-id', String(preview['plan_id']), '--json']);
    const answer = f.json(applied);
    equal(applied.exit, 0, `1235: unchanged apply ${applied.stderr}`);
    equal(answer['status'], 'unchanged', '1235: unchanged status');
    check(typeof preview['plan_id'] === 'string' && preview['plan_id'].trim().length > 0, '1235: preview has a non-empty plan');
    check(Array.isArray(preview['diff']) && preview['diff'].length > 0, '1235: preview has a non-empty diff');
    equal(answer['plan_id'], preview['plan_id'], '1235: preview plan retained');
    same(answer['diff'], preview['diff'], '1235: preview diff retained');
    check(String(answer['next']).includes('no server write'), '1235: answer names no write');
    check(!/bm_write|bm_edit|bm_delete/.test(fs.readFileSync(path.join(f.storage, '.calls.log'), 'utf8')), '1235: unchanged grant writes no server note');
  } finally { await f.dispose(); }
}


async function section1236(): Promise<void> {
  const f = await fixture('1236');
  try {
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Hash forms.']).exit, 0, '1236: make Book');
    equal(f.cli(['basic-memory', 'open', 'demo', '--seat', 'first', '--json']).exit, 0, '1236: open Book');
    const content = f.put('content.md', '# Page\nOriginal body.\n');
    equal(f.gated(['shared', 'add-page', 'demo', 'page', '--content-path', content]).exit, 0, '1236: seed page');
    const read = JSON.parse(f.cli(['mcp', 'call', 'read_open_book_page', '--slug', 'demo', '--page', 'page', '--place', 'shared', '--seat', 'first']).stdout).result;
    const hash = String(read.content[1].text).replace('sha256: ', '');
    f.put('content.md', '# Page\nChanged body.\n');
    const args = ['shared', 'replace-page', 'demo', 'page', '--content-path', content, '--seat', 'first'];
    const preview = f.json(f.cli([...args, '--preflight', '--json']));
    equal(preview['reader_sha256'], hash, '1236: preview reader hash matches exact reader');
    const answer = f.json(f.cli([...args, '--user-confirmed', '--plan-id', String(preview['plan_id']), '--json']));
    equal(answer['reader_sha256'], hash, '1236: apply keeps reader comparison hash');
    const usage = f.cli(['shared', 'replace-page', '--seat', 'first', '--preflight']);
    check(usage.stderr.includes('page body without frontmatter'), '1236: usage says content takes page body without frontmatter');
  } finally { await f.dispose(); }
}


async function section1237(): Promise<void> {
  const f = await fixture('1237');
  try {
    const { findBookPages, formatDiscoveryResult } = await import('../../src/discovery.ts');
    equal(f.cli(['shelf', 'new', 'inbox', '--title', 'Inbox', '--summary', 'Capture coverage.', '--capture']).exit, 0, '1237: capture Book');
    f.put('ws/shelf/inbox/wiki/notes/private.md', '# Hidden subject\nPrivate body.\n');
    equal(f.cli(['shelf', 'rebuild', 'inbox']).exit, 0, '1237: rebuild');
    f.put('ws/.claude/seats/first/.open-books', 'shelf/holding\nshelf/letters\nshelf/reports\n');
    const answer = formatDiscoveryResult(findBookPages({ workspace: f.workspace, query: 'Hidden', deskStateDirectory: path.join(f.workspace, '.claude/seats/first') }));
    check(answer.includes('Capture notes were not searched: shelf/inbox') && answer.includes('Open the Book and use search_open_books'), '1237: closed capture names missing coverage and route');
    check(!answer.includes('Hidden subject') && !answer.includes('Private body'), '1237: closed notes stay unread');
  } finally { await f.dispose(); }
}


async function section1238(): Promise<void> {
  const { sharedFolder, sharedPage, sharedFailureClass } = await import('../../src/sharedmanifests.ts');
  const session = { surface: 'bm', callTool: async () => { throw new Error('page not found, invalid upkeep note, lock held'); } } as unknown as McpSession;
  let failure: unknown;
  try { await sharedFolder(session, 'fixture-project', 'books/demo/wiki/x.md'); } catch (error) { failure = error; }
  equal(sharedFailureClass(failure), 'listing failed', '1238: a folder ending in .md is a folder regardless of error words');
  try { await sharedPage(session, { id: 'fixture-project', name: 'fixture-project' }, 'books/demo/wiki/x.md', 'books/demo/wiki/x'); } catch (error) { failure = error; }
  equal(sharedFailureClass(failure), 'page would not read', '1238: page provenance ignores message');
  equal(sharedFailureClass(new Error('listing failed')), 'server error', '1238: unclassified transport error has no guessed class');
}


async function section1239(): Promise<void> {
  const f = await fixture('1239');
  try {
    const { readExactOrNull } = await import('../../src/basicmemory.ts');
    f.put('server/books/demo/wiki/neighbour.md', '---\ntitle: Neighbour\npermalink: books/demo/wiki/asked\n---\n# Private neighbour body\n');
    for (const surface of ['bm', 'legacy']) {
      const server = surface === 'bm' ? null : await startFakeBasicMemory(f.storage, ['--surface', 'legacy']);
      const session = server ? new McpSession(server.url, '1239-legacy') : f.session;
      try {
        if (server) await session.initialize();
        let said = '';
        try { await readExactOrNull(session, 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', 'books/demo/wiki/asked.md'); } catch (error) { said = (error as Error).message; }
        check(said.includes('not found') && said.includes('near match') && said.includes('books/demo/wiki/neighbour.md'), `1239: ${surface} refuses near match as not found: ${said}`);
        check(!said.includes('Private neighbour body'), '1239: neighbour body is not returned');
      } finally { server?.stop(); }
    }
  } finally { await f.dispose(); }
}


async function section1240(): Promise<void> {
  const { answerLine } = await import('../../src/mcpserve.ts');
  const response = await answerLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { workspace: '', stateDirectory: '', bound: null, hadMarker: false, id: '', refusal: null }, undefined);
  const tools = JSON.parse(response!).result.tools as { name: string; description: string }[];
  for (const name of ['read_book_catalog', 'read_open_book_page', 'search_open_books']) {
    const tool = tools.find(tool => tool.name === name);
    check(tool?.description.startsWith('place is where the Book is; location is the same argument.') === true, `1240: ${name} starts with the two argument names`);
  }
}


async function section1241(): Promise<void> {
  const f = await fixture('1241');
  try {
    const result = f.cli(['hub', 'new', 'new-hub', '--title', 'New Hub', '--preflight', '--json']);
    const preview = f.json(result);
    equal(result.exit, 0, `1241: preview ${result.stderr}`);
    same(preview['would_write'], ['collection/projects/new-hub/connections.md', 'collection/projects/new-hub/_project.md', 'collection/projects/README.md'], '1241: preview lists real workspace paths');
    equal(preview['project_path'], 'collection/projects/new-hub', '1241: project path');
    equal(preview['confirmation_required'], false, '1241: additive creation needs no confirmation');
    check(String(preview['next']).includes('deskpost hub new') && String(preview['next']).includes('same arguments') && String(preview['next']).includes('without the preview flag'), '1241: next names apply');
    for (const file of preview['would_write']) if (!file.endsWith('README.md')) check(!fs.existsSync(path.join(f.workspace, file)), '1241: preview creates no page');
  } finally { await f.dispose(); }
}



async function section1243(): Promise<void> {
  const f = await fixture('1243');
  const legacy = await startFakeBasicMemory(f.storage, ['--surface', 'legacy']);
  try {
    const ws = path.join(f.root, 'legacy');
    equal(runCli(['init', ws, '--registry-root', path.join(f.root, 'legacy-reg')]).exit, 0, '1243: init');
    const marker = JSON.parse(fs.readFileSync(path.join(ws, '.library/workspace.json'), 'utf8'));
    marker.backend = 'basic-memory'; marker.collection_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    f.put('legacy/.library/workspace.json', JSON.stringify(marker));
    f.put('legacy/.claude/.library-mcp-url', legacy.url); f.put('legacy/.claude/.library-project', marker.collection_id);
    f.put('legacy/.claude/.library-shared-root', f.storage);
    f.put('server/books/demo/wiki/_book.md', '# Demo\n');
    f.put('server/books/demo/wiki/_index.md', '# Map\n[[books/demo/wiki/topic/page|Page]]\n');
    f.put('server/books/demo/wiki/topic/page.md', '# Page\nNested body.\n');
    const result = runCli(['shared', 'archive', 'demo', '--workspace', ws, '--user-confirmed', '--json']);
    equal(result.exit, 0, `1243: legacy archive ${result.stderr}`);
    check(!fs.existsSync(path.join(f.storage, 'books/demo')), '1243: source directory moved');
    check(fs.readFileSync(path.join(f.storage, 'archive/demo/wiki/topic/page.md'), 'utf8').includes('Nested body.'), '1243: nested body moved');
    const map = fs.readFileSync(path.join(f.storage, 'archive/demo/wiki/_index.md'), 'utf8');
    check(map.includes('archive/demo/wiki/topic/page') && !map.includes('books/demo/wiki/topic/page'), '1243: reader map reached and rewritten');
    equal(fs.readFileSync(path.join(f.storage, '.writes.log'), 'utf8').split('\n').filter(line => line.includes('|move books/demo -> archive/demo')).length, 1, '1243: whole directory moved once');
  } finally { legacy.stop(); await f.dispose(); }
}


async function section1244(): Promise<void> {
  const f = await fixture('1244');
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const { rebuildSharedManifests } = await import('../../src/sharedmanifests.ts');
    equal(f.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Lock classes.']).exit, 0, '1244: make Book');
    const ready = path.join(f.root, 'holder-ready');
    const script = f.put('holder.mjs', `import fs from 'node:fs';\nimport { enterBookLock } from ${JSON.stringify(new URL('../../src/locks.ts', import.meta.url).href)};\nenterBookLock(${JSON.stringify(f.workspace)}, 'shared/demo');\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready');\nsetInterval(() => {}, 1000);\n`);
    holder = spawn(process.execPath, [script], { stdio: 'ignore' });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(50);
    check(fs.existsSync(ready), '1244: second holder took the Book lock');
    const roster = () => JSON.parse(fs.readFileSync(path.join(f.workspace, 'internal/book-manifests/shared/_roster.json'), 'utf8')).books[0];
    await rebuildSharedManifests(f.workspace);
    equal(roster().unavailable_class, "the Book's lock was held", '1244: real held Book lock');
    holder.kill();
    await new Promise<void>(resolve => holder!.once('exit', () => resolve()));
    holder = undefined;
    // The stopped holder's lock is this fixture's; remove it before testing the export refusal.
    fs.rmSync(path.join(f.workspace, 'internal/book-locks/shared-demo.lock'));
    f.put('ws/internal/book-locks/collection-export.lock', 'fixture export running\n');
    await rebuildSharedManifests(f.workspace);
    equal(roster().unavailable_class, 'server error', '1244: collection export is not a held Book lock');
  } finally { holder?.kill(); await f.dispose(); }
}

async function section1245(): Promise<void> {
  const { hostRemedies, readerText, NOT_SHIPPED } = await import('../../src/remedy.ts');
  const helper = 'tools/CodexBindings.ps1';
  const words = 'pass -Seat and tools/CodexBindings.ps1 and library desk';
  const marked = readerText(words);
  for (const flavor of ['posix', 'win32-compiled', 'win32'] as const) {
    const authored = flavor === 'win32' ? helper : flavor === 'win32-compiled'
      ? 'CodexBindings' + NOT_SHIPPED : helper + ' (a PowerShell helper; this machine has no PowerShell to run it)';
    equal(hostRemedies(`Run ${helper} now; ${marked}`, flavor), `Run ${authored} now; ${words}`,
      `1245: ${flavor} preserves marked words and uses host wording outside`);
    equal(hostRemedies('\uE001\uE000' + words, flavor), words, `1245: ${flavor} handles stray and unmatched marks`);
    equal(hostRemedies(readerText('a\uE001b\uE000c'), flavor), 'abc', `1245: ${flavor} emits no marks`);
  }
}

async function section1246(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-train-reader-text-'));
  try {
    const workspace = path.join(root, 'library');
    const env = { LIBRARY_SEAT: 'planner', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: path.join(root, 'registry') };
    const init = runCli(['init', workspace], { cwd: root, env: { ...env, LIBRARY_SEAT: '' } });
    equal(init.exit, 0, `1246: init: ${init.stderr}`);
    if (init.exit !== 0) return;
    const title = 'Fix pass -Seat and tools/Archive-ShelfBook.ps1 -Action restore demo and library desk "half';
    const note = 'see pass -WorkspacePath and tools/CodexBindings.ps1:202';
    const id = 'reader-words';
    const clean = (text: string, label: string) => check(!/[\uE000\uE001]/.test(text), `1246: ${label} contains no marks`);
    const readerValues = [
      { marker: 'Archive-ShelfBook', value: title, quotedSummary: /^(Added|Closed|Retitled) / },
      { marker: 'CodexBindings', value: note, quotedSummary: /^Set / },
    ];
    const train = (args: string[], ...expected: string[]) => {
      const result = runCli(['train', ...args, '--workspace', workspace], { cwd: root, env });
      const label = args.join(' ') || 'train';
      equal(result.exit, 0, `1246: ${label}: ${result.stderr}`);
      clean(result.stdout, label);
      for (const value of expected) check(result.stdout.includes(value), `1246: ${label} preserves ${value}`);
      for (const line of result.stdout.split(/\r?\n/)) {
        for (const { marker, value, quotedSummary } of readerValues) {
          if (!line.includes(marker)) continue;
          const quoted = line.startsWith('{') || args.includes('--json') || quotedSummary.test(line);
          const expectedValue = quoted ? JSON.stringify(value) : value;
          check(line.includes(expectedValue), `1246: ${label} preserves ${expectedValue} on this line: ${line}`);
        }
      }
      return result.stdout;
    };
    train(['add', id, '--title', title, '--place', 'foundation'], JSON.stringify(title));
    train(['set', id, '--note', note], JSON.stringify(note));
    train(['retitle', id, '--title', title], JSON.stringify(title));
    const show = train(['show', id], 'Title: ' + title, 'Note: ' + note);
    const history = show.split(/\r?\n/).slice(show.split(/\r?\n/).indexOf('History:') + 1).filter(Boolean);
    check(history.some(line => line.includes(JSON.stringify(title))), '1246: history preserves the saved title');
    check(history.some(line => line.includes(JSON.stringify(note))), '1246: history preserves the saved note');
    train([], title + '; ' + note);
    train(['page'], title + '; ' + note);
    train(['page', '--by', 'lane'], title + '; ' + note);
    train(['close', id, '--done', '--note', note], JSON.stringify(title), note);
    train(['reopen', id, '--note', note], note);
    const json = train(['show', id, '--json']);
    const register = fs.readFileSync(path.join(workspace, 'internal', 'train', 'register.json'), 'utf8');
    clean(register, 'register');
    const answer = JSON.parse(json);
    equal(answer.title, title, '1246: JSON title');
    equal(answer.note, note, '1246: JSON note');
    const item = JSON.parse(register).items.find((item: { id: string }) => item.id === id);
    equal(item.title, title, '1246: register title');
    equal(item.note, note, '1246: register note');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1247(): Promise<void> {
  const { hostRemedies, NOT_SHIPPED } = await import('../../src/remedy.ts');
  const helper = 'tools/CodexBindings.ps1';
  const installed = 'CodexBindings' + NOT_SHIPPED;
  const transition = `Unclosed "prefix; note: "" -> "x ${helper}:202"`;
  equal(hostRemedies(transition, 'win32-compiled'), transition, '1247: the empty prior value survives a stray opening quote');
  const adjacent = '"pass -Seat""library desk"';
  equal(hostRemedies(adjacent, 'posix'), adjacent, '1247: adjacent quoted values protect both commands');
  const continued = 'Unclosed "prefix pass -Seat\n' + JSON.stringify(`library desk and ${helper}:202`);
  equal(hostRemedies(continued, 'posix'), continued.replace('pass -Seat', 'pass --seat'),
    '1247: an unmatched quote cannot cross a line');
  const escaped = JSON.stringify(`pass -Seat and "library desk" and ${helper}:202`);
  equal(hostRemedies(`${adjacent}${escaped} Run ${helper} now.`, 'win32-compiled'),
    `${adjacent}${escaped} Run ${installed} now.`, '1247: escaped quotes and adjacent values keep all passes outside');
}

export async function runLane(h: Harness): Promise<void> {
  ({ selected, prerequisite, check, equal, same, failures, runCli, runCliAsync, HERE, PROGRAM_ROOT, KERNEL_COMMAND, isCompiled } = h);

if (selected(1200) && prerequisite(1200, () => !isCompiled(), 'requires source stand-in')) await section1200();
if (selected(1201) && prerequisite(1201, () => !isCompiled(), 'requires source stand-in')) await section1201();
if (selected(1202) && prerequisite(1202, () => !isCompiled(), 'requires source stand-in')) await section1202();
if (selected(1203) && prerequisite(1203, () => !isCompiled(), 'requires source stand-in')) await section1203();
if (selected(1204) && prerequisite(1204, () => !isCompiled(), 'requires source stand-in')) await section1204();
if (selected(1205) && prerequisite(1205, () => !isCompiled(), 'requires source stand-in')) await section1205();
if (selected(1206) && prerequisite(1206, () => !isCompiled(), 'requires source stand-in')) await section1206();
if (selected(1207) && prerequisite(1207, () => !isCompiled(), 'requires source stand-in')) await section1207();
if (selected(1208) && prerequisite(1208, () => !isCompiled(), 'requires source stand-in')) await section1208();
if (selected(1209) && prerequisite(1209, () => !isCompiled(), 'requires source stand-in')) await section1209();

if (selected(1210) && prerequisite(1210, () => !isCompiled(), 'requires source stand-in')) await section1210();

if (selected(1211) && prerequisite(1211, () => !isCompiled(), 'requires source stand-in')) await section1211();

if (selected(1212) && prerequisite(1212, () => !isCompiled(), 'requires source stand-in')) await section1212();

if (selected(1213) && prerequisite(1213, () => !isCompiled(), 'requires source stand-in')) await section1213();

if (selected(1214) && prerequisite(1214, () => !isCompiled(), 'requires source stand-in')) await section1214();

if (selected(1216) && prerequisite(1216, () => !isCompiled(), 'requires source stand-in')) await section1216();

if (selected(1217) && prerequisite(1217, () => !isCompiled(), 'requires source stand-in')) await section1217();

if (selected(1218) && prerequisite(1218, () => !isCompiled(), 'requires source stand-in')) await section1218();

if (selected(1219) && prerequisite(1219, () => !isCompiled(), 'requires source stand-in')) await section1219();

if (selected(1220) && prerequisite(1220, () => !isCompiled(), 'requires source stand-in')) await section1220();

if (selected(1221) && prerequisite(1221, () => !isCompiled(), 'requires source stand-in')) await section1221();

if (selected(1222) && prerequisite(1222, () => !isCompiled(), 'requires source stand-in')) await section1222();

if (selected(1223) && prerequisite(1223, () => !isCompiled(), 'requires source stand-in')) await section1223();

if (selected(1224) && prerequisite(1224, () => !isCompiled(), 'requires source stand-in')) await section1224();

if (selected(1225) && prerequisite(1225, () => !isCompiled(), 'requires source stand-in')) await section1225();

if (selected(1226) && prerequisite(1226, () => !isCompiled(), 'requires source stand-in')) await section1226();

if (selected(1227) && prerequisite(1227, () => !isCompiled(), 'requires source stand-in')) await section1227();

if (selected(1229) && prerequisite(1229, () => !isCompiled(), 'requires source stand-in')) await section1229();

if (selected(1230) && prerequisite(1230, () => !isCompiled(), 'requires source stand-in')) await section1230();

if (selected(1231) && prerequisite(1231, () => !isCompiled(), 'requires source stand-in')) await section1231();

if (selected(1232) && prerequisite(1232, () => process.platform === 'win32' && !isCompiled(), 'requires Windows PowerShell and the source stand-in')) await section1232();

if (selected(1233) && prerequisite(1233, () => !isCompiled(), 'requires source stand-in')) await section1233();

if (selected(1234) && prerequisite(1234, () => !isCompiled(), 'requires source stand-in')) await section1234();

if (selected(1235) && prerequisite(1235, () => !isCompiled(), 'requires source stand-in')) await section1235();

if (selected(1236) && prerequisite(1236, () => !isCompiled(), 'requires source stand-in')) await section1236();

if (selected(1237) && prerequisite(1237, () => !isCompiled(), 'requires source stand-in')) await section1237();

if (selected(1238) && prerequisite(1238, () => !isCompiled(), 'requires source stand-in')) await section1238();

if (selected(1239) && prerequisite(1239, () => !isCompiled(), 'requires source stand-in')) await section1239();

if (selected(1240) && prerequisite(1240, () => !isCompiled(), 'requires source stand-in')) await section1240();

if (selected(1241) && prerequisite(1241, () => !isCompiled(), 'requires source stand-in')) await section1241();

if (selected(1243) && prerequisite(1243, () => !isCompiled(), 'requires source stand-in')) await section1243();

if (selected(1244) && prerequisite(1244, () => !isCompiled(), 'requires source stand-in')) await section1244();
if (selected(1245)) await section1245();
if (selected(1246)) await section1246();
if (selected(1247)) await section1247();

}
