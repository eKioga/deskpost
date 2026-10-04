/**
 * ON macOS AND LINUX A REMEDY NAMES A COMMAND THE MACHINE CAN RUN (S42).
 *
 * The kernel's refusals, guard denials and `next` lines are the PowerShell oracle's sentences, and they name
 * the oracle's helpers -- `tools/Set-VirtualDesk.ps1 -Action Open ...`, `tools/Start-LibrarySeat.ps1 -Seat`.
 * Measured in a clean Linux distro: `library desk` with no seat told a reader with no PowerShell to use a
 * `.ps1`. So where a sentence LEAVES the kernel on POSIX -- a refusal, a denial, the Desk hook's text, a
 * result's remedy fields -- each helper invocation with a ported verb is rewritten to that verb, and one with
 * no port is named as PowerShell-only rather than offered as a thing to do. Kernel self-test section 23.
 *
 * A COMPILED KERNEL ON WINDOWS REWRITES TOO (S47, the reader's ruling). Measured in S7's Windows Sandbox: the
 * plugin's Read guard told a reader who installed the kernel to run `tools/Set-VirtualDesk.ps1`, a path relative
 * to a workspace that has no `tools/`. So a compiled kernel says the ported verb there as well. A helper with no
 * port was named by its full path in the installed program until 1.3.2; a release ships no `tools/*.ps1` since
 * (D9), so it is now named as a source-checkout helper the install does not ship, with no PowerShell (D4). A
 * kernel run from source on Windows keeps the oracle's sentences; the acceptance matrix, judging a compiled
 * kernel, passes the oracle's sentence through this same rewrite before it compares (ADR-0045).
 *
 * NEVER APPLIED TO CONTENT: a page read through the reader is the reader's to return byte for byte, and a
 * note that quotes a helper is a note.
 */

import { isCompiled } from './programroot.ts';
import { COMMAND_NAME } from './machine.ts';
import { VERBS } from './verbs.ts';

/** How remedies are said: `win32` is the oracle's own words; `win32-compiled` is an installed kernel on Windows. */
export type RemedyHost = 'posix' | 'win32' | 'win32-compiled';

export const REMEDY_HOST: RemedyHost = process.platform !== 'win32' ? 'posix' : isCompiled() ? 'win32-compiled' : 'win32';
const HOST = REMEDY_HOST;

/** A parameter value as the sentences spell one: a slug, a name, or a `<placeholder>`; never trailing punctuation. */
const VALUE = String.raw`(?:<[^>\s]+>|[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_]|[A-Za-z0-9_]|\.(?=[\s)]|$))`;
const PARAMETERS = String.raw`(?:\s+-[A-Za-z]+(?:\s+${VALUE})?)*`;

function parameters(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of text.matchAll(new RegExp(String.raw`-([A-Za-z]+)(?:\s+(${VALUE}))?`, 'g'))) found.set(match[1]!.toLowerCase(), match[2] ?? '');
  return found;
}

function deskCommand(text: string): string | null {
  const given = parameters(text);
  const action = (given.get('action') ?? 'open').toLowerCase();
  if (!['open', 'close', 'clear'].includes(action)) return null;
  if (action === 'clear') return 'library desk clear';
  const kind = (given.get('kind') ?? 'book').toLowerCase();
  const slug = given.get('slug') ?? '<slug>';
  const parts = ['library desk', action, kind === 'project' ? 'project' : 'book', slug];
  if ((given.get('location') ?? '').toLowerCase() === 'shelf') parts.push('--location shelf');
  if ((given.get('shelf') ?? '').toLowerCase() === 'archive') parts.push('--shelf archive');
  return parts.join(' ');
}

