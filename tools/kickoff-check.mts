/**
 * IS THIS KICKOFF COMPLETE? (docs/kickoff-template.md; Eric, 2026-10-13: "proceed with your recommendations" to the
 * dev loop review's option A.) The planner runs `node tools/kickoff-check.mts <file>` on a Kickoff's content file before
 * `hub edit --mode new-page`; self-test section 240 judges the rules on fixtures and on the template itself.
 *
 * The rules, each one a drift the review found in real Kickoffs:
 *   (a) every required section is present, as a line that starts with its name and a colon (`WHY NOW:`), in the
 *       template's order;
 *   (b) no section points to another Kickoff in place of its text ("as kickoffs/s117's");
 *   (c) every numbered row under ROWS has a `Done when:` line;
 *   (d) CLOSE ends with **Stop.**
 *   (e) every `ADR-NNNN` it names has a file `docs/adr/NNNN-*.md` (kickoffs/s127 row 2: s125's named one that did not).
 * It reads text only; it never writes.
 */

/** The sections every Kickoff carries, in order. */
export const REQUIRED_SECTIONS: readonly string[] = [
  'WHY NOW',
  'SIZE',
  'OWNS',
  'STAY OUT OF',
  'WHERE THINGS STAND',
  'MERGE',
  'ROWS',
  'COMMANDS',
  'CHARTER',
  'NOT CHARTERED',
  'RULES',
  'STANDING ANSWERS',
  'OPEN',
  'CLOSE',
];

export type KickoffProblems = {
  missing: string[];
  outOfOrder: string[];
  pointers: string[];
  rowsWithoutDone: number[];
  noStop: boolean;
};

/**
 * Where each section starts: a line at column 0 that is the section's name, an optional parenthesis, then a colon. The
 * parenthesis may wrap: it then closes on a following line, and the colon comes right after it (kickoffs/s120 row 6).
 */
export function sectionStarts(text: string): { name: string; line: number }[] {
  const lines = text.split(/\r?\n/);
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, index) => {
    const m = /^([A-Z][A-Z ]*[A-Z])(?: \([^)]*\))?:/.exec(line);
    if (m && REQUIRED_SECTIONS.includes(m[1]!)) { starts.push({ name: m[1]!, line: index }); return; }
    const open = /^([A-Z][A-Z ]*[A-Z]) \([^)]*$/.exec(line);
    if (!open || !REQUIRED_SECTIONS.includes(open[1]!)) return;
    const closing = lines.slice(index + 1).find((next) => next.includes(')'));
    if (closing !== undefined && /^[^)]*\):/.test(closing)) starts.push({ name: open[1]!, line: index });
  });
  return starts;
}

/** The text of one section: its own line to the line before the next section starts. */
function sectionText(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  const starts = sectionStarts(text);
  const at = starts.findIndex((start) => start.name === name);
  if (at < 0) return '';
  const end = at + 1 < starts.length ? starts[at + 1]!.line : lines.length;
  return lines.slice(starts[at]!.line, end).join('\n');
}

