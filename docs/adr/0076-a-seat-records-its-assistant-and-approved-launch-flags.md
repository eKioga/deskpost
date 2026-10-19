# ADR-0076: A seat records its assistant and approved launch flags

**Status:** accepted
**Superseded in part by ADR-0077:** [The main menu offers access by plain name](0077-the-main-menu-offers-access-by-plain-name.md).
**Date:** 2026-10-12
**Effective from:** the release that carries c5 (planned 1.4.4)
**Relates to:** [ADR-0059](0059-bare-deskpost-is-the-main-menu-and-seat-start-is-its-one-launcher.md),
[ADR-0061](0061-a-seats-added-folders-are-the-seats-own.md)

## Context

A Codex seat needed a pasted terminal command because the main menu remembered conversations but not the
reader's assistant and launch flags. A shared Codex daemon could also separate a launched session from the
launcher's seat claim. Eric signed off PLAN-codex-seats-menu.md r7 on 2026-10-11; c5 builds steps 1–13.

## Decision

A seat records its assistant and per-assistant argv in launch.json beside added-dirs.json. Strict schema 1 binds
the record to its seat_id. Empty argv requires null approval; nonempty argv requires an approval naming its
plan id, UTC time and argv digest. Invalid records contribute no assistant or flags, are named at launch,
and receive a doctor WARN with the reset route.

seat start and settings previews use one pure planner. Explicit executable, classification and conversation
requests take precedence; the saved assistant takes precedence over a caller's fallback. A numbered menu
entry starts a new conversation when its recorded owner's assistant differs from the saved assistant,
and the row says so first. Every Codex launch receives --no-daemon. A saved assistant absent from this
machine is refused by name. Every human launch prints escaped argv and the stored flags' approval.

seat settings sets the assistant instantly. Every flag mutation, including clear and whole-record reset,
requires a preview and its exact plan id. The id hashes canonical JSON containing the operation, scope,
seat, incarnation, current file digest and proposed semantic record. Generated approval id and UTC are
filled after validation; the untouched assistant's approval is retained. Malformed readable bytes can be
reset under their digest; unreadable bytes receive no plan id. Modes cannot be combined.

The approval is a protocol, not an authority: it binds the supplied preview to the applied state, and
detects stale previews. A process with the same operating-system user can still write a record itself.
Visibility at launch and the record's integrity check do not prove that a person approved it.

Writes merge under the registry lock and recheck liveness, incarnation and rename barriers. The launcher
always re-reads the record and incarnation under that lock and launches only the resulting plan.
Retirement archives the record; rename carries it; a reused name never inherits another incarnation's record.

## Consequences

Use s<number> once per existing Codex seat to choose Codex and its flags. The settings screen copies flags
only from a named live seat with a valid record, and approves the destination separately. The wizard and
help seat save their assistant under the wrapped creation approval and store no flags. A failed record
write leaves a created seat usable and names s<number> to finish its setting.

The flag table reserves conversation, name, folders, root, guard loading and claim ownership to the launcher.
Unknown bare options or --x=value remain the reader's choice; no sandbox or approval mode is recommended
or judged. Release rehearsal checks the table against the installed clients. Sections 221–223 prove the
record, CLI, settings and menu contracts; a real-client fixture proof and the release rehearsal complement them.

## C8 amendment: guard-loading values (2026-10-12)

The launcher reserves Codex config roots `hooks`, `mcp_servers`, `plugins`, `features`, `profiles`,
`profile` and `shell_environment_policy`. Stored `-c`/`--config` cannot replace those tables or their
children. The Library config enables `features.hooks`, registers the validated reader, disables
inherited servers and plugins, and keeps the inherited Windows Path (`exclude = []`, since `2f10bea`). `.codex/hooks.json` registers
the read, shell and patch guards and context hooks. Those registrations must survive seated launches.

Stored `-p`/`--profile` is refused because it layers another config file. `--enable`/`--disable` cannot
toggle any of the reserved names above; `daemon_auto_start` remains reserved. Other feature values
remain available. Validation covers separate, equals and attached short values. Claude's
`--mcp-config` and `--strict-mcp-config` are reserved because they can replace the reader's servers.
Ordinary model overrides remain available. Previously stored guard overrides make the record invalid
and follow the existing named reset route.

Legacy registry rows receive the existing `seat_id` field on their first launch-setting write under
the registry lock. Preview assigns no id; its approval binds the original legacy row. Section 224
proves these boundaries and creation's final assistant and conversation plan.
