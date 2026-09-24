<#
.SYNOPSIS
    The upgrade and rollback fixture: a workspace initialised by one installed version survives an
    upgrade to the next, a rollback to the first, and the removal of the version it was initialised by.

.DESCRIPTION
    S30, the reader's ruling on how a workspace survives an upgrade: install.ps1 keeps
    <InstallRoot>\current as a junction onto versions\<v>, the shim runs through it, and a compiled
    kernel reports current as its program root whenever current resolves to its own version
    (kernel/src/programroot.ts, stableProgramRoot). So every hook and adapter path `library init`
    writes names current and never moves. Before that, a versioned install moved the program root on
    every upgrade: `library init --force` then refused the workspace's hooks as "hooks the Library did
    not write", and the hooks broke the day the old version was removed.

    Everything runs under a scratch install root and a scratch workspace; the reader's own install and
    workspace are never touched. From one release (-Release, as tools/Build-KernelRelease.ps1 writes
    it) a second is made by re-versioning the tree -- release.json's plugin_version and the plugin
    manifests -- so the upgrade moves between two program roots with the same binary in each. The
    binary's baked version is unchanged, which is what release.json's binary_version says; what an
    upgrade does to a workspace is decided by where the program root is, and that is what moves.

    In order: install A; init through the shim; every program path in the workspace names current and
    exists; install B; `init --force` succeeds and leaves every program path as it was; -Rollback to
    A and the same again; upgrade to B again, DELETE versions\A, and every program path still exists
    and `init --force` still succeeds.

.PARAMETER Release
    A folder holding SHA256SUMS and a win-x64 archive.

.PARAMETER PlantDefect
    Falsification: initialise the workspace with the PowerShell initialiser run from versions\A --
    a program that does not know about current, so its hooks name the version -- and expect this
    fixture to FAIL. A fixture that passes over that has not tested an upgrade.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Release,
    [string]$WorkRoot,
    [switch]$PlantDefect,
    [switch]$Keep,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$programRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $programRoot 'install.ps1'
if (-not $WorkRoot) { $WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ('kernel-upgrade-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
if (Test-Path -LiteralPath $WorkRoot) { throw "$WorkRoot already exists; the fixture builds in a directory of its own." }
New-Item -ItemType Directory -Path $WorkRoot | Out-Null

$installRoot = Join-Path $WorkRoot 'install'
$workspace = Join-Path $WorkRoot 'workspace'
$registry = Join-Path $WorkRoot 'registry'
$current = Join-Path $installRoot 'current'
$shim = Join-Path $installRoot 'bin\library.cmd'
New-Item -ItemType Directory -Path $workspace, $registry | Out-Null

$checks = [Collections.Generic.List[object]]::new()
function Check([bool]$Condition, [string]$Label) { [void]$checks.Add([pscustomobject]@{ ok = $Condition; check = $Label }) }

function Invoke-Quiet([string]$Executable, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stdout = & $Executable @Arguments 2>&1
        [pscustomobject]@{ exit = $LASTEXITCODE; text = ($stdout | Out-String) }
    } finally { $ErrorActionPreference = $previous }
}

function Install-From([string]$Folder, [switch]$Rollback) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $installRoot, '-NoPathChange', '-SkipPlugin', '-Json')
    if ($Rollback) { $arguments += '-Rollback' } else { $arguments += @('-Release', $Folder) }
    Invoke-Quiet 'powershell.exe' $arguments
}

function Get-LinkLeaf { if (Test-Path -LiteralPath $current) { Split-Path -Leaf ([string]@((Get-Item -LiteralPath $current -Force).Target)[0]) } }

