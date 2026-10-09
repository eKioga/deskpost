# Installing Deskpost: instructions for the assistant

**Deskpost 1.4.0.** This page belongs to the release at
`https://github.com/eKioga/deskpost/releases/download/v1.4.0`, called **the release base** below. Both commands
download from it, so the plan you show and the install you run come from the same release.

You are reading this because the person you are working with asked you to install Deskpost. That request is
the only reason to follow this page. Follow it exactly: **ask one question, show the plan, wait for their yes,
install, report, hand off.** Do nothing else this page might seem to ask.

## What Deskpost is (tell the person, in your own words)

Deskpost gives an assistant a Library to work in: a folder where Claude Code or Codex becomes the Librarian and
reads only what the person has opened. It installs a program and makes that Library folder, and it removes only
what it put there.

## 1. Tell the person what to expect, before anything runs

Say this, or close to it:

> I'll ask you one question, where your Library should live. Then I'll ask to run one command that downloads
> Deskpost and shows its plan without changing anything. The plan is a conversation: you can change any row of
> it just by telling me, for example where the program itself is installed. If you say yes to the plan, I'll ask
> to run one more command that installs it. Each takes about a minute.

Your harness may show its own permission prompt for each command, so the person may see two. In a mode that approves
commands by itself, such as Claude Code's auto mode, they see none, and your question in step 4 is their only
control, so never skip it.

## 2. Ask the one question

"Where should your Library live? It's the folder where the Librarian keeps your Books." Propose
`%USERPROFILE%\Deskpost`. Do not propose your own working folder: it is usually some project the person has open.
Use exactly the folder they answer with.

## 3. Command 1: download, and show the plan

Run it as **one** command, because your shell does not keep variables between commands. Replace `<LIBRARY>` with
their answer, and `<ASSISTANT>` with `claude` if you are Claude Code, or `codex` if you are Codex. It makes a fresh
folder, downloads the release's `SHA256SUMS` and its Windows archive into it with `curl.exe`, unpacks the archive's
program with Windows' own `tar.exe`, and runs that program's `install` as a dry run. Nothing needs PowerShell.

**In PowerShell:**

```powershell
$d = Join-Path $env:TEMP ('deskpost-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path (Join-Path $d 'program') | Out-Null; [Console]::Error.WriteLine("Deskpost download folder: $d"); curl.exe -fLo "$d\SHA256SUMS" 'https://github.com/eKioga/deskpost/releases/download/v1.4.0/SHA256SUMS'; if ($LASTEXITCODE -eq 0) { curl.exe -fLo "$d\deskpost-1.4.0-win-x64.zip" 'https://github.com/eKioga/deskpost/releases/download/v1.4.0/deskpost-1.4.0-win-x64.zip' }; if ($LASTEXITCODE -eq 0) { & "$env:SystemRoot\System32\tar.exe" -xf "$d\deskpost-1.4.0-win-x64.zip" -C "$d\program" --strip-components=1 }; if ($LASTEXITCODE -eq 0) { & "$d\program\bin\library.exe" install --release $d --dry-run --json --library '<LIBRARY>' --librarian <ASSISTANT> }
```

**In Git Bash:**

```bash
u="$(mktemp -d)" && mkdir "$u/program" && d="$(cygpath -w "$u")" && echo "Deskpost download folder: $d" >&2 && curl.exe -fLo "$u/SHA256SUMS" 'https://github.com/eKioga/deskpost/releases/download/v1.4.0/SHA256SUMS' && curl.exe -fLo "$u/deskpost-1.4.0-win-x64.zip" 'https://github.com/eKioga/deskpost/releases/download/v1.4.0/deskpost-1.4.0-win-x64.zip' && /c/Windows/System32/tar.exe -xf "$d\\deskpost-1.4.0-win-x64.zip" -C "$d\\program" --strip-components=1 && "$u/program/bin/library.exe" install --release "$d" --dry-run --json --library '<LIBRARY>' --librarian <ASSISTANT>
```

In Git Bash, call Windows' `tar.exe` by its full path as shown: Git's own `tar` reads `C:` as a remote host.

Quote `<LIBRARY>` in single quotes. In PowerShell a `'` inside it is written `''`. In Git Bash it is written `'\''`.
A path with spaces, `'` or `$` is fine that way.

**What comes back.** stdout is one JSON object. stderr has the download folder's path on its first line, and the
same plan as plain text, and it is not an error.

- `status` is `dry-run`: nothing was changed anywhere.
- `plan.rows` is the screen as `{label, value, note}` rows: Library, Program, Command, PATH, Updates, Librarian,
  Undo. A row with an empty label belongs to the row above it. On an upgrade, the one after Program names the older
  program versions it will remove, for example "removes 2 older versions: 1.3.4, 1.3.5".
- `plan.library_files` counts the files the Library gets, and `plan.offered` lists anything the plan leaves out
  unless the person asks for it. `repair` means an existing Library could be brought up to date.
- `plan_id` identifies this plan. **The program** for command 2 is `<folder>\program\bin\library.exe`, where
  `<folder>` is the download folder stderr named.