export function checkKickoff(text: string): KickoffProblems {
  const starts = sectionStarts(text);
  const seen = starts.map((start) => start.name);
  const missing = REQUIRED_SECTIONS.filter((name) => !seen.includes(name));
  const firsts = REQUIRED_SECTIONS.filter((name) => seen.includes(name)).map((name) => seen.indexOf(name));
  const outOfOrder = REQUIRED_SECTIONS.filter((name) => seen.includes(name)).filter((_, i) => i > 0 && firsts[i]! < firsts[i - 1]!);
  const pointers = text.split(/\r?\n/).filter((line) => /\bas kickoffs\/[a-z]*\d+[a-z0-9-]*'s\b/i.test(line)).map((line) => line.trim());
  const rows = sectionText(text, 'ROWS').split(/\r?\n/);
  const rowsWithoutDone: number[] = [];
  let current: { number: number; done: boolean } | null = null;
  for (const line of rows) {
    const m = /^(\d+)\. /.exec(line);
    if (m) {
      if (current && !current.done) rowsWithoutDone.push(current.number);
      current = { number: Number(m[1]), done: false };
    }
    if (current && /Done when:/.test(line)) current.done = true;
  }
  if (current && !current.done) rowsWithoutDone.push(current.number);
  const close = sectionText(text, 'CLOSE').trim();
  const noStop = !/\*\*Stop\.\*\*\s*$/.test(close.replace(/```\s*$/, '').trim());
  return { missing, outOfOrder, pointers, rowsWithoutDone, noStop };
}

/** One line per problem, empty when the Kickoff is complete. */
export function describeProblems(problems: KickoffProblems): string[] {
  const lines: string[] = [];
  if (problems.missing.length) lines.push(`missing sections: ${problems.missing.join(', ')}`);
  if (problems.outOfOrder.length) lines.push(`out of the template's order: ${problems.outOfOrder.join(', ')}`);
  for (const pointer of problems.pointers) lines.push(`points to another Kickoff instead of carrying its text: "${pointer}"`);
  if (problems.rowsWithoutDone.length) lines.push(`rows with no "Done when:" line: ${problems.rowsWithoutDone.join(', ')}`);
  if (problems.noStop) lines.push('CLOSE does not end with **Stop.**');
  return lines;
}

/** (e) The ADRs the Kickoff names that have no file among `adrFiles` (the names in `docs/adr/`), each once, in order. */
export function missingAdrs(text: string, adrFiles: readonly string[]): string[] {
  const named = [...new Set([...text.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]!))];
  return named.filter((number) => !adrFiles.some((file) => file.startsWith(`${number}-`) && file.endsWith('.md'))).map((number) => `ADR-${number}`);
}

/** Rows asking for the required-sections verdict must name the flag that prints it. */
export function missingRequiredSections(text: string): number[] {
  const rows = sectionText(text, 'ROWS').split(/(?=^\d+\. )/m);
  return rows.filter((row) => /^\d+\. /.test(row) && row.includes('gate.required-sections') && !row.includes('--require-sections'))
    .map((row) => Number(/^(\d+)\./.exec(row)![1]));
}

export function describeMissingRequiredSections(rows: readonly number[]): string[] {
  return rows.map((row) => `row ${row} asks for gate.required-sections but its command has no --require-sections <n,...>`);
}

/** One problem line per ADR with no file. */
export function describeMissingAdrs(missing: readonly string[]): string[] {
  return missing.map((adr) => `names ${adr}, which has no file docs/adr/${adr.slice('ADR-'.length)}-*.md`);
}

/** The fenced block in docs/kickoff-template.md: the template itself. */
export function templateBlock(templateDoc: string): string {
  const m = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(templateDoc);
  return m ? m[1]! : '';
}

const USAGE = 'node tools/kickoff-check.mts <kickoff file>: checks the sections docs/kickoff-template.md requires';

async function main(argv: string[]): Promise<number> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const file = argv[0];
  if (file === '--help' || file === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 2;
  }
  if (!file || argv.length !== 1) {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    process.stderr.write(`kickoff-check: no such file: ${file}\n`);
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  const adrFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'adr');
  const problems = [...describeProblems(checkKickoff(text)), ...describeMissingAdrs(missingAdrs(text, fs.readdirSync(adrFolder))), ...describeMissingRequiredSections(missingRequiredSections(text))];
  if (problems.length === 0) {
    process.stdout.write(`kickoff-check: ${file} is complete (${REQUIRED_SECTIONS.length} sections, every row has "Done when:").\n`);
    return 0;
  }
  process.stdout.write(`kickoff-check: ${file} is not complete:\n${problems.map((line) => `- ${line}`).join('\n')}\n`);
  return 1;
}

const invoked = process.argv[1] ?? '';
if (/kickoff-check\.mts$/.test(invoked.replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
