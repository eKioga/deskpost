<#
.SYNOPSIS
    Install the Library on Windows from a release: verify it, place it in a versioned directory,
    switch the `library` shim to it, register the plugin, and let `library doctor` say whether it
    worked.

.DESCRIPTION
    PLAN-public-release.md step 28. A release is the archives tools/Build-KernelRelease.ps1 writes --
    `deskpost-<version>-<platform>.zip`, each the program tree with the compiled kernel at bin/ --
    and the SHA256SUMS beside them. In order:

      1. SHA256SUMS is read and the ONE line for this platform is taken from it. The archive's hash
         must equal that line before anything is extracted. Checksum-only authenticity is v1's
         accepted limitation (the plan says so, and so does the README); a signed manifest is v1.x.
      2. The archive is extracted beside the versions it will join, and its bin/library.exe is RUN:
         `--version` must report the tuple release.json records -- plugin, binary and workspace
         schema versions -- and the extracted tree as its program root. Only then is it renamed into
         versions/<version>.
      3. current -- a junction beside versions\ -- is switched onto that version, and bin/library.cmd
         runs current\bin\library.exe. CURRENT IS THE PROGRAM ROOT the binary reports and every hook
         path `library init` writes into a workspace (S30, the reader's ruling), so an upgrade does not
         move it and a workspace's hooks survive the old version's removal. The switch is a new junction
         renamed onto the old one's name, with an instant between in which neither exists. current.json
         records the version and the one before it, which is what -Rollback switches back to.
      4. Only with -Plugin, the release is added as a Claude Code marketplace and the plugin
         installed from it. THE PLUGIN IS OPT-IN (S47, the reader's ruling): `library init` registers a
         workspace's own guards and reader, and a plugin as well made every guard run twice on the
         README's route -- measured in S7's Windows Sandbox, and warned by doctor.
      5. `library doctor` runs. ITS RESULT IS THE INSTALL'S RESULT: an installer that exited 0 over a
         red doctor would report success for an install that does not work.

    An install already at a version is reused when its archive hash matches and refused when it does
    not: two different trees under one version number is a defect in the release, not something to
    overwrite.

    From a release on the web, as one line:

        & ([scriptblock]::Create((irm https://github.com/eKioga/deskpost/releases/latest/download/install.ps1)))

.PARAMETER Release
    A folder holding SHA256SUMS and the archives, or the base URL they are served from. Defaults to
    the latest GitHub release.

.PARAMETER InstallRoot
    Defaults to %LOCALAPPDATA%\deskpost. Holds versions\, the current junction, bin\library.cmd and
    current.json.

.PARAMETER Workspace
    The workspace `library doctor` reports on. Without one, doctor reports its workspace checks
    skipped, which is still an answer.

.PARAMETER NoPathChange
    Leave the user PATH alone. By default <InstallRoot>\bin is appended to it once.

.PARAMETER Plugin
    Also register the release as a Claude Code marketplace and install the plugin from it, for a reader
    who wants the guards in every Claude session rather than per workspace.

.PARAMETER SkipPlugin
    Accepted and ignored: skipping the plugin is the default since S47.

.PARAMETER Rollback
    Switch the shim back to the version installed before the current one. Nothing is downloaded.
#>

[CmdletBinding()]
param(
    [string]$Release = 'https://github.com/eKioga/deskpost/releases/latest/download',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'deskpost'),
    [string]$Platform,
    [string]$Workspace,
    [switch]$NoPathChange,
    [switch]$Plugin,
    [switch]$SkipPlugin,
    [switch]$Rollback,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { if (-not $Json) { Write-Host "  $Text" } }

function Write-TextAtomically([string]$Path, [string]$Text) {
    <#
        Write beside the target, then one rename over it. [IO.File]::Replace is the rename that may
        land on an existing file; a first install has none to replace.
    #>
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $incoming = "$Path.incoming"
    [IO.File]::WriteAllText($incoming, $Text, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($incoming, $Path, [NullString]::Value) }
    else { [IO.File]::Move($incoming, $Path) }
}

function Read-Current {
    $file = Join-Path $InstallRoot 'current.json'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
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

function Switch-Current([string]$Version) {
    <#
        <InstallRoot>\current -> versions\<Version>, the path every workspace's hooks name (S30, the
        reader's ruling), so the program root does not move on an upgrade. A NEW JUNCTION BESIDE IT,
        THEN THE OLD ONE REMOVED AND THE NEW ONE RENAMED ONTO ITS NAME: Windows has no rename that lands
        a directory on an existing one, so there is an instant between the two in which `current` does
        not exist and a `library` or hook started then fails to start. Stated, not hidden. Both calls
        act on the link alone -- measured: [IO.Directory]::Delete removes a junction and leaves its
        target's files, and [IO.Directory]::Move renames the junction.
    #>
    $current = Join-Path $InstallRoot 'current'
    $target = Join-Path $versions $Version
    $had = Get-LinkTarget $current
    if ($had -ieq $target) { return }
    $incoming = "$current.incoming-" + [guid]::NewGuid().ToString('N')
    New-Item -ItemType Junction -Path $incoming -Target $target | Out-Null
    if ($null -ne $had) { [IO.Directory]::Delete($current) }
    [IO.Directory]::Move($incoming, $current)
}

function Get-ExpectedProgramRoot([string]$Root) {
    <# What a binary at <Root>\bin reports: current, when current is a link onto <Root>; otherwise <Root>. #>
    $current = Join-Path $InstallRoot 'current'
    $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ((Test-Path -LiteralPath $current) -and ((Get-LinkTarget $current) -ieq $full)) { return $current }
    $full
}

function Set-Shim([string]$Version, [string]$Previous, [string]$ArchiveSha256) {
    Switch-Current $Version
    # %~dp0 is the shim's own folder, so the install root can be moved as a whole. THROUGH current, so
    # the shim's text is the same for every version and the switch above is the whole switch.
    $shim = "@`"%~dp0..\current\bin\library.exe`" %*`r`n"
    Write-TextAtomically (Join-Path $InstallRoot 'bin\library.cmd') $shim
    $record = [ordered]@{ schema = 1; version = $Version; previous = $Previous; archive_sha256 = $ArchiveSha256; switched = (Get-Date).ToString('o') }
    Write-TextAtomically (Join-Path $InstallRoot 'current.json') (($record | ConvertTo-Json) + "`n")
}

function Switch-Verified([string]$Version, [string]$Previous, [string]$ArchiveSha256, $Expected) {
    <#
        Switch, then ask the binary THROUGH current -- the root every workspace will name -- and put
        current and current.json back as they were when it does not answer with it. A version built
        before current existed reports its own versions\<v> path and is refused here: a workspace
        initialised by it would name a path that moves.
    #>
    $stable = Join-Path $InstallRoot 'current'
    $recordFile = Join-Path $InstallRoot 'current.json'
    $recordBefore = if (Test-Path -LiteralPath $recordFile) { Get-Content -LiteralPath $recordFile -Raw } else { $null }
    $linkBefore = Get-LinkTarget $stable
    Set-Shim $Version $Previous $ArchiveSha256
    try { Assert-Tuple $stable $Expected $stable }
    catch {
        $undo = 'nothing was switched back: there was no version before it'
        if ($null -ne $linkBefore) {
            Switch-Current (Split-Path -Leaf $linkBefore)
            if ($null -ne $recordBefore) { Write-TextAtomically $recordFile $recordBefore }
            $undo = "current points at $(Split-Path -Leaf $linkBefore) again"
        }
        throw "$($_.Exception.Message) ($undo)"
    }
}

function Invoke-Library([string]$Executable, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stdout = & $Executable @Arguments 2>$null
        [pscustomobject]@{ exit = $LASTEXITCODE; stdout = ($stdout | Out-String) }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Assert-Tuple([string]$Root, $Expected, [string]$ExpectRoot = $Root) {
    <#
        The binary is asked, not the file beside it: a binary that cannot find its program says so here.
        -ExpectRoot is the root it must report, which is `current` once current links onto its version.
    #>
    $ran = Invoke-Library (Join-Path $Root 'bin\library.exe') @('--version')
    if ($ran.exit -ne 0) { throw "$Root\bin\library.exe exited $($ran.exit) on --version; the release does not run on this machine." }
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

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$versions = Join-Path $InstallRoot 'versions'

# --- rollback ----------------------------------------------------------------------------------

if ($Rollback) {
    $current = Read-Current
    if ($null -eq $current -or -not $current.previous) { throw "nothing to roll back to: $InstallRoot\current.json names no previous version." }
    $target = Join-Path $versions $current.previous
    if (-not (Test-Path -LiteralPath (Join-Path $target 'bin\library.exe'))) { throw "the previous version $($current.previous) is no longer under $versions." }
    $expected = Get-Content -LiteralPath (Join-Path $target 'release.json') -Raw | ConvertFrom-Json
    [void](Assert-Tuple $target $expected (Get-ExpectedProgramRoot $target))
    $sha = if (Test-Path -LiteralPath (Join-Path $target '.archive-sha256')) { (Get-Content -LiteralPath (Join-Path $target '.archive-sha256') -Raw).Trim() } else { $null }
    [void](Switch-Verified $current.previous $current.version $sha $expected)
    $result = [pscustomobject]@{ action = 'rolled-back'; version = $current.previous; from = $current.version; install_root = $InstallRoot
        plugin = 'The plugin is not rolled back by this switch. Reinstall it from the version above if it was upgraded with the binary.' }
    if ($Json) { $result | ConvertTo-Json } else { $result }
    return
}

# --- 1. the checksum ---------------------------------------------------------------------------

if (-not $Platform) { $Platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' } }
if ($Platform -notin 'win-x64', 'win-arm64') { throw "install.ps1 installs a Windows release; '$Platform' is not one. Use install.sh on macOS and Linux." }

$isLocal = Test-Path -LiteralPath $Release -PathType Container
$downloads = Join-Path $InstallRoot 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null

function Get-ReleaseFile([string]$Name) {
    $to = Join-Path $downloads $Name
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

Write-Step "Verifying $archiveName"
$archive = Get-ReleaseFile $archiveName
$actualSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha -ne $expectedSha) {
    Remove-Item -LiteralPath $archive -Force
    throw "$archiveName hashes to $actualSha and SHA256SUMS says $expectedSha. Nothing was installed, and the download was deleted."
}

# --- 2. extract and ask the binary -------------------------------------------------------------

$incoming = Join-Path $versions (".incoming-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $incoming -Force | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $incoming)
    $roots = @(Get-ChildItem -LiteralPath $incoming -Directory)
    if ($roots.Count -ne 1) { throw "$archiveName holds $($roots.Count) top-level folders; a release holds one." }
    $extracted = $roots[0].FullName
    $releaseRecord = Get-Content -LiteralPath (Join-Path $extracted 'release.json') -Raw | ConvertFrom-Json
    if ($releaseRecord.platform -ne $Platform) { throw "$archiveName is built for $($releaseRecord.platform), not $Platform." }
    $version = [string]$releaseRecord.plugin_version
    if ($version -notmatch '^[0-9A-Za-z.+-]+$') { throw "release.json's version '$version' cannot name a directory." }

    $target = Join-Path $versions $version
    if (Test-Path -LiteralPath $target) {
        $recorded = Join-Path $target '.archive-sha256'
        $had = if (Test-Path -LiteralPath $recorded) { (Get-Content -LiteralPath $recorded -Raw).Trim() } else { '' }
        if ($had -ne $actualSha) {
            throw "version $version is already installed at $target from a different archive ($had). Two trees under one version number is a defect in the release; nothing was changed."
        }
        Write-Step "Version $version is already installed from this archive; reusing it"
        $reused = $true
    } else {
        Write-Step "Checking the binary reports the release's tuple"
        [void](Assert-Tuple $extracted $releaseRecord)
        Move-Item -LiteralPath $extracted -Destination $target
        [IO.File]::WriteAllText((Join-Path $target '.archive-sha256'), "$actualSha`n", [Text.UTF8Encoding]::new($false))
        $reused = $false
    }
} finally {
    if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force }
}
[void](Assert-Tuple $target $releaseRecord (Get-ExpectedProgramRoot $target))

# --- 3. the shim -------------------------------------------------------------------------------

$current = Read-Current
$previous = if ($null -ne $current -and $current.version -ne $version) { [string]$current.version } elseif ($null -ne $current) { $current.previous } else { $null }
$tuple = Switch-Verified $version $previous $actualSha $releaseRecord
$shim = Join-Path $InstallRoot 'bin\library.cmd'
$stable = Join-Path $InstallRoot 'current'
Write-Step "library now runs $version ($shim)"

$pathAction = 'unchanged (-NoPathChange)'
if (-not $NoPathChange) {
    # THE REGISTRY VALUE, UNEXPANDED, and written back as REG_EXPAND_SZ. [Environment]::SetEnvironmentVariable
    # would write the EXPANDED path as REG_SZ and silently freeze every %VARIABLE% entry already there.
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $bin = Join-Path $InstallRoot 'bin'
    if (@($raw -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin }).Count) { $pathAction = 'already on the user PATH' }
    else {
        $updated = if ($raw.Trim()) { $raw.TrimEnd(';') + ';' + $bin } else { $bin }
        Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $updated -Type ExpandString
        $pathAction = "appended $bin to the user PATH; new terminals will find library"
    }
}

# --- 4. the plugin -----------------------------------------------------------------------------

$plugin = [ordered]@{ claude = 'not installed (opt-in with -Plugin; library init registers a workspace''s guards)'; codex = 'not installed (opt-in with -Plugin)' }
if ($Plugin -and -not $SkipPlugin) {
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($null -eq $claude) {
        $plugin.claude = "claude is not on PATH. Run: claude plugin marketplace add `"$stable`" ; claude plugin install deskpost@deskpost"
    } else {
        $added = Invoke-Library $claude.Source @('plugin', 'marketplace', 'add', $stable)
        $installed = Invoke-Library $claude.Source @('plugin', 'install', 'deskpost@deskpost')
        $plugin.claude = if ($added.exit -eq 0 -and $installed.exit -eq 0) { "installed from $stable" }
                         else { "FAILED: marketplace add exited $($added.exit), plugin install exited $($installed.exit)" }
    }
    $plugin.codex = "Codex has no non-interactive plugin install yet. In Codex, run /plugins and add the marketplace at $stable."
}

# --- 5. doctor ---------------------------------------------------------------------------------

Write-Step 'Running library doctor'
$doctorArguments = @('doctor', '--json')
if ($Workspace) { $doctorArguments += @('--workspace', $Workspace) }
$doctor = Invoke-Library (Join-Path $stable 'bin\library.exe') $doctorArguments
$report = $null
try { $report = $doctor.stdout | ConvertFrom-Json } catch { $report = $null }

$result = [pscustomobject]@{
    action         = if ($reused) { 'reused' } else { 'installed' }
    version        = $version
    platform       = $Platform
    archive_sha256 = $actualSha
    install_root   = $InstallRoot
    shim           = $shim
    previous       = $previous
    tuple          = $tuple
    path           = $pathAction
    plugin         = [pscustomobject]$plugin
    doctor_exit    = $doctor.exit
    doctor         = $report
}
if ($Json) { $result | ConvertTo-Json -Depth 6 } else { $result | Format-List | Out-String | Write-Host }
if ($doctor.exit -ne 0) {
    [Console]::Error.WriteLine("library doctor is not green (exit $($doctor.exit)), so this install is not accepted. It is in place; install.ps1 -Rollback switches back.")
    exit 1
}
