# The Notebook reset preserves the Desk; clearing it is the caller's choice

`Reset-LocalNotebook.ps1` deletes and rebuilds `notebook/` and, by default, **leaves the Virtual Desk
exactly as it is**. Every open Book and Project Hub stays open. `-ClearDesk` performs the full
**Library Reset** — Notebook and Desk together — which is what ADR-0006's vocabulary still routes
to.

This reverses the original behaviour, in which the Desk clear was unconditional and unreachable to
opt out of.

## Status

accepted — 2026-09-03.

Supersedes the *behaviour* half of ADR-0006, not its routing. "Reset", "start fresh", and "reset my
workspace" still mean the Library Reset and still never mean a Git cleanup; the Librarian reaches it
by passing `-ClearDesk`. What changed is that the helper is no longer only able to do that.

## Why the original coupling was wrong

**A primitive you cannot decompose is the wrong primitive.**
`Set-VirtualDesk.ps1 -Action Clear` already clears the Desk in one command, so Notebook-and-Desk was
always composable from two narrow verbs. Notebook-alone was not reachable at all. The build made the
impossible thing the only thing.

**The harm is asymmetric.** A Desk left open when the reader wanted it clear is visible in
`Get-DeskOverview.ps1` and undone by one command. A Desk cleared when the reader wanted it kept
destroys the record of what they had open, and nothing else holds that record — not git, not the
Notebook, not the shared collection. The recoverable mistake belongs in the default.

**The file is named `Reset-LocalNotebook.ps1`.** Clearing the Desk was never in that promise.

**And the reader's dominant case was the unreachable one.** Reported 2026-09-03: wanting a clean
Notebook while staying on the same Books is *vastly* more common than wanting both gone, and it had
never been possible. A design whose common case is the one it cannot express is not serving the
reader who has to work around it every time.

## Considered options

**A `-KeepDesk` opt-in, default unchanged.** Rejected. It leaves the dangerous behaviour as the
default and taxes the common case with a flag the reader must remember at exactly the moment they
are about to destroy something. The safer branch should not be the one you have to ask for.

**Split into two helpers.** Rejected as disproportionate. The operations share their preflight,
their advisory, their approval, and their Notebook rebuild; a second file would duplicate all of it
to vary one line.

**Ask at the approval moment which shape is wanted.** Rejected as the default, on the same reasoning
ADR-0006 used against asking: the preflight already names `desk_action` before approval, so the
reader sees which operation they are approving without being made to answer a question they have
usually already answered by their wording.

## Consequences

The preflight reports `desk_action` — `preserved` or `cleared` — beside the open-Book and
open-Project advisories, so which of the two operations is about to run is visible **before** the
reader approves rather than discovered in the result.

The result's `virtual_desk_cleared` is read from the switch rather than hardcoded `$true`, and the
run reports `open_books_after` / `open_projects_after` **read back from the state files**. Preserving
the Desk is a claim about state, so it is answered from state.

`Test-LibraryHelpers.ps1` seeds the Desk before resetting and asserts both shapes. It previously
asserted only that the Desk ended empty, against a fixture whose Desk was **already empty** — an
assertion that would have passed whichever behaviour the helper had. That is the reason this
reversal carried no failing test to discover it.

The playbook, `docs/notebook-and-desk-model.md`, the `library-help` Skill reference, and
`tools/_helpers.json` all describe the two shapes and which wording routes to which.
