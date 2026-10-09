/**
 * What a person reads: `doctor` and `init` as lines, not a JSON document (PLAN-install-onboarding.md step 9, F7).
 * `--json` still gives the machine form, which every script and the acceptance matrix pass.
 *
 * GLYPHS ONLY WHERE THEY RENDER (step 0, measurement 4). A console write keeps `✓` and `✗` intact, but Consolas and
 * Lucida Console, conhost's fonts, have no glyph for either, and PowerShell capturing the output at code page 437
 * turns them into mojibake. So `✓`/`✗` are written to a terminal inside Windows Terminal (`WT_SESSION`) or off
 * Windows; everywhere else, and whenever stdout is not a terminal, it is `[ok]`/`[!]`/`[x]`. No colour is written,
 * so `NO_COLOR` has nothing to turn off.
 */

import { COMMAND_NAME } from './machine.ts';
import { roleLabel } from './seatmeta.ts';

export interface Marks {
  ok: string;
  warn: string;
  fail: string;
  skip: string;
}

export function marks(stream: { isTTY?: boolean } = process.stdout): Marks {
  const unicode = stream.isTTY === true && (process.platform !== 'win32' || Boolean(process.env['WT_SESSION'])) && !process.env['DESKPOST_ASCII'];
  return unicode ? { ok: '✓', warn: '!', fail: '✗', skip: '-' } : { ok: '[ok]', warn: '[!]', fail: '[x]', skip: '[-]' };
}

/** The oracle's PowerShell parameter names, said as the kernel's flags: a person types what this program takes (F8). */
function kernelFlags(text: string): string {
  return text.replace(/-WorkspacePath\b/g, '--workspace').replace(/(^|\s)-Seat\b/g, '$1--seat');
}

const CHECK_LABELS: Record<string, string> = {
  'program.command-resolves': 'The deskpost command',
  'program.assistant-present': 'Assistant',
  'workspace.guards-registered': 'Claude Code guards',
  'workspace.codex-guards-registered': 'Codex guards',
  'shelf.overlap-records': 'Overlap records',
  'raw.batch-owners': 'Raw batch owners',
  'shelf.references-resolve': 'Shelf references',
  'desk.seat-retirement-identity': 'Seats and owners',
  'notebook.master-index-renders': 'Notebook index',
  'shelf.catalog-renders-from-entries': 'Shelf catalog',
  'output.namespaced-by-project': 'output/ folders',
  'seats.inbound-policy': 'Seat inbound files',
  'settings.user-inbound': 'User inbound setting',
};

interface Row {
  check: string;
  status: string;
  detail: string;
}

function mark(status: string, glyphs: Marks): string {
  return status === 'pass' ? glyphs.ok : status === 'warn' ? glyphs.warn : status === 'fail' ? glyphs.fail : glyphs.skip;
}

function rowLines(rows: Row[], glyphs: Marks, all: Row[] = rows): string[] {
  const width = Math.max(...all.map((row) => (CHECK_LABELS[row.check] ?? row.check).length), 0);
  const tag = Math.max(glyphs.ok.length, glyphs.warn.length, glyphs.fail.length, glyphs.skip.length);
  return rows.map((row) => `  ${mark(row.status, glyphs).padEnd(tag)} ${(CHECK_LABELS[row.check] ?? row.check).padEnd(width)}  ${kernelFlags(row.detail)}`);
}

function tally(rows: Row[]): string {
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const parts = [`${count('pass')} passed`];
  if (count('warn')) parts.push(`${count('warn')} warning${count('warn') === 1 ? '' : 's'}`);
  if (count('fail')) parts.push(`${count('fail')} failed`);
  if (count('skipped')) parts.push(`${count('skipped')} skipped`);
  return parts.join(', ');
}

