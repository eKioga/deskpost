/**
 * IS THIS KICKOFF COMPLETE? (docs/kickoff-template.md; Eric, 2026-10-13: "proceed with your recommendations" to the
 * dev loop review's option A.) The orchestrator runs `node tools/kickoff-check.mts <file>` on a Kickoff's content file before
 * `hub edit --mode new-page`; since kickoffs/s174 row 1 the rules live in `kernel/src/kickoffcheck.ts`, which `hub edit` and
 * `deskpost kickoff check` call too, and this file is a thin wrapper that keeps the tool's usage, exits and lines.
 *
 * A COPY OUTSIDE A CHECKOUT REFUSES IN ONE LINE (c73-r2, section 556): `docs/adr` beside this copy is checked before the
 * kernel module is imported, so a copy with no checkout around it says so instead of failing on the import.
 * It reads the machine slot setting and checks BASE ancestry in slot mode; it never writes.
 */

const USAGE = 'node tools/kickoff-check.mts <kickoff file>: checks the sections docs/kickoff-template.md requires; --repo <dir> selects the BASE checkout; --train <register file> (internal/train/register.json) also checks its TRAIN id';

async function main(argv: string[]): Promise<number> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 2;
  }
  let file: string | undefined, trainFile: string | undefined, repository: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--train' && !trainFile && argv[index + 1] && !argv[index + 1]!.startsWith('-')) trainFile = argv[++index];
    else if (arg === '--repo' && !repository && argv[index + 1] && !argv[index + 1]!.startsWith('-')) repository = argv[++index];
    else if (!arg.startsWith('-') && !file) file = arg;
    else {
      process.stderr.write(`kickoff-check: cannot read argument '${arg}'; usage: ${USAGE}\n`);
      return 2;
    }
  }
  if (!file) {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    process.stderr.write(`kickoff-check: no such file: ${file}\n`);
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  const adrFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'adr');
  if (!fs.existsSync(adrFolder)) {
    process.stderr.write(`kickoff-check: no docs/adr beside this copy of the tool (${adrFolder}): run it from inside a checkout\n`);
    return 2;
  }
  const adrFiles = fs.readdirSync(adrFolder);
  const kc = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'src', 'kickoffcheck.ts')).href) as typeof import('../kernel/src/kickoffcheck.ts');
  let train: { record: unknown } | undefined;
  let unreadable: string | null = null;
  if (trainFile) {
    try { train = { record: JSON.parse(fs.readFileSync(trainFile, 'utf8')) }; }
    catch (error) { unreadable = `cannot read train register '${trainFile}': ${(error as Error).message}`; }
  }
  // Only this source tool passes the section claims (kickoffs/s194 spare S1): the installed check's verdict is unchanged.
  let covers: Record<string, string[]> | undefined;
  let newPathMapped: ((file: string) => boolean) | undefined;
  // With each lane's claim file (kickoffs/s210 row 3), merged as the commit check merges them.
  try {
    const select = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'section-select.mts')).href) as typeof import('./section-select.mts');
    const repo = path.join(adrFolder, '..', '..');
    covers = select.mergeCovers(select.coversFiles(name => fs.existsSync(path.join(repo, name)) ? fs.readFileSync(path.join(repo, name), 'utf8') : null)).sections;
    newPathMapped = file => {
      if (fs.existsSync(path.join(repo, file)) || select.pathChecks([file]).length) return true;
      // Mapped documents and section-only rules can have no named checks. The selector distinguishes them from absence.
      try { select.selectSections({ changed: [file], selftestHunks: [], selftestText: '', covers: { schema: 1, about: '', sections: covers ?? {} } }); return true; }
      catch (error) { if ((error as Error).message.startsWith('unmapped changed path ')) return false; throw error; }
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/g, ' ');
    process.stderr.write(`kickoff-check: warning: section claims unreadable (${message}); the pinned-section rule is off for this check\n`);
    covers = undefined;
  }
  // The lane rule requires readable, well-formed docs/areas.json (c155-r2 spare S2).
  let areas: import('../kernel/src/kickoffcheck.ts').KickoffAreas | undefined;
  // The new-section rule reads its numbers from the same file, and refuses a Kickoff adding sections when it cannot (s210 row 3).
  let areasText: string | null = null;
  let numbering: ReturnType<typeof kc.parseKickoffNumbering>;
  try { areasText = fs.readFileSync(path.join(adrFolder, '..', 'areas.json'), 'utf8'); numbering = kc.parseKickoffNumbering(areasText); }
  catch (error) { process.stderr.write(`kickoff-check: docs/areas.json cannot be read: ${(error as Error).message}\n`); return 1; }
  let shared: string[];
  try {
    const record = JSON.parse(areasText ?? '') as Partial<import('../kernel/src/kickoffcheck.ts').KickoffAreas> & { shared?: unknown };
    const listMap = (value: unknown) => !!value && typeof value === 'object' && Object.values(value).every(list => Array.isArray(list) && list.every(item => typeof item === 'string'));
    if (!record || !listMap(record.lanes) || !listMap(record.areas)) throw new Error('lanes and areas must map names to string lists');
    areas = { lanes: record.lanes!, areas: record.areas! };
    if (record.shared !== undefined && (!Array.isArray(record.shared) || record.shared.some(item => typeof item !== 'string'))) {
      throw new Error('shared must list paths');
    }
    shared = (record.shared ?? []) as string[];
  } catch (error) {
    process.stderr.write(`kickoff-check: docs/areas.json is malformed: ${(error as Error).message}\n`);
    return 1;
  }
  const checkout = path.resolve(adrFolder, '..', '..');
  const listed = new Set([...Object.values(areas.areas).flat(), ...shared]);
  for (const file of new Set(kc.ownsPaths(text).patterns)) {
    if (!/^(?:kernel\/(?:src|test)|tools)\//.test(file) || listed.has(file)) continue;
    if (fs.statSync(path.join(checkout, file), {throwIfNoEntry: false})?.isFile()) {
      process.stderr.write(`kickoff-check: warning: ${file} is absent from docs/areas.json; run node tools/areas.mts --check\n`);
    }
  }
  const { buildEnvelope, KICKOFF_ID } = await import('../kernel/src/kickoffenvelope.ts');
  const { KICKOFF_SIZE_LIMIT } = await import('../kernel/src/kickoff.ts');
  const name = path.basename(file, path.extname(file));
  const envelope = buildEnvelope(KICKOFF_ID.test(name) ? name : 'check', text);
  if (envelope.bytes > KICKOFF_SIZE_LIMIT) {
    process.stderr.write(`kickoff-check: warning: ${envelope.bytes} bytes exceeds the ${KICKOFF_SIZE_LIMIT} bytes limit; kickoff send to another office will refuse it.\n`);
  }
  const verdict = kc.kickoffVerdict(text, { adrFiles, train, covers, areas, numbering, newPathMapped });
  if (unreadable !== null) verdict.problems.push(unreadable);
  const { readSlots } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'test', 'gate-lock.ts')).href) as typeof import('../kernel/test/gate-lock.ts');
  const slots = readSlots(line => process.stderr.write(line + '\n'));
  if (slots) {
    // The header is the lines before the first required heading (TRAIN:); a body quoting the phrase is not a base (s186).
    const lines = text.split(/\r?\n/);
    const head = lines.slice(0, Math.max(0, lines.findIndex(line => line.startsWith('TRAIN:')))).join('\n');
    const at = head.indexOf('as committed at');
    const base = at < 0 ? undefined : /^as committed at\s*`([a-f0-9]{40})`/.exec(head.slice(at))?.[1];
    if (!base) {
      const held = at < 0 ? '' : (/^as committed at[ \t]*`([^`]*)`/.exec(head.slice(at))?.[1] ?? /^as committed at[ \t]+([^\s`]+)/.exec(head.slice(at))?.[1]?.replace(/[.,;:!?]+$/, '') ?? '');
      verdict.problems.push(`BASE: header holds ${held ? JSON.stringify(held) : 'nothing'} after "as committed at"; name the base in full: a full 40-character lowercase SHA is needed.`);
    }
    else {
      const { spawnSync } = await import('node:child_process');
      // Fixture-only repository override; ordinary invocations compare in this tool's checkout.
      const root = repository || process.env['DESKPOST_KICKOFF_TEST_REPOSITORY'] || path.resolve(adrFolder, '..', '..');
      const git = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', slots.u2Tip, base], { encoding: 'utf8', windowsHide: true });
      if (git.status === 1) verdict.problems.push(`BASE: ${base} is before recorded U2 ${slots.u2Tip}; a Kickoff on code before U2 would not see the gate slots; rebase the unit's base, or --set-slots off first.`);
      else if (git.status !== 0) {
        const error = git.error?.message || `${git.stderr}${git.stdout}`.trim().split(/\r?\n/)[0] || `git exited ${git.status}`;
        verdict.problems.push(`BASE: cannot compare ${base} with recorded U2 ${slots.u2Tip}: ${error}`);
      }
    }
  }
  process.stdout.write(kc.verdictText(file, verdict));
  return verdict.problems.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] ?? '';
if (/kickoff-check\.mts$/.test(invoked.replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
