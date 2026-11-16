/**
 * THE GUARDS-AND-TOOLING LANE'S SELF-TEST SECTIONS (PLAN-lane-test-files.md; kickoffs/s210 row 1). This lane's new sections go here,
 * numbered in its range in docs/areas.json `section_ranges` (1800 to 1999), and claim their kernel/src files in
 * `guards-and-tooling.covers.json` beside this file. kernel/test/selftest.ts awaits `runLane` after its last own section, so all of
 * its initialization has run; the names below are its helpers (./harness.ts says what each is).
 *
 * THE FORMAT IS THE PARSERS' OWN, AT COLUMN ZERO (tools/section-select.mts `sectionRanges`, kernel/test/run-parallel.ts
 * `sectionNumbers` and `knownDeclaredSkips`, tools/ci-manifest.mts): each section is a top-level `async function
 * sectionN(): Promise<void> {` whose closing `}` is at column zero, and `runLane` holds one dispatch line per section at
 * column zero, `if (selected(N)) await sectionN();` or `if (selected(N) && prerequisite(N, () => <condition>, '<reason>'))
 * await sectionN();` on one line, in number order. No formatter runs on this file.
 */
import type { Harness } from './harness.ts';

let selected: Harness['selected'], prerequisite: Harness['prerequisite'], check: Harness['check'], equal: Harness['equal'], same: Harness['same'];
let failures: Harness['failures'], runCli: Harness['runCli'], runCliAsync: Harness['runCliAsync'];
let HERE: Harness['HERE'], PROGRAM_ROOT: Harness['PROGRAM_ROOT'], KERNEL_COMMAND: Harness['KERNEL_COMMAND'], isCompiled: Harness['isCompiled'];

export async function runLane(h: Harness): Promise<void> {
  ({ selected, prerequisite, check, equal, same, failures, runCli, runCliAsync, HERE, PROGRAM_ROOT, KERNEL_COMMAND, isCompiled } = h);
if (selected(1800) && prerequisite(1800, () => !isCompiled(), 'requires the source suite and Node module hooks')) await section1800();
if (selected(1801) && prerequisite(1801, () => !isCompiled(), 'requires source lane files and real Git')) await section1801();
if (selected(1802) && prerequisite(1802, () => !isCompiled(), 'requires source tools/gate.ts and real Git')) await section1802();
if (selected(1803) && prerequisite(1803, () => !isCompiled(), 'requires source tools/ci-manifest.mts and run-parallel.ts')) await section1803();
if (selected(1804) && prerequisite(1804, () => !isCompiled(), 'requires the source tools and lane files')) await section1804();
if (selected(1805) && prerequisite(1805, () => !isCompiled(), 'requires the source claim files')) await section1805();
if (selected(1806) && prerequisite(1806, () => !isCompiled(), 'requires source tools/kickoff-check.mts and docs/areas.json')) await section1806();
if (selected(1807) && prerequisite(1807, () => !isCompiled(), 'requires source runner and removal injection')) await section1807();
if (selected(1808) && prerequisite(1808, () => !isCompiled(), 'requires source runner with inherited TMPDIR')) await section1808();
if (selected(1809) && prerequisite(1809, () => !isCompiled(), 'requires source runner verdict')) await section1809();
if (selected(1813) && prerequisite(1813, () => !isCompiled(), 'requires source gate waiter liveness')) await section1813();
if (selected(1814) && prerequisite(1814, () => !isCompiled(), 'requires source gate status')) await section1814();
if (selected(1815) && prerequisite(1815, () => !isCompiled(), 'requires source waiter decision')) await section1815();
if (selected(1816) && prerequisite(1816, () => !isCompiled(), 'requires source tooling fixture')) await section1816();
if (selected(1817) && prerequisite(1817, () => !isCompiled(), 'requires source tooling fixture')) await section1817();
if (selected(1818) && prerequisite(1818, () => !isCompiled(), 'requires source tooling fixture')) await section1818();
if (selected(1819) && prerequisite(1819, () => !isCompiled(), 'requires source waiter reads')) await section1819();
if (selected(1820) && prerequisite(1820, () => !isCompiled(), 'requires source section readers')) await section1820();
if (selected(1821) && prerequisite(1821, () => !isCompiled(), 'requires source section readers')) await section1821();
if (selected(1822) && prerequisite(1822, () => !isCompiled(), 'requires source section readers')) await section1822();
if (selected(1823) && prerequisite(1823, () => !isCompiled(), 'requires source section readers')) await section1823();
if (selected(1824) && prerequisite(1824, () => !isCompiled(), 'requires source owns tool')) await section1824();
if (selected(1826) && prerequisite(1826, () => !isCompiled(), 'requires source deployment scan')) await section1826();
if (selected(1827) && prerequisite(1827, () => !isCompiled(), 'requires source section readers')) await section1827();
if (selected(1829) && prerequisite(1829, () => !isCompiled(), 'requires source section readers')) await section1829();
if (selected(1830) && prerequisite(1830, () => !isCompiled(), 'requires source section selection')) await section1830();
if (selected(1831) && prerequisite(1831, () => !isCompiled(), 'requires source ownership fixture')) await section1831();
if (selected(1832) && prerequisite(1832, () => !isCompiled(), 'requires source hook scanner')) await section1832();
if (selected(1833) && prerequisite(1833, () => !isCompiled(), 'requires source TypeScript loader')) await section1833();
if (selected(1834) && prerequisite(1834, () => !isCompiled(), 'requires source syntax counting')) await section1834();
if (selected(1835) && prerequisite(1835, () => !isCompiled(), 'requires source dispatch and ownership nits')) await section1835();
if (selected(1836) && prerequisite(1836, () => !isCompiled(), 'requires real git append')) await section1836();
if (selected(1837) && prerequisite(1837, () => !isCompiled(), 'requires conservative section selection')) await section1837();
if (selected(1838) && prerequisite(1838, () => !isCompiled(), 'requires configurable lane readers')) await section1838();
}

