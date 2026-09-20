[CmdletBinding()]
param(
    [string]$ClaudeSessionsRoot = (Join-Path $env:USERPROFILE '.claude\projects\D--Library'),
    [string]$CodexSessionsRoot,
    [string]$WorkspacePath = 'D:\Library',
    [Nullable[DateTimeOffset]]$AsOf,
    [string]$SourceManifest,
    [switch]$IncludeRawLabels,
    [switch]$SelfTest,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'CodexHome.ps1')
$script:Utf8Strict = [Text.UTF8Encoding]::new($false, $true)
$script:Utf8 = [Text.UTF8Encoding]::new($false)

function Get-Property([AllowNull()][object]$Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if (@($Object.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains $Name) { return $Object.$Name }
    $null
}

function Get-HashBytes([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-HashText([string]$Text) { Get-HashBytes $script:Utf8.GetBytes($Text) }

function Read-Prefix([string]$Path, [long]$Limit) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        if ($stream.Length -lt $Limit) { throw "Source '$Path' is shorter than its manifest byte limit ($($stream.Length) < $Limit)." }
        if ($Limit -gt [int]::MaxValue) { throw "Source '$Path' is too large for this helper's in-memory prefix reader." }
        $bytes = [byte[]]::new([int]$Limit)
        $read = 0
        while ($read -lt $bytes.Length) {
            $count = $stream.Read($bytes, $read, $bytes.Length - $read)
            if ($count -eq 0) { throw "Source '$Path' ended before its manifest byte limit." }
            $read += $count
        }
        return ,$bytes
    }
    finally { $stream.Dispose() }
}

function Test-BeneathRoot([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full -ceq $base -or $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoEscapingLink([string]$Path, [string]$Root) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $cursor = [IO.Path]::GetFullPath($Path)
    while (Test-BeneathRoot $cursor $base) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $target = [string](Get-Property $item 'Target')
            if ([string]::IsNullOrWhiteSpace($target)) { throw "Manifest source '$Path' uses an unverifiable reparse point." }
            $resolvedTarget = if ([IO.Path]::IsPathRooted($target)) { [IO.Path]::GetFullPath($target) } else { [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $cursor) $target)) }
            if (-not (Test-BeneathRoot $resolvedTarget $base)) { throw "Manifest source '$Path' escapes its configured session root through a link." }
        }
        if ($cursor.TrimEnd('\', '/') -ceq $base) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) { break }
        $cursor = $parent
    }
}

function Get-SourceRecords([string]$ClaudeRoot, [string]$CodexRoot, [string]$ManifestPath) {
    $roots = @{ claude = [IO.Path]::GetFullPath($ClaudeRoot); codex = [IO.Path]::GetFullPath($CodexRoot) }
    $sources = [Collections.Generic.List[object]]::new()
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        foreach ($engine in @('claude', 'codex')) {
            $root = $roots[$engine]
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
            $files = if ($engine -ceq 'claude') {
                @(Get-ChildItem -LiteralPath $root -File -Filter '*.jsonl' | Sort-Object FullName)
            } else {
                @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.jsonl' | Sort-Object FullName)
            }
            foreach ($file in $files) {
                $limit = [long]$file.Length
                $bytes = Read-Prefix $file.FullName $limit
                [void]$sources.Add([pscustomobject][ordered]@{ engine = $engine; path = $file.FullName; byte_limit = $limit; sha256 = Get-HashBytes $bytes; bytes = $bytes })
            }
        }
        return @($sources)
    }

    $manifestFull = [IO.Path]::GetFullPath($ManifestPath)
    if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) { throw "Source manifest '$ManifestPath' does not exist." }
    $manifestText = [IO.File]::ReadAllText($manifestFull, $script:Utf8Strict)
    $manifestObject = $manifestText | ConvertFrom-Json
    $entries = Get-Property $manifestObject 'sources'
    if ($null -eq $entries) { $entries = Get-Property $manifestObject 'source_manifest' }
    if ($null -eq $entries) { throw 'Source manifest must contain a sources array.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($entries)) {
        $engine = [string](Get-Property $entry 'engine')
        if ($engine -cnotin @('claude', 'codex')) { throw "Manifest entry has unknown engine '$engine'." }
        $rawPath = [string](Get-Property $entry 'path')
        if ([string]::IsNullOrWhiteSpace($rawPath)) { throw 'Manifest entry has no path.' }
        if (@([regex]::Split($rawPath, '[\\/]') | Where-Object { $_ -ceq '..' }).Count -gt 0) { throw "Manifest source '$rawPath' contains a traversal segment." }
        $full = [IO.Path]::GetFullPath($rawPath)
        if (-not (Test-BeneathRoot $full $roots[$engine])) { throw "Manifest source '$rawPath' is outside the configured $engine session root." }
        if ([IO.Path]::GetExtension($full) -cne '.jsonl') { throw "Manifest source '$rawPath' is not a .jsonl file." }
        if (-not $seen.Add($full)) { throw "Manifest source '$rawPath' is duplicated." }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Manifest source '$rawPath' is missing." }
        Assert-NoEscapingLink $full $roots[$engine]
        $limit = [long](Get-Property $entry 'byte_limit')
        if ($limit -lt 0) { throw "Manifest source '$rawPath' has an invalid byte limit." }
        $bytes = Read-Prefix $full $limit
        $actualHash = Get-HashBytes $bytes
        $expectedHash = [string](Get-Property $entry 'sha256')
        if ($actualHash -cne $expectedHash) { throw "Manifest source '$rawPath' prefix hash does not match." }
        [void]$sources.Add([pscustomobject][ordered]@{ engine = $engine; path = $full; byte_limit = $limit; sha256 = $actualHash; bytes = $bytes })
    }
    @($sources)
}

