<#
.SYNOPSIS
    Every release fixture, against one built release folder: the release checklist's one line.

.DESCRIPTION
    Run after tools/Build-KernelRelease.ps1 and before a release is pushed, against the exact folder that will be
    published. The fixtures take a built release, so none of them can run in the gate, and a fixture nobody runs goes
    stale in silence: S57 built 1.2 without running tools/Test-KernelUpgrade.ps1, and S58 found it failing
    at its first install against 1.2.0 (the S58 Report Inbox note, #10). So this runs all of them, each in its own
    powershell.exe (the installer hands its console to the kernel), and fails if any one fails. The gate row
    `release.fixtures-all-run` fails when a tools/Test-*.ps1 that takes a release is missing from $script:Fixtures
    below, so a new fixture cannot be left off the list.

    The machine's own Deskpost stays out of it: LIBRARY_WORKSPACE, LIBRARY_SEAT and LIBRARY_SEAT_CLAIM are blanked,
    and every PATH entry holding a deskpost shim is dropped, because a seat's launcher puts the real install on PATH
    and the install fixtures then refuse "already installed".

.PARAMETER Release
    The release folder: SHA256SUMS, the installers and the archives.

.PARAMETER PreviousRelease
    An older release folder, for the upgrade-in-place fixture (Test-InstallLifecycle.ps1). Without it that fixture is
    reported as NOT RUN and the whole run fails, because "not run" must never read as passed.

.PARAMETER Work
    A scratch folder, created fresh; each fixture works in a folder of its own under it. Put it on another drive from
    %TEMP% to cover the installer's cross-volume copy.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Release,
    [string]$PreviousRelease,
    [Parameter(Mandatory)][string]$Work
)
$ErrorActionPreference = 'Stop'

# THE LIST. Each entry is the fixture's file and the arguments it takes; {release}, {previous} and {work} are filled in.
$script:Fixtures = @(
    @{ file = 'Test-KernelUpgrade.ps1';     args = @('-Release', '{release}', '-WorkRoot', '{work}') },
    @{ file = 'Test-InstallOnboarding.ps1'; args = @('-Release', '{release}', '-Work', '{work}') },
    @{ file = 'Test-InstallProof.ps1';      args = @('-Release', '{release}', '-Work', '{work}') },
    @{ file = 'Test-InstallLifecycle.ps1';  args = @('-ReleaseA', '{previous}', '-ReleaseB', '{release}', '-Work', '{work}'); needs_previous = $true }
)

$Release = [IO.Path]::GetFullPath($Release)
if (-not (Test-Path -LiteralPath (Join-Path $Release 'SHA256SUMS') -PathType Leaf)) { throw "$Release holds no SHA256SUMS, so it is not a release folder. Nothing was run." }
if ($PreviousRelease) {
    $PreviousRelease = [IO.Path]::GetFullPath($PreviousRelease)
    if (-not (Test-Path -LiteralPath (Join-Path $PreviousRelease 'SHA256SUMS') -PathType Leaf)) { throw "$PreviousRelease holds no SHA256SUMS, so it is not a release folder. Nothing was run." }
}
$Work = [IO.Path]::GetFullPath($Work)
if (Test-Path -LiteralPath $Work) { throw "$Work already exists; the fixtures build in a folder of their own. Nothing was run." }
New-Item -ItemType Directory -Path $Work | Out-Null

$savedPath = $env:Path
$saved = @{}
foreach ($name in 'LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM') { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$rows = [Collections.Generic.List[object]]::new()
try {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, '', 'Process') }
    $env:Path = (@($env:Path -split ';' | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'deskpost.cmd')) }) -join ';')

    foreach ($fixture in $script:Fixtures) {
        $name = [IO.Path]::GetFileNameWithoutExtension($fixture.file)
        if ($fixture.needs_previous -and -not $PreviousRelease) {
            $rows.Add([pscustomobject]@{ fixture = $name; result = 'NOT RUN'; last = 'needs -PreviousRelease, an older release folder' })
            continue
        }
        $folder = Join-Path $Work $name
        $arguments = @($fixture.args | ForEach-Object { $_.Replace('{release}', $Release).Replace('{previous}', [string]$PreviousRelease).Replace('{work}', $folder) })
        $log = Join-Path $Work "$name.log"
        $ErrorActionPreference = 'Continue'
        # Piped to Out-File rather than redirected: Windows PowerShell's `*>` writes UTF-16, which grep and a diff read as noise.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $fixture.file) @arguments 2>&1 |
            ForEach-Object { "$_" } | Out-File -LiteralPath $log -Encoding utf8
        $exit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $last = @(Get-Content -LiteralPath $log | Where-Object { $_.Trim() }) | Select-Object -Last 1
        $rows.Add([pscustomobject]@{ fixture = $name; result = $(if ($exit -eq 0) { 'PASS' } else { "FAIL ($exit)" }); last = [string]$last })
    }
}
finally {
    $env:Path = $savedPath
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}

$rows | Format-Table -AutoSize -Wrap | Out-String -Width 200
"Logs: $Work"
$bad = @($rows | Where-Object { $_.result -ne 'PASS' })
if ($bad.Count) { throw "$($bad.Count) of $($rows.Count) release fixture(s) did not pass: $(@($bad | ForEach-Object { $_.fixture }) -join ', '). Do not push this release." }
"All $($rows.Count) release fixtures passed against $Release."
