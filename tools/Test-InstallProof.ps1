<#
.SYNOPSIS
    The install proof fixture (PLAN-install-onboarding.md step 7): the cases the S54 post-build inspection left open
    (#12), run against the REAL published 1.0.0 and a built 1.1 release, under a scratch folder.

.DESCRIPTION
    Run by hand after a build, in its own powershell.exe (the installer hands its console to the kernel). Every install
    uses -NoPathChange and a scratch LIBRARY_WORKSPACES, so PATH and the real registry are never touched. It judges:

      1. an upgrade in place from a real 1.0.0 install, made by 1.0.0's own install.ps1 and `library init`: the
         Library's hooks byte for byte, and 1.1's doctor green on 1.0's registrations, the double-quoted Codex render
         among them;
      2. the close-your-sessions rule: a live seat in that Library refuses a repair and an uninstall, naming it;
      3. the finisher's FAILED path: a program file held open is left, `failed` is written, pending and the receipt
         stay, and install.ps1 -Resume finish completes it with no program to run;
      4. legacy adoption: the 1.0.0 version folder, which has no inventory, is removed from its kept archive, while a
         reader's own file inside it and inside downloads survives with its folders; the Library's 1.0 entries,
         Codex's double-quoted render included, are removed and a reader's own hook is kept;
      5. a missing kept archive leaves versions\1.0.0 in place, named;
      6. the finisher's CANCEL path (DESKPOST_UNINSTALL_FAULT=no-finisher): no finisher starts, `cancel` is written,
         a late finisher deletes nothing, and -Resume finish completes it.

.PARAMETER Release
    A release folder tools/Build-KernelRelease.ps1 wrote, of a version above 1.0.0.

.PARAMETER Work
    A scratch folder, removed and re-created. Nothing outside it is written but %TEMP%'s finisher files.

.PARAMETER LegacyRelease
    Where 1.0.0 comes from: its published release by default.
#>
param(
    [Parameter(Mandatory)][string]$Release,
    [Parameter(Mandatory)][string]$Work,
    [string]$LegacyRelease = 'https://github.com/eKioga/deskpost/releases/download/v1.0.0',
    [string]$Installer
)
$ErrorActionPreference = 'Continue'
$results = [Collections.Generic.List[string]]::new()
function Check([bool]$c, [string]$l) { $results.Add($(if ($c) { "PASS  $l" } else { "FAIL  $l" })) }
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory $Work | Out-Null
# THE FIXTURE'S STAND-INS DO NOT OUTLIVE IT (S58 post-build inspection #4); restored in the finally below.
$savedEnv = @{}
foreach ($name in 'LIBRARY_WORKSPACE', 'LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM', 'LIBRARY_WORKSPACES', 'DESKPOST_USER_PATH', 'ORCA_TERMINAL_HANDLE', 'DESKPOST_UNINSTALL_FAULT') { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$env:LIBRARY_WORKSPACE = ''; $env:LIBRARY_SEAT = ''; $env:LIBRARY_SEAT_CLAIM = ''; $env:LIBRARY_WORKSPACES = "$Work\reg"; $env:DESKPOST_USER_PATH = ';'
$env:ORCA_TERMINAL_HANDLE = ''; $env:DESKPOST_UNINSTALL_FAULT = ''
Push-Location $Work
try {
$installer = if ($Installer) { $Installer } else { Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'install.ps1' }
$version = [regex]::Match((Get-Content (Join-Path $Release 'SHA256SUMS') -Raw), 'deskpost-(\S+)-win-x64\.zip').Groups[1].Value
$legacyInstaller = Join-Path $Work 'install-1.0.0.ps1'
[IO.File]::WriteAllText($legacyInstaller, (New-Object Net.WebClient).DownloadString("$LegacyRelease/install.ps1"))
$resultFile = Join-Path $env:TEMP 'deskpost-uninstall-result.json'

function Install-Legacy([string]$Root, [string]$Library) {
    & $legacyInstaller -Release $LegacyRelease -InstallRoot $Root -NoPathChange | Out-Null
    & "$Root\bin\library.cmd" init $Library | Out-Null
}
function Wait-Result([int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $resultFile)) { Start-Sleep -Milliseconds 500 }
    if (Test-Path $resultFile) { Get-Content $resultFile -Raw | ConvertFrom-Json } else { $null }
}
function Receipt([string]$Root) { if (Test-Path "$Root\install-receipt.json") { Get-Content "$Root\install-receipt.json" -Raw | ConvertFrom-Json } else { $null } }

# --- 1. an upgrade in place from a real 1.0.0 install ----------------------------------------------------------------
$R = "$Work\prog"; $L = "$Work\lib"
try { Install-Legacy $R $L; $ok = (Get-Content "$R\current.json" -Raw | ConvertFrom-Json).version -eq '1.0.0' } catch { $ok = $false; "legacy: $($_.Exception.Message)" }
Check ($ok -and (Test-Path "$L\.library\workspace.json")) 'the published 1.0.0 installs, and its library init makes a Library'
$codexCommands = @(([IO.File]::ReadAllText("$L\.codex\hooks.json") | ConvertFrom-Json).hooks.PSObject.Properties | ForEach-Object { $_.Value } | ForEach-Object { $_.hooks } | ForEach-Object { [string]$_.command })
Check ($codexCommands.Count -gt 0 -and @($codexCommands | Where-Object { $_.StartsWith('& "') }).Count -eq $codexCommands.Count) "1.0's Codex hooks are its double-quoted render ($($codexCommands[0]))"
$hashes = @{}; foreach ($f in '.claude\settings.local.json', '.codex\hooks.json', '.mcp.json') { $hashes[$f] = (Get-FileHash "$L\$f").Hash }
try { & $installer -Release $Release -InstallRoot $R -Library $L -Yes -NoPathChange | Out-Null; $ok = $true } catch { $ok = $false; "upgrade: $($_.Exception.Message)" }
$record = Get-Content "$R\current.json" -Raw | ConvertFrom-Json
Check ($ok -and $record.version -eq $version -and $record.previous -eq '1.0.0') "the upgrade from the real 1.0.0 is in place ($($record.version), previous $($record.previous))"
Check ((Get-FileHash "$L\.codex\hooks.json").Hash -ne $hashes['.codex\hooks.json'] -and @(([IO.File]::ReadAllText("$L\.codex\hooks.json") | ConvertFrom-Json).hooks.PSObject.Properties | ForEach-Object { $_.Value } | ForEach-Object { $_.hooks } | ForEach-Object { [string]$_.command } | Where-Object { $_.StartsWith('& "') }).Count -eq 0) 'the upgrade brought the 1.0 Library''s registrations up to date (its Codex hooks no longer the double-quoted render)'
$doctor = & "$R\bin\deskpost.cmd" doctor --workspace $L --json | ConvertFrom-Json
$codexRow = @($doctor.checks | Where-Object { $_.check -eq 'workspace.codex-guards-registered' })
Check ($doctor.failed -eq 0 -and $codexRow.Count -eq 1 -and $codexRow[0].status -ne 'fail') "1.1's doctor is green on 1.0's registrations, the double-quoted Codex render included ($($doctor.failed) failed; codex $($codexRow[0].status))"

# --- 2. a live seat refuses a repair and an uninstall ---------------------------------------------------------------
& "$R\bin\deskpost.cmd" hub new probe --title Probe --workspace $L | Out-Null
$holder = Start-Process -FilePath "$R\bin\deskpost.cmd" -ArgumentList @('seat', 'start', 'probe', '--project', 'probe', '--workspace', $L, '--command', 'powershell.exe', '--', '-NoProfile', '-Command', 'Start-Sleep 90') -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(30); $held = $false
while ((Get-Date) -lt $deadline -and -not $held) {
    Start-Sleep -Milliseconds 500
    $status = & "$R\bin\deskpost.cmd" seat status --workspace $L --json 2>$null | ConvertFrom-Json
    $held = @($status.seats | Where-Object { $_.seat -eq 'probe' -and $_.claim -eq 'held' }).Count -eq 1
}
Check $held 'a seat is held in the upgraded Library'
$threw = $null; try { & $installer -Release $Release -InstallRoot $R -Library $L -Yes -NoPathChange -Repair | Out-Null } catch { $threw = $_.Exception.Message }
Check ($null -ne $threw -and $threw -match 'Close your sessions first' -and $threw -match 'probe') "a repair is refused while the seat is held, naming it ($(([string]$threw).Split("`n")[0]))"
$out = & "$R\bin\deskpost.cmd" uninstall --yes 2>&1 | Out-String
Check ($LASTEXITCODE -ne 0 -and $out -match 'probe' -and (Test-Path "$R\current")) "an uninstall is refused while the seat is held, naming it ($(($out.Trim() -split "`n")[0]))"
# ONLY THE HOLDER'S OWN TREE (post-build inspection #9): a command-line match could end an unrelated process.
$all = @(Get-CimInstance Win32_Process)
$tree = [Collections.Generic.List[int]]::new(); $tree.Add($holder.Id)
for ($i = 0; $i -lt $tree.Count; $i++) { foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $tree[$i] })) { $tree.Add([int]$child.ProcessId) } }
foreach ($id in (@($tree) | Select-Object -Skip 1)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
if ($holder -and -not $holder.HasExited) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not ((& "$R\bin\deskpost.cmd" setup --sessions --install-root $R --json 2>$null | ConvertFrom-Json).clear)) { Start-Sleep -Milliseconds 500 }

