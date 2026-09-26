#!/bin/bash
# S47: the mirror job's release step, with local bare repositories as both remotes and a stub for GitHub's API.
#
# Run on Linux with git, curl, python3, sha256sum and tar -- the job's own container has them; S47 ran it in the
# deskpost-clean distro. The argument is a folder holding:
#   new/scan-and-publish.sh   the scanner tools/Export-MirrorOpsRepo.ps1 generates from docs/mirror-publishing-job.md
#   old/scan-and-publish.sh   a scanner from before the release step, for the planted-defect run (3r)
#   stub.py                   this folder's stand-in for the three GitHub release endpoints
# S47, measured: 15 passed, and 3r red as it must be -- the old scanner passes a planted identity inside a
# compressed binary and forwards refs/releases/<tag> to the public side.
set -u
K="$1"                        # the unpacked kit: new/, old/, stub.py
D="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }

PORT=18765
python3 "$K/stub.py" "$PORT" "$D/stub" & STUB=$!
trap 'kill $STUB 2>/dev/null; rm -rf "$D"' EXIT
sleep 1

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
git init -q --bare "$D/src.git"
mkdir -p "$D/gh/eKioga"
git init -q --bare "$D/gh/eKioga/deskpost.git"
git init -q -b main "$D/work"
cd "$D/work"

