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
- Pull requests are opened and reviewed on GitHub and **merged only at Forgejo**; ~~GitHub branch
  protection blocks every push except the mirror token's~~ — see the amendment below.
- The identity denylist is per machine, outside every repository, with an approved-attribution
  allowlist for the reader's public name and email; a static check runs it over every product
  working file and fails on any deployment default. Contributor machines fall back to `gitleaks`.
- The export tool stages, scans, and only then initialises; a failed scan discards the staging
  folder whole.

**Amended 2026-09-20 (S11): the mirror cannot be named as the only writer, so the rule is stated as
what is enforceable.** The original consequence assumed GitHub could restrict pushes to one actor.
It cannot here, for two independent reasons, both measured rather than assumed.

*Actor restriction is organization-only.* GitHub's protected-branches documentation: "You can enable
branch restrictions in public repositories owned by a GitHub Free organization and in all
repositories owned by an organization using GitHub Team or GitHub Enterprise Cloud." Its REST API
documentation says the same of the parameter: "User, app, and team restrictions are only available
for organization-owned repositories." The public repository is owned by a user account, confirmed
from the API rather than from the name, so the option does not exist. The repository ruleset form
offers no such rule either.

*And an actor restriction would not discriminate anyway.* The mirror authenticates with a
fine-grained token issued by the account that owns the repository, so the publishing job and a
maintainer typing `git push` are **the same actor**. Naming that actor permits both or blocks both.
Separating them needs the mirror to hold an identity of its own — a GitHub App installation, or a
machine account under an organization — which is a change to a publishing job that took three
sessions to get green, and is deferred rather than rejected.

*What is enforced instead*, as ruleset `Mirror is the only writer`, active on the default branch and
on `attestations`: **restrict deletions** and **block force pushes**. Verified through the public
API with an unrelated branch as a control, which returns no rules. GitHub's own name for the second
rule is `non_fast_forward`, which answers a question its prose does not: it rejects non-fast-forward
*updates*, not the `--force` flag, so the job's `git push --force` of a fast-forward is unaffected.
`attestations` is targeted deliberately as well as the default branch — it advances on every
scheduled run, so the rule is exercised continuously instead of lying untested until the next
release. **Confirmed by the job itself rather than by reading**: the first scheduled run after the
ruleset went active advanced `attestations` from `64b46763` to `8a860d60`, which is a `--force`
push of a fast-forward landing on a branch carrying the rule.

The gap this leaves is named rather than papered over: **a maintainer can still push to the public
repository by hand.** Nothing merged there survives, because the mirror forwards exactly the refs
its snapshot holds, but the correction is silent and arrives on the next run. Closing it properly is
the GitHub App above. Until then the protection is against history being *replaced or deleted*, not
against it being *added to*.
