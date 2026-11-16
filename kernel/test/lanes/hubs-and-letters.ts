/**
 * THE HUBS-AND-LETTERS LANE'S SELF-TEST SECTIONS (PLAN-lane-test-files.md; kickoffs/s210 row 1). This lane's new sections go here,
 * numbered in its range in docs/areas.json `section_ranges` (1400 to 1599), and claim their kernel/src files in
 * `hubs-and-letters.covers.json` beside this file. kernel/test/selftest.ts awaits `runLane` after its last own section, so all of
 * its initialization has run; the names below are its helpers (./harness.ts says what each is).
 *
 * THE FORMAT IS THE PARSERS' OWN, AT COLUMN ZERO (tools/section-select.mts `sectionRanges`, kernel/test/run-parallel.ts
 * `sectionNumbers` and `knownDeclaredSkips`, tools/ci-manifest.mts): each section is a top-level `async function
 * sectionN(): Promise<void> {` whose closing `}` is at column zero, and `runLane` holds one dispatch line per section at
 * column zero, `if (selected(N)) await sectionN();` or `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))
 * await sectionN();` on one line, in number order. No formatter runs on this file.
 */
import type { Harness } from './harness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

let selected: Harness['selected'], prerequisite: Harness['prerequisite'], check: Harness['check'], equal: Harness['equal'], same: Harness['same'];
let failures: Harness['failures'], runCli: Harness['runCli'], runCliAsync: Harness['runCliAsync'];
let HERE: Harness['HERE'], PROGRAM_ROOT: Harness['PROGRAM_ROOT'], KERNEL_COMMAND: Harness['KERNEL_COMMAND'], isCompiled: Harness['isCompiled'];

