/**
 * What `library` answers to, as data: the WHOLE surface the supported-operation matrix names, not
 * only the part that is ported.
 *
 * THE TABLE IS THE DISPATCH AND THE DISPATCH IS THE TABLE. A second list of verbs -- in a usage
 * string, in a check, or in the matrix -- is a second chance to be wrong, and this program has paid
 * for that shape more than once. `cli.ts` dispatches from here, `library verbs` prints it, and
 * `acceptance.kernel-verbs-exist` reads that output.
 *
 * WHY THAT CHECK NEEDED THIS FILE. `docs/supported-operation-matrix.md` says a row's kernel command
 * is a SPECIFICATION, and `acceptance.matrix-shape` deliberately resolved nothing on the kernel side
 * because there was nothing there to resolve. S12's kickoff named the asymmetry and its cost: "a row
 * naming `library shelf render` when the verb is `library shelf rerender` would sit green-adjacent
 * and pending forever, and no check would say so." A kernel exists now, so the asymmetry closes --
 * by ASKING THE CLI what it answers to, which is the rule `docs/mcp-tool-allowlist-check.md` already
 * settled for the reader's tool list.
 *
 * SO EVERY VERB THE MATRIX NAMES IS DECLARED HERE, PORTED OR NOT, and `ported: false` is the honest
 * state for most of them today. This is what makes the check a check rather than a countdown: it
 * asks whether a row names something the dispatcher will ever see, not whether S13 got round to it.
 * An unported verb REFUSES BY NAME and its row mismatches honestly; a misspelled one fails the gate.
 *
 * `positional` MARKS THE VERBS WHOSE SECOND WORD IS DATA RATHER THAN A NAME -- `capture <book>`,
 * `compile <batch>`, `init <folder>`, `publish <slug>`. The check cannot resolve a value, and
 * pretending to would be the same mistake the kernel side was avoiding in the first place.
 */

import type { ArgumentTable } from './argv.ts';
import { CONTENT_PATH_RULE } from './contentpath.ts';

export interface VerbDeclaration {
  summary: string;
  usage: string;
  /** The closed set of sub-actions this verb dispatches on, or empty when it takes none. */
  actions: string[];
  /** True when the slot after the verb may instead carry a positional argument. */
  positional: boolean;
  /** True when this verb answers today. False means it refuses by name, and its rows mismatch. */
  ported: boolean;
  /** The ledger row of PLAN-public-release.md that carries it. */
  row: string;
  /** Lines `<verb> <action> --help` adds under the action's usage, one per mode or rule (S85 row 1). */
  details?: Record<string, string[]>;
  /**
   * WHAT EACH ACTION TAKES, keyed by action, with `''` for the verb without one (PLAN-correct-and-find.md D7,
   * kickoffs/s106). The parser reads its value names from here, the front door refuses whatever is not here, and the
   * self-test checks every usage line the documents teach against it. The global flags (`GLOBAL_ARGUMENTS`) are added
   * by `argumentTable`, never written here.
   */
  arguments: Record<string, ArgumentTable>;
  /** False for a verb that runs against no workspace, so `--workspace` is not one of its global flags. */
  workspace?: false;
}

/**
 * THE GLOBAL FLAGS, DECLARED ONCE: every verb takes `--json` (a no-op where the verb always prints JSON) and `--help`,
 * and every verb that runs against a workspace takes `--workspace <path>`. `--seat` is a verb's own, where it reads one.
 */
export const GLOBAL_ARGUMENTS = { valued: ['workspace'], boolean: ['json', 'help'] };

/** One action's table with the global flags added: what the parser, the front door and the docs check all read. */
export function argumentTable(verb: string, action = ''): ArgumentTable {
  const declaration = VERBS[verb];
  const own = declaration?.arguments[action];
  if (!declaration || !own) throw new Error(`verbs.ts declares no argument table for '${verb}${action ? ` ${action}` : ''}'; that is a defect in verbs.ts.`);
  const valued = [...(own.valued ?? [])];
  if (declaration.workspace !== false && !valued.includes('workspace')) valued.push(GLOBAL_ARGUMENTS.valued[0]!);
  const boolean = [...(own.boolean ?? [])];
  for (const name of GLOBAL_ARGUMENTS.boolean) if (!boolean.includes(name)) boolean.push(name);
  return { ...own, valued, boolean };
}

/**
 * THE GLOBAL FLAGS ALONE, for a command line whose action the verb does not have: the front door still finds
 * `--workspace`, and the verb refuses the action in its own words.
 */
export function globalTable(verb: string): ArgumentTable {
  return { valued: VERBS[verb]?.workspace === false ? [] : [...GLOBAL_ARGUMENTS.valued], boolean: [...GLOBAL_ARGUMENTS.boolean], positionals: 0 };
}

/** The action's table when the verb declares that action, else the global flags alone (the verb refuses the action). */
export function tableFor(verb: string, action: string): ArgumentTable {
  return VERBS[verb]?.arguments[action] ? argumentTable(verb, action) : globalTable(verb);
}

/**
 * EVERY ACTION'S VALUE NAMES TOGETHER, for a parser whose job is to find the action itself (`process`, `collection
 * owner|rebuild`): a value is never read as the action word. The front door has already checked the line against the
 * action's own table.
 */
export function verbTable(verb: string): ArgumentTable {
  const tables = Object.keys(VERBS[verb]?.arguments ?? {}).map((action) => argumentTable(verb, action));
  const union = (pick: (table: ArgumentTable) => string[] | undefined): string[] => [...new Set(tables.flatMap((table) => pick(table) ?? []))];
  return { valued: union((table) => table.valued), repeatable: union((table) => table.repeatable), boolean: union((table) => table.boolean), positionals: Math.max(0, ...tables.map((table) => table.positionals)) };
}

/** The action a command line names, and the words after it: the first word, or the first action word after flags. */
export function commandAction(verb: string, rest: string[]): { action: string; argv: string[] } {
  const declaration = VERBS[verb];
  if (!declaration || !declaration.actions.length) return { action: '', argv: rest };
  if (declaration.actions.includes(rest[0] ?? '')) return { action: rest[0]!, argv: rest.slice(1) };
  // A FLAG MAY COME BEFORE THE ACTION (`raw --workspace w search ...`): skip each option and its value.
  const valued = new Set([...GLOBAL_ARGUMENTS.valued, ...Object.values(declaration.arguments).flatMap((table) => [...(table.valued ?? []), ...(table.repeatable ?? [])])]);
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item.startsWith('--')) {
      if (valued.has(item.substring(2))) index += 1;
      continue;
    }
    if (declaration.actions.includes(item)) return { action: item, argv: [...rest.slice(0, index), ...rest.slice(index + 1)] };
    break;
  }
  return { action: '', argv: rest };
}

