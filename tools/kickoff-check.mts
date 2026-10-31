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
 *   (e) every `ADR-NNNN` it names has a file `docs/adr/NNNN-*.md` (kickoffs/s127 row 2: s125's named one that did not);
 *   (f) a line that runs the acceptance matrix (`Invoke-AcceptanceMatrix`) gives `-Row` one row, never a comma list
 *       (kickoffs/s147 row 6: s138's `-Row a,b` passed; through `powershell.exe -File` it arrives as one row name).
 *   (g) a release TRAIN id requires WHY NOW's Audit line naming library-auditor and its answering letter
 *       (Decision 2026-10-27: library-auditor audits every release).
 *   (h) sensitive paths in OWNS require WHY NOW's Second read line naming library-auditor (the same Decision).
 * Two warnings, which do not refuse: a row whose text names a `tools/*.ps1` helper (other than the matrix harness)
 * and whose `Done when:` asks for green from the source kernel, which judges a helper-sentence row as a mismatch by design.
 * Also a WSL row reading origin/master: the clone reads the shared repository's local master, not its pushed tip (c71).
 * It reads text only; it never writes.
 */

/** The sections every Kickoff carries, in order. */
export const REQUIRED_SECTIONS: readonly string[] = [
  'TRAIN',
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
  /** Required names whose line starts like a heading but is not one (`ROWS (…). Prose:`), named instead of "missing". */
  malformed: string[];
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

/**
 * A REQUIRED NAME AT COLUMN 0 WHOSE LINE IS NOT A HEADING (kickoffs/s157 row 9; triage of 2026-10-23, item 6): a line
 * that starts with the name and ` (` or `:`, which `sectionStarts` did not take, as `ROWS (in order). Prose:` read as a
 * missing ROWS. Each name once, and only while no line starts that section.
 */
export function malformedHeadings(text: string): string[] {
  const starts = sectionStarts(text);
  const names = text.split(/\r?\n/).flatMap((line, index) => {
    const m = /^([A-Z][A-Z ]*[A-Z])(?: \(|:)/.exec(line);
    return m && REQUIRED_SECTIONS.includes(m[1]!) && !starts.some((start) => start.line === index) ? [m[1]!] : [];
  });
  return [...new Set(names)].filter((name) => !starts.some((start) => start.name === name));
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
  const malformed = malformedHeadings(text);
  const missing = REQUIRED_SECTIONS.filter((name) => !seen.includes(name) && !malformed.includes(name));
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
  return { missing, outOfOrder, pointers, rowsWithoutDone, noStop, malformed };
}

/** One line per problem, empty when the Kickoff is complete. */
export function describeProblems(problems: KickoffProblems): string[] {
  const lines: string[] = [];
  if (problems.missing.length) lines.push(`missing sections: ${problems.missing.join(', ')}`);
  for (const name of problems.malformed ?? []) lines.push(`${name}: its heading line is not ${name} (…):; keep any text after the parenthesis inside it`);
  if (problems.outOfOrder.length) lines.push(`out of the template's order: ${problems.outOfOrder.join(', ')}`);
  for (const pointer of problems.pointers) lines.push(`points to another Kickoff instead of carrying its text: "${pointer}"`);
  if (problems.rowsWithoutDone.length) lines.push(`rows with no "Done when:" line: ${problems.rowsWithoutDone.join(', ')}`);
  if (problems.noStop) lines.push('CLOSE does not end with **Stop.**');
  return lines;
}

/** The highest ADR number among `adrFiles`, 0 when there is none. */
function highestAdr(adrFiles: readonly string[]): number {
  return Math.max(0, ...adrFiles.map((file) => /^(\d{4})-.*\.md$/.exec(file)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])));
}

/**
 * (e) The ADRs the Kickoff names that have no file among `adrFiles` (the names in `docs/adr/`), each once, in order. A
 * NUMBER THE KICKOFF CREATES (kickoffs/s160 row 5) is written `new ADR-NNNN`: accepted when NNNN is above the highest
 * there is, and then accepted wherever else the Kickoff names it. A `new` one that exists, or is not above the highest,
 * is returned as `new ADR-NNNN`.
 */
export function missingAdrs(text: string, adrFiles: readonly string[]): string[] {
  const filed = (number: string) => adrFiles.some((file) => file.startsWith(`${number}-`) && file.endsWith('.md'));
  const created = [...new Set([...text.matchAll(/\bnew ADR-(\d{4})\b/gi)].map((m) => m[1]!))];
  const badNew = created.filter((number) => filed(number) || Number(number) <= highestAdr(adrFiles));
  const named = [...new Set([...text.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]!))];
  return [
    ...badNew.map((number) => `new ADR-${number}`),
    ...named.filter((number) => !filed(number) && !created.includes(number)).map((number) => `ADR-${number}`),
  ];
}

/** Rows asking for the required-sections verdict must name the flag that prints it. */
export function missingRequiredSections(text: string): number[] {
  const rows = sectionText(text, 'ROWS').split(/(?=^\d+\. )/m);
  return rows.filter((row) => /^\d+\. /.test(row) && row.includes('gate.required-sections') && !row.includes('--require-sections'))
    .map((row) => Number(/^(\d+)\./.exec(row)![1]));
}

/** (f) The lines that give the matrix harness a comma list after `-Row`, each with its 1-based line number. */
export function commaRowLines(text: string): { line: number; text: string }[] {
  return text.split(/\r?\n/).flatMap((line, index) =>
    /Invoke-AcceptanceMatrix/.test(line) && /-Row\s+(?:<[^>\s]*>|[^\s`'",<\[]+)\[?\s*,/.test(line) ? [{ line: index + 1, text: line.trim() }] : []);
}

export function describeCommaRows(lines: readonly { line: number; text: string }[]): string[] {
  return lines.map((found) => `line ${found.line} gives -Row a comma list: one \`-Row\` per call (docs/dev-session-loop.md, the acceptance matrix): "${found.text}"`);
}

/** The rows whose text names a `tools/*.ps1` helper and whose `Done when:` asks for source-kernel green (a warning). */
export function sourceGreenHelperRows(text: string): number[] {
  const rows = sectionText(text, 'ROWS').split(/(?=^\d+\. )/m);
  return rows.filter((row) => {
    if (!/^\d+\. /.test(row)) return false;
    const helpers = [...row.matchAll(/tools\/([A-Za-z0-9-]+)\.ps1/g)].map((m) => m[1]!).filter((name) => name !== 'Invoke-AcceptanceMatrix');
    const done = row.slice(row.indexOf('Done when:'));
    return helpers.length > 0 && row.includes('Done when:') && /green/i.test(done) && /(source[- ]kernel|node kernel\/src\/cli\.ts)/i.test(done);
  }).map((row) => Number(/^(\d+)\./.exec(row)![1]));
}

export function describeSourceGreenHelperRows(rows: readonly number[]): string[] {
  return rows.map((row) => `row ${row} asks for source-kernel green on a row that names a tools/*.ps1 helper: the source kernel judges a helper-sentence row as a mismatch by design; judge it against a build of the same commit (docs/dev-session-loop.md, the acceptance matrix)`);
}

export function describeMissingRequiredSections(rows: readonly number[]): string[] {
  return rows.map((row) => `row ${row} asks for gate.required-sections but its command has no --require-sections <n,...>`);
}

/** One problem line per ADR with no file, and per `new` ADR that is not a new number (`adrFiles` names which). */
export function describeMissingAdrs(missing: readonly string[], adrFiles: readonly string[] = []): string[] {
  return missing.map((adr) => {
    const number = adr.slice(adr.indexOf('ADR-') + 'ADR-'.length);
    if (!adr.startsWith('new ')) return `names ${adr}, which has no file docs/adr/${number}-*.md`;
    const file = adrFiles.find((name) => name.startsWith(`${number}-`) && name.endsWith('.md'));
    return file
      ? `names ${adr}, which already exists: docs/adr/${file}`
      : `names ${adr}, which is not above the highest ADR there is, ADR-${String(highestAdr(adrFiles)).padStart(4, '0')}`;
  });
}

/** The fenced block in docs/kickoff-template.md: the template itself. */
export function templateBlock(templateDoc: string): string {
  const m = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(templateDoc);
  return m ? m[1]! : '';
}

/** Posted Kickoffs escape write-time placeholders so the writer preserves their literal spelling. */
export function placeholderProblems(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => [...line.matchAll(/(?<!\{)\{(now|today|session)\}(?!\})/g)]
    .map(match => `line ${index + 1}: ${match[0]} needs doubled braces; a posted Kickoff keeps the placeholder only when the file doubles its braces`));
}

/** Membership uses the first word on TRAIN, never a title or a closed item's id. */
export function trainProblems(text: string, record: unknown): string[] {
  const r = record as { schema?: unknown; items?: { id?: unknown; status?: unknown }[] } | null;
  if (!r || r.schema !== 1 || !Array.isArray(r.items) || r.items.some(i => !i || typeof i.id !== 'string' || !['open', 'done', 'dropped'].includes(String(i.status))) || new Set(r.items.map(i => i.id)).size !== r.items.length) return ['train register is not a valid schema-1 record'];
  const id = /^TRAIN:[ \t]*(\S+)/m.exec(text)?.[1];
  const item = r.items.find(i => i.id === id);
  return item?.status === 'open' ? [] : [`TRAIN id '${id ?? ''}' is not an open item in the train register`];
}

/** Decision 2026-10-27: every release names the auditor's answering letter; text only, not a letter lookup. */
export function auditProblems(text: string): string[] {
  if (!/^TRAIN:[ \t]*release-\S*/m.test(text)) return [];
  const audit = sectionText(text, 'WHY NOW').split(/\r?\n/).find(line => line.startsWith('- **Audit:**')) ?? '';
  return /\blibrary-auditor\b/.test(audit) && /\[\[letters\/notes\/[^\]\s]+\]\]/.test(audit) ? []
    : ['release Kickoff needs a WHY NOW - **Audit:** line naming library-auditor and its answering [[letters/notes/<page>]] (Decision 2026-10-27)'];
}

/** Decision 2026-10-27's sensitive files, including a kernel file written by basename alone. */
export const SENSITIVE_PATHS: readonly RegExp[] = [
  /(?<![\w./-])(?:kernel\/src\/)?guards\.ts\b/g, // guards
  /(?<![\w./-])(?:kernel\/src\/)?(?:hook[\w-]*|codexhooktrust)\.ts\b|\.githooks\/[^\s`'",;)]*/g, // hooks
  /[\w./-]*(?:settings|secret|credential)[\w./-]*[./][\w./-]*|[\w./-]*[./][\w./-]*(?:settings|secret|credential)[\w./-]*/g, // settings and credentials
  /(?<![\w./-])(?:kernel\/src\/)?locks\.ts\b/g, // locks
  /(?<![\w./-])(?:kernel\/src\/)?(?:undo|journal)\.ts\b/g, // undo and journals
  /(?<![\w./-])(?:kernel\/src\/)?(?:netpolicy|postbox|basicmemory|bm[\w-]*|updatecheck|reportsend|install|upgrade)\.ts\b/g, // network
];

export function secondReadProblems(text: string): string[] {
  const owns = sectionText(text, 'OWNS').replace(/\\/g, '/');
  const first = SENSITIVE_PATHS.flatMap(pattern => [...owns.matchAll(pattern)]).sort((a, b) => a.index! - b.index!)[0]?.[0];
  if (!first) return [];
  const second = sectionText(text, 'WHY NOW').split(/\r?\n/).some(line => line.startsWith('- **Second read:**') && /\blibrary-auditor\b/.test(line));
  const file = first.includes('/') || !first.endsWith('.ts') ? first : `kernel/src/${first}`;
  return second ? [] : [`OWNS names sensitive path ${file}: needs a WHY NOW - **Second read:** line naming library-auditor (Decision 2026-10-27)`];
}

/** c71 parked on the clone's stale master; a prohibition without a git command must not warn. */
export function wslMasterRows(text: string): number[] {
  return sectionText(text, 'ROWS').split(/(?=^\d+\. )/m)
    .filter(row => /^\d+\. /.test(row) && row.includes('wsl-run.mts') && /\bgit[ \t]+(?:rev-parse|checkout|merge|log|diff|reset)\b[^\r\n]*\borigin\/master(?![\w/.-])/.test(row))
    .map(row => Number(/^(\d+)\./.exec(row)![1]));
}

const USAGE = 'node tools/kickoff-check.mts <kickoff file>: checks the sections docs/kickoff-template.md requires; --train <register file> also checks its TRAIN id';

async function main(argv: string[]): Promise<number> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
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
  const problems = [...describeProblems(checkKickoff(text)), ...describeMissingAdrs(missingAdrs(text, adrFiles), adrFiles), ...describeMissingRequiredSections(missingRequiredSections(text)), ...describeCommaRows(commaRowLines(text)), ...placeholderProblems(text), ...auditProblems(text), ...secondReadProblems(text)];
  if (argv[2]) {
    try { problems.push(...trainProblems(text, JSON.parse(fs.readFileSync(argv[2], 'utf8')))); }
    catch (error) { problems.push(`cannot read train register '${argv[2]}': ${(error as Error).message}`); }
  }
  const warnings = [...describeSourceGreenHelperRows(sourceGreenHelperRows(text)), ...wslMasterRows(text).map(row => `row ${row} runs a WSL step that reads origin/master: in the WSL clone that is the shared repository's local master, which pushes never move; read origin/<the unit's branch>`)];
  if (warnings.length) process.stdout.write(`${warnings.map((line) => `kickoff-check: warning: ${line}`).join('\n')}\n`);
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
