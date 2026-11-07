# ADR-0089: Shared Books are written by any Library, with conditional writes, change records and restore as the guarantee

**Status:** accepted
**Date:** 2026-11-05
**Effective from:** the release carrying 1.6.0's shared writers
**Amends:** [ADR-0050](0050-a-local-librarys-basic-memory-is-a-connection-in-its-marker.md) and [ADR-0054](0054-a-shared-book-opens-on-a-local-library-and-rollback-checks-for-it.md)
**Closes, for the connection route:** the open question of [ADR-0044](0044-basic-memory-is-optional-and-the-public-install-is-local.md)

## Context

A local Library reaches Basic Memory as a connection in its marker (ADR-0050), and opens shared Books over it read
only (ADR-0054): nothing was written to Basic Memory. Several Libraries, one per office, now share one collection, and
each needs to add and correct pages of the shared Books. ADR-0030's fence lets one workspace write a collection, which
works for the attached route, where a workspace's backend is Basic Memory, and cannot work for many local Libraries
that each own their own `collection/`. ADR-0044 left open how one writer per collection is enforced over MCP alone.

Basic Memory 1.0 answers that from the server's side: every change tool takes `expected_checksum`, a mismatch is a typed
`REVISION_CONFLICT` with nothing changed, and a create never overwrites (`ALREADY_EXISTS`). The 1.0 write primitives
(`kernel/src/bmwrite.ts`) send each change once and return `written`, `refused` or `unknown`, settling an uncertain one by
listing. `tools/bm-proof.mts --record` proves those answers on a server and records its tool-list fingerprint.

## Decision

The signed `PLAN-many-libraries.md` r12, Stage 2, implemented from kickoffs/s191:

1. **Opting in.** A local Library writes shared Books only when its connection records `shared_writes: true`, set by
   `deskpost basic-memory setup --shared-writes on`. It is off for a new connection, kept for the same server and
   collection, and reset by a changed URL or collection. This amends ADR-0050 and ADR-0054: `shared/` is writable on
   opt-in, and only through the shared writers over the connection.
2. **A proven fingerprint.** A shared writer opens one session per command and writes only when the server's surface is
   Basic Memory 1.0 and its tool-list fingerprint equals the one `bm-proof --record` proved. Otherwise it refuses before
   anything is written, naming both fingerprints and the whole command that re-proves the server.
3. **Every write is conditional.** A page that exists is replaced only with the checksum of the read its base came from;
   a new page is created only if it is still absent. Another Library's write in between is refused by the server, and the
   writer names the page and its current checksum. No writer retries, and an uncertain write is reported unsettled and
   never sent again.
4. **The change record comes first, and it is the guarantee.** Before the page write, the writer records the page's
   previous text (or that it was absent), the new text, the Library, card and seat, under
   `_deskpost/changes/<slug>/`, and reads it back by listing; the page is written only after that. Records are never
   edited or deleted by Deskpost. A local receipt names each record, and `undo` points to its restore line, so a
   shared write has one recovery route: restore from its record.
5. **A create is confirmed by listing**, with one wait and at most one more create when the listing has not caught up,
   because a listing has been seen to lag a create on the NAS.
6. **ADR-0030's one-writer fence stays for the attached route only.** On the connection route there is no lease and no
   multi-writer mode switch (r12 points 1 and 2): the server's conditional writes order the writers, and the records and
   restore recover from a write that should not have landed. This closes ADR-0044's open question for the connection
   route.

## Consequences

Any opted-in Library can add or correct a shared page without a lock or a lease, and two Libraries cannot silently
overwrite each other's change. A server update that changes the tool list pauses shared writes until the proof is run
again. The previous text of every shared change is kept on the server, so a wrong change can be put back; the restore
commands, reconcile and the list of changes come with 1.6.0's next unit, and until then `undo` names the restore line
and refuses. The guarantee rests on the server's documented conditional writes, proven on one server build by the proof,
not on a proof of atomicity. Removing or archiving a shared Book is not part of this decision (r12 point 6).
