<#
.SYNOPSIS
    Record, update, list, and validate topic-scoped overlap records between Shelf Books.

.DESCRIPTION
    Item 2.1 of the plan. The Shelf's overlaps are conversion residue: its Books were converted from
    separate LLM Wiki workspaces and those conversions were not uniformly clean, so the same subject
    can sit in two Books with no way for a reader to tell which copy is current.

    A single per-Book Status cannot express that, which is why these records are scoped to a *topic*:
    `agentic-os-development` is superseded for the `2nd-b` material and remains canonical for its
    Odysseus and household-platform pages. Both facts are true of the same Book at the same time.

    What this helper does NOT do:

    - It never reads a Book body. It reads `shelf/_catalog.md`, which is catalog-class and readable
      while every Book is closed, and it writes one record file. That is what lets it run with an
      empty Desk, and it is also the boundary: a relationship recorded here is the reader's judgment,
      not a claim derived from pages this process read.
    - It does not merge or stub anything. `docs/duplicate-topic-resolution.md` requires reading every
      page of the losing copy first, which is a Desk operation and is out of scope this iteration.
      These records are the durable place that judgment lands so 2.2's Discovery can report overlap
      status without re-deriving it.

    Contradiction is prevented structurally rather than by cross-checking. A relationship is stored
    once per topic and unordered Book pair, expressed directionally from `book` to `counterpart`, so
    there is no second record that could disagree with the first -- a duplicate pair is refused
    outright. The remaining rules are dangling slugs, self-pairs, and relationship/resolution
    combinations that cannot both be true.

