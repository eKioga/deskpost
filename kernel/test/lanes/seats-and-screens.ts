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
    put(join(workspace, '.mcp.json'), `${workspace}\n${process.platform === 'win32' ? workspace.toLowerCase().replace(/\\/g, '/') : workspace}\n${workspace}-different\n`);
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
      if (process.platform === 'win32') check(human.stdout.includes('Who may rewrite: orca') && human.stdout.includes('Who may rewrite: unknown'), '1011: human names Orca and unreadable files');
    } finally { unlock?.(); }
    const runPreview = () => runCli(['library', 'move', destination, '--preflight', '--workspace', workspace, '--registry-root', registry, '--json'], { cwd: root, env });
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
    else check(!command.stderr.includes('close it, then run the command again'), '1014: real Linux table passes the quiet check');
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
  const message = 'deskpost library move is turned off in this release because a known fault can rewrite unrelated paths; it returns in a later release, and nothing was changed.';
  try {
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, '1018: fixture initialized');
    const forms = [[join(root, 'destination'), '--preflight'], [join(root, 'destination'), '--user-confirmed', '--plan-id', 'fixture'], ['--resume', 'fixture'], ['--rollback', 'fixture']];
    for (const form of forms) for (const json of [false, true]) {
      const before = snapshot(root);
      const result = runCli(['library', 'move', ...form, '--workspace', workspace, '--registry-root', registry, ...(json ? ['--json'] : [])], { cwd: root, env });
      check(result.exit !== 0, '1018: move form refused: ' + form[0]);
      check(result.stderr.includes(message), '1018: refusal explains fault, return and unchanged state');
      if (json) {
        let value: unknown;
        try { value = JSON.parse(result.stdout); } catch { /* The check reports invalid or missing JSON. */ }
        check(value !== null && typeof value === 'object' && !Array.isArray(value), '1018: JSON refusal is one object on standard output');
        equal((value as { refusal?: string } | undefined)?.refusal, message, '1018: JSON names the refusal');
      } else equal(result.stdout, '', '1018: plain refusal has no standard output');
      check(JSON.stringify(snapshot(root)) === JSON.stringify(before), '1018: entire fixture byte-identical');
      check(!fs.existsSync(join(workspace, 'internal/library-move')), '1018: no move journal');
    }
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
if (selected(1010)) await section1010();
if (selected(1011)) await section1011();
if (selected(1012)) await section1012();
if (selected(1013)) await section1013();
if (selected(1014)) await section1014();
if (selected(1015)) await section1015();
if (selected(1016)) await section1016();
if (selected(1018)) await section1018();
}
