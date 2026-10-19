# ADR-0079: Codex runs save and closeout on the kernel first

**Status:** accepted
**Date:** 2026-10-15

## Context

The shared checkpoint core exists, but Codex has no native save or closeout tracker.
Claude Code already runs the deskpost-mods plugin. Installing another tracker or another
closeout skill there would duplicate both state and commands.

## Decision

Codex alone registers `hook checkpoint` for UserPromptSubmit, PostToolUse, Stop and Interrupt.
The adapter passes native conversation/turn identities and tool results to the kernel;
Stop checks the actual final answer. An unavailable answer is an unchecked gap. Interrupt
cancels a pending request. Every hook failure is advisory and logged, never a turn denial.

Codex receives save and closeout skills under `.agents/skills`. Claude Code keeps the mod
until a later unit points it at the kernel. The plugin route carries no checkpoint hooks yet.

## Consequences

One kernel record backs the Codex request and its evidence. Its result grants no writer
permission. Native delivery and hook trust require a separate live fixture proof; installation
and synthetic payload tests alone do not establish them. No real-home configuration is changed.
