<#
.SYNOPSIS
    The maintenance barrier: one marker under `internal/` that stops every claim-gated mutation and
    both seat entry routes for the length of a cutover. Dot-sourced; never invoked directly.

.DESCRIPTION
    WHY IT EXISTS. PLAN-public-release.md step 6 moves whole material directories, and round 2 of
    Codex review found the hole a hashed copy alone cannot close: a writer can change the source
    AFTER its copy was verified, finish, and leave no lock behind for the idleness check to see --
    so the destination silently lacks that completed work. Checking that nothing is running does not
    stop something from starting either. The barrier is the answer to both: it goes up BEFORE any
    inventory is taken and stays up through final verification and pointer cutover, so the window
    in which a write could land is closed rather than merely observed to be empty.

    WHAT IT IS. One file, `internal/maintenance-barrier.json`, created by exclusive create so two
    movers cannot both believe they hold it. It is DURABLE and deliberately outlives its process:
    a cutover interrupted by a crash must leave the Library stopped rather than half-moved and
    open for writing. That is why nothing here reads liveness off `engaged_by_pid` -- the pid is
    recorded for the reader, never consulted for a decision.

    WHAT IT IS NOT. It is not a lock and joins no lock order. Nothing waits on it; every consumer
    asks once and refuses. It gates MUTATION only: reading the Library, listing a Desk, and every
    reader tool are unaffected, exactly as the seat claim is.

    FAIL CLOSED ON A DAMAGED RECORD, which is the half that decides whether this is a barrier at
    all. A marker file that exists and cannot be parsed reads as ENGAGED, not as absent: the unsafe
    direction is the one where corruption re-opens the Library mid-cutover, and the cost of the safe
    direction is a refusal naming the file and how to clear it by hand.

    WHO ENGAGES IT. `tools/Move-LibraryFolder.ps1` and nothing else; `maintenance.barrier-coverage`
    in the gate asserts that, in both directions, so a second engager is a failed gate rather than a
    second authority over when the Library is stopped.

    WHO REFUSES ON IT. `Assert-SeatClaimHeld` in tools/LibrarySeat.ps1, which is the one choke point
    every claim-gated mutator already passes through -- so the set that refuses is DERIVED from
    `Get-ClaimGatedHelpers` rather than copied beside it -- plus both seat entry routes,
    `Start-LibrarySeat.ps1` and `Enter-LibrarySeat.ps1`, which are not claim-gated because they are
    what ACQUIRES the claim.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'AtomicFile.ps1')

$script:MaintenanceBarrierSchema = 1
$script:MaintenanceBarrierFileName = 'maintenance-barrier.json'

function Get-MaintenanceBarrierPath {
    <#
    .SYNOPSIS
        Where the marker lives. Spelled once, so nothing can guard a different file from the one a
        mover writes.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    Join-Path (Join-Path $Workspace 'internal') $script:MaintenanceBarrierFileName
}

