/**
 * The kernel's own suite.
 *
 * IT ENTERS THE WAY A CALLER DOES. S12 recorded the cost of the alternative against the acceptance
 * harness itself: 26 checks green while `-All` died on its first row, because every case called the
 * inner function directly and nothing ran the script. So every behavioural case here spawns
 * `node kernel/src/cli.ts` as a CHILD PROCESS and reads its stdout, stderr and exit code. The pure
 * cases -- the serializer and the merge -- are imported, because there the function IS the subject.
 *
 * THE SERIALIZER IS PINNED AGAINST MEASURED PowerShell OUTPUT, not against itself. `ConvertTo-Json`
 * indents a container's children relative to the column its own opening bracket was written at, so
 * the length of the key above decides the indent; a round trip through this file's own writer would
 * agree with any rule it happened to implement. The expectations below were taken from Windows
 * PowerShell 5.1 on 2026-09-22 and are what the acceptance matrix compares byte for byte.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psConvertToJson } from '../src/psjson.ts';
import { mergeLibraryJsonValue, managedSectionPlan, desiredPermissionAllowlist } from '../src/init.ts';
import { newShelfCatalogEntryText, testShelfCatalogEntryText } from '../src/shelfcatalog.ts';
import { toWorkspaceRoot, findWorkspaceByMarker } from '../src/workspace.ts';
import { VERBS, READER_TOOLS } from '../src/verbs.ts';
import { isCompiled, locateProgramRoot } from '../src/programroot.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.ts');
const PROGRAM_ROOT = path.resolve(HERE, '..', '..');

/**
 * TWO SWITCHES FOR A MATRIX JUDGE (S41), both absent in an ordinary run, which then runs every section
 * against this checkout's CLI as it always has. LIBRARY_SELFTEST_KERNEL is the kernel under test as a
 * command line (an executable, or an interpreter and a script, split on whitespace as the acceptance
 * harness splits its -Kernel), so a section that drives the front door judges THAT kernel.
 * LIBRARY_SELFTEST_SECTIONS is a comma list of section numbers to run, because most sections import this
 * checkout's modules in process and would judge the source tree, not the kernel under test: a judge names
 * only sections that go through `runCli`.
 */
