<#
.SYNOPSIS
    Destroy one quarantine directory for good, and take the ownership rows of the material it held
    with it.

.DESCRIPTION
    THE OPERATION THE RESET HAS BEEN PROMISING. `Reset-LocalNotebook.ps1` reports that purging the
    quarantine is "a separate approved operation"; until 2026-09-10 it was a sentence rather than a
    route, so quarantined material accumulated forever and the only way to clear it was a file
    manager, which does exactly the wrong half.

    WHY A PURGE IS NOT TIDYING. A reset LEAVES each quarantined topic's ownership row citing the seat
    that owned it -- deliberately, because the row is what a restore reads to find out whose material
    it is. So a purge that only deleted files would leave the record naming material that exists
    nowhere: a row no reset can ever clear (reset acts on directories, and there is no longer a
    directory), and a permanent blocker on that seat's slug, since `Get-SeatSlugReuseBlockers`
    refuses a name whose rows name an incarnation nothing can account for. The row is part of what is
    being destroyed, so it goes in the same approved operation.

    ROWS FIRST, THEN THE MATERIAL, and the order is the recovery argument. A run that removed the
    rows and then failed leaves material with no rows, which `-Adopt` on the restore can still bring
    back. A run that deleted the material and then failed leaves rows citing nothing, which is the
    exact defect this helper exists not to ship.

    WHAT IT REFUSES. Material owned by an incarnation that is still REGISTERED and is not this seat's
    -- that seat has not finished with it, and a purge here would destroy another seat's work on this
    seat's approval. Work at that seat, or reassign the topic first. A row it cannot remove is not a
    refusal: a `shared` or `excluded` declaration is about a NAME rather than about material, and a
    topic that exists in `notebook/` again has a row describing the LIVE copy, which must survive.

    GATED. Preflight, one approval, an exact `plan_id` binding the quarantine, every topic with the
    row that would go, and the loose files. A preflight with anything to refuse issues no `plan_id`.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,
    [string]$Seat,
    # The stamped directory name under internal/notebook-reset-quarantine/, never a path.
    [Parameter(Mandatory = $true)]
    [string]$Quarantine,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'NotebookIndex.ps1')
. (Join-Path $PSScriptRoot 'BookRootSchema.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'

$seatState = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($seatState.status -cne 'named') { throw $seatState.message }
$Seat = $seatState.seat

$inventory = @(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine)
if (-not $inventory.Count) {
    $known = @(@(Get-NotebookQuarantineInventory -Workspace $workspace) | ForEach-Object { [string]$_.name })
    $because = if ($known.Count) { "There are: $($known -join ', ')." } else { 'This workspace holds no quarantined material at all.' }
    throw ("Purge aborted: internal/notebook-reset-quarantine/$Quarantine does not exist. $because " +
           'Run tools/Restore-NotebookQuarantine.ps1 -List to see what each one holds.')
}
$quarantineRow = $inventory[0]

# --- WHAT HAPPENS TO EACH TOPIC'S ROW -------------------------------------------------------------
#
# Under the registry lock, because every disposition here is decided by comparing an ownership row's
# (seat, incarnation) against the registry and the retirement records -- and a seat created or
# retired mid-scan changes the answer.
function Get-PurgeDispositions {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Topics
    )
    $stateDirectory = Join-Path $Workspace '.claude'
    $registry = Read-SeatRegistry -StateDirectory $stateDirectory
    $actingIncarnation = Get-SeatEntryIncarnation -Entry (Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $ActingSeat)
    $retirements = @((Read-SeatRetirementRecords -Workspace $Workspace).records)
    $owners = Read-NotebookTopicOwners -Workspace $Workspace

    $rows = [Collections.Generic.List[object]]::new()
    foreach ($name in @($Topics)) {
        $entry = Get-NotebookTopicOwner -Owners $owners -Topic $name
        $scope = ''
        $seat = ''
        $incarnation = ''
        if ($null -ne $entry) {
            $fields = @($entry.PSObject.Properties | ForEach-Object { $_.Name })
            $scope = [string]$entry.scope
            if ($scope -ceq 'owned') {
                $seat = [string]$entry.seat
                if ($fields -ccontains 'seat_id') { $incarnation = [string]$entry.seat_id }
            }
        }
        $liveTopic = Test-Path -LiteralPath (Join-Path (Join-Path $Workspace 'notebook') $name) -PathType Container

        $action = ''
        $reason = ''
        $status = ''
        if ($null -eq $entry) {
            $action = 'no-row'
            $reason = 'no ownership row names it, so there is nothing to remove'
        }
        elseif ($scope -cne 'owned') {
            $action = 'keep-row'
            $reason = "the record declares that name '$scope', which is a declaration about the name rather than a record of this material"
        }
        elseif ($liveTopic) {
            $action = 'keep-row'
            $reason = 'a topic of that name exists in notebook/ again, so the row describes the live copy and must survive this purge'
        }
        else {
            $status = Get-SeatIncarnationStatus -Registry $registry -Retirements $retirements -Seat $seat -SeatId $incarnation
            $which = if ([string]::IsNullOrWhiteSpace($incarnation)) { 'the pre-identity incarnation' } else { "incarnation $incarnation" }
            if ($seat -ceq $ActingSeat -and $incarnation -ceq $actingIncarnation) {
                $action = 'remove-row'
                $reason = 'this seat''s own material'
            }
            elseif ($status -ceq 'live') {
                $action = 'blocked'
                $reason = ("notebook/$name is owned by seat '$seat' ($which), which is still registered, so that seat has not " +
                           "finished with it. Purge from that seat, or reassign the topic first with " +
                           "tools/Set-NotebookTopicOwner.ps1 -Topic $name -Seat $ActingSeat")
            }
            else {
                $action = 'remove-row'
                $reason = "owned by seat '$seat' ($which), which is $status"
            }
        }
        [void]$rows.Add([pscustomobject]@{
            topic = $name; action = $action; reason = $reason
            seat = $seat; seat_id = $incarnation; scope = $scope; status = $status
        })
    }
    [pscustomobject]@{ seat_id = $actingIncarnation; rows = @($rows) }
}

