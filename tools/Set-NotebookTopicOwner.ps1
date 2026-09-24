<#
.SYNOPSIS
    Record which seat owns a Notebook topic, or declare it shared or excluded.

.DESCRIPTION
    `notebook/` is shared by every seat, so a reset has to know whose material it is about to move.
    The three Notebook writers record ownership for the topics they create; this is how a topic that
    predates them, or one that belongs to nobody in particular, gets mapped.

    THE DAY-ONE PREFLIGHT REFUSES UNTIL EVERY TOPIC ON DISK IS MAPPED (step 23), and this is the
    helper that answers it. A `topic-slug == seat-slug` fallback was rejected: it would recognise
    only `notebook/main/` and leave real directories like `notebook/library-dev/` unowned and
    reachable only by the dangerous whole-tree path.

    THE THREE SCOPES, AND WHY THE LAST TWO ARE DECLARED RATHER THAN INFERRED:

        -Scope owned     this seat's material; its reset moves it
        -Scope shared    deliberately common ground; NO seat's reset moves it
        -Scope excluded  deliberately out of scope; NO seat's reset moves it

    A reset that silently skips a topic and one that silently includes one are both wrong, and the
    reader is approving one specific set of moves. `shared` and `excluded` make the skip explicit and
    reviewable rather than an accident of what nobody got round to mapping.

    AND `excluded` IS REFUSED ON A TOPIC THAT IS PROVABLY REPRODUCIBLE (ADR-0025, encoded 2026-09-18).
    A topic every page of which is a hash-bound current copy of a published Book can be rebuilt by
    tools/Restore-BookSource.ps1, so declaring it out of every reset's reach protects nothing and
    costs the reader an empty Notebook they asked for. THE DRIFT HALF IS WHY THIS IS NOT SIMPLY "has
    a Book": a topic holding a page the Book does not -- drifted, legacy-recorded, or never published
    -- is legitimately excluded, and that declaration still goes through. Pass -AcceptReproducible to
    declare it anyway; the result then says the evidence was seen and taken.

    ADDITIVE, AND CLAIM-GATED SINCE 2026-09-09. It writes one record and touches no Notebook material
    at all, so it needs no approval: getting a mapping wrong is corrected by running it again. What it
    does need is the ACTING session's own live seat claim, and the distinction is the whole reason
    this helper was left out of the claim-gated set until now -- `-Seat` names the topic's ASSIGNEE,
    which may legitimately be a dormant seat, so demanding THAT seat's claim would answer the wrong
    question. The right question is whether the session doing the reassigning holds a seat at all.
    Without it, a session holding none could take a live seat's topic and then reset it as its own
    (2026-09-09 seats review, verified from the code).

    AND ANOTHER LIVE SEAT'S TOPIC IS NOT REASSIGNABLE. Moving a topic away from a seat whose agent is
    running -- `held` or `orphaned` -- is refused, because that seat's reset would then stop covering
    material it is still writing. Two things are still allowed, and both are deliberate: a DORMANT
    seat's topic may be reassigned, which is the recovery route the reset's own refusal names; and the
    acting seat may hand over a topic IT owns, because that is a decision that seat is entitled to
    make. The live workspace needed the second one on the day the rule shipped -- seat `library-dev`
    owned `notebook/2nd-b-vault-dev` and had to hand it to the seat named for that project.

.EXAMPLE
    tools/Set-NotebookTopicOwner.ps1 -Topic library-dev -Seat library-dev
.EXAMPLE
    tools/Set-NotebookTopicOwner.ps1 -Topic house-style -Scope shared
.EXAMPLE
    tools/Set-NotebookTopicOwner.ps1 -List
#>
[CmdletBinding()]
param(
    [string]$Topic,
    [string]$Seat,
    [ValidateSet('owned', 'shared', 'excluded')][string]$Scope = 'owned',
    # Write an `excluded` declaration over the evidence that the topic is reproducible. The refusal
    # names this switch, because a refusal whose remedy is unreachable is a wall rather than a guard.
    [switch]$AcceptReproducible,
    [string]$WorkspacePath,
    # Report every topic on disk beside what the record says about it, and change nothing.
    [switch]$List,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LibraryOutput.ps1')
. (Join-Path $PSScriptRoot 'NotebookOwnership.ps1')

# STEP 20: THE WORKSPACE IS SELECTED, NOT ASSUMED. `Split-Path -Parent $PSScriptRoot` answered
# "which workspace" with "one level above my own code", which is right only while the program and
# the workspace are the same directory. Order: -WorkspacePath, then LIBRARY_WORKSPACE, then the
# nearest `.library/workspace.json` above the working directory, then this program's own root --
# and that last one only while the program really is a workspace, which is what keeps an un-split
# checkout working and stops an installed package inventing one. tools/WorkspaceRegistry.ps1.
. (Join-Path $PSScriptRoot 'WorkspaceRegistry.ps1')
$WorkspacePath = Resolve-ToolWorkspace -Explicit $WorkspacePath -Anchor (Split-Path -Parent $PSScriptRoot)
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

if ($List) {
    $inventory = @(Get-NotebookOwnershipInventory -Workspace $workspace)
    Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
        operation            = 'Notebook topic ownership'
        workspace            = $workspace
        topics               = $inventory
        unmapped             = @($inventory | Where-Object { $_.scope -ceq 'unmapped' } | ForEach-Object { $_.topic })
        note                 = 'A topic reported as unmapped blocks a reset until it is owned, shared or excluded. That is deliberate: a reset will not guess at material nobody has claimed.'
        shared_library_write = $false
    })
    return
}