const KERNEL_COMMAND = (process.env['LIBRARY_SELFTEST_KERNEL'] ?? '').split(/\s+/).filter((part) => part.length > 0);
const SECTIONS = new Set(
  (process.env['LIBRARY_SELFTEST_SECTIONS'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number),
);
if ([...SECTIONS].some((section) => !Number.isInteger(section) || section < 1)) {
  process.stderr.write(`kernel self-test: LIBRARY_SELFTEST_SECTIONS must be section numbers, got '${process.env['LIBRARY_SELFTEST_SECTIONS']}'\n`);
  process.exit(2);
}
function selected(section: number): boolean {
  return SECTIONS.size === 0 || SECTIONS.has(section);
}

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, label: string): void {
  checks += 1;
  if (!condition) failures.push(label);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${label} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runCli(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  const [file, ...prefix] = KERNEL_COMMAND.length ? KERNEL_COMMAND : [process.execPath, CLI];
  const result = spawnSync(file!, [...prefix, ...args], {
    cwd: options.cwd ?? PROGRAM_ROOT,
    env: { ...process.env, LIBRARY_WORKSPACE: '', ...(options.env ?? {}) },
    encoding: 'utf8',
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return {
    exit: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// --- 1. The PowerShell-shaped serializer ------------------------------------------------------------

// Measured from `[ordered]@{...} | ConvertTo-Json` on Windows PowerShell 5.1, with CRLF collapsed --
// which is what the acceptance comparator does before it compares.
if (selected(1)) {
  const PINNED = [
    '{',
    '    "emptyobj":  {',
    '',
    '                 },',
    '    "nested":  {',
    '                   "inner":  {',
    '',
    '                             }',
    '               },',
    '    "arrobj":  [',
    '                   {',
    '                       "x":  1',
    '                   }',
    '               ],',
    '    "deep":  [',
    '                 [',
    '                     1,',
    '                     2',
    '                 ],',
    '                 [',
    '                     3',
    '                 ]',
    '             ],',
    '    "num":  0,',
    '    "neg":  -1,',
    '    "big":  1234567890123',
    '}',
  ].join('\n');

  equal(
    psConvertToJson({
      emptyobj: {},
      nested: { inner: {} },
      arrobj: [{ x: 1 }],
      deep: [
        [1, 2],
        [3],
      ],
      num: 0,
      neg: -1,
      big: 1234567890123,
    }),
    PINNED,
    'the PowerShell-shaped serializer drifted from the layout ConvertTo-Json writes',
  );

  // The escapes PowerShell applies and the ones it does not. `<`, `>`, `&` and `'` are escaped as
  // \uXXXX; a forward slash and a non-ASCII character are written literally.
  equal(psConvertToJson({ a: "<x> & y'z" }), '{\n    "a":  "\\u003cx\\u003e \\u0026 y\\u0027z"\n}', 'the JavaScriptSerializer escapes drifted');
  equal(psConvertToJson({ a: 'p/q' }), '{\n    "a":  "p/q"\n}', 'a forward slash was escaped and PowerShell does not escape one');
  equal(psConvertToJson({ a: 'caf\u00e9' }), '{\n    "a":  "caf\u00e9"\n}', 'a non-ASCII character was escaped and PowerShell writes it literally');
  equal(psConvertToJson({ a: 'x\ty\nz' }), '{\n    "a":  "x\\ty\\nz"\n}', 'the short control escapes drifted');

  // AND IT IS FALSIFIED, not merely exercised: a writer that agreed with everything would pass every
  // case above. Two documents that differ must not serialize alike.
  check(
    psConvertToJson({ a: 1 }) !== psConvertToJson({ a: 2 }),
    'the serializer produced the same text for two different documents',
  );
}

// --- 2. The merge, in both directions -----------------------------------------------------------------

if (selected(2)) {
  const absent = mergeLibraryJsonValue(null, { permissions: { allow: ['a'] } }, 'settings.json');
  check(absent.changed, 'a merge into an absent document reported no change');

  const equalCase = mergeLibraryJsonValue({ permissions: { allow: ['a'] } }, { permissions: { allow: ['a'] } }, 'settings.json');
  check(!equalCase.changed, 'a merge of an entry already present reported a change');
  check(equalCase.conflicts.length === 0, 'a merge of an identical entry reported a conflict');

  const setMerge = mergeLibraryJsonValue({ permissions: { allow: ['reader'] } }, { permissions: { allow: ['a'] } }, 'settings.json');
  const allow = ((setMerge.value as Record<string, unknown>)['permissions'] as Record<string, unknown>)['allow'] as string[];
  check(allow.length === 2 && allow[0] === 'reader', "a list merged as a set did not keep the reader's own entry first");

  // A LEAF THAT DISAGREES IS A CONFLICT, NAMED. This is the direction that must not go quiet: a
  // merge that silently replaced a reader's value would be a tool overwriting work it did not write.
  const conflict = mergeLibraryJsonValue({ model: 'theirs' }, { model: 'ours' }, 'settings.json');
  check(conflict.conflicts.length === 1, 'a disagreeing leaf did not report a conflict');
  check(!conflict.changed, 'a disagreeing leaf reported a change');
  check(String(conflict.conflicts[0]).includes('theirs') && String(conflict.conflicts[0]).includes('ours'), 'the conflict named neither value');

  const shapeConflict = mergeLibraryJsonValue({ permissions: 'not-an-object' }, { permissions: { allow: ['a'] } }, 'settings.json');
  check(shapeConflict.conflicts.length === 1, 'a scalar where an object is wanted did not report a conflict');
}

// --- 3. The managed section ------------------------------------------------------------------------

if (selected(3)) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-selftest-'));
  try {
    const file = path.join(sandbox, 'CLAUDE.md');
    equal(managedSectionPlan(file, 'BODY').action, 'create', 'an absent instruction file did not plan a create');

    fs.writeFileSync(file, 'The reader wrote this.\n', 'utf8');
    const appended = managedSectionPlan(file, 'BODY');
    equal(appended.action, 'append', 'a file with no markers did not plan an append');
    check(String(appended.content).startsWith('The reader wrote this.'), 'an append did not keep every byte the reader wrote');

    fs.writeFileSync(file, String(appended.content), 'utf8');
    equal(managedSectionPlan(file, 'BODY').action, 'unchanged', 'an identical section was rewritten rather than reported unchanged');
    equal(managedSectionPlan(file, 'OTHER').action, 'replace', 'a changed body did not plan a replace');

    // MALFORMED IS A REFUSAL AND NOT A REPAIR. Every repair guesses at where the reader's own words
    // stop, and guessing wrong silently deletes prose somebody wrote.
    fs.writeFileSync(file, '<!-- library:begin -->\nx\n<!-- library:begin -->\ny\n<!-- library:end -->\n', 'utf8');
    equal(managedSectionPlan(file, 'BODY').action, 'refuse', 'two begin markers were repaired rather than refused');
    fs.writeFileSync(file, '<!-- library:end -->\nx\n<!-- library:begin -->\n', 'utf8');
    equal(managedSectionPlan(file, 'BODY').action, 'refuse', 'an inverted marker pair was repaired rather than refused');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- 4. The workspace resolver ------------------------------------------------------------------------

if (selected(4)) {
  check(toWorkspaceRoot('\\\\server\\share\\ws') === null, 'a UNC path was accepted as a workspace root');
  check(toWorkspaceRoot('') === null, 'an empty path was accepted as a workspace root');
  check(toWorkspaceRoot('C:\\x\\') === 'C:\\x', 'a trailing separator was not trimmed from a workspace root');
  check(toWorkspaceRoot('C:\\') === 'C:\\', 'a drive root was trimmed away');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-selftest-'));
  try {
    const deep = path.join(sandbox, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    check(findWorkspaceByMarker(deep) === null, 'a directory in no workspace resolved to one');
    fs.mkdirSync(path.join(sandbox, '.library'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, '.library', 'workspace.json'), '{}', 'utf8');
    const found = findWorkspaceByMarker(deep);
    check(found !== null && fs.existsSync(path.join(found, '.library', 'workspace.json')), 'a marker above the start directory was not found by walking up');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- 5. The Shelf catalog entry rules --------------------------------------------------------------------

if (selected(5)) {
  const composed = newShelfCatalogEntryText('alpha', 'Caf\u00e9 Book', ['- **Summary:** Accented.']);
  check(composed.includes('- **Path:** shelf/alpha'), 'the composer did not append the Path line');
  check(composed.includes('Caf\u00e9 Book'), 'the composer mangled a non-ASCII title');

  let mislabelled = false;
  try {
    newShelfCatalogEntryText('alpha', 'Alpha', ['- **Path:** shelf/zeta']);
  } catch {
    mislabelled = true;
  }
  check(mislabelled, 'a caller supplied a second Path line and it was accepted');

  // THE SLUG IS CHECKED AGAINST THE DIRECTORY THE ENTRY WAS FOUND IN, which is the whole reason an
  // entry file is safe to render unread.
  let mismatched = false;
  try {
    testShelfCatalogEntryText('## Zeta\n- **Path:** shelf/zeta\n', 'alpha', 'test');
  } catch {
    mismatched = true;
  }
  check(mismatched, 'an entry declaring another Book was accepted under this one');
}

// --- 6. The front door ---------------------------------------------------------------------------------

if (selected(6)) {
  const help = runCli(['help']);
  equal(help.exit, 0, `library help exited ${help.exit}`);
  check(help.stdout.includes('library -- the Library'), 'library help printed no usage');

  const unknown = runCli(['nope']);
  check(unknown.exit !== 0, 'an unknown command exited 0');
  check(unknown.stdout.trim() === '', 'an unknown command wrote a refusal to stdout');
  check(unknown.stderr.includes("has no command 'nope'"), 'an unknown command did not name itself in the refusal');
  // NAMES WHAT EXISTS, rather than leaving the reader guessing at a list the dispatcher is holding.
  check(unknown.stderr.includes('shelf'), 'the refusal for an unknown command named no command that does exist');

  // THE VERB TABLE IS WHAT THE GATE CHECK READS, so its shape is asserted here rather than only
  // where it is consumed.
  const inventory = runCli(['verbs']);
  equal(inventory.exit, 0, `library verbs exited ${inventory.exit}`);
  let parsed: { verbs: Record<string, { actions: string[]; ported: boolean }>; reader_tools: string[] } | null = null;
  try {
    parsed = JSON.parse(inventory.stdout);
  } catch (error) {
    failures.push(`library verbs did not print parseable JSON: ${(error as Error).message}`);
  }
  if (parsed) {
    check(Object.keys(parsed.verbs).length === Object.keys(VERBS).length, 'library verbs printed a different number of verbs than the table declares');
    check(parsed.reader_tools.length === READER_TOOLS.length, 'library verbs printed a different number of reader tools than the table declares');
    check(parsed.verbs['shelf']!.actions.includes('render'), 'library verbs did not list the shelf actions');
  }

  // AN UNPORTED VERB REFUSES BY NAME AND EXITS NON-ZERO. A kernel that exited 0 on a command it did
  // not run would compare green against an arm that had done the work.
  // `selftest`, since S43 ported `collection owner`, which was this probe until then (and `hub new` before it).
  const unported = runCli(['selftest', 'hooks']);
  check(unported.exit !== 0, 'an unported verb exited 0');
  check(unported.stderr.includes('not ported yet'), 'an unported verb did not say so');
  check(unported.stdout.trim() === '', 'an unported verb wrote to stdout');

  // THE RESOLVER'S REFUSAL IS PASSED ON, WITH THE VERB IN FRONT OF IT. Its wording names the three
  // routes to a workspace, and a second wording of that would drift from it.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-selftest-'));
  try {
    const noWorkspace = runCli(['desk', '--json'], { cwd: sandbox });
    check(noWorkspace.exit !== 0, 'a command needing a workspace exited 0 where there is none');
    check(noWorkspace.stderr.startsWith('library desk : '), 'the refusal did not carry the verb it came from');
    check(noWorkspace.stderr.includes('`library init <folder>` creates one'), 'the refusal did not name the command that creates a workspace');

    // `library init` END TO END, THROUGH THE FRONT DOOR. The acceptance matrix judges this against
    // the PowerShell arm; this asserts the one thing the matrix cannot, which is that the entry path
    // between the argument list and the initialiser binds at all.
    const workspace = path.join(sandbox, 'ws');
    const registry = path.join(sandbox, 'registry');
    const created = runCli(['init', workspace, '--registry-root', registry, '--collection-id', '00000000-0000-0000-0000-000000000000']);
    equal(created.exit, 0, `library init exited ${created.exit}: ${created.stderr}`);
    let initResult: { status: string; files: { file: string; action: string }[] } | null = null;
    try {
      initResult = JSON.parse(created.stdout);
    } catch (error) {
      failures.push(`library init did not print parseable JSON: ${(error as Error).message}`);
    }
    if (initResult) {
      equal(initResult.status, 'initialized', 'a first init did not report itself initialized');
      check(fs.existsSync(path.join(workspace, '.library', 'workspace.json')), 'library init reported success and wrote no marker');
      check(fs.existsSync(path.join(registry, 'workspaces.json')), 'library init reported success and registered nothing');
      check(initResult.files.some((entry) => entry.file === 'CLAUDE.md' && entry.action === 'create'), 'library init did not create the instruction file');
    }

    // IDEMPOTENT, AND THE SECOND RUN MUST SAY SO RATHER THAN REISSUING THE ID.
    const again = runCli(['init', workspace, '--registry-root', registry]);
    equal(again.exit, 0, `a second library init exited ${again.exit}: ${again.stderr}`);
    const secondResult = JSON.parse(again.stdout) as { status: string; id: string };
    equal(secondResult.status, 'already_initialized', 'a second init did not report the workspace already initialised');
    if (initResult) {
      equal(secondResult.id, (initResult as unknown as { id: string }).id, 'a second init reissued the workspace id');
    }

    // THE LOCAL COLLECTION (ADR-0030, S30), and the marker keeping its collection on a re-run -- the
    // Report Inbox's defect, which the second init above is exactly the shape of.
    const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    const idFile = path.join(workspace, 'collection', '.library', 'collection.json');
    check(fs.existsSync(idFile), 'a Tier 0 init laid out no collection id file');
    for (const relative of ['books/README.md', 'projects/README.md', 'archive/projects/README.md']) {
      check(fs.existsSync(path.join(workspace, 'collection', relative)), `a Tier 0 init laid out no collection/${relative}`);
    }
    const pinned = '00000000-0000-0000-0000-000000000000';
    equal(readJson(idFile)['id'], pinned, "the local collection did not take the id init was given");
    equal(readJson(path.join(workspace, '.library', 'workspace.json'))['collection_id'], pinned, 'a Tier 0 re-run with no collection id lost the collection');
    const retarget = runCli(['init', workspace, '--registry-root', registry, '--force', '--collection-id', '11111111-1111-1111-1111-111111111111']);
    check(retarget.exit !== 0 && retarget.stderr.includes('will not retarget the workspace'), 'an init naming another collection than collection.json did not refuse');
    equal(readJson(path.join(workspace, '.library', 'workspace.json'))['collection_id'], pinned, 'a refused retarget still changed the marker');
    const withEndpoint = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-endpoint-'));
    try {
      // WITH AN ENDPOINT THERE IS NO LOCAL COLLECTION, so the marker is the only record of the id and
      // this is where the Report Inbox's defect shows: measured, the Tier 0 case above passes with the
      // marker fallback removed, because collection.json answers for it.
      const attached = runCli(['init', withEndpoint, '--registry-root', registry, '--mcp-url', 'http://127.0.0.1:1/mcp', '--collection-id', pinned]);
      equal(attached.exit, 0, `an init with an endpoint exited ${attached.exit}: ${attached.stderr}`);
      check(!fs.existsSync(path.join(withEndpoint, 'collection')), 'a workspace with an endpoint was given a local collection');
      const rerun = runCli(['init', withEndpoint, '--registry-root', registry, '--mcp-url', 'http://127.0.0.1:1/mcp', '--force']);
      equal(rerun.exit, 0, `a re-run with an endpoint exited ${rerun.exit}: ${rerun.stderr}`);
      equal(readJson(path.join(withEndpoint, '.library', 'workspace.json'))['collection_id'], pinned, 'a re-run with no collection id emptied the one the marker recorded');
    } finally {
      fs.rmSync(withEndpoint, { recursive: true, force: true });
    }

    // THE SHAPE IS JUDGED BEFORE THE DIRECTORY IS CREATED. A UNC path is refused by the rule rather
    // than by whatever the network happens to say.
    const unc = runCli(['init', '\\\\server\\share\\ws', '--registry-root', registry]);
    check(unc.exit !== 0, 'library init accepted a UNC path');
    check(unc.stderr.includes('drive-rooted'), 'the UNC refusal did not name the rule');
    check(unc.stdout.trim() === '', 'a refused init wrote a result to stdout');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- 7. The allowlist the workspace is given is DERIVED, never spelled out ------------------------------

if (selected(7)) {
  const allow = desiredPermissionAllowlist(PROGRAM_ROOT);
  check(allow.length > 0, "the program's own settings yielded no validated-reader permission entries");
  check(
    allow.every((entry) => entry.startsWith('mcp__validated-book-reader__')),
    'the derived allowlist carried an entry that is not a validated-reader tool',
  );
  const sorted = [...allow].sort();
  check(allow.every((entry, index) => entry === sorted[index]), 'the derived allowlist was not sorted');
}

// --- 8. THE TABLE AND THE DISPATCH, CHECKED AGAINST EACH OTHER -----------------------------------------
//
// `acceptance.kernel-verbs-exist` resolves a matrix row's verb against `library verbs`, which proves a
// row names something the table knows. It cannot prove the DISPATCH knows it: a verb flipped to
// `ported: true` with no branch beside it lands in the default arm, and the only thing that would
// ever say so is a refusal nothing runs. The rule in `.claude/rules/library-development.md` is that a
// list standing for a table is checked BOTH WAYS, so this drives every ported verb through the front
// door and asserts none of them reports that defect.
//
// EACH ONE IS GIVEN AN ARGUMENT SHAPE CERTAIN TO REFUSE, from a directory that is no workspace. What
// is asserted is WHICH refusal arrives -- the verb's own, never the dispatcher's.

if (selected(8)) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'library-kernel-verbs-'));
  try {
    // A shape per verb that reaches its branch and stops there. `init` is exercised in full by
    // section 6 and is deliberately not run here: it would create a workspace.
    const probes: Record<string, string[]> = {
      verbs: ['verbs'],
      shelf: ['shelf', 'no-such-action'],
      desk: ['desk', 'no-such-action'],
      mcp: ['mcp', 'no-such-action'],
      raw: ['raw', 'no-such-action'],
      triage: ['triage', 'no-such-action'],
      book: ['book', 'no-such-action'],
      // `capture` takes a positional Book rather than an action word, so the shape certain to stop
      // in its own branch is a missing title rather than an unknown action.
      capture: ['capture', 'holding'],
      // S17's four. `compile` takes a positional batch, `doctor` takes nothing and ANSWERS with no
      // workspace -- every check skipped -- which is the one probe here that is not a refusal.
      compile: ['compile', '.'],
      notebook: ['notebook', 'no-such-action'],
      reset: ['reset', 'no-such-action'],
      doctor: ['doctor'],
      // S14's second half. An unknown action stops in the verb's own branch.
      seat: ['seat', 'no-such-action'],
      // S18. `migrate` takes no action word, so two modes at once is the shape that stops in its branch.
      migrate: ['migrate', '--preflight', '--resume'],
      // S30. With no workspace the branch refuses in the resolver's words, which is still its own branch.
      hub: ['hub', 'no-such-action'],
      // S34. Both stop at the workspace resolver in the sandbox, which is still the dispatcher's branch.
      shared: ['shared', 'no-such-action'],
      publish: ['publish', 'curated'],
      // S31. A guard reads its payload from stdin, so the probe names none and stops at the refusal.
      hook: ['hook', 'no-such-guard'],
      // S43. With no workspace the branch refuses in the resolver's words, which is still its own branch.
      collection: ['collection', 'no-such-action'],
    };
    for (const [verb, declaration] of Object.entries(VERBS)) {
      if (!declaration.ported) continue;
      if (verb === 'init') continue;
      const probe = probes[verb];
      check(probe !== undefined, `verb '${verb}' is declared ported and this suite has no probe for it`);
      if (probe === undefined) continue;
      const answer = runCli(probe, { cwd: sandbox });
      check(
        !answer.stderr.includes('has no dispatch branch'),
        `library ${verb} is declared ported and the dispatcher has no branch for it`,
      );
    }

    // AN UNPORTED VERB REFUSES BY NAME AND NAMES THE ROW THAT CARRIES IT, which is what lets its
    // matrix row mismatch honestly rather than sitting pending.
    // `selftest`, since S43 ported `collection owner`, which was this probe's verb until then.
    const unported = runCli(['selftest', 'hooks'], { cwd: sandbox });
    check(unported.exit !== 0, 'an unported verb exited 0');
    check(unported.stdout.trim() === '', 'an unported verb wrote a result to stdout');
    check(unported.stderr.includes('not ported yet'), 'an unported verb did not say it is unported');
    check(unported.stderr.includes(VERBS['selftest']!.row), 'an unported verb did not name the ledger row that carries it');

    // SKIP AND FAIL ARE DIFFERENT ANSWERS, and the doctor is the verb whose whole subject that is. With
    // no workspace every check reports skipped WITH the reason, the run exits 0, and the report still
    // arrives -- a doctor that refused here would be a doctor unusable by the reader who most needs it.
    const doctor = runCli(['doctor', '--json'], { cwd: sandbox });
    check(doctor.exit === 0, `library doctor with no workspace exited ${doctor.exit}: ${doctor.stderr}`);
    let doctorReport: { checks?: { status: string; detail: string }[]; skipped?: number; workspace?: string } = {};
    try {
      doctorReport = JSON.parse(doctor.stdout) as typeof doctorReport;
    } catch {
      check(false, 'library doctor with no workspace printed no parseable report');
    }
    const doctorChecks = doctorReport.checks ?? [];
    check(doctorChecks.length === 9, `library doctor reported ${doctorChecks.length} checks rather than the nine workspace checks`);
    check(doctorChecks.every((row) => row.status === 'skipped'), 'library doctor with no workspace reported a check as something other than skipped');
    check(doctorChecks.every((row) => row.detail.includes('no reader workspace is attached')), 'a skipped doctor check did not say why');
    check(doctorReport.workspace === '', 'library doctor with no workspace reported one anyway');

    // A GATED WRITER WITH NO WORKSPACE REFUSES IN THE RESOLVER'S WORDS, before it reads a catalog.
    // The matrix always hands these a workspace, so this is the shape it never exercises -- and a
    // writer that got halfway into a Shelf it could not identify is the failure worth pinning.
    for (const argv of [
      ['shelf', 'rename', 'alpha', 'beta'],
      ['shelf', 'remove', 'alpha'],
      ['shelf', 'archive', 'alpha'],
      ['shelf', 'restore', 'alpha'],
      ['shelf', 'stub', 'alpha', 'page', '--canonical', 'alpha/other'],
      ['desk', 'open', 'book', 'alpha'],
      ['capture', 'holding', '--title', 'x', '--body', 'y'],
      ['book', 'add-page', 'alpha', 'page', '--title', 'x', '--body', 'y'],
      ['book', 'graduate', 'alpha', '--topic', 'acceptance', '--preflight'],
      ['raw', 'search', 'alpha', 'needle'],
      ['raw', 'owners'],
      ['triage', 'validate', '--actions', '[]'],
      ['compile', 'acceptance/batch', '--topic', 'acceptance', '--preflight'],
      ['notebook', 'render'],
      ['notebook', 'own', 'acceptance', '--seat', 'alpha'],
      ['reset', '--seat', 'alpha', '--preflight'],
      ['reset', 'restore', '--list'],
      ['migrate', '--preflight'],
    ]) {
      const answer = runCli(argv, { cwd: sandbox });
      check(answer.exit !== 0, `${argv.join(' ')} exited 0 with no workspace`);
      check(answer.stdout.trim() === '', `${argv.join(' ')} wrote a result to stdout with no workspace`);
      check(
        answer.stderr.includes('no Library workspace was selected'),
        `${argv.join(' ')} did not refuse in the resolver's words`,
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- 9. Where a COMPILED kernel finds its program ---------------------------------------------------------

// MEASURED 2026-09-22 (S29) from a `bun build --compile` binary on Windows: `import.meta.url` was
// `file:///B:/%7EBUN/root/<name>.exe`. The source-tree rule gave `B:\` there, so these cases drive
// the rule with that URL rather than with anything this process can produce running from source.
if (selected(9)) {
  const compiledUrl = 'file:///B:/%7EBUN/root/library.exe';
  check(isCompiled(compiledUrl), 'the measured Bun module URL is not recognised as compiled');
  check(isCompiled('file:///$bunfs/root/library'), "Bun's POSIX module URL is not recognised as compiled");
  check(!isCompiled(pathToFileURL(CLI).href), 'the source tree is taken for a compiled binary');

  const fromSource = locateProgramRoot(pathToFileURL(path.join(PROGRAM_ROOT, 'kernel', 'src', 'programroot.ts')).href);
  equal(fromSource.root, PROGRAM_ROOT, 'from source, the program root is not two directories above kernel/src');

  const release = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-release-'));
  try {
    const executable = path.join(release, 'bin', 'library.exe');
    const inRelease = locateProgramRoot(compiledUrl, executable);
    check(inRelease.root === null && inRelease.refusal !== null, 'a binary outside a release layout answered with a root');
    check(
      (inRelease.refusal ?? '').includes(path.join(release, '.codex-plugin', 'plugin.json')),
      'the refusal does not name where it looked',
    );
    fs.mkdirSync(path.join(release, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(release, '.codex-plugin', 'plugin.json'), '{"version":"9.9.9"}');
    const laidOut = locateProgramRoot(compiledUrl, executable);
    equal(laidOut.root, release, 'a binary at <program>/bin/ does not find <program> as its root');
    check(laidOut.compiled, 'a binary in a release does not report itself compiled');
  } finally {
    fs.rmSync(release, { recursive: true, force: true });
  }

  // THE INSTALL'S STABLE ROOT (S30). A junction here, because that is what install.ps1 makes, and
  // Node's 'junction' symlink type needs no privilege. Each case is a different answer the rule gives.
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-install-'));
  try {
    const layVersion = (version: string): string => {
      const root = path.join(install, 'versions', version);
      fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), `{"version":"${version}"}`);
      return root;
    };
    const older = layVersion('1.0.0');
    const newer = layVersion('1.1.0');
    const current = path.join(install, 'current');
    const asRun = (root: string) => locateProgramRoot(compiledUrl, path.join(root, 'bin', 'library.exe')).root;

    equal(asRun(newer), newer, 'with no current link, a versioned binary does not report its own version directory');
    fs.symlinkSync(newer, current, 'junction');
    equal(asRun(newer), current, 'a binary whose version current points at does not report current as its root');
    equal(asRun(older), older, 'a binary current does NOT point at reports current, which names another version');
    fs.unlinkSync(current); // the link, not its target: rmSync refuses a junction as a directory
    fs.symlinkSync(older, current, 'junction');
    equal(asRun(older), current, 'after the switch back, the older version does not report current');
    equal(asRun(newer), newer, 'after the switch back, the newer version still reports current');

    const loose = path.join(install, 'elsewhere', '2.0.0');
    fs.mkdirSync(path.join(loose, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(loose, '.codex-plugin', 'plugin.json'), '{"version":"2.0.0"}');
    fs.symlinkSync(loose, path.join(install, 'elsewhere', 'current'), 'junction');
    equal(asRun(loose), loose, "a release not under a versions/ directory is given a current that is not the installer's");
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }

  const tuple = runCli(['--version']);
  equal(tuple.exit, 0, '--version exited non-zero');
  const reported = JSON.parse(tuple.stdout) as Record<string, unknown>;
  equal(reported['compiled'], false, '--version from source reports itself compiled');
  equal(reported['program_root'], PROGRAM_ROOT, '--version from source names another program root');
  equal(reported['workspace_schema'], 1, '--version reports a workspace schema other than 1');
  check(typeof reported['binary_version'] === 'string' && typeof reported['plugin_version'] === 'string', '--version is missing a version');
}

// --- 10. TIER 0 OPENS A SEAT WITH NO BASIC MEMORY (S16's criterion, S30) ----------------------------------

// Through the front door: init with no endpoint, a Hub in the local collection, a seat created against
// its catalog and bound to a stand-in agent, and the Desk that seat reads back. Every refusal the
// creation gate owes is driven too, because a gate that admits a seat for a Hub nobody made is the
// defect the catalog check exists to prevent.
if (selected(10)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-tier0-'));
  const { spawn } = await import('node:child_process');
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' });
  agent.unref();
  const tier0Env = { LIBRARY_SEAT: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const run = (args: string[]) => runCli(args, { env: tier0Env });
  try {
    const workspace = path.join(root, 'ws');
    const registry = path.join(root, 'reg');
    equal(run(['init', workspace, '--registry-root', registry]).exit, 0, 'a Tier 0 init failed');
    for (const folder of ['notebook', 'shelf', 'raw', 'output', 'internal']) {
      check(fs.existsSync(path.join(workspace, folder)), `init laid out no ${folder}/, so the Desk cannot answer`);
    }

    const hub = run(['hub', 'new', 'tier-zero', '--title', 'Tier Zero', '--workspace', workspace]);
    equal(hub.exit, 0, `hub new exited ${hub.exit}: ${hub.stderr}`);
    check(fs.existsSync(path.join(workspace, 'collection', 'projects', 'tier-zero', '_project.md')), 'hub new wrote no Hub root');
    const again = run(['hub', 'new', 'tier-zero', '--title', 'Tier Zero', '--workspace', workspace]);
    check(again.exit !== 0 && again.stderr.includes('already exists'), 'a second hub new over the same slug did not refuse');
    const catalog = fs.readFileSync(path.join(workspace, 'collection', 'projects', 'README.md'), 'utf8');
    equal(catalog.split('[[projects/tier-zero/_project|').length - 1, 1, 'the catalog does not list the Hub exactly once');

    const seatArgs = (seat: string, extra: string[]) => ['seat', 'enter', seat, '--create', '--agent-pid', String(agent.pid), '--workspace', workspace, ...extra];
    const offer = run(seatArgs('first', ['--preflight']));
    equal(offer.exit, 0, `a preflight with no project exited ${offer.exit}: ${offer.stderr}`);
    const offered = JSON.parse(offer.stdout) as { plan_id: unknown; active_projects: string[] };
    check(offered.plan_id === null && offered.active_projects.includes('tier-zero'), 'a preflight naming no project did not offer the active Projects');
    const invented = run(seatArgs('first', ['--project', 'no-such-hub', '--plan-id', '0000000000000000']));
    check(invented.exit !== 0 && invented.stderr.includes("There is no active Project Hub 'no-such-hub'"), 'a seat for a Hub that does not exist was not refused');
    const preflight = run(seatArgs('first', ['--project', 'tier-zero', '--preflight']));
    const planId = String((JSON.parse(preflight.stdout) as { plan_id: string }).plan_id);
    check(/^[0-9a-f]{16}$/.test(planId), `the preflight issued plan id '${planId}'`);
    const stale = run(seatArgs('first', ['--project', 'tier-zero', '--plan-id', 'ffffffffffffffff']));
    check(stale.exit !== 0 && stale.stderr.includes('that plan_id does not match'), 'a creation under the wrong plan id was not refused');
    check(!fs.existsSync(path.join(workspace, '.claude', 'seats', 'first')), 'a refused creation left a seat directory');

    const created = run(seatArgs('first', ['--project', 'tier-zero', '--plan-id', planId]));
    equal(created.exit, 0, `the confirmed creation exited ${created.exit}: ${created.stderr}`);
    const desk = run(['desk', '--seat', 'first', '--workspace', workspace, '--json']);
    equal(desk.exit, 0, `the Desk of a Tier 0 seat did not answer: ${desk.stderr}`);
    const overview = JSON.parse(desk.stdout) as { open_projects: string[]; this_seat: { claimed: boolean } };
    check(overview.open_projects.includes('projects/tier-zero'), "the new seat's Desk does not hold its own Project");
    check(overview.this_seat.claimed === true, "the new seat's claim is not held");
    const taken = run(seatArgs('second', ['--project', 'tier-zero', '--preflight']));
    check(taken.exit !== 0 && taken.stderr.includes("is already bound to seat 'first'"), 'a second seat for one Project was not refused');
    const catalogRead = run(['mcp', 'call', 'read_project_catalog', '--seat', 'first', '--workspace', workspace]);
    check(catalogRead.stdout.includes('projects/tier-zero/_project'), 'read_project_catalog did not answer from the local collection');

    // A WORKSPACE ATTACHED TO BASIC MEMORY IS NEVER READ AS LOCAL, and since S33 its `hub new` goes to
    // Basic Memory -- FENCED FIRST, so both refusals below land before any request is sent (the endpoint
    // is a closed port). No filesystem view is `misconfigured`; a role another workspace holds is refused
    // in the oracle's words.
    const shared = path.join(root, 'shared');
    run(['init', shared, '--registry-root', registry, '--mcp-url', 'http://127.0.0.1:1/mcp', '--collection-id', '22222222-2222-2222-2222-222222222222']);
    fs.writeFileSync(path.join(shared, '.claude', '.library-mcp-url'), 'http://127.0.0.1:1/mcp');
    fs.writeFileSync(path.join(shared, '.claude', '.library-project'), '22222222-2222-2222-2222-222222222222');
    const noView = run(['hub', 'new', 'x', '--title', 'X', '--workspace', shared]);
    check(
      noView.exit !== 0 && noView.stderr.includes('creating a Project Hub is refused') && noView.stderr.includes('with no filesystem view of it'),
      `hub new against a Basic Memory workspace with no share root was not refused as unfenceable: ${noView.stderr}`,
    );
    check(!fs.existsSync(path.join(shared, 'collection', 'projects', 'x')), 'hub new against a Basic Memory workspace wrote a local Hub');
    const view = path.join(root, 'shared-view');
    for (const catalog of ['books', 'projects']) {
      fs.mkdirSync(path.join(view, catalog), { recursive: true });
      fs.writeFileSync(path.join(view, catalog, 'README.md'), '# Catalog\n');
    }
    fs.mkdirSync(path.join(view, '.owner'), { recursive: true });
    fs.writeFileSync(
      path.join(view, '.owner', '0001.claim.json'),
      JSON.stringify({ schema: 1, incarnation: 1, workspace_id: 'another-workspace', machine: 'elsewhere', acquired: '2026-09-22T00:00:00Z' }),
    );
    fs.writeFileSync(path.join(shared, '.claude', '.library-shared-root'), view);
    const heldElsewhere = run(['hub', 'new', 'x', '--title', 'X', '--workspace', shared]);
    check(
      heldElsewhere.exit !== 0 &&
        heldElsewhere.stderr.includes('workspace another-workspace holds the writable role for this collection at incarnation 1, on elsewhere'),
      `hub new into a collection another workspace owns was not refused by the fence: ${heldElsewhere.stderr}`,
    );
    const sharedSeat = runCli(['seat', 'enter', 'x', '--create', '--project', 'x', '--preflight', '--agent-pid', String(agent.pid), '--workspace', shared], { env: tier0Env });
    check(sharedSeat.exit !== 0 && sharedSeat.stderr.includes('does not speak to Basic Memory yet'), 'seat creation against a Basic Memory workspace was not refused by name');
  } finally {
    try {
      process.kill(agent.pid!);
    } catch {
      // already gone
    }
    // The holder lets go when its agent dies; give it a moment before the directory goes.
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
      }
    }
  }
}

// --- 11. A GUARD JUDGES A NOTEBOOK WRITE AS THIS KERNEL'S WRITERS DO (S31, ADR-0029) ------------------------

// The `guards` rows hold `library hook` to the PowerShell guards wherever the two layouts agree. Where
// they do not -- a seat-owned Notebook, which the oracle never carries -- the rule is the kernel's own,
// and this is what judges it: each layout state, through the front door, with the payload on stdin.
if (selected(11)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-guards-'));
  const env = { LIBRARY_SEAT: '', LIBRARY_WORKSPACES: path.join(root, 'registry') };
  const hook = (workspace: string, tool: string, input: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', 'shelf-read', '--workspace', workspace, '--seat', 'alpha'], {
      cwd: PROGRAM_ROOT,
      env: { ...process.env, LIBRARY_WORKSPACE: '', ...env },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }),
      encoding: 'utf8',
    });
    const stdout = (result.stdout ?? '').trim();
    const reason = stdout ? String((JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason) : '';
    return { exit: result.status ?? -1, allowed: stdout === '', reason };
  };
  const workspaceIn = (name: string, layout: 'seat-owned' | 'legacy' | 'fresh' | 'migrating') => {
    const workspace = path.join(root, name);
    fs.mkdirSync(path.join(workspace, 'notebook'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'internal'), { recursive: true });
    if (layout === 'seat-owned') fs.writeFileSync(path.join(workspace, 'internal', 'notebook-layout.json'), '{"schema":1,"layout":"seat-owned"}');
    if (layout === 'legacy') fs.mkdirSync(path.join(workspace, 'notebook', 'old-topic'));
    if (layout === 'migrating') {
      fs.mkdirSync(path.join(workspace, 'internal', 'notebook-migration'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'internal', 'notebook-migration', 'journal.json'), '{"status":"in-progress"}');
    }
    return workspace;
  };
  try {
    const owned = workspaceIn('owned', 'seat-owned');
    const own = hook(owned, 'Write', { file_path: 'notebook/alpha/topic/page.md', content: 'x' });
    check(own.exit === 0 && own.allowed, `a write under this seat's own Notebook root was not allowed: ${own.reason}`);
    const other = hook(owned, 'Write', { file_path: 'notebook/beta/topic/page.md', content: 'x' });
    check(other.exit === 0 && other.reason.includes("seat 'beta''s Notebook"), `a write into another seat's Notebook was not refused naming it: ${other.reason}`);
    const loose = hook(owned, 'Edit', { file_path: 'notebook/loose.md', old_string: 'a', new_string: 'b' });
    check(loose.reason.includes('directly under notebook/'), `a loose file under notebook/ was not refused: ${loose.reason}`);
    const read = hook(owned, 'Read', { file_path: 'notebook/beta/topic/page.md' });
    check(read.allowed, `a READ of another seat's Notebook was refused, and only writes are this rule's: ${read.reason}`);
    const patched = hook(owned, 'apply_patch', { command: '*** Begin Patch\n*** Add File: notebook/beta/topic/new.md\n+x\n*** End Patch' });
    check(patched.reason.startsWith("This patch writes 'notebook/beta/topic/new.md'.") && patched.reason.includes("seat 'beta''s Notebook"), `a patch into another seat's Notebook was not refused: ${patched.reason}`);

    const legacy = hook(workspaceIn('legacy', 'legacy'), 'Write', { file_path: 'notebook/alpha/topic/page.md', content: 'x' });
    check(legacy.reason.includes('shared layout ADR-0029 retires') && legacy.reason.includes('library migrate'), `a write into a legacy Notebook was not refused naming the migration: ${legacy.reason}`);
    const fresh = hook(workspaceIn('fresh', 'fresh'), 'Write', { file_path: 'notebook/alpha/topic/page.md', content: 'x' });
    check(fresh.reason.includes('not active yet') && fresh.reason.includes('library notebook render --seat alpha'), `a write into a fresh Notebook was not refused naming the activation: ${fresh.reason}`);
    const migrating = hook(workspaceIn('migrating', 'migrating'), 'Write', { file_path: 'notebook/alpha/topic/page.md', content: 'x' });
    check(migrating.reason.includes('migration is in progress'), `a write during a migration was not refused: ${migrating.reason}`);
    check(fs.readdirSync(path.join(root, 'fresh', 'notebook')).length === 0 && !fs.existsSync(path.join(root, 'fresh', 'internal', 'notebook-layout.json')), 'a guard wrote into the workspace it was judging');

    const unreadable = spawnSync(process.execPath, [CLI, 'hook', 'shelf-read', '--workspace', owned], { cwd: PROGRAM_ROOT, env: { ...process.env, ...env }, input: '{not json', encoding: 'utf8' });
    check((unreadable.stdout ?? '').includes('"permissionDecision":"deny"') && unreadable.status === 0, 'a payload the guard could not parse was not denied');
    const noGuard = runCli(['hook', 'no-such-guard']);
    check(noGuard.exit !== 0 && noGuard.stderr.includes('shelf-read or shell-shelf-read'), 'a hook call naming no guard was not refused by name');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 12. THE BASIC MEMORY GUARD, WHERE NO ROW REACHES (S32) ------------------------------------------------

// The fourteen `basic-memory` rows hold `library hook basic-memory-read` to the PowerShell guard on each
// branch. What they cannot hold, pinned here against answers MEASURED from the oracle on 2026-09-22:
// .NET's `$` also matches before a final newline, so a trailing newline is admitted wherever the path
// stays inside an open Book or Project and denied everywhere else; a missing property is StrictMode's
// own sentence; and the oracle WRITES an empty `.open-projects` when the Desk has none.
if (selected(12)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-bm-guard-'));
  const pin = '00000000-0000-0000-0000-000000000000';
  const workspace = path.join(root, 'ws');
  const desk = path.join(workspace, '.claude', 'seats', 'alpha');
  fs.mkdirSync(desk, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude', '.library-project'), pin + '\n');
  fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/curated\nbooks/demo\n');
  const hook = (tool: string, input: unknown, cwd = PROGRAM_ROOT, args = ['--workspace', workspace]) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', 'basic-memory-read', ...args, '--seat', 'alpha'], {
      cwd,
      env: { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_WORKSPACES: path.join(root, 'registry') },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }),
      encoding: 'utf8',
    });
    const stdout = (result.stdout ?? '').trim();
    const reason = stdout ? String((JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason) : '';
    return { exit: result.status ?? -1, allowed: stdout === '', reason };
  };
  const list = (dir: unknown) => hook('mcp__basic-memory__list_directory', { project_id: pin, dir_name: dir });
  try {
    const first = list('books/demo/wiki');
    check(first.exit === 0 && first.allowed, `a listing inside an open shared Book was not allowed: ${first.reason}`);
    check(fs.existsSync(path.join(desk, '.open-projects')) && fs.readFileSync(path.join(desk, '.open-projects'), 'utf8') === '', 'the guard did not write the empty .open-projects the oracle writes');

    check(list('books/demo/wiki\n').allowed, 'a trailing newline inside an open Book was denied, and the oracle admits it');
    check(list('books/demo\n').reason.startsWith('That Book or Project is closed'), 'a trailing newline on the Book root itself was not denied as the oracle denies it');
    check(list('books/demo/..\n').reason === 'Virtual Desk requires a canonical directory path.', 'a trailing newline hid a .. segment');
    const write = (input: Record<string, unknown>) => hook('mcp__basic-memory__write_note', { project_id: pin, ...input });
    fs.writeFileSync(path.join(desk, '.open-projects'), 'projects/demo\n');
    check(write({ directory: 'projects/demo/notes\n', title: 'x' }).allowed, 'a trailing newline on an open Hub directory was denied, and the oracle admits it');
    check(write({ directory: 'projects/demo/notes', title: 'x\n' }).allowed, 'a trailing newline on a title was denied, and the oracle admits it');

    const missing = hook('mcp__basic-memory__list_directory', { project_id: pin });
    check(missing.reason === "Virtual Desk failed closed: The property 'dir_name' cannot be found on this object. Verify that the property exists.", `a missing dir_name was not refused in StrictMode's words: ${missing.reason}`);
    const noInput = hook('mcp__basic-memory__list_directory', null);
    check(noInput.reason.includes("The property 'project_id' cannot be found"), `a null tool_input was not refused as the oracle refuses it: ${noInput.reason}`);
    const blank = hook('mcp__basic-memory__list_directory', { project_id: pin, project: '  ', dir_name: 'books' });
    check(blank.allowed, `a blank project name was treated as routing: ${blank.reason}`);

    fs.writeFileSync(path.join(desk, '.open-books'), 'books/demo\nbooks/demo\n');
    check(list('books').reason === 'Virtual Desk failed closed: Virtual Desk open-book state contains duplicates.', 'a Desk naming one Book twice was not refused');
    fs.writeFileSync(path.join(desk, '.open-books'), 'Books/Demo\n');
    check(list('books').reason === 'Virtual Desk failed closed: Virtual Desk open-book state is malformed.', 'a capitalised Desk line was accepted');

    const nowhere = fs.mkdtempSync(path.join(root, 'nowhere-'));
    const seatless = hook('mcp__basic-memory__list_directory', { project_id: pin, dir_name: 'books' }, nowhere, []);
    check(seatless.reason.includes('in no Library workspace'), `a session in no workspace was not refused: ${seatless.reason}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 13. THE HUB EDIT, THE FENCE AND THE WIRE, WHERE NO ROW REACHES (S34) ----------------------------------

// Two `hub` rows hold `library hub edit` to Edit-ProjectHub.ps1 against the NAS, on one preflight and one
// AddSection. What they cannot hold: (a) the text rules on every other mode, pinned against answers
// MEASURED from the oracle's own functions on 2026-09-22 (extracted from the script by AST and run over the
// same inputs -- 25 of 25 identical); (b) the local collection, which the oracle has no half of; (c) the
// ownership fence on all four new shared writers, which refuses before anything is read over the network;
// and (d) that a result's non-ASCII value reaches stdout as ASCII escapes.
if (selected(13)) {
  const { newProjectBody } = await import('../src/hubedit.ts');
  const hubBody =
    '# Acceptance\n\n## Purpose\n\nDescribe what this project is for.\n\n## Now\n\nWhere this project stands.\n\n## Next\n\n- [ ] Add the next useful action.\n';
  equal(
    newProjectBody(hubBody, 'AddSection', '2026-09-22', 'One dated entry.', '', false),
    hubBody + '\n## 2026-09-22\n\nOne dated entry.\n',
    'AddSection did not append the section as the oracle does',
  );
  const wrapped = '# W\n\n## Next\n\n- [ ] A short action\n- [ ] **A long action.** This wraps,\n  onto a continuation line.\n';
  equal(
    newProjectBody(wrapped, 'AppendSection', 'Next', '- [x] Appended', '', false),
    '# W\n\n## Next\n\n- [ ] A short action\n- [ ] **A long action.** This wraps,\n  onto a continuation line.\n- [x] Appended\n',
    'a bullet appended after a wrapped item did not join the list',
  );
  equal(
    newProjectBody('# C\r\n\r\n## Now\r\n\r\n- [ ] one\r\n\r\n## Next\r\n\r\n- [x] two\r\n', 'CheckItem', '', '', 'two', true),
    '# C\n\n## Now\n\n- [ ] one\n\n## Next\n\n- [ ] two\n',
    'CheckItem -Uncheck over CRLF did not answer as the oracle answers',
  );
  const refusal = (body: string, mode: string, section: string, content: string, match: string): string => {
    try {
      newProjectBody(body, mode as never, section, content, match, false);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };
  equal(refusal(hubBody, 'AppendSection', 'Now', '- Still open.', ''), "Every column-zero list entry in 'Now' requires a status marker; add - [ ] or - [x].", 'an unmarked Now entry was not refused in the oracle\'s words');
  equal(refusal('# D\n\n## Now\n\na\n\n## Now\n\nb\n', 'AppendSection', 'Now', 'x', ''), "Section 'Now' appears more than once on this page; edit it by hand or name a unique section.", 'a duplicated section was not refused');
  equal(refusal(hubBody, 'RemoveSection', 'Now', '', ''), "Section 'Now' is structural and cannot be removed.", 'a structural section was removable');
  equal(refusal(wrapped, 'CheckItem', 'Next', '', 'action'), "'action' matches 2 items; give text unique to one. Matches begin: - [ ] A short action | - [ ] **A long action.** This wraps,", 'an ambiguous match was not refused with its preview');

  // (b) and (d): the local collection, through the front door.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-hub-edit-'));
  const localEnv = { LIBRARY_SEAT: 'alpha', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
  const run = (args: string[], env: Record<string, string> = localEnv) => runCli(args, { env });
  try {
    const workspace = path.join(root, 'ws');
    equal(run(['init', workspace, '--registry-root', path.join(root, 'reg')]).exit, 0, 'init for the hub edit failed');
    equal(run(['hub', 'new', 'demo', '--title', 'Demo — Hub', '--workspace', workspace]).exit, 0, 'hub new for the hub edit failed');
    const page = path.join(workspace, 'collection', 'projects', 'demo', '_project.md');
    const edit = (extra: string[]) => run(['hub', 'edit', 'demo', '--workspace', workspace, ...extra]);
    const closed = edit(['--mode', 'add-section', '--section', 'Log', '--content', 'x']);
    check(closed.exit !== 0 && closed.stderr.includes("Project 'demo' is not open."), `an edit of a Hub not open at this seat was not refused: ${closed.stderr}`);
    fs.mkdirSync(path.join(workspace, '.claude', 'seats', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.claude', 'seats', 'alpha', '.open-projects'), 'projects/demo\n');
    const before = fs.readFileSync(page, 'utf8');
    const added = edit(['--mode', 'add-section', '--section', 'Log', '--content', 'An entry — dated.', '--json']);
    equal(added.exit, 0, `a local AddSection exited ${added.exit}: ${added.stderr}`);
    equal(fs.readFileSync(page, 'utf8'), before + '\n## Log\n\nAn entry — dated.\n', 'a local AddSection did not write the page the text rules give');
    const journals = fs.readdirSync(path.join(workspace, 'internal', 'publication-journals'));
    check(journals.length === 1 && /^project-edit-demo-project-\d{8}-\d{6}-[0-9a-f]{8}\.json$/.test(journals[0]!), `the edit left no journal named as the oracle names one: ${journals.join(', ')}`);
    const hubResult = run(['hub', 'new', 'wire', '--title', 'Wire — Test', '--workspace', workspace, '--preflight', '--json']);
    check(![...Buffer.from(hubResult.stdout, 'utf8')].some((byte) => byte > 127), 'a result carrying U+2014 put non-ASCII bytes on stdout');
    check(hubResult.stdout.includes('\\u2014'), 'a result carrying U+2014 did not escape it');
    const gated = edit(['--mode', 'replace-section', '--section', 'Log', '--content', 'Rewritten.']);
    check(gated.exit !== 0 && gated.stderr.includes('ReplaceSection removes existing text and is not yet performed'), 'a gated mode wrote without confirmation');
    const plan = JSON.parse(edit(['--mode', 'replace-section', '--section', 'Log', '--content', 'Rewritten.', '--preflight']).stdout) as { plan_id: string; section_before: string };
    equal(plan.section_before, '## Log\n\nAn entry — dated.', 'the preflight did not return section_before');
    const stale = edit(['--mode', 'replace-section', '--section', 'Log', '--content', 'Rewritten.', '--user-confirmed', '--plan-id', 'project-edit-0']);
    check(stale.exit !== 0 && stale.stderr.includes('pass its exact plan_id'), 'a gated mode ran under the wrong plan id');
    equal(edit(['--mode', 'replace-section', '--section', 'Log', '--content', 'Rewritten.', '--user-confirmed', '--plan-id', plan.plan_id]).exit, 0, 'the confirmed ReplaceSection did not run');
    check(fs.readFileSync(page, 'utf8').endsWith('## Log\n\nRewritten.\n'), 'the confirmed ReplaceSection did not write its section');
    const same = JSON.parse(edit(['--mode', 'replace-section', '--section', 'Log', '--content', 'Rewritten.', '--user-confirmed', '--plan-id', 'x']).stdout) as { unchanged: boolean; written: boolean };
    check(same.unchanged === true && same.written === false, 'an edit changing nothing was not reported unchanged');

    // (c) the fence: a collection whose writable role another workspace holds. Nothing listens at the
    // endpoint, so a verb that got past the fence would fail on the network instead of refusing here.
    const share = path.join(root, 'share');
    for (const catalog of ['books', 'projects']) {
      fs.mkdirSync(path.join(share, catalog), { recursive: true });
      fs.writeFileSync(path.join(share, catalog, 'README.md'), '# Catalog\n');
    }
    fs.mkdirSync(path.join(share, '.owner'));
    fs.writeFileSync(
      path.join(share, '.owner', '0001.claim.json'),
      JSON.stringify({ schema: '1', incarnation: 1, workspace_id: '11111111-1111-4111-8111-111111111111', machine: 'elsewhere' }),
    );
    const fenced = { ...localEnv, AI_LIBRARY_MCP_URL: 'http://127.0.0.1:9/mcp', AI_LIBRARY_PROJECT_ID: '22222222-2222-4222-8222-222222222222', LIBRARY_SHARED_COLLECTION_ROOT: share };
    const marker = path.join(workspace, '.library', 'workspace.json');
    const markerText = fs.readFileSync(marker, 'utf8');
    fs.writeFileSync(marker, markerText.replace('"backend":  "local"', '"backend":  "basic-memory"'));
    for (const [args, operation] of [
      [['hub', 'edit', 'demo', '--mode', 'add-section', '--section', 'X', '--content', 'y'], 'editing a Project Hub'],
      [['hub', 'archive', 'demo', '--preflight'], 'archiving a Project Hub'],
      [['hub', 'copy-pages', 'demo', '--source', 'notebook/x', '--title', 'T', '--purpose', 'P', '--preflight'], 'copying local pages to a Project Hub'],
      [['shared', 'archive', 'curated', '--preflight'], 'archiving a shared Book'],
      [['shared', 'list-entry', 'curated', '--preflight'], 'listing a Catalog entry'],
      [['publish', 'curated', '--title', 'T', '--summary', 'S', '--preflight'], 'publishing to the shared collection'],
    ] as [string[], string][]) {
      const answer = run([...args, '--workspace', workspace], fenced);
      check(
        answer.exit !== 0 && answer.stderr.startsWith(`${operation} is refused: workspace 11111111-1111-4111-8111-111111111111 holds the writable role`),
        `library ${args.slice(0, 2).join(' ')} was not refused by the fence: ${answer.stderr.trim()}`,
      );
    }
    fs.writeFileSync(marker, markerText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 14. SORT-OBJECT'S ORDER, AND THE COPY WHERE NO ROW REACHES (S35) ----------------------------------------

// `hub.local-pages-copy-into-a-project` holds the copy preflight, and the harness normalises its digests and
// `plan_id` -- so the ORDER the records are hashed in is invisible to the row. Every list below is the order
// Windows PowerShell 5.1's `Sort-Object` gave, measured on 2026-09-23 under en-US; until S35 `psSortCompare`
// broke a hyphen tie ordinally and reversed the second and third lists.
if (selected(14)) {
  const { psSortCompare } = await import('../src/notebook.ts');
  const B = String.fromCharCode(92);
  const measured: string[][] = [
    ['abc', 'ab-c', 'a-bc', 'a-b-c'],
    ['abcd', 'abc-d', 'ab-cd', 'ab-c-d', 'a-bcd', 'a-bc-d', 'a-b-cd'],
    ['its', "it's", 'it-s'],
    ['/_index.md', '/~x.md', '/10.md', '/9.md', '/a b.md', '/a.b.md', '/A.md', '/a_b.md', '/ab.md', '/ab-.md', '/a-b.md', '/B.md', '/sub/_index.md', '/sub/x.md', '/Sub2/q.md', '/sub-x.md', '/sub-x/y.md', '/z.MD'].map(
      (entry) => entry.split('/').join(B),
    ),
  ];
  for (const order of measured) {
    equal([...order].reverse().sort(psSortCompare).join(' | '), order.join(' | '), 'psSortCompare did not give the order Sort-Object gave');
  }
  const symbols = [...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~0a'].map((ch) => `x${ch}y`).sort(psSortCompare).map((entry) => entry.charAt(1)).join('');
  equal(symbols, ' !"#$%&()*,./:;?@[\\]^_`{|}~+<=>0a\'-', 'psSortCompare did not weigh punctuation as Sort-Object does');

  // THE READER-MAP LABEL a published Book's `_index` carries, hashed into its manifest digest and so
  // invisible to the rows. Each expectation is what `Get-ReaderMapLabel` answered for the same input,
  // measured on 2026-09-23 by dot-sourcing ShelfNoteCommon.ps1.
  const { readerMapLabel } = await import('../src/publish.ts');
  const long = 'Long title words '.repeat(25);
  const labels: [string, string, string][] = [
    ['Intro.\n\n```\n# Not the title\n```\n\n# Real Title ###\n', 'fence.md', 'Real Title'],
    ['# Zero​width é  spaced\r\n\r\nBody.\r\n', 'crlf.md', 'Zero width é spaced'],
    [`# ${long}\n`, 'long.md', long.trim().substring(0, 300).trimEnd() + '...'],
    ['Just prose.\n', 'notitle.md', 'notitle'],
    ['## Only an H2\n', 'sub/deep.md', 'sub/deep'],
    ['﻿---\ntitle: x\n---\n# After BOM frontmatter\n', 'bom.md', 'After BOM frontmatter'],
    ['   # Indented three\n', 'indent.md', 'Indented three'],
    ['    # Indented four\n', 'four.md', 'four'],
    ['# Tab\tinside\r# not a line\n', 'cr.md', 'Tab inside # not a line'],
    ['~~~\n# In tilde fence\n~~~\n#   \n# ###\n', 'tilde.md', '#'],
  ];
  for (const [text, page, expected] of labels) equal(readerMapLabel(text, page), expected, `the reader-map label of ${page} was not the oracle's`);

  // A local collection is refused by name, before any fence or read: the oracle has no local half.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-hub-copy-'));
  try {
    const workspace = path.join(root, 'ws');
    const env = { LIBRARY_SEAT: 'alpha', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    equal(runCli(['init', workspace, '--registry-root', path.join(root, 'reg')], { env }).exit, 0, 'init for the hub copy failed');
    const local = runCli(['hub', 'copy-pages', 'demo', '--source', 'notebook/x', '--title', 'T', '--purpose', 'P', '--preflight', '--workspace', workspace], { env });
    check(local.exit !== 0 && local.stderr.includes('ported against Basic Memory only'), `a local copy was not refused by name: ${local.stderr.trim()}`);
    const bare = runCli(['hub', 'copy-pages', 'demo', '--title', 'T', '--purpose', 'P', '--workspace', workspace], { env });
    check(bare.exit !== 0 && bare.stderr.includes('needs --source'), `a copy with no source was not refused: ${bare.stderr.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 15. THE RESOLVER'S ANCHOR AND ITS REGISTRY REFUSALS (S36) ------------------------------------------------

// Four `guards` rows hold the selection refusals and the cross-workspace rule. The ANCHOR no row reaches --
// every program root a row runs from carries no marker -- so it is held here, case for case with
// WorkspaceRegistry.ps1's own self-test (5)-(7) and (9)-(13), including the COPIED marker a plugin install
// really produced on 2026-09-20.
if (selected(15)) {
  const { isWorkspaceAnchor, resolveWorkspace } = await import('../src/workspace.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-anchor-'));
  const marker = (dir: string, text: string): void => {
    fs.mkdirSync(path.join(dir, '.library'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.library', 'workspace.json'), text, 'utf8');
  };
  const registry = (name: string, rows: { id: string; path: string }[]): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ workspaces: rows }), 'utf8');
    return dir;
  };
  try {
    const loose = path.join(root, 'nowhere');
    const program = path.join(root, 'program-not-a-workspace');
    const initialised = path.join(root, 'initialised');
    const copied = path.join(root, 'plugin-cache-copy');
    const beta = path.join(root, 'beta');
    const gamma = path.join(root, 'gamma');
    for (const dir of [loose, path.join(program, 'tools'), gamma]) fs.mkdirSync(dir, { recursive: true });
    const id = '11111111-1111-1111-1111-111111111111';
    marker(initialised, JSON.stringify({ id }));
    marker(copied, JSON.stringify({ id }));
    marker(beta, '{"id":"x"}');
    const empty = path.join(root, 'empty-reg');
    fs.mkdirSync(empty);
    const copyReg = registry('copy-reg', [{ id, path: initialised }]);
    const reg = registry('reg', [{ id: 'beta', path: beta }, { id: 'gamma', path: gamma }]);
    const resolve = (options: Record<string, string>) =>
      resolveWorkspace({ environmentWorkspace: '', startDirectory: loose, anchor: '', ...options });

    check(!isWorkspaceAnchor(program, empty), 'a program root with no marker was accepted as an anchor');
    check(!isWorkspaceAnchor(loose, empty), 'a bare directory was accepted as an anchor');
    check(isWorkspaceAnchor(initialised, empty), 'a workspace with a marker was refused as an anchor');
    check(isWorkspaceAnchor(initialised, copyReg), 'the workspace the registry names was refused as an anchor');
    check(!isWorkspaceAnchor(copied, copyReg), 'a COPY of a registered marker was accepted as an anchor');
    check(isWorkspaceAnchor(copied, empty), 'a marker the registry has never seen was refused as an anchor');
    const fromAnchor = resolve({ anchor: initialised, registryRoot: empty });
    check(fromAnchor.kind === 'resolved' && fromAnchor.source === 'anchor', `an initialised anchor resolved ${fromAnchor.kind} from ${fromAnchor.source}`);
    equal(resolve({ anchor: copied, registryRoot: copyReg }).kind, 'none', 'an anchor on a copied marker did not resolve none');
    equal(resolve({ anchor: program, registryRoot: empty }).kind, 'none', 'an anchor on a marker-less program root did not resolve none');
    equal(resolve({ explicit: initialised, anchor: copied, registryRoot: empty }).source, 'explicit', 'the anchor outranked an explicit selection');

    equal(resolve({ explicit: initialised, startDirectory: beta, registryRoot: reg }).kind, 'resolved', 'an unregistered selection from another cwd was refused');
    const clash = resolve({ explicit: beta, registryRoot: reg });
    check(clash.kind === 'conflict' && (clash.reason ?? '').includes("calls it 'x'") && (clash.reason ?? '').includes("registers that same path as 'beta'"), `an id clash resolved ${clash.kind}: ${clash.reason}`);
    const inside = resolve({ explicit: path.join(beta, 'shelf'), startDirectory: initialised, registryRoot: reg });
    check(inside.kind === 'conflict' && (inside.reason ?? '').includes(initialised) && (inside.reason ?? '').includes('workspaces.json'), `a selection inside a registered root resolved ${inside.kind}: ${inside.reason}`);
    const gone = resolve({ explicit: gamma, registryRoot: reg });
    check(gone.kind === 'conflict' && (gone.reason ?? '').includes('marker'), `a registered root with no marker resolved ${gone.kind}: ${gone.reason}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 16. THE SETTINGS GUARD, WHERE NO ROW REACHES (S36) ------------------------------------------------------

// Nine `guards.settings-*` rows hold the decisions. What they cannot: a syntax error's refusal (its sentence
// is this engine's, not .NET's, so no row compares it), a BOM, and FAILING OPEN -- the one guard that must.
if (selected(16)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-settings-'));
  const hook = (stdin: string) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', 'settings-integrity', '--state-directory', root], { input: stdin, encoding: 'utf8', env: { ...process.env, LIBRARY_WORKSPACE: '' } });
    return { exit: result.status ?? -1, stdout: (result.stdout ?? '').trim() };
  };
  const payload = JSON.stringify({ hook_event_name: 'ConfigChange', source: 'project_settings' });
  try {
    fs.writeFileSync(path.join(root, 'settings.json'), '{ "hooks": ', 'utf8');
    const broken = hook(payload);
    check(broken.exit === 0 && broken.stdout.includes('"permissionDecision":"deny"') && broken.stdout.includes('settings.json is no longer valid JSON'), `a settings file that does not parse was not refused: ${broken.stdout}`);
    fs.writeFileSync(path.join(root, 'settings.json'), '﻿{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"Guard-BasicMemoryRead.ps1 Guard-ShelfBookRead.ps1 Guard-ShellShelfRead.ps1"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"Get-VirtualDeskContext.ps1"}]}]}}', 'utf8');
    const bom = hook(payload);
    check(bom.exit === 0 && bom.stdout.includes('Settings accepted'), `a settings file with a BOM was not read as ReadAllText reads it: ${bom.stdout}`);
    const open = hook('{ not a payload');
    check(open.exit === 0 && open.stdout === '', `a payload the guard could not read did not fail OPEN: ${open.stdout}`);
    fs.rmSync(path.join(root, 'settings.json'));
    const none = hook(payload);
    check(none.stdout.includes('no settings file'), `a .claude/ with no settings file was not refused: ${none.stdout}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 17. MCP SERVE, WHERE ONLY A LONG-RUNNING PROCESS REACHES (S36) --------------------------------------------

// Eight `reader.serve-*` rows each send one request. What none can: a workspace re-initialised UNDER a server
// already answering for it, which must refuse the next call rather than answer for the new identity, and the
// launch warning a server owes on stderr when the guards are not registered where it was started.
if (selected(17)) {
  const { spawn } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-serve-'));
  try {
    const workspace = path.join(root, 'ws');
    const env = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    equal(runCli(['init', workspace, '--registry-root', path.join(root, 'reg')], { env }).exit, 0, 'init for mcp serve failed');
    fs.rmSync(path.join(workspace, '.claude', 'settings.local.json'), { force: true });
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve', '--workspace', workspace], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const lines = async (count: number): Promise<string[]> => {
      for (let waited = 0; stdout.split('\n').filter(Boolean).length < count && waited < 15000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      return stdout.split('\n').filter(Boolean);
    };
    const request = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_book_catalog', arguments: { location: 'shelf' } } }) + '\n';
    child.stdin.write(request(1));
    const first = await lines(1);
    check(first.length === 1 && !first[0]!.includes('re-initialised'), `the first call through mcp serve did not answer: ${first.join(' | ')}`);
    const marker = path.join(workspace, '.library', 'workspace.json');
    fs.writeFileSync(marker, JSON.stringify({ ...(JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>), id: 'reinitialised-under-the-server' }), 'utf8');
    child.stdin.write(request(2));
    const second = await lines(2);
    check(second.length === 2 && second[1]!.includes('has been re-initialised since this reader started') && second[1]!.includes('"isError":true'), `a workspace re-initialised under mcp serve was answered for: ${second[1] ?? '(nothing)'}`);
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    check(stderr.includes('LIBRARY GUARD WARNING') && stderr.includes('guard hook not registered: Guard-BasicMemoryRead.ps1'), `mcp serve launched with no guards registered said nothing on stderr: ${stderr.trim()}`);
    check(!stdout.includes('LIBRARY GUARD WARNING'), 'the launch warning reached stdout, where it breaks the protocol');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 18. THE DESK HOOK NAMES THE READER THE HARNESS EXPOSES (S37) ------------------------------------------------

// The eight `guards.desk-context-*` rows hold the default, the name a workspace's own `.mcp.json` gives the
// reader. What none can: the name under the PLUGIN, which the harness composes (measured in S37 as
// `mcp__plugin_<plugin>_<server>__` in Claude Code and as the server's hyphens turned to underscores in
// Codex), and which the plugin's hook passes as `--reader-tool-prefix`. A prefix that names no tool must say
// so rather than be advertised.
if (selected(18)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-deskprefix-'));
  try {
    const workspace = path.join(root, 'ws');
    const env = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    equal(runCli(['init', workspace, '--registry-root', path.join(root, 'reg')], { env }).exit, 0, 'init for the desk prefix failed');
    fs.mkdirSync(path.join(workspace, '.claude', 'seats', 'reader'), { recursive: true });
    for (const file of ['.open-books', '.open-projects']) fs.writeFileSync(path.join(workspace, '.claude', 'seats', 'reader', file), '', 'utf8');
    const context = (extra: string[]) => {
      const result = spawnSync(process.execPath, [CLI, 'hook', 'desk-context', '--workspace', workspace, '--seat', 'reader', '--agent-pid', '0', ...extra], { input: '{"session_id":"s"}', encoding: 'utf8', env });
      return (result.stdout ?? '').trim();
    };
    const plain = context([]);
    check(plain.includes('call mcp__validated-book-reader__read_book_catalog or mcp__validated-book-reader__read_project_catalog'), `the default reader name changed: ${plain}`);
    const plugin = context(['--reader-tool-prefix', 'mcp__plugin_deskpost_validated-book-reader__']);
    check(plugin.includes('call mcp__plugin_deskpost_validated-book-reader__read_book_catalog or mcp__plugin_deskpost_validated-book-reader__read_project_catalog') && !plugin.includes(' mcp__validated-book-reader__'), `the plugin prefix was not the name advertised: ${plugin}`);
    const bogus = context(['--reader-tool-prefix', 'read_']);
    check(bogus.includes("Virtual Desk unavailable: the reader tool prefix 'read_' is not an MCP tool prefix") && !bogus.includes('read_book_catalog'), `a prefix naming no tool was advertised: ${bogus}`);
    // .NET's `$` matches before a final newline and the oracle's `\z` does not; neither may this.
    const newline = context(['--reader-tool-prefix', 'mcp__validated-book-reader__\n']);
    check(newline.includes('is not an MCP tool prefix') && !newline.includes('read_book_catalog'), `a prefix ending in a newline was advertised: ${newline}`);
    // S38: THE CODEX BINDINGS `init` WROTE hand three hooks Codex's name for the reader, and the Basic
    // Memory guard a matcher that fires on Codex's name for Basic Memory. Asked of the file, not the code.
    const codexHooks = JSON.parse(fs.readFileSync(path.join(workspace, '.codex', 'hooks.json'), 'utf8'));
    const codexCommands: string[] = [];
    for (const blocks of Object.values(codexHooks.hooks) as { hooks: { command: string }[] }[][]) for (const block of blocks) for (const hook of block.hooks) codexCommands.push(hook.command);
    // Either spelling: a guard script's `-ReaderToolPrefix`, or a compiled kernel's own verb and `--reader-tool-prefix`
    // (S48, ADR-0046: a compiled Windows init registers the kernel's hooks, as POSIX always has).
    const isBasicMemoryGuard = (command: string) => command.includes('Guard-BasicMemoryRead.ps1') || / hook basic-memory-read( |$)/.test(command);
    const prefixed = codexCommands.filter((command) => / (-ReaderToolPrefix|--reader-tool-prefix) mcp__validated_book_reader__$/.test(command));
    check(prefixed.length === 3 && prefixed.every((command) => !isBasicMemoryGuard(command)), `init's Codex hooks do not hand the three reader-naming hooks Codex's prefix: ${codexCommands.join(' | ')}`);
    // S38 refused suggest_active_projects over the LOCAL collection, which has no oracle; S46 (ADR-0044) answers
    // it there, because that refusal was the default route's. With no Hubs it says so, and asks Basic Memory nothing.
    const marker = JSON.parse(fs.readFileSync(path.join(workspace, '.library', 'workspace.json'), 'utf8').replace(/^﻿/, ''));
    const suggest = runCli(['mcp', 'call', 'suggest_active_projects', '--query', 'kernel', '--workspace', workspace, '--seat', 'reader'], { env });
    check(marker.backend === 'local' && suggest.stdout.includes('There are no active Projects to search.'), `suggest_active_projects did not answer over the local collection: ${suggest.stdout}${suggest.stderr}`);
    const bmMatcher = String(codexHooks.hooks.PreToolUse.find((block: { hooks: { command: string }[] }) => block.hooks.some((hook) => isBasicMemoryGuard(hook.command)))?.matcher);
    check(new RegExp(bmMatcher).test('mcp__basic_memory__list_directory'), `init's Codex Basic Memory matcher cannot fire on Codex's spelling: ${bmMatcher}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 19. A POSIX WORKSPACE ROOT (S42, the reader's ruling) ---------------------------------------------------

// On macOS and Linux a workspace root is an absolute `/` path, resolved by path.posix. A leading `//` (which
// POSIX leaves to the implementation), a NUL and -- in a ROOT -- a backslash are refused: the guards read a
// backslash as a separator, so a root spelled with one could not be judged by prefix. Every comparison stays
// case-insensitive, as on Windows, so a guard errs toward denying. NO POWERSHELL ORACLE RUNS THERE, so this
// section is the POSIX branch's only judge. Its first half calls the pure functions with the platform named
// and runs on every host; its second half drives the front door and runs only on a POSIX host, which S42's
// judge is: this file compiled for Linux, run in a clean distro against the release binary.
if (selected(19)) {
  const { workspaceRelative } = await import('../src/guards.ts');
  equal(toWorkspaceRoot('/srv/ws', 'posix'), '/srv/ws', 'an absolute POSIX root was not accepted');
  equal(toWorkspaceRoot('/srv/ws/', 'posix'), '/srv/ws', 'a trailing slash was not trimmed from a POSIX root');
  equal(toWorkspaceRoot('/srv/./a/../ws', 'posix'), '/srv/ws', 'a POSIX root was not normalised');
  equal(toWorkspaceRoot('/', 'posix'), '/', 'the POSIX root directory was trimmed away');
  equal(toWorkspaceRoot('//srv/ws', 'posix'), null, "a POSIX root with a leading '//' was accepted");
  equal(toWorkspaceRoot('/srv/a\\b', 'posix'), null, 'a POSIX root with a backslash was accepted');
  equal(toWorkspaceRoot('/srv/a\u0000b', 'posix'), null, 'a POSIX root with a NUL was accepted');
  equal(toWorkspaceRoot('C:\\x\\', 'win32'), 'C:\\x', 'the Windows root form changed');

  const place = (target: string) => workspaceRelative(target, '/srv/ws', 'posix');
  const inside = (target: string, relative: string) => {
    const placed = place(target);
    check(placed.kind === 'inside' && placed.relative === relative, `'${target}' placed ${placed.kind} '${placed.relative}', not inside '${relative}'`);
  };
  inside('/srv/ws/shelf/alpha/p.md', 'shelf/alpha/p.md');
  inside('shelf/alpha/p.md', 'shelf/alpha/p.md');
  inside('/srv/WS/Shelf/Alpha/p.md', 'Shelf/Alpha/p.md');
  inside('/srv/ws/notes/../shelf/alpha/p.md', 'shelf/alpha/p.md');
  inside('/srv/ws//shelf///alpha/p.md', 'shelf/alpha/p.md');
  inside('shelf\\alpha\\p.md', 'shelf/alpha/p.md');
  inside('../ws/shelf/alpha/p.md', 'shelf/alpha/p.md');
  inside('/srv/ws', '');
  equal(place('/srv/other/x.md').kind, 'outside', 'a path in another directory was not outside');
  equal(place('/srv/wsx/shelf/alpha/p.md').kind, 'outside', 'a sibling sharing the root as a prefix was not outside');
  equal(place('//srv/ws/shelf/alpha/p.md').kind, 'invalid', "a path with a leading '//' was not invalid");
  equal(place('\\\\srv\\ws\\shelf\\alpha').kind, 'invalid', 'a UNC-shaped path was not invalid on POSIX');
  equal(place('/srv/ws/shelf/alpha\u0000/p.md').kind, 'invalid', 'a path with a NUL was not invalid');
  const windows = workspaceRelative('C:\\ws\\shelf\\alpha', 'C:\\ws', 'win32');
  check(windows.kind === 'inside' && windows.relative === 'shelf/alpha', `the Windows placement changed: ${windows.kind} '${windows.relative}'`);
  equal(workspaceRelative('/srv/ws/x', 'C:\\ws', 'win32').kind, 'invalid', 'a POSIX path was placed on Windows');

  if (process.platform !== 'win32') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-posix-')));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', HOME: home, AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
      const cli = (args: string[], input?: string) => runCli(args, { cwd: root, env, ...(input !== undefined ? { input } : {}) });
      const workspace = path.join(root, 'ws');
      const other = path.join(root, 'other');
      const init = cli(['init', workspace]);
      equal(init.exit, 0, `library init refused an absolute POSIX root: ${init.stderr.trim()}`);
      const registry = path.join(home, '.library', 'workspaces.json');
      if (init.exit === 0) {
        const told = JSON.parse(init.stdout) as Record<string, unknown>;
        equal(told['workspace'], workspace, 'init did not report the POSIX root it was given');
        equal(told['registry'], registry, "init did not register under $HOME/.library");
      }
      check(fs.existsSync(registry) && fs.readFileSync(registry, 'utf8').includes(workspace), `the registry under $HOME does not name ${workspace}`);
      check(!fs.existsSync(path.join(root, '.library')), 'the registry was written relative to the working directory');
      const relative = cli(['init', 'ws2']);
      check(relative.exit === 0 && relative.stdout.includes(path.join(root, 'ws2')), `a relative init did not resolve against the working directory: ${relative.stderr.trim()}`);
      equal(cli(['init', other]).exit, 0, 'a second POSIX workspace could not be initialised');
      for (const bad of ['//srv/ws', path.join(root, 'a\\b')]) {
        const refused = cli(['init', bad]);
        check(refused.exit !== 0 && refused.stderr.includes('is not an absolute local path') && refused.stdout.trim() === '', `init did not refuse '${bad}' by the rule: ${refused.exit} ${refused.stderr.trim()}`);
      }
      check(!fs.existsSync(path.join(root, 'a\\b')), 'a refused init created its directory');
      const doctor = cli(['doctor', '--workspace', workspace]);
      const report = (() => { try { return JSON.parse(doctor.stdout) as Record<string, unknown>; } catch { return {}; } })();
      check(report['workspace'] === workspace && Number(report['skipped']) < Number(report['total']), `doctor did not read the POSIX workspace: ${doctor.stdout.slice(0, 300)} ${doctor.stderr.trim()}`);

      const desk = path.join(workspace, '.claude', 'seats', 'reader');
      fs.mkdirSync(desk, { recursive: true });
      fs.writeFileSync(path.join(desk, '.open-books'), 'shelf/alpha\n', 'utf8');
      fs.writeFileSync(path.join(desk, '.open-projects'), '', 'utf8');
      const hook = (verb: string, call: Record<string, unknown>) =>
        cli(['hook', verb, '--workspace', workspace, '--seat', 'reader'], JSON.stringify(call)).stdout;
      const read = (filePath: string) => hook('shelf-read', { tool_name: 'Read', tool_input: { file_path: filePath } });
      const shell = (command: string) => hook('shell-shelf-read', { tool_name: 'Bash', tool_input: { command } });
      const denied = (answer: string, words: string, label: string) =>
        check(answer.includes('"permissionDecision":"deny"') && answer.includes(words), `${label}: ${answer || '(allowed)'}`);
      const allowed = (answer: string, label: string) => check(answer.trim() === '', `${label}: ${answer}`);
      denied(read(path.join(workspace, 'shelf', 'beta', 'p.md')), "Shelf Book 'beta' is closed", 'a closed Book by absolute POSIX path was not denied');
      allowed(read(path.join(workspace, 'shelf', 'alpha', 'p.md')), 'an open Book by absolute POSIX path was denied');
      denied(read('shelf/beta/p.md'), "Shelf Book 'beta' is closed", 'a closed Book by relative path was not denied');
      denied(read(workspace.toUpperCase() + '/SHELF/BETA/p.md'), "Shelf Book 'beta' is closed", 'a closed Book in another case was not denied');
      denied(read(path.join(workspace, 'notes') + '/../shelf/beta/p.md'), "Shelf Book 'beta' is closed", "a closed Book reached through '..' was not denied");
      denied(read('/' + path.join(workspace, 'shelf', 'alpha', 'p.md')), 'an absolute local path', "a path with a leading '//' was not denied as unplaceable");
      allowed(read(path.join(root, 'elsewhere', 'x.md')), 'a path outside every workspace was denied');
      denied(read(path.join(other, 'shelf', 'alpha', 'p.md')), 'which is not this workspace', "another registered POSIX workspace's Shelf was not denied");
      denied(shell('cat ' + path.join(other, 'notebook', 'x.md')), 'which is not this workspace', "a shell command naming another POSIX workspace's Notebook was not denied");
      denied(shell('cat shelf/beta/p.md'), "Shelf Book 'beta' is closed", 'a shell command naming a closed Book was not denied');
      allowed(shell('ls /usr/bin 2>/dev/null'), 'a shell command naming no workspace was denied');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

// --- 20. A FRESH WORKSPACE PASSES ITS OWN CHECKS (S42, the reader's ruling) ------------------------------

// `library init` and then `library doctor` failed three checks in every fresh workspace, on Windows and in a
// clean Linux distro alike. `workspace.init-leaves-a-workspace-its-checks-pass` holds the two arms to the same
// outcome, which two arms that both fail would share; this holds the outcome itself: nothing failed. Through
// the front door, so it judges whichever kernel LIBRARY_SELFTEST_KERNEL names, on whichever host it runs.
if (selected(20)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-freshdoctor-')));
  try {
    const registry = path.join(root, 'reg');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const cli = (args: string[]) => runCli(args, { cwd: root, env });
    const init = (folder: string) => cli(['init', folder, '--registry-root', registry]);
    const actionOf = (result: { stdout: string }, file: string): string => {
      try {
        const files = (JSON.parse(result.stdout) as { files: { file: string; action: string }[] }).files;
        return files.find((entry) => entry.file === file)?.action ?? '(absent)';
      } catch {
        return '(unreadable)';
      }
    };
    const fresh = path.join(root, 'fresh');
    const first = init(fresh);
    equal(first.exit, 0, `init of a fresh folder failed: ${first.stderr.trim()}`);
    for (const slug of ['holding', 'reports']) {
      check(fs.existsSync(path.join(fresh, 'shelf', slug, 'wiki', 'notes')), `a fresh init laid out no capture Book at shelf/${slug}`);
      equal(actionOf(first, `shelf/${slug}`), 'created', `a fresh init did not report shelf/${slug} created`);
    }
    const catalog = fs.existsSync(path.join(fresh, 'shelf', '_catalog.md')) ? fs.readFileSync(path.join(fresh, 'shelf', '_catalog.md'), 'utf8') : '';
    check(/^## Holding Shelf\n(?:- .*\n)*- \*\*Kind:\*\* capture\n(?:- .*\n)*- \*\*Path:\*\* shelf\/holding$/m.test(catalog), 'the rendered catalog does not list the Holding Shelf as a capture Book');
    check(/^- \*\*Path:\*\* shelf\/reports$/m.test(catalog), 'the rendered catalog does not list the Report Inbox');
    const master = path.join(fresh, 'notebook', '_master-index.md');
    check(fs.existsSync(master) && fs.readFileSync(master, 'utf8').startsWith('# '), 'a fresh init wrote no master index');
    const doctor = cli(['doctor', '--workspace', fresh]);
    const report = (() => { try { return JSON.parse(doctor.stdout) as { failed: number; passed: number; checks: { check: string; status: string; detail: string }[] }; } catch { return null; } })();
    check(
      report !== null && report.failed === 0 && report.passed > 0 && doctor.exit === 0,
      `doctor is not green over a freshly initialised workspace (exit ${doctor.exit}): ${report ? report.checks.filter((row) => row.status === 'fail').map((row) => `${row.check}: ${row.detail}`).join(' | ') : doctor.stdout + doctor.stderr}`,
    );
    const second = init(fresh);
    for (const file of ['shelf/holding', 'shelf/reports', 'shelf/_catalog.md', 'notebook/_master-index.md']) equal(actionOf(second, file), 'unchanged', `a second init did not leave ${file} unchanged`);

    const kept = path.join(root, 'kept');
    fs.mkdirSync(path.join(kept, 'shelf', 'holding', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(kept, 'shelf', 'holding', 'wiki', '_book.md'), '# Mine\n');
    fs.writeFileSync(path.join(kept, 'shelf', 'holding', '_catalog-entry.md'), '## Mine\n- **Summary:** mine\n- **Path:** shelf/holding\n');
    const keptRun = init(kept);
    check(keptRun.exit === 0 && fs.readFileSync(path.join(kept, 'shelf', 'holding', 'wiki', '_book.md'), 'utf8') === '# Mine\n' && actionOf(keptRun, 'shelf/holding') === 'unchanged', `init touched a Holding Shelf the workspace already had: ${keptRun.stderr.trim()}`);

    for (const [name, plant, words] of [
      ['husk', ['shelf', 'reports'], 'is a husk rather than a Book'],
      ['unrenderable', ['shelf', 'other', 'wiki'], 'the Shelf cannot be rendered'],
    ] as const) {
      const folder = path.join(root, name);
      fs.mkdirSync(path.join(folder, ...plant), { recursive: true });
      const refused = init(folder);
      check(refused.exit !== 0 && refused.stderr.includes(words), `init over ${name} did not refuse with '${words}': ${refused.exit} ${refused.stderr.trim()}`);
      check(!fs.existsSync(path.join(folder, '.library')) && !fs.existsSync(path.join(folder, 'shelf', 'holding')), `a run refused over ${name} still wrote`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 21. A POSIX WORKSPACE IS BOUND TO THE BINARY (S42, the reader's ruling) ---------------------------------

// On a host with no PowerShell `library init` registers the compiled kernel: every Claude and Codex hook as
// `"<program>/bin/library" hook <verb>` and the reader as `bin/library mcp serve`. What is held here is that
// the registrations START -- the registered hook command run through `sh` denies a closed Book, the
// registered reader answers `tools/list` -- and that doctor now fails a registration this machine cannot
// start, which it passed for every `powershell.exe` one. POSIX only, and nothing runs it anywhere else.
if (selected(21) && process.platform !== 'win32') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-posixbind-')));
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', HOME: home, CODEX_HOME: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const cli = (args: string[], input?: string) => runCli(args, { cwd: root, env, ...(input !== undefined ? { input } : {}) });
    const program = String((JSON.parse(cli(['--version']).stdout) as Record<string, unknown>)['program_root']);
    const binary = path.join(program, 'bin', 'library');
    const workspace = path.join(root, 'ws');
    const init = cli(['init', workspace]);
    equal(init.exit, 0, `init failed on POSIX: ${init.stderr.trim()}`);

    const readJson = (relative: string): Record<string, unknown> => {
      try { return JSON.parse(fs.readFileSync(path.join(workspace, relative), 'utf8')) as Record<string, unknown>; } catch { return {}; }
    };
    const commandsOf = (document: Record<string, unknown>): { event: string; matcher: string; command: string }[] => {
      const out: { event: string; matcher: string; command: string }[] = [];
      const hooks = (document['hooks'] ?? {}) as Record<string, { matcher?: string; hooks: { command: string; args?: unknown }[] }[]>;
      for (const [event, blocks] of Object.entries(hooks)) for (const block of blocks) for (const hook of block.hooks) out.push({ event, matcher: block.matcher ?? '', command: `${hook.command}${hook.args ? ' ' + JSON.stringify(hook.args) : ''}` });
      return out;
    };
    const claude = commandsOf(readJson('.claude/settings.local.json'));
    const prefix = `"${binary}" hook `;
    check(claude.length === 5 && claude.every((row) => row.command.startsWith(prefix)), `init's Claude hooks are not the binary's five: ${claude.map((row) => row.command).join(' | ')}`);
    for (const [verb, event] of [['basic-memory-read', 'PreToolUse'], ['shelf-read', 'PreToolUse'], ['shell-shelf-read', 'PreToolUse'], ['desk-context', 'UserPromptSubmit'], ['settings-integrity', 'ConfigChange']]) {
      check(claude.some((row) => row.event === event && row.command === prefix + verb), `init registered no ${event} '${verb}' for Claude`);
    }
    const reader = ((readJson('.mcp.json')['mcpServers'] ?? {}) as Record<string, { command?: string; args?: string[] }>)['validated-book-reader'];
    check(reader?.command === binary && JSON.stringify(reader?.args) === JSON.stringify(['mcp', 'serve', '--state-directory', path.join(workspace, '.claude')]), `init's reader is not the binary's serve: ${JSON.stringify(reader)}`);
    const codex = commandsOf(readJson('.codex/hooks.json'));
    check(codex.length === 4 && codex.every((row) => row.command.startsWith(prefix)), `init's Codex hooks are not the binary's four: ${codex.map((row) => row.command).join(' | ')}`);
    check(codex.filter((row) => row.command.endsWith(' --reader-tool-prefix mcp__validated_book_reader__')).length === 3, "init's Codex hooks do not hand three of them Codex's reader prefix");
    const toml = fs.existsSync(path.join(workspace, '.codex', 'config.toml')) ? fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8') : '';
    check(toml.includes(`command = "${binary}"`) && toml.includes('args = ["mcp", "serve", "--state-directory"') && !toml.includes('powershell'), `init's Codex reader is not the binary's serve: ${toml.slice(-400)}`);

    // THE REGISTRATIONS START. The shelf guard, exactly as registered, run as Claude runs a hook: through sh.
    const desk = path.join(workspace, '.claude', 'seats', 'reader');
    fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, '.open-books'), '');
    fs.writeFileSync(path.join(desk, '.open-projects'), '');
    const shelfGuard = claude.find((row) => row.command === prefix + 'shelf-read')?.command ?? 'false';
    const ran = spawnSync('sh', ['-c', shelfGuard], {
      cwd: workspace,
      env: { ...process.env, ...env, LIBRARY_SEAT: 'reader' },
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(workspace, 'shelf', 'holding', 'wiki', '_index.md') } }),
      encoding: 'utf8',
    });
    check((ran.stdout ?? '').includes('"permissionDecision":"deny"') && (ran.stdout ?? '').includes("Shelf Book 'holding' is closed"), `the registered shelf guard did not deny a closed Book: ${ran.status} ${ran.stdout} ${ran.stderr}`);
    const served = spawnSync(reader?.command ?? 'false', reader?.args ?? [], {
      cwd: workspace,
      env: { ...process.env, ...env },
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
      encoding: 'utf8',
      timeout: 30000,
    });
    check((served.stdout ?? '').includes('read_book_catalog') && !(served.stderr ?? '').includes('LIBRARY GUARD WARNING'), `the registered reader did not serve, or warned: ${served.status} ${(served.stdout ?? '').slice(0, 200)} ${served.stderr}`);

    const doctor = cli(['doctor', '--workspace', workspace]);
    const rows = (() => { try { return (JSON.parse(doctor.stdout) as { checks: { check: string; status: string; detail: string }[] }).checks; } catch { return []; } })();
    const status = (name: string) => rows.find((row) => row.check === name)?.status ?? '(absent)';
    equal(status('workspace.guards-registered'), 'pass', `doctor did not pass the binary's Claude registrations: ${rows.find((row) => row.check === 'workspace.guards-registered')?.detail}`);
    check(status('workspace.codex-guards-registered') !== 'fail', `doctor failed the binary's Codex registrations: ${rows.find((row) => row.check === 'workspace.codex-guards-registered')?.detail}`);

    // THE FALSE GREEN. A `powershell.exe` registration is what init wrote here until S42.
    const stale = path.join(root, 'stale');
    equal(cli(['init', stale]).exit, 0, 'init of the stale workspace failed');
    const oldBlock = { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'powershell.exe', args: ['-File', path.join(program, '.claude', 'hooks', 'Guard-ShelfBookRead.ps1')] }] }] };
    const local = path.join(stale, '.claude', 'settings.local.json');
    const bound = JSON.parse(fs.readFileSync(local, 'utf8')) as Record<string, unknown>;
    (bound['hooks'] as Record<string, unknown>)['PreToolUse'] = [...((bound['hooks'] as Record<string, unknown[]>)['PreToolUse'] ?? []), ...oldBlock.PreToolUse];
    fs.writeFileSync(local, JSON.stringify(bound));
    const staleDoctor = cli(['doctor', '--workspace', stale]);
    check(staleDoctor.stdout.includes('starts a program this machine does not have') && staleDoctor.stdout.includes('powershell.exe'), `doctor passed a powershell.exe hook on POSIX: ${staleDoctor.stdout.slice(0, 600)}`);
    // AND A RE-RUN REPLACES IT: the old block points into this program, so it is the Library's.
    fs.writeFileSync(local, JSON.stringify({ hooks: oldBlock }));
    const rerun = cli(['init', stale]);
    check(rerun.exit === 0 && !fs.readFileSync(local, 'utf8').includes('powershell.exe'), `init over its own old powershell.exe block did not replace it: ${rerun.exit} ${rerun.stderr.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 22. A WORKSPACE GUARDED BY THE PLUGIN IS GUARDED (S42) --------------------------------------------------

// `checks.a-plugin-only-workspace-reads-as-guarded` holds the two arms to one answer. This holds the answer:
// doctor passes a workspace whose guards come only from the enabled plugin, a workspace's own settings can
// switch the plugin off for it, both at once is warned as every guard twice, the launch warning is silent,
// and a verb is matched on its word boundary -- `hook shell-shelf-read` is not `shelf-read`.
if (selected(22)) {
  const { namesHook, hookRegistrationProblems } = await import('../src/hookregistry.ts');
  const { launchSettingsFaults } = await import('../src/mcpserve.ts');
  check(namesHook('"C:/p/bin/library" hook shelf-read', 'Guard-ShelfBookRead.ps1'), 'the binary spelling of the shelf guard was not recognised');
  check(!namesHook('"C:/p/bin/library" hook shell-shelf-read', 'Guard-ShelfBookRead.ps1'), "'hook shell-shelf-read' was read as the shelf guard");
  check(!namesHook('"C:/p/bin/library" hook shelf-reader', 'Guard-ShelfBookRead.ps1'), "'hook shelf-reader' was read as the shelf guard");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-plugin-')));
  try {
    const registry = path.join(root, 'reg');
    const config = path.join(root, 'claude-config');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', CLAUDE_CONFIG_DIR: config, AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const workspace = path.join(root, 'ws');
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'init for the plugin workspace failed');
    const install = path.join(root, 'plugin-install');
    fs.mkdirSync(path.join(install, '.claude-plugin', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    // Executable, as an installed binary is: on POSIX doctor fails a registered command it cannot start.
    fs.writeFileSync(path.join(install, 'bin', 'library'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // A Windows release's hooks name `bin/library.exe` in exec form (S46), so the stand-in is there too (S47: until
    // then this section failed against every compiled Windows kernel since rel46b, for want of the file they name).
    if (process.platform === 'win32') fs.writeFileSync(path.join(install, 'bin', 'library.exe'), 'MZ');
    // The KERNEL UNDER TEST's own program root, which a compiled self-test cannot find from its own path.
    const kernelProgram = String((JSON.parse(runCli(['--version'], { cwd: root, env }).stdout) as Record<string, unknown>)['program_root']);
    fs.copyFileSync(path.join(kernelProgram, '.claude-plugin', 'hooks', 'hooks.json'), path.join(install, '.claude-plugin', 'hooks', 'hooks.json'));
    fs.copyFileSync(path.join(kernelProgram, '.claude-plugin', '.mcp.json'), path.join(install, '.claude-plugin', '.mcp.json'));
    fs.writeFileSync(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'deskpost', hooks: './.claude-plugin/hooks/hooks.json', mcpServers: './.claude-plugin/.mcp.json' }));
    fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'deskpost@deskpost': true } }));
    fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'deskpost@deskpost': [{ scope: 'user', installPath: install }] } }));
    const guards = () => {
      const doctor = runCli(['doctor', '--workspace', workspace], { cwd: root, env });
      try {
        return ((JSON.parse(doctor.stdout) as { checks: { check: string; status: string; detail: string }[] }).checks.find((row) => row.check === 'workspace.guards-registered')) ?? { status: '(absent)', detail: '' };
      } catch {
        return { status: '(unreadable)', detail: doctor.stdout + doctor.stderr };
      }
    };
    const both = guards();
    check(both.status === 'warn' && both.detail.includes('every guard runs twice'), `init's hooks and the plugin's together were not warned as doubled: ${both.status} ${both.detail}`);
    const local = path.join(workspace, '.claude', 'settings.local.json');
    fs.writeFileSync(local, '{}\n');
    const only = guards();
    check(only.status === 'pass' && only.detail.includes('through the enabled deskpost@deskpost plugin'), `a plugin-only workspace was not read as guarded: ${only.status} ${only.detail}`);
    // In process, so this process is pointed at the scratch configuration for the one call.
    const previousConfig = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = config;
    const launch = launchSettingsFaults(path.join(workspace, '.claude'));
    if (previousConfig === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = previousConfig;
    check(launch.length === 0, `the launch warning fired over a plugin-only workspace: ${launch.join('; ')}`);
    fs.writeFileSync(local, JSON.stringify({ enabledPlugins: { 'deskpost@deskpost': false } }));
    const off = guards();
    check(off.status === 'fail' && off.detail.includes('is not registered'), `a plugin the workspace switched off still guarded it: ${off.status} ${off.detail}`);
    fs.writeFileSync(local, '{}\n');
    fs.rmSync(path.join(install, 'bin', 'library'));
    fs.rmSync(path.join(install, 'bin', 'library.exe'), { force: true });
    const missing = guards();
    check(missing.status === 'fail' && missing.detail.includes('bin/library'), `a plugin whose binary is gone was read as guarded: ${missing.status} ${missing.detail}`);
    check(hookRegistrationProblems([{}]).some((problem) => !problem.optional), 'an empty settings tree read as registering the guards');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 23. ON POSIX A REMEDY NAMES A COMMAND THE MACHINE CAN RUN (S42) -----------------------------------------

// The kernel's refusals, guard denials and `next` lines name the PowerShell helpers the oracle names, and a
// host with no PowerShell cannot run one: `library desk` with no seat told a Linux reader to use
// tools/Start-LibrarySeat.ps1. On POSIX each is rewritten, where it leaves the kernel, to its ported `library`
// verb, and a helper with no port is named as PowerShell-only rather than offered. Windows keeps the oracle's
// sentences, which the matrix compares. Pure half on every host; the front door on POSIX only.
if (selected(23)) {
  const { hostRemedies } = await import('../src/remedy.ts');
  const posix = (text: string) => hostRemedies(text, 'posix');
  const cases: [string, string][] = [
    ['Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug beta, then read', 'Open it with library desk open book beta --location shelf, then read'],
    ['tools/Set-VirtualDesk.ps1 -Action Open -Kind Book -Location Shelf -Shelf Archive -Slug old', 'library desk open book old --location shelf --shelf archive'],
    ['tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug <slug>.', 'library desk open book <slug> --location shelf.'],
    ['tools/Set-VirtualDesk.ps1 -Action Close -Kind Project -Slug hub', 'library desk close project hub'],
    ['Sit down at a seat with tools/Enter-LibrarySeat.ps1 -Seat <name>, or', 'Sit down at a seat with library seat enter <name>, or'],
    ['tools/Retire-Seat.ps1 -Seat old', 'library seat retire old'],
    ['re-render it with tools/ShelfCatalog.ps1 -Render -WorkspacePath .', 're-render it with library shelf render'],
    ['tools/NotebookIndex.ps1 -Render -WorkspacePath .', 'library notebook render'],
    ['Capture into it with tools/Add-ShelfNote.ps1 -BookSlug holding. It is', 'Capture into it with library capture holding --title <title> --body <text>. It is'],
    ['Use tools/Get-DeskOverview.ps1 until then.', 'Use library desk until then.'],
    ['Create one with tools/Start-LibrarySeat.ps1 -Seat <name> -Project <project-slug>.', 'Create one with library seat start <name> --project <project-slug>.'],
    ['pass -WorkspacePath, set LIBRARY_WORKSPACE, or pass -Seat explicitly.', 'pass --workspace, set LIBRARY_WORKSPACE, or pass --seat explicitly.'],
    ['tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List', 'library reset restore --list'],
    ['tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine <name> -Show', 'library reset restore --quarantine <name> --show'],
    ['tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -Quarantine reset-20260926-0102 -Preflight', 'library reset restore --quarantine reset-20260926-0102 --preflight'],
    ['restore them with tools/Restore-NotebookQuarantine.ps1, or', 'restore them with library reset restore, or'],
    ['take it over with tools/Set-NotebookTopicOwner.ps1, or', 'take it over with tools/Set-NotebookTopicOwner.ps1 (a PowerShell helper; this machine has no PowerShell to run it), or'],
  ];
  for (const [given, wanted] of cases) equal(posix(given), wanted, `the POSIX remedy for '${given}'`);
  const windowsText = 'Open it with tools/Set-VirtualDesk.ps1 -Action Open -Location Shelf -Slug beta.';
  equal(hostRemedies(windowsText, 'win32'), windowsText, "the Windows remedy from source changed; it is the oracle's sentence");
  equal(posix('no helper named here'), 'no helper named here', 'a sentence naming no helper was changed');

  // A `*_route` FIELD IS A REMEDY (S49, the reader's ruling): every such key, and no other field for containing `route`.
  const { hostRemedyFields } = await import('../src/remedy.ts');
  const routed = hostRemedyFields(
    { quarantine: { list_route: 'tools/Restore-NotebookQuarantine.ps1 -WorkspacePath . -List', note: 'tools/Restore-NotebookQuarantine.ps1' }, later_route: 'tools/Get-DeskOverview.ps1', routes: 'tools/Get-DeskOverview.ps1' },
    'posix',
  );
  check(
    routed.quarantine.list_route === 'library reset restore --list' && routed.later_route === 'library desk' && routed.quarantine.note === 'tools/Restore-NotebookQuarantine.ps1' && routed.routes === 'tools/Get-DeskOverview.ps1',
    `the field walk did not treat exactly the *_route keys as remedies: ${JSON.stringify(routed)}`,
  );

  // AN INSTALLED KERNEL ON WINDOWS (S47, the reader's ruling): a ported helper is its verb, as on POSIX, and one
  // with no port is named by its full path in the installed program, runnable under a default execution policy.
  const installedRoot = String.raw`C:\Users\r\AppData\Local\deskpost\current`;
  const installed = (text: string) => hostRemedies(text, 'win32-compiled', installedRoot);
  for (const [given, wanted] of cases.slice(0, -1)) equal(installed(given), wanted, `the installed Windows remedy for '${given}'`);
  equal(
    installed('take it over with tools/Set-NotebookTopicOwner.ps1 -Topic x, or'),
    `take it over with powershell -ExecutionPolicy Bypass -File "${installedRoot}${String.raw`\tools\Set-NotebookTopicOwner.ps1`}" -Topic x, or`,
    'an installed kernel on Windows did not name an unported helper by its full path',
  );

  const compiledKernel = (() => {
    try {
      return (JSON.parse(runCli(['--version']).stdout) as { compiled: boolean }).compiled === true;
    } catch {
      return false;
    }
  })();
  if (process.platform !== 'win32' || compiledKernel) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-remedy-')));
    try {
      const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'reg'), LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
      const workspace = path.join(root, 'ws');
      equal(runCli(['init', workspace, '--registry-root', path.join(root, 'reg')], { cwd: root, env }).exit, 0, 'init for the remedy workspace failed');
      const desk = runCli(['desk'], { cwd: workspace, env });
      check(desk.exit !== 0 && desk.stderr.includes('library seat enter') && !desk.stderr.includes('.ps1'), `a seatless desk still offers a PowerShell helper on POSIX or from a compiled kernel: ${desk.stderr.trim()}`);
      const seatDesk = path.join(workspace, '.claude', 'seats', 'reader');
      fs.mkdirSync(seatDesk, { recursive: true });
      fs.writeFileSync(path.join(seatDesk, '.open-books'), '');
      fs.writeFileSync(path.join(seatDesk, '.open-projects'), '');
      const denial = runCli(['hook', 'shelf-read', '--workspace', workspace, '--seat', 'reader'], { cwd: root, env, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(workspace, 'shelf', 'holding', 'wiki', '_index.md') } }) }).stdout;
      check(denial.includes('library desk open book holding --location shelf') && !denial.includes('Set-VirtualDesk.ps1'), `a closed-Book denial still offers a PowerShell helper on POSIX or from a compiled kernel: ${denial}`);
      // THE ROUTE FIELDS (S49): the Desk's quarantine block and the restore's list, each a command this host runs.
      // The Desk answers only a real seat, made as section 35 makes one: a Hub, then a confirmed `seat enter`.
      const { spawn } = await import('node:child_process');
      const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      agent.unref();
      try {
        equal(runCli(['hub', 'new', 'routes', '--title', 'Routes', '--workspace', workspace], { cwd: root, env }).exit, 0, 'hub new for the route seat failed');
        const enter = (extra: string[]) => runCli(['seat', 'enter', 'router', '--create', '--project', 'routes', '--agent-pid', String(agent.pid), '--workspace', workspace, ...extra], { cwd: root, env });
        const planId = (() => {
          try {
            return String((JSON.parse(enter(['--preflight']).stdout) as { plan_id: unknown }).plan_id);
          } catch {
            return '';
          }
        })();
        equal(enter(['--plan-id', planId]).exit, 0, 'the route seat could not be created');
      } finally {
        try {
          process.kill(agent.pid!);
        } catch {}
      }
      const overview = runCli(['desk', '--seat', 'router', '--json'], { cwd: workspace, env });
      const listRoute = (() => {
        try {
          return String((JSON.parse(overview.stdout) as { notebook?: { quarantine?: { list_route?: unknown } } }).notebook?.quarantine?.list_route);
        } catch {
          return `unreadable: ${overview.stdout.trim()} ${overview.stderr.trim()}`;
        }
      })();
      equal(listRoute, 'library reset restore --list', "the Desk's notebook.quarantine.list_route on POSIX or from a compiled kernel");
      const listing = runCli(['reset', 'restore', '--list', '--json'], { cwd: workspace, env });
      const showRoute = (() => {
        try {
          return String((JSON.parse(listing.stdout) as { show_route?: unknown }).show_route);
        } catch {
          return `unreadable: ${listing.stdout.trim()} ${listing.stderr.trim()}`;
        }
      })();
      equal(showRoute, 'library reset restore --quarantine <name> --show', "the restore listing's show_route on POSIX or from a compiled kernel");
    } finally {
      // The seat's claim holder lets go when its agent dies; give it a moment, as section 35 does.
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          break;
        } catch {
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
        }
      }
    }
  }
}

// --- 24. A SEAT IS HELD FOR ITS SESSION'S LIFE, ON EVERY HOST, AND `seat start` HOLDS IT (S42) ---------------

// Measured in the clean Linux distro: off Windows the seat claim was a plain open(2), and its probe asked only
// whether the file opens, which it always does -- so every held seat read free and two sessions could take
// one. On POSIX the claim is now flock(2) through bun:ffi; this holds the PROPERTY, on every host: a second
// holder is refused while the first holds, the probe reads it held, and it is free once released. Then the
// port the reader ruled for: `library seat start` creates a new seat bound to an active Project, holds the
// claim for exactly its agent's life -- the agent sees the seat held, and after it the seat is free -- refuses a
// second start at a held seat, and refuses with no seat named; `library seat status` is the roster it reads.
// CONCEDED: a kernel run from source under Node on POSIX has no FFI and its claim does not exclude.
if (selected(24)) {
  const { enterSeatClaim, exitSeatClaim, testSeatClaim } = await import('../src/seatclaim.ts');
  const underNodeOnPosix = process.platform !== 'win32' && typeof (globalThis as { Bun?: unknown }).Bun !== 'object';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-seatstart-')));
  try {
    const state = path.join(root, 'claims', '.claude');
    if (!underNodeOnPosix) {
      const first = enterSeatClaim(state, 'probe');
      let second: unknown = null;
      try {
        second = enterSeatClaim(state, 'probe');
      } catch (error) {
        second = error;
      }
      check(second instanceof Error && (second as Error).message.includes('already has a live session'), `a second claim on a held seat was not refused: ${String(second)}`);
      if (!(second instanceof Error)) exitSeatClaim(second as ReturnType<typeof enterSeatClaim>);
      check(testSeatClaim(state, 'probe'), 'a held claim read free');
      exitSeatClaim(first);
      check(!testSeatClaim(state, 'probe'), 'a released claim still read held');
    }

    const registry = path.join(root, 'reg');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const workspace = path.join(root, 'ws');
    const cli = (args: string[]) => runCli(args, { cwd: workspace, env });
    fs.mkdirSync(workspace, { recursive: true });
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'init for the seat workspace failed');
    const hub = cli(['hub', 'new', 'demo', '--title', 'Demo', '--purpose', 'A Project for the seat self-test.', '--workspace', workspace, '--json']);
    equal(hub.exit, 0, `the Project Hub for the seat could not be made: ${hub.stderr.trim()}`);
    const kernel = KERNEL_COMMAND.length ? KERNEL_COMMAND : [process.execPath, CLI];
    const status = (): Record<string, unknown>[] => {
      try {
        return (JSON.parse(cli(['seat', 'status', '--workspace', workspace, '--json']).stdout) as { seats: Record<string, unknown>[] }).seats;
      } catch {
        return [];
      }
    };
    const noName = cli(['seat', 'start', '--workspace', workspace]);
    check(noName.exit !== 0 && noName.stderr.includes('Name the seat'), `seat start with no seat did not refuse by name: ${noName.stderr.trim()}`);
    const preflight = cli(['seat', 'start', 'reader', '--project', 'demo', '--preflight', '--workspace', workspace, '--json']);
    check(preflight.exit === 0 && preflight.stdout.includes('"seat_exists":  false') && preflight.stdout.includes('"project":  "demo"'), `seat start's preflight did not plan the new seat: ${preflight.stdout} ${preflight.stderr}`);
    check(!fs.existsSync(path.join(workspace, '.claude', 'seats', 'reader')), 'a preflight created the seat');

    // THE AGENT IS THE KERNEL ITSELF, asked for the roster from inside the session the start holds.
    const started = runCli(['seat', 'start', 'reader', '--project', 'demo', '--workspace', workspace, '--command', kernel[0]!, '--', ...kernel.slice(1), 'seat', 'status', '--workspace', workspace, '--json'], { cwd: workspace, env });
    equal(started.exit, 0, `seat start did not run its agent: ${started.stderr.trim()}`);
    // The start's own result is written first and the agent's after it, so the agent's is the LAST document.
    const during = (() => { try { return (JSON.parse(started.stdout.substring(started.stdout.lastIndexOf('\n{') + 1)) as { seats: Record<string, unknown>[] }).seats; } catch { return []; } })();
    const readerDuring = during.find((row) => row['seat'] === 'reader');
    check(readerDuring?.['claim'] === 'held' && readerDuring?.['project'] === 'demo', `inside its session the seat did not read held and bound: ${started.stdout.slice(0, 400)}`);
    const readerAfter = status().find((row) => row['seat'] === 'reader');
    check(readerAfter?.['claim'] === 'free', `after its agent exited the seat still read ${String(readerAfter?.['claim'])}`);

    const nested = runCli(['seat', 'start', 'reader', '--workspace', workspace, '--command', kernel[0]!, '--', ...kernel.slice(1), 'seat', 'start', 'reader', '--no-launch', '--workspace', workspace], { cwd: workspace, env });
    check(nested.exit !== 0 && nested.stderr.includes('already has a live session'), `a second start at a held seat was not refused: ${nested.exit} ${nested.stderr.trim()}`);
    const rebound = cli(['seat', 'start', 'reader', '--project', 'other', '--no-launch', '--workspace', workspace]);
    check(rebound.exit !== 0 && rebound.stderr.includes("is already bound to project 'demo'"), `a start rebinding the seat to another Project was not refused: ${rebound.stderr.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 25-27. THE SEAT CLAIM, JUDGED THROUGH THE FRONT DOOR (S43, S21's group 3) ---------------------------------

// Three independent rows are judged here, one section each, and every check goes through `runCli` -- so
// with LIBRARY_SELFTEST_KERNEL they judge THAT kernel. Nothing below imports the kernel's claim code: a
// judge that asked the kernel's own functions whether the kernel is right would agree with any defect it
// shares with them. The stand-in agents are ordinary processes, a sleeping Node on Windows and `sleep`
// elsewhere, because a claim is bound to a process identity and nothing else about the agent matters.
// Each section builds its own workspace, with two Projects and the seats it needs, and kills every agent
// it started before its directory goes.
async function seatClaimWorkspace(label: string, options: { pin?: boolean } = {}) {
  const { spawn } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kernel-${label}-`)));
  const registry = path.join(root, 'reg');
  const workspace = path.join(root, 'ws');
  const agents: { pid: number; kill(signal?: NodeJS.Signals): boolean }[] = [];
  const env = {
    LIBRARY_WORKSPACE: '',
    LIBRARY_WORKSPACES: registry,
    LIBRARY_SEAT: '',
    LIBRARY_SEAT_CLAIM: '',
    CLAUDE_PID: '',
    AI_LIBRARY_MCP_URL: '',
    AI_LIBRARY_PROJECT_ID: '',
    LIBRARY_SHARED_COLLECTION_ROOT: '',
  };
  const startAgent = () => {
    const agent =
      process.platform === 'win32'
        ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' })
        : spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    agent.unref();
    agents.push(agent as unknown as { pid: number; kill(signal?: NodeJS.Signals): boolean });
    return agent.pid!;
  };
  // `as` is the process a call comes from: CLAUDE_PID names its agent, which is how a real tool child is
  // identified. A call from NO agent names this judge's own pid, which is alive and bound to nothing --
  // leaving it empty would send the kernel up the parent chain, to whatever launched this run.
  const as = (agentPid: number, args: string[], extra: Record<string, string> = {}) =>
    runCli(args, { cwd: root, env: { ...env, CLAUDE_PID: String(agentPid), ...extra } });
  // A COMPILED self-test's own executable is this suite, so asking it to evaluate a timer would run the suite
  // again; there the pause is `sleep`.
  const pause = (ms: number) =>
    isCompiled() && process.platform !== 'win32' ? spawnSync('sleep', [String(ms / 1000)]) : spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]);
  const claimed = (seat: string): boolean | null => {
    const desk = as(process.pid, ['desk', '--seat', seat, '--workspace', workspace, '--json']);
    try {
      return (JSON.parse(desk.stdout) as { this_seat: { claimed: boolean } }).this_seat.claimed;
    } catch {
      return null;
    }
  };
  // The holder notices its agent's death on its own poll; a claim still held ten seconds later is not.
  const untilFree = (seat: string): boolean => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (claimed(seat) === false) return true;
      pause(200);
    }
    return false;
  };
  const createSeat = (seat: string, project: string, agentPid: number) => {
    const args = ['seat', 'enter', seat, '--create', '--project', project, '--agent-pid', String(agentPid), '--workspace', workspace];
    const preflight = as(agentPid, [...args, '--preflight']);
    const planId = (() => {
      try {
        return String((JSON.parse(preflight.stdout) as { plan_id: string }).plan_id);
      } catch {
        return '';
      }
    })();
    return as(agentPid, [...args, '--plan-id', planId]);
  };
  const claimToken = (seat: string): string => {
    try {
      const text = fs.readFileSync(path.join(workspace, '.claude', 'seats', seat, '.claim'), 'utf8');
      return /^token=([0-9a-f]{32})$/m.exec(text.replace(/\r/g, ''))?.[1] ?? '';
    } catch {
      return '';
    }
  };
  // Every file under a directory with its modification time and length, for "nothing was written".
  const snapshot = (directory: string): string => {
    const lines: string[] = [];
    const walk = (at: string) => {
      if (!fs.existsSync(at)) return;
      for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const stat = fs.statSync(full);
          lines.push(`${path.relative(directory, full)} ${stat.size} ${stat.mtimeMs}`);
        }
      }
    };
    walk(directory);
    return lines.join('\n');
  };
  const dispose = () => {
    for (const agent of agents) {
      try {
        if (process.platform !== 'win32') agent.kill('SIGCONT');
        agent.kill();
      } catch {
        // already gone
      }
    }
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        pause(200);
      }
    }
  };

  const init = runCli(['init', workspace, '--registry-root', registry], { cwd: root, env });
  equal(init.exit, 0, `init for the ${label} workspace failed: ${init.stderr.trim()}`);
  for (const project of ['alpha', 'beta']) {
    const hub = as(process.pid, ['hub', 'new', project, '--title', project, '--workspace', workspace]);
    equal(hub.exit, 0, `the ${project} Hub could not be made: ${hub.stderr.trim()}`);
  }
  // The Desk writers refuse a workspace with no collection pin, as their oracle does; a Tier 0 init writes none.
  // A pin with no endpoint makes the Project reader expect Basic Memory, so a section that reads a local Hub
  // through the reader goes without it.
  if (options.pin !== false) {
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.claude', '.library-project'), '33333333-3333-3333-3333-333333333333');
  }
  return { root, workspace, as, pause, claimed, untilFree, createSeat, claimToken, snapshot, startAgent, agents, dispose };
}

// 25. seat.refuses-a-seat-claimed-by-a-live-process -- ADR-0018 and step 25: a seat whose claim a living process
// holds is refused to a second process, entering and changing alike; a PAUSED agent keeps its seat, and nothing
// is written while it is paused, because there is no heartbeat and no lease to expire; and the claim ends with
// the process, so the seat is free once it has died and a new agent may take it.
if (selected(25)) {
  const w = await seatClaimWorkspace('claim-live');
  try {
    const first = w.startAgent();
    const second = w.startAgent();
    const created = w.createSeat('first', 'alpha', first);
    equal(created.exit, 0, `the seat could not be created and entered: ${created.stderr.trim()}`);
    check(w.claimed('first') === true, 'a seat entered by a living agent does not read claimed');

    const intruder = w.as(second, ['seat', 'enter', 'first', '--agent-pid', String(second), '--workspace', w.workspace]);
    check(intruder.exit !== 0 && intruder.stderr.includes('live session'), `a second process entered a seat another living process holds: ${intruder.exit} ${intruder.stderr.trim()}`);
    const intruderWrite = w.as(second, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]);
    check(intruderWrite.exit !== 0 && intruderWrite.stderr.includes('does not hold seat'), `a second process changed the Desk of a seat it does not hold: ${intruderWrite.exit} ${intruderWrite.stderr.trim()}`);
    const ownWrite = w.as(first, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]);
    equal(ownWrite.exit, 0, `the holding agent could not change its own Desk, so the refusals above prove nothing: ${ownWrite.stderr.trim()}`);
    const again = w.as(first, ['seat', 'enter', 'first', '--agent-pid', String(first), '--workspace', w.workspace]);
    equal(again.exit, 0, `the holding agent entering its own seat again was not a no-op: ${again.stderr.trim()}`);

    // PAUSED. On POSIX the agent is really stopped; Windows has no signal for it, so there it is only idle.
    // Either way nothing may be written under the seat while it waits: a write would be a heartbeat.
    const seatDirectory = path.join(w.workspace, '.claude', 'seats', 'first');
    if (process.platform !== 'win32') process.kill(first, 'SIGSTOP');
    const before = w.snapshot(seatDirectory);
    w.pause(3000);
    const after = w.snapshot(seatDirectory);
    check(before === after, `something was written under a paused agent's seat, which is a heartbeat: ${before} => ${after}`);
    check(w.claimed('first') === true, 'a paused agent lost its seat');
    const whilePaused = w.as(second, ['seat', 'enter', 'first', '--agent-pid', String(second), '--workspace', w.workspace]);
    check(whilePaused.exit !== 0 && whilePaused.stderr.includes('live session'), `a second process took a paused agent's seat: ${whilePaused.exit} ${whilePaused.stderr.trim()}`);
    if (process.platform !== 'win32') process.kill(first, 'SIGCONT');

    // THE CLAIM ENDS WITH THE PROCESS, whatever killed it.
    process.kill(first);
    check(w.untilFree('first'), 'the seat still read claimed ten seconds after its agent died');
    const taken = w.as(second, ['seat', 'enter', 'first', '--agent-pid', String(second), '--workspace', w.workspace]);
    equal(taken.exit, 0, `a new agent could not take a seat whose holder had died: ${taken.stderr.trim()}`);
    check(w.claimed('first') === true, 'the seat a new agent took does not read claimed');
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// 26. seat.every-mutation-fences-on-the-incarnation -- step 25: the claim carries an incarnation, and a mutation
// carrying a STALE one is refused although the seat's name still matches. Three stale forms, each beside the
// current one as its positive control: the token of an earlier session at the same seat, a binding whose agent
// process is not the one now at that pid (a reused pid), and a seat retired and created again under its old
// name, whose earlier session's token must not reach the new one. The Desk writers and a reset are driven; a
// compile meets the same gate (`assertSeatClaimHeld`) only after its batch is resolved, so it is not.
if (selected(26)) {
  const w = await seatClaimWorkspace('claim-fence');
  try {
    const first = w.startAgent();
    equal(w.createSeat('first', 'alpha', first).exit, 0, 'the seat could not be created and entered');
    const staleToken = w.claimToken('first');
    check(/^[0-9a-f]{32}$/.test(staleToken), `the first session's claim carries no token to go stale: '${staleToken}'`);
    process.kill(first);
    check(w.untilFree('first'), 'the first session never let go of its seat');
    const next = w.startAgent();
    equal(w.as(next, ['seat', 'enter', 'first', '--agent-pid', String(next), '--workspace', w.workspace]).exit, 0, 'the second session could not enter');
    const currentToken = w.claimToken('first');
    check(currentToken !== '' && currentToken !== staleToken, 'the second session was given the first one\'s token, so no fence below can tell them apart');

    // By token alone: the call comes from no agent, so the token is its only proof.
    const byToken = (token: string, args: string[]) => w.as(process.pid, args, { LIBRARY_SEAT_CLAIM: token });
    const mutations: [string, string[]][] = [
      ['desk open', ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]],
      ['desk close', ['desk', 'close', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]],
      ['reset', ['reset', '--seat', 'first', '--preflight', '--workspace', w.workspace, '--json']],
    ];
    for (const [label, args] of mutations) {
      const stale = byToken(staleToken, args);
      check(stale.exit !== 0 && stale.stderr.includes('does not hold seat'), `${label} carrying the earlier session's token was not refused: ${stale.exit} ${stale.stderr.trim()}`);
      const current = byToken(currentToken, args);
      equal(current.exit, 0, `${label} carrying the current token was refused, so the stale refusal proves nothing: ${current.stderr.trim()}`);
    }

    // A REUSED PID: the binding's recorded start time no longer describes the process at that pid.
    const bindingPath = path.join(w.workspace, '.claude', 'seats', 'first', 'binding.json');
    const bindingText = fs.existsSync(bindingPath) ? fs.readFileSync(bindingPath, 'utf8') : '{}';
    const binding = JSON.parse(bindingText.replace(/^\uFEFF/, '')) as { agent_start_utc?: string };
    check(typeof binding.agent_start_utc === 'string' && binding.agent_start_utc.length > 0, 'the binding records no agent start time, so a reused pid could inherit it');
    const byAgent = () => w.as(next, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]);
    equal(byAgent().exit, 0, 'the bound agent could not change its own Desk');
    if (fs.existsSync(bindingPath)) {
      fs.writeFileSync(bindingPath, bindingText.replace(String(binding.agent_start_utc), '2001-01-01T00:00:00.0000000Z'));
      const reused = byAgent();
      check(reused.exit !== 0 && reused.stderr.includes('does not hold seat'), `a process at the bound pid with another start time changed the Desk: ${reused.exit} ${reused.stderr.trim()}`);
      fs.writeFileSync(bindingPath, bindingText);
      equal(byAgent().exit, 0, 'restoring the binding did not restore the agent\'s right to write, so the refusal above was not the start time');
    }

    // A SEAT RETIRED AND CREATED AGAIN is a new incarnation; the old session's token reaches nothing in it.
    process.kill(next);
    check(w.untilFree('first'), 'the second session never let go of its seat');
    const retire = w.as(process.pid, ['seat', 'retire', 'first', '--preflight', '--workspace', w.workspace, '--json']);
    const retirePlan = (() => {
      try {
        return String((JSON.parse(retire.stdout) as { plan_id: string }).plan_id);
      } catch {
        return '';
      }
    })();
    const retired = w.as(process.pid, ['seat', 'retire', 'first', '--plan-id', retirePlan, '--workspace', w.workspace, '--json']);
    equal(retired.exit, 0, `the seat could not be retired: ${retire.stderr.trim()} ${retired.stderr.trim()}`);
    const reborn = w.startAgent();
    equal(w.createSeat('first', 'alpha', reborn).exit, 0, 'the seat could not be created again under its old name');
    const rebornToken = w.claimToken('first');
    for (const token of [staleToken, currentToken]) {
      const old = byToken(token, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]);
      check(old.exit !== 0 && old.stderr.includes('does not hold seat'), `a token from the retired incarnation changed the new seat's Desk: ${old.exit} ${old.stderr.trim()}`);
    }
    equal(byToken(rebornToken, ['desk', 'open', 'book', 'reports', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]).exit, 0, 'the new incarnation\'s own token was refused');
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// 27. reset.refuses-a-seat-whose-claim-is-held -- ADR-0016: a reset aimed at a seat another living session holds
// is refused, and changes nothing there, so one seat's habitual command cannot destroy another seat's work in
// progress. Its controls: the session holding that seat is allowed the same preflight, and once that session
// has ended the reset is still refused from elsewhere, because a reset acts from its own seat's claim.
if (selected(27)) {
  const w = await seatClaimWorkspace('claim-reset');
  try {
    const mine = w.startAgent();
    const theirs = w.startAgent();
    equal(w.createSeat('first', 'alpha', mine).exit, 0, 'the acting seat could not be created');
    equal(w.createSeat('second', 'beta', theirs).exit, 0, 'the other seat could not be created');
    // Material in the other seat's Notebook, which a reset would quarantine.
    const notebook = path.join(w.workspace, 'notebook');
    const theirState = path.join(w.workspace, '.claude', 'seats', 'second');
    const beforeNotebook = w.snapshot(notebook);
    const beforeState = w.snapshot(theirState);
    const resetArgs = (extra: string[]) => ['reset', '--seat', 'second', '--workspace', w.workspace, '--json', ...extra];

    const refused = w.as(mine, resetArgs(['--preflight']));
    check(refused.exit !== 0 && refused.stderr.includes('Another session is working that seat'), `a reset preflight at a seat another session holds was not refused as held: ${refused.exit} ${refused.stderr.trim()}`);
    check(!refused.stdout.includes('plan_id'), 'a refused reset still issued a plan');
    const confirmed = w.as(mine, resetArgs(['--plan-id', '0000000000000000']));
    check(confirmed.exit !== 0 && confirmed.stderr.includes('Another session is working that seat'), `a confirmed reset at a held seat was not refused as held: ${confirmed.exit} ${confirmed.stderr.trim()}`);
    const clearing = w.as(mine, resetArgs(['--clear-desk', '--preflight']));
    check(clearing.exit !== 0 && clearing.stderr.includes('Another session is working that seat'), `a full reset at a held seat was not refused as held: ${clearing.stderr.trim()}`);
    check(w.snapshot(notebook) === beforeNotebook, 'a refused reset changed the Notebook');
    check(w.snapshot(theirState) === beforeState, "a refused reset changed the other seat's state");
    check(w.claimed('second') === true, 'a refused reset released the other seat');

    const own = w.as(theirs, resetArgs(['--preflight']));
    equal(own.exit, 0, `the session holding the seat was refused its own reset preflight, so the refusal above proves nothing: ${own.stderr.trim()}`);

    process.kill(theirs);
    check(w.untilFree('second'), "the other seat's session never let go");
    const afterwards = w.as(mine, resetArgs(['--preflight']));
    check(afterwards.exit !== 0 && afterwards.stderr.includes('has no live session'), `a reset at a free seat from another seat's session was not refused: ${afterwards.exit} ${afterwards.stderr.trim()}`);
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// --- 28. ONE WRITABLE WORKSPACE PER COLLECTION, ACQUIRED AND RELEASED (S43, S21's group 4) ----------------------

// publication.collection-ownership-is-acquired-and-released -- ADR-0030 and step 21: ownership is an exclusive
// per-incarnation claim record in the collection's own folder, and a second workspace is refused while it
// stands. Judged through `library collection owner` and the fence every shared write meets, over a scratch
// filesystem view of a collection -- the arbitration is exclusive create in that folder and needs no Basic
// Memory, so the endpoint is a closed port nothing is ever sent to. Ten workspaces: two to hand the role
// between, and all ten to contend for it at once, three times over, where exactly one may win each time and
// no incarnation may be claimed twice.
if (selected(28)) {
  const { spawn } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-owner-')));
  try {
    const registry = path.join(root, 'reg');
    const view = path.join(root, 'view');
    for (const catalog of ['books', 'projects']) {
      fs.mkdirSync(path.join(view, catalog), { recursive: true });
      fs.writeFileSync(path.join(view, catalog, 'README.md'), '# Catalog\n');
    }
    const collectionId = '44444444-4444-4444-4444-444444444444';
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const workspaces: { path: string; id: string }[] = [];
    const CONTENDERS = 10;
    for (let n = 0; n < CONTENDERS; n += 1) {
      const workspace = path.join(root, `ws${n}`);
      const init = runCli(['init', workspace, '--registry-root', registry, '--mcp-url', 'http://127.0.0.1:1/mcp', '--collection-id', collectionId], { cwd: root, env });
      equal(init.exit, 0, `init for workspace ${n} failed: ${init.stderr.trim()}`);
      fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', '.library-mcp-url'), 'http://127.0.0.1:1/mcp');
      fs.writeFileSync(path.join(workspace, '.claude', '.library-project'), collectionId);
      fs.writeFileSync(path.join(workspace, '.claude', '.library-shared-root'), view);
      let id = '';
      try {
        id = String((JSON.parse(fs.readFileSync(path.join(workspace, '.library', 'workspace.json'), 'utf8').replace(/^\uFEFF/, '')) as { id: string }).id);
      } catch {
        // reported below
      }
      check(/^[0-9a-f-]{8,}$/.test(id), `workspace ${n} carries no workspace id to record against the collection`);
      workspaces.push({ path: workspace, id });
    }
    const [a, b] = workspaces as [{ path: string; id: string }, { path: string; id: string }];
    const owner = (at: { path: string }, extra: string[]) => runCli(['collection', 'owner', ...extra, '--workspace', at.path, '--json'], { cwd: root, env });
    const parsed = (result: { stdout: string }): Record<string, unknown> => {
      try {
        return JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const ownerDirectory = path.join(view, '.owner');
    const records = () => (fs.existsSync(ownerDirectory) ? fs.readdirSync(ownerDirectory).filter((name) => /^\d{4,}\.(claim|release)\.json$/.test(name)).sort() : []);

    // DAY ONE: nobody owns it, the status says so and what that means, and reading it writes nothing.
    const unowned = owner(a, ['--status']);
    equal(unowned.exit, 0, `status over an unowned collection failed: ${unowned.stderr.trim()}`);
    check(parsed(unowned)['role'] === 'unowned' && String(parsed(unowned)['refusal']).includes('shared writes are not fenced'), `an unowned collection was not reported as unowned and unfenced: ${unowned.stdout.slice(0, 300)}`);
    check(!fs.existsSync(ownerDirectory), 'reading the status wrote an ownership record');

    // ACQUIRED ONCE, idempotently, and then nobody else may have it.
    const acquired = owner(a, ['--acquire']);
    check(acquired.exit === 0 && parsed(acquired)['outcome'] === 'acquired' && parsed(acquired)['incarnation'] === 1, `the first acquire did not take incarnation 1: ${acquired.stdout.slice(0, 300)} ${acquired.stderr.trim()}`);
    equal(records().join(','), '0001.claim.json', 'the first acquire did not write exactly one claim record');
    const claimBody = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ownerDirectory, '0001.claim.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    check(claimBody['workspace_id'] === a.id && claimBody['incarnation'] === 1 && String(claimBody['schema']) === '1', `the claim record does not name the acquiring workspace and its incarnation: ${JSON.stringify(claimBody)}`);
    const twice = owner(a, ['--acquire']);
    check(twice.exit === 0 && parsed(twice)['outcome'] === 'already_held' && parsed(twice)['incarnation'] === 1, `a second acquire by the holder was not idempotent: ${twice.stdout.slice(0, 300)} ${twice.stderr.trim()}`);
    equal(records().join(','), '0001.claim.json', 'a second acquire by the holder wrote a record');
    const stolen = owner(b, ['--acquire']);
    check(stolen.exit !== 0 && stolen.stderr.includes(`Workspace ${a.id} holds the writable role for this collection at incarnation 1`), `a second workspace was not refused the role another holds: ${stolen.exit} ${stolen.stderr.trim()}`);
    equal(records().join(','), '0001.claim.json', 'a refused acquire wrote a record');
    check(parsed(owner(a, ['--status']))['role'] === 'writable', 'the holder does not read its role as writable');
    const readOnly = parsed(owner(b, ['--status']));
    check(readOnly['role'] === 'read-only' && String(readOnly['refusal']).includes(`workspace ${a.id} holds the writable role`), `the other workspace's status does not say it is read-only and why: ${JSON.stringify(readOnly).slice(0, 300)}`);
    // THE FENCE READS WHAT THE PORT WROTE: a shared write from the other workspace is refused before it is sent.
    const fenced = runCli(['hub', 'new', 'x', '--title', 'X', '--workspace', b.path], { cwd: root, env });
    check(fenced.exit !== 0 && fenced.stderr.includes(`workspace ${a.id} holds the writable role for this collection at incarnation 1`), `a shared write from a read-only workspace was not refused by the fence: ${fenced.stderr.trim()}`);

    // RELEASED ONLY WITH NO WRITE IN FLIGHT, once, and then the next acquire takes the next incarnation.
    const lockDirectory = path.join(a.path, 'internal', 'book-locks');
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(lockDirectory, 'shelf-demo.lock'), '');
    const busy = owner(a, ['--release']);
    check(busy.exit !== 0 && busy.stderr.includes('holds 1 Book lock(s)') && busy.stderr.includes('shelf-demo.lock'), `a release while a Book lock is held was not refused naming it: ${busy.stderr.trim()}`);
    equal(records().join(','), '0001.claim.json', 'a refused release wrote a record');
    fs.rmSync(path.join(lockDirectory, 'shelf-demo.lock'));
    const foreignRelease = owner(b, ['--release']);
    check(foreignRelease.exit !== 0 && foreignRelease.stderr.includes('does not hold the writable role'), `a workspace released a role it does not hold: ${foreignRelease.stderr.trim()}`);
    const released = owner(a, ['--release']);
    check(released.exit === 0 && parsed(released)['outcome'] === 'released', `the holder could not release: ${released.stdout.slice(0, 300)} ${released.stderr.trim()}`);
    const releasedTwice = owner(a, ['--release']);
    check(releasedTwice.exit === 0 && parsed(releasedTwice)['outcome'] === 'already_released', `a second release was not reported as already released: ${releasedTwice.stdout.slice(0, 300)} ${releasedTwice.stderr.trim()}`);
    equal(records().join(','), '0001.claim.json,0001.release.json', 'the release did not write exactly one release record');
    const whileReleased = runCli(['hub', 'new', 'x', '--title', 'X', '--workspace', a.path], { cwd: root, env });
    check(whileReleased.exit !== 0 && whileReleased.stderr.includes('no workspace holds the writable role for this collection'), `a shared write while the role is released was not refused: ${whileReleased.stderr.trim()}`);
    const handed = owner(b, ['--acquire']);
    check(handed.exit === 0 && parsed(handed)['incarnation'] === 2, `the next acquire did not take incarnation 2: ${handed.stdout.slice(0, 300)} ${handed.stderr.trim()}`);

    // A FORCED TAKEOVER is previewed first, writes nothing then, and is recorded under the forcer's name.
    const preview = owner(a, ['--acquire', '--force']);
    check(preview.exit === 0 && parsed(preview)['mode'] === 'acquire-preflight' && parsed(preview)['would_displace'] === b.id, `a forced acquire without confirmation was not a preview: ${preview.stdout.slice(0, 300)} ${preview.stderr.trim()}`);
    equal(records().length, 3, 'a forced-acquire preview wrote a record');
    const forced = owner(a, ['--acquire', '--force', '--user-confirmed']);
    check(forced.exit === 0 && parsed(forced)['incarnation'] === 3 && parsed(forced)['displaced'] === b.id, `a confirmed forced acquire did not take incarnation 3 and name whom it displaced: ${forced.stdout.slice(0, 300)} ${forced.stderr.trim()}`);
    const forcedRelease = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ownerDirectory, '0002.release.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    check(forcedRelease['reason'] === 'forced' && forcedRelease['workspace_id'] === a.id, `the displaced incarnation's release is not a forced one signed by the forcer: ${JSON.stringify(forcedRelease)}`);
    equal(owner(a, ['--release']).exit, 0, 'the forcer could not release');

    // CONTENTION: every workspace acquires at once, three rounds, and exactly one wins each round. MEASURED
    // FIRST (S43): with six contenders and an empty record directory, an arbitration that REPLACED an existing
    // record -- two winners, one silently overwritten -- stayed green, because the processes start tens of
    // milliseconds apart and the window between reading the record and creating the next claim is far shorter.
    // So the record directory is padded with names the reader ignores, which makes every contender's read long
    // enough for their reads to overlap, and the round is run three times.
    fs.mkdirSync(ownerDirectory, { recursive: true });
    for (let pad = 0; pad < 4000; pad += 1) fs.writeFileSync(path.join(ownerDirectory, `.pad-${pad}`), '');
    const contend = () =>
      Promise.all(
        workspaces.map(
          (at) =>
            new Promise<{ exit: number; stdout: string; stderr: string }>((resolve) => {
              const [file, ...prefix] = KERNEL_COMMAND.length ? KERNEL_COMMAND : [process.execPath, CLI];
              const child = spawn(file!, [...prefix, 'collection', 'owner', '--acquire', '--workspace', at.path, '--json'], { cwd: root, env: { ...process.env, ...env } });
              let stdout = '';
              let stderr = '';
              child.stdout.on('data', (chunk) => (stdout += String(chunk)));
              child.stderr.on('data', (chunk) => (stderr += String(chunk)));
              child.on('close', (code) => resolve({ exit: code ?? -1, stdout, stderr }));
            }),
        ),
      );
    for (const incarnation of [4, 5, 6]) {
      const contenders = await contend();
      const winners = contenders.filter((result) => result.exit === 0 && parsed(result)['outcome'] === 'acquired');
      equal(winners.length, 1, `round ${incarnation}: ${winners.length} workspaces acquired the role at once: ${contenders.map((result) => `${result.exit} ${String(parsed(result)['incarnation'] ?? '')} ${result.stderr.slice(0, 100)}`).join(' | ')}`);
      const losers = contenders.filter((result) => result.exit !== 0);
      check(
        losers.length === contenders.length - 1 && losers.every((result) => /holds the writable role|while this acquire was in flight/.test(result.stderr)),
        `round ${incarnation}: a contender that lost was not refused by name: ${losers.map((result) => result.stderr.trim().slice(0, 160)).join(' | ')}`,
      );
      const status = parsed(owner(a, ['--status']));
      const holder = workspaces.find((at) => at.id === status['held_by']);
      check(
        status['state'] === 'held' && status['incarnation'] === incarnation && holder !== undefined && winners.length === 1 && parsed(winners[0]!)['workspace_id'] === holder.id,
        `round ${incarnation}: the record is not held at incarnation ${incarnation} by the one contender told it won: ${JSON.stringify(status).slice(0, 300)}`,
      );
      if (holder !== undefined) equal(owner(holder, ['--release']).exit, 0, `round ${incarnation}: the winner could not release`);
    }
    equal(
      records().filter((name) => name.endsWith('.claim.json')).join(','),
      '0001.claim.json,0002.claim.json,0003.claim.json,0004.claim.json,0005.claim.json,0006.claim.json',
      'contention left other than exactly one claim per incarnation',
    );
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 29-30. A LOCK EXCLUDES, JUDGED WITH THE LOCK ITSELF AS THE GATE (S43, S21's group 4) --------------------------

// A Book lock is a file made by exclusive create in internal/book-locks/, named for the Book, and a writer
// waits while another holds it. That is observable from outside the kernel, so these judges HOLD THE LOCK
// THEMSELVES, the way another writer would: every writer started while the judge holds it must write nothing,
// and each must complete once it is released. The gate is what makes the race deterministic -- writers that
// merely start at the same moment serialise by accident of process start-up more often than they contend, which
// S43 measured on the ownership row -- and it turns each defect into a certainty: a writer that takes no lock
// writes while the gate is shut, and one that reads its prior state before taking the lock journals that state
// while the gate is shut. The lock file's name is the kernel's normalisation of the Book root (`shelf/holding`
// is `shelf-holding.lock`), which is part of the protocol every writer shares, not a detail of this kernel.
// SPAWNED NOW, NOT AFTER AN AWAIT, and waited on with `sleep` rather than a synchronous pause. Both measured the
// hard way (S43): a child spawned inside an async callback is not started until the event loop next turns, and a
// synchronous pause does not turn it -- so every writer "behind the gate" started only once the gate had opened,
// and the gate checks passed against a kernel that took no lock at all.
function startCli(args: string[], options: { cwd: string; env: Record<string, string> }) {
  const [file, ...prefix] = KERNEL_COMMAND.length ? KERNEL_COMMAND : [process.execPath, CLI];
  let exited = false;
  const child = spawn(file!, [...prefix, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const done = new Promise<{ exit: number; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      exited = true;
      resolve({ exit: code ?? -1, stdout, stderr });
    });
  });
  return { done, hasExited: () => exited, kill: () => child.kill() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function holdBookLock(workspace: string, lockName: string): () => void {
  const directory = path.join(workspace, 'internal', 'book-locks');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${lockName}.lock`);
  fs.writeFileSync(file, `pid=${process.pid}\nacquired=${new Date().toISOString()}\nbook=held by the kernel self-test\n`, { flag: 'wx' });
  return () => fs.rmSync(file, { force: true });
}

function listFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    if (!fs.existsSync(at)) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(directory, full).split(path.sep).join('/'));
    }
  };
  walk(directory);
  return found.sort();
}

// 29. concurrency.two-writers-one-book-lock -- step 23: writers against one Book serialise on the Book's lock,
// and it is taken BEFORE prior state is read, so no journal describes a torn capture. Eight captures into one
// capture Book are started behind the gate: nothing is written and nothing journaled while it is shut; once
// open, all eight land, the reader map lists all eight, and the eight journals' recorded prior reader maps list
// 0, 1, ... 7 of those notes -- each capture saw every capture before it and none after, which is exactly what
// a lock taken before the read guarantees and what a lock taken after it cannot.
if (selected(29)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-booklock-')));
  const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(root, 'reg'), LIBRARY_SEAT: '', CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
  const workspace = path.join(root, 'ws');
  let release: (() => void) | null = null;
  try {
    equal(runCli(['init', workspace, '--registry-root', path.join(root, 'reg')], { cwd: root, env }).exit, 0, 'init for the Book-lock workspace failed');
    // THE GATE STAYS SHUT LONG ENOUGH FOR EVERY WRITER TO REACH IT. Eight kernels starting at once take far
    // longer than one, and a gate opened before they arrive tests nothing, so the wait is scaled from one
    // ungated capture timed first (into the Report Inbox, so the Book under test starts as it was).
    const started = Date.now();
    equal(runCli(['capture', 'reports', '--title', 'Timing note', '--body', 'Times one capture.', '--workspace', workspace, '--json'], { cwd: root, env }).exit, 0, 'an ungated capture failed');
    const gateMs = Math.max(3000, 10 * (Date.now() - started) + 1000);
    const wiki = path.join(workspace, 'shelf', 'holding', 'wiki');
    const journals = path.join(workspace, 'internal');
    const notesBefore = listFiles(path.join(wiki, 'notes'));
    const internalBefore = listFiles(journals);
    const titles = Array.from({ length: 8 }, (_, n) => `Contended note ${String.fromCharCode(97 + n)}`);

    release = holdBookLock(workspace, 'shelf-holding');
    const writers = titles.map((title) => startCli(['capture', 'holding', '--title', title, '--body', `The body of ${title}.`, '--workspace', workspace, '--json'], { cwd: root, env }));
    await sleep(gateMs);
    check(writers.every((writer) => !writer.hasExited()), 'a capture finished while another writer held the Book lock');
    equal(listFiles(path.join(wiki, 'notes')).join(','), notesBefore.join(','), 'a capture wrote a note while another writer held the Book lock');
    const internalWhileHeld = listFiles(journals).filter((name) => !internalBefore.includes(name) && !name.startsWith('book-locks/'));
    equal(internalWhileHeld.join(','), '', 'a capture journaled or recorded state while another writer held the Book lock, so its prior state was read before the lock');
    release();
    release = null;

    const results = await Promise.all(writers.map((writer) => writer.done));
    check(results.every((result) => result.exit === 0), `not every capture landed once the lock was released: ${results.map((result) => `${result.exit} ${result.stderr.trim().slice(0, 120)}`).join(' | ')}`);
    const notes = listFiles(path.join(wiki, 'notes')).filter((name) => !notesBefore.includes(name));
    equal(notes.length, 8, `eight captures left ${notes.length} new notes: ${notes.join(', ')}`);
    const map = fs.existsSync(path.join(wiki, '_index.md')) ? fs.readFileSync(path.join(wiki, '_index.md'), 'utf8') : '';
    const listed = notes.filter((name) => map.includes(name.replace(/\.md$/, '')));
    equal(listed.length, 8, `the reader map lists ${listed.length} of the eight new notes, so an update was lost`);

    // Each capture's journal records the reader map as it stood before that capture: 0..7 of the new notes.
    const journalFiles = listFiles(journals).filter((name) => !internalBefore.includes(name) && /journal/i.test(name) && name.endsWith('.json') && name.includes('shelf-holding'));
    const priorCounts: number[] = [];
    for (const name of journalFiles) {
      try {
        const journal = JSON.parse(fs.readFileSync(path.join(journals, ...name.split('/')), 'utf8').replace(/^\uFEFF/, '')) as { entries: { path: string; existed: boolean; content_base64: string | null }[] };
        const mapEntry = journal.entries.find((entry) => path.basename(entry.path).toLowerCase() === '_index.md');
        const prior = mapEntry && mapEntry.existed && mapEntry.content_base64 ? Buffer.from(mapEntry.content_base64, 'base64').toString('utf8') : '';
        priorCounts.push(notes.filter((note) => prior.includes(note.replace(/\.md$/, ''))).length);
      } catch (error) {
        failures.push(`the capture journal ${name} could not be read: ${(error as Error).message}`);
      }
    }
    equal(
      priorCounts.sort((x, y) => x - y).join(','),
      '0,1,2,3,4,5,6,7',
      `the eight journals do not record the reader map as eight successive states (${journalFiles.length} journals), so a capture read state another capture was still changing`,
    );
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    if (release) release();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 30. concurrency.notebook-mutation-lock-excludes-reset-compile-and-triage -- step 26: a per-seat Notebook mutation
// lock survives ADR-0029. One agent may issue concurrent operations, and they exclude each other: two compiles
// of new topics started behind the seat's render lock promote nothing while it is held and both land once it is
// released, with the seat's index listing both; a reset started behind a topic's lock moves nothing while it is
// held and quarantines the topic once released; a compile of a topic whose lock is held changes nothing until
// then. Triage's Notebook destination is not ported (`library triage` refuses it by name), so it is not driven.
if (selected(30)) {
  const w = await seatClaimWorkspace('notebooklock');
  let release: (() => void) | null = null;
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
    const batch = path.join(w.workspace, 'raw', 'alpha', '2026-09-23-sources');
    fs.mkdirSync(batch, { recursive: true });
    fs.writeFileSync(path.join(batch, 'source.md'), '# Source\n\nA fact worth keeping.\n');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const compileArgs = (topic: string) => {
      const content = path.join(w.root, `${topic}.md`);
      fs.writeFileSync(content, `# ${topic}\n\nWhat the source says about ${topic}.\n\n## Key Takeaways\n\n- ${topic} is worth keeping.\n`);
      return ['compile', 'alpha/2026-09-23-sources', '--topic', topic, '--topic-title', `Topic ${topic}`, '--topic-overview', `About ${topic}.`, '--article-slug', 'first-article', '--content-path', content, '--source-file', 'source.md', '--seat', 'first', '--workspace', w.workspace, '--json'];
    };
    const seatNotebook = path.join(w.workspace, 'notebook', 'first');

    // A first compile, ungated, activates the seat-owned layout and proves the command itself works.
    const warmStarted = Date.now();
    const warm = runCli(compileArgs('warm-up'), { cwd: w.root, env });
    const gateMs = Math.max(3000, 4 * (Date.now() - warmStarted) + 1000);
    equal(warm.exit, 0, `a compile into the seat's Notebook failed, so nothing below can be judged: ${warm.stderr.trim()}`);
    const indexBefore = fs.existsSync(path.join(seatNotebook, '_index.md')) ? 'present' : 'absent';

    release = holdBookLock(w.workspace, 'render-notebook-master-index-first');
    const compiles = ['topic-one', 'topic-two'].map((topic) => startCli(compileArgs(topic), { cwd: w.root, env }));
    await sleep(gateMs);
    check(compiles.every((c) => !c.hasExited()), "a compile of a new topic finished while the seat's render lock was held");
    check(!fs.existsSync(path.join(seatNotebook, 'topic-one')) && !fs.existsSync(path.join(seatNotebook, 'topic-two')), "a compile promoted a topic while the seat's render lock was held");
    release();
    release = null;
    const compiled = await Promise.all(compiles.map((c) => c.done));
    check(compiled.every((result) => result.exit === 0), `a compile did not land once the render lock was released: ${compiled.map((result) => result.stderr.trim().slice(0, 160)).join(' | ')}`);
    const seatIndex = (() => {
      for (const name of fs.existsSync(seatNotebook) ? fs.readdirSync(seatNotebook) : []) {
        if (name.startsWith('_') && name.endsWith('.md')) return fs.readFileSync(path.join(seatNotebook, name), 'utf8');
      }
      return '';
    })();
    check(seatIndex.includes('topic-one') && seatIndex.includes('topic-two'), `the seat's index does not list both topics compiled at once, so one was lost (index was ${indexBefore}): ${seatIndex.slice(0, 300)}`);

    // A compile into an existing topic whose lock is held changes nothing until it is released.
    const articleBefore = listFiles(path.join(seatNotebook, 'topic-one'));
    release = holdBookLock(w.workspace, 'notebook-first-topic-one');
    const second = compileArgs('topic-one');
    second[second.indexOf('first-article')] = 'second-article';
    const blockedCompile = startCli(second, { cwd: w.root, env });
    await sleep(gateMs);
    check(!blockedCompile.hasExited(), "a compile into a topic finished while that topic's lock was held");
    equal(listFiles(path.join(seatNotebook, 'topic-one')).join(','), articleBefore.join(','), "a compile changed a topic while that topic's lock was held");
    release();
    release = null;
    const secondResult = await blockedCompile.done;
    equal(secondResult.exit, 0, `the compile into a topic did not land once its lock was released: ${secondResult.stderr.trim()}`);

    // A reset behind a topic's lock moves nothing while it is held.
    const preflight = runCli(['reset', '--seat', 'first', '--preflight', '--workspace', w.workspace, '--json'], { cwd: w.root, env });
    const planId = (() => {
      try {
        return String((JSON.parse(preflight.stdout) as { plan_id: string }).plan_id);
      } catch {
        return '';
      }
    })();
    check(planId.length > 0, `the reset preflight issued no plan: ${preflight.stderr.trim()}`);
    release = holdBookLock(w.workspace, 'notebook-first-topic-two');
    const reset = startCli(['reset', '--seat', 'first', '--plan-id', planId, '--workspace', w.workspace, '--json'], { cwd: w.root, env });
    await sleep(gateMs);
    check(!reset.hasExited(), "a reset finished while one of its topics' locks was held");
    check(['warm-up', 'topic-one', 'topic-two'].every((topic) => fs.existsSync(path.join(seatNotebook, topic))), "a reset moved a topic while one of its topics' locks was held");
    release();
    release = null;
    const resetResult = await reset.done;
    equal(resetResult.exit, 0, `the reset did not complete once the lock was released: ${resetResult.stderr.trim()}`);
    check(['warm-up', 'topic-one', 'topic-two'].every((topic) => !fs.existsSync(path.join(seatNotebook, topic))), 'the reset left a topic in the Notebook');
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    if (release) release();
    w.dispose();
  }
}

// --- 31-32. AN INTERRUPTED WRITE, AND A FAILED ONE (S43, S21's group 4) --------------------------------------------

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// 31. recovery.an-interrupted-write-leaves-no-partial-file -- step 23's fault injection: a whole-file replacement
// is atomic, so a reader sees the old file or the new one and never part of either, and a writer killed mid-flight
// leaves one or the other. The subject is a Hub page the kernel replaces whole (`hub edit --mode replace-body`),
// made large -- two bodies of several megabytes, each line naming its body -- so a write takes long enough to be
// caught in the middle. While a stream of confirmed replacements runs, this judge reads the page in a tight loop,
// and kernel readers (`read_open_project_page`, through the seat that holds the Hub open) read it too: every read
// must be exactly one body or the other, and a kernel read must not fail at the instant of a rename. Then writers
// are killed at staggered moments, and after each kill the page is still exactly one body or the other.
// MEASURED FIRST (S43): a killed capture left its note complete or absent in 60 of 60 trials, and its Book lock
// behind, as a crashed run's lock is (stale after 30 minutes); so each kill here is followed by removing the Hub's
// lock, which is the remedy the lock's own refusal names.
if (selected(31)) {
  const w = await seatClaimWorkspace('atomic', { pin: false });
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const hubPage = path.join(w.workspace, 'collection', 'projects', 'alpha', '_project.md');
    check(fs.existsSync(hubPage), `the Hub page is not where the judge expects it: ${hubPage}`);
    const bodies = ['north', 'south'].map((name) => {
      const file = path.join(w.root, `${name}.md`);
      fs.writeFileSync(file, `# Alpha\n\n${`The ${name} body of the page, one of many identical lines.\n`.repeat(200000)}`);
      return { name, file };
    });
    // Which body a page holds, judged whole: every line of one body and nothing else, or 'torn'.
    const judgePage = (text: string): string => {
      for (const body of bodies) {
        const line = `The ${body.name} body of the page, one of many identical lines.`;
        const lines = text.split('\n').filter((row) => row.includes(' body of the page, one of many identical lines.'));
        if (lines.length === 200000 && lines.every((row) => row === line)) return body.name;
      }
      return text.includes(' body of the page') ? 'torn' : 'initial';
    };
    const replace = (body: { file: string }): string[] | null => {
      const preflight = runCli(['hub', 'edit', 'alpha', '--mode', 'replace-body', '--content-path', body.file, '--preflight', '--workspace', w.workspace, '--json'], { cwd: w.root, env });
      let planId = '';
      try {
        planId = String((JSON.parse(preflight.stdout) as { plan_id: string }).plan_id);
      } catch {
        failures.push(`a replace-body preflight gave no plan: ${preflight.stderr.trim()}`);
        return null;
      }
      return ['hub', 'edit', 'alpha', '--mode', 'replace-body', '--content-path', body.file, '--user-confirmed', '--plan-id', planId, '--workspace', w.workspace, '--json'];
    };
    const first = replace(bodies[0]!);
    const seeded = first ? runCli(first, { cwd: w.root, env }) : { exit: -1, stderr: 'no plan' };
    equal(seeded.exit, 0, `the first replacement failed, so nothing below can be judged: ${seeded.stderr.trim()}`);
    equal(judgePage(fs.readFileSync(hubPage, 'utf8')), 'north', 'the first replacement did not leave the north body whole');
    // THE KERNEL'S OWN READ of the page is a replace-body preflight, which reads the page to plan and reports the
    // hash of the body it read. Tier 0 has no reader for an open local Project's page (`read_open_project_page`
    // refuses it for want of Basic Memory, S43), so this is the kernel read there is. Its two whole answers are
    // taken while nothing is writing; every read under the writers must be one of them.
    const kernelRead = () => runCli(['hub', 'edit', 'alpha', '--mode', 'replace-body', '--content-path', bodies[0]!.file, '--preflight', '--workspace', w.workspace, '--json'], { cwd: w.root, env });
    const hashOf = (result: { stdout: string }) => {
      try {
        return String((JSON.parse(result.stdout) as { current_sha256: string }).current_sha256);
      } catch {
        return '';
      }
    };
    const northHash = hashOf(kernelRead());
    const northSize = fs.statSync(hubPage).size;
    const southArgs = replace(bodies[1]!);
    if (southArgs) equal(runCli(southArgs, { cwd: w.root, env }).exit, 0, 'the quiet south replacement failed');
    const southHash = hashOf(kernelRead());
    const southSize = fs.statSync(hubPage).size;
    check(/^[0-9a-f]{64}$/.test(northHash) && /^[0-9a-f]{64}$/.test(southHash) && northHash !== southHash, `the kernel's read of the two bodies gave no two distinct hashes: ${northHash} ${southHash}`);

    // CONCURRENT READERS. Writers alternate bodies while a READER PROCESS reads the page as another program would,
    // every 10 ms, judging each read whole, and a kernel read is started beside every writer. MEASURED (S43): the
    // same reads made inside this judge's own process made one replacement in ten exhaust its retries, where a
    // separate reader at the same rate made none in thirty -- so the reader is its own process, as the oracle's
    // measurement rig's was. It stops when the stop file appears and prints what it saw.
    const stopFile = path.join(w.root, 'stop-reading');
    const readerScript = [
      "const fs = require('fs');",
      `const page = ${JSON.stringify(hubPage)}; const stop = ${JSON.stringify(stopFile)};`,
      "const judge = (text) => { for (const name of ['north', 'south']) { const line = 'The ' + name + ' body of the page, one of many identical lines.';",
      "  const lines = text.split(String.fromCharCode(10)).filter((row) => row.includes(' body of the page, one of many identical lines.'));",
      "  if (lines.length === 200000 && lines.every((row) => row === line)) return name; } return text.includes(' body of the page') ? 'torn' : 'initial'; };",
      `const sizes = [${northSize}, ${southSize}];`,
      // A TAIL PROBE EVERY ~2 ms, PACED BY SPINNING: a torn in-place write lasts ~3.4 ms for this page (measured, S43),
      // under Windows' ~15 ms timer tick, so a timer-paced reader misses it. The tail of a whole page is one whole
      // line of one body at one of the two whole sizes; anything else is a page caught part-written. Each probe
      // holds the file for microseconds, which a retrying writer gets past. Every 200th probe reads the page whole.
      "const tails = ['north', 'south'].map((name) => 'The ' + name + ' body of the page, one of many identical lines.' + String.fromCharCode(10));",
      "const tailOk = () => { let fd; try { fd = fs.openSync(page, 'r'); } catch { return true; } try { const size = fs.fstatSync(fd).size; if (!sizes.includes(size)) return false;",
      "  const buffer = Buffer.alloc(tails[0].length); fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length); return tails.includes(buffer.toString('utf8')); } finally { fs.closeSync(fd); } };",
      "const seen = {}; const note = (verdict) => { seen[verdict] = (seen[verdict] || 0) + 1; };",
      "for (let probe = 1; ; probe += 1) {",
      "  if (probe % 100 === 0 && fs.existsSync(stop)) break;",
      "  if (probe % 200 === 0) { let text = null; for (let attempt = 0; attempt < 50 && text === null; attempt += 1) { try { text = fs.readFileSync(page, 'utf8'); } catch { /* the instant of the rename */ } }",
      "    note(text === null ? 'unreadable' : judge(text)); } else note(tailOk() ? 'tail-whole' : 'torn-tail');",
      "  const until = Date.now() + 2; while (Date.now() < until) { /* pace without a timer */ }",
      "}",
      "process.stdout.write(JSON.stringify(seen));",
    ].join('\n');
    const readerProcess = isCompiled()
      ? spawn(process.execPath, ['-e', readerScript], { env: { ...process.env, BUN_BE_BUN: '1' } })
      : spawn(process.execPath, ['-e', readerScript]);
    let readerOut = '';
    readerProcess.stdout.on('data', (chunk) => (readerOut += String(chunk)));
    const readerDone = new Promise<void>((resolve) => readerProcess.on('close', () => resolve()));
    const kernelReads: ReturnType<typeof startCli>[] = [];
    for (let round = 0; round < 12; round += 1) {
      const args = replace(bodies[(round + 1) % 2]!);
      if (!args) break;
      const writer = startCli(args, { cwd: w.root, env });
      kernelReads.push(startCli(['hub', 'edit', 'alpha', '--mode', 'replace-body', '--content-path', bodies[0]!.file, '--preflight', '--workspace', w.workspace, '--json'], { cwd: w.root, env }));
      const written = await writer.done;
      equal(written.exit, 0, `replacement ${round} failed: ${written.stderr.trim()}`);
    }
    fs.writeFileSync(stopFile, '');
    await readerDone;
    const seen = (() => {
      try {
        return JSON.parse(readerOut) as Record<string, number>;
      } catch {
        return {} as Record<string, number>;
      }
    })();
    check(!seen['torn'] && !seen['torn-tail'] && !seen['initial'] && !seen['unreadable'], `a read caught the page part-written, or could not read it at all: ${JSON.stringify(seen)} ${readerOut.slice(0, 200)}`);
    check((seen['north'] ?? 0) > 0 && (seen['south'] ?? 0) > 0, `the reader did not see both bodies while the writers ran, so it proved nothing: ${JSON.stringify(seen)}`);
    const readResults = await Promise.all(kernelReads.map((read) => read.done));
    const badReads = readResults.filter((result) => result.exit !== 0 || ![northHash, southHash].includes(hashOf(result)));
    equal(badReads.length, 0, `a kernel read of the page failed, or read a body that is neither whole one, while it was being replaced: ${badReads.map((result) => `${result.exit} ${hashOf(result)} ${result.stderr.trim().slice(0, 200)}`).join(' | ')}`);

    // KILLED WRITERS: at staggered moments across one write's span, the page is one body or the other after each.
    const timing = replace(bodies[0]!);
    const started = Date.now();
    if (timing) equal(runCli(timing, { cwd: w.root, env }).exit, 0, 'a timed replacement failed');
    const span = Date.now() - started;
    const lock = path.join(w.workspace, 'internal', 'book-locks', 'projects-alpha.lock');
    const outcomes: Record<string, number> = {};
    for (let kill = 0; kill < 16; kill += 1) {
      const args = replace(bodies[(kill + 1) % 2]!);
      if (!args) break;
      const writer = startCli(args, { cwd: w.root, env });
      await sleep(Math.floor((span * (kill + 4)) / 20));
      if (!writer.hasExited()) {
        try {
          writer.kill();
        } catch {
          // it finished between the test and the kill
        }
      }
      await writer.done;
      fs.rmSync(lock, { force: true });
      const verdict = judgePage(fs.readFileSync(hubPage, 'utf8'));
      outcomes[verdict] = (outcomes[verdict] ?? 0) + 1;
    }
    check(!outcomes['torn'] && !outcomes['initial'], `a killed writer left the page part-written: ${JSON.stringify(outcomes)}`);
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// 32. recovery.rollback-undoes-one-operation-and-verifies-by-readback -- a failed operation is rolled back from its
// journal: prior bodies restored, pages the operation created deleted -- a folder made only for them too -- and
// the rollback verified by reading back, which the writer's refusal says. The fault is injected with no test
// surface in the kernel: a file the operation must rewrite is made read-only, so its write throws after the
// earlier writes have landed. Three writers, three shapes: a capture (a created note, prior ABSENCE), a page added
// to a curated Book in a folder of its own (a created page and folder), and a Book renamed (a directory moved and
// the catalog and title page rewritten, prior BODIES). Each is run again once the fault is cleared, and lands.
if (selected(32)) {
  const w = await seatClaimWorkspace('rollback');
  const readOnly: string[] = [];
  const setReadOnly = (file: string, on: boolean) => {
    fs.chmodSync(file, on ? 0o444 : 0o666);
    if (on) readOnly.push(file);
  };
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const cli = (args: string[]) => runCli([...args, '--workspace', w.workspace], { cwd: w.root, env });
    const shelf = path.join(w.workspace, 'shelf');
    const snapshot = () => listFiles(shelf).map((name) => `${name}:${fs.readFileSync(path.join(shelf, ...name.split('/')), 'utf8').length}`).join('\n');
    const bytes = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<absent>');

    // A CAPTURE whose reader map cannot be rewritten: the note it created is deleted again.
    const holdingMap = path.join(shelf, 'holding', 'wiki', '_index.md');
    const beforeCapture = snapshot();
    setReadOnly(holdingMap, true);
    const failedCapture = cli(['capture', 'holding', '--title', 'Rolled back note', '--body', 'A note that must not survive.', '--json']);
    setReadOnly(holdingMap, false);
    check(failedCapture.exit !== 0 && failedCapture.stderr.includes('Rollback: complete and verified'), `a capture that failed at its reader map did not roll back and say so: ${failedCapture.exit} ${failedCapture.stderr.trim()}`);
    equal(snapshot(), beforeCapture, 'a rolled-back capture left the Book other than it found it');
    equal(cli(['capture', 'holding', '--title', 'Rolled back note', '--body', 'A note that must not survive.', '--json']).exit, 0, 'the capture did not land once the fault was cleared');

    // A PAGE ADDED TO A CURATED BOOK, into a folder that exists only for it.
    equal(cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'A curated Book for the rollback judge.', '--json']).exit, 0, 'the curated Book could not be made');
    equal(w.as(agent, ['desk', 'open', 'book', 'demo', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]).exit, 0, 'the curated Book could not be opened');
    const demoMap = path.join(shelf, 'demo', 'wiki', '_index.md');
    check(fs.existsSync(demoMap), 'the curated Book has no reader map to make read-only');
    const beforePage = snapshot();
    setReadOnly(demoMap, true);
    const failedPage = cli(['book', 'add-page', 'demo', 'fresh-topic/page', '--title', 'Fresh', '--body', '# Fresh\n\nA page that must not survive.', '--seat', 'first', '--json']);
    setReadOnly(demoMap, false);
    check(failedPage.exit !== 0 && failedPage.stderr.includes('Rollback: complete and verified'), `an add-page that failed at its reader map did not roll back and say so: ${failedPage.exit} ${failedPage.stderr.trim()}`);
    equal(snapshot(), beforePage, 'a rolled-back add-page left the Book other than it found it');
    check(!fs.existsSync(path.join(shelf, 'demo', 'wiki', 'fresh-topic')), 'a folder made only for the rolled-back page was left behind');
    equal(cli(['book', 'add-page', 'demo', 'fresh-topic/page', '--title', 'Fresh', '--body', '# Fresh\n\nA page that lands.', '--seat', 'first', '--json']).exit, 0, 'the page did not land once the fault was cleared');

    // A BOOK RENAMED, failing after its directory has moved: moved back, and every rewritten body restored.
    equal(w.as(agent, ['desk', 'close', 'book', 'demo', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]).exit, 0, 'the curated Book could not be closed');
    const titlePage = path.join(shelf, 'demo', 'wiki', '_book.md');
    const catalog = path.join(shelf, '_catalog.md');
    const catalogBefore = bytes(catalog);
    const titleBefore = bytes(titlePage);
    const beforeRename = snapshot();
    const renameArgs = ['shelf', 'rename', 'demo', 'renamed', '--new-title', 'Renamed', '--json'];
    const plan = cli([...renameArgs, '--preflight']);
    const planId = (() => {
      try {
        return String((JSON.parse(plan.stdout) as { plan_id: string }).plan_id);
      } catch {
        return '';
      }
    })();
    check(planId.length > 0, `the rename preflight issued no plan: ${plan.stderr.trim()}`);
    setReadOnly(titlePage, true);
    const failedRename = cli([...renameArgs, '--plan-id', planId]);
    const titleAfterFailure = path.join(shelf, 'demo', 'wiki', '_book.md');
    if (fs.existsSync(titleAfterFailure)) setReadOnly(titleAfterFailure, false);
    const movedTitle = path.join(shelf, 'renamed', 'wiki', '_book.md');
    if (fs.existsSync(movedTitle)) setReadOnly(movedTitle, false);
    check(failedRename.exit !== 0 && failedRename.stderr.includes('Rollback: complete and verified'), `a rename that failed at its title page did not roll back and say so: ${failedRename.exit} ${failedRename.stderr.trim()}`);
    check(fs.existsSync(path.join(shelf, 'demo', 'wiki')) && !fs.existsSync(path.join(shelf, 'renamed')), 'a rolled-back rename did not move the Book back');
    equal(bytes(catalog), catalogBefore, 'a rolled-back rename did not restore the catalog');
    equal(bytes(titlePage), titleBefore, 'a rolled-back rename did not restore the title page');
    equal(snapshot(), beforeRename, 'a rolled-back rename left the Shelf other than it found it');
    const retried = cli([...renameArgs, '--preflight']);
    const retryPlan = (() => {
      try {
        return String((JSON.parse(retried.stdout) as { plan_id: string }).plan_id);
      } catch {
        return '';
      }
    })();
    equal(cli([...renameArgs, '--plan-id', retryPlan]).exit, 0, 'the rename did not land once the fault was cleared');
    check(fs.existsSync(path.join(shelf, 'renamed', 'wiki')), 'the rename that landed did not move the Book');
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    for (const file of readOnly) {
      try {
        fs.chmodSync(file, 0o666);
      } catch {
        // gone with the rollback or the rename
      }
    }
    w.dispose();
  }
}

// --- 33. A TRIAGE BATCH RESUMES FROM ITS JOURNAL, AND NO ACTION RUNS TWICE (S43, S21's group 3) ------------------

// triage.batch-resumes-after-an-interruption -- step 23's interrupted-run recovery, through `library triage
// batch`. Two interruptions, each of the kind the runner must survive:
//   a FAILED action -- the curated Book's reader map made read-only -- in a batch that continues past it: the
//   batch is incomplete, its journal says which actions succeeded, and running the same batch again once the
//   fault is cleared runs ONLY the failed one, leaving what landed byte for byte as it was;
//   a KILLED run -- the process ended while an action was under way, found waiting on a Book lock this judge
//   holds: the journal says `attempting`, and the resume reports that action `interrupted` rather than running
//   it again, because whether its output landed is unknown; the action before it is not repeated either.
// Actions that rewrite their own source (a review, a copy to the Notebook) are left out on purpose: once one
// has succeeded, the batch it belonged to no longer resolves to the same id, which is the oracle's rule.
if (selected(33)) {
  const w = await seatClaimWorkspace('triage');
  let release: (() => void) | null = null;
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const cli = (args: string[]) => runCli([...args, '--workspace', w.workspace], { cwd: w.root, env });
    const parsed = (result: { stdout: string }): Record<string, unknown> => {
      try {
        return JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const shelf = path.join(w.workspace, 'shelf');
    const holdingNotes = path.join(shelf, 'holding', 'wiki', 'notes');
    fs.mkdirSync(path.join(w.workspace, 'notebook', 'sources'), { recursive: true });
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(path.join(w.workspace, 'notebook', 'sources', `${name}.md`), `# Source ${name}\n\nWhat the ${name} article says.\n`);
    }
    equal(cli(['shelf', 'new', 'demo', '--title', 'Demo', '--summary', 'A curated Book for the triage judge.', '--json']).exit, 0, 'the curated Book could not be made');
    for (const title of ['Graduate one', 'Graduate two']) {
      equal(cli(['capture', 'holding', '--title', title, '--body', `The body of ${title}.`, '--json']).exit, 0, `the note '${title}' could not be captured`);
    }
    for (const book of ['demo', 'holding']) {
      equal(w.as(agent, ['desk', 'open', 'book', book, '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]).exit, 0, `the ${book} Book could not be opened`);
    }
    const hashes = () => {
      const found: Record<string, string> = {};
      for (const name of fs.existsSync(holdingNotes) ? fs.readdirSync(holdingNotes).sort() : []) {
        found[name] = sha256Hex(fs.readFileSync(path.join(holdingNotes, name)));
      }
      return found;
    };
    const run = (actions: unknown[], extra: string[]) => cli(['triage', 'batch', '--actions', JSON.stringify(actions), '--json', ...extra]);
    const planOf = (actions: unknown[]) => {
      const preflight = run(actions, ['--preflight']);
      return { preflight, report: parsed(preflight), planId: String(parsed(preflight)['plan_id'] ?? '') };
    };
    const journalOf = (planId: string): Record<string, unknown> => {
      try {
        return JSON.parse(withoutBom(fs.readFileSync(path.join(w.workspace, 'internal', 'triage-journals', `${planId}.json`), 'utf8'))) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const states = (journal: Record<string, unknown>) => ((journal['actions'] as Record<string, unknown>[] | undefined) ?? []).map((record) => `${String(record['kind'])}:${String(record['state'])}`).join(',');

    // 1. A FAILED ACTION, then the same batch again.
    const first = [
      { kind: 'holding', source: 'notebook', source_path: 'notebook/sources/alpha.md', title: 'Alpha note' },
      { kind: 'holding', source: 'notebook', source_path: 'notebook/sources/beta.md', title: 'Beta note' },
      { kind: 'shelf-book', source: 'holding', source_match: 'Graduate two', slug: 'demo', page_path: 'triage/graduated', title: 'Graduated' },
    ];
    const plan = planOf(first);
    check(/^triage-[0-9a-f]{64}$/.test(plan.planId) && plan.report['resume'] === false && plan.report['pending_count'] === 3, `the first preflight did not plan a fresh batch of three: ${plan.preflight.stdout.slice(0, 300)} ${plan.preflight.stderr.trim()}`);
    const notesBefore = hashes();
    const demoMap = path.join(shelf, 'demo', 'wiki', '_index.md');
    fs.chmodSync(demoMap, 0o444);
    const partial = run(first, ['--user-confirmed', '--plan-id', plan.planId]);
    fs.chmodSync(demoMap, 0o666);
    const partialReport = parsed(partial);
    check(
      partial.exit === 0 && partialReport['status'] === 'incomplete' && partialReport['succeeded_count'] === 2 && partialReport['failed_count'] === 1,
      `a batch with one failing action was not reported incomplete with two landed: ${partial.stdout.slice(0, 400)} ${partial.stderr.trim()}`,
    );
    equal(states(journalOf(plan.planId)), 'holding:succeeded,holding:succeeded,shelf-book:failed', 'the journal does not record which actions landed and which failed');
    check(!fs.existsSync(path.join(shelf, 'demo', 'wiki', 'triage', 'graduated.md')), 'the failed page exists');
    const notesAfterPartial = hashes();
    const landed = Object.keys(notesAfterPartial).filter((name) => !(name in notesBefore));
    equal(landed.length, 2, `the partial batch left ${landed.length} new notes, not the two that succeeded`);

    const again = planOf(first);
    check(
      again.planId === plan.planId && again.report['resume'] === true && again.report['pending_count'] === 1 && again.report['already_succeeded'] === 2,
      `the same batch run again was not recognised as a resume narrowed to the failed action: ${again.preflight.stdout.slice(0, 300)} ${again.preflight.stderr.trim()}`,
    );
    const resumed = run(first, ['--user-confirmed', '--plan-id', plan.planId]);
    const resumedReport = parsed(resumed);
    const outcomes = (resumedReport['outcomes'] as Record<string, unknown>[] | undefined) ?? [];
    check(
      resumed.exit === 0 && resumedReport['status'] === 'complete' && outcomes.filter((row) => row['skipped'] === true).length === 2,
      `the resume did not complete by running only the failed action: ${resumed.stdout.slice(0, 400)} ${resumed.stderr.trim()}`,
    );
    check(fs.existsSync(path.join(shelf, 'demo', 'wiki', 'triage', 'graduated.md')), 'the resumed action did not land its page');
    const notesAfterResume = hashes();
    equal(JSON.stringify(notesAfterResume), JSON.stringify(notesAfterPartial), 'the resume changed or added a note, so an action that had landed ran again');
    const journal = journalOf(plan.planId);
    equal(states(journal), 'holding:succeeded,holding:succeeded,shelf-book:succeeded', 'the resumed journal does not record every action succeeded');
    equal(((journal['actions'] as Record<string, unknown>[] | undefined) ?? []).map((record) => String(record['attempts'])).join(','), '1,1,2', 'the journal says an action was attempted other than once, or the retried one other than twice');

    // 2. A KILLED RUN: the second action waits on the curated Book's lock, which this judge holds, and the run
    // is ended there.
    const second = [
      { kind: 'holding', source: 'notebook', source_path: 'notebook/sources/gamma.md', title: 'Gamma note' },
      { kind: 'shelf-book', source: 'holding', source_match: 'Graduate one', slug: 'demo', page_path: 'triage/interrupted', title: 'Interrupted' },
    ];
    const killPlan = planOf(second);
    check(killPlan.planId.length > 0, `the second batch's preflight gave no plan: ${killPlan.preflight.stderr.trim()}`);
    const beforeKill = hashes();
    release = holdBookLock(w.workspace, 'shelf-demo');
    const victim = startCli(['triage', 'batch', '--actions', JSON.stringify(second), '--user-confirmed', '--plan-id', killPlan.planId, '--json', '--workspace', w.workspace], { cwd: w.root, env });
    let reached = '';
    const until = Date.now() + 20000;
    while (Date.now() < until && !victim.hasExited()) {
      reached = states(journalOf(killPlan.planId));
      if (reached === 'holding:succeeded,shelf-book:attempting') break;
      await sleep(100);
    }
    equal(reached, 'holding:succeeded,shelf-book:attempting', 'the run never reached the action this judge holds up, so there is nothing to interrupt');
    victim.kill();
    await victim.done;
    release();
    release = null;
    // A crashed run's lock is its leftover, stale only after thirty minutes; removing it is the remedy its
    // refusal names. The judge's own lock on the Book is already gone.
    for (const name of fs.readdirSync(path.join(w.workspace, 'internal', 'book-locks'))) {
      if (name.startsWith('triage-triage-')) fs.rmSync(path.join(w.workspace, 'internal', 'book-locks', name), { force: true });
    }
    const afterKill = hashes();
    equal(Object.keys(afterKill).filter((name) => !(name in beforeKill)).length, 1, 'the killed run did not land exactly its first action');

    const killResume = planOf(second);
    check(killResume.report['resume'] === true && killResume.report['pending_count'] === 1, `the killed batch was not resumable from its journal: ${killResume.preflight.stdout.slice(0, 300)} ${killResume.preflight.stderr.trim()}`);
    const afterward = run(second, ['--user-confirmed', '--plan-id', killPlan.planId]);
    const afterwardReport = parsed(afterward);
    const afterwardOutcomes = (afterwardReport['outcomes'] as Record<string, unknown>[] | undefined) ?? [];
    check(
      afterward.exit === 0 && afterwardReport['status'] === 'incomplete' && afterwardReport['interrupted_count'] === 1,
      `the resume after a killed run did not report the interrupted action: ${afterward.stdout.slice(0, 400)} ${afterward.stderr.trim()}`,
    );
    equal(afterwardOutcomes.map((row) => `${String(row['kind'])}:${String(row['state'])}:${String(row['skipped'])}`).join(','), 'holding:succeeded:true,shelf-book:interrupted:false', 'the resume ran an action again, or did not leave the interrupted one alone');
    check(!fs.existsSync(path.join(shelf, 'demo', 'wiki', 'triage', 'interrupted.md')), 'the interrupted action was run again by the resume');
    equal(JSON.stringify(hashes()), JSON.stringify(afterKill), 'the resume changed or added a note');
    equal(states(journalOf(killPlan.planId)), 'holding:succeeded,shelf-book:interrupted', 'the journal does not record the interrupted action as interrupted');
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    if (release) release();
    w.dispose();
  }
}

// --- 34. A TRIAGE BATCH CARRIES MORE THAN ONE NOTEBOOK ACTION (S44) ------------------------------------------

// triage.batch-carries-more-than-one-notebook-action -- a Report Inbox claim of S43's, confirmed in both
// implementations: every Notebook action names the seat's master index in its write set, and the batch refused
// any two actions naming one path, so a batch could carry at most one Notebook action. The index is re-rendered,
// never created. No differential row can hold this -- the oracle writes the shared layout ADR-0029 retires and
// the kernel only a seat's own -- so it is judged here, through `library triage batch` in a seat's Notebook: one
// topic made by a first batch, then a batch of two Notebook actions, one into that topic and one into a new one.
if (selected(34)) {
  const w = await seatClaimWorkspace('triage-notebook');
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: String(agent), AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
    const cli = (args: string[]) => runCli([...args, '--workspace', w.workspace], { cwd: w.root, env });
    const parsed = (result: { stdout: string }): Record<string, unknown> => {
      try {
        return JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    for (const title of ['Topic seed note', 'Existing topic note', 'New topic note']) {
      equal(cli(['capture', 'holding', '--title', title, '--body', `The body of ${title}.`, '--json']).exit, 0, `the note '${title}' could not be captured`);
    }
    equal(w.as(agent, ['desk', 'open', 'book', 'holding', '--location', 'shelf', '--seat', 'first', '--workspace', w.workspace]).exit, 0, 'the Holding Shelf could not be opened');
    const confirmBatch = (actions: unknown[], label: string) => {
      const preflight = cli(['triage', 'batch', '--actions', JSON.stringify(actions), '--seat', 'first', '--preflight', '--json']);
      const planId = String(parsed(preflight)['plan_id'] ?? '');
      check(/^triage-[0-9a-f]{64}$/.test(planId), `${label}: the preflight issued no plan: ${preflight.stderr.trim()}`);
      const confirmed = cli(['triage', 'batch', '--actions', JSON.stringify(actions), '--seat', 'first', '--user-confirmed', '--plan-id', planId, '--json']);
      check(confirmed.exit === 0 && parsed(confirmed)['status'] === 'complete', `${label}: the confirmed batch did not complete: ${confirmed.stdout.slice(0, 300)} ${confirmed.stderr.trim()}`);
    };

    // A first batch makes the topic the second one writes into, so the second holds both branches.
    confirmBatch([{ kind: 'notebook', source: 'holding', source_match: 'Topic seed note', topic: 'kept-topic' }], 'the seeding batch');
    const notebook = path.join(w.workspace, 'notebook');
    const topicDirectory = (topic: string) => listFiles(notebook).map((name) => name.split('/')).find((parts) => parts.includes(topic) && parts[parts.length - 1] === '_index.md');
    check(topicDirectory('kept-topic') !== undefined, 'the seeding batch made no topic index, so there is no existing topic to write into');

    confirmBatch(
      [
        { kind: 'notebook', source: 'holding', source_match: 'Existing topic note', topic: 'kept-topic' },
        { kind: 'notebook', source: 'holding', source_match: 'New topic note', topic: 'fresh-topic' },
      ],
      'the batch of two Notebook actions',
    );
    const files = listFiles(notebook);
    check(files.some((name) => name.includes('kept-topic/') && name.endsWith('existing-topic-note.md')), `the note into the existing topic did not land: ${files.join(', ')}`);
    check(files.some((name) => name.includes('fresh-topic/') && name.endsWith('new-topic-note.md')), `the note into the new topic did not land: ${files.join(', ')}`);
    check(topicDirectory('fresh-topic') !== undefined, `the new topic has no index: ${files.join(', ')}`);
    const master = files.filter((name) => name.endsWith('_master-index.md')).map((name) => fs.readFileSync(path.join(notebook, ...name.split('/')), 'utf8')).join('\n');
    check(master.includes('kept-topic') && master.includes('fresh-topic'), `the seat's master index does not list both topics: ${master.slice(0, 300)}`);
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// --- 35. A TIER 0 SEAT READS AND OPENS WHAT ITS LOCAL COLLECTION HOLDS (S46, ADR-0044) ------------------------

// seat.tier0-reads-and-opens-its-local-collection -- ADR-0044 makes a workspace with no endpoint the default
// route, and S45 measured the release refusing its first Project read ("Virtual Desk configuration is missing
// .library-project") and its first Desk write ("Virtual Desk is not configured in this workspace"): both asked
// for the Basic Memory pin a Tier 0 init never writes. The same pin gated every reader tool that reads the Desk,
// so a Tier 0 seat could not read its own Holding Shelf either. No oracle has a local collection, so this is
// judged, and every call goes through the front door with no endpoint anywhere in its environment -- a read
// that reached for Basic Memory would refuse for want of one, never answer.
if (selected(35)) {
  const w = await seatClaimWorkspace('tier0-reads', { pin: false });
  try {
    const agent = w.startAgent();
    equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the Tier 0 seat could not be created');
    const read = (tool: string, args: string[]) => {
      const result = w.as(agent, ['mcp', 'call', tool, ...args, '--seat', 'first', '--workspace', w.workspace]);
      try {
        const envelope = JSON.parse(result.stdout) as { result: { content: { text: string }[]; isError: boolean } };
        return { error: envelope.result.isError, text: envelope.result.content[0]?.text ?? '' };
      } catch {
        return { error: true, text: `unparseable: ${result.stdout.slice(0, 200)} ${result.stderr.trim()}` };
      }
    };
    const desk = (args: string[]) => w.as(agent, ['desk', ...args, '--seat', 'first', '--workspace', w.workspace]);

    // The seat's own Project: its root, the briefing (which reads the connections page too), a missing page.
    const root = read('read_open_project_page', ['--slug', 'alpha', '--page', '_project']);
    check(!root.error && root.text.startsWith('# alpha'), `a Tier 0 seat could not read its own Project's root: ${root.text.slice(0, 200)}`);
    const briefing = read('read_open_project_briefing', ['--slug', 'alpha']);
    check(!briefing.error && briefing.text.startsWith('Project return briefing - alpha'), `the Tier 0 return briefing did not answer: ${briefing.text.slice(0, 200)}`);
    const missing = read('read_open_project_page', ['--slug', 'alpha', '--page', 'no-such-page']);
    check(missing.error && missing.text.includes('That page is not in this Project.'), `a missing local Project page was not refused as missing: ${missing.text.slice(0, 200)}`);
    const escape = read('read_open_project_page', ['--slug', 'alpha', '--page', '../beta/_project']);
    check(escape.error && !escape.text.includes('# beta'), `a page path walked out of the open Project: ${escape.text.slice(0, 200)}`);

    // A second Project is closed until the Desk opens it, and closed again after.
    const closed = read('read_open_project_page', ['--slug', 'beta', '--page', '_project']);
    check(closed.error && closed.text.includes("Project 'beta' is closed."), `a Project not on the Desk was not refused as closed: ${closed.text.slice(0, 200)}`);
    const opened = desk(['open', 'project', 'beta']);
    equal(opened.exit, 0, `a Tier 0 Desk could not open a Project: ${opened.stderr.trim()}`);
    const betaRoot = read('read_open_project_page', ['--slug', 'beta', '--page', '_project']);
    check(!betaRoot.error && betaRoot.text.startsWith('# beta'), `an opened local Project could not be read: ${betaRoot.text.slice(0, 200)}`);
    equal(desk(['close', 'project', 'beta']).exit, 0, 'a Tier 0 Desk could not close a Project');
    check(read('read_open_project_page', ['--slug', 'beta', '--page', '_project']).error, 'a closed local Project stayed readable');
    const invented = desk(['open', 'project', 'no-such-hub']);
    check(invented.exit !== 0 && invented.stderr.includes('no-such-hub'), `a Tier 0 Desk opened a Project the local collection does not hold: ${invented.stdout.slice(0, 200)}`);

    // The Holding Shelf and the Report Inbox, which init lays out in every workspace.
    const shelfOpen = desk(['open', 'book', 'reports', '--location', 'shelf']);
    equal(shelfOpen.exit, 0, `a Tier 0 Desk could not open the Report Inbox: ${shelfOpen.stderr.trim()}`);
    const inbox = read('read_open_book_page', ['--slug', 'reports', '--page', '_index']);
    check(!inbox.error && inbox.text.trim().length > 0, `a Tier 0 seat could not read an open Shelf Book: ${inbox.text.slice(0, 200)}`);

    // A Book in the local collection, where the shared layout puts it: its catalog, and its page once open.
    const bookWiki = path.join(w.workspace, 'collection', 'books', 'field-guide', 'wiki');
    fs.mkdirSync(bookWiki, { recursive: true });
    fs.writeFileSync(path.join(bookWiki, 'birds.md'), '# Birds\n\nA local collection page.\n');
    const catalog = read('read_book_catalog', []);
    check(!catalog.error && catalog.text.includes("The Books in this workspace's local collection."), `the Tier 0 Book Catalog did not answer from the local collection: ${catalog.text.slice(0, 200)}`);
    const sharedCatalog = read('read_book_catalog', ['--location', 'shared']);
    check(!sharedCatalog.error && sharedCatalog.text.startsWith('# Books'), `the Tier 0 collection catalog did not answer: ${sharedCatalog.text.slice(0, 200)}`);
    const closedBook = read('read_open_book_page', ['--slug', 'field-guide', '--page', 'birds']);
    check(closedBook.error && closedBook.text.includes("Book 'field-guide' is closed."), `a closed local-collection Book was not refused as closed: ${closedBook.text.slice(0, 200)}`);
    equal(desk(['open', 'book', 'field-guide']).exit, 0, 'a Tier 0 Desk could not open a Book in its local collection');
    const birds = read('read_open_book_page', ['--slug', 'field-guide', '--page', 'birds']);
    check(!birds.error && birds.text.startsWith('# Birds'), `an open local-collection Book could not be read: ${birds.text.slice(0, 200)}`);
    const noBook = desk(['open', 'book', 'no-such-book']);
    check(noBook.exit !== 0 && noBook.stderr.includes('no-such-book'), `a Tier 0 Desk opened a Book the local collection does not hold: ${noBook.stdout.slice(0, 200)}`);

    // suggest_active_projects ranks the local Hubs rather than refusing the default route.
    const suggested = read('suggest_active_projects', ['--query', 'beta']);
    check(!suggested.error && suggested.text.includes('[beta]'), `suggest_active_projects did not answer from the local collection: ${suggested.text.slice(0, 200)}`);

    // Nothing above wrote a Basic Memory pin or endpoint to get there.
    for (const name of ['.library-project', '.library-mcp-url']) {
      check(!fs.existsSync(path.join(w.workspace, '.claude', name)), `a Tier 0 read or Desk write left ${name} behind`);
    }
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// --- 36. A TIER 0 WORKSPACE'S OWN READER READS ITS LOCAL COLLECTION (S46, ADR-0044) ------------------------------

// workspace.tier0-init-registers-the-kernel-reader -- S7 in Windows Sandbox, rel46a: a Claude session's first Project
// read went to the reader `library init` registered, which on Windows was the PowerShell adapter, and the adapter has
// no local collection ("Virtual Desk configuration is missing .library-project"). A compiled kernel attached to its
// local collection now registers itself -- `bin/library mcp serve` -- for Claude and for Codex, as a POSIX host always
// has; a Basic Memory workspace keeps the adapter, and so does a kernel run from source, which has no binary to name.
// Judged through the front door: the registration read back from the files init wrote, and the registered command
// LAUNCHED as a harness launches it, asked for the seat's Project page over stdio.
if (selected(36)) {
  const w = await seatClaimWorkspace('tier0-reader', { pin: false });
  try {
    const version = runCli(['--version']);
    const compiled = (() => {
      try {
        return (JSON.parse(version.stdout) as { compiled: boolean }).compiled === true;
      } catch {
        return false;
      }
    })();
    const mcp = JSON.parse(fs.readFileSync(path.join(w.workspace, '.mcp.json'), 'utf8').replace(/^﻿/, '')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers['validated-book-reader'];
    const codex = fs.readFileSync(path.join(w.workspace, '.codex', 'config.toml'), 'utf8');
    const kernelReader = compiled || process.platform !== 'win32';
    if (kernelReader) {
      check(
        server !== undefined && /\/bin\/library$/.test(server.command) && server.args[0] === 'mcp' && server.args[1] === 'serve',
        `a Tier 0 init by a compiled kernel registered ${server ? `${server.command} ${server.args.join(' ')}` : 'no reader'} for Claude, not bin/library mcp serve`,
      );
      check(/command = "[^"]*\/bin\/library"/.test(codex) && codex.includes('"mcp", "serve"'), `a Tier 0 init by a compiled kernel registered another reader for Codex: ${codex.slice(0, 400)}`);
    } else {
      check(server !== undefined && server.command === 'powershell.exe', `a Tier 0 init from source registered ${server ? server.command : 'no reader'}, where only the adapter is there to name`);
    }

    // A Basic Memory workspace keeps the adapter: its collection is the adapter's to read.
    const shared = path.join(w.root, 'shared');
    runCli(['init', shared, '--registry-root', path.join(w.root, 'reg'), '--mcp-url', 'http://127.0.0.1:1/mcp', '--collection-id', '44444444-4444-4444-4444-444444444444'], { cwd: w.root, env: { LIBRARY_WORKSPACES: path.join(w.root, 'reg') } });
    const sharedMcp = JSON.parse(fs.readFileSync(path.join(shared, '.mcp.json'), 'utf8').replace(/^﻿/, '')) as { mcpServers: Record<string, { command: string }> };
    if (process.platform === 'win32') {
      check(sharedMcp.mcpServers['validated-book-reader']?.command === 'powershell.exe', `a Basic Memory init on Windows stopped registering the adapter: ${sharedMcp.mcpServers['validated-book-reader']?.command}`);
    }

    // RE-RUN OVER THE LIBRARY'S OWN OLD ADAPTER: a workspace an earlier release initialised carries the adapter entry,
    // and init replaces what is the Library's rather than refusing it as a conflict (the matrix's idempotent rows found
    // a second init refused, S46). An entry someone else wrote under the same name is still refused.
    if (kernelReader && process.platform === 'win32') {
      const mcpPath = path.join(w.workspace, '.mcp.json');
      const adapterEntry = { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/old/program/.claude/adapters/Validated-BookReader.ps1', '-StateDirectory', `${w.workspace.replace(/\\/g, '/')}/.claude`] };
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'validated-book-reader': adapterEntry, other: { command: 'x' } } }, null, 2));
      const again = runCli(['init', w.workspace, '--registry-root', path.join(w.root, 'reg')], { cwd: w.root, env: { LIBRARY_WORKSPACES: path.join(w.root, 'reg') } });
      const redone = JSON.parse(fs.readFileSync(mcpPath, 'utf8').replace(/^\uFEFF/, '')) as { mcpServers: Record<string, { command: string }> };
      check(again.exit === 0 && /\/bin\/library$/.test(redone.mcpServers['validated-book-reader']?.command ?? ''), `init over the Library's own adapter entry did not replace it: exit ${again.exit} ${again.stderr.trim().slice(0, 200)}`);
      check(redone.mcpServers['other']?.command === 'x', "init over the Library's own adapter entry dropped another server");
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'validated-book-reader': { command: 'node', args: ['mine.js'] } } }, null, 2));
      const foreign = runCli(['init', w.workspace, '--registry-root', path.join(w.root, 'reg')], { cwd: w.root, env: { LIBRARY_WORKSPACES: path.join(w.root, 'reg') } });
      check(foreign.exit !== 0 && foreign.stderr.includes('cannot be merged'), `init replaced a reader entry the Library did not write: exit ${foreign.exit}`);
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'validated-book-reader': { command: server?.command ?? '', args: server?.args ?? [] } } }, null, 2));
    }

    // The registered reader, launched as a harness launches it, reads the seat's own Project.
    if (kernelReader && server !== undefined) {
      const agent = w.startAgent();
      equal(w.createSeat('first', 'alpha', agent).exit, 0, 'the seat could not be created');
      const requests =
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_open_project_page', arguments: { slug: 'alpha', page: '_project' } } },
        ]
          .map((request) => JSON.stringify(request))
          .join('\n') + '\n';
      const command = process.platform === 'win32' && !server.command.endsWith('.exe') ? `${server.command}.exe` : server.command;
      const served = spawnSync(command, server.args, {
        cwd: w.workspace,
        input: requests,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: path.join(w.root, 'reg'), LIBRARY_SEAT: 'first', CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' },
      });
      const answer = (served.stdout ?? '')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as { id?: number; result?: { content?: { text: string }[]; isError?: boolean } };
          } catch {
            return {};
          }
        })
        .find((message) => message.id === 2);
      check(
        answer?.result?.isError === false && (answer.result.content?.[0]?.text ?? '').startsWith('# alpha'),
        `the reader init registered did not read the seat's Project: ${JSON.stringify(answer ?? served.stdout).slice(0, 300)} ${String(served.stderr ?? '').slice(0, 200)}`,
      );
    }
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    w.dispose();
  }
}

