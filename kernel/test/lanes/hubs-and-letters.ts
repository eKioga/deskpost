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
        if (named) check(String(letter['next']).includes(`first line "${ring}"`) === (assistant === 'claude'), `1400: ${assistant} ring in next only for a Claude writer`);
        if (assistant === 'codex') check(!String(letter['next']).includes('Ring: SendMessage'), `1400: ${named} Codex writer is asked for no ring`);
        if (assistant === 'codex') {
          const relay = `Tell second: a letter for you, letters ${letter['page']}`;
          equal(letter['relay_line'], relay, `1400: ${named} Codex relay line`);
          check(String(letter['next']).includes(`Put this line in your reply for Eric: "${relay}"`), `1400: ${named} relay instruction`);
        } else check(!('relay_line' in letter), `1400: Claude has no relay ${named}`);
      }
    }
    const help = fs.readFileSync(path.join(PROGRAM_ROOT, '.claude/skills/library-help/references/messages-between-seats.md'), 'utf8');
    check(help.includes("So a Codex writer's capture names no ring in `next`; when the recipient is a held Claude seat, it returns a `relay_line` for the writer to put in its reply for Eric."), '1400: library-help describes the Codex ring and relay receipt');
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


async function section1426(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const { pathChecks, selectSections } = await import('../../../tools/section-select.mts');
  const mapped = (file: string) => {
    if (pathChecks([file]).length) return true;
    try { selectSections({ changed: [file], selftestHunks: [], selftestText: '', covers: { schema: 1, about: '', sections: {} } }); return true; }
    catch (error) { if ((error as Error).message.startsWith('unmapped changed path ')) return false; throw error; }
  };
  const body = (files: string[]) => 'OWNS PATHS:\n' + files.map(file => '- `' + file + '`').join('\n') + '\nSTAY OUT OF: nothing';
  const warnings = (files: string[], exists = false) => kickoffVerdict(body(files), { adrFiles: [], newPathMapped: file => exists || mapped(file) }).warnings;
  check(warnings(['docs/x.yaml']).some(line => line.includes('docs/x.yaml') && line.includes('tools/check-map.json')), '1426: unmapped new path warns');
  for (const files of [['docs/x.yaml', 'tools/check-map.json'], ['kernel/src/x.ts'], ['tools/x.mts'], ['.githooks/x'], ['docs/x.md'], ['docs/areas.json']])
    check(!warnings(files).some(line => line.includes('unmapped new path')), `1426: mapped or exempt path passes: ${files}`);
  check(!warnings(['docs/x.yaml'], true).some(line => line.includes('unmapped new path')), '1426: existing path passes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-map-'));
  try {
    const { spawnSync } = await import('node:child_process');
    const { childEnv } = await import('../gate-env.ts');
    const file = path.join(root, 'kickoff.md');
    fs.writeFileSync(file, body(['docs/x.yaml']));
    const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), file],
      { encoding: 'utf8', timeout: 60000, env: { ...childEnv(), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
        TEMP: root, TMP: root, TMPDIR: root, DESKPOST_GATE_DIR: root } });
    check(ran.stdout.includes('unmapped new path docs/x.yaml'), '1426: source tool supplies its real map predicate');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

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


