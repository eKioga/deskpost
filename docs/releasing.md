# Releasing Deskpost

How a reviewed release candidate goes to the public download, and the exact commands that publish it. Recorded in S74
(1.2.5), because the push commands for 1.2.3 were never written down.

## The path

1. **Bump the version** on the release's `int/<kickoff>` branch in its own gated commit: `kernel/package.json` and the two root `version` lines of
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
   This commit and the release-notes text form the candidate. Record the second reader's review
   of that exact candidate SHA by [the loop's rule](dev-session-loop.md#the-second-reader) before
   any credential-bearing step. Then check routes: `git ls-remote` and reading the mirror workflow
   prove connectivity and read access only. Read Forgejo `permissions.push` where available; record
   authorization without a non-mutating source as unverified until publish. Secrets resolve only
   through `deskpost_secrets.py`'s service-account route, without printed values or bare `op`.
2. **Prepare that candidate, locally, in a publish folder** outside the checkout (`<publish>`),
   under a release-preparation Kickoff. A changed candidate returns to step 1 and invalidates review.
   A failed review or route check means a Report and deskpost-dev prepares after its weekly usage reset.
   The folder holds the publish script, its
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
3. **Publish, on Eric's separate named `publish X`**: one atomic push from the publish clone, bound
   to the reviewed candidate SHA and the exact READY refs. Refuse if either moved. Nothing else publishes a release.
4. **Start the mirror** right after the push: the release session starts the `publish-mirror` workflow on
   `Kioga/deskpost-ops` itself, through Forgejo's API (`workflow_dispatch`). It is never the reader's manual step. If
   the start fails, the release session says so, and the mirror's daily run (12:00 UTC) publishes within a day.
   **The token never comes from a bare `op`**: a seat shell has no 1Password account. Read the item
   `forgejo-dispatch (deskpost)` once through `deskpost_secrets.py`'s `_op`
   (`D:\dev\projects\deskpost-secrets`), which hands this PC's service-account token to `op` in its child
   environment only and keeps `op`'s first error line. Then one dispatch call and one status read. The
   steps and the script: "Starting the mirror" below, which any release seat can read (it ran green in S107).

## Proving a release (steps 1-2 in practice)

Re-read installed `codex --help` and `claude --help`: compare their approval, sandbox and permission-mode
values with `LAUNCH_ACCESS_VALUES` beside `LAUNCH_FLAG_TABLE` in `kernel/src/seatlaunch.ts`. A changed list
needs a source correction and its tests before the release candidate is judged.

The checks every release session has run since 1.3.8 (S100, S107, S111, S113, S114), written here so that any release
seat, Codex or Claude Code, reads one recipe instead of a chain of Kickoffs on another seat's Hub. `<new>` is the
version being released, `<prev>` the one before it, `<pf>` the publish folder `D:\dev\releases\deskpost\publish`. A
Kickoff adds the checks its own release needs (the reads of what it ships) and may override anything here; where it
is silent, this section holds.

**The bump commit** ("Deskpost `<new>`", step 1): `<prev>` to `<new>` at every site and nowhere else. Find the sites
with `git grep -n "<prev>"` (escape the dots); what is left afterwards is history (the roadmap's earlier entries, plans,
ADRs, kernel comments, `kernel/test/`, `tools/`, examples), listed in the commit message. If the release seat's build
needs `kernel/node_modules`, `npm ci --offline` in `kernel/`, recorded.

**The publish folder** `<pf>\v<new>` holds only four files at first: copies of `<pf>\v<prev>\prepare.ps1` and
`audit-archives.ps1`, and `pub-commit.txt` (ASCII, LF, shaped like `v<prev>`'s: the title line, the release's name,
one bullet per reader-facing change in reader words, then "How to upgrade"; no matrix, self-test, fixtures or rulings)
and `pub-tag.txt` (`Deskpost <new>`). The scripts change only in the lines that name the release, shown by `diff`
against `v<prev>`'s copies:

- `prepare.ps1`: the header line (the session and `v<new>`), `$d` (`<pf>\v<new>`), `$tag` (`v<new>`), and
  `-PreviousRelease` (`<pf>\v<prev>\rel`);
- **`prepare.ps1`'s `$app`**: the checkout the release is built from. The script takes the program commit as
  `git -C $app rev-parse HEAD` and loads `DeploymentScan.ps1`, `Build-KernelRelease.ps1` and `Test-BuiltRelease.ps1`
  from it. Earlier copies name `D:\deskpost\app`; a release from any other checkout names that checkout, and checks
  first that its `HEAD` is the release commit and its tree is clean. A wrong `$app` builds and publishes the wrong tree;
- `audit-archives.ps1`: its header (keeping "S58" and naming `v<new>`), `$d`, and the checkout it dot-sources
  `DeploymentScan.ps1` from (the same one as `$app`).

**Build and judge, before `prepare.ps1`**, from a clean clone of the release commit (`git clone -c
core.autocrlf=false`) in the session's scratch folder:

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '<clone>\tools\Build-KernelRelease.ps1' -SourceRoot
   '<clone>' -Target 'win-x64','linux-x64' -Destination '<scratch>\rel'"` (`-Target` takes a list only through
   `-Command`); `byte_audit` clean; eight files in `rel` (both versioned zips, the two unversioned twins, `SHA256SUMS`,
   `install.ps1`, `install.sh`, `llms-install.md`).
