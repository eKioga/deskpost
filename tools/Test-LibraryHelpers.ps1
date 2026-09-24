<#
.SYNOPSIS
    Boundary suite for the local-only helpers this iteration touches.

.DESCRIPTION
    Item 0.2 of the plan, local half. Every case runs against a disposable fixture workspace; the
    reader's real Notebook, Shelf, and Desk are never touched, and no NAS call is made.

    Covers Set-VirtualDesk, Reset-LocalNotebook, Invoke-LibraryTriage (validation and the local
    half of its batch state machine), Publish-BookCopy (Shelf destination and offline shared
    preflight), and Import-ExternalWikiToShelf -- including stale and fabricated plan_id,
    destination collisions, refusal without confirmation, and preflight leaving nothing changed.

    Not covered here: confirmed paths that require an MCP endpoint -- Publish-SharedBookCandidate,
    Copy-LocalPagesToProject, Archive-ProjectHub, Archive-SharedBook, and triage's project and book
    kinds. Those are covered by Test-McpHelpers.ps1, the stub-endpoint half of 0.2.
    Add-ShelfNote and triage's capture-Book surface are covered by Test-ShelfNoteBoundary.ps1.
#>
[CmdletBinding()]
param([switch]$KeepFixture)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$passed = 0
$failures = [Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Label) {
    if ($Condition) { $script:passed++ } else { [void]$failures.Add($Label) }
}
function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ("$Expected" -ceq "$Actual") { $script:passed++ } else { [void]$failures.Add("$Label (expected '$Expected', got '$Actual')") }
}
function Assert-Refused([scriptblock]$Body, [string]$Fragment, [string]$Label) {
    try { & $Body | Out-Null; [void]$failures.Add("$Label -- it was allowed") }
    catch {
        if ($_.Exception.Message -match [regex]::Escape($Fragment)) { $script:passed++ }
        else { [void]$failures.Add("$Label -- refused for the wrong reason: $($_.Exception.Message)") }
    }
}

# --- Fixture --------------------------------------------------------------------------------------
# Initialize-ShelfCatalogForFixture and the entry-file API the fixtures write through.
. (Join-Path $PSScriptRoot 'ShelfCatalog.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')
# Fixtures work at a seat named 'fixture'. Set in this process so CHILD helper processes
# inherit it: they default -Seat to LIBRARY_SEAT, and there is no default seat to fall back on.
$env:LIBRARY_SEAT = 'fixture'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ("library-helpers-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
function New-Fixture {
    New-Item -ItemType Directory -Path (Join-Path $fixture '.claude') -Force | Out-Null
    # THROUGH Initialize-SeatForFixture, WHICH REGISTERS THE SEAT AS WELL AS BUILDING ITS DESK
    # (2026-09-10). Composing the Desk directory by hand left a seat with no registry entry, which
    # no production route can produce -- both creation routes write the entry in the same locked
    # transaction -- and reset target selection now refuses an unregistered acting seat, because
    # without an entry its incarnation resolves to '' and would match every pre-identity ownership
    # row. This is the reason that helper exists: a fixture cannot pass against a layout production
    # no longer uses.
    Initialize-SeatForFixture -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Project 'fixture' | Out-Null
    # THE FIXTURE HOLDS ITS SEAT. The helpers driven below are MUTATORS, and a mutator requires a
    # matching live claim token (step 15b). Holding one here is the faithful test rather than an
    # exemption: a fixture that could mutate without a claim would be proving something production
    # cannot do. The handle lives as long as this process, which is what a claim IS -- the suite
    # ending releases it, exactly as a session ending does.
    Enter-FixtureSeatClaim -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/graphics') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/demo/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/curated/wiki/nested') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/metadata-only/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/pending/wiki/notes') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'docs') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'raw/sample') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'output') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'internal') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixture '.claude/.library-project') -Value '00000000-0000-0000-0000-000000000000' -Encoding utf8 -NoNewline
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Value '' -Encoding utf8
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'projects') -Value '' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/_master-index.md') -Value "# Notebook Index`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/graphics/_index.md') -Value "# Graphics`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/graphics/shaders.md') -Value "# Shaders`nBody.`n" -Encoding utf8
    # This topic predates topic ownership, and the reset preflight refuses material no seat claims.
    # That is the day-one behaviour working rather than a fixture defect -- test fixtures are legacy
    # data too. Recorded through the real writer, so a change to the record's shape reaches here.
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'graphics' -Seat 'fixture'
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/_index.md') -Value "# Demo`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/_book.md') -Value "# Curated Fixture`n`n- **Type:** Local copy`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/_index.md') -Value "# Curated Fixture - Reader Map`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/alpha.md') -Value "# Alpha`n`nSee [[sibling]].`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/sibling.md') -Value "# Sibling`n`nLinked body.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/nested/_index.md') -Value "# Nested index`n`nNested navigation.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/curated/wiki/nested/page.md') -Value "# Nested page`n`nNested body.`n" -Encoding utf8
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/curated/wiki/frontmatter-page.md'), "---`ntitle: Source title`ntags: [news]`n---`n`n# Frontmatter page`n`nBody.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/curated/wiki/plain-page.md'), "# Plain page`n`nBody.`n", [Text.UTF8Encoding]::new($false))
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/metadata-only/wiki/_book.md') -Value "# Metadata Only`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/metadata-only/wiki/_index.md') -Value "# Metadata Only - Reader Map`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/pending/wiki/_book.md') -Value "# Fixture Pending`n`n- **Type:** Local copy`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/pending/wiki/_index.md') -Value "# Fixture Pending - Reader Map`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/pending/wiki/notes/2026-08-16-kept.md') -Value "---`ncaptured: 2026-08-16T00:00:00Z`nreview: pending`n---`n`n# Kept note`n`nBody that must survive a rename.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'docs/keep.md') -Value "# Keep me`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'raw/sample/source.md') -Value "# Source`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'output/report.md') -Value "# Report`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'internal/record.json') -Value '{}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'shelf/_catalog.md') -Value @"
# Local Shelf

## Demo
- **Summary:** Fixture Book.
- **Path:** shelf/demo

## Curated Fixture
- **Summary:** Curated fixture Book for shared-publication preflights.
- **Topics:** fixtures, publishing
- **Path:** shelf/curated

## Metadata Only
- **Summary:** Fixture Book with no publishable reader pages.
- **Path:** shelf/metadata-only

## Fixture Pending
- **Summary:** Fixture capture Book.
- **Kind:** capture
- **Path:** shelf/pending
"@ -Encoding utf8
    # Last, once every Book directory and the catalog exist: the split reads the catalog and writes
    # one entry file per Book that is actually on disk.
    Initialize-ShelfCatalogForFixture -FixtureRoot $fixture
}