export const VERBS: Record<string, VerbDeclaration> = {
  'basic-memory': {
    summary: "A local Library's connection to a Basic Memory server: set it up, see how the two differ, import from it, open a shared Book.",
    usage:
      'library basic-memory setup --url <mcp-url> --collection <name> [--storage <folder>] [--preflight]; library basic-memory disconnect; ' +
      'library basic-memory status; library basic-memory import (--preflight | --dry-run | --user-confirmed --plan-id <id> [--lock-timeout <s>]); ' +
      'library basic-memory open [<slug> [--shelf archive] [--seat <s>]]; library basic-memory rollback-check [--registry-root <d>]',
    actions: ['disconnect', 'import', 'open', 'rollback-check', 'setup', 'status'],
    positional: false,
    arguments: {
      setup: { valued: ['url', 'collection', 'storage'], boolean: ['preflight'], positionals: 0 },
      disconnect: { positionals: 0 },
      status: { positionals: 0 },
      import: { valued: ['plan-id', 'lock-timeout'], boolean: ['preflight', 'dry-run', 'user-confirmed'], positionals: 0 },
      open: { valued: ['shelf', 'seat', 'claim-token'], internal: ['claim-token'], positionals: 1 },
      'rollback-check': { valued: ['registry-root'], positionals: 0 },
    },
    // PLAN-basic-memory.md (S52): a connection, never a backend, and nothing written to Basic Memory in 1.1.
    ported: true,
    row: 'S52',
  },
  book: {
    summary: 'Add a page to an open curated Book (or a raw/ batch as its sources/ pages), correct one of its pages in place, keep its source list, rebuild its reader map, or graduate a Notebook topic into one.',
    // ONE CLAUSE PER ACTION (S71 row 10), each listing its own parser's flags, so `book <action> --help` shows it.
    usage:
      'library book add-page <slug> <page> (--content-path <f> | --body <text>) [--title <t>] [--seat <s>] [--preflight]; ' +
      'library book add-page <slug> --from-folder raw/<batch> [--seat <s>] [--preflight]; ' +
      'library book graduate <slug> [--topic <t> | --source-path <p>] [--page-prefix <p>] [--recurse] [--seat <s>] [--preflight]; ' +
      'library book replace-page <slug> <page> --content-path <f> [--sources-compiled <f>] (--preflight | --base-sha256 <h>) [--seat <s>]; ' +
      'library book reader-map <slug> [--seat <s>]; ' +
      'library book sources <slug> [(--set | --mark-compiled) --content-path <f> (--preflight | --base-sha256 <h>)] [--seat <s>]',
    actions: ['add-page', 'graduate', 'reader-map', 'replace-page', 'sources'],
    positional: false,
    details: {
      '*': [CONTENT_PATH_RULE],
      'add-page': [CONTENT_PATH_RULE],
      'replace-page': [CONTENT_PATH_RULE],
      sources: [CONTENT_PATH_RULE],
    },
    // `--seat` IS ACCEPTED WHERE THE USAGE NAMES IT, and changes nothing there: the seat comes from the session.
    arguments: {
      // Two forms: `<slug> <page>`, or `<slug> --from-folder raw/<batch>`, which refuses a second word itself.
      'add-page': { valued: ['title', 'body', 'content-path', 'from-folder', 'seat'], boolean: ['preflight'], positionals: 2 },
      graduate: { valued: ['topic', 'source-path', 'page-prefix', 'seat'], boolean: ['recurse', 'preflight'], positionals: 1 },
      // `--body` and `--title` are read only to be refused by name: a correction takes a file and keeps its own H1.
      'replace-page': { valued: ['content-path', 'base-sha256', 'sources-compiled', 'body', 'title', 'seat'], internal: ['body', 'title'], boolean: ['preflight'], positionals: 2 },
      // These two refuse a second word in their own sentences.
      'reader-map': { valued: ['seat'], positionals: 1, ownWords: true },
      sources: { valued: ['content-path', 'base-sha256', 'seat'], boolean: ['set', 'mark-compiled', 'preflight'], positionals: 1, ownWords: true },
    },
    // `add-page` is ported whole; `graduate` answers --preflight and refuses the apply half by
    // name, because its per-page progress journal is what makes an interrupted run resumable.
    ported: true,
    row: 'S15',
  },
  capture: {
    summary: 'Capture a note into a capture-enabled Book. Saving is ungated and needs no open Book; reading the note back needs its Book open.',
    // --content-path beside --body (S66): on Windows the shim keeps only an inline body's first line.
    // --why (S73 row 3): one closed category, recorded and never required.
    // --supersedes (S73 row 4): closes the named older note in the same Book, and needs the Book open and a seat.
    // --answers, --routes and --for-department (S98) were accepted and named in no usage (kickoffs/s106 row 6a).
    usage:
      'library capture <book> --title <t> (--body <b> | --content-path <file>) [--why no-seat|no-home|needs-yes|reset-imminent|for-seat] ' +
      '[--supersedes notes/<page>] [--for <seat> | --for-department <department>] [--answers notes/<page>] [--routes notes/<page>]',
    details: {
      '*': [
        '--for names one seat a letter is for; --for-department names a department, and any seat in it may answer.',
        '--answers notes/<page> answers that letter and closes it; --routes notes/<page> hands it on to the seat --for names and closes it.',
        CONTENT_PATH_RULE,
      ],
    },
    actions: [],
    positional: true,
    arguments: {
      '': {
        valued: [
          'title', 'body', 'content-path', 'why', 'supersedes', 'for', 'for-department', 'answers', 'routes',
          'tags', 'source-paths', 'source-project', 'capture-date', 'require-note-file', 'seat',
        ],
        // `--seat` is read only to be refused: a capture's seat is the session's. The other two are triage batch's plumbing.
        internal: ['capture-date', 'require-note-file', 'seat'],
        boolean: ['preflight'],
        positionals: 1,
      },
    },
    ported: true,
    row: 'S15',
  },
  collection: {
    summary: "The shared collection's ownership claim, the Local collection's Discovery manifests, and a page added to or corrected in one of its Books.",
    usage:
      'library collection owner [--status | --acquire [--force [--user-confirmed]] | --release] [--json]; library collection rebuild [--json]; ' +
      'library collection add-page <slug> <page> (--content-path <f> | --body <b>) [--title <t>] (--preflight | --user-confirmed --plan-id <id>) [--lock-timeout <s>]; ' +
      'library collection replace-page <slug> <page> --content-path <f> (--preflight | --user-confirmed --plan-id <id>) [--lock-timeout <s>]',
    actions: ['add-page', 'owner', 'rebuild', 'replace-page'],
    positional: false,
    details: {
      '*': [CONTENT_PATH_RULE],
      'add-page': [CONTENT_PATH_RULE],
      'replace-page': [CONTENT_PATH_RULE],
      owner: ['--status is the default: with neither --acquire nor --release, owner reports the claim, and --status changes nothing.'],
    },
    arguments: {
      // `--status` IS ACCEPTED AND CHANGES NOTHING (kickoffs/s106 ruling 3): it is the default, and the kernel's own
      // remedy sentences and a matrix row name it.
      owner: { boolean: ['status', 'acquire', 'release', 'force', 'user-confirmed'], positionals: 0 },
      rebuild: { positionals: 0 },
      'add-page': { valued: ['title', 'body', 'content-path', 'plan-id', 'lock-timeout', 'seat'], boolean: ['preflight', 'user-confirmed'], positionals: 2 },
      // `--body` and `--title` are read only to be refused by name.
      'replace-page': { valued: ['content-path', 'plan-id', 'lock-timeout', 'seat', 'body', 'title'], internal: ['body', 'title'], boolean: ['preflight', 'user-confirmed'], positionals: 2 },
    },
    // Set-CollectionOwner.ps1 whole (S43), judged by kernel self-test section 28.
    ported: true,
    row: 'S16',
  },
  compile: {
    summary: 'Compile one source batch into Notebook articles. Never the whole raw tree.',
    usage:
      'library compile <batch> --topic <t> --topic-title <title> --topic-overview <line> --article-slug <s> ' +
      '--content-path <file> --source-file <a[,b]> [--replace-existing] [--require-pin] [--preflight | --plan-id <id>] [--json]',
    details: { '*': [CONTENT_PATH_RULE] },
    actions: [],
    positional: true,
    arguments: {
      '': {
        valued: ['topic', 'topic-title', 'topic-overview', 'article-slug', 'content-path', 'source-file', 'allow-host', 'plan-id', 'seat'],
        boolean: ['replace-existing', 'require-pin', 'preflight'],
        positionals: 1,
      },
    },
    // A batch with no git repository compiles whole. A source file INSIDE one refuses by name: the
    // upstream pin -- HEAD, the tracked remote ref and a bounded fetch proving the commit is on the
    // remote -- is not ported, and withholding a pin the oracle would capture is a thinner answer.
    ported: true,
    row: 'S17',
  },
  desk: {
    summary: "What is on this seat's Desk, and one line per other seat.",
    usage: 'library desk [open|close|clear] [book|project <slug>] [--location collection|shelf|shared] [--shelf archive] [--seat <name>] [--json]',
    actions: ['clear', 'close', 'open'],
    positional: false,
    arguments: {
      // THE OVERVIEW: any word is read as an action, and the verb refuses one it does not have.
      '': { valued: ['seat'], positionals: 1 },
      open: { valued: ['location', 'shelf', 'seat', 'claim-token'], internal: ['claim-token'], positionals: 2 },
      close: { valued: ['location', 'shelf', 'seat', 'claim-token'], internal: ['claim-token'], positionals: 2 },
      clear: { valued: ['location', 'shelf', 'seat', 'claim-token'], internal: ['claim-token'], positionals: 2 },
    },
    ported: true,
    row: 'S14',
  },
  doctor: {
    summary: 'Every registered check, with one result each. A check that did not run reports skipped. --report files each FAIL (and each WARN with --warnings) once into the Report Inbox.',
    usage: 'library doctor [--workspace <path>] [--report [--warnings]] [--json]',
    actions: [],
    positional: false,
    arguments: {
      // `--served-by`, `--kept` and `--registry-root` are the installer's: `install` runs them in its child doctor.
      '': { valued: ['served-by', 'registry-root'], repeatable: ['kept'], internal: ['served-by', 'registry-root', 'kept'], boolean: ['report', 'warnings'], positionals: 0 },
    },
    // The nine checks that read the reader's material -- what `Invoke-LibraryChecks.ps1 -WorkspaceOnly`
    // runs. The program's own development gate is not a doctor's, and is not ported.
    ported: true,
    row: 'S17',
  },
  'finish-uninstall': {
    summary: "Finish an uninstall: the copy of this program `uninstall` starts in %TEMP%. Internal, never run by hand.",
    usage: 'library finish-uninstall --parent-pid <n> --root <dir> --handshake <file> --transaction <id> --result <file>',
    actions: [],
    positional: false,
    arguments: { '': { valued: ['parent-pid', 'root', 'handshake', 'transaction', 'result'], positionals: 0 } },
    workspace: false,
    // PLAN-no-powershell-runtime.md D8 (S83): the port of tools/Finish-Uninstall.ps1, started outside the uninstall's
    // job by CreateProcessW. Not in the menu; self-test section 116 judges it through a fixture install.
    ported: true,
    row: 'S83',
  },
  install: {
    summary: 'Install, upgrade or repair Deskpost from a release, or finish or undo an interrupted install, with no PowerShell: what install.ps1 did.',
    usage:
      'library install [--release <folder|url>] [--install-root <dir>] [--library <dir|none>] [--platform win-x64|win-arm64] [--yes] [--dry-run] [--json] [--plan-id <id>] ' +
      '[--allow-overlap] [--repair] [--keep-libraries] [--path-change|--no-path-change] [--wait <seconds>] [--plugin|--skip-plugin] [--resume finish|undo] [--librarian claude|codex]',
    actions: [],
    positional: false,
    // INSTALL REFUSES AN UNKNOWN FLAG AND A WORD ITSELF, in its own sentences (S89), from this table.
    arguments: {
      '': {
        valued: [
          'release', 'install-root', 'library', 'platform', 'plan-id', 'resume', 'librarian', 'wait',
          'script-sha', 'script-path', 'refusal-file', 'extracted', 'archive-sha256', 'bootstrap-folder',
        ],
        boolean: [
          'yes', 'dry-run', 'allow-overlap', 'repair', 'keep-libraries', 'no-path-change', 'path-change', 'plugin', 'skip-plugin',
          'run-as-file', 'forwarded',
        ],
        internal: ['script-sha', 'script-path', 'refusal-file', 'extracted', 'archive-sha256', 'bootstrap-folder', 'run-as-file', 'forwarded'],
        positionals: 0,
        ownRefusals: true,
      },
    },
    workspace: false,
    // PLAN-install-without-powershell.md D1-D8 (S89, ADR-0066). Run by a reader it is the bootstrap: it reads and checks
    // the release, then runs that release's own binary with --extracted <folder> --archive-sha256 <hex>, which installs.
    // install.ps1 is a forwarder onto the same, passing --forwarded, --refusal-file, --script-sha, --script-path and
    // --run-as-file. Windows only; install.sh installs on macOS and Linux.
    ported: true,
    row: 'S89',
  },
  upgrade: {
    summary: 'Upgrade the install this program runs from to the latest release, or say whether one is ready (--check).',
    usage:
      'library upgrade [--check] [--dry-run] [--json] [--plan-id <id>] [--yes] [--wait <seconds>] [--path-change|--no-path-change] [--release <url|folder>]',
    details: {
      '*': [
        'It upgrades the install it runs from; it takes no --install-root. --check reads the release\'s SHA256SUMS only.',
        'It waits for open sessions to close; --wait <seconds> waits that long when nobody is there to ask. The install.ps1',
        'line cannot wait: run `deskpost upgrade` from a terminal or the main menu instead.',
      ],
    },
    actions: [],
    positional: false,
    // UPGRADE REFUSES AN UNKNOWN FLAG AND A WORD ITSELF, in its own sentences (S92), from this table.
    arguments: {
      '': { valued: ['release', 'plan-id', 'wait'], boolean: ['check', 'dry-run', 'yes', 'path-change', 'no-path-change'], positionals: 0, ownRefusals: true },
    },
    workspace: false,
    // PLAN-one-step-upgrade.md D1 (S92, ADR-0068): the check reads SHA256SUMS; an upgrade runs `install` as the
    // bootstrap with --install-root <this install>, so the new release does its own install.
    ported: true,
    row: 'S92',
  },
  hook: {
    summary: "The Library's hooks: a harness payload on stdin, a decision or context on stdout.",
    usage: 'library hook <shelf-read|shell-shelf-read|basic-memory-read|settings-integrity|desk-context|compact-clear|search-hit|seat-start> [--workspace <path>] [--seat <s>] [--state-directory <d>] [--agent-pid <n>] [--reader-tool-prefix <p>]',
    actions: ['shelf-read', 'shell-shelf-read', 'basic-memory-read', 'settings-integrity', 'desk-context', 'compact-clear', 'search-hit', 'seat-start'],
    positional: false,
    // ONE TABLE FOR EVERY HOOK, as the usage is one clause: a refused hook would fail a harness event, and a
    // registration written by an older release passes the same few names to each.
    arguments: Object.fromEntries(
      ['shelf-read', 'shell-shelf-read', 'basic-memory-read', 'settings-integrity', 'desk-context', 'compact-clear', 'search-hit', 'seat-start'].map((action) => [
        action,
        {
          valued: ['seat', 'state-directory', 'agent-pid', 'deadline-seconds', 'reader-tool-prefix'],
          boolean: ['advisory'],
          internal: ['deadline-seconds', 'advisory'],
          positionals: 0,
        },
      ]),
    ),
    // The two Shelf guards (S31, the first half of S20's port), the Basic Memory guard (S32) and the
    // ConfigChange settings guard and the UserPromptSubmit Desk context hook (S36). The PostCompact and
    // SessionStart serve-ledger clear, the PostToolUse search reminder and the SessionStart seat roster
    // (S82, ADR-0064). A verb this binary lacks fails safe (S82, D3).
    ported: true,
    row: 'S20',
  },
  hub: {
    summary: 'Project Hubs, local and shared, and the bounded Hub edit.',
    usage:
      'library hub new <slug> --title <t> [--purpose <p>] [--next-action <a>] [--dev] [--preflight] [--json]; ' +
      'library hub edit <slug> --mode <add-section|append-section|remove-section|replace-section|replace-body|check-item|replace-item|new-page> [--title <t>] ' +
      '[--section <s>] [--match-text <t>] [--content <c> | --content-path <f>] [--page <p>] [--uncheck] [--preflight | --user-confirmed --plan-id <id>]; ' +
      'library hub archive <slug> --preflight; ' +
      'library hub copy-pages <slug> --source <path> --title <t> --purpose <p> [--next-action <a>]... [--include-page <p>]... ' +
      '[--at-project-root | --destination-directory <d>] --preflight; ' +
      'library hub rename <old-slug> <new-slug> --title <t> [--preflight | --user-confirmed --plan-id <id>] [--lock-timeout <s>]',
    actions: ['archive', 'copy-pages', 'edit', 'new', 'rename'],
    // ONE LINE PER MODE (S85 rows 1 and 3): the usage names eight modes and said nothing of what each takes, so a
    // seat put the section's own `## ` heading into its content and was told the page held the section twice.
    details: {
      edit: [
        'Modes:',
        "  add-section      --section <s> --content-path <f>: a new level-two section at the page's end.",
        '  append-section   --section <s> --content-path <f>: lines added at the end of an existing section.',
        '  remove-section   --section <s>: removes a section other than Purpose, Now or Next. Gated.',
        "  replace-section  --section <s> --content-path <f>: the section's body replaced. Gated.",
        '  replace-body     --content-path <f>: the whole page replaced. Gated.',
        '  check-item       --match-text <t> [--section <s>] [--uncheck]: ticks or unticks one checkbox item.',
        '  replace-item     --match-text <t> [--section <s>] --content-path <f>: one item replaced. Gated.',
        "  new-page         --page <p> --content-path <f>: a new page in a local Library's Hub; never overwrites.",
        '                   Its --preflight issues a plan_id: the apply takes it with --plan-id <id>, or runs without one.',
        '',
        "For the section modes, --content and --content-path are the section's body only: leave out the '## <section>' line.",
        'replace-item on a paragraph line replaces that line only; on a list item it replaces the item with its nested sub-items.',
        "Gated means --preflight first, then --user-confirmed --plan-id <id> with the reader's yes.",
        'add-section, append-section and check-item given a --plan-id apply only when it is the one their --preflight gives now.',
        CONTENT_PATH_RULE,
      ],
    },
    positional: false,
    arguments: {
      new: { valued: ['title', 'purpose', 'next-action'], boolean: ['dev', 'preflight'], positionals: 1 },
      // EVERY MODE'S NAMES IN ONE TABLE; `--title` given to a mode but new-page is refused in hubedit.ts, and
      // `--user-confirmed` is accepted on every mode.
      edit: {
        valued: ['mode', 'section', 'match-text', 'content', 'content-path', 'page', 'title', 'plan-id', 'seat', 'lock-timeout'],
        boolean: ['uncheck', 'preflight', 'user-confirmed'],
        positionals: 1,
        // S97's own sentence refuses a second word, naming it.
        ownWords: true,
      },
      archive: { boolean: ['preflight', 'user-confirmed'], positionals: 1 },
      'copy-pages': {
        valued: ['source', 'title', 'purpose', 'destination-directory', 'plan-id', 'journal-path'],
        repeatable: ['next-action', 'include-page'],
        boolean: ['at-project-root', 'preflight', 'user-confirmed', 'replace-existing'],
        internal: ['journal-path'],
        positionals: 1,
      },
      rename: { valued: ['title', 'plan-id', 'lock-timeout'], boolean: ['preflight', 'user-confirmed'], positionals: 2 },
    },
    // `new` against both backends (S30 local, S33 Basic Memory); `edit` against both (S34); `archive`
    // (S34) and `copy-pages` (S35) against Basic Memory, their preflights, with the confirmed halves
    // refusing by name.
    ported: true,
    row: 'S16',
  },
  init: {
    summary: 'Make a folder a Library workspace, and tell this machine about it.',
    usage: 'library init [<folder>] [--writable] [--json]',
    actions: [],
    positional: true,
    // INIT REFUSES AN UNKNOWN FLAG AND A SECOND FOLDER ITSELF, in its own sentences (S61), from this table; `--force`
    // is read only to be refused by name.
    arguments: {
      '': {
        valued: ['registry-root', 'collection-id', 'mcp-url'],
        boolean: ['writable', 'force'],
        internal: ['registry-root', 'collection-id', 'mcp-url', 'force'],
        positionals: 1,
        ownRefusals: true,
      },
    },
    ported: true,
    row: 'S13',
  },
  letters: {
    summary: 'Close a letter addressed to this seat, in one step and with no new note, once it has been dealt with.',
    // kickoffs/s108 ruling 2 (the messaging plan r4, D3; ADR-0071): `--seat` is read only to be refused by name.
    usage: 'library letters close notes/<page> [--note "<one line>"]',
    details: {
      close: [
        'Closes a letter for this seat in the letters Book (open on its Desk): review: done, the reviewed: stamp, and',
        '--note as closed_note, one line saying what became of it. It needs no reader\'s yes and writes no note.',
        'It refuses another seat\'s letter, a closed one, and one still carrying answered_by or routed_to.',
      ],
    },
    actions: ['close'],
    positional: false,
    arguments: {
      close: { valued: ['note', 'seat'], internal: ['seat'], positionals: 1 },
    },
    ported: true,
    row: 'S108',
  },
  library: {
    summary: 'The Libraries registered on this machine, and which one bare `deskpost` opens from anywhere.',
    usage: 'library library [list] [--json]; library library default <folder> [--json]',
    actions: ['default', 'list'],
    positional: false,
    arguments: {
      '': { valued: ['registry-root'], internal: ['registry-root'], positionals: 0 },
      list: { valued: ['registry-root'], internal: ['registry-root'], positionals: 0 },
      default: { valued: ['registry-root'], internal: ['registry-root'], positionals: 1 },
    },
    workspace: false,
    // PLAN-install-onboarding.md step 5a (S55, ADR-0059): the default Library is one registry entry's `default: true`.
    ported: true,
    row: 'S55',
  },
  browse: {
    summary: 'What the Library holds: Shelf Books, collection Books and Projects, by title, slug, summary and topics. Seatless, offline, metadata only; the menu shows it on l.',
    usage: 'library browse [--archived] [--json] [--workspace <path>]',
    actions: [],
    positional: false,
    arguments: { '': { boolean: ['archived'], positionals: 0, ownWords: true } },
    // PLAN-correct-and-find.md D5 (S102 row 4).
    ported: true,
    row: 'S102',
  },
  menu: {
    summary: 'The main menu, which bare `deskpost` opens: your seats, a number to resume one, n<number> for a new conversation, + for a new seat.',
    usage: 'library menu [--workspace <path>] [--width <n>] [--plain] [--assistant claude|codex] [--script <answers-file>]',
    actions: [],
    positional: false,
    arguments: {
      '': {
        valued: ['width', 'assistant', 'script', 'registry-root', 'transcript-root', 'cwd'],
        boolean: ['plain'],
        internal: ['registry-root', 'transcript-root', 'cwd'],
        positionals: 0,
      },
    },
    // PLAN-install-onboarding.md step 5a (S55, ADR-0059): tools/SeatPicker.ps1 ported, launching through `seat start`.
    ported: true,
    row: 'S55',
  },
  mcp: {
    summary: 'The validated reader: one tool call the way a harness makes it, or the stdio MCP server a harness launches.',
    usage:
      'library mcp call <tool> [--slug <s>] [--page <p>] [--place shelf|collection|shared] [--section <heading>] [--query <q>] [--location <l>]; ' +
      'library mcp serve [--workspace <path>] [--state-directory <d>] [--seat <s>]',
    actions: ['call', 'serve'],
    positional: false,
    arguments: {
      // One option per tool argument, `max_results` spelled `--max-results`; `--location` also answers for `--place`.
      call: {
        valued: ['slug', 'page', 'place', 'location', 'shelf', 'section', 'query', 'max-results', 'seat', 'id'],
        internal: ['id'],
        positionals: 1,
      },
      serve: { valued: ['state-directory', 'seat'], positionals: 0 },
    },
    ported: true,
    row: 'S13',
  },
  migrate: {
    summary: 'The data-model migration, which refuses activation until every legacy state is accounted for.',
    usage:
      'library migrate [--assign <item>=<seat>[,...]] [--set-aside <item>[,...]] (--preflight | --plan-id <id>) | --resume | --rollback [--seat <s>] [--json]',
    actions: [],
    positional: false,
    arguments: {
      '': { valued: ['assign', 'set-aside', 'plan-id', 'seat', 'fault-after'], internal: ['fault-after'], boolean: ['preflight', 'resume', 'rollback'], positionals: 0 },
    },
    // ADR-0029's migration (S18). It exists only here: the PowerShell implementation never carries the
    // seat-owned Notebook, so its row is independent and tools/Test-NotebookMigration.ps1 judges it.
    ported: true,
    row: 'S18',
  },
  notebook: {
    summary: "The Notebook: this seat's derived index. Topic ownership is retired by ADR-0029 and refuses by name.",
    usage: 'library notebook <render [--seat <s>] | own> [--workspace <path>] [--json]',
    actions: ['own', 'render'],
    positional: false,
    arguments: {
      render: { valued: ['seat'], positionals: 0 },
      // RETIRED: it refuses by name before any table is read (kickoffs/s106 ruling 3).
      own: { positionals: 0, retired: true },
    },
    ported: true,
    row: 'S17',
  },
  process: {
    summary: 'What the kernel reads about a process: its start time, its parents, its exit and the process list. Internal: the self-test drives these through it.',
    usage: 'library process <start|ancestry|wait> <pid> [--start-utc <s>] [--poll-ms <n>]; library process list [--name <image>]',
    actions: ['ancestry', 'list', 'start', 'wait'],
    positional: false,
    arguments: {
      start: { positionals: 1 },
      ancestry: { positionals: 1 },
      wait: { valued: ['start-utc', 'poll-ms'], positionals: 1 },
      list: { valued: ['name'], positionals: 0 },
    },
    workspace: false,
    // PLAN-no-powershell-runtime.md D7 (S83): the calls a seat and a lifecycle switch make, on `bun:ffi` in a compiled
    // kernel. Not in the menu; self-test section 115 judges a compiled kernel through it with no PowerShell on PATH.
    ported: true,
    row: 'S83',
  },
  publish: {
    summary: "Publish, batch-publish or refresh a Shelf Book into the Library's collection: collection/ on a local Library, Basic Memory on one attached to it.",
    usage:
      'library publish <shelf-slug> --title <t> --summary <s> [--book-slug <s>] [--collection <c>] [--book-version <v>] [--replace-existing] ' +
      '(--preflight | --user-confirmed --plan-id <plan_id>); library publish batch --plan <path> (--preflight | --user-confirmed --plan-id <plan_id>); ' +
      'library publish refresh <slug> --title <t> --summary <s> [--collection <c>] (--preflight | --user-confirmed --plan-id <refresh_plan_id>)',
    // THE PROSE THAT ENDED THE USAGE (S106 row 3): a usage clause is grammar the docs check reads, so sentences live here.
    details: {
      '*': [
        'Each runs --preflight first, then --user-confirmed --plan-id <id> with the id the preflight issued.',
        "A recalled Book's --title and --summary default to its Shelf entry. On a local Library a refresh is approved by its",
        'refresh_plan_id, never its candidate_plan_id.',
      ],
    },
    actions: ['batch', 'refresh'],
    positional: true,
    arguments: {
      '': {
        valued: [
          'title', 'summary', 'book-slug', 'collection', 'topics', 'book-version', 'reason', 'lock-timeout', 'plan-id',
          'publication-journal-path', 'workflow-journal-path',
        ],
        boolean: ['replace-existing', 'preflight', 'user-confirmed'],
        internal: ['publication-journal-path', 'workflow-journal-path'],
        positionals: 1,
      },
      batch: { valued: ['plan', 'plan-id'], boolean: ['preflight', 'user-confirmed'], positionals: 0 },
      refresh: {
        valued: ['title', 'summary', 'book-slug', 'collection', 'lock-timeout', 'plan-id', 'journal-path'],
        boolean: ['preflight', 'user-confirmed'],
        internal: ['journal-path'],
        positionals: 1,
      },
    },
    // The fence (S34), then the three preflights (S35, src/publish.ts): Publish-ShelfBookToShared,
    // Publish-ShelfBookBatchToShared and Publish-BookCopy -ReplaceExisting. The confirmed publish and refresh
    // since S39, and the batch's since S40.
    ported: true,
    row: 'S16',
  },
  raw: {
    summary: 'Scoped search over one source batch, and which Project owns each batch.',
    usage: 'library raw search <batch> <query> [--max-results <n>]; library raw owners [--offline]',
    actions: ['owners', 'search'],
    positional: false,
    details: {
      owners: ['--offline is the default: owners reads only this Library and never the network, so --offline changes nothing.'],
    },
    arguments: {
      search: { valued: ['max-results'], positionals: 2 },
      // `--offline` IS ACCEPTED AND CHANGES NOTHING (kickoffs/s106 ruling 3): the verb is always offline, and a matrix
      // row passes it.
      owners: { boolean: ['offline'], positionals: 0 },
    },
    ported: true,
    row: 'S15',
  },
  reset: {
    summary: 'The Library Reset: seat-scoped, quarantining, recoverable.',
    usage:
      'library reset [--seat <s>] [--clear-desk] [--preflight | --plan-id <id>] [--json]; ' +
      'library reset restore (--list | --quarantine <name> [--show | --topic <t,...>] [--adopt] [--preflight | --plan-id <id>]) [--json]',
    actions: ['restore'],
    positional: false,
    arguments: {
      // `--whole-tree` and `--all-idle-seats` are read only to be refused by name.
      '': { valued: ['seat', 'plan-id'], boolean: ['clear-desk', 'preflight', 'whole-tree', 'all-idle-seats'], internal: ['whole-tree', 'all-idle-seats'], positionals: 0 },
      restore: { valued: ['quarantine', 'topic', 'plan-id', 'seat'], boolean: ['list', 'show', 'adopt', 'preflight'], positionals: 0 },
    },
    ported: true,
    row: 'S17',
  },
  seat: {
    summary: 'Seat creation, the claim by verified process identity, and binding.',
    usage:
      'library seat <cards|describe|dirs|enter|rename|settings|start|status|retire> [<name>] [arguments]; library seat start <name> [--project <slug>] [--command claude|codex] ' +
      '[--session-id <id> | --resume <id>] [--plan-id <id>] [--no-launch] [--preflight] [-- <agent arguments>]; ' +
      'library seat start <name> --project <slug> [--template performer|orchestrator] [--department <slug>] [--role performer|orchestrator] ' +
      '[--card "<one line>"] [--open-book <shelf-slug>]... [--inbound accept|hold|refuse|unset] [--preflight | --plan-id <id>]; ' +
      'library seat dirs <name> [--list | --add <folder> | --remove <folder>] [--workspace <path>] [--json]; ' +
      'library seat settings <name> [--inbound accept|hold|refuse|unset] [--preflight | --plan-id <id>] [--workspace <path>] [--json]; ' +
      'library seat describe <name> [--department <slug>] [--role performer|orchestrator] [--card "<one line>"] [--clear-department] [--clear-role] [--clear-card] [--from <seat>] [--preflight | --plan-id <id>] [--workspace <path>]; ' +
      'library seat cards [--all] [--seat <name>] [--json] [--workspace <path>]; ' +
      'library seat rename <old> <new> [--preflight | --user-confirmed --plan-id <id>] [--workspace <path>] [--json]; ' +
      'library seat rename (--resume <seat> | --rollback <seat>) [--workspace <path>] [--json]; ' +
      'library seat status [--seat <name>] [--text] [--workspace <path>]',
    // Every one answers; `start` is the one launcher the main menu uses (S55, ADR-0059), and `hold` is the claim holder
    // `enter` spawns, never run by hand. `dirs` is the seat's own added folders (1.2.5, ADR-0061), and `settings` its
    // inbound policy (1.3.1, ADR-0062), both applied by `start`. `describe` sets a seat's department, role and card under
    // the reader's gate (1.3.8, ADR-0069), and `cards` lists them as the directory, computed and read only.
    actions: ['cards', 'describe', 'dirs', 'enter', 'hold', 'rename', 'retire', 'settings', 'start', 'status'],
    positional: false,
    details: {
      rename: [
        'One seat per run, by its id: its folder, its Notebook root, four files\' seat key and its registry row; the Project and Hub never change.',
        'A stopped rename stands as a barrier at the seat: --resume <seat> finishes it, --rollback <seat> puts it back (either name finds it).',
        'Undo a finished rename by renaming back to the seat\'s previous name.',
      ],
      start: [
        'A new seat: --template, --department, --role, --card, --open-book and --inbound each need the plan_id its --preflight issued.',
        '--inbound accept lets other seats\' rings reach a new Claude Code seat at once; an existing seat takes it from seat settings.',
      ],
      dirs: ['--list is the default: with neither --add nor --remove, dirs lists the seat\'s folders, and --list changes nothing.'],
    },
    arguments: {
      cards: { valued: ['seat'], boolean: ['all'], positionals: 0 },
      describe: {
        valued: ['department', 'role', 'card', 'from', 'plan-id'],
        boolean: ['clear-department', 'clear-role', 'clear-card', 'preflight'],
        positionals: 1,
      },
      dirs: { valued: ['add', 'remove'], boolean: ['list'], positionals: 1 },
      // THE SESSION-START HOOK'S ROUTE: the five `seat start` options are read only to be refused by name here.
      enter: {
        valued: ['agent-pid', 'session-id', 'deadline-seconds', 'project', 'plan-id', 'department', 'role', 'card', 'template', 'open-book'],
        boolean: ['create', 'preflight'],
        internal: ['agent-pid', 'deadline-seconds'],
        positionals: 1,
      },
      // The claim holder `seat enter` spawns; never run by hand.
      hold: {
        valued: ['seat', 'attempt-id', 'agent-pid', 'agent-start-utc', 'poll-ms'],
        internal: ['seat', 'attempt-id', 'agent-pid', 'agent-start-utc', 'poll-ms'],
        positionals: 0,
      },
      rename: { valued: ['plan-id', 'resume', 'rollback'], boolean: ['preflight', 'user-confirmed'], positionals: 2 },
      retire: { valued: ['plan-id'], boolean: ['preflight'], positionals: 1 },
      settings: { valued: ['inbound', 'plan-id'], boolean: ['preflight'], positionals: 1 },
      // EVERYTHING AFTER A BARE `--` IS THE AGENT'S, never checked. The two legacy names are read only to be refused.
      start: {
        valued: [
          'project', 'command', 'plan-id', 'assistant', 'resume', 'session-id', 'department', 'role', 'card', 'template', 'inbound',
          'deadline-seconds', 'restore-desk-from-archive',
        ],
        repeatable: ['open-book'],
        boolean: ['no-launch', 'preflight', 'retire-legacy-desk'],
        internal: ['deadline-seconds', 'restore-desk-from-archive', 'retire-legacy-desk'],
        positionals: 1,
        passthrough: true,
      },
      status: { valued: ['seat'], boolean: ['text'], positionals: 0 },
    },
    ported: true,
    row: 'S14',
  },
  selftest: {
    summary: 'The suites judged against a stated property rather than against PowerShell.',
    usage: 'library selftest <name> [--workspace <path>]',
    // The three the harness rows still name, each judged by a verdict a real session records. The four
    // concurrency and recovery actions were removed (S43): their rows are judged by kernel self-test sections
    // 29-32, which drive the kernel's real verbs, because a kernel judging itself is not a judge.
    actions: ['codex-hooks', 'hooks', 'session-start'],
    positional: false,
    // NOT PORTED: it refuses by name before any table is read.
    arguments: { '': { positionals: 0, retired: true }, 'codex-hooks': { positionals: 0, retired: true }, hooks: { positionals: 0, retired: true }, 'session-start': { positionals: 0, retired: true } },
    ported: false,
    row: 'S18',
  },
  rollback: {
    summary: 'Switch this install back to the version before it, once every session is closed; a shared Book open on a Desk blocks it.',
    usage: 'library rollback [--yes] [--json]',
    actions: [],
    positional: false,
    arguments: { '': { boolean: ['yes'], positionals: 0 } },
    workspace: false,
    // PLAN-install-onboarding.md step 8 (S54, ADR-0058), keeping ADR-0054's shared-Desk preflight. Windows in 1.1.
    ported: true,
    row: 'S54',
  },
  setup: {
    summary: 'Set up Deskpost: the installer\'s one question and screen, its read-only plan and its apply; or a Library made later, shown first and made on one yes.',
    usage:
      'library setup [<folder>] [--repair] [--yes] [--json]; library setup --ask --answers <file> [--library <dir|none>] [--install-root <dir>] [--yes] [--allow-overlap] [--repair] [--no-path-change]; ' +
      'library setup --plan --answers <file> --resources <tree> [--register-as <root>/current] --out <file>; library setup --apply --plan-file <file>; ' +
      'library setup --welcome --workspace <Library> [--assistant claude|codex]',
    actions: [],
    positional: true,
    // EVERY MODE'S NAMES IN ONE TABLE, as the usage is one verb; `--welcome` is answered by the menu's module.
    arguments: {
      '': {
        valued: [
          'answers', 'install-root', 'library', 'resources', 'register-as', 'out', 'plan-file', 'assistant', 'script',
          'cwd', 'checksum-note', 'registry-root', 'release-sha', 'script-sha', 'user-path', 'refresh-served',
        ],
        boolean: ['ask', 'plan', 'apply', 'welcome', 'sessions', 'yes', 'repair', 'allow-overlap', 'no-path-change', 'run-as-file', 'keep-libraries'],
        internal: ['script', 'cwd', 'checksum-note', 'registry-root', 'release-sha', 'script-sha', 'user-path', 'refresh-served', 'sessions', 'run-as-file', 'keep-libraries'],
        positionals: 1,
      },
    },
    // PLAN-install-onboarding.md steps 2-4 (S54, ADR-0057). The installer runs --ask, --plan and --apply; a reader runs the bare verb.
    ported: true,
    row: 'S54',
  },
  shared: {
    summary: "The collection's Catalog: `collection/` on a local Library, Basic Memory on one attached to it. List an entry, archive a Book.",
    usage:
      'library shared <archive|list-entry> <slug> [--title <t>] [--summary <s>] [--kind book|project] [--collection <c>] --preflight; ' +
      'library shared archive <slug> [--kind book] --user-confirmed --plan-id <id>',
    details: {
      archive: ['On a local Library, --plan-id is the plan_id the preflight issued.'],
    },
    actions: ['archive', 'list-entry'],
    positional: false,
    arguments: {
      // Both backends' names: a local Library reads `--kind` and `--plan-id`; Basic Memory's preflight reads neither.
      archive: { valued: ['kind', 'plan-id'], boolean: ['preflight', 'user-confirmed'], positionals: 1 },
      'list-entry': { valued: ['title', 'summary', 'kind', 'collection'], boolean: ['preflight', 'user-confirmed'], positionals: 1 },
    },
    // Both preflights, against Basic Memory (S34); a confirmed run names the PowerShell helper.
    ported: true,
    row: 'S16',
  },
  shelf: {
    summary:
      "The local Shelf: render, new, rename, remove, archive, restore, stub, carry another workspace's capture notes in, recall a collection Book to the Shelf, tidy a capture Book's closed notes, and rebuild a Book's Discovery manifest from disk.",
    usage:
      // ONE CLAUSE PER ACTION (S71 row 10), each listing its own parser's flags, so `shelf <action> --help` shows it.
      'library shelf <action> [arguments] [--workspace <path>] [--json]; ' +
      'library shelf render; ' +
      'library shelf new <slug> --title <t> --summary <s> [--topics <t>] [--origin <o>] [--capture [--closed-by writer|any] [--letters]] [--preflight]; ' +
      'library shelf rename <slug> <new-slug> [--new-title <t>] (--preflight | --plan-id <id>); ' +
      'library shelf remove <slug> [--reason <r>] [--seat <s>] (--preflight | --plan-id <id>); ' +
      'library shelf archive <slug> [--reason <r>] (--preflight | --plan-id <id>); ' +
      'library shelf restore <slug> (--preflight | --plan-id <id>); ' +
      'library shelf stub <slug> <page> --canonical <book>/<page> [--reason <r>] [--superseded-on <yyyy-MM-dd>] (--preflight | --plan-id <id>); ' +
      'library shelf duplicates [--embedding-url <u>] [--embedding-model <m>] [--api-key <k>] [--similarity-threshold <n>] [--batch-size <n>]; ' +
      'library shelf carry <old-workspace> --book <capture-book> (--preflight | --user-confirmed --plan-id <id>); ' +
      'library shelf recall <book-slug> [--shelf-slug <s>] (--preflight | --user-confirmed --plan-id <id>) [--lock-timeout <s>]; ' +
      'library shelf tidy <capture-book> [--days <n>] [--restore reviewed/<yyyy-mm>/<name>] (--preflight | --user-confirmed --plan-id <id>); ' +
      'library shelf rebuild [<slug>]',
    actions: ['archive', 'carry', 'duplicates', 'new', 'rebuild', 'recall', 'remove', 'rename', 'render', 'restore', 'stub', 'tidy'],
    positional: false,
    arguments: {
      '': { positionals: 0 },
      render: { positionals: 0 },
      new: { valued: ['title', 'summary', 'topics', 'origin', 'closed-by'], boolean: ['capture', 'letters', 'preflight'], positionals: 1 },
      rename: { valued: ['new-title', 'plan-id'], boolean: ['preflight'], positionals: 2 },
      remove: { valued: ['reason', 'seat', 'plan-id'], boolean: ['preflight'], positionals: 1 },
      archive: { valued: ['reason', 'plan-id'], boolean: ['preflight'], positionals: 1 },
      restore: { valued: ['plan-id'], boolean: ['preflight'], positionals: 1 },
      stub: { valued: ['canonical', 'reason', 'superseded-on', 'plan-id'], boolean: ['preflight'], positionals: 2 },
      duplicates: { valued: ['embedding-url', 'embedding-model', 'api-key', 'similarity-threshold', 'batch-size'], positionals: 0 },
      carry: { valued: ['book', 'plan-id'], boolean: ['preflight', 'user-confirmed'], positionals: 1 },
      recall: { valued: ['shelf-slug', 'lock-timeout', 'plan-id', 'seat'], boolean: ['preflight', 'user-confirmed'], positionals: 1 },
      tidy: { valued: ['days', 'restore', 'plan-id'], boolean: ['preflight', 'user-confirmed'], positionals: 1 },
      rebuild: { positionals: 1 },
    },
    details: {
      render: [
        "render rebuilds shelf/_catalog.md from each Book's shelf/<slug>/_catalog-entry.md. It takes no Book name: it",
        'renders the whole catalog. Run it after any _catalog-entry.md edit. It is safe to rerun: the same entries give the same catalog.',
      ],
    },
    // The five writers landed in S14; `duplicates` in S41 (src/duplicates.ts), judged against the
    // harness's embedding stand-in.
    ported: true,
    row: 'S13',
  },
  triage: {
    summary: 'The triage inventory, plan validation, and the resumable batch.',
    usage: 'library triage <inventory [--pending]|validate|batch> [--actions <json> | --actions-path <file>] [--preflight | --user-confirmed --plan-id <id>] [arguments]',
    // THE SOURCES, AND HOW A LETTER IS CLOSED (S85 row 5, backlog Row C): `source_slug` was nowhere in the help.
    details: {
      '*': [
        'Sources:',
        "  holding    a note in a capture Book: the Holding Shelf, or the Book source_slug names (reports, letters).",
        '  notebook   a Notebook article.',
        '',
        'inventory names each note\'s from_seat and for_seat; --pending lists only the notes still waiting, and no Notebook page.',
        'validate is always a preview: it writes nothing, and --preflight changes nothing there.',
        '--actions-path <file> reads the actions as UTF-8 JSON from a file, in place of --actions: Windows PowerShell strips the',
        'quotes inside an inline JSON value. ' + CONTENT_PATH_RULE.replace('--content-path', '--actions-path'),
        '',
        'A seat closes a letter for itself with deskpost letters close notes/<page> --note "<what became of it>", not with triage.',
        'The reader closes any letter with a review that names its Book:',
        `  --actions '[{"kind":"review","source":"holding","source_slug":"letters","source_page":"notes/<page>"}]'`,
      ],
    },
    actions: ['batch', 'inventory', 'validate'],
    positional: false,
    arguments: {
      inventory: { boolean: ['pending'], positionals: 0 },
      // `--preflight` IS ACCEPTED AND CHANGES NOTHING (kickoffs/s106 ruling 3): validation is always a preview, and a
      // matrix row passes it.
      validate: { valued: ['actions', 'actions-path', 'capture-date', 'seat'], boolean: ['preflight'], internal: ['capture-date'], positionals: 0 },
      // `--plan-path` is read only to be refused by name.
      batch: {
        valued: ['actions', 'actions-path', 'capture-date', 'seat', 'plan-id', 'lock-timeout', 'plan-path'],
        boolean: ['preflight', 'user-confirmed'],
        internal: ['capture-date', 'plan-path'],
        positionals: 0,
      },
    },
    // All three answer. `batch` (S43) runs and resumes a plan for the local kinds and refuses a project or
    // book action by name; the old `resume` action is gone, because a resume IS the same batch run again.
    ported: true,
    row: 'S15',
  },
  uninstall: {
    summary: 'Remove what this install put on the machine, shown first: its entries in your Libraries, its PATH entry and its program files. Your Libraries stay.',
    usage: 'library uninstall [--dry-run] [--yes] [--json]',
    actions: [],
    positional: false,
    arguments: { '': { boolean: ['dry-run', 'yes'], positionals: 0 } },
    workspace: false,
    // PLAN-install-onboarding.md step 8 (S54, ADR-0058): a frozen list, the Libraries edited first, then a finisher. Windows in 1.1.
    ported: true,
    row: 'S54',
  },
  verbs: {
    summary: 'This table, as JSON, for the gate check that resolves a matrix row against it.',
    usage: 'library verbs',
    actions: [],
    positional: false,
    arguments: { '': { positionals: 0 } },
    workspace: false,
    ported: true,
    row: 'S13',
  },
};