2. `tools/Test-BuiltRelease.ps1 -Release <scratch>\rel -PreviousRelease <pf>\v<prev>\rel -Work <scratch>\fx` to
   "All N release fixtures passed", run from a neutral folder.
3. The compiled self-test sections (as of 1.4.3: 115-117, 129-138, 143, 144 with its built-release half, 146-151) with
   `LIBRARY_SELFTEST_KERNEL` naming the release's own extracted `library.exe` (Windows' `tar.exe -xf`) and
   `LIBRARY_SELFTEST_PREVIOUS_INSTALLER` a copy of `<pf>\v<prev>\rel\install.ps1`; `DESKPOST_UPDATE_CHECK` unset; a
   count of `library.exe` and `selftest-win.exe` processes before and after.

**Every install line's run is fenced.** The child's environment sets `DESKPOST_PATH_KEY` to a twin registry key (made
and deleted with `reg.exe` from node), `TEMP`, `TMP` and `LOCALAPPDATA` to fixture folders, `LIBRARY_WORKSPACES` to the
fixture's registry, the seat variables blank, no `deskpost` folder on PATH, `DESKPOST_UPDATE_CHECK=0`, and for
`upgrade` runs `--release <rel>` with `DESKPOST_UPDATE_RELEASE` naming the built `rel` too. Before each line's first
real run, its dry run must name the fixture's `install_root`; if it names the real install or the real
`%LOCALAPPDATA%\deskpost`, stop that step. The only text substituted in a line is the release base; record each
substituted line. Nothing installs, upgrades, rolls back or repairs the real install or the real Library.

**The upgrade from `<prev>`**, in a fixture laid out as a long-time reader's install: `<prev>` installed by
`<pf>\v<prev>\rel\install.ps1` at a non-default root, its `bin` on the twin key; a Library with Hubs, a Shelf Book with
a topic folder, two seats (one with `added-dirs.json`, one with inbound `hold`), one letter for a seat and one for a
department, and the Library's own keys in `.claude/settings.local.json`; a copy of the registry's bytes. Two copies:

- **`deskpost upgrade`** from the fixture's own `bin` (`<prev>`'s binary doing the upgrade): dry run, `--yes`, then the
  same again, which must give the same-version answer;
