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
  const scan = (source: string) => ({
    dispatches: [...source.matchAll(/^if \(selected\(/gm)].length,
    inline: [...source.matchAll(/^if \(selected\((\d+)\)\) \{\r?$/gm)]
      .map(match => Number(match[1])).filter(number => ![169, 208, 277].includes(number)),
  });
  const { dispatches, inline } = scan(readFileSync(join(PROGRAM_ROOT, 'kernel/test/selftest.ts'), 'utf8'));
  check(dispatches > 0, '1000: no section dispatches found in selftest.ts');
  check(inline.length === 0, `1000: inline sections (${inline.length}): ${inline.join(', ')}; a new section goes in its lane's file (kernel/test/lanes/<lane>.ts); an existing inline section takes the async function sectionN() form`);
  const fixture = 'if (selected(22)) {\r\n  check(true, "fixture");\r\n}\r\nif (selected(24)) await section24();\r\n';
  equal(JSON.stringify(scan(fixture)), '{"dispatches":2,"inline":[22]}', '1000: a CRLF checkout retains both dispatches and the inline section');
  equal(scan('const noSections = true;\r\n').dispatches, 0, '1000: source without dispatches is detected');
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

async function section1010(): Promise<void> {
  const { createHash } = await import('node:crypto');
  const { enterSeatClaim, exitSeatClaim, agentProcessIdentity } = await import('../../src/seatclaim.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c163-1010-')));
  const workspace = join(root, 'library'), home = join(root, 'home'), registry = join(root, 'registry');
  const destination = process.platform === 'win32' ? join(root.slice(0, 3), 'dev', 'c163-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', LIBRARY_WORKSPACES: registry };
  const run = (args: string[], cwd = root) => runCli(['library', 'move', ...args, '--registry-root', registry, '--workspace', workspace], { cwd, env });
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name); if (file === join(registry, 'move-journals/refusals')) return [];
    if (entry.isDirectory()) return snapshot(file);
    try { return [file + ':' + createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }
    catch (error) { return [file + ':' + (error as NodeJS.ErrnoException).code]; }
  });
  try {
    fs.mkdirSync(home); fs.mkdirSync(registry); fs.mkdirSync(join(workspace, '.library'), { recursive: true });
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'c163-fixture' }));
    fs.writeFileSync(join(registry, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'c163-fixture', path: workspace }] }));
    const state = join(workspace, '.claude'), seats = join(state, 'seats');
    fs.mkdirSync(seats, { recursive: true });
    fs.writeFileSync(join(seats, '_registry.json'), JSON.stringify({ seats: [{ seat: 'busy', project: 'busy' }, { seat: 'other', project: 'other' }] }));
    const barrier = join(workspace, 'internal/maintenance-barrier.json');
    const occupied = join(root, 'occupied'); fs.mkdirSync(occupied); fs.writeFileSync(join(occupied, 'keep'), 'keep');
    const cases: [string, string[], string, (() => () => void)?][] = [
      ['missing destination', ['--preflight'], 'deskpost library move <destination>'],
      ['relative destination', ['relative', '--preflight'], 'Give a full path'],
      ['quoted destination', [process.platform === 'win32' ? "D:\\dev\\Eric's Library" : join(root, "Eric's Library"), '--preflight'], 'holds a quote character, which the settings files that name this Library cannot hold unescaped; choose a folder name without quotes'],
      ['child destination', [join(workspace, 'child'), '--preflight'], 'Choose a folder outside'],
      ['parent destination', [root, '--preflight'], 'Choose a folder outside'],
      ['missing marker', [destination, '--preflight'], 'give --workspace', () => {
        const marker = join(workspace, '.library/workspace.json'), before = fs.readFileSync(marker); fs.unlinkSync(marker);
        return () => fs.writeFileSync(marker, before);
      }],
      ['damaged marker', [destination, '--preflight'], 'repair it, then run the preview again', () => {
        const marker = join(workspace, '.library/workspace.json'), before = fs.readFileSync(marker); fs.writeFileSync(marker, '{');
        return () => fs.writeFileSync(marker, before);
      }],
      ['occupied destination', [occupied, '--preflight'], 'Choose a new folder, or empty it first'],
      ['maintenance barrier', [destination, '--preflight'], 'Lift it with:', () => {
        fs.mkdirSync(join(workspace, 'internal'), { recursive: true }); fs.writeFileSync(barrier, JSON.stringify({ run_id: 'fixture' }));
        return () => fs.unlinkSync(barrier);
      }],
      ['held seats', [destination, '--preflight', '--json'], 'close each session first', () => {
        const claims = ['busy', 'other'].map(seat => enterSeatClaim(state, seat));
        return () => claims.forEach(exitSeatClaim);
      }],
      ['orphaned seat', [destination, '--preflight', '--json'], 'close each session first', () => {
        const file = join(seats, 'busy/binding.json'); fs.mkdirSync(join(seats, 'busy'), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ state: 'committed', agent_pid: process.pid, agent_start_utc: agentProcessIdentity(process.pid, { fresh: true }) }));
        return () => fs.unlinkSync(file);
      }],
    ];
    const link = join(root, 'linked-library'); fs.symlinkSync(workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
    cases.push(['resolved child destination', [join(link, 'child'), '--preflight'], 'Choose a folder outside']);
    const fileAncestor = join(root, 'a-file'); fs.writeFileSync(fileAncestor, 'keep');
    cases.push(['file ancestor', [join(fileAncestor, 'child'), '--preflight'], 'is a file; choose a destination under a folder']);
    const dangling = join(root, 'dangling'); fs.symlinkSync(join(workspace, 'missing'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    cases.push(['dangling destination ancestor', [join(dangling, 'child'), '--preflight'], 'repair it, then run the preview again']);
    cases.push(['invalid recovery id', ['--rollback', 'bad', '--preflight'], 'Give the run id printed by the move']);
    cases.push(['two recovery forms', ['--resume', 'one', '--rollback', 'two', '--preflight'], 'Choose --resume or --rollback']);
    cases.push(['missing recovery journal', ['--rollback', 'move-missing-journal', '--preflight'], 'keep every copy and run the same recovery preview again']);
    if (process.platform === 'win32') cases.push(['outside dev', [join(root.slice(0, 3), 'outside-dev', 'library'), '--preflight'], "New folders go under a drive's dev folder"]);
    if (process.platform === 'win32') {
      const missingDrive = [...'ZYXWVUTSRQPONMLKJIHGFEDCBA'].find(letter => !fs.existsSync(letter + ':/'));
      if (missingDrive) cases.push(['unavailable drive', [missingDrive + ':/dev/library', '--preflight'], 'mount the drive or choose an available destination']);
    }
    for (const [label, args, remedy, prepare] of cases) {
      const restore = prepare?.();
      try {
        const before = snapshot(root), result = run(args);
        const warning = label === 'held seats' || label === 'orphaned seat';
        equal(result.exit, warning ? 3 : 1, '1010: refusal or warning: ' + label);
        const text = warning && result.exit === 3 ? JSON.parse(result.stdout).warnings.join('\n') : result.stderr;
        check(text.includes(remedy), `1010: ${label} names remedy ${remedy}: ${text}`);
        if (label === 'held seats') check(text.includes('busy') && text.includes('other'), '1010: names every held seat');
        same(snapshot(root), before, '1010: refusal writes nothing: ' + label);
      } finally { restore?.(); }
    }
    const before = snapshot(root), good = run([destination, '--preflight', '--json']);
    check([0, 3].includes(good.exit), '1010: good preview: ' + good.stderr);
    if ([0, 3].includes(good.exit)) check(JSON.parse(good.stdout).written === false, '1010: preview never claims a write');
    same(snapshot(root), before, '1010: preview leaves Library, registry and home byte-identical');
    check(!fs.existsSync(destination), '1010: destination not created');
    const inside = runCli(['library', 'move', destination, '--preflight', '--registry-root', registry], { cwd: workspace, env });
    equal(inside.exit, 3, '1010: resolves source from current folder marker');
    if (process.platform !== 'win32') check(run([destination, '--preflight', '--details']).stdout.includes('check does not apply'), '1010: details explains POSIX rule');
    const help = run(['--help']); equal(help.exit, 0, '1010: help succeeds');
    for (const flag of ['--preflight', '--user-confirmed', '--plan-id', '--resume', '--rollback']) check(help.stdout.includes(flag), '1010: help names ' + flag);
    for (const quote of ['"', '`']) {
      const quoted = run([destination + quote + 'quoted', '--preflight']);
      check(quoted.exit !== 0 && quoted.stderr.includes('choose a folder name without quotes'), '1010: other quote characters refused: ' + quote);
    }
    const move = await import('../../src/librarymove.ts');
    const mixed = (await move.previewLibraryMove({ destination: destination + "\t'name", workspace: join(root, 'no-library'), preflight: true }));
    check(mixed.refusal?.includes(destination + "\\u0009'name holds a control character") === true && !mixed.refusal.includes('\t'), '1010: quote and tab destination escapes its control character');
    for (const character of ['\n', '\t', '\0', '\x7f']) {
      const escaped = '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();
      const invalid = destination + character + 'control';
      const before = snapshot(root);
      const result = (await move.previewLibraryMove({ destination: invalid, workspace: join(root, 'no-library'), preflight: true, processTable: () => { throw new Error('must not read the process table'); } }));
      check(result.refusal?.includes(destination + escaped + 'control holds a control character') === true && result.refusal.includes('choose a folder name without one'), '1010: control character refused before reading: ' + escaped);
      check(!result.refusal?.includes(character), '1010: diagnostic escapes control character ' + escaped);
      same(snapshot(root), before, '1010: control refusal writes nothing ' + escaped);
    }
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1010: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1010: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1010: snapshot explains both included and excluded rows');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // AST inventory: every refusal site must have a case and a remedy, including delegated diagnostics.
  // The behavioural cases above and sections 1013 to 1016 exercise the corresponding paths.
  const remedies: [string, string][] = [
    ['image name for process', 'repair process-table access'],
    ['process table is not supported', 'repair process-table access'],
    ['writers.length', 'close it, then run the command again'],
    ['The process table could not be read', 'repair process-table access'],
    ['Run deskpost library move <destination>', '--preflight'],
    ['Give a full path', 'Give a full path'],
    ['holds a quote character', 'choose a folder name without quotes'],
    ['holds a control character', 'choose a folder name without one'],
    ['is not a folder; move it aside', 'create an empty folder named internal, then run the preview again'],
    ['is missing; create it as an empty folder', 'then run the preview again'],
    ['No Library marker found', 'give --workspace'],
    ['is unavailable', 'mount the drive or choose an available destination'],
    ['is a file', 'choose a destination under a folder'],
    ['Choose a folder outside', 'Choose a folder outside'],
    ['Choose a new folder', 'empty it first'],
    ['New folders go under', 'use '],
    ['The maintenance barrier changed', 'inspect the move journal'],
    ['belongs to another run', 'inspect its journal'],
    ['differs from its manifest', 'keep both trees and inspect'],
    ['The source folder identity changed', 'keep every copy and inspect the move journal'],
    ['The old folder changed before copying finished', 'keep both trees and inspect these files before recovery'],
    ['The old folder was restored', 'any partial copy was kept'],
    ['Restoration stopped', '--rollback'],
    ['is not a real folder', 'keep every copy and inspect the move journal'],
    ['The source path is occupied', 'keep both trees and inspect the move journal'],
    ['The retained copy path is occupied', 'keep every copy and inspect the move journal'],
    ['Keep this copy:', 'look inside before removing it by hand'],
    ['Clean-up refused:', 'run --clean-up --preflight again'],
    ['Several Libraries are registered', '--workspace'],
    ['The chosen Library is not registered', 'run the preview again with --workspace'],
    ['blockerText(inspection.blockers)', 'close it, then run the command again'],
    ['child.stderr', 'repair holder access'],
    ['older than this holder reader', 'set DESKPOST_KERNEL'],
    ['Injected move fault', '--rollback'],
    ['could not be copied after three retries', 'close its reader, then roll back'],
    ['both exist', 'inspect the move journal'],
    ['did not read back; resume', 'resume or roll back'],
    ['the registry row for', 'run the preview again'],
    ['The registry relocation did not read back', 'resume or roll back'],
    ['run the preview first', '--preflight'],
    ['run it from a folder outside', 'run it from a folder outside'],
    ['plan.reasons.join', 'run the preview again'],
    ['the Library changed since the preview', 'run the preview again'],
    ['The move journal must be outside', 'choose an outside --registry-root'],
    ['(error as Error).message + recovery', '--rollback'],
    ['Give the run id', '--rollback <run-id> --preflight'],
    ['The move journal is inconsistent', 'inspect it before recovery'],
    ['The move manifest has an unsafe path', 'inspect the journal'],
    ['saved pointer bytes do not match', 'inspect the journal'],
    ['The source tree location is unclear', 'inspect the move journal'],
    ['Both destination copies exist', 'inspect the move journal'],
    ["reasons.join('\\n')", 'run the preview again'],
    ['The moved registry row changed', 'inspect it before retrying'],
    ['The restored registry did not read back', 'inspect it before retrying'],
    ['restored bytes did not read back', 'retry the rollback'],
    ['Choose --resume or --rollback', 'preview that recovery'],
    ['Run deskpost library move --', '--preflight'],
    ['The recovery changed since the preview', 'run the recovery preview again'],
    ['Only a move past its commit point', '--rollback <run-id> --preflight'],
    ['The recovery barriers could not be updated', 'keep every copy and inspect'],
    ['Recovery stopped', 'keep every copy and run the same recovery preview again'],
    ['Check the named path or record', 'repair it, then run the preview again'],
    ['is already registered', 'run deskpost library forget'],
    ['the registry relocation did not verify', 'restore '],
    ['is a symbolic link or junction', 'resolve it by hand, then run the preview again'],
    ['is not a regular file', 'move it by hand, then run the preview again'],
    ['; repair it, then run the preview again', 'repair it, then run the preview again'],
    ['has insufficient free space', 'free space or choose another destination'],
    ['is not valid UTF-8', 'change it by hand or remove the path'],
  ];
  const ts = await import('typescript');
  const diagnostics = (text: string) => {
    const source = ts.createSourceFile('move.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), messages: string[] = [];
    const visit = (node: import('typescript').Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Error' && node.arguments?.[0]) messages.push(node.arguments[0].getText(source));
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'no' && node.arguments[0]) messages.push(node.arguments[0].getText(source));
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'refusal' && node.initializer.kind !== ts.SyntaxKind.NullKeyword) messages.push(node.initializer.getText(source));
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'reasons.push' && node.arguments[0] && !ts.isIdentifier(node.arguments[0])) messages.push(node.arguments[0].getText(source));
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'reason' && node.initializer) messages.push(node.initializer.getText(source));
      ts.forEachChild(node, visit);
    }; visit(source); return messages;
  };
  const source = fs.readFileSync(join(PROGRAM_ROOT, 'kernel/src/librarymove.ts'), 'utf8');
  const initSource = ts.createSourceFile('init.ts', fs.readFileSync(join(PROGRAM_ROOT, 'kernel/src/init.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const relocate = initSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'relocateWorkspace')?.getText(initSource) ?? '';
  const messages = diagnostics(source + '\n' + relocate);
  const delegated = new Set(['image name for process', 'process table is not supported', 'blockerText(inspection.blockers)', 'child.stderr', 'Injected move fault', 'plan.reasons.join', "reasons.join('\\n')", '(error as Error).message + recovery']);
  for (const message of messages) {
    const entry = remedies.find(([label]) => message.includes(label));
    check(Boolean(entry), '1010: refusal has a remedy case: ' + message);
    if (entry) check(message.includes(entry[1]) || (delegated.has(entry[0]) && source.includes(entry[1])), '1010: refusal retains its next step: ' + entry[0]);
  }
  for (const [label] of remedies) check(messages.some(message => message.includes(label)), '1010: remedy entry still names a refusal: ' + label);
  check(diagnostics("throw new Error('a new refusal without a remedy');").some(message => !remedies.some(([label]) => message.includes(label))), '1010: a new uncatalogued refusal fails the inventory');
}

async function section1011(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c163-1011-')));
  const workspace = join(root, 'vault/library-Ä'), home = join(root, 'home'), appdata = join(root, 'appdata'), registry = join(root, 'registry');
  const destination = process.platform === 'win32' ? join(root.slice(0, 3), 'dev', 'c163-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  const env = { HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', LIBRARY_WORKSPACES: registry };
  const planted = new Map<string, string>();
  const put = (file: string, text: string | Buffer, rewrite?: string) => {
    fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text);
    if (rewrite) planted.set(file, rewrite);
  };
  try {
    put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'c163-fixture' }));
    put(join(registry, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: workspace, id: 'c163-fixture' }] }), 'program');
    for (const file of ['.mcp.json', '.codex/config.toml', '.codex/hooks.json', '.claude/settings.json', '.claude/settings.local.json', '.agents/one.md', '.agents/nested/two.md']) {
      put(join(workspace, file), JSON.stringify({ path: workspace }), 'program');
    }
    // Match either separator and any case on Windows, plus the doubled separators in JSON; keep the extension apart.
    // s218 row 1: each path in its own JSON string (the three raw-text lines are a case of their own below).
    const threeLines = `${workspace}\n${process.platform === 'win32' ? workspace.toLowerCase().replace(/\\/g, '/') : workspace}\n${workspace}-different\n`;
    put(join(workspace, '.mcp.json'), JSON.stringify({ a: workspace, b: process.platform === 'win32' ? workspace.toLowerCase().replace(/\\/g, '/') : workspace, c: workspace + '-different' }));
    for (const file of ['.claude/settings.json', '.claude.json', '.codex/config.toml']) put(join(home, file), JSON.stringify({ path: workspace }), 'eric');
    if (process.platform === 'win32') {
      for (const profile of ['first', 'second']) for (const file of ['.claude.json', '.claude/settings.json', 'CLAUDE.md']) {
        put(join(appdata, 'orca/claude-profiles', profile, 'home', file), JSON.stringify({ path: workspace }), 'orca');
      }
      put(join(appdata, 'orca/store.json'), JSON.stringify({ path: workspace }), 'orca');
      put(join(appdata, 'orca/store.db'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(workspace), Buffer.from([0, 254])]), 'orca');
    }
    put(join(home, 'outside-search.txt'), workspace);
    put(join(workspace, 'outside-config.txt'), workspace);
    fs.mkdirSync(join(root, 'vault/.obsidian'), { recursive: true });
    const unreadable = join(workspace, '.agents/unreadable.md');
    put(unreadable, workspace);
    let unlock: (() => void) | undefined;
    if (process.platform === 'win32') {
      const { openShareNothing } = await import('../../src/seatclaim.ts');
      const handle = openShareNothing(unreadable); unlock = () => handle.close();
    } else {
      fs.chmodSync(unreadable, 0);
      try { fs.readFileSync(unreadable); check(true, '1011: unreadable file skipped: this account can read mode 000'); }
      catch { planted.set(unreadable, 'unknown'); }
      unlock = () => fs.chmodSync(unreadable, 0o600);
    }
    try {
      if (process.platform === 'win32') planted.set(unreadable, 'unknown');
      else if (!planted.has(unreadable)) planted.set(unreadable, 'program');
      const run = (cwd: string) => runCli(['library', 'move', destination, '--preflight', '--workspace', workspace, '--registry-root', registry, '--json'], { cwd, env });
      const result = run(root);
      equal(result.exit, 3, '1011: not-ready preview: ' + result.stderr);
      if (![0, 3].includes(result.exit)) return;
      const value = JSON.parse(result.stdout);
      same(value.pointers?.map((row: { file: string }) => row.file).sort(), [...planted.keys()].sort(), '1011: exactly the planted pointer files');
      for (const [file, rewrite] of planted) {
        const row = value.pointers?.find((r: { file: string }) => r.file === file);
        equal(row?.rewrite, rewrite, '1011: rewrite owner for ' + file);
        equal(row?.occurrences, rewrite === 'unknown' ? 0 : file === join(workspace, '.mcp.json') ? 2 : 1, '1011: occurrence count for ' + file);
        equal(row?.ambiguous, file === join(workspace, '.mcp.json') ? 1 : 0, '1011: ambiguous count for ' + file);
        if (rewrite === 'unknown') check(Boolean(row?.reason), '1011: unreadable reason named');
      }
      equal(value.inside_obsidian_vault, true, '1011: inside vault');
      equal(value.obsidian_vault, join(root, 'vault'), '1011: vault folder named');
      equal(value.cwd_inside_library, false, '1011: outside current folder');
      const inside = run(workspace);
      equal(inside.exit, 3, '1011: inside preview');
      if ([0, 3].includes(inside.exit)) equal(JSON.parse(inside.stdout).cwd_inside_library, true, '1011: inside current folder');
      const human = runCli(['library', 'move', destination, '--preflight', '--details', '--workspace', workspace, '--registry-root', registry], { cwd: root, env });
      check(human.stdout.includes('Who may rewrite: program') && human.stdout.includes('Who may rewrite: eric') && human.stdout.includes('Not searched:'), '1011: human groups owners and closes with search limits');
      check(human.stdout.includes('Check any rewritten value whose earlier text is not a command word: a relative folder named like an option, or ending in a space or a quote, before the Library path is rewritten too.'), '1011: human names the accepted risk');
      if (process.platform === 'win32') check(human.stdout.includes('Who may rewrite: orca') && human.stdout.includes('Who may rewrite: unknown'), '1011: human names Orca and unreadable files');
    } finally { unlock?.(); }
    const runPreview = () => runCli(['library', 'move', destination, '--preflight', '--workspace', workspace, '--registry-root', registry, '--json'], { cwd: root, env });
    put(join(workspace, '.mcp.json'), threeLines);
    const rawLines = JSON.parse(runPreview().stdout).pointers.find((p: { file: string }) => p.file === join(workspace, '.mcp.json'));
    equal(rawLines?.occurrences, 0, '1011: raw-text lines in .mcp.json, outside any string: occurrences');
    equal(rawLines?.ambiguous, 3, '1011: raw-text lines in .mcp.json, outside any string: ambiguous count');
    for (const suffix of ['(backup)', '-DSH']) {
      put(join(workspace, '.mcp.json'), workspace + suffix);
      const result = runPreview(); check([0, 3].includes(result.exit), '1011: ambiguous preview');
      const row = JSON.parse(result.stdout).pointers.find((p: { file: string }) => p.file === join(workspace, '.mcp.json'));
      equal(row?.occurrences, 0, '1011: no rewrite of ' + suffix); equal(row?.ambiguous, 1, '1011: counts ambiguous ' + suffix);
    }
    put(join(workspace, '.mcp.json'), Buffer.concat([Buffer.from(workspace), Buffer.from([255])]));
    let value = JSON.parse(runPreview().stdout);
    check(value.executable === false && value.not_executable_reasons.some((s: string) => s.includes('not valid UTF-8') && s.includes('change it by hand')), '1011: invalid pointer cannot execute');
    put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace }));
    fs.symlinkSync(home, join(workspace, 'linked-home'), process.platform === 'win32' ? 'junction' : 'dir');
    value = JSON.parse(runPreview().stdout);
    check(value.executable === false && value.not_executable_reasons.some((s: string) => s.includes('linked-home')), '1011: link inside prevents execution');
    check(typeof value.plan_id === 'string' && value.plan_id.length === 64 && value.source_manifest.length > 0 && value.expected_destination_manifest.length > 0, '1011: manifests and plan id');
    const beforeId = value.plan_id; put(join(workspace, 'new-file'), 'changed');
    check(JSON.parse(runPreview().stdout).plan_id !== beforeId, '1011: all source bytes bind the plan');
    if (process.platform !== 'win32') check(true, '1011: Unicode case folding does not apply on POSIX');
    check(!fs.existsSync(join(workspace, 'internal')), '1011: missing internal fixture starts without the folder');
    const missingInternal = JSON.parse(runPreview().stdout);
    check(missingInternal.executable === false && missingInternal.not_executable_reasons.includes(join(workspace, 'internal') + ' is missing; create it as an empty folder, then run the preview again'), '1011: missing internal folder prevents execution with remedy');
    check(!fs.existsSync(join(workspace, 'internal')), '1011: missing internal preview creates no folder');
    const internal = join(workspace, 'internal');
    fs.writeFileSync(internal, 'a file, not a folder');
    const fileInternal = JSON.parse(runPreview().stdout);
    check(fileInternal.executable === false && fileInternal.not_executable_reasons.includes(internal + ' is not a folder; move it aside and create an empty folder named internal, then run the preview again'), '1011: file internal prevents execution with remedy');
    equal(fs.readFileSync(internal, 'utf8'), 'a file, not a folder', '1011: internal file preserved');
    fs.unlinkSync(internal); // Replace only this fixture's file with a fixture link.
    for (const target of [home, join(root, 'missing-link-target')]) {
      fs.symlinkSync(target, internal, process.platform === 'win32' ? 'junction' : 'dir');
      const linkedInternal = JSON.parse(runPreview().stdout);
      check(linkedInternal.executable === false && linkedInternal.not_executable_reasons.includes(internal + ' is not a folder; move it aside and create an empty folder named internal, then run the preview again'), '1011: linked internal prevents execution with remedy: ' + target);
      fs.unlinkSync(internal); // Only this fixture link, preserving its target.
    }
    // s215 row 1, s217 row 2, s218 row 1: a Library path rewrites only when it is the first path in its value (a JSON or
    // TOML string, else the line): no / or \ before it there, and before it only nothing, an option, a variable or a tool
    // pattern after the nearest whitespace or quote. Each case is written to its own file (JSON in .mcp.json, TOML in
    // .codex/config.toml, plain text under .agents/), previewed, then moved to the staging copy (stopped before promote),
    // so the expected manifest and the staged bytes are both read. Each case names its verdict at the base (acd83bb8, one
    // character before the path decided) and after s218; the fail-first run fails exactly the cases where they differ.
    const move = await import('../../src/librarymove.ts');
    const { createHash } = await import('node:crypto');
    const savedEnv = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
    type Verdict = 'rewrite' | 'ambiguous';
    type Form = { file: string; text: (library: string) => string; rewritten?: (library: string, destination: string) => string };
    const S = '/server.js';
    // A JSON or TOML basic string holds the path escaped (doubled separators on Windows) and rewrites with the same escaping.
    const json = (value: (library: string) => string): Form => ({ file: '.mcp.json', text: l => JSON.stringify({ v: value(l) }), rewritten: (_l, d) => JSON.stringify({ v: value(d) }) });
    const toml = (value: (library: string) => string): Form => ({ file: '.codex/config.toml', text: l => `path = ${JSON.stringify(value(l))}\n`, rewritten: (_l, d) => `path = ${JSON.stringify(value(d))}\n` });
    const plain = (value: (library: string) => string): Form => ({ file: '.agents/case.md', text: l => value(l) + '\n' });
    const raw = (file: string, text: (library: string) => string): Form => ({ file, text });
    const boundaryCases: ({ name: string; base: Verdict; after: Verdict; refused?: true } & Form)[] = [
      // Ambiguous after s218: an earlier path, or earlier text that is no command word.
      { name: '/backup= in a JSON string (library-auditor\'s witness)', base: 'rewrite', after: 'ambiguous', ...json(l => '/backup=' + l + S) },
      { name: '/backup+ in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => '/backup+' + l + S) },
      { name: '/a, in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/a,' + l + S) },
      { name: '/a( in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/a(' + l + S) },
      { name: '/a: in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/a:' + l + S) },
      { name: '/a; in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/a;' + l + S) },
      { name: '/x= in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/x=' + l + S) },
      { name: '[t]( in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '[t](' + l + S) },
      { name: 'file:/// in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => 'file:///' + l + S) },
      { name: ']= in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => ']=' + l + S) },
      { name: '-= in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '-=' + l + S) },
      { name: '--1x= in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '--1x=' + l + S) },
      { name: 'Read ( in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => 'Read (' + l + S) },
      { name: '/backup and a space in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/backup ' + l + S) },
      { name: '/home/my backup and a space in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/home/my backup ' + l + S) },
      { name: "/o' in a JSON string", base: 'rewrite', after: 'ambiguous', ...json(l => "/o'" + l + S) },
      { name: '/o` in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/o`' + l + S) },
      { name: 'a second path in one JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => 'node ' + (process.platform === 'win32' ? 'D:/a/x.js ' : '/a/x.js ') + l + S) },
      { name: "/backup ' in a JSON string", base: 'rewrite', after: 'ambiguous', ...json(l => "/backup '" + l + S) },
      { name: '/backup ` in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/backup `' + l + S) },
      { name: '/backup and an escaped quote in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => '/backup "' + l + S) },
      { name: '/backup= in a TOML string', base: 'rewrite', after: 'ambiguous', ...toml(l => '/backup=' + l + S) },
      { name: '/backup+ in a TOML string', base: 'ambiguous', after: 'ambiguous', ...toml(l => '/backup+' + l + S) },
      { name: '/a, in a TOML string', base: 'rewrite', after: 'ambiguous', ...toml(l => '/a,' + l + S) },
      { name: '/a( in a TOML string', base: 'rewrite', after: 'ambiguous', ...toml(l => '/a(' + l + S) },
      { name: '/backup=" in a TOML literal string', base: 'rewrite', after: 'ambiguous', ...raw('.codex/config.toml', l => `path = '/backup="${l}${S}'\n`) },
      { name: 'outside any string in .mcp.json', base: 'rewrite', after: 'ambiguous', ...raw('.mcp.json', l => `{"a": 1}\n${l}${S}\n`) },
      { name: 'outside any string in .codex/config.toml', base: 'rewrite', after: 'ambiguous', ...raw('.codex/config.toml', l => `path = ${l}${S}\n`) },
      { name: 'an unclosed JSON string', base: 'rewrite', after: 'ambiguous', ...raw('.mcp.json', l => `{"path": ${JSON.stringify(l + S).slice(0, -1)}\n`) },
      // s223 (unit B, plan D5.2): a TOML file the scanner cannot read that holds the path is refused, so the move stops.
      { name: 'a four-quote multiline basic string in TOML, the path in single quotes', base: 'rewrite', after: 'ambiguous', refused: true, ...raw('.codex/config.toml', l => `path = """"\n/backup\n'${l}'\n""""\n`) },
      { name: 'an escaped backslash before an escaped quote in a JSON string', base: 'rewrite', after: 'ambiguous', ...json(l => 'node \\"' + l + S) },
      { name: 'prefixed by /backup in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => 'node /backup' + l + S) },
      { name: 'prefixed by a letter in text', base: 'ambiguous', after: 'ambiguous', ...plain(l => 'x' + l + S) },
      { name: 'prefixed by a backslash in text', base: 'ambiguous', after: 'ambiguous', ...plain(l => '\\' + l + S) },
      { name: 'prefixed by a slash in text', base: 'ambiguous', after: 'ambiguous', ...plain(l => '/' + l + S) },
      { name: 'prefixed by ~ in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => '~' + l + S) },
      { name: 'prefixed by @ in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => '@' + l + S) },
      { name: 'prefixed by % in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => '%' + l + S) },
      { name: 'prefixed by # in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => '#' + l + S) },
      { name: 'prefixed by é in a JSON string', base: 'ambiguous', after: 'ambiguous', ...json(l => 'é' + l + S) },
      // s218 spare review-nits-s217: U+0085 NEXT LINE is no whitespace to the rule, and an emoji (a surrogate pair) no command word.
      { name: 'prefixed by U+0085 NEXT LINE in text', base: 'ambiguous', after: 'ambiguous', ...plain(l => '\u0085' + l + S) },
      { name: 'prefixed by an emoji in text', base: 'ambiguous', after: 'ambiguous', ...plain(l => '\u{1F600}' + l + S) },
      // Rewritten after s218: the first path in its value, after nothing, an option, a variable or a tool pattern.
      { name: '--workspace= in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => '--workspace=' + l + S) },
      { name: '-C= in text', base: 'rewrite', after: 'rewrite', ...plain(l => '-C=' + l + S) },
      { name: 'LIBRARY_WORKSPACE= in text', base: 'rewrite', after: 'rewrite', ...plain(l => 'LIBRARY_WORKSPACE=' + l + S) },
      { name: '_X= in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => '_X=' + l + S) },
      { name: 'Read( in a JSON string, then /**)', base: 'rewrite', after: 'rewrite', ...json(l => 'Read(' + l + '/**)') },
      { name: 'Bash(git -C in a JSON string, then /app merge:*)', base: 'rewrite', after: 'rewrite', ...json(l => 'Bash(git -C ' + l + '/app merge:*)') },
      { name: 'alone in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => l) },
      { name: 'in a TOML basic string', base: 'rewrite', after: 'rewrite', ...toml(l => l + S) },
      { name: 'in a TOML literal string', base: 'rewrite', after: 'rewrite', ...raw('.codex/config.toml', l => `path = '${l}${S}'\n`) },
      { name: 'after a space in text', base: 'rewrite', after: 'rewrite', ...plain(l => 'node ' + l + S) },
      { name: 'after " in text', base: 'rewrite', after: 'rewrite', ...plain(l => '"' + l + S + '"') },
      { name: "after ' in text", base: 'rewrite', after: 'rewrite', ...plain(l => "'" + l + S + "'") },
      { name: 'after ` in text', base: 'rewrite', after: 'rewrite', ...plain(l => '`' + l + S + '`') },
      { name: 'at the start of a text file', base: 'rewrite', after: 'rewrite', ...plain(l => l + S) },
      { name: 'after an escaped quote in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => 'node "' + l + S) },
      { name: 'accepted risk: backup and a space in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => 'backup ' + l + S) },
      { name: "accepted risk: backup' in a JSON string", base: 'rewrite', after: 'rewrite', ...json(l => "backup'" + l + S) },
      { name: 'accepted risk: --x= in a JSON string', base: 'rewrite', after: 'rewrite', ...json(l => '--x=' + l + S) },
    ];
    try {
      // s217 row 2, s218 row 1: every printable ASCII character and one non-ASCII letter before the path in a text line (the
      // line is the value). Only a quote is a boundary there; every other character is ambiguous (whitespace is not printable,
      // so the space cases above cover it). At the base, = : ; , ( [ { < > also rewrote.
      const pathStarts = new Set(['"', "'", '`']);
      const table = join(root, 'boundary', 'table'), tableLibrary = join(table, 'library'), tableRegistry = join(table, 'registry'), tableDestination = join(table, 'destination');
      for (const [key] of savedEnv) process.env[key] = join(table, 'home');
      put(join(tableLibrary, '.library/workspace.json'), JSON.stringify({ id: 'boundary' })); fs.mkdirSync(join(tableLibrary, 'internal'));
      put(join(tableRegistry, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: tableLibrary, id: 'boundary' }] }));
      const characters = [...Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)), 'é'];
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      for (const char of characters) {
        const label = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} ${char}`, starts = pathStarts.has(char);
        const original = 'run ' + char + tableLibrary + '"\n';
        put(join(tableLibrary, '.agents/table.md'), original);
        const preview = (await move.previewLibraryMove({ workspace: tableLibrary, destination: tableDestination, registryRoot: tableRegistry, destinationRule: 'any', processTable: () => [], preflight: true }));
        equal(preview.refusal, null, '1011: start table preview: ' + label);
        const value = preview.value as Record<string, any>;
        if (!value) continue;
        const pointer = value.pointers.find((p: { file: string }) => p.file === join(tableLibrary, '.agents/table.md'));
        equal(pointer?.occurrences, starts ? 1 : 0, '1011: start table occurrences: ' + label);
        equal(pointer?.ambiguous, starts ? 0 : 1, '1011: start table ambiguous count: ' + label);
        equal(value.expected_destination_manifest.find((r: { relative: string }) => r.relative === '.agents/table.md')?.sha256,
          sha(starts ? original.split(tableLibrary).join(tableDestination) : original), '1011: start table expected manifest: ' + label);
      }
      let index = 0;
      for (const row of boundaryCases) {
        const folder = join(root, 'boundary', String(++index)), library = join(folder, 'library'), registryRoot = join(folder, 'registry'), destination = join(folder, 'destination');
        for (const [key] of savedEnv) process.env[key] = join(folder, 'home');
        put(join(library, '.library/workspace.json'), JSON.stringify({ id: 'boundary' })); fs.mkdirSync(join(library, 'internal'));
        put(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: library, id: 'boundary' }] }));
        const original = row.text(library), rewrites = row.after === 'rewrite';
        // Plain text and TOML literal strings rewrite by plain replacement (native separators, no doubling); JSON and TOML
        // basic strings keep their escaping.
        const expected = !rewrites ? original : row.rewritten ? row.rewritten(library, destination) : original.split(library).join(destination);
        put(join(library, row.file), original);
        const options = { workspace: library, destination, registryRoot, destinationRule: 'any' as const, processTable: () => [], preflight: true };
        const preview = (await move.previewLibraryMove(options));
        equal(preview.refusal, null, '1011: boundary preview: ' + row.name);
        const value = preview.value as Record<string, any>;
        if (!value) continue;
        const pointer = value.pointers.find((p: { file: string }) => p.file === join(library, row.file));
        equal(pointer?.occurrences, rewrites ? 1 : 0, '1011: boundary occurrences: ' + row.name);
        equal(pointer?.ambiguous, rewrites ? 0 : 1, '1011: boundary ambiguous count: ' + row.name);
        const sha = (text: string) => createHash('sha256').update(text).digest('hex');
        equal(value.expected_destination_manifest.find((r: { relative: string }) => r.relative === row.file)?.sha256, sha(expected), '1011: boundary expected manifest: ' + row.name);
        const stopped = (await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: value.plan_id, faultAt: 'promote:before' }));
        if (row.refused) { check(stopped.refusal?.includes(join(library, row.file) + ': the old path may be written here in a form the move cannot read; change it by hand, then run the preview again') === true, '1011: boundary move refuses the file it cannot read: ' + row.name + ': ' + stopped.refusal); continue; }
        check(stopped.refusal?.includes('Injected move fault') === true, '1011: boundary move reaches the staged copy: ' + row.name + ': ' + stopped.refusal);
        const staging = fs.readdirSync(folder).find(name => name.startsWith('destination.partial-'));
        equal(staging ? fs.readFileSync(join(folder, staging, row.file), 'utf8') : 'no staged copy', expected, '1011: boundary staged bytes: ' + row.name);
      }
      // s218 row 1: the binary branch (an Orca store, read on Windows only), where the value is the run of printable bytes.
      // At the base all four counted (0x01 is the s218 spare review-nits-s217: a control byte other than 0x00).
      if (process.platform !== 'win32') check(true, '1011: binary branch cases skipped: Orca stores are read on Windows only');
      else for (const [name, lead, after] of [['a byte 0x00', 0x00, 'rewrite'], ['a byte 0x01', 0x01, 'rewrite'], ['"', 0x22, 'rewrite'], ['=', 0x3d, 'ambiguous']] as const) {
        const folder = join(root, 'binary', String(lead)), library = join(folder, 'library'), registryRoot = join(folder, 'registry');
        for (const [key] of savedEnv) process.env[key] = join(folder, 'home');
        put(join(library, '.library/workspace.json'), JSON.stringify({ id: 'binary' })); fs.mkdirSync(join(library, 'internal'));
        put(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: library, id: 'binary' }] }));
        put(join(folder, 'home', 'orca', 'store.db'), Buffer.concat([Buffer.from([1, lead]), Buffer.from(library), Buffer.from([0])]));
        const preview = (await move.previewLibraryMove({ workspace: library, destination: join(folder, 'destination'), registryRoot, destinationRule: 'any', processTable: () => [], preflight: true }));
        const pointer = (preview.value as Record<string, any> | undefined)?.pointers?.find((p: { file: string }) => p.file === join(folder, 'home', 'orca', 'store.db'));
        equal(pointer?.occurrences, after === 'rewrite' ? 1 : 0, '1011: binary occurrences after ' + name);
        equal(pointer?.ambiguous, after === 'rewrite' ? 0 : 1, '1011: binary ambiguous count after ' + name);
      }
    } finally { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1012(): Promise<void> {
  const { previewLibraryMove } = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c163-1012-')));
  const workspace = join(root, 'library'), home = join(root, 'home'), registry = join(root, 'registry');
  const destination = process.platform === 'win32' ? join(root.slice(0, 3), 'dev', 'c163-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const put = (relative: string, text: string) => { const file = join(workspace, relative); fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name); if (file === join(registry, 'move-journals/refusals')) return []; return entry.isDirectory() ? snapshot(file) : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  try {
    for (const [key] of saved) process.env[key] = home;
    fs.mkdirSync(home); fs.mkdirSync(registry);
    put('.library/workspace.json', JSON.stringify({ id: 'c163-fixture' }));
    put('internal/journals/first.json', JSON.stringify({ before: workspace, after: workspace }));
    put('internal/journals/nested/second.json', workspace);
    put('internal/other/record.json', workspace);
    put('collection/book/wiki/page.md', 'Old home: ' + workspace);
    put('shelf/unrelated.md', 'A different path');
    put('raw/large.txt', workspace + 'x'.repeat(2048));
    const before = snapshot(root);
    const result = (await previewLibraryMove({ destination, workspace, registryRoot: registry, preflight: true, details: true, historyByteLimit: 1024 }));
    equal(result.refusal, null, '1012: history preview: ' + result.refusal);
    const value = result.value as Record<string, unknown> | null;
    same(value?.history, [{ folder: 'collection', files: 1 }, { folder: 'internal/journals', files: 2 }, { folder: 'internal/other', files: 1 }], '1012: history grouped by folder and counts files rather than occurrences');
    same(value?.history_skipped, [{ folder: 'raw', files: 1 }], '1012: large file counted without an 8 MB fixture');
    same(value?.history_unreadable, [], '1012: no hidden unreadable files');
    check(result.humanText?.includes('left as written and readable by their old path in the aside copy') === true, '1012: explains history remains readable');
    check(result.humanText?.includes('History skipped: raw: 1 files') === true, '1012: human skipped count');
    same(snapshot(root), before, '1012: history, home and registry byte-identical');
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1012: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1012: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1012: snapshot explains both included and excluded rows');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1013(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const init = await import('../../src/init.ts');
  check(typeof move.quietCheck === 'function' && typeof init.relocateWorkspace === 'function', '1013: quiet check and relocation exist');
  if (typeof move.quietCheck !== 'function' || typeof init.relocateWorkspace !== 'function') return;
  const rows = [
    { pid: process.pid, parentPid: 900001, name: 'node' }, { pid: 900001, parentPid: 0, name: 'codex.exe' },
    ...['CLAUDE.exe', 'codex', 'codex-windows-sandbox-service.exe', 'Orca', 'library.exe', 'deskpost'].map((name, n) => ({ pid: 900010 + n, parentPid: 0, name })),
    { pid: 900020, parentPid: 0, name: 'node.exe', commandLine: 'node C:/program/kernel/src/cli.ts' },
    { pid: 900021, parentPid: 0, name: 'node', commandLine: 'node other-program.js' },
    { pid: 900022, parentPid: 0, name: 'node', commandLine: null },
    { pid: 900023, parentPid: 0, name: 'system', commandLine: null },
    { pid: 900024, parentPid: 0, name: 'Obsidian.exe' },
    { pid: 900025, parentPid: 0, name: 'node', commandLine: 'node C:/apps/codex/plugin.js' },
    { pid: 900026, parentPid: 0, name: 'node', commandLine: 'node library.ts' },
    { pid: 900027, parentPid: 0, name: 'node', commandLine: '"C:\\Program Files\\nodejs\\node.exe" "library.ts" desk' },
    { pid: 900028, parentPid: 0, name: 'node', commandLine: 'node notlibrary.ts' },
    { pid: 900029, parentPid: 0, name: 'node', commandLine: 'node cli.ts desk' },
    { pid: 900030, parentPid: 0, name: 'node', commandLine: 'node notcli.ts' },
  ];
  const quiet = move.quietCheck({ processTable: () => rows });
  same(quiet.writers.map(row => row.pid), [900010, 900011, 900012, 900013, 900014, 900015, 900020, 900022, 900025, 900026, 900027, 900029], '1013: exactly the writers, without ancestors');
  for (const row of quiet.writers) check(Boolean(quiet.refusal?.includes(String(row.pid)) && quiet.refusal.includes(row.name) && quiet.refusal.includes('close it, then run the command again')), '1013: names writer and remedy: ' + row.pid);
  for (const pid of [900026, 900027]) check(quiet.writers.some(row => row.pid === pid) && quiet.refusal?.includes(String(pid)) === true, '1013: bare Library writer refused by pid ' + pid);
  check(!quiet.writers.some(row => row.pid === 900028), '1013: notlibrary.ts stays allowed');
  check(quiet.writers.some(row => row.pid === 900029) && quiet.refusal?.includes('900029') === true, '1013: bare cli.ts refused by pid');
  check(!quiet.writers.some(row => row.pid === 900030), '1013: notcli.ts stays allowed');
  check(move.quietCheck({ processTable: () => rows, inside_obsidian_vault: true }).writers.some(row => row.pid === 900024), '1013: Obsidian when inside a vault');
  equal(move.quietCheck({ processTable: () => rows.filter(row => [900021, 900023, 900024].includes(row.pid)) }).refusal, null, '1013: other processes pass');
  check(move.quietCheck({ processTable: () => { throw new Error('fixture unreadable'); } }).refusal?.includes('repair process-table access') === true, '1013: unreadable table fails closed');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1013-')));
  const file = join(root, 'workspaces.json'), from = { path: join(root, 'source'), id: 'same-id' }, to = join(root, 'destination');
  const before = JSON.stringify({ version: 1, extra: 'keep', workspaces: [{ ...from, default: true, custom: 42 }] });
  try {
    fs.writeFileSync(file, before); init.relocateWorkspace(root, from, to);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    same(value.workspaces, [{ path: to, id: from.id, default: true, custom: 42 }], '1013: row replaced, fields and id kept');
    equal(value.extra, 'keep', '1013: document fields kept');
    for (const [document, expected] of [
      [JSON.stringify({ workspaces: [{ ...from }, { path: to, id: 'another' }] }), 'already registered'],
      [JSON.stringify({ workspaces: [{ ...from, id: 'changed' }] }), 'changed since the preview'],
    ]) {
      fs.writeFileSync(file, document!); let refusal = '';
      try { init.relocateWorkspace(root, from, to); } catch (error) { refusal = (error as Error).message; }
      check(refusal.includes(expected!), '1013: registry refusal ' + expected); equal(fs.readFileSync(file, 'utf8'), document, '1013: refused registry unchanged');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1014(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  check(typeof move.moveLibrary === 'function', '1014: move exists'); if (typeof move.moveLibrary !== 'function') return;
  const { createHash } = await import('node:crypto');
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1014-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA', 'LIBRARY_WORKSPACES'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, key === 'LIBRARY_WORKSPACES' ? 'registry' : 'home');
    const fixture = async (label: string) => {
      const folder = join(root, label), workspace = join(folder, 'source'), registryRoot = join(folder, 'registry');
      const destination = process.platform === 'win32' && label === 'real-table' ? join(root.slice(0, 3), 'dev', 'c183-writer-' + root.split(/[\\/]/).pop()) : join(folder, 'destination');
      const put = (file: string, text: string | Buffer) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: label }));
      fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(join(workspace, 'empty'));
      put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace, history: workspace + '(backup)' }));
      put(join(workspace, 'history.md'), workspace);
      put(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: workspace, id: label, default: true }] }));
      put(join(root, 'home/.claude.json'), JSON.stringify({ path: workspace }));
      put(join(root, 'home/orca/store.json'), JSON.stringify({ path: workspace }));
      put(join(root, 'home/orca/store.db'), Buffer.concat([Buffer.from(workspace), Buffer.from([0, 255])]));
      let calls = 0;
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => { calls++; return []; } };
      const preview = (await move.previewLibraryMove(options)); equal(preview.refusal, null, '1014: preview ' + label);
      const plan = preview.value as Record<string, any>; calls = 0;
      return { folder, workspace, destination, registryRoot, options, plan, put, calls: () => calls };
    };
    const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      if (entry.isSymbolicLink()) return [join(folder, entry.name) + ':link:' + fs.readlinkSync(join(folder, entry.name))];
      const file = join(folder, entry.name); if (file === join(root, file.slice(root.length + 1).split(/[\\/]/)[0]!, 'registry/move-journals/refusals')) return []; return entry.isDirectory() ? snapshot(file) : [file + ':' + sha(fs.readFileSync(file))];
    });
    const success = (await fixture('success'));
    const pointer = join(root, 'home/.claude.json'), beforePointer = fs.readFileSync(pointer);
    const result = (await move.moveLibrary({ ...success.options, preflight: false, userConfirmed: true, planId: success.plan.plan_id }));
    equal(result.refusal, null, '1014: success ' + result.refusal);
    if (!result.refusal) {
      const value = result.value as Record<string, any>, journal = JSON.parse(fs.readFileSync(join(value.journal, 'journal.json'), 'utf8'));
      check(fs.existsSync(value.aside) && !fs.existsSync(success.workspace), '1014: source renamed aside');
      equal(fs.readFileSync(join(value.aside, '.mcp.json'), 'utf8'), JSON.stringify({ path: success.workspace, history: success.workspace + '(backup)' }), '1014: aside bytes kept');
      equal(fs.readFileSync(join(success.destination, '.mcp.json'), 'utf8'), JSON.stringify({ path: success.destination, history: success.workspace + '(backup)' }), '1014: only exact program pointer rewritten');
      equal(fs.readFileSync(join(success.destination, 'history.md'), 'utf8'), success.workspace, '1014: history unchanged');
      check(fs.statSync(join(success.destination, 'empty')).isDirectory(), '1014: empty folder copied');
      equal(fs.readFileSync(pointer, 'utf8'), JSON.stringify({ path: success.destination }), '1014: outside pointer rewritten');
      check(fs.readFileSync(join(value.journal, 'pointer-0-before')).equals(beforePointer), '1014: prior bytes saved outside both trees');
      same(journal.sourceManifest, success.plan.source_manifest, '1014: journal source manifest'); same(journal.expectedManifest, success.plan.expected_destination_manifest, '1014: journal expected manifest');
      const registry = JSON.parse(fs.readFileSync(join(success.registryRoot, 'workspaces.json'), 'utf8'));
      same(registry.workspaces, [{ path: success.destination, id: 'success', default: true }], '1014: registry relocated and identity kept');
      check(!fs.existsSync(join(success.destination, 'internal/maintenance-barrier.json')) && fs.existsSync(join(value.aside, 'internal/maintenance-barrier.json')), '1014: only destination barrier lifted');
      check(fs.existsSync(join(success.destination, 'internal/move-journals', value.run_id, 'journal.json')), '1014: destination has journal copy');
      check(value.left_and_listed.some((line: string) => line.includes('ambiguous')), '1014: ambiguous occurrence listed');
      if (process.platform === 'win32') check(value.left_and_listed.some((line: string) => line.includes('open the workspace again in Orca')), '1014: database remedy listed');
    }
    const drift = (await fixture('drift')); drift.put(join(drift.workspace, 'changed'), 'changed'); const before = snapshot(root);
    check((await move.moveLibrary({ ...drift.options, preflight: false, userConfirmed: true, planId: drift.plan.plan_id })).refusal?.includes('changed since the preview') === true, '1014: stale plan refused');
    same(snapshot(root), before, '1014: stale plan writes nothing');
    const missingInternal = (await fixture('missing-internal'));
    fs.rmdirSync(join(missingInternal.workspace, 'internal')); // This fixture's empty folder only.
    const missingBefore = snapshot(missingInternal.workspace);
    const missingPlan = (await move.previewLibraryMove(missingInternal.options)).value as Record<string, any>;
    const missingResult = (await move.moveLibrary({ ...missingInternal.options, preflight: false, userConfirmed: true, planId: missingPlan.plan_id }));
    check(missingResult.refusal?.includes(join(missingInternal.workspace, 'internal') + ' is missing') === true, '1014: missing internal refuses an in-process move');
    same(snapshot(missingInternal.workspace), missingBefore, '1014: missing internal move leaves source bytes unchanged');
    check(!fs.existsSync(join(missingInternal.workspace, 'internal')), '1014: missing internal move creates no folder');
    // Exercise barrier itself after the plan: remove the empty folder at its step's fault seam.
    const missingBarrier = (await fixture('missing-barrier'));
    const barrierBefore = snapshot(missingBarrier.workspace);
    const barrierResult = (await move.moveLibrary({ ...missingBarrier.options, preflight: false, userConfirmed: true, planId: missingBarrier.plan.plan_id,
      get faultAt() {
        // step() reads this immediately before barrier's effect. Remove this fixture's empty folder only.
        if (fs.existsSync(join(missingBarrier.workspace, 'internal'))) fs.rmdirSync(join(missingBarrier.workspace, 'internal'));
        return undefined;
      },
    }));
    check(barrierResult.refusal?.includes(join(missingBarrier.workspace, 'internal') + ' is missing') === true, '1014: barrier refuses its missing internal folder');
    check(!fs.existsSync(join(missingBarrier.workspace, 'internal')), '1014: barrier creates no missing internal folder');
    same(snapshot(missingBarrier.workspace), barrierBefore, '1014: missing barrier leaves source bytes unchanged');
    const fileInternal = (await fixture('file-internal')), internal = join(fileInternal.workspace, 'internal');
    fs.rmdirSync(internal); // Replace only this fixture's empty folder with a file.
    fs.writeFileSync(internal, 'keep this file');
    const fileBefore = snapshot(fileInternal.workspace);
    const filePlan = (await move.previewLibraryMove(fileInternal.options)).value as Record<string, any>;
    const fileResult = (await move.moveLibrary({ ...fileInternal.options, preflight: false, userConfirmed: true, planId: filePlan.plan_id }));
    check(fileResult.refusal?.includes(internal + ' is not a folder; move it aside') === true, '1014: file internal refuses an in-process move');
    same(snapshot(fileInternal.workspace), fileBefore, '1014: file internal move leaves source bytes unchanged');
    for (const kind of ['file', 'link', 'dangling-link']) {
      const w = (await fixture('barrier-' + kind)), internal = join(w.workspace, 'internal');
      const replaceInternal = () => {
        fs.rmdirSync(internal); // Replace only this fixture's empty folder at the barrier seam.
        if (kind === 'file') fs.writeFileSync(internal, 'keep this file');
        else fs.symlinkSync(join(root, kind === 'link' ? 'home' : 'missing-link-target'), internal, process.platform === 'win32' ? 'junction' : 'dir');
      };
      let replaced = false, before: string[] = [];
      const result = (await move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id,
        get faultAt() {
          if (!replaced) { replaceInternal(); replaced = true; before = snapshot(w.workspace); }
          return undefined;
        },
      }));
      check(result.refusal?.includes(internal + ' is not a folder; move it aside') === true, '1014: barrier refuses internal ' + kind);
      same(snapshot(w.workspace), before, '1014: barrier refusal leaves source bytes unchanged: ' + kind);
    }
    for (let quietAt = 1; quietAt <= 4; quietAt++) {
      const w = (await fixture('writer-' + quietAt)); let calls = 0;
      const refused = (await move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id, processTable: () => ++calls === quietAt ? [{ name: 'codex', pid: 990001, parentPid: 0 }] : [] }));
      check(refused.refusal?.includes('990001') === true || (refused.value as any)?.blockers?.some((row: any) => row.pid === 990001), '1014: writer refused or returned held at quiet check ' + quietAt);
    }
    const changedOutside = (await fixture('outside-drift')); let calls = 0;
    const outsideResult = (await move.moveLibrary({ ...changedOutside.options, preflight: false, userConfirmed: true, planId: changedOutside.plan.plan_id, processTable: () => {
      if (++calls === 2) changedOutside.put(pointer, 'reader changed this'); return [];
    } }));
    equal(outsideResult.refusal, null, '1014: outside drift leaves move valid');
    equal(fs.readFileSync(pointer, 'utf8'), 'reader changed this', '1014: outside drift kept');
    check((outsideResult.value as Record<string, any>)?.left_and_listed.some((line: string) => line.includes('changed since the preview')), '1014: outside drift listed');
    const inside = (await fixture('inside')); const previous = process.cwd();
    try { process.chdir(inside.workspace); check((await move.moveLibrary({ ...inside.options, preflight: false, userConfirmed: true, planId: inside.plan.plan_id })).refusal?.includes('run it from a folder outside') === true, '1014: inside current folder refused'); } finally { process.chdir(previous); }
    const linked = (await fixture('linked')); fs.symlinkSync(join(root, 'home'), join(linked.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedPreview = (await move.previewLibraryMove(linked.options));
    check((await move.moveLibrary({ ...linked.options, preflight: false, userConfirmed: true, planId: (linkedPreview.value as Record<string, any>).plan_id })).refusal?.includes('symbolic link or junction') === true, '1014: link inside refused');
    const real = (await fixture('real-table'));
    const command = runCli(['library', 'move', real.destination, '--workspace', real.workspace, '--registry-root', real.registryRoot, '--user-confirmed', '--plan-id', real.plan.plan_id], { cwd: root, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' } });
    if (process.platform === 'win32') {
      check(command.exit !== 0 && /(?:codex|library).*process \d+/i.test(command.stderr), '1014: real Windows writer table refuses: ' + command.stderr);
      check(!fs.existsSync(real.destination), '1014: real writer refusal starts no copy');
    }
    else check((command.exit === 0 || command.exit === 1) && !command.stderr.includes('The process table could not be read'), '1014: real Linux table is read and judged');
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1014: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1014: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1014: snapshot explains both included and excluded rows');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1015(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  check(typeof move.moveLibrary === 'function', '1015: recovery exists'); if (typeof move.moveLibrary !== 'function') return;
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1015-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    const put = (file: string, text: string | Buffer) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
    const bytes = (file: string) => fs.readFileSync(file).toString('base64');
    const tree = (folder: string, relative = ''): string[] => fs.readdirSync(join(folder, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const absolute = join(folder, name);
      if (absolute === join(root, absolute.slice(root.length + 1).split(/[\\/]/)[0]!, 'registry/move-journals/refusals')) return [];
      if (name === 'internal/maintenance-barrier.json' || name === 'internal/move-journals') return [];
      return entry.isDirectory() ? ['folder:' + name, ...tree(folder, name)] : [name + ':' + bytes(join(folder, name))];
    });
    let serial = 0;
    const fixture = async () => {
      const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry'), home = join(folder, 'home');
      for (const [key] of saved) process.env[key] = home;
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture-' + serial })); fs.mkdirSync(join(workspace, 'internal'));
      put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace })); put(join(workspace, 'history.md'), workspace);
      fs.mkdirSync(join(workspace, 'empty'));
      const pointers = [join(home, '.claude.json'), join(home, '.claude/settings.json'), join(home, '.codex/config.toml')];
      for (const file of pointers) put(file, JSON.stringify({ path: workspace }));
      const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture-' + serial, path: workspace, default: true }] }));
      const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [], legacyOrder: true };
      fs.mkdirSync(join(registryRoot, 'move-journals'), { recursive: true });
      const plan = (await move.previewLibraryMove(options)).value as Record<string, any>;
      const original = tree(workspace), priorRegistry = bytes(registry), priorPointers = pointers.map(bytes);
      return { folder, workspace, destination, registryRoot, pointers, registry, options, plan, original, priorRegistry, priorPointers };
    };
    const failedMove = async (w: Awaited<ReturnType<typeof fixture>>, faultAt: string) => {
      const result = (await move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id, faultAt }));
      check(result.refusal?.includes('Injected move fault') === true, '1015: fault reached: ' + faultAt + ': ' + result.refusal);
      const journals = fs.readdirSync(join(w.registryRoot, 'move-journals'));
      equal(journals.length, 1, '1015: one journal per interrupted move');
      return journals[0]!;
    };
    const rollback = async (w: Awaited<ReturnType<typeof fixture>>, id: string, faultAt?: string) => {
      const preview = (await move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true }));
      equal(preview.refusal, null, '1015: rollback preview: ' + preview.refusal);
      if (preview.refusal) return preview;
      return (await move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id, faultAt }));
    };
    const restored = (w: Awaited<ReturnType<typeof fixture>>, label: string) => {
      same(tree(w.workspace), w.original, '1015: source byte-equal after ' + label);
      equal(bytes(w.registry), w.priorRegistry, '1015: registry byte-equal after ' + label);
      same(w.pointers.map(bytes), w.priorPointers, '1015: outside pointers byte-equal after ' + label);
      check(!fs.existsSync(join(w.workspace, 'internal/maintenance-barrier.json')), '1015: restored source barrier lifted');
    };
    for (const point of ['copy-file:before-done', 'promote:before', 'promote:before-done', 'cutover:before-done', 'cutover:after-done', 'pointer-0:after-done', 'pointer-0:before-done', 'registry:before-done', 'complete:before-done', 'journal-copy:before-done']) {
      const phaseB = !point.startsWith('copy') && !point.startsWith('promote');
      for (const recovery of phaseB ? ['resume', 'rollback'] : ['rollback']) {
        const w = (await fixture()), id = (await failedMove(w, point));
        if (recovery === 'rollback') { const result = (await rollback(w, id)); equal(result.refusal, null, '1015: rollback at ' + point + ': ' + result.refusal); if (!result.refusal) restored(w, point); }
        else {
          if (point === 'journal-copy:before-done') put(join(w.destination, 'internal/move-journals', id, 'registry-before'), 'a partial journal copy');
          const result = (await move.moveLibrary({ ...w.options, destination: undefined, resume: id, preflight: false, userConfirmed: true }));
          equal(result.refusal, null, '1015: resume at ' + point + ': ' + result.refusal);
          if (!result.refusal) {
            const value = result.value as Record<string, any>;
            same(tree(value.aside), w.original, '1015: resume keeps byte-equal source aside');
            equal(fs.readFileSync(join(w.destination, '.mcp.json'), 'utf8'), JSON.stringify({ path: w.destination }), '1015: resumed destination pointer');
            same(w.pointers.map(file => fs.readFileSync(file, 'utf8')), w.pointers.map(() => JSON.stringify({ path: w.destination })), '1015: resumed outside pointers');
            check(!fs.existsSync(join(w.destination, 'internal/maintenance-barrier.json')), '1015: resumed destination barrier lifted');
            if (point === 'journal-copy:before-done') {
              same(tree(join(w.destination, 'internal/move-journals', id)), tree(join(w.registryRoot, 'move-journals', id)), '1015: resumed journal copy equals outside journal folder');
              same(JSON.parse(fs.readFileSync(w.registry, 'utf8')).workspaces, [{ id: 'fixture-' + serial, path: w.destination, default: true }], '1015: journal copy recovery keeps moved registry');
            }
          }
        }
      }
    }
    for (const rename of ['rollback-destination', 'rollback-source']) for (const timing of ['before-done', 'after-done']) {
      const w = (await fixture()), id = (await failedMove(w, 'pointer-0:before-done'));
      const interrupted = (await rollback(w, id, rename + ':' + timing));
      check(interrupted.refusal?.includes('Injected move fault') === true, '1015: rollback rename fault reached ' + rename + ':' + timing);
      const resumed = (await rollback(w, id)); equal(resumed.refusal, null, '1015: interrupted rollback resumes: ' + resumed.refusal);
      if (!resumed.refusal) { restored(w, rename + ':' + timing); check(!fs.existsSync(w.destination), '1015: recovery never recreates renamed destination'); }
    }
    for (const name of ['rollback-barriers', 'rollback-pointer-0', 'rollback-empty', 'rollback-complete']) {
      const w = (await fixture()); fs.mkdirSync(w.destination);
      w.plan = (await move.previewLibraryMove(w.options)).value as Record<string, any>;
      const id = (await failedMove(w, 'registry:before-done')), point = name + ':before-done';
      check((await rollback(w, id, point)).refusal?.includes('Injected move fault at ' + point) === true, '1015: recovery step effect interrupted: ' + point);
      const result = (await rollback(w, id));
      equal(result.refusal, null, '1015: same rollback completes after ' + point + ': ' + result.refusal);
      if (!result.refusal) {
        restored(w, point);
        same(fs.readdirSync(w.destination), [], '1015: recovery step restores original empty destination: ' + point);
      }
    }
    for (const timing of ['before-done', 'after-done']) {
      const w = (await fixture()), id = (await failedMove(w, 'copy-file:before-done'));
      check((await rollback(w, id, 'rollback-destination:' + timing)).refusal?.includes('Injected move fault') === true, '1015: partial staging rename fault');
      const result = (await rollback(w, id)); equal(result.refusal, null, '1015: partial staging rollback continues: ' + result.refusal); if (!result.refusal) restored(w, 'partial staging rename');
    }
    const registryInterrupted = (await fixture());
    const registryDocument = JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8'));
    registryDocument.workspaces.push({ path: join(registryInterrupted.folder, 'unrelated'), id: 'unrelated', note: 'before' });
    put(registryInterrupted.registry, JSON.stringify(registryDocument));
    registryInterrupted.plan = (await move.previewLibraryMove(registryInterrupted.options)).value as Record<string, any>;
    const registryId = (await failedMove(registryInterrupted, 'registry:before-done'));
    check((await rollback(registryInterrupted, registryId, 'rollback-registry:before-done')).refusal?.includes('Injected move fault') === true, '1015: registry restore interrupted before done');
    const restoredDocument = JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8'));
    restoredDocument.workspaces.find((row: { id: string }) => row.id === 'unrelated').note = 'reader changed this';
    put(registryInterrupted.registry, JSON.stringify(restoredDocument));
    const registryRetry = (await rollback(registryInterrupted, registryId));
    equal(registryRetry.refusal, null, '1015: registry restore resumes after unrelated row changed: ' + registryRetry.refusal);
    same(JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8')), restoredDocument, '1015: restored identity, default flag and unrelated edit kept');
    same(tree(registryInterrupted.workspace), registryInterrupted.original, '1015: registry retry restores original source tree');
    same(registryInterrupted.pointers.map(bytes), registryInterrupted.priorPointers, '1015: registry retry restores outside pointers');
    check(!fs.existsSync(join(registryInterrupted.workspace, 'internal/maintenance-barrier.json')), '1015: registry retry lifts source barrier');
    const changedRegistry = (await fixture()), changedRegistryId = (await failedMove(changedRegistry, 'registry:before-done'));
    const changedDocument = JSON.parse(fs.readFileSync(changedRegistry.registry, 'utf8'));
    changedDocument.workspaces[0].default = false;
    put(changedRegistry.registry, JSON.stringify(changedDocument));
    const changedBytes = bytes(changedRegistry.registry), changedPointers = changedRegistry.pointers.map(bytes);
    const recoverySnapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const file = join(folder, entry.name); if (file === join(root, file.slice(root.length + 1).split(/[\\/]/)[0]!, 'registry/move-journals/refusals')) return [];
      return entry.isDirectory() ? ['folder:' + file, ...recoverySnapshot(file)] : [file + ':' + bytes(file)];
    });
    const changedSnapshot = recoverySnapshot(changedRegistry.folder);
    const changedResult = (await rollback(changedRegistry, changedRegistryId));
    check(changedResult.refusal?.includes('The moved registry row changed; inspect it before retrying the rollback') === true, '1015: changed moved row still refused');
    equal(bytes(changedRegistry.registry), changedBytes, '1015: changed moved row is not written');
    same(changedRegistry.pointers.map(bytes), changedPointers, '1015: changed moved row refusal leaves outside pointers alone');
    same(recoverySnapshot(changedRegistry.folder), changedSnapshot, '1015: changed moved row refusal leaves whole fixture unchanged');
    for (const changed of ['aside', 'destination']) {
      const w = (await fixture()), id = (await failedMove(w, 'cutover:after-done'));
      const journalFile = join(w.registryRoot, 'move-journals', id, 'journal.json');
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      put(join(changed === 'aside' ? journal.aside : w.destination, 'history.md'), 'reader changed this');
      const before = tree(w.folder);
      const result = (await move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true }));
      check(result.refusal?.includes('history.md') === true, '1015: changed ' + changed + ' refused by file name'); same(tree(w.folder), before, '1015: changed tree refusal writes nothing');
    }
    const drifted = (await fixture()), driftId = (await failedMove(drifted, 'pointer-0:before-done'));
    put(drifted.pointers[0]!, 'outside edit'); const driftResult = (await rollback(drifted, driftId));
    equal(driftResult.refusal, null, '1015: rollback leaves outside drift'); equal(fs.readFileSync(drifted.pointers[0]!, 'utf8'), 'outside edit', '1015: drifted outside bytes kept');
    check((driftResult.value as Record<string, any>)?.left_and_listed.some((line: string) => line.includes('changed after the move')), '1015: outside drift listed on rollback');
    const changedSource = (await fixture()); let quiet = 0;
    const sourceFault = (await move.moveLibrary({ ...changedSource.options, preflight: false, userConfirmed: true, planId: changedSource.plan.plan_id, processTable: () => { if (++quiet === 2) put(join(changedSource.workspace, 'history.md'), 'saved after copy'); return []; } }));
    check(sourceFault.refusal?.includes('history.md') === true && fs.existsSync(changedSource.workspace), '1015: source saved after copy caught before commit');
    const sourceId = fs.readdirSync(join(changedSource.registryRoot, 'move-journals'))[0]!;
    equal((await rollback(changedSource, sourceId)).refusal, null, '1015: phase A rollback preserves a later source save');
    equal(fs.readFileSync(join(changedSource.workspace, 'history.md'), 'utf8'), 'saved after copy', '1015: later source save never overwritten');
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1015: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1015: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1015: snapshot explains both included and excluded rows');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1016(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  check(typeof move.moveLibrary === 'function', '1016: recovery exists'); if (typeof move.moveLibrary !== 'function') return;
  const { spawn } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1016-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
  let serial = 0;
  try {
    const fixture = async () => {
      const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'destination'), home = join(folder, 'home'), registryRoot = join(folder, 'registry');
      for (const [key] of saved) process.env[key] = home;
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture' })); fs.mkdirSync(join(workspace, 'internal'));
      put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace }));
      const longFile = join(...['long-folder-'.repeat(4), 'next-folder-'.repeat(4), 'last-folder-'.repeat(4), 'final-folder-'.repeat(4)], 'long-file.txt');
      put(join(workspace, longFile), 'a long path is preserved');
      put(join(workspace, 'large-file.txt'), 'a file spans the hash buffer\n'.repeat(60000));
      const pointer = join(home, '.claude.json'); put(pointer, JSON.stringify({ path: workspace }));
      const registryFile = join(registryRoot, 'workspaces.json'); put(registryFile, JSON.stringify({ workspaces: [{ id: 'fixture', path: workspace, default: true }] }));
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const plan = (await move.previewLibraryMove(options)).value as Record<string, any>;
      return { folder, workspace, destination, home, registryRoot, registryFile, pointer, options, plan, longFile, registryBefore: fs.readFileSync(registryFile, 'utf8'), pointerBefore: fs.readFileSync(pointer, 'utf8') };
    };
    const childAt = async (w: Awaited<ReturnType<typeof fixture>>, faultAt: string, release = false) => {
      const marker = join(w.folder, 'marker'), releaseFile = join(w.folder, 'release'), resultFile = join(w.folder, 'result.json'), script = join(w.folder, 'child.mjs');
      const options = { ...w.options, processTable: undefined, preflight: false, userConfirmed: true, planId: w.plan.plan_id, faultAt, faultMarker: marker, ...(release ? { faultRelease: releaseFile } : {}) };
      put(script, `import { moveLibrary } from ${JSON.stringify(pathToFileURL(join(PROGRAM_ROOT, 'kernel/src/librarymove.ts')).href)};\nimport fs from 'node:fs';\nconst result = await moveLibrary({...${JSON.stringify(options)}, processTable: () => []});\nfs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));\n`);
      const child = spawn(process.execPath, [script], { cwd: w.folder, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, APPDATA: w.home, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' } });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const until = Date.now() + 15000;
        while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        check(fs.existsSync(marker), '1016: child reached ' + faultAt);
        return { child, exited, marker, releaseFile, resultFile };
      } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
    };
    const rollBack = async (w: Awaited<ReturnType<typeof fixture>>, id: string) => {
      const preview = (await move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true }));
      equal(preview.refusal, null, '1016: rollback preview: ' + preview.refusal);
      if (preview.refusal) return preview;
      return (await move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id }));
    };
    for (const [point, recovery] of [['copy-file:before-done', 'rollback'], ['pointer-0:before-done', 'resume'], ['pointer-0:before-done', 'rollback']]) {
      const w = (await fixture()), worker = await childAt(w, point!);
      worker.child.kill('SIGKILL'); await worker.exited;
      const id = fs.readdirSync(join(w.registryRoot, 'move-journals'))[0]!;
      const result = recovery === 'rollback' ? (await rollBack(w, id)) : (await move.moveLibrary({ ...w.options, destination: undefined, resume: id, preflight: false, userConfirmed: true }));
      equal(result.refusal, null, '1016: killed child ' + recovery + ': ' + result.refusal);
      if (result.refusal) continue;
      const home = recovery === 'rollback' ? w.workspace : w.destination;
      equal(fs.readFileSync(join(home, '.mcp.json'), 'utf8'), JSON.stringify({ path: home }), '1016: recovered program bytes');
      equal(fs.readFileSync(join(home, w.longFile), 'utf8'), 'a long path is preserved', '1016: long path survived recovery');
      equal(fs.readFileSync(join(home, 'large-file.txt'), 'utf8'), 'a file spans the hash buffer\n'.repeat(60000), '1016: streamed hash covers every buffer');
      check(!fs.existsSync(join(home, 'internal/maintenance-barrier.json')), '1016: recovered active barrier lifted');
      if (recovery === 'rollback') {
        equal(fs.readFileSync(w.registryFile, 'utf8'), w.registryBefore, '1016: killed child registry restored byte-exact');
        equal(fs.readFileSync(w.pointer, 'utf8'), w.pointerBefore, '1016: killed child pointer restored byte-exact');
      } else {
        equal(fs.readFileSync(w.pointer, 'utf8'), JSON.stringify({ path: w.destination }), '1016: killed child pointer resumed');
        equal(JSON.parse(fs.readFileSync(w.registryFile, 'utf8')).workspaces[0].path, w.destination, '1016: killed child registry resumed');
      }
    }
    if (process.platform === 'win32') {
      const w = (await fixture()), worker = await childAt(w, 'copy:before', true);
      const { openShareNothing } = await import('../../src/seatclaim.ts');
      const currentId = fs.readdirSync(join(w.registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      const currentJournal = JSON.parse(fs.readFileSync(join(w.registryRoot, 'move-journals', currentId, 'journal.json'), 'utf8'));
      const handle = openShareNothing(join(currentJournal.order === 'aside-first' ? currentJournal.aside : w.workspace, '.mcp.json'));
      try {
        put(worker.releaseFile, 'continue');
        const finished = await Promise.race([worker.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000))]);
        check(finished, '1016: sharing violation retries are bounded');
        if (!finished) { worker.child.kill('SIGKILL'); await worker.exited; }
      } finally { handle.close(); if (worker.child.exitCode === null) { worker.child.kill('SIGKILL'); await worker.exited; } }
      const result = JSON.parse(fs.readFileSync(worker.resultFile, 'utf8'));
      check(result.refusal.includes('.mcp.json') && result.refusal.includes('after three retries') && result.refusal.includes('--rollback'), '1016: sharing violation names file and rollback');
      check(!fs.existsSync(w.destination) && (fs.existsSync(w.workspace) || fs.existsSync(currentJournal.aside)), '1016: sharing failure preserves the source before promotion');
      const id = fs.readdirSync(join(w.registryRoot, 'move-journals'))[0]!; equal((await rollBack(w, id)).refusal, null, '1016: sharing failure rolls back');
    } else check(true, '1016: Windows sharing violation does not apply on POSIX');
    const empty = (await fixture()); fs.mkdirSync(empty.destination);
    const result = (await move.moveLibrary({ ...empty.options, preflight: false, userConfirmed: true, planId: empty.plan.plan_id })); equal(result.refusal, null, '1016: empty destination moved: ' + result.refusal);
    if (!result.refusal) {
      equal((await rollBack(empty, (result.value as Record<string, any>).run_id)).refusal, null, '1016: empty destination restored');
      same(fs.readdirSync(empty.destination), [], '1016: original empty destination remains empty');
    }
    for (const timing of ['before-done', 'after-done']) {
      const w = (await fixture()); fs.mkdirSync(w.destination);
      const moved = (await move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id }));
      equal(moved.refusal, null, '1016: empty-folder rollback fault setup');
      if (moved.refusal) continue;
      const id = (moved.value as Record<string, any>).run_id;
      const preview = (await move.moveLibrary({ ...w.options, rollback: id, preflight: true }));
      const stopped = (await move.moveLibrary({ ...w.options, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id, faultAt: 'rollback-empty:' + timing }));
      check(stopped.refusal?.includes('Injected move fault') === true, '1016: empty destination rollback rename fault reached');
      equal((await rollBack(w, id)).refusal, null, '1016: empty destination rollback rename continues');
      same(fs.readdirSync(w.destination), [], '1016: interrupted empty destination restored');
    }
    const stale = (await fixture());
    const stopped = (await move.moveLibrary({ ...stale.options, preflight: false, userConfirmed: true, planId: stale.plan.plan_id, faultAt: 'cutover:after-done' })); check(stopped.refusal !== null, '1016: recovery plan drift setup');
    const id = fs.readdirSync(join(stale.registryRoot, 'move-journals'))[0]!;
    const preview = (await move.moveLibrary({ ...stale.options, rollback: id, preflight: true }));
    put(stale.pointer, 'changed after recovery preview');
    check((await move.moveLibrary({ ...stale.options, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id })).refusal?.includes('recovery changed since the preview') === true, '1016: rollback approval binds current outside bytes');
    equal((await rollBack(stale, id)).refusal, null, '1016: fresh rollback preview accepts drift and lists it');
    equal(fs.readFileSync(stale.pointer, 'utf8'), 'changed after recovery preview', '1016: fresh rollback preserves outside edit');
    const cli = runCli(['library', 'move', '--fault-at', 'copy:before', '--preflight'], { cwd: root, env: { HOME: root, USERPROFILE: root, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '' } });
    check(cli.exit !== 0 && cli.stderr.includes('--fault-at'), '1016: command line cannot inject a fault');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1018(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c165-1018-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry');
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry, DESKPOST_LIBRARY_MOVE: '' };
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name); if (file === join(registry, 'move-journals/refusals')) return [];
    return entry.isDirectory() ? [file + '/', ...snapshot(file)] : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  const destination = process.platform === 'win32'
    ? join(root.slice(0, 3), 'dev', 'w48-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, '1018: fixture initialized');
    fs.mkdirSync(join(registry, 'move-journals'), { recursive: true });
    const forms: [string[], RegExp | null][] = [
      [[destination, '--preflight'], null],
      [[destination, '--user-confirmed', '--plan-id', 'fixture'], /run the preview again|close it, then run the command again/],
      [['--resume', 'fixture'], /Give the run id printed by the move/],
      [['--rollback', 'fixture'], /Give the run id printed by the move/],
    ];
    for (const [form, remedy] of forms) for (const json of [false, true]) {
      const before = snapshot(root);
      const result = runCli(['library', 'move', ...form, '--workspace', workspace, '--registry-root', registry, ...(json ? ['--json'] : [])], { cwd: root, env });
      if (remedy) {
        check(result.exit !== 0 && remedy.test(result.stderr), '1018: refusal gives its remedy: ' + result.stderr);
      } else {
        check([0, 3].includes(result.exit), '1018: preview succeeds without the switch: ' + result.stderr);
        if ([0, 3].includes(result.exit) && json) equal(JSON.parse(result.stdout).written, false, '1018: JSON preview records no write');
        if (!json) check(result.stdout.includes('Nothing was written in the Library.'), '1018: plain preview reports no write');
      }
      check(!(result.stdout + result.stderr).includes('turned off'), '1018: move no longer reports an off switch');
      check(JSON.stringify(snapshot(root)) === JSON.stringify(before), '1018: whole fixture stays unchanged');
      check(!fs.existsSync(destination), '1018: destination stays absent');
    }
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1018: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1018: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1018: snapshot explains both included and excluded rows');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1017(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1017-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
  // Only machine refusal diagnostics are excluded; all other folders, barriers, backups and copied journals count.
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name); if (file === join(root, file.slice(root.length + 1).split(/[\\/]/)[0]!, 'registry/move-journals/refusals')) return [];
    return entry.isDirectory() ? ['folder:' + file, ...snapshot(file)] : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  let serial = 0;
  const fixture = async (point = 'registry:after-done', vault = false) => {
    const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry'), home = join(folder, 'home');
    for (const [key] of saved) process.env[key] = home;
    put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture' })); fs.mkdirSync(join(workspace, 'internal'));
    if (vault) fs.mkdirSync(join(workspace, '.obsidian'));
    put(join(workspace, 'page.md'), 'source bytes'); put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace }));
    put(join(home, '.claude.json'), JSON.stringify({ path: workspace }));
    if (process.platform !== 'win32') fs.chmodSync(join(home, '.claude.json'), 0o600);
    const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture', path: workspace }] }));
    const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, processTable: () => [], preflight: false, userConfirmed: true };
    fs.mkdirSync(join(registryRoot, 'move-journals'), { recursive: true });
    const plan = (await move.previewLibraryMove({ ...options, preflight: true })).value as Record<string, any>;
    const stopped = (await move.moveLibrary({ ...options, planId: plan.plan_id, faultAt: point }));
    check(stopped.refusal?.includes('Injected move fault') === true, '1017: setup reaches ' + point);
    const id = fs.readdirSync(join(registryRoot, 'move-journals'))[0]!;
    const journalFile = join(registryRoot, 'move-journals', id, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const writeJournal = () => put(journalFile, JSON.stringify(journal));
    const rollback = async () => {
      const preview = (await move.moveLibrary({ ...options, rollback: id, preflight: true }));
      return (await move.moveLibrary({ ...options, rollback: id, planId: (preview.value as Record<string, any>)?.plan_id }));
    };
    return { folder, workspace, destination, registry, options, id, journalFile, journal, writeJournal, rollback, plan };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Case = { name: string; expected: string; point?: string; prepare?: (w: Fixture) => void | Promise<void>; command?: (w: Fixture) => Parameters<typeof move.moveLibrary>[0] | Promise<Parameters<typeof move.moveLibrary>[0]>; cwd?: boolean };
  // One row per explicit refusal before recovery's first step, plus filesystem/JSON failures.
  // verifyRecovery's verifyTree delegates its manifest refusal; requireQuiet delegates its table refusal.
  const cases: Case[] = [
    { name: 'both recovery options', expected: 'Choose --resume or --rollback', command: w => ({ ...w.options, resume: w.id, rollback: w.id }) },
    { name: 'invalid run id', expected: 'Give the run id', command: w => ({ ...w.options, resume: '../invalid' }) },
    { name: 'missing journal', expected: 'ENOENT', prepare: w => fs.renameSync(w.journalFile, w.journalFile + '.saved') },
    { name: 'invalid journal JSON', expected: 'JSON', prepare: w => put(w.journalFile, '{') },
    { name: 'inconsistent journal', expected: 'The move journal is inconsistent', prepare: w => { w.journal.schema = 2; w.writeJournal(); } },
    { name: 'unsafe manifest', expected: 'The move manifest has an unsafe path', prepare: w => { w.journal.sourceManifest[0].relative = '../escape'; w.writeJournal(); } },
    { name: 'saved pointer hash', expected: 'saved pointer bytes do not match', prepare: w => { w.journal.pointers[0].before = 'changed'; w.writeJournal(); } },
    { name: 'missing source', expected: 'The source tree location is unclear', prepare: w => fs.renameSync(w.journal.aside, w.journal.aside + '.saved') },
    { name: 'two sources', expected: 'The source tree location is unclear', prepare: w => fs.mkdirSync(w.workspace) },
    { name: 'two destinations', expected: 'Both destination copies exist', prepare: w => fs.mkdirSync(w.destination + '.rolled-back-' + w.id) },
    { name: 'source manifest differs', expected: 'differs from its manifest', prepare: w => { delete w.journal.order; w.writeJournal(); put(join(w.journal.aside, 'page.md'), 'changed'); } },
    { name: 'destination manifest differs', expected: 'differs from its manifest', prepare: w => put(join(w.destination, 'page.md'), 'changed') },
    { name: 'confirmation missing', expected: '--preflight, then its --user-confirmed', command: w => ({ ...w.options, resume: w.id, userConfirmed: false }) },
    { name: 'rollback plan missing', expected: '--preflight, then its --user-confirmed', command: w => ({ ...w.options, rollback: w.id }) },
    { name: 'stale recovery plan', expected: 'The recovery changed since the preview', command: w => ({ ...w.options, resume: w.id, planId: 'stale' }) },
    { name: 'inside current folder', expected: 'run it from a folder outside', cwd: true },
    { name: 'writer running', expected: 'close it, then run the command again', command: w => ({ ...w.options, resume: w.id, processTable: () => [{ pid: 990001, parentPid: 0, name: 'codex' }] }) },
    { name: 'unreadable process table', expected: 'The process table could not be read', command: w => ({ ...w.options, resume: w.id, processTable: () => { throw new Error('fixture table'); } }) },
    { name: 'invalid resume location', expected: 'Only a move past its commit point', point: 'copy-verify:after-done' },
    { name: 'resume after rollback', expected: 'Only a move past its commit point', prepare: async w => equal((await w.rollback()).refusal, null, '1017: completed rollback setup') },
    { name: 'changed registry row', expected: 'The moved registry row changed', prepare: w => { const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8')); doc.workspaces[0].id = 'changed'; put(w.registry, JSON.stringify(doc)); }, command: async w => {
      const preview = (await move.moveLibrary({ ...w.options, rollback: w.id, preflight: true }));
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } },
    { name: 'invalid registry JSON', expected: 'JSON', prepare: w => put(w.registry, '{'), command: async w => {
      const preview = (await move.moveLibrary({ ...w.options, rollback: w.id, preflight: true }));
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } },
  ];
  // s215 row 3: a foreign barrier where recovery would place its own refuses before the first step, so neither the
  // journal nor the destination's journal copy is written.
  const foreign = (folder: string) => put(join(folder, 'internal/maintenance-barrier.json'), JSON.stringify({ run_id: 'move-other-run', operation: 'Library move', reason: 'fixture' }) + '\n');
  cases.push({ name: 'foreign barrier at a completed destination, rolled back', expected: 'belongs to another run', point: 'journal-copy:after-done', prepare: async w => {
    equal((await move.moveLibrary({ ...w.options, resume: w.id })).refusal, null, '1017: completed move setup');
    check(fs.existsSync(join(w.destination, 'internal/move-journals', w.id, 'journal.json')), '1017: completed move keeps a destination journal copy');
    foreign(w.destination);
  }, command: async w => {
    const preview = (await move.moveLibrary({ ...w.options, rollback: w.id, preflight: true }));
    return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
  } });
  cases.push({ name: 'foreign barrier at the aside of a stopped move, resumed', expected: 'belongs to another run', prepare: w => foreign(w.journal.aside) });
  // s215 row 2: a row that is neither the source's nor the destination's still refuses before any rename.
  cases.push({ name: 'registry row for another folder', expected: 'The moved registry row changed', prepare: w => {
    const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8')); doc.workspaces[0].path = join(w.folder, 'elsewhere'); put(w.registry, JSON.stringify(doc));
  }, command: async w => {
    const preview = (await move.moveLibrary({ ...w.options, rollback: w.id, preflight: true }));
    return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
  } });
  for (const kind of ['duplicate-target', 'duplicate-source', 'case-alias']) {
    if (kind === 'case-alias' && process.platform !== 'win32') { check(true, '1017: Windows case-alias registry row skipped on POSIX'); continue; }
    cases.push({ name: kind, expected: 'The moved registry row changed', prepare: w => {
      const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8'));
      if (kind === 'duplicate-source') doc.workspaces = [{ ...w.journal.registryRow }, { ...w.journal.registryRow }];
      else doc.workspaces.push({ ...doc.workspaces[0], path: kind === 'case-alias' ? w.destination.toUpperCase() : w.destination });
      put(w.registry, JSON.stringify(doc));
    }, command: async w => {
      const preview = (await move.moveLibrary({ ...w.options, rollback: w.id, preflight: true }));
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } });
  }
  try {
    for (const row of cases) {
      const w = (await fixture(row.point)); await row.prepare?.(w);
      const options = (await row.command?.(w)) ?? { ...w.options, resume: w.id };
      const previous = process.cwd();
      try {
        if (row.cwd) process.chdir(w.journal.aside);
        const before = snapshot(w.folder), result = (await move.moveLibrary(options));
        check(result.refusal?.includes(row.expected) === true, '1017: ' + row.name + ' refuses: ' + result.refusal);
        same(snapshot(w.folder), before, '1017: ' + row.name + ' changes no byte');
      } finally { process.chdir(previous); }
    }
    // s215 row 2: the rollback judges a restored source row by its resolved path, so its readback must too. The row is an
    // alias of the source (a trailing separator; a case alias on Windows), beside an unrelated registry edit.
    for (const alias of ['trailing separator', 'case alias']) {
      if (alias === 'case alias' && process.platform !== 'win32') { check(true, '1017: Windows case-alias restored row skipped on POSIX'); continue; }
      const w = (await fixture());
      const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8'));
      doc.workspaces[0].path = alias === 'case alias' ? w.workspace.toUpperCase() : w.workspace + (process.platform === 'win32' ? '\\' : '/');
      doc.workspaces.push({ id: 'unrelated', path: join(w.folder, 'unrelated') });
      put(w.registry, JSON.stringify(doc));
      const result = (await w.rollback());
      equal(result.refusal, null, '1017: rollback with a restored ' + alias + ' row completes');
      equal((result.value as Record<string, any> | null)?.state, 'rolled-back', '1017: ' + alias + ' rollback reaches rolled-back');
      check(fs.existsSync(join(w.workspace, 'page.md')) && !fs.existsSync(w.destination), '1017: ' + alias + ' rollback restores the source and moves the destination aside');
      same(JSON.parse(fs.readFileSync(w.registry, 'utf8')), doc, '1017: ' + alias + ' rollback leaves the restored registry as written');
    }
    for (const action of ['start', 'resume', 'rollback'] as const) {
      const w = (await fixture('registry:after-done', true));
      equal(w.plan.inside_obsidian_vault, true, '1017: Library itself is a vault at ' + action + ' preview');
      equal(w.plan.obsidian_vault, w.workspace, '1017: preview names the Library vault');
      if (action === 'start') equal((await w.rollback()).refusal, null, '1017: vault start restores setup');
      const preview = action === 'start' ? (await move.previewLibraryMove({ ...w.options, preflight: true })) : (await move.moveLibrary({ ...w.options, [action]: w.id, preflight: true }));
      equal(preview.refusal, null, '1017: vault recovery preview');
      const before = snapshot(w.folder);
      const result = (await move.moveLibrary({ ...w.options, ...(action === 'start' ? {} : { [action]: w.id }), planId: (preview.value as Record<string, any>).plan_id,
        processTable: () => [{ pid: 990001, parentPid: 0, name: 'Obsidian' }] }));
      check(result.refusal?.includes('Obsidian') === true, '1017: Library vault refuses Obsidian at ' + action);
      same(snapshot(w.folder), before, '1017: Library vault ' + action + ' refusal changes no byte');
    }
    if (process.platform === 'win32') {
      console.log('1017: private-file permission assertions skipped on Windows; the Linux check proves them');
      check(true, '1017: POSIX pointer and journal modes skipped on Windows');
    } else {
      const w = (await fixture('journal-copy:after-done'));
      equal((await move.moveLibrary({ ...w.options, resume: w.id })).refusal, null, '1017: private-file move completes');
      const mode = (file: string) => fs.statSync(file).mode & 0o7777;
      const pointer = join(w.folder, 'home/.claude.json');
      equal(mode(pointer), 0o600, '1017: private pointer stays 0600 after move');
      for (const folder of [w.journal.directory, join(w.destination, 'internal/move-journals', w.id)]) {
        equal(mode(folder), 0o700, '1017: private journal folder is 0700');
        for (const file of fs.readdirSync(folder)) equal(mode(join(folder, file)), 0o600, '1017: private journal file is 0600: ' + file);
      }
      equal((await w.rollback()).refusal, null, '1017: private-file rollback completes');
      equal(mode(pointer), 0o600, '1017: private pointer stays 0600 after rollback');
    }
    // rollbackMove's rolled-back branch returns without a step; it has no refusal of its own.
    // Later barrier, rename and readback throws are effects after step(), covered by 1015 and 1016.
    // The no-write exception is paired with a positive, isolated refusal-diagnostic proof.
    const diagnosticRoot = join(root, 'diagnostic-source'), diagnosticRegistry = join(root, 'diagnostic-registry');
    fs.mkdirSync(join(diagnosticRoot, '.library'), { recursive: true }); fs.mkdirSync(join(diagnosticRoot, 'internal'));
    fs.writeFileSync(join(diagnosticRoot, '.library/workspace.json'), JSON.stringify({ id: 'diagnostic' }));
    const diagnosticMove = await import('../../src/librarymove.ts');
    await diagnosticMove.moveBlockers('move', { workspace: diagnosticRoot, destination: join(root, 'diagnostic-target'), registryRoot: diagnosticRegistry,
      destinationRule: 'any', preflight: true, processTable: () => [{ pid: process.pid, parentPid: 0, name: 'node' }, { pid: 990001, parentPid: 0, name: 'orca' }] });
    const diagnosticFolder = join(diagnosticRegistry, 'move-journals/refusals'), diagnosticFiles = fs.readdirSync(diagnosticFolder);
    equal(diagnosticFiles.length, 1, '1017: one blocked inspection writes exactly one refusal snapshot');
    const diagnostic = JSON.parse(fs.readFileSync(join(diagnosticFolder, diagnosticFiles[0]!), 'utf8'));
    check(diagnostic.processes.every((row: any) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && typeof row.name === 'string' && typeof row.reason === 'string' && row.reason.length > 0), '1017: every snapshot row names pid, parent, name and classification reason');
    check(diagnostic.processes.some((row: any) => row.pid === process.pid && row.excluded && row.reason.includes('ancestor')) && diagnostic.processes.some((row: any) => row.pid === 990001 && !row.excluded && row.reason.includes('process')), '1017: snapshot explains both included and excluded rows');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A Library with dev Hubs `one` and `shut`, plain Hubs `desk` and `elsewhere`, and the seat `viewer` (kickoffs/s220). */
function reportFixture(label: string) {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), label)));
  const workspace = join(root, 'ws'), registry = join(root, 'registry');
  const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(process.pid),
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '',
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root };
  const run = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: root, env });
  equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, label + ': init');
  for (const [slug, dev] of [['one', true], ['shut', true], ['desk', false], ['elsewhere', false]] as const) {
    equal(run(['hub', 'new', slug, '--title', slug, ...(dev ? ['--dev'] : [])]).exit, 0, label + ': hub ' + slug);
  }
  const seats = [['b-one', 'one'], ['b-shut', 'shut'], ['viewer', 'desk'], ['other', 'elsewhere']];
  fs.mkdirSync(join(workspace, '.claude/seats'), { recursive: true });
  fs.writeFileSync(join(workspace, '.claude/seats/_registry.json'), JSON.stringify({ schema: 1, seats: seats.map(([seat, project], index) =>
    ({ seat, project, created_utc: '2026-11-01T00:00:00.0000000Z', seat_id: String(index + 1).repeat(32) })) }, null, 2));
  for (const [seat] of seats) {
    fs.mkdirSync(join(workspace, '.claude/seats', seat!), { recursive: true });
    fs.writeFileSync(join(workspace, '.claude/seats', seat!, '.open-books'), '');
  }
  const open = (seat: string, hubs: string[]) => fs.writeFileSync(join(workspace, '.claude/seats', seat, '.open-projects'), hubs.map(hub => 'projects/' + hub + '\n').join(''));
  open('viewer', ['desk', 'one']);
  const hubFile = (hub: string, page: string) => join(workspace, 'collection/projects', hub, page + '.md');
  const write = (hub: string, page: string, text: string) => { fs.mkdirSync(join(hubFile(hub, page), '..'), { recursive: true }); fs.writeFileSync(hubFile(hub, page), text); };
  /** Replace `## <section>`'s body on a Hub's root page. */
  const section = (hub: string, heading: string, body: string) => {
    const text = fs.readFileSync(hubFile(hub, '_project'), 'utf8');
    const start = text.indexOf('## ' + heading + '\n'), end = text.indexOf('\n## ', start + 3);
    fs.writeFileSync(hubFile(hub, '_project'), text.slice(0, start) + '## ' + heading + '\n\n' + body + '\n' + (end < 0 ? '' : text.slice(end)));
  };
  const journal = (hub: string, page: string, stamp: string) => {
    fs.mkdirSync(join(workspace, 'internal/publication-journals'), { recursive: true });
    fs.writeFileSync(join(workspace, 'internal/publication-journals', `project-new-page-${hub}-${page.replace(/\//g, '-')}-${stamp}-0123abcd.json`), '{}');
  };
  return { root, workspace, run, open, write, section, journal, hubFile, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function section1030(): Promise<void> {
  const { builderRunStates } = await import('../../src/dashboard.ts');
  const { hubStatus } = await import('../../src/hubstatus.ts');
  const f = reportFixture('s220-1030-');
  try {
    const now = Date.parse('2026-11-19T10:41:30Z');
    const rowOf = (seat: string) => builderRunStates(f.workspace, 'viewer', now).find(row => row.seat === seat);
    const all = builderRunStates(f.workspace, 'viewer', now);
    equal(all.map(row => row.seat).join(','), 'b-one,b-shut', '1030: only the dev Hubs\' seats have rows, in registry order');
    const shut = rowOf('b-shut')!;
    equal(JSON.stringify([shut.hub, shut.problem, shut.state]), JSON.stringify(['shut', 'closed on this Desk', undefined]), '1030: a Hub closed on this Desk is a problem row, no state');
    // Posted: two pending pointers, one ticked, one in a fence and one in an HTML comment.
    f.section('one', 'Next', ['- [x] Run k0: [[projects/one/kickoffs/k0]]', '- [ ] Run k1: [[projects/one/kickoffs/k1]]', '- [ ] Run k2: [[projects/one/kickoffs/k2]]',
      '', '```', '- [ ] Run fenced: inside a fence', '```', '', '<!-- - [ ] Run hidden: inside a comment -->'].join('\n'));
    let one = rowOf('b-one')!;
    equal(JSON.stringify(one.queue), '["k1","k2"]', '1030: the queue is the pending pointers in page order, none from a fence or a comment');
    equal(JSON.stringify([one.current, one.state, one.attempt_page, one.minutes_running]), '["k1","posted",null,null]', '1030: a pending pointer with no attempt page is posted');
    check(one.source.includes('projects/one/_project ## Next') && one.read_at === new Date(now).toISOString(), '1030: the row names its source and when it was read');
    const status = hubStatus(f.workspace, 'one', 'viewer');
    const statusQueue = status.lines.filter(line => line.group === 'queue').map(line => /^\d+\. Run (\S+)/.exec(line.text)?.[1]);
    equal(JSON.stringify(one.queue), JSON.stringify(statusQueue), '1030: the queue equals the queue lines hub status prints for the same Hub');
    // Running: the attempt page has no Handback; its minutes come from its new-page journal's UTC time.
    f.write('one', 'notes/2026-11-19-k1-a1', '# k1 attempt 1\n\n## Rows\n\nRow 0 done.\n');
    f.journal('one', 'notes/2026-11-19-k1-a1', '20261119-100000');
    f.journal('one', 'notes/2026-11-19-k1-a1-extra', '20261119-090000');
    one = rowOf('b-one')!;
    equal(JSON.stringify([one.current, one.state, one.attempt_page, one.minutes_running]), '["k1","running","notes/2026-11-19-k1-a1",41]', '1030: an attempt page without an Outcome is running, 41 minutes from its journal');
    f.section('one', 'Next', '- [x] Run k1: [[projects/one/kickoffs/k1]]\n- [ ] Run k2: [[projects/one/kickoffs/k2]]');
    equal(rowOf('b-one')!.state, 'running', '1030: a running unit stays current while the next pointer waits');
    // Handed back, with each Outcome word.
    for (const outcome of ['pushed', 'published', 'done', 'parked', 'stopped']) {
      f.write('one', 'notes/2026-11-19-k1-a1', `# k1 attempt 1\n\n## Handback\n\nOutcome: ${outcome}. Pull request 9.\nRan: kickoffs/k1 r1\n`);
      f.section('one', 'Next', '- [x] Run k1: [[projects/one/kickoffs/k1]]');
      one = rowOf('b-one')!;
      equal(JSON.stringify([one.current, one.state, one.outcome, one.minutes_running]), `["k1","handed back","${outcome}",null]`, '1030: handed back with Outcome ' + outcome);
    }
    // Reviewed by a dated review page on an open Hub; the same page on a closed Hub is not read.
    f.write('elsewhere', 'notes/2026-11-19-k1-review', '# k1 review\n');
    equal(rowOf('b-one')!.state, 'handed back', '1030: a review page on a Hub closed on this Desk leaves it handed back');
    f.write('desk', 'notes/2026-11-19-k1-review-accepted', '# k1 review\n');
    equal(rowOf('b-one')!.state, 'reviewed', '1030: a dated review page on an open Hub makes it reviewed');
    f.write('desk', 'notes/2026-11-19-k10-review', '# k10 review\n');
    f.write('desk', 'notes/2026-11-09-k1-review-accepted-a504733', '# an older review, ending in a commit\n');
    equal(JSON.stringify([rowOf('b-one')!.current, rowOf('b-one')!.state]), '["k1","reviewed"]', '1030: a page ending in a commit is no attempt page');
    // A newer pointer after the review is posted again.
    f.section('one', 'Next', '- [x] Run k1: [[projects/one/kickoffs/k1]]\n- [ ] Run k2: [[projects/one/kickoffs/k2]]');
    equal(JSON.stringify([rowOf('b-one')!.current, rowOf('b-one')!.state]), '["k2","posted"]', '1030: the next pending pointer is posted once the last unit is handed back');
    // A ## Repo working tree that does not exist is a problem; the state is still reported.
    f.section('one', 'Repo', '- **Working tree:** `' + join(f.root, 'gone') + '` (the checkout).');
    one = rowOf('b-one')!;
    check(one.problem?.includes('does not exist') === true && one.problem.includes(join(f.root, 'gone')), '1030: a missing working tree is a problem on the row: ' + one.problem);
    equal(one.state, 'posted', '1030: the state is still reported beside the problem');
    f.section('one', 'Repo', '- **Working tree:** `' + f.root + '`');
    equal(rowOf('b-one')!.problem, undefined, '1030: a working tree that exists is no problem');
  } finally { f.dispose(); }
}

async function section1031(): Promise<void> {
  const { trainFront, trainNeedsYouItem } = await import('../../src/dashboard.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 's220-1031-')));
  try {
    const now = new Date(2026, 10, 19, 12, 0, 0).getTime();
    const item = (id: string, place: string, status = 'open') => ({ id, title: 'Title of ' + id, place, first_asked: '2026-11-01', source: 'fixture', status, note: '' });
    const register = (items: object[], cars: object[]) => {
      fs.mkdirSync(join(root, 'internal/train'), { recursive: true });
      fs.writeFileSync(join(root, 'internal/train/register.json'), JSON.stringify({ schema: 1, changed_at: '2026-11-19T00:00:00Z', changed_by: 'fixture', items, cars }));
    };
    const cars = [{ place: 'car:early', opened: '2026-11-01', arrived: '2026-11-10' }, { place: 'car:front', opened: '2026-11-15', arrived: null }, { place: 'car:later', opened: '2026-11-18', arrived: null }];
    // An arrived car before the front car, an earlier car still holding open items, a running item, and done and dropped
    // items still at place running.
    register([item('old-open', 'car:early'), item('front-done', 'car:front', 'done'), item('front-a', 'car:front'), item('front-b', 'car:front'),
      item('runs', 'running'), item('ran', 'running', 'done'), item('dropped-run', 'running', 'dropped'), item('later-a', 'car:later')], cars.slice(0, 2));
    let front = trainFront(root, now);
    equal(JSON.stringify([front.place, front.days_open, front.next?.id, front.finished]), '["car:front",4,"front-a",false]', '1031: the open car, its days open and its first open item');
    equal(JSON.stringify(front.running?.map(row => row.id)), '["runs"]', '1031: only open items at running are shown; done and dropped are not');
    equal(trainNeedsYouItem(front), null, '1031: a car with open items asks nothing');
    check(front.source === 'internal/train/register.json' && front.read_at === new Date(now).toISOString(), '1031: the field names its source and when it was read');
    // A front car whose items are all done or dropped.
    register([item('old-open', 'car:early'), item('front-done', 'car:front', 'done'), item('front-dropped', 'car:front', 'dropped')], cars.slice(0, 2));
    front = trainFront(root, now);
    equal(JSON.stringify([front.place, front.next, front.finished]), '["car:front",null,true]', '1031: a front car with no open item is finished');
    equal(trainNeedsYouItem(front), 'Train: car:front has no open items; mark it arrived', '1031: a finished car is a needs-you item');
    // No car open.
    register([item('old-open', 'car:early')], cars.slice(0, 1));
    front = trainFront(root, now);
    equal(JSON.stringify(front.place), 'null', '1031: no car open gives place null');
    equal(trainNeedsYouItem(front), null, '1031: no car open asks nothing');
    // An unreadable register throws; the report names it as a problem.
    fs.writeFileSync(join(root, 'internal/train/register.json'), '{ not json');
    let threw = false;
    try { trainFront(root, now); } catch { threw = true; }
    check(threw, '1031: an unreadable register is never read as no car');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** A minimal valid checkpoint record for one conversation (checkpointverb.ts `validateCheckpoint`). */
function checkpointRecord(seatId: string, conversation: string, closeout: 'none' | 'done' | 'waits', at: number): string {
  return JSON.stringify({ schema: 1, seatId, conversation, tracking: true, seen: [], gaps: [], waits: closeout === 'waits' ? ['a write waits on Eric'] : [],
    saveGaps: [], saveWaits: [], savedWrites: 0, turnsSince: 0, savedAt: closeout === 'none' ? null : at, saveState: closeout === 'none' ? 'none' : 'saved',
    closeout, ...(closeout === 'done' ? { closedOutAt: at } : {}), writes: [], trouble: [], request: null });
}

async function section1032(): Promise<void> {
  const { dashboardReport, NOTEBOOK_LIMITS } = await import('../../src/dashboard.ts');
  const f = reportFixture('s220-1032-');
  try {
    const now = Date.parse('2026-11-19T18:00:00Z');
    const report = (more: { seat?: string; conversation?: string; installRoot?: string | null } = {}) =>
      dashboardReport(f.workspace, { seat: more.seat ?? 'viewer', now, installRoot: null, ...more });
    const names = (r: ReturnType<typeof report>) => r.problems.map(problem => problem.source + ': ' + problem.problem).join(' | ');
    // Empty.
    let r = report();
    equal(JSON.stringify([r.schema, r.seat, r.read_at]), JSON.stringify([2, 'viewer', new Date(now).toISOString()]), '1032: schema 2, the seat and when it was read');
    equal(r.needs_you?.count, 0, '1032: an empty Library needs nothing: ' + JSON.stringify(r.needs_you));
    equal(r.problems.length, 0, '1032: an empty Library has no problems: ' + names(r));
    equal(JSON.stringify(r.train_front && [r.train_front.place, r.train_front.source]), '[null,"internal/train/register.json"]', '1032: no register gives no car, not a problem');
    equal(JSON.stringify(r.update && [r.update.checked, r.update.newer]), '["not installed",false]', '1032: a source run has no install root');
    equal(JSON.stringify(r.notebook && [r.notebook.notes, r.notebook.limit_notes, r.notebook.limit_topics, r.notebook.over]), JSON.stringify([0, NOTEBOOK_LIMITS.notes, NOTEBOOK_LIMITS.topics, false]), '1032: the Notebook against its limits');
    equal(JSON.stringify([NOTEBOOK_LIMITS.notes, NOTEBOOK_LIMITS.topics]), '[25,6]', '1032: the limits are the mod\'s defaults');
    check(r.desk !== null && Array.isArray(r.desk.open_projects) && 'other_seats' in r.desk && 'capture_books' in r.desk, '1032: the pane\'s Desk fields come from the overview');
    for (const key of ['needs_you', 'train_front', 'closeout', 'hub_over_limit', 'desk', 'notebook', 'update'] as const) {
      const value = r[key] as { source?: unknown; read_at?: unknown } | null;
      check(value !== null && typeof value.source === 'string' && value.read_at === r.read_at, '1032: ' + key + ' carries its source and read_at');
    }
    check((r.builders ?? []).every(row => typeof row.source === 'string' && row.read_at === r.read_at), '1032: each builder row carries its source and read_at');
    check(Array.isArray(r.row) && r.row.length === 2 && Array.isArray(r.pane) && r.pane.length > 0, '1032: the row and the pane are filled by reportLines');
    // Letters only: one letter for viewer.
    const viewerId = '3'.repeat(32);
    const note = (book: string, name: string, front: string) => {
      fs.mkdirSync(join(f.workspace, 'shelf', book, 'wiki/notes'), { recursive: true });
      fs.writeFileSync(join(f.workspace, 'shelf', book, 'wiki/notes', name + '.md'), '---\ncaptured: 2026-11-19T09:00:00Z\nreview: pending\n' + front + '---\n\n# ' + name + '\n\nBody.\n');
    };
    note('letters', '2026-11-19-for-viewer', `why: for-seat\nfor_seat: viewer\nfor_seat_id: ${viewerId}\nfrom_seat: other\n`);
    r = report();
    const letters = r.needs_you?.sections.find(section => section.key === 'letters')?.items ?? [];
    check(letters.length === 1 && letters[0]!.text.startsWith('viewer: 1 letter'), '1032: letters only: ' + JSON.stringify(r.needs_you));
    equal(r.needs_you?.count, 1, '1032: letters only counts one');
    equal(JSON.stringify(r.desk?.letters_for_this_seat), 'null', '1032: the Desk\'s letters field is the overview\'s as it is (none without a held claim)');
    fs.rmSync(join(f.workspace, 'shelf/letters/wiki/notes/2026-11-19-for-viewer.md'));
    // Reports only.
    note('reports', '2026-11-19-a-defect', 'why: defect\n');
    r = report();
    const reports = r.needs_you?.sections.find(section => section.key === 'reports')?.items ?? [];
    check(reports.length === 1 && reports[0]!.text.startsWith('1 pending') && r.needs_you?.count === 1, '1032: Reports only: ' + JSON.stringify(r.needs_you));
    // An unreadable capture Book is a problem, never "no notes".
    fs.rmSync(join(f.workspace, 'shelf/reports/wiki/notes'), { recursive: true });
    fs.writeFileSync(join(f.workspace, 'shelf/reports/wiki/notes'), 'not a folder');
    r = report();
    check(r.problems.some(problem => problem.source === 'needs-you' && problem.problem.includes('not a folder')), '1032: an unreadable capture Book is a named problem: ' + names(r));
    fs.rmSync(join(f.workspace, 'shelf/reports/wiki/notes'));
    fs.mkdirSync(join(f.workspace, 'shelf/reports/wiki/notes'));
    // A running builder.
    f.write('one', 'notes/2026-11-19-k1-a1', '# k1 attempt 1\n');
    f.journal('one', 'notes/2026-11-19-k1-a1', '20261119-173000');
    r = report();
    const one = r.builders?.find(row => row.seat === 'b-one');
    equal(JSON.stringify(one && [one.state, one.current, one.minutes_running]), '["running","k1",30]', '1032: a running builder with its minutes');
    // A Hub over its limit.
    const big = fs.readFileSync(f.hubFile('desk', '_project'), 'utf8') + '\n' + 'Filler line for the size limit.\n'.repeat(2000);
    fs.writeFileSync(f.hubFile('desk', '_project'), big);
    r = report();
    check((r.hub_over_limit?.pages ?? []).some(page => page['hub'] === 'desk' && page['page'] === '_project'), '1032: a Hub over its limit: ' + JSON.stringify(r.hub_over_limit));
    // A Notebook over its limit.
    for (let index = 0; index <= NOTEBOOK_LIMITS.notes; index++) fs.writeFileSync(join(f.workspace, 'notebook', `note-${index}.md`), `# Note ${index}\n`);
    r = report();
    check(r.notebook !== null && r.notebook.notes > NOTEBOOK_LIMITS.notes && r.notebook.over, '1032: a Notebook over its limit: ' + JSON.stringify(r.notebook));
    // Two conversations on one seat: each gets its own record; none falls back to the other.
    fs.mkdirSync(join(f.workspace, 'internal/checkpoints', viewerId), { recursive: true });
    fs.writeFileSync(join(f.workspace, 'internal/checkpoints', viewerId, 'conversation-a.json'), checkpointRecord(viewerId, 'conversation-a', 'done', now - 12 * 60000));
    fs.writeFileSync(join(f.workspace, 'internal/checkpoints', viewerId, 'conversation-b.json'), checkpointRecord(viewerId, 'conversation-b', 'waits', now - 60000));
    const a = report({ conversation: 'conversation-a' }).closeout, b = report({ conversation: 'conversation-b' }).closeout, c = report({ conversation: 'conversation-c' }).closeout;
    equal(JSON.stringify(a && [a.conversation, a.label, a.state]), '["conversation-a","the conversation named","done 12 min"]', '1032: the first conversation\'s own closeout');
    equal(JSON.stringify(b && [b.conversation, b.state]), '["conversation-b","waits"]', '1032: the second conversation\'s own closeout');
    equal(JSON.stringify(c && [c.conversation, c.state, c.save]), '["conversation-c",null,null]', '1032: a conversation with no record falls back to no other');
    check(a?.source.endsWith(`${viewerId}/conversation-a.json`) === true, '1032: the closeout names its record');
    const unnamed = report().closeout;
    equal(JSON.stringify(unnamed && [unnamed.label, unnamed.state]), '["this seat\'s recorded conversation",null]', '1032: without --conversation it reads only the seat\'s recorded conversation');
    // The update record: newer, equal, none, and one with an error.
    const install = join(f.root, 'install');
    fs.mkdirSync(install);
    r = report({ installRoot: install });
    equal(JSON.stringify(r.update && [r.update.checked, r.update.newer]), '["never",false]', '1032: no update record is checked: never');
    const record = (installed: string, latest: string | null, error: string | null) => fs.writeFileSync(join(install, 'update-check.json'),
      JSON.stringify({ checked_utc: '2026-11-19T17:00:00Z', installed, latest, release: 'https://example.invalid/release', error }));
    record('1.7.0', '1.8.0', null);
    r = report({ installRoot: install });
    equal(JSON.stringify(r.update && [r.update.checked, r.update.installed, r.update.latest, r.update.newer, r.update.checked_utc]), '["yes","1.7.0","1.8.0",true,"2026-11-19T17:00:00Z"]', '1032: a newer release');
    record('1.7.0', '1.7.0', null);
    equal(report({ installRoot: install }).update?.newer, false, '1032: the same release is not newer');
    record('1.7.0', null, 'The release could not be reached.');
    r = report({ installRoot: install });
    check(r.update?.newer === false && r.problems.some(problem => problem.problem === 'The release could not be reached.'), '1032: an update error is a problem: ' + names(r));
    // An unreadable train register is a problem, not zero.
    fs.mkdirSync(join(f.workspace, 'internal/train'), { recursive: true });
    fs.writeFileSync(join(f.workspace, 'internal/train/register.json'), '{ not json');
    r = report();
    check(r.train_front === null && r.problems.some(problem => problem.source === 'internal/train/register.json'), '1032: an unreadable train register: ' + names(r));
    // No Desk: the overview's fields are null and named; the rest is still read.
    fs.rmSync(join(f.workspace, '.claude/seats/other'), { recursive: true });
    r = report({ seat: 'other' });
    check(r.desk === null && r.notebook === null && r.closeout === null && r.hub_over_limit === null && r.problems.some(problem => problem.source === 'Desk overview'), '1032: no Desk: ' + names(r));
    check(r.needs_you !== null && r.builders !== null, '1032: no Desk still reads needs-you and the builders');
  } finally { f.dispose(); }
}

/** A display report built by hand, for the row and pane sections (kickoffs/s220 rows 4 and 5). */
function handReport(shape: { builders: [string, string, string, number | null][]; car: string | null; next: string | null; running: string[]; closeout: string | null; needs: string[] }) {
  const read_at = '2026-11-19T18:00:00.000Z', source = 'fixture';
  return {
    schema: 2 as const, seat: 'viewer', read_at,
    needs_you: { count: shape.needs.length, sections: [{ key: 'answers', heading: 'Waiting on your answer', items: shape.needs.map(text => ({ seat: null, text })) }], source, read_at },
    builders: shape.builders.map(([seat, state, current, minutes]) => ({ seat, hub: seat, queue: [], current, state: state as 'running', outcome: state === 'handed back' ? 'pushed' : null,
      attempt_page: null, minutes_running: minutes, source, read_at })),
    train_front: shape.car === null ? { place: null, source, read_at } : { place: shape.car, days_open: 3, next: shape.next === null ? null : { id: shape.next, title: 'Title of ' + shape.next },
      running: shape.running.map(id => ({ id, title: 'Title of ' + id })), finished: shape.next === null, source, read_at },
    closeout: { conversation: 'c', label: 'the conversation named', save: 'saved 2 h', state: shape.closeout, record_at: null, source, read_at },
    hub_over_limit: { pages: [], source, read_at },
    desk: { open_books: [{ slug: 'letters' }], open_projects: ['projects/one'], hub_pages: [{ hub: 'one', page: '_project', size_bytes: 1200, limit_bytes: 40000, over: false }],
      other_seats: [{ seat: 'b-one', claim_state: 'held' }, { seat: 'b-two', claim_state: 'free' }], letters_for_this_seat: null, capture_books: [], source, read_at },
    notebook: { notes: 30, topics: 2, limit_notes: 25, limit_topics: 6, over: true, source, read_at },
    update: { checked: 'yes' as const, installed: '1.7.0', latest: '1.8.0', checked_utc: '2026-11-19T17:00:00Z', error: null, newer: true, source, read_at },
    problems: [], row: null, pane: null,
  };
}

async function section1033(): Promise<void> {
  const { reportLines, dashboardCells } = await import('../../src/dashboard.ts');
  const text = (line: { text: string }[]) => line.map(part => part.text).join('');
  // A pane line wraps a word longer than the pane inside it, so the pane is compared without its spaces.
  const flat = (lines: { text: string }[][]) => lines.map(text).join('').replace(/\s+/g, '');
  const inPane = (whole: string, value: string) => whole.includes(value.replace(/\s+/g, ''));
  const longCar = 'car:a-front-car-whose-name-runs-much-longer-than-any-pane-is-wide-at-all';
  const scenarios = [
    { name: 'short', builders: [['b1', 'running', 'k1', 41]], car: 'car:c', next: 'n1', running: ['r1'], closeout: 'done 12 min', needs: ['b1: Eric: say yes.'] },
    { name: 'medium', builders: [['builder-one', 'running', 'k12', 7], ['builder-two', 'handed back', 'c34', null]], car: 'car:thin-hubs', next: 'books-to-collection', running: ['library-move'], closeout: 'waits',
      needs: ['first item that needs Eric', 'second item that needs Eric', 'third item that needs Eric', 'fourth and oldest item'] },
    { name: 'long', builders: [['a-builder-seat-with-a-long-name', 'running', 'unit-with-long-id', 125], ['second-long-builder-seat', 'posted', 'k9', null], ['third-builder', 'reviewed', 'k8', null]],
      car: longCar, next: 'an-item-with-a-long-id-for-the-next', running: ['one-running-item', 'two-running-item'], closeout: 'gaps', needs: ['x'.repeat(40) + ' ' + 'single item longer than any row can hold, cut from its end'.repeat(2)] },
    { name: 'quiet', builders: [['b2', 'posted', 'k2', null]], car: null, next: null, running: [], closeout: null, needs: [] },
    { name: 'finished', builders: [['b3', 'reviewed', 'k3', null]], car: 'car:done-car', next: null, running: [], closeout: 'done 3 h', needs: [] },
  ] as const;
  const stages = new Set<string>();
  for (const scenario of scenarios) {
    const report = handReport(scenario as unknown as Parameters<typeof handReport>[0]);
    for (const columns of [80, 60]) for (const reserve of [0, 21]) {
      const at = `1033 ${scenario.name} ${columns}/${reserve}: `, width = columns - reserve;
      const { row, pane } = reportLines(report as never, columns, reserve);
      equal(row.length, 2, at + 'two row lines');
      const [one, two] = [text(row[0]!), text(row[1]!)], whole = flat(pane);
      for (const line of [...row, ...pane]) check(dashboardCells(text(line)) <= width, at + 'a line fits ' + width + ': ' + text(line));
      check(row.every(line => line.every(part => ['attention', 'normal', 'quiet', 'good'].includes(part.tone))), at + 'every segment has a tone');
      // The short forms only at 60 columns or fewer; full words elsewhere.
      const all = one + ' ' + two + ' ' + whole;
      if (columns > 60) check(!/\d (min|h|d)\b/.test(all), at + 'full words above 60 columns: ' + all);
      else check(!/\d (minutes?|hours?|days?)\b/.test(all), at + 'short forms at 60 columns: ' + all);
      // Line 1: a prefix of the items, the rest counted; a single item too long is cut from its end.
      if (!scenario.needs.length && scenario.next !== null) equal(one, 'Nothing needs you', at + 'nothing needs you');
      const items = [...(scenario.car !== null && scenario.next === null ? [`Train: ${scenario.car} has no open items; mark it arrived`] : []), ...scenario.needs];
      if (items.length) {
        check(one.startsWith('Needs you: '), at + 'line 1 starts Needs you: ' + one);
        const shown = items.filter(item => one.includes(item)).length;
        const more = /\+(\d+) more$/.exec(one);
        if (items.length - Math.max(shown, 1) > 0) {
          check(more !== null && Number(more[1]) === items.length - Math.max(shown, 1), at + 'the folded items are counted: ' + one);
          stages.add(shown === 0 ? 'line 1 cut' : 'line 1 more');
        }
        if (shown === 0) { check(one.includes('...'), at + 'a single item too long is cut with ...: ' + one); stages.add('line 1 cut'); }
        for (const item of items) check(inPane(whole, item.replace(/\s+/g, ' ')), at + 'each needs-you item is in the pane: ' + item);
        check(!/\b0 /.test(one), at + 'no zero count on the row');
      }
      // Line 2: each slot's value is on the line, or folded in the plan's order, and always in the pane.
      const minutes = (count: number) => columns <= 60 ? `${count} min` : `${count} minute${count === 1 ? '' : 's'}`;
      const slots: [string, string | null][] = [
        ['closeout', scenario.closeout === null ? null : 'Closeout: '],
        ['next', scenario.next === null || scenario.car === null ? null : `next ${scenario.next}`],
        ['running', scenario.running.length && scenario.car !== null ? `Running: ${scenario.running.join(', ')}` : null],
        ['minutes', scenario.builders.some(row => row[3] !== null) ? minutes(scenario.builders.find(row => row[3] !== null)![3]!) : null],
        ['builders', scenario.builders.map(row => `${row[0]} ${row[1]} ${row[2]}`).join(' · ')],
        ['car', scenario.car === null ? 'Train: no car open' : `Train: ${scenario.car.replace(/^car:/, '')}`],
      ];
      let folded = true;
      for (const [slot, value] of slots) {
        if (value === null) continue;
        const present = slot === 'builders' ? scenario.builders.every(row => two.includes(`${row[0]} ${row[1]} ${row[2]}`)) : two.includes(value);
        if (!present) { check(folded, at + `${slot} folded only after every slot before it: ${two}`); stages.add(slot); }
        else folded = false;
      }
      if (!scenario.builders.every(row => two.includes(row[0]))) check(two.includes(`${scenario.builders.length} builder`), at + 'the builders become their count: ' + two);
      if (scenario.car !== null && !two.includes(scenario.car.replace(/^car:/, ''))) check(/Train: [^·]*\.\.\./.test(two), at + 'the front car is cut with ...: ' + two);
      // The pane holds every slot in full.
      for (const [seat, state, current, count] of scenario.builders) {
        check(inPane(whole, `Builder ${seat}: ${state} ${current}`) && (count === null || inPane(whole, minutes(count))), at + 'each builder in full in the pane: ' + seat);
      }
      if (scenario.car !== null) check(inPane(whole, `Front car: ${scenario.car.replace(/^car:/, '')}, open ${columns <= 60 ? '3 d' : '3 days'}`), at + 'the front car in full with its days open');
      if (scenario.next !== null) check(inPane(whole, `Next: ${scenario.next}`), at + 'the next item in the pane');
      for (const id of scenario.car === null ? [] : scenario.running) check(inPane(whole, `Running: ${id}`), at + 'each running item in the pane: ' + id);
      if (scenario.closeout !== null) check(inPane(whole, 'Closeout: '), at + 'the closeout in the pane');
      check(inPane(whole, 'Update: Deskpost 1.8.0 is out; 1.7.0 is installed') && inPane(whole, 'Notebook: 30 of 25 notes, 2 of 6 topics, over its limit'), at + 'the update and the Notebook in the pane');
      check(inPane(whole, 'Books: letters') && inPane(whole, 'Hubs: one (1,200 of 40,000 bytes)') && inPane(whole, 'Other seats: b-one held; 1 free'), at + 'the Desk in the pane');
    }
  }
  for (const stage of ['closeout', 'next', 'running', 'minutes', 'builders', 'car', 'line 1 more', 'line 1 cut']) check(stages.has(stage), '1033: the table reaches the fold step ' + stage + ' (reached: ' + [...stages].join(', ') + ')');
}

async function section1034(): Promise<void> {
  const { dashboardReport, dashboardText, watchDashboard } = await import('../../src/dashboard.ts');
  const { deskOverview } = await import('../../src/desk.ts');
  const f = reportFixture('s220-1034-');
  const write = process.stdout.write;
  try {
    const now = Date.parse('2026-11-19T18:00:00Z');
    f.section('one', 'Next', '- [ ] Run k1: [[projects/one/kickoffs/k1]]');
    const overview = deskOverview({ workspace: f.workspace, seat: 'viewer' });
    const report = dashboardReport(f.workspace, { seat: 'viewer', now, installRoot: null, overview });
    const before = dashboardText(overview, { width: 80, now });
    const oneShot = dashboardText(overview, { width: 80, now, report });
    check(oneShot.startsWith(before + '\n'), '1034: every line the frame drew stays, word for word and in order, before the new lines');
    const added = oneShot.slice(before.length + 1).split('\n');
    equal(added[0], 'Needs you:', '1034: the needs-you group comes first: ' + added.join(' | '));
    check(added.includes('  b-one: k1, waiting for you to start the seat and say yes.'), '1034: the posted Kickoff needs you: ' + added.join(' | '));
    check(added.includes('Builder b-one: posted k1') && added.includes('Builder b-shut: closed on this Desk'), '1034: the builders: ' + added.join(' | '));
    check(added.includes('Front car: none open') && added.includes('Update: not checked, this program is not an installed copy') && added.includes('Notebook: 0 of 25 notes, 0 of 6 topics'), '1034: train, update and Notebook: ' + added.join(' | '));
    check(!added.some(line => /^(Books|Hubs|Other seats|Letters|Reports):/.test(line)), '1034: the frame does not repeat what it already draws');
    // The watch draws the same lines from its own read.
    let printed = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
    try { await watchDashboard({ workspace: f.workspace, seat: 'viewer', width: 80, intervalSeconds: 2, iterations: 1, now: () => now }); }
    finally { process.stdout.write = write; }
    const watched = printed.replace(/^---\n/, '').replace(/\n$/, '');
    const watchedAdded = watched.split('\n').slice(before.split('\n').length);
    equal(JSON.stringify(watchedAdded.filter(line => !line.startsWith('Update:'))), JSON.stringify(added.filter(line => !line.startsWith('Update:'))), '1034: --watch prints the same pane lines as the one-shot frame');
    check(watched.startsWith(before + '\n'), '1034: --watch keeps every earlier line first: ' + watched.slice(0, 200));
  } finally { process.stdout.write = write; f.dispose(); }
}

/** The text of one report line, its segments joined. */
function reportText(line: { text: string }[]): string {
  return line.map(part => part.text).join('');
}

async function section1035(): Promise<void> {
  const { dashboardReport } = await import('../../src/dashboard.ts');
  const f = reportFixture('s220-r2-1035-');
  try {
    const now = Date.parse('2026-11-20T18:00:00Z');
    const report = () => dashboardReport(f.workspace, { seat: 'viewer', now, installRoot: null });
    const names = (r: ReturnType<typeof report>) => r.problems.map(problem => problem.source + ': ' + problem.problem).join(' | ');
    const notes = join(f.workspace, 'shelf/reports/wiki/notes');
    // The Reports Book's notes folder is a file, and nothing else waits.
    fs.rmSync(notes, { recursive: true, force: true });
    fs.mkdirSync(join(notes, '..'), { recursive: true });
    fs.writeFileSync(notes, 'not a folder');
    let r = report();
    check(r.needs_you !== null && r.needs_you.count === null, '1035: an unreadable needs-you source gives no count, never zero: ' + JSON.stringify(r.needs_you));
    check(Array.isArray(r.needs_you?.sections), '1035: the sections are still carried beside the missing count');
    check(r.problems.some(problem => problem.source === 'needs-you' && problem.problem.includes('not a folder')), '1035: the unreadable source is named: ' + names(r));
    const one = reportText(r.row![0]!);
    check(one !== 'Nothing needs you' && one.includes('could not be read'), '1035: line 1 does not say Nothing needs you: ' + one);
    // The same Library made readable and empty counts zero.
    fs.rmSync(notes);
    fs.mkdirSync(notes);
    r = report();
    equal(r.needs_you?.count, 0, '1035: a readable, empty Library counts zero: ' + JSON.stringify(r.needs_you));
    equal(r.problems.length, 0, '1035: and has no problems: ' + names(r));
  } finally { f.dispose(); }
}

async function section1036(): Promise<void> {
  const { dashboardReport } = await import('../../src/dashboard.ts');
  const f = reportFixture('s220-r2-1036-');
  try {
    const now = Date.parse('2026-11-20T18:00:00Z');
    const install = join(f.root, 'install');
    fs.mkdirSync(install);
    const record = (error: string | null, latest: string | null) => fs.writeFileSync(join(install, 'update-check.json'),
      JSON.stringify({ installed: '1.7.0', latest, checked_utc: '2026-11-19T17:00:00Z', ...(error === null ? {} : { error }) }));
    const pane = () => {
      // Wide enough that the update line is one pane line.
      const r = dashboardReport(f.workspace, { seat: 'viewer', now, installRoot: install, columns: 300 });
      return { r, lines: (r.pane ?? []).map(reportText), update: (r.pane ?? []).filter(line => reportText(line).startsWith('Update:')) };
    };
    // A failed check: no release was read, and an error was recorded.
    record('The release could not be reached.', null);
    let { r, lines, update } = pane();
    equal(update.length, 1, '1036: one update line: ' + lines.join(' | '));
    const failed = reportText(update[0] ?? []);
    check(failed.includes('the last check failed') && failed.includes('The release could not be reached.') && failed.includes('1.7.0 is installed'), '1036: the update line says the check failed, with its words: ' + failed);
    check(failed.includes('2026-11-19T17:00:00Z'), '1036: the failed check carries when it ran: ' + failed);
    check((update[0] ?? []).some(part => part.tone === 'attention'), '1036: a failed check is in the attention tone: ' + JSON.stringify(update[0]));
    check(!lines.some(line => line.includes('is up to date')), '1036: no line says up to date after a failed check: ' + lines.join(' | '));
    check(r.problems.some(problem => problem.problem === 'The release could not be reached.'), '1036: the error is still a problem');
    // A newer release with an error still shows the newer release.
    record('A later read failed.', '1.8.0');
    ({ update } = pane());
    check(reportText(update[0] ?? []).includes('Deskpost 1.8.0 is out'), '1036: a newer release with an error still shows the newer release: ' + reportText(update[0] ?? []));
    // A check with no error is up to date.
    record(null, '1.7.0');
    ({ r, update } = pane());
    check(reportText(update[0] ?? []).includes('1.7.0 is up to date'), '1036: a record with no error is up to date: ' + reportText(update[0] ?? []));
    equal(r.problems.length, 0, '1036: and names no problem');
  } finally { f.dispose(); }
}

async function section1037(): Promise<void> {
  const { dashboardReport, dashboardText } = await import('../../src/dashboard.ts');
  const { deskOverview } = await import('../../src/desk.ts');
  const f = reportFixture('s220-r2-1037-');
  try {
    const now = Date.parse('2026-11-20T18:00:00Z');
    // Wide enough that each group's line is one pane line.
    const report = () => dashboardReport(f.workspace, { seat: 'viewer', now, installRoot: null, columns: 300 });
    const paneOf = (r: ReturnType<typeof report>) => (r.pane ?? []).map(reportText);
    const needsLines = (r: ReturnType<typeof report>) => paneOf(r).filter(line => line.startsWith('Needs you'));
    const note = (book: string, name: string, front: string) => {
      fs.mkdirSync(join(f.workspace, 'shelf', book, 'wiki/notes'), { recursive: true });
      fs.writeFileSync(join(f.workspace, 'shelf', book, 'wiki/notes', name + '.md'), '---\ncaptured: 2026-11-20T09:00:00Z\nreview: pending\n' + front + '---\n\n# ' + name + '\n\nBody.\n');
    };
    const letter = join(f.workspace, 'shelf/letters/wiki/notes/2026-11-20-for-viewer.md'), defect = join(f.workspace, 'shelf/reports/wiki/notes/2026-11-20-a-defect.md');
    // Nothing waits.
    let r = report();
    equal(JSON.stringify(needsLines(r)), '["Needs you: nothing"]', '1037: nothing waits: ' + paneOf(r).join(' | '));
    // A letter only.
    note('letters', '2026-11-20-for-viewer', `why: for-seat\nfor_seat: viewer\nfor_seat_id: ${'3'.repeat(32)}\nfrom_seat: other\n`);
    r = report();
    equal(JSON.stringify(needsLines(r)), '["Needs you: letters waiting, listed below"]', '1037: a letter only: ' + paneOf(r).join(' | '));
    check(paneOf(r).some(line => line.startsWith('Letters waiting:')), '1037: the letters group still lists it');
    const overview = deskOverview({ workspace: f.workspace, seat: 'viewer' });
    const text = dashboardText(overview, { now, report: dashboardReport(f.workspace, { seat: 'viewer', now, installRoot: null, overview }) });
    check(text.includes('Needs you: letters waiting, listed below') && !text.includes('Needs you: nothing'), '1037: the frame says what waits, never nothing: ' + text);
    // Both.
    note('reports', '2026-11-20-a-defect', 'why: defect\n');
    r = report();
    equal(JSON.stringify(needsLines(r)), '["Needs you: letters waiting and Reports pending, listed below"]', '1037: a letter and a Report: ' + paneOf(r).join(' | '));
    // A Report only.
    fs.rmSync(letter);
    r = report();
    equal(JSON.stringify(needsLines(r)), '["Needs you: Reports pending, listed below"]', '1037: a Report only: ' + paneOf(r).join(' | '));
    check(paneOf(r).some(line => line.startsWith('Reports: 1 pending')), '1037: the Reports group still lists it');
    fs.rmSync(defect);
    equal(JSON.stringify(needsLines(report())), '["Needs you: nothing"]', '1037: nothing waits again');
    // A page other than _project over its limit shows its own size and limit (train review-nits-s220, its Nit).
    f.write('desk', 'backlog', '# Backlog\n\n' + 'Filler line for the backlog page size limit.\n'.repeat(5000));
    r = report();
    const row = (Array.isArray(r.desk?.hub_pages) ? r.desk.hub_pages as { [key: string]: unknown }[] : []).find(page => page['hub'] === 'desk' && page['page'] === 'backlog');
    check(row !== undefined && row['over'] === true, '1037: the fixture backlog page is over its limit: ' + JSON.stringify(row));
    const hubs = paneOf(r).find(line => line.startsWith('Hubs:')) ?? '';
    const words = `backlog over its limit (${Number(row?.['size_bytes']).toLocaleString('en-US')} of ${Number(row?.['limit_bytes']).toLocaleString('en-US')} bytes)`;
    check(hubs.includes(words), '1037: the Hubs line names the page with its own size and limit in bytes (' + words + '): ' + hubs);
  } finally { f.dispose(); }
}

async function section1038(): Promise<void> {
  const { dashboardCells } = await import('../../src/dashboard.ts');
  const { deskOverview } = await import('../../src/desk.ts');
  const f = reportFixture('s220-r2-1038-');
  try {
    type Report = { schema: number; seat: string; row: { text: string }[][]; pane: { text: string }[][]; closeout: { conversation: string | null; state: string | null } | null };
    const viewerId = '3'.repeat(32);
    f.section('one', 'Next', '- [ ] Run k1: [[projects/one/kickoffs/k1]]');
    fs.mkdirSync(join(f.workspace, 'internal/checkpoints', viewerId), { recursive: true });
    fs.writeFileSync(join(f.workspace, 'internal/checkpoints', viewerId, 'conversation-a.json'), checkpointRecord(viewerId, 'conversation-a', 'done', Date.now() - 12 * 60000));
    fs.writeFileSync(join(f.workspace, 'internal/checkpoints', viewerId, 'conversation-b.json'), checkpointRecord(viewerId, 'conversation-b', 'waits', Date.now() - 60000));
    // The report beside the overview's keys and the checkpoint, every one of them kept.
    const ran = f.run(['dashboard', '--json', '--seat', 'viewer']);
    equal(ran.exit, 0, '1038: dashboard --json: ' + ran.stderr);
    const value = JSON.parse(ran.stdout) as { [key: string]: unknown; report: Report };
    const overviewKeys = Object.keys(deskOverview({ workspace: f.workspace, seat: 'viewer' }));
    equal(JSON.stringify(Object.keys(value).filter(key => key !== 'report' && key !== 'checkpoint').sort()), JSON.stringify([...overviewKeys].sort()), '1038: the overview\'s keys are all there, and no other but checkpoint and report');
    check('checkpoint' in value, '1038: the checkpoint key stays');
    equal(value['seat'], 'viewer', '1038: the overview\'s seat is unchanged');
    check(value.report?.schema === 2 && value.report.seat === 'viewer' && value.report.row.length === 2 && value.report.pane.length > 0, '1038: the report, with its row and pane: ' + String(JSON.stringify(value.report)).slice(0, 300));
    // --conversation chooses that conversation's closeout.
    for (const [conversation, state] of [['conversation-a', 'done'], ['conversation-b', 'waits']]) {
      const named = JSON.parse(f.run(['dashboard', '--json', '--seat', 'viewer', '--conversation', conversation!]).stdout) as { report: Report; checkpoint: { conversation: string; closeout: string } | null };
      check(named.report?.closeout?.conversation === conversation && named.report.closeout?.state?.startsWith(state!) === true, '1038: --conversation ' + conversation + ' chooses its own closeout: ' + JSON.stringify(named.report?.closeout));
      check(named.checkpoint?.conversation === conversation && named.checkpoint?.closeout.startsWith(state!) === true, '1038: the checkpoint key reads the same conversation: ' + JSON.stringify(named.checkpoint));
    }
    // --columns and --reserve fit the row.
    const fitted = JSON.parse(f.run(['dashboard', '--json', '--seat', 'viewer', '--columns', '60', '--reserve', '21']).stdout) as { report: Report };
    check(fitted.report?.row?.length === 2, '1038: --columns and --reserve give the report its two row lines');
    for (const line of fitted.report?.row ?? []) check(dashboardCells(reportText(line)) <= 39, '1038: a row line fits 60 less 21 columns: ' + reportText(line));
    for (const line of fitted.report?.pane ?? []) check(dashboardCells(reportText(line)) <= 39, '1038: a pane line fits 60 less 21 columns: ' + reportText(line));
    // Each refusal: its words, its exit code, and its refusal object with --json.
    const refusals: [string[], string][] = [
      [['--conversation', 'not an id!'], '--conversation needs a conversation id'],
      [['--conversation', '-starts-with-a-hyphen'], '--conversation needs a conversation id'],
      [['--columns', '19'], '--columns must be a whole number from 20 to 400'],
      [['--columns', '401'], '--columns must be a whole number from 20 to 400'],
      [['--columns', 'wide'], '--columns must be a whole number from 20 to 400'],
      [['--columns', '60', '--reserve', '41'], '--reserve must be a whole number from 0 to 40'],
      [['--reserve', '61'], '--reserve must be a whole number from 0 to 60'],
      [['--reserve', '-1'], '--reserve must be a whole number'],
      [['--watch', '--conversation', 'conversation-a'], 'are for the one-shot read'],
      [['--watch', '--columns', '80'], 'are for the one-shot read'],
      [['--watch', '--reserve', '0'], 'are for the one-shot read'],
    ];
    for (const [extra, words] of refusals) {
      const args = ['dashboard', '--seat', 'viewer', ...extra];
      const plain = f.run(args), json = f.run([...args, '--json']);
      check(plain.exit === 1 && plain.stderr.includes(words), '1038: ' + extra.join(' ') + ' is refused with exit 1 and "' + words + '": exit ' + plain.exit + ', ' + plain.stderr.trim());
      if (extra[0] !== '--watch') {
        equal(json.exit, 1, '1038: ' + extra.join(' ') + ' --json exit');
        let object: unknown = null;
        try { object = JSON.parse(json.stdout); } catch { /* checked below */ }
        same(object, { status: 'refused', refusal: json.stderr.trimEnd(), verb: 'dashboard', action: null }, '1038: ' + extra.join(' ') + ' --json gives the refusal object');
      }
    }
    // The one-shot text holds the report's pane lines, as --watch draws them.
    const text = f.run(['dashboard', '--seat', 'viewer', '--width', '80']);
    equal(text.exit, 0, '1038: the one-shot text: ' + text.stderr);
    for (const line of ['Builder b-one: posted k1', 'Builder b-shut: closed on this Desk', 'Front car: none open', 'Notebook: 0 of 25 notes, 0 of 6 topics']) {
      check(text.stdout.split(/\r?\n/).includes(line), '1038: the one-shot text holds the pane line "' + line + '": ' + text.stdout);
    }
  } finally { f.dispose(); }
}

async function section1039(): Promise<void> {
  const { builderRunStates } = await import('../../src/dashboard.ts');
  const { hubStatus } = await import('../../src/hubstatus.ts');
  const f = reportFixture('s220-r2-1039-');
  try {
    // The rows as the program reads them the same moment, without the read time (a minute may turn between the two reads).
    const bare = (rows: unknown) => JSON.stringify((rows as { read_at?: string }[]).map(row => ({ ...row, read_at: undefined })));
    const status = (label: string) => {
      const before = Date.now();
      const plain = f.run(['kickoff', 'status', '--seat', 'viewer']), json = f.run(['kickoff', 'status', '--seat', 'viewer', '--json']);
      const after = Date.now();
      equal(plain.exit, 0, '1039 ' + label + ': kickoff status: ' + plain.stderr);
      equal(json.exit, 0, '1039 ' + label + ': kickoff status --json: ' + json.stderr);
      let rows: { seat: string; queue?: string[] }[] = [];
      try { const value = JSON.parse(json.stdout); if (Array.isArray(value)) rows = value; } catch { /* checked below */ }
      check(rows.length > 0, '1039 ' + label + ': --json prints the rows: ' + json.stdout);
      check([before, after].some(now => bare(builderRunStates(f.workspace, 'viewer', now)) === bare(rows)), '1039 ' + label + ': the JSON rows equal builderRunStates for the same seat: ' + json.stdout);
      const queue = hubStatus(f.workspace, 'one', 'viewer').lines.filter(line => line.group === 'queue').map(line => /^\d+\. Run (\S+)/.exec(line.text)?.[1]);
      equal(JSON.stringify(rows.find(row => row.seat === 'b-one')?.queue), JSON.stringify(queue), '1039 ' + label + ': the pending ids equal hub status\'s queue lines');
      const lines = plain.stdout.split(/\r?\n/).filter(Boolean);
      equal(lines.length, rows.length, '1039 ' + label + ': one line per builder: ' + plain.stdout);
      check(lines.includes('b-shut  closed on this Desk'), '1039 ' + label + ': a closed Hub is its problem: ' + plain.stdout);
      return lines.find(line => line.startsWith('b-one  ')) ?? '';
    };
    // Posted.
    f.section('one', 'Next', '- [ ] Run k1: [[projects/one/kickoffs/k1]]\n- [ ] Run k2: [[projects/one/kickoffs/k2]]');
    equal(status('posted'), 'b-one  posted k1', '1039: a posted unit');
    // Running, with its minutes from the attempt page's new-page journal.
    const started = new Date(Date.now() - 30 * 60000);
    const stamp = started.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    f.write('one', 'notes/2026-11-20-k1-a1', '# k1 attempt 1\n\n## Rows\n\nRow 0 done.\n');
    f.journal('one', 'notes/2026-11-20-k1-a1', stamp);
    const running = status('running');
    check(/^b-one {2}running k1, (30|31) minutes$/.test(running), '1039: a running unit with its minutes: ' + running);
    // Handed back.
    f.write('one', 'notes/2026-11-20-k1-a1', '# k1 attempt 1\n\n## Handback\n\nOutcome: pushed. Pull request 9.\nRan: kickoffs/k1 r1\n');
    f.section('one', 'Next', '- [x] Run k1: [[projects/one/kickoffs/k1]]');
    equal(status('handed back'), 'b-one  handed back k1', '1039: a handed-back unit');
    // A seatless call is refused, naming --seat.
    const seatless = f.run(['kickoff', 'status']);
    check(seatless.exit === 1 && seatless.stderr.includes('--seat <name>'), '1039: a seatless call is refused, naming --seat <name>: exit ' + seatless.exit + ', ' + seatless.stderr.trim());
    // An unknown flag gives the refusal object.
    const unknown = f.run(['kickoff', 'status', '--s220-no-such-flag', '--json']);
    equal(unknown.exit, 1, '1039: an unknown flag exits 1');
    let object: unknown = null;
    try { object = JSON.parse(unknown.stdout); } catch { /* checked below */ }
    same(object, { status: 'refused', refusal: unknown.stderr.trimEnd(), verb: 'kickoff', action: 'status' }, '1039: an unknown flag gives the refusal object');
  } finally { f.dispose(); }
}

async function section1040(): Promise<void> {
  const w = seatFixture('w47-1040-');
  try {
    const { seatMetadata, destinationOf, departmentProblem } = await import('../../src/seatmeta.ts');
    const rows = [
      { seat: 'game-admin', department: 'games', role: 'performer' },
      { seat: 'sbox-lead', department: 'games/sbox', role: 'orchestrator' },
      { seat: 'picotron-lead', department: 'games/picotron', role: 'orchestrator' },
      { seat: 'solo', department: 'other/group', role: 'performer' },
    ];
    for (const department of ['games/sbox/x', '/sbox', 'games/', 'Games/sbox', 'games//sbox']) {
      check(departmentProblem(department)?.includes('<department>/<group>') === true, '1040: refusal names the group form for ' + department);
    }
    equal(departmentProblem('games/sbox'), null, '1040: a group is a department');
    const projection = seatMetadata(rows);
    same(projection.problems, [], '1040: sibling orchestrators may coexist');
    equal(destinationOf(projection, 'games/sbox').seat, 'sbox-lead', '1040: sbox has its own destination');
    equal(destinationOf(projection, 'games/picotron').seat, 'picotron-lead', '1040: picotron has its own destination');
    equal(destinationOf(projection, 'games').kind, 'none', '1040: game-admin does not receive parent letters');
    equal(destinationOf(projection, 'other/group').seat, 'solo', '1040: a group has the only-seat rule');
    equal(destinationOf(projection, 'other').kind, 'none', '1040: the unoccupied parent has no destination');
    for (const [index, row] of rows.entries()) {
      const project = 'group-project-' + index;
      equal(w.run(['hub', 'new', project, '--title', project]).exit, 0, '1040: create ' + project);
      const args = ['seat', 'start', row.seat, '--project', project, '--no-launch', '--department', row.department, '--role', row.role, '--json'];
      const preview = w.run([...args, '--preflight']);
      equal(preview.exit, 0, '1040: preview ' + row.seat + ': ' + preview.stderr);
      if (preview.exit !== 0) continue;
      const start = w.run([...args, '--plan-id', JSON.parse(preview.stdout).plan_id]);
      equal(start.exit, 0, '1040: start ' + row.seat + ': ' + start.stderr);
    }
    const cards = w.run(['seat', 'cards', '--all', '--json']);
    equal(cards.exit, 0, '1040: seat cards: ' + cards.stderr);
    if (cards.exit !== 0) return;
    const departments = JSON.parse(cards.stdout).departments;
    same(departments.map((row: { department: string; parent: string | null }) => [row.department, row.parent]),
      [['games', null], ['games/picotron', 'games'], ['games/sbox', 'games'], ['other', null], ['other/group', 'other']],
      '1040: parent headings precede their groups');
    equal(departments.find((row: { department: string }) => row.department === 'other')?.seats.length, 0, '1040: an unoccupied parent has no seats');
    for (const row of departments) {
      const expected = destinationOf(projection, row.department);
      const { seats: _seats, ...visible } = expected;
      same(row.destination, visible, '1040: cards and letters agree for ' + row.department);
    }
  } finally { w.dispose(); }
}

async function section1041(): Promise<void> {
  const w = seatFixture('w47-1041-');
  try {
    const { parseShelfNote } = await import('../../src/shelfnote.ts');
    for (const [seat, project] of [['lead', 'alpha'], ['admin', 'beta']] as const) {
      const args = ['seat', 'start', seat, '--project', project, '--no-launch', '--open-book', 'letters', '--json'];
      const plan = w.run([...args, '--preflight']);
      equal(plan.exit, 0, '1041: preview ' + seat + ': ' + plan.stderr);
      if (plan.exit !== 0) return;
      equal(w.run([...args, '--plan-id', JSON.parse(plan.stdout).plan_id]).exit, 0, '1041: create ' + seat);
    }
    const registry = join(w.workspace, '.claude/seats/_registry.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    const lead = data.seats.find((row: { seat: string }) => row.seat === 'lead');
    const admin = data.seats.find((row: { seat: string }) => row.seat === 'admin');
    const save = () => fs.writeFileSync(registry, JSON.stringify(data));
    Object.assign(lead, { department: 'games/sbox', role: 'orchestrator' });
    Object.assign(admin, { department: 'games', role: 'performer' });
    save();
    const asLead = (args: string[]) => runCli([...args, '--workspace', w.workspace],
      { cwd: w.root, env: { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: join(w.root, 'registry'), LIBRARY_SEAT: 'lead', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(process.pid) } });
    const capture = (department: string, title: string) =>
      w.run(['capture', 'letters', '--for-department', department, '--title', title, '--body', 'Test letter', '--json']);
    const notes = join(w.workspace, 'shelf/letters/wiki/notes');
    const group = capture('games/sbox', 'Group letter');
    equal(group.exit, 0, '1041: group letter: ' + group.stderr);
    if (group.exit === 0) {
      const name = fs.readdirSync(notes).find((file) => file.endsWith('-group-letter.md'));
      check(name !== undefined, '1041: group letter exists');
      if (name !== undefined) {
        const file = join(notes, name);
        const body = fs.readFileSync(file, 'utf8');
        const note = parseShelfNote(name, file, body);
        equal(note.forDepartment, 'games/sbox', '1041: the group address reads back');
        equal(note.forSeat, 'lead', '1041: the letter reaches the group orchestrator');
        check(body.includes('department_delivery: orchestrator'), '1041: delivery mode is recorded');
        same(note.malformed, [], '1041: a group address is well formed');
        fs.writeFileSync(file, body.replace(/^captured: .*$/m, 'captured: 2000-01-01T00:00:00Z'));
        const desk = w.run(['desk', '--seat', 'lead', '--json']);
        equal(desk.exit, 0, '1041: group desk: ' + desk.stderr);
        if (desk.exit === 0) equal(JSON.parse(desk.stdout).directory.stuck_letters, 1, '1041: a group letter counts as stuck');
        const route = asLead(['capture', 'letters', '--for', 'admin', '--routes', note.page, '--title', 'Routed letter', '--body', 'Please review']);
        equal(route.exit, 0, '1041: route: ' + route.stderr);
        const routed = fs.readdirSync(notes).find((entry) => entry.endsWith('-routed-letter.md'));
        check(routed !== undefined && fs.readFileSync(join(notes, routed), 'utf8').includes('to department `games/sbox`'), '1041: routed provenance names the group');
      }
    }
    const before = fs.readdirSync(notes);
    const without = capture('games', 'Refused parent');
    check(without.exit !== 0 && without.stderr.includes('games/sbox (orchestrator: lead)') && without.stderr.includes('--for-department games/<group>'), '1041: parent refusal names the group and destination: ' + without.stderr);
    same(fs.readdirSync(notes), before, '1041: parent refusal creates no letter');
    const missing = capture('games/missing', 'Missing group');
    check(missing.exit !== 0 && missing.stderr.includes('has no seat in this Library') && missing.stderr.includes('games/sbox'), '1041: the missing group is refused with available departments');
    admin.role = 'orchestrator';
    save();
    const withLead = capture('games', 'Parent with orchestrator');
    check(withLead.exit === 0 && JSON.parse(withLead.stdout).department_delivery === 'orchestrator', '1041: the parent reaches its own orchestrator: ' + withLead.stderr);
    admin.role = 'performer';
    lead.department = 'other';
    save();
    const only = capture('games', 'Parent without groups');
    check(only.exit === 0 && JSON.parse(only.stdout).department_delivery === 'only-seat', '1041: the flat department still reaches its only seat: ' + only.stderr);
  } finally { w.dispose(); }
}

async function section1042(): Promise<void> {
  const w = seatFixture('w47-1042-');
  try {
    const registry = join(w.workspace, '.claude/seats/_registry.json');
    const rows = () => JSON.parse(fs.readFileSync(registry, 'utf8')).seats as { seat: string; department?: string; role?: string }[];
    const make = (seat: string, department: string, role: string) => {
      const project = seat + '-hub';
      equal(w.run(['hub', 'new', project, '--title', project]).exit, 0, '1042: create ' + project);
      equal(w.run(['seat', 'start', seat, '--project', project, '--no-launch']).exit, 0, '1042: create ' + seat);
      const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
      Object.assign(data.seats.find((row: { seat: string }) => row.seat === seat), { department, role });
      fs.writeFileSync(registry, JSON.stringify(data));
    };
    make('game-admin', 'games', 'orchestrator');
    make('tester', 'games/picotron', 'performer');
    let turn = 0;
    const context = (seat: string) => runCli(['hook', 'desk-context', '--seat', seat, '--agent-pid', '0', '--workspace', w.workspace],
      { cwd: w.root, env: { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_CONFIG_DIR: join(w.root, 'no-config') }, input: JSON.stringify({ session_id: 'group-context-' + ++turn }) }).stdout;
    check(context('tester').includes('games/picotron, which has no orchestrator yet'), '1042: the lone performer sees its own group');
    make('second-tester', 'games/picotron', 'performer');
    check(context('tester').includes('games/picotron, which has no orchestrator yet'), '1042: the group still has no orchestrator');
    const wizard = (project: string, department: string) => {
      const script = join(w.root, 'answers.txt');
      fs.writeFileSync(script, ['+', project, department, 'o', '', '', '', '', ''].join('\n'));
      return runCli(['menu', '--script', script, '--width', '200', '--workspace', w.workspace],
        { cwd: w.root, env: { PATH: w.root, LIBRARY_WORKSPACES: join(w.root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '' } });
    };
    const first = wizard('Sbox Work', 'games/sbox');
    check(first.stdout.includes('Seat name   [Enter] sbox-lead › '), '1042: wizard proposes sbox-lead: ' + first.stdout.slice(-900));
    check(rows().some((row) => row.seat === 'sbox-lead' && row.department === 'games/sbox' && row.role === 'orchestrator'), '1042: Enter creates the group orchestrator');
    const second = wizard('Other Sbox Work', 'other/sbox');
    check(second.stdout.includes('Seat name   [Enter] sbox-lead-2 › '), '1042: wizard offers the next free name: ' + second.stdout.slice(-900));
    check(rows().some((row) => row.seat === 'sbox-lead-2' && row.department === 'other/sbox' && row.role === 'orchestrator'), '1042: Enter creates the suffixed group orchestrator');
    make('sbox-tester', 'games/sbox', 'performer');
    check(context('sbox-tester').includes('its orchestrator is sbox-lead'), '1042: a sibling group sees its own orchestrator');
    const retire = w.run(['seat', 'retire', 'game-admin', '--preflight', '--json']);
    equal(retire.exit, 0, '1042: retire preview: ' + retire.stderr);
    if (retire.exit === 0) {
      const note = JSON.parse(retire.stdout).department_note ?? '';
      check(note.includes('games/sbox') && note.includes('--department games --role orchestrator') && !note.includes('until a seat joins it'), '1042: retire preview names the groups and the parent role: ' + note);
    }
  } finally { w.dispose(); }
}




async function section1019(): Promise<void> {
  // s218-r2: a Library path rewrites only when the whole match lies inside one value (row 1), and every escape before it in
  // a JSON or TOML basic string is read by its format's own table (row 2): JSON's (RFC 8259 section 7) and TOML's (1.0, plus
  // 1.1's \e and \x); an escape outside the table, or malformed, makes the match ambiguous. Each case is previewed, then
  // moved to the staging copy (stopped before promote), checking occurrences, ambiguous count, the expected manifest and the
  // staged bytes. Each names its verdict at the base (ee944f0c) and after s218-r2; the fail-first run fails exactly the cases
  // where they differ. 'none' is no occurrence and no ambiguous match.
  const move = await import('../../src/librarymove.ts');
  const { createHash } = await import('node:crypto');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 's218r2-1019-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  type Verdict = 'rewrite' | 'ambiguous' | 'none';
  type Form = { file: string; text: (library: string) => string; rewritten?: (library: string, destination: string) => string };
  type Case = { name: string; base: Verdict; after: Verdict; posix?: true; leaf?: string } & Form;
  const S = '/server.js';
  // The path as JSON.stringify escapes it inside a string (valid in a TOML basic string too): on Windows its separators double.
  const escape = (value: string) => JSON.stringify(value).slice(1, -1);
  const json = (value: (library: string) => string): Form => ({ file: '.mcp.json', text: l => JSON.stringify({ v: value(l) }), rewritten: (_l, d) => JSON.stringify({ v: value(d) }) });
  // A raw-escape case: `prefix` is the exact bytes written in the string before the escaped path.
  const rawJson = (prefix: string): Form => ({ file: '.mcp.json', text: l => `{"v": "${prefix}${escape(l + S)}"}`, rewritten: (_l, d) => `{"v": "${prefix}${escape(d + S)}"}` });
  const rawToml = (prefix: string): Form => ({ file: '.codex/config.toml', text: l => `path = "${prefix}${escape(l + S)}"\n`, rewritten: (_l, d) => `path = "${prefix}${escape(d + S)}"\n` });
  // The first read's root, /srv/","library (a folder name holding " cannot exist on Windows), and one every platform can
  // build: a last folder named srv', y = 'library, so `x = '<root>/server.js'` reads x = '<folder>/srv', y = 'library/server.js'.
  const quoteLeaf = join('srv', '","library'), apostropheLeaf = "srv', y = 'library";
  const cases: Case[] = [
    // Row 1: the match starts inside one string and ends past its close.
    { name: "the first read's witness in .json: the match crosses the string's closing quote", base: 'rewrite', after: 'ambiguous', posix: true, leaf: quoteLeaf, file: '.mcp.json', text: l => `{"a":"${l}${S}":"x"}` },
    { name: "the first read's witness in .codex/config.toml", base: 'rewrite', after: 'ambiguous', posix: true, leaf: quoteLeaf, file: '.codex/config.toml', text: l => `a = "${l}${S}"\n` },
    { name: "the match crosses a TOML literal string's closing '", base: 'rewrite', after: 'ambiguous', leaf: apostropheLeaf, file: '.codex/config.toml', text: l => `x = '${l}${S}'\n` },
    // Row 1's controls: the whole match inside one string.
    { name: 'the " root wholly inside a TOML literal string', base: 'rewrite', after: 'rewrite', posix: true, leaf: quoteLeaf, file: '.codex/config.toml', text: l => `p = '${l}${S}'\n` },
    { name: 'the " root written by JSON.stringify in .json (listed: written with an escaped character)', base: 'none', after: 'ambiguous', posix: true, leaf: quoteLeaf, ...json(l => l + S) },
    { name: "the ' root wholly inside one JSON string", base: 'rewrite', after: 'rewrite', leaf: apostropheLeaf, ...json(l => l + S) },
    // Row 2, TOML basic strings: library-auditor's exact bytes (its /srv/library is this fixture's own root), then each escape
    // in TOML's table, outside it, and malformed. The base read \U, \x, \e and \q as their letter alone.
    { name: "library-auditor's witness: \\U0000002Fbackup and a space in TOML (an encoded /)", base: 'rewrite', after: 'ambiguous', ...rawToml('\\U0000002Fbackup ') },
    { name: '\\U0000005Cbackup and a space in TOML (an encoded \\)', base: 'rewrite', after: 'ambiguous', ...rawToml('\\U0000005Cbackup ') },
    { name: '\\U00000020 before the path in TOML (an encoded space)', base: 'ambiguous', after: 'rewrite', ...rawToml('\\U00000020') },
    { name: '\\x2f before the path in TOML (an encoded /)', base: 'ambiguous', after: 'ambiguous', ...rawToml('\\x2f') },
    { name: '\\x2fbackup and a space in TOML', base: 'rewrite', after: 'ambiguous', ...rawToml('\\x2fbackup ') },
    { name: '\\e before the path in TOML (ESC is no whitespace and no path start)', base: 'ambiguous', after: 'ambiguous', ...rawToml('\\e') },
    { name: 'an unknown \\q before the path in TOML', base: 'ambiguous', after: 'ambiguous', ...rawToml('\\q') },
    { name: 'an unknown \\q and a space in TOML', base: 'rewrite', after: 'ambiguous', ...rawToml('\\q ') },
    { name: 'a malformed \\U0000D800 (a surrogate) before the path in TOML', base: 'ambiguous', after: 'ambiguous', ...rawToml('\\U0000D800') },
    { name: 'a malformed \\U0000D800 and a space in TOML', base: 'rewrite', after: 'ambiguous', ...rawToml('\\U0000D800 ') },
    // Row 2, JSON strings: JSON has no \U, and \u is one UTF-16 code unit.
    { name: '\\U0000002F before the path in JSON (not in its table)', base: 'ambiguous', after: 'ambiguous', ...rawJson('\\U0000002F') },
    { name: '\\U0000002Fbackup and a space in JSON', base: 'rewrite', after: 'ambiguous', ...rawJson('\\U0000002Fbackup ') },
    { name: '\\u002f before the path in JSON (an encoded /)', base: 'ambiguous', after: 'ambiguous', ...rawJson('\\u002f') },
    { name: '\\u0020 before the path in JSON (an encoded space)', base: 'rewrite', after: 'rewrite', ...rawJson('\\u0020') },
    { name: 'a\\n before the path in JSON (a newline is whitespace)', base: 'ambiguous', after: 'rewrite', ...rawJson('a\\n') },
    { name: 'a\\t before the path in JSON (a tab is whitespace)', base: 'ambiguous', after: 'rewrite', ...rawJson('a\\t') },
    { name: '\\b before the path in JSON (a backspace)', base: 'ambiguous', after: 'ambiguous', ...rawJson('\\b') },
    { name: '\\ud83d\\ude00 and a space before the path in JSON (a surrogate pair, then whitespace)', base: 'rewrite', after: 'rewrite', ...rawJson('\\ud83d\\ude00 ') },
  ];
  try {
    let index = 0;
    for (const row of cases) {
      if (row.posix && process.platform === 'win32') { check(true, '1019: skipped on Windows, where a folder name cannot hold ": ' + row.name); continue; }
      const folder = join(root, String(++index)), library = join(folder, row.leaf ?? 'library'), registryRoot = join(folder, 'registry'), destination = join(folder, 'destination');
      for (const [key] of saved) process.env[key] = join(folder, 'home');
      put(join(library, '.library/workspace.json'), JSON.stringify({ id: 'case' })); fs.mkdirSync(join(library, 'internal'));
      put(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: library, id: 'case' }] }));
      const original = row.text(library);
      const expected = row.after !== 'rewrite' ? original : row.rewritten ? row.rewritten(library, destination) : original.split(library).join(destination);
      put(join(library, row.file), original);
      const options = { workspace: library, destination, registryRoot, destinationRule: 'any' as const, processTable: () => [], preflight: true };
      const preview = (await move.previewLibraryMove(options));
      equal(preview.refusal, null, '1019: preview: ' + row.name);
      const value = preview.value as Record<string, any>;
      if (!value) continue;
      const pointer = value.pointers.find((p: { file: string }) => p.file === join(library, row.file));
      equal(pointer?.occurrences ?? 0, row.after === 'rewrite' ? 1 : 0, '1019: occurrences: ' + row.name);
      equal(pointer?.ambiguous ?? 0, row.after === 'ambiguous' ? 1 : 0, '1019: ambiguous count: ' + row.name);
      equal(value.expected_destination_manifest.find((r: { relative: string }) => r.relative === row.file)?.sha256, sha(expected), '1019: expected manifest: ' + row.name);
      const stopped = (await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: value.plan_id, faultAt: 'promote:before' }));
      check(stopped.refusal?.includes('Injected move fault') === true, '1019: move reaches the staged copy: ' + row.name + ': ' + stopped.refusal);
      const staging = fs.readdirSync(folder).find(name => name.startsWith('destination.partial-'));
      equal(staging ? fs.readFileSync(join(folder, staging, row.file), 'utf8') : 'no staged copy', expected, '1019: staged bytes: ' + row.name);
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1020(): Promise<void> {
  // s218-r2 spare library-move-copy-mid-file: a move stopped inside the journal copy, after its first file and before the
  // rest, recovers: resume finishes the copy (equal to the outside journal folder) with the registry on the destination;
  // rollback restores the source byte for byte and lifts its barrier, as section 1015 asserts for its points.
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 's218r2-1020-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
    const bytes = (file: string) => fs.readFileSync(file).toString('base64');
    const tree = (folder: string, relative = ''): string[] => fs.readdirSync(join(folder, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name === 'internal/maintenance-barrier.json' || name === 'internal/move-journals') return [];
      return entry.isDirectory() ? ['folder:' + name, ...tree(folder, name)] : [name + ':' + bytes(join(folder, name))];
    });
    for (const recovery of ['resume', 'rollback'] as const) {
      const folder = join(root, recovery), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry'), home = join(folder, 'home');
      for (const [key] of saved) process.env[key] = home;
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture-' + recovery })); fs.mkdirSync(join(workspace, 'internal'));
      put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace })); put(join(home, '.claude.json'), JSON.stringify({ path: workspace }));
      const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture-' + recovery, path: workspace, default: true }] }));
      const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
      const plan = (await move.previewLibraryMove(options)).value as Record<string, any>;
      const original = tree(workspace), priorRegistry = bytes(registry), priorPointer = bytes(join(home, '.claude.json'));
      const stopped = (await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: plan.plan_id, faultAt: 'journal-copy:file' }));
      check(stopped.refusal?.includes('Injected move fault at journal-copy:file') === true, '1020: fault reached inside the journal copy: ' + stopped.refusal);
      const id = fs.readdirSync(join(registryRoot, 'move-journals'))[0]!, outside = join(registryRoot, 'move-journals', id), copy = join(destination, 'internal/move-journals', id);
      check(fs.readdirSync(outside).length > 1, '1020: the outside journal holds more than one file');
      equal(fs.readdirSync(copy).length, 1, '1020: the move stopped after the journal copy\'s first file');
      if (recovery === 'resume') {
        const result = (await move.moveLibrary({ ...options, destination: undefined, resume: id, preflight: false, userConfirmed: true }));
        equal(result.refusal, null, '1020: resume inside the journal copy: ' + result.refusal);
        same(tree(copy), tree(outside), '1020: resumed journal copy equals the outside journal folder');
        same(JSON.parse(fs.readFileSync(registry, 'utf8')).workspaces, [{ id: 'fixture-resume', path: destination, default: true }], '1020: resumed registry row names the destination');
        check(!fs.existsSync(join(destination, 'internal/maintenance-barrier.json')), '1020: resumed destination barrier lifted');
      } else {
        const preview = (await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: true }));
        equal(preview.refusal, null, '1020: rollback preview: ' + preview.refusal);
        if (preview.refusal) continue;
        const result = (await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id }));
        equal(result.refusal, null, '1020: rollback inside the journal copy: ' + result.refusal);
        same(tree(workspace), original, '1020: source byte-equal after rollback');
        equal(bytes(registry), priorRegistry, '1020: registry byte-equal after rollback');
        equal(bytes(join(home, '.claude.json')), priorPointer, '1020: outside pointer byte-equal after rollback');
        check(!fs.existsSync(join(workspace, 'internal/maintenance-barrier.json')), '1020: restored source barrier lifted');
      }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1022(): Promise<void> {
  // s222 row 3 (PLAN-library-move-finish.md r5, D2's P4, last paragraph): P4 exempts non-canonical occurrences, since the
  // matcher normalises them; the journal must restore them. One fixture Library whose configuration files hold one
  // non-canonical occurrence of each kind section 1021 labels (a run of separators, another case on Windows, a value
  // already holding the destination) is moved to the end, then rolled back as section 1020 does; each file reads back byte
  // for byte as it was before the move.
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 's222-1022-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
    const bytes = (file: string) => fs.readFileSync(file).toString('base64');
    const tree = (folder: string, relative = ''): string[] => fs.readdirSync(join(folder, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name === 'internal/maintenance-barrier.json' || name === 'internal/move-journals') return [];
      return entry.isDirectory() ? ['folder:' + name, ...tree(folder, name)] : [name + ':' + bytes(join(folder, name))];
    });
    const workspace = join(root, 'source'), destination = join(root, 'destination'), registryRoot = join(root, 'registry'), home = join(root, 'home');
    for (const [key] of saved) process.env[key] = home;
    put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture-1022' })); fs.mkdirSync(join(workspace, 'internal'));
    const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture-1022', path: workspace, default: true }] }));
    // The non-canonical spellings: the last separator doubled, the path in upper case (an occurrence on Windows only), and a
    // value already holding the destination. The plain path rides along so each file is rewritten.
    const cut = workspace.search(/[\\/][^\\/]*$/);
    const values: Record<string, string> = { plain: workspace + '/server.js', run: workspace.slice(0, cut) + workspace[cut] + workspace.slice(cut) + '/server.js',
      destination: destination + '/server.js', ...(process.platform === 'win32' ? { case: workspace.toUpperCase() + '/server.js' } : {}) };
    const files = ['.mcp.json', '.codex/config.toml', '.agents/notes.md'];
    put(join(workspace, '.mcp.json'), JSON.stringify(values, null, 2) + '\n');
    put(join(workspace, '.codex/config.toml'), Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(''));
    put(join(workspace, '.agents/notes.md'), Object.entries(values).map(([key, value]) => `${key}: ${value}\n`).join(''));
    const before = new Map(files.map(file => [file, bytes(join(workspace, file))]));
    const original = tree(workspace), priorRegistry = bytes(registry);
    const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
    const plan = (await move.previewLibraryMove(options));
    equal(plan.refusal, null, '1022: preview: ' + plan.refusal);
    if (plan.refusal) return;
    const planned = plan.value as Record<string, any>;
    for (const file of files) {
      const pointer = planned.pointers.find((row: { file: string }) => row.file === join(workspace, file));
      equal(pointer?.occurrences, process.platform === 'win32' ? 3 : 2, '1022: occurrences planned in ' + file);
    }
    const moved = (await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: planned.plan_id }));
    equal(moved.refusal, null, '1022: the move ran to the end: ' + moved.refusal);
    if (moved.refusal) return;
    equal((moved.value as Record<string, any>).state, 'complete', '1022: the move is complete');
    for (const file of files) {
      const text = fs.readFileSync(join(destination, file), 'utf8');
      check(bytes(join(destination, file)) !== before.get(file) && !text.includes(values.run!.replace(/\\/g, file === '.agents/notes.md' ? '\\' : '\\\\')),
        '1022: the move rewrote the run of separators in ' + file + ', so no inverse of the rewrite gives its bytes back');
    }
    const id = (moved.value as Record<string, any>).run_id as string;
    const preview = (await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: true }));
    equal(preview.refusal, null, '1022: rollback preview: ' + preview.refusal);
    if (preview.refusal) return;
    const result = (await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id }));
    equal(result.refusal, null, '1022: rollback: ' + result.refusal);
    for (const file of files) equal(bytes(join(workspace, file)), before.get(file), '1022: ' + file + ' byte for byte after rollback');
    same(tree(workspace), original, '1022: source byte-equal after rollback');
    equal(bytes(registry), priorRegistry, '1022: registry byte-equal after rollback');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1023(): Promise<void> {
  // s223 row 3 (PLAN-library-move-finish.md r6, Build item 2's Done when): the preview lists what unit B finds. Three fixture
  // Libraries, each previewed through the command line as section 1011 does: one whose .mcp.json writes one letter of its
  // path as a \u escape (listed ambiguous with D1.3's reason, still executable); one whose .codex/config.toml writes it in a
  // """ string with one letter escaped (not executable, D5.2); one whose .mcp.json already holds the destination as a key
  // beside the source key (not executable, D5.3).
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 's223-1023-')));
  const escapedReason = 'the old path is written here with an escaped character; change it by hand';
  try {
    const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
    // The path as a JSON or TOML basic string writes it (doubled backslashes on Windows), with its last letter as \u.
    const escapeLast = (path: string) => { const written = JSON.stringify(path).slice(1, -1); return written.slice(0, -1) + '\\u' + written.charCodeAt(written.length - 1).toString(16).padStart(4, '0'); };
    const preview = (name: string, files: (workspace: string, destination: string) => Record<string, string>) => {
      const folder = join(root, name), workspace = join(folder, 'library'), registry = join(folder, 'registry'), home = join(folder, 'home');
      const destination = process.platform === 'win32' ? join(root.slice(0, 3), 'dev', 's223-preview-' + root.split(/[\\/]/).pop() + '-' + name) : join(folder, 'destination');
      const env = { HOME: home, USERPROFILE: home, APPDATA: join(folder, 'appdata'), LOCALAPPDATA: home,
        LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', LIBRARY_WORKSPACES: registry };
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture-1023-' + name })); fs.mkdirSync(join(workspace, 'internal'));
      put(join(registry, 'workspaces.json'), JSON.stringify({ workspaces: [{ path: workspace, id: 'fixture-1023-' + name }] }));
      for (const [relative, text] of Object.entries(files(workspace, destination))) put(join(workspace, relative), text);
      const result = runCli(['library', 'move', destination, '--preflight', '--workspace', workspace, '--registry-root', registry, '--json'], { cwd: root, env });
      check([0, 3].includes(result.exit), `1023: ${name} preview: ${result.stderr}`);
      const value = [0, 3].includes(result.exit) ? JSON.parse(result.stdout) as Record<string, any> : {};
      return { value, workspace, pointer: (relative: string) => value['pointers']?.find((row: { file: string }) => row.file === join(workspace, relative)) as Record<string, any> | undefined };
    };

    const escaped = preview('escaped', workspace => ({ '.mcp.json': `{"mcpServers": {"library": {"args": ["--workspace", "${escapeLast(workspace)}"]}}}\n` }));
    const listed = escaped.pointer('.mcp.json');
    equal(listed?.occurrences, 0, '1023: an escaped letter in the path is not rewritten');
    equal(listed?.ambiguous, 1, '1023: an escaped letter in the path is listed ambiguous');
    equal(listed?.reason, escapedReason, '1023: the escaped path is listed with its reason');
    equal(escaped.value['executable'], true, '1023: a file with an escaped path stays executable: ' + JSON.stringify(escaped.value['not_executable_reasons']));

    const residue = 'the old path may be written here in a form the move cannot read; change it by hand, then run the preview again';
    const unreadable = preview('unreadable', workspace => ({ '.codex/config.toml': `v = """\n${escapeLast(workspace)}/server.js"""\n` }));
    equal(unreadable.value['executable'], false, '1023: a TOML file with an escaped path in a """ string is not executable');
    check(unreadable.value['not_executable_reasons']?.includes(join(unreadable.workspace, '.codex/config.toml') + ': ' + residue) === true,
      '1023: the """ file is named with D5.2\'s reason: ' + JSON.stringify(unreadable.value['not_executable_reasons']));
    equal(unreadable.pointer('.codex/config.toml')?.reason, residue, '1023: the """ file is listed with D5.2\'s reason');

    const collision = preview('collision', (workspace, destination) => ({ '.mcp.json': JSON.stringify({ projects: { [workspace]: { trusted: true }, [destination]: { trusted: false } } }, null, 2) + '\n' }));
    equal(collision.value['executable'], false, '1023: a key that would become the destination\'s key is not executable');
    check(collision.value['not_executable_reasons']?.includes(join(collision.workspace, '.mcp.json') + ': two keys would become one; merge them by hand') === true,
      '1023: the colliding file is named with D5.3\'s reason: ' + JSON.stringify(collision.value['not_executable_reasons']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1021(): Promise<void> {
  // s222 row 2 (PLAN-library-move-finish.md r5, D2 to D4 and Build item 1, unit A): every library-move case is checked by
  // properties over a generated case set, before any rule changes. Each case is one file's bytes, built from dimension
  // values; each value carries its D1 outcome at the base and after unit B in LABELS, written once. The real pathCounter
  // runs on each case; the case must match its outcome after unit B and P1 to P5a. P1, P2 and P5 read the bytes with
  // JSON.parse and smol-toml; P3 and P5a compare with the generator's own record of where it wrote the Library path; none of
  // them calls the decoders or string scanners under test. s223 row 1 (unit B, plan r6 Build item 2): every case asserts
  // its after-unit-B outcome, and no label carries an expected miss any more; the count of expected misses must be 0.
  let toml: typeof import('smol-toml');
  try { toml = await import('smol-toml'); }
  catch { failures.push('smol-toml is not installed: run npm ci in kernel/, then the self-test again'); return; }
  const { pathCounter } = await import('../../src/librarymove.ts');
  const MINIMUM_CASES = 6936;
  const windows = process.platform === 'win32';
  type Outcome = 'rewrite' | 'ambiguous' | 'none' | 'not executable';
  type Format = 'json' | 'toml' | 'literal' | 'text' | 'db';
  type Property = 'outcome' | 'P1' | 'P2' | 'P2a' | 'P3' | 'P4' | 'P5a' | 'P5';
  type Label = { base: Outcome; afterB: Outcome; nonCanonical?: true; miss?: Property[] };
  const label = (base: Outcome, afterB: Outcome = base, more: Partial<Label> = {}): Label => ({ base, afterB, ...more });
  // D1 per dimension value, at the base (4d81b548, unchanged since 5f524557) and after unit B. Case folding happens only on
  // Windows, so another case of the path is an occurrence there and no match elsewhere.
  const LABELS = {
    rewrite: label('rewrite'),
    ambiguous: label('ambiguous'),
    // An escape after the path decodes to a character that continues it; the base reads the raw backslash, an end.
    escapedEnd: label('rewrite', 'ambiguous'),
    // A letter of the path written as an escape, or a quote escaped inside a folder name: the base finds no match.
    escapedChar: label('none', 'ambiguous'),
    // A single-letter escape that makes the raw text read like the path (\r before oot/library): no occurrence at all.
    phantomRewrite: label('rewrite', 'none', { nonCanonical: true }),
    phantomAmbiguous: label('ambiguous', 'none'),
    // A short escape the path's first letter completes (\x4 before D:\library reads as M:\library): the base reads it as
    // malformed, so ambiguous; decoded, the path is not there (s223).
    completedEscape: label('ambiguous', 'none'),
    // \/ between folders in JSON: one raw match holding both separator forms; unit B rewrites it with \/ (D1.8's fourth form).
    mixedSeparators: label('rewrite', 'rewrite', { nonCanonical: true }),
    // The same where the base's rewrite leaves JSON that does not parse (plan r6, D1.8's fourth form, unit B).
    mixedSeparatorsUnreadable: label('rewrite', 'rewrite', { nonCanonical: true }),
    run: label('rewrite', 'rewrite', { nonCanonical: true }),
    leadingRun: label('ambiguous', 'ambiguous', { nonCanonical: true }),
    otherCase: windows ? label('rewrite', 'rewrite', { nonCanonical: true }) : label('none'),
    // A .db run holding a non-ASCII path in another case: the base folds bytes read as Latin-1 and finds nothing; unit B
    // folds the run decoded as UTF-8 (plan r6, D1.1).
    otherCaseFoldedBytes: windows ? label('rewrite', 'rewrite', { nonCanonical: true }) : label('none'),
    // A key that becomes another key of the same object or table (P2a, D5.3).
    collisionKey: label('rewrite', 'not executable', { nonCanonical: true }),
    // The same in TOML, whose reference parser refuses a duplicate key (plan r6, D5.3, unit B).
    collisionKeyUnreadable: label('rewrite', 'not executable', { nonCanonical: true }),
    // A TOML file holding """ or ''' is not scanned (D1.9); after unit B, D5.2's residue scan refuses it.
    unreadable: label('ambiguous', 'not executable'),
    unreadableEscaped: label('none', 'not executable'),
  } satisfies Record<string, Label>;
  // The reasons unit B gives (plan r6, D1.3, D5.2 and D5.3), word for word.
  const ESCAPED_REASON = 'the old path is written here with an escaped character; change it by hand';
  const RESIDUE_REASON = 'the old path may be written here in a form the move cannot read; change it by hand, then run the preview again';
  const COLLISION_REASON = 'two keys would become one; merge them by hand';
  type LabelName = keyof typeof LABELS;
  type Form = 'doubled' | 'single' | 'forward' | 'mixed';
  // A place the generator wrote: its raw span, the separator form it wrote, whether the text there spells the Library path
  // as a reader decodes it (P3 and P5a count only those; an escaped letter of the path still spells it), and whether it lies
  // inside one string (a JSON or TOML string, a text line, a run).
  type Part = string | { label: LabelName; raw: string; form?: Form; written?: boolean; inString?: boolean };
  type Place = { label: Label; name: LabelName; start: number; end: number; form: Form; written: boolean; inString: boolean };
  type Case = { dims: Record<string, string>; format: Format; source: string; destination: string; text: string; places: Place[]; canonical: boolean };
  const cases: Case[] = [];
  const add = (dims: Record<string, string>, format: Format, source: string, destination: string, parts: Part[], canonical = true) => {
    let text = ''; const places: Place[] = [];
    for (const part of parts) {
      if (typeof part === 'string') { text += part; continue; }
      const written = part.written ?? true;
      places.push({ label: LABELS[part.label], name: part.label, start: text.length, end: text.length + part.raw.length, form: part.form ?? 'mixed', written, inString: part.inString ?? true });
      text += part.raw;
    }
    cases.push({ dims: { ...dims, destination }, format, source, destination, text, places, canonical });
  };
  const escapes = (format: Format) => format === 'json' || format === 'toml';
  // Decoded text as the format writes it inside a string: JSON's escaping is valid in a TOML basic string too.
  const enc = (format: Format, decoded: string) => escapes(format) ? JSON.stringify(decoded).slice(1, -1) : decoded;
  const literalOk = (decoded: string) => !/['\n\r\x00-\x08\x0b-\x1f\x7f]/.test(decoded);
  const native = (format: Format, path: string): [string, Form] =>
    !path.includes('\\') ? [path, 'forward'] : escapes(format) ? [path.replace(/\\/g, '\\\\'), 'doubled'] : [path, 'single'];
  type Shape = { name: string; path: string; forward?: true };
  const SHAPES: Shape[] = [
    { name: 'POSIX /srv/library', path: '/srv/library' },
    { name: 'Windows D:\\library, native separators', path: 'D:\\library' },
    { name: 'Windows D:\\library, forward slashes', path: 'D:\\library', forward: true },
    { name: 'a space in a folder name', path: '/srv/my library' },
    { name: 'a non-ASCII letter', path: '/srv/bibliothèque' },
  ];
  const writtenPath = (format: Format, shape: Shape): [string, Form] => shape.forward ? [shape.path.replace(/\\/g, '/'), 'forward'] : native(format, shape.path);
  const at = (name: LabelName, [raw, form]: [string, Form], more: Partial<Exclude<Part, string>> = {}): Part => ({ label: name, raw, form, ...more });
  // One file: each value is a JSON string, a TOML basic or literal string, a text line, or a run of printable bytes.
  const file = (format: Format, values: Part[][]): Part[] => {
    const out: Part[] = [];
    if (format === 'json') { out.push('{'); values.forEach((value, i) => out.push(i ? ', ' : '', `"v${i}": "`, ...value, '"')); out.push('}'); }
    else if (format === 'toml' || format === 'literal') { const quote = format === 'toml' ? '"' : "'"; values.forEach((value, i) => out.push(`v${i} = ${quote}`, ...value, quote + '\n')); }
    else if (format === 'text') values.forEach(value => out.push(...value, '\n'));
    else values.forEach(value => out.push('\x00\x01', ...value, '\x00'));
    return out;
  };
  const FORMATS: Format[] = ['json', 'toml', 'literal', 'text', 'db'];
  // A move stays on one machine: a Windows Library moves to a Windows destination, a POSIX one to a POSIX destination.
  const S = '/server.js', DEST = '/srv/new', destinationFor = (path: string) => path.includes('\\') ? 'E:\\new' : DEST;
  const dims = (dimension: string, value: string, format: Format, shape: string, destination = DEST) => ({ dimension, value: JSON.stringify(value), format, source: shape, destination });

  // Destination shape: the same set as the source, so P4 runs both ways, and a destination holding the source's text.
  for (const format of FORMATS) {
    for (const shape of SHAPES) for (const destination of shape.path.includes('\\') ? ['E:\\new', 'E:\\new place', 'E:\\nouvé'] : ['/srv/new', '/srv/new place', '/srv/nouvé']) {
      add(dims('destination', destination, format, shape.name, destination), format, shape.path, destination, file(format, [[at('rewrite', writtenPath(format, shape)), S]]));
    }
    for (const [source, destination] of [['/srv/library', '/srv/library-old'], ['/srv/library-old', '/srv/library'], ['D:\\library', 'D:\\library-old'], ['D:\\library-old', 'D:\\library']] as const) {
      add(dims('destination holds the source', destination, format, source, destination), format, source, destination, file(format, [[at('rewrite', native(format, source)), S]]));
    }
  }
  // What comes before the path in its value (decoded): every printable ASCII character and é, then the shapes sections 1011
  // and 1019 name. Only a quote is a path start; in a .db run, a non-ASCII byte ends the run, so the value starts after it.
  const pathStarts = new Set(['"', "'", '`']);
  const BEFORE: [string, LabelName, LabelName?][] = [
    ...Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).map((char): [string, LabelName] => [char, pathStarts.has(char) ? 'rewrite' : 'ambiguous']),
    ['é', 'ambiguous', 'rewrite'], ['\u0085', 'ambiguous', 'rewrite'], ['\x00', 'ambiguous', 'rewrite'], ['\x01', 'ambiguous', 'rewrite'], ['\u{1F600}', 'ambiguous', 'rewrite'], ['\u{1F600} ', 'rewrite'],
    ['', 'rewrite'], [' ', 'rewrite'], ['--workspace=', 'rewrite'], ['-C=', 'rewrite'], ['LIBRARY_WORKSPACE=', 'rewrite'], ['_X=', 'rewrite'],
    ['Read(', 'rewrite'], ['Bash(git -C ', 'rewrite'], ['node ', 'rewrite'], ['node "', 'rewrite'], ['a\n', 'rewrite'], ['a\t', 'rewrite'], ['\f', 'rewrite'],
    // D5's accepted risk: a relative folder ending in a space or a quote, rewritten too.
    ['backup ', 'rewrite'], ["backup'", 'rewrite'], ['--x=', 'rewrite'],
    ['/backup=', 'ambiguous'], ['/backup+', 'ambiguous'], ['/a,', 'ambiguous'], ['/a(', 'ambiguous'], ['/a:', 'ambiguous'], ['/a;', 'ambiguous'],
    ['/x=', 'ambiguous'], ['[t](', 'ambiguous'], ['file:///', 'ambiguous'], [']=', 'ambiguous'], ['-=', 'ambiguous'], ['--1x=', 'ambiguous'],
    ['Read (', 'ambiguous'], ['/backup ', 'ambiguous'], ['/home/my backup ', 'ambiguous'], ["/o'", 'ambiguous'], ['/o`', 'ambiguous'],
    ['node /a/x.js ', 'ambiguous'], ['node D:/a/x.js ', 'ambiguous'], ["/backup '", 'ambiguous'], ['/backup `', 'ambiguous'], ['/backup "', 'ambiguous'],
    ['/backup="', 'ambiguous'], ['node \\"', 'ambiguous'], ['node /backup', 'ambiguous'],
  ];
  for (const [decoded, name, dbName] of BEFORE) for (const format of FORMATS) for (const shape of SHAPES) {
    if (format === 'literal' && !literalOk(decoded)) continue;
    add(dims('before', decoded, format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[enc(format, decoded), at(format === 'db' && dbName ? dbName : name, writtenPath(format, shape)), S]]));
  }
  // What comes after it (decoded): D1.7's ends, every other printable character, é, the closing quote, the end of the file.
  const ENDS = new Set(['\\', '/', '"', "'", '<', '>', '|', '*', '?', '\t', '\n', '\r']);
  const AFTER = [...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)), 'é', '\t', '\n', '\r', '', '/**)', '/app merge:*)', '(backup)', '-DSH', '-different'];
  for (const decoded of AFTER) for (const format of FORMATS) for (const shape of SHAPES) {
    if (format === 'literal' && !literalOk(decoded)) continue;
    const first = decoded.slice(0, 1);
    const name: LabelName = first === '' ? 'rewrite' : format === 'db' ? (/[a-z0-9_. -]/i.test(first) ? 'ambiguous' : 'rewrite') : ENDS.has(first) ? 'rewrite' : 'ambiguous';
    add(dims('after', decoded, format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[at(name, writtenPath(format, shape)), enc(format, decoded)]]));
  }
  for (const shape of SHAPES) add(dims('after', 'the end of the file', 'text', shape.name), 'text', shape.path, destinationFor(shape.path), [at('rewrite', writtenPath('text', shape))]);
  // An escape after the path (raw), in JSON and TOML basic strings.
  for (const [format, raw, name] of [['json', '\\u0041', 'escapedEnd'], ['json', '\\u0020', 'escapedEnd'], ['json', '\\u00e9', 'escapedEnd'], ['json', '\\u002f', 'rewrite'],
    ['toml', '\\x41', 'escapedEnd'], ['toml', '\\u0020', 'escapedEnd'], ['toml', '\\U00000041', 'escapedEnd'], ['toml', '\\x2f', 'rewrite']] as const) {
    for (const shape of SHAPES) add(dims('escape after', raw, format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[at(name, writtenPath(format, shape)), raw]]));
  }
  // Escapes before it (raw): every escape in the format's table, each unknown letter, malformed ones and surrogates.
  const JSON_ESCAPES: [string, LabelName][] = [
    ['\\"', 'rewrite'], ['\\\\', 'ambiguous'], ['\\/', 'ambiguous'], ['\\b', 'ambiguous'], ['\\f', 'rewrite'], ['\\n', 'rewrite'], ['\\r', 'rewrite'], ['\\t', 'rewrite'],
    ['\\u0020', 'rewrite'], ['\\u0041', 'ambiguous'], ['\\u002f', 'ambiguous'], ['\\ud83d\\ude00', 'ambiguous'], ['\\ud83d\\ude00 ', 'rewrite'], ['\\ud800', 'ambiguous'],
    ['\\u12', 'ambiguous'], ['\\U0000002F', 'ambiguous'], ['\\U0000002Fbackup ', 'ambiguous'], ['a\\n', 'rewrite'], ['a\\t', 'rewrite'],
    ...[...'acdeghijklmopqsvwxyzU'].map((letter): [string, LabelName] => ['\\' + letter, 'ambiguous']),
  ];
  const TOML_ESCAPES: [string, LabelName][] = [
    ['\\b', 'ambiguous'], ['\\t', 'rewrite'], ['\\n', 'rewrite'], ['\\f', 'rewrite'], ['\\r', 'rewrite'], ['\\"', 'rewrite'], ['\\\\', 'ambiguous'], ['\\e', 'ambiguous'],
    ['\\x41', 'ambiguous'], ['\\x20', 'rewrite'], ['\\x2f', 'ambiguous'], ['\\x2fbackup ', 'ambiguous'], ['\\u0020', 'rewrite'], ['\\u0041', 'ambiguous'],
    ['\\U00000020', 'rewrite'], ['\\U0000002Fbackup ', 'ambiguous'], ['\\U0000005Cbackup ', 'ambiguous'], ['\\U0001F600', 'ambiguous'], ['\\uD800', 'ambiguous'],
    ['\\U0000D800', 'ambiguous'], ['\\U0000D800 ', 'ambiguous'], ['\\U00110000', 'ambiguous'], ['\\u12', 'ambiguous'], ['\\x4', 'ambiguous'], ['\\q ', 'ambiguous'],
    ...[...'acdghijklmopqsvwyz/'].map((letter): [string, LabelName] => ['\\' + letter, 'ambiguous']),
  ];
  for (const [format, table] of [['json', JSON_ESCAPES], ['toml', TOML_ESCAPES]] as const) for (const [raw, name] of table) for (const shape of SHAPES) {
    // A short hex escape the path's first letter completes (\x4 before D:) is no malformed escape: it reads as another
    // letter, so the path is not there at all (s223).
    const completed = /\\x[0-9a-fA-F]$/.test(raw) && /^[0-9a-fA-F]/.test(writtenPath(format, shape)[0]);
    add(dims('escape before', raw, format, shape.name), format, shape.path, destinationFor(shape.path),
      file(format, [[raw, completed ? { label: 'completedEscape', raw: writtenPath(format, shape)[0], written: false } : at(name, writtenPath(format, shape)), S]]));
  }
  // Escapes that look like separators: a single-letter escape directly before the rest of the path's text, alone and beside
  // a real occurrence in the same value.
  for (const format of ['json', 'toml'] as const) for (const [escape, source] of [['\\r', '/root/library'], ['\\n', '/new/library'], ['\\t', '/tmp/library'], ['\\b', '/bin/library'], ['\\f', '/foo/library']] as const) {
    const phantom = escape + source.slice(2);
    add(dims('separator-looking escape', phantom + ', alone', format, source), format, source, DEST, file(format, [[{ label: 'phantomRewrite', raw: phantom, written: false }, S]]));
    add(dims('separator-looking escape', phantom + ', then the path', format, source), format, source, DEST,
      file(format, [[{ label: 'phantomRewrite', raw: phantom, written: false }, S + ' ', at('ambiguous', [source, 'forward']), S]]));
    add(dims('separator-looking escape', 'the path, then ' + phantom, format, source), format, source, DEST,
      file(format, [[at('rewrite', [source, 'forward']), S + ' ', { label: 'phantomAmbiguous', raw: phantom, written: false }, S]]));
  }
  // Escapes inside the path: one letter as \u, a quote inside a folder name (\"), and \/ between folders (JSON).
  const escapeLast = ([raw]: [string, Form]) => raw.slice(0, -1) + '\\u' + raw.charCodeAt(raw.length - 1).toString(16).padStart(4, '0');
  for (const format of ['json', 'toml'] as const) {
    for (const shape of SHAPES) add(dims('escape inside the path', 'the last letter as \\u', format, shape.name), format, shape.path, destinationFor(shape.path),
      file(format, [[{ label: 'escapedChar', raw: escapeLast(writtenPath(format, shape)) }, S]]));
    add(dims('escape inside the path', 'an escaped quote in a folder name', format, '/srv/li"brary'), format, '/srv/li"brary', DEST,
      file(format, [[{ label: 'escapedChar', raw: '/srv/li\\"brary' }, S]]));
  }
  for (const shape of SHAPES) {
    const [raw, form] = writtenPath('json', shape);
    if (form !== 'forward') continue;
    add(dims('escape inside the path', '\\/ between folders', 'json', shape.name), 'json', shape.path, destinationFor(shape.path), file('json', [[at(shape.forward ? 'mixedSeparators' : 'mixedSeparatorsUnreadable', [raw[0] + raw.slice(1).replace(/\//g, '\\/'), 'mixed']), S]]));
  }
  // Position: crossing a string's end, outside any string, in a key, and in TOML multiline strings.
  const crossing = (format: Format, source: string, before: string, after: string) =>
    add(dims('position', 'the match crosses its string\'s end', format, source), format, source, DEST, [before, { label: 'ambiguous', raw: source, form: 'forward', inString: false }, after]);
  crossing('json', '/srv/","library', '{"a":"', S + '":"x"}');
  crossing('toml', '/srv/","library', 'a = "', S + '"\n');
  crossing('literal', "/srv', y = 'library", "x = '", S + "'\n");
  // Section 1019's controls: the same two folder names wholly inside one string.
  add(dims('position', 'a folder name holding \' wholly inside one JSON string', 'json', "/srv', y = 'library"), 'json', "/srv', y = 'library", DEST,
    file('json', [[at('rewrite', ["/srv', y = 'library", 'forward']), S]]));
  add(dims('position', 'a folder name holding " wholly inside one TOML literal string', 'literal', '/srv/","library'), 'literal', '/srv/","library', DEST,
    file('literal', [[at('rewrite', ['/srv/","library', 'forward']), S]]));
  for (const shape of SHAPES) {
    const P = (format: Format, name: LabelName = 'rewrite', more: Partial<Exclude<Part, string>> = {}) => at(name, writtenPath(format, shape), more);
    const position = (value: string, format: Format, parts: Part[]) => add(dims('position', value, format, shape.name), format, shape.path, destinationFor(shape.path), parts);
    position('outside any string', 'json', ['{"a": 1}\n', P('json', 'ambiguous', { inString: false }), S + '\n']);
    position('outside any string', 'toml', ['path = ', P('literal', 'ambiguous', { inString: false }), S + '\n']);
    position('in a comment', 'toml', ['# ', P('literal', 'ambiguous', { inString: false }), S + '\nv = 1\n']);
    position('in an unclosed string', 'json', ['{"path": "', P('json', 'ambiguous', { inString: false }), S + '\n']);
    position('a JSON object key', 'json', ['{"', P('json'), S + '": 1}']);
    position('a TOML quoted key', 'toml', ['"', P('toml'), S + '" = 1\n']);
    position('a TOML literal key', 'literal', ["'", P('literal'), S + "' = 1\n"]);
    position('a table header', 'toml', ['[projects."', P('toml'), '"]\ntrust_level = "trusted"\n']);
    position('a table header, literal key', 'literal', ["[projects.'", P('literal'), "']\ntrust_level = 'trusted'\n"]);
    position('one key in two dotted table headers', 'toml', ['[projects."', P('toml'), '".a]\nx = 1\n[projects."', P('toml'), '".b]\ny = 2\n']);
    position('a multiline basic string', 'toml', ['v = """\n', P('toml', 'unreadable'), S + '"""\n']);
    position('a multiline literal string', 'toml', ["v = '''\n", P('literal', 'unreadable'), S + "'''\n"]);
    position('a four-quote multiline string, the path in single quotes', 'toml', ['path = """"\n/backup\n\'', P('toml', 'unreadable'), S + '\'\n""""\n']);
    position('a basic string in a file that also holds """', 'toml', ['a = "', P('toml', 'unreadable'), S + '"\nv = """\nx"""\n']);
    position('a multiline basic string, one letter escaped', 'toml', ['v = """\n', { label: 'unreadableEscaped', raw: escapeLast(writtenPath('toml', shape)), written: false }, S + '"""\n']);
    const [raw] = writtenPath('toml', shape), cut = raw.length - 3;
    for (const [how, join] of [['with indentation', '\\\n    '], ['with a blank line', '\\\n\n  '], ['LF', '\\\n'], ['CRLF', '\\\r\n']] as const) {
      position('a multiline basic string, split in a folder name by a line continuation, ' + how, 'toml',
        ['v = """\n', { label: 'unreadableEscaped', raw: raw.slice(0, cut) + join + raw.slice(cut), written: false }, S + '"""\n']);
    }
  }
  // Neighbours in the same file, and canonical or not.
  const formOf = (format: Format, shape: Shape) => writtenPath(format, shape)[1];
  const destinationIn = (form: Form, destination: string) => form === 'doubled' ? destination.replace(/[\\/]/g, '\\\\') : form === 'single' ? destination.replace(/[\\/]/g, '\\') : destination.replace(/\\/g, '/');
  for (const shape of SHAPES) {
    for (const format of FORMATS) {
      const P = (name: LabelName = 'rewrite') => at(name, writtenPath(format, shape));
      const [raw, form] = writtenPath(format, shape);
      add(dims('neighbour', 'a sibling folder whose name starts with the last folder name', format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[P(), S], [P('ambiguous'), '-old' + S]]));
      if (format !== 'db') add(dims('neighbour', 'a value already holding the destination', format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[P(), S], [native(format, destinationFor(shape.path))[0] + S]]), false);
      add(dims('canonical', 'a run of separators', format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[at('run', [raw.replace(/(?<=.)([\\/]+)/, '$1$1'), 'mixed']), S]]));
      if (/^[\\/]/.test(shape.path)) add(dims('canonical', 'a leading run of separators', format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[at('leadingRun', [raw[0] + raw, form]), S]]));
      add(dims('canonical', 'another case', format, shape.name), format, shape.path, destinationFor(shape.path), file(format, [[at(format === 'db' && /[^\x00-\x7f]/.test(shape.path) ? 'otherCaseFoldedBytes' : 'otherCase', [raw.toUpperCase(), form], { written: windows }), S]]));
    }
    for (const format of ['json', 'toml'] as const) {
      add(dims('neighbour', 'an ambiguous occurrence and an escaped-character occurrence', format, shape.name), format, shape.path, destinationFor(shape.path),
        file(format, [['x', at('ambiguous', writtenPath(format, shape)), S], [{ label: 'escapedChar', raw: escapeLast(writtenPath(format, shape)) }, S]]));
    }
    for (const format of ['json', 'toml', 'literal'] as const) {
      const form = formOf(format, shape), quote = format === 'literal' ? "'" : '"';
      const parts: Part[] = format === 'json' ? ['{"', at('collisionKey', writtenPath(format, shape)), `": 1, "${destinationIn(form, destinationFor(shape.path))}": 2}`]
        : [quote, at('collisionKeyUnreadable', writtenPath(format, shape)), `${quote} = 1\n${quote}${destinationIn(form, destinationFor(shape.path))}${quote} = 2\n`];
      add(dims('neighbour', 'a key already equal to the destination', format, shape.name), format, shape.path, destinationFor(shape.path), parts, false);
    }
  }

  // The properties. An occurrence, for P2 and P5, is D1.1's: separators either way and in runs, case folded on Windows.
  const fold = (text: string) => !windows ? text : Array.from(text, char => { const lower = char.toLowerCase(); return lower.length === char.length ? lower : char; }).join('');
  const quoteRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = (path: string) => fold(path).split(/[\\/]+/).map(quoteRe).join('[\\\\/]+');
  const occurrences = (path: string, text: string) => [...fold(text).matchAll(new RegExp(pathRe(path), 'g'))];
  // P2 for one string: b with zero or more of its occurrences replaced by the destination (in any separator form), and nothing else.
  const substituted = (b: string, a: string, source: string, destination: string) => {
    if (a === b) return true;
    let pattern = '^', cursor = 0;
    for (const match of occurrences(source, b)) {
      pattern += quoteRe(b.slice(cursor, match.index)) + '(?:' + quoteRe(b.slice(match.index, match.index + match[0].length)) + '|' + destination.split(/[\\/]+/).map(quoteRe).join('[\\\\/]+') + ')';
      cursor = match.index + match[0].length;
    }
    return new RegExp(pattern + quoteRe(b.slice(cursor)) + '$').test(a);
  };
  const tree = (format: Format, text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    try { return { ok: true, value: format === 'json' ? JSON.parse(text) : toml.parse(text) }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  };
  const sameTree = (b: unknown, a: unknown, source: string, destination: string): boolean => {
    if (typeof b === 'string') return typeof a === 'string' && substituted(b, a, source, destination);
    if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((item, i) => sameTree(item, a[i], source, destination));
    if (b && typeof b === 'object' && !(b instanceof Date)) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
      const bKeys = Object.keys(b), aKeys = Object.keys(a);
      return bKeys.length === aKeys.length && bKeys.every((key, i) => substituted(key, aKeys[i]!, source, destination) &&
        sameTree((b as Record<string, unknown>)[key], (a as Record<string, unknown>)[aKeys[i]!], source, destination));
    }
    return JSON.stringify(b) === JSON.stringify(a);
  };
  const keyCounts = (value: unknown): number[] => Array.isArray(value) ? value.flatMap(keyCounts)
    : value && typeof value === 'object' && !(value instanceof Date) ? [Object.keys(value).length, ...Object.values(value).flatMap(keyCounts)] : [];
  const survivors = (value: unknown, source: string): number => typeof value === 'string' ? occurrences(source, value).length
    : Array.isArray(value) ? value.reduce((sum: number, item) => sum + survivors(item, source), 0)
    : value && typeof value === 'object' && !(value instanceof Date) ? Object.entries(value).reduce((sum, [key, item]) => sum + occurrences(source, key).length + survivors(item, source), 0) : 0;
  // P3: after is before with some of the written spans, and nothing else, replaced by the destination in the span's form.
  // A JSON span written with \/ is rewritten with \/ for every separator (D1.8's fourth form, unit B).
  const destinationForms = (form: Form, destination: string, format: Format) => ({
    doubled: [destination.replace(/[\\/]/g, '\\\\')], single: [destination.replace(/[\\/]/g, '\\')], forward: [destination.replace(/\\/g, '/')],
    mixed: [destination.replace(/[\\/]/g, '\\\\'), destination.replace(/[\\/]/g, '\\'), destination.replace(/\\/g, '/'), ...(format === 'json' ? [destination.replace(/[\\/]/g, '\\/')] : [])],
  })[form];
  const spansReplaced = (row: Case, after: string): Place[] | null => {
    const spans = row.places.filter(place => place.written).sort((x, y) => x.start - y.start);
    let pattern = '^', cursor = 0;
    for (const span of spans) {
      pattern += quoteRe(row.text.slice(cursor, span.start)) + '(?:' + quoteRe(row.text.slice(span.start, span.end)) + '|(' + destinationForms(span.form, row.destination, row.format).map(quoteRe).join('|') + '))';
      cursor = span.end;
    }
    const match = new RegExp(pattern + quoteRe(row.text.slice(cursor)) + '$').exec(after);
    return match ? spans.filter((_, i) => match[i + 1] !== undefined) : null;
  };

  const counters = new Map<string, ReturnType<typeof pathCounter>>();
  const counter = (root: string) => { let found = counters.get(root); if (!found) counters.set(root, found = pathCounter(root)); return found; };
  const counterFormat = { json: 'json', toml: 'toml', literal: 'toml', text: 'text', db: 'binary' } as const;
  const PROPERTIES: Property[] = ['outcome', 'P1', 'P2', 'P2a', 'P3', 'P4', 'P5a', 'P5'];
  const expectedMisses = new Map<Property, number>(PROPERTIES.map(property => [property, 0]));
  const faults: string[] = [];
  const started = Date.now();
  for (const row of cases) {
    // The outcome after unit B: rewrite and ambiguous counted as before, none counting nothing; a case with a place labelled
    // not executable is a file the counter refuses, with D5.2's or D5.3's reason, and plans no bytes for.
    const refused = row.places.some(place => place.label.afterB === 'not executable');
    const expected = { occurrences: row.places.filter(place => place.label.afterB === 'rewrite').length, ambiguous: row.places.filter(place => place.label.afterB === 'ambiguous').length,
      notExecutable: !refused ? undefined : row.places.some(place => place.name.startsWith('collision')) ? COLLISION_REASON : RESIDUE_REASON,
      reason: row.places.some(place => place.name === 'escapedChar') ? ESCAPED_REASON : undefined };
    let result: { occurrences: number; ambiguous: number; newBytes?: Buffer; reason?: string; notExecutable?: string };
    try { result = counter(row.source)(Buffer.from(row.text, 'utf8'), row.destination, counterFormat[row.format]); }
    catch (error) { faults.push(`1021: pathCounter threw on ${JSON.stringify(row.dims)}: ${(error as Error).message}; before ${JSON.stringify(row.text)}`); continue; }
    const after = result.newBytes?.toString('utf8');
    const verdicts = new Map<Property, boolean>();
    verdicts.set('outcome', refused ? result.notExecutable === expected.notExecutable && after === undefined
      : result.notExecutable === undefined && result.occurrences === expected.occurrences && result.ambiguous === expected.ambiguous && result.reason === expected.reason);
    // The folded Must of s222-r2's first read: a case the counter rewrites and does not refuse must have planned bytes, so P1
    // to P5 never pass by being skipped.
    if (row.format !== 'db' && result.occurrences > 0 && result.notExecutable === undefined && after === undefined) {
      faults.push(`1021: counted ${result.occurrences} occurrences but planned no bytes: ${JSON.stringify(row.dims)}; before ${JSON.stringify(row.text)}`);
    }
    const written = row.places.filter(place => place.written);
    verdicts.set('P5a', result.notExecutable !== undefined || result.occurrences + result.ambiguous === written.length);
    // A refused file has no after: P3 checks only that nothing was planned for it.
    if (result.notExecutable !== undefined) verdicts.set('P3', after === undefined);
    let replaced: Place[] | null = null;
    if (after !== undefined) {
      replaced = spansReplaced(row, after);
      verdicts.set('P3', replaced !== null && replaced.length === result.occurrences);
      if (row.canonical && !row.places.some(place => place.label.nonCanonical)) {
        const back = counter(row.destination)(Buffer.from(after, 'utf8'), row.source, counterFormat[row.format]);
        verdicts.set('P4', back.occurrences === result.occurrences && back.newBytes?.toString('utf8') === row.text);
      }
      if (row.format === 'text') verdicts.set('P2', substituted(row.text, after, row.source, row.destination));
    }
    if (after !== undefined && row.format !== 'text') {
      const b = tree(row.format, row.text), a = tree(row.format, after);
      verdicts.set('P1', b.ok === a.ok);
      if (b.ok) {
        verdicts.set('P2', a.ok && sameTree(b.value, a.value, row.source, row.destination));
        verdicts.set('P2a', a.ok ? JSON.stringify(keyCounts(a.value)) === JSON.stringify(keyCounts(b.value)) : !/redefine|duplicate/i.test(a.error));
      }
      // P5: the planned rewrite applied, the spans it replaced masked (copies of the destination it wrote), then the
      // occurrences still in a value or key: at most the ambiguous count less those written outside any string.
      let masked = after;
      if (replaced) { masked = ''; let cursor = 0; for (const span of replaced) { masked += row.text.slice(cursor, span.start) + 'MASK'; cursor = span.end; } masked += row.text.slice(cursor); }
      const m = tree(row.format, masked);
      if (m.ok) verdicts.set('P5', survivors(m.value, row.source) <= result.ambiguous - written.filter(place => !place.inString).length);
    }
    const marked = new Set(row.places.flatMap(place => place.label.miss ?? []));
    for (const [property, held] of verdicts) {
      const isMarked = marked.has(property);
      if (!held && isMarked) { expectedMisses.set(property, expectedMisses.get(property)! + 1); continue; }
      if (held && !isMarked) continue;
      faults.push(`1021: ${held ? `marked expected miss: D5 (${property}) passed` : `${property} failed`}: ${JSON.stringify(row.dims)}; before ${JSON.stringify(row.text)}; ` +
        `planned after ${after === undefined ? '(none)' : JSON.stringify(after)}; counted ${result.occurrences} occurrences and ${result.ambiguous} ambiguous` +
        `${result.reason ? `, reason "${result.reason}"` : ''}${result.notExecutable ? `, not executable "${result.notExecutable}"` : ''}; ` +
        `labels expect ${refused ? `not executable "${expected.notExecutable}"` : `${expected.occurrences} and ${expected.ambiguous}`}; places ${row.places.map(place => place.name).join(', ') || 'none'}`);
    }
  }
  const elapsed = Date.now() - started;
  // No file under kernel/src imports the reference parser: it is a test-only dependency (plan D4).
  const sourceFiles = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(join(folder, entry.name)) : entry.name.endsWith('.ts') ? [join(folder, entry.name)] : []);
  const importers = sourceFiles(join(HERE, '..', 'src')).filter(name => /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]smol-toml['"]/.test(readFileSync(name, 'utf8')));
  same(importers, [], '1021: no file under kernel/src imports smol-toml');
  console.log(`1021: ${cases.length} generated cases, checked in ${elapsed} milliseconds; expected misses until unit B: ` +
    PROPERTIES.map(property => `${property} ${expectedMisses.get(property)}`).join(', '));
  for (const fault of faults) failures.push(fault);
  check(faults.length === 0, `1021: every case matches its outcome after unit B and every property (${faults.length} did not)`);
  // Unit B removes every mark: no label names an expected miss, and every printed count is 0.
  same(Object.entries(LABELS).filter(([, value]) => (value as Label).miss?.length).map(([name]) => name), [], '1021: no label carries an expected miss');
  same(PROPERTIES.filter(property => expectedMisses.get(property) !== 0), [], '1021: every expected-miss count is 0');
  check(cases.length >= MINIMUM_CASES, `1021: the generator made at least ${MINIMUM_CASES} cases (made ${cases.length}); a lost dimension lowers the count`);
  if (windows) check(elapsed <= 30_000, `1021: the generated cases ran in 30 seconds or less on Windows (took ${elapsed} milliseconds)`);
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
if (selected(1010)) await section1010();
if (selected(1011)) await section1011();
if (selected(1012)) await section1012();
if (selected(1013)) await section1013();
if (selected(1014)) await section1014();
if (selected(1015)) await section1015();
if (selected(1016)) await section1016();
if (selected(1017)) await section1017();
if (selected(1018)) await section1018();
if (selected(1021)) await section1021();
if (selected(1022)) await section1022();
if (selected(1023)) await section1023();
if (selected(1060)) await section1060();
if (selected(1061)) await sectionDefaultRules(1061);
if (selected(1062)) await sectionDefaultRules(1062);
if (selected(1063)) await sectionDefaultCreation(1063);
if (selected(1064)) await sectionDefaultCreation(1064);
if (selected(1065)) await sectionDefaultLaunch(1065);
if (selected(1066)) await sectionDefaultLaunch(1066);
if (selected(1067)) await sectionDefaultDescribe();
if (selected(1068)) await section1068();
if (selected(1069)) await section1069();
if (selected(1030)) await section1030();
if (selected(1031)) await section1031();
if (selected(1032)) await section1032();
if (selected(1033)) await section1033();
if (selected(1034)) await section1034();
if (selected(1035)) await section1035();
if (selected(1036)) await section1036();
if (selected(1037)) await section1037();
if (selected(1038)) await section1038();
if (selected(1039)) await section1039();
if (selected(1040)) await section1040();
if (selected(1041)) await section1041();
if (selected(1042)) await section1042();
if (selected(1019)) await section1019();
if (selected(1020)) await section1020();
if (selected(1050) && prerequisite(1050, () => process.platform === 'win32', 'requires Windows')) await section1050();
if (selected(1051) && prerequisite(1051, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1051();
if (selected(1052)) await section1052();
if (selected(1053) && prerequisite(1053, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1053();
if (selected(1070)) await section1070();
if (selected(1071)) await section1071();
if (selected(1074)) await section1074();
if (selected(1075)) await section1075();
if (selected(1076)) await section1076();
if (selected(1077)) await section1077();
if (selected(1078)) await section1078();
if (selected(1079)) await section1079();
if (selected(1080)) await section1080();
if (selected(1081)) await section1081();
if (selected(1082)) await section1082();
if (selected(1083)) await section1083();
if (selected(1084)) await section1084();
if (selected(1085)) await section1085();
if (selected(1086)) await section1086();
if (selected(1087)) await section1087();
if (selected(1088) && prerequisite(1088, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1088();
if (selected(1089) && prerequisite(1089, () => process.platform === 'linux', 'requires Linux')) await section1089();
if (selected(1090)) await section1090();
if (selected(1091)) await section1091();
if (selected(1092)) await section1092();
if (selected(1093) && prerequisite(1093, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1093();
if (selected(1094) && prerequisite(1094, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1094();
if (selected(1095) && prerequisite(1095, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1095();
if (selected(1072) && prerequisite(1072, () => process.platform === 'win32' && KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!), 'requires Windows compiled kernel')) await section1072();
if (selected(1073) && prerequisite(1073, () => process.platform === 'linux', 'requires Linux')) await section1073();
}

async function section1070(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const { createHash } = await import('node:crypto');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-1070-')));
  const workspace = join(root, 'source'), destination = join(root, 'destination'), registryRoot = join(root, 'registry');
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    fs.mkdirSync(join(workspace, '.library'), { recursive: true });
    fs.mkdirSync(join(workspace, 'internal'));
    fs.mkdirSync(registryRoot);
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'yield-fixture' }));
    fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'yield-fixture', path: workspace }] }));
    const payload = Buffer.alloc(32 * 1024 * 1024, 73);
    fs.writeFileSync(join(workspace, 'large.bin'), payload);
    for (let index = 0; index < 8; index++) fs.writeFileSync(join(workspace, `file-${index}.txt`), `keep ${index}`);
    const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
    const preview = await move.previewLibraryMove(options);
    equal(preview.refusal, null, '1070: preview');
    if (preview.refusal) return;
    const plan = preview.value as Record<string, any>;
    let inputRan = false, progressAfterInput = false, hashInput = false, hashYielded = false, hashStarted = false;
    const events: { phase: string; file?: string }[] = [];
    const input = new Promise<void>(resolve => setImmediate(() => { inputRan = true; resolve(); }));
    const result = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: plan.plan_id,
      control: { cancelled: () => false, progress: (event: { phase: string; file?: string }) => {
        events.push(event); progressAfterInput ||= inputRan;
        if (event.phase === 'hash' && event.file?.endsWith('large.bin')) {
          if (!hashStarted) { hashStarted = true; setImmediate(() => { hashInput = true; }); }
          else hashYielded ||= hashInput;
        }
      } } });
    await input;
    equal(result.refusal, null, '1070: async move: ' + result.refusal);
    check(progressAfterInput, '1070: input executes while the engine reports progress');
    check(events.some(event => event.phase === 'copy' && event.file === 'large.bin'), '1070: copy reports large-file progress');
    check(events.some(event => event.phase === 'hash'), '1070: hashing reports progress');
    check(hashYielded, '1070: event-loop input runs between chunks of one large file');
    const copied = events.findIndex(event => event.phase === 'copy');
    check(copied >= 0 && events.slice(copied + 1).some(event => event.phase === 'hash'), '1070: verification hashing also reports progress');
    if (!result.refusal) {
      const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      equal(sha(fs.readFileSync(join(destination, 'large.bin'))), sha(payload), '1070: yielded hashing and copying preserve bytes');
      for (let index = 0; index < 8; index++) equal(fs.readFileSync(join(destination, `file-${index}.txt`), 'utf8'), `keep ${index}`, '1070: small-file bytes preserved');
      same((result.value as Record<string, any>).left_and_listed, [], '1070: silent move adds no unresolved outcome');
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1071(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const blockers = (move as any).moveBlockers;
  check(typeof blockers === 'function', '1071: operation-aware blocker collector exists');
  if (typeof blockers !== 'function') return;
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-1071-')));
  const workspace = join(root, 'source'), destination = join(root, 'destination'), registryRoot = join(root, 'registry');
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const previous = process.cwd();
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'blockers' }));
    fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'blockers', path: workspace }] }));
    const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any', processTable: () => [], holderScan: () => ({ holders: [], uninspectable: 0, resources: [] }) };
    same(await blockers('move', options), [], '1071: clear fixture has no blocker');
    const refusals = join(registryRoot, 'move-journals/refusals');
    check(!fs.existsSync(refusals), '1071: a ready preview writes no refusal snapshot');
    const resources = join(root, 'resource-cap'); fs.mkdirSync(resources);
    for (let index = 0; index < 513; index++) fs.writeFileSync(join(resources, String(index).padStart(4, '0') + '.txt'), 'fixture');
    const capped = move.scanMoveHolders([resources], []);
    equal(capped.resources.length, 512, '1071: 513 eligible resources stop at the 512-path boundary');
    check(!capped.resources.includes(join(resources, '0512.txt')), '1071: the first path beyond the cap is excluded');
    process.chdir(workspace);
    const many = await blockers('move', { ...options, processTable: () => [{ pid: 990001, parentPid: 0, name: 'orca' }, { pid: 990002, parentPid: 0, name: 'codex' }], holderScan: () => ({ holders: [{ pid: 990003, name: 'editor', detail: 'open file' }], uninspectable: 3, resources: [] }) });
    check(many.some((b: any) => b.kind === 'folder'), '1071: current folder is a blocker');
    const snapshots = fs.existsSync(refusals) ? fs.readdirSync(refusals) : [];
    equal(snapshots.length, 1, '1071: one refusal writes one snapshot');
    if (snapshots.length === 1) {
      const snapshot = JSON.parse(fs.readFileSync(join(refusals, snapshots[0]!), 'utf8'));
      check(snapshot.processes.some((row: any) => row.pid === 990001 && row.parentPid === 0 && row.name === 'orca' && row.reason.includes('process')), '1071: snapshot records process identity and classification');
      check(snapshot.holders.some((row: any) => row.pid === 990003), '1071: snapshot records holders');
    }
    for (const pid of [990001, 990002, 990003]) check(many.some((b: any) => b.pid === pid), '1071: every writer and holder is aggregated: ' + pid);
    check(!many.some((b: any) => /could not be checked/.test(b.detail)), '1071: uninspectable processes are counted, not blockers');
    process.chdir(previous);
    same(await blockers('move', options), [], '1071: clearing the table clears all blockers');
    const arrived = await blockers('move', { ...options, processTable: () => [{ pid: 990004, parentPid: 0, name: 'deskpost' }] });
    check(arrived.some((b: any) => b.pid === 990004), '1071: an arriving writer is seen');
    const unreadable = await blockers('move', { ...options, processTable: () => { throw new Error('fixture table denied'); } });
    check(unreadable.some((b: any) => /process table could not be read/i.test(b.detail)), '1071: unreadable table fails closed');
    const service = { pid: 990005, parentPid: 0, name: 'codex-windows-sandbox-service.exe' };
    same(await blockers('move', { ...options, processTable: () => [service] }), [], '1071: sandbox service alone is not a named-application blocker');
    const coupled = await blockers('move', { ...options, processTable: () => [service, { pid: 990006, parentPid: 0, name: 'codex.exe' }] });
    check(coupled.some((b: any) => b.pid === service.pid && b.fix.includes('Codex closes')), '1071: service with Codex has the precise remedy');
    const heldService = await blockers('move', { ...options, processTable: () => [service], holderScan: () => ({ holders: [{ ...service, detail: 'working folder' }], uninspectable: 0, resources: [] }) });
    check(heldService.some((b: any) => b.kind === 'holder' && b.pid === service.pid), '1071: a service holding the folder remains a holder');
    fs.rmdirSync(join(workspace, 'internal'));
    const reasons = await blockers('move', { ...options, processTable: () => [{ pid: 990007, parentPid: 0, name: 'orca' }] });
    check(reasons.some((b: any) => b.kind === 'reason' && /internal.*missing/.test(b.detail)) && reasons.some((b: any) => b.pid === 990007), '1071: structural reasons and processes appear together');
  } finally {
    process.chdir(previous);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1072(): Promise<void> {
  const { spawn, spawnSync } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-1072-')));
  const workspace = join(root, 'source'), registry = join(root, 'registry');
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry };
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const init = spawnSync(process.execPath, [join(PROGRAM_ROOT, 'kernel/src/cli.ts'), 'init', workspace, '--registry-root', registry], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    equal(init.status, 0, '1072: fixture init: ' + init.stderr); if (init.status !== 0) return;
    const file = join(workspace, 'held.txt'); fs.writeFileSync(file, 'keep bytes');
    for (const kind of ['folder', 'file']) {
      const ready = join(root, kind + '-ready');
      const script = join(root, kind + '-child.mjs');
      fs.writeFileSync(script, `import fs from 'node:fs'; ${kind === 'file' ? `const handle = fs.openSync(${JSON.stringify(file)}, 'r');` : ''} fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
      const child = spawn(process.execPath, [script], { cwd: kind === 'folder' ? workspace : root, env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' }); children.push(child);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        check(fs.existsSync(ready), '1072: real holder ready: ' + kind);
        const destination = join(root.slice(0, 3), 'dev', 'c183-' + root.split(/[\\/]/).pop());
        const result = runCli(['library', 'move', destination, '--workspace', workspace, '--registry-root', registry, '--preflight', '--json'], { cwd: root, env });
        check([0, 3].includes(result.exit), '1072: blocked preview is readable: ' + result.stderr);
        if ([0, 3].includes(result.exit)) {
          const value = JSON.parse(result.stdout);
          check(value.blockers?.some((b: any) => b.kind === 'holder' && b.pid === child.pid), '1072: native reader names real ' + kind + ' holder');
        }
        equal(fs.readFileSync(file, 'utf8'), 'keep bytes', '1072: holder preview preserves source');
        check(!fs.existsSync(destination), '1072: holder preview makes no copy');
      } finally { child.kill(); await exited; }
    }
    await section1074('held');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1073(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const scan = (move as any).scanMoveHolders;
  check(typeof scan === 'function', '1073: holder reader exists'); if (typeof scan !== 'function') return;
  const { spawn } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-1073-')));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, stdio: 'ignore' });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const found = scan([root], [{ pid: child.pid!, parentPid: process.pid, name: 'node' }]);
    check(found.holders.some((b: any) => b.pid === child.pid && b.detail.includes('working folder')), '1073: real Linux working-folder holder');
    const heldFile = join(root, 'held.txt'), ready = join(root, 'descriptor-ready'), script = join(root, 'descriptor.mjs');
    fs.writeFileSync(heldFile, 'keep these bytes');
    fs.writeFileSync(script, `import fs from 'node:fs'; const handle = fs.openSync(${JSON.stringify(heldFile)}, 'r'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    const descriptorChild = spawn(process.execPath, [script], { cwd: os.tmpdir(), stdio: 'ignore' });
    const descriptorExit = new Promise<void>(resolve => descriptorChild.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(ready) && descriptorChild.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      check(fs.existsSync(ready), '1073: real file-descriptor holder is ready');
      const fileScan = scan([root], [{ pid: descriptorChild.pid!, parentPid: process.pid, name: 'node' }]);
      check(fileScan.holders.some((b: any) => b.pid === descriptorChild.pid && b.detail === 'open file: ' + heldFile), '1073: real Linux file-descriptor holder outside the Library');
      equal(fs.readFileSync(heldFile, 'utf8'), 'keep these bytes', '1073: holder scan preserves file bytes');
    } finally { descriptorChild.kill(); await descriptorExit; }
  } finally { child.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1050(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const proc = await import('../../src/procstart.ts');
  const { windowsProcesses } = await import('../../src/lifecycle.ts');
  const { waitForAgentExit } = await import('../../src/seat.ts');
  const { quietCheck } = await import('../../src/librarymove.ts');
  const api = await import('../../src/win32proc.ts');
  const run = (api as any).runInstalledProcess;
  check(typeof run === 'function', '1050: installed process route exists');
  if (typeof run !== 'function') return;
  const saved = { ...process.env };
  const root = fs.mkdtempSync(join(os.tmpdir(), 'c176-source-'));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    for (const key of Object.keys(process.env)) if (/^path$/i.test(key)) delete process.env[key];
    process.env['PATH'] = (saved['PATH'] ?? saved['Path'] ?? '').split(';').filter(p => p && !fs.existsSync(join(p, 'powershell.exe')) && !fs.existsSync(join(p, 'pwsh.exe'))).join(';');
    if (KERNEL_COMMAND.length === 1 && /\.exe$/i.test(KERNEL_COMMAND[0]!)) process.env['DESKPOST_KERNEL'] = KERNEL_COMMAND[0];
    let installed = '';
    try { installed = run(null); } catch (error) { console.log('1050: only refusal half judged: ' + (error as Error).message); }
    if (installed) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(child);
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const pid = child.pid!;
      const start = run(['start', String(pid)]).start_utc;
      check(typeof start === 'string' && start !== proc.UNREADABLE_IDENTITY, '1050: fixture has a readable start time');
      equal(proc.agentProcessIdentity(pid, { fresh: true }), start, '1050: source start equals installed start');
      const ancestry = proc.readProcessAncestry(pid);
      check(ancestry.some(row => row.pid === process.pid), '1050: ancestry reaches this parent');
      equal(proc.readProcessAncestry(pid, 0).length, 1, '1050: ancestry respects depth');
      check(windowsProcesses().some(row => row.ProcessId === pid && row.ExecutablePath?.toLowerCase() === process.execPath.toLowerCase()), '1050: source table holds fixture name and path');
      const agent = join(root, 'codex.exe'); fs.copyFileSync(process.execPath, agent);
      const client = spawn(agent, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(client);
      await new Promise<void>((resolve, reject) => { client.once('spawn', resolve); client.once('error', reject); });
      equal(proc.launcherChildAgent(process.pid)?.pid, client.pid, '1050: launcher finds agent child');
      const wait = waitForAgentExit(pid, start, 25);
      let returned = false; void wait.then(() => { returned = true; });
      await new Promise(resolve => setTimeout(resolve, 150));
      check(!returned, '1050: wait holds while fixture lives');
      child.kill(); await wait;
      check(returned, '1050: wait returns after fixture exits');
    }
    process.env['DESKPOST_KERNEL'] = join(root, 'missing.exe'); process.env['PATH'] = root;
    equal(proc.agentProcessIdentity(process.pid, { fresh: true }), proc.UNREADABLE_IDENTITY, '1050: missing route preserves unreadable identity');
    same(proc.readProcessAncestry(process.pid), [], '1050: missing route stops walk');
    equal(proc.launcherChildAgent(process.pid), null, '1050: missing route finds no agent');
    let tableError = ''; try { windowsProcesses(); } catch (error) { tableError = (error as Error).message; }
    check(tableError.includes('DESKPOST_KERNEL'), '1050: table refusal names repair');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const wait = waitForAgentExit(child.pid!, '', 25);
    let returned = false; void wait.then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    check(!returned, '1050: wait holds while missing-route fixture lives');
    child.kill(); await wait;
    check(returned, '1050: wait returns after missing-route fixture exits');
    check(quietCheck().refusal?.includes('DESKPOST_KERNEL') === true, '1050: move refusal names repair');
  } finally {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; } }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1051(): Promise<void> {
  const { spawn, spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(join(os.tmpdir(), 'c176-release-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: join(root, 'registry'), DESKPOST_LIBRARY_MOVE: '1' };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env['PATH'] = (process.env['PATH'] ?? process.env['Path'] ?? '').split(';').filter(p => p && !fs.existsSync(join(p, 'powershell.exe')) && !fs.existsSync(join(p, 'pwsh.exe'))).join(';');
  const run = (args: string[]) => {
    const result = spawnSync(KERNEL_COMMAND[0]!, args, { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    equal(result.status, args[0] === 'library' && args[1] === 'move' ? 3 : 0, '1051: ' + args.slice(0, 2).join(' ') + ': ' + result.stderr);
    return JSON.parse(result.stdout || '{}');
  };
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const script = join(root, 'cli.ts'); fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    for (const args of [[script], ['-e', 'setInterval(() => {}, 1000)']]) {
      const child = spawn(process.execPath, args, { env, stdio: 'ignore', windowsHide: true }); children.push(child);
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    }
    const all = run(['process', 'list']);
    equal(all.route, 'bun-ffi', '1051: compiled native route');
    check(all.processes?.length > 0 && all.processes.every((row: any) => typeof row.name === 'string' && row.name.length > 0), '1051: every process has an image name');
    const nodes = run(['process', 'list', '--name', 'node.exe']);
    check(nodes.processes?.find((row: any) => row.pid === children[0]!.pid)?.command_line?.includes(script), '1051: native command line holds fixture script path');
    const workspace = join(root, 'Library');
    const init = spawnSync(process.execPath, [join(PROGRAM_ROOT, 'kernel/src/cli.ts'), 'init', workspace, '--registry-root', env['LIBRARY_WORKSPACES']!], { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    equal(init.status, 0, '1051: scratch init: ' + init.stderr);
    const path = await import('node:path');
    const destination = join(path.parse(root).root, 'dev', path.basename(root) + '-destination');
    const preview = run(['library', 'move', destination, '--workspace', workspace, '--preflight', '--json']);
    const text = JSON.stringify(preview);
    check(!/process table could not be read/i.test(text), '1051: move reads process table without PowerShell');
    check(text.includes(`(process ${children[0]!.pid})`), '1051: move lists cli.ts fixture as a writer');
    check(!text.includes(`(process ${children[1]!.pid})`), '1051: plain node expression is not a writer');
    console.log('1051: preview ' + JSON.stringify({ written: preview.written, warnings: preview.warnings, writer: children[0]!.pid, plain: children[1]!.pid }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1052(): Promise<void> {
  const api = await import('../../src/win32proc.ts');
  const run = (api as any).runInstalledProcess;
  check(typeof run === 'function', '1052: installed process discovery exists');
  if (typeof run !== 'function') return;
  const root = fs.mkdtempSync(join(os.tmpdir(), 'c176-discovery-'));
  try {
    const exe = join(root, 'chosen.exe'); fs.writeFileSync(exe, 'fixture');
    equal(run(null, { DESKPOST_KERNEL: exe, PATH: '' }), exe, '1052: explicit executable');
    const notExe = join(root, 'chosen.cmd'); fs.writeFileSync(notExe, 'fixture');
    for (const env of [{ DESKPOST_KERNEL: notExe, PATH: '' }, { DESKPOST_KERNEL: join(root, 'missing.exe'), PATH: '' }, { PATH: '' }]) {
      let message = ''; try { run(null, env); } catch (error) { message = (error as Error).message; }
      check(message.includes('DESKPOST_KERNEL') && /install/i.test(message), '1052: missing executable names both repairs');
    }
    const bin = join(root, 'bin'), current = join(root, 'current', 'bin'); fs.mkdirSync(bin); fs.mkdirSync(current, { recursive: true });
    const linked = join(current, 'library.exe'); fs.writeFileSync(linked, 'fixture');
    const direct = join(bin, 'library.exe'); fs.writeFileSync(direct, 'fixture');
    equal(run(null, { DESKPOST_KERNEL: exe, PATH: bin }), exe, '1052: explicit executable takes precedence');
    for (const shim of ['deskpost.cmd', 'library.cmd']) {
      fs.writeFileSync(join(bin, shim), 'fixture');
      equal(run(null, { PATH: bin }), linked, '1052: ' + shim + ' resolves installed executable');
      fs.unlinkSync(join(bin, shim));
    }
    equal(run(null, { PATH: bin }), direct, '1052: executable on PATH');
    fs.mkdirSync(join(root, 'folder.exe'));
    let refused = false; try { run(null, { DESKPOST_KERNEL: join(root, 'folder.exe'), PATH: '' }); } catch { refused = true; }
    check(refused, '1052: a directory is not an executable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1053(): Promise<void> {
  const kernel = KERNEL_COMMAND.length === 1 ? KERNEL_COMMAND[0] : '';
  if (!prerequisite(1053, () => Boolean(kernel && /\.exe$/i.test(kernel) && fs.existsSync(kernel)), 'requires a compiled kernel through LIBRARY_SELFTEST_KERNEL')) return;
  const { spawn } = await import('node:child_process');
  const { runInstalledProcess } = await import('../../src/win32proc.ts');
  const { quietCheck } = await import('../../src/librarymove.ts');
  const { liveSessions } = await import('../../src/lifecycle.ts');
  const saved = { ...process.env };
  const root = fs.mkdtempSync(join(os.tmpdir(), 'c176-reader-'));
  const copy = join(root, 'current', 'bin', 'library.exe');
  const children: ReturnType<typeof spawn>[] = [];
  try {
    fs.mkdirSync(join(root, 'current', 'bin'), { recursive: true });
    fs.copyFileSync(kernel!, copy);
    for (const key of Object.keys(process.env)) if (/^path$/i.test(key)) delete process.env[key];
    process.env['PATH'] = (saved['PATH'] ?? saved['Path'] ?? '').split(';').filter(p => p && !fs.existsSync(join(p, 'powershell.exe')) && !fs.existsSync(join(p, 'pwsh.exe'))).join(';');
    process.env['DESKPOST_KERNEL'] = copy;
    const rows = () => runInstalledProcess<{ processes: { pid: number; path: string | null }[] }>(['list']).processes;
    const isCopy = (row: { path: string | null }) => row.path?.toLowerCase() === copy.toLowerCase();
    check(!rows().some(isCopy), '1053: source list excludes its installed process reader');
    const quiet = quietCheck();
    check(!quiet.refusal?.includes('process table could not be read'), '1053: quiet check reads the process table');
    const gone = quiet.writers.filter(row => /^library\.exe$/i.test(row.name)).filter(row => {
      try { process.kill(row.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    });
    same(gone, [], '1053: quiet check lists no finished library reader');
    const empty = liveSessions(root);
    same(empty.processes, [], '1053: install sees no process reader session');
    check(!empty.unreadable.some(text => text.includes('process list')), '1053: install reads the process table');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const reader = spawn(copy, ['process', 'wait', String(child.pid)], { stdio: 'ignore', windowsHide: true }); children.push(reader);
    await new Promise<void>((resolve, reject) => { reader.once('spawn', resolve); reader.once('error', reject); });
    check(rows().some(row => row.pid === reader.pid && isCopy(row)), '1053: source list keeps a live installed process');
    check(liveSessions(root).processes.some(row => row.pid === reader.pid), '1053: install keeps a live installed process');
  } finally {
    // Remove only this section's children and copied executable after every child exits.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1060(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w48-1060-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry'), home = join(root, 'home');
  const destination = process.platform === 'win32'
    ? join(root.slice(0, 3), 'dev', 'w48-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', LIBRARY_WORKSPACES: registry };
  const { pathToFileURL } = await import('node:url');
  const actual = pathToFileURL(join(PROGRAM_ROOT, 'kernel/src/librarymove.ts')).href;
  const wrapper = 'data:text/javascript,' + encodeURIComponent(
    'import { runLibraryMoveCommand as actual } from ' + JSON.stringify(actual) + '; ' +
    'export const runLibraryMoveCommand = options => actual({ ...options, processTable: () => [] });');
  const preload = join(root, 'quiet-move.mjs');
  // Stand in for the machine-wide process list only in the scratch command's Node process.
  fs.writeFileSync(preload, 'import { registerHooks } from "node:module";\n' +
    'registerHooks({ resolve(specifier, context, next) { return specifier === "./librarymove.ts" && context.parentURL?.endsWith("/cli.ts") ' +
    '? { url: ' + JSON.stringify(wrapper) + ', shortCircuit: true } : next(specifier, context); } });\n');
  const nodeOptions = '--import=' + pathToFileURL(preload).href;
  const run = (args: string[]) => runCli(['library', 'move', destination, '--workspace', workspace, '--registry-root', registry, ...args], { cwd: root, env: { ...env, NODE_OPTIONS: nodeOptions } });
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name);
    return entry.isDirectory() ? [file + '/', ...snapshot(file)] : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  const preview = (file: string) => {
    const result = run(['--preflight', '--json']);
    check([0, 3].includes(result.exit), '1060: preview succeeds: ' + result.stderr);
    const plan = [0, 3].includes(result.exit) ? JSON.parse(result.stdout) : {};
    equal(result.exit, plan.ready ? 0 : 3, '1060: preview exit agrees with readiness');
    return { plan, pointer: plan.pointers?.find((row: { file: string }) => row.file === file) };
  };
  const refuseMove = (file: string, reason: string, planId: string) => {
    const before = snapshot(workspace);
    const result = run(['--user-confirmed', '--plan-id', planId]);
    check(result.exit !== 0 && result.stderr.includes(file + ': ' + reason), '1060: move refusal names the file and reason: ' + result.stderr);
    check(JSON.stringify(snapshot(workspace)) === JSON.stringify(before), '1060: refused move leaves the Library unchanged');
    check(!fs.existsSync(destination), '1060: refused move leaves the destination absent');
  };
  const residue = 'the old path may be written here in a form the move cannot read; change it by hand, then run the preview again';
  const collision = 'two keys would become one; merge them by hand';
  try {
    fs.mkdirSync(home);
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, '1060: fixture initialized');
    const toml = join(workspace, '.codex/config.toml');
    fs.mkdirSync(join(workspace, '.codex'), { recursive: true });
    const basicPath = JSON.stringify(workspace).slice(1, -2) + '\\u0079';
    for (const [kind, contents] of [['basic', 'path = "' + basicPath + '\n'], ['literal', "path = '" + workspace]] as const) {
      fs.writeFileSync(toml, contents);
      const { plan, pointer } = preview(toml);
      equal(plan.executable, false, '1060: unclosed ' + kind + ' string prevents execution');
      equal(pointer?.reason, residue, '1060: unclosed ' + kind + ' string is listed with its reason');
      equal(fs.readFileSync(toml, 'utf8'), contents, '1060: preview leaves the ' + kind + ' string unchanged');
      if (kind === 'basic' && plan.executable === false) refuseMove(toml, residue, plan.plan_id);
    }
    fs.writeFileSync(toml, 'path = ' + JSON.stringify(workspace) + '\n');
    const closed = preview(toml);
    equal(closed.plan.executable, true, '1060: closed string permits execution');
    equal(closed.pointer?.occurrences, 1, '1060: closed string plans one rewrite');

    const json = join(workspace, '.mcp.json');
    fs.writeFileSync(json, JSON.stringify({ [workspace]: 1, [destination]: 2 }));
    const colliding = preview(json);
    equal(colliding.plan.executable, false, '1060: colliding keys prevent execution');
    equal(colliding.pointer?.reason, collision, '1060: colliding keys are listed with their reason');
    if (colliding.plan.executable === false) refuseMove(json, collision, colliding.plan.plan_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function sectionDefaultRules(section: number): Promise<void> {
  const { matchingDefaultBooks } = await import('../../src/seatdefaults.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w51-default-rules-')));
  const workspace = join(root, 'library');
  const registry = join(root, 'registry');
  const home = join(root, 'home');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry };
  const run = (args: string[]) => runCli(['seat', 'defaults', ...args, '--workspace', workspace, '--json'], { cwd: root, env });
  const rules = join(workspace, '.claude', 'seats', '_book-defaults.json');
  const history = join(workspace, 'internal', 'seat-registry-history.jsonl');
  const add = (department: string) => ['add', '--department', department, '--book', 'shelf/handbook'];
  const plan = (args: string[]) => {
    const result = run([...args, '--preflight']);
    equal(result.exit, 0, 'default rules preview succeeds: ' + result.stderr);
    return JSON.parse(result.stdout);
  };
  const apply = (args: string[], id: string) => run([...args, '--user-confirmed', '--plan-id', id]);
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'scratch Library initialized');
    fs.mkdirSync(join(workspace, 'shelf', 'handbook', 'wiki'), { recursive: true });
    const empty = run([]);
    equal(empty.exit, 0, 'default rules list succeeds');
    equal(JSON.parse(empty.stdout).rules.length, 0, 'no rules at initialization');
    if (section === 1061) {
      const preview = plan(add('games'));
      check(!fs.existsSync(rules) && !fs.existsSync(history), 'preflight publishes neither rules nor history');
      equal(apply(add('games'), preview.plan_id).exit, 0, 'department rule added');
      const group = plan(add('games/sbox'));
      equal(apply(add('games/sbox'), group.plan_id).exit, 0, 'group rule added');
      const matches = matchingDefaultBooks(workspace, { department: 'games/valheim', role: null });
      equal(matches.length, 1, 'parent but not sibling rule matches');
      equal(matches[0]?.source, 'department games', 'parent rule supplies source');
      const removal = ['remove', preview.rule.id];
      equal(apply(removal, plan(removal).plan_id).exit, 0, 'rule removed');
      equal(matchingDefaultBooks(workspace, { department: 'games/valheim', role: null }).length, 0, 'no sibling match remains');
      equal(fs.readFileSync(history, 'utf8').trim().split('\n').length, 6, 'three history attempts committed');
    } else {
      for (const refused of [
        ['add', '--book', 'shelf/handbook'],
        [...add('games'), '--role', 'performer'],
        ['add', '--role', 'unknown', '--book', 'shelf/handbook'],
        add('games/bad/extra'),
        [...add('games'), '--book', 'shelf/missing'],
      ]) {
        check(run([...refused, '--preflight']).exit !== 0, 'invalid default rule is refused');
        check(!fs.existsSync(rules) && !fs.existsSync(history), 'refusal writes neither rules nor history');
      }
      const stale = plan(add('games'));
      const other = add('office');
      equal(apply(other, plan(other).plan_id).exit, 0, 'a concurrent rule was published');
      const snapshot = [fs.readFileSync(rules, 'utf8'), fs.readFileSync(history, 'utf8')];
      check(apply(add('games'), stale.plan_id).exit !== 0, 'stale rule plan refused');
      check(run([...other, '--preflight']).exit !== 0, 'duplicate rule refused');
      equal(fs.readFileSync(rules, 'utf8'), snapshot[0], 'refused actions preserve rules');
      equal(fs.readFileSync(history, 'utf8'), snapshot[1], 'refused actions preserve history');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function sectionDefaultCreation(section: number): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w51-default-creation-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry'), home = join(root, 'home');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry };
  const run = (args: string[]) => runCli([...args, '--workspace', workspace, '--json'], { cwd: root, env });
  const add = (book: string) => {
    fs.mkdirSync(join(workspace, 'shelf', book, 'wiki'), { recursive: true });
    const args = ['seat', 'defaults', 'add', '--department', 'games', '--book', 'shelf/' + book];
    const preview = run([...args, '--preflight']);
    equal(preview.exit, 0, 'rule preview succeeds: ' + preview.stderr);
    const applied = run([...args, '--user-confirmed', '--plan-id', JSON.parse(preview.stdout).plan_id]);
    equal(applied.exit, 0, 'rule applied: ' + applied.stderr);
  };
  const file = (seat: string, name: string) => join(workspace, '.claude', 'seats', seat, name);
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'scratch Library initialized');
    add('handbook');
    if (section === 1063) {
      const start = (seat: string, folder: string, extra: string[] = []) => [
        'seat', 'start', seat, '--project', seat, '--department', 'games/' + folder, '--role', 'orchestrator', '--no-launch', ...extra,
      ];
      const prepare = (args: string[]) => {
        const seat = args[2]!;
        equal(run(['hub', 'new', seat, '--title', seat]).exit, 0, 'Project created');
        const result = run([...args, '--preflight']);
        equal(result.exit, 0, 'seat preview succeeds: ' + result.stderr);
        return JSON.parse(result.stdout);
      };
      const enabled = start('enabled', 'valheim');
      const disabled = start('disabled', 'sbox', ['--no-default-books']);
      const pending = start('pending', 'other');
      const enabledPlan = prepare(enabled);
      check(enabledPlan.open_books.includes('handbook'), 'preview includes the default Book');
      equal(run([...enabled, '--plan-id', enabledPlan.plan_id]).exit, 0, 'seat with default created');
      check(fs.readFileSync(file('enabled', '.open-books'), 'utf8').includes('shelf/handbook'), 'default Book opened');
      const disabledPlan = prepare(disabled);
      equal(run([...disabled, '--plan-id', disabledPlan.plan_id]).exit, 0, 'seat without defaults created');
      equal(fs.readFileSync(file('disabled', '.open-books'), 'utf8').trim(), '', 'no defaults open');
      equal(fs.readFileSync(file('disabled', '.declined-books'), 'utf8').trim(), 'shelf/handbook', 'default recorded declined');
      const pendingPlan = prepare(pending);
      add('new-book');
      check(run([...pending, '--plan-id', pendingPlan.plan_id]).exit !== 0, 'new rule makes the creation preview stale');
      check(!fs.existsSync(file('pending', '.open-books')), 'stale creation opens nothing');
    } else {
      const script = join(root, 'answers.txt');
      fs.writeFileSync(script, ['+', 'Line Project', 'games/valheim', '', 'line-seat', '', 'none', '', ''].join('\n'));
      const line = runCli(['menu', '--script', script, '--width', '200', '--workspace', workspace],
        { cwd: root, env: { ...env, PATH: root } });
      equal(line.exit, 0, 'line wizard completed: ' + line.stderr + line.stdout);
      check(line.stdout.includes('handbook (default: department games)'), 'line wizard labels the default');
      equal(fs.readFileSync(file('line-seat', '.declined-books'), 'utf8').trim(), 'shelf/handbook', 'line wizard persists the decline');

      const bin = join(root, 'bin');
      fs.mkdirSync(bin);
      if (process.platform === 'win32') {
        fs.writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\nexit /b 0\r\n');
      } else {
        fs.writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      const { delimiter } = await import('node:path');
      const { screenWizard } = await import('../../src/menu.ts');
      const saved = { ...process.env };
      try {
        Object.assign(process.env, env, { PATH: [bin, saved.PATH].filter(Boolean).join(delimiter) });
        const replies = ['codex', 'work', 'more', 'department', 'none', 'shelf/handbook', 'done', 'submit', 'make'];
        const labels: string[] = [];
        await screenWizard({
          workspace, options: { cwd: workspace }, claude: true, codex: true, assistant: 'codex',
          talk: {
            scripted: false, say: () => {},
            ask: async () => { throw new Error('Unexpected line prompt'); },
            screen: async (model: any) => {
              const screen = typeof model === 'function' ? model('') : model;
              labels.push(...screen.items.map((item: { text: string }) => item.text));
              const id = replies.shift();
              if (!id) throw new Error(['Unexpected screen ' + screen.title, ...(screen.before ?? [])].join('\n'));
              return id === 'department' ? { id: 'submit', text: 'games/valheim' } : { id, text: '' };
            },
          },
        } as unknown as Parameters<typeof screenWizard>[0], 'wizard-seat');
        equal(replies.length, 0, 'wizard consumed its inputs');
        check(labels.some(label => label === '[x] handbook (default: department games)'), 'wizard labels the preselected default');
        check(labels.some(label => label === '[ ] handbook (default: department games)'), 'unticked default is shown');
        equal(fs.readFileSync(file('wizard-seat', '.declined-books'), 'utf8').trim(), 'shelf/handbook', 'wizard persists the decline');
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function sectionDefaultLaunch(section: number): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w51-default-launch-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry'), home = join(root, 'home');
  const { programRoot } = await import('../../src/programroot.ts');
  const standIn = join(root, 'agent.cjs');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry };
  const run = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: root, env });
  const plan = (args: string[]) => {
    const result = run([...args, '--preflight', '--json']);
    equal(result.exit, 0, 'preview succeeds: ' + result.stderr);
    return JSON.parse(result.stdout).plan_id;
  };
  const add = (book: string) => {
    fs.mkdirSync(join(workspace, 'shelf', book, 'wiki'), { recursive: true });
    const args = ['seat', 'defaults', 'add', '--role', 'orchestrator', '--book', 'shelf/' + book];
    equal(run([...args, '--user-confirmed', '--plan-id', plan(args)]).exit, 0, 'default rule added');
  };
  const launch = (action = '', seat = 'reader') => runCli(['seat', 'start', 'reader', '--workspace', workspace, '--command', process.execPath, '--', standIn, action, seat], { cwd: root, env });
  const desk = (seat: string, file = '.open-books') => fs.readFileSync(join(workspace, '.claude', 'seats', seat, file), 'utf8').trim();
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'scratch Library initialized');
    for (const seat of ['reader', 'other']) {
      equal(run(['hub', 'new', seat, '--title', seat]).exit, 0, 'Project created');
      const args = ['seat', 'start', seat, '--project', seat, '--no-launch',
        ...(seat === 'reader' ? ['--department', 'games/sbox', '--role', 'orchestrator'] : [])];
      equal(run([...args, '--plan-id', plan(args)]).exit, 0, 'seat created before adding any rules');
    }
    fs.writeFileSync(standIn, `const { spawnSync } = require('node:child_process');
const [, , action, seat] = process.argv;
if (action) {
  const ran = spawnSync(process.execPath, [${JSON.stringify(join(programRoot(), 'kernel', 'src', 'cli.ts'))}, 'desk', action, 'book', 'handbook', '--location', 'shelf', '--seat', seat], { stdio: 'inherit' });
  process.exitCode = ran.status ?? 1;
}
`);
    add('handbook');
    if (section === 1065) {
      add('missing-book');
      fs.rmSync(join(workspace, 'shelf', 'missing-book'), { recursive: true });
      const overview = run(['desk', '--seat', 'reader']);
      check(overview.stdout.includes('Default Books not open: handbook, missing-book'), 'desk says which defaults are missing');
      const started = launch();
      equal(started.exit, 0, 'launch continues after a failed open: ' + started.stderr);
      check(started.stderr.includes('Opened default Book handbook (role orchestrator)'), 'launch prints the opened default');
      check(started.stderr.includes('Could not open default Book missing-book'), 'launch prints failed default');
      equal(desk('reader'), 'shelf/handbook', 'launcher opens only the available default');
      const other = launch('open', 'other');
      check(other.exit !== 0, 'the launch claim cannot open Books at another seat');
      equal(desk('other'), '', 'other seat Desk untouched');
    } else {
      equal(launch('close').exit, 0, 'default opened and closed by its seat');
      equal(desk('reader', '.declined-books'), 'shelf/handbook', 'close records the decline');
      equal(desk('reader'), '', 'Book closed');
      const move = ['seat', 'describe', 'reader', '--department', 'games/valheim'];
      equal(run([...move, '--plan-id', plan(move)]).exit, 0, 'seat moved to a sibling department');
      add('new-book');
      equal(launch().exit, 0, 'seat relaunched');
      equal(desk('reader'), 'shelf/new-book', 'new default opens and declined Book stays closed across move');
      equal(launch('open').exit, 0, 'seat manually reopens default');
      equal(desk('reader', '.declined-books'), '', 'reopening clears the decline');
      check(desk('reader').includes('shelf/handbook'), 'handbook is open again');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function sectionDefaultDescribe(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w51-default-describe-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry'), home = join(root, 'home');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry };
  const run = (args: string[]) => {
    const result = runCli([...args, '--workspace', workspace, '--json'], { cwd: root, env });
    equal(result.exit, 0, 'command succeeds: ' + result.stderr);
    return JSON.parse(result.stdout);
  };
  const description = (args: string[]) => run(['seat', 'describe', ...args, '--preflight']);
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'scratch Library initialized');
    for (const name of ['lead', 'crew']) {
      run(['hub', 'new', name, '--title', name]);
      const start = ['seat', 'start', name, '--project', name, '--department', 'games/sbox', '--role', name === 'lead' ? 'orchestrator' : 'performer', '--no-launch'];
      run([...start, '--plan-id', run([...start, '--preflight']).plan_id]);
    }
    const move = ['crew', '--department', 'games/valheim'];
    const handover = ['crew', '--role', 'orchestrator', '--from', 'lead'];
    const beforeMove = description(move);
    const beforeHandover = description(handover);
    fs.mkdirSync(join(workspace, 'shelf', 'handbook', 'wiki'), { recursive: true });
    for (const selector of [['--role', 'orchestrator'], ['--department', 'games/valheim']]) {
      const add = ['seat', 'defaults', 'add', ...selector, '--book', 'shelf/handbook', '--keep'];
      run([...add, '--user-confirmed', '--plan-id', run([...add, '--preflight']).plan_id]);
    }
    const moved = description(move);
    equal(moved.plan_id, beforeMove.plan_id, 'default rules are outside the describe plan id');
    check(moved.default_books[0].includes('crew: default Books at next start: shelf/handbook'), 'move previews default open');
    check(moved.default_books[0].includes('Upkeep grants to add (from local copies): shelf/handbook'), 'move previews keep rule');
    const changed = description(handover);
    equal(changed.plan_id, beforeHandover.plan_id, 'handover approval unchanged');
    check(changed.default_books.some((line: string) => line.startsWith('lead: default Books at next start: none')), 'handover shows outgoing seat');
    check(changed.default_books.some((line: string) => line.startsWith('crew: default Books at next start: shelf/handbook')), 'handover shows incoming seat');
    run(['seat', 'describe', ...handover, '--plan-id', changed.plan_id]);
    for (const seat of ['lead', 'crew']) {
      const dir = join(workspace, '.claude', 'seats', seat);
      equal(fs.readFileSync(join(dir, '.open-books'), 'utf8').trim(), '', 'describe does not open defaults');
      check(!fs.existsSync(join(dir, '.declined-books')), 'describe records no declines');
    }
    check(!fs.existsSync(join(workspace, 'internal', 'shared-upkeep')), 'describe writes no grants');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1068(): Promise<void> {
  await sectionDefaultGrants(1068);
}

async function section1069(): Promise<void> {
  await sectionDefaultGrants(1069);
}

async function sectionDefaultGrants(section: number): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const { McpSession } = await import('../../src/basicmemory.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'w51-default-grants-')));
  const workspace = join(root, 'library'), registry = join(root, 'registry'), storage = join(root, 'server');
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CLAUDE_PID: String(agent.pid),
    LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACES: registry,
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const portFile = join(root, 'port');
  const put = (file: string, body: string) => {
    const full = join(root, file);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
  };
  const answer = (args: string[], more: Record<string, string> = {}) => {
    const result = runCli([...args, '--workspace', workspace, '--json'], { cwd: root, env: { ...env, ...more } });
    equal(result.exit, 0, args.slice(0, 3).join(' ') + ': ' + result.stderr);
    return JSON.parse(result.stdout);
  };
  const gated = (args: string[]) => {
    const preview = answer([...args, '--preflight']);
    return answer([...args, '--user-confirmed', '--plan-id', preview.plan_id]);
  };
  put('server/books/README.md', '# Books\n\n## Open a Book\n');
  put('server/projects/README.md', '# Projects\n\n## Projects\n');
  const server = spawn(process.execPath, [join(HERE, 'fake-basic-memory.ts'), storage, portFile, '--call-log'], { stdio: 'ignore' });
  const libraryId = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
  const noteName = (slug: string) => `server/_deskpost/upkeep/${slug}.md`;
  const read = (file: string) => fs.readFileSync(join(root, file), 'utf8');
  const grants = ['seat', 'defaults', 'grants', '--seat', 'first'];
  const preview = () => answer([...grants, '--preflight']);
  const apply = (id: string, more?: Record<string, string>) => answer([...grants, '--user-confirmed', '--plan-id', id], more);
  const outcome = (value: any, slug: string) => value.books.find((book: { book: string }) => book.book === 'shared/' + slug);
  const make = (slug: string) => gated(['shared', 'new-book', slug, '--title', slug, '--summary', 'Default Books fixture.', '--seat', 'first']);
  const keep = (slug: string) => gated(['seat', 'defaults', 'add', '--role', 'performer', '--book', 'shared/' + slug, '--keep']);
  try {
    const until = Date.now() + 15000;
    while (!fs.existsSync(portFile) || !read('port').trim()) {
      if (Date.now() > until) throw new Error('The fixture Basic Memory server did not start.');
      await sleep(50);
    }
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'scratch Library initialized');
    answer(['hub', 'new', 'alpha', '--title', 'Alpha']);
    const enter = ['seat', 'enter', 'first', '--create', '--project', 'alpha', '--agent-pid', String(agent.pid), '--deadline-seconds', '10'];
    answer([...enter, '--plan-id', answer([...enter, '--preflight']).plan_id]);
    const describe = ['seat', 'describe', 'first', '--role', 'performer', '--department', 'games'];
    answer([...describe, '--plan-id', answer([...describe, '--preflight']).plan_id]);
    const url = 'http://127.0.0.1:' + read('port').trim() + '/mcp';
    const session = new McpSession(url, 'default-books-test');
    await session.initialize();
    put('library/internal/postbox/state.json', JSON.stringify({ schema: 1, url, project_name: 'deskpost',
      project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', library_id: libraryId, library_card: 'Home',
      server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    answer(['basic-memory', 'setup', '--url', url, '--collection', 'stand-in-collection', '--shared-writes', 'on']);
    make('demo');
    keep('demo');
    const historyFile = 'library/internal/seat-registry-history.jsonl';
    if (section === 1068) {
      const retired = '11111111111111111111111111111111';
      const renamed = '22222222222222222222222222222222';
      gated(['shared', 'upkeep', 'demo', '--seats', 'first', '--seat', 'first']);
      put(noteName('demo'), read(noteName('demo')).replace(/^- seat_ids: .*$/m, `- seat_ids: ${retired},${renamed}`).replace(/^- names: .*$/m, '- names: retired,old-name'));
      make('all');
      gated(['shared', 'upkeep', 'all', '--any-seat', '--seat', 'first']);
      keep('all');
      const any = read(noteName('all'));
      put('server/books/old/wiki/_book.md', '# Old Book\n');
      keep('old');
      const savedHistory = read(historyFile);
      const checked = preview();
      equal(outcome(checked, 'demo').missing_seat_ids.length, 1, 'preview proposes only the new live id');
      equal(outcome(checked, 'demo').local_copy, 'stale', 'preview sees stale local copy');
      const result = apply(checked.plan_id);
      equal(outcome(result, 'demo').outcome, 'written', 'additive grant written');
      check(read(noteName('demo')).includes(`- seat_ids: ${retired},${renamed},`) && read(noteName('demo')).includes('- names: retired,old-name,first'), 'existing ids retain their names');
      equal(read(noteName('all')), any, 'any-seat grant unchanged');
      equal(outcome(result, 'old').outcome, 'not written', 'pre-1.6.0 Book cannot gain an upkeep grant');
      const lines = read(historyFile).slice(savedHistory.length).trim().split('\n').map(line => JSON.parse(line));
      equal(lines.length, 2, 'one grant history attempt and commit');
      equal(lines[0].verb, 'seat defaults grants', 'history names grant');
      check(lines[1].attempt === lines[0].attempt && lines[1].committed === true, 'history commit names its attempt');
      equal(outcome(preview(), 'demo').outcome, 'unchanged', 'rerun has nothing to write');
    } else {
      const stale = preview();
      gated(['shared', 'upkeep', 'demo', '--any-seat', '--seat', 'first']);
      const before = read(historyFile);
      equal(outcome(apply(stale.plan_id), 'demo').outcome, 'refused', 'changed remote note refused');
      equal(read(historyFile), before, 'refused grant records no history');
      make('recovery');
      keep('recovery');
      const interrupted = apply(preview().plan_id, { LIBRARY_DEFAULT_GRANTS_FAULT: 'local-copy' });
      check(outcome(interrupted, 'recovery').reason.includes('Local copy publication failed'), 'remote write and local copy failure distinguished');
      check(fs.existsSync(join(root, noteName('recovery'))), 'grant landed remotely');
      put('server/.calls.log', '');
      const refresh = preview();
      equal(outcome(refresh, 'recovery').outcome, 'would refresh local copy', 'rerun detects missing receipt');
      equal(outcome(apply(refresh.plan_id), 'recovery').outcome, 'local copy refreshed', 'rerun repairs the local receipt');
      check(!/bm_write|bm_edit|bm_delete/.test(read('server/.calls.log')), 'refresh does not write remotely');

      make('history-gap');
      keep('history-gap');
      const historyPlan = preview();
      const plannedIds = outcome(historyPlan, 'history-gap').missing_seat_ids;
      const withoutHistory = outcome(apply(historyPlan.plan_id, { LIBRARY_DEFAULT_GRANTS_FAULT: 'history' }), 'history-gap');
      equal(withoutHistory.outcome, 'written', 'confirmed grant stays written after history failure');
      equal(withoutHistory.reason, 'Remote grant written. History not recorded: Fixture interruption before history append.', 'reported failure names history');
      equal(plannedIds.length, 1, 'one seat receives the grant');
      check(read(noteName('history-gap')).includes('- seat_ids: ' + plannedIds[0]), 'remote grant contains the previewed seat ID');
      equal(outcome(preview(), 'history-gap').outcome, 'unchanged', 'local receipt was published despite the history failure');
    }
  } finally {
    server.kill();
    agent.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1074(kind = 'order'): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const { spawn } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-aside-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const timing of kind === 'cancel' ? ['before-rename', 'barrier', 'copy', 'rewrite', 'copy-verify', 'before-stat', 'promote'] : ['copy']) {
      const folder = join(root, timing), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: timing }));
      fs.writeFileSync(join(workspace, 'payload.txt'), 'original');
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: timing, path: workspace }] }));
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const preview = await move.previewLibraryMove(options); equal(preview.refusal, null, '1074: fixture preview');
      if (kind === 'held') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, windowsHide: true, stdio: 'ignore' });
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        try {
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          const held = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id });
          equal((held.value as any)?.state, 'held', '1074: a real Windows working-folder hold is met before copying');
          equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original', '1074: held source bytes are unchanged');
          check(!fs.readdirSync(folder).some(name => name.startsWith('target') || name.startsWith('source.moved-')), '1074: held rename leaves no copied files or aside');
        } finally { child.kill(); await exited; }
      }
      let cancelled = false, copiedAside = false, changed = false;
      const result = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id,
        control: { cancelled: () => cancelled, progress: event => {
          if (event.phase === 'copy') {
            copiedAside = !fs.existsSync(workspace) && fs.readdirSync(folder).some(name => name.startsWith('source.moved-'));
            if (kind === 'drift' && !changed) {
              const aside = join(folder, fs.readdirSync(folder).find(name => name.startsWith('source.moved-')) ?? 'source');
              fs.appendFileSync(join(aside, 'payload.txt'), ' retained write'); changed = true;
            }
          }
          if (kind === 'stat-drift' && event.phase === 'before-stat') {
            const aside = join(folder, fs.readdirSync(folder).find(name => name.startsWith('source.moved-'))!);
            fs.appendFileSync(join(aside, 'payload.txt'), ' retained write');
          }
          if (kind === 'cancel' && event.phase === timing) cancelled = true;
        } } });
      if (kind === 'order' || kind === 'held') {
        equal(result.refusal, null, '1074: new move completes: ' + result.refusal);
        check(copiedAside, '1074: source is set aside before the first copied file');
        if (result.value) {
          const journal = JSON.parse(fs.readFileSync(join((result.value as any).journal, 'journal.json'), 'utf8'));
          equal(journal.order, 'aside-first', '1074: new journals explicitly record their order');
          check(typeof journal.sourceIdentity === 'string' && journal.sourceIdentity.length > 0, '1074: journal binds the source folder identity');
        }
      } else if (kind === 'cancel') {
        if (timing === 'promote') { equal(result.refusal, null, '1075: cancellation from promotion finishes safely'); check(fs.existsSync(destination), '1075: post-promotion destination remains'); }
        else {
          equal((result as any).exitCode, 130, '1075: pre-promotion cancellation exit at ' + timing);
          equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original', '1075: cancelled source restored at ' + timing);
          check(!fs.existsSync(destination), '1075: no promoted destination after cancellation at ' + timing);
          check(!fs.existsSync(join(workspace, 'internal/maintenance-barrier.json')), '1075: source barrier removed at ' + timing);
        }
      } else {
        check(result.refusal?.includes('payload.txt') === true, '1076: changed source is named');
        equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original retained write', '1076: abort restores the changed source bytes');
        check(!fs.existsSync(destination), '1076: drift prevents promotion');
      }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function section1075(): Promise<void> {
  await section1074('cancel');
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-abort-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const variant of ['aside', 'restored', 'identity', 'occupied', 'link', 'foreign']) {
      const folder = join(root, variant), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: variant }));
      fs.writeFileSync(join(workspace, 'payload.txt'), 'original');
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: variant, path: workspace }] }));
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const preview = await move.previewLibraryMove(options); let cancelled = false;
      const failed = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id,
        faultAt: variant === 'restored' ? 'abort-source:after-done' : 'abort-intent:after-done',
        control: { cancelled: () => cancelled, progress: event => { if (event.phase === 'copy') cancelled = true; } } });
      check(failed.refusal?.includes('Injected move fault') === true, '1075: interrupted abort: ' + variant);
      const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      const journalFile = join(registryRoot, 'move-journals', id, 'journal.json');
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      equal(journal.state, 'abort-intent', '1075: crash retains abort intent');
      const actual = fs.existsSync(journal.aside) ? journal.aside : workspace;
      fs.appendFileSync(join(actual, 'payload.txt'), ' after crash');
      if (variant === 'identity' || variant === 'link') {
        fs.renameSync(actual, actual + '.saved');
        if (variant === 'link') fs.symlinkSync(actual + '.saved', actual, process.platform === 'win32' ? 'junction' : 'dir');
        else fs.mkdirSync(actual);
      }
      if (variant === 'occupied') { fs.mkdirSync(workspace); fs.writeFileSync(join(workspace, 'keep'), 'foreign bytes'); }
      if (variant === 'foreign') fs.writeFileSync(join(actual, 'internal/maintenance-barrier.json'), JSON.stringify({ run_id: 'foreign' }));
      const recovery = await move.moveLibrary({ ...options, rollback: id, destination: undefined, preflight: true });
      if (['identity', 'occupied', 'link', 'foreign'].includes(variant)) {
        check(recovery.refusal !== null || (recovery.value as any)?.ready === false, '1075: unsafe restoration is refused: ' + variant);
        check(!fs.existsSync(destination), '1075: unsafe restoration never promotes a copy');
        if (variant === 'occupied') equal(fs.readFileSync(join(workspace, 'keep'), 'utf8'), 'foreign bytes', '1075: occupied source is untouched');
      } else {
        equal(recovery.refusal, null, '1075: interrupted abort can be previewed');
        const restored = await move.moveLibrary({ ...options, rollback: id, destination: undefined, preflight: false, userConfirmed: true, planId: (recovery.value as any)?.plan_id });
        equal(restored.refusal, null, '1075: interrupted abort completes: ' + variant + ': ' + restored.refusal);
        equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original after crash', '1075: interrupted abort preserves later source bytes');
        equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'aborted', '1075: completed abort is recorded');
      }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }

}
async function section1076(): Promise<void> {
  await section1074('drift');
  await section1074('stat-drift');
  const move = await import('../../src/librarymove.ts'), { spawn, spawnSync } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-retained-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const phase of ['copy', 'before-stat']) {
      const folder = join(root, phase), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: phase }));
      const file = join(workspace, 'payload.txt'); fs.writeFileSync(file, 'original');
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: phase, path: workspace }] }));
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const preview = await move.previewLibraryMove(options);
      const ready = join(folder, 'ready'), trigger = join(folder, 'trigger'), done = join(folder, 'done'), script = join(folder, 'writer.mjs'), waiter = join(folder, 'waiter.mjs');
      const nativeWriter = `const {dlopen,FFIType:t,ptr}=await import('bun:ffi'); const api=dlopen('kernel32.dll',{CreateFileW:{args:[t.ptr,t.u32,t.u32,t.ptr,t.u32,t.u32,t.i64_fast],returns:t.i64_fast},WriteFile:{args:[t.i64_fast,t.ptr,t.u32,t.ptr,t.ptr],returns:t.i32},FlushFileBuffers:{args:[t.i64_fast],returns:t.i32}}).symbols; const name=Buffer.from(${JSON.stringify(file)}+'\0','utf16le'); const handle=api.CreateFileW(ptr(name),4,7,null,3,128,0); if(handle===-1)throw new Error('retained writer open failed'); const append=()=>{const bytes=Buffer.from(' retained write'),written=new Uint32Array(1);if(!api.WriteFile(handle,ptr(bytes),bytes.length,ptr(written),null))throw new Error('retained write failed');api.FlushFileBuffers(handle);};`;
      fs.writeFileSync(script, `import fs from 'node:fs'; ${process.platform === 'win32' ? nativeWriter : `const fd=fs.openSync(${JSON.stringify(file)},'a'); const append=()=>{fs.writeSync(fd,' retained write');fs.fsyncSync(fd);};`} fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(poll);append();fs.writeFileSync(${JSON.stringify(done)},'done');}},10); setInterval(()=>{},1000);`);
      fs.writeFileSync(waiter, `import fs from 'node:fs'; const until=Date.now()+15000; while(!fs.existsSync(${JSON.stringify(done)}) && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); process.exit(fs.existsSync(${JSON.stringify(done)})?0:1);`);
      const child = spawn(process.platform === 'win32' ? 'bun' : process.execPath, [script], { cwd: folder, windowsHide: true, stdio: 'ignore' });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        check(fs.existsSync(ready), '1076: real retained-handle writer is ready');
        let written = false;
        const result = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id,
          control: { cancelled: () => false, progress: event => {
            if (!written && event.phase === phase && (phase !== 'copy' || event.file)) {
              written = true; fs.writeFileSync(trigger, 'write');
              equal(spawnSync(process.execPath, [waiter], { windowsHide: true, timeout: 20000 }).status, 0, '1076: retained child appended at ' + phase);
            }
          } } });
        if (process.platform === 'win32' && (result.value as any)?.state === 'held') {
          console.log('1076: Windows denied the folder rename with a FILE_SHARE_DELETE writer; retained-writer append proof is incomplete on this route. Linux must prove it.');
          equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original', '1076: Windows held rename preserves the source');
          check(!written, '1076: Windows hold prevents the copy checkpoint');
        } else {
          check(result.refusal?.includes('payload.txt') === true, '1076: retained writer names the changed file at ' + phase + ': ' + JSON.stringify(result));
          equal(fs.readFileSync(join(workspace, 'payload.txt'), 'utf8'), 'original retained write', '1076: retained child bytes survive restoration at ' + phase);
        }
        check(!fs.existsSync(destination), '1076: retained writer prevents promotion at ' + phase);
      } finally { child.kill(); await exited; }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }

}

async function section1077(drift = false): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-orders-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  let serial = 0;
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const legacyOrder of [true, false]) for (const point of drift ? ['promote:before-done', 'registry:after-done', 'complete'] : ['barrier:before-done', 'copy-file:before-done', 'promote:before-done', 'cutover:after-done', 'pointer-0:before-done', 'registry:after-done']) for (const recovery of ['rollback', 'resume'] as const) {
      if (legacyOrder && point === 'promote:before-done' && (drift || recovery === 'resume')) continue;
      if (recovery === 'resume' && ['barrier:before-done', 'copy-file:before-done'].includes(point)) continue;
      const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'orders' }));
      fs.writeFileSync(join(workspace, 'payload.txt'), 'original');
      const registry = join(registryRoot, 'workspaces.json'), registryBefore = JSON.stringify({ workspaces: [{ id: 'orders', path: workspace }] });
      fs.writeFileSync(registry, registryBefore);
      const pointer = join(root, 'home/.claude.json'); fs.mkdirSync(join(pointer, '..'), { recursive: true }); fs.writeFileSync(pointer, JSON.stringify({ path: workspace }));
      const options = { workspace, destination, registryRoot, legacyOrder, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const preview = await move.previewLibraryMove(options);
      let appended = false;
      const stopped = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id, faultAt: point === 'complete' ? undefined : point,
        control: { cancelled: () => false, progress: event => {
          if (drift && !legacyOrder && event.phase === 'promote' && !appended) {
            const aside = join(folder, fs.readdirSync(folder).find(name => name.startsWith('source.moved-'))!);
            fs.appendFileSync(join(aside, 'payload.txt'), ' late'); appended = true;
          }
        } } });
      const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      const journalFile = join(registryRoot, 'move-journals', id, 'journal.json'), journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      if (drift && legacyOrder) fs.appendFileSync(join(fs.existsSync(journal.aside) ? journal.aside : workspace, 'payload.txt'), ' late');
      if (point === 'complete' && !legacyOrder) {
        equal(stopped.refusal, null, '1078: a late old-folder write does not strand completion: ' + stopped.refusal);
        check(journal.aside_drift?.includes('payload.txt'), '1078: completed journal records late drift');
      }
      const recoverPreview = await move.moveLibrary({ ...options, destination: undefined, [recovery]: id, preflight: true });
      if (drift && legacyOrder) {
        check(recoverPreview.refusal?.includes('payload.txt') === true, '1078: legacy recovery keeps strict source drift refusal');
        continue;
      }
      equal(recoverPreview.refusal, null, '1077: recovery preview ' + point + ': ' + recoverPreview.refusal);
      const result = await move.moveLibrary({ ...options, destination: undefined, [recovery]: id, preflight: false, userConfirmed: true, planId: (recoverPreview.value as any)?.plan_id });
      equal(result.refusal, null, '1077: ' + recovery + ' ' + point + ' legacy=' + legacyOrder + ': ' + result.refusal);
      if (result.refusal) continue;
      const active = recovery === 'rollback' ? workspace : destination;
      equal(fs.readFileSync(join(active, 'payload.txt'), 'utf8'), 'original' + (drift && recovery === 'rollback' ? ' late' : ''), '1077: correct active bytes survive recovery');
      if (recovery === 'rollback') equal(fs.readFileSync(registry, 'utf8'), registryBefore, '1077: exact original registry restored');
      else equal(JSON.parse(fs.readFileSync(registry, 'utf8')).workspaces[0].path, destination, '1077: resumed registry names destination');
      if (drift) check(JSON.parse(fs.readFileSync(journalFile, 'utf8')).aside_drift?.includes('payload.txt'), '1078: recovery records old-folder drift');
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function section1078(): Promise<void> {
  await section1077(true);
}

async function section1079(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const resolve = (move as any).resolveMoveWorkspace;
  check(typeof resolve === 'function', '1079: move-specific resolution exists'); if (!resolve) return;
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-resolution-'))), registryRoot = join(root, 'registry');
  const previous = process.cwd();
  try {
    process.chdir(root); fs.mkdirSync(registryRoot);
    const options = { destination: join(root, 'destination'), registryRoot, preflight: true };
    const registry = join(registryRoot, 'workspaces.json');
    let refused = '';
    try { await resolve(options); } catch (error) { refused = (error as Error).message; }
    check(refused.includes('No Library marker'), '1079: absent registry and no marker refuse');
    const first = join(root, 'first'), second = join(root, 'second');
    for (const folder of [first, second]) { fs.mkdirSync(join(folder, '.library'), { recursive: true }); fs.mkdirSync(join(folder, 'internal')); fs.writeFileSync(join(folder, '.library/workspace.json'), JSON.stringify({ id: folder })); }
    fs.writeFileSync(registry, JSON.stringify({ workspaces: [{ path: first, id: first }] }));
    equal(await resolve(options), first, '1079: one registered Library is found outside any Library');
    fs.writeFileSync(registry, '{'); process.chdir(second);
    equal(await resolve(options), second, '1079: nearest marker wins before reading a malformed registry');
    equal(await resolve({ ...options, workspace: first }), first, '1079: explicit workspace overrides the nearest marker');
    process.chdir(root);
    try { await resolve(options); } catch (error) { refused = (error as Error).message; }
    check(refused.includes('JSON'), '1079: malformed registry is an honest refusal');
    fs.writeFileSync(registry, JSON.stringify({ workspaces: [{ path: first, id: first }, { path: second, id: second }] }));
    const before = fs.readFileSync(registry, 'utf8');
    try { await resolve({ ...options, chooseWorkspace: null }); } catch (error) { refused = (error as Error).message; }
    check(refused.includes(first) && refused.includes(second) && refused.includes('--workspace'), '1079: plain multi-Library refusal lists both ready commands');
    let asked = 0;
    equal(await resolve({ ...options, chooseWorkspace: async (choices: string[]) => { asked++; same(choices, [first, second], '1079: picker receives every registration'); return second; } }), second, '1079: terminal choice selects the requested source');
    equal(asked, 1, '1079: source selection asks once');
    try { await resolve({ ...options, chooseWorkspace: async () => join(root, 'not-registered') }); } catch (error) { refused = (error as Error).message; }
    check(refused.includes('not registered') && refused.includes('--workspace'), '1079: an unregistered picker result is refused');
    equal(fs.readFileSync(registry, 'utf8'), before, '1079: resolution leaves registry bytes unchanged');
  } finally { process.chdir(previous); fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1080(): Promise<void> {
  const moduleFile = join(PROGRAM_ROOT, 'kernel/src/librarymovescreen.ts');
  check(fs.existsSync(moduleFile), '1080: move session controller exists'); if (!fs.existsSync(moduleFile)) return;
  const { MoveSession } = await import('../../src/librarymovescreen.ts'), { EventEmitter } = await import('node:events');
  for (const action of ['success', 'waiting', 'escape', 'cancel', 'interrupt', 'moving', 'promoted', 'error', 'end', 'stale']) {
    const input = new EventEmitter() as any, output = new EventEmitter() as any;
    const modes: boolean[] = []; let transcript = '', applied = 0, ready = 0, checks = 0;
    input.isRaw = false; input.setRawMode = (raw: boolean) => { modes.push(raw); input.isRaw = raw; }; input.resume = () => {}; input.pause = () => {};
    output.columns = 80; output.rows = 24;
    output.write = (text: string) => {
      transcript += text;
      if (/Moved\.|Cancelled\.|The Library could not be moved/.test(text)) setImmediate(() => input.emit('data', '\r'));
      if (text.includes('Ready.')) {
        ready++;
        setImmediate(() => {
          if (action === 'escape') input.emit('data', '\x1b');
          else if (action === 'interrupt') input.emit('data', '\x03');
          else if (action === 'cancel') input.emit('data', '\x1b[B\r');
          else if (action === 'end') input.emit('end');
          else input.emit('data', '\r');
        });
      }
    };
    const session = new MoveSession({ check: async () => {
      checks++;
      if (action === 'waiting' && checks === 1) return { refusal: null, value: { ready: false, plan_id: 'one', blockers: [{ kind: 'process', name: 'Editor', detail: 'still open', fix: 'Close it.' }] } };
      return { refusal: null, value: { ready: true, plan_id: action === 'stale' && checks > 1 ? 'changed' : 'one', workspace: '/source', destination: '/target', blockers: [] } };
    }, apply: async (_id, control) => {
      applied++; equal(input.listenerCount('data'), 1, '1080: one input listener through apply');
      if (action === 'error') throw new Error('fixture engine failed');
      for (const phase of ['barrier', 'copy', 'rewrite', 'copy-verify', 'before-stat', 'promote', 'registry']) {
        control.progress({ phase });
        if (action === 'moving' && phase === 'copy') input.emit('data', '\x03');
        if (action === 'promoted' && phase === 'promote') { input.emit('data', '\x03'); input.emit('data', '\x03'); }
        equal(input.listenerCount('data'), 1, '1080: no input gap at ' + phase);
        if (control.cancelled() && phase !== 'promote' && action !== 'promoted') return { refusal: null, value: { state: 'aborted', written: false }, exitCode: 130 };
        await new Promise(resolve => setImmediate(resolve));
      }
      return { refusal: null, value: { workspace: '/target', things_for_you: [] } };
    } }, { terminal: { input, output }, colour: false, refreshMilliseconds: 1 });
    let result: any, failure = '';
    try { result = await session.run(); } catch (error) { failure = (error as Error).message; }
    same(modes, [true, false], '1080: raw mode restored: ' + action);
    equal(input.listenerCount('data'), 0, '1080: input listener removed: ' + action);
    check(transcript.includes('\x1b[?25h') && !input.isRaw, '1080: terminal restored: ' + action);
    if (['escape', 'cancel', 'interrupt', 'end'].includes(action)) { equal(applied, 0, '1080: cancellation before write: ' + action); equal(result?.exitCode, 130, '1080: cancellation exit: ' + action); }
    if (action === 'moving') equal(result?.exitCode, 130, '1080: live cancellation reaches engine');
    if (action === 'promoted') check(transcript.includes('Almost done; this cannot stop safely now'), '1080: repeated post-promotion interrupt is acknowledged');
    if (action === 'error') equal(failure, 'fixture engine failed', '1080: thrown engine error is restored and returned');
    if (action === 'stale') check(checks >= 3 && ready >= 2 && applied === 1, '1080: changed confirmation returns to checking before applying');
    if (action === 'waiting') check(checks >= 3 && applied === 1 && transcript.includes('Editor'), '1080: waiting blockers refresh and the same controller reaches ready');
  }
}

async function section1088(linux = false, scenario: 'cancel-copy' | 'pick-move' | 'pick-escape' | 'resume' = 'cancel-copy'): Promise<void> {
  const section = scenario === 'pick-move' ? 1093 : scenario === 'pick-escape' ? 1094 : scenario === 'resume' ? 1095 : linux ? 1089 : 1088;
  const { spawnSync } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-terminal-')));
  const workspace = join(root, 'source'), destination = join(root, 'target'), registryRoot = join(root, 'registry');
  try {
    fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'terminal' }));
    fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'terminal', path: workspace }] }));
    for (let index = 0; index < 96; index++) fs.writeFileSync(join(workspace, 'payload-' + index + '.bin'), Buffer.alloc(1024 * 1024, 73));
    const second = join(root, 'second'), home = join(root, 'home');
    const { createHash } = await import('node:crypto');
    const snapshot = (directory: string): string => {
      if (!fs.existsSync(directory)) return 'absent';
      return JSON.stringify(fs.readdirSync(directory, { recursive: true }).map(String).sort().map(name => {
        const file = join(directory, name), stat = fs.lstatSync(file);
        return [name, stat.isDirectory() ? 'directory' : createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
      }));
    };
    if (scenario.startsWith('pick-')) {
      fs.mkdirSync(join(second, '.library'), { recursive: true }); fs.mkdirSync(join(second, 'internal'));
      fs.writeFileSync(join(second, '.library/workspace.json'), JSON.stringify({ id: 'chosen' })); fs.writeFileSync(join(second, 'chosen.txt'), 'chosen Library bytes');
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'terminal', path: workspace }, { id: 'chosen', path: second }] }));
    }
    const before = [workspace, second, registryRoot, home].map(snapshot);
    const driver = join(root, 'driver.ts'), resultFile = join(root, 'result.json'), transcript = join(root, 'transcript.log'), host = join(root, 'host.py'), config = join(root, 'host.json');
    const importPath = (name: string) => linux ? pathToFileURL(join(PROGRAM_ROOT, 'kernel/src', name)).href : join(PROGRAM_ROOT, 'kernel/src', name);
    const modeReader = `let consoleApi=null;if(process.platform==='win32'){const {dlopen,FFIType:t}=await import('bun:ffi');consoleApi=dlopen('kernel32.dll',{GetStdHandle:{args:[t.i32],returns:t.i64_fast},GetConsoleMode:{args:[t.i64_fast,t.ptr],returns:t.i32}}).symbols;}const modes=()=>{if(!consoleApi)return null;return [-10,-11].map(which=>{const mode=new Uint32Array(1);if(!consoleApi.GetConsoleMode(consoleApi.GetStdHandle(which),mode))throw new Error('console mode unreadable');return mode[0];}).join(',');};`;
    const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' };
    fs.writeFileSync(driver, `import fs from 'node:fs';import {MoveSession} from ${JSON.stringify(importPath('librarymovescreen.ts'))};import {moveLibrary} from ${JSON.stringify(importPath('librarymove.ts'))};${modeReader}const before=modes();const options=${JSON.stringify(options)};options.processTable=()=>[];const raw=process.stdin.isRaw??false;const session=new MoveSession({check:()=>moveLibrary({...options,preflight:true}),apply:(planId,control)=>moveLibrary({...options,preflight:false,userConfirmed:true,planId,control})},{colour:false});const reply=await session.run();fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({reply,raw_before:raw,raw_after:process.stdin.isRaw,tty:process.stdin.isTTY,modes_before:before,modes_after:modes()}));console.log('SMOKE_RESTORED');`);
    if (scenario !== 'cancel-copy') {
      // Real command, picker, controller and engine. Only process observations are isolated.
      const commandOptions = { destination, registryRoot, preflight: false, destinationRule: 'any' };
      const setupResume = `const plan=await moveLibrary({...options,workspace:${JSON.stringify(workspace)},preflight:true});const stopped=await moveLibrary({...options,workspace:${JSON.stringify(workspace)},preflight:false,userConfirmed:true,planId:plan.value.plan_id,faultAt:'registry:after-done'});if(!stopped.refusal?.includes('Injected move fault'))throw new Error('resume setup did not stop');options.resume=fs.readdirSync(${JSON.stringify(join(registryRoot, 'move-journals'))}).find(name=>name.startsWith('move-'));delete options.destination;`;
      fs.writeFileSync(driver, `import fs from 'node:fs';import {runLibraryMoveCommand,moveLibrary} from ${JSON.stringify(importPath('librarymove.ts'))};${modeReader}const before=modes();const raw=process.stdin.isRaw??false;let adds=0,max=0,checks=0;process.stdin.on('newListener',event=>{if(event==='data'){adds++;max=Math.max(max,process.stdin.listenerCount('data')+1);}});const options=${JSON.stringify(commandOptions)};options.processTable=()=>${scenario === 'pick-move' ? "++checks<=2?[{pid:990099,parentPid:0,name:'orca'}]:[]" : '[]'};${scenario === 'resume' ? setupResume : ''}const reply=await runLibraryMoveCommand(options);fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({reply,raw_before:raw,raw_after:process.stdin.isRaw??false,tty:process.stdin.isTTY,modes_before:before,modes_after:modes(),data_adds:adds,max_listeners:max,listeners_after:process.stdin.listenerCount('data'),checks}));console.log('SMOKE_RESTORED');process.exitCode=reply.exitCode??(reply.refusal?1:0);`);
    }
    let command: string[];
    if (linux) command = [process.execPath, driver];
    else {
      const executable = join(root, 'deskpost.exe');
      const built = spawnSync('bun', ['build', '--compile', driver, '--outfile', executable], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      equal(built.status, 0, section + ': compiled real-engine terminal fixture: ' + built.stderr); if (built.status !== 0) return;
      command = [executable];
    }
    // Fixture host follows Microsoft's pseudoconsole startup and redirected-handle guidance.
    // https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
    // https://github.com/microsoft/terminal/discussions/15814
    fs.writeFileSync(host, "import ctypes, json, os, subprocess, sys, threading, time\n\ncfg = json.load(open(sys.argv[1], encoding='utf-8'))\nos.environ.update(cfg.get('env', {}))\ncaptured = bytearray()\nsent_enter = sent_escape = sent_receipt = picked = False\n\ndef drive(chunk, send):\n    global sent_enter, sent_escape, sent_receipt, picked\n    captured.extend(chunk)\n    scenario = cfg.get('scenario', 'cancel-copy')\n    if scenario.startswith('pick-') and not picked and b'Which Library do you want to move?' in captured:\n        picked = True\n        if scenario == 'pick-escape':\n            send(b'\\x1b'); sent_escape = True\n        else:\n            send(b'\\x1b[B\\r')\n    if not sent_enter and b'Ready.' in captured:\n        send(b'\\r'); sent_enter = True\n    trigger = b'Moving the Library' if scenario == 'resume' else b'Step 2 of 4: copying files'\n    if scenario in ('cancel-copy', 'resume') and sent_enter and not sent_escape and trigger in captured:\n        send(b'\\x1b'); sent_escape = True\n    if (sent_enter or sent_escape) and not sent_receipt and (b'Cancelled.' in captured or b'Moved.' in captured or b'The Library could not be moved' in captured):\n        send(b'\\r'); sent_receipt = True\n\nif os.name == 'nt':\n    from ctypes import wintypes as w\n    k = ctypes.WinDLL('kernel32', use_last_error=True)\n    class COORD(ctypes.Structure):\n        _fields_ = [('X', ctypes.c_short), ('Y', ctypes.c_short)]\n    class STARTUPINFO(ctypes.Structure):\n        _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR), ('lpTitle', w.LPWSTR), ('dwX', w.DWORD), ('dwY', w.DWORD), ('dwXSize', w.DWORD), ('dwYSize', w.DWORD), ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD), ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD), ('lpReserved2', ctypes.c_void_p), ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE), ('hStdError', w.HANDLE)]\n    class STARTUPINFOEX(ctypes.Structure):\n        _fields_ = [('StartupInfo', STARTUPINFO), ('lpAttributeList', ctypes.c_void_p)]\n    class PROCESSINFO(ctypes.Structure):\n        _fields_ = [('hProcess', w.HANDLE), ('hThread', w.HANDLE), ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD)]\n    signatures = {\n        'CreatePipe': ([ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD], w.BOOL),\n        'CreatePseudoConsole': ([COORD, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)], ctypes.c_long),\n        'ClosePseudoConsole': ([w.HANDLE], None),\n        'CloseHandle': ([w.HANDLE], w.BOOL),\n        'InitializeProcThreadAttributeList': ([ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)], w.BOOL),\n        'UpdateProcThreadAttribute': ([ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p], w.BOOL),\n        'DeleteProcThreadAttributeList': ([ctypes.c_void_p], None),\n        'CreateProcessW': ([w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(PROCESSINFO)], w.BOOL),\n        'ReadFile': ([w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p], w.BOOL),\n        'WriteFile': ([w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p], w.BOOL),\n        'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),\n        'GetExitCodeProcess': ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),\n        'TerminateProcess': ([w.HANDLE, w.UINT], w.BOOL),\n    }\n    for name, (args, result) in signatures.items():\n        getattr(k, name).argtypes = args; getattr(k, name).restype = result\n    def require(ok):\n        if not ok: raise ctypes.WinError(ctypes.get_last_error())\n    ir, iw, or_, ow, console = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()\n    require(k.CreatePipe(ctypes.byref(ir), ctypes.byref(iw), None, 0)); require(k.CreatePipe(ctypes.byref(or_), ctypes.byref(ow), None, 0))\n    status = k.CreatePseudoConsole(COORD(80, 24), ir, ow, 0, ctypes.byref(console))\n    if status: raise RuntimeError('CreatePseudoConsole HRESULT ' + str(status))\n    size = ctypes.c_size_t(); k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))\n    attributes = ctypes.create_string_buffer(size.value)\n    require(k.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)))\n    require(k.UpdateProcThreadAttribute(attributes, 0, 0x20016, console, ctypes.sizeof(w.HANDLE), None, None))\n    startup = STARTUPINFOEX(); startup.StartupInfo.cb = ctypes.sizeof(startup); startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)\n    # Null standard handles plus STARTF_USESTDHANDLES prevent inheriting the host's redirected pipes.\n    # https://github.com/microsoft/terminal/discussions/15814\n    startup.StartupInfo.dwFlags = 0x100\n    info = PROCESSINFO(); command = ctypes.create_unicode_buffer(subprocess.list2cmdline(cfg['command']))\n    require(k.CreateProcessW(None, command, None, None, False, 0x80000 | 0x400, None, cfg['cwd'], ctypes.byref(startup), ctypes.byref(info)))\n    k.CloseHandle(ir); k.CloseHandle(ow)\n    k.CloseHandle(info.hThread)\n    def send(data):\n        count = w.DWORD(); require(k.WriteFile(iw, data, len(data), ctypes.byref(count), None))\n    errors = []\n    def read_output():\n        try:\n            buffer = ctypes.create_string_buffer(65536); count = w.DWORD()\n            while k.ReadFile(or_, buffer, len(buffer), ctypes.byref(count), None) and count.value:\n                drive(buffer.raw[:count.value], send)\n        except Exception as error: errors.append(str(error))\n    reader = threading.Thread(target=read_output, daemon=True); reader.start()\n    if k.WaitForSingleObject(info.hProcess, 60000) == 258:\n        k.TerminateProcess(info.hProcess, 1); k.WaitForSingleObject(info.hProcess, 10000); open(cfg['transcript'], 'wb').write(captured); raise RuntimeError('terminal smoke deadline')\n    code = w.DWORD(); require(k.GetExitCodeProcess(info.hProcess, ctypes.byref(code)))\n    k.ClosePseudoConsole(console); k.CloseHandle(iw); reader.join(5); k.CloseHandle(or_); k.CloseHandle(info.hProcess); k.DeleteProcThreadAttributeList(attributes)\n    if errors: raise RuntimeError('; '.join(errors))\n    child_exit = code.value\nelse:\n    import fcntl, pty, select, struct, termios\n    master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))\n    before = termios.tcgetattr(slave)\n    child = subprocess.Popen(cfg['command'], cwd=cfg['cwd'], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)\n    deadline = time.monotonic() + 60\n    try:\n        while time.monotonic() < deadline:\n            ready, _, _ = select.select([master], [], [], 0.05)\n            if ready:\n                try: chunk = os.read(master, 65536)\n                except OSError: break\n                if not chunk: break\n                drive(chunk, lambda data: os.write(master, data))\n            if child.poll() is not None: break\n        if child.poll() is None: child.kill(); child.wait(); open(cfg['transcript'], 'wb').write(captured); raise RuntimeError('terminal smoke deadline')\n        child_exit = child.returncode\n        cfg['host_modes_restored'] = before == termios.tcgetattr(slave)\n    finally:\n        if child.poll() is None: child.kill(); child.wait()\n        os.close(master); os.close(slave)\n\nopen(cfg['transcript'], 'wb').write(captured)\nprint(json.dumps({'child_exit': child_exit, 'entered': sent_enter, 'cancelled': sent_escape, 'host_modes_restored': cfg.get('host_modes_restored')}))\nscenario = cfg.get('scenario', 'cancel-copy')\nvalid = child_exit == (130 if scenario == 'pick-escape' else 0) and (sent_escape if scenario == 'pick-escape' else sent_enter and (scenario == 'pick-move' or sent_escape))\nsys.exit(0 if valid else 1)\n");
    const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home'), LOCALAPPDATA: join(root, 'home'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' };
    fs.writeFileSync(config, JSON.stringify({ command, cwd: root, transcript, env, scenario }));
    const result = spawnSync(linux ? 'python3' : 'python', ['-I', host, config], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 75000 });
    const evidence = process.env['DESKPOST_MOVE_TERMINAL_EVIDENCE'];
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      for (const file of [transcript, resultFile, config, driver, host]) if (fs.existsSync(file)) fs.copyFileSync(file, join(evidence, section + '-' + file.split(/[\\/]/).pop()));
    }
    equal(result.status, 0, section + ': real terminal Enter and Esc: ' + result.stdout + result.stderr); if (result.status !== 0 || !fs.existsSync(resultFile)) return;
    const reply = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (scenario !== 'cancel-copy') {
      const text = fs.readFileSync(transcript, 'utf8');
      equal(reply.max_listeners, 1, section + ': picker and controller never overlap input ownership');
      equal(reply.data_adds, scenario === 'pick-escape' || scenario === 'resume' ? 1 : 2, section + ': one question then one controller');
      equal(reply.listeners_after, 0, section + ': all input listeners restored');
      check(reply.tty && reply.raw_before === reply.raw_after, section + ': real raw state restored');
      equal(reply.modes_after, reply.modes_before, section + ': exact console modes restored across the source question');
      if (scenario === 'pick-escape') {
        equal(reply.reply.exitCode, 130, section + ': source-question Escape exits 130');
        same([workspace, second, registryRoot, home].map(snapshot), before, section + ': question Escape preserves both Libraries, home and registry');
        check(!fs.existsSync(destination) && !fs.existsSync(join(registryRoot, 'move-journals')), section + ': question Escape creates no destination or move record');
      } else {
        equal(reply.reply.refusal, null, section + ': real command reaches a successful receipt');
        check(text.includes('Moved.') && text.includes('SMOKE_RESTORED'), section + ': receipt acknowledged without input workaround');
        const rows = JSON.parse(fs.readFileSync(join(registryRoot, 'workspaces.json'), 'utf8')).workspaces;
        equal(rows.find((row: any) => row.id === (scenario === 'resume' ? 'terminal' : 'chosen')).path, destination, section + ': chosen registry row agrees');
        if (scenario === 'pick-move') {
          equal(snapshot(workspace), before[0], section + ': other registered Library stays byte-identical');
          equal(fs.readFileSync(join(destination, 'chosen.txt'), 'utf8'), 'chosen Library bytes', section + ': chosen bytes reach destination');
          check(!fs.existsSync(second) && reply.checks >= 4 && text.includes('orca'), section + ': one selection survives blocker refresh, confirmation and apply');
        } else {
          check(text.includes('Almost done; this cannot stop safely now'), section + ': real resumed Escape acknowledged');
          check(fs.readFileSync(join(destination, 'payload-0.bin')).equals(Buffer.alloc(1024 * 1024, 73)), section + ': real resumed bytes agree');
        }
        const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
        equal(JSON.parse(fs.readFileSync(join(registryRoot, 'move-journals', id, 'journal.json'), 'utf8')).state, 'complete', section + ': completed journal agrees');
      }
      console.log(section + ': native terminal evidence ' + JSON.stringify(reply));
      return;
    }
    equal(reply.reply.exitCode, 130, section + ': Esc cancels the real fixture copy');
    check(reply.tty && reply.raw_before === reply.raw_after, section + ': real input raw state restored');
    if (!linux) equal(reply.modes_after, reply.modes_before, section + ': real Windows console input/output modes restored');
    else check(JSON.parse(result.stdout.trim()).host_modes_restored === true, section + ': real Linux terminal modes restored');
    check(fs.existsSync(workspace) && !fs.existsSync(destination), section + ': source restored before promotion');
    check(fs.readFileSync(join(workspace, 'payload-0.bin')).equals(Buffer.alloc(1024 * 1024, 73)), section + ': source bytes preserved');
    check(fs.existsSync(reply.reply.value.retained), section + ': partial copy retained as rolled-back');
    const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
    const journal = JSON.parse(fs.readFileSync(join(registryRoot, 'move-journals', id, 'journal.json'), 'utf8'));
    equal(journal.state, 'aborted', section + ': cancellation is durably recorded');
    check(journal.rollbackManifest?.some((entry: any) => entry.type === 'file'), section + ': recorded partial-copy bytes are real');
    check(fs.readFileSync(transcript, 'utf8').includes('SMOKE_RESTORED'), section + ': driver reached the restored receipt');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function section1089(): Promise<void> {
  await section1088(true);
}

async function section1081(): Promise<void> {
  const screen = await import('../../src/librarymovescreen.ts');
  const phases = ['checking', 'waiting', 'ready', 'moving', 'done', 'refused'] as const;
  for (const [width, height] of [[60, 24], [80, 24], [40, 10]] as const) for (const colour of [false, true]) for (const phase of phases) {
    const lines = screen.drawMoveScreen({ phase, value: { workspace: '/source', destination: '/target', ready: phase === 'ready', files: 12, bytes: 4096, destination_free_bytes: 8192,
      blockers: [{ kind: 'process', name: 'Orca', pid: 1, detail: 'still open', fix: 'Close Orca.' }], things_for_you: [] }, progress: { phase: 'copy', file: 'page.md', bytes: 100 }, refusal: 'The destination is full. Choose another folder.' }, width, height, colour);
    const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
    check(plain.every(line => line.length <= width), '1081: frame fits ' + phase + ' ' + width);
    check(plain.join('\n').includes('Library'), '1081: frame names the Library: ' + phase);
    if (width < 60) check(plain.join('\n').includes('1.'), '1081: small terminal uses numbered plain form');
    if (phase === 'waiting' && width >= 60) check(plain.join('\n').includes('[ ] Orca'), '1081: checklist carries meaning without colour');
    if (phase === 'done' && width >= 60) check(plain.join('\n').includes('Nothing left for you to do.'), '1081: empty receipt is explicit');
  }
  same(screen.drawMoveScreen({ phase: 'ready', value: { workspace: '/source', destination: '/target' } }, 60, 24, false).map(line => line.trimEnd()), [
    ' Ready. Nothing else is using the Library.', '', 'From  /source', 'To    /target', ' > Move it now', '   Cancel', '', '   Arrows move   Enter choose   Esc quit',
  ], '1081: ready frame golden');
  const held = screen.drawMoveScreen({ phase: 'waiting', cleared: ['Obsidian'], value: { blockers: [
    { kind: 'holder', name: 'Orca', pid: 1, detail: 'working folder', fix: 'Close Orca.' },
    { kind: 'holder', name: 'Orca', pid: 2, detail: 'open file', fix: 'Close Orca.' },
  ] } }, 60, 24, false).join('\n');
  check(held.includes('Waiting.') && held.includes('[x] Obsidian') && held.includes('2 processes'), '1081: held frame names closed applications and counts observed processes');
}
async function section1082(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-output-'))), workspace = join(root, 'source'), registryRoot = join(root, 'registry');
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'output' }));
    fs.writeFileSync(join(workspace, 'history.md'), workspace);
    fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'output', path: workspace }] }));
    const options = { workspace, destination: join(root, 'target'), registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
    const ready = await move.previewLibraryMove(options);
    equal(ready.exitCode, 0, '1082: ready preview exits zero');
    check(ready.humanText?.startsWith('Move the Library: ready.') === true, '1082: default plain starts with readiness');
    check(!ready.humanText?.includes('Who may rewrite:'), '1082: verbose inventory is behind details');
    const details = await move.previewLibraryMove({ ...options, details: true });
    check(details.humanText?.includes('Not searched:') === true && details.humanText.includes('History:'), '1082: details retains old preview information');
    const blocked = await move.previewLibraryMove({ ...options, processTable: () => [{ pid: 990001, parentPid: 0, name: 'orca' }] });
    equal(blocked.exitCode, 3, '1082: blocked preview exits three');
    check(blocked.humanText?.includes('1.') === true && blocked.humanText.includes('orca'), '1082: all plain blockers are numbered');
    const data = blocked.value as any;
    for (const key of ['history', 'pointers', 'source_manifest', 'expected_destination_manifest', 'plan_id', 'warnings', 'executable', 'blockers', 'ready', 'things_for_you']) check(key in data, '1082: preview retains JSON field ' + key);
    check(!data.ready && data.blockers.some((row: any) => row.pid === 990001), '1082: blocked JSON exposes readiness');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function section1083(): Promise<void> {
  const move = await import('../../src/librarymove.ts'), things = (move as any).moveThingsForYou;
  check(typeof things === 'function', '1083: complete receipt builder exists'); if (!things) return;
  const rows = things({ destination: '/new', pointers: [
    { file: '/source/.mcp.json', rewrite: 'program', place: 'Library configuration', occurrences: 0, ambiguous: 1, reason: 'the old path is written here with an escaped character; change it by hand' },
    { file: '/home/settings.json', rewrite: 'unknown', place: 'Home configuration', occurrences: 0, ambiguous: 0, reason: 'EACCES' },
    { file: '/home/orca/store.db', rewrite: 'orca', place: 'Orca store', occurrences: 4, ambiguous: 0, reason: 'open the workspace again in Orca after the move' },
  ], listed: ['/home/changed.json: changed since the preview; left as written', '1 files changed in the old folder after it was copied: late.txt. They are not in the new Library; compare them and copy over what you need.'] });
  for (const name of ['.mcp.json', 'settings.json', 'changed.json', 'late.txt', 'Orca']) check(rows.some((line: string) => line.includes(name)), '1083: receipt includes ' + name);
  same(things({ destination: '/new', pointers: [], listed: [] }), [], '1083: empty outcome has no invented work');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-receipt-'))), workspace = join(root, 'source'), destination = join(root, 'target'), registryRoot = join(root, 'registry'), home = join(root, 'home');
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = home;
    fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
    fs.mkdirSync(join(home, '.claude/settings.json'), { recursive: true });
    fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'receipt' }));
    fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'receipt', path: workspace }] }));
    const encoded = JSON.stringify(workspace).slice(1, -1), escaped = encoded.slice(0, -1) + '\\u' + encoded.charCodeAt(encoded.length - 1).toString(16).padStart(4, '0');
    fs.writeFileSync(join(workspace, '.mcp.json'), '{"path":"' + escaped + '"}');
    const outside = join(home, '.claude.json'); fs.writeFileSync(outside, JSON.stringify({ path: workspace }));
    const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
    const preview = await move.previewLibraryMove(options); let changed = false;
    const result = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id,
      control: { cancelled: () => false, progress: event => { if (event.phase === 'copy' && event.file && !changed) { changed = true; fs.writeFileSync(outside, 'outside edit'); } } } });
    equal(result.refusal, null, '1083: real receipt move succeeds: ' + result.refusal);
    const receipt = (result.value as any)?.things_for_you ?? [];
    for (const name of [join(destination, '.mcp.json'), join(home, '.claude/settings.json'), outside]) check(receipt.some((line: string) => line.includes(name)), '1083: actual receipt retains unresolved file ' + name);
    equal(fs.readFileSync(outside, 'utf8'), 'outside edit', '1083: changed outside bytes remain untouched');
    check(receipt.every((line: string) => !line.includes('ambiguous occurrences')), '1083: default receipt uses reader wording');
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }

}
async function section1084(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const guard = (move as any).moveRunsAsPreflight;
  check(typeof guard === 'function', '1084: agent guard exists'); if (!guard) return;
  const names = (move as any).MOVE_AGENT_VARIABLES as string[];
  for (const name of ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'DESKPOST_LAUNCHER_PID']) check(names.includes(name), '1084: agent guard includes ' + name);
  for (const name of names) check(guard({ [name]: 'set' }), '1084: each agent variable prevents confirmation: ' + name);
  check(!guard({}), '1084: ordinary terminal is not an agent');
}

async function section1085(aborted = false): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  check(typeof (move as any).cleanupPlanId === 'function', '1085: clean-up planner exists'); if (!(move as any).cleanupPlanId) return;
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-cleanup-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const variant of ['valid', 'rolled-back', 'added', 'changed', 'reused', 'link', 'parent-link', 'registered', 'inside', 'containing', 'unfinished', 'drift', 'unconfirmed', 'selected', 'late-change']) {
      const folder = join(root, variant), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: variant })); fs.writeFileSync(join(workspace, 'payload.txt'), 'original');
      const registry = join(registryRoot, 'workspaces.json'); fs.writeFileSync(registry, JSON.stringify({ workspaces: [{ id: variant, path: workspace }] }));
      const options = { workspace, destination, registryRoot, preflight: true, destinationRule: 'any' as const, processTable: () => [] };
      const preview = await move.previewLibraryMove(options); let cancelled = false;
      const result = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id,
        control: { cancelled: () => cancelled, progress: event => { if (aborted && event.phase === 'copy' && event.file) cancelled = true; } } });
      equal(result.refusal, null, '1085: fixture move ' + variant);
      const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      const journalFile = join(registryRoot, 'move-journals', id, 'journal.json'), journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      if (variant === 'rolled-back' && !aborted) {
        const recovery = await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: true });
        equal((await move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (recovery.value as any).plan_id })).refusal, null, '1085: completed fixture rolls back');
      }
      const restored = aborted || variant === 'rolled-back';
      const copy = restored ? destination + '.rolled-back-' + id : journal.aside;
      const cleanup = { registryRoot, cleanup: true, preflight: true };
      let plan = await move.moveLibrary(cleanup);
      check((plan.value as any)?.candidates?.some((row: any) => row.path === copy), '1085: terminal-state copy is offered');
      if (variant === 'added') fs.writeFileSync(join(copy, 'added.txt'), 'new bytes');
      if (variant === 'changed') fs.writeFileSync(join(copy, '.library/workspace.json'), 'changed bytes');
      if (variant === 'reused' || variant === 'link') {
        fs.renameSync(copy, copy + '.saved');
        if (variant === 'link') fs.symlinkSync(copy + '.saved', copy, process.platform === 'win32' ? 'junction' : 'dir');
        else fs.cpSync(copy + '.saved', copy, { recursive: true });
      }
      if (variant === 'parent-link') { fs.renameSync(folder, folder + '.saved'); fs.symlinkSync(folder + '.saved', folder, process.platform === 'win32' ? 'junction' : 'dir'); }
      if (['registered', 'inside', 'containing'].includes(variant)) {
        const document = JSON.parse(fs.readFileSync(registry, 'utf8'));
        document.workspaces.push({ id: 'live', path: variant === 'registered' ? copy : variant === 'inside' ? folder : join(copy, 'nested') });
        fs.writeFileSync(registry, JSON.stringify(document));
      }
      if (variant === 'unfinished' || variant === 'drift') {
        if (variant === 'unfinished') for (const state of ['phase-a', 'aside', 'phase-a-failed', 'phase-b-failed', 'abort-intent', 'unknown-state']) {
          journal.state = state; fs.writeFileSync(journalFile, JSON.stringify(journal));
          const peek = await move.moveLibrary(cleanup);
          check(!(peek.value as any)?.candidates?.some((row: any) => row.path === copy), '1085: unfinished state is never eligible: ' + state);
          check(fs.existsSync(copy), '1085: unfinished state retains its bytes: ' + state);
        }
        if (variant === 'unfinished') journal.state = 'abort-intent'; else journal.aside_drift = ['payload.txt'];
        fs.writeFileSync(journalFile, JSON.stringify(journal));
      }
      if (variant === 'selected') {
        plan = await move.moveLibrary({ ...cleanup, cleanupSelected: [] });
        const applied = await move.moveLibrary({ ...cleanup, cleanupSelected: [], preflight: false, userConfirmed: true, planId: (plan.value as any).plan_id });
        equal(applied.refusal, null, '1085: empty selection is a harmless confirmed action'); check(fs.existsSync(copy), '1085: unticked copy survives'); continue;
      }
      const applied = await move.moveLibrary({ ...cleanup, preflight: false, userConfirmed: variant !== 'unconfirmed', planId: (plan.value as any).plan_id,
        control: { cancelled: () => false, progress: event => { if (variant === 'late-change' && event.phase === 'cleanup-check') fs.writeFileSync(join(copy, 'late.txt'), 'late bytes'); } } });
      if (variant === 'valid' || variant === 'rolled-back') { equal(applied.refusal, null, '1085: approved unchanged copy can be deleted'); check(!fs.existsSync(copy), '1085: selected copy deleted'); }
      else { check(applied.refusal !== null, '1085: unsafe or unconfirmed clean-up refuses: ' + variant); check(fs.existsSync(copy), '1085: refused copy survives: ' + variant); }
      check(fs.existsSync(restored ? workspace : destination), '1085: live Library survives every clean-up');
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function section1086(): Promise<void> {
  await section1085(true);
  const { MoveSession } = await import('../../src/librarymovescreen.ts'), { cleanupPlanId } = await import('../../src/librarymove.ts'), { EventEmitter } = await import('node:events');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-cleanup-keys-')));
  try {
    for (const word of ['delete', 'dele', '']) {
      const folder = join(root, word || 'missing'), first = join(folder, 'first'), second = join(folder, 'second');
      fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second); fs.writeFileSync(join(first, 'keep'), 'first'); fs.writeFileSync(join(second, 'keep'), 'second');
      const candidates = [first, second].map(path => ({ path, identity: 'fixture:' + path, digest: 'fixture', bytes: 5 }));
      const input = new EventEmitter() as any, output = new EventEmitter() as any; let stage = 0, applied = 0;
      input.isRaw = false; input.setRawMode = (raw: boolean) => { input.isRaw = raw; }; input.resume = () => {}; input.pause = () => {};
      output.columns = 80; output.rows = 24; output.write = (text: string) => {
        if (stage === 0 && text.includes('Delete old Library copies')) { stage = 1; setImmediate(() => { input.emit('data', '\r'); input.emit('data', '\x1b[B\x1b[B\r'); }); }
        else if (stage === 1 && text.includes('Type delete')) { stage = 2; setImmediate(() => { input.emit('data', word + '\r'); if (word !== 'delete') setImmediate(() => input.emit('data', '\x03')); }); }
        else if (text.includes('Old Library copies deleted.')) setImmediate(() => input.emit('data', '\r'));
      };
      const session = new MoveSession({ check: async (selected = []) => ({ refusal: null, value: { cleanup: true, candidates, selected, ready: true, plan_id: cleanupPlanId(candidates, selected) } }),
        apply: async (_id, _control, selected = []) => {
          applied++; same(selected, [first], '1086: only the ticked fixture reaches deletion');
          for (const file of selected) fs.rmSync(file, { recursive: true });
          return { refusal: null, value: { cleanup: true, deleted: selected, things_for_you: [] }, exitCode: 0 };
        } }, { terminal: { input, output }, colour: false });
      const result = await session.run();
      equal(applied, word === 'delete' ? 1 : 0, '1086: exact typed word is required: ' + word);
      check(fs.existsSync(second), '1086: unticked copy is never deleted');
      equal(fs.existsSync(first), word !== 'delete', '1086: missing or invalid typed word keeps the selected copy');
      equal(result.exitCode, word === 'delete' ? 0 : 130, '1086: clean-up confirmation outcome');
      check(!input.isRaw && input.listenerCount('data') === 0, '1086: clean-up restores the terminal');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

}

async function section1090(): Promise<void> {
  const move = await import('../../src/librarymove.ts'), { EventEmitter } = await import('node:events');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-command-'))), previous = process.cwd();
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    process.chdir(root); for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const cancel of [false, true]) {
      const folder = join(root, String(cancel)), first = join(folder, 'first'), second = join(folder, 'second'), registryRoot = join(folder, 'registry'), destination = join(folder, 'target');
      for (const workspace of [first, second]) {
        fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal'));
        fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: workspace })); fs.writeFileSync(join(workspace, 'payload'), workspace);
      }
      fs.mkdirSync(registryRoot); const registry = join(registryRoot, 'workspaces.json');
      fs.writeFileSync(registry, JSON.stringify({ workspaces: [first, second].map(path => ({ path, id: path })) })); const before = fs.readFileSync(registry, 'utf8');
      const input = new EventEmitter() as any, output = new EventEmitter() as any;
      input.isTTY = output.isTTY = true; input.isRaw = false; input.setRawMode = (raw: boolean) => { input.isRaw = raw; }; input.resume = () => {}; input.pause = () => {};
      output.columns = 80; output.rows = 24; let asked = 0, checks = 0, transcript = '';
      output.write = (text: string) => { transcript += text; if (text.includes('Ready.') || text.includes('Moved.')) setImmediate(() => input.emit('data', '\r')); };
      const reply = await (move.runLibraryMoveCommand as any)({ destination, registryRoot, destinationRule: 'any', preflight: false,
        chooseWorkspace: async () => { asked++; equal(input.listenerCount('data'), 0, '1090: source question precedes controller input'); return cancel ? null : second; },
        processTable: () => { checks++; equal(input.listenerCount('data'), 1, '1090: controller owns input during each engine check/apply'); return []; },
      }, { terminal: { input, output }, refreshMilliseconds: 1 });
      equal(asked, 1, '1090: command chooses once through confirmation and apply');
      equal(input.listenerCount('data'), 0, '1090: command leaves no input listener'); check(!input.isRaw, '1090: command restores raw mode');
      equal(fs.readFileSync(join(first, 'payload'), 'utf8'), first, '1090: unchosen Library unchanged');
      if (cancel) { equal(reply.exitCode, 130, '1090: question Escape cancels'); equal(checks, 0, '1090: question cancellation never checks engine'); equal(fs.readFileSync(registry, 'utf8'), before, '1090: cancelled registry unchanged'); check(!fs.existsSync(destination), '1090: cancelled destination absent'); }
      else { equal(reply.refusal, null, '1090: chosen move succeeds'); check(transcript.includes('Moved.'), '1090: command reaches receipt'); check(checks >= 3, '1090: check, confirmation and apply use resolved source'); check(fs.existsSync(join(destination, 'payload')), '1090: chosen bytes reach destination'); if (fs.existsSync(join(destination, 'payload'))) equal(fs.readFileSync(join(destination, 'payload'), 'utf8'), second, '1090: moved bytes belong to chosen Library'); check(!fs.existsSync(second), '1090: chosen source moved'); }
    }
  } finally { process.chdir(previous); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1091(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-journal-cleanup-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const state of ['complete', 'rolled-back', 'aborted']) for (const change of ['none', 'added', 'changed', 'after-preview', 'checkpoint', 'legacy']) {
      const folder = join(root, state + '-' + change), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal/move-journals/prior'), { recursive: true }); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'journal-proof' })); fs.writeFileSync(join(workspace, 'payload'), 'reader bytes');
      fs.writeFileSync(join(workspace, 'internal/move-journals/prior/record'), 'prior evidence');
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'journal-proof', path: workspace }] }));
      const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
      const preview = await move.moveLibrary(options); let cancel = false;
      const moved = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (preview.value as any).plan_id, control: { cancelled: () => cancel, progress: event => { if (state === 'aborted' && event.phase === 'copy' && event.file?.endsWith('payload')) cancel = true; } } });
      equal(moved.refusal, null, '1091: fixture move ' + state);
      const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      if (state === 'rolled-back') {
        const p = await move.moveLibrary({ registryRoot, rollback: id, preflight: true, processTable: () => [] });
        equal((await move.moveLibrary({ registryRoot, rollback: id, preflight: false, userConfirmed: true, planId: (p.value as any).plan_id, processTable: () => [] })).refusal, null, '1091: fixture rollback');
      }
      const journalFile = join(registryRoot, 'move-journals', id, 'journal.json'), journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      const copy = state === 'complete' ? journal.aside : destination + '.rolled-back-' + id;
      const cleanup = { registryRoot, cleanup: true, preflight: true };
      let plan = await move.moveLibrary(cleanup);
      check((plan.value as any)?.candidates.some((row: any) => row.path === copy), '1091: unchanged ' + state + ' copy is eligible');
      const mutate = () => {
        fs.mkdirSync(join(copy, 'internal/move-journals'), { recursive: true });
        const files = fs.readdirSync(join(copy, 'internal/move-journals'), { recursive: true }).map(String).filter(name => fs.statSync(join(copy, 'internal/move-journals', name)).isFile());
        const file = change === 'changed' && files.length ? join(copy, 'internal/move-journals', files[0]!) : join(copy, 'internal/move-journals/unseen');
        fs.writeFileSync(file, 'unseen reader bytes'); return file;
      };
      let unseen: string | undefined;
      if (['added', 'changed', 'after-preview'].includes(change)) unseen = mutate();
      if (change === 'legacy') { delete journal.sourceJournals; delete journal.retainedJournals; fs.writeFileSync(journalFile, JSON.stringify(journal)); if (!fs.existsSync(join(copy, 'internal/move-journals'))) unseen = mutate(); }
      if (['added', 'changed', 'legacy'].includes(change)) {
        plan = await move.moveLibrary(cleanup);
        check(!(plan.value as any)?.candidates.some((row: any) => row.path === copy), '1091: unproved journal bytes are held: ' + state + ' ' + change);
      }
      const result = await move.moveLibrary({ ...cleanup, preflight: false, userConfirmed: true, planId: (plan.value as any).plan_id, cleanupSelected: [copy], control: { cancelled: () => false, progress: event => { if (change === 'checkpoint' && event.phase === 'cleanup-check') unseen = mutate(); } } });
      if (change === 'none') { equal(result.refusal, null, '1091: unchanged journal evidence permits deletion: ' + state); check(!fs.existsSync(copy), '1091: unchanged selected copy removed'); }
      else { check(result.refusal !== null, '1091: changed journal refuses deletion: ' + state + ' ' + change); check(fs.existsSync(copy), '1091: changed copy survives'); if (unseen && fs.existsSync(unseen)) equal(fs.readFileSync(unseen, 'utf8'), 'unseen reader bytes', '1091: unseen bytes survive'); }
      check(fs.existsSync(state === 'complete' ? destination : workspace), '1091: live Library survives');
    }
  } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1092(): Promise<void> {
  const move = await import('../../src/librarymove.ts'), { EventEmitter } = await import('node:events');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c183-resume-escape-'))), previous = process.cwd();
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  try {
    process.chdir(root); for (const [key] of saved) process.env[key] = join(root, 'home');
    for (const key of ['\x1b', '\x03']) {
      const folder = join(root, key === '\x1b' ? 'escape' : 'interrupt'), workspace = join(folder, 'source'), destination = join(folder, 'target'), registryRoot = join(folder, 'registry');
      fs.mkdirSync(join(workspace, '.library'), { recursive: true }); fs.mkdirSync(join(workspace, 'internal')); fs.mkdirSync(registryRoot);
      fs.writeFileSync(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'resume' })); fs.writeFileSync(join(workspace, 'payload'), Buffer.alloc(64 * 1024 * 1024, 83));
      fs.writeFileSync(join(registryRoot, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'resume', path: workspace }] }));
      const pointer = join(root, 'home/.claude.json'); fs.mkdirSync(join(pointer, '..'), { recursive: true }); fs.writeFileSync(pointer, JSON.stringify({ path: workspace }));
      const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
      const plan = await move.moveLibrary(options);
      const stopped = await move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: (plan.value as any).plan_id, faultAt: 'registry:after-done' });
      check(stopped.refusal?.includes('Injected move fault') === true, '1092: fixture is interrupted past promotion');
      const id = fs.readdirSync(join(registryRoot, 'move-journals')).find(name => name.startsWith('move-'))!;
      const input = new EventEmitter() as any, output = new EventEmitter() as any; let sent = false, transcript = '';
      input.isRaw = false; input.setRawMode = (raw: boolean) => { input.isRaw = raw; }; input.resume = () => {}; input.pause = () => {};
      output.columns = 80; output.rows = 24; output.write = (text: string) => {
        transcript += text;
        if (text.includes('Ready.')) setImmediate(() => input.emit('data', '\r'));
        if (text.includes('Moving the Library') && !sent) { sent = true; input.emit('data', key); }
        if (text.includes('Moved.') || text.includes('The Library could not be moved')) setImmediate(() => input.emit('data', '\r'));
      };
      const reply = await move.runLibraryMoveCommand({ registryRoot, resume: id, preflight: false, processTable: () => [] }, { terminal: { input, output } });
      equal(reply.refusal, null, '1092: post-promotion Escape cannot strand recovery: ' + reply.refusal);
      check(sent && transcript.includes('Almost done; this cannot stop safely now'), '1092: resumed Escape is acknowledged');
      equal(JSON.parse(fs.readFileSync(join(registryRoot, 'move-journals', id, 'journal.json'), 'utf8')).state, 'complete', '1092: resumed journal completes');
      equal(JSON.parse(fs.readFileSync(join(registryRoot, 'workspaces.json'), 'utf8')).workspaces[0].path, destination, '1092: resumed registry agrees');
      equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).path, destination, '1092: resumed outside pointer agrees');
      check(fs.readFileSync(join(destination, 'payload')).equals(Buffer.alloc(64 * 1024 * 1024, 83)), '1092: resumed destination bytes agree');
      check(!input.isRaw && input.listenerCount('data') === 0, '1092: resumed controller restores input');
    }
  } finally { process.chdir(previous); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1087(): Promise<void> {
  const read = (file: string) => fs.readFileSync(join(PROGRAM_ROOT, file), 'utf8');
  const guide = (read('docs/guides/README.md').split('Before moving:')[1] ?? '').split('\n## Shared moves')[0] ?? '';
  const quick = (read('docs/guides/quick-start.md').split('Before moving,')[1] ?? '').split('\n## When something')[0] ?? '';
  const skill = read('.claude/skills/library-help/SKILL.md');
  const moveHelp = skill.match(/\*\*Moving a Library\.\*\*[\s\S]*?(?=\n\n\*\*|$)/)?.[0] ?? '';
  for (const [name, text] of [['guide', guide], ['quick start', quick], ['help skill', moveHelp]] as const) {
    check(/outside the Library/i.test(text), '1087: ' + name + ' puts the terminal outside the Library');
    check(text.includes('--workspace') && /registered/i.test(text), '1087: ' + name + ' explains resolution');
    for (const flag of ['--preflight', '--plain', '--details', '--resume', '--rollback', '--clean-up']) check(text.includes(flag), '1087: ' + name + ' documents ' + flag);
    check(text.includes('130') && /\b3\b/.test(text), '1087: ' + name + ' documents cancellation and not-ready exits');
    check(/counts old-path matches in `\.db` contents and never rewrites those files/.test(text), '1087: ' + name + ' states the database boundary');
    check(/rename does not exclude all writers/i.test(text), '1087: ' + name + ' states the retained-handle limit');
    check(text.includes('delete'), '1087: ' + name + ' explains gated clean-up');
  }
  check(!moveHelp.includes('turned off'), '1087: help no longer says moving is disabled');
  const help = runCli(['library', 'move', '--help']);
  for (const flag of ['--plain', '--details', '--clean-up']) check(help.stdout.includes(flag), '1087: actual command help includes ' + flag);
  check(help.stdout.includes('130') && help.stdout.includes('3'), '1087: actual help includes readiness exits');
  check(/(Next release|\d+\.\d+\.\d+ is released)[^\n]*one run/i.test(read('docs/roadmap.md')), '1087: roadmap names this change as the next release or as released');
}

async function section1093(): Promise<void> {
  await section1088(false, 'pick-move');
}
async function section1094(): Promise<void> {
  await section1088(false, 'pick-escape');
}
async function section1095(): Promise<void> {
  await section1088(false, 'resume');
}
