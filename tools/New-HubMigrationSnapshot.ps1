<#
.SYNOPSIS
    Capture the pre-migration snapshot and the verifier manifest for the Library Development Hub's
    Now/Next migration, from one reader-approved migration plan.

.DESCRIPTION
    tools/Test-HubMigrationAcceptance.ps1 verifies a migration that has already happened. It throws
    on any of nine required snapshot fields, and nothing produced them. This is that producer.

    Three of the nine fields are not observations of the current page at all -- expected_post,
    orientation_prose, and open_items describe the page AFTER the migration. They cannot be captured;
    they have to be PREDICTED, and a prediction made by hand-reading the writer's source is a
    prediction that drifts. So this helper does not re-implement any of it:

      * The composition of the three writes is performed by Edit-ProjectHub.ps1's own body functions,
        imported from that file. The simulated post-migration page is therefore produced by the code
        that will produce the real one -- including Assert-NowStructure, so a migration whose own
        gated ReplaceSection would refuse it fails HERE, before an approval is spent on it.
      * Every field derived from that page is computed by Test-HubMigrationAcceptance.ps1's own
        parsers, imported from that file. A snapshot and the verifier that reads it cannot disagree
        about what a block, an open item, or a section is, because there is only one parser.

    Functions are imported by AST rather than by dot-sourcing, because both files are runnable
    scripts whose top level performs work. The names are whitelisted and a missing one is fatal, so
    a rename in either file stops this helper loudly instead of silently reverting to a stale copy.

    Read-only with respect to the Library: it reads the Hub through the validated reader adapter,
    exactly as the verifier does, and writes only into the caller's chosen output directory.