async function section1428(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r2-close-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
    const w = await letterWorkspace('w21-r2-close');
    try {
      const letter = w.capture(0, ['--for', 'second', '--title', 'Close values'], 'codex');
      const { pathToFileURL } = await import('node:url');
      const clock = path.join(w.root, 'clock.mjs');
      fs.writeFileSync(clock, "const original = Date.prototype.toISOString; let tick = 0; Date.prototype.toISOString = function () { return original.call(new Date(this.getTime() + 1000 * tick++)); };\n");
      const oldOptions = process.env['NODE_OPTIONS'];
      const closeWithClock = (args: string[], who: number) => {
        process.env['NODE_OPTIONS'] = (oldOptions ?? '') + ' --import=' + pathToFileURL(clock).href;
        try { return w.json(w.cli(who, args, 'codex')); }
        finally { if (oldOptions === undefined) delete process.env['NODE_OPTIONS']; else process.env['NODE_OPTIONS'] = oldOptions; }
      };
      const note = 'handled "exactly"';
      const closed = closeWithClock(['letters', 'close', String(letter['page']), '--note', note, '--json'], 1);
      const stamp = fs.readFileSync(w.file(String(letter['page'])), 'utf8').match(/^reviewed: (.+)$/m)?.[1];
      check(!!stamp && String(closed['scope']).includes('reviewed: ' + stamp), '1428: letter scope names the written stamp');
      check(String(closed['scope']).includes('closed_note: ' + JSON.stringify(note)), '1428: letter scope names exact note');
      check(String(closed['scope']).includes('no new page is written'), '1428: letter scope says no new page');
      equal(w.cli(0, ['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1428: open reports');
      const report = w.json(w.cli(0, ['capture', 'reports', '--local', '--title', 'Withdraw values', '--body', 'Fixture report', '--json'], 'codex'));
      const page = String(report['page'] ?? String(report['note_page']).replace(/^.*\/wiki\//, ''));
      const withdrawn = closeWithClock(['reports', 'withdraw', page, '--note', note, '--json'], 0);
      const text = fs.readFileSync(path.join(w.ws, 'shelf/reports/wiki', page + '.md'), 'utf8');
      const reviewed = text.match(/^reviewed: (.+)$/m)?.[1];
      check(!!reviewed && String(withdrawn['scope']).includes('reviewed: ' + reviewed), '1428: report scope names written stamp');
      check(String(withdrawn['scope']).includes('closed_note: ' + JSON.stringify(note)), '1428: report scope names exact note');
      check(String(withdrawn['scope']).includes('no new page is written'), '1428: report scope says no new page');
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


async function section1430(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  equal(builderPushLines('ROWS:\n`node -- tools/gate.ts --tier push`').length, 1, '1430: double dash runs gate script');
  equal(builderPushLines('ROWS:\n`node -- tools/other.mts --tier push`').length, 0, '1430: other script');
  equal(builderPushLines('NOT CHARTERED:\n`node -- tools/gate.ts --tier push`').length, 0, '1430: prohibition');
}

async function section1431(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  equal(builderPushLines('ROWS:\n`node tools/other.mts tools/gate.ts --tier push`').length, 0, '1431: later gate path is an argument');
  equal(builderPushLines('ROWS:\n`node --title="a b" tools/gate.ts --tier push`').length, 1, '1431: quoted option value stays one word');
  for (const command of ['node --title="a b" tools/other.mts tools/gate.ts --tier push', 'node -- tools/other.mts tools/gate.ts --tier push'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 0, '1431: options never turn an argument into the script');
}

async function section1432(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const verdict = kickoffVerdict('WHY NOW: [[projects/work/_project]]', { adrFiles: [] });
  same(verdict.warnings.filter(line => line.startsWith('names not checked:')), ['names not checked: no Library; run deskpost kickoff check <file> in a Library to check them'], '1432: bare tool gives names remedy');
}

async function section1433(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r2-posted-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
    const w = await letterWorkspace('w21-r2-posted');
    try {
      const { KNOWN_SECTIONS } = await import('../../src/kickoffcheck.ts');
      const page = (token: string) => KNOWN_SECTIONS.map(name => name === 'ROWS' ? 'ROWS:\n1. Change.\n   Done when: checked.' : name === 'CLOSE' ? 'CLOSE: **Stop.**' : name === 'OWNS PATHS' ? 'OWNS PATHS:\n- `kernel/a.ts`' : name + ': ' + (name === 'WHY NOW' ? token : 'filled')).join('\n');
      const file = path.join(w.root, 'posted.md');
      fs.writeFileSync(file, page('{now}'));
      const draft = w.cli(0, ['kickoff', 'check', file, '--json']);
      check(draft.exit === 1 && draft.stdout.includes('a posted page: run kickoff check --posted'), '1433: single braces refused with posted remedy');
      const posted = w.cli(0, ['kickoff', 'check', file, '--posted', '--json']);
      check(posted.exit === 0 && JSON.parse(posted.stdout).complete === true, '1433: posted mode accepts single braces: ' + posted.stdout + posted.stderr);
      fs.writeFileSync(file, page('{{now}}'));
      for (const flags of [[], ['--posted']]) {
        const ran = w.cli(0, ['kickoff', 'check', file, ...flags, '--json']);
        check(ran.exit === 0 && JSON.parse(ran.stdout).complete === true, '1433: draft accepted either way: ' + ran.stdout + ran.stderr);
      }
    } finally { await w.dispose(); }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function section1434(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r2-context-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
    const w = await letterWorkspace('w21-r2-context');
    try {
      equal(w.cli(0, ['desk', 'open', 'project', 'first']).exit, 0, '1434: open Hub');
      const ran = w.cli(0, ['hook', 'desk-context', '--seat', 'first', '--agent-pid', '0']);
      equal(ran.exit, 0, '1434: hook');
      const text = JSON.parse(ran.stdout).hookSpecificOutput.additionalContext;
      check(text.includes('read_open_book_page(slug, page)'), '1434: book reader arguments');
      check(text.includes("read_open_project_page(slug, page; root _project)"), '1434: project reader arguments and root');
    } finally { await w.dispose(); }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function section1435(): Promise<void> {
  const { countAsks, asksText, projectFolderName } = await import('../../src/asks.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r3-asks-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  try {
    const workspace = path.join(root, 'ws'), config = path.join(root, 'config');
    const folder = path.join(config, 'projects', projectFolderName(workspace));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'sample.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session-owner', accountUuid: 'fixture' }) + '\n');
    const options = { since: '2026-01-14', until: '2026-01-16', configDirectory: config };
    const safe = countAsks(workspace, options);
    same(safe['skipped_records'], { 'session-owner': 1 }, '1435: known safe type still skipped');
    check(!asksText(safe).includes('Unknown records'), '1435: no unknown line without unknown records');
    fs.appendFileSync(file, JSON.stringify({ type: 'future-metadata', tag: 'fixture' }) + '\n');
    const unknown = countAsks(workspace, options);
    same(unknown['unknown_records'], { 'future-metadata': 1 }, '1435: unknown record counted and named');
    same(unknown['skipped_records'], { 'session-owner': 1 }, '1435: unknown is not a safe skip');
    check(asksText(unknown).includes('Unknown records (not judged): future-metadata 1'), '1435: default text names unjudged record');
    equal(unknown['approvals'], 0, '1435: unknown record never invented as a judged approval');
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1436(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r2-insert-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = temp;
  try {
    const { newProjectBody } = await import('../../src/hubedit.ts');
    const nested = '# Items\n\n## Now\n\n- [ ] Parent\n  - [ ] Child\n\n## Next\n\nKeep.\n';
    equal(newProjectBody(nested, 'InsertItem', '', '- [ ] Another child', 'Child', false), nested.replace('  - [ ] Child\n', '  - [ ] Child\n  - [ ] Another child\n'), '1436: nested insertion inherits indent in Now');
    let refusedNow = false;
    try { newProjectBody(nested, 'InsertItem', 'Now', '- Missing status', 'Parent', false); }
    catch (error) { refusedNow = String(error).includes('status marker'); }
    check(refusedNow, '1436: insertion keeps the Now status rule');
    const w = await letterWorkspace('w21-r2-insert');
    try {
      equal(w.cli(0, ['desk', 'open', 'project', 'first']).exit, 0, '1436: open Hub');
      const file = path.join(w.ws, 'collection/projects/first/notes/items.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const content = path.join(w.root, 'addition.md');
      fs.writeFileSync(content, '- [ ] Inserted.\n');
      const args = ['hub', 'edit', 'first', '--page', 'notes/items', '--mode', 'insert-item', '--section', 'Queue', '--after', 'First item', '--content-path', content];
      for (const eol of ['\n', '\r\n']) {
        const before = '# Items\n\n## Queue\n\n- [ ] First item\n  continuation\n  - nested\n- [ ] Last item\n\n\n## Later\n\nKeep trailing blanks.\n\n'.replace(/\n/g, eol);
        fs.writeFileSync(file, before);
        const pre = w.cli(0, [...args, '--preflight', '--json']);
        equal(pre.exit, 0, '1436: preflight: ' + pre.stderr);
        check(fs.readFileSync(file, 'utf8') === before, '1436: preflight changes nothing');
        if (pre.exit !== 0) continue;
        const plan = JSON.parse(pre.stdout);
        equal(plan.confirmation_required, false, '1436: insertion ungated');
        const stale = w.cli(0, [...args, '--plan-id', 'stale']);
        check(stale.exit === 1 && stale.stderr.includes('plan-id'), '1436: stale plan refused');
        equal(fs.readFileSync(file, 'utf8'), before, '1436: stale plan preserves bytes');
        const applied = w.cli(0, [...args, '--plan-id', plan.plan_id, '--json']);
        equal(applied.exit, 0, '1436: apply: ' + applied.stderr);
        equal(fs.readFileSync(file, 'utf8'), before.replace('- [ ] Last item', '- [ ] Inserted.' + eol + '- [ ] Last item'), '1436: other bytes preserved including nested lines and endings');
      }
      for (const [match, body] of [['Absent item', '- [ ] First item\n'], ['First item', '- [ ] First item\n- [ ] First item again\n']]) {
        fs.writeFileSync(file, '# Items\n\n## Queue\n\n' + body);
        const call = args.map(value => value === 'First item' ? match! : value);
        const ran = w.cli(0, [...call, '--preflight']);
        check(ran.exit === 1 && ran.stderr.includes(match!), '1436: absent or duplicate match refused by name: ' + ran.stderr);
      }
    } finally { await w.dispose(); }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function section1437(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  for (const command of ['node --conditions development tools/gate.ts --tier push', 'node --watch-path src tools/gate.ts --tier push', 'node --redirect-warnings warnings.log tools/gate.ts --tier push'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 1, '1437: value option still runs gate: ' + command);
  for (const command of ['node --conditions development tools/other.mts tools/gate.ts --tier push', 'node -e "x" tools/gate.ts --tier push', 'node - tools/gate.ts --tier push', 'node --eval="x" tools/gate.ts --tier push', 'node -p "x" tools/gate.ts --tier push', 'node --print "x" tools/gate.ts --tier push'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 0, '1437: gate is not the script: ' + command);
  equal(builderPushLines('NOT CHARTERED:\n`node --conditions development tools/gate.ts --tier push`').length, 0, '1437: prohibition stays allowed');
}

async function section1438(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const warnings = (pattern: string) => kickoffVerdict('OWNS PATHS:\n- `' + pattern + '`', { adrFiles: [], newPathMapped: () => false }).warnings.filter(line => line.includes('unmapped new path'));
  same(warnings('none'), [], '1438: none is not a new path');
  same(warnings('<path or pattern>'), [], '1438: a placeholder is not a new path');
  check(warnings('docs/x.yaml').some(line => line.includes('docs/x.yaml')), '1438: real unmapped path still warns');
}

async function section1439(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const { judgeKickoff } = await import('../../src/hubnewpage.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r4-hint-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  try {
    const body = 'WHY NOW: {now}';
    const hint = ' (a posted page: run kickoff check --posted)';
    for (const [name, judge] of [
      ['kickoffVerdict', (postedHint: boolean | undefined) => kickoffVerdict(body, { adrFiles: [], postedHint })],
      ['judgeKickoff', (postedHint: boolean | undefined) => judgeKickoff(body, root, { programRoot: PROGRAM_ROOT, train: false, names: false, postedHint })],
    ] as const) {
      const plain = judge(undefined).problems;
      check(plain.some(line => line.includes('{now}')), '1439: ' + name + ' still refuses placeholders');
      check(!plain.some(line => line.includes(hint)), '1439: ' + name + ' defaults to no command hint');
      same(judge(false).problems, plain, '1439: ' + name + ' false keeps plain refusal');
      same(judge(true).problems, plain.map(line => line.includes('{now}') ? line + hint : line), '1439: ' + name + ' opt-in adds only placeholder hint');
    }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1440(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r4-triager-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    TEMP: root, TMP: root, TMPDIR: root, LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
    AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  try {
    equal(runCli(['init', ws], { cwd: root, env }).exit, 0, '1440: init');
    const cache = path.join(ws, 'internal', 'postbox', 'state.json');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const pin = { library_id: 'far', seat: 'triager', source: 'follow' };
    const entries = [{ library_id: 'other', library_card: 'Other Office' }, { library_id: 'far', library_card: 'Far Office' }];
    for (const [reports_triager, entries_seen, expected] of [
      [pin, entries, 'Far Office'], [pin, [entries[0]], null], [null, entries, null], [pin, undefined, null],
    ] as const) {
      const state = { schema: 1, reports_triager, entries_seen };
      const before = JSON.stringify(state);
      fs.writeFileSync(cache, before);
      const ran = runCli(['postbox', 'status', '--workspace', ws], { cwd: root, env });
      equal(ran.exit, 0, '1440: status reads cache: ' + ran.stderr);
      if (ran.exit !== 0) continue;
      const result = JSON.parse(ran.stdout);
      equal(result.reports_triager_card, expected, '1440: matching card or null');
      same(result.reports_triager, reports_triager ? { ...reports_triager, library_card: expected } : null,
        '1440: status preserves pin fields and adds the matching card or null');
      equal(fs.readFileSync(cache, 'utf8'), before, '1440: status does not write cache');
    }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1441(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  for (const command of ['node -expose-gc tools/gate.ts --tier push', 'node -expose_gc tools/gate.ts --tier push', 'node -stack-size=900 tools/gate.ts --tier push', 'node -prof tools/gate.ts --tier push', 'node --conditions development.js tools/gate.ts --tier push', 'node --disable-warning dev.js tools/gate.ts --tier push', 'node --conditions=development.js tools/gate.ts --tier push', 'node --test-reporter spec.js tools/gate.ts --tier push', 'node --some-future-option x.js tools/gate.ts --tier push', 'node -- tools/gate.ts --tier push'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 1, '1441: runs gate: ' + command);
  for (const command of ['node -p 1 tools/gate.ts --tier push', 'node -e 1 tools/gate.ts --tier push', 'node --conditions tools/gate.ts tools/other.mts --tier push', 'node -pe 1 tools/gate.ts --tier push', 'node --run build tools/gate.ts --tier push', 'node tools/other.mts tools/gate.ts --tier push'])
    equal(builderPushLines('ROWS:\n`' + command + '`').length, 0, '1441: gate is not script: ' + command);
  equal(builderPushLines('NOT CHARTERED:\n`node --conditions development.js tools/gate.ts --tier push`').length, 0, '1441: prohibition allowed');
}

async function section1442(): Promise<void> {
  const { NODE_VALUE_OPTIONS } = await import('../../src/kickoffcheck.ts');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r5-node-help-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  try {
    const help = execFileSync(process.execPath, ['--help'], { encoding: 'utf8', timeout: 10000 });
    const options = help.split(/\r?\n/).filter(line => /^  -/.test(line))
      .map(line => line.trim().split(/\s{2,}/)[0]!)
      .filter(column => /(?<!\[)=/.test(column))
      .flatMap(column => column.split(', ').map(alias => alias.split('=')[0]!));
    check(options.includes('--conditions') && options.includes('-C') && options.includes('--inspect-port'), '1442: help parser finds value options and aliases');
    const missing = options.filter(option => !NODE_VALUE_OPTIONS.has(option));
    check(missing.length === 0, '1442: NODE_VALUE_OPTIONS missing: ' + missing.join(', '));
    check(!NODE_VALUE_OPTIONS.has('--stack-size'), '1442: V8 stack size requires equals');
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1443(): Promise<void> {
  const { builderPushLines } = await import('../../src/kickoffcheck.ts');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w21-r6-node-eval-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools/gate.ts'), 'console.log("GATE-RAN");\n');
    fs.writeFileSync(path.join(root, 'tools/other.mts'), '');
    fs.writeFileSync(path.join(root, 'development.js'), '');
    const forms = [[], ['-expose-gc'], ['-expose_gc'], ['-prof'], ['-trace-gc'], ['-harmony'],
      ['-stack-size=900'], ['-max-old-space-size=100'], ['-abort-on-uncaught-exception'],
      ['-e'], ['-p'], ['-pe', '1'], ['-e', '1'], ['-p', '1'], ['--eval=1'], ['--print'],
      ['--eval', '1'], ['-'], ['-C', 'development.js'], ['--conditions', 'development.js'],
      ['-r', './development.js'], ['--expose-gc'], ['--'], ['--run', 'build'], ['--title=x'],
      ['-expose-gc', '-pe', '1']];
    for (const form of forms) {
      const args = [...form, 'tools/gate.ts', '--tier', 'push'];
      let ran = false;
      try {
        ran = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).split(/\r?\n/).includes('GATE-RAN');
      } catch (error) {
        // A refused option or eval error did not run the gate; infrastructure failures stay loud.
        if (typeof (error as { status?: unknown }).status !== 'number') throw error;
      }
      const ordered = builderPushLines('ROWS:\n`node ' + args.join(' ') + '`').length === 1;
      equal(ordered, ran, '1443: ' + (form.join(' ') || '(none)') + ': Node ran=' + ran + ', rule ordered=' + ordered);
    }
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1444(): Promise<void> {
  const { kickoffNames, checkKickoff } = await import('../../src/kickoffcheck.ts');
  same(kickoffNames('`projects/a` page `notes/x` and `projects/b` page `notes/y`').map(hit => hit.name),
    ['projects/a/notes/x', 'projects/b/notes/y'], '1444: next Hub starts its own page list');
  for (const suffix of ['row 2 says', 'WHERE THINGS STAND']) {
    const text = 'as `projects/work` page `kickoffs/c1` ' + suffix;
    check(checkKickoff(text).pointers.length > 0, '1444: Hub pointer ' + suffix);
  }
  equal(checkKickoff('see `projects/work` page `kickoffs/c1` for the history').pointers.length, 0, '1444: history is not a pointer');
}

async function section1445(): Promise<void> {
  const { commaRowLines, trainProblems } = await import('../../src/kickoffcheck.ts');
  const row = '-' + 'Row ';
  equal(commaRowLines(row + '<row-2-id>').length, 0, '1445: hyphenated row id is one row');
  equal(commaRowLines(row + '<2 row ids>').length, 1, '1445: several row ids remain refused');
  const register = { schema: 1, items: ['a', 'b', 'c'].map(id => ({ id, status: 'open' })) };
  for (const list of ['b, and absent', 'b, absent.'])
    check(trainProblems('TRAIN: a (lane:fixes; this unit also carries ' + list + ')', register).some(line => line.includes("id 'absent' is not an open")), '1445: checks ' + list);
  same(trainProblems('TRAIN: a, b, c (lane:fixes)', register),
    ["TRAIN lists 'b', 'c' after a comma; write it as a (lane:fixes; this unit also carries b, c)"], '1445: one complete repair');
}

async function section1446(): Promise<void> {
  const { newSectionDeclarations, pinnedSectionWarnings, revisionEvidenceWarnings } = await import('../../src/kickoffcheck.ts');
  for (const list of ['19,615', '19, 615']) {
    same(newSectionDeclarations('OWNS:\nNew sections ' + list).numbers, [19, 615], '1446: declares ' + list);
    const text = 'OWNS:\nExisting sections ' + list + '\nOWNS PATHS:\n- `kernel/src/kickoffcheck.ts`\nSTAY OUT OF:\nevery self-test section but 1444 to 1449';
    same(pinnedSectionWarnings(text, { '19': ['kernel/src/kickoffcheck.ts'], '615': ['kernel/src/kickoffcheck.ts'] }), [], '1446: pins ' + list);
  }
  const head = '# c108-r2 kickoff: test\nRevision: **r2**\nOPEN:\n';
  equal(revisionEvidenceWarnings(head + 'D:/dev/scratch/deskpost/c108: the old folder').length, 1, '1446: colon ends old folder');
  equal(revisionEvidenceWarnings(head + 'D:/dev/scratch/deskpost/c108-r2: its own').length, 0, '1446: own folder is safe');
}

async function section1447(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const { templateBlock } = await import('../../src/kickoffcheck.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w23-repo-'));
  const saved = ['TEMP', 'TMP', 'TMPDIR'].map(key => process.env[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  try {
    const base = spawnSync('git', ['-C', PROGRAM_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: repositoryNeutralEnv() }).stdout.trim();
    const gate = path.join(root, 'gate'), empty = path.join(root, 'empty');
    fs.mkdirSync(gate); fs.mkdirSync(empty);
    fs.writeFileSync(path.join(gate, 'slots'), JSON.stringify({ slots: 2, u2Tip: base }));
    const file = path.join(root, 'kickoff.md');
    const block = templateBlock(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs/kickoff-template.md'), 'utf8'));
    fs.writeFileSync(file, block.replace('as committed at `<SHA>`', 'as committed at `' + base + '`'));
    const run = (args: string[], override = empty) => {
      const r = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), ...args],
        { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...repositoryNeutralEnv(), DESKPOST_GATE_DIR: gate,
          DESKPOST_KICKOFF_TEST_REPOSITORY: override, TEMP: root, TMP: root, TMPDIR: root } });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const bad = run([file]);
    check(bad.code === 1 && bad.out.includes('BASE: cannot compare'), '1447: empty folder refuses BASE');
    for (const args of [['--repo', PROGRAM_ROOT, file], [file, '--repo', PROGRAM_ROOT]]) {
      const good = run(args);
      check(good.code === 0 && !good.out.includes('BASE:'), '1447: explicit checkout overrides fixture: ' + good.out);
    }
    const missing = run([file, '--repo']);
    check(missing.code === 2 && missing.out.includes("cannot read argument '--repo'"), '1447: missing repo value');
    const unset = run([file], '');
    check(unset.code === 0 && !unset.out.includes('BASE:'), '1447: empty override uses tool checkout: ' + unset.out);
  } finally {
    ['TEMP', 'TMP', 'TMPDIR'].forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1448(): Promise<void> {
  const { checkLetterGo } = await import('../../src/lettergo.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-w23-go-'));
  const keys = ['TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
  const saved = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = root;
  try {
    const state = path.join(root, 'state'), seat = path.join(state, 'seats', 'sender');
    const session = '14000000-0000-4000-8000-000000001448';
    fs.mkdirSync(seat, { recursive: true });
    fs.writeFileSync(path.join(seat, 'activity.json'), JSON.stringify({ session_id: session, assistant: 'claude', conversation_recorded_utc: '2026-11-17T12:00:00Z' }));
    const folder = path.join(root, 'projects', 'fixture'); fs.mkdirSync(folder, { recursive: true });
    const now = new Date('2026-11-17T12:00:00Z');
    for (const [text, allowed] of [['\u{1D400}yes', false], ['yes\u{1D400}', false], ['ok, yes.', true], ['\u{1D400} yes', true]] as const) {
      fs.writeFileSync(path.join(folder, session + '.jsonl'), JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: now.toISOString(), message: { content: text } }) + '\n');
      let accepted = false;
      try { accepted = checkLetterGo(state, 'sender', 'launcher', 'yes', now).check === 'transcript'; }
      catch (error) { check((error as Error).message.includes('found no matching typed message'), '1448: expected only boundary refusal: ' + (error as Error).message); }
      equal(accepted, allowed, '1448: whole code point boundary ' + text);
    }
  } finally {
    keys.forEach((key, n) => { if (saved[n] === undefined) delete process.env[key]; else process.env[key] = saved[n]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function section1449(): Promise<void> {
  const { placeholderProblems } = await import('../../src/kickoffcheck.ts');
  const head = '# w1 kickoff: test\n\nw1, AT seat. author_seat: lead, written {now}.\n';
  same(placeholderProblems(head), [], '1449: header posting time is filled by writer');
  equal(placeholderProblems(head + 'WHY NOW:\n{now}').length, 1, '1449: body placeholder stays refused');
  equal(placeholderProblems(head.replace('{now}', '{today}')).length, 1, '1449: today on header stays refused');
  equal(placeholderProblems(head.replace('{now}', '{session}')).length, 1, '1449: session on header stays refused');
  equal(placeholderProblems(head.replace('{now}', '{now} {now}')).length, 1, '1449: only one posting time allowed');
}

async function section1450(): Promise<void> {
  const w = await letterWorkspace('w28-kept-lines');
  try {
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', ...args, '--json']);
    w.json(edit(['--mode', 'append-section', '--section', 'Now', '--content', '- [ ] Keep this line']));
    const replace = ['--mode', 'replace-item', '--section', 'Now', '--match-text', 'Keep this line'];
    const additive = [...replace, '--content', 'Keep this line\n  Keep this detail'];
    const drops = [...replace, '--content', 'Different line'];
    const additivePlan = w.json(edit([...additive, '--preflight']));
    equal(additivePlan.confirmation_required, false, '1450: keeping the old text needs no yes');
    const dropsPlan = w.json(edit([...drops, '--preflight']));
    equal(dropsPlan.confirmation_required, true, '1450: dropping text needs a yes');
    check(edit([...drops, '--plan-id', String(dropsPlan.plan_id)]).exit !== 0, '1450: refuses unconfirmed removal');
    equal(w.json(edit([...additive, '--plan-id', String(additivePlan.plan_id)])).written, true,
      '1450: keeping the old text applies with the plan alone');
  } finally { await w.dispose(); }
}

async function section1451(): Promise<void> {
  const w = await letterWorkspace('w28-supersede');
  try {
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', ...args, '--json']);
    const old = '- [ ] Run w1: [[projects/first/kickoffs/w1]]';
    const next = '- [ ] Run w2: [[projects/first/kickoffs/w2]]';
    w.json(edit(['--content', old]));
    check(edit(['--supersedes', 'Run missing:', '--content', next, '--preflight']).exit !== 0, '1451: missing Run refuses');
    check(edit(['--supersedes', 'Run w1:', '--content', '- [ ] Ordinary item', '--preflight']).exit !== 0, '1451: ordinary item refuses');
    const args = ['--supersedes', 'Run w1:', '--content', next];
    const plan = w.json(edit([...args, '--preflight']));
    check(String(plan.section_after).includes(old.replace('[ ]', '[x]')) && String(plan.section_after).includes(next),
      '1451: one plan previews both changes');
    equal(w.json(edit([...args, '--plan-id', String(plan.plan_id)])).written, true, '1451: apply');
    check(edit([...args, '--preflight']).exit !== 0, '1451: ticked Run refuses');
  } finally { await w.dispose(); }
}

async function section1452(): Promise<void> {
  const w = await letterWorkspace('w28-many-items');
  try {
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', '--section', 'Now', ...args, '--json']);
    w.json(edit(['--mode', 'append-section', '--content', '- [ ] First item\n- [ ] Second item']));
    const tick = ['--mode', 'check-item', '--match-text', 'First item'];
    check(edit([...tick, '--match-text', 'Missing item']).exit !== 0, '1452: missing match refuses');
    const both = [...tick, '--match-text', 'Second item'];
    const plan = w.json(edit([...both, '--preflight']));
    same(plan.items?.map((item: { before: string }) => item.before), ['- [ ] First item', '- [ ] Second item'],
      '1452: preview lists both matches, still unticked');
    equal(w.json(edit([...both, '--plan-id', String(plan.plan_id)])).written, true, '1452: one apply');
    const confirmed = w.json(edit([...both, '--preflight']));
    equal(confirmed.unchanged, true, '1452: both items were ticked');
    const replace = ['--mode', 'replace-item', '--match-text', 'First item', '--match-text', 'Second item', '--content', 'New wording'];
    const replacement = w.json(edit([...replace, '--preflight']));
    equal(replacement.items?.length, 2, '1452: two replacements previewed');
    equal(w.json(edit([...replace, '--user-confirmed', '--plan-id', String(replacement.plan_id)])).written, true,
      '1452: both replacements write together');
  } finally { await w.dispose(); }
}

async function section1453(): Promise<void> {
  const w = await letterWorkspace('w28-remove-page');
  try {
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', ...args, '--json']);
    const page = 'notes/old';
    const file = path.join(w.ws, 'collection', 'projects', 'first', 'notes', 'old.md');
    w.json(edit(['--mode', 'new-page', '--page', page, '--title', 'Old', '--content', 'Old text.']));
    w.json(edit(['--mode', 'append-section', '--section', 'Next', '--content', 'See [[projects/first/notes/old]].']));
    const removal = ['--mode', 'remove-page', '--page', page];
    const plan = w.json(edit([...removal, '--preflight']));
    equal(plan.confirmation_required, true, '1453: removal requires approval');
    same(plan.linked_from, ['projects/first/_project'], '1453: preview names the linking page');
    check(edit([...removal, '--plan-id', String(plan.plan_id)]).exit !== 0 && fs.existsSync(file),
      '1453: unconfirmed removal writes nothing');
    const oldBytes = fs.readFileSync(file, 'utf8');
    const result = w.json(edit([...removal, '--user-confirmed', '--plan-id', String(plan.plan_id)]));
    check(result.written && !fs.existsSync(file), '1453: approved removal');
    const assert: typeof import('node:assert').strict = (await import('node:assert')).strict;
    assert.ok(typeof result.journal === 'string' && result.journal.length > 0, '1453: removal returns a journal id');
    const undone = w.cli(0, ['undo', path.basename(result.journal, '.json'), '--json']);
    equal(undone.exit, 0, '1453: undo succeeds: ' + undone.stderr + undone.stdout);
    equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, oldBytes, '1453: undo restores the old bytes');
    for (const protectedPage of ['_project', 'kickoffs/w1']) {
      check(edit(['--mode', 'remove-page', '--page', protectedPage, '--preflight']).exit !== 0,
        '1453: protected page refuses: ' + protectedPage);
    }
  } finally { await w.dispose(); }
}

async function section1454(): Promise<void> {
  const w = await letterWorkspace('w28-write-once');
  try {
    const kickoff = path.join(w.ws, 'collection', 'projects', 'first', 'kickoffs', 'w1.md');
    const original = '# Original kickoff\n\n## Now\n\n- [x] Completed line\n';
    fs.mkdirSync(path.dirname(kickoff), { recursive: true });
    fs.writeFileSync(kickoff, original);
    const tidy = w.cli(0, ['hub', 'tidy', 'first', '--page', 'kickoffs/w1', '--preflight', '--json']);
    check(tidy.exit !== 0 && (tidy.stderr + tidy.stdout).includes('pages are written once'), '1454: tidy refuses');
    const source = path.join(w.ws, 'notebook', 'w1.md');
    fs.writeFileSync(source, '# Replacement\n');
    const copy = w.cli(0, ['hub', 'copy-pages', 'first', '--source', source, '--title', 'First',
      '--purpose', 'Fixture', '--destination-directory', 'kickoffs', '--preflight', '--json']);
    check(copy.exit !== 0 && (copy.stderr + copy.stdout).includes('pages are written once'), '1454: copy refuses');
    equal(fs.readFileSync(kickoff, 'utf8'), original, '1454: original bytes kept');
  } finally { await w.dispose(); }
}

async function section1455(): Promise<void> {
  const w = await letterWorkspace('w28-tidy-list-sections');
  try {
    const tidy = (args: string[]) => w.cli(0, ['hub', 'tidy', 'first', ...args, '--json']);
    const empty = w.json(tidy(['--preflight']));
    check(empty.nothing_selected && empty.page_size_bytes > 0 && empty.page_limit_bytes === 40000,
      '1455: empty plan carries page size and limit');
    w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'add-section', '--section', 'Review',
      '--content', '- [x] Completed elsewhere\n  A nested line.\n- [ ] Still open', '--json']));
    const plan = w.json(tidy(['--preflight']));
    same(plan.moved?.map((item: { section: string }) => item.section), ['Review'], '1455: selects ticked item from Review');
    const assert: typeof import('node:assert').strict = (await import('node:assert')).strict;
    assert.ok(typeof plan.plan_id === 'string' && plan.plan_id.length > 0, '1455: tidy preview returns a plan id');
    const applied = w.json(tidy(['--user-confirmed', '--plan-id', String(plan.plan_id)]));
    check(applied.written || applied.status === 'written', '1455: apply succeeded');
    const body = fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'first', '_project.md'), 'utf8');
    check(body.includes('- [ ] Still open') && !body.includes('Completed elsewhere'), '1455: keeps open item');
    const history = fs.readFileSync(path.join(w.ws, plan.notes_page_file), 'utf8');
    check(history.includes('- [x] Completed elsewhere\n  A nested line.'), '1455: moved full item verbatim');
  } finally { await w.dispose(); }
}

async function section1456(): Promise<void> {
  const w = await letterWorkspace('w28-order-places');
  try {
    const train = (args: string[]) => w.cli(0, ['train', ...args, '--json']);
    for (const [id, place] of [['a', 'running'], ['b', 'bucket:1'], ['c', 'running'], ['d', 'bucket:2'], ['e', 'bucket:2']]) {
      w.json(train(['add', id!, '--title', 'Task ' + id, '--place', place!]));
    }
    const assertOrder = (expected: string[], label: string) => {
      const rows = w.json(train(['page', '--by', 'lane'])) as unknown as { place: string }[];
      same(rows.map(row => row.place), expected, label);
    };
    w.json(train(['move', 'e', '--place', 'bucket:2', '--before', 'c']));
    assertOrder(['bucket:2', 'running', 'bucket:1'], '1456: places order from the first item of the anchor place');
    w.json(train(['move', 'e', '--place', 'bucket:2', '--after', 'b']));
    assertOrder(['running', 'bucket:1', 'bucket:2'], '1456: after reorders all the items of that place');
  } finally { await w.dispose(); }
}

async function section1457(): Promise<void> {
  const w = await letterWorkspace('w28-car-finish');
  try {
    const train = (args: string[]) => w.cli(0, ['train', ...args]);
    const car = 'car:fixture';
    w.json(train(['car', car, '--opened', '--json']));
    const result = w.json(train(['car', car, '--finish-line', 'Every fixture is green', '--plan', 'plans/fixture.md', '--json']));
    equal(result.cars?.[0]?.finish_line, 'Every fixture is green', '1457: finish line persisted');
    equal(result.cars?.[0]?.plan, 'plans/fixture.md', '1457: owning plan persisted');
    w.json(train(['add', 'first', '--title', 'First fixture', '--place', car, '--json']));
    w.json(train(['add', 'second', '--title', 'Second fixture', '--place', car, '--json']));
    const first = train(['close', 'first', '--done', '--note', 'Passed.']);
    check(first.exit === 0 && !first.stdout.includes('Every fixture is green'), '1457: another item remains');
    const last = train(['close', 'second', '--done', '--note', 'Passed.']);
    check(last.exit === 0 && last.stdout.includes('Every fixture is green') && last.stdout.includes('evidence'),
      '1457: closing the last item asks for finish-line evidence');
  } finally { await w.dispose(); }
}

async function section1458(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const train = await import('../../src/train.ts') as { commandLiteral?: (value: string, platform: NodeJS.Platform) => string };
  const literal = train.commandLiteral;
  check(typeof literal === 'function', '1458: train exports commandLiteral');
  const quotes = "'\u2018\u2019\u201a\u201b";
  equal(literal?.(quotes, 'win32'), "'" + Array.from(quotes, quote => quote + quote).join('') + "'",
    '1458: PowerShell doubles every single quote character');
  equal(literal?.(quotes, 'linux'), "''\\''" + quotes.slice(1) + "'",
    '1458: POSIX escapes only the ASCII apostrophe');

  const w = await letterWorkspace('w28-closed-train-reference');
  try {
    const append = (who: number, hub: string, content: string) => w.json(w.cli(who, ['hub', 'edit', hub,
      '--mode', 'append-section', '--section', 'Now', '--content', content, '--json']));
    append(0, 'first', '- [ ] Check `fixture-task` for Hub work\n- [x] Done `fixture-task`');
    const item = '- [ ] Review `fixture-task` quotes ' + quotes;
    append(0, 'first', item);
    append(1, 'second', '- [ ] Closed Hub mentions `fixture-task`');
    const page = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const before = fs.readFileSync(page, 'utf8');
    w.json(w.cli(0, ['train', 'add', 'fixture-task', '--title', 'Fixture task', '--place', 'running', '--json']));
    const closed = w.cli(0, ['train', 'close', 'fixture-task', '--done', '--note', 'Passed.']);
    check(closed.exit === 0 && closed.stdout.includes('Check `fixture-task` for Hub work')
      && closed.stdout.includes('deskpost hub edit first --mode check-item'), '1458: close prints the matching open item and command');
    check(!closed.stdout.includes('Done `fixture-task`') && !closed.stdout.includes('Closed Hub mentions'), '1458: ignores the ticked and closed-Hub items');
    equal(fs.readFileSync(page, 'utf8'), before, '1458: close leaves the Hub untouched');

    const command = closed.stdout.split(/\r?\n/).map(line => line.trim())
      .find(line => line.startsWith('deskpost hub edit first --mode check-item') && line.includes('Review'));
    check(command !== undefined, '1458: prints advice for the item containing quotes');
    if (!command) return;
    const args = ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Now', '--match-text', item];
    if (process.platform === 'win32') {
      // The real PowerShell parser's answer for this command, captured once at d6c23e53 (kickoffs/s225, standing answer 4):
      // no errors, one statement, and these words. The printed command must stay exactly that form.
      const parsed = { line: "deskpost hub edit first --mode check-item --section 'Now' --match-text '- [ ] Review `fixture-task` quotes ''\u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201b'", words: ["deskpost", "hub", "edit", "first", "--mode", "check-item", "--section", "Now", "--match-text", "- [ ] Review `fixture-task` quotes '\u2018\u2019\u201a\u201b"] };
      equal(command, parsed.line, '1458: the printed command is the form PowerShell was seen to parse');
      equal(JSON.stringify(parsed.words), JSON.stringify(['deskpost', ...args]), '1458: the recorded parse gives the original arguments back');
    } else {
      const result = spawnSync('sh', ['-c', 'set -- ' + command.slice('deskpost '.length) + '\nprintf "%s\\n" "$@"'],
        { encoding: 'utf8', timeout: 8_000 });
      equal(result.status, 0, '1458: sh parses the printed arguments: ' + (result.error ?? result.stderr));
      equal(result.stdout, args.join('\n') + '\n', '1458: sh preserves the original arguments');
    }
  } finally { await w.dispose(); }
}

async function section1459(): Promise<void> {
  const { placeholderProblems } = await import('../../src/kickoffcheck.ts');
  const w = await letterWorkspace('w28-posted-at');
  try {
    const header = 'w1, AT first. author_seat: first, written {posted}.';
    const text = '# w1 kickoff: Fixture\n\n' + header + '\n';
    same(placeholderProblems(text), [], '1459: posting time in the header is allowed');
    equal(placeholderProblems(text + '\nWHY NOW:\n{posted}').length, 1, '1459: the body refuses an unescaped posting time');
    equal(placeholderProblems(text.replace('written ', '')).length, 1, '1459: the header requires written before the placeholder');
    const args = ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'notes/stamp', '--content', text, '--json'];
    const plan = w.json(w.cli(0, [...args, '--preflight']));
    const applied = w.json(w.cli(0, [...args, '--plan-id', String(plan.plan_id)]));
    check(applied.written, '1459: apply uses the original plan');
    const saved = fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'first', 'notes', 'stamp.md'), 'utf8');
    check(/written \d{4}-\d{2}-\d{2}/.test(saved) && !saved.includes('{posted}'), '1459: header records write time');
  } finally { await w.dispose(); }
}

async function section1462(): Promise<void> {
  const { kickoffVerdict } = await import('../../src/kickoffcheck.ts');
  const text = 'OWNS:\n- New sections: 1462, 1480.\nROWS:\n0. Base proof.\n   Run LIBRARY_SELFTEST_SECTIONS=1459,1462 node test/run-parallel.ts.\n   Done when: green.\n1. Implement.\n   Run LIBRARY_SELFTEST_SECTIONS=1480 node test/run-parallel.ts.\n   Done when: green.\nRULES:\n- New section 1481.\nOPEN:\n1. Run LIBRARY_SELFTEST_SECTIONS=1481 node test/run-parallel.ts.\nCLOSE:\n**Stop.**\n';
  const warnings = kickoffVerdict(text, { adrFiles: [] }).warnings.filter(line => line.includes('base run'));
  check(warnings.some(line => line.includes('1462')), '1462: detects intersection with row 0');
  check(warnings.some(line => line.includes('1481')), '1462: detects RULES section in OPEN');
  check(!warnings.some(line => line.includes('1480') || line.includes('1459')), '1462: ignores other rows and existing sections');
}

async function section1463(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  same(kc.kickoffNames('See `projects/work` page `notes/a`, `notes/b`.').map(row => row.name),
    ['projects/work/notes/a', 'projects/work/notes/b'], '1463: singular page phrase can list pages');
  check(kc.checkKickoff("WHY NOW: as `projects/work` page `kickoffs/w1`'s rule.").pointers.length === 1,
    '1463: recognizes the Hub page pointer');
  const rows = 'ROWS:\n1. The row.\n   Done when: works.\n```text\n42. Numbered example.\n```\n2. The other row.\n   Done when: works.\nCLOSE:\n**Stop.**';
  same(kc.checkKickoff(rows).rowsWithoutDone, [], '1463: ignores numbers in fenced prose');
  const record = { schema: 1, items: [{ id: 'first', status: 'open' }, { id: 'second', status: 'open' }] };
  const found = kc.trainProblems('TRAIN: first (lane:fixes; this unit also carries `second`, and `third`. `fourth`)', record);
  check(found.some(line => line.includes("'third'")) && found.some(line => line.includes("'fourth'")),
    '1463: checks carried IDs after Oxford comma and full stop');
  const repair = kc.trainProblems('TRAIN: first,second,`third` (lane:fixes)', record);
  check(repair.filter(line => line.includes('write it as')).length === 1 && repair[0]?.includes('second, third') === true, '1463: one complete repair');
  same(kc.newSectionNumbers('OWNS: New sections 1463,1464.'), [1463, 1464], '1463: no space after comma is accepted');
  check(kc.revisionEvidenceWarnings('# w1-r2 kickoff: Test\nRevision: **r2**\nOPEN:\nD:/dev/scratch/deskpost/w1: preserve this.').length === 1,
    '1463: colon ends a revision evidence folder');
}

async function section1464(): Promise<void> {
  const { countAsks, projectFolderName } = await import('../../src/asks.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w28-asks-'));
  try {
    const workspace = path.join(root, 'workspace');
    const folder = path.join(root, 'projects', projectFolderName(workspace));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'fixture.jsonl');
    for (const key of ['toolApproval', 'decisionAtGate', 'approval']) {
      fs.writeFileSync(file, JSON.stringify({ type: 'new-metadata' }) + '\n' +
        JSON.stringify({ type: 'new-metadata', [key]: 'grant' }) + '\n');
      let message = '';
      try { countAsks(workspace, { configDirectory: root }); }
      catch (error) { message = (error as Error).message; }
      check(message.includes(file) && message.includes('line 2') && message.includes(key), '1464: refuses unknown ' + key);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function section1467(): Promise<void> {
  const w = await letterWorkspace('w28-fill-title');
  try {
    const titled = w.capture(0, ['--for', 'second', '--title', 'Reminder {today} at {now}']);
    check(!/(today|now)/.test(String(titled.page)) && /\d{4}-\d{2}-\d{2}/.test(String(titled.page)),
      '1467: file name is derived from the filled title');
    check(!/\{(?:today|now)\}/.test(String(titled.note_title)), '1467: explicit title is filled');
    const heading = w.json(w.cli(0, ['capture', 'letters', '--for', 'second', '--body', '# {today} A heading\n\nBody.', '--json']));
    check(/^\d{4}-\d{2}-\d{2} A heading$/.test(String(heading.note_title)), '1467: title from H1 is filled too');
    check(/^notes\/\d{4}-\d{2}-\d{2}-a-heading(?:-\d+)?$/.test(String(heading.page)), '1467: date is not repeated in file name');
  } finally { await w.dispose(); }
}

async function section1468(): Promise<void> {
  const w = await letterWorkspace('w28-placeholders-in-code');
  try {
    const body = 'Written {now}. Inline `{now}` and ``example `{today}` ``.\n\n~~~text\n{now} {session}\n~~~\n\nAfter {today}.';
    const captured = w.json(w.cli(0, ['capture', 'letters', '--for', 'second', '--title', 'Code example', '--body', body, '--json']));
    const saved = fs.readFileSync(w.file(String(captured.page)), 'utf8');
    const hub = w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'notes/code',
      '--title', 'Code example', '--content', body, '--json']));
    const hubBody = fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'first', 'notes', 'code.md'), 'utf8');
    for (const text of [saved, hubBody]) {
      check(/Written \d{4}-\d{2}-\d{2}/.test(text) && /After \d{4}-\d{2}-\d{2}/.test(text), '1468: expands prose');
      check(text.includes('Inline `{now}` and ``example `{today}` ``.'), '1468: keeps inline code verbatim');
      check(text.includes('~~~text\n{now} {session}\n~~~'), '1468: keeps fenced code verbatim');
    }
    check(hub.written, '1468: Hub page written');
  } finally { await w.dispose(); }
}

async function section1469(): Promise<void> {
  const w = await letterWorkspace('w28-late-delivery-cache');
  try {
    const state = path.join(w.ws, 'internal', 'postbox', 'state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    const rows = Array.from({ length: 22 }, (_, index) => ({ delivery_id: 'fixture-' + index }));
    fs.writeFileSync(state, JSON.stringify({ schema: 1, library_id: '12121212-1212-4212-8212-121212121212',
      check_history: [{ late_deliveries: rows.slice(0, 12) }, { late_deliveries: rows.slice(12) }] }));
    const status = w.json(w.cli(0, ['postbox', 'status', '--json']));
    same(status.late_deliveries, rows.slice(0, 20), '1469: legacy check history yields a bounded status list');
  } finally { await w.dispose(); }
}

async function section1470(): Promise<void> {
  const w = await letterWorkspace('w28-triager-card');
  try {
    const state = path.join(w.ws, 'internal', 'postbox', 'state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    const id = '12121212-1212-4212-8212-121212121212';
    fs.writeFileSync(state, JSON.stringify({ schema: 1, library_id: id,
      reports_triager: { library_id: id, seat: 'second' }, entries_seen: [{ library_id: id, library_card: 'fixture' }] }));
    const status = w.json(w.cli(0, ['postbox', 'status', '--json']));
    equal(status.reports_triager?.library_id, id, '1470: retains the id');
    equal(status.reports_triager?.library_card, 'fixture', '1470: card appears beside the id');
  } finally { await w.dispose(); }
}

async function section1471(): Promise<void> {
  const w = await letterWorkspace('w28-empty-report-preflight');
  try {
    equal(w.cli(0, ['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1471: reports open');
    const state = path.join(w.ws, 'internal', 'postbox', 'state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ schema: 1, library_id: '12121212-1212-4212-8212-121212121212',
      reports_triager: { library_id: '13131313-1313-4313-8313-131313131313', seat: 'triager', seat_id: '2'.repeat(32) } }));
    const plan = w.json(w.cli(0, ['reports', 'send-pending', '--preflight', '--json']));
    equal(plan.count, 0, '1471: no pending outbound reports');
    check(plan.plan_id == null && plan.confirmation_required === false && /nothing|no .*pending/i.test(String(plan.note)),
      '1471: explains why there is no plan');
  } finally { await w.dispose(); }
}

async function section1472(): Promise<void> {
  const w = await letterWorkspace('w28-triage-confirmation');
  try {
    equal(w.cli(0, ['desk', 'open', 'book', 'holding', '--location', 'shelf']).exit, 0, '1472: Holding Shelf open');
    const note = w.json(w.cli(0, ['capture', 'holding', '--title', 'Triage candidate', '--body', 'An example.', '--json']));
    for (const [kind, expected] of [['discard', true], ['review', false]] as const) {
      const actions = JSON.stringify([{ kind, source: 'holding', source_slug: 'holding', source_page: note.page }]);
      const validate = w.json(w.cli(0, ['triage', 'validate', '--actions', actions, '--json']));
      const batch = w.json(w.cli(0, ['triage', 'batch', '--actions', actions, '--preflight', '--json']));
      equal(batch.confirmation_required, expected, '1472: control batch preflight ' + kind);
      equal(validate.confirmation_required, batch.confirmation_required, '1472: validate matches batch ' + kind);
    }
  } finally { await w.dispose(); }
}

async function section1473(): Promise<void> {
  const { triageInventory } = await import('../../src/triageinventory.ts');
  const w = await letterWorkspace('w28-triage-pending');
  try {
    const pending = w.capture(0, ['--for', 'second', '--title', 'Pending']);
    const source = fs.readFileSync(w.file(String(pending.page)), 'utf8').replace(/^review: pending$/m, 'review: done');
    for (let i = 0; i < 199; i++) fs.writeFileSync(w.file('notes/reviewed-' + i), source + '\n' + 'Long note. '.repeat(6400));
    fs.writeFileSync(path.join(w.ws, 'notebook', 'standalone.md'), '# Standalone\n' + 'Notebook text. '.repeat(5000));
    const measured = Array.from({ length: 3 }, () => {
      const start = performance.now();
      const inventory = triageInventory(w.ws, 'notebook', { pendingOnly: true });
      return { inventory, ms: performance.now() - start };
    });
    const full = triageInventory(w.ws, 'notebook') as Record<string, any>;
    const result = measured[0]!.inventory;
    const expected: Record<string, unknown> = { ...full, pages: [], pages_listed: 'none',
      holding_notes: full.holding_notes.filter((note: { review: string }) => note.review !== 'done'),
      holding_notes_listed: 'pending' };
    same(result, expected, '1473: pending keeps counters, topics and pending records');
    equal(full.holding_note_count, 200, '1473: benchmark covers 200 notes');
    process.stdout.write('1473 pending inventory milliseconds: ' + measured.map(value => value.ms.toFixed(2)).join(', ') + '\n');
  } finally { await w.dispose(); }
}

async function section1474(): Promise<void> {
  const w = await letterWorkspace('w28-letters-sent');
  try {
    const pending = w.capture(0, ['--for', 'second', '--title', 'Pending from first']);
    const closed = w.capture(0, ['--for', 'second', '--title', 'Closed from first']);
    w.json(w.cli(1, ['letters', 'close', String(closed.page), '--json']));
    w.capture(1, ['--for', 'first', '--title', 'Incoming to first']);
    const sent = w.json(w.cli(0, ['letters', 'list', '--sent', '--json']));
    same(sent.letters?.map((entry: { page: string }) => entry.page), [pending.page], '1474: only own pending sent letters');
    equal(sent.letters?.[0]?.for_seat, 'second', '1474: recipient seat');
  } finally { await w.dispose(); }
}

async function section1475(): Promise<void> {
  const w = await letterWorkspace('w28-letters-closed');
  try {
    const older = w.capture(0, ['--for', 'second', '--title', 'Older closed']);
    const newer = w.capture(0, ['--for', 'second', '--title', 'Newer closed']);
    w.capture(0, ['--for', 'second', '--title', 'Still pending']);
    for (const [note, date] of [[older, '2026-10-01T12:00:00Z'], [newer, '2026-10-02T12:00:00Z']] as const) {
      w.json(w.cli(1, ['letters', 'close', String(note.page), '--note', 'Handled.', '--json']));
      const file = w.file(String(note.page));
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^reviewed: .*$/m, 'reviewed: ' + date));
    }
    const list = (extra: string[]) => w.json(w.cli(1, ['letters', 'list', '--closed', ...extra, '--json']));
    same(list([]).letters?.map((entry: { page: string }) => entry.page), [newer.page, older.page], '1475: newest closed first');
    const since = list(['--since', '2026-10-02']);
    equal(since.count, 1, '1475: timestamp filter');
    equal(since.letters?.[0]?.closed_note, 'Handled.', '1475: close outcome included');
    equal(since.letters?.[0]?.from, 'first', '1475: sender included');
  } finally { await w.dispose(); }
}

async function section1476(): Promise<void> {
  const w = await letterWorkspace('w28-letter-delivery-id');
  try {
    const sent = w.capture(0, ['--for', 'second', '--title', 'Delivery identity']);
    const file = w.file(String(sent.page));
    const delivery = '12121212-1212-4212-8212-121212121212-20261117t120000z-01234567';
    const current = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, current.replace('\n---\n', '\ndelivery_id: ' + delivery + '\n---\n'));
    const incoming = w.json(w.cli(1, ['letters', 'list', '--json']));
    equal(incoming.letters?.[0]?.delivery_id, delivery, '1476: stored delivery identifier');
    equal(incoming.letters?.[0]?.for_seat, 'second', '1476: recipient seat');
    const outgoing = w.json(w.cli(0, ['letters', 'list', '--sent', '--json']));
    equal(outgoing.letters?.[0]?.delivery_id, delivery, '1476: same identifier in sent listing');
  } finally { await w.dispose(); }
}

async function section1478(): Promise<void> {
  const help = runCli(['capture', '--help']);
  equal(help.exit, 0, '1478: capture help');
  check(help.stdout.includes("routes back through the asker's Library") && help.stdout.includes('Leave out --library when using --answers'),
    '1478: cross-Library answers infer their destination');
  const letters = runCli(['letters', '--help']);
  for (const [result, command] of [[help, 'capture'], [letters, 'letters']] as const) {
    check(result.stdout.includes('[--title <t>]') && result.stdout.includes("defaults to the body's H1")
      && result.stdout.includes('required when the body has none'), '1478: optional title help for ' + command);
  }
}

/** Make a fixture Hub a dev Hub (kickoffs/s213): a dev Hub is one with `## Repo` (PLAN-hub-redesign.md section 3). */
function makeDevHub(ws: string, slug: string): void {
  const file = path.join(ws, 'collection', 'projects', slug, '_project.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n*$/, '\n\n## Repo\n\nA fixture repository.\n'));
}

/** A canonical Run pointer for a fixture Hub. */
const runPointer = (slug: string, id: string, extra = '') => `- [ ] Run ${id}: [[projects/${slug}/kickoffs/${id}]]${extra}`;

async function section1500(): Promise<void> {
  const w = await letterWorkspace('s213-queue-cap');
  try {
    const add = (slug: string, who: number, line: string) => w.cli(who, ['hub', 'edit', slug, '--mode', 'append-section', '--section', 'Next',
      '--content', line, '--json']);
    makeDevHub(w.ws, 'first');
    for (const id of ['s1', 's2', 's3']) equal(add('first', 0, runPointer('first', id)).exit, 0, `1500: dev Hub accepts pending pointer ${id}`);
    const fourth = add('first', 0, runPointer('first', 's4'));
    check(fourth.exit !== 0, '1500: dev Hub refuses a fourth pending pointer');
    check(/at most three pending Run pointers/.test(fourth.stdout + fourth.stderr), '1500: the refusal names the cap of three: ' + fourth.stderr);
    equal(add('second', 1, runPointer('second', 'c1')).exit, 0, '1500: a Hub without ## Repo accepts its first pointer');
    const second = add('second', 1, runPointer('second', 'c2'));
    check(second.exit !== 0, '1500: a Hub without ## Repo still refuses a second pending pointer');
    check((second.stdout + second.stderr).includes('## Next holds one pending Run pointer, and this edit would leave 2: '),
      '1500: a Hub without ## Repo keeps the message word for word: ' + second.stderr);
  } finally { await w.dispose(); }
}

async function section1501(): Promise<void> {
  const w = await letterWorkspace('s213-queue-revise');
  try {
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', '--section', 'Next', ...args, '--json']);
    const pointers = () => fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'first', '_project.md'), 'utf8')
      .split(/\r?\n/).filter(line => /^- \[ \] Run /.test(line)).map(line => /Run ([^:]+):/.exec(line)![1]);
    makeDevHub(w.ws, 'first');
    for (const id of ['s1', 's2', 's3']) w.json(edit(['--mode', 'append-section', '--content', runPointer('first', id)]));
    const revise = (from: string, to: string) => {
      const args = ['--mode', 'replace-item', '--match-text', `Run ${from}:`, '--content', `Run ${to}: [[projects/first/kickoffs/${to}]]`];
      const plan = w.json(edit([...args, '--preflight']));
      equal(w.json(edit([...args, '--user-confirmed', '--plan-id', String(plan.plan_id)])).written, true, `1501: revise ${from} to ${to}`);
    };
    revise('s1', 's1-r2');
    same(pointers(), ['s1-r2', 's2', 's3'], '1501: revising the first keeps its place');
    revise('s2', 's2-r2');
    same(pointers(), ['s1-r2', 's2-r2', 's3'], '1501: revising the middle keeps its place');
    w.json(edit(['--mode', 'check-item', '--match-text', 'Run s1-r2:']));
    const sameId = edit(['--mode', 'append-section', '--content', runPointer('first', 's3', ' (again)')]);
    check(sameId.exit !== 0 && /second pending Run pointer for s3/.test(sameId.stdout + sameId.stderr),
      '1501: a second pending pointer for one unit id is refused: ' + sameId.stderr);
    const samePage = edit(['--mode', 'append-section', '--content', '- [ ] Run other: [[projects/first/kickoffs/s3]]']);
    check(samePage.exit !== 0 && /second pending Run pointer for s3/.test(samePage.stdout + samePage.stderr),
      '1501: a second pending pointer to one kickoffs page is refused: ' + samePage.stderr);
    same(pointers(), ['s2-r2', 's3'], '1501: nothing was written by the refusals');
  } finally { await w.dispose(); }
}

/** A complete Kickoff page's text, as section 448 writes one (hub edit checks every kickoffs/ page it writes). */
function kickoffText(id: string, header = ''): string {
  return `# ${id} kickoff\n\n${header}Row 1.\n\nTRAIN: filled\nWHY NOW: filled\nSIZE: filled\nOWNS: filled\nOWNS PATHS:\n- \`a.ts\`\nSTAY OUT OF: filled\nWHERE THINGS STAND: filled\nMERGE: filled\nROWS:\n1. **A row**: change a.\n   Done when: section 1 passes.\nCOMMANDS: filled\nCHARTER: filled\nNOT CHARTERED: filled\nRULES: filled\nSTANDING ANSWERS: filled\nOPEN: filled\nCLOSE:\n- **Stop.**\n`;
}

/** A Kickoff letter from seat `second` to seat `first`, filed as the Postbox files one: a letter whose body is the envelope. */
async function fileKickoffLetter(w: Awaited<ReturnType<typeof letterWorkspace>>, id: string, text: string): Promise<{ letter: string; sha256: string }> {
  const { buildEnvelope } = await import('../../src/kickoffenvelope.ts');
  const envelope = buildEnvelope(id, text);
  const page = String(w.capture(1, ['--for', 'first', '--title', `Kickoff ${id}`])['page']);
  const file = w.file(page);
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(fs.readFileSync(file, 'utf8'))![0];
  fs.writeFileSync(file, `${front}\n${envelope.text}`);
  return { letter: page, sha256: envelope.sha256 };
}

async function section1502(): Promise<void> {
  const w = await letterWorkspace('s213-receive-queue');
  try {
    makeDevHub(w.ws, 'first');
    const hub = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const runLines = () => fs.readFileSync(hub, 'utf8').split(/\r?\n/).filter(line => /^- \[ \] Run /.test(line));
    const receive = (letter: string) => w.cli(0, ['kickoff', 'receive', letter, '--json']);
    const sent: { id: string; sha256: string; revision: string }[] = [];
    for (const [id, header, revision] of [['k1', '', 'r1'], ['k2-r2', '', 'r2'], ['k3', 'Revision: **r4** (a fixture).\n', 'r4']] as const) {
      const { letter, sha256 } = await fileKickoffLetter(w, id, kickoffText(id, header));
      const ran = receive(letter);
      equal(ran.exit, 0, `1502: receiving ${id} succeeds: ${ran.stderr.slice(0, 400)}`);
      sent.push({ id, sha256, revision });
    }
    same(runLines(), sent.map(({ id, sha256, revision }) => `- [ ] Run ${id}: [[projects/first/kickoffs/${id}]] (${revision}, sha256 \`${sha256}\`, from this Library)`),
      '1502: each received pointer is appended in order with its revision and the page sha256');
    const fourth = await fileKickoffLetter(w, 'k4', kickoffText('k4'));
    const refused = receive(fourth.letter);
    check(refused.exit !== 0 && /at most three pending Run pointers/.test(refused.stderr), '1502: a fourth receive is refused naming the cap: ' + refused.stderr.slice(0, 400));
    check(!fs.existsSync(path.join(w.ws, 'collection', 'projects', 'first', 'kickoffs', 'k4.md')), '1502: the refused receive wrote no page');
    equal(runLines().length, 3, '1502: the refused receive added no pointer');
  } finally { await w.dispose(); }
}

async function section1503(): Promise<void> {
  const { readNeedsYou } = await import('../../src/needsyou.ts');
  const w = await letterWorkspace('s213-needs-you-queue');
  try {
    const add = (line: string) => w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', line, '--json']));
    const kickoffs = () => readNeedsYou(w.ws).sections.find(section => section.key === 'kickoffs')!.items
      .filter(item => item.seat === 'first').map(item => item.text);
    makeDevHub(w.ws, 'first');
    add(runPointer('first', 's1'));
    same(kickoffs(), ['first: s1, waiting for you to start the seat and say yes.'], '1503: one pointer is one line, as before');
    add(runPointer('first', 's2'));
    add(runPointer('first', 's3'));
    same(kickoffs(), ['first: s1, waiting for you to start the seat and say yes.', 'first: 2 more queued'],
      '1503: the first pointer waits to start and the rest are counted');
    w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Next', '--match-text', 'Run s1:', '--json']));
    same(kickoffs(), ['first: s2, waiting for you to start the seat and say yes.', 'first: 1 more queued'],
      '1503: after the first is ticked, the second is the one to start');
  } finally { await w.dispose(); }
}

async function section1504(): Promise<void> {
  const { pendingKickoffIds } = await import('../../src/kickoff.ts');
  const { notebookLinks } = await import('../../src/notebooklinks.ts');
  const w = await letterWorkspace('s213-queue-live');
  try {
    makeDevHub(w.ws, 'first');
    const add = (line: string) => w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', line, '--json']));
    add('- [x] Run s0: [[projects/first/kickoffs/s0]] (done)');
    for (const id of ['s1', 's2', 's3']) add(runPointer('first', id));
    const kickoffs = path.join(w.ws, 'collection', 'projects', 'first', 'kickoffs');
    fs.mkdirSync(kickoffs, { recursive: true });
    for (const id of ['s0', 's1', 's2', 's3']) fs.writeFileSync(path.join(kickoffs, `${id}.md`), `# ${id}\n\nEvidence goes to notebook/first/${id}/run.md.\n`);
    same([...pendingKickoffIds(w.ws, 'first')].sort(), ['s1', 's2', 's3'], '1504: pendingKickoffIds returns every queued id');
    const live = notebookLinks(w.ws).filter(link => link.page.includes('/kickoffs/')).map(link => path.basename(link.page, '.md')).sort();
    same(live, ['s1', 's2', 's3'], '1504: notebookLinks reads every queued Kickoff as live and the ticked one as history');
  } finally { await w.dispose(); }
}

async function section1505(): Promise<void> {
  const w = await letterWorkspace('s213-open-first');
  try {
    makeDevHub(w.ws, 'first');
    for (const id of ['s1', 's2']) w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', runPointer('first', id), '--json']));
    const open = (who: number, id: string, json = false) => w.cli(who, ['kickoff', 'check', '--open', id, ...(json ? ['--json'] : [])]);
    const first = open(0, 's1');
    check(first.exit === 0 && first.stdout.includes('Run s1') && first.stdout.includes('first pending'), '1505: the first pending pointer passes: ' + first.stdout + first.stderr);
    const firstJson = open(0, 's1', true);
    equal(firstJson.exit, 0, '1505: --json passes the first too');
    try { same(JSON.parse(firstJson.stdout).first, 's1', '1505: --json names the first'); } catch { check(false, '1505: --json is JSON: ' + firstJson.stdout); }
    const second = open(0, 's2');
    check(second.exit === 1 && (second.stdout + second.stderr).includes('the first is Run s1'), '1505: the second is refused naming the first: ' + second.stdout + second.stderr);
    const missing = open(0, 's9');
    check(missing.exit === 1 && (missing.stdout + missing.stderr).includes('the first is Run s1'), '1505: an id not queued is refused naming the first');
    const none = open(1, 's1');
    check(none.exit === 1 && (none.stdout + none.stderr).includes('projects/second has no pending Run pointer'), '1505: no pointer is refused naming the Hub: ' + none.stdout + none.stderr);
    const both = w.cli(0, ['kickoff', 'check', 'some-file.md', '--open', 's1']);
    check(both.exit === 2, '1505: a file and --open together are a usage error');
    const usage = runCli(['kickoff', '--help']);
    check(usage.stdout.includes('kickoff check --open <id> [--json]'), '1505: the usage names --open');
  } finally { await w.dispose(); }
}

/**
 * A builder Hub at the end of a unit, for `kickoff next` (kickoffs/s213 rows 8 and 11): the finished Kickoff's ticked
 * pointer, its attempt page with a Handback, this session's closeout record, and the next pointer with its page hash.
 * Each part can be rewritten by the case that tests it; `reset` puts every part back to a chained, done state.
 */
async function chainFixture(w: Awaited<ReturnType<typeof letterWorkspace>>) {
  const { readSeatRegistry } = await import('../../src/desk.ts');
  const { pageComparisonSha256 } = await import('../../src/sha.ts');
  const hubDir = path.join(w.ws, 'collection', 'projects', 'first');
  const hubFile = path.join(hubDir, '_project.md');
  const original = fs.readFileSync(hubFile, 'utf8');
  const session = '14000000-0000-4000-8000-000000000001';
  w.activity('first', {});
  const seatId = readSeatRegistry(path.join(w.ws, '.claude')).find(row => row.seat === 'first')!.seatId;
  const closeoutFile = path.join(w.ws, 'internal', 'checkpoints', seatId, `${session}.json`);
  const kickoff = (id: string, chain: boolean) => {
    fs.mkdirSync(path.join(hubDir, 'kickoffs'), { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'kickoffs', `${id}.md`), kickoffText(id, `Revision: **r1**.\n${chain ? 'CHAIN: yes\n' : ''}\n`));
  };
  const pageSha = (id: string) => pageComparisonSha256(fs.readFileSync(path.join(hubDir, 'kickoffs', `${id}.md`), 'utf8'));
  const setNext = (lines: string[]) => {
    fs.writeFileSync(hubFile, original.replace(/^## Next[ \t]*\r?\n/m, `## Next\n\n${lines.join('\n')}\n`));
    makeDevHub(w.ws, 'first');
  };
  const pointer = (id: string, sha = pageSha(id)) => `- [ ] Run ${id}: [[projects/first/kickoffs/${id}]] (r1, sha256 \`${sha}\`, posted)`;
  const handback = (outcome: string) => {
    fs.mkdirSync(path.join(hubDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'notes', '2026-11-17-f1-a1.md'), `# f1 attempt 1\n\n## Run\n\n- State: done.\n\n## Handback\n\nOutcome: ${outcome}\nRan: kickoffs/f1 r1\n`);
  };
  // The session's record holds the attempt page it wrote (kickoffs/s213-r3 row 3): that is how kickoff next knows the finished unit.
  const attemptWrite = (page = 'notes/2026-11-17-f1-a1') => ({ kind: 'hub', name: 'first', page, at: Date.now() });
  const closeout = (state: string, writes: Record<string, unknown>[] = [attemptWrite()]) => {
    fs.mkdirSync(path.dirname(closeoutFile), { recursive: true });
    const at = Date.now();
    fs.writeFileSync(closeoutFile, JSON.stringify({ schema: 1, seatId, conversation: session, tracking: false, writes, seen: [], trouble: [],
      request: null, savedAt: at, savedWrites: 0, closedOutAt: state === 'done' ? at : null, saveState: 'saved', closeout: state,
      gaps: [], waits: state === 'waits' ? ['a Hub write'] : [], saveGaps: [], saveWaits: [], turnsSince: 0 }));
  };
  const reset = () => {
    kickoff('f1', true); kickoff('n1', true);
    setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', pointer('n1')]);
    handback('done'); closeout('done');
  };
  const next = (context: string, compacted = false): Record<string, string | number> => {
    const ran = w.cli(0, ['kickoff', 'next', '--context', context, ...(compacted ? ['--compacted'] : []), '--json']);
    try { return { exit: ran.exit, ...JSON.parse(ran.stdout) as Record<string, string> }; } catch { return { exit: ran.exit, decision: 'unreadable', reason: ran.stdout + ran.stderr }; }
  };
  return { kickoff, pointer, setNext, handback, closeout, attemptWrite, reset, next, closeoutFile, hubDir };
}

async function section1506(): Promise<void> {
  const w = await letterWorkspace('s213-kickoff-next');
  try {
    const c = await chainFixture(w);
    const cases: [string, () => void, RegExp, string?, boolean?][] = [
      ['parked', () => c.handback('parked'), /Outcome: parked/],
      ['stopped', () => c.handback('stopped'), /Outcome: stopped/],
      ['closeout incomplete', () => c.closeout('waits'), /closeout/],
      ['CHAIN missing on the finished', () => c.kickoff('f1', false), /kickoffs\/f1 does not say CHAIN: yes/],
      ['CHAIN missing on the next', () => { c.kickoff('n1', false); c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', c.pointer('n1')]); }, /kickoffs\/n1 does not say CHAIN: yes/],
      ['hash mismatch', () => c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', c.pointer('n1', '0'.repeat(64))]), /sha256/],
      ['no next pointer', () => c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)']), /no next pending Run pointer/],
      ['exactly 60%', () => {}, /60%/, '60'],
      ['unknown with --compacted', () => {}, /compact/, 'unknown', true],
      ['--compacted', () => {}, /compact/, '59', true],
    ];
    for (const [label, breakIt, reason, context = '59', compacted = false] of cases) {
      c.reset();
      const start = c.next('59');
      check(start.exit === 0 && start['decision'] === 'start' && start['id'] === 'n1', `1506 (${label}): a done, chained pair at 59% starts n1: ${JSON.stringify(start)}`);
      breakIt();
      const stop = c.next(context, compacted);
      check(stop.exit === 0 && stop['decision'] === 'stop' && reason.test(String(stop['reason'])), `1506 (${label}): stops naming the reason: ${JSON.stringify(stop)}`);
    }
    c.reset();
    const unknown = c.next('unknown');
    check(unknown.exit === 0 && unknown['decision'] === 'start' && unknown['id'] === 'n1', `1506: an unknown reading starts n1: ${JSON.stringify(unknown)}`);
    const percent = c.next('59%');
    equal(percent['decision'], 'start', '1506: a reading written with % is read the same');
    const bad = w.cli(0, ['kickoff', 'next', '--context', 'lots', '--json']);
    check(bad.exit !== 0, '1506: a context that is neither a percent nor unknown is refused');
  } finally { await w.dispose(); }
}

async function section1507(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const body = kc.KNOWN_SECTIONS.map(name => name === 'ROWS' ? 'ROWS:\n1. Change.\n   Done when: checked.' : name === 'CLOSE' ? 'CLOSE: **Stop.**'
    : name === 'OWNS PATHS' ? 'OWNS PATHS:\n- `kernel/a.ts`' : name + ': filled').join('\n');
  const page = (chain: string | null) => `# x1 kickoff: a fixture\n\nx1, AT seat. author_seat: lead.\nRevision: **r1**.\n${chain === null ? '' : chain + '\n'}\n${body}\n`;
  const problems = (chain: string | null) => kc.kickoffVerdict(page(chain), { adrFiles: [] }).problems;
  same(problems('CHAIN: yes'), [], '1507: CHAIN: yes in the header is accepted');
  same(problems(null), [], '1507: no CHAIN line is accepted, and means no');
  for (const bad of ['CHAIN: maybe', 'CHAIN: Yes', 'CHAIN: no', 'CHAIN:yes']) {
    const found = problems(bad);
    check(found.length === 1 && found[0]!.includes('CHAIN: yes') && found[0]!.includes(bad), `1507: ${bad} is refused naming the form: ${JSON.stringify(found)}`);
  }
  same(kc.chainHeader(page('CHAIN: yes')), 'yes', '1507: chainHeader reads yes');
  same(kc.chainHeader(page(null)), 'absent', '1507: chainHeader reads absent');
  same(kc.chainHeader(page(null).replace('CLOSE: **Stop.**', 'CHAIN: yes\nCLOSE: **Stop.**')), 'absent', '1507: a CHAIN line below the header is not the header line');
  const template = fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', 'kickoff-template.md'), 'utf8');
  check(/`CHAIN: yes`/.test(template) && /absent means no/i.test(template), '1507: the template names the optional CHAIN: yes line and that absent means no');
}

/** What the loop docs must say about the queue and chaining (kickoffs/s213 rows 10 and 24), as problem lines. */
function loopDocProblems(docs: { session: string; orchestrator: string; hubDesign?: string }): string[] {
  const problems: string[] = [];
  const need = (doc: string, text: string, what: string) => { if (!doc.replace(/\s+/g, ' ').includes(text)) problems.push(`${what} does not say: ${text}`); };
  const s = docs.session;
  need(s, '**A Kickoff starts in a fresh session, with one exception:**', 'dev-session-loop.md');
  need(s, '**The one exception is a chained start**', 'dev-session-loop.md');
  need(s, 'deskpost kickoff check --open <id>', 'dev-session-loop.md');
  need(s, 'deskpost kickoff next --context <percent|unknown> [--compacted] --json', 'dev-session-loop.md');
  need(s, 'its own row 0 from its own pinned base', 'dev-session-loop.md');
  if (s.includes('**A Kickoff starts in a fresh session:**')) problems.push('dev-session-loop.md still holds the unconditional fresh-session sentence');
  need(docs.orchestrator, 'A builder Hub queues up to three Kickoffs', 'dev-loop-orchestrator.md');
  need(docs.orchestrator, 'write `CHAIN: yes` in a Kickoff\'s header only for a Kickoff on another branch', 'dev-loop-orchestrator.md');
  need(docs.orchestrator, 'replaces the old pointer where it stands', 'dev-loop-orchestrator.md');
  if (docs.hubDesign !== undefined) {
    for (const text of ['`hub edit --mode close-item`', '`deskpost hub status <slug>`', 'queue of up to three', 'refuses an added or replaced top-level item']) {
      need(docs.hubDesign, text, 'project-hub-design.md');
    }
  }
  return problems;
}

async function section1508(): Promise<void> {
  const read = (name: string) => fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', name), 'utf8');
  const docs = { session: read('dev-session-loop.md'), orchestrator: read('dev-loop-orchestrator.md'), hubDesign: read('project-hub-design.md') };
  same(loopDocProblems(docs), [], '1508: the loop docs state the queue, the fresh-session exception and the chain rule');
  const noCheck = { ...docs, hubDesign: docs.hubDesign.replace(/`deskpost hub status <slug>`/g, 'hub status') };
  check(loopDocProblems(noCheck).some(line => line.startsWith('project-hub-design.md')), '1508: a design page without the hub status sentence fails the check');
  const old = { ...docs, session: docs.session.replace('**A Kickoff starts in a fresh session, with one exception:**', '**A Kickoff starts in a fresh session:**') };
  check(loopDocProblems(old).some(line => line.includes('unconditional fresh-session sentence')), '1508: the old unconditional sentence fails the check');
  const noChain = { ...docs, orchestrator: docs.orchestrator.replace(/CHAIN: yes/g, 'CHAIN') };
  check(loopDocProblems(noChain).length > 0, '1508: an orchestrator page without the chain rule fails the check');
}

/** A fixture Hub for close-item (kickoffs/s213 rows 12 to 16): the root's Now and Next set by hand, and its readers. */
function closeFixture(w: Awaited<ReturnType<typeof letterWorkspace>>, now: string[], next: string[]) {
  const hubDir = path.join(w.ws, 'collection', 'projects', 'first');
  const root = path.join(hubDir, '_project.md');
  const text = fs.readFileSync(root, 'utf8').replace(/\r\n/g, '\n');
  const nowAt = text.indexOf('\n## Now\n'), nextAt = text.indexOf('\n## Next\n');
  const afterNext = text.indexOf('\n## ', nextAt + 1);
  fs.writeFileSync(root, text.slice(0, nowAt) + `\n## Now\n\n${now.join('\n')}\n` + `\n## Next\n\n${next.join('\n')}\n` + (afterNext < 0 ? '' : text.slice(afterNext)));
  const close = (match: string, extra: string[] = [], env: Record<string, string> = {}) => runCloseWithEnv(w, match, extra, env);
  const history = () => {
    const notes = path.join(hubDir, 'notes');
    return fs.existsSync(notes) ? fs.readdirSync(notes).filter(name => /-history-tidy-\d+\.md$/.test(name)).sort() : [];
  };
  const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return { hubDir, root, close, history, read, rootText: () => read(root), notesText: (name: string) => read(path.join(hubDir, 'notes', name)) };
}

/** close-item through the CLI, with an environment for the test-only fault seam. */
function runCloseWithEnv(w: Awaited<ReturnType<typeof letterWorkspace>>, match: string, extra: string[], env: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return w.cli(0, ['hub', 'edit', 'first', '--mode', 'close-item', '--match-text', match, ...extra, '--json']); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function section1510(): Promise<void> {
  const w = await letterWorkspace('s213-close-item');
  try {
    const f = closeFixture(w, [
      '- [ ] A wrapped item that runs on',
      '  to a second line.',
      '- [ ] A parent item',
      '  - [ ] its sub-item',
      '- [x] An item already ticked',
      '- [ ] Same words one',
      '- [ ] Same words two',
    ], ['- [ ] Run s9: [[projects/first/kickoffs/s9]] (r1)', '- [ ] Something else']);
    const ok = (match: string) => { const ran = f.close(match); equal(ran.exit, 0, `1510: close '${match}': ${ran.stderr.slice(0, 300)}`); return ran; };
    const preview = f.close('runs on', ['--preflight']);
    check(preview.exit === 0 && JSON.parse(preview.stdout).proof === 'passed', '1510: --preflight shows the plan with its proof: ' + preview.stdout.slice(0, 200));
    check(f.rootText().includes('runs on'), '1510: --preflight writes nothing');
    ok('runs on');
    const page = f.history()[0]!;
    check(f.notesText(page).includes('- [x] A wrapped item that runs on\n  to a second line.'), '1510: the wrapped item moved whole, ticked');
    check(!f.rootText().includes('A wrapped item'), '1510: the wrapped item left the root');
    ok('A parent item');
    check(f.notesText(page).includes('- [x] A parent item\n  - [ ] its sub-item'), '1510: the item with its sub-item moved whole, only its first box ticked');
    ok('already ticked');
    check(f.notesText(page).includes('- [x] An item already ticked'), '1510: an already ticked item moved unchanged');
    ok('Run s9:');
    check(f.notesText(page).includes('## From ## Next\n\n- [x] Run s9: [[projects/first/kickoffs/s9]] (r1)'), '1510: a Run pointer moved under From ## Next, ticked');
    check(!f.rootText().includes('Run s9:'), '1510: the Run pointer left the root');
    const before = f.rootText(), notesBefore = f.notesText(page);
    const none = f.close('no such words');
    check(none.exit !== 0 && (none.stdout + none.stderr).includes("contains 'no such words'"), '1510: no match is refused: ' + none.stderr);
    const several = f.close('Same words');
    check(several.exit !== 0 && (several.stdout + several.stderr).includes('matches 2 items'), '1510: several matches are refused, naming them: ' + several.stderr);
    check(f.rootText() === before && f.notesText(page) === notesBefore, '1510: the refusals wrote nothing');
    const other = f.close('Something else', ['--section', 'Decisions']);
    check(other.exit !== 0 && (other.stdout + other.stderr).includes('## Now and ## Next only'), '1510: a section other than Now or Next is refused');
  } finally { await w.dispose(); }
}

async function section1511(): Promise<void> {
  const w = await letterWorkspace('s213-close-history');
  try {
    const { localDate } = await import('../../src/localdate.ts');
    const f = closeFixture(w, ['- [ ] First to close', '- [ ] Second to close'], []);
    equal(f.history().length, 0, '1511: the fixture Hub has no history page');
    equal(f.close('First to close').exit, 0, '1511: the first close succeeds');
    const made = `${localDate()}-hub-history-tidy-1.md`;
    same(f.history(), [made], '1511: a Hub with none gets notes/<date>-hub-history-tidy-1');
    const text = f.notesText(made);
    check(text.startsWith('# first: tidy 1\n\n') || /^# .+: tidy 1\n\n/.test(text), '1511: the new page is titled as hub tidy titles one: ' + text.slice(0, 80));
    check(text.includes('\n## From ## Now\n\n- [x] First to close\n'), '1511: the block is under ## From ## Now');
    // A Hub with two history pages: the close appends to the highest, and makes no third.
    const notes = path.join(f.hubDir, 'notes');
    fs.rmSync(path.join(notes, made));
    fs.writeFileSync(path.join(notes, '2026-11-01-hub-history-tidy-1.md'), '# first: tidy 1\n\nOld.\n');
    const second = '# first: tidy 2\n\nMoved from `_project` on 2026-11-02 by `deskpost hub tidy`, word for word.\n\nPrevious history page: [[projects/first/notes/2026-11-01-hub-history-tidy-1]]\n\n## From ## Now\n\n- [x] Tidied before\n';
    fs.writeFileSync(path.join(notes, '2026-11-02-hub-history-tidy-2.md'), second);
    equal(f.close('Second to close').exit, 0, '1511: the close on a Hub with two pages succeeds');
    same(f.history(), ['2026-11-01-hub-history-tidy-1.md', '2026-11-02-hub-history-tidy-2.md'], '1511: no new page is made');
    equal(f.notesText('2026-11-01-hub-history-tidy-1.md'), '# first: tidy 1\n\nOld.\n', '1511: the older page is untouched');
    // The root's pointer still named the first close's page (removed above), so this close retargets it and says so.
    equal(f.notesText('2026-11-02-hub-history-tidy-2.md'), second + `\nReplaced pointer: Closed items: [[projects/first/notes/${made.slice(0, -3)}]]\n\n- [x] Second to close\n`,
      '1511: the newest page gains the block under its own ## From ## Now');
  } finally { await w.dispose(); }
}

async function section1512(): Promise<void> {
  const w = await letterWorkspace('s213-close-proof');
  try {
    const f = closeFixture(w, ['- [ ] Opens the history page', '- [ ] The item the faults try to close'], []);
    equal(f.close('Opens the history page').exit, 0, '1512: a first close makes the history page (c) needs');
    const page = f.history()[0]!;
    for (const part of ['a', 'b', 'c']) {
      const root = f.rootText(), notes = f.notesText(page);
      for (const extra of [['--preflight'], []]) {
        const ran = f.close('The item the faults try to close', extra, { LIBRARY_CLOSE_ITEM_FAULT: part });
        check(ran.exit !== 0 && (ran.stdout + ran.stderr).includes(`(${part})`), `1512: corrupting (${part}) is refused naming it${extra.length ? ' at --preflight' : ''}: ${ran.stderr.slice(0, 300)}`);
      }
      check(f.rootText() === root && f.notesText(page) === notes && f.history().length === 1, `1512: corrupting (${part}) wrote nothing`);
    }
    equal(f.close('The item the faults try to close').exit, 0, '1512: without a fault the same close succeeds');
  } finally { await w.dispose(); }
}

async function section1513(): Promise<void> {
  const w = await letterWorkspace('s213-close-pointer');
  try {
    const { localDate } = await import('../../src/localdate.ts');
    const tidied = 'Tidied 2026-11-01 from ## Now: 1 item moved word for word to [[projects/first/notes/2026-11-01-hub-history-tidy-9]] (tidy 9); that page links the one before it.';
    const f = closeFixture(w, [tidied, '', '- [ ] Alpha', '- [ ] Beta', '- [ ] Gamma'], ['- [ ] Only next item']);
    const first = `${localDate()}-hub-history-tidy-1`;
    const pointer = (name: string) => `Closed items: [[projects/first/notes/${name}]]`;
    const nowOf = () => /\n## Now\n([\s\S]*?)\n## Next\n/.exec(f.rootText())![1]!;
    // insert: before the section's first top-level item, with a blank line after it.
    equal(JSON.parse(f.close('Alpha').stdout).pointer_change, 'insert', '1513: the first close inserts the pointer');
    check(nowOf().includes(`${pointer(first)}\n\n- [ ] Beta`), '1513: the pointer stands before the first remaining item: ' + nowOf());
    // none: the pointer already names the page.
    const before = nowOf();
    equal(JSON.parse(f.close('Beta').stdout).pointer_change, 'none', '1513: a close with the pointer current changes no pointer');
    equal(nowOf(), before.replace('- [ ] Beta\n', ''), '1513: only the item left the section');
    // retarget: a newer page made by hub tidy (here by hand), so this close writes there and moves the pointer.
    const newer = '2026-11-18-hub-history-tidy-2';
    fs.writeFileSync(path.join(f.hubDir, 'notes', `${newer}.md`), '# first: tidy 2\n\nMoved by hub tidy.\n');
    equal(JSON.parse(f.close('Gamma').stdout).pointer_change, 'retarget', '1513: a newer page retargets the pointer');
    check(nowOf().includes(pointer(newer)) && !nowOf().includes(pointer(first)), '1513: the pointer now names the newer page');
    check(f.notesText(`${newer}.md`).includes(`Replaced pointer: ${pointer(first)}\n\n- [x] Gamma`), '1513: the old pointer line is on the history block as Replaced pointer');
    // At the section's end when no item is left, one pointer per section, and Tidied paragraphs never touched.
    equal(JSON.parse(f.close('Only next item').stdout).pointer_change, 'insert', '1513: Next gets its own pointer');
    check(/\n## Next\n\n+Closed items: \[\[projects\/first\/notes\/2026-11-18-hub-history-tidy-2\]\]\n/.test(f.rootText()), '1513: with no item left the pointer stands at the section end');
    check(f.rootText().includes(tidied), '1513: the Tidied paragraph is untouched');
    equal(f.rootText().split('\n').filter(line => line.startsWith('Closed items: ')).length, 2, '1513: one pointer in each section');
  } finally { await w.dispose(); }
}

async function section1514(): Promise<void> {
  const help = runCli(['hub', '--help']);
  check(help.stdout.includes('check-item|close-item|replace-item'), '1514: the hub edit usage names close-item');
  check(runCli(['hub', 'edit', '--help']).stdout.includes('  close-item       --match-text <t> [--section Now|Next]'), '1514: the hub edit help has a close-item line');
  const { hubRefusalJson } = await import('../../src/hubedit.ts');
  equal(hubRefusalJson('edit', "close-item was given a --plan-id that is not this edit's: the page changed.")['reason'], 'stale-plan', '1514: a stale close-item plan id is a stale-plan refusal');
  const w = await letterWorkspace('s213-close-usage');
  try {
    const f = closeFixture(w, ['- [ ] An item'], []);
    const after = w.cli(0, ['hub', 'edit', 'first', '--mode', 'close-item', '--after', 'An item', '--json']);
    check(after.exit !== 0 && (after.stdout + after.stderr).includes('--after is for insert-item only'), '1514: --after with close-item is refused: ' + after.stdout + after.stderr);
    const content = w.cli(0, ['hub', 'edit', 'first', '--mode', 'close-item', '--match-text', 'An item', '--content', 'x', '--json']);
    check(content.exit !== 0 && (content.stdout + content.stderr).includes('takes no content'), '1514: content with close-item is refused');
    const stale = f.close('An item', ['--plan-id', 'project-close-0']);
    check(stale.exit !== 0 && (stale.stdout + stale.stderr).includes("close-item was given a --plan-id that is not this edit's"), '1514: a wrong plan id is refused: ' + stale.stdout + stale.stderr);
    const plan = JSON.parse(f.close('An item', ['--preflight']).stdout);
    equal(f.close('An item', ['--plan-id', String(plan.plan_id)]).exit, 0, '1514: the preflight plan id applies');
  } finally { await w.dispose(); }
}

/** A fixture train register (kickoffs/s213 rows 17 to 20): `open` items open, `done` and `dropped` closed. */
function writeTrain(ws: string, items: [string, 'open' | 'done' | 'dropped', string][], car: string | null): void {
  const file = path.join(ws, 'internal', 'train', 'register.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, changed_at: '2026-11-17T00:00:00Z', changed_by: 'lead',
    items: items.map(([id, status, place]) => ({ id, title: id, place, first_asked: '2026-11-01', source: 'fixture', status, note: '' })),
    cars: car === null ? [] : [{ place: car, opened: '2026-11-10', arrived: null }] }, null, 2));
}

async function hubStatusOf(w: Awaited<ReturnType<typeof letterWorkspace>>, who: number, slug: string): Promise<{ exit: number; text: string; lines: { group: string; source: string; text: string }[] }> {
  const text = w.cli(who, ['hub', 'status', slug]);
  const json = w.cli(who, ['hub', 'status', slug, '--json']);
  let lines: { group: string; source: string; text: string }[] = [];
  try { lines = JSON.parse(json.stdout).lines; } catch { lines = []; }
  return { exit: text.exit === 0 && json.exit === 0 ? 0 : 1, text: text.stdout + text.stderr, lines };
}

async function section1515(): Promise<void> {
  const w = await letterWorkspace('s213-hub-status');
  try {
    writeTrain(w.ws, [['open-thing', 'open', 'car:one'], ['done-thing', 'done', 'car:one']], 'car:one');
    const letter = String(w.capture(1, ['--for', 'first', '--title', 'A question'])['page']);
    closeFixture(w, ['- [ ] Waits on `open-thing`', '- [ ] Waits on `done-thing`', '- [ ] Review kickoffs/s0', `- [ ] Answer ${letter}`],
      ['- [x] Run s0: [[projects/first/kickoffs/s0]] (r1)', '- [ ] Run s1: [[projects/first/kickoffs/s1]] (r1)']);
    makeDevHub(w.ws, 'first');
    const status = await hubStatusOf(w, 0, 'first');
    equal(status.exit, 0, '1515: hub status runs: ' + status.text.slice(0, 300));
    const said = (text: string, source: string) => check(status.lines.some(line => line.text === text && line.source === source), `1515: says "${text}" from ${source}: ${JSON.stringify(status.lines)}`);
    said('train open-thing: open', 'train:open-thing');
    said('train done-thing: done; closed: tick or close this item', 'train:done-thing');
    said('kickoffs/s0: ticked; closed: tick or close this item', 'projects/first/_project ## Next Run s0');
    said('kickoffs/s1: pending', 'projects/first/_project ## Next Run s1');
    said(`letter ${letter}: open`, `letters/${letter}`);
    said('1. Run s1 (the one to open)', 'projects/first/_project ## Next');
    said('first: s1, waiting for you to start the seat and say yes.', 'needs-you:kickoffs');
    check(status.lines.some(line => line.group === 'pages' && line.text.startsWith('_project: ')), '1515: the root page size is shown');
    equal(w.cli(0, ['letters', 'close', letter]).exit, 0, '1515: the letter closes');
    const after = await hubStatusOf(w, 0, 'first');
    check(after.lines.some(line => line.text === `letter ${letter}: closed; closed: tick or close this item`), '1515: a closed letter marks its item');
  } finally { await w.dispose(); }
}

async function section1516(): Promise<void> {
  const w = await letterWorkspace('s213-hub-status-desk');
  try {
    writeTrain(w.ws, [['open-thing', 'open', 'car:one']], null);
    const letter = String(w.capture(1, ['--for', 'first', '--title', 'A question'])['page']);
    closeFixture(w, [`- [ ] Answer ${letter}`], []);
    // A Hub not open on this Desk: one line, and the view still answers.
    const closedHub = await hubStatusOf(w, 0, 'second');
    equal(closedHub.exit, 0, '1516: a closed Hub does not refuse the view');
    check(closedHub.lines.some(line => line.text === 'projects/second: closed on this Desk' && line.source === 'projects/second'), '1516: a closed Hub is one line');
    check(!closedHub.lines.some(line => line.group === 'pages' || line.group === 'needs-you' || line.group === 'pointers'), '1516: nothing from a closed Hub is read');
    check(closedHub.lines.some(line => line.group === 'train'), '1516: the Library train still shows');
    // The letters Book closed: a count and the oldest date, no letter one by one.
    equal(w.cli(0, ['desk', 'close', 'book', 'letters', '--seat', 'first']).exit, 0, '1516: the letters Book closes');
    const closedLetters = await hubStatusOf(w, 0, 'first');
    equal(closedLetters.exit, 0, '1516: a closed letters Book does not refuse the view');
    check(!closedLetters.lines.some(line => line.text.startsWith('letter ')), '1516: no letter is listed one by one');
    check(closedLetters.lines.some(line => /^letters: closed on this Desk; 1 open for first, the oldest from /.test(line.text)), '1516: letters are a count and the oldest date: ' + JSON.stringify(closedLetters.lines));
  } finally { await w.dispose(); }
}

async function section1517(): Promise<void> {
  const w = await letterWorkspace('s213-hub-status-train');
  try {
    writeTrain(w.ws, [['a-one', 'open', 'car:one'], ['a-two', 'done', 'car:one'], ['a-three', 'open', 'lane:hubs'], ['a-four', 'open', 'bucket:1'],
      ['a-five', 'open', 'car:one'], ['a-six', 'open', 'foundation'], ['a-seven', 'open', 'running']], 'car:one');
    closeFixture(w, ['- [ ] Waits on [[projects/second/kickoffs/c1]]'], []);
    w.json(w.cli(1, ['hub', 'edit', 'second', '--mode', 'append-section', '--section', 'Next', '--content', '- [ ] Run c1: [[projects/second/kickoffs/c1]]', '--json']));
    const status = await hubStatusOf(w, 0, 'first');
    const train = status.lines.filter(line => line.group === 'train').map(line => line.text);
    same(train, ['open car car:one, opened 2026-11-10', 'a-one (car:one)', 'a-three (lane:hubs)', 'a-four (bucket:1)', 'a-five (car:one)', 'a-six (foundation)'],
      '1517: the open car and the first five open items in register order, with their place');
    check(status.text.includes('\nLibrary train\n') && !/lane/i.test(status.text.split('Library train')[1]!.split('\n\n')[0]!.replace('(lane:hubs)', '')), '1517: headed Library train, no lane grouping');
    check(status.lines.some(line => line.text === 'projects/second: closed on this Desk'), '1517: another Hub named but closed is one line');
    equal(w.cli(0, ['desk', 'open', 'project', 'second', '--seat', 'first']).exit, 0, '1517: open the other Hub on this Desk');
    const open = await hubStatusOf(w, 0, 'first');
    check(open.lines.some(line => line.text === 'projects/second kickoffs/c1: pending' && line.source === 'projects/second/_project ## Next Run c1'), '1517: the named pointer of an open Hub shows its state: ' + JSON.stringify(open.lines));
    w.json(w.cli(1, ['hub', 'edit', 'second', '--mode', 'check-item', '--section', 'Next', '--match-text', 'Run c1:', '--json']));
    w.json(w.cli(1, ['hub', 'edit', 'second', '--mode', 'append-section', '--section', 'Next', '--content', '- [ ] Run c2: [[projects/second/kickoffs/c2]]', '--json']));
    const later = await hubStatusOf(w, 0, 'first');
    check(!later.lines.some(line => line.text.includes('c2')), '1517: a pointer this Hub does not name never appears');
    writeTrain(w.ws, [['a-one', 'open', 'car:one']], null);
    check((await hubStatusOf(w, 0, 'first')).lines.some(line => line.group === 'train' && line.text === 'no open car'), '1517: no open car is said');
  } finally { await w.dispose(); }
}

async function section1518(): Promise<void> {
  const w = await letterWorkspace('s213-hub-status-width');
  try {
    writeTrain(w.ws, [['a-very-long-train-item-identifier-that-runs-on-and-on-past-the-edge', 'open', 'car:a-very-long-car-name-too']], 'car:a-very-long-car-name-too');
    closeFixture(w, ['- [ ] Waits on `a-very-long-train-item-identifier-that-runs-on-and-on-past-the-edge`'], ['- [ ] Run s1: [[projects/first/kickoffs/s1]]']);
    const status = await hubStatusOf(w, 0, 'first');
    equal(status.exit, 0, '1518: hub status runs');
    const wide = status.text.split(/\r?\n/).filter(line => line.length > 69);
    same(wide, [], '1518: every terminal line is at most 69 columns');
    check(status.lines.length > 5 && status.lines.every(line => typeof line.source === 'string' && line.source.length > 0), '1518: every --json line names its source');
    const { fitLine } = await import('../../src/hubstatus.ts');
    equal(fitLine('x'.repeat(80)).length, 69, '1518: a long line is cut to 69 columns');
  } finally { await w.dispose(); }
}

/** Row 22's refusal names where the detail goes and the close-item command (kickoffs/s213 row 22). */
function namesPointerRemedy(message: string): boolean {
  return message.includes('Put the wording') && message.includes('in the record and point to it here') && message.includes('--mode close-item');
}

async function section1519(): Promise<void> {
  const w = await letterWorkspace('s213-dev-pointers');
  try {
    writeTrain(w.ws, [['known-item', 'open', 'car:one']], null);
    makeDevHub(w.ws, 'first');
    const add = (who: number, slug: string, section: string, line: string) => w.cli(who, ['hub', 'edit', slug, '--mode', 'append-section', '--section', section, '--content', line, '--json']);
    const sized = (bytes: number) => { const head = '- [ ] See [[projects/first/notes/record]] '; return head + 'x'.repeat(bytes - Buffer.byteLength(head)); };
    const long = add(0, 'first', 'Now', sized(601));
    check(long.exit !== 0 && (long.stdout + long.stderr).includes('601 bytes, over 600'), '1519: a 601-byte item is refused: ' + long.stderr.slice(0, 300));
    check(namesPointerRemedy(long.stdout + long.stderr), '1519: the refusal names where the detail goes and close-item');
    equal(add(0, 'first', 'Now', sized(600)).exit, 0, '1519: a 600-byte item with a record is accepted');
    const bare = add(0, 'first', 'Next', '- [ ] Remember to look at the thing later');
    check(bare.exit !== 0 && (bare.stdout + bare.stderr).includes('names no record') && namesPointerRemedy(bare.stdout + bare.stderr), '1519: an item naming no record is refused');
    const unknown = add(0, 'first', 'Now', '- [ ] Waits on `not-a-train-item`');
    check(unknown.exit !== 0, '1519: a backticked word that is no train item is no record');
    for (const form of ['`known-item`', '[[projects/first/notes/a-page]]', '[[books/handbook/page]]', 'kickoffs/s5', 'notes/2026-11-17-a-letter-page', 'PLAN-hub-redesign.md']) {
      equal(add(0, 'first', 'Now', `- [ ] Waits on ${form}`).exit, 0, `1519: the record form ${form} is accepted`);
    }
    const root = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    if (!/^## Decisions/m.test(fs.readFileSync(root, 'utf8'))) {
      equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'add-section', '--section', 'Decisions', '--content', '- 2026-11-17: a short one ([[projects/first/notes/decision]])', '--json']).exit, 0, '1519: a short linked Decisions entry is accepted');
    }
    const longDecision = add(0, 'first', 'Decisions', `- 2026-11-17: ${'a reason '.repeat(50)}[[projects/first/notes/decision]]`);
    check(longDecision.exit !== 0 && (longDecision.stdout + longDecision.stderr).includes('over 400'), '1519: a long Decisions entry is refused');
    check(add(0, 'first', 'Decisions', '- 2026-11-17: no link here').exit !== 0, '1519: a Decisions entry with no link is refused');
    // The same items on a Hub without ## Repo: accepted, as today.
    for (const line of [sized(601), '- [ ] Remember to look at the thing later']) equal(add(1, 'second', 'Now', line).exit, 0, '1519: a Hub without ## Repo accepts ' + line.slice(0, 30));
    // An old long item is never judged: an unrelated edit, and ticking it, both pass and leave it alone.
    const old = '- [ ] An old item written before the check, long and pointing nowhere: ' + 'y'.repeat(700);
    fs.writeFileSync(root, fs.readFileSync(root, 'utf8').replace(/^## Now\r?\n/m, `## Now\n\n${old}\n`));
    equal(add(0, 'first', 'Next', '- [ ] Waits on kickoffs/s6').exit, 0, '1519: an unrelated edit beside an old long item passes');
    equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Now', '--match-text', 'An old item written', '--json']).exit, 0, '1519: ticking an old long item passes');
    check(fs.readFileSync(root, 'utf8').includes(old.replace('[ ]', '[x]')), '1519: the old item is left as it was, ticked');
    // The negative control: a refusal without the remedy sentence fails the assertion above.
    check(!namesPointerRemedy('On a dev Hub, an item in ## Now is a short pointer. Nothing was written.'), '1519: a refusal without the remedy fails the check');
  } finally { await w.dispose(); }
}

async function section1523(): Promise<void> {
  const { closeItemProof } = await import('../../src/hubtidy.ts');
  const pointer = 'Closed items: [[projects/first/notes/2026-11-01-hub-history-tidy-1]]';
  const page = (now: string[], next: string[]) => ['# first', '', '## Now', '', ...now, '', '## Next', '', ...next, ''].join('\n');
  const oldNotes = '# first: tidy 1\n\n## From ## Now\n\n- [x] Old\n';
  const goodNotes = oldNotes + '\n- [x] Alpha\n';
  // Alpha is line 6 (0-based) of a root whose Now already holds the pointer, and line 4 of one with no pointer yet.
  const withPointer = page([pointer, '', '- [ ] Alpha', '- [ ] Beta'], ['- [ ] Gamma']);
  const bare = page(['- [ ] Alpha', '- [ ] Beta'], ['- [ ] Gamma']);
  const proof = (currentBody: string, blockStart: number, proposedBody: string, notesBody = goodNotes) =>
    closeItemProof({ currentBody, proposedBody, blockStart, blockEnd: blockStart, oldNotes, notesBody, pointer });
  same(proof(withPointer, 6, page([pointer, '', '- [ ] Beta'], ['- [ ] Gamma'])), [], '1523: a correct close with the pointer current is accepted');
  same(proof(bare, 4, page([pointer, '', '- [ ] Beta'], ['- [ ] Gamma'])), [], '1523: a correct close inserting the pointer is accepted');
  const refused = (problems: string[], part: string, label: string) => check(problems.length > 0 && problems.every(problem => problem.startsWith(`(${part})`)), `1523: ${label} is refused under (${part}): ${JSON.stringify(problems)}`);
  refused(proof(withPointer, 6, page(['- [ ] Beta'], [pointer, '', '- [ ] Gamma'])), 'a', 'the pointer moved to another section');
  refused(proof(bare, 4, page(['- [ ] Beta'], [pointer, '', '- [ ] Gamma'])), 'a', 'a new pointer written in another section');
  refused(proof(withPointer, 6, page(['- [ ] Beta', '', pointer], ['- [ ] Gamma'])), 'a', 'the pointer moved within its section');
  refused(proof(withPointer, 6, page([pointer, '', pointer, '', '- [ ] Beta'], ['- [ ] Gamma'])), 'a', 'the pointer duplicated');
  refused(proof(withPointer, 6, page([pointer, '', '- [ ] Beta'], ['- [ ] Gamma']), goodNotes + '- [x] Alpha\n'), 'b', 'the block doubled in the history');
  refused(proof(withPointer, 6, page([pointer, '', '- [ ] Beta'], ['- [ ] Gamma']), oldNotes + '\n- [x] Alpha\n\nA line after it.\n'), 'b', 'the block not at the end of the history');
}

async function section1524(): Promise<void> {
  const w = await letterWorkspace('s213r2-close-twin');
  try {
    const f = closeFixture(w, ['- [ ] Twin item', '- [ ] Stays'], []);
    // The same text as the Now item, earlier on the page in Purpose: the close must prove the Now block it planned.
    fs.writeFileSync(f.root, f.rootText().replace(/\n## Purpose\n/, '\n## Purpose\n\n- [ ] Twin item\n'));
    const ran = f.close('Twin item', ['--section', 'Now']);
    equal(ran.exit, 0, '1524: closing the Now item whose text Purpose also holds succeeds: ' + ran.stderr.slice(0, 400));
    const purpose = /\n## Purpose\n([\s\S]*?)\n## /.exec(f.rootText())?.[1] ?? '';
    const now = /\n## Now\n([\s\S]*?)\n## Next\n/.exec(f.rootText())?.[1] ?? '';
    check(purpose.includes('- [ ] Twin item'), '1524: the Purpose line is untouched: ' + purpose);
    check(!now.includes('Twin item') && now.includes('- [ ] Stays'), '1524: the Now item left the root: ' + now);
    check(f.history().length === 1 && f.notesText(f.history()[0]!).endsWith('\n- [x] Twin item\n'), '1524: the history page holds the Now block, ticked');
  } finally { await w.dispose(); }
}

async function section1525(): Promise<void> {
  const w = await letterWorkspace('s213r2-close-half-page');
  try {
    const f = closeFixture(w, ['- [ ] Closes onto a new page'], []);
    equal(f.history().length, 0, '1525: the fixture Hub has no history page');
    const root = f.rootText();
    const ran = f.close('Closes onto a new page', [], { LIBRARY_CLOSE_ITEM_FAULT: 'write' });
    check(ran.exit !== 0 && (ran.stdout + ran.stderr).includes('A test fault stopped the write'), '1525: the throwing write is refused: ' + ran.stderr.slice(0, 400));
    same(f.history(), [], '1525: no new history page is left behind');
    equal(f.rootText(), root, '1525: the root is unchanged');
    equal(f.close('Closes onto a new page').exit, 0, '1525: without the fault the same close succeeds');
  } finally { await w.dispose(); }
}

async function section1526(): Promise<void> {
  const w = await letterWorkspace('s213r2-kickoff-next-closeout');
  try {
    const c = await chainFixture(w);
    const record = () => JSON.parse(fs.readFileSync(c.closeoutFile, 'utf8')) as Record<string, unknown>;
    const rewrite = (change: Record<string, unknown>) => fs.writeFileSync(c.closeoutFile, JSON.stringify({ ...record(), ...change }));
    c.reset();
    const start = c.next('42');
    check(start['decision'] === 'start' && start['id'] === 'n1', '1526: a finished closeout still starts n1: ' + JSON.stringify(start));
    for (const [label, change, shown] of [
      ['done with no closedOutAt', { closeout: 'done', closedOutAt: null }, /closeout: done, with no closedOutAt/],
      ['done with closedOutAt missing', { closeout: 'done', closedOutAt: undefined }, /closeout: done, with no closedOutAt/],
      ['done with a closedOutAt that is no number', { closeout: 'done', closedOutAt: 'yesterday' }, /closeout: done, with no closedOutAt/],
      ['stale', { closeout: 'stale' }, /closeout: stale/],
    ] as [string, Record<string, unknown>, RegExp][]) {
      c.reset();
      rewrite(change);
      const stop = c.next('42');
      check(stop['decision'] === 'stop' && shown.test(String(stop['reason'])), `1526 (${label}): stops naming what the record shows: ${JSON.stringify(stop)}`);
    }
  } finally { await w.dispose(); }
}

async function section1527(): Promise<void> {
  const w = await letterWorkspace('s213r2-queue-case');
  try {
    makeDevHub(w.ws, 'first');
    const root = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const append = (line: string) => w.cli(0, ['hub', 'edit', 'first', '--section', 'Next', '--mode', 'append-section', '--content', line, '--json']);
    equal(append(runPointer('first', 's1')).exit, 0, '1527: the first pointer, Run s1, is accepted');
    const before = fs.readFileSync(root, 'utf8');
    const upper = append(runPointer('first', 'S1'));
    check(upper.exit !== 0 && /second pending Run pointer for s1/.test(upper.stdout + upper.stderr), '1527: Run S1: to kickoffs/S1 beside Run s1: is refused as a duplicate: ' + (upper.stdout + upper.stderr).slice(0, 300));
    const idOnly = append('- [ ] Run S1: [[projects/first/kickoffs/other]]');
    check(idOnly.exit !== 0 && /second pending Run pointer for s1/.test(idOnly.stdout + idOnly.stderr), '1527: an id differing only in case is a duplicate');
    const pageOnly = append('- [ ] Run other: [[projects/first/kickoffs/S1]]');
    check(pageOnly.exit !== 0 && /second pending Run pointer for s1/.test(pageOnly.stdout + pageOnly.stderr), '1527: a kickoffs page differing only in case is a duplicate');
    equal(fs.readFileSync(root, 'utf8'), before, '1527: the refusals wrote nothing');
    equal(append(runPointer('first', 's2')).exit, 0, '1527: a different unit is still accepted');
  } finally { await w.dispose(); }
}

async function section1528(): Promise<void> {
  const kc = await import('../../src/kickoffcheck.ts');
  const body = kc.KNOWN_SECTIONS.map(name => name === 'ROWS' ? 'ROWS:\n1. Change.\n   Done when: checked.' : name === 'CLOSE' ? 'CLOSE: **Stop.**'
    : name === 'OWNS PATHS' ? 'OWNS PATHS:\n- `kernel/a.ts`' : name + ': filled').join('\n');
  const page = (header: string[]) => `# x1 kickoff: a fixture\n\nx1, AT seat. author_seat: lead.\nRevision: **r1**.\n${header.map(line => line + '\n').join('')}\n${body}\n`;
  const problems = (header: string[]) => kc.kickoffVerdict(page(header), { adrFiles: [] }).problems;
  same(problems(['CHAIN: yes']), [], '1528: one CHAIN: yes line is accepted');
  for (const [label, header, line] of [
    ['a second CHAIN: yes', ['CHAIN: yes', 'A header line between.', 'CHAIN: yes'], 'CHAIN: yes'],
    ['CHAIN: no after CHAIN: yes', ['CHAIN: yes', 'CHAIN: no'], 'CHAIN: no'],
    ['a malformed line after CHAIN: yes', ['CHAIN: yes', 'CHAIN:yes'], 'CHAIN:yes'],
  ] as [string, string[], string][]) {
    const found = problems(header);
    const at = 5 + header.lastIndexOf(line);
    check(found.length === 1 && found[0]!.startsWith(`line ${at}: "${line}"`), `1528: ${label} is refused naming line ${at}: ${JSON.stringify(found)}`);
    check(typeof kc.chainHeader(page(header)) === 'object', `1528: chainHeader does not read ${label} as yes`);
  }
}

async function section1529(): Promise<void> {
  const w = await letterWorkspace('s213r2-kickoff-next-reads');
  try {
    makeDevHub(w.ws, 'first');
    const c = await chainFixture(w);
    const vault = path.join(w.root, 'vault');
    for (const folder of ['.obsidian', 'Librarian']) fs.mkdirSync(path.join(vault, folder), { recursive: true });
    const preview = w.json(w.cli(0, ['vault', 'connect', vault, '--preflight', '--json']));
    equal(w.cli(0, ['vault', 'connect', vault, '--user-confirmed', '--plan-id', String(preview['plan_id'] ?? '')]).exit, 0, '1529: the vault connects');
    const page = path.join(vault, 'Librarian', 'needs-you.md');
    equal(w.cli(0, ['needs-you', '--write', '--json']).exit, 0, '1529: the needs-you page is written');
    // The queue changes by hand, so a refresh would now rewrite the page.
    c.reset();
    const bytes = fs.readFileSync(page);
    const next = c.next('42');
    check(next['decision'] === 'start', '1529: kickoff next answers: ' + JSON.stringify(next));
    check(fs.readFileSync(page).equals(bytes), '1529: kickoff next left Librarian/needs-you.md unchanged');
    // The control: the page was stale, so a refreshing write does change it.
    equal(w.cli(0, ['needs-you', '--write', '--json']).exit, 0, '1529: the control write runs');
    check(!fs.readFileSync(page).equals(bytes), '1529: the control: the page was stale, so a write changes it');
  } finally { await w.dispose(); }
}

async function section1530(): Promise<void> {
  const w = await letterWorkspace('s213r2-decisions-remedy');
  try {
    writeTrain(w.ws, [['known-item', 'open', 'car:one']], null);
    makeDevHub(w.ws, 'first');
    const add = (section: string, line: string) => w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', section, '--content', line, '--json']);
    const root = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    if (!/^## Decisions/m.test(fs.readFileSync(root, 'utf8'))) {
      equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'add-section', '--section', 'Decisions', '--content', '- 2026-11-17: a short one ([[projects/first/notes/decision]])', '--json']).exit, 0, '1530: a short linked Decisions entry is accepted');
    }
    // Both refusals carry the remedy: the wording goes in the linked record, and close-item closes what is finished.
    const remedy = (message: string) => /wording[^.]* in the (linked )?record/.test(message) && message.includes('deskpost hub edit first --mode close-item --match-text');
    const nowItem = add('Now', '- [ ] Remember to look at the thing later');
    check(nowItem.exit !== 0 && remedy(nowItem.stdout + nowItem.stderr), '1530: the Now refusal names the record and close-item: ' + (nowItem.stdout + nowItem.stderr).slice(0, 400));
    const decision = add('Decisions', '- 2026-11-17: no link here');
    check(decision.exit !== 0 && remedy(decision.stdout + decision.stderr), '1530: the Decisions refusal names the linked record and close-item: ' + (decision.stdout + decision.stderr).slice(0, 400));
    check(!remedy("On a dev Hub, a ## Decisions entry is a one-line pointer. Put the decision's wording in a dated record page and link it here. Nothing was written."), '1530: the control: the old Decisions refusal fails the check');
  } finally { await w.dispose(); }
}

async function section1531(): Promise<void> {
  const w = await letterWorkspace('s213r3-kickoff-next-exact-closeout');
  try {
    const c = await chainFixture(w);
    const record = () => JSON.parse(fs.readFileSync(c.closeoutFile, 'utf8')) as Record<string, unknown>;
    const rewrite = (change: Record<string, unknown>) => fs.writeFileSync(c.closeoutFile, JSON.stringify({ ...record(), ...change }));
    c.reset();
    const start = c.next('42');
    check(start['decision'] === 'start' && start['id'] === 'n1', '1531: a finished closeout still starts n1: ' + JSON.stringify(start));
    for (const [label, change, shown] of [
      ['"done yesterday" with no closedOutAt', { closeout: 'done yesterday', closedOutAt: undefined }, /closeout: done yesterday/],
      ['"done yesterday" with a finite closedOutAt', { closeout: 'done yesterday' }, /closeout: done yesterday/],
      ['done with closedOutAt "soon"', { closeout: 'done', closedOutAt: 'soon' }, /closeout: done, with no closedOutAt/],
      ['done with closedOutAt null', { closeout: 'done', closedOutAt: null }, /closeout: done, with no closedOutAt/],
    ] as [string, Record<string, unknown>, RegExp][]) {
      c.reset();
      rewrite(change);
      const stop = c.next('42');
      check(stop['decision'] === 'stop' && shown.test(String(stop['reason'])), `1531 (${label}): stops naming the closeout: ${JSON.stringify(stop)}`);
    }
  } finally { await w.dispose(); }
}

async function section1532(): Promise<void> {
  // The words come from the loop doc's own Handback line, so a word the doc adds fails this section until kickoff next knows it.
  const doc = fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', 'dev-session-loop.md'), 'utf8').replace(/\s+/g, ' ');
  const line = /`Outcome: <([^>`]+)>`/.exec(doc)?.[1];
  check(line !== undefined, '1532: docs/dev-session-loop.md holds the Handback line `Outcome: <...>`');
  const words = (line ?? '').split('|').map(word => word.trim()).filter(Boolean);
  check(words.length >= 2, '1532: the Outcome line names its words: ' + JSON.stringify(words));
  const finishing = new Set(['pushed', 'published']);
  const known = await import('../../src/kickoff.ts').then(m => [...(m.FINISHED_OUTCOMES ?? []), ...(m.STOPPING_OUTCOMES ?? [])] as string[], () => [] as string[]);
  const w = await letterWorkspace('s213r3-kickoff-next-outcome-words');
  try {
    const c = await chainFixture(w);
    for (const word of words) {
      check(known.includes(word), `1532: kickoff next knows the loop doc's Outcome word "${word}": ${JSON.stringify(known)}`);
      c.reset();
      c.handback(word);
      const answer = c.next('42');
      if (finishing.has(word)) check(answer['decision'] === 'start' && answer['id'] === 'n1', `1532: Outcome: ${word} starts n1: ${JSON.stringify(answer)}`);
      else check(answer['decision'] === 'stop' && String(answer['reason']).includes(`Outcome: ${word}`), `1532: Outcome: ${word} stops naming it: ${JSON.stringify(answer)}`);
    }
    for (const word of finishing) check(words.includes(word), `1532: the loop doc still gives the finishing word "${word}"`);
    c.reset();
    c.handback('landed');
    const unknown = c.next('42');
    check(unknown['decision'] === 'stop' && String(unknown['reason']).includes('Outcome: landed'), '1532: a word the doc does not give stops naming it: ' + JSON.stringify(unknown));
  } finally { await w.dispose(); }
}

async function section1533(): Promise<void> {
  const w = await letterWorkspace('s213r3-kickoff-next-finished-from-record');
  try {
    const c = await chainFixture(w);
    const attemptPage = (id: string, outcome: string) => fs.writeFileSync(path.join(c.hubDir, 'notes', `2026-11-16-${id}-a1.md`), `# ${id} attempt 1\n\n## Handback\n\nOutcome: ${outcome}\nRan: kickoffs/${id} r1\n`);
    // The finished unit's pointer closed away by close-item: only the next pointer is left.
    c.reset();
    c.setNext([c.pointer('n1')]);
    const closed = c.next('42');
    check(closed['decision'] === 'start' && closed['id'] === 'n1' && closed['finished'] === 'f1', '1533: with f1 closed away, the record names f1 and n1 starts: ' + JSON.stringify(closed));
    // An older ticked unit above the queue is not taken as the finished one, even when it would chain.
    c.reset();
    c.kickoff('f0', true);
    attemptPage('f0', 'pushed');
    c.setNext(['- [x] Run f0: [[projects/first/kickoffs/f0]] (r1, done)', c.pointer('n1')]);
    const older = c.next('42');
    check(older['decision'] === 'start' && older['finished'] === 'f1' && older['attempt'] === 'notes/2026-11-17-f1-a1', '1533: the older ticked f0 is not taken as finished: ' + JSON.stringify(older));
    // ...and when the record names f0's attempt page instead, f0 is the finished unit.
    c.closeout('done', [c.attemptWrite('notes/2026-11-16-f0-a1')]);
    const named = c.next('42');
    check(named['decision'] === 'start' && named['finished'] === 'f0', '1533: the record decides which unit finished: ' + JSON.stringify(named));
    // A record with no attempt-page write stops, naming why.
    c.reset();
    c.closeout('done', [{ kind: 'hub', name: 'first', page: '_project', at: Date.now() }]);
    const none = c.next('42');
    check(none['decision'] === 'stop' && /no attempt page/.test(String(none['reason'])), '1533: a record with no attempt-page write stops: ' + JSON.stringify(none));
    // An attempt page on another Hub is not this seat's.
    c.closeout('done', [{ kind: 'hub', name: 'second', page: 'notes/2026-11-17-f1-a1', at: Date.now() }]);
    const elsewhere = c.next('42');
    check(elsewhere['decision'] === 'stop' && /no attempt page/.test(String(elsewhere['reason'])), '1533: an attempt page on another Hub does not count: ' + JSON.stringify(elsewhere));
    // Attempt pages of two units: the newest write names the finished unit, and the earlier one, finished, does not stop
    // it (kickoffs/s213-r5 row 4; this expectation was a stop naming both until then).
    attemptPage('f0', 'pushed');
    c.closeout('done', [c.attemptWrite(), c.attemptWrite('notes/2026-11-16-f0-a1')]);
    const two = c.next('42');
    check(two['decision'] === 'start' && two['finished'] === 'f0' && two['attempt'] === 'notes/2026-11-16-f0-a1', '1533: attempt pages of two units read the newest write: ' + JSON.stringify(two));
    // Two attempts of one unit in one session read the later one.
    c.reset();
    fs.writeFileSync(path.join(c.hubDir, 'notes', '2026-11-17-f1-a2.md'), '# f1 attempt 2\n\n## Handback\n\nOutcome: parked\nRan: kickoffs/f1 r1\n');
    c.closeout('done', [c.attemptWrite(), c.attemptWrite('notes/2026-11-17-f1-a2')]);
    const later = c.next('42');
    check(later['decision'] === 'stop' && /f1-a2/.test(String(later['reason'])) && /Outcome: parked/.test(String(later['reason'])), '1533: the later attempt of one unit is read: ' + JSON.stringify(later));
    fs.rmSync(path.join(c.hubDir, 'notes', '2026-11-17-f1-a2.md'));
    // The finished unit's pointer still pending is no finished unit.
    c.reset();
    c.setNext([c.pointer('f1'), c.pointer('n1')]);
    const pending = c.next('42');
    check(pending['decision'] === 'stop' && /Run f1 is still pending/.test(String(pending['reason'])), '1533: a finished unit whose pointer is still pending stops: ' + JSON.stringify(pending));
  } finally { await w.dispose(); }
}

async function section1534(): Promise<void> {
  const w = await letterWorkspace('s213r3-decisions-prose');
  try {
    makeDevHub(w.ws, 'first');
    const root = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const add = (section: string, content: string) => w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', section, '--content', content, '--json']);
    if (!/^## Decisions/m.test(fs.readFileSync(root, 'utf8'))) {
      equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'add-section', '--section', 'Decisions', '--content', '- 2026-11-17: a short one ([[projects/first/notes/decision]])', '--json']).exit, 0, '1534: a short linked Decisions entry is accepted');
    }
    const head = 'On 2026-11-17 we decided this, in prose and with no link: ';
    const long = head + 'w'.repeat(401 - Buffer.byteLength(head));
    equal(Buffer.byteLength(long), 401, '1534: the paragraph is 401 bytes');
    const before = fs.readFileSync(root, 'utf8');
    const refused = add('Decisions', long);
    check(refused.exit !== 0 && /401 bytes, over 400/.test(refused.stdout + refused.stderr) && /links no record/.test(refused.stdout + refused.stderr), '1534: a 401-byte unlinked paragraph is refused: ' + (refused.stdout + refused.stderr).slice(0, 400));
    equal(fs.readFileSync(root, 'utf8'), before, '1534: the refusal wrote nothing');
    const twoLines = add('Decisions', 'A paragraph over two lines,\nwith no link on either.');
    check(twoLines.exit !== 0 && /links no record/.test(twoLines.stdout + twoLines.stderr), '1534: a short unlinked paragraph of two lines is refused');
    equal(add('Decisions', 'Kept as the record says: [[projects/first/notes/decision-2]].').exit, 0, '1534: a short linked paragraph is accepted');
    // A paragraph inside a fence is not an entry.
    equal(add('Decisions', '```\nan example block with no link\n```').exit, 0, '1534: fenced text is not judged');
    // A paragraph already on the page is left alone: an unrelated edit beside it passes.
    fs.writeFileSync(root, fs.readFileSync(root, 'utf8').replace(/^## Decisions\r?\n/m, `## Decisions\n\n${'An old prose decision, long and with no link: ' + 'z'.repeat(500)}\n`));
    equal(add('Decisions', '- 2026-11-18: another short one ([[projects/first/notes/decision-3]])').exit, 0, '1534: an existing paragraph left as it is is not judged');
    // ## Now and ## Next keep their rule: a paragraph there is not judged as an item.
    equal(add('Next', 'A note paragraph in Next, as tidy lines are.').exit, 0, '1534: a paragraph in ## Next keeps today\'s rule');
  } finally { await w.dispose(); }
}

async function section1535(): Promise<void> {
  const w = await letterWorkspace('s213r4-kickoff-next-stored-closeout');
  try {
    const c = await chainFixture(w);
    const record = () => JSON.parse(fs.readFileSync(c.closeoutFile, 'utf8')) as Record<string, unknown>;
    const rewrite = (change: Record<string, unknown>) => fs.writeFileSync(c.closeoutFile, JSON.stringify({ ...record(), ...change }));
    // Only the stored string "done" with a finite closedOutAt is finished; every other stored value stops, named as stored.
    for (const [label, value, shown] of [
      ['an array ["done"]', ['done'], '["done"]'],
      ['an object {"done": true}', { done: true }, '{"done":true}'],
      ['"done " with a trailing space', 'done ', '"done "'],
      ['"DONE" in capitals', 'DONE', 'DONE'],
    ] as [string, unknown, string][]) {
      c.reset();
      rewrite({ closeout: value });
      check(typeof record()['closedOutAt'] === 'number', `1535 (${label}): the record keeps a finite closedOutAt`);
      const stop = c.next('42');
      check(stop['decision'] === 'stop' && String(stop['reason']).includes(`closeout: ${shown}`), `1535 (${label}): stops naming the stored value ${shown}: ${JSON.stringify(stop)}`);
    }
    c.reset();
    const start = c.next('42');
    check(start['decision'] === 'start' && start['id'] === 'n1', '1535: "done" with a finite closedOutAt still starts n1: ' + JSON.stringify(start));
  } finally { await w.dispose(); }
}

async function section1536(): Promise<void> {
  const w = await letterWorkspace('s213r4-kickoff-next-ran-line');
  try {
    const c = await chainFixture(w);
    // An attempt page is named by its unit (s9-a3); its Handback's Ran: line names the revision it ran (s9-r2).
    const attempt = 'notes/2026-11-17-s9-a3';
    const setUp = (s9Chain: boolean, r2Chain: boolean, ran: string | null) => {
      c.reset();
      c.kickoff('s9', s9Chain); c.kickoff('s9-r2', r2Chain);
      fs.writeFileSync(path.join(c.hubDir, `${attempt}.md`), `# s9-r2 attempt 3\n\n## Run\n\n- State: done.\n\n## Handback\n\nOutcome: pushed\n${ran === null ? '' : `Ran: ${ran} r1, sha256 \`${'a'.repeat(64)}\`; attempt [[projects/first/${attempt}]]\n`}`);
      c.setNext(['- [x] Run s9-r2: [[projects/first/kickoffs/s9-r2]] (r1, done)', c.pointer('n1')]);
      c.closeout('done', [c.attemptWrite(attempt)]);
    };
    setUp(true, false, 'kickoffs/s9-r2');
    const r2No = c.next('42');
    check(r2No['decision'] === 'stop' && /kickoffs\/s9-r2 does not say CHAIN: yes/.test(String(r2No['reason'])), '1536: CHAIN is read from the Kickoff the Handback ran (s9-r2 says no), not from the attempt page\'s unit (s9): ' + JSON.stringify(r2No));
    setUp(false, true, 'kickoffs/s9-r2');
    const r2Yes = c.next('42');
    check(r2Yes['decision'] === 'start' && r2Yes['id'] === 'n1' && r2Yes['finished'] === 's9-r2', '1536: the two CHAIN lines swapped, s9-r2 chains and n1 starts: ' + JSON.stringify(r2Yes));
    setUp(true, true, null);
    const noRan = c.next('42');
    check(noRan['decision'] === 'stop' && /no ## Handback with a Ran: kickoffs\/<id> line/.test(String(noRan['reason'])), '1536: a Handback with no Ran: line stops naming why: ' + JSON.stringify(noRan));
    setUp(true, true, 'kickoffs/s8-r2');
    const otherUnit = c.next('42');
    check(otherUnit['decision'] === 'stop' && /Ran: kickoffs\/s8-r2/.test(String(otherUnit['reason'])) && /unit s9/.test(String(otherUnit['reason'])), '1536: Ran: kickoffs/s8-r2 on an s9 attempt stops naming both units: ' + JSON.stringify(otherUnit));
    // The Kickoff the Handback ran still pending in ## Next is not finished.
    setUp(true, true, 'kickoffs/s9-r2');
    c.setNext([c.pointer('s9-r2'), c.pointer('n1')]);
    const pending = c.next('42');
    check(pending['decision'] === 'stop' && /Run s9-r2 is still pending/.test(String(pending['reason'])), '1536: the ran Kickoff\'s pointer still pending stops: ' + JSON.stringify(pending));
  } finally { await w.dispose(); }
}

async function section1537(): Promise<void> {
  const w = await letterWorkspace('s213r4-kickoff-next-pointer-order');
  try {
    const c = await chainFixture(w);
    const ticked = (id: string) => `- [x] Run ${id}: [[projects/first/kickoffs/${id}]] (r1, done)`;
    const attemptPage = (name: string, outcome: string) => fs.writeFileSync(path.join(c.hubDir, 'notes', `${name}.md`), `# s9 attempt

## Handback

Outcome: ${outcome}
Ran: kickoffs/s9-r2 r1
`);
    const setUp = (next: () => string[]) => {
      c.reset();
      c.kickoff('s8', true); c.kickoff('s9-r2', true); c.kickoff('s10', true);
      attemptPage('2026-11-17-s9-a1', 'pushed');
      // An older attempt of the same unit, with a higher number: the newest by date, then number, is read.
      attemptPage('2026-11-16-s9-a2', 'parked');
      c.setNext(next());
      c.closeout('done', []);
    };
    // A record with no writes at all, one ticked pointer, then one pending: pointer order names s9.
    setUp(() => [ticked('s9-r2'), c.pointer('s10')]);
    const one = c.next('42');
    check(one['decision'] === 'start' && one['id'] === 's10' && one['finished'] === 's9-r2' && one['attempt'] === 'notes/2026-11-17-s9-a1', '1537: writes: [] with one ticked Run s9-r2 before the pending Run s10 starts s10: ' + JSON.stringify(one));
    setUp(() => [ticked('s8'), ticked('s9-r2'), c.pointer('s10')]);
    const two = c.next('42');
    check(two['decision'] === 'stop' && /no attempt page/.test(String(two['reason'])) && /2 ticked Run pointers/.test(String(two['reason'])), '1537: two ticked pointers before the pending one stop: ' + JSON.stringify(two));
    setUp(() => [c.pointer('s10')]);
    const none = c.next('42');
    check(none['decision'] === 'stop' && /0 ticked Run pointers/.test(String(none['reason'])), '1537: no ticked pointer stops: ' + JSON.stringify(none));
    // The fallback never overrides a record that tracked writes: a Hub write that is no attempt page still stops.
    setUp(() => [ticked('s9-r2'), c.pointer('s10')]);
    c.closeout('done', [{ kind: 'hub', name: 'first', page: '_project', at: Date.now() }]);
    const tracked = c.next('42');
    check(tracked['decision'] === 'stop' && /no attempt page/.test(String(tracked['reason'])), '1537: a record with writes but no attempt page still stops: ' + JSON.stringify(tracked));
    // Pointer order naming a unit with no attempt page on the Hub stops.
    setUp(() => [ticked('s8'), c.pointer('s10')]);
    const missing = c.next('42');
    check(missing['decision'] === 'stop' && /holds no attempt page notes\/<date>-s8-a<n>/.test(String(missing['reason'])), '1537: a pointer unit with no attempt page stops: ' + JSON.stringify(missing));
  } finally { await w.dispose(); }
}

async function section1538(): Promise<void> {
  // c161-r3 row 9's seed line, and a comment over three lines: neither hides a pointer, adds one, or ends ## Next early.
  const forms: [string, string[]][] = [
    ['one-line comment', ['<!-- Add the next action this project can complete. -->']],
    ['three-line comment', ['<!--', 'Add the next action this project can complete.', '-->']],
  ];
  for (const [label, comment] of forms) {
    const w = await letterWorkspace('s213r4-next-comment');
    try {
      const hub = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
      const underNext = (lines: string[]) => {
        const text = fs.readFileSync(hub, 'utf8');
        const at = text.search(/^## Next[ \t]*\r?\n/m);
        const after = text.indexOf('\n', at) + 1;
        fs.writeFileSync(hub, `${text.slice(0, after)}${lines.join('\n')}\n${text.slice(after)}`);
      };
      const append = (line: string) => w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', line, '--json']);
      // (a) as 734 (a): a comment directly under ## Next, a fenced example, and the comment again last, as c161-r3 row 9's
      // seed left it; one real pointer, then a second is refused (a Hub holding one). The append must not land in the fence.
      // c161-r3 row 9's seed had no item in ## Next, only its comment: the placeholder item goes, so no real list line follows the fence.
      fs.writeFileSync(hub, fs.readFileSync(hub, 'utf8').replace(/^- \[ \] Add the next useful action\.\r?\n/m, ''));
      underNext([...comment, '', 'An example:', '', '```', '- [ ] Run a2: [[projects/first/kickoffs/a2]] (shown, not pending)', '```', '', ...comment, '']);
      check(!/Add the next useful action/.test(fs.readFileSync(hub, 'utf8')), `1538 (${label}): the fixture's ## Next holds no placeholder item`);
      equal(append(runPointer('first', 'a1', ' (the real one)')).exit, 0, `1538 (${label}): the first real pointer beside the comment is accepted`);
      const before = fs.readFileSync(hub, 'utf8');
      const second = append(runPointer('first', 'a3', ' (a second real one)'));
      check(second.exit !== 0 && (second.stdout + second.stderr).includes('this edit would leave 2:'), `1538 (${label}): a second real pointer is refused counting 2: ${second.exit} ${(second.stdout + second.stderr).slice(0, 400)}`);
      equal(fs.readFileSync(hub, 'utf8'), before, `1538 (${label}): the refused pointer wrote nothing`);
      // A Run line inside a comment is no pointer: the Hub with one real pointer and one commented Run line takes an edit
      // that adds no pointer, and a pending count names only the real one.
      underNext(['<!--', '- [ ] Run a2: [[projects/first/kickoffs/a2]] (inside a comment)', '-->', '']);
      equal(append('- [ ] Read the log.').exit, 0, `1538 (${label}): an edit beside a commented Run line is accepted`);
      const third = append(runPointer('first', 'a4'));
      check(third.exit !== 0 && (third.stdout + third.stderr).includes('this edit would leave 2:') && !(third.stdout + third.stderr).includes('Run a2'), `1538 (${label}): the commented Run a2 is not counted: ${(third.stdout + third.stderr).slice(0, 400)}`);
      // (b) as 734 (b): kickoff receive beside a comment finishes every stage, with exactly one real pointer.
      equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Next', '--match-text', 'Run a1:', '--json']).exit, 0, `1538 (${label}): Run a1 is ticked`);
      const { letter } = await fileKickoffLetter(w, 'k1', kickoffText('k1'));
      const ran = w.cli(0, ['kickoff', 'receive', letter, '--json']);
      check(ran.exit === 0 && w.json(ran)['status'] === 'received', `1538 (${label}): receive beside a comment refused: ${(ran.stdout + ran.stderr).slice(0, 400)}`);
      const record = path.join(w.ws, 'internal', 'kickoffs', 'k1.json');
      const stages = fs.existsSync(record) ? (JSON.parse(fs.readFileSync(record, 'utf8')) as { stages: { name: string; state: string }[] }).stages.map(s => `${s.name}:${s.state}`).join(',') : 'no record';
      equal(stages, 'page:done,pointer:done,close:done', `1538 (${label}): the receive finished every stage`);
      equal(fs.readFileSync(hub, 'utf8').split(/\r?\n/).filter(line => /^- \[ \] Run k1:/.test(line)).length, 1, `1538 (${label}): exactly one real k1 pointer`);
    } finally { await w.dispose(); }
  }
}

async function section1540(): Promise<void> {
  // kickoffs/s213-r5 row 2: one reading of ## Next. Each body runs through kickoff next's reading, hub edit's pointer count,
  // kickoff receive's pointer stage, hub status's Run queue (kickoffs/s213-r6 row 1), and hub tidy's and close-item's item
  // reading (kickoffs/s214 row 3), and every reader must see the same
  // pointers: the real ones (@REAL), never a hidden one (`(hidden)`, named @ID so that it would collide with the real
  // pointer if it were read).
  const { nextSectionLines } = await import('../../src/hubedit.ts');
  const hidden = '- [ ] Run @ID: [[projects/@HUB/kickoffs/@ID]] (hidden)';
  const cases: { label: string; body: string[]; receivable: boolean }[] = [
    { label: 'a ## heading inside a comment', body: ['<!--', '## Earlier', 'An old note.', '-->', '', '@REAL'], receivable: true },
    { label: 'a fence marker inside a comment', body: ['<!--', '```', '-->', '', '@REAL'], receivable: true },
    { label: 'a comment opened after text on its line', body: ['Explanation <!--', hidden, '-->', '', '@REAL'], receivable: true },
    { label: 'a comment marker inside a fence', body: ['```', '<!--', hidden, '```', '', '@REAL'], receivable: true },
    { label: 'a ~~~ fence', body: ['~~~', hidden, '~~~', '', '@REAL'], receivable: true },
    { label: 'a four-backtick fence holding a three-backtick line', body: ['````', '```', hidden, '```', '````', '', '@REAL'], receivable: true },
    // An append to a section ending inside an unclosed fence has no shown place to land (row 3), so receive cannot finish.
    { label: 'an unclosed fence at the section end', body: ['@REAL', '', '```', hidden], receivable: false },
    { label: 'a one-line comment beside a real pointer', body: ['<!-- The next action this project can complete. -->', '@REAL', `<!-- ${hidden} -->`], receivable: true },
  ];
  const fill = (body: string[], real: string[], id: string, hub: string) =>
    body.flatMap(line => line === '@REAL' ? real : [line.replace(/@ID/g, id).replace(/@HUB/g, hub)]);
  const pendingIds = (lines: string[]) => lines.map(line => /^\s*- \[ \] Run ([A-Za-z0-9._-]+):/.exec(line)?.[1]).filter((id): id is string => id !== undefined);
  // hub status's Run queue of the chain Hub, from its --json lines (group `queue`, `<n>. Run <id>`), and the same ids
  // read from its terminal text, which must agree.
  const statusQueue = async (w: Awaited<ReturnType<typeof letterWorkspace>>): Promise<string[]> => {
    const status = await hubStatusOf(w, 0, 'first');
    equal(status.exit, 0, '1540: hub status runs: ' + status.text.slice(0, 300));
    const ids = status.lines.filter(line => line.group === 'queue').map(line => /^\d+\. Run ([A-Za-z0-9._-]+)/.exec(line.text)?.[1] ?? `unreadable: ${line.text}`);
    const printed = [...status.text.matchAll(/^\s*\d+\. Run ([A-Za-z0-9._-]+)/gm)].map(match => match[1]!);
    same(printed, ids, '1540: hub status prints the Run queue its --json lines hold');
    return ids;
  };
  for (const { label, body, receivable } of cases) {
    const w = await letterWorkspace('s213r5-one-next');
    try {
      const c = await chainFixture(w);
      // 1. kickoff next's reading: f1 ticked, n1 the first pending pointer.
      c.reset();
      c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', ...fill(body, [c.pointer('n1')], 'n1', 'first')]);
      same(pendingIds(nextSectionLines(fs.readFileSync(path.join(c.hubDir, '_project.md'), 'utf8'))), ['n1'], `1540 (${label}): hub edit's reading of the chain Hub`);
      const next = c.next('10');
      check(next['decision'] === 'start' && next['id'] === 'n1', `1540 (${label}): kickoff next reads n1 as the next pointer: ${JSON.stringify(next).slice(0, 400)}`);
      // kickoffs/s213-r6 row 1: hub status's Run queue is one more reader, and names exactly the pointers the others see.
      same(await statusQueue(w), ['n1'], `1540 (${label}): hub status's Run queue of the chain Hub`);
      // kickoffs/s214 row 3: hub tidy's item reading is one more reader. The hidden line is ticked here (h1), so a tidy that
      // read it would move it; it must move exactly the real ticked f1, and close-item must find no hidden h1 to close.
      c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', ...fill(body, [c.pointer('n1')], 'h1', 'first').map(line => line.replace('- [ ] Run h1:', '- [x] Run h1:'))]);
      const tidy = w.cli(0, ['hub', 'tidy', 'first', '--preflight', '--json']);
      let tidied: Record<string, unknown> = {};
      try { tidied = JSON.parse(tidy.stdout); } catch { tidied = {}; }
      const moved = Array.isArray(tidied['moved']) ? (tidied['moved'] as { label?: string }[]).map(item => /Run ([A-Za-z0-9._-]+):/.exec(String(item.label))?.[1] ?? String(item.label)) : [`unreadable: ${(tidy.stdout + tidy.stderr).slice(0, 300)}`];
      same(moved, ['f1'], `1540 (${label}): hub tidy moves exactly the shown ticked item`);
      const closeHidden = w.cli(0, ['hub', 'edit', 'first', '--mode', 'close-item', '--match-text', 'Run h1:', '--preflight', '--json']);
      check(closeHidden.exit !== 0 && (closeHidden.stdout + closeHidden.stderr).includes('No top-level item'), `1540 (${label}): close-item finds no hidden item to close: ${closeHidden.exit} ${(closeHidden.stdout + closeHidden.stderr).slice(0, 300)}`);
      // 2. hub edit's pointer count on a Hub that holds one: unticking b1 would leave exactly a1 and b1 pending.
      const second = path.join(w.ws, 'collection', 'projects', 'second', '_project.md');
      const real = [runPointer('second', 'a1'), '- [x] Run b1: [[projects/second/kickoffs/b1]] (done)'];
      fs.writeFileSync(second, fs.readFileSync(second, 'utf8').replace(/^## Next[ \t]*\r?\n/m, `## Next\n\n${fill(body, real, 'a1', 'second').join('\n')}\n`));
      same(pendingIds(nextSectionLines(fs.readFileSync(second, 'utf8'))), ['a1'], `1540 (${label}): hub edit's reading of the one-pointer Hub`);
      const before = fs.readFileSync(second, 'utf8');
      const untick = w.cli(1, ['hub', 'edit', 'second', '--mode', 'check-item', '--uncheck', '--section', 'Next', '--match-text', 'Run b1:', '--json']);
      const said = /this edit would leave (\d+): (.*?)\. Tick/.exec(untick.stdout + untick.stderr);
      check(untick.exit !== 0 && said !== null, `1540 (${label}): unticking b1 beside a1 is refused: ${untick.exit} ${(untick.stdout + untick.stderr).slice(0, 400)}`);
      same(said === null ? [] : pendingIds(said[2]!.split(' | ')), ['a1', 'b1'], `1540 (${label}): hub edit counts exactly a1 and b1`);
      equal(fs.readFileSync(second, 'utf8'), before, `1540 (${label}): the refused edit wrote nothing`);
      // 3. kickoff receive's pointer stage: the hidden line names k1's own link, and must not count as its pointer.
      c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', ...fill(body, [c.pointer('n1')], 'k1', 'first')]);
      const { letter } = await fileKickoffLetter(w, 'k1', kickoffText('k1'));
      const ran = w.cli(0, ['kickoff', 'receive', letter, '--json']);
      const received = ran.exit === 0 && w.json(ran)['status'] === 'received';
      equal(received, receivable, `1540 (${label}): receive ${receivable ? 'finishes' : 'cannot finish'}: ${(ran.stdout + ran.stderr).slice(0, 400)}`);
      same(pendingIds(nextSectionLines(fs.readFileSync(path.join(c.hubDir, '_project.md'), 'utf8'))), receivable ? ['n1', 'k1'] : ['n1'], `1540 (${label}): the pointers every reader sees after receive`);
      same(await statusQueue(w), receivable ? ['n1', 'k1'] : ['n1'], `1540 (${label}): hub status's Run queue after receive`);
    } finally { await w.dispose(); }
  }
}

async function section1541(): Promise<void> {
  // kickoffs/s213-r5 row 3: an appended pointer lands on a shown line right after the last item's last line, or the
  // append is refused when ## Next ends inside a fence that is never closed.
  const { nextSectionLines } = await import('../../src/hubedit.ts');
  const w = await letterWorkspace('s213r5-append-point');
  try {
    const hub = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const original = fs.readFileSync(hub, 'utf8');
    const setNext = (lines: string[]) => fs.writeFileSync(hub, original.replace(/^## Next[ \t]*\r?\n[\s\S]*$/m, `## Next\n\n${lines.join('\n')}\n\n## Later\n\nLater text.\n`));
    const pointer = runPointer('first', 'a9', ' (appended)');
    const append = () => w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', pointer, '--json']);
    const cases: [string, string[], string][] = [
      ['a fenced example with a blank line inside the last item, prose after',
        ['- [x] Run a1: [[projects/first/kickoffs/a1]] (done)', '  ```', '  example line', '', '  more example', '  ```', '', 'Some prose after the list.'], '  ```'],
      ['an ordinary item with an indented continuation line, prose after',
        ['- [x] Run a1: [[projects/first/kickoffs/a1]] (done)', '  continued on a second line', '', 'Some prose after the list.'], '  continued on a second line'],
    ];
    for (const [label, body, lastLine] of cases) {
      setNext(body);
      const ran = append();
      equal(ran.exit, 0, `1541 (${label}): the append is accepted: ${(ran.stdout + ran.stderr).slice(0, 300)}`);
      const lines = fs.readFileSync(hub, 'utf8').split(/\r?\n/);
      const at = lines.indexOf(pointer);
      check(at > 0 && lines[at - 1] === lastLine, `1541 (${label}): the pointer follows the item's last line '${lastLine}': ${JSON.stringify(lines.slice(Math.max(0, at - 3), at + 3))}`);
      check(lines.indexOf('Some prose after the list.') > at, `1541 (${label}): the pointer lands before the prose`);
      check(nextSectionLines(fs.readFileSync(hub, 'utf8')).includes(pointer), `1541 (${label}): the pointer is on a shown line`);
    }
    // A ## Next holding only an unclosed fence: no shown place to append, so it is refused, naming the fence and the remedy.
    setNext(['```', '- [ ] Run x1: [[projects/first/kickoffs/x1]] (shown as an example)']);
    const before = fs.readFileSync(hub, 'utf8');
    const refused = append();
    const said = refused.stdout + refused.stderr;
    check(refused.exit !== 0 && said.includes('ends inside a fence that is never closed') && said.includes("opened by '```'") && said.includes('Close the fence'),
      `1541 (an unclosed fence): the append is refused naming the fence and closing it as the remedy: ${refused.exit} ${said.slice(0, 400)}`);
    equal(fs.readFileSync(hub, 'utf8'), before, '1541 (an unclosed fence): nothing was written');
    const preflight = w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', pointer, '--preflight', '--json']);
    check(preflight.exit !== 0 && (preflight.stdout + preflight.stderr).includes('never closed'), `1541 (an unclosed fence): --preflight refuses too: ${preflight.exit}`);
  } finally { await w.dispose(); }
}

async function section1542(): Promise<void> {
  // kickoffs/s213-r5 row 4: a session that already chained (f1 finished, n1 started and finished) chains again, to n2.
  const w = await letterWorkspace('s213r5-chain-twice');
  try {
    const c = await chainFixture(w);
    const n1Attempt = path.join(c.hubDir, 'notes', '2026-11-17-n1-a1.md');
    const chained = () => {
      c.reset();
      c.kickoff('n2', true);
      c.setNext(['- [x] Run f1: [[projects/first/kickoffs/f1]] (r1, done)', '- [x] Run n1: [[projects/first/kickoffs/n1]] (r1, done)', c.pointer('n2')]);
      fs.writeFileSync(n1Attempt, '# n1 attempt 1\n\n## Run\n\n- State: done.\n\n## Handback\n\nOutcome: pushed\nRan: kickoffs/n1 r1\n');
      c.closeout('done', [c.attemptWrite(), c.attemptWrite('notes/2026-11-17-n1-a1')]);
    };
    chained();
    const again = c.next('10');
    check(again['decision'] === 'start' && again['id'] === 'n2' && again['finished'] === 'n1' && again['attempt'] === 'notes/2026-11-17-n1-a1',
      '1542: after f1 and n1, both handed back, kickoff next starts n2: ' + JSON.stringify(again));
    // The earlier attempt page left without an Outcome: that unit was left unfinished, so the chain stops, naming it.
    chained();
    fs.writeFileSync(path.join(c.hubDir, 'notes', '2026-11-17-f1-a1.md'), '# f1 attempt 1\n\n## Run\n\n- State: started.\n');
    const unfinished = c.next('10');
    check(unfinished['decision'] === 'stop' && /2026-11-17-f1-a1/.test(String(unfinished['reason'])) && /no Outcome: line/.test(String(unfinished['reason'])),
      '1542: an earlier attempt with no Handback Outcome stops, naming it: ' + JSON.stringify(unfinished));
    // A record with only f1 behaves as before: n1 starts.
    fs.rmSync(n1Attempt);
    c.reset();
    const single = c.next('10');
    check(single['decision'] === 'start' && single['id'] === 'n1' && single['finished'] === 'f1', '1542: a record with only f1 starts n1 as before: ' + JSON.stringify(single));
  } finally { await w.dispose(); }
}

async function section1520(): Promise<void> {
  // kickoffs/s213 row 27 (s213-r5 row 5): read_open_project_briefing returns today's briefing, then hub status for the Hub.
  const w = await letterWorkspace('s213r5-briefing-status');
  try {
    equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', runPointer('first', 'q1'), '--json']).exit, 0, '1520: a pointer is queued');
    const briefing = () => {
      const ran = w.cli(0, ['mcp', 'call', 'read_open_project_briefing', '--slug', 'first', '--seat', 'first']);
      let text = '';
      try { text = String((JSON.parse(ran.stdout) as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? ''); } catch { text = ''; }
      return { exit: ran.exit, stdout: text, stderr: ran.stderr + (text ? '' : ran.stdout) };
    };
    const today = 'These are recorded project connections only; no additional Books were opened automatically.';
    const open = briefing();
    const text = open.stdout;
    check(open.exit === 0 && text.startsWith('Project return briefing - first') && text.includes(today), `1520: today's briefing comes first: ${open.exit} ${(text + open.stderr).slice(0, 400)}`);
    const live = text.indexOf('projects/first: live state, read now');
    check(live > text.indexOf(today), `1520: the live state follows the briefing under its own heading: ${text.slice(0, 600)}`);
    check(text.includes('Run queue') && text.includes('1. Run q1 (the one to open)'), `1520: the status lines are there (the queue): ${text.slice(live, live + 600)}`);
    check(/Letters\n {2}\d+ open for first/.test(text), `1520: with letters open, the letters line has no closed note: ${text.slice(live, live + 800)}`);
    // The Desk limits are hub status's own: with the letters Book closed, a count only, saying so.
    equal(w.cli(0, ['desk', 'close', 'book', 'letters', '--seat', 'first']).exit, 0, '1520: the letters Book closes');
    const closed = briefing().stdout;
    check(closed.includes('letters: closed on this Desk;') && closed.startsWith('Project return briefing - first'), `1520: a closed letters Book reads as a count and says so: ${closed.slice(closed.indexOf('live state'), closed.indexOf('live state') + 800)}`);
    // A failing part of the status: the train register cannot be read. The briefing still returns, the part names why.
    fs.mkdirSync(path.join(w.ws, 'internal', 'train'), { recursive: true });
    fs.writeFileSync(path.join(w.ws, 'internal', 'train', 'register.json'), 'not a register');
    const failing = briefing();
    check(failing.exit === 0 && failing.stdout.startsWith('Project return briefing - first') && failing.stdout.includes(today), `1520: a failing status part still returns the briefing: ${failing.exit} ${(failing.stdout + failing.stderr).slice(0, 400)}`);
    check(failing.stdout.includes('train: unreadable:') && failing.stdout.includes('1. Run q1 (the one to open)'), `1520: the failing part is one line, and the rest still shows: ${failing.stdout.slice(failing.stdout.indexOf('live state'), failing.stdout.indexOf('live state') + 800)}`);
  } finally { await w.dispose(); }
}

async function section1521(): Promise<void> {
  // kickoffs/s213 row 28 (s213-r5 row 6): a catalog of 26 active Hubs is ranked whole, and at most five come back.
  const w = await letterWorkspace('s213r5-catalog-ceiling');
  try {
    for (let n = 1; n <= 24; n++) equal(w.cli(0, ['hub', 'new', `garden-${n}`, '--title', `Garden ${n}`, '--purpose', `Keep garden plot ${n} weeded.`, '--json']).exit, 0, `1521: Hub garden-${n} is made`);
    const catalog = fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'README.md'), 'utf8');
    const entries = (catalog.match(/^\s*-\s+\[\[projects\/[a-z0-9-]+\/_project\|[^\]]+\]\]\s*$/gm) ?? []).length;
    check(entries >= 26, `1521: the active catalog lists 26 entries or more: ${entries}`);
    const ran = w.cli(0, ['mcp', 'call', 'suggest_active_projects', '--query', 'garden', '--seat', 'first']);
    let text = '';
    try { text = String((JSON.parse(ran.stdout) as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? ''); } catch { text = ''; }
    check(ran.exit === 0 && text.startsWith('# Active Project suggestions') && !/more than 25/.test(ran.stdout + ran.stderr), `1521: 26 entries are ranked, not refused: ${ran.exit} ${(ran.stdout + ran.stderr).slice(0, 400)}`);
    const shown = text.split('\n').filter(line => /^- Garden \d+ \[garden-\d+\]: matched garden\.$/.test(line)).length;
    equal(shown, 5, `1521: at most five suggestions come back: ${text.slice(0, 600)}`);
  } finally { await w.dispose(); }
}

async function section1539(): Promise<void> {
  // hub-template-placeholders (s213-r5 row 8): a new Hub starts with no placeholder text to remove, the same from local
  // hub new and from New-ProjectHub.ps1, and its first real Next action is the only pointer every reader sees.
  const { nextSectionLines, removeFrontmatter } = await import('../../src/hubedit.ts');
  const placeholders = ['Replace this line.', 'Add the next useful action.', 'Describe what this project is for.'];
  const w = await letterWorkspace('s213r5-no-placeholders');
  try {
    for (const dev of [false, true]) {
      const slug = dev ? 'fresh-dev' : 'fresh';
      equal(w.cli(0, ['hub', 'new', slug, '--title', 'Fresh', ...(dev ? ['--dev'] : []), '--json']).exit, 0, `1539 (dev ${dev}): hub new makes the Hub`);
      const local = removeFrontmatter(fs.readFileSync(path.join(w.ws, 'collection', 'projects', slug, '_project.md'), 'utf8').replace(/^﻿/, '')).replace(/\r\n/g, '\n');
      for (const text of placeholders) check(!local.includes(text), `1539 (dev ${dev}): hub new's Hub holds no '${text}'`);
      check(/^## Next\n\n<!-- [^\n]+ -->\n/m.test(local) && /^## Purpose\n\n<!-- [^\n]+ -->\n/m.test(local), `1539 (dev ${dev}): the empty Purpose and Next keep their guidance as a comment: ${local.slice(0, 400)}`);
      check(local.includes('Orientation and open items only.') && local.includes('remove a pointer when its decision is superseded') === dev, `1539 (dev ${dev}): the guidance text stays`);
      // The byte-for-byte comparison with New-ProjectHub.ps1's body, run through PowerShell, retired (kickoffs/s225).
    }
    // Explicit purpose and actions are kept as given.
    equal(w.cli(0, ['hub', 'new', 'given', '--title', 'Given', '--purpose', 'Grow beans.', '--next-action', 'Plant the beans.', '--json']).exit, 0, '1539: hub new with a purpose and an action');
    const given = fs.readFileSync(path.join(w.ws, 'collection', 'projects', 'given', '_project.md'), 'utf8');
    check(/^## Purpose\r?\n\r?\nGrow beans\.\r?\n/m.test(given) && /^## Next\r?\n\r?\n- \[ \] Plant the beans\.\r?\n/m.test(given), `1539: the given purpose and action are kept: ${given.slice(0, 500)}`);
    // The fixture's own Hub was made by hub new: its first real action is the only pointer hub edit and receive see.
    const hub = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    for (const text of placeholders) check(!fs.readFileSync(hub, 'utf8').includes(text), `1539: the fixture Hub holds no '${text}'`);
    equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', runPointer('first', 'a1'), '--json']).exit, 0, '1539: the first real pointer is accepted');
    same(nextSectionLines(fs.readFileSync(hub, 'utf8')).filter(line => /^- \[[ xX]\] /.test(line)), [runPointer('first', 'a1')], '1539: the first real pointer is the only item in Next');
    const second = w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--content', runPointer('first', 'a2'), '--json']);
    check(second.exit !== 0 && (second.stdout + second.stderr).includes(`this edit would leave 2: ${runPointer('first', 'a1')} | ${runPointer('first', 'a2')}.`), `1539: hub edit counts exactly a1 and the new a2: ${(second.stdout + second.stderr).slice(0, 400)}`);
    equal(w.cli(0, ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Next', '--match-text', 'Run a1:', '--json']).exit, 0, '1539: Run a1 is ticked');
    const { letter } = await fileKickoffLetter(w, 'k1', kickoffText('k1'));
    const ran = w.cli(0, ['kickoff', 'receive', letter, '--json']);
    check(ran.exit === 0 && w.json(ran)['status'] === 'received', `1539: receive on a fresh Hub finishes: ${(ran.stdout + ran.stderr).slice(0, 400)}`);
    same(nextSectionLines(fs.readFileSync(hub, 'utf8')).filter(line => /^- \[ \] /.test(line)).map(line => /Run ([^:]+):/.exec(line)?.[1]), ['k1'], '1539: the received k1 is the only pending pointer');
  } finally { await w.dispose(); }
}

async function section1522(): Promise<void> {
  // kickoffs/s213 row 29 (s213-r5 row 7): both Now seeds say a dev Hub's items are pointers, byte for byte the same.
  const { projectRootBody } = await import('../../src/collection.ts');
  const sentence = 'On a dev Hub each item is a short pointer to its record; `hub status` shows the live state.';
  for (const dev of [false, true]) {
    const input = { title: 'Seed Check', purpose: 'Compare the seeds.', actions: ['Take the next step.'], dev };
    const kernel = projectRootBody(input.title, input.purpose, input.actions, dev);
    const nowOf = (body: string) => /^## Now\n\n([\s\S]*?)\n\n## Next$/m.exec(body)?.[1] ?? '';
    check(nowOf(kernel).includes(sentence), `1522 (dev ${dev}): the kernel's Now seed holds the sentence: ${nowOf(kernel).slice(-200)}`);
  }
  // The comparison with New-ProjectHub.ps1's body, run through PowerShell, retired (kickoffs/s225): the script's own
  // source still says it, with PowerShell's doubled backticks.
  const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'tools', 'New-ProjectHub.ps1'), 'utf8');
  check(source.includes(sentence.replace(/`/g, '``')), '1522: tools/New-ProjectHub.ps1 holds the sentence in its $nowSeed');
}

async function section1543(): Promise<void> {
  // kickoffs/s213-r6 row 2: the dev seed's Decisions template line is a comment, as every placeholder a reader must remove
  // is (s213-r5 row 8), and New-ProjectHub.ps1's Decisions seed is byte for byte the kernel's.
  const { projectRootBody } = await import('../../src/collection.ts');
  const { shownText, toLines } = await import('../../src/hubedit.ts');
  const template = '- **<date> -- <what was decided>.** <where its record lives>';
  const decisionsOf = (body: string) => /^## Decisions\n\n([\s\S]*)$/m.exec(body)?.[1] ?? '';
  const input = { title: 'Seed Check', purpose: 'Compare the seeds.', actions: ['Take the next step.'], dev: true };
  const kernel = projectRootBody(input.title, input.purpose, input.actions, true);
  const decisions = decisionsOf(kernel);
  check(decisions.includes('Settled ground, as one-line pointers.'), '1543: the kernel\'s dev seed has its ## Decisions: ' + kernel.slice(-300));
  const shown = shownText(toLines(decisions)).filter((line): line is string => line !== null);
  check(!shown.some(line => line.startsWith('- **<')), '1543: no shown line of the seed\'s ## Decisions is a template item: ' + JSON.stringify(shown));
  check(decisions.includes(`<!-- ${template} -->`), '1543: the template line is kept as a comment: ' + decisions.slice(0, 300));
  check(shown.some(line => line.startsWith('Pointers only:')), '1543: the guidance text stays shown');
  // The comparison with New-ProjectHub.ps1's body, run through PowerShell, retired (kickoffs/s225): the script's own
  // source holds the commented line.
  const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'tools', 'New-ProjectHub.ps1'), 'utf8');
  check(source.includes(`"<!-- ${template} -->\`n\`n"`), '1543: tools/New-ProjectHub.ps1 holds the commented line in its $decisionsSeed');
}

async function section1544(): Promise<void> {
  // kickoffs/s214 row 1: a Claude Code builder has no checkpoint hook (only Codex registers one, ADR 0079), so it records
  // its closeout by command, and kickoff next must then answer start. The builder does by hand what Codex's hook does:
  // each Hub write's answer goes to `checkpoint observe` as one tool result, then `checkpoint request closeout --harness
  // claude`, then `checkpoint check closeout` with the answer's ```closeout block on standard input.
  const { seatClaimField } = await import('../../src/seatclaim.ts');
  const w = await letterWorkspace('s214-claude-closeout');
  try {
    const c = await chainFixture(w);
    c.reset();
    fs.rmSync(c.closeoutFile, { force: true });
    fs.rmSync(path.join(c.hubDir, 'notes', '2026-11-17-f1-a1.md'), { force: true });
    const session = '14000000-0000-4000-8000-000000000001';
    const home = path.join(w.root, 'home');
    const token = seatClaimField(path.join(w.ws, '.claude'), 'first', 'token') ?? '';
    check(token !== '', '1544: the fixture seat holds a claim token, as a launched seat does');
    // The builder's own environment: the launcher hands it the claim token, so no agent id is needed.
    const builder = (args: string[], input?: string) => runCli([...args, '--seat', 'first', '--workspace', w.ws], { cwd: w.root,
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home, LIBRARY_WORKSPACE: '',
        LIBRARY_WORKSPACES: path.join(w.root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: token, DESKPOST_ASSISTANT: 'claude',
        CLAUDE_CODE_SESSION_ID: session, CODEX_THREAD_ID: session,
        CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' },
      ...(input === undefined ? {} : { input }) });
    // The attempt page, written with a real Hub write whose answer the builder then hands to observe.
    const body = path.join(w.root, 'a1.md');
    fs.writeFileSync(body, '# f1 attempt 1\n\n## Run\n\n- State: done.\n\n## Handback\n\nOutcome: pushed\nRan: kickoffs/f1 r1\n');
    const write = ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'notes/2026-11-17-f1-a1', '--content-path', body, '--json'];
    const written = builder(write);
    equal(written.exit, 0, '1544: the attempt page is written: ' + written.stderr);
    const observed = builder(['checkpoint', 'observe', '--conversation', session],
      JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_1544_a1', session_id: session, tool_input: { command: `deskpost ${write.join(' ')}` }, tool_response: { stdout: written.stdout } }));
    equal(observed.exit, 0, '1544: checkpoint observe takes the write: ' + observed.stderr);
    const requested = builder(['checkpoint', 'request', 'closeout', '--conversation', session, '--harness', 'claude']);
    equal(requested.exit, 0, '1544: checkpoint request closeout --harness claude runs: ' + requested.stderr);
    let prompt = '';
    try { prompt = String(JSON.parse(requested.stdout)['prompt'] ?? ''); } catch { prompt = ''; }
    check(prompt.startsWith('Closeout before /clear.') && prompt.includes('```closeout'), '1544: the request gives the closeout steps and block: ' + prompt.slice(0, 200));
    const answer = ['Closeout done.', '```closeout', 'reports: none: no Library command failed', 'book letters: nothing new: read only',
      'hub first: updated notes/2026-11-17-f1-a1', '```', ''].join('\n');
    const checked = builder(['checkpoint', 'check', 'closeout', '--conversation', session], answer);
    equal(checked.exit, 0, '1544: checkpoint check closeout runs: ' + checked.stderr);
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(checked.stdout); } catch { state = {}; }
    check(state['closeout'] === 'done' && typeof state['closedOutAt'] === 'number', '1544: the closeout is recorded done: ' + JSON.stringify({ closeout: state['closeout'], gaps: state['gaps'] }));
    const answered = c.next('30');
    check(answered['decision'] === 'start' && answered['id'] === 'n1' && answered['finished'] === 'f1', '1544: kickoff next answers start with n1: ' + JSON.stringify(answered));
    // The program records its own writer, so removing checkpoint observations still leaves a checked closeout.
    fs.rmSync(c.closeoutFile, { force: true });
    builder(['checkpoint', 'request', 'closeout', '--conversation', session, '--harness', 'claude']);
    const bare = builder(['checkpoint', 'check', 'closeout', '--conversation', session], answer);
    let bareState: Record<string, unknown> = {};
    try { bareState = JSON.parse(bare.stdout); } catch { bareState = {}; }
    check(bareState['closeout'] === 'done', '1544: without observe the ledger still closes out: ' + JSON.stringify(bareState['gaps']));
    const stopped = c.next('30');
    check(stopped['decision'] === 'start' && stopped['id'] === 'n1', '1544: and kickoff next starts after ledger closeout: ' + JSON.stringify(stopped));
  } finally { await w.dispose(); }
}

async function section1545(): Promise<void> {
  // kickoffs/s214 row 2 (train hub-preflight-size): the answer hub edit gives when it writes never prints whole sections. At
  // 76f034a9 it already held none of the five text fields (none since the port, ca59c7aa), so this is a regression pin
  // (standing answer 9); the preview keeps every field, since sections 13, 202, 256, 527 and 1451 read them there.
  const w = await letterWorkspace('s214-apply-size');
  try {
    const filler = Array.from({ length: 400 }, (_, i) => `- Note ${String(i).padStart(3, '0')}: ${'a long history line kept for size '.repeat(3)}`);
    const big = path.join(w.root, 'big.md');
    fs.writeFileSync(big, filler.join('\n') + '\n');
    w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'add-section', '--section', 'Log', '--content-path', big, '--json']));
    const hubFile = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const logSize = Buffer.byteLength(/^## Log\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(fs.readFileSync(hubFile, 'utf8').replace(/\r\n/g, '\n'))?.[0] ?? '', 'utf8');
    check(logSize > 40 * 1024, `1545: the fixture section holds over 40 KB (${logSize} bytes)`);
    const edit = ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Log', '--content', '- [ ] Note 400: one more line.'];
    const preview = w.cli(0, [...edit, '--preflight', '--json']);
    equal(preview.exit, 0, '1545: the preview runs: ' + preview.stderr);
    let plan: Record<string, unknown> = {};
    try { plan = JSON.parse(preview.stdout); } catch { plan = {}; }
    const shown = w.cli(0, [...edit, '--preflight', '--show-sections', '--json']);
    let full: Record<string, unknown> = {};
    try { full = JSON.parse(shown.stdout); } catch { full = {}; }
    check(shown.exit === 0 && String(full['section_after'] ?? '').includes('- [ ] Note 400: one more line.')
      && ['section_before', 'section_body_before', 'section_after'].every(field =>
        typeof full[field] === 'string' && plan[field] === null && typeof plan[field + '_summary'] === 'object'),
    '1545: the preview summarizes all three large section fields and --show-sections returns their text');
    const applied = w.cli(0, [...edit, '--plan-id', String(plan['plan_id'] ?? ''), '--json']);
    equal(applied.exit, 0, '1545: the append writes: ' + applied.stderr);
    const bytes = Buffer.byteLength(applied.stdout, 'utf8');
    check(bytes < 4 * 1024, `1545: the apply answers in under 4 KB (${bytes} bytes)`);
    let answer: Record<string, unknown> = {};
    try { answer = JSON.parse(applied.stdout); } catch { answer = {}; }
    equal(answer['status'], 'written', '1545: the apply says written');
    for (const field of ['section_before', 'section_body_before', 'section_after', 'item_before', 'item_after']) {
      check(!(field in answer), `1545: the apply answer holds no ${field}`);
    }
    check(typeof answer['written_sha256'] === 'string' && typeof answer['journal'] === 'string', '1545: the apply still gives its hash and journal');
    // An item edit on the same big section: its preview holds the item, its apply neither the item nor the section.
    const tick = ['hub', 'edit', 'first', '--mode', 'check-item', '--section', 'Log', '--match-text', 'Note 400:'];
    const tickPreview = w.cli(0, [...tick, '--preflight', '--json']);
    let tickPlan: Record<string, unknown> = {};
    try { tickPlan = JSON.parse(tickPreview.stdout); } catch { tickPlan = {}; }
    check(String(tickPlan['item_after'] ?? '').startsWith('- [x] Note 400:'), '1545: the item preview holds item_after: ' + tickPreview.stdout.slice(0, 200) + tickPreview.stderr);
    const ticked = w.cli(0, [...tick, '--json']);
    let item: Record<string, unknown> = {};
    try { item = JSON.parse(ticked.stdout); } catch { item = {}; }
    check(ticked.exit === 0 && item['status'] === 'written' && Buffer.byteLength(ticked.stdout, 'utf8') < 4 * 1024
      && ['section_before', 'section_body_before', 'section_after', 'item_before', 'item_after'].every(field => !(field in item)),
      '1545: the item edit\'s apply answers in under 4 KB with none of the five fields: ' + ticked.stdout.slice(0, 300) + ticked.stderr);
  } finally { await w.dispose(); }
}

async function section1546(): Promise<void> {
  // kickoffs/s214 row 4 (train hub-tidy-journal-milliseconds): a tidy rolled back and retried in the same second works. The
  // journal is created exclusively and its name held seconds only, so the retry's journal name was the rolled-back one's.
  const tidyModule: Record<string, unknown> = await import('../../src/hubtidy.ts');
  const { seatClaimField } = await import('../../src/seatclaim.ts');
  const stampOf = tidyModule['tidyJournalStamp'] as ((now: Date) => string) | undefined;
  check(typeof stampOf === 'function', '1546: hubtidy.ts gives the journal stamp as tidyJournalStamp');
  if (typeof stampOf === 'function') {
    // A fixed clock: two moments in one second.
    const first = stampOf(new Date('2026-11-18T18:00:00.100Z'));
    const retry = stampOf(new Date('2026-11-18T18:00:00.900Z'));
    equal(first, '20261118-180000100', '1546: the stamp holds the date, the time and the milliseconds');
    check(first !== retry, `1546: two tidies in the same second get two journal names: ${first} and ${retry}`);
  }
  const w = await letterWorkspace('s214-tidy-retry');
  try {
    w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Now', '--content', '- [x] Finished thing one.', '--json']));
    const journals = () => fs.readdirSync(path.join(w.ws, 'internal', 'publication-journals')).filter(name => name.startsWith('project-tidy-first-hub-'));
    const preview = w.json(w.cli(0, ['hub', 'tidy', 'first', '--preflight', '--json']));
    const apply = ['hub', 'tidy', 'first', '--user-confirmed', '--plan-id', String(preview['plan_id'] ?? ''), '--json'];
    const rolled = runCli([...apply, '--workspace', w.ws], { cwd: w.root, env: { HOME: path.join(w.root, 'home'), USERPROFILE: path.join(w.root, 'home'),
      APPDATA: path.join(w.root, 'home'), LOCALAPPDATA: path.join(w.root, 'home'), LIBRARY_WORKSPACES: path.join(w.root, 'reg'), LIBRARY_SEAT: 'first',
      LIBRARY_SEAT_CLAIM: seatClaimField(path.join(w.ws, '.claude'), 'first', 'token') ?? '', DESKPOST_ASSISTANT: 'claude',
      LIBRARY_HUB_TIDY_FAULT: 'readback', CLAUDE_PID: '', LIBRARY_WORKSPACE: '', CODEX_HOME: path.join(w.root, 'home') } });
    check(rolled.exit !== 0 && (rolled.stdout + rolled.stderr).includes('the page was restored'), '1546: the readback fault rolls the tidy back: ' + (rolled.stdout + rolled.stderr).slice(0, 300));
    equal(journals().length, 1, '1546: the rolled-back tidy left one journal');
    // The retry, at once: the same plan, so with a seconds-only name it collided with the rolled-back journal.
    const retried = w.cli(0, apply);
    check(retried.exit === 0 && (retried.stdout + retried.stderr).includes('"written"'), '1546: the retry finishes: ' + (retried.stdout + retried.stderr).slice(0, 300));
    const names = journals();
    equal(names.length, 2, '1546: the retry wrote a second journal: ' + names.join(', '));
    check(names.every(name => /-\d{8}-\d{9}-[0-9a-f]{8}\.json$/.test(name)), '1546: each journal name holds milliseconds: ' + names.join(', '));
  } finally { await w.dispose(); }
}

async function section1547(): Promise<void> {
  const w = await letterWorkspace('w35-shown-items');
  try {
    const comment = ['<!-- an example: ``` -->', '<!--', '```', '-->'];
    const fixture = closeFixture(w, [
      '```text', '- [x] Example', '```', '',
      ...comment, '- [x] Done item', '- [ ] Open item',
    ], []);
    const tidy = w.json(w.cli(0, ['hub', 'tidy', 'first', '--preflight', '--json']));
    same(tidy?.['moved']?.map((item: { label: string }) => item.label), ['Done item'], '1547: tidy selects only the shown ticked item');
    const desk = w.json(w.cli(0, ['desk', '--json']));
    equal(desk?.['hub_pages']?.find((page: { hub: string; page: string }) => page.hub === 'first' && page.page === '_project')?.ticked_now,
      1, '1547: Desk counts only the shown ticked item');
    const close = fixture.close('Open item', ['--preflight']);
    equal(close.exit, 0, '1547: close-item finds Open item: ' + close.stdout.slice(0, 260) + close.stderr);
    const hidden = fixture.close('Example', ['--preflight']);
    check(hidden.exit !== 0 && (hidden.stdout + hidden.stderr).includes('No top-level item'), '1547: close-item skips the real fence');
    closeFixture(w, [], []);
    fs.appendFileSync(fixture.root, '\n## Log\n\n' + [...comment, '- [ ] Open log item'].join('\n') + '\n');
    const named = w.cli(0, ['hub', 'tidy', 'first', '--section', 'Log', '--preflight', '--json']);
    check(named.exit !== 0 && (named.stdout + named.stderr).includes('Open log item'), '1547: named tidy refuses and names the unticked item');
  } finally { await w.dispose(); }
}

async function section1548(): Promise<void> {
  const w = await letterWorkspace('w35-section-preview');
  try {
    const fixture = closeFixture(w, [], []);
    const longSection = Array.from({ length: 400 }, () => 'Résumé with enough text for a large section. '.repeat(4).trim()).join('\n');
    fs.appendFileSync(fixture.root, '\n## Log\n\n' + longSection + '\n');
    check(Buffer.byteLength(longSection) > 40 * 1024, '1548: the fixture has over 40 KB of section text');
    const appended = 'One more line.';
    const edit = ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Log', '--content', appended];
    const preview = w.cli(0, [...edit, '--preflight', '--json']);
    const compact = w.json(preview);
    const full = w.json(w.cli(0, [...edit, '--preflight', '--show-sections', '--json']));
    const bytes = Buffer.byteLength(preview.stdout);
    check(bytes < 4 * 1024 + Buffer.byteLength(appended), `1548: compact preview is under 4 KB plus the change (got ${bytes} bytes)`);
    equal(compact['plan_id'], full['plan_id'], '1548: the flag leaves the plan id unchanged');
    for (const field of ['section_before', 'section_body_before', 'section_after']) {
      const whole = full[field];
      const expected = field === 'section_before' ? '## Log\n\n' + longSection
        : field === 'section_after' ? '## Log\n\n' + longSection + '\n\n' + appended : longSection;
      equal(whole === expected, true, `1548: --show-sections returns the whole ${field}`);
      equal(compact[field] === null, true, `1548: the compact ${field} is null`);
      if (typeof whole === 'string') {
        same(compact[field + '_summary'], {
          lines: whole.split('\n').length,
          bytes: Buffer.byteLength(whole),
          sha256: createHash('sha256').update(whole).digest('hex'),
        }, `1548: the ${field} summary describes the full text`);
      }
      check(!(field + '_summary' in full), `1548: the full preview omits the ${field} summary`);
    }
    const before = fixture.rootText();
    const refused = w.cli(0, [...edit, '--show-sections', '--json']);
    check(refused.exit !== 0 && (refused.stdout + refused.stderr).includes('--show-sections requires --preflight'), '1548: the flag requires --preflight');
    check(fixture.rootText() === before, '1548: the refusal leaves the page intact');

    const small = w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Now',
      '--content', '- [ ] An item', '--preflight', '--json']));
    equal(small['section_after'], '## Now\n\n- [ ] An item', '1548: the small section retains its text');
    check(['section_before', 'section_body_before', 'section_after'].every(field =>
      typeof small[field] === 'string' && !(field + '_summary' in small)), '1548: small fields have text and no summaries');
  } finally { await w.dispose(); }
}

async function section1549(): Promise<void> {
  const w = await letterWorkspace('w36-kickoff-revisions');
  try {
    const cases: [string, boolean, string[], string][] = [
      ['x1', false, ['x1-r2'], 'pending; newer revision kickoffs/x1-r2 posted'],
      ['x1', false, [], 'pending'],
      ['x1-r2', false, ['x1', 'x1-r3', 'x1-r10', 'x1-r9'], 'pending; newer revision kickoffs/x1-r10 posted'],
      ['x1', true, ['x1-r2'], 'ticked'],
      ['x1', false, ['x10', 'x10-r2'], 'pending'],
    ];
    for (const [id, ticked, others, state] of cases) {
      const fixture = closeFixture(w, [], [`- [${ticked ? 'x' : ' '}] Run ${id}: [[projects/first/kickoffs/${id}]]`]);
      const folder = path.join(path.dirname(fixture.root), 'kickoffs');
      fs.mkdirSync(folder, { recursive: true });
      for (const page of [id, ...others]) fs.writeFileSync(path.join(folder, page + '.md'), `# ${page}\n`);
      const status = await hubStatusOf(w, 0, 'first');
      const line = `kickoffs/${id}: ${state}`;
      equal(status.exit, 0, '1549: hub status runs');
      check(status.lines.some(row => row.group === 'pointers' && row.text === line), '1549: JSON says ' + line);
      check(status.text.split('\n').some(row => row.trim() === line), '1549: terminal says ' + line);
      for (const page of [id, ...others]) fs.unlinkSync(path.join(folder, page + '.md'));
    }
  } finally { await w.dispose(); }
}

async function section1570(): Promise<void> {
  const w = await letterWorkspace('desk-conversation');
  try {
    const state = path.join(w.ws, '.claude');
    const folder = path.join(state, 'seats', 'first');
    const bindingFile = path.join(folder, 'binding.json');
    const binding = fs.readFileSync(bindingFile, 'utf8');
    const activityFile = path.join(folder, 'activity.json');
    const id = '15700000-0000-4000-8000-000000000001';
    const other = '15700000-0000-4000-8000-000000000002';
    const config = path.join(w.root, 'claude');
    const codexHome = path.join(w.root, 'codex');
    const transcripts = path.join(config, 'projects', 'fixture');
    fs.mkdirSync(transcripts, { recursive: true });
    fs.mkdirSync(codexHome);
    const transcript = path.join(transcripts, `${id}.jsonl`);
    const record = (assistant: string) => fs.writeFileSync(activityFile, JSON.stringify({
      seat: 'first', session_id: id, conversation_recorded_utc: '2999-01-01T00:00:00Z', assistant }));
    const { spawnSync } = await import('node:child_process');
    const bin = path.join(w.root, 'bin');
    fs.mkdirSync(bin);
    const image = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { fs.linkSync(process.execPath, image); } catch { fs.copyFileSync(process.execPath, image); }
    const token = /^token=([0-9a-f]{32})$/m.exec(fs.readFileSync(path.join(folder, '.claim'), 'utf8').replace(/\r/g, ''))?.[1] ?? '';
    const overview = (vars: Record<string, string> = {}) => {
      const ran = spawnSync(image, [path.join(PROGRAM_ROOT, 'kernel/src/cli.ts'), 'desk', '--workspace', w.ws, '--json'], {
        cwd: w.root, encoding: 'utf8', env: { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(w.root, 'reg'),
          LIBRARY_SEAT: 'first', LIBRARY_SEAT_CLAIM: token, DESKPOST_LAUNCHER_PID: String(process.pid), CLAUDE_PID: '',
          CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', ...vars } });
      equal(ran.status, 0, `1570: fixture Desk succeeds: ${ran.stderr}`);
      return JSON.parse(ran.stdout)['this_seat'];
    };
    record('codex');
    const codex = overview();
    check(codex.title_status === 'not-read' && codex.entry_action === 'resume', '1570 (a): Codex title is not read and conversation resumes');
    record('claude');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'first' }) + '\n');
    equal(overview().title_status, 'no-title', '1570 (b): the seat name alone is no title');
    record('codex');
    equal(overview({ CLAUDE_CODE_SESSION_ID: other, CODEX_THREAD_ID: id }).is_this_conversation, true, '1570 (c): Codex uses its own id with both variables set');
    record('claude');
    equal(overview({ CLAUDE_CODE_SESSION_ID: id, CODEX_THREAD_ID: other }).is_this_conversation, true, '1570 (c): Claude still uses its own id');
    const desk = await import('../../src/desk.ts');
    const conversation = await import('../../src/conversation.ts');
    const compare = (label: string) => {
      const shared = conversation.seatConversationRecord(state, 'first');
      same(desk.seatConversationRecord(state, 'first'), { sessionId: shared.session_id, source: shared.source, recordedUtc: shared.recorded_utc }, `1570 (d): record readers agree for ${label}`);
    };
    fs.rmSync(activityFile);
    compare('a binding');
    record('codex');
    compare('a newer launcher record');
    fs.rmSync(bindingFile);
    fs.writeFileSync(activityFile, JSON.stringify({ session_id: 'malformed', conversation_recorded_utc: '2999-01-01T00:00:00Z' }));
    compare('a malformed id');
    fs.rmSync(activityFile);
    compare('no record');
    fs.writeFileSync(bindingFile, binding);
    // (g) The Desk's exported reader keeps damaged bindings visible to its callers.
    fs.writeFileSync(bindingFile, '{ not json');
    for (const activity of [true, false]) {
      if (activity) record('codex');
      else fs.rmSync(activityFile);
      let error = '';
      try { desk.seatConversationRecord(state, 'first'); }
      catch (caught) { error = (caught as Error).message; }
      check(error.includes(bindingFile) && error.includes('not valid JSON'),
        `1570 (g): a damaged binding throws ${activity ? 'beside a valid activity record' : 'alone'}`);
    }
    fs.writeFileSync(bindingFile, binding);
    record('claude');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'The reader chose this title' }) + '\n');
    const custom = overview();
    check(custom.title_status === 'titled' && custom.title === 'The reader chose this title', '1570 (e): a custom title is shown');
    const started = performance.now();
    const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'kernel/src/desk.ts'), 'utf8');
    check(!/seatConversationTitle|seatTranscriptRoot|\.jsonl/.test(source) && /import\s*\{[^}]*seatConversationView[^}]*\}\s*from '\.\/conversation\.ts'/s.test(source), '1570 (f): the Desk imports its conversation reader and defines no transcript reader');
    const elapsed = performance.now() - started;
    console.log(`1570 (f): static conversation reader check took ${elapsed.toFixed(1)} milliseconds.`);
    check(elapsed < 1000, '1570 (f): static check takes less than one second');
  } finally { await w.dispose(); }
}

async function section1571(): Promise<void> {
  const w = await letterWorkspace('moved-book-commands');
  const third = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
  const cli = (who: number, args: string[]) => who === 2 ? runCli([...args, '--workspace', w.ws], { cwd: w.root,
    env: { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(w.root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '',
      HOME: path.join(w.root, 'home'), USERPROFILE: path.join(w.root, 'home'), APPDATA: path.join(w.root, 'home'),
      LOCALAPPDATA: path.join(w.root, 'home'), CODEX_HOME: path.join(w.root, 'home'), CLAUDE_CONFIG_DIR: path.join(w.root, 'home'),
      CLAUDE_PID: String(third.pid), DESKPOST_ASSISTANT: 'claude' } }) : w.cli(who, args);
  let server: ReturnType<typeof spawn> | undefined;
  try {
    const storage = path.join(w.root, 'server');
    fs.mkdirSync(path.join(storage, 'books'), { recursive: true });
    fs.writeFileSync(path.join(storage, 'books/README.md'), '# Books\n\n## Open a Book\n');
    const portFile = path.join(w.root, 'server.port');
    server = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), storage, portFile, '--call-log'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').trim()) {
      if (Date.now() > deadline) throw new Error('1571: fixture Basic Memory server did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}/mcp`;
    const bm = await import('../../src/basicmemory.ts');
    const session = new bm.McpSession(url, 'selftest-1571');
    await session.initialize();
    const stateFile = path.join(w.ws, 'internal/postbox/state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ schema: 1, url, project_name: 'deskpost',
      project_id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', library_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb',
      library_card: 'Home', server_tools_fingerprint: session.toolsFingerprint, server_tools_proven_fingerprint: session.toolsFingerprint }));
    w.json(cli(0, ['basic-memory', 'setup', '--url', url, '--collection', 'stand-in-collection', '--shared-writes', 'on', '--json']));
    w.json(cli(2, ['hub', 'new', 'third', '--title', 'Third', '--json']));
    const enter = ['seat', 'enter', 'third', '--create', '--project', 'third', '--agent-pid', String(third.pid), '--deadline-seconds', '10'];
    const plan = w.json(cli(2, [...enter, '--preflight']));
    w.json(cli(2, [...enter, '--plan-id', String(plan.plan_id)]));
    const wiki = path.join(w.ws, 'collection/books/demo/wiki');
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, '_book.md'), '---\ntitle: _book\n---\n\n# Demo\n\n## Purpose\n\nA fixture Book.\n');
    fs.writeFileSync(path.join(wiki, '_index.md'), '---\ntitle: _index\n---\n\n# Demo - Reader Map\n\n- [[books/demo/wiki/_book|Book metadata and limits]]\n- [[books/demo/wiki/start|Start]]\n');
    fs.writeFileSync(path.join(wiki, 'start.md'), '# Start\n\nThe fixture text.\n');
    w.json(cli(0, ['collection', 'rebuild', '--json']));
    for (const [who, seat] of ['first', 'second', 'third'].entries())
      equal(cli(who, ['desk', 'open', 'book', 'demo', '--location', 'collection', '--seat', seat]).exit, 0, `1571: ${seat} opens the collection Book`);
    const args = ['shared', 'promote', 'demo', '--seat', 'first'];
    const preview = w.json(cli(0, [...args, '--preflight', '--json']));
    const promoted = w.json(cli(0, [...args, '--user-confirmed', '--plan-id', String(preview.plan_id), '--json']));
    equal(promoted.verdict, 'written', '1571: fixture Book is promoted');
    const overview = (who: number, seat: string) => w.json(cli(who, ['desk', '--seat', seat, '--json']));
    const rows = overview(0, 'first').moved_books_still_open as Record<string, any>[];
    same(rows.map(row => row.seat), ['second', 'third'], '1571: one moved-Book row per holding seat');
    const booksFile = (seat: string) => path.join(w.ws, '.claude/seats', seat, '.open-books');
    for (const row of rows) {
      const who = row.seat === 'second' ? 1 : 2;
      const others = ['first', 'second', 'third'].filter(seat => seat !== row.seat);
      const before = others.map(seat => fs.readFileSync(booksFile(seat), 'utf8'));
      const close = cli(who, String(row.close).split(' ').slice(1));
      equal(close.exit, 0, `1571: printed close succeeds for ${row.seat}: ${close.stderr}`);
      check(!/^books\/demo\r?$/m.test(fs.readFileSync(booksFile(row.seat), 'utf8')), `1571: close removes only ${row.seat}'s old entry`);
      same(others.map(seat => fs.readFileSync(booksFile(seat), 'utf8')), before, '1571: close preserves other seats');
      const open = cli(who, String(row.open).split(' ').slice(1));
      equal(open.exit, 0, `1571: printed open succeeds for ${row.seat}: ${open.stderr}`);
      check((overview(who, row.seat).open_books as Record<string, any>[]).some(book => book.root === 'shared/demo'), `1571: ${row.seat} now holds the shared Book`);
      same(others.map(seat => fs.readFileSync(booksFile(seat), 'utf8')), before, '1571: open preserves other seats');
    }
    check(!('moved_books_still_open' in overview(0, 'first')), '1571: no old entry remains');
  } finally {
    if (server && server.exitCode === null) {
      const stopped = new Promise<void>(resolve => server!.once('exit', () => resolve()));
      server.kill();
      await stopped;
    }
    if (third.exitCode === null) {
      const stopped = new Promise<void>(resolve => third.once('exit', () => resolve()));
      third.kill();
      await stopped;
    }
    await w.dispose();
  }
}

async function section1572(): Promise<void> {
  const w = await letterWorkspace('upkeep-seat-names');
  try {
    const state = path.join(w.ws, '.claude');
    const desk = await import('../../src/desk.ts');
    const live = desk.readSeatRegistry(state).find(row => row.seat === 'first')!.seatId;
    const retired = '15720000000040008000000000000001';
    const missing = '15720000000040008000000000000002';
    const unnamed = '15720000000040008000000000000003';
    const archive = path.join(w.ws, 'internal/seat-archive/old-fixture');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'seat.json'), JSON.stringify({ seat: 'old', seat_id: retired, retired_utc: '2026-01-01T00:00:00Z' }));
    const grant = path.join(w.ws, 'internal/shared-upkeep/demo.json');
    fs.mkdirSync(path.dirname(grant), { recursive: true });
    fs.writeFileSync(grant, JSON.stringify({ seat_ids: [live, retired, missing, unnamed], names: ['first', 'old', 'Remembered'] }));
    fs.appendFileSync(path.join(state, 'seats/first/.open-books'), 'shared/demo\n');
    const view = w.json(w.cli(0, ['desk', '--seat', 'first', '--json']));
    const book = (view.open_books as Record<string, any>[]).find(row => row.root === 'shared/demo');
    equal(book?.maintained_by?.[0], 'first', '1572: a live seat keeps its current name');
    equal(book?.maintained_by?.[1], 'old (retired)', '1572: a retirement record names a retired seat');
    equal(book?.maintained_by?.[2], 'Remembered (unknown seat)', '1572: an unknown seat keeps its recorded name');
    equal(book?.maintained_by?.[3], `${unnamed} (unknown seat)`, '1572: an unknown seat without a name keeps its id');
    equal(book?.maintained_by?.length, 4, '1572: the grant has exactly four names');
  } finally { await w.dispose(); }
}

