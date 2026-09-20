<#
.SYNOPSIS
    Create or enter a seat, hold its exclusive session claim, and start the agent there.

.DESCRIPTION
    A seat is a named place to work carrying its own Desk (ADR-0015). This is how one is entered,
    and after the 2026-09-07 ruling it is how work at a seat begins at all: THERE IS NO DEFAULT
    SEAT, so nothing falls back to a seat when `LIBRARY_SEAT` is unset.

    WHY THE LAUNCHER IS MANDATORY FOR MUTATION, AND WHAT IT IS NOT. The mutators that write
    `notebook/` or a Desk require a matching live claim token and fail closed without one
    (step 15b). NO COUNT AND NO LIST HERE, deliberately: `Get-ClaimGatedHelpers` in
    tools/LibrarySeat.ps1 is the declaration, docs/seats.md renders it as a table that
    `seats.contract-table-matches-code` checks in both directions, and a retyped copy in this help
    is exactly how the two come to disagree -- which is what happened to the sentence this one
    replaces. Reads are unaffected: a bare agent invocation can still read the Library's own files
    and answer from them, and every Desk-reading surface takes an explicit -Seat. What it cannot do
    is compile, open a Book, or reset -- because if unclaimed sessions could write, reset could not
    tell they were live, and would quarantine work that was in progress.

    EDITING A HUB IS NOT IN THAT SET, AND THIS HELP SAID IT WAS UNTIL 2026-09-08. Edit-ProjectHub
    and both manifest updaters are seat-aware, mutate, and take no claim: they consult this seat's
    Desk for entitlement and write outside `notebook/`, so no reset judges their output. They are
    still refused at a session holding NO SEAT AT ALL, because resolving the Desk needs one -- a
    different refusal from the claim gate, and worth distinguishing when passing it on.

    (Corrected again 2026-09-10. The replaced sentence said "five" -- four short by then -- and
    named Set-NotebookTopicOwner as taking no claim, which stopped being true on 2026-09-09.)

    HOW THIS IS REACHED, RULED 2026-09-08. From a TERMINAL pane, not an agent button. Orca's agent
    buttons (Claude, Codex) run the binary directly, so a session started from one has no seat and
    no claim; `New Terminal: PowerShell` (Ctrl+T) gives the shell parent this script needs. Nothing
    in the IDE is configured -- the profile-global command override was investigated and rejected,
    because it would run this launcher in every workspace. docs/seats.md carries that reasoning.

    The deciding argument was that a per-pane mechanism to set `LIBRARY_SEAT` is needed regardless,
    so this IS that mechanism rather than an extra step.

    THE CLAIM LASTS EXACTLY AS LONG AS THE SESSION, which is the property Desk state cannot have. It
    is an open file handle held by this process, so it ends when the process does -- including when
    it is killed. Nothing waits on it and it is not an ordered lock; see `tools/LibrarySeat.ps1`.

    MIGRATION IS ADDITIVE HERE, DELIBERATELY. A checkout that predates seats has its Desk in two
    loose files under `.claude`. Entering a seat COPIES them in and verifies the bytes; it does not
    remove them, because a write that provably cannot lose text applies directly while one that can
    needs an approval. Retiring the legacy files is `-RetireLegacyDesk`, and the plan requires that
    it happen with no active session and after an adapter restart -- a long-running validated-reader
    adapter started before the cutover still reads the old path.

    WITH NO -Seat IT IS A PICKER, AND THAT IS WHY IT IS NO LONGER MANDATORY (step 12, 2026-09-10).
    The one-click route -- an agent button plus the SessionStart hook -- is the ordinary way in now,
    and it needs a running agent with hooks enabled. This is the route beside it: hooks disabled, a
    non-Orca terminal, or a recovery. A numbered line per seat, a number to resume that seat's last
    conversation, `n<number>` for a new one, `+` to create and `r<number>` to retire. A caller that
    cannot be prompted -- a script, a hook, an agent tool call, anything with stdin redirected -- is
    refused and told to pass -Seat, because a picker that waited there would hang rather than fail.

.EXAMPLE
    tools/Start-LibrarySeat.ps1 -Seat fallout -Project fallout-research
.EXAMPLE
    tools/Start-LibrarySeat.ps1 -Seat library-dev -Preflight
.EXAMPLE
    tools/Start-LibrarySeat.ps1
