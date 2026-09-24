#!/bin/sh
# Install the Library on macOS or Linux from a release: verify it, place it in a versioned directory,
# switch the `library` symlink to it, register the plugin, and let `library doctor` say whether it
# worked. PLAN-public-release.md step 28; install.ps1 is the Windows half and says the same things at
# more length.
#
#   curl -fsSL https://github.com/eKioga/deskpost/releases/latest/download/install.sh | sh
#
# Environment, all optional:
#   DESKPOST_RELEASE       a folder holding SHA256SUMS and the archives, or the base URL they are served from
#   DESKPOST_INSTALL_ROOT  defaults to ${XDG_DATA_HOME:-$HOME/.local/share}/deskpost
#   DESKPOST_BIN_DIR       where the `library` symlink goes; defaults to $HOME/.local/bin
#   DESKPOST_WORKSPACE     the workspace `library doctor` reports on
#   DESKPOST_SKIP_PLUGIN   set to 1 to skip the marketplace and plugin install
#   DESKPOST_ROLLBACK      set to 1 to switch back to the previously installed version
#
# FIRST RUN ON LINUX 2026-09-23 (S42), in a clean WSL2 Ubuntu 24.04 distro logged in as root, with git,
# curl and python3 and no unzip, node, bun or PowerShell: it verified, extracted (through python3, see
# extract_zip), switched both links, refused a second 0.1.0 from a different archive, and doctor ran.
# There, root's ~/.profile does not put ~/.local/bin on PATH, which the warning below names. NOT YET RUN
# ON macOS.

set -eu

RELEASE="${DESKPOST_RELEASE:-https://github.com/eKioga/deskpost/releases/latest/download}"
INSTALL_ROOT="${DESKPOST_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/deskpost}"
BIN_DIR="${DESKPOST_BIN_DIR:-$HOME/.local/bin}"
VERSIONS="$INSTALL_ROOT/versions"

fail() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

replace_link() {
  # A new link beside the old one, then one rename over it: whatever is started at any instant sees
  # one target or the other. `mv -T` is GNU; BSD mv replaces a symlink to a directory the same way
  # when given -h, so each is asked for what it has.
  ln -sfn "$1" "$2.incoming"
  if mv -T "$2.incoming" "$2" 2>/dev/null; then :;
  else mv -fh "$2.incoming" "$2"; fi
}

switch_link() {
  # $INSTALL_ROOT/current -> versions/<v> is the program root the binary reports and every hook path
  # `library init` writes (S30, the reader's ruling), so an upgrade does not move it. The `library`
  # link runs through it and is the same for every version.
  [ -e "$INSTALL_ROOT/current" ] && [ ! -L "$INSTALL_ROOT/current" ] &&
    fail "$INSTALL_ROOT/current is a real directory, not the link the installer keeps there; move it aside and re-run."
  replace_link "$VERSIONS/$1" "$INSTALL_ROOT/current"
  mkdir -p "$BIN_DIR"
  replace_link "$INSTALL_ROOT/current/bin/library" "$BIN_DIR/library"
  printf '{"schema":1,"version":"%s","previous":"%s","archive_sha256":"%s"}\n' "$1" "$2" "$3" > "$INSTALL_ROOT/current.json.incoming"
  mv -f "$INSTALL_ROOT/current.json.incoming" "$INSTALL_ROOT/current.json"
}

json_field() {
  # One flat string or number field out of a small JSON document, without requiring jq.
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -n 1
}

assert_tuple() {
  # The binary is asked, not the file beside it: a binary that cannot find its program says so here.
  reported="$("$1/bin/library" --version)" || fail "$1/bin/library does not run on this machine."
  for field in plugin_version binary_version workspace_schema; do
    want="$(json_field "$field" < "$1/release.json")"
    got="$(printf '%s' "$reported" | tr -d '\n' | json_field "$field")"
    [ "$want" = "$got" ] || fail "the installed binary reports $field $got; release.json says $want."
  done
  printf '%s' "$reported" | tr -d '\n' | grep -q '"compiled"[[:space:]]*:[[:space:]]*true' || fail "$1/bin/library does not report itself compiled."
}

current_field() { [ -f "$INSTALL_ROOT/current.json" ] && json_field "$1" < "$INSTALL_ROOT/current.json" || true; }

if [ "${DESKPOST_ROLLBACK:-0}" = 1 ]; then
  previous="$(current_field previous)"; now="$(current_field version)"
  [ -n "$previous" ] || fail "nothing to roll back to: $INSTALL_ROOT/current.json names no previous version."
  [ -x "$VERSIONS/$previous/bin/library" ] || fail "the previous version $previous is no longer under $VERSIONS."
  assert_tuple "$VERSIONS/$previous"
  switch_link "$previous" "$now" "$(cat "$VERSIONS/$previous/.archive-sha256" 2>/dev/null || true)"
  say "library now runs $previous again. The plugin is not rolled back by this switch."
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=macos-arm64 ;;
  Darwin-x86_64) PLATFORM=macos-x64 ;;
  Linux-x86_64) PLATFORM=linux-x64 ;;
  Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
  *) fail "no release is built for $(uname -s) $(uname -m)." ;;
