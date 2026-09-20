<#
.SYNOPSIS
    Declare, withdraw, and report which Project owns each source batch under raw/, with the owning
    Project's liveness derived fresh on every read.

.DESCRIPTION
    Plan item 3.1. tools/RawBatchOwnership.ps1 holds the record file, the validation, the liveness
    join, and the suite, exactly as RawSearch.ps1 does for 2.4's search tier.

    OWNERSHIP IS DECLARED, NEVER INFERRED. raw/ does not follow the documented
    raw/<project-slug>/<source-batch>/ shape -- whole repository checkouts sit at the top level and
    none of their names is a Project slug -- so a name is not evidence of ownership. A batch nobody
    has declared is reported as unmapped, and -Action Report tells you which.

    LIVENESS IS NEVER STORED. A record holds a Project slug and nothing else, so archiving a Project
    cannot leave a stale copy of its state behind: every read joins the slug against the active and
    archived Project Catalogs and reports `active`, `archived`, `unlisted`, or `undetermined`. That
    join is the only part of this helper that reaches the shared collection, and -Offline skips it,
    reporting every liveness as `undetermined` rather than as anything more confident.

    EVICTION IS OFFERED AND NEVER PERFORMED. A batch whose owning Project is archived is named as a
    candidate, with the evidence. Nothing here deletes, moves, or modifies anything under raw/ --
    that is the reader's to do, because raw/ is their own source material and the deletion is
    irreversible.

.EXAMPLE
    tools/Set-RawBatchOwner.ps1 -Action Report
    Every top-level batch, its declared owner, and whether that Project is still live.

.EXAMPLE
    tools/Set-RawBatchOwner.ps1 -Action Report -Offline
    The same, with the shared collection left alone; every liveness reads `undetermined`.

.EXAMPLE
    tools/Set-RawBatchOwner.ps1 -Action Set -Batch 'buzz-main' -Project buzz-relay-deployment
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Report', 'List', 'Set', 'Remove', 'Validate')]
    [string]$Action,

    # A source batch under raw/, named the way tools/Search-RawBatch.ps1 -List reports it. Stored
    # under the canonical path Resolve-RawBatch returns, not under the spelling given here.
    [string]$Batch,

    # The owning Project's slug. Checked for shape only -- whether the Project exists is liveness,
    # and liveness is derived at read time by design.
    [string]$Project,

    # ISO date, yyyy-MM-dd. Defaults to today.
    [string]$Date,

    # One line on why, for a reader who finds this record months later.
    [string]$Note,

    # Skip the Project Catalog read. Every liveness then reads `undetermined`, and the eviction
    # offer says it could not be determined rather than saying there is nothing to evict.
    [switch]$Offline,

    [string]$McpUrl,
    [string]$ProjectId,
    [string]$WorkspacePath,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'BookWriteGuard.ps1')
. (Join-Path $PSScriptRoot 'RawBatchOwnership.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) {
    Write-LibraryFailure "No such workspace: $WorkspacePath"
}
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

# One writer at a time. The lock is taken on the RECORD SET rather than on any batch, because the
# file is shared by every batch and a per-batch lock would let two declarations interleave a
# read-modify-write and lose one. Reads do not need it.
$lock = $null
try {
    switch ($Action) {
        'Validate' {
            $records = @((Read-RawOwnerFile -Workspace $workspace).records)
            $problems = @(Test-RawOwnerRecords -Records $records)
            if ($problems.Count) {
                throw "$($script:RawOwnerRelativePath) has $($problems.Count) problem(s):$([Environment]::NewLine)  - $(@($problems) -join "$([Environment]::NewLine)  - ")"
            }
            $result = [pscustomobject]@{
                operation = 'ValidateRawBatchOwners'
                path      = $script:RawOwnerRelativePath
                count     = $records.Count
                valid     = $true
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        'List' {
            $records = @((Read-RawOwnerFile -Workspace $workspace).records)
            $result = [pscustomobject]@{
                operation = 'ListRawBatchOwners'
                path      = $script:RawOwnerRelativePath
                count     = $records.Count
                records   = $records
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        'Report' {
            # $null, not an empty catalog set: the join reports `undetermined` for a missing set, and
            # -Offline must produce the same honest answer an unreachable NAS does rather than a
            # quieter one.
            $catalogs = $null
            if (-not $Offline) {
                $catalogs = Get-RawOwnerCatalogSet -McpUrl $McpUrl -ProjectId $ProjectId
            }
            $report = Get-RawBatchOwnershipReport -Workspace $workspace -Catalogs $catalogs
            $rendered = Format-RawBatchOwnershipReport $report
            if (-not $Json) { Write-Output $rendered; return }
            $report | Add-Member -NotePropertyName 'rendered' -NotePropertyValue $rendered -Force
            Write-LibraryResult -Result $report -Json
            return
        }

        'Set' {
            if ([string]::IsNullOrWhiteSpace($Batch)) { throw 'Declaring an owner needs -Batch. Run tools/Search-RawBatch.ps1 -List to see the source batches you can name.' }
            if ([string]::IsNullOrWhiteSpace($Project)) { throw 'Declaring an owner needs -Project, the owning Project slug.' }
            $lock = Enter-BookLock -Workspace $workspace -BookRoot 'internal/raw-batch-owners'
            $written = Set-RawOwnerMapping -Workspace $workspace -Batch $Batch -Project $Project -Date $Date -Note $Note
            $result = [pscustomobject]@{
                operation = 'SetRawBatchOwner'
                path      = $script:RawOwnerRelativePath
                batch     = $written.batch
                project   = $written.project
                date      = $written.date
                note      = $written.note
                replaced  = $written.replaced
                count     = $written.count
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }

        'Remove' {
            if ([string]::IsNullOrWhiteSpace($Batch)) { throw 'Withdrawing an owner needs -Batch.' }
            $lock = Enter-BookLock -Workspace $workspace -BookRoot 'internal/raw-batch-owners'
            $removed = Remove-RawOwnerMapping -Workspace $workspace -Batch $Batch
            $result = [pscustomobject]@{
                operation = 'RemoveRawBatchOwner'
                path      = $script:RawOwnerRelativePath
                batch     = $removed.batch
                count     = $removed.count
            }
            Write-LibraryResult -Result $result -Json:$Json
            return
        }
    }
}
catch {
    Write-LibraryFailure $_.Exception.Message
}
finally {
    if ($lock) { Exit-BookLock -Lock $lock }
}
