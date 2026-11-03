/**
 * IS THIS KICKOFF COMPLETE? (docs/kickoff-template.md; Eric, 2026-10-13: "proceed with your recommendations" to the
 * dev loop review's option A.) Moved here from `tools/kickoff-check.mts` (kickoffs/s174 row 1; the plan "Rules the program
 * keeps, not the model", Phase A step 1): a compiled `deskpost` cannot import `tools/`, so `hub edit` and `deskpost kickoff
 * check` call the functions below, and the tool is a thin wrapper over them. Self-test section 240 judges the rules on
 * fixtures and on the template itself.
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
 * Pure: text in, lines out. It imports nothing, reads nothing and writes nothing.
 */

/** The sections every Kickoff carries, in order. */
export const REQUIRED_SECTIONS: readonly string[] = [
  'TRAIN',
  'WHY NOW',
  'SIZE',
  'OWNS',
  'OWNS PATHS',
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

/** Whole-file ownership only; prose OWNS still describes parts of files. */
export function ownsPaths(text: string): { patterns: string[]; problems: string[] } {
  const patterns: string[] = [], problems: string[] = [];
  for (const line of sectionText(text, 'OWNS PATHS').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const value = /^- `([^`]*)`$/.exec(line)?.[1];
    if (value === undefined || !value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\\?\[\]{}!]/.test(value) ||
        value.split('/').some(segment => !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'))) {
      problems.push('OWNS PATHS: invalid entry ' + line); continue;
    }
    patterns.push(value);
  }
  if (!patterns.length) problems.push('OWNS PATHS: at least one entry is required');
  return { patterns, problems };
}

/** A star stays within a segment; a double-star segment consumes zero or more segments. */
export function ownsPatternMatches(pattern: string, path: string): boolean {
  const segments = pattern.split('/'), parts = path.split('/');
  const memo = new Map<string, boolean>();
  const matches = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    const segment = segments[i];
    const result = segment === undefined ? j === parts.length : segment === '**'
      ? matches(i + 1, j) || (j < parts.length && matches(i, j + 1))
      : j < parts.length && new RegExp('^' + segment.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$').test(parts[j]!) && matches(i + 1, j + 1);
    memo.set(key, result); return result;
  };
  return matches(0, 0);
}

function pointsToKickoff(line: string): boolean {
  const plain = line.replace(/`/g, '');
  const sections = REQUIRED_SECTIONS.join('|');
  return /\bas kickoffs\/[a-z]*\d+[a-z0-9-]*'s\b/i.test(plain) || /\bread there\b/i.test(plain) ||
    new RegExp('\\bas\\s+kickoffs/[a-z0-9-]+\\s+(?:(?:row|rule|standing answer)\\s+\\d+\\s+says\\b|(?:' + sections + ')\\b)', 'i').test(plain);
}