function Set-FixtureReadOnly([string]$RelativePath, [bool]$ReadOnly) {
    (Get-Item -LiteralPath (Join-Path $fixture $RelativePath) -Force).IsReadOnly = $ReadOnly
}
function Get-FixtureHash([string]$RelativePath) {
    (Get-FileHash -LiteralPath (Join-Path $fixture $RelativePath) -Algorithm SHA256).Hash
}
function Get-TextHash([string]$Text) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($hash.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-MeterSessionsRoot([string]$CaseName) {
    Join-Path $fixture "meter/$CaseName/.codex/sessions"
}
function New-MeterSessionsRoot([string]$CaseName) {
    $root = Get-MeterSessionsRoot -CaseName $CaseName
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $root
}
function Write-MeterRollout([string]$Root, [string]$RelativePath, [string[]]$Lines, [DateTime]$TimestampUtc) {
    $path = Join-Path $Root $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    [IO.File]::WriteAllText($path, ($Lines -join "`r`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::SetLastWriteTimeUtc($path, $TimestampUtc)
    $path
}

try {
    New-Fixture
    $desk = Join-Path $toolsDir 'Set-VirtualDesk.ps1'
    $reset = Join-Path $toolsDir 'Reset-LocalNotebook.ps1'
    $compileRaw = Join-Path $toolsDir 'Compile-RawBatchToNotebook.ps1'
    $triage = Join-Path $toolsDir 'Invoke-LibraryTriage.ps1'
    $publish = Join-Path $toolsDir 'Publish-BookCopy.ps1'
    $removeShelfBook = Join-Path $toolsDir 'Remove-ShelfBook.ps1'
    $import = Join-Path $toolsDir 'Import-ExternalWikiToShelf.ps1'
    $meter = Join-Path $toolsDir 'Get-MeterStatus.ps1'

    # === Get-MeterStatus =========================================================================
    # Case 1: the helper's own parser checks run wholly against a disposable fixture.
    $meterSelfTest = & $meter -SelfTest
    # 7 until 2026-09-08, when two CODEX_HOME resolution cases landed. The exact pin is the point:
    # it caught that change rather than letting two new assertions pass unnoticed, and it is what
    # would report a self-test that quietly stopped running some of its cases.
    Assert-Equal 9 $meterSelfTest.passed 'meter self-test did not run all offline parser checks'

    # Case 2: a complete reading reports both windows, identity, credits, source, and raw/UTC reset.
    $meterRoot = New-MeterSessionsRoot -CaseName 'happy'
    $meterPath = Write-MeterRollout -Root $meterRoot -RelativePath '2026/08/18/rollout-happy.jsonl' -TimestampUtc ([DateTime]::UtcNow.AddMinutes(-20)) -Lines @(
        '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"message","text":"the build spec quoted rate_limits JSON"}}',
        '{"timestamp":"2026-08-12T01:51:46.299Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":19464,"cached_input_tokens":11008,"output_tokens":137},"rate_limits":{"limit_id":"codex","primary":{"used_percent":82.0,"window_minutes":10080,"resets_at":1787245625},"secondary":{"used_percent":15.5,"window_minutes":1440,"resets_at":1787000000},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus"}}}}'
    )
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'ok' $r.status 'a complete meter reading was not reported as ok'
    Assert-Equal 'last_known_from_disk' $r.reading_kind 'the meter reading could be mistaken for live data'
    Assert-True (-not $r.is_live) 'the disk reading claimed to be live'
    Assert-Equal 'codex' $r.limit_id 'the meter lost limit_id'
    Assert-Equal 'plus' $r.plan_type 'the meter lost plan_type'
    Assert-Equal 'False' $r.credits.has_credits 'the meter lost the credits block'
    Assert-True ($r.primary.used_percent -eq 82) 'the meter lost primary used_percent'
    Assert-Equal 10080 $r.primary.window_minutes 'the meter lost primary window_minutes'
    Assert-Equal 1787245625 $r.primary.resets_at 'the meter lost the raw primary reset epoch'
    Assert-Equal '2026-08-20T17:07:05Z' $r.primary.resets_at_utc 'the primary reset UTC conversion is wrong'
    Assert-Equal 15.5 $r.secondary.used_percent 'the meter lost the secondary window'
    Assert-Equal $meterPath $r.source_path 'the meter did not identify its source file'
    Assert-True (-not [string]::IsNullOrWhiteSpace($r.source_timestamp_utc)) 'the meter omitted the source timestamp'

    # Case 3: a null secondary remains explicitly absent while primary still parses.
    $meterRoot = New-MeterSessionsRoot -CaseName 'secondary-null'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-null.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-12T01:51:46.299Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"rate_limits":{"limit_id":"codex","primary":{"used_percent":21,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-True ($null -eq $r.secondary) 'a null secondary was fabricated into a window'
    Assert-Equal 21 $r.primary.used_percent 'a null secondary disturbed the primary window'

    # Case 4: file LastWriteTimeUtc, not enumeration order or filename, decides the newest reading.
    $meterRoot = New-MeterSessionsRoot -CaseName 'newest-file'
    Write-MeterRollout -Root $meterRoot -RelativePath 'z/rollout-newer-name.jsonl' -TimestampUtc ([DateTime]::UtcNow.AddHours(-2)) -Lines @(
        '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"rate_limits":{"limit_id":"old","primary":{"used_percent":11,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"old"}}}}'
    ) | Out-Null
    $newestPath = Write-MeterRollout -Root $meterRoot -RelativePath 'a/rollout-older-name.jsonl' -TimestampUtc ([DateTime]::UtcNow.AddHours(-1)) -Lines @(
        '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2},"rate_limits":{"limit_id":"new","primary":{"used_percent":44,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"new"}}}}'
    )
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 44 $r.primary.used_percent 'the newest rollout file did not win'
    Assert-Equal $newestPath $r.source_path 'the newest rollout source path was wrong'

    # Case 5: within the selected file, the last rate_limits occurrence wins.
    $meterRoot = New-MeterSessionsRoot -CaseName 'last-occurrence'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-last.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}}}',
        '{"timestamp":"2026-08-12T01:50:30.000Z","type":"event_msg","payload":{"type":"message","text":"between token counts"}}',
        '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2},"rate_limits":{"limit_id":"codex","primary":{"used_percent":55,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 55 $r.primary.used_percent 'the last rate_limits occurrence did not win'

    # Case 6: a normal truncated final line degrades the status but preserves the last good reading.
    $meterRoot = New-MeterSessionsRoot -CaseName 'truncated'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-truncated.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"rate_limits":{"limit_id":"codex","primary":{"used_percent":37,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}}}',
        '{"timestamp":"2026-08-12T01:52:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'ok_with_malformed_lines' $r.status 'a truncated line was not disclosed in status'
    Assert-Equal 1 $r.malformed_line_count 'the truncated line was not counted'
    Assert-Equal 37 $r.primary.used_percent 'a truncated line discarded the last good reading'

    # Case 7: no .codex directory returns a shaped, non-throwing result.
    $meterRoot = Get-MeterSessionsRoot -CaseName 'missing-codex'
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'codex_directory_missing' $r.status 'a missing .codex directory had the wrong status'
    Assert-Equal 'last_known_from_disk' $r.reading_kind 'the missing-.codex result lost the staleness warning'

    # Case 8: .codex present but sessions absent is a distinct result.
    $meterRoot = Get-MeterSessionsRoot -CaseName 'missing-sessions'
    New-Item -ItemType Directory -Path (Split-Path -Parent $meterRoot) -Force | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'sessions_directory_missing' $r.status 'a missing sessions directory had the wrong status'

    # Case 9: an existing but empty sessions tree reports zero rollout files.
    $meterRoot = New-MeterSessionsRoot -CaseName 'zero-rollouts'
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'no_rollout_files' $r.status 'zero rollout files had the wrong status'
    Assert-Equal 0 $r.rollout_file_count 'the empty sessions tree reported rollout files'

    # Case 10: valid JSONL with no rate_limits object is distinguished from missing input.
    $meterRoot = New-MeterSessionsRoot -CaseName 'no-rate-limits'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-events.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-12T01:50:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}}}}',
        '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"message","text":"a quoted rate_limits object is only message text"}}',
        '{"timestamp":"2026-08-12T01:52:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":null}}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'no_rate_limits' $r.status 'a rollout without rate_limits had the wrong status'
    Assert-True ($null -eq $r.primary) 'a rollout without rate_limits fabricated a primary reading'

    # Case 11: a top-level rate_limits decoy must not be accepted as a real token-count reading.
    $meterRoot = New-MeterSessionsRoot -CaseName 'top-level-decoy'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-decoy.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-12T01:51:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}}},"rate_limits":{"limit_id":"decoy","primary":{"used_percent":99,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'no_rate_limits' $r.status 'a top-level rate_limits decoy was accepted'
    Assert-True ($null -eq $r.primary) 'a top-level rate_limits decoy fabricated a reading'

    # Case 12: current rollouts may carry rate_limits beside info under the token_count payload.
    $meterRoot = New-MeterSessionsRoot -CaseName 'payload-sibling'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-sibling.jsonl' -TimestampUtc ([DateTime]::UtcNow) -Lines @(
        '{"timestamp":"2026-08-18T14:43:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"last_token_usage":{"input_tokens":1},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":63,"window_minutes":10080,"resets_at":1787245625},"secondary":null,"credits":{"has_credits":false},"plan_type":"plus"}}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-Equal 'ok' $r.status 'the current payload-level rate_limits shape was not accepted'
    Assert-Equal 63 $r.primary.used_percent 'the current payload-level rate_limits reading was lost'

    # Case 13: staleness is computed from and reported alongside the source file timestamp.
    $meterRoot = New-MeterSessionsRoot -CaseName 'staleness'
    Write-MeterRollout -Root $meterRoot -RelativePath 'rollout-stale.jsonl' -TimestampUtc ([DateTime]::UtcNow.AddMinutes(-90)) -Lines @(
        '{"timestamp":"2026-08-12T01:51:46.299Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1},"rate_limits":{"limit_id":"codex","primary":{"used_percent":50,"window_minutes":60,"resets_at":1787245625},"secondary":null,"credits":null,"plan_type":"plus"}}}}'
    ) | Out-Null
    $r = & $meter -SessionsRoot $meterRoot
    Assert-True ($r.reading_age_minutes -ge 89 -and $r.reading_age_minutes -le 92) 'reading_age_minutes was not computed from the source timestamp'
    Assert-True ($r.source_timestamp_utc -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') 'the source timestamp was not ISO-8601 UTC'

    # Case 14: explicit JSON mode remains exactly one schema-versioned object at a process boundary.
    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $meter -SessionsRoot $meterRoot -Json
    Assert-Equal 1 (@($json).Count) 'Get-MeterStatus -Json emitted more than one object'
    $parsedMeter = $json | ConvertFrom-Json
    Assert-Equal 1 $parsedMeter.schema 'Get-MeterStatus -Json omitted the schema version'
    Assert-Equal 'ok' $parsedMeter.status 'Get-MeterStatus -Json lost the reading status'

    # === Set-VirtualDesk ==========================================================================
    $r = & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture
    Assert-Equal 'shelf/demo' ($r.open_books -join ',') 'opening a Shelf Book records its collection root'

    $r = & $desk -Action Open -Slug buzz-self-hosting -WorkspacePath $fixture
    Assert-True ($r.open_books -contains 'books/buzz-self-hosting') 'opening a shared Book records books/<slug>'

    # Opening the same Book twice must not duplicate desk state.
    $r = & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture
    Assert-Equal 2 (@($r.open_books).Count) 'a repeated open did not duplicate the desk entry'

    Assert-Refused { & $desk -Action Open -Location Shelf -Slug missing -WorkspacePath $fixture } 'No Shelf Book' `
        'opening a Shelf slug with no wiki directory was refused'
    Assert-Refused { & $desk -Action Open -Location Shelf -Slug 'Demo' -WorkspacePath $fixture } 'lowercase' `
        'an uppercase slug was refused as a bad slug'

    $r = & $desk -Action Close -Location Shelf -Slug demo -WorkspacePath $fixture
    Assert-True ($r.open_books -notcontains 'shelf/demo') 'closing removed only that Book'
    Assert-True ($r.open_books -contains 'books/buzz-self-hosting') 'closing one Book left the other open'

    # JSON mode must be exactly one parseable object across the process boundary.
    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desk -Action List -WorkspacePath $fixture -Json
    Assert-Equal 1 (@($json).Count) 'Set-VirtualDesk -Json emitted a single line'
    Assert-Equal 1 (($json | ConvertFrom-Json).schema) 'Set-VirtualDesk -Json carried the schema version'

    $r = & $desk -Action Clear -WorkspacePath $fixture
    Assert-Equal 0 (@($r.open_books).Count) 'Clear emptied the open-Book list'
    Assert-Equal 0 (@($r.open_projects).Count) 'Clear emptied the open-Project list'

    # A DESK WRITE MUST NOT ERASE WHICH CONVERSATION IS SITTING AT THE SEAT (2026-09-11).
    # Write-SeatActivity clears the conversation by default, which is right for an ENTRY that started
    # none and therefore cannot name one. Opening a Book is not an entry. Until this was fixed, one
    # open at a launcher-started seat -- which holds no binding to fall back on -- left the picker
    # saying "nothing has recorded a conversation at this seat" about a live session, and refusing to
    # resume it. Observed on a real seat: recorded at 20:05, erased by one open at 20:54.
    $deskConversation = '2f21d1b4-6b8e-4f0a-9a0e-3f6f4b5c7d81'
    Write-SeatActivity -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Note 'seat entered' `
        -Conversation $deskConversation | Out-Null
    & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null
    # SHAPE BEFORE VALUE, ON EVERY FIELD THIS BLOCK READS, because a cleared conversation is an ABSENT
    # field rather than an empty one. Reading one straight off the record turns this defect into a
    # StrictMode PropertyNotFound that names neither the Desk nor the conversation -- and worse,
    # Assert-Equal COLLECTS failures rather than throwing, so the two assertions that correctly fired
    # above were still unreported when the third one killed the run. Measured by reintroducing the
    # defect, which is the only way to see what a check says when it fires.
    $activityField = {
        param($Record, [string]$Field)
        $names = @($Record.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -cnotcontains $Field) { return "<no $Field field: the record was cleared>" }
        [string]$Record.$Field
    }
    $afterOpen = Read-SeatActivity -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture'
    # THE WRITE HAPPENED, asserted before what it kept. Without this the next assertion is satisfied
    # by a Desk that never touched the record at all, and the check would pass for the wrong reason.
    Assert-Equal 'desk open' ([string]$afterOpen.note) 'opening a Book did not rewrite the seat activity record'
    Assert-Equal $deskConversation (& $activityField $afterOpen 'session_id') 'opening a Book erased the conversation sitting at the seat'
    & $desk -Action Close -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null
    $afterClose = Read-SeatActivity -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture'
    Assert-Equal 'desk close' ([string]$afterClose.note) 'closing a Book did not rewrite the seat activity record'
    Assert-Equal $deskConversation (& $activityField $afterClose 'session_id') 'closing a Book erased the conversation sitting at the seat'
    # AND THE ORIGINAL STAMP TRAVELS WITH IT. Re-stamping would make this record look newer than a
    # binding written since, which is the comparison that decides which record is a seat's last.
    # COMPARED AGAINST A REAL STAMP, not against whatever the other side happens to be: two missing
    # fields are equal to each other, and this assertion would then pass in exactly the state the two
    # above it are failing in.
    $carriedStamp = & $activityField $afterOpen 'conversation_recorded_utc'
    Assert-True ($carriedStamp -cmatch '^\d{4}-\d{2}-\d{2}T') "the carried-forward conversation lost its original stamp: $carriedStamp"
    Assert-Equal $carriedStamp (& $activityField $afterClose 'conversation_recorded_utc') 'a Desk write re-stamped the conversation it carried forward'
    & $desk -Action Clear -WorkspacePath $fixture | Out-Null

    # === Reset-LocalNotebook ======================================================================
    & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null

    # The Desk is seeded so the two reset shapes can actually be told apart. With it empty, a helper
    # that clears and a helper that preserves produce identical state and the assertion proves
    # nothing -- which is how the original single assertion passed for either behaviour.
    $deskBooksPath = Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'
    [IO.File]::WriteAllText($deskBooksPath, "shelf/demo`n", [Text.UTF8Encoding]::new($false))

    # A LOOSE FILE, which the preview never used to list while the commit moved it anyway. It is
    # part of the approved set now, so it belongs in the fixture that approves one.
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/stray-note.md'), "# Stray`n", [Text.UTF8Encoding]::new($false))

    # THE CLAIM IS PROBED BEFORE THE PLAN IS ISSUED. Measured on 2026-09-09 with the token blanked:
    # the preflight printed a full quarantine plan naming two topics and no refusal at all, because
    # the step-15b assertion sat below the preflight's `return`. A plan a session cannot execute is
    # worse than no plan -- it is an approval for an operation certain to fail.
    $realClaimToken = $env:LIBRARY_SEAT_CLAIM
    $env:LIBRARY_SEAT_CLAIM = 'not-the-live-token'
    Assert-Refused { & $reset -WorkspacePath $fixture -Preflight } 'does not hold seat' 'the reset preflight was refused to a session holding no claim'
    $env:LIBRARY_SEAT_CLAIM = $realClaimToken

    $r = & $reset -WorkspacePath $fixture -Preflight
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'notebook/graphics/shaders.md')) 'reset preflight changed nothing'
    Assert-True ($r.desk_action -match 'preserved') 'reset preflight did not report the Desk as preserved by default'
    Assert-True (@($r.loose_files_to_quarantine) -ccontains 'stray-note.md') 'the reset preflight did not list the loose file it would move'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$r.plan_id)) 'the reset preflight issued no plan_id'
    $clearPre = & $reset -WorkspacePath $fixture -ClearDesk -Preflight
    Assert-True ($clearPre.desk_action -match 'cleared') 'reset -ClearDesk preflight did not report the Desk as cleared'
    # THE SCOPE SWITCHES ARE IN THE DIGEST, so an approval for one shape cannot execute the other.
    Assert-True ($clearPre.plan_id -cne $r.plan_id) 'the -ClearDesk plan_id matched the Desk-preserving one'
    Assert-True (@(Get-Content -LiteralPath $deskBooksPath | Where-Object { $_.Trim() }).Count -eq 1) 'a preflight changed the Desk'
    Assert-Refused { & $reset -WorkspacePath $fixture } 'confirm' 'reset without -UserConfirmed was refused'
    Assert-Refused { & $reset -WorkspacePath $fixture -UserConfirmed } 'exact plan_id' 'reset without -ApprovedPlanId was refused'
    Assert-Refused { & $reset -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'reset-local-notebook-fabricated' } 'exact plan_id' `
        'reset with a fabricated plan_id was refused'
    Assert-Refused { & $reset -WorkspacePath $fixture -ClearDesk -UserConfirmed -ApprovedPlanId $r.plan_id } 'exact plan_id' `
        'a Desk-preserving approval was refused for a -ClearDesk run'
    # A TOPIC THAT ENTERS THE TARGET SET AFTER THE PREVIEW invalidates the approval rather than being
    # swept in silently -- the exact finding: `-UserConfirmed` alone approved "a reset" and the run
    # then recomputed its own selection. Owned by this seat, so it lands in `targets`: an UNMAPPED
    # topic would refuse for its own reason and would prove nothing about the digest.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/late-topic') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/late-topic/_index.md'), "# Late topic`n", [Text.UTF8Encoding]::new($false))
    Set-NotebookTopicOwner -Workspace $fixture -Topic 'late-topic' -Seat 'fixture' | Out-Null
    Assert-Refused { & $reset -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $r.plan_id } 'exact plan_id' `
        'a stale reset approval was refused after a topic entered the target set'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'notebook/graphics/shaders.md')) 'the stale reset approval moved a topic anyway'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'notebook/late-topic/_index.md')) 'the stale reset approval moved the newly owned topic'
    # A LOOSE FILE THAT APPEARS AFTER THE PREVIEW does the same, which is the half the preview used
    # to be silent about entirely.
    $latePre = & $reset -WorkspacePath $fixture -Preflight
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/late-stray.md'), "# Late stray`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $reset -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $latePre.plan_id } 'exact plan_id' `
        'a stale reset approval was refused after a loose file appeared'
    # Tolerant, because these two cases are falsified by removing the guard -- and without it the
    # reset RUNS and quarantines both. A cleanup that then crashed would replace four named
    # assertion failures with a missing-path error naming this line.
    Remove-Item -LiteralPath (Join-Path $fixture 'notebook/late-stray.md') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $fixture 'notebook/late-topic') -Recurse -Force -ErrorAction SilentlyContinue

    # AND THE TARGET'S INCARNATION IS IN THE DIGEST TOO (2026-09-10), which is the one field a
    # changed target set does not stand in for. Since a slug may now be reused after a retirement,
    # a topic can be re-owned between the preview and the run by a DIFFERENT incarnation of the
    # same seat -- same topic, same slug, and every other field in the digest identical. So both
    # sides move together here: the registry entry gets an incarnation and so does the row, which
    # keeps the topic in `targets` and leaves the incarnation as the only difference. Written the
    # other way first, changing the row alone, and it proved nothing: the row then matched no
    # registered incarnation, dropped out of the target set, and the refusal came from the set
    # changing rather than from the field under test.
    $incarnationPre = & $reset -WorkspacePath $fixture -Preflight
    $incarnationState = Join-Path $fixture '.claude'
    $incarnationLock = Enter-SeatRegistryLock -Workspace $fixture
    try {
        $incarnationRegistry = Read-SeatRegistry -StateDirectory $incarnationState
        Write-SeatRegistry -StateDirectory $incarnationState -Registry ([pscustomobject]@{ schema = 1; seats = @(@($incarnationRegistry.seats) |
            ForEach-Object { if ([string]$_.seat -ceq 'fixture') { [pscustomobject]@{ seat = 'fixture'; project = [string]$_.project; seat_id = 'incarnation-two' } } else { $_ } }) })
    }
    finally { Exit-BookLock -Lock $incarnationLock }
    $incarnationOwnersLock = Enter-NotebookOwnersLock -Workspace $fixture
    try {
        $incarnationOwners = Read-NotebookTopicOwners -Workspace $fixture
        Write-NotebookTopicOwners -Workspace $fixture -Owners ([pscustomobject]@{ schema = 1; topics = @(@($incarnationOwners.topics) |
            ForEach-Object {
                if ([string]$_.scope -cne 'owned') { $_ }
                else { [pscustomobject]@{ topic = [string]$_.topic; scope = 'owned'; seat = [string]$_.seat; project = [string]$_.project; recorded_utc = [string]$_.recorded_utc; seat_id = 'incarnation-two' } }
            }) })
    }
    finally { Exit-BookLock -Lock $incarnationOwnersLock }
    $incarnationPost = & $reset -WorkspacePath $fixture -Preflight
    Assert-True ((@($incarnationPre.topics_to_quarantine) -join ',') -ceq (@($incarnationPost.topics_to_quarantine) -join ',')) `
        'the fixture changed the target SET, so a differing plan_id would prove nothing about the incarnation'
    Assert-True ($incarnationPost.plan_id -cne $incarnationPre.plan_id) 'the reset plan_id did not move when a target changed incarnation'
    Assert-Refused { & $reset -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $incarnationPre.plan_id } 'exact plan_id' `
        'a stale reset approval was accepted after a target topic changed to another incarnation of the same seat'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'notebook/graphics/shaders.md')) 'the stale-incarnation approval moved a topic anyway'

    $r = & $reset -WorkspacePath $fixture -Preflight
    $r = & $reset -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $r.plan_id
    Assert-True (@($r.loose_files_quarantined) -ccontains 'stray-note.md') 'the reset did not report the loose file it moved'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/stray-note.md'))) 'the reset left the loose file in place'
    Assert-True (Test-Path -LiteralPath (Join-Path $r.quarantine_directory 'stray-note.md') -PathType Leaf) 'the loose file was not quarantined beside the topics'
    # The positive control for the unapproved-file report: on an ordinary run it is empty, which is
    # what says the enumeration ran rather than being skipped.
    Assert-Equal 0 @($r.loose_files_left_unapproved).Count 'the reset reported an unapproved loose file on a run that had none'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/graphics'))) 'reset removed the Notebook topic'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'notebook/_master-index.md')) 'reset rebuilt the master index'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'docs/keep.md')) 'reset preserved docs/'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'raw/sample/source.md')) 'reset preserved raw/'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'output/report.md')) 'reset preserved output/'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'internal/record.json')) 'reset preserved internal/'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/_index.md')) 'reset preserved the Shelf'
    # The default is Notebook-only (ADR-0010): an open Book survives a reset it did not ask to clear.
    $books = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') | Where-Object { $_.Trim() })
    Assert-Equal 1 $books.Count 'the default reset cleared the Virtual Desk instead of preserving it'
    # -ccontains, not $books[0]: when an earlier refusal case is falsified away, a -ClearDesk run
    # that should have been refused empties this list, and indexing it replaced every named failure
    # with an IndexOutOfRangeException naming nothing.
    Assert-True (@($books) -ccontains 'shelf/demo') 'the default reset altered the preserved Desk entry'
    Assert-True (-not $r.virtual_desk_cleared) 'the default reset reported virtual_desk_cleared true'
    Assert-True ($r.open_books_after -contains 'shelf/demo') 'the default reset did not read the surviving Desk back'

    # -ClearDesk is still the full Library Reset, and the routing for "start fresh" depends on it.
    $clearPre = & $reset -WorkspacePath $fixture -ClearDesk -Preflight
    $r = & $reset -WorkspacePath $fixture -ClearDesk -UserConfirmed -ApprovedPlanId $clearPre.plan_id
    $books = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') | Where-Object { $_.Trim() })
    Assert-Equal 0 $books.Count 'reset -ClearDesk did not clear the Virtual Desk'
    Assert-True ([bool]$r.virtual_desk_cleared) 'reset -ClearDesk reported virtual_desk_cleared false'

    # === Compile-RawBatchToNotebook ================================================================
    $draftPath = Join-Path $fixture 'docs/compiled-draft.md'
    [IO.File]::WriteAllText($draftPath, "# Compiled finding`n`nConcise synthesis.`n`n## Key Takeaways`n`n- The bounded source supports the finding.`n", [Text.UTF8Encoding]::new($false))
    $placeholder = 'This Notebook is ready for a new topic. Add topic folders here as material is compiled.'
    $masterIndexPath = Join-Path $fixture 'notebook/_master-index.md'
    [IO.File]::WriteAllText($masterIndexPath, "# Notebook Index`n`n$placeholder`n", [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/raw-exercise') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/raw-exercise/_index.md'), "# Raw exercise`n`n$placeholder`n`n## Articles`n", [Text.UTF8Encoding]::new($false))
    $compileArgs = @{
        Batch = 'sample'
        Topic = 'raw-exercise'
        TopicTitle = 'Raw exercise'
        TopicOverview = 'Working knowledge compiled from the named fixture source batch.'
        ArticleSlug = 'finding'
        ContentPath = $draftPath
        SourceFile = @('source.md')
        WorkspacePath = $fixture
    }
    $cpre = & $compileRaw @compileArgs -Preflight
    Assert-True (-not $cpre.confirmation_required) 'a new Notebook article asked for confirmation'
    Assert-Equal 1 $cpre.source_count 'the compile preflight did not bind its exact source file'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'notebook/raw-exercise/finding.md'))) 'compile preflight wrote the article'

    $compiled = & $compileRaw @compileArgs
    Assert-Equal 'complete' $compiled.status 'the additive raw compilation did not complete'
    Assert-True (-not $compiled.shared_library_write) 'raw compilation claimed a shared write'
    $compiledBody = [IO.File]::ReadAllText((Join-Path $fixture 'notebook/raw-exercise/finding.md'))
    Assert-True ($compiledBody.Contains('## Sources')) 'the compiled article has no generated source section'
    Assert-True ($compiledBody.Contains('raw/sample/source.md')) 'the compiled article did not name its exact raw source'
    Assert-True ($compiledBody -cmatch 'SHA-256 `[0-9a-f]{64}`') 'the compiled article did not bind the source hash'
    $topicIndex = [IO.File]::ReadAllText((Join-Path $fixture 'notebook/raw-exercise/_index.md'))
    Assert-True ($topicIndex.Contains('[[finding|Compiled finding]]')) 'the topic index did not link the compiled article'
    Assert-True ($topicIndex.Contains($placeholder)) 'the master-index placeholder sentence was stripped from a topic index'
    # THE MASTER INDEX IS DERIVED, so what it lists is every topic on disk -- not a running append
    # of whatever the last compile happened to touch. The topic already existed here and its H1 was
    # not touched, so the only reason this run rendered at all is that the placeholder paragraph was
    # drift against a topic directory that was already there.
    $expectedMaster = "# Notebook Index`n`n- [[raw-exercise/_index|Raw exercise]]`n"
    $masterAfterFirstCompile = [IO.File]::ReadAllText($masterIndexPath)
    Assert-Equal $expectedMaster $masterAfterFirstCompile 'the first compile did not render the master index from the topics on disk'
    Assert-True (-not $masterAfterFirstCompile.Contains('This Notebook is ready for a new topic.')) 'the first placeholder sentence remained in the master index'
    Assert-True (-not $masterAfterFirstCompile.Contains('Add topic folders here as material is compiled.')) 'the second placeholder sentence remained in the master index'
    Assert-True (-not $compiled.topic_is_new) 'a compile into a pre-existing topic reported a new topic'
    Assert-True ([bool]$compiled.master_index_rendered) 'a compile that repaired a drifted master index did not report rendering it'
    $masterHashAfterFirstCompile = Get-FixtureHash 'notebook/_master-index.md'

    $again = & $compileRaw @compileArgs
    Assert-Equal 'unchanged' $again.status 'an identical raw compilation was not idempotent'
    Assert-Equal $masterHashAfterFirstCompile (Get-FixtureHash 'notebook/_master-index.md') 'an identical compile changed the master-index bytes'
    Assert-Equal 1 ([regex]::Matches([IO.File]::ReadAllText((Join-Path $fixture 'notebook/_master-index.md')), '\[\[raw-exercise/_index\|').Count) 'an identical compile duplicated the master-index link'

    # THE NARROW CRITICAL SECTION, VISIBLE ON THE RESULT. A second article in a topic that already
    # exists, whose H1 nobody edited, changes nothing the master index derives from -- so it must
    # not take the render lock, and PLAN-multi-desk.md D2 is the reason. The process-level proof
    # that this is what really happens is tools/Test-NotebookRenderLock.ps1; this is the contract.
    $secondDraft = Join-Path $fixture 'docs/second-draft.md'
    [IO.File]::WriteAllText($secondDraft, "# Second finding`n`nMore synthesis.`n`n## Key Takeaways`n`n- Also supported.`n", [Text.UTF8Encoding]::new($false))
    $secondArgs = @{} + $compileArgs
    $secondArgs.ArticleSlug = 'second-finding'
    $secondArgs.ContentPath = $secondDraft
    $second = & $compileRaw @secondArgs
    Assert-Equal 'complete' $second.status 'a second article in an existing topic did not complete'
    Assert-True (-not $second.takes_render_lock) 'a compile into an existing topic with an unchanged H1 took the render lock'
    Assert-True (-not $second.master_index_rendered) 'a compile that changed no topic heading rendered the master index anyway'
    Assert-Equal $masterHashAfterFirstCompile (Get-FixtureHash 'notebook/_master-index.md') 'a new article inside an existing topic moved the master index'

    # A TOPIC DIRECTORY WITH NO INDEX IS REFUSED, not added to. This is the state Compile and Triage
    # both used to create, and a compile into it would leave an article beside no index and fail the
    # render for every other topic at the same time.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/headless-topic') -Force | Out-Null
    $headlessArgs = @{} + $compileArgs
    $headlessArgs.Topic = 'headless-topic'
    $headlessArgs.TopicTitle = 'Headless topic'
    $headlessArgs.ArticleSlug = 'headless-finding'
    Assert-Refused { & $compileRaw @headlessArgs } 'exists with no _index.md' 'a compile into a topic directory with no index was allowed'
    Remove-Item -LiteralPath (Join-Path $fixture 'notebook/headless-topic') -Recurse -Force

    [IO.File]::WriteAllText($masterIndexPath, "# Notebook Index`n", [Text.UTF8Encoding]::new($false))
    $plainMasterArgs = @{} + $compileArgs
    $plainMasterArgs.Topic = 'plain-master'
    $plainMasterArgs.TopicTitle = 'Plain master'
    $plainMasterArgs.ArticleSlug = 'plain-finding'
    $plainMaster = & $compileRaw @plainMasterArgs
    Assert-Equal 'complete' $plainMaster.status 'a compile against a master index with no placeholder did not complete'
    Assert-True ([bool]$plainMaster.topic_is_new) 'a compile that created a topic did not report it as new'
    Assert-True ([bool]$plainMaster.takes_render_lock) 'a compile that made a new topic visible did not take the render lock'
    # Both topics, ordered by slug: a new topic joins the derived index rather than replacing what
    # was there, and the order is the renderer's rather than the arrival order of the writers.
    Assert-Equal "# Notebook Index`n`n- [[plain-master/_index|Plain master]]`n- [[raw-exercise/_index|Raw exercise]]`n" ([IO.File]::ReadAllText($masterIndexPath)) `
        'a new topic did not render alongside the existing one in slug order'

    [IO.File]::WriteAllText($draftPath, "# Compiled finding`n`nRevised synthesis.`n`n## Key Takeaways`n`n- Revised.`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $compileRaw @compileArgs } 'Use -ReplaceExisting' 'a divergent article was overwritten without replacement mode'
    $replacePre = & $compileRaw @compileArgs -ReplaceExisting -Preflight
    Assert-True $replacePre.confirmation_required 'a divergent Notebook replacement did not require confirmation'
    Assert-True ($replacePre.plan_id -cmatch '^compile-raw-[0-9a-f]{64}$') 'the replacement preflight returned no content-bound plan_id'
    [IO.File]::WriteAllText((Join-Path $fixture 'raw/sample/source.md'), "# Source`nChanged after approval.`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $compileRaw @compileArgs -ReplaceExisting -UserConfirmed -ApprovedPlanId $replacePre.plan_id } 'does not match current content' `
        'a raw source change after preflight did not invalidate the replacement approval'
    $replaceCurrent = & $compileRaw @compileArgs -ReplaceExisting -Preflight
    $replaced = & $compileRaw @compileArgs -ReplaceExisting -UserConfirmed -ApprovedPlanId $replaceCurrent.plan_id
    Assert-Equal 'complete' $replaced.status 'the approved Notebook replacement did not complete'
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture 'notebook/raw-exercise/finding.md')).Contains('Revised synthesis.')) 'the approved replacement did not land'

    [IO.File]::WriteAllText($draftPath, "# Missing takeaways`n`nBody.`n", [Text.UTF8Encoding]::new($false))
    $badArgs = @{} + $compileArgs
    $badArgs.ArticleSlug = 'missing-takeaways'
    Assert-Refused { & $compileRaw @badArgs } '## Key Takeaways' 'a compiled article without Key Takeaways was accepted'
    [IO.File]::WriteAllText($draftPath, "# Outside source`n`nBody.`n`n## Key Takeaways`n`n- Bounded.`n", [Text.UTF8Encoding]::new($false))
    $outsideArgs = @{} + $compileArgs
    $outsideArgs.ArticleSlug = 'outside-source'
    $outsideArgs.SourceFile = @('../docs/keep.md')
    Assert-Refused { & $compileRaw @outsideArgs } 'relative to the named raw batch' 'a source outside the named raw batch was accepted'

    # === Invoke-LibraryTriage, plan validation ====================================================
    # The reset above removed notebook/graphics, and a plan resolves and hashes its sources on disk
    # rather than taking the reader's word for them. A preflight is pure: it writes no plan record,
    # because the record is what an APPROVED batch leaves behind and a discarded preflight should
    # leave nothing at all.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/triage-src') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage-src/one.md') -Value "# One`nBody.`n" -Encoding utf8

    $good = '[{"kind":"book","source_path":"notebook/triage-src","slug":"graphics","title":"Graphics","summary":"s"}]'
    $r = & $triage -ActionJson $good -WorkspacePath $fixture -Preflight
    Assert-Equal 1 $r.action_count 'a valid triage plan was validated'
    Assert-Equal 'batch' $r.mode 'an -ActionJson call was not treated as a batch'
    Assert-Equal 'True' $r.confirmation_required 'a batch did not require confirmation'
    Assert-Equal 'False' $r.shared_library_write 'a preflight claimed a shared write'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/triage-plans'))) 'a preflight wrote a plan record'
    Assert-True (@(@($r.actions)[0].write_set) -ccontains 'books/graphics/wiki/triage-src/one.md') 'the plan records the canonical write set'
    Assert-True (@(@($r.actions)[0].touch_set) -ccontains 'books/README.md') 'the shared Book Catalog is recorded as a touch, not a create'
    Assert-Equal 0 @(@($r.actions)[0].delete_set).Count 'an additive action declared a delete set'
    Assert-True (-not [string]::IsNullOrWhiteSpace(@($r.actions)[0].action_digest)) 'every action carries a content-bound digest'
    # The source defaults to the Notebook, so every pre-2026-08-28 action shape still validates.
    Assert-Equal 'notebook' @($r.actions)[0].source 'an action with no source field did not default to the Notebook'

    Assert-Refused { & $triage -ActionJson '[{"kind":"leave-local","source_path":"notebook/triage-src","slug":"b","title":"c"}]' -WorkspacePath $fixture -Preflight } 'Unknown triage action kind' `
        'an unknown action kind was refused'
    Assert-Refused { & $triage -ActionJson '[{"kind":"book","slug":"b","title":"c","summary":"s"}]' -WorkspacePath $fixture -Preflight } 'source_path' `
        'an action missing source_path was refused'
    Assert-Refused { & $triage -ActionJson 'not json' -WorkspacePath $fixture -Preflight } 'valid JSON' `
        'malformed plan JSON was refused'
    Assert-Refused { & $triage -ActionJson '[]' -WorkspacePath $fixture -Preflight } 'at least one' `
        'an empty plan was refused'
    Assert-Refused { & $triage -WorkspacePath $fixture -Preflight } 'exactly one surface' `
        'a call naming no surface at all was refused'

    # --- the kind-by-source matrix, refused with its reason rather than as an unknown kind -------
    Assert-Refused { & $triage -ActionJson '[{"kind":"review","source":"notebook","source_path":"notebook/triage-src/one.md"}]' -WorkspacePath $fixture -Preflight } 'no review field' `
        'a review of a Notebook article was refused as an unknown kind rather than for its reason'
    Assert-Refused { & $triage -ActionJson '[{"kind":"discard","source":"notebook","source_path":"notebook/triage-src/one.md"}]' -WorkspacePath $fixture -Preflight } 'quarantines notebook/' `
        'a discard from the Notebook was refused without saying why there is none'
    Assert-Refused { & $triage -ActionJson '[{"kind":"notebook","source":"notebook","source_path":"notebook/triage-src/one.md","topic":"t"}]' -WorkspacePath $fixture -Preflight } 'already in the Notebook' `
        'a notebook action sourced from the Notebook was refused for the wrong reason'
    Assert-Refused { & $triage -ActionJson '[{"kind":"book","source":"sideways","source_path":"notebook/triage-src"}]' -WorkspacePath $fixture -Preflight } 'Unknown triage source' `
        'an unknown source was refused'

    # === Publish-BookCopy, Shelf destination ======================================================
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/topic') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/topic/page.md') -Value "# Page`nBody.`n" -Encoding utf8

    $r = & $publish -Destination Shelf -SourcePath 'notebook/topic' -BookSlug 'fresh' -BookTitle 'Fresh' -Summary 'A fixture Book.' -WorkspacePath $fixture
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/fresh/wiki')) 'a new Shelf Book was created'

    Assert-Refused { & $publish -Destination Shelf -SourcePath 'notebook/topic' -BookSlug 'fresh' -BookTitle 'Fresh' -Summary 's' -WorkspacePath $fixture } 'already exists' `
        'publishing over an existing Shelf Book was refused'
    Assert-Refused { & $publish -Destination Shelf -SourcePath 'notebook/topic' -BookSlug 'Bad_Slug' -BookTitle 'x' -Summary 's' -WorkspacePath $fixture } 'lowercase' `
        'a malformed Book slug was refused'
    # Summary is Mandatory, so the parameter binder refuses an empty string before the script's own
    # check runs. Refused is refused; the message just comes from PowerShell rather than the helper.
    Assert-Refused { & $publish -Destination Shelf -SourcePath 'notebook/topic' -BookSlug 'nosum' -BookTitle 'x' -Summary '' -WorkspacePath $fixture } 'empty string' `
        'publishing without a summary was refused'

    # === Publish-BookCopy, Shelf source to shared preflight =======================================
    # The entire section is preflight-only. It returns before the first MCP call and leaves both
    # the Shelf source and the shared collection untouched.
    $sharedArgs = @{
        Destination = 'Shared'; SourcePath = 'shelf/curated'; FromShelf = $true
        BookSlug = 'curated-shared'; BookTitle = 'Curated Shared'; Summary = 'A shared fixture copy.'
        WorkspacePath = $fixture; Preflight = $true
    }

    Assert-Refused { & $publish @sharedArgs } 'is closed' `
        'a closed Shelf Book reached shared-publication preflight'
    Assert-Refused { & $publish -Destination Shared -SourcePath 'notebook/topic' -FromShelf -BookSlug 'outside-shelf' -BookTitle 'Outside' -Summary 's' -WorkspacePath $fixture -Preflight } 'inside shelf/' `
        '-FromShelf accepted a path outside shelf/'
    Assert-Refused { & $publish -Destination Shared -SourcePath 'shelf/curated/wiki/alpha.md' -FromShelf -BookSlug 'single-shelf-page' -BookTitle 'Single' -Summary 's' -WorkspacePath $fixture -Preflight } 'not a single file' `
        '-FromShelf accepted a single Markdown file'
    Assert-Refused { & $publish -Destination Shared -SourcePath 'shelf/pending' -FromShelf -BookSlug 'capture-shared' -BookTitle 'Capture' -Summary 's' -WorkspacePath $fixture -Preflight } 'capture Book' `
        'a capture Book reached shared-publication preflight'

    & $desk -Action Open -Location Shelf -Slug metadata-only -WorkspacePath $fixture | Out-Null
    Assert-Refused { & $publish -Destination Shared -SourcePath 'shelf/metadata-only' -FromShelf -BookSlug 'metadata-shared' -BookTitle 'Metadata' -Summary 's' -WorkspacePath $fixture -Preflight } 'no publishable Markdown pages' `
        'a Shelf Book containing only generated root pages was accepted'

    & $desk -Action Open -Location Shelf -Slug curated -WorkspacePath $fixture | Out-Null
    $shelfPlan = & $publish @sharedArgs
    $shelfPaths = @($shelfPlan.planned_shared_records | ForEach-Object { $_.path })
    $shelfSources = @($shelfPlan.planned_shared_records | Where-Object { $null -ne $_.source_path } | ForEach-Object { $_.source_path })
    $expectedShelfPaths = @(
        'books/curated-shared/wiki/_book.md',
        'books/curated-shared/wiki/_index.md',
        'books/curated-shared/wiki/alpha.md',
        'books/curated-shared/wiki/frontmatter-page.md',
        'books/curated-shared/wiki/nested/_index.md',
        'books/curated-shared/wiki/nested/page.md',
        'books/curated-shared/wiki/plain-page.md',
        'books/curated-shared/wiki/sibling.md'
    )
    $expectedShelfSources = @(
        'shelf/curated/wiki/alpha.md',
        'shelf/curated/wiki/frontmatter-page.md',
        'shelf/curated/wiki/nested/_index.md',
        'shelf/curated/wiki/nested/page.md',
        'shelf/curated/wiki/plain-page.md',
        'shelf/curated/wiki/sibling.md'
    )
    Assert-Equal ($expectedShelfPaths -join ',') ($shelfPaths -join ',') 'Shelf preflight planned the wrong shared paths'
    Assert-Equal ($expectedShelfSources -join ',') ($shelfSources -join ',') 'Shelf preflight selected the wrong source pages'
    Assert-Equal 6 $shelfPlan.source_file_count 'Shelf preflight counted generated root pages as sources'
    Assert-Equal 1 $shelfPlan.frontmatter_page_count 'Shelf preflight counted the wrong frontmattered source pages'
    Assert-True ($shelfPaths -ccontains 'books/curated-shared/wiki/nested/_index.md') 'a nested _index.md was excluded from the source set'
    Assert-True (-not ($shelfPaths -cmatch '/wiki/wiki/')) 'Shelf preflight added a second wiki directory'
    Assert-True ($shelfPlan.plan_id -clike 'shelf-copy-*') 'Shelf preflight did not use the shelf-copy plan_id namespace'
    Assert-Equal 'shelf/curated/wiki' $shelfPlan.source 'Shelf preflight reported the wrong source boundary'
    Assert-Equal 'True' $shelfPlan.local_original_preserved 'Shelf preflight did not promise to preserve the local Book'

    $wikiArgs = @{} + $sharedArgs
    $wikiArgs.SourcePath = 'shelf/curated/wiki'
    $wikiPlan = & $publish @wikiArgs
    Assert-Equal ($shelfPlan | ConvertTo-Json -Compress -Depth 8) ($wikiPlan | ConvertTo-Json -Compress -Depth 8) `
        'shelf/<slug> and shelf/<slug>/wiki produced different plans'

    $subsetArgs = @{} + $sharedArgs
    $subsetArgs.IncludePage = @('alpha.md')
    Assert-Refused { & $publish @subsetArgs } 'omitted local page' `
        '-IncludePage allowed a selected Shelf page to link to an omitted sibling'

    # A curated Shelf Book is published whole with -FromShelf. Since 2026-08-28 one root under
    # shelf/ IS publishable directly -- a capture Book's wiki/notes/<file>.md, so a Holding Shelf
    # finding can become a shared Book without detouring through the Notebook -- so the refusal now
    # names the shape it does accept instead of only naming notebook/.
    Assert-Refused { & $publish -Destination Shared -SourcePath 'shelf/curated' -BookSlug 'legacy-boundary' -BookTitle 'Legacy' -Summary 's' -WorkspacePath $fixture -Preflight } 'is not one note in a capture Book' `
        'a curated Shelf path was accepted without -FromShelf'
    Assert-Refused { & $publish -Destination Shared -SourcePath 'shelf/curated/wiki/notes/nope.md' -BookSlug 'legacy-boundary' -BookTitle 'Legacy' -Summary 's' -WorkspacePath $fixture -Preflight } 'not capture-enabled' `
        'a notes/ path under a CURATED Book was accepted as a capture note'

    # === Publish-BookCopy, frontmatter round-trip preflight =======================================
    $frontmatterRecord = @($shelfPlan.planned_shared_records | Where-Object { $_.source_path -ceq 'shelf/curated/wiki/frontmatter-page.md' })[0]
    $plainRecord = @($shelfPlan.planned_shared_records | Where-Object { $_.source_path -ceq 'shelf/curated/wiki/plain-page.md' })[0]
    $frontmatterBodyHash = Get-TextHash "# Frontmatter page`n`nBody."
    $frontmatterWholeHash = (Get-FixtureHash 'shelf/curated/wiki/frontmatter-page.md').ToLowerInvariant()
    Assert-Equal $frontmatterBodyHash $frontmatterRecord.sha256 'a frontmattered page was not hashed over its body alone'
    Assert-True ($frontmatterRecord.sha256 -cne $frontmatterWholeHash) 'a frontmattered page hash still covered the whole file'
    Assert-Equal ((Get-FixtureHash 'shelf/curated/wiki/plain-page.md').ToLowerInvariant()) $plainRecord.sha256 `
        'a frontmatterless page hash changed from the whole-file hash'

    $ordinaryArgs = @{} + $sharedArgs
    $ordinaryArgs.IncludePage = @('frontmatter-page.md')
    $ordinaryPlan = & $publish @ordinaryArgs
    Assert-Equal 1 $ordinaryPlan.source_file_count 'a conventional frontmatter separator blank line was refused'

    $noTrailingNewlinePath = Join-Path $fixture 'shelf/curated/wiki/frontmatter-no-trailing-newline.md'
    [IO.File]::WriteAllText($noTrailingNewlinePath, "---`ntitle: No trailing newline`n---`n`n# Frontmatter page`n`nBody.", [Text.UTF8Encoding]::new($false))
    $noTrailingNewlineArgs = @{} + $sharedArgs
    $noTrailingNewlineArgs.IncludePage = @('frontmatter-no-trailing-newline.md')
    $noTrailingNewlinePlan = & $publish @noTrailingNewlineArgs
    $noTrailingNewlineRecord = @($noTrailingNewlinePlan.planned_shared_records | Where-Object { $null -ne $_.source_path })[0]
    Assert-Equal $frontmatterRecord.sha256 $noTrailingNewlineRecord.sha256 'one trailing newline changed the trimmed frontmatter body hash'

    $severalBlankPath = Join-Path $fixture 'shelf/curated/wiki/frontmatter-several-blanks.md'
    [IO.File]::WriteAllText($severalBlankPath, "---`ntitle: Several blanks`n---`n`n`n`n# Frontmatter page`n`nBody.`n", [Text.UTF8Encoding]::new($false))
    $severalBlankArgs = @{} + $sharedArgs
    $severalBlankArgs.IncludePage = @('frontmatter-several-blanks.md')
    $severalBlankPlan = & $publish @severalBlankArgs
    $severalBlankRecord = @($severalBlankPlan.planned_shared_records | Where-Object { $null -ne $_.source_path })[0]
    Assert-Equal 1 $severalBlankPlan.source_file_count 'several frontmatter separator blank lines were refused'
    Assert-Equal $frontmatterRecord.sha256 $severalBlankRecord.sha256 'separator blank-line count changed the trimmed body hash'

    $severalTrailingNewlinesPath = Join-Path $fixture 'shelf/curated/wiki/frontmatter-several-trailing-newlines.md'
    [IO.File]::WriteAllText($severalTrailingNewlinesPath, "---`ntitle: Several trailing newlines`n---`n`n# Frontmatter page`n`nBody.`n`n`n", [Text.UTF8Encoding]::new($false))
    $severalTrailingNewlinesArgs = @{} + $sharedArgs
    $severalTrailingNewlinesArgs.IncludePage = @('frontmatter-several-trailing-newlines.md')
    $severalTrailingNewlinesPlan = & $publish @severalTrailingNewlinesArgs
    $severalTrailingNewlinesRecord = @($severalTrailingNewlinesPlan.planned_shared_records | Where-Object { $null -ne $_.source_path })[0]
    Assert-Equal $noTrailingNewlineRecord.sha256 $severalTrailingNewlinesRecord.sha256 'several trailing newlines changed the trimmed frontmatter body hash'

    $emptyBodyPath = Join-Path $fixture 'shelf/curated/wiki/frontmatter-empty-body.md'
    [IO.File]::WriteAllText($emptyBodyPath, "---`ntitle: Empty body`n---`n", [Text.UTF8Encoding]::new($false))
    $emptyBodyArgs = @{} + $sharedArgs
    $emptyBodyArgs.IncludePage = @('frontmatter-empty-body.md')
    Assert-Refused { & $publish @emptyBodyArgs } "Source page '$emptyBodyPath' has frontmatter but no body." `
        'an empty frontmattered page was not refused with the file-specific message'

    $blankOnlyBodyPath = Join-Path $fixture 'shelf/curated/wiki/frontmatter-blank-only-body.md'
    [IO.File]::WriteAllText($blankOnlyBodyPath, "---`ntitle: Blank-only body`n---`n`n`n`n", [Text.UTF8Encoding]::new($false))
    $blankOnlyBodyArgs = @{} + $sharedArgs
    $blankOnlyBodyArgs.IncludePage = @('frontmatter-blank-only-body.md')
    Assert-Refused { & $publish @blankOnlyBodyArgs } "Source page '$blankOnlyBodyPath' has frontmatter but no body." `
        'a blank-only frontmattered page was not refused with the file-specific message'

    $frontmatterlessBlankPath = Join-Path $fixture 'shelf/curated/wiki/frontmatterless-blank-body.md'
    [IO.File]::WriteAllText($frontmatterlessBlankPath, "`n# Refuse me`n", [Text.UTF8Encoding]::new($false))
    $frontmatterlessBlankArgs = @{} + $sharedArgs
    $frontmatterlessBlankArgs.IncludePage = @('frontmatterless-blank-body.md')
    Assert-Refused { & $publish @frontmatterlessBlankArgs } 'starts with a blank line' `
        'a frontmatterless page starting with a blank line was accepted'

    $unterminatedPath = Join-Path $fixture 'shelf/curated/wiki/unterminated-frontmatter.md'
    $unterminatedContent = "---`ntitle: Never closed`n`n# Still body`n"
    [IO.File]::WriteAllText($unterminatedPath, $unterminatedContent, [Text.UTF8Encoding]::new($false))
    $unterminatedArgs = @{} + $sharedArgs
    $unterminatedArgs.IncludePage = @('unterminated-frontmatter.md')
    $unterminatedPlan = & $publish @unterminatedArgs
    $unterminatedRecord = @($unterminatedPlan.planned_shared_records | Where-Object { $null -ne $_.source_path })[0]
    Assert-Equal 0 $unterminatedPlan.frontmatter_page_count 'an unterminated opening fence was counted as frontmatter'
    Assert-Equal (Get-TextHash $unterminatedContent) $unterminatedRecord.sha256 'an unterminated opening fence was not hashed as body'

    $horizontalRulePath = Join-Path $fixture 'shelf/curated/wiki/horizontal-rule.md'
    $horizontalRuleContent = "# Before`n`n---`n`n# After`n"
    [IO.File]::WriteAllText($horizontalRulePath, $horizontalRuleContent, [Text.UTF8Encoding]::new($false))
    $horizontalRuleArgs = @{} + $sharedArgs
    $horizontalRuleArgs.IncludePage = @('horizontal-rule.md')
    $horizontalRulePlan = & $publish @horizontalRuleArgs
    $horizontalRuleRecord = @($horizontalRulePlan.planned_shared_records | Where-Object { $null -ne $_.source_path })[0]
    Assert-Equal 0 $horizontalRulePlan.frontmatter_page_count 'a mid-page horizontal rule was counted as frontmatter'
    Assert-Equal (Get-TextHash $horizontalRuleContent) $horizontalRuleRecord.sha256 'a mid-page horizontal rule changed the whole-file hash'

    $lfFrontmatter = "---`ntitle: Line endings`n---`n`n# Same body`n`nText.`n"
    $crlfFrontmatter = $lfFrontmatter.Replace("`n", "`r`n")
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/curated/wiki/frontmatter-lf.md'), $lfFrontmatter, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'shelf/curated/wiki/frontmatter-crlf.md'), $crlfFrontmatter, [Text.UTF8Encoding]::new($false))
    $lineEndingArgs = @{} + $sharedArgs
    $lineEndingArgs.IncludePage = @('frontmatter-lf.md', 'frontmatter-crlf.md')
    $lineEndingPlan = & $publish @lineEndingArgs
    $lineEndingHashes = @($lineEndingPlan.planned_shared_records | Where-Object { $null -ne $_.source_path } | ForEach-Object { $_.sha256 })
    Assert-Equal 2 $lineEndingPlan.frontmatter_page_count 'the CRLF and LF frontmatter twins were not both counted'
    Assert-Equal $lineEndingHashes[0] $lineEndingHashes[1] 'CRLF and LF frontmattered pages produced different body hashes'

    # Fixed no-BOM input and fixed hashes make this a snapshot of the pre-existing Notebook plan,
    # not a second calculation that could drift with the implementation under test.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/shared-regression/nested') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/shared-regression/page.md'), "# Page`nBody.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'notebook/shared-regression/nested/two.md'), "# Two`nSecond.`n", [Text.UTF8Encoding]::new($false))
    $notebookPlan = & $publish -Destination Shared -SourcePath 'notebook/shared-regression' -BookSlug 'notebook-regression' -BookTitle 'Notebook Regression' -Summary 'Fixed summary.' -WorkspacePath $fixture -Preflight
    $expectedNotebookPaths = @(
        'books/notebook-regression/wiki/_book.md',
        'books/notebook-regression/wiki/_index.md',
        'books/notebook-regression/wiki/shared-regression/nested/two.md',
        'books/notebook-regression/wiki/shared-regression/page.md'
    )
    # The _index.md hash moved on 2026-09-18 when reader-map labels became page titles, and it is
    # the ONLY one of the four that moved -- the two page records and _book.md are unchanged,
    # which is what bounds that change to the map. The new value was not copied out of the run:
    # it is SHA-256 over the reader map this publisher is supposed to emit, composed by hand from
    # the two fixture H1s ('Two', 'Page') and confirmed to equal what the helper produced.
    $expectedNotebookHashes = @(
        '9b27917236aded47397cd08b3da2bd857fb06ff76ddb46aa90a2488381117f2f',
        '5cc0ec6f1121b674cfa713f433ba77f197b1833b045757e8e09a5ec272bfad4f',
        '3df8d01243384fd03a88e02d7cb57103a72d372bfde8b390f9fb0bbdb2b109b2',
        '03fb79f0f8b79c266e375058adf52222a5abfe592e5aa4eadd55e939532619ed'
    )
    Assert-Equal ($expectedNotebookPaths -join ',') (@($notebookPlan.planned_shared_records | ForEach-Object { $_.path }) -join ',') 'the Notebook plan path mapping changed'
    Assert-Equal ($expectedNotebookHashes -join ',') (@($notebookPlan.planned_shared_records | ForEach-Object { $_.sha256 }) -join ',') 'the Notebook record hashes changed'
    Assert-Equal 'notebook/shared-regression/nested/two.md,notebook/shared-regression/page.md' (@($notebookPlan.include_pages) -join ',') 'the Notebook plan source labels changed'
    Assert-Equal '78af985688adf402671d8456e0f3f50fa1c3b5c3f259632a0b5716267e2a1785' $notebookPlan.source_digest_sha256 'the Notebook source digest changed'
    Assert-Equal 'e91529b1a63fe910948b08cf26f3a2cd28265e2417ee92dd3d9e628b34ddca81' $notebookPlan.page_manifest_sha256 'the Notebook manifest digest changed'
    Assert-Equal 'local-copy-78af985688adf402671d8456e0f3f50fa1c3b5c3f259632a0b5716267e2a1785-e91529b1a63fe910948b08cf26f3a2cd28265e2417ee92dd3d9e628b34ddca81' $notebookPlan.plan_id 'the Notebook plan identity changed'
    Assert-Equal 0 $notebookPlan.frontmatter_page_count 'the frontmatterless Notebook regression gained frontmatter exposure'

    # === Import-ExternalWikiToShelf ===============================================================
    $srcWiki = Join-Path $fixture 'external/wiki'
    New-Item -ItemType Directory -Path $srcWiki -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $srcWiki 'alpha.md') -Value "# Alpha`nAlpha body.`n" -Encoding utf8

    $pre = & $import -SourceWikiPath $srcWiki -BookSlug 'imported' -BookTitle 'Imported' -Summary 'From a fixture wiki.' -WorkspacePath $fixture -Preflight
    Assert-True (-not [string]::IsNullOrWhiteSpace($pre.plan_id)) 'import preflight returned a plan_id'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/imported'))) 'import preflight created nothing'

    Assert-Refused { & $import -SourceWikiPath $srcWiki -BookSlug 'imported' -BookTitle 'Imported' -Summary 's' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'fabricated-plan-id' } 'plan' `
        'import with a fabricated plan_id was refused'
    Assert-Refused { & $import -SourceWikiPath $srcWiki -BookSlug 'imported' -BookTitle 'Imported' -Summary 's' -WorkspacePath $fixture -ApprovedPlanId $pre.plan_id } 'confirm' `
        'import without -UserConfirmed was refused'

    $done = & $import -SourceWikiPath $srcWiki -BookSlug 'imported' -BookTitle 'Imported' -Summary 'From a fixture wiki.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/imported/wiki')) 'a confirmed import created the Shelf Book'

    Assert-Refused { & $import -SourceWikiPath $srcWiki -BookSlug 'imported' -BookTitle 'Imported' -Summary 's' -WorkspacePath $fixture -Preflight } 'exists' `
        'importing over an existing Shelf Book was refused'

    # The source workspace is read-only throughout.
    Assert-True (Test-Path -LiteralPath (Join-Path $srcWiki 'alpha.md')) 'the source wiki was left intact'

    # === Reader-map labels are page titles, not page paths ========================================
    # Five writers built a Book's reader map by labelling each link with the page PATH, so every map
    # read as a file listing while the Discovery manifest for the same page already held its title:
    # `page-title: jellyfin -- Jellyfin` against a map saying `jellyfin.md`. These cases drive the two
    # publishers that run offline. The third, Publish-SharedBookCandidate, needs MCP and is covered by
    # books.reader-map-labels-are-titles reading its source instead.
    #
    # EVERY FIXTURE TITLE DIFFERS FROM ITS FILENAME BY MORE THAN THE EXTENSION, deliberately. A page
    # named `page.md` and titled `Page` cannot tell a writer that reads the H1 from one that merely
    # strips `.md`, and both were plausible fixes.
    $mapSrc = Join-Path $fixture 'notebook/map-labels'
    New-Item -ItemType Directory -Path (Join-Path $mapSrc 'nested') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $mapSrc 'hosts-and-roles.md') -Value "# Hosts and Roles`nBody.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $mapSrc 'nested/deep-page.md') -Value "# A Page Further In`nBody.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $mapSrc 'no-heading.md') -Value "Body with no heading at all.`n" -Encoding utf8

    & $publish -Destination Shelf -SourcePath 'notebook/map-labels' -BookSlug 'map-labels' -BookTitle 'Map Labels' -Summary 'A reader-map label fixture.' -WorkspacePath $fixture | Out-Null
    $publishedMap = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/map-labels/wiki/_index.md'))
    Assert-True ($publishedMap.Contains('|Hosts and Roles]]')) 'a copied Book labels a page with its H1'
    Assert-True ($publishedMap.Contains('|A Page Further In]]')) 'a copied Book labels a nested page with its H1'
    Assert-True (-not $publishedMap.Contains('.md]]')) 'no copied-Book reader-map label is a filename'
    # The no-H1 fallback is the path without its extension, never the empty string the manifest
    # stores for that same page -- an empty label renders as a link with nothing to click.
    Assert-True ($publishedMap.Contains('|map-labels/no-heading]]')) 'a page with no H1 falls back to its path without the extension'

    $mapWiki = Join-Path $fixture 'external/map-wiki'
    New-Item -ItemType Directory -Path $mapWiki -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $mapWiki 'sync-and-backup.md') -Value "# Sync, Annex and Backup`nBody.`n" -Encoding utf8
    $mapPre = & $import -SourceWikiPath $mapWiki -BookSlug 'map-import' -BookTitle 'Map Import' -Summary 'A reader-map label fixture.' -WorkspacePath $fixture -Preflight
    & $import -SourceWikiPath $mapWiki -BookSlug 'map-import' -BookTitle 'Map Import' -Summary 'A reader-map label fixture.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $mapPre.plan_id | Out-Null
    $importedMap = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/map-import/wiki/_index.md'))
    Assert-True ($importedMap.Contains('|Sync, Annex and Backup]]')) 'an imported wiki labels a page with its H1'
    Assert-True (-not $importedMap.Contains('.md]]')) 'no imported-wiki reader-map label is a filename'

    # === Rename-ShelfBook =========================================================================
    # A rename is a destructive Shelf writer: it moves the directory holding the reader's only copy
    # of unvetted material. Every case below therefore checks two things -- that the refusal or the
    # failure happened, and that the note came through byte-identical.
    $rename = Join-Path $toolsDir 'Rename-ShelfBook.ps1'
    $notePage = 'shelf/pending/wiki/notes/2026-08-16-kept.md'
    $renamedNotePage = 'shelf/holding/wiki/notes/2026-08-16-kept.md'

    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'Holding' -WorkspacePath $fixture -Preflight } 'lowercase' `
        'an uppercase NewSlug was refused as a bad slug'
    Assert-Refused { & $rename -Slug 'not-listed' -NewSlug 'holding' -WorkspacePath $fixture -Preflight } 'is listed in shelf/_catalog.md' `
        'renaming a Book absent from the catalog was refused'
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'demo' -WorkspacePath $fixture -Preflight } 'already exists' `
        'a destination collision was refused before a plan_id was issued'
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'pending' -WorkspacePath $fixture -Preflight } 'nothing to rename' `
        'a no-op rename was refused'

    $pre = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -Preflight
    Assert-True (-not [string]::IsNullOrWhiteSpace($pre.plan_id)) 'rename preflight returned a plan_id'
    Assert-True ($pre.confirmation_required -eq $true) 'rename preflight declared a confirmation is required'
    Assert-Equal 'capture' $pre.kind 'rename preflight identified the capture Book'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending/wiki')) 'rename preflight moved nothing'
    Assert-True ($pre.desk_state_action -match 'not open') 'rename preflight reported the Book as closed'

    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -ApprovedPlanId $pre.plan_id } 'rerun with -UserConfirmed' `
        'rename without -UserConfirmed was refused'
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'rename-shelf-book-0000' } 'exact plan_id' `
        'rename with a fabricated plan_id was refused'

    # A note edited after approval invalidates it: the plan_id covers every page hash.
    Add-Content -LiteralPath (Join-Path $fixture $notePage) -Value 'Edited after approval.' -Encoding utf8
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id } 'exact plan_id' `
        'a plan_id went stale when a note changed'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending/wiki')) 'the Book moved despite a stale plan_id'

    $noteHash = Get-FixtureHash $notePage
    $catalogBefore = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/_catalog.md'))
    $bookPageBefore = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/pending/wiki/_book.md'))
    $mapBefore = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/pending/wiki/_index.md'))

    # --- Fault injection: fail after each mutation and prove the rollback -------------------------
    # A read-only file makes the very next write throw, which is the one seam that needs no
    # test-only surface in the helper. Each case fails one step later than the last.

    # 1. Fail at the catalog rewrite, immediately after the directory move.
    Set-FixtureReadOnly 'shelf/_catalog.md' $true
    $pre = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -Preflight
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id } 'Rollback: complete and verified' `
        'a failed catalog write rolled back and said so'
    Set-FixtureReadOnly 'shelf/_catalog.md' $false
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending/wiki')) 'the Book directory was moved back after a failed catalog write'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/holding'))) 'the new Book root survived rollback'
    Assert-Equal $noteHash (Get-FixtureHash $notePage) 'the note survived a failed catalog write byte-identical'
    Assert-Equal $catalogBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/_catalog.md'))) 'the catalog was restored'

    # 2. Fail at the _book.md title rewrite, after the catalog was already changed.
    Set-FixtureReadOnly 'shelf/pending/wiki/_book.md' $true
    $pre = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -Preflight
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id } 'Rollback: complete and verified' `
        'a failed title-page write rolled back and said so'
    Set-FixtureReadOnly 'shelf/pending/wiki/_book.md' $false
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending/wiki')) 'the Book directory was moved back after a failed title write'
    Assert-Equal $catalogBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/_catalog.md'))) 'a catalog rewrite was undone when a later step failed'
    Assert-Equal $bookPageBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/pending/wiki/_book.md'))) 'the Book page was restored'
    Assert-Equal $noteHash (Get-FixtureHash $notePage) 'the note survived a failed title write byte-identical'

    # 3. Fail at the Desk-state rewrite, after the catalog, the title page, and the reader map.
    & $desk -Action Open -Location Shelf -Slug pending -WorkspacePath $fixture | Out-Null
    $deskBefore = [IO.File]::ReadAllText((Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'))
    Set-FixtureReadOnly (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') $true
    $pre = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -Preflight
    Assert-True ($pre.desk_state_action -match 'seat') 'rename preflight reported that a seat''s Desk will be rewritten'
    Assert-True ($pre.desk_state_action -match 'fixture') 'rename preflight NAMED the seat holding the Book, which is what the reader approves'
    Assert-Refused { & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id } 'Rollback: complete and verified' `
        'a failed Desk-state write rolled back and said so'
    Set-FixtureReadOnly (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') $false
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending/wiki')) 'the Book directory was moved back after a failed Desk write'
    Assert-Equal $catalogBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/_catalog.md'))) 'the catalog was restored after a failed Desk write'
    Assert-Equal $bookPageBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/pending/wiki/_book.md'))) 'the Book page was restored after a failed Desk write'
    Assert-Equal $mapBefore ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/pending/wiki/_index.md'))) 'a regenerated reader map was restored'
    Assert-Equal $deskBefore ([IO.File]::ReadAllText((Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books'))) 'the Desk state was left as it was'
    Assert-Equal $noteHash (Get-FixtureHash $notePage) 'the note survived a failed Desk write byte-identical'

    # --- The rename that succeeds ------------------------------------------------------------------
    $pre = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -Preflight
    $done = & $rename -Slug 'pending' -NewSlug 'holding' -NewTitle 'Holding Shelf' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $pre.plan_id
    Assert-Equal 'renamed' $done.status 'the rename reported success'
    Assert-Equal 1 $done.pages_verified_identical 'the rename verified the content page'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/pending'))) 'the old Book root is gone'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/holding/wiki')) 'the new Book root exists'
    Assert-Equal $noteHash (Get-FixtureHash $renamedNotePage) 'the note crossed the rename byte-identical'

    $catalogAfter = [IO.File]::ReadAllText((Join-Path $fixture 'shelf/_catalog.md'))
    Assert-True ($catalogAfter.Contains('## Holding Shelf')) 'the catalog heading carries the new title'
    Assert-True ($catalogAfter.Contains('- **Path:** shelf/holding')) 'the catalog Path line names the new root'
    Assert-True (-not $catalogAfter.Contains('shelf/pending')) 'the catalog still names the old root'
    Assert-True ($catalogAfter.Contains('## Demo')) 'an unrelated catalog entry was disturbed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/holding/wiki/_book.md')).StartsWith('# Holding Shelf')) 'the Book page H1 carries the new title'
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/holding/wiki/_index.md')).StartsWith('# Holding Shelf - Reader Map')) 'the reader map H1 carries the new title'
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture 'shelf/holding/wiki/_index.md')).Contains('Kept note')) 'the reader map still lists the note'

    $deskAfter = @(Get-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Assert-True ($deskAfter -ccontains 'shelf/holding') 'the Desk follows the Book to its new root'
    Assert-True ($deskAfter -cnotcontains 'shelf/pending') 'the Desk still names the old root'

    # The renamed Book is still a working capture destination, which is what the catalog rewrite is for.
    $capture = & (Join-Path $toolsDir 'Add-ShelfNote.ps1') -Title 'After the rename' -Content 'Body.' -BookSlug 'holding' -WorkspacePath $fixture -Preflight
    Assert-Equal 'shelf/holding' $capture.book 'capture resolves the renamed Book'
    Assert-Equal 'Holding Shelf' $capture.book_title 'capture reports the new title'

    # === Add-ShelfBookPage ========================================================================
    # ADR-0001's writer. Additive and ungated by a plan_id, so what has to be proved is that it can
    # only ever add: a collision fails, a hand-edited reader map is refused rather than flattened,
    # and a failure after the page exists removes it again.
    . (Join-Path $toolsDir 'BookWriteGuard.ps1')
    $addPage = Join-Path $toolsDir 'Add-ShelfBookPage.ps1'
    $demoWiki = Join-Path $fixture 'shelf/demo/wiki'

    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'graduated/one' -Content "# One`nBody." -WorkspacePath $fixture } 'is closed' `
        'adding a page to a closed Shelf Book was refused'
    Assert-Refused { & $addPage -BookSlug 'holding' -PagePath 'one' -Content "# One`nBody." -WorkspacePath $fixture } 'capture Book' `
        'adding a curated page to a capture Book was refused by name'

    & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null

    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'Graduated/one' -Content "# One`nB." -WorkspacePath $fixture } 'lowercase' `
        'an uppercase PagePath segment was refused'
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath '../notebook/x' -Content "# X`nB." -WorkspacePath $fixture } 'lowercase' `
        'a traversing PagePath was refused'
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath '_index' -Content "# X`nB." -WorkspacePath $fixture } 'reader map' `
        'naming the reader map as a page was refused'
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'one' -Content 'c' -ContentPath 'p' -WorkspacePath $fixture } 'not both' `
        'giving both a body and a body path was refused'
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'one' -Content '   ' -WorkspacePath $fixture } 'needs a body' `
        'an empty body was refused'
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'one' -Content 'No heading at all.' -WorkspacePath $fixture } '-Title is required' `
        'a body with no H1 and no -Title was refused'

    $pre = & $addPage -BookSlug 'demo' -PagePath 'graduated/one' -Content "# Graduated one`n`nBody." -WorkspacePath $fixture -Preflight
    Assert-True (-not $pre.confirmation_required) 'an additive page write asked for a confirmation'
    Assert-Equal 'regenerate from the pages on disk' $pre.reader_map_action 'the preflight reported the reader-map action'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'graduated'))) 'the preflight created a folder'

    $r = & $addPage -BookSlug 'demo' -PagePath 'graduated/one' -Content "# Graduated one`n`nBody." -WorkspacePath $fixture
    Assert-Equal 'added' $r.status 'the page was added'
    Assert-Equal 'body H1' $r.title_source 'the body H1 became the page title'
    $pageText = [IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/one.md'))
    Assert-True ($pageText.StartsWith('# Graduated one')) 'the page kept its own H1'
    $mapText = [IO.File]::ReadAllText((Join-Path $demoWiki '_index.md'))
    Assert-True ($mapText.StartsWith('# Demo - Reader Map')) 'the regenerated map carries the Book title'
    Assert-True ($mapText.Contains('[[graduated/one|Graduated one]]')) 'the regenerated map lists the new page by its title'
    Assert-True ($mapText.Contains('[[_book|Book metadata and limits]]')) 'the regenerated map kept the Book metadata link'

    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'graduated/one' -Content "# Other`nDifferent body." -WorkspacePath $fixture } 'already exists' `
        'a second page at the same path was refused'
    Assert-Equal $pageText ([IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/one.md'))) 'the existing page was left untouched'

    # Fault injection: fail at the reader-map rewrite, after the page file already exists. This
    # writer's rollback shape is the prior-ABSENCE one -- there is no earlier body to put back, so
    # the proof is that the page it created is gone again.
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $true
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'graduated/two' -Content "# Graduated two`nB." -WorkspacePath $fixture } 'Rollback: complete and verified' `
        'a failed reader-map rewrite rolled back and said so'
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $false
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'graduated/two.md'))) 'the created page survived rollback'
    Assert-Equal $mapText ([IO.File]::ReadAllText((Join-Path $demoWiki '_index.md'))) 'the reader map was left as it was'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'graduated/one.md')) 'rollback removed an unrelated page'

    # A folder that existed only for the failed page goes with it; one holding another page does not.
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $true
    Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'fresh-topic/page' -Content "# Fresh`nB." -WorkspacePath $fixture } 'Rollback: complete and verified' `
        'a failed write into a new folder rolled back'
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $false
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'fresh-topic'))) 'a folder created only for the failed page was left behind'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'graduated')) 'rollback removed a folder holding another page'

    # A curated reader map is appended to, never regenerated: regenerating it would destroy the
    # sections and annotations a reader wrote, and an additive write that can destroy text is not
    # additive. shelf/library-dev's real map is exactly this shape.
    $generatedMap = [IO.File]::ReadAllText((Join-Path $demoWiki '_index.md'))
    [IO.File]::WriteAllText((Join-Path $demoWiki '_index.md'),
        "# Demo - Reader Map`n`n## Curated section`n`n- [[graduated/one|graduated/one.md]] - with an annotation.`n",
        [Text.UTF8Encoding]::new($false))
    $curated = & $addPage -BookSlug 'demo' -PagePath 'graduated/three' -Content "# Three`nB." -WorkspacePath $fixture
    Assert-Equal 'added' $curated.status 'a page was added to a Book with a curated map'
    $curatedMap = [IO.File]::ReadAllText((Join-Path $demoWiki '_index.md'))
    Assert-True ($curatedMap.Contains('## Curated section')) 'the curated section survived'
    Assert-True ($curatedMap.Contains('with an annotation.')) 'a link annotation survived'
    Assert-True ($curatedMap.Contains('[[graduated/three|Three]]')) 'the new link was appended under its title'
    Assert-Equal 0 $curated.reader_map_unlisted 'every page on disk is named by a link'

    # Drift a curated map can have, and a regenerated one cannot: reported, not silently accepted.
    [IO.File]::WriteAllText((Join-Path $demoWiki 'graduated/orphan.md'), "# Orphan`nB.`n", [Text.UTF8Encoding]::new($false))
    $drift = & $addPage -BookSlug 'demo' -PagePath 'graduated/five' -Content "# Five`nB." -WorkspacePath $fixture
    Assert-Equal 1 $drift.reader_map_unlisted 'a page no link names was reported as unlisted'
    Remove-Item -LiteralPath (Join-Path $demoWiki 'graduated/orphan.md') -Force
    Remove-Item -LiteralPath (Join-Path $demoWiki 'graduated/three.md') -Force
    Remove-Item -LiteralPath (Join-Path $demoWiki 'graduated/five.md') -Force
    [IO.File]::WriteAllText((Join-Path $demoWiki '_index.md'), $generatedMap, [Text.UTF8Encoding]::new($false))

    # The lock is the Book's: a second writer waits for it and then refuses rather than racing.
    $held = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/demo' -TimeoutSeconds 5
    try {
        Assert-Refused { & $addPage -BookSlug 'demo' -PagePath 'graduated/four' -Content "# Four`nB." -WorkspacePath $fixture -LockTimeoutSeconds 1 } 'holds the lock' `
            'a second writer refused while another held the Book lock'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'graduated/four.md'))) 'a page was written while another writer held the lock'
    }
    finally { Exit-BookLock -Lock $held }

    # === Set-ShelfBookPageStub ====================================================================
    # The first Shelf writer that DESTROYS text, so its rollback shape is the one neither 1.1 nor
    # 1.2 covers here: a prior BODY to put back, not a prior absence to delete. What has to be
    # proved is that the approval is real (bound to the page as it was read), that the reserved
    # pages cannot be stubbed at all, and that a retry after the stub landed writes nothing.
    $stubPage = Join-Path $toolsDir 'Set-ShelfBookPageStub.ps1'
    $stubArgs = @{ CanonicalBook = 'Canonical Demo'; CanonicalPage = 'topic/page'; WorkspacePath = $fixture }
    [IO.File]::WriteAllText((Join-Path $demoWiki 'graduated/dupe.md'), "# Duplicated topic`n`nThe full original body that a stub replaces.`n", [Text.UTF8Encoding]::new($false))

    # Both refusals come from ConvertTo-BookPagePath, which owns that rule for every Shelf writer.
    # Asserted here anyway: this helper needs them, and a future refactor that stopped routing
    # through it would take the guard away silently.
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath '_book' @stubArgs -Preflight } 'Book metadata page' `
        'stubbing the Book identity page was refused'
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/_index' @stubArgs -Preflight } 'reader map' `
        'stubbing a nested reader map was refused'
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/not-a-page' @stubArgs -Preflight } 'does not exist' `
        'stubbing a page that does not exist was refused rather than creating one'
    Assert-Refused { & $stubPage -BookSlug 'holding' -PagePath 'x' @stubArgs -Preflight } 'capture Book' `
        'stubbing a capture Book page was refused by name'
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '15/08/2026' -Preflight } 'ISO date' `
        'a non-ISO SupersededOn was refused'

    $stubPre = & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -Reason 'a fuller, source-cited copy' -SupersededOn '2026-08-20' -Preflight
    Assert-True $stubPre.confirmation_required 'a write that destroys text applied without a confirmation'
    Assert-Equal 'Duplicated topic' $stubPre.page_title 'the stub kept the page''s own title'
    Assert-True ($stubPre.replacement_text.Contains('**Superseded 2026-08-20.**')) 'the preflight showed the dated stub text'
    Assert-True ($stubPre.replacement_text.Contains('a fuller, source-cited copy')) 'the preflight showed the reason'
    # Depth is computed, not assumed: graduated/dupe sits one folder deep, so docs/ is four up.
    Assert-True ($stubPre.replacement_text.Contains('(../../../../docs/duplicate-topic-resolution.md)')) 'the docs link depth matched the page depth'
    Assert-Equal "# Duplicated topic`n`nThe full original body that a stub replaces.`n" ([IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/dupe.md'))) 'the preflight changed the page'

    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '2026-08-20' } '-UserConfirmed' `
        'stubbing without a confirmation was refused'
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '2026-08-20' -UserConfirmed -ApprovedPlanId 'stub-shelf-book-page-0000000000000000' } 'exact plan_id' `
        'a wrong plan_id was refused'

    # The approval is bound to the page as it was READ. Editing it after the preflight must
    # invalidate the plan_id rather than overwrite against a stale reading.
    [IO.File]::WriteAllText((Join-Path $demoWiki 'graduated/dupe.md'), "# Duplicated topic`n`nEdited after the preflight.`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -Reason 'a fuller, source-cited copy' -SupersededOn '2026-08-20' -UserConfirmed -ApprovedPlanId $stubPre.plan_id } 'exact plan_id' `
        'an approval bound to the pre-edit body still applied'
    [IO.File]::WriteAllText((Join-Path $demoWiki 'graduated/dupe.md'), "# Duplicated topic`n`nThe full original body that a stub replaces.`n", [Text.UTF8Encoding]::new($false))

    $stubbed = & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -Reason 'a fuller, source-cited copy' -SupersededOn '2026-08-20' -UserConfirmed -ApprovedPlanId $stubPre.plan_id
    Assert-Equal 'stubbed' $stubbed.status 'the page was stubbed'
    $stubText = [IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/dupe.md'))
    Assert-True ($stubText.StartsWith('# Duplicated topic')) 'the stub kept the original H1'
    Assert-True ($stubText.Contains('**Canonical Demo** Book')) 'the stub named the canonical Book'
    Assert-True (-not $stubText.Contains('The full original body')) 'the original body survived the stub'

    # Idempotent by content: the same call again writes nothing at all, and needs no approval to
    # say so. This is what makes a retry after an interruption safe.
    $again = & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -Reason 'a fuller, source-cited copy' -SupersededOn '2026-08-20'
    Assert-Equal 'already-stubbed' $again.status 'an identical stub was rewritten instead of being recognised'
    Assert-True (-not $again.confirmation_required) 'an identical stub asked for a confirmation'
    Assert-Equal $stubText ([IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/dupe.md'))) 'the settled page was rewritten'

    # A DIFFERENT stub is an ordinary change and is gated like any other.
    $restub = & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '2026-08-21' -Preflight
    Assert-True $restub.confirmation_required 'restubbing to a different date applied without a confirmation'
    Assert-True $restub.page_is_already_a_stub 'the preflight did not report that the page was already a stub'

    # Fault injection, and the rollback shape that matters here: the page is read-only, so the write
    # fails after the journal has captured the prior BODY. The proof is the body coming back.
    Set-FixtureReadOnly 'shelf/demo/wiki/graduated/dupe.md' $true
    Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '2026-08-21' -UserConfirmed -ApprovedPlanId $restub.plan_id } 'Rollback: complete and verified' `
        'a failed stub write rolled back and said so'
    Set-FixtureReadOnly 'shelf/demo/wiki/graduated/dupe.md' $false
    Assert-Equal $stubText ([IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/dupe.md'))) 'the prior body was not restored after a failed stub'

    # A top-level page needs a shallower docs link than a nested one. The constant that would have
    # been right for graduated/dupe is wrong here, which is why the depth is computed.
    [IO.File]::WriteAllText((Join-Path $demoWiki 'toplevel.md'), "# Top level`n`nBody.`n", [Text.UTF8Encoding]::new($false))
    $shallow = & $stubPage -BookSlug 'demo' -PagePath 'toplevel' @stubArgs -Preflight
    Assert-True ($shallow.replacement_text.Contains('(../../../docs/duplicate-topic-resolution.md)')) 'a top-level page got the nested page''s link depth'
    Remove-Item -LiteralPath (Join-Path $demoWiki 'toplevel.md') -Force

    # The lock is the Book's here too.
    $stubHeld = Enter-BookLock -Workspace $fixture -BookRoot 'shelf/demo' -TimeoutSeconds 5
    try {
        Assert-Refused { & $stubPage -BookSlug 'demo' -PagePath 'graduated/dupe' @stubArgs -SupersededOn '2026-08-21' -UserConfirmed -ApprovedPlanId $restub.plan_id -LockTimeoutSeconds 1 } 'holds the lock' `
            'a stub write refused while another writer held the Book lock'
        Assert-Equal $stubText ([IO.File]::ReadAllText((Join-Path $demoWiki 'graduated/dupe.md'))) 'the page changed while another writer held the lock'
    }
    finally { Exit-BookLock -Lock $stubHeld }

    Remove-Item -LiteralPath (Join-Path $demoWiki 'graduated/dupe.md') -Force
    [IO.File]::WriteAllText((Join-Path $demoWiki '_index.md'), $generatedMap, [Text.UTF8Encoding]::new($false))

    # === Archive-ShelfBook ========================================================================
    # A whole Book leaving the active Shelf. The rollback shape here is neither of the other two: a
    # moved DIRECTORY, which no journal of file bytes can put back, so the move is unwound by hand
    # in the catch and the journal covers only the catalog. What has to be proved is that the move
    # is reversible, that the catalog entry comes back verbatim, and that an archived Book stops
    # being reachable.
    $archive = Join-Path $toolsDir 'Archive-ShelfBook.ps1'
    $catalogPath = Join-Path $fixture 'shelf/_catalog.md'
    $catalogBefore = [IO.File]::ReadAllText($catalogPath)

    $emptyList = & $archive -Action List -WorkspacePath $fixture
    Assert-Equal 0 $emptyList.archived_count 'a Shelf with nothing archived reported archived Books'

    Assert-Refused { & $archive -Action Archive -BookSlug 'holding' -WorkspacePath $fixture -Preflight } 'capture Book' `
        'archiving a capture Book was refused by name'
    Assert-Refused { & $archive -Action Archive -BookSlug 'Demo' -WorkspacePath $fixture -Preflight } 'lowercase' `
        'an uppercase slug was refused'
    Assert-Refused { & $archive -Action Archive -BookSlug 'no-such-book' -WorkspacePath $fixture -Preflight } 'no Shelf Book' `
        'archiving a Book that does not exist was refused'
    # The Book is still open from the page-writer section above, which is exactly the guard's case.
    Assert-Refused { & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -Preflight } 'open on the Desk' `
        'archiving a Book that is open on the Desk was refused'

    & $desk -Action Close -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null

    # Reference classification, and the reason it exists: the first live use archived a Book with
    # eleven mentions under docs/ and internal/, the gate passed clean, and the preflight had said
    # flatly that it would fail. Only the narrow set shelf.references-resolve actually reads --
    # .claude/skills/**/*.md, CLAUDE.md, CONTEXT.md -- can block. A mention in docs/ is history.
    New-Item -ItemType Directory -Path (Join-Path $fixture '.claude/skills/demo-skill') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'docs/mentions-demo.md'), "# History`n`nOn some date, shelf/demo did a thing.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'docs/mentions-lookalike.md'), "# Lookalike`n`nThis names shelf/demo-v2, a different Book.`n", [Text.UTF8Encoding]::new($false))

    $refsOnly = & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    Assert-Equal 0 $refsOnly.blocking_references.Count 'a docs/ mention was reported as blocking the gate'
    Assert-True ('docs/mentions-demo.md' -cin $refsOnly.other_references) 'a docs/ mention was not reported at all'
    Assert-True ('docs/mentions-lookalike.md' -cnotin $refsOnly.other_references) 'shelf/demo-v2 was counted as a mention of shelf/demo'
    Assert-True ($refsOnly.next -clike '*No blocking references*') "with nothing blocking, next still warned: $($refsOnly.next)"

    # Now put one on a surface the gate really does read. It must flip to blocking, and say so.
    [IO.File]::WriteAllText((Join-Path $fixture '.claude/skills/demo-skill/SKILL.md'), "# Demo skill`n`nUses shelf/demo.`n", [Text.UTF8Encoding]::new($false))
    $refsBlocking = & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    Assert-True ('.claude/skills/demo-skill/SKILL.md' -cin $refsBlocking.blocking_references) 'a Skill mention was not reported as blocking'
    Assert-True ($refsBlocking.next -clike '*WILL fail*') "with a blocking reference, next did not warn: $($refsBlocking.next)"
    Remove-Item -LiteralPath (Join-Path $fixture '.claude/skills') -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $fixture 'docs/mentions-demo.md') -Force
    Remove-Item -LiteralPath (Join-Path $fixture 'docs/mentions-lookalike.md') -Force

    $archivePre = & $archive -Action Archive -BookSlug 'demo' -Reason 'a duplicate of the shared copy' -WorkspacePath $fixture -Preflight
    Assert-True $archivePre.confirmation_required 'archiving a Book applied without a confirmation'
    Assert-Equal 'shelf/_archive/demo' $archivePre.destination 'the archive destination'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo')) 'the preflight moved the Book'
    Assert-Equal $catalogBefore ([IO.File]::ReadAllText($catalogPath)) 'the preflight changed the catalog'

    Assert-Refused { & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture } '-UserConfirmed' `
        'archiving without a confirmation was refused'
    Assert-Refused { & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'archive-shelf-book-nope' } 'exact plan_id' `
        'a wrong plan_id was refused'

    $archived = & $archive -Action Archive -BookSlug 'demo' -Reason 'a duplicate of the shared copy' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $archivePre.plan_id
    Assert-Equal 'archived' $archived.status 'the Book was archived'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo'))) 'the Book is still on the active Shelf'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/_archive/demo/wiki')) 'the archived Book has no pages'
    Assert-True ($archived.pages_verified_identical -gt 0) 'no pages were verified after the move'
    $catalogAfter = [IO.File]::ReadAllText($catalogPath)
    Assert-True (-not $catalogAfter.Contains('shelf/demo')) 'the catalog still lists the archived Book'
    # The capture Book was renamed pending -> holding by the Rename section above, so this is its
    # slug by now. Named explicitly because removing one catalog section must leave the others whole.
    Assert-True ($catalogAfter.Contains('shelf/holding')) 'archiving one Book removed another Book''s entry'

    # An archived Book is gone from every reading surface, which is the point and also the limit.
    Assert-Refused { & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture } 'demo' `
        'an archived Shelf Book could still be opened on the Desk'

    $listed = & $archive -Action List -WorkspacePath $fixture
    Assert-Equal 1 $listed.archived_count 'the archived Book was not listed'
    Assert-Equal 'demo' $listed.books[0].slug 'the listed slug'
    Assert-Equal 'a duplicate of the shared copy' $listed.books[0].reason 'the archive reason was not kept'
    Assert-True $listed.books[0].restorable 'the archived Book was reported as not restorable'

    Assert-Refused { & $archive -Action Restore -BookSlug 'no-such-book' -WorkspacePath $fixture -Preflight } 'was not found' `
        'restoring a Book that was never archived was refused'

    $restorePre = & $archive -Action Restore -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    Assert-True $restorePre.confirmation_required 'restoring a Book applied without a confirmation'
    Assert-Refused { & $archive -Action Restore -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'restore-shelf-book-nope' } 'exact plan_id' `
        'a wrong restore plan_id was refused'

    $restored = & $archive -Action Restore -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $restorePre.plan_id
    Assert-Equal 'restored' $restored.status 'the Book was restored'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki')) 'the restored Book has no pages'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/_archive/demo'))) 'the archived copy was left behind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/_archived.json'))) 'the archive record was restored onto the active Shelf'
    # The entry comes back verbatim, not regenerated: the summary line the reader wrote survives.
    $catalogRestored = [IO.File]::ReadAllText($catalogPath)
    Assert-True ($catalogRestored.Contains('- **Path:** shelf/demo')) 'the catalog entry was not restored'
    Assert-True ($catalogRestored.Contains('Fixture Book.')) 'the reader''s own summary line was not restored verbatim'
    Assert-Equal 0 (& $archive -Action List -WorkspacePath $fixture).archived_count 'the restored Book is still listed as archived'

    # Fault injection: the catalog is read-only, so the rewrite fails AFTER the directory has moved.
    # The proof is the directory coming back, which no journal of file bytes could have done.
    & $desk -Action Close -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null
    $doomedPre = & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -Preflight
    Set-FixtureReadOnly 'shelf/_catalog.md' $true
    Assert-Refused { & $archive -Action Archive -BookSlug 'demo' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $doomedPre.plan_id } 'Rollback: complete and verified' `
        'a failed archive rolled back and said so'
    Set-FixtureReadOnly 'shelf/_catalog.md' $false
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki')) 'the moved directory was not moved back'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/_archive/demo'))) 'the half-archived copy was left behind'
    Assert-Equal $catalogRestored ([IO.File]::ReadAllText($catalogPath)) 'the catalog was left changed after a rolled-back archive'
    Assert-Equal 0 (& $archive -Action List -WorkspacePath $fixture).archived_count 'a rolled-back archive still shows in the listing'

    # Guarded, so that a rollback defect is reported by the assertions above rather than by this
    # line crashing the whole suite before it can print them. Found by mutating the rollback away.
    if (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki')) {
        & $desk -Action Open -Location Shelf -Slug demo -WorkspacePath $fixture | Out-Null
    }

    # === Remove-ShelfBook =========================================================================
    # The active lifecycle has no local-archive step: this helper stages only long enough to verify
    # the move and Catalog removal, then permanently deletes. Its approval binds every file and the
    # Desk state, and rollback is possible until permanent deletion begins.
    $deleteRoot = Join-Path $fixture 'shelf/delete-me'
    New-Item -ItemType Directory -Path (Join-Path $deleteRoot 'wiki') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $deleteRoot 'wiki/_book.md'), "# Delete Me`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $deleteRoot 'wiki/_index.md'), "# Delete Me - Reader Map`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $deleteRoot 'wiki/page.md'), "# Page`n`nDelete this body.`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($catalogPath, "`n## Delete Me`n- **Summary:** Disposable fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-me`n", [Text.UTF8Encoding]::new($false))
    # The entry file too, which this Book got away without while it was the only unrendered Book on
    # the fixture Shelf: it moves to staging with the directory, so nothing renders while it is
    # missing one. It stopped getting away with it when a second Book outlived a render, and the
    # cost was a fault-injection red that named a template instead of the assertion that failed.
    [IO.File]::WriteAllText((Get-ShelfCatalogEntryPath -Workspace $fixture -Slug 'delete-me'),
        "## Delete Me`n- **Summary:** Disposable fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-me`n", [Text.UTF8Encoding]::new($false))
    & $desk -Action Open -Location Shelf -Slug delete-me -WorkspacePath $fixture | Out-Null

    # A FOREIGN SEAT HOLDING THE BOOK IS A REFUSAL, at the preflight and again at apply. Until
    # 2026-09-09 the plan detected every seat and the apply path then closed only the CALLER's Desk
    # before deleting, leaving each foreign seat an entry entitling it to whatever Book landed on
    # that slug next -- no concurrency required. A second seat's Desk is written here through the
    # real Desk-file path, so the scan sees it exactly as it sees a live one.
    #
    # ON ITS OWN BOOK, deliberately. Removing the guard is how this case is falsified, and without
    # the guard the apply-time run DELETES -- so sharing a Book with the cases below would replace
    # two named failures with a missing-file crash in an unrelated assertion. A red has to name the
    # thing that broke.
    $foreignRoot = Join-Path $fixture 'shelf/delete-foreign'
    New-Item -ItemType Directory -Path (Join-Path $foreignRoot 'wiki') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $foreignRoot 'wiki/_book.md'), "# Delete Foreign`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $foreignRoot 'wiki/_index.md'), "# Delete Foreign - Reader Map`n", [Text.UTF8Encoding]::new($false))
    # Through the entry file AS WELL AS the rendered catalog, which the Books below do not need:
    # each of those is gone by the time anything renders, and this one is still on the Shelf when
    # the deletion below renders. A Book directory with no _catalog-entry.md is a refusal the
    # renderer is right to make.
    [IO.File]::AppendAllText($catalogPath, "`n## Delete Foreign`n- **Summary:** Foreign-seat fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-foreign`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Get-ShelfCatalogEntryPath -Workspace $fixture -Slug 'delete-foreign'),
        "## Delete Foreign`n- **Summary:** Foreign-seat fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-foreign`n", [Text.UTF8Encoding]::new($false))
    & $desk -Action Open -Location Shelf -Slug delete-foreign -WorkspacePath $fixture | Out-Null
    $foreignPre = & $removeShelfBook -BookSlug 'delete-foreign' -Reason 'Foreign fixture.' -WorkspacePath $fixture -Preflight

    $foreignSeatDesk = Get-DeskStateDirectory -StateDirectory (Join-Path $fixture '.claude') -Seat 'other'
    New-Item -ItemType Directory -Path $foreignSeatDesk -Force | Out-Null
    [IO.File]::WriteAllText((Get-DeskFileInDirectory -DeskDirectory $foreignSeatDesk -Kind 'books'), "shelf/delete-foreign`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Get-DeskFileInDirectory -DeskDirectory $foreignSeatDesk -Kind 'projects'), '', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-foreign' -Reason 'Foreign fixture.' -WorkspacePath $fixture -Preflight } 'open at 1 other seat(s): other' `
        'Shelf deletion refused a Book held by a foreign seat'
    # And again at APPLY, which is the half a preflight check cannot cover: the seat opened the Book
    # after the reader approved. Under the registry lock that is the only way it can happen, so this
    # is the case the lock exists to turn into a refusal rather than a silent deletion.
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-foreign' -Reason 'Foreign fixture.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $foreignPre.plan_id } 'open at 1 other seat(s): other' `
        'Shelf deletion refused a seat that opened the Book after approval'
    Assert-True (Test-Path -LiteralPath (Join-Path $foreignRoot 'wiki/_book.md') -PathType Leaf) 'the foreign-seat refusal deleted the Book anyway'
    Assert-True ((& $desk -Action List -WorkspacePath $fixture).open_books -contains 'shelf/delete-foreign') 'the foreign-seat refusal left the acting seat''s Desk closed'
    Remove-Item -LiteralPath $foreignSeatDesk -Recurse -Force
    & $desk -Action Close -Location Shelf -Slug delete-foreign -WorkspacePath $fixture | Out-Null

    $deletePre = & $removeShelfBook -BookSlug 'delete-me' -Reason 'Fixture deletion.' -WorkspacePath $fixture -Preflight
    Assert-True $deletePre.destructive 'Shelf deletion was not labelled destructive'
    Assert-True (-not $deletePre.recoverable) 'Shelf deletion claimed to be recoverable'
    Assert-True ($deletePre.desk_action -clike 'close*') 'Shelf deletion did not disclose that it would close the Book'
    Assert-True (Test-Path -LiteralPath $deleteRoot -PathType Container) 'Shelf deletion preflight changed the Book'
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-me' -Reason 'Fixture deletion.' -WorkspacePath $fixture -ApprovedPlanId $deletePre.plan_id } 'rerun with -UserConfirmed' `
        'Shelf deletion without confirmation was refused'
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-me' -Reason 'Fixture deletion.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId 'fabricated-delete-id' } 'exact plan_id' `
        'Shelf deletion with a fabricated plan_id was refused'

    $deletePage = Join-Path $deleteRoot 'wiki/page.md'
    $deleteBody = [IO.File]::ReadAllText($deletePage)
    [IO.File]::WriteAllText($deletePage, "$deleteBody`nChanged after approval.`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-me' -Reason 'Fixture deletion.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $deletePre.plan_id } 'exact plan_id' `
        'Shelf deletion refused a stale content-bound approval'
    [IO.File]::WriteAllText($deletePage, $deleteBody, [Text.UTF8Encoding]::new($false))

    $deleted = & $removeShelfBook -BookSlug 'delete-me' -Reason 'Fixture deletion.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $deletePre.plan_id
    Assert-Equal 'deleted' $deleted.status 'confirmed Shelf deletion did not report deleted'
    Assert-True (-not (Test-Path -LiteralPath $deleteRoot)) 'confirmed Shelf deletion left the active Book behind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture "internal/shelf-delete-staging/$($deletePre.plan_id)"))) 'confirmed Shelf deletion left its staging copy behind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'internal/book-manifests/shelf/delete-me'))) 'confirmed Shelf deletion left a manifest store behind'
    Assert-True ([IO.File]::ReadAllText($catalogPath) -cnotmatch 'shelf/delete-me') 'confirmed Shelf deletion left its Catalog entry behind'
    Assert-True ((& $desk -Action List -WorkspacePath $fixture).open_books -notcontains 'shelf/delete-me') 'confirmed Shelf deletion left the Book open'

    # Failure after the directory move but before the Catalog rewrite: the Book and its Desk state
    # must come back. This is the last wholly recoverable side of the permanent-delete boundary.
    $rollbackRoot = Join-Path $fixture 'shelf/delete-rollback'
    New-Item -ItemType Directory -Path (Join-Path $rollbackRoot 'wiki') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $rollbackRoot 'wiki/_book.md'), "# Delete Rollback`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $rollbackRoot 'wiki/_index.md'), "# Delete Rollback - Reader Map`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($catalogPath, "`n## Delete Rollback`n- **Summary:** Rollback fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-rollback`n", [Text.UTF8Encoding]::new($false))
    # The entry file too, for the reason delete-me above was given one and one step further on.
    # delete-me needed it because a second Book outlived a render; this Book needed it as soon as
    # the ROLLBACK began re-deriving the catalog (2026-09-18), because the rollback puts the
    # directory back and then renders -- and a Book on the Shelf with no entry file is a Shelf that
    # cannot be rendered at all. A fixture Shelf missing one is a state shelf.catalog-renders-from-
    # entries forbids in the real workspace, so it was the fixture that was wrong, not the rollback.
    [IO.File]::WriteAllText((Get-ShelfCatalogEntryPath -Workspace $fixture -Slug 'delete-rollback'),
        "## Delete Rollback`n- **Summary:** Rollback fixture.`n- **Topics:** fixture`n- **Path:** shelf/delete-rollback`n", [Text.UTF8Encoding]::new($false))
    & $desk -Action Open -Location Shelf -Slug delete-rollback -WorkspacePath $fixture | Out-Null
    $rollbackPre = & $removeShelfBook -BookSlug 'delete-rollback' -Reason 'Fault injection.' -WorkspacePath $fixture -Preflight
    Set-FixtureReadOnly 'shelf/_catalog.md' $true
    Assert-Refused { & $removeShelfBook -BookSlug 'delete-rollback' -Reason 'Fault injection.' -WorkspacePath $fixture -UserConfirmed -ApprovedPlanId $rollbackPre.plan_id } 'Rollback: complete and verified' `
        'failed Shelf deletion rolled back and said so'
    Set-FixtureReadOnly 'shelf/_catalog.md' $false
    Assert-True (Test-Path -LiteralPath (Join-Path $rollbackRoot 'wiki/_book.md') -PathType Leaf) 'failed Shelf deletion did not restore the Book directory'
    Assert-True ([IO.File]::ReadAllText($catalogPath) -cmatch 'shelf/delete-rollback') 'failed Shelf deletion did not preserve the Catalog entry'
    Assert-True ((& $desk -Action List -WorkspacePath $fixture).open_books -contains 'shelf/delete-rollback') 'failed Shelf deletion did not restore the Desk state'

    # === Add-ShelfBookTopic =======================================================================
    # Item 1.3, and Codex Round-1 finding #8. The distinctive property here is not rollback but
    # RESUME: when a multi-page write is interrupted partway, the pages that landed are correct and
    # complete, so keeping them is the right outcome. Rolling them back -- which is exactly what 1.1
    # and 1.2 must do -- would discard finished work for nothing.
    $addTopic = Join-Path $toolsDir 'Add-ShelfBookTopic.ps1'
    $topicSrc = Join-Path $fixture 'notebook/graduating'
    New-Item -ItemType Directory -Path $topicSrc -Force | Out-Null
    foreach ($n in @('alpha', 'beta', 'gamma')) {
        [IO.File]::WriteAllText((Join-Path $topicSrc "$n.md"), "# Topic $n`n`nBody of $n.`n", [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $topicSrc '_index.md'), "# Graduating`n`n- [[alpha]]`n", [Text.UTF8Encoding]::new($false))

    Assert-Refused { & $addTopic -BookSlug 'imported' -SourcePath 'notebook/graduating' -WorkspacePath $fixture -Preflight } 'is closed' `
        'graduating a topic into a closed Shelf Book was refused'
    Assert-Refused { & $addTopic -BookSlug 'holding' -SourcePath 'notebook/graduating' -WorkspacePath $fixture -Preflight } 'capture Book' `
        'graduating a topic into a capture Book was refused by name'
    Assert-Refused { & $addTopic -BookSlug 'demo' -SourcePath 'notebook/no-such-topic' -WorkspacePath $fixture -Preflight } 'not a directory' `
        'a missing source directory was refused'

    # An article with no H1 is refused by name and before anything is written. A Book page's title is
    # curatorial, so this helper does not invent one from the filename.
    [IO.File]::WriteAllText((Join-Path $topicSrc 'no-heading.md'), "Just a body.`n", [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -WorkspacePath $fixture -Preflight } 'no-heading.md' `
        'an article with no H1 was refused by name'
    Remove-Item -LiteralPath (Join-Path $topicSrc 'no-heading.md') -Force

    $tpre = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture -Preflight
    Assert-Equal 3 $tpre.pages_total 'the manifest bound the three articles'
    Assert-Equal 3 $tpre.pages_pending 'all three articles were pending'
    Assert-Equal 1 $tpre.skipped_sources 'the topic index was skipped rather than graduated'
    Assert-True (-not $tpre.confirmation_required) 'an additive topic graduate asked for a confirmation'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'topics'))) 'the preflight created pages'

    # Fault injection, 1.3's shape: a multi-page write interrupted partway. A directory standing
    # where beta's page file must go fails exactly that one entry while alpha and gamma succeed --
    # no test-only surface in the helper, and the manifest still classes beta as pending because a
    # container is not a page.
    New-Item -ItemType Directory -Path (Join-Path $demoWiki 'topics/beta.md') -Force | Out-Null
    $partial = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture
    Assert-Equal 'incomplete' $partial.status 'a partial topic graduate was dressed up as success'
    Assert-Equal 2 $partial.pages_succeeded 'the two unobstructed pages landed'
    Assert-Equal 1 $partial.pages_failed 'the obstructed page was reported failed'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'topics/alpha.md')) 'alpha landed despite a later failure'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'topics/gamma.md')) 'gamma landed after an earlier failure'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture $partial.journal)) 'the progress journal was written'

    # RESUME, not undo: the pages that landed stay byte-identical and are not written again; only the
    # unfinished entry is attempted. This is the assertion that separates 1.3 from 1.1 and 1.2.
    $alphaHash = Get-FixtureHash 'shelf/demo/wiki/topics/alpha.md'
    $gammaHash = Get-FixtureHash 'shelf/demo/wiki/topics/gamma.md'
    Remove-Item -LiteralPath (Join-Path $demoWiki 'topics/beta.md') -Recurse -Force
    $resumed = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture
    Assert-Equal 'complete' $resumed.status 'the resumed run did not complete'
    Assert-True ($resumed.resuming) 'the resumed run did not recognise the earlier journal'
    Assert-Equal 3 $resumed.pages_succeeded 'the resumed run did not account for all three entries'
    Assert-Equal 0 $resumed.pages_failed 'the resumed run reported a failure'
    Assert-Equal $alphaHash (Get-FixtureHash 'shelf/demo/wiki/topics/alpha.md') 'the resume rewrote a page that had already landed'
    Assert-Equal $gammaHash (Get-FixtureHash 'shelf/demo/wiki/topics/gamma.md') 'the resume rewrote a page that had already landed'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'topics/beta.md')) 'the unfinished entry landed on resume'

    # Idempotence by content, which is what keeps a retry safe when the journal died with the process
    # that wrote it. No journal, same sources: every entry is already present and identical.
    Remove-Item -LiteralPath (Join-Path $fixture 'internal/graduate-journals') -Recurse -Force
    $again = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture
    Assert-Equal 'complete' $again.status 'a rerun with no journal did not complete'
    Assert-True (-not $again.resuming) 'a rerun with no journal claimed to be resuming'
    Assert-Equal 3 $again.pages_identical 'the already-present pages were not recognised as identical'
    Assert-Equal 3 $again.pages_succeeded 'identical pages were not counted as succeeded'
    Assert-Equal $alphaHash (Get-FixtureHash 'shelf/demo/wiki/topics/alpha.md') 'a rerun rewrote an identical page'

    # A divergent collision refuses the whole operation before any write. Suffixing around it is
    # exactly how the duplicate pages were being made.
    [IO.File]::WriteAllText((Join-Path $topicSrc 'alpha.md'), "# Topic alpha`n`nRewritten body.`n", [Text.UTF8Encoding]::new($false))
    $blocked = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture -Preflight
    Assert-Equal 1 $blocked.pages_divergent 'the changed article was not reported as a divergent collision'
    Assert-True ($blocked.blocked) 'the preflight did not flag the operation as blocked'
    Assert-Refused { & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture } 'different content' `
        'a divergent collision did not refuse the operation'
    Assert-Equal $alphaHash (Get-FixtureHash 'shelf/demo/wiki/topics/alpha.md') 'the refused run changed the existing page'

    # The digest binds every source hash, so a changed set is a different operation and an earlier
    # journal cannot be resumed against material that has moved underneath it.
    [IO.File]::WriteAllText((Join-Path $topicSrc 'alpha.md'), "# Topic alpha`n`nBody of alpha.`n", [Text.UTF8Encoding]::new($false))
    $firstDigest = (& $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture -Preflight).manifest_digest
    [IO.File]::WriteAllText((Join-Path $topicSrc 'delta.md'), "# Topic delta`n`nBody of delta.`n", [Text.UTF8Encoding]::new($false))
    $grown = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture -Preflight
    Assert-True ($grown.manifest_digest -cne $firstDigest) 'adding an article left the manifest digest unchanged'
    Assert-Equal 1 $grown.pages_pending 'only the new article should have been pending'
    Assert-Equal 3 $grown.pages_identical 'the already-graduated pages were not recognised'

    # The established fault seam applied to the multi-page writer: with the reader map unwritable the
    # pending entry fails, and the page the child created is rolled back by the child, not left half
    # written for the resume to trip over.
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $true
    $mapFail = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $false
    Assert-Equal 'incomplete' $mapFail.status 'an unwritable reader map was reported as success'
    Assert-Equal 1 $mapFail.pages_failed 'the unwritable reader map did not fail the pending entry'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $demoWiki 'topics/delta.md'))) 'the child left its page behind after a failed map rewrite'
    Assert-Equal $alphaHash (Get-FixtureHash 'shelf/demo/wiki/topics/alpha.md') 'a failed run disturbed a page that had already landed'

    $final = & $addTopic -BookSlug 'demo' -SourcePath 'notebook/graduating' -PagePrefix 'topics' -WorkspacePath $fixture
    Assert-Equal 'complete' $final.status 'the run after clearing the fault did not complete'
    Assert-True (Test-Path -LiteralPath (Join-Path $demoWiki 'topics/delta.md')) 'the last entry landed once the fault was cleared'
    Assert-Equal 0 $final.pages_failed 'the final run still reported a failure'

    # === Invoke-LibraryTriage, the batch state machine ============================================
    #
    # 1.4's rollback shape is one neither 1.1 nor 1.2 covers. Their correct answer to a failure is
    # to leave no trace: a half-renamed Book or a half-added page is worse than none. A batch's
    # correct answer is the opposite -- what already landed must SURVIVE the failure of a later
    # action, because the reader ran this to lose nothing before a reset. So the property under
    # test here is not "nothing remains" but "exactly what succeeded remains, it is reported as
    # partial rather than as success, and a resume finishes the rest without touching it".
    $unreachableMcp = 'http://127.0.0.1:9/mcp'
    New-Item -ItemType Directory -Path (Join-Path $fixture 'notebook/triage') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/one.md') -Value "# Triage one`n`nFirst.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/two.md') -Value "# Triage two`n`nSecond.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/three.md') -Value "# Triage three`n`nThird.`n" -Encoding utf8
    Set-Content -LiteralPath (Get-DeskFilePath -StateDirectory (Join-Path $fixture '.claude') -Seat 'fixture' -Kind 'books') -Value "shelf/demo`n" -Encoding utf8

    # --- validation, which happens before an approval exists ---
    Assert-Refused { & $triage -ActionJson '[{"kind":"project","source_path":"notebook/triage","slug":"p","title":"T","purpose":"P","replace_existing":true}]' -WorkspacePath $fixture -Preflight } 'create-and-additive only' `
        'replace_existing on a Project action was refused at validation'
    Assert-Refused { & $triage -ActionJson '[{"kind":"book","source_path":"notebook/triage","slug":"b","title":"T","summary":"S","replace_existing":true}]' -WorkspacePath $fixture -Preflight } 'create-and-additive only' `
        'replace_existing on a Book action was refused at validation'
    Assert-Refused { & $triage -ActionJson '[{"kind":"shelf-book","source_path":"notebook/triage/one.md","slug":"demo","title":"T"}]' -WorkspacePath $fixture -Preflight } 'page_path' `
        'a shelf-book action without page_path was refused'
    Assert-Refused { & $triage -ActionJson '[{"kind":"shelf-book","source_path":"notebook/triage/one.md","slug":"holding","page_path":"x","title":"T"}]' -WorkspacePath $fixture -Preflight } 'capture Book' `
        'a shelf-book action naming a capture Book was refused'
    Assert-Refused { & $triage -ActionJson '[{"kind":"holding","source_path":"docs/keep.md","title":"T"}]' -WorkspacePath $fixture -Preflight } 'inside notebook/' `
        'a source outside notebook/ was refused'
    Assert-Refused { & $triage -ActionJson '[{"kind":"holding","source_path":"notebook/triage","title":"T"}]' -WorkspacePath $fixture -Preflight } 'single Markdown article' `
        'a folder source for a single-article kind was refused'

    # Two actions creating one path is a guaranteed partial batch, and it is knowable here. The
    # note slug comes from the body H1, so identical headings collide however they are titled.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/dup-a.md') -Value "# Same heading`n`nA.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/dup-b.md') -Value "# Same heading`n`nB.`n" -Encoding utf8
    Assert-Refused { & $triage -ActionJson '[{"kind":"holding","source_path":"notebook/triage/dup-a.md","title":"A"},{"kind":"holding","source_path":"notebook/triage/dup-b.md","title":"B"}]' -WorkspacePath $fixture -Preflight } 'Two actions both create' `
        'a write-set overlap was refused at validation'

    # A shared reader map is a touch, not a create, so two pages into one Book is not an overlap.
    $twoPages = & $triage -ActionJson '[{"kind":"shelf-book","source_path":"notebook/triage/one.md","slug":"demo","page_path":"triage/p1","title":"P1"},{"kind":"shelf-book","source_path":"notebook/triage/two.md","slug":"demo","page_path":"triage/p2","title":"P2"}]' -WorkspacePath $fixture -Preflight
    Assert-Equal 2 $twoPages.action_count 'two pages into one Book were wrongly treated as an overlap'

    # --- a mixed local batch, with a fault injected into its second action ---
    $batchJson = '[{"kind":"holding","source_path":"notebook/triage/one.md","title":"Triage one"},{"kind":"shelf-book","source_path":"notebook/triage/two.md","slug":"demo","page_path":"triage/two","title":"Triage two"},{"kind":"holding","source_path":"notebook/triage/three.md","title":"Triage three"}]'
    $batch = & $triage -ActionJson $batchJson -WorkspacePath $fixture -Preflight
    Assert-Equal 3 $batch.action_count 'the mixed batch plan was written'
    # Fixed order, cheapest and most reversible first, whatever order the reader listed them in.
    Assert-Equal 'holding:holding,holding:holding,shelf-book:demo' (@($batch.execution_order) -join ',') 'the batch was not ordered holding before shelf-book'

    $bpre = & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight
    Assert-True ($bpre.plan_id -cmatch '^triage-[0-9a-f]{64}$') 'the batch preflight returned a content-bound plan_id'
    Assert-Equal 3 $bpre.pending_count 'a first run reported every action as pending'
    Assert-Equal 'False' $bpre.resume 'a first run claimed to be a resume'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/triage/two.md'))) 'the batch preflight wrote a page'

    Assert-Refused { & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp } 'UserConfirmed' `
        'a batch without confirmation was refused'
    Assert-Refused { & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -UserConfirmed -ApprovedPlanId 'triage-wrong' } 'exact plan_id' `
        'a batch with a fabricated plan_id was refused'

    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $true
    $brun = & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -UserConfirmed -ApprovedPlanId $bpre.plan_id
    Set-FixtureReadOnly 'shelf/demo/wiki/_index.md' $false

    Assert-Equal 'incomplete' $brun.status 'a partial batch was reported as complete'
    Assert-Equal 'False' $brun.all_succeeded 'a partial batch claimed every action succeeded'
    Assert-Equal 2 $brun.succeeded_count 'the two independent actions did not both land'
    Assert-Equal 1 $brun.failed_count 'the injected fault did not fail its action'
    # Continue-on-failure: the third action is ordered after the failing one and must still run.
    $thirdNote = Join-Path $fixture 'shelf/holding/wiki/notes'
    Assert-Equal 2 @(Get-ChildItem -LiteralPath $thirdNote -File -Filter '*triage-*.md').Count 'the batch stopped at the first failure instead of continuing'
    # Honest per-destination reporting: nothing here touched the NAS.
    Assert-Equal 'True' $brun.shelf_write 'a Shelf write was not reported'
    Assert-Equal 'False' $brun.shared_collection_write 'a local-only batch claimed a shared-collection write'
    Assert-Equal 'False' $brun.notebook_write 'a batch with no notebook kind claimed to write the Notebook'
    Assert-Equal 'False' $brun.shared_library_write 'a local-only batch claimed a shared Library write'
    # Every outcome carries the same properties, whatever happened to it.
    Assert-True (@(@($brun.outcomes) | Where-Object { $null -eq $_.PSObject.Properties['error'] }).Count -eq 0) 'an outcome omitted its error property'

    $journalFile = $brun.journal_path
    Assert-True (Test-Path -LiteralPath $journalFile -PathType Leaf) 'the batch journal was not written'
    $journal = ([IO.File]::ReadAllText($journalFile)) | ConvertFrom-Json
    Assert-Equal 'incomplete' $journal.state 'the journal recorded a partial batch as complete'
    Assert-Equal 3 @($journal.actions).Count 'the journal did not record every action'
    Assert-Equal 1 @(@($journal.actions) | Where-Object { $_.state -ceq 'failed' }).Count 'the journal did not record the failure'
    Assert-Equal 2 @(@($journal.actions) | Where-Object { $_.state -ceq 'succeeded' }).Count 'the journal did not record the successes'

    # What already landed must survive the failure of a later action -- the property that separates
    # this writer from 1.1 and 1.2, whose correct response to a failure is to leave no trace.
    $survivor = @(Get-ChildItem -LiteralPath $thirdNote -File -Filter '*triage-one*.md')[0]
    $survivorHash = (Get-FileHash -LiteralPath $survivor.FullName -Algorithm SHA256).Hash

    # --- resume: only the unfinished action runs, and the finished ones are untouched ---
    $bpre2 = & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight
    Assert-Equal $bpre.plan_id $bpre2.plan_id 'the batch identity changed between runs of the same plan'
    Assert-Equal 'True' $bpre2.resume 'the second run did not recognise the journal'
    Assert-Equal 1 $bpre2.pending_count 'the resume did not narrow to the unfinished action'
    Assert-Equal 2 $bpre2.already_succeeded 'the resume did not recognise the completed actions'

    $brun2 = & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -UserConfirmed -ApprovedPlanId $bpre2.plan_id
    Assert-Equal 'complete' $brun2.status 'the resume did not complete the batch'
    Assert-Equal 3 $brun2.succeeded_count 'the resume did not count the previously succeeded actions'
    Assert-Equal 2 @(@($brun2.outcomes) | Where-Object { $_.skipped }).Count 'the resume re-ran actions already recorded as succeeded'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'shelf/demo/wiki/triage/two.md')) 'the unfinished action did not land on resume'
    Assert-Equal $survivorHash (Get-FileHash -LiteralPath $survivor.FullName -Algorithm SHA256).Hash 'the resume disturbed an entry that had already landed'
    Assert-Equal 2 @(Get-ChildItem -LiteralPath $thirdNote -File -Filter '*triage-*.md').Count 'the resume duplicated a note that had already landed'

    # --- an approved path taken between approval and execution ---
    # The approval named an exact path; execution fails rather than quietly relocating, and the
    # independent action beside it still lands.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/four.md') -Value "# Triage four`n`nFourth.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/five.md') -Value "# Triage five`n`nFifth.`n" -Encoding utf8
    $squatJson = '[{"kind":"holding","source_path":"notebook/triage/four.md","title":"Triage four"},{"kind":"holding","source_path":"notebook/triage/five.md","title":"Triage five"}]'
    $spre = & $triage -ActionJson $squatJson -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight
    # Taken from the plan's own write set, not rebuilt from Get-Date: the capture date is UTC and
    # the test host may not be.
    $squatted = Join-Path $fixture (@(@($spre.actions) | Where-Object { $_.write_set -match 'triage-four' })[0].write_set[0])
    $spared = Join-Path $fixture (@(@($spre.actions) | Where-Object { $_.write_set -match 'triage-five' })[0].write_set[0])
    Set-Content -LiteralPath $squatted -Value 'squatter' -Encoding utf8
    $srun = & $triage -ActionJson $squatJson -WorkspacePath $fixture -McpUrl $unreachableMcp -UserConfirmed -ApprovedPlanId $spre.plan_id
    Assert-Equal 'incomplete' $srun.status 'an occupied approved path was reported as a complete batch'
    Assert-Equal 1 $srun.failed_count 'an occupied approved path did not fail its action'
    Assert-True ((@(@($srun.outcomes) | Where-Object { $_.state -ceq 'failed' })[0].error) -match 'no longer writable') 'the occupied path failed for the wrong reason'
    Assert-Equal 'squatter' ([IO.File]::ReadAllText($squatted).Trim()) 'the occupied path was overwritten'
    Assert-True (Test-Path -LiteralPath $spared) 'the independent action beside the failure did not land'

    # --- the plan record, and a source edited after it was written ---
    # A confirmed run writes internal/triage-plans/<batch id>.json once, and only once: it is the
    # record of exactly what was approved, so a retry must find it and leave it alone.
    $planRecord = Join-Path $fixture "internal/triage-plans/$($spre.plan_id).json"
    Assert-True (Test-Path -LiteralPath $planRecord -PathType Leaf) 'the confirmed run wrote no plan record'
    $recordDoc = ([IO.File]::ReadAllText($planRecord)) | ConvertFrom-Json
    Assert-Equal 3 $recordDoc.version 'the plan record does not carry the v3 schema'
    Assert-Equal 2 @($recordDoc.actions).Count 'the plan record did not record every action'
    $recordHash = (Get-FileHash -LiteralPath $planRecord -Algorithm SHA256).Hash

    # The squatter is cleared first, because a preflight refuses the WHOLE batch on any gate failure
    # -- that is the point of preflighting before an approval exists. The action that already
    # succeeded stays succeeded: the journal skips it rather than re-checking its now-occupied path.
    Remove-Item -LiteralPath $squatted -Force

    # Re-running from the record reproduces the same batch identity: the record is evidence, and the
    # digests are recomputed from the sources rather than trusted.
    $rpre = & $triage -PlanPath $planRecord -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight
    Assert-Equal $spre.plan_id $rpre.plan_id 'a plan re-read from its record produced a different batch identity'
    Assert-Equal $recordHash ((Get-FileHash -LiteralPath $planRecord -Algorithm SHA256).Hash) 'reading a plan record rewrote it'

    # Now edit a source. The stored digest no longer matches what is on disk, and that is caught
    # before any write rather than after one.
    Add-Content -LiteralPath (Join-Path $fixture 'notebook/triage/five.md') -Value 'Edited after planning.'
    Assert-Refused { & $triage -PlanPath $planRecord -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight } 'Rebuild the plan' `
        'a source edited after the plan was written did not invalidate it'

    # --- READ BOTH, WRITE ONE: a legacy handoff plan stays readable and is refused execution ---
    # internal/handoff-plans/ holds real records of real batches. Schema 2 digests were computed
    # without source, delete_set, or a list-valued required_desk_state, so they cannot re-resolve --
    # and keeping a second digest recipe to make them would be two parsers of one record. The path
    # still resolves and the refusal says exactly that.
    $legacyPlan = Join-Path $fixture 'internal/handoff-plans/handoff-20260818-000000-deadbeef.json'
    New-Item -ItemType Directory -Path (Split-Path -Parent $legacyPlan) -Force | Out-Null
    [IO.File]::WriteAllText($legacyPlan, '{"version":2,"created_utc":"2026-08-18T00:00:00Z","capture_date":"2026-08-18","actions":[]}', [Text.UTF8Encoding]::new($false))
    $legacyHash = (Get-FileHash -LiteralPath $legacyPlan -Algorithm SHA256).Hash
    Assert-Refused { & $triage -PlanPath $legacyPlan -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight } 'is a Library Handoff plan from before 2026-08-28' `
        'a schema 2 handoff plan was not refused with its reason'
    Assert-Equal $legacyHash ((Get-FileHash -LiteralPath $legacyPlan -Algorithm SHA256).Hash) 'refusing a legacy plan rewrote it'
    Assert-Refused { & $triage -PlanPath (Join-Path $fixture 'docs/keep.md') -WorkspacePath $fixture -Preflight } 'internal/triage-plans/ or internal/handoff-plans/' `
        'a plan path outside the two plan roots was allowed'

    # === The round-seven review findings, carried forward from Handoff v2 =========================
    # Every case below is a defect Codex found in the first implementation on 2026-08-18. They are
    # kept as checks rather than as prose because a fix without one is a fix that comes back.

    # An approval must bind the title. Paths derive from the slug, so a changed Book or Project
    # title moves no file -- and would have changed the written body while the digest stayed put.
    $titleA = (& $triage -ActionJson '[{"kind":"book","source_path":"notebook/triage","slug":"titled","title":"First title","summary":"S"}]' -WorkspacePath $fixture -Preflight)
    $titleB = (& $triage -ActionJson '[{"kind":"book","source_path":"notebook/triage","slug":"titled","title":"Second title","summary":"S"}]' -WorkspacePath $fixture -Preflight)
    Assert-True ((@($titleA.actions)[0].action_digest) -cne (@($titleB.actions)[0].action_digest)) 'a changed title left the action digest unchanged'

    # Metadata is length-prefixed before hashing, so one field holding "a,b" cannot hash the same as
    # two fields holding "a" and "b". A separator-joined digest cannot tell those apart.
    $aliasA = (& $triage -ActionJson '[{"kind":"project","source_path":"notebook/triage","slug":"aliased","title":"T","purpose":"P","next_actions":["a,b"]}]' -WorkspacePath $fixture -Preflight)
    $aliasB = (& $triage -ActionJson '[{"kind":"project","source_path":"notebook/triage","slug":"aliased","title":"T","purpose":"P","next_actions":["a","b"]}]' -WorkspacePath $fixture -Preflight)
    Assert-True ((@($aliasA.actions)[0].action_digest) -cne (@($aliasB.actions)[0].action_digest)) 'two different metadata shapes hashed identically'

    # include_pages must narrow the source manifest and the write set, not arrive as metadata after
    # both were built from every file -- which refused every legitimate subset.
    $subset = & $triage -ActionJson '[{"kind":"book","source_path":"notebook/triage","slug":"subset","title":"Subset","summary":"S","include_pages":["one.md"]}]' -WorkspacePath $fixture -Preflight
    $subsetWrite = @(@($subset.actions)[0].write_set)
    Assert-True ($subsetWrite -ccontains 'books/subset/wiki/triage/one.md') 'include_pages dropped the page it selected'
    Assert-True (-not ($subsetWrite -ccontains 'books/subset/wiki/triage/two.md')) 'include_pages left an unselected page in the write set'
    Assert-Equal 1 @(@($subset.actions)[0].source_manifest).Count 'include_pages did not narrow the source manifest'
    Assert-Refused { & $triage -ActionJson '[{"kind":"book","source_path":"notebook/triage","slug":"subset","title":"S","summary":"S","include_pages":["absent.md"]}]' -WorkspacePath $fixture -Preflight } 'not an exact Markdown file' `
        'include_pages naming a missing file was refused'

    # Two Project actions for one Hub have disjoint write sets and still cannot both run: the first
    # creates the Hub, which invalidates the second's child approval.
    Assert-Refused { & $triage -ActionJson '[{"kind":"project","source_path":"notebook/triage/one.md","slug":"twice","title":"T","purpose":"P"},{"kind":"project","source_path":"notebook/triage/two.md","slug":"twice","title":"T","purpose":"P"}]' -WorkspacePath $fixture -Preflight } 'both target' `
        'two Project actions for one Hub were allowed'

    # The journal is written with a forced move, so its path is confined exactly as PlanPath is.
    Assert-Refused { & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -JournalPath (Join-Path $fixture 'docs/keep.md') -Preflight } 'internal/triage-journals' `
        'a journal path outside the two journal roots was allowed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $fixture 'docs/keep.md')).Contains('Keep me')) 'the refused journal path was written anyway'

    # A journal is evidence about one batch. Accepting a foreign or hand-edited one would let a
    # stale `succeeded` record silently skip real work, which is the one thing a resume must not do.
    $foreign = Join-Path $fixture 'internal/triage-journals/foreign.json'
    New-Item -ItemType Directory -Path (Split-Path -Parent $foreign) -Force | Out-Null
    [IO.File]::WriteAllText($foreign, '{"schema":1,"batch_id":"triage-someone-else","actions":[]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -JournalPath $foreign -Preflight } 'belongs to batch' `
        'a journal from a different batch was accepted'
    [IO.File]::WriteAllText($foreign, '{"schema":99,"batch_id":"x","actions":[]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $triage -ActionJson $batchJson -WorkspacePath $fixture -McpUrl $unreachableMcp -JournalPath $foreign -Preflight } 'unsupported schema' `
        'a journal with an unknown schema was accepted'

    # --- the crash window: a run that died between starting an action and recording its outcome ---
    # Neither retrying blindly nor claiming success is honest, because whether the destination
    # exists is unknowable from here. The action is reported interrupted and left alone, and the
    # independent action beside it still runs.
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/six.md') -Value "# Triage six`n`nSixth.`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $fixture 'notebook/triage/seven.md') -Value "# Triage seven`n`nSeventh.`n" -Encoding utf8
    $crashJson = '[{"kind":"holding","source_path":"notebook/triage/six.md","title":"Triage six"},{"kind":"holding","source_path":"notebook/triage/seven.md","title":"Triage seven"}]'
    $cpre = & $triage -ActionJson $crashJson -WorkspacePath $fixture -McpUrl $unreachableMcp -Preflight
    $sixAction = @(@($cpre.actions) | Where-Object { $_.write_set -match 'triage-six' })[0]
    $crashJournal = Join-Path $fixture 'internal/triage-journals/crashed.json'
    $crashDoc = [pscustomobject]@{
        schema = 1; batch_id = $cpre.plan_id; plan_path = $cpre.plan_path; state = 'in-progress'
        created_utc = '2026-08-18T00:00:00Z'; updated_utc = '2026-08-18T00:00:00Z'
        actions = @([pscustomobject]@{
            action_id = $sixAction.action_id; kind = 'holding'; slug = 'holding'; destination = 'shelf'
            action_digest = $sixAction.action_digest; write_set = @($sixAction.write_set)
            state = 'attempting'; attempts = 1; completed_utc = ''; error = ''
        })
    }
    [IO.File]::WriteAllText($crashJournal, ($crashDoc | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))

    $cpre2 = & $triage -ActionJson $crashJson -WorkspacePath $fixture -McpUrl $unreachableMcp -JournalPath $crashJournal -Preflight
    $crun = & $triage -ActionJson $crashJson -WorkspacePath $fixture -McpUrl $unreachableMcp -JournalPath $crashJournal -UserConfirmed -ApprovedPlanId $cpre2.plan_id
    Assert-Equal 'incomplete' $crun.status 'a batch carrying an interrupted action was reported complete'
    Assert-Equal 1 $crun.interrupted_count 'the interrupted action was not reported as interrupted'
    Assert-Equal 1 $crun.succeeded_count 'the batch did not continue past the interrupted action'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture @($sixAction.write_set)[0]))) 'the interrupted action was retried blindly'
    $sevenAction = @(@($cpre.actions) | Where-Object { $_.write_set -match 'triage-seven' })[0]
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture @($sevenAction.write_set)[0])) 'the action beside the interrupted one did not run'
    $crashAfter = ([IO.File]::ReadAllText($crashJournal)) | ConvertFrom-Json
    Assert-Equal 'interrupted' (@(@($crashAfter.actions) | Where-Object { $_.action_id -ceq $sixAction.action_id })[0].state) 'the journal did not record the interruption'

    # === powershell.defect-families, family 5 (parameter shadowing) ==============================
    # Each case is its own scratch workspace holding one tools/*.ps1, so the only variable between
    # runs is the fixture's shape. Two things are load-bearing here:
    #   -Fast, because the full run's library-helpers.boundary-suite re-invokes THIS file from its
    #     own $PSScriptRoot regardless of -WorkspacePath. Without it the suite recurses into itself
    #     and wedges with no output rather than failing -- which is how the delegated first attempt
    #     at these fixtures was lost.
    #   -Json, so the verdict is read from the check's own record instead of matched against a
    #     rendered line. A scratch workspace cannot satisfy settings.parse or context.always-on-budget,
    #     so the run as a whole always fails and only this one check's status is meaningful.
    function Get-DefectFamiliesCheck([string]$ScratchDir) {
        # BOTH ROOTS POINT AT THE SCRATCH TREE, and -ProgramPath is the load-bearing one. What this
        # fixture tests is the DETECTORS, which are program-shaped: it plants faults under
        # $ScratchDir/tools and expects them flagged. Before the program root and the workspace
        # became two answers (2026-09-21) -WorkspacePath set both, so this line worked by accident
        # of their being the same variable. Passing only the workspace makes every detector scan
        # the REAL tree, find it clean, and report `pass` where this fixture expects `fail` -- five
        # detectors silently unfalsifiable, which is how this was found.
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $toolsDir 'Invoke-LibraryChecks.ps1') -ProgramPath $ScratchDir -WorkspacePath $ScratchDir -Fast -Json 2>&1
        $global:LASTEXITCODE = 0   # the scratch workspace fails unrelated checks by construction
        $doc = (@($out) -join "`n") | ConvertFrom-Json
        @(@($doc.checks) | Where-Object { $_.check -ceq 'powershell.defect-families' })[0]
    }
    function New-DefectFixture([string]$CaseName, [string]$FileName, [string]$Body) {
        $dir = Join-Path $fixture "defect-families/$CaseName"
        New-Item -ItemType Directory -Path (Join-Path $dir 'tools') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $dir (Join-Path 'tools' $FileName)), $Body, [Text.UTF8Encoding]::new($false))
        $dir
    }

    # Case 1 -- positive: a script assigning to its own declared parameter is the defect itself.
    $dir = New-DefectFixture 'positive' 'Family5-Positive.ps1' @'
