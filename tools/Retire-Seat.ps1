<#
.SYNOPSIS
    Retire a seat recoverably: archive its Desk and metadata, then remove it from the registry.

.DESCRIPTION
    "Name the seat and delete its work" is not an acceptable escape hatch. Under ADR-0010 the Desk
    is the ONLY durable record of what a reader had open -- not git, not the Notebook, not the shared
    collection -- so retiring a seat archives that record rather than discarding it.

    GATED. Preflight, an exact `plan_id`, and one approval, like every other consequential helper
    here. The `plan_id` binds the seat's Desk contents and its registry entry, so a seat whose Desk
    changed between preflight and approval invalidates it.

    A CLAIMED SEAT IS REFUSED, AND SO IS A SEAT THAT IS NOT THIS ONE'S TO RETIRE. Retirement is what
    makes a seat's material eligible for a whole-tree reset (ADR-0016), so retiring a seat somebody
    is actively working would hand their Notebook topics to the next reset. The claim probe never
    waits -- it is checked while the registry lock is held, and waiting there is the deadlock step 9c
    exists to prevent.

    WHAT SURVIVES. `internal/seat-archive/<seat>-<timestamp>/` holds both Desk files verbatim and a
    `seat.json` recording the binding and when it was retired. Nothing is deleted until those are on
    disk and read back.

    AND THAT RECORD IS NOW WHAT "RETIRED" MEANS (2026-09-10). Until this change nothing read the
    archive: a seat counted as retired because its directory was absent from `.claude/seats/`,
    which a hand deletion produces just as well as a retirement does -- and that directory is
    gitignored, so no commit restores it. `seat.json` therefore carries the incarnation's
    `seat_id`, and `Get-SeatIncarnationStatus` answers `retired` only for a (slug, incarnation) this
    helper actually archived. Two consequences follow. A deleted directory is no longer retirement,
    so its topics stay out of every other seat's reset. And a slug may now be REUSED after a real
    retirement, because the new seat's incarnation differs from the one the archive names.

    A SEAT WHOSE DESK IS GONE IS STILL RETIREABLE, which is what makes that refusal actionable. The
    Desk files are archived if present and skipped if not, the record is written either way, and the
    registry entry is what actually goes -- so "retire it" is a route the reader can take rather
    than advice that runs into a missing file.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Seat,
    [string]$WorkspacePath,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'

$resolved = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($resolved.status -cne 'named') { throw $resolved.message }
$seatName = $resolved.seat

function Get-DeskBytes([string]$Path) {
    # RETURNED BEHIND A COMMA, because a function's output travels the pipeline and the pipeline
    # unrolls a collection: an EMPTY Desk file's byte[0] came back as $null, and the read-back
    # comparison below then died inside [Convert]::ToBase64String with 'Value cannot be null'
    # instead of reporting on the archive it had just written. A Desk file is created empty, so
    # that was every seat retired before anything had been opened at it. Same family and same run
    # as Get-DeskMigrationPlan's, 2026-09-09; seat.lifecycle retires an empty-Desk seat to hold it.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $bytes = [IO.File]::ReadAllBytes($Path)
    , $bytes
}