/** Two live fixture seats; every call names its writer's harness and uses an isolated home. */
async function letterWorkspace(label: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kernel-${label}-`)));
  const ws = path.join(root, 'ws'), home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const agents = [0, 1].map(() => {
    const child = process.platform === 'win32'
      ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' })
      : spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  });
  const cli = (who: number, args: string[], assistant = 'claude') => runCli([...args, '--workspace', ws],
    { cwd: root, env: { ...env, CLAUDE_PID: String(agents[who]?.pid ?? process.pid), DESKPOST_ASSISTANT: assistant } });
  const json = (ran: ReturnType<typeof cli>): Record<string, any> => {
    equal(ran.exit, 0, `${label}: command succeeds: ${ran.stderr}`);
    try { return JSON.parse(ran.stdout); } catch { return {}; }
  };
  const dispose = async () => {
    for (const agent of agents) agent.kill();
    // Only this fixture's stand-in home, Library and registry go after its agents stop.
    const until = Date.now() + 10000;
    for (;;) {
      try { fs.rmSync(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  };
  try {
    equal(runCli(['init', ws, '--registry-root', env.LIBRARY_WORKSPACES], { cwd: root,
      env: { ...env, CLAUDE_PID: String(process.pid), DESKPOST_ASSISTANT: 'claude' } }).exit, 0, `${label}: init`);
    for (const [who, seat] of ['first', 'second'].entries()) {
      json(cli(who, ['hub', 'new', seat, '--title', seat, '--json']));
      const args = ['seat', 'enter', seat, '--create', '--project', seat, '--agent-pid', String(agents[who]!.pid), '--deadline-seconds', '10'];
      const preflight = json(cli(who, [...args, '--preflight']));
      json(cli(who, [...args, '--plan-id', String(preflight['plan_id'])]));
      equal(cli(who, ['desk', 'open', 'book', 'letters', '--location', 'shelf', '--seat', seat]).exit, 0, `${label}: open letters`);
    }
  } catch (error) { await dispose(); throw error; }
  const file = (page: string) => path.join(ws, 'shelf', 'letters', 'wiki', `${page}.md`);
  const capture = (who: number, args: string[], assistant = 'claude') => json(cli(who,
    ['capture', 'letters', ...args, '--body', 'Please look.', '--json'], assistant));
  const activity = (seat: string, extra: Record<string, unknown>) => {
    const session = '14000000-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(ws, '.claude', 'seats', seat, 'activity.json'), JSON.stringify({ seat,
      last_seen_utc: '2999-01-01T00:00:00Z', session_id: session, conversation_recorded_utc: '2999-01-01T00:00:00Z',
      message_session_id: session, ...extra }));
  };
  return { root, ws, cli, json, capture, file, activity, dispose };
}

async function section1400(): Promise<void> {
  const w = await letterWorkspace('ring-lines');
  try {
    for (const assistant of ['claude', 'codex']) {
      for (const named of [true, false]) {
        w.activity('second', named ? { message_name: 'second-peer' } : {});
        const letter = w.capture(0, ['--for', 'second', '--title', `${assistant} ${named}`], assistant);
        const ring = `From first: a letter for you, letters ${letter['page']}`;
        equal(letter['ring_line'], ring, `1400: ${assistant} ${named} exact ring line`);
        equal(letter['ring_to'], named ? 'second-peer' : null, `1400: ${assistant} ${named} ring destination`);
        if (named) check(String(letter['next']).includes(`first line "${ring}"`), `1400: ${assistant} ring in next`);
        if (assistant === 'codex') {
          const relay = `Tell second: a letter for you, letters ${letter['page']}`;
          equal(letter['relay_line'], relay, `1400: ${named} Codex relay line`);
          check(String(letter['next']).includes(`Put this line in your reply for Eric: "${relay}"`), `1400: ${named} relay instruction`);
        } else check(!('relay_line' in letter), `1400: Claude has no relay ${named}`);
      }
    }
    w.activity('second', { assistant: 'codex' });
    const codex = w.capture(0, ['--for', 'second', '--title', 'Codex recipient'], 'codex');
    check(!('relay_line' in codex) && !('ring_line' in codex), '1400: Codex recipient has no ring or relay');
    equal(w.cli(2, ['hub', 'new', 'closed', '--title', 'Closed']).exit, 0, '1400: closed Hub created');
    equal(w.cli(2, ['seat', 'start', 'closed', '--project', 'closed', '--no-launch']).exit, 0, '1400: free seat created');
    const closed = w.capture(0, ['--for', 'closed', '--title', 'Closed recipient'], 'codex');
    check(!('relay_line' in closed), '1400: closed recipient has no relay');
    w.activity('first', { message_name: 'first-peer' });
    const answer = w.capture(1, ['--answers', String(codex['page']), '--title', 'Answer'], 'claude');
    equal(answer['ring_line'], `From second: a letter for you, letters ${answer['page']}`, '1400: answer rings first asker');
    equal(answer['ring_to'], 'first-peer', '1400: answer ring destination');
  } finally { await w.dispose(); }
}

async function section1401(): Promise<void> {
  const w = await letterWorkspace('follow-up');
  try {
    const read = (page: string) => fs.readFileSync(w.file(page), 'utf8');
    const hash = (page: string) => createHash('sha256').update(fs.readFileSync(w.file(page))).digest('hex');
    for (const how of ['answer', 'own close', 'triage', 'route']) {
      const letter = w.capture(0, ['--for', 'second', '--title', `Closed by ${how}`], 'claude');
      const page = String(letter['page']);
      if (how === 'answer') w.capture(1, ['--answers', page, '--title', 'First answer'], 'codex');
      else if (how === 'own close') equal(w.cli(1, ['letters', 'close', page], 'codex').exit, 0, '1401: own close');
      else if (how === 'route') w.capture(1, ['--for', 'first', '--routes', page, '--title', 'Route'], 'codex');
      else fs.writeFileSync(w.file(page), read(page).replace('review: pending', 'review: done'));
      const before = hash(page);
      const follow = w.capture(1, ['--answers', page, '--title', `Follow-up ${how}`], 'codex');
      equal(follow['for_seat'], 'first', `1401: ${how} reply to first asker`);
      equal(follow['answers'], page, `1401: ${how} JSON links follow-up`);
      if (typeof follow['page'] === 'string') check(read(follow['page']).includes(`answers: ${page}\n`), `1401: ${how} reply frontmatter link`);
      same(follow['answered'], { page, status: 'unchanged' }, `1401: ${how} says unchanged`);
      check(String(follow['next']).includes(`${page} was already closed; this reply is linked to it and leaves it closed.`), `1401: ${how} next explains follow-up`);
      equal(hash(page), before, `1401: ${how} closed bytes unchanged`);
      const wrong = w.cli(0, ['capture', 'letters', '--answers', page, '--title', 'Wrong seat', '--body', 'No'], 'claude');
      check(wrong.exit !== 0 && wrong.stderr.includes("letter for seat 'second'"), `1401: ${how} wrong recipient refused by name`);
      const close = w.cli(1, ['letters', 'close', page, '--json'], 'codex');
      if (how === 'own close') {
        equal(w.json(close)['status'], 'already closed', '1401: repeat own close succeeds unchanged');
        equal(hash(page), before, '1401: repeat close changes no bytes');
        equal(w.cli(1, ['capture', 'letters', '--for', 'first', '--routes', page, '--title', 'Another route', '--body', 'No'], 'codex').exit, 0, '1401: own-close proof still permits route');
      } else {
        check(close.exit !== 0 && close.stderr.includes('already closed'), `1401: ${how} repeat close still refused`);
        const route = w.cli(1, ['capture', 'letters', '--for', 'first', '--routes', page, '--title', 'Another route', '--body', 'No'], 'codex');
        check(route.exit !== 0 && route.stderr.includes('already closed'), `1401: ${how} route still refused`);
      }
    }
    for (const field of ['answered_by', 'routed_to']) {
      const letter = w.capture(0, ['--for', 'second', '--title', `Reopened ${field}`], 'claude');
      const page = String(letter['page']);
      fs.writeFileSync(w.file(page), read(page).replace('review: pending', `review: pending\n${field}: notes/prior`));
      const refused = w.cli(1, ['capture', 'letters', '--answers', page, '--title', 'Reopened answer', '--body', 'No'], 'codex');
      check(refused.exit !== 0 && refused.stderr.includes(`still carries ${field}`), `1401: reopened ${field} still refused`);
    }
  } finally { await w.dispose(); }
}

async function section1402(): Promise<void> {
  const w = await letterWorkspace('reopened-list');
  const started = Date.now();
  try {
    const empty = w.cli(1, ['letters', 'list'], 'codex');
    equal(empty.stdout.trim(), "No open letters for seat 'second'.", '1402: empty list is unchanged');
    const open = w.capture(0, ['--for', 'second', '--title', 'Ordinary open'], 'claude');
    const oldText = w.cli(1, ['letters', 'list'], 'codex').stdout;
    const oldJson = w.json(w.cli(1, ['letters', 'list', '--json'], 'codex'));
    equal(oldJson['count'], 1, '1402: ordinary open count unchanged');
    check(!('reopened_count' in oldJson), '1402: no reopened_count key without reopened letters');
    check(!('reopened' in oldJson['letters'][0]), '1402: ordinary JSON row unchanged');
    const other = w.capture(1, ['--for', 'first', '--title', 'Other seat reopened'], 'codex');
    const reopen = (page: string, field: string) => fs.writeFileSync(w.file(page), fs.readFileSync(w.file(page), 'utf8')
      .replace('review: pending', `review: pending\n${field}: notes/prior`));
    reopen(String(other['page']), 'answered_by');
    equal(w.cli(1, ['letters', 'list'], 'codex').stdout, oldText, '1402: another seat reopened letter does not change output');
    for (const field of ['answered_by', 'routed_to']) {
      const letter = w.capture(0, ['--for', 'second', '--title', `Reopened ${field}`], 'claude');
      const page = String(letter['page']);
      reopen(page, field);
      const text = w.cli(1, ['letters', 'list'], 'codex').stdout;
      const listed = w.json(w.cli(1, ['letters', 'list', '--json'], 'codex'));
      const row = listed['letters'].find((item: Record<string, unknown>) => item['page'] === page);
      equal(row?.['reopened'], true, `1402: ${field} reopened JSON row`);
      check(text.includes(`from first: Reopened ${field}  [reopened: answer with a new letter --for first, or close it with triage]`), `1402: ${field} remedy line`);
      check(!text.includes(String(other['page'])), '1402: other seat still absent');
      check(text.indexOf(String(open['page'])) < text.indexOf(page), '1402: open letters precede reopened letters');
      const count = field === 'answered_by' ? 1 : 2;
      check(text.includes(`1 open letter, ${count} reopened for seat 'second', oldest first:`), `1402: ${field} count line`);
      check(listed['count'] === 1 && listed['reopened_count'] === count, `1402: ${field} JSON counts open and reopened apart: ${JSON.stringify(listed)}`);
      const close = w.cli(1, ['letters', 'close', page], 'codex');
      check(close.exit !== 0 && close.stderr.includes(`still carries ${field}`), `1402: ${field} close still refused`);
    }
  } finally {
    await w.dispose();
    process.stdout.write(`section 1402 elapsed: ${(Date.now() - started) / 1000}s\n`);
  }
}

async function section1403(): Promise<void> {
  const w = await letterWorkspace('tidy-moved-section');
  try {
    for (const [page, prefix, names] of [
      ['host', '# Fixture\n\n## Queue\n\n- [ ] Keep.\n\n', ['Review of s1']],
      ['first', '', ['First review']],
      ['pair', '# Fixture\n\n## Queue\n\n- [ ] Keep.\n\n', ['Review of s1', 'Review of s2']],
    ] as const) {
      const body = prefix + names.map(name => `## ${name}\n\n- Accepted ${name}.\n\n`).join('') + '## Later\n\n- [ ] Keep later.\n';
      const file = path.join(w.ws, 'collection/projects/first', `${page}.md`);
      fs.writeFileSync(file, body);
      const args = ['hub', 'tidy', 'first', '--page', page, ...names.flatMap(name => ['--section', name])];
      const pre = w.json(w.cli(0, [...args, '--preflight'], 'codex'));
      equal(pre['proof'], 'passed', `1403: ${page} preflight preserves every line`);
      const applied = w.json(w.cli(0, [...args, '--user-confirmed', '--plan-id', String(pre['plan_id'])], 'codex'));
      equal(applied['written'], true, `1403: ${page} applied`);
      const after = fs.readFileSync(file, 'utf8');
      const pointers = after.split('\n').filter(line => line.startsWith('Tidied '));
      equal(pointers.length, names.length, `1403: ${page} one pointer per moved section`);
      for (const [index, name] of names.entries()) {
        check(pointers[index]?.includes(` from ## ${name}:`) === true, `1403: ${page} pointer ${index} names ${name}: ${pointers.join(' | ')}`);
        check(!after.split('\n').includes(`## ${name}`), `1403: ${page} moved heading absent`);
      }
      check(!pointers.some(line => /from ## (?:Queue|\(page\)):/.test(line)), `1403: ${page} no host or page name`);
      check(after.indexOf(pointers[0] ?? 'missing pointer') < after.indexOf('## Later'), `1403: ${page} pointer stays before later section`);
      if (prefix) check(after.indexOf('- [ ] Keep.') < after.indexOf(pointers[0] ?? 'missing pointer'), `1403: ${page} pointer follows host content`);
      else check(after.trimStart().startsWith('Tidied '), '1403: first section pointer stands at page top');
      const history = fs.readFileSync(path.join(w.ws, 'collection', String(pre['notes_page_path'])), 'utf8');
      for (const name of names) check(history.includes(`## ${name}\n\n- Accepted ${name}.`), `1403: ${page} history keeps ${name} whole`);
    }
  } finally { await w.dispose(); }
}

