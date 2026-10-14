# ADR-0077: The main menu offers access by plain name

**Status:** accepted
**Date:** 2026-10-13
**Effective from:** the release carrying c10 (planned 1.4.5)
**Relates to:** [ADR-0059](0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md),
[ADR-0076](0076-a-seat-records-its-assistant-and-approved-launch-flags.md)

## Context

The approved House Design main-menu screens replace remembered letter commands with the controls
people already use: arrows, Enter, Esc, typing, single-click to focus and double-click to choose.
Access needs a name the reader can understand before seeing its exact command settings.

## Decision

The main screen offers the most recent free conversation first, groups seats open in another window
below the free seats, and searches seats and actions immediately. Choosing a seat opens its actions.
New seats take name, installed assistant and access, followed by a ready screen. Department and
template choices remain available under More choices. A live claim is never stolen by confirmation:
after the reader confirms the other window is closed, the existing claim detector is read again and
the unchanged launcher remains the final authority.

The access names, descriptions, argv and installed-client value lists live in one module,
`kernel/src/menuaccess.ts`. The interactive screens and plain summaries read it. The existing
launch validator imports its value table; no launch behavior or record schema changes. Codex offers
Look only, Work in its own folders (usual), Full access and Type my own settings. Claude Code offers
Look only, Ask me first (usual), Edit freely, Auto mode, Full access and Type my own settings.
The mappings were checked against codex-cli 0.162.1 and Claude Code 2.1.296 at OPEN.

Full access requires typing `full`, also for typed settings that grant it. A stored full-access choice
carries `(!)` with a legend. Values are still checked by the existing flag validator and saved through
the launch-setting preflight and its exact plan id. New-seat creation approves the assistant through
the existing creation plan, creates without launch, saves the selected access for that incarnation,
and starts only after access saving succeeds. If that later step fails, the menu says what was made
and directs the reader to Settings; it does not repeat creation.

The screen engine is a pure reducer and renderer with a terminal adapter. The terminal uses its own
16 colours, ASCII marks, bounded lists and scroll counts. Raw mode, mouse reporting, bracketed paste
and cursor state are cleaned up before returning, on cancellation, and on exceptions. Text fields
turn mouse reporting off; pasted newlines never submit. Small panes, `--plain` and `--script` use
plain input. A non-terminal prints a plain roster and the existing deterministic-launch refusal.
Old scripted answers such as `n7` continue to reach the same launcher. The menu has no existing
persistent preference record; the permanent plain-mode preference is parked rather than introducing
a file format. The menu can select plain text for the current visit.

## Consequences

This supersedes ADR-0059's numbered interactive menu in part. It supersedes ADR-0076's statement
that no sandbox or approval mode is recommended or judged: the menu now names the approved usual
choices while retaining typed settings and the existing validator. The seat claim, retirement
archive, registry schema, launch-record schema and command-line settings protocol remain their
existing owners.

Sections 232-239 cover input and restoration, source screen wording at 60 columns, access mappings,
disposable creation and setting flows, and legacy scripts. Native-terminal appearance and behavior
still require the design owner's review against the approved pictures. Tests supply a fixture
registry and inputs; they do not certify a release binary or effective client configuration inherited
from an unstored user preference.