[CmdletBinding()]
param([switch]$Preflight)

$action = 'open'
$Preflight = Get-ChildPreflight $action
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'fail' $c.status 'family 5 did not flag an assignment to a script parameter'
    Assert-True ($c.detail -clike "*Family5-Positive.ps1:5 assignment to script parameter 'Preflight': `$Preflight = Get-ChildPreflight `$action*") `
        'the family 5 finding did not name the file, line, parameter, and offending assignment'

    # Case 2 -- case negative: PowerShell variable names are case-insensitive, so the lowercase
    # spelling is the same parameter. Missing this would miss the defect exactly as it was written.
    $dir = New-DefectFixture 'case' 'Family5-Case.ps1' @'
[CmdletBinding()]
param([switch]$Preflight)

$action = 'open'
$preflight = Get-ChildPreflight $action
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'fail' $c.status 'family 5 missed the case-insensitive spelling of a script parameter'
    Assert-True ($c.detail -clike "*assignment to script parameter 'Preflight'*") `
        'the case-insensitive finding did not report the parameter under its declared spelling'

    # Case 3 -- negative control, the requirement most likely to be got wrong: a function's local
    # writes that function's scope and is not the script's parameter, even sharing its name. A lint
    # that flags correct code gets suppressed, and then catches nothing.
    $dir = New-DefectFixture 'function-local' 'Family5-NegativeControl.ps1' @'
