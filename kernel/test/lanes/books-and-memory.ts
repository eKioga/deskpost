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
import { spawn } from 'node:child_process';
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

}
