# Releasing Deskpost

How a release goes from `master` to the public download, and the exact commands that publish it. Recorded in S74
(1.2.5), because the push commands for 1.2.3 were never written down.

## The path

1. **Bump the version** on `master` in its own commit: `kernel/package.json`, `.codex-plugin/plugin.json`,
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

## The push (the only step that publishes)

From the publish clone, whose `origin` is `Kioga/deskpost`:

```
git -C <publish>\pub push --atomic origin main refs/tags/v<version> refs/releases/v<version>:refs/releases/v<version>
```

- **Atomic**, because the mirror job refuses a snapshot whose `refs/releases/<tag>` has no tag `<tag>` beside it
  (`docs/mirror-publishing-job.md`). One push carries all three refs, or none.
- Before it runs, check that the three SHAs are the ones the `READY` line printed:
  `git -C <publish>\pub rev-parse main v<version>^{commit} refs/releases/v<version>`.
- **What follows**: the mirror publishes `Kioga/deskpost` to `eKioga/deskpost` within about ten minutes. It pushes
  `main` and the tag, then makes the GitHub release from `refs/releases/<tag>`. Check both
  `https://github.com/eKioga/deskpost/releases/latest` and the tag's release page before telling anyone to upgrade.

`Kioga/library` (this checkout's `origin`) publishes nothing. A push there is ordinary development
(`docs/dev-session-loop.md`, "The mirror source").

## After the publish

- If the publish slipped a day, B corrects the release date in `docs/roadmap.md` on the next `desk/sNN`, which
  reaches `master` at that Kickoff's MERGE (B never commits on `master`). The public copy follows at the next release.
- Only once `releases/latest` names the new version, and it is newer than the installed one, is anyone given an
  upgrade line.
