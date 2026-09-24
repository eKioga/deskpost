# ADR-0041: `library init` lays out the Holding Shelf and the Report Inbox

**Status:** accepted
**Date:** 2026-09-23
**Effective from:** Phase D of `PLAN-public-release.md` (its "Done when": `library doctor` green after
`library init`; S42)
**Relates to:** [ADR-0036](0036-a-direct-install-registers-its-guards-from-library-init.md) (what `library init`
writes)

## Context

`library init` and then `library doctor` failed three of nine checks in every fresh workspace -- measured on
Windows and in a clean Linux distro alike: `shelf/_catalog.md` was missing (twice) and so was
`notebook/_master-index.md`. An empty catalog is not enough: `shelf.references-resolve` requires the catalog to
list the Books the program's own skills and helpers name, and they name two -- the Holding Shelf
(`Add-ShelfNote.ps1` and `Invoke-LibraryTriage.ps1` default to `-BookSlug 'holding'`, which must be
capture-enabled) and the Report Inbox (`shelf/reports`). So "save this for later" refused in a new workspace.

## Decision

**`library init` lays out both Books, empty and capture-enabled, through the helper that creates any empty Book**
(`New-ShelfBook.ps1 -Capture`, `library shelf new --capture`), renders the catalog from them, and writes the
empty master index -- whose text the layout reader counts as no material, so a fresh workspace stays fresh. In
the PowerShell oracle and the kernel alike.

- A Book already there is never touched, whatever it holds. A husk (`shelf/<slug>` with no `wiki/`) and a Shelf
  that cannot be rendered are refused with every other file, before anything is written.
- The master index is written only over an empty `notebook/`; a Notebook with anything in it keeps its own
  renderer, which a seat-owned layout never points at the root.

## Consequences

- `workspace.init-leaves-a-workspace-its-checks-pass` holds the two arms to one outcome; kernel self-test
  section 20 and the oracle's `-SelfTest` hold the outcome itself, zero failed checks, which two arms that both
  fail would share.
- Porting it found a defect no row had reached: the kernel's `shelf new --capture` wrote a curated Book's reader
  map. `shelf.new-capture-book-gets-a-capture-reader-map` now compares it.
- Every acceptance fixture is built by the real `init`, so every fixture now carries the Report Inbox, and
  `workspace-shelf` replaces init's empty Holding Shelf with its own.