async function section1573(): Promise<void> {
  const w = await letterWorkspace('oversized-hub-remedy');
  try {
    fs.writeFileSync(path.join(w.ws, '.claude/seats/first/.open-projects'), 'projects/first\nprojects/second\n');
    const first = path.join(w.ws, 'collection/projects/first');
    const second = path.join(w.ws, 'collection/projects/second');
    fs.appendFileSync(path.join(first, '_project.md'), '\n## Evidence\n\n' + 'Oversized root.\n'.repeat(3000));
    fs.writeFileSync(path.join(first, 'connections.md'), '# Connections\n\n' + 'Oversized connections.\n'.repeat(3000));
    fs.mkdirSync(path.join(second, 'research'), { recursive: true });
    fs.writeFileSync(path.join(second, 'research/large.md'), '# Large page\n\n' + 'Oversized on demand.\n'.repeat(3000));
    const { hubPages } = await import('../../src/hubpages.ts');
    const original = hubPages(w.ws, ['projects/first', 'projects/second']) as Record<string, any>[];
    const view = w.json(w.cli(0, ['desk', '--seat', 'first', '--json']));
    const rows = view.hub_pages as Record<string, any>[];
    check(rows.some(row => row.hub === 'first' && row.page === '_project' && row.over === true), '1573: fixture root exceeds its limit');
    check(rows.some(row => row.page === 'connections' && row.over === true), '1573: fixture connections exceed their limit');
    check(rows.some(row => row.page === 'research/large' && row.over === true), '1573: fixture on demand page exceeds its limit');
    check(rows.some(row => row.hub === 'second' && row.page === '_project' && row.over === false), '1573: other root is within its limit');
    for (const row of rows) {
      if (row.page === '_project' && row.over === true) {
        equal(row.remedy, `deskpost hub tidy ${row.hub} --preflight`, '1573: oversized root names hub tidy');
        equal(Object.keys(row).at(-1), 'remedy', '1573: remedy is the last key');
      } else check(!('remedy' in row), `1573: ${row.hub}/${row.page} has no root remedy`);
      const { remedy: _remedy, ...unchanged } = row;
      same(unchanged, original.find(item => item.hub === row.hub && item.page === row.page), `1573: existing fields stay unchanged for ${row.hub}/${row.page}`);
    }
  } finally { await w.dispose(); }
}