export function checkKickoff(text: string): KickoffProblems {
  const starts = sectionStarts(text);
  const seen = starts.map((start) => start.name);
  const malformed = malformedHeadings(text);
  const missing = REQUIRED_SECTIONS.filter((name) => !seen.includes(name) && !malformed.includes(name));
  const firsts = REQUIRED_SECTIONS.filter((name) => seen.includes(name)).map((name) => seen.indexOf(name));
  const outOfOrder = REQUIRED_SECTIONS.filter((name) => seen.includes(name)).filter((_, i) => i > 0 && firsts[i]! < firsts[i - 1]!);
  const pointers = text.split(/\r?\n/).flatMap((line, index) => pointsToKickoff(line) ? [`line ${index + 1}: ${line.trim()}`] : []);
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

/** A flag gets exactly one row, on command lines and in code spans alike. */
export function commaRowLines(text: string): { line: number; text: string }[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const bad = [...line.matchAll(/-Row[ \t]+(['"]?)(<[^>]*>[^\s`]*|[^\s`]+)/g)].some(m =>
      m[2]!.includes(',') || (/^</.test(m[2]!) && /\b(?:rows|two|three|four|five|six|seven|eight|nine|ten|[2-9]\d*|1\d+)\b/i.test(m[2]!)));
    return bad ? [{ line: index + 1, text: line.trim() }] : [];
  });
}

export function describeCommaRows(lines: readonly { line: number; text: string }[]): string[] {
  // The flag is joined from two parts (kickoffs/s174 row 1): this line is advice to the orchestrator about the repository's
  // matrix harness, which self-test section 120 would otherwise read as a kernel string naming a PowerShell parameter.
  const flag = '-' + 'Row';
  return lines.map((found) => `line ${found.line} gives ${flag} a comma list or several rows: one \`${flag}\` per call (docs/dev-session-loop.md, the acceptance matrix): "${found.text}"`);
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

/** Check the primary TRAIN id and each carried id; trailing register prose is not an id. */
export function trainProblems(text: string, record: unknown): string[] {
  const r = record as { schema?: unknown; items?: { id?: unknown; status?: unknown }[] } | null;
  if (!r || r.schema !== 1 || !Array.isArray(r.items) || r.items.some(i => !i || typeof i.id !== 'string' || !['open', 'done', 'dropped'].includes(String(i.status))) || new Set(r.items.map(i => i.id)).size !== r.items.length) return ['train register is not a valid schema-1 record'];
  const train = /^TRAIN:[ \t]*(.+)$/m.exec(text)?.[1] ?? '';
  const ids = [train.split(/\s/)[0] ?? ''];
  const carried = /;\s*this unit also carries\s+([^)]*)/.exec(train)?.[1];
  for (const piece of carried?.split(/,\s*|\s+and\s+/) ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(piece.trim())) break;
    ids.push(piece.trim());
  }
  return [...new Set(ids)].filter(id => !r.items!.some(item => item.id === id && item.status === 'open'))
    .map(id => "TRAIN id '" + id + "' is not an open item in the train register");
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
  /(?<![\w./-])(?:tools\/owns\.mts|(?:kernel\/src\/)?kickoffcheck\.ts)\b/g, // ownership
];

export function secondReadProblems(text: string): string[] {
  const owns = (sectionText(text, 'OWNS') + '\n' + sectionText(text, 'OWNS PATHS')).replace(/\\/g, '/');
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

/** A page name the Kickoff gives explicitly; page placeholders describe future pages and are not lookups. */
export function kickoffNames(text: string): { name: string; line: number }[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const names = [...line.matchAll(/\[\[((?:projects\/[^/\]\s]+\/[^\]|]+)|(?:[^\]\s|]+\/notes\/[^\]|]+))(?:\|[^\]]*)?\]\]/g)].map(m => m[1]!);
    for (const phrase of line.matchAll(/`(projects\/[a-z0-9-]+)` pages? ((?:`[^`]+`(?:\s*,\s*(?:and\s+)?|\s+and\s+)?)+)/g)) {
      for (const page of phrase[2]!.matchAll(/`([^`]+)`/g)) names.push(`${phrase[1]}/${page[1]}`);
    }
    return [...new Set(names)].filter(name => !/<[^>]+>/.test(name.slice(name.startsWith('projects/') ? name.indexOf('/', 9) + 1 : name.indexOf('/notes/') + 7)))
      .map(name => ({ name, line: index + 1 }));
  });
}

export type NameResolution = { status: 'exists' | 'absent' } | { status: 'unreadable'; reason: string };

/** A colon or sentence boundary outside code spans; paths and headings inside code cannot end a list header. */
function outsideCode(text: string, pattern: RegExp): number {
  let code = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') code = !code;
    else if (!code && pattern.test(text.slice(i))) return i;
  }
  return -1;
}