function ConvertTo-NormalizedCwd([AllowNull()][object]$Cwd) {
    if ($null -eq $Cwd) { return '' }
    $value = ([string]$Cwd).Replace('\', '/').TrimEnd('/')
    if ($value -cmatch '^/mnt/([A-Za-z])(?:/(.*))?$') {
        $tail = [string]$Matches[2]
        $value = $Matches[1].ToUpperInvariant() + ':/' + $tail
    }
    $value.ToLowerInvariant()
}

function Test-InScope([AllowNull()][object]$Cwd, [string]$Workspace) {
    (ConvertTo-NormalizedCwd $Cwd) -ceq (ConvertTo-NormalizedCwd $Workspace)
}

function ConvertTo-Records($Sources, [Nullable[DateTimeOffset]]$Cutoff) {
    $records = [Collections.Generic.List[object]]::new()
    $issues = [Collections.Generic.List[object]]::new()
    foreach ($source in @($Sources)) {
        try { $text = $script:Utf8Strict.GetString([byte[]]$source.bytes) }
        catch {
            [void]$issues.Add([pscustomobject]@{ engine = $source.engine; path = $source.path; kind = 'invalid_utf8'; count = 1 })
            continue
        }
        $lineNumber = 0
        foreach ($line in @([regex]::Split($text, '\r?\n'))) {
            $lineNumber++
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $record = $line | ConvertFrom-Json }
            catch {
                [void]$issues.Add([pscustomobject]@{ engine = $source.engine; path = $source.path; kind = 'malformed_line'; line = $lineNumber; contributing_token_event = $line.Contains('"token_count"'); count = 1 })
                continue
            }
            $timestamp = Get-Property $record 'timestamp'
            if ($null -ne $Cutoff -and $null -ne $timestamp) {
                $parsedTimestamp = [DateTimeOffset]::MinValue
                if ([DateTimeOffset]::TryParse([string]$timestamp, [ref]$parsedTimestamp) -and $parsedTimestamp -gt [DateTimeOffset]$Cutoff) { continue }
            }
            [void]$records.Add([pscustomobject]@{ engine = $source.engine; source = $source.path; line = $lineNumber; value = $record })
        }
    }
    [pscustomobject]@{ records = @($records); issues = @($issues) }
}

function Get-UsageNumber([AllowNull()][object]$Usage, [string]$Name) {
    $value = Get-Property $Usage $Name
    if ($null -eq $value) { return [long]0 }
    [long]$value
}

function ConvertTo-ClaudeUsage([object]$Usage) {
    $input = Get-UsageNumber $Usage 'input_tokens'
    $write = Get-UsageNumber $Usage 'cache_creation_input_tokens'
    $read = Get-UsageNumber $Usage 'cache_read_input_tokens'
    $output = Get-UsageNumber $Usage 'output_tokens'
    $details = Get-Property $Usage 'output_tokens_details'
    [pscustomobject][ordered]@{
        total_input_tokens = $input + $write + $read
        direct_input_tokens = $input
        cache_write_input_tokens = $write
        cache_read_input_tokens = $read
        output_tokens = $output
        reasoning_output_tokens = Get-UsageNumber $details 'thinking_tokens'
        total_tokens = $input + $write + $read + $output
    }
}

function ConvertTo-CodexUsage([object]$Usage) {
    $input = Get-UsageNumber $Usage 'input_tokens'
    $output = Get-UsageNumber $Usage 'output_tokens'
    $total = Get-UsageNumber $Usage 'total_tokens'
    if ($total -eq 0 -and ($input -ne 0 -or $output -ne 0)) { $total = $input + $output }
    [pscustomobject][ordered]@{
        total_input_tokens = $input
        cached_input_tokens = Get-UsageNumber $Usage 'cached_input_tokens'
        cache_write_input_tokens = Get-UsageNumber $Usage 'cache_write_input_tokens'
        output_tokens = $output
        reasoning_output_tokens = Get-UsageNumber $Usage 'reasoning_output_tokens'
        total_tokens = $total
    }
}

function Get-Percentiles([long[]]$Values) {
    $sorted = @($Values | Sort-Object)
    $result = [ordered]@{ quantity = 'per-turn total input'; count = $sorted.Count; p50 = $null; p95 = $null; maximum = $null }
    if ($sorted.Count -eq 0) { return [pscustomobject]$result }
    function Pick([double]$P) { $sorted[[Math]::Max(0, [Math]::Ceiling($P * $sorted.Count) - 1)] }
    $result.p50 = Pick 0.50
    $result.p95 = Pick 0.95
    $result.maximum = $sorted[$sorted.Count - 1]
    [pscustomobject]$result
}

function Get-SafeLabel([string]$Kind, [AllowNull()][object]$Value, [bool]$Raw) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    if ($Raw) { return [string]$Value }
    "$Kind-" + (Get-HashText ([string]$Value)).Substring(0, 12)
}

