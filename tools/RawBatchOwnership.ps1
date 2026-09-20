<#
.SYNOPSIS
    Which Project owns a source batch under raw/, and whether that Project is still live. Dot-sourced;
    never invoked directly.

.DESCRIPTION
    Plan item 3.1. 2.4 answered SCOPE -- a source batch is a canonical directory under raw/ that the
    reader names -- and deliberately stopped there. This file answers the other half, OWNERSHIP, and
    nothing else.

    OWNERSHIP CANNOT BE INFERRED, WHICH IS THE WHOLE REASON THIS FILE EXISTS. CLAUDE.md documents the
    shape raw/<project-slug>/<source-batch>/, and raw/ does not follow it: `buzz-main` and
    `deepseek-harness-master` are whole repository checkouts sitting at the top level, `LLM Workflow
    Testing/pilot` sits one level down, and none of those names is a Project slug. Deriving an owner
    from a directory name would therefore be a guess dressed as a rule, and it would contradict the
    documented shape rather than implement it. So ownership is DECLARED by the reader, one batch at a
    time, and a batch nobody has declared is reported as unmapped -- never guessed.

    THIS FILE IS NOT A SECOND AUTHORITY ON SCOPE, AND THAT IS DELIBERATE. tools/RawSearch.ps1 owns
    what a source batch is: `Get-RawBatchRoster` enumerates raw/'s real shape at both depths a batch
    is actually found at, `Resolve-RawBatch` decides whether a reader-supplied name IS one, and
    `Get-RawProvenance` decides whether it holds retired instructions. All three are called here and
    none is reimplemented. A mapping is stored under the CANONICAL path Resolve-RawBatch returns,
    not under the spelling the reader typed, so the two can never disagree about which directory a
    record is about. Two authorities on one question is the drift this codebase keeps paying for.

    LIVENESS IS DERIVED AT READ TIME AND IS NEVER STORED. A record holds a Project SLUG and nothing
    about that Project's state, because a copy of the state would go stale the moment a Project is
    archived and nothing would say so. Every read joins the slug against the active and archived
    Project Catalogs and reports one of four values:

        active        the slug is listed in the active Project Catalog
        archived      it is not, and it is listed in the archived Project Catalog
        unlisted      it is in neither, and both were read successfully
        undetermined  the catalogs could not be read, so the question was not answered

    THE UNDETERMINED CASE IS THE ONE THAT MATTERS. 2.4's worst defect was an empty result stating a
    complete-sounding conclusion underneath a note saying the scan had stopped early. The same shape
    is available here: with the shared collection unreachable, "no batch is owned by an archived
    Project" is a sentence this code could produce while knowing nothing. It must not, and the
    eviction offer is reported as undetermined rather than empty whenever any mapped slug is.

    THE ARCHIVE CATALOG'S ABSENCE IS KNOWLEDGE, NOT FAILURE, AND THE TWO ARE DISTINGUISHED
    STRUCTURALLY. Basic Memory answers a read for a note that does not exist with a successful but
    EMPTY record -- the same signal the validated reader adapter keys `Test-AbsentRecord` on -- so an
    archived catalog that has never been created reads as `absent` rather than as an error.
    Archive-ProjectHub.ps1 creates it on the first archive, so absent genuinely means no Project has
    ever been archived, and a slug missing from the active catalog is then `unlisted`. A read that
    FAILS is a different thing and yields `undetermined`.

    EVICTION IS OFFERED AND NEVER PERFORMED. Nothing in this file or its helper deletes, moves, or
    modifies anything under raw/. A batch whose owning Project is archived is named as a candidate,
    with the evidence, for the reader to act on themselves. That is a deliberate boundary: raw/ is
    1.9 GB of the reader's own source material, deleting it is irreversible, and CLAUDE.md forbids
    improvising a workspace-wide deletion. Recorded in docs/raw-batch-ownership.md rather than left
    implied.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'RawSearch.ps1')

$script:RawOwnerSchema = 1
$script:RawOwnerRelativePath = 'internal/raw-batch-owners.json'

# The four values a derived liveness may take. Declared once so the resolver, the renderer, the
# eviction rule, and the canaries cannot drift apart.
$script:RawOwnerActive = 'active'
$script:RawOwnerArchived = 'archived'
$script:RawOwnerUnlisted = 'unlisted'
$script:RawOwnerUndetermined = 'undetermined'

# Catalog read outcomes. `absent` is not a failure -- see the header.
$script:RawOwnerReadOk = 'ok'
$script:RawOwnerReadAbsent = 'absent'
$script:RawOwnerReadFailed = 'failed'

$script:RawOwnerActiveCatalogPath = 'projects/README.md'
$script:RawOwnerArchiveCatalogPath = 'archive/projects/README.md'

# Rendered as the last line of every report, the way Get-SearchClosingRule closes every search tier.
# One string, so a renderer cannot state a softer version of it than a canary asserts.
function Get-RawOwnerEvictionRule {
    'An eviction candidate is an OFFER, not an action: nothing here deletes, moves, or modifies anything under raw/, and no record is a licence to. Ownership is what the reader declared, never what a directory name suggests.'
}

# --- The record file ------------------------------------------------------------------------------
#
# internal/, and internal/ is gitignored -- which is the right home here and the WRONG one for the
# declared historical roots, for a reason worth stating because the two look alike. A provenance
# label is policy: it must survive a fresh clone or the label can go missing, so RawSearch.ps1 keeps
# that list in tracked source. An ownership record is about reader material that is itself
# gitignored; on a fresh clone the batches are gone too, and a mapping for a directory that does not
# exist is not a loss. Same directory, opposite conclusions, both deliberate.

function Get-RawOwnerRecordPath([string]$Workspace) {
    Join-Path $Workspace $script:RawOwnerRelativePath
}

function New-RawOwnerRecord([string]$Batch, [string]$Project, [string]$Date, [string]$Note) {
    [pscustomobject][ordered]@{
        batch   = $Batch
        project = $Project
        date    = $Date
        note    = $Note
    }
}

function Read-RawOwnerFile([string]$Workspace) {
    $path = Get-RawOwnerRecordPath $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ schema = $script:RawOwnerSchema; records = @() }
    }
    # [IO.File]::ReadAllText, never Get-Content -Raw: the latter reads a BOM-less UTF-8 file as ANSI
    # under Windows PowerShell 5.1, and a batch name carrying an accent would come back mangled.
    $raw = [IO.File]::ReadAllText($path)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ schema = $script:RawOwnerSchema; records = @() }
    }
    try { $parsed = $raw | ConvertFrom-Json }
    catch { throw "$($script:RawOwnerRelativePath) is not valid JSON: $($_.Exception.Message)" }

    if ($null -eq $parsed.PSObject.Properties['schema']) { throw "$($script:RawOwnerRelativePath) has no schema field." }
    if ([int]$parsed.schema -ne $script:RawOwnerSchema) {
        throw "$($script:RawOwnerRelativePath) is schema $($parsed.schema); this helper writes schema $($script:RawOwnerSchema)."
    }
    # @() twice over: a single record unrolls to a bare object and .Count then fails under
    # StrictMode, and an absent list must read as empty rather than as $null.
    $records = @()
    if ($null -ne $parsed.PSObject.Properties['records'] -and $null -ne $parsed.records) { $records = @($parsed.records) }
    [pscustomobject]@{ schema = $script:RawOwnerSchema; records = $records }
}

function Save-RawOwnerFile([string]$Workspace, [object[]]$Records) {
    $path = Get-RawOwnerRecordPath $Workspace
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $sorted = @($Records | Sort-Object -Property @{ Expression = { [string]$_.batch } })
    $payload = [ordered]@{ schema = $script:RawOwnerSchema; records = $sorted }
    $json = ([pscustomobject]$payload | ConvertTo-Json -Depth 8) + [Environment]::NewLine

    # Write beside the destination and swap, so a crash mid-write leaves the previous record set
    # intact rather than a truncated one. Same idiom as Set-TopicOverlap.ps1, including the reason
    # for [NullString]::Value: PowerShell binds $null to a [string] parameter as '', and
    # File.Replace rejects '' as "The path is not of a legal form."
    $temp = "$path.tmp"
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temp, $path, [NullString]::Value) }
    else { [IO.File]::Move($temp, $path) }
    $path
}

# --- Validation -----------------------------------------------------------------------------------

