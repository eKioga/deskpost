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
}

export const VERBS: Record<string, VerbDeclaration> = {
  book: {
    summary: 'Add a page to an open curated Book, or graduate a Notebook topic into one.',
    usage: 'library book <add-page|graduate> <slug> [arguments]',
    actions: ['add-page', 'graduate'],
    positional: false,
    // `add-page` is ported whole; `graduate` answers --preflight and refuses the apply half by
    // name, because its per-page progress journal is what makes an interrupted run resumable.
    ported: true,
    row: 'S15',
  },
  capture: {
    summary: 'Capture a note into a capture-enabled Book. Saving is ungated and needs no open Book; reading the note back needs its Book open.',
    usage: 'library capture <book> --title <t> --body <b>',
    actions: [],
    positional: true,
    ported: true,
    row: 'S15',
  },
  collection: {
    summary: "The shared collection's ownership claim: who may write to it from this machine.",
    usage: 'library collection owner [--status | --acquire [--force [--user-confirmed]] | --release] [--json]',
    actions: ['owner'],
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
    usage: 'library desk [open|close|clear] [--seat <name>] [--json]',
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
  hook: {
    summary: "The Library's hooks: a harness payload on stdin, a decision or context on stdout.",
    usage: 'library hook <shelf-read|shell-shelf-read|basic-memory-read|settings-integrity|desk-context> [--workspace <path>] [--seat <s>] [--state-directory <d>] [--agent-pid <n>] [--reader-tool-prefix <p>]',
    actions: ['shelf-read', 'shell-shelf-read', 'basic-memory-read', 'settings-integrity', 'desk-context'],
    positional: false,
    // The two Shelf guards (S31, the first half of S20's port), the Basic Memory guard (S32) and the
    // ConfigChange settings guard and the UserPromptSubmit Desk context hook (S36).
    ported: true,
    row: 'S20',
  },
  hub: {
    summary: 'Project Hubs, local and shared, and the bounded Hub edit.',
    usage:
      'library hub new <slug> --title <t> [--purpose <p>] [--next-action <a>] [--dev] [--preflight] [--json]; ' +
      'library hub edit <slug> --mode <add-section|append-section|remove-section|replace-section|replace-body|check-item|replace-item> ' +
      '[--section <s>] [--match-text <t>] [--content <c> | --content-path <f>] [--page <p>] [--uncheck] [--preflight | --user-confirmed --plan-id <id>]; ' +
      'library hub archive <slug> --preflight; ' +
      'library hub copy-pages <slug> --source <path> --title <t> --purpose <p> [--next-action <a>]... [--include-page <p>]... ' +
      '[--at-project-root | --destination-directory <d>] --preflight',
    actions: ['archive', 'copy-pages', 'edit', 'new'],
    positional: false,
    // `new` against both backends (S30 local, S33 Basic Memory); `edit` against both (S34); `archive`
    // (S34) and `copy-pages` (S35) against Basic Memory, their preflights, with the confirmed halves
    // refusing by name.
    ported: true,
    row: 'S16',
  },
  init: {
    summary: 'Make a folder a Library workspace, and tell this machine about it.',
    usage: 'library init [<folder>] [--force] [--json]',
    actions: [],
    positional: true,
    ported: true,
    row: 'S13',
  },
  mcp: {
    summary: 'The validated reader: one tool call the way a harness makes it, or the stdio MCP server a harness launches.',
    usage: 'library mcp call <tool> [--slug <s>] [--page <p>] [--location <l>]; library mcp serve [--workspace <path>] [--state-directory <d>] [--seat <s>]',
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
  publish: {
    summary: 'Publish, batch-publish or refresh a Shelf Book into the shared collection.',
    usage:
      'library publish <shelf-slug> --title <t> --summary <s> [--book-slug <s>] [--collection <c>] [--book-version <v>] [--replace-existing] --preflight; ' +
      'library publish batch --plan <path> --preflight; library publish refresh <slug> --title <t> --summary <s> --preflight',
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
    usage: 'library seat <enter|start|status|retire> [<name>] [arguments]',
    // `enter` and `retire` are ported (S14's second half); `start` and `status` refuse by name, and
    // `hold` is the claim holder `enter` spawns, never run by hand.
    actions: ['enter', 'hold', 'retire', 'start', 'status'],
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
    summary: 'The local Shelf: render, new, rename, remove, archive, restore, stub.',
    usage: 'library shelf <action> [arguments] [--workspace <path>] [--json]',
    actions: ['archive', 'duplicates', 'new', 'remove', 'rename', 'render', 'restore', 'stub'],
    positional: false,
    // The five writers landed in S14; `duplicates` in S41 (src/duplicates.ts), judged against the
    // harness's embedding stand-in.
    ported: true,
    row: 'S13',
  },
  triage: {
    summary: 'The triage inventory, plan validation, and the resumable batch.',
    usage: 'library triage <inventory|validate|batch> [--actions <json>] [--preflight | --user-confirmed --plan-id <id>] [arguments]',
    actions: ['batch', 'inventory', 'validate'],
    positional: false,
    // All three answer. `batch` (S43) runs and resumes a plan for the local kinds and refuses a project or
    // book action by name; the old `resume` action is gone, because a resume IS the same batch run again.
    ported: true,
    row: 'S15',
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

/** The usage text, composed from the table so the help and the dispatch cannot drift apart. */
export function usageText(): string {
  const lines = [
    'library -- the Library, from the command line.',
    '',
    'Usage: library [--workspace <path>] <command> [arguments]',
    '',
    'Commands:',
  ];
  for (const name of Object.keys(VERBS).sort()) {
    const declaration = VERBS[name]!;
    const mark = declaration.ported ? '' : `   (not ported yet -- ${declaration.row})`;
    lines.push(`  ${name.padEnd(10)} ${declaration.summary}${mark}`);
    lines.push(`             ${declaration.usage}`);
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
