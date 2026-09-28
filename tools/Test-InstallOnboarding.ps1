<#
.SYNOPSIS
    The install onboarding fixture (PLAN-install-onboarding.md step 10): the Windows installer's passes, refusals and
    recovery, run against a built release under a scratch folder.

.DESCRIPTION
    Takes -Release, a folder tools/Build-KernelRelease.ps1 wrote, so it is run by hand after a build rather than in
    the gate. Every install uses -NoPathChange and a scratch LIBRARY_WORKSPACES registry, so the machine's PATH and
    its real registry are never touched; PATH itself is judged in the Windows Sandbox run. The interruption cases
    stop the installer through DESKPOST_INSTALL_FAULT_AFTER, right after a named mark, as a crash would leave it.
    Put -Work on another drive from %TEMP% to cover the cross-volume copy (#12). Run it in its own powershell.exe:
    the installer hands its console to the kernel, which a PowerShell job cannot carry.

.PARAMETER Release
    A release folder: SHA256SUMS and the archives.

.PARAMETER Work
    A scratch folder, removed and re-created. Nothing outside it is written.

.PARAMETER Installer
    The install.ps1 under test. Defaults to this program's.
#>
param(
    [Parameter(Mandatory)][string]$Release,
    [Parameter(Mandatory)][string]$Work,
    [string]$Installer
)
$ErrorActionPreference = 'Continue'
if (-not $Installer) { $Installer = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'install.ps1' }
$results = [Collections.Generic.List[string]]::new()
# THE RELEASE'S OWN VERSION, read from its archive name, so the fixture judges whatever release it is given.
$releaseVersion = [regex]::Match((Get-Content (Join-Path $Release 'SHA256SUMS') -Raw), 'deskpost-(\S+)-win-x64\.zip').Groups[1].Value
function Check([bool]$Condition, [string]$Label) { $results.Add($(if ($Condition) { "PASS  $Label" } else { "FAIL  $Label" })) }
function Run([hashtable]$Arguments, [string]$Fault = '') {
    $env:DESKPOST_INSTALL_FAULT_AFTER = $Fault
    $threw = $null
    $out = try { & $Installer @Arguments 2>&1 | Out-String -Width 400 } catch { $threw = $_.Exception.Message; '' }
    $env:DESKPOST_INSTALL_FAULT_AFTER = ''
    [pscustomobject]@{ out = $out; threw = $threw }
}
function Receipt([string]$Root) { Get-Content -LiteralPath (Join-Path $Root 'install-receipt.json') -Raw | ConvertFrom-Json }
if (Test-Path $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
New-Item -ItemType Directory -Path $Work -Force | Out-Null
# THE FIXTURE'S STAND-INS DO NOT OUTLIVE IT (S58 post-build inspection #4): run in a terminal, a script's $env: changes
# persist, and a later real install there would judge a registry and a user PATH that are not the machine's.
$savedEnv = @{}
foreach ($name in 'LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'LIBRARY_WORKSPACES', 'DESKPOST_USER_PATH', 'DESKPOST_INSTALL_FAULT_AFTER') { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$env:LIBRARY_WORKSPACE = ''; $env:LIBRARY_SEAT = ''; $env:LIBRARY_SEAT_CLAIM = ''; $env:LIBRARY_WORKSPACES = Join-Path $Work 'reg'; $env:DESKPOST_USER_PATH = ';'
Push-Location $Work
try {
    # S1: a fresh install, on another drive from %TEMP% when $Work is (#12)
    $root = Join-Path $Work 'prog'; $lib = Join-Path $Work 'lib'
    $r = Run @{ Release = $Release; InstallRoot = $root; Library = $lib; Yes = $true; NoPathChange = $true }
    Check ($null -eq $r.threw -and (Test-Path (Join-Path $lib '.library\workspace.json')) -and $null -eq (Receipt $root).pending) "fresh install completes, pending cleared ($($r.threw))"
    Check (-not @(Get-ChildItem (Join-Path $root 'versions') -Force -Filter '.incoming-*').Count) 'no staging left after a completed install'
    # S2: the same version again, non-interactively, without -Repair
    $r = Run @{ Release = $Release; InstallRoot = $root; Library = $lib; Yes = $true; NoPathChange = $true }
    Check ($null -ne $r.threw -and ((Get-Content (Join-Path $root 'current.json') -Raw) | ConvertFrom-Json).version -eq $releaseVersion) "same version without -Repair refused, the install unchanged ($($r.threw))"
    # S3: -Repair reuses the version and repairs the Library
    $r = Run @{ Release = $Release; InstallRoot = $root; Library = $lib; Yes = $true; NoPathChange = $true; Repair = $true }
    Check ($null -eq $r.threw -and $null -eq (Receipt $root).pending -and @(Get-ChildItem (Join-Path $root 'versions') -Force).Count -eq 1) "-Repair reuses versions\<v> and completes ($($r.threw))"
    # S4: a fault after the plan is frozen; the owner is relinquished; undo reverses it
    $root4 = Join-Path $Work 'prog4'; $lib4 = Join-Path $Work 'lib4'
    $r = Run @{ Release = $Release; InstallRoot = $root4; Library = $lib4; Yes = $true; NoPathChange = $true } 'activated'
    $p = (Receipt $root4).pending
    Check ($null -ne $r.threw -and $null -ne $p -and $null -eq $p.owner) "a fault leaves pending with its owner relinquished ($($r.threw))"
    $r = Run @{ Release = $Release; InstallRoot = $root4; Library = $lib4; Yes = $true; NoPathChange = $true }
    Check ($null -ne $r.threw -and $r.threw -match '-Resume') "a re-run without -Resume names the choices ($($r.threw))"
    $r = Run @{ Release = $Release; InstallRoot = $root4; Library = $lib4; Yes = $true; NoPathChange = $true; Resume = 'undo' }
    Check ($null -eq $r.threw -and $null -eq (Receipt $root4).pending -and -not (Test-Path (Join-Path $root4 'current')) -and -not (Test-Path (Join-Path $root4 'versions\1.0.0'))) "undo removes current and the placed version ($($r.threw))"
    Check (-not (Test-Path (Join-Path $lib4 '.library\workspace.json'))) 'undo leaves no Library file written (none was)'
    # S5: a fault after Place; finish completes from the frozen plan
    $root5 = Join-Path $Work 'prog5'; $lib5 = Join-Path $Work 'lib5'
    $r = Run @{ Release = $Release; InstallRoot = $root5; Library = $lib5; Yes = $true; NoPathChange = $true } 'placed'
    Check ($null -ne $r.threw) "fault after Place stops ($($r.threw))"
    $r = Run @{ Release = $Release; InstallRoot = $root5; Library = $lib5; Yes = $true; NoPathChange = $true; Resume = 'finish' }
    Check ($null -eq $r.threw -and (Test-Path (Join-Path $lib5 '.library\workspace.json')) -and $null -eq (Receipt $root5).pending) "finish completes from the frozen plan ($($r.threw))"
    # S6: a fault before the plan is frozen; finish starts over
    $root6 = Join-Path $Work 'prog6'; $lib6 = Join-Path $Work 'lib6'
    $r = Run @{ Release = $Release; InstallRoot = $root6; Library = $lib6; Yes = $true; NoPathChange = $true } 'staged'
    $r = Run @{ Release = $Release; InstallRoot = $root6; Library = $lib6; Yes = $true; NoPathChange = $true; Resume = 'undo' }
    Check ($null -ne $r.threw -and $r.threw -match 'nothing to undo') "undo before the plan is frozen is refused ($($r.threw))"
    $r = Run @{ Release = $Release; InstallRoot = $root6; Library = $lib6; Yes = $true; NoPathChange = $true; Resume = 'finish' }
    Check ($null -eq $r.threw -and (Test-Path (Join-Path $lib6 '.library\workspace.json'))) "finish before the plan is frozen starts over and completes ($($r.threw))"
    # S7: -DryRun leaves no trace
    $root7 = Join-Path $Work 'prog7'; $lib7 = Join-Path $Work 'lib7'
    $r = Run @{ Release = $Release; InstallRoot = $root7; Library = $lib7; Yes = $true; NoPathChange = $true; DryRun = $true }
    Check ($null -eq $r.threw -and -not (Test-Path $root7) -and -not (Test-Path $lib7)) "-DryRun creates nothing ($($r.threw))"
    # S8: -Json prints one object, and an install asked for as JSON names the plan it was shown (PLAN-assistant-onboarding.md step 2)
    $root8 = Join-Path $Work 'prog8'; $lib8 = Join-Path $Work 'lib8'
    $env:DESKPOST_INSTALL_FAULT_AFTER = ''
    $r = Run @{ Release = $Release; InstallRoot = $root8; Library = $lib8; Json = $true; NoPathChange = $true }
    Check ($null -ne $r.threw -and $r.threw -match 'must name the plan' -and -not (Test-Path $root8)) "-Json without -PlanId is refused and creates nothing ($($r.threw))"
    $dry = & $Installer -Release $Release -InstallRoot $root8 -Library $lib8 -Json -DryRun -NoPathChange 2>$null
    $plan = $null; try { $plan = ($dry | Out-String) | ConvertFrom-Json } catch { }
    Check ($null -ne $plan -and $plan.status -eq 'dry-run' -and $plan.plan_id -match '^[0-9a-f]{64}$' -and @($plan.plan.rows).Count -ge 5) "-DryRun -Json prints the plan and its plan_id (got: $((($dry | Out-String).Trim()) -replace '\s+',' ' | ForEach-Object { $_.Substring(0, [Math]::Min(120, $_.Length)) }))"
    $json = & $Installer -Release $Release -InstallRoot $root8 -Library $lib8 -Json -PlanId $plan.plan_id -NoPathChange 2>$null
    $parsed = $null; try { $parsed = ($json | Out-String) | ConvertFrom-Json } catch { }
    Check ($null -ne $parsed -and $parsed.status -eq 'installed' -and $parsed.plan_id -eq $plan.plan_id) "-Json -PlanId installs and prints one parseable result (got: $((($json | Out-String).Trim()) -replace '\s+',' ' | ForEach-Object { $_.Substring(0, [Math]::Min(120, $_.Length)) }))"
    # S9: a non-empty program folder, and ';' in it
    $busy = Join-Path $Work 'busy'; New-Item -ItemType Directory $busy -Force | Out-Null; Set-Content (Join-Path $busy 'theirs.txt') 'x'
    $r = Run @{ Release = $Release; InstallRoot = $busy; Library = (Join-Path $Work 'lib9'); Yes = $true; NoPathChange = $true }
    Check ($null -ne $r.threw -and (Get-ChildItem $busy).Count -eq 1) "a non-empty program folder is refused and untouched ($($r.threw))"
    # S10: an interrupted install blocks a second only while its owner is alive (the owner here is this process)
    $root10 = Join-Path $Work 'prog10'
    $r = Run @{ Release = $Release; InstallRoot = $root10; Library = 'none'; Yes = $true; NoPathChange = $true } 'planned'
    $receipt = Receipt $root10; $receipt.pending.owner = [pscustomobject]@{ pid = $PID; start_utc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText((Join-Path $root10 'install-receipt.json'), ($receipt | ConvertTo-Json -Depth 12))
    $r = Run @{ Release = $Release; InstallRoot = $root10; Library = 'none'; Yes = $true; NoPathChange = $true; Resume = 'finish' }
    Check ($null -ne $r.threw -and $r.threw -match 'is running') "a live owner blocks a second installer ($($r.threw))"
    $receipt.pending.owner = [pscustomobject]@{ pid = $PID; start_utc = '2001-01-01T00:00:00.0000000Z' }
    [IO.File]::WriteAllText((Join-Path $root10 'install-receipt.json'), ($receipt | ConvertTo-Json -Depth 12))
    $r = Run @{ Release = $Release; InstallRoot = $root10; Library = 'none'; Yes = $true; NoPathChange = $true; Resume = 'finish' }
    Check ($null -eq $r.threw) "a reused pid with another start time is a dead owner, and recovery proceeds ($($r.threw))"
    # S11: a version folder from another archive is refused BEFORE a pending is recorded (post-build inspection #2)
    $root11 = Join-Path $Work 'prog11'
    New-Item -ItemType Directory (Join-Path $root11 "versions\$releaseVersion") -Force | Out-Null
    Set-Content (Join-Path $root11 "versions\$releaseVersion\.archive-sha256") 'not-this-archive'
    $r = Run @{ Release = $Release; InstallRoot = $root11; Library = 'none'; Yes = $true; NoPathChange = $true }
    $pendingLeft = (Test-Path (Join-Path $root11 'install-receipt.json')) -and $null -ne (Receipt $root11).pending
    Check ($null -ne $r.threw -and $r.threw -match 'differs from the release' -and -not $pendingLeft) "a mismatched version folder is refused with no pending left to block its remedy ($($r.threw))"
} finally {
    Pop-Location
    foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
}
$results
$passed = @($results | Where-Object { $_ -like 'PASS*' }).Count
"$passed of $($results.Count) passed"
if ($passed -ne $results.Count) { throw "$($results.Count - $passed) install onboarding case(s) failed." }