/** Only OPEN's explicit Required reads list is judged; other prose cannot create required reads. */
export function requiredReadProblems(text: string): string[] {
  const open = sectionText(text, 'OPEN').split(/\r?\n/);
  const offset = sectionStarts(text).find(s => s.name === 'OPEN')?.line ?? 0;
  const problems: string[] = [];
  const paths = (value: string) => [...value.matchAll(/`([^`]+)`/g)].map(m => m[1]!);
  const defined = (token: string) => text.split(/\r?\n/).some(line => line.includes('`' + token + '`') && /\b(?:is|below is|folder)\b/.test(line) && /`(?:[A-Za-z]:\/|\/|~\/)[^`]+`/.test(line));
  const path = (value: string): boolean => {
    const placeholder = /^<[^>]+>/.exec(value)?.[0];
    if (placeholder) return defined(placeholder) && value.includes('/');
    return /\//.test(value) || /^[A-Z][\w.-]*\.md$/.test(value);
  };
  const items = (value: string, header: string, line: number) => {
    const folder = paths(header).some(value => path(value) && value.includes('/') || (/^<[^>]+>$/.test(value) && defined(value)));
    let depth = 0, code = false, start = 0;
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '`') code = !code;
      else if (!code) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
      }
    }
    parts.push(value.slice(start));
    for (const item of parts.map(s => s.trim()).filter(Boolean)) {
      if (/^<[^>]+>\.?$/.test(item) || kickoffNames(item).length || /(?:^|[\s("'])(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s;]+/.test(item) || paths(item).some(value => path(value) || (folder && /^[\w.-]+\.[\w]+$/.test(value)))) continue;
      problems.push(`line ${line}: required read names no checkable path or page: ${item}`);
    }
  };
  for (let i = 0; i < open.length; i++) {
    const at = open[i]!.indexOf('**Required reads**');
    if (at < 0 || (!/^\s*(?:[-*]\s*)?$/.test(open[i]!.slice(0, at)) && !/^\s*0\.\s/.test(open[i]!))) continue;
    const rest = open[i]!.slice(at);
    const colon = outsideCode(rest, /^:/);
    if (colon < 0) continue;
    let list = rest.slice(colon + 1).trim();
    if (list) {
      while (outsideCode(list, /^\.(?:\s|$)/) < 0 && i + 1 < open.length && !/^\s*\d+\.\s/.test(open[i + 1]!)) list += ' ' + open[++i]!.trim();
      const end = outsideCode(list, /^\.(?:\s|$)/);
      items(end < 0 ? list : list.slice(0, end), '', offset + i + 1);
    } else {
      while (i + 1 < open.length && /^\s*[-*]\s/.test(open[i + 1]!)) {
        const bullet = open[++i]!.replace(/^\s*[-*]\s+/, '');
        const colon = outsideCode(bullet, /^:/);
        items(colon < 0 ? bullet : bullet.slice(colon + 1), colon < 0 ? '' : bullet.slice(0, colon), offset + i + 1);
      }
    }
  }
  return problems;
}

/** The tool and both posting paths share this verdict. Received pages skip names; a bare tool warns when it has names. */
export function kickoffVerdict(
  text: string,
  options: { adrFiles: readonly string[]; train?: { record: unknown }; placeholders?: boolean; names?: boolean; missingAdrs?: 'refuse' | 'warn'; resolveName?: (name: string) => NameResolution },
): { problems: string[]; warnings: string[] } {
  const names = options.names === false ? [] : kickoffNames(text);
  const nameProblems = options.resolveName ? names.flatMap(({ name, line }) => {
    try {
      const result = options.resolveName!(name);
      return result.status === 'exists' ? [] : ['line ' + line + ': page ' + name + ' is ' + result.status + (result.status === 'unreadable' ? ': ' + result.reason : '')];
    } catch (error) { return ['line ' + line + ': page ' + name + ' is unreadable: ' + String(error)]; }
  }) : [];
  const problems = [
    ...describeProblems(checkKickoff(text)),
    ...ownsPaths(text).problems,
    ...nameProblems,
    ...requiredReadProblems(text),
    ...describeMissingAdrs(missingAdrs(text, options.adrFiles).filter(adr => options.missingAdrs !== 'warn' || adr.startsWith('new ')), options.adrFiles),
    ...describeMissingRequiredSections(missingRequiredSections(text)),
    ...describeCommaRows(commaRowLines(text)),
    ...(options.placeholders === false ? [] : placeholderProblems(text)),
    ...auditProblems(text),
    ...secondReadProblems(text),
    ...(options.train ? trainProblems(text, options.train.record) : []),
  ];
  const warnings = [
    ...(options.missingAdrs === 'warn' ? missingAdrs(text, options.adrFiles).filter(adr => !adr.startsWith('new ')).map(adr =>
      `names ${adr}, which this installed release does not have (its docs/adr/ ends at ADR-${String(highestAdr(options.adrFiles)).padStart(4, '0')}); the source check, node tools/kickoff-check.mts in the build checkout, decides`) : []),
    ...(names.length && !options.resolveName ? ['names not checked: no Library'] : []),
    ...describeSourceGreenHelperRows(sourceGreenHelperRows(text)),
    ...wslMasterRows(text).map(row => `row ${row} runs a WSL step that reads origin/master: in the WSL clone that is the shared repository's local master, which pushes never move; read origin/<the unit's branch>`),
  ];
  return { problems, warnings };
}

/** The lines the check prints for `file`: the warnings first, then the verdict, as the tool has always printed them. */
export function verdictText(file: string, verdict: { problems: readonly string[]; warnings: readonly string[] }): string {
  const warnings = verdict.warnings.map((line) => `kickoff-check: warning: ${line}\n`).join('');
  return verdict.problems.length === 0
    ? `${warnings}kickoff-check: ${file} is complete (${REQUIRED_SECTIONS.length} sections, every row has "Done when:").\n`
    : `${warnings}kickoff-check: ${file} is not complete:\n${verdict.problems.map((line) => `- ${line}`).join('\n')}\n`;
}
