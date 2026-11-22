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
if (selected(1839)) await section1839();
if (selected(1840)) await section1840();
if (selected(1841)) await section1841();
if (selected(1842)) await section1842();
if (selected(1843)) await section1843();
if (selected(1844)) await section1844();
if (selected(1846) && prerequisite(1846, () => !isCompiled(), 'requires source tools')) await section1846();
if (selected(1847) && prerequisite(1847, () => !isCompiled(), 'requires source tools')) await section1847();
if (selected(1848) && prerequisite(1848, () => !isCompiled(), 'requires source tools')) await section1848();
if (selected(1849) && prerequisite(1849, () => !isCompiled(), 'requires source tools')) await section1849();
if (selected(1850) && prerequisite(1850, () => !isCompiled(), 'requires source tools')) await section1850();
if (selected(1851) && prerequisite(1851, () => !isCompiled(), 'requires source landing tool')) await section1851();
if (selected(1852) && prerequisite(1852, () => !isCompiled(), 'requires source tools')) await section1852();
if (selected(1853) && prerequisite(1853, () => !isCompiled(), 'requires source tools')) await section1853();
if (selected(1854) && prerequisite(1854, () => !isCompiled(), 'requires source tools')) await section1854();
if (selected(1855)) await section1855();
if (selected(1856) && prerequisite(1856, () => !isCompiled(), 'requires source tools')) await section1856();
if (selected(1857) && prerequisite(1857, () => !isCompiled(), 'requires source docs gate')) await section1857();
if (selected(1858) && prerequisite(1858, () => !isCompiled() && process.platform !== 'win32', 'requires the source WSL tool and Bash')) await section1858();
if (selected(1859)) await section1859();
if (selected(1860)) await section1860();
if (selected(1861) && prerequisite(1861, () => !isCompiled(), 'requires source tools')) await section1861();
if (selected(1862) && prerequisite(1862, () => !isCompiled(), 'requires source tools')) await section1862();
if (selected(1863) && prerequisite(1863, () => !isCompiled(), 'requires source tools')) await section1863();
if (selected(1864) && prerequisite(1864, () => !isCompiled(), 'requires source tools')) await section1864();
if (selected(1865) && prerequisite(1865, () => !isCompiled(), 'requires source tools')) await section1865();
if (selected(1866) && prerequisite(1866, () => !isCompiled(), 'requires source tools')) await section1866();
if (selected(1867) && prerequisite(1867, () => !isCompiled(), 'requires source tools')) await section1867();
if (selected(1868) && prerequisite(1868, () => !isCompiled(), 'requires source tools')) await section1868();
if (selected(1869) && prerequisite(1869, () => !isCompiled(), 'requires source tools')) await section1869();
if (selected(1871) && prerequisite(1871, () => !isCompiled(), 'requires source tools')) await section1871();
if (selected(1872) && prerequisite(1872, () => !isCompiled(), 'requires source tools')) await section1872();
if (selected(1873) && prerequisite(1873, () => !isCompiled(), 'requires source tools')) await section1873();
if (selected(1874) && prerequisite(1874, () => !isCompiled(), 'requires source landing tool')) await section1874();
if (selected(1875) && prerequisite(1875, () => process.platform !== 'win32' && !isCompiled(), 'requires a POSIX shell and source tools')) await section1875();
if (selected(1876) && prerequisite(1876, () => !isCompiled(), 'requires source tools')) await section1876();
if (selected(1884) && prerequisite(1884, () => !isCompiled(), 'requires source tools')) await section1884();
if (selected(1885) && prerequisite(1885, () => !isCompiled(), 'requires source tools')) await section1885();
if (selected(1886) && prerequisite(1886, () => !isCompiled(), 'requires source tools')) await section1886();
if (selected(1892)) await section1892();
if (selected(1893) && prerequisite(1893, () => process.platform === 'linux' && !isCompiled(), 'requires Linux and the source reaper')) await section1893();
if (selected(1894) && prerequisite(1894, () => !isCompiled(), 'requires source tools and Git')) await section1894();
if (selected(1895) && prerequisite(1895, () => !isCompiled(), 'requires the source worker environment')) await section1895();
if (selected(1896) && prerequisite(1896, () => process.platform === 'linux' && !isCompiled(), 'requires Linux and source landing tools')) await section1896();
if (selected(1898) && prerequisite(1898, () => !isCompiled(), 'requires the source section selector')) await section1898();
if (selected(1899) && prerequisite(1899, () => !isCompiled(), 'requires the source section selector')) await section1899();
if (selected(1900) && prerequisite(1900, () => !isCompiled(), 'requires source tools')) await section1900();
if (selected(1950)) await section1950();
if (selected(1951)) await section1951();
if (selected(1952) && prerequisite(1952, () => !isCompiled(), 'requires source inventory checker and real Git')) await section1952();
if (selected(1953) && prerequisite(1953, () => !isCompiled(), 'requires source inventory command and real Git')) await section1953();
if (selected(1954)) await section1954();
if (selected(1980)) await section1980();
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
    const hooked = select.stagedSelection((args: string[]) => run(...args));
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
    const suite = path.join(PROGRAM_ROOT, cold.SELFTEST_PATH);
    const before = cold.dispatchParseCount;
    cold.suiteText(suite);
    const after = cold.dispatchParseCount;
    check(after > before, '1835: the first suite read parses source');
    cold.suiteText(suite);
    equal(cold.dispatchParseCount, after, '1835: the repeated suite read adds no parses');
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