async function section1550(): Promise<void> {
  const w = await letterWorkspace('w36-tidy-named-items');
  try {
    const replacement = ['- [ ] Replaced item', '  - Keep this nested line verbatim.'];
    const done = '- [x] Finished item';
    const kept = '- [ ] Keep this item';
    const plain = 'A standalone archive line.';
    const run = '- [ ] Run x1: [[projects/first/kickoffs/x1]]';
    const fixture = closeFixture(w, [...replacement, done, kept, '', '<!-- Hidden archive item -->', '',
      '```text', 'Fenced archive item', '```'], [run]);
    fs.appendFileSync(fixture.root, '\n## Log\n\n' + plain + '\n\n## Decisions\n\n- Keep this ruling.\n');
    const tidy = (...args: string[]) => w.cli(0, ['hub', 'tidy', 'first', ...args, '--json']);
    const help = w.cli(0, ['hub', 'tidy', '--help']);
    check(help.exit === 0 && help.stdout.includes('--item') && help.stdout.includes('--supersedes'), '1550: help explains named items');
    const before = fixture.rootText();
    const refusal = (args: string[], ...expected: string[]) => {
      const result = tidy(...args, '--preflight');
      const message = result.stdout + result.stderr;
      check(result.exit !== 0 && expected.every(part => message.includes(part)), '1550: refusal explains ' + expected.join(', ') + ': ' + message);
      equal(fixture.rootText(), before, '1550: refusal keeps the Hub intact');
      same(fixture.history(), [], '1550: refusal creates no history');
    };
    refusal(['--item', 'Run x1:'], '--supersedes "Run x1:"');
    refusal(['--item', 'item'], 'Replaced item', 'Finished item');
    refusal(['--item', 'Hidden archive item'], 'No item or line');
    refusal(['--item', 'Fenced archive item'], 'No item or line');
    refusal(['--item', 'Keep this ruling'], 'Decisions');
    refusal(['--item', plain, '--section', 'Log'], '--section', 'Log');

    const items = ['--item', 'nested line verbatim', '--item', plain, '--item', 'Finished item'];
    const preview = tidy(...items, '--preflight');
    equal(preview.exit, 0, '1550: named preflight succeeds: ' + preview.stdout + preview.stderr);
    if (preview.exit !== 0) return;
    const firstPlan = String(w.json(preview)['plan_id']);
    fs.appendFileSync(fixture.root, 'A later change stays here.\n');
    const second = w.json(tidy(...items, '--preflight'));
    const secondPlan = String(second['plan_id']);
    check(firstPlan !== secondPlan, '1550: a page edit changes the plan ID');
    const stale = tidy(...items, '--user-confirmed', '--plan-id', firstPlan);
    check(stale.exit !== 0 && (stale.stdout + stale.stderr).includes('exact plan_id'), '1550: the old plan refuses');
    same(fixture.history(), [], '1550: the old plan creates no history');
    const apply = tidy(...items, '--user-confirmed', '--plan-id', secondPlan);
    equal(apply.exit, 0, '1550: the current plan applies: ' + apply.stdout + apply.stderr);
    const history = fixture.history();
    equal(history.length, 1, '1550: one history page');
    if (history.length !== 1) return;
    const text = fixture.notesText(history[0]!);
    check(text.includes(['## From ## Now', '', ...replacement, done].join('\n')), '1550: the unticked and ticked items move verbatim, in page order');
    check(text.includes('## From ## Log\n\n' + plain), '1550: a named prose line moves under its section');
    equal(text.split(done).length, 2, '1550: the explicitly selected ticked item moves once');
    const after = fixture.rootText();
    check([kept, run, 'A later change stays here.'].every(line => after.includes(line)), '1550: the other lines stay intact');
    check([...replacement, done, plain].every(line => !after.includes(line)), '1550: the moved lines leave the Hub');
  } finally { await w.dispose(); }
}

