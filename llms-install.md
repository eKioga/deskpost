# Installing Deskpost: instructions for the assistant

**Deskpost 1.3.2.** This page belongs to the release at
`https://github.com/eKioga/deskpost/releases/download/v1.3.2`, called **the release base** below. Pass it as
`-Release` on both commands, so the plan you show and the install you run come from the same release.

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
their answer, and `<ASSISTANT>` with `claude` if you are Claude Code, or `codex` if you are Codex.

**In PowerShell:**

```powershell
$d = Join-Path $env:TEMP ('deskpost-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/eKioga/deskpost/releases/download/v1.3.2/install.ps1' -OutFile (Join-Path $d 'install.ps1') -ErrorAction Stop; powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $d 'install.ps1') -Release 'https://github.com/eKioga/deskpost/releases/download/v1.3.2' -DryRun -Json -Library '<LIBRARY>' -Librarian <ASSISTANT>
```

**In Git Bash:**

```bash
d="$(cygpath -w "$(mktemp -d)")" && curl -fsSL 'https://github.com/eKioga/deskpost/releases/download/v1.3.2/install.ps1' -o "$d\\install.ps1" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$d\\install.ps1" -Release 'https://github.com/eKioga/deskpost/releases/download/v1.3.2' -DryRun -Json -Library '<LIBRARY>' -Librarian <ASSISTANT>
```

Quote `<LIBRARY>` in single quotes. In PowerShell a `'` inside it is written `''`. In Git Bash it is written `'\''`.
A path with spaces, `'` or `$` is fine that way.

Never pipe the script into `iex`, and never run it from its URL directly.

**What comes back.** stdout is one JSON object. stderr has the same plan as plain text, and it is not an error.

- `status` is `dry-run`: nothing was changed anywhere.
- `plan.rows` is the screen as `{label, value, note}` rows: Library, Program, Command, Librarian, Undo.
- `plan.library_files` counts the files the Library gets, and `plan.offered` lists anything the plan leaves out
  unless the person asks for it. `repair` means an existing Library could be brought up to date.
- `plan_id` identifies this plan. `script.path` is the script you downloaded: use it for command 2.

**If it throws instead**, stderr's last lines say why, in plain words. Typical cases: Deskpost is already installed
somewhere else, an existing Library needs `-Repair`, or the Library and the program folder overlap. Tell the person
what it said, and ask what they want. Add `-Repair`, `-AllowOverlap`, `-InstallRoot <folder>` or `-Resume` only
when they choose it, and then run command 1 again with it.

## 4. Show the plan, and ask

Show `plan.rows` as a small table, then "and N files in your Library", and the Undo row. Then ask one short
question that says any row can change: **"Install it? Say yes, no, or change any row, for example 'put the
program in D:\Tools\Deskpost'."** The table shows what can change: the Library folder, the program folder, the
other assistant when both are found, and bringing an existing Library up to date when it is offered. The person
asked only about the Library, so they will not assume the program folder is theirs to choose unless the question
says so. A change means running command 1 again with it, and showing the new plan.

**Wait for their answer.** Do not run command 2 until they have said yes to this plan.

## 5. Command 2: install exactly that plan

Run the **same script** from `script.path`, with the same answers, plus `-Json -PlanId <plan_id>`. Leave out
`-DryRun`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<script.path>' -Release 'https://github.com/eKioga/deskpost/releases/download/v1.3.2' -Json -PlanId <plan_id> -Library '<LIBRARY>' -Librarian <ASSISTANT>
```

Add any flag the person chose in step 3. The script plans again from the same release before it writes anything,
and refuses if the plan is no longer the one you showed: "This is not the plan that was shown". If that happens,
run command 1 again and show the new plan.

## 6. Report plainly

From the JSON:

- `status` (`installed`, `upgraded`, `repaired`);
- `install_root`, which is the program, and `library`;
- `doctor_exit`, where `0` means every check passed; say any warnings in `doctor`.

A refusal, or a doctor that is not green, is said as exactly that, never as done. After this, your own shell will
not find `deskpost` until it is restarted, because it started before the install. For anything you run yourself,
use `command_path`.

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

For an upgrade, add: "`deskpost rollback` returns to the version you had."

## Codex

- **Escalation.** Codex's sandbox has no network and cannot write outside its workspace, so it will ask to run
  both commands outside the sandbox, in Codex's own dialog. If escalation is unavailable or declined, do not
  change a policy or look for a way round it. Give the person the terminal install instead, to run themselves in
  PowerShell:
  `& ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/download/v1.3.2/install.ps1)))`
- **First start.** Codex reads a Library's guards only once the folder is trusted and its hooks are reviewed, and it
  skips unreviewed hooks silently. Tell the person: when Codex starts in the Library, trust the folder, then type
  `/hooks` and approve Deskpost's hooks, and only then ask to be shown around.

## Honest edges

- The checksum line means the archive matches the release's SHA256SUMS. Never call the release "verified": the
  sums and the script come from the same place.
- New terminals find `deskpost`. A terminal inside an app that was already running, such as an editor or Orca,
  finds it after that app is restarted.
- The yes you asked for is what keeps the person in control. The `plan_id` only proves that what was installed is
  the plan that was produced. It cannot prove anyone read it.
