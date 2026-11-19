/**
 * IS THIS KICKOFF COMPLETE? (docs/kickoff-template.md; Eric, 2026-10-13: "proceed with your recommendations" to the
 * dev loop review's option A.) Moved here from `tools/kickoff-check.mts` (kickoffs/s174 row 1; the plan "Rules the program
 * keeps, not the model", Phase A step 1): a compiled `deskpost` cannot import `tools/`, so `hub edit` and `deskpost kickoff
 * check` call the functions below, and the tool is a thin wrapper over them. Self-test section 240 judges the rules on
 * fixtures and on the template itself.
 *
 * The rules, each one a drift the review found in real Kickoffs:
 *   (a) seven required sections are present, as lines starting with their name and a colon (`WHY NOW:`);
 *       all known headings, including optional ones, keep the template's order;
 *   (b) no section points to another Kickoff in place of its text ("as kickoffs/s117's");
 *   (c) every numbered row under ROWS has a `Done when:` line;
 *   (d) CLOSE ends with **Stop.**
 *   (e) every `ADR-NNNN` it names has a file `docs/adr/NNNN-*.md` (kickoffs/s127 row 2: s125's named one that did not);
 *   (f) a line that runs the acceptance matrix (`Invoke-AcceptanceMatrix`) gives `-Row` one row, never a comma list
 *       (kickoffs/s147 row 6: s138's `-Row a,b` passed; through `powershell.exe -File` it arrives as one row name).
 *   (g) a release TRAIN id requires WHY NOW's Audit line naming library-auditor and its answering letter
 *       (Decision 2026-10-27: library-auditor audits every release).
 *   (h) sensitive paths in OWNS require WHY NOW's Second read line naming library-auditor (the same Decision).
 *   (i) a builder Kickoff orders no push test run and no push to master in inline code (Two Builders rules, 2026-11-10).
 * Two warnings, which do not refuse: a row whose text names a `tools/*.ps1` helper (other than the matrix harness)
 * and whose `Done when:` asks for green from the source kernel, which judges a helper-sentence row as a mismatch by design.
 * Also a WSL row reading origin/master: the clone reads the shared repository's local master, not its pushed tip (c71).
 * Pure: text in, lines out. It imports verbs.ts for the action lists, reads nothing and writes nothing.
 */

import { VERBS } from './verbs.ts';

/** Required and optional headings, in their shared order; older full Kickoffs remain valid. */
export const KNOWN_SECTIONS: readonly string[] = [
  'TRAIN',
  'WHY NOW',
  'SIZE',
  'OWNS',
  'OWNS PATHS',
  'STAY OUT OF',
  'WHERE THINGS STAND',
  'MERGE',
  'ROWS',
  'NOT BUILDING',
  'NET LINES',
  'COMMANDS',
  'CHARTER',
  'NOT CHARTERED',
  'RULES',
  'STANDING ANSWERS',
  'OPEN',
  'CLOSE',
];

/** The seven headings every Kickoff carries, in the same relative order. */
export const REQUIRED_SECTIONS: readonly string[] = [
  'TRAIN', 'WHY NOW', 'OWNS PATHS', 'STAY OUT OF', 'ROWS', 'CHARTER', 'CLOSE',
];

export type KickoffProblems = {
  missing: string[];
  outOfOrder: string[];
  pointers: string[];
  rowsWithoutDone: number[];
  noStop: boolean;
  /** Known names whose line starts like a heading but is not one (`ROWS (…). Prose:`), named instead of "missing". */
  malformed: string[];
  malformedSuffixes?: Record<string, string>;
};

/**
 * THE CHAIN LINE (PLAN-hub-redesign.md A1-01; kickoffs/s213 row 9): an optional header line, before the first section,
 * that reads exactly `CHAIN: yes`. Absent means no. Any other `CHAIN:` line in the header is malformed, and so is a second
 * `CHAIN` line, even a second `CHAIN: yes` (kickoffs/s213-r2 row 6): every header line is read, never only the first.
 */
export function chainHeader(text: string): 'yes' | 'absent' | { malformed: string; line: number; repeated?: true } {
  const lines = text.split(/\r?\n/);
  const { inside } = fencedLines(text);
  const first = sectionStarts(text)[0]?.line ?? lines.length;
  let seen = false;
  for (let index = 0; index < first; index++) {
    if (inside[index] || !/^CHAIN\b/.test(lines[index]!)) continue;
    if (lines[index] !== 'CHAIN: yes') return { malformed: lines[index]!, line: index + 1 };
    if (seen) return { malformed: lines[index]!, line: index + 1, repeated: true };
    seen = true;
  }
  return seen ? 'yes' : 'absent';
}

export function chainProblems(text: string): string[] {
  const chain = chainHeader(text);
  if (typeof chain !== 'object') return [];
  return [chain.repeated
    ? `line ${chain.line}: "${chain.malformed}" is a second CHAIN line: the header holds one CHAIN: yes line, or none (absent means no)`
    : `line ${chain.line}: "${chain.malformed}" is not a chain line: write exactly CHAIN: yes in the header to chain this Kickoff after the one before it, or leave the line out (absent means no)`];
}

/** The ids of a `## Next`'s unticked Run pointers, in page order (fenced lines already left out by the caller). */
export function pendingRunIds(nextLines: readonly string[]): string[] {
  return nextLines.map((line) => /^\s*- \[ \] Run ([A-Za-z0-9._-]+):/.exec(line)?.[1]).filter((id): id is string => id !== undefined);
}

/**
 * IS THIS THE KICKOFF TO OPEN? (PLAN-hub-redesign.md A1-04; kickoffs/s213 row 7): a builder Hub queues up to three Run
 * pointers, run in page order, so a builder's OPEN passes only the first. Pure: the caller reads the seat Hub's `## Next`
 * (`kickoff.ts` `seatHubNext`) and passes its lines.
 */
export function openVerdict(nextLines: readonly string[], hub: string, id: string): { ok: boolean; first: string | null; pending: string[]; message: string } {
  const pending = pendingRunIds(nextLines);
  const first = pending[0] ?? null;
  if (first === null) {
    return { ok: false, first, pending, message: `projects/${hub} has no pending Run pointer in ## Next, so no Kickoff is ready to open. Wait for the next pointer to be posted.` };
  }
  if (first.toLowerCase() === id.trim().toLowerCase()) {
    const rest = pending.length - 1;
    return { ok: true, first, pending, message: `Run ${first} is the first pending Run pointer on projects/${hub}: open it.${rest > 0 ? ` ${rest} more queued behind it.` : ''}` };
  }
  const where = pending.some((one) => one.toLowerCase() === id.trim().toLowerCase()) ? `is queued at place ${pending.findIndex((one) => one.toLowerCase() === id.trim().toLowerCase()) + 1}` : 'is not pending';
  return { ok: false, first, pending, message: `Run ${id.trim()} ${where} on projects/${hub}, and the first is Run ${first}. Open Run ${first} first; the queue runs in page order.` };
}

