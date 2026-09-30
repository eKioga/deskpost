# ADR-0061: A seat's added folders are the seat's own

**Status:** accepted
**Date:** 2026-09-30
**Effective from:** 1.2.5
**Relates to:** [ADR-0059](0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md) (`seat start`
is the one launcher), [ADR-0029](0029-the-notebook-belongs-to-the-seat.md) (a seat's material is its own),
[Seats](../seats.md)

## Context

A seat that works on files outside the Library, such as a game mod's source or a repository, needs
that folder in its session. Claude Code loads a folder's `.claude/skills` and `.claude/agents` only
when the folder is added with `--add-dir` at launch or `/add-dir` during a session. The main menu
starts every seat, and it could pass neither.

So on 2026-09-29 a reader at the `valhiem-dev` seat typed `/add-dir D:\dev\game-mods\valheim` and
accepted "remember". Claude Code wrote the folder into `permissions.additionalDirectories` in the
**workspace's** `.claude/settings.local.json`. Every seat in the Library then started with that
folder, including its decompiled game code and its helper skill: a new `deskpost-desk` session
listed it the same day. Claude Code writes that file itself, so no Deskpost hook can intercept
`/add-dir`. Four Reports followed, and the reader called per-seat folders important for developers.

## Decision

- **A seat keeps a record of its own added folders**: `.claude/seats/<seat>/added-dirs.json`,
  `{ "schema": 1, "dirs": [...] }`, written atomically, in the order the folders were added. It is the
  seat's file, like its `conversations.json`. It is not in `_registry.json`, the claim, or any plan
  id.
- **`seat start` applies it on every launch.** The main menu's resume, new and restart all call it,
  so there is one place. Each folder becomes `--add-dir <folder>`, after the conversation arguments
  and before the reader's own `--` passthrough, so explicit arguments still come last. A command that
  is neither Claude Code nor Codex gets none, and the start says so. A folder that no longer exists
  is skipped and named, never refused: the reader must still be able to sit down.
- **`deskpost seat dirs <seat> [--list] | --add <folder> | --remove <folder>`** keeps the record, and
  the main menu's `f<number>` calls the same code, showing the launch line before it saves. A folder
  must be absolute, exist and be a folder. It must not already be recorded, must not be the Library,
  inside it or around it, must not be another Library, and must not hold `"` or `%`, which the
  `cmd.exe` route to an npm-installed agent cannot pass unchanged.
- **It is ungated.** It is the seat's own launch setting. It is additive and reversible with
  `--remove`, and it changes nothing until the next launch. A plan id would guard nothing that the
  reader cannot undo in one command.
- **It is never written to workspace settings.** Anything in the workspace's `.claude/settings.json`
  or `settings.local.json` reaches every seat, which is the leak this record exists to end.
  `deskpost doctor` WARNs on an `additionalDirectories` entry there that points outside the Library,
  and names this route. It never edits the file.
- **`seat retire` archives the record** beside the Desk, with the seat's conversations, and removes
  it with the seat.
- **It is a kernel feature.** The PowerShell launcher is not extended.

## The Codex difference

Codex takes `--add-dir` too, `codex resume <id>` included (`codex resume --help`, codex-cli
0.159.2), so the same record applies. In Codex the flag makes the folder a writable sandbox root.
Whether Codex also loads skills from it is not verified, and nothing here promises it.

## Consequences

- A reader gives a folder to one seat once, from the menu or the command line, and every later
  launch of that seat has it. No other seat does.
- `/add-dir` with "remember" still writes workspace-wide settings. Deskpost cannot stop that. It can
  only make the need for it go away, and let `doctor` show it when it happens.
- Removing an existing workspace-wide entry stays the reader's job, because only the reader edits
  the settings files.