esac

DOWNLOADS="$INSTALL_ROOT/downloads"
mkdir -p "$DOWNLOADS" "$VERSIONS"

fetch() {
  if [ -d "$RELEASE" ]; then cp "$RELEASE/$1" "$DOWNLOADS/$1"
  else curl -fsSL "${RELEASE%/}/$1" -o "$DOWNLOADS/$1" || fail "could not download ${RELEASE%/}/$1."; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

say "Reading the release's checksums from $RELEASE"
fetch SHA256SUMS
lines="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?deskpost-[0-9A-Za-z.+-]+-$PLATFORM\.zip[[:space:]]*$" "$DOWNLOADS/SHA256SUMS" || true)"
[ "$(printf '%s' "$lines" | grep -c . || true)" = 1 ] || fail "SHA256SUMS does not name exactly one archive for $PLATFORM."
expected="$(printf '%s' "$lines" | cut -d' ' -f1)"
archive="$(printf '%s' "$lines" | sed 's/^[0-9a-f]*[[:space:]]*\*\{0,1\}//; s/[[:space:]]*$//')"

say "Verifying $archive"
fetch "$archive"
actual="$(sha256_of "$DOWNLOADS/$archive")"
if [ "$actual" != "$expected" ]; then
  rm -f "$DOWNLOADS/$archive"
  fail "$archive hashes to $actual and SHA256SUMS says $expected. Nothing was installed, and the download was deleted."
fi

extract_zip() {
  # A stock Ubuntu 24.04 has no unzip and does have python3 (measured S42, in a clean WSL2 distro).
  # The archive holds regular files only, and the two executables are chmod-ed below, so python3's
  # zipfile, which drops the mode bits, extracts the same tree.
  if command -v unzip >/dev/null 2>&1; then unzip -q "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else fail 'unzip or python3 is needed to extract the release.'; fi
}

incoming="$VERSIONS/.incoming-$$"
rm -rf "$incoming"; mkdir -p "$incoming"
trap 'rm -rf "$incoming"' EXIT
extract_zip "$DOWNLOADS/$archive" "$incoming"
[ "$(ls "$incoming" | wc -l | tr -d ' ')" = 1 ] || fail "$archive does not hold exactly one top-level folder."
extracted="$incoming/$(ls "$incoming")"
chmod 0755 "$extracted/bin/library" "$extracted/library"
[ "$(json_field platform < "$extracted/release.json")" = "$PLATFORM" ] || fail "$archive is not built for $PLATFORM."
version="$(json_field plugin_version < "$extracted/release.json")"
printf '%s' "$version" | grep -Eq '^[0-9A-Za-z.+-]+$' || fail "release.json's version cannot name a directory."

if [ -d "$VERSIONS/$version" ]; then
  [ "$(cat "$VERSIONS/$version/.archive-sha256" 2>/dev/null || true)" = "$actual" ] ||
    fail "version $version is already installed from a different archive; two trees under one version number is a defect in the release."
  say "Version $version is already installed from this archive; reusing it"
else
  assert_tuple "$extracted"
  mv "$extracted" "$VERSIONS/$version"
  printf '%s\n' "$actual" > "$VERSIONS/$version/.archive-sha256"
fi
assert_tuple "$VERSIONS/$version"

now="$(current_field version)"
if [ -n "$now" ] && [ "$now" != "$version" ]; then previous="$now"; else previous="$(current_field previous)"; fi
switch_link "$version" "$previous" "$actual"
say "library now runs $version ($BIN_DIR/library)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "$BIN_DIR is not on PATH; add it to your shell profile." ;; esac

if [ "${DESKPOST_SKIP_PLUGIN:-0}" != 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    if claude plugin marketplace add "$INSTALL_ROOT/current" && claude plugin install deskpost@deskpost; then
      say "Claude Code plugin installed from $INSTALL_ROOT/current"
    else
      say "The Claude Code plugin install FAILED; the binary is installed."
    fi
  else
    say "claude is not on PATH. Run: claude plugin marketplace add \"$INSTALL_ROOT/current\" && claude plugin install deskpost@deskpost"
  fi
  say "Codex has no non-interactive plugin install yet. In Codex, run /plugins and add the marketplace at $INSTALL_ROOT/current."
fi

say 'Running library doctor'
if [ -n "${DESKPOST_WORKSPACE:-}" ]; then
  "$INSTALL_ROOT/current/bin/library" doctor --workspace "$DESKPOST_WORKSPACE"
else
  "$INSTALL_ROOT/current/bin/library" doctor
fi || fail 'library doctor is not green, so this install is not accepted. It is in place; DESKPOST_ROLLBACK=1 switches back.'