/** A closing marker may have trailing text; a same-line span outside a fence stays inline. */
export function fenceMarker(line: string, open: boolean): boolean {
  return line.startsWith('```') && (open || !line.slice(3).includes('```'));
}

/** Closed blocks only; a same-line span stays inline, and an unmatched opener is reported by its one-based line. */
export function fencedLines(text: string): { inside: boolean[]; markers: boolean[]; unclosed: number | null } {
  const lines = text.split(/\r?\n/), inside = lines.map(() => false), markers = lines.map(() => false);
  let open: number | null = null;
  lines.forEach((line, index) => {
    if (!fenceMarker(line, open !== null)) return;
    markers[index] = true;
    if (open !== null) {
      for (let n = open + 1; n < index; n++) inside[n] = true;
      open = null;
    } else open = index;
  });
  return { inside, markers, unclosed: open === null ? null : open + 1 };
}

/** Column-zero section names, with an optional parenthesis that may wrap, outside closed code fences. */
export function sectionStarts(text: string): { name: string; line: number }[] {
  const lines = text.split(/\r?\n/);
  const { inside } = fencedLines(text);
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, index) => {
    if (inside[index]) return;
    const m = /^([A-Z][A-Z ]*[A-Z])(?: \([^)]*\))?:/.exec(line);
    if (m && KNOWN_SECTIONS.includes(m[1]!)) { starts.push({ name: m[1]!, line: index }); return; }
    const open = /^([A-Z][A-Z ]*[A-Z]) \([^)]*$/.exec(line);
    if (!open || !KNOWN_SECTIONS.includes(open[1]!)) return;
    const closing = lines.slice(index + 1).find((next) => next.includes(')'));
    if (closing !== undefined && /^[^)]*\):/.test(closing)) starts.push({ name: open[1]!, line: index });
  });
  return starts;
}

/**
 * A KNOWN NAME AT COLUMN 0 WHOSE LINE IS NOT A HEADING (kickoffs/s157 row 9; triage of 2026-10-23, item 6): a line
 * that starts with the name and ` (` or `:`, which `sectionStarts` did not take, as `ROWS (in order). Prose:` read as a
 * missing ROWS. Each name once, and only while no line starts that section.
 */
function nearMissHeadings(text: string): [string, string][] {
  const { inside } = fencedLines(text);
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (inside[index]) return [];
    const m = /^([A-Z][A-Z ]*[A-Z])/.exec(line);
    const tail = m ? line.slice(m[1]!.length) : '';
    return m && KNOWN_SECTIONS.includes(m[1]!) && !/^(?: \(|:)/.test(tail) ? [[m[1]!, tail] as [string, string]] : [];
  });
}

