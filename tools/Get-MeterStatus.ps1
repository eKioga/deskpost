[CmdletBinding()]
param(
    [string]$SessionsRoot,
    [switch]$SelfTest,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'CodexHome.ps1')

function Get-ObjectProperty([AllowNull()][object]$InputObject, [string]$Name) {
    if ($null -eq $InputObject) { return $null }
    $propertyNames = @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
    if ($propertyNames -ccontains $Name) { return $InputObject.$Name }
    $null
}

function ConvertTo-LimitWindow([AllowNull()][object]$Window) {
    if ($null -eq $Window) { return $null }

    $epoch = Get-ObjectProperty -InputObject $Window -Name 'resets_at'
    $resetUtc = $null
    if ($null -ne $epoch) {
        try { $resetUtc = [DateTimeOffset]::FromUnixTimeSeconds([long]$epoch).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'") }
        catch { $resetUtc = $null }
    }

    [pscustomobject][ordered]@{
        used_percent = Get-ObjectProperty -InputObject $Window -Name 'used_percent'
        window_minutes = Get-ObjectProperty -InputObject $Window -Name 'window_minutes'
        resets_at = $epoch
        resets_at_utc = $resetUtc
    }
}

function Get-RateLimitsFromRecord([AllowNull()][object]$Record) {
    if ((Get-ObjectProperty -InputObject $Record -Name 'type') -cne 'event_msg') { return $null }
    $payload = Get-ObjectProperty -InputObject $Record -Name 'payload'
    if ((Get-ObjectProperty -InputObject $payload -Name 'type') -cne 'token_count') { return $null }
    $info = Get-ObjectProperty -InputObject $payload -Name 'info'
    $rateLimits = Get-ObjectProperty -InputObject $info -Name 'rate_limits'
    if ($null -eq $rateLimits) {
        # Current local rollouts use this sibling shape; earlier observed records nested the block
        # under info. Both remain structural token_count fields, never substring matches.
        $rateLimits = Get-ObjectProperty -InputObject $payload -Name 'rate_limits'
    }
    $rateLimits
}

function New-MeterResult(
    [string]$Status,
    [string]$Root,
    [int]$RolloutFileCount,
    [int]$MalformedLineCount
) {
    [pscustomobject][ordered]@{
        operation = 'Codex delegate meter status'
        status = $Status
        reading_kind = 'last_known_from_disk'
        is_live = $false
        sessions_root = $Root
        source_path = $null
        source_timestamp_utc = $null
        reading_age_minutes = $null
        rollout_file_count = $RolloutFileCount
        malformed_line_count = $MalformedLineCount
        limit_id = $null
        plan_type = $null
        credits = $null
        primary = $null
        secondary = $null
        shared_library_write = $false
    }
}

function Get-MeterReading([string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Root)) { throw 'SessionsRoot must not be empty.' }

    $fullRoot = [IO.Path]::GetFullPath($Root)
    $codexRoot = Split-Path -Parent $fullRoot
    if (-not (Test-Path -LiteralPath $codexRoot -PathType Container)) {
        return New-MeterResult -Status 'codex_directory_missing' -Root $fullRoot -RolloutFileCount 0 -MalformedLineCount 0
    }
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        return New-MeterResult -Status 'sessions_directory_missing' -Root $fullRoot -RolloutFileCount 0 -MalformedLineCount 0
    }

    $rolloutFiles = @(Get-ChildItem -LiteralPath $fullRoot -Recurse -File -Filter 'rollout-*.jsonl' | Sort-Object LastWriteTimeUtc -Descending)
    if ($rolloutFiles.Count -eq 0) {
        return New-MeterResult -Status 'no_rollout_files' -Root $fullRoot -RolloutFileCount 0 -MalformedLineCount 0
    }

    $malformedLineCount = 0
    $sourceFile = $null
    $rateLimits = $null
    foreach ($file in $rolloutFiles) {
        $lastInFile = $null
        try { $text = [IO.File]::ReadAllText($file.FullName) }
        catch {
            $malformedLineCount++
            continue
        }

        foreach ($line in @([regex]::Split($text, '\r?\n'))) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $record = $line | ConvertFrom-Json }
            catch {
                $malformedLineCount++
                continue
            }
            $candidate = Get-RateLimitsFromRecord -Record $record
            if ($null -ne $candidate) { $lastInFile = $candidate }
        }

        if ($null -ne $lastInFile) {
            $sourceFile = $file
            $rateLimits = $lastInFile
            break
        }
    }

    if ($null -eq $sourceFile) {
        $emptyStatus = if ($malformedLineCount -gt 0) { 'no_rate_limits_with_malformed_lines' } else { 'no_rate_limits' }
        return New-MeterResult -Status $emptyStatus -Root $fullRoot -RolloutFileCount $rolloutFiles.Count -MalformedLineCount $malformedLineCount
    }

    $status = if ($malformedLineCount -gt 0) { 'ok_with_malformed_lines' } else { 'ok' }
    $result = New-MeterResult -Status $status -Root $fullRoot -RolloutFileCount $rolloutFiles.Count -MalformedLineCount $malformedLineCount
    $sourceTimestamp = [DateTimeOffset]::new($sourceFile.LastWriteTimeUtc)
    $result.source_path = $sourceFile.FullName
    $result.source_timestamp_utc = $sourceTimestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")
    $result.reading_age_minutes = [Math]::Round(([DateTimeOffset]::UtcNow - $sourceTimestamp).TotalMinutes, 2)
    $result.limit_id = Get-ObjectProperty -InputObject $rateLimits -Name 'limit_id'
    $result.plan_type = Get-ObjectProperty -InputObject $rateLimits -Name 'plan_type'
    $result.credits = Get-ObjectProperty -InputObject $rateLimits -Name 'credits'
    $result.primary = ConvertTo-LimitWindow (Get-ObjectProperty -InputObject $rateLimits -Name 'primary')
    $result.secondary = ConvertTo-LimitWindow (Get-ObjectProperty -InputObject $rateLimits -Name 'secondary')
    $result
}

