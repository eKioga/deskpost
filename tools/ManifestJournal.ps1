<#
.SYNOPSIS
    The progress journal a manifest backfill writes, reads, and resumes from. Dot-sourced; never
    invoked directly.

.DESCRIPTION
    Plan item 2.2. Rung 5 built this for the Shelf and rung 7 needs the same thing for the shared
    collection, so it lives here rather than twice: two runners, one journal format. What differs
    between the collections is where pages come from, not how progress is recorded, and a second
    copy of this would be a second thing to keep identical.

    THE JOURNAL IS A FAST PATH; THE STORE IS THE AUTHORITY. It is rewritten in full after every Book
    via a temp file and a replacing move, because a journal written only at the end cannot survive
    the interruption it exists for. On a re-run, a `committed` entry is trusted only when the store
    -- which reads no body -- still confirms it. An unreadable, half-written, or absent journal is
    treated as absent and is never fatal.
#>

Set-StrictMode -Version Latest

$script:ManifestJournalSchema = 1

function Get-ManifestSha256Text([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))
        -join @($bytes | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
}

# A temp file plus a replacing move, exactly like Add-ShelfBookTopic's Save-TopicJournal: an
# interruption during the write leaves the previous journal intact rather than a truncated one, and
# a half-written progress record is worse than a slightly stale one because resume trusts it.
function Save-ManifestJournal([string]$Path, $Data) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function New-ManifestJournal([string]$Mode, [string]$Digest, [string]$PlanId, [bool]$ClosedBooksApproved) {
    [pscustomobject]@{
        schema                = $script:ManifestJournalSchema
        mode                  = $Mode
        digest                = $Digest
        plan_id               = $PlanId
        # The run's own record: it can only have reached this point with closed Books in scope by
        # carrying the approval.
        closed_books_approved = $ClosedBooksApproved
        started               = (Get-Date).ToUniversalTime().ToString('o')
        updated               = ''
        entries               = [pscustomobject]@{}
    }
}

function Read-ManifestJournal([string]$Path, [string]$Digest) {
    <#
    .SYNOPSIS
        Load a journal for this exact run, or $null. Never throws.
    #>
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $loaded = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        # Enumerated rather than read as .Properties.Name: under Set-StrictMode that property throws
        # on an empty member collection instead of yielding nothing.
        $fields = @($loaded.PSObject.Properties | ForEach-Object { $_.Name })
        if (($fields -ccontains 'digest') -and ($fields -ccontains 'entries') -and ([string]$loaded.digest -ceq $Digest)) {
            return $loaded
        }
    }
    catch { return $null }
    $null
}

# One journal mutation, shared by every branch of a per-Book loop so no path writes a partial entry.
# -Force overwrites, which is what a re-run of a Book needs: the journal records the LAST outcome,
# and only a `committed` entry is ever trusted on resume.
function Set-ManifestJournalEntry($Journal, [string]$Slug, $Outcome, [string]$At) {
    $Journal.entries | Add-Member -NotePropertyName $Slug -NotePropertyValue ([pscustomobject]@{
        status        = $Outcome.status
        generation    = $Outcome.generation
        source_digest = $Outcome.source_digest
        detail        = $Outcome.detail
        at            = $At
    }) -Force
    $Journal.updated = $At
}
