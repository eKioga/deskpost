# The mirror publishing job

> **Status:** designed 2026-09-19 (S7), deployed 2026-09-20 (S9), **running and green since
> 2026-09-20 (S10), run #5.** `eKioga/deskpost` carries `refs/heads/main`, `refs/tags/v0.1.0`,
> `refs/heads/attestations` and `refs/notes/published`, and `latest.json` reads
> `{"result":"pass","snapshot":"00d55700f397243c","objects":250,"policy":1,"refs":[...]}`.
>
> **Since S47 the job publishes GitHub releases**, from a private `refs/releases/<tag>` it scans inside and
> never forwards (see the scanner's release section). Measured on a fixture, `tools/mirror-fixture/`, and
> not yet on the deployed job: 15 checks pass, and the scanner from before the step, given a planted
> identity inside a compressed binary, passes it and forwards the release ref to the public side.
>
> **Getting there cost four failed runs and three defects that only running could find.** Runs #1-#3
> fired on the cron before it was removed and died on a missing executable bit; run #4 published
> `main` and `v0.1.0` and then died pushing a notes ref that had never been created. The sections
> below say plainly which parts are measured and which are written from the API's answers.
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
  # THE SCHEDULE WAS HELD UNTIL THE SCANNER HAD ACTUALLY RUN, and restored on
  # 2026-09-20 (S10) once it had. The condition the hold was written against --
  # "a ten-minute cron makes the FIRST run automatic, and the first successful
  # run IS the first public release, of a scanner that has never executed" -- is
  # retired: run #5 is green, `eKioga/deskpost` carries main, the tag, the
  # attestations branch and the published-state note, and the REFUSAL path has
  # been exercised against a planted denylisted identity with the target branch
  # provably unchanged.
  #
  # Restoring it was the reader's decision, not a cleanup, and the same is true
  # of removing it again. Export-MirrorOpsRepo.ps1 REPORTS this block's state on
  # every run -- reported, never asserted -- so which of the two is in force can
  # never change quietly in a generated file nobody reads.
  schedule:
    - cron: '*/10 * * * *'
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
        # The scanner calls all six (tar since S47, to open a release). A missing python3 would otherwise surface
        # as a malformed issue body on the one run that had something to report.
        run: |
          for t in git curl sha256sum grep python3 tar; do
            command -v "$t" >/dev/null || { echo "FATAL: $t is not on PATH in this container"; exit 1; }
          done
          echo "all six tools present"

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
        # INVOKED THROUGH `sh`, NOT AS `./scan-and-publish.sh`, and that is not a style choice.
        # The scanner is generated by tools/Export-MirrorOpsRepo.ps1 on Windows, which has no
        # executable bit to set, so every push of it records mode 100644 and a bare `./` call
        # dies with "Permission denied" and exit code 126. All three scheduled runs on
        # 2026-09-20 failed there, after checkout and the tool assertion had both passed.
        # Chmod-ing the blob would fix one push and silently regress on the next regeneration;
        # not depending on the bit fixes the class. The scanner is `#!/bin/sh` and POSIX-clean,
        # so `sh` is what its own shebang asks for. Export-MirrorOpsRepo.ps1 refuses a bare
        # `./scan-and-publish.sh` in this block so the defect cannot come back unnoticed.
        run: sh ./scan-and-publish.sh
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

# A NON-PERSONAL IDENTITY FOR EVERY OBJECT THIS JOB CREATES ITSELF.
#
# `$WORK/src` is a fresh bare clone and the runner's container has no global `user.email`, so
# `git notes add` and `git commit-tree` both refuse with "Committer identity unknown". That is the
# most likely reason `refs/notes/published` was empty on run #4 -- the run died on "src refspec
# refs/notes/published does not match any" AFTER the mirror push had succeeded, and the actual error
# was discarded by a `2>/dev/null`. Removing that discard, below, is the other half of this fix.
#
# Deliberately a bot name rather than the maintainer's: these objects are pushed to the PUBLIC
# mirror, and a person's identity is the one thing this job must never invent there.
GIT_AUTHOR_NAME='deskpost-mirror'
GIT_AUTHOR_EMAIL='deskpost-mirror@users.noreply.github.com'
GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# --- publishing the attestation -------------------------------------------------------------------
# Called on BOTH paths, because a refused snapshot's attestation is the ONLY public signal that
# anything happened at all.
#
# Until 2026-09-20 this did not exist: the attestation was written into `$WORK` -- a `mktemp -d` with
# an EXIT trap -- and never uploaded on either path, so the contract's "publishes a sanitised
# attestation" was not implemented. Run #4 confirmed it by omission, and S9's dry run had already
# said so without being read: "three pushes suppressed" is two refs plus the notes ref, and no
# attestation was ever among them.
#
# A BRANCH OF ITS OWN, NEVER `main`. What is pushed to main must stay exactly the snapshot that was
# scanned, so the attestation cannot live in that tree. Pure git plumbing, because `$WORK/src` is a
# BARE mirror clone with no working tree to `git add` into: hash-object, a temporary index,
# write-tree, commit-tree.
publish_attestation() {
  ATT_PARENT=''
  if git fetch "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
       'refs/heads/attestations:refs/heads/attestations' 2>/dev/null; then
    ATT_PARENT="$(git rev-parse --verify --quiet refs/heads/attestations || true)"
  fi

  ATT_BLOB="$(git hash-object -w "$WORK/attestation.json")"
  GIT_INDEX_FILE="$WORK/att-index"; export GIT_INDEX_FILE
  rm -f "$GIT_INDEX_FILE"
  [ -n "$ATT_PARENT" ] && git read-tree "$ATT_PARENT^{tree}"
  git update-index --add --cacheinfo "100644,$ATT_BLOB,latest.json"
  git update-index --add --cacheinfo "100644,$ATT_BLOB,$SNAPSHOT_ID.json"
  ATT_TREE="$(git write-tree)"
  unset GIT_INDEX_FILE

  if [ -n "$ATT_PARENT" ]; then
    ATT_COMMIT="$(git commit-tree "$ATT_TREE" -p "$ATT_PARENT" -m "attestation $SNAPSHOT_ID")"
  else
    ATT_COMMIT="$(git commit-tree "$ATT_TREE" -m "attestation $SNAPSHOT_ID")"
  fi
  git push --force "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
      "$ATT_COMMIT:refs/heads/attestations"
}

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

# --- releases: scanned INSIDE, published as GitHub releases, never forwarded as refs (S47) ----------
# A release travels on the private side as `refs/releases/<tag>`: one commit whose tree holds exactly
# what tools/Build-KernelRelease.ps1 wrote from a clone of the tagged commit -- SHA256SUMS, the two
# installers and the archives. A zip is compressed, so the blob scan above read nothing of what is
# inside it; each new release is extracted here and every file in it, a compiled binary included,
# joins the surface before anything is pushed. Measured in S47: a build started from the wrong
# directory embedded the builder's profile path 65 times in the binary, which no tree scan could see.
grep ' refs/releases/' "$WORK/snapshot" > "$WORK/release-refs" || :
: > "$WORK/releases"
while read -r sha ref; do
  grep -qxF "$sha" "$LAST" && continue                 # published by an earlier run
  tag="${ref#refs/releases/}"
  case "$tag" in v[0-9]*) ;; *) echo "FATAL: $ref does not name a v<version> tag"; exit 1 ;; esac
  grep -q " refs/tags/$tag\$" "$WORK/snapshot" || { echo "FATAL: release $tag has no tag $tag in this snapshot"; exit 1; }
  tagged="$(git rev-parse "refs/tags/$tag^{commit}")"
  dir="$WORK/rel/$tag"
  mkdir -p "$dir/files" "$dir/x"
  git archive "$sha" | tar -x -C "$dir/files"
  # The tree holds only what a release publishes, and SHA256SUMS names every archive in it.
  for f in "$dir/files"/* "$dir/files"/.[!.]*; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"
    case "$n" in SHA256SUMS|install.ps1|install.sh) ;; deskpost-*.zip) grep -q "  $n\$" "$dir/files/SHA256SUMS" || { echo "FATAL: release $tag carries $n, which SHA256SUMS does not name"; exit 1; } ;;
      *) echo "FATAL: release $tag carries $n, which a release does not publish"; exit 1 ;; esac
  done
  ( cd "$dir/files" && sha256sum -c --strict --quiet SHA256SUMS ) || { echo "FATAL: release $tag does not match its SHA256SUMS"; exit 1; }
  # Every archive is extracted, refused on an entry that climbs out, and must say it was built from
  # the very commit its tag names -- so a release cannot be attached to a tag it was not built from.
  python3 - "$dir/files" "$dir/x" "$tagged" <<'PY'
import glob, json, os, sys, zipfile
files, out, tagged = sys.argv[1], sys.argv[2], sys.argv[3]
archives = sorted(glob.glob(os.path.join(files, 'deskpost-*.zip')))
if not archives:
    sys.exit('FATAL: the release carries no archive')
for archive in archives:
    z = zipfile.ZipFile(archive)
    for name in z.namelist():
        if name.startswith('/') or '\\' in name or '..' in name.split('/'):
            sys.exit('FATAL: %s has an entry that leaves its folder: %s' % (os.path.basename(archive), name))
    root = os.path.join(out, os.path.basename(archive)[:-4])
    z.extractall(root)
    records = glob.glob(os.path.join(root, '*', 'release.json'))
    if len(records) != 1:
        sys.exit('FATAL: %s holds %d release.json files, not one' % (os.path.basename(archive), len(records)))
    built = json.load(open(records[0], encoding='utf-8-sig')).get('source_commit')
    if built != tagged:
        sys.exit('FATAL: %s was built from %s, and its tag names %s' % (os.path.basename(archive), built, tagged))
PY
  {
    find "$dir" -type f | sed "s#^$dir/##"               # paths inside the release and its archives
    find "$dir" -type f | while read -r f; do tr -d '\000' < "$f"; echo; done
  } >> "$WORK/surface"
  echo "$tag" >> "$WORK/releases"
done < "$WORK/release-refs"

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
  # Said BEFORE the upload, so a failure to publish the attestation cannot swallow the refusal
  # itself -- which is the more important of the two messages.
  echo "REFUSED: $HITS denied term(s) in snapshot $SNAPSHOT_ID"
  publish_attestation
  exit 1
fi

# --- publish exactly the snapshot -----------------------------------------------------------------
# Ref by ref at the recorded SHA, rather than `push --mirror`, which would push whatever the refs
# say at push time -- which is not what was scanned.
while read -r sha ref; do
  # A release ref carries binaries and is published as a GitHub release below, never as a ref.
  case "$ref" in refs/releases/*) continue ;; esac
  git push --force "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
      "$sha:$ref"
done < "$WORK/snapshot"

printf '{"result":"pass","snapshot":"%s","objects":%s,"policy":%s,"refs":[%s]}\n' \
  "$SNAPSHOT_ID" "$OBJECT_COUNT" "$POLICY_VERSION" \
  "$(cut -d' ' -f2 "$WORK/snapshot" | sed 's/.*/"&"/' | paste -sd, -)" > "$WORK/attestation.json"

