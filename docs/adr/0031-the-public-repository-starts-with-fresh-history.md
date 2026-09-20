# The public repository starts with fresh history, and a trusted job mirrors every branch

The public repository is created from a curated allowlist of product files, scanned before its
first commit, with one commit of history. Its origin on Forgejo is private; GitHub is a mirror
written only by a publishing job that runs from code the product repository cannot modify, scans
every newly reachable object against an immutable snapshot, and pushes exactly those refs. Every
branch of the program repository is mirrored; experiments live in the reader's private workspace
repository or a private fork.

## Status

accepted — 2026-09-19, Eric's ruling Q2 in `PLAN-public-release.md`, amended by Codex rounds 1
to 3. Effective from that plan's Phase B. `Kioga/library` on Forgejo stays as the private archival
record, read-only.

## Why

Thirteen commits in this repository add or remove the NAS address, `.mcp.json` once carried the
endpoint, and the root planning logs hold over a hundred lines naming the reader's hosts and
paths. Rewriting 222 commits means auditing the whole history of thirteen 40 to 75 KB logs; a
curated first commit is auditable in one sitting. On review, a pre-commit scan alone was shown
insufficient for an unattended mirror — it is bypassed by `--no-verify`, by contributor mode, and
by pushing an existing branch that creates no commit — so the gate moved to the server, where no
client can reach it.

## Considered options

**`git filter-repo` over the existing history.** Rejected. Keeps the commit graph at the cost of a
full-history audit, and rewrites what the private remote has served.

**A gated release repository on Forgejo, mirrored instead of the working repository.** Rejected.
A second remote and a stale public repository whenever the gate is skipped.

**Forgejo's built-in push mirror behind pre-commit.** Rejected on review. The built-in mirror
pushes whatever the branch holds, and pre-commit is a client-side courtesy.

## Consequences

- Publishing code lives in instance-level Forgejo Actions configuration or a private `ops`
  repository, never in a workflow file inside the mirrored repository. Runs are serialised. Each
  run scans every object reachable from an immutable snapshot of all refs that was absent from
  the **last successfully published snapshot** — blob contents, paths, commit messages, author and
  committer identities, tag names and messages — and forwards exactly those refs at those SHAs.
- A passed run publishes an attestation of validated ref names, SHAs and policy version; a failed
  run publishes only an opaque snapshot id, an object count and the policy version, never a ref
  name or path. Matched content and the full log stay private.
- Pull requests are opened and reviewed on GitHub and **merged only at Forgejo**; GitHub branch
  protection blocks every push except the mirror token's.
- The identity denylist is per machine, outside every repository, with an approved-attribution
  allowlist for the reader's public name and email; a static check runs it over every product
  working file and fails on any deployment default. Contributor machines fall back to `gitleaks`.
- The export tool stages, scans, and only then initialises; a failed scan discards the staging
  folder whole.
