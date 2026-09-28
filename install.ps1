<#
.SYNOPSIS
    Install Deskpost on Windows: fetch a release and check it, ask one question, show what will happen, and do it on
    one key. `deskpost` is the command it leaves ready; `deskpost uninstall` undoes it.

.DESCRIPTION
    PLAN-install-onboarding.md step 2 (ADR-0057). THE SCRIPT FETCHES; THE PROGRAM HOLDS THE CONVERSATION. In order:

      1. Fetch and check, in %TEMP%\deskpost-<guid>. SHA256SUMS and this platform's archive are downloaded, the
         archive's hash must equal its line, it is extracted, and its bin\library.exe must report the release's tuple.
         Nothing is created under an install root yet.
      2. Ask. The fetched binary runs `setup --ask`: the question, the plan screen and its checks. It writes nothing
         but an answers file in the temp folder. Exit 3 is the reader quitting, and nothing was installed.
      3. Stage on the destination. Under <root>\.lifecycle.lock the receipt's `pending` transaction is recorded
         FIRST (install-receipt.json), then the tree is copied to versions\.incoming-<txn> -- a copy, because a move
         from %TEMP% to another drive is not a rename -- and its binary re-hashed. A version already there from the
         same archive is reused; from a different archive it is refused.
      4. Plan. The staged binary runs `setup --plan`, reading the staged tree and naming <root>\current. The frozen
         plan is kept in <root>\.pending\ until the install completes or is undone.
      5. Place. versions\<v>; `current` switched in four named substeps (a new link, the old renamed aside, the new
         renamed in, the old removed), so an interruption at any point is recognised; the `deskpost` and `library`
         shims; the user PATH and this window's.
      6. Apply. `current\bin\library.exe setup --apply` writes the Library from the frozen plan. The transaction moves
         into the receipt's `owned` list, `pending` is cleared, and doctor runs.
      7. Clean up. The temp folder goes; an unfinished transaction's owner is relinquished, so re-running the
         one-liner in this same window can finish or undo it.
      8. The fork (step 5, ADR-0059). Only after all of that, and only for a person at a first install: the program's
         `setup --welcome` offers the tutorial seat or the main menu. Anything else ends with `Next: deskpost`.

    RECOVERY IS ONE RULE: RE-RUN THE ONE-LINER. It finds `pending` and offers what is true for that phase: before the
    plan was frozen, starting over; after it, finishing (every step re-checked against the frozen plan) or undoing
    (a Library file restored only while it still holds this transaction's content). -Resume finish|undo decides it
    without a prompt.

    THIS SCRIPT NEVER CALLS `exit`. The one-liner runs it inside the reader's own PowerShell, where `exit` would close
    their window. A failure throws one readable line, and with -Json the only thing on stdout is one JSON result.

    From a release on the web, as one line:

        & ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/latest/download/install.ps1)))

.PARAMETER Release
    A folder holding SHA256SUMS and the archives, or the base URL they are served from. Defaults to the latest
    GitHub release.

.PARAMETER InstallRoot
    The program folder (DESKPOST_INSTALL_ROOT). Defaults to %LOCALAPPDATA%\deskpost. It must be new, empty, or an
    existing Deskpost install, and may not hold ';' or '%'.

.PARAMETER Library
    The Library folder, or `none` for the program only (DESKPOST_LIBRARY). Without it, the question is asked, with
    the folder this was run from as the answer already filled in.

.PARAMETER Yes
    No prompts: defaults only (also DESKPOST_YES=1, CI, or input that is not a terminal). A consequential choice is
    never a default: overlap needs -AllowOverlap, repairing an existing Library needs -Repair.

.PARAMETER DryRun
    Show the screen and the plan, and change nothing outside %TEMP% (which is cleaned).

.PARAMETER AllowOverlap
    Allow the Library and the program folder to contain each other.

.PARAMETER Repair
    Reinstall the same version over itself, and bring an existing Library's managed files up to date.

.PARAMETER Resume
    `finish` or `undo` an interrupted install without a prompt.

.PARAMETER NoPathChange
    Leave the user PATH alone. By default <InstallRoot>\bin is appended to it once.

.PARAMETER Plugin
    Also register the release as a Claude Code marketplace and install the plugin from it.

.PARAMETER Rollback
    Switch back to the version installed before the current one. Nothing is downloaded.

.PARAMETER Json
    One JSON result on stdout; the screen goes to stderr. With -DryRun, the result carries the plan an assistant shows
    (its rows, its files, and its plan_id). An install asked for as JSON must name that plan with -PlanId.

.PARAMETER PlanId
    Install exactly the plan a -DryRun -Json run produced (PLAN-assistant-onboarding.md step 2). The plan is made again
    from the same release before anything is written into the program folder, and a different one is refused. Implies
    -Yes. It proves what is installed is what was planned, not that anyone read it: the person's yes is the assistant's
    to ask for (llms-install.md).

.PARAMETER Librarian
    `claude` or `codex`: the assistant the Librarian row names, instead of the one found first.
#>

[CmdletBinding()]
param(
    [string]$Release = 'https://github.com/eKioga/deskpost/releases/latest/download',
    [string]$InstallRoot,
    [string]$Library,
    [string]$Platform,
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$AllowOverlap,
    [switch]$Repair,
    [ValidateSet('', 'finish', 'undo')][string]$Resume = '',
    [switch]$NoPathChange,
    [switch]$Plugin,
    [switch]$SkipPlugin,
    [switch]$Rollback,
    [switch]$Json,
    [string]$PlanId,
    [ValidateSet('', 'claude', 'codex')][string]$Librarian = '',
    # Accepted for 1.0's callers; the Library doctor reports on is the one set up.
    [string]$Workspace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $InstallRoot) { $InstallRoot = if ($env:DESKPOST_INSTALL_ROOT) { $env:DESKPOST_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'deskpost' } }
