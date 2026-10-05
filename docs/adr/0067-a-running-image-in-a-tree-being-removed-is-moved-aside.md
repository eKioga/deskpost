# ADR-0067: A running image in a tree being removed is moved aside, and its delete handed on

**Status:** accepted
**Date:** 2026-10-05
**Effective from:** 1.3.5 (built in S90, released in S91)
**Amends:** [ADR-0066](0066-the-program-installs-itself.md) (decision 2: the bootstrap may run from inside the tree
its child removes)
**Relates to:** [ADR-0065](0065-the-kernel-calls-the-finisher-and-the-release-start-no-powershell.md) (the finisher's
own delete, handed to a `cmd /c` child outside the job)

## Context

`library install` without `--extracted` is a bootstrap: it extracts the release and waits on the extracted binary,
which does the work (ADR-0066 decision 2). A reader who runs it from the installed program,
`<root>\current\bin\library.exe`, runs an image that lives in `<root>\versions\<v>`. Two recoveries remove a version
tree: an undo of an upgrade removes `versions\<new>`, and an uninstall's finish removes every version. Run that way,
each met its own caller's image: Windows refuses to delete a running executable (EPERM), so the undo threw after
`current` and `current.json` were already restored, and the uninstall's finish refused with the program half gone
(the Codex review of S89, finding 1). The forwarder runs the extracted copy, so S89's parity run never took this path.

Measured in S90 (Bun 1.4.2, Windows 11): a running image cannot be deleted, but it CAN be renamed within its volume,
after which the folder it was in removes cleanly, and the renamed file deletes as soon as the process exits.

## Decision

1. **A file in a tree being removed that cannot be deleted because it is in use is moved, not left.** The undo and the
   uninstall's finish remove a tree by deleting what they can and renaming what they cannot into `<root>\.leftover`
   (a rename, so on the same volume as the root). The tree is then removed in full, and the recovery completes.
2. **The moved file's delete is handed on**, as the finisher hands on its own (`handOffOwnDelete`): a `cmd /c` child
   started outside this process's job retries the delete once a second for up to 20 seconds, so it lands when the
   bootstrap exits, then removes `.leftover` and, after an uninstall, the root, each only when empty.
3. **It is named.** The recovery's text says that the program it ran from was still running and was moved to
   `.leftover`, and that it goes once it exits; with `--json` the result lists it as `handed_on`.
4. **The next `library install` at the root sweeps `.leftover`** under the lifecycle lock, so a hand-off that could not
   start, or a file still running past its 20 seconds, is finished by the next run.

## Alternatives considered

- **The bootstrap re-runs itself from a temp copy when its image is under the root.** Windows has no `exec`: the
  original must wait on the copy to relay its console and exit code, so the original image stays running inside the
  tree. Exiting early instead would hand the caller an exit code before the work was done.
- **Refuse a recovery run from the installed program.** The reader's natural command after an interrupted upgrade is
  the installed one; a refusal would send them to download the release again for no reason.
- **Leave the version and name it.** It leaves a version tree that `current` does not name and nothing would ever
  remove, and an undo that reports success with part of its work left.

## Consequences

- A recovery run from the installed program completes in one run. Self-test section 134 proves both paths through
  the bootstrap, and that no `library.exe` is left running.
- `<root>\.leftover` may exist for up to 20 seconds after such a run, or until the next install. Nothing reads it.
- The finisher's own path is unchanged: it already runs from a `%TEMP%` copy.
