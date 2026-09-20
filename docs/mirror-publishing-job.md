# The mirror publishing job

> **Status:** designed 2026-09-19 (S7), **not yet running**. Nothing in this document has been
> executed end to end; the sections below say plainly which parts are measured and which are
> written from the API's answers.
>
> **Corrected 2026-09-20 (S9).** This page said "no Actions runner is registered yet" and specified
> `runs-on: self-hosted`. Both were wrong, and the second would have cost the first run: a job
> requesting a label no runner carries is queued forever, not failed. See
> [The runner](#the-runner) for the measurement that replaced them.

PLAN-public-release.md step 12, server half. This is the boundary that actually guarantees the
product promise: **no material belonging to the maintainer's Library reaches a public object.** The
local scan in `tools/DeploymentScan.ps1` is fast feedback on one machine. This is the gate.

## What the instance can do, measured 2026-09-19

The plan's risk list said to inspect the Forgejo instance at the start of Phase B and decide the
job's form from what it found. Three sessions passed without it; this is that inspection.

`forgejo.example.invalid`, **Forgejo 14.0.5+gitea-1.22.0**:

> The instance host is written as a placeholder throughout this document, and so is every machine
> name. This file ships in the public tree, and a hostname names a machine as surely as an address
> does — the identity scan refused an earlier draft of this very page for exactly that, which is the
> shortest possible argument that the gate below is worth building. The real names are in the
> private records.

| Question | Answer | How it was established |
| --- | --- | --- |
| Actions enabled instance-wide | **yes** | `GET /api/v1/repos/{owner}/{repo}/actions/tasks` answers `{"workflow_runs":[],"total_count":0}` rather than 404 |
| Actions enabled on the repository | **yes** | the repository object reports `has_actions: true` |
| A repo-scoped runner can be registered | **yes** | `GET /actions/runners/registration-token` issues a token |
| A runner is currently registered | **yes** — corrected 2026-09-20 | the list-runners endpoint does not exist in this version, so the API cannot answer it directly and the 2026-09-19 reading took the maintainer's "no" instead. A runner's observable marker is *executed tasks*, not a runners endpoint: `GET /repos/Kioga/ignis-build/actions/tasks` reports **122 runs**, the latest `event=schedule`, `status=success`, `created_at=2026-09-19T21:01:50-07:00` |
| Pre-receive git hooks available | **no** | `GET /repos/{owner}/{repo}/hooks/git` returns **403** |
| Instance-level admin configuration | **available to the maintainer, not to the token** | `/api/v1/admin/*` returns 404 and `/api/v1/user` returns 403 for the API token in use, which is scope-limited; the maintainer confirmed separately that he holds a site-admin account |

**One caveat, stated rather than smoothed over.** The 403 and 404 responses on the admin routes are
evidence about *the token*, not about the account. A fine-grained Forgejo token without admin scope
answers exactly the same way a non-admin user's token does. The `is_admin: false` on the owner
record points the same way but is not proof either, because Forgejo suppresses that field for
unprivileged reads. The site-admin question was settled by asking the maintainer, not by the API.

### Which of the three forms this decides

The plan named three, and ruled that the choice must be made before the job is designed:

1. **Instance-level Forgejo Actions configuration.** Available in principle — the maintainer is a
   site admin — but rejected. Instance-level configuration is invisible from any repository, lives
   only in the server's filesystem, and is not reviewable in a diff. A boundary this important
   should be readable by the person relying on it.
2. **Pre-receive hooks.** **Not available.** Git hooks are refused at 403, which on Forgejo means
   either `DISABLE_GIT_HOOKS=true` in the instance configuration or a token without the privilege.
   Either way it is not a route that can be taken today without changing server configuration.
3. **A separate private `ops` repository with its own Actions workflow.** **This is the form.** It
   satisfies the plan's requirement — trusted code the product repository cannot modify — while
   staying reviewable, versioned and diffable. The product repository has no write access to it, so
   a pull request against the product cannot alter the gate that inspects it.

The fallback the plan feared — a scanning script driven from the maintainer's machine, which is no
longer unattended and is a weaker product promise — **is not needed**. A runner is registered and
executing scheduled jobs, so nothing stands between this design and a working mirror but the two
repositories and their secrets.

## Why the workflow is not in this repository

There is no `.forgejo/workflows/` directory here and there must not be one. A workflow file inside
the mirrored repository is modifiable by anything that can change the mirrored repository, which
includes every pull request the job exists to inspect. The running copy lives in the private `ops`
repository; what follows is its source, kept here so it can be reviewed alongside the product it
guards.

`ops/` is also absent from `tools/PublicTreeAllowlist.ps1`, so nothing of the job's configuration
reaches the public tree even by accident.

## The contract

Each run:

1. **Serialises.** One run at a time, enforced by a concurrency group. Two runs racing would let a
   ref move between one run's scan and another's push.
2. **Snapshots.** Records every ref and its SHA at one instant, and works from that snapshot only.
   Everything after this point reads the snapshot, never the live repository — a ref that moves
   mid-run belongs to the next run.
3. **Scans the new objects.** Every object reachable from the snapshot that was not reachable from
   the **last successfully published snapshot**. The `--not` form is what makes this both cheap and
   correct: an object rejected on an earlier push is scanned again the moment it becomes reachable
   from a new ref, rather than being treated as already-seen.
4. **Scans all five surfaces.** Blob contents, **paths**, commit messages, **author and committer
   identities**, and tag names and messages. Four of those are not blobs, and a scan that read only
   blob contents would publish a branch named after a machine without noticing.
5. **Forwards only a clean snapshot**, pushing exactly those refs at exactly those SHAs. Not
   `--mirror` against the live repository, which would push whatever the refs say at push time.
6. **Has no override.** There is no input, no label and no environment variable that skips the scan.
   A false positive is fixed by correcting the denylist in the secret, which is an edit somebody
   makes deliberately, on the server, outside the product repository.
7. **On failure: stops, and opens an issue** on the private Forgejo repository naming the object, so
   the maintainer can see exactly what was caught. That issue is private and may name anything.
8. **Publishes a sanitised attestation**, and nothing else, to the public side.

## The attestation, and why the failure case says so little

For a **passed** snapshot: the ref names, the object SHAs, the policy version, and `pass`. Ref names
are safe to publish here precisely because they went through the same scan as everything else — that
is the ordering that makes this work.

For a **failed** snapshot: an opaque snapshot id, the object count, the policy version, and nothing
more. **Never a ref name and never a path.** The reason is the case that makes the whole design
necessary: a tag or branch rejected *because its name carries a private identity* would, if the
failure attestation named it, publish that identity in the course of reporting that it refused to.
Matched content and the full log stay on Forgejo.

## The runner

**One already exists.** Measured 2026-09-20, after the 2026-09-19 reading recorded the opposite.

A `forgejo-runner` stack — image `davbfr/forgejo-runner:12`, runner name `nas-lab-runner` — is
deployed on the NAS host that also runs Forgejo, and has been since before this document was
written. Its capture sits in the estate's own `raw/` material.

**Why the earlier reading said no, and what the right question was.** Forgejo 14.0.5 has no
list-runners endpoint; every path 404s, re-confirmed on 2026-09-20. So S7 asked the maintainer and
recorded the answer as fact. But a runner's observable marker is not a runners endpoint — it is
**executed tasks**, and those the API answers readily:

| repository | `total_count` | latest |
| --- | --- | --- |
| `Kioga/odysseus-build` | 194 | — |
| `Kioga/ignis-build` | **122** | run #107, `event=schedule`, `status=success`, `2026-09-19T21:01:50-07:00` |
| `Kioga/mcp-agent-mail-ops` | 3 | run #3, `status=success` |

A scheduled job succeeded the day before this correction. Cron-driven Actions on this instance are
not a plan; they are a running system. **The general rule this cost: a tool's negative is not
absence — name the container searched, and measure the marker the writer actually stamps.**

### The label the runner answers to

**`runs-on: self-hosted`, as this document originally specified, would never have been picked up.**
Actions matches a job's `runs-on` against the runner's registered labels, and an unmatched job is
**queued indefinitely rather than failed** — the worst failure shape, because it looks like nothing
happening. Both workflows that demonstrably run on this instance declare:

```yaml
runs-on: docker
container:
  image: catthehacker/ubuntu:act-latest
```

That is the form [the workflow](#the-workflow) below now uses, taken from
`Kioga/ignis-build/.forgejo/workflows/build.yml` and `Kioga/mcp-agent-mail-ops` rather than composed.
The container image supplies `git` and a POSIX shell, which is all the scan needs; the workflow
asserts its tools at startup rather than assuming them.

The scanner does **not** need the product's PowerShell toolchain: the server-side scan is
deliberately independent of the product's own code, so a defect in `tools/DeploymentScan.ps1` cannot
disable the gate that guards it.

**The workflow still belongs to the `ops` repository, not the product repository.** That was never
about which host runs the job — a shared runner is fine. It is about which repository's *files* the
runner executes: a workflow living in the product repo could be altered by a pull request against
the product, which is the thing this design exists to prevent.

## Secrets the job needs

Set on the `ops` repository, never in any repository's files:

| Secret | What it is |
| --- | --- |
| `SOURCE_REPO` | the private product repository's clone URL. **A secret because it names the instance**, and this document ships in the public tree. |
| `TARGET_REPO` | the public mirror's clone URL. Not sensitive, but kept beside `SOURCE_REPO` so neither is a literal in a file that ships. |
| `IDENTITY_DENYLIST` | the maintainer's denylist, one term per line — the same content as `%USERPROFILE%\.library\identity-denylist.txt`. **This file is the leak it prevents**, which is why it is a secret and not a file. |
| `IDENTITY_ALLOWLIST` | approved attribution, one term per line. A denied term is excused only when an allowlisted string covers the whole match at that position. |
| `FORGEJO_TOKEN` | reads the private product repository and opens an issue on it. |
| `MIRROR_GITHUB_PAT` | a **fine-grained** GitHub PAT scoped to the one public repository, Contents: Read and write, and nothing else. Metadata read is added by GitHub and cannot be removed. |

## The workflow

To be placed at `.forgejo/workflows/publish.yml` **in the private `ops` repository**.

```yaml
name: publish-mirror
on:
  # THE SCHEDULE IS DELIBERATELY ABSENT, and restoring it is a decision rather
  # than a cleanup. A ten-minute cron makes the FIRST run of this job automatic,
  # and the first successful run IS the first public release -- of a scanner that
  # has never executed, whose job is to prevent the one failure that cannot be
  # undone. Three defects in this very document were found by running it rather
  # than reading it (an absent runner, a runner label that matches nothing, a
  # secret name Forgejo refuses to create); the scanner is the part not yet
  # exercised.
  #
  # Restore `schedule: [{ cron: '*/10 * * * *' }]` here only after a deliberate
  # workflow_dispatch run has been watched end to end and ADR-0032's two
  # pre-publication items are closed.
  workflow_dispatch:

# One run at a time. Two runs racing could scan one snapshot and push another.
concurrency:
  group: publish-mirror
  cancel-in-progress: false

jobs:
  publish:
    # MEASURED, NOT CHOSEN. These two lines are the form both workflows that
    # actually run on this instance use. `self-hosted` matches no runner here,
    # and an unmatched job queues forever rather than failing -- see The runner.
    runs-on: docker
    container:
      image: catthehacker/ubuntu:act-latest
    steps:
      - name: Check out the scanner from this repository
        uses: actions/checkout@v4

      - name: Assert the tools the scanner needs
        # The scanner calls all five. A missing python3 would otherwise surface
        # as a malformed issue body on the one run that had something to report.
        run: |
          for t in git curl sha256sum grep python3; do
            command -v "$t" >/dev/null || { echo "FATAL: $t is not on PATH in this container"; exit 1; }
          done
          echo "all five tools present"

      - name: Scan the new objects and publish a clean snapshot
        env:
          # BOTH REPOSITORY URLS ARE SECRETS, and the first one has to be.
          # This document ships in the public tree, so the instance hostname
          # cannot be written here -- the identity scan refused an earlier draft
          # of this very page for exactly that. Until 2026-09-20 these two lines
          # carried the PLACEHOLDER hostnames as literals, which meant the
          # deployed job would clone `forgejo.example.invalid` and die on its
          # first command. Found by dry-running the scanner: the dry run
          # supplied its own SOURCE_REPO, so it proved the scanner works and
          # said nothing about the env block, which is the half that was broken.
          SOURCE_REPO: ${{ secrets.SOURCE_REPO }}
          TARGET_REPO: ${{ secrets.TARGET_REPO }}
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_TOKEN }}
          MIRROR_GITHUB_PAT: ${{ secrets.MIRROR_GITHUB_PAT }}
          IDENTITY_DENYLIST: ${{ secrets.IDENTITY_DENYLIST }}
          IDENTITY_ALLOWLIST: ${{ secrets.IDENTITY_ALLOWLIST }}
        run: ./scan-and-publish.sh
```

## The scanner

To be placed at `scan-and-publish.sh` in the private `ops` repository. **Untested**: no runner
exists to run it against. Treat it as the design expressed precisely rather than as working code,
and run it once by hand before trusting a schedule to it.

```sh
#!/bin/sh
set -eu

WORK="$(mktemp -d)"
POLICY_VERSION=1
trap 'rm -rf "$WORK"' EXIT

# --- the snapshot -------------------------------------------------------------------------------
# A bare mirror clone taken once. Everything below reads THIS, never the live repository, so a ref
# that moves mid-run belongs to the next run rather than to this one's push.
git clone --mirror "$(echo "$SOURCE_REPO" | sed "s#https://#https://$FORGEJO_TOKEN@#")" "$WORK/src"
cd "$WORK/src"
git for-each-ref --format='%(objectname) %(refname)' > "$WORK/snapshot"
SNAPSHOT_ID="$(sha256sum "$WORK/snapshot" | cut -c1-16)"

# --- what is new since the last SUCCESSFUL publish ------------------------------------------------
# Kept as a git note on the published side rather than in a file, so a lost runner cannot silently
# reset the baseline to "everything is new" -- or worse, to "nothing is".
LAST="$WORK/last-published"
git fetch "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
    'refs/notes/published:refs/notes/published' 2>/dev/null || true
git notes --ref=published list 2>/dev/null | cut -d' ' -f2 | sort -u > "$LAST" || : > "$LAST"

# Every object reachable from the snapshot that was not reachable from the last published state.
# `--not` rather than a seen-list: an object rejected on an earlier push is scanned again as soon
# as a new ref makes it reachable.
if [ -s "$LAST" ]; then
  git rev-list --objects --all --not $(cat "$LAST") > "$WORK/objects"
else
  git rev-list --objects --all > "$WORK/objects"
fi

printf '%s\n' "$IDENTITY_DENYLIST"  | sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' > "$WORK/deny"
printf '%s\n' "$IDENTITY_ALLOWLIST" | sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' > "$WORK/allow"
[ -s "$WORK/deny" ] || { echo "FATAL: the denylist is empty, so this scan would pass everything"; exit 1; }

# --- the five surfaces ----------------------------------------------------------------------------
# Four of these are not blob contents. A scan that read only blobs publishes a branch named after a
# machine without noticing.
{
  cut -d' ' -f2- "$WORK/objects" | sed '/^$/d'          # paths
  cut -d' ' -f1 "$WORK/objects" | while read -r o; do
    case "$(git cat-file -t "$o")" in
      blob)   git cat-file blob "$o" | tr -d '\000' ;;    # blob contents
      commit) git cat-file commit "$o" ;;                  # message, author AND committer identity
      tag)    git cat-file tag "$o" ;;                     # tag name and message
    esac
  done
  cut -d' ' -f2 "$WORK/snapshot"                          # ref names
} > "$WORK/surface"

# A denied term is excused only when an allowlisted string covers the WHOLE match. Approximated here
# by removing every allowlisted string first, so a bare name inside a home directory still matches
# while the same name in a byline does not.
cp "$WORK/surface" "$WORK/residue"
while IFS= read -r a; do
  [ -n "$a" ] && { sed "s|$(printf '%s' "$a" | sed 's/[][\.*^$/]/\\&/g')||g" "$WORK/residue" > "$WORK/r2"; mv "$WORK/r2" "$WORK/residue"; }
done < "$WORK/allow"

HITS=0
while IFS= read -r d; do
  [ -n "$d" ] && grep -qiF -- "$d" "$WORK/residue" && HITS=$((HITS+1))
done < "$WORK/deny"

OBJECT_COUNT="$(wc -l < "$WORK/objects" | tr -d ' ')"

# --- refuse, and say almost nothing in public -----------------------------------------------------
if [ "$HITS" -gt 0 ]; then
  # The private issue may name anything; it is on Forgejo and only the maintainer sees it.
  MATCHED="$(while IFS= read -r d; do
      [ -n "$d" ] && grep -qiF -- "$d" "$WORK/residue" && grep -niF -- "$d" "$WORK/residue" | head -3
    done < "$WORK/deny")"
  # DERIVED FROM SOURCE_REPO, never spelled. This file ships in the public tree, so it cannot name
  # the instance. It carried a placeholder hostname as a literal until 2026-09-20, which meant the
  # one message that says WHAT was caught went to a host that does not resolve -- and the public
  # attestation deliberately says almost nothing, so a refusal was very nearly undiagnosable.
  ISSUE_API="$(printf '%s' "$SOURCE_REPO" | sed -e 's#\.git$##' -e 's#^\(https://[^/]*\)/\(.*\)$#\1/api/v1/repos/\2/issues#')"
  curl -sf -X POST -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' \
    "$ISSUE_API" \
    -d "$(printf '{"title":"Mirror refused snapshot %s","body":%s}' "$SNAPSHOT_ID" \
          "$(printf '%s' "$MATCHED" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null || echo "WARNING: could not open the issue; the refusal still stands"

  # The PUBLIC attestation: an opaque id, a count, a policy version. Never a ref name, never a path.
  # A tag rejected BECAUSE its name carries an identity would otherwise publish that identity here.
  printf '{"result":"fail","snapshot":"%s","objects":%s,"policy":%s}\n' \
         "$SNAPSHOT_ID" "$OBJECT_COUNT" "$POLICY_VERSION" > "$WORK/attestation.json"
  echo "REFUSED: $HITS denied term(s) in snapshot $SNAPSHOT_ID"
  exit 1
fi

# --- publish exactly the snapshot -----------------------------------------------------------------
# Ref by ref at the recorded SHA, rather than `push --mirror`, which would push whatever the refs
# say at push time -- which is not what was scanned.
while read -r sha ref; do
  git push --force "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
      "$sha:$ref"
done < "$WORK/snapshot"

printf '{"result":"pass","snapshot":"%s","objects":%s,"policy":%s,"refs":[%s]}\n' \
  "$SNAPSHOT_ID" "$OBJECT_COUNT" "$POLICY_VERSION" \
  "$(cut -d' ' -f2 "$WORK/snapshot" | sed 's/.*/"&"/' | paste -sd, -)" > "$WORK/attestation.json"

# Record the published state so the next run's `--not` baseline is right.
while read -r sha ref; do git notes --ref=published add -f -m "published $SNAPSHOT_ID" "$sha" 2>/dev/null || true; done < "$WORK/snapshot"
git push --force "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
    'refs/notes/published:refs/notes/published'
echo "PUBLISHED snapshot $SNAPSHOT_ID, $OBJECT_COUNT object(s)"
```

## What is not proven

Said plainly, because a design record that overstates its status is worse than none:

- **Nothing here has run.** A runner exists and executes scheduled jobs (measured 2026-09-20), and
  the `runs-on` form is now taken from workflows that demonstrably run on it — but *this* workflow
  has still never executed. The `rev-list --not` baseline, the note-based published-state record and
  the attestation shapes remain reasoned, not observed.
- **The allowlist approximation is weaker than the local scan's.** `tools/DeploymentScan.ps1`
  implements whole-span containment at an exact position; the shell version above removes allowlisted
  strings before matching, which is close but not identical. It errs toward *more* suppression, so a
  term that is a strict substring of an allowlisted string could be missed. Before this job is
  trusted, that difference should be measured against the same fixture the local scan uses — the two
  implementations of one rule need a comparison test, not two independent readings of the prose.
- **The GitHub side does not exist yet**, so branch protection blocking every push except the
  mirror token's is a plan, not a configuration.

## Before the first public push

From [ADR-0032](adr/0032-the-family-name-is-deskpost.md), still open:

- Register `deskpost.dev` and `deskpost.io`.
- Do a trademark gut-check. The 2026-09-19 search was for registry collisions, not for marks.