async function section1551(): Promise<void> {
  const w = await letterWorkspace('w37-tidy-nested-run');
  try {
    const parent = '- [ ] Old plan';
    const pointer = '  - [ ] Run x1: [[projects/first/kickoffs/x1]]';
    const fixture = closeFixture(w, [], [parent, pointer]);
    const args = ['hub', 'tidy', 'first', '--item', 'Old plan', '--json'];
    const before = fs.readFileSync(fixture.root);
    const refusal = w.cli(0, [...args, '--preflight']);
    const message = refusal.stdout + refusal.stderr;
    check(refusal.exit !== 0 && message.includes('--supersedes "Run x1:"'), '1551: the nested pending Run pointer blocks moving its parent: ' + message);
    check(before.equals(fs.readFileSync(fixture.root)), '1551: refusal leaves the Hub byte-identical');
    same(fixture.history(), [], '1551: refusal creates no history');

    const ticked = pointer.replace('[ ]', '[x]');
    fs.writeFileSync(fixture.root, before.toString().replace(pointer, ticked));
    const preview = w.cli(0, [...args, '--preflight']);
    equal(preview.exit, 0, '1551: a ticked nested pointer previews: ' + preview.stdout + preview.stderr);
    if (preview.exit !== 0) return;
    const apply = w.cli(0, [...args, '--user-confirmed', '--plan-id', String(w.json(preview)['plan_id'])]);
    equal(apply.exit, 0, '1551: a ticked nested pointer moves: ' + apply.stdout + apply.stderr);
    const history = fixture.history();
    equal(history.length, 1, '1551: one history page');
    if (history.length !== 1) return;
    check(fixture.notesText(history[0]!).includes(parent + '\n' + ticked), '1551: the complete block moves verbatim');
    check(!fixture.rootText().includes(parent) && !fixture.rootText().includes(ticked), '1551: both lines leave the Hub');
  } finally { await w.dispose(); }
}

