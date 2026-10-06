# ADR-0068: The program checks for and fetches its own upgrades

**Status:** accepted
**Date:** 2026-10-05
**Effective from:** 1.3.6 (built in S92)
**Relates to:** [ADR-0066](0066-the-program-installs-itself.md) (the bootstrap `upgrade` runs, and the new version's
own install), [ADR-0067](0067-a-running-image-in-a-tree-being-removed-is-moved-aside.md) (a running image moved aside)

## Context

Through 1.3.5 a reader upgraded Deskpost by running an install line again, and for an install outside the default
folder that line needed `-InstallRoot` (or `--install-root`) and the folder typed by hand. Nothing said a version was
ready: the program had no version comparison, no network check and no upgrade verb (PLAN-one-step-upgrade.md, "Where
things stand"). An upgrade that met an open session refused and asked the reader to press Enter to look again. Eric's
direction (2026-10-05): `deskpost upgrade`, a main-menu line that says a version is ready, an upgrade that waits for
the last session instead of refusing, and one-liners that need no options.

## Decision

1. **One version comparison (D0).** `compareVersions(a, b)` compares the leading dotted integers component by
   component, a missing component counting as 0; equal integers with a different suffix are "different, not newer";
   a version with no leading integer is "could not tell". The latest version a release offers is the version in its
   one versioned `SHA256SUMS` line for the platform (`deskpost-<v>-<platform>.zip`); a file with only the unversioned
   twin names none.
2. **`deskpost upgrade` upgrades the install it runs from (D1).** Its root is `installRootOf(programRoot())`, never a
   guess and never `--install-root`; from a checkout or a release folder it refuses by name. `--check` reads only the
   release's `SHA256SUMS` (one GET of a public file from `releases/latest/download/`, no API call, no token, no
   identifier beyond any download's) and says ready, up to date, or why it could not tell, always exit 0, with
   `installed`, `latest`, `newer`, `checked_utc` and `error` under `--json`. Without `--check`, a release that is not
   newer is said and nothing changes; could-not-tell refuses; a newer one goes through `install`, so the bootstrap
   fetches and checks the release and the NEW version runs its own install (ADR-0066). `upgrade` passes only
   `install`'s flags (`--dry-run`, `--json`, `--plan-id`, `--yes`, `--wait`, `--path-change`, `--no-path-change`) and
   the root. Inside a seat's session (`LIBRARY_SEAT` or `LIBRARY_SEAT_CLAIM` set) an upgrade refuses, since it waits
   for every session, this one included; `--check` changes nothing and is answered anywhere.
3. **An upgrade waits for the last session to close (D3).** One wait serves install, upgrade, uninstall and rollback.
   Interactive, it lists what is open and looks again by itself every 2 seconds in raw mode; `q` or Ctrl+C stops it,
   and a terminal that refuses raw mode falls back to the Enter loop. With nobody to ask it refuses at once, or with
   `--wait <seconds>` looks again up to that limit. Held and orphaned seats both block, each labelled with what to
   close. The dry run names the open sessions beside the plan, outside what the plan id hashes.
4. **The menu says when a version is ready (D2).** At most once a day, from the interactive menu of an install only
   (never under `CI`, a non-TTY, `LIBRARY_SEAT` or `DESKPOST_UPDATE_CHECK=0`), the menu runs decision 2's check under a
   5-second timeout without blocking its first draw, records the result in `<root>\update-check.json`, and shows
   `Update   Deskpost <v> is ready (you have <u>)   u upgrade` only when the release is newer. This is the kernel's
   first network call the reader did not ask for; the install's plan screen and the README say so, and
   `DESKPOST_UPDATE_CHECK=0` turns it off. The line is drawn from the record whenever it is newer than the running
   program, outside a seat and unless the check is off, so a check that finished after the first draw shows it before
   the next prompt; `u` (accepted only while the line shows, on the seat list and on the no-seats screen) runs decision
   2 interactively from the record's `release`, then starts the new program's menu with this one's options, or tells a
   scripted menu to start it again. Two fixture switches, for proof that cannot be a terminal: `DESKPOST_UPDATE_CHECK=1`
   forces the check whenever the menu opens, and `DESKPOST_UPDATE_RELEASE` names the release it reads.
5. **The one-liners find the install themselves (D4).** When the default root holds nothing and exactly one install
   is found elsewhere, the run is about that install, said on its first line ("found on <via>") and bound by the plan
   id, with no extra question. A found install newer than the release is refused: no downgrade by a found install.

## Built

- **S92, before the cut:** decisions 1, 2 and 3, with the refusals in the caller's spelling (D6) and the install's
  PATH answer kept on upgrade (D5).
- **S92, after the cut:** decision 4 (row 8) and decision 5 (row 9): two or more installs found are refused, each
  named with its own upgrade line; `install.ps1` runs inside `& { }` so `| iex` leaves no strict mode, `'Stop'` or
  function in the caller's session (its one PowerShell edit); `install.sh` finds the install from the `deskpost` link
  by one level of `readlink`. Row 10 adds the pruning that one-step upgrades need (D7): after a committed upgrade only
  the two versions `current.json` names stay, an image still running from a pruned one is moved aside as ADR-0067
  says, and a folder that cannot go is a warning; `install.sh` keeps two and empties `downloads/`. Nothing parked.

## Alternatives considered

- **Ask GitHub's API for the latest release.** It is rate-limited without a token and returns more than the version.
  `SHA256SUMS` is already what every install reads, and its versioned line carries the version.
- **Download and compare the archive.** A check that downloads 50 MB to say "up to date" would be a cost the reader
  never asked for.
- **`upgrade --install-root <folder>`.** It would make `upgrade` a second spelling of `install`. The install a program
  runs from is the one it can name without a guess.
- **Refuse while sessions are open, as before.** The reader's next step was always to close them and try again; the
  program can do the looking.

## Consequences

- From 1.3.6 a reader upgrades with `deskpost upgrade`; 1.3.5 has no such verb, so the upgrade to 1.3.6 itself goes
  through a line.
- `deskpost upgrade --check` reads the network once per run; the menu's check reads it at most once a day per install.
- `install` gains `--wait <seconds>` and `--path-change`. The forwarder (`install.ps1`) carries neither, so an `irm`
  caller cannot wait.
