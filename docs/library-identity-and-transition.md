# Library Identity and Transition

> **Status:** active operating identity, 2026-08-15.

## The name

This workspace is **the Library**. Its local folder is named `Library/`, and the active reader,
hooks, helpers, and MCP configuration resolve from that folder rather than from a machine-specific
path. Historical records may still refer to the former Pilot; those references describe evidence,
not the active workspace.

Use these names consistently in ordinary conversation. [CONTEXT.md](../CONTEXT.md) is the single
glossary and the authority on what each one means; this document explains the workspace's identity,
not its vocabulary.

> The name table that used to sit here was consolidated into `CONTEXT.md` on 2026-08-17. It had
> already drifted from the copy in `CLAUDE.md`, which still described the Desk as part of the shared
> collection after Shelf Books gained open/closed state on 2026-08-16.

## The Librarian

The Library uses a warm, state-grounded Librarian voice so a reader can quickly understand what is
ready to use and make the next useful choice. It grounds orientation in the actual Desk and
Notebook state, recommends only from material actually checked, and offers a small contextual next
step instead of a menu or diagnostic report. Warmth never changes a safety boundary: failures,
source limits, warnings, and consequential confirmations remain plain and exact. See [Librarian
Voice and Wayfinding](librarian-voice-and-wayfinding.md) for the ordinary-use voice checks.

The original Forgejo checkout, reader-card, and author-mode mechanics are not imported. The
Library retains its existing local Notebook, Shelf, validated shared reader, Project Hubs, and
manifest-bound copy safeguards.

## Standalone boundary

The Library's local MCP configuration contains exactly two services:

1. Basic Memory, for the NAS-backed shared collection; and
2. the validated reader, for ordinary safe Book and Project reading.

Agent Mail is intentionally absent. It did not prove reliable enough to be part of routine
Library operation. Its source material and earlier acceptance records remain untouched in the
parent research workspace as historical evidence; they are not an invitation to configure it in
the Library.

## What stays stable

- Work locally in `raw/` and `notebook/`.
- Open only the Books and Projects needed for the current question.
- Copy selected context to the shared collection only after its bounded preflight and approval.
- Reset, archive, and publication safeguards remain unchanged.
- The Library is in active development. For a reader-experience change, record its reader benefit
  and safety boundary, then test ordinary reader requests before adopting it.

