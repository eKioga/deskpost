[CmdletBinding()]
param(
    [string]$Snapshot,
    [string]$Manifest,
    [string]$WorkspacePath,
    [string]$ProjectSlug = 'library-dev',
    [string]$DestinationPage = 'notes/library-dev-history-2026-08-part-2',
    [switch]$SelfTest,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
$script:Utf8 = [Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [Text.UTF8Encoding]::new($false, $true)

function Get-Property([AllowNull()][object]$Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if (@($Object.PSObject.Properties | ForEach-Object { $_.Name }) -ccontains $Name) { return $Object.$Name }
    $null
}

function Normalize-Text([AllowNull()][object]$Text) {
    if ($null -eq $Text) { return '' }
    ([string]$Text).Replace("`r`n", "`n").Replace("`r", "`n")
}

function Get-Hash([string]$Text) {
    Get-HashBytes $script:Utf8.GetBytes($Text)
}

function Get-HashBytes([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function ConvertTo-CanonicalValue([AllowNull()][object]$Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) { $ordered[[string]$key] = ConvertTo-CanonicalValue $Value[$key] }
        return [pscustomobject]$ordered
    }
    if ($Value -is [Collections.IEnumerable]) { return @($Value | ForEach-Object { ConvertTo-CanonicalValue $_ }) }
    $object = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) { $object[$property.Name] = ConvertTo-CanonicalValue $property.Value }
    [pscustomobject]$object
}

function Get-CanonicalHash([AllowNull()][object]$Value) {
    $canonical = ConvertTo-CanonicalValue $Value
    Get-Hash (Normalize-Text ($canonical | ConvertTo-Json -Compress -Depth 32))
}

function ConvertTo-Lines([string]$Text) { @((Normalize-Text $Text).Split("`n")) }

function Get-FencedLineMask([string[]]$Lines) {
    $mask = [bool[]]::new($Lines.Count); $character = ''; $length = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ([string]::IsNullOrEmpty($character)) {
            if ($line -cmatch '^[ ]{0,3}((`{3,}|~{3,}))(.*)$') { $delimiter = $Matches[1]; $character = $delimiter.Substring(0, 1); $length = $delimiter.Length; $mask[$i] = $true }
            continue
        }
        $mask[$i] = $true
        if ($line -cmatch ('^[ ]{0,3}(' + [regex]::Escape($character) + '{' + $length + ',})\s*$')) { $character = ''; $length = 0 }
    }
    $mask
}

function Get-LevelTwoSections([string]$Body) {
    $lines = @(ConvertTo-Lines $Body); $fenced = @(Get-FencedLineMask $lines); $headings = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $lines.Count; $i++) { if (-not $fenced[$i] -and $lines[$i] -cmatch '^##[ \t]+(.+?)[ \t]*$') { [void]$headings.Add([pscustomobject]@{ index = $i; name = $Matches[1] }) } }
    $sections = @{}
    for ($i = 0; $i -lt $headings.Count; $i++) {
        $end = if ($i + 1 -lt $headings.Count) { $headings[$i + 1].index } else { $lines.Count }
        $slice = @($lines[$headings[$i].index..($end - 1)])
        $sections[$headings[$i].name] = ($slice -join "`n").TrimEnd("`n")
    }
    [pscustomobject]@{ lines = $lines; headings = @($headings); sections = $sections; first_heading = if ($headings.Count) { $headings[0].index } else { $lines.Count } }
}

function Get-ItemBlocks([string]$SectionText) {
    $lines = @(ConvertTo-Lines $SectionText)
    if ($lines.Count -gt 0 -and $lines[0] -cmatch '^##[ \t]+') { $lines = if ($lines.Count -gt 1) { @($lines[1..($lines.Count - 1)]) } else { @() } }
    $fenced = @(Get-FencedLineMask $lines); $blocks = [Collections.Generic.List[string]]::new(); $i = 0
    while ($i -lt $lines.Count) {
        if (-not $fenced[$i] -and $lines[$i] -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+') {
            $start = $i; $i++
            while ($i -lt $lines.Count -and ($fenced[$i] -or $lines[$i] -cnotmatch '^(?:[-*+]|[0-9]+\.)[ \t]+')) {
                if ([string]::IsNullOrWhiteSpace($lines[$i])) { break }
                $i++
            }
            [void]$blocks.Add((@($lines[$start..($i - 1)]) -join "`n"))
        } else { $i++ }
    }
    @($blocks)
}

