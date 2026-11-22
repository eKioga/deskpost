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
    const file = join(folder, entry.name);
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
      ['no preview flag', [destination], 'run the preview first: deskpost library move'],
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
        equal(result.exit, warning ? 0 : 1, '1010: refusal or warning: ' + label);
        const text = warning && result.exit === 0 ? JSON.parse(result.stdout).warnings.join('\n') : result.stderr;
        check(text.includes(remedy), `1010: ${label} names remedy ${remedy}: ${text}`);
        if (label === 'held seats') check(text.includes('busy') && text.includes('other'), '1010: names every held seat');
        same(snapshot(root), before, '1010: refusal writes nothing: ' + label);
      } finally { restore?.(); }
    }
    const before = snapshot(root), good = run([destination, '--preflight', '--json']);
    equal(good.exit, 0, '1010: good preview: ' + good.stderr);
    if (good.exit === 0) check(JSON.parse(good.stdout).written === false, '1010: preview never claims a write');
    same(snapshot(root), before, '1010: preview leaves Library, registry and home byte-identical');
    check(!fs.existsSync(destination), '1010: destination not created');
    const inside = runCli(['library', 'move', destination, '--preflight', '--registry-root', registry], { cwd: workspace, env });
    equal(inside.exit, 0, '1010: resolves source from current folder marker');
    if (process.platform !== 'win32') check(run([destination, '--preflight']).stdout.includes('check does not apply'), '1010: explains POSIX rule');
    const help = run(['--help']); equal(help.exit, 0, '1010: help succeeds');
    for (const flag of ['--preflight', '--user-confirmed', '--plan-id', '--resume', '--rollback']) check(help.stdout.includes(flag), '1010: help names ' + flag);
    for (const quote of ['"', '`']) {
      const quoted = run([destination + quote + 'quoted', '--preflight']);
      check(quoted.exit !== 0 && quoted.stderr.includes('choose a folder name without quotes'), '1010: other quote characters refused: ' + quote);
    }
    const move = await import('../../src/librarymove.ts');
    const mixed = move.previewLibraryMove({ destination: destination + "\t'name", workspace: join(root, 'no-library'), preflight: true });
    check(mixed.refusal?.includes(destination + "\\u0009'name holds a control character") === true && !mixed.refusal.includes('\t'), '1010: quote and tab destination escapes its control character');
    for (const character of ['\n', '\t', '\0', '\x7f']) {
      const escaped = '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();
      const invalid = destination + character + 'control';
      const before = snapshot(root);
      const result = move.previewLibraryMove({ destination: invalid, workspace: join(root, 'no-library'), preflight: true, processTable: () => { throw new Error('must not read the process table'); } });
      check(result.refusal?.includes(destination + escaped + 'control holds a control character') === true && result.refusal.includes('choose a folder name without one'), '1010: control character refused before reading: ' + escaped);
      check(!result.refusal?.includes(character), '1010: diagnostic escapes control character ' + escaped);
      same(snapshot(root), before, '1010: control refusal writes nothing ' + escaped);
    }
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
    ['quiet.refusal', 'close it, then run the command again'],
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
  const delegated = new Set(['image name for process', 'process table is not supported', 'quiet.refusal', 'Injected move fault', 'plan.reasons.join', "reasons.join('\\n')", '(error as Error).message + recovery']);
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
      equal(result.exit, 0, '1011: preview: ' + result.stderr);
      if (result.exit !== 0) return;
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
      equal(inside.exit, 0, '1011: inside preview');
      if (inside.exit === 0) equal(JSON.parse(inside.stdout).cwd_inside_library, true, '1011: inside current folder');
      const human = runCli(['library', 'move', destination, '--preflight', '--workspace', workspace, '--registry-root', registry], { cwd: root, env });
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
      const result = runPreview(); equal(result.exit, 0, '1011: ambiguous preview');
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
        const preview = move.previewLibraryMove({ workspace: tableLibrary, destination: tableDestination, registryRoot: tableRegistry, destinationRule: 'any', processTable: () => [], preflight: true });
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
        const preview = move.previewLibraryMove(options);
        equal(preview.refusal, null, '1011: boundary preview: ' + row.name);
        const value = preview.value as Record<string, any>;
        if (!value) continue;
        const pointer = value.pointers.find((p: { file: string }) => p.file === join(library, row.file));
        equal(pointer?.occurrences, rewrites ? 1 : 0, '1011: boundary occurrences: ' + row.name);
        equal(pointer?.ambiguous, rewrites ? 0 : 1, '1011: boundary ambiguous count: ' + row.name);
        const sha = (text: string) => createHash('sha256').update(text).digest('hex');
        equal(value.expected_destination_manifest.find((r: { relative: string }) => r.relative === row.file)?.sha256, sha(expected), '1011: boundary expected manifest: ' + row.name);
        const stopped = move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: value.plan_id, faultAt: 'promote:before' });
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
        const preview = move.previewLibraryMove({ workspace: library, destination: join(folder, 'destination'), registryRoot, destinationRule: 'any', processTable: () => [], preflight: true });
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
    const file = join(folder, entry.name); return entry.isDirectory() ? snapshot(file) : [file + ':' + fs.readFileSync(file).toString('base64')];
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
    const result = previewLibraryMove({ destination, workspace, registryRoot: registry, preflight: true, historyByteLimit: 1024 });
    equal(result.refusal, null, '1012: history preview: ' + result.refusal);
    const value = result.value as Record<string, unknown> | null;
    same(value?.history, [{ folder: 'collection', files: 1 }, { folder: 'internal/journals', files: 2 }, { folder: 'internal/other', files: 1 }], '1012: history grouped by folder and counts files rather than occurrences');
    same(value?.history_skipped, [{ folder: 'raw', files: 1 }], '1012: large file counted without an 8 MB fixture');
    same(value?.history_unreadable, [], '1012: no hidden unreadable files');
    check(result.humanText?.includes('left as written and readable by their old path in the aside copy') === true, '1012: explains history remains readable');
    check(result.humanText?.includes('History skipped: raw: 1 files') === true, '1012: human skipped count');
    same(snapshot(root), before, '1012: history, home and registry byte-identical');
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
    const fixture = (label: string) => {
      const folder = join(root, label), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry');
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
      const preview = move.previewLibraryMove(options); equal(preview.refusal, null, '1014: preview ' + label);
      const plan = preview.value as Record<string, any>; calls = 0;
      return { folder, workspace, destination, registryRoot, options, plan, put, calls: () => calls };
    };
    const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      if (entry.isSymbolicLink()) return [join(folder, entry.name) + ':link:' + fs.readlinkSync(join(folder, entry.name))];
      const file = join(folder, entry.name); return entry.isDirectory() ? snapshot(file) : [file + ':' + sha(fs.readFileSync(file))];
    });
    const success = fixture('success');
    const pointer = join(root, 'home/.claude.json'), beforePointer = fs.readFileSync(pointer);
    const result = move.moveLibrary({ ...success.options, preflight: false, userConfirmed: true, planId: success.plan.plan_id });
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
    const drift = fixture('drift'); drift.put(join(drift.workspace, 'changed'), 'changed'); const before = snapshot(root);
    check(move.moveLibrary({ ...drift.options, preflight: false, userConfirmed: true, planId: drift.plan.plan_id }).refusal?.includes('changed since the preview') === true, '1014: stale plan refused');
    same(snapshot(root), before, '1014: stale plan writes nothing');
    const missingInternal = fixture('missing-internal');
    fs.rmdirSync(join(missingInternal.workspace, 'internal')); // This fixture's empty folder only.
    const missingBefore = snapshot(missingInternal.workspace);
    const missingPlan = move.previewLibraryMove(missingInternal.options).value as Record<string, any>;
    const missingResult = move.moveLibrary({ ...missingInternal.options, preflight: false, userConfirmed: true, planId: missingPlan.plan_id });
    check(missingResult.refusal?.includes(join(missingInternal.workspace, 'internal') + ' is missing') === true, '1014: missing internal refuses an in-process move');
    same(snapshot(missingInternal.workspace), missingBefore, '1014: missing internal move leaves source bytes unchanged');
    check(!fs.existsSync(join(missingInternal.workspace, 'internal')), '1014: missing internal move creates no folder');
    // Exercise barrier itself after the plan: remove the empty folder at its step's fault seam.
    const missingBarrier = fixture('missing-barrier');
    const barrierBefore = snapshot(missingBarrier.workspace);
    const barrierResult = move.moveLibrary({ ...missingBarrier.options, preflight: false, userConfirmed: true, planId: missingBarrier.plan.plan_id,
      get faultAt() {
        // step() reads this immediately before barrier's effect. Remove this fixture's empty folder only.
        if (fs.existsSync(join(missingBarrier.workspace, 'internal'))) fs.rmdirSync(join(missingBarrier.workspace, 'internal'));
        return undefined;
      },
    });
    check(barrierResult.refusal?.includes(join(missingBarrier.workspace, 'internal') + ' is missing') === true, '1014: barrier refuses its missing internal folder');
    check(!fs.existsSync(join(missingBarrier.workspace, 'internal')), '1014: barrier creates no missing internal folder');
    same(snapshot(missingBarrier.workspace), barrierBefore, '1014: missing barrier leaves source bytes unchanged');
    const fileInternal = fixture('file-internal'), internal = join(fileInternal.workspace, 'internal');
    fs.rmdirSync(internal); // Replace only this fixture's empty folder with a file.
    fs.writeFileSync(internal, 'keep this file');
    const fileBefore = snapshot(fileInternal.workspace);
    const filePlan = move.previewLibraryMove(fileInternal.options).value as Record<string, any>;
    const fileResult = move.moveLibrary({ ...fileInternal.options, preflight: false, userConfirmed: true, planId: filePlan.plan_id });
    check(fileResult.refusal?.includes(internal + ' is not a folder; move it aside') === true, '1014: file internal refuses an in-process move');
    same(snapshot(fileInternal.workspace), fileBefore, '1014: file internal move leaves source bytes unchanged');
    for (const kind of ['file', 'link', 'dangling-link']) {
      const w = fixture('barrier-' + kind), internal = join(w.workspace, 'internal');
      const replaceInternal = () => {
        fs.rmdirSync(internal); // Replace only this fixture's empty folder at the barrier seam.
        if (kind === 'file') fs.writeFileSync(internal, 'keep this file');
        else fs.symlinkSync(join(root, kind === 'link' ? 'home' : 'missing-link-target'), internal, process.platform === 'win32' ? 'junction' : 'dir');
      };
      let replaced = false, before: string[] = [];
      const result = move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id,
        get faultAt() {
          if (!replaced) { replaceInternal(); replaced = true; before = snapshot(w.workspace); }
          return undefined;
        },
      });
      check(result.refusal?.includes(internal + ' is not a folder; move it aside') === true, '1014: barrier refuses internal ' + kind);
      same(snapshot(w.workspace), before, '1014: barrier refusal leaves source bytes unchanged: ' + kind);
    }
    for (let quietAt = 1; quietAt <= 4; quietAt++) {
      const w = fixture('writer-' + quietAt); let calls = 0;
      const refused = move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id, processTable: () => ++calls === quietAt ? [{ name: 'codex', pid: 990001, parentPid: 0 }] : [] });
      check(refused.refusal?.includes('990001') === true, '1014: writer refused at quiet check ' + quietAt);
    }
    const changedOutside = fixture('outside-drift'); let calls = 0;
    const outsideResult = move.moveLibrary({ ...changedOutside.options, preflight: false, userConfirmed: true, planId: changedOutside.plan.plan_id, processTable: () => {
      if (++calls === 2) changedOutside.put(pointer, 'reader changed this'); return [];
    } });
    equal(outsideResult.refusal, null, '1014: outside drift leaves move valid');
    equal(fs.readFileSync(pointer, 'utf8'), 'reader changed this', '1014: outside drift kept');
    check((outsideResult.value as Record<string, any>)?.left_and_listed.some((line: string) => line.includes('changed since the preview')), '1014: outside drift listed');
    const inside = fixture('inside'); const previous = process.cwd();
    try { process.chdir(inside.workspace); check(move.moveLibrary({ ...inside.options, preflight: false, userConfirmed: true, planId: inside.plan.plan_id }).refusal?.includes('run it from a folder outside') === true, '1014: inside current folder refused'); } finally { process.chdir(previous); }
    const linked = fixture('linked'); fs.symlinkSync(join(root, 'home'), join(linked.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedPreview = move.previewLibraryMove(linked.options);
    check(move.moveLibrary({ ...linked.options, preflight: false, userConfirmed: true, planId: (linkedPreview.value as Record<string, any>).plan_id }).refusal?.includes('symbolic link or junction') === true, '1014: link inside refused');
    const real = fixture('real-table');
    const command = runCli(['library', 'move', real.destination, '--workspace', real.workspace, '--registry-root', real.registryRoot, '--user-confirmed', '--plan-id', real.plan.plan_id], { cwd: root, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' } });
    if (process.platform === 'win32') check(command.exit !== 0 && /(?:codex|library).*process \d+/i.test(command.stderr), '1014: real Windows writer table refuses: ' + command.stderr);
    else check((command.exit === 0 || command.exit === 1) && !command.stderr.includes('The process table could not be read'), '1014: real Linux table is read and judged');
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
      if (name === 'internal/maintenance-barrier.json' || name === 'internal/move-journals') return [];
      return entry.isDirectory() ? ['folder:' + name, ...tree(folder, name)] : [name + ':' + bytes(join(folder, name))];
    });
    let serial = 0;
    const fixture = () => {
      const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry'), home = join(folder, 'home');
      for (const [key] of saved) process.env[key] = home;
      put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture-' + serial })); fs.mkdirSync(join(workspace, 'internal'));
      put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace })); put(join(workspace, 'history.md'), workspace);
      fs.mkdirSync(join(workspace, 'empty'));
      const pointers = [join(home, '.claude.json'), join(home, '.claude/settings.json'), join(home, '.codex/config.toml')];
      for (const file of pointers) put(file, JSON.stringify({ path: workspace }));
      const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture-' + serial, path: workspace, default: true }] }));
      const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, preflight: true, processTable: () => [] };
      const plan = move.previewLibraryMove(options).value as Record<string, any>;
      const original = tree(workspace), priorRegistry = bytes(registry), priorPointers = pointers.map(bytes);
      return { folder, workspace, destination, registryRoot, pointers, registry, options, plan, original, priorRegistry, priorPointers };
    };
    const failedMove = (w: ReturnType<typeof fixture>, faultAt: string) => {
      const result = move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id, faultAt });
      check(result.refusal?.includes('Injected move fault') === true, '1015: fault reached: ' + faultAt + ': ' + result.refusal);
      const journals = fs.readdirSync(join(w.registryRoot, 'move-journals'));
      equal(journals.length, 1, '1015: one journal per interrupted move');
      return journals[0]!;
    };
    const rollback = (w: ReturnType<typeof fixture>, id: string, faultAt?: string) => {
      const preview = move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true });
      equal(preview.refusal, null, '1015: rollback preview: ' + preview.refusal);
      if (preview.refusal) return preview;
      return move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id, faultAt });
    };
    const restored = (w: ReturnType<typeof fixture>, label: string) => {
      same(tree(w.workspace), w.original, '1015: source byte-equal after ' + label);
      equal(bytes(w.registry), w.priorRegistry, '1015: registry byte-equal after ' + label);
      same(w.pointers.map(bytes), w.priorPointers, '1015: outside pointers byte-equal after ' + label);
      check(!fs.existsSync(join(w.workspace, 'internal/maintenance-barrier.json')), '1015: restored source barrier lifted');
    };
    for (const point of ['copy-file:before-done', 'promote:before', 'promote:before-done', 'cutover:before-done', 'cutover:after-done', 'pointer-0:after-done', 'pointer-0:before-done', 'registry:before-done', 'complete:before-done', 'journal-copy:before-done']) {
      const phaseB = !point.startsWith('copy') && !point.startsWith('promote');
      for (const recovery of phaseB ? ['resume', 'rollback'] : ['rollback']) {
        const w = fixture(), id = failedMove(w, point);
        if (recovery === 'rollback') { const result = rollback(w, id); equal(result.refusal, null, '1015: rollback at ' + point + ': ' + result.refusal); if (!result.refusal) restored(w, point); }
        else {
          if (point === 'journal-copy:before-done') put(join(w.destination, 'internal/move-journals', id, 'registry-before'), 'a partial journal copy');
          const result = move.moveLibrary({ ...w.options, destination: undefined, resume: id, preflight: false, userConfirmed: true });
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
      const w = fixture(), id = failedMove(w, 'pointer-0:before-done');
      const interrupted = rollback(w, id, rename + ':' + timing);
      check(interrupted.refusal?.includes('Injected move fault') === true, '1015: rollback rename fault reached ' + rename + ':' + timing);
      const resumed = rollback(w, id); equal(resumed.refusal, null, '1015: interrupted rollback resumes: ' + resumed.refusal);
      if (!resumed.refusal) { restored(w, rename + ':' + timing); check(!fs.existsSync(w.destination), '1015: recovery never recreates renamed destination'); }
    }
    for (const name of ['rollback-barriers', 'rollback-pointer-0', 'rollback-empty', 'rollback-complete']) {
      const w = fixture(); fs.mkdirSync(w.destination);
      w.plan = move.previewLibraryMove(w.options).value as Record<string, any>;
      const id = failedMove(w, 'registry:before-done'), point = name + ':before-done';
      check(rollback(w, id, point).refusal?.includes('Injected move fault at ' + point) === true, '1015: recovery step effect interrupted: ' + point);
      const result = rollback(w, id);
      equal(result.refusal, null, '1015: same rollback completes after ' + point + ': ' + result.refusal);
      if (!result.refusal) {
        restored(w, point);
        same(fs.readdirSync(w.destination), [], '1015: recovery step restores original empty destination: ' + point);
      }
    }
    for (const timing of ['before-done', 'after-done']) {
      const w = fixture(), id = failedMove(w, 'copy-file:before-done');
      check(rollback(w, id, 'rollback-destination:' + timing).refusal?.includes('Injected move fault') === true, '1015: partial staging rename fault');
      const result = rollback(w, id); equal(result.refusal, null, '1015: partial staging rollback continues: ' + result.refusal); if (!result.refusal) restored(w, 'partial staging rename');
    }
    const registryInterrupted = fixture();
    const registryDocument = JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8'));
    registryDocument.workspaces.push({ path: join(registryInterrupted.folder, 'unrelated'), id: 'unrelated', note: 'before' });
    put(registryInterrupted.registry, JSON.stringify(registryDocument));
    registryInterrupted.plan = move.previewLibraryMove(registryInterrupted.options).value as Record<string, any>;
    const registryId = failedMove(registryInterrupted, 'registry:before-done');
    check(rollback(registryInterrupted, registryId, 'rollback-registry:before-done').refusal?.includes('Injected move fault') === true, '1015: registry restore interrupted before done');
    const restoredDocument = JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8'));
    restoredDocument.workspaces.find((row: { id: string }) => row.id === 'unrelated').note = 'reader changed this';
    put(registryInterrupted.registry, JSON.stringify(restoredDocument));
    const registryRetry = rollback(registryInterrupted, registryId);
    equal(registryRetry.refusal, null, '1015: registry restore resumes after unrelated row changed: ' + registryRetry.refusal);
    same(JSON.parse(fs.readFileSync(registryInterrupted.registry, 'utf8')), restoredDocument, '1015: restored identity, default flag and unrelated edit kept');
    same(tree(registryInterrupted.workspace), registryInterrupted.original, '1015: registry retry restores original source tree');
    same(registryInterrupted.pointers.map(bytes), registryInterrupted.priorPointers, '1015: registry retry restores outside pointers');
    check(!fs.existsSync(join(registryInterrupted.workspace, 'internal/maintenance-barrier.json')), '1015: registry retry lifts source barrier');
    const changedRegistry = fixture(), changedRegistryId = failedMove(changedRegistry, 'registry:before-done');
    const changedDocument = JSON.parse(fs.readFileSync(changedRegistry.registry, 'utf8'));
    changedDocument.workspaces[0].default = false;
    put(changedRegistry.registry, JSON.stringify(changedDocument));
    const changedBytes = bytes(changedRegistry.registry), changedPointers = changedRegistry.pointers.map(bytes);
    const recoverySnapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const file = join(folder, entry.name);
      return entry.isDirectory() ? ['folder:' + file, ...recoverySnapshot(file)] : [file + ':' + bytes(file)];
    });
    const changedSnapshot = recoverySnapshot(changedRegistry.folder);
    const changedResult = rollback(changedRegistry, changedRegistryId);
    check(changedResult.refusal?.includes('The moved registry row changed; inspect it before retrying the rollback') === true, '1015: changed moved row still refused');
    equal(bytes(changedRegistry.registry), changedBytes, '1015: changed moved row is not written');
    same(changedRegistry.pointers.map(bytes), changedPointers, '1015: changed moved row refusal leaves outside pointers alone');
    same(recoverySnapshot(changedRegistry.folder), changedSnapshot, '1015: changed moved row refusal leaves whole fixture unchanged');
    for (const changed of ['aside', 'destination']) {
      const w = fixture(), id = failedMove(w, 'cutover:after-done');
      const journalFile = join(w.registryRoot, 'move-journals', id, 'journal.json');
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      put(join(changed === 'aside' ? journal.aside : w.destination, 'history.md'), 'reader changed this');
      const before = tree(w.folder);
      const result = move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true });
      check(result.refusal?.includes('history.md') === true, '1015: changed ' + changed + ' refused by file name'); same(tree(w.folder), before, '1015: changed tree refusal writes nothing');
    }
    const drifted = fixture(), driftId = failedMove(drifted, 'pointer-0:before-done');
    put(drifted.pointers[0]!, 'outside edit'); const driftResult = rollback(drifted, driftId);
    equal(driftResult.refusal, null, '1015: rollback leaves outside drift'); equal(fs.readFileSync(drifted.pointers[0]!, 'utf8'), 'outside edit', '1015: drifted outside bytes kept');
    check((driftResult.value as Record<string, any>)?.left_and_listed.some((line: string) => line.includes('changed after the move')), '1015: outside drift listed on rollback');
    const changedSource = fixture(); let quiet = 0;
    const sourceFault = move.moveLibrary({ ...changedSource.options, preflight: false, userConfirmed: true, planId: changedSource.plan.plan_id, processTable: () => { if (++quiet === 2) put(join(changedSource.workspace, 'history.md'), 'saved after copy'); return []; } });
    check(sourceFault.refusal?.includes('history.md') === true && fs.existsSync(changedSource.workspace), '1015: source saved after copy caught before commit');
    const sourceId = fs.readdirSync(join(changedSource.registryRoot, 'move-journals'))[0]!;
    equal(rollback(changedSource, sourceId).refusal, null, '1015: phase A rollback preserves a later source save');
    equal(fs.readFileSync(join(changedSource.workspace, 'history.md'), 'utf8'), 'saved after copy', '1015: later source save never overwritten');
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
    const fixture = () => {
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
      const plan = move.previewLibraryMove(options).value as Record<string, any>;
      return { folder, workspace, destination, home, registryRoot, registryFile, pointer, options, plan, longFile, registryBefore: fs.readFileSync(registryFile, 'utf8'), pointerBefore: fs.readFileSync(pointer, 'utf8') };
    };
    const childAt = async (w: ReturnType<typeof fixture>, faultAt: string, release = false) => {
      const marker = join(w.folder, 'marker'), releaseFile = join(w.folder, 'release'), resultFile = join(w.folder, 'result.json'), script = join(w.folder, 'child.mjs');
      const options = { ...w.options, processTable: undefined, preflight: false, userConfirmed: true, planId: w.plan.plan_id, faultAt, faultMarker: marker, ...(release ? { faultRelease: releaseFile } : {}) };
      put(script, `import { moveLibrary } from ${JSON.stringify(pathToFileURL(join(PROGRAM_ROOT, 'kernel/src/librarymove.ts')).href)};\nimport fs from 'node:fs';\nconst result = moveLibrary({...${JSON.stringify(options)}, processTable: () => []});\nfs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));\n`);
      const child = spawn(process.execPath, [script], { cwd: w.folder, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, APPDATA: w.home, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' } });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const until = Date.now() + 15000;
        while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        check(fs.existsSync(marker), '1016: child reached ' + faultAt);
        return { child, exited, marker, releaseFile, resultFile };
      } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
    };
    const rollBack = (w: ReturnType<typeof fixture>, id: string) => {
      const preview = move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: true });
      equal(preview.refusal, null, '1016: rollback preview: ' + preview.refusal);
      if (preview.refusal) return preview;
      return move.moveLibrary({ ...w.options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id });
    };
    for (const [point, recovery] of [['copy-file:before-done', 'rollback'], ['pointer-0:before-done', 'resume'], ['pointer-0:before-done', 'rollback']]) {
      const w = fixture(), worker = await childAt(w, point!);
      worker.child.kill('SIGKILL'); await worker.exited;
      const id = fs.readdirSync(join(w.registryRoot, 'move-journals'))[0]!;
      const result = recovery === 'rollback' ? rollBack(w, id) : move.moveLibrary({ ...w.options, destination: undefined, resume: id, preflight: false, userConfirmed: true });
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
      const w = fixture(), worker = await childAt(w, 'copy:before', true);
      const { openShareNothing } = await import('../../src/seatclaim.ts');
      const handle = openShareNothing(join(w.workspace, '.mcp.json'));
      try {
        put(worker.releaseFile, 'continue');
        const finished = await Promise.race([worker.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000))]);
        check(finished, '1016: sharing violation retries are bounded');
        if (!finished) { worker.child.kill('SIGKILL'); await worker.exited; }
      } finally { handle.close(); if (worker.child.exitCode === null) { worker.child.kill('SIGKILL'); await worker.exited; } }
      const result = JSON.parse(fs.readFileSync(worker.resultFile, 'utf8'));
      check(result.refusal.includes('.mcp.json') && result.refusal.includes('after three retries') && result.refusal.includes('--rollback'), '1016: sharing violation names file and rollback');
      check(fs.existsSync(w.workspace), '1016: sharing failure is before commit');
      const id = fs.readdirSync(join(w.registryRoot, 'move-journals'))[0]!; equal(rollBack(w, id).refusal, null, '1016: sharing failure rolls back');
    } else check(true, '1016: Windows sharing violation does not apply on POSIX');
    const empty = fixture(); fs.mkdirSync(empty.destination);
    const result = move.moveLibrary({ ...empty.options, preflight: false, userConfirmed: true, planId: empty.plan.plan_id }); equal(result.refusal, null, '1016: empty destination moved: ' + result.refusal);
    if (!result.refusal) {
      equal(rollBack(empty, (result.value as Record<string, any>).run_id).refusal, null, '1016: empty destination restored');
      same(fs.readdirSync(empty.destination), [], '1016: original empty destination remains empty');
    }
    for (const timing of ['before-done', 'after-done']) {
      const w = fixture(); fs.mkdirSync(w.destination);
      const moved = move.moveLibrary({ ...w.options, preflight: false, userConfirmed: true, planId: w.plan.plan_id });
      equal(moved.refusal, null, '1016: empty-folder rollback fault setup');
      if (moved.refusal) continue;
      const id = (moved.value as Record<string, any>).run_id;
      const preview = move.moveLibrary({ ...w.options, rollback: id, preflight: true });
      const stopped = move.moveLibrary({ ...w.options, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id, faultAt: 'rollback-empty:' + timing });
      check(stopped.refusal?.includes('Injected move fault') === true, '1016: empty destination rollback rename fault reached');
      equal(rollBack(w, id).refusal, null, '1016: empty destination rollback rename continues');
      same(fs.readdirSync(w.destination), [], '1016: interrupted empty destination restored');
    }
    const stale = fixture();
    const stopped = move.moveLibrary({ ...stale.options, preflight: false, userConfirmed: true, planId: stale.plan.plan_id, faultAt: 'cutover:after-done' }); check(stopped.refusal !== null, '1016: recovery plan drift setup');
    const id = fs.readdirSync(join(stale.registryRoot, 'move-journals'))[0]!;
    const preview = move.moveLibrary({ ...stale.options, rollback: id, preflight: true });
    put(stale.pointer, 'changed after recovery preview');
    check(move.moveLibrary({ ...stale.options, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id }).refusal?.includes('recovery changed since the preview') === true, '1016: rollback approval binds current outside bytes');
    equal(rollBack(stale, id).refusal, null, '1016: fresh rollback preview accepts drift and lists it');
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
    const file = join(folder, entry.name);
    return entry.isDirectory() ? [file + '/', ...snapshot(file)] : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  const destination = process.platform === 'win32'
    ? join(root.slice(0, 3), 'dev', 'w48-preview-' + root.split(/[\\/]/).pop()) : join(root, 'destination');
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, '1018: fixture initialized');
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
        equal(result.exit, 0, '1018: preview succeeds without the switch: ' + result.stderr);
        if (result.exit === 0 && json) equal(JSON.parse(result.stdout).written, false, '1018: JSON preview records no write');
        if (!json) check(result.stdout.includes('Nothing was written.'), '1018: plain preview reports no write');
      }
      check(!(result.stdout + result.stderr).includes('turned off'), '1018: move no longer reports an off switch');
      check(JSON.stringify(snapshot(root)) === JSON.stringify(before), '1018: whole fixture stays unchanged');
      check(!fs.existsSync(destination), '1018: destination stays absent');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1017(): Promise<void> {
  const move = await import('../../src/librarymove.ts');
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'c164-1017-')));
  const saved = ['HOME', 'USERPROFILE', 'APPDATA'].map(key => [key, process.env[key]] as const);
  const put = (file: string, text: string) => { fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, text); };
  // No exclusions: folders, empty folders, barriers, journal backups and copied journals all count.
  const snapshot = (folder: string): string[] => fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(folder, entry.name);
    return entry.isDirectory() ? ['folder:' + file, ...snapshot(file)] : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
  let serial = 0;
  const fixture = (point = 'registry:after-done', vault = false) => {
    const folder = join(root, String(++serial)), workspace = join(folder, 'source'), destination = join(folder, 'destination'), registryRoot = join(folder, 'registry'), home = join(folder, 'home');
    for (const [key] of saved) process.env[key] = home;
    put(join(workspace, '.library/workspace.json'), JSON.stringify({ id: 'fixture' })); fs.mkdirSync(join(workspace, 'internal'));
    if (vault) fs.mkdirSync(join(workspace, '.obsidian'));
    put(join(workspace, 'page.md'), 'source bytes'); put(join(workspace, '.mcp.json'), JSON.stringify({ path: workspace }));
    put(join(home, '.claude.json'), JSON.stringify({ path: workspace }));
    if (process.platform !== 'win32') fs.chmodSync(join(home, '.claude.json'), 0o600);
    const registry = join(registryRoot, 'workspaces.json'); put(registry, JSON.stringify({ workspaces: [{ id: 'fixture', path: workspace }] }));
    const options = { workspace, destination, registryRoot, destinationRule: 'any' as const, processTable: () => [], preflight: false, userConfirmed: true };
    const plan = move.previewLibraryMove({ ...options, preflight: true }).value as Record<string, any>;
    const stopped = move.moveLibrary({ ...options, planId: plan.plan_id, faultAt: point });
    check(stopped.refusal?.includes('Injected move fault') === true, '1017: setup reaches ' + point);
    const id = fs.readdirSync(join(registryRoot, 'move-journals'))[0]!;
    const journalFile = join(registryRoot, 'move-journals', id, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const writeJournal = () => put(journalFile, JSON.stringify(journal));
    const rollback = () => {
      const preview = move.moveLibrary({ ...options, rollback: id, preflight: true });
      return move.moveLibrary({ ...options, rollback: id, planId: (preview.value as Record<string, any>)?.plan_id });
    };
    return { folder, workspace, destination, registry, options, id, journalFile, journal, writeJournal, rollback, plan };
  };
  type Fixture = ReturnType<typeof fixture>;
  type Case = { name: string; expected: string; point?: string; prepare?: (w: Fixture) => void; command?: (w: Fixture) => Parameters<typeof move.moveLibrary>[0]; cwd?: boolean };
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
    { name: 'source manifest differs', expected: 'differs from its manifest', prepare: w => put(join(w.journal.aside, 'page.md'), 'changed') },
    { name: 'destination manifest differs', expected: 'differs from its manifest', prepare: w => put(join(w.destination, 'page.md'), 'changed') },
    { name: 'confirmation missing', expected: '--preflight, then its --user-confirmed', command: w => ({ ...w.options, resume: w.id, userConfirmed: false }) },
    { name: 'rollback plan missing', expected: '--preflight, then its --user-confirmed', command: w => ({ ...w.options, rollback: w.id }) },
    { name: 'stale recovery plan', expected: 'The recovery changed since the preview', command: w => ({ ...w.options, resume: w.id, planId: 'stale' }) },
    { name: 'inside current folder', expected: 'run it from a folder outside', cwd: true },
    { name: 'writer running', expected: 'close it, then run the command again', command: w => ({ ...w.options, resume: w.id, processTable: () => [{ pid: 990001, parentPid: 0, name: 'codex' }] }) },
    { name: 'unreadable process table', expected: 'The process table could not be read', command: w => ({ ...w.options, resume: w.id, processTable: () => { throw new Error('fixture table'); } }) },
    { name: 'invalid resume location', expected: 'Only a move past its commit point', point: 'promote:after-done' },
    { name: 'resume after rollback', expected: 'Only a move past its commit point', prepare: w => equal(w.rollback().refusal, null, '1017: completed rollback setup') },
    { name: 'changed registry row', expected: 'The moved registry row changed', prepare: w => { const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8')); doc.workspaces[0].id = 'changed'; put(w.registry, JSON.stringify(doc)); }, command: w => {
      const preview = move.moveLibrary({ ...w.options, rollback: w.id, preflight: true });
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } },
    { name: 'invalid registry JSON', expected: 'JSON', prepare: w => put(w.registry, '{'), command: w => {
      const preview = move.moveLibrary({ ...w.options, rollback: w.id, preflight: true });
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } },
  ];
  // s215 row 3: a foreign barrier where recovery would place its own refuses before the first step, so neither the
  // journal nor the destination's journal copy is written.
  const foreign = (folder: string) => put(join(folder, 'internal/maintenance-barrier.json'), JSON.stringify({ run_id: 'move-other-run', operation: 'Library move', reason: 'fixture' }) + '\n');
  cases.push({ name: 'foreign barrier at a completed destination, rolled back', expected: 'belongs to another run', point: 'journal-copy:after-done', prepare: w => {
    equal(move.moveLibrary({ ...w.options, resume: w.id }).refusal, null, '1017: completed move setup');
    check(fs.existsSync(join(w.destination, 'internal/move-journals', w.id, 'journal.json')), '1017: completed move keeps a destination journal copy');
    foreign(w.destination);
  }, command: w => {
    const preview = move.moveLibrary({ ...w.options, rollback: w.id, preflight: true });
    return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
  } });
  cases.push({ name: 'foreign barrier at the aside of a stopped move, resumed', expected: 'belongs to another run', prepare: w => foreign(w.journal.aside) });
  // s215 row 2: a row that is neither the source's nor the destination's still refuses before any rename.
  cases.push({ name: 'registry row for another folder', expected: 'The moved registry row changed', prepare: w => {
    const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8')); doc.workspaces[0].path = join(w.folder, 'elsewhere'); put(w.registry, JSON.stringify(doc));
  }, command: w => {
    const preview = move.moveLibrary({ ...w.options, rollback: w.id, preflight: true });
    return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
  } });
  for (const kind of ['duplicate-target', 'duplicate-source', 'case-alias']) {
    if (kind === 'case-alias' && process.platform !== 'win32') { check(true, '1017: Windows case-alias registry row skipped on POSIX'); continue; }
    cases.push({ name: kind, expected: 'The moved registry row changed', prepare: w => {
      const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8'));
      if (kind === 'duplicate-source') doc.workspaces = [{ ...w.journal.registryRow }, { ...w.journal.registryRow }];
      else doc.workspaces.push({ ...doc.workspaces[0], path: kind === 'case-alias' ? w.destination.toUpperCase() : w.destination });
      put(w.registry, JSON.stringify(doc));
    }, command: w => {
      const preview = move.moveLibrary({ ...w.options, rollback: w.id, preflight: true });
      return { ...w.options, rollback: w.id, planId: (preview.value as Record<string, any>).plan_id };
    } });
  }
  try {
    for (const row of cases) {
      const w = fixture(row.point); row.prepare?.(w);
      const options = row.command?.(w) ?? { ...w.options, resume: w.id };
      const previous = process.cwd();
      try {
        if (row.cwd) process.chdir(w.journal.aside);
        const before = snapshot(w.folder), result = move.moveLibrary(options);
        check(result.refusal?.includes(row.expected) === true, '1017: ' + row.name + ' refuses: ' + result.refusal);
        same(snapshot(w.folder), before, '1017: ' + row.name + ' changes no byte');
      } finally { process.chdir(previous); }
    }
    // s215 row 2: the rollback judges a restored source row by its resolved path, so its readback must too. The row is an
    // alias of the source (a trailing separator; a case alias on Windows), beside an unrelated registry edit.
    for (const alias of ['trailing separator', 'case alias']) {
      if (alias === 'case alias' && process.platform !== 'win32') { check(true, '1017: Windows case-alias restored row skipped on POSIX'); continue; }
      const w = fixture();
      const doc = JSON.parse(fs.readFileSync(w.registry, 'utf8'));
      doc.workspaces[0].path = alias === 'case alias' ? w.workspace.toUpperCase() : w.workspace + (process.platform === 'win32' ? '\\' : '/');
      doc.workspaces.push({ id: 'unrelated', path: join(w.folder, 'unrelated') });
      put(w.registry, JSON.stringify(doc));
      const result = w.rollback();
      equal(result.refusal, null, '1017: rollback with a restored ' + alias + ' row completes');
      equal((result.value as Record<string, any> | null)?.state, 'rolled-back', '1017: ' + alias + ' rollback reaches rolled-back');
      check(fs.existsSync(join(w.workspace, 'page.md')) && !fs.existsSync(w.destination), '1017: ' + alias + ' rollback restores the source and moves the destination aside');
      same(JSON.parse(fs.readFileSync(w.registry, 'utf8')), doc, '1017: ' + alias + ' rollback leaves the restored registry as written');
    }
    for (const action of ['start', 'resume', 'rollback'] as const) {
      const w = fixture('registry:after-done', true);
      equal(w.plan.inside_obsidian_vault, true, '1017: Library itself is a vault at ' + action + ' preview');
      equal(w.plan.obsidian_vault, w.workspace, '1017: preview names the Library vault');
      if (action === 'start') equal(w.rollback().refusal, null, '1017: vault start restores setup');
      const preview = action === 'start' ? move.previewLibraryMove({ ...w.options, preflight: true }) : move.moveLibrary({ ...w.options, [action]: w.id, preflight: true });
      equal(preview.refusal, null, '1017: vault recovery preview');
      const before = snapshot(w.folder);
      const result = move.moveLibrary({ ...w.options, ...(action === 'start' ? {} : { [action]: w.id }), planId: (preview.value as Record<string, any>).plan_id,
        processTable: () => [{ pid: 990001, parentPid: 0, name: 'Obsidian' }] });
      check(result.refusal?.includes('Obsidian') === true, '1017: Library vault refuses Obsidian at ' + action);
      same(snapshot(w.folder), before, '1017: Library vault ' + action + ' refusal changes no byte');
    }
    if (process.platform === 'win32') {
      console.log('1017: private-file permission assertions skipped on Windows; the Linux check proves them');
      check(true, '1017: POSIX pointer and journal modes skipped on Windows');
    } else {
      const w = fixture('journal-copy:after-done');
      equal(move.moveLibrary({ ...w.options, resume: w.id }).refusal, null, '1017: private-file move completes');
      const mode = (file: string) => fs.statSync(file).mode & 0o7777;
      const pointer = join(w.folder, 'home/.claude.json');
      equal(mode(pointer), 0o600, '1017: private pointer stays 0600 after move');
      for (const folder of [w.journal.directory, join(w.destination, 'internal/move-journals', w.id)]) {
        equal(mode(folder), 0o700, '1017: private journal folder is 0700');
        for (const file of fs.readdirSync(folder)) equal(mode(join(folder, file)), 0o600, '1017: private journal file is 0600: ' + file);
      }
      equal(w.rollback().refusal, null, '1017: private-file rollback completes');
      equal(mode(pointer), 0o600, '1017: private pointer stays 0600 after rollback');
    }
    // rollbackMove's rolled-back branch returns without a step; it has no refusal of its own.
    // Later barrier, rename and readback throws are effects after step(), covered by 1015 and 1016.
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
      const preview = move.previewLibraryMove(options);
      equal(preview.refusal, null, '1019: preview: ' + row.name);
      const value = preview.value as Record<string, any>;
      if (!value) continue;
      const pointer = value.pointers.find((p: { file: string }) => p.file === join(library, row.file));
      equal(pointer?.occurrences ?? 0, row.after === 'rewrite' ? 1 : 0, '1019: occurrences: ' + row.name);
      equal(pointer?.ambiguous ?? 0, row.after === 'ambiguous' ? 1 : 0, '1019: ambiguous count: ' + row.name);
      equal(value.expected_destination_manifest.find((r: { relative: string }) => r.relative === row.file)?.sha256, sha(expected), '1019: expected manifest: ' + row.name);
      const stopped = move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: value.plan_id, faultAt: 'promote:before' });
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
      const plan = move.previewLibraryMove(options).value as Record<string, any>;
      const original = tree(workspace), priorRegistry = bytes(registry), priorPointer = bytes(join(home, '.claude.json'));
      const stopped = move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: plan.plan_id, faultAt: 'journal-copy:file' });
      check(stopped.refusal?.includes('Injected move fault at journal-copy:file') === true, '1020: fault reached inside the journal copy: ' + stopped.refusal);
      const id = fs.readdirSync(join(registryRoot, 'move-journals'))[0]!, outside = join(registryRoot, 'move-journals', id), copy = join(destination, 'internal/move-journals', id);
      check(fs.readdirSync(outside).length > 1, '1020: the outside journal holds more than one file');
      equal(fs.readdirSync(copy).length, 1, '1020: the move stopped after the journal copy\'s first file');
      if (recovery === 'resume') {
        const result = move.moveLibrary({ ...options, destination: undefined, resume: id, preflight: false, userConfirmed: true });
        equal(result.refusal, null, '1020: resume inside the journal copy: ' + result.refusal);
        same(tree(copy), tree(outside), '1020: resumed journal copy equals the outside journal folder');
        same(JSON.parse(fs.readFileSync(registry, 'utf8')).workspaces, [{ id: 'fixture-resume', path: destination, default: true }], '1020: resumed registry row names the destination');
        check(!fs.existsSync(join(destination, 'internal/maintenance-barrier.json')), '1020: resumed destination barrier lifted');
      } else {
        const preview = move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: true });
        equal(preview.refusal, null, '1020: rollback preview: ' + preview.refusal);
        if (preview.refusal) continue;
        const result = move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id });
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
    const plan = move.previewLibraryMove(options);
    equal(plan.refusal, null, '1022: preview: ' + plan.refusal);
    if (plan.refusal) return;
    const planned = plan.value as Record<string, any>;
    for (const file of files) {
      const pointer = planned.pointers.find((row: { file: string }) => row.file === join(workspace, file));
      equal(pointer?.occurrences, process.platform === 'win32' ? 3 : 2, '1022: occurrences planned in ' + file);
    }
    const moved = move.moveLibrary({ ...options, preflight: false, userConfirmed: true, planId: planned.plan_id });
    equal(moved.refusal, null, '1022: the move ran to the end: ' + moved.refusal);
    if (moved.refusal) return;
    equal((moved.value as Record<string, any>).state, 'complete', '1022: the move is complete');
    for (const file of files) {
      const text = fs.readFileSync(join(destination, file), 'utf8');
      check(bytes(join(destination, file)) !== before.get(file) && !text.includes(values.run!.replace(/\\/g, file === '.agents/notes.md' ? '\\' : '\\\\')),
        '1022: the move rewrote the run of separators in ' + file + ', so no inverse of the rewrite gives its bytes back');
    }
    const id = (moved.value as Record<string, any>).run_id as string;
    const preview = move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: true });
    equal(preview.refusal, null, '1022: rollback preview: ' + preview.refusal);
    if (preview.refusal) return;
    const result = move.moveLibrary({ ...options, destination: undefined, rollback: id, preflight: false, userConfirmed: true, planId: (preview.value as Record<string, any>).plan_id });
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
      equal(result.exit, 0, `1023: ${name} preview: ${result.stderr}`);
      const value = result.exit === 0 ? JSON.parse(result.stdout) as Record<string, any> : {};
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
    'import { moveLibrary as actual } from ' + JSON.stringify(actual) + '; ' +
    'export const moveLibrary = options => actual({ ...options, processTable: () => [] });');
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
    equal(result.exit, 0, '1060: preview succeeds: ' + result.stderr);
    const plan = result.exit === 0 ? JSON.parse(result.stdout) : {};
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