if ([string]::IsNullOrWhiteSpace($Topic)) { throw 'Name the topic to map with -Topic, or pass -List to see what is unmapped.' }

$stateDirectory = Join-Path $workspace '.claude'

# THE ACTING SESSION'S CLAIM, WHICH IS A DIFFERENT SEAT FROM THE ASSIGNEE BELOW. -List is a read and
# is unaffected; it returns above this line. Declared in Get-ClaimGatedHelpers, and
# `desk.claim-coverage` compares that declaration with this call in both directions.
#
# -ActingSeatOnly BECAUSE THIS HELPER'S `-Seat` MEANS THE ASSIGNEE. Without it the refusal ends "or
# pass -Seat explicitly", which is the switch the reader has already passed -- a circle they were
# sent round live on 2026-09-15.
$actingSeat = Resolve-SeatName -StateDirectory $stateDirectory -ActingSeatOnly `
    -SeatArgumentMeans "the topic's assignee, which may be any seat"
if ($actingSeat.status -cne 'named') { throw $actingSeat.message }
Assert-SeatClaimHeld -StateDirectory $stateDirectory -Seat $actingSeat.seat | Out-Null

$seatName = $null
if ($Scope -ceq 'owned') {
    $resolved = Resolve-SeatName -Seat $Seat -StateDirectory $stateDirectory
    if ($resolved.status -cne 'named') { throw $resolved.message }
    $seatName = $resolved.seat
    # A topic owned by a seat that does not exist is a record reset cannot act on safely, so the
    # seat is checked HERE rather than discovered at reset time.
    Assert-SeatRegistered -StateDirectory $stateDirectory -Seat $seatName | Out-Null
}

$topicPath = Join-Path (Join-Path $workspace 'notebook') $Topic
if (-not (Test-Path -LiteralPath $topicPath -PathType Container)) {
    throw "There is no Notebook topic at notebook/$Topic. Map a topic that exists; ownership of one that does not is a record nothing will ever act on."
}

# Read BEFORE the write, so the result can say what changed hands rather than only where it landed.
$previousEntry = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $workspace) -Topic $Topic
$previousOwner = if ($null -ne $previousEntry -and [string]$previousEntry.scope -ceq 'owned') { [string]$previousEntry.seat } else { $null }

Set-NotebookTopicOwner -Workspace $workspace -Topic $Topic -Seat $seatName -ActingSeat $actingSeat.seat -Scope $Scope -AcceptReproducible:$AcceptReproducible

$entry = Get-NotebookTopicOwner -Owners (Read-NotebookTopicOwners -Workspace $workspace) -Topic $Topic
# READ AGAIN RATHER THAN THREADED OUT OF THE WRITER, and the second walk is the price. The guard
# inside Set-NotebookTopicOwner takes its own reading, because a caller that could hand this evidence
# in could hand in a flattering one -- the rule `seat_id` already follows. Reported on the `excluded`
# path only: that is the declaration ADR-0025 says has to be answerable, and it is what makes this
# helper loud about a choice it just allowed as well as about one it refused.
$exclusionEvidence = $null
if ($Scope -ceq 'excluded') { $exclusionEvidence = Get-NotebookTopicReproducibility -Workspace $workspace -Topic $Topic }
# Read back from the record rather than echoed from the arguments: a helper that reported what it
# was asked to do, rather than what the record now says, is not evidence of anything.
Write-LibraryResult -Json:$Json -Result ([pscustomobject]@{
    operation            = 'Set Notebook topic ownership'
    workspace            = $workspace
    topic                = $Topic
    scope                = [string]$entry.scope
    seat                 = if ($Scope -ceq 'owned') { $seatName } else { $null }
    acting_seat          = $actingSeat.seat
    # Named because a REASSIGNMENT is a different operation from a first mapping, and the reader
    # should see which one just happened. $null on a first mapping.
    previous_owner       = $previousOwner
    # $null for every scope but `excluded`. ADR-0025's ruling is that a protected topic states
    # whether it can be rebuilt, and a declaration made without that stated is the 2026-09-15 defect.
    exclusion_evidence   = $exclusionEvidence
    reproducibility_accepted = [bool]($AcceptReproducible -and $Scope -ceq 'excluded')
    still_unmapped       = @(Get-NotebookOwnershipInventory -Workspace $workspace | Where-Object { $_.scope -ceq 'unmapped' } | ForEach-Object { $_.topic })
    shared_library_write = $false
})
