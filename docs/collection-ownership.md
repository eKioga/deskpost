# One Writable Workspace Per Collection

A collection can be attached to more than one workspace. Exactly one of them may write to it, and
that role is acquired rather than assumed. Every other attachment is read-only, which is the
default.

This is the reference for `tools/Set-CollectionOwner.ps1`, for the refusals a shared write can
return, and for the record the role leaves in the collection. The rulings behind it are
[ADR-0030](adr/0030-a-collection-has-one-layout-and-two-backends.md) and
[ADR-0015](adr/0015-the-desk-is-per-seat-one-library-many-seats.md); the implementation is
`tools/CollectionOwnership.ps1`.

## Why the role exists

Book locks live **under each workspace**, in `internal/book-locks/` (`tools/BookWriteGuard.ps1`). So
two workspaces attached to one collection take two *different* locks over the same page: exclusion
that looks present and is absent. That is the split-lock defect ADR-0015 rejected when it refused
"clone the checkout per topic" — and `library init`, which arrived in step 20 of the public-release
plan, made attaching a second workspace to one collection easy for the first time.

The `writable` flag in a workspace's `.library/workspace.json` is therefore a **request recorded at
init time**, not a role held. Nothing in `library init` grants it.

## The three states of a collection

| State | What it means | What a shared write does |
| --- | --- | --- |
| `unowned` | no workspace has ever claimed the role | writes are permitted and **not fenced** |
| `held` | one workspace holds the role at incarnation *N* | that workspace writes; every other is refused |
| `released` | the holder stood down; the role is free | every write is refused until someone acquires |

**`unowned` is permitted on purpose, and it is a one-way door.** Every collection in existence
before step 21 has no ownership record, so a fence that refused on absence would have stopped every
shared write in the Library on the day it shipped. Absence means *the invariant is not yet armed*.
The first successful acquire arms it permanently: nothing deletes a claim record, so a collection
that has had an owner can never read `unowned` again.

`tools/Set-CollectionOwner.ps1 -Status` says which state a collection is in, and says so in the
words a refused write would use.

## The three verbs

```powershell
tools/Set-CollectionOwner.ps1 -Status
tools/Set-CollectionOwner.ps1 -Acquire
tools/Set-CollectionOwner.ps1 -Release
```

**`-Status`** is the default and never writes. It reports the backend state, the collection's
filesystem root, who holds the role, at which incarnation, since when and on which machine — and the
refusal a shared write would receive.

**`-Acquire`** is additive, reversible and idempotent: it writes one claim record, removes nothing,
and a second run by the same workspace reports the incarnation it already has. The role belongs to
the **workspace**, not to the process that took it, so every session on that machine holds it. What
it will not do is take a role another workspace holds; that refusal names both remedies.

**`-Acquire -Force`** displaces another workspace, and is the only operation here that the affected
party cannot undo from where they are sitting: their next shared write is refused wherever it runs.
So `-Force` on its own is a **preflight** — it reports exactly what it would displace and writes
nothing — and applies only with `-UserConfirmed`. Use it when that workspace is genuinely gone. If
it is merely idle, `-Release` run *there* is the correct route and leaves no forced-takeover record
behind.

**`-Release`** refuses while this workspace holds **any** Book lock. That refusal is the handoff's
whole safety: a release states that no write of ours is in flight, and the next owner starts writing
immediately. The lock files are read off disk rather than from an in-process ledger, because the
writer may be a session in another window.

## The record

The ownership record is `<collection>/.owner/`, a directory of one file per incarnation:

```
.owner/0001.claim.json      exclusive create IS the allocation of incarnation 1
.owner/0001.release.json    exclusive create IS the release of incarnation 1
.owner/0002.claim.json      the next owner
```

Nothing is ever deleted or rewritten. The current owner is **derived** — the highest claim with no
matching release — so there is no mutable pointer that can disagree with the records it points at,
and every state a crash can leave is a state the program can name.

**Why a directory and not the single `collection/.owner` file the plan sketched.** A single file has
to be *deleted* before the next owner can create it, and delete-then-create is not atomic: two
acquirers that both observed a release would both delete and both create, and the second delete
removes the first winner's own record. Two workspaces would then each hold incarnation *N+1* with no
way to tell. One exclusive create per incarnation has no such window.

