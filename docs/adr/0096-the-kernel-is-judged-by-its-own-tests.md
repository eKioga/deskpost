# ADR-0096: The kernel is judged by its own tests

**Status:** accepted
**Date:** 2026-11-21
**Decided by:** Eric, 2026-11-21
**Amends:** [ADR-0039](0039-an-independent-row-is-judged-against-the-kernel-under-test.md) and
[ADR-0043](0043-a-judge-drives-the-kernels-real-verbs.md)

## Decision

Retire the comparison with the frozen PowerShell implementation. The kernel is judged by its self-test,
the release's compiled sections, the built-release fixtures and real sessions in each harness. Keeping
the old implementation as the oracle increasingly required approving intended differences at each release.
The reader benefit is a release proof that checks the program readers receive; this retires no Desk,
approval, locking, recovery or data-preservation boundary.

Differential rows established parity while operations moved from PowerShell to the kernel. They are
retired with their runner and generated operation table. The kernel self-test continues to assert public
commands, refusals and file changes; the built-release fixtures prove installation, upgrade and rollback.
Independent rows checked races and recovery that agreement between two implementations cannot prove:
the sections used by their 33 automated rows join the compiled release recipe when they pass against
the release binary. Section 39 currently fails against the starting binary because its Codex hook inventory
expectation differs; it remains a source-suite check and is recorded as unresolved, not a compiled pass.
The two migration rows' seven case groups move to section 1954, including every legacy state, approval
refusals, byte preservation, seat-scoped reset and adoption, and interruption recovery at every journal
boundary. The eleven recorded session verdicts become the [Harness looks](../releasing.md#harness-looks)
checklist, recorded on the release review page for the exact binary hash once per release.

## Consequences

The [release recipe](../releasing.md) names the proof steps. Real-session observations remain distinct
from simulated hook payloads: a model declining a read before calling a tool does not prove hook delivery.
Provenance comments and dated decisions remain historical records. The external-wiki inventory and import
helpers remain because reader playbooks still call them; their retirement needs a later unit.