async function section1404(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const prohibited = 'STAY OUT OF: Never run `git push origin master`; do not run `node tools/gate.ts --tier push`.';
  same(kc.builderPushLines(prohibited), [], '1404: quoted push prohibitions pass');
  equal(kc.builderPushLines('Run `node tools/gate.ts --tier push`, never skip it.').length, 1, '1404: later never does not excuse an order');
  same(kc.builderPushLines('ROWS:\n1. Run no `gate.ts --tier push`; the lander checks it.'), [], '1404: section 240 no gate form');
  same(kc.builderPushLines('NOT CHARTERED: `node tools/gate.ts --tier push`.'), [], '1404: section 240 exempt heading');
  same(kc.builderPushLines('TRAIN: release-1-2-0\nROWS: `node tools/gate.ts --tier push`.'), [], '1404: section 240 release');
  equal(kc.builderPushLines('Push with `git push origin int/c137:master`.').length, 1, '1404: section 240 master refspec');
  for (const command of ['node ./tools/gate.ts --tier push', 'git -C . push origin HEAD:master', 'git -c core.foo=bar --no-pager --literal-pathspecs push origin HEAD:refs/heads/master']) {
    equal(kc.builderPushLines(`Run \`${command}\`.`).length, 1, `1404: refuse push form ${command}`);
  }
  same(kc.builderPushLines('Run `git -C . push origin int/c155`.'), [], '1404: feature branch push passes');
}

async function section1405(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const areas = { lanes: { 'hubs-and-letters': ['hubs'], tooling: ['tooling'] }, areas: { hubs: [], tooling: ['tools/kickoff-check.mts', 'tools/gate.ts', 'tools/land.mts'] } };
  const text = 'WHY NOW:\n- **Lane:** hubs-and-letters\n- **Cross-lane:** `tools/kickoff-check.mts` for checking.\n- **Cross-lane:** `tools/gate.ts` for gate proof.\nOWNS PATHS:\n- `tools/kickoff-check.mts`\n- `tools/gate.ts`\nSTAY OUT OF: nothing';
  same(kc.laneProblems(text, areas), [], '1405: every Cross-lane line counts');
  const problems = kc.laneProblems(text.replace('STAY OUT OF:', '- `tools/land.mts`\nSTAY OUT OF:'), areas);
  check(problems.length === 1 && problems[0]!.includes('tools/land.mts'), `1405: undeclared third path refused: ${JSON.stringify(problems)}`);
}

async function section1406(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const record = { schema: 1, items: [ { id: 'main', status: 'open' }, { id: 'first', status: 'open' }, { id: 'second', status: 'open' }, { id: 'finished', status: 'done' } ] };
  const text = 'TRAIN: main (lane:fixes)\n';
  const bad = kc.trainProblems(text + 'SPARE TRAIN: `finished`, absent\n', record);
  same(bad, ['finished', 'absent'].map(id => `SPARE TRAIN id '${id}' is not an open item in the train register; a spare comes from the open train`), '1406: done and absent spare ids refused');
  same(kc.trainProblems(text + 'SPARE TRAIN: `first`, second\n', record), [], '1406: two open spare ids pass');
  same(kc.trainProblems(text, record), [], '1406: no spare line unchanged');
}