function Get-ClaudeBaseline($Records, $Issues, [string]$Workspace, [bool]$RawLabels) {
    $all = @($Records | Where-Object { $_.engine -ceq 'claude' })
    $nodes = @{}
    $sessionMeta = @{}
    foreach ($wrapped in $all) {
        $record = $wrapped.value
        $uuid = [string](Get-Property $record 'uuid')
        if (-not [string]::IsNullOrWhiteSpace($uuid)) { $nodes[$uuid] = $record }
        $sessionId = [string](Get-Property $record 'sessionId')
        if (-not [string]::IsNullOrWhiteSpace($sessionId) -and -not $sessionMeta.ContainsKey($sessionId)) {
            $sessionMeta[$sessionId] = [pscustomobject]@{ cwd = Get-Property $record 'cwd'; title = $null; last_prompt = $null; git_branch = Get-Property $record 'gitBranch' }
        }
        $recordType = [string](Get-Property $record 'type')
        if ($recordType -ceq 'custom-title' -and $sessionMeta.ContainsKey($sessionId)) { $sessionMeta[$sessionId].title = Get-Property $record 'customTitle' }
        if ($recordType -ceq 'last-prompt' -and $sessionMeta.ContainsKey($sessionId)) { $sessionMeta[$sessionId].last_prompt = Get-Property $record 'lastPrompt' }
    }

    $assistantCount = 0
    $dedup = @{}
    $conflicts = [Collections.Generic.List[string]]::new()
    foreach ($wrapped in $all) {
        $record = $wrapped.value
        if ((Get-Property $record 'type') -cne 'assistant') { continue }
        $sessionId = [string](Get-Property $record 'sessionId')
        $cwd = Get-Property $record 'cwd'
        if ($null -eq $cwd -and $sessionMeta.ContainsKey($sessionId)) { $cwd = $sessionMeta[$sessionId].cwd }
        if (-not (Test-InScope $cwd $Workspace)) { continue }
        $message = Get-Property $record 'message'
        $usage = Get-Property $message 'usage'
        if ($null -eq $usage) { continue }
        $assistantCount++
        $requestId = [string](Get-Property $record 'requestId')
        $identity = if ([string]::IsNullOrWhiteSpace($requestId)) { [string](Get-Property $record 'uuid') } else { $requestId }
        if ([string]::IsNullOrWhiteSpace($identity)) { $identity = "source:$($wrapped.source):$($wrapped.line)" }
        $key = "$sessionId`u{001f}$identity"
        $usageShape = ConvertTo-ClaudeUsage $usage
        $fingerprint = $usageShape | ConvertTo-Json -Compress
        if ($dedup.ContainsKey($key)) {
            if ($dedup[$key].fingerprint -cne $fingerprint -and -not $conflicts.Contains($key)) { [void]$conflicts.Add($key) }
            continue
        }
        $dedup[$key] = [pscustomobject]@{ record = $record; usage = $usageShape; fingerprint = $fingerprint; key = $key }
    }

    $valid = @($dedup.Values | Where-Object { -not $conflicts.Contains($_.key) })
    $sessions = [Collections.Generic.List[object]]::new()
    $segments = @{}
    $coverage = @{ attribution_skill = 0; session_boundary = 0; prompt_segment = 0; unclassified = 0; sidechain = 0 }
    foreach ($group in @($valid | Group-Object { [string](Get-Property $_.record 'sessionId') })) {
        $sum = [ordered]@{ total_input_tokens = [long]0; direct_input_tokens = [long]0; cache_write_input_tokens = [long]0; cache_read_input_tokens = [long]0; output_tokens = [long]0; reasoning_output_tokens = [long]0; total_tokens = [long]0 }
        $turnInputs = [Collections.Generic.List[long]]::new()
        foreach ($entry in @($group.Group)) {
            foreach ($name in @($sum.Keys)) { $sum[$name] += [long]$entry.usage.$name }
            [void]$turnInputs.Add([long]$entry.usage.total_input_tokens)
            $record = $entry.record
            $sessionId = [string](Get-Property $record 'sessionId')
            $tier = 'unclassified'
            $labelValue = $null
            if ([bool](Get-Property $record 'isSidechain')) { $tier = 'sidechain'; $labelValue = $sessionId }
            else {
                $skill = Get-Property $record 'attributionSkill'
                if ($null -ne $skill) { $tier = 'attribution_skill'; $labelValue = $skill }
                elseif ($sessionMeta.ContainsKey($sessionId) -and ($null -ne $sessionMeta[$sessionId].title -or $null -ne $sessionMeta[$sessionId].last_prompt)) {
                    $tier = 'session_boundary'; $labelValue = if ($null -ne $sessionMeta[$sessionId].title) { $sessionMeta[$sessionId].title } else { $sessionMeta[$sessionId].last_prompt }
                }
                else {
                    $parent = [string](Get-Property $record 'parentUuid')
                    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                    while (-not [string]::IsNullOrWhiteSpace($parent) -and $nodes.ContainsKey($parent) -and $seen.Add($parent)) {
                        $ancestor = $nodes[$parent]
                        $promptId = Get-Property $ancestor 'promptId'
                        if ($null -ne $promptId) { $tier = 'prompt_segment'; $labelValue = $promptId; break }
                        $parent = [string](Get-Property $ancestor 'parentUuid')
                    }
                }
            }
            $coverage[$tier]++
            $safe = Get-SafeLabel $tier $labelValue $RawLabels
            if ($null -eq $safe) { $safe = 'unclassified' }
            $segmentKey = "$tier`u{001f}$safe"
            if (-not $segments.ContainsKey($segmentKey)) { $segments[$segmentKey] = [ordered]@{ tier = $tier; label = $safe; turns = 0; total_input_tokens = [long]0; output_tokens = [long]0 } }
            $segments[$segmentKey].turns++
            $segments[$segmentKey].total_input_tokens += [long]$entry.usage.total_input_tokens
            $segments[$segmentKey].output_tokens += [long]$entry.usage.output_tokens
        }
        $meta = if ($sessionMeta.ContainsKey($group.Name)) { $sessionMeta[$group.Name] } else { $null }
        [void]$sessions.Add([pscustomobject][ordered]@{ session = Get-SafeLabel 'session' $group.Name $RawLabels; git_branch = if ($null -eq $meta) { $null } else { $meta.git_branch }; turns = $group.Count; totals = [pscustomobject]$sum; input_percentiles = Get-Percentiles @($turnInputs) })
    }

    $grand = [ordered]@{ total_input_tokens = [long]0; direct_input_tokens = [long]0; cache_write_input_tokens = [long]0; cache_read_input_tokens = [long]0; output_tokens = [long]0; reasoning_output_tokens = [long]0; total_tokens = [long]0 }
    foreach ($session in @($sessions)) { foreach ($name in @($grand.Keys)) { $grand[$name] += [long]$session.totals.$name } }
    $totalCoverage = [Math]::Max(1, $valid.Count)
    $coverageRows = @($coverage.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ tier = $_; turns = $coverage[$_]; percent = [Math]::Round(100 * $coverage[$_] / $totalCoverage, 2) } })

    $toolBytes = [long]0
    $toolShapes = 0
    $unsupported = 0
    foreach ($wrapped in $all) {
        $record = $wrapped.value
        $sessionId = [string](Get-Property $record 'sessionId')
        $cwd = Get-Property $record 'cwd'
        if ($null -eq $cwd -and $sessionMeta.ContainsKey($sessionId)) { $cwd = $sessionMeta[$sessionId].cwd }
        if (-not (Test-InScope $cwd $Workspace)) { continue }
        $result = Get-Property $record 'toolUseResult'
        if ($null -ne $result) { $toolShapes++; $toolBytes += $script:Utf8.GetByteCount(($result | ConvertTo-Json -Compress -Depth 32)); continue }
        $message = Get-Property $record 'message'
        foreach ($block in @((Get-Property $message 'content'))) {
            if ((Get-Property $block 'type') -ceq 'tool_result') { $unsupported++ }
        }
    }

    [pscustomobject][ordered]@{
        engine = 'claude'; status = if (@($Issues | Where-Object { $_.engine -ceq 'claude' }).Count -or $conflicts.Count) { 'ok_with_malformed_or_conflicting_records' } else { 'ok' }
        accounting_formula = 'total_input=input+cache_creation+cache_read; total=total_input+output; thinking is nested in output'
        assistant_records = $assistantCount; deduplicated_requests = $dedup.Count; excluded_conflicts = $conflicts.Count
        deduplication_ratio = if ($assistantCount) { [Math]::Round($dedup.Count / $assistantCount, 6) } else { $null }
        totals = [pscustomobject]$grand; sessions = @($sessions); segments = @($segments.Values); coverage = $coverageRows
        unclassified_turns = $coverage.unclassified
        tool_results = [pscustomobject]@{ extraction = 'UTF-8 bytes of compact JSON serialization of top-level toolUseResult'; parsed_shapes = $toolShapes; utf8_bytes = $toolBytes; unsupported_shapes = $unsupported }
    }
}