#>
[CmdletBinding()]
param(
    # NOT MANDATORY SINCE 2026-09-10: an omitted seat is the picker, not a prompt for this parameter.
    # PowerShell's own mandatory-parameter prompt would ask for a name the reader is here BECAUSE
    # they do not remember, and it would ask it in a non-interactive caller too.
    [string]$Seat,
    [string]$Project,
    [string]$WorkspacePath,
    [string]$Command = 'claude',
    [string[]]$CommandArgs = @(),
    [switch]$NoLaunch,
    [switch]$RetireLegacyDesk,
    [switch]$Preflight,
    # Creating a seat validates that its Project Hub exists and is ACTIVE, and the Active Project
    # Catalog is the only authority for that. Entering an EXISTING seat makes no network call.
    [string]$McpUrl = $env:AI_LIBRARY_MCP_URL,
    [string]$ProjectId = $env:AI_LIBRARY_PROJECT_ID,
    # THE PICKER'S ANSWERS, for a suite that drives the real loop rather than a copy of it. It
    # supplies what Read-Host would have returned and bypasses no gate: the creation still needs its
    # plan_id, retirement still needs its own approval, and the claim is still acquired atomically.
    [string[]]$PickerInput = @(),
    # THE PICKER'S APPROVAL, REVALIDATED UNDER THE REGISTRY LOCK. A reader who typed -Seat and
    # -Project confirmed both by typing them and passes none of this; a reader who typed `+` was
    # SHOWN a plan instead, and this is what stops that plan executing against a registry it never
    # described. Accepted as a parameter rather than kept internal so the revalidation is drivable:
    # a stale id must refuse, and nothing else here can produce one.
    [string]$ApprovedPlanId,
    # RESTORE A RETIRED SEAT'S DESK ONTO THIS ONE (2026-09-10). The stamped directory name under
    # internal/seat-archive/, never a path. Additive: it opens what that Desk had open and closes
    # nothing. The archive's conversation history travels only when the archive records THIS seat's
    # slug -- a conversation record is a claim about which seat a conversation sat at.
    #
    # IT REQUIRES AN EXISTING SEAT, because there is one approval per run and creation already owns
    # -ApprovedPlanId on the route that needs one. Create the seat first with -NoLaunch, then start
    # it with the restore.
    [string]$RestoreDeskFromArchive,
    # The one approval a Desk restore needs, beside its exact -ApprovedPlanId. It applies to nothing
    # else here: entering a seat is not consequential, and creating one is confirmed by typing both
    # slugs or by the picker's own plan.
    [switch]$UserConfirmed,
    # Where conversation transcripts live, for the picker's title column. Defaults to
    # CLAUDE_CONFIG_DIR, then to ~/.claude; a fixture points it at its own tree.
    [string]$TranscriptRoot,
    # The Orca terminal whose tab the picker offers to retitle. THE ONE PLACE THE ENVIRONMENT IS READ
    # for it: passing an empty handle explicitly means "do not offer", which is what lets a suite run
    # inside an Orca terminal without being asked a question it did not plan for.
    [string]$TerminalHandle = $env:ORCA_TERMINAL_HANDLE,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'LibrarySeat.ps1')
# THE CREATION GATE IS SHARED WITH tools/Enter-LibrarySeat.ps1 (SeatCreation.ps1). Until 2026-09-10
# this file validated the project slug's shape and its uniqueness and nothing else, so a seat could
# be created for a Project Hub that does not exist -- which is also what made one-seat-per-project
# unenforceable, since an invented slug is unique by construction.
. (Join-Path $PSScriptRoot 'SeatCreation.ps1')
# The picker: the roster, the choice grammar, the transcript title and the tab offer. It brings the
# creation gate with it, so this file's own dot-source above is what the picker's absence would leave.
. (Join-Path $PSScriptRoot 'SeatPicker.ps1')

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $WorkspacePath = Split-Path -Parent $PSScriptRoot }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$stateDirectory = Join-Path $workspace '.claude'

# --- A CUTOVER STOPS THIS ROUTE BEFORE ANYTHING ELSE (2026-09-19) ---------------------------------
#
# BEFORE THE PICKER, BEFORE ANY LOCK, AND BEFORE ANY PLAN, and it refuses a -Preflight too. The
# barrier's guarantee is that no NEW claim can be taken while a cutover copies and verifies, and a
# launcher is exactly what takes one -- it is not in the claim-gated set because it is the thing
# that ACQUIRES the claim, so Assert-SeatClaimHeld's copy of this guard never sees it.
#
# A preflight is refused rather than shown, for the reason recorded at this file's claim-live
# preflight: printing a plan for a start the barrier is certain to refuse is worse than refusing,
# because the reader acts on the plan.
Assert-NoMaintenanceBarrier -Workspace $workspace -Operation 'starting a session at a seat' | Out-Null

