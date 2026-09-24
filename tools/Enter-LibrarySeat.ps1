<#
.SYNOPSIS
    Sit down at a seat from a conversation that has already started: bind this agent process to a
    seat, or create one after a single confirmation.

.DESCRIPTION
    THE ROUTE THIS OPENS, AND WHY IT IS NOT THE LAUNCHER. `tools/Start-LibrarySeat.ps1` starts the
    agent, so it can hold the seat's claim handle in-process for the whole session. A session begun
    from an IDE agent button has no launcher above it, and until now that meant no seat at all: it
    could read the Library's own files and open nothing. ADR-0018 amends the entry route -- a seat
    may be BOUND to the running agent process, verified by process identity -- and this is the helper
    that does it. Nothing about what a seat IS changes: one live agent per seat, one seat per agent
    process for the life of that process, no default seat, and the mutators still fail closed without
    a claim.

    THE CLAIM IS HELD BY A SPAWNED HOLDER, because this helper lives for a second and the agent it is
    binding lives for hours. `Start-SeatClaimHolder` writes an attempt record, spawns
    `Invoke-SeatClaimHolder.ps1`, and waits for that holder to have the handle; the holder then waits
    on the agent process and releases in a `finally`. Every launch is self-abandoning: a helper killed
    mid-handshake leaves a handle that lets go by itself.

    THE ORDER OF THE TWO COMMITS IS LOAD-BEARING and is explained where it happens, in
    `Complete-SeatClaimHolder`: the binding commits first and the attempt second, so the crash window
    lands on `orphaned` -- a state the matrix already repairs -- rather than on a held handle over a
    binding nothing can recognise.

    THE DESK IS NOT TOUCHED WHEN AN EXISTING SEAT IS ENTERED (ADR-0010). Entering a seat is not a
    reset and not a migration; what was open stays open.

    CREATING A SEAT TAKES ONE CONFIRMATION BOUND TO A `plan_id` (Eric, Q3). The preflight reads the
    Active Project Catalog over MCP -- OUTSIDE any lock, because a network read inside the registry
    lock stalls every other seat -- and validates that the Hub exists and is active, that no other
    seat holds the project, and that no ownership row or seat archive still cites the slug. The
    confirmed run is ONE transaction under the registry lock, and an uncommitted creation aborts
    explicitly: the attempt is abandoned, the handle is waited out, and the seat directory and
    registry entry are removed ONLY ONCE THAT HANDLE HAS ACTUALLY CLOSED. When it has not, the seat is
    left whole and registered rather than half-removed -- a registered seat with a Desk and no binding
    is what a successful creation minus the bind looks like, so the reader can enter it or retire it,
    where a directory with its Desk files deleted and its claim file refusing has no route at all.

.EXAMPLE
    tools/Enter-LibrarySeat.ps1 -Seat library-dev
.EXAMPLE
    tools/Enter-LibrarySeat.ps1 -Seat fallout -Create -Project fallout-research -Preflight
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Seat,
    [string]$Project,
    [string]$WorkspacePath,
    # The agent process this seat binds to. Resolved from CLAUDE_PID when omitted, which is every
    # ordinary call; supplied explicitly by fixtures and by any caller that identified its agent
    # another way, such as the reader adapter's parent-process route.
    [int]$AgentProcessId = -1,
    # The Claude conversation, recorded on the binding so a resumed conversation can find its seat
    # again. It LOCATES and never authorises (ADR-0018).
    [string]$SessionId,
    [switch]$Create,
    [switch]$Preflight,
    [switch]$UserConfirmed,
    [string]$ApprovedPlanId,
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$ProjectId = $env:AI_LIBRARY_PROJECT_ID,
    # Step 0d measured the registry lock refusing at 2108 ms against a held lock, and a real Desk
    # write holds it for under a millisecond. Two seconds is a bind that degrades to a refusal rather
    # than a reader's first turn hanging on another seat.
    [double]$DeadlineSeconds = 2,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# THE CREATION GATE IS SHARED WITH THE LAUNCHER (SeatCreation.ps1). The two routes validated
