# ADR-0037: A seat starts in the workspace it is a seat in

**Status:** accepted
**Date:** 2026-09-21
**Effective from:** Phase C of `PLAN-public-release.md` (step 22's "a seat opens from Orca" clause)
**Relates to:** [ADR-0027](0027-the-program-is-separate-from-the-workspace.md) (the split) and
[ADR-0036](0036-a-direct-install-registers-its-guards-from-library-init.md) (what guards the place a
reader sits)

## Context

`tools/Start-LibrarySeat.ps1` launched the agent with `& $Command`, which inherits the launcher's own
working directory. That was correct for as long as the program and the workspace were one folder.

Orca's Quick Command opens its tab **in the worktree** — the program — and passes
`-WorkspacePath D:\deskpost\workspaces\eric`. So on 2026-09-21 the first seat ever opened from that
button put the agent in `D:\deskpost\app` with `LIBRARY_WORKSPACE` naming somewhere else.

**It was guarded, and it was still wrong.** The program's own `.claude/settings.json` registers all
nine hooks, so the boundary held: a `Glob` under a closed Shelf Book was denied through real hook
dispatch, and so was an absolute `Read` under the reader's workspace root. The validated reader
connected and bound to the reader's workspace. What broke was quieter. A session takes its
instructions from the directory it is rooted in, and that directory was the program, whose
`CLAUDE.md` is the Librarian **developing** the Library and whose Desk rule is
`tools/Get-DeskOverview.ps1 -WorkspacePath .`. `.` was the program. Asked "what's on my desk?", the
session answered:

> Seat 's19-probe' has no Desk in this workspace.

A true sentence about the wrong Library, with the seat's real Desk sitting in the reader's workspace
the whole time. Phase C requires that "reset", "what's on my desk?" and a post-compaction prompt
behave as before; this is the shape in which they stop.

## Considered options

**(a) Start the agent in the workspace.** Chosen, by Eric on 2026-09-21. One line before the launch,
and the working directory then agrees with the seat, with `LIBRARY_WORKSPACE`, and with the
registrations ADR-0036 writes.

**(b) Keep the agent in the program and fix the instruction** to read `$env:LIBRARY_WORKSPACE`
instead of `.`. Rejected. It is cheaper and it treats the symptom: a reader at a seat would still
load the developer's instruction file, and the workspace's own hook registrations — the entire
subject of ADR-0036 — would be read by nothing on the one route readers actually use.

**(c) Let the root follow the seat's Project**, so development seats root in the program and reader
seats in the workspace. Rejected as a rule the launcher would have to guess by, where a wrong guess
puts a reader in the program with no sign that it has.

## Decision

`tools/Start-LibrarySeat.ps1` sets its working directory to the resolved workspace immediately before
starting the agent. Where the program and the workspace are one directory — every checkout before
step 22 — this is a no-op, which is what keeps an un-split install behaving exactly as it did.

## Consequences

- A reader's session loads the **workspace's** `CLAUDE.md`, the one `library init` manages, and
  `-WorkspacePath .` resolves to their own Library.
- The guards that run are the ones in the workspace's `.claude/settings.local.json`. That makes
  ADR-0036's registration load-bearing rather than ornamental, and it is why the malformed block
  found the same day mattered: a session rooted there had no boundary at all.
- **Claude Code asks for folder trust once**, naming the permissions `library init` wrote, the first
  time a reader sits in a new workspace. That is a one-time prompt and it names what it is approving.
- **The program's `tools/` is no longer on a relative path** from the session. Helpers are reached by
  absolute path into the program; the seated session did this unprompted and correctly. A first-class
  route for it — the `library` command the workspace instructions already name — is Phase D's
  packaging, and until it exists the workspace's own `library desk` line names something that is not
  installed.
- Doing program work still means a session rooted in the program, started without the seat launcher.
