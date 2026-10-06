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
    // PLAN-basic-memory.md (S52): a connection, never a backend, and nothing written to Basic Memory in 1.1.
    ported: true,
    row: 'S52',
  },
  book: {
    summary: 'Add a page to an open curated Book, or graduate a Notebook topic into one.',
    // ONE CLAUSE PER ACTION (S71 row 10), each listing its own parser's flags, so `book <action> --help` shows it.
    usage:
      'library book add-page <slug> <page> (--content-path <f> | --body <text>) [--title <t>] [--seat <s>] [--preflight]; ' +
      'library book graduate <slug> [--topic <t> | --source-path <p>] [--page-prefix <p>] [--recurse] [--seat <s>] [--preflight]',
    actions: ['add-page', 'graduate'],
    positional: false,
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
    usage: 'library capture <book> --title <t> (--body <b> | --content-path <file>) [--why no-seat|no-home|needs-yes|reset-imminent|for-seat] [--supersedes notes/<page>] [--for <seat>]',
    actions: [],
    positional: true,
    ported: true,
    row: 'S15',
  },
  collection: {
    summary: "The shared collection's ownership claim, the Local collection's Discovery manifests, and a page added to one of its Books.",
    usage:
      'library collection owner [--status | --acquire [--force [--user-confirmed]] | --release] [--json]; library collection rebuild [--json]; ' +
      'library collection add-page <slug> <page> (--content-path <f> | --body <b>) [--title <t>] (--preflight | --user-confirmed --plan-id <id>) [--lock-timeout <s>]',
    actions: ['add-page', 'owner', 'rebuild'],
    positional: false,
    // Set-CollectionOwner.ps1 whole (S43), judged by kernel self-test section 28.
    ported: true,
    row: 'S16',
  },
  compile: {
    summary: 'Compile one source batch into Notebook articles. Never the whole raw tree.',
    usage:
      'library compile <batch> --topic <t> --topic-title <title> --topic-overview <line> --article-slug <s> ' +
      '--content-path <file> --source-file <a[,b]> [--replace-existing] [--require-pin] [--preflight | --plan-id <id>] [--json]',
    actions: [],
    positional: true,
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
    ported: true,
    row: 'S14',
  },
  doctor: {
    summary: 'Every registered check, with one result each. A check that did not run reports skipped.',
    usage: 'library doctor [--workspace <path>] [--json]',
    actions: [],
    positional: false,
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
        '',
        "For the section modes, --content and --content-path are the section's body only: leave out the '## <section>' line.",
        'replace-item on a paragraph line replaces that line only; on a list item it replaces the item with its nested sub-items.',
        "Gated means --preflight first, then --user-confirmed --plan-id <id> with the reader's yes.",
      ],
    },
    positional: false,
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
    ported: true,
    row: 'S13',
  },
  library: {
    summary: 'The Libraries registered on this machine, and which one bare `deskpost` opens from anywhere.',
    usage: 'library library [list] [--json]; library library default <folder> [--json]',
    actions: ['default', 'list'],
    positional: false,
    // PLAN-install-onboarding.md step 5a (S55, ADR-0059): the default Library is one registry entry's `default: true`.
    ported: true,
    row: 'S55',
  },
  menu: {
    summary: 'The main menu, which bare `deskpost` opens: your seats, a number to resume one, n<number> for a new conversation, + for a new seat.',
    usage: 'library menu [--workspace <path>] [--width <n>] [--plain] [--assistant claude|codex] [--script <answers-file>]',
    actions: [],
    positional: false,
    // PLAN-install-onboarding.md step 5a (S55, ADR-0059): tools/SeatPicker.ps1 ported, launching through `seat start`.
    ported: true,
    row: 'S55',
  },
  mcp: {
    summary: 'The validated reader: one tool call the way a harness makes it, or the stdio MCP server a harness launches.',
    usage:
      'library mcp call <tool> [--slug <s>] [--page <p>] [--place shelf|collection|shared] [--query <q>] [--location <l>]; ' +
      'library mcp serve [--workspace <path>] [--state-directory <d>] [--seat <s>]',
    actions: ['call', 'serve'],
    positional: false,
    ported: true,
    row: 'S13',
  },
  migrate: {
    summary: 'The data-model migration, which refuses activation until every legacy state is accounted for.',
    usage:
      'library migrate [--assign <item>=<seat>[,...]] [--set-aside <item>[,...]] (--preflight | --plan-id <id>) | --resume | --rollback [--seat <s>] [--json]',
    actions: [],
    positional: false,
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
    ported: true,
    row: 'S17',
  },
  process: {
    summary: 'What the kernel reads about a process: its start time, its parents, its exit and the process list. Internal: the self-test drives these through it.',
    usage: 'library process <start|ancestry|wait> <pid> [--start-utc <s>] [--poll-ms <n>]; library process list [--name <image>]',
    actions: ['ancestry', 'list', 'start', 'wait'],
    positional: false,
    // PLAN-no-powershell-runtime.md D7 (S83): the calls a seat and a lifecycle switch make, on `bun:ffi` in a compiled
    // kernel. Not in the menu; self-test section 115 judges a compiled kernel through it with no PowerShell on PATH.
    ported: true,
    row: 'S83',
  },
  publish: {
    summary: "Publish, batch-publish or refresh a Shelf Book into the Library's collection: collection/ on a local Library, Basic Memory on one attached to it.",
    usage:
      'library publish <shelf-slug> --title <t> --summary <s> [--book-slug <s>] [--collection <c>] [--book-version <v>] [--replace-existing] --preflight, ' +
      'then --user-confirmed --plan-id <plan_id>; library publish batch --plan <path> --preflight; ' +
      'library publish refresh <slug> --title <t> --summary <s> [--collection <c>] --preflight, then --user-confirmed --plan-id <refresh_plan_id>. ' +
      "A recalled Book's --title and --summary default to its Shelf entry. On a local Library a refresh is approved by its refresh_plan_id, never its candidate_plan_id",
    actions: ['batch', 'refresh'],
    positional: true,
    // The fence (S34), then the three preflights (S35, src/publish.ts): Publish-ShelfBookToShared,
    // Publish-ShelfBookBatchToShared and Publish-BookCopy -ReplaceExisting. The confirmed publish and refresh
    // since S39, and the batch's since S40.
    ported: true,
    row: 'S16',
  },
  raw: {
    summary: 'Scoped search over one source batch, and which Project owns each batch.',
    usage: 'library raw <search|owners> [arguments]',
    actions: ['owners', 'search'],
    positional: false,
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
    ported: true,
    row: 'S17',
  },
  seat: {
    summary: 'Seat creation, the claim by verified process identity, and binding.',
    usage:
      'library seat <dirs|enter|settings|start|status|retire> [<name>] [arguments]; library seat start <name> [--project <slug>] [--command claude|codex] ' +
      '[--session-id <id> | --resume <id>] [--plan-id <id>] [--no-launch] [--preflight] [-- <agent arguments>]; ' +
      'library seat dirs <name> [--list | --add <folder> | --remove <folder>] [--workspace <path>] [--json]; ' +
      'library seat settings <name> [--inbound accept|hold|refuse|unset] [--preflight | --plan-id <id>] [--workspace <path>] [--json]; ' +
      'library seat status [--seat <name>] [--text] [--workspace <path>]',
    // All six answer; `start` is the one launcher the main menu uses (S55, ADR-0059), and `hold` is the claim holder
    // `enter` spawns, never run by hand. `dirs` is the seat's own added folders (1.2.5, ADR-0061), and `settings` its
    // inbound policy (1.3.1, ADR-0062), both applied by `start`.
    actions: ['dirs', 'enter', 'hold', 'retire', 'settings', 'start', 'status'],
    positional: false,
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
    ported: false,
    row: 'S18',
  },
  rollback: {
    summary: 'Switch this install back to the version before it, once every session is closed; a shared Book open on a Desk blocks it.',
    usage: 'library rollback [--yes] [--json]',
    actions: [],
    positional: false,
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
    // PLAN-install-onboarding.md steps 2-4 (S54, ADR-0057). The installer runs --ask, --plan and --apply; a reader runs the bare verb.
    ported: true,
    row: 'S54',
  },
  shared: {
    summary: "The shared collection's own Catalog: list an entry, archive a Book.",
    usage: 'library shared <archive|list-entry> <slug> [--title <t>] [--summary <s>] [--kind book|project] [--collection <c>] --preflight',
    actions: ['archive', 'list-entry'],
    positional: false,
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
    // The five writers landed in S14; `duplicates` in S41 (src/duplicates.ts), judged against the
    // harness's embedding stand-in.
    ported: true,
    row: 'S13',
  },
  triage: {
    summary: 'The triage inventory, plan validation, and the resumable batch.',
    usage: 'library triage <inventory [--pending]|validate|batch> [--actions <json>] [--preflight | --user-confirmed --plan-id <id>] [arguments]',
    // THE SOURCES, AND HOW A LETTER IS CLOSED (S85 row 5, backlog Row C): `source_slug` was nowhere in the help.
    details: {
      '*': [
        'Sources:',
        "  holding    a note in a capture Book: the Holding Shelf, or the Book source_slug names (reports, letters).",
        '  notebook   a Notebook article.',
        '',
        'inventory names each note\'s from_seat and for_seat; --pending lists only the notes still waiting.',
        '',
        'Marking a letter read (the seat it is for may close it):',
        `  --actions '[{"kind":"review","source":"holding","source_slug":"letters","source_page":"notes/<page>"}]'`,
      ],
    },
    actions: ['batch', 'inventory', 'validate'],
    positional: false,
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
    // PLAN-install-onboarding.md step 8 (S54, ADR-0058): a frozen list, the Libraries edited first, then a finisher. Windows in 1.1.
    ported: true,
    row: 'S54',
  },
  verbs: {
    summary: 'This table, as JSON, for the gate check that resolves a matrix row against it.',
    usage: 'library verbs',
    actions: [],
    positional: false,
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