function ConvertTo-RawOwnerBatchKey([string]$Batch) {
    ([string]$Batch).Replace('\', '/').Trim('/')
}

function Test-RawOwnerRecords {
    <#
    .SYNOPSIS
        Every structural problem in a record set. Empty means the set is valid. Offline and total:
        it touches neither raw/ nor the shared collection.

    .DESCRIPTION
        WHAT IS DELIBERATELY NOT VALIDATED HERE, AND WHY.

        That the Project exists. That is liveness, it is derived at read time by design, and
        validating it offline would either need a stored copy of the answer -- the exact staleness
        this item exists to prevent -- or would fail the pre-commit hook whenever the NAS is down.

        That the batch exists on disk. raw/ is gitignored, so on a fresh clone EVERY batch is
        missing, and a reader who evicts a batch has done the right thing rather than corrupted a
        record. A mapping with no directory behind it is reported by the read path as stale, which
        is information; failing a commit over it would be noise.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Records)

    $problems = [Collections.Generic.List[string]]::new()
    # Ordinal, deliberately. A PowerShell hashtable literal compares keys case-INSENSITIVELY, which
    # would silently do this rule's job and leave the explicit lowercasing below untested -- a
    # mutation sweep found exactly that. One mechanism, declared where it can be read.
    $seen = [Collections.Generic.Dictionary[string, int]]::new([StringComparer]::Ordinal)
    $index = 0
    foreach ($record in $Records) {
        $index++
        $label = "record $index"
        $required = @('batch', 'project', 'date')
        $missing = @($required | Where-Object { $null -eq $record.PSObject.Properties[$_] })
        if ($missing.Count) {
            [void]$problems.Add("$label is missing $(@($missing) -join ', ')")
            continue
        }
        $batch = [string]$record.batch
        $label = "record $index (raw/$batch)"

        # A batch key is a plain relative path under raw/. The shapes refused here are the ones that
        # would make a mapping mean something other than one directory: an absolute path, an escape,
        # or a name that widens to raw/ itself.
        if ([string]::IsNullOrWhiteSpace($batch)) {
            [void]$problems.Add("$label has an empty batch")
        }
        elseif ($batch -cne (ConvertTo-RawOwnerBatchKey $batch)) {
            [void]$problems.Add("$label has a batch that is not canonical: '$batch' should be stored as '$(ConvertTo-RawOwnerBatchKey $batch)'")
        }
        elseif ($batch -match '[\x00-\x1F]' -or $batch.Contains('\')) {
            [void]$problems.Add("$label has a batch carrying a backslash or control character")
        }
        elseif (@($batch.Split('/')) -contains '.' -or @($batch.Split('/')) -contains '..' -or @($batch.Split('/')) -contains '') {
            [void]$problems.Add("$label has a batch with a relative or empty path segment: '$batch'")
        }
        elseif ($batch -match '^[A-Za-z]:' -or $batch.StartsWith('//')) {
            [void]$problems.Add("$label has a batch that is not relative to raw/: '$batch'")
        }

        # -cnotmatch, not -notmatch: PowerShell's -notmatch is case-insensitive, so 'Library-Dev'
        # would satisfy a lowercase-only rule and be stored as a slug that never matches the Project
        # Catalog. Same family as Set-TopicOverlap and the note triage; linted by
        # powershell.defect-families.
        $project = [string]$record.project
        if ([string]::IsNullOrWhiteSpace($project) -or $project -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
            [void]$problems.Add("$label has a malformed project slug '$project'")
        }

        $date = [string]$record.date
        if ($date -cnotmatch '^\d{4}-\d{2}-\d{2}$') {
            [void]$problems.Add("$label has a malformed date '$date'")
        }

        # One batch, one owner. Compared case-insensitively because these are Windows filesystem
        # paths: two records differing only in case name the same directory, and storing both would
        # make ownership depend on which one the resolver happened to see first.
        $key = (ConvertTo-RawOwnerBatchKey $batch).ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            [void]$problems.Add("$label duplicates the batch already mapped by record $($seen[$key]); one batch has exactly one owner")
        }
        else { $seen[$key] = $index }
    }
    $problems
}

# --- Ownership resolution -------------------------------------------------------------------------

function Get-RawOwnerRecordFor {
    <#
    .SYNOPSIS
        The record that owns one batch path, or $null. Longest declared prefix wins.

    .DESCRIPTION
        A mapping covers its whole subtree, exactly as a declared historical root does in
        RawSearch.ps1, and for the same reason: a repository checkout is one piece of source material
        whether the reader names its root or a directory inside it. Longest prefix wins, so a reader
        who owns `LLM Workflow Testing` by one Project and `LLM Workflow Testing/guild-lab` by
        another gets the specific answer rather than the general one.

        OrdinalIgnoreCase is correct here and is NOT defect family 1: these are Windows filesystem
        paths, which are case-insensitive, and the declared keys carry capitals and spaces rather
        than being a lowercase-only rule.
    #>
    param([AllowEmptyCollection()][object[]]$Records, [string]$Batch)

    $normalised = ConvertTo-RawOwnerBatchKey $Batch
    if ([string]::IsNullOrWhiteSpace($normalised)) { return $null }

    $best = $null
    $bestLength = -1
    foreach ($record in @($Records)) {
        if ($null -eq $record -or $null -eq $record.PSObject.Properties['batch']) { continue }
        $key = ConvertTo-RawOwnerBatchKey ([string]$record.batch)
        if ([string]::IsNullOrWhiteSpace($key)) { continue }
        $covers = $normalised.Equals($key, [StringComparison]::OrdinalIgnoreCase) -or
                  $normalised.StartsWith($key + '/', [StringComparison]::OrdinalIgnoreCase)
        if ($covers -and $key.Length -gt $bestLength) {
            $best = $record
            $bestLength = $key.Length
        }
    }
    $best
}

# --- Project catalogs and liveness ------------------------------------------------------------------

function New-RawOwnerCatalogSet {
    <#
    .SYNOPSIS
        A catalog set: what was read, what it listed, and why anything was not read.

    .DESCRIPTION
        The join below is pure -- it takes this object and never reaches the network itself -- so
        every liveness state including `undetermined` is reachable in an offline suite. The fetch
        lives in Get-RawOwnerCatalogSet, and the reader-facing helper is what calls it.
    #>
    param(
        [string]$ActiveRead = $script:RawOwnerReadFailed,
        [AllowEmptyCollection()][string[]]$ActiveSlugs = @(),
        [string]$ActiveReason = '',
        [string]$ArchiveRead = $script:RawOwnerReadFailed,
        [AllowEmptyCollection()][string[]]$ArchiveSlugs = @(),
        [string]$ArchiveReason = ''
    )
    [pscustomobject]@{
        active_read    = $ActiveRead
        active_slugs   = @($ActiveSlugs)
        active_reason  = $ActiveReason
        archive_read   = $ArchiveRead
        archive_slugs  = @($ArchiveSlugs)
        archive_reason = $ArchiveReason
    }
}

function ConvertTo-RawOwnerCatalogSlugs([string]$CatalogText, [string]$Prefix) {
    <#
    .SYNOPSIS
        The Project slugs a Catalog body links to. Pure text; no MCP.
    #>
    $slugs = [Collections.Generic.List[string]]::new()
    $seen = @{}
    $pattern = '(?m)^\s*-\s*\[\[' + [regex]::Escape($Prefix) + '/([a-z0-9][a-z0-9-]*)/_project\|'
    foreach ($match in @([regex]::Matches([string]$CatalogText, $pattern))) {
        $slug = $match.Groups[1].Value
        if ($seen.ContainsKey($slug)) { continue }
        $seen[$slug] = $true
        [void]$slugs.Add($slug)
    }
    @($slugs)
}

function Resolve-RawOwnerLiveness {
    <#
    .SYNOPSIS
        One Project slug's liveness, derived from a catalog set. Never guesses and never defaults to
        live.

    .DESCRIPTION
        Decomposed so that an unreadable ARCHIVE catalog only degrades the answer for slugs that
        actually need it. A slug listed as active is active whatever the archive says; a slug that
        is not listed as active is the only one whose answer depends on the archive, and it is the
        one that goes `undetermined` when the archive could not be read.
    #>
    param([object]$Catalogs, [string]$Slug)

    if ($null -eq $Catalogs) { return $script:RawOwnerUndetermined }
    if ([string]$Catalogs.active_read -cne $script:RawOwnerReadOk) { return $script:RawOwnerUndetermined }
    if (@($Catalogs.active_slugs) -ccontains $Slug) { return $script:RawOwnerActive }

    $archive = [string]$Catalogs.archive_read
    if ($archive -ceq $script:RawOwnerReadOk) {
        if (@($Catalogs.archive_slugs) -ccontains $Slug) { return $script:RawOwnerArchived }
        return $script:RawOwnerUnlisted
    }
    # An archived Catalog that has never been created is knowledge: Archive-ProjectHub.ps1 creates it
    # on the first archive, so its absence means nothing has ever been archived.
    if ($archive -ceq $script:RawOwnerReadAbsent) { return $script:RawOwnerUnlisted }
    $script:RawOwnerUndetermined
}

# --- The report -------------------------------------------------------------------------------------

