/**
 * IS THIS KICKOFF COMPLETE? (docs/kickoff-template.md; Eric, 2026-10-13: "proceed with your recommendations" to the
 * dev loop review's option A.) The orchestrator runs `node tools/kickoff-check.mts <file>` on a Kickoff's content file before
 * `hub edit --mode new-page`; since kickoffs/s174 row 1 the rules live in `kernel/src/kickoffcheck.ts`, which `hub edit` and
 * `deskpost kickoff check` call too, and this file is a thin wrapper that keeps the tool's usage, exits and lines.
 *
 * A COPY OUTSIDE A CHECKOUT REFUSES IN ONE LINE (c73-r2, section 556): `docs/adr` beside this copy is checked before the
 * kernel module is imported, so a copy with no checkout around it says so instead of failing on the import.
 * It reads text only; it never writes.
 */

const USAGE = 'node tools/kickoff-check.mts <kickoff file>: checks the sections docs/kickoff-template.md requires; --train <register file> also checks its TRAIN id';

async function main(argv: string[]): Promise<number> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const file = argv[0];
  if (file === '--help' || file === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 2;
  }
  if (!file || !(argv.length === 1 || (argv.length === 3 && argv[1] === '--train' && argv[2]))) {
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
  if (argv[2]) {
    try { train = { record: JSON.parse(fs.readFileSync(argv[2], 'utf8')) }; }
    catch (error) { unreadable = `cannot read train register '${argv[2]}': ${(error as Error).message}`; }
  }
  const verdict = kc.kickoffVerdict(text, { adrFiles, train });
  if (unreadable !== null) verdict.problems.push(unreadable);
  process.stdout.write(kc.verdictText(file, verdict));
  return verdict.problems.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] ?? '';
if (/kickoff-check\.mts$/.test(invoked.replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