// --- 1800. A lane section runs inside the real suite: its failing check fails the suite, a lane-only selection counts its
// checks, and selftest.ts's initialization ran first (kickoffs/s210 row 4; PLAN-lane-test-files.md, Proofs). The real
// selftest.ts runs as a child with its guards-and-tooling lane resolved to a fixture lane file in the real format.
async function section1800(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1800-')));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    const lane = path.join(root, 'guards-and-tooling.ts');
    fs.writeFileSync(lane, [
      "import type { Harness } from './harness.ts';",
      '',
      "let selected: Harness['selected'], check: Harness['check'], failures: Harness['failures'];",
      '',
      'export async function runLane(h: Harness): Promise<void> {',
      '  ({ selected, check, failures } = h);',
      'if (selected(1998)) await section1998();',
      'if (selected(1999)) await section1999();',
      '}',
      '',
      '// --- 1998. Three checks; the first two hold only once the suite has set its fixture Codex home.',
      'async function section1998(): Promise<void> {',
      "  const home = process.env['CODEX_HOME'] ?? '';",
      "  check(/kernel-codex-home-/.test(home), '1998: CODEX_HOME is the suite fixture home');",
      "  check((await import('node:fs')).existsSync(home), '1998: the fixture home exists');",
      "  check(Array.isArray(failures) && failures.length === 0, '1998: the suite failure list is shared and empty');",
      '}',
      '',
      '// --- 1999. One planted failure.',
      'async function section1999(): Promise<void> {',
      "  check(false, '1999: planted failure');",
      '}',
      '',
    ].join('\n'));
    const hook = path.join(root, 'redirect.mjs');
    fs.writeFileSync(hook, [
      "import { registerHooks } from 'node:module';",
      'registerHooks({ resolve(specifier, context, next) {',
      "  if (specifier === './lanes/guards-and-tooling.ts' && String(context.parentURL ?? '').endsWith('/kernel/test/selftest.ts')) return { url: " + JSON.stringify(pathToFileURL(lane).href) + ', shortCircuit: true };',
      '  return next(specifier, context);',
      '} });',
      '',
    ].join('\n'));
    const run = (sections: string) => spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, path.join(HERE, 'selftest.ts')], {
      env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: sections }, encoding: 'utf8', timeout: 300_000, windowsHide: true });
    const passing = run('1998');
    equal(passing.status, 0, `1800: a lane-only selection of a passing lane section exits 0: ${passing.stdout.slice(-300)} ${passing.stderr.slice(-300)}`);
    equal(passing.stdout.trim().split(/\r?\n/).at(-1), 'kernel self-test passed (3 checks).', '1800: the suite counts the lane section\'s three checks (initialization first, one failure list)');
    const failing = run('1999');
    equal(failing.status, 1, '1800: a failing check in a lane section fails the suite');
    check(failing.stderr.includes('kernel self-test FAILED (1 of 1): 1999: planted failure'), `1800: the suite names the lane section's failure: ${failing.stderr.slice(-300)}`);
    const both = run('1998,1999');
    check(both.status === 1 && both.stderr.includes('kernel self-test FAILED (1 of 4): 1999: planted failure'), `1800: both lane sections count in one verdict: ${both.stderr.slice(-300)}`);
  } catch (error) { failures.push(`section 1800 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1801. Two branches from one base, each adding a section to a different lane's test file and claim file, merge with
// no conflict; the same two additions in one lane's files conflict, so the check can see one (kickoffs/s210 row 4).
async function section1801(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1801-')));
  try {
    const git = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args],
      { encoding: 'utf8', windowsHide: true, env: repositoryNeutralEnv(), timeout: 60_000 });
    const lanes = path.join(root, 'kernel', 'test', 'lanes');
    fs.mkdirSync(lanes, { recursive: true });
    const real = (name: string) => fs.readFileSync(path.join(HERE, 'lanes', name), 'utf8').replace(/\r\n/g, '\n');
    for (const lane of ['seats-and-screens', 'books-and-memory']) for (const name of [`${lane}.ts`, `${lane}.covers.json`]) fs.writeFileSync(path.join(lanes, name), real(name));
    // A new section as a unit adds one: its dispatch line last in runLane, its function at the end, its claim key.
    const add = (lane: string, n: number) => {
      const file = path.join(lanes, `${lane}.ts`);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const close = lines.findIndex((line, i) => line === '}' && lines.slice(0, i).some(l => l.startsWith('export async function runLane(')));
      lines.splice(close, 0, `if (selected(${n})) await section${n}();`);
      fs.writeFileSync(file, lines.join('\n') + `\n// --- ${n}. A fixture section.\nasync function section${n}(): Promise<void> {\n  check(true, '${n}');\n}\n`);
      const covers = path.join(lanes, `${lane}.covers.json`);
      const map = JSON.parse(fs.readFileSync(covers, 'utf8')) as { sections: Record<string, string[]> };
      map.sections[String(n)] = [];
      fs.writeFileSync(covers, JSON.stringify(map, null, 2) + '\n');
      equal(git('add', '-A').status, 0, `1801: staged section ${n}`);
      equal(git('commit', '-q', '-m', `add ${n}`).status, 0, `1801: committed section ${n}`);
    };
    equal(git('init', '-q', '-b', 'base').status, 0, '1801: git init');
    git('add', '-A'); equal(git('commit', '-q', '-m', 'base').status, 0, '1801: base committed');
    git('switch', '-q', '-c', 'a', 'base'); add('seats-and-screens', 1000);
    git('switch', '-q', '-c', 'b', 'base'); add('books-and-memory', 1200);
    git('switch', '-q', '-c', 'c', 'base'); add('seats-and-screens', 1001);
    const clean = git('merge-tree', '--write-tree', 'a', 'b');
    equal(clean.status, 0, `1801: two lanes' additions merge with no conflict: ${clean.stdout}${clean.stderr}`);
    const tree = clean.stdout.trim().split(/\r?\n/)[0] ?? '';
    check(/^[0-9a-f]{40,64}$/.test(tree) && !/CONFLICT/.test(clean.stdout), `1801: merge-tree wrote one tree and named no conflict: ${clean.stdout}`);
    const merged = (file: string) => git('show', `${tree}:kernel/test/lanes/${file}`).stdout;
    check(merged('seats-and-screens.ts').includes('async function section1000(') && merged('books-and-memory.ts').includes('async function section1200('), '1801: the merged tree holds both sections');
    check(/"1000"/.test(merged('seats-and-screens.covers.json')) && /"1200"/.test(merged('books-and-memory.covers.json')), '1801: the merged tree holds both claims');
    const same = git('merge-tree', '--write-tree', 'a', 'c');
    check(same.status === 1 && same.stdout.includes('CONFLICT (content)') && same.stdout.includes('kernel/test/lanes/seats-and-screens.ts'), `1801: negative control: two additions in one lane's file conflict: ${same.stdout}${same.stderr}`);
  } catch (error) { failures.push(`section 1801 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1802. The commit check selects a lane file's changed section and no other, runs every section for a hunk outside every
// section there, and a tool named by a legacy section and a lane section selects both (kickoffs/s210 row 4). Real git, the
// real gate.ts selection and the staged hook selection.
async function section1802(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const gate = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'gate.ts')).href) as { selection: (root: string, commit: string | null) => { selection: { all: boolean; sections: number[]; reasons: string[] } } };
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'section-select.mts')).href) as typeof import('../../../tools/section-select.mts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1802-')));
  try {
    const run = (...args: string[]) => {
      const ran = spawnSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true, env: repositoryNeutralEnv(), timeout: 60_000 });
      if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
      return ran.stdout;
    };
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    const laneFile = 'kernel/test/lanes/guards-and-tooling.ts', laneCovers = 'kernel/test/lanes/guards-and-tooling.covers.json';
    const lane = [
      "let selected: (n: number) => boolean, check: (ok: boolean, label: string) => void;",
      '',
      'export async function runLane(h: { selected: typeof selected; check: typeof check }): Promise<void> {',
      '  ({ selected, check } = h);',
      'if (selected(1810)) await section1810();',
      'if (selected(1811)) await section1811();',
      '}',
      '',
      '// --- 1810. Names the fixture tool.',
      'async function section1810(): Promise<void> {',
      "  check(true, 'runs tools/fixture-1802.mts');",
      '}',
      '',
      '// --- 1811. Plain.',
      'async function section1811(): Promise<void> {',
      "  check(true, 'one');",
      '  check(true, \'two\');',
      '}',
      '',
    ];
    write('kernel/test/selftest.ts', "// fixture\nif (selected(7)) {\n  check(true, 'runs tools/fixture-1802.mts');\n}\nif (selected(8)) {\n  check(true, 'eight');\n}\n");
    write('kernel/test/section-covers.json', JSON.stringify({ schema: 1, sections: { '7': [], '8': [] } }, null, 2) + '\n');
    write(laneFile, lane.join('\n'));
    write(laneCovers, JSON.stringify({ schema: 1, sections: { '1810': [], '1811': [] } }, null, 2) + '\n');
    write('tools/fixture-1802.mts', 'export {};\n');
    // A lane with no section yet, as four lanes are when they get their first (row 4's own commit selected every section).
    const seatsFile = 'kernel/test/lanes/seats-and-screens.ts', seatsCovers = 'kernel/test/lanes/seats-and-screens.covers.json';
    const emptyLane = 'export async function runLane(h) {\n}\n';
    write(seatsFile, emptyLane);
    write(seatsCovers, JSON.stringify({ schema: 1, sections: {} }, null, 2) + '\n');
    run('init', '-q'); run('add', '-A'); run('commit', '-q', '-m', 'base');
    const staged = (change: () => void) => { change(); run('add', '-A'); const chosen = gate.selection(root, null).selection; run('reset', '-q', '--hard', 'HEAD'); return chosen; };
    const edit = (index: number, text: string) => () => { const next = [...lane]; next[index] = text; write(laneFile, next.join('\n')); };
    let chosen = staged(edit(16, "  check(true, 'two, changed');"));
    check(!chosen.all && chosen.sections.join(',') === '1811', `1802: a line inside a lane section selects that section and no other: ${JSON.stringify(chosen)}`);
    chosen = staged(edit(0, "let selected: (n: number) => boolean, check: (ok: boolean, label: string) => void; // changed"));
    check(chosen.all && chosen.reasons.some(r => r.includes(`${laneFile} line 1 is outside every section`)), `1802: a lane-file line outside every section runs every section, named: ${JSON.stringify(chosen.reasons)}`);
    chosen = staged(() => write('tools/fixture-1802.mts', 'export const changed = 1;\n'));
    check(!chosen.all && chosen.sections.includes(7) && chosen.sections.includes(1810) && !chosen.sections.includes(8) && !chosen.sections.includes(1811),
      `1802: a tool named by a legacy section and a lane section selects both, and only them: ${JSON.stringify(chosen)}`);
    chosen = staged(() => {
      const next = [...lane]; next.splice(6, 0, 'if (selected(1812)) await section1812();');
      write(laneFile, next.join('\n') + "// --- 1812. New.\nasync function section1812(): Promise<void> {\n  check(true, 'new');\n}\n");
      write(laneCovers, JSON.stringify({ schema: 1, sections: { '1810': [], '1811': [], '1812': [] } }, null, 2) + '\n');
    });
    check(!chosen.all && chosen.sections.join(',') === '1812', `1802: a new lane section with its claim selects only itself: ${JSON.stringify(chosen)}`);
    chosen = staged(() => {
      const lines = emptyLane.split('\n');
      const close = lines.findIndex((line, i) => line === '}' && lines.slice(0, i).some(l => l.startsWith('export async function runLane(')));
      lines.splice(close, 0, 'if (selected(1000)) await section1000();');
      write(seatsFile, lines.join('\n') + "\n// --- 1000. The lane's first.\nasync function section1000(): Promise<void> {\n  check(true, 'first');\n}\n");
      write(seatsCovers, JSON.stringify({ schema: 1, sections: { '1000': [] } }, null, 2) + '\n');
    });
    check(!chosen.all && chosen.sections.join(',') === '1000', `1802: a lane's first section selects only itself, though git counts runLane's closing brace as added: ${JSON.stringify(chosen)}`);
    // The staged hook selection reads the same lane file from the index (it adds the type check's 155).
    edit(16, "  check(true, 'two, staged');")(); run('add', '-A');
    const hooked = select.hookSections((args: string[]) => run(...args));
    run('reset', '-q', '--hard', 'HEAD');
    check(!hooked.all && hooked.sections.join(',') === '155,1811', `1802: the hook's index selection maps the lane hunk the same way: ${JSON.stringify(hooked)}`);
  } catch (error) { failures.push(`section 1802 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1803. The CI plan lists lane sections with their platform guards, run-parallel.ts runs one by number, and the
// runner's inventory of this checkout holds this lane's sections (kickoffs/s210 row 4).
async function section1803(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'section-select.mts')).href) as typeof import('../../../tools/section-select.mts');
  const runner = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'kernel', 'test', 'run-parallel.ts')).href) as typeof import('../run-parallel.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1803-')));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    const suite = path.join(root, 'selftest.ts');
    fs.writeFileSync(suite, [
      "const want = (process.env['LIBRARY_SELFTEST_SECTIONS'] ?? '').split(',').filter(Boolean).map(Number);",
      'const selected = (n: number) => want.length === 0 || want.includes(n);',
      "const prerequisite = (n: number, condition: () => unknown, reason: string) => { if (!selected(n)) return false; if (condition()) return true; console.log(`SKIP section ${n}: ${reason}`); return false; };",
      'let checks = 0; const failures: string[] = [];',
      'const check = (ok: boolean, label: string) => { checks += 1; if (!ok) failures.push(label); };',
      "if (selected(1)) check(true, 'one');",
      "await (await import('./lanes/guards-and-tooling.ts')).runLane({ selected, prerequisite, check });",
      "if (want.length && checks === 0) failures.push(`LIBRARY_SELFTEST_SECTIONS selected no checks: ${want.join(',')}`);",
      "if (failures.length) { console.error(`kernel self-test FAILED (${failures.length} of ${checks}): ${failures.join('; ')}`); process.exit(1); }",
      'console.log(`kernel self-test passed (${checks} checks).`);',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'lanes'));
    fs.writeFileSync(path.join(root, 'lanes', 'guards-and-tooling.ts'), [
      'let selected: (n: number) => boolean, prerequisite: (n: number, c: () => unknown, r: string) => boolean, check: (ok: boolean, label: string) => void;',
      '',
      'export async function runLane(h: { selected: typeof selected; prerequisite: typeof prerequisite; check: typeof check }): Promise<void> {',
      '  ({ selected, prerequisite, check } = h);',
      "if (selected(1890) && prerequisite(1890, () => process.platform === 'win32', 'requires Windows')) await section1890();",
      'if (selected(1891)) await section1891();',
      '}',
      '',
      'async function section1890(): Promise<void> {',
      "  check(true, '1890');",
      '}',
      '',
      'async function section1891(): Promise<void> {',
      "  check(true, '1891 a');",
      "  check(true, '1891 b');",
      '}',
      '',
    ].join('\n'));
    const plan = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools', 'ci-manifest.mts'), 'plan', '--suite', suite], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    equal(plan.status, 0, `1803: ci-manifest plan reads the fixture suite and its lane: ${plan.stderr}`);
    const entries = plan.status === 0 ? (JSON.parse(plan.stdout) as { sections: { section: number; class: string; prerequisite?: string }[] }).sections : [];
    same(entries, [{ section: 1, class: 'both' }, { section: 1890, class: 'windows', prerequisite: 'requires Windows' }, { section: 1891, class: 'both' }], '1803: the plan lists the lane sections with their platform guards');
    const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'kernel', 'test', 'run-parallel.ts'), '--suite', suite, '--workers', '2'], {
      env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: '1891' }, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
    equal(ran.status, 0, `1803: run-parallel.ts runs a lane section by number: ${ran.stdout.slice(-300)}${ran.stderr.slice(-300)}`);
    check(/^section 1891: PASS 2 checks /m.test(ran.stdout) && ran.stdout.trim().endsWith('kernel self-test passed (2 checks).'), `1803: the runner records the lane section's checks: ${ran.stdout.slice(-300)}`);
    same(runner.sectionNumbers(select.suiteText(suite), ''), [1, 1890, 1891], '1803: the runner inventory of the fixture suite holds its lane sections');
    const real = runner.sectionNumbers(select.suiteText(path.join(PROGRAM_ROOT, 'kernel', 'test', 'selftest.ts')), '');
    check([1800, 1801, 1802, 1803, 1804, 1805, 1806].every(n => real.includes(n)) && real.includes(830), `1803: this checkout's runner inventory holds 1800 to 1806 beside the legacy sections (${real.length} sections)`);
  } catch (error) { failures.push(`section 1803 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1804. Every parser reads a lane file in the real format the same way: the inventory and its order, each section's
// body range, the name search, the platform classification and the declared skips; a lane line off column zero is refused,
// and this checkout's lane files and harness calls keep the format and the lane order (kickoffs/s210 row 4).
async function section1804(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'section-select.mts')).href) as typeof import('../../../tools/section-select.mts');
  const runner = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'kernel', 'test', 'run-parallel.ts')).href) as typeof import('../run-parallel.ts');
  const manifest = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'ci-manifest.mts')).href) as typeof import('../../../tools/ci-manifest.mts');
  try {
    const legacy = "if (selected(1)) {\n  check(true, 'one');\n}\nif (selected(2)) await section2();\n";
    const laneLines = [
      'let selected, prerequisite, check;',                                                                          // 1
      '',                                                                                                            // 2
      'export async function runLane(h) {',                                                                          // 3
      '  ({ selected, prerequisite, check } = h);',                                                                   // 4
      "if (selected(1880) && prerequisite(1880, () => process.platform === 'win32', 'requires Windows')) await section1880();", // 5
      'if (selected(1881)) await section1881();',                                                                    // 6
      'if (selected(1882)) await section1882();',                                                                    // 7
      '}',                                                                                                           // 8
      '',                                                                                                            // 9
      '// --- 1880. Windows only, by its dispatch guard.',                                                           // 10
      'async function section1880() {',                                                                              // 11
      "  check(true, 'w');",                                                                                         // 12
      '}',                                                                                                           // 13
      '',                                                                                                            // 14
      '// --- 1881. Names tools/named-1804.mts.',                                                                    // 15
      'async function section1881() {',                                                                              // 16
      "  check(true, 'runs tools/named-1804.mts');",                                                                 // 17
      '}',                                                                                                           // 18
      '',                                                                                                            // 19
      'async function section1882() {',                                                                              // 20
      "  if (!prerequisite(1882, () => process.platform !== 'win32', 'requires POSIX')) return;",                    // 21
      "  check(true, 'posix');",                                                                                     // 22
      '}',                                                                                                           // 23
      '',
    ];
    const lane = laneLines.join('\n');
    const laneFile = 'kernel/test/lanes/guards-and-tooling.ts';
    const sources = [{ file: select.SELFTEST_PATH, text: legacy }, { file: laneFile, text: lane }];
    const joined = select.joinedText(sources);
    same(runner.sectionNumbers(joined, ''), [1, 2, 1880, 1881, 1882], '1804: the runner inventory lists legacy then lane sections, in number order');
    same(select.sectionRanges(lane).map(r => [r.section, r.start, r.end]), [[1880, 5, 5], [1881, 6, 6], [1882, 7, 7], [1880, 10, 13], [1881, 15, 18], [1882, 20, 23]],
      '1804: each dispatch line and each section body (with its comment lines) is one range');
    const named = select.selectSections({ changed: ['tools/named-1804.mts'], selftestText: legacy, selftestHunks: [], covers: { schema: 1, about: '1804', sections: {} },
      laneSources: [{ file: laneFile, text: lane, hunks: [] }] });
    check(!named.all && named.sections.includes(1881) && !named.sections.includes(1880), `1804: the name search reads the lane file: ${JSON.stringify(named)}`);
    same(manifest.plan(joined).sections, [{ section: 1, class: 'both' }, { section: 2, class: 'both' }, { section: 1880, class: 'windows', prerequisite: 'requires Windows' },
      { section: 1881, class: 'both' }, { section: 1882, class: 'linux', prerequisite: 'requires POSIX' }], '1804: the CI plan classifies a lane dispatch guard and a lane body guard');
    same(runner.knownDeclaredSkips(joined, { platform: 'linux', kernel: [] }), [{ section: 1880, reason: 'requires Windows' }], '1804: the declared skips read the lane dispatch guard');
    same(select.laneFormatProblems(laneFile, lane), [], '1804: the fixture lane file keeps the format');
    const drifted = (index: number, text: string) => { const next = [...laneLines]; next[index] = text; return select.laneFormatProblems(laneFile, next.join('\n')); };
    same(drifted(10, '  async function section1880() {'), [`${laneFile} line 11: an indented section declaration; it starts at column zero`], '1804: an indented section declaration is refused by line');
    same(drifted(6, '  if (selected(1882)) await section1882();'), [`${laneFile} line 7: an indented dispatch line; it starts at column zero`], '1804: an indented dispatch line is refused by line');
    same(drifted(12, '  }'), [`${laneFile} line 16: section 1880 has no closing '}' at column zero before this line`], '1804: an indented closing brace is refused at the line its range runs into');
    check(!runner.sectionNumbers(laneLines.map((line, i) => i === 6 ? '  ' + line : line).join('\n'), '').includes(1882), '1804: why: the runner never sees an indented dispatch line');
    // This checkout: each lane file keeps the format, LANES is docs/areas.json's lane order, and selftest.ts runs the lanes in it.
    for (const name of select.LANES) same(select.laneFormatProblems(select.laneTestPath(name), fs.readFileSync(path.join(PROGRAM_ROOT, select.laneTestPath(name)), 'utf8')), [], `1804: ${name}.ts keeps the format`);
    same([...select.LANES], Object.keys((JSON.parse(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', 'areas.json'), 'utf8')) as { lanes: Record<string, string[]> }).lanes), '1804: LANES is docs/areas.json lane order');
    same([...fs.readFileSync(path.join(PROGRAM_ROOT, select.SELFTEST_PATH), 'utf8').matchAll(/^await \(await import\('\.\/lanes\/([a-z-]+)\.ts'\)\)\.runLane\(harness\);$/gm)].map(m => m[1]), [...select.LANES],
      '1804: selftest.ts awaits each lane once, in lane order');
    // The readers refuse a lane file out of format or out of its lane's range, instead of dropping its sections
    // (kickoffs/s210-r2 row 2): this lane's own file with every dispatch line indented, 1804's included, and a fixture
    // seats-and-screens.ts holding 1810 beside a fixture docs/areas.json.
    const os = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const thrown = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
    const fixture = (lane: string, text: string, areas?: string) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1804-')));
      fs.mkdirSync(path.join(root, 'kernel', 'test', 'lanes'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
      fs.writeFileSync(path.join(root, 'kernel', 'test', 'selftest.ts'), [
        "const want = (process.env['LIBRARY_SELFTEST_SECTIONS'] ?? '').split(',').filter(Boolean).map(Number);",
        'const selected = (n: number) => want.length === 0 || want.includes(n);',
        'let checks = 0;',
        'if (selected(1)) checks += 1;',
        'console.log(`kernel self-test passed (${checks} checks).`);',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(root, 'kernel', 'test', 'lanes', `${lane}.ts`), text);
      if (areas !== undefined) { fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs', 'areas.json'), areas); }
      return root;
    };
    const ownText = fs.readFileSync(path.join(PROGRAM_ROOT, select.laneTestPath('guards-and-tooling')), 'utf8');
    const ownLines = ownText.split(/\r?\n/);
    const own1804 = ownLines.findIndex(line => line.startsWith('if (selected(1804)')) + 1;
    const indented = fixture('guards-and-tooling', ownLines.map(line => line.startsWith('if (selected(') ? '  ' + line : line).join('\n'));
    const outOfRange = fixture('seats-and-screens', ['export async function runLane(h) {', 'if (selected(1810)) await section1810();', '}', '', 'async function section1810() {', '}', ''].join('\n'),
      JSON.stringify({ section_ranges: { 'seats-and-screens': [1000, 1199], 'guards-and-tooling': [1800, 1999] } }));
    try {
      const suite = path.join(indented, 'kernel', 'test', 'selftest.ts');
      const said = thrown(() => select.suiteText(suite));
      check(said.includes(`guards-and-tooling.ts line ${own1804}: an indented dispatch line`) && said.includes('guards-and-tooling.ts line 21: an indented dispatch line'),
        `1804: suiteText refuses a lane file with its dispatch lines indented, naming the file and each line (1804's own at line ${own1804}): ${said || 'no refusal'}`);
      const env = { ...process.env };
      delete env['LIBRARY_SELFTEST_SECTIONS'];
      const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'kernel', 'test', 'run-parallel.ts'), '--suite', suite, '--workers', '2'], { env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
      check(ran.status !== 0 && !/^section 1: /m.test(ran.stdout) && `${ran.stdout}${ran.stderr}`.includes(`guards-and-tooling.ts line ${own1804}: an indented dispatch line`),
        `1804: the runner stops on that lane file with its message instead of listing [1] (exit ${ran.status}): ${ran.stdout.slice(-300)}${ran.stderr.slice(-300)}`);
      const read = (root: string) => (file: string) => { const full = path.join(root, file); return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null; };
      for (const [where, said2] of [['suiteText', thrown(() => select.suiteText(path.join(outOfRange, 'kernel', 'test', 'selftest.ts')))], ['sectionSources', thrown(() => select.sectionSources(read(outOfRange)))]] as const) {
        check(said2.includes('seats-and-screens.ts line 2: section 1810 is outside lane seats-and-screens\'s range 1000 to 1199'), `1804: ${where} refuses a lane section outside its lane's range: ${said2 || 'no refusal'}`);
      }
      equal(thrown(() => select.suiteText(path.join(PROGRAM_ROOT, select.SELFTEST_PATH))), '', '1804: this checkout\'s lane files and docs/areas.json pass suiteText');
      equal(thrown(() => select.sectionSources(read(PROGRAM_ROOT))), '', '1804: this checkout\'s lane files and docs/areas.json pass sectionSources');
    } finally { for (const root of [indented, outOfRange]) fs.rmSync(root, { recursive: true, force: true }); }
  } catch (error) { failures.push(`section 1804 stopped early: ${(error as Error).message}`); }
}

// --- 1805. One claim map: a number claimed in two files, or a lane section claimed outside its lane's claim file, is
// refused by name; this checkout's merged map claims every section of every source (kickoffs/s210 row 4).
async function section1805(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools', 'section-select.mts')).href) as typeof import('../../../tools/section-select.mts');
  try {
    const legacyCovers = select.COVERS_PATH, guardsCovers = select.laneCoversPath('guards-and-tooling'), seatsCovers = select.laneCoversPath('seats-and-screens');
    const map = (sections: Record<string, string[]>) => JSON.stringify({ schema: 1, sections });
    const sources = [{ file: select.SELFTEST_PATH, text: 'if (selected(7)) {\n}\n' },
      { file: select.laneTestPath('guards-and-tooling'), text: 'async function section1870() {\n}\n' }];
    const refusal = (parts: { file: string; text: string }[], withSources = true) => { try { select.mergeCovers(parts, withSources ? sources : undefined); return ''; } catch (error) { return (error as Error).message; } };
    equal(refusal([{ file: legacyCovers, text: map({ '7': ['kernel/src/cli.ts'] }) }, { file: guardsCovers, text: map({ '1870': [] }) }]), '', '1805: a legacy claim and a lane claim merge');
    same(select.mergeCovers([{ file: legacyCovers, text: map({ '7': ['kernel/src/cli.ts'] }) }, { file: guardsCovers, text: map({ '1870': ['kernel/src/sha.ts'] }) }], sources).sections,
      { '7': ['kernel/src/cli.ts'], '1870': ['kernel/src/sha.ts'] }, '1805: the merged map holds both files\' claims');
    equal(refusal([{ file: legacyCovers, text: map({ '7': [] }) }, { file: guardsCovers, text: map({ '7': [] }) }], false),
      `section 7 is claimed in two files: ${legacyCovers} and ${guardsCovers}`, '1805: a number claimed in two files is refused by name');
    equal(refusal([{ file: legacyCovers, text: map({ '7': [] }) }, { file: seatsCovers, text: map({ '1870': [] }) }]),
      `${seatsCovers} claims section 1870, which ${select.laneTestPath('guards-and-tooling')} holds: a lane claims only its own file's sections`, '1805: another lane\'s claim file claiming a lane section is refused');
    equal(refusal([{ file: legacyCovers, text: map({ '7': [], '1870': [] }) }]),
      `${legacyCovers} claims section 1870, which ${select.laneTestPath('guards-and-tooling')} holds: claim it in ${guardsCovers}`, '1805: section-covers.json claiming a lane section is refused');
    equal(refusal([{ file: legacyCovers, text: map({}) }, { file: guardsCovers, text: map({ '7': [] }) }]),
      `${guardsCovers} claims section 7, which ${select.SELFTEST_PATH} holds: a lane claims only its own file's sections`, '1805: a lane claim file claiming a legacy section is refused');
    check(refusal([{ file: guardsCovers, text: '{"schema": 1, "sections": {"x": []}}' }], false).startsWith(`${guardsCovers}: 'x' is not a section number`), '1805: a malformed lane claim file is named');
    // This checkout: the real files merge, and every section of every source has its claim.
    const read = (file: string) => { const full = path.join(PROGRAM_ROOT, file); return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null; };
    const real = select.sectionSources(read);
    const merged = select.mergeCovers(select.coversFiles(read), real);
    const unclaimed = real.flatMap(source => select.sectionRanges(source.text).map(r => r.section)).filter(n => !Object.hasOwn(merged.sections, String(n)));
    same([...new Set(unclaimed)], [], '1805: every section of selftest.ts and the lane files has a claim in the merged map');
  } catch (error) { failures.push(`section 1805 stopped early: ${(error as Error).message}`); }
}

// --- 1806. kickoff-check keeps a Kickoff's new sections in its lane's file and range, in the source tool and the posting
// path (`judgeKickoff`): it refuses one with no Lane, with docs/areas.json unreadable, with a number outside the range, or
// with another lane's file, and passes a grandfathered w8 revision adding 782 (kickoffs/s210 row 4).
async function section1806(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const kc = await import('../../src/kickoffcheck.ts');
  const { judgeKickoff } = await import('../../src/hubnewpage.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1806-')));
  try {
    const kickoff = (id: string, why: string[], owns: string, paths: string[]) => [`# ${id} kickoff: fixture`, '', ...kc.KNOWN_SECTIONS.map(name => `${name}: ${
      name === 'WHY NOW' ? '\n- **Goal:** fixture.\n' + why.join('\n')
      : name === 'OWNS' ? owns
      : name === 'OWNS PATHS' ? '\n' + paths.map(file => `- \`${file}\``).join('\n')
      : name === 'ROWS' ? '\n1. Change a.\n   Done when: checked.' : name === 'CLOSE' ? '\n**Stop.**' : 'filled'}`)].join('\n');
    const guards = 'kernel/test/lanes/guards-and-tooling.ts', guardsCovers = 'kernel/test/lanes/guards-and-tooling.covers.json', seats = 'kernel/test/lanes/seats-and-screens.ts';
    const numbering = kc.parseKickoffNumbering(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', 'areas.json'), 'utf8'));
    // An explicit `undefined` (no numbering passed at all) must stay undefined, so the default is spelled out.
    const mine = (text: string, ...given: [] | [typeof numbering | undefined]) => kc.kickoffVerdict(text, { adrFiles: [], numbering: given.length ? given[0] : numbering }).problems.filter(p => p.startsWith('New sections: '));
    const good = kickoff('s999', ['- **Lane:** guards-and-tooling'], 'New sections 1810 to 1811 in the lane file.', [guards, guardsCovers]);
    same(mine(good), [], '1806: new sections in the lane range and the lane file pass');
    same(kc.newSectionNumbers(good), [1810, 1811], '1806: OWNS names its new section numbers');
    let found = mine(kickoff('s999', [], 'New sections 1810 to 1811.', [guards]));
    check(found.length === 1 && found[0]!.includes('- **Lane:**'), `1806: no Lane line is refused: ${found.join(' | ')}`);
    for (const [given, word] of [[kc.parseKickoffNumbering('{'), 'cannot be read'], [kc.parseKickoffNumbering(null), 'is missing'], [undefined, 'was not read']] as const) {
      found = mine(good, given);
      check(found.length === 1 && found[0]!.includes('docs/areas.json') && found[0]!.includes(word), `1806: docs/areas.json unreadable (${word}) is refused for a Kickoff adding sections: ${found.join(' | ')}`);
    }
    same(mine(kickoff('s999', [], 'No new section; cases inside section 830 only.', ['tools/lander.mts']), kc.parseKickoffNumbering('{')), [], '1806: a Kickoff adding no section keeps today\'s verdict with docs/areas.json unreadable');
    found = mine(kickoff('s999', ['- **Lane:** guards-and-tooling'], 'New section 1500.', [guards]));
    check(found.length === 1 && found[0]!.includes('section 1500 is outside lane guards-and-tooling\'s range 1800 to 1999'), `1806: a number outside the lane range is refused: ${found.join(' | ')}`);
    found = mine(kickoff('s999', ['- **Lane:** guards-and-tooling'], 'New section 1810.', [guards, guardsCovers, seats]));
    check(found.length === 1 && found[0]!.includes(`names ${seats}`) && found[0]!.includes('seats-and-screens'), `1806: another lane's file is refused: ${found.join(' | ')}`);
    same(mine(kickoff('s999', ['- **Lane:** guards-and-tooling', `- **Cross-lane:** \`${seats}\` (fixture)`], 'New section 1810.', [guards, guardsCovers, seats])), [], '1806: another lane\'s file on a Cross-lane line passes');
    same(mine(kickoff('w8-r2', ['- **Lane:** guards-and-tooling'], 'New section 782.', [])), [], '1806: a w8 revision adding grandfathered 782 passes');
    found = mine(kickoff('w9', ['- **Lane:** guards-and-tooling'], 'New section 782.', []));
    check(found.length === 1 && found[0]!.includes('section 782 is outside'), `1806: another unit adding 782 is refused: ${found.join(' | ')}`);
    // The source tool, on files, reading this checkout's docs/areas.json.
    const tool = (name: string, text: string) => { const file = path.join(root, name); fs.writeFileSync(file, text); const r = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools', 'kickoff-check.mts'), file], { encoding: 'utf8', windowsHide: true, timeout: 120_000 }); return `${r.stdout}${r.stderr}`; };
    let out = tool('outside.md', kickoff('s999', ['- **Lane:** guards-and-tooling'], 'New section 1500.', [guards]));
    check(out.includes("New sections: section 1500 is outside lane guards-and-tooling's range 1800 to 1999"), `1806: the source tool refuses a number outside the range: ${out.slice(-600)}`);
    out = tool('w8.md', kickoff('w8-r2', ['- **Lane:** guards-and-tooling'], 'New section 782.', []));
    check(!out.includes('New sections: '), `1806: the source tool passes a w8 revision adding 782: ${out.slice(-600)}`);
    // The posting path, from this program root and from one whose docs/areas.json cannot be read.
    const posted = (text: string, programRoot?: string) => judgeKickoff(text, root, { train: false, names: false, ...(programRoot ? { programRoot } : {}) }).problems.filter(p => p.startsWith('New sections: '));
    found = posted(kickoff('s999', ['- **Lane:** guards-and-tooling'], 'New section 1500.', [guards]));
    check(found.length === 1 && found[0]!.includes('section 1500 is outside'), `1806: judgeKickoff refuses a number outside the range: ${found.join(' | ')}`);
    same(posted(kickoff('w8-r2', ['- **Lane:** guards-and-tooling'], 'New section 782.', [])), [], '1806: judgeKickoff passes a w8 revision adding 782');
    const broken = path.join(root, 'program');
    fs.mkdirSync(path.join(broken, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'docs', 'areas.json'), '{ not json');
    found = posted(good, broken);
    check(found.length === 1 && found[0]!.includes('docs/areas.json cannot be read'), `1806: judgeKickoff refuses a Kickoff adding sections when docs/areas.json cannot be read: ${found.join(' | ')}`);
    // Every way a Kickoff in ordinary Markdown declares a new section is found, in both entry points (kickoffs/s210-r2 row 1):
    // each refused case names what it refuses; the forms naming an existing section pass.
    const lane = ['- **Lane:** guards-and-tooling'], selftest = 'kernel/test/selftest.ts';
    const refused: [string, string, string[], string[]][] = [
      ['inline code', 'New section `1500` in the lane file.', [guards, guardsCovers], ['section 1500 is outside']],
      ['Adds', 'Adds section 831 to selftest.ts.', [selftest], ['section 831 is outside']],
      ['a colon and a comma list', 'New sections: 1500, 1501.', [guards, guardsCovers], ['section 1500 is outside', 'section 1501 is outside']],
      ['an en dash', 'New sections 1500–1502.', [guards, guardsCovers], ['section 1500 is outside', 'section 1501 is outside', 'section 1502 is outside']],
      ['a lane number without its lane files', 'New section 1810.', [selftest], [guards, guardsCovers, 'section 1810']],
      ['no readable number', 'New sections to follow.', [guards, guardsCovers], ['names no number this check can read: "New sections to follow"']],
    ];
    for (const [name, owns, paths, words] of refused) {
      for (const [where, got] of [['kickoffVerdict', mine(kickoff('s999', lane, owns, paths))], ['judgeKickoff', posted(kickoff('s999', lane, owns, paths))]] as const) {
        check(words.every(word => got.some(p => p.includes(word))), `1806: ${where} refuses a new section declared with ${name} (${owns}): ${got.join(' | ') || 'no problem'}`);
      }
    }
    same(mine(kickoff('s999', lane, 'New sections 1810 to 1811; `kernel/test/lanes/guards-and-tooling.ts` only your new sections; each new section needs a claim.', [guards, guardsCovers])), [],
      '1806: a phrase referring back to the declared sections (your new sections, each new section) is not a declaration');
    same(kc.newSectionNumbers(kickoff('s999', lane, 'New sections 1500–1502 and `1504`; adds **section 1506**.', [])), [1500, 1501, 1502, 1504, 1506], '1806: OWNS read with code marks and emphasis removed and an en dash as a hyphen');
    // Numbering is checked as tools/areas.mts checks it (kickoffs/s210-r2 row 3): a range outside 1000 to 1999, or a
    // grandfathered number in it, makes docs/areas.json unreadable, and a Kickoff adding sections is refused in both entry points.
    check(!('unreadable' in numbering), `1806: this checkout's docs/areas.json parses: ${JSON.stringify(numbering).slice(0, 300)}`);
    const realAreas = JSON.parse(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs', 'areas.json'), 'utf8')) as { section_ranges: Record<string, number[]>; grandfathered_sections: Record<string, number[]> };
    for (const [name, bad, fault] of [
      ['a range outside 1000 to 1999', { ...realAreas, section_ranges: { ...realAreas.section_ranges, 'guards-and-tooling': [1, 9999] } }, 'section_ranges guards-and-tooling 1 to 9999 is not a range inside 1000 to 1999'],
      ['a grandfathered number in the lane numbers', { ...realAreas, grandfathered_sections: { w8: [1800] } }, 'grandfathered_sections w8 names 1800: grandfathered numbers are below 1000'],
    ] as const) {
      const parsed = kc.parseKickoffNumbering(JSON.stringify(bad));
      check('unreadable' in parsed && parsed.unreadable.startsWith('docs/areas.json cannot be read: ') && parsed.unreadable.includes(fault), `1806: parseKickoffNumbering refuses ${name}: ${JSON.stringify(parsed).slice(0, 400)}`);
      found = mine(good, parsed);
      check(found.length === 1 && found[0]!.includes(fault), `1806: kickoffVerdict refuses a Kickoff adding sections with ${name}: ${found.join(' | ')}`);
      fs.writeFileSync(path.join(broken, 'docs', 'areas.json'), JSON.stringify(bad));
      found = posted(good, broken);
      check(found.length === 1 && found[0]!.includes(fault), `1806: judgeKickoff refuses a Kickoff adding sections with ${name}: ${found.join(' | ')}`);
    }
    for (const owns of ['No new section number; cases inside section 814 only.', 'cases inside section 830 only (no new section number)', 'In kernel/test/selftest.ts: section 763 only.']) {
      same(mine(kickoff('s999', lane, owns, [selftest])), [], `1806: kickoffVerdict passes a Kickoff naming an existing section (${owns})`);
      same(posted(kickoff('s999', lane, owns, [selftest])), [], `1806: judgeKickoff passes a Kickoff naming an existing section (${owns})`);
    }
  } catch (error) { failures.push(`section 1806 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1807. Section cleanup retries and errors without codes remain useful warnings (w18).
async function section1807(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1807-'));
  try {
    const suite = path.join(root, 'suite.mjs'), hook = path.join(root, 'inject.mjs');
    fs.writeFileSync(suite, 'const selected = n => Number(process.env.LIBRARY_SELFTEST_SECTIONS) === n;\nif (selected(1)) console.log("kernel self-test passed (1 checks).");\n');
    fs.writeFileSync(hook, `import fs from 'node:fs'; import path from 'node:path';
const remove = fs.rmSync;
fs.rmSync = (folder, options) => {
  if (path.basename(String(folder)) === '1') {
    fs.appendFileSync(${JSON.stringify(path.join(root, 'options.jsonl'))}, JSON.stringify(options) + '\\n');
    if (process.env.FAIL_REMOVE === '1') throw new Error('fixture message without code');
  }
  return remove(folder, options);
};
`);
    const run = (fail: boolean) => {
      const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
      return spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, path.join(HERE, 'run-parallel.ts'), '--suite', suite, '--workers', '2'], {
        env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: '1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, FAIL_REMOVE: fail ? '1' : '0' }, encoding: 'utf8', timeout: 120000, windowsHide: true });
    };
    const ok = run(false);
    equal(ok.status, 0, '1807: retry fixture passes: ' + ok.stderr);
    const options = JSON.parse(fs.readFileSync(path.join(root, 'options.jsonl'), 'utf8').trim().split(/\r?\n/)[0]!);
    check(options.maxRetries > 0 && options.retryDelay === 100, '1807: section removal retries: ' + JSON.stringify(options));
    const refused = run(true);
    equal(refused.status, 0, '1807: failed cleanup keeps passing verdict');
    const warnings = refused.stderr.trim().split(/\r?\n/).filter(line => line.startsWith('runner:'));
    check(warnings.length === 1 && warnings[0]!.includes('(fixture message without code); kept') && !refused.stderr.includes('(undefined)'), '1807: one warning names an error without code: ' + refused.stderr);
    // Old run folders only: links inside them never lead cleanup outside the fixture.
    const pruneRun = (tmp: string) => spawnSync(process.execPath, [path.join(HERE, 'run-parallel.ts'), '--suite', suite, '--workers', '2'], {
      env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: '1', TEMP: tmp, TMP: tmp, TMPDIR: tmp }, encoding: 'utf8', timeout: 120000, windowsHide: true });
    const tmp = fs.mkdtempSync(path.join(root, 'prune-')), outside = path.join(root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    const old = new Date(Date.now() - 8 * 86400000), young = new Date(Date.now() - 86400000);
    const aged = (base: string, name: string, when: Date) => { const folder = path.join(base, name); fs.mkdirSync(folder); fs.utimesSync(folder, when, when); return folder; };
    const doomed = aged(tmp, 'deskpost-gate-OLD001', old);
    fs.symlinkSync(outside, path.join(doomed, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.utimesSync(doomed, old, old);
    const recent = aged(tmp, 'deskpost-gate-NEW001', young), other = aged(tmp, 'unrelated', old);
    const file = path.join(tmp, 'deskpost-gate-FILE01'); fs.writeFileSync(file, 'keep'); fs.utimesSync(file, old, old);
    const link = path.join(tmp, 'deskpost-gate-LINK01'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    fs.lutimesSync(link, old, old); fs.utimesSync(outside, old, old);
    const pruned = pruneRun(tmp);
    equal(pruned.status, 0, '1807: prune preserves exit zero: ' + pruned.stderr);
    check(!fs.existsSync(doomed), '1807: old run folder removed');
    check(fs.existsSync(recent) && fs.existsSync(other) && fs.existsSync(file) && fs.lstatSync(link).isSymbolicLink(), '1807: young, unrelated, file and link entries survive');
    equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside', '1807: linked target survives');
    equal(pruned.stderr.trim(), `runner: removed 1 run folders older than 7 days from ${tmp}`, '1807: prune line names one removal');
    const capped = fs.mkdtempSync(path.join(root, 'cap-'));
    for (let n = 0; n < 201; n++) aged(capped, 'deskpost-gate-' + String(n).padStart(6, '0'), new Date(old.getTime() + n * 1000));
    const cappedRun = pruneRun(capped);
    equal(cappedRun.status, 0, '1807: bounded prune preserves verdict');
    const left = fs.readdirSync(capped).filter(name => /^deskpost-gate-\d{6}$/.test(name));
    same(left, ['deskpost-gate-000200'], '1807: oldest first, at most 200 removed');
    check(cappedRun.stderr.includes('removed 200 run folders'), '1807: cap reported');
  } catch (error) { failures.push(`section 1807 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1808. An inherited Linux TMPDIR cannot make two sections share their temporary home (w18).
async function section1808(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1808-'));
  try {
    const suite = path.join(root, 'suite.mjs'), printed = path.join(root, 'printed.txt');
    fs.writeFileSync(suite, `import os from 'node:os'; import fs from 'node:fs';
const selected = n => Number(process.env.LIBRARY_SELFTEST_SECTIONS) === n;
${''}if (selected(1)) { fs.writeFileSync(${JSON.stringify(printed)}, os.tmpdir()); console.log('kernel self-test passed (1 checks).'); }
`);
    const shared = path.join(root, 'shared'); fs.mkdirSync(shared);
    const ran = spawnSync(process.execPath, [path.join(HERE, 'run-parallel.ts'), '--suite', suite, '--workers', '2', '--keep-logs'], {
      env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: '1', TEMP: shared, TMP: shared, TMPDIR: shared }, encoding: 'utf8', timeout: 120000, windowsHide: true });
    equal(ran.status, 0, '1808: fixture runner passes: ' + ran.stderr);
    const folder = /^runner log: (.+)$/m.exec(ran.stdout)?.[1]?.trim();
    const actual = fs.readFileSync(printed, 'utf8');
    console.log('1808: printed ' + actual);
    check(!!folder && actual.startsWith(path.join(folder, '1') + path.sep) && actual !== shared, '1808: os.tmpdir is inside the section folder: ' + actual);
  } catch (error) { failures.push(`section 1808 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1809. Node echoes the throwing source before the useful error message (w18).
async function section1809(): Promise<void> {
  const { verdict } = await import('../run-parallel.ts');
  const text = ["file:///fixture.mjs:3", "    throw new Error('x: ' + detail);", '          ^', '', 'Error: 1809: detail 42', '    at file:///fixture.mjs:3:11', '', 'Node.js v24.0.0'].join('\n');
  const got = verdict(1, 1, text);
  console.log('1809: detail ' + got.detail);
  check(got.detail.includes('Error: 1809: detail 42') && !got.detail.includes('throw new'), '1809: reports thrown message: ' + got.detail);
  for (const name of ['Error [ERR_MODULE_NOT_FOUND]', 'TypeError [ERR_INVALID_ARG_TYPE]', 'AssertionError [ERR_ASSERTION]']) {
    const message = name + ': 1809: coded detail 42';
    const coded = verdict(1, 1, text.replace('Error: 1809: detail 42', message));
    check(coded.detail.includes(message), '1809: keeps coded message: ' + message + '; got ' + coded.detail);
  }
}

// --- 1813. Sweep only registrations proven dead; read-only callers never sweep (w18).
async function section1813(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const gate = await import('../gate-lock.ts');
  const { startIdentity } = await import('../run-parallel.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1813-'));
  try {
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    equal(child.status, 0, '1813: dead child finished');
    const start = await startIdentity(process.pid);
    check(!!start, '1813: real process start is readable');
    const registration = (id: string, pid: number, processStart: string) => ({ id, seat: 'fixture', tier: 'commit', pid, processStart, arrived: new Date().toISOString() });
    fs.writeFileSync(path.join(root, 'dead.json'), JSON.stringify(registration('dead', child.pid, 'dead-start')));
    fs.writeFileSync(path.join(root, 'reused.json'), JSON.stringify(registration('reused', process.pid, 'wrong-start')));
    fs.writeFileSync(path.join(root, 'live.json'), JSON.stringify(registration('live', process.pid, start!)));
    fs.writeFileSync(path.join(root, 'malformed.json'), '{');
    const before = fs.readdirSync(root).map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]);
    // The namespace import lets the base proof explain the missing export rather than crashing on import.
    check(typeof gate.liveWaiters === 'function', '1813: liveWaiters is exported');
    if (typeof gate.liveWaiters !== 'function') return;
    same((await gate.liveWaiters(root, false)).map(row => row.id), ['live'], '1813: read-only view includes only live waiter');
    same(fs.readdirSync(root).map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]), before, '1813: sweep disabled writes nothing');
    same((await gate.liveWaiters(root)).map(row => row.id), ['live'], '1813: sweep returns live waiter only');
    same(fs.readdirSync(root).sort(), ['live.json', 'malformed.json'], '1813: gone and reused registrations removed, malformed preserved');
  } catch (error) { failures.push(`section 1813 stopped early: ${(error as Error).message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1814. Gate status names holders and ordered waiters without changing any registration (w18).
async function section1814(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { startIdentity } = await import('../run-parallel.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1814-'));
  const name = 'fixture-1814-' + process.pid;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}-1` : `\0${name}-1`;
  const holder = { seat: 'fixture-holder', tier: 'commit', pid: process.pid, processStart: await startIdentity(process.pid), start: new Date().toISOString(), token: 'slot:1:fixture-status-holder' };
  const server = net.createServer(socket => socket.end(JSON.stringify(holder) + '\n'));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    fs.writeFileSync(path.join(root, 'slots'), JSON.stringify({ slots: 2, u2Tip: '0'.repeat(40) }));
    const waiters = path.join(root, 'waiters'); fs.mkdirSync(waiters);
    const entry = (id: string, arrived: string, start = holder.processStart) => ({ id, seat: id, tier: 'cut', pid: process.pid, processStart: start, arrived });
    fs.writeFileSync(path.join(waiters, 'second.json'), JSON.stringify(entry('fixture-second', '2026-01-02T00:00:00Z')));
    fs.writeFileSync(path.join(waiters, 'first.json'), JSON.stringify(entry('fixture-first', '2026-01-01T00:00:00Z')));
    fs.writeFileSync(path.join(waiters, 'dead.json'), JSON.stringify(entry('fixture-dead', '2026-01-01T00:00:00Z', 'wrong-start')));
    const snapshot = (folder = root): unknown[] => fs.readdirSync(folder).sort().map(file => {
      const full = path.join(folder, file);
      return fs.lstatSync(full).isDirectory() ? [file, snapshot(full)] : [file, fs.readFileSync(full).toString('hex')];
    });
    const before = snapshot();
    const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, 'gate-lock.ts'), '--status'], { env: { ...process.env, DESKPOST_GATE_LOCK_NAME: name, DESKPOST_GATE_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; const timer = setTimeout(() => { child.kill(); reject(Error('1814: status timed out')); }, 15000);
      child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { out += String(chunk); });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, out }); });
    });
    equal(result.code, 0, '1814: status exits without waiting: ' + result.out);
    check(result.out.includes('gate slots: 2') && result.out.includes('fixture-holder') && result.out.includes('commit') && result.out.includes(holder.start) && result.out.includes('\"slots\":1'), '1814: status names setting, holder, tier and since: ' + result.out);
    check(result.out.includes('fixture-first') && result.out.indexOf('fixture-first') < result.out.indexOf('fixture-second') && !result.out.includes('fixture-dead'), '1814: live waiters in arrival order: ' + result.out);
    same(snapshot(), before, '1814: status leaves every gate file name and byte unchanged, including dead registration');
  } catch (error) { failures.push(`section 1814 stopped early: ${(error as Error).message}`); }
  finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1815. Only evidence collected after registrations can prove one dead (w18-r2).
async function section1815(): Promise<void> {
  const gate = await import('../gate-lock.ts');
  const entry = { pid: 123, processStart: 'registered-start' };
  // At the base, exercise the existing decision, including its unsafe missing-row inference.
  type Entry = {pid: number; processStart: string};
  type Rows = {pid: number; start: string}[];
  const decide: (entry: Entry, platform: string, rows: Rows, identity: string | null | undefined, ownPid: number) => boolean = gate.deadRegistration ?? ((entry, platform, rows, identity, ownPid) => {
    const start = platform === 'win32' ? rows.find(row => row.pid === entry.pid)?.start : identity;
    return platform === 'win32' ? start === undefined || !!start && start !== entry.processStart : start === null || !!start && start !== entry.processStart;
  });
  const dead = (entry: Entry, platform: string, rows: Rows, identity: string | null | undefined) => decide(entry, platform, rows, identity, process.pid);
  const self = { pid: process.pid, start: 'self-start' };
  check(!dead(entry, 'win32', [], undefined), '1815: empty table is undecidable');
  check(!dead(entry, 'win32', [{ pid: 456, start: 'other' }], undefined), '1815: table without self is undecidable');
  check(dead(entry, 'win32', [self], undefined), '1815: answered table without waiter proves death');
  check(dead(entry, 'win32', [self, { pid: 123, start: 'different' }], undefined), '1815: different start proves reuse');
  check(!dead(entry, 'win32', [self, { pid: 123, start: '' }], undefined), '1815: unreadable start is undecidable');
  check(!dead(entry, 'win32', [self, { pid: 123, start: entry.processStart }], undefined), '1815: matching start is live');
  check(dead(entry, 'linux', [], null), '1815: absent Linux process proves death');
  check(dead(entry, 'linux', [], 'different'), '1815: Linux reuse proves death');
  check(!dead(entry, 'linux', [], ''), '1815: unreadable Linux start is undecidable');
  check(!dead(entry, 'linux', [], entry.processStart), '1815: matching Linux start is live');
  check(!dead({ ...entry, processStart: '' }, 'linux', [], 'readable'), '1815: unreadable registered start is undecidable');
}

// --- 1816. Large changed selections fit the commit estimate; runners retain the rest (w18-r2).
async function section1816(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { boundedCommitSelection, COMMIT_SELECTION_BUDGET_SECONDS } = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/gate.ts')).href);
  const { estimateSeconds } = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-times.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1816-'));
  try {
    const put = (name: string, text: string) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); };
    const inventory = Array.from({length:400}, (_, i) => i + 1), own = inventory.slice(88), smoke = [1, 2, 3];
    put('kernel/test/selftest.ts', inventory.map(n => `if (selected(${n})) {}`).join('\n'));
    put('kernel/test/smoke-sections.json', JSON.stringify({schema:1, sections:Object.fromEntries(smoke.map(n => [n, 'fixture']))}));
    const times = {schema:1, from:['fixture'], sections:Object.fromEntries(inventory.map(n => [n, 10 + n % 4]))};
    put('kernel/test/section-times.json', JSON.stringify(times));
    const chosen = {all:false, sections:inventory, ownSections:own, reasons:['fixture']};
    const result = boundedCommitSelection(root, chosen, 2), ran = result.selection.sections;
    check(smoke.every(n => ran.includes(n)), '1816: smoke always selected');
    check(own.some(n => ran.includes(n)) && own.some(n => !ran.includes(n)), '1816: changed sections are bounded');
    check(estimateSeconds(ran, times, 2) <= COMMIT_SELECTION_BUDGET_SECONDS, '1816: estimate stays within budget');
    const deferred = own.filter(n => !ran.includes(n));
    check(deferred.length > 0 && deferred.every(n => result.line?.includes(String(n))), '1816: line names every deferred changed section');
    equal(result.deferred, inventory.filter(n => !ran.includes(n)).length, '1816: deferred count matches');
    const sorted = [...own].sort((a,b) => times.sections[a]! - times.sections[b]! || a-b);
    const included = sorted.filter(n => ran.includes(n));
    same(included, sorted.slice(0, included.length), '1816: shortest changed sections run first');
    const small = {...chosen, sections:own.slice(0,3), ownSections:own.slice(0,3)};
    same(boundedCommitSelection(root, small, 2).selection, small, '1816: three changed sections unchanged');
    const hugeTimes = {...times, sections:Object.fromEntries(inventory.map(n => [n, 500]))};
    put('kernel/test/section-times.json', JSON.stringify(hugeTimes));
    check(own.some(n => boundedCommitSelection(root, chosen, 2).selection.sections.includes(n)), '1816: at least one changed section even if indivisible cost exceeds budget');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1817. Memory sampling records the minimum and its UTC instant (w18-r2).
async function section1817(): Promise<void> {
  const path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const gate = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/gate.ts')).href);
  check(typeof gate.memorySampler === 'function', '1817: memory sampler is available');
  if (typeof gate.memorySampler !== 'function') return;
  const values = [80, 50, 65, 40, 40], times = values.map((_, i) => `2026-11-14T12:00:0${i}.000Z`);
  let index = 0;
  const sampler = gate.memorySampler(() => values[index]! * 1048576, () => times[index]!);
  for (index = 1; index < values.length; index++) sampler.sample();
  same(sampler.minimum(), { free_min_mb:40, free_min_at:times[3] }, '1817: lowest reading and first time retained');
}

// --- 1818. A seated docs scan still finds deployment values in its checkout (w18-r2).
async function section1818(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1818-'));
  try {
    const repo = path.join(root, 'repo'), home = path.join(root, 'home'), library = path.join(root, 'library');
    fs.mkdirSync(path.join(home, '.library'), {recursive:true});
    fs.writeFileSync(path.join(home, '.library/identity-denylist.txt'), 'fixture-denied-value\n');
    const env = repositoryNeutralEnv({...process.env, HOME:home, USERPROFILE:home, APPDATA:home, LOCALAPPDATA:home,
      LIBRARY_WORKSPACE:'', LIBRARY_SEAT:'', LIBRARY_SEAT_CLAIM:'', LIBRARY_WORKSPACES:path.join(root, 'registry'), TEMP:root, TMP:root, TMPDIR:root});
    const cloned = spawnSync('git', ['clone', '--shared', '--quiet', PROGRAM_ROOT, repo], {env:repositoryNeutralEnv(env), encoding:'utf8', timeout:60000});
    equal(cloned.status, 0, '1818: fixture clone: ' + cloned.stderr);
    fs.mkdirSync(path.join(library, '.library'), {recursive:true});
    fs.writeFileSync(path.join(library, '.library/workspace.json'), JSON.stringify({schema:1, id:'18181818-1818-4818-8818-181818181818'}));
    const value = 'fixture-deployment-1818'; // gitleaks:allow (a value this test plants)
    fs.writeFileSync(path.join(repo, '.claude/.library-project'), value + '\n');
    fs.writeFileSync(path.join(repo, 'docs/scan-fixture.md'), '# Fixture\n\n' + value + '\n');
    const staged = spawnSync('git', ['add', 'docs/scan-fixture.md'], {cwd:repo, env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(staged.status, 0, '1818: stage fixture document');
    const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/docs-gate.ts')], {cwd:repo,
      env:{...env, LIBRARY_WORKSPACE:library}, encoding:'utf8', timeout:120000, windowsHide:true});
    const line = ran.stdout.split(/\r?\n/).find(line => line.includes('public.no-deployment-defaults')) ?? '';
    check(line.startsWith('FAIL') && line.includes(value) && line.includes('docs/scan-fixture.md'), '1818: child finds checkout deployment value despite seated parent: ' + line + ran.stderr);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1819. The real sweep reads registrations before taking its process snapshot (w19).
async function section1819(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { liveWaiters } = await import('../gate-lock.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1819-'));
  try {
    const entry = {id:'new', seat:'fixture', tier:'commit', pid:123, processStart:'new-start', arrived:'2026-01-01T00:00:00Z'};
    const file = path.join(root, 'new.json');
    let started = false;
    const arrive = () => { started = true; fs.writeFileSync(file, JSON.stringify({...entry, privateExtra:'must not escape'})); };
    const reads = {
      platform:'win32',
      readFolder: (folder: string) => { const names = fs.readdirSync(folder); if (!started) arrive(); return names; },
      processTable: async () => {
        const rows = [{pid:process.pid, parentPid:0, start:'self', command:''}];
        if (started) rows.push({pid:123, parentPid:0, start:'new-start', command:''});
        if (!started) arrive();
        return rows;
      },
      startIdentity: async () => 'new-start'
    };
    await liveWaiters(root, true, reads);
    check(fs.existsSync(file), '1819: registration arriving between reads survives the real sweep');
    const result = await liveWaiters(root, true, reads);
    same(result, [entry], '1819: result contains only the six public registration fields');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1820. Every section reader refuses dispatches the runner cannot inventory (w19).
async function section1820(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1820-'));
  try {
    const legacy = 'kernel/test/selftest.ts', lane = select.laneTestPath('guards-and-tooling');
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true}); fs.writeFileSync(path.join(root, file), text); };
    const read = (file: string) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
    const said = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
    for (const [file, n] of [[legacy, 7], [lane, 1890]] as const) {
      put(legacy, 'if (selected(1)) {}\n'); put(lane, '');
      const declaration = `async function section${n}() {\n}\n`;
      for (const [text, label] of [
        [declaration + `if(selected(${n}))await section${n}();\n`, 'noncanonical'],
        [declaration, 'missing'],
        [declaration + `if (selected(${n})) await section${n}();\nif (selected(${n})) await section${n}();\n`, 'duplicate'],
      ]) {
        put(file, text!);
        for (const run of [() => select.sectionSources(read), () => select.suiteText(path.join(root, legacy))]) {
          const message = said(run);
          check(message.includes(path.basename(file)) && message.includes('line ') && message.includes('if (selected('), `1820: ${label} dispatch refused by file, line and correct form: ${message || 'no refusal'}`);
        }
      }
      put(file, declaration + `if (selected(${n})) await section${n}();\nif (selected(522)) await helper();\n`);
      equal(said(() => select.sectionSources(read)), '', '1820: canonical dispatch and helper without declaration accepted');
    }
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1821. Legacy section numbers stay frozen even when a lane range would allow them (w19).
async function section1821(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1821-'));
  try {
    const suite = path.join(root, 'kernel/test/selftest.ts'), areas = path.join(root, 'docs/areas.json');
    fs.mkdirSync(path.dirname(suite), {recursive:true}); fs.mkdirSync(path.dirname(areas), {recursive:true});
    const read = (file: string) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
    const said = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
    for (const [n, grandfathered, allowed] of [[820, false, true], [821, false, false], [1500, false, false], [825, true, true], [825, false, false], [1500, true, false]] as const) {
      fs.writeFileSync(suite, `async function section${n}() {\n}\nif (selected(${n})) await section${n}();\n`);
      if (grandfathered) fs.writeFileSync(areas, JSON.stringify({section_ranges:{}, grandfathered_sections:{fixture:[n]}}));
      else if (fs.existsSync(areas)) fs.unlinkSync(areas);
      for (const run of [() => select.sectionSources(read), () => select.suiteText(suite)]) {
        const message = said(run);
        check(allowed ? message === '' : message.includes('selftest.ts line 1') && message.includes(String(n)) && message.includes('lane') && message.includes('range'),
          `1821: legacy ${n}, grandfathered ${grandfathered}, allowed ${allowed}: ${message || 'no refusal'}`);
      }
    }
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1822. An existing areas file must supply each present lane's valid range (w19).
async function section1822(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1822-'));
  try {
    const suite = path.join(root, 'kernel/test/selftest.ts'), lane = select.laneTestPath('guards-and-tooling'), areas = path.join(root, 'docs/areas.json');
    fs.mkdirSync(path.dirname(path.join(root, lane)), {recursive:true}); fs.mkdirSync(path.dirname(areas), {recursive:true});
    fs.writeFileSync(suite, 'if (selected(1)) {}\n'); fs.writeFileSync(path.join(root, lane), '');
    const read = (file: string) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
    const said = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
    for (const ranges of [undefined, {}, null, {'guards-and-tooling':[1800, 1900, 1999]}, {'guards-and-tooling':[1999, 1800]}, {'guards-and-tooling':['1800', 1999]}]) {
      fs.writeFileSync(areas, JSON.stringify({section_ranges:ranges}));
      for (const run of [() => select.sectionSources(read), () => select.suiteText(suite)]) {
        const message = said(run);
        check(message.includes('guards-and-tooling') && message.includes('areas.json') && message.includes('range'),
          `1822: missing or malformed range refused with lane and file: ${message || 'no refusal'}`);
      }
    }
    fs.writeFileSync(areas, JSON.stringify({section_ranges:{'guards-and-tooling':[1800, 1999]}}));
    equal(said(() => select.sectionSources(read)), '', '1822: valid range accepted');
    fs.unlinkSync(areas);
    equal(said(() => select.suiteText(suite)), '', '1822: absent areas file preserves fixture support');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1823. A section number may occur repeatedly in one source, never in two (w19).
async function section1823(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1823-'));
  try {
    const legacy = 'kernel/test/selftest.ts', lane = select.laneTestPath('guards-and-tooling');
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true}); fs.writeFileSync(path.join(root, file), text); };
    const read = (file: string) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
    const said = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
    put(legacy, 'async function section7() {\n}\nif (selected(7)) await section7();\n');
    for (const text of ['async function section7() {\n}\nif (selected(7)) await section7();\n', 'if (selected(7)) await helper();\n']) {
      put(lane, text);
      for (const run of [() => select.sectionSources(read), () => select.suiteText(path.join(root, legacy))]) {
        const message = said(run);
        check(message.includes(legacy) && message.includes(lane) && message.includes('section 7'),
          `1823: duplicate source refused naming number and both files: ${message || 'no refusal'}`);
      }
    }
    put(legacy, 'if (selected(208)) {\n}\nif (selected(208)) {\n}\n'); put(lane, '');
    equal(said(() => select.sectionSources(read)), '', '1823: two legacy 208 blocks in one source stay valid');
    put(lane, 'async function section1890() {\n}\nif (selected(1890)) await section1890();\n');
    equal(said(() => select.suiteText(path.join(root, legacy))), '', '1823: distinct source numbers stay valid');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1824. Ownership cannot start another unit on the current branch (w19).
async function section1824(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1824-'));
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root,
      LIBRARY_WORKSPACE:'', LIBRARY_SEAT:'', LIBRARY_SEAT_CLAIM:'', TEMP:root, TMP:root, TMPDIR:root});
    const init = spawnSync('git', ['init', '-q', '-b', 'int/w900', root], {env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(init.status, 0, '1824: fixture repository initialized');
    const record = path.join(root, '.git/deskpost-owns/int%2Fw900.json');
    const run = (id: string) => {
      const file = path.join(root, 'kickoff.md'), text = `# ${id} kickoff: fixture\nOWNS PATHS:\n- \`a.ts\`\nSTAY OUT OF: none\n`;
      fs.writeFileSync(file, text);
      return spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/owns.mts'), 'start', '--kickoff', file, '--sha256', createHash('sha256').update(text).digest('hex')],
        {cwd:root, env, encoding:'utf8', timeout:30000});
    };
    const wrong = run('w901'), message = wrong.stdout + wrong.stderr;
    check(wrong.status === 1 && message.includes('int/w900') && message.includes('w901'), '1824: mismatch refuses and prints both names: ' + message);
    check(!fs.existsSync(record), '1824: mismatch writes no ownership record');
    const matching = run('w900');
    equal(matching.status, 0, '1824: matching unit starts: ' + matching.stderr);
    const revised = run('w900-r2');
    equal(revised.status, 0, '1824: revision of same unit starts on its unit branch: ' + revised.stderr);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1826. A zero-value deployment scan names its uncovered configuration, retaining structural hits (w19).
async function section1826(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const { deploymentScan } = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/scan.ts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1826-')), previous = process.cwd();
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, TEMP:root, TMP:root, TMPDIR:root});
    const init = spawnSync('git', ['init', '-q', root], {env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(init.status, 0, '1826: fixture repository initialized');
    fs.mkdirSync(path.join(root, 'docs')); const file = path.join(root, 'docs/probe.md');
    fs.writeFileSync(file, '# Fixture\n');
    const add = spawnSync('git', ['-C', root, 'add', 'docs/probe.md'], {env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(add.status, 0, '1826: fixture document tracked');
    process.chdir(root);
    const clean = deploymentScan(root);
    equal(clean.status, 'pass', '1826: zero configured values preserve clean exit status');
    check(clean.detail.includes('configured-value') && clean.detail.includes('not run') &&
      ['.library-mcp-url', '.library-project', '.library-shared-root'].every(name => clean.detail.includes(path.join(root, '.claude', name))),
      '1826: zero configured values explicitly unscanned and every missing file named: ' + clean.detail);
    fs.writeFileSync(file, '# Fixture\nhttps://deployment-fixture.test/mcp\n');
    const structural = deploymentScan(root);
    check(structural.status === 'fail' && structural.hits.some((hit: {kind: string}) => hit.kind === 'endpoint'), '1826: structural hits still fail with zero configured values');
    check(structural.detail.includes('not run'), '1826: structural failure still names configured-value gap');
    fs.mkdirSync(path.join(root, '.claude'));
    const value = 'fixture-configured-1826'; // gitleaks:allow (a value this test plants)
    fs.writeFileSync(path.join(root, '.claude/.library-project'), value);
    fs.writeFileSync(file, '# Fixture\n' + value + '\n');
    const configured = deploymentScan(root);
    check(configured.status === 'fail' && configured.hits.some((hit: {kind: string}) => hit.kind === 'configured') && !configured.detail.includes('not run'),
      '1826: configured values still scanned and reported without false uncovered claim');
  } finally { process.chdir(previous); fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1827. Real-suite scratch trees carry the frozen-number input (w19-r2).
async function section1827(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1827-'));
  try {
    fs.mkdirSync(path.join(root, 'kernel/test'), {recursive:true});
    fs.copyFileSync(path.join(PROGRAM_ROOT, 'kernel/test/selftest.ts'), path.join(root, 'kernel/test/selftest.ts'));
    fs.symlinkSync(path.join(PROGRAM_ROOT, 'tools'), path.join(root, 'tools'), process.platform === 'win32' ? 'junction' : 'dir');
    const read = (file: string) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
    let message = ''; try { select.sectionSources(read); } catch (error) { message = (error as Error).message; }
    check(message.includes('section 825') && message.includes('frozen legacy'), '1827: missing input refuses the real suite: ' + message);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.copyFileSync(path.join(PROGRAM_ROOT, 'docs/areas.json'), path.join(root, 'docs/areas.json'));
    equal(select.sectionSources(read).length, 1, '1827: copied areas input admits real legacy suite');
    check(select.suiteText(path.join(root, 'kernel/test/selftest.ts')).includes('section825'), '1827: disk reader also accepts copied input');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1829. Ownership titles and every reachable section need a readable dispatch (w19-r2).
async function section1829(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url'), { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1829-'));
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root,
      LIBRARY_WORKSPACE:'', LIBRARY_SEAT:'', LIBRARY_SEAT_CLAIM:'', TEMP:root, TMP:root, TMPDIR:root});
    equal(spawnSync('git', ['init', '-q', '-b', 'int/w900', root], {env:repositoryNeutralEnv(env), encoding:'utf8'}).status, 0, '1829: fixture initialized');
    const run = (title: string) => {
      const text = title + '\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: none\n', file = path.join(root, 'kickoff.md');
      fs.writeFileSync(file, text);
      return spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/owns.mts'), 'start', '--kickoff', file, '--sha256', createHash('sha256').update(text).digest('hex')], {cwd:root, env, encoding:'utf8', timeout:30000});
    };
    for (const title of ['# No unit here', '# Kickoff: w901']) {
      const ran = run(title);
      check(ran.status === 1 && (ran.stdout + ran.stderr).includes(title), '1829: missing unit refused naming title: ' + ran.stdout + ran.stderr);
    }
    for (const prefix of ['', '\uFEFF', '---\nkind: fixture\n---\n', '\uFEFF---\nkind: fixture\n---\n']) {
      const matching = run(prefix + '# w900-r2 kickoff: fixture');
      equal(matching.status, 0, '1829: matching title with optional BOM/frontmatter: ' + matching.stderr);
      const wrong = run(prefix + '# w901 kickoff: fixture');
      check(wrong.status === 1 && wrong.stderr.includes('w901'), '1829: normalized wrong title refused: ' + wrong.stderr);
    }
    const said = (text: string) => { try { select.sectionSources((file: string) => file === select.SELFTEST_PATH ? text : null); return ''; } catch (error) { return (error as Error).message; } };
    for (const declaration of ['async function section7 () {', 'function section7() {', 'function section7 () {']) {
      check(said(declaration + '\n}\n').includes('dispatch'), '1829: every declaration needs dispatch: ' + declaration);
    }
    for (const line of ['if (selected( 7)) await section7();', 'if (selected(x)) await helper();', '  if (selected(7)) await helper();']) {
      check(said(line).includes('dispatch'), '1829: unreadable or indented dispatch refused: ' + line);
    }
    equal(said('async function section7() {\n}\nif (selected(7)) await section7();\n'), '', '1829: canonical fixture remains valid');
    check(select.suiteText(path.join(PROGRAM_ROOT, 'kernel/test/selftest.ts')).includes('section1829'), '1829: real suite remains readable');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1830. Whole adjacent added sections select precisely their own numbers (w19-r2).
async function section1830(): Promise<void> {
  const path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const text = ['async function section7() {', '  check(true);', '}', 'if (selected(7)) await section7();', '',
    'async function section8() {', '  check(true);', '}', 'if (selected(8)) await section8();'].join('\n');
  const run = (selftestText: string, oldCount = 0) => select.selectSections({changed:[select.SELFTEST_PATH],
    selftestText, selftestHunks:[{start:1, count:selftestText.split('\n').length, oldCount}], covers:{schema:1, about:'fixture', sections:{'7':[], '8':[]}}});
  const adjacent = run(text);
  check(!adjacent.all && JSON.stringify(adjacent.sections) === '[7,8]', '1830: two whole pure additions select exactly both: ' + adjacent.reasons.join('; '));
  check(run(text + '\nconst shared = true;').all, '1830: one stray shared line selects every section');
  check(run(text, 1).all, '1830: replaced multi-section hunk retains whole-suite fallback');
}

// --- 1832. The hook retains its original scanner path across removal of an installed shim folder (w19-r3).
async function section1832(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1832-'));
  try {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const standin = path.join(bin, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
    fs.copyFileSync(process.execPath, standin); fs.chmodSync(standin, 0o755);
    fs.writeFileSync(path.join(bin, 'deskpost'), '# fixture shim\n');
    const stub = path.join(root, 'stub.mjs');
    fs.writeFileSync(stub, "if(process.argv[0].includes('gitleaks')) { if(process.argv.some(a=>a.endsWith('version'))) console.log('8.30.2'); process.exit(0); }\n");
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root,
      TEMP:root, TMP:root, TMPDIR:root, DESKPOST_GITLEAKS:'', PATH:bin + path.delimiter + process.env.PATH,
      NODE_OPTIONS:'--import=' + pathToFileURL(stub).href});
    const hook = fs.readFileSync(path.join(PROGRAM_ROOT, '.githooks/pre-commit'), 'utf8');
    const block = hook.slice(hook.indexOf('set -f'), hook.indexOf('set +f') + 'set +f'.length);
    const retained = spawnSync('sh', ['-c', block + '\nprintf "%s" "$DESKPOST_GITLEAKS"'], {cwd:root, env, encoding:'utf8', timeout:30000});
    equal(retained.status, 0, '1832: hook environment step runs: ' + retained.stderr);
    // Shell paths use / even when Node was launched on Windows.
    check(retained.stdout.replaceAll('\\', '/').endsWith('/bin/gitleaks') || retained.stdout.replaceAll('\\', '/').endsWith('/bin/gitleaks.exe'),
      '1832: hook resolves scanner before dropping shim folder: ' + retained.stdout);
    const run = (scanner: string) => spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/staged-secrets.mts')], {
      cwd:root, env:{...env, PATH:path.join(root, 'absent'), DESKPOST_GITLEAKS:scanner}, encoding:'utf8', timeout:30000});
    const good = run(retained.stdout);
    check(good.status === 0 && good.stdout.includes('staged secrets: no leaks found (gitleaks 8.30.2)'), '1832: retained scanner runs: ' + good.stdout + good.stderr);
    const absent = run('');
    check(absent.status === 0 && absent.stdout.includes('WARN gitleaks is not installed'), '1832: empty variable and missing PATH still warn: ' + absent.stdout + absent.stderr);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1833. Section readers explain a missing local TypeScript package and read the installed suite (w19-r3).
async function section1833(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1833-'));
  try {
    fs.mkdirSync(path.join(root, 'tools')); fs.mkdirSync(path.join(root, 'kernel/node_modules'), {recursive:true});
    for (const name of ['section-select.mts', 'check-map.json']) fs.copyFileSync(path.join(PROGRAM_ROOT, 'tools', name), path.join(root, 'tools', name));
    const copied = await import(pathToFileURL(path.join(root, 'tools/section-select.mts')).href);
    let message = ''; try { copied.sectionSources((file: string) => file === copied.SELFTEST_PATH ? 'if (selected(1)) {}\n' : null); } catch (error) { message = (error as Error).message; }
    check(message.includes('kernel/node_modules/typescript') && message.includes('npm ci') && message.includes('kernel/'), '1833: missing package names path and remedy: ' + message);
    const real = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
    check(real.suiteText(path.join(PROGRAM_ROOT, real.SELFTEST_PATH)).includes('section1833'), '1833: installed package reads real suite');
    check(!fs.readFileSync(path.join(root, 'tools/section-select.mts'), 'utf8').includes("process.getBuiltinModule("), '1833: reader does not require the Node 22.3 builtin API');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1834. Dispatch declarations and counts come from syntax, never template examples (w19-r3).
async function section1834(): Promise<void> {
  const path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const said = (text: string) => { try { select.sectionSources((file: string) => file === select.SELFTEST_PATH ? text : null); return ''; } catch (error) { return (error as Error).message; } };
  const declaration = 'async function section7() {\n}\n', dispatch = 'if (selected(7)) await section7();\n';
  const example = 'const example = `\n' + dispatch + '`;\n';
  check(said(declaration + example).includes('0 dispatch'), '1834: example is not an executing dispatch');
  equal(said(declaration + example + dispatch), '', '1834: example beside real dispatch is not a duplicate');
  equal(said('const example = `\n' + declaration + '`;\n'), '', '1834: example is not a declaration');
  check(said(declaration + dispatch + dispatch).includes('2 dispatch'), '1834: two real dispatches still refuse');
  check(select.suiteText(path.join(PROGRAM_ROOT, select.SELFTEST_PATH)).includes('section1834'), '1834: real suite remains readable');
}

// --- 1835. Mid-line dispatches refuse, ownership stores normalized titles, and repeat reads reuse syntax (w19-r3).
async function section1835(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url'), { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const text = 'async function section7() {\n}\nif (other) {\n} else if (selected( 7)) await section7();\n';
  let message = ''; try { select.sectionSources((file: string) => file === select.SELFTEST_PATH ? text : null); } catch (error) { message = (error as Error).message; }
  check(message.includes('line 4') && message.includes('write the dispatch'), '1835: mid-line spelling refusal names correct form: ' + message);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1835-'));
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, TEMP:root, TMP:root, TMPDIR:root});
    equal(spawnSync('git', ['init', '-q', '-b', 'int/w900', root], {env:repositoryNeutralEnv(env), encoding:'utf8'}).status, 0, '1835: initialize ownership fixture');
    for (const prefix of ['\uFEFF', '---\nkind: fixture\n---\n', '\uFEFF---\nkind: fixture\n---\n']) {
      const body = prefix + '# w900-r3 kickoff: normalized\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: none\n', file = path.join(root, 'kickoff.md');
      fs.writeFileSync(file, body);
      const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/owns.mts'), 'start', '--kickoff', file, '--sha256', createHash('sha256').update(body).digest('hex')], {cwd:root, env, encoding:'utf8', timeout:30000});
      equal(ran.status, 0, '1835: normalized kickoff starts: ' + ran.stderr);
      equal(JSON.parse(fs.readFileSync(path.join(root, '.git/deskpost-owns/int%2Fw900.json'), 'utf8')).kickoff_title, '# w900-r3 kickoff: normalized', '1835: stored title is normalized');
    }
    // Use a fresh module instance so its first read really is cold in this worker.
    const cold = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href + '?1835');
    const start = performance.now(); cold.suiteText(path.join(PROGRAM_ROOT, cold.SELFTEST_PATH)); const first = performance.now() - start;
    const again = performance.now(); cold.suiteText(path.join(PROGRAM_ROOT, cold.SELFTEST_PATH)); const second = performance.now() - again;
    check(second < first, '1835: repeated suite read is faster with cached syntax: ' + first + 'ms then ' + second + 'ms');
    console.log('1835: suite read cold ' + first.toFixed(1) + 'ms, cached ' + second.toFixed(1) + 'ms');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1836. Real git append hunks select only the two newly added sections (w19-r3).
async function section1836(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1836-'));
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, TEMP:root, TMP:root, TMPDIR:root});
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], {cwd:root, env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(git('init', '-q', '-b', 'fixture').status, 0, '1836: initialize fixture');
    const lane = select.laneTestPath('guards-and-tooling'), file = path.join(root, lane);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    const section = (n: number) => 'async function section' + n + '() {\n  check(true);\n}\n';
    const base = section(1880) + '\nexport async function runLane(h) {\nif (selected(1880)) await section1880();\n}\n';
    const next = base.replace('if (selected(1880)) await section1880();\n}', 'if (selected(1880)) await section1880();\nif (selected(1881)) await section1881();\nif (selected(1882)) await section1882();\n}') + '\n' + section(1881) + '\n' + section(1882);
    fs.writeFileSync(file, base); git('add', '.'); equal(git('commit', '-qm', 'base').status, 0, '1836: commit base');
    fs.writeFileSync(file, next); git('add', '.'); equal(git('commit', '-qm', 'append two sections').status, 0, '1836: commit append');
    const diff = git('diff', '-U0', 'HEAD^', 'HEAD', '--', lane);
    equal(diff.status, 0, '1836: real git diff');
    const hunks = select.parseHunks(diff.stdout);
    check(hunks.length > 0 && hunks.every((h: {oldCount: number}) => h.oldCount === 0), '1836: real append is pure addition');
    check(hunks.some((h: {start: number; count: number}) => next.split('\n').slice(h.start - 1, h.start + h.count - 1).includes('}') && next.split('\n')[h.start + h.count - 1] === '}'), '1836: git aligns an existing closing brace after the added hunk');
    const result = select.selectSections({changed:[lane], selftestText:'', selftestHunks:[], covers:{schema:1, about:'fixture', sections:{'1880':[], '1881':[], '1882':[]}}, laneSources:[{file:lane, text:next, hunks}]});
    same(result.sections, [1881,1882], '1836: real append selects exactly two new sections: ' + result.reasons.join('; '));
    check(!result.all, '1836: real append avoids whole suite');
    console.log('1836 real diff: ' + diff.stdout);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1837. A replacement spanning sections remains conservative; pure additions stay precise (w19-r3).
async function section1837(): Promise<void> {
  const path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const text = 'async function section7() {\n  check(true);\n}\n\nasync function section8() {\n  check(true);\n}\n';
  for (const file of [select.SELFTEST_PATH, select.laneTestPath('guards-and-tooling')]) {
    const run = (oldCount: number) => select.selectSections({changed:[file], selftestText:file === select.SELFTEST_PATH ? text : '', selftestHunks:file === select.SELFTEST_PATH ? [{start:2,count:5,oldCount}] : [],
      covers:{schema:1,about:'fixture',sections:{'7':[],'8':[]}}, laneSources:file === select.SELFTEST_PATH ? [] : [{file,text,hunks:[{start:2,count:5,oldCount}]}]});
    const replaced = run(1);
    check(replaced.all && replaced.reasons.some((reason: string) => reason.includes('replaces lines across')), '1837: old side may have held a helper: ' + replaced.reasons.join('; '));
    const added = run(0);
    check(!added.all, '1837: same new side as pure addition stays precise');
    same(added.sections, [7,8], '1837: both added section ranges selected');
  }
}

// --- 1838. Lane readers follow the areas-file order and discover an added lane immediately (w19-r3).
async function section1838(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1838-'));
  try {
    fs.mkdirSync(path.join(root, 'tools')); fs.mkdirSync(path.join(root, 'docs')); fs.mkdirSync(path.join(root, 'kernel'));
    fs.symlinkSync(path.join(PROGRAM_ROOT, 'kernel/node_modules'), path.join(root, 'kernel/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['section-select.mts', 'check-map.json']) fs.copyFileSync(path.join(PROGRAM_ROOT, 'tools', name), path.join(root, 'tools', name));
    const areas = JSON.parse(fs.readFileSync(path.join(PROGRAM_ROOT, 'docs/areas.json'), 'utf8'));
    areas.section_ranges['fixture-lane'] = [1900,1999];
    fs.writeFileSync(path.join(root, 'docs/areas.json'), JSON.stringify(areas));
    const copied = await import(pathToFileURL(path.join(root, 'tools/section-select.mts')).href);
    same([...copied.LANES], Object.keys(areas.section_ranges), '1838: LANES follows configured section-range order including new lane');
    const lane = copied.laneTestPath('fixture-lane');
    const laneText = 'async function section1900() {\n}\nif (selected(1900)) await section1900();\n';
    const sources = copied.sectionSources((file: string) => file === copied.SELFTEST_PATH ? 'if (selected(1)) {}\n' : file === 'docs/areas.json' ? JSON.stringify(areas) : file === lane ? laneText : null);
    check(sources.some((source: {file: string}) => source.file === lane), '1838: sectionSources reads new lane without a separate guard update');
    fs.mkdirSync(path.dirname(path.join(root, lane)), {recursive:true});
    fs.writeFileSync(path.join(root, lane), laneText); fs.writeFileSync(path.join(root, copied.SELFTEST_PATH), 'if (selected(1)) {}\n');
    check(copied.suiteSources(path.join(root, copied.SELFTEST_PATH)).some((source: {file: string}) => source.file.replaceAll('\\', '/').endsWith(lane)), '1838: disk suite reader sees new lane');
    const claim = copied.laneCoversPath('fixture-lane');
    check(copied.coversFiles((file: string) => file === 'docs/areas.json' ? JSON.stringify(areas) : file === copied.COVERS_PATH || file === claim ? '{"schema":1,"sections":{}}' : null).some((part: {file: string}) => part.file === claim), '1838: claim reader sees new lane');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

// --- 1831. The shared ownership fixture derives its default title from the current branch (w19-r3).
async function section1831(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
  const { repositoryNeutralEnv } = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-1831-'));
  try {
    const env = repositoryNeutralEnv({...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, TEMP:root, TMP:root, TMPDIR:root});
    const git = (...args: string[]) => spawnSync('git', args, {cwd:root, env:repositoryNeutralEnv(env), encoding:'utf8', timeout:30000});
    equal(git('init', '-q', '-b', 'int/c902').status, 0, '1831: initialize fixture');
    const source = fs.readFileSync(path.join(PROGRAM_ROOT, 'kernel/test/selftest.ts'), 'utf8');
    const expression = /const start = \(patterns: string\[\], title = (.*?)\) => \{/.exec(source)![1]!;
    const defaultTitle = () => new Function('git', 'return ' + expression)((...args: string[]) => git(...args).stdout.trim());
    const run = (title: string) => {
      const text = title + '\nOWNS PATHS:\n- `a.ts`\nSTAY OUT OF: none\n', file = path.join(root, 'kickoff.md');
      fs.writeFileSync(file, text);
      return spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/owns.mts'), 'start', '--kickoff', file, '--sha256', createHash('sha256').update(text).digest('hex')], {cwd:root, env, encoding:'utf8', timeout:30000});
    };
    for (const branch of ['int/c902', 'dev/w1-r2']) {
      equal(git('symbolic-ref', 'HEAD', 'refs/heads/' + branch).status, 0, '1831: set branch');
      const title = defaultTitle();
      equal(title, '# ' + branch.split('/')[1] + ' kickoff: fixture', '1831: default names current branch including revision');
      const started = run(title);
      equal(started.status, 0, '1831: matching default starts: ' + started.stderr);
      const wrong = run('# c999 kickoff: fixture');
      check(wrong.status === 1 && wrong.stderr.includes('c999'), '1831: another unit still refuses: ' + wrong.stderr);
    }
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}