function Get-RawBatchOwnershipReport {
    <#
    .SYNOPSIS
        Every top-level source batch joined against its declared owner and that owner's derived
        liveness, plus every declared mapping and what it currently resolves to.

    .DESCRIPTION
        The roster comes from RawSearch.ps1 and the shape of raw/ is read from disk each time, so a
        batch added or evicted since the last run is reflected without anything being rebuilt.

        REPORTED AT THE TOP LEVEL, BECAUSE A MAPPING COVERS ITS SUBTREE. raw/ holds roughly 500
        directories at the roster's two depths, and listing every one of them as separately unmapped
        would be a wall rather than a report. A depth-1 root is the unit an ownership decision is
        actually made about; anything under it inherits, and a reader who wants a finer grain
        declares a deeper mapping, which is then listed on its own.

        NO CAP LIVES HERE, AND THAT IS ON PURPOSE. The roots are a handful and the mappings are
        whatever the reader declared. A cap that cannot bind is a flag nobody watches go red -- this
        plan has already found one of those -- so there is none to report on.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [object]$Catalogs
    )

    $rawRoot = Get-RawRoot $Workspace
    $rawPresent = Test-Path -LiteralPath $rawRoot -PathType Container

    $state = Read-RawOwnerFile -Workspace $Workspace
    $records = @($state.records)
    $roster = @(Get-RawBatchRoster -Workspace $Workspace)

    $roots = [Collections.Generic.List[object]]::new()
    foreach ($entry in @($roster | Where-Object { [int]$_.depth -eq 1 })) {
        $batch = [string]$entry.batch
        # A root can only ever be owned DIRECTLY -- nothing sits above it to inherit from -- so the
        # resolver either finds a record for this exact path or the root is unmapped. What a root can
        # have is mappings BENEATH it, which own part of its subtree without owning the root, and a
        # bare "UNMAPPED" would hide that the reader has already made a finer-grained decision.
        $owner = Get-RawOwnerRecordFor -Records $records -Batch $batch
        $slug = if ($null -eq $owner) { '' } else { [string]$owner.project }
        $prefix = (ConvertTo-RawOwnerBatchKey $batch) + '/'
        $beneath = @($records | Where-Object {
                (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
            })
        [void]$roots.Add([pscustomobject]@{
                batch      = $batch
                provenance = [string]$entry.provenance
                children   = [int]$entry.children
                project    = $slug
                mapped     = ($null -ne $owner)
                sub_mapped = $beneath.Count
                liveness   = if ($null -eq $owner) { '' } else { (Resolve-RawOwnerLiveness -Catalogs $Catalogs -Slug $slug) }
            })
    }

    $mappings = [Collections.Generic.List[object]]::new()
    foreach ($record in $records) {
        $batch = ConvertTo-RawOwnerBatchKey ([string]$record.batch)
        $slug = [string]$record.project
        # Resolve-RawBatch is the authority on whether this names a real batch today -- not a second
        # existence test written here.
        $resolved = Resolve-RawBatch -Workspace $Workspace -Batch $batch
        [void]$mappings.Add([pscustomobject]@{
                batch      = $batch
                project    = $slug
                date       = if ($null -eq $record.PSObject.Properties['date']) { '' } else { [string]$record.date }
                note       = if ($null -eq $record.PSObject.Properties['note']) { '' } else { [string]$record.note }
                on_disk    = [bool]$resolved.recognised
                miss_reason = if ($resolved.recognised) { '' } else { [string]$resolved.reason }
                provenance = if ($resolved.recognised) { [string]$resolved.provenance } else { (Get-RawProvenance $batch) }
                liveness   = (Resolve-RawOwnerLiveness -Catalogs $Catalogs -Slug $slug)
            })
    }

    $unmapped = @(@($roots | Where-Object { -not $_.mapped }) | ForEach-Object { [string]$_.batch })
    $stale = @($mappings | Where-Object { -not $_.on_disk })
    $evictable = @($mappings | Where-Object { $_.on_disk -and ([string]$_.liveness -ceq $script:RawOwnerArchived) })
    # THE SAME EMPTY CANDIDATE LIST HAS TWO CAUSES, AND ONLY ONE OF THEM IS "nothing is archived".
    # An archived owner whose directory is already gone is not on disk, so it never reaches
    # $evictable -- and the render used to answer that with "No batch is owned by an archived
    # Project", denying a mapping it had printed as [archived] four lines above. Held as its own set
    # so the render can tell the two apart. Found by the first live run that had a real archived
    # Project to resolve, 2026-09-03: raw/buzz-main -- buzz-relay-deployment [archived] -- NO DIRECTORY.
    $archivedAbsent = @($mappings | Where-Object { (-not $_.on_disk) -and ([string]$_.liveness -ceq $script:RawOwnerArchived) })
    # A record naming a Project that is in NEITHER Catalog. Distinct from an archived owner, which is
    # an eviction offer, and from an unreadable Catalog, which is `undetermined` rather than
    # `unlisted` -- so this set can never be populated by a failure to look.
    $dangling = @($mappings | Where-Object { [string]$_.liveness -ceq $script:RawOwnerUnlisted })

    # THE PARTIAL-ANSWER RULE, AS TWO FIELDS RATHER THAN ONE. These are different questions and the
    # first version of this report answered both with one flag, which the FIRST LIVE RUN caught: with
    # the catalogs unreachable and no mapping declared yet, no mapping was undetermined, so the one
    # flag read "determined" while nothing had been read at all -- and it sat beside a populated
    # reason saying the opposite. One cap doing two jobs reports one of them wrongly whichever it
    # picks.
    #
    #   catalogs_read        were the Project Catalogs actually read? A property of the network call.
    #   eviction_determined  is the candidate list complete? A property of the MAPPINGS, and
    #                        vacuously true when there are none, because a list of nothing really is
    #                        complete.
    $undetermined = @($mappings | Where-Object { [string]$_.liveness -ceq $script:RawOwnerUndetermined })
    $evictionDetermined = ($undetermined.Count -eq 0)

    $livenessReason = ''
    if ($null -eq $Catalogs) { $livenessReason = 'the Project Catalogs were not read, so no mapping has a derived liveness' }
    elseif ([string]$Catalogs.active_read -cne $script:RawOwnerReadOk) {
        $reason = [string]$Catalogs.active_reason
        $livenessReason = "the active Project Catalog could not be read$(if ($reason) { ": $reason" } else { '' })"
    }
    elseif ([string]$Catalogs.archive_read -ceq $script:RawOwnerReadFailed) {
        $reason = [string]$Catalogs.archive_reason
        $livenessReason = "the archived Project Catalog could not be read$(if ($reason) { ": $reason" } else { '' })"
    }

    [pscustomobject]@{
        operation           = 'RawBatchOwnershipReport'
        status              = 'ok'
        raw_present         = [bool]$rawPresent
        record_path         = $script:RawOwnerRelativePath
        roots_total         = $roots.Count
        roots_unmapped      = $unmapped.Count
        records_total       = $mappings.Count
        catalog_active      = if ($null -eq $Catalogs) { $script:RawOwnerReadFailed } else { [string]$Catalogs.active_read }
        catalog_archive     = if ($null -eq $Catalogs) { $script:RawOwnerReadFailed } else { [string]$Catalogs.archive_read }
        catalogs_read       = [bool]([string]::IsNullOrEmpty($livenessReason))
        liveness_reason     = $livenessReason
        roots               = @($roots)
        mappings            = @($mappings)
        unmapped            = $unmapped
        stale_mappings      = $stale
        dangling_mappings   = $dangling
        eviction_candidates = $evictable
        archived_absent     = $archivedAbsent
        eviction_determined = [bool]$evictionDetermined
    }
}

# --- Rendering ----------------------------------------------------------------------------------------