# --- NO -Seat MEANS THE PICKER, AND NEVER A FALL BACK TO THE ENVIRONMENT ---------------------------
#
# Resolve-SeatName's whole job is to answer "which seat is this call about" from three sources, and
# LIBRARY_SEAT is one of them -- so calling it with an empty -Seat here would silently enter whatever
# seat this shell inherited instead of asking. There is no default seat, and a picker whose default
# is the environment is a default seat wearing a menu.
$pickerDecision = $null
$conversationId = ''
$deskRestorePlan = $null
# THE TWO ROUTES THAT OWN -ApprovedPlanId ARE KEPT APART HERE, before either can run. There is one
# approval per run -- a second name for it is how two routes come to disagree about which one was
# checked -- so a run that would both create a seat and restore a Desk is refused rather than given
# two meanings for one argument. The refusal names the two commands.
if (-not [string]::IsNullOrWhiteSpace($RestoreDeskFromArchive) -and [string]::IsNullOrWhiteSpace($Seat)) {
    throw ('A Desk restore acts on ONE named seat: the picker does not offer it. Pass -Seat <name> ' +
           '-RestoreDeskFromArchive <archive> -Preflight to see what it would open.')
}
# THE ARGUMENTS THE AGENT IS ACTUALLY STARTED WITH: what the caller passed, plus whatever the picker's
# decision implies. Kept apart from the parameter so the two can be compared.
$agentArguments = @($CommandArgs)
if ([string]::IsNullOrWhiteSpace($Seat)) {
    if ($Preflight) {
        throw ('A preflight plans ONE named seat: -Preflight with no -Seat would describe an operation nobody has ' +
               'chosen yet. Run tools/Start-LibrarySeat.ps1 with no arguments to pick a seat, or pass -Seat <name> ' +
               '-Preflight to plan that one.')
    }
    # FAIL CLOSED FOR ANYONE WHO CANNOT BE ASKED. Measured 2026-09-10: an agent tool call, a piped
    # invocation and a hook child all report stdin redirected, and an interactive terminal does not.
    # Scripted answers are the one exception, and they are answers rather than a bypass.
    if (-not @($PickerInput).Count -and [Console]::IsInputRedirected) {
        throw (Get-SeatPickerNonInteractiveRefusal -StateDirectory $stateDirectory)
    }
    $pickerDecision = Invoke-SeatPicker -Workspace $workspace -StateDirectory $stateDirectory `
        -InputLines $PickerInput -TranscriptRoot $TranscriptRoot -McpUrl $McpUrl -ProjectId $ProjectId `
        -TerminalHandle $TerminalHandle
    # NOTHING CHOSEN IS NOT A FAILURE. The reader typed `q`, or backed out of a creation; they are
    # where they started, with no claim taken and nothing written.
    if ($null -eq $pickerDecision) { return }
    $Seat = [string]$pickerDecision.seat
    $conversationId = [string]$pickerDecision.conversation_id
    # THE SAME VARIABLE THE PARAMETER DECLARES, deliberately: there is one approval per run, and a
    # second name for it is how two routes come to disagree about which one was checked.
    $ApprovedPlanId = [string]$pickerDecision.approved_plan_id
    # THE PROJECT TRAVELS ONLY FOR A CREATION. For a seat that exists it is read from the registry
    # below, and passing the roster's copy would turn a registry the picker read a moment ago into an
    # argument the seat<->project check has to agree with.
    if ([string]$pickerDecision.action -ceq 'create') { $Project = [string]$pickerDecision.project }
    # A NEW NAME RATHER THAN A REASSIGNED PARAMETER. `$CommandArgs = ...` IS the [string[]] parameter
    # -- PowerShell variable names are case-insensitive -- and powershell.defect-families lints it,
    # because that family's whole expense is the diagnosis: the failure is reported against the
    # script's own parameter binding with the stack pointing at the caller.
    $agentArguments = @(@($agentArguments) + @(Get-SeatPickerLaunchArguments -Decision $pickerDecision))
}

$resolved = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
if ($resolved.status -cne 'named') { throw $resolved.message }
$seatName = $resolved.seat