// --- 1839. w22 row 1: guard boundary regression.
async function section1839(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    for (const [target, kind, slug] of [
      ['shelf/missing/wiki/p.md', 'Shelf Book', 'missing'],
      ['collection/books/missing/wiki/p.md', 'collection Book', 'missing'],
      ['collection/projects/missing/_project.md', 'Project Hub', 'missing'],
      ['collection/books/README', 'collection Book', 'readme'],
    ]) for (const answer of [read(target!), shell(`cat ${target}`)]) denied(answer, [`No ${kind} named '${slug}' is in this Library`, 'deskpost browse'], '1839: missing root');
    for (const target of ['shelf/closed/wiki/p.md', 'collection/books/closed/wiki/p.md', 'collection/projects/closed/_project.md']) for (const answer of [read(target), shell(`cat ${target}`)]) denied(answer, ['is closed'], '1839: real closed root');
    for (const target of ['shelf/open/wiki/p.md', 'collection/books/open/wiki/p.md', 'collection/projects/one/_project.md']) {
      allowed(read(target), '1839: open root through Read');
      const output = JSON.parse(shell(`cat ${target}`) || '{}').hookSpecificOutput;
      const reader = target.startsWith('collection/projects/') ? 'read_open_project_page' : 'read_open_book_page';
      check(output?.hookEventName === 'PreToolUse' && output?.permissionDecision === undefined &&
        output?.additionalContext?.includes(reader), '1839: open root through shell advises ' + reader);
    }
    denied(shell('cat shelf/missing/wiki/p.md'), ['file tool', 'pass', 'path'], '1839: text remedy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1840. w22 row 2: guard boundary regression.
async function section1840(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    const outside = path.join(root, 'scratch'); fs.mkdirSync(outside);
    for (const verb of ['cd', 'pushd', 'Set-Location']) {
      allowed(shell(`${verb} "${outside}" && cat collection/projects/closed/_project.md`), '1840: relative read outside');
      allowed(shell(`${verb} "${outside}" && echo hi > notebook/topic/page.md`), '1840: relative write outside');
      allowed(shell(`${verb} "${outside}" && cat shelf/closed/wiki/p.md`), '1840: Shelf read outside');
      allowed(shell(`${verb} "${outside}" && echo hi > internal/y`), '1840: internal write outside');
    }
    for (const command of [
      `cd "${lib}" && cat collection/projects/closed/_project.md`,
      `cd "${lib}" && echo hi > notebook/topic/page.md`,
      `cd "${outside}" && cd "${lib}" && cat collection/projects/closed/_project.md`,
      `cd "${outside}" && "cd" "${lib}" && cat collection/projects/closed/_project.md`,
      `cd "${outside}" && cd "${lib}" && echo hi > notebook/topic/page.md`,
      `cd "${outside}" && cat "${path.join(lib, 'collection/projects/closed/_project.md')}"`,
      `cd "${outside}" && echo hi > "${path.join(lib, 'internal/y')}"`,
      `cd "${path.join(root, 'absent')}" || Set-Content internal/w22-witness x`,
      `cd "${path.join(root, 'absent')}" || cat collection/projects/closed/_project.md`,
      ...[';', '|', '&', '\n'].map(separator => `cd "${outside}" ${separator} cat collection/projects/closed/_project.md`),
    ]) denied(shell(command), [], '1840: still guarded');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1841. w22 row 3: guard boundary regression.
async function section1841(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    const outside = path.join(root, 'copy.json');
    allowed(shell(`mkdir -p "${path.join(root, 'scratch/x')}"; grep -c train internal/notebook-layout.json`), '1841: read after independent write');
    for (const verb of ['cp', 'copy', 'xcopy', 'robocopy', 'Copy-Item', 'install']) {
      if (verb === 'robocopy') denied(shell(`${verb} internal/notebook-layout.json "${outside}"`), [], '1841: unrecognised robocopy source');
      else allowed(shell(`${verb} internal/notebook-layout.json "${outside}"`), '1841: copy source ' + verb);
      denied(shell(`${verb} "${outside}" internal/y`), ['internal/y'], '1841: copy destination ' + verb);
    }
    allowed(shell(`Copy-Item -Path internal/notebook-layout.json -Destination "${outside}"`), '1841: named outside destination');
    allowed(shell(`cp -r internal/notebook-layout.json "${outside}"`), '1841: recursive outside destination');
    allowed(shell(`xcopy /Y internal\\notebook-layout.json "${outside}"`), '1841: switch outside destination');
    for (const command of [
      'cp -t internal/y source.txt', 'install -t internal/y source.txt',
      'cp --target-directory=internal/y source.txt', 'robocopy source internal/y witness.txt',
      'Copy-Item -Destination:internal/y -Path source.txt', 'Copy-Item source.txt -Dest internal/y',
      'pwsh -NoProfile -Command "Set-Content internal/y x"', 'cmd /d /c copy source.txt internal/y',
      'command cp source.txt internal/y',
    ]) {
      denied(shell(command), ['internal/y'], '1841: uncertain copy or wrapper retains protection');
      allowed(shell(command.replace('internal/y', outside)), '1841: outside target inverse');
    }
    for (const command of [
      `mv internal/x "${outside}"`, 'echo x > internal/y', 'mkdir x && touch internal/y',
      'Copy-Item -Path a -Destination internal/y', 'cp a notebook/other/topic/page.md',
      'mkdir x || touch internal/y', 'printf x | tee internal/y', 'mkdir x\ntouch internal/y',
      'touch "internal/file with spaces"', 'cp a internal/y 2>log', 'cp a internal/./y',
      'xcopy a internal/y /E', 'copy a internal/y /Y', 'robocopy a internal/y /R:1',
    ]) denied(shell(command), [], '1841: still a write');
    denied(shell(`echo 'mkdir; cp internal/x' && cat internal/notebook-layout.json`), [], '1841: quoted write retains protection');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1842. w22 row 4: guard boundary regression.
async function section1842(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    for (const command of ['ls collection/projects/', "cat <<EOF\ncollection/projects/\nEOF"]) denied(shell(command), ['deskpost browse', 'file tool'], '1842: span remedy');
    const text = hook('computer-use', 'Bash', { command: "printf '%s' '--computer-use on' > note.md" });
    denied(text, ['file editor', 'pass the file by path'], '1842: computer-use text remedy');
    allowed(hook('computer-use', 'Bash', { command: 'deskpost seat settings first --computer-use off' }), '1842: explicit off');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1843. w22 row 5: guard boundary regression.
async function section1843(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    allowed(shell("rg -n word -g '!collection/books/closed/**' ."), '1843: collection exclusion');
    for (const command of ["rg -g 'collection/books/closed/**' word .", "cat -g '!collection/books/closed/**'", "rg -g '!collection/books/closed/$(cat x)' word ."]) denied(shell(command), [], '1843: real or computed read');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1844. w22 row 6: guard boundary regression.
async function section1844(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w22-guard-')));
  try {
    const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
    const env = { LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', TEMP: temp, TMP: temp, TMPDIR: temp };
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], { cwd: root, env }).exit, 0, 'w22: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first'); fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/open\nbooks/open\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/one\nprojects/two\n');
    for (const folder of ['shelf/open', 'shelf/closed', 'collection/books/open', 'collection/books/closed', 'collection/projects/one', 'collection/projects/two', 'collection/projects/closed']) fs.mkdirSync(path.join(lib, folder), { recursive: true });
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) => runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], { cwd: lib, env, input: JSON.stringify({ tool_name, tool_input }) }).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', { command });
    const read = (file_path: string) => hook('shelf-read', 'Read', { file_path });
    const glob = (pattern: string) => hook('shelf-read', 'Glob', { pattern });
    const denied = (answer: string, words: string[], label: string) => check(answer.includes('"permissionDecision":"deny"') && words.every(word => answer.includes(word)), `${label}: ${answer || '(allowed)'}`);
    const allowed = (answer: string, label: string) => equal(answer.trim(), '', label);
    allowed(glob('collection/projects/{one,two}/kickoffs/*.md'), '1844: two open Hubs');
    allowed(glob('collection/projects/{one,two}/notes/*.md'), '1844: notes in open Hubs');
    for (const pattern of ['collection/projects/{one,two}/../closed/_project.md', 'collection/projects/{one,two}/..'])
      denied(glob(pattern), ['spans collection'], '1844: parent escapes brace roots');
    allowed(glob('collection/projects/one/{a,b}.md'), '1844: choices inside one open root stay allowed');
    denied(glob('collection/projects/{one,closed}/kickoffs/*.md'), ["Project Hub 'closed' is closed"], '1844: closed choice');
    fs.writeFileSync(path.join(desk, '.open-books'), 'books/open\nbooks/second\n');
    fs.mkdirSync(path.join(lib, 'collection/books/second'), { recursive: true });
    allowed(glob('collection/books/{open,second}/wiki/*.md'), '1844: two open Books');
    denied(glob('collection/books/{open,closed}/wiki/*.md'), ["Collection Book 'closed' is closed"], '1844: closed Book choice');
    for (const pattern of ['collection/projects/{one,{two,closed}}/p.md', 'collection/projects/{one,tw*}/p.md', 'collection/projects/{one,two}/{a,b}.md']) denied(glob(pattern), ['spans collection', 'one root per call'], '1844: complex brace');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1846. w25 regression.
async function section1846(): Promise<void> {
  const path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  for (const opening of ['/**', '/*']) {
    const text = '// lead\n'+opening+'\n * comment\n */\nasync function section7() {\n}\n';
    const run = (start: number) => select.selectSections({changed:[select.SELFTEST_PATH], selftestText:text, selftestHunks:[{start,count:1}],covers:{schema:1,about:'fixture',sections:{}}});
    check(!run(3).all, '1846: attached block belongs to section'); same(run(3).sections,[7],'1846: only section seven');
    equal(select.sectionRanges(text)[0].start,1,'1846: line comments above block included');
  }
  const detached = '/**\n * detached\n */\nconst shared = true;\nasync function section7() {\n}\n';
  check(select.selectSections({changed:[select.SELFTEST_PATH],selftestText:detached,selftestHunks:[{start:2,count:1}],covers:{schema:1,about:'fixture',sections:{}}}).all,'1846: detached block is shared');
}

// --- 1847. w25 regression.
async function section1847(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const result = spawnSync('git',['ls-files','-z'],{cwd:PROGRAM_ROOT,env:repositoryNeutralEnv(),encoding:'utf8'});
  equal(result.status,0,'1847: tracked inventory read');
  const covers = select.mergeCovers(select.coversFiles((file: string) => fs.existsSync(path.join(PROGRAM_ROOT,file)) ? fs.readFileSync(path.join(PROGRAM_ROOT,file),'utf8') : null));
  same(select.unmappedPaths(result.stdout.split('\0').filter(Boolean),covers),[],'1847: every tool/test path has a mapping or whole-suite reason');
  same(select.unmappedPaths(['tools/new-unmapped.mts','tools/areas.mts'],covers),['tools/new-unmapped.mts'],'1847: new unmapped tool named, mapped area tool omitted');
}

// --- 1848. w25 regression.
async function section1848(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const covers = select.mergeCovers(select.coversFiles((file: string) => fs.existsSync(path.join(PROGRAM_ROOT,file)) ? fs.readFileSync(path.join(PROGRAM_ROOT,file),'utf8') : null));
  const wanted = [82,92,118,120,215,631];
  same(covers.wholeTreeSections,wanted,'1848: source-tree readers listed once');
  const choose = (file: string) => select.selectSections({changed:[file],selftestText:'',selftestHunks:[],covers});
  const known = choose('kernel/src/psjson.ts');
  check(known.all || wanted.every(n => known.sections.includes(n)),'1848: every whole-tree reader selected for a mapped source');
  const unknown = choose('kernel/src/fixture-unmapped.ts');
  check(unknown.all && unknown.reasons.some((r: string) => r.includes('whole source tree')),'1848: unmapped source keeps full fallback and whole-tree reason');
}

// --- 1849. w25 regression.
async function section1849(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {spawnSync} = await import('node:child_process');
  const {childEnv} = await import('../gate-env.ts');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT,'tools/section-select.mts')).href);
  const maps = [select.COVERS_PATH,select.laneCoversPath('guards-and-tooling'),select.laneCoversPath('books-and-memory')];
  for (const pair of [[maps[0],maps[1]],[maps[1],maps[2]]]) {
    let refusal = ''; try { select.mergeCovers(pair.map(file => ({file,text:JSON.stringify({schema:1,sections:{'7':[]}})}))); } catch(e) {refusal=String(e);}
    check(refusal.includes('section 7') && pair.every(file => refusal.includes(file)), '1849: duplicate covers names both files');
  }
  const normalizeSeparators = (value: string) => value.replaceAll('\\', '/');
  const namesBoth = (message: string, ...files: string[]) =>
    files.every(file => normalizeSeparators(message).includes(normalizeSeparators(file)));
  const windowsRoot = 'C:\\x';
  check(namesBoth('C:\\x\\selftest.ts and C:\\x/lanes/guards-and-tooling.ts',
    path.win32.join(windowsRoot, 'selftest.ts'), path.win32.join(windowsRoot, 'lanes', 'guards-and-tooling.ts')),
  '1849: mixed Windows path separators still name both files');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'w25-duplicates-'));
  try {
    fs.mkdirSync(path.join(root,'lanes'));
    const suite = path.join(root,'selftest.ts'), lane = path.join(root,'lanes/guards-and-tooling.ts');
    for (const declaration of [true,false]) {
      fs.writeFileSync(suite, declaration ? 'async function section7() {\n}\nif (selected(7)) await section7();\n' : 'if (selected(7)) {\n}\n');
      fs.writeFileSync(lane,'async function section7() {\n}\nif (selected(7)) await section7();\n');
      const ran = spawnSync(process.execPath,[path.join(PROGRAM_ROOT,'kernel/test/run-parallel.ts'),'--suite',suite],{cwd:root,env:childEnv(),encoding:'utf8',timeout:30000});
      const out=ran.stdout+ran.stderr;
      check(ran.status !== 0 && namesBoth(out, suite, lane) && out.includes('section 7'),'1849: runner refuses duplicate source before execution: '+out);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}

// --- 1850. w25 regression.
async function section1850(): Promise<void> {
  const path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const lander = await import(pathToFileURL(path.join(PROGRAM_ROOT,'tools/lander.mts')).href);
  check(typeof lander.readAllRuns === 'function','1850: shared run reader exported');
  if (typeof lander.readAllRuns !== 'function') return;
  const rows = Array.from({length:50},(_,i) => ({id:i+1})); let calls=0;
  const read = async () => {calls++; if(calls>2) throw Error('fixture page bound'); return {total_count:50,workflow_runs:rows};};
  equal((await lander.readAllRuns(read)).length,50,'1850: full last page retained');equal(calls,1,'1850: total stops a full last page');
  calls=0; let refusal='';
  try {await lander.readAllRuns(async () => {calls++; return {total_count:100,workflow_runs:calls===1?rows:[...rows].reverse()};});}catch(e){refusal=String(e);}
  check(refusal.includes('repeated') && calls===2,'1850: repeated page refused before another request');
  for (const [total, received] of [[2, 1], [2, 0], [1, 2]]) {
    let message = '';
    try {
      await lander.readAllRuns(async () => ({total_count: total, workflow_runs: rows.slice(0, received)}));
    } catch (error) { message = String(error); }
    check(message.includes(`received ${received}, expected ${total}`),
      `1850: received ${received} of ${total} runs is refused with both counts`);
  }
  equal(lander.LANDER_VERSION,'1.1.4','1850: fix version');
}

// --- 1851. Opening a pull request requires the repository's commit hooks.
async function section1851(): Promise<void> {
  const path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {land} = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/land.mts')).href);
  for (const setting of ['', '.githooks']) {
    const messages: string[] = [];
    const commands: string[] = [];
    const status = await land('int/fixture', {
      cwd: PROGRAM_ROOT, open: true, tokenItem: 'fixture', env: {DESKPOST_SECRETS_DIR: 'fixture'},
      say: (line: string) => messages.push(line),
      runner: async (command: string, args: string[], cwd: string) => {
        if (command !== 'git') throw Error('fixture reached credential reader');
        commands.push(args.join(' '));
        equal(cwd, PROGRAM_ROOT, '1851: hook configuration is read in the repository');
        if (args.join(' ') === 'config core.hooksPath') {
          if (!setting) throw Error('git config exited 1');
          return setting;
        }
        throw Error('unexpected fixture command');
      },
    });
    equal(status, 1, '1851: fixture never opens a pull request');
    same(commands, ['config core.hooksPath'], '1851: read the hook configuration before push');
    check(messages.some(line => line.includes(setting ? 'fixture reached credential reader' : 'git config core.hooksPath .githooks')),
      '1851: configured clone continues, unconfigured clone gets the remedy: ' + messages.join(' '));
  }
}

// --- 1852. w25 regression.
async function section1852(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const gate = await import(pathToFileURL(path.join(PROGRAM_ROOT,'tools/gate.ts')).href);
  check(typeof gate.lineEndingProblems === 'function','1852: staged line-ending check exists');
  if (typeof gate.lineEndingProblems !== 'function') return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'w25-lines-'));
  try {
    const git=(...args: string[]) => {const r=spawnSync('git',args,{cwd:root,env:repositoryNeutralEnv(),encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);};
    git('init','-q');git('config','core.autocrlf','false');
    fs.writeFileSync(path.join(root,'lf.ts'),'one\ntwo\n');fs.writeFileSync(path.join(root,'crlf.ts'),'one\r\ntwo\r\n');
    for(let i=0;i<8;i++)fs.writeFileSync(path.join(root,`safe${i}.md`),'safe\n');
    git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.git/no-hooks','commit','-qm','base');
    fs.writeFileSync(path.join(root,'lf.ts'),'one\r\ntwo\r\n');
    fs.writeFileSync(path.join(root,'lone.json'),'one\ntwo\rthree\n');
    fs.writeFileSync(path.join(root,'crlf.ts'),'changed\r\n');
    fs.writeFileSync(path.join(root,'new.ts'),'new\r\n');fs.writeFileSync(path.join(root,'binary.ts'),Buffer.from([0,13,1]));
    for(let i=0;i<5;i++)fs.appendFileSync(path.join(root,`safe${i}.md`),'next\n');
    git('add','.');fs.writeFileSync(path.join(root,'lone.json'),'working tree hides staged CR\n');
    const started=performance.now();const problems=gate.lineEndingProblems(root);const elapsed=performance.now()-started;
    check(problems.some((p: string)=>p.includes('lf.ts:1') && p.includes('CRLF')),'1852: LF changed to CRLF refused');
    check(problems.some((p: string)=>p.includes('lone.json:2') && p.includes('lone')),'1852: staged lone CR names line');
    equal(problems.length,2,'1852: existing CRLF, new CRLF, binary and LF changes allowed');
    check(elapsed<2000,'1852: ten staged files checked under two seconds: '+elapsed);console.log('1852 ten-file milliseconds: '+elapsed.toFixed(1));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

// --- 1853. w25 regression.
async function section1853(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const scan = await import(pathToFileURL(path.join(PROGRAM_ROOT,'tools/scan.ts')).href);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'w25-scope-'));
  try {
    const git=(...args: string[]) => {const r=spawnSync('git',args,{cwd:root,env:repositoryNeutralEnv(),encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);};
    git('init','-q');fs.writeFileSync(path.join(root,'PLAN-x.md'),'plan\n');fs.writeFileSync(path.join(root,'PLAN-y.md'),'plan\n');git('add','.');
    const terms=path.join(root,'terms');fs.mkdirSync(terms);fs.writeFileSync(path.join(terms,'identity-denylist.txt'),'scope-fixture-private\n');
    const result=scan.identityScan(root,'',terms);
    check(result.status==='pass','1853: plan-only commit clean');
    check(result.detail.includes('0 staged blob(s); 2 staged file(s) left out as not product files: PLAN-x.md, PLAN-y.md'),'1853: scope names both omitted plan files: '+result.detail);
    fs.writeFileSync(path.join(root,'product.txt'),'scope-fixture-private\n');git('add','product.txt');
    const refused=scan.identityScan(root,'',terms);
    check(refused.status==='fail' && refused.detail.includes('2 staged file(s) left out as not product files: PLAN-x.md, PLAN-y.md'),'1853: failed scan also names omissions');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

// --- 1854. w25 regression.
async function section1854(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {childEnv} = await import('../gate-env.ts');
  const expected='kernel self-test FAILED (1 of 0): LIBRARY_SELFTEST_SECTIONS selected no checks: 999999\n';
  for(let i=0;i<3;i++) {
    const ran=spawnSync(process.execPath,[path.join(PROGRAM_ROOT,'kernel/test/selftest.ts')],{cwd:PROGRAM_ROOT,env:{...childEnv(),LIBRARY_SELFTEST_SECTIONS:'999999'},encoding:'utf8',timeout:30000});
    equal(ran.status,1,'1854: deliberately red self-test exits one, run '+i);
    check(ran.stderr.endsWith(expected),'1854: full failure line drained, run '+i+': '+ran.stderr);
  }
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'w25-drain-'));
  try {
    const suite=path.join(root,'selftest.ts');
    fs.writeFileSync(suite, 'const selected=()=>true;\nif (selected(1)) {\nprocess.stderr.write("kernel self-test FAILED (1 of 1): drain fixture\\n");\nprocess.exitCode=1;\n}\n');
    const ran=spawnSync(process.execPath,[path.join(PROGRAM_ROOT,'kernel/test/run-parallel.ts'),'--suite',suite],{cwd:root,env:{...childEnv(),LIBRARY_SELFTEST_SECTIONS:'1',HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root},encoding:'utf8',timeout:30000});
    check(ran.status===1 && (ran.stdout+ran.stderr).includes('kernel self-test FAILED (1 of 1): drain fixture'),'1854: runner retains red exit and full line');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}


// --- 1855. Direct shell page reads remind the caller which Desk reader to use.
async function section1855(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w26-shell-read-')));
  try {
    const env = {LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: ''};
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], {cwd: root, env}).exit, 0, '1855: fixture init');
    const desk = path.join(lib, '.claude', 'seats', 'first');
    fs.mkdirSync(desk, {recursive: true});
    fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/demo\nbooks/demo\n');
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/demo\n');
    const book = 'collection/books/demo/wiki/page.md';
    const hub = 'collection/projects/demo/_project.md';
    const shelf = 'shelf/demo/wiki/page.md';
    for (const page of [book, hub, shelf]) {
      const file = path.join(lib, page);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, 'fixture\n');
    }
    const hook = (verb: string, tool_name: string, tool_input: Record<string, unknown>) =>
      runCli(['hook', verb, '--workspace', lib, '--seat', 'first'], {cwd: lib, env, input: JSON.stringify({tool_name, tool_input})}).stdout;
    const shell = (command: string) => hook('shell-shelf-read', 'Bash', {command});
    for (const command of ['cat', 'Get-Content', 'type', 'head -n 2', 'tail', 'less', 'more', "sed -n '1p'"]) {
      for (const [page, tool] of [[book, 'read_open_book_page'], [shelf, 'read_open_book_page'], [hub, 'read_open_project_page']]) {
        const answer = shell(`${command} "${page}"`);
        const output = JSON.parse(answer || '{}').hookSpecificOutput;
        check(output?.hookEventName === 'PreToolUse' && output?.additionalContext?.includes(tool) && !output.permissionDecision,
          '1855: ' + command + ' advises the reader for ' + page + ': ' + answer);
      }
    }
    for (const command of ['echo collection/books/demo', 'cat collection/books/demo', 'cat notebook/topic/page.md', "sed 'collection/books/demo/wiki/page.md'"])
      equal(shell(command).trim(), '', '1855: no advice without an open page read: ' + command);
    for (const command of ['cat > copy.md "' + book + '"', 'cat "' + book + '" > copy.md',
      'cat >> copy.md "' + book + '"']) {
      const advice = JSON.parse(shell(command) || '{}').hookSpecificOutput?.additionalContext;
      check(advice?.includes('read_open_book_page'), '1855: open operand gets advice: ' + command);
    }
    equal(shell('cat local.md > "' + book + '"').trim(), '', '1855: output target gets no read advice');
    equal(hook('shelf-read', 'Read', {file_path: book}).trim(), '', '1855: Read tool stays silent');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1856. Whole-suite paths keep their coverage when a filename appears in a section.
async function section1856(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const [legacy, ...lanes] = select.sectionSources((file: string) => fs.readFileSync(path.join(PROGRAM_ROOT, file), 'utf8'));
  const input = {
    selftestText: legacy.text,
    laneSources: lanes.map((lane: {file: string; text: string}) => ({...lane, hunks: []})),
    covers: {schema: 1, about: 'Path selection', sections: {}},
  };
  const choose = (file: string, selftestHunks: {start: number; count: number}[] = []) =>
    select.selectSections({...input, changed: [file], selftestHunks});
  const fixture = ['tools/mirror-fixture/fixture', 'sh'].join('.');
  const fixtureSelection = choose(fixture);
  check(fixtureSelection.all, '1856: mirror fixture selects every section; selected ' + fixtureSelection.sections.join(', '));
  check(fixtureSelection.reasons.includes('every section: ' + fixture + ' is on the whole-suite list in tools/check-map.json'),
    '1856: mirror fixture names its whole-suite rule');
  check(choose('tools/gate.ts').all, '1856: gate selects every section');
  // Keep the probe's spelling out of filename-based reader discovery.
  const lander = choose(['tools/lander', 'mts'].join('.'));
  check(!lander.all, '1856: the lander selects narrowly');
  same(lander.sections, [806, 807, 830, 1806, 1850, 1864], '1856: only the real lander readers are selected');
  const section = select.sectionRanges(legacy.text)[0];
  const selftest = choose(legacy.file, [{start: section.start, count: 1}]);
  check(!selftest.all, '1856: a hunk in one legacy section selects narrowly');
  same(selftest.sections, [section.section], '1856: only the edited legacy section is selected');
}