export function malformedHeadings(text: string): string[] {
  const starts = sectionStarts(text);
  const { inside } = fencedLines(text);
  const names = text.split(/\r?\n/).flatMap((line, index) => {
    if (inside[index]) return [];
    const m = /^([A-Z][A-Z ]*[A-Z])(?: \(|:)/.exec(line);
    return m && KNOWN_SECTIONS.includes(m[1]!) && !starts.some((start) => start.line === index) ? [m[1]!] : [];
  });
  return [...new Set([...names.filter(name => !starts.some(start => start.name === name)), ...nearMissHeadings(text).map(([name]) => name)])];
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
    if (value && (value.startsWith('/') || /^[A-Za-z]:/.test(value))) {
      problems.push('OWNS PATHS: OWNS PATHS lists repository paths; name a file outside the repository in OWNS: ' + line); continue;
    }
    if (value === undefined || !value || /[\\?\[\]{}!]/.test(value) ||
        value.split('/').some(segment => !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'))) {
      problems.push('OWNS PATHS: invalid entry ' + line + '; use one backticked path or glob per bullet, with nothing after it'); continue;
    }
    patterns.push(value);
  }
  if (!patterns.length) problems.push('OWNS PATHS: at least one entry is required');
  if (patterns.includes('none') && patterns.length > 1) problems.push('OWNS PATHS: `none` means no tracked file, so it stands alone');
  return { patterns, problems };
}

/** A star stays within a segment; a double-star segment consumes zero or more segments. */
export function ownsPatternMatches(pattern: string, path: string): boolean {
  if (pattern === 'none') return false;
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
  const plain = line.replace(/`/g, '').replace(/projects\/[a-z0-9-]+ page (kickoffs\/)/gi, '$1');
  const sections = KNOWN_SECTIONS.join('|');
  return /\bas kickoffs\/[a-z]*\d+[a-z0-9-]*'s\b/i.test(plain) || /\bread there\b/i.test(plain) ||
    new RegExp('\\bas\\s+kickoffs/[a-z0-9-]+\\s+(?:(?:row|rule|standing answer)\\s+\\d+\\s+says\\b|(?:' + sections + ')\\b)', 'i').test(plain);
}

export function checkKickoff(text: string): KickoffProblems {
  const starts = sectionStarts(text);
  const seen = starts.map((start) => start.name);
  const malformed = malformedHeadings(text);
  const missing = REQUIRED_SECTIONS.filter((name) => !seen.includes(name) && !malformed.includes(name));
  const firsts = KNOWN_SECTIONS.filter((name) => seen.includes(name)).map((name) => seen.indexOf(name));
  const outOfOrder = KNOWN_SECTIONS.filter((name) => seen.includes(name)).filter((_, i) => i > 0 && firsts[i]! < firsts[i - 1]!);
  const pointers = text.split(/\r?\n/).flatMap((line, index) => pointsToKickoff(line) ? [`line ${index + 1}: ${line.trim()}`] : []);
  const rows = sectionText(text, 'ROWS').split(/\r?\n/);
  const rowsWithoutDone: number[] = [];
  let current: { number: number; done: boolean } | null = null;
  const rowFences = fencedLines(rows.join('\n'));
  for (const [index, line] of rows.entries()) {
    if (rowFences.inside[index] || rowFences.markers[index]) continue;
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
  return { missing, outOfOrder, pointers, rowsWithoutDone, noStop, malformed, malformedSuffixes: Object.fromEntries(nearMissHeadings(text)) };
}

/** One line per problem, empty when the Kickoff is complete. */
export function describeProblems(problems: KickoffProblems): string[] {
  const lines: string[] = [];
  if (problems.missing.length) lines.push(`missing sections: ${problems.missing.join(', ')}`);
  for (const name of problems.malformed ?? []) lines.push(problems.malformedSuffixes?.[name] !== undefined
    ? `${name}: followed by ${problems.malformedSuffixes[name] ? JSON.stringify(problems.malformedSuffixes[name]) : 'end of line'}; its heading needs ${name}:`
    : `${name}: its heading line is not ${name} (…):; keep any text after the parenthesis inside it`);
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

/** Rows running the push or release gate and asking for its required-sections verdict must name the flag that prints it. */
export function missingRequiredSections(text: string): number[] {
  const rows = sectionText(text, 'ROWS').split(/(?=^\d+\. )/m);
  // Only a row that runs the gate (kickoffs/s180 row 2(e)): naming the check as data asks for nothing.
  const runsGate = (row: string) => /gate\.ts\b[^\n`]*--tier[ \t]+(?:push|release)\b/.test(row);
  return rows.filter((row) => /^\d+\. /.test(row) && runsGate(row) && row.includes('gate.required-sections') && !row.includes('--require-sections'))
    .map((row) => Number(/^(\d+)\./.exec(row)![1]));
}

/** A flag gets exactly one row, on command lines and in code spans alike. */
export function commaRowLines(text: string): { line: number; text: string }[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const bad = [...line.matchAll(/-Row[ \t]+(['"]?)(<[^>]*>[^\s`]*|[^\s`]+)/g)].some(m =>
      m[2]!.includes(',') || (/^</.test(m[2]!) && /(?<![\w-])(?:rows|two|three|four|five|six|seven|eight|nine|ten|[2-9]\d*|1\d+)(?![\w-])/i.test(m[2]!)));
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

/** The only posting-time token that new-page may fill. */
export function postedHeader(text: string): { line: number; column: number } | null {
  const lines = text.split(/\r?\n/);
  const title = lines.findIndex(line => line.startsWith('# '));
  const line = title < 0 ? -1 : lines.findIndex((line, index) => index > title && line.trim() !== '');
  if (line < 0) return null;
  const marker = /\bwritten[ \t]+\{posted\}(?!\})/.exec(lines[line]!);
  return marker ? { line, column: marker.index + marker[0].indexOf('{') } : null;
}

/** Posted Kickoffs escape write-time placeholders so the writer preserves their literal spelling. */
export function placeholderProblems(text: string): string[] {
  const lines = text.split(/\r?\n/), title = lines.findIndex(line => line.startsWith('# '));
  const header = title < 0 ? -1 : lines.findIndex((line, index) => index > title && line.trim() !== '');
  const posted = postedHeader(text);
  let postingTime = false;
  return lines.flatMap((line, index) => [...line.matchAll(/(?<!\{)\{(now|today|session|posted)\}(?!\})/g)]
    .filter(match => {
      if (match[1] === 'posted') return posted?.line !== index || posted.column !== match.index || postingTime;
      if (index !== header || match[1] !== 'now' || postingTime || posted) return true;
      postingTime = true; return false;
    })
    .map(match => `line ${index + 1}: ${match[0]} needs doubled braces; a posted Kickoff keeps the placeholder only when the file doubles its braces`));
}

/** Read the primary TRAIN id consistently for lookup and release rules. */
export function primaryTrainId(text: string): string {
  const train = /^TRAIN:[ \t]*(.+)$/m.exec(text)?.[1] ?? '';
  return (train.split(/[,\s]/)[0] ?? '').replace(/[;]$/, '').replace(/^`(.*)`$/, '$1');
}

/** Check the primary TRAIN id and each carried id; trailing register prose is not an id. */
export function trainProblems(text: string, record: unknown): string[] {
  const r = record as { schema?: unknown; items?: { id?: unknown; status?: unknown }[] } | null;
  if (!r || r.schema !== 1 || !Array.isArray(r.items) || r.items.some(i => !i || typeof i.id !== 'string' || !['open', 'done', 'dropped'].includes(String(i.status))) || new Set(r.items.map(i => i.id)).size !== r.items.length) return ['train register is not a valid schema-1 record'];
  const train = /^TRAIN:[ \t]*(.+)$/m.exec(text)?.[1] ?? '';
  const unquote = (id: string): string => id.replace(/^`(.*)`$/, '$1');
  const primary = primaryTrainId(text);
  const ids = [primary];
  const place = /\(([^;)]*)/.exec(train)?.[1]?.trim() ?? '<place>';
  const commaIds = train.split('(')[0]!.split(',').slice(1).map(id => unquote(id.trim().replace(/\.$/, ''))).filter(id => /^[a-z0-9][a-z0-9-]*$/.test(id));
  const listProblems = commaIds.length ? [`TRAIN lists ${commaIds.map(id => `'${id}'`).join(', ')} after a comma; write it as ${primary} (${place}; this unit also carries ${commaIds.join(', ')})`] : [];
  const carried = /;\s*this unit also carries\s+([^)]*)/.exec(train)?.[1];
  const malformed: string[] = [];
  for (const part of carried?.split(/,\s*|\s+and\s+|\.\s+(?=`)/) ?? []) {
    const piece = part.trim().replace(/^and\s+/, '').replace(/\.$/, '');
    if (piece.includes('`') && !/^`[a-z0-9][a-z0-9-]*`$/.test(piece.trim())) {
      malformed.push("TRAIN carries a malformed id '" + piece.trim() + "'");
      if (!/^`?[a-z0-9][a-z0-9-]*`?$/.test(piece.trim())) continue;
    }
    if (!/^`?[a-z0-9][a-z0-9-]*`?$/.test(piece.trim())) break;
    ids.push(unquote(piece.trim()));
  }
  const spares: string[] = [];
  for (const line of text.matchAll(/^SPARE TRAIN:[ \t]*(.*)$/gm)) {
    const value = line[1]!.replace(/\([^)]*\)/g, '').trim();
    if (value === 'none') continue;
    for (const piece of value.split(',').map(piece => piece.trim())) {
      if (!/^`?[a-z0-9][a-z0-9-]*`?$/.test(piece)) malformed.push(`SPARE TRAIN needs an id or none, not '${piece}': ${line[0].trim()}`);
      else spares.push(unquote(piece));
    }
  }
  const spareProblems = [...new Set(spares)].filter(id => !r.items!.some(item => item.id === id && item.status === 'open'))
    .map(id => `SPARE TRAIN id '${id}' is not an open item in the train register; a spare comes from the open train`);
  return [...listProblems, ...[...new Set(ids)].filter(id => !r.items!.some(item => item.id === id && item.status === 'open'))
    .map(id => "TRAIN id '" + id + "' is not an open item in the train register; a project that keeps its own queue adds a pointer first: deskpost train add <id> --title <t> --place lane:<project> --source <its TRAIN.md>"), ...malformed, ...spareProblems];
}

/** Decision 2026-10-27: every release names the auditor's answering letter; text only, not a letter lookup. */
export function auditProblems(text: string): string[] {
  if (!/^release-/.test(primaryTrainId(text))) return [];
  const audit = sectionText(text, 'WHY NOW').split(/\r?\n/).find(line => line.startsWith('- **Audit:**')) ?? '';
  return /\blibrary-auditor\b/.test(audit) && /\[\[letters\/notes\/[^\]\s]+\]\]/.test(audit) ? []
    : ['release Kickoff needs a WHY NOW - **Audit:** line naming library-auditor and its answering [[letters/notes/<page>]] (Decision 2026-10-27)'];
}

/** Decision 2026-10-27's sensitive files, including a kernel file written by basename alone. */
export const SENSITIVE_PATHS: readonly RegExp[] = [
  /(?<![\w./-])(?:kernel\/src\/)?guards\.ts\b/g, // guards
  /(?<![\w./-])(?:kernel\/src\/)?(?:hook[\w-]*|codexhooktrust)\.ts\b|\.githooks\/[^\s`'",;)]*/g, // hooks
  /[\w./-]*(?:settings|secret|credential)[\w./-]*[./][\w-][\w./-]*|[\w./-]*[./][\w./-]*(?:settings|secret|credential)[\w./-]*/g, // settings and credentials
  /(?<![\w./-])(?:kernel\/src\/)?locks\.ts\b/g, // locks
  /(?<![\w./-])(?:kernel\/src\/)?(?:undo|journal)\.ts\b/g, // undo and journals
  /(?<![\w./-])(?:kernel\/src\/)?(?:netpolicy|postbox|basicmemory|bm[\w-]*|updatecheck|reportsend|install|upgrade)\.ts\b/g, // network
  /(?<![\w./-])(?:tools\/owns\.mts|(?:kernel\/src\/)?kickoffcheck\.ts)\b/g, // ownership
];

export function secondReadProblems(text: string): string[] {
  const owns = (sectionText(text, 'OWNS') + '\n' + sectionText(text, 'OWNS PATHS')).replace(/\\/g, '/')
    .replace(/(?<![\w./-])(?:[A-Za-z]:\/[^\s`'",;)]*?\/(?:app|codex-dev)\/|\.\/|app\/)/g, '');
  const first = SENSITIVE_PATHS.flatMap(pattern => [...owns.matchAll(pattern)]).sort((a, b) => a.index! - b.index!)[0]?.[0];
  if (!first) return [];
  const second = sectionText(text, 'WHY NOW').split(/\r?\n/).some(line => line.startsWith('- **Second read:**') && /\blibrary-auditor\b/.test(line));
  const file = first.includes('/') || !first.endsWith('.ts') ? first : `kernel/src/${first}`;
  return second ? [] : [`OWNS names sensitive path ${file}: needs a WHY NOW - **Second read:** line naming library-auditor (Decision 2026-10-27)`];
}

/** docs/areas.json as the source tool passes it: each lane's areas and each area's files (`shared` files are in no area). */
export type KickoffAreas = { lanes: Record<string, readonly string[]>; areas: Record<string, readonly string[]> };

/**
 * A KICKOFF STAYS IN ONE LANE (Two Builders rule 9; kickoffs/s206-r2 row 2). With WHY NOW's `- **Lane:** <lane>`, each
 * OWNS PATHS pattern is matched against the files `areas` lists: a file in another lane's area is a problem unless a
 * `- **Cross-lane:**` path matches it. A file the areas file does not list (docs/, templates/, a new file) is not judged;
 * no Lane bullet, or a `<placeholder>` value, judges nothing.
 */
export function laneProblems(text: string, areas: KickoffAreas): string[] {
  const why = sectionText(text, 'WHY NOW').split(/\r?\n/);
  const value = why.find(line => line.startsWith('- **Lane:**'))?.slice('- **Lane:**'.length).trim() ?? '';
  if (!value || /^<[^>]*>$/.test(value)) return [];
  const lane = value.split(/\s+/)[0]!.replace(/`/g, '');
  if (!Object.hasOwn(areas.lanes, lane)) return [`WHY NOW - **Lane:** ${lane} is not a lane in docs/areas.json (${Object.keys(areas.lanes).join(', ')})`];
  const cross = why.filter(line => line.startsWith('- **Cross-lane:**'))
    .flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]!));
  const laneOf = new Map(Object.entries(areas.lanes).flatMap(([name, list]) => list.map(area => [area, name] as const)));
  return ownsPaths(text).patterns.flatMap(pattern => Object.entries(areas.areas)
    .filter(([area]) => !areas.lanes[lane]!.includes(area))
    .flatMap(([area, files]) => files.filter(file => ownsPatternMatches(pattern, file) && !cross.some(path => ownsPatternMatches(path, file)))
      .map(file => `OWNS PATHS ${pattern} names ${file}, in area ${area} of lane ${laneOf.get(area) ?? 'none'}, outside this Kickoff's lane ${lane}: ` +
        'name it on a WHY NOW - **Cross-lane:** line with the reason, or give it to its own lane (Two Builders rule 9)')));
}

/**
 * docs/areas.json's numbers for new self-test sections (PLAN-lane-test-files.md, Design 5; kickoffs/s210 row 3): each
 * lane's `[first, last]`, and the numbers below the lanes that a unit posted before them may still add, by unit id.
 */
export type KickoffNumbering = { section_ranges: Record<string, readonly [number, number]>; grandfathered_sections: Record<string, readonly number[]> };

/** The numbers lane sections take (docs/areas.json `section_ranges`); grandfathered numbers are below them. */
export const LANE_SECTION_NUMBERS = { first: 1000, last: 1999 } as const;

/**
 * THE NUMBERING RULES, IN ONE PLACE (kickoffs/s210-r2 row 3), for tools/areas.mts `sectionRangeFaults` and
 * `parseKickoffNumbering`: every range inside LANE_SECTION_NUMBERS with its first not after its last, the ranges
 * disjoint, a range only for a lane when `lanes` is given, and grandfathered numbers below LANE_SECTION_NUMBERS.
 */
export function sectionNumberingFaults(ranges: Readonly<Record<string, readonly [number, number]>>, grandfathered: Readonly<Record<string, readonly number[]>>, lanes?: readonly string[]): string[] {
  const { first: low, last: high } = LANE_SECTION_NUMBERS;
  const faults: string[] = [];
  const seen: [string, number, number][] = [];
  for (const [lane, [first, last]] of Object.entries(ranges)) {
    if (lanes && !lanes.includes(lane)) faults.push(`section_ranges names ${lane}, which is not a lane`);
    if (first > last || first < low || last > high) faults.push(`section_ranges ${lane} ${first} to ${last} is not a range inside ${low} to ${high}`);
    for (const [other, a, b] of seen) if (first <= b && a <= last) faults.push(`section_ranges ${lane} ${first} to ${last} overlaps ${other} ${a} to ${b}`);
    seen.push([lane, first, last]);
  }
  for (const [unit, numbers] of Object.entries(grandfathered)) {
    const above = numbers.filter(n => n >= low);
    if (above.length) faults.push(`grandfathered_sections ${unit} names ${above.join(', ')}: grandfathered numbers are below ${low}`);
  }
  return faults;
}

/** The numbering from docs/areas.json's text (null: there is no such file), or why it cannot be read. */
export function parseKickoffNumbering(text: string | null): KickoffNumbering | { unreadable: string } {
  if (text === null) return { unreadable: 'docs/areas.json is missing' };
  let record: { section_ranges?: unknown; grandfathered_sections?: unknown; lanes?: unknown } | null;
  try { record = JSON.parse(text.replace(/^﻿/, '')) as typeof record; }
  catch (error) { return { unreadable: `docs/areas.json cannot be read: ${(error as Error).message}` }; }
  const map = (value: unknown, each: (item: unknown) => boolean) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(each);
  const numbers = (value: unknown) => Array.isArray(value) && value.every(item => Number.isInteger(item));
  if (!map(record?.section_ranges, item => numbers(item) && (item as number[]).length === 2)) return { unreadable: 'docs/areas.json cannot be read: it has no section_ranges of [first, last] for each lane' };
  const grandfathered = record?.grandfathered_sections ?? {};
  if (!map(grandfathered, numbers)) return { unreadable: 'docs/areas.json cannot be read: its grandfathered_sections is not a list of numbers for each unit' };
  const result = { section_ranges: record!.section_ranges as KickoffNumbering['section_ranges'], grandfathered_sections: grandfathered as KickoffNumbering['grandfathered_sections'] };
  const lanes = record?.lanes && typeof record.lanes === 'object' && !Array.isArray(record.lanes) ? Object.keys(record.lanes) : undefined;
  const faults = sectionNumberingFaults(result.section_ranges, result.grandfathered_sections, lanes);
  return faults.length ? { unreadable: `docs/areas.json cannot be read: ${faults.join('; ')}` } : result;
}

/**
 * The new self-test sections OWNS declares (kickoffs/s210-r2 row 1), read with inline code marks and emphasis removed and
 * an en or em dash as a hyphen: `new (self-test) section(s)` or `add(s|ing) (a) (new) section(s)`, an optional colon, then
 * numbers joined by commas, `and`, `to` or a hyphen. `unreadable` holds each such phrase followed by no number, other
 * than one negated (`no new section`, `does not add a section`) or one referring back (`your new sections`, `each new
 * section needs ...`).
 */
export function newSectionDeclarations(text: string, section = 'OWNS'): { numbers: number[]; unreadable: string[] } {
  const owns = sectionText(text, section).replace(/[`*]/g, '').replace(/\b_+|_+\b/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  const item = String.raw`\d+(?:(?: to | ?- ?)\d+)?`;
  const phrase = String.raw`\b(?:new (?:self-test )?|(?:adds|add|adding) (?:a )?(?:new )?(?:self-test )?)sections?(?: numbers?)?(?![\w-])`;
  const found = new Set<number>();
  const unreadable: string[] = [];
  for (const match of owns.matchAll(new RegExp(String.raw`${phrase}:? ?(${item}(?:(?:,\s*(?:and )?| and )${item})*)?`, 'gi'))) {
    if (/\b(?:no|not|nor|without) $/i.test(owns.slice(0, match.index))) continue;
    if (match[1] === undefined) {
      // `your new sections`, `each new section needs ...`: a reference to sections declared elsewhere, not a declaration.
      if (!/\b(?:the|your|its|their|each|every|any|a|an|these|those|this|that|which) $/i.test(owns.slice(0, match.index))) unreadable.push(owns.slice(match.index).split(/[.;(]/)[0]!.trim().slice(0, 60));
      continue;
    }
    for (const part of match[1].split(/,| and/)) {
      const range = /(\d+)(?: to | ?- ?)(\d+)/.exec(part);
      const [first, last] = range ? [Number(range[1]), Number(range[2])] : [Number(part.trim()), Number(part.trim())];
      for (let n = first; n <= last && n - first < 1000; n += 1) found.add(n);
    }
  }
  return { numbers: [...found].sort((a, b) => a - b), unreadable };
}

/** The new self-test section numbers OWNS declares (`newSectionDeclarations`). */
export function newSectionNumbers(text: string): number[] {
  return newSectionDeclarations(text).numbers;
}

/**
 * A KICKOFF'S NEW SECTIONS STAY IN ITS LANE'S FILE AND RANGE (PLAN-lane-test-files.md, Design 5, "The Kickoff rule";
 * kickoffs/s210 row 3). It applies when the Kickoff adds sections: its OWNS names new section numbers, or its OWNS PATHS
 * names a file under kernel/test/lanes/ other than harness.ts. Then it refuses a missing `- **Lane:**`; numbering that
 * could not be read (fail closed for these Kickoffs only; others keep their verdict); a new number outside the lane's
 * range, unless docs/areas.json grandfathers it for this unit (its id without an `-r<n>` suffix); a number in the lane's
 * range when OWNS PATHS does not name that lane's test and claim files (kickoffs/s210-r2 row 1); a declaration with no
 * readable number; and another lane's test or claim file, unless a `- **Cross-lane:**` path names it.
 */
export function sectionRangeProblems(text: string, numbering: KickoffNumbering | { unreadable: string } | undefined): string[] {
  const { numbers, unreadable } = newSectionDeclarations(text);
  const patterns = ownsPaths(text).patterns;
  const laneFiles = patterns.filter(pattern => pattern.startsWith('kernel/test/lanes/') && pattern !== 'kernel/test/lanes/harness.ts');
  if (!numbers.length && !laneFiles.length && !unreadable.length) return [];
  const adds = numbers.length ? `new sections ${numbers.join(', ')}` : laneFiles.length ? `OWNS PATHS ${laneFiles.join(', ')}` : 'new sections with no readable number';
  const why = sectionText(text, 'WHY NOW').split(/\r?\n/);
  const value = why.find(line => line.startsWith('- **Lane:**'))?.slice('- **Lane:**'.length).trim() ?? '';
  const lane = !value || /^<[^>]*>$/.test(value) ? '' : value.split(/\s+/)[0]!.replace(/`/g, '');
  const problems = unreadable.map(said => `New sections: OWNS declares new self-test sections but names no number this check can read: "${said}"; write them as New sections N to M`);
  if (!lane) problems.push(`New sections: this Kickoff adds self-test sections (${adds}), so WHY NOW needs a - **Lane:** line naming the lane whose file and range they use`);
  if (numbering === undefined || 'unreadable' in numbering) {
    problems.push(`New sections: ${numbering === undefined ? 'docs/areas.json was not read' : numbering.unreadable}; a Kickoff that adds self-test sections (${adds}) is refused until its section_ranges can be read`);
    return problems;
  }
  if (!lane) return problems;
  const range = numbering.section_ranges[lane];
  if (!range) return [...problems, `New sections: lane ${lane} has no range in docs/areas.json section_ranges (${Object.keys(numbering.section_ranges).join(', ')})`];
  const unit = /^# ([a-z][a-z0-9-]*?)(?:-r\d+)? kickoff:/m.exec(text)?.[1] ?? '';
  const grandfathered = (Object.hasOwn(numbering.grandfathered_sections, unit) ? numbering.grandfathered_sections[unit] : undefined) ?? [];
  for (const n of numbers) {
    if (n >= range[0] && n <= range[1]) continue;
    if (grandfathered.includes(n)) continue;
    problems.push(`New sections: section ${n} is outside lane ${lane}'s range ${range[0]} to ${range[1]} in docs/areas.json, and is not grandfathered for unit ${unit || '(no unit id in the title)'}`);
  }
  const inRange = numbers.filter(n => n >= range[0] && n <= range[1]);
  const missing = [`kernel/test/lanes/${lane}.ts`, `kernel/test/lanes/${lane}.covers.json`].filter(file => !patterns.some(pattern => ownsPatternMatches(pattern, file)));
  if (inRange.length && missing.length) {
    problems.push(`New sections: section ${inRange.join(', ')} is in lane ${lane}'s range, so it goes in that lane's files, and OWNS PATHS does not name ${missing.join(' or ')}`);
  }
  const cross = why.filter(line => line.startsWith('- **Cross-lane:**')).flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]!));
  for (const pattern of laneFiles) {
    const named = /^kernel\/test\/lanes\/([a-z0-9-]+)\.(?:ts|covers\.json)$/.exec(pattern)?.[1];
    if (!pattern.includes('*') && (named === undefined || !Object.hasOwn(numbering.section_ranges, named))) {
      problems.push(`New sections: OWNS PATHS ${pattern} is not a lane's test or claim file (kernel/test/lanes/<lane>.ts or .covers.json, a lane of docs/areas.json)`);
    }
    for (const other of Object.keys(numbering.section_ranges).filter(name => name !== lane)) {
      for (const file of [`kernel/test/lanes/${other}.ts`, `kernel/test/lanes/${other}.covers.json`]) {
        if (ownsPatternMatches(pattern, file) && !cross.some(path => ownsPatternMatches(path, file))) {
          problems.push(`New sections: OWNS PATHS ${pattern} names ${file}, lane ${other}'s file, not lane ${lane}'s: new sections go in the Kickoff lane's own file, or name it on a - **Cross-lane:** line with the reason`);
        }
      }
    }
  }
  return problems;
}