/** doctor's report as lines. With no Library it says so, rather than listing nine skips as if they were answers (F4). */
export function doctorText(report: Record<string, unknown>, glyphs: Marks = marks()): string {
  if (Array.isArray(report['libraries'])) return servedByText(report, glyphs);
  const checks = (report['checks'] as Row[] | undefined) ?? [];
  const program = (report['program_checks'] as Row[] | undefined) ?? [];
  const workspace = String(report['workspace'] ?? '');
  const lines = ['Deskpost doctor', `  Program  ${String(report['program'] ?? '')}`];
  lines.push(workspace ? `  Library  ${workspace}` : '  Library  none here; checked the program only');
  lines.push('');
  const shown = workspace ? [...program, ...checks] : program;
  lines.push(...rowLines(program, glyphs, shown));
  if (workspace) lines.push(...rowLines(checks, glyphs, shown));
  lines.push('');
  const failed = [...program, ...(workspace ? checks : [])].filter((row) => row.status === 'fail').length;
  lines.push(`Program: ${tally(program)}.` + (workspace ? ` Library: ${tally(checks)}.` : ''));
  lines.push(
    failed
      ? `${failed} check${failed === 1 ? '' : 's'} failed; each line above says how to fix it.`
      : workspace
        ? 'Nothing failed.'
        : `Nothing failed. To check a Library, run ${COMMAND_NAME} doctor inside it, or pass --workspace <folder>.`,
  );
  // --report (D6): what was filed into the Report Inbox, what was already there, and what could not be filed.
  const filing = report['report'] as Record<string, unknown> | undefined;
  if (filing) {
    const list = (key: string) => (Array.isArray(filing[key]) ? (filing[key] as Record<string, unknown>[]) : []);
    lines.push(`Reports: ${list('filed').length} filed, ${list('skipped').length} already filed, ${list('not_filed').length} not filed.`);
    for (const row of list('filed')) lines.push(`  filed    ${String(row['check'])}  ${String(row['page'])}`);
    for (const row of list('skipped')) lines.push(`  skipped  ${String(row['check'])}  already in ${String(row['page'])}`);
    for (const row of list('not_filed')) lines.push(`  not filed  ${String(row['check'])}: ${String(row['reason'])}`);
  }
  return lines.join('\n');
}

/**
 * `doctor --served-by <root>` as lines (D8): the program's own checks once, then each Library the install serves under
 * its folder, then any registered Library that could not be reached. A kept Library says so beside its folder.
 */
function servedByText(report: Record<string, unknown>, glyphs: Marks): string {
  const program = (report['program_checks'] as Row[] | undefined) ?? [];
  const libraries = report['libraries'] as { workspace: string; kept: boolean; checks: Row[] }[];
  const unreached = (report['unreached'] as string[] | undefined) ?? [];
  const lines = ['Deskpost doctor', `  Program  ${String(report['program'] ?? '')}`, `  Serves   ${libraries.length} Librar${libraries.length === 1 ? 'y' : 'ies'} of the install at ${String(report['served_by'] ?? '')}`, ''];
  const shown = [...program, ...libraries.flatMap((library) => library.checks)];
  lines.push(...rowLines(program, glyphs, shown));
  for (const library of libraries) {
    lines.push('', `  Library  ${library.workspace}${library.kept ? '  (kept as it is)' : ''}`);
    lines.push(...rowLines(library.checks, glyphs, shown));
  }
  for (const folder of unreached) lines.push('', `${glyphs.warn} Could not reach the registered Library ${folder}, so whether this install serves it is not known.`);
  lines.push('');
  lines.push(`Program: ${tally(program)}.` + libraries.map((library) => ` ${library.workspace}: ${tally(library.checks)}.`).join(''));
  const failed = Number(report['failed'] ?? 0);
  lines.push(failed ? `${failed} check${failed === 1 ? '' : 's'} failed; each line above says how to fix it.` : 'Nothing failed.');
  return lines.join('\n');
}

/**
 * init's result as lines, ending with one `Next:` line (step 9). `written` is every file the apply wrote,
 * Library-relative (runLibraryInit): the line names each by its reported action where result.files or result.skill
 * reports it, and every other write -- the marker's program_version refresh -- as written, so a refresh is never told
 * that nothing changed (S65).
 */