function Get-OpenItems([string]$SectionText) { @(Get-ItemBlocks $SectionText | Where-Object { $_ -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+\[ \](?:[ \t]+|$)' }) }

function Get-OrientationBlocks([string]$SectionText) {
    $lines = @(ConvertTo-Lines $SectionText)
    if ($lines.Count -gt 0) { $lines = @($lines | Select-Object -Skip 1) }
    $fenced = @(Get-FencedLineMask $lines); $blocks = [Collections.Generic.List[string]]::new(); $current = [Collections.Generic.List[string]]::new(); $insideItem = $false
    function Flush-Orientation { if ($current.Count) { [void]$blocks.Add((@($current) -join "`n").TrimEnd()); $current.Clear() } }
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if (-not $fenced[$i] -and $lines[$i] -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+') { Flush-Orientation; $insideItem = $true; continue }
        if ($insideItem) { if ([string]::IsNullOrWhiteSpace($lines[$i])) { $insideItem = $false }; continue }
        if ([string]::IsNullOrWhiteSpace($lines[$i])) { Flush-Orientation; continue }
        [void]$current.Add($lines[$i])
    }
    Flush-Orientation
    @($blocks)
}

function Invoke-ReaderCall([string]$Tool, [hashtable]$Arguments, [string]$Workspace) {
    $adapter = Join-Path $Workspace '.claude/adapters/Validated-BookReader.ps1'
    $requests = @(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hub-migration-acceptance","version":"1.0"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
        ([pscustomobject]@{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = [pscustomobject]@{ name = $Tool; arguments = $Arguments } } | ConvertTo-Json -Compress -Depth 8)
    )
    $out = $requests | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapter 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Validated reader failed: $(($out | Select-Object -Last 4) -join ' | ')" }
    $responses = @($out | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ -and (Get-Property $_ 'id') -eq 2 })
    if ($responses.Count -ne 1) { throw 'Validated reader returned no unique response.' }
    $error = Get-Property $responses[0] 'error'; if ($null -ne $error) { throw "Validated reader refused ${Tool}: $($error.message)" }
    [string]$responses[0].result.content[0].text
}

function Get-ExpectedHash([AllowNull()][object]$Value) {
    $hash = Get-Property $Value 'sha256'
    if ($null -ne $hash) { return [string]$hash }
    Get-CanonicalHash $Value
}

function Assert-InputSchemas([object]$SnapshotData, [object[]]$ManifestData) {
    # The frozen table names nine fields despite calling itself an eight-field schema. Refusing any
    # of the nine named fields would leave one of its required assertions without evidence.
    $requiredSnapshot = @('preamble', 'invariant_sections', 'expected_post', 'orientation_prose', 'open_items', 'desk_overview', 'briefing', 'destination', 'workflow_bytes')
    $snapshotNames = @($SnapshotData.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $requiredSnapshot) { if ($snapshotNames -cnotcontains $name) { throw "Snapshot is missing required field '$name'." } }
    $preamble = Get-Property $SnapshotData 'preamble'
    foreach ($name in @('body', 'sha256', 'excluded_fields')) { if (@($preamble.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains $name) { throw "Snapshot preamble is missing '$name'." } }
    foreach ($section in @('Now', 'Next')) {
        $expected = Get-Property (Get-Property $SnapshotData 'expected_post') $section
        foreach ($name in @('body', 'sha256')) { if (@($expected.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains $name) { throw "Snapshot expected_post.$section is missing '$name'." } }
    }
    foreach ($entry in @((Get-Property $SnapshotData 'orientation_prose'))) {
        foreach ($name in @('body', 'sha256')) { if (@($entry.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains $name) { throw "Snapshot orientation_prose entry is missing '$name'." } }
    }
    $desk = Get-Property $SnapshotData 'desk_overview'
    foreach ($name in @('value', 'sha256')) { if (@($desk.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains $name) { throw "Snapshot desk_overview is missing '$name'." } }
    $briefing = Get-Property $SnapshotData 'briefing'
    foreach ($name in @('body', 'sha256')) { if (@($briefing.PSObject.Properties | ForEach-Object { $_.Name }) -cnotcontains $name) { throw "Snapshot briefing is missing '$name'." } }
    foreach ($item in @($ManifestData)) {
        $names = @($item.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($name in @('source_section', 'source_block', 'destination_pre_count')) { if ($names -cnotcontains $name) { throw "Manifest item is missing '$name'." } }
        if ([int](Get-Property $item 'destination_pre_count') -ne 0) { throw 'Every manifest destination_pre_count must be zero.' }
    }
}

function Invoke-Assertions([object]$SnapshotData, [object[]]$ManifestData, [string]$PageBody, [string]$HistoryBody, [object]$DeskOverview, [string]$Briefing, [AllowNull()][string]$GateSummary) {
    $assertions = [Collections.Generic.List[object]]::new()
    function Check([string]$Name, [bool]$Condition, [string]$Detail) { [void]$assertions.Add([pscustomobject]@{ assertion = $Name; status = if ($Condition) { 'pass' } else { 'fail' }; detail = $Detail }) }
    $parsed = Get-LevelTwoSections $PageBody
    $now = if ($parsed.sections.ContainsKey('Now')) { [string]$parsed.sections['Now'] } else { '' }
    $next = if ($parsed.sections.ContainsKey('Next')) { [string]$parsed.sections['Next'] } else { '' }

    $expectedOpen = Get-Property $SnapshotData 'open_items'
    foreach ($name in @('Now', 'Next')) {
        $expected = @((Get-Property $expectedOpen $name))
        $actual = @(if ($name -ceq 'Now') { Get-OpenItems $now } else { Get-OpenItems $next })
        Check "open_items.$name" ((Get-CanonicalHash $actual) -ceq (Get-CanonicalHash $expected)) "$($actual.Count) ordered open item(s)"
    }
    foreach ($item in @($ManifestData)) {
        $sourceSection = [string](Get-Property $item 'source_section'); $block = Normalize-Text (Get-Property $item 'source_block')
        $sourceText = if ($parsed.sections.ContainsKey($sourceSection)) { [string]$parsed.sections[$sourceSection] } else { '' }
        Check "source_absent.$sourceSection.$((Get-Hash $block).Substring(0,8))" (-not (Normalize-Text $sourceText).Contains($block)) 'manifest block absent from source'
        $count = ([regex]::Matches((Normalize-Text $HistoryBody), [regex]::Escape($block))).Count
        Check "destination_once.$((Get-Hash $block).Substring(0,8))" ($count -eq 1 -and [int](Get-Property $item 'destination_pre_count') -eq 0) "destination count=$count, pre-count=$([int](Get-Property $item 'destination_pre_count'))"
    }

    $preamble = (@($parsed.lines[0..([Math]::Max(0, $parsed.first_heading - 1))]) -join "`n")
    if ($parsed.first_heading -eq 0) { $preamble = '' }
    $preambleExpected = Get-Property $SnapshotData 'preamble'; $preambleBody = Normalize-Text (Get-Property $preambleExpected 'body')
    $preambleValid = (Get-Hash $preambleBody) -ceq [string](Get-Property $preambleExpected 'sha256')
    Check 'preamble' ($preambleValid -and (Normalize-Text $preamble) -ceq $preambleBody) "exact body; excluded fields: $(@((Get-Property $preambleExpected 'excluded_fields')) -join ', ')"
    $invariants = Get-Property $SnapshotData 'invariant_sections'
    # The invariant set is DERIVED from the page, not a fixed list of four names. The spec's fourth
    # name, "Prior implementation", is a shorthand: the Hub's actual heading reads "Prior
    # implementation (backed up, not on the Shelf)". A hard-coded name that resolves to no section
    # fell through to the empty string, hashed it, matched a snapshot that hashed the same empty
    # string, and reported a pass while the whole section went unchecked -- the silent-pass shape
    # this verifier exists to catch, inside the verifier. Every level-two section that is not a
    # migration target is an invariant, and the snapshot must name exactly that set.
    $invariantNames = @(@($parsed.headings | ForEach-Object { [string]$_.name }) | Where-Object { @('Now', 'Next') -cnotcontains $_ })
    $snapshotNames = @($invariants.PSObject.Properties | ForEach-Object { $_.Name })
    Check 'invariant_sections.coverage' ((@($invariantNames | Sort-Object) -join "`n") -ceq (@($snapshotNames | Sort-Object) -join "`n")) "$($invariantNames.Count) section(s): $($invariantNames -join ' | ')"
    foreach ($name in $invariantNames) {
        $actual = Normalize-Text $parsed.sections[$name]
        Check "invariant_sections.$name" ((Get-Hash $actual) -ceq [string](Get-Property $invariants $name)) 'normalized hash'
    }
    $orientationExpected = @((Get-Property $SnapshotData 'orientation_prose'))
    $orientationActual = @(Get-OrientationBlocks $now | ForEach-Object { Get-Hash (Normalize-Text $_) })
    $orientationHashes = @($orientationExpected | ForEach-Object { [string](Get-Property $_ 'sha256') })
    $orientationBodiesValid = @($orientationExpected | Where-Object { (Get-Hash (Normalize-Text (Get-Property $_ 'body'))) -cne [string](Get-Property $_ 'sha256') }).Count -eq 0
    Check 'orientation_prose' ($orientationBodiesValid -and (Get-CanonicalHash $orientationActual) -ceq (Get-CanonicalHash $orientationHashes)) "$($orientationActual.Count) exact non-bullet block(s)"

    $expectedPost = Get-Property $SnapshotData 'expected_post'
    foreach ($name in @('Now', 'Next')) {
        $expectedValue = Get-Property $expectedPost $name; $expectedHash = [string](Get-Property $expectedValue 'sha256'); $expectedBody = Normalize-Text (Get-Property $expectedValue 'body')
        $actual = if ($parsed.sections.ContainsKey($name)) { Normalize-Text $parsed.sections[$name] } else { '' }
        Check "expected_post.$name" ((Get-Hash $expectedBody) -ceq $expectedHash -and $actual -ceq $expectedBody) 'approved normalized section body and hash'
    }

    $destination = Get-Property $SnapshotData 'destination'; $normalizedHistory = Normalize-Text $HistoryBody; $historyBytes = $script:Utf8.GetBytes($normalizedHistory)
    $prefixLength = [int](Get-Property $destination 'byte_length')
    $prefixOkay = $historyBytes.Length -ge $prefixLength
    $prefixHash = if ($prefixOkay) { $prefix = [byte[]]::new($prefixLength); [Array]::Copy($historyBytes, 0, $prefix, 0, $prefixLength); Get-HashBytes $prefix } else { '' }
    Check 'destination_prefix' ($prefixOkay -and $prefixHash -ceq [string](Get-Property $destination 'sha256')) "prefix bytes=$prefixLength"
    $expectedAppend = Normalize-Text (Get-Property $destination 'appended_batch')
    $suffix = if ($prefixOkay) { $script:Utf8.GetString($historyBytes, $prefixLength, $historyBytes.Length - $prefixLength) } else { '' }
    Check 'destination_suffix' ($suffix -ceq $expectedAppend) 'suffix equals approved appended batch'

    $deskExpected = Get-Property $SnapshotData 'desk_overview'; $deskValue = Get-Property $deskExpected 'value'; $deskHash = [string](Get-Property $deskExpected 'sha256')
    Check 'desk_overview' ((Get-CanonicalHash $deskValue) -ceq $deskHash -and (Get-CanonicalHash $DeskOverview) -ceq $deskHash) 'full canonical UTF-8 serialization hash'
    $briefingExpected = Get-Property $SnapshotData 'briefing'; $briefingBody = Normalize-Text (Get-Property $briefingExpected 'body'); $briefingHash = [string](Get-Property $briefingExpected 'sha256')
    Check 'briefing' ((Get-CanonicalHash $briefingBody) -ceq $briefingHash -and (Get-CanonicalHash (Normalize-Text $Briefing)) -ceq $briefingHash) 'full canonical UTF-8 serialization hash'
    if ($null -ne $GateSummary) { Check 'include_shared_gate' ($GateSummary -cmatch '\b0 failed\b') $GateSummary }

    $workflowBefore = Get-Property $SnapshotData 'workflow_bytes'
    $workflowAfter = [pscustomobject][ordered]@{
        desk_overview = $script:Utf8.GetByteCount((ConvertTo-CanonicalValue $DeskOverview | ConvertTo-Json -Compress -Depth 32))
        briefing = $script:Utf8.GetByteCount($Briefing)
        project_page = $script:Utf8.GetByteCount($PageBody)
    }
    [pscustomobject]@{ assertions = @($assertions); workflow_bytes = [pscustomobject]@{ before = $workflowBefore; after = $workflowAfter; after_total = [long]$workflowAfter.desk_overview + [long]$workflowAfter.briefing + [long]$workflowAfter.project_page } }
}

if ($SelfTest) {
    $now = "## Now`n`nStanding prose.`n`n- [ ] Open now"
    $next = "## Next`n`n- [ ] Open next"
    $page = "# Hub`n`n## Purpose`n`nPurpose.`n`n$now`n`n$next`n`n## Connected knowledge`n`nKnowledge.`n`n## Connected tools`n`nTools.`n`n## Prior implementation`n`nPrior."
    $historyPrefix = "# History`n"; $closed = '- [x] Closed'; $history = $historyPrefix + $closed
    $sections = Get-LevelTwoSections $page
    $snapshotData = [pscustomobject][ordered]@{
        preamble = [pscustomobject]@{ body = "# Hub`n"; sha256 = Get-Hash "# Hub`n"; excluded_fields = @() }
        invariant_sections = [pscustomobject][ordered]@{ Purpose = Get-Hash $sections.sections['Purpose']; 'Connected knowledge' = Get-Hash $sections.sections['Connected knowledge']; 'Connected tools' = Get-Hash $sections.sections['Connected tools']; 'Prior implementation' = Get-Hash $sections.sections['Prior implementation'] }
        expected_post = [pscustomobject][ordered]@{ Now = [pscustomobject]@{ body = $sections.sections['Now']; sha256 = Get-Hash $sections.sections['Now'] }; Next = [pscustomobject]@{ body = $sections.sections['Next']; sha256 = Get-Hash $sections.sections['Next'] } }
        orientation_prose = @([pscustomobject]@{ body = 'Standing prose.'; sha256 = Get-Hash 'Standing prose.' })
        open_items = [pscustomobject]@{ Now = @('- [ ] Open now'); Next = @('- [ ] Open next') }
        desk_overview = [pscustomobject]@{ value = [pscustomobject]@{ open = @('library-dev') }; sha256 = Get-CanonicalHash ([pscustomobject]@{ open = @('library-dev') }) }
        briefing = [pscustomobject]@{ body = 'brief'; sha256 = Get-CanonicalHash 'brief' }
        destination = [pscustomobject]@{ byte_length = $script:Utf8.GetByteCount($historyPrefix); sha256 = Get-Hash $historyPrefix; appended_batch = $closed }
        workflow_bytes = [pscustomobject]@{ desk_overview = 1; briefing = 2; project_page = 3 }
    }
    $manifestData = @([pscustomobject]@{ source_section = 'Now'; source_block = $closed; destination_pre_count = 0 })
    Assert-InputSchemas $snapshotData $manifestData
    $tested = Invoke-Assertions $snapshotData $manifestData $page $history ([pscustomobject]@{ open = @('library-dev') }) 'brief' '100 passed, 0 warned, 0 failed, 1 skipped'
    $failures = @($tested.assertions | Where-Object { $_.status -ceq 'fail' })
    if ($failures.Count) { throw "Hub migration acceptance self-test failed: $($failures.assertion -join ', ')" }
    $badPage = $page.Replace('- [ ] Open now', '')
    $negative = Invoke-Assertions $snapshotData $manifestData $badPage $history ([pscustomobject]@{ open = @('library-dev') }) 'brief' '100 passed, 0 warned, 0 failed, 1 skipped'
    if (@($negative.assertions | Where-Object { $_.assertion -ceq 'open_items.Now' -and $_.status -ceq 'fail' }).Count -ne 1) { throw 'Hub migration acceptance self-test did not detect a lost open item.' }
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = 'Hub migration acceptance self-test'; checks = @($tested.assertions).Count + 1; passed = @($tested.assertions).Count + 1; shared_library_write = $false })
    return
}

if ([string]::IsNullOrWhiteSpace($Snapshot) -or [string]::IsNullOrWhiteSpace($Manifest)) { throw 'Snapshot and Manifest are required.' }
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
foreach ($path in @($Snapshot, $Manifest)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Input '$path' does not exist." } }
$snapshotData = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Snapshot), $script:Utf8Strict) | ConvertFrom-Json
$manifestObject = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Manifest), $script:Utf8Strict) | ConvertFrom-Json
$manifestData = if ($null -ne (Get-Property $manifestObject 'items')) { @($manifestObject.items) } else { @($manifestObject) }
Assert-InputSchemas $snapshotData $manifestData
$pageBody = Invoke-ReaderCall 'read_open_project_page' @{ slug = $ProjectSlug; page = '_project' } $workspace
$historyBody = Invoke-ReaderCall 'read_open_project_page' @{ slug = $ProjectSlug; page = $DestinationPage } $workspace
$briefing = Invoke-ReaderCall 'read_open_project_briefing' @{ slug = $ProjectSlug } $workspace
$deskOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-DeskOverview.ps1') -WorkspacePath $workspace -Json 2>&1
if ($LASTEXITCODE -ne 0) { throw "Desk overview failed: $(($deskOut | Select-Object -Last 4) -join ' | ')" }
$deskOverview = (($deskOut | Out-String).Trim() | ConvertFrom-Json)
$gateOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Invoke-LibraryChecks.ps1') -WorkspacePath $workspace -IncludeShared 2>&1
$gateExitCode = $LASTEXITCODE
$gateSummary = @($gateOut | Where-Object { [string]$_ -cmatch '^\d+ passed, \d+ warned, \d+ failed, \d+ skipped$' } | Select-Object -Last 1)
$gateLine = if ($gateSummary.Count) { [string]$gateSummary[0] } else { 'IncludeShared gate produced no summary line.' }
$evaluation = Invoke-Assertions $snapshotData $manifestData $pageBody $historyBody $deskOverview $briefing $gateLine
$failed = @($evaluation.assertions | Where-Object { $_.status -ceq 'fail' })
$result = [pscustomobject][ordered]@{ operation = 'Hub migration acceptance'; status = if ($failed.Count) { 'failed' } else { 'passed' }; assertions = @($evaluation.assertions); workflow_bytes = $evaluation.workflow_bytes; gate_summary = $gateLine; shared_library_write = $false }
Write-LibraryResult -Result $result -Json:$Json -Depth 16
if ($failed.Count -or $gateExitCode -ne 0) { exit 1 }
