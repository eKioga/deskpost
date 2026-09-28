<#
.SYNOPSIS
    The uninstall finisher: remove the PATH entry and the program files `deskpost uninstall` froze, after it has exited.

.DESCRIPTION
    PLAN-install-onboarding.md step 8 (ADR-0058). `deskpost uninstall` edits the Libraries, records the removal list
    in the receipt's `pending: uninstall`, copies this script to %TEMP% and starts the copy, so the script never deletes
    itself mid-run. Reached only by that delegation; never run by hand.

    THE HANDSHAKE (round 4, #1). This writes `started <pid>` to -Handshake and waits. The parent, on seeing it, makes
    this process the pending operation's owner and writes `go`; only then does this wait for the parent to exit and
    remove anything. `cancel`, or no `go` within 30 s, and this exits having deleted nothing.

    ONLY ON `completed` is `pending` cleared and the receipt deleted, last. On `failed` both stay, owned by no live
    process, and re-running the installer (-Resume finish) completes the list with no program present.

.PARAMETER ParentProcessId
    The `deskpost uninstall` process to wait for. `-Pid` would collide with PowerShell's read-only $PID.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$ParentProcessId,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Handshake,
    [Parameter(Mandatory)][string]$Transaction,
    [Parameter(Mandatory)][string]$Result
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Write-Handshake([string]$Line) { [IO.File]::AppendAllText($Handshake, "$Line`r`n") }

function Read-Receipt {
    Get-Content -LiteralPath (Join-Path $Root 'install-receipt.json') -Raw | ConvertFrom-Json
}

function Invoke-UnderLock([scriptblock]$Body) {
    $lock = Join-Path $Root '.lifecycle.lock'
    $deadline = (Get-Date).AddSeconds(15)
    $stream = $null
    while ($null -eq $stream) {
        try { $stream = [IO.File]::Open($lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { if ((Get-Date) -gt $deadline) { throw "the lifecycle lock at $lock is held" }; Start-Sleep -Milliseconds 200 }
    }
    try { & $Body } finally { $stream.Dispose() }
}

function Write-Result([string]$Status, $Problems) {
    $record = [ordered]@{ status = $Status; root = $Root; transaction = $Transaction; left = @($Problems); utc = (Get-Date).ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText($Result, (($record | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
}

Write-Handshake "started $PID"
$deadline = (Get-Date).AddSeconds(30)
$word = ''
while ((Get-Date) -lt $deadline) {
    $text = if (Test-Path -LiteralPath $Handshake) { [IO.File]::ReadAllText($Handshake) } else { '' }
    if ($text -match '(?m)^cancel') { $word = 'cancel'; break }
    if ($text -match '(?m)^go') { $word = 'go'; break }
    Start-Sleep -Milliseconds 100
}
if ($word -ne 'go') { Write-Result 'cancelled' @(); return }

# THE PARENT EXITS FIRST: it is the program being removed.
try { Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction Stop } catch { }

try {
    $receipt = Read-Receipt
    if ($null -eq $receipt.pending -or $receipt.pending.id -ne $Transaction) { Write-Result 'failed' @("the receipt no longer records transaction $Transaction"); return }
    $problems = Invoke-UninstallRemoval $Root $receipt.pending.removal
} catch {
    $problems = @("the removal stopped: $($_.Exception.Message)")
}

if (@($problems).Count) {
    # FAILED: pending and the receipt stay, owned by no live process, for -Resume finish.
    try { Invoke-UnderLock { $r = Read-Receipt; $r.pending.owner = $null; [IO.File]::WriteAllText((Join-Path $Root 'install-receipt.json'), (($r | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false)) } } catch { }
    Write-Result 'failed' $problems
    return
}

# COMPLETED: the receipt goes last, then the lock, .pending and the root, each only if nothing else is left.
Remove-Item -LiteralPath (Join-Path $Root 'install-receipt.json') -Force
Remove-Item -LiteralPath (Join-Path $Root '.pending') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $Root '.lifecycle.lock') -Force -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath $Root) -and -not @(Get-ChildItem -LiteralPath $Root -Force).Count) { [IO.Directory]::Delete($Root) }
Write-Result 'completed' @()