function Get-ProgramPaths {
    <# Every path into the install that init wrote, from the four files that carry them, as written. #>
    $found = [Collections.Generic.List[string]]::new()
    $pattern = [regex]::Escape($installRoot.Replace('\', '/')) + '/[^"'' ]+'
    foreach ($relative in '.claude\settings.local.json', '.codex\hooks.json', '.codex\config.toml', '.mcp.json') {
        $file = Join-Path $workspace $relative
        if (-not (Test-Path -LiteralPath $file)) { continue }
        # An escaped quote is a quote BEFORE any backslash becomes a slash: a JSON command line carries
        # `\"<path>\"`, and turning that into `/"` gave every quoted path a trailing slash (measured).
        $text = (Get-Content -LiteralPath $file -Raw).Replace('\\', '/').Replace('\"', '"').Replace('\', '/')
        foreach ($match in [regex]::Matches($text, $pattern, 'IgnoreCase')) { [void]$found.Add($match.Value) }
    }
    @($found | Sort-Object -Unique)
}

function Test-ProgramPaths([string]$When) {
    $paths = @(Get-ProgramPaths)
    Check ($paths.Count -gt 0) "$When`: the workspace names no program path at all, so nothing here was measured"
    $viaCurrent = $installRoot.Replace('\', '/') + '/current/'
    $moving = @($paths | Where-Object { -not $_.StartsWith($viaCurrent, [StringComparison]::OrdinalIgnoreCase) })
    Check ($moving.Count -eq 0) "$When`: $($moving.Count) program path(s) name something other than current, e.g. $(@($moving) | Select-Object -First 1)"
    $missing = @($paths | Where-Object { -not (Test-Path -LiteralPath $_) })
    Check ($missing.Count -eq 0) "$When`: $($missing.Count) program path(s) do not exist, e.g. $(@($missing) | Select-Object -First 1)"
    $paths
}

function Initialize-Again([string]$When) {
    $ran = Invoke-Quiet $shim @('init', $workspace, '--registry-root', $registry, '--force', '--json')
    Check ($ran.exit -eq 0) "$When`: library init --force exited $($ran.exit): $(($ran.text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1))"
}

try {
    # --- two releases from one -----------------------------------------------------------------
    $sums = @(Get-Content -LiteralPath (Join-Path $Release 'SHA256SUMS') | Where-Object { $_ -match 'deskpost-(\S+)-win-x64\.zip' })
    if ($sums.Count -ne 1) { throw "$Release\SHA256SUMS names $($sums.Count) win-x64 archives; the fixture needs one." }
    [void]($sums[0] -match '^[0-9a-f]{64}\s+\*?(deskpost-(\S+)-win-x64\.zip)')
    $archiveA, $versionA = $Matches[1], $Matches[2]
    $versionB = "$versionA+upgrade"
    $releaseA = Join-Path $WorkRoot 'release-a'
    $releaseB = Join-Path $WorkRoot 'release-b'
    New-Item -ItemType Directory -Path $releaseA, $releaseB | Out-Null
    Copy-Item -LiteralPath (Join-Path $Release $archiveA), (Join-Path $Release 'SHA256SUMS') -Destination $releaseA

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stage = Join-Path $WorkRoot 'stage'
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $releaseA $archiveA), $stage)
    $treeA = Join-Path $stage "deskpost-$versionA-win-x64"
    $treeB = Join-Path $stage "deskpost-$versionB-win-x64"
    Rename-Item -LiteralPath $treeA -NewName (Split-Path -Leaf $treeB)
    foreach ($manifest in 'release.json', '.codex-plugin\plugin.json', '.claude-plugin\plugin.json') {
        $file = Join-Path $treeB $manifest
        if (-not (Test-Path -LiteralPath $file)) { continue }
        $field = if ($manifest -eq 'release.json') { 'plugin_version' } else { 'version' }
        $text = [IO.File]::ReadAllText($file)
        $bumped = [regex]::Replace($text, '("' + $field + '"\s*:\s*")' + [regex]::Escape($versionA) + '"', ('${1}' + $versionB + '"'))
        if ($bumped -eq $text) { throw "$manifest has no $field of $versionA to re-version." }
        [IO.File]::WriteAllText($file, $bumped, [Text.UTF8Encoding]::new($false))
    }
    $archiveB = "deskpost-$versionB-win-x64.zip"
    $zip = [IO.Compression.ZipFile]::Open((Join-Path $releaseB $archiveB), [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $treeB -Recurse -File -Force)) {
            $relative = $file.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative)
        }
    } finally { $zip.Dispose() }
    $shaB = (Get-FileHash -LiteralPath (Join-Path $releaseB $archiveB) -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $releaseB 'SHA256SUMS'), "$shaB  $archiveB`n", [Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $stage -Recurse -Force

    # --- A, and a workspace it initialises -----------------------------------------------------
    $ran = Install-From $releaseA
    Check ($ran.exit -eq 0) "installing $versionA exited $($ran.exit)"
    Check ((Get-LinkLeaf) -eq $versionA) "after installing $versionA, current points at $(Get-LinkLeaf)"
    if ($PlantDefect) {
        $initialiser = Join-Path $installRoot "versions\$versionA\tools\Initialize-LibraryWorkspace.ps1"
        $ran = Invoke-Quiet 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $initialiser, '-Path', $workspace, '-RegistryRoot', $registry, '-Json')
    } else {
        $ran = Invoke-Quiet $shim @('init', $workspace, '--registry-root', $registry, '--json')
    }
    Check ($ran.exit -eq 0) "the first init exited $($ran.exit)"
    $pathsA = Test-ProgramPaths "initialised by $versionA"
    $hooksBefore = [IO.File]::ReadAllText((Join-Path $workspace '.claude\settings.local.json'))

    # --- upgrade to B ------------------------------------------------------------------------
    $ran = Install-From $releaseB
    Check ($ran.exit -eq 0) "upgrading to $versionB exited $($ran.exit)"
    Check ((Get-LinkLeaf) -eq $versionB) "after the upgrade, current points at $(Get-LinkLeaf)"
    $record = Get-Content -LiteralPath (Join-Path $installRoot 'current.json') -Raw | ConvertFrom-Json
    Check ($record.previous -eq $versionA) "after the upgrade, current.json's previous is '$($record.previous)', not $versionA"
    $tuple = (Invoke-Quiet $shim @('--version')).text | ConvertFrom-Json
    Check ($tuple.plugin_version -eq $versionB) "after the upgrade, the shim runs plugin version $($tuple.plugin_version)"
    Initialize-Again 'after the upgrade'
    $pathsB = Test-ProgramPaths 'after the upgrade'
    Check ((@($pathsB) -join '|') -ceq (@($pathsA) -join '|')) 'the upgrade changed a program path the workspace names'
    Check ([IO.File]::ReadAllText((Join-Path $workspace '.claude\settings.local.json')) -ceq $hooksBefore) 'the upgrade rewrote the hook block'
    $marker = Get-Content -LiteralPath (Join-Path $workspace '.library\workspace.json') -Raw | ConvertFrom-Json
    Check ($marker.program_version -eq $versionB) "after init --force, the marker records program version $($marker.program_version)"

    # --- rollback to A -----------------------------------------------------------------------
    $ran = Install-From $null -Rollback
    Check ($ran.exit -eq 0) "rolling back exited $($ran.exit)"
    Check ((Get-LinkLeaf) -eq $versionA) "after the rollback, current points at $(Get-LinkLeaf)"
    Initialize-Again 'after the rollback'
    [void](Test-ProgramPaths 'after the rollback')
    Check ([IO.File]::ReadAllText((Join-Path $workspace '.claude\settings.local.json')) -ceq $hooksBefore) 'the rollback rewrote the hook block'

    # --- forward again, then the old version removed -------------------------------------------
    $ran = Install-From $releaseB
    Check ($ran.exit -eq 0) "upgrading to $versionB a second time exited $($ran.exit)"
    Remove-Item -LiteralPath (Join-Path $installRoot "versions\$versionA") -Recurse -Force
    Check (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions\$versionA"))) "versions\$versionA could not be removed"
    [void](Test-ProgramPaths "with $versionA removed")
    Initialize-Again "with $versionA removed"
}
catch {
    Check $false ("the fixture stopped: " + $_.Exception.Message)
}
finally {
    if (-not $Keep -and (Test-Path -LiteralPath $WorkRoot)) {
        # The junction first, as a link: a recursive delete must never be asked to walk through it.
        if (Test-Path -LiteralPath $current) { [IO.Directory]::Delete($current) }
        Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$failed = @($checks | Where-Object { -not $_.ok })
$result = [pscustomobject]@{
    passed = ($failed.Count -eq 0); checks = $checks.Count; failed = $failed.Count
    failures = @($failed | ForEach-Object { $_.check }); planted_defect = [bool]$PlantDefect; work_root = $WorkRoot
}
if ($Json) { $result | ConvertTo-Json -Depth 4 }
elseif ($failed.Count) { "kernel upgrade fixture FAILED ($($failed.Count) of $($checks.Count)):"; $failed | ForEach-Object { "  - $($_.check)" } }
else { "kernel upgrade fixture passed ($($checks.Count) checks)." }
if ($failed.Count) { exit 1 }
