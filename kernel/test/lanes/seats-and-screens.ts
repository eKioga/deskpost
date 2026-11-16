/**
 * THE SEATS-AND-SCREENS LANE'S SELF-TEST SECTIONS (PLAN-lane-test-files.md; kickoffs/s210 row 1). This lane's new sections go here,
 * numbered in its range in docs/areas.json `section_ranges` (1000 to 1199), and claim their kernel/src files in
 * `seats-and-screens.covers.json` beside this file. kernel/test/selftest.ts awaits `runLane` after its last own section, so all of
 * its initialization has run; the names below are its helpers (./harness.ts says what each is).
 *
 * THE FORMAT IS THE PARSERS' OWN, AT COLUMN ZERO (tools/section-select.mts `sectionRanges`, kernel/test/run-parallel.ts
 * `sectionNumbers` and `knownDeclaredSkips`, tools/ci-manifest.mts): each section is a top-level `async function
 * sectionN(): Promise<void> {` whose closing `}` is at column zero, and `runLane` holds one dispatch line per section at
 * column zero, `if (selected(N)) await sectionN();` or `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))
 * await sectionN();` on one line, in number order. No formatter runs on this file.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { Harness } from './harness.ts';

let selected: Harness['selected'], prerequisite: Harness['prerequisite'], check: Harness['check'], equal: Harness['equal'], same: Harness['same'];
let failures: Harness['failures'], runCli: Harness['runCli'], runCliAsync: Harness['runCliAsync'];
let HERE: Harness['HERE'], PROGRAM_ROOT: Harness['PROGRAM_ROOT'], KERNEL_COMMAND: Harness['KERNEL_COMMAND'], isCompiled: Harness['isCompiled'];

async function section1000(): Promise<void> {
  const source = readFileSync(join(PROGRAM_ROOT, 'kernel/test/selftest.ts'), 'utf8');
  const inline = [...source.matchAll(/^if \(selected\((\d+)\)\) \{$/gm)]
    .map(match => Number(match[1])).filter(number => ![169, 208, 277].includes(number));
  check(inline.length === 0, `1000: inline sections (${inline.length}): ${inline.join(', ')}; a new section goes in its lane's file (kernel/test/lanes/<lane>.ts); an existing inline section takes the async function sectionN() form`);
}

function seatFixture(label: string) {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), label)));
  const workspace = join(root, 'ws');
  const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: join(root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    CLAUDE_PID: String(process.pid), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '',
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root };
  const run = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: root, env });
  equal(runCli(['init', workspace, '--registry-root', env.LIBRARY_WORKSPACES], { cwd: root, env }).exit, 0, label + ': init');
  for (const slug of ['alpha', 'beta']) equal(run(['hub', 'new', slug, '--title', slug]).exit, 0, label + ': hub ' + slug);
  return { root, workspace, run, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function section1001(): Promise<void> {
  const w = seatFixture('w20-1001-');
  try {
    const made = w.run(['seat', 'start', 'first', '--project', 'alpha', '--command', 'codex', '--no-launch', '--json']);
    equal(made.exit, 0, '1001: create: ' + made.stderr);
    const record = join(w.workspace, '.claude/seats/first/launch.json');
    check(fs.existsSync(record), '1001: --command creates assistant record');
    if (fs.existsSync(record)) {
      const before = fs.readFileSync(record, 'utf8');
      equal(JSON.parse(before).assistant, 'codex', '1001: remembers Codex');
      const once = w.run(['seat', 'start', 'first', '--command', 'claude', '--no-launch', '--json']);
      equal(once.exit, 0, '1001: existing launch override');
      equal(fs.readFileSync(record, 'utf8'), before, '1001: override preserves record');
      check(once.stdout.includes('launch only: claude'), '1001: override explains scope');
    }
    const registry = join(w.workspace, '.claude/seats/_registry.json');
    const before = fs.readFileSync(registry, 'utf8');
    const mismatch = w.run(['seat', 'start', 'second', '--project', 'beta', '--command', 'codex', '--record-assistant', 'claude', '--no-launch']);
    check(mismatch.exit !== 0 && mismatch.stderr.includes('codex') && mismatch.stderr.includes('claude'), '1001: mismatch names both');
    equal(fs.readFileSync(registry, 'utf8'), before, '1001: mismatch leaves registry');
    check(!fs.existsSync(join(w.workspace, '.claude/seats/second')), '1001: mismatch creates no folder');
    equal(w.run(['seat', 'start', 'custom', '--project', 'beta', '--command', 'custom-tool', '--no-launch']).exit, 0, '1001: custom command');
    check(!fs.existsSync(join(w.workspace, '.claude/seats/custom/launch.json')), '1001: custom command has no record');
  } finally { w.dispose(); }
}

async function section1002(): Promise<void> {
  const w = seatFixture('w20-1002-');
  try {
    const args = ['seat', 'start', 'first', '--project', 'alpha', '--no-launch', '--open-project', 'beta'];
    const preview = w.run([...args, '--preflight', '--json']);
    equal(preview.exit, 0, '1002: preview: ' + preview.stderr);
    if (preview.exit !== 0) return;
    const plan = JSON.parse(preview.stdout);
    same(plan.open_projects, ['beta'], '1002: preview names Projects');
    const other = w.run([...args, '--open-project', 'alpha', '--preflight', '--json']);
    equal(other.exit, 0, '1002: second list');
    check(JSON.parse(other.stdout).plan_id !== plan.plan_id, '1002: Projects bound into plan id');
    const duplicate = w.run([...args, '--open-project', 'beta', '--preflight', '--json']);
    equal(JSON.parse(duplicate.stdout).plan_id, plan.plan_id, '1002: deduplicated');
    const unknown = w.run([...args, '--open-project', 'missing', '--preflight']);
    check(unknown.exit !== 0 && unknown.stderr.includes('catalog'), '1002: unknown names catalog remedy');
    const apply = w.run([...args, '--plan-id', plan.plan_id, '--json']);
    equal(apply.exit, 0, '1002: apply: ' + apply.stderr);
    const desk = JSON.parse(w.run(['desk', '--seat', 'first', '--json']).stdout);
    same(desk.open_projects, ['projects/alpha', 'projects/beta'], '1002: bound and extra Projects open');
    const existing = w.run([...args, '--preflight']);
    check(existing.exit !== 0 && existing.stderr.includes('--open-project'), '1002: existing seat refuses creation options');
  } finally { w.dispose(); }
}

async function section1003(): Promise<void> {
  const w = seatFixture('w20-1003-');
  try {
    equal(w.run(['seat', 'start', 'current', '--project', 'alpha', '--no-launch']).exit, 0, '1003: seat');
    const normal = w.run(['seat', 'cards', '--seat', 'current', '--json']).stdout;
    const file = join(w.workspace, '.claude/seats/_registry.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    registry.seats[0].names = [{ name: 'earlier', from_utc: '2026-01-01', to_utc: '2026-02-01' }, { name: 'current', from_utc: '2026-02-01', to_utc: null }];
    fs.writeFileSync(file, JSON.stringify(registry));
    const archive = join(w.workspace, 'internal/seat-archive/retired-one');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(join(archive, 'seat.json'), JSON.stringify({ seat: 'retired-one', seat_id: 'a'.repeat(32), retired_utc: '2026-03-01' }));
    const broken = join(w.workspace, 'internal/seat-archive/broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(join(broken, 'seat.json'), '{');
    equal(w.run(['seat', 'cards', '--seat', 'current', '--json']).stdout, normal, '1003: default byte-for-byte unchanged');
    const all = w.run(['seat', 'cards', '--all', '--json']);
    equal(all.exit, 0, '1003: all: ' + all.stderr);
    const result = JSON.parse(all.stdout);
    same(result.renamed, [{ old: 'earlier', current: 'current', renamed_utc: '2026-02-01' }], '1003: earlier name and date');
    check(result.retired?.some((row: { seat: string; retired_utc: string }) => row.seat === 'retired-one' && row.retired_utc === '2026-03-01'), '1003: retired name and date');
    check(result.history_unreadable?.some((line: string) => line.includes('broken/seat.json')), '1003: unreadable record named');
    const text = w.run(['seat', 'cards', '--all']).stdout;
    check(text.includes('Renamed') && text.includes('Retired') && text.includes('earlier') && text.includes('retired-one'), '1003: text history');
  } finally { w.dispose(); }
}

async function section1004(): Promise<void> {
  const w = seatFixture('w20-1004-');
  try {
    fs.writeFileSync(join(w.workspace, 'internal/notebook-layout.json'), '{"schema":1,"layout":"seat-owned"}');
    equal(w.run(['seat', 'start', 'former', '--project', 'alpha', '--no-launch']).exit, 0, '1004: seat');
    const paths = ['collection/projects/alpha/notes/mention.md', 'shelf/example/wiki/mention.md', '.agents/skills/example/SKILL.md',
      'collection/projects/alpha/log.md', 'shelf/example/wiki/sources/mention.md', 'shelf/example/wiki/not-word.md'];
    for (const name of paths) {
      const file = join(w.workspace, name);
      fs.mkdirSync(join(file, '..'), { recursive: true });
      fs.writeFileSync(file, name.endsWith('not-word.md') ? 'former-extra and preformer' : 'seat former lives here');
    }
    const preview = w.run(['seat', 'rename', 'former', 'current', '--preflight', '--json']);
    equal(preview.exit, 0, '1004: preview: ' + preview.stderr);
    if (preview.exit !== 0) return;
    const done = w.run(['seat', 'rename', 'former', 'current', '--user-confirmed', '--plan-id', JSON.parse(preview.stdout).plan_id, '--json']);
    equal(done.exit, 0, '1004: rename: ' + done.stderr);
    if (done.exit !== 0) return;
    const result = JSON.parse(done.stdout);
    equal(result.old_name_mentions?.count, 3, '1004: only allowed whole-word mentions');
    same(result.old_name_mentions?.paths, paths.slice(0, 3).sort(), '1004: exact paths');
    for (const name of paths.slice(0, 3)) equal(fs.readFileSync(join(w.workspace, name), 'utf8'), 'seat former lives here', '1004: scan is read only');
    equal(w.run(['seat', 'start', 'former-two', '--project', 'beta', '--no-launch']).exit, 0, '1004: cap seat');
    for (let index = 0; index < 51; index++) fs.writeFileSync(join(w.workspace, `shelf/example/wiki/extra-${index}.md`), 'former-two');
    const capPlan = JSON.parse(w.run(['seat', 'rename', 'former-two', 'current-two', '--preflight', '--json']).stdout);
    const capped = w.run(['seat', 'rename', 'former-two', 'current-two', '--user-confirmed', '--plan-id', capPlan.plan_id, '--json']);
    equal(capped.exit, 0, '1004: cap rename: ' + capped.stderr);
    if (capped.exit !== 0) return;
    const mentions = JSON.parse(capped.stdout).old_name_mentions;
    equal(mentions.count, 51, '1004: full count beyond cap');
    equal(mentions.paths.length, 50, '1004: paths bounded at 50');
  } finally { w.dispose(); }
}

async function section1005(): Promise<void> {
  const w = seatFixture('w20-1005-');
  const { spawn } = await import('node:child_process');
  const storage = join(w.root, 'server'), portFile = join(w.root, 'port');
  fs.mkdirSync(storage);
  const child = spawn(process.execPath, [join(HERE, 'fake-basic-memory.ts'), storage, portFile], {
    env: { ...process.env, TEMP: w.root, TMP: w.root, TMPDIR: w.root }, stdio: 'ignore' });
  try {
    const until = Date.now() + 15000;
    while ((!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').trim()) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    check(fs.existsSync(portFile), '1005: stand-in starts');
    if (!fs.existsSync(portFile)) return;
    const url = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}/mcp`;
    equal(w.run(['seat', 'start', 'first', '--project', 'alpha', '--no-launch']).exit, 0, '1005: seat');
    const card = (name: string) => {
      const pre = w.run(['library', 'card', '--set', name, '--preflight', '--json']);
      equal(pre.exit, 0, '1005: card preview');
      return w.run(['library', 'card', '--set', name, '--user-confirmed', '--plan-id', JSON.parse(pre.stdout).plan_id, '--json']);
    };
    equal(card('Before').exit, 0, '1005: initial card');
    const pre = w.run(['postbox', 'setup', '--url', url, '--preflight', '--json']);
    equal(pre.exit, 0, '1005: setup preview: ' + pre.stderr);
    if (pre.exit !== 0) return;
    const setup = w.run(['postbox', 'setup', '--url', url, '--user-confirmed', '--plan-id', JSON.parse(pre.stdout).plan_id, '--json']);
    equal(setup.exit, 0, '1005: setup: ' + setup.stderr);
    const changed = card('After');
    equal(changed.exit, 0, '1005: changed card');
    check(changed.stdout.includes('deskpost postbox check'), '1005: card names update step');
    const writes = () => fs.readFileSync(join(storage, '.writes.log'), 'utf8').split('\n').filter(line => line.includes('postbox/libraries/')).length;
    const before = writes();
    const checked = w.run(['postbox', 'check', '--json']);
    equal(checked.exit, 0, '1005: check: ' + checked.stderr);
    check(checked.stdout.includes('card changed: Before to After; the Postbox entry now says After'), '1005: names successful card refresh');
    equal(writes(), before + 1, '1005: republished once');
    const again = w.run(['postbox', 'check', '--json']);
    equal(again.exit, 0, '1005: second check');
    equal(writes(), before + 1, '1005: unchanged card not republished');
    const state = JSON.parse(fs.readFileSync(join(w.workspace, 'internal/postbox/state.json'), 'utf8'));
    equal(state.library_card, 'After', '1005: cache updated');
  } finally { child.kill(); await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('exit', () => resolve())); w.dispose(); }
}

async function section1006(): Promise<void> {
  const { stringLiterals } = await import('../stringliterals.ts');
  same(stringLiterals('const s = `powershell.exe -NoProfile -File ${x}`;'), ['powershell.exe -NoProfile -File \uFFFC'], '1006: one template message');
  same(stringLiterals('const s = `a${"inside"}b${`nested${x}end`}c`;'), ['a\uFFFCb\uFFFCc', 'inside', 'nested\uFFFCend'], '1006: nested strings retained once');
  for (const source of ['function f() { return /[\'\"]/; } // comment\nconst s = "real";', '/[\'\"]/.test(value); const s = "real";', 'const r = /[\\]/"\']/; const s = "real";']) {
    same(stringLiterals(source), ['real'], '1006: regex skipped');
  }
}

async function section1007(): Promise<void> {
  const w = seatFixture('w20-1007-');
  const started = Date.now();
  try {
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: join(w.root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
      CLAUDE_PID: String(process.pid), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '',
      HOME: w.root, USERPROFILE: w.root, APPDATA: w.root, LOCALAPPDATA: w.root, TEMP: w.root, TMP: w.root, TMPDIR: w.root };
    const cases = ['cards', 'describe', 'dirs', 'rename', 'retire', 'settings', 'start', 'status'].flatMap(action => [undefined, '', 'unknown'].map(name => ({ action, name })));
    const results = await Promise.all(cases.map(async ({ action, name }) => {
      const args = ['seat', action];
      if (action === 'cards' && name !== undefined) args.push('--seat', name);
      else if (name !== undefined) args.push(name);
      if (action === 'rename' && name === 'unknown') args.push('new-name');
      return runCliAsync([...args, '--workspace', w.workspace], { cwd: w.root, env });
    }));
    for (const [index, result] of results.entries()) {
      const { action, name } = cases[index]!;
      const shouldRefuse = action === 'cards' ? name === 'unknown' : action === 'status' ? name !== undefined : true;
      equal(result.exit === 0, !shouldRefuse, '1007: outcome for ' + action + '/' + (name ?? '(missing)'));
      if (result.exit !== 0) {
        console.log('1007 refusal ' + JSON.stringify({ action, name: name ?? '(missing)', stderr: result.stderr.trim() }));
        check(/(?:deskpost|library)\s+(?:seat|desk|browse)|--(?:seat|project|preflight|help)\b/i.test(result.stderr), '1007: remedy for ' + action + '/' + (name ?? '(missing)'));
      }
    }
    console.log('1007 elapsed milliseconds: ' + (Date.now() - started));
  } finally { w.dispose(); }
}

async function section1008(): Promise<void> {
  const { dashboardWidth, dashboardText, dashboardCells } = await import('../../src/dashboard.ts');
  const overview = { seat: 'a-very-long-seat-name-for-the-pane', this_seat: { claim_state: 'held' },
    letters_for_this_seat: { count: 123 }, capture_books: [], open_books: [{ slug: 'a-long-book-name' }], open_projects: ['projects/alpha'] };
  for (const [explicit, columns] of [[undefined, 20], [undefined, 29], [120, 80]] as const) {
    const width = dashboardWidth(explicit, columns);
    equal(width, columns, '1008: width respects columns');
    const text = dashboardText(overview, { width, now: 0, rows: 3 });
    const lines = text.split('\n');
    equal(lines.length, 3, '1008: frame has requested rows');
    check(lines.every(line => dashboardCells(line) <= columns), '1008: every line fits ' + columns + ': ' + text);
    equal(lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(dashboardCells(line) / columns)), 0), lines.length, '1008: physical rows equal frame rows');
  }
}

async function section1009(): Promise<void> {
  const { judge, sessionEnv } = await import('../../../tools/seat-rules-check.mts');
  const { countLetterCalls } = await import('../../../tools/seat-rules-check/count.mts');
  const { spawnSync } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w20-1009-')));
  const env = { ...sessionEnv(), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root };
  try {
    const fixture = { agents: [], expected_ring_target: 'peer', ring_line: 'ring', relay_line: '', answered_page: 'notes/one', outputs: { plain: [], wants: '', answers: '' } };
    for (const [succeeded, captured] of [[false, false], [true, false], [false, true]]) {
      const counts = countLetterCalls([{ tool: 'capture_letter', succeeded, captured, arguments: { wants: 'answer', answers: 'notes/one' } }], '', fixture);
      equal(counts.letters_captured, 0, '1009 a: refused capture not counted');
      equal(counts.capture_wants_answer, 0, '1009 a: refused wants not counted');
      equal(counts.capture_answers_page, 0, '1009 a: refused answer not counted');
    }
    equal(countLetterCalls([{ tool: 'capture_letter', succeeded: true, captured: true, arguments: {} }], '', fixture).letters_captured, 1, '1009 a: successful capture counted');
    const hashes = { rules_sha256: 'rules', cases_sha256: 'cases', method_sha256: 'method', count_sha256: 'count', fixture_server_sha256: 'server' };
    const made = (label: string, group: string, requested = 3, actual = 3) => {
      const dir = join(root, label); fs.mkdirSync(dir);
      fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ repeats: requested, ...hashes }));
      fs.writeFileSync(join(dir, 'cases.json'), JSON.stringify([{ id: 'one', group, prompt: 'x', fixture: 'f', needs_reader: false,
        criteria: [group === 'abiotic' ? { count: 'questions', rules_better_when: 'lower' } : { count: 'questions', rules_not_worse_when: 'not_higher' }] }]));
      for (const harness of ['codex', 'claude']) for (let r = 1; r <= actual; r++) for (const condition of ['rules', 'baseline']) {
        const folder = join(dir, `one--${harness}--${condition}--r${r}`); fs.mkdirSync(folder);
        fs.writeFileSync(join(folder, 'counts.json'), JSON.stringify({ status: 'completed', questions: condition === 'rules' ? 0 : 1 }));
      }
      return dir;
    };
    const countsFile = (dir: string, harness: string, condition: string, r: number) => join(dir, `one--${harness}--${condition}--r${r}`, 'counts.json');
    const report = (...args: string[]) => spawnSync(process.execPath, [join(PROGRAM_ROOT, 'tools/seat-rules-check.mts'), 'report', ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    for (const group of ['abiotic', 'control']) {
      const missing = made(group + '-last', group, 3, 2);
      const last = judge(missing);
      check(last.bar !== 'bar: met', '1009 b: missing last repeat blocks ' + group);
      check(last.undecided.some(row => row.repeat === 3 && row.detail.includes('missing')), '1009 b: names missing r3');
      const gap = made(group + '-r1', group);
      for (const condition of ['rules', 'baseline']) fs.unlinkSync(countsFile(gap, 'claude', condition, 1));
      check(judge(gap).undecided.some(row => row.harness === 'claude' && row.repeat === 1), '1009 e: r1 gap is visible ' + group);
      const error = made(group + '-error', group);
      fs.writeFileSync(countsFile(error, 'codex', 'rules', 2), JSON.stringify({ status: 'failed', questions: 0 }));
      check(judge(error).undecided.some(row => row.harness === 'codex' && row.repeat === 2 && row.detail.includes('failed')), '1009 e: error repeat cannot pass ' + group);
    }
    const four = made('four', 'control', 2, 4);
    equal(judge(four).bar, 'bar: met', '1009 e: four completed repeats accepted');
    for (const [harness, r] of [['claude', 4], ['codex', 2]] as const) fs.writeFileSync(countsFile(four, harness, 'rules', r), JSON.stringify({ status: 'completed', questions: 2 }));
    equal(judge(four).bar, 'bar: not met', '1009 e: fourth failure is judged');
    const shown = report(four);
    check(shown.status === 0 && shown.stdout.includes('failing: one claude r4') && shown.stdout.includes('failing: one codex r2'), '1009 c: failing lines name each harness');
    const before = made('before', 'control'), after = made('after', 'control');
    for (const field of Object.keys(hashes)) {
      const manifest: Record<string, unknown> = { repeats: 3, ...hashes }; delete manifest[field];
      fs.writeFileSync(join(before, 'manifest.json'), JSON.stringify(manifest));
      const gap = report(before, after);
      check(gap.status === 2 && gap.stderr.includes(field), '1009 e: before-folder hash gap refused: ' + field);
    }
    fs.writeFileSync(join(before, 'manifest.json'), '{');
    const broken = report(before);
    check(broken.status === 2 && broken.stderr.includes('not valid JSON') && !broken.stderr.includes('SyntaxError') && !/\n\s+at /.test(broken.stderr), '1009 d: broken JSON is a usage refusal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export async function runLane(h: Harness): Promise<void> {
  ({ selected, prerequisite, check, equal, same, failures, runCli, runCliAsync, HERE, PROGRAM_ROOT, KERNEL_COMMAND, isCompiled } = h);
if (selected(1000)) await section1000();
if (selected(1001)) await section1001();
if (selected(1002)) await section1002();
if (selected(1003)) await section1003();
if (selected(1004)) await section1004();
if (selected(1005)) await section1005();
if (selected(1006)) await section1006();
if (selected(1007)) await section1007();
if (selected(1008)) await section1008();
if (selected(1009)) await section1009();
}