/**
 * The reader tools `library mcp call` dispatches on. Named here rather than inside the reader so the
 * inventory a check reads and the switch that serves the call cannot disagree.
 */
export const READER_TOOLS = [
  'discover_book_pages',
  'read_book_catalog',
  'read_open_book_page',
  'read_open_project_briefing',
  'read_open_project_page',
  'read_project_catalog',
  'search_open_books',
  'suggest_active_projects',
];

export function verbInventory(): Record<string, unknown> {
  const verbs: Record<string, unknown> = {};
  for (const name of Object.keys(VERBS).sort()) {
    const declaration = VERBS[name]!;
    verbs[name] = {
      summary: declaration.summary,
      usage: declaration.usage,
      actions: declaration.actions,
      positional: declaration.positional,
      ported: declaration.ported,
      row: declaration.row,
    };
  }
  return { schema: 1, verbs, reader_tools: [...READER_TOOLS].sort() };
}

/**
 * The usage text, composed from the table so the help and the dispatch cannot drift apart. It says `deskpost`, the
 * command a reader types (ADR-0055); the table's own usage lines keep `library`, the alias, which is what the
 * acceptance matrix's rows name.
 */
/**
 * ONE VERB'S USAGE, for `deskpost <verb> [<action>] --help` and `deskpost help <verb>` (S67, three Reports: `hub edit
 * --help` failed, `book add-page --help` was read as a slug, and `init --help` once made a Library). An action that
 * names its own clauses shows only those; anything else shows the verb's whole usage.
 */
