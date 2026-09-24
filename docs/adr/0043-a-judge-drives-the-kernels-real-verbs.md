# ADR-0043: A judge drives the kernel's real verbs, and the kernel does not judge itself

**Status:** accepted
**Date:** 2026-09-24
**Effective from:** Phase D of `PLAN-public-release.md` (S21's groups (3)-(5); S43)
**Decided by:** the Librarian, working through S43 while the reader was away and had said to go with its
recommendations and keep questions for the next session. Each decision rests on a measurement made in S43
and is recorded so the reader can overrule it.
**Relates to:** [ADR-0039](0039-an-independent-row-is-judged-against-the-kernel-under-test.md) (the judge and
the recorded verdict), [ADR-0018](0018-a-seat-binds-to-a-conversation-by-verified-process-identity.md) (the seat
claim), [ADR-0030](0030-a-collection-has-one-layout-and-two-backends.md) (collection ownership)

## Context

Ten independent rows had no judge (S40's groups (3)-(5)). Four named `library selftest <action>`, a verb
declared and never ported; one named `library collection owner`, unported; one named `library triage resume`,
unported; one named a PowerShell suite with no publication resume in it and a kernel command neither
implementation has; three named PowerShell suites that drive PowerShell only.

## Decision

1. **A judge drives the kernel's real verbs from outside, and `library selftest` is not ported for these
   rows.** A kernel that answered `library selftest concurrency` would be asked whether it is right by
   itself, and a defect it shares with its own check would pass. Kernel self-test sections 25-33 run the
   kernel under test (`LIBRARY_SELFTEST_KERNEL`) through `seat`, `desk`, `reset`, `collection owner`,
   `capture`, `book add-page`, `shelf rename`, `compile`, `hub edit` and `triage batch`, and import nothing
   from the kernel's own claim, lock or journal code. The four rows' kernel steps now name the verb their
   judge drives; `selftest` keeps only the three actions the recorded-verdict harness rows name.
2. **Where a race decides the property, the judge makes the race certain.** A Book lock is a file made by
   exclusive create, so a judge holds it itself and starts the writers behind it: a writer that takes no lock,
   or reads its prior state before taking it, is caught every time, where writers merely started together
   serialise by accident of start-up. Where no gate exists -- ownership's create -- the read window is widened
   and the round repeated, and the detection rate was measured (6 of 6).
3. **The kernel's atomic write retries a refused rename, jittered.** Section 31 found every fourth replacement
   of a page failing with EPERM while another process read it: Windows refuses a rename over a file any process
   holds open, the oracle retries eight times, and the port renamed once. It now retries eight times; and the
   pause is jittered (60-180 ms) where the oracle's is a fixed 120 ms, because a periodic reader was measured
   to stay in phase with a fixed retry and refuse all eight attempts of one write in ten. The oracle's
   `File.Replace` fallback has no Node spelling and is not ported: a holder that shares Delete and never lets
   go is refused where the oracle would have written.
4. **`library triage batch` is the runner, ported for the local kinds** -- review, holding, notebook,
   shelf-book, discard -- with the oracle's state machine, batch id and journal; a project or book action is
   refused by name, as are the single-note surface and a stored plan by path. A resume is the same `--actions`
   run again. Porting it found an oracle defect, fixed there first with a regression: the write-set gate
   refused a Notebook action's master index and an existing topic's index, which the action never creates, so
   since ADR-0041 every triage to the Notebook refused.
5. **The publication resume row is two differential rows over a genuinely interrupted publication.** The
   harness gained two seed steps: `collection_delete`, and `expect_failure` on a script step, which must stop
   and say the stated text. A real publisher is stopped at a page it did not write, the page is removed, and
   each arm's next publish must resume -- or, with the page left in place, refuse it.

6. **On Linux a zombie is not a running agent.** Sections 25-27, run in the clean distro, found an agent that
   had exited but was not yet reaped by its parent still holding its seat: its pid, `/proc` entry and start time
   all survive until the reap. The kernel now reads a `/proc/<pid>/stat` state of `Z` as gone.

## Consequences

- Kernel self-test sections 19-31 run in the clean distro against the Linux release; 32 and 33 inject their faults
  by making a file read-only, which root ignores, so they judge on Windows.
- Every row of the matrix now has a comparison, a judge or a recorded verdict. What stands between S21 and its
  criterion is the four recorded verdicts, which only a real session can give, and the release-candidate run.
- The harness normalises stderr by cutting the error-record decoration, joining PowerShell's character-wrapped
  lines with nothing, and only then replacing path tokens; a failure row naming a long path would otherwise
  differ by the host's width. Every failure row is measured under the new order by the offline matrix, and the
  shared rows by the release candidate's full run.
- Conceded: triage to a Project or a new shared Book is not ported; `-CaptureDate` other than today makes a
  holding action refuse in both arms, because the child names the note by today's date; an action that
  rewrites its own source cannot be resumed past, the oracle's rule; the atomic write's `File.Replace`
  fallback is not ported.
