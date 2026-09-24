/**
 * ON macOS AND LINUX A REMEDY NAMES A COMMAND THE MACHINE CAN RUN (S42).
 *
 * The kernel's refusals, guard denials and `next` lines are the PowerShell oracle's sentences, and they name
 * the oracle's helpers -- `tools/Set-VirtualDesk.ps1 -Action Open ...`, `tools/Start-LibrarySeat.ps1 -Seat`.
 * Measured in a clean Linux distro: `library desk` with no seat told a reader with no PowerShell to use a
 * `.ps1`. So where a sentence LEAVES the kernel on POSIX -- a refusal, a denial, the Desk hook's text, a
 * result's remedy fields -- each helper invocation with a ported verb is rewritten to that verb, and one with
 * no port is named as PowerShell-only rather than offered as a thing to do. On Windows nothing changes: the
 * sentences are the oracle's, and the acceptance matrix compares them there. Kernel self-test section 23.
 *
 * NEVER APPLIED TO CONTENT: a page read through the reader is the reader's to return byte for byte, and a
 * note that quotes a helper is a note.
 */

import type { PathFlavor } from './workspace.ts';

const HOST: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';

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
];

const POWERSHELL_ONLY = ' (a PowerShell helper; this machine has no PowerShell to run it)';

/** One sentence as this host should say it. Pure, and the identity on Windows. */
export function hostRemedies(text: string, flavor: PathFlavor = HOST): string {
  if (flavor === 'win32') return text;
  let out = text;
  if (out.includes('.ps1')) {
    out = out.replace(new RegExp(String.raw`tools/([A-Za-z-]+)\.ps1(${PARAMETERS})`, 'g'), (whole: string, helper: string, rest: string) => {
      const rewrite = REWRITES.find((entry) => entry.helper === helper);
      const replaced = rewrite ? rewrite.to(rest) : null;
      return replaced ?? whole + POWERSHELL_ONLY;
    });
  }
  // The resolvers' own refusals name the PowerShell parameters; the kernel's are `--workspace` and `--seat`.
  return out.replace(/\bpass -WorkspacePath\b/g, 'pass --workspace').replace(/\bpass -Seat\b/g, 'pass --seat');
}

/** The fields of a result that carry a remedy, and only those: a result's content is never rewritten. */
const REMEDY_KEYS = new Set(['next', 'remedy', 'detail', 'message', 'reason', 'refusal', 'hint', 'repair', 'guidance', 'permissionDecisionReason', 'additionalContext']);

/** A result with its remedy fields said as this host should say them. Identity on Windows. */
export function hostRemedyFields<T>(value: T, flavor: PathFlavor = HOST): T {
  if (flavor === 'win32') return value;
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') return key !== null && REMEDY_KEYS.has(key) ? hostRemedies(node, flavor) : node;
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