const REWRITES: { helper: string; to: (parameterText: string) => string | null }[] = [
  { helper: 'Set-VirtualDesk', to: deskCommand },
  {
    helper: 'Enter-LibrarySeat',
    to: (text) => {
      const given = parameters(text);
      const project = given.get('project');
      return `library seat enter ${given.get('seat') ?? '<name>'}` + (project ? ` --create --project ${project}` : '');
    },
  },
  {
    helper: 'Start-LibrarySeat',
    to: (text) => {
      const given = parameters(text);
      const project = given.get('project');
      return `library seat start ${given.get('seat') ?? '<name>'}` + (project ? ` --project ${project}` : '');
    },
  },
  { helper: 'Retire-Seat', to: (text) => `library seat retire ${parameters(text).get('seat') ?? '<name>'}` },
  { helper: 'Get-DeskOverview', to: () => 'library desk' },
  { helper: 'ShelfCatalog', to: (text) => (parameters(text).has('render') ? 'library shelf render' : null) },
  { helper: 'NotebookIndex', to: (text) => (parameters(text).has('render') ? 'library notebook render' : null) },
  { helper: 'Add-ShelfNote', to: (text) => `library capture ${parameters(text).get('bookslug') ?? '<book>'} --title <title> --body <text>` },
  // THE WRITERS A SEAT IS SENT TO (S67): `shelf new`'s next line and the Shelf refusals named these helpers, so an
  // installed kernel told a reader to run a PowerShell script for a verb it already has.
  {
    helper: 'Add-ShelfBookPage',
    to: (text) => {
      const given = parameters(text);
      return `library book add-page ${given.get('bookslug') ?? '<slug>'} ${given.get('pagepath') ?? '<page>'} --content-path <file>`;
    },
  },
  { helper: 'Edit-ProjectHub', to: (text) => `library hub edit ${parameters(text).get('projectslug') ?? '<slug>'} --mode ${parameters(text).get('mode') ?? '<mode>'}` },
  { helper: 'New-ProjectHub', to: (text) => `library hub new ${parameters(text).get('projectslug') ?? '<slug>'} --title <title>` },
  // EVERY OTHER HELPER A SENTENCE NAMES THAT HAS A VERB (S83, PLAN-no-powershell-runtime.md D4): a release ships no
  // tools/*.ps1 but the reader adapter's closure (D9), so on an installed kernel these would otherwise be dead ends.
  {
    helper: 'Set-CollectionOwner',
    to: (text) => {
      const given = parameters(text);
      const command = given.has('acquire')
        ? `library collection owner --acquire${given.has('force') ? ' --force' : ''}`
        : `library collection owner ${given.has('release') ? '--release' : '--status'}`;
      // ITS PARAMETERS ARE ALL SWITCHES, so a word the pattern took as the last one's value is the sentence's own
      // (`-Acquire -Force if that workspace is gone`, `-Status to confirm it`), and it is put back.
      const last = [...text.matchAll(new RegExp(String.raw`-([A-Za-z]+)(?:\s+(${VALUE}))?`, 'g'))].pop();
      return last?.[2] ? `${command} ${last[2]}` : command;
    },
  },
  {
    helper: 'Archive-ShelfBook',
    to: (text) => {
      const given = parameters(text);
      const action = (given.get('action') ?? '').toLowerCase();
      return action === 'restore' || action === 'archive' ? `library shelf ${action} ${given.get('bookslug') ?? '<slug>'}` : null;
    },
  },
  { helper: 'Copy-LocalPagesToProject', to: (text) => `library hub copy-pages ${parameters(text).get('projectslug') ?? '<slug>'}` },
  { helper: 'Initialize-LibraryWorkspace', to: () => 'library init' },
  // Only bare: `-PlanPath` names a route the kernel's `triage batch` refuses by name.
  { helper: 'Invoke-LibraryTriage', to: (text) => (text.trim() ? null : 'library triage') },
  {
    helper: 'Restore-NotebookQuarantine',
    to: (text) => {
      const given = parameters(text);
      if (given.has('list')) return 'library reset restore --list';
      if (!given.has('quarantine')) return 'library reset restore';
      const parts = ['library reset restore --quarantine', given.get('quarantine')!];
      if (given.has('show')) parts.push('--show');
      if (given.get('topic')) parts.push(`--topic ${given.get('topic')}`);
      if (given.has('adopt')) parts.push('--adopt');
      if (given.has('preflight')) parts.push('--preflight');
      if (given.get('planid')) parts.push(`--plan-id ${given.get('planid')}`);
      return parts.join(' ');
    },
  },
];