# A release as Build-KernelRelease.ps1 lays one out, built from $2 (a commit), with an optional extra file
# and an optional planted term inside the binary, spelled UTF-16LE as a Windows string table would.
make_release() {   # $1 tag  $2 source_commit  $3 planted(0/1)  $4 extra file name or ''
  r="$D/rel-$1"; rm -rf "$r"; mkdir -p "$r"
  python3 - "$r" "$1" "$2" "$3" <<'PY'
import hashlib, json, os, sys, zipfile
out, tag, commit, planted = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
version = tag[1:]
root = 'deskpost-%s-win-x64' % version
# COMPRESSIBLE, as a real binary is (87 MB deflates to 42 MB): random filler is stored raw by deflate and
# would leave a planted term readable in the zip's own bytes, which is not the case the step exists for.
binary = b'MZ' + b'kernel runtime section text ' * 400 + ('library %s' % version).encode()
if planted:
    binary += 'planted-identity-7731'.encode('utf-16-le') + b'kernel runtime section text ' * 400
zpath = os.path.join(out, root + '.zip')
with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(root + '/release.json', json.dumps({'schema': 1, 'name': 'deskpost', 'platform': 'win-x64', 'binary_version': version, 'source_commit': commit}))
    z.writestr(root + '/bin/library.exe', binary)
    z.writestr(root + '/README.md', '# Deskpost\n')
open(os.path.join(out, 'install.ps1'), 'w').write('# installer\n')
open(os.path.join(out, 'install.sh'), 'w').write('#!/bin/sh\n')
digest = hashlib.sha256(open(zpath, 'rb').read()).hexdigest()
open(os.path.join(out, 'SHA256SUMS'), 'w').write('%s  %s\n' % (digest, root + '.zip'))
PY
  [ -n "$4" ] && echo extra > "$r/$4"
  export GIT_INDEX_FILE="$D/rel-index"; rm -f "$GIT_INDEX_FILE"
  for f in "$r"/*; do git update-index --add --cacheinfo "100644,$(git hash-object -w "$f"),$(basename "$f")"; done
  tree="$(git write-tree)"; unset GIT_INDEX_FILE
  c="$(git commit-tree "$tree" -m "release $1")"
  git push -q "$D/src.git" "$c:refs/releases/$1"
}
tag_commit() {     # $1 tag -- a new commit on main, tagged
  echo "$1" > VERSION; git add VERSION; git commit -q -m "version $1"
  git tag -a "$1" -m "$1"; git push -q "$D/src.git" main "refs/tags/$1"
  git rev-parse "$1^{commit}"
}

run_job() {        # $1 new|old -- the job's environment as the workflow sets it, the API pointed at the stub
  ( cd "$D" && SOURCE_REPO="$D/src.git" TARGET_REPO="file://$D/gh/eKioga/deskpost.git" FORGEJO_TOKEN=x \
    MIRROR_GITHUB_PAT=fixture-pat IDENTITY_DENYLIST='planted-identity-7731' IDENTITY_ALLOWLIST='' \
    MIRROR_GITHUB_API_URL="http://127.0.0.1:$PORT" MIRROR_GITHUB_UPLOADS_URL="http://127.0.0.1:$PORT" \
    GITHUB_API_URL="http://127.0.0.1:9/a-runner-sets-this" GITHUB_UPLOADS_URL="http://127.0.0.1:9/a-runner-sets-this" \
    sh "$K/$1/scan-and-publish.sh" > "$D/run.log" 2>&1 )
}
dst_refs() { git --git-dir="$D/gh/eKioga/deskpost.git" for-each-ref --format='%(refname)'; }
posts() { grep -c '^POST' "$D/stub/requests.log" 2>/dev/null || echo 0; }

echo "slug: the production URL names the repository"
slug="$(printf '%s' 'https://github.com/eKioga/deskpost.git' | sed -e 's#\.git$##' -e 's#^[a-z]*://[^/]*/##')"
check '[ "$slug" = eKioga/deskpost ]' "https://github.com/eKioga/deskpost.git -> $slug"

echo "1. a clean release is published as a GitHub release, and its ref is not forwarded"
T1="$(tag_commit v0.2.0)"; make_release v0.2.0 "$T1" 0 ''
run_job new; e=$?
check '[ $e -eq 0 ]' "the job passed (exit $e)"
check 'dst_refs | grep -qx refs/tags/v0.2.0 && dst_refs | grep -qx refs/heads/main' 'main and the tag reached the public side'
check '! dst_refs | grep -q refs/releases/' 'no refs/releases ref reached the public side'
check 'grep -q "\"draft\": false" "$D/stub/requests.log" && grep -q "\"prerelease\": false" "$D/stub/requests.log" && grep -q "\"tag_name\": \"v0.2.0\"" "$D/stub/requests.log"' 'release v0.2.0 was created, not draft, not prerelease'
same=1; for f in "$D/rel-v0.2.0"/*; do cmp -s "$f" "$D/stub/uploads/v0.2.0__$(basename "$f")" || same=0; done
check '[ $same -eq 1 ] && [ "$(ls "$D/stub/uploads" | wc -l)" -eq 4 ]' 'all four assets uploaded byte for byte'

echo "2. a rerun publishes nothing twice"
before="$(posts)"; run_job new; e=$?
check '[ $e -eq 0 ] && [ "$(posts)" = "$before" ]' "the rerun passed with no new POST (exit $e, $(posts) POSTs)"

cp -r "$D/src.git" "$D/src-before-3.git"; cp -r "$D/gh/eKioga/deskpost.git" "$D/dst-before-3.git"
echo "3. a denied term INSIDE the compressed binary refuses the whole snapshot"
T3="$(tag_commit v0.2.1)"; make_release v0.2.1 "$T3" 1 ''
before="$(posts)"; run_job new; e=$?
check '[ $e -ne 0 ] && grep -q REFUSED "$D/run.log"' "the job refused (exit $e)"
check '! dst_refs | grep -qx refs/tags/v0.2.1' 'the tag did not reach the public side'
check '[ "$(posts)" = "$before" ]' 'no release was created or uploaded'

echo "3r. RED: the scanner WITHOUT the release step, on the same snapshot"
rm -rf "$D/old-src.git" "$D/old-dst"; cp -r "$D/src.git" "$D/old-src.git"
mv "$D/gh/eKioga/deskpost.git" "$D/dst-after-3.git"; cp -r "$D/dst-before-3.git" "$D/gh/eKioga/deskpost.git"
( cd "$D" && SOURCE_REPO="$D/old-src.git" TARGET_REPO="file://$D/gh/eKioga/deskpost.git" FORGEJO_TOKEN=x MIRROR_GITHUB_PAT=fixture-pat \
  IDENTITY_DENYLIST='planted-identity-7731' IDENTITY_ALLOWLIST='' sh "$K/old/scan-and-publish.sh" > "$D/old.log" 2>&1 ); e=$?
check '[ $e -eq 0 ] && dst_refs | grep -qx refs/releases/v0.2.1' "RED as expected: the old scanner passed (exit $e) and forwarded refs/releases/v0.2.1 with the planted binary"
echo "--- old.log"; tail -12 "$D/old.log"
rm -rf "$D/gh/eKioga/deskpost.git"; mv "$D/dst-after-3.git" "$D/gh/eKioga/deskpost.git"

git --git-dir="$D/src.git" update-ref -d refs/releases/v0.2.1
git --git-dir="$D/src.git" update-ref -d refs/tags/v0.2.1

echo "4. a release built from another commit than its tag is refused"
T4="$(tag_commit v0.2.2)"; make_release v0.2.2 "$T1" 0 ''
run_job new; e=$?
check '[ $e -ne 0 ] && grep -q "was built from" "$D/run.log"' "refused: $(grep -o 'FATAL.*' "$D/run.log" | head -1 | cut -c1-90)"
check '! dst_refs | grep -qx refs/tags/v0.2.2' 'the tag did not reach the public side'
git --git-dir="$D/src.git" update-ref -d refs/releases/v0.2.2

echo "5. a release carrying a file a release does not publish is refused"
make_release v0.2.2 "$T4" 0 notes.txt
run_job new; e=$?
check '[ $e -ne 0 ] && grep -q "carries notes.txt" "$D/run.log"' "refused: $(grep -o 'FATAL.*' "$D/run.log" | head -1 | cut -c1-90)"
git --git-dir="$D/src.git" update-ref -d refs/releases/v0.2.2

echo "6. the corrected release publishes"
make_release v0.2.2 "$T4" 0 ''
run_job new; e=$?
check '[ $e -eq 0 ] && dst_refs | grep -qx refs/tags/v0.2.2 && [ -f "$D/stub/uploads/v0.2.2__SHA256SUMS" ]' "published (exit $e)"

# S50, the reader's ruling: a tag with a pre-release suffix is created as a GitHub pre-release, so
# `releases/latest` -- the README's install route -- keeps serving the last full release.
created() { grep "^CREATED .*\"tag_name\": \"$1\"" "$D/stub/requests.log"; }
echo "7. a release candidate is created as a pre-release, and a full release is not"
T7="$(tag_commit v1.0.0-rc.1)"; make_release v1.0.0-rc.1 "$T7" 0 ''
run_job new; e=$?
check '[ $e -eq 0 ] && dst_refs | grep -qx refs/tags/v1.0.0-rc.1' "published (exit $e)"
check 'created v1.0.0-rc.1 | grep -q "\"prerelease\": true"' "v1.0.0-rc.1 was created as a pre-release: $(created v1.0.0-rc.1 | grep -o '"prerelease": [a-z]*')"
check 'created v0.2.2 | grep -q "\"prerelease\": false"' "v0.2.2 was not: $(created v0.2.2 | grep -o '"prerelease": [a-z]*')"

echo "---"
echo "fixture: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || { echo "--- last run.log"; tail -25 "$D/run.log"; }