export function verbUsageText(verb: string, action?: string): string {
  const declaration = VERBS[verb]!;
  const clauses = declaration.usage.split(/;\s+(?=library )/).map((clause) => clause.replace(/^library /, 'deskpost '));
  const picked = action && declaration.actions.includes(action) ? clauses.filter((clause) => clause.startsWith(`deskpost ${verb} ${action}`)) : [];
  const shown = picked.length ? picked : clauses;
  const lines = [`deskpost ${verb} -- ${declaration.summary}`, '', 'Usage:', ...shown.map((clause) => `  ${clause}`)];
  if (declaration.actions.length && !picked.length) lines.push('', `Actions: ${declaration.actions.join(', ')}`);
  // `*` is the verb's own lines, shown when no one action is picked.
  const details = picked.length && action ? declaration.details?.[action] : declaration.details?.['*'];
  if (details?.length) lines.push('', ...details);
  return lines.join('\n') + '\n';
}

export function usageText(): string {
  const lines = [
    'deskpost -- the Library, from the command line. (`library` is the same command, kept as an alias through 1.x.)',
    '',
    'Usage: deskpost [--workspace <path>] <command> [arguments]',
    '',
    'Commands:',
  ];
  for (const name of Object.keys(VERBS).sort()) {
    const declaration = VERBS[name]!;
    const mark = declaration.ported ? '' : `   (not ported yet -- ${declaration.row})`;
    lines.push(`  ${name.padEnd(10)} ${declaration.summary}${mark}`);
    lines.push(`             ${declaration.usage.replace(/(^|; )library /g, '$1deskpost ')}`);
  }
  lines.push('');
  lines.push('Every command but `init` runs against one workspace, chosen in this order:');
  lines.push('  --workspace <path>, then $env:LIBRARY_WORKSPACE, then a walk up from the current directory.');
  return lines.join('\n');
}

/**
 * The refusal an unported verb gives. It names the ledger row that carries it and the PowerShell
 * route that works today, because a refusal that only says "no" leaves the reader with nothing.
 */
export function notPortedRefusal(verb: string): string {
  const declaration = VERBS[verb]!;
  return (
    `library ${verb} is not ported yet: PLAN-public-release.md step 24 sequences it, and ${declaration.row} ` +
    'is the ledger row that carries it. Its matrix rows mismatch until this answers. ' +
    'Use the PowerShell helpers in tools/ until then.'
  );
}
