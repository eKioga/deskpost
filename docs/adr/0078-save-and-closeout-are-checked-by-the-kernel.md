# ADR-0078: Save and closeout are checked by the kernel

**Status:** accepted
**Date:** 2026-10-14

## Context

Claude Code checks save and closeout answers against session writes; Codex has a manual procedure.
Two implementations would let evidence and completion rules drift. The 2026-10-11 source in `4714eee^3` (`0537498`) was a reference, not lost;
its notes and surviving tests are references for this rebuild.

## Decision

The kernel owns seat/conversation records, requests, successful writer evidence and answer checks.
Both harnesses will be thin wrappers around `deskpost checkpoint`. The
[contract](../save-closeout-contract.md) names source functions and deliberate differences.
The installed Claude mod keeps working unchanged until a later unit points it at the kernel.
C21 changes no hooks, skills or installation; C22 supplies those adapters and their live pilots.

## Consequences

One implementation checks both harnesses' evidence without granting writer authority. Missing
tracking, changed Desk snapshots and unsupported write claims cannot silently pass. Presentation
and reminders remain harness responsibilities.