function Get-CodexBaseline($Records, $Issues, [string]$Workspace, [bool]$RawLabels) {
    $all = @($Records | Where-Object { $_.engine -ceq 'codex' })
    $sessionBuckets = @{}
    foreach ($sourceGroup in @($all | Group-Object source)) {
        $identity = $sourceGroup.Name; $sourceCwd = $null
        foreach ($wrapped in @($sourceGroup.Group)) {
            if ((Get-Property $wrapped.value 'type') -ceq 'session_meta') {
                $payload = Get-Property $wrapped.value 'payload'
                $candidate = [string](Get-Property $payload 'id'); if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = [string](Get-Property $payload 'session_id') }
                if (-not [string]::IsNullOrWhiteSpace($candidate)) { $identity = $candidate }
                $sourceCwd = Get-Property $payload 'cwd'; break
            }
        }
        if (-not $sessionBuckets.ContainsKey($identity)) { $sessionBuckets[$identity] = [pscustomobject]@{ Name = $identity; Group = [Collections.Generic.List[object]]::new(); Sources = [Collections.Generic.List[string]]::new(); Cwd = $sourceCwd } }
        foreach ($wrapped in @($sourceGroup.Group)) { [void]$sessionBuckets[$identity].Group.Add($wrapped) }
        [void]$sessionBuckets[$identity].Sources.Add($sourceGroup.Name)
        if ($null -eq $sessionBuckets[$identity].Cwd) { $sessionBuckets[$identity].Cwd = $sourceCwd }
    }
    $sessions = [Collections.Generic.List[object]]::new()
    $allTurnInputs = [Collections.Generic.List[long]]::new()
    $aggregate = [ordered]@{ total_input_tokens = [long]0; cached_input_tokens = [long]0; cache_write_input_tokens = [long]0; output_tokens = [long]0; reasoning_output_tokens = [long]0; total_tokens = [long]0 }
    $toolBytes = [long]0
    $toolShapes = 0
    $unsupported = 0
    $segments = @{}
    foreach ($fileGroup in @($sessionBuckets.Values)) {
        $sessionId = $fileGroup.Name
        $cwd = $fileGroup.Cwd
        $gitBranch = $null
        foreach ($wrapped in @($fileGroup.Group)) {
            if ((Get-Property $wrapped.value 'type') -ceq 'session_meta') {
                $payload = Get-Property $wrapped.value 'payload'; $sessionId = [string](Get-Property $payload 'id'); if ([string]::IsNullOrWhiteSpace($sessionId)) { $sessionId = [string](Get-Property $payload 'session_id') }; $cwd = Get-Property $payload 'cwd'; $gitBranch = Get-Property $payload 'git_branch'; break
            }
        }
        if (-not (Test-InScope $cwd $Workspace)) { continue }
        $events = [Collections.Generic.List[object]]::new()
        $seenEvents = @{}
        $duplicated = $false; $conflicting = $false; $missing = $false
        $currentSegment = $null
        foreach ($wrapped in @($fileGroup.Group)) {
            $record = $wrapped.value; $payload = Get-Property $record 'payload'
            if ((Get-Property $record 'type') -ceq 'event_msg' -and (Get-Property $payload 'type') -ceq 'task_started') { $currentSegment = Get-Property $payload 'turn_id' }
            if ((Get-Property $record 'type') -ceq 'event_msg' -and (Get-Property $payload 'type') -ceq 'token_count') {
                $info = Get-Property $payload 'info'; $totalUsage = Get-Property $info 'total_token_usage'; $lastUsage = Get-Property $info 'last_token_usage'
                if ($null -eq $totalUsage) { continue }
                if ($null -eq $lastUsage) { $missing = $true }
                $timestamp = [string](Get-Property $record 'timestamp')
                if ([string]::IsNullOrWhiteSpace($timestamp)) { $timestamp = "$($wrapped.source):$($wrapped.line)" }
                $signature = "$timestamp|" + ($totalUsage | ConvertTo-Json -Compress) + '|' + ($lastUsage | ConvertTo-Json -Compress)
                if ($seenEvents.ContainsKey($timestamp)) {
                    if ($seenEvents[$timestamp] -ceq $signature) { $duplicated = $true } else { $conflicting = $true }
                    continue
                }
                $seenEvents[$timestamp] = $signature
                [void]$events.Add([pscustomobject]@{ total = ConvertTo-CodexUsage $totalUsage; last = if ($null -eq $lastUsage) { $null } else { ConvertTo-CodexUsage $lastUsage }; segment = $currentSegment })
            }
            if ((Get-Property $record 'type') -ceq 'response_item') {
                $kind = [string](Get-Property $payload 'type')
                if ($kind -cin @('function_call_output', 'custom_tool_call_output')) {
                    $output = Get-Property $payload 'output'
                    if ($null -eq $output) { $unsupported++ } else { $toolShapes++; $toolBytes += $script:Utf8.GetByteCount(($output | ConvertTo-Json -Compress -Depth 32)) }
                }
            }
        }
        if ($events.Count -eq 0) { continue }
        $candidate = [ordered]@{ total_input_tokens = [long]0; cached_input_tokens = [long]0; cache_write_input_tokens = [long]0; output_tokens = [long]0; reasoning_output_tokens = [long]0; total_tokens = [long]0 }
        $lastSum = [ordered]@{ total_input_tokens = [long]0; cached_input_tokens = [long]0; cache_write_input_tokens = [long]0; output_tokens = [long]0; reasoning_output_tokens = [long]0; total_tokens = [long]0 }
        $epochLast = $null; $decreased = $false; $sessionTurnInputs = [Collections.Generic.List[long]]::new()
        foreach ($event in @($events)) {
            if ($null -ne $epochLast) {
                foreach ($name in @($candidate.Keys)) { if ([long]$event.total.$name -lt [long]$epochLast.$name) { $decreased = $true; break } }
            }
            if ($null -eq $epochLast -or @($candidate.Keys | Where-Object { [long]$event.total.$_ -lt [long]$epochLast.$_ }).Count -gt 0) {
                foreach ($name in @($candidate.Keys)) { $candidate[$name] += [long]$event.total.$name }
            } else {
                foreach ($name in @($candidate.Keys)) { $candidate[$name] += [long]$event.total.$name - [long]$epochLast.$name }
            }
            $epochLast = $event.total
            if ($null -ne $event.last) {
                foreach ($name in @($lastSum.Keys)) { $lastSum[$name] += [long]$event.last.$name }
                [void]$allTurnInputs.Add([long]$event.last.total_input_tokens)
                [void]$sessionTurnInputs.Add([long]$event.last.total_input_tokens)
                $segmentLabel = Get-SafeLabel 'prompt_segment' $event.segment $RawLabels
                if ($null -eq $segmentLabel) { $segmentLabel = 'unclassified' }
                if (-not $segments.ContainsKey($segmentLabel)) { $segments[$segmentLabel] = [ordered]@{ tier = if ($segmentLabel -ceq 'unclassified') { 'unclassified' } else { 'prompt_segment' }; label = $segmentLabel; model_requests = 0; total_input_tokens = [long]0; output_tokens = [long]0 } }
                $segments[$segmentLabel].model_requests++
                $segments[$segmentLabel].total_input_tokens += [long]$event.last.total_input_tokens
                $segments[$segmentLabel].output_tokens += [long]$event.last.output_tokens
            }
        }
        $unparsed = @($Issues | Where-Object { $_.engine -ceq 'codex' -and @($fileGroup.Sources) -ccontains $_.path -and [bool](Get-Property $_ 'contributing_token_event') }).Count -gt 0
        $matches = @($candidate.Keys | Where-Object { [long]$candidate[$_] -ne [long]$lastSum[$_] }).Count -eq 0
        $reconciled = $matches -and -not $missing -and -not $duplicated -and -not $conflicting -and -not $unparsed
        $admitted = -not $decreased -or $reconciled
        $status = if ($decreased) { if ($reconciled) { 'reconciled_after_discontinuity' } else { 'ambiguous_after_discontinuity' } } else { 'ok' }
        if ($admitted) { foreach ($name in @($aggregate.Keys)) { $aggregate[$name] += [long]$candidate[$name] } }
        [void]$sessions.Add([pscustomobject][ordered]@{
            session = Get-SafeLabel 'session' $sessionId $RawLabels; git_branch = $gitBranch; status = $status; admitted_to_aggregates = $admitted
            cumulative_epoch_sum_candidate = [pscustomobject]$candidate; summed_last_token_usage = [pscustomobject]$lastSum
            reconciliation = [pscustomobject]@{ exact = $matches; successful = $reconciled; missing_event = $missing; duplicated_event = $duplicated; conflicting_event = $conflicting; unparsed_event = $unparsed }
            model_requests = @($events | Where-Object { $null -ne $_.last }).Count
            input_percentiles = Get-Percentiles @($sessionTurnInputs)
        })
    }
    [pscustomobject][ordered]@{
        engine = 'codex'; status = if (@($Issues | Where-Object { $_.engine -ceq 'codex' }).Count) { 'ok_with_malformed_lines' } else { 'ok' }
        accounting_formula = 'total=input+output; cached_input and cache_write are nested in input; reasoning is nested in output'
        totals = [pscustomobject]$aggregate; sessions = @($sessions); segments = @($segments.Values); input_percentiles = Get-Percentiles @($allTurnInputs)
        tool_results = [pscustomobject]@{ extraction = 'UTF-8 bytes of compact JSON serialization of response_item function_call_output/custom_tool_call_output output'; parsed_shapes = $toolShapes; utf8_bytes = $toolBytes; unsupported_shapes = $unsupported }
    }
}