.EXAMPLE
    tools/Set-TopicOverlap.ps1 -Action Add -Topic obsidian-tooling `
        -Slug agentic-os-development -Counterpart 2nd-b -Relationship unverified

.EXAMPLE
    tools/Set-TopicOverlap.ps1 -Action List -Slug 2nd-b -Json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Add', 'Set', 'Remove', 'List', 'Validate')]
    [string]$Action,

    # Lowercase topic slug. Scope is the reader's word for the shared subject, not a page path.
    [string]$Topic,

    # The Book the record is written from; -Relationship reads in this direction.
    [string]$Slug,

    # The other Book in the pair.
    [string]$Counterpart,

    #   unverified    an overlap is suspected and nobody has read both copies yet
    #   complementary both copies were read and each covers a facet the other does not
    #   canonical     -Slug is the canonical copy for this topic; -Counterpart is superseded
    [ValidateSet('unverified', 'complementary', 'canonical')]
    [string]$Relationship,

    #   open       recorded; the resolution work has not been done
    #   accepted   complementary, and the reader decided there is nothing to merge
    #   resolved   canonical, and the losing copy has been reconciled
    [ValidateSet('open', 'accepted', 'resolved')]
    [string]$Resolution,

    # ISO date, yyyy-MM-dd. Defaults to today for Add and Set.
    [string]$Date,

    # One line on why, for a reader who finds this record months later.
    [string]$Note,

    [string]$WorkspacePath,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')

$script:OverlapSchema = 1
$script:RecordRelativePath = 'internal/overlap-records.json'

# A relationship and a resolution state that cannot both be true is a contradiction the same way a
# reversed pair is. "Resolved" means the losing copy was reconciled, so it needs a losing copy;
# "accepted" means the reader decided there was nothing to merge, which only complementary offers;
# and nothing can be settled about a pair nobody has read.
$script:AllowedResolutions = @{
    'unverified'    = @('open')
    'complementary' = @('open', 'accepted')
    'canonical'     = @('open', 'resolved')
}

function Assert-Slug([string]$Value, [string]$Label) {
    # -cnotmatch, not -notmatch: the default is case-insensitive, so 'Agentic-OS' would satisfy a
    # lowercase-only rule and be stored as a slug that never matches the catalog on a case-sensitive
    # filesystem. Same family as Set-VirtualDesk and the note triage; linted by powershell.defect-families.
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
        throw "$Label must contain only lowercase letters, digits, and hyphens."
    }
}

function Assert-IsoDate([string]$Value) {
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Date must be an ISO date, yyyy-MM-dd.' }
    $parsed = [datetime]::MinValue
    $styles = [Globalization.DateTimeStyles]::None
    if (-not [datetime]::TryParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        throw "Date '$Value' is not a real calendar date."
    }
}

function Get-ShelfBookSlugs([string]$Workspace) {
    # Same catalog shape Invoke-LibraryChecks' shelf.references-resolve reads. Catalog-class: no Book
    # has to be open for this, which is the whole reason the record file can be maintained cold.
    $catalogPath = Join-Path $Workspace 'shelf/_catalog.md'
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'shelf/_catalog.md is missing.' }
    $catalog = Get-Content -LiteralPath $catalogPath -Raw
    $slugs = [Collections.Generic.List[string]]::new()
    foreach ($m in @([regex]::Matches($catalog, '(?m)^\s*-\s+\*\*Path:\*\*\s+shelf/([a-z0-9][a-z0-9-]*)\s*$'))) {
        [void]$slugs.Add($m.Groups[1].Value)
    }
    if (-not $slugs.Count) { throw 'shelf/_catalog.md lists no Books.' }
    $slugs
}

function Get-PairKey([string]$TopicSlug, [string]$BookA, [string]$BookB) {
    # Unordered on the pair, so 'a canonical for b' and 'b canonical for a' collide instead of
    # coexisting. This is what makes a contradictory pair unrepresentable rather than merely detected.
    $ordered = @(@($BookA, $BookB) | Sort-Object)
    "$TopicSlug|$($ordered[0])|$($ordered[1])"
}

function Read-OverlapFile([string]$Workspace) {
    $path = Join-Path $Workspace $script:RecordRelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ schema = $script:OverlapSchema; records = @() }
    }
    $raw = [IO.File]::ReadAllText($path)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ schema = $script:OverlapSchema; records = @() }
    }
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "$($script:RecordRelativePath) is not valid JSON: $($_.Exception.Message)" }

    if ($null -eq $parsed.PSObject.Properties['schema']) { throw "$($script:RecordRelativePath) has no schema field." }
    if ([int]$parsed.schema -ne $script:OverlapSchema) {
        throw "$($script:RecordRelativePath) is schema $($parsed.schema); this helper writes schema $($script:OverlapSchema)."
    }
    # @() is load-bearing twice over: a single record unrolls to a bare object and .Count then fails
    # under StrictMode, and an absent list must read as empty rather than as $null.
    $records = @()
    if ($null -ne $parsed.PSObject.Properties['records'] -and $null -ne $parsed.records) { $records = @($parsed.records) }
    [pscustomobject]@{ schema = $script:OverlapSchema; records = $records }
}

function Test-OverlapRecords {
    <#
    .SYNOPSIS
        Return every problem in a record set. Empty means the set is valid.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Records,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$KnownSlugs
    )

    $problems = [Collections.Generic.List[string]]::new()
    $seen = @{}
    $index = 0
    foreach ($record in $Records) {
        $index++
        $label = "record $index"
        $required = @('topic', 'book', 'counterpart', 'relationship', 'resolution', 'date')
        $missing = @($required | Where-Object { $null -eq $record.PSObject.Properties[$_] })
        if ($missing.Count) {
            [void]$problems.Add("$label is missing $(@($missing) -join ', ')")
            continue
        }
        $label = "record $index ($($record.topic): $($record.book)/$($record.counterpart))"

        foreach ($field in @('topic', 'book', 'counterpart')) {
            $value = [string]$record.$field
            if ([string]::IsNullOrWhiteSpace($value) -or $value -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
                [void]$problems.Add("$label has a malformed $field '$value'")
            }
        }
        if ([string]$record.book -ceq [string]$record.counterpart) {
            [void]$problems.Add("$label pairs a Book with itself")
        }
        foreach ($field in @('book', 'counterpart')) {
            $value = [string]$record.$field
            if ($value -and ($KnownSlugs -cnotcontains $value)) {
                [void]$problems.Add("$label names shelf/$value, which shelf/_catalog.md does not list")
            }
        }
        $relationship = [string]$record.relationship
        if (-not $script:AllowedResolutions.ContainsKey($relationship)) {
            [void]$problems.Add("$label has an unknown relationship '$relationship'")
        }
        else {
            $resolution = [string]$record.resolution
            if ($script:AllowedResolutions[$relationship] -cnotcontains $resolution) {
                [void]$problems.Add("$label is '$relationship' with resolution '$resolution'; allowed: $(@($script:AllowedResolutions[$relationship]) -join ', ')")
            }
        }
        $date = [string]$record.date
        if ($date -cnotmatch '^\d{4}-\d{2}-\d{2}$') {
            [void]$problems.Add("$label has a malformed date '$date'")
        }

        $key = Get-PairKey ([string]$record.topic) ([string]$record.book) ([string]$record.counterpart)
        if ($seen.ContainsKey($key)) {
            [void]$problems.Add("$label duplicates the pair already recorded as record $($seen[$key]); one topic and Book pair holds exactly one relationship")
        }
        else { $seen[$key] = $index }
    }
    $problems
}

function Save-OverlapFile([string]$Workspace, [object[]]$Records) {
    $path = Join-Path $Workspace $script:RecordRelativePath
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $sorted = @($Records | Sort-Object -Property @{ Expression = { [string]$_.topic } }, @{ Expression = { [string]$_.book } }, @{ Expression = { [string]$_.counterpart } })
    $payload = [ordered]@{ schema = $script:OverlapSchema; records = $sorted }
    $json = ([pscustomobject]$payload | ConvertTo-Json -Depth 8) + [Environment]::NewLine

    # Write beside the destination and swap, so a crash mid-write leaves the previous record set
    # intact rather than a truncated one. File.Move has no overwrite overload on Windows PowerShell,
    # so an existing destination is replaced and a new one is moved into place.
    $temp = "$path.tmp"
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    # [NullString]::Value, not $null: PowerShell converts $null to an empty string when binding a
    # [string] parameter, and File.Replace rejects "" as "The path is not of a legal form."
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temp, $path, [NullString]::Value) }
    else { [IO.File]::Move($temp, $path) }
    $path
}

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$knownSlugs = @(Get-ShelfBookSlugs -Workspace $workspace)

if ($Action -in @('Add', 'Set', 'Remove')) {
    Assert-Slug $Topic 'Topic'
    Assert-Slug $Slug 'Slug'
    Assert-Slug $Counterpart 'Counterpart'
    if ($Slug -ceq $Counterpart) { throw 'A Book cannot overlap itself; -Slug and -Counterpart must differ.' }
}
if ($Action -in @('Add', 'Set')) {
    foreach ($candidate in @($Slug, $Counterpart)) {
        if ($knownSlugs -cnotcontains $candidate) { throw "No Shelf Book '$candidate' is listed in shelf/_catalog.md." }
    }
}
if ($Action -eq 'Add' -and -not $Relationship) {
    throw '-Relationship is required when adding a record. Use unverified when the copies have not been read.'
}
if ($Date) { Assert-IsoDate $Date }
if ($Note -and $Note -match '[\r\n]') { throw 'Note must be a single line.' }

# One writer at a time. The record file is shared by every Book, so the lock is taken on the record
# set rather than on either Book -- a per-Book lock would let two pairs interleave a read-modify-write
# and lose one of them. Reads do not need it.
$lock = $null
if ($Action -in @('Add', 'Set', 'Remove')) {
    $lock = Enter-BookLock -Workspace $workspace -BookRoot 'internal/overlap-records'
}

try {
    $state = Read-OverlapFile -Workspace $workspace
    $records = [Collections.Generic.List[object]]::new()
    foreach ($record in @($state.records)) { [void]$records.Add($record) }

    switch ($Action) {
        'List' {
            # Not $matches: that is an automatic variable PowerShell fills from -match.
            $selected = @($records | Where-Object {
                    (-not $Topic -or [string]$_.topic -ceq $Topic) -and
                    (-not $Slug -or [string]$_.book -ceq $Slug -or [string]$_.counterpart -ceq $Slug)
                })
            $result = [pscustomobject]@{
                operation = 'ListTopicOverlaps'
                path      = $script:RecordRelativePath
                total     = $records.Count
                count     = $selected.Count
                records   = $selected
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        'Validate' {
            $problems = @(Test-OverlapRecords -Records @($records) -KnownSlugs $knownSlugs)
            if ($problems.Count) {
                throw "$($script:RecordRelativePath) has $($problems.Count) problem(s):$([Environment]::NewLine)  - $(@($problems) -join "$([Environment]::NewLine)  - ")"
            }
            $result = [pscustomobject]@{
                operation = 'ValidateTopicOverlaps'
                path      = $script:RecordRelativePath
                count     = $records.Count
                valid     = $true
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        'Remove' {
            $key = Get-PairKey $Topic $Slug $Counterpart
            $kept = @($records | Where-Object { (Get-PairKey ([string]$_.topic) ([string]$_.book) ([string]$_.counterpart)) -cne $key })
            if ($kept.Count -eq $records.Count) {
                throw "No overlap record for topic '$Topic' between shelf/$Slug and shelf/$Counterpart."
            }
            $path = Save-OverlapFile -Workspace $workspace -Records $kept
            $result = [pscustomobject]@{
                operation = 'RemoveTopicOverlap'
                path      = $script:RecordRelativePath
                topic     = $Topic
                book      = $Slug
                counterpart = $Counterpart
                count     = $kept.Count
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        default {
            # Add and Set share one write path; they differ only in whether the pair must already exist.
            $key = Get-PairKey $Topic $Slug $Counterpart
            $existing = @($records | Where-Object { (Get-PairKey ([string]$_.topic) ([string]$_.book) ([string]$_.counterpart)) -ceq $key })

            if ($Action -eq 'Add' -and $existing.Count) {
                throw "An overlap record for topic '$Topic' between shelf/$Slug and shelf/$Counterpart already exists. Use -Action Set to change it."
            }
            if ($Action -eq 'Set' -and -not $existing.Count) {
                throw "No overlap record for topic '$Topic' between shelf/$Slug and shelf/$Counterpart. Use -Action Add to create it."
            }

            $prior = if ($existing.Count) { $existing[0] } else { $null }
            $relationship = if ($Relationship) { $Relationship } elseif ($prior) { [string]$prior.relationship } else { 'unverified' }
            $resolution = if ($Resolution) { $Resolution } elseif ($prior -and -not $Relationship) { [string]$prior.resolution } else { 'open' }
            $recordDate = if ($Date) { $Date } else { (Get-Date).ToString('yyyy-MM-dd') }
            $recordNote = if ($PSBoundParameters.ContainsKey('Note')) { $Note } elseif ($prior -and $null -ne $prior.PSObject.Properties['note']) { [string]$prior.note } else { '' }

            # -Slug is the direction the relationship reads in, so a Set that names the pair the other
            # way round must not silently keep the old direction.
            $entry = [pscustomobject][ordered]@{
                topic        = $Topic
                book         = $Slug
                counterpart  = $Counterpart
                relationship = $relationship
                resolution   = $resolution
                date         = $recordDate
                note         = $recordNote
            }

            $next = @(@($records | Where-Object { (Get-PairKey ([string]$_.topic) ([string]$_.book) ([string]$_.counterpart)) -cne $key }) + @($entry))
            $problems = @(Test-OverlapRecords -Records $next -KnownSlugs $knownSlugs)
            if ($problems.Count) {
                throw "Refused: $(@($problems) -join '; ')"
            }
            $path = Save-OverlapFile -Workspace $workspace -Records $next

            # Verified readback: the record set on disk is the evidence, not the object just built.
            $after = Read-OverlapFile -Workspace $workspace
            $written = @(@($after.records) | Where-Object { (Get-PairKey ([string]$_.topic) ([string]$_.book) ([string]$_.counterpart)) -ceq $key })
            if ($written.Count -ne 1) { throw "Readback failed: $($script:RecordRelativePath) does not hold exactly one record for this pair after the write." }
            if ([string]$written[0].relationship -cne $relationship -or [string]$written[0].resolution -cne $resolution -or [string]$written[0].book -cne $Slug) {
                throw "Readback mismatch: $($script:RecordRelativePath) does not hold the record that was just written."
            }

            $result = [pscustomobject]@{
                operation    = if ($Action -eq 'Add') { 'AddTopicOverlap' } else { 'SetTopicOverlap' }
                path         = $script:RecordRelativePath
                topic        = $Topic
                book         = $Slug
                counterpart  = $Counterpart
                relationship = $relationship
                resolution   = $resolution
                date         = $recordDate
                count        = @($after.records).Count
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }
    }
}
finally {
    if ($lock) { Exit-BookLock -Lock $lock }
}