# --- THE CATALOG READ, IF THIS IS A CREATION, AND IT HAPPENS BEFORE THE LOCK IS TAKEN.
# A network round trip inside the registry lock stalls every other seat's Desk write for as long as
# the NAS takes to answer (D10), so the question "does this Project Hub exist" is answered first.
#
# THE PEEK AT THE REGISTRY HERE IS LOCK-FREE AND DECIDES NOTHING. It answers only "is this call
# likely to create a seat", so that the overwhelmingly common case -- entering a seat that already
# exists -- pays for no network call at all. The authoritative read happens under the lock below and
# the gate runs again there, so a seat that appeared in between is caught by the real check rather
# than by this one.
$activeProjects = @()
if ($null -eq (Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $stateDirectory) -Seat $seatName)) {
    # A DESK RESTORE NEEDS A SEAT TO RESTORE ONTO, AND SAYING SO HERE IS WHAT KEEPS IT CHEAP. The
    # authoritative check is inside the lock below, where $existing is read under it; this one is
    # above the catalog read, so a caller who asked for the impossible combination is refused without
    # a network round trip to a NAS that may not answer.
    if (-not [string]::IsNullOrWhiteSpace($RestoreDeskFromArchive)) {
        throw ("Seat '$seatName' does not exist yet, and a Desk restore needs a seat to restore ONTO. There is one " +
               'approval per run and creating a seat already owns it, so do the two separately: ' +
               "tools/Start-LibrarySeat.ps1 -Seat $seatName -Project <slug> -NoLaunch, then rerun with " +
               "-RestoreDeskFromArchive $RestoreDeskFromArchive -Preflight.")
    }
    $activeProjects = @(Get-ActiveProjectSlugs -McpUrl $McpUrl -ProjectId $ProjectId)
}