[CmdletBinding()]
param([switch]$Preflight)

function Invoke-Thing {
    $preflight = 'a function-local of the same name is a different variable'
    $preflight
}

Invoke-Thing
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'pass' $c.status 'family 5 flagged a function-local variable sharing a script parameter name'
    Assert-True ($c.detail -cnotlike '*assignment to script parameter*') 'the negative control produced a family 5 finding'

    # Case 4 -- the deliberate narrowing, tested rather than only commented: string parameters are
    # exempt, because the tree-wide default-if-unset idiom reassigns them on purpose. This check's
    # own $WorkspacePath is the first instance. The cost is that a [string] shadow goes uncaught.
    $dir = New-DefectFixture 'string-default' 'Family5-StringDefault.ps1' @'
[CmdletBinding()]
param([string]$WorkspacePath)

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = $PSScriptRoot }
$WorkspacePath
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'pass' $c.status 'the default-if-unset idiom on a string parameter was flagged as family 5'

    # === powershell.defect-families, family 2's PRODUCTION side (added 2026-09-09) ================
    # The consumption detector reads `.Count` on a pipeline result; this one reads the other end -- a
    # call that can legitimately return an EMPTY array, sitting where its value travels the pipeline.
    # Empty unrolls to nothing, so the caller receives $null. Three positions unroll and four forms
    # are safe, and BOTH directions are pinned here: a rule only ever tested for what it rejects is
    # half tested, and the four safe forms are what stop it flagging correct code.
    #
    # THESE CASES ARE ALSO WHAT STOPS THE DETECTOR GOING VACUOUS. Emptying or renaming
    # $emptyCapableCalls makes every positive below report 'pass', so the set cannot quietly stop
    # matching -- which a count alone could not prove, because zero is the right answer for a fixture.

    $dir = New-DefectFixture 'unroll-return' 'UnrollReturn.ps1' @'