/** c71 parked on the clone's stale master; a prohibition without a git command must not warn. */
export function wslMasterRows(text: string): number[] {
  return sectionText(text, 'ROWS').split(/(?=^\d+\. )/m)
    .filter(row => /^\d+\. /.test(row) && row.includes('wsl-run.mts') && /\bgit[ \t]+(?:-[^\r\n]*?[ \t]+)?(?:rev-parse|checkout|merge|log|diff|reset)\b[^\r\n]*\borigin\/master(?=\.{2,3}|(?![\w/.-]))/.test(row))
    .map(row => Number(/^(\d+)\./.exec(row)![1]));
}

// Value-taking options from Node 24.22.3 --help; section 1442 checks the running Node.
export const NODE_VALUE_OPTIONS = new Set([
  '--allow-fs-read', '--allow-fs-write', '--build-snapshot-config', '--conditions', '--cpu-prof-dir', '--cpu-prof-interval',
  '--cpu-prof-name', '--debug-port', '--diagnostic-dir', '--disable-proto', '--disable-warning', '--dns-result-order', '--env-file',
  '--env-file-if-exists', '--eval', '--experimental-config-file', '--experimental-default-config-file', '--experimental-loader', '--experimental-package-map',
  '--experimental-sea-config', '--experimental-test-isolation', '--experimental-test-tag-filter', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
  '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir', '--import', '--input-type', '--inspect-port', '--inspect-publish-uid',
  '--loader', '--localstorage-file', '--max-http-header-size', '--max-old-space-size-percentage', '--network-family-autoselection-attempt-timeout', '--openssl-config',
  '--redirect-warnings', '--report-dir', '--report-directory', '--report-filename', '--report-signal', '--require',
  '--run', '--secure-heap', '--secure-heap-min', '--snapshot-blob', '--test-concurrency', '--test-coverage-branches',
  '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines', '--test-global-setup', '--test-isolation',
  '--test-name-pattern', '--test-random-seed', '--test-reporter', '--test-reporter-destination', '--test-rerun-failures', '--test-shard',
  '--test-skip-pattern', '--test-timeout', '--title', '--tls-cipher-list', '--tls-keylog', '--trace-event-categories',
  '--trace-event-file-pattern', '--trace-require-module', '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal',
  '--watch-path', '-C', '-e', '-r',
]);

