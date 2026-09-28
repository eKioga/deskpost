# ADR-0057: Setup asks, plans and applies, and the installer only fetches

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S54, `PLAN-install-onboarding.md` step 3)
**Relates to:** [ADR-0038](0038-an-installed-library-is-rooted-at-its-current-link.md) (`current`),
[ADR-0055](0055-the-command-is-deskpost-and-the-binary-stays-library-exe.md),
[ADR-0056](0056-doctor-and-init-speak-to-a-person-and-json-is-the-machine-form.md)

## Context

1.0's installer decided everything itself. It put the program at `%LOCALAPPDATA%\deskpost` without asking, created
folders under the install root before it had checked anything, and could not make a Library at all. `init` created
the Library folder before it had judged the rest. The plan's Q1 ruling: the one-liner stays a fetcher, and the
program it fetched holds the conversation.

## Decision

- **`deskpost setup --ask --answers <file>`** is the one question and the one screen. It asks where the Library
  should live. The default is the folder run from: that folder itself when it is empty, `<folder>\Library` when it
  holds other files, the Library there when it is one, or, only when it is the Windows folder, the machine's default Library (amended S55: the Sandbox run found the default Library answering before the folder run from). It then prints the plan
  screen and takes one key. It writes nothing but the answers file, and exits 0 to go or 3 when the reader quits.
  - The program folder must be new, empty, or an install (`current.json`). An interrupted install's own leftovers
    count as empty.
  - `;`, `%`, and a name ending in a space or dot are refused in the program folder, each with its reason.
  - Another install that this terminal already runs as `deskpost` or `library` is refused, naming it.
  - The Library and the program folder must not contain each other. That is judged on physical paths, so a
    junction is seen. Keeping them together is a key (`k`) interactively, and `-AllowOverlap` otherwise.
  - The same version again is a repair, and only with `-Repair` when nobody can be asked.
  - An existing Library is used as it is unless the reader chooses `[r] repair`.
  - The first Library becomes the default. A later one does only on a yes, and an existing default is never
    replaced silently.
  - `--yes`, `DESKPOST_YES=1`, `CI`, `--json` or a stdin that is not a terminal mean no prompts. The screen is still
    printed, to stderr under `--json`.
- **`deskpost setup --plan --answers <file> --resources <tree> --register-as <root>\current --out <file>`** is `init`
  with its writes split off (`planLibraryInit`). It reads the program from `--resources` (the staged release) and
  renders every registration naming `--register-as` (the `current` that is not switched yet). It lists every file
  with its content now (hash, and the text for an undo) and the content it will hold, plus the folders to create.
  **It creates nothing, not even the Library folder.** The standard Books are planned by running the real Shelf
  writer on a scratch copy of `shelf/` and reading back what it wrote, so a planned Book is byte for byte
  `shelf new`'s. An existing Library used as it is plans no write inside it, only its registration.
- **`deskpost setup --apply --plan-file <file>`** writes exactly what the plan lists, under the **three-state rule**.
  A file still in its old state is written. One already in its new state is done (a crash hit after the write). One
  in any other state makes the whole apply refuse, naming every such file, **before anything is written**. So
  re-running an apply finishes a half-written Library. The registry is merged when the plan is applied, not frozen
  with it, because registering is the same answer however often it runs.
- **`library init` is now plan then apply** through the same two functions. The installer's planner is the same
  `init` the acceptance matrix judges, and the matrix's `workspace` rows stay green.
- **`deskpost setup [<folder>]`** on its own plans a Library against the installed program, shows it, and applies it
  on one yes (`--yes` when nobody can be asked). An existing Library needs `--repair`.

## Consequences

- Kernel self-test section 49 judges the defaults, every refusal above, the planner creating nothing and naming
  `--register-as`, the apply writing the Holding Shelf's empty folders, finishing after a lost file and refusing a
  changed one, and an existing Library untouched byte for byte.
- `install.ps1` runs these three calls against the release it fetched (step 3b, below).

## The installer's passes (step 3b)

`install.ps1` fetches and checks the release in `%TEMP%\deskpost-<guid>`. It then runs the fetched binary's
`setup --ask`, **stages** on the destination, **plans** with the staged binary, **places**, and **applies**.
- **The watched calls inherit the console.** A native command run inside a PowerShell function has its stdout
  captured, which would take the terminal away from the prompts. So `setup --ask`, `--apply` and doctor are
  started as processes on this console, each argument quoted by the `CommandLineToArgvW` rules. Under `-Json` their
  output is collected and written to stderr, and stdout carries one result.
- **The receipt, `<root>\install-receipt.json`, and the lifecycle lock `<root>\.lifecycle.lock`.**
  - The lock is opened share-nothing only to check and claim.
  - `pending` records the transaction first: id, operation, version, archive hash, owner (pid and start time),
    phase, candidate tree, and what it replaced.
  - A live owner refuses a second run. A dead one, a pid reused with another start time, or an empty owner is
    claimed under the lock.
  - A run that fails relinquishes its own owner in `finally`, so a retry in the same window can claim it.
  - On completion the transaction moves into `owned`. That list holds the version folder if this run created it,
    `current`, `current.json`, both shims, the receipt, the lock, the PATH entry if this run added it, and each
    Library with the files it created. The receipt also records `path_change`, which doctor reads for
    `-NoPathChange`.
- **Staging** copies the tree to `versions\.incoming-<txn>` and re-hashes the binary. It reuses `versions\<v>` when
  its `.archive-sha256` matches, and refuses it, naming the route, when it does not. It checks the release's
  `.inventory.json`, which `tools/Build-KernelRelease.ps1` now writes: every file with its SHA-256.
- **Place** is idempotent step by step:
  - the rename into `versions\<v>`;
  - `current` switched in four named substeps (`current.new-<txn>`, `current.old-<txn>`), judged by which names
    exist;
  - the shims;
  - PATH (raw `REG_EXPAND_SZ`, `$env:Path` in this window, a bounded `WM_SETTINGCHANGE`);
  - a tuple check through `current`.
- **Recovery is re-running the one-liner.**
  - Before the plan was frozen the only choice is **start over**. Nothing had been placed, so the staging is
    discarded and the run goes on with the release just fetched. *This departs from the plan's wording*, which
    re-fetches the pinned version: with nothing placed there is nothing the newer release could conflict with.
  - After the plan was frozen, **finish** re-runs Place and Apply from the frozen plan and the retained candidate.
  - **Undo** restores each Library file from the plan's saved text, only while it still holds this transaction's
    content, and names the rest. It also switches `current` back or removes it, removes a version folder and PATH
    entry this run added, and clears `pending`.
  - `-Resume finish|undo` decides without a prompt. Non-interactively without it, the run refuses, naming the
    transaction and both flags.
- **No `exit`.** Failures throw one line. A red doctor throws too, after the install is in place, naming
  `deskpost rollback`.
- `DESKPOST_INSTALL_FAULT_AFTER=<phase>` stops the run right after a mark, for the interruption fixtures.
- `tools/Test-InstallOnboarding.ps1` is the fixture, run by hand against a built release. It covers 17 cases, on D:
  while `%TEMP%` is on C:, and all of them pass. It never changes PATH or the real registry. PATH, SmartScreen and an
  upgrade from 1.0.0 are left to the Windows Sandbox run (step 7).
- `-Rollback` is unchanged in behaviour, keeping ADR-0054's shared-Desk preflight, and now switches `current` with
  the same four substeps. The close-your-sessions rule and `deskpost rollback` are step 4.
