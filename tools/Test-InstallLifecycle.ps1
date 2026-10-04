<#
.SYNOPSIS
    The install lifecycle fixture (PLAN-install-onboarding.md step 10): install one version, upgrade to a second in
    place, `deskpost rollback`, then `deskpost uninstall` through its finisher, under a scratch folder.

.DESCRIPTION
    Takes two release folders tools/Build-KernelRelease.ps1 wrote, -ReleaseA older than -ReleaseB. A second version is
    made by copying the tracked tree out, bumping the version in .codex-plugin/plugin.json, .claude-plugin/plugin.json
    and kernel/package.json, and building with -SourceRoot on the copy. Run by hand after a build, in its own
    powershell.exe; it uses -NoPathChange and a scratch LIBRARY_WORKSPACES, so PATH and the real registry are not
    touched. It judges: the Library's hooks byte for byte across the upgrade, doctor green after the upgrade and after
    the rollback, a dry run changing nothing, the finisher completing, the program folder gone, a reader's own hook
    surviving, and the Library itself untouched.
#>
param(
    [Parameter(Mandatory)][string]$ReleaseA,
    [Parameter(Mandatory)][string]$ReleaseB,
    [Parameter(Mandatory)][string]$Work,
    [string]$Installer
)
$ErrorActionPreference = 'Continue'
# EACH RELEASE'S OWN VERSION, read from its SHA256SUMS, so the fixture judges whatever two releases it is given (S59):
# the labels were typed as 1.0.0 and 1.1.0-s54, and 4 of 16 cases failed on every build after S54 for that alone.
function Get-ReleaseVersion([string]$Folder) {
    $names = @(Get-Content -LiteralPath (Join-Path $Folder 'SHA256SUMS') | ForEach-Object { if ($_ -match 'deskpost-(\S+)-win-x64\.zip') { $Matches[1] } })
    if ($names.Count -ne 1) { throw "$Folder\SHA256SUMS names $($names.Count) win-x64 archives; the fixture needs one." }
    $names[0]
}
$versionA = Get-ReleaseVersion $ReleaseA; $versionB = Get-ReleaseVersion $ReleaseB
if ($versionA -eq $versionB) { throw "-ReleaseA and -ReleaseB are both $versionA; an upgrade needs two versions." }
$results = [Collections.Generic.List[string]]::new()
function Check([bool]$c, [string]$l) { $results.Add($(if ($c) { "PASS  $l" } else { "FAIL  $l" })) }
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory $Work | Out-Null
# THE FIXTURE'S STAND-INS DO NOT OUTLIVE IT (S58 post-build inspection #4); restored in the finally below.
$savedEnv = @{}
foreach ($name in 'LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'LIBRARY_WORKSPACES', 'DESKPOST_USER_PATH', 'DESKPOST_INSTALL_FAULT_AFTER') { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$env:LIBRARY_WORKSPACE = ''; $env:LIBRARY_SEAT = ''; $env:LIBRARY_SEAT_CLAIM = ''; $env:LIBRARY_WORKSPACES = "$Work\reg"; $env:DESKPOST_USER_PATH = ';'
Push-Location $Work
try {
$R = "$Work\prog"; $L = "$Work\lib"; $installer = if ($Installer) { $Installer } else { Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'install.ps1' }
try { & $installer -Release $ReleaseA -InstallRoot $R -Library $L -Yes -NoPathChange | Out-Null; $ok = $true } catch { $ok = $false; "A: $($_.Exception.Message)" }
Check $ok "install $versionA"
$hooks = Get-FileHash "$L\.claude\settings.local.json"
# AN UPGRADE INTERRUPTED AFTER current SWITCHED, THEN UNDONE: current, current.json and the hooks as they were.
$recordBefore = [IO.File]::ReadAllText("$R\current.json")
$env:DESKPOST_INSTALL_FAULT_AFTER = 'activated'
try { & $installer -Release $ReleaseB -InstallRoot $R -Library $L -Yes -NoPathChange | Out-Null } catch { }
$env:DESKPOST_INSTALL_FAULT_AFTER = ''
try { & $installer -Release $ReleaseB -InstallRoot $R -Yes -NoPathChange -Resume undo | Out-Null; $ok = $true } catch { $ok = $false; "undo: $($_.Exception.Message)" }
Check ($ok -and (Get-Item "$R\current").Target -like "*\$versionA" -and [IO.File]::ReadAllText("$R\current.json") -eq $recordBefore -and -not (Test-Path "$R\versions\$versionB")) 'an interrupted upgrade is undone: current, current.json and the new version folder as they were'
Check ((Get-FileHash "$L\.claude\settings.local.json").Hash -eq $hooks.Hash) 'the undone upgrade left the Library''s hooks byte for byte'
try { & $installer -Release $ReleaseB -InstallRoot $R -Library $L -Yes -NoPathChange | Out-Null; $ok = $true } catch { $ok = $false; "B: $($_.Exception.Message)" }
$record = Get-Content "$R\current.json" -Raw | ConvertFrom-Json
Check ($ok -and $record.version -eq $versionB -and $record.previous -eq $versionA) "upgrade $versionA -> $versionB in place ($($record.version), previous $($record.previous))"
Check ([IO.File]::ReadAllText("$L\.claude\settings.local.json").Contains(($R -replace '\\', '/') + '/current/') -and -not [IO.File]::ReadAllText("$L\.claude\settings.local.json").Contains('/versions/')) 'the upgrade brought the Library''s hooks up to date, naming current'
$doctor = & "$R\bin\deskpost.cmd" doctor --workspace $L --json | ConvertFrom-Json
Check ($doctor.failed -eq 0) "doctor green after the upgrade ($($doctor.failed) failed)"
# AN INTERRUPTED `deskpost rollback` MET BY THE INSTALLER (post-build inspection #1): current put back, never removed.
$receipt = Get-Content "$R\install-receipt.json" -Raw | ConvertFrom-Json
$receipt.pending = [pscustomobject]@{ id = 'plantedrollback'; operation = 'rollback'; owner = $null; phase = 'recorded'; version = $versionA; from = $versionB; previous_record = [IO.File]::ReadAllText("$R\current.json") }
[IO.File]::WriteAllText("$R\install-receipt.json", ($receipt | ConvertTo-Json -Depth 12))
[IO.Directory]::Delete("$R\current"); New-Item -ItemType Junction -Path "$R\current" -Target "$R\versions\$versionA" | Out-Null
$refused = $false; try { & "$R\bin\deskpost.cmd" rollback --yes 2>&1 | Out-Null; $refused = $LASTEXITCODE -ne 0 } catch { $refused = $true }
try { & $installer -Release $ReleaseB -InstallRoot $R -Yes -NoPathChange -Resume undo | Out-Null; $ok = $true } catch { $ok = $false; "rollback recovery: $($_.Exception.Message)" }
$afterRecovery = Get-Content "$R\install-receipt.json" -Raw | ConvertFrom-Json
Check ($refused -and $ok -and (Get-Item "$R\current").Target -like "*\$versionB" -and (Test-Path "$R\bin\deskpost.cmd") -and $null -eq $afterRecovery.pending) 'an interrupted rollback is recovered by putting current back, the shims kept'
& "$R\bin\deskpost.cmd" rollback --yes | Out-Null
$record = Get-Content "$R\current.json" -Raw | ConvertFrom-Json
Check ($LASTEXITCODE -eq 0 -and $record.version -eq $versionA -and (Get-Item "$R\current").Target -like "*\$versionA") "deskpost rollback switches current back ($($record.version))"
$doctor = & "$R\bin\deskpost.cmd" doctor --workspace $L --json | ConvertFrom-Json
Check ($doctor.failed -eq 0) "doctor green after the rollback, the Library still guarded ($($doctor.failed) failed)"
# A reader's own hook in the same block must survive uninstall.
$settings = Get-Content "$L\.claude\settings.local.json" -Raw | ConvertFrom-Json
$settings.hooks.PreToolUse[0].hooks += [pscustomobject]@{ type = 'command'; command = 'node'; args = @('C:/mine/hook.js') }
[IO.File]::WriteAllText("$L\.claude\settings.local.json", ($settings | ConvertTo-Json -Depth 12))
$dry = & "$R\bin\deskpost.cmd" uninstall --dry-run --json | ConvertFrom-Json
Check ($dry.removal.files.Count -gt 100 -and @($dry.library_edits).Count -ge 3) "uninstall --dry-run lists the program files ($($dry.removal.files.Count)) and the Library edits ($(@($dry.library_edits).Count))"
Check (Test-Path "$R\current") 'the dry run changed nothing'
Remove-Item "$env:TEMP\deskpost-uninstall-result.json" -ErrorAction SilentlyContinue
$out = & "$R\bin\deskpost.cmd" uninstall --yes 2>&1 | Out-String
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-Path "$env:TEMP\deskpost-uninstall-result.json")) { Start-Sleep -Milliseconds 500 }
$final = if (Test-Path "$env:TEMP\deskpost-uninstall-result.json") { Get-Content "$env:TEMP\deskpost-uninstall-result.json" -Raw | ConvertFrom-Json } else { $null }
Check ($null -ne $final -and $final.status -eq 'completed') "the finisher completes ($($final.status); $(@($final.left) -join '; ')) -- $($out.Trim())"
Check (-not (Test-Path $R)) "the program folder is gone ($(if (Test-Path $R) { (Get-ChildItem $R -Recurse -Force | Select-Object -First 5 | ForEach-Object FullName) -join ', ' }))"
$after = Get-Content "$L\.claude\settings.local.json" -Raw
Check ($after -notmatch [regex]::Escape(($R -replace '\\', '/')) -and $after -match 'C:/mine/hook.js') 'the Library no longer names the install, and the reader''s own hook survived'
Check ((Test-Path "$L\.library\workspace.json") -and (Test-Path "$L\shelf\holding")) 'the Library itself is untouched'
$mcp = Get-Content "$L\.mcp.json" -Raw
Check ($mcp -notmatch 'validated-book-reader') 'the reader registration is gone from .mcp.json'
} finally {
    Pop-Location
    foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
}
$results
$passed = @($results | Where-Object { $_ -like 'PASS*' }).Count
# THE LAST LINE NAMES THE INSTALLER RUN (S74 row 2): Test-BuiltRelease shows each fixture's last line.
"$passed of $($results.Count) passed (installer: $installer)"
if ($passed -ne $results.Count) { throw "$($results.Count - $passed) install lifecycle case(s) failed." }
