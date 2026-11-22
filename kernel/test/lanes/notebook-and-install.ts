/**
 * THE NOTEBOOK-AND-INSTALL LANE'S SELF-TEST SECTIONS (PLAN-lane-test-files.md; kickoffs/s210 row 1). This lane's new sections go here,
 * numbered in its range in docs/areas.json `section_ranges` (1600 to 1799), and claim their kernel/src files in
 * `notebook-and-install.covers.json` beside this file. kernel/test/selftest.ts awaits `runLane` after its last own section, so all of
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
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

let selected: Harness['selected'], prerequisite: Harness['prerequisite'], check: Harness['check'], equal: Harness['equal'], same: Harness['same'];
let failures: Harness['failures'], runCli: Harness['runCli'], runCliAsync: Harness['runCliAsync'];
let HERE: Harness['HERE'], PROGRAM_ROOT: Harness['PROGRAM_ROOT'], KERNEL_COMMAND: Harness['KERNEL_COMMAND'], isCompiled: Harness['isCompiled'];

function refusalFixture(label: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root,
    LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const run = (args: string[]) => runCli(args, { cwd: root, env });
  return { root, env, run, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function refusalObject(ran: { stdout: string; stderr: string }, verb: string, action: string | null, label: string) {
  let value: unknown;
  try { value = JSON.parse(ran.stdout); } catch { check(false, label + ': exactly one JSON object'); return; }
  same(value, { status: 'refused', refusal: ran.stderr.trimEnd(), verb, action }, label + ': refusal object');
}

async function section1600(): Promise<void> {
  const w = refusalFixture('c160-1600-');
  try {
    for (const args of [['hub', 'edit', 'projects/x', '--mode', 'check-item', '--section', 'Now', '--match-text', 'a', '--preflight'],
      ['capture', 'reports'], ['book', 'nosuch'], ['desk'], ['hub', 'edit', '--nosuch']]) {
      const plain = w.run(args), json = w.run([...args, '--json']);
      equal(json.exit, 1, '1600: exit ' + args.join(' '));
      equal(json.stderr, plain.stderr, '1600: unchanged standard error');
      if (args[0] === 'hub' && args[2] === 'projects/x') {
        try {
          const value = JSON.parse(json.stdout);
          equal(value.status, 'refused', '1600: hub workspace status');
          equal(value.verb, 'hub edit', '1600: hub workspace verb');
          equal(value.message, json.stderr.trimEnd(), '1600: hub workspace message');
        } catch { check(false, '1600: hub workspace exactly one object'); }
      } else refusalObject(json, args[0]!, args[0] === 'hub' ? 'edit' : null, '1600: ' + args.join(' '));
    }
    for (const args of [['nosuch', '--json'], ['desk'], ['seat', 'start', 'nosuch', '--', '--json']]) {
      const ran = w.run(args);
      equal(ran.exit, 1, '1600: plain refusal exit'); equal(ran.stdout, '', '1600: no JSON requested by this command');
    }
    const workspace = path.join(w.root, 'ws');
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1600: init fixture');
    const own = w.run(['hub', 'edit', 'nosuch', '--mode', 'check-item', '--section', 'Now', '--match-text', 'a', '--workspace', workspace, '--json']);
    equal(own.exit, 1, '1600: hub own refusal');
    try { const value = JSON.parse(own.stdout); equal(value.verb, 'hub edit', '1600: preserves hub own object'); }
    catch { check(false, '1600: hub prints exactly one object'); }
    const { runClosing } = await import('../../src/install.ts');
    const child = path.join(w.root, 'refuse.mjs');
    fs.writeFileSync(child, "process.stdout.write(JSON.stringify({status:'refused',refusal:'fixture refusal'})+'\\n'); process.stderr.write('fixture refusal\\n'); process.exitCode=1;\n");
    const said: string[] = [];
    const closing = runClosing({ args: { json: false } as Parameters<typeof runClosing>[0]['args'], say: text => said.push(text) }, process.execPath, [child]);
    equal(closing.report, null, '1600: refusal is no report'); equal(closing.detail, 'fixture refusal', '1600: closing detail');
    check(said.includes('fixture refusal'), '1600: closing says standard error');
  } finally { w.dispose(); }
}

async function section1601(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c160-1601-')));
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root,
    LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  try {
    for (const action of ['edit', 'tidy']) for (const json of [false, true]) {
      const ran = runCli(['hub', action, 'projects/x', ...(action === 'edit' ? ['--mode', 'check-item', '--section', 'Now', '--match-text', 'a'] : []),
        '--preflight', ...(json ? ['--json'] : [])], { cwd: root, env });
      equal(ran.exit, 1, `1601: ${action} ${json}: exit`);
      check(ran.stderr.includes('no Library workspace was selected'), '1601: workspace refusal');
      try {
        const value = JSON.parse(ran.stdout);
        equal(value.status, 'refused', '1601: status'); equal(value.verb, 'hub ' + action, '1601: verb');
        equal(value.message, ran.stderr.trimEnd(), '1601: same message as standard error');
      } catch { check(false, `1601: ${action} ${json}: exactly one object`); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1602(): Promise<void> {
  const w = refusalFixture('c160-1602-');
  try {
    for (const args of [['kickoff', 'check', 'a.md', 'b.md'], ['kickoff', 'check', 'a.md', '--nosuch']]) {
      const plain = w.run(args), json = w.run([...args, '--json']);
      equal(plain.exit, 2, '1602: usage exits 2: ' + args.join(' '));
      equal(json.exit, 2, '1602: JSON usage exits 2');
      check(plain.stderr.includes(args.includes('--nosuch') ? 'has no --nosuch.' : 'was given 1 more: b.md.'), '1602: original refusal words');
      equal(json.stderr, plain.stderr, '1602: JSON keeps standard error');
      refusalObject(json, 'kickoff', 'check', '1602: usage refusal');
    }
    const send = w.run(['kickoff', 'send', '--nosuch', '--json']);
    equal(send.exit, 1, '1602: other action still exits 1');
    refusalObject(send, 'kickoff', 'send', '1602: send refusal');
  } finally { w.dispose(); }
}


async function section1603(): Promise<void> {
  const { enterSeatClaim, exitSeatClaim } = await import('../../src/seatclaim.ts');
  const w = refusalFixture('c160-1603-');
  const workspace = path.join(w.root, 'ws');
  let claim: ReturnType<typeof enterSeatClaim> | null = null;
  try {
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1603: init');
    equal(w.run(['hub', 'new', 'alpha', '--title', 'Alpha', '--workspace', workspace]).exit, 0, '1603: Hub');
    equal(w.run(['seat', 'start', 'first', '--project', 'alpha', '--command', 'codex', '--no-launch', '--workspace', workspace]).exit, 0, '1603: seat');
    claim = enterSeatClaim(path.join(workspace, '.claude'), 'first');
    const env = { ...w.env, LIBRARY_SEAT: 'first', LIBRARY_SEAT_CLAIM: claim.token, CLAUDE_PID: String(process.pid), DESKPOST_LAUNCHER_PID: '' };
    const cli = (args: string[], input?: string) => runCli(['checkpoint', ...args, '--conversation', 'c160-fixture', '--workspace', workspace],
      { cwd: w.root, env, ...(input === undefined ? {} : { input }) });
    for (const kind of ['closeout', 'save']) {
      const none = cli(['check', kind, '--json']);
      equal(none.stderr.trimEnd(), 'No pending request of that kind.', '1603: no request unchanged');
      check(none.exit !== 0, '1603: no request refuses');
      refusalObject(none, 'checkpoint', 'check', '1603: no request object');
      equal(cli(['request', kind]).exit, 0, '1603: request ' + kind);
      const answer = '```' + kind + '\n' + (kind === 'closeout' ? 'reports: none: fixture only\n' : '') + 'hub alpha: nothing new: fixture only\n```';
      const checked = cli(['check', kind], answer);
      equal(checked.exit, 0, '1603: first check ' + kind + ': ' + checked.stderr);
      const status = JSON.parse(checked.stdout)[kind === 'closeout' ? 'closeout' : 'saveState'];
      for (const json of [false, true]) {
        const again = cli(['check', kind, ...(json ? ['--json'] : [])], answer);
        check(again.exit !== 0, '1603: second check refuses');
        check(again.stderr.includes('already checked') && again.stderr.includes(status), '1603: checked state named');
        check(again.stderr.includes('deskpost checkpoint request ' + kind) && again.stderr.includes('once'), '1603: one check and new request remedy');
        if (json) refusalObject(again, 'checkpoint', 'check', '1603: second check object');
      }
    }
  } finally { exitSeatClaim(claim); w.dispose(); }
}


async function section1604(): Promise<void> {
  const { planView } = await import('../../src/setup.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c160-1604-')));
  const registry = path.join(root, 'registry');
  try {
    const answers: import('../../src/setup.ts').SetupAnswers = { schema: 1, version: '9.9.9', install_root: path.join(root, 'program'),
      install_state: 'repair', from_version: '9.9.9', library: null, library_state: 'none', repair: false, make_default: false,
      overlap_accepted: false, assistant: null, path_change: false };
    const refresh: import('../../src/setup.ts').SetupPlan = { schema: 1, operation: 'Plan a Deskpost setup', answers, library: null, register: null,
      refresh: [{ workspace: path.join(root, 'served'), decision: 'refresh', reason: null, plan: null }] };
    const repair: import('../../src/setup.ts').SetupPlan = { ...refresh, refresh: [],
      answers: { ...answers, library: path.join(root, 'ws'), library_state: 'existing', repair: true } };
    for (const plan of [refresh, repair, { ...repair, answers: { ...repair.answers, unguarded: true } }]) {
      const dry = planView(plan, registry, true).rows.map(row => row.note).join('\n');
      check(!dry.includes('will be') && !/(?<!would be )repaired \(/.test(dry), '1604: dry-run plan never promises a write: ' + dry);
      check(dry.includes('would'), '1604: dry-run plan says would');
    }
    check(planView(refresh, registry, true).rows.some(row => row.note.includes('would be brought up to date')), '1604: refresh dry-run');
    check(planView(repair, registry, true).rows.some(row => row.note === 'existing Library, would be repaired (its managed files brought up to date)'), '1604: repair dry-run');
    const unguarded = { ...repair, answers: { ...repair.answers, unguarded: true } };
    check(planView(unguarded, registry, true).rows.some(row => row.note.includes('would be registered again')), '1604: guard dry-run');
    check(planView(refresh, registry).rows.some(row => row.note.includes('will be brought up to date')), '1604: real refresh unchanged');
    check(planView(repair, registry).rows.some(row => row.note === 'existing Library, repaired (its managed files brought up to date)'), '1604: real repair unchanged');
    check(planView(unguarded, registry).rows.some(row => row.note.includes('they are registered again')), '1604: real guard repair unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1605(): Promise<void> {
  const { VERBS } = await import('../../src/verbs.ts');
  const w = refusalFixture('c160-1605-');
  const started = Date.now();
  try {
    const cases = Object.entries(VERBS).filter(([, declaration]) => declaration.ported)
      .flatMap(([verb, declaration]) => Object.keys(declaration.arguments).map(action => ({ verb, action,
        exit: declaration.usageExitCode?.[action] ?? 1 })));
    check(cases.length >= 155, '1605: at least the 155 ported verb/action pairs at 2659382f');
    check(cases.some(entry => entry.verb === 'kickoff' && entry.action === 'check'), '1605: includes kickoff check');
    check(cases.some(entry => entry.verb === 'hub' && entry.action === 'edit'), '1605: includes hub edit');
    for (let index = 0; index < cases.length; index += 8) {
      await Promise.all(cases.slice(index, index + 8).map(async entry => {
        const args = [entry.verb, ...(entry.action ? [entry.action] : []), '--c160-no-such-flag', '--json'];
        const ran = await runCliAsync(args, { cwd: w.root, env: w.env });
        equal(ran.exit, entry.exit, '1605: ' + args.join(' ') + ' exit');
        refusalObject(ran, entry.verb, entry.action || null, '1605: ' + entry.verb + ' ' + entry.action);
      }));
    }
    console.log('1605: ' + cases.length + ' verb/action pairs, ' + (Date.now() - started) + ' milliseconds');
    // Run 130 took 40.6 seconds with six CI workers; the Windows focused run took 17.213 seconds.
    check(Date.now() - started < 90_000, '1605: every verb check stays under 90 seconds');
  } finally { w.dispose(); }
}


async function section1606(): Promise<void> {
  const { notebookLinks } = await import('../../src/notebooklinks.ts');
  const w = refusalFixture('c160-1606-');
  try {
    const folder = path.join(w.root, 'collection', 'projects', 'alpha');
    fs.mkdirSync(folder, { recursive: true });
    const slash = w.root.replace(/\\/g, '/');
    fs.writeFileSync(path.join(folder, '_project.md'), '# Links\nlib/notebook/t/n.md\nlib\\notebook\\t\\n.md\n' +
      slash + '/notebook/t/n.md\nnotebook/t/n.md\n' + slash.toUpperCase().replace(/\//g, '\\') + '\\notebook\\t\\n.md\n');
    const links = notebookLinks(w.root);
    same(links.map(link => link.line), [4, 5, 6], '1606: only this root or bare Notebook paths');
    check(links.every(link => link.path === 'notebook/t/n.md'), '1606: canonical Notebook link');
  } finally { w.dispose(); }
}


async function section1607(): Promise<void> {
  const { emptyCheckpoint, observeCheckpointResult } = await import('../../src/checkpoint.ts');
  const state = emptyCheckpoint('c160-fixture', 'seat-one');
  const receipt = { status: 'amended', book: 'shelf/reports', report: 'notes/defect' };
  const observe = (output: unknown, exit_code = 0, command = 'deskpost reports amend notes/defect --content-path update.md') =>
    observeCheckpointResult(state, { command, output: JSON.stringify(output), exit_code }, 50);
  const writes = observe(receipt).writes;
  equal(writes.length, 1, '1607: amend is one reports write');
  equal(writes[0]?.kind, 'book', '1607: Book write');
  equal(writes[0]?.name, 'reports', '1607: reports Book');
  equal(writes[0]?.page, 'notes/defect', '1607: Report page');
  equal(writes[0]?.where, 'shelf', '1607: Shelf location');
  for (const refused of [{ ...receipt, status: 'refused' }, { ...receipt, refusal: 'no' }, { ...receipt, written: false }, { ...receipt, preflight: true }])
    equal(observe(refused).writes.length, 0, '1607: unsuccessful amend is no write');
  equal(observe(receipt, 1).writes.length, 0, '1607: failed process is no write');
  equal(observe(receipt, 0, 'deskpost reports amend notes/other').writes.length, 0, '1607: wrong page is no write');
  equal(observe({ ...receipt, book: 'shelf/letters' }).writes.length, 0, '1607: wrong Book is no write');
}


async function section1608(): Promise<void> {
  const { emptyCheckpoint, observeCheckpointResult, fillText } = await import('../../src/checkpoint.ts');
  const prompt = fillText([{ kind: 'hub', name: 'alpha' }, { kind: 'book', name: 'reports', where: 'shelf' }], 'alpha');
  const updatedLine = prompt.split('\n').find(line => line.includes('`updated <page>`')) ?? '';
  const cases: [string, unknown, string][] = [
    ['deskpost hub edit alpha --page notes/one', { status: 'written', page_path: 'projects/alpha/notes/one.md' }, 'hub edit'],
    ...['add-page', 'replace-page', 'graduate'].map(action => ['deskpost book ' + action + ' demo guide', { status: 'added', page: 'shelf/demo/wiki/guide.md' }, action] as [string, unknown, string]),
    ...['add-page', 'replace-page'].map(action => ['deskpost collection ' + action + ' demo guide', { status: 'added', page: 'collection/books/demo/wiki/guide.md' }, action] as [string, unknown, string]),
    ...['add-page', 'replace-page'].map(action => ['deskpost shared ' + action + ' demo guide', { verdict: 'written', book: 'shared/demo', page: 'books/demo/wiki/guide.md', shared_library_write: true }, action] as [string, unknown, string]),
    ['deskpost capture reports', { status: 'captured', note_page: 'shelf/reports/wiki/notes/defect.md' }, 'capture'],
    ['deskpost letters close notes/one', { status: 'closed', book: 'shelf/letters', letter: 'notes/one' }, 'letters close'],
    ['deskpost triage batch', { operation: 'Library Triage', status: 'complete', outcomes: [{ state: 'succeeded', skipped: false, result: { status: 'written', page: 'shelf/demo/wiki/guide.md' } }] }, 'triage batch'],
    ['deskpost reports amend notes/defect', { status: 'amended', book: 'shelf/reports', report: 'notes/defect' }, 'reports amend'],
  ];
  const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'kernel/src/checkpoint.ts'), 'utf8');
  const writerSource = source.slice(source.indexOf('function writers('), source.indexOf('\nfunction canonicalWrite('));
  const declared: string[] = [];
  for (const branch of writerSource.split('\n').filter(line => line.includes('if(') && line.includes("verb==='"))) {
    const verbs = [...branch.matchAll(/verb==='([^']+)'/g)].map(match => match[1]!);
    const group = /\[([^\]]+)\]\.includes\(action/.exec(branch);
    const actions = group ? [...group[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)
      : [...branch.matchAll(/action==='([^']+)'/g)].map(match => match[1]!);
    for (const verb of verbs) for (const action of actions.length ? actions : ['']) declared.push((verb + ' ' + action).trim());
  }
  const covered = cases.map(([command]) => command.split(' ').slice(1, command.startsWith('deskpost capture ') ? 2 : 3).join(' '));
  same(covered.sort(), declared.sort(), '1608: fixtures cover every writer branch both ways');
  for (const [command, output, wording] of cases) {
    const observed = observeCheckpointResult(emptyCheckpoint('c160-fixture', 'seat-one'), { command, output: JSON.stringify(output), exit_code: 0 }, 50);
    check(observed.writes.length > 0, '1608: fixture counts ' + command);
    equal(updatedLine, '   - `updated <page>`: only for a write the program recorded for this conversation. A preflight is not a write.', '1608: prompt names the program record for ' + wording);
  }
  const notACommand = observeCheckpointResult(emptyCheckpoint('c160-fixture', 'seat-one'), {
    command: 'deskpost collection graduate demo guide',
    output: JSON.stringify({ status: 'added', page: 'collection/books/demo/wiki/guide.md' }), exit_code: 0,
  }, 50);
  equal(notACommand.writes.length, 0, '1608: nonexistent collection graduate is not counted');
}


async function section1609(): Promise<void> {
  const w = refusalFixture('c160-1609-');
  const { hostRemedies } = await import('../../src/remedy.ts');
  const started = Date.now();
  try {
    const workspace = path.join(w.root, 'ws');
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1609: init');
    // Captured at 2659382fa7636d507bec266ae39674466f5916a1 in a detached worktree (c160-r5 row 3).
    const missing = path.join(w.root, 'missing.md');
    const cases: [string[], number, string][] = [
      [['kickoff', 'check'], 2, 'usage: library kickoff check <file> [--json] [--posted]\n'],
      [['kickoff', 'check', missing], 2, `kickoff-check: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`],
      [['kickoff', 'check', 'a.md', '--json', '--workspace'], 2, '--workspace needs a value after it.\n'],
      [['reports', 'triager', 'clerk', '--preflight'], 1, 'This Library has no Postbox yet: deskpost postbox setup --url <mcp-url> --preflight.\n'],
    ];
    for (const [args, exit, stderr] of cases) {
      const command = [...args.slice(0, 2), '--workspace', workspace, ...args.slice(2)];
      const plain = w.run(command.filter(word => word !== '--json'));
      const json = w.run([...command.slice(0, 2), '--json', ...command.slice(2)]);
      equal(json.exit, exit, '1609: exit ' + args.join(' '));
      equal(json.stderr, plain.stderr, '1609: unchanged standard error');
      equal(json.stderr, hostRemedies(stderr), '1609: standard error matches captured base bytes, as this host words them');
      refusalObject(json, args[0]!, args[1]!, '1609: ' + args.join(' '));
    }
    // judgeKickoff handles malformed text as verdict problems; no input text makes its judge throw.
    check(Date.now() - started < 20_000, '1609: direct refusal cases stay under 20 seconds');
  } finally { w.dispose(); }
}

async function section1610(): Promise<void> {
  const w = refusalFixture('c160-1610-');
  try {
    const temp = path.join(w.root, 'temp'), home = path.join(w.root, 'home');
    fs.mkdirSync(temp); fs.mkdirSync(home);
    const env = { ...w.env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home, LIBRARY_WORKSPACES: '' };
    const registry = path.join(home, '.library', 'workspaces.json');
    const inside = path.join(temp, 'inside'), outside = path.join(w.root, 'outside');
    const run = (args: string[]) => runCli(args, { cwd: w.root, env });
    const skipped = run(['init', inside, '--json']);
    equal(skipped.exit, 0, '1610: temporary init: ' + skipped.stderr);
    equal(JSON.parse(skipped.stdout).registration, 'skipped-temporary', '1610: temporary registration skipped');
    equal(JSON.parse(skipped.stdout).registry, registry, '1610: intended registry reported');
    check(!fs.existsSync(registry), '1610: home registry not created');
    const text = run(['init', inside]);
    check(text.stdout.includes('not added to this machine\'s Library list because it is in the temp directory') && text.stdout.includes('deskpost library default ' + inside), '1610: sentence and remedy');
    check(!text.stdout.includes('Registered in'), '1610: no false registration');
    const registered = run(['init', outside, '--json']);
    equal(registered.exit, 0, '1610: outside init');
    check(JSON.parse(registered.stdout).registration !== 'skipped-temporary', '1610: outside registered');
    check(fs.readFileSync(registry, 'utf8').includes(outside.replace(/\\/g, '\\\\')), '1610: outside in registry');
    check(run(['init', outside]).stdout.includes('Registered in'), '1610: outside keeps original line');
    const fixtureRegistry = path.join(temp, 'registry');
    const explicit = run(['init', inside, '--registry-root', fixtureRegistry, '--json']);
    equal(explicit.exit, 0, '1610: explicit fixture registry');
    check(JSON.parse(explicit.stdout).registration !== 'skipped-temporary', '1610: temp registry written');
    check(fs.existsSync(path.join(fixtureRegistry, 'workspaces.json')), '1610: explicit registry exists');
  } finally { w.dispose(); }
}

async function section1611(): Promise<void> {
  const w = refusalFixture('c160-1611-');
  try {
    const temp = path.join(w.root, 'temp'), home = path.join(w.root, 'home');
    fs.mkdirSync(temp); fs.mkdirSync(home);
    const env = { ...w.env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home, LIBRARY_WORKSPACES: '' };
    const run = (args: string[]) => runCli(args, { cwd: w.root, env });
    for (const [folder, skipped] of [[path.join(temp, 'ws'), true], [path.join(w.root, 'outside'), false]] as const) {
      const init = run(['init', folder, '--registry-root', path.join(temp, 'registry'), '--json']);
      equal(init.exit, 0, '1611: init');
      const plan = path.join(w.root, 'plan.json');
      fs.writeFileSync(plan, JSON.stringify({ schema: 1, operation: 'Plan a Deskpost setup', answers: { make_default: false },
        library: null, register: { workspace: folder, id: JSON.parse(init.stdout).id } }));
      const applied = run(['setup', '--apply', '--plan-file', plan, '--json']);
      equal(applied.exit, 0, '1611: setup apply: ' + applied.stderr);
      equal(JSON.parse(applied.stdout).library.registration === 'skipped-temporary', skipped, '1611: registration decision');
      const text = run(['setup', '--apply', '--plan-file', plan]);
      equal(text.exit, 0, '1611: setup text');
      check(text.stdout.includes('was left as it is'), '1611: left as it is');
      if (skipped) {
        check(text.stdout.includes('not added to this machine\'s Library list because it is in the temp directory') && text.stdout.includes('deskpost library default ' + folder), '1611: temp sentence and remedy');
        check(!fs.existsSync(path.join(home, '.library', 'workspaces.json')), '1611: no home registry written');
      } else check(text.stdout.includes('is registered'), '1611: normal wording unchanged');
    }
  } finally { w.dispose(); }
}

async function section1612(): Promise<void> {
  const { powerShellLiteral } = await import('../../src/init.ts');
  const w = refusalFixture('c160-1612-');
  const started = Date.now();
  try {
    const rows = [0x27, 0x2018, 0x2019, 0x201a, 0x201b].map(code => {
      const root = path.join(w.root, 'quote' + String.fromCharCode(code) + ';Write-Output marker;#');
      const hooks = path.join(root, '.claude', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      for (const file of fs.readdirSync(path.join(PROGRAM_ROOT, '.claude', 'hooks'), { withFileTypes: true })) {
        if (file.isFile()) fs.copyFileSync(path.join(PROGRAM_ROOT, '.claude', 'hooks', file.name), path.join(hooks, file.name));
      }
      check(fs.existsSync(path.join(hooks, 'Guard-BasicMemoryRead.ps1')), '1612: fixture hook exists');
      const target = path.join(root, 'kernel', 'src', 'cli.ts').replace(/\\/g, '/');
      return { target, hooks, command: `& 'node' ${powerShellLiteral(target)} hook checkpoint` };
    });
    const data = path.join(w.root, 'input.json'), script = path.join(w.root, 'parse.ps1');
    fs.writeFileSync(data, JSON.stringify({ rows, bindings: path.join(PROGRAM_ROOT, 'tools', 'CodexBindings.ps1'), template: path.join(PROGRAM_ROOT, '.codex', 'hooks.template.json') }));
    fs.writeFileSync(script, [
      "$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$inputData = [IO.File]::ReadAllText($args[0]) | ConvertFrom-Json', '. $inputData.bindings',
      'function Read-Command($text) {', '  $tokens = $null; $errors = $null',
      '  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)',
      '  $statements = @($ast.EndBlock.Statements)', '  $argument = $null',
      '  if ($statements.Count -eq 1) { $elements = @($statements[0].PipelineElements[0].CommandElements); if ($elements.Count -gt 1) { $argument = $elements[1].Value } }',
      '  @{ count = $statements.Count; argument = $argument; errors = @($errors).Count }', '}',
      '$results = @()', 'foreach ($row in $inputData.rows) {',
      '  $results += Read-Command $row.command',
      '  $document = New-CodexHooksDocument -TemplatePath $inputData.template -HookDirectory $row.hooks | ConvertFrom-Json',
      '  $results += Read-Command $document.hooks.Stop[0].hooks[0].commandWindows', '}',
      'ConvertTo-Json -InputObject $results -Depth 8 -Compress',
    ].join('\n'));
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, data], { cwd: w.root, env: { ...process.env, ...w.env }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    equal(ran.status, 0, '1612: PowerShell parser: ' + ran.stderr);
    if (ran.status === 0) {
      const parsed = JSON.parse(ran.stdout);
      equal(parsed.length, 10, '1612: both writers for every quote');
      rows.forEach((row, index) => {
        for (const offset of [0, 1]) {
          const one = parsed[index * 2 + offset];
          equal(one.count, 1, '1612: one statement for quote ' + index + ' writer ' + offset);
          equal(one.errors, 0, '1612: no parser errors');
          equal(one.argument, row.target, '1612: literal argument round trip');
        }
      });
    }
    check(Date.now() - started < 20000, '1612: under 20 seconds');
  } finally { w.dispose(); }
}

async function section1613(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { McpSession } = await import('../../src/basicmemory.ts');
  const { emptyCheckpoint, observeCheckpointResult } = await import('../../src/checkpoint.ts');
  const w = refusalFixture('c160-1613-'), workspace = path.join(w.root, 'ws'), storage = path.join(w.root, 'server');
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
  let server: ReturnType<typeof spawn> | null = null;
  const env = { ...w.env, CLAUDE_PID: String(agent.pid) };
  const cli = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: w.root, env });
  const put = (relative: string, text: string) => { const file = path.join(w.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  try {
    equal(cli(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1613: init');
    equal(cli(['hub', 'new', 'alpha', '--title', 'Alpha']).exit, 0, '1613: Hub');
    const enter = ['seat', 'enter', 'first', '--create', '--project', 'alpha', '--agent-pid', String(agent.pid), '--deadline-seconds', '10'];
    equal(cli([...enter, '--plan-id', JSON.parse(cli([...enter, '--preflight']).stdout).plan_id]).exit, 0, '1613: seat');
    put('server/books/README.md', '# Books\n\n## Open a Book\n'); put('server/projects/README.md', '# Projects\n\n## Projects\n');
    const port = path.join(w.root, 'server.port');
    server = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), storage, port], { stdio: 'ignore', windowsHide: true });
    const until = Date.now() + 15000;
    while (!fs.existsSync(port) || !fs.readFileSync(port, 'utf8').trim()) {
      if (Date.now() > until) throw Error('1613: stand-in server did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = 'http://127.0.0.1:' + fs.readFileSync(port, 'utf8').trim() + '/mcp';
    const session = new McpSession(url, 'c160-1613'); await session.initialize();
    put('ws/internal/postbox/state.json', JSON.stringify({ schema: 1, url, project_name: 'deskpost', project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
      library_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', library_card: 'Fixture', server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    equal(cli(['basic-memory', 'setup', '--url', url, '--collection', 'stand-in-collection', '--shared-writes', 'on', '--json']).exit, 0, '1613: connection');
    const gated = (args: string[]) => {
      const preview = cli([...args, '--seat', 'first', '--preflight', '--json']);
      equal(preview.exit, 0, '1613: preview: ' + preview.stderr);
      return cli([...args, '--seat', 'first', '--user-confirmed', '--plan-id', JSON.parse(preview.stdout).plan_id, '--json']);
    };
    equal(gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Fixture.']).exit, 0, '1613: shared Book');
    const content = put('content.md', '# Start\n');
    for (const action of ['add-page', 'replace-page']) {
      if (action === 'replace-page') fs.writeFileSync(content, '# Start\n\nChanged.\n');
      const args = ['shared', action, 'demo', 'start', '--content-path', content];
      const ran = gated(args);
      equal(ran.exit, 0, '1613: apply: ' + ran.stderr);
      const receipt = JSON.parse(ran.stdout);
      console.log('1613 actual ' + action + ' receipt: ' + JSON.stringify(receipt));
      const command = 'deskpost shared ' + action + ' demo start --content-path content.md';
      const observe = (output: unknown, commandLine = command, exit_code = 0) => observeCheckpointResult(emptyCheckpoint('fixture', 'first'), { command: commandLine, output: JSON.stringify(output), exit_code }, 50).writes;
      const writes = observe(receipt);
      equal(writes.length, 1, '1613: one shared Book write per success');
      if (writes.length) same({ kind: writes[0]!.kind, name: writes[0]!.name, where: writes[0]!.where, page: writes[0]!.page }, { kind: 'book', name: 'demo', where: 'shared', page: 'start' }, '1613: correct page and Book');
      equal(observe(receipt, command + ' --preflight').length, 0, '1613: preflight command counts none');
      equal(observe(receipt, command, 1).length, 0, '1613: failed process counts none');
      equal(observe(receipt, command.replace('demo start', 'other start')).length, 0, '1613: mismatched command counts none');
      for (const invalid of [{ ...receipt, status: 'refused' }, { ...receipt, verdict: 'refused' }, { ...receipt, preflight: true }, { ...receipt, written: false }, { ...receipt, shared_library_write: false }, { ...receipt, book: 'shared/other' }])
        equal(observe(invalid).length, 0, '1613: refused, preview, failed or mismatched receipt counts none');
      for (const contradiction of [
        { verdict: 'refused' }, { verdict: 'preview' }, { verdict: 'written', shared_library_write: false },
      ]) equal(observe({ ...receipt, status: 'written', written: true, ...contradiction }).length, 0, '1613: generic success cannot override incomplete shared receipt: ' + JSON.stringify(contradiction));
    }
  } finally {
    server?.kill(); agent.kill();
    // Remove only this section's disposable Library and stand-in server after stopping its children.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { fs.rmSync(w.root, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    check(!fs.existsSync(w.root), '1613: fixture children stopped and cleanup finished');
  }
}

async function section1614(): Promise<void> {
  const w = refusalFixture('c160-1614-');
  try {
    const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
    check(!source.includes('refresh-served'), '1614: installer has no unapproved refresh');
    const start = source.indexOf('# --- the closing check'), end = source.indexOf('# --- end of manual Library update ---');
    check(start >= 0 && end > start, '1614: installer explains the manual Library update');
    if (start < 0 || end <= start) return;
    const closing = source.slice(start, end);
    const quoteStart = source.indexOf('sh_quote()');
    check(quoteStart >= 0, '1614: shared POSIX quoting function');
    const functions = quoteStart < 0 ? '' : source.slice(quoteStart, source.indexOf('\n}', quoteStart) + 2);
    const posix = (value: string) => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase());
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    for (const exit of [0, 1]) {
      const root = path.join(w.root, 'install-' + exit), log = path.join(root, 'calls');
      const binary = path.join(root, 'current', 'bin', 'library');
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" "$PATH" >> ${quote(posix(log))}\ncase "$PATH" in "$BIN_DIR":*) exit ${exit} ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
      const script = path.join(root, 'step.sh');
      fs.writeFileSync(script, `set -eu\nINSTALL_ROOT=${quote(posix(root))}\nexport BIN_DIR="$INSTALL_ROOT/bin"\nDESKPOST_WORKSPACE=''\nfail() { printf 'install.sh: %s\\n' "$1" >&2; exit 1; }\nsay() { printf '%s\\n' "$1"; }\n${functions}\n${closing}\n`);
      const ran = spawnSync('sh', [posix(script)], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      equal(ran.status, exit, '1614: doctor controls install outcome: ' + ran.stderr);
      check(fs.existsSync(log), '1614: doctor was called: ' + ran.stderr);
      if (fs.existsSync(log)) {
        const calls = fs.readFileSync(log, 'utf8').trimEnd().split('\n');
        equal(calls.length, 2, '1614: doctor ran once with one argument');
        equal(calls[0], 'doctor', '1614: doctor argument');
        check(calls[1]?.startsWith(posix(root) + '/bin:') === true, '1614: install bin first on doctor PATH');
      }
      if (exit) {
        check(ran.stderr.includes('library doctor is not green'), '1614: existing doctor failure message');
        check(!ran.stdout.includes('were not brought up to date'), '1614: failure prints no manual update line');
      } else {
        const lines = ran.stdout.trimEnd().split('\n');
        check(lines.at(-2)?.includes('is not on PATH; add it to your shell profile.') === true, '1614: PATH advice precedes update line');
        check(lines.at(-1)?.includes('were not brought up to date by this installer') === true && lines.at(-1)?.includes(' init <folder>') === true, '1614: manual update is last');
      }
    }
    const root = posix(w.root) + '/$(touch marker)`touch marker`"\'root';
    const advice = source.split('\n').find(line => line.startsWith('say "The Libraries'))!;
    const plugin = source.split('\n').find(line => line.includes('Run: claude plugin marketplace add'))!;
    for (const [line, prefix, suffix, expected] of [
      [advice, '; run ', ' init <folder>', root + '/current/bin/library'],
      [plugin, 'marketplace add ', ' && claude plugin install', root + '/current'],
    ] as const) {
      const printScript = path.join(w.root, 'print.sh');
      fs.writeFileSync(printScript, `INSTALL_ROOT=${quote(root)}\nsay() { printf '%s\\n' "$1"; }\n${functions}\n${line}\n`);
      const printed = spawnSync('sh', [posix(printScript)], { cwd: w.root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      equal(printed.status, 0, '1614: print command for hostile root: ' + printed.stderr);
      const from = printed.stdout.indexOf(prefix), to = printed.stdout.indexOf(suffix, from + prefix.length);
      check(from >= 0 && to > from, '1614: printed command boundaries');
      if (from < 0 || to <= from) continue;
      const words = printed.stdout.slice(from + prefix.length, to);
      const parseScript = path.join(w.root, 'parse.sh');
      fs.writeFileSync(parseScript, `sh -c ${quote(`printf '%s\\n' ${words}`)}\n`);
      const parsed = spawnSync('sh', [posix(parseScript)], { cwd: w.root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      equal(parsed.status, 0, '1614: printed command parsed by sh: ' + parsed.stderr);
      equal(parsed.stdout, expected + '\n', '1614: printed path round trips byte for byte');
      check(!fs.existsSync(path.join(w.root, 'marker')), '1614: printed command executes no root content');
    }
  } finally { w.dispose(); }
}

async function section1615(): Promise<void> {
  const { scopeIndexDrift, invokeNotebookRender } = await import('../../src/notebook.ts');
  const w = refusalFixture('c160-1615-');
  try {
    const root = path.join(w.root, 'notebook', 'first');
    const scope: import('../../src/notebooklayout.ts').NotebookScope = { workspace: w.root, root, seat: 'first', layout: 'seat-owned', activates: false, relative: 'notebook/first' };
    fs.mkdirSync(path.join(root, 'topic'), { recursive: true });
    const master = path.join(root, '_master-index.md'), prior = '# Notebook Index\n';
    fs.writeFileSync(master, prior);
    const drift = scopeIndexDrift(scope).join('\n');
    check(drift.includes("create the topic's _index.md with your own file tools"), '1615: drift names own file tools');
    check(drift.includes('library notebook render'), '1615: drift names repair command');
    let refusal = '';
    try { invokeNotebookRender(scope); } catch (error) { refusal = (error as Error).message; }
    check(refusal.includes("Create the topic's _index.md with your own file tools"), '1615: render refusal names own file tools');
    check(refusal.includes('library notebook render'), '1615: render refusal names repair command');
    equal(fs.readFileSync(master, 'utf8'), prior, '1615: refusal preserves master index');
    fs.writeFileSync(path.join(root, 'topic', '_index.md'), '# Repaired topic\n');
    equal(invokeNotebookRender(scope).topic_count, 1, '1615: own file tools then render repairs it');
    same(scopeIndexDrift(scope), [], '1615: repaired index has no drift');
  } finally { w.dispose(); }
}

async function section1616(): Promise<void> {
  const { powerShellLiteral } = await import('../../src/init.ts');
  for (const code of [0x27, 0x2018, 0x2019, 0x201a, 0x201b]) {
    const quote = String.fromCharCode(code);
    equal(powerShellLiteral('a' + quote + 'b'), "'a" + quote + quote + "b'", '1616: quote doubled ' + code);
  }
  equal(powerShellLiteral('C:/plain/path'), "'C:/plain/path'", '1616: plain path unchanged');
}

async function section1617(): Promise<void> {
  const { emptyCheckpoint, observeCheckpointResult } = await import('../../src/checkpoint.ts');
  const command = 'deskpost reports amend notes/defect --content-path update.md';
  const receipt = { status: 'amended', book: 'shelf/reports', report: 'notes/defect' };
  const writes = (output: unknown, cmd = command, exit_code = 0) => observeCheckpointResult(emptyCheckpoint('fixture', 'first'), { command: cmd, output: JSON.stringify(output), exit_code }, 50).writes;
  same(writes(receipt).map(({ kind, name, where, page }) => ({ kind, name, where, page })), [{ kind: 'book', name: 'reports', where: 'shelf', page: 'notes/defect' }], '1617: successful amend is one Reports Book write');
  equal(writes(receipt, command + ' --preflight').length, 0, '1617: preflight command is no write');
  equal(writes(receipt, command, 1).length, 0, '1617: failed command is no write');
  for (const invalid of [{ ...receipt, status: 'preview' }, { ...receipt, status: 'refused' }, { ...receipt, preflight: true }, { ...receipt, written: false }, { ...receipt, refusal: 'not allowed' }])
    equal(writes(invalid).length, 0, '1617: preview, refusal or failure is no write');
}

async function section1618(): Promise<void> {
  const { notebookLinks } = await import('../../src/notebooklinks.ts');
  const w = refusalFixture('c160-1618-');
  try {
    const project = path.join(w.root, 'collection', 'projects', 'alpha');
    fs.mkdirSync(project, { recursive: true });
    const slash = w.root.replace(/\\/g, '/');
    fs.writeFileSync(path.join(project, '_project.md'), [
      '# Links', 'lib/notebook/t/n.md', 'lib\\notebook\\t\\n.md', 'mynotebook/t/n.md',
      'notebook/t/n.md', slash + '/notebook/t/n.md', slash.replace(/\//g, '\\') + '\\notebook\\t\\n.md',
      'lib/mynotebook/t/n.md', 'notebook-x/t/n.md', '',
    ].join('\n'));
    const links = notebookLinks(w.root);
    same(links.map(link => link.line), [5, 6, 7], '1618: bare and this Library root count; longer relative paths do not');
    check(links.every(link => link.path === 'notebook/t/n.md'), '1618: every accepted path is canonical');
  } finally { w.dispose(); }
}

async function section1619(): Promise<void> {
  const w = refusalFixture('c160-1619-');
  try {
    const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('sh_quote() {'), end = source.indexOf('\n}', start);
    check(start >= 0 && end > start, '1619: shared POSIX quoting function');
    if (start < 0 || end <= start) return;
    const functions = source.slice(start, end + 2);
    const posix = (value: string) => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase());
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const run = (script: string) => {
      const file = path.join(w.root, 'step.sh');
      fs.writeFileSync(file, script + '\n');
      return spawnSync('sh', [posix(file)],
        { cwd: w.root, env: { ...process.env, ...w.env }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    };
    const sed = run('command -v sed');
    equal(sed.status, 0, '1619: locate the system sed before changing PATH');
    check(sed.stdout.trim().startsWith('/'), '1619: system sed has an absolute path');
    if (sed.status !== 0 || !sed.stdout.trim().startsWith('/')) return;
    const folders = [path.join(w.root, 'bsd-sed'), path.join(w.root, 'refusing-sed')];
    for (const folder of folders) fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folders[0]!, 'sed'), `#!/bin/sh\n${quote(sed.stdout.trim())} "$@" | awk '{print}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(folders[1]!, 'sed'), "#!/bin/sh\nprintf 'sed called\\n' >&2\nexit 1\n", { mode: 0o755 });
    const values = ["a'$(y)`z`\"b", "ends'", '', 'line one\nline two'];
    for (const value of values) {
      const baseline = run(functions + '\nsh_quote ' + quote(value));
      for (const [label, folder] of [['system', null], ['BSD-like sed', folders[0]], ['refusing sed', folders[1]]] as const) {
        const prefix = folder ? `PATH=${quote(posix(folder))}:"$PATH"\n` : '';
        const ran = run(functions + '\n' + prefix + 'sh_quote ' + quote(value));
        equal(ran.status, 0, `1619: ${label}: quote exits zero`);
        equal(ran.stderr, '', `1619: ${label}: quote has no standard error`);
        equal(ran.stdout, baseline.stdout, `1619: ${label}: identical quote bytes for ${JSON.stringify(value)}`);
        check(ran.stdout.endsWith("'") && !ran.stdout.endsWith('\n'), `1619: ${label}: ends at closing quote`);
        const roundTrip = run('sh -c ' + quote("printf '%s' " + ran.stdout));
        equal(roundTrip.status, 0, `1619: ${label}: round-trip exits zero`);
        equal(roundTrip.stderr, '', `1619: ${label}: round-trip has no standard error`);
        equal(roundTrip.stdout, value, `1619: ${label}: literal value round-trips`);
      }
    }
  } finally { w.dispose(); }
}

async function section1620(): Promise<void> {
  const started = performance.now();
  const { spawn } = await import('node:child_process');
  let server: ReturnType<typeof spawn> | null = null;
  const ledger = await import('../../src/checkpoint.ts');
  check(typeof ledger.readWriteLedger === 'function', '1620: front door ledger exists');
  if (typeof ledger.readWriteLedger !== 'function') return;
  const { enterSeatClaim, exitSeatClaim } = await import('../../src/seatclaim.ts');
  const w = refusalFixture('c167-1620-'), workspace = path.join(w.root, 'ws');
  const { argumentTable, commandAction } = await import('../../src/verbs.ts');
  let claim: ReturnType<typeof enterSeatClaim> | null = null;
  const env = { ...w.env, CODEX_HOME: path.join(w.root, 'codex'), CLAUDE_CONFIG_DIR: path.join(w.root, 'claude'),
    CODEX_THREAD_ID: 'c167-ledger-codex', CLAUDE_CODE_SESSION_ID: 'c167-ledger-claude',
    LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(process.pid) };
  const cli = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: w.root, env });
  const put = (name: string, body: string) => { const file = path.join(w.root, name); fs.writeFileSync(file, body); return file; };
  const receipts: Record<string, unknown> = {};
  const run = (label: string, args: string[], gated = false) => {
    let command = args;
    const before = ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length;
    if (gated) {
      const preview = cli([...args, '--preflight', '--json']);
      equal(preview.exit, 0, '1620: preview ' + label + ': ' + preview.stderr);
      equal(ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length, before, '1620: preview writes no ledger ' + label);
      if (preview.exit !== 0) return null;
      const action = commandAction(args[0]!, args.slice(1)).action;
      const confirms = argumentTable(args[0]!, action).boolean?.includes('user-confirmed');
      const plan = JSON.parse(preview.stdout);
      command = [...args, ...(confirms ? ['--user-confirmed'] : []), '--plan-id', plan.refresh_plan_id ?? plan.plan_id];
    }
    const result = cli([...command, '--json']);
    equal(result.exit, 0, '1620: ' + label + ': ' + result.stderr);
    if (result.exit !== 0) return null;
    const receipt = JSON.parse(result.stdout); receipts[label] = receipt;
    const read = ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID), entry = read.entries.at(-1);
    equal(read.entries.length, before + 1, '1620: one entry ' + label);
    equal(entry?.state, 'committed', '1620: committed ' + label);
    check(!!entry?.targets?.length || entry?.unattributed === true, '1620: targets or explicit unattributed ' + label);
    same(ledger.readWriteLedger(workspace, env.CLAUDE_CODE_SESSION_ID).entries, read.entries, '1620: both identities ' + label);
    console.log('1620 writer ' + label + ': ' + JSON.stringify(entry));
    const records = fs.readFileSync(path.join(workspace, 'internal/checkpoints/ledger', env.CODEX_THREAD_ID + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.entry === entry?.entry);
    same(records.map(row => row.state), ['started', 'committed'], '1620: exactly one start and completion ' + label);
    return receipt;
  };
  try {
    equal(cli(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1620: init');
    equal(cli(['hub', 'new', 'alpha', '--title', 'Alpha']).exit, 0, '1620: initial Hub');
    equal(cli(['seat', 'start', 'first', '--project', 'alpha', '--command', 'codex', '--no-launch']).exit, 0, '1620: seat');
    claim = enterSeatClaim(path.join(workspace, '.claude'), 'first'); env.LIBRARY_SEAT = 'first'; env.LIBRARY_SEAT_CLAIM = claim.token;
    const content = put('content.md', '# Page\n\nOriginal.\n'), addition = put('addition.md', 'Added.\n');
    run('hub new', ['hub', 'new', 'beta', '--title', 'Beta']);
    run('hub edit add-section', ['hub', 'edit', 'alpha', '--mode', 'add-section', '--section', 'Evidence', '--content-path', addition]);
    run('hub edit append-section', ['hub', 'edit', 'alpha', '--mode', 'append-section', '--section', 'Evidence', '--content-path', addition]);
    run('hub edit replace-section', ['hub', 'edit', 'alpha', '--mode', 'replace-section', '--section', 'Evidence', '--content-path', addition], true);
    run('hub edit remove-section', ['hub', 'edit', 'alpha', '--mode', 'remove-section', '--section', 'Evidence'], true);
    const item = put('item.md', '- [ ] Fixture task.\n');
    run('hub edit append Now', ['hub', 'edit', 'alpha', '--mode', 'append-section', '--section', 'Now', '--content-path', item]);
    run('hub edit check-item', ['hub', 'edit', 'alpha', '--mode', 'check-item', '--section', 'Now', '--match-text', 'Fixture task.'], true);
    const second = put('second.md', '- [ ] Another fixture.\n');
    run('hub edit insert-item', ['hub', 'edit', 'alpha', '--mode', 'insert-item', '--section', 'Now', '--after', 'Fixture task.', '--content-path', second]);
    const replaced = put('replaced.md', '- [ ] Another fixture with evidence.\n');
    run('hub edit replace-item', ['hub', 'edit', 'alpha', '--mode', 'replace-item', '--section', 'Now', '--match-text', 'Another fixture.', '--content-path', replaced], true);
    run('hub edit close-item', ['hub', 'edit', 'alpha', '--mode', 'close-item', '--section', 'Now', '--match-text', 'Fixture task.']);
    run('hub edit new-page', ['hub', 'edit', 'alpha', '--mode', 'new-page', '--page', 'notes/proof', '--content-path', content]);
    run('hub edit remove-page', ['hub', 'edit', 'alpha', '--mode', 'remove-page', '--page', 'notes/proof'], true);
    const body = put('hub-body.md', '# Alpha\n\n## Purpose\n\nFixture.\n\n## Now\n\n- [ ] Remaining task.\n\n## Next\n\n## Extra\n\nFixture.\n');
    run('hub edit replace-body', ['hub', 'edit', 'alpha', '--mode', 'replace-body', '--content-path', body], true);
    run('shelf new', ['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'Fixture.']);
    equal(cli(['desk', 'open', 'book', 'demo', '--location', 'shelf']).exit, 0, '1620: open Book');
    run('book add-page', ['book', 'add-page', 'demo', 'guide', '--content-path', content]);
    const replacement = put('replacement.md', '# Page\n\nRevised.\n');
    const preview = cli(['book', 'replace-page', 'demo', 'guide', '--content-path', replacement, '--preflight']);
    equal(preview.exit, 0, '1620: replace preview');
    run('book replace-page', ['book', 'replace-page', 'demo', 'guide', '--content-path', replacement, '--base-sha256', JSON.parse(preview.stdout).current_sha256]);
    fs.writeFileSync(path.join(workspace, 'shelf/demo/wiki/_index.md'), '# Demo\n');
    run('book reader-map', ['book', 'reader-map', 'demo']);
    const mapArgs = ['book', 'reader-map', 'demo', '--workspace', workspace, '--json'];
    const withoutLedger = runCli(mapArgs, { cwd: w.root, env: { ...env, CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' } });
    // A directory at the ledger file path refuses append on both Windows and POSIX, without an elevated-user bypass.
    fs.mkdirSync(path.join(workspace, 'internal/checkpoints/ledger/unwritable-fixture.jsonl'));
    const failedLedger = runCli(mapArgs, { cwd: w.root, env: { ...env, CODEX_THREAD_ID: 'unwritable-fixture', CLAUDE_CODE_SESSION_ID: '' } });
    same(failedLedger, withoutLedger, '1620: ledger write failure leaves stdout, stderr and exit identical');
    equal(failedLedger.exit, 0, '1620: ledger write failure preserves successful unchanged command');
    equal(ledger.readWriteLedger(workspace, 'unwritable-fixture').ledger, 'unreadable', '1620: failed append is unreadable on next read');
    const graduateBefore = ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length;
    const graduate = cli(['book', 'graduate', 'demo', '--source-path', content]);
    check(graduate.exit !== 0, '1620: graduate has no applying writer');
    check(!ledger.LEDGER_WRITERS.book!.includes('graduate'), '1620: preview-only graduate removed from writer audit');
    equal(ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length, graduateBefore, '1620: graduate has no mutation ledger');
    const sources = put('sources.json', JSON.stringify({ schema: 1, pin: null, sources: [{ id: 'manual', address: 'https://example.invalid/manual', kind: 'web', feeds: [] }] }));
    const sourcePreview = cli(['book', 'sources', 'demo', '--set', '--content-path', sources, '--preflight']);
    equal(sourcePreview.exit, 0, '1620: sources preview');
    run('book sources', ['book', 'sources', 'demo', '--set', '--content-path', sources, '--base-sha256', JSON.parse(sourcePreview.stdout).current_sha256]);
    run('shelf describe', ['shelf', 'describe', 'demo', '--summary', 'Revised fixture.'], true);
    const note = run('hub edit for undo', ['hub', 'edit', 'alpha', '--mode', 'replace-section', '--section', 'Extra', '--content-path', replacement], true);
    if (note) {
      const undone = run('undo', ['undo', path.basename(String(note.journal), '.json')]);
      if (undone) run('redo', ['redo', String(undone.id)]);
    }
    const report = run('capture', ['capture', 'reports', '--title', 'Fixture report', '--content-path', addition]);
    equal(cli(['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1620: open Reports');
    if (report) run('reports amend', ['reports', 'amend', String(report.note_page).replace(/^shelf\/reports\/wiki\//, '').replace(/\.md$/, ''), '--content-path', addition]);
    if (report) run('reports withdraw', ['reports', 'withdraw', String(report.note_page).replace(/^shelf\/reports\/wiki\//, '').replace(/\.md$/, ''), '--note', 'Fixture resolved.']);
    run('shelf new letter Book', ['shelf', 'new', 'mail', '--title', 'Mail', '--summary', 'Fixture letters.', '--capture', '--letters']);
    // The fixture's own seat receives and closes its letter through the same writer as a real seat.
    const letter = run('capture letter', ['capture', 'letters', '--title', 'Fixture letter', '--for', 'first', '--why', 'for-seat', '--content-path', addition]);
    equal(cli(['desk', 'open', 'book', 'letters', '--location', 'shelf']).exit, 0, '1620: open letters');
    if (letter) run('letters close', ['letters', 'close', String(letter.note_page).replace(/^shelf\/letters\/wiki\//, '').replace(/\.md$/, ''), '--note', 'Read fixture.']);
    run('publish', ['publish', 'demo', '--title', 'Demo', '--summary', 'Fixture.'], true);
    equal(cli(['desk', 'open', 'book', 'demo', '--location', 'collection']).exit, 0, '1620: open collection Book');
    run('collection add-page', ['collection', 'add-page', 'demo', 'extra', '--content-path', content], true);
    run('collection replace-page', ['collection', 'replace-page', 'demo', 'extra', '--content-path', replacement], true);
    run('shelf recall', ['shelf', 'recall', 'demo', '--shelf-slug', 'recalled'], true);
    equal(cli(['desk', 'open', 'book', 'recalled', '--location', 'shelf']).exit, 0, '1620: open recall');
    run('book add recalled page', ['book', 'add-page', 'recalled', 'later', '--content-path', content]);
    run('publish refresh', ['publish', 'refresh', 'recalled', '--title', 'Demo', '--summary', 'Refreshed fixture.'], true);
    run('shelf new disposable', ['shelf', 'new', 'disposable', '--title', 'Disposable', '--summary', 'Fixture.']);
    equal(cli(['desk', 'open', 'book', 'disposable', '--location', 'shelf']).exit, 0, '1620: open disposable');
    run('book add disposable page', ['book', 'add-page', 'disposable', 'guide', '--content-path', content]);
    run('shelf stub', ['shelf', 'stub', 'disposable', 'guide', '--canonical', 'demo/guide'], true);
    equal(cli(['desk', 'close', 'book', 'disposable', '--location', 'shelf']).exit, 0, '1620: close disposable');
    run('shelf rename', ['shelf', 'rename', 'disposable', 'renamed'], true);
    run('shelf archive', ['shelf', 'archive', 'renamed'], true);
    run('shelf restore', ['shelf', 'restore', 'renamed'], true);
    run('shelf remove', ['shelf', 'remove', 'renamed'], true);
    run('shelf new batch Book', ['shelf', 'new', 'batch-book', '--title', 'Batch', '--summary', 'Fixture.']);
    equal(cli(['desk', 'open', 'book', 'batch-book', '--location', 'shelf']).exit, 0, '1620: open batch Book');
    run('batch Book page', ['book', 'add-page', 'batch-book', 'guide', '--content-path', content]);
    const batch = put('batch.json', JSON.stringify({ items: [{ shelf_book_slug: 'batch-book', book_slug: 'batch-book', book_title: 'Batch', summary: 'Fixture.' }] }));
    run('publish batch', ['publish', 'batch', '--plan', batch], true);
    const raw = path.join(workspace, 'raw', 'fixture'); fs.mkdirSync(raw, { recursive: true }); fs.writeFileSync(path.join(raw, 'source.txt'), 'Source.');
    const synthesis = put('synthesis.md', '# Evidence\n\n## Key Takeaways\n\nFixture.\n');
    run('compile', ['compile', 'fixture', '--topic', 'proof', '--topic-title', 'Proof', '--topic-overview', 'Fixture.', '--article-slug', 'article', '--content-path', synthesis, '--source-file', 'source.txt']);
    run('notebook render', ['notebook', 'render']);
    const reset = run('reset', ['reset'], true);
    if (reset) run('reset restore', ['reset', 'restore', '--quarantine', path.basename(String(reset.quarantine_directory)), '--topic', 'proof'], true);
    const triageNote = run('capture for triage', ['capture', 'holding', '--title', 'Triage fixture', '--why', 'no-home', '--content-path', addition]);
    equal(cli(['desk', 'open', 'book', 'holding', '--location', 'shelf']).exit, 0, '1620: open Holding Shelf');
    if (triageNote) {
      const actions = put('triage.json', JSON.stringify([{ kind: 'review', source: 'holding', source_slug: 'holding', source_page: String(triageNote.note_page).replace(/^shelf\/holding\/wiki\//, '').replace(/\.md$/, '') }]));
      run('triage batch', ['triage', 'batch', '--actions-path', actions], true);
    }
    const done = put('done.md', '- [x] Decided fixture.\n');
    run('hub append done', ['hub', 'edit', 'alpha', '--mode', 'append-section', '--section', 'Now', '--content-path', done]);
    run('hub tidy', ['hub', 'tidy', 'alpha'], true);
    const { buildEnvelope } = await import('../../src/kickoffenvelope.ts');
    const kickoff = put('kickoff-letter.md', buildEnvelope('fixture-unit', '# Fixture unit\n\nRevision: **r1**.\n\nTRAIN: fixture\n\nWHY NOW: Fixture.\n\nOWNS PATHS:\n- `fixture.md`\n\nSTAY OUT OF: all else\n\nROWS:\n1. Exercise the fixture.\n   Done when: fixture passes.\n\nCHARTER: Fixture only.\n\nCLOSE: **Stop.**\n').text);
    const delivery = run('capture kickoff letter', ['capture', 'letters', '--title', 'Fixture Kickoff', '--for', 'first', '--why', 'for-seat', '--content-path', kickoff]);
    if (delivery) run('kickoff receive', ['kickoff', 'receive', String(delivery.note_page).replace(/^shelf\/letters\/wiki\//, '').replace(/\.md$/, '')]);
    const old = path.join(w.root, 'old');
    const oldEnv = { ...w.env, CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_HOME: env.CODEX_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR };
    equal(runCli(['init', old, '--registry-root', w.env.LIBRARY_WORKSPACES], { cwd: w.root, env: oldEnv }).exit, 0, '1620: old Library for carry');
    fs.writeFileSync(path.join(old, 'shelf/holding/wiki/notes/carried-fixture.md'), '---\ntitle: Carried fixture\ncaptured: 2026-01-01\nreview: pending\n---\n\nFixture.\n');
    run('shelf carry', ['shelf', 'carry', old, '--book', 'holding'], true);
    const oldDone = path.join(workspace, 'shelf/holding/wiki/notes/old-done.md');
    fs.writeFileSync(oldDone, '---\ntitle: Old done\ncaptured: 2026-01-01\nreview: done\nreviewed: 2026-01-01\n---\n\nFixture.\n');
    run('shelf tidy', ['shelf', 'tidy', 'holding', '--days', '0'], true);
    run('hub rename', ['hub', 'rename', 'beta', 'gamma', '--title', 'Gamma'], true);
    equal(cli(['desk', 'close', 'book', 'demo', '--location', 'collection']).exit, 0, '1620: close collection Book');
    run('shared archive', ['shared', 'archive', 'demo'], true);
    run('shared restore', ['shared', 'restore', 'demo'], true);
    const storage = path.join(w.root, 'server'); fs.mkdirSync(path.join(storage, 'books'), { recursive: true }); fs.mkdirSync(path.join(storage, 'projects'));
    fs.writeFileSync(path.join(storage, 'books/README.md'), '# Books\n\n## Open a Book\n'); fs.writeFileSync(path.join(storage, 'projects/README.md'), '# Projects\n\n## Projects\n');
    const port = path.join(w.root, 'server.port');
    server = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), storage, port], { stdio: 'ignore', windowsHide: true });
    const until = Date.now() + 15000;
    while (!fs.existsSync(port) || !fs.readFileSync(port, 'utf8').trim()) { if (Date.now() > until) throw Error('1620: stand-in server did not start'); await new Promise(resolve => setTimeout(resolve, 50)); }
    const url = 'http://127.0.0.1:' + fs.readFileSync(port, 'utf8').trim() + '/mcp';
    const { McpSession } = await import('../../src/basicmemory.ts'); const session = new McpSession(url, 'c167-1620'); await session.initialize();
    fs.mkdirSync(path.join(workspace, 'internal/postbox'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'internal/postbox/state.json'), JSON.stringify({ schema: 1, url, project_name: 'deskpost', project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', library_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', library_card: 'Fixture', server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    equal(cli(['basic-memory', 'setup', '--url', url, '--collection', 'stand-in-collection', '--storage', storage, '--shared-writes', 'on', '--json']).exit, 0, '1620: connection');
    run('shared new-book', ['shared', 'new-book', 'shared-demo', '--title', 'Shared demo', '--summary', 'Fixture.'], true);
    run('shared add-page', ['shared', 'add-page', 'shared-demo', 'guide', '--content-path', content], true);
    run('shared replace-page', ['shared', 'replace-page', 'shared-demo', 'guide', '--content-path', replacement], true);
    run('shared catalog-line', ['shared', 'catalog-line', 'shared-demo', '--title', 'Revised shared demo', '--summary', 'Revised fixture.'], true);
    const sharedSources = put('shared-sources.md', '# Sources\n\n```json\n' + fs.readFileSync(sources, 'utf8') + '\n```\n');
    run('shared sources', ['shared', 'sources', 'shared-demo', '--content-path', sharedSources], true);
    run('shared remove-page', ['shared', 'remove-page', 'shared-demo', 'guide'], true);
    run('shared promote', ['shared', 'promote', 'demo'], true);
    run('basic-memory import', ['basic-memory', 'import'], true);
    // Standing answer 9: the old Hub writers require the retired Basic Memory writer surface;
    // the delivery writers require a second Library's triager or an addressed incoming delivery.
    // Their receipt shapes are recorded from their front-door return objects, with no live server claim.
    for (const [verb, action, receipt, why] of [
      ['hub', 'copy-pages', { operation: 'Copy Local Pages to Project', created_records: ['projects/legacy/_project.md'], shared_library_write: true }, 'requires the retired Basic Memory writer surface'],
      ['hub', 'archive', { operation: 'Archive Project Hub', status: 'archived' }, 'requires the retired Basic Memory writer surface'],
      ['reports', 'send-pending', { status: 'sent-pending', count: 1, deliveries: [] }, 'requires a second Library with its pinned triager'],
      ['postbox', 'check', { filed: [{ book: 'letters', page: 'notes/incoming' }] }, 'requires an addressed delivery from a second Library'],
    ] as const) {
      const at = Date.now(), record: import('../../src/checkpoint.ts').LedgerRecord = { schema: 1, entry: 'recorded-' + verb + '-' + action, state: 'started', at, verb, action, mode: null, seat: 'first', claude_session: env.CLAUDE_CODE_SESSION_ID, codex_thread: env.CODEX_THREAD_ID };
      for (const id of [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID]) fs.appendFileSync(path.join(workspace, 'internal/checkpoints/ledger', id + '.jsonl'), JSON.stringify(record) + '\n');
      ledger.finishWriteLedger({ workspace, record, receipts: [receipt] }, 0);
      equal(ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.at(-1)?.state, 'committed', '1620: recorded receipt ' + verb + ' ' + action);
      console.log(`1620 writer ${verb} ${action}: fixture: none (${why}); recorded receipt: ${JSON.stringify(receipt)}`);
    }
    const before = ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length;
    const refused = cli(['book', 'add-page', 'missing', 'guide', '--content-path', content]);
    equal(refused.exit, 1, '1620: refusal exit');
    const last = ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.at(-1);
    equal(last?.state, 'unchanged', '1620: refused writer wrote nothing');
    equal(last?.targets, undefined, '1620: refused writer no targets');
    equal(ledger.readWriteLedger(workspace, env.CODEX_THREAD_ID).entries.length, before + 1, '1620: refused writer one entry');
    same(ledger.readWriteLedger(workspace, 'unrelated').entries, [], '1620: unrelated conversation empty');
  } finally {
    if (server && server.exitCode === null) { const stopped = new Promise(resolve => server!.once('exit', resolve)); server.kill(); await stopped; }
    exitSeatClaim(claim); w.dispose(); console.log('1620 elapsed seconds: ' + ((performance.now() - started) / 1000).toFixed(2));
  }
}

async function section1621(): Promise<void> {
  const ledger = await import('../../src/checkpoint.ts');
  check(typeof ledger.readWriteLedger === 'function', '1621: ledger reader exists');
  if (typeof ledger.readWriteLedger !== 'function') return;
  const { createHash } = await import('node:crypto');
  const w = refusalFixture('c167-1621-');
  const root = path.join(w.root, 'internal', 'checkpoints', 'ledger');
  fs.mkdirSync(root, { recursive: true });
  const at = Date.now() - 1000;
  const record: import('../../src/checkpoint.ts').LedgerRecord = { schema: 1, entry: 'fixture-entry', state: 'started', at,
    verb: 'book', action: 'add-page', mode: null, seat: 'first', claude_session: 'fixture-claude', codex_thread: 'fixture-codex' };
  const write = () => { for (const id of ['fixture-claude', 'fixture-codex']) fs.writeFileSync(path.join(root, id + '.jsonl'), JSON.stringify(record) + '\n'); };
  try {
    write();
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.state, 'uncertain', '1621: started without journal uncertain');
    const journals = path.join(w.root, 'internal', 'shelf-journals'); fs.mkdirSync(journals);
    const journal = path.join(journals, 'fixture.json'); fs.writeFileSync(journal, JSON.stringify({ entries: [] }));
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.state, 'uncertain', '1621: prior-state journal is not completion');
    const page = 'shelf/demo/wiki/proof.md', file = path.join(w.root, page); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'proof');
    const undo = { written_by_seat: 'first', paths: [{ path: page, after_sha256: createHash('sha256').update('proof').digest('hex') }] };
    fs.writeFileSync(journal, JSON.stringify({ operation: 'book-add-page', book_root: 'shelf/demo', undo }));
    fs.utimesSync(journal, new Date(at + 100), new Date(at + 100));
    const completed = ledger.readWriteLedger(w.root, 'fixture-codex');
    equal(completed.entries[0]?.state, 'committed', '1621: verified completed journal commits');
    equal(completed.entries[0]?.targets?.[0]?.page, 'proof', '1621: journal target');
    same(ledger.readWriteLedger(w.root, 'fixture-claude').entries, completed.entries, '1621: reconciled under both identities');
    const other = { ...record, entry: 'other-conversation-entry', claude_session: 'other-conversation', codex_thread: 'other-conversation' };
    fs.writeFileSync(path.join(root, 'other-conversation.jsonl'), JSON.stringify(other) + '\n');
    equal(ledger.readWriteLedger(w.root, 'other-conversation').entries[0]?.state, 'uncertain', '1621: another conversation cannot reuse a settled journal');
    equal(ledger.readWriteLedger(w.root, 'other-conversation').entries[0]?.state, 'uncertain', '1621: another conversation stays uncertain on reread');
    const racePage = 'shelf/race/wiki/proof.md', raceFile = path.join(w.root, racePage);
    fs.mkdirSync(path.dirname(raceFile), { recursive: true }); fs.writeFileSync(raceFile, 'race proof');
    fs.writeFileSync(path.join(journals, 'race.json'), JSON.stringify({ operation: 'book-add-page', book_root: 'shelf/race', undo: { written_by_seat: 'first', paths: [{ path: racePage, after_sha256: createHash('sha256').update('race proof').digest('hex') }] } }));
    const { Worker } = await import('node:worker_threads');
    const { pathToFileURL } = await import('node:url');
    const barrier = new SharedArrayBuffer(4), workers: InstanceType<typeof Worker>[] = [];
    try {
      const readers = ['race-one', 'race-two'].map(conversation => {
        fs.writeFileSync(path.join(root, conversation + '.jsonl'), JSON.stringify({ ...record, entry: conversation, target: 'race', claude_session: conversation, codex_thread: conversation }) + '\n');
        const worker = new Worker(`const {parentPort, workerData} = require('node:worker_threads');
          import(workerData.module).then(({readWriteLedger}) => { parentPort.postMessage('ready');
            Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
            parentPort.postMessage(readWriteLedger(workerData.workspace, workerData.conversation).entries[0]?.state);
          }).catch(error => { throw error; });`, { eval: true, workerData: { module: pathToFileURL(path.join(PROGRAM_ROOT, 'kernel/src/checkpoint.ts')).href, workspace: w.root, conversation, barrier },
          env: { ...process.env, ...w.env, CLAUDE_CODE_SESSION_ID: conversation, CODEX_THREAD_ID: conversation, CODEX_HOME: path.join(w.root, 'codex'), CLAUDE_CONFIG_DIR: path.join(w.root, 'claude') } });
        workers.push(worker);
        const ready = new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
        const result = new Promise<string>((resolve, reject) => { worker.on('message', value => { if (value !== 'ready') resolve(String(value)); }); worker.once('error', reject); });
        return { ready, result };
      });
      await Promise.all(readers.map(reader => reader.ready)); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      same((await Promise.all(readers.map(reader => reader.result))).sort(), ['committed', 'uncertain'], '1621: simultaneous conversations claim one journal once');
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
    // One completion belongs to one writer, and must identify its command and target.
    const secondJournal = path.join(journals, 'second.json'); fs.copyFileSync(journal, secondJournal);
    const first = { ...record, entry: 'first-interrupted', target: 'other' };
    const second = { ...record, entry: 'second-interrupted', target: 'demo' };
    const third = { ...second, entry: 'third-interrupted' };
    fs.writeFileSync(path.join(root, 'fixture-codex.jsonl'), [first, second, third].map(r => JSON.stringify(r)).join('\n') + '\n');
    let recovered = ledger.readWriteLedger(w.root, 'fixture-codex');
    equal(recovered.entries[0]?.state, 'uncertain', '1621: another Book journal cannot settle writer');
    equal(recovered.entries.filter(r => r.state === 'committed').length, 1, '1621: one journal settles at most one writer');
    recovered = ledger.readWriteLedger(w.root, 'fixture-codex');
    equal(recovered.entries[2]?.state, 'uncertain', '1621: journal remains consumed after reread');
    const saved = { ...ledger.emptyCheckpoint('fixture-codex'), savedAt: Date.now() + 1000 };
    check(ledger.checkpointLedger(saved, w.root).ledgerGaps!.some(g => g.includes('first-interrupted')), '1621: clean save cannot hide unresolved writer');
    fs.writeFileSync(journal, JSON.stringify({ operation: 'book-replace-page', book_root: 'shelf/demo', undo }));
    write();
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.state, 'uncertain', '1621: another action cannot settle writer');
    fs.writeFileSync(journal, JSON.stringify({ operation: 'book-add-page', book_root: 'shelf/demo', undo }));
    write(); fs.writeFileSync(file, 'changed');
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.state, 'uncertain', '1621: mismatched after hash uncertain');
    const run = { workspace: w.root, record, receipts: [{ status: 'unchanged' }] };
    ledger.finishWriteLedger(run, 0);
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.state, 'unchanged', '1621: unchanged is not committed');
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').entries[0]?.targets, undefined, '1621: unchanged no targets');
    fs.writeFileSync(path.join(w.root, 'internal', 'checkpoints', 'ledger-unreadable-fixture-codex'), 'unreadable');
    equal(ledger.readWriteLedger(w.root, 'fixture-codex').ledger, 'unreadable', '1621: failed write retained for next read');
    const fixture = await checkpointFixture('ledger-options');
    try {
      const other = path.join(fixture.root, 'second-library');
      equal(fixture.cli(['init', other, '--registry-root', fixture.env.LIBRARY_WORKSPACES]).exit, 0, '1621: second Library');
      const content = fixture.put('capture.md', 'Fixture.\n');
      // Run the real writer with both workspace options, keeping the parser's last value.
      const repeated = runCli(['capture', 'reports', '--title', 'Repeated workspace', '--content-path', content, '--workspace', fixture.workspace, '--workspace', other], { cwd: fixture.root, env: fixture.env });
      equal(repeated.exit, 0, '1621: repeated workspace capture');
      equal(ledger.readWriteLedger(other, fixture.env.CODEX_THREAD_ID).entries.at(-1)?.state, 'committed', '1621: last workspace gets ledger');
      const beforeTitle = ledger.readWriteLedger(fixture.workspace, fixture.env.CODEX_THREAD_ID).entries.length;
      const title = fixture.cli(['capture', 'reports', '--title', '--list', '--content-path', content]);
      equal(title.exit, 0, '1621: option value resembles flag');
      equal(ledger.readWriteLedger(fixture.workspace, fixture.env.CODEX_THREAD_ID).entries.at(-1)?.state, 'committed', '1621: title list is ledgered');
      equal(ledger.readWriteLedger(fixture.workspace, fixture.env.CODEX_THREAD_ID).entries.length, beforeTitle + 1, '1621: title list adds writer entry');
    } finally { fixture.dispose(); }
    const recovery = await checkpointFixture('writer-failures');
    try {
      const { pathToFileURL } = await import('node:url');
      const module = pathToFileURL(path.join(PROGRAM_ROOT, 'kernel/src/checkpoint.ts')).href;
      const script = recovery.put('finish.mjs', `import fs from 'node:fs'; import path from 'node:path';
        import {startWriteLedger,finishWriteLedger,readWriteLedger,checkpointLedger,emptyCheckpoint} from ${JSON.stringify(module)};
        const [workspace,conversation,args,change,beforeDispatch]=process.argv.slice(2);
        const run=startWriteLedger([...JSON.parse(args),'--workspace',workspace]);
        if(!run) throw Error('Writer did not start');
        if(change!=='null') {const {file,text}=JSON.parse(change);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
        finishWriteLedger(run,1,beforeDispatch==='true');
        console.log(JSON.stringify({started:run.record.at,entry:readWriteLedger(workspace,conversation).entries.at(-1),gaps:checkpointLedger(emptyCheckpoint(conversation),workspace).ledgerGaps}));`);
      const attempt = (id: string, args: string[], change: { file: string; text: string } | null = null, beforeDispatch = false) => {
        recovery.conversation(id);
        const ran = spawnSync(process.execPath, [script, recovery.workspace, id, JSON.stringify(args), JSON.stringify(change), String(beforeDispatch)], { cwd: recovery.root, env: { ...process.env, ...recovery.env }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
        equal(ran.status, 0, '1621: simulated writer finishes ' + id + ': ' + ran.stderr); return JSON.parse(ran.stdout);
      };
      const args = ['publish', 'refresh', 'missing'];
      let result = attempt('no-journal', args); equal(result.entry.state, 'unchanged', '1621: refusal with no journal wrote nothing');
      const changed = path.join(recovery.workspace, 'internal/publication-journals/changed.json');
      result = attempt('changed-journal', args, { file: changed, text: '{}' });
      equal(result.entry.state, 'uncertain', '1621: changed journal remains uncertain'); equal(result.entry.at, result.started, '1621: interrupted writer keeps its start time'); check(result.gaps.some((gap: string) => gap.includes(result.entry.entry)), '1621: changed journal gives a named gap');
      result = attempt('old-journal', args); equal(result.entry.state, 'unchanged', '1621: old unchanged journal does not make a gap');
      const custom = path.join(recovery.workspace, 'internal/custom-journal.json');
      result = attempt('custom-journal', [...args, '--journal-path', custom], { file: custom, text: '{}' }); equal(result.entry.state, 'uncertain', '1621: custom journal path counts');
      result = attempt('relative-custom-journal', [...args, '--journal-path', 'relative-journal.json'], { file: path.join(recovery.root, 'relative-journal.json'), text: '{}' }); equal(result.entry.state, 'uncertain', '1621: relative custom journal follows the writer working directory');
      const linked = path.join(recovery.workspace, 'internal/linked-journals');
      fs.symlinkSync(path.dirname(changed), linked, process.platform === 'win32' ? 'junction' : 'dir');
      result = attempt('unknown-journal-evidence', [...args, '--journal-path', linked]); equal(result.entry.state, 'uncertain', '1621: a linked journal probe is unknown evidence');
      result = attempt('before-dispatch', ['capture', 'reports', '--title', 'Fixture'], null, true); equal(result.entry.state, 'unchanged', '1621: refusal before dispatch wrote nothing');
      result = attempt('without-journal-evidence', ['capture', 'reports', '--title', 'Fixture']); equal(result.entry.state, 'uncertain', '1621: a dispatched failure with no journal evidence stays uncertain'); check(result.gaps.some((gap: string) => gap.includes(result.entry.entry)), '1621: a dispatched failure with no journal evidence gives a named gap');
      const article = path.join(recovery.workspace, 'notebook/topics/partial/article.md');
      result = attempt('compile-partial', ['compile', 'raw/batch', '--topic', 'partial', '--topic-title', 'Partial', '--topic-overview', 'Fixture.', '--article-slug', 'article'], { file: article, text: 'Partial article.\n' });
      equal(result.entry.state, 'uncertain', '1621: a compile that fails after its article write stays uncertain'); check(result.gaps.some((gap: string) => gap.includes(result.entry.entry)), '1621: a partial compile gives a named gap');
      equal(recovery.cli(['shelf', 'new', 'partial', '--title', 'Partial', '--summary', 'Fixture.']).exit, 0, '1621: partial publisher source');
      equal(recovery.cli(['desk', 'open', 'book', 'partial', '--location', 'shelf']).exit, 0, '1621: open partial source');
      const source = recovery.put('source.md', '# Page\n\nFixture source.\n');
      equal(recovery.cli(['book', 'add-page', 'partial', 'guide', '--content-path', source]).exit, 0, '1621: partial source page');
      equal(recovery.cli(['book', 'reader-map', 'partial']).exit, 0, '1621: partial source map');
      const refresh = ['publish', 'refresh', 'partial', '--title', 'Partial', '--summary', 'Fixture.'];
      const preview = recovery.cli([...refresh, '--preflight']); equal(preview.exit, 0, '1621: partial publisher preflight: ' + preview.stderr);
      const plan = JSON.parse(preview.stdout || '{}');
      recovery.conversation('real-stale-approval');
      equal(recovery.cli([...refresh, '--user-confirmed', '--plan-id', 'stale-approval']).exit, 1, '1621: real publisher refuses stale approval');
      equal(ledger.readWriteLedger(recovery.workspace, recovery.env.CODEX_THREAD_ID).entries.at(-1)?.state, 'unchanged', '1621: real stale approval wrote nothing');
      const wiki = path.join(recovery.workspace, 'collection/books/partial/wiki'); fs.mkdirSync(path.join(wiki, '_index.md'), { recursive: true });
      recovery.conversation('real-partial-refresh');
      const partial = recovery.cli([...refresh, '--user-confirmed', '--plan-id', plan.refresh_plan_id]);
      equal(partial.exit, 1, '1621: real publisher fails on second record'); check(fs.existsSync(path.join(wiki, '_book.md')), '1621: real failed refresh retains first write');
      const { bookManifestStorePath } = await import('../../src/manifeststore.ts');
      check(partial.stderr.includes('Journal:') && fs.existsSync(path.join(bookManifestStorePath(recovery.workspace, 'partial', 'collection'), 'dirty.json')), '1621: real failed refresh retains journal and mutation marker: ' + partial.stderr);
      const interrupted = ledger.readWriteLedger(recovery.workspace, recovery.env.CODEX_THREAD_ID).entries.at(-1);
      equal(interrupted?.state, 'uncertain', '1621: real failed refresh is uncertain'); check(ledger.checkpointLedger(ledger.emptyCheckpoint(recovery.env.CODEX_THREAD_ID), recovery.workspace).ledgerGaps!.some(gap => gap.includes(interrupted!.entry)), '1621: real partial refresh gives a named gap');
    } finally { recovery.dispose(); }
    fs.writeFileSync(path.join(root, 'damaged.jsonl'), '{');
    equal(ledger.readWriteLedger(w.root, 'damaged').ledger, 'unreadable', '1621: malformed ledger is not empty');
  } finally { w.dispose(); }
}

async function checkpointFixture(label: string) {
  const { enterSeatClaim, exitSeatClaim } = await import('../../src/seatclaim.ts');
  const w = refusalFixture('c167-' + label + '-'), workspace = path.join(w.root, 'ws');
  const env = { ...w.env, CODEX_HOME: path.join(w.root, 'codex'), CLAUDE_CONFIG_DIR: path.join(w.root, 'claude'),
    CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: String(process.pid), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '' };
  const cli = (args: string[], input?: string) => runCli([...args, '--workspace', workspace], { cwd: w.root, env, ...(input === undefined ? {} : { input }) });
  equal(cli(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, label + ': init');
  equal(cli(['hub', 'new', 'alpha', '--title', 'Alpha']).exit, 0, label + ': Hub');
  equal(cli(['seat', 'start', 'first', '--project', 'alpha', '--command', 'codex', '--no-launch']).exit, 0, label + ': seat');
  const claim = enterSeatClaim(path.join(workspace, '.claude'), 'first'); env.LIBRARY_SEAT = 'first'; env.LIBRARY_SEAT_CLAIM = claim.token;
  env.CODEX_THREAD_ID = label; env.CLAUDE_CODE_SESSION_ID = label;
  const cp = (args: string[], input?: string) => cli(['checkpoint', ...args, '--conversation', env.CODEX_THREAD_ID], input);
  const put = (name: string, body: string) => { const file = path.join(w.root, name); fs.writeFileSync(file, body); return file; };
  const conversation = (id: string) => { env.CODEX_THREAD_ID = id; env.CLAUDE_CODE_SESSION_ID = id; };
  const { argumentTable, commandAction } = await import('../../src/verbs.ts');
  const gated = (args: string[]) => {
    const preview = cli([...args, '--preflight', '--json']); equal(preview.exit, 0, label + ': preview: ' + preview.stderr);
    if (preview.exit !== 0) return preview;
    const confirms = argumentTable(args[0]!, commandAction(args[0]!, args.slice(1)).action).boolean?.includes('user-confirmed');
    return cli([...args, ...(confirms ? ['--user-confirmed'] : []), '--plan-id', JSON.parse(preview.stdout).plan_id, '--json']);
  };
  return { ...w, workspace, env, cli, cp, put, conversation, gated, dispose: () => { exitSeatClaim(claim); w.dispose(); } };
}

async function section1622(): Promise<void> {
  const { spawn } = await import('node:child_process');
  let server: ReturnType<typeof spawn> | null = null;
  const w = await checkpointFixture('ledger-checkpoint');
  const request = () => { const result = w.cp(['request', 'closeout']); equal(result.exit, 0, '1622: request: ' + result.stderr); return JSON.parse(result.stdout); };
  const cancel = () => equal(w.cp(['cancel']).exit, 0, '1622: cancel');
  try {
    const root = path.join(w.workspace, 'collection/projects/alpha/_project.md');
    fs.writeFileSync(root, '# Alpha\n\n## Purpose\n\nFixture.\n\n## Now\n\n- [x] Finished.\n\n## Next\n\n## Evidence\n\nOriginal.\n');
    equal(w.cli(['hub', 'edit', 'alpha', '--mode', 'close-item', '--section', 'Now', '--match-text', 'Finished.']).exit, 0, '1622: close item');
    let asked = request(); equal(asked.writes.filter((write: { kind: string }) => write.kind === 'hub').length, 1, '1622: close-item counted once'); cancel();
    const body = w.put('body.md', '# Fixture\n\nChanged.\n');
    const capture = w.cli(['capture', 'reports', '--title', 'Ledger Report', '--content-path', body]); equal(capture.exit, 0, '1622: capture');
    const page = JSON.parse(capture.stdout).note_page.replace(/^shelf\/reports\/wiki\//, '').replace(/\.md$/, '');
    equal(w.cli(['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1622: open reports');
    asked = request(); check(asked.prompt.includes('Pending Report filed this conversation: ' + JSON.parse(capture.stdout).note_title), '1622: pending Report title included'); cancel();
    w.conversation('only-amend');
    const update = w.put('update.md', 'More fixture evidence.\n');
    const amended = w.cli(['reports', 'amend', page, '--content-path', update]); equal(amended.exit, 0, '1622: amend: ' + amended.stderr);
    asked = request(); equal(asked.writes.length, 1, '1622: only amend counted once'); check(asked.prompt.includes(page), '1622: amendment listed');
    let answer = '```closeout\nreports: none: fixture only\nbook reports: updated ' + page + '\nhub alpha: nothing new: no write recorded\n```';
    let checked = w.cp(['check', 'closeout'], answer); equal(checked.exit, 0, '1622: check amendment'); equal(JSON.parse(checked.stdout).closeout, 'done', '1622: only amendment closes');
    w.conversation('before-undo');
    const args = ['hub', 'edit', 'alpha', '--mode', 'replace-section', '--section', 'Evidence', '--content-path', body];
    const preview = w.cli([...args, '--preflight']); equal(preview.exit, 0, '1622: replace preview');
    const changed = w.cli([...args, '--user-confirmed', '--plan-id', JSON.parse(preview.stdout).plan_id]); equal(changed.exit, 0, '1622: replace');
    const journal = path.basename(JSON.parse(changed.stdout).journal, '.json');
    w.conversation('only-undo'); const undo = w.cli(['undo', journal]); equal(undo.exit, 0, '1622: undo');
    asked = request(); equal(asked.writes.length, 1, '1622: only undo counted once');
    answer = '```closeout\nreports: none: fixture only\nbook reports: nothing new: no write recorded\nhub alpha: updated _project\n```';
    checked = w.cp(['check', 'closeout'], answer); equal(JSON.parse(checked.stdout).closeout, 'done', '1622: only undo closes');
    w.conversation('only-redo'); equal(w.cli(['redo', JSON.parse(undo.stdout).id]).exit, 0, '1622: redo');
    asked = request(); equal(asked.writes.length, 1, '1622: only redo counted once'); cancel();
    const storage = path.join(w.root, 'server'); fs.mkdirSync(path.join(storage, 'books'), { recursive: true }); fs.mkdirSync(path.join(storage, 'projects'));
    fs.writeFileSync(path.join(storage, 'books/README.md'), '# Books\n\n## Open a Book\n'); fs.writeFileSync(path.join(storage, 'projects/README.md'), '# Projects\n\n## Projects\n');
    const port = path.join(w.root, 'server.port');
    server = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), storage, port], { stdio: 'ignore', windowsHide: true });
    const until = Date.now() + 15000;
    while (!fs.existsSync(port) || !fs.readFileSync(port, 'utf8').trim()) { if (Date.now() > until) throw Error('1622: stand-in server did not start'); await new Promise(resolve => setTimeout(resolve, 50)); }
    const url = 'http://127.0.0.1:' + fs.readFileSync(port, 'utf8').trim() + '/mcp';
    const { McpSession } = await import('../../src/basicmemory.ts'); const session = new McpSession(url, 'c167-1622'); await session.initialize();
    fs.mkdirSync(path.join(w.workspace, 'internal/postbox'), { recursive: true });
    fs.writeFileSync(path.join(w.workspace, 'internal/postbox/state.json'), JSON.stringify({ schema: 1, url, project_name: 'deskpost', project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', library_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', library_card: 'Fixture', server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    equal(w.cli(['basic-memory', 'setup', '--url', url, '--collection', 'stand-in-collection', '--shared-writes', 'on', '--json']).exit, 0, '1622: connection');
    equal(w.gated(['shared', 'new-book', 'demo', '--title', 'Demo', '--summary', 'Fixture.']).exit, 0, '1622: shared Book');
    for (const action of ['add-page', 'replace-page']) {
      w.conversation('only-shared-' + action);
      const file = action === 'add-page' ? body : update;
      const result = w.gated(['shared', action, 'demo', 'guide', '--content-path', file]); equal(result.exit, 0, '1622: shared ' + action + ': ' + result.stderr);
      asked = request(); equal(asked.writes.length, 1, '1622: shared ' + action + ' counted once'); equal(asked.writes[0]?.where, 'shared', '1622: shared location'); cancel();
    }
    w.conversation('refused-and-preview');
    equal(w.cli(['hub', 'edit', 'alpha', '--mode', 'append-section', '--section', 'Evidence', '--content-path', update, '--preflight']).exit, 0, '1622: preview');
    equal(w.cli(['hub', 'edit', 'missing', '--mode', 'append-section', '--section', 'Evidence', '--content-path', update]).exit, 1, '1622: refused writer');
    asked = request(); equal(asked.writes.length, 0, '1622: refused writer and preview count no writes'); cancel();
    w.conversation('indirect-writer');
    const python = w.put('writer.py', 'import subprocess, sys\nraise SystemExit(subprocess.run(sys.argv[1:]).returncode)\n');
    const indirect = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', python, process.execPath, path.join(PROGRAM_ROOT, 'kernel/src/cli.ts'), 'hub', 'edit', 'alpha', '--mode', 'new-page', '--page', 'notes/indirect', '--content-path', body, '--workspace', w.workspace], { env: { ...process.env, ...w.env }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    equal(indirect.status, 0, '1622: Python subprocess writer: ' + indirect.stderr);
    asked = request(); equal(asked.writes.length, 1, '1622: indirect writer counted'); equal(asked.writes[0]?.page, 'notes/indirect', '1622: indirect target'); cancel();
    w.conversation('uncertain-writer');
    const ledger = path.join(w.workspace, 'internal/checkpoints/ledger/uncertain-writer.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({ schema: 1, entry: 'missing-end', state: 'started', at: Date.now(), verb: 'book', action: 'add-page', mode: null, seat: 'first', claude_session: 'uncertain-writer', codex_thread: 'uncertain-writer' }) + '\n');
    asked = request(); check(asked.prompt.includes('incomplete') && asked.prompt.includes('missing-end'), '1622: uncertain list named');
    checked = w.cp(['check', 'closeout'], answer.replace('hub alpha: updated _project', 'hub alpha: nothing new: no write recorded'));
    const gaps = JSON.parse(checked.stdout).gaps;
    check(gaps.some((gap: string) => gap.includes('missing-end')), '1622: unresolved entry cannot say nothing new');
    equal(w.cli(['desk', 'close', 'book', 'reports', '--location', 'shelf']).exit, 0, '1622: close reports before updated Hub cases');
    for (const kind of ['uncertain', 'unattributed', 'unreadable', 'no-open-item']) {
      const conversation = 'gap-' + kind, entry = 'incomplete-' + kind; w.conversation(conversation);
      equal(w.cli(['hub', 'edit', 'alpha', '--mode', 'append-section', '--section', 'Evidence', '--content', 'Written beside incomplete evidence.']).exit, 0, '1622: successful Hub write beside ' + kind);
      const file = path.join(w.workspace, 'internal/checkpoints/ledger', conversation + '.jsonl');
      if (kind !== 'unreadable') fs.appendFileSync(file, JSON.stringify({ schema: 1, entry, state: kind === 'unattributed' ? 'committed' : 'started', at: Date.now(), verb: 'book', action: 'add-page', target: 'missing', mode: null, seat: 'first', claude_session: conversation, codex_thread: conversation, ...(kind === 'unattributed' ? { targets: null, unattributed: true } : {}) }) + '\n');
      if (kind === 'no-open-item') {
        equal(w.cli(['desk', 'close', 'project', 'alpha']).exit, 0, '1622: close Hub for empty Desk');
      }
      asked = request();
      if (kind === 'unreadable') fs.writeFileSync(file, '{');
      const block = '```closeout\nreports: none: fixture only\n' + (kind === 'no-open-item' ? '' : 'hub alpha: updated _project\n') + '```';
      const result = JSON.parse(w.cp(['check', 'closeout'], block).stdout);
      equal(result.closeout, 'gaps', '1622: incomplete evidence prevents clean closeout beside ' + kind);
      check(result.gaps.some((gap: string) => gap.includes(kind === 'unreadable' ? 'ledger: unreadable for this conversation.' : entry)), '1622: incomplete evidence named for ' + kind);
      equal(result.gaps.length, 1, '1622: each ledger gap appears once for ' + kind);
    }
  } finally {
    if (server && server.exitCode === null) { const stopped = new Promise(resolve => server!.once('exit', resolve)); server.kill(); await stopped; }
    w.dispose();
  }
}

async function section1626(): Promise<void> {
  const { emptyCheckpoint, observeCheckpoint, beginCheckpoint, checkCheckpoint } = await import('../../src/checkpoint.ts');
  const open = [{ kind: 'hub' as const, name: 'alpha' }];
  const block = '```closeout\nreports: none: fixture only\nhub alpha: nothing new: no write recorded\n```';
  const state = beginCheckpoint(observeCheckpoint(emptyCheckpoint('fixture'), []), { id: 'request', kind: 'closeout', at: 1, since: null, open, hub: 'alpha', trouble: [] });
  const lineStarted = performance.now();
  const lf = checkCheckpoint(state, 'request', block, open, 2), crlf = checkCheckpoint(state, 'request', block.replace(/\n/g, '\r\n'), open, 2);
  same(crlf, lf, '1626: CRLF and LF have identical verdicts'); equal(crlf.closeout, 'done', '1626: CRLF closeout accepted');
  const lineElapsed = performance.now() - lineStarted;
  const w = await checkpointFixture('checkpoint-refusals');
  const identity = ['--conversation', w.env.CODEX_THREAD_ID];
  const timings: { label: string; elapsed: number }[] = [];
  const command = (args: string[], input?: string) => { const started = performance.now(); const ran = w.cp(args, input); timings.push({ label: args.join(' '), elapsed: performance.now() - started }); return ran; };
  const refusal = (ran: { exit: number; stdout: string; stderr: string }, label: string) => {
    equal(ran.exit, 1, '1626: refusal exits one: ' + label);
    try { const value = JSON.parse(ran.stdout); equal(value.status, 'refused', '1626: one JSON refusal without --json: ' + label); }
    catch { check(false, '1626: one JSON refusal without --json: ' + label + ': ' + ran.stdout); }
  };
  try {
    const cases = [['status'], ['status', '--conversation', '../bad'], ['unknown', ...identity], ['status', ...identity, '--unknown'],
      ['request', 'unknown', ...identity], ['request', 'closeout', ...identity, '--decided', 'unknown'], ['check', 'closeout', ...identity]];
    const results = await Promise.all(cases.map(async args => { const started = performance.now(); const ran = await runCliAsync(['checkpoint', ...args, '--workspace', w.workspace], { cwd: w.root, env: w.env }); timings.push({ label: args.join(' '), elapsed: performance.now() - started }); return ran; }));
    results.forEach((ran, index) => refusal(ran, cases[index]!.join(' ')));
    const badDecision = command(['request', 'closeout', '--decided', 'invented']);
    refusal(badDecision, 'invalid tidy decision');
    check(badDecision.stderr.includes('--decided is tidied, declined or tidy-refused'), '1626: bad decided value names the choices');
    for (const input of ['{}', '{"status":"written","page_path":"projects/alpha/_project.md"}']) {
      const ran = command(['observe'], input); refusal(ran, 'tool-result shape'); check(ran.stderr.includes('tool-result') && ran.stderr.includes('shape'), '1626: bare receipt shape named');
    }
    equal(w.cp(['request', 'closeout']).exit, 0, '1626: request');
    refusal(command(['request', 'closeout']), 'pending request');
    refusal(command(['check', 'closeout', '--request-id', 'wrong'], block), 'bad request id');
    refusal(command(['check', 'save'], block), 'wrong kind');
    equal(w.cp(['check', 'closeout'], block).exit, 0, '1626: correct check');
    refusal(command(['check', 'closeout'], block), 'already checked');
    const slowest = timings.reduce((a, b) => a.elapsed > b.elapsed ? a : b);
    check(slowest.elapsed < 10000 && lineElapsed < 10000, '1626: every refusal and line-ending check finishes in ten seconds: ' + slowest.label);
    console.log('1626 slowest refusal seconds: ' + (slowest.elapsed / 1000).toFixed(2) + '; line-ending seconds: ' + (lineElapsed / 1000).toFixed(2));
  } finally { w.dispose(); }
}

async function section1623(): Promise<void> {
  const { createHash } = await import('node:crypto');
  const w = await checkpointFixture('prepare-closeout');
  const root = path.join(w.workspace, 'collection/projects/alpha/_project.md');
  const snapshot = (folder: string): string => {
    const rows: string[] = [];
    const walk = (at: string) => { for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name); if (entry.isDirectory()) walk(file);
      else {
        let fingerprint: string;
        try { fingerprint = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error; const stat = fs.statSync(file); fingerprint = 'held claim:' + stat.size + ':' + stat.mtimeMs; }
        rows.push(path.relative(folder, file) + ':' + fingerprint);
      }
    } }; walk(folder); return rows.sort().join('\n');
  };
  const prepare = () => {
    const before = snapshot(w.workspace), ran = w.cp(['prepare', 'closeout', '--json']);
    equal(ran.exit, 0, '1623: prepare: ' + ran.stderr); equal(snapshot(w.workspace), before, '1623: prepare changes no Library file');
    return JSON.parse(ran.stdout);
  };
  const body = (ticked: boolean, over: boolean) => '# Alpha\n\n## Purpose\n\n' + (over ? 'x'.repeat(41000) : 'Fixture.') + '\n\n## Now\n\n' + (ticked ? '- [x] Finished.\n' : '- [ ] Remains.\n') + '\n## Next\n\n';
  try {
    for (const [ticked, over, expected] of [[false, false, false], [true, false, true], [false, true, true], [true, true, true]] as const) {
      fs.writeFileSync(root, body(ticked, over));
      const value = prepare(); equal(value.ask_first !== null && value.ask_first !== undefined, expected, `1623: question ticked ${ticked}, over ${over}`);
      if (!expected || !value.ask_first) continue;
      same(value.ask_first.choices.map((choice: { label: string }) => choice.label), ['Tidy it now', 'Not now'], '1623: two choices');
      const commands = value.ask_first.choices[0].commands;
      equal(commands.filter((command: { argv?: string[] }) => command.argv?.includes('close-item')).length, ticked ? 1 : 0, '1623: ticked top-level items only');
      equal(commands.filter((command: { preflight?: string[] }) => command.preflight?.includes('tidy')).length, over ? 1 : 0, '1623: tidy only over limit');
    }
    equal(w.cli(['desk', 'close', 'project', 'alpha']).exit, 0, '1623: close Hub');
    equal(prepare().ask_first, null, '1623: closed Hub no question');
    equal(w.cli(['desk', 'open', 'project', 'alpha']).exit, 0, '1623: reopen Hub');
    for (const decided of ['tidied', 'declined', 'tidy-refused']) {
      const ran = w.cp(['request', 'closeout', '--decided', decided, '--json']); equal(ran.exit, 0, '1623: request decision');
      const value = JSON.parse(ran.stdout); equal(value.request?.decided, decided, '1623: decision recorded');
      equal(String(value.prompt).includes('close what is done'), decided === 'tidy-refused', '1623: tidy instruction follows decision');
      equal(w.cp(['cancel']).exit, 0, '1623: cancel');
    }
    const bad = w.cp(['request', 'closeout', '--decided', 'invented', '--json']); equal(bad.exit, 1, '1623: bad decision refuses'); equal(JSON.parse(bad.stdout).status, 'refused', '1623: decision refusal object');
    const vault = path.join(w.root, 'vault'); fs.mkdirSync(path.join(vault, 'Librarian'), { recursive: true }); fs.mkdirSync(path.join(vault, '.obsidian'));
    const marker = path.join(w.workspace, '.library/workspace.json'), current = JSON.parse(fs.readFileSync(marker, 'utf8'));
    current.connections = { ...current.connections, vault: { path: vault, librarian_folder: 'Librarian', features: ['needs-you'] } }; fs.writeFileSync(marker, JSON.stringify(current));
    prepare();
    check(!fs.existsSync(path.join(vault, 'Librarian/needs-you.md')), '1623: read-only prepare writes no connected vault page');
    equal(w.cp(['request', 'closeout']).exit, 0, '1623: request for refreshing check');
    equal(w.cp(['check', 'closeout'], '```closeout\nreports: none: fixture only\nhub alpha: nothing new: fixture only\n```').exit, 0, '1623: checkpoint check still runs');
    const vaultPage = path.join(vault, 'Librarian/needs-you.md');
    check(fs.existsSync(vaultPage), '1623: checkpoint check still refreshes vault');
    if (fs.existsSync(vaultPage)) fs.writeFileSync(vaultPage, 'fixture stale page');
    // Exercise the successful postbox command's refresh callback without needing a mail server.
    const { refreshAfterCommand } = await import('../../src/needsyou.ts');
    refreshAfterCommand(['postbox', 'check', '--workspace', w.workspace]);
    check(fs.existsSync(vaultPage) && fs.readFileSync(vaultPage, 'utf8') !== 'fixture stale page', '1623: postbox check still refreshes vault');
  } finally { w.dispose(); }
}

async function section1624(): Promise<void> {
  const { desiredHookRegistration } = await import('../../src/init.ts');
  const { namesHook } = await import('../../src/hookregistry.ts');
  const w = await checkpointFixture('claude-hooks');
  try {
    const settings = fs.readFileSync(path.join(PROGRAM_ROOT, '.claude/settings.json'), 'utf8');
    for (const compiled of [false, true]) {
      const program = path.join(w.root, compiled ? 'compiled' : 'source'); fs.mkdirSync(path.join(program, '.claude'), { recursive: true }); fs.writeFileSync(path.join(program, '.claude/settings.json'), settings);
      fs.mkdirSync(path.join(program, 'kernel/src'), { recursive: true }); fs.writeFileSync(path.join(program, 'kernel/src/cli.ts'), '// Render-only fixture.\n');
      if (compiled) { fs.mkdirSync(path.join(program, 'bin')); fs.writeFileSync(path.join(program, 'bin/library.exe'), ''); fs.writeFileSync(path.join(program, 'bin/library'), ''); }
      const hooks = desiredHookRegistration(program) as Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
      for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
        const entries = (hooks[event] ?? []).flatMap(block => block.hooks).filter(hook => namesHook([hook.command, ...(hook.args ?? [])].join(' '), 'checkpoint'));
        equal(entries.length, 1, `1624: exactly one ${event} checkpoint, compiled ${compiled}`);
        const text = entries.map(hook => [hook.command, ...(hook.args ?? [])].join(' ')).join('');
        check(compiled ? /bin[\\/]library/.test(text) : text.includes('kernel/src/cli.ts'), '1624: correct executable form');
        check(!text.includes('.ps1'), '1624: no script hook');
      }
    }
    const payload = { session_id: w.env.CODEX_THREAD_ID, prompt_id: 'prompt-one', cwd: w.workspace };
    const hook = (name: string, extra: Record<string, unknown> = {}) => w.cli(['hook', 'checkpoint'], JSON.stringify({ ...payload, hook_event_name: name, ...extra }));
    const prompt = hook('UserPromptSubmit'); equal(prompt.exit, 0, '1624: prompt hook');
    check(prompt.stdout.includes('Checkpoint conversation id: claude-hooks') && prompt.stdout.includes('Checkpoint turn id: prompt-one') && prompt.stdout.includes('Checkpoint harness: claude'), '1624: Claude identity reaches context');
    equal(w.cp(['request', 'closeout', '--harness', 'claude', '--turn', 'prompt-one']).exit, 0, '1624: request');
    equal(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'fixture-tool', tool_input: { command: 'printf fixture' }, tool_response: 'fixture' }).exit, 0, '1624: tool hook');
    const stopped = hook('Stop', { last_assistant_message: '```closeout\nreports: none: fixture only\nhub alpha: nothing new: no write recorded\n```', stop_hook_active: false });
    equal(stopped.exit, 0, '1624: Stop hook'); equal(JSON.parse(w.cp(['status']).stdout).closeout, 'done', '1624: actual Claude final answer checked');
    equal(w.cp(['request', 'closeout', '--harness', 'claude', '--turn', 'prompt-one']).exit, 0, '1624: unanswered request');
    check(hook('UserPromptSubmit').stdout.includes('request waits'), '1624: same turn retains request');
    const next = hook('UserPromptSubmit', { prompt_id: 'prompt-two' }); equal(next.exit, 0, '1624: next prompt');
    const state = JSON.parse(w.cp(['status']).stdout); equal(state.request, null, '1624: next Claude prompt cancels pending request'); equal(state.closeout, 'none', '1624: interruption never completes closeout');
  } finally { w.dispose(); }
}

async function section1625(): Promise<void> {
  const { createHash } = await import('node:crypto');
  const { planLibraryInit, applyLibraryInit } = await import('../../src/init.ts');
  const w = await checkpointFixture('shared-closeout-skill');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const seed = (workspace: string, location: string, kind: string) => {
    const folder = path.join(workspace, location, 'save'); fs.mkdirSync(folder, { recursive: true });
    const body = '---\nname: save\ndescription: Fixture old skill.\n---\nOld owned save.\n';
    fs.writeFileSync(path.join(folder, 'SKILL.md'), body);
    if (kind !== 'foreign') fs.writeFileSync(path.join(folder, '.deskpost-managed.json'), JSON.stringify({ schema: 1, files: { 'SKILL.md': [hash(body)] } }));
    if (kind === 'edited') fs.appendFileSync(path.join(folder, 'SKILL.md'), 'Reader addition.\n');
    return folder;
  };
  try {
    for (const kind of ['owned', 'edited', 'foreign']) {
      const workspace = path.join(w.root, kind);
      const init = () => w.cli(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]);
      equal(init().exit, 0, '1625: initial fixture ' + kind);
      for (const location of ['.claude/skills', '.agents/skills']) {
        for (const skill of ['library-help', 'closeout']) check(fs.existsSync(path.join(workspace, location, skill, 'SKILL.md')), '1625: installed ' + location + '/' + skill);
        seed(workspace, location, kind);
      }
      const ran = init(); equal(ran.exit, 0, '1625: retire ' + kind + ': ' + ran.stderr);
      for (const location of ['.claude/skills', '.agents/skills']) {
        const folder = path.join(workspace, location, 'save');
        equal(fs.existsSync(folder), kind !== 'owned', '1625: save folder fate ' + kind + ' ' + location);
        check(ran.stdout.includes(location + '/save') && ran.stdout.toLowerCase().includes(kind === 'owned' ? 'removed' : 'kept'), '1625: named human line ' + kind);
        if (kind === 'edited') check(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8').includes('Reader addition.'), '1625: reader edit retained');
        if (kind === 'foreign') check(!fs.existsSync(path.join(folder, '.deskpost-managed.json')), '1625: foreign save never adopted');
      }
    }
    const folder = seed(w.workspace, '.agents/skills', 'owned');
    const plan = planLibraryInit({ workspacePath: w.workspace, programRoot: PROGRAM_ROOT, registryRoot: w.env.LIBRARY_WORKSPACES });
    check(JSON.stringify(plan.result).includes('removed'), '1625: retirement named in plan');
    fs.writeFileSync(path.join(folder, 'reader.md'), 'Reader work.\n');
    let refused = false; try { applyLibraryInit(plan); } catch { refused = true; }
    check(refused && fs.existsSync(path.join(folder, 'reader.md')), '1625: changed folder refuses stale removal');
    const asked = w.cp(['request', 'closeout', '--harness', 'claude']); equal(asked.exit, 0, '1625: Claude request');
    check(JSON.parse(asked.stdout).prompt.includes('closeout skill'), '1625: Claude uses the shared closeout skill');
    for (const location of ['.agents/skills', '.claude/skills']) {
      const file = path.join(PROGRAM_ROOT, location, 'closeout/SKILL.md');
      const skill = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      check(skill.includes('checkpoint prepare closeout') && skill.includes('--decided') && skill.includes('plain words'), '1625: shared ask-first workflow ' + location);
    }
  } finally { w.dispose(); }
}

async function section1627(): Promise<void> {
  const { readHookLedger } = await import('../../src/hookledger.ts');
  const w = await checkpointFixture('desk-snapshots');
  const state = path.join(w.workspace, '.claude'), settings = path.join(state, 'settings.local.json');
  const clear = { type: 'command', command: process.execPath, args: [path.join(PROGRAM_ROOT, 'kernel/src/cli.ts'), 'hook', 'compact-clear', '--state-directory', state] };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostCompact: [{ hooks: [clear] }], SessionStart: [{ hooks: [clear] }] } }));
  Object.assign(w.env, { DESKPOST_ASSISTANT: 'claude' });
  let prefix = 'mcp__validated-book-reader__';
  const session = 'snapshot-conversation';
  const context = () => {
    const ran = w.cli(['hook', 'desk-context', '--seat', 'first', '--agent-pid', '0', '--reader-tool-prefix', prefix], JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }));
    equal(ran.exit, 0, '1627: context hook'); return ran.stdout.trim() ? String(JSON.parse(ran.stdout).hookSpecificOutput?.additionalContext ?? '') : '';
  };
  const letter = (title: string) => {
    const file = w.put('letter.md', 'Fixture letter.\n');
    const ran = w.cli(['capture', 'letters', '--for', 'first', '--why', 'for-seat', '--title', title, '--content-path', file]); equal(ran.exit, 0, '1627: capture letter');
    return String(JSON.parse(ran.stdout).note_page).replace(/^shelf\/letters\/wiki\//, '').replace(/\.md$/, '');
  };
  try {
    const a = context(); check(a.includes('Virtual Desk'), '1627: A sent'); equal(context(), '', '1627: A again withheld');
    equal(w.cli(['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1627: B Desk');
    const b = context(); check(b.includes('reports') && b !== a, '1627: B sent');
    equal(w.cli(['desk', 'close', 'book', 'reports', '--location', 'shelf']).exit, 0, '1627: return to A');
    equal(context(), a, '1627: A after B sent again');
    equal((readHookLedger(state).get(session) ?? []).filter(key => key.startsWith('desk-context:')).length, 1, '1627: only last Desk snapshot retained');
    equal(w.cli(['desk', 'open', 'book', 'letters', '--location', 'shelf']).exit, 0, '1627: open letters');
    const first = letter('First ordinary letter'); check(context().includes('Letters wait'), '1627: first letter served');
    equal(w.cli(['letters', 'close', first, '--note', 'Read fixture.']).exit, 0, '1627: close first letter');
    letter('Replacement ordinary letter'); check(context().includes('Letters wait'), '1627: replacement letter with same count served');
    letter('c9 handback: fixture complete');
    equal(w.cli(['desk', 'close', 'book', 'letters', '--location', 'shelf']).exit, 0, '1627: close letters before handback check');
    const hub = path.join(w.workspace, 'collection/projects/alpha/_project.md');
    fs.writeFileSync(hub, fs.readFileSync(hub, 'utf8').replace(/^## Next[ \t]*\r?$/m, '## Next\n\n- [ ] Run c8: [[projects/alpha/kickoffs/c8]]') + '\n## Repo\n\nFixture repository.\n');
    const ready = context(); check(ready.includes('Handback waits: c9 handback: fixture complete'), '1627: newest handback title'); check(ready.includes('Ready to start: Run c8'), '1627: first pending Run pointer');
    equal(w.cli(['hook', 'compact-clear', '--state-directory', state], JSON.stringify({ hook_event_name: 'PostCompact', session_id: session })).exit, 0, '1627: actual compaction clear');
    check(context().includes('Ready to start: Run c8'), '1627: compaction sends snapshot again');
    Object.assign(w.env, { DESKPOST_ASSISTANT: 'codex' }); prefix = 'mcp__validated_book_reader__';
    check(context().includes('Virtual Desk'), '1627: Codex first snapshot'); equal(context(), '', '1627: Codex unchanged snapshot withheld where clear reaches');
    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }));
    check(context().includes('Virtual Desk'), '1627: Codex repeats without a reachable clear'); check(context().includes('Virtual Desk'), '1627: Codex repeats every prompt without a clear');
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PostCompact: [{ hooks: [clear] }], SessionStart: [{ hooks: [clear] }] } }));
    // Replace only this disposable fixture's serve ledger with an unreadable file slot.
    const ledger = path.join(state, '.hook-served.json'); fs.rmSync(ledger, { force: true }); fs.mkdirSync(ledger);
    check(context().includes('Virtual Desk'), '1627: unreadable ledger sends'); check(context().includes('Virtual Desk'), '1627: unreadable ledger keeps sending');
  } finally { w.dispose(); }
}

async function section1640(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const w = refusalFixture('c175-1640-'), workspace = path.join(w.root, 'ws'), storage = path.join(w.root, 'server');
  let server: ReturnType<typeof spawn> | null = null;
  const put = (relative: string, text: string) => { const file = path.join(w.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const cli = (args: string[]) => runCli([...args, '--workspace', workspace], { cwd: w.root, env: w.env });
  try {
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1640: init');
    equal(cli(['hub', 'new', 'alpha', '--title', 'Alpha']).exit, 0, '1640: Hub');
    equal(cli(['seat', 'start', 'first', '--project', 'alpha', '--no-launch']).exit, 0, '1640: seat');
    put('server/books/README.md', '# Books\n\n## Open a Book\n');
    put('server/projects/README.md', '# Projects\n\n## Projects\n');
    put('server/books/demo/wiki/_book.md', '# Demo\n\n## Purpose\n\nShared fixture.\n');
    const body = '# Guide\n\nThe distinctive c175 needle is here.\n';
    put('server/books/demo/wiki/guide.md', body);
    const port = path.join(w.root, 'server.port');
    server = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), storage, port], { stdio: 'ignore', windowsHide: true });
    const until = Date.now() + 15000;
    while (!fs.existsSync(port) || !fs.readFileSync(port, 'utf8').trim()) {
      if (Date.now() > until) throw Error('1640: stand-in server did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = 'http://127.0.0.1:' + fs.readFileSync(port, 'utf8').trim() + '/mcp';
    // The same legacy Basic Memory shape section 36's basicMemoryWorkspace constructs.
    const markerFile = path.join(workspace, '.library/workspace.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    marker.backend = 'basic-memory'; marker.collection_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    put('ws/.claude/.library-mcp-url', url); put('ws/.claude/.library-project', marker.collection_id);
    // Remove this fixture's first registration so this measures what Basic Memory init selects.
    fs.rmSync(path.join(workspace, '.mcp.json'));
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1640: Basic Memory init');
    const reader = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers['validated-book-reader'];
    console.log('1640 registered reader: ' + JSON.stringify(reader));
    const kernel = !/powershell|pwsh|\.ps1/i.test(JSON.stringify(reader));
    check(kernel, '1640: Basic Memory init registers the kernel reader');
    if (!kernel) return;
    put('ws/.claude/seats/first/.open-books', 'books/demo\n');
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c175', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_open_book_page', arguments: { slug: 'demo', page: 'guide' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_open_books', arguments: { query: 'distinctive c175 needle' } } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n';
    const served = spawnSync(reader.command, reader.args, { cwd: workspace, input: requests, encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, ...w.env, LIBRARY_SEAT: 'first', CLAUDE_PID: '' } });
    const messages = (served.stdout ?? '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const page = messages.find(row => row.id === 2)?.result;
    const search = messages.find(row => row.id === 3)?.result;
    check(page?.isError === false && page.content?.[0]?.text === body, '1640: shared page text through registered stdio reader: ' + JSON.stringify(page));
    check(JSON.stringify(page).includes(createHash('sha256').update(body).digest('hex')), '1640: shared page SHA256');
    check(search?.isError === false && JSON.stringify(search).includes('guide') && JSON.stringify(search).includes('distinctive c175 needle'), '1640: shared full-text hit through registered stdio reader: ' + JSON.stringify(search));
    equal(served.status, 0, '1640: registered reader exits cleanly: ' + served.stderr);
  } catch (error) { failures.push('1640: ' + (error as Error).message); }
  finally { if (server !== null) { server.kill(); await new Promise(resolve => server!.once('exit', resolve)); } w.dispose(); }
}


async function section1641(): Promise<void> {
  const { librariesServedByRoot } = await import('../../src/installs.ts');
  const { planRefreshes, refreshServed } = await import('../../src/setup.ts');
  const w = refusalFixture('c175-1641-');
  const root = path.join(w.root, 'install'), current = path.join(root, 'current'), version = '0.0.1';
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const script = (program: string, name: string) => ({ command: 'powershell.exe', args: ['-NoProfile', '-File', path.join(program, '.claude', name).replace(/\\/g, '/')] });
  try {
    put(path.join(current, 'bin/library.exe'), 'MZ'); put(path.join(current, 'bin/library'), 'fixture');
    put(path.join(root, 'current.json'), JSON.stringify({ schema: 1, version }));
    const alpha = path.join(w.root, 'alpha'), beta = path.join(w.root, 'beta'), foreign = path.join(w.root, 'foreign');
    for (const workspace of [alpha, beta, foreign]) equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1641: init fixture');
    // These are fixture registrations from an older release, with no kernel registration left.
    for (const workspace of [alpha, beta, foreign]) {
      for (const relative of ['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.mcp.json']) put(path.join(workspace, relative), '{}');
      put(path.join(workspace, '.codex/config.toml'), '# Managed by `library init`. Re-run it after moving the program; edits here are replaced.\n');
    }
    put(path.join(alpha, '.claude/settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [script(current, 'hooks/Guard-ShelfBookRead.ps1')] }] } }));
    put(path.join(alpha, '.mcp.json'), JSON.stringify({ mcpServers: { 'validated-book-reader': script(current, 'adapters/Validated-BookReader.ps1') } }));
    put(path.join(alpha, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [script(current, 'hooks/Guard-BasicMemoryRead.ps1')] }] } }));
    const old = path.join(root, 'versions/0.0.0');
    const adapter = script(old, 'adapters/Validated-BookReader.ps1');
    put(path.join(beta, '.codex/config.toml'), '# Managed by `library init`. Re-run it after moving the program; edits here are replaced.\n[mcp_servers.validated-book-reader]\ncommand = "powershell.exe"\nargs = ' + JSON.stringify(adapter.args) + '\n');
    put(path.join(foreign, '.claude/settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [script(path.join(w.root, 'reader-program'), 'hooks/notify.ps1')] }] } }));
    const found = librariesServedByRoot(root, w.env.LIBRARY_WORKSPACES).served;
    same(found.sort(), [alpha, beta].sort(), '1641: current scripts and version-only Codex adapter are served, foreign script excluded');
    const entries = planRefreshes(found, PROGRAM_ROOT, current, w.env.LIBRARY_WORKSPACES);
    check(entries.length === 2 && entries.every(entry => entry.decision === 'refresh'), '1641: both script-only Libraries can refresh: ' + JSON.stringify(entries.map(entry => entry.reason)));
    const approval = { schema: 1, version, install_root: root, kept: [], libraries: entries.map(entry => ({ workspace: entry.workspace, decision: entry.decision, reason: entry.reason,
      writes: (entry.plan?.writes ?? []).map(write => ({ relative: write.relative, path: write.path, old_sha256: write.old_sha256, new_sha256: write.new_sha256, content: write.content })), directories: entry.plan?.directories ?? [] })) };
    put(path.join(root, 'install-receipt.json'), JSON.stringify({ schema: 1, owned: [], pending: null, refresh_pending: approval }));
    const refreshed = refreshServed(root, PROGRAM_ROOT, w.env.LIBRARY_WORKSPACES);
    check((refreshed.value.refresh as { libraries: { status: string }[] }).libraries.length === 2, '1641: approved refresh visits both Libraries');
    for (const workspace of [alpha, beta]) for (const relative of ['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.mcp.json']) {
      const text = fs.readFileSync(path.join(workspace, relative), 'utf8');
      const registrations = JSON.stringify(JSON.parse(text), (key, value) => key === 'matcher' ? undefined : value);
      check(!/powershell|\.ps1/i.test(registrations), '1641: refresh removes old registrations from ' + workspace + '/' + relative);
    }
    for (const workspace of [alpha, beta]) {
      const text = fs.readFileSync(path.join(workspace, '.codex/config.toml'), 'utf8').split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n');
      check(!/powershell|\.ps1/i.test(text), '1641: refresh replaces Codex reader');
    }
    // A refused Library is left unchanged and carries the existing finish command.
    approval.libraries = [{ workspace: foreign, decision: 'refused', reason: 'fixture foreign hook', writes: [], directories: [] }];
    put(path.join(root, 'install-receipt.json'), JSON.stringify({ schema: 1, owned: [], pending: null, refresh_pending: approval }));
    const kept = refreshServed(root, PROGRAM_ROOT, w.env.LIBRARY_WORKSPACES);
    check(kept.humanText.includes(`deskpost init ${foreign}`), '1641: refused Library keeps its repair line');
  } catch (error) { failures.push('1641: ' + (error as Error).message); }
  finally { w.dispose(); }
}

async function section1642(): Promise<void> {
  const w = refusalFixture('c175-1642-'), workspace = path.join(w.root, 'ws');
  const put = (relative: string, value: unknown) => fs.writeFileSync(path.join(workspace, relative), JSON.stringify(value));
  const script = (relative: string) => ({ command: 'powershell.exe', args: ['-NoProfile', '-File', path.join(PROGRAM_ROOT, relative).replace(/\\/g, '/')] });
  const doctor = () => JSON.parse(w.run(['doctor', '--workspace', workspace, '--json']).stdout).library_checks as { check: string; status: string; detail: string }[];
  try {
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1642: init');
    const hooks = { PreToolUse: [{ hooks: [script('.claude/hooks/Guard-ShelfBookRead.ps1')] }], Stop: [{ hooks: [{ command: 'powershell.exe', args: ['-File', path.join(w.root, 'reader-notify.ps1')] }] }] };
    put('.claude/settings.local.json', { hooks });
    put('.mcp.json', { mcpServers: { 'validated-book-reader': script('.claude/adapters/Validated-BookReader.ps1') } });
    put('.codex/hooks.json', { hooks: { PreToolUse: [{ hooks: [script('.claude/hooks/Guard-BasicMemoryRead.ps1')] }] } });
    const config = path.join(workspace, '.codex/config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/^command = .*$/m, 'command = "powershell.exe"').replace(/^args = .*$/m, 'args = ' + JSON.stringify(script('.claude/adapters/Validated-BookReader.ps1').args)));
    const warnings = doctor().filter(row => row.check === 'workspace.powershell-registrations' && row.status === 'warn');
    equal(warnings.length, 1, '1642: one warning per Library');
    const text = warnings[0]?.detail ?? '';
    console.log('1642 warning: ' + text);
    check(text.includes('.claude/settings.local.json') && text.includes('PreToolUse') && text.includes('.mcp.json') && text.includes('.codex/hooks.json') && text.includes('.codex/config.toml') && text.includes(`deskpost init ${workspace}`), '1642: warning names each owned registration and repair');
    check(!text.includes('reader-notify'), '1642: reader hook is unjudged');
    // Remove only the fixture's foreign hook before the authorised init refresh.
    delete (hooks as Partial<typeof hooks>).Stop; put('.claude/settings.local.json', { hooks });
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1642: re-init replaces old scripts');
    check(!doctor().some(row => row.check === 'workspace.powershell-registrations' && row.status === 'warn'), '1642: no script warning after init');
  } catch (error) { failures.push('1642: ' + (error as Error).message); }
  finally { w.dispose(); }
}


async function section1643(): Promise<void> {
  const { planLibraryInit } = await import('../../src/init.ts');
  const w = refusalFixture('c175-r2-1643-'), workspace = path.join(w.root, 'ws');
  const mcp = path.join(workspace, '.mcp.json');
  const other = { command: 'reader-owned-server', args: ['one', 'two'], env: { FIXTURE: 'kept' } };
  try {
    equal(w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]).exit, 0, '1643: first init');
    const fresh = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    const expected = fresh.mcpServers['validated-book-reader'];
    const changed = structuredClone(fresh);
    changed.mcpServers.other = other;
    const reader = changed.mcpServers['validated-book-reader'];
    const stateAt = reader.args.indexOf('--state-directory');
    check(stateAt >= 0, '1643: registered reader names its state directory');
    reader.args[stateAt + 1] = path.join(w.root, 'old-place', '.claude');
    fs.writeFileSync(mcp, JSON.stringify(changed));
    const again = w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]);
    equal(again.exit, 0, '1643: same program re-init: ' + again.stderr);
    const replaced = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    same(replaced.mcpServers['validated-book-reader'], expected, '1643: own reader replaced whole');
    same(replaced.mcpServers.other, other, '1643: second server survives replacement');

    const foreign = structuredClone(fresh);
    foreign.mcpServers.other = other;
    const alien = foreign.mcpServers['validated-book-reader'];
    if (alien.args[0] === 'mcp') alien.command = path.join(w.root, 'other-program', 'bin', path.basename(alien.command));
    else alien.args[0] = path.join(w.root, 'other-program', 'kernel', 'src', 'cli.ts');
    const before = JSON.stringify(foreign, null, 2) + '\n';
    fs.writeFileSync(mcp, before);
    const refused = w.run(['init', workspace, '--registry-root', w.env.LIBRARY_WORKSPACES]);
    check(refused.exit !== 0, '1643: another program refused');
    check(refused.stderr.includes('other-program') && refused.stderr.includes('nothing has been written'), '1643: refusal names program and no write');
    equal(fs.readFileSync(mcp, 'utf8'), before, '1643: refusal preserves file bytes and second server');

    if (process.platform === 'win32') {
      const current = path.join(w.root, 'install', 'current'), versionWorkspace = path.join(w.root, 'version-ws');
      fs.mkdirSync(path.join(current, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(current, 'bin', 'library.exe'), 'MZ');
      fs.writeFileSync(path.join(w.root, 'install', 'current.json'), JSON.stringify({ schema: 1, version: '0.0.1' }));
      const options = { workspacePath: versionWorkspace, programRoot: PROGRAM_ROOT, registerAs: current, registryRoot: w.env.LIBRARY_WORKSPACES };
      const first = planLibraryInit(options);
      const target = path.join(versionWorkspace, '.mcp.json');
      const wanted = JSON.parse(first.writes.find(write => write.path === target)!.content);
      const old = structuredClone(wanted);
      old.mcpServers['validated-book-reader'].command = path.join(w.root, 'install', 'versions', '0.0.0', 'bin', 'library.exe');
      old.mcpServers['validated-book-reader'].args.push('--old-argument');
      old.mcpServers.other = other;
      fs.mkdirSync(versionWorkspace, { recursive: true });
      fs.writeFileSync(target, JSON.stringify(old));
      const plan = planLibraryInit(options);
      const planned = JSON.parse(plan.writes.find(write => write.path === target)!.content);
      same(planned.mcpServers['validated-book-reader'], wanted.mcpServers['validated-book-reader'], '1643: version reader replaced whole with current');
      same(planned.mcpServers.other, other, '1643: version replacement keeps second server');
    }
  } catch (error) { failures.push('1643: ' + (error as Error).message); }
  finally { w.dispose(); }
}

async function section1644(): Promise<void> {
  const ledger = await import('../../src/checkpoint.ts');
  const { createHash } = await import('node:crypto');
  const w = refusalFixture('w50-1644-');
  const hash = (body: string) => createHash('sha256').update(body).digest('hex');
  const runFixture = (workspace: string, withLaterWriter: boolean) => {
    const journals = path.join(workspace, 'internal', 'publication-journals');
    const ledgerRoot = path.join(workspace, 'internal', 'checkpoints', 'ledger');
    const conversation = 'w50-fixture';
    fs.mkdirSync(journals, { recursive: true });
    fs.mkdirSync(ledgerRoot, { recursive: true });
    const start = (entry: string): import('../../src/checkpoint.ts').LedgerRecord => {
      const record = { schema: 1, entry, state: 'started', at: Date.now() - 1000,
        verb: 'hub', action: 'edit', mode: 'replace-body', seat: 'first',
        claude_session: null, codex_thread: conversation, target: 'alpha' } as const;
      fs.appendFileSync(path.join(ledgerRoot, conversation + '.jsonl'), JSON.stringify(record) + '\n');
      return record;
    };
    const journal = (name: string, complete: boolean) => {
      const page = 'collection/projects/alpha/notes/' + name + '.md';
      const file = path.join(workspace, page);
      const journalPath = path.join(journals, name + '.json');
      const identity = { operation: 'project-edit', mode: 'replace-body', project_slug: 'alpha' };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(journalPath, JSON.stringify(identity));
      fs.writeFileSync(file, name);
      if (complete) {
        const undo = { written_by_seat: 'first', paths: [{ path: page, after_sha256: hash(name) }] };
        fs.writeFileSync(journalPath, JSON.stringify({ ...identity, undo }));
      }
      return { page, journalPath };
    };
    const earlier = start('writer-a');
    const { journalPath } = journal('a', !withLaterWriter);
    if (!withLaterWriter) {
      const [recovered] = ledger.readWriteLedger(workspace, conversation).entries;
      equal(recovered?.state, 'committed', '1644: sole interrupted writer recovers from its complete journal');
      equal(recovered?.targets?.[0]?.page, 'notes/a', '1644: recovered writer has its own target');
      return;
    }
    const later = start('writer-b');
    const { ctimeMs, mtimeMs } = fs.statSync(journalPath);
    const snapshot = [{ path: journalPath, ctimeMs, mtimeMs, hash: hash(fs.readFileSync(journalPath, 'utf8')) }];
    const { page } = journal('b', true);
    ledger.finishWriteLedger({ workspace, record: later, receipts: [{ written: true, page_file: page }],
      journalEvidence: { paths: [journals], snapshot } }, 0);
    const entries = ledger.readWriteLedger(workspace, conversation).entries;
    equal(entries.find(entry => entry.entry === earlier.entry)?.state, 'uncertain', '1644: earlier pending writer stays uncertain');
    const finished = entries.find(entry => entry.entry === later.entry);
    equal(finished?.state, 'committed', '1644: later finished writer stays committed');
    equal(finished?.targets?.[0]?.page, 'notes/b', '1644: later writer retains its own target');
    const checkpoint = ledger.checkpointLedger(ledger.emptyCheckpoint(conversation), workspace);
    check(checkpoint.ledgerGaps?.some(gap => gap.includes('ledger entry writer-a: uncertain')) === true,
      '1644: checkpoint names the earlier writer in a gap');
  };
  try {
    runFixture(path.join(w.root, 'later-writer'), true);
    runFixture(path.join(w.root, 'sole-writer'), false);
  } finally { w.dispose(); }
}

export async function runLane(h: Harness): Promise<void> {
  ({ selected, prerequisite, check, equal, same, failures, runCli, runCliAsync, HERE, PROGRAM_ROOT, KERNEL_COMMAND, isCompiled } = h);
if (selected(1600)) await section1600();
if (selected(1601)) await section1601();
if (selected(1602)) await section1602();
if (selected(1603)) await section1603();
if (selected(1604)) await section1604();
if (selected(1605)) await section1605();
if (selected(1606)) await section1606();
if (selected(1607)) await section1607();
if (selected(1608)) await section1608();
if (selected(1609)) await section1609();
if (selected(1610)) await section1610();
if (selected(1611)) await section1611();
if (selected(1612) && prerequisite(1612, () => process.platform === 'win32', 'requires Windows PowerShell')) await section1612();
if (selected(1613) && prerequisite(1613, () => !isCompiled(), 'requires the source fake server')) await section1613();
if (selected(1614) && prerequisite(1614, () => spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0, 'requires working sh')) await section1614();
if (selected(1615)) await section1615();
if (selected(1616)) await section1616();
if (selected(1617)) await section1617();
if (selected(1618)) await section1618();
if (selected(1619) && prerequisite(1619, () => spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0, 'requires working sh (skipped on Windows without sh on PATH)')) await section1619();
if (selected(1620)) await section1620();
if (selected(1621)) await section1621();
if (selected(1622)) await section1622();
if (selected(1623)) await section1623();
if (selected(1624)) await section1624();
if (selected(1625)) await section1625();
if (selected(1626)) await section1626();
if (selected(1627)) await section1627();
if (selected(1640)) await section1640();
if (selected(1641)) await section1641();
if (selected(1642)) await section1642();
if (selected(1643)) await section1643();
if (selected(1644)) await section1644();
}
