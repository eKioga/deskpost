[CmdletBinding()]
param(
    [string]$ProjectSlug,
    [string]$Page = '_project',
    [ValidateSet('AddSection', 'AppendSection', 'RemoveSection', 'ReplaceSection', 'ReplaceBody', 'CheckItem', 'ReplaceItem')]
    [string]$Mode,
    [string]$Section,
    [string]$MatchText,
    [switch]$Uncheck,
    [string]$Content,
    [string]$ContentPath,
    [string]$WorkspacePath,
    # Which seat's Desk gates this run. Defaults to LIBRARY_SEAT; there is no default seat.
    [string]$Seat,
    [string]$ProjectId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$JournalPath,
    [int]$LockTimeoutSeconds = 20,
    [string]$ApprovedPlanId,
    [switch]$UserConfirmed,
    [switch]$Preflight,
    [switch]$Json,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
# Enter-BookLock, for the projects/<slug> lock this helper now holds across its whole write.
# PLAN-multi-desk.md Release 1, step 5.
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'LibraryDeployment.ps1')
# STEP 21: ONE WRITABLE WORKSPACE PER COLLECTION. Resolve-LibraryWriteEndpoint is
# Resolve-LibraryMcpUrl plus the ownership fence, and every shared writer reaches the collection
# through it. tools/CollectionOwnership.ps1, checked by collection.write-fence-coverage.
. (Join-Path $PSScriptRoot 'CollectionOwnership.ps1')
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
$script:HubPageSizeWarningThresholdBytes = 40000
# Calibrated against real data on 2026-08-26, not guessed: this Hub's root was 28,657 bytes -- under
# the whole-page threshold, and therefore silent -- while its Now section alone was 15,474 and Next
# was 10,716. A page-level check cannot see the section that is actually the problem, so 12,000 sits
# above Next and below Now, catching the one that had already gone wrong.
$script:HubSectionSizeWarningThresholdBytes = 12000

# A section is a sum; an entry is the thing a writer controls at the moment of writing. Calibrated
# on 2026-08-26 against all 74 top-level entries on this Hub's two largest pages: the well-formed
# norm runs 74-1,170 bytes and the outliers start at 1,240, so 1,200 sits in the gap between them.
# It names 5 of the root's 9 Now entries -- the five carrying 12,314 of that section's 15,474 -- and
# 4 of the curated connections page's 53, leaving the other 49 silent.
$script:HubEntrySizeWarningThresholdBytes = 1200

# A refusal is an answer, not a crash: report the reason without the script's internal position.
trap {
    $PSCmdlet.ThrowTerminatingError(
        (New-Object Management.Automation.ErrorRecord($_.Exception, 'EditProjectHubStopped', [Management.Automation.ErrorCategory]::InvalidOperation, $null)))
}

# ---------------------------------------------------------------------------
# Body editing. These functions are pure text and are covered by -SelfTest.
# ---------------------------------------------------------------------------

function ConvertTo-Lines([string]$Text) {
    if ($null -eq $Text) { return @() }
    @(([string]$Text).Replace("`r`n", "`n").Replace("`r", "`n").Split("`n"))
}

function Join-Lines([string[]]$Lines) {
    (($Lines -join "`n").TrimEnd("`n")) + "`n"
}

function Remove-TrailingBlank([string[]]$Lines) {
    $end = $Lines.Count
    while ($end -gt 0 -and [string]::IsNullOrWhiteSpace($Lines[$end - 1])) { $end-- }
    if ($end -eq 0) { return @() }
    @($Lines[0..($end - 1)])
}

function Remove-Frontmatter([string]$Text) {
    $body = [string]$Text
    if ($body -match '(?s)^---\r?\n.*?\r?\n---\r?\n(.*)$') { return $Matches[1].TrimStart("`r", "`n") }
    $body
}

# Headings inside fenced code blocks are content, not structure. The migration tools
# learned this the hard way by scanning links without skipping fences.
function Get-FencedLineMask([string[]]$Lines) {
    $mask = [bool[]]::new($Lines.Count)
    $fenceCharacter = ''
    $fenceLength = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ([string]::IsNullOrEmpty($fenceCharacter)) {
            if ($line -cmatch '^[ ]{0,3}((`{3,}|~{3,}))(.*)$') {
                $delimiter = $Matches[1]
                $fenceCharacter = $delimiter.Substring(0, 1)
                $fenceLength = $delimiter.Length
                $mask[$i] = $true
            }
            continue
        }

        $mask[$i] = $true
        $escaped = [regex]::Escape($fenceCharacter)
        if ($line -cmatch ('^[ ]{0,3}(' + $escaped + '{' + $fenceLength + ',})\s*$')) {
            $fenceCharacter = ''
            $fenceLength = 0
        }
    }
    $mask
}

function Get-Headings([string[]]$Lines) {
    $fenced = @(Get-FencedLineMask $Lines)
    $found = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ($fenced[$i]) { continue }
        if ($line -cmatch '^[ ]{0,3}(#{1,2})[ \t]+(.+?)[ \t]*$') {
            [void]$found.Add([pscustomobject]@{ index = $i; level = $Matches[1].Length; text = $Matches[2] })
        }
    }
    @($found)
}

function Get-SectionSpan([string[]]$Lines, [string]$Section) {
    $headings = @(Get-Headings $Lines)
    $start = -1
    foreach ($heading in $headings) {
        if ($heading.level -eq 2 -and $heading.text -ceq $Section) {
            if ($start -ge 0) { throw "Section '$Section' appears more than once on this page; edit it by hand or name a unique section." }
            $start = $heading.index
        }
    }
    if ($start -lt 0) { return $null }
    $end = $Lines.Count
    foreach ($heading in $headings) { if ($heading.index -gt $start) { $end = $heading.index; break } }
    [pscustomobject]@{ start = $start; end = $end }
}

function Get-SectionText([string[]]$Lines, $Span) {
    if ($null -eq $Span) { return '' }
    $body = @(Remove-TrailingBlank @($Lines[$Span.start..($Span.end - 1)]))
    ($body -join "`n")
}

function Test-ListLine([string]$Line) {
    [bool]($Line -match '^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+')
}

function Get-TopLevelEntries([string[]]$Lines, [int]$Start, [int]$End) {
    $fenced = @(Get-FencedLineMask $Lines)
    $entries = [Collections.Generic.List[object]]::new()
    for ($i = $Start; $i -lt $End; $i++) {
        if (-not $fenced[$i] -and $Lines[$i] -cmatch '^(?:[-*+]|[0-9]+\.)[ \t]+(.*)$') {
            $status = $Matches[1] -cmatch '^\[[ xX]\](?:[ \t]+|$)'
            [void]$entries.Add([pscustomobject]@{ index = $i; line = $Lines[$i]; has_status = $status })
        }
    }
    @($entries)
}