function Get-ElapsedSummary($Records, [string]$Workspace) {
    $result = [ordered]@{}
    foreach ($engine in @('claude', 'codex')) {
        $deltas = [Collections.Generic.List[double]]::new()
        foreach ($group in @($Records | Where-Object { $_.engine -ceq $engine } | Group-Object source)) {
            $inScope = $false
            foreach ($wrapped in @($group.Group)) {
                $record = $wrapped.value
                $cwd = if ($engine -ceq 'codex' -and (Get-Property $record 'type') -ceq 'session_meta') { Get-Property (Get-Property $record 'payload') 'cwd' } else { Get-Property $record 'cwd' }
                if (Test-InScope $cwd $Workspace) { $inScope = $true; break }
            }
            if (-not $inScope) { continue }
            $prior = $null
            foreach ($wrapped in @($group.Group)) {
                $timestamp = [DateTimeOffset]::MinValue
                if ([DateTimeOffset]::TryParse([string](Get-Property $wrapped.value 'timestamp'), [ref]$timestamp)) {
                    if ($null -ne $prior -and $timestamp -ge $prior) { [void]$deltas.Add(($timestamp - $prior).TotalMilliseconds) }
                    $prior = $timestamp
                }
            }
        }
        $result[$engine] = [pscustomobject]@{ quantity = 'inter-record elapsed time'; observations = $deltas.Count; total_milliseconds = [Math]::Round(($deltas | Measure-Object -Sum).Sum, 3) }
    }
    [pscustomobject]$result
}