async function section1552(): Promise<void> {
  const w = await letterWorkspace('w37-tidy-subheading');
  try {
    const item = '- [ ] Replaced task';
    const fixture = closeFixture(w, [], []);
    fs.appendFileSync(fixture.root, '\n## Log\n\n### Earlier work\n\n' + item + '\n\n## Decisions\n\n### Older rulings\n\n- Keep this ruling\n');
    const tidy = (match: string, ...args: string[]) => w.cli(0, ['hub', 'tidy', 'first', '--item', match, ...args, '--json']);
    const before = fs.readFileSync(fixture.root);
    const refusal = tidy('Keep this ruling', '--preflight');
    const message = refusal.stdout + refusal.stderr;
    check(refusal.exit !== 0 && message.includes("'Decisions'"), '1552: Decisions still protects items under its subheadings: ' + message);
    check(before.equals(fs.readFileSync(fixture.root)), '1552: refusal leaves the Hub byte-identical');
    same(fixture.history(), [], '1552: refusal creates no history');

    const preview = tidy('Replaced task', '--preflight');
    equal(preview.exit, 0, '1552: a named item under a subheading previews: ' + preview.stdout + preview.stderr);
    if (preview.exit !== 0) return;
    const apply = tidy('Replaced task', '--user-confirmed', '--plan-id', String(w.json(preview)['plan_id']));
    equal(apply.exit, 0, '1552: a named item under a subheading moves: ' + apply.stdout + apply.stderr);
    const history = fixture.history();
    equal(history.length, 1, '1552: one history page');
    if (history.length !== 1) return;
    check(fixture.notesText(history[0]!).includes('## From ## Log\n\n' + item), '1552: the item moves verbatim under Log');
    check(!fixture.rootText().includes(item), '1552: the item leaves the Hub');
    check(fixture.rootText().includes('### Older rulings\n\n- Keep this ruling'), '1552: the ruling stays under its subheading');
  } finally { await w.dispose(); }
}

async function section1553(): Promise<void> {
  const w = await letterWorkspace('w38-insert-item');
  try {
    const fixture = closeFixture(w, [], ['A paragraph anchor.', '- [ ] List anchor']);
    const before = fs.readFileSync(fixture.root);
    const insert = (anchor: string, content: string) => w.cli(0, ['hub', 'edit', 'first', '--mode', 'insert-item',
      '--section', 'Next', '--after', anchor, '--content', content, '--preflight', '--json']);
    const paragraph = insert('A paragraph anchor.', '- New item');
    const anchorMessage = paragraph.stdout + paragraph.stderr;
    check(paragraph.exit !== 0 && anchorMessage.includes('A paragraph anchor.') && anchorMessage.includes('append-section'),
      '1553: paragraph anchor names itself and append-section: ' + anchorMessage);
    check(before.equals(fs.readFileSync(fixture.root)), '1553: anchor refusal leaves the page byte-identical');
    equal(insert('List anchor', '- New item').exit, 0, '1553: list content after a list anchor previews');
    const content = insert('List anchor', 'A paragraph to insert.');
    const contentMessage = content.stdout + content.stderr;
    check(content.exit !== 0 && contentMessage.includes('A paragraph to insert.') && contentMessage.includes('1.'),
      '1553: non-list content names its first line and markers: ' + contentMessage);
    check(before.equals(fs.readFileSync(fixture.root)), '1553: content refusal leaves the page byte-identical');
  } finally { await w.dispose(); }
}

async function section1554(): Promise<void> {
  const w = await letterWorkspace('w38-item-remedies');
  try {
    const fixture = closeFixture(w, [], ['A plain line.', '- [ ] Shared one', '- [ ] Shared two']);
    const before = fs.readFileSync(fixture.root);
    const cases: Array<[string, string[]]> = [
      ['replace-item needs a match', ['edit', 'first', '--mode', 'replace-item', '--content', 'New']],
      ['replace-item has no match', ['edit', 'first', '--mode', 'replace-item', '--match-text', 'Missing', '--content', 'New']],
      ['check-item needs a match', ['edit', 'first', '--mode', 'check-item']],
      ['check-item finds a plain line', ['edit', 'first', '--mode', 'check-item', '--match-text', 'A plain line.']],
      ['check-item has an ambiguous match', ['edit', 'first', '--mode', 'check-item', '--match-text', 'Shared']],
      ['insert-item needs an anchor', ['edit', 'first', '--mode', 'insert-item', '--content', '- New']],
      ['insert-item finds a plain anchor', ['edit', 'first', '--mode', 'insert-item', '--after', 'A plain line.', '--content', '- New']],
      ['insert-item needs a list item', ['edit', 'first', '--mode', 'insert-item', '--after', 'Shared one', '--content', 'New']],
      ['tidy has no named match', ['tidy', 'first', '--item', 'Missing']],
    ];
    for (const [label, args] of cases) {
      const refused = w.cli(0, ['hub', ...args, '--preflight', '--json']);
      const message = refused.stdout + refused.stderr;
      check(refused.exit !== 0 && /--match-text|--after|--section|--mode|append-section|replace-item\.|give text unique to one/i.test(message),
        '1554: ' + label + ' names a next step: ' + message);
      if (label === 'check-item finds a plain line') {
        check(message.includes('is not a checkbox') && message.includes('replace-item'), '1554: a plain match names the checkbox remedy');
      }
      check(before.equals(fs.readFileSync(fixture.root)), '1554: ' + label + ' leaves the page byte-identical');
    }
  } finally { await w.dispose(); }
}

async function section1555(): Promise<void> {
  const w = await letterWorkspace('w38-remove-markdown-links');
  try {
    const edit = (...args: string[]) => w.json(w.cli(0, ['hub', 'edit', 'first', ...args, '--json']));
    edit('--mode', 'new-page', '--page', 'notes/old', '--content', '# Old\n\nOld text.');
    edit('--mode', 'new-page', '--page', 'notes/neighbor', '--content', '# Expected\n\n[x](old.md#details)');
    edit('--mode', 'new-page', '--page', 'notes/external', '--content', '# External\n\n[x](https://example.test/notes/old.md)');
    edit('--mode', 'append-section', '--section', 'Next', '--content', 'See [old notes](notes/old.md).');
    const preview = edit('--mode', 'remove-page', '--page', 'notes/old', '--preflight');
    same(preview.linked_from, ['projects/first/_project', 'projects/first/notes/neighbor'],
      '1555: preview names both relative Markdown links and omits the external link');
    edit('--mode', 'new-page', '--page', 'notes/parentheses', '--content', '# Parentheses\n\n[y](old.md#part(one))');
    const withParentheses = edit('--mode', 'remove-page', '--page', 'notes/old', '--preflight');
    same(withParentheses.linked_from, ['projects/first/_project', 'projects/first/notes/neighbor', 'projects/first/notes/parentheses'],
      '1555: preview includes the link with balanced parentheses');
    for (const [name, link] of [
      ['unbalanced', '[y](old.md#part(one)'],
      ['prose', 'old.md#part(one)'],
      ['absolute', '[z](/old.md#part(one))'],
      ['scheme', '[w](https://example.test/old.md#part(one))'],
    ]) {
      edit('--mode', 'new-page', '--page', `notes/${name}`, '--content', `# ${name}\n\n${link}`);
      const omitted = edit('--mode', 'remove-page', '--page', 'notes/old', '--preflight');
      same(omitted.linked_from, withParentheses.linked_from, `1555: ${name} is left out of linked_from`);
    }
  } finally { await w.dispose(); }
}

async function section1556(): Promise<void> {
  const { fillTimePlaceholders, hasTimePlaceholders } = await import('../../src/hubedit.ts');
  const now = new Date(2026, 10, 18, 13, 14);
  for (const prefix of ['> ', '> > ']) {
    const fence = [prefix + '~~~', prefix + '{now}', prefix + '~~~'].join('\n');
    equal(fillTimePlaceholders(fence, now), fence, '1556: quoted fence keeps the placeholder literal');
    check(!hasTimePlaceholders(fence), '1556: quoted fence is skipped when detecting placeholders');
  }
  const prose = '> {now}';
  const fence = '> ~~~\n> {now}\n> ~~~';
  check(hasTimePlaceholders(prose) && !fillTimePlaceholders(prose, now).includes('{now}'),
    '1556: quoted prose still fills');
  equal(fillTimePlaceholders(fence + '\n> {today}', now), fence + '\n> 2026-11-18',
    '1556: quoted prose immediately after the closing fence fills');

  const cases = [
    { label: 'quote ends at a blank line', text: '> ~~~\n> example\n\n{now}', found: true },
    { label: 'quote ends at unquoted prose', text: '> ~~~\n> example\ntext {now}', found: true },
    { label: 'quoted marker inside an ordinary fence', text: '~~~\n> ~~~\n{now}\n~~~', found: false },
    { label: 'prose after an ordinary fence', text: '~~~\n> ~~~\nx\n~~~\n{now}', found: true },
  ];
  for (const { label, text, found } of cases) {
    equal(hasTimePlaceholders(text), found, '1556: detection while ' + label);
    equal(fillTimePlaceholders(text, now), found ? text.replace('{now}', fillTimePlaceholders('{now}', now)) : text,
      '1556: replacement while ' + label);
  }

  const w = await letterWorkspace('w38-quoted-fence');
  try {
    const fixture = closeFixture(w, [], []);
    const result = w.json(w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next',
      '--content', fence, '--json']));
    check(result.written && fixture.rootText().includes(fence), '1556: apply writes the quoted fence with literal placeholders');
  } finally { await w.dispose(); }
}

async function section1557(): Promise<void> {
  const { pageSizeRemedy } = await import('../../src/hubedit.ts');
  const command = 'deskpost hub tidy first --preflight';
  const now = '## Now\n\n- [ ] A longer entry in Now\n\n## Decisions\n\n- Short';
  const decisions = '## Decisions\n\n- A longer entry in Decisions\n\n## Now\n\n- [ ] Short';
  const nowAdvice = pageSizeRemedy('projects/first/_project.md', now);
  check(nowAdvice.startsWith('Move history to a dated notes/ page, connections to the companion connections page, and accepted limits to the limits page (ADR-0013).') &&
    nowAdvice.includes(command), '1557: Now advice preserves the existing sentence and names tidy');
  const decisionsAdvice = pageSizeRemedy('projects/first/_project.md', decisions);
  check(decisionsAdvice.startsWith('Move whole entries from ## Decisions, word for word, to a dated notes/ record page with new-page; leave one grouped pointer line with replace-section.') &&
    decisionsAdvice.includes(command), '1557: Decisions advice preserves the existing sentence and names tidy');
  check(pageSizeRemedy('_project.md', now).includes('deskpost hub tidy <slug> --preflight'), '1557: an unknown slug uses a placeholder');
  equal(pageSizeRemedy('projects/first/notes/old.md', now), 'Move detail onto a linked page and keep this one to what a reader needs on arrival.',
    '1557: the notes page advice is unchanged');
}

/** hub status advises closing an item only when the item closes on that record (kickoffs/s219 row 1). */
async function section1558(): Promise<void> {
  const w = await letterWorkspace('s219-close-advice');
  try {
    writeTrain(w.ws, [['c-one', 'done', 'car:one'], ['c-two', 'done', 'car:one'], ['c-three', 'done', 'car:one'], ['c-four', 'done', 'car:one'],
      ['c-five', 'done', 'car:one'], ['c-six', 'open', 'car:one']], 'car:one');
    const letter = String(w.capture(1, ['--for', 'first', '--title', 'A question'])['page']);
    closeFixture(w, [
      '- [ ] Waits on `c-one`',
      '- [ ] Waits on `c-two`. Closes when `c-two` closes.',
      '- [ ] Train `c-three` was closed on a weak proof. Closes when Eric answers.',
      '- [ ] Waits on `c-four` and `c-five`. Closes when `c-five` closes.',
      `- [ ] Answer ${letter}. Closes when \`c-six\` closes.`,
      '- [ ] Review kickoffs/k1. Closes when kickoffs/k2 lands.',
    ], ['- [x] Run k1: [[projects/first/kickoffs/k1]] (r1)']);
    equal(w.cli(0, ['letters', 'close', letter]).exit, 0, '1558: the letter closes');
    const status = await hubStatusOf(w, 0, 'first');
    equal(status.exit, 0, '1558: hub status runs: ' + status.text.slice(0, 300));
    const said = (text: string, source: string) => check(status.lines.some(line => line.text === text && line.source === source && line.group === 'pointers'),
      `1558: says "${text}" from ${source}: ${JSON.stringify(status.lines)}`);
    said('train c-one: done; closed: tick or close this item', 'train:c-one');
    said('train c-two: done; closed: tick or close this item', 'train:c-two');
    said('train c-three: done', 'train:c-three');
    said('train c-four: done', 'train:c-four');
    said('train c-five: done; closed: tick or close this item', 'train:c-five');
    said(`letter ${letter}: closed`, `letters/${letter}`);
    said('kickoffs/k1: ticked', 'projects/first/_project ## Next Run k1');
    check(status.lines.every(line => Object.keys(line).sort().join(',') === 'group,source,text'), '1558: each JSON line keeps its shape');
  } finally { await w.dispose(); }
}

/** hub status's terminal view keeps each line's state and advice whole (kickoffs/s219 row 2). */
async function section1559(): Promise<void> {
  const { hubStatusText } = await import('../../src/hubstatus.ts');
  const letter = ('notes/2026-11-19-' + 'sbox-codex-dev-asks-about-the-long-letter-path-'.repeat(2)).slice(0, 89) + 'v';
  equal(letter.length, 90, '1559: the letter path is 90 characters');
  const train = ('t-' + 'long-train-identifier-'.repeat(3)).slice(0, 59) + 'x';
  equal(train.length, 60, '1559: the train id is 60 characters');
  const pointers = [
    { group: 'pointers' as const, source: `letters/${letter}`, text: `letter ${letter}: closed; closed: tick or close this item` },
    { group: 'pointers' as const, source: `train:${train}`, text: `train ${train}: done; closed: tick or close this item` },
    { group: 'pointers' as const, source: `train:${train}-b`, text: `train ${train}: open` },
    { group: 'pointers' as const, source: 'train:short', text: 'train short: open' },
  ];
  const text = hubStatusText({ schema: 1, operation: 'Hub status', hub: 'projects/first', seat: 'first', lines: pointers });
  const printed = text.split('\n');
  same(printed.filter(line => line.length > 69), [], '1559: every printed line is at most 69 columns');
  check(printed.includes('  train short: open'), '1559: the short line is unchanged: ' + text);
  const words = (from: string) => from.split(/[\s;:]+/).filter(Boolean);
  // Each line's state and advice, the text after the record's name, appears whole in the printed text.
  for (const line of pointers) {
    const rest = line.text.slice(line.text.indexOf(': ') + 2);
    check(text.includes(rest), `1559: "${rest}" appears whole: ${text}`);
    for (const word of words(rest)) check(words(text).includes(word), `1559: the word "${word}" appears whole`);
  }
  check(printed.some(line => line.startsWith('  letter notes/2026-11-19-sbox') && line.endsWith('v:')), '1559: the letter line keeps its name\'s start and end: ' + text);
  check(printed.some(line => line === '    closed; closed: tick or close this item'), '1559: the letter\'s state and advice wrap to an indented line: ' + text);
  check(printed.some(line => line.startsWith('  train t-long') && line.endsWith('x: open')), '1559: the train line keeps its name\'s start and end and its state: ' + text);
}

/** hub status names a Kickoff page no Run pointer names, once it is more than an hour old (kickoffs/s219 row 3). */
async function section1560(): Promise<void> {
  const w = await letterWorkspace('s219-orphan-kickoff');
  try {
    const fixture = closeFixture(w, [], ['- [ ] Run p1: [[projects/first/kickoffs/p1]] (r1)']);
    const kickoffs = path.join(fixture.hubDir, 'kickoffs'), notes = path.join(fixture.hubDir, 'notes');
    fs.mkdirSync(kickoffs, { recursive: true });
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, '2026-11-01-hub-history-tidy-1.md'), '# History\n\n- [x] Run p2: [[projects/first/kickoffs/p2]] (r1)\n');
    fs.writeFileSync(path.join(notes, '2026-10-01-hub-history-s1-tidy.md'), '# History\n\n- [x] Run p5: [[projects/first/kickoffs/p5]] (r1)\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const file = path.join(kickoffs, `${id}.md`);
      fs.writeFileSync(file, `# ${id}\n`);
      if (id !== 'p4') fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
    }
    const status = await hubStatusOf(w, 0, 'first');
    equal(status.exit, 0, '1560: hub status runs: ' + status.text.slice(0, 300));
    const orphans = status.lines.filter(line => line.text.endsWith(': no Run pointer names it'));
    same(orphans, [{ group: 'queue', source: 'projects/first/kickoffs/p3', text: 'kickoffs/p3: no Run pointer names it' }],
      '1560: only the unpointed page older than an hour is named');
    check(status.text.split('\n').includes('  kickoffs/p3: no Run pointer names it'), '1560: the terminal view names it under the Run queue: ' + status.text);
    equal(w.cli(0, ['desk', 'close', 'project', 'first', '--seat', 'first']).exit, 0, '1560: the Hub closes on the Desk');
    check(!(await hubStatusOf(w, 0, 'first')).lines.some(line => line.text.includes('no Run pointer names it')), '1560: nothing is listed while the Hub is closed');
  } finally { await w.dispose(); }
}

/**
 * THE DIAGNOSTIC TEXT OF A SOURCE (kickoffs/s219 row 4): each argument of `refuse(`, `new Error(` or `new <Name>Error(` /
 * `new <Name>Refusal(`, its string and template literal pieces joined, a `${...}` read as `<x>`. Option tables and
 * argument arrays are never read. `at[i]` is the source index of the message's character i.
 */
function diagnosticLiterals(text: string): { line: (index: number) => number; messages: { message: string; at: number[] }[] } {
  const messages: { message: string; at: number[] }[] = [];
  const call = /(?<![\w.])(?:refuse|new (?:Error|[A-Z]\w*(?:Error|Refusal)))\(/g;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    let index = match.index + match[0].length, depth = 1, message = '';
    const at: number[] = [];
    const put = (piece: string, from: number) => { message += piece; for (let i = 0; i < piece.length; i++) at.push(from); };
    while (index < text.length && depth > 0) {
      const char = text[index]!;
      if (char === "'" || char === '"') {
        let end = index + 1;
        while (end < text.length && text[end] !== char) { put(text[end] === '\\' ? text[end + 1]! : text[end]!, end); end += text[end] === '\\' ? 2 : 1; }
        index = end + 1;
      } else if (char === '`') {
        let end = index + 1;
        while (end < text.length && text[end] !== '`') {
          if (text[end] === '\\') { put(text[end + 1]!, end); end += 2; continue; }
          if (text[end] === '$' && text[end + 1] === '{') {
            const from = end;
            let inner = 1; end += 2;
            while (end < text.length && inner > 0) { if (text[end] === '{') inner++; else if (text[end] === '}') inner--; end++; }
            put('<x>', from);
            continue;
          }
          put(text[end]!, end); end++;
        }
        index = end + 1;
      } else {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        index++;
      }
    }
    messages.push({ message, at });
  }
  return { line: (index: number) => text.slice(0, index).split('\n').length, messages };
}

