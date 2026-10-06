<#
.SYNOPSIS
    Install Deskpost on Windows. Since 1.3.5 this script only forwards: it fetches a release and checks it, then runs
    that release's own `library.exe install`, which installs with no PowerShell (PLAN-install-without-powershell.md D6;
    ADR-0066). `deskpost` is the command it leaves ready; `deskpost uninstall` undoes it.

.DESCRIPTION
    The archive's hash must equal its SHA256SUMS line; the extracted binary then does everything else, its output
    relayed as it is (with -Json, its one JSON result). A refusal is thrown as one line. Recovery is re-running the
    one-liner. It calls `exit` only when run as a file, after a committed transaction, never when dot-sourced or run
    through `irm`. The parameters are `library install`'s flags (`library help install`).

        & ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/latest/download/install.ps1)))
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
    [switch]$KeepLibraries,
    [ValidateSet('', 'finish', 'undo')][string]$Resume = '',
    [switch]$NoPathChange,
    [switch]$Plugin,
    [switch]$SkipPlugin,
    [switch]$Rollback,
    [switch]$Json,
    [string]$PlanId,
    [ValidateSet('', 'claude', 'codex')][string]$Librarian = '',
    [string]$Workspace   # accepted for 1.0's callers, and ignored
)

# A CHILD SCOPE (PLAN-one-step-upgrade.md D4): `irm ... | iex` runs this text in the caller's scope, where strict mode,
# 'Stop', these functions and any variable would outlive the install. Two automatic variables change inside the block, so
# they are passed into it as its arguments, evaluated here, and nothing is set in the caller's scope (kickoffs/s94 row 2).
& {
param($libraryGiven, $dotSourced)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $InstallRoot) { $InstallRoot = if ($env:DESKPOST_INSTALL_ROOT) { $env:DESKPOST_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'deskpost' } }
if (-not $libraryGiven -and $env:DESKPOST_LIBRARY) { $Library = $env:DESKPOST_LIBRARY }
# AN INSTALL ASKED FOR AS JSON MUST NAME THE PLAN IT WAS SHOWN (PLAN-assistant-onboarding.md step 2), before any download.
if ($Json -and -not $DryRun -and -not $PlanId -and -not $Rollback) {
    throw 'An install asked for as JSON must name the plan it was shown: run with -DryRun -Json first, then again with -PlanId <plan_id>. Nothing was changed.'
}
# THIS SCRIPT'S OWN IDENTITY (step 2, flaw D): run as a file it has a path and a hash, which the plan carries.
$scriptPath = if ($PSCommandPath) { $PSCommandPath } else { '' }
$scriptSha = if ($scriptPath) { (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')

function ConvertTo-CommandLineArgument([string]$Value) {   # as CommandLineToArgvW reads it back
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $out = '"'; $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' } else { $out += ('\' * $slashes) + $ch }
        $slashes = 0
    }
    $out + ('\' * ($slashes * 2)) + '"'
}

function Invoke-Program([string]$Executable, [string[]]$Arguments, [switch]$Capture) {
    <# THE CONSOLE IS THE CHILD'S unless its stdout is captured (-Json, the capability check); stderr is always the console's. #>
    $start = New-Object Diagnostics.ProcessStartInfo $Executable
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).ProviderPath
    if ($Capture) { $start.RedirectStandardOutput = $true; $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false) }
    $process = [Diagnostics.Process]::Start($start)
    $stdout = if ($Capture) { $process.StandardOutput.ReadToEnd() } else { '' }
    $process.WaitForExit()
    [pscustomobject]@{ exit = $process.ExitCode; stdout = $stdout }
}

# ONE ROLLBACK, THE KERNEL'S (ADR-0063 decision 9).
if ($Rollback) {
    $exe = Join-Path $InstallRoot 'current\bin\library.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "nothing to roll back: $exe is not there." }
    $ran = Invoke-Program $exe @(@('rollback', '--yes') + @(if ($Json) { '--json' })) -Capture:$Json
    if ($Json -and $ran.stdout.Trim()) { $ran.stdout.Trim() }
    if ($ran.exit -ne 0) { throw "deskpost rollback refused (exit $($ran.exit)); what it said is above." }
    return
}