function Invoke-Baseline(
    [string]$ClaudeRoot,
    [string]$CodexRoot,
    [string]$ScopeWorkspace,
    [Nullable[DateTimeOffset]]$Cutoff,
    [string]$ReplayManifest,
    [bool]$RawLabels
) {
    $sources = @(Get-SourceRecords $ClaudeRoot $CodexRoot $ReplayManifest)
    $parsed = ConvertTo-Records $sources $Cutoff
    $manifest = @($sources | ForEach-Object { [pscustomobject][ordered]@{ engine = $_.engine; path = $_.path; byte_limit = $_.byte_limit; sha256 = $_.sha256 } })
    [pscustomobject][ordered]@{
        operation = 'Cross-engine token baseline'; status = if ($parsed.issues.Count) { 'ok_with_malformed_lines' } else { 'ok' }
        workspace = [IO.Path]::GetFullPath($ScopeWorkspace); as_of = if ($null -eq $Cutoff) { $null } else { ([DateTimeOffset]$Cutoff).ToUniversalTime().ToString('o') }
        labels = if ($RawLabels) { 'raw_opt_in' } else { 'sanitized' }
        engines = @(
            (Get-ClaudeBaseline $parsed.records $parsed.issues $ScopeWorkspace $RawLabels),
            (Get-CodexBaseline $parsed.records $parsed.issues $ScopeWorkspace $RawLabels)
        )
        inter_record_elapsed = Get-ElapsedSummary $parsed.records $ScopeWorkspace
        parse_issues = @($parsed.issues)
        sources = $manifest
        shared_library_write = $false
    }
}