# --- 3 and 4. the FAILED finisher, then -Resume finish; legacy adoption of versions\1.0.0 -----------------------------
New-Item -ItemType File "$R\versions\1.0.0\mine.txt" -Value 'a reader file inside the version folder' -Force | Out-Null
New-Item -ItemType File "$R\downloads\mine.txt" -Value 'a reader file inside downloads' -Force | Out-Null
$settings = Get-Content "$L\.claude\settings.local.json" -Raw | ConvertFrom-Json
$settings.hooks.PreToolUse[0].hooks += [pscustomobject]@{ type = 'command'; command = 'node'; args = @('C:/mine/hook.js') }
[IO.File]::WriteAllText("$L\.claude\settings.local.json", ($settings | ConvertTo-Json -Depth 12))
$dry = & "$R\bin\deskpost.cmd" uninstall --dry-run --json | ConvertFrom-Json
$legacyFiles = @($dry.removal.files | Where-Object { ([string]$_.path) -match 'versions[\\/]1\.0\.0[\\/]' }).Count
Check ($legacyFiles -gt 100) "uninstall adopts the 1.0.0 version folder from its kept archive ($legacyFiles files)"
# READABLE, SO THE PREVIEW CAN HASH IT, AND NOT DELETABLE, SO THE FINISHER CANNOT REMOVE IT.
$locked = [IO.File]::Open("$R\versions\$version\README.md", 'Open', 'Read', 'Read')
Remove-Item $resultFile -ErrorAction SilentlyContinue
$uninstallOut = & "$R\bin\deskpost.cmd" uninstall --yes 2>&1 | Out-String
$final = Wait-Result
$receipt = Receipt $R
Check ($null -ne $final -and $final.status -eq 'failed' -and $null -ne $receipt -and $null -ne $receipt.pending -and $receipt.pending.operation -eq 'uninstall') "a held program file makes the finisher FAIL, pending and the receipt kept ($($final.status): $(@($final.left) -join '; ') $($uninstallOut.Trim()))"
$locked.Dispose()
try { & $installer -Release $Release -InstallRoot $R -Yes -NoPathChange -Resume finish | Out-Null; $ok = $true } catch { $ok = $false; "resume: $($_.Exception.Message)" }
Check ($ok -and -not (Test-Path "$R\current") -and -not (Test-Path "$R\install-receipt.json") -and -not (Test-Path "$R\bin")) "install.ps1 -Resume finish completes the failed uninstall with no program ($(if (Test-Path $R) { (Get-ChildItem $R -Recurse -Force | Select-Object -First 6 | ForEach-Object { $_.FullName.Substring($R.Length) }) -join ', ' }))"
Check ((Test-Path "$R\versions\1.0.0\mine.txt") -and (Test-Path "$R\downloads\mine.txt") -and @(Get-ChildItem "$R\versions\1.0.0" -Force).Count -eq 1) 'a reader''s own files inside versions\1.0.0 and downloads survive, with only their folders'
$after = [IO.File]::ReadAllText("$L\.claude\settings.local.json") + [IO.File]::ReadAllText("$L\.codex\hooks.json") + [IO.File]::ReadAllText("$L\.mcp.json")
Check ($after -notmatch [regex]::Escape($R) -and $after -notmatch [regex]::Escape(($R -replace '\\', '/')) -and $after -match 'C:/mine/hook.js') 'the Library''s 1.0 entries are gone, the Codex double-quoted render included, and the reader''s own hook survived'
Check ((Test-Path "$L\.library\workspace.json") -and (Test-Path "$L\shelf\holding")) 'the Library itself is untouched'