// --- 1857. Pinned GitHub links resolve at the named tag, using the real docs gate.
async function section1857(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-pinned-links-'));
  try {
    const env = repositoryNeutralEnv();
    const git = (...args: string[]) => {
      const ran = spawnSync('git', args, {cwd: root, env, encoding: 'utf8', timeout: 30_000});
      if (ran.status !== 0) throw Error(ran.stderr || String(ran.error ?? ran.status));
      return ran.stdout.trim();
    };
    const put = (name: string, text: string) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, text);
    };
    git('init', '-q');
    put('README.md', '# Fixture\n');
    put('docs/present.md', '# Present at the tag\n');
    put('docs/guide(old).md', '# Parentheses at the tag\n');
    put('docs/adr/0001-example.md', '# Fixture decision\n');
    put('docs/_index.md', '# Fixture index\n\n[Fixture decision](adr/0001-example.md)\n');
    git('add', '.');
    git('-c', 'core.hooksPath=.git/no-hooks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--author=Fixture <export@deskpost.invalid>', '-qm', 'Fixture root');
    git('tag', 'v-fixture');
    put('docs/new.md', '# Exists only in the working tree\n');
    const run = () => spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/docs-gate.ts'), '--file', 'README.md'],
      {cwd: root, env, encoding: 'utf8', timeout: 60_000});
    const base = 'https://github.com/eKioga/deskpost/blob/';
    const help = '.claude/skills/library-help/references/fixture.md';
    put(help, `# Fixture\n[Tagged](${base}v-fixture/docs/present.md#heading)\n`);
    put('llms-install.md', `[Missing tag](${base}v-missing/docs/present.md)\n`);
    git('add', help, 'llms-install.md');
    const good = run();
    check(/^PASS\s+docs\.pinned-github-links: 1 pinned link/m.test(good.stdout), '1857: tagged path resolves: ' + good.stdout);
    check(/^SKIP\s+docs\.pinned-github-links:.*v-missing.*llms-install\.md:1/m.test(good.stdout), '1857: absent tag is a named skip: ' + good.stdout);
    put(help, `# Fixture\n[Working only](${base}v-fixture/docs/new.md)\n`);
    const bad = run();
    const failures = (output: string) => output.match(/^FAIL\s/gm)?.length ?? 0;
    equal(failures(bad.stdout), failures(good.stdout) + 1, '1857: a tagged-path failure adds a gate failure');
    const broken = bad.stdout.split('\n').find(line => /^FAIL\s+docs\.pinned-github-links:/.test(line)) ?? '';
    check(broken.includes(help + ':2') && broken.includes(base + 'v-fixture/docs/new.md'),
      '1857: reports the file, line and unresolved link: ' + bad.stdout);
    const guide = base + 'v-fixture/docs/guide(old).md';
    const gone = base + 'v-fixture/docs/gone(old).md';
    put(help, '# Fixture\n[Bare](' + guide + ')\n[Angle](<' + guide + '>)\n');
    const parentheses = run().stdout;
    check(/^PASS\s+docs\.pinned-github-links: 2 pinned links?/m.test(parentheses) &&
      !/^FAIL\s+docs\.pinned-github-links:/m.test(parentheses), '1857: both parenthesized destinations resolve: ' + parentheses);
    put(help, '# Fixture\n[Gone](' + gone + ')\n');
    const missing = run().stdout;
    check(missing.split('\n').some(line => /^FAIL\s+docs\.pinned-github-links:/.test(line) && line.includes(gone)),
      '1857: reports the full missing path with parentheses: ' + missing);
    put(help, '# Fixture\n[Tagged](' + base + 'v-fixture/docs/present.md#heading)\n');
    const exportNotice = 'The gate trusted local git setting deskpost.exportRoot for the export binding. The tree scan remains unverified.';
    const linkDetail = (output: string) => output.split('\n').find(line => line.includes('docs.links-resolve:')) ?? '';
    check(!linkDetail(good.stdout).includes(exportNotice), '1857: a checkout without a binding omits the export notice');
    git('config', '--local', 'deskpost.exportRoot', git('rev-parse', 'HEAD'));
    const bound = linkDetail(run().stdout);
    check(bound.startsWith('PASS') && bound.includes(exportNotice), '1857: a valid export binding states what was trusted: ' + bound);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1858. The WSL preamble reports version drift before running the script.
