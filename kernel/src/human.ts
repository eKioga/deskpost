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
  return lines.join('\n');
}

/** init's result as lines, ending with one `Next:` line (step 9). */
export function initText(result: Record<string, unknown>, glyphs: Marks = marks()): string {
  const files = ((result['files'] as { file: string; action: string }[] | undefined) ?? []);
  const changed = files.filter((file) => !['unchanged', 'skipped-program-file'].includes(file.action));
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