if ($SelfTest) {
    $checks = [Collections.Generic.List[object]]::new()
    function Assert([string]$Name, [bool]$Condition) { if (-not $Condition) { throw "Get-TokenBaseline self-test failed: $Name" }; [void]$checks.Add([pscustomobject]@{ check = $Name; result = 'pass' }) }
    function Assert-Throws([string]$Name, [scriptblock]$Action) { $threw = $false; try { & $Action } catch { $threw = $true }; Assert $Name $threw }
    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('token-baseline-selftest-' + [guid]::NewGuid().ToString('N'))
    $claudeRoot = Join-Path $fixture 'claude'; $codexRoot = Join-Path $fixture 'codex'; $manifestPath = Join-Path $fixture 'manifest.json'
    New-Item -ItemType Directory -Path $claudeRoot, $codexRoot -Force | Out-Null
    try {
        $claudeUsage = [pscustomobject]@{ input_tokens = 10; cache_creation_input_tokens = 20; cache_read_input_tokens = 30; output_tokens = 5; output_tokens_details = [pscustomobject]@{ thinking_tokens = 2 } }
        $cu = ConvertTo-ClaudeUsage $claudeUsage
        Assert 'Claude cache components are disjoint input components' ($cu.total_input_tokens -eq 60 -and $cu.total_tokens -eq 65 -and $cu.reasoning_output_tokens -eq 2)
        $codexUsage = [pscustomobject]@{ input_tokens = 2527387; cached_input_tokens = 2470000; cache_write_input_tokens = 10000; output_tokens = 21231; reasoning_output_tokens = 5000; total_tokens = 2548618 }
        $xu = ConvertTo-CodexUsage $codexUsage
        Assert 'Codex input and output partition total' ($xu.total_input_tokens + $xu.output_tokens -eq $xu.total_tokens)
        Assert 'Codex nested fields are not added to total' (($xu.total_input_tokens + $xu.output_tokens + $xu.cached_input_tokens + $xu.cache_write_input_tokens + $xu.reasoning_output_tokens) -gt $xu.total_tokens)

        $claudePath = Join-Path $claudeRoot 'session.jsonl'
        $claudeLines = @(
            '{"type":"user","uuid":"u1","parentUuid":null,"promptId":"p1","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:00Z"}',
            '{"type":"user","uuid":"u2","parentUuid":"u1","promptId":"p2","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:01Z"}',
            '{"type":"assistant","uuid":"a1","parentUuid":"u1","requestId":"same","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:02Z","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":5}}}',
            '{"type":"assistant","uuid":"a1-copy","parentUuid":"u1","requestId":"same","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:03Z","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":5}}}',
            '{"type":"assistant","uuid":"a2","parentUuid":"u2","requestId":"conflict","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:04Z","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            '{"type":"assistant","uuid":"a3","parentUuid":"u2","requestId":"conflict","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:05Z","message":{"usage":{"input_tokens":2,"output_tokens":1}}}',
            '{"type":"assistant","uuid":"no-request","parentUuid":"u2","sessionId":"s1","cwd":"D:\\Library","isSidechain":true,"timestamp":"2026-08-25T00:00:06Z","message":{"usage":{"input_tokens":3,"output_tokens":1}}}',
            '{"type":"assistant","uuid":"branch","parentUuid":"u2","requestId":"branch","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:07Z","message":{"usage":{"input_tokens":4,"output_tokens":1}}}',
            '{"type":"assistant","uuid":"skill","parentUuid":"u2","requestId":"skill","sessionId":"s1","cwd":"D:\\Library","attributionSkill":"fixture-skill","timestamp":"2026-08-25T00:00:08Z","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
            '{"type":"custom-title","uuid":"title","sessionId":"s2","cwd":"D:\\Library","customTitle":"Fixture title","timestamp":"2026-08-25T00:00:09Z"}',
            '{"type":"assistant","uuid":"other-session","requestId":"same","sessionId":"s2","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:10Z","message":{"usage":{"input_tokens":6,"output_tokens":1}}}',
            '{"type":"user","uuid":"tool-result","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:11Z","toolUseResult":{"stdout":"ok"}}',
            '{"type":"user","uuid":"unsupported-tool-result","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-25T00:00:12Z","message":{"content":[{"type":"tool_result","content":"legacy"}]}}',
            '{"type":"assistant","uuid":"late","parentUuid":"u2","requestId":"late","sessionId":"s1","cwd":"D:\\Library","timestamp":"2026-08-26T00:00:00Z","message":{"usage":{"input_tokens":99,"output_tokens":1}}}',
            '{"truncated":'
        )
        [IO.File]::WriteAllText($claudePath, ($claudeLines -join "`n"), $script:Utf8)

        $codexPath = Join-Path $codexRoot 'rollout.jsonl'
        $codexLines = @(
            '{"timestamp":"2026-08-25T00:00:00Z","type":"session_meta","payload":{"id":"c1","cwd":"/mnt/d/Library"}}',
            '{"timestamp":"2026-08-25T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}',
            '{"timestamp":"2026-08-25T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"output_tokens":20,"total_tokens":170},"last_token_usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60},"unknown":1}}}',
            '{"timestamp":"2026-08-25T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"output_tokens":2,"total_tokens":22},"last_token_usage":{"input_tokens":20,"output_tokens":2,"total_tokens":22}}}}',
            '{"bad":'
        )
        [IO.File]::WriteAllText($codexPath, ($codexLines -join "`n"), $script:Utf8)

        $cutoff = [DateTimeOffset]'2026-08-25T23:59:59Z'
        $first = Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff '' $false
        $claude = @($first.engines | Where-Object { $_.engine -ceq 'claude' })[0]
        $codex = @($first.engines | Where-Object { $_.engine -ceq 'codex' })[0]
        Assert 'identical Claude duplicates deduplicate by session and request' ($claude.assistant_records -eq 8 -and $claude.deduplicated_requests -eq 6)
        Assert 'the same requestId in another session remains distinct' (@($claude.sessions).Count -eq 2)
        Assert 'conflicting Claude usage is reported and excluded' ($claude.excluded_conflicts -eq 1)
        Assert 'missing requestId falls back to uuid and sidechains stay separate' ($claude.coverage.turns -contains 1 -and $claude.coverage.tier -contains 'sidechain')
        Assert 'parentUuid lineage reaches branched prompt segments' (@($claude.coverage | Where-Object { $_.tier -ceq 'prompt_segment' })[0].turns -eq 2)
        Assert 'attribution skill and session boundary precedence are covered' ($claude.coverage.tier -contains 'attribution_skill' -and $claude.coverage.tier -contains 'session_boundary')
        Assert 'Claude tool-result bytes and unsupported shapes are explicit' ($claude.tool_results.parsed_shapes -eq 1 -and $claude.tool_results.unsupported_shapes -eq 1 -and $claude.tool_results.utf8_bytes -gt 0)
        Assert 'AsOf excludes later records' ($claude.assistant_records -eq 8)
        Assert 'truncated tails are tolerated and reported' ($first.status -ceq 'ok_with_malformed_lines')
        Assert 'unknown fields do not stop parsing' ($codex.sessions.Count -eq 1)
        Assert 'cumulative counters use implicit-zero epoch deltas' ($codex.sessions[0].cumulative_epoch_sum_candidate.total_tokens -eq 192)
        Assert 'counter decrease remains visibly reconciled' ($codex.sessions[0].status -ceq 'reconciled_after_discontinuity')

        [IO.File]::WriteAllText($manifestPath, ([pscustomobject]@{ sources = $first.sources } | ConvertTo-Json -Depth 6), $script:Utf8)
        $replay = Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false
        Assert 'exact replay reproduces engine results' ((Get-HashText ($first.engines | ConvertTo-Json -Compress -Depth 20)) -ceq (Get-HashText ($replay.engines | ConvertTo-Json -Compress -Depth 20)))
        [IO.File]::AppendAllText($claudePath, "`n{`"new`":true}", $script:Utf8)
        $appendedReplay = Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false
        Assert 'replay ignores bytes appended after capture' ($appendedReplay.sources[0].byte_limit -eq $first.sources[0].byte_limit)
        $newFile = Join-Path $claudeRoot 'new.jsonl'; [IO.File]::WriteAllText($newFile, '{}', $script:Utf8)
        Assert 'replay excludes newly created files' ($appendedReplay.sources.path -cnotcontains $newFile)

        $bad = $first.sources | ConvertTo-Json -Depth 6 | ConvertFrom-Json
        @($bad)[0].sha256 = ('0' * 64); [IO.File]::WriteAllText($manifestPath, ([pscustomobject]@{ sources = @($bad) } | ConvertTo-Json -Depth 6), $script:Utf8)
        Assert-Throws 'prefix hash mismatch fails loudly' { Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false }
        @($bad)[0].sha256 = @($first.sources)[0].sha256; @($bad)[0].path = Join-Path $claudeRoot 'missing.jsonl'; [IO.File]::WriteAllText($manifestPath, ([pscustomobject]@{ sources = @($bad) } | ConvertTo-Json -Depth 6), $script:Utf8)
        Assert-Throws 'missing replay source fails loudly' { Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false }
        @($bad)[0].path = $claudePath; @($bad)[0].byte_limit = ([IO.FileInfo]$claudePath).Length + 100; [IO.File]::WriteAllText($manifestPath, ([pscustomobject]@{ sources = @($bad) } | ConvertTo-Json -Depth 6), $script:Utf8)
        Assert-Throws 'shortened replay source fails loudly' { Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false }
        @($bad)[0].path = Join-Path $claudeRoot '..\outside.jsonl'; @($bad)[0].byte_limit = 0; @($bad)[0].sha256 = Get-HashBytes @(); [IO.File]::WriteAllText($manifestPath, ([pscustomobject]@{ sources = @($bad) } | ConvertTo-Json -Depth 6), $script:Utf8)
        Assert-Throws 'manifest containment failure refuses the whole replay' { Invoke-Baseline $claudeRoot $codexRoot 'D:\Library' $cutoff $manifestPath $false }
        Write-LibraryResult -Json:$Json -Result ([pscustomobject][ordered]@{ operation = 'Cross-engine token baseline self-test'; checks = @($checks); passed = $checks.Count; shared_library_write = $false })
        return
    }
    finally { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ([string]::IsNullOrWhiteSpace($CodexSessionsRoot)) { $CodexSessionsRoot = Get-CodexSessionsRoot }
$result = Invoke-Baseline $ClaudeSessionsRoot $CodexSessionsRoot $WorkspacePath $AsOf $SourceManifest ([bool]$IncludeRawLabels)
Write-LibraryResult -Result $result -Json:$Json -Depth 20
