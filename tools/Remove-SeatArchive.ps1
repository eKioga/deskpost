<#
.SYNOPSIS
    Destroy one retired seat's archive for good -- and refuse when doing so would leave Notebook
    material nothing can account for.

.DESCRIPTION
    WHY THIS IS NOT TIDYING, WHICH IS THE WHOLE POINT OF THE HELPER. Until 2026-09-10 an archive
    under `internal/seat-archive/` was a keepsake: a copy of a retired seat's Desk that nothing read.
    Since retirement gained an identity it is the RETIREMENT ITSELF. `seat.json` naming a (slug,
    incarnation) plus no registry entry naming it is what `Get-SeatIncarnationStatus` answers
    `retired` from, and three things rest on that answer:

        - a whole-tree reset may move that incarnation's Notebook topics;
        - the slug may be used again by a new seat;
        - the Desk overview and the gate call the workspace consistent.

    So deleting an archive UN-RETIRES the incarnation it recorded. Its topics become `unaccounted`,
    every whole-tree reset refuses them by name, and the slug stops being reusable -- permanently,
    because retirement acts on a registry entry and there is no longer one to retire. That state
    cannot be repaired by retiring the seat again; it can only be prevented here, at the delete.

    SO THE GUARD IS MEASURED, NOT ASSUMED. The status of every owned ownership row is computed twice
    -- once as the workspace stands, and once against the retirement records that would REMAIN --
    and a row that changes to `unaccounted` refuses the purge, named, with the routes that clear it.
    Computing it against what would remain rather than against this archive's own seat name is what
    makes a duplicate record (two archives naming one incarnation) behave correctly instead of
    blocking on a copy.

    WHAT IS LOST WHEN IT IS ALLOWED. The Desk is the only durable record of what that seat had open
    (ADR-0010), `conversations.json` is the only record of which conversations sat there, and
    `binding.json` says how the last one ended. None of it is in Git -- `internal/` is not tracked.
    The preflight names all of it, because that is what the reader is approving.

    GATED. Preflight, one approval, an exact `plan_id` binding the archive and the files it holds. A
    preflight with anything to refuse issues no `plan_id`.

    NO CLAIM IS REQUIRED, and the reason is the same one that exempts `Retire-Seat.ps1`: this writes
    neither `notebook/` nor a Desk, so no reset ever misjudges its output. What it can do is make a
    reset refuse MORE, and the guard above is what stops it doing even that.
#>
[CmdletBinding()]
param(
    [string]$WorkspacePath,
    # The stamped directory name under internal/seat-archive/, never a path.
    [string]$Archive,
    [switch]$List,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
$archiveRoot = Get-SeatArchiveDirectory -Workspace $workspace

function Get-ArchiveContents {
    <# What one archive directory holds, as plain strings. Never throws for a damaged archive. #>
    param([Parameter(Mandatory = $true)][string]$Directory)
    $files = @(@(Get-ChildItem -LiteralPath $Directory -File -Force -ErrorAction SilentlyContinue) |
        ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
    $seat = ''
    $seatId = ''
    $project = ''
    $retired = ''
    $books = @()
    $projects = @()
    $status = 'no-record'
    $recordPath = Join-Path $Directory 'seat.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        try {
            $parsed = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $recordPath)) | ConvertFrom-Json
            $fields = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
            if ($fields -ccontains 'seat') { $seat = [string]$parsed.seat }
            if ($fields -ccontains 'seat_id') { $seatId = [string]$parsed.seat_id }
            if ($fields -ccontains 'project') { $project = [string]$parsed.project }
            if ($fields -ccontains 'retired_utc') { $retired = [string]$parsed.retired_utc }
            # PLAIN STRINGS, and that matters here: Retire-Seat.ps1 paid a session for handing
            # Get-Content's decorated lines to ConvertTo-Json, which walked the provider graph
            # instead of writing a plan.
            if ($fields -ccontains 'open_books') { $books = @(@($parsed.open_books) | ForEach-Object { [string]$_ }) }
            if ($fields -ccontains 'open_projects') { $projects = @(@($parsed.open_projects) | ForEach-Object { [string]$_ }) }
            $status = if ([string]::IsNullOrWhiteSpace($seat)) { 'nameless' } else { 'read' }
        }
        catch { $status = 'unreadable' }
    }
    [pscustomobject]@{
        seat = $seat; seat_id = $seatId; project = $project; retired_utc = $retired
        open_books = $books; open_projects = $projects; files = $files; record_status = $status
    }
}