$lock = Enter-SeatRegistryLock -Workspace $workspace
try {
    $registry = Read-SeatRegistry -StateDirectory $stateDirectory
    $entry = Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $seatName

    # CHECKED BEFORE A plan_id IS ISSUED, not after. An approval for an operation already certain to
    # fail is worse than no approval -- the same rule Archive-ShelfBook applies to a destination
    # collision.
    #
    # THE DECISION COMES FROM THE MATRIX, NOT FROM A BOOLEAN (ADR-0018). Retirement is the `retire`
    # row: it acts ON a seat and is authorised by that seat being idle, which is a different question
    # from the `mutate` row's "does this session hold the seat it is acting from". An `orphaned` seat
    # -- agent alive, claim holder gone -- used to read as unclaimed here, so retirement would have
    # made a live agent's material whole-tree eligible underneath it.
    $claimState = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $seatName
    if ((Get-SeatStateDecision -Operation 'retire' -State ([string]$claimState.state)) -cne 'allow') {
        $because = if ([string]$claimState.state -ceq 'orphaned') {
            "is bound to agent process $([int]$claimState.agent_pid), which is still running even though its claim holder is gone"
        }
        else { 'has a live session' }
        throw ("Seat '$seatName' $because, and cannot be retired. Retirement makes a seat's material " +
               'eligible for a whole-tree reset, so retiring an active seat would hand its work to the next one. ' +
               'Wait for that agent to end, then retire it.')
    }

    $booksPath = Get-DeskFilePath -StateDirectory $stateDirectory -Seat $seatName -Kind 'books'
    $projectsPath = Get-DeskFilePath -StateDirectory $stateDirectory -Seat $seatName -Kind 'projects'
    # PLAIN STRINGS, NOT WHAT Get-Content HANDS BACK. Every line Get-Content emits is decorated with
    # PSPath, PSParentPath, PSChildName, PSDrive, PSProvider and ReadCount note properties, and
    # PSProvider reaches the whole provider graph -- including `Drives`, which on this machine lists
    # the NAS. So `ConvertTo-Json -Depth 12` inside Write-LibraryResult walked that graph instead of
    # writing a plan, and `-Preflight -Json` NEVER RETURNED. Even where it does return, the shape is
    # wrong: `open_books` comes out as an array of objects rather than of strings.
    #
    # THE CAST IS GONE BECAUSE THE TRAP IS (2026-09-18): Read-DeskFileLines decodes bytes and splits a
    # string, so there is nothing to decorate. RAW LINES, not entries -- this fingerprint is of what
    # is literally in the file, and dropping a `#` line here would make the plan_id disagree with
    # itself the first time someone commented a Desk.
    #
    # WHY IT SURVIVED. This plan body had never once run. It is unobservable against a claimed seat
    # by design, and the route the playbook documents omits -Json -- so Write-LibraryResult handed
    # back the live object and formatted it, where no serialisation happens. An empty Desk hides it
    # too, because there are no lines to serialise. Found 2026-09-09 by seat.lifecycle's case 8, the
    # first run this code has ever had.
    $bookLines = @(Read-DeskFileLines -Path $booksPath | Where-Object { $_.Trim() })
    $projectLines = @(Read-DeskFileLines -Path $projectsPath | Where-Object { $_.Trim() })

    $fingerprint = [Security.Cryptography.SHA256]::Create()
    try {
        $material = "$seatName|$([string]$entry.project)|$(($bookLines -join ';'))|$(($projectLines -join ';'))"
        $planId = (-join ($fingerprint.ComputeHash([Text.Encoding]::UTF8.GetBytes($material)) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
    }
    finally { $fingerprint.Dispose() }

    # WHAT WILL TRAVEL BESIDE THE DESK, read now rather than named as a fixed list: three of the five
    # are absent at most seats, and a plan that promised to archive a record the seat does not have
    # would be describing more than the operation performs.
    #
    # DELIBERATELY NOT IN THE plan_id's MATERIAL. The digest binds the approval to the DESK the
    # reader was shown, and a conversation recorded between the preflight and the confirmed run is
    # not a change to what they approved -- it is the record doing its job. Making it invalidate an
    # approval would refuse retirements for a reason the reader cannot act on.
    $recordsPresent = @(@(
        @{ kind = 'conversations'; path = (Get-SeatConversationsPath -StateDirectory $stateDirectory -Seat $seatName) },
        @{ kind = 'binding'; path = (Get-SeatBindingPath -StateDirectory $stateDirectory -Seat $seatName) },
        @{ kind = 'holder-attempt'; path = (Get-SeatHolderAttemptPath -StateDirectory $stateDirectory -Seat $seatName) }
    ) | Where-Object { Test-Path -LiteralPath ([string]$_.path) -PathType Leaf } | ForEach-Object { [string]$_.kind })

    # THE INCARNATION BEING RETIRED, read from the registry entry rather than from the binding. The
    # binding is the LIVE agent's record and a retireable seat has no live agent; the registry entry
    # is the durable one, and it is what Get-SeatIncarnationStatus compares the archive against. A
    # seat created before ADR-0018 carries none, and '' is a real incarnation there rather than a
    # gap -- it is the only value that a pre-identity ownership row matches.
    $seatIncarnation = Get-SeatEntryIncarnation -Entry $entry

    $plan = [pscustomobject]@{
        operation            = 'Retire a Library seat'
        seat                 = $seatName
        seat_id              = $seatIncarnation
        project              = [string]$entry.project
        plan_id              = $planId
        open_books           = $bookLines
        open_projects        = $projectLines
        records_to_archive   = $recordsPresent
        archive_destination  = (Join-Path (Get-SeatArchiveDirectory -Workspace $workspace) "$seatName-<timestamp>")
        recoverable          = $true
        note                 = 'The Desk is the only durable record of what was open, so it is archived rather than discarded. The archive record is also what MAKES this seat retired: it is what lets a whole-tree reset reach this incarnation''s Notebook topics, and what lets the name be used again by a new seat that will not inherit them.'
        shared_library_write = $false
    }

    if ($Preflight) { Write-LibraryResult -Result $plan -Json:$Json; return }
    if (-not $UserConfirmed) { throw 'The seat was not retired: run with -Preflight, show the reader what it reports, and rerun with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.' }
    if ($ApprovedPlanId -cne $planId) { throw 'The seat was not retired: rerun the current preflight and pass its exact plan_id as ApprovedPlanId. A different plan_id means the seat''s Desk changed since you approved it.' }

    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $archiveDirectory = Join-Path (Get-SeatArchiveDirectory -Workspace $workspace) "$seatName-$stamp"
    New-Item -ItemType Directory -Path $archiveDirectory -Force | Out-Null

    # ARCHIVE FIRST, VERIFY, AND ONLY THEN REMOVE. Both Desk files travel together, for the same
    # reason the migration refuses to move one without the other.
    #
    # AND THE SEAT'S OWN RECORDS TRAVEL WITH THEM (plan step 8). `conversations.json` is the durable
    # history of which conversations sat here and it is the ONLY copy -- removing the seat directory
    # below deletes it, so a retirement that archived the Desk alone would discard exactly the record
    # that makes a hibernated conversation findable, and discard it silently. `binding.json` and the
    # holder attempt go for the same reason they are refused a live seat: they say who was last here
    # and how the claim ended, which is what a recovery reads. Each is absent at most seats and an
    # absent file is skipped, not an error.
    $archived = @()
    foreach ($pair in @(
        @{ kind = 'books'; path = $booksPath },
        @{ kind = 'projects'; path = $projectsPath },
        @{ kind = 'conversations'; path = (Get-SeatConversationsPath -StateDirectory $stateDirectory -Seat $seatName) },
        @{ kind = 'binding'; path = (Get-SeatBindingPath -StateDirectory $stateDirectory -Seat $seatName) },
        @{ kind = 'holder-attempt'; path = (Get-SeatHolderAttemptPath -StateDirectory $stateDirectory -Seat $seatName) })) {
        $source = [string]$pair.path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $archiveDirectory (Split-Path -Leaf $source)
        Write-AtomicText -Path $destination -Text ([Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $source))) | Out-Null
        $sourceBytes = Get-DeskBytes $source
        $destinationBytes = Get-DeskBytes $destination
        if ([Convert]::ToBase64String($sourceBytes) -cne [Convert]::ToBase64String($destinationBytes)) {
            throw "The seat was NOT retired: $destination did not read back identical to $source. Nothing has been removed."
        }
        $archived += $pair.kind
    }
    # THIS FILE IS THE RETIREMENT, not a receipt for it. Read-SeatRetirementRecords requires a
    # parsable seat.json naming a seat before it will call any incarnation retired, so an archive
    # written without one licenses nothing -- which is the fail-closed direction and is why the
    # record goes in beside the Desk files rather than being inferred from the directory name.
    Write-AtomicText -Path (Join-Path $archiveDirectory 'seat.json') -Text ((([pscustomobject]@{
        seat = $seatName
        seat_id = $seatIncarnation
        project = [string]$entry.project
        retired_utc = [DateTime]::UtcNow.ToString('o')
        open_books = $bookLines
        open_projects = $projectLines
    }) | ConvertTo-Json -Depth 5) + "`n") | Out-Null

    $entries = @(@($registry.seats) | Where-Object { [string]$_.seat -cne $seatName })
    Write-SeatRegistry -StateDirectory $stateDirectory -Registry ([pscustomobject]@{ schema = 1; seats = $entries })

    $deskDirectory = Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName
    if (Test-Path -LiteralPath $deskDirectory -PathType Container) { Remove-Item -LiteralPath $deskDirectory -Recurse -Force }

    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation            = 'Retire a Library seat'
        seat                 = $seatName
        seat_id              = $seatIncarnation
        project              = [string]$entry.project
        archived             = $archived
        archive_directory    = $archiveDirectory
        seats_remaining      = @($entries | ForEach-Object { [string]$_.seat })
        shared_library_write = $false
    })
}
finally { Exit-BookLock -Lock $lock }