# --- 5. a missing kept archive leaves versions\1.0.0 in place -------------------------------------------------------
$R5 = "$Work\prog5"; $L5 = "$Work\lib5"
try { Install-Legacy $R5 $L5; & $installer -Release $Release -InstallRoot $R5 -Library $L5 -Yes -NoPathChange | Out-Null; $ok = $true } catch { $ok = $false; "legacy 5: $($_.Exception.Message)" }
Remove-Item "$R5\downloads\deskpost-1.0.0-win-x64.zip" -Force -ErrorAction SilentlyContinue
$dry = & "$R5\bin\deskpost.cmd" uninstall --dry-run --json | ConvertFrom-Json
Check ($ok -and @($dry.removal.kept | Where-Object { $_ -match 'versions/1\.0\.0 \(not recognised' }).Count -eq 1) "with its archive gone, versions\1.0.0 is named as not recognised ($(@($dry.removal.kept) -join '; '))"
Remove-Item $resultFile -ErrorAction SilentlyContinue
& "$R5\bin\deskpost.cmd" uninstall --yes | Out-Null
$final = Wait-Result
Check ($null -ne $final -and $final.status -eq 'completed' -and (Test-Path "$R5\versions\1.0.0\bin\library.exe") -and -not (Test-Path "$R5\current")) "the uninstall completes and leaves versions\1.0.0 in place ($($final.status))"