publish_attestation

# --- the GitHub releases this snapshot carries (S47) ------------------------------------------------
# After the scan passed and after the tag was pushed, so a release is only ever attached to a tag the
# public side already holds. The mirror's PAT has Contents: write on the one repository, which is the
# permission GitHub asks for to create a release and upload its assets. IDEMPOTENT, because a run
# that fails here records no published-state note and the next run comes back: a release that exists
# is reused and an asset it already carries is skipped. The two API bases are overridable only so
# the fixture can stand in for GitHub, and the override names are the job's OWN: the first live run
# (2026-09-25) read `GITHUB_API_URL`, which a Forgejo runner sets to the Forgejo instance's API, as
# every Actions-compatible runner sets it -- so the release calls never reached GitHub, and the run
# failed after the tag was already public. Nothing sets a `MIRROR_` name but the fixture.
GITHUB_API="${MIRROR_GITHUB_API_URL:-https://api.github.com}"
GITHUB_UPLOADS="${MIRROR_GITHUB_UPLOADS_URL:-https://uploads.github.com}"
SLUG="$(printf '%s' "$TARGET_REPO" | sed -e 's#\.git$##' -e 's#^[a-z]*://[^/]*/##')"
gh_api() {
  curl -sS -H "Authorization: Bearer $MIRROR_GITHUB_PAT" -H 'Accept: application/vnd.github+json' \
       -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}