function Format-RawBatchOwnershipReport($Report) {
    $lines = [Collections.Generic.List[string]]::new()

    if (-not $Report.raw_present) {
        [void]$lines.Add('This workspace has no raw/ directory, so there are no source batches to own.')
        if ($Report.records_total -gt 0) {
            [void]$lines.Add("$($Report.records_total) ownership record(s) are still declared; every one of them is stale until raw/ exists again.")
        }
        [void]$lines.Add('')
        [void]$lines.Add((Get-RawOwnerEvictionRule))
        return ($lines -join "`n")
    }

    [void]$lines.Add("Source batch ownership: $($Report.roots_total) top-level batch(es) under raw/, $($Report.records_total) declared mapping(s).")
    [void]$lines.Add('A mapping covers its whole subtree, so a directory inside a mapped batch inherits that owner.')

    # The liveness sentence comes BEFORE any liveness value, so a reader meets the caveat before the
    # material it qualifies -- the same ordering rule 2.4's provenance banner follows. Gated on
    # whether the CATALOGS were read, not on whether the eviction list came out complete: with no
    # mapping declared the list is complete and the catalogs may still have been unreachable.
    if (-not $Report.catalogs_read) {
        [void]$lines.Add("LIVENESS WAS NOT DETERMINED: $($Report.liveness_reason). Every value below reading 'undetermined' is a question that was not answered, not a Project that is missing.")
    }

    [void]$lines.Add('')
    [void]$lines.Add('Top-level batches:')
    foreach ($root in @($Report.roots)) {
        $mark = if (Test-RawProvenanceSuperseded ([string]$root.provenance)) { " [$($root.provenance)]" } else { '' }
        $beneath = if ([int]$root.sub_mapped -gt 0) { " ($($root.sub_mapped) sub-batch mapping(s) declared)" } else { '' }
        if ($root.mapped) {
            [void]$lines.Add("  $($root.batch)$mark -- $($root.project) [$($root.liveness)]$beneath")
        }
        else {
            [void]$lines.Add("  $($root.batch)$mark -- UNMAPPED$beneath")
        }
    }

    if ($Report.roots_unmapped -gt 0) {
        [void]$lines.Add('')
        [void]$lines.Add("$($Report.roots_unmapped) of $($Report.roots_total) top-level batch(es) have no declared owner. That is reported, not guessed: raw/ does not follow the documented raw/<project-slug>/<source-batch>/ shape, so a name is not evidence of ownership. Declare one with -Action Set.")
    }

    if ($Report.records_total -gt 0) {
        [void]$lines.Add('')
        [void]$lines.Add('Declared mappings:')
        foreach ($mapping in @($Report.mappings)) {
            $mark = if (Test-RawProvenanceSuperseded ([string]$mapping.provenance)) { " [$($mapping.provenance)]" } else { '' }
            $gone = if (-not $mapping.on_disk) { " -- NO DIRECTORY: $($mapping.miss_reason)" } else { '' }
            [void]$lines.Add("  raw/$($mapping.batch)$mark -- $($mapping.project) [$($mapping.liveness)]$gone")
        }
    }

    if (@($Report.dangling_mappings).Count -gt 0) {
        [void]$lines.Add('')
        [void]$lines.Add("$(@($Report.dangling_mappings).Count) mapping(s) name a Project that is in neither the active nor the archived Project Catalog. That is a record to correct or withdraw, not an eviction offer: an unlisted Project is one nothing knows about, where an archived one is a decision that was made.")
    }

    [void]$lines.Add('')
    if ($Report.records_total -eq 0) {
        # A third sentence, because "nothing to evict" would be true here for a reason that has
        # nothing to do with liveness, and stating it as though it did is how an absence of DATA
        # gets read as a finding about the material.
        [void]$lines.Add('No batch has a declared owner yet, so no eviction offer can be made. That is the absence of a mapping, not evidence that everything under raw/ is still wanted.')
    }
    elseif (-not $Report.eviction_determined) {
        [void]$lines.Add('Eviction candidates could NOT be determined, because at least one mapped Project has an undetermined liveness. This is not a finding that there are none.')
    }
    elseif ((@($Report.eviction_candidates).Count -eq 0) -and (@($Report.archived_absent).Count -gt 0)) {
        # A FOURTH SENTENCE, for the reason the third one exists. The candidate list is empty here
        # because the archived owner's directory is ALREADY GONE, not because no owner is archived.
        # The old wording denied a mapping this same render prints as [archived] directly above, and a
        # summary that contradicts its own list is how a reader learns to stop trusting the summary.
        [void]$lines.Add("Nothing is offered for eviction: $(@($Report.archived_absent).Count) mapping(s) name an archived Project, but no directory remains under raw/ to offer.")
        foreach ($mapping in @($Report.archived_absent)) {
            [void]$lines.Add("  raw/$($mapping.batch) -- $($mapping.project) is archived, and no directory raw/$($mapping.batch) exists")
        }
    }
    elseif (@($Report.eviction_candidates).Count -eq 0) {
        [void]$lines.Add('No batch is owned by an archived Project, so nothing is offered for eviction.')
    }
    else {
        [void]$lines.Add("Offered for eviction -- $(@($Report.eviction_candidates).Count) batch(es) whose owning Project is archived:")
        foreach ($candidate in @($Report.eviction_candidates)) {
            [void]$lines.Add("  raw/$($candidate.batch) -- $($candidate.project) is archived")
        }
    }

    [void]$lines.Add('')
    [void]$lines.Add((Get-RawOwnerEvictionRule))
    ($lines -join "`n")
}

# --- Fetching the catalogs ----------------------------------------------------------------------------