// --- 37. `seat start` FINDS AN AGENT CLAUDE CODE'S INSTALLER LEFT OFF PATH (S47, the Report Inbox) ----------------

// S7 in Windows Sandbox: Claude Code's installer puts `~\.local\bin\claude.exe` there and not on PATH, so the README's
// `library seat start me --project my-project` refused in a new terminal. On Windows a bare agent name PATH does not
// resolve is started from `~\.local\bin`; a name found in neither place is still refused, naming both. The agent here
// is the kernel itself, copied into a scratch profile's `.local\bin` under a name nothing else carries.
if (selected(37) && process.platform === 'win32') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-agentbin-')));
  try {
    const registry = path.join(root, 'reg');
    const home = path.join(root, 'home');
    const userBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(userBin, { recursive: true });
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', USERPROFILE: home };
    const workspace = path.join(root, 'ws');
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'init for the agent-bin workspace failed');
    equal(runCli(['hub', 'new', 'demo', '--title', 'Demo', '--purpose', 'A Project for the agent-bin self-test.', '--workspace', workspace], { cwd: workspace, env }).exit, 0, 'the Project Hub could not be made');
    const kernel = KERNEL_COMMAND.length ? KERNEL_COMMAND : [process.execPath, CLI];
    const name = `deskagent${process.pid}`;

    const missing = runCli(['seat', 'start', 'reader', '--project', 'demo', '--workspace', workspace, '--command', name], { cwd: workspace, env });
    check(missing.exit === 127 && missing.stderr.includes(path.join(userBin, `${name}.exe`)), `an agent found nowhere was not refused naming ~\\.local\\bin: ${missing.exit} ${missing.stderr.trim().slice(0, 300)}`);

    fs.copyFileSync(kernel[0]!, path.join(userBin, `${name}.exe`));
    const started = runCli(['seat', 'start', 'reader', '--workspace', workspace, '--command', name, '--', ...kernel.slice(1), '--version'], { cwd: workspace, env });
    check(started.exit === 0 && started.stdout.includes('"binary_version"'), `an agent in ~\\.local\\bin and off PATH was not started: ${started.exit} ${started.stderr.trim().slice(0, 300)}`);
    check(started.stderr.includes('which is not on PATH'), `starting an agent from ~\\.local\\bin did not say so: ${started.stderr.trim().slice(0, 300)}`);
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 38. DOCTOR SAYS WHY A KERNEL HOOK FAILS OPEN ON WINDOWS (S47, the Report Inbox) ------------------------------

