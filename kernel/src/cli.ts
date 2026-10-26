#!/usr/bin/env node
/**
 * `library` -- the command a reader runs, in the language the kernel is being ported into.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. `library.ps1` at the program root is the PowerShell dispatcher
 * this replaces one verb at a time; PLAN-public-release.md step 24 sets the order, and
 * `tools/Invoke-AcceptanceMatrix.ps1 -Kernel 'node <this file>'` is what says whether a ported verb
 * answers the way the one it replaces does. A verb that is not ported yet REFUSES BY NAME rather
 * than pretending: a kernel that exited 0 on a verb it does not have would compare green against
 * nothing at all on some future row.
 *
 * REFUSALS GO TO STDERR AND THE EXIT CODE IS NON-ZERO. A dispatcher that printed a refusal on
 * stdout and exited 0 is indistinguishable from a result to everything that runs it.
 *
 * STDOUT IS WRITTEN AS ONE STRING, NEVER FORMATTED. The PowerShell half of this program pays for
 * that repeatedly -- `docs/helper-write-and-output-contracts.md` records a `-Json` document that
 * was unparseable because the host wrapped its long lines at 120 columns even into a redirected
 * file. Node does not format, and this file does not either: what goes to stdout is the document.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubHistory } from './hubhistory.ts';
import { runLibraryInit } from './init.ts';
import { deskOverview, deskWrite } from './desk.ts';
import { runCheckpointVerb } from './checkpointverb.ts';
import { runShelfVerb } from './shelf.ts';
import { shelfDuplicates } from './duplicates.ts';
import { captureVerb, lettersCloseVerb, lettersListVerb, reportsListVerb, reportsVerb, runBookVerb } from './capture.ts';
import { kickoffReceive, kickoffSend } from './kickoff.ts';
import { reportsTriagerVerb, runPostboxVerb } from './postbox.ts';
import { auditVerb } from './audit.ts';
import { runRawSearch } from './rawsearch.ts';
import { runRawOwners } from './rawowners.ts';
import { runTriageVerb } from './triage.ts';
import { runNotebookVerb } from './notebookverb.ts';
import { runResetVerb } from './reset.ts';
import { runCompileVerb } from './compile.ts';
import { runMigrateVerb } from './migrate.ts';
import { runDoctor } from './doctor.ts';
import { runBrowseVerb } from './browse.ts';
import { runSeatVerb } from './seat.ts';
import { runHubVerb, runPublishVerb, runSharedVerb } from './collection.ts';
import { runCollectionVerb } from './ownership.ts';
import { collectionAddPage } from './collectionpage.ts';
import { collectionReplacePage } from './collectionreplace.ts';
import { runMcpVerb } from './reader.ts';
import { runHookVerb } from './guards.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { forgetLibrary, NO_WORKSPACE_REFUSAL, requireWorkspace, resolveWorkspace } from './workspace.ts';
import { checkArguments, parseArguments, quoteWarnings } from './argv.ts';
import { takeContentPathNote } from './contentpath.ts';
import { programRoot, releaseTuple } from './programroot.ts';
import { argumentTable, commandAction, globalTable, notPortedRefusal, usageText, verbInventory, verbUsageText, VERBS } from './verbs.ts';
import { hostRemedies, hostRemedyFields, REMEDY_HOST } from './remedy.ts';
import { runBasicMemoryVerb } from './bmconnection.ts';
import { BASIC_MEMORY_ACTIONS } from './bmactions.ts';
import { doctorText, initText } from './human.ts';
import { runSetupVerb } from './setup.ts';
import { rollbackVerb, uninstallVerb } from './lifecycle.ts';
import { runProcessVerb } from './processverb.ts';
import { runFinishUninstall } from './finisher.ts';
import { installVerb } from './install.ts';
import { upgradeVerb } from './upgrade.ts';
import { menuIsInteractive, runLibraryVerb, runMenuVerb, runWelcomeVerb } from './menu.ts';
import { dashboardText, watchDashboard } from './dashboard.ts';
import { vaultVerb } from './vault.ts';
import { needsYouText, readNeedsYou, refreshAfterCommand, writeNeedsYou } from './needsyou.ts';


function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

/**
 * ASCII ON THE WIRE, as `Write-LibraryResult -Json` writes it since S34: every character above U+007F as
 * `\uXXXX`. The same JSON, and a reader whose console decodes stdout in an OEM code page -- 437 on the
 * machine this was measured on -- gets U+2014 rather than a best-fit hyphen or three bytes of mojibake.
 * Files are never written through here; they keep ConvertTo-Json's literal characters.
 */