**What a claim record discloses, stated rather than left to be discovered.** Besides the workspace id
and the incarnation, a claim carries the machine name, the workspace's local path, the process id and
a UTC timestamp — all of it so a refusal can tell a reader *where* to go and release the role rather
than only that somebody holds it. Everyone who can read the collection can read those records. On a
single-reader collection that is the point; on a collection shared between people it discloses
hostnames and local paths, and a deployment that minds should say so before the first acquire. The
program writes nothing else there.

The record appears complete or not at all: the body is written under a staging name and moved into
place, because a create that makes a zero-byte file visible first would let a concurrent reader
report the collection's ownership as corrupt. A record that *is* unreadable is therefore a damaged
one, and is refused rather than interpreted — as is a claim whose filename and body disagree, a
record of another schema, and a plain release signed by a workspace other than the claim's owner. A
*forced* release signed by someone else is legitimate and says so on its face.

## The fence

Every shared writer resolves its endpoint through one function,
`Resolve-LibraryWriteEndpoint`, which is `Resolve-LibraryMcpUrl` plus the ownership check. Readers
keep the plain resolver: a read is never fenced, because read-only attachment is the default and the
point. `collection.write-fence-coverage` asserts the wiring in three directions — a declared writer
that stops calling the door, an undeclared file that starts, and a declared writer that keeps a
second unfenced route — and asserts that the door itself still calls the check.

The check returns a **token** carrying the incarnation it observed. A one-shot helper needs nothing
more. A multi-step writer calls `Assert-LibraryWriteFenceUnchanged` before it commits, because a
forced takeover landing mid-publication would otherwise leave the rest of it writing pages the new
owner may already be writing.

The fence needs a **filesystem view** of the collection, which is why a configured endpoint with no
share root is a refusal rather than merely unhelpful: the deployed Basic Memory MCP surface has no
exclusive-create verb of any kind, so the arbitration cannot ride on the transport the writers
already use, and a writer that cannot be fenced is the split-writer hazard itself.

**A share that is merely disconnected is different, and permits.** The share and the HTTP endpoint are
different services, so a writer can be perfectly able to write while the arbitration cannot be read,
and refusing there would make every shared write depend on a mount — the behaviour
`SharedCollectionFiles.ps1` exists to end, since it resolves an unreachable share to nothing rather
than throwing and lets every caller degrade to "unavailable" and say so. The fence therefore permits
with reason `unreachable-view`. The residual risk is real and is named rather than hidden: while the
share is down, the fence cannot tell whether another workspace holds the role. A configured endpoint
with **no share root at all** is a static configuration fault rather than a transient one, and still
refuses.

## The four backend states, and the fifth

Each is a different reason a shared-collection operation cannot proceed, with a different fix, which
is why they are not one "unavailable".

| State | Condition | The fix it names |
| --- | --- | --- |
| `attached` | endpoint, collection id and a reachable collection root | — |
| `local` | no endpoint configured and none in the harness config | `Initialize-CodexLibrary.ps1 -McpUrl <url> -CollectionId <id>` |
| `harness-exposed` | no Library backend, but the reader's own harness config exposes a Basic Memory server | configure the Library's backend explicitly; the Library neither uses nor guards that server |
| `misconfigured` | the configuration contradicts itself: an endpoint with no collection id, a collection id with no endpoint, or an endpoint with no filesystem view | the one missing value, named |
| `unreachable` | everything is configured and the collection root is absent, or is not a collection | reconnect the share, or correct the path |

`local` is a working configuration rather than a fault — it is Tier 0, where there is no shared
collection to write to and local material is unaffected.

`harness-exposed` is reported rather than adopted. ADR-0030 rejected Basic Memory as a peer MCP
server beside the Library's, because a guard inside the Library's own server cannot intercept a
server exposed beside it: reads and writes through the reader's own server are outside every Desk and
Shelf boundary this program enforces. Saying so is better than behaving as though that server were
the backend.

## What this does not do

- It excludes **Library workspaces**, not every writer. Somebody editing the collection in Obsidian,
  or through their own Basic Memory server, is outside it — which is what `harness-exposed` exists to
  say out loud.
- The commit-time re-check is wired into the multi-step publication path. A one-shot edit is checked
  on entry only, and the residual window is one operation wide.
- A crashed owner leaves `held` with no release, which is visible in `-Status` and is what `-Force`
  is for. Nothing expires a claim on a timer: a role that quietly lapsed would be a second writer
  arriving without anyone deciding.