function Get-MaintenanceBarrierState {
    <#
    .SYNOPSIS
        `absent`, `engaged` or `unreadable`, with the record behind the answer.

    .DESCRIPTION
        THE THIRD STATE IS THE POINT, for Get-SeatClaimState's reason one subject over: a marker
        that exists and cannot be read is not an absent barrier, and treating it as one would
        re-open every mutator in the middle of a cutover. `engaged` is true for BOTH `engaged` and
        `unreadable`, so a caller that asks the boolean question cannot accidentally take the
        dangerous reading.

        IT TAKES NO LOCK AND CHANGES NOTHING. Every mutator and both launchers call this on their
        way in; a read that could block or write would put a new failure in front of every
        operation in the tree.
    #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    $path = Get-MaintenanceBarrierPath -Workspace $Workspace
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ state = 'absent'; engaged = $false; record = $null; path = $path; detail = '' }
    }
    $raw = $null
    try { $raw = [Text.UTF8Encoding]::new($false, $true).GetString((Read-AtomicBytes -Path $path)) }
    catch {
        return [pscustomobject]@{ state = 'unreadable'; engaged = $true; record = $null; path = $path; detail = "the record could not be read: $($_.Exception.Message)" }
    }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json }
    catch {
        return [pscustomobject]@{ state = 'unreadable'; engaged = $true; record = $null; path = $path; detail = "the record is not valid JSON: $($_.Exception.Message)" }
    }
    if ($null -eq $parsed) {
        return [pscustomobject]@{ state = 'unreadable'; engaged = $true; record = $null; path = $path; detail = 'the record is empty' }
    }
    # Enumerated rather than read off the aggregate .Name: on a single-property object that
    # aggregate is a bare string, which answers a different question (defect family 4).
    $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($required in @('schema', 'barrier_id', 'operation', 'reason', 'engaged_utc')) {
        if ($names -cnotcontains $required) {
            return [pscustomobject]@{ state = 'unreadable'; engaged = $true; record = $null; path = $path; detail = "the record has no '$required' field" }
        }
    }
    [pscustomobject]@{ state = 'engaged'; engaged = $true; record = $parsed; path = $path; detail = '' }
}

function Test-MaintenanceBarrierEngaged {
    <# Is anything stopping mutation right now? Boolean, fail-closed. #>
    param([Parameter(Mandatory = $true)][string]$Workspace)
    [bool](Get-MaintenanceBarrierState -Workspace $Workspace).engaged
}

function Get-MaintenanceBarrierRefusal {
    <#
    .SYNOPSIS
        The refusal sentence, spelled once, or `$null` when nothing is in the way.

    .DESCRIPTION
        ONE SENTENCE, IN ONE PLACE, AND IT IS ITS OWN STOP REASON. A reader told "seat 'x' has no
        live session" during a cutover takes the wrong action -- they start a session, which the
        launcher then refuses for a reason the first message never mentioned. So the barrier states
        what it is, what it is for, who engaged it, and the one command that lifts it.

        The two states get different sentences because they have different remedies: an engaged
        barrier is lifted by its own run, and a damaged one is repaired or removed by hand.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    $state = Get-MaintenanceBarrierState -Workspace $Workspace
    if (-not $state.engaged) { return $null }

    if ([string]$state.state -ceq 'unreadable') {
        return ("The Library is under a maintenance barrier, so $Operation is refused. The barrier record at " +
                "$($state.path) exists and $($state.detail) -- a damaged marker is treated as ENGAGED, because a " +
                'barrier that reads as absent when it is corrupt is not a barrier. Read the run it belongs to with ' +
                'tools/Move-LibraryFolder.ps1 -Action Status, or repair the record by hand. Reading is unaffected.')
    }

    $record = $state.record
    $names = @($record.PSObject.Properties | ForEach-Object { $_.Name })
    $runId = if ($names -ccontains 'run_id') { [string]$record.run_id } else { '' }
    $lift = if ($names -ccontains 'lift_command' -and -not [string]::IsNullOrWhiteSpace([string]$record.lift_command)) {
        [string]$record.lift_command
    }
    elseif (-not [string]::IsNullOrWhiteSpace($runId)) {
        "tools/Move-LibraryFolder.ps1 -Action LiftBarrier -RunId $runId -UserConfirmed"
    }
    else { 'tools/Move-LibraryFolder.ps1 -Action Status' }

    ("The Library is under a maintenance barrier, so $Operation is refused. $([string]$record.operation) engaged it at " +
     "$([string]$record.engaged_utc) for: $([string]$record.reason). Nothing may be changed at any seat until it is " +
     "lifted, which is what keeps a cutover's verified copy from going stale under a late write. Lift it with: $lift. " +
     'Reading is unaffected.')
}