if ($SelfTest) {
    $checks = [Collections.Generic.List[object]]::new()
    function Assert-SelfTest([string]$Name, [bool]$Condition) {
        if (-not $Condition) { throw "Get-MeterStatus self-test failed: $Name" }
        [void]$checks.Add([pscustomobject]@{ check = $Name; result = 'pass' })
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ("meter-status-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $root = Join-Path $fixture '.codex\sessions'
    $session = Join-Path $root '2026\08\18'
    New-Item -ItemType Directory -Path $session -Force | Out-Null
    try {
        $path = Join-Path $session 'rollout-selftest.jsonl'
        $body = @(
            '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10.0,"window_minutes":60,"resets_at":1787240000},"secondary":null,"credits":{"has_credits":false},"plan_type":"plus"}}}}',
            '{"timestamp":"2026-08-12T01:51:46.299Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200},"rate_limits":{"limit_id":"codex","primary":{"used_percent":82.0,"window_minutes":10080,"resets_at":1787245625},"secondary":null,"credits":{"has_credits":false},"plan_type":"plus"}}}}',
            '{"type":"event_msg","payload":{"type":"message","text":"the build spec quoted rate_limits JSON"},"rate_limits":{"limit_id":"decoy","primary":{"used_percent":99}}}',
            '{"timestamp":"2026-08-12T01:52:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":'
        ) -join "`r`n"
        [IO.File]::WriteAllText($path, $body, [Text.UTF8Encoding]::new($false))
        [IO.File]::SetLastWriteTimeUtc($path, [DateTime]::UtcNow.AddMinutes(-30))

        $reading = Get-MeterReading -Root $root
        Assert-SelfTest 'a truncated line is tolerated' ($reading.status -ceq 'ok_with_malformed_lines')
        Assert-SelfTest 'the last occurrence wins' ($reading.primary.used_percent -eq 82.0)
        Assert-SelfTest 'the reset epoch is retained' ($reading.primary.resets_at -eq 1787245625)
        Assert-SelfTest 'the reset is converted to UTC' ($reading.primary.resets_at_utc -ceq '2026-08-20T17:07:05Z')
        Assert-SelfTest 'a null secondary remains null' ($null -eq $reading.secondary)
        Assert-SelfTest 'a top-level rate_limits decoy is ignored' ($reading.limit_id -ceq 'codex')
        Assert-SelfTest 'staleness is reported' ($reading.reading_age_minutes -ge 29)

        # THE DEFAULT ROOT, BOTH BRANCHES. This was a hard-coded ~/.codex/sessions until 2026-09-08,
        # which read a store an Orca-launched delegate never writes to and reported a real but stale
        # figure rather than failing. A preflight consulted to rule out staleness cannot be the
        # thing that manufactures it. Reasoning and the measurement: tools/CodexHome.ps1.
        $callerCodexHome = $env:CODEX_HOME
        try {
            $redirected = Join-Path $fixture 'redirected-home'
            $env:CODEX_HOME = $redirected
            Assert-SelfTest 'CODEX_HOME decides the sessions root' ((Get-CodexSessionsRoot) -ceq (Join-Path $redirected 'sessions'))
            $env:CODEX_HOME = ''
            Assert-SelfTest 'an unset CODEX_HOME falls back to the user profile' ((Get-CodexSessionsRoot) -ceq (Join-Path (Join-Path $env:USERPROFILE '.codex') 'sessions'))
        }
        finally { $env:CODEX_HOME = $callerCodexHome }

        Write-LibraryResult -Json:$Json -Result ([pscustomobject][ordered]@{
            operation = 'Codex delegate meter self-test'
            checks = @($checks)
            passed = $checks.Count
            shared_library_write = $false
        })
        return
    }
    finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ([string]::IsNullOrWhiteSpace($SessionsRoot)) { $SessionsRoot = Get-CodexSessionsRoot }
$reading = Get-MeterReading -Root $SessionsRoot
Write-LibraryResult -Result $reading -Json:$Json
