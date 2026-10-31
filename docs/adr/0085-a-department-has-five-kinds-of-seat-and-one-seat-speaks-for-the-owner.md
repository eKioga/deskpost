# ADR-0085: A department has five kinds of seat, and one seat speaks for the owner

**Status:** accepted
**Date:** 2026-10-28
**Effective from:** the release carrying c75
**Relates to:** [PLAN-department-structure.md](../../PLAN-department-structure.md), [ADR-0071](0071-every-request-and-answer-between-seats-is-a-letter-and-the-writer-rings-an-open-recipient.md)

## Context

Deskpost's seats grew six templates, and two words for one job: the seat that writes Kickoffs was "the planner" in the loop pages and "the orchestrator" in the registry. Nobody answered design questions for the owner, so every such question waited on him.

## Decision

A department has five kinds of seat: orchestrator, planner, builder, auditor and performer. The orchestrator orders the work, writes Kickoffs and reviews handbacks. The planner stands in for the owner on design questions and always says so; the owner's reserved list (credentials and secrets; money; publishing and any public push; his own notes and vaults; Claude Code's and Codex's settings files; anything reaching outside Deskpost; a product's goals, scope and name; one priority call after each release) goes to him every time. The builder turns one approved Kickoff into tested commits. The auditor checks claims read-only. Every other seat is a performer. The `ideas`, `developer` and old `planner` templates are retired.

## Consequences

A seat created from a retired template keeps that name in its registry row as history; nothing migrates it. New seats come only from the five. "Planner" now means the stand-in seat everywhere; old pages keep the old meaning. A project manager per stream is added only when the measured trigger fires (median handback wait over 4 hours across ten handbacks, or three streams at once).
