# ADR-0056: Doctor and init speak to a person, and `--json` is the machine form

**Status:** accepted
**Date:** 2026-09-27
**Effective from:** 1.1 (S54, `PLAN-install-onboarding.md` step 2)
**Relates to:** [ADR-0050](0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md) (init keeps marker
fields), [ADR-0055](0055-the-command-is-deskpost-and-the-binary-stays-library-exe.md) (the command and doctor's
program checks)

## Context

Eric's first run of 1.0 printed a raw JSON document from `init` and from `doctor`, because `cli.ts` emitted JSON
whatever was asked and `--json` did nothing (F7). With no Library, doctor printed nine `skipped` checks and exited 0,
which reads as a pass (F4). `init --force` was parsed and did nothing, while its name promised an overwrite (F9). And
the Codex hook render `& "<path>"` let PowerShell expand `$` inside the path (#11).

## Decision

- **`doctor` and `init` print lines by default; `--json` prints the document.** Every script and every matrix row
  already passes `--json`. Doctor's lines give the program, the Library (or `none here; checked the program only`),
  then one line per check: a mark, a short name and the check's own detail. It ends with the tallies and one
  sentence saying whether anything failed. `init` says what it did, names the files it wrote, and ends with one
  `Next:` line.
- **Glyphs only where they render** (step 0, measurement 4). `✓` and `✗` are written to a terminal inside Windows
  Terminal, or off Windows. Everywhere else, and whenever stdout is not a terminal, the marks are `[ok]`, `[!]`,
  `[x]` and `[-]`. No colour is written. `DESKPOST_ASCII` forces the ASCII marks.
- **The lines name the kernel's flags** (F8): `--workspace`, not `-WorkspacePath`. An installed kernel's remedies
  already did (ADR-0045), which was verified against the 1.0 binary. The lines now do too, on every host, including
  a source run.
- **`init --force` is refused by name.** Init already brings managed files up to date, and refuses, naming the
  file, whatever it cannot merge. The flag is gone from the usage. The PowerShell oracle keeps `-Force`, and the
  matrix row judging it runs the kernel without the flag.
- **The Codex hook render on Windows is a single-quoted literal:** `& '<program>/bin/library' hook <verb>`, with a
  `'` in the path written `''`. Nothing inside single quotes expands. 1.0's double-quoted render is still recognised
  as Deskpost's, both by init's ownership test and by doctor (ADR-0055's tokenizer).
- **The registry writer keeps every field it does not set** (step 0, measurement 1). An entry's `default`, any
  unknown entry field and any unknown top-level field survive another Library's `init`, and a re-init of the same
  Library. 1.0's writer dropped them.
- **Marker fields are verified, not rebuilt.** ADR-0050 already makes init carry `writable` and every field it does
  not own. Kernel self-test section 48 now holds that as well.

## Consequences

- Kernel self-test section 48 judges the lines, the `--force` refusal, registry and marker fields surviving, doctor
  with no Library in ASCII, and the single-quoted render run through `powershell -Command` from a folder named
  `O'Neil $work`. The self-test's own doctor and init calls that parse the document now pass `--json`.
- `tools/Test-KernelUpgrade.ps1` no longer passes `--force`.