function Assert-NoMaintenanceBarrier {
    <#
    .SYNOPSIS
        Refuse when a cutover is in progress. Throws; never returns a value a caller could ignore.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    $refusal = Get-MaintenanceBarrierRefusal -Workspace $Workspace -Operation $Operation
    if ($null -ne $refusal) { throw $refusal }
    $true
}

function New-MaintenanceBarrier {
    <#
    .SYNOPSIS
        Raise the barrier by EXCLUSIVE CREATE. Returns the record written.

    .DESCRIPTION
        CreateNew is atomic, so exactly one caller wins and a second mover is refused rather than
        overwriting a barrier it did not raise -- the same primitive Enter-BookLock uses, and for
        the same reason. There is deliberately no steal-after-N-minutes here: a Book lock left by a
        crashed writer costs delay, and a barrier left by a crashed CUTOVER means a half-moved tree,
        which must be looked at rather than timed out.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$RunId,
        [string]$LiftCommand = ''
    )
    $internal = Join-Path $Workspace 'internal'
    if (-not (Test-Path -LiteralPath $internal -PathType Container)) {
        New-Item -ItemType Directory -Path $internal -Force | Out-Null
    }
    $path = Get-MaintenanceBarrierPath -Workspace $Workspace
    if ([string]::IsNullOrWhiteSpace($LiftCommand)) {
        $LiftCommand = "tools/Move-LibraryFolder.ps1 -Action LiftBarrier -RunId $RunId -UserConfirmed"
    }
    $record = [ordered]@{
        schema         = $script:MaintenanceBarrierSchema
        barrier_id     = [guid]::NewGuid().ToString('N')
        run_id         = $RunId
        operation      = $Operation
        reason         = $Reason
        engaged_utc    = [DateTime]::UtcNow.ToString('o')
        # RECORDED FOR THE READER, NEVER CONSULTED. A barrier outlives its process on purpose.
        engaged_by_pid = $PID
        lift_command   = $LiftCommand
    }
    $body = (([pscustomobject]$record) | ConvertTo-Json -Depth 6) + "`n"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($body)
    $stream = $null
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    catch [IO.IOException] {
        $existing = Get-MaintenanceBarrierState -Workspace $Workspace
        $who = if ([string]$existing.state -ceq 'engaged') {
            "$([string]$existing.record.operation) engaged it at $([string]$existing.record.engaged_utc) for: $([string]$existing.record.reason)"
        }
        else { "a record is already at $path and $($existing.detail)" }
        throw ("A maintenance barrier is already up, so this one was not raised: $who. One cutover at a time; read it " +
               'with tools/Move-LibraryFolder.ps1 -Action Status.')
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    [pscustomobject]$record
}

function Remove-MaintenanceBarrier {
    <#
    .SYNOPSIS
        Lower the barrier this run raised, and only that one.

    .DESCRIPTION
        THE ID IS CHECKED BEFORE THE DELETE. A run that lowered whatever marker happened to be
        there would, on the day two cutovers overlapped, open the Library in the middle of somebody
        else's copy. `-Force` exists for the one case the id cannot cover: a marker so damaged that
        nothing can read an id out of it, which is a repair rather than a lift.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$BarrierId = '',
        [switch]$Force
    )
    $state = Get-MaintenanceBarrierState -Workspace $Workspace
    if (-not $state.engaged) { return 'absent' }
    if (-not $Force) {
        if ([string]$state.state -cne 'engaged') {
            throw ("The barrier record at $($state.path) cannot be read ($($state.detail)), so its id cannot be " +
                   'matched. Clear it with -Force after reading what run it belonged to, or repair the record.')
        }
        if ([string]::IsNullOrWhiteSpace($BarrierId) -or [string]$state.record.barrier_id -cne $BarrierId) {
            throw ("The maintenance barrier at $($state.path) was raised by run $([string]$state.record.run_id) and " +
                   'carries a different id, so this run did not lower it. One cutover owns one barrier.')
        }
    }
    Remove-Item -LiteralPath $state.path -Force
    'removed'
}