function Get-Bytes([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllBytes($Path)
}
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'fail' $c.status 'an array-returning call in a RETURN statement was not flagged'
    Assert-True ($c.detail -clike '*UnrollReturn.ps1:3 ReadAllBytes can return an EMPTY array*a return statement*') `
        "the return-position finding did not name the file, line, call and position: $($c.detail)"

    $dir = New-DefectFixture 'unroll-bare' 'UnrollBare.ps1' @'
function Get-Bytes([string]$Path) {
    [IO.File]::ReadAllBytes($Path)
}
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'fail' $c.status 'an array-returning call as a BARE trailing statement was not flagged'
    Assert-True ($c.detail -clike '*a bare trailing statement*') "the bare-statement finding did not name the position: $($c.detail)"

    # The shape that took the live 2nd-b-vault-dev seat offline: the `if` is the value, so the
    # assignment does not save it. This is the case an assignment-shaped rule would have caught and
    # the two above are the two it would have missed.
    $dir = New-DefectFixture 'unroll-statement' 'UnrollStatement.ps1' @'
$exists = Test-Path -LiteralPath 'x' -PathType Leaf
$bytes = if ($exists) { [IO.File]::ReadAllBytes('x') } else { $null }
$bytes.Length
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'fail' $c.status 'an array-returning call inside an if-statement USED AS A VALUE was not flagged'
    Assert-True ($c.detail -clike '*an if/foreach/switch statement used as a value*') `
        "the statement-value finding did not name the position: $($c.detail)"

    # THE NEGATIVE CONTROLS, all four safe forms in one fixture. A detector that flagged any of these
    # would be unusable: they are how the tree already writes this call, 38 times over.
    $dir = New-DefectFixture 'unroll-safe' 'UnrollSafe.ps1' @'
function Get-Direct([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    , $bytes
}
function Get-Wrapped([string]$Path) {
    @([IO.File]::ReadAllLines($Path) | Where-Object { $_ })
}
function Get-Consumed([string]$Path) {
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path))
}
function Get-Cast([string]$Path) {
    [byte[]]([IO.File]::ReadAllBytes($Path))
}
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'pass' $c.status "a SAFE form was flagged as unrolling: $($c.detail)"

    # Split is outside the set on purpose: splitting even an empty string yields one element, so it
    # never unrolls to nothing. Including it would flag twenty correct sites in this tree.
    $dir = New-DefectFixture 'unroll-split' 'UnrollSplit.ps1' @'