# different things until 2026-09-10, and that divergence is what let a seat be bound to a Project Hub
# that does not exist. It brings NotebookOwnership.ps1 and RawBatchOwnership.ps1 with it.
. (Join-Path $PSScriptRoot 'SeatCreation.ps1')

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

# AND THE DEPLOYMENT THAT WORKSPACE IS ATTACHED TO, for the same reason and in the same shape as
# tools/Start-LibrarySeat.ps1: the seat came from -WorkspacePath and the endpoint came from the cwd,
# which are two answers to one question wherever the program and the workspace are different
# directories. -Optional, because entering an existing seat needs no network and the refusal belongs
# at the catalog read, which can say what it could not confirm.
if ([string]::IsNullOrWhiteSpace($McpUrl)) {
    $McpUrl = Resolve-LibraryMcpUrl -WorkspacePath $workspace -Optional
}
if ([string]::IsNullOrWhiteSpace($ProjectId)) {
    $ProjectId = Resolve-LibraryCollectionId -WorkspacePath $workspace -Optional
}

# --- A CUTOVER STOPS THIS ROUTE BEFORE ANYTHING ELSE (2026-09-19) ---------------------------------
#
# The second entry route, and it needs the guard for the same reason the launcher does: binding an
# agent to a seat takes a claim, and the barrier exists to guarantee that no new claim starts while
# a cutover copies and verifies. Refused ahead of identity, the registry lock and any plan --
# including a -Preflight, because a plan the barrier will refuse is a plan the reader acts on.
Assert-NoMaintenanceBarrier -Workspace $workspace -Operation 'sitting down at a seat' | Out-Null

# THE SEAT IS NAMED, ALWAYS. Resolving it implicitly would make "enter a seat" mean "enter the seat I
# am already at", which is the one thing this helper has no use for.
$resolved = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($resolved.status -cne 'named') { throw $resolved.message }
$seatName = $resolved.seat

# --- WHO IS ASKING ---------------------------------------------------------------------------------
# Identity first, before any lock and before any plan: a seat binds to a process, so a caller whose
# process cannot be identified has nothing to bind and must be told that rather than shown a plan.
$agentPid = if ($AgentProcessId -ge 0) { $AgentProcessId } else { Get-CurrentAgentProcessId }
if ($agentPid -le 0) {
    throw ('This process is not recognised as an agent tool child, so there is no agent process to bind a seat to. ' +
           'CLAUDE_PID is set in Claude Code tool and hook children and nowhere else. Run this from a tool call in the ' +
           "conversation that should hold the seat, or start work at a terminal with tools/Start-LibrarySeat.ps1 -Seat $seatName.")
}
$agentStartUtc = Get-AgentProcessIdentity -ProcessId $agentPid
if ($null -eq $agentStartUtc) {
    throw ("Agent process $agentPid is not running, so nothing may be bound to it. If this came from CLAUDE_PID, the " +
           'value is stale; pass -AgentProcessId explicitly or start a new conversation.')
}

# THE PLAN ID'S DERIVATION MOVED INTO THE SHARED GATE ON 2026-09-10 (Get-SeatCreationPlanId), where
# the validations already live. The terminal picker is a second route that shows a creation plan and
# asks for a yes, and two copies of an approval's derivation would agree until one of them changed --
# after which an approval would silently stop binding what the reader was shown.

function Get-EntrySeatId($Entry) {
    if ($null -eq $Entry) { return $null }
    $names = @($Entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -cnotcontains 'seat_id') { return $null }
    [string]$Entry.seat_id
}

