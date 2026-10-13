# ADR-0076: A seat records its assistant and approved launch flags

**Status:** accepted
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