function Get-Lines([string]$Text) {
    $Text.Replace("`r`n", "`n").Split("`n")
}
'@
    $c = Get-DefectFamiliesCheck $dir
    Assert-Equal 'pass' $c.status "Split was treated as empty-capable and flagged: $($c.detail)"

    # --- 2.1 topic overlap records ----------------------------------------------------------------
    # The interesting property is structural: a contradictory pair is unrepresentable rather than
    # detected, because the record key is unordered on the Book pair. Case 3 is the one that proves
    # it -- the reversed pair is refused as a duplicate, not accepted as a second opinion.
    # Two dedicated fixture Books, so these cases do not depend on what the rename cases above left
    # the catalog looking like.
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/overlap-a/wiki') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'shelf/overlap-b/wiki') -Force | Out-Null
    $catalogPath = Join-Path $fixture 'shelf/_catalog.md'
    [IO.File]::WriteAllText($catalogPath, ([IO.File]::ReadAllText($catalogPath) + "`n## Overlap A`n- **Summary:** Fixture Book.`n- **Path:** shelf/overlap-a`n`n## Overlap B`n- **Summary:** Fixture Book.`n- **Path:** shelf/overlap-b`n"), [Text.UTF8Encoding]::new($false))

    $overlap = Join-Path $toolsDir 'Set-TopicOverlap.ps1'
    $recordFile = Join-Path $fixture 'internal/overlap-records.json'
    function Reset-OverlapFile { Remove-Item -LiteralPath $recordFile -Force -ErrorAction SilentlyContinue }

    Reset-OverlapFile
    $r = & $overlap -Action Add -Topic shaders -Slug overlap-a -Counterpart overlap-b -Relationship unverified -WorkspacePath $fixture
    Assert-Equal 'AddTopicOverlap' $r.operation 'Add did not report AddTopicOverlap'
    Assert-Equal 'open' $r.resolution 'a new unverified record did not default to open'
    Assert-True (Test-Path -LiteralPath $recordFile -PathType Leaf) 'Add wrote no record file'
    Assert-True (-not (Test-Path -LiteralPath "$recordFile.tmp")) 'Add left its temporary file behind'

    Assert-Refused { & $overlap -Action Add -Topic shaders -Slug overlap-a -Counterpart overlap-b -Relationship canonical -WorkspacePath $fixture } `
        'already exists' 'a second record for the same topic and pair was accepted'

    Assert-Refused { & $overlap -Action Add -Topic shaders -Slug overlap-b -Counterpart overlap-a -Relationship canonical -WorkspacePath $fixture } `
        'already exists' 'the reversed pair was accepted as a separate record, so the file could hold a contradiction'

    $r = & $overlap -Action Add -Topic tooling -Slug overlap-a -Counterpart overlap-b -Relationship complementary -WorkspacePath $fixture
    Assert-Equal 2 $r.count 'a second topic over the same Book pair was not accepted'

    Assert-Refused { & $overlap -Action Add -Topic shaders -Slug overlap-a -Counterpart absent -Relationship unverified -WorkspacePath $fixture } `
        'is listed in shelf/_catalog.md' 'a dangling counterpart slug was accepted'
    Assert-Refused { & $overlap -Action Add -Topic shaders -Slug overlap-a -Counterpart overlap-a -Relationship unverified -WorkspacePath $fixture } `
        'cannot overlap itself' 'a Book was recorded as overlapping itself'
    Assert-Refused { & $overlap -Action Add -Topic Shaders -Slug overlap-a -Counterpart overlap-b -Relationship unverified -WorkspacePath $fixture } `
        'lowercase' 'an uppercase topic was accepted'
    Assert-Refused { & $overlap -Action Add -Topic optics -Slug overlap-a -Counterpart overlap-b -Relationship unverified -Resolution resolved -WorkspacePath $fixture } `
        "is 'unverified' with resolution 'resolved'" 'a pair nobody has read was recorded as resolved'
    Assert-Refused { & $overlap -Action Add -Topic optics -Slug overlap-a -Counterpart overlap-b -Relationship complementary -Resolution resolved -WorkspacePath $fixture } `
        "is 'complementary' with resolution 'resolved'" 'a complementary pair was recorded as resolved, which has no losing copy'
    Assert-Refused { & $overlap -Action Add -Topic optics -Slug overlap-a -Counterpart overlap-b -Relationship unverified -Date '2026-02-30' -WorkspacePath $fixture } `
        'not a real calendar date' 'an impossible date was accepted'
    Assert-Refused { & $overlap -Action Add -Topic optics -Slug overlap-a -Counterpart overlap-b -Relationship unverified -Note "one`ntwo" -WorkspacePath $fixture } `
        'single line' 'a multi-line note was accepted'

    Assert-Refused { & $overlap -Action Set -Topic optics -Slug overlap-a -Counterpart overlap-b -Relationship canonical -WorkspacePath $fixture } `
        'Use -Action Add' 'Set silently created a record that did not exist'

    # Changing the relationship resets the resolution: a state settled under the old reading of the
    # pair is not evidence about the new one.
    $r = & $overlap -Action Set -Topic tooling -Slug overlap-a -Counterpart overlap-b -Relationship canonical -WorkspacePath $fixture
    Assert-Equal 'open' $r.resolution 'changing the relationship kept the previous resolution state'
    $r = & $overlap -Action Set -Topic tooling -Slug overlap-a -Counterpart overlap-b -Resolution resolved -WorkspacePath $fixture
    Assert-Equal 'resolved' $r.resolution 'a canonical pair could not be marked resolved'
    Assert-Equal 'canonical' $r.relationship 'Set without -Relationship did not keep the recorded relationship'

    # Naming the pair the other way round is how the direction is corrected, and it must not leave two
    # records behind.
    $r = & $overlap -Action Set -Topic tooling -Slug overlap-b -Counterpart overlap-a -Relationship canonical -WorkspacePath $fixture
    Assert-Equal 'overlap-b' $r.book 'reversing the pair did not change which Book the relationship reads from'
    Assert-Equal 2 $r.count 'reversing the pair added a record instead of replacing it'

    $r = & $overlap -Action List -Slug overlap-b -WorkspacePath $fixture
    Assert-Equal 2 $r.count 'List did not return both records touching the Book'
    $r = & $overlap -Action List -Topic shaders -WorkspacePath $fixture
    Assert-Equal 1 $r.count 'List did not filter by topic'
    $r = & $overlap -Action Validate -WorkspacePath $fixture
    Assert-True $r.valid 'a record set written by this helper failed its own validation'

    $r = & $overlap -Action Remove -Topic shaders -Slug overlap-b -Counterpart overlap-a -WorkspacePath $fixture
    Assert-Equal 1 $r.count 'Remove did not delete the record named the other way round'
    Assert-Refused { & $overlap -Action Remove -Topic shaders -Slug overlap-a -Counterpart overlap-b -WorkspacePath $fixture } `
        'No overlap record' 'removing an absent record reported success'

    # Shelf exit removes Books before their Shelf-only overlap records can be reconciled. Remove
    # still requires an exact existing pair, but must be able to clear that now-stale record.
    & $overlap -Action Add -Topic retired-topic -Slug overlap-a -Counterpart overlap-b -Relationship canonical -WorkspacePath $fixture | Out-Null
    $catalogWithOverlapB = [IO.File]::ReadAllText($catalogPath)
    $catalogWithoutOverlapB = ($catalogWithOverlapB -replace '(?s)\r?\n## Overlap B\r?\n- \*\*Summary:\*\* Fixture Book\.\r?\n- \*\*Path:\*\* shelf/overlap-b\r?\n?', "`n")
    [IO.File]::WriteAllText($catalogPath, $catalogWithoutOverlapB, [Text.UTF8Encoding]::new($false))
    $r = & $overlap -Action Remove -Topic retired-topic -Slug overlap-a -Counterpart overlap-b -WorkspacePath $fixture
    Assert-Equal 1 $r.count 'Remove did not clear a record for a retired Shelf Book'
    [IO.File]::WriteAllText($catalogPath, $catalogWithOverlapB, [Text.UTF8Encoding]::new($false))

    # Hand-edited files: the record file is application-managed, but nothing stops a reader opening it.
    [IO.File]::WriteAllText($recordFile, '{"schema":1,"records":[{"topic":"a","book":"overlap-a","counterpart":"overlap-b","relationship":"canonical","resolution":"open","date":"2026-08-18"},{"topic":"a","book":"overlap-b","counterpart":"overlap-a","relationship":"canonical","resolution":"open","date":"2026-08-18"}]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $overlap -Action Validate -WorkspacePath $fixture } 'duplicates the pair' 'a hand-written contradictory pair passed validation'

    [IO.File]::WriteAllText($recordFile, '{"schema":1,"records":[{"topic":"a","book":"overlap-a","counterpart":"gone","relationship":"canonical","resolution":"open","date":"2026-08-18"}]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $overlap -Action Validate -WorkspacePath $fixture } 'shelf/_catalog.md does not list' 'a record naming a Book that no longer exists passed validation'

    [IO.File]::WriteAllText($recordFile, '{"schema":1,"records":[{"topic":"a","book":"overlap-a","counterpart":"overlap-b","relationship":"canonical"}]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $overlap -Action Validate -WorkspacePath $fixture } 'is missing' 'a truncated record passed validation'

    [IO.File]::WriteAllText($recordFile, '{"schema":9,"records":[]}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $overlap -Action Validate -WorkspacePath $fixture } 'this helper writes schema' 'a future schema was read as if it were this one'

    [IO.File]::WriteAllText($recordFile, '{"schema":1,,}', [Text.UTF8Encoding]::new($false))
    Assert-Refused { & $overlap -Action Validate -WorkspacePath $fixture } 'not valid JSON' 'an unparseable record file was read as empty'

    # A refused write must not damage what is already recorded.
    Reset-OverlapFile
    & $overlap -Action Add -Topic shaders -Slug overlap-a -Counterpart overlap-b -Relationship canonical -WorkspacePath $fixture | Out-Null
    $recordsBefore = [IO.File]::ReadAllText($recordFile)
    Assert-Refused { & $overlap -Action Add -Topic shaders -Slug overlap-b -Counterpart overlap-a -Relationship complementary -WorkspacePath $fixture } `
        'already exists' 'a refused Add was allowed'
    Assert-Equal $recordsBefore ([IO.File]::ReadAllText($recordFile)) 'a refused Add still rewrote the record file'

    # Process boundary: exactly one JSON object, with the schema field the output contract promises.
    $boundary = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $overlap -Action List -WorkspacePath $fixture -Json
    $decoded = ($boundary -join '') | ConvertFrom-Json
    Assert-Equal 1 $decoded.schema 'the JSON boundary output carried no output-contract schema'
    Assert-Equal 'ListTopicOverlaps' $decoded.operation 'the JSON boundary output did not carry the operation'
    Reset-OverlapFile

# --- Currency check, collection tier, and Restore-BookSource ----------------------------------------
# Both are offline here by construction. The collection tier's whole state machine up to the point a
# remote is contacted runs against planted manifests, and every refusal Restore-BookSource can reach
# before it opens an MCP session is reached with no session opened.
. (Join-Path $toolsDir 'BookManifestTransaction.ps1')
$currency = Join-Path $toolsDir 'Get-BookCurrency.ps1'
$restore = Join-Path $toolsDir 'Restore-BookSource.ps1'

$currencyFixture = Join-Path $fixture 'currency'
function Write-CurrencyFile([string]$Relative, [string]$Text) {
    $path = Join-Path $currencyFixture $Relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
}
function Get-CurrencyBook($Result, [string]$Slug) { @($Result.books | Where-Object { $_.book -ceq $Slug })[0] }

$currencyOid = '0123456789abcdef0123456789abcdef01234567'
$currencyHash = 'a' * 64
Write-CurrencyFile (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') ''
Write-CurrencyFile (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'projects') ''
Write-CurrencyFile 'notebook/_master-index.md' "# Notebook`n"
Write-CurrencyFile 'shelf/_catalog.md' @"
# Local Shelf

## Refused Host
- **Summary:** Pinned to a host the allowlist does not carry.
- **Path:** shelf/refusedhost

## Unanchored
- **Summary:** Compiled, but citing no git upstream.
- **Path:** shelf/unanchored

## Broken Anchor
- **Summary:** A Sources block that does not parse.
- **Path:** shelf/brokenanchor

## No Manifest
- **Summary:** Catalogued and never backfilled.
- **Path:** shelf/nomanifest

## Legacy Schema
- **Summary:** A manifest written before the anchor roll-up.
- **Path:** shelf/legacyschema

## Dirty Store
- **Summary:** A manifest mid-mutation.
- **Path:** shelf/dirtystore
"@
Write-CurrencyFile 'shelf/refusedhost/wiki/_book.md' "# Refused Host`n"
Write-CurrencyFile 'shelf/refusedhost/wiki/page.md' ("# Page`n`n## Sources`n`n" +
    "- Upstream ``https://codeberg.org/someone/thing`` ref ``refs/heads/main`` at ``$currencyOid``; repo root ``raw/x``; captured ``2026-09-04```n" +
    "- ``raw/x/a.md`` - SHA-256 ``$currencyHash``; provenance: ``external```n")
Write-CurrencyFile 'shelf/unanchored/wiki/_book.md' "# Unanchored`n"
Write-CurrencyFile 'shelf/unanchored/wiki/page.md' "# Page`n`n## Sources`n`n- ``raw/x/a.md`` - SHA-256 ``$currencyHash``; provenance: ``external```n"
Write-CurrencyFile 'shelf/brokenanchor/wiki/_book.md' "# Broken Anchor`n"
Write-CurrencyFile 'shelf/brokenanchor/wiki/page.md' ("# Page`n`n## Sources`n`n" +
    "- Upstream ``https://github.com/a/b`` at ``$currencyOid```n- ``raw/x/a.md`` - SHA-256 ``$currencyHash``; provenance: ``external```n")
Write-CurrencyFile 'shelf/nomanifest/wiki/_book.md' "# No Manifest`n"
Write-CurrencyFile 'shelf/nomanifest/wiki/page.md' "# Page`n`nBody.`n"
Write-CurrencyFile 'shelf/legacyschema/wiki/_book.md' "# Legacy Schema`n"
Write-CurrencyFile 'shelf/legacyschema/wiki/page.md' "# Page`n`nBody.`n"
Write-CurrencyFile 'shelf/dirtystore/wiki/_book.md' "# Dirty Store`n"
Write-CurrencyFile 'shelf/dirtystore/wiki/page.md' "# Page`n`nBody.`n"

foreach ($slug in @('refusedhost', 'unanchored', 'brokenanchor', 'legacyschema', 'dirtystore')) {
    Invoke-BookManifestTransaction -Workspace $currencyFixture -Slug $slug -BookRoot "shelf/$slug" -Reason 'currency fixture' | Out-Null
}
# A stored schema-1 manifest: the field is ABSENT, which is not the same state as an empty array.
$legacyStored = Get-StoredBookManifest -Workspace $currencyFixture -Slug 'legacyschema'
$legacyBody = [ordered]@{}
foreach ($property in $legacyStored.manifest.PSObject.Properties) {
    if ($property.Name -cin @('anchored_upstreams', 'anchor_unreadable')) { continue }
    $legacyBody[$property.Name] = $property.Value
}
$legacyBody['schema'] = 1
Save-BookManifest -Workspace $currencyFixture -Slug 'legacyschema' -Manifest ([pscustomobject]$legacyBody) -Reason 'schema-1 fixture' | Out-Null
Set-BookManifestDirty -Workspace $currencyFixture -Slug 'dirtystore' -Reason 'planted' | Out-Null

# -ShelfOnly, so the shared Catalog is never contacted and the suite stays offline. Every verdict
# below is decided before any network call, and `refused source` is decided instead of one.
$currencyAll = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $currency -All -ShelfOnly -WorkspacePath $currencyFixture -Json
$currencyResult = ($currencyAll -join '') | ConvertFrom-Json
Assert-Equal 1 $currencyResult.schema 'the collection tier carried no output-contract schema'
Assert-Equal 'the ACTIVE local Shelf' $currencyResult.scope 'a -ShelfOnly run claimed shared coverage'
Assert-True (-not $currencyResult.shared_books_covered) 'a -ShelfOnly run reported the shared collection as covered'
Assert-True ($currencyResult.shared_books_note -clike '*not contacted*') 'a -ShelfOnly run did not say the shared collection was left out'
# ACTIVE, added 2026-09-08: this tier covers the two active collections and not the two archives, so
# a scope that named the Shelf without qualifying it read as the whole Shelf including its archive.
# The archives are named in `archive_note`; asserted where the coverage claim lives, in
# archive.search-coverage, against a fixture that actually has an archived Book.
Assert-True ($currencyResult.scope -cnotlike '*shared*') 'a -ShelfOnly run named the shared collection in its scope'
Assert-Equal 6 $currencyResult.books_total 'the collection tier did not join against the live Shelf catalog'

Assert-Equal 'cannot verify' (Get-CurrencyBook $currencyResult 'nomanifest').verdict 'a catalogued Book with no manifest'
Assert-True ((Get-CurrencyBook $currencyResult 'nomanifest').detail -clike 'no manifest:*') 'a Book with no manifest was not told apart from one with no anchors'
Assert-Equal 'cannot verify' (Get-CurrencyBook $currencyResult 'dirtystore').verdict 'a dirty store'
Assert-True ((Get-CurrencyBook $currencyResult 'dirtystore').detail -clike 'manifest unavailable (dirty)*') 'a dirty store was not named as unavailable'
Assert-Equal 'cannot verify' (Get-CurrencyBook $currencyResult 'legacyschema').verdict 'a schema-1 manifest'
Assert-True ((Get-CurrencyBook $currencyResult 'legacyschema').detail -clike 'manifest lacks anchor data:*') 'a schema-1 manifest was read as unanchored'
Assert-Equal 'not anchored' (Get-CurrencyBook $currencyResult 'unanchored').verdict 'a Book citing no git upstream'
Assert-Equal 'cannot verify' (Get-CurrencyBook $currencyResult 'brokenanchor').verdict 'a Book whose Sources block does not parse'
Assert-True ((Get-CurrencyBook $currencyResult 'brokenanchor').detail -clike 'malformed anchor:*') 'an unparseable Sources block was not reported as a malformed anchor'
Assert-Equal 'cannot verify' (Get-CurrencyBook $currencyResult 'refusedhost').verdict 'a pin on a host the allowlist does not carry'
Assert-True ((Get-CurrencyBook $currencyResult 'refusedhost').detail -clike 'refused source:*') 'a non-allowlisted host was contacted rather than refused'
# Absence never reads as current, whatever shape the absence takes.
Assert-Equal 0 ([int]$currencyResult.counts.current) 'a Book with no usable anchor data was reported current'
# The collection tier holds no cited paths, so it must never claim it can name changed files.
Assert-True (($currencyAll -join '') -cnotmatch 'refresh due') 'the collection tier used the per-Book tier''s verdict'
Assert-True ($currencyResult.limits -clike '*is NOT fetched*') 'the collection tier did not disclose that its pins were never fetched'
# Every catalogued Book contributes a row: an unreadable store is reported, never dropped.
Assert-Equal 6 ([int]$currencyResult.counts.current + [int]$currencyResult.counts.'not anchored' + [int]$currencyResult.counts.'cannot verify' + [int]$currencyResult.counts.'upstream advanced -- article inspection required') 'a catalogued Book was silently dropped from the collection tier'

# --- Restore-BookSource: every refusal reachable without an MCP session -------------------------------
Assert-Refused { & $restore -Book 'Obsidian-App' -WorkspacePath $currencyFixture -Preflight } 'lowercase slug' `
    'a mixed-case slug was accepted and would have built a notebook path nothing else matches'
Assert-Refused { & $restore -Book 'notopen' -WorkspacePath $currencyFixture -Preflight } 'is not open on the Desk' `
    'a closed shared Book was restored without the Desk gate'
Assert-Refused { & $restore -Book 'unanchored' -WorkspacePath $currencyFixture -Preflight } 'is a Shelf Book' `
    'a Shelf Book, whose pages are already local, was offered a restore'

Write-CurrencyFile (Get-DeskFileRelativePath -Seat 'fixture' -Kind 'books') "books/demoresto`n"
Assert-Refused { & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -Preflight } 'no internal/publication-journals directory' `
    'a workspace with no journals at all did not say so'

function Write-RestoreJournal([string]$Name, [object]$Body) {
    Write-CurrencyFile "internal/publication-journals/$Name" ($Body | ConvertTo-Json -Depth 8)
}
function New-RestoreRecords([object[]]$Pairs) {
    @($Pairs | ForEach-Object { [pscustomobject]@{ path = "books/demoresto/wiki/demoresto/$($_.name)"; source = "notebook/demoresto/$($_.name)"; sha256 = $_.sha256 } })
}
function Get-RestoreDigest([object[]]$Records) { Get-TextHash ((@($Records) | ForEach-Object { "$($_.source)|$($_.sha256)" }) -join "`n") }

$restoreBodyOne = "# One`n`nRestored body one.`n"
$restoreBodyTwo = "# Two`n`nRestored body two.`n"
$restoreRecords = New-RestoreRecords @(
    @{ name = 'one.md'; sha256 = (Get-TextHash $restoreBodyOne) }
    @{ name = 'two.md'; sha256 = (Get-TextHash $restoreBodyTwo) }
)
$restoreJournal = [ordered]@{
    state = 'complete'; timestamp_utc = '2026-09-01T00:00:00.0000000Z'; project_id = 'fixture-project'
    book_slug = 'demoresto'; source_digest_sha256 = (Get-RestoreDigest $restoreRecords); planned_records = @($restoreRecords)
}
Write-RestoreJournal 'demoresto-aaaa.json' $restoreJournal

# An incomplete journal is never selected, however new it is.
Write-RestoreJournal 'demoresto-bbbb.json' ([ordered]@{
    state = 'copying'; timestamp_utc = '2026-09-09T00:00:00.0000000Z'; project_id = 'fixture-project'
    book_slug = 'demoresto'; source_digest_sha256 = (Get-RestoreDigest $restoreRecords); planned_records = @($restoreRecords) })
$restorePre = & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' -Preflight
Assert-Equal 'ready' $restorePre.status 'a valid journal did not produce a ready preflight'
Assert-True ($restorePre.journal -clike '*demoresto-aaaa.json') 'an incomplete journal was selected over the completed one'
Assert-Equal 2 $restorePre.page_count 'the preflight did not count the planned records'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $currencyFixture 'notebook/demoresto'))) 'a preflight created the destination'

# Newest by the timestamp INSIDE the file, because the filename embeds a digest and not a date.
$newerRecords = New-RestoreRecords @(@{ name = 'one.md'; sha256 = (Get-TextHash $restoreBodyOne) })
Write-RestoreJournal 'demoresto-0000.json' ([ordered]@{
    state = 'complete'; timestamp_utc = '2026-09-08T00:00:00.0000000Z'; project_id = 'fixture-project'
    book_slug = 'demoresto'; source_digest_sha256 = (Get-RestoreDigest $newerRecords); planned_records = @($newerRecords) })
$restoreNewer = & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' -Preflight
Assert-True ($restoreNewer.journal -clike '*demoresto-0000.json') 'the journal was selected by filename rather than by the timestamp inside it'
Remove-Item -LiteralPath (Join-Path $currencyFixture 'internal/publication-journals/demoresto-0000.json') -Force

# The external completeness proof: a journal missing one record is still valid JSON and must fail.
Write-RestoreJournal 'demoresto-cccc.json' ([ordered]@{
    state = 'complete'; timestamp_utc = '2026-09-07T00:00:00.0000000Z'; project_id = 'fixture-project'
    book_slug = 'demoresto'; source_digest_sha256 = (Get-RestoreDigest $restoreRecords); planned_records = @($restoreRecords[0]) })
Assert-Refused { & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' -Preflight } 'does not reproduce its own source digest' `
    'a journal with a dropped record passed as complete'
Remove-Item -LiteralPath (Join-Path $currencyFixture 'internal/publication-journals/demoresto-cccc.json') -Force

# A source path that escapes notebook/<slug>/ is refused before anything is read.
$escapeRecords = @([pscustomobject]@{ path = 'books/demoresto/wiki/demoresto/one.md'; source = 'notebook/demoresto/../../secrets.md'; sha256 = (Get-TextHash $restoreBodyOne) })
Write-RestoreJournal 'demoresto-dddd.json' ([ordered]@{
    state = 'complete'; timestamp_utc = '2026-09-07T00:00:00.0000000Z'; project_id = 'fixture-project'
    book_slug = 'demoresto'; source_digest_sha256 = (Get-RestoreDigest $escapeRecords); planned_records = @($escapeRecords) })
Assert-Refused { & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' -Preflight } 'relative or empty path segment' `
    'a source path escaping the destination was accepted'
Remove-Item -LiteralPath (Join-Path $currencyFixture 'internal/publication-journals/demoresto-dddd.json') -Force

# A journal written against another project is not this reader's to restore from.
Assert-Refused { & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'other-project' -Preflight } 'was written against project' `
    'a journal from a different project was accepted'

# Create-only, and it refuses an EMPTY existing destination too: a directory that exists is one
# something else may be filling, and "empty, therefore mine" is a race with a rmdir.
New-Item -ItemType Directory -Path (Join-Path $currencyFixture 'notebook/demoresto') -Force | Out-Null
$restoreCollide = & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' -Preflight
Assert-Equal 'refused' $restoreCollide.status 'an existing destination did not refuse the preflight'
Assert-True ($restoreCollide.reason -clike '*create-only*') 'the refusal did not say why the destination is never replaced'
Assert-Refused { & $restore -Book 'demoresto' -WorkspacePath $currencyFixture -ProjectId 'fixture-project' } 'already exists' `
    'an existing empty destination was restored into'
Assert-True (-not @(Get-ChildItem -LiteralPath (Join-Path $currencyFixture 'notebook/demoresto') -Force).Count) 'a refused restore wrote into the existing destination'
Remove-Item -LiteralPath (Join-Path $currencyFixture 'notebook/demoresto') -Recurse -Force
}
finally {
    if ($KeepFixture) { Write-Host "Fixture kept at $fixture" }
    else { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failures.Count) {
    [Console]::Error.WriteLine("Test-LibraryHelpers FAILED ($($failures.Count) of $($passed + $failures.Count)):")
    foreach ($f in $failures) { [Console]::Error.WriteLine("  - $f") }
    exit 1
}
Write-Host "Test-LibraryHelpers passed ($passed checks)."
exit 0
