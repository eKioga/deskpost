# ADR-0039: An independent row is judged against the kernel under test

**Status:** accepted
**Date:** 2026-09-23
**Effective from:** Phase D of `PLAN-public-release.md` (step 23's matrix, S21's closing gate; S41)
**Relates to:** [ADR-0028](0028-the-kernel-is-typescript-shipped-as-one-binary.md) (the kernel the matrix
judges) and [ADR-0038](0038-an-installed-library-is-rooted-at-its-current-link.md) (the release it is
judged as)

## Context

The acceptance matrix has two kinds of row. A **differential** row runs the PowerShell oracle and the
kernel over the same fixture and compares what each did. An **independent** row states a property that a
comparison cannot establish -- two implementations that both lose a race agree -- and names the suite
that asserts it.

S40 measured that the closing gate could not pass as built. An independent row reported `independent`,
which `-RequireGreen` counts as not green; and with `-IncludeIndependent` it fell through to the
differential arms, comparing a PowerShell TEST SUITE against a kernel command. So no independent row
could ever be green, and seventeen of the matrix's rows were independent.

A second row could not be judged at all: the duplicate-topic detector needs an embedding endpoint, and
the only one available is the reader's own inference server, whose address and key are theirs.

## Decision

**An independent row is green when its property is shown to hold for the kernel under test**, in one of
two ways, and it says which:

1. **A `judge`**: a command the harness runs with the kernel under test handed to it as `{kernel}`,
   whose exit 0 is the row's green. A judge that never names `{kernel}` is refused by the shape check,
   because it would judge whatever it judged before. A row with a judge and no kernel is `pending`.
2. **A `recorded_verdict`**, for a row only a real Claude Code or Codex session can show: a verdict a
   session recorded in `tools/acceptance-verdicts.json`, bound to the **SHA-256 of the exact release
   binary** it was judged against. A new release is a new binary, so every release is judged again. A
   kernel run from source has no binary and reads `pending`.

A row with neither stays `independent` -- not judged yet, which is not green -- and says so.

**The embedding service is the harness's own deterministic stand-in**, `tools/AcceptanceEmbeddingStandIn.mjs`,
started for the row and shared by both arms. Its vectors are integer word counts, exact in every parser.
The harness sets every row's `TEI_EMBEDDING_URL` and `TEI_API_KEY`, so no row can reach a reader's server
through a variable inherited from the shell.

## Consequences

- `-RequireGreen -IncludeIndependent -IncludeShared` can pass, and only when every judge passes against
  the release and every real-session row has a passing verdict for that release's binary.
- A judge is a program's own test run against a binary, so a judge must drive the kernel through its
  front door. The kernel self-test's `LIBRARY_SELFTEST_KERNEL` and `LIBRARY_SELFTEST_SECTIONS`, and
  `Test-NotebookMigration.ps1 -Kernel`, exist for this; a section that imports kernel modules in process
  judges the source tree and must not be named by a judge.
- What the stand-in concedes: it proves each implementation's arithmetic, order and rounding over the
  same answers, not that a real model's vectors would give the same pairs. Nothing here measures a model.