async function section1407(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const owns = "In `kernel/src/verbs.ts`: the `train` declaration's `usage`, `details` and argument table only.";
  const rows = '1. Add `train weigh <id> [--lane <slug>]`.\n   Done when: it sets.\n2. Add `deskpost train check [--json]` and keep `train page --by lane`.\n   Done when: it checks.';
  const text = `OWNS: ${owns}\nOWNS PATHS:\n- \`kernel/src/verbs.ts\`\nSTAY OUT OF: nothing\nROWS:\n${rows}\nCHARTER: build`;
  const warnings = (body: string) => kc.kickoffVerdict(body, { adrFiles: [] }).warnings.filter(line => line.includes('commandAction, kernel/src/verbs.ts'));
  const found = warnings(text);
  check(found.length === 1 && found[0]!.startsWith('row 1 names train weigh,') && !found[0]!.includes('train page'), `1407: warn once for the first new action: ${JSON.stringify(found)}`);
  check(!kc.kickoffVerdict(text, { adrFiles: [] }).problems.some(line => line.includes('commandAction,')), '1407: missing actions ownership warns only');
  same(warnings(text.replace('and argument table', ', `actions` and argument table')), [], '1407: owning actions suppresses the warning');
  same(warnings(text.replace(rows, '1. Keep `train page --by lane`.\n   Done when: it lists.')), [], '1407: existing action passes');
  same(warnings(text.replace('- `kernel/src/verbs.ts`', '- `kernel/src/train.ts`')), [], '1407: no verbs.ts ownership passes');
  same(warnings(text.replace('`train` declaration', '`train` implementation')), [], '1407: other declaration phrasing passes');
  const prefixed = warnings(text.replace('train weigh <id> [--lane <slug>]', 'deskpost train weigh <id>'));
  check(prefixed.length === 1 && prefixed[0]!.startsWith('row 1 names train weigh,'), '1407: optional deskpost prefix');
  same(warnings(text.replace(rows, '1. Read `train --json`, `train <id>` and `unknown set`.\n   Done when: read.')), [], '1407: options, placeholders and unknown verbs pass');
}

