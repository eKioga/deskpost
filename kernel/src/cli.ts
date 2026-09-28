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
import { invokeLibraryWorkspaceInit } from './init.ts';
import { deskOverview, deskWrite } from './desk.ts';
import { runShelfVerb } from './shelf.ts';
import { shelfDuplicates } from './duplicates.ts';
import { captureVerb, runBookVerb } from './capture.ts';
import { runRawSearch } from './rawsearch.ts';
import { runRawOwners } from './rawowners.ts';
import { runTriageVerb } from './triage.ts';
import { runNotebookVerb } from './notebookverb.ts';
import { runResetVerb } from './reset.ts';
import { runCompileVerb } from './compile.ts';
import { runMigrateVerb } from './migrate.ts';
import { runDoctor } from './doctor.ts';
import { runSeatVerb } from './seat.ts';
import { runHubVerb, runPublishVerb, runSharedVerb } from './collection.ts';
import { runCollectionVerb } from './ownership.ts';
import { runMcpVerb } from './reader.ts';
import { runHookVerb } from './guards.ts';
import { psConvertToJson, type PsJsonValue } from './psjson.ts';
import { NO_WORKSPACE_REFUSAL, requireWorkspace, resolveWorkspace } from './workspace.ts';
import { parseArguments } from './argv.ts';
import { programRoot, releaseTuple } from './programroot.ts';
import { notPortedRefusal, usageText, verbInventory, VERBS } from './verbs.ts';
import { hostRemedies, hostRemedyFields, REMEDY_HOST } from './remedy.ts';
import { runBasicMemoryVerb } from './bmconnection.ts';
import { BASIC_MEMORY_ACTIONS } from './bmactions.ts';
import { doctorText, initText } from './human.ts';
import { runSetupVerb } from './setup.ts';
import { rollbackVerb, uninstallVerb } from './lifecycle.ts';
import { menuIsInteractive, runLibraryVerb, runMenuVerb, runWelcomeVerb } from './menu.ts';


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
  // BARE `deskpost` IS THE MAIN MENU (ADR-0059), where a person can answer; anywhere else it prints usage, as before,
  // so a caller that cannot be prompted never waits.
  if (argv.length === 0 && menuIsInteractive()) {
    const result = await runMenuVerb([]);
    if (result.refusal !== null) refuse(result.refusal);
    return result.exitCode;
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
      `library has no command '${verb}'. It has: ${Object.keys(VERBS).sort().join(', ')}. ` +
        'Run `library help` for what each one does.',
    );
  }

  switch (verb) {
    case 'verbs': {
      emit(verbInventory() as PsJsonValue, true);
      return 0;
    }

    case 'init': {
      const parsed = parseArguments(rest, ['registry-root', 'collection-id', 'mcp-url', 'workspace']);
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
      const unknown = [...parsed.flags].filter((name) => !['writable', 'json'].includes(name));
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
      const result = invokeLibraryWorkspaceInit({
        workspacePath: folder,
        mcpUrl: parsed.options.get('mcp-url'),
        collectionId: parsed.options.get('collection-id'),
        writable: parsed.flags.has('writable'),
        registryRoot: parsed.options.get('registry-root'),
        programRoot: programRoot(),
      });
      // LINES FOR A PERSON, THE DOCUMENT WITH --json (F7): until 1.1 `--json` was a no-op and a person got the document.
      emit(result as PsJsonValue, parsed.flags.has('json'), initText(result));
      return 0;
    }

    case 'desk': {
      const parsed = parseArguments(rest, ['seat', 'workspace', 'location', 'shelf', 'claim-token']);
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
        const kind = (parsed.positional[1] ?? 'book') as 'book' | 'project';
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
      const parsed = parseArguments(rest, ['title', 'body', 'content-path', 'tags', 'source-paths', 'source-project', 'require-note-file', 'workspace', 'seat']);
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

    // THE VALUED NAMES ARE EVERY ACTION'S, so `--workspace` is found wherever it sits: a `--section Now`
    // read as a flag would make `Now` positional and move nothing else, but a value that happened to be
    // the word `--workspace` would be taken for the option.
    case 'collection': {
      const parsed = parseArguments(rest, ['workspace']);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library collection : ${(error as Error).message}`);
      }
      const result = runCollectionVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    // A LOCAL LIBRARY'S BASIC MEMORY CONNECTION (PLAN-basic-memory.md): set-up, status, import, open-shared.
    case 'basic-memory': {
      const parsed = parseArguments(rest.slice(1), ['url', 'collection', 'storage', 'workspace', 'seat', 'plan-id', 'lock-timeout', 'claim-token', 'shelf', 'registry-root']);
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
      const parsed = parseArguments(rest.slice(verb === 'publish' ? 0 : 1), [
        'title', 'purpose', 'next-action', 'workspace', 'mode', 'section', 'match-text', 'content', 'content-path', 'page',
        'seat', 'plan-id', 'lock-timeout', 'summary', 'kind', 'collection', 'book-slug', 'topics', 'plan',
        'source', 'include-page', 'destination-directory', 'book-version', 'reason',
      ]);
      let workspace: string;
      try {
        workspace = requireWorkspace({ explicit: parsed.options.get('workspace') });
      } catch (error) {
        refuse(`library ${verb} : ${(error as Error).message}`);
      }
      const result =
        verb === 'hub' ? await runHubVerb(rest, workspace) : verb === 'shared' ? await runSharedVerb(rest, workspace) : await runPublishVerb(rest, workspace);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, true);
      return 0;
    }

    case 'book': {
      const parsed = parseArguments(rest, ['title', 'body', 'content-path', 'topic', 'source-path', 'page-prefix', 'workspace', 'seat']);
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

    case 'raw': {
      const parsed = parseArguments(rest, ['max-results', 'workspace', 'mcp-url', 'collection-id']);
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

    case 'triage': {
      const parsed = parseArguments(rest, ['actions', 'capture-date', 'workspace']);
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
      const parsed = parseArguments(rest, ['seat', 'scope', 'workspace']);
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

    // THE INSTALLER'S CONVERSATION, ITS PLANNER AND ITS APPLY, and a Library made later (PLAN-install-onboarding.md, ADR-0057).
    // THE MAIN MENU BY NAME, which is also how a suite reaches it with scripted answers (ADR-0059).
    case 'menu': {
      const result = await runMenuVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      return result.exitCode;
    }

    // WHICH LIBRARY BARE `deskpost` OPENS (step 5a): the list, and `default <folder>`.
    case 'library': {
      const result = runLibraryVerb(rest);
      if (result.refusal !== null) refuse(result.refusal);
      emit(result.value!, rest.includes('--json'), result.humanText);
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
      const parsed = parseArguments(rest, [
        'topic', 'topic-title', 'topic-overview', 'article-slug', 'content-path', 'source-file', 'seat', 'allow-host', 'plan-id', 'workspace',
      ]);
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
      const parsed = parseArguments(rest, ['seat', 'plan-id', 'workspace', 'quarantine', 'topic']);
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
      const parsed = parseArguments(rest, ['assign', 'set-aside', 'plan-id', 'seat', 'workspace', 'fault-after']);
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
      return await runSeatVerb(rest, (value) => emit(value, true), refuse);
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
    })
    .catch((error: unknown) => {
      process.stderr.write(((error as Error).message ?? String(error)) + '\n');
      process.exitCode = 1;
    });
}

export { main, NO_WORKSPACE_REFUSAL, resolveWorkspace };
