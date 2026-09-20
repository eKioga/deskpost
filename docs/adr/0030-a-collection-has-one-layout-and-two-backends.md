# A collection has one layout and two backends, and a Project Hub may live locally

A collection is a folder of Markdown in the shared collection's exact shape — `books/<slug>/`,
`projects/<slug>/`, `archive/` — wherever it lives. The program reads and writes it through one
interface with two implementations: a local folder, and Basic Memory reached through the
program's own server. A Project Hub may therefore live in a workspace's local collection, so
Seats, Desks, capture, triage, discovery and Hubs all work with no Basic Memory at all.

## Status

accepted — 2026-09-19, Eric's ruling Q5 in `PLAN-public-release.md`, amended by Codex round 1.
Effective from that plan's Phase D. The v0 preview still requires a Basic Memory endpoint and
says so.

## Why

Today a Hub exists only in the shared collection, so a Seat cannot exist without a network
service, and the install story carries a container. Basic Memory's own architecture, read in the
open `basic-memory` Book on 2026-09-19, says Markdown is canonical and every index is a rebuildable
projection — so a local Hub folder is already a valid Basic Memory project the moment a reader
points Basic Memory at it. The container Eric feared is a property of his multi-machine topology,
not of the product. No Hub playbook reads Basic Memory's relation graph; they read exact paths.

## Considered options

**Hubs stay shared-only.** Rejected. No Seats without a network service; the container stays in
the install story.

**Bundle local Basic Memory as the Tier 0 store.** Rejected. It removes the local backend and adds
`uv` and Python as prerequisites for everyone, against the footprint rule.

**Basic Memory as a peer MCP server beside the Library's.** Rejected on review (Codex round 1,
finding 14). A plugin's hooks are untrusted in Codex until reviewed, and a guard inside the
Library's server cannot intercept a separately exposed server. So the plugin exposes **one MCP
facade**, and Basic Memory is a backend behind it; direct Basic Memory tools are an explicit
reader opt-in after hook trust is verified and a live denial test passes.

## Consequences

- A workspace's local collection is Tier 0's **durable** tier; the Shelf stays the staging tier and
  drains into the collection, local or shared, so `docs/shelf-lifecycle.md` holds in Tier 0.
- Both backends carry a persistent collection id in the collection root. Four backend states are
  distinct and each has its own refusal: explicit local mode; configured but unreachable;
  misconfigured; and a Basic Memory server exposed by the reader's own harness configuration,
  which the program neither uses nor guards and says so.
- **One writable workspace per collection**, acquired by exclusive create of an owner record with
  an incarnation, fenced on every shared write, released only with no outstanding locks; read-only
  attachment is the default. Book locks live under each workspace, and two writers would hold
  different locks on one page — the split-lock defect ADR-0015 rejected.
- Tiers, for the README: 0 local only; 1 local Basic Memory through `uv tool install`, no
  container; 2 the reader's own networked endpoint; 3 Basic Memory Cloud.