export function asciiJson(document: string): string {
  return document.replace(/[^\x00-\x7f]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function emit(value: PsJsonValue, asJson: boolean, humanText?: string): void {
  // A RELATIVE --content-path FOUND IN BOTH PLACES SAYS WHICH WAS READ (kickoffs/s106 row 6c, contentpath.ts).
  const note = takeContentPathNote();
  if (note !== null && value !== null && typeof value === 'object' && !Array.isArray(value) && !('content_path_resolved' in value)) {
    value = { ...value, content_path_resolved: note };
  }
  // ON POSIX, AND FROM A COMPILED KERNEL ON WINDOWS, A REMEDY NAMES A COMMAND THE MACHINE CAN RUN (S42, S47, remedy.ts).
  if (asJson || humanText === undefined) writeStdout(asciiJson(psConvertToJson(hostRemedyFields(value))));
  else writeStdout(hostRemedies(humanText));
}

/** A hook's one JSON document, its remedy fields said as this host should say them (S42). */
function hostHookOutput(stdout: string): string {
  if (REMEDY_HOST === 'win32') return stdout;
  try {
    return JSON.stringify(hostRemedyFields(JSON.parse(stdout) as unknown));
  } catch {
    return hostRemedies(stdout);
  }
}

function refuse(message: string): never {
  process.stderr.write(hostRemedies(message) + '\n');
  process.exit(1);
}

async function main(argv: string[]): Promise<number> {
  // The global workspace may precede the verb, as the top-level usage promises.
  if (argv[0] === '--workspace') {
    const workspace = argv[1];
    if (!workspace || workspace.startsWith('-')) refuse('--workspace requires a path.');
    argv = [...argv.slice(2), '--workspace', workspace];
  }
  // BARE `deskpost` IS THE MAIN MENU (ADR-0059), where a person can answer; anywhere else it prints usage, as before,
  // so a caller that cannot be prompted never waits.
  if (argv.length === 0 && menuIsInteractive()) {
    const result = await runMenuVerb([]);
    if (result.refusal !== null) refuse(result.refusal);
    return result.exitCode;
  }
  // `help <verb>` IS THAT VERB'S USAGE (S67), and exits 0 like the whole table does.
  if (argv[0] === 'help' && argv[1] !== undefined && Object.prototype.hasOwnProperty.call(VERBS, argv[1])) {
    writeStdout(verbUsageText(argv[1], argv[2]));
    return 0;
  }
  if (argv.length === 0 || ['help', '--help', '-h', '-?', '/?'].includes(argv[0]!)) {
    writeStdout(usageText());
    return 0;
  }

  // THE RELEASE TUPLE, which install.ps1 and install.sh read back from the binary they just placed.
  // A flag rather than a verb: it describes the program, not an operation on a workspace.
  if (argv[0] === '--version') {
    emit(releaseTuple() as PsJsonValue, true);
    return 0;
  }

  const verb = argv[0]!;
  const rest = argv.slice(1);

  if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) {
    // NAMES WHAT EXISTS. A bare "unknown command" leaves the reader guessing at a list this file is
    // holding in its hand.
    refuse(
      `deskpost has no command '${verb}'. It has: ${Object.keys(VERBS).sort().join(', ')}. ` +
        'Run `deskpost help` for what each one does.',
    );
  }

  // `--help` ON ANY VERB OR ACTION PRINTS ITS USAGE AND EXITS 0, before any parser can take it for a slug or a flag
  // to act on (S67: `hub edit --help` failed, `book add-page --help` was read as a Book slug). `-h` counts wherever
  // `--help` does (S69): after a verb's other arguments it was a stray positional, and `hub new x ... -h` made the Hub.
  // EVERYTHING AFTER `seat start`'s BARE `--` IS THE AGENT'S (S106): `-- --help` asks the agent, not this program.
  const { action, argv: tail } = commandAction(verb, rest);
  const ownTable = VERBS[verb]!.arguments[action];
  const ours = ownTable?.passthrough && rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (ours.includes('--help') || ours.includes('-h')) {
    writeStdout(verbUsageText(verb, VERBS[verb]!.actions.includes(rest[0] ?? '') ? rest[0] : undefined));
    return 0;
  }

  // WHAT A VERB DOES NOT DECLARE IS REFUSED BEFORE IT RUNS (PLAN-correct-and-find.md D7, kickoffs/s106 row 1): until
  // 1.4.0 an unknown flag was ignored, so a typo ran the verb without it and said nothing. An action the verb does not
  // have has no table, and the verb refuses it in its own words; so does an unported verb and a retired action.
  // THE TABLE EVERY BRANCH BELOW PARSES WITH: the action's own, or the global flags alone for an action the verb lacks.
  const table = ownTable ? argumentTable(verb, action) : globalTable(verb);
  // AN UNKNOWN ACTION NAMES THE ACTIONS (kickoffs/s149 row 1): a verb with actions whose bare form takes no words read
  // `library nosuch` as one word too many ("takes no words"), so the reader never learned the verb has actions at all.
  const declared = VERBS[verb]!;
  if (declared.ported && declared.actions.length && action === '' && ownTable && ownTable.positionals === 0 && !ownTable.ownRefusals && !ownTable.ownWords) {
    const wantsValue = new Set([...(table.valued ?? []), ...(table.repeatable ?? [])]);
    let word: string | undefined;
    for (let index = 0; index < tail.length; index += 1) {
      const item = tail[index]!;
      if (item.startsWith('-')) {
        if (item.startsWith('--') && wantsValue.has(item.substring(2))) index += 1;
        continue;
      }
      word = item;
      break;
    }
    if (word !== undefined) refuse(`deskpost ${verb} has no action '${word}'. It has: ${declared.actions.join(', ')}. Nothing was run.`);
  }
  if (VERBS[verb]!.ported && ownTable) {
    const command = `deskpost ${verb}${action ? ` ${action}` : ''}`;
    const refusal = checkArguments(command, tail, table);
    if (refusal !== null) refuse(refusal);
    for (const warning of quoteWarnings(command, tail, table)) process.stderr.write(warning + '\n');
  }

  switch (verb) {
    case 'verbs': {
      emit(verbInventory() as PsJsonValue, true);
      return 0;
    }

    case 'init': {
      const parsed = parseArguments(rest, table);
      // `--force` IS GONE (F9): it was parsed and did nothing, while its name promised an overwrite init never does.
      if (parsed.flags.has('force')) {
        refuse('library init has no --force: init already brings a Library\'s managed files up to date, and refuses, naming the file, whatever it cannot merge. Run it again without --force.');
      }
      // `--help` PRINTS USAGE, AND ANY OTHER FLAG INIT DOES NOT TAKE IS REFUSED BEFORE A WRITE (the Report Inbox's S61
      // note). The parser files an undeclared `--name` as a flag, so `init --help` used to make the working directory a
      // Library; and a word starting `-` is a mistyped flag (`-h`), never a folder to initialise.
      if (parsed.flags.has('help') || parsed.positional.some((word) => word === '-h' || word === '-?' || word === '/?')) {
        process.stdout.write(`${VERBS.init!.summary}\n\nUsage: ${VERBS.init!.usage}\n`);
        return 0;
      }
      const unknown = [...parsed.flags].filter((name) => !(table.boolean ?? []).includes(name));
      if (unknown.length) {
        refuse(`library init has no ${unknown.map((name) => `--${name}`).join(', ')}; nothing has been written. It takes: ${VERBS.init!.usage}`);
      }
      if (parsed.positional.some((word) => word.startsWith('-'))) {
        refuse(`library init has no option '${parsed.positional.find((word) => word.startsWith('-'))}'; nothing has been written. It takes: ${VERBS.init!.usage}`);
      }
      if (parsed.positional.length > 1) {
        refuse(`library init takes one folder, and was given ${parsed.positional.length}: ${parsed.positional.join(' ')}. Nothing has been written.`);
      }
      const folder = parsed.positional[0] ?? parsed.options.get('workspace') ?? process.cwd();
      const { result, written } = runLibraryInit({
        workspacePath: folder,
        mcpUrl: parsed.options.get('mcp-url'),
        collectionId: parsed.options.get('collection-id'),
        writable: parsed.flags.has('writable'),
        registryRoot: parsed.options.get('registry-root'),
        programRoot: programRoot(),
      });
      // LINES FOR A PERSON, THE DOCUMENT WITH --json (F7): until 1.1 `--json` was a no-op and a person got the document.
      emit(result as PsJsonValue, parsed.flags.has('json'), initText(result, written));
      return 0;
    }

    case 'checkpoint': {
      try {
        const result = runCheckpointVerb(rest);
        emit(result.value, true);
        return 0;
      } catch (error) {
        refuse((error as Error).message);
      }
    }

    case 'desk': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        // THE RESOLVER'S REFUSAL IS PASSED ON, NOT RESTATED, with the verb in front of it exactly as
        // `library.ps1` writes it. It already names the three routes and the command that creates a
        // workspace, and a second wording of that would drift from it.
        refuse(`library desk : ${(error as Error).message}`);
      }
      // THE BARE VERB IS THE OVERVIEW, which is what a reader asking "what is on my desk" types. An
      // action word in the first slot is a WRITE, and everything after it is that write's subject.
      const action = parsed.positional[0] ?? '';
      try {
        if (action === '') {
          emit(deskOverview({ workspace, seat: parsed.options.get('seat') }) as PsJsonValue, true);
          return 0;
        }
        if (!['open', 'close', 'clear'].includes(action)) {
          refuse(`library desk has no action '${action}'. It has: clear, close, open, or no action at all for the overview.`);
        }
        // THE DEFAULTS ARE THE POWERSHELL HELPER'S DEFAULTS, deliberately, down to `clear` echoing a
        // Book and the shared collection it never consulted. Two CLIs whose unstated arguments mean
        // different things are two CLIs, and the matrix compares what each one reports it did.
        // NO LOCATION IS THE LIBRARY'S OWN COLLECTION (PLAN-basic-memory.md step 1); `shared` on a local Library
        // is its Basic Memory connection once one is set up.
        const locationWord = parsed.options.get('location');
        if (locationWord !== undefined && !['shared', 'shelf', 'collection'].includes(locationWord.toLowerCase())) {
          refuse(`library desk --location is collection, shelf or shared; got '${locationWord}'.`);
        }
        const location = locationWord?.toLowerCase() as 'shared' | 'shelf' | 'collection' | undefined;
        const shelf = (parsed.options.get('shelf') ?? 'active') as 'active' | 'archive';
        // A KIND OTHER THAN book OR project IS REFUSED BY NAME (PLAN-one-step-upgrade.md small fix 1): `desk open widget
        // foo` opened Project `foo`, silently on Basic Memory, because every word but `book` read as a Project.
        const kindWord = parsed.positional[1];
        if (action !== 'clear' && kindWord !== undefined && !['book', 'project'].includes(kindWord)) {
          const slugWord = parsed.positional[2] ?? kindWord;
          refuse(`library desk ${action} takes book or project, not '${kindWord}'. Did you mean \`deskpost desk ${action} book ${slugWord}\`? Nothing was changed.`);
        }
        const kind = (kindWord ?? 'book') as 'book' | 'project';
        const result = deskWrite({
          workspace,
          action: action as 'open' | 'close' | 'clear',
          kind,
          location,
          shelf,
          slug: parsed.positional[2] ?? '',
          seat: parsed.options.get('seat'),
          claimToken: parsed.options.get('claim-token'),
        });
        emit(result as PsJsonValue, true);
        return 0;
      } catch (error) {
        refuse((error as Error).message);
      }
    }

    case 'dashboard': {
      const parsed = parseArguments(rest, table);
      try {
        const watch = parsed.flags.has('watch');
        const seat = parsed.options.get('seat');
        if (watch && !seat?.trim()) refuse('deskpost dashboard --watch needs --seat <name>: the pane never chooses a seat.');
        if (watch && parsed.flags.has('json')) refuse('deskpost dashboard --json is a one-shot read; use --watch without --json.');
        const interval = parsed.options.get('interval-seconds') ?? '5';
        if (!/^\d+$/.test(interval) || Number(interval) < 2 || Number(interval) > 60) refuse('deskpost dashboard --interval-seconds must be a whole number from 2 to 60.');
        const iterations = parsed.options.get('iterations');
        if (iterations !== undefined && (!/^\d+$/.test(iterations) || !Number.isSafeInteger(Number(iterations)) || Number(iterations) < 1)) refuse('deskpost dashboard --iterations needs a positive whole number.');
        if (!watch && (parsed.options.has('interval-seconds') || iterations !== undefined)) refuse('deskpost dashboard --interval-seconds and --iterations need --watch.');
        const width = parsed.options.get('width');
        if (width !== undefined && (!/^\d+$/.test(width) || !Number.isSafeInteger(Number(width)))) refuse('deskpost dashboard --width needs a whole number.');
        const workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
        if (watch) {
          await watchDashboard({ workspace, seat: seat!, width: width === undefined ? undefined : Number(width), intervalSeconds: Number(interval), iterations: iterations === undefined ? undefined : Number(iterations) });
          return 0;
        }
        const overview = deskOverview({ workspace, seat });
        const { dashboardColor, dashboardWidth, readDashboardCheckpoint } = await import('./dashboard.ts');
        const now = Date.now();
        const checkpoint = readDashboardCheckpoint(workspace, overview, now);
        const color = dashboardColor(process.stdout.isTTY === true, process.env);
        emit({ ...overview, ...checkpoint } as PsJsonValue, parsed.flags.has('json'), dashboardText(overview, { width: dashboardWidth(width === undefined ? undefined : Number(width), process.stdout.columns), rows: process.stdout.rows, now, color, checkpoint: checkpoint.checkpoint }));
        return 0;
      } catch (error) {
        refuse((error as Error).message);
      }
    }

    case 'shelf': {
      // The one Shelf verb that waits on a network answer (S41), so it is dispatched before the others.
      if (rest[0] === 'duplicates') {
        try {
          emit((await shelfDuplicates(rest.slice(1))) as PsJsonValue, true);
        } catch (error) {
          refuse((error as Error).message);
        }
        return 0;
      }
      const result = runShelfVerb(rest, programRoot());
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, result.asJson, result.humanText);
      return 0;
    }

    // THE WORKSPACE IS RESOLVED HERE AND THE RESOLVER'S REFUSAL IS PASSED ON, with the verb in
    // front of it exactly as `library.ps1` writes it: it already names the three routes to a
    // workspace, and a second wording of that would drift from it.
    case 'capture': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library capture : ${(error as Error).message}`);
      }
      const result = captureVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // THE VALUED NAMES ARE THE ACTION'S OWN (its table), so `--workspace` is found wherever it sits: a value
    // that happened to be the word `--workspace` is never taken for the option.
    case 'collection': {
      // `add-page` takes values of its own (S67), which a parser valuing only `--workspace` would turn into flags
      // and stray positionals, so it is dispatched to its own module with its own names.
      const addingPage = rest[0] === 'add-page';
      const replacingPage = rest[0] === 'replace-page';
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library collection : ${(error as Error).message}`);
      }
      if (addingPage) {
        try {
          emit(collectionAddPage(rest.slice(1), workspace), true);
        } catch (error) {
          refuse((error as Error).message);
        }
        return 0;
      }
      if (replacingPage) {
        try {
          emit(collectionReplacePage(rest.slice(1), workspace), true);
        } catch (error) {
          refuse((error as Error).message);
        }
        return 0;
      }
      const result = runCollectionVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // A LOCAL LIBRARY'S BASIC MEMORY CONNECTION (PLAN-basic-memory.md): set-up, status, import, open-shared.
    case 'basic-memory': {
      const parsed = parseArguments(rest.slice(1), table);
      let workspace = '';
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        // THE ROLLBACK CHECK SCANS EVERY REGISTERED LIBRARY, so it answers from anywhere: install.ps1 runs it from no workspace.
        if (rest[0] !== 'rollback-check' || parsed.options.get('workspace') !== undefined) refuse(`library basic-memory : ${(error as Error).message}`);
      }
      const result = await runBasicMemoryVerb(rest, workspace, BASIC_MEMORY_ACTIONS);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'hub':
    case 'shared':
    case 'publish': {
      const parsed = parseArguments(rest.slice(verb === 'publish' ? 0 : 1), table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library ${verb} : ${(error as Error).message}`);
      }
      if (verb === 'hub' && action === 'history') {
        try {
          const history = await hubHistory(tail, workspace);
          emit(history.value, parsed.flags.has('json'), history.text);
          return 0;
        } catch (error) { refuse((error as Error).message); }
      }
      const result =
        verb === 'hub' ? await runHubVerb(rest, workspace) : verb === 'shared' ? await runSharedVerb(rest, workspace) : await runPublishVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'book': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library book : ${(error as Error).message}`);
      }
      const result = runBookVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // THE AUDIT RECORD (kickoffs/s112 ruling 5): `revision`, `record` and `due`, lines for a person, the document with --json.
    case 'audit': {
      if (!['revision', 'record', 'due'].includes(action)) refuse(`library audit has no action '${rest[0] ?? ''}'. It has: due, record, revision.`);
      const parsed = parseArguments(tail, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library audit : ${(error as Error).message}`);
      }
      try {
        const result = auditVerb(action, {
          workspace,
          target: parsed.positional[0],
          revision: parsed.options.get('revision'),
          findings: parsed.options.get('findings'),
          report: parsed.options.get('report'),
          days: parsed.options.get('days'),
        });
        emit(result.value, parsed.flags.has('json'), result.text);
      } catch (error) {
        refuse((error as Error).message);
      }
      return 0;
    }

    // A KICKOFF BETWEEN OFFICES (kickoffs/s159 rows 2 and 3): `send` and `receive`, read from the words after it.
    case 'kickoff': {
      if (action !== 'send' && action !== 'receive') refuse(`library kickoff has no action '${rest[0] ?? ''}'. It has: receive, send.`);
      const parsed = parseArguments(tail, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library kickoff : ${(error as Error).message}`);
      }
      try {
        const result = action === 'send'
          ? kickoffSend({ page: parsed.positional[0] ?? '', library: parsed.options.get('library') ?? '', forSeat: parsed.options.get('for') ?? '' }, workspace)
          : await kickoffReceive({ letter: parsed.positional[0] ?? '' }, workspace);
        emit(result, true);
      } catch (error) {
        refuse((error as Error).message);
      }
      return 0;
    }

    // A SEAT'S OWN MAIL (kickoffs/s108 ruling 2; kickoffs/s120 row 3): `list` and `close`, read from the words after it.
    case 'letters': {
      if (action !== 'close' && action !== 'list') refuse(`library letters has no action '${rest[0] ?? ''}'. It has: list, close.`);
      const parsed = parseArguments(tail, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library letters : ${(error as Error).message}`);
      }
      if (action === 'list') {
        const listed = lettersListVerb(tail, workspace);
        if (listed.refusal !== null) refuse(listed.refusal);
        emit(listed.value!, parsed.flags.has('json'), listed.text);
        return 0;
      }
      const result = lettersCloseVerb(tail, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // A SEAT'S OWN REPORT (kickoffs/s130 row 2; ADR-0083): `amend` and `withdraw`, read from the words after it.
    case 'reports': {
      if (action !== 'amend' && action !== 'list' && action !== 'send-pending' && action !== 'withdraw' && action !== 'triager') refuse(`library reports has no action '${rest[0] ?? ''}'. It has: ${VERBS['reports']!.actions.join(', ')}.`);
      const parsed = parseArguments(tail, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library reports : ${(error as Error).message}`);
      }
      if (action === 'list') {
        const listed = reportsListVerb(tail, workspace);
        if (listed.refusal !== null) refuse(listed.refusal);
        emit(listed.value!, parsed.flags.has('json'), listed.text);
        return 0;
      }
      const result = action === 'send-pending' ? (await import('./capture.ts')).reportsSendPendingVerb(tail, workspace) : action === 'triager' ? await reportsTriagerVerb(tail, workspace) : reportsVerb(action, tail, workspace);
      // Let the asynchronous transport drain before exiting on a triager refusal (Windows/libuv).
      if (action === 'triager' && result.refusal !== null) {
        process.stderr.write(hostRemedies(result.refusal) + '\n');
        return 1;
      }
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'raw': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library raw : ${(error as Error).message}`);
      }
      const action = parsed.positional[0] ?? '';
      const result =
        action === 'search'
          ? runRawSearch(rest, workspace)
          : action === 'owners'
            ? runRawOwners(rest, workspace)
            : { refusal: `library raw has no action '${action}'. It has: owners, search.`, value: null };
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // WHAT WAITS ON ERIC (kickoffs/s161 row 4): the five sections, read from the Library's files.
    case 'needs-you': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library needs-you : ${(error as Error).message}`);
      }
      try {
        const needs = readNeedsYou(workspace);
        if (parsed.flags.has('write')) {
          const done = writeNeedsYou(workspace, needs);
          if (done.status === 'refused') refuse(`The page ${done.path} was not written: ${done.reason}. Nothing was written.`);
          emit({ schema: 1, operation: 'Write the needs-you page', workspace, status: done.status, path: done.path } as PsJsonValue, parsed.flags.has('json'),
            done.status === 'written' ? `Wrote ${done.path}.` : `${done.path} already says this; nothing was written.`);
          return 0;
        }
        emit({ schema: 1, operation: 'Needs you', workspace, sections: needs.sections, problems: needs.problems } as unknown as PsJsonValue, parsed.flags.has('json'), needsYouText(needs));
      } catch (error) {
        refuse((error as Error).message);
      }
      return 0;
    }

    // THE VAULT CONNECTION (kickoffs/s161 row 1): `connect`, `disconnect` and `status`, read from the words after it.
    case 'vault': {
      if (action !== 'connect' && action !== 'disconnect' && action !== 'status') refuse(`library vault has no action '${rest[0] ?? ''}'. It has: connect, disconnect, status.`);
      const parsed = parseArguments(tail, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library vault : ${(error as Error).message}`);
      }
      try {
        const result = vaultVerb(action, workspace, {
          folder: parsed.positional[0],
          preflight: parsed.flags.has('preflight'),
          userConfirmed: parsed.flags.has('user-confirmed'),
          planId: parsed.options.get('plan-id'),
        });
        emit(result.value, parsed.flags.has('json') || action !== 'status', result.text);
      } catch (error) {
        refuse((error as Error).message);
      }
      return 0;
    }

    case 'triage': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library triage : ${(error as Error).message}`);
      }
      const result = runTriageVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'notebook': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library notebook : ${(error as Error).message}`);
      }
      const result = runNotebookVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // THE REPORT IS PRINTED WHATEVER THE EXIT CODE, because a failed check is part of the outcome rather
    // than a crash: exit 1 with the report, exactly as the runner it ports.
    case 'doctor': {
      const result = runDoctor(rest, programRoot());
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, rest.includes('--json'), doctorText(result.value as Record<string, unknown>));
      return result.exitCode;
    }

    // WHAT THE LIBRARY HOLDS, seatless and offline (PLAN-correct-and-find.md D5): the data the menu's `l` renders.
    case 'browse': {
      const result = runBrowseVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, rest.includes('--json'), result.humanText);
      return 0;
    }

    // THE INSTALLER'S CONVERSATION, ITS PLANNER AND ITS APPLY, and a Library made later (PLAN-install-onboarding.md, ADR-0057).
    // THE MAIN MENU BY NAME, which is also how a suite reaches it with scripted answers (ADR-0059).
    case 'menu': {
      const result = await runMenuVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      return result.exitCode;
    }

    // WHICH LIBRARY BARE `deskpost` OPENS (step 5a): the list, and `default <folder>`.
    case 'library': {
      // FORGET (kickoffs/s146 row 1) is the registry's own writer, so it lives beside the registry, not the menu.
      if (rest[0] === 'forget') {
        const parsed = parseArguments(rest, table);
        const forgot = forgetLibrary({
          target: parsed.positional[1],
          registryRoot: parsed.options.get('registry-root'),
          preflight: parsed.flags.has('preflight'),
          confirmed: parsed.flags.has('user-confirmed'),
          planId: parsed.options.get('plan-id'),
        });
        if (forgot.refusal !== null) refuse(forgot.refusal);
        emit(forgot.value!, rest.includes('--json'), forgot.humanText);
        return 0;
      }
      const result = runLibraryVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, rest.includes('--json'), result.humanText);
      return 0;
    }

    // A LIBRARY'S PLACE IN THE POSTBOX (kickoffs/s121 row 9): setup writes to a server only on its plan id's yes.
    case 'postbox': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library postbox : ${(error as Error).message}`);
      }
      const result = await runPostboxVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'setup': {
      // THE FORK AN INSTALL ENDS ON (step 5): install.ps1 runs it once the lock is released and `pending` is cleared.
      if (rest.includes('--welcome')) {
        const welcome = await runWelcomeVerb(rest);
        if (welcome.refusal !== null) refuse(welcome.refusal);
        return welcome.exitCode;
      }
      const result = await runSetupVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      if (result.value !== null) emit(result.value, result.asJson, result.humanText);
      else if (result.humanText) writeStdout(result.humanText);
      return result.exitCode;
    }

    // INSTALL WITHOUT POWERSHELL (PLAN-install-without-powershell.md, ADR-0066): the bootstrap, or with --extracted the installer.
    case 'install': {
      const result = await installVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      return result.exitCode;
    }

    case 'upgrade': {
      const result = await upgradeVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      return result.exitCode;
    }

    case 'finish-uninstall': {
      if (process.platform !== 'win32') refuse('library finish-uninstall finishes a Windows uninstall; it is started by `deskpost uninstall` and never run by hand.');
      const result = runFinishUninstall(rest);
      if (result.refusal !== null) refuse(result.refusal);
      return result.exitCode;
    }

    case 'process': {
      const result = await runProcessVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // AN INSTALL'S LIFE AFTER IT IS MADE (PLAN-install-onboarding.md step 8, ADR-0058).
    case 'uninstall':
    case 'rollback': {
      if (process.platform !== 'win32') refuse(`library ${verb} is for a Windows install in 1.1; on macOS and Linux, install.sh --rollback switches back, and removing ~/.local/share/deskpost and its link removes it.`);
      const result = verb === 'uninstall' ? await uninstallVerb(rest) : await rollbackVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      if (result.value !== null) emit(result.value, result.asJson, result.humanText);
      else if (result.humanText) writeStdout(result.humanText);
      return result.exitCode;
    }

    case 'compile': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library compile : ${(error as Error).message}`);
      }
      const result = runCompileVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'reset': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library reset : ${(error as Error).message}`);
      }
      const result = runResetVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'migrate': {
      const parsed = parseArguments(rest, table);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library migrate : ${(error as Error).message}`);
      }
      const result = runMigrateVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'seat': {
      // `seat hold` is the claim holder `seat enter` spawns: it prints nothing and its exit code is
      // the whole of what it says, so it is returned rather than emitted.
      return await runSeatVerb(rest, (value, humanText) => emit(value, humanText === undefined, humanText), refuse);
    }

    case 'hook': {
      // A GUARD'S STDOUT IS ITS WHOLE ANSWER and its exit code is 0 whatever it decided: a deny is a
      // document, an allow is silence. Only a call that names no guard is a refusal.
      const result = runHookVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      if (result.stdout) writeStdout(hostHookOutput(result.stdout));
      return 0;
    }

    case 'mcp': {
      const result = await runMcpVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      // `mcp serve` answers on stdout as it runs, and has no one result to emit when stdin closes.
      if (result.value !== null) emit(result.value, true);
      return result.exitCode;
    }

    default:
      // EVERY VERB THE MATRIX NAMES IS DECLARED, SO THIS IS WHERE THE UNPORTED ONES LAND, and they
      // refuse by name rather than exiting 0 on a command they did not run. A kernel that said
      // nothing here would compare green against an arm that had done the work.
      if (VERBS[verb]!.ported) {
        refuse(`library ${verb} is declared ported and has no dispatch branch; that is a defect in this file.`);
      }
      refuse(notPortedRefusal(verb));
  }
}

// EXPORTED FOR THE SELF-TEST, AND RUN ONLY WHEN THIS FILE IS THE ENTRY POINT. A suite that reaches a
// verb by importing its function has not tested the front door -- which is the defect S12 recorded
// against the acceptance harness itself -- so the self-test runs this file as a CHILD PROCESS and
// this guard is what lets it also import the parser without running a command.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // THE "NEEDS YOU" PAGE KEPT CURRENT (kickoffs/s161 row 6): after a verb that exited 0 and can change it; a failure is
      // one line on standard error and never this exit code.
      if (code === 0) refreshAfterCommand(process.argv.slice(2));
    })
    .catch((error: unknown) => {
      process.stderr.write(((error as Error).message ?? String(error)) + '\n');
      process.exitCode = 1;
    });
}

export { main, NO_WORKSPACE_REFUSAL, resolveWorkspace };
