<#
.SYNOPSIS
    Hold one seat's claim handle for exactly as long as its agent process lives. Spawned by
    Start-SeatClaimHolder; never run by hand.

.DESCRIPTION
    THE PROBLEM THIS PROCESS EXISTS FOR. A seat's claim is an open file handle, which is what makes it
    end exactly when its holder does -- including when the holder is killed, which no written record
    can match. On the terminal route the launcher IS the session, so it holds the handle itself for
    hours and there is nothing to spawn. On the bind-after-launch route (ADR-0018) the helper that
    binds the seat is invoked from a tool call and lives for a second, while the agent it is binding
    lives for the whole conversation. Something has to outlive the helper and die with the agent, and
    this is it.

    IT ABANDONS ITSELF, AND THAT IS THE WHOLE SAFETY PROPERTY (round 3 of review, #3). Every launch is
    an ATTEMPT with a recorded deadline. This process opens the handle, then polls its own attempt
    record: if the record is gone, already `abandoned`, or still `pending` when the deadline passes, it
    releases the handle and exits. So a helper killed mid-handshake leaves a handle that lets go by
    itself rather than one nobody can release, and a child that starts late -- after its attempt was
    abandoned -- never acquires one at all.

    IT VERIFIES THE AGENT BEFORE IT TAKES ANYTHING. The PID it is given is checked against the start
    time recorded with it, through the same Get-AgentProcessIdentity the binding was written from, so
    there is no second formatting of a DateTime that could read as a different process. A recycled PID
    is a different process and gets no handle.

    IT TAKES NO LOCK, EVER, and that is not an omission. Start-SeatClaimHolder waits for this process
    while HOLDING the registry lock, so a holder that waited for that lock would be waiting for the
    helper that is waiting for it. Everything here is either a handle operation or a lock-free read,
    for the same reason the claim probe never blocks.

    ITS OUTPUT GOES NOWHERE. It is spawned hidden and detached; nothing reads its streams. The attempt
    record and the claim handle are the whole interface, which is why every exit path below changes
    one of them rather than printing anything.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorkspacePath,
    [Parameter(Mandatory = $true)][string]$Seat,
    [Parameter(Mandatory = $true)][string]$AttemptId,
    [Parameter(Mandatory = $true)][int]$AgentProcessId,
    [Parameter(Mandatory = $true)][string]$AgentStartUtc,
    # How often the agent is re-checked once the attempt has committed. A second would be tidier and
    # buys nothing: the seat is released when the agent dies, and nothing is waiting on the release.
    [int]$AgentPollMilliseconds = 2000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')

$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'
$resolved = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($resolved.status -cne 'named') { exit 2 }
$seatName = $resolved.seat

# --- 1. IS THIS ATTEMPT STILL WANTED, AND IS THE AGENT STILL THE AGENT? ---------------------------
# Both are checked BEFORE the handle is opened. A late child must never acquire one, because the
# helper that spawned it has already given up and may have removed the provisional state it would
# otherwise be holding a seat against.
$attempt = $null
# EXIT 7, NOT 3. An unreadable attempt record and an absent one both mean "let go", and both are safe;
# they are still different faults, and one shared code left the guard below indistinguishable from this
# one -- deleting either produced the same exit, so a suite could not tell that a control had gone.
try { $attempt = Read-SeatHolderAttempt -StateDirectory $stateDirectory -Seat $seatName }
catch { exit 7 }
if ($null -eq $attempt) { exit 3 }
if ([string]$attempt.attempt_id -cne $AttemptId) { exit 3 }
if ([string]$attempt.state -cne 'pending') { exit 3 }
if (-not (Test-SeatAgentAlive -ProcessId $AgentProcessId -StartUtc $AgentStartUtc)) { exit 4 }

$deadline = [DateTime]::MaxValue
try { $deadline = [DateTime]::Parse([string]$attempt.deadline_utc).ToUniversalTime() }
catch { exit 3 }

# --- 2. THE HANDLE ---------------------------------------------------------------------------------
# Enter-SeatClaim is the atomic acquisition: it takes the handle and refuses in the same act, so a
# seat another agent holds is refused here rather than probed for first.
$claim = $null
try { $claim = Enter-SeatClaim -StateDirectory $stateDirectory -Seat $seatName -AttemptId $AttemptId }
catch { exit 5 }

try {
    # --- 3. WAIT FOR THE COMMIT, AND ABANDON AT THE DEADLINE --------------------------------------
    # The helper commits the binding first and this attempt second, so a `committed` attempt means the
    # binding it belongs to is already durable. Anything else -- abandoned, gone, unreadable, or still
    # pending past the deadline -- means let go.
    $committed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $current = $null
        try { $current = Read-SeatHolderAttempt -StateDirectory $stateDirectory -Seat $seatName }
        catch { break }
        if ($null -eq $current) { break }
        if ([string]$current.attempt_id -cne $AttemptId) { break }
        if ([string]$current.state -ceq 'abandoned') { break }
        if ([string]$current.state -ceq 'committed') { $committed = $true; break }
        Start-Sleep -Milliseconds 25
    }
    if (-not $committed) { exit 6 }

    # --- 4. HOLD FOR EXACTLY THE AGENT'S LIFE -----------------------------------------------------
    # Polled rather than waited on, because the question is not "has PID N exited" but "is PID N still
    # the process this seat was bound to". Wait-Process cannot tell those apart across a PID reuse.
    while (Test-SeatAgentAlive -ProcessId $AgentProcessId -StartUtc $AgentStartUtc) {
        Start-Sleep -Milliseconds $AgentPollMilliseconds
    }
}
finally {
    # THE RELEASE IS IN A FINALLY AND Exit-SeatClaim NEVER THROWS, so every path above -- including an
    # exit, a kill of the agent, and an unhandled fault -- ends with the seat released.
    Exit-SeatClaim -Claim $claim
}