/**
 * Two Builders rules (Eric, 2026-11-10): a builder Kickoff orders no push test run and no push to master. Inline code
 * and fenced command lines count; STAY OUT OF, NOT CHARTERED and NOT BUILDING may name them; a release TRAIN is exempt.
 */
export function builderPushLines(text: string): { line: number; text: string }[] {
  if (/^release-/.test(primaryTrainId(text))) return [];
  // Shell operators delimit commands only outside quoted arguments.
  const commands = (span: string): string[] => {
    const parts: string[] = [];
    let quote = '', start = 0;
    for (let n = 0; n < span.length; n++) {
      const char = span[n]!;
      if (char === '\\' && quote !== "'" && /[\\'"]/.test(span[n + 1] ?? '')) { n++; continue; }
      if (quote) { if (char === quote) quote = ''; }
      else if (char === "'" || char === '"') quote = char;
      else if (';|&'.includes(char)) { parts.push(span.slice(start, n)); start = n + 1; }
    }
    return [...parts, span.slice(start)];
  };
  let heading = '';
  const { inside, markers } = fencedLines(text);
  const starts = sectionStarts(text);
  return text.split(/\r?\n/).flatMap((line, index) => {
    heading = starts.find(start => start.line === index)?.name ?? heading;
    if (markers[index]) return [];
    if (heading === 'STAY OUT OF' || heading === 'NOT CHARTERED' || heading === 'NOT BUILDING') return [];
    const spans = inside[index] ? [line] : [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
    const orders = spans.some(span => commands(span).some(code => {
      const command = code.trim().replace(/^\(/, '').replace(/\)$/, '').replace(/^env[ \t]+/, '').replace(/^(?:[A-Za-z_][\w]*=\S*[ \t]+)*/, '');
      const words = (command.match(/(?:[^\s'"]+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []).map(word =>
        word.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_match, double, single) => single ?? double.replace(/\\(["\\])/g, '$1')));
      if (words[0] === 'npx' && words[1] === 'tsx') words.splice(0, 2, 'node');
      if (/^node(?:\.exe)?$/.test(words[0] ?? '')) {
        let script = 1, uncertain = false;
        while (script < words.length) {
          const word = words[script]!;
          if (word === '--') { script++; break; }
          if (word === '-' || /^(?:--eval|--print|--run)(?:=|$)/.test(word) || /^(?:-e|-p|-pe)$/.test(word)) return false;
          if (NODE_VALUE_OPTIONS.has(word)) { script += 2; continue; }
          if (!word.startsWith('-')) break;
          if (word.startsWith('--') && !word.includes('=')) uncertain = true;
          script++;
        }
        return words.slice(script, script + (uncertain ? 2 : 1)).some((word, offset) =>
          /^(?:.*[\\/])?tools[\\/]gate\.ts$/.test(word) &&
          /--tier(?:[ \t]+|=)push\b/.test(words.slice(script + offset + 1).join(' ')));
      }
      if (words.shift() !== 'git') return false;
      while (/^(?:-[A-Za-z]|--[\w-]+(?:=.*)?)$/.test(words[0] ?? '')) {
        words.splice(0, /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(words[0]!) ? 2 : 1);
      }
      if (words.shift() !== 'push') return false;
      if (words.includes('--all') || words.includes('--mirror')) return true;
      let remote = false;
      const operands: string[] = [];
      for (let n = 0; n < words.length; n++) {
        const word = words[n]!;
        if (word === '--repo') { n++; remote = true; }
        else if (word.startsWith('--repo=')) remote = true;
        else if (!word.startsWith('-')) operands.push(word);
      }
      return operands.slice(remote ? 0 : 1).some(refspec => /(?:^|:)\+?(?:refs\/heads\/)?master$/.test(refspec));
    }));
    return orders ? [{ line: index + 1, text: line.trim() }] : [];
  });
}

export function describeBuilderPushLines(lines: readonly { line: number; text: string }[]): string[] {
  return lines.map(found => `line ${found.line} orders a push test run or a push to master: a builder Kickoff lands through \`node tools/land.mts --open int/<unit>\`; a push test run takes every test slot (Two Builders rules): "${found.text}"; a prohibition names the command under STAY OUT OF, NOT CHARTERED or NOT BUILDING`);
}

/** A Done when document command cannot judge files owned by behaviour checks. */
export function docsFileRouteWarnings(text: string): string[] {
  return sectionText(text, 'ROWS').split(/(?=^\d+\. )/m).flatMap(row => {
    const number = /^(\d+)\./.exec(row)?.[1];
    if (!number || !row.includes('Done when:')) return [];
    const done = row.slice(row.indexOf('Done when:'));
    return [...done.matchAll(/docs-gate\.ts([^\n;]*)/g)]
      .flatMap(command => [...command[1]!.matchAll(/--file(?=[ \t`'"]|$)(?:[ \t]+[`'"]?([^\s`'"]+))?/g)])
      .flatMap(match => {
        const file = match[1];
        if (!file || file.startsWith('--')) return [`row ${number}: docs-gate.ts --file needs a path`];
        return /^(?:\.[^/]+|kernel|tools|templates)\//.test(file)
          ? [`row ${number} asks docs-gate.ts --file to judge ${file}, which is a behaviour file: stage it and let the commit hook run its mapped checks (node tools/gate.ts --tier commit)`] : [];
      });
  });
}

/** A page name the Kickoff gives explicitly; page placeholders describe future pages and are not lookups. */
export function kickoffNames(text: string): { name: string; line: number }[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const names = [...line.matchAll(/\[\[((?:projects\/[^/\]\s]+\/[^\]|]+)|(?:[^\]\s|]+\/notes\/[^\]|]+))(?:\|[^\]]*)?\]\]/g)].map(m => m[1]!);
    for (const phrase of line.matchAll(/`(projects\/[a-z0-9-]+)` pages? ((?:`(?!projects\/)[^`]+`(?:\s*,\s*(?:and\s+)?|\s+and\s+)?)+)/g)) {
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

/**
 * SECTIONS A KICKOFF LEAVES PINNED (kickoffs/s194 spare S1, `kickoff-check-pinned-sections`; s192 had to change section
 * 665's words for `kernel/src/undo.ts` while its STAY OUT OF kept every section but 672 to 677). For each `kernel/src`
 * file OWNS PATHS names, the sections `covers` (kernel/test/section-covers.json's `sections`) says claim it, outside the
 * one range STAY OUT OF leaves open in the form `every self-test section but <a> to <b>`, and not named in OWNS. Only
 * that form is recognised; a Kickoff without it, or a check given no covers, warns of nothing.
 */
export function pinnedSectionWarnings(text: string, covers: Record<string, readonly string[]>): string[] {
  const range = /every self-test section but (\d+) to (\d+)/.exec(sectionText(text, 'STAY OUT OF').replace(/\s+/g, ' '));
  if (!range) return [];
  const [low, high] = [Number(range[1]), Number(range[2])];
  const named = new Set<number>();
  const owns = sectionText(text, 'OWNS').replace(/\s+/g, ' ');
  // Only numbers OWNS names as sections (s196 spare S1), so "rows 1 to 4" or "c121 takes 715 to 719" name none.
  for (const m of owns.matchAll(/\bsections? (\d+) to (\d+)\b/gi)) for (let n = Number(m[1]); n <= Number(m[2]) && n - Number(m[1]) < 1000; n += 1) named.add(n);
  for (const m of owns.matchAll(/\bsections? (\d+(?:(?:,\s*(?:and )?| and )\d+)*)\b/gi)) for (const n of m[1]!.match(/\d+/g)!) named.add(Number(n));
  // "N (...)" at the top level of an existing-sections list, which runs to the first full stop outside parentheses.
  for (const list of owns.matchAll(/\bexisting sections\b/gi)) {
    let depth = 0;
    for (let i = list.index + list[0].length; i < owns.length; i += 1) {
      const c = owns[i]!;
      if (c === '(') depth += 1; else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '.' && depth === 0 && (i + 1 === owns.length || owns[i + 1] === ' ')) break;
      const m = depth === 0 ? /^(\d+) \(/.exec(owns.slice(i)) : null;
      if (m && !/\d/.test(owns[i - 1] ?? '')) named.add(Number(m[1]));
    }
  }
  const files = ownsPaths(text).patterns.filter((pattern) => pattern.startsWith('kernel/src/'));
  const warnings: string[] = [];
  for (const pattern of files) {
    const claimed = Object.entries(covers)
      .filter(([key, paths]) => /^\d+$/.test(key) && paths.some((file) => ownsPatternMatches(pattern, file)))
      .map(([key]) => Number(key))
      .filter((n) => (n < low || n > high) && !named.has(n))
      .sort((a, b) => a - b);
    if (claimed.length) {
      warnings.push(`OWNS PATHS names ${pattern}, and sections ${claimed.join(', ')} claim it in kernel/test/section-covers.json outside STAY OUT OF's ${low} to ${high}: ` +
        'a row that changes words they pin cannot change them; name in OWNS the ones it may change');
    }
  }
  return warnings;
}

/** A revision must keep its evidence apart from an earlier attempt. Advice only, for the pinned path form. */
export function revisionEvidenceWarnings(text: string): string[] {
  // The unit's id without the title's `-r<n>` (s196 row 4): `# c108-r2 kickoff:` is unit c108.
  const id = /^# ([a-z][a-z0-9-]*?)(?:-r\d+)? kickoff:/m.exec(text)?.[1];
  const revision = Number(/Revision:\s*\*\*r(\d+)\*\*/.exec(text)?.[1] ?? 0);
  if (!id || revision < 2) return [];
  const original = `D:/dev/scratch/deskpost/${id}/`;
  // The folder name ends at a slash, a backtick, whitespace, the line's end or closing punctuation.
  const paths = sectionText(text, 'OPEN').matchAll(/D:\/dev\/scratch\/deskpost\/([a-z0-9-]+)(?=$|[\s/`'"),.;:\]])/gm);
  return [...paths].some(match => match[1] === id)
    ? [`Revision r${revision} names the original evidence folder ${original}; name D:/dev/scratch/deskpost/${id}-r${revision}/ instead.`] : [];
}

/** A new verb action needs its declaration's actions list as well as its words (c155; workshop w17). */
function newActionWarnings(text: string): string[] {
  if (!ownsPaths(text).patterns.includes('kernel/src/verbs.ts')) return [];
  const sentences = sectionText(text, 'OWNS').split(/(?<=[.!?])\s+/);
  const warned = new Set<string>(), warnings: string[] = [];
  for (const row of sectionText(text, 'ROWS').split(/(?=^(?:S)?\d+\. )/m)) {
    const number = /^((?:S)?\d+)\./.exec(row)?.[1];
    if (!number) continue;
    for (const match of row.matchAll(/`([^`]+)`/g)) {
      const [verb = '', action = ''] = match[1]!.trim().replace(/^deskpost\s+/, '').split(/\s+/);
      const actions = Object.hasOwn(VERBS, verb) ? VERBS[verb]!.actions : [];
      if (!actions.length || !/^[a-z][a-z-]*$/.test(action) || actions.includes(action) || warned.has(verb) ||
          !sentences.some(sentence => sentence.includes('`' + verb + '` declaration') && !/\bactions\b/.test(sentence))) continue;
      warned.add(verb);
      warnings.push(`row ${number} names ${verb} ${action}, an action ${verb} does not have at this base (actions: ${actions.join(', ')}), and OWNS gives the ${verb} declaration without its actions list, which a new action needs (commandAction, kernel/src/verbs.ts)`);
    }
  }
  return warnings;
}

function baseRunSectionWarnings(text: string): string[] {
  const rowZero = sectionText(text, 'ROWS').split(/(?=^(?:[AB])?\d+\. )/m).filter(row => /^(?:[AB])?0\. /.test(row));
  const base = [sectionText(text, 'OPEN'), ...rowZero].join('\n');
  const used = new Set<number>();
  for (const run of base.matchAll(/\bLIBRARY_SELFTEST_SECTIONS\s*=\s*['"]?([0-9]+(?:\s*,\s*[0-9]+)*)/g)) {
    for (const number of run[1]!.split(',')) used.add(Number(number));
  }
  const added = new Set([...newSectionNumbers(text), ...newSectionDeclarations(text, 'RULES').numbers]);
  return [...added].filter(number => used.has(number))
    .map(number => `New sections: section ${number} appears in a base run before this unit adds it.`);
}

/** The tool and both posting paths share this verdict. Received pages skip names; a bare tool warns when it has names. */
export function kickoffVerdict(
  text: string,
  options: { adrFiles: readonly string[]; train?: { record: unknown }; placeholders?: boolean; postedHint?: boolean; names?: boolean; missingAdrs?: 'refuse' | 'warn'; resolveName?: (name: string) => NameResolution; covers?: Record<string, readonly string[]>; areas?: KickoffAreas;
    numbering?: KickoffNumbering | { unreadable: string }; newPathMapped?: (file: string) => boolean },
): { problems: string[]; warnings: string[]; sectionCount: number; sectionNames: string[] } {
  const names = options.names === false ? [] : kickoffNames(text);
  const nameProblems = options.resolveName ? names.flatMap(({ name, line }) => {
    try {
      const result = options.resolveName!(name);
      return result.status === 'exists' ? [] : ['line ' + line + ': page ' + name + ' is ' + result.status + (result.status === 'unreadable' ? ': ' + result.reason : '')];
    } catch (error) { return ['line ' + line + ': page ' + name + ' is unreadable: ' + String(error)]; }
  }) : [];
  const { unclosed } = fencedLines(text);
  const problems = [
    ...(unclosed === null ? [] : [`unclosed code fence at line ${unclosed}`]),
    ...describeProblems(checkKickoff(text)),
    ...ownsPaths(text).problems,
    ...nameProblems,
    ...requiredReadProblems(text),
    ...describeMissingAdrs(missingAdrs(text, options.adrFiles).filter(adr => options.missingAdrs !== 'warn' || adr.startsWith('new ')), options.adrFiles),
    ...describeMissingRequiredSections(missingRequiredSections(text)),
    ...describeCommaRows(commaRowLines(text)),
    ...(options.placeholders === false ? [] : placeholderProblems(text).map(problem => problem + (options.postedHint ? ' (a posted page: run kickoff check --posted)' : ''))),
    ...auditProblems(text),
    ...secondReadProblems(text),
    ...(options.areas ? laneProblems(text, options.areas) : []),
    ...sectionRangeProblems(text, options.numbering),
    ...describeBuilderPushLines(builderPushLines(text)),
    ...chainProblems(text),
    ...(options.train ? trainProblems(text, options.train.record) : []),
  ];
  const warnings = [
    ...ownsPaths(text).patterns.filter(pattern => pattern.includes('*') && pattern.split('/').includes('fixtures')).map(pattern =>
      `OWNS PATHS ${pattern} covers a fixtures folder: sensitive-named fixtures under it are accepted; the handback names each one`),
    ...(options.missingAdrs === 'warn' ? missingAdrs(text, options.adrFiles).filter(adr => !adr.startsWith('new ')).map(adr =>
      `names ${adr}, which this installed release does not have (its docs/adr/ ends at ADR-${String(highestAdr(options.adrFiles)).padStart(4, '0')}); the source check, node tools/kickoff-check.mts in the build checkout, decides`) : []),
    ...(names.length && !options.resolveName ? ['names not checked: no Library; run deskpost kickoff check <file> in a Library to check them'] : []),
    ...describeSourceGreenHelperRows(sourceGreenHelperRows(text)),
    ...docsFileRouteWarnings(text),
    ...revisionEvidenceWarnings(text),
    ...newActionWarnings(text),
    ...baseRunSectionWarnings(text),
    ...(options.covers ? pinnedSectionWarnings(text, options.covers) : []),
    ...(options.newPathMapped && !ownsPaths(text).patterns.includes('tools/check-map.json')
      ? ownsPaths(text).patterns.filter(file => file !== 'none' && !/^<[^<>]+>$/.test(file) && !file.includes('*') && !/^(?:kernel|tools|\.githooks)\//.test(file) && !options.newPathMapped!(file))
        .map(file => `OWNS PATHS: unmapped new path ${file}; own tools/check-map.json and add its covering checks`) : []),
    ...newSectionNumbers(text).filter(number => options.covers && Object.hasOwn(options.covers, String(number)))
      .map(number => `New sections: section ${number} is taken at the base; choose a free section number`),
    ...wslMasterRows(text).map(row => `row ${row} runs a WSL step that reads origin/master: in the WSL clone that is the shared repository's local master, which pushes never move; read origin/<the unit's branch>`),
  ];
  const sectionNames = sectionStarts(text).map(start => start.name);
  return { problems, warnings, sectionCount: sectionNames.length, sectionNames };
}

/** The lines the check prints for `file`: the warnings first, then the verdict, as the tool has always printed them. */
export function verdictText(file: string, verdict: { problems: readonly string[]; warnings: readonly string[]; sectionCount?: number; sectionNames?: readonly string[] }): string {
  const warnings = verdict.warnings.map((line) => `kickoff-check: warning: ${line}\n`).join('');
  return verdict.problems.length === 0
    ? `${warnings}kickoff-check: ${file} is complete (${verdict.sectionCount} sections, ${verdict.sectionNames?.join(', ') ?? ''}; every row has "Done when:").\n`
    : `${warnings}kickoff-check: ${file} is not complete:\n${verdict.problems.map((line) => `- ${line}`).join('\n')}\n`;
}