# --- Everything that inspects or mutates the registry or a Desk happens under the registry lock,
# --- which is the FIRST class in the total order and therefore always safe to take here.
$lock = Enter-SeatRegistryLock -Workspace $workspace
try {
    $registry = Read-SeatRegistry -StateDirectory $stateDirectory
    $existing = Get-SeatEntry -Registry $registry -Seat $seatName

    if ($null -eq $existing) {
        # EVERY RULE ABOUT WHAT A NEW SEAT MAY BE lives in Assert-NewSeatIsCreatable and is shared
        # with tools/Enter-LibrarySeat.ps1: the Hub must exist and be active, the project must be
        # unbound, and no ownership row or seat archive may still cite the slug. What is NOT shared is
        # the approval -- a reader who typed both slugs at a terminal has confirmed them by typing
        # them, where the Librarian inferring them from a conversation has not, which is why that
        # helper binds its creation to a plan_id and this one does not.
        #
        # $activeProjects was read above, before the lock. If a seat appeared between that read and
        # this line, $existing is non-null and this branch does not run at all.
        Assert-NewSeatIsCreatable -Workspace $workspace -StateDirectory $stateDirectory -Registry $registry `
            -Seat $seatName -Project $Project -ActiveProjects $activeProjects | Out-Null
        # THE PICKER'S APPROVAL IS REVALIDATED HERE, under the lock this creation commits under. A
        # reader who typed both slugs as arguments confirmed them by typing them and needs no
        # plan_id; a reader who typed `+` was SHOWN a plan instead, and a plan shown against one
        # registry must not execute against another. Same derivation as Enter-LibrarySeat.ps1's, from
        # the shared gate, so the two routes cannot drift apart.
        if (-not [string]::IsNullOrWhiteSpace($ApprovedPlanId)) {
            $currentPlanId = Get-SeatCreationPlanId -Registry $registry -Seat $seatName -Project $Project
            if ($ApprovedPlanId -cne $currentPlanId) {
                throw ("Seat '$seatName' was not created: the registry changed between the plan you were shown and this " +
                       'write, so that approval no longer describes it. Run the picker again and confirm the new plan.')
            }
        }
        $bound = $Project
    }
    else {
        $bound = [string]$existing.project
        if (-not [string]::IsNullOrWhiteSpace($Project) -and $Project -cne $bound) {
            throw ("Seat '$seatName' is already bound to project '$bound', not '$Project'. Rebinding a seat would " +
                   'orphan the Notebook topics it owns; create another seat for the other project.')
        }
    }

    $migrationPlan = Get-DeskMigrationPlan -StateDirectory $stateDirectory -Seat $seatName

    if (-not [string]::IsNullOrWhiteSpace($RestoreDeskFromArchive)) {
        if ($null -eq $existing) {
            throw ("Seat '$seatName' does not exist yet, and a Desk restore needs a seat to restore ONTO. There is one " +
                   'approval per run and creating a seat already owns it, so do the two separately: ' +
                   "tools/Start-LibrarySeat.ps1 -Seat $seatName -Project <slug> -NoLaunch, then rerun with " +
                   "-RestoreDeskFromArchive $RestoreDeskFromArchive -Preflight.")
        }
        # COMPUTED INSIDE THE LOCK THE APPLY COMMITS UNDER, so the plan the reader's -ApprovedPlanId
        # is compared against is derived from the Desk as it is now, not as it was when they read it.
        $deskRestorePlan = Get-SeatDeskRestorePlan -Workspace $workspace -StateDirectory $stateDirectory `
            -Seat $seatName -Archive $RestoreDeskFromArchive
    }

    if ($Preflight) {
        # THE CLAIM IS CHECKED BEFORE A PLAN IS ISSUED, not after -- Retire-Seat.ps1's rule, applied
        # to the sibling that MINTS every claim. Until 2026-09-09 this branch computed the very value
        # that refuses, printed `claim_live: True`, promised `launch: claude` and exited 0 -- a plan
        # for an operation Enter-SeatClaim is certain to refuse a dozen lines below. The real path
        # was never unsafe; what was wrong was the plan a reader acts on, and a plan for an operation
        # already certain to fail is worse than no plan.
        #
        # THE PREFLIGHT BRANCH ONLY, DELIBERATELY. Enter-SeatClaim stays the sole authority on the
        # real path, because it is the ATOMIC one: it takes the handle and refuses in the same act,
        # where a Test-then-Enter pair could not. Hoisting this above the branch would make the real
        # path's refusal come from a probe rather than from the acquisition, and would leave the
        # acquisition's own refusal exercised by nothing.
        $claimState = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $seatName
        $claimLive = ([string]$claimState.state -cne 'free')
        if ($claimLive) {
            $because = if ([string]$claimState.state -ceq 'orphaned') {
                "is bound to agent process $([int]$claimState.agent_pid), which is still running even though its claim holder is gone"
            }
            else { 'already has a live session' }
            throw ("Seat '$seatName' $because, so starting one here would be refused and this " +
                   'preflight will not plan it. One session per seat: finish or close that one, or start work at ' +
                   'another seat with tools/Start-LibrarySeat.ps1 -Seat <name>.')
        }
        $plan = [pscustomobject]@{
            operation            = 'Start a Library seat (preflight)'
            seat                 = $seatName
            project              = $bound
            seat_exists          = ($null -ne $existing)
            desk_directory       = (Join-Path (Get-SeatsDirectory $stateDirectory) $seatName)
            claim_live           = $claimLive
            desk_migration       = $migrationPlan.files
            legacy_desk_retired  = [bool]$RetireLegacyDesk
            other_seats          = @(@($registry.seats) | Where-Object { [string]$_.seat -cne $seatName } | ForEach-Object { [string]$_.seat })
            launch               = if ($NoLaunch) { 'none' } else { $Command }
            shared_library_write = $false
        }
        if ($null -ne $deskRestorePlan) {
            # ONE plan_id FOR THE RUN, and when a restore is asked for it is the restore's. The
            # entry itself needs no approval; what the reader is approving is the Desk gaining
            # entries and the seat gaining a conversation history.
            $plan | Add-Member -NotePropertyName 'desk_restore' -NotePropertyValue ([pscustomobject]@{
                archive               = [string]$deskRestorePlan.archive
                archived_seat         = [string]$deskRestorePlan.archived_seat
                archived_seat_id      = [string]$deskRestorePlan.archived_seat_id
                books_to_open         = @($deskRestorePlan.books_to_open)
                books_already_open    = @($deskRestorePlan.books_already_open)
                projects_to_open      = @($deskRestorePlan.projects_to_open)
                projects_already_open = @($deskRestorePlan.projects_already_open)
                history               = [string]$deskRestorePlan.history_action
                history_note          = [string]$deskRestorePlan.history_reason
                conversations_to_add  = @($deskRestorePlan.conversations_to_add)
                faults                = @($deskRestorePlan.faults)
                additive              = $true
                note                  = 'A restore OPENS what the archive had open and closes nothing. It never removes an entry this Desk already holds.'
            })
            $plan | Add-Member -NotePropertyName 'plan_id' -NotePropertyValue ([string]$deskRestorePlan.plan_id)
            $plan | Add-Member -NotePropertyName 'confirmation_required' -NotePropertyValue $true
        }
        Write-LibraryResult -Result $plan -Json:$Json
        return
    }

    # THE RESTORE'S APPROVAL IS CHECKED BEFORE THE CLAIM IS TAKEN, not after. Taking a seat's claim
    # for an operation already certain to be refused would put this session in the way of one that
    # could do the work -- the same rule that moved Retire-Seat's claim probe above its plan.
    if ($null -ne $deskRestorePlan) {
        if (-not $UserConfirmed) {
            throw ('The Desk was not restored: run with -Preflight, show the reader the entries it would open, and rerun ' +
                   'with -UserConfirmed and the exact -ApprovedPlanId after one clear yes.')
        }
        if ($ApprovedPlanId -cne [string]$deskRestorePlan.plan_id) {
            $because = if ([string]::IsNullOrWhiteSpace($ApprovedPlanId)) { 'no plan_id was passed' }
                       else { 'this seat''s Desk, the archive, or its conversation history is not what that plan described' }
            throw ("The Desk was NOT restored: $because. Rerun the current preflight and pass its exact plan_id as " +
                   '-ApprovedPlanId.')
        }
    }

    # AN ORPHANED SEAT IS REFUSED ON THE REAL PATH TOO, and Enter-SeatClaim cannot do it (ADR-0018).
    # `orphaned` means the claim HANDLE is gone while the bound agent process is still running, so
    # the acquisition below would succeed and hand a second agent a seat the first one still holds --
    # the one-live-agent-per-seat invariant broken by the very mechanism that enforces it. This is
    # the matrix's `enter` row for another agent, and it is the one case the atomic acquisition
    # genuinely cannot answer. Everything else stays Enter-SeatClaim's: it takes the handle and
    # refuses in the same act, where a test-then-enter pair could not.
    # ONLY THE ORPHANED ROW IS ANSWERED HERE. A `held` seat is left to Enter-SeatClaim below, whose
    # refusal is atomic and whose wording the reader already knows; answering it from a probe would
    # move the authority to the weaker mechanism. And `orphaned` for THIS agent is `restore` rather
    # than `refuse`, so the acquisition below is exactly what restores the lost handle.
    $entryState = Get-SeatClaimState -StateDirectory $stateDirectory -Seat $seatName
    if ([string]$entryState.state -ceq 'orphaned' -and
        (Get-SeatStateDecision -Operation 'enter' -State 'orphaned' -SameAgent ([bool]$entryState.this_agent)) -ceq 'refuse') {
        throw ("Seat '$seatName' is bound to agent process $([int]$entryState.agent_pid), which is still running; its " +
               'claim holder is gone, which is not the same as the seat being free. Re-bind it from that conversation, ' +
               'or start work at another seat with tools/Start-LibrarySeat.ps1 -Seat <name>.')
    }

    # CLAIM BEFORE MIGRATING. A second live session must be refused before this one starts changing
    # the seat's Desk, not after.
    $claim = Enter-SeatClaim -StateDirectory $stateDirectory -Seat $seatName

    try {
        $migration = Invoke-DeskMigration -StateDirectory $stateDirectory -Seat $seatName -RetireLegacy:$RetireLegacyDesk

        if ($null -eq $existing) {
            # A `seat_id` ON EVERY NEW ENTRY, the same as the other creation route writes. It is what
            # *give retirement an identity* needs to tell a recreated seat from the one whose name it
            # reused, and a registry where only half the entries carry one would make that item's
            # migration guess which half.
            $entries = @(@($registry.seats) + [pscustomobject]@{
                seat = $seatName; project = $bound; created_utc = [DateTime]::UtcNow.ToString('o')
                seat_id = [guid]::NewGuid().ToString('N')
            })
            Write-SeatRegistry -StateDirectory $stateDirectory -Registry ([pscustomobject]@{ schema = 1; seats = $entries })
            # AND THE SAME DESK THE OTHER CREATION ROUTE BUILDS. Until 2026-09-10 this route left the
            # new Desk empty while tools/Enter-LibrarySeat.ps1 opened the seat's own Project Hub, so
            # which route created a seat decided whether it could orient itself. Written in-process
            # rather than through Set-VirtualDesk.ps1, which takes this same non-reentrant lock and
            # would wait on its own parent -- the reason that helper is on Get-RegistryLockedHelpers.
            Set-DeskEntryForSeat -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
                -Kind 'projects' -Entry (Get-NewSeatDeskEntry -Project $bound) -Action 'Add' | Out-Null
        }

        # --- THE DESK RESTORE, INSIDE THE SAME LOCKED TRANSACTION ------------------------------
        #
        # The plan was derived from this Desk under this lock and the approval was matched against it
        # a few lines above, so there is nothing to revalidate: no window has opened. Written through
        # Set-DeskEntryForSeat rather than Set-VirtualDesk.ps1, which takes this same non-reentrant
        # lock and would wait on its own parent -- the reason this file is on Get-RegistryLockedHelpers.
        $deskRestored = $null
        if ($null -ne $deskRestorePlan) {
            $opened = [Collections.Generic.List[string]]::new()
            foreach ($pair in @(
                @{ kind = 'books'; entries = @($deskRestorePlan.books_to_open) },
                @{ kind = 'projects'; entries = @($deskRestorePlan.projects_to_open) })) {
                foreach ($entry in @($pair.entries)) {
                    if (Set-DeskEntryForSeat -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
                            -Kind ([string]$pair.kind) -Entry ([string]$entry) -Action 'Add') {
                        [void]$opened.Add("$([string]$pair.kind): $([string]$entry)")
                    }
                }
            }
            # THE HISTORY ONLY WHEN THERE IS SOMETHING TO ADD. Saving an unchanged document would
            # rewrite the file for no change, and this record is one a reader may be reading.
            $historyAdded = @()
            if ([string]$deskRestorePlan.history_action -ceq 'merge' -and @($deskRestorePlan.conversations_to_add).Count) {
                Save-SeatConversationDocument -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
                    -Document $deskRestorePlan.conversation_document | Out-Null
                $historyAdded = @($deskRestorePlan.conversations_to_add)
            }
            # Read back from the Desk rather than reported from the plan: the point of a restore is
            # that the entries are there, and a field that cannot disagree with the run is not evidence.
            $deskRestored = [pscustomobject]@{
                archive               = [string]$deskRestorePlan.archive
                opened                = @($opened)
                already_open          = @(@($deskRestorePlan.books_already_open | ForEach-Object { "books: $_" }) +
                                          @($deskRestorePlan.projects_already_open | ForEach-Object { "projects: $_" }))
                conversations_added   = @($historyAdded)
                history               = [string]$deskRestorePlan.history_action
                history_note          = [string]$deskRestorePlan.history_reason
                open_books_after      = @(Get-DeskEntriesForSeat -StateDirectory $stateDirectory -Seat $seatName -Kind 'books')
                open_projects_after   = @(Get-DeskEntriesForSeat -StateDirectory $stateDirectory -Seat $seatName -Kind 'projects')
            }
        }

        # --- THE CONVERSATION HISTORY, FOR THE ONE ENTRY ROUTE THAT WRITES NO BINDING (plan step 8)
        #
        # A LAUNCHER-STARTED SESSION CAN NEVER HOLD A BINDING: the claim handle is held by THIS
        # process, so the agent inside it is refused by the `enter`/`held` row of the matrix,
        # deliberately. This process mints the id it passes to `claude --session-id`, so it is the
        # one that knows which conversation is about to sit here -- and without this the durable
        # history would be blank at exactly the seats the one-click route creates, which is the gap
        # step 12 had to close for the picker's roster.
        #
        # IT IS A LOCATOR AND IT SAYS SO. `source` is `launcher`: nothing verified a process, and no
        # reader of this file may treat it as identity. What it buys is that resuming this
        # conversation from a bare agent later finds the seat it was started at, and enters it
        # through the same gate a typed -Seat would meet.
        #
        # INSIDE THE LOCK THIS BLOCK ALREADY HOLDS, rather than beside the lock-free activity write
        # below: a registry-locked record taken under a second acquisition would be a second
        # ordered-lock take on the launch path for a value already known here.
        #
        # AND ONLY WHEN A CONVERSATION IS ACTUALLY STARTED, the same rule the activity record
        # follows: -NoLaunch returns without an agent, and a picked seat entered by name mints
        # nothing, so writing either would name a conversation that never existed.
        if (-not $NoLaunch -and -not [string]::IsNullOrWhiteSpace($conversationId)) {
            $launchEntry = Get-SeatEntry -Registry (Read-SeatRegistry -StateDirectory $stateDirectory) -Seat $seatName
            $launchSeatId = ''
            if ($null -ne $launchEntry) {
                $launchFields = @($launchEntry.PSObject.Properties | ForEach-Object { $_.Name })
                if ($launchFields -ccontains 'seat_id') { $launchSeatId = [string]$launchEntry.seat_id }
            }
            Write-SeatConversationRecord -Workspace $workspace -StateDirectory $stateDirectory -Seat $seatName `
                -SessionId $conversationId -SeatId $launchSeatId -Source 'launcher' | Out-Null
        }
    }
    catch {
        Exit-SeatClaim -Claim $claim
        throw
    }
}
finally { Exit-BookLock -Lock $lock }

# The registry lock is RELEASED before the session runs. Holding an ordered lock for the life of an
# interactive session would block every other seat's registry write for hours; the claim is what
# covers that span, and the claim is deliberately not an ordered lock.
# THE CONVERSATION IS RECORDED ONLY WHEN ONE IS ACTUALLY STARTED. -NoLaunch returns without an
# agent, so writing the id it WOULD have passed would name a conversation that never existed -- and
# the picker's next run would offer to resume it. Advisory state is still state.
$recordedConversation = ''
if (-not $NoLaunch) { $recordedConversation = $conversationId }
# AND A -NoLaunch RUN KEEPS WHATEVER WAS THERE, because it starts no conversation to replace it with.
# Without that, a script entering a seat erased the conversation the last real session recorded.
Write-SeatActivity -StateDirectory $stateDirectory -Seat $seatName -Note 'seat entered' `
    -Conversation $recordedConversation -KeepConversation:$NoLaunch | Out-Null

$env:LIBRARY_SEAT = $seatName
$env:LIBRARY_SEAT_CLAIM = $claim.token

$result = [pscustomobject]@{
    operation            = 'Start a Library seat'
    seat                 = $seatName
    project              = $bound
    desk_directory       = (Get-DeskStateDirectory -StateDirectory $stateDirectory -Seat $seatName)
    desk_migrated        = $migration.migrated
    legacy_desk_retired  = $migration.legacy_retired
    claim_held           = $true
    environment          = @('LIBRARY_SEAT', 'LIBRARY_SEAT_CLAIM')
    # WHAT THE PICKER DECIDED, reported rather than only acted on: which conversation this session is,
    # how it was chosen, and the arguments the agent is actually started with. `picked` is false for
    # a named -Seat, which is how a caller tells a chosen seat from a typed one.
    picked               = ($null -ne $pickerDecision)
    conversation         = $conversationId
    conversation_action  = $(if ($null -ne $pickerDecision) { [string]$pickerDecision.action } else { 'named' })
    conversation_recorded = (-not [string]::IsNullOrWhiteSpace($recordedConversation))
    command_args         = @($agentArguments)
    shared_library_write = $false
}
# Reported only when one was asked for, and read back from the Desk rather than restated from the
# plan: what makes a restore true is that the entries are on the Desk now.
if ($null -ne $deskRestored) { $result | Add-Member -NotePropertyName 'desk_restore' -NotePropertyValue $deskRestored }

try {
    if ($NoLaunch) {
        Write-LibraryResult -Result $result -Json:$Json
        # NoLaunch exists for scripts and tests. The claim is released on the way out, because
        # nothing is holding the seat after this process ends -- which is the honest answer.
        return
    }
    # THE TAB IS RETITLED ONLY NOW, with the claim in hand. The picker decides it and this performs
    # it: doing the rename there would have titled a tab for a seat the acquisition above can still
    # refuse. SILENT ON SUCCESS since 2026-09-14, when the reader's yes went away -- a line saying the
    # tab is now called `seat: <name>` tells them what the tab bar is already showing them. A failure
    # still speaks, because that is the case where the tab does NOT say where they are sitting.
    if ($null -ne $pickerDecision -and [bool]$pickerDecision.rename_tab) {
        $rename = Set-OrcaTerminalTitle -TerminalHandle ([string]$pickerDecision.terminal_handle) -Seat $seatName
        if ([string]$rename.outcome -cne 'renamed') {
            Write-Host "The tab was not retitled ($([string]$rename.outcome)): $([string]$rename.reason)"
        }
    }
    Write-LibraryResult -Result $result -Json:$Json
    & $Command @agentArguments
}
finally {
    Exit-SeatClaim -Claim $claim
}