if (-not $Platform) { $Platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' } }
if ($Platform -notin 'win-x64', 'win-arm64') { throw "install.ps1 installs a Windows release; '$Platform' is not one. Use install.sh on macOS and Linux." }

$temp = Join-Path ([IO.Path]::GetTempPath()) ('deskpost-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
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
    $step = "  Reading the release's checksums from $Release"
    if ($Json) { [Console]::Error.WriteLine($step) } else { Write-Host $step }
    $lines = @(Get-Content -LiteralPath (Get-ReleaseFile 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?(deskpost-[0-9A-Za-z.+-]+-$([regex]::Escape($Platform))\.zip)\s*$" })
    if ($lines.Count -ne 1) { throw "SHA256SUMS names $($lines.Count) archive(s) for $Platform; an install needs exactly one." }
    [void]($lines[0] -match "^([0-9a-f]{64})\s+\*?(\S+)")
    $expectedSha, $archiveName = $Matches[1], $Matches[2]
    $archive = Get-ReleaseFile $archiveName
    $actualSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $expectedSha) { throw "$archiveName hashes to $actualSha and SHA256SUMS says $expectedSha. Nothing was installed." }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $temp 'x'))
    $roots = @(Get-ChildItem -LiteralPath (Join-Path $temp 'x') -Directory)
    if ($roots.Count -ne 1) { throw "$archiveName holds $($roots.Count) top-level folders; a release holds one." }
    $extracted = $roots[0].FullName
    $exe = Join-Path $extracted 'bin\library.exe'
    # A CAPABILITY CHECK, NOT A VERSION COMPARE (D6): a fixture's `<v>+upgrade` or a prerelease tag still knows the verb.
    if ((Invoke-Program $exe @('install', '--help') -Capture).exit -ne 0) { throw "This release predates ``library install``. Use that release's own install.ps1. Nothing was installed." }

    $refusal = Join-Path $temp 'refusal.txt'
    $arguments = @('install', '--extracted', $extracted, '--archive-sha256', $actualSha, '--release', $Release, '--install-root', $InstallRoot,
        '--platform', $Platform, '--forwarded', '--refusal-file', $refusal, '--script-sha', $scriptSha)
    if ($libraryGiven -or $Library) { $arguments += @('--library', $Library) }
    if ($scriptPath) { $arguments += @('--script-path', $scriptPath, '--run-as-file') }
    if ($Resume) { $arguments += @('--resume', $Resume) }
    if ($PlanId) { $arguments += @('--plan-id', $PlanId) }
    if ($Librarian) { $arguments += @('--librarian', $Librarian) }
    foreach ($flag in @(
        @($Yes, '--yes'), @($DryRun, '--dry-run'), @($AllowOverlap, '--allow-overlap'), @($Repair, '--repair'), @($KeepLibraries, '--keep-libraries'),
        @($NoPathChange, '--no-path-change'), @($Plugin, '--plugin'), @($SkipPlugin, '--skip-plugin'), @($Json, '--json'))) {
        if ($flag[0]) { $arguments += $flag[1] }
    }
    $ran = Invoke-Program $exe $arguments -Capture:$Json
    if ($Json -and $ran.stdout.Trim()) { $ran.stdout.Trim() }
    if ($ran.exit -eq 0 -and -not $NoPathChange -and -not $DryRun) {
        # THIS WINDOW TOO (D4): the program cannot change its caller's PATH, so the one-liner's window is given the entry here.
        $bin = Join-Path $InstallRoot 'bin'
        if ((Test-Path -LiteralPath (Join-Path $bin 'deskpost.cmd')) -and -not @($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin }).Count) { $env:Path = $env:Path.TrimEnd(';') + ';' + $bin }
    }
    # 0 is done, 3 the reader quitting; a refusal is thrown in the program's own words. A committed install whose check is
    # not green said so (D7), never an exception: a file run exits with its code; dot-sourced ('.') or the one-liner, never.
    if ($ran.exit -notin 0, 3) {
        $said = if (Test-Path -LiteralPath $refusal) { [IO.File]::ReadAllText($refusal).Trim() } else { '' }
        if ($said) { throw $said }
        $global:LASTEXITCODE = $ran.exit
        if ($scriptPath -and -not $dotSourced) { exit $ran.exit }
    }
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
} ($PSBoundParameters.ContainsKey('Library')) ($MyInvocation.InvocationName -eq '.')