async function section1408(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const probes = [
    'No row is done until you run `git push origin master`.',
    'Never forget to run `git push origin master`.',
    "Don't wait for review, just run `git push origin master`.",
    'Never mind the hold, run `git push origin master`.',
    'Do not stop, run `node tools/gate.ts --tier push`.',
    'No need to wait, then `git push origin HEAD:master`.',
    'Run with no `--force` `git push origin master`.',
  ];
  for (const sentence of probes) {
    same(kc.builderPushLines(`ROWS:\n1. ${sentence}`).map(found => found.line), [2], `1408: structural order: ${sentence}`);
    for (const heading of ['STAY OUT OF', 'NOT CHARTERED', 'NOT BUILDING']) {
      same(kc.builderPushLines(`${heading}:\n${sentence}`), [], `1408: prohibition under ${heading}: ${sentence}`);
    }
  }
  for (const command of [
  "npm test | git push origin master",
  "npm test & git push origin master",
  "env X=1 git push origin master",
  "(git push origin master)",
  "git push origin \"master\"",
  "git push --all origin",
  "git push --mirror origin",
  "node.exe tools/gate.ts --tier push",
  "npx tsx tools/gate.ts --tier push",
  "node --env-file .env tools/gate.ts --tier push",
  "node --env-file-if-exists .env tools/gate.ts --tier push"
]) {
    same(kc.builderPushLines('ROWS:\n1. Run '+String.fromCharCode(96)+command+String.fromCharCode(96)+'.').map(found => found.line), [2], '1408: extra push form '+command);
  }
  for (const command of ['git log --all', 'npx tsx tools/other.ts --tier push']) {
    same(kc.builderPushLines('ROWS:\n1. Run '+String.fromCharCode(96)+command+String.fromCharCode(96)+'.'), [], '1408: other command '+command);
  }
  for (const heading of ['ROWS', 'NOT CHARTERED', 'STAY OUT OF', 'NOT BUILDING']) {
    const fence = String.fromCharCode(96).repeat(3);
    same(kc.builderPushLines(`${heading}:\n${fence}powershell\ngit push origin master\n${fence}`).map(found => found.line), heading === 'ROWS' ? [3] : [], `1408: fenced push under ${heading}`);
    same(kc.builderPushLines(`${heading}:\n${fence}\ngit log\n${fence}`), [], `1408: fenced log under ${heading}`);
  }
  const cases: [string, string, number[]][] = [
    ...[
      'git --git-dir .git push origin master',
      'git --work-tree . push origin master',
      'git --namespace example push origin master',
      'git --exec-path tools push origin master',
      'git -P push origin master',
      'node --no-warnings tools/gate.ts --tier push',
      'node --import module tools/gate.ts --tier push',
      'node D:/repo/tools/gate.ts --tier=push',
      'node D:\\repo\\tools\\gate.ts --tier push',
      'npm test && git push origin master',
      'npm test || node tools/gate.ts --tier push',
      'npm test; git push origin master',
    ].map(command => [command, `ROWS:\n1. Run \`${command}\`.`, [2]] as [string, string, number[]]),
    ['git-dir without push', 'ROWS:\n1. Run `git log --git-dir x`.', []],
    ['negation earlier', 'ROWS:\n1. If the hook does not fail, run `git push origin master`.', [2]],
    ['not later', 'ROWS:\n1. Now, not later, run `git push origin HEAD:master`.', [2]],
    ['negation inside code', 'ROWS:\n1. Run `npm test --no-color`, then `git push origin master`.', [2]],
    ['plain order', 'ROWS:\n1. Run `git push origin master`.', [2]],
    ['one-line triple span', 'ROWS:\n```git push origin master```\n1. Run `git push origin master`.', [2, 3]],
    ['unclosed fence leaves later inline order visible', 'ROWS:\n```sh\n1. Run `git push origin master`.', [3]],
    ['two-command prohibition', 'STAY OUT OF: Never run `node tools/gate.ts --tier push` or `git push origin master`.', []],
    ['deferred git-dir form', 'ROWS:\n1. Run `git --git-dir .git push origin master`.', [2]],
    ['stay out opening', 'STAY OUT OF: Do not run `git push origin master`.', []],
    ['close label', 'Close: Never use `git push origin master`.', [1]],
    ['governing suffix', 'ROWS:\n1. For this unit you must not run `git push origin master`.', [2]],
  ];
  for (const [name, text, expected] of cases) {
    const actual = kc.builderPushLines(text).map(found => found.line);
    same(actual, expected, `1408: ${name}: lines ${JSON.stringify(actual)}`);
  }
  for (const heading of ['STAY OUT OF', 'NOT CHARTERED', 'NOT BUILDING', 'ROWS']) {
    for (const boundary of ['NOTE:', 'Context:', '  ROWS:']) {
      const body = `${heading}:\n${boundary} Run \`git push origin master\`.`;
      const starts = kc.sectionStarts(body);
      equal(starts.length, 1, `1408: ${heading} boundary ${boundary} keeps one section`);
      equal(starts[0]?.name, heading, `1408: ${heading} boundary ${boundary} agrees with parser`);
      same(kc.builderPushLines(body).map(found => found.line), heading === 'ROWS' ? [2] : [], `1408: ${heading} boundary ${boundary}`);
    }
  }
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-c155-areas-'));
  try {
    for (const file of ['tools/kickoff-check.mts', 'kernel/src/kickoffcheck.ts', 'kernel/src/verbs.ts', 'kernel/src/contentpath.ts', 'kernel/test/gate-lock.ts']) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(PROGRAM_ROOT, file), target);
    }
    fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/areas.json'), '{ malformed');
    const file = path.join(root, 'kickoff.md');
    fs.writeFileSync(file, kc.REQUIRED_SECTIONS.map(name => name === 'ROWS' ? 'ROWS:\n1. Check.\n   Done when: checked.' : name === 'CLOSE' ? 'CLOSE: **Stop.**' : name === 'OWNS PATHS' ? 'OWNS PATHS:\n- `a.ts`' : `${name}: filled`).join('\n'));
    const ran = spawnSync(process.execPath, [path.join(root, 'tools/kickoff-check.mts'), file],
      { env: { ...childEnv(), DESKPOST_GATE_DIR: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check(ran.status === 1 && `${ran.stdout}${ran.stderr}`.includes('docs/areas.json'), `1408: malformed areas refused by name: ${ran.status}: ${ran.stdout}${ran.stderr}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1409(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const record = { schema: 1, items: [{ id: 'main', status: 'open' }, { id: 'spare', status: 'open' }, { id: 'finished', status: 'done' }] };
  const main = 'TRAIN: main (lane:fixes)\n';
  same(kc.trainProblems(main + 'SPARE TRAIN: spare (lane:fixes), finished (note), absent\n', record),
    ['finished', 'absent'].map(id => `SPARE TRAIN id '${id}' is not an open item in the train register; a spare comes from the open train`), '1409: every id after notes checked');
  same(kc.trainProblems(main + 'SPARE TRAIN: none (taken elsewhere)\n', record), [], '1409: none with note means no spares');
  check(kc.trainProblems(main + 'SPARE TRAIN: Kickoff Check\n', record).some(line => line.includes('SPARE TRAIN: Kickoff Check')), '1409: no id names its line');
  same(kc.trainProblems(main + 'SPARE TRAIN: none\n', record), [], '1409: none means no spares');
  same(kc.trainProblems(main + 'SPARE TRAIN: spare (lane:fixes)\n', record), [], '1409: spare id stops before note');
  same(kc.trainProblems(main + 'SPARE TRAIN: spare\nSPARE TRAIN: finished\n', record),
    ["SPARE TRAIN id 'finished' is not an open item in the train register; a spare comes from the open train"], '1409: second spare line is checked');
  check(kc.trainProblems(main + 'SPARE TRAIN: spare, Kickoff Check\n', record).some(line => line.includes('Kickoff Check')), '1409: malformed piece after valid id is named');
  same(kc.trainProblems(main + 'SPARE TRAIN: a (lane:fixes), b\n', { schema: 1, items: [...record.items, { id: 'a', status: 'open' }, { id: 'b', status: 'open' }] }), [], '1409: notes keep both valid pieces');
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-c155-train-order-'));
  try {
    const file = path.join(root, 'kickoff.md'), register = path.join(root, 'train.json');
    const body = kc.REQUIRED_SECTIONS.map(name => name === 'ROWS' ? 'ROWS:\n1. Check.\n   Done when: checked.' : name === 'CLOSE' ? 'CLOSE: **Stop.**' : name === 'OWNS PATHS' ? 'OWNS PATHS:\n- `a.ts`' : `${name}: main`).join('\n');
    fs.writeFileSync(file, body);
    fs.writeFileSync(register, JSON.stringify(record));
    for (const args of [[file, '--train', register], ['--train', register, file]]) {
      const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), ...args],
        { env: { ...childEnv(), DESKPOST_GATE_DIR: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      equal(ran.status, 0, `1409: train argument order ${JSON.stringify(args)}: ${ran.stdout}${ran.stderr}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1410(): Promise<void> {
  const w = await letterWorkspace('reopened-first-asker');
  const agent = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' })
    : spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  agent.unref();
  const home = path.join(w.root, 'home');
  const thirdCli = (args: string[]) => runCli([...args, '--workspace', w.ws], { cwd: w.root, env: {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(w.root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '',
    CLAUDE_PID: String(agent.pid), DESKPOST_ASSISTANT: 'codex' } });
  try {
    w.json(thirdCli(['hub', 'new', 'third', '--title', 'Third', '--json']));
    const enter = ['seat', 'enter', 'third', '--create', '--project', 'third', '--agent-pid', String(agent.pid), '--deadline-seconds', '10'];
    const pre = w.json(thirdCli([...enter, '--preflight']));
    w.json(thirdCli([...enter, '--plan-id', String(pre['plan_id'])]));
    equal(thirdCli(['desk', 'open', 'book', 'letters', '--location', 'shelf', '--seat', 'third']).exit, 0, '1410: third opens letters');
    const original = w.capture(0, ['--for', 'second', '--title', 'First asker'], 'claude');
    const routed = w.capture(1, ['--routes', String(original['page']), '--for', 'third', '--title', 'Routed asker'], 'codex');
    const page = String(routed['page']);
    const file = w.file(page);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace('review: pending', 'review: pending\nanswered_by: notes/prior');
    fs.writeFileSync(file, text);
    const listed = thirdCli(['letters', 'list']);
    equal(listed.exit, 0, '1410: routed reopened list succeeds');
    check(listed.stdout.includes('answer with a new letter --for first,') && !listed.stdout.includes('--for second'), '1410: routed remedy names first asker, not router: ' + listed.stdout);
    const row = w.json(thirdCli(['letters', 'list', '--json']))['letters'].find((item: Record<string, unknown>) => item['page'] === page);
    equal(row?.['asker'], 'first', '1410: routed JSON asker');
    fs.writeFileSync(file, text.replace(/\norigin_library_id: [^\n]*/g, '').replace('review: pending', 'origin_library_id: 11111111-1111-4111-8111-111111111111\nreview: pending'));
    const away = thirdCli(['letters', 'list']);
    equal(away.exit, 0, '1410: foreign reopened list succeeds');
    check(away.stdout.includes('the first asker is first in another Library; answer with a new letter through the Postbox, or close it with triage') && !away.stdout.includes('--for '), '1410: foreign remedy names Postbox and has no local --for: ' + away.stdout);
    fs.writeFileSync(file, text.replace(/^(?:origin_seat|origin_seat_id|from_seat|from_seat_id):.*\n/gm, ''));
    const missing = thirdCli(['letters', 'list']);
    check(missing.exit === 0 && missing.stdout.includes('[reopened: answer with a new letter, or close it with triage]'), '1410: missing asker has no invented recipient');
    const missingRow = w.json(thirdCli(['letters', 'list', '--json']))['letters'].find((item: Record<string, unknown>) => item['page'] === page);
    equal(missingRow?.['asker'], null, '1410: missing JSON asker is null');
  } finally { agent.kill(); await w.dispose(); }
}

async function section1411(): Promise<void> {
  const w = await letterWorkspace('answer-preview-scope');
  try {
    const letter = w.capture(0, ['--for', 'second', '--title', 'Preview answer'], 'claude');
    const page = String(letter['page']);
    const args = ['capture', 'letters', '--answers', page, '--title', 'Answer preview', '--body', 'Answered.', '--json'];
    const open = w.json(w.cli(1, [...args, '--preflight'], 'codex'));
    const expected = `It also closes ${page} (review: done, reviewed:, answered_by:), journalled with the new note. Nothing is removed.`;
    check(String(open['scope']).endsWith(expected), '1411: open answer scope keeps exact closing text');
    const appliedOpen = w.json(w.cli(1, args, 'codex'));
    equal(appliedOpen['scope'], open['scope'], '1411: open applied scope matches preview');
    const closed = w.json(w.cli(1, [...args, '--preflight'], 'codex'));
    check(String(closed['scope']).endsWith(`It links to ${page}, which is already closed and is left unchanged; nothing is removed.`) && !String(closed['scope']).includes('It also closes'), '1411: closed answer preview says already closed and is left unchanged: ' + closed['scope']);
    const appliedClosed = w.json(w.cli(1, args, 'codex'));
    equal(appliedClosed['scope'], closed['scope'], '1411: closed applied scope matches preview');
    equal(appliedClosed['answered']?.status, 'unchanged', '1411: closed application agrees with scope');
  } finally { await w.dispose(); }
}

async function section1412(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const body = 'TRAIN: main\nWHY NOW: fix\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: nothing\nROWS:\n1. Change a.\n   Done when: checked.\nNOT BUILDING:\n2. A sentence without completion.\nNET LINES: small\nCHARTER: build\nCLOSE: **Stop.**';
  same(kc.describeProblems(kc.checkKickoff(body)), [], '1412: NOT BUILDING ends numbered rows');
  const verdict = kc.kickoffVerdict(body, { adrFiles: [] });
  check(verdict.sectionNames.includes('NOT BUILDING') && verdict.sectionNames.includes('NET LINES'), '1412: both headings are recognized');
  const spare = 'OWNS: In `kernel/src/verbs.ts`: the `train` declaration usage only.\nOWNS PATHS:\n- `kernel/src/verbs.ts`\nSTAY OUT OF: nothing\nROWS:\nS1. Add `deskpost train weigh <id>`.\n   Done when: checked.\nCHARTER: build';
  check(kc.kickoffVerdict(spare, { adrFiles: [] }).warnings.some(line => line.startsWith('row S1 names train weigh,')), '1412: spare adding an action warns');
  check(!kc.kickoffVerdict(spare.replace('usage only', 'usage and actions'), { adrFiles: [] }).warnings.some(line => line.includes('commandAction,')), '1412: spare owning actions passes');
}

async function section1413(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const invalid = kc.ownsPaths('OWNS PATHS:\n- `a.ts` extra\nSTAY OUT OF: nothing').problems.join('\n');
  check(invalid.includes('one backticked path or glob per bullet') && invalid.includes('nothing after it'), '1413: invalid entry says its shape');
  for (const absolute of ['/outside/file.ts', 'D:/outside/file.ts']) {
    const problem = kc.ownsPaths(`OWNS PATHS:\n- \`${absolute}\`\nSTAY OUT OF: nothing`).problems.join('\n');
    check(problem.includes('OWNS PATHS lists repository paths') && problem.includes('outside the repository in OWNS'), `1413: outside file has a home: ${absolute}`);
  }
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-c155-usage-'));
  try {
    const help = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), '--help'],
      { env: { ...childEnv(), DESKPOST_GATE_DIR: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check(help.status === 2 && help.stdout.includes('--train <register file>') && help.stdout.includes('internal/train/register.json'), '1413: usage names the train register file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1414(): Promise<void> {
  const w = await letterWorkspace('letters-read-route');
  try {
    const letter = w.capture(0, ['--for', 'second', '--title', 'Read this letter'], 'codex');
    const page = String(letter['page']);
    const listed = w.cli(1, ['letters', 'list'], 'codex');
    check(listed.stdout.includes(`Read with read_open_book_page: Book letters, page ${page}.`), '1414: text names the exact validated reader route');
    const row = w.json(w.cli(1, ['letters', 'list', '--json'], 'codex'))['letters'].find((item: Record<string, unknown>) => item['page'] === page);
    same(row?.['read_route'], { tool: 'read_open_book_page', book: 'letters', page }, '1414: JSON names tool, Book and page');
  } finally { await w.dispose(); }
}

async function section1415(): Promise<void> {
  const help = runCli(['hub', 'edit', '--help']);
  equal(help.exit, 0, '1415: hub edit help succeeds');
  check(help.stdout.includes('Every column-zero entry in ## Now starts with - [ ] or - [x].'), '1415: Now entry marker rule is in help');
}

async function section1416(): Promise<void> {
  const { ownsPaths } = await import('../../src/kickoffcheck.ts');
  for (const entries of ['', '- `/a`', '- `C:a`', '- `a.ts` extra', '- ``', '- `a/../b`', '- `none`\n- `a.ts`']) {
    const problems = ownsPaths(`OWNS PATHS:\n${entries}\nSTAY OUT OF: nothing`).problems;
    check(problems.length > 0 && problems.every(line => line.startsWith('OWNS PATHS:')), `1416: every refusal has the prefix: ${entries}`);
  }
}

async function section1417(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const closed = 'ROWS:\n```sh\nNOT CHARTERED:\ngit push origin master\n```\n1. Run `git push origin master`.';
  same(kc.sectionStarts(closed).map(s => s.name), ['ROWS'], '1417: fenced heading starts no section');
  same(kc.builderPushLines(closed).map(s => s.line), [4, 6], '1417: fenced heading cannot hide either push');
  const unclosed = 'ROWS:\n```sh\n1. Run `git push origin master`.';
  const problems = kc.kickoffVerdict(unclosed, { adrFiles: [] }).problems;
  same(problems.filter(p => p.includes('unclosed code fence')), ['unclosed code fence at line 2'], '1417: unclosed fence refused once');
  same(kc.builderPushLines(unclosed).map(s => s.line), [3], '1417: unclosed fence does not hide inline push');
  same(kc.builderPushLines('ROWS:\n```git push origin master```').map(s => s.line), [2], '1417: one-line span is an order');
  const safe = 'NOT CHARTERED:\n```sh\nROWS:\ngit push origin master\n```';
  same(kc.builderPushLines(safe), [], '1417: fenced heading cannot end prohibition');
  same(kc.kickoffVerdict(closed, { adrFiles: [] }).problems.filter(p => p.includes('unclosed code fence')), [], '1417: closed fence accepted');
}

async function section1418(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-train-show-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_SEAT: 'planner', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const train = (args: string[]) => runCli(['train', ...args, '--workspace', ws], { cwd: root, env });
  try {
    equal(runCli(['init', ws], { cwd: root, env: { ...env, LIBRARY_SEAT: '' } }).exit, 0, '1418: init');
    equal(train(['add', 'sample', '--title', 'Read one item', '--place', 'foundation', '--lane', 'fixes', '--group', 'readers', '--source', 'projects/work/_project']).exit, 0, '1418: add');
    equal(train(['set', 'sample', '--note', 'Keep this note']).exit, 0, '1418: note');
    equal(train(['add', 'other', '--title', 'Other item', '--place', 'bucket:1']).exit, 0, '1418: another item');
    const file = path.join(ws, 'internal/train/register.json'), history = path.join(ws, 'internal/train/history.jsonl');
    const before = fs.readFileSync(file), log = fs.readFileSync(history);
    const item = JSON.parse(before.toString()).items.find((i: any) => i.id === 'sample');
    const text = train(['show', 'sample']);
    equal(text.exit, 0, '1418: text read');
    for (const value of Object.values(item)) check(text.stdout.includes(String(value)), `1418: text holds ${value}`);
    for (const line of log.toString().trim().split('\n').filter(line => JSON.parse(line).id === 'sample')) check(text.stdout.includes(line), '1418: matching history included');
    check(!text.stdout.includes('Other item') && !text.stdout.includes('"id":"other"'), '1418: other item and history omitted');
    const json = train(['show', 'sample', '--json']);
    equal(json.exit, 0, '1418: JSON read');
    same(JSON.parse(json.stdout || '{}'), item, '1418: JSON is stored item');
    const missing = train(['show', 'absent']);
    check(missing.exit === 1 && missing.stderr.includes('absent'), '1418: unknown id refused by name');
    const unknown = train(['unknown-action']);
    check(unknown.exit === 1 && unknown.stderr.includes('show'), '1418: unknown action lists show');
    check(before.equals(fs.readFileSync(file)) && log.equals(fs.readFileSync(history)), '1418: reads and refusals change nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1419(): Promise<void> {
  const { sectionRangeProblems } = await import('../../src/kickoffcheck.ts');
  const numbering = { section_ranges: { hubs: [1400, 1599], books: [1000, 1199], tools: [1800, 1999] }, grandfathered_sections: {} } as const;
  const body = 'WHY NOW:\n- **Lane:** hubs\n- **Cross-lane:** `kernel/test/lanes/books.ts` for a paired test.\n- **Cross-lane:** `kernel/test/lanes/tools.covers.json` for its claim.\nOWNS PATHS:\n- `kernel/test/lanes/books.ts`\n- `kernel/test/lanes/tools.covers.json`\nSTAY OUT OF: nothing';
  same(sectionRangeProblems(body, numbering), [], '1419: every Cross-lane line counts');
  const missing = body.replace('- **Cross-lane:** `kernel/test/lanes/tools.covers.json` for its claim.\n', '');
  check(sectionRangeProblems(missing, numbering).some(line => line.includes("lane tools's file")), '1419: an unnamed foreign file still refuses');
  same(sectionRangeProblems(body.replace(/books\.ts/g, 'books.*').replace(/tools\.covers\.json/g, 'tools.*'), numbering), [], '1419: patterns on both Cross-lane lines count');
}

async function section1420(): Promise<void> {
  const { docsFileRouteWarnings } = await import('../../src/kickoffcheck.ts');
  const row = (command: string) => `ROWS:\n2. Check.\n   Done when: \`${command}\` passes.\nCLOSE: **Stop.**`;
  for (const command of ['node tools/docs-gate.ts --file', 'node tools/docs-gate.ts --file ', 'node tools/docs-gate.ts --file --json', 'node tools/docs-gate.ts --file ""']) {
    const warnings = docsFileRouteWarnings(row(command));
    check(warnings.length === 1 && warnings[0]?.includes('row 2') === true && warnings[0]?.includes('--file needs a path') === true, `1420: bare file warns: ${command}`);
  }
  same(docsFileRouteWarnings(row('node tools/docs-gate.ts --file docs/readme.md')), [], '1420: document path is allowed');
  check(docsFileRouteWarnings(row('node tools/docs-gate.ts --file kernel/src/cli.ts')).some(line => line.includes('behaviour file')), '1420: behaviour path still warns');
  same(docsFileRouteWarnings('ROWS:\n2. Run `node tools/docs-gate.ts --file`.\n   Done when: checked.'), [], '1420: only Done when is judged');
}

async function section1421(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  const orders = ['node --title review tools/gate.ts --tier push', 'node -C development tools/gate.ts --tier push',
    String.raw`node C:\dev\app\tools\gate.ts --tier=push`, 'node /abs/tools/gate.ts --tier push',
    'git push --repo=origin master', 'git push --repo origin master', 'git --git-dir .git push origin master',
    'git -P push origin master', 'git status && git push origin master'];
  const safe = ['node tools/other.ts --tier push', 'node --title tools/gate.ts other.ts --tier push',
    'git log --oneline master', 'git push origin int/w21', 'git push --repo=origin int/w21'];
  for (const command of orders) {
    equal(builderPushLines('ROWS:\n1. Run `' + command + '`.').length, 1, `1421: order: ${command}`);
    equal(builderPushLines('NOT CHARTERED:\n`' + command + '`').length, 0, `1421: prohibition: ${command}`);
  }
  for (const command of safe) equal(builderPushLines('ROWS:\n1. Run `' + command + '`.').length, 0, `1421: safe: ${command}`);
}


async function section1422(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  for (const command of ["printf '%s' 'example; git push origin master ; end'", "echo 'a && git push origin master'", 'echo "a || git push origin master"'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 0, `1422: quoted text: ${command}`);
  for (const command of ['true; git push origin master', "'node' tools/gate.ts --tier push"])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 1, `1422: command: ${command}`);
}


async function section1423(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const kc = await import('../../src/kickoffcheck.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-base-'));
  try {
    const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
    const base = spawnSync('git', ['-C', PROGRAM_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: repositoryNeutralEnv() }).stdout.trim();
    fs.writeFileSync(path.join(root, 'slots'), JSON.stringify({ slots: 2, u2Tip: base }));
    const block = kc.templateBlock(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs/kickoff-template.md'), 'utf8'));
    const run = (value: string) => {
      const file = path.join(root, 'kickoff.md');
      fs.writeFileSync(file, block.replace('as committed at `<SHA>`', 'as committed at ' + value));
      return spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), file],
        { encoding: 'utf8', timeout: 60000, env: { ...childEnv(), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
          TEMP: root, TMP: root, TMPDIR: root, DESKPOST_GATE_DIR: root, DESKPOST_KICKOFF_TEST_REPOSITORY: PROGRAM_ROOT } });
    };
    const unquoted = run('4a33b3c6;');
    check(unquoted.status === 1 && unquoted.stdout.includes('header holds "4a33b3c6"'), '1423: unquoted header value named');
    const empty = run('');
    check(empty.status === 1 && empty.stdout.includes('header holds nothing'), '1423: absent header value named');
    const valid = run('`' + base + '`');
    check(valid.status === 0 && !valid.stdout.includes('BASE:'), `1423: full backticked base passes: ${valid.stdout}${valid.stderr}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}


async function section1424(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  same(builderPushLines('ROWS:\n```sh\necho safe\n```git push origin master```'), [], '1424: closing fence inline span is a marker');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-history-'));
  const ws = path.join(root, 'ws');
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: root,
    TEMP: root, TMP: root, TMPDIR: root, LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'),
    LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  try {
    equal(runCli(['init', ws], { cwd: root, env }).exit, 0, '1424: init');
    equal(runCli(['train', 'add', 'sample', '--title', 'Sample', '--place', 'foundation', '--workspace', ws], { cwd: root, env: { ...env, LIBRARY_SEAT: 'planner' } }).exit, 0, '1424: add');
    fs.appendFileSync(path.join(ws, 'internal/train/history.jsonl'), '\n{damaged\n');
    const result = runCli(['train', 'show', 'sample', '--workspace', ws], { cwd: root, env });
    check(result.exit === 1 && result.stderr.includes('internal/train/history.jsonl') && result.stderr.includes('line 3'), '1424: damaged history names file and line: ' + result.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}


async function section1425(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const body = 'OWNS:\n- New sections 1425 to 1426.\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: nothing';
  const started = Date.now();
  const taken = kickoffVerdict(body, { adrFiles: [], covers: { '1425': ['kernel/src/x.ts'] } }).warnings;
  check(taken.some(w => w.includes('1425') && w.includes('taken at the base')), '1425: taken number warns');
  check(!taken.some(w => w.includes('1426') && w.includes('taken at the base')), '1425: free number does not warn');
  check(!kickoffVerdict(body, { adrFiles: [] }).warnings.some(w => w.includes('taken at the base')), '1425: no claims gives no taken warning');
  check(Date.now() - started < 2000, '1425: warnings take under two seconds');
}


async function section1427(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-own-page-temp-'));
  const saved = [process.env['TEMP'], process.env['TMP'], process.env['TMPDIR']];
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
  const w = await letterWorkspace('w21-own-page');
  try {
    equal(w.cli(0, ['desk', 'open', 'project', 'first']).exit, 0, '1427: open Hub');
    const body = (page: string) => '# sample kickoff: self link\nTRAIN: sample\nWHY NOW: [[projects/first/' + page + ']]\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: nothing\nROWS:\n1. Change.\n   Done when: checked.\nCHARTER: build\nCLOSE: **Stop.**';
    const file = path.join(w.root, 'kickoff.md');
    fs.writeFileSync(file, body('kickoffs/sample'));
    const posted = w.cli(0, ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'kickoffs/sample', '--content-path', file]);
    equal(posted.exit, 0, '1427: self-link posts: ' + posted.stderr);
    check(fs.existsSync(path.join(w.ws, 'collection/projects/first/kickoffs/sample.md')), '1427: self-link page written');
    fs.writeFileSync(file, body('kickoffs/absent'));
    const absent = w.cli(0, ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'kickoffs/other', '--content-path', file]);
    check(absent.exit === 1 && absent.stderr.includes('projects/first/kickoffs/absent'), '1427: another absent page refused');
  } finally { await w.dispose(); }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}


async function section1429(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-library-card-temp-'));
  const saved = [process.env['TEMP'], process.env['TMP'], process.env['TMPDIR']];
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
  const w = await letterWorkspace('w21-library-card');
  try {
    const local = w.capture(0, ['--for', 'second', '--title', 'Local letter'], 'codex');
    const remote = w.capture(0, ['--for', 'second', '--title', 'Remote letter'], 'codex');
    const file = w.file(String(remote['page']));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('review: pending', 'review: pending\nfrom_library_card: Far Library\nfrom_library_id: 14000000-0000-4000-8000-000000000002'));
    const listed = w.cli(1, ['letters', 'list'], 'codex');
    equal(listed.exit, 0, '1429: list');
    check(listed.stdout.includes('from first (Far Library): Remote letter'), '1429: remote sender names Library card');
    const captured = fs.readFileSync(w.file(String(local['page'])), 'utf8').match(/^captured: (.+)$/m)?.[1];
    check(listed.stdout.includes(`  ${captured}  from first: Local letter\n    ${local['page']}\n`), '1429: local sender line unchanged');
  } finally { await w.dispose(); }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}


export async function runLane(h: Harness): Promise<void> {
  ({ selected, prerequisite, check, equal, same, failures, runCli, runCliAsync, HERE, PROGRAM_ROOT, KERNEL_COMMAND, isCompiled } = h);
if (selected(1400)) await section1400();
if (selected(1401)) await section1401();
if (selected(1402)) await section1402();
if (selected(1403)) await section1403();
if (selected(1404)) await section1404();
if (selected(1405)) await section1405();
if (selected(1406)) await section1406();
if (selected(1407)) await section1407();
if (selected(1408)) await section1408();
if (selected(1409)) await section1409();
if (selected(1410)) await section1410();
if (selected(1411)) await section1411();
if (selected(1412)) await section1412();
if (selected(1413)) await section1413();
if (selected(1414)) await section1414();
if (selected(1415)) await section1415();
if (selected(1416)) await section1416();
if (selected(1417)) await section1417();
if (selected(1418)) await section1418();
if (selected(1419)) await section1419();
if (selected(1420)) await section1420();
if (selected(1421)) await section1421();
if (selected(1422)) await section1422();
if (selected(1423)) await section1423();
if (selected(1424)) await section1424();
if (selected(1425)) await section1425();
if (selected(1427)) await section1427();
if (selected(1429)) await section1429();
}