/** The command each file's refusals answer when they name none: the command line the reader just ran. */
const OWN_COMMAND: Record<string, [string, string][]> = {
  'hubedit.ts': [['hub', 'edit']],
  'hubnewpage.ts': [['hub', 'edit']],
  'hubtidy.ts': [['hub', 'tidy'], ['hub', 'edit']],
  'hubstatus.ts': [['hub', 'status']],
  'kickoffcheck.ts': [['kickoff', 'check']],
  'kickoff.ts': [['kickoff', 'check'], ['kickoff', 'next'], ['kickoff', 'send'], ['kickoff', 'receive']],
};

/** Every remedy in this lane names a command its verb takes (kickoffs/s219 row 4; the due class "A refusal or usage line that does not name its remedy"). */
async function remedyProblems(kernelSource: string): Promise<string[]> {
  const { VERBS, argumentTable } = await import('../../src/verbs.ts');
  const takes = (verb: string, action: string, option: string): boolean => {
    try {
      const table = argumentTable(verb, action);
      return [...(table.valued ?? []), ...(table.repeatable ?? []), ...(table.boolean ?? [])].includes(option);
    } catch { return false; }
  };
  // NAMED SKIPS, each with its reason (the handback lists them): the self-test fault hooks name no option; `--options`
  // is the prose "its --options" in hub edit's and hub tidy's second-word refusal, not an option name.
  const SKIPPED_OPTIONS = new Set(['options']);
  // A refusal another verb passes on (hub edit's Run-pointer refusals reach `kickoff receive`) must name its command.
  const passedOn = /pending Run pointer/;
  const problems: string[] = [];
  for (const name of Object.keys(OWN_COMMAND)) {
    const source = diagnosticLiterals(fs.readFileSync(path.join(kernelSource, name), 'utf8'));
    for (const { message, at } of source.messages) {
      const commands: { at: number; verb: string; action: string }[] = [];
      for (const m of message.matchAll(/\bdeskpost ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
        const declaration = VERBS[m[1]!];
        if (declaration) commands.push({ at: m.index!, verb: m[1]!, action: declaration.actions.includes(m[2] ?? '') ? m[2]! : '' });
      }
      for (const m of message.matchAll(/(?<![\w-])hub ([a-z][a-z-]*)/g)) {
        if (VERBS['hub']!.actions.includes(m[1]!) && !commands.some(c => c.at === m.index! - 'deskpost '.length)) commands.push({ at: m.index!, verb: 'hub', action: m[1]! });
      }
      for (const m of message.matchAll(/--mode (?:<x>|[a-z][a-z-]*)/g)) commands.push({ at: m.index!, verb: 'hub', action: 'edit' });
      commands.sort((a, b) => a.at - b.at);
      for (const m of message.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
        const option = m[1]!;
        if (SKIPPED_OPTIONS.has(option)) continue;
        const where = `${name}:${source.line(at[m.index!]!)}`;
        const before = commands.filter(c => c.at <= m.index!);
        const command = before[before.length - 1];
        if (command === undefined) {
          if (passedOn.test(message)) problems.push(`${where}: --${option} follows no command the message names, and kickoff receive passes this refusal on: ${message.slice(0, 160)}`);
          else if (!OWN_COMMAND[name]!.some(([verb, action]) => takes(verb, action, option))) problems.push(`${where}: --${option} is not an option of this file's own command: ${message.slice(0, 160)}`);
        } else if (!takes(command.verb, command.action, option)) problems.push(`${where}: --${option} is not an option of ${command.verb}${command.action ? ' ' + command.action : ''}: ${message.slice(0, 160)}`);
      }
    }
  }
  return problems;
}

/** The static check over this lane's refusals: each --option a remedy names is taken by the command it names (kickoffs/s219 row 4). */
async function section1561(): Promise<void> {
  const started = Date.now();
  const kernelSource = path.join(HERE, '..', 'src');
  const problems = await remedyProblems(kernelSource);
  same(problems, [], '1561: every remedy names a command that takes its option');
  // The check judges what it says it judges: a made-up refusal of each kind is caught.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-s219-remedy-'));
  try {
    for (const name of Object.keys(OWN_COMMAND)) fs.writeFileSync(path.join(scratch, name), '');
    fs.writeFileSync(path.join(scratch, 'hubedit.ts'), [
      "refuse('## Next holds one pending Run pointer. Tick it, or append with --supersedes.');",
      "refuse(`Use deskpost kickoff receive ${letter} --supersedes x.`);",
      "throw new HubEditRefusal('Run --frobnicate first.');",
      "refuse('Supply exactly one of --content or --content-path.');",
      "refuse(`Run deskpost hub edit ${slug} --mode check-item --match-text \"Run x:\".`);",
      "const NODE_VALUE_OPTIONS = ['--nope'];",
    ].join('\n'));
    const caught = await remedyProblems(scratch);
    equal(caught.length, 3, '1561: the planted refusals are caught: ' + JSON.stringify(caught));
    check(caught.some(line => line.startsWith('hubedit.ts:1: --supersedes follows no command')), '1561: an unnamed remedy passed on is caught');
    check(caught.some(line => line.startsWith('hubedit.ts:2: --supersedes is not an option of kickoff receive')), '1561: an option the named verb lacks is caught');
    check(caught.some(line => line.startsWith('hubedit.ts:3: --frobnicate is not an option of this file')), '1561: an option the file\'s own command lacks is caught');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  const took = Date.now() - started;
  console.log(`1561: the static check took ${took} ms`);
  check(took < 2000, `1561: the static check runs in under 2 seconds (${took} ms)`);
}

/** A receive into a full queue names the commands that clear it and the one to try again (kickoffs/s219 row 4). */
async function section1562(): Promise<void> {
  const w = await letterWorkspace('s219-receive-remedy');
  try {
    closeFixture(w, [], [runPointer('first', 'p1'), runPointer('first', 'p2'), runPointer('first', 'p3')]);
    makeDevHub(w.ws, 'first');
    const hub = path.join(w.ws, 'collection', 'projects', 'first', '_project.md');
    const before = fs.readFileSync(hub, 'utf8');
    const { letter } = await fileKickoffLetter(w, 'k4', kickoffText('k4'));
    const refused = w.cli(0, ['kickoff', 'receive', letter, '--json']);
    const said = refused.stdout + refused.stderr;
    check(refused.exit !== 0, '1562: the receive is refused: ' + said.slice(0, 400));
    check(said.includes('deskpost hub edit first --mode check-item --section Next --match-text "Run p1:"'), '1562: the refusal names the check-item command: ' + said.slice(0, 800));
    check(said.includes('deskpost hub edit first --mode append-section --section Next --supersedes "Run <old id>:" --content-path <file>'), '1562: the refusal names the --supersedes command: ' + said.slice(0, 800));
    check(said.includes(`Then run deskpost kickoff receive ${letter} again.`), '1562: the refusal names receive again: ' + said.slice(0, 800));
    check(!fs.existsSync(path.join(w.ws, 'collection', 'projects', 'first', 'kickoffs', 'k4.md')), '1562: no Kickoff page is written');
    equal(fs.readFileSync(hub, 'utf8'), before, '1562: no pointer is written');
    check(/^review: pending$/m.test(fs.readFileSync(w.file(letter), 'utf8')), '1562: the letter stays open');
  } finally { await w.dispose(); }
}

/** hub tidy's default reaches ticked items in sections that mix prose and lists, and never Decisions (kickoffs/s219 row 6). */
/** The meanwhile request carries the side-work lanes and the program's evidence for them. */
async function section1595(): Promise<void> {
  const w = await letterWorkspace('w46-meanwhile');
  try {
    const hub = (seat: string) => path.join(w.ws, 'collection', 'projects', seat);
    const firstRoot = path.join(hub('first'), '_project.md');
    const put = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    const open = w.cli(0, ['desk', 'open', 'project', 'second', '--seat', 'first']);
    equal(open.exit, 0, '1595: open the second builder Hub: ' + open.stderr);
    const reports = w.cli(0, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first']);
    equal(reports.exit, 0, '1595: open Reports: ' + reports.stderr);
    makeDevHub(w.ws, 'first');
    makeDevHub(w.ws, 'second');
    const own = fs.readFileSync(firstRoot, 'utf8').replace('A fixture repository.', '- Working tree: `' + w.root + '`');
    put(firstRoot, own.replace('## Next\n', '## Next\n\n' + runPointer('first', 'w47') + '\n'));
    put(path.join(hub('first'), 'kickoffs/w46.md'), '# Prepare the release\n\nTRAIN: one\n\nROWS:\n\nSTANDING ANSWERS:\n\n## Example\n');
    put(path.join(hub('first'), 'notes/2026-11-21-w46-a1.md'), '# First attempt\n\n## Run\n\n- State: started.\n');
    put(path.join(w.ws, 'internal/publication-journals/project-new-page-first-notes-2026-11-21-w46-a1-20200101-000000-fixture.json'), '{}');
    put(path.join(hub('second'), 'kickoffs/c170.md'), '# Triage reports\n\nROWS:\n');
    put(path.join(hub('second'), 'notes/2026-11-21-c170-a1.md'), '# Second attempt\n\n## Handback\n\nOutcome: pushed\nRan: fixture\n');
    const note = (date: string, title: string) => `---\ncaptured: 2026-11-21T${date}:00:00Z\nreview: pending\nfrom_seat: second\n---\n\n# ${title}\n`;
    put(w.file('notes/handback'), note('04', 'c170 handback: pushed'));
    const report = (name: string, date: string) => put(path.join(w.ws, 'shelf/reports/wiki/notes', name + '.md'), note(date, name));
    report('before', '03');
    report('first-after', '05');
    report('second-after', '06');

    const prepare = () => w.json(w.cli(0, ['meanwhile', 'prepare', '--seat', 'first', '--json']));
    const value = prepare();
    const request = String(value.request);
    check(request.startsWith('side work while first runs / second has handed back'), '1595: heading reflects both runs: ' + request.slice(0, 160));
    for (const phrase of [
      'Prepare the release [[projects/first/kickoffs/w46]]', 'notes/2026-11-21-w46-a1', 'Minutes running:',
      'notes/2026-11-21-c170-a1]] with a ## Handback', 'first-after', 'second-after', 'Written and not started: w47',
      'second: handed back', 'int/w46; never move it while the run lasts', 'desk/* commit follows this seat’s Hub Now',
      'Working tree: ' + w.root, 'Never touch a builder’s working tree or master',
      'Write a builder Hub only to add a Kickoff page and its one pointer', 'Ask Eric only for decisions, approvals, or credentials',
      'Review second’s handback', 'notes/<date>-c170-review-', 'Draft the next Kickoff in the Notebook',
      'write it to the Hub only on Eric’s word', 'Keep review notes in the Notebook', 'backlog’s candidates',
      'Read these Kickoff headings: TRAIN, ROWS, STANDING ANSWERS', 'Prepare the post-publish steps',
      'Gather asks for Eric from this seat’s Hub', 'Needs you report', 'pending Reports (3)', 'letters (0)',
      'Hub pages over their limit', 'Check closeout gaps and waits', 'at most 7 items', 'Give each a size',
      'make one recommendation', 'Start nothing until Eric picks',
    ]) check(request.includes(phrase), '1595: request includes ' + phrase);
    for (const phrase of ['PARTS', 'Example', 'release notices owed', 'backlog’s design queue', '(reports/notes/before)']) {
      check(!request.includes(phrase), '1595: request omits ' + phrase);
    }
    const running = value.runs?.find((run: { seat: string }) => run.seat === 'first');
    const handedBack = value.runs?.find((run: { seat: string }) => run.seat === 'second');
    equal(value.hub, 'first', '1595: caller Hub');
    equal(value.active?.length, 2, '1595: both runs active');
    equal(running?.kickoff, 'projects/first/kickoffs/w46', '1595: Kickoff page');
    equal(running?.title, 'Prepare the release', '1595: title comes from H1');
    equal(running?.tree, w.root, '1595: tree comes from ## Repo');
    equal(running?.branch, 'int/w46', '1595: unit branch');
    equal(running?.attempt_page, 'notes/2026-11-21-w46-a1', '1595: attempt page');
    check(running?.minutes_running > 0, '1595: elapsed minutes from the new-page journal');
    same(running?.waiting, ['w47'], '1595: waiting queue');
    same(running?.headings, ['TRAIN', 'ROWS', 'STANDING ANSWERS'], '1595: only actual Kickoff headings');
    equal(handedBack?.state, 'handed back', '1595: handed-back state');
    equal(handedBack?.minutes_running, null, '1595: no running minutes after a handback');
    same(handedBack?.late_reports?.map((entry: { title: string }) => entry.title), ['first-after', 'second-after'], '1595: only Reports after the handback');
    equal(value.others?.[0]?.state, 'handed back', '1595: other builder state');
    equal(value.counts?.reports, 3, '1595: pending Reports count');
    equal(value.counts?.letters, 0, '1595: pending letters count');
    check(typeof value.counts?.needs_you === 'number' && typeof value.counts?.hub_over_limit === 'number' && value.counts?.closeout,
      '1595: display report facts are present');
    check(value.problems?.some((entry: { problem: string }) => entry.problem.includes('names no working tree')), '1595: missing Repo tree is reported');
    check(value.problems?.some((entry: { source: string }) => entry.source === 'time rule'), '1595: absent verbatim time rule is reported');

    fs.appendFileSync(firstRoot, '\n## Notes\n\nA release notice is owed.\n');
    put(path.join(hub('first'), 'backlog.md'), '# Backlog\n');
    const withPages = String(prepare().request);
    check(withPages.includes('release notices owed'), '1595: show release notices when the Hub names one');
    check(withPages.includes('backlog’s design queue'), '1595: show design queue when the page exists');

    if (process.platform !== 'win32') {
      fs.chmodSync(firstRoot, 0);
      try {
        let readable = true;
        try { fs.readFileSync(firstRoot); } catch { readable = false; }
        if (readable) check(true, '1595: unreadable Project check skipped: this account can read mode 000');
        else {
          const unreadable = prepare();
          check(String(unreadable.request).includes('This seat’s Hub was not read'), '1595: unreadable Hub is named in the request');
          check(unreadable.problems?.some((entry: { source: string }) => entry.source === 'projects/first/_project'),
            '1595: unreadable Project page is named in problems');
        }
      } finally { fs.chmodSync(firstRoot, 0o600); }
    } else check(true, '1595: unreadable Project check skipped: Unix file modes are unavailable');
  } finally { await w.dispose(); }
}

async function section1596(): Promise<void> {
  const w = await letterWorkspace('w46-meanwhile-cli');
  try {
    const seatless = w.cli(2, ['meanwhile', 'prepare']);
    check(seatless.exit !== 0 && (seatless.stdout + seatless.stderr).includes('--seat'), '1596: seatless refusal names --seat: ' + seatless.stderr);
    const args = ['meanwhile', 'prepare', '--seat', 'first'];
    const result = w.json(w.cli(0, [...args, '--json']));
    const human = w.cli(0, args);
    equal(human.exit, 0, '1596: text succeeds: ' + human.stderr);
    equal(human.stdout.trimEnd(), String(result.request).trimEnd(), '1596: plain text and JSON agree');
    const help = w.cli(0, ['meanwhile', '--help']);
    check(help.exit === 0 && help.stdout.includes('meanwhile prepare'), '1596: help lists prepare');
  } finally { await w.dispose(); }
}

async function section1564(): Promise<void> {
  const w = await letterWorkspace('s219-tidy-reach');
  try {
    const fixture = closeFixture(w, ['- [x] Done in Now', '- [ ] Open in Now'], []);
    const notes = '## Notes\n\nA paragraph about the notes.\n\n- [x] Done in Notes\n  - its nested detail\n- [ ] Open in Notes\n\n## Decisions\n\n- [x] Decided thing\n';
    fs.writeFileSync(fixture.root, fixture.rootText().replace(/\n*$/, '\n\n') + notes);
    const preview = w.json(w.cli(0, ['hub', 'tidy', 'first', '--preflight', '--json']));
    const applied = w.cli(0, ['hub', 'tidy', 'first', '--user-confirmed', '--plan-id', String(preview['plan_id'] ?? ''), '--json']);
    equal(applied.exit, 0, '1564: the tidy applies: ' + (applied.stdout + applied.stderr).slice(0, 400));
    const root = fixture.rootText();
    check(!root.includes('- [x] Done in Now'), '1564: Now\'s ticked item moved');
    check(!root.includes('- [x] Done in Notes') && !root.includes('its nested detail'), '1564: Notes\' ticked item moved whole');
    check(root.includes('A paragraph about the notes.') && root.includes('- [ ] Open in Notes') && root.includes('- [ ] Open in Now'), '1564: the paragraph and the unticked items stay: ' + root);
    check(root.includes('## Decisions\n\n- [x] Decided thing'), '1564: Decisions\' ticked item stays: ' + root);
    const pages = fixture.history();
    equal(pages.length, 1, '1564: one history page: ' + pages.join(', '));
    const history = pages.length ? fixture.notesText(pages[0]!) : '';
    check(history.includes('- [x] Done in Now\n') && history.includes('- [x] Done in Notes\n  - its nested detail\n'), '1564: the history page holds both moved items word for word: ' + history);
    check(!history.includes('Decided thing'), '1564: nothing from Decisions is on the history page');
    const nothing = w.json(w.cli(0, ['hub', 'tidy', 'first', '--preflight', '--json']));
    check(String(nothing['message'] ?? '').includes('no ticked item in any section but Purpose and Decisions'), '1564: the nothing-selected message names what the default reaches: ' + JSON.stringify(nothing));
  } finally { await w.dispose(); }
}

/** deskpost hub notes <slug> lists a Hub's notes pages, newest first (kickoffs/s219 row 7). */
async function section1565(): Promise<void> {
  const w = await letterWorkspace('s219-hub-notes');
  try {
    const notes = path.join(w.ws, 'collection', 'projects', 'first', 'notes');
    fs.mkdirSync(notes, { recursive: true });
    const written: [string, string, number][] = [
      ['2026-11-01-alpha-a1', 'a', 5], ['2026-11-02-beta-a1', 'bb', 4], ['2026-11-03-alpha-history-tidy-1', 'ccc', 3],
      ['2026-11-04-Gamma-Report', 'dddd', 2], ['2026-11-05-beta-a2', 'eeeee', 1],
    ];
    for (const [name, text, hoursAgo] of written) {
      const file = path.join(notes, `${name}.md`);
      fs.writeFileSync(file, text);
      const at = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      fs.utimesSync(file, at, at);
    }
    const list = (extra: string[]) => {
      const ran = w.cli(0, ['hub', 'notes', 'first', ...extra, '--json']);
      let pages: { page: string; size_bytes: number; modified_utc: string }[] = [];
      try { pages = JSON.parse(ran.stdout).pages; } catch { pages = []; }
      return { exit: ran.exit, said: ran.stdout + ran.stderr, pages };
    };
    const all = list([]);
    equal(all.exit, 0, '1565: hub notes runs: ' + all.said.slice(0, 300));
    same(all.pages.map(page => page.page), ['notes/2026-11-05-beta-a2', 'notes/2026-11-04-Gamma-Report', 'notes/2026-11-03-alpha-history-tidy-1', 'notes/2026-11-02-beta-a1', 'notes/2026-11-01-alpha-a1'], '1565: every notes page, newest first');
    same(all.pages.map(page => page.size_bytes), [5, 4, 3, 2, 1], '1565: each page\'s size in bytes');
    check(all.pages.every(page => /^\d{4}-\d{2}-\d{2}T/.test(page.modified_utc)), '1565: each page\'s modification time');
    same(list(['--prefix', '2026-11-0']).pages.length, 5, '1565: a prefix every name has keeps all');
    same(list(['--prefix', 'notes/2026-11-01']).pages.map(page => page.page), ['notes/2026-11-01-alpha-a1'], '1565: a prefix after notes/ keeps the names starting with it');
    same(list(['--match', 'ALPHA']).pages.map(page => page.page), ['notes/2026-11-03-alpha-history-tidy-1', 'notes/2026-11-01-alpha-a1'], '1565: a match keeps the names containing it, ignoring case');
    same(list(['--match', 'gamma']).pages.map(page => page.page), ['notes/2026-11-04-Gamma-Report'], '1565: a match ignores the name\'s own case');
    const none = list(['--match', 'nothing-like-this']);
    equal(none.exit, 0, '1565: no match exits 0');
    same(none.pages, [], '1565: no match is an empty list');
    const text = w.cli(0, ['hub', 'notes', 'first']);
    check(text.exit === 0 && text.stdout.includes('projects/first: 5 notes pages, newest first') && text.stdout.includes('  notes/2026-11-05-beta-a2  5 bytes  '), '1565: the terminal view lists them: ' + text.stdout);
    const help = w.cli(0, ['hub', '--help']);
    check(help.stdout.includes('hub notes <slug>') && /Actions: .*\bnotes\b/.test(help.stdout), '1565: hub --help names notes: ' + help.stdout.slice(0, 300));
    equal(w.cli(0, ['desk', 'close', 'project', 'first', '--seat', 'first']).exit, 0, '1565: the Hub closes on the Desk');
    const closed = list([]);
    equal(closed.exit, 1, '1565: a Hub closed on the Desk is refused with exit 1, as hub history is');
    check(closed.said.includes('deskpost desk open project first'), '1565: the refusal names how to open it: ' + closed.said.slice(0, 300));
  } finally { await w.dispose(); }
}

/** new-page writes LF whatever the content file's line ends (kickoffs/s219 row 8). */
async function section1566(): Promise<void> {
  const w = await letterWorkspace('s219-new-page-lf');
  try {
    const body = ['# A page', '', 'First line.', 'Second line.', '', '- an item', ''];
    const sources: [string, string][] = [['lf', body.join('\n')], ['crlf', body.join('\r\n')]];
    const written: Record<string, Buffer> = {};
    for (const [name, text] of sources) {
      const file = path.join(w.root, `${name}.md`);
      fs.writeFileSync(file, text);
      const ran = w.cli(0, ['hub', 'edit', 'first', '--mode', 'new-page', '--page', `notes/2026-11-19-${name}`, '--content-path', file, '--json']);
      equal(ran.exit, 0, `1566: the ${name} page is written: ${(ran.stdout + ran.stderr).slice(0, 300)}`);
      let result: Record<string, unknown> = {};
      try { result = JSON.parse(ran.stdout); } catch { result = {}; }
      equal(result['proposed_sha256'], result['written_sha256'], `1566: the ${name} page's proposed_sha256 equals its written_sha256`);
      const page = path.join(w.ws, 'collection', 'projects', 'first', 'notes', `2026-11-19-${name}.md`);
      written[name] = fs.existsSync(page) ? fs.readFileSync(page) : Buffer.from('');
      check(written[name]!.length > 0 && !written[name]!.includes(0x0d), `1566: the ${name} page holds no carriage return`);
    }
    check(written['crlf']!.equals(written['lf']!), '1566: the page from a CRLF file holds the same bytes as the one from an LF file');
    // A lone CR stays a stray control character, refused with nothing written (section 152 holds the same).
    const lone = path.join(w.root, 'cr.md');
    fs.writeFileSync(lone, body.join('\r'));
    const refused = w.cli(0, ['hub', 'edit', 'first', '--mode', 'new-page', '--page', 'notes/2026-11-19-cr', '--content-path', lone, '--json']);
    check(refused.exit !== 0 && (refused.stdout + refused.stderr).includes('U+000D'), '1566: a lone-CR file is still refused as a stray control character: ' + (refused.stdout + refused.stderr).slice(0, 300));
    check(!fs.existsSync(path.join(w.ws, 'collection', 'projects', 'first', 'notes', '2026-11-19-cr.md')), '1566: the refused lone-CR page is not written');
  } finally { await w.dispose(); }
}

/** The stand-in Basic Memory server the Postbox sections use (selftest.ts `startFakeBasicMemory`), as a child process. */
async function startPostboxServer(folder: string): Promise<{ url: string; stop(): void }> {
  const portFile = path.join(os.tmpdir(), `kernel-fake-bm-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.port`);
  const child = spawn(process.execPath, [path.join(HERE, 'fake-basic-memory.ts'), folder, portFile], { stdio: 'ignore' });
  const until = Date.now() + 15000;
  while (!(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim())) {
    if (Date.now() > until) { child.kill(); throw new Error('the stand-in Basic Memory server did not start'); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const port = fs.readFileSync(portFile, 'utf8').trim();
  fs.rmSync(portFile, { force: true });
  return { url: `http://127.0.0.1:${port}/mcp`, stop: () => { try { child.kill(); } catch { /* already gone */ } } };
}

/** A letter to another Library keeps that Library's card on the sender's note, and `letters list --sent` names it (kickoffs/s219 row 9, review-nits-w28 part 1). */
async function section1567(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-s219-sent-card-')));
  const storage = path.join(root, 'server');
  fs.mkdirSync(storage, { recursive: true });
  const server = await startPostboxServer(storage);
  try {
    const env = { LIBRARY_WORKSPACES: path.join(root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACE: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const cli = (lib: string, args: string[], seat = '') => runCli([...args, '--workspace', lib], { cwd: root, env: { ...env, LIBRARY_SEAT: seat } });
    const json = (ran: { stdout: string }): Record<string, unknown> => { try { return JSON.parse(ran.stdout) as Record<string, unknown>; } catch { return {}; } };
    const library = (name: string, card: string, seat: string) => {
      const lib = path.join(root, name);
      equal(runCli(['init', lib], { cwd: root, env }).exit, 0, `1567: the fixture Library ${name} initialises`);
      equal(cli(lib, ['hub', 'new', `work-${seat}`, '--title', `Work ${seat}`]).exit, 0, `1567: ${name}'s fixture Hub is made`);
      equal(cli(lib, ['seat', 'start', seat, '--project', `work-${seat}`, '--no-launch']).exit, 0, `1567: ${name}'s fixture seat is made`);
      fs.writeFileSync(path.join(lib, '.claude', 'seats', seat, '.open-books'), 'shelf/letters\n');
      const pre = json(cli(lib, ['library', 'card', '--set', card, '--preflight', '--json']));
      equal(cli(lib, ['library', 'card', '--set', card, '--user-confirmed', '--plan-id', String(pre['plan_id'])]).exit, 0, `1567: ${name}'s card is set`);
      const setup = json(cli(lib, ['postbox', 'setup', '--url', server.url, '--preflight', '--json']));
      const applied = json(cli(lib, ['postbox', 'setup', '--url', server.url, '--user-confirmed', '--plan-id', String(setup['plan_id'] ?? ''), '--json']));
      check(applied['written'] === true, `1567: ${name}'s Postbox is set up: ${JSON.stringify(applied).slice(0, 300)}`);
      return lib;
    };
    const home = library('home', 'Home Office', 'asker');
    library('far', 'Far Office', 'clerk');
    const sent = cli(home, ['capture', 'letters', '--for', 'clerk', '--library', 'Far Office', '--title', 'A question', '--body', 'Could you look at this?', '--json'], 'asker');
    equal(sent.exit, 0, '1567: the letter to another Library is written: ' + (sent.stdout + sent.stderr).slice(0, 400));
    const page = String(json(sent)['note_page'] ?? '').replace(/^.*\/wiki\//, '').replace(/^notes\//, '');
    const note = fs.readFileSync(path.join(home, 'shelf', 'letters', 'wiki', 'notes', `${page}.md`), 'utf8');
    check(/\nfor_library_id: [0-9a-f-]{36}\nfor_library_card: Far Office\ndelivery_id: /.test(note), '1567: the sent note holds for_library_card after for_library_id: ' + note.slice(0, 700));
    const listed = cli(home, ['letters', 'list', '--sent', '--json'], 'asker');
    const letters = (json(listed)['letters'] as Record<string, unknown>[] | undefined) ?? [];
    check(letters.length === 1 && letters[0]!['for_library_card'] === 'Far Office', '1567: letters list --sent gives the card: ' + listed.stdout.slice(0, 400));
    const text = cli(home, ['letters', 'list', '--sent'], 'asker');
    check(text.stdout.includes('to clerk (Far Office): A question'), '1567: the sent letter\'s line names the card: ' + text.stdout.slice(0, 400));
  } finally {
    server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The TRAIN carries split also takes a full stop before a bare id (kickoffs/s219 row 9, review-nits-w28 part 4). */
async function section1568(): Promise<void> {
  const { trainProblems } = await import('../../src/kickoffcheck.ts');
  const register = (ids: string[]) => ({ schema: 1, items: ids.map(id => ({ id, status: 'open' })) });
  const train = 'TRAIN: x (lane:fixes; this unit also carries a. b)';
  same(trainProblems(train, register(['x', 'a', 'b'])), [], '1568: x, a and b are all read, and all open');
  const missingB = trainProblems(train, register(['x', 'a']));
  check(missingB.some(line => line.includes("'b'")) && !missingB.some(line => line.includes("'a'")), '1568: b, after the full stop, is read as an id: ' + JSON.stringify(missingB));
  const missingA = trainProblems(train, register(['x', 'b']));
  check(missingA.some(line => line.includes("'a'")) && !missingA.some(line => line.includes("'b'")), '1568: a, before the full stop, is read as an id: ' + JSON.stringify(missingA));
  same(trainProblems('TRAIN: x (lane:fixes; this unit also carries `a`. `b`)', register(['x', 'a', 'b'])), [], '1568: ids in backticks still split at a full stop');
}

async function section1590(): Promise<void> {
  const w = await letterWorkspace('w43-triager');
  try {
    const state = path.join(w.ws, 'internal', 'postbox', 'state.json');
    const local = '12121212-1212-4212-8212-121212121212';
    const far = '13131313-1313-4313-8313-131313131313';
    const pin = { library_id: local, seat: 'first' };
    const claimants = [pin, { library_id: far, seat: 'reviewer' }];
    const prepare = (who: number, triager: object, remedy?: string) => {
      const answer = w.json(w.cli(who, ['triage', 'prepare', '--json']));
      same(answer.triager, triager, '1590: triager comes from Postbox state');
      const problems = answer.problems ?? [];
      check(problems.every((problem: string) => problem.includes('deskpost')), '1590: all problems name a command');
      check(remedy ? problems.some((problem: string) => problem.includes(remedy)) : problems.length === 0,
        '1590: the expected triager remedy is present');
    };
    prepare(0, { state: 'none' }, 'deskpost reports triager');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    const write = (fields: object) => fs.writeFileSync(state, JSON.stringify({ schema: 1, library_id: local, ...fields }));
    write({});
    prepare(0, { state: 'none' }, 'deskpost reports triager');
    write({ reports_triager: pin });
    prepare(0, { state: 'this-seat' });
    prepare(1, { state: 'other-seat', seat: 'first' }, 'deskpost reports triager');
    write({ reports_triager: claimants[1], entries_seen: [{ library_id: far, library_card: 'far' }] });
    prepare(0, { state: 'other-library', library_id: far, library_card: 'far', seat: 'reviewer' }, 'deskpost reports send-pending');
    write({ reports_triager: pin, reports_triager_conflict: { claimants } });
    prepare(0, { state: 'conflict', claimants }, 'deskpost reports triager --follow');
    fs.writeFileSync(state, 'damaged');
    prepare(0, { state: 'unknown' }, 'deskpost postbox status');
  } finally { await w.dispose(); }
}

async function section1591(): Promise<void> {
  const w = await letterWorkspace('w43-reports');
  try {
    for (const who of [0, 1]) {
      equal(w.cli(who, ['desk', 'open', 'book', 'reports', '--location', 'shelf']).exit, 0, '1591: Reports open');
    }
    const capture = (who: number, title: string): string => {
      const report = w.json(w.cli(who, ['capture', 'reports', '--local', '--title', title, '--body', 'Fixture report', '--json']));
      return String(report.page ?? String(report.note_page).replace(/^.*\/wiki\//, ''));
    };
    const first = capture(0, 'First report');
    const second = capture(1, 'Second report');
    const suspected = capture(0, 'sUsPeCtEd fixture report');
    const suspectedFile = path.join(w.ws, 'shelf', 'reports', 'wiki', suspected + '.md');
    fs.writeFileSync(suspectedFile, fs.readFileSync(suspectedFile, 'utf8').replace('review: pending',
      'review: pending\nfrom_library_id: 13131313-1313-4313-8313-131313131313\nfrom_library_card: Far Library'));

    const record = 'projects/first/notes/held-review';
    const actions = JSON.stringify([{ kind: 'hold', source: 'holding', source_slug: 'reports', source_page: first, record }]);
    const batch = ['triage', 'batch', '--actions', actions, '--json'];
    const plan = w.json(w.cli(0, [...batch, '--preflight']));
    w.json(w.cli(0, [...batch, '--user-confirmed', '--plan-id', String(plan.plan_id)]));

    const prepare = () => w.json(w.cli(0, ['triage', 'prepare', '--json']));
    const noRegister = prepare();
    equal(noRegister.train, null, '1591: no train register');
    same(noRegister.reports?.map((report: any) => report.train_items), [[], [], []], '1591: no register gives empty matches');
    const add = (id: string, title: string, source: string) =>
      w.json(w.cli(0, ['train', 'add', id, '--title', title, '--place', 'running', '--source', source, '--json']));
    const doneTitle = 'Fix ' + second.replace(/^notes\//, '');
    add('first-fix', 'First fix', 'reports/' + first);
    add('second-fix', doneTitle, 'fixture');
    w.json(w.cli(0, ['train', 'close', 'second-fix', '--done', '--note', 'Landed as abc123', '--json']));
    const note = 'Resolves ' + suspected;
    add('note-fix', 'Note fix', 'fixture');
    w.json(w.cli(0, ['train', 'close', 'note-fix', '--done', '--note', note, '--json']));
    add('first-follow-up', 'First follow-up', 'reports/' + first);

    const answer = prepare();
    equal(answer.report_count, 3, '1591: three pending Reports');
    equal(answer.held_count, 1, '1591: one held Report');
    const reports = new Map<string, any>(answer.reports?.map((report: any) => [report.page, report]) ?? []);
    const fields = (page: string) => {
      const { received, filed_by_this_seat, suspected, train_items } = reports.get(page) ?? {};
      return { received, filed_by_this_seat, suspected, train_items };
    };
    same(fields(first), { received: false, filed_by_this_seat: true, suspected: false,
      train_items: [
        { id: 'first-fix', title: 'First fix', status: 'open', place: 'running', note: '' },
        { id: 'first-follow-up', title: 'First follow-up', status: 'open', place: 'running', note: '' },
      ] }, '1591: local filer and source match');
    same(fields(second), { received: false, filed_by_this_seat: false, suspected: false,
      train_items: [{ id: 'second-fix', title: doneTitle, status: 'done', place: 'running', note: 'Landed as abc123' }] }, '1591: other filer and done title match');
    same(fields(suspected), { received: true, filed_by_this_seat: false, suspected: true,
      train_items: [{ id: 'note-fix', title: 'Note fix', status: 'done', place: 'running', note }] }, '1591: received and suspected');
    check(Boolean(reports.get(first)?.held), '1591: held date is present');
    equal(reports.get(first)?.held_record, record, '1591: hold names its record');

    fs.writeFileSync(path.join(w.ws, 'internal', 'train', 'register.json'), 'damaged');
    const damaged = prepare();
    same(damaged.reports?.map((report: any) => report.train_items), [null, null, null], '1591: unreadable register gives unknown matches');
    check(damaged.problems?.some((problem: string) => problem.includes('deskpost train --json')), '1591: unreadable register names its remedy');
    check(damaged.problems?.every((problem: string) => problem.includes('deskpost')), '1591: all problems name a command');
  } finally { await w.dispose(); }
}

async function section1592(): Promise<void> {
  const w = await letterWorkspace('w43-program');
  try {
    const version = w.json(runCli(['--version'])).binary_version;
    check(typeof version === 'string' && version.length > 0, '1592: the program reports a version');
    const answer = w.json(w.cli(0, ['triage', 'prepare', '--json']));
    same(answer.program, { version, tag: 'v' + version }, '1592: prepare gives the installed version and private source tag');
  } finally { await w.dispose(); }
}

async function section1593(): Promise<void> {
  const w = await letterWorkspace('w43-record');
  try {
    const hub = 'projects/first';
    const page = path.join(w.ws, 'collection', hub, 'classes.md');
    const prepare = () => w.json(w.cli(0, ['triage', 'prepare', '--json']));
    const empty = { hub, classes_page: null, classes: null, fields: [] };
    same(prepare().record, empty, '1593: no classes page means no class fields');
    fs.writeFileSync(page, '# Classes\n\n## First class\n\nState: due (seeded for the test)\n\n## Second class\n\nNo state.');
    same(prepare().record, {
      hub, classes_page: hub + '/classes',
      classes: [{ name: 'First class', state: 'due' }, { name: 'Second class', state: null }],
      fields: ['Class', 'Missed by'],
    }, '1593: the Hub supplies class names, states and verdict fields');

    equal(w.cli(0, ['desk', 'close', 'project', 'first']).exit, 0, '1593: close the Hub');
    const closed = prepare();
    same(closed.record, empty, '1593: a closed Hub does not disclose the classes page');
    check(closed.problems?.some((problem: string) => problem.includes('deskpost desk open project first')), '1593: the closed Hub names its remedy');
    check(closed.problems?.every((problem: string) => problem.includes('deskpost')), '1593: all problems name a command');
  } finally { await w.dispose(); }

  const unreadable = await letterWorkspace('w44-unreadable-desk');
  try {
    const desk = path.join(unreadable.ws, '.claude', 'seats', 'first', '.open-projects');
    fs.writeFileSync(path.join(unreadable.ws, 'collection', 'projects/first', 'classes.md'),
      '# Classes\n\n## First class\n\nState: due (seeded for the test)\n');
    const readable = unreadable.json(unreadable.cli(0, ['triage', 'prepare', '--json']));
    equal(readable.record?.classes_page, 'projects/first/classes', '1593: the readable Desk finds the classes page');
    same(readable.record?.classes, [{ name: 'First class', state: 'due' }], '1593: the readable Desk supplies the seeded class');
    let unlock: () => void;
    if (process.platform === 'win32') {
      const { openShareNothing } = await import('../../src/seatclaim.ts');
      const handle = openShareNothing(desk);
      unlock = () => handle.close();
    } else {
      fs.chmodSync(desk, 0);
      unlock = () => fs.chmodSync(desk, 0o600);
    }
    try {
      if (process.platform !== 'win32') {
        let readable = true;
        try { fs.readFileSync(desk); } catch { readable = false; }
        if (readable) {
          check(true, '1593: unreadable Desk case skipped: this account can read mode 000');
          return;
        }
      }
      const result = unreadable.cli(0, ['triage', 'prepare', '--json']);
      equal(result.exit, 0, '1593: prepare answers with an unreadable Desk: ' + result.stdout + result.stderr);
      if (result.exit !== 0) return;
      const answer = unreadable.json(result);
      equal(answer.record?.classes_page, null, '1593: unknown Desk leaves the classes page unknown');
      equal(answer.record?.classes, null, '1593: unknown Desk leaves classes unknown');
      equal(answer.problems?.filter((problem: string) => problem.includes('deskpost desk names the fault')).length,
        1, '1593: the unreadable Desk names its remedy once');
    } finally { unlock(); }
  } finally { await unreadable.dispose(); }
}

async function section1594(): Promise<void> {
  const w = await letterWorkspace('w43-prepare-help');
  try {
    const seatless = w.cli(2, ['triage', 'prepare', '--json']);
    equal(seatless.exit, 1, '1594: seatless prepare refuses');
    const refusal = JSON.parse(seatless.stdout.trim() || '{}');
    check(JSON.stringify(refusal).includes('needs a seat'), '1594: JSON refusal names the missing seat');

    for (const [word, reason] of [['stray', /takes no words/i], ['--no-such-option', /has no --no-such-option/i]] as const) {
      const result = w.cli(0, ['triage', 'prepare', word]);
      equal(result.exit, 1, '1594: prepare refuses ' + word);
      check(reason.test(result.stderr + result.stdout) && (result.stderr + result.stdout).includes(word), '1594: refusal names ' + word);
    }

    const help = w.cli(0, ['triage', '--help']);
    equal(help.exit, 0, '1594: triage help succeeds');
    check(help.stdout.includes('|prepare|') && help.stdout.includes('prepare lists, from this Library'), '1594: help gives usage and details');
    const reference = fs.readFileSync(path.join(PROGRAM_ROOT, '.claude', 'skills', 'library-help', 'references', 'capture-and-triage.md'), 'utf8');
    check(reference.includes('Before a triage, library triage prepare') && /a source it cannot read is a named problem/i.test(reference), '1594: library-help describes prepare');

    for (const book of ['reports', 'holding']) {
      equal(w.cli(0, ['desk', 'open', 'book', book, '--location', 'shelf']).exit, 0, '1594: open ' + book);
    }
    const report = w.json(w.cli(0, ['capture', 'reports', '--local', '--title', 'Local verdict', '--body', 'Fixture Report', '--json']));
    const holding = w.json(w.cli(0, ['capture', 'holding', '--title', 'Held note', '--body', 'Fixture note', '--json']));
    const reportPage = report.page ?? String(report.note_page).replace(/^.*\/wiki\//, '');
    const action = { kind: 'review', source: 'holding', source_slug: 'reports', source_page: reportPage, outcome: 'confirmed' };
    const validate = (label: string, fields: object) => {
      const result = w.cli(0, ['triage', 'validate', '--actions', JSON.stringify([{ ...action, ...fields }]), '--json']);
      equal(result.exit, 1, '1594: validate refuses ' + label);
      return result.stdout + result.stderr;
    };
    const original = 'outcome and outcome_note are fields only a review close of a received Report takes.';
    const local = validate('local Report close', { outcome_note: 'x' });
    check(local.includes(original) && local.includes('deskpost triage prepare'), '1594: the local Report close names the verdict record: ' + local);
    for (const [label, fields] of [
      ['local Report hold', { kind: 'hold', record: 'projects/first/notes/held-review' }],
      ['local Report reopen', { reopen: true }],
      ['Holding note close', { source_slug: 'holding', source_page: holding.page }],
    ] as const) {
      const message = validate(label, fields);
      check(message.includes(original) && !message.includes('triage prepare'), '1594: the refusal is unchanged for ' + label + ': ' + message);
    }
    check(help.stdout.includes("A local Report's close takes neither; its verdict goes on the triaging seat's Hub record, which triage prepare names."),
      '1594: help names the local verdict record');
    check(reference.includes("A local Report's close refuses those fields; its verdict goes on the triaging seat's Hub record, which `library triage prepare` names (`record.hub`)."),
      '1594: library-help names the local verdict record');

    const registryPath = path.join(w.ws, '.claude', 'seats', '_registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.seats = registry.seats.filter((entry: { seat: string }) => entry.seat !== 'first');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const noHub = w.json(w.cli(0, ['triage', 'prepare', '--json']));
    equal(noHub.hub, null, '1594: no Hub registered for this seat');
    check(noHub.problems?.some((problem: string) => problem.includes('deskpost seat status first')), '1594: missing Hub names its remedy');
  } finally { await w.dispose(); }
}

/** append-section adds to one ### subsection (kickoffs/s219 row 5). */
async function section1563(): Promise<void> {
  const w = await letterWorkspace('s219-subsection');
  try {
    const fixture = closeFixture(w, [], []);
    const notes = '## Notes\n\nIntro line.\n\n### A\n\n- a1\n\n### B\n\nPara b.\n\n### C\n\n- c1\n';
    const base = fixture.rootText().replace(/\n*$/, '\n\n') + notes;
    fs.writeFileSync(fixture.root, base);
    const append = (subsection: string, content: string, extra: string[] = []) =>
      w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Notes', '--subsection', subsection, '--content', content, ...extra, '--json']);
    const first = append('A', '- a2');
    equal(first.exit, 0, '1563: append to the first subsection: ' + (first.stdout + first.stderr).slice(0, 400));
    equal(fixture.rootText(), base.replace('### A\n\n- a1\n\n### B', '### A\n\n- a1\n- a2\n\n### B'), '1563: the item joins the first subsection\'s list, before ### B, and nothing else changes');
    const afterFirst = fixture.rootText();
    const last = append('### C', 'Para c.');
    equal(last.exit, 0, '1563: append to the last subsection: ' + (last.stdout + last.stderr).slice(0, 400));
    equal(fixture.rootText(), afterFirst.replace(/### C\n\n- c1\n$/, '### C\n\n- c1\n\nPara c.\n'), '1563: the paragraph ends the last subsection, and nothing else changes');
    const unchanged = fixture.rootText();
    const missing = append('D', '- d1');
    const missingSaid = missing.stdout + missing.stderr;
    check(missing.exit !== 0 && missingSaid.includes("holds no subsection '### D'") && missingSaid.includes("'A', 'B', 'C'"), '1563: a missing heading is refused naming the subsections: ' + missingSaid.slice(0, 400));
    const both = w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Next', '--subsection', 'A',
      '--content', '- [ ] Run x9: [[projects/first/kickoffs/x9]]', '--supersedes', 'Run x1:', '--json']);
    check(both.exit !== 0 && (both.stdout + both.stderr).includes('--subsection cannot be used with --supersedes'), '1563: --subsection with --supersedes is refused: ' + (both.stdout + both.stderr).slice(0, 400));
    equal(fixture.rootText(), unchanged, '1563: the refused edits wrote nothing');
    fs.writeFileSync(fixture.root, unchanged + '\n### B\n\n- b2\n');
    const doubled = append('B', '- b3');
    const doubledSaid = doubled.stdout + doubled.stderr;
    check(doubled.exit !== 0 && doubledSaid.includes("'### B' 2 times") && doubledSaid.includes("'A', 'B', 'C', 'B'"), '1563: a doubled heading is refused naming the subsections: ' + doubledSaid.slice(0, 400));
    equal(fixture.rootText(), unchanged + '\n### B\n\n- b2\n', '1563: the doubled case wrote nothing');
  } finally { await w.dispose(); }
}

async function section1509(): Promise<void> {
  const { readNeedsYou } = await import('../../src/needsyou.ts');
  const { pageComparisonSha256 } = await import('../../src/sha.ts');
  const w = await letterWorkspace('s213-queue-end-to-end');
  try {
    makeDevHub(w.ws, 'first');
    const c = await chainFixture(w);
    const hubDir = path.join(w.ws, 'collection', 'projects', 'first');
    const edit = (args: string[]) => w.cli(0, ['hub', 'edit', 'first', ...args, '--json']);
    // deskpost-lead-style posting: the page with new-page, then its pointer with the page's sha256.
    for (const id of ['p1', 'p2']) {
      const file = path.join(w.root, `${id}.md`);
      fs.writeFileSync(file, kickoffText(id, 'Revision: **r1**.\nCHAIN: yes\n\n'));
      const posted = edit(['--mode', 'new-page', '--page', `kickoffs/${id}`, '--content-path', file]);
      equal(posted.exit, 0, `1509: posting kickoffs/${id}: ${posted.stderr.slice(0, 300)}`);
      const sha = pageComparisonSha256(fs.readFileSync(path.join(hubDir, 'kickoffs', `${id}.md`), 'utf8'));
      w.json(edit(['--mode', 'append-section', '--section', 'Next', '--content', `- [ ] Run ${id}: [[projects/first/kickoffs/${id}]] (r1, sha256 \`${sha}\`, base \`0000000\`, posted; a fixture)`]));
    }
    const received = await fileKickoffLetter(w, 'k3', kickoffText('k3'));
    equal(w.cli(0, ['kickoff', 'receive', received.letter, '--json']).exit, 0, '1509: receiving k3 appends the third pointer');
    const open = (id: string) => w.cli(0, ['kickoff', 'check', '--open', id]).exit;
    same(['p1', 'p2', 'k3'].map(open), [0, 1, 1], '1509: only the first queued pointer opens');
    const needs = () => readNeedsYou(w.ws).sections.find(section => section.key === 'kickoffs')!.items.filter(item => item.seat === 'first').map(item => item.text);
    same(needs(), ['first: p1, waiting for you to start the seat and say yes.', 'first: 2 more queued'], '1509: needs-you before the first starts');
    w.json(edit(['--mode', 'check-item', '--section', 'Next', '--match-text', 'Run p1:']));
    same(needs(), ['first: p2, waiting for you to start the seat and say yes.', 'first: 1 more queued'], '1509: needs-you after the first is ticked');
    same(['p2', 'k3'].map(open), [0, 1], '1509: after the tick the second opens');
    fs.mkdirSync(path.join(hubDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'notes', '2026-11-17-p1-a1.md'),'# p1 attempt 1\n\n## Handback\n\nOutcome: done\nRan: kickoffs/p1 r1\n');
    c.closeout('done', [c.attemptWrite('notes/2026-11-17-p1-a1')]);
    const next = c.next('42');
    check(next['decision'] === 'start' && next['id'] === 'p2', `1509: kickoff next after a done, chained p1 starts p2: ${JSON.stringify(next)}`);
  } finally { await w.dispose(); }
}

async function withReadingFixture(section: number, run: (fixture: ReturnType<typeof readingFixture>) => Promise<void> | void): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kernel-${section}-`)));
  try {
    await run(readingFixture(root, section));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readingFixture(root: string, section: number) {
  const env = { LIBRARY_WORKSPACES: path.join(root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', LIBRARY_WORKSPACE: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
  const cli = (lib: string, args: string[], seat = '') => runCli([...args, '--workspace', lib], { cwd: root, env: { ...env, LIBRARY_SEAT: seat } });
  const json = (ran: ReturnType<typeof cli>): Record<string, unknown> => {
    equal(ran.exit, 0, `${section}: command succeeds: ${ran.stderr}`);
    try { return JSON.parse(ran.stdout) as Record<string, unknown>; } catch { return {}; }
  };
  const library = (seat: string, card?: string, url?: string) => {
    const lib = path.join(root, seat);
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, `${section}: ${seat}'s Library initialises`);
    equal(cli(lib, ['hub', 'new', `work-${seat}`, '--title', `Work ${seat}`]).exit, 0, `${section}: ${seat}'s Hub is made`);
    equal(cli(lib, ['seat', 'start', seat, '--project', `work-${seat}`, '--no-launch']).exit, 0, `${section}: ${seat} is made`);
    fs.writeFileSync(path.join(lib, '.claude', 'seats', seat, '.open-books'), 'shelf/letters\nshelf/holding\n');
    if (card && url) {
      const pre = json(cli(lib, ['library', 'card', '--set', card, '--preflight', '--json']));
      equal(cli(lib, ['library', 'card', '--set', card, '--user-confirmed', '--plan-id', String(pre['plan_id'])]).exit, 0, `${section}: ${seat}'s card is set`);
      const setup = json(cli(lib, ['postbox', 'setup', '--url', url, '--preflight', '--json']));
      const applied = json(cli(lib, ['postbox', 'setup', '--url', url, '--user-confirmed', '--plan-id', String(setup['plan_id']), '--json']));
      check(applied['written'] === true, `${section}: ${seat}'s Postbox is set up`);
    }
    return lib;
  };
  const notes = (lib: string) => path.join(lib, 'shelf', 'letters', 'wiki', 'notes');
  const files = (lib: string) => fs.existsSync(notes(lib)) ? fs.readdirSync(notes(lib)) : [];
  const server = async () => {
    const storage = path.join(root, 'server');
    fs.mkdirSync(storage);
    return startPostboxServer(storage);
  };
  return { root, cli, json, library, notes, files, server };
}

async function section1580(): Promise<void> {
  await withReadingFixture(1580, async t => {
    const local = t.library('local');
    check(!Object.hasOwn(t.json(t.cli(local, ['letters', 'list', '--json'], 'local')), 'postbox'), '1580: no Postbox gives no JSON field');
    equal(t.cli(local, ['letters', 'list'], 'local').stdout.trim(), "No open letters for seat 'local'.", '1580: no Postbox leaves the text alone');

    const server = await t.server();
    try {
      const home = t.library('asker', 'Home Office', server.url);
      const far = t.library('clerk', 'Far Office', server.url);
      const sent = t.json(t.cli(home, ['capture', 'letters', '--for', 'clerk', '--library', 'Far Office',
        '--title', 'A new letter', '--body', 'Please read this.', '--json'], 'asker'));
      const listed = t.json(t.cli(far, ['letters', 'list', '--json'], 'clerk'));
      const letters = listed['letters'] as Record<string, unknown>[] | undefined;
      check(letters?.some(letter => letter['title'] === 'A new letter' && letter['delivery_id'] === sent['delivery_id']) ?? false,
        '1580: letters list finds the delivery without an earlier Postbox check');
      const postbox = listed['postbox'] as Record<string, unknown> | undefined;
      check(postbox?.['checked'] === true && postbox['filed'] === 1, '1580: JSON reports a successful check that filed one letter');

      const offline = t.library('offline', 'Offline Office', server.url);
      equal(t.cli(offline, ['capture', 'letters', '--for', 'offline', '--title', 'Already filed', '--body', 'Local text.'], 'offline').exit,
        0, '1580: a local letter is filed for the offline case');
      const stateFile = path.join(offline, 'internal', 'postbox', 'state.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const lastCheck = '2026-11-19T12:00:00Z';
      const { createServer } = await import('node:net');
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const address = reservation.address();
      if (!address || typeof address === 'string') throw new Error('no local port reserved');
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, url: `http://127.0.0.1:${address.port}/mcp`, last_check: lastCheck }));
      const start = performance.now();
      const unreachable = t.cli(offline, ['letters', 'list'], 'offline');
      check(unreachable.exit === 0 && performance.now() - start < 30000 && unreachable.stdout.includes('Already filed'),
        '1580: a closed port leaves the earlier letter readable within the child limit');
      check(unreachable.stdout.includes('Postbox not reached') && unreachable.stdout.includes(lastCheck),
        '1580: a closed port is reported with the last successful check time');
    } finally {
      server.stop();
    }
  });
}

async function section1581(): Promise<void> {
  const { openVerdict } = await import('../../src/kickoffcheck.ts');
  const remedy = (text: string) => text.startsWith('projects/') && text.includes('has no pending Run pointer')
    && text.includes('deskpost letters list') && text.includes('deskpost kickoff receive');
  const verdict = openVerdict([], 'second', 's1');
  check(verdict.message.startsWith('projects/second has no pending Run pointer') && remedy(verdict.message),
    '1581: the no-pointer verdict names how to find and receive a Kickoff letter');
  await withReadingFixture(1581, async t => {
    const server = await t.server();
    try {
      const home = t.library('asker', 'Home Office', server.url);
      const far = t.library('clerk', 'Far Office', server.url);
      const page = path.join(home, 'collection', 'projects', 'work-asker', 'kickoffs', 'k1.md');
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.writeFileSync(page, `# k1 kickoff\n\nTRAIN: filled\nWHY NOW: filled\nSIZE: filled\nOWNS: filled\nOWNS PATHS:\n- \x60a.ts\x60\nSTAY OUT OF: filled\nWHERE THINGS STAND: filled\nMERGE: filled\nROWS:\n1. **A row**: change a.\n   Done when: section 1 passes.\nCOMMANDS: filled\nCHARTER: filled\nNOT CHARTERED: filled\nRULES: filled\nSTANDING ANSWERS: filled\nOPEN: filled\nCLOSE:\n- **Stop.**\n`);
      const sent = t.json(t.cli(home, ['kickoff', 'send', 'kickoffs/k1', '--library', 'Far Office', '--for', 'clerk', '--json'], 'asker'));
      const opened = t.cli(far, ['kickoff', 'check', '--open', 'k1'], 'clerk');
      check(opened.exit === 1 && remedy((opened.stderr || opened.stdout).trim()),
        '1581: checking before receiving gives the remedy: ' + opened.stdout + opened.stderr);
      const delivery = String(sent['delivery_id'] ?? '');
      const name = t.files(far).find(file => fs.readFileSync(path.join(t.notes(far), file), 'utf8').includes(`\ndelivery_id: ${delivery}\n`));
      check(typeof name === 'string' && delivery !== '', '1581: kickoff check itself already filed the delivery');
      const listed = t.json(t.cli(far, ['letters', 'list', '--json'], 'clerk'));
      const letters = listed['letters'] as Record<string, unknown>[] | undefined;
      check(letters?.some(letter => letter['delivery_id'] === delivery) ?? false, '1581: letters list shows the Kickoff letter');
      if (!name) return;
      const received = t.json(t.cli(far, ['kickoff', 'receive', `notes/${name.replace(/\.md$/, '')}`, '--json'], 'clerk'));
      check(String(received['pointer']).includes('Run k1:'), '1581: receiving the letter creates a pointer');
      equal(t.cli(far, ['kickoff', 'check', '--open', 'k1'], 'clerk').exit, 0, '1581: the received Kickoff can be opened');
    } finally {
      server.stop();
    }
  });
}

async function section1582(): Promise<void> {
  await withReadingFixture(1582, t => {
    const lib = t.library('reader');
    const send = (content: string[]) => t.cli(lib, ['capture', 'letters', '--for', 'reader', ...content], 'reader');
    const bodyFile = path.join(t.root, 'body.md');
    fs.writeFileSync(bodyFile, '# Only a heading\n\n');
    for (const content of [['--body', '# Only a heading'], ['--content-path', bodyFile]]) {
      const before = t.files(lib);
      const ran = send(content);
      check(ran.exit !== 0 && (ran.stdout + ran.stderr).includes('pass --content-path'), `1582: heading alone via ${content[0]} is refused with the remedy`);
      same(t.files(lib), before, `1582: heading alone via ${content[0]} writes no letter`);
    }
    fs.writeFileSync(bodyFile, '# A heading\n\nA line of text.\n');
    const written = send(['--content-path', bodyFile, '--json']);
    t.json(written);
    check(t.files(lib).some(name => fs.readFileSync(path.join(t.notes(lib), name), 'utf8').includes('# A heading\n\nA line of text.')),
      '1582: a letter with a heading and text is written');
    const holding = t.json(t.cli(lib, ['capture', 'holding', '--title', 'T', '--body', 'text', '--json'], 'reader'));
    check(typeof holding['note_page'] === 'string', '1582: a Holding Shelf note with text is written');
  });
}

async function section1583(): Promise<void> {
  await withReadingFixture(1583, t => {
    const lib = t.library('reader');
    const before = t.files(lib);
    const ran = t.cli(lib, ['capture', 'letters', '--answers', 'notes/question', '--library', 'Far Office',
      '--title', 'T', '--body', 'x'], 'reader');
    check(ran.exit !== 0 && (ran.stdout + ran.stderr).includes('--answers notes/<page> alone'),
      '1583: the refusal explains that --answers alone routes a reply');
    same(t.files(lib), before, '1583: the refused answer writes no letter');
  });
}

/** Shared records receive advice from every item naming them, in first-named order. */
async function section1584(): Promise<void> {
  const w = await letterWorkspace('c168-item-advice');
  try {
    writeTrain(w.ws, [['t-a', 'done', 'car:one'], ['t-b', 'open', 'car:one']], 'car:one');
    const letter = String(w.capture(1, ['--for', 'first', '--title', 'Closed record'])['page']);
    equal(w.cli(0, ['letters', 'close', letter]).exit, 0, '1584: the letter closes');
    const records = [
      { name: '`t-a`', source: 'train:t-a', state: 'train t-a: done' },
      { name: 'kickoffs/k1', source: 'projects/first/_project ## Next Run k1', state: 'kickoffs/k1: ticked' },
      { name: letter, source: `letters/${letter}`, state: `letter ${letter}: closed` },
    ];
    const next = ['- [x] Run k1: [[projects/first/kickoffs/k1]]'];
    for (const record of records) {
      for (const scenario of ['later qualifies', 'alone', 'ticked first']) {
        const a = `- [ ] A names ${record.name}. Closes when \`t-b\` closes.`;
        const now = scenario === 'alone' ? [a] : scenario === 'ticked first'
          ? [`- [x] Done names ${record.name}`, a] : [a, `- [ ] B names ${record.name}`];
        closeFixture(w, now, next);
        const status = await hubStatusOf(w, 0, 'first');
        equal(status.exit, 0, `1584: status succeeds for ${record.name}, ${scenario}`);
        const lines = status.lines.filter(line => line.group === 'pointers' && line.source === record.source);
        equal(lines.length, 1, `1584: ${record.name} appears once for ${scenario}`);
        equal(lines[0]?.text, record.state + (scenario === 'later qualifies' ? '; closed: tick or close this item' : ''),
          `1584: ${record.name} advice considers every item for ${scenario}`);
      }
    }
    closeFixture(w, [`- [ ] First ${letter}, then kickoffs/k1, then \`t-a\`. Closes when \`t-b\` closes.`,
      `- [ ] Later ${letter}, kickoffs/k1, \`t-a\``], next);
    const status = await hubStatusOf(w, 0, 'first');
    same(status.lines.filter(line => line.group === 'pointers').map(line => line.source),
      ['train:t-a', 'train:t-b', 'projects/first/_project ## Next Run k1', `letters/${letter}`],
      '1584: record lines retain their first-named order');
  } finally { await w.dispose(); }
}


/** Notes pointers must be shown text, and long revision names keep their pending state. */
async function section1585(): Promise<void> {
  const { hubStatusText } = await import('../../src/hubstatus.ts');
  const id = 'a' + 'long-name-'.repeat(7).slice(0, 68) + 'z';
  equal(id.length, 70, '1585: the revision id has 70 characters');
  const text = hubStatusText({ schema: 1, operation: 'Hub status', hub: 'projects/first', seat: 'first', lines: [
    { group: 'pointers', source: 'projects/first/_project', text: `kickoffs/${id}: pending; newer revision kickoffs/${id}-r2 posted` },
  ] });
  check(text.split('\n').every(line => line.length <= 69), '1585: revision lines fit 69 columns');
  check(text.includes('pending;'), '1585: pending state is whole: ' + text);
  check(text.split('\n').some(line => line.startsWith('  kickoffs/a') && line.includes('z: pending;')),
    '1585: the shortened name retains its first and last characters: ' + text);
  const w = await letterWorkspace('c168-shown-pointer');
  try {
    const fixture = closeFixture(w, [], []);
    const kickoffs = path.join(fixture.hubDir, 'kickoffs'), notes = path.join(fixture.hubDir, 'notes');
    fs.mkdirSync(kickoffs, { recursive: true });
    fs.mkdirSync(notes, { recursive: true });
    const file = path.join(kickoffs, 'p3.md'), history = path.join(notes, 'history.md');
    fs.writeFileSync(file, '# p3\n');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    const pointer = '- [x] Run p3: [[projects/first/kickoffs/p3]]';
    for (const hidden of ['```\n' + pointer + '\n```', '<!--\n' + pointer + '\n-->']) {
      fs.writeFileSync(history, '# History\n\n' + hidden + '\n');
      const status = await hubStatusOf(w, 0, 'first');
      equal(status.exit, 0, '1585: hidden pointer status succeeds');
      check(status.lines.some(line => line.text === 'kickoffs/p3: no Run pointer names it'),
        '1585: a hidden example does not name the orphan: ' + hidden);
    }
    fs.writeFileSync(history, '# History\n\n' + pointer + '\n');
    check(!(await hubStatusOf(w, 0, 'first')).lines.some(line => line.text === 'kickoffs/p3: no Run pointer names it'),
      '1585: a shown pointer names the page');
  } finally { await w.dispose(); }
}


/** A hash belonging to a subsection title is retained; spaced closing hashes are removed. */
async function section1586(): Promise<void> {
  const w = await letterWorkspace('c168-heading-hash');
  try {
    const fixture = closeFixture(w, [], []);
    const base = fixture.rootText().replace(/\n*$/, '\n\n') + '## Notes\n\n### A#\n\n- hash\n\n### A\n\n- plain\n\n### B ##\n\n- closing\n';
    for (const [wanted, before] of [['A#', '- hash'], ['A', '- plain'], ['B', '- closing'], ['### B ##', '- closing']]) {
      fs.writeFileSync(fixture.root, base);
      const ran = w.cli(0, ['hub', 'edit', 'first', '--mode', 'append-section', '--section', 'Notes',
        '--subsection', wanted!, '--content', '- added', '--json']);
      equal(ran.exit, 0, `1586: append under ${wanted}: ${ran.stderr}`);
      equal(fixture.rootText(), base.replace(before!, before + '\n- added'), `1586: only ${wanted} receives the addition`);
    }
  } finally { await w.dispose(); }
}


/** The lane's remedy check reaches plain Error diagnostics. */
async function section1587(): Promise<void> {
  const started = Date.now();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-c168-remedy-'));
  try {
    for (const name of Object.keys(OWN_COMMAND)) fs.writeFileSync(path.join(scratch, name), '');
    fs.writeFileSync(path.join(scratch, 'hubedit.ts'), "throw new Error('Run --frobnicate first.');\n");
    const caught = await remedyProblems(scratch);
    equal(caught.length, 1, '1587: plain Error is inspected');
    check(caught.some(line => line.startsWith("hubedit.ts:1: --frobnicate is not an option of this file's own command")),
      '1587: the unknown option is diagnosed: ' + JSON.stringify(caught));
    fs.writeFileSync(path.join(scratch, 'hubedit.ts'), "throw new Error('Supply --content-path.');\n");
    same(await remedyProblems(scratch), [], '1587: a valid option in plain Error is accepted');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  check(Date.now() - started < 2000, '1587: the planted diagnostic check takes under 2 seconds');
}


/** Local Hub previews expose the exact sections and byte length of the root they create. */
async function section1588(): Promise<void> {
  const w = await letterWorkspace('c168-new-preview');
  try {
    for (const dev of [true, false]) {
      const slug = dev ? 'preview-dev' : 'preview-plain';
      const args = ['hub', 'new', slug, '--title', 'T', ...(dev ? ['--dev'] : []), '--json'];
      const root = path.join(w.ws, 'collection', 'projects', slug, '_project.md');
      const preview = w.json(w.cli(0, [...args, '--preflight']));
      check(!fs.existsSync(root), '1588: preview writes no root');
      equal(w.cli(0, args).exit, 0, '1588: the previewed Hub is created');
      const body = fs.readFileSync(root, 'utf8');
      const headings = [...body.matchAll(/^## (.+)$/gm)].map(match => match[1]!.trim());
      same(preview['planned_root_sections'], headings, `1588: ${slug} preview lists written headings in order`);
      equal(preview['planned_root_bytes'], fs.statSync(root).size, `1588: ${slug} preview counts written UTF-8 bytes`);
      check(headings.includes('Repo') === dev, '1588: the development and plain bodies differ');
    }
  } finally { await w.dispose(); }
}


/** Closing an item retargets the first link and preserves all text following it. */
async function section1589(): Promise<void> {
  const w = await letterWorkspace('c168-closed-pointer');
  try {
    const tail = ' (the newest history page; it links the ones before).';
    for (const suffix of [tail, '']) {
      const old = 'Closed items: [[projects/first/notes/old]]' + suffix;
      const fixture = closeFixture(w, [old, '', '- [ ] Close this one'], []);
      const ran = fixture.close('Close this one');
      equal(ran.exit, 0, '1589: close-item succeeds: ' + ran.stderr);
      const pointers = fixture.rootText().split('\n').filter(line => line.startsWith('Closed items:'));
      equal(pointers.length, 1, '1589: the root keeps exactly one pointer');
      const history = fixture.history().at(-1)?.replace(/\.md$/, '');
      equal(pointers[0], `Closed items: [[projects/first/notes/${history}]]${suffix}`, '1589: only the first link target changes');
    }
    const fixture = closeFixture(w, ['Closed items: [[projects/first/notes/old]]',
      'Closed items: [[projects/first/notes/older]]' + tail, '', '- [ ] Refuse this close'], []);
    const before = fixture.rootText();
    const notes = fixture.history().map(name => [name, fixture.notesText(name)]);
    const ran = fixture.close('Refuse this close');
    check(ran.exit !== 0 && (ran.stdout + ran.stderr).includes('holds 2 Closed items lines'), '1589: two pointer lines are refused naming their count');
    equal(fixture.rootText(), before, '1589: refusal keeps the root unchanged');
    same(fixture.history().map(name => [name, fixture.notesText(name)]), notes, '1589: refusal writes no history');
  } finally { await w.dispose(); }
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
if (selected(1426)) await section1426();
if (selected(1427)) await section1427();
if (selected(1428)) await section1428();
if (selected(1429)) await section1429();
if (selected(1430)) await section1430();
if (selected(1431)) await section1431();
if (selected(1432)) await section1432();
if (selected(1433)) await section1433();
if (selected(1434)) await section1434();
if (selected(1435)) await section1435();
if (selected(1436)) await section1436();
if (selected(1437)) await section1437();
if (selected(1438)) await section1438();
if (selected(1439)) await section1439();
if (selected(1440)) await section1440();
if (selected(1441)) await section1441();
if (selected(1442)) await section1442();
if (selected(1443)) await section1443();
if (selected(1444)) await section1444();
if (selected(1445)) await section1445();
if (selected(1446)) await section1446();
if (selected(1447)) await section1447();
if (selected(1448)) await section1448();
if (selected(1449)) await section1449();
if (selected(1450)) await section1450();
if (selected(1451)) await section1451();
if (selected(1452)) await section1452();
if (selected(1453)) await section1453();
if (selected(1454)) await section1454();
if (selected(1455)) await section1455();
if (selected(1456)) await section1456();
if (selected(1457)) await section1457();
if (selected(1458)) await section1458();
if (selected(1459)) await section1459();
if (selected(1462)) await section1462();
if (selected(1463)) await section1463();
if (selected(1464)) await section1464();
if (selected(1467)) await section1467();
if (selected(1468)) await section1468();
if (selected(1469)) await section1469();
if (selected(1470)) await section1470();
if (selected(1471)) await section1471();
if (selected(1472)) await section1472();
if (selected(1473)) await section1473();
if (selected(1474)) await section1474();
if (selected(1475)) await section1475();
if (selected(1476)) await section1476();
if (selected(1478)) await section1478();
if (selected(1500)) await section1500();
if (selected(1501)) await section1501();
if (selected(1502)) await section1502();
if (selected(1503)) await section1503();
if (selected(1504)) await section1504();
if (selected(1505)) await section1505();
if (selected(1506)) await section1506();
if (selected(1507)) await section1507();
if (selected(1508)) await section1508();
if (selected(1509)) await section1509();
if (selected(1510)) await section1510();
if (selected(1511)) await section1511();
if (selected(1512)) await section1512();
if (selected(1513)) await section1513();
if (selected(1514)) await section1514();
if (selected(1515)) await section1515();
if (selected(1516)) await section1516();
if (selected(1517)) await section1517();
if (selected(1518)) await section1518();
if (selected(1519)) await section1519();
if (selected(1520)) await section1520();
if (selected(1521)) await section1521();
if (selected(1522)) await section1522();
if (selected(1523)) await section1523();
if (selected(1524)) await section1524();
if (selected(1525)) await section1525();
if (selected(1526)) await section1526();
if (selected(1527)) await section1527();
if (selected(1528)) await section1528();
if (selected(1529)) await section1529();
if (selected(1530)) await section1530();
if (selected(1531)) await section1531();
if (selected(1532)) await section1532();
if (selected(1533)) await section1533();
if (selected(1534)) await section1534();
if (selected(1535)) await section1535();
if (selected(1536)) await section1536();
if (selected(1537)) await section1537();
if (selected(1538)) await section1538();
if (selected(1539)) await section1539();
if (selected(1540)) await section1540();
if (selected(1541)) await section1541();
if (selected(1542)) await section1542();
if (selected(1543)) await section1543();
if (selected(1544)) await section1544();
if (selected(1545)) await section1545();
if (selected(1546)) await section1546();
if (selected(1547)) await section1547();
if (selected(1548)) await section1548();
if (selected(1549)) await section1549();
if (selected(1570) && prerequisite(1570, () => !isCompiled(), 'requires the source launcher stand-in')) await section1570();
if (selected(1571) && prerequisite(1571, () => !isCompiled(), 'requires source fixtures')) await section1571();
if (selected(1572) && prerequisite(1572, () => !isCompiled(), 'requires source fixtures')) await section1572();
if (selected(1573) && prerequisite(1573, () => !isCompiled(), 'requires source fixtures')) await section1573();
if (selected(1550)) await section1550();
if (selected(1551)) await section1551();
if (selected(1552)) await section1552();
if (selected(1553)) await section1553();
if (selected(1554)) await section1554();
if (selected(1555)) await section1555();
if (selected(1556)) await section1556();
if (selected(1557)) await section1557();
if (selected(1558)) await section1558();
if (selected(1559)) await section1559();
if (selected(1560)) await section1560();
if (selected(1561)) await section1561();
if (selected(1562)) await section1562();
if (selected(1563)) await section1563();
if (selected(1595)) await section1595();
if (selected(1596)) await section1596();
if (selected(1564)) await section1564();
if (selected(1565)) await section1565();
if (selected(1566)) await section1566();
if (selected(1567)) await section1567();
if (selected(1568)) await section1568();
if (selected(1590)) await section1590();
if (selected(1591)) await section1591();
if (selected(1592)) await section1592();
if (selected(1593)) await section1593();
if (selected(1594)) await section1594();
if (selected(1580)) await section1580();
if (selected(1581)) await section1581();
if (selected(1582)) await section1582();
if (selected(1583)) await section1583();
if (selected(1584)) await section1584();
if (selected(1585)) await section1585();
if (selected(1586)) await section1586();
if (selected(1587)) await section1587();
if (selected(1588)) await section1588();
if (selected(1589)) await section1589();
}