# ==================================================================================================
# CREATE
# ==================================================================================================
if ($Create) {
    if ($Preflight) {
        # THE CATALOG READ IS OUTSIDE EVERY LOCK (D10) and is the shared gate's, not this file's --
        # the launcher makes the same read for the same reason. A network round trip inside the
        # registry lock stalls every seat's Desk write for as long as the NAS takes to answer, and
        # this read is a precondition rather than part of any transaction: the confirmed run
        # revalidates the registry under the lock.
        $activeProjects = @(Get-ActiveProjectSlugs -McpUrl $McpUrl -ProjectId $ProjectId)

        $lock = Enter-SeatRegistryLock -Workspace $workspace
        try {
            $registry = Read-SeatRegistry -StateDirectory $stateDirectory
            # THE SEAT HALF FIRST, so the offer below is only made to a reader whose seat name is
            # actually usable.
            Assert-NewSeatIsCreatable -Workspace $workspace -StateDirectory $stateDirectory -Registry $registry `
                -Seat $seatName -ActiveProjects $activeProjects -SeatOnly | Out-Null
            if ([string]::IsNullOrWhiteSpace($Project) -or $Project -cnotin $activeProjects) {
                # NOT A REFUSAL WHEN NOTHING WAS NAMED. The reader is being offered the list; a wrong
                # name is a different case and says so.
                $because = if ([string]::IsNullOrWhiteSpace($Project)) { 'A new seat is bound to exactly one Project, and none was named.' }
                           else { "There is no active Project Hub '$Project'." }
                Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
                    operation             = 'Create a Library seat (preflight)'
                    seat                  = $seatName
                    project               = $Project
                    plan_id               = $null
                    because               = $because
                    active_projects       = $activeProjects
                    taken_projects        = @(@($registry.seats) | ForEach-Object { [string]$_.project } | Sort-Object -CaseSensitive)
                    next                  = "Rerun with -Project <slug> from active_projects, then confirm with -UserConfirmed and the plan_id it issues."
                    confirmation_required = $true
                    shared_library_write  = $false
                })
                return
            }
            Assert-NewSeatIsCreatable -Workspace $workspace -StateDirectory $stateDirectory -Registry $registry `
                -Seat $seatName -Project $Project -ActiveProjects $activeProjects | Out-Null

            $planId = Get-SeatCreationPlanId -Registry $registry -Seat $seatName -Project $Project

            Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
                operation             = 'Create a Library seat (preflight)'
                seat                  = $seatName
                project               = $Project
                plan_id               = $planId
                desk_directory        = (Join-Path (Get-SeatsDirectory $stateDirectory) $seatName)
                desk_created_empty    = $true
                project_hub_opened    = "projects/$Project"
                agent_pid             = $agentPid
                session_id            = $SessionId
                other_seats           = @(@($registry.seats) | ForEach-Object { [string]$_.seat } | Sort-Object -CaseSensitive)
                confirmation_required = $true
                note                  = 'The new seat opens its own Project Hub and nothing else. No other seat is touched, and no shared-collection write happens.'
                shared_library_write  = $false
            })
            return
        }
        finally { Exit-BookLock -Lock $lock }
    }

    if (-not $UserConfirmed) {
        throw ('No seat was created: run with -Create -Preflight, show the reader the seat and the Project it would be ' +
               'bound to, and rerun with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.')
    }
    if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { throw 'No seat was created: -UserConfirmed needs the exact -ApprovedPlanId the preflight issued.' }

    $lock = Enter-SeatRegistryLock -Workspace $workspace
    $attempt = $null
    $seatCreated = $false
    $registryWritten = $false
    try {
        # REVALIDATED UNDER THE LOCK, and the digest is what binds the approval to the registry the
        # reader saw. A seat created between the preview and this line changes the digest, so the
        # approval stops applying rather than executing against a registry it never described.
        $registry = Read-SeatRegistry -StateDirectory $stateDirectory
        # THE SAME GATE, RE-RUN UNDER THE LOCK against the registry this transaction will write. The
        # digest below catches a registry that CHANGED since the preview; this catches one that was
        # never legal, and the two are different failures. The Project is checked against the
        # preflight's own answer rather than re-read: the approval is what binds it, and a second
        # network read inside the lock is the thing D10 forbids.
        if ([string]::IsNullOrWhiteSpace($Project)) { throw 'The confirmed run needs the same -Project the preflight planned.' }
        Assert-NewSeatIsCreatable -Workspace $workspace -StateDirectory $stateDirectory -Registry $registry `
            -Seat $seatName -Project $Project -ActiveProjects @($Project) | Out-Null

        $planId = Get-SeatCreationPlanId -Registry $registry -Seat $seatName -Project $Project
        if ($ApprovedPlanId -cne $planId) {
            throw ('The seat was not created: that plan_id does not match this seat, this project and the registry as ' +
                   'it stands now. Either the id is not the one the preflight issued, or the registry changed since ' +
                   'it was. Rerun the preflight, show the reader what it says, and ask again.')
        }

        $seatId = [guid]::NewGuid().ToString('N')
        # THE DESK IS CREATED IN-PROCESS, never through Set-VirtualDesk.ps1: that helper takes this
        # same non-reentrant lock, so a child process would wait on its own parent (measured
        # 2026-09-09 on Remove-ShelfBook's auto-close). It also requires a claim, which does not exist
        # yet at this point in the transaction.
        New-SeatDirectory -StateDirectory $stateDirectory -Seat $seatName | Out-Null
        $seatCreated = $true
        Set-DeskEntryForSeat -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -Kind 'projects' -Entry (Get-NewSeatDeskEntry -Project $Project) -Action 'Add' | Out-Null

        $entries = @(@($registry.seats) + [pscustomobject]@{
            seat = $seatName; project = $Project; created_utc = [DateTime]::UtcNow.ToString('o'); seat_id = $seatId
        })
        Write-SeatRegistry -StateDirectory $stateDirectory -Registry ([pscustomobject]@{ schema = 1; seats = $entries })
        $registryWritten = $true

        Write-SeatBinding -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -SessionId $SessionId -SeatId $seatId -State 'pending' | Out-Null
        $attempt = Start-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -DeadlineSeconds $DeadlineSeconds
        Complete-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -Attempt $attempt -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -SessionId $SessionId `
            -SeatId $seatId -CommitBinding | Out-Null

        Write-SeatActivity -StateDirectory $stateDirectory -Seat $seatName -Note 'seat created and bound' | Out-Null
        Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
            operation            = 'Create a Library seat'
            seat                 = $seatName
            seat_id              = $seatId
            project              = $Project
            desk_directory       = (Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName)
            bound                = $true
            binding_source       = 'binding'
            agent_pid            = $agentPid
            session_id           = $SessionId
            holder_pid           = [int]$attempt.holder_pid
            shared_library_write = $false
        })
    }
    catch {
        # THE ABORT IS EXPLICIT, AND ITS ORDER IS THE POINT (round 3, #4). The handle goes first: a
        # seat directory removed while a holder still has `.claim` open cannot be deleted, and what
        # `Remove-Item -Force -ErrorAction SilentlyContinue` would leave is a HALF-deleted seat -- the
        # Desk files gone, the claim file and the directory still there, and nothing saying so.
        #
        # SO THE REMOVAL IS CONDITIONAL ON THE HANDLE ACTUALLY CLOSING, not merely on having asked it
        # to. When it does not close, the seat is left whole and registered rather than half-removed:
        # a registered seat with a Desk and no binding is exactly what a successful creation minus the
        # bind looks like, so the reader can enter it or retire it through the ordinary routes. A
        # half-deleted directory has no route at all.
        #
        # The never-committed `pending` binding is provisional state and goes with the directory --
        # the protection in Write-SeatBinding covers COMMITTED bindings only, which is exactly why
        # this one may be removed.
        # THE HANDLE IS ASKED, NOT INFERRED. `$attempt` is $null on the commonest failure of all --
        # Start-SeatClaimHolder throwing, which is exactly the timeout case -- and that function has
        # already abandoned its own attempt and waited for the handle without necessarily getting it.
        # An earlier version read "no attempt object" as "nothing to release" and deleted a seat
        # directory whose claim file another process still held: the Desk files went, the claim file
        # refused, and what was left was a half-removed seat with the registry entry gone too. Found
        # by `seat.create-acceptance` planting a held handle, not by reading this.
        if ($null -ne $attempt) {
            Stop-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName -Attempt $attempt | Out-Null
        }
        $handleFree = -not (Test-SeatClaim -StateDirectory $stateDirectory -Seat $seatName)
        if (-not $handleFree) {
            throw ("Seat '$seatName' was created but not bound, and its claim handle is still open, so it was LEFT IN " +
                   "PLACE rather than half-removed: $($_.Exception.Message) The seat is registered and its Desk holds " +
                   "projects/$Project. Enter it with tools/Enter-LibrarySeat.ps1 -Seat $seatName once that holder has " +
                   "gone, or retire it with tools/Retire-Seat.ps1 -Seat $seatName.")
        }
        if ($registryWritten) {
            $rollback = Read-SeatRegistry -StateDirectory $stateDirectory
            $kept = @(@($rollback.seats) | Where-Object { [string]$_.seat -cne $seatName })
            Write-SeatRegistry -StateDirectory $stateDirectory -Registry ([pscustomobject]@{ schema = 1; seats = $kept })
        }
        if ($seatCreated) {
            $deskDirectory = Join-Path (Get-SeatsDirectory $stateDirectory) $seatName
            Remove-Item -LiteralPath $deskDirectory -Recurse -Force
        }
        throw
    }
    finally { Exit-BookLock -Lock $lock }
    return
}