if ($List) {
    $rows = @()
    if (Test-Path -LiteralPath $archiveRoot -PathType Container) {
        $rows = @(@(Get-ChildItem -LiteralPath $archiveRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object -Property Name) |
            ForEach-Object {
                $contents = Get-ArchiveContents -Directory $_.FullName
                [pscustomobject]@{
                    name = $_.Name; seat = [string]$contents.seat; seat_id = [string]$contents.seat_id
                    project = [string]$contents.project; retired_utc = [string]$contents.retired_utc
                    record = [string]$contents.record_status; files = @($contents.files)
                }
            })
    }
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation            = 'List retired seat archives'
        workspace            = $workspace
        archive_root         = $archiveRoot
        archives             = @($rows)
        shared_library_write = $false
    })
    return
}

if ([string]::IsNullOrWhiteSpace($Archive)) {
    throw ('Purge aborted: name the archive with -Archive <name>. Run this helper with -List to see what is there. ' +
           'An archive is a retirement record, not a keepsake: deleting one un-retires the incarnation it names.')
}
$archiveDirectory = Join-Path $archiveRoot $Archive
if (-not (Test-Path -LiteralPath $archiveDirectory -PathType Container)) {
    throw "Purge aborted: internal/seat-archive/$Archive does not exist. Run this helper with -List to see what is there."
}
$contents = Get-ArchiveContents -Directory $archiveDirectory

function Get-ArchivePlanId {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ArchivedSeat,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ArchivedSeatId,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Files
    )
    $lines = @('action=remove-seat-archive', "archive=$Name", "seat=$ArchivedSeat", "seat_id=$ArchivedSeatId") +
        @(@($Files | Sort-Object -CaseSensitive) | ForEach-Object { "file=$_" })
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hex = -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
    "remove-seat-archive-$hex"
}

# --- WHAT THIS DELETION WOULD STRAND --------------------------------------------------------------
#
# THE COMPARISON IS AGAINST WHAT WOULD REMAIN, not against this archive's seat name. Two archives can
# name one incarnation -- a hand copy, a restored backup -- and in that case deleting one strands
# nothing, because the other still records the retirement. Deriving the answer from the remaining
# records rather than from "is this the seat" is what makes that case behave.
function Get-ArchiveStranding {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$ArchiveName
    )
    $registry = Read-SeatRegistry -StateDirectory (Join-Path $Workspace '.claude')
    $all = @((Read-SeatRetirementRecords -Workspace $Workspace).records)
    $remaining = @(@($all) | Where-Object { [string]$_.directory -cne $ArchiveName })
    $stranded = [Collections.Generic.List[object]]::new()
    foreach ($row in @(@((Read-NotebookTopicOwners -Workspace $Workspace).topics) | Where-Object { [string]$_.scope -ceq 'owned' })) {
        $fields = @($row.PSObject.Properties | ForEach-Object { $_.Name })
        $incarnation = if ($fields -ccontains 'seat_id') { [string]$row.seat_id } else { '' }
        $before = Get-SeatIncarnationStatus -Registry $registry -Retirements $all -Seat ([string]$row.seat) -SeatId $incarnation
        $after = Get-SeatIncarnationStatus -Registry $registry -Retirements $remaining -Seat ([string]$row.seat) -SeatId $incarnation
        if ($before -ceq 'unaccounted' -or $after -cne 'unaccounted') { continue }
        [void]$stranded.Add([pscustomobject]@{ topic = [string]$row.topic; seat = [string]$row.seat; seat_id = $incarnation; was = $before })
    }
    @($stranded)
}

$registryLock = Enter-SeatRegistryLock -Workspace $workspace
try { $stranded = @(Get-ArchiveStranding -Workspace $workspace -ArchiveName $Archive) }
finally { Exit-BookLock -Lock $registryLock }