#>
[CmdletBinding()]
param(
    [string]$Plan,
    [string]$OutputDirectory,
    [string]$WorkspacePath,
    [switch]$SelfTest,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')

$script:Utf8 = [Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [Text.UTF8Encoding]::new($false, $true)

# --- Importing the two source files' own functions -------------------------------------------------

function Import-ScriptFunctionScope([string]$Path, [string[]]$Names, [string]$Preamble = '') {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Cannot import functions: '$Path' does not exist." }
    $text = [IO.File]::ReadAllText($Path, $script:Utf8Strict)
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$parseErrors)
    if ($null -ne $parseErrors -and @($parseErrors).Count -gt 0) { throw "Cannot import functions: '$Path' does not parse." }
    $defined = @{}
    foreach ($function in $ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        if (-not $defined.ContainsKey($function.Name)) { $defined[$function.Name] = $function.Extent.Text }
    }
    $missing = @($Names | Where-Object { -not $defined.ContainsKey($_) })
    if ($missing.Count) { throw "'$Path' no longer defines: $($missing -join ', '). This helper reads its behaviour from that file and will not guess." }
    $source = @('Set-StrictMode -Version Latest', "`$ErrorActionPreference = 'Stop'", $Preamble) + @($Names | ForEach-Object { $defined[$_] })
    New-Module -ScriptBlock ([scriptblock]::Create(($source -join "`n`n"))) -AsCustomObject
}

$script:HubFunctionNames = @(
    'ConvertTo-Lines', 'Join-Lines', 'Remove-TrailingBlank', 'Remove-Frontmatter',
    'Get-FencedLineMask', 'Get-Headings', 'Get-SectionSpan', 'Get-SectionText',
    'Test-ListLine', 'Get-TopLevelEntries', 'Test-LinesPreserved', 'Test-InsideList',
    'Get-ItemBlocks', 'Find-UniqueBlock', 'Set-CheckboxState',
    'New-ProjectBodyRaw', 'Test-LineSequenceInSpan', 'Assert-NowStructure', 'New-ProjectBody'
)

$script:VerifierFunctionNames = @(
    'Get-Property', 'Normalize-Text', 'Get-Hash', 'Get-HashBytes',
    'ConvertTo-CanonicalValue', 'Get-CanonicalHash', 'ConvertTo-Lines',
    'Get-FencedLineMask', 'Get-LevelTwoSections', 'Get-ItemBlocks', 'Get-OpenItems',
    'Get-OrientationBlocks', 'Invoke-ReaderCall', 'Assert-InputSchemas', 'Invoke-Assertions'
)

# Test-HubMigrationAcceptance.ps1 sets these two at its own script scope, outside every function it
# defines, and its hashing functions read them. Restated verbatim so the imported scope is the scope
# those functions were written for.
$script:VerifierPreamble = @'
$script:Utf8 = [Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [Text.UTF8Encoding]::new($false, $true)
'@

function Get-HubScope { Import-ScriptFunctionScope (Join-Path $PSScriptRoot 'Edit-ProjectHub.ps1') $script:HubFunctionNames }
function Get-VerifierScope { Import-ScriptFunctionScope (Join-Path $PSScriptRoot 'Test-HubMigrationAcceptance.ps1') $script:VerifierFunctionNames $script:VerifierPreamble }

# --- Plan blocks -----------------------------------------------------------------------------------
#
# Neither source file enumerates what this plan has to classify. Test-HubMigrationAcceptance.ps1's
# Get-ItemBlocks finds list items and stops at a blank line; Now's entries are a mix of column-zero
# bullets AND bold-lead paragraphs, and its wrapped bullets carry indented paragraphs separated by
# blank lines. Both shapes have to be nameable, so this defines the third thing: a plan block.
#
# A plan block starts at a non-blank, unfenced, column-zero line that is EITHER preceded by a blank
# line (or the start of the section) OR is itself a list marker -- the second clause is what keeps
# consecutive tight bullets apart instead of merging them into one block. It runs to the last
# non-blank line before the next start, so indented continuations and a wrapped item's own internal
# blank lines stay inside the item they belong to.

function Get-PlanBlocks([object]$HubScope, [string]$SectionText) {
    $lines = @($HubScope.'ConvertTo-Lines'.Invoke($SectionText))
    if ($lines.Count -gt 0 -and $lines[0] -cmatch '^[ ]{0,3}#{1,2}[ \t]+') { $lines = @($lines | Select-Object -Skip 1) }
    # `,$lines` is load-bearing. A script method's .Invoke() takes a params array, so .Invoke($lines)
    # SPREADS the array across the function's parameters and binds only its first line -- a mask one
    # element long, and an out-of-bounds read on the second line of every section.
    $fenced = @($HubScope.'Get-FencedLineMask'.Invoke((, $lines)))

    $starts = [Collections.Generic.List[int]]::new()
    $previousBlank = $true
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $blank = [string]::IsNullOrWhiteSpace($lines[$i])
        if (-not $blank -and -not $fenced[$i] -and $lines[$i] -cmatch '^\S') {
            if ($previousBlank -or $lines[$i] -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+') { [void]$starts.Add($i) }
        }
        $previousBlank = $blank
    }

    $blocks = [Collections.Generic.List[object]]::new()
    for ($k = 0; $k -lt $starts.Count; $k++) {
        $start = $starts[$k]
        $end = if ($k + 1 -lt $starts.Count) { $starts[$k + 1] - 1 } else { $lines.Count - 1 }
        while ($end -gt $start -and [string]::IsNullOrWhiteSpace($lines[$end])) { $end-- }
        $first = [string]$lines[$start]
        $marker = [bool]($first -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+')
        $status = if ($marker -and $first -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+\[([ xX])\](?:[ \t]+|$)') { $Matches[1] } else { $null }
        [void]$blocks.Add([pscustomobject][ordered]@{
            index = $blocks.Count + 1
            start = $start
            end = $end
            first_line = $first
            is_list_entry = $marker
            status = $status
            text = (@($lines[$start..$end]) -join "`n")
        })
    }
    [pscustomobject]@{ lines = @($lines); blocks = @($blocks) }
}

function Format-SectionContent([string[]]$Lines) {
    $result = [Collections.Generic.List[string]]::new()
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($result.Count -eq 0) { continue }
            if ([string]::IsNullOrWhiteSpace($result[$result.Count - 1])) { continue }
            [void]$result.Add('')
            continue
        }
        [void]$result.Add($line)
    }
    while ($result.Count -gt 0 -and [string]::IsNullOrWhiteSpace($result[$result.Count - 1])) { $result.RemoveAt($result.Count - 1) }
    @($result)
}

# --- Plan resolution -------------------------------------------------------------------------------

$script:Dispositions = @('closed', 'open', 'orientation')
$script:Rewrites = @('none', 'mark_open')

function Resolve-PlanSection([object]$HubScope, [object]$Parsed, [string]$SectionName, [object[]]$PlanItems) {
    $blocks = @($Parsed.blocks)
    $claimed = @{}
    $resolved = [Collections.Generic.List[object]]::new()

    foreach ($item in @($PlanItems)) {
        $names = @($item.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($required in @('id', 'section', 'anchor', 'disposition')) {
            if ($names -cnotcontains $required) { throw "Plan item in '$SectionName' is missing '$required'." }
        }
        $disposition = [string]$item.disposition
        if ($script:Dispositions -cnotcontains $disposition) { throw "Plan item '$($item.id)' has an unknown disposition '$disposition'." }
        $rewrite = if ($names -ccontains 'rewrite') { [string]$item.rewrite } else { 'none' }
        if ($script:Rewrites -cnotcontains $rewrite) { throw "Plan item '$($item.id)' has an unknown rewrite '$rewrite'." }

        $anchor = [string]$item.anchor
        $matched = @($blocks | Where-Object { $_.first_line -ceq $anchor })
        if ($matched.Count -eq 0) { throw "Plan item '$($item.id)' does not match any block in '$SectionName'. Its anchor must equal a block's first line exactly." }
        if ($matched.Count -gt 1) { throw "Plan item '$($item.id)' matches $($matched.Count) blocks in '$SectionName'; an anchor must be unique." }
        $block = $matched[0]
        if ($names -ccontains 'index' -and $null -ne $item.index -and [int]$item.index -ne [int]$block.index) {
            throw "Plan item '$($item.id)' names block index $([int]$item.index) but its anchor resolves to block $($block.index) of '$SectionName'; the page moved under the plan."
        }
        if ($claimed.ContainsKey([int]$block.index)) { throw "Block $($block.index) of '$SectionName' is claimed by both '$($claimed[[int]$block.index])' and '$($item.id)'." }
        $claimed[[int]$block.index] = [string]$item.id

        if ($disposition -ceq 'orientation' -and $block.is_list_entry) { throw "Plan item '$($item.id)' calls a list entry orientation prose; orientation prose is never a column-zero list entry." }
        if ($rewrite -ceq 'mark_open' -and $null -ne $block.status) { throw "Plan item '$($item.id)' asks to mark a block that already carries a status marker." }
        if ($disposition -ceq 'open' -and $rewrite -ceq 'none' -and $null -eq $block.status) { throw "Plan item '$($item.id)' keeps an unmarked entry open without marking it; 'Now' refuses an unmarked column-zero entry, so this migration would be refused by its own gate." }

        [void]$resolved.Add([pscustomobject][ordered]@{
            id = [string]$item.id
            section = $SectionName
            title = if ($names -ccontains 'title') { [string]$item.title } else { '' }
            disposition = $disposition
            rewrite = $rewrite
            block = $block
        })
    }

    $unclaimed = @($blocks | Where-Object { -not $claimed.ContainsKey([int]$_.index) })
    if ($unclaimed.Count) {
        $names = @($unclaimed | ForEach-Object { "$($_.index): $($_.first_line.Substring(0, [Math]::Min(70, $_.first_line.Length)))" })
        throw "The plan does not classify every block of '$SectionName'. Unclassified: $($names -join ' | '). An unclassified block is exactly what the verifier's expected_post assertion exists to catch, so it is refused here rather than dropped silently."
    }
    @($resolved)
}

# --- Simulating the three writes -------------------------------------------------------------------

function Set-EntryMarked([object]$Block) {
    $text = [string]$Block.text
    # An entry that is already a bullet only gains a checkbox inside its existing content, so the
    # marker width does not change and nothing downstream of the first line moves.
    if ($Block.is_list_entry) { return ($text -creplace '^((?:[-*+]|[0-9]+\.)[ \t]+)', '$1[ ] ') }

    # A bold-lead paragraph becomes an entry by gaining "- [ ] ". The marker "- " occupies the first
    # two columns, so the item's content column is 2. A line that merely wraps is a lazy continuation
    # and needs no indent -- but a paragraph starting after a BLANK line must be indented at least two
    # spaces, or it lands outside the item as its own block. On this page that block would be an
    # unmarked one, which is exactly what 'Now' refuses.
    $lines = @($text.Split("`n"))
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if (-not [string]::IsNullOrWhiteSpace($lines[$i - 1])) { continue }
        if ([string]::IsNullOrWhiteSpace($lines[$i])) { continue }
        if ($lines[$i] -cnotmatch '^(?: {2,}|\t)') {
            throw "Block $($Block.index) starts a paragraph after a blank line without indenting it at least two spaces, so a list marker would leave that paragraph outside the entry. Indent it, or split the block."
        }
    }
    "- [ ] $text"
}

function New-SectionContent([object[]]$Resolved) {
    $kept = [Collections.Generic.List[string]]::new()
    foreach ($entry in @($Resolved)) {
        if ($entry.disposition -ceq 'closed') { continue }
        $text = if ($entry.rewrite -ceq 'mark_open') { Set-EntryMarked $entry.block } else { [string]$entry.block.text }
        if ($kept.Count) { [void]$kept.Add('') }
        foreach ($line in @($text.Split("`n"))) { [void]$kept.Add($line) }
    }
    (@(Format-SectionContent @($kept)) -join "`n")
}

function New-AppendContent([object]$PlanEnvelope, [object[]]$Closed) {
    $names = @($PlanEnvelope.PSObject.Properties | ForEach-Object { $_.Name })
    $lines = [Collections.Generic.List[string]]::new()
    if ($names -ccontains 'destination_preamble') {
        foreach ($line in @($PlanEnvelope.destination_preamble)) { [void]$lines.Add([string]$line) }
    }
    foreach ($entry in @($Closed)) {
        if ($lines.Count) { [void]$lines.Add('') }
        foreach ($line in @(([string]$entry.block.text).Split("`n"))) { [void]$lines.Add($line) }
    }
    if ($lines.Count -eq 0) { throw 'The plan closes no items, so there is nothing to append.' }
    (@(Format-SectionContent @($lines)) -join "`n")
}

function Split-Frontmatter([object]$HubScope, [string]$NormalizedReaderText) {
    $body = [string]$HubScope.'Remove-Frontmatter'.Invoke($NormalizedReaderText)
    if (-not $NormalizedReaderText.EndsWith($body, [StringComparison]::Ordinal)) {
        throw 'The page body is not a suffix of the page the reader returned; frontmatter could not be separated without guessing.'
    }
    [pscustomobject]@{ frontmatter = $NormalizedReaderText.Substring(0, $NormalizedReaderText.Length - $body.Length); body = $body }
}

# --- The capture itself ----------------------------------------------------------------------------
#
# Pure: it takes the four reader-visible inputs as values and performs no I/O, so -SelfTest drives the
# whole pipeline against fixtures without a Desk, a network, or a workspace.

function New-HubMigrationCapture(
    [object]$HubScope,
    [object]$VerifierScope,
    [object]$PlanEnvelope,
    [string]$ProjectReaderText,
    [string]$HistoryReaderText,
    [object]$DeskOverview,
    [string]$BriefingText
) {
    $projectBefore = [string]$VerifierScope.'Normalize-Text'.Invoke($ProjectReaderText)
    $historyBefore = [string]$VerifierScope.'Normalize-Text'.Invoke($HistoryReaderText)

    $planNames = @($PlanEnvelope.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('destination_heading', 'items')) {
        if ($planNames -cnotcontains $required) { throw "The migration plan is missing '$required'." }
    }
    $planItems = @($PlanEnvelope.items)
    if ($planItems.Count -eq 0) { throw 'The migration plan classifies no items.' }
    $unknownSections = @($planItems | ForEach-Object { [string]$_.section } | Sort-Object -Unique | Where-Object { @('Now', 'Next') -cnotcontains $_ })
    if ($unknownSections.Count) { throw "The migration plan names section(s) this phase does not migrate: $($unknownSections -join ', ')." }

    $parsedBefore = $VerifierScope.'Get-LevelTwoSections'.Invoke($projectBefore)
    foreach ($section in @('Now', 'Next')) {
        if (-not $parsedBefore.sections.ContainsKey($section)) { throw "The Hub page has no '$section' section." }
    }

    $resolvedBySection = [ordered]@{}
    foreach ($section in @('Now', 'Next')) {
        $parsedSection = Get-PlanBlocks $HubScope ([string]$parsedBefore.sections[$section])
        $items = @($planItems | Where-Object { [string]$_.section -ceq $section })
        $resolvedBySection[$section] = @(Resolve-PlanSection $HubScope $parsedSection $section $items)
    }
    $resolved = @(@($resolvedBySection['Now']) + @($resolvedBySection['Next']))
    $closed = @($resolved | Where-Object { $_.disposition -ceq 'closed' })
    if ($closed.Count -eq 0) { throw 'The migration plan closes no items.' }

    $nowContent = New-SectionContent @($resolvedBySection['Now'])
    $nextContent = New-SectionContent @($resolvedBySection['Next'])
    foreach ($section in @('Now', 'Next')) {
        $content = if ($section -ceq 'Now') { $nowContent } else { $nextContent }
        if ([string]::IsNullOrWhiteSpace($content)) { throw "The plan would leave '$section' empty; ReplaceSection refuses empty content." }
    }
    $appendContent = New-AppendContent $PlanEnvelope @($closed)

    # --- Simulate, using the writer's own composition and its own Now guard ---
    $historyParts = Split-Frontmatter $HubScope $historyBefore
    $historyBodyAfter = [string]$HubScope.'New-ProjectBody'.Invoke($historyParts.body, 'AddSection', [string]$PlanEnvelope.destination_heading, $appendContent, '', $false)
    $historyAfter = $historyParts.frontmatter + $historyBodyAfter
    if (-not $historyAfter.StartsWith($historyBefore, [StringComparison]::Ordinal)) {
        throw 'The append would not leave the destination page byte-identical up to its current length; it rewrites existing content and the verifier would fail on destination_prefix.'
    }
    $appendedBatch = $historyAfter.Substring($historyBefore.Length)

    $projectParts = Split-Frontmatter $HubScope $projectBefore
    $bodyAfterNow = [string]$HubScope.'New-ProjectBody'.Invoke($projectParts.body, 'ReplaceSection', 'Now', $nowContent, '', $false)
    $bodyAfterNext = [string]$HubScope.'New-ProjectBody'.Invoke($bodyAfterNow, 'ReplaceSection', 'Next', $nextContent, '', $false)
    # The whole-page form of the same guard, run once more on the final body: the Next write does not
    # target Now and so never validates it, and a Now left holding an unmarked entry makes the
    # migration's own gated write refuse the migration.
    $HubScope.'Assert-NowStructure'.Invoke($projectParts.body, $bodyAfterNext, 'ReplaceBody', '', $bodyAfterNext) | Out-Null
    $projectAfter = $projectParts.frontmatter + $bodyAfterNext

    $parsedAfter = $VerifierScope.'Get-LevelTwoSections'.Invoke($projectAfter)

    # --- Assertions the verifier would otherwise discover only after the migration ran ---
    $namesBefore = @($parsedBefore.headings | ForEach-Object { [string]$_.name })
    $namesAfter = @($parsedAfter.headings | ForEach-Object { [string]$_.name })
    if (($namesBefore -join "`n") -cne ($namesAfter -join "`n")) {
        throw "The simulated migration changes the page's section set or order: before [$($namesBefore -join ', ')] / after [$($namesAfter -join ', ')]."
    }
    $preambleBefore = if ($parsedBefore.first_heading -eq 0) { '' } else { (@($parsedBefore.lines[0..($parsedBefore.first_heading - 1)]) -join "`n") }
    $preambleAfter = if ($parsedAfter.first_heading -eq 0) { '' } else { (@($parsedAfter.lines[0..($parsedAfter.first_heading - 1)]) -join "`n") }
    if ($preambleBefore -cne $preambleAfter) { throw 'The simulated migration changes the page preamble.' }

    # Derived from the page, never hard-coded. A name that does not resolve to a real heading would
    # hash the empty string and pass while proving nothing about the section it was meant to protect.
    $invariantNames = @($namesBefore | Where-Object { @('Now', 'Next') -cnotcontains $_ })
    if ($invariantNames.Count -eq 0) { throw 'The Hub page has no invariant sections to protect.' }
    $invariants = [ordered]@{}
    foreach ($name in $invariantNames) {
        $before = [string]$VerifierScope.'Normalize-Text'.Invoke($parsedBefore.sections[$name])
        $after = [string]$VerifierScope.'Normalize-Text'.Invoke($parsedAfter.sections[$name])
        if ($before -cne $after) { throw "The simulated migration changes the invariant section '$name'." }
        $invariants[$name] = [string]$VerifierScope.'Get-Hash'.Invoke($before)
    }

    $manifestItems = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($closed)) {
        $block = [string]$entry.block.text
        $preCount = ([regex]::Matches($historyBefore, [regex]::Escape($block))).Count
        if ($preCount -ne 0) {
            throw "Item '$($entry.id)' already occurs $preCount time(s) on the destination page. The contract is zero before the append and exactly one after; reconcile this item explicitly rather than carrying a pre-count forward."
        }
        $inBatch = ([regex]::Matches($appendedBatch, [regex]::Escape($block))).Count
        if ($inBatch -ne 1) { throw "Item '$($entry.id)' occurs $inBatch time(s) in the appended batch; it must occur exactly once. Two identical or nested blocks cannot both be counted." }
        $sectionAfter = [string]$VerifierScope.'Normalize-Text'.Invoke($parsedAfter.sections[[string]$entry.section])
        if ($sectionAfter.Contains($block)) { throw "Item '$($entry.id)' still occurs in '$($entry.section)' after the simulated removal; another surviving block contains its text." }
        [void]$manifestItems.Add([pscustomobject][ordered]@{
            id = $entry.id
            title = $entry.title
            source_section = $entry.section
            source_block = $block
            destination_pre_count = 0
        })
    }

    $expectedPost = [ordered]@{}
    foreach ($section in @('Now', 'Next')) {
        $body = [string]$VerifierScope.'Normalize-Text'.Invoke($parsedAfter.sections[$section])
        $expectedPost[$section] = [pscustomobject][ordered]@{ body = $body; sha256 = [string]$VerifierScope.'Get-Hash'.Invoke($body) }
    }
    $nowAfter = [string]$parsedAfter.sections['Now']
    $orientation = @(@($VerifierScope.'Get-OrientationBlocks'.Invoke($nowAfter)) | ForEach-Object {
        $body = [string]$VerifierScope.'Normalize-Text'.Invoke($_)
        [pscustomobject][ordered]@{ body = $body; sha256 = [string]$VerifierScope.'Get-Hash'.Invoke($body) }
    })
    $openItems = [pscustomobject][ordered]@{
        Now = @($VerifierScope.'Get-OpenItems'.Invoke($nowAfter))
        Next = @($VerifierScope.'Get-OpenItems'.Invoke([string]$parsedAfter.sections['Next']))
    }

    $historyBeforeBytes = $script:Utf8.GetBytes($historyBefore)
    $briefingBody = [string]$VerifierScope.'Normalize-Text'.Invoke($BriefingText)

    $snapshot = [pscustomobject][ordered]@{
        preamble = [pscustomobject][ordered]@{
            body = $preambleBefore
            sha256 = [string]$VerifierScope.'Get-Hash'.Invoke($preambleBefore)
            # Nothing is excluded, and that is measured rather than assumed. The verifier compares
            # this body exactly, so a frontmatter field that changed on every write would fail the
            # assertion no matter what this list said. Edit-ProjectHub strips frontmatter before
            # editing and Basic Memory regenerates it on write_note, so the question is whether it
            # regenerates identically. Tested 2026-08-25 on a real append through that exact path:
            # the destination page went 200,397 -> 206,690 bytes with the previous bytes preserved
            # as an exact prefix and the frontmatter character-identical. It carries title, type,
            # and permalink only. If a volatile field ever appears, the preamble assertion fails
            # loudly and this list is where the exclusion would be named.
            excluded_fields = @()
        }
        invariant_sections = [pscustomobject]$invariants
        expected_post = [pscustomobject]$expectedPost
        orientation_prose = $orientation
        open_items = $openItems
        desk_overview = [pscustomobject][ordered]@{ value = $DeskOverview; sha256 = [string]$VerifierScope.'Get-CanonicalHash'.Invoke($DeskOverview) }
        briefing = [pscustomobject][ordered]@{ body = $briefingBody; sha256 = [string]$VerifierScope.'Get-CanonicalHash'.Invoke($briefingBody) }
        destination = [pscustomobject][ordered]@{
            byte_length = $historyBeforeBytes.Length
            sha256 = [string]$VerifierScope.'Get-HashBytes'.Invoke($historyBeforeBytes)
            appended_batch = $appendedBatch
        }
        workflow_bytes = [pscustomobject][ordered]@{
            desk_overview = $script:Utf8.GetByteCount(([string]($VerifierScope.'ConvertTo-CanonicalValue'.Invoke($DeskOverview) | ConvertTo-Json -Compress -Depth 32)))
            briefing = $script:Utf8.GetByteCount($BriefingText)
            project_page = $script:Utf8.GetByteCount($ProjectReaderText)
        }
    }

    [pscustomobject][ordered]@{
        snapshot = $snapshot
        manifest_items = @($manifestItems)
        now_content = $nowContent
        next_content = $nextContent
        append_content = $appendContent
        project_after = $projectAfter
        history_after = $historyAfter
        resolved = @($resolved)
    }
}

# --- Reading the live workspace --------------------------------------------------------------------

function Read-DeskOverview([string]$Workspace) {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Get-DeskOverview.ps1') -WorkspacePath $Workspace -Json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Desk overview failed: $(($out | Select-Object -Last 4) -join ' | ')" }
    (($out | Out-String).Trim() | ConvertFrom-Json)
}

function Write-Utf8File([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Text, $script:Utf8)
    [IO.Path]::GetFullPath($Path)
}

# --- Self-test -------------------------------------------------------------------------------------

if ($SelfTest) {
    $checks = [Collections.Generic.List[object]]::new()
    function Assert-SelfTest([string]$Name, [bool]$Condition) {
        if (-not $Condition) { throw "New-HubMigrationSnapshot self-test failed: $Name" }
        [void]$checks.Add([pscustomobject]@{ check = $Name; result = 'pass' })
    }
    function Assert-Refused([string]$Name, [scriptblock]$Action, [string]$Fragment) {
        $message = ''
        try { & $Action; $message = '' }
        catch { $message = [string]$_.Exception.Message }
        if ([string]::IsNullOrEmpty($message)) { throw "New-HubMigrationSnapshot self-test failed: $Name was accepted." }
        if ($message.IndexOf($Fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "New-HubMigrationSnapshot self-test failed: $Name was refused for the wrong reason: $message"
        }
        [void]$checks.Add([pscustomobject]@{ check = $Name; result = 'pass' })
    }
    # A plan item is a bag of optional fields, so a variant is rebuilt rather than mutated: assigning
    # to a property a fixture happens not to carry throws instead of adding it.
    function New-PlanItemVariant([object]$Item, [hashtable]$Overrides) {
        $fields = [ordered]@{}
        foreach ($name in @($Item.PSObject.Properties | ForEach-Object { $_.Name })) { $fields[$name] = $Item.$name }
        foreach ($name in @($Overrides.Keys)) { $fields[[string]$name] = $Overrides[$name] }
        [pscustomobject]$fields
    }

    $hub = Get-HubScope
    $verifier = Get-VerifierScope
    Assert-SelfTest 'the writer''s own body functions import' ($null -ne $hub.'New-ProjectBody')
    Assert-SelfTest 'the verifier''s own parsers import' ($null -ne $verifier.'Get-OpenItems')

    # The fixture mirrors the shapes that actually occur on the Hub: a bold-lead paragraph entry, an
    # unmarked column-zero bullet entry, orientation prose that must survive untouched, an already
    # marked open item, a stale [x] item, a fenced bullet that is not an entry, an indented bullet
    # that is not an entry, and an invariant section whose heading carries a parenthesised suffix.
    $frontmatter = "---`ntitle: _project`ntype: note`npermalink: ai-library/projects/fixture/project`n---`n`n"
    $nowBody = @(
        '## Now',
        '',
        '**What this section is.** Orientation and open items only.',
        'It wraps onto a second line.',
        '',
        '**Open item - a bold-lead paragraph that is still live.** It has to survive AND be marked,',
        'because an unmarked column-zero entry is refused by the section guard.',
        '',
        '- **2026-08-01 - a closed bullet.** This one moves to history.',
        '  Its indented continuation moves with it.',
        '',
        '- **2026-08-02 - a second closed bullet.** This one moves too.',
        '',
        '- [ ] **An entry that already carries its marker.** It survives untouched.',
        '',
        '```text',
        '- not an entry: this bullet is inside a fence',
        '```',
        '',
        '  - not an entry: this bullet is indented',
        '',
        '**Open item - a bold-lead entry carrying its own indented paragraph.** It survives and is marked.',
        '',
        '  **Its second paragraph.** Indented two spaces, so it stays inside the entry once the marker lands.'
    ) -join "`n"
    $nextBody = @(
        '## Next',
        '',
        '- [ ] An open action that stays.',
        '- [x] **A stale closed item (2026-08-01).** It moves to history.',
        '- [ ] **A second open action.** It stays, with',
        '  an indented continuation.'
    ) -join "`n"
    $page = $frontmatter + (@(
        '# Fixture Hub',
        '',
        '## Purpose',
        '',
        'Why this exists.',
        '',
        $nowBody,
        '',
        $nextBody,
        '',
        '## Connected knowledge',
        '',
        '- A Book.',
        '',
        '## Connected tools',
        '',
        '- A helper.',
        '',
        '## Prior implementation (backed up, not on the Shelf)',
        '',
        'A heading whose name is not the shorthand the spec used.'
    ) -join "`n") + "`n"
    $history = "---`ntitle: history`ntype: note`npermalink: ai-library/projects/fixture/notes/history`n---`n`n# History`n`n## 2026-07-30 - An earlier move`n`nNothing here matches the fixture's entries.`n"
    $desk = [pscustomobject]@{ open_projects = @('projects/fixture'); open_books = @() }
    $briefing = "Project return briefing - Fixture Hub`n`nRelated Books to consider opening`n- A Book.`n"

    $planFixture = [pscustomobject]@{
        destination_heading = '2026-08-25 - The fixture migration'
        destination_preamble = @('> Moved verbatim from the Hub on 2026-08-25.')
        items = @(
            [pscustomobject]@{ id = 'now-1'; section = 'Now'; index = 1; anchor = '**What this section is.** Orientation and open items only.'; disposition = 'orientation'; title = 'What this section is' }
            [pscustomobject]@{ id = 'now-2'; section = 'Now'; index = 2; anchor = '**Open item - a bold-lead paragraph that is still live.** It has to survive AND be marked,'; disposition = 'open'; rewrite = 'mark_open'; title = 'Live bold-lead entry' }
            [pscustomobject]@{ id = 'now-3'; section = 'Now'; index = 3; anchor = '- **2026-08-01 - a closed bullet.** This one moves to history.'; disposition = 'closed'; title = 'First closed bullet' }
            [pscustomobject]@{ id = 'now-4'; section = 'Now'; index = 4; anchor = '- **2026-08-02 - a second closed bullet.** This one moves too.'; disposition = 'closed'; title = 'Second closed bullet' }
            [pscustomobject]@{ id = 'now-5'; section = 'Now'; index = 5; anchor = '- [ ] **An entry that already carries its marker.** It survives untouched.'; disposition = 'open'; title = 'Already marked' }
            [pscustomobject]@{ id = 'now-6'; section = 'Now'; index = 6; anchor = '**Open item - a bold-lead entry carrying its own indented paragraph.** It survives and is marked.'; disposition = 'open'; rewrite = 'mark_open'; title = 'Bold-lead entry with paragraphs' }
            [pscustomobject]@{ id = 'next-1'; section = 'Next'; index = 1; anchor = '- [ ] An open action that stays.'; disposition = 'open'; title = 'Open action' }
            [pscustomobject]@{ id = 'next-2'; section = 'Next'; index = 2; anchor = '- [x] **A stale closed item (2026-08-01).** It moves to history.'; disposition = 'closed'; title = 'Stale closed item' }
            [pscustomobject]@{ id = 'next-3'; section = 'Next'; index = 3; anchor = '- [ ] **A second open action.** It stays, with'; disposition = 'open'; title = 'Second open action' }
        )
    }

    $capture = New-HubMigrationCapture $hub $verifier $planFixture $page $history $desk $briefing

    # --- The round trip: the real verifier, run against the page this migration would produce ---
    $manifestData = @($capture.manifest_items)
    $verifier.'Assert-InputSchemas'.Invoke($capture.snapshot, $manifestData) | Out-Null
    Assert-SelfTest 'the snapshot satisfies the verifier''s own schema guard' $true
    $evaluated = $verifier.'Invoke-Assertions'.Invoke($capture.snapshot, $manifestData, $capture.project_after, $capture.history_after, $desk, $briefing, '40 passed, 0 warned, 0 failed, 0 skipped')
    $failed = @(@($evaluated.assertions) | Where-Object { $_.status -ceq 'fail' })
    Assert-SelfTest "every verifier assertion passes against the simulated result ($(@($evaluated.assertions).Count) assertions)" ($failed.Count -eq 0)

    # --- The shapes the reader was warned about ---
    $nowAfter = [string]($verifier.'Get-LevelTwoSections'.Invoke($capture.project_after)).sections['Now']
    $unmarked = @($hub.'Get-TopLevelEntries'.Invoke(@($hub.'ConvertTo-Lines'.Invoke($nowAfter)), 1, @($hub.'ConvertTo-Lines'.Invoke($nowAfter)).Count) | Where-Object { -not $_.has_status })
    Assert-SelfTest 'no column-zero entry survives in Now without a status marker' ($unmarked.Count -eq 0)
    Assert-SelfTest 'a surviving bold-lead entry is marked rather than dropped' ($nowAfter.Contains('- [ ] **Open item - a bold-lead paragraph that is still live.**'))
    Assert-SelfTest 'a marked entry that already had its marker is left alone' ($nowAfter.Contains('- [ ] **An entry that already carries its marker.** It survives untouched.'))
    Assert-SelfTest 'orientation prose survives verbatim' ($nowAfter.Contains('**What this section is.** Orientation and open items only.'))
    Assert-SelfTest 'a fenced bullet is not treated as an entry' ($nowAfter.Contains('- not an entry: this bullet is inside a fence'))
    Assert-SelfTest 'an indented bullet is not treated as an entry' ($nowAfter.Contains('  - not an entry: this bullet is indented'))
    # orientation_prose is the verifier's own reading of "every block that is not a top-level entry",
    # which is wider than prose: fenced content and an item's indented continuation after a blank line
    # both land in it. That is fine for an invariant -- the snapshot is computed by the same parser --
    # but it is why this asserts membership rather than a count.
    $orientationBodies = @(@($capture.snapshot.orientation_prose) | ForEach-Object { [string]$_.body })
    Assert-SelfTest 'a marked bold-lead entry keeps its indented paragraph inside the entry' (
        $nowAfter.Contains("- [ ] **Open item - a bold-lead entry carrying its own indented paragraph.** It survives and is marked.`n`n  **Its second paragraph.**")
    )
    Assert-SelfTest 'orientation_prose carries the standing prose block verbatim' (
        $orientationBodies -ccontains "**What this section is.** Orientation and open items only.`nIt wraps onto a second line."
    )
    Assert-SelfTest 'orientation_prose carries no marked entry' (
        @($orientationBodies | Where-Object { $_ -cmatch '(?m)^(?:[-*+]|[0-9]+\.)[ \t]+\[[ xX]\]' }).Count -eq 0
    )
    Assert-SelfTest 'orientation_prose drops a closed entry that used to precede it' (
        @($orientationBodies | Where-Object { $_.Contains('a closed bullet') }).Count -eq 0
    )
    Assert-SelfTest 'open_items counts every marked survivor in Now' (@($capture.snapshot.open_items.Now).Count -eq 3)
    Assert-SelfTest 'open_items drops the stale [x] entry from Next' (@($capture.snapshot.open_items.Next).Count -eq 2)
    Assert-SelfTest 'the manifest holds exactly the closed items' (@($capture.manifest_items).Count -eq 3)

    # --- The invariant set is derived, so a parenthesised heading is actually covered ---
    $invariantNames = @($capture.snapshot.invariant_sections.PSObject.Properties | ForEach-Object { $_.Name })
    Assert-SelfTest 'the invariant set is derived from the page, not a fixed list of four shorthand names' (
        $invariantNames.Count -eq 4 -and $invariantNames -ccontains 'Prior implementation (backed up, not on the Shelf)'
    )
    $priorHash = [string]$capture.snapshot.invariant_sections.'Prior implementation (backed up, not on the Shelf)'
    Assert-SelfTest 'an invariant section hash is the section, not the empty string' ($priorHash -cne [string]$verifier.'Get-Hash'.Invoke(''))

    # --- The destination contract: zero before, exactly one after, nothing lost ---
    $historyBefore = [string]$verifier.'Normalize-Text'.Invoke($history)
    Assert-SelfTest 'the destination prefix is the page as it stands' ($capture.snapshot.destination.byte_length -eq $script:Utf8.GetByteCount($historyBefore))
    Assert-SelfTest 'the appended batch is exactly the suffix the append produces' ($capture.history_after -ceq ($historyBefore + $capture.snapshot.destination.appended_batch))
    foreach ($item in @($capture.manifest_items)) {
        $count = ([regex]::Matches($capture.history_after, [regex]::Escape([string]$item.source_block))).Count
        Assert-SelfTest "closed item '$($item.id)' occurs exactly once in the destination" ($count -eq 1)
    }

    # --- Refusals ---
    Assert-Refused 'an unclassified block is refused' {
        $bad = $planFixture.PSObject.Copy(); $bad.items = @($planFixture.items | Where-Object { $_.id -cne 'now-5' })
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'does not classify every block'
    Assert-Refused 'an anchor that matches nothing is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @(@($planFixture.items | Where-Object { $_.id -cne 'now-5' }) + @([pscustomobject]@{ id = 'now-5'; section = 'Now'; anchor = '- [ ] a line that is not on the page'; disposition = 'open' }))
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'does not match any block'
    Assert-Refused 'two items claiming one block is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @(@($planFixture.items) + @([pscustomobject]@{ id = 'now-5b'; section = 'Now'; anchor = '- [ ] **An entry that already carries its marker.** It survives untouched.'; disposition = 'open' }))
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'claimed by both'
    Assert-Refused 'a stale block index is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @($planFixture.items | ForEach-Object { if ($_.id -ceq 'now-5') { New-PlanItemVariant $_ @{ index = 9 } } else { $_ } })
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'the page moved under the plan'
    Assert-Refused 'an unmarked entry kept open without marking is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @($planFixture.items | ForEach-Object { if ($_.id -ceq 'now-3') { New-PlanItemVariant $_ @{ disposition = 'open'; rewrite = 'none' } } else { $_ } })
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'refused by its own gate'
    Assert-Refused 'calling a list entry orientation prose is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @($planFixture.items | ForEach-Object { if ($_.id -ceq 'now-5') { New-PlanItemVariant $_ @{ disposition = 'orientation' } } else { $_ } })
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'never a column-zero list entry'
    Assert-Refused 'an item already present on the destination page is refused' {
        $polluted = $history + "`n- **2026-08-01 - a closed bullet.** This one moves to history.`n  Its indented continuation moves with it.`n"
        New-HubMigrationCapture $hub $verifier $planFixture $page $polluted $desk $briefing
    } 'contract is zero before the append'
    Assert-Refused 'a plan that closes everything in a section is refused' {
        $bad = $planFixture.PSObject.Copy()
        $bad.items = @($planFixture.items | ForEach-Object { if ($_.section -ceq 'Next') { New-PlanItemVariant $_ @{ disposition = 'closed'; rewrite = 'none' } } else { $_ } })
        New-HubMigrationCapture $hub $verifier $bad $page $history $desk $briefing
    } 'would leave'
    Assert-Refused 'a bold-lead entry whose later paragraph is under-indented is refused' {
        $underIndented = $page.Replace('  **Its second paragraph.**', ' **Its second paragraph.**')
        New-HubMigrationCapture $hub $verifier $planFixture $underIndented $history $desk $briefing
    } 'without indenting it at least two spaces'
    Assert-Refused 'a renamed function in a source file stops the import' {
        Import-ScriptFunctionScope (Join-Path $PSScriptRoot 'Edit-ProjectHub.ps1') @('New-ProjectBody', 'Get-NoSuchFunction')
    } 'no longer defines'

    Write-LibraryResult -Json:$Json -Result ([pscustomobject][ordered]@{
        operation = 'Hub migration snapshot self-test'
        checks = @($checks)
        passed = $checks.Count
        verifier_assertions = @($evaluated.assertions).Count
        shared_library_write = $false
    })
    return
}

# --- Live capture ----------------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Plan)) { throw 'Plan is required.' }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'OutputDirectory is required.' }
if (-not (Test-Path -LiteralPath $Plan -PathType Leaf)) { throw "Plan '$Plan' does not exist." }
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$planEnvelope = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Plan), $script:Utf8Strict) | ConvertFrom-Json
$planNames = @($planEnvelope.PSObject.Properties | ForEach-Object { $_.Name })
$projectSlug = if ($planNames -ccontains 'project_slug') { [string]$planEnvelope.project_slug } else { 'library-dev' }
$destinationPage = if ($planNames -ccontains 'destination_page') { [string]$planEnvelope.destination_page } else { 'notes/library-dev-history-2026-08-part-2' }

$hubScope = Get-HubScope
$verifierScope = Get-VerifierScope
$projectText = [string]$verifierScope.'Invoke-ReaderCall'.Invoke('read_open_project_page', @{ slug = $projectSlug; page = '_project' }, $workspace)
$historyText = [string]$verifierScope.'Invoke-ReaderCall'.Invoke('read_open_project_page', @{ slug = $projectSlug; page = $destinationPage }, $workspace)
$briefingText = [string]$verifierScope.'Invoke-ReaderCall'.Invoke('read_open_project_briefing', @{ slug = $projectSlug }, $workspace)
$deskOverview = Read-DeskOverview $workspace

$capture = New-HubMigrationCapture $hubScope $verifierScope $planEnvelope $projectText $historyText $deskOverview $briefingText

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
$root = (Resolve-Path -LiteralPath $OutputDirectory).Path
$snapshotPath = Write-Utf8File (Join-Path $root 'snapshot.json') (($capture.snapshot | ConvertTo-Json -Depth 32) + "`n")
$manifestPath = Write-Utf8File (Join-Path $root 'manifest.json') ((([pscustomobject][ordered]@{
    project_slug = $projectSlug
    destination_page = $destinationPage
    destination_heading = [string]$planEnvelope.destination_heading
    items = @($capture.manifest_items)
}) | ConvertTo-Json -Depth 32) + "`n")
# The three writes take their content from these files verbatim. Retyping any of them changes the
# text the snapshot already predicted, and expected_post or destination_suffix would then fail.
$appendPath = Write-Utf8File (Join-Path $root 'append-content.md') ($capture.append_content + "`n")
$nowPath = Write-Utf8File (Join-Path $root 'now-content.md') ($capture.now_content + "`n")
$nextPath = Write-Utf8File (Join-Path $root 'next-content.md') ($capture.next_content + "`n")

function Measure-Disposition([object[]]$Resolved, [string]$Section, [string]$Disposition) {
    @(@($Resolved) | Where-Object { $_.section -ceq $Section -and $_.disposition -ceq $Disposition }).Count
}
$resolved = @($capture.resolved)

$result = [pscustomobject][ordered]@{
    operation = 'Hub migration snapshot'
    status = 'captured'
    project_slug = $projectSlug
    destination_page = $destinationPage
    destination_heading = [string]$planEnvelope.destination_heading
    snapshot_path = $snapshotPath
    manifest_path = $manifestPath
    append_content_path = $appendPath
    now_content_path = $nowPath
    next_content_path = $nextPath
    now = [pscustomobject][ordered]@{
        blocks = @(@($resolved) | Where-Object { $_.section -ceq 'Now' }).Count
        closed = Measure-Disposition $resolved 'Now' 'closed'
        open = Measure-Disposition $resolved 'Now' 'open'
        orientation = Measure-Disposition $resolved 'Now' 'orientation'
    }
    next = [pscustomobject][ordered]@{
        blocks = @(@($resolved) | Where-Object { $_.section -ceq 'Next' }).Count
        closed = Measure-Disposition $resolved 'Next' 'closed'
        open = Measure-Disposition $resolved 'Next' 'open'
        orientation = Measure-Disposition $resolved 'Next' 'orientation'
    }
    page_bytes_before = $script:Utf8.GetByteCount($projectText)
    page_bytes_after = $script:Utf8.GetByteCount($capture.project_after)
    appended_batch_bytes = $script:Utf8.GetByteCount([string]$capture.snapshot.destination.appended_batch)
    invariant_sections = @($capture.snapshot.invariant_sections.PSObject.Properties | ForEach-Object { $_.Name })
    migration_performed = $false
    shared_library_write = $false
}
Write-LibraryResult -Result $result -Json:$Json -Depth 16