function Get-PurgeSelection {
    param([Parameter(Mandatory = $true)][string]$Workspace, [Parameter(Mandatory = $true)][string]$ActingSeat,
          [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Topics)
    $registryLock = Enter-SeatRegistryLock -Workspace $Workspace
    try { Get-PurgeDispositions -Workspace $Workspace -ActingSeat $ActingSeat -Topics $Topics }
    finally { Exit-BookLock -Lock $registryLock }
}

function Get-PurgePlanId {
    param(
        [Parameter(Mandatory = $true)][string]$ActingSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ActingSeatId,
        [Parameter(Mandatory = $true)][string]$QuarantineName,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Rows,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$LooseFiles
    )
    $lines = @(
        'action=remove-notebook-quarantine',
        "seat=$ActingSeat",
        "seat_id=$ActingSeatId",
        "quarantine=$QuarantineName"
    ) +
        @(@($Rows | ForEach-Object { "topic=$($_.topic):$($_.seat):$($_.seat_id):$($_.action)" }) | Sort-Object -CaseSensitive) +
        @(@($LooseFiles | Sort-Object -CaseSensitive) | ForEach-Object { "loose=$_" })
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hex = -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
    "remove-notebook-quarantine-$hex"
}

$topics = @($quarantineRow.topics)
$selection = Get-PurgeSelection -Workspace $workspace -ActingSeat $Seat -Topics $topics
$rows = @($selection.rows)
$blocked = @(@($rows) | Where-Object { [string]$_.action -ceq 'blocked' })

$refusals = [Collections.Generic.List[string]]::new()
foreach ($row in $blocked) { [void]$refusals.Add("$($row.topic): $($row.reason).") }

$planId = ''
if (-not $refusals.Count) {
    $planId = Get-PurgePlanId -ActingSeat $Seat -ActingSeatId ([string]$selection.seat_id) -QuarantineName $Quarantine `
        -Rows @($rows) -LooseFiles @($quarantineRow.loose_files)
}

$result = [ordered]@{
    operation             = 'Purge quarantined Notebook material'
    workspace             = $workspace
    seat                  = $Seat
    seat_id               = [string]$selection.seat_id
    quarantine            = [string]$quarantineRow.name
    quarantine_directory  = [string]$quarantineRow.directory
    quarantined_by_seat   = [string]$quarantineRow.seat
    quarantined_utc       = [string]$quarantineRow.quarantined_utc
    journal_status        = [string]$quarantineRow.journal_status
    # THE WORD THE READER IS APPROVING. Everything else in this Library that removes material moves
    # it somewhere; this one does not, and saying so plainly is the difference between an approval
    # and a misunderstanding.
    recoverable           = $false
    destroys              = ("Every file under $([string]$quarantineRow.directory) is deleted permanently. Nothing stages it, " +
                             'nothing journals it, and no Git command restores it -- internal/ is not tracked. Restore what you ' +
                             'want to keep with tools/Restore-NotebookQuarantine.ps1 FIRST.')
    topics_to_destroy     = @($topics)
    ownership_rows_to_remove = @(@($rows | Where-Object { [string]$_.action -ceq 'remove-row' }) | ForEach-Object { "$($_.topic) (seat $($_.seat), $($_.reason))" })
    ownership_rows_kept   = @(@($rows | Where-Object { [string]$_.action -cin @('keep-row', 'no-row') }) | ForEach-Object { "$($_.topic): $($_.reason)" })
    loose_files_to_destroy = @($quarantineRow.loose_files)
    refusals              = @($refusals)
    plan_id               = $planId
    confirmation_required = (-not $refusals.Count)
    shared_library_write  = $false
}

# The claim before the plan, as the reset does: this changes the ownership record, which is what a
# reset judges, so a claimless session is certain to be refused and must not be handed a plan first.
Assert-SeatClaimHeld -StateDirectory $stateDirectory -Seat $Seat | Out-Null
if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json; return }
if (-not $UserConfirmed) { throw 'Purge aborted: run with -Preflight, show the reader what it reports, and rerun with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.' }

# --- THE APPLY ------------------------------------------------------------------------------------
#
# Registry lock, then each topic's lock in sorted order. The rows go first and the directory second,
# so a failure between them leaves material that a restore can still adopt rather than rows citing
# material that no longer exists.
$topicLocks = [Collections.Generic.List[object]]::new()
$applyRegistryLock = Enter-SeatRegistryLock -Workspace $workspace
try {
    $current = Get-PurgeDispositions -Workspace $workspace -ActingSeat $Seat -Topics $topics
    $currentRows = @($current.rows)
    $currentBlocked = @(@($currentRows) | Where-Object { [string]$_.action -ceq 'blocked' })
    $currentLoose = @((@(Get-NotebookQuarantineInventory -Workspace $workspace -Name $Quarantine))[0].loose_files)
    $currentPlanId = Get-PurgePlanId -ActingSeat $Seat -ActingSeatId ([string]$current.seat_id) -QuarantineName $Quarantine `
        -Rows @($currentRows) -LooseFiles @($currentLoose)
    if ($currentPlanId -cne $ApprovedPlanId) {
        $because = if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { 'no plan_id was passed' }
                   else { 'the seat, the quarantine, the topics it holds, their owners, or the loose files are not what that plan described' }
        throw ("Purge aborted and nothing was destroyed: $because. Rerun the current preflight and pass its exact plan_id " +
               'as -ApprovedPlanId.')
    }
    if (@($currentBlocked).Count) {
        throw ('Purge aborted and nothing was destroyed: ' + (@($currentBlocked | ForEach-Object { "$($_.topic): $($_.reason)" }) -join '; '))
    }

    $removing = @(@($currentRows) | Where-Object { [string]$_.action -ceq 'remove-row' })
    foreach ($name in @(@($removing | ForEach-Object { [string]$_.topic }) | Sort-Object -CaseSensitive)) {
        [void]$topicLocks.Add((Enter-BookLock -Workspace $workspace -BookRoot "notebook/$name"))
    }
    $removed = @()
    foreach ($row in $removing) {
        $removed += Remove-NotebookTopicOwner -Workspace $workspace -Topic ([string]$row.topic) `
            -ExpectedSeat ([string]$row.seat) -ExpectedSeatId ([string]$row.seat_id)
    }

    # AND ONLY NOW THE MATERIAL. One Remove-Item over the stamped directory, which is the whole
    # quarantine including both journals: the journals describe material that will not exist, and
    # leaving them would leave a directory that reads as recoverable and is not.
    Remove-Item -LiteralPath ([string]$quarantineRow.directory) -Recurse -Force
}
finally {
    foreach ($lock in $topicLocks) { Exit-BookLock -Lock $lock }
    Exit-BookLock -Lock $applyRegistryLock
}

$result.status = 'completed'
$result.ownership_rows_removed = @($removed | Where-Object { $_.removed } | ForEach-Object { "$($_.topic) (seat $($_.seat))" })
# A row the removal refused is named rather than silently dropped from the count: the reader approved
# a set, and this is how they learn the set was not what ran.
$result.ownership_rows_left = @($removed | Where-Object { -not $_.removed } | ForEach-Object { "$($_.topic): $($_.reason)" })
# Read back rather than asserted: the point of this operation is that the directory is gone.
$result.quarantine_directory_exists = (Test-Path -LiteralPath ([string]$quarantineRow.directory))
$result.quarantines_remaining = @(@(Get-NotebookQuarantineInventory -Workspace $workspace) | ForEach-Object { [string]$_.name })
$result.basic_memory_write = $false
Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