$refusals = [Collections.Generic.List[string]]::new()
if (@($stranded).Count) {
    $detail = @($stranded | ForEach-Object {
        $which = if ([string]::IsNullOrWhiteSpace([string]$_.seat_id)) { 'the pre-identity incarnation' } else { "incarnation $([string]$_.seat_id)" }
        "notebook/$($_.topic) (seat $($_.seat), $which)"
    }) -join '; '
    [void]$refusals.Add("deleting this archive would un-retire the incarnation it records, and these ownership rows would then be " +
        "accounted for by nothing: $detail. No reset could ever reach that material again and the seat name could never be reused, " +
        'because retirement acts on a registry entry and there would no longer be one. Clear them first: take each topic over with ' +
        'tools/Set-NotebookTopicOwner.ps1 -Topic <topic> -Seat <a live seat>, declare it with -Scope shared if it is common ground, ' +
        'or destroy the material -- a whole-tree reset followed by tools/Remove-NotebookQuarantine.ps1, which removes the row with it.')
}

$planId = ''
if (-not $refusals.Count) {
    $planId = Get-ArchivePlanId -Name $Archive -ArchivedSeat ([string]$contents.seat) -ArchivedSeatId ([string]$contents.seat_id) -Files @($contents.files)
}

$result = [ordered]@{
    operation             = 'Purge a retired seat archive'
    workspace             = $workspace
    archive               = $Archive
    archive_directory     = $archiveDirectory
    seat                  = [string]$contents.seat
    seat_id               = [string]$contents.seat_id
    project               = [string]$contents.project
    retired_utc           = [string]$contents.retired_utc
    record_status         = [string]$contents.record_status
    recoverable           = $false
    destroys              = ('The retirement record, and with it the only durable copy of that seat''s Desk, its conversation ' +
                             'history and its binding. internal/ is not tracked, so no Git command brings any of it back.')
    open_books_archived   = @($contents.open_books)
    open_projects_archived = @($contents.open_projects)
    files_to_destroy      = @($contents.files)
    would_strand          = @($stranded | ForEach-Object { "notebook/$($_.topic) (seat $($_.seat))" })
    refusals              = @($refusals)
    plan_id               = $planId
    confirmation_required = (-not $refusals.Count)
    shared_library_write  = $false
}

if ($Preflight) { Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json; return }
if (-not $UserConfirmed) { throw 'The archive was not purged: run with -Preflight, show the reader what it reports, and rerun with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.' }

$applyLock = Enter-SeatRegistryLock -Workspace $workspace
try {
    # REVALIDATED UNDER THE LOCK. Between the preview and now, a topic can have been recorded to this
    # incarnation -- which is exactly the row this deletion would strand -- so the stranding question
    # is asked again rather than taken from the plan.
    $currentContents = Get-ArchiveContents -Directory $archiveDirectory
    $currentPlanId = Get-ArchivePlanId -Name $Archive -ArchivedSeat ([string]$currentContents.seat) `
        -ArchivedSeatId ([string]$currentContents.seat_id) -Files @($currentContents.files)
    if ($currentPlanId -cne $ApprovedPlanId) {
        $because = if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { 'no plan_id was passed' }
                   else { 'the archive no longer holds what that plan described' }
        throw ("The archive was NOT purged: $because. Rerun the current preflight and pass its exact plan_id as " +
               '-ApprovedPlanId.')
    }
    $currentStranded = @(Get-ArchiveStranding -Workspace $workspace -ArchiveName $Archive)
    if (@($currentStranded).Count) {
        throw ('The archive was NOT purged: deleting it would leave these ownership rows accounted for by nothing -- ' +
               (@($currentStranded | ForEach-Object { "notebook/$($_.topic) (seat $($_.seat))" }) -join '; ') +
               '. Clear them first; the preflight names the three routes.')
    }
    Remove-Item -LiteralPath $archiveDirectory -Recurse -Force
}
finally { Exit-BookLock -Lock $applyLock }

$result.status = 'completed'
# Read back rather than asserted: the point of this operation is that the directory is gone.
$result.archive_directory_exists = (Test-Path -LiteralPath $archiveDirectory)
$result.archives_remaining = @(if (Test-Path -LiteralPath $archiveRoot -PathType Container) {
    @(Get-ChildItem -LiteralPath $archiveRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
})
$result.basic_memory_write = $false
Write-LibraryResult -Result ([pscustomobject]$result) -Json:$Json