function Test-LinesPreserved([string[]]$Old, [string[]]$New) {
    $oldMeaningful = @($Old | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $newMeaningful = @($New | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $cursor = 0
    foreach ($line in $oldMeaningful) {
        while ($cursor -lt $newMeaningful.Count -and $newMeaningful[$cursor] -cne $line) { $cursor++ }
        if ($cursor -ge $newMeaningful.Count) { return $false }
        $cursor++
    }
    $true
}

# A wrapped list item continues onto indented lines, so the last line of a list section is
# usually continuation prose rather than a bullet. Walk back to decide.
function Test-InsideList([string[]]$Lines) {
    for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
        $line = $Lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { return $false }
        if (Test-ListLine $line) { return $true }
        if ($line -match '^[ \t]+\S') { continue }
        return $false
    }
    $false
}

# One list item is its marker line plus the indented lines that wrap it.
function Get-ItemBlocks([string[]]$Lines, [int]$Start, [int]$End) {
    $blocks = [Collections.Generic.List[object]]::new()
    $index = $Start
    while ($index -lt $End) {
        if (Test-ListLine $Lines[$index]) {
            $last = $index
            $scan = $index + 1
            while ($scan -lt $End -and -not (Test-ListLine $Lines[$scan]) -and $Lines[$scan] -match '^[ \t]+\S') { $last = $scan; $scan++ }
            [void]$blocks.Add([pscustomobject]@{ start = $index; end = $last; kind = 'item' })
            $index = $scan
            continue
        }
        if (-not [string]::IsNullOrWhiteSpace($Lines[$index])) {
            [void]$blocks.Add([pscustomobject]@{ start = $index; end = $index; kind = 'line' })
        }
        $index++
    }
    @($blocks)
}

function Find-UniqueBlock([string[]]$Lines, [int]$Start, [int]$End, [string]$MatchText) {
    if ([string]::IsNullOrWhiteSpace($MatchText)) { throw 'MatchText is required: give text that appears in exactly one item or line.' }
    $matched = @(Get-ItemBlocks $Lines $Start $End | Where-Object {
        (($Lines[$_.start..$_.end]) -join ' ').Contains($MatchText)
    })
    if ($matched.Count -eq 0) { throw "No item or line contains '$MatchText'." }
    if ($matched.Count -gt 1) {
        $preview = ($matched | ForEach-Object { $Lines[$_.start].Trim() } | Select-Object -First 4) -join ' | '
        throw "'$MatchText' matches $($matched.Count) items; give text unique to one. Matches begin: $preview"
    }
    $matched[0]
}

function Set-CheckboxState([string]$Line, [bool]$Checked) {
    if ($Line -notmatch '^([ \t]*(?:[-*+]|[0-9]+\.)[ \t]+)\[([ xX])\](.*)$') {
        throw "That item is not a checkbox: $($Line.Trim())"
    }
    $marker = if ($Checked) { 'x' } else { ' ' }
    $Matches[1] + '[' + $marker + ']' + $Matches[3]
}

# `Now` is orientation and open items; session narrative belongs on a dated notes/ history page.
# See docs/project-hub-design.md. A nudge and deliberately not a refusal: an open item may
# legitimately carry a date, and a guard that cannot tell a log entry from a live one would block
# real content. The rule this replaces tried to be mechanical -- a word count -- and fired in both
# wrong directions within two days.
function New-ProjectBodyRaw([string]$CurrentBody, [string]$Mode, [string]$Section, [string]$Content, [string]$MatchText, [bool]$Uncheck) {
    $lines = @(ConvertTo-Lines $CurrentBody)
    $addition = @(Remove-TrailingBlank @(ConvertTo-Lines $Content))
    $itemModes = @('CheckItem', 'ReplaceItem')
    if ($Mode -eq 'RemoveSection') {
        if (-not [string]::IsNullOrWhiteSpace($Content)) { throw 'RemoveSection takes no content.' }
        if (-not [string]::IsNullOrWhiteSpace($MatchText)) { throw 'RemoveSection takes no MatchText.' }
        if ($Section -ceq 'Purpose' -or $Section -ceq 'Now' -or $Section -ceq 'Next') {
            throw "Section '$Section' is structural and cannot be removed."
        }
    }
    if ($Mode -notin @('ReplaceBody', 'CheckItem', 'RemoveSection') -and $addition.Count -eq 0) { throw 'The supplied content is empty.' }

    if ($Mode -in $itemModes) {
        $start = 0
        $end = $lines.Count
        if (-not [string]::IsNullOrWhiteSpace($Section)) {
            $itemSpan = Get-SectionSpan $lines $Section
            if ($null -eq $itemSpan) { throw "Section '$Section' was not found." }
            $start = $itemSpan.start + 1
            $end = $itemSpan.end
        }
        $block = Find-UniqueBlock $lines $start $end $MatchText
        $result = @()
        if ($block.start -gt 0) { $result += @($lines[0..($block.start - 1)]) }
        if ($Mode -eq 'CheckItem') {
            $updated = Set-CheckboxState $lines[$block.start] (-not $Uncheck)
            $result += $updated
            if ($block.end -gt $block.start) { $result += @($lines[($block.start + 1)..$block.end]) }
        }
        else {
            $result += $addition
        }
        if ($block.end + 1 -lt $lines.Count) { $result += @($lines[($block.end + 1)..($lines.Count - 1)]) }
        return (Join-Lines $result)
    }

    if ($Mode -eq 'ReplaceBody') {
        if ($addition.Count -eq 0) { throw 'ReplaceBody requires a non-empty body.' }
        return (Join-Lines $addition)
    }

    $span = Get-SectionSpan $lines $Section
    if ($Mode -eq 'AddSection') {
        if ($null -ne $span) { throw "Section '$Section' already exists; use AppendSection or ReplaceSection." }
        $kept = @(Remove-TrailingBlank $lines)
        $result = @()
        if ($kept.Count) { $result += $kept; $result += '' }
        $result += "## $Section"
        $result += ''
        $result += $addition
        return (Join-Lines $result)
    }

    if ($null -eq $span) {
        $available = @(Get-Headings $lines | Where-Object { $_.level -eq 2 } | ForEach-Object { $_.text })
        $list = if ($available.Count) { $available -join ', ' } else { '(none)' }
        throw "Section '$Section' was not found. Level-two sections on this page: $list."
    }

    $before = @()
    if ($span.start -gt 0) { $before = @($lines[0..($span.start - 1)]) }
    $after = @()
    if ($span.end -lt $lines.Count) { $after = @($lines[$span.end..($lines.Count - 1)]) }
    $sectionLines = @(Remove-TrailingBlank @($lines[$span.start..($span.end - 1)]))

    if ($Mode -eq 'RemoveSection') {
        $kept = @(Remove-TrailingBlank $before)
        $result = @()
        if ($kept.Count) { $result += $kept }
        if ($kept.Count -and $after.Count) { $result += '' }
        if ($after.Count) { $result += $after }
        return (Join-Lines $result)
    }

    $result = @()
    $result += $before
    if ($Mode -eq 'AppendSection') {
        $result += $sectionLines
        # A bullet added to a list continues that list; prose gets its own paragraph break.
        # The section's last line is often a wrapped item's continuation, not the marker line.
        $continuesList = (Test-InsideList $sectionLines) -and (Test-ListLine $addition[0])
        if (-not $continuesList) { $result += '' }
        $result += $addition
    }
    else {
        $result += $sectionLines[0]
        $result += ''
        $result += $addition
    }
    if ($after.Count) {
        $result += ''
        $result += $after
    }
    Join-Lines $result
}

function Test-LineSequenceInSpan([string[]]$Lines, [string[]]$Needle, $Span) {
    if ($Needle.Count -eq 0 -or $null -eq $Span) { return $false }
    $lastStart = $Span.end - $Needle.Count
    for ($start = $Span.start + 1; $start -le $lastStart; $start++) {
        $same = $true
        for ($offset = 0; $offset -lt $Needle.Count; $offset++) {
            if ($Lines[$start + $offset] -cne $Needle[$offset]) { $same = $false; break }
        }
        if ($same) { return $true }
    }
    $false
}

function Assert-NowStructure([string]$CurrentBody, [string]$ProposedBody, [string]$Mode, [string]$Section, [string]$Content) {
    if ($Mode -eq 'CheckItem') { return }
    $introducingModes = @('AppendSection', 'AddSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem')
    if ($Mode -notin $introducingModes) { return }

    $proposedLines = @(ConvertTo-Lines $ProposedBody)
    $proposedSpan = Get-SectionSpan $proposedLines 'Now'
    if ($null -eq $proposedSpan) { return }

    $targetsNow = $Mode -eq 'ReplaceBody' -or $Section -ceq 'Now'
    if ($Mode -eq 'ReplaceItem' -and -not $targetsNow) {
        $currentLines = @(ConvertTo-Lines $CurrentBody)
        $currentSpan = Get-SectionSpan $currentLines 'Now'
        if ($null -ne $currentSpan) {
            $targetsNow = (Get-SectionText $currentLines $currentSpan) -cne (Get-SectionText $proposedLines $proposedSpan)
        }
    }
    if (-not $targetsNow) { return }

    if ($Mode -ne 'ReplaceBody') {
        $contentLines = @(Remove-TrailingBlank @(ConvertTo-Lines $Content))
        $structural = @(Get-Headings $contentLines | Where-Object { $_.level -le 2 })
        if ($structural.Count -gt 0) {
            throw "Content targeting 'Now' must not contain a level-one or level-two heading."
        }
        if (-not (Test-LineSequenceInSpan $proposedLines $contentLines $proposedSpan)) {
            throw "The resulting 'Now' section does not contain the entire intended addition; the edit stopped without writing."
        }
    }

    $unmarked = @(Get-TopLevelEntries $proposedLines ($proposedSpan.start + 1) $proposedSpan.end | Where-Object { -not $_.has_status })
    if ($unmarked.Count -gt 0) {
        throw "Every column-zero list entry in 'Now' requires a status marker; add - [ ] or - [x]."
    }
}

function New-ProjectBody([string]$CurrentBody, [string]$Mode, [string]$Section, [string]$Content, [string]$MatchText, [bool]$Uncheck) {
    $proposed = New-ProjectBodyRaw $CurrentBody $Mode $Section $Content $MatchText $Uncheck
    Assert-NowStructure $CurrentBody $proposed $Mode $Section $Content
    $proposed
}

function Get-ChangeCounts([string]$OldBody, [string]$NewBody) {
    $oldLines = @(ConvertTo-Lines $OldBody | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $newLines = @(ConvertTo-Lines $NewBody | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $oldCounts = @{}
    foreach ($line in $oldLines) { if ($oldCounts.ContainsKey($line)) { $oldCounts[$line]++ } else { $oldCounts[$line] = 1 } }
    $added = 0
    foreach ($line in $newLines) {
        if ($oldCounts.ContainsKey($line) -and $oldCounts[$line] -gt 0) { $oldCounts[$line]-- } else { $added++ }
    }
    $removed = 0
    foreach ($value in $oldCounts.Values) { $removed += $value }
    [pscustomobject]@{ added_lines = $added; removed_lines = $removed }
}

function Get-Sha256([string]$Text) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($hash.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

# Dated notes/ history pages are append-only by design and carry no size limit -- the Hub's own seed
# text says so. Warning on one is noise, and the advice "move history to a dated notes/ page" is
# nonsense on a page that already is one. Found the way these are always found: by the first live
# append after the warning shipped, onto a 252,440-byte history page.
# `notes/` is append-only narrative and `limits` is a ledger of accepted limits (ADR-0013). Neither
# orients anyone, so neither has a size worth warning about -- and capping the limits page would
# recreate the very pressure that made a Now section accumulate them: an accepted limit must be free
# to sit there forever at no cost, or it gets narrowed, or it stays in Now.
function Test-HubPageSizeExempt([string]$PagePath) {
    ([string]$PagePath).Replace('\', '/') -cmatch '(^|/)(notes/|limits(\.md)?$)'
}

function Get-HubPageSizeStatus([string]$Body, [int]$ThresholdBytes = $script:HubPageSizeWarningThresholdBytes, [string]$PagePath = '') {
    $sizeBytes = [Text.UTF8Encoding]::new($false).GetByteCount($Body)
    $exempt = Test-HubPageSizeExempt $PagePath
    $oversized = ($sizeBytes -gt $ThresholdBytes)
    [pscustomobject]@{
        size_bytes = $sizeBytes
        threshold_bytes = $ThresholdBytes
        oversized = $oversized
        exempt = $exempt
        warn = ($oversized -and -not $exempt)
    }
}

# The remedy has to fit the page it is given, or it is worse than silence. Telling the companion
# connections page to "move connections to the companion connections page" is the same circular
# advice the notes/ exemption fixed, one page over -- and it was 8.5 KB from firing when this landed.
function Get-HubPageSizeRemedy([string]$PagePath) {
    $normalized = ([string]$PagePath).Replace('\', '/')
    if ($normalized -cmatch '(^|/)connections\.md$') {
        return 'Prune entries that no longer earn their place, or split them onto topic pages.'
    }
    if ($normalized -cmatch '(^|/)_project\.md$') {
        return 'Move history to a dated notes/ page, connections to the companion connections page, and accepted limits to the limits page (ADR-0013).'
    }
    'Move detail onto a linked page and keep this one to what a reader needs on arrival.'
}

# Sections are enumerated straight from Get-Headings rather than through Get-SectionSpan, because
# that one throws on a duplicate heading. A warning must never be the thing that fails a good write.
function Get-HubSectionSizes([string]$Body) {
    $lines = @(ConvertTo-Lines $Body)
    $headings = @(Get-Headings $lines | Where-Object { $_.level -eq 2 })
    $utf8 = [Text.UTF8Encoding]::new($false)
    $sizes = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $headings.Count; $i++) {
        $start = $headings[$i].index
        $end = if (($i + 1) -lt $headings.Count) { $headings[$i + 1].index } else { $lines.Count }
        $bytes = 0
        for ($j = $start; $j -lt $end; $j++) { $bytes += ($utf8.GetByteCount($lines[$j]) + 1) }
        [void]$sizes.Add([pscustomobject]@{ section = $headings[$i].text; size_bytes = $bytes })
    }
    @($sizes)
}

function Get-HubSectionSizeTotals([string]$Body) {
    $totals = @{}
    foreach ($section in @(Get-HubSectionSizes $Body)) {
        # Summed rather than assigned: a duplicate heading must not make one of its copies invisible.
        if ($totals.ContainsKey($section.section)) { $totals[$section.section] += $section.size_bytes }
        else { $totals[$section.section] = $section.size_bytes }
    }
    $totals
}

# Delta-scoped on purpose. Now has been over 12,000 bytes since the threshold shipped, so warning on
# every write to the page said something true, identical, and unactionable each time -- the cry-wolf
# pattern that made the original whole-page warning useless. A warning earns its line only when this
# write is what made the section bigger: an oversized section nobody touched is not this write's
# business, and one that just got smaller has already been acted on. With no PreviousBody the
# comparison is skipped and every oversized section is warnable, which is what measuring a page on
# its own wants.
function Get-HubSectionSizeStatus([string]$Body, [int]$ThresholdBytes = $script:HubSectionSizeWarningThresholdBytes, [string]$PagePath = '', [AllowNull()][string]$PreviousBody = $null) {
    $exempt = Test-HubPageSizeExempt $PagePath
    $oversized = @(Get-HubSectionSizes $Body | Where-Object { $_.size_bytes -gt $ThresholdBytes })
    $warned = $oversized
    if ($null -ne $PreviousBody) {
        $before = Get-HubSectionSizeTotals $PreviousBody
        $after = Get-HubSectionSizeTotals $Body
        $warned = @($oversized | Where-Object {
            $priorSize = if ($before.ContainsKey($_.section)) { $before[$_.section] } else { 0 }
            $after[$_.section] -gt $priorSize
        })
    }
    [pscustomobject]@{
        threshold_bytes = $ThresholdBytes
        exempt = $exempt
        oversized_sections = $oversized
        warned_sections = @($warned)
        warn = ((@($warned).Count -gt 0) -and -not $exempt)
    }
}

# The first line of an entry, condensed to something a warning can name without reprinting it.
function Get-HubEntryLabel([string]$Line) {
    $text = ([string]$Line) -creplace '^[ \t]*(?:[-*+]|[0-9]+\.)[ \t]+', ''
    $text = $text -creplace '^\[[ xX]\][ \t]*', ''
    $text = ($text -replace '\s+', ' ').Trim()
    if ($text.Length -le 60) { return $text }
    # Never cut between a surrogate pair: half a character in a warning is a mystery, not a name.
    $cut = 60
    if ([char]::IsHighSurrogate($text[$cut - 1])) { $cut-- }
    $text.Substring(0, $cut).TrimEnd() + '...'
}

# The section warning names a sum; this names the thing a writer can actually shorten. Measured
# 2026-08-26: the root's Now section held 15,474 bytes across 9 entries with 0 of them closed, so
# nothing was stale -- the bytes were entry length, and no rule anywhere addressed entry length. An
# entry runs from its column-zero marker to the next one, so its wrapped continuation lines and
# indented paragraphs count against it, which is where the length actually goes.
function Get-HubEntrySizes([string]$Body) {
    $lines = @(ConvertTo-Lines $Body)
    $headings = @(Get-Headings $lines | Where-Object { $_.level -eq 2 })
    $utf8 = [Text.UTF8Encoding]::new($false)
    $sizes = [Collections.Generic.List[object]]::new()
    for ($h = 0; $h -lt $headings.Count; $h++) {
        $sectionStart = $headings[$h].index
        $sectionEnd = if (($h + 1) -lt $headings.Count) { $headings[$h + 1].index } else { $lines.Count }
        $entries = @(Get-TopLevelEntries $lines ($sectionStart + 1) $sectionEnd)
        for ($e = 0; $e -lt $entries.Count; $e++) {
            $start = $entries[$e].index
            $end = if (($e + 1) -lt $entries.Count) { $entries[$e + 1].index } else { $sectionEnd }
            $bytes = 0
            for ($j = $start; $j -lt $end; $j++) { $bytes += ($utf8.GetByteCount($lines[$j]) + 1) }
            [void]$sizes.Add([pscustomobject]@{
                section = $headings[$h].text
                # A newline cannot occur inside either half, so the pair is an unambiguous identity.
                key = $headings[$h].text + "`n" + $entries[$e].line
                label = Get-HubEntryLabel $entries[$e].line
                size_bytes = $bytes
            })
        }
    }
    @($sizes)
}

function Get-HubEntrySizeStatus([string]$Body, [int]$ThresholdBytes = $script:HubEntrySizeWarningThresholdBytes, [string]$PagePath = '', [AllowNull()][string]$PreviousBody = $null) {
    $exempt = Test-HubPageSizeExempt $PagePath
    $oversized = @(Get-HubEntrySizes $Body | Where-Object { $_.size_bytes -gt $ThresholdBytes })
    $warned = $oversized
    if ($null -ne $PreviousBody) {
        $before = @{}
        foreach ($entry in @(Get-HubEntrySizes $PreviousBody)) {
            if (-not $before.ContainsKey($entry.key)) { $before[$entry.key] = $entry.size_bytes }
        }
        # An entry whose first line changed is a new key, and so counts as new: either way this write
        # produced the text being complained about, which is exactly when the advice can be acted on.
        $warned = @($oversized | Where-Object { -not $before.ContainsKey($_.key) -or $_.size_bytes -gt $before[$_.key] })
    }
    [pscustomobject]@{
        threshold_bytes = $ThresholdBytes
        exempt = $exempt
        oversized_entries = $oversized
        warned_entries = @($warned)
        warn = ((@($warned).Count -gt 0) -and -not $exempt)
    }
}

# ---------------------------------------------------------------------------
# Offline self-test
# ---------------------------------------------------------------------------

if ($SelfTest) {
    $checks = [Collections.Generic.List[object]]::new()
    function Assert-True([string]$Name, [bool]$Condition) {
        if (-not $Condition) { throw "Self-test failed: $Name" }
        [void]$checks.Add([pscustomobject]@{ check = $Name; result = 'pass' })
    }
    function Assert-Throws([string]$Name, [scriptblock]$Action) {
        $threw = $false
        try { & $Action } catch { $threw = $true }
        Assert-True $Name $threw
    }

    $sample = @(
        '# Demo Project',
        '',
        '## Purpose',
        '',
        'Why this exists.',
        '',
        '## Now',
        '',
        'Current state.',
        '',
        '### A subheading',
        '',
        'Detail that belongs to Now.',
        '',
        '## Next',
        '',
        '- [ ] First action',
        ''
    ) -join "`n"

    $appended = New-ProjectBody $sample 'AppendSection' 'Now' 'A new paragraph.'
    Assert-True 'AppendSection keeps every existing line' (Test-LinesPreserved (ConvertTo-Lines $sample) (ConvertTo-Lines $appended))
    Assert-True 'AppendSection adds inside the named section' ($appended -match "(?s)Detail that belongs to Now\.\s*\n\s*\nA new paragraph\.\s*\n\s*\n## Next")
    Assert-True 'AppendSection keeps a level-three subheading inside its section' ($appended -match '### A subheading')

    $replaced = New-ProjectBody $sample 'ReplaceSection' 'Now' 'Only this remains.'
    Assert-True 'ReplaceSection keeps the heading' ($replaced -match '(?m)^## Now$')
    Assert-True 'ReplaceSection drops the old section body' ($replaced -notmatch 'Current state\.')
    Assert-True 'ReplaceSection leaves other sections intact' (($replaced -match 'Why this exists\.') -and ($replaced -match '- \[ \] First action'))

    $withRemovable = $sample -replace "`n## Next", "`n## Details`n`nTemporary migration text.`n`n## Next"
    $removed = New-ProjectBody $withRemovable 'RemoveSection' 'Details' '' '' $false
    Assert-True 'RemoveSection removes the heading and its body' (($removed -notmatch '(?m)^## Details$') -and ($removed -notmatch 'Temporary migration text\.'))
    Assert-True 'RemoveSection leaves neighbouring sections intact' (($removed -match '(?m)^## Now$') -and ($removed -match '(?m)^## Next$'))
    $withLastSection = $sample.TrimEnd() + "`n`n## Details`n`nLast section text.`n"
    $removedLast = New-ProjectBody $withLastSection 'RemoveSection' 'Details' '' '' $false
    Assert-True 'RemoveSection removes the last section without stray blank lines' ($removedLast -ceq $sample)
    foreach ($structuralSection in @('Purpose', 'Now', 'Next')) {
        Assert-Throws "RemoveSection refuses structural section $structuralSection" { New-ProjectBody $sample 'RemoveSection' $structuralSection '' '' $false }
    }
    Assert-Throws 'RemoveSection refuses a missing section' { New-ProjectBody $sample 'RemoveSection' 'Nowhere' '' '' $false }
    Assert-Throws 'RemoveSection refuses Content' { New-ProjectBody $withRemovable 'RemoveSection' 'Details' 'ignored' '' $false }
    Assert-Throws 'RemoveSection refuses MatchText' { New-ProjectBody $withRemovable 'RemoveSection' 'Details' '' 'ignored' $false }

    $added = New-ProjectBody $sample 'AddSection' 'Connected tools' '- A helper.'
    Assert-True 'AddSection appends a new level-two section' ($added -match "(?s)- \[ \] First action\s*\n\s*\n## Connected tools\s*\n\s*\n- A helper\.")
    Assert-True 'AddSection keeps every existing line' (Test-LinesPreserved (ConvertTo-Lines $sample) (ConvertTo-Lines $added))
    Assert-Throws 'AddSection refuses an existing section' { New-ProjectBody $sample 'AddSection' 'Now' 'text' }

    Assert-Throws 'A missing section is refused, not created' { New-ProjectBody $sample 'ReplaceSection' 'Nowhere' 'text' }
    Assert-Throws 'Empty content is refused' { New-ProjectBody $sample 'AppendSection' 'Now' "   `n  " }
    Assert-True 'ReplaceBody replaces the whole page' ((New-ProjectBody $sample 'ReplaceBody' '' "# New`n`nBody.") -eq "# New`n`nBody.`n")
    Assert-True 'ReplaceBody does not preserve the old body' (-not (Test-LinesPreserved (ConvertTo-Lines $sample) (ConvertTo-Lines (New-ProjectBody $sample 'ReplaceBody' '' "# New`n`nBody.`n"))))

    $fenced = @(
        '# Fenced',
        '',
        '## Now',
        '',
        'Run this:',
        '',
        '```powershell',
        '# Not a heading',
        '## Also not a heading',
        '```',
        '',
        'Still Now.',
        '',
        '## Next',
        '',
        '- [ ] Something'
    ) -join "`n"
    $fencedResult = New-ProjectBody $fenced 'AppendSection' 'Now' 'Appended after the fence.'
    Assert-True 'A fenced code block does not end a section' ($fencedResult -match "(?s)Still Now\.\s*\n\s*\nAppended after the fence\.\s*\n\s*\n## Next")
    $fenceBlock = ('```powershell' + "`n" + '# Not a heading' + "`n" + '## Also not a heading' + "`n" + '```')
    Assert-True 'A fenced code block is left byte-identical' ($fencedResult.Contains($fenceBlock))

    $listAppend = New-ProjectBody $sample 'AppendSection' 'Next' '- [x] Second action'
    Assert-True 'A bullet appended to a list joins that list' ($listAppend -match "(?m)^- \[ \] First action`n- \[x\] Second action$")
    $proseAppend = New-ProjectBody $sample 'AppendSection' 'Next' 'A closing paragraph.'
    Assert-True 'Prose appended to a list keeps a blank line' ($proseAppend -match "(?m)^- \[ \] First action`n`nA closing paragraph\.$")

    $duplicate = "# D`n`n## Now`n`na`n`n## Now`n`nb`n"
    Assert-Throws 'A duplicated section name is refused' { New-ProjectBody $duplicate 'AppendSection' 'Now' 'text' }

    Assert-True 'Frontmatter is stripped before editing' ((Remove-Frontmatter "---`ntitle: x`n---`n`n# Body`n") -eq "# Body`n")
    Assert-True 'A page without frontmatter is unchanged' ((Remove-Frontmatter "# Body`n") -eq "# Body`n")

    $counts = Get-ChangeCounts $sample $replaced
    Assert-True 'Change counts report one added and three removed lines' ($counts.added_lines -eq 1 -and $counts.removed_lines -eq 3)

    $underSize = Get-HubPageSizeStatus '1234' 4
    $overSize = Get-HubPageSizeStatus '12345' 4
    Assert-True 'page at threshold does not warn' (-not $underSize.oversized -and $underSize.size_bytes -eq 4)
    Assert-True 'page over threshold warns' ($overSize.oversized -and $overSize.size_bytes -eq 5)

    # An oversized history page is still oversized -- it just must not warn, because notes/ pages are
    # append-only by design. Both halves are asserted so neither a lost exemption nor a blanket
    # exemption can pass.
    $historySize = Get-HubPageSizeStatus '12345' 4 'projects/library-dev/notes/library-dev-history-2026-08-part-2.md'
    $rootSize = Get-HubPageSizeStatus '12345' 4 'projects/library-dev/_project.md'
    Assert-True 'oversized notes/ history page is exempt and does not warn' ($historySize.oversized -and $historySize.exempt -and -not $historySize.warn)
    Assert-True 'oversized Hub root still warns' ($rootSize.oversized -and -not $rootSize.exempt -and $rootSize.warn)
    Assert-True 'a backslash notes/ path is still exempt' ((Get-HubPageSizeStatus '12345' 4 'projects\library-dev\notes\history.md').exempt)

    # The gap a whole-page threshold cannot see: one fat section on an otherwise small page. "Big" is
    # 70 bytes against a 40-byte section threshold, while the whole page is ~89 against 40,000.
    $sectionFixture = "# T`n`n## Small`n`nab`n`n## Big`n`n$('x' * 60)`n"
    $sectionStatus = Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/_project.md'
    $pageStatusSameBody = Get-HubPageSizeStatus $sectionFixture 40000 'projects/demo/_project.md'
    Assert-True 'an oversized section warns even when the whole page does not' ($sectionStatus.warn -and -not $pageStatusSameBody.warn)
    Assert-True 'only the oversized section is named' (@($sectionStatus.oversized_sections).Count -eq 1 -and @($sectionStatus.oversized_sections)[0].section -ceq 'Big')
    Assert-True 'an oversized section on a notes/ page is exempt' (-not (Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/notes/history.md').warn)

    # A duplicate heading must not turn a warning into a failed write.
    $duplicateSections = Get-HubSectionSizes "# T`n`n## Same`n`na`n`n## Same`n`nb`n"
    Assert-True 'duplicate section headings are measured, not thrown on' (@($duplicateSections).Count -eq 2)

    # Delta scoping, asserted in all four directions. An absence-only pair would pass against a
    # status object that never warns at all, so the two positive cases name the section they found.
    $grownFixture = "# T`n`n## Small`n`nab`n`n## Big`n`n$('x' * 90)`n"
    $newSectionFixture = "# T`n`n## Small`n`nab`n"
    $grewStatus = Get-HubSectionSizeStatus $grownFixture 40 'projects/demo/_project.md' $sectionFixture
    $untouchedStatus = Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/_project.md' $sectionFixture
    $shrankStatus = Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/_project.md' $grownFixture
    $addedStatus = Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/_project.md' $newSectionFixture
    Assert-True 'a section this write grew is named' ($grewStatus.warn -and @($grewStatus.warned_sections).Count -eq 1 -and @($grewStatus.warned_sections)[0].section -ceq 'Big')
    Assert-True 'a section this write added is named' ($addedStatus.warn -and @($addedStatus.warned_sections).Count -eq 1 -and @($addedStatus.warned_sections)[0].section -ceq 'Big')
    Assert-True 'an oversized section this write did not touch is silent but still reported' ((-not $untouchedStatus.warn) -and @($untouchedStatus.oversized_sections).Count -eq 1)
    Assert-True 'an oversized section this write shrank is silent but still reported' ((-not $shrankStatus.warn) -and @($shrankStatus.oversized_sections).Count -eq 1)
    Assert-True 'without a previous body every oversized section stays warnable' ($sectionStatus.warn -and @($sectionStatus.warned_sections).Count -eq 1 -and @($sectionStatus.warned_sections)[0].section -ceq 'Big')
    $duplicateBody = "# T`n`n## Same`n`na`n`n## Same`n`nb`n"
    Assert-True 'duplicate headings are summed, not overwritten, before comparing' ((Get-HubSectionSizeTotals $duplicateBody).Same -eq ((Get-HubSectionSizes $duplicateBody | Measure-Object -Property size_bytes -Sum).Sum))

    # Entry sizing: the lever a section sum cannot pull. Measured 2026-08-26, the root's Now section
    # was 15,474 bytes across 9 entries, none of them closed -- length, not staleness.
    $entryFixture = @(
        '# T',
        '',
        '## Now',
        '',
        '- [ ] **Short.** One line.',
        "- [ ] **Long.** $('y' * 200)",
        '',
        '## Next',
        '',
        '- [ ] Also short.'
    ) -join "`n"
    $entrySizes = @(Get-HubEntrySizes $entryFixture)
    Assert-True 'every top-level entry is measured inside its own section' (@($entrySizes).Count -eq 3 -and @($entrySizes | Where-Object { $_.section -ceq 'Now' }).Count -eq 2)
    $wrappedBytes = (Get-HubEntrySizes "# T`n`n## Now`n`n- [ ] head`n  tail`n" | Select-Object -First 1).size_bytes
    $unwrappedBytes = (Get-HubEntrySizes "# T`n`n## Now`n`n- [ ] head`n" | Select-Object -First 1).size_bytes
    Assert-True 'an entry carries its wrapped continuation lines' ($wrappedBytes -eq ($unwrappedBytes + 7))

    $entryStatus = Get-HubEntrySizeStatus $entryFixture 100 'projects/demo/_project.md'
    Assert-True 'only the long entry is named, by its own text and its section' (@($entryStatus.warned_entries).Count -eq 1 -and @($entryStatus.warned_entries)[0].label.StartsWith('**Long.**') -and @($entryStatus.warned_entries)[0].section -ceq 'Now')
    $exemptEntryStatus = Get-HubEntrySizeStatus $entryFixture 100 'projects/demo/notes/history.md'
    Assert-True 'an oversized entry on a notes/ page is exempt and does not warn' ($exemptEntryStatus.exempt -and @($exemptEntryStatus.oversized_entries).Count -eq 1 -and -not $exemptEntryStatus.warn)
    $untouchedEntryStatus = Get-HubEntrySizeStatus $entryFixture 100 'projects/demo/_project.md' $entryFixture
    Assert-True 'an oversized entry this write did not touch is silent but still reported' ((-not $untouchedEntryStatus.warn) -and @($untouchedEntryStatus.oversized_entries).Count -eq 1)

    $lengthened = $entryFixture.Replace(('y' * 200), ('y' * 300))
    Assert-True 'the lengthening fixture changed one entry and no line count' (($lengthened -cne $entryFixture) -and (@(ConvertTo-Lines $lengthened).Count -eq @(ConvertTo-Lines $entryFixture).Count))
    $lengthenedStatus = Get-HubEntrySizeStatus $lengthened 100 'projects/demo/_project.md' $entryFixture
    Assert-True 'an entry this write lengthened is named' ($lengthenedStatus.warn -and @($lengthenedStatus.warned_entries).Count -eq 1 -and @($lengthenedStatus.warned_entries)[0].label.StartsWith('**Long.**'))
    $appended = $entryFixture + "`n- [ ] **Fresh.** $('w' * 200)`n"
    $appendedStatus = Get-HubEntrySizeStatus $appended 100 'projects/demo/_project.md' $entryFixture
    Assert-True 'an entry this write added is named, and the untouched one is not' ($appendedStatus.warn -and @($appendedStatus.warned_entries).Count -eq 1 -and @($appendedStatus.warned_entries)[0].label.StartsWith('**Fresh.**') -and @($appendedStatus.oversized_entries).Count -eq 2)

    Assert-True 'the marker and the checkbox are stripped from an entry label' ((Get-HubEntryLabel '- [ ] **Named.** detail') -ceq '**Named.** detail')
    $longLabel = Get-HubEntryLabel ('- [ ] ' + ('z' * 200))
    Assert-True 'a long entry label is condensed rather than reprinted' ($longLabel.Length -le 63 -and $longLabel.EndsWith('...') -and $longLabel.StartsWith('zzz'))

    # Decided on 2026-08-26 rather than defaulted, and pinned here so removing it has to be argued
    # again. The companion connections page is NOT exempt: unlike a notes/ history page its remedy is
    # already non-circular -- prune or split, never "move connections to the connections page" -- and
    # delta scoping means it speaks only when a write grows an already-oversized section, which is
    # the nag that justified the notes/ exemption in the first place. Its Connected tools section was
    # 21,446 bytes when this was decided, so the exemption would have silenced a real signal.
    $connectionsSection = Get-HubSectionSizeStatus $sectionFixture 40 'projects/demo/connections.md' $newSectionFixture
    Assert-True 'the connections page is not exempt from the section warning' ((-not $connectionsSection.exempt) -and $connectionsSection.warn -and @($connectionsSection.warned_sections)[0].section -ceq 'Big')
    $connectionsEntry = Get-HubEntrySizeStatus $entryFixture 100 'projects/demo/connections.md'
    Assert-True 'the connections page is not exempt from the entry warning' ((-not $connectionsEntry.exempt) -and $connectionsEntry.warn)

    Assert-True 'the Hub root remedy names the companion connections page' ((Get-HubPageSizeRemedy 'projects/demo/_project.md') -clike '*companion connections page*')
    # Assert the positive identity, not just the absence of the circular phrase: dropping the branch
    # falls through to the generic remedy, which also lacks that phrase, so an absence-only assertion
    # passes against a lost fix. Found by mutation-testing this very assertion.
    $connectionsRemedy = Get-HubPageSizeRemedy 'projects/demo/connections.md'
    Assert-True 'the connections page gets its own remedy' ($connectionsRemedy -clike '*Prune entries*')
    Assert-True 'the connections page is not told to move to itself' ($connectionsRemedy -cnotlike '*companion connections page*')
    Assert-True 'an unrecognised Hub page gets the generic remedy' ((Get-HubPageSizeRemedy 'projects/demo/design/gateway.md') -clike '*Move detail onto a linked page*')

    # Hub prose wraps, so the common list ends on an indented continuation line, not a marker.
    $wrapped = @(
        '# Wrapped',
        '',
        '## Next',
        '',
        '- [ ] A short action',
        '- [ ] **A long action.** This item wraps onto a second line and keeps going for a while,',
        '  which means the section ends on indented continuation prose rather than a bullet.',
        ''
    ) -join "`n"
    $wrappedAppend = New-ProjectBody $wrapped 'AppendSection' 'Next' '- [x] Appended after a wrapped item'
    Assert-True 'A bullet appended after a wrapped item joins the list' ($wrappedAppend -match "(?m)^  which means.*bullet\.`n- \[x\] Appended after a wrapped item$")
    $wrappedProse = New-ProjectBody $wrapped 'AppendSection' 'Next' 'Closing prose.'
    Assert-True 'Prose appended after a wrapped item keeps a blank line' ($wrappedProse -match "(?m)^  which means.*bullet\.`n`nClosing prose\.$")

    $checked = New-ProjectBody $wrapped 'CheckItem' 'Next' '' 'A long action' $false
    Assert-True 'CheckItem ticks the matched item' ($checked -match '(?m)^- \[x\] \*\*A long action\.\*\*')
    Assert-True 'CheckItem leaves the wrapped continuation untouched' ($checked -match '(?m)^  which means the section ends on indented continuation prose rather than a bullet\.$')
    Assert-True 'CheckItem leaves other items untouched' ($checked -match '(?m)^- \[ \] A short action$')
    Assert-True 'CheckItem on an already-ticked item changes nothing' ((New-ProjectBody $checked 'CheckItem' 'Next' '' 'A long action' $false) -ceq $checked)
    $unchecked = New-ProjectBody $checked 'CheckItem' 'Next' '' 'A long action' $true
    Assert-True 'CheckItem unticks with -Uncheck' ($unchecked -match '(?m)^- \[ \] \*\*A long action\.\*\*')
    Assert-Throws 'CheckItem refuses an ambiguous match' { New-ProjectBody $wrapped 'CheckItem' 'Next' '' 'action' $false }
    Assert-Throws 'CheckItem refuses text that matches nothing' { New-ProjectBody $wrapped 'CheckItem' 'Next' '' 'absent text' $false }
    Assert-Throws 'CheckItem refuses a non-checkbox item' { New-ProjectBody $sample 'CheckItem' 'Purpose' '' 'Why this exists' $false }

    $replacedItem = New-ProjectBody $wrapped 'ReplaceItem' 'Next' '- [x] **A long action.** Done and rewritten.' 'A long action' $false
    Assert-True 'ReplaceItem replaces the whole wrapped item' (($replacedItem -match '(?m)^- \[x\] \*\*A long action\.\*\* Done and rewritten\.$') -and ($replacedItem -notmatch 'which means the section ends'))
    Assert-True 'ReplaceItem leaves neighbouring items intact' ($replacedItem -match '(?m)^- \[ \] A short action$')

    # `Now` enforcement is deliberately column-zero and fence-aware. Direct Basic Memory writes do
    # not pass through this helper, so this is discipline for the sanctioned path, not a page-wide
    # guarantee.
    Assert-Throws 'an unmarked bullet in Now is refused' { New-ProjectBody $sample 'AppendSection' 'Now' '- Still open.' '' $false }
    Assert-True 'an open checkbox in Now is accepted' ((New-ProjectBody $sample 'AppendSection' 'Now' '- [ ] Still open.' '' $false) -match '(?m)^- \[ \] Still open\.$')
    Assert-True 'a closed checkbox in Now is accepted' ((New-ProjectBody $sample 'AppendSection' 'Now' '- [x] Done.' '' $false) -match '(?m)^- \[x\] Done\.$')
    Assert-True 'an uppercase closed checkbox in Now is accepted' ((New-ProjectBody $sample 'AppendSection' 'Now' '- [X] Done.' '' $false) -match '(?m)^- \[X\] Done\.$')
    Assert-True 'a dated open checkbox in Now is accepted' ((New-ProjectBody $sample 'AppendSection' 'Now' '- [ ] **2026-08-23 -- Still open.**' '' $false) -match '2026-08-23')
    Assert-True 'non-bullet orientation prose in Now is accepted' ((New-ProjectBody $sample 'AppendSection' 'Now' '**Standing fact.** Still true.' '' $false) -match 'Standing fact')

    foreach ($indented in @('   - child', '    - code-like', "`t- tab child")) {
        Assert-True "indented marker is ignored: $indented" ((New-ProjectBody $sample 'AppendSection' 'Now' $indented '' $false).Contains($indented))
    }
    foreach ($marker in @('-', '*', '+', '1.')) {
        $entryLines = @("$marker no marker")
        Assert-True "$marker is recognized as a top-level entry" (@(Get-TopLevelEntries $entryLines 0 1).Count -eq 1)
    }

    $fenceCases = @(
        (@('~~~text', '- unmarked', '~~~') -join "`n"),
        (@('```', '```text', '- unmarked', '```') -join "`n"),
        (@('````text', '- unmarked', '``` ', 'still fenced', '````') -join "`n"),
        (@('```text', '- unmarked', '~~~', 'still fenced', '```') -join "`n"),
        (@('```text', '- unmarked') -join "`n")
    )
    foreach ($fenceCase in $fenceCases) {
        Assert-True 'a fenced or unterminated-fence bullet is ignored' ((New-ProjectBody $sample 'AppendSection' 'Now' $fenceCase '' $false).Contains('- unmarked'))
    }

    Assert-Throws 'AddSection enforces markers in a new Now section' { New-ProjectBody ($sample -replace '(?s)\n## Now.*?(?=\n## Next)', '') 'AddSection' 'Now' '- missing' '' $false }
    Assert-Throws 'ReplaceSection enforces markers in Now' { New-ProjectBody $sample 'ReplaceSection' 'Now' '- missing' '' $false }
    Assert-Throws 'ReplaceBody enforces markers in Now' { New-ProjectBody $sample 'ReplaceBody' '' "# Demo`n`n## Now`n`n- missing`n" '' $false }
    $nowItem = "# Demo`n`n## Now`n`n- [ ] Replace me`n"
    Assert-Throws 'ReplaceItem enforces markers in Now' { New-ProjectBody $nowItem 'ReplaceItem' 'Now' '- missing' 'Replace me' $false }

    foreach ($headingMode in @('AppendSection', 'ReplaceSection')) {
        Assert-Throws "$headingMode refuses structural headings targeting Now" { New-ProjectBody $sample $headingMode 'Now' "## Escape`n- [ ] hidden" '' $false }
    }
    $withoutNow = $sample -replace '(?s)\n## Now.*?(?=\n## Next)', ''
    Assert-Throws 'AddSection refuses structural headings targeting Now' { New-ProjectBody $withoutNow 'AddSection' 'Now' "# Escape`n- [ ] hidden" '' $false }
    Assert-Throws 'ReplaceItem refuses structural headings targeting Now' { New-ProjectBody $nowItem 'ReplaceItem' 'Now' "## Escape`n- [ ] hidden" 'Replace me' $false }
    Assert-Throws 'ReplaceBody refuses a duplicated final Now structure' { New-ProjectBody $sample 'ReplaceBody' '' "# Demo`n`n## Now`n`n- [ ] one`n`n## Now`n`n- [ ] two`n" '' $false }
    Assert-Throws 'span containment is verified independently of marker validity' { Assert-NowStructure $sample $sample 'AppendSection' 'Now' '- [ ] absent from proposal' }

    $legacyNow = "# Demo`n`n## Now`n`n- legacy unmarked`n- [ ] Tick me`n"
    Assert-True 'CheckItem is exempt because it cannot introduce a bullet' ((New-ProjectBody $legacyNow 'CheckItem' 'Now' '' 'Tick me' $false) -match '(?m)^- \[x\] Tick me$')

    # The size warnings must be computed BEFORE the -Preflight return, or none of them can fire on a
    # preflight -- which is what the playbook promises preflight is for. Found unfixed 2026-09-04:
    # all three read $readbackBody, which only exists after the write. This is an ordering invariant,
    # so it is checked on the source rather than by running the helper, whose preflight path needs a
    # live Project Hub over MCP and cannot run offline in a self-test.
    $ownSource = [IO.File]::ReadAllText($PSCommandPath)
    $warningOffset = $ownSource.IndexOf('$script:SizeWarnings = @(', [StringComparison]::Ordinal)
    $preflightOffset = $ownSource.IndexOf('if ($Preflight) {', [StringComparison]::Ordinal)
    Assert-True 'the size warnings are computed at all' ($warningOffset -ge 0)
    Assert-True 'the preflight return exists' ($preflightOffset -ge 0)
    Assert-True 'size warnings are computed before the preflight return, so preflight can report them' `
        ($warningOffset -lt $preflightOffset)
    Assert-True 'the warnings are no longer computed from the post-write readback' `
        (-not ($ownSource -match 'Get-Hub(Page|Section|Entry)SizeStatus \$readbackBody'))
    Assert-True 'the preflight result carries the warnings for a -Json consumer' `
        ($ownSource -match 'page_size_warning' -and $ownSource -match 'entry_size_warning')

    [pscustomobject]@{
        operation = 'Edit Project Hub self-test'
        checks = @($checks)
        passed = $checks.Count
        shared_library_write = $false
    }
    return
}

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($ProjectSlug)) { throw 'ProjectSlug is required.' }
if ([string]::IsNullOrWhiteSpace($Mode)) { throw 'Mode is required: AddSection, AppendSection, CheckItem, RemoveSection, ReplaceItem, ReplaceSection, or ReplaceBody.' }
# -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'My-Project' satisfies
# this lowercase-only rule and travels on as a Project directory. See docs/capture-book-model.md.
if ($ProjectSlug -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'ProjectSlug must use lowercase letters, digits, and single hyphens.' }
$McpUrl = Resolve-LibraryWriteEndpoint -McpUrl $McpUrl -WorkspacePath $WorkspacePath -Operation 'editing a Project Hub'
$ProjectId = Resolve-LibraryCollectionId -CollectionId $ProjectId
# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$pageName = $Page.Trim().Replace('\', '/').Trim('/')
if ($pageName -match '\.md$') { $pageName = $pageName.Substring(0, $pageName.Length - 3) }
if ([string]::IsNullOrWhiteSpace($pageName)) { throw 'Page is required.' }
if ($pageName -notmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._ -]+)*$' -or $pageName -match '(^|/)\.\.?($|/)') {
    throw 'Page must be a canonical path below the Project root, such as _project or notes/topic/Article.'
}
$pagePath = "projects/$ProjectSlug/$pageName.md"

$sectionModes = @('AddSection', 'AppendSection', 'RemoveSection', 'ReplaceSection')
$itemModes = @('CheckItem', 'ReplaceItem')
if ($Mode -in $sectionModes) {
    if ([string]::IsNullOrWhiteSpace($Section)) { throw "$Mode requires -Section, the exact level-two heading text without the leading '##'." }
}
if (-not [string]::IsNullOrWhiteSpace($Section)) { $Section = $Section.Trim().TrimStart('#').Trim() }
if ($Mode -eq 'RemoveSection') {
    if ($Section -ceq 'Purpose' -or $Section -ceq 'Now' -or $Section -ceq 'Next') {
        throw "Section '$Section' is structural and cannot be removed."
    }
    if ($PSBoundParameters.ContainsKey('Content') -or $PSBoundParameters.ContainsKey('ContentPath')) {
        throw 'RemoveSection takes no content; do not supply -Content or -ContentPath.'
    }
    if ($PSBoundParameters.ContainsKey('MatchText')) { throw 'RemoveSection takes no -MatchText.' }
}
if ($Mode -in $itemModes -and [string]::IsNullOrWhiteSpace($MatchText)) {
    throw "$Mode requires -MatchText: text appearing in exactly one item, matched case-sensitively. -Section is optional and narrows the search."
}
$usedContent = -not [string]::IsNullOrWhiteSpace($Content)
$usedContentPath = -not [string]::IsNullOrWhiteSpace($ContentPath)
if ($Mode -eq 'RemoveSection') {
    # Its arguments were checked by bound-parameter presence above; no content is expected.
}
elseif ($Mode -eq 'CheckItem') {
    if ($usedContent -or $usedContentPath) { throw 'CheckItem changes only the checkbox marker; it takes no content.' }
}
elseif ($usedContent -eq $usedContentPath) { throw 'Supply exactly one of -Content or -ContentPath.' }
if ($usedContentPath) {
    $contentFull = if ([IO.Path]::IsPathRooted($ContentPath)) { [IO.Path]::GetFullPath($ContentPath) } else { [IO.Path]::GetFullPath((Join-Path $workspace $ContentPath)) }
    if (-not (Test-Path -LiteralPath $contentFull -PathType Leaf)) { throw "ContentPath '$ContentPath' is not a file." }
    $Content = [IO.File]::ReadAllText($contentFull, [Text.UTF8Encoding]::new($false, $true))
}

# COPY EVIDENCE, AND ONLY FOR THE ONE MODE WHERE IT IS TRUE (2026-09-18).
# Get-LibraryTriageInventory builds a Notebook page's copy_status out of `planned_records`, and this
# journal carried none -- so Get-JournalEntries fell to its legacy branch, which returns @() for any
# non-Book destination. A ReplaceBody that made a Hub page byte-identical to its Notebook source
# therefore bound NOTHING, and the page kept reading `known-copy-drifted`. That is not merely a
# cosmetic under-report: the copy advisory names the page as one to act on, and the only additive
# tool for acting on it -- Invoke-LibraryTriage -- refuses it, because the destination already
# exists and `replace_existing` is rejected at plan validation. The reader is sent in a circle.
#
# RECORDED FOR ReplaceBody ALONE, and the narrowness is the point. Only there does the whole source
# file become the whole page. An append or a section replace puts the source in as a FRAGMENT, and a
# record claiming the page carries that Notebook page's content would be FALSE -- a wrong `known-
# current-copy` is far worse than the missing one this fixes, because it would tell a reset that
# material is safe when it is not. A -Content edit and a -ContentPath outside notebook/ have no
# Notebook source at all, and record nothing.
#
# THE HASH IS OF THE FILE'S RAW BYTES. Get-Sha256 above hashes a *string* as UTF-8 without a BOM;
# the inventory hashes the file with ReadAllBytes. The two disagree on a BOM or on CRLF endings, and
# a source_sha256 that disagrees reads as `known-copy-drifted` -- the very state being fixed.
$notebookSourceRelative = $null
$notebookSourceHash = $null
if ($usedContentPath -and $Mode -ceq 'ReplaceBody') {
    $workspaceRoot = [IO.Path]::GetFullPath($workspace)
    if (-not $workspaceRoot.EndsWith([IO.Path]::DirectorySeparatorChar)) { $workspaceRoot += [IO.Path]::DirectorySeparatorChar }
    if ($contentFull.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $candidate = $contentFull.Substring($workspaceRoot.Length) -replace '\\', '/'
        if ($candidate -cmatch '^notebook/.+') {
            $sourceHasher = [Security.Cryptography.SHA256]::Create()
            try { $notebookSourceHash = ([BitConverter]::ToString($sourceHasher.ComputeHash([IO.File]::ReadAllBytes($contentFull)))).Replace('-', '').ToLowerInvariant() }
            finally { $sourceHasher.Dispose() }
            $notebookSourceRelative = $candidate
        }
    }
}

# The Desk is the boundary for an edit that carries no plan_id: a Hub must be open to be changed.
# THIS SEAT'S DESK, deliberately not the union. The question here is whether THIS session may
# change the Hub, and a Hub open at another seat must not entitle this one -- that would widen the
# boundary rather than migrate it.
$openProjectsPath = Get-DeskFilePath -StateDirectory (Join-Path $workspace '.claude') -Seat $Seat -Kind 'projects'
# FOUND BY desk.state-read-and-written-atomically ON ITS FIRST RUN (2026-09-18), not by the sweep
# that routed the rest: this site read the Desk with ReadAllText and split it by hand, so a search
# for the Get-Content pipeline every other reader shared walked straight past it. The twenty-first
# read site, in a helper that gates every Hub edit.
#
# The strict-decoding UTF8Encoding goes with it, and that is the intended direction: it threw on a
# Desk file with invalid bytes here and NOWHERE ELSE, so one reader refused what twenty accepted.
# All of them now fail closed the same way -- a mangled line matches no open Project and the edit is
# refused, which is the outcome the throw produced anyway.
$openProjects = @(Get-DeskFileEntries -Path $openProjectsPath)
if ("archive/projects/$ProjectSlug" -in $openProjects) { throw "Project '$ProjectSlug' is open from the archive shelf. Archived Project Hubs are read-only." }
if ("projects/$ProjectSlug" -notin $openProjects) {
    throw "Project '$ProjectSlug' is not open. Open it first: tools/Set-VirtualDesk.ps1 -Action Open -Kind Project -Slug $ProjectSlug"
}

$isReplacing = $Mode -in @('RemoveSection', 'ReplaceSection', 'ReplaceBody', 'ReplaceItem')

# ---------------------------------------------------------------------------
# Shared collection access
# ---------------------------------------------------------------------------

$script:Session = $null
$script:Request = 1

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 32
    $builder = [Text.StringBuilder]::new()
    foreach ($character in $json.ToCharArray()) {
        if ([int]$character -le 127) { [void]$builder.Append($character) }
        else { [void]$builder.AppendFormat('\u{0:x4}', [int]$character) }
    }
    $builder.ToString()
}
function Get-RpcError($Response) {
    $property = $Response.PSObject.Properties['error']
    if ($null -eq $property) { return $null }
    $property.Value
}
# --- Session recovery -----------------------------------------------------------------------------
# The MCP transport forgets its session when the server restarts or the session expires, and then
# answers every later request with "Session not found". The cached id is permanently wrong from that
# point, so a helper holding one session across several calls fails for the rest of its run while the
# NAS is healthy and answering a fresh initialize on the first try.
#
# Re-initialising and retrying ONCE is the whole fix. It retries only on that one message, only when
# an id was actually cached, and never for `initialize` itself -- so an unreachable NAS still fails on
# the first attempt rather than being retried into a slower identical failure, and the retry cannot
# recurse. Initialize-Mcp deliberately calls the non-retrying primitive for the same reason.
#
# WHY ONE OPERATION FAMILY IS EXCLUDED. "Session not found" is emitted by the MCP transport layer
# (mcp 2.0.0 / fastmcp 4.0.0b1), NOT by Basic Memory -- the string appears nowhere in its source.
# That places the rejection before tool dispatch, which would make a retry safe for every operation.
# That is an inference from where the string is absent, not a verified reading of the code that emits
# it, so the one family that would fail SILENTLY if the inference is wrong is excluded rather than
# trusted: append, prepend and the insert_* edits are not idempotent and a second application
# duplicates content with no error. write_note is permalink-keyed, replace_section is idempotent, and
# find_replace self-guards through expected_replacements, so those stay retryable.
# See the Basic-Memory MCP Book, page basic-memory/write-semantics-and-retry-safety.
function Test-McpRetryIsSafe([string]$Method, $Params) {
    if ($Method -cne 'tools/call' -or $null -eq $Params) { return $true }
    if ([string]$Params['name'] -cne 'edit_note') { return $true }
    $arguments = $Params['arguments']
    if ($null -eq $arguments) { return $true }
    # -cin, not -in: these operation names are lowercase by the tool's own contract, and the
    # case-insensitive default would let 'Append' past the exclusion it is here to enforce.
    -not ([string]$arguments['operation'] -cin @('append', 'prepend', 'insert_before_section', 'insert_after_section'))
}

function Invoke-Mcp([string]$Method, [hashtable]$Params, [switch]$Notification) {
    try { return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification) }
    catch {
        if ($Method -ceq 'initialize' -or -not $script:Session) { throw }
        if ($_.Exception.Message -notmatch 'Session not found') { throw }
        if (-not (Test-McpRetryIsSafe -Method $Method -Params $Params)) { throw }
        $script:Session = $null
        Initialize-Mcp
        return (Invoke-McpOnce -Method $Method -Params $Params -Notification:$Notification)
    }
}

function Invoke-McpOnce([string]$Method, [hashtable]$Params, [switch]$Notification) {
    $id = $null
    if (-not $Notification) { $id = $script:Request; $script:Request++ }
    $payload = [ordered]@{ jsonrpc = '2.0'; method = $Method }
    if ($null -ne $id) { $payload.id = $id }
    if ($null -ne $Params) { $payload.params = $Params }
    $client = [Net.Http.HttpClient]::new()
    try {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $McpUrl)
        [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
        [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', '2025-03-26')
        if ($script:Session) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Session-Id', $script:Session) }
        $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::ASCII.GetBytes((ConvertTo-AsciiJson $payload)))
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $($body.Substring(0, [Math]::Min($body.Length, 4096)))" }
    }
    catch { throw "MCP $Method failed: $($_.Exception.Message)" }
    finally { $client.Dispose() }
    if ($Method -eq 'initialize') {
        $values = [Collections.Generic.IEnumerable[string]]$null
        if (-not $response.Headers.TryGetValues('Mcp-Session-Id', [ref]$values)) { throw 'The shared Library did not establish an MCP session.' }
        $script:Session = @($values)[0]
    }
    if ($Notification) { return }
    if ($body.Trim().StartsWith('{')) { return ($body | ConvertFrom-Json) }
    $events = @($body -split "`r?`n" | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() } | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    # An id-less notifications/message log frame has no .id to read, and reading it throws under
    # StrictMode. Enumerate the property names before comparing -- and enumerate rather than reading
    # the aggregate .Name, which throws in turn on a property-less {} frame (defect family 4).
    # Held by mcp.transports-guard-idless-events.
    $result = @($events | Where-Object { @($_.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'id' -and $_.id -eq $id } | Select-Object -Last 1)
    if ($result.Count -ne 1) { throw "MCP response for request $id was incomplete." }
    $result[0]
}
function Initialize-Mcp {
    $response = Invoke-McpOnce 'initialize' @{ protocolVersion = '2025-03-26'; capabilities = @{}; clientInfo = @{ name = 'library-project-edit'; version = '1.0.0' } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "MCP initialization was rejected: $($rpcError.message)" }
    Invoke-McpOnce 'notifications/initialized' @{} -Notification
}
# Every read is checked against the exact requested path: a substituted page is a stop, not a merge.
function Read-ExactOrNull([string]$Path) {
    $response = Invoke-Mcp 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $ProjectId; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $true } }
    $rpcError = Get-RpcError $response
    if ($null -ne $rpcError) { throw "Read '$Path' failed: $($rpcError.message)" }
    if ($response.result.isError) {
        $detail = [string]($response.result.content | ConvertTo-Json -Compress -Depth 8)
        if ($detail -match '(?i)not found|does not exist|no note') { return $null }
        throw "Read '$Path' was rejected: $detail"
    }
    $record = $response.result.structuredContent.result
    if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.file_path)) { return $null }
    if ([string]$record.file_path -cne $Path) { throw "Read '$Path' returned '$($record.file_path)'; the edit stopped without writing." }
    $record
}

Initialize-Mcp
$existing = Read-ExactOrNull $pagePath
if ($null -eq $existing) {
    throw "Page '$pagePath' does not exist. This helper edits existing Project pages; create a Hub with tools/New-ProjectHub.ps1 or copy Notebook pages with tools/Copy-LocalPagesToProject.ps1."
}
$currentBody = Remove-Frontmatter ([string]$existing.content)
$proposedBody = New-ProjectBody $currentBody $Mode $Section $Content $MatchText ([bool]$Uncheck)
$currentLines = @(ConvertTo-Lines $currentBody)
$proposedLines = @(ConvertTo-Lines $proposedBody)
if ($Mode -eq 'CheckItem') {
    # A tick may change one marker character and nothing else, and is provable line by line.
    if ($currentLines.Count -ne $proposedLines.Count) { throw 'CheckItem would change the page shape; the edit stopped without writing.' }
    $differing = @(0..($currentLines.Count - 1) | Where-Object { $currentLines[$_] -cne $proposedLines[$_] })
    if ($differing.Count -gt 1) { throw "CheckItem would change $($differing.Count) lines; the edit stopped without writing." }
    if ($differing.Count -eq 1) {
        $normalizedOld = $currentLines[$differing[0]] -replace '\[[ xX]\]', '[ ]'
        $normalizedNew = $proposedLines[$differing[0]] -replace '\[[ xX]\]', '[ ]'
        if ($normalizedOld -cne $normalizedNew) { throw 'CheckItem would change more than the checkbox marker; the edit stopped without writing.' }
    }
}
elseif (-not $isReplacing -and -not (Test-LinesPreserved $currentLines $proposedLines)) {
    throw "$Mode would not preserve the existing page text; the edit stopped without writing."
}
$sectionAdvice = $null

$currentHash = Get-Sha256 $currentBody
$proposedHash = Get-Sha256 $proposedBody
$counts = Get-ChangeCounts $currentBody $proposedBody
$planId = 'project-edit-' + (Get-Sha256 "$pagePath|$Mode|$Section|$MatchText|$currentHash|$proposedHash")
$sectionBefore = $null
$sectionAfter = $null
$itemBefore = $null
$itemAfter = $null
if ($Mode -in $sectionModes) {
    $beforeSpan = Get-SectionSpan $currentLines $Section
    $afterSpan = Get-SectionSpan $proposedLines $Section
    $sectionBefore = Get-SectionText $currentLines $beforeSpan
    $sectionAfter = if ($null -eq $afterSpan) { $null } else { Get-SectionText $proposedLines $afterSpan }
}
if ($Mode -in $itemModes) {
    $scopeStart = 0
    $scopeEnd = $currentLines.Count
    if (-not [string]::IsNullOrWhiteSpace($Section)) {
        $itemSpan = Get-SectionSpan $currentLines $Section
        $scopeStart = $itemSpan.start + 1
        $scopeEnd = $itemSpan.end
    }
    $block = Find-UniqueBlock $currentLines $scopeStart $scopeEnd $MatchText
    $itemBefore = ($currentLines[$block.start..$block.end]) -join "`n"
    $itemAfter = if ($Mode -eq 'CheckItem') { ($proposedLines[$block.start..$block.end]) -join "`n" } else { (@(Remove-TrailingBlank @(ConvertTo-Lines $Content))) -join "`n" }
}

$plan = [pscustomobject]@{
    operation = 'Edit Project Hub'
    project_slug = $ProjectSlug
    page_path = $pagePath
    mode = $Mode
    section = if ([string]::IsNullOrWhiteSpace($Section)) { $null } else { $Section }
    match_text = if ($Mode -in $itemModes) { $MatchText } else { $null }
    unchanged = ($currentHash -ceq $proposedHash)
    current_sha256 = $currentHash
    proposed_sha256 = $proposedHash
    added_lines = $counts.added_lines
    removed_lines = $counts.removed_lines
    current_line_count = $currentLines.Count
    proposed_line_count = $proposedLines.Count
    section_before = $sectionBefore
    section_after = $sectionAfter
    item_before = $itemBefore
    item_after = $itemAfter
    plan_id = $planId
    confirmation_required = $isReplacing
    advice = $sectionAdvice
    shared_library_write = $false
}

# The page, section and entry warnings used to be computed after the write, from $readbackBody --
# so none of them could fire on -Preflight, even though the playbook calls preflight "a safe way to
# preview a long append". They are computed here instead, from $proposedBody, which the write path
# then proves byte-equal to the readback anyway. One computation, rendered by both paths.
$script:SizeWarnings = @(
    (Get-HubPageSizeStatus $proposedBody $script:HubPageSizeWarningThresholdBytes $pagePath),
    (Get-HubSectionSizeStatus $proposedBody $script:HubSectionSizeWarningThresholdBytes $pagePath $currentBody),
    (Get-HubEntrySizeStatus $proposedBody $script:HubEntrySizeWarningThresholdBytes $pagePath $currentBody)
)
function Write-SizeWarning {
    $page = $script:SizeWarnings[0]
    if ($page.warn) { Write-Warning "Project Hub page '$pagePath' is $($page.size_bytes) bytes. $(Get-HubPageSizeRemedy $pagePath)" }
    $section = $script:SizeWarnings[1]
    if ($section.warn) {
        foreach ($oversizedSection in $section.warned_sections) {
            # THE REMEDY IS SORT, NOT COMPRESS (ADR-0013). It used to say "keep each entry to a
            # line or two", which is the trimming the 2026-08-18 record explicitly warned against --
            # "what you write when you already know a number invites gaming". Measurement settled it:
            # a section goes over because it is holding items that cannot close, not because its
            # entries are verbose. Naming the three destinations is actionable; "be shorter" is not,
            # and this warning already had a comment admitting it was unactionable.
            Write-Warning "Section '$($oversizedSection.section)' on '$pagePath' grew to $($oversizedSection.size_bytes) bytes. Usually this section is holding items it cannot close rather than verbose ones: send a limit whose proof needs an event you cannot cause to the limits page with a disposition, a settled question to ## Decisions and its record, and a standing practice to the subject's own rules. Sort before you shorten (ADR-0013)."
        }
    }
    $entry = $script:SizeWarnings[2]
    if ($entry.warn) {
        foreach ($oversizedEntry in $entry.warned_entries) {
            Write-Warning "Entry '$($oversizedEntry.label)' in '$($oversizedEntry.section)' on '$pagePath' is $($oversizedEntry.size_bytes) bytes. Keep the entry to its decision and its link, and put the detail on a linked page."
        }
    }
}

if ($Preflight) {
    # Reported on the object as well as warned, so a preflight consumed with -Json still sees them.
    $plan | Add-Member -NotePropertyName page_size_warning -NotePropertyValue $script:SizeWarnings[0]
    $plan | Add-Member -NotePropertyName section_size_warning -NotePropertyValue $script:SizeWarnings[1]
    $plan | Add-Member -NotePropertyName entry_size_warning -NotePropertyValue $script:SizeWarnings[2]
    Write-SizeWarning
    Write-LibraryResult -Result $plan -Json:$Json
    return
}
if ($plan.unchanged) {
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{ operation = 'Edit Project Hub'; project_slug = $ProjectSlug; page_path = $pagePath; mode = $Mode; unchanged = $true; written = $false; shared_library_write = $false })
    return
}
if ($isReplacing) {
    if (-not $UserConfirmed) { throw "$Mode removes existing text and is not yet performed: review the preflight and rerun with -UserConfirmed." }
    if ($ApprovedPlanId -cne $planId) { throw "$Mode is not yet performed: rerun the current preflight and pass its exact plan_id as ApprovedPlanId." }
}

if ([string]::IsNullOrWhiteSpace($JournalPath)) {
    $pageLabel = ($pageName -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLowerInvariant()
    # The plan_id suffix keeps two edits made in the same second from sharing one journal.
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $planLabel = $planId.Substring($planId.Length - 8)
    $JournalPath = Join-Path $workspace "internal/publication-journals/project-edit-$ProjectSlug-$pageLabel-$stamp-$planLabel.json"
}
function Save-Journal([string]$State, [string]$ErrorText) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $JournalPath) -Force | Out-Null
    # BUILT AS A STATEMENT, NOT AN if EXPRESSION. `planned_records = if (...) { @() } else { ... }`
    # reads correctly and is wrong: an empty array returned from an if *expression* unrolls to
    # nothing, so the property lands as $null and serialises to `null` rather than `[]`. Downstream
    # that is survivable -- Get-JournalEntries filters nulls -- but the journal then misdescribes
    # its own shape, and `@($journal.planned_records).Count` reads 1 for a record that is not there.
    $plannedRecords = @()
    if (-not [string]::IsNullOrWhiteSpace($notebookSourceRelative)) {
        $plannedRecords = @([pscustomobject]@{ path = $pagePath; source = $notebookSourceRelative; sha256 = $notebookSourceHash })
    }
    $journal = [pscustomobject]@{
        state = $State
        operation = 'project-edit'
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
        project_id = $ProjectId
        project_slug = $ProjectSlug
        page_path = $pagePath
        mode = $Mode
        section = if ([string]::IsNullOrWhiteSpace($Section)) { $null } else { $Section }
        match_text = if ($Mode -in $itemModes) { $MatchText } else { $null }
        approved_plan_id = $planId
        previous_sha256 = $currentHash
        proposed_sha256 = $proposedHash
        # Empty for every mode but a ReplaceBody sourced from notebook/ -- see the note where these
        # are computed. Get-JournalEntries reads this field and binds nothing when it is empty, so
        # the absence is as deliberate as the presence.
        planned_records = $plannedRecords
        previous_body = $currentBody
        error = $ErrorText
    }
    [IO.File]::WriteAllText($JournalPath, ($journal | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

# THE LOCK IS TAKEN BEFORE THE FINAL RE-READ AND HELD THROUGH THE JOURNAL. Releasing it after the
# write but before the readback lets ANOTHER helper's perfectly correct write land in between, and
# this run then reports a failed verification for an edit that succeeded -- pointing the reader at a
# rollback journal for a page that is fine. Held through Save-Journal 'complete' for the same
# reason: a journal finalised after the lock is gone can describe a state that has already moved.
$lock = Enter-BookLock -Workspace $workspace -BookRoot "projects/$ProjectSlug" -TimeoutSeconds $LockTimeoutSeconds
$verified = $false
try {
    # THE PRECONDITION, ON EVERY MODE. The digest was already computed for the plan and journaled as
    # previous_sha256, but only the four gated modes ever checked it -- through the plan_id. So
    # AddSection, AppendSection and CheckItem applied with no precondition at all: a page that
    # changed between the read and the write was overwritten with a body composed from the old one,
    # and the run reported success. This is not compare-and-swap and cannot be: write_note exposes
    # no expected-digest argument, so the residual window is one network round trip wide, and the
    # local lock excludes Library helpers rather than every writer. It closes the window that is
    # actually ours.
    $recheck = Read-ExactOrNull $pagePath
    if ($null -eq $recheck) { throw "Page '$pagePath' disappeared between the plan and the write; nothing was written." }
    # Compared with line endings normalised, the same way the readback below is compared. The stored
    # previous_sha256 stays the raw digest so the journal still describes the exact bytes read.
    $recheckBody = Remove-Frontmatter ([string]$recheck.content)
    if ((Get-Sha256 ($recheckBody -replace "`r`n", "`n")) -cne (Get-Sha256 ($currentBody -replace "`r`n", "`n"))) {
        throw "Page '$pagePath' changed after this edit was planned, so nothing was written. Re-read the page and plan the edit again; the text you were editing is no longer what is there."
    }

    # The prior text is journaled before the write, so an interrupted edit is always recoverable.
    Save-Journal -State 'pending' -ErrorText ''
    $response = Invoke-Mcp 'tools/call' @{ name = 'write_note'; arguments = @{ project_id = $ProjectId; directory = (Split-Path -Parent $pagePath).Replace('\', '/'); title = [IO.Path]::GetFileNameWithoutExtension($pagePath); content = $proposedBody; note_type = 'note'; overwrite = $true; output_format = 'json' } }
    if ($null -ne (Get-RpcError $response) -or $response.result.isError) { throw "Write '$pagePath' was rejected." }
    $readback = Read-ExactOrNull $pagePath
    if ($null -eq $readback) { throw "Write '$pagePath' did not become readable." }
    $readbackBody = Remove-Frontmatter ([string]$readback.content)
    if ((Get-Sha256 (($readbackBody -replace "`r`n", "`n"))) -cne (Get-Sha256 (($proposedBody -replace "`r`n", "`n")))) {
        throw "Readback of '$pagePath' did not match the approved text; the previous text is in $JournalPath."
    }
    # Rendered from the single computation made before the preflight return. The readback has just
    # been proved hash-equal to $proposedBody, so recomputing from it would only risk the two paths
    # disagreeing.
    Write-SizeWarning
    $verified = $true
    Save-Journal -State 'complete' -ErrorText ''
}
catch {
    $failure = $_.Exception.Message
    if (-not $verified) { try { Save-Journal -State 'incomplete' -ErrorText $failure } catch { } }
    if ($verified) { throw "The Project edit was verified, but its journal could not be saved: $failure" }
    throw
}
finally { Exit-BookLock -Lock $lock }

Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation = 'Edit Project Hub'
    project_slug = $ProjectSlug
    page_path = $pagePath
    mode = $Mode
    section = if ([string]::IsNullOrWhiteSpace($Section)) { $null } else { $Section }
    match_text = if ($Mode -in $itemModes) { $MatchText } else { $null }
    plan_id = $planId
    previous_sha256 = $currentHash
    written_sha256 = $proposedHash
    added_lines = $counts.added_lines
    removed_lines = $counts.removed_lines
    journal_path = $JournalPath
    # Named on the result because it is the one thing a reader cannot see from the outside: the write
    # was serialized against other Library helpers, and it was preconditioned on the page still
    # being what the plan described.
    precondition_verified = $true
    written = $true
    advice = $sectionAdvice
    shared_library_write = $true
})