async function section1858(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {spawnSync} = await import('node:child_process');
  const {CLONE, PREAMBLE, encodeScript} = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/wsl-run.mts')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-wsl-versions-'));
  try {
    const app = path.join(root, CLONE, 'app');
    const bin = path.join(root, CLONE, 'node/bin');
    const workflow = path.join(app, '.forgejo/workflows/ci.yml');
    fs.mkdirSync(bin, {recursive: true});
    fs.mkdirSync(path.dirname(workflow), {recursive: true});
    const source = fs.readFileSync(path.join(PROGRAM_ROOT, '.forgejo/workflows/ci.yml'), 'utf8');
    fs.writeFileSync(workflow, source);
    const binary = (name: string, version: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {mode: 0o755});
    binary('node', 'v24.12.0');
    const run = () => spawnSync('bash', ['-c', PREAMBLE, 'fixture.sh', encodeScript('echo script-ran\nexit 7\n')],
      {env: {...process.env, HOME: root, BASH_ENV: ''}, encoding: 'utf8', timeout: 30_000});
    binary('git', 'git version 2.43.0');
    const drift = run();
    equal(drift.status, 7, '1858: drift does not change the script exit');
    check(/^wsl-run: .*git 2\.43\.0.*2\.39\.5.*\nscript-ran\n$/.test(drift.stdout),
      '1858: one mismatch line precedes script output: ' + drift.stdout + drift.stderr);
    binary('git', 'git version 2.39.5');
    const match = run();
    equal(match.stdout, 'script-ran\n', '1858: real workflow image has a matching baseline');
    binary('node', 'v23.9.0');
    const nodeDrift = run();
    check(/^wsl-run: .*Node v23\.9\.0.*24.*\nscript-ran\n$/.test(nodeDrift.stdout), '1858: Node major drift is named');
    fs.writeFileSync(workflow, source.replace(/^(\s*image:\s*)\S+/m, '$1node:25-bookworm'));
    const unknown = run();
    check(/^wsl-run: .*node:25-bookworm.*no version baseline.*\nscript-ran\n$/.test(unknown.stdout),
      '1858: an unknown image warns and the script still runs');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1859. Recovery commands quote PowerShell literal paths.
async function section1859(): Promise<void> {
  const {recoveryGuardRemovalCommand} = await import('../../src/locks.ts');
  const quotes = ["'", '\u2018', '\u2019', '\u201a', '\u201b'];
  const cases = quotes.map(quote => {
    const path = 'a' + quote + 'b';
    const command = recoveryGuardRemovalCommand(path, 'win32');
    equal(command, "Remove-Item -LiteralPath 'a" + quote + quote + "b'",
      '1859: literal quote is doubled (U+' + quote.codePointAt(0)!.toString(16) + ')');
    return {path, command};
  });
  // The real PowerShell parser's answer for each command, captured once at d6c23e53 (kickoffs/s225, standing answer 4):
  // no errors, one command of three words, the third the original literal path. It holds on every platform now.
  const parsed: {line: string; words: string[]}[] = [
    {line: "Remove-Item -LiteralPath 'a''b'", words: ["Remove-Item", "-LiteralPath", "a'b"]},
    {line: "Remove-Item -LiteralPath 'a\u2018\u2018b'", words: ["Remove-Item", "-LiteralPath", "a\u2018b"]},
    {line: "Remove-Item -LiteralPath 'a\u2019\u2019b'", words: ["Remove-Item", "-LiteralPath", "a\u2019b"]},
    {line: "Remove-Item -LiteralPath 'a\u201a\u201ab'", words: ["Remove-Item", "-LiteralPath", "a\u201ab"]},
    {line: "Remove-Item -LiteralPath 'a\u201b\u201bb'", words: ["Remove-Item", "-LiteralPath", "a\u201bb"]},
  ];
  equal(cases.length, parsed.length, '1859: every command has its recorded parse');
  for (const [index, item] of cases.entries()) {
    equal(item.command, parsed[index]?.line, '1859: the command is the form PowerShell was seen to parse: ' + item.command);
    equal(parsed[index]?.words[2], item.path, '1859: the recorded parse gives back the original literal path: ' + item.path);
  }
}

// --- 1860. Closed Book refusals name the file routes for literal text.
async function section1860(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w27-literal-')));
  try {
    const env = {LIBRARY_WORKSPACES: path.join(root, 'registry'), LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: ''};
    const lib = path.join(root, 'lib');
    equal(runCli(['init', lib], {cwd: root, env}).exit, 0, '1860: fixture init');
    const book = 'shelf/demo/wiki/page.md';
    fs.mkdirSync(path.dirname(path.join(lib, book)), {recursive: true});
    fs.writeFileSync(path.join(lib, book), 'fixture');
    const desk = path.join(lib, '.claude', 'seats', 'first');
    fs.mkdirSync(desk, {recursive: true});
    fs.writeFileSync(path.join(desk, '.open-books'), '');

    const literal = 'A reference to ' + book;
    for (const command of ["printf %s '" + literal + "' > out.md",
      "deskpost train add x --title '" + literal + "'", 'cat ' + book]) {
      const answer = runCli(['hook', 'shell-shelf-read', '--workspace', lib, '--seat', 'first'],
        {cwd: lib, env, input: JSON.stringify({tool_name: 'Bash', tool_input: {command}})}).stdout;
      const output = JSON.parse(answer || '{}').hookSpecificOutput;
      equal(output?.permissionDecision, 'deny', '1860: closed path is refused: ' + command);
      const reason = output?.permissionDecisionReason ?? '';
      check(reason.includes('A shell command cannot read around that') && reason.includes('use the Grep tool'),
        '1860: the previous remedy remains: ' + reason);
      check(reason.includes('the file tool') && reason.includes('--title-path') &&
        reason.includes('--content-path') && reason.includes('--note-path') && reason.includes('quoted argument'),
        '1860: literal payload remedy: ' + reason);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1861. Only trailing Node warnings can follow a successful test verdict.
async function section1861(): Promise<void> {
  const path = await import('node:path'), {pathToFileURL} = await import('node:url');
  const {verdict} = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'kernel/test/run-parallel.ts')).href);
  const pass = 'kernel self-test passed (7 checks).\n';
  const warnings = '(node:321) ExperimentalWarning: fixture\n(Use \x60node --trace-warnings ...\x60 to show where the warning was created)\n';
  same(verdict(1, 0, pass + warnings), {verdict: 'PASS', checks: 7, detail: ''}, '1861: warning preserves pass and count');
  equal(verdict(1, 0, pass + 'kernel self-test FAILED\n').verdict, 'FAIL', '1861: trailing failure remains red');
  equal(verdict(1, 1, pass).verdict, 'FAIL', '1861: nonzero exit remains red');
}

// --- 1862. Kickoff checks warn about duplicate section claims and paths without areas.
async function section1862(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {childEnv} = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-kickoff-warnings-'));
  try {
    const put = (file: string, contents: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, contents);
    };
    for (const file of ['tools/kickoff-check.mts', 'tools/owns.mts', 'tools/scan.ts', 'tools/section-select.mts', 'tools/check-map.json',
      'kernel/test/gate-lock.ts', 'kernel/src/kickoffcheck.ts', 'kernel/src/verbs.ts', 'kernel/src/contentpath.ts',
      'docs/areas.json']) put(file, fs.readFileSync(path.join(PROGRAM_ROOT, file), 'utf8'));
    fs.cpSync(path.join(PROGRAM_ROOT, 'kernel/src'), path.join(root, 'kernel/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/adr'));
    const kickoff = 'TRAIN: example\nWHY NOW:\n- Fixture\nOWNS PATHS:\n- \x60tools/new.mts\x60\nSTAY OUT OF: none\n' +
      'ROWS:\n1. Example\n   Done when: complete.\nCHARTER: example\nCLOSE: finish.\n**Stop.**\n';
    const env = {...childEnv(), DESKPOST_GATE_DIR: path.join(root, 'absent')};
    const run = () => spawnSync(process.execPath, ['tools/kickoff-check.mts', 'kickoff.md'], {cwd: root, env, encoding: 'utf8', timeout: 30_000});
    put('tools/new.mts', 'export {};\n');
    put('kernel/test/section-covers.json', JSON.stringify({schema: 1, about: 'Fixture', sections: {}}));
    put('kickoff.md', kickoff.replace('tools/new.mts', 'none'));
    const clean = run();
    check(clean.status === 0 && !clean.stderr.includes('kickoff-check: warning:'), '1862: clean kickoff: ' + clean.stdout + clean.stderr);

    put('kickoff.md', kickoff);
    const unlisted = run();
    check(unlisted.status === clean.status && /^kickoff-check: warning: tools\/new\.mts .*node tools\/areas\.mts --check$/m.test(unlisted.stderr),
      '1862: unlisted checkout file warns: ' + unlisted.stdout + unlisted.stderr);
    const cover = JSON.stringify({schema: 1, about: 'Fixture', sections: {'1800': []}});
    put('kernel/test/section-covers.json', cover);
    put('kernel/test/lanes/guards-and-tooling.covers.json', cover);
    put('kickoff.md', kickoff.replace('tools/new.mts', 'none'));
    const duplicate = run();
    check(duplicate.status === clean.status && /^kickoff-check: warning: section claims unreadable \(section 1800 is claimed in two files: .+\); the pinned-section rule is off for this check$/m.test(duplicate.stderr),
      '1862: duplicate claims warn without failing the kickoff: ' + duplicate.stdout + duplicate.stderr);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1863. An integration branch's commit subject names its unit.
async function section1863(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const {childEnv} = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-commit-subject-'));
  try {
    const env = {...repositoryNeutralEnv(childEnv()), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root};
    const run = (...args: string[]) => spawnSync('git', args, {cwd: root, env: repositoryNeutralEnv(env), encoding: 'utf8', timeout: 30_000});
    const git = (...args: string[]) => {
      const result = run(...args);
      if (result.status !== 0) throw Error(result.stderr || String(result.error ?? result.status));
    };
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', '.githooks');
    fs.mkdirSync(path.join(root, '.library'));
    fs.writeFileSync(path.join(root, '.library/identity-denylist.txt'), 'fixture-denylisted-term\n');
    const copy = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.copyFileSync(path.join(PROGRAM_ROOT, file), path.join(root, file));
    };
    copy('.githooks/commit-msg');
    fs.chmodSync(path.join(root, '.githooks/commit-msg'), 0o755);
    copy('tools/scan.ts');
    if (fs.existsSync(path.join(PROGRAM_ROOT, 'tools/commit-subject.mts'))) copy('tools/commit-subject.mts');
    fs.mkdirSync(path.join(root, 'kernel'));
    fs.cpSync(path.join(PROGRAM_ROOT, 'kernel/src'), path.join(root, 'kernel/src'), {recursive: true});
    git('commit', '--allow-empty', '-m', 'Any master subject');
    git('switch', '-qc', 'desk/x');
    git('commit', '--allow-empty', '-m', 'Any desk subject');
    git('switch', '-qc', 'int/c161');
    git('commit', '--allow-empty', '-m', 'c161-r2 row 1: x');
    git('commit', '--allow-empty', '-m', 'c161: x');
    git('commit', '--allow-empty', '-m', 'c161 spare S1: x');
    git('commit', '--allow-empty', '-m', 'fixup! c161: x');
    const wrong = run('commit', '--allow-empty', '-m', 'row 1: x');
    check(wrong.status !== 0 && (wrong.stdout + wrong.stderr).includes('c161 row <n>:'), '1863: refusal names the expected form: ' + wrong.stderr);
    const ambiguous = run('commit', '--allow-empty', '-m', 'c1610 row 1: x');
    check(ambiguous.status !== 0, '1863: a different unit with the same prefix is refused');
    git('switch', '-q', '--detach');
    git('commit', '--allow-empty', '-m', 'Any detached subject');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1864. The head returned before the lander requested a run at the intervening commit.
async function section1864(): Promise<void> {
  const { createServer } = await import('node:http');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createLander, LABELS } = await import(pathToFileURL(join(PROGRAM_ROOT, 'tools/lander.mts')).href);
  const head = 'a'.repeat(40), intervening = 'b'.repeat(40);
  const labels = Object.values(LABELS).map((name, id) => ({ name, id: id + 1 }));
  const checking = labels.find(label => label.name === LABELS.checking)!;
  const held = labels.find(label => label.name === LABELS.held)!;
  const pull = { number: 1, head: { sha: head, ref: 'int/fixture' }, base: { ref: 'master' }, labels: [checking] };
  const comments = [{ id: 1, body: `lander: run-request ${head} #1 after run 10`, user: { login: 'fixture' } }];
  const runs = [{ id: 21, index_in_repo: 11, commit_sha: intervening, workflow_id: 'ci.yml', event: 'pull_request',
    status: 'running', event_payload: { pull_request: { number: 1 }, label: { name: LABELS.checking } } }];
  const server = createServer(async (request, response) => {
    const route = new URL(request.url!, 'http://fixture').pathname.replace('/api/v1/repos/owner/repo', '');
    let body = '';
    for await (const chunk of request) body += chunk;
    let status = 200, result: unknown = {};
    if (route === '/labels') result = labels;
    else if (route === '/pulls') result = [pull];
    else if (route === '/pulls/1') result = pull;
    else if (route === '/actions/runs') result = { total_count: runs.length, workflow_runs: runs };
    else if (route === '/issues/1/comments' && request.method === 'GET') result = comments;
    else if (route === '/issues/1/comments') {
      result = { id: comments.length + 1, body: JSON.parse(body).body, user: { login: 'fixture' } };
      comments.push(result as typeof comments[number]);
    } else if (route === '/issues/1/labels' && JSON.parse(body).labels.includes(held.id)) {
      pull.labels.push(held);
      result = pull.labels;
    } else if (route === `/issues/1/labels/${checking.id}` && request.method === 'DELETE') {
      pull.labels = pull.labels.filter(label => label.id !== checking.id);
      status = 204;
    } else status = 404;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(status === 204 ? undefined : JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const lander = createLander({ repoUrl: `http://127.0.0.1:${address.port}/owner/repo`, login: 'fixture',
      readSecrets: async () => ({ token: 'fixture-token', webhook: 'fixture-webhook' }), say: () => {} });
    check(await lander.pass(), '1864: a run at the intervening commit lets the lander advance');
    same(pull.labels, [held], '1864: the pull leaves checking and is held');
    same(comments.map(comment => comment.body), [
      `lander: run-request ${head} #1 after run 10`,
      `lander: held ${head}: head returned to an earlier commit; reset to check it again`,
    ], '1864: the lander gives the recovery reason without asking for another run');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

// --- 1865. Landing stops waiting for a child that misses its deadline.
async function section1865(): Promise<void> {
  const { basename, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { execute } = await import(pathToFileURL(join(PROGRAM_ROOT, 'tools/land.mts')).href);
  const { performance } = await import('node:perf_hooks');
  const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const limit = 750;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  const checkTree = async (detached: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'land-child-tree-'));
    const pidsFile = join(root, 'pids');
    // Off Windows, the child and its grandchild share one connection; it closes once both have released it, which they do only as they exit.
    const posix = process.platform !== 'win32';
    const socketPath = join(root, 'tree.sock');
    let treeExited = (): void => {};
    const exited = new Promise<void>(resolve => { treeExited = resolve; });
    const { createServer } = await import('node:net');
    const connections = new Set<import('node:net').Socket>();
    const server = createServer(connection => { connections.add(connection); connection.resume(); connection.once('close', () => treeExited()); });
    if (posix) await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
    const start = performance.now();
    let failure = '';
    try {
      try {
        await execute(process.execPath, ['-e', `
          const { spawn } = require('node:child_process');
          const begin = shared => {
            const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: shared ? ['ignore', 'ignore', 'ignore', shared] : 'ignore', windowsHide: true, detached: ${detached} });
            require('node:fs').writeFileSync(process.argv[1], JSON.stringify([process.pid, grandchild.pid]));
          };
          if (process.argv[2]) { const shared = require('node:net').connect(process.argv[2], () => begin(shared)); } else begin();
        `, pidsFile, posix ? socketPath : ''], root, process.env, limit);
      } catch (error) {
        failure = (error as Error).message;
      }
      check(failure.includes(basename(process.execPath)) && failure.includes(`${limit} ms`), '1865: the rejection names the child and its limit');
      check(performance.now() - start < 2000, '1865: the child is stopped before its own exit');
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const treeGone = posix && await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve => { deadlineTimer = setTimeout(resolve, 2000, false); }),
      ]);
      clearTimeout(deadlineTimer);
      if (posix) check(treeGone, '1865: the child and its grandchild release their connection within 2000 ms of the rejection');
      const pids: number[] = JSON.parse(readFileSync(pidsFile, 'utf8'));
      try {
        for (const pid of pids) {
          let stopped = treeGone || !alive(pid);
          if (!stopped && process.platform === 'linux') {
            try {
              const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
              stopped = stat[stat.lastIndexOf(')') + 2] === 'Z';
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              stopped = true;
            }
          }
          check(stopped, `1865: process ${pid} was still running at rejection`);
        }
      } finally {
        for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    } finally {
      for (const connection of connections) connection.destroy();
      if (posix) await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  };
  await checkTree(false);
  if (process.platform === 'linux') await checkTree(true);
  const windowsCase = prerequisite(1865, () => process.platform === 'win32', 'the missing taskkill case requires Windows');
  if (!windowsCase) return;
  const empty = mkdtempSync(join(tmpdir(), 'land-no-taskkill-'));
  const pidFile = join(empty, 'pid');
  const env = { ...process.env };
  const systemRoot = process.env.SystemRoot;
  const deadline = limit + 2000;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = performance.now();
    process.env.SystemRoot = empty;
    const result = await Promise.race([
      execute(process.execPath, ['-e', `
        require('node:fs').writeFileSync(process.argv[1], String(process.pid));
        setTimeout(() => {}, 10000);
      `, pidFile], tmpdir(), env, limit)
        .then(() => 'child completed', (error: Error) => error.message),
      new Promise<string>(resolve => { deadlineTimer = setTimeout(resolve, deadline, 'deadline elapsed'); }),
    ]);
    equal(result, `${basename(process.execPath)} timed out after ${limit} ms; child tree termination failed`,
      '1865: missing taskkill rejects with the termination failure');
    check(performance.now() - started < deadline, '1865: missing taskkill settles before the child exits');
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    clearTimeout(deadlineTimer);
    try {
      const wrotePid = existsSync(pidFile);
      if (wrotePid) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      check(wrotePid, '1865: the child started and wrote its pid before the timeout');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }
}

// --- 1866. A section's child Git uses the fixture repository even when the hook has repository variables.
async function section1866(): Promise<void> {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'section-1866-')));
  const outer = join(root, 'outer'), fixture = join(root, 'fixture');
  const env = childEnv();
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  const originalDir = process.env.GIT_DIR, originalIndex = process.env.GIT_INDEX_FILE;
  try {
    for (const folder of [outer, fixture]) {
      const init = git(root, env, 'init', folder);
      if (init.status !== 0) throw Error(`1866: git init failed: ${init.stderr}`);
    }
    process.env.GIT_DIR = join(outer, '.git');
    process.env.GIT_INDEX_FILE = join(outer, '.git', 'index');
    const result = git(fixture, childEnv(), 'rev-parse', '--git-dir');
    equal(result.status, 0, '1866: fixture Git resolves its repository');
    equal(resolve(fixture, result.stdout.trim()), join(fixture, '.git'), '1866: child Git ignores the hook repository');
    check(childEnv().GIT_INDEX_FILE === undefined, '1866: child Git ignores the hook index');
  } finally {
    if (originalDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalDir;
    if (originalIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = originalIndex;
    rmSync(root, { force: true, recursive: true });
  }
}

// --- 1867. The three secret scan entry points accept only a retained file named for the scanner.
async function section1867(): Promise<void> {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(join(tmpdir(), 'section-1867-'));
  try {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const valid = join(root, 'gitleaks' + exe), invalid = join(root, 'unrelated' + exe);
    for (const file of [valid, invalid]) {
      fs.copyFileSync(process.execPath, file);
      fs.chmodSync(file, 0o755);
    }
    const stub = join(root, 'stub.mjs');
    fs.writeFileSync(stub, [
      "import { basename } from 'node:path';",
      "if (/^(gitleaks|unrelated)(\\.exe)?$/.test(basename(process.execPath))) {",
      "  if (process.argv[1]?.endsWith('version')) console.log('8.30.2');",
      "  process.exit(0);",
      "}",
    ].join('\n'));
    const scan = pathToFileURL(join(PROGRAM_ROOT, 'tools/scan.ts')).href;
    const entryPoints = [
      { args: [join(PROGRAM_ROOT, 'tools/staged-secrets.mts')], accepted: 'gitleaks 8.30.2' },
      { args: ['--input-type=module', '-e', `import { gitleaks } from ${JSON.stringify(scan)}; console.log(gitleaks(process.cwd()).detail);`], accepted: 'found nothing' },
      { args: ['--input-type=module', '-e', `import { secretsScan } from ${JSON.stringify(scan)}; console.log(secretsScan(process.cwd()).detail);`], accepted: 'found nothing' },
    ];
    for (const [index, { args, accepted }] of entryPoints.entries()) {
      const run = (file: string) => spawnSync(process.execPath, args, {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        env: { ...process.env, PATH: join(root, 'absent'), NODE_OPTIONS: '--import=' + pathToFileURL(stub).href, DESKPOST_GITLEAKS: file },
      });
      const good = run(valid), bad = run(invalid);
      check(good.status === 0 && good.stdout.includes(accepted), `1867: reader ${index + 1} accepts gitleaks: ${good.stderr}`);
      check(!bad.stdout.includes(accepted) && bad.stderr.includes('ignored DESKPOST_GITLEAKS') && bad.stderr.includes('unrelated'),
        `1867: reader ${index + 1} reports and ignores the unrelated executable: ${bad.stdout}${bad.stderr}`);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

// --- 1868. The compiled module and scan tooling share the identity terms.
async function section1868(): Promise<void> {
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const kernel = await import(pathToFileURL(join(PROGRAM_ROOT, 'kernel/src/identityterms.ts')).href);
  const scan = await import(pathToFileURL(join(PROGRAM_ROOT, 'tools/scan.ts')).href);
  const root = fs.mkdtempSync(join(tmpdir(), 'section-1868-'));
  try {
    const config = join(root, '.claude');
    fs.mkdirSync(config);
    fs.writeFileSync(join(config, '.library-mcp-url'), 'https://fixture.example.invalid/mcp\n');
    const terms = kernel.deploymentDenylist(root);
    check(terms.includes('fixture.example.invalid'), '1868: configuration contributes the endpoint host');
    same(scan.deploymentDenylist(root), terms, '1868: both modules read the same deployment values');
    const sources = [{ source: 'fixture', text: 'Approved fixture.example.invalid\nactual FIXTURE.EXAMPLE.INVALID' }];
    const allowed = ['Approved fixture.example.invalid'];
    const hits = kernel.identityHits(sources, terms, allowed);
    same(hits, [{ source: 'fixture', line: 2, kind: 'identity', match: 'fixture.example.invalid' }],
      '1868: match positions and the approval exemption survive the move');
    same(scan.identityHits(sources, terms, allowed), hits, '1868: both modules produce the same hits');
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

// --- 1869. The source check warns at the same canonical byte boundary as kickoff send.
async function section1869(): Promise<void> {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { KICKOFF_SIZE_LIMIT } = await import('../../src/kickoff.ts');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(join(tmpdir(), 'section-1869-'));
  try {
    const file = join(root, 'w900.md');
    const prefix = '# Kickoff fixture\n\nTRAIN: fixture\nWHY NOW:\n- ';
    const suffix = '\nOWNS PATHS:\n- `none`\nSTAY OUT OF: none\n' +
      'ROWS:\n1. Fixture\n   Done when: checked.\nCHARTER: fixture\nCLOSE: finish.\n**Stop.**\n';
    const fill = (bytes: number) => prefix + 'é' + 'x'.repeat(bytes - Buffer.byteLength(prefix + 'é' + suffix)) + suffix;
    const checkSize = (bytes: number) => {
      // Disk CRLF makes the raw file longer than the canonical transport payload.
      fs.writeFileSync(file, fill(bytes).replaceAll('\n', '\r\n'));
      return spawnSync(process.execPath, [join(PROGRAM_ROOT, 'tools/kickoff-check.mts'), file], {
        cwd: root, env: { ...childEnv(), DESKPOST_GATE_DIR: join(root, 'absent') },
        windowsHide: true, encoding: 'utf8', timeout: 30_000,
      });
    };
    const atLimit = checkSize(KICKOFF_SIZE_LIMIT), over = checkSize(KICKOFF_SIZE_LIMIT + 1);
    equal(atLimit.status, 0, '1869: canonical payload at the limit passes: ' + atLimit.stdout + atLimit.stderr);
    equal(over.status, 0, '1869: the size warning does not refuse the kickoff: ' + over.stdout + over.stderr);
    check(!atLimit.stderr.includes('kickoff send'), '1869: no send-size warning at the limit');
    const warnings = over.stderr.split(/\r?\n/).filter(line => line.includes('kickoff send'));
    equal(warnings.length, 1, '1869: an oversized payload has one send-size warning');
    const warning = warnings[0] ?? '';
    check(warning.includes(`${KICKOFF_SIZE_LIMIT + 1} bytes`) && warning.includes(`${KICKOFF_SIZE_LIMIT} bytes`) &&
      warning.includes('another office') && warning.includes('refuse'), '1869: warning names both sizes and the refusal');
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

// --- 1871. Host remedies preserve helper paths inside JSON-quoted reader text.
async function section1871(): Promise<void> {
  const { hostRemedies, NOT_SHIPPED } = await import('../../src/remedy.ts');
  const helper = 'tools/CodexBindings.ps1';
  const line = `Run ${helper} to see the binding.`;
  equal(hostRemedies(line, 'win32-compiled'), `Run CodexBindings${NOT_SHIPPED} to see the binding.`,
    '1871: an authored remedy still uses the installed wording');
  const note = `note: "" -> "x ${helper}:202"`;
  equal(hostRemedies(note, 'win32-compiled'), note, '1871: the note is preserved as written');
  const prefixed = 'Unclosed "prefix; ' + note;
  equal(hostRemedies(prefixed, 'win32-compiled'), prefixed, '1871: a stray quote does not expose a later reader value');
  const commands = JSON.stringify('pass -WorkspacePath, pass -Seat, library desk');
  equal(hostRemedies(commands + ' pass -WorkspacePath, pass -Seat, library desk', 'posix'),
    commands + ' pass --workspace, pass --seat, deskpost desk', '1871: every pass leaves reader values alone');
  const escaped = JSON.stringify(`x "quoted" ${helper}:202`);
  equal(hostRemedies(`${escaped} and ${helper}`, 'win32-compiled'), `${escaped} and CodexBindings${NOT_SHIPPED}`,
    '1871: escaped quotes stay inside the reader text and the following remedy changes');
}

async function section1872(): Promise<void> {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(join(tmpdir(), 'kickoff-shared-'));
  try {
    for (const file of ['tools/kickoff-check.mts', 'tools/owns.mts', 'tools/scan.ts', 'tools/section-select.mts', 'tools/check-map.json', 'docs/areas.json', 'kernel/test/section-covers.json', 'kernel/test/gate-lock.ts']) {
      const target = join(root, file);
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.copyFileSync(join(PROGRAM_ROOT, file), target);
    }
    fs.mkdirSync(join(root, 'docs/adr'));
    fs.symlinkSync(join(PROGRAM_ROOT, 'kernel/src'), join(root, 'kernel/src'), 'junction');
    fs.writeFileSync(join(root, 'kernel/test/selftest.ts'), '');
    fs.writeFileSync(join(root, 'tools/x.mts'), '');
    const file = join(root, 'w900.md');
    fs.writeFileSync(file, '# Kickoff fixture\n\nTRAIN: fixture\nWHY NOW:\n- fixture\n'
      + 'OWNS PATHS:\n- `kernel/test/selftest.ts`\n- `kernel/test/section-covers.json`\n- `tools/x.mts`\n'
      + 'STAY OUT OF: none\nROWS:\n1. Fixture\n   Done when: checked.\nCHARTER: fixture\nCLOSE: finish.\n**Stop.**\n');
    const result = spawnSync(process.execPath, [join(root, 'tools/kickoff-check.mts'), file], {
      cwd: root, env: { ...childEnv(), DESKPOST_GATE_DIR: join(root, 'absent') }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    equal(result.status, 0, '1872: fixture kickoff passed: ' + result.stdout + result.stderr);
    check(!/kernel\/test\/(?:selftest\.ts|section-covers\.json) is absent from docs\/areas\.json/.test(result.stderr),
      '1872: shared files do not receive area warnings');
    check(result.stderr.includes('tools/x.mts is absent from docs/areas.json'), '1872: an unlisted tool still receives a warning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 1873. A regenerated letter fixture guards the named recipient and accepts an answer.
async function section1873(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { childEnv } = await import('../gate-env.ts');
  const root = mkdtempSync(join(tmpdir(), 'letter-fixture-guard-'));
  const tools = join(PROGRAM_ROOT, 'tools', 'seat-rules-check');
  const out = join(root, 'fixtures');
  const options = { cwd: root, env: childEnv(), encoding: 'utf8' as const, windowsHide: true };
  try {
    const recorded = spawnSync(process.execPath,
      [join(tools, 'record-letters.mts'), '--out', out, '--scratch', root],
      { ...options, timeout: 90_000 });
    equal(recorded.status, 0, '1873: recording completed: ' + (recorded.error ?? recorded.stderr));
    if (recorded.status !== 0) return;
    const letters = join(out, 'reply-to-closed', 'letters-ring.json');
    const fixture = JSON.parse(readFileSync(letters, 'utf8'));
    equal(fixture.expected_capture_for, 'recipient', '1873: regenerated fixture keeps the recipient guard');
    const request = (id: number, args: Record<string, string>) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'capture_letter', arguments: { title: 'Fixture letter', body: 'Fixture body', ...args } },
    });
    const served = spawnSync(process.execPath,
      [join(tools, 'fixture-server.mts'), '--root', root, '--log', join(root, 'calls.jsonl'), '--letters', letters],
      { ...options, timeout: 10_000, input: request(1, { for: 'other' }) + '\n' + request(2, { answers: fixture.answered_page }) + '\n' });
    equal(served.status, 0, '1873: fixture server completed: ' + (served.error ?? served.stderr));
    if (served.status !== 0) return;
    const replies = served.stdout.trim().split('\n').map(line => JSON.parse(line).result);
    check(replies[0]?.isError === true && replies[0]?.content[0]?.text === 'refused: no seat other here',
      '1873: the fixture server refuses a different named recipient');
    same(replies[1], { content: [{ type: 'text', text: fixture.outputs.answers }] },
      '1873: an answer without a named recipient returns the recorded output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1874. The landing worktree and gate lock stay held until the child closes.
async function section1874(): Promise<void> {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { releaseAfterChild } = await import(pathToFileURL(join(PROGRAM_ROOT, 'tools/land.mts')).href);
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const lines: string[] = [];
  let released = false;
  const release = async () => { released = true; };
  const pending = releaseAfterChild({ pid: 12345, closed }, (line: string) => lines.push(line), release);
  await Promise.resolve();
  check(!released, '1874: cleanup has not run while the child is open');
  equal(lines[0], 'holding the gate lock until process 12345 exits; stop it with taskkill /T /F /PID 12345',
    '1874: the hold notice names the child and the stop command');
  close();
  await pending;
  check(released, '1874: cleanup ran after the child closed');

  released = false;
  lines.length = 0;
  const alreadyClosed = releaseAfterChild(undefined, (line: string) => lines.push(line), release);
  check(released, '1874: cleanup starts immediately when no child is open');
  await alreadyClosed;
  equal(lines.length, 0, '1874: an already closed child needs no hold notice');
}

// --- 1875. Commit settings checks fall back to PowerShell 7 and report when both executables are absent.
async function section1875(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-settings-pwsh-'));
  try {
    const withPwsh = fs.mkdirSync(path.join(root, 'with-pwsh'), { recursive: true })!;
    const empty = fs.mkdirSync(path.join(root, 'empty'), { recursive: true })!;
    fs.writeFileSync(path.join(withPwsh, 'pwsh'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-Only" ]; then
    printf '{"checks":[{"check":"%s","status":"pass","detail":"stand-in"}]}\\n' "$2"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
    const gateUrl = pathToFileURL(path.join(PROGRAM_ROOT, 'tools/gate.ts')).href;
    const script = `
      import { settingsChecks } from ${JSON.stringify(gateUrl)};
      console.log(JSON.stringify(await settingsChecks(process.cwd(), ['.claude/settings.json'])));
    `;
    const run = (searchPath: string) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root, env: { ...process.env, PATH: searchPath }, encoding: 'utf8', timeout: 30_000,
      });
      equal(result.status, 0, `1875: settings child exited: ${result.error ?? result.stderr}`);
      return result.status === 0 ? JSON.parse(result.stdout) as { check: string; status: string; detail: string }[] : [];
    };
    const available = run(withPwsh);
    check(available.length > 0 && available.every(row => row.status === 'pass' && row.detail === 'stand-in'),
      `1875: each settings check passes through pwsh: ${JSON.stringify(available)}`);
    const missing = run(empty);
    check(missing.length > 0 && missing.every(row => row.status === 'fail'
      && row.detail.includes('powershell.exe is missing') && row.detail.includes('pwsh') && row.detail.includes(row.check)),
      `1875: each failure names both executables and the check: ${JSON.stringify(missing)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 1876. Each PowerShell script with a matching self-test selects it when changed.
async function section1876(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { settingsChecksForPaths } = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/gate.ts')).href);
  const hubChecks = settingsChecksForPaths(['tools/New-ProjectHub.ps1']);
  for (const name of ['new-project-hub.selftest', 'hub.dev-template-seeds-sections']) {
    check(hubChecks.includes(name), `1876: tools/New-ProjectHub.ps1 must select ${name}`);
  }

  const toolsDir = path.join(PROGRAM_ROOT, 'tools');
  const runner = fs.readFileSync(path.join(toolsDir, 'Invoke-LibraryChecks.ps1'), 'utf8');
  const selfTests = new Set(Array.from(runner.matchAll(/\bInvoke-Check\s+'([\w-]+\.selftest)'/g), match => match[1]));
  const pairs: string[] = [], missing: string[] = [];
  for (const file of fs.readdirSync(toolsDir).sort()) {
    if (!file.endsWith('.ps1')) continue;
    const name = file.slice(0, -4)
      .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase() + '.selftest';
    if (!selfTests.has(name)) continue;
    const source = `tools/${file}`;
    const pair = `${source} -> ${name}`;
    pairs.push(pair);
    if (!settingsChecksForPaths([source]).includes(name)) missing.push(pair);
  }
  check(pairs.length >= 25, `1876: found ${pairs.length} PowerShell script and self-test pairs (expected at least 25): ${pairs.join(', ')}`);
  check(missing.length === 0, `1876: missing self-test mappings: ${missing.join(', ')}. All pairs: ${pairs.join(', ')}`);
}

// --- 1884. The source checker and ownership command agree on the title's unit.
async function section1884(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { createHash } = await import('node:crypto');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-branch-unit-'));
  try {
    const file = path.join(root, 'kickoff.md');
    const env = { ...childEnv(), HOME: root, USERPROFILE: root, DESKPOST_GATE_DIR: path.join(root, 'absent') };
    const run = (cwd: string, command: string, args: string[]) =>
      spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const fixture = (title: string, branches: string) =>
      `# ${title} kickoff: fixture\n\nBranch: ${branches}\n\nTRAIN: fixture\nWHY NOW:\n- Fixture\n`
      + 'OWNS PATHS:\n- \x60none\x60\nSTAY OUT OF: none\nROWS:\n1. Fixture\n   Done when: checked.\nCHARTER: fixture\nCLOSE: finish.\n**Stop.**\n';
    const validate = (text: string) => {
      fs.writeFileSync(file, text);
      return run(PROGRAM_ROOT, process.execPath, ['tools/kickoff-check.mts', file]);
    };
    for (const [unit, branch] of [['w7', 'int/w7'], ['c160-r10', 'int/c160-r7']] as const) {
      const result = validate(fixture(unit, branch));
      equal(result.status, 0, '1884: matching unit: ' + result.stdout + result.stderr);
    }
    const wrong = fixture('c162', 'int/c161');
    const mismatch = validate(wrong);
    check(mismatch.status === 1 && mismatch.stdout.includes('BRANCH: header names int/c161, which belongs to c161, but the title names c162'),
      '1884: wrong unit refused: ' + mismatch.stdout + mismatch.stderr);
    const multiple = validate(fixture('c162', 'int/c161 and int/c160'));
    check(multiple.status === 1 && multiple.stdout.includes('BRANCH: header names int/c161 and int/c160; a Kickoff continues one branch'),
      '1884: two branches refused: ' + multiple.stdout + multiple.stderr);
    fs.writeFileSync(file, wrong);
    const init = run(root, 'git', ['init', '--initial-branch=int/c160']);
    equal(init.status, 0, '1884: fixture Git initialized: ' + init.stderr);
    const start = run(root, process.execPath, [path.join(PROGRAM_ROOT, 'tools/owns.mts'), 'start', '--kickoff', file,
      '--sha256', createHash('sha256').update(wrong).digest('hex')]);
    check(start.status === 1 && start.stderr.includes("branch int/c160 belongs to c160, but the Kickoff title names c162; start on that unit's branch"),
      '1884: ownership command still refuses: ' + start.stdout + start.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 1885. Kickoff identity warnings name the line and keep the term private.
async function section1885(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-identity-'));
  try {
    const termRoot = path.join(root, '.library');
    fs.mkdirSync(termRoot);
    const denyFile = path.join(termRoot, 'identity-denylist.txt');
    const privateTerm = 'fixture-private-identity';
    const allowedTerm = 'fixture-approved-attribution';
    fs.writeFileSync(denyFile, `${privateTerm}\n${allowedTerm}\n`);
    fs.writeFileSync(path.join(termRoot, 'identity-allowlist.txt'), allowedTerm + '\n');
    const text = `# w7 kickoff: fixture\n\nTRAIN: fixture\nWHY NOW:\n- ${privateTerm}\n- ${allowedTerm}\n`
      + 'OWNS PATHS:\n- \x60none\x60\nSTAY OUT OF: none\nROWS:\n1. Fixture\n   Done when: checked.\nCHARTER: fixture\nCLOSE: finish.\n**Stop.**\n';
    const file = path.join(root, 'kickoff.md');
    fs.writeFileSync(file, text);
    const run = () => spawnSync(process.execPath, ['tools/kickoff-check.mts', file], {
      cwd: PROGRAM_ROOT, env: { ...childEnv(), HOME: root, USERPROFILE: root, DESKPOST_GATE_DIR: path.join(root, 'absent') },
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    const result = run();
    equal(result.status, 0, '1885: private-term warning does not refuse the Kickoff');
    check(result.stderr.includes('warning: line 5 names a private identity term') && !result.stderr.includes('warning: line 6'),
      '1885: warns only on the denylisted line');
    check(!(result.stdout + result.stderr).includes(privateTerm), '1885: neither stream exposes the private term');
    const scan = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/scan.ts')).href);
    if (typeof scan.textIdentityHits === 'function') {
      same(scan.textIdentityHits(text, termRoot), { hits: [{ line: 5, kind: 'identity' }], identityDenylistMissing: false },
        '1885: direct helper reports the redacted line and kind');
    }
    fs.unlinkSync(denyFile);
    const missing = run();
    equal(missing.status, 0, '1885: missing denylist does not refuse the Kickoff');
    check(!missing.stderr.includes('names a private identity term'), '1885: missing denylist has no identity warning');
    if (typeof scan.textIdentityHits === 'function') {
      same(scan.textIdentityHits(text, termRoot), { hits: [], identityDenylistMissing: true },
        '1885: helper records the missing denylist');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 1886. A Catches here line identifies sections the bounded commit tier may defer.
async function section1886(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process'), { childEnv } = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-catches-here-'));
  try {
    const file = path.join(root, 'kickoff.md');
    const run = (catches: string) => {
      fs.writeFileSync(file, '# w7 kickoff: fixture\n\nTRAIN: fixture\nWHY NOW:\n- Fixture\n'
        + 'OWNS PATHS:\n- \x60none\x60\nSTAY OUT OF: none\nROWS:\n1. Add section 1886.\n'
        + `   Catches here: ${catches}\n   Done when: checked.\nCHARTER: fixture\nCLOSE: finish.\n**Stop.**\n`);
      return spawnSync(process.execPath, ['tools/kickoff-check.mts', file], {
        cwd: PROGRAM_ROOT, env: { ...childEnv(), HOME: root, USERPROFILE: root, DESKPOST_GATE_DIR: path.join(root, 'absent') },
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });
    };
    for (const [catches, sections] of [
      ['the commit tier runs sections 1, 2 and 3.', ''],
      ['the bounded commit tier runs the new section 1886.', '1886'],
      ['the commit tier runs 1872.', '1872'],
      ['the commit tier runs sections 1 and 1872, or the runners take them.', ''],
      ['the commit tier runs 1872, or the push tier runs it.', ''],
      ['the commit tier runs 1872, or the Linux check runs it.', ''],
      ['the commit tier runs sections 1010 to 1012.', '1010, 1011, 1012'],
    ]) {
      const result = run(catches!);
      equal(result.status, 0, '1886: tier warning is advisory: ' + result.stdout + result.stderr);
      const warnings = result.stderr.split(/\r?\n/).filter(line => line.includes('bounded commit tier may leave'));
      equal(warnings.length, sections ? 1 : 0, '1886: expected warning count for ' + catches);
      if (sections) check(warnings[0]?.includes(`line 11: the bounded commit tier may leave section(s) ${sections} to the runners`) === true,
        '1886: warning names the line and all deferred sections: ' + result.stderr);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 1892. The Linux workflow checks the areas file before self-tests.
async function section1892(): Promise<void> {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const workflow = join(PROGRAM_ROOT, '.forgejo/workflows/ci.yml');
  if (!prerequisite(1892, () => existsSync(workflow), 'requires .forgejo/workflows/ci.yml')) return;
  const text = readFileSync(workflow, 'utf8');
  const step = /^      - name: Areas file matches the tree\s*\n((?:^ {8}[^\n]*\n?)*)/m.exec(text);
  check(step !== null, '1892: the workflow has an areas check step');
  if (!step || step[1] === undefined) return;
  check(/^        working-directory: src$/m.test(step[1]), '1892: the areas check runs from the repository root');
  check(/^        run: node tools\/areas\.mts --check$/m.test(step[1]), '1892: the step runs the areas checker');
  const install = text.indexOf('- name: npm ci (kernel)');
  const selftest = text.indexOf('- name: Self-test,');
  check(install >= 0 && install < step.index && step.index < selftest,
    '1892: the areas check runs after kernel dependencies install and before self-tests');
}

// --- 1893. The Linux reaper preserves success for an explicitly supplied command.
async function section1893(): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const result = spawnSync('python3', [join(PROGRAM_ROOT, 'tools/ci-reap.py'), '--', process.execPath, '-e', 'process.exit(0)'], {
    encoding: 'utf8', timeout: 30_000,
  });
  equal(result.status, 0, '1893: the reaper runs an explicit command: ' + (result.error ?? result.stderr));
}

// --- 1894. A cherry-pick continued after a conflict keeps the carried subject.
async function section1894(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { childEnv } = await import('../gate-env.ts');
  const root = mkdtempSync(join(tmpdir(), 'deskpost-carried-subject-'));
  const env = { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-config') };
  const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  const git = (...args: string[]) => {
    const result = run('git', ...args);
    if (result.status !== 0) throw Error(result.stderr || String(result.error ?? result.status));
  };
  const commit = (text: string) => {
    writeFileSync(join(root, 'conflict.txt'), text + '\n');
    git('add', 'conflict.txt');
    git('commit', '-qm', text);
  };
  const subject = 'c164-r4 row 1: refuse recovery';
  const message = join(root, 'message');
  try {
    git('init', '-qb', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    commit('common');
    git('switch', '-qc', 'side');
    commit(subject);
    git('switch', '-qc', 'int/demo', 'main');
    commit('demo: change the same line');
    equal(run('git', 'cherry-pick', 'side').status, 1, '1894: the cherry-pick stops for a conflict');
    git('rev-parse', '--verify', 'CHERRY_PICK_HEAD');
    writeFileSync(join(root, 'conflict.txt'), 'resolved\n');
    git('add', 'conflict.txt');
    writeFileSync(message, subject + '\n');
    const guard = () => run(process.execPath, join(PROGRAM_ROOT, 'tools/commit-subject.mts'), message);
    const carried = guard();
    equal(carried.status, 0, '1894: the guard accepts the carried subject: ' + carried.stderr);
    git('cherry-pick', '--abort');
    const ordinary = guard();
    equal(ordinary.status, 1, '1894: the guard refuses the same subject for an ordinary commit');
    check(ordinary.stderr.includes('int/demo'), '1894: the refusal names int/demo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1895. Filtering an installed Deskpost directory preserves its gitleaks.
async function section1895(): Promise<void> {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'deskpost-worker-gitleaks-'));
  const dropped = join(root, 'installed');
  const kept = join(root, 'kept');
  const scanner = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
  const installedScanner = join(dropped, scanner);
  const explicitScanner = join(root, scanner);
  try {
    mkdirSync(dropped);
    mkdirSync(kept);
    writeFileSync(join(dropped, process.platform === 'win32' ? 'deskpost.cmd' : 'deskpost'), '');
    writeFileSync(installedScanner, '', { mode: 0o755 });
    writeFileSync(explicitScanner, '', { mode: 0o755 });
    const module = pathToFileURL(join(HERE, 'gate-env.ts')).href;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    const run = (override: string): NodeJS.ProcessEnv => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import { childEnv } from ' + JSON.stringify(module) + '; console.log(JSON.stringify(childEnv()));'],
      { env: { ...env, PATH: [dropped, kept].join(delimiter), DESKPOST_GITLEAKS: override }, encoding: 'utf8', timeout: 10_000 });
      if (result.status !== 0) throw Error(result.stderr || String(result.error ?? result.status));
      return JSON.parse(result.stdout);
    };
    const filtered = run('');
    const entries = filtered.PATH?.split(delimiter) ?? [];
    check(!entries.includes(dropped) && entries.includes(kept), '1895: the worker drops only the installed directory');
    equal(filtered.DESKPOST_GITLEAKS, installedScanner, '1895: the worker retains the scanner in the dropped directory');
    equal(run(explicitScanner).DESKPOST_GITLEAKS, explicitScanner, '1895: an explicit scanner wins');
    rmSync(installedScanner);
    equal(run('').DESKPOST_GITLEAKS, '', '1895: a directory with no scanner leaves the override empty');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1896. Landing stops waiting when a reparented process keeps its output open.
async function section1896(): Promise<void> {
  const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { basename, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'deskpost-held-output-'));
  const pidFile = join(root, 'grandchild.pid');
  const childScript = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 35000)'],
      { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    require('node:fs').writeFileSync(process.argv[1], String(grandchild.pid));
    process.exit(0);
  `;
  const land = pathToFileURL(join(PROGRAM_ROOT, 'tools/land.mts')).href;
  const callerScript = `
    import { execute } from ${JSON.stringify(land)};
    execute(process.execPath, ['-e', ${JSON.stringify(childScript)}, process.argv[1]], process.cwd(), process.env, 500)
      .catch(error => console.log(error.message));
  `;
  const grandchildPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
  const signal = (pid: number, name: NodeJS.Signals | 0) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, name); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  try {
    const caller = spawnSync(process.execPath, ['--input-type=module', '-e', callerScript, pidFile],
      { cwd: root, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    check(grandchildPid() > 1, '1896: the detached grandchild wrote its pid');
    equal(caller.status, 0, '1896: the caller exits within ten seconds: ' + (caller.error ?? caller.stderr));
    check(caller.stdout.includes(basename(process.execPath) + ' timed out after 500 ms') &&
      caller.stdout.includes('output was still held open'), '1896: the timeout names the held output: ' + caller.stdout);
    console.log('1896: detached grandchild survived the stop: ' + signal(grandchildPid(), 0));
  } finally {
    signal(grandchildPid(), 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1898. Section selection accounts for removed text as well as new text.
async function section1898(): Promise<void> {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const select = await import(pathToFileURL(join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const file = select.laneTestPath('guards-and-tooling');
  const first = 'async function section1880() {\n  first();\n  last();\n}\n';
  const second = 'async function section1881() {\n  next();\n}\n';
  const run = (text: string, diff: string) => select.selectSections({
    changed: [file], selftestText: '', selftestHunks: [],
    covers: { schema: 1, about: 'fixture', sections: { 1880: [], 1881: [] } },
    laneSources: [{ file, text, hunks: select.parseHunks(diff) }],
  });
  const replaced = run(first + '\n' + second, '@@ -5 +5 @@\n-sharedHelper();\n+\n');
  check(replaced.all && replaced.reasons.some((reason: string) => reason.includes(file) && reason.includes('line 5')),
    '1898: replacing a shared helper with a blank selects every section and names line 5: ' + replaced.reasons.join('; '));
  const deleted = run(first + second, '@@ -5 +4,0 @@\n-sharedHelper();\n');
  check(deleted.all && deleted.reasons.some((reason: string) => reason.includes(file) && reason.includes('after line 4')),
    '1898: deleting a shared helper selects every section and names the boundary: ' + deleted.reasons.join('; '));
  const blank = run(first + second, '@@ -5 +4,0 @@\n-  \n');
  check(!blank.all && blank.sections.length === 0, '1898: deleting a blank line selects nothing: ' + blank.reasons.join('; '));
  const inside = run(first + second, '@@ -3 +2,0 @@\n-  middle();\n');
  check(!inside.all, '1898: deleting a line strictly inside one section stays local');
  same(inside.sections, [1880], '1898: the deletion selects only its section');
}

// --- 1899. A repeated section key in one claim file is refused before JSON can discard it.
async function section1899(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const select = await import(pathToFileURL(path.join(PROGRAM_ROOT, 'tools/section-select.mts')).href);
  const thrown = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).message; } };
  const compact = '{"schema": 1, "sections": {"7": [], "7": ["kernel/src/cli.ts"]}}';
  const message = 'x.json: section 7 is claimed twice in this file; keep one claim';
  equal(thrown(() => select.parseCovers(compact, 'x.json')), message, '1899: (a) compact duplicate is refused by name');
  for (const newline of ['\n', '\r\n']) {
    const text = ['{', '  "schema": 1,', '  "sections": {', '    "7": [],', '    "7": ["kernel/src/cli.ts"]', '  }', '}'].join(newline);
    equal(thrown(() => select.parseCovers(text, 'x.json')), message, '1899: (b) laid out duplicate is refused with ' + JSON.stringify(newline));
  }
  const safe = JSON.stringify({schema: 1, about: '"7": []', sections: {'7': []}});
  same(select.parseCovers(safe, 'x.json').sections, {'7': []}, '1899: (c) quoted example is not a claim');
  const lane = select.laneCoversPath('guards-and-tooling');
  equal(thrown(() => select.mergeCovers([{file: lane, text: compact}])),
    lane + ': section 7 is claimed twice in this file; keep one claim', '1899: (d) merging refuses the repeated key by file');
  const read = (file: string) => fs.existsSync(path.join(PROGRAM_ROOT, file)) ? fs.readFileSync(path.join(PROGRAM_ROOT, file), 'utf8') : null;
  for (const part of select.coversFiles(read)) {
    equal(thrown(() => select.parseCovers(part.text, part.file)), '', '1899: (e) real claim file parses: ' + part.file);
  }
}

// --- 1950. Real Git ranges count lines, binary files and literal paths without writes.
async function section1950(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const {auditBalance, readBalanceConfig} = await import('../../src/auditbalance.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c172-balance-'));
  const config = {schema: 1, buckets: {product: ['product/**'], tests: ['tests/**', '**/*.spec'], tools: ['tools/**'], docs: ['**/*.md']}};
  const put = (file: string, value: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), value); };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, {cwd: root, env: repositoryNeutralEnv(), encoding: 'utf8'});
    if (r.status !== 0) throw Error(r.stderr || String(r.error));
    return r.stdout.trim();
  };
  const thrown = (fn: () => unknown) => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', 'absent-hooks'); git('config', 'core.autocrlf', 'false');
    const cfg = path.join(root, '.deskpost/code-balance.json');
    check(thrown(() => readBalanceConfig(root)).includes(cfg), '1950: missing setting names its path');
    put('.deskpost/code-balance.json', '{"schema":2}');
    check(thrown(() => readBalanceConfig(root)).includes('schema'), '1950: malformed schema names its key');
    for (const bad of [{...config, buckets: {product: 'bad'}}, {...config, heavy: -1}, {...config, bloated: 'six'}]) {
      put('.deskpost/code-balance.json', JSON.stringify(bad));
      check(thrown(() => readBalanceConfig(root)).includes('code-balance.json'), '1950: invalid setting refuses');
    }
    put('.deskpost/code-balance.json', JSON.stringify(config));
    put('product/old', 'old\n'.repeat(80)); put('tests/old', 'old\n'.repeat(80));
    git('add', '.'); git('commit', '-qm', 'Base'); const base = git('rev-parse', 'HEAD');
    const cases = [
      ['no code', 'docs/readme.md', 3], ['BALANCED', 'product/new', 10],
      ['HEAVY', 'tests/new', 40], ['BLOATED', 'tools/new', 30],
    ] as const;
    let tip = base;
    for (const [verdict, file, lines] of cases) {
      put(file, 'new\n'.repeat(lines)); git('add', '.'); git('commit', '-qm', verdict); tip = git('rev-parse', 'HEAD');
      const r = auditBalance({repo: root, base, tip});
      equal(r.value.verdict, verdict, '1950: ' + verdict);
      equal(r.value.ratio, verdict === 'no code' ? null : verdict === 'BALANCED' ? 0 : verdict === 'HEAVY' ? 4 : 7, '1950: added-line ratio');
      check(r.text.split('\n').length <= 6, '1950: at most six text lines');
      if (verdict === 'HEAVY' || verdict === 'BLOATED') check(r.text.includes('tests/new'), '1950: largest paths named');
    }
    const change = (file: string, content: string, verdict: string) => {
      const before = tip; put(file, content); git('add', '.'); git('commit', '-qm', verdict); tip = git('rev-parse', 'HEAD');
      const r = auditBalance({repo: root, base: before, tip});
      equal(r.value.verdict, verdict, '1950: ' + verdict); equal(r.value.ratio, null, '1950: no product additions means no ratio');
    };
    change('tests/old', '', 'tidy'); change('product/old', '', 'product-removal'); change('tests/only', 'test\n', 'test-only');
    const beforeBinary = tip; put('product/binary', Buffer.from([0, 1, 2])); git('add', '.'); git('commit', '-qm', 'Binary'); tip = git('rev-parse', 'HEAD');
    const binary = auditBalance({repo: root, base: beforeBinary, tip}).value;
    equal(binary.verdict, 'no code', '1950: binary-only product is no code'); equal(binary.buckets.product!.binary_files, 1, '1950: binary counted by file');
    equal(binary.ratio, null, '1950: binary adds no ratio');
    equal(git('status', '--porcelain'), '', '1950: reading leaves repository clean');
    const refError = thrown(() => auditBalance({repo: root, base: 'absent-ref', tip}));
    check(refError.includes('absent-ref') && refError.includes('git fetch'), '1950: unresolved ref names it and git fetch');
    const dated = auditBalance({repo: root, since: '2030-01-01', tip});
    equal(dated.value.base, tip, '1950: since resolves the last commit before the date');
    for (const args of [{base}, {base, tip, since: '2020-01-01'}, {since: ''}]) {
      check(thrown(() => auditBalance({repo: root, ...args})).length > 0, '1950: incomplete or mixed arguments refused');
    }
    // Build paths in Git's index: Windows cannot create tab or newline filenames on disk.
    git('config', 'core.protectNTFS', 'false');
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, env: repositoryNeutralEnv(), input: 'odd\n', encoding: 'utf8'}).stdout.trim();
    const beforeOdd = tip;
    put('.deskpost/code-balance.json', JSON.stringify({...config, heavy: 2})); git('add', '.deskpost/code-balance.json');
    for (const file of ['tests/café.spec', 'tools/tab\tfile', 'tools/new\nfile', 'product/first.spec', 'outside/extra']) {
      git('update-index', '--add', '--cacheinfo', '100644', blob, file);
    }
    git('commit', '-qm', 'Literal paths'); tip = git('rev-parse', 'HEAD');
    const odd = auditBalance({repo: root, base: beforeOdd, tip});
    equal(odd.value.buckets.product!.added, 1, '1950: first matching bucket wins');
    equal(odd.value.buckets.tests!.added, 1, '1950: non-ASCII path matched'); equal(odd.value.buckets.tools!.added, 2, '1950: tab and newline paths matched');
    check(odd.text.includes('tab\\tfile') && odd.text.includes('new\\nfile') && !odd.text.includes('tab\tfile'), '1950: text escapes control characters');
    check(odd.value.other.paths.some(f => f.path === 'outside/extra'), '1950: largest unmatched paths shown');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1951. Code balance works in a plain repository without a Library.
async function section1951(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {readBalanceConfig} = await import('../../src/auditbalance.ts');
  equal(readBalanceConfig(PROGRAM_ROOT).schema, 1, '1951: shipped repository setting loads');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const {childEnv} = await import('../gate-env.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c172-cli-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, {cwd: root, env: repositoryNeutralEnv(childEnv()), encoding: 'utf8'});
    if (r.status !== 0) throw Error(r.stderr || String(r.error)); return r.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.hooksPath', 'absent-hooks');
    fs.mkdirSync(path.join(root, '.deskpost')); fs.writeFileSync(path.join(root, '.deskpost/code-balance.json'), JSON.stringify({schema: 1, buckets: {product: ['*.ts'], tests: [], tools: [], docs: []}}));
    git('add', '.'); git('commit', '-qm', 'Base'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'app.ts'), 'product\n'); git('add', '.'); git('commit', '-qm', 'Tip');
    const ran = runCli(['audit', 'balance', base, 'HEAD', '--json'], {cwd: root});
    equal(ran.exit, 0, '1951: plain repository exit: ' + ran.stderr);
    if (ran.exit === 0) { const value = JSON.parse(ran.stdout); equal(value.verdict, 'BALANCED', '1951: reading'); equal(value.buckets.product.added, 1, '1951: counts product'); }
    const bad = runCli(['audit', 'balance', '--c160-no-such-flag', '--json'], {cwd: root});
    equal(bad.exit, 1, '1951: unknown flag exit'); const refusal = JSON.parse(bad.stdout);
    equal(refusal.status, 'refused', '1951: structured refusal'); equal(refusal.verb, 'audit', '1951: refusal verb'); equal(refusal.action, 'balance', '1951: refusal action');
    equal(git('status', '--porcelain'), '', '1951: command writes nothing');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1952. The tools inventory checks the index in both directions on either gate tier.
async function section1952(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const {inventoryChecks} = await import('../../../tools/inventory.mts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c173-inventory-'));
  const put = (file: string, text = '') => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text); };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, {cwd: root, env: repositoryNeutralEnv(), encoding: 'utf8'});
    if (r.status !== 0) throw Error(r.stderr || String(r.error));
  };
  const row = (file: string) => '| `' + file + '` | Fixture | by hand | Fixture | keep |\n';
  const body = '| Path | What it does | Run by | Evidence | Decision |\n| --- | --- | --- | --- | --- |\n' + row('tools/INVENTORY.md') + row('tools/one.mts');
  try {
    git('init', '-q'); git('config', 'core.autocrlf', 'false');
    put('tools/INVENTORY.md', body); put('tools/one.mts');
    equal(inventoryChecks(root)[0]!.status, 'skip', '1952: an untracked inventory skips the gate');
    git('add', '.');
    for (const tier of ['commit', 'push'] as const) {
      const result = inventoryChecks(root, tier)[0]!;
      equal(result.status, 'pass', '1952: complete index passes ' + tier);
      equal(result.tier, tier, '1952: outcome names its tier');
      equal(result.check, 'tools.inventory', '1952: named gate check');
    }
    for (const file of ['tools/new.mts', 'tools/seat-rules-check/nested.mts']) {
      put(file); git('add', file);
      const commit = inventoryChecks(root, 'commit')[0]!, push = inventoryChecks(root, 'push')[0]!;
      equal(commit.status, 'fail', '1952: staged unlisted file fails');
      check(commit.detail.includes(file), '1952: names staged file ' + file);
      equal(push.detail, commit.detail, '1952: both tiers report the same fault');
      equal(push.status, commit.status, '1952: both tiers refuse');
    }
    const complete = body + row('tools/new.mts') + row('tools/seat-rules-check/nested.mts');
    put('tools/INVENTORY.md', complete); equal(inventoryChecks(root)[0]!.status, 'pass', '1952: adding rows restores green');
    put('tools/INVENTORY.md', complete + row('tools/missing.mts'));
    const phantom = inventoryChecks(root)[0]!;
    equal(phantom.status, 'fail', '1952: phantom refuses'); check(phantom.detail.includes('tools/missing.mts'), '1952: phantom named');
    put('tools/INVENTORY.md', complete + row('tools/one.mts'));
    const duplicate = inventoryChecks(root)[0]!;
    equal(duplicate.status, 'fail', '1952: duplicate refuses'); check(duplicate.detail.includes('path listed twice: tools/one.mts'), '1952: duplicate named');
    put('tools/INVENTORY.md', complete.replace(/\n/g, '\r\n'));
    equal(inventoryChecks(root)[0]!.status, 'pass', '1952: carriage-return line endings accepted');
    const gate = fs.readFileSync(path.join(PROGRAM_ROOT, 'tools/gate.ts'), 'utf8');
    check(gate.includes("if (options.tier === 'commit' || options.tier === 'push')") && gate.includes('for (const outcome of inventoryChecks(root, options.tier)) say(outcome);'), '1952: gate calls the same function in the shared tier branch');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

// --- 1953. The inventory command checks the real tracked tree.
async function section1953(): Promise<void> {
  const {spawnSync} = await import('node:child_process'), path = await import('node:path');
  const {childEnv} = await import('../gate-env.ts'), {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const ran = spawnSync(process.execPath, [path.join(PROGRAM_ROOT, 'tools/inventory.mts'), '--check'], {cwd: PROGRAM_ROOT, env: repositoryNeutralEnv(childEnv()), encoding: 'utf8', timeout: 60_000});
  equal(ran.status, 0, '1953: real inventory command succeeds: ' + ran.stdout + ran.stderr);
  check(ran.stdout.includes('is complete'), '1953: complete summary printed');
}

// --- 1900. A continuation checks section claims at its merge base, with working-tree fallback.
async function section1900(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process'), {childEnv} = await import('../gate-env.ts');
  const {repositoryNeutralEnv} = await import('../../src/gitenv.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c169-claims-'));
  try {
    const put = (file: string, contents: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, contents);
    };
    for (const file of ['tools/kickoff-check.mts', 'tools/owns.mts', 'tools/scan.ts', 'tools/section-select.mts', 'tools/check-map.json',
      'kernel/test/gate-lock.ts', 'docs/areas.json']) put(file, fs.readFileSync(path.join(PROGRAM_ROOT, file), 'utf8'));
    fs.cpSync(path.join(PROGRAM_ROOT, 'kernel/src'), path.join(root, 'kernel/src'), {recursive: true});
    fs.mkdirSync(path.join(root, 'docs/adr'));
    const env = {...childEnv(), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, DESKPOST_GATE_DIR: path.join(root, 'absent')};
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, {cwd: root, env: repositoryNeutralEnv(env), encoding: 'utf8', timeout: 30_000});
      if (result.status !== 0) throw Error(result.stderr || String(result.error ?? result.status));
      return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', 'absent-hooks');
    const lane = 'kernel/test/lanes/guards-and-tooling.covers.json';
    const claims = (sections: Record<string, string[]>) => JSON.stringify({schema: 1, about: 'Fixture', sections});
    put('kernel/test/section-covers.json', claims({}));
    put(lane, claims({'1800': []}));
    git('add', '.');
    git('commit', '-qm', 'Fixture base');
    git('update-ref', 'refs/remotes/origin/master', git('rev-parse', 'HEAD'));
    put(lane, claims({'1800': [], '1801': []}));
    git('add', lane);
    git('commit', '-qm', 'Fixture continuation');
    const run = (section: number) => {
      put('kickoff.md', '# c999 kickoff: fixture\nTRAIN: example\nWHY NOW:\n- **Lane:** guards-and-tooling\n' +
        'OWNS:\n- New sections ' + section + '.\nOWNS PATHS:\n- `kernel/test/lanes/guards-and-tooling.ts`\n' +
        '- `kernel/test/lanes/guards-and-tooling.covers.json`\nSTAY OUT OF: none\nROWS:\n1. Fixture\n' +
        '   Done when: complete.\nCHARTER: example\nCLOSE: finish.\n**Stop.**\n');
      const result = spawnSync(process.execPath, ['tools/kickoff-check.mts', 'kickoff.md'],
        {cwd: root, env: repositoryNeutralEnv(env), encoding: 'utf8', timeout: 30_000});
      if (result.error || result.status === null) throw Error(String(result.error ?? result.signal));
      return result;
    };
    const continuation = run(1801);
    check(!continuation.stdout.includes('section 1801 is taken at the base'), '1900: continuation does not claim its own new section at the base: ' + continuation.stdout);
    check(!continuation.stderr.includes('section claims unreadable'), '1900: merge-base claim files are readable: ' + continuation.stderr);
    const existing = run(1800);
    check(existing.stdout.includes('section 1800 is taken at the base'), '1900: a section present at the base still warns: ' + existing.stdout);
    git('update-ref', '-d', 'refs/remotes/origin/master');
    const fallback = run(1801);
    check(fallback.stdout.includes('section 1801 is taken at the base'), '1900: without origin/master the working-tree warning returns: ' + fallback.stdout);
    check(!fallback.stderr.includes('section claims unreadable'), '1900: fallback claims remain readable: ' + fallback.stderr);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}



// --- 1954. Legacy Notebook migration keeps every state and recovers at every journal boundary.
async function section1954(): Promise<void> {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { enterSeatClaim, exitSeatClaim } = await import('../../src/seatclaim.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-states-'));
  // Captured from the legacy writers at 2c107daf on 2026-11-21. Only the Notebook, its ownership
  // record, the retired seat and the reset quarantine are retained; no live Library is read.
  const captured: Record<string, string> = {
    ".claude/seats/_registry.json": "{\r\n    \"schema\":  1,\r\n    \"seats\":  [\r\n                  {\r\n                      \"seat\":  \"beta\",\r\n                      \"project\":  \"acceptance-second\",\r\n                      \"created_utc\":  \"2026-11-21T17:26:04.0773957Z\",\r\n                      \"seat_id\":  \"22222222-2222-2222-2222-222222222222\"\r\n                  },\r\n                  {\r\n                      \"seat\":  \"fixture\",\r\n                      \"project\":  \"acceptance\",\r\n                      \"created_utc\":  \"2026-11-21T17:26:02.7242559Z\",\r\n                      \"seat_id\":  \"11111111-1111-1111-1111-111111111111\"\r\n                  }\r\n              ]\r\n}\n",
    ".library/workspace.json": "{\r\n    \"id\":  \"12135337-2901-415c-90cd-012019e618c8\",\r\n    \"program_version\":  \"1.7.0\",\r\n    \"collection_id\":  \"00000000-0000-0000-0000-000000000000\",\r\n    \"backend\":  \"local\",\r\n    \"writable\":  false,\r\n    \"created\":  \"2026-11-21T09:26:01.4517822-08:00\"\r\n}\n",
    "internal/notebook-reset-quarantine/beta-20261121-172607/beta-scratch/note.md": "# Note\n\nWritten into beta-scratch by the legacy fixture.\n",
    "internal/notebook-reset-quarantine/beta-20261121-172607/beta-scratch/_index.md": "# Beta scratch\n\n- [Note](note.md)\n",
    "internal/notebook-reset-quarantine/beta-20261121-172607/loose-idea.md": "# A loose idea\n\nWritten straight into notebook/, under no topic.\n",
    "internal/notebook-reset-quarantine/beta-20261121-172607/reset-journal.json": "{\r\n    \"operation\":  \"Reset local notebook\",\r\n    \"seat\":  \"beta\",\r\n    \"whole_tree\":  false,\r\n    \"all_idle_seats\":  false,\r\n    \"clear_desk\":  false,\r\n    \"plan_id\":  \"reset-local-notebook-276520d3c7bd1cc2df6af0e66aef0f026358ef9923c94e607d5f4b0a927c4255\",\r\n    \"quarantined_utc\":  \"2026-11-21T17:26:07.3007723Z\",\r\n    \"moves\":  [\r\n                  {\r\n                      \"topic\":  \"beta-scratch\",\r\n                      \"moved\":  true,\r\n                      \"source\":  \"notebook/beta-scratch\",\r\n                      \"destination\":  \"D:\\\\dev\\\\scratch\\\\deskpost\\\\c174\\\\legacy-capture\\\\workspace\\\\internal\\\\notebook-reset-quarantine\\\\beta-20261121-172607\\\\beta-scratch\"\r\n                  }\r\n              ],\r\n    \"targets\":  [\r\n                    {\r\n                        \"topic\":  \"beta-scratch\",\r\n                        \"seat\":  \"beta\",\r\n                        \"seat_id\":  \"22222222-2222-2222-2222-222222222222\"\r\n                    }\r\n                ],\r\n    \"loose_files\":  [\r\n                        \"loose-idea.md\"\r\n                    ]\r\n}\n",
    "internal/notebook-topic-owners.json": "{\r\n    \"schema\":  1,\r\n    \"topics\":  [\r\n                   {\r\n                       \"topic\":  \"acceptance\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:03.3197454Z\",\r\n                       \"seat\":  \"fixture\",\r\n                       \"project\":  \"acceptance\",\r\n                       \"seat_id\":  \"11111111-1111-1111-1111-111111111111\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"beta\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:07.3934312Z\",\r\n                       \"seat\":  \"beta\",\r\n                       \"project\":  \"acceptance-second\",\r\n                       \"seat_id\":  \"22222222-2222-2222-2222-222222222222\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"beta-scratch\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:04.1540596Z\",\r\n                       \"seat\":  \"beta\",\r\n                       \"project\":  \"acceptance-second\",\r\n                       \"seat_id\":  \"22222222-2222-2222-2222-222222222222\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"gone-topic\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:10.0048077Z\",\r\n                       \"seat\":  \"fixture\",\r\n                       \"project\":  \"acceptance\",\r\n                       \"seat_id\":  \"11111111-1111-1111-1111-111111111111\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"house-style\",\r\n                       \"scope\":  \"shared\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:09.7457946Z\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"old-notes\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:07.4161550Z\",\r\n                       \"seat\":  \"gamma\",\r\n                       \"project\":  \"acceptance-third\",\r\n                       \"seat_id\":  \"33333333-3333-3333-3333-333333333333\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"orphan-notes\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:09.7125244Z\",\r\n                       \"seat\":  \"delta\",\r\n                       \"project\":  \"acceptance-fourth\",\r\n                       \"seat_id\":  \"44444444-4444-4444-4444-444444444444\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"portability\",\r\n                       \"scope\":  \"owned\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:03.3622564Z\",\r\n                       \"seat\":  \"fixture\",\r\n                       \"project\":  \"acceptance\",\r\n                       \"seat_id\":  \"11111111-1111-1111-1111-111111111111\"\r\n                   },\r\n                   {\r\n                       \"topic\":  \"reference-copy\",\r\n                       \"scope\":  \"excluded\",\r\n                       \"recorded_utc\":  \"2026-11-21T17:26:09.9851623Z\"\r\n                   }\r\n               ]\r\n}\n",
    "internal/seat-archive/gamma-20261121-172609/.open-books": "",
    "internal/seat-archive/gamma-20261121-172609/.open-projects": "",
    "internal/seat-archive/gamma-20261121-172609/seat.json": "{\r\n    \"seat\":  \"gamma\",\r\n    \"seat_id\":  \"33333333-3333-3333-3333-333333333333\",\r\n    \"project\":  \"acceptance-third\",\r\n    \"retired_utc\":  \"2026-11-21T17:26:09.5677876Z\",\r\n    \"open_books\":  [\r\n\r\n                   ],\r\n    \"open_projects\":  [\r\n\r\n                      ]\r\n}\n",
    "notebook/acceptance/oracle-notes.md": "# Oracle notes\n\n## Key Takeaways\n\n- A fixture proves the code works when given the input.\n",
    "notebook/acceptance/_index.md": "# Acceptance\n\n- [Oracle notes](oracle-notes.md)\n",
    "notebook/beta/note.md": "# Note\n\nWritten into beta by the legacy fixture.\n",
    "notebook/beta/_index.md": "# Named like its seat\n\n- [Note](note.md)\n",
    "notebook/drafts/note.md": "# Note\n\nWritten into drafts by the legacy fixture.\n",
    "notebook/drafts/_index.md": "# Drafts\n\n- [Note](note.md)\n",
    "notebook/house-style/note.md": "# Note\n\nWritten into house-style by the legacy fixture.\n",
    "notebook/house-style/_index.md": "# House style\n\n- [Note](note.md)\n",
    "notebook/old-notes/note.md": "# Note\n\nWritten into old-notes by the legacy fixture.\n",
    "notebook/old-notes/_index.md": "# Old notes\n\n- [Note](note.md)\n",
    "notebook/orphan-notes/note.md": "# Note\n\nWritten into orphan-notes by the legacy fixture.\n",
    "notebook/orphan-notes/_index.md": "# Orphan notes\n\n- [Note](note.md)\n",
    "notebook/portability/line-endings.md": "# Line endings\n\nMeasured with a byte counter, never with a line grep.\n",
    "notebook/portability/_index.md": "# Portability\n\n- [Line endings](line-endings.md)\n",
    "notebook/reference-copy/note.md": "# Note\n\nWritten into reference-copy by the legacy fixture.\n",
    "notebook/reference-copy/_index.md": "# Reference copy\n\n- [Note](note.md)\n",
    "notebook/scratch.md": "# Scratch\n\nA loose file written after the reset.\n",
    "notebook/_master-index.md": "# Notebook Index\n\n- [[acceptance/_index|Acceptance]]\n- [[beta/_index|Named like its seat]]\n- [[drafts/_index|Drafts]]\n- [[house-style/_index|House style]]\n- [[old-notes/_index|Old notes]]\n- [[orphan-notes/_index|Orphan notes]]\n- [[portability/_index|Portability]]\n- [[reference-copy/_index|Reference copy]]\n"
  };
  const choices = ['--assign', 'drafts=fixture,orphan-notes=beta,scratch.md=fixture', '--set-aside', 'house-style,reference-copy'];
  let copies = 0;
  const fresh = () => {
    const ws = path.join(root, 'copy-' + copies++);
    for (const [name, text] of Object.entries(captured)) {
      const file = path.join(ws, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    for (const seat of ['fixture', 'beta']) fs.mkdirSync(path.join(ws, '.claude/seats', seat), { recursive: true });
    return ws;
  };
  const call = (ws: string, args: string[], env: Record<string, string> = {}) => runCli([...args, '--workspace', ws, '--json'], {
    cwd: root, env: { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', LIBRARY_WORKSPACES: path.join(root, 'registry'), ...env },
  });
  const callAsync = (ws: string, args: string[]) => runCliAsync([...args, '--workspace', ws, '--json'], {
    cwd: root, env: { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', LIBRARY_WORKSPACES: path.join(root, 'registry') },
  });
  const json = (r: ReturnType<typeof call>) => {
    equal(r.exit, 0, '1954: command succeeds: ' + r.stderr);
    if (r.exit !== 0) throw Error('1954: command refused: ' + r.stderr);
    return JSON.parse(r.stdout);
  };
  const plan = (ws: string, args = choices) => json(call(ws, ['migrate', ...args, '--preflight']));
  const tree = (ws: string, normal = false) => {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name), relative = path.relative(ws, file).replaceAll(path.sep, '/');
        if (relative.startsWith('internal/book-locks/')) continue;
        if (entry.isDirectory()) walk(file);
        else {
          const name = normal ? relative.replace(/migration-\d{8}-\d{6}/g, 'migration-<stamp>') : relative;
          files[name] = normal && (/^internal\/notebook-migration\/journal.*\.json$/.test(name) || name === 'internal/notebook-layout.json' || name === 'internal/notebook-reset-quarantine/migration-<stamp>/reset-journal.json')
            ? 'present' : createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
      }
    };
    walk(ws); return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  };
  try {
    const ws = fresh(), before = tree(ws), bare = plan(ws, []);
    same([...new Set(bare.items.map((i: { state: string }) => i.state))].sort(),
      ['owned', 'owned-retired', 'owned-unaccounted', 'shared', 'excluded', 'unmapped', 'loose', 'stale-row', 'record', 'derived', 'quarantine'].sort(), '1954: every legacy state');
    const byName = Object.fromEntries(bare.items.map((i: { item: string }) => [i.item, i]));
    check(byName['old-notes'].legacy_owner === 'gamma' && byName['old-notes'].disposition === 'set-aside', '1954: retired ownership is set aside');
    check(byName.beta.disposition === 'seat' && byName.beta.seat === 'beta', '1954: topic named like a seat');
    equal(byName['beta-scratch'].state, 'stale-row', '1954: reset left a stale ownership row');
    equal(bare.items.filter((i: { state: string; disposition: string }) => i.state === 'quarantine' && i.disposition === 'keep').length, 1, '1954: old quarantine kept');
    check(bare.activation === 'refused' && bare.plan_id === '', '1954: undecided migration has no approval plan');
    same(bare.unaccounted.sort(), ['drafts', 'house-style', 'orphan-notes', 'reference-copy', 'scratch.md'], '1954: all undecided items named');
    for (const extra of [[], ['--plan-id', 'migrate-notebook-0000']]) {
      const r = call(ws, ['migrate', ...choices, ...extra]);
      check(r.exit !== 0 && r.stderr.includes('nothing was moved'), '1954: absent or wrong plan refuses');
    }
    check(plan(ws, ['--assign', 'draft=fixture']).refusals.some((s: string) => s.includes("'draft' names no topic")), '1954: typo refused');
    same(tree(ws), before, '1954: refusals move nothing');
    for (const args of [['reset', '--seat', 'fixture', '--preflight'], ['notebook', 'render', '--seat', 'fixture']]) {
      const r = call(ws, args); check(r.exit !== 0 && r.stderr.includes('migrate --preflight'), '1954: legacy writer names migration');
    }
    const own = call(ws, ['notebook', 'own', 'acceptance']);
    check(own.exit !== 0 && own.stderr.includes('ADR-0029'), '1954: ownership writer retired');
    const ready = plan(ws);
    check(ready.activation === 'ready' && ready.plan_id, '1954: complete dispositions issue a plan');
    equal(json(call(ws, ['migrate', ...choices, '--plan-id', ready.plan_id])).status, 'complete', '1954: reference completes');
    const reference = tree(ws, true), raw = tree(ws);
    for (const name of ['notebook/fixture/_master-index.md', 'notebook/fixture/acceptance/_index.md', 'notebook/fixture/portability/_index.md',
      'notebook/fixture/drafts/_index.md', 'notebook/fixture/scratch.md', 'notebook/beta/_master-index.md', 'notebook/beta/beta/_index.md',
      'notebook/beta/orphan-notes/_index.md', 'internal/notebook-migration/legacy/notebook-topic-owners.json', 'internal/notebook-migration/legacy/_master-index.md',
      'internal/notebook-layout.json', 'internal/notebook-migration/journal.json',
      ...['old-notes', 'house-style', 'reference-copy'].map(t => 'internal/notebook-reset-quarantine/migration-<stamp>/' + t + '/_index.md')])
      check(name in reference, '1954: reference destination ' + name);
    for (const name of ['internal/notebook-topic-owners.json', 'notebook/_master-index.md', 'notebook/acceptance/_index.md', 'notebook/scratch.md'])
      check(!(name in reference), '1954: old location retired ' + name);
    check(!fs.existsSync(path.join(ws, 'internal/notebook-migration/staging')), '1954: staging removed');
    for (const [name, hash] of Object.entries(before).filter(([n]) => n.startsWith('notebook/') || n.startsWith('internal/notebook-reset-quarantine/') || n === 'internal/notebook-topic-owners.json'))
      check(Object.values(raw).includes(hash), '1954: preserves bytes ' + name);
    const index = fs.readFileSync(path.join(ws, 'notebook/beta/_master-index.md'), 'utf8');
    check(index.includes('[[beta/_index|') && index.includes('[[orphan-notes/_index|'), '1954: seat index lists both topics');
    const quarantine = fs.readdirSync(path.join(ws, 'internal/notebook-reset-quarantine')).find(n => n.startsWith('migration-'))!;
    const journal = JSON.parse(fs.readFileSync(path.join(ws, 'internal/notebook-reset-quarantine', quarantine, 'reset-journal.json'), 'utf8'));
    const retired = journal.targets.filter((i: { topic: string }) => i.topic === 'old-notes');
    check(retired.length === 1 && retired[0].seat === 'gamma' && retired[0].seat_id === '33333333-3333-3333-3333-333333333333', '1954: quarantine keeps retired identity');
    equal(plan(ws, []).status, 'already-seat-owned', '1954: repeat migration is a no-op');
    const held = enterSeatClaim(path.join(ws, '.claude'), 'fixture');
    try {
      const env = { LIBRARY_SEAT: 'fixture', LIBRARY_SEAT_CLAIM: held.token };
      const reset = json(call(ws, ['reset', '--preflight'], env));
      same(reset.topics_to_quarantine, ['acceptance', 'drafts', 'portability'], '1954: reset takes only own topics');
      same(reset.loose_files_to_quarantine, ['scratch.md'], '1954: reset takes own loose page');
      json(call(ws, ['reset', '--plan-id', reset.plan_id], env));
      check(fs.existsSync(path.join(ws, 'notebook/beta/beta/_index.md')), '1954: reset leaves other seat');
      const args = ['reset', 'restore', '--quarantine', quarantine, '--topic', 'house-style', '--adopt'];
      const restore = json(call(ws, [...args, '--preflight'], env));
      json(call(ws, [...args, '--plan-id', restore.plan_id], env));
      check(fs.existsSync(path.join(ws, 'notebook/fixture/house-style/_index.md')), '1954: set-aside adopts into own Notebook');
      const retiredOwn = call(ws, ['notebook', 'own', 'house-style'], env);
      check(retiredOwn.exit !== 0 && retiredOwn.stderr.includes('ADR-0029') && !fs.existsSync(path.join(ws, 'internal/notebook-topic-owners.json')), '1954: no writer recreates ownership');
    } finally { exitSeatClaim(held); }
    const migration = JSON.parse(fs.readFileSync(path.join(ws, 'internal/notebook-migration/journal.json'), 'utf8'));
    const points = ['journal-created', ...migration.steps.flatMap((s: { id: string }) => [s.id, s.id + ':recorded'])];
    check(points.length >= 20, '1954: interruption set reaches every journal step');
    const pending = points.flatMap(point => ['resume', 'rollback'].map(ending => ({ point, ending })));
    // Every recovery owns its entire workspace. Four workers bound process pressure while keeping
    // all journal boundaries in the commit proof rather than sampling interruption points.
    await Promise.all(Array.from({ length: 4 }, async () => { while (pending.length) {
      const { point, ending } = pending.shift()!;
      const copy = fresh(), p = json(await callAsync(copy, ['migrate', ...choices, '--preflight']));
      const fault = await callAsync(copy, ['migrate', ...choices, '--plan-id', p.plan_id, '--fault-after', point]);
      check(fault.exit !== 0 && fault.stderr.includes('FAULT INJECTED'), '1954: fault reached ' + point);
      const reset = await callAsync(copy, ['reset', '--seat', 'fixture', '--preflight']);
      check(reset.exit !== 0 && reset.stderr.includes('migrate --resume'), '1954: interrupted reset refuses ' + point);
      equal(json(await callAsync(copy, ['migrate', '--preflight'])).status, 'interrupted', '1954: preflight reports interrupted ' + point);
      equal(json(await callAsync(copy, ['migrate', '--' + ending])).status, ending === 'resume' ? 'complete' : 'rolled-back', '1954: recovery ' + point);
      if (ending === 'resume') same(tree(copy, true), reference, '1954: resume reaches reference ' + point);
      else {
        const back = tree(copy), history = Object.keys(back).filter(n => n.startsWith('internal/notebook-migration/journal-rolled-back-'));
        equal(history.length, 1, '1954: rollback keeps one journal ' + point);
        for (const name of history) delete back[name];
        same(back, before, '1954: rollback restores every byte ' + point);
      }
    } }));
    console.log('1954: all eleven legacy states, seven case groups, ' + points.length + ' interruption points resumed and rolled back');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- 1980. No self-test section starts PowerShell outside its allowed list (kickoffs/s225 row 3; PLAN-powershell-retirement.md
// U2 items 4 and 6). Every code file under kernel/test/ is read for a PowerShell launch: a spawn, spawnSync, execFile,
// execFileSync or boundedCommand whose program is powershell or pwsh, by name or by a WindowsPowerShell path, written in
// the call or in the variable the call names; such a call whose arguments hold PowerShell's -File; and any -EncodedCommand.
// Each launch must sit in a section or helper the list below names, with the unit that removes it, and an entry with no
// launch left fails too, so each owner removes its own entry. Fixture files prove each spelling is caught and that a
// mention which starts nothing (a hook registration, a PATH filter, a message, a comment) is not.
async function section1980(): Promise<void> {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  // The spellings are assembled, so this section's own text holds none of them.
  const PS = ['power', 'shell'].join(''), PW = ['pw', 'sh'].join(''), WPS = ['Windows', 'Power', 'Shell'].join('');
  const ENC = ['-Encoded', 'Command'].join(''), FILE = ['-Fi', 'le'].join(''), SPAWN = ['spawn', 'Sync'].join('');
  type Allowed = {file: string; owner: string; who: string};
  const allowed: Allowed[] = [
    {file: 'run-parallel.ts', owner: PS, who: "U2 item 3: the runner's process reads, once a release carries c176's process list"},
    {file: 'selftest.ts', owner: 's39', who: "c175's follow-up (pull request 107 changes section 39)"},
    {file: 'selftest.ts', owner: 's132', who: 'stays: it runs install.ps1, the plan\'s one exception'},
    {file: 'selftest.ts', owner: 's137', who: 'stays: it runs install.ps1, the plan\'s one exception'},
    {file: 'selftest.ts', owner: 's231', who: "s224's follow-up (pull request 108)"},
    {file: 'selftest.ts', owner: 's625', who: "s224's follow-up: its check moves to tools/gate-checks.ts in pull request 108"},
    {file: 'selftest.ts', owner: 's754', who: "s224's follow-up for the check (pull request 108); U4 for Initialize-CodexLibrary.ps1"},
    {file: 'lanes/notebook-and-install.ts', owner: 's1612', who: 'U4 (the notebook-and-install lane is c175\'s file)'},
  ];
  const program = new RegExp(`['"\`](?:[^'"\`\\n]*[\\\\/])?(?:${PS}|${PW})(?:\\.exe)?['"\`]|${WPS}`, 'i');
  const fileFlag = new RegExp(`['"\`]${FILE}['"\`]`), encoded = new RegExp(`['"\`]${ENC}['"\`]`, 'gi');
  const calls = /\b(?:spawn|spawnSync|execFile|execFileSync|boundedCommand)\s*\(/g;
  const markers = [/^(?:export )?(?:async )?function\s+section(\d+)\b/, /^if \(selected\((\d+)\)/, /^\/\/ --- (\d+)[.:]/, /^\/\/ SECTION (\d+)\./, /^(?:export )?(?:async )?function\s+(\w+)/];
  // The text inside the parentheses that open at `open`, skipping string contents.
  const inside = (text: string, open: number): string => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  };
  const firstArgument = (args: string): string => {
    let depth = 0;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < args.length && args[i] !== ch; i++) if (args[i] === '\\') i++;
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) return args.slice(0, i);
    }
    return args;
  };
  // A declaration's value, from just after its `=` to the `;` that ends it outside brackets and strings, or to the end of
  // a line where every bracket is closed, the value does not end in an operator, and the next line starts a statement.
  const statementFrom = (text: string, from: number, end: number): string => {
    let depth = 0;
    for (let i = from; i < end; i++) {
      const ch = text[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < end && text[i] !== ch; i++) if (text[i] === '\\') i++;
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) return text.slice(from, i); depth--; }
      else if (ch === ';' && depth === 0) return text.slice(from, i);
      else if (ch === '\n' && depth === 0) {
        const soFar = text.slice(from, i);
        if (soFar.trim() && !/[=+\-*/%,?:|&(]\s*$/.test(soFar) && /^\s*(?:(?:const|let|var|if|for|while|do|return|await|throw|try|switch|function|class)\b|[A-Za-z_$][\w$.]*\s*\()/.test(text.slice(i + 1, end))) return soFar;
      }
    }
    return text.slice(from, end);
  };
  const scan = (root: string, list: Allowed[]) => {
    const files: string[] = [];
    const walk = (folder: string) => {
      for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:ts|mts|js|mjs|cjs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
    const launches: {file: string; line: number; owner: string; why: string}[] = [];
    for (const full of files.sort()) {
      const file = path.relative(root, full).split(path.sep).join('/');
      const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      const lines = text.split('\n');
      const starts: number[] = [];
      for (let i = 0, at = 0; i < lines.length; at += lines[i]!.length + 1, i++) starts.push(at);
      const lineOf = (index: number) => { let low = 0, high = starts.length - 1; while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid]! <= index) low = mid; else high = mid - 1; } return low; };
      const comment = (line: number) => /^\s*(?:\/\/|\*|\/\*)/.test(lines[line]!);
      const owner = (line: number) => {
        for (let i = line; i >= 0; i--) for (const marker of markers) { const found = marker.exec(lines[i]!); if (found) return /^\d+$/.test(found[1]!) ? 's' + found[1] : found[1]!; }
        return '(top)';
      };
      const add = (index: number, why: string) => {
        const line = lineOf(index);
        if (comment(line) || launches.some(seen => seen.file === file && seen.line === line + 1)) return;
        launches.push({file, line: line + 1, owner: owner(line), why});
      };
      for (const call of text.matchAll(calls)) {
        const args = inside(text, call.index! + call[0].length - 1), first = firstArgument(args).trim();
        if (program.test(first)) { add(call.index!, 'starts ' + first.replace(/\s+/g, ' ').slice(0, 80)); continue; }
        if (fileFlag.test(args)) { add(call.index!, `passes ${FILE} to ${first.slice(0, 40)}`); continue; }
        const name = /^([A-Za-z_$][\w$]*)!?$/.exec(first)?.[1];
        if (!name) continue;
        const line = lineOf(call.index!);
        for (let i = line; i >= Math.max(0, line - 80); i--) {
          const declared = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).exec(lines[i]!);
          const listed = new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+${name}\\s+of\\s+([^)]*)`).exec(lines[i]!);
          if (!declared && !listed) continue;
          // A declaration is read whole, across lines (kickoffs/s225-r2), so a path built over several lines is seen.
          const value = declared ? statementFrom(text, starts[i]! + declared.index + declared[0].length, call.index!) : listed![1]!;
          if (program.test(value)) add(call.index!, `starts ${name}, which holds a PowerShell path (line ${i + 1})`);
          break;
        }
      }
      for (const found of text.matchAll(encoded)) add(found.index!, `passes ${ENC}`);
    }
    const unlisted = launches.filter(launch => !list.some(entry => entry.file === launch.file && entry.owner === launch.owner));
    const stale = list.filter(entry => !launches.some(launch => launch.file === entry.file && launch.owner === entry.owner));
    return {files: files.length, launches, unlisted, stale};
  };
  const shown = (rows: {file: string; line: number; owner: string; why: string}[]) => rows.map(row => `${row.file}:${row.line} (${row.owner}) ${row.why}`).join('; ');

  // FIXTURES: each spelling once in a file of its own, a data-only file, and an allowed launch.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-launch-audit-'));
  try {
    const put = (name: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), body); };
    const caught = {
      'by-name.ts': `async function section1() {\n  const ran = ${SPAWN}('${PS}.exe', ['-NoProfile', '-Command', 'exit 0']);\n}\n`,
      'lanes/by-path.ts': `async function section2() {\n  const shell = path.join(root, 'System32', '${WPS}', 'v1.0', '${PS}.exe');\n  const ran = ${SPAWN}(\n    shell,\n    ['-NoProfile'],\n  );\n}\n`,
      'by-list.ts': `async function section3() {\n  for (const shell of ['${PW}', '${PS}.exe']) {\n    const ran = spawn(shell, ['-NoProfile']);\n  }\n}\n`,
      'encoded.ts': `async function section4() {\n  const ran = run(exe, ['${ENC}', text]);\n}\n`,
      'file-flag.ts': `async function section5() {\n  const ran = execFileSync(exe, ['-NoProfile', '${FILE}', 'tools/Check.ps1']);\n}\n`,
      'by-binding-lines.ts': `async function section9() {\nconst shell = path.join(\n  root, '${PW}.exe'\n);\n${SPAWN}(shell, ['-Command', 'exit 0']);\n}\n`,
    };
    // The same binding over several lines, naming Node, starts no PowerShell.
    put('node-binding-lines.ts', `async function section10() {\nconst shell = path.join(\n  root, 'node.exe'\n);\n${SPAWN}(shell, ['-Command', 'exit 0']);\n}\n`);
    for (const [name, body] of Object.entries(caught)) put(name, body);
    put('data.ts', [
      'async function section6() {',
      `  const block = [{ hooks: [{ type: 'command', command: '${PS}.exe', args: ['-NoProfile', '${FILE}', 'C:/p/Hook.ps1'] }] }];`,
      `  const entries = paths.filter((entry) => !fs.existsSync(path.join(entry, '${PS}.exe')));`,
      `  const where = ${SPAWN}('where.exe', ['${PS}.exe', '${PW}.exe']);`,
      `  check(row.detail.includes('${PS}.exe is missing'), 'named');`,
      `  // ${SPAWN}('${PS}.exe', ['${ENC}', x]) in a comment starts nothing`,
      '}',
      '',
    ].join('\n'));
    put('allowed.ts', `// --- 7. An allowed launch.\nif (selected(7)) {\n  const ran = ${SPAWN}('${PS}.exe', ['-NoProfile']);\n}\n`);
    const fixtureList: Allowed[] = [{file: 'allowed.ts', owner: 's7', who: 'the fixture'}, {file: 'gone.ts', owner: 's8', who: 'a launch already removed'}];
    const fixture = scan(root, fixtureList);
    same(fixture.unlisted.map(row => row.file).sort(), Object.keys(caught).sort(), '1980: each spelling is caught once, and nothing in the data file or the allowed launch: ' + shown(fixture.unlisted));
    same(fixture.unlisted.map(row => `${row.file}:${row.owner}`).sort(), ['by-binding-lines.ts:s9', 'by-list.ts:s3', 'by-name.ts:s1', 'encoded.ts:s4', 'file-flag.ts:s5', 'lanes/by-path.ts:s2'], '1980: each launch is named by its section');
    same(fixture.launches.filter(row => row.file === 'node-binding-lines.ts').map(row => row.owner), [], '1980: a binding over several lines that names Node is taken for a PowerShell launch');
    equal(fixture.unlisted.find(row => row.file === 'lanes/by-path.ts')?.line, 3, '1980: a call over several lines is named at its first line');
    same(fixture.launches.filter(row => row.file === 'allowed.ts').map(row => row.owner), ['s7'], '1980: the allowed launch is seen and passes');
    same(fixture.stale.map(entry => entry.file), ['gone.ts'], '1980: an entry with no launch left is reported');

    // THIS CHECKOUT: no launch outside the list, and no entry without one.
    const real = scan(path.join(PROGRAM_ROOT, 'kernel', 'test'), allowed);
    check(real.files > 10, `1980: kernel/test/ held only ${real.files} code files`);
    check(real.unlisted.length === 0, `1980: ${real.unlisted.length} PowerShell launch(es) in kernel/test/ outside the allowed list: ${shown(real.unlisted)}. Rewrite the section so it judges the kernel without PowerShell (kickoffs/s225), or add an entry naming the unit that removes it.`);
    check(real.stale.length === 0, `1980: allowed entries with no launch left; remove them: ${real.stale.map(entry => `${entry.file} ${entry.owner} (${entry.who})`).join('; ')}`);
    console.log(`1980: ${real.files} files read; ${real.launches.length} launches, ${real.unlisted.length} outside the list: ${shown(real.launches)}`);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}