publish_release() {
  tag="$1"; files="$WORK/rel/$tag/files"
  code="$(gh_api -o "$WORK/release.json" -w '%{http_code}' "$GITHUB_API/repos/$SLUG/releases/tags/$tag")" || code=000
  if [ "$code" = 404 ]; then
    body="$(python3 -c 'import json,sys; t=sys.argv[1]; print(json.dumps({"tag_name": t, "name": "Deskpost " + t, "body": "Built from the tag " + t + " and published by the mirror job after the scan that published the tag. Check an archive against SHA256SUMS; install.ps1 does.", "draft": False, "prerelease": False}))' "$tag")"
    code="$(gh_api -o "$WORK/release.json" -w '%{http_code}' -X POST -d "$body" "$GITHUB_API/repos/$SLUG/releases")" || code=000
    [ "$code" = 201 ] || { echo "FATAL: creating release $tag answered $code: $(head -c 300 "$WORK/release.json" 2>/dev/null)"; return 1; }
  elif [ "$code" != 200 ]; then
    echo "FATAL: reading release $tag answered $code"; return 1
  fi
  id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$WORK/release.json")"
  python3 -c 'import json,sys; [print(a["name"]) for a in json.load(open(sys.argv[1])).get("assets", [])]' "$WORK/release.json" > "$WORK/assets-held"
  for f in "$files"/*; do
    n="$(basename "$f")"
    if grep -qxF "$n" "$WORK/assets-held"; then echo "release $tag already carries $n"; continue; fi
    code="$(gh_api -o "$WORK/asset.json" -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' \
            --data-binary "@$f" "$GITHUB_UPLOADS/repos/$SLUG/releases/$id/assets?name=$n")" || code=000
    [ "$code" = 201 ] || { echo "FATAL: uploading $n to release $tag answered $code: $(head -c 300 "$WORK/asset.json" 2>/dev/null)"; return 1; }
    echo "release $tag: uploaded $n"
  done
}
while read -r tag; do
  publish_release "$tag" || exit 1
done < "$WORK/releases"

# Record the published state so the next run's `--not` baseline is right. BEST EFFORT, AND NEVER
# SILENT -- the two halves that run #4 had backwards.
#
# This is an OPTIMISATION, not a safety property: without the note the next run rescans every object
# instead of only the newly reachable ones, which is slower and not less safe. So it must not fail a
# run whose publication succeeded. But it must not be swallowed either: the `add` used to end in
# `2>/dev/null || true` while the push that followed was mandatory, so the run died on a missing ref
# with the cause discarded, after the mirror push had already gone through.
NOTES_OK=1
while read -r sha ref; do
  git notes --ref=published add -f -m "published $SNAPSHOT_ID" "$sha" || {
    NOTES_OK=0
    echo "WARNING: could not record the published-state note for $sha"
  }
done < "$WORK/snapshot"
if [ "$NOTES_OK" -eq 1 ] && git rev-parse --verify --quiet refs/notes/published >/dev/null; then
  git push --force "$(echo "$TARGET_REPO" | sed "s#https://#https://$MIRROR_GITHUB_PAT@#")" \
      'refs/notes/published:refs/notes/published' \
    || echo "WARNING: the published-state note could not be pushed; the next run rescans every object"
else
  echo "WARNING: refs/notes/published was not created; the next run rescans every object"
fi
echo "PUBLISHED snapshot $SNAPSHOT_ID, $OBJECT_COUNT object(s)"
```

## What is not proven

Said plainly, because a design record that overstates its status is worse than none:

- ~~**Nothing here has run.**~~ **It runs.** Rewritten twice on 2026-09-20 (S10), and the two
  rewrites are the entry worth keeping. The first said "nothing here has run", which was already
  false: three scheduled runs had executed and failed. The second said "no run has completed", which
  run #5 retired. What is now **observed** rather than reasoned: the `rev-list --not` baseline (run 2
  of the fixture dropped from 6 objects to 4), the note-based published-state record, **both**
  attestation shapes, and the refusal path — a planted denylisted identity was refused with the
  target branch provably unchanged, which nothing had ever exercised.
- **The pass-path object count includes the job's own notes, and that is left alone deliberately.**
  `refs/notes/published` is fetched into the working clone *before* `rev-list --objects --all` runs,
  so the note commit, tree and blob are counted and scanned like anything else. A run where nothing
  changed reports 4 objects rather than 0. Measured on the fixture, 2026-09-20. It errs toward
  scanning **more**, which is the safe direction for a gate, so the behaviour stays and the surprise
  is written down instead.
- **A dry run cannot see the deployment.** The scanner was dry-run in S9 against the real private
  repository with `push` intercepted — 250 objects, clean, exit 0 — and the deployed job could not
  have started at the time, because the dry run set `SOURCE_REPO` itself. Two later defects, a
  missing executable bit and a missing git identity, were invisible to that dry run for the same
  reason: it supplied its own environment and intercepted its own pushes. The fixture harness that
  replaced it uses **local bare repositories as both remotes**, so the pushes actually land and what
  they produce can be read back.
- **The allowlist approximation is weaker than the local scan's.** `tools/DeploymentScan.ps1`
  implements whole-span containment at an exact position; the shell version above removes allowlisted
  strings before matching, which is close but not identical. It errs toward *more* suppression, so a
  term that is a strict substring of an allowlisted string could be missed. **That difference is now
  measured rather than reasoned:** `tools/Test-AllowlistRuleParity.ps1` runs both implementations
  over one fixture set — 8 cases, pinning 2 server-side false positives and 1 blind spot the two
  share. It is a gate check, so a change to either implementation that moves the divergence fails
  the build.
- **The GitHub side exists but is unconfigured.** `eKioga/deskpost` is public and empty (no branches,
  no tags, confirmed 2026-09-20). Branch protection blocking every push except the mirror token's is
  still a plan, not a configuration, and it should be set before the repository has anything in it
  worth protecting.

## Before the first public push

From [ADR-0032](adr/0032-the-family-name-is-deskpost.md):

- ~~Register `deskpost.dev` and `deskpost.io`.~~ **Closed 2026-09-20 (S10) by ruling, not by doing
  it:** no domain is registered for now, and Deskpost gets a page on the existing Pika site instead.
  Both names were re-confirmed unregistered the same day by RDAP and DNS agreeing, so the option is
  deferred rather than lost.
- Do a trademark gut-check. The 2026-09-19 search was for registry collisions, not for marks.
  **Partly done 2026-09-20 (S10)**, and the limit is stated rather than smoothed over: `deskpost` is
  free on npm, PyPI and crates.io, the GitHub handle is free, and a GitHub repository-name search
  returns only `eKioga/deskpost` itself. The nearest live software brand is **DeskPro**, a help-desk
  SaaS — a different product in a neighbouring word. One real collision: the public repository
  `medici-finance/assay` ships an internal `cmd/deskpost` subcommand, which is neither a product name
  nor a package. **USPTO's own database was not reached** — its search is a client-side application
  and the endpoints refuse an automated request — so the mark search proper is still outstanding.