export function initText(result: Record<string, unknown>, written: readonly string[], glyphs: Marks = marks()): string {
  const reported = [
    ...((result['files'] as { file: string; action: string }[] | undefined) ?? []),
    ...(((result['skill'] as { files?: { file: string; action: string }[] } | undefined)?.files) ?? []),
  ];
  const covers = (entry: string, file: string) => file === entry || file.startsWith(`${entry}/`);
  const changed = [
    ...reported.filter((entry) => written.some((file) => covers(entry.file, file))),
    ...written.filter((file) => !reported.some((entry) => covers(entry.file, file))).map((file) => ({ file, action: 'written' })),
  ];
  const fresh = result['status'] === 'initialized';
  const workspace = String(result['workspace'] ?? '');
  const lines = [
    fresh
      ? `${glyphs.ok} ${workspace} is now a Library.`
      : changed.length
        ? `${glyphs.ok} ${workspace} was already a Library; ${changed.length} of its files were brought up to date.`
        : `${glyphs.ok} ${workspace} was already a Library, and nothing needed changing.`,
  ];
  if (changed.length) lines.push(`  Written: ${changed.map((file) => `${file.file} (${file.action})`).join(', ')}`);
  lines.push(`  Registered in ${String(result['registry'] ?? '')} (${String(result['registration'] ?? '')})`);
  // THE ONE COMMAND TO COME BACK TO IS THE PRODUCT'S NAME (ADR-0059): inside a Library, `deskpost` opens its menu.
  lines.push(`Next: ${COMMAND_NAME}, from inside the Library, opens its main menu.`);
  return lines.join('\n');
}

/**
 * `seat status --text`: the roster as lines (kickoffs/s79 row 4, S75 parked item 1), from the JSON that already ships
 * and nothing else. One line per seat: its claim, its Project, and for a held seat the name it answers to and its
 * inbound policy, in the JSON's own words. A held seat with no name yet says when it gets one, so "null" is never left
 * for a person to decode.
 */
export function seatStatusText(report: Record<string, unknown>): string {
  const seats = (report['seats'] as Record<string, unknown>[] | undefined) ?? [];
  const width = Math.max(...seats.map((row) => String(row['seat'] ?? '').length), 4);
  const lines = [`Deskpost seats  ${String(report['workspace'] ?? '')}`, ''];
  if (!seats.length) lines.push('  No seats yet.');
  for (const row of seats) {
    const parts = [`Project ${String(row['project'] ?? '')}`];
    // ITS ROLE AND DEPARTMENT (1.3.8, kickoffs/s96 row 1), as the projection reads them; nothing when it has none.
    const role = roleLabel({ department: typeof row['department'] === 'string' ? row['department'] : null, role: row['role'] === 'performer' || row['role'] === 'orchestrator' ? row['role'] : null, card: null, template: null });
    if (role) parts.push(role);
    // AN ATTEMPT WITH NO COMMIT LINE (kickoffs/s96 row 2): said, never guessed at.
    const unconfirmed = Number(row['unconfirmed_attempts'] ?? 0);
    if (unconfirmed > 0) parts.push(`${unconfirmed} attempt${unconfirmed === 1 ? '' : 's'} unconfirmed`);
    if (row['claim'] === 'held') {
      if (row['messaging'] !== undefined) parts.push(`${row['assistant'] === 'codex' ? 'Codex, ' : ''}messaging ${String(row['messaging'])}`);
      else if (typeof row['message_name'] === 'string') parts.push(`answers to ${row['message_name']}`);
      else if ('message_name' in row) parts.push('not yet named (it names itself on its second prompt)');
      if (row['inbound_policy'] !== undefined) parts.push(`inbound ${String(row['inbound_policy'])}`);
    }
    lines.push(`  ${String(row['seat'] ?? '').padEnd(width)}  ${String(row['claim'] ?? '').padEnd(8)}  ${parts.join(', ')}${row['this_seat'] === true ? '  (this seat)' : ''}`);
    // ITS CARD ON A LINE OF ITS OWN: text the seat wrote about itself, validated as one line with no control character.
    if (typeof row['card'] === 'string') lines.push(`  ${''.padEnd(width)}  ${''.padEnd(8)}  card: ${row['card']}`);
  }
  lines.push('');
  lines.push(String(report['advisory'] ?? ''));
  return lines.join('\n');
}