- **the bare `| iex` line** in one `powershell.exe` child, run twice in the same shell, with `Get-Variable` before and
  after (no variable added but the check script's own).

Each checked item by item: exactly one "Upgrading Deskpost `<prev>` to `<new>` at `<root>`." in each dry run and
`--yes`; each Library brought up to date once; `current.json` names `<new>`, previous `<prev>`; `versions` and the
shims as the previous release left them plus `<new>`; the twin key's entry present once; the Library's own keys
untouched; the registry unchanged unless the release means to change it. **Then the hooks:** every hook and
status-line command in the fixture Library's `.claude/settings.json` and `.claude/settings.local.json`, and
`.codex/hooks.json`'s (PowerShell strings: run them through `powershell.exe -NoProfile -Command`), once each against
the installed `<new>` with a minimal JSON payload of that event's shape. **None may be refused**; a refusal is
release-blocking. Record each command and its exit. Then the Kickoff's own reads. From Git Bash with the fixture's
`bin` first on PATH (the `/c/...` form), `deskpost --version` prints `<new>`. Then two forwarder dry runs with
`DESKPOST_LIBRARY=<A>`: without `-Library` the plan's Library row names A, with `-Library <B>` it names B. **Rollback
to `<prev>` last** (the first copy, `versions\<new>\bin\library.exe rollback --yes --json`), and `library desk` and
doctor under `<prev>` on what `<new>` wrote: each exit and its first refusal or WARN line. A `<prev>` that refuses is
not a blocker; it is a "How to upgrade" line and a morning item.

**Linux**, in the WSL distro `deskpost-clean` (`wsl.exe -d deskpost-clean --exec sh -c ...`, with
`MSYS_NO_PATHCONV=1` from Git Bash): each run with its own fresh `HOME` under `/tmp`, no `deskpost` on PATH
(`command -v deskpost` empty first), the release's Linux files in over stdin (nothing mounted):

- **the bare line on a fresh login**: `curl -fsSL file://$HOME/stage/rel/install.sh | DESKPOST_RELEASE=$HOME/stage/rel
  sh` with `~/.local/bin` not on PATH: exit 0, doctor's "Nothing failed", the PATH line last;
- **the upgrade**: `<prev>` installed by its own `install.sh` with `DESKPOST_INSTALL_ROOT=$HOME/apps/deskpost`, then
  `<new>`'s line with no `DESKPOST_INSTALL_ROOT`: the first line names `$HOME/apps/deskpost`, `versions` holds both, the
  `deskpost` link unchanged; doctor's program checks listed by name.

Both `HOME`s deleted afterwards by the program that made them; the distro stopped again if it was stopped.

**The compiled arm**: `tools/Invoke-AcceptanceMatrix.ps1 -All -Kernel <rel's win-x64 library.exe>`, no
`-IncludeShared`, alone. Every differential row green except the two known init-rerun rows. A difference the release
means (a Kickoff or an attempt page names the field) is approved as a delta with `approved_by` naming the Kickoff,
value patterns at absent, null, `0`, `all` or `none` where they can, in one commit, `acceptance.matrix-shape` green,
the rows rerun green. Any other difference is a defect. **A delta commit changes the release commit**: build and judge
again from it, and, where the release needs a review of the candidate first, the candidate is new.

**`prepare.ps1` to READY**: run it from `<pf>\v<new>` to `READY: main <sha>, tag v<new>, refs/releases/v<new>; nothing
pushed`. Then check: its `library.exe` byte-identical to the one judged; eight files in `rel`; `git ls-tree
refs/releases/v<new>` gives each versioned zip and its twin the same blob; the public README (read from the clean
clone, not a CRLF checkout) says "The current release is **`<new>`**"; the public roadmap has `<new>` under Released.

**The publish question**, asked as its own question once READY prints: first, in its own call,
`git -C <pf>/v<new>/pub rev-parse main v<new>^{commit} refs/releases/v<new>` and show the three SHAs match READY;
also verify the source HEAD still equals the reviewed candidate SHA; then
the one push command ("The push" below). It runs only on a reply that names the action ("publish `<new>`"), never a
bare "yes". After the push, start the mirror ("Starting the mirror").

**Rules for the whole run.** One heavy job at a time: never a build, `Test-BuiltRelease`, `prepare.ps1`, a matrix run,
a WSL run, a self-test run or a gate beside another. `DESKPOST_UPDATE_CHECK` unset for the compiled sections and every
gate. In Git Bash: a PATH entry in the `/c/...` form, never `C:/...`; `MSYS_NO_PATHCONV=1` where an argument starts
with `/`; text holding backslashes written with an editor tool, never through a heredoc or `sed`. A fixture never names
a real person, domain or account. Fixtures are made and removed by the one program that uses them. No `git fetch`;
`npm` only with `--offline`; no network read beyond `prepare.ps1`'s clone of the public repository until the publish.

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

## Starting the mirror (step 4)

How a release session starts `publish-mirror` on `Kioga/deskpost-ops` right after the publish push. First done in
S107 (run 3137); the route is home-lab-admin's (its letter of 2026-10-09). Moved here from deskpost-dev's Hub
(`notes/how-to-start-the-publish-mirror`) so that every release seat, Codex or Claude Code, reads the same steps.

**When.** Only after the publish push to `Kioga/deskpost` has landed, and only under a Kickoff's CHARTER or the
reader's explicit yes. One 1Password item read, ONE dispatch call, ONE status read. Do not poll. If any step fails,
the mirror's daily run (cron `0 12 * * *`, 12:00 UTC) publishes within a day; say so at close.

**The token: never with a bare `op`.**

- A bare `op` in a seat shell has **no 1Password account** ("No accounts configured for use with 1Password CLI").
  S107's first read failed exactly that way (exit 1).
- The working route: `D:\dev\projects\deskpost-secrets\deskpost_secrets.py`, whose `_op` reads this PC's
  service-account token from Windows Credential Manager (`deskpost/<COMPUTERNAME>/1password`) and passes it to `op`
  **in the child process environment only**, and on failure keeps `op`'s first error line.
- The item is `forgejo-dispatch (deskpost)` in vault `Deskpost`, an **API Credentials** item: read its `credential`
  and `hostname` fields from `op item get ... --reveal --format json`. `get_login` does not fit it (no username or
  password).
- Never print, log or export the Forgejo token, not even its length. Send it only as `Authorization: token <value>`.
- To check the route without reading the item:
  `python D:\dev\projects\deskpost-secrets\deskpost_secrets.py check` (names only: token found, `op` version, signed
  in as `SERVICE_ACCOUNT`, item titles).

**The calls.** The Forgejo host is the one this checkout's `origin` names (`git remote get-url origin`); it is not
written here.

- `POST https://<host>/api/v1/repos/Kioga/deskpost-ops/actions/workflows/publish.yml/dispatches` with
  `{"ref": "main", "return_run_info": true}`: 201 with `{id, run_number, jobs}`, or 204.
- Then ONE `GET /api/v1/repos/Kioga/deskpost-ops/actions/runs/{id}`. Right after dispatch it reads `waiting`.
- A 500 "workflow not found" means a wrong file name, not scope. **A 403 means the token lost its scope: record it,
  tell home-lab-admin, never retry with another token.**
- Before the yes, use Git's stored login to run `git ls-remote https://<origin-host>/Kioga/deskpost-ops.git refs/heads/main`, then `git clone --depth 1 --no-checkout https://<origin-host>/Kioga/deskpost-ops.git <scratch>/ops`. Read `.forgejo/workflows/publish.yml` with `git -C <scratch>/ops show HEAD:.forgejo/workflows/publish.yml` and check `workflow_dispatch:`. Run this in one program's temporary-directory context so it removes the scratch clone after its child processes exit; do not read or print a credential.

**The script.** Save it to the session's scratch folder as `mirror_start.py` and run `python -I mirror_start.py`
from this checkout (it reads the host from `origin`). Read it end to end first: S107's first green read was wasted by
a leftover line that crashed after the read and before the call, and a syntax check (`python -I -m py_compile`) does
not catch that. The one change from S107's script: `EXPECTED_HOST` comes from `origin` instead of a literal.

```python
# Start publish-mirror on Kioga/deskpost-ops: ONE 1Password read, ONE workflow_dispatch call, ONE status read.
# The Forgejo token is never printed, logged or put in this process's environment; it is sent only as the
# Authorization header. The 1Password service-account token goes to `op` in its child environment only.
import importlib.util
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request

origin = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=True).stdout.strip()
EXPECTED_HOST = urllib.parse.urlsplit(origin).hostname
if not EXPECTED_HOST:
    print("This checkout's origin is not an https URL; no 1Password read made.")
    raise SystemExit(2)
REPO = "Kioga/deskpost-ops"

spec = importlib.util.spec_from_file_location("deskpost_secrets", r"D:\dev\projects\deskpost-secrets\deskpost_secrets.py")
secrets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(secrets)
try:
    raw = secrets._op("item", "get", "forgejo-dispatch (deskpost)", "--vault", "Deskpost", "--reveal", "--format", "json")
except secrets.SecretError as exc:
    print(f"1Password read failed: {exc}; no API call made.")
    raise SystemExit(2)
data = json.loads(raw)
del raw
fields = {f.get("id") or f.get("label"): f.get("value") for f in data.get("fields", [])}
fields.update({f.get("label"): f.get("value") for f in data.get("fields", []) if f.get("label")})
del data
token = fields.get("credential")
host = (fields.get("hostname") or "").strip().removeprefix("https://").removesuffix("/")
if not token:
    print("The item has no credential field; no API call made.")
    raise SystemExit(2)
if host != EXPECTED_HOST:
    print("The item's hostname is not origin's host; no API call made.")
    raise SystemExit(2)
headers = {"Authorization": f"token {token}", "Content-Type": "application/json", "Accept": "application/json"}


def call(method, url, body=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


base = f"https://{EXPECTED_HOST}/api/v1/repos/{REPO}/actions"
status, text = call("POST", f"{base}/workflows/publish.yml/dispatches", {"ref": "main", "return_run_info": True})
print(f"dispatch: HTTP {status}")
if status not in (200, 201, 204):
    raise SystemExit(1)
run_id = None
if text.strip():
    info = json.loads(text)
    run_id = info.get("id")
    print(f"run id {run_id}, run_number {info.get('run_number')}, jobs {json.dumps(info.get('jobs'))[:200]}")
if run_id is None:
    print("No run id returned (204); no status read made.")
    raise SystemExit(0)
status, text = call("GET", f"{base}/runs/{run_id}")
print(f"status read: HTTP {status}")
if status == 200:
    run = json.loads(text)
    print(f"run {run.get('id')}: status {run.get('status')}, conclusion {run.get('conclusion')}")
```

**Afterwards.** Record the run id, run number and the one status on the attempt page. Give no upgrade line: the
planner (deskpost-desk) checks `https://github.com/eKioga/deskpost/releases/latest` and its assets once the run has
finished, then gives the reader the upgrade steps, starting with `deskpost upgrade --dry-run`.

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