# ==================================================================================================
# ENTER AN EXISTING SEAT
# ==================================================================================================
if ($Preflight) {
    throw ('Entering an EXISTING seat needs no preflight: it is entered on the reader''s word, and it changes no ' +
           'material -- the Desk is left exactly as it was. -Preflight belongs to -Create, which needs one confirmation ' +
           'of both slugs.')
}

$lock = Enter-SeatRegistryLock -Workspace $workspace -TimeoutSeconds ([int][Math]::Ceiling($DeadlineSeconds))
try {
    $entry = Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $seatName

    # ONE SEAT PER AGENT PROCESS FOR ITS LIFE (D11). Checked before the matrix, because "you are
    # already sitting somewhere else" is a different sentence from "somebody else has that seat", and
    # a reader told the second takes the wrong action.
    $boundElsewhere = Get-SeatBindingForAgent -StateDirectory $stateDirectory -AgentProcessId $agentPid
    if ($null -ne $boundElsewhere -and [string]$boundElsewhere.seat -cne $seatName) {
        throw ("This agent process is already bound to seat '$([string]$boundElsewhere.seat)', so it may not also take " +
               "'$seatName'. One agent process holds one seat for the life of that process: a seat given away mid-session " +
               'could have a queued write land at it afterwards. End this conversation and sit down at ' +
               "'$seatName' in a new one.")
    }

    $state = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $seatName -AgentProcessId $agentPid
    $decision = Get-SeatStateDecision -Operation 'enter' -State ([string]$state.state) -SameAgent ([bool]$state.this_agent)

    if ($decision -ceq 'refuse') {
        if ([string]$state.state -ceq 'orphaned') {
            throw ("Seat '$seatName' is bound to agent process $([int]$state.agent_pid), which is still running; its claim " +
                   'holder is gone, which is not the same as the seat being free. Re-bind it from that conversation, or ' +
                   'work at another seat.')
        }
        throw ("Seat '$seatName' has a live session at agent process $([int]$state.agent_pid). One live agent per seat: " +
               'finish or close that one, or work at another seat.')
    }

    $attempt = $null
    if ($decision -ceq 'no-op') {
        # ALREADY BOUND, AND THIS IS NOT AN ERROR. A resumed conversation's hook and a reader who says
        # it twice both land here, and both want the same answer: you are at this seat.
        #
        # AND IT IS STILL THE PLACE THE CONVERSATION IS RECORDED. A no-op that reported the seat and
        # dropped the -SessionId it was handed would leave this agent's binding naming an older
        # conversation, which is the record a later resume looks itself up in. The shared function
        # decides whether there is anything to write and detects the lock this transaction holds.
        $conversationRecord = Update-SeatConversationRecord -Workspace $workspace -StateDirectory $stateDirectory `
            -Seat $seatName -AgentProcessId $agentPid -SessionId $SessionId -DeadlineSeconds $DeadlineSeconds
        $boundConversation = if ($conversationRecord -ceq 'recorded') { $SessionId } else { [string]$state.session_id }
        $result = [pscustomobject]@{
            operation            = 'Enter a Library seat'
            seat                 = $seatName
            project              = [string]$entry.project
            bound                = $true
            already_bound        = $true
            conversation_record  = $conversationRecord
            binding_source       = 'binding'
            agent_pid            = $agentPid
            session_id           = $boundConversation
            desk_directory       = (Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName)
            desk_action          = 'untouched'
            shared_library_write = $false
        }
        Write-LibraryResult -Result $result -Json:$Json
        return
    }

    $attempt = Start-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
        -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -DeadlineSeconds $DeadlineSeconds

    if ($decision -ceq 'restore') {
        # RECOVERY WRITES ONLY AN ATTEMPT (round 3, #2). The committed binding is the identity that
        # made this recovery safe to allow at all; rewriting it here would erase what was verified.
        Complete-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName -Attempt $attempt | Out-Null
    }
    else {
        $seatId = Get-EntrySeatId $entry
        Write-SeatBinding -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -SessionId $SessionId -SeatId $seatId -State 'pending' | Out-Null
        Complete-SeatClaimHolder -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
            -Attempt $attempt -AgentProcessId $agentPid -AgentStartUtc $agentStartUtc -SessionId $SessionId `
            -SeatId $seatId -CommitBinding | Out-Null
    }

    # THE CONVERSATION IS READ BACK OFF THE BINDING, never echoed from the parameter. A recovery
    # passes no -SessionId and must not rewrite the committed binding, so the conversation this seat
    # is bound to is the one already recorded -- reporting the empty parameter instead would tell a
    # reader their seat had lost its conversation at the moment it was repaired.
    $committedBinding = Read-SeatBinding -StateDirectory $stateDirectory -Seat $seatName
    $boundSession = ''
    if ($null -ne $committedBinding) {
        $bindingFields = @($committedBinding.PSObject.Properties | ForEach-Object { $_.Name })
        if ($bindingFields -ccontains 'session_id') { $boundSession = [string]$committedBinding.session_id }
    }

    $result = [pscustomobject]@{
        operation            = 'Enter a Library seat'
        seat                 = $seatName
        project              = [string]$entry.project
        bound                = $true
        already_bound        = $false
        recovered_orphan     = ($decision -ceq 'restore')
        binding_source       = 'binding'
        agent_pid            = $agentPid
        session_id           = $boundSession
        holder_pid           = [int]$attempt.holder_pid
        desk_directory       = (Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName)
        # ADR-0010: entering a seat is not a reset and not a migration. What was open stays open.
        desk_action          = 'untouched'
        shared_library_write = $false
    }
    Write-LibraryResult -Result $result -Json:$Json
}
finally { Exit-BookLock -Lock $lock }

Write-SeatActivity -StateDirectory $stateDirectory -Seat $seatName -Note 'seat bound' | Out-Null