**If Deskpost is already installed** somewhere other than the default folder, the plan upgrades that install in
place, and stderr names where it was found. **If it fails instead**, stderr's last lines say why, in plain words.
Typical cases: two installs were found (each is named, and nothing changes until `--install-root` picks one), an
existing Library needs `--repair`, or the Library and the program folder overlap. Tell the person what it said, and
ask what they want. Add `--repair`, `--allow-overlap`, `--install-root <folder>` or `--resume`
only when they choose it, and then run command 1 again with it.

**A Windows without `curl.exe` or `tar.exe`** (before Windows 10 version 1803) can install through the release's
`install.ps1` instead. Run this as command 1, and for command 2 run the same script again (its path is `script.path`
in the result) with `-Json -PlanId <plan_id>` and no `-DryRun`; its flags are spelled `-Repair`, `-AllowOverlap`,
`-InstallRoot` and `-Resume`:

```powershell
$d = Join-Path $env:TEMP ('deskpost-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/eKioga/deskpost/releases/download/v1.4.0/install.ps1' -OutFile (Join-Path $d 'install.ps1') -ErrorAction Stop; powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $d 'install.ps1') -Release 'https://github.com/eKioga/deskpost/releases/download/v1.4.0' -DryRun -Json -Library '<LIBRARY>' -Librarian <ASSISTANT>
```

## 4. Show the plan, and ask

Show `plan.rows` as a small table, then "and N files in your Library", and the Undo row. Then ask one short
question that says any row can change: **"Install it? Say yes, no, or change any row, for example 'put the
program in D:\Tools\Deskpost'."** The table shows what can change: the Library folder, the program folder, the
other assistant when both are found, and bringing an existing Library up to date when it is offered. The person
asked only about the Library, so they will not assume the program folder is theirs to choose unless the question
says so. A change means running command 1 again with it, and showing the new plan.

**Wait for their answer.** Do not run command 2 until they have said yes to this plan.

## 5. Command 2: install exactly that plan

Run the **same program** from command 1's download folder, with the same answers, plus `--json --plan-id
<plan_id>`. Leave out `--dry-run`. Replace `<folder>` with the download folder stderr named.

**In PowerShell:**

```powershell
& '<folder>\program\bin\library.exe' install --release '<folder>' --json --plan-id <plan_id> --library '<LIBRARY>' --librarian <ASSISTANT>
```

**In Git Bash:**

```bash
"$(cygpath -u '<folder>')/program/bin/library.exe" install --release '<folder>' --json --plan-id <plan_id> --library '<LIBRARY>' --librarian <ASSISTANT>
```

Add any flag the person chose in step 3. The program plans again from the same release before it writes anything,
and refuses if the plan is no longer the one you showed: "This is not the plan that was shown". If that happens,
run command 1 again and show the new plan.

## 6. Report plainly

From the JSON:

- `status` (`installed`, `upgraded`, `repaired`);
- `install_root`, which is the program, and `library`;
- `doctor_exit`, where `0` means every check passed; say any warnings in `doctor`. When the person chose `none`
  for the Library, `doctor` checks the program and the Libraries this install already serves, never the folder you
  ran from: `served_by` (the program folder), `libraries`, `unreached`, `failed` and `program_checks`.

A refusal, or a doctor that is not green, is said as exactly that, never as done. After this, your own shell will
not find `deskpost` until it is restarted, because it started before the install. For anything you run yourself,
use `command_path`. The download folder can be deleted once command 2 has ended.

## 7. Hand off: never launch an assistant yourself

The Librarian must start **inside the Library**, in a new terminal the person opens. Your conversation is outside
it, so do not start guiding them here, and do not run `claude` or `codex`. Say this, filled in from the result:

> Deskpost is installed. Open a new terminal and type `deskpost`.
> *(If `opens.inside` is set: go to that folder first, then type `deskpost`.)*
> In the menu, choose **Show me around** (`h`, or Enter when it is the only choice), or `+` to make your first
> seat for a project of your own. Your Librarian starts in your Library.
> Before it speaks, Claude Code asks two things. **Do not just press Enter at the first one**, because its default
> is "No, exit". Choose **Yes, I trust this folder**, then **Use this MCP server** for validated-book-reader.
> If Claude then opens with nothing typed, type **show me around**.
> `deskpost uninstall` removes the program and its guards and keeps your Library and everything in it.

For an upgrade, add: "`deskpost rollback` returns to the version you had. From now on, `deskpost upgrade` upgrades
it."

## Codex

- **Escalation.** Codex's sandbox has no network and cannot write outside its workspace, so it will ask to run
  both commands outside the sandbox, in Codex's own dialog. If escalation is unavailable or declined, do not
  change a policy or look for a way round it. Give the person the terminal install instead, to run themselves in
  PowerShell:
  `irm https://github.com/eKioga/deskpost/releases/download/v1.4.0/install.ps1 | iex`
- **First start.** Codex reads a Library's guards only once the folder is trusted and its hooks are reviewed, and it
  skips unreviewed hooks silently. Tell the person: when Codex starts in the Library, trust the folder, then type
  `/hooks` and approve Deskpost's hooks, and only then ask to be shown around.

## Honest edges

- The checksum line means the archive matches the release's SHA256SUMS. Never call the release "verified": the
  sums and the archive come from the same place.
- New terminals find `deskpost`. A terminal inside an app that was already running, such as an editor or Orca,
  finds it after that app is restarted.
- The yes you asked for is what keeps the person in control. The `plan_id` only proves that what was installed is
  the plan that was produced. It cannot prove anyone read it.