if (-not $PSBoundParameters.ContainsKey('Library') -and $env:DESKPOST_LIBRARY) { $Library = $env:DESKPOST_LIBRARY }
if ($env:DESKPOST_YES -eq '1') { $Yes = [switch]::Present }
if ($PlanId) { $Yes = [switch]::Present }
# AN INSTALL ASKED FOR AS JSON MUST NAME THE PLAN IT WAS SHOWN (PLAN-assistant-onboarding.md step 2): an assistant using
# JSON must at least produce the plan before installing. Scripts keep -Yes without -Json, which still prints the screen.
if ($Json -and -not $DryRun -and -not $PlanId -and -not $Rollback) {
    throw 'An install asked for as JSON must name the plan it was shown: run with -DryRun -Json first, then again with -PlanId <plan_id>. Nothing was changed.'
}
# THIS SCRIPT'S OWN IDENTITY (step 2, flaw D): run as a file it has a path and a hash, and the plan carries both, so the
# second command is provably the script the first one ran. The one-liner's scriptblock has neither.
$script:ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { '' }
$script:ScriptSha = if ($script:ScriptPath) { (Get-FileHash -LiteralPath $script:ScriptPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
$script:Interactive = -not ($Yes -or $Json -or $env:CI -or [Console]::IsInputRedirected)

function Write-Step([string]$Text) { if ($Json) { [Console]::Error.WriteLine("  $Text") } else { Write-Host "  $Text" } }

function Write-TextAtomically([string]$Path, [string]$Text) {
    <# Write beside the target, then one rename over it. [IO.File]::Replace lands on an existing file; a first write has none. #>
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $incoming = "$Path.incoming"
    [IO.File]::WriteAllText($incoming, $Text, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($incoming, $Path, [NullString]::Value) }
    else { [IO.File]::Move($incoming, $Path) }
}

function Get-LinkTarget([string]$Path) {
    <# A link's target, or $null for no link. A REAL directory at the path throws: it is never ours to replace. #>
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -notin 'Junction', 'SymbolicLink') {
        throw "$Path is a real directory, not the link the installer keeps there; nothing was changed. Move it aside and re-run."
    }
    [IO.Path]::GetFullPath([string]@($item.Target)[0]).TrimEnd('\')
}

function Test-EntryPresent([string]$Path) {
    <# Whether a name exists at all, a link whose target is gone included: Test-Path follows the link (post-build inspection #9). #>
    try { [void][IO.File]::GetAttributes($Path); $true } catch { $false }
}

function Test-IsLink([string]$Path) {
    try { ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0 } catch { $false }
}

function Remove-Link([string]$Path) {
    <# A link is removed as a link, never walked into (PLAN-install-onboarding.md step 0, measurement 5), dangling or not. #>
    if (-not (Test-EntryPresent $Path)) { return }
    if (-not (Test-IsLink $Path)) { throw "$Path is a real directory, not a link the installer keeps; nothing was changed. Move it aside and re-run." }
    [IO.Directory]::Delete($Path)
}

function Invoke-Library([string]$Executable, [string[]]$Arguments) {
    <#
        A captured run, for the machine answers (--version, --json). stderr is kept too, and said when it fails (#16).
        A PROCESS, NOT `& exe 2> file` (PLAN-assistant-onboarding.md step 0, #1): Windows PowerShell 5.1 wraps a native
        command's stderr in a NativeCommandError record, which reached an assistant reading -Json as a failure. Both
        streams are redirected and decoded as UTF-8; stderr is read asynchronously, because reading both to the end in
        turn deadlocks once the other pipe fills.
    #>
    $start = New-Object Diagnostics.ProcessStartInfo $Executable
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $process = [Diagnostics.Process]::Start($start)
    $errorsRead = $process.StandardError.ReadToEndAsync()
    $stdout = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    [pscustomobject]@{ exit = $process.ExitCode; stdout = $stdout; stderr = $errorsRead.Result }
}

function ConvertTo-CommandLineArgument([string]$Value) {
    <# One argument as CommandLineToArgvW reads it back: quoted when it holds a space or a quote, backslashes before a quote doubled. #>
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $out = '"'
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' } else { $out += ('\' * $slashes) + $ch }
        $slashes = 0
    }
    $out + ('\' * ($slashes * 2)) + '"'
}

function Invoke-LibraryShown([string]$Executable, [string[]]$Arguments) {
    <#
        A run the reader watches. THE CONSOLE IS THE CHILD'S: a native command run inside a PowerShell function has its
        stdout captured, which would take the terminal away from setup's prompts, so it is started as a process that
        inherits this console, and only its exit code comes back. Each argument is passed quoted as an argument
        (#11), never spliced into a command. With -Json the child's output is collected and said on stderr, so stdout
        carries one result only.
    #>
    if ($Json) {
        $ran = Invoke-Library $Executable $Arguments
        if (([string]$ran.stdout).Trim()) { [Console]::Error.WriteLine(([string]$ran.stdout).TrimEnd()) }
        if (([string]$ran.stderr).Trim()) { [Console]::Error.WriteLine(([string]$ran.stderr).TrimEnd()) }
        return $ran.exit
    }
    $start = New-Object Diagnostics.ProcessStartInfo $Executable
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $process = [Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    $process.ExitCode
}

function Assert-Tuple([string]$Root, $Expected, [string]$ExpectRoot = $Root) {
    <# The binary is asked, not the file beside it. -ExpectRoot is the root it must report (`current` once switched). #>
    $ran = Invoke-Library (Join-Path $Root 'bin\library.exe') @('--version')
    if ($ran.exit -ne 0) { throw "$Root\bin\library.exe exited $($ran.exit) on --version; the release does not run on this machine. $(([string]$ran.stderr).Trim())" }
    $reported = $ran.stdout | ConvertFrom-Json
    $mismatch = @()
    foreach ($field in 'plugin_version', 'binary_version', 'workspace_schema') {
        if ([string]$reported.$field -ne [string]$Expected.$field) { $mismatch += "$field is $($reported.$field), release.json says $($Expected.$field)" }
    }
    if ($reported.compiled -ne $true) { $mismatch += 'it does not report itself compiled' }
    if ([IO.Path]::GetFullPath([string]$reported.program_root).TrimEnd('\') -ne [IO.Path]::GetFullPath($ExpectRoot).TrimEnd('\')) {
        $mismatch += "its program root is $($reported.program_root), not $ExpectRoot"
    }
    if ($mismatch.Count) { throw "the installed binary does not match its release: $($mismatch -join '; ')." }
    $reported
}

function Get-FileSha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# --- the receipt and the lifecycle lock (PLAN-install-onboarding.md step 8) ------------------------------------------

function Get-ProcessStart([int]$Id) {
    try { (Get-Process -Id $Id -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $null }
}

function Test-OwnerAlive($Owner) {
    <# Alive only if a process with that id exists AND has that start time: a reused id is someone else (round 5, #2). #>
    if ($null -eq $Owner -or -not $Owner.pid) { return $false }
    $start = Get-ProcessStart ([int]$Owner.pid)
    $null -ne $start -and $start -eq [string]$Owner.start_utc
}

function Read-Receipt([string]$Root) {
    $file = Join-Path $Root 'install-receipt.json'
    if (-not (Test-Path -LiteralPath $file)) { return [pscustomobject]@{ schema = 1; owned = @(); pending = $null; path_change = $null } }
    $receipt = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if (-not ($receipt.PSObject.Properties.Name -contains 'owned')) { $receipt | Add-Member owned @() }
    if (-not ($receipt.PSObject.Properties.Name -contains 'pending')) { $receipt | Add-Member pending $null }
    if (-not ($receipt.PSObject.Properties.Name -contains 'path_change')) { $receipt | Add-Member path_change $null }
    $receipt
}

function Write-Receipt([string]$Root, $Receipt) {
    Write-TextAtomically (Join-Path $Root 'install-receipt.json') (($Receipt | ConvertTo-Json -Depth 12) + "`n")
}

function Invoke-UnderLock([string]$Root, [scriptblock]$Body) {
    <#
        CHECKING AND CLAIMING ARE ONE LOCKED OPERATION (round 4, #1): <root>\.lifecycle.lock opened share-nothing, the
        receipt read and written inside, and the lock released at once. The lock is never held across a prompt.
    #>
    if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    $lockPath = Join-Path $Root '.lifecycle.lock'
    $deadline = (Get-Date).AddSeconds(15)
    $stream = $null
    while ($null -eq $stream) {
        try { $stream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch {
            if ((Get-Date) -gt $deadline) { throw "another Deskpost install, upgrade or uninstall is changing $Root right now (it holds $lockPath). Let it finish, then run this again." }
            Start-Sleep -Milliseconds 200
        }
    }
    try { & $Body } finally { $stream.Dispose() }
}

function Set-PendingMark([string]$Root, [string]$Phase, [hashtable]$Fields = @{}) {
    Invoke-UnderLock $Root {
        $receipt = Read-Receipt $Root
        if ($null -eq $receipt.pending -or $receipt.pending.id -ne $script:Txn) { throw "the pending transaction at $Root is no longer this one ($script:Txn); stopping." }
        $receipt.pending.phase = $Phase
        foreach ($key in $Fields.Keys) {
            if ($receipt.pending.PSObject.Properties.Name -contains $key) { $receipt.pending.$key = $Fields[$key] } else { $receipt.pending | Add-Member $key $Fields[$key] }
        }
        Write-Receipt $Root $receipt
    }
    # FAULT INJECTION FOR THE INTERRUPTION FIXTURES (step 10): a stop right after a mark, as a crash would leave it.
    if ($env:DESKPOST_INSTALL_FAULT_AFTER -and $env:DESKPOST_INSTALL_FAULT_AFTER -eq $Phase) { throw "fault injected after '$Phase' (DESKPOST_INSTALL_FAULT_AFTER)" }
}

# --- Place: the version, `current`, the shims, PATH -------------------------------------------------------------------

function Set-CurrentLink([string]$Root, [string]$Target, [string]$Txn) {
    <#
        FOUR RECOGNISABLE SUBSTEPS (round 4, #3). Windows cannot rename a directory over an existing one (ADR-0038),
        so: create current.new-<txn> -> target; rename current -> current.old-<txn>; rename the new one in; remove the
        old link. Each substep is judged by which names exist, so a re-run after an interruption at any point goes on
        from where it stopped, and never refuses a state its own substeps produce.
    #>
    $current = Join-Path $Root 'current'
    $new = "$current.new-$Txn"
    $old = "$current.old-$Txn"
    $target = [IO.Path]::GetFullPath($Target).TrimEnd('\')
    $present = Test-EntryPresent $current
    if ($present -and -not (Test-IsLink $current)) { throw "$current is a real directory, not the link the installer keeps there; nothing was changed. Move it aside and re-run." }
    $now = if ($present -and (Test-Path -LiteralPath $current)) { Get-LinkTarget $current } else { $null }
    if ($now -ieq $target) {
        Remove-Link $new
        Remove-Link $old
        return
    }
    if (-not (Test-EntryPresent $new)) { New-Item -ItemType Junction -Path $new -Target $target | Out-Null }
    elseif (-not (Test-Path -LiteralPath $new) -or (Get-LinkTarget $new) -ine $target) { throw "$new does not point at $target; it is not this transaction's. Move it aside and re-run." }
    # A PRESENT current IS MOVED ASIDE EVEN WHEN ITS TARGET IS GONE: a dangling link still holds the name.
    if ($present) { [IO.Directory]::Move($current, $old) }
    [IO.Directory]::Move($new, $current)
    Remove-Link $old
}

$script:ShimText = "@`"%~dp0..\current\bin\library.exe`" %*`r`n"

function Set-Shims([string]$Root) {
    # `deskpost` IS THE COMMAND, `library` ITS ALIAS THROUGH 1.x (ADR-0055): two shims, one binary, the same text.
    foreach ($name in 'deskpost.cmd', 'library.cmd') {
        $file = Join-Path $Root "bin\$name"
        if ((Test-Path -LiteralPath $file) -and ([IO.File]::ReadAllText($file) -ceq $script:ShimText)) { continue }
        Write-TextAtomically $file $script:ShimText
    }
}

function Send-EnvironmentChange {
    <#
        WM_SETTINGCHANGE "Environment", bounded (step 0, measurement 3). Windows Terminal builds a new tab's environment
        from the registry itself; Explorer and what it starts rely on this message. Already-open terminals keep theirs.
    #>
    if (-not ('Deskpost.Native' -as [type])) {
        Add-Type -Namespace Deskpost -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    }
    $result = [UIntPtr]::Zero
    [void][Deskpost.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
}

function Add-UserPath([string]$Bin) {
    <#
        THE REGISTRY VALUE, UNEXPANDED, written back as REG_EXPAND_SZ. [Environment]::SetEnvironmentVariable would write
        the EXPANDED path as REG_SZ and silently freeze every %VARIABLE% entry already there. Returns whether it added.
    #>
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $added = $false
    if (-not @($raw -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Bin }).Count) {
        $updated = if ($raw.Trim()) { $raw.TrimEnd(';') + ';' + $Bin } else { $Bin }
        Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $updated -Type ExpandString
        $added = $true
        Send-EnvironmentChange
    }
    # THIS WINDOW TOO: the one-liner runs in the reader's own session, so `deskpost` works here at once.
    if (-not @($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Bin }).Count) { $env:Path = $env:Path.TrimEnd(';') + ';' + $Bin }
    $added
}

function Remove-UserPath([string]$Bin) {
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kept = @($raw -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $Bin })
    if ($kept.Count -ne @($raw -split ';' | Where-Object { $_ }).Count) {
        Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ($kept -join ';') -Type ExpandString
        Send-EnvironmentChange
    }
    $env:Path = (@($env:Path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $Bin }) -join ';')
}

# --- BEGIN uninstall removal (install.ps1 carries this block byte for byte; kernel self-test section 50 holds them equal) ---
function Remove-DeskpostPathEntry([string]$Entry) {
    <# The one PATH entry Deskpost added, read and written raw so REG_EXPAND_SZ and every other entry survive. #>
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kept = @($raw -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $Entry.TrimEnd('\') })
    if ($kept.Count -ne @($raw -split ';' | Where-Object { $_ }).Count) {
        Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ($kept -join ';') -Type ExpandString
    }
}

function Test-UnderRootWithoutLinks([string]$Root, [string]$Full) {
    <# The path is under the root physically: no folder between them is a reparse point, so nothing is reached through a link. #>
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Full)
    if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $parent = Split-Path -Parent $full
    while ($parent -and $parent.Length -gt $rootFull.Length) {
        if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        $parent = Split-Path -Parent $parent
    }
    $true
}

function Invoke-UninstallRemoval([string]$Root, $Removal) {
    <#
        Step 8's step 5, under its distinct rules. A link is removed as a link (step 0, measurement 5). A file is removed
        only if it still hashes to what was frozen, and only after it is revalidated as a physical path under the root.
        A folder is removed only if empty afterwards; the root only if empty. Returns what could not be removed.
    #>
    $problems = [Collections.Generic.List[string]]::new()
    if ($Removal.path_entry) {
        try { Remove-DeskpostPathEntry ([string]$Removal.path_entry) } catch { [void]$problems.Add("the PATH entry $($Removal.path_entry): $($_.Exception.Message)") }
    }
    foreach ($name in @($Removal.links)) {
        $full = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $item = Get-Item -LiteralPath $full -Force
        if ($item.LinkType -notin 'Junction', 'SymbolicLink') { [void]$problems.Add("$full is not a link; left in place"); continue }
        try { [IO.Directory]::Delete($full) } catch { [void]$problems.Add("$($full): $($_.Exception.Message)") }
    }
    foreach ($file in @($Removal.files)) {
        $full = Join-Path $Root (([string]$file.path) -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        if (-not (Test-UnderRootWithoutLinks $Root $full)) { [void]$problems.Add("$full is reached through a link; left in place"); continue }
        if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$file.sha256) { [void]$problems.Add("$full changed since uninstall was planned; left in place"); continue }
        try { [IO.File]::Delete($full) } catch { [void]$problems.Add("$($full): $($_.Exception.Message)") }
    }
    foreach ($folder in @(@($Removal.folders) | Sort-Object { ([string]$_).Split('/').Count } -Descending)) {
        $full = Join-Path $Root (([string]$folder) -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
        if (((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        if (@(Get-ChildItem -LiteralPath $full -Force).Count) { continue }
        try { [IO.Directory]::Delete($full) } catch { [void]$problems.Add("$($full): $($_.Exception.Message)") }
    }
    ,$problems
}
# --- END uninstall removal ---

function Write-CurrentRecord([string]$Root, [string]$Version, [string]$Previous, [string]$ArchiveSha256) {
    $record = [ordered]@{ schema = 1; version = $Version; previous = $Previous; archive_sha256 = $ArchiveSha256; switched = (Get-Date).ToString('o') }
    Write-TextAtomically (Join-Path $Root 'current.json') (($record | ConvertTo-Json) + "`n")
}

# --- the transaction ---------------------------------------------------------------------------------------------------

function Invoke-Place([string]$Root, $Pending) {
    <# Pass 5, every step idempotent: a re-run after an interruption goes on from where it stopped. #>
    $versions = Join-Path $Root 'versions'
    $target = Join-Path $versions $Pending.version
    if ($Pending.candidate -ne $target) {
        if ((Test-Path -LiteralPath $Pending.candidate) -and -not (Test-Path -LiteralPath $target)) { [IO.Directory]::Move($Pending.candidate, $target) }
        elseif (-not (Test-Path -LiteralPath $target)) { throw "the staged release $($Pending.candidate) is gone, and $target was never placed. Run -Resume undo, then install again." }
        elseif (Test-Path -LiteralPath $Pending.candidate) {
            # BOTH THERE (post-build inspection #3): the placed folder must be this archive's, and the staging then goes.
            $placedSha = if (Test-Path -LiteralPath (Join-Path $target '.archive-sha256')) { (Get-Content -LiteralPath (Join-Path $target '.archive-sha256') -Raw).Trim() } else { '' }
            if ($placedSha -ne [string]$Pending.archive_sha256) { throw "$target is not this transaction's release ($placedSha), and its staged copy is still at $($Pending.candidate). Run -Resume undo." }
            Remove-Item -LiteralPath $Pending.candidate -Recurse -Force
        }
    }
    Set-PendingMark $Root 'placed-version'
    Set-CurrentLink $Root $target $Pending.id
    $recordVersion = if ($Pending.PSObject.Properties.Name -contains 'previous_version') { [string]$Pending.previous_version } else { '' }
    $previous = if ($recordVersion -and $recordVersion -ne $Pending.version) { $recordVersion } elseif ($Pending.PSObject.Properties.Name -contains 'previous_previous') { [string]$Pending.previous_previous } else { $null }
    Write-CurrentRecord $Root $Pending.version $previous $Pending.archive_sha256
    Set-PendingMark $Root 'activated'
    Set-Shims $Root
    Set-PendingMark $Root 'shims'
    $pathAdded = $false
    if ($Pending.path_change) { $pathAdded = Add-UserPath (Join-Path $Root 'bin') }
    $already = $Pending.PSObject.Properties.Name -contains 'path_added' -and $Pending.path_added -eq $true
    Set-PendingMark $Root 'placed' @{ path_added = ($pathAdded -or $already) }
    $stable = Join-Path $Root 'current'
    $expected = Get-Content -LiteralPath (Join-Path $target 'release.json') -Raw | ConvertFrom-Json
    [void](Assert-Tuple $stable $expected $stable)
}

function Invoke-Apply([string]$Root, $Pending) {
    <# Pass 6: the Library from the frozen plan, then the transaction moves into `owned` and `pending` is cleared. #>
    $plan = Join-Path $Root '.pending\plan.json'
    $code = Invoke-LibraryShown (Join-Path $Root 'current\bin\library.exe') @('setup', '--apply', '--plan-file', $plan)
    if ($code -ne 0) { throw "writing the Library from the plan failed (exit $code); its refusal is above. Re-run the installer to finish or undo." }
    $frozen = Get-Content -LiteralPath $plan -Raw | ConvertFrom-Json
    Invoke-UnderLock $Root {
        $receipt = Read-Receipt $Root
        $owned = [Collections.Generic.List[object]]::new()
        foreach ($item in @($receipt.owned)) { [void]$owned.Add($item) }
        $stamp = (Get-Date).ToUniversalTime().ToString('o')
        if ($Pending.created_version) { [void]$owned.Add([pscustomobject]@{ kind = 'version'; path = "versions\$($Pending.version)"; archive_sha256 = $Pending.archive_sha256; utc = $stamp }) }
        foreach ($name in 'current', 'current.json', 'bin\deskpost.cmd', 'bin\library.cmd', 'install-receipt.json', '.lifecycle.lock') {
            if (-not @($owned | Where-Object { $_.kind -eq 'file' -and $_.path -eq $name }).Count) { [void]$owned.Add([pscustomobject]@{ kind = 'file'; path = $name; utc = $stamp }) }
        }
        # ADOPTED IS NOT ADDED (post-build inspection #2): 1.0's entry becomes Deskpost's to remove at uninstall, but an undo
        # of this transaction reads only path_added, so it never strips an entry this transaction did not write.
        $adopted = $Pending.PSObject.Properties.Name -contains 'path_adopted' -and $Pending.path_adopted -eq $true
        if ($Pending.path_added -eq $true -or $adopted) { [void]$owned.Add([pscustomobject]@{ kind = 'path'; entry = (Join-Path $Root 'bin'); utc = $stamp }) }
        if ($null -ne $frozen.library) {
            $created = @($frozen.library.writes | Where-Object { $null -eq $_.old_sha256 } | ForEach-Object { $_.relative })
            [void]$owned.Add([pscustomobject]@{ kind = 'library'; path = $frozen.library.workspace; created = $created; utc = $stamp })
        }
        $receipt.owned = @($owned)
        $receipt.pending = $null
        $receipt.path_change = [bool]$Pending.path_change
        Write-Receipt $Root $receipt
    }
    Remove-Item -LiteralPath (Join-Path $Root '.pending') -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-Undo([string]$Root, $Pending) {
    <#
        Reverse what this transaction did. A Library file is restored from the plan's saved text only while it still
        holds this transaction's new content; one someone has changed since is left, and named.
    #>
    $left = [Collections.Generic.List[string]]::new()
    $planFile = Join-Path $Root '.pending\plan.json'
    if (Test-Path -LiteralPath $planFile) {
        $frozen = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
        if ($null -ne $frozen.library) {
            foreach ($write in @($frozen.library.writes)) {
                if (-not (Test-Path -LiteralPath $write.path)) { continue }
                if ((Get-FileSha $write.path) -ne $write.new_sha256) { [void]$left.Add($write.path); continue }
                if ($null -eq $write.old_sha256) { Remove-Item -LiteralPath $write.path -Force }
                else { Write-TextAtomically $write.path ([string]$write.old_text) }
            }
            # THE FOLDERS THIS TRANSACTION MADE, planned or made on the way to a created file (post-build inspection #6):
            # each removed only when empty. The Library folder itself is kept: it may be the empty folder the reader ran from.
            $workspace = [IO.Path]::GetFullPath([string]$frozen.library.workspace).TrimEnd('\')
            $made = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($directory in @($frozen.library.directories)) { [void]$made.Add([string]$directory) }
            foreach ($write in @($frozen.library.writes | Where-Object { $null -eq $_.old_sha256 })) {
                $parent = Split-Path -Parent ([string]$write.path)
                while ($parent -and $parent.Length -gt $workspace.Length) { [void]$made.Add($parent); $parent = Split-Path -Parent $parent }
            }
            foreach ($directory in @($made | Sort-Object { $_.Length } -Descending)) {
                if ((Test-Path -LiteralPath $directory) -and -not (Test-IsLink $directory) -and -not @(Get-ChildItem -LiteralPath $directory -Force).Count) { [IO.Directory]::Delete($directory) }
            }        }
    }
    $current = Join-Path $Root 'current'
    foreach ($stray in @(Get-ChildItem -LiteralPath $Root -Force -Filter "current.*-$($Pending.id)" -ErrorAction SilentlyContinue)) { Remove-Link $stray.FullName }
    $previous = if ($Pending.PSObject.Properties.Name -contains 'previous_target') { [string]$Pending.previous_target } else { '' }
    if ($previous) {
        if (Test-Path -LiteralPath $previous) { Set-CurrentLink $Root $previous "undo$($Pending.id)" }
        if ($Pending.PSObject.Properties.Name -contains 'previous_record' -and $Pending.previous_record) { Write-TextAtomically (Join-Path $Root 'current.json') ([string]$Pending.previous_record) }
    } else {
        if (Test-Path -LiteralPath $current) { Remove-Link $current }
        Remove-Item -LiteralPath (Join-Path $Root 'current.json') -Force -ErrorAction SilentlyContinue
        foreach ($name in 'deskpost.cmd', 'library.cmd') { Remove-Item -LiteralPath (Join-Path $Root "bin\$name") -Force -ErrorAction SilentlyContinue }
        if ((Test-Path -LiteralPath (Join-Path $Root 'bin')) -and -not @(Get-ChildItem -LiteralPath (Join-Path $Root 'bin') -Force).Count) { [IO.Directory]::Delete((Join-Path $Root 'bin')) }
    }
    if ($Pending.PSObject.Properties.Name -contains 'path_added' -and $Pending.path_added -eq $true) { Remove-UserPath (Join-Path $Root 'bin') }
    if ($Pending.created_version) {
        $placed = Join-Path $Root "versions\$($Pending.version)"
        if ((Test-Path -LiteralPath $placed) -and ((Get-LinkTarget $current) -ine $placed)) { Remove-Item -LiteralPath $placed -Recurse -Force }
    }
    if ($Pending.candidate -and ($Pending.candidate -like '*\.incoming-*') -and (Test-Path -LiteralPath $Pending.candidate)) { Remove-Item -LiteralPath $Pending.candidate -Recurse -Force }
    Invoke-UnderLock $Root {
        $receipt = Read-Receipt $Root
        $receipt.pending = $null
        Write-Receipt $Root $receipt
    }
    Remove-Item -LiteralPath (Join-Path $Root '.pending') -Recurse -Force -ErrorAction SilentlyContinue
    $left
}

# --- rollback (kept as 1.0 had it; `deskpost rollback` is step 4) --------------------------------------------------

function Invoke-Rollback([string]$Root) {
    $versions = Join-Path $Root 'versions'
    $file = Join-Path $Root 'current.json'
    if (-not (Test-Path -LiteralPath $file)) { throw "nothing to roll back to: $file does not exist." }
    $current = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if (-not $current.previous) { throw "nothing to roll back to: $file names no previous version." }
    # NOT DURING ANOTHER CHANGE (post-build inspection #7): a pending transaction, live or interrupted, owns the root.
    if (Test-Path -LiteralPath (Join-Path $Root 'install-receipt.json')) {
        Invoke-UnderLock $Root {
            $pending = (Read-Receipt $Root).pending
            if ($null -ne $pending) {
                if (Test-OwnerAlive $pending.owner) { throw "a Deskpost $($pending.operation) is running on $Root (process $($pending.owner.pid)); let it finish, then roll back." }
                throw "an interrupted Deskpost $($pending.operation) is recorded at $Root; run the installer to finish or undo it before rolling back."
            }
        }
    }
    $target = Join-Path $versions $current.previous
    if (-not (Test-Path -LiteralPath (Join-Path $target 'bin\library.exe'))) { throw "the previous version $($current.previous) is no longer under $versions." }
    $expected = Get-Content -LiteralPath (Join-Path $target 'release.json') -Raw | ConvertFrom-Json
    # A SHARED BOOK OPEN ON ANY DESK (PLAN-basic-memory.md step 5, ADR-0054): 1.0's reader refuses a whole Desk that
    # holds a shared/ entry, so the version being LEFT is asked first. A version without the check (1.0 has no
    # shared/ form), or one that cannot answer, never blocks the way back: rollback is the fallback for a broken one.
    $leaving = Join-Path $versions "$($current.version)\bin\library.exe"
    if (Test-Path -LiteralPath $leaving) {
        $check = Invoke-Library $leaving @('basic-memory', 'rollback-check', '--json')
        $answer = $null
        if ($check.exit -eq 0) { try { $answer = $check.stdout | ConvertFrom-Json } catch { $answer = $null } }
        if ($null -ne $answer -and @($answer.blocking).Count -gt 0) {
            $lines = @($answer.blocking | ForEach-Object { @($_.close) | ForEach-Object { "  $_" } })
            throw ("Not rolled back: $(@($answer.blocking).Count) seat(s) hold a shared Book on their Desk, and $($current.previous)'s reader would refuse " +
                "those Desks whole. Close them first, then run -Rollback again:`n" + ($lines -join "`n"))
        }
        if ($null -ne $answer -and @($answer.unreadable).Count -gt 0) { Write-Step "The shared-Desk check could not read everything: $(@($answer.unreadable) -join '; ')" }
    }
    $sha = if (Test-Path -LiteralPath (Join-Path $target '.archive-sha256')) { (Get-Content -LiteralPath (Join-Path $target '.archive-sha256') -Raw).Trim() } else { $null }
    $before = Get-Content -LiteralPath $file -Raw
    Set-CurrentLink $Root $target ('rollback' + [guid]::NewGuid().ToString('N'))
    Write-CurrentRecord $Root $current.previous $current.version $sha
    Set-Shims $Root
    try { [void](Assert-Tuple (Join-Path $Root 'current') $expected (Join-Path $Root 'current')) }
    catch {
        Set-CurrentLink $Root (Join-Path $versions $current.version) ('rollback' + [guid]::NewGuid().ToString('N'))
        Write-TextAtomically $file $before
        throw "$($_.Exception.Message) (current points at $($current.version) again)"
    }
    $result = [pscustomobject]@{ status = 'rolled-back'; version = $current.previous; from = $current.version; install_root = $Root
        plugin = 'The plugin is not rolled back by this switch. Reinstall it from the version above if it was upgraded with the binary.' }
    if ($Json) { $result | ConvertTo-Json -Compress } else { Write-Host "Rolled back to $($current.previous) (from $($current.version)). $($result.plugin)" }
}

# --- the run -------------------------------------------------------------------------------------------------------

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($Rollback) { Invoke-Rollback $InstallRoot; return }

if (-not $Platform) { $Platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' } }
if ($Platform -notin 'win-x64', 'win-arm64') { throw "install.ps1 installs a Windows release; '$Platform' is not one. Use install.sh on macOS and Linux." }

$script:Txn = $null
$script:OwnsPending = $false
$script:Root = $null
$script:Welcome = $null
$script:AppliedView = $null
$temp =Join-Path ([IO.Path]::GetTempPath()) ('deskpost-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$status = 'installed'
try {
    # --- 1. fetch and check, in %TEMP% ---------------------------------------------------------------------------
    $isLocal = Test-Path -LiteralPath $Release -PathType Container
    function Get-ReleaseFile([string]$Name) {
        $to = Join-Path $temp $Name
        if ($isLocal) { Copy-Item -LiteralPath (Join-Path $Release $Name) -Destination $to -Force }
        else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri ($Release.TrimEnd('/') + '/' + $Name) -OutFile $to
        }
        $to
    }
    Write-Step "Reading the release's checksums from $Release"
    $sums = Get-Content -LiteralPath (Get-ReleaseFile 'SHA256SUMS')
    $lines = @($sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?(deskpost-[0-9A-Za-z.+-]+-$([regex]::Escape($Platform))\.zip)\s*$" })
    if ($lines.Count -ne 1) { throw "SHA256SUMS names $($lines.Count) archive(s) for $Platform; an install needs exactly one." }
    [void]($lines[0] -match "^([0-9a-f]{64})\s+\*?(\S+)")
    $expectedSha, $archiveName = $Matches[1], $Matches[2]
    $archive = Get-ReleaseFile $archiveName
    $actualSha = Get-FileSha $archive
    if ($actualSha -ne $expectedSha) { throw "$archiveName hashes to $actualSha and SHA256SUMS says $expectedSha. Nothing was installed." }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $temp 'x'))
    $roots = @(Get-ChildItem -LiteralPath (Join-Path $temp 'x') -Directory)
    if ($roots.Count -ne 1) { throw "$archiveName holds $($roots.Count) top-level folders; a release holds one." }
    $extracted = $roots[0].FullName
    $releaseRecord = Get-Content -LiteralPath (Join-Path $extracted 'release.json') -Raw | ConvertFrom-Json
    if ($releaseRecord.platform -ne $Platform) { throw "$archiveName is built for $($releaseRecord.platform), not $Platform." }
    $version = [string]$releaseRecord.plugin_version
    if ($version -notmatch '^[0-9A-Za-z.+-]+$') { throw "release.json's version '$version' cannot name a directory." }
    [void](Assert-Tuple $extracted $releaseRecord)
    $tempExe = Get-FileSha (Join-Path $extracted 'bin\library.exe')

    # --- an interrupted transaction first: re-running the one-liner is the recovery -------------------------------
    $recovering = $null
    $script:Recovering = $null
    # RECOVERY IS DISPATCHED FIRST, AND NEVER ON A DRY RUN (PLAN-assistant-onboarding.md step 2; Codex #2). Claiming an
    # abandoned transaction rewrites the receipt, so a dry run only reports it, read without the lock, and a -Json
    # install refuses with the same report: recovery is done at a terminal (-Transaction under -Json is deferred).
    if (($DryRun -or $Json) -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'install-receipt.json'))) {
        $seen = Read-Receipt $InstallRoot
        if ($null -ne $seen.pending) {
            $pendingFrozen = [string]$seen.pending.phase -notin 'staging', 'staged'
            $allowed = if ([string]$seen.pending.operation -eq 'uninstall') { '-Resume finish' } elseif ($pendingFrozen) { '-Resume finish or -Resume undo' } else { '-Resume finish (which starts over)' }
            $report = "An interrupted Deskpost $($seen.pending.operation) is recorded at $InstallRoot (transaction $($seen.pending.id), stopped at '$($seen.pending.phase)'). Run the installer at a terminal with $allowed."
            if ($DryRun) {
                $status = 'pending'
                Write-Step "$report Nothing was changed."
                if ($Json) { [pscustomobject]@{ status = 'pending'; install_root = $InstallRoot; operation = [string]$seen.pending.operation; transaction = [string]$seen.pending.id; phase = [string]$seen.pending.phase; resume = $allowed } | ConvertTo-Json -Compress }
                return
            }
            throw "$report Nothing was changed."
        }
    }
    if (Test-Path -LiteralPath (Join-Path $InstallRoot 'install-receipt.json')) {
        Invoke-UnderLock $InstallRoot {
            $receipt = Read-Receipt $InstallRoot
            if ($null -ne $receipt.pending) {
                if (Test-OwnerAlive $receipt.pending.owner) {
                    throw "another Deskpost $($receipt.pending.operation) is running on $InstallRoot (process $($receipt.pending.owner.pid)). Let it finish, then run this again."
                }
                # A DEAD OR EMPTY OWNER IS CLAIMED, UNDER THE LOCK (round 4, #1): two recoverers can never both claim.
                $receipt.pending.owner = [pscustomobject]@{ pid = $PID; start_utc = (Get-ProcessStart $PID) }
                Write-Receipt $InstallRoot $receipt
                $script:Recovering = $receipt.pending
            }
        }
        $recovering = $script:Recovering
    }
    if ($null -ne $recovering) {
        $script:Txn = $recovering.id
        $script:Root = $InstallRoot
        $script:OwnsPending = $true
        if ($recovering.operation -eq 'rollback') {
            # AN INTERRUPTED `deskpost rollback` (post-build inspection #1). Its only recovery is to put current back as it
            # was, from the record it saved; it is never recovered as an install, whose undo removes current and the shims.
            $record = [string]$recovering.previous_record | ConvertFrom-Json
            $back = Join-Path $InstallRoot "versions\$($record.version)"
            if (-not (Test-Path -LiteralPath (Join-Path $back 'bin\library.exe'))) { throw "An interrupted rollback is recorded at $InstallRoot, and $back is not there to switch back to. Nothing was changed." }
            Set-CurrentLink $InstallRoot $back "recover$($recovering.id)"
            Write-TextAtomically (Join-Path $InstallRoot 'current.json') ([string]$recovering.previous_record)
            Invoke-UnderLock $InstallRoot { $receipt = Read-Receipt $InstallRoot; $receipt.pending = $null; Write-Receipt $InstallRoot $receipt }
            $script:OwnsPending = $false
            $status = 'rollback-undone'
            Write-Step "The interrupted rollback is undone: current runs $($record.version) again. Run deskpost rollback again if you still want it."
            if ($Json) { [pscustomobject]@{ status = $status; install_root = $InstallRoot; version = $record.version } | ConvertTo-Json -Compress }
            return
        }
        if ($recovering.operation -notin 'install', 'upgrade', 'repair', 'uninstall') {
            throw "An interrupted Deskpost '$($recovering.operation)' is recorded at $InstallRoot (transaction $($recovering.id)), which this installer does not know how to recover. Nothing was changed."
        }
        if ($recovering.operation -eq 'uninstall') {
            # AN INTERRUPTED UNINSTALL (round 3, #7). Retry never needs the program: this script is not what is being
            # removed. Once its Library edits began the only choice is finish; before them, undo just clears it.
            $begun = $recovering.PSObject.Properties.Name -contains 'library_edits_begun' -and $recovering.library_edits_begun -eq $true
            $choice = $Resume
            if (-not $choice) {
                if (-not $script:Interactive) {
                    throw "An interrupted Deskpost uninstall is recorded at $InstallRoot (transaction $($recovering.id)). Run the installer again with $(if ($begun) { '-Resume finish' } else { '-Resume finish or -Resume undo' })."
                }
                $key = (Read-Host "An uninstall of $InstallRoot was interrupted. $(if ($begun) { '[f] finish it   [q] quit' } else { '[f] finish it   [u] undo it   [q] quit' })").Trim().ToLowerInvariant()
                $choice = switch ($key) { 'f' { 'finish' } 'u' { 'undo' } default { '' } }
                if (-not $choice) { $status = 'quit'; return }
            }
            if ($choice -eq 'undo') {
                if ($begun) { throw 'The interrupted uninstall had begun editing your Libraries, so it can only be finished: run with -Resume finish.' }
                Invoke-UnderLock $InstallRoot { $receipt = Read-Receipt $InstallRoot; $receipt.pending = $null; Write-Receipt $InstallRoot $receipt }
                $script:OwnsPending = $false
                Write-Step 'The interrupted uninstall is undone; nothing had been removed.'
                if ($Json) { [pscustomobject]@{ status = 'uninstall-undone'; install_root = $InstallRoot } | ConvertTo-Json -Compress }
                return
            }
            if (-not $begun) { throw "The interrupted uninstall never reached your Libraries; run $InstallRoot\bin\deskpost.cmd uninstall again, or -Resume undo." }
            $problems = @(Invoke-UninstallRemoval $InstallRoot $recovering.removal | ForEach-Object { $_ })
            if ($problems.Count) { throw "The uninstall could not remove everything: $($problems -join '; '). Close what holds them and run -Resume finish again." }
            Remove-Item -LiteralPath (Join-Path $InstallRoot 'install-receipt.json') -Force
            Remove-Item -LiteralPath (Join-Path $InstallRoot '.pending') -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path $InstallRoot '.lifecycle.lock') -Force -ErrorAction SilentlyContinue
            if ((Test-Path -LiteralPath $InstallRoot) -and -not @(Get-ChildItem -LiteralPath $InstallRoot -Force).Count) { [IO.Directory]::Delete($InstallRoot) }
            $script:OwnsPending = $false
            $status = 'uninstalled'
            Write-Step "The uninstall of $InstallRoot is finished."
            if ($Json) { [pscustomobject]@{ status = $status; install_root = $InstallRoot } | ConvertTo-Json -Compress }
            return
        }
        $frozen = $recovering.phase -notin 'staging', 'staged'
        $choice = $Resume
        if (-not $choice) {
            if (-not $script:Interactive) {
                $allowed = if ($frozen) { '-Resume finish or -Resume undo' } else { '-Resume finish (which starts over)' }
                throw "An interrupted Deskpost $($recovering.operation) of $($recovering.version) is recorded at $InstallRoot (transaction $($recovering.id), stopped at '$($recovering.phase)'). Run the installer again with $allowed."
            }
            Write-Host "An earlier $($recovering.operation) of Deskpost $($recovering.version) at $InstallRoot was interrupted (at '$($recovering.phase)')."
            $keys = if ($frozen) { '[f] finish it   [u] undo it   [q] quit' } else { '[s] start over   [q] quit' }
            $key = (Read-Host $keys).Trim().ToLowerInvariant()
            $choice = switch ($key) { 'f' { 'finish' } 's' { 'finish' } 'u' { 'undo' } default { '' } }
            if (-not $choice) { $status = 'quit'; Write-Host 'Nothing was changed. The interrupted transaction is kept for next time.'; return }
        }
        if ($choice -eq 'undo') {
            if (-not $frozen) { throw "The interrupted $($recovering.operation) stopped before its plan was frozen, so there is nothing to undo; run with -Resume finish to start over." }
            $left = @(Invoke-Undo $InstallRoot $recovering)
            $script:OwnsPending = $false
            $status = 'undone'
            Write-Step "Undone. $(if ($left.Count) { "Left as they are, because they changed since: $($left -join ', ')." } else { 'Nothing was left behind.' })"
            if ($Json) { [pscustomobject]@{ status = $status; transaction = $recovering.id; left = $left } | ConvertTo-Json -Compress }
            return
        }
        if ($frozen) {
            # FINISH FROM THE FROZEN PLAN AND THE RETAINED CANDIDATE, never the release just fetched (round 4, #4).
            Write-Step "Finishing the interrupted $($recovering.operation) of $($recovering.version)"
            if ($recovering.phase -ne 'placed') { Invoke-Place $InstallRoot $recovering }
            $recovering = (Read-Receipt $InstallRoot).pending
            Invoke-Apply $InstallRoot $recovering
            $script:OwnsPending = $false
            $status = 'finished'
            Write-Step "Finished. Run: deskpost doctor"
            if ($Json) { [pscustomobject]@{ status = $status; transaction = $recovering.id; version = $recovering.version; install_root = $InstallRoot } | ConvertTo-Json -Compress }
            return
        }
        # BEFORE THE PLAN WAS FROZEN NOTHING WAS PLACED: only the receipt and staging. Start over with this release.
        if ($recovering.candidate -and ($recovering.candidate -like '*\.incoming-*') -and (Test-Path -LiteralPath $recovering.candidate)) { Remove-Item -LiteralPath $recovering.candidate -Recurse -Force }
        Invoke-UnderLock $InstallRoot { $receipt = Read-Receipt $InstallRoot; $receipt.pending = $null; Write-Receipt $InstallRoot $receipt }
        $script:OwnsPending = $false
        $script:Txn = $null
        Write-Step 'Starting over.'
    }

    # --- 2. ask: the program holds the conversation ------------------------------------------------------------------
    $answersFile = Join-Path $temp 'answers.json'
    $askArguments = @('setup', '--ask', '--answers', $answersFile, '--install-root', $InstallRoot, '--cwd', (Get-Location).ProviderPath,
        '--checksum-note', "checksum matches the release's SHA256SUMS")
    if ($PSBoundParameters.ContainsKey('Library') -or $Library) { $askArguments += @('--library', $Library) }
    if (-not $script:Interactive) { $askArguments += '--yes' }
    if ($Json) { $askArguments += '--json' }
    if ($AllowOverlap) { $askArguments += '--allow-overlap' }
    if ($Repair) { $askArguments += '--repair' }
    if ($NoPathChange) { $askArguments += '--no-path-change' }
    if ($Librarian) { $askArguments += @('--assistant', $Librarian) }
    if ($script:ScriptPath) { $askArguments += '--run-as-file' }
    # THE USER PATH AS STORED (step 3): an install on it that this shell cannot see is still another install.
    # DESKPOST_USER_PATH stands in for it when set, as LIBRARY_WORKSPACES stands in for the registry: a fixture run on a
    # machine with a real install judges its scratch installs, not that one. `;` is a user PATH with no entries (an
    # empty value would unset the variable).
    $storedUserPath = if (Test-Path Env:DESKPOST_USER_PATH) { [string]$env:DESKPOST_USER_PATH } else { [string](Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    if ($storedUserPath) { $askArguments += @('--user-path', $storedUserPath) }
    $asked = Invoke-LibraryShown (Join-Path $extracted 'bin\library.exe') $askArguments
    if ($asked -eq 3) { $status = 'quit'; if ($Json) { [pscustomobject]@{ status = 'quit' } | ConvertTo-Json -Compress }; return }
    if ($asked -ne 0) { throw "setup stopped (exit $asked); what it said is above. Nothing was installed." }
    $answers = Get-Content -LiteralPath $answersFile -Raw | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath([string]$answers.install_root).TrimEnd('\')

    # CLOSE YOUR SESSIONS FIRST (#7, #10): an upgrade or repair switches the program they are running. Best effort.
    # A REPAIRED LIBRARY COUNTS WHATEVER ITS PROGRAM (S58 post-build inspection #2): a new root that repairs an existing
    # Library rewrites the registrations its live seats run under, so that Library's seats are checked too.
    $repairsLibrary = [string]$answers.library_state -eq 'existing' -and [bool]$answers.repair
    if (([string]$answers.install_state -in 'upgrade', 'repair' -or $repairsLibrary) -and -not $DryRun) {
        $sessionArguments = @('setup', '--sessions', '--install-root', $root, '--json')
        if ($repairsLibrary) { $sessionArguments += @('--library', [string]$answers.library) }
        $what = if ([string]$answers.install_state -in 'upgrade', 'repair') { "this $($answers.install_state) switches the program they are running" } else { "this repair rewrites the guards they are running under" }
        for (;;) {
            $ran = Invoke-Library (Join-Path $extracted 'bin\library.exe') $sessionArguments
            $live = $null
            try { $live = $ran.stdout | ConvertFrom-Json } catch { $live = $null }
            # A CHECK THAT CANNOT ANSWER IS NOT A CLEAR ONE (post-build inspection #8).
            if ($null -eq $live) { throw "The live-session check did not answer (exit $($ran.exit)): $(([string]$ran.stderr).Trim()) Nothing was changed." }
            if ($live.clear) { break }
            $message = "Close your sessions first: $what.`n$($live.text)"
            if (-not $script:Interactive) { throw "$message`nEnd those sessions, then run the installer again." }
            Write-Host $message
            if ((Read-Host '[Enter] look again   [q] quit').Trim().ToLowerInvariant() -eq 'q') { $status = 'quit'; Write-Host 'Nothing was changed.'; return }
        }
    }

    # THE PLAN FROM THE TEMP TREE (step 2): what a dry run shows, and what -PlanId is compared with, before any root write.
    $tempPlanFile = Join-Path $temp 'plan.json'
    $planArguments = @('setup', '--plan', '--answers', $answersFile, '--resources', $extracted, '--register-as', (Join-Path $root 'current'), '--out', $tempPlanFile, '--release-sha', $actualSha, '--script-sha', $script:ScriptSha)
    if ($DryRun -or $PlanId) {
        $code = if ($DryRun) { Invoke-LibraryShown (Join-Path $extracted 'bin\library.exe') $planArguments } else { (Invoke-Library (Join-Path $extracted 'bin\library.exe') $planArguments).exit }
        if ($code -ne 0) { throw "the plan was refused (exit $code); what it said is above. Nothing was changed." }
        $tempPlan = Get-Content -LiteralPath $tempPlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    if ($DryRun) {
        $status = 'dry-run'
        Write-Step 'Dry run: nothing was changed.'
        if ($Json) {
            [pscustomobject]@{
                status = $status; version = $version; install_root = $root; library = $answers.library
                plan_id = [string]$tempPlan.plan_id; plan = $tempPlan.view
                script = [pscustomobject]@{ path = $script:ScriptPath; sha256 = $script:ScriptSha }
                command_path = (Join-Path $root 'bin\deskpost.cmd')
            } | ConvertTo-Json -Depth 8 -Compress
        }
        return
    }
    if ($PlanId -and [string]$tempPlan.plan_id -ne $PlanId.Trim().ToLowerInvariant()) {
        throw "This is not the plan that was shown (plan_id $PlanId; the plan now is $($tempPlan.plan_id)): the release, an answer, the program folder or the Library changed since. Run the dry run again and show the new plan. Nothing was changed."
    }

    # --- 3. stage on the destination ----------------------------------------------------------------------------------
    $script:Root = $root
    $script:Txn = [guid]::NewGuid().ToString('N')
    $versions = Join-Path $root 'versions'
    $target = Join-Path $versions $version
    $currentLink = Join-Path $root 'current'
    $previousTarget = if (Test-Path -LiteralPath $currentLink) { [string](Get-LinkTarget $currentLink) } else { $null }
    # [string], NOT THE PROVIDER'S STRING: Get-Content -Raw attaches PSPath and PSProvider, and ConvertTo-Json -Depth then walks the provider.
    $previousRecord = if (Test-Path -LiteralPath (Join-Path $root 'current.json')) { [string][IO.File]::ReadAllText((Join-Path $root 'current.json')) } else { $null }
    $previousVersion = if ($previousRecord) { [string]($previousRecord | ConvertFrom-Json).version } else { $null }
    $previousPrevious = if ($previousRecord) { [string]($previousRecord | ConvertFrom-Json).previous } else { $null }
    $operation = switch ([string]$answers.install_state) { 'upgrade' { 'upgrade' } 'repair' { 'repair' } default { 'install' } }
    # A DIFFERENT TREE UNDER THIS VERSION IS REFUSED BEFORE ANYTHING IS RECORDED (post-build inspection #2): recorded
    # first, its pending blocked the very `deskpost uninstall` the refusal names.
    if (Test-Path -LiteralPath (Join-Path $target '.archive-sha256')) {
        $had = (Get-Content -LiteralPath (Join-Path $target '.archive-sha256') -Raw).Trim()
        if ($had -ne $actualSha) { throw "versions\$version differs from the release ($had); run deskpost uninstall, then install again. Nothing was changed." }
    } elseif (Test-Path -LiteralPath $target) {
        throw "versions\$version is already there with no record of its archive; run deskpost uninstall, then install again. Nothing was changed."
    }
    # A 1.0 INSTALL IS ADOPTED WITH ITS PATH ENTRY (S55, found in the Windows Sandbox run): 1.0 wrote no receipt, so an
    # upgrade found `<root>\bin` already on PATH, recorded nothing, and uninstall then left the entry behind. An install
    # with `current.json` and no receipt, and that exact entry on the user PATH, is 1.0's own work.
    $legacyPath = $false
    if ((Test-Path -LiteralPath (Join-Path $root 'current.json')) -and -not (Test-Path -LiteralPath (Join-Path $root 'install-receipt.json'))) {
        $userPath = [string](Get-Item -LiteralPath 'HKCU:\Environment').GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $legacyPath = @($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq (Join-Path $root 'bin') }).Count -gt 0
    }
    Invoke-UnderLock $root {
        $receipt = Read-Receipt $root
        if ($null -ne $receipt.pending) { throw "a Deskpost transaction appeared at $root while this one was being asked; run the installer again." }
        # THE FIRST WRITE INTO THE ROOT IS THE PENDING TRANSACTION (round 2, #2), before anything is staged.
        $receipt.pending = [pscustomobject]@{
            id = $script:Txn; operation = $operation; version = $version; archive_sha256 = $actualSha; root = $root
            owner = [pscustomobject]@{ pid = $PID; start_utc = (Get-ProcessStart $PID) }
            phase = 'staging'; candidate = $null; created_version = $false; path_change = (-not $NoPathChange); path_adopted = $legacyPath
            previous_target = $previousTarget; previous_record = $previousRecord; previous_version = $previousVersion; previous_previous = $previousPrevious
            steps = @('stage', 'plan', 'place-version', 'activate-current', 'shims', 'path', 'apply')
        }
        Write-Receipt $root $receipt
    }
    $script:OwnsPending = $true

    if (Test-Path -LiteralPath $target) {
        # THE SAME VERSION ALREADY THERE (round 3, #3): the same archive is the candidate, and Place skips the rename.
        $recorded = Join-Path $target '.archive-sha256'
        $had = if (Test-Path -LiteralPath $recorded) { (Get-Content -LiteralPath $recorded -Raw).Trim() } else { '' }
        if ($had -ne $actualSha) { throw "versions\$version differs from the release ($had); run deskpost uninstall, then install again. Nothing else was changed." }
        $candidate = $target
        $createdVersion = $false
        Write-Step "Version $version is already here from this archive; reusing it"
    } else {
        $candidate = Join-Path $versions ".incoming-$script:Txn"
        Write-Step "Copying $version into $root"
        New-Item -ItemType Directory -Path $versions -Force | Out-Null
        Copy-Item -LiteralPath $extracted -Destination $candidate -Recurse
        if ((Get-FileSha (Join-Path $candidate 'bin\library.exe')) -ne $tempExe) { throw "the copied binary does not match the one checked in $temp; the copy to $root is not trusted. Nothing was switched." }
        [IO.File]::WriteAllText((Join-Path $candidate '.archive-sha256'), "$actualSha`n", [Text.UTF8Encoding]::new($false))
        $createdVersion = $true
    }
    $inventory = Join-Path $candidate '.inventory.json'
    if (Test-Path -LiteralPath $inventory) {
        $bad = @((Get-Content -LiteralPath $inventory -Raw | ConvertFrom-Json).files | Where-Object { $f = Join-Path $candidate $_.path; -not (Test-Path -LiteralPath $f) -or (Get-FileSha $f) -ne $_.sha256 } | ForEach-Object { $_.path })
        if ($bad.Count) { throw "$($bad.Count) file(s) in the staged release do not match its inventory ($(($bad | Select-Object -First 5) -join ', ')); nothing was switched." }
    }
    Set-PendingMark $root 'staged' @{ candidate = $candidate; created_version = $createdVersion }

    # --- 4. plan, read-only, before anything is switched -------------------------------------------------------------
    $pendingDirectory = Join-Path $root '.pending'
    New-Item -ItemType Directory -Path $pendingDirectory -Force | Out-Null
    $planFile = Join-Path $pendingDirectory 'plan.json'
    $planned = Invoke-LibraryShown (Join-Path $candidate 'bin\library.exe') @('setup', '--plan', '--answers', $answersFile, '--resources', $candidate, '--register-as', $currentLink, '--out', $planFile, '--release-sha', $actualSha, '--script-sha', $script:ScriptSha)
    # THE STAGED PLAN IS THE APPROVED ONE (step 2): the same archive gives the same plan; a difference is a staging fault.
    $stagingFault = $null
    $script:AppliedView = $null
    if ($planned -eq 0) {
        $stagedPlan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $stagedPlan.PSObject.Properties['view']) { $script:AppliedView = $stagedPlan.view }
        if ($PlanId -and [string]$stagedPlan.plan_id -ne [string]$tempPlan.plan_id) { $stagingFault = "the staged release plans differently from the plan that was shown ($($stagedPlan.plan_id), not $($tempPlan.plan_id))" }
    }
    if ($stagingFault) {
        if ($createdVersion) { Remove-Item -LiteralPath $candidate -Recurse -Force }
        Invoke-UnderLock $root { $receipt = Read-Receipt $root; $receipt.pending = $null; Write-Receipt $root $receipt }
        Remove-Item -LiteralPath $pendingDirectory -Recurse -Force -ErrorAction SilentlyContinue
        $script:OwnsPending = $false
        throw "$stagingFault. Staging was removed; nothing was switched, and the Library was not touched."
    }
    if ($planned -ne 0) {
        # A REFUSAL HERE LEAVES ONLY STAGING TO REMOVE (round 2, #1): nothing was switched and the Library is untouched.
        if ($createdVersion) { Remove-Item -LiteralPath $candidate -Recurse -Force }
        Invoke-UnderLock $root { $receipt = Read-Receipt $root; $receipt.pending = $null; Write-Receipt $root $receipt }
        Remove-Item -LiteralPath $pendingDirectory -Recurse -Force -ErrorAction SilentlyContinue
        $script:OwnsPending = $false
        throw "the plan was refused (exit $planned); what it said is above. Nothing was switched, and the Library was not touched."
    }
    Copy-Item -LiteralPath $answersFile -Destination (Join-Path $pendingDirectory 'answers.json')
    Set-PendingMark $root 'planned'

    # --- 5 and 6. place, then apply ------------------------------------------------------------------------------------
    Invoke-Place $root (Read-Receipt $root).pending
    Invoke-Apply $root (Read-Receipt $root).pending
    $script:OwnsPending = $false
    $status = switch ($operation) { 'upgrade' { 'upgraded' } 'repair' { 'repaired' } default { 'installed' } }

    # THE COMMAND ROW IS HONEST ABOUT PATH (#17): what `deskpost` resolves to in this window, said as it is.
    $resolved = Get-Command deskpost -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $shim = Join-Path $root 'bin\deskpost.cmd'
    $command = if ($null -eq $resolved) { "not on this window's PATH; run $shim" }
               elseif ([IO.Path]::GetFullPath($resolved.Source) -ieq $shim) { 'ready in this window; other open terminals after a restart' }
               else { "this window runs $($resolved.Source) as deskpost, not this install; move $(Split-Path -Parent $shim) earlier on PATH" }

    # --- the plugin, opt-in ----------------------------------------------------------------------------------------
    $pluginResult = 'not installed (opt-in with -Plugin)'
    if ($Plugin -and -not $SkipPlugin) {
        $claude = Get-Command claude -ErrorAction SilentlyContinue
        if ($null -eq $claude) { $pluginResult = "claude is not on PATH. Run: claude plugin marketplace add `"$currentLink`" ; claude plugin install deskpost@deskpost" }
        else {
            $added = Invoke-Library $claude.Source @('plugin', 'marketplace', 'add', $currentLink)
            $installed = Invoke-Library $claude.Source @('plugin', 'install', 'deskpost@deskpost')
            $pluginResult = if ($added.exit -eq 0 -and $installed.exit -eq 0) { "installed from $currentLink" } else { "FAILED: marketplace add exited $($added.exit), plugin install exited $($installed.exit)" }
        }
    }

    # --- doctor: its result is the install's result ------------------------------------------------------------------
    $doctorArguments = @('doctor')
    if ($answers.library) { $doctorArguments += @('--workspace', [string]$answers.library) }
    $exe = Join-Path $currentLink 'bin\library.exe'
    if ($Json) {
        $doctor = Invoke-Library $exe ($doctorArguments + '--json')
        $report = $null
        try { $report = $doctor.stdout | ConvertFrom-Json } catch { $report = $null }
        $opens = if ($null -ne $script:AppliedView) { $script:AppliedView.opens } else { $null }
        [pscustomobject]@{ status = $status; version = $version; install_root = $root; library = $answers.library; command = $command; command_path = $shim; plan_id = $PlanId; opens = $opens; plugin = $pluginResult; doctor_exit = $doctor.exit; doctor = $report } | ConvertTo-Json -Depth 8 -Compress
        if ($doctor.exit -ne 0) { throw "deskpost doctor is not green (exit $($doctor.exit)); the install is in place, and deskpost rollback switches back." }
    } else {
        Write-Host ''
        $doctorExit = Invoke-LibraryShown $exe $doctorArguments
        Write-Host ''
        if ($doctorExit -ne 0) { throw "deskpost doctor is not green (exit $doctorExit): the lines marked [x] above say what to fix. The install is in place; deskpost rollback switches back." }
        $done = if ($status -eq 'upgraded') { "Deskpost is upgraded to $version." } else { "Deskpost $version is installed." }
        Write-Host $(if ($answers.library) { "$done Your Library is at $($answers.library)." } else { "$done No Library was set up." })
        Write-Host "  Command  deskpost: $command"
        if ($Plugin) { Write-Host "  Plugin   $pluginResult" }
        # THE FORK, OR ONE LINE (step 5). A person is offered the tutorial or the main menu once this script has let
        # go of everything (below the finally); a script, -Yes, CI or no terminal gets `Next: deskpost`, and nothing
        # is ever launched for it. `-Library none` has no Library to show, so it names how to make one.
        if (-not $answers.library) { Write-Host 'Next: deskpost setup <folder>, to make a Library.' }
        elseif ($script:Interactive -and $status -eq 'installed') { $script:Welcome =@{ exe = $exe; library = [string]$answers.library; assistant = [string]$answers.assistant } }
        else { Write-Host 'Next: deskpost' }
    }
}
finally {
    # AN UNFINISHED TRANSACTION THIS RUN OWNS IS RELINQUISHED (round 5, #1): the one-liner runs in the reader's own
    # PowerShell, which outlives this script, so without this a failed install would block its own retry until the
    # window closed. The recovery data stays; the next run claims it.
    if ($script:OwnsPending -and $script:Root) {
        try {
            Invoke-UnderLock $script:Root {
                $receipt = Read-Receipt $script:Root
                if ($null -ne $receipt.pending -and $receipt.pending.id -eq $script:Txn) { $receipt.pending.owner = $null; Write-Receipt $script:Root $receipt }
            }
        } catch { [Console]::Error.WriteLine("The interrupted transaction at $($script:Root) could not be released: $($_.Exception.Message)") }
    }
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

# THE LOCK IS NEVER HELD DURING A CONVERSATION (round 2, #4): the fork runs only here, after `pending` was cleared by
# Apply and the finally above released what this run held. Its console is the reader's.
if ($script:Welcome) {
    $welcomeArguments = @('setup', '--welcome', '--workspace', $script:Welcome.library)
    if ($script:Welcome.assistant) { $welcomeArguments += @('--assistant', $script:Welcome.assistant) }
    [void](Invoke-LibraryShown $script:Welcome.exe $welcomeArguments)
}