const POWERSHELL_ONLY = ' (a PowerShell helper; this machine has no PowerShell to run it)';

/**
 * AN UNPORTED HELPER ON AN INSTALLED WINDOWS KERNEL (S83, D4): named, with no PowerShell and no path. Until 1.3.2 this
 * was the helper's full path under the program, runnable with `powershell -File`; a release no longer ships
 * `tools/*.ps1` (D9), so that path would be a dead end.
 */
export const NOT_SHIPPED = ' (a helper in the Deskpost source checkout; this installed program does not ship it)';

function installedHelper(helper: string, rest: string): string {
  return `${helper}${rest}${NOT_SHIPPED}`;
}

/**
 * One sentence as this host should say it. Pure, and the identity for the oracle's own host. `_root` is kept for the
 * callers that pass the program root: since S83 an unported helper is named without a path, so it is not read.
 */
export function hostRemedies(text: string, flavor: RemedyHost = HOST, _root: string | null = null): string {
  if (flavor === 'win32') return text;
  let out = text;
  if (out.includes('.ps1')) {
    out = out.replace(new RegExp(String.raw`tools/([A-Za-z-]+)\.ps1(${PARAMETERS})`, 'g'), (whole: string, helper: string, rest: string) => {
      const rewrite = REWRITES.find((entry) => entry.helper === helper);
      const replaced = rewrite ? rewrite.to(rest) : null;
      if (replaced !== null) return replaced;
      return flavor === 'win32-compiled' ? installedHelper(helper, rest) : whole + POWERSHELL_ONLY;
    });
  }
  // The resolvers' own refusals name the PowerShell parameters; the kernel's are `--workspace` and `--seat`.
  out = out.replace(/\bpass -WorkspacePath\b/g, 'pass --workspace').replace(/\bpass -Seat\b/g, 'pass --seat');
  // THE COMMAND A READER TYPES IS `deskpost` (ADR-0055). The sentences, and the rewrites above, say `library <verb>`,
  // the oracle's word and a quiet alias through 1.x; where a remedy leaves an installed kernel it says the product's
  // name. Only a verb this kernel has is renamed, so a path (`bin/library`) or prose is never touched.
  return out.replace(LIBRARY_COMMAND, `$1${COMMAND_NAME}`);
}

/** `library` as a command: not inside a path or a word, and followed by one of the kernel's verbs. */
const LIBRARY_COMMAND = new RegExp(String.raw`(^|[^\w./\\-])library(?= (?:${[...Object.keys(VERBS), 'help'].map((verb) => verb.replace(/-/g, '\\-')).join('|')})\b)`, 'g');

/** The fields of a result that carry a remedy, and only those: a result's content is never rewritten. */
const REMEDY_KEYS = new Set(['next', 'remedy', 'detail', 'message', 'reason', 'refusal', 'hint', 'repair', 'guidance', 'permissionDecisionReason', 'additionalContext']);

/**
 * A FIELD NAMED `*_route` IS A COMMAND TO RUN, SO IT IS A REMEDY (S49, the reader's ruling). `library desk`'s
 * `quarantine.list_route` and the restore's `show_route` and `restore_route` named a PowerShell helper on POSIX and
 * from a compiled Windows kernel. Every such key rather than a list, so a route added later is covered.
 */
function isRemedyKey(key: string): boolean {
  return REMEDY_KEYS.has(key) || key.endsWith('_route');
}

/** A result with its remedy fields said as this host should say them. Identity for the oracle's own host. */
export function hostRemedyFields<T>(value: T, flavor: RemedyHost = HOST): T {
  if (flavor === 'win32') return value;
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') return key !== null && isRemedyKey(key) ? hostRemedies(node, flavor) : node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(node as Record<string, unknown>)) copy[name] = walk(item, name);
      return copy;
    }
    return node;
  };
  return walk(value, null) as T;
}
