# ADR-0097: A department may hold groups, each a department of its own

**Status:** accepted
**Date:** 2026-11-21
**Decided by:** Eric, 2026-11-21
**Amends:** [ADR-0073](0073-a-department-letter-goes-to-its-orchestrator-or-its-only-seat-and-a-seats-names-follow-one-set-of-rules.md) point 1 for a parent with groups

## Decision

A department name may contain one slash, as in `games/sbox`. Each part is a slug.
Rules for seats, orchestrators and letters apply to the whole name. Seat cards list
the parent's own seats first and then its groups.

A letter to a parent that has groups goes to the parent's own orchestrator. When the parent
has none, capture refuses and names the group destinations. This keeps an administrative seat
alone in the parent from receiving every letter addressed to the parent.

## Alternatives considered

A separate registry field would let seats in the same group disagree about their parent.
Flat departments would lose the shared heading. A performer choosing its own orchestrator
would leave a department letter without a single destination.

## Consequences

Existing top-level routing rules continue to apply to departments without groups.
An older Deskpost version reads a letter addressed to a group as malformed. Seat moves
use approved `seat describe` previews after the release that introduces groups.