# --- 6. the CANCEL path: no finisher, cancel written, a late finisher deletes nothing, then -Resume finish -----------
$R6 = "$Work\prog6"
try { & $installer -Release $Release -InstallRoot $R6 -Library none -Yes -NoPathChange | Out-Null; $ok = $true } catch { $ok = $false; "install 6: $($_.Exception.Message)" }
$before = @(Get-ChildItem $R6 -Recurse -Force).Count
$started = Get-Date
$env:DESKPOST_UNINSTALL_FAULT = 'no-finisher'
$out = & "$R6\bin\deskpost.cmd" uninstall --yes 2>&1 | Out-String
$env:DESKPOST_UNINSTALL_FAULT = ''
$handshake = Get-ChildItem $env:TEMP -Filter 'deskpost-finish-*.handshake' | Where-Object { $_.LastWriteTime -ge $started } | Sort-Object LastWriteTime | Select-Object -Last 1
$receipt = Receipt $R6
Check ($ok -and $LASTEXITCODE -ne 0 -and $out -match 'finisher did not start' -and $null -ne $handshake -and (Get-Content $handshake.FullName -Raw) -match 'cancel' -and $receipt.pending.operation -eq 'uninstall') "with no finisher, the handshake writes cancel and pending stays ($(($out.Trim() -split "`n")[-1]))"
$lateResult = Join-Path $Work 'late-result.json'
& "$R6\current\bin\library.exe" finish-uninstall --parent-pid 999999 --root $R6 --handshake $handshake.FullName --transaction ([string]$receipt.pending.id) --result $lateResult | Out-Null
$late = if (Test-Path $lateResult) { Get-Content $lateResult -Raw | ConvertFrom-Json } else { $null }
Check ($null -ne $late -and $late.status -eq 'cancelled' -and @(Get-ChildItem $R6 -Recurse -Force).Count -eq $before) "a late finisher that finds cancel deletes nothing ($($late.status))"
try { & $installer -Release $Release -InstallRoot $R6 -Yes -NoPathChange -Resume finish | Out-Null; $ok = $true } catch { $ok = $false; "resume 6: $($_.Exception.Message)" }
Check ($ok -and -not (Test-Path $R6)) "-Resume finish completes the cancelled uninstall ($(if (Test-Path $R6) { (Get-ChildItem $R6 -Force | ForEach-Object Name) -join ', ' }))"
} finally {
    Pop-Location
    foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
}

$results
$passed = @($results | Where-Object { $_ -like 'PASS*' }).Count
"$passed of $($results.Count) passed"
if ($passed -ne $results.Count) { throw "$($results.Count - $passed) install proof case(s) failed." }
