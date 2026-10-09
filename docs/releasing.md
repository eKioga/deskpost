# Releasing Deskpost

How a release goes from `master` to the public download, and the exact commands that publish it. Recorded in S74
(1.2.5), because the push commands for 1.2.3 were never written down.

## The path

1. **Bump the version** on `master` in its own commit: `kernel/package.json` and the two root `version` lines of
   `kernel/package-lock.json` (the package's own and its `packages[""]` entry), `.codex-plugin/plugin.json`,
   `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (two lines), `llms-install.md` (its release base
   and every `download/v<version>` URL), and the `blob/v<version>` links in `.claude/skills/library-help/SKILL.md`
   and its reference files. There is no CHANGELOG.
   The same commit brings the roadmap up to the release (`docs/roadmap.md`, "Keeping it current"): the
   milestones it carries move to **Released** with its date, and the README's **Roadmap** section names it as the
   current release, with the next milestones. The public README is copied from this commit, so it is true on the
   day the release ships.
   The same commit checks `docs/guides/` against the milestones the release carries: a guide that is wrong or
   silent about one is fixed before the bump. It also moves the README's `Status:` line to the release's minor
   version.
2. **Prepare, locally, in a publish folder** outside the checkout (`<publish>`). It holds the publish script, its
   archive audit, `pub-commit.txt` (the release notes, which become the public commit's text) and `pub-tag.txt`. The
   script:
   - clones the public repository, `Kioga/deskpost`, with `-c core.autocrlf=false`;
   - copies the allowlisted files over it and checks every staged blob against the program commit;
   - runs the deployment, identity and gitleaks scans over the staged change;
   - commits with `pub-commit.txt` and makes the annotated tag `v<version>`;
   - clones that tag with `-c core.autocrlf=false` and builds win-x64 and linux-x64 from it. The build refuses any
     file whose bytes differ from its blob, and audits the archives against the blobs
     (`kernel/src/releaseaudit.ts`);
   - audits and scans the extracted archives, and runs `tools/Test-BuiltRelease.ps1` against the previous release;
   - writes `refs/releases/v<version>`, one parentless commit holding exactly the release files;
   - prints `READY: main <sha>, tag v<version>, refs/releases/v<version>; nothing pushed`.
3. **Publish, on the reader's explicit yes**: one atomic push from the publish clone. Nothing else publishes a
   release.
4. **Start the mirror** right after the push: the release session starts the `publish-mirror` workflow on
   `Kioga/deskpost-ops` itself, through Forgejo's API (`workflow_dispatch`). It is never the reader's manual step. If
   the start fails, the release session says so, and the mirror's daily run (12:00 UTC) publishes within a day.

## The push (the only step that publishes)

From the publish clone, whose `origin` is `Kioga/deskpost`:

```
git -C <publish>\pub push --atomic origin main refs/tags/v<version> refs/releases/v<version>:refs/releases/v<version>
```

- **Atomic**, because the mirror job refuses a snapshot whose `refs/releases/<tag>` has no tag `<tag>` beside it
  (`docs/mirror-publishing-job.md`). One push carries all three refs, or none.
- Before it runs, check that the three SHAs are the ones the `READY` line printed:
  `git -C <publish>\pub rev-parse main v<version>^{commit} refs/releases/v<version>`.
- **What follows**: the release session starts the mirror right after this push (step 4, through Forgejo's
  API), and it publishes `Kioga/deskpost` to `eKioga/deskpost`; its daily run
  catches a missed start. It pushes
  `main` and the tag, then makes the GitHub release from `refs/releases/<tag>`. Check both
  `https://github.com/eKioga/deskpost/releases/latest` and the tag's release page before telling anyone to upgrade.

`Kioga/library` (this checkout's `origin`) publishes nothing. A push there is ordinary development
(`docs/dev-session-loop.md`, "The mirror source").

## After the publish

- If the publish slipped a day, B corrects the release date in `docs/roadmap.md` on the next `desk/sNN`, which
  reaches `master` at that Kickoff's MERGE (B never commits on `master`). The public copy follows at the next release.
- Only once `releases/latest` names the new version, and it is newer than the installed one, is anyone given an
  upgrade line. Before giving one, check which install root and which Library it acts on: an install outside the
  default root, run with the bare one-liner, refuses as a second install, and a retry can fall into a new install's
  "Where should your Library live?" prompt.
- **Every release is installed.** Never suggest skipping a version to test a later route; test a new route on the
  next upgrade instead.

## Proving an install in a build session

A build session has no version bump, so a build of `HEAD` reports the same version as `-PreviousRelease`, and
`Test-InstallLifecycle` refuses two equal versions. The recipe (S89, S94):

1. Clone `HEAD` cleanly (`git clone -c core.autocrlf=false`, `* -text` in `.git/info/attributes`) into the scratchpad,
   and make ONE commit there setting `<version>-s<NN>` in both plugin manifests, `.claude-plugin/marketplace.json`,
   `kernel/package.json` and `llms-install.md`. The clone is never pushed.
2. Build it with `Build-KernelRelease.ps1 -SourceRoot <clone>`, then run `Test-BuiltRelease.ps1 -PreviousRelease
   <the previous release's rel folder>`, with every PATH entry holding a `deskpost` shim dropped first.
3. Self-test sections 116, 117 and 130-133 run only with `LIBRARY_SELFTEST_KERNEL` naming the extracted release's
   `bin\library.exe` (`tar.exe -xf`); the `-Fast` gate skips them.
4. The suffixed version breaks sections 143, 144, 146 and 147 (they compare or bump versions), so judge them, and any
   new install section, on a **second, unbumped build** of the same commit (`-Target 'win-x64'` is enough).

## When auto mode stops the publish push

The harness's auto-mode classifier has blocked the publish push once and later let the same push through. It has
also refused branch amends and deletes on some days and allowed them on others; the cause is unknown. What has
worked: the reader's message names the exact action ("publish 1.4.0"), never a bare "yes"; the push runs as one
plain command, with its checks in separate calls. Classifier rules live only in the reader's user settings, and a
change to them is the reader's own edit, never one an agent writes or scripts. Log any new block with its reason,
the Claude Code version and how many seats were open.