function Get-RawOwnerCatalogSet {
    <#
    .SYNOPSIS
        Read both Project Catalogs over MCP and return a catalog set. Never throws: an unreadable
        catalog is a reported state, because a failure here must degrade the answer rather than
        replace it.

    .DESCRIPTION
        Uses SharedBookSource.ps1's transport rather than a fourth copy of the MCP client. An ABSENT
        note is distinguished from a FAILED read structurally: Basic Memory answers a read for a note
        that does not exist with a successful but empty record, which is the signal the validated
        reader adapter keys Test-AbsentRecord on. String-matching an error message would have been a
        guess about wording.
    #>
    [CmdletBinding()]
    param([string]$McpUrl, [string]$ProjectId, [int]$TimeoutSeconds = 60)

    # SharedBookSource.ps1 uses [Net.Http.HttpClient] and does NOT load the assembly itself -- every
    # one of its other callers does it in their own param preamble, so the omission here failed on
    # the first live run with `Unable to find type [Net.Http.HttpClient]`, reported as a catalog that
    # could not be read. Loaded here so this helper is self-sufficient.
    Add-Type -AssemblyName System.Net.Http
    . (Join-Path $PSScriptRoot 'SharedBookSource.ps1')

    $session = $null
    try { $session = New-SharedBookSession -McpUrl $McpUrl -ProjectId $ProjectId -TimeoutSeconds $TimeoutSeconds }
    catch {
        return (New-RawOwnerCatalogSet -ActiveRead $script:RawOwnerReadFailed -ActiveReason $_.Exception.Message `
                -ArchiveRead $script:RawOwnerReadFailed -ArchiveReason $_.Exception.Message)
    }

    $read = {
        param($Path, $Prefix)
        try {
            $record = Read-SharedNoteExact $session $Path
            return [pscustomobject]@{ read = $script:RawOwnerReadOk; slugs = @(ConvertTo-RawOwnerCatalogSlugs ([string]$record.content) $Prefix); reason = '' }
        }
        catch {
            # Read-SharedNoteExact refuses an empty body, which is exactly how an absent note arrives.
            # Re-ask without its guard so absence can be told from failure.
            try {
                $probe = Invoke-SharedMcp $session 'tools/call' @{ name = 'read_note'; arguments = @{ project_id = $session.project_id; identifier = $Path.Substring(0, $Path.Length - 3); output_format = 'json'; include_frontmatter = $false } }
                if ($null -eq (Get-SharedRpcError $probe) -and -not $probe.result.isError) {
                    $candidate = $probe.result.structuredContent.result
                    if ($null -ne $candidate -and
                        [string]::IsNullOrWhiteSpace([string]$candidate.file_path) -and
                        [string]::IsNullOrWhiteSpace([string]$candidate.content)) {
                        return [pscustomobject]@{ read = $script:RawOwnerReadAbsent; slugs = @(); reason = 'the note does not exist' }
                    }
                }
            }
            catch { }
            return [pscustomobject]@{ read = $script:RawOwnerReadFailed; slugs = @(); reason = $_.Exception.Message }
        }
    }

    $active = & $read $script:RawOwnerActiveCatalogPath 'projects'
    $archive = & $read $script:RawOwnerArchiveCatalogPath 'archive/projects'

    New-RawOwnerCatalogSet -ActiveRead $active.read -ActiveSlugs @($active.slugs) -ActiveReason $active.reason `
        -ArchiveRead $archive.read -ArchiveSlugs @($archive.slugs) -ArchiveReason $archive.reason
}

# --- Mutation -----------------------------------------------------------------------------------------
#
# The record set is read, changed, validated, written, and read back here. THE LOCK IS THE CALLER'S:
# Set-RawBatchOwner.ps1 takes the non-Book key `internal/raw-batch-owners` around these, because the
# file is shared by every batch and a per-batch lock would let two declarations interleave a
# read-modify-write and lose one. These functions are separate from the helper so the suite can drive
# them directly rather than through a process boundary.

function Set-RawOwnerMapping {
    <#
    .SYNOPSIS
        Declare which Project owns one source batch. Upsert: re-declaring an owner replaces the record.

    .DESCRIPTION
        Resolve-RawBatch decides whether the name IS a source batch, and the record is stored under
        the canonical path IT returns rather than under the spelling the reader typed. That is what
        keeps RawSearch.ps1 the single authority on scope: this file never decides that something is
        or is not a batch.

        The Project slug is checked for SHAPE and not for existence. Existence is liveness, it is
        derived at read time by design, and requiring it here would refuse a perfectly good mapping
        whenever the NAS is unreachable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Batch,
        [Parameter(Mandatory = $true)][string]$Project,
        [string]$Date,
        [string]$Note
    )

    $resolved = Resolve-RawBatch -Workspace $Workspace -Batch $Batch
    if (-not $resolved.recognised) {
        throw "raw/$Batch is not a source batch: $($resolved.reason)"
    }
    $canonical = ConvertTo-RawOwnerBatchKey ([string]$resolved.batch)

    if ([string]::IsNullOrWhiteSpace($Project) -or $Project -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
        throw 'Project must be a lowercase Project slug: letters, digits, and hyphens.'
    }
    $recordDate = if ([string]::IsNullOrWhiteSpace($Date)) { (Get-Date).ToString('yyyy-MM-dd') } else { $Date }
    if ($recordDate -cnotmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Date must be an ISO date, yyyy-MM-dd.' }
    $recordNote = if ($null -eq $Note) { '' } else { [string]$Note }
    if ($recordNote -match '[\r\n]') { throw 'Note must be a single line.' }

    $state = Read-RawOwnerFile -Workspace $Workspace
    $key = $canonical.ToLowerInvariant()
    # Case-insensitive, because these are Windows paths: a second declaration spelled ALPHA is the
    # same directory as alpha and must replace it rather than sit beside it as a second owner.
    $kept = @(@($state.records) | Where-Object { (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).ToLowerInvariant() -cne $key })
    $entry = New-RawOwnerRecord $canonical $Project $recordDate $recordNote
    $next = @($kept + @($entry))

    $problems = @(Test-RawOwnerRecords -Records $next)
    if ($problems.Count) { throw "Refused: $(@($problems) -join '; ')" }
    [void](Save-RawOwnerFile -Workspace $Workspace -Records $next)

    # Verified readback: the file on disk is the evidence, not the object just built.
    $after = Read-RawOwnerFile -Workspace $Workspace
    $written = @(@($after.records) | Where-Object { (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).ToLowerInvariant() -ceq $key })
    if ($written.Count -ne 1) { throw "Readback failed: $($script:RawOwnerRelativePath) does not hold exactly one record for raw/$canonical after the write." }
    if (([string]$written[0].project -cne $Project) -or ([string]$written[0].batch -cne $canonical)) {
        throw "Readback mismatch: $($script:RawOwnerRelativePath) does not hold the record that was just written."
    }

    [pscustomobject]@{
        batch   = $canonical
        project = $Project
        date    = $recordDate
        note    = $recordNote
        count   = @($after.records).Count
        replaced = (@($state.records).Count -eq @($after.records).Count)
    }
}

function Remove-RawOwnerMapping {
    <#
    .SYNOPSIS
        Withdraw one batch's ownership record.

    .DESCRIPTION
        DELIBERATELY DOES NOT CALL Resolve-RawBatch. A mapping whose directory is gone is exactly the
        one a reader most needs to remove -- it is what a completed eviction leaves behind -- so
        requiring the batch to still exist would make the stale record unremovable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Batch
    )

    $canonical = ConvertTo-RawOwnerBatchKey $Batch
    if ([string]::IsNullOrWhiteSpace($canonical)) { throw 'Batch must name a source batch under raw/.' }
    $key = $canonical.ToLowerInvariant()

    $state = Read-RawOwnerFile -Workspace $Workspace
    $kept = @(@($state.records) | Where-Object { (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).ToLowerInvariant() -cne $key })
    if ($kept.Count -eq @($state.records).Count) {
        throw "No ownership record for raw/$canonical."
    }
    [void](Save-RawOwnerFile -Workspace $Workspace -Records $kept)

    $after = Read-RawOwnerFile -Workspace $Workspace
    $remaining = @(@($after.records) | Where-Object { (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).ToLowerInvariant() -ceq $key })
    if ($remaining.Count -ne 0) { throw "Readback failed: $($script:RawOwnerRelativePath) still holds a record for raw/$canonical." }

    [pscustomobject]@{ batch = $canonical; count = @($after.records).Count }
}

# ---------------------------------------------------------------------------------------------------
# Self-test. Fixture-only and offline; run by Invoke-LibraryChecks.ps1 as
# `raw-batch-ownership.selftest`. It reaches no network: every liveness state including
# `undetermined` is produced by handing the join a catalog set, which is why the fetch is a separate
# function from the join.
# ---------------------------------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.' -and $args -contains '-SelfTest') {
    $script:failures = [Collections.Generic.List[string]]::new()
    $script:checks = 0
    function Assert([bool]$Condition, [string]$Message) {
        $script:checks++
        if (-not $Condition) { [void]$script:failures.Add($Message) }
    }

    # Indexing an empty match set throws, and an outer catch then swallows every assertion after it,
    # so a suite that HAS the right canary reports only the first one that noticed.
    function First($Items) {
        $all = @($Items)
        if ($all.Count) { return $all[0] }
        $null
    }
    # A call that throws must be a failed assertion, not a dead suite. The module verifies its own
    # readback and throws on a mismatch, so an unguarded write is a canary that takes the suite with
    # it -- and every assertion after that point stops being run at all.
    function Invoke-SafeSet {
        param($Root, [string]$Batch, [string]$Project, [string]$Date = '2026-08-19', [string]$Note = '')
        try { return Set-RawOwnerMapping -Workspace $Root -Batch $Batch -Project $Project -Date $Date -Note $Note }
        catch { return $null }
    }
    function Invoke-SafeRemove {
        param($Root, [string]$Batch)
        try { [void](Remove-RawOwnerMapping -Workspace $Root -Batch $Batch); return $true }
        catch { return $false }
    }
    function Invoke-SafeReport($Root, $Catalogs) {
        try { return Get-RawBatchOwnershipReport -Workspace $Root -Catalogs $Catalogs }
        catch { return $null }
    }
    function Invoke-Refused([scriptblock]$Body) {
        try { & $Body | Out-Null; return '' }
        catch { return [string]$_.Exception.Message }
    }
    function Test-RenderContains($Report, [string]$Needle) {
        if ($null -eq $Report) { return $false }
        (Format-RawBatchOwnershipReport $Report).IndexOf($Needle, [StringComparison]::Ordinal) -ge 0
    }
    function Get-Root($Report, [string]$Batch) {
        if ($null -eq $Report) { return $null }
        First @(@($Report.roots) | Where-Object { [string]$_.batch -ceq $Batch })
    }
    function Get-Mapping($Report, [string]$Batch) {
        if ($null -eq $Report) { return $null }
        First @(@($Report.mappings) | Where-Object { [string]$_.batch -ceq $Batch })
    }
    function Get-RawDirectoryCount([string]$Root) {
        $rawRoot = Join-Path $Root 'raw'
        if (-not (Test-Path -LiteralPath $rawRoot -PathType Container)) { return 0 }
        @(Get-ChildItem -LiteralPath $rawRoot -Directory -Recurse -Force -ErrorAction SilentlyContinue).Count
    }

    $fixture = Join-Path ([IO.Path]::GetTempPath()) ('raw-owner-selftest-' + [guid]::NewGuid().ToString('n'))
    try {
        # An ASCII fixture cannot catch an encoding defect, so one batch name carries a real accented
        # character -- built from its code point, because a tools/*.ps1 with no BOM mangles a
        # non-ASCII literal in its own source.
        $accented = 'caf' + [char]0x00E9 + '-notes'
        foreach ($relative in @(
                'raw/alpha/beta/gamma',
                'raw/alpha-two',
                'raw/LLM Workflow Testing/pilot',
                "raw/$accented")) {
            New-Item -ItemType Directory -Path (Join-Path $fixture $relative) -Force | Out-Null
        }

        $live = New-RawOwnerCatalogSet -ActiveRead 'ok' -ActiveSlugs @('library-dev', 'buzz-relay-deployment') -ArchiveRead 'ok' -ArchiveSlugs @('old-project')
        $absentArchive = New-RawOwnerCatalogSet -ActiveRead 'ok' -ActiveSlugs @('library-dev') -ArchiveRead 'absent' -ArchiveReason 'the note does not exist'
        $allDown = New-RawOwnerCatalogSet -ActiveRead 'failed' -ActiveReason 'connection refused' -ArchiveRead 'failed' -ArchiveReason 'connection refused'
        $archiveDown = New-RawOwnerCatalogSet -ActiveRead 'ok' -ActiveSlugs @('library-dev') -ArchiveRead 'failed' -ArchiveReason 'timeout'

        # --- Liveness is derived, and never guessed ------------------------------------------------
        Assert ((Resolve-RawOwnerLiveness -Catalogs $live -Slug 'library-dev') -ceq 'active') 'an active slug was not reported active'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $live -Slug 'old-project') -ceq 'archived') 'an archived slug was not reported archived'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $live -Slug 'never-existed') -ceq 'unlisted') 'a slug in neither catalog was not reported unlisted'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $allDown -Slug 'library-dev') -ceq 'undetermined') 'an unreadable active catalog did not yield undetermined'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $null -Slug 'library-dev') -ceq 'undetermined') 'a missing catalog set did not yield undetermined'
        # An absent ARCHIVE catalog is knowledge: Archive-ProjectHub creates it on the first archive.
        Assert ((Resolve-RawOwnerLiveness -Catalogs $absentArchive -Slug 'never-existed') -ceq 'unlisted') 'an absent archive catalog did not resolve a missing slug to unlisted'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $absentArchive -Slug 'library-dev') -ceq 'active') 'an absent archive catalog disturbed an active slug'
        # An unreadable archive catalog degrades ONLY the slugs whose answer depends on it.
        Assert ((Resolve-RawOwnerLiveness -Catalogs $archiveDown -Slug 'library-dev') -ceq 'active') 'an unreadable archive catalog wrongly degraded an active slug'
        Assert ((Resolve-RawOwnerLiveness -Catalogs $archiveDown -Slug 'never-existed') -ceq 'undetermined') 'an unreadable archive catalog did not degrade a non-active slug'

        # --- Catalog parsing -----------------------------------------------------------------------
        $activeText = "# Active Projects`n`n## Projects`n`n- [[projects/buzz-relay-deployment/_project|Buzz Relay Deployment]]`n- [[projects/library-dev/_project|Library Development]]`n"
        $activeSlugs = @(ConvertTo-RawOwnerCatalogSlugs $activeText 'projects')
        Assert ($activeSlugs.Count -eq 2) "the active catalog parser found $($activeSlugs.Count) slug(s), expected 2"
        Assert ($activeSlugs -ccontains 'library-dev') 'the active catalog parser lost library-dev'
        # The archive catalog links through archive/projects/, and the active prefix must not match it.
        $archiveText = "# Archived Projects`n`n## Archived Projects`n`n- [[archive/projects/old-project/_project|Old Project]]`n"
        Assert (@(ConvertTo-RawOwnerCatalogSlugs $archiveText 'archive/projects') -ccontains 'old-project') 'the archive catalog parser lost old-project'
        Assert (@(ConvertTo-RawOwnerCatalogSlugs $archiveText 'projects').Count -eq 0) 'the active prefix matched an archived catalog entry'

        # --- Declaring ownership: RawSearch decides what a batch IS --------------------------------
        $set = Invoke-SafeSet $fixture 'alpha' 'library-dev' '2026-08-19' 'the alpha checkout'
        Assert ($null -ne $set) 'declaring an owner for raw/alpha threw'
        Assert (($null -ne $set) -and ([string]$set.batch -ceq 'alpha')) 'declaring raw/alpha did not store it as alpha'
        # Stored under the CANONICAL path, not the spelling typed. A backslash separator and a
        # trailing slash are the two shapes a reader actually types on Windows.
        $nested = Invoke-SafeSet $fixture 'alpha\beta\' 'buzz-relay-deployment'
        Assert ($null -ne $nested) 'a backslashed, trailing-slash batch name was refused outright'
        Assert (($null -ne $nested) -and ([string]$nested.batch -ceq 'alpha/beta')) 'a backslashed name was not stored under the canonical path RawSearch resolved'
        # A non-ASCII batch name must survive the JSON round trip byte for byte.
        $accentedSet = Invoke-SafeSet $fixture $accented 'library-dev' '2026-08-19' ('r' + [char]0x00E9 + 'sum' + [char]0x00E9)
        Assert ($null -ne $accentedSet) 'declaring an owner for a batch whose name carries an accent threw'
        $reread = @((Read-RawOwnerFile -Workspace $fixture).records | Where-Object { [string]$_.batch -ceq $accented })
        Assert ($reread.Count -eq 1) 'the accented batch name did not survive the record round trip'
        if ($reread.Count -eq 1) {
            Assert ([string]$reread[0].note -ceq ('r' + [char]0x00E9 + 'sum' + [char]0x00E9)) 'the accented note was mangled by the record round trip'
        }

        # A name RawSearch does not recognise is refused with RawSearch's own reason -- this file
        # never writes a second existence rule.
        $escape = Invoke-Refused { Set-RawOwnerMapping -Workspace $fixture -Batch 'alpha/../alpha-two' -Project 'library-dev' }
        Assert ($escape -ne '') 'a relative-segment batch name was accepted'
        Assert ($escape.IndexOf('relative segments are not accepted', [StringComparison]::Ordinal) -ge 0) "a relative-segment name was refused for the wrong reason: $escape"
        $ghost = Invoke-Refused { Set-RawOwnerMapping -Workspace $fixture -Batch 'no-such-batch' -Project 'library-dev' }
        Assert ($ghost.IndexOf('no directory raw/no-such-batch exists', [StringComparison]::Ordinal) -ge 0) "a nonexistent batch was refused for the wrong reason: $ghost"
        $wideningName = Invoke-Refused { Set-RawOwnerMapping -Workspace $fixture -Batch '' -Project 'library-dev' }
        Assert ($wideningName -ne '') 'an empty batch name was accepted, which is a mapping over all of raw/'

        # -cnotmatch, not -notmatch: a capitalised slug must be refused, or it is stored as a slug
        # that never matches the Project Catalog.
        # THE REASON, NOT ONLY THE REFUSAL. Test-RawOwnerRecords carries the same lowercase-only rule,
        # so relaxing the writer's own check still gets the write refused -- by the wrong gate, with
        # the wrong message. A mutation sweep found this canary asserting nothing about the writer.
        $badSlug = Invoke-Refused { Set-RawOwnerMapping -Workspace $fixture -Batch 'alpha-two' -Project 'Library-Dev' }
        Assert ($badSlug -ne '') 'a capitalised Project slug was accepted'
        Assert ($badSlug.IndexOf('Project must be a lowercase Project slug', [StringComparison]::Ordinal) -ge 0) `
            "a capitalised slug was refused by the record validator rather than by the writer's own rule: $badSlug"
        $badDate = Invoke-Refused { Set-RawOwnerMapping -Workspace $fixture -Batch 'alpha-two' -Project 'library-dev' -Date '19-08-2026' }
        Assert ($badDate -ne '') 'a malformed date was accepted'

        # One batch, one owner. A second declaration spelled in another case is the same directory.
        $before = @((Read-RawOwnerFile -Workspace $fixture).records).Count
        Assert ($null -ne (Invoke-SafeSet $fixture 'ALPHA' 'buzz-relay-deployment')) 're-declaring raw/alpha in another case threw'
        $afterUpsert = @((Read-RawOwnerFile -Workspace $fixture).records)
        Assert ($afterUpsert.Count -eq $before) "re-declaring raw/alpha in another case added a record: $before -> $($afterUpsert.Count)"
        $alphaOwners = @($afterUpsert | Where-Object { (ConvertTo-RawOwnerBatchKey ([string]$_.batch)).ToLowerInvariant() -ceq 'alpha' })
        Assert ($alphaOwners.Count -eq 1) "raw/alpha ended with $($alphaOwners.Count) owners"
        if ($alphaOwners.Count -eq 1) {
            Assert ([string]$alphaOwners[0].project -ceq 'buzz-relay-deployment') 'the re-declaration did not replace the previous owner'
        }
        Assert ($null -ne (Invoke-SafeSet $fixture 'alpha' 'library-dev' '2026-08-19' 'the alpha checkout')) 'restoring the raw/alpha owner threw'

        # --- Subtree ownership, longest prefix wins ------------------------------------------------
        $records = @((Read-RawOwnerFile -Workspace $fixture).records)
        $ownerOfDeep = Get-RawOwnerRecordFor -Records $records -Batch 'alpha/beta/gamma'
        Assert ($null -ne $ownerOfDeep) 'a directory inside a mapped subtree found no owner'
        if ($null -ne $ownerOfDeep) {
            Assert ([string]$ownerOfDeep.project -ceq 'buzz-relay-deployment') 'the longest declared prefix did not win over the shorter one'
        }
        $ownerOfShallow = Get-RawOwnerRecordFor -Records $records -Batch 'alpha'
        Assert (($null -ne $ownerOfShallow) -and ([string]$ownerOfShallow.project -ceq 'library-dev')) 'a deeper mapping wrongly claimed its parent'
        # A prefix match must respect the path separator: alpha-two is not inside alpha.
        Assert ($null -eq (Get-RawOwnerRecordFor -Records $records -Batch 'alpha-two')) 'a name-prefix match claimed a sibling batch'
        Assert ($null -eq (Get-RawOwnerRecordFor -Records $records -Batch 'LLM Workflow Testing')) 'an unmapped batch was given an owner'

        # --- The report ----------------------------------------------------------------------------
        $report = Invoke-SafeReport $fixture $live
        Assert ($null -ne $report) 'the ownership report threw'
        Assert ($report.roots_total -eq 4) "the report saw $($report.roots_total) top-level batch(es), expected 4"
        $alphaRoot = Get-Root $report 'alpha'
        Assert (($null -ne $alphaRoot) -and $alphaRoot.mapped) 'the mapped root was not reported as mapped'
        if ($null -ne $alphaRoot) {
            Assert ([string]$alphaRoot.liveness -ceq 'active') 'a mapped root lost its derived liveness'
            Assert ([int]$alphaRoot.sub_mapped -eq 1) "the mapped root reported $($alphaRoot.sub_mapped) sub-batch mapping(s), expected 1"
        }
        # UNMAPPED IS REPORTED AND NEVER GUESSED. `LLM Workflow Testing` has no declared owner and no
        # name inference may supply one.
        $historicalRoot = Get-Root $report 'LLM Workflow Testing'
        Assert (($null -ne $historicalRoot) -and (-not $historicalRoot.mapped)) 'an undeclared batch was given an owner'
        if ($null -ne $historicalRoot) {
            Assert ([string]$historicalRoot.project -ceq '') 'an unmapped root carried a project slug'
            Assert ([string]$historicalRoot.liveness -ceq '') 'an unmapped root carried a liveness value, conflating "nobody declared this" with "the Project is gone"'
            # Provenance comes from RawSearch and must survive into the ownership view.
            Assert ([string]$historicalRoot.provenance -ceq 'historical') 'the declared historical root lost its provenance label in the ownership report'
        }
        Assert ($report.unmapped -ccontains 'LLM Workflow Testing') 'the unmapped list did not name the undeclared batch'
        Assert (Test-RenderContains $report 'LLM Workflow Testing [historical] -- UNMAPPED') 'the render dropped either the historical label or the UNMAPPED marker'
        Assert (Test-RenderContains $report 'have no declared owner. That is reported, not guessed') 'the render did not say that unmapped batches are reported rather than guessed'
        Assert (Test-RenderContains $report (Get-RawOwnerEvictionRule)) 'the report did not close on the eviction rule'

        # The roster is RawSearch's, at its two depths. A depth-3 directory is not a top-level batch.
        Assert ($null -eq (Get-Root $report 'alpha/beta/gamma')) 'the report invented a top-level batch below depth 1'

        # --- Eviction is offered, and only when liveness was actually determined --------------------
        Assert ($null -ne (Invoke-SafeSet $fixture 'alpha-two' 'old-project')) 'declaring an archived Project as an owner threw'
        $withArchived = Invoke-SafeReport $fixture $live
        Assert ($null -ne $withArchived) 'the report with an archived owner threw'
        Assert ($withArchived.eviction_determined) 'a fully readable catalog set reported liveness as undetermined'
        Assert ($withArchived.catalogs_read) 'a fully readable catalog set reported the catalogs as unread'
        Assert ([string]$withArchived.liveness_reason -ceq '') 'a fully readable catalog set still carried a reason for not reading them'
        Assert (@($withArchived.eviction_candidates).Count -eq 1) "an archived owner produced $(@($withArchived.eviction_candidates).Count) eviction candidate(s), expected 1"
        Assert (Test-RenderContains $withArchived 'Offered for eviction') 'the render did not offer the archived batch for eviction'
        Assert (Test-RenderContains $withArchived 'raw/alpha-two -- old-project is archived') 'the eviction offer did not name the batch and its archived Project'
        Assert (-not (Test-RenderContains $withArchived 'No batch has a declared owner yet')) 'a report holding mappings still claimed none were declared'

        # A PARTIAL ANSWER MUST NEVER STATE A COMPLETE-SOUNDING CONCLUSION. With the catalogs
        # unreadable the candidate list is empty because nothing was asked, and rendering that as
        # "no batch is owned by an archived Project" is 2.4's worst defect in another costume.
        $blind = Invoke-SafeReport $fixture $allDown
        Assert ($null -ne $blind) 'the report with unreadable catalogs threw'
        Assert (-not $blind.eviction_determined) 'unreadable catalogs still reported eviction as determined'
        Assert (-not $blind.catalogs_read) 'unreadable catalogs reported themselves as read'
        Assert (@($blind.eviction_candidates).Count -eq 0) 'unreadable catalogs produced eviction candidates'
        Assert (Test-RenderContains $blind 'Eviction candidates could NOT be determined') 'an undetermined report did not say so'
        Assert (-not (Test-RenderContains $blind 'No batch is owned by an archived Project')) 'an undetermined report claimed there was nothing to evict'
        Assert (Test-RenderContains $blind 'LIVENESS WAS NOT DETERMINED') 'an undetermined report did not warn before its liveness values'
        Assert (Test-RenderContains $blind 'connection refused') 'an undetermined report did not carry the reason the catalogs could not be read'

        # BOTH VALUES OF THE FLAG. A sentence only ever seen in one state is not tested, so the
        # determined-and-empty case is asserted too.
        Assert (Invoke-SafeRemove $fixture 'alpha-two') 'withdrawing a mapping threw'
        $clean = Invoke-SafeReport $fixture $live
        Assert (($null -ne $clean) -and $clean.eviction_determined) 'the clean report did not report liveness as determined'
        Assert (($null -ne $clean) -and $clean.catalogs_read) 'the clean report did not report the catalogs as read'
        Assert (Test-RenderContains $clean 'No batch is owned by an archived Project') 'a determined, empty eviction list did not say so plainly'
        Assert (-not (Test-RenderContains $clean 'Eviction candidates could NOT be determined')) 'a determined report still hedged'
        Assert (-not (Test-RenderContains $clean 'LIVENESS WAS NOT DETERMINED')) 'a determined report still carried the undetermined warning'

        # --- AN ARCHIVED OWNER WHOSE DIRECTORY IS ALREADY GONE -------------------------------------
        # The candidate list is empty here too, for a completely different reason: the owner IS
        # archived, its directory simply no longer exists. Both cases rendered as "No batch is owned
        # by an archived Project", which contradicted the [archived] mapping printed above it.
        # Set-RawOwnerMapping REFUSES a batch that is not on disk, so this state is only reachable by
        # removing the directory AFTER declaring the owner -- which is exactly how raw/buzz-main
        # reached it live, declared 2026-08-19 and cleared by a later reset. The fixture reproduces
        # that order rather than hand-writing a record the helper would never have accepted.
        $goneBatch = 'alpha-gone'
        New-Item -ItemType Directory -Path (Join-Path $fixture "raw/$goneBatch") -Force | Out-Null
        Assert ($null -ne (Invoke-SafeSet $fixture $goneBatch 'old-project')) 'declaring an archived owner for a batch that is on disk threw'
        Remove-Item -LiteralPath (Join-Path $fixture "raw/$goneBatch") -Recurse -Force
        $gone = Invoke-SafeReport $fixture $live
        Assert ($null -ne $gone) 'the report with an archived owner off disk threw'
        if ($null -ne $gone) {
            Assert ($gone.eviction_determined) 'an archived owner off disk made the candidate list incomplete'
            Assert (@($gone.eviction_candidates).Count -eq 0) 'a batch with no directory was offered for eviction'
            Assert (@($gone.archived_absent).Count -eq 1) "an archived owner off disk produced $(@($gone.archived_absent).Count) record(s), expected 1"
            Assert (-not (Test-RenderContains $gone 'No batch is owned by an archived Project')) `
                'the render denied an archived owner that it had just listed as archived'
            Assert (Test-RenderContains $gone 'no directory remains under raw/ to offer') 'the render did not say why nothing could be offered'
            Assert (Test-RenderContains $gone "raw/$goneBatch -- old-project is archived, and no directory raw/$goneBatch exists") `
                'the render did not name the archived mapping whose directory is gone'
            # The offer branch still wins when something IS evictable, so the new sentence cannot
            # suppress a real candidate.
            Assert (-not (Test-RenderContains $gone 'Offered for eviction')) 'a mapping with no directory was rendered as an eviction offer'
        }
        Assert (Invoke-SafeRemove $fixture $goneBatch) 'withdrawing the off-disk mapping threw'

        # --- WHAT WAS DECLARED MUST BE VISIBLE, AND `unlisted` MUST BE REACHABLE IN THE RENDER -----
        # The second live run mapped a batch to a Project in neither Catalog, and the rendered answer
        # showed it nowhere: a deeper mapping appeared only as a count on its parent root, and the
        # `unlisted` liveness the resolver had produced had no renderer at all.
        Assert ($null -ne (Invoke-SafeSet $fixture 'alpha/beta' 'never-existed')) 'declaring an owner that is in neither catalog threw'
        $dangling = Invoke-SafeReport $fixture $live
        Assert ($null -ne $dangling) 'the report with a dangling mapping threw'
        if ($null -ne $dangling) {
            Assert (@($dangling.dangling_mappings).Count -eq 1) "a mapping naming an unlisted Project produced $(@($dangling.dangling_mappings).Count) dangling record(s), expected 1"
            Assert (Test-RenderContains $dangling 'raw/alpha/beta -- never-existed [unlisted]') 'the render did not show the deeper mapping and its unlisted Project'
            Assert (Test-RenderContains $dangling 'name a Project that is in neither') 'the render did not name the dangling mapping as a record to correct'
            # An unlisted Project is not an archived one, and only the second is an eviction offer.
            Assert (-not (Test-RenderContains $dangling 'Offered for eviction')) 'an unlisted Project was offered for eviction as though it had been archived'
        }
        # FAIL CLOSED. With the catalogs unreadable nothing is `unlisted`, because nothing was looked
        # up. A dangling set that a network error could populate would be a finding invented out of a
        # failure to look.
        $danglingBlind = Invoke-SafeReport $fixture $allDown
        Assert (($null -ne $danglingBlind) -and (@($danglingBlind.dangling_mappings).Count -eq 0)) 'unreadable catalogs produced dangling mappings'
        Assert (-not (Test-RenderContains $danglingBlind 'name a Project that is in neither')) 'unreadable catalogs still named a Project as unlisted'
        Assert ($null -ne (Invoke-SafeSet $fixture 'alpha/beta' 'buzz-relay-deployment')) 'restoring the deeper mapping threw'

        # --- THE DEFECT THE FIRST LIVE RUN FOUND ------------------------------------------------------
        # No mapping declared AND the catalogs unreachable. Nothing is undetermined because nothing
        # was asked, so a single flag covering both questions reads "determined" while the reader has
        # been told nothing -- and the warning that would have said so was suppressed with it. This
        # is the state a fresh workspace is actually in, and the suite passed 87 checks without ever
        # visiting it.
        $emptyWorkspace = Join-Path ([IO.Path]::GetTempPath()) ('raw-owner-empty-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path (Join-Path $emptyWorkspace 'raw/alpha') -Force | Out-Null
        try {
            $noRecords = Invoke-SafeReport $emptyWorkspace $allDown
            Assert ($null -ne $noRecords) 'the report on a workspace with no records threw'
            if ($null -ne $noRecords) {
                Assert ($noRecords.records_total -eq 0) 'the empty workspace reported mappings it does not have'
                Assert (-not $noRecords.catalogs_read) 'unreadable catalogs with no mappings still reported the catalogs as read'
                Assert ([string]$noRecords.liveness_reason -ne '') 'unreadable catalogs with no mappings gave no reason'
                # An empty candidate list IS complete when there is nothing to be incomplete about.
                Assert ($noRecords.eviction_determined) 'a mapping-free report called its own empty candidate list incomplete'
                Assert (Test-RenderContains $noRecords 'LIVENESS WAS NOT DETERMINED') 'the warning was suppressed because no mapping happened to be undetermined'
                Assert (-not (Test-RenderContains $noRecords 'No batch is owned by an archived Project')) `
                    'a report that read no catalog and holds no mapping concluded that nothing is owned by an archived Project'
                Assert (Test-RenderContains $noRecords 'No batch has a declared owner yet') 'the mapping-free report did not say why it can offer nothing'
                Assert (Test-RenderContains $noRecords 'not evidence that everything under raw/ is still wanted') `
                    'the mapping-free report let an absence of records read as a finding about the material'
            }
            # And with the catalogs readable, the same mapping-free workspace must not gain a warning.
            $noRecordsLive = Invoke-SafeReport $emptyWorkspace $live
            Assert (($null -ne $noRecordsLive) -and $noRecordsLive.catalogs_read) 'a readable catalog set was reported unread'
            Assert (-not (Test-RenderContains $noRecordsLive 'LIVENESS WAS NOT DETERMINED')) 'a readable catalog set still carried the undetermined warning'
            Assert (Test-RenderContains $noRecordsLive 'No batch has a declared owner yet') 'the mapping-free sentence went missing when the catalogs were readable'
        }
        finally {
            if (Test-Path -LiteralPath $emptyWorkspace) { Remove-Item -LiteralPath $emptyWorkspace -Recurse -Force -ErrorAction SilentlyContinue }
        }

        # --- A stale mapping is reported, never a validation failure --------------------------------
        Remove-Item -LiteralPath (Join-Path $fixture "raw/$accented") -Recurse -Force
        $stale = Invoke-SafeReport $fixture $live
        Assert ($null -ne $stale) 'the report with a stale mapping threw'
        $staleEntry = First @(@($stale.stale_mappings) | Where-Object { [string]$_.batch -ceq $accented })
        Assert ($null -ne $staleEntry) 'a mapping whose directory is gone was not reported as stale'
        if ($null -ne $staleEntry) {
            Assert ([string]$staleEntry.miss_reason -ne '') 'a stale mapping was reported without saying why'
        }
        Assert (Test-RenderContains $stale 'NO DIRECTORY') 'the render did not mark the mapping whose directory is gone'
        Assert (Test-RenderContains $stale 'Declared mappings:') 'the render dropped the declared-mapping listing'
        Assert (@(Test-RawOwnerRecords -Records @((Read-RawOwnerFile -Workspace $fixture).records)).Count -eq 0) `
            'a mapping with no directory behind it failed validation, which would fail every fresh clone'
        # And it must be removable, or a completed eviction leaves an unremovable record behind.
        Assert (Invoke-SafeRemove $fixture $accented) 'a mapping whose directory is gone could not be withdrawn'
        Assert (@((Read-RawOwnerFile -Workspace $fixture).records | Where-Object { [string]$_.batch -ceq $accented }).Count -eq 0) `
            'a stale mapping could not be removed'
        $absentRemoval = Invoke-Refused { Remove-RawOwnerMapping -Workspace $fixture -Batch 'alpha-two' }
        Assert ($absentRemoval -ne '') 'removing a mapping that does not exist was reported as success'

        # --- Nothing under raw/ is touched by reading ------------------------------------------------
        $countBefore = Get-RawDirectoryCount $fixture
        [void](Invoke-SafeReport $fixture $live)
        [void](Invoke-SafeReport $fixture $allDown)
        Assert ((Get-RawDirectoryCount $fixture) -eq $countBefore) 'reporting ownership changed what is on disk under raw/'

        # --- Validation, on record sets the writer would never produce --------------------------------
        Assert (@(Test-RawOwnerRecords -Records @()).Count -eq 0) 'an empty record set was reported as invalid'
        $malformed = @(
            [pscustomobject]@{ batch = 'one'; project = 'library-dev'; date = '2026-08-19' },
            [pscustomobject]@{ batch = 'One'; project = 'library-dev'; date = '2026-08-19' })
        Assert (@(Test-RawOwnerRecords -Records $malformed).Count -ge 1) 'two records for one directory, differing only in case, were accepted'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one/../two'; project = 'library-dev'; date = '2026-08-19' })).Count -ge 1) 'a relative path segment was accepted in a stored record'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'C:/one'; project = 'library-dev'; date = '2026-08-19' })).Count -ge 1) 'an absolute path was accepted as a batch key'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one\two'; project = 'library-dev'; date = '2026-08-19' })).Count -ge 1) 'a backslashed batch key was accepted as canonical'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one/'; project = 'library-dev'; date = '2026-08-19' })).Count -ge 1) 'a trailing slash was accepted as canonical'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one'; project = 'Library-Dev'; date = '2026-08-19' })).Count -ge 1) 'a capitalised slug passed validation'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one'; project = 'library-dev'; date = 'yesterday' })).Count -ge 1) 'a malformed date passed validation'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one'; project = 'library-dev' })).Count -ge 1) 'a record missing its date passed validation'
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one'; project = 'library-dev'; date = '2026-08-19' })).Count -eq 0) 'a valid record was reported as a problem'
        # Validation is deliberately blind to the Project's existence: that is liveness, and a
        # pre-commit check that needed the NAS would fail whenever the NAS was down.
        Assert (@(Test-RawOwnerRecords -Records @([pscustomobject]@{ batch = 'one'; project = 'no-such-project'; date = '2026-08-19' })).Count -eq 0) `
            'validation refused a slug for not existing, which is a read-time question'

        # --- A corrupt or foreign record file is refused rather than half-read -------------------------
        $recordPath = Join-Path $fixture 'internal/raw-batch-owners.json'
        $saved = [IO.File]::ReadAllText($recordPath)
        [IO.File]::WriteAllText($recordPath, '{ not json', [Text.UTF8Encoding]::new($false))
        Assert ((Invoke-Refused { Read-RawOwnerFile -Workspace $fixture }) -ne '') 'an unparseable record file was read as empty'
        [IO.File]::WriteAllText($recordPath, '{ "schema": 99, "records": [] }', [Text.UTF8Encoding]::new($false))
        Assert ((Invoke-Refused { Read-RawOwnerFile -Workspace $fixture }) -ne '') 'a record file from a future schema was read anyway'
        [IO.File]::WriteAllText($recordPath, $saved, [Text.UTF8Encoding]::new($false))
        Assert (@((Read-RawOwnerFile -Workspace $fixture).records).Count -ge 1) 'the restored record file did not read back'

        # --- A workspace with no raw/ at all -----------------------------------------------------------
        $bare = Join-Path ([IO.Path]::GetTempPath()) ('raw-owner-bare-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $bare -Force | Out-Null
        try {
            $bareReport = Invoke-SafeReport $bare $live
            Assert ($null -ne $bareReport) 'the report threw on a workspace with no raw/'
            if ($null -ne $bareReport) {
                Assert (-not $bareReport.raw_present) 'a workspace with no raw/ reported raw/ as present'
                Assert ($bareReport.roots_total -eq 0) 'a workspace with no raw/ reported top-level batches'
                Assert (Test-RenderContains $bareReport 'has no raw/ directory') 'a workspace with no raw/ did not say so'
                Assert (Test-RenderContains $bareReport (Get-RawOwnerEvictionRule)) 'the empty report dropped the eviction rule'
            }
        }
        finally {
            if (Test-Path -LiteralPath $bare) { Remove-Item -LiteralPath $bare -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    catch {
        # An escaping exception is a FAILURE, not a quiet end to the run. 3.2's suite printed
        # "55 checks passed" after a missing dot-source aborted its fixture block; the same hole was
        # here.
        Assert $false "the suite stopped early: $($_.Exception.Message)"
    }
    finally {
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if ($script:failures.Count) {
        [Console]::Error.WriteLine("raw-batch-ownership selftest: $($script:failures.Count) of $($script:checks) check(s) FAILED")
        foreach ($failure in $script:failures) { [Console]::Error.WriteLine("  - $failure") }
        exit 1
    }
    Write-Output "raw-batch-ownership selftest: $($script:checks) checks passed"
    exit 0
}