// S7 in Windows Sandbox, rel46a: doctor failed the plugin's guards as "a registered hook names a script that is not
// there" -- the conclusion right and the cause wrong. The release ships `bin/library.exe`; the hook was a quoted
// command in shell form, which Claude Code runs through PowerShell where Git Bash is absent, and PowerShell refuses.
// Now `bin/library` resolves to `library.exe` as the shell resolves it, exec form passes, and shell form fails with
// its real cause only where Git Bash is absent. CLAUDE_CODE_GIT_BASH_PATH decides it, as it decides it for Claude Code:
// naming a missing file hides Git Bash and naming a file shows it. (Windows resets ProgramFiles in every process it
// creates, so Git's default folder cannot be hidden from a child; that branch is measured in the Sandbox instead.)
if (selected(38) && process.platform === 'win32') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-shellform-')));
  try {
    const registry = path.join(root, 'reg');
    const config = path.join(root, 'claude-config');
    const system = process.env['SystemRoot'] ?? 'C:\\Windows';
    const bare = [path.join(system, 'System32'), system].join(';');
    const env: Record<string, string> = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', CLAUDE_CONFIG_DIR: config, AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', PATH: bare, Path: bare, CLAUDE_CODE_GIT_BASH_PATH: path.join(root, 'no-git', 'bash.exe') };
    const workspace = path.join(root, 'ws');
    equal(runCli(['init', workspace, '--registry-root', registry], { cwd: root, env }).exit, 0, 'init for the shell-form workspace failed');
    fs.writeFileSync(path.join(workspace, '.claude', 'settings.local.json'), '{}\n');
    const install = path.join(root, 'plugin-install');
    fs.mkdirSync(path.join(install, '.claude-plugin', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'bin', 'library.exe'), 'MZ');
    const kernelProgram = String((JSON.parse(runCli(['--version'], { cwd: root, env }).stdout) as Record<string, unknown>)['program_root']);
    fs.copyFileSync(path.join(kernelProgram, '.claude-plugin', '.mcp.json'), path.join(install, '.claude-plugin', '.mcp.json'));
    fs.writeFileSync(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'deskpost', hooks: './.claude-plugin/hooks/hooks.json', mcpServers: './.claude-plugin/.mcp.json' }));
    fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'deskpost@deskpost': true } }));
    fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'deskpost@deskpost': [{ scope: 'user', installPath: install }] } }));

    // Both forms written from the program's own hooks, whichever form it ships: exec form names `library.exe` with
    // args, shell form names `"<root>/bin/library" hook <verb>` as rel46a's plugin did.
    type HookEntry = { type?: string; command: string; args?: string[] };
    const shipped = JSON.parse(fs.readFileSync(path.join(kernelProgram, '.claude-plugin', 'hooks', 'hooks.json'), 'utf8').replace(/^\uFEFF/, '')) as { hooks: Record<string, { matcher?: string; hooks: HookEntry[] }[]> };
    const verbsOf = (entry: HookEntry): string[] => (entry.args ?? entry.command.replace(/^\s*"[^"]*"\s*/, '').split(/\s+/)).filter((part) => part);
    const rendered = (form: 'exec' | 'shell') => ({
      hooks: Object.fromEntries(
        Object.entries(shipped.hooks).map(([event, blocks]) => [
          event,
          blocks.map((block) => ({
            ...block,
            hooks: block.hooks.map((entry) =>
              form === 'exec'
                ? { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/library.exe', args: verbsOf(entry) }
                : { type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}/bin/library" ${verbsOf(entry).join(' ')}` },
            ),
          })),
        ]),
      ),
    });
    const guards = (extra: Record<string, string> = {}) => {
      const doctor = runCli(["doctor", "--workspace", workspace], { cwd: root, env: { ...env, ...extra } });
      try {
        return ((JSON.parse(doctor.stdout) as { checks: { check: string; status: string; detail: string }[] }).checks.find((row) => row.check === 'workspace.guards-registered')) ?? { status: '(absent)', detail: '' };
      } catch {
        return { status: '(unreadable)', detail: doctor.stdout + doctor.stderr };
      }
    };
    const hooksFile = path.join(install, '.claude-plugin', 'hooks', 'hooks.json');

    fs.writeFileSync(hooksFile, JSON.stringify(rendered('exec')));
    const exec = guards();
    check(exec.status === 'pass', `an exec-form plugin naming library.exe was not read as guarded: ${exec.status} ${exec.detail}`);

    fs.writeFileSync(hooksFile, JSON.stringify(rendered('shell')));
    const shell = guards();
    check(shell.status === 'fail' && shell.detail.includes('shell form') && shell.detail.includes('Git Bash'), `a shell-form plugin with no Git Bash was not failed for its form: ${shell.status} ${shell.detail}`);
    check(!shell.detail.includes('is not there'), `a shell-form plugin whose library.exe exists was called missing: ${shell.detail}`);

    const bash = path.join(root, 'bash.exe');
    fs.writeFileSync(bash, 'MZ');
    const withBash = guards({ CLAUDE_CODE_GIT_BASH_PATH: bash });
    check(withBash.status === 'pass', `a shell-form plugin with Git Bash present was failed: ${withBash.status} ${withBash.detail}`);

    fs.rmSync(path.join(install, 'bin', 'library.exe'));
    const gone = guards();
    check(gone.status === 'fail' && gone.detail.includes('bin/library'), `a plugin whose library.exe is gone was read as guarded: ${gone.status} ${gone.detail}`);
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- 39. A COMPILED WINDOWS INIT REGISTERS THE KERNEL'S OWN HOOKS (S48, the reader's ruling, ADR-0046) -----------

// workspace.compiled-init-registers-the-kernel-hooks -- S7 in Windows Sandbox on v0.2.1: a closed Holding Shelf page
// read by Read was refused, but the denial named tools/Set-VirtualDesk.ps1, because `library init` on Windows
// registered the program's guard scripts and ADR-0045's rewrite lives in the kernel's hook verbs. A compiled kernel now
// registers its five ported hooks -- exec form for Claude, `& "<program>/bin/library" hook <verb>` for Codex, which runs
// a hook through powershell.exe -Command -- and keeps the four with no port as PowerShell, which Windows has. A kernel run
// from source has no binary to name and keeps every script. Judged through the front door: the registration read back,
// the hooks LAUNCHED as each harness launches them against a closed Book, and a re-run over the block v0.2.1 wrote.
if (selected(39) && process.platform === 'win32') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-winhooks-')));
  try {
    const registry = path.join(root, 'reg');
    const env = { LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', CLAUDE_PID: '', CODEX_HOME: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '' };
    const cli = (args: string[]) => runCli(args, { cwd: root, env });
    const version = JSON.parse(cli(['--version']).stdout) as { compiled?: boolean; program_root?: string };
    const program = String(version.program_root).replace(/\\/g, '/').replace(/\/+$/, '');
    const compiled = version.compiled === true && fs.existsSync(path.join(program, 'bin', 'library.exe'));
    const workspace = path.join(root, 'ws');
    const init = cli(['init', workspace, '--registry-root', registry]);
    equal(init.exit, 0, `init for the Windows hook workspace failed: ${init.stderr.trim()}`);

    type Entry = { type?: string; command: string; args?: string[]; commandWindows?: string };
    const entriesOf = (relative: string): { event: string; matcher: string; entry: Entry }[] => {
      const out: { event: string; matcher: string; entry: Entry }[] = [];
      try {
        const document = JSON.parse(fs.readFileSync(path.join(workspace, relative), 'utf8').replace(/^﻿/, '')) as { hooks?: Record<string, { matcher?: string; hooks: Entry[] }[]> };
        for (const [event, blocks] of Object.entries(document.hooks ?? {})) for (const block of blocks) for (const entry of block.hooks) out.push({ event, matcher: block.matcher ?? '', entry });
      } catch {
        // an unreadable file registers nothing, and the checks below say so
      }
      return out;
    };
    const spelled = (entry: Entry) => `${entry.command}${entry.args ? ' ' + JSON.stringify(entry.args) : ''}`;
    const claude = entriesOf('.claude/settings.local.json');
    const codex = entriesOf('.codex/hooks.json');
    const binary = `${program}/bin/library.exe`;
    const ported: [string, string][] = [['basic-memory-read', 'PreToolUse'], ['shelf-read', 'PreToolUse'], ['shell-shelf-read', 'PreToolUse'], ['desk-context', 'UserPromptSubmit'], ['settings-integrity', 'ConfigChange']];
    const unported = ['Get-PlaybookContext.ps1', 'Add-SearchHitReminder.ps1', 'Restore-CompactedGuidance.ps1', 'Get-SeatStartContext.ps1'];

    if (!compiled) {
      check(claude.length > 0 && claude.every((row) => row.entry.command === 'powershell.exe'), `an init from source registered something other than the guard scripts for Claude: ${claude.map((row) => spelled(row.entry)).join(' | ')}`);
    } else {
      const exec = claude.filter((row) => row.entry.command === binary);
      check(exec.length === 5 && exec.every((row) => Array.isArray(row.entry.args) && row.entry.args[0] === 'hook' && row.entry.args.length === 2), `a compiled init's Claude hooks are not the kernel's five in exec form: ${claude.map((row) => spelled(row.entry)).join(' | ')}`);
      for (const [verb, event] of ported) check(exec.some((row) => row.event === event && row.entry.args?.[1] === verb), `a compiled init registered no ${event} '${verb}' for Claude`);
      const scripts = claude.filter((row) => row.entry.command !== binary);
      check(scripts.every((row) => row.entry.command === 'powershell.exe' && unported.some((name) => spelled(row.entry).includes(name))), `a compiled init registered a guard script the kernel has ported: ${scripts.map((row) => spelled(row.entry)).join(' | ')}`);
      for (const name of unported) check(scripts.some((row) => spelled(row.entry).includes(name)), `a compiled init dropped the unported ${name}, which Windows can still run`);

      const codexPrefix = `& "${program}/bin/library" hook `;
      check(codex.length === 4 && codex.every((row) => row.entry.command.startsWith(codexPrefix) && row.entry.commandWindows === row.entry.command), `a compiled init's Codex hooks are not the kernel's four behind '& ': ${codex.map((row) => row.entry.command).join(' | ')}`);
      check(codex.filter((row) => row.entry.command.endsWith(' --reader-tool-prefix mcp__validated_book_reader__')).length === 3, "a compiled init's Codex hooks do not hand three of them Codex's reader prefix");

      // THE REGISTRATIONS START, AND SAY WHAT THE READER CAN RUN. A closed Holding Shelf page, the seat's Desk empty.
      const desk = path.join(workspace, '.claude', 'seats', 'reader');
      fs.mkdirSync(desk, { recursive: true });
      fs.writeFileSync(path.join(desk, '.open-books'), '');
      fs.writeFileSync(path.join(desk, '.open-projects'), '');
      const page = path.join(workspace, 'shelf', 'holding', 'wiki', '_index.md');
      const hookEnv = { ...process.env, ...env, LIBRARY_SEAT: 'reader' };
      const shelfGuard = exec.find((row) => row.entry.args?.[1] === 'shelf-read')?.entry;
      // Claude's exec form: the command spawned directly, no shell (claude 2.1.282, S46).
      const ran = spawnSync(shelfGuard?.command ?? 'false', shelfGuard?.args ?? [], { cwd: workspace, env: hookEnv, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: page } }), encoding: 'utf8', timeout: 30000 });
      const denial = ran.stdout ?? '';
      check(denial.includes('"permissionDecision":"deny"') && denial.includes("Shelf Book 'holding' is closed"), `the registered Claude shelf guard did not deny a closed Book: ${ran.status} ${denial} ${ran.stderr}`);
      check(denial.includes('library desk open book holding --location shelf') && !denial.includes('.ps1'), `the registered Claude shelf guard's denial still names a PowerShell helper: ${denial}`);
      // Codex's form: through powershell.exe -Command, as codex-cli 0.153.4 runs a hook on Windows (S46).
      const shellGuard = codex.find((row) => / hook shell-shelf-read /.test(row.entry.command))?.entry.command ?? 'exit 1';
      const viaCodex = spawnSync('powershell.exe', ['-NoProfile', '-Command', shellGuard], { cwd: workspace, env: hookEnv, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `Get-Content "${page}"` } }), encoding: 'utf8', timeout: 60000 });
      const codexDenial = viaCodex.stdout ?? '';
      check(codexDenial.includes('"permissionDecision":"deny"') && !codexDenial.includes('.ps1'), `the registered Codex shell guard, run through powershell.exe, did not deny a closed Book in the kernel's words: ${viaCodex.status} ${codexDenial.slice(0, 400)} ${String(viaCodex.stderr ?? '').slice(0, 300)}`);

      const doctor = cli(['doctor', '--workspace', workspace]);
      const rows = (() => { try { return (JSON.parse(doctor.stdout) as { checks: { check: string; status: string; detail: string }[] }).checks; } catch { return []; } })();
      const row = (name: string) => rows.find((item) => item.check === name) ?? { status: '(absent)', detail: '' };
      equal(row('workspace.guards-registered').status, 'pass', `doctor did not pass a compiled init's Claude hooks: ${row('workspace.guards-registered').detail}`);
      check(row('workspace.codex-guards-registered').status !== 'fail', `doctor failed a compiled init's Codex hooks: ${row('workspace.codex-guards-registered').detail}`);

      // A RE-RUN REPLACES WHAT v0.2.1 WROTE: guard-script paths into this program are the Library's, not foreign.
      const local = path.join(workspace, '.claude', 'settings.local.json');
      const old = { hooks: { PreToolUse: [{ matcher: 'Read|Grep|Glob|Write|Edit', hooks: [{ type: 'command', command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${program}/.claude/hooks/Guard-ShelfBookRead.ps1`] }] }] } };
      fs.writeFileSync(local, JSON.stringify(old));
      const rerun = cli(['init', workspace, '--registry-root', registry]);
      const redone = fs.readFileSync(local, 'utf8');
      check(rerun.exit === 0 && !redone.includes('Guard-ShelfBookRead.ps1') && redone.includes('library.exe'), `init over v0.2.1's guard-script block did not replace it: ${rerun.exit} ${rerun.stderr.trim().slice(0, 300)}`);
    }
  } catch (error) {
    failures.push(`section stopped early: ${(error as Error).message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- the verdict ----------------------------------------------------------------------------------------

// A selection that ran nothing -- a section number that does not exist -- is not a pass.
if (SECTIONS.size > 0 && checks === 0) failures.push(`LIBRARY_SELFTEST_SECTIONS selected no checks: ${[...SECTIONS].join(',')}`);
if (failures.length) {
  process.stderr.write(`kernel self-test FAILED (${failures.length} of ${checks}): ${failures.join('; ')}\n`);
  process.exit(1);
}
process.stdout.write(`kernel self-test passed (${checks} checks).\n`);
